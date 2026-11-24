import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeFeishuOutbox } from './feishu-outbox.mjs';

const MAX_PENDING = 20;
const MAX_ATTEMPTS = 3;
const MAX_TEXT_BYTES = 64 * 1024;

function hasText(path) {
  try {
    return Boolean(readFileSync(path, 'utf8').trim());
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function makeArchive({ database, directory, transcribe, delivery, retryDelay = 15000 }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(database);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, hash TEXT NOT NULL, status TEXT NOT NULL, audio BLOB,
      created INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0, error TEXT
    );
  `);
  const lookup = db.prepare('SELECT id, hash, status, error FROM jobs WHERE id = ?');
  const count = db.prepare("SELECT count(*) AS pending FROM jobs WHERE status = 'pending'");
  const insert = db.prepare("INSERT INTO jobs (id, hash, status, audio, created) VALUES (?, ?, 'pending', ?, ?)");
  const requeue = db.prepare("UPDATE jobs SET status = 'pending', audio = ?, created = ?, attempts = 0, next_attempt = 0, error = NULL WHERE id = ?");
  const next = db.prepare("SELECT id, audio, attempts, next_attempt FROM jobs WHERE status = 'pending' ORDER BY next_attempt, created LIMIT 1");
  const finish = db.prepare("UPDATE jobs SET status = 'stored', audio = NULL, error = NULL WHERE id = ?");
  const review = db.prepare("UPDATE jobs SET status = 'review', audio = NULL, error = ? WHERE id = ?");
  const retry = db.prepare('UPDATE jobs SET attempts = ?, next_attempt = ? WHERE id = ?');
  let worker;
  let timer;
  let closed = false;
  const outbox = delivery && makeFeishuOutbox({
    db, delivery, transcriptPath: id => join(directory, filename(id)), retryDelay,
  });

  function filename(id) {
    return 'watch-' + id + '.txt';
  }

  function status(id) {
    const record = lookup.get(id);
    if (!record || record.status !== 'stored') return record;
    const file = filename(id);
    if (hasText(join(directory, file))) return { ...record, file };
    return { status: 'review', error: 'transcript_missing' };
  }

  async function drain() {
    while (!closed) {
      const job = next.get();
      if (!job) return;
      if (job.next_attempt > Date.now()) {
        timer = setTimeout(wake, job.next_attempt - Date.now());
        return;
      }
      const path = join(directory, filename(job.id));
      try {
        if (!hasText(path)) {
          const text = (await transcribe(job.audio)).trim();
          if (!text) {
            review.run('no_speech_detected', job.id);
            continue;
          }
          if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
            review.run('transcript_too_large', job.id);
            continue;
          }
          const temporary = path + '.partial';
          writeFileSync(temporary, text + '\n', { encoding: 'utf8', mode: 0o600, flush: true });
          renameSync(temporary, path);
        }
        if (outbox) {
          db.exec('BEGIN IMMEDIATE');
          try {
            finish.run(job.id);
            outbox.enqueue(job.id);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          outbox.wake();
        } else {
          finish.run(job.id);
        }
      } catch (error) {
        const attempts = job.attempts + 1;
        if (error.code === 'invalid_audio' || error.retryable === false || attempts >= MAX_ATTEMPTS) {
          review.run(error.code === 'invalid_audio' ? 'invalid_audio' : 'transcription_failed', job.id);
        } else {
          retry.run(attempts, Date.now() + retryDelay * attempts, job.id);
        }
      }
    }
  }

  function wake() {
    if (closed || worker) return;
    clearTimeout(timer);
    worker = drain()
      .catch(() => {
        if (!closed) timer = setTimeout(wake, retryDelay);
      })
      .finally(() => { worker = undefined; });
  }

  return {
    start() {
      wake();
      outbox?.wake();
    },
    status,
    submit(id, hash, bytes, retryRequested) {
      const existing = lookup.get(id);
      if (existing) {
        if (existing.hash !== hash) return { status: 'review', error: 'recording_conflict' };
        const current = status(id);
        if (!retryRequested || !['transcription_failed', 'transcript_missing'].includes(current.error)) {
          return current;
        }
      }
      if (count.get().pending >= MAX_PENDING) return { status: 'busy' };
      if (existing) requeue.run(bytes, Date.now(), id);
      else insert.run(id, hash, bytes, Date.now());
      wake();
      return { status: 'pending' };
    },
    close() {
      closed = true;
      clearTimeout(timer);
      const sending = outbox?.close();
      if (worker || sending) Promise.allSettled([worker, sending]).then(() => db.close());
      else db.close();
    },
  };
}
