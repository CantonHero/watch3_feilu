import { readFileSync } from 'node:fs';

export function makeFeishuOutbox({ db, delivery, transcriptPath, retryDelay }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feishu_outbox (
      id TEXT NOT NULL, destination TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, first_attempt INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0, message_id TEXT,
      PRIMARY KEY (id, destination)
    );
  `);
  const { target, send } = delivery;
  const queue = db.prepare("INSERT OR IGNORE INTO feishu_outbox (id, destination, status) VALUES (?, ?, 'pending')");
  const next = db.prepare("SELECT id, attempts, first_attempt, next_attempt FROM feishu_outbox WHERE destination = ? AND status = 'pending' ORDER BY next_attempt, id LIMIT 1");
  const markAttempt = db.prepare('UPDATE feishu_outbox SET attempts = ?, first_attempt = ? WHERE id = ? AND destination = ?');
  const schedule = db.prepare('UPDATE feishu_outbox SET next_attempt = ? WHERE id = ? AND destination = ?');
  const finish = db.prepare('UPDATE feishu_outbox SET status = ?, message_id = ? WHERE id = ? AND destination = ?');
  let worker;
  let timer;
  let closed = false;

  async function drain() {
    while (!closed) {
      const job = next.get(target);
      if (!job) return;
      const now = Date.now();
      if (job.next_attempt > now) {
        timer = setTimeout(wake, job.next_attempt - now);
        return;
      }
      // Feishu's request deduplication window lasts one hour.
      if (job.attempts >= 3 || (job.first_attempt && now - job.first_attempt >= 50 * 60000)) {
        finish.run('review', null, job.id, target);
        continue;
      }
      const attempts = job.attempts + 1;
      markAttempt.run(attempts, job.first_attempt || now, job.id, target);
      try {
        const transcript = readFileSync(transcriptPath(job.id), 'utf8').trim();
        if (!transcript) {
          finish.run('review', null, job.id, target);
          continue;
        }
        const messageId = await send(job.id, transcript);
        finish.run('sent', messageId, job.id, target);
      } catch (error) {
        if (error.code === 'ENOENT' || error.retryable === false || attempts >= 3) {
          finish.run('review', null, job.id, target);
        } else {
          schedule.run(Date.now() + retryDelay * attempts, job.id, target);
        }
      }
    }
  }

  function wake() {
    if (closed || worker) return;
    clearTimeout(timer);
    worker = drain()
      .catch(() => { if (!closed) timer = setTimeout(wake, retryDelay); })
      .finally(() => { worker = undefined; });
  }

  return {
    enqueue: id => queue.run(id, target),
    wake,
    close() {
      closed = true;
      clearTimeout(timer);
      return worker;
    },
  };
}
