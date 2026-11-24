import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeArchive } from './archive.mjs';
import { makeFeishuSender } from './feishu.mjs';
import { makeMiniMaxTranscriber } from './minimax.mjs';
import { makeTranscriber } from './transcriber.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
const LEGACY_AUDIO_TYPE = 'application/vnd.watch3.audio-base64';
const RECORDING_PATH = /^\/v1\/recordings\/([0-9]{13}-[a-f0-9]{16})$/;

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function reply(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function reject(response, status, error) {
  response.setHeader('Connection', 'close');
  reply(response, status, { error });
}

function receipt(response, id, record) {
  if (!record) reply(response, 404, { error: 'recording_not_found' });
  else if (record.status === 'stored') reply(response, 200, { id, status: 'stored', file: record.file });
  else if (record.status === 'review') reply(response, 409, { id, error: record.error });
  else if (record.status === 'busy') reply(response, 429, { error: 'archive_queue_full' });
  else reply(response, 202, { id, status: 'processing' });
}

export function makeRelay({ watchToken, database, directory, transcribe, delivery, onTestUpload, retryDelay }) {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(watchToken ?? '')) {
    throw new Error('WATCH_TOKEN must have at least 32 URL-safe characters');
  }
  const authorization = digest('Bearer ' + watchToken);
  const uploads = new Set();
  const archive = transcribe && makeArchive({ database, directory, transcribe, delivery, retryDelay });

  async function accept(request, response) {
    if (request.method === 'GET' && request.url === '/health') {
      reply(response, 200, { status: 'ready', mode: archive ? 'archive' : 'test' });
      return;
    }
    const route = RECORDING_PATH.exec(request.url);
    if (!route || !['GET', 'PUT'].includes(request.method)) {
      reject(response, 404, 'not_found');
      return;
    }
    if (!timingSafeEqual(digest(request.headers.authorization ?? ''), authorization)) {
      reject(response, 401, 'unauthorized');
      return;
    }
    const id = route[1];
    if (request.method === 'GET') {
      receipt(response, id, archive?.status(id));
      return;
    }
    const audioType = request.headers['content-type'];
    const encoded = audioType === LEGACY_AUDIO_TYPE;
    if (audioType !== 'audio/mp4' && !encoded) {
      reject(response, 415, 'expected_m4a');
      return;
    }
    const maxBodyBytes = encoded ? Math.ceil(MAX_BYTES / 3) * 4 : MAX_BYTES;
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) {
      reject(response, 413, 'recording_too_large');
      return;
    }
    if (uploads.has(id) || uploads.size >= 8) {
      reject(response, 429, 'busy_retry_later');
      return;
    }
    uploads.add(id);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maxBodyBytes) {
          reject(response, 413, 'recording_too_large');
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks, size);
      const base64 = encoded ? body.toString('latin1') : null;
      const bytes = encoded ? Buffer.from(base64, 'base64') : body;
      const valid = bytes.length >= 16 && bytes.length <= MAX_BYTES
        && (!encoded || bytes.toString('base64') === base64)
        && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= bytes.length
        && bytes.toString('ascii', 4, 8) === 'ftyp';
      if (!valid) {
        reply(response, 422, { error: 'invalid_recording' });
        return;
      }
      const hash = digest(bytes).toString('hex');
      if (archive) receipt(response, id, archive.submit(id, hash, bytes, request.headers['x-archive-retry'] === '1'));
      else {
        const received = { status: 'test_received', id, sha256: hash, bytes: bytes.length };
        onTestUpload?.(received);
        reply(response, 202, received);
      }
    } finally {
      uploads.delete(id);
    }
  }

  const server = createServer({ requestTimeout: 30000, headersTimeout: 10000 }, (request, response) => {
    accept(request, response).catch(() => {
      if (!response.destroyed && !response.headersSent) reply(response, 503, { error: 'archive_unavailable' });
    });
  });
  server.on('listening', () => archive?.start());
  server.on('close', () => archive?.close());
  return server;
}

async function start() {
  const {
    WATCH_TOKEN, PORT = '8787', ARCHIVE_DB = './state/archive.sqlite',
    TRANSCRIPT_DIR = './transcripts', RELAY_MODE = 'test', ASR_PYTHON, ASR_MODEL_DIR,
    ASR_PROVIDER = 'local', MINIMAX_API_KEY, MINIMAX_REGION = 'cn',
    ASR_LOCAL_FALLBACK = '0',
    FEISHU_ENABLED = '0', FEISHU_CHAT_ID, FEISHU_APP_ID, FEISHU_APP_SECRET,
  } = process.env;
  if (!['test', 'archive'].includes(RELAY_MODE)) throw new Error('Invalid RELAY_MODE');
  const port = Number(PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  let transcribe;
  let database;
  let delivery;
  const provider = ASR_PROVIDER === 'minimax' && !MINIMAX_API_KEY?.trim() && ASR_LOCAL_FALLBACK === '1'
    ? 'local' : ASR_PROVIDER;
  if (RELAY_MODE === 'archive') {
    if (provider === 'local') {
      transcribe = makeTranscriber({ python: ASR_PYTHON, modelDir: ASR_MODEL_DIR });
    } else if (provider === 'minimax') {
      transcribe = await makeMiniMaxTranscriber({ apiKey: MINIMAX_API_KEY, region: MINIMAX_REGION });
    } else {
      throw new Error('ASR_PROVIDER must be local or minimax');
    }
    database = resolve(ARCHIVE_DB);
    mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
    if (FEISHU_ENABLED === '1') {
      delivery = makeFeishuSender({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET, chatId: FEISHU_CHAT_ID });
    }
  }
  const server = makeRelay({
    watchToken: WATCH_TOKEN, database, directory: resolve(TRANSCRIPT_DIR), transcribe, delivery,
    onTestUpload: receipt => console.log(JSON.stringify({ receivedAt: new Date().toISOString(), ...receipt })),
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('WATCH 3 relay listening on 127.0.0.1:' + port + ' (' + RELAY_MODE + ')'
      + (RELAY_MODE === 'archive' ? ' · ASR ' + provider : ''));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await start();
