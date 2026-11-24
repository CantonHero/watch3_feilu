import fs from '@ohos.fileio';
import media from '@ohos.multimedia.media';
import http from '@ohos.net.http';
import { relayUrl, watchToken } from './relay-config';

const RECORDING = /^watch-([0-9]{13}-[a-f0-9]{16})\.m4a$/;
const MAX_BYTES = 4 * 1024 * 1024;
const CREATE_READ_WRITE = 0o100 | 0o2;
const OWNER_READ_WRITE = 0o600;
const READY_SUFFIX = '.ready';
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function pendingRecordings(dir) {
  const directory = fs.opendirSync(dir);
  const names = [];
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (!entry.name.endsWith(READY_SUFFIX)) continue;
      const name = entry.name.slice(0, -READY_SUFFIX.length);
      if (RECORDING.test(name)) names.push(name);
    }
  } finally {
    directory.closeSync();
  }
  return names.sort();
}

function randomPart() {
  const hex = Math.floor(Math.random() * 0x100000000).toString(16);
  return ('00000000' + hex).slice(-8);
}

export async function openRecorder(dir, onError) {
  const id = Date.now() + '-' + randomPart() + randomPart();
  const path = dir + '/watch-' + id + '.m4a';
  const fd = fs.openSync(path, CREATE_READ_WRITE, OWNER_READ_WRITE);
  let recorder;
  let finishOperation;

  function release() {
    try {
      if (recorder) recorder.release();
    } finally {
      fs.closeSync(fd);
    }
  }

  function operate(event, run) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Recorder ' + event + ' timed out')), 5000);
      function finish(error) {
        if (finishOperation !== finish) return;
        finishOperation = undefined;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      }
      finishOperation = finish;
      try {
        recorder.on(event, () => finish());
        run();
      } catch (error) {
        finish(error);
      }
    });
  }

  try {
    recorder = media.createAudioRecorder();
    if (!recorder) throw new Error('No AudioRecorder');
    recorder.on('error', error => {
      if (finishOperation) finishOperation(error || new Error('AudioRecorder failed'));
      else onError();
    });
    await operate('prepare', () => recorder.prepare({
      audioEncoder: media.AudioEncoder.AAC_LC,
      audioEncodeBitRate: 48000,
      audioSampleRate: 44100,
      numberOfChannels: 1,
      format: media.AudioOutputFormat.MPEG_4,
      uri: 'fd://' + fd,
    }));
    await operate('start', () => recorder.start());
  } catch (error) {
    release();
    // Keep any bytes already captured for diagnosis after an interrupted start.
    throw error;
  }

  return {
    async stop() {
      try {
        await operate('stop', () => recorder.stop());
      } finally {
        release();
      }
      if (fs.statSync(path).size < 16) throw new Error('Empty recording');
      fs.closeSync(fs.openSync(path + READY_SUFFIX, CREATE_READ_WRITE, OWNER_READ_WRITE));
    },
  };
}

export function relayConfigured() {
  return /^https:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/.test(relayUrl) && watchToken.length >= 32;
}

export async function archiveRecording(dir, name, retryFailed) {
  const id = RECORDING.exec(name)[1];
  const path = dir + '/' + name;
  const url = relayUrl.replace(/\/+$/, '') + '/v1/recordings/' + id;
  const client = http.createHttp();
  const options = {
    header: { Authorization: 'Bearer ' + watchToken },
    usingCache: false,
    connectTimeout: 10000,
    readTimeout: 35000,
  };
  let response;
  try {
    response = await client.request(url, { ...options, method: http.RequestMethod.GET });
  } finally {
    client.destroy();
  }
  if (response.responseCode === 404) return uploadRecording(url, options, path, id, name);
  if (retryFailed && response.responseCode === 409
      && ['transcription_failed', 'transcript_missing'].includes(receiptBody(response).error)) {
    options.header['X-Archive-Retry'] = '1';
    return uploadRecording(url, options, path, id, name);
  }
  return checkReceipt(response, path, id, name);
}

async function uploadRecording(url, options, path, id, name) {
  const size = fs.statSync(path).size;
  if (size < 16 || size > MAX_BYTES) return 'review';

  const fd = fs.openSync(path);
  const audio = new ArrayBuffer(size);
  try {
    let received = 0;
    const target = new Uint8Array(audio);
    while (received < size) {
      const chunk = new ArrayBuffer(Math.min(size - received, 65536));
      const result = await fs.read(fd, chunk, { position: received });
      if (result.bytesRead <= 0) throw new Error('Incomplete read');
      target.set(new Uint8Array(result.buffer, 0, result.bytesRead), received);
      received += result.bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }

  const client = http.createHttp();
  try {
    const response = await client.request(url, {
      ...options,
      method: http.RequestMethod.PUT,
      header: { ...options.header, 'Content-Type': 'application/vnd.watch3.audio-base64' },
      extraData: encodeAudio(new Uint8Array(audio)),
    });
    return checkReceipt(response, path, id, name);
  } finally {
    client.destroy();
  }
}

function encodeAudio(bytes) {
  const parts = [];
  let part = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const packed = (bytes[index] << 16) | ((bytes[index + 1] || 0) << 8) | (bytes[index + 2] || 0);
    part += BASE64[(packed >> 18) & 63] + BASE64[(packed >> 12) & 63]
      + (index + 1 < bytes.length ? BASE64[(packed >> 6) & 63] : '=')
      + (index + 2 < bytes.length ? BASE64[packed & 63] : '=');
    if (part.length >= 16384) {
      parts.push(part);
      part = '';
    }
  }
  parts.push(part);
  return parts.join('');
}

function receiptBody(response) {
  const body = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
  return body || {};
}

function checkReceipt(response, path, id, name) {
  if (response.responseCode === 409 && receiptBody(response).error === 'no_speech_detected') return 'no_speech';
  if ([409, 422, 413].includes(response.responseCode)) return 'review';
  if (response.responseCode !== 200 && response.responseCode !== 202) return 'retry';
  const receipt = receiptBody(response);
  if (receipt.id !== id) return 'retry';
  if (response.responseCode === 200 && receipt.status === 'stored'
      && receipt.file === name.replace(/\.m4a$/, '.txt')) {
    fs.unlinkSync(path + READY_SUFFIX);
    fs.unlinkSync(path);
    return 'stored';
  }
  if (response.responseCode === 202 && ['processing', 'test_received'].includes(receipt.status)) {
    return receipt.status;
  }
  return 'retry';
}
