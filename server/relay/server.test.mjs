import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { makeMiniMaxTranscriber } from './minimax.mjs';
import { makeFeishuSender } from './feishu.mjs';
import { makeRelay } from './server.mjs';
import { makeTranscriber } from './transcriber.mjs';

const id = '1795330650000-ac1234f001abcdef';
const file = 'watch-' + id + '.txt';
const watchToken = 'fixture-token-not-valid-in-deployment-AAAA';
const sample = readFileSync(new URL('./fixtures/test-tone.m4a', import.meta.url));
const expected = '这是一条普通话转写测试。';
const hash = createHash('sha256').update(sample).digest('hex');

function state(t) {
  const root = mkdtempSync(join(tmpdir(), 'watch3-archive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { directory: join(root, 'transcripts'), database: join(root, 'archive.sqlite') };
}

async function serve(options = {}) {
  const server = makeRelay({ watchToken, retryDelay: 5, ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/v1/recordings/' + id;
  const headers = { Authorization: 'Bearer ' + watchToken };
  return {
    get: () => fetch(url, { headers }),
    put: (body = sample, overrides = {}) => fetch(url, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'audio/mp4', ...overrides }, body,
    }),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function waitFor(archive, status) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const response = await archive.get();
    const body = await response.json();
    if (response.status === status) return body;
    assert.equal(response.status, 202, JSON.stringify(body));
    await delay(25);
  }
  assert.fail('Archive did not produce the expected receipt');
}

test('test mode authenticates audio and reports a receipt without archiving', async () => {
  const relay = await serve();
  try {
    assert.equal((await relay.get()).status, 404);
    assert.equal((await relay.put(sample, { Authorization: 'Bearer incorrect' })).status, 401);
    assert.equal((await relay.put(sample, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await relay.put(Buffer.from('invalid'))).status, 422);
    const response = await relay.put();
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { id, status: 'test_received', bytes: sample.length, sha256: hash });
  } finally {
    await relay.close();
  }
});

test('API 6 base64 uploads produce the same receipt as raw audio', async () => {
  const relay = await serve();
  const headers = { 'Content-Type': 'application/vnd.watch3.audio-base64' };
  try {
    const encoded = sample.toString('base64');
    assert.equal((await relay.put(encoded + '\n', headers)).status, 422);
    const response = await relay.put(encoded, headers);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { id, status: 'test_received', bytes: sample.length, sha256: hash });
  } finally {
    await relay.close();
  }
});

test('one audio produces one UTF-8 file and a restart preserves its receipt', async t => {
  const options = state(t);
  let transcriptions = 0;
  const relay = await serve({ ...options, async transcribe(bytes) {
    assert.deepEqual(Buffer.from(bytes), sample);
    transcriptions++;
    await delay(30);
    return expected;
  } });
  try {
    assert.equal((await relay.put()).status, 202);
    assert.deepEqual(await waitFor(relay, 200), { id, status: 'stored', file });
    assert.deepEqual(readdirSync(options.directory), [file]);
    assert.equal(readFileSync(join(options.directory, file), 'utf8'), expected + '\n');
  } finally {
    await relay.close();
  }
  const restarted = await serve({ ...options, async transcribe() {
    transcriptions++;
    throw new Error('Stored audio must never be transcribed again');
  } });
  try {
    assert.equal((await restarted.put()).status, 200);
    const different = Buffer.from(sample);
    different[different.length - 1] ^= 1;
    assert.equal((await restarted.put(different)).status, 409);
    assert.equal(transcriptions, 1);
    const db = new DatabaseSync(options.database, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT audio FROM jobs WHERE id = ?').get(id).audio, null);
    } finally {
      db.close();
    }
  } finally {
    await restarted.close();
  }
});

test('Feishu receives the saved transcript as text and keeps a single receipt across restarts', async t => {
  const options = state(t);
  const target = 'oc_fixturegroup';
  const payloads = [];
  const sender = makeFeishuSender({ appId: 'cli_fixture', appSecret: 'fixture-only', chatId: target },
    async (url, request) => {
      assert.equal(request.method, 'POST');
      if (url.endsWith('/tenant_access_token/internal')) {
        return Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 });
      }
      assert.equal(url, 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id');
      assert.equal(request.headers.Authorization, 'Bearer fixture-token');
      assert.equal(readFileSync(join(options.directory, file), 'utf8'), expected + '\n');
      const payload = JSON.parse(request.body);
      assert.equal(payload.receive_id, target);
      assert.equal(payload.msg_type, 'text');
      assert.deepEqual(JSON.parse(payload.content), { text: expected });
      assert.match(payload.uuid, /^[a-f0-9]{32}$/);
      payloads.push(payload);
      if (payloads.length === 1) return Response.json({}, { status: 503 });
      return Response.json({ code: 0, data: { message_id: 'om_fixture_receipt' } });
    });
  const relay = await serve({ ...options, transcribe: async () => expected, delivery: sender });
  try {
    assert.equal((await relay.put()).status, 202);
    await waitFor(relay, 200);
    const db = new DatabaseSync(options.database, { readOnly: true });
    try {
      const find = db.prepare('SELECT status, message_id FROM feishu_outbox WHERE id = ?');
      const deadline = Date.now() + 2000;
      while (find.get(id)?.status !== 'sent' && Date.now() < deadline) await delay(10);
      assert.deepEqual({ ...find.get(id) }, { status: 'sent', message_id: 'om_fixture_receipt' });
    } finally {
      db.close();
    }
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].uuid, payloads[1].uuid);
  } finally {
    await relay.close();
  }
  const restarted = await serve({ ...options, transcribe: async () => expected, delivery: sender });
  try {
    assert.equal((await restarted.put()).status, 200);
    assert.equal(payloads.length, 2);
  } finally {
    await restarted.close();
  }
});

