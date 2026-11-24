import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const device = {
  files: new Map(),
  nextResponse: null,
  transportError: null,
  destroyed: 0,
  getCalls: 0,
  putCalls: 0,
};
const root = '/sandbox/files';
const id = '1795330650000-ac1234f001abcdef';
const name = 'watch-' + id + '.m4a';
const payload = Buffer.alloc(160000, 0x55);
payload.writeUInt32BE(24, 0);
payload.write('ftypM4A ', 4, 'ascii');

const fakeFs = {
  opendirSync() {
    const entries = [...device.files.keys()].map(path => ({ name: path.split('/').pop() }));
    return { readSync: () => entries.shift(), closeSync() {} };
  },
  statSync(path) { return { size: device.files.get(path).length }; },
  openSync(path, flags, mode) {
    if (flags & 0o100) {
      assert.equal(mode, 0o600);
      device.files.set(path, Buffer.alloc(0));
    }
    return path;
  },
  closeSync() {},
  async read(path, chunk, { position }) {
    // Return fewer bytes than requested to exercise the position loop.
    const data = device.files.get(path).subarray(position, position + Math.min(20000, chunk.byteLength));
    new Uint8Array(chunk).set(data);
    return { bytesRead: data.length, buffer: chunk, offset: 0 };
  },
  unlinkSync(path) { device.files.delete(path); },
};
const fakeMedia = {
  AudioEncoder: { AAC_LC: 3 },
  AudioOutputFormat: { MPEG_4: 2 },
  createAudioRecorder() {
    let path;
    const events = new Map();
    return {
      on(event, callback) { events.set(event, callback); },
      prepare(config) {
        assert.equal(config.audioEncoder, 3);
        assert.equal(config.format, 2);
        path = config.uri.slice('fd://'.length);
        events.get('prepare')();
      },
      start() { events.get('start')(); },
      stop() {
        device.files.set(path, payload);
        events.get('stop')();
      },
      release() {},
    };
  },
};
const fakeHttp = {
  RequestMethod: { PUT: 'PUT', GET: 'GET' },
  createHttp() {
    return {
      async request(url, options) {
        assert.equal(url, 'https://voice.example.invalid/v1/recordings/' + id);
        if (device.transportError) throw device.transportError;
        if (options.method === 'GET') {
          device.getCalls++;
          return device.nextResponse.get;
        }
        device.putCalls++;
        assert.equal(options.method, 'PUT');
        assert.equal(options.header['Content-Type'], 'application/vnd.watch3.audio-base64');
        assert.equal(options.extraData, payload.toString('base64'));
        return device.nextResponse.put;
      },
      destroy() { device.destroyed++; },
    };
  },
};
globalThis.watch3TestModules = { fakeFs, fakeMedia, fakeHttp };
const replace = new Map([
  ['@ohos.fileio', 'export default globalThis.watch3TestModules.fakeFs;'],
  ['@ohos.multimedia.media', 'export default globalThis.watch3TestModules.fakeMedia;'],
  ['@ohos.net.http', 'export default globalThis.watch3TestModules.fakeHttp;'],
  ['./relay-config', 'export const relayUrl = "https://voice.example.invalid"; export const watchToken = "fixture-token-only-never-for-deploy";'],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (replace.has(specifier)) {
      return { url: 'data:text/javascript,' + encodeURIComponent(replace.get(specifier)), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { archiveRecording, openRecorder, pendingRecordings, relayConfigured } =
  await import('./entry/src/main/js/MainAbility/common/recordings.js');
hooks.deregister();

test('only a finalized recording enters the pending queue', async () => {
  device.files.clear();
  const recorder = await openRecorder(root, () => {});
  assert.deepEqual(pendingRecordings(root), []);
  await recorder.stop();
  const [pending] = pendingRecordings(root);
  assert.match(pending, /^watch-\d{13}-[a-f0-9]{16}\.m4a$/);
  assert.deepEqual(device.files.get(root + '/' + pending), payload);
  assert.equal(device.files.get(root + '/' + pending + '.ready').length, 0);
});

test('test and processing receipts keep audio, and polling retrieves a final text receipt', async () => {
  assert.ok(relayConfigured());
  device.files.clear();
  device.files.set(root + '/' + name, payload);
  device.files.set(root + '/' + name + '.ready', Buffer.alloc(0));
  device.transportError = new Error('simulated offline');
  await assert.rejects(archiveRecording(root, name), /simulated offline/);
  assert.deepEqual(pendingRecordings(root), [name]);
  device.transportError = null;

  device.nextResponse = {
    get: { responseCode: 404 },
    put: { responseCode: 202, result: JSON.stringify({ id, status: 'test_received' }) },
  };
  assert.equal(await archiveRecording(root, name), 'test_received');
  assert.deepEqual(pendingRecordings(root), [name]);

  device.nextResponse.get = { responseCode: 202, result: { id, status: 'processing' } };
  assert.equal(await archiveRecording(root, name), 'processing');
  assert.deepEqual(pendingRecordings(root), [name]);
  device.nextResponse.get = { responseCode: 200, result: { id: 'different', status: 'stored', file: 'watch-' + id + '.txt' } };
  assert.equal(await archiveRecording(root, name), 'retry');
  assert.deepEqual(pendingRecordings(root), [name]);

  device.nextResponse.get.result.id = id;
  assert.equal(await archiveRecording(root, name), 'stored');
  assert.deepEqual(pendingRecordings(root), []);
  assert.equal(device.files.size, 0);
  assert.equal(device.getCalls, 4);
  assert.equal(device.putCalls, 1);
  assert.equal(device.destroyed, 6);
});