test('transcription retries automatically and blank speech never creates an empty file', async t => {
  const options = state(t);
  let attempts = 0;
  const relay = await serve({ ...options, async transcribe() {
    if (++attempts === 1) throw new Error('Transient worker outage');
    return '   ';
  } });
  try {
    assert.equal((await relay.put()).status, 202);
    assert.deepEqual(await waitFor(relay, 409), { id, error: 'no_speech_detected' });
    assert.equal(attempts, 2);
    assert.deepEqual(readdirSync(options.directory), []);
  } finally {
    await relay.close();
  }
});

test('startup resumes an unfinished job from the existing archive database', async t => {
  const options = state(t);
  const first = await serve({ ...options, transcribe: async () => '' });
  await first.close();
  const db = new DatabaseSync(options.database);
  db.prepare("INSERT INTO jobs (id, hash, status, audio, created) VALUES (?, ?, 'pending', ?, ?)")
    .run(id, hash, sample, Date.now());
  db.close();
  const relay = await serve({ ...options, transcribe: async () => expected });
  try {
    assert.deepEqual(await waitFor(relay, 200), { id, status: 'stored', file });
    assert.equal(readFileSync(join(options.directory, file), 'utf8'), expected + '\n');
  } finally {
    await relay.close();
  }
});

test('after retries are exhausted only an explicit matching retry requeues the original audio', async t => {
  const options = state(t);
  let tries = 0;
  const relay = await serve({ ...options, async transcribe() {
    if (++tries <= 3) throw new Error('Simulated worker outage');
    return expected;
  } });
  try {
    assert.equal((await relay.put()).status, 202);
    assert.deepEqual(await waitFor(relay, 409), { id, error: 'transcription_failed' });
    assert.equal((await relay.put()).status, 409);
    assert.equal(tries, 3);
    assert.equal((await relay.put(sample, { 'X-Archive-Retry': '1' })).status, 202);
    assert.deepEqual(await waitFor(relay, 200), { id, status: 'stored', file });
    assert.equal(tries, 4);
  } finally {
    await relay.close();
  }
});

test('MiniMax receives the M4A with the documented fields and simplified text is archived once', async t => {
  const options = state(t);
  const source = readFileSync(new URL('./fixtures/test-mandarin.m4a', import.meta.url));
  let requests = 0;
  const transcribe = await makeMiniMaxTranscriber({ apiKey: 'test-key' }, async (url, request) => {
    requests++;
    assert.equal(url, 'https://api.minimax.cn/v1/speech_to_text');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer test-key');
    assert.equal(request.headers.language, 'zh');
    assert.equal(request.body.get('model'), 'asr-1.0');
    assert.equal(request.body.get('response_format'), 'json');
    assert.equal(request.body.get('stream'), 'false');
    const audio = request.body.get('file');
    assert.equal(audio.type, 'audio/mp4');
    assert.equal(audio.name, 'recording.m4a');
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), source);
    return Response.json({ text: '請把手錶錄音轉寫成簡體中文。', duration: 10 });
  });
  const relay = await serve({ ...options, transcribe });
  try {
    assert.equal((await relay.put(source)).status, 202);
    assert.deepEqual(await waitFor(relay, 200), { id, status: 'stored', file });
    assert.equal(readFileSync(join(options.directory, file), 'utf8'), '请把手表录音转写成简体中文。\n');
    assert.equal((await relay.put(source)).status, 200);
    assert.equal(requests, 1);
  } finally {
    await relay.close();
  }
});

test('MiniMax validates region and rejects API errors without exposing response text', async () => {
  await assert.rejects(makeMiniMaxTranscriber({ apiKey: '' }), /MINIMAX_API_KEY/);
  await assert.rejects(makeMiniMaxTranscriber({ apiKey: 'test-key', region: 'other' }), /MINIMAX_REGION/);
  const unauthorized = await makeMiniMaxTranscriber({ apiKey: 'test-key', region: 'global' }, url => {
    assert.equal(url, 'https://api.minimax.io/v1/speech_to_text');
    return Response.json({ error: { message: 'sensitive server detail' } }, { status: 401 });
  });
  await assert.rejects(unauthorized(sample), error => (
    error.retryable === false && error.message === 'MiniMax ASR HTTP 401'
  ));
  const failed = await makeMiniMaxTranscriber({ apiKey: 'test-key' }, () => Response.json({
    base_resp: { status_code: 1010, status_msg: 'sensitive server detail' }, text: 'unexpected',
  }));
  await assert.rejects(failed(sample), {
    message: 'MiniMax ASR did not return a successful transcript',
  });
});

test('a local Mandarin voice is transcribed and archived over the HTTP flow', {
  skip: !process.env.ASR_PYTHON || !process.env.ASR_MODEL_DIR,
}, async t => {
  const options = state(t);
  const transcribe = makeTranscriber({ python: process.env.ASR_PYTHON, modelDir: process.env.ASR_MODEL_DIR });
  const relay = await serve({ ...options, transcribe });
  try {
    const audio = process.env.ASR_TEST_AUDIO || new URL('./fixtures/test-mandarin.m4a', import.meta.url);
    assert.equal((await relay.put(readFileSync(audio))).status, 202);
    assert.deepEqual(await waitFor(relay, 200), { id, status: 'stored', file });
    const text = readFileSync(join(options.directory, file), 'utf8');
    assert.match(text, /手表/);
    assert.match(text, /服务器/);
  } finally {
    await relay.close();
  }
});
