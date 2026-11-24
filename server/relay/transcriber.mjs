import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./transcribe.py', import.meta.url));

export function makeTranscriber({ python, modelDir }) {
  if (!python || !modelDir) throw new Error('Archive mode requires ASR_PYTHON and ASR_MODEL_DIR');
  const directory = resolve(modelDir);
  for (const name of ['config.json', 'tokenizer.json', 'model.bin']) {
    if (!existsSync(join(directory, name))) throw new Error('ASR model directory is missing ' + name);
  }

  return audio => new Promise((resolveText, reject) => {
    const process = spawn(python, ['-B', worker, directory], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
      timeout: 300000,
    });
    const chunks = [];
    let size = 0;
    process.stdout.on('data', chunk => {
      size += chunk.length;
      if (size <= 64 * 1024) chunks.push(chunk);
      else {
        process.kill();
        reject(new Error('Transcription output exceeded its size limit'));
      }
    });
    process.stdin.on('error', error => {
      if (error.code !== 'EPIPE') reject(error);
    });
    process.on('error', reject);
    process.on('close', (code, signal) => {
      if (code === 0) resolveText(Buffer.concat(chunks).toString('utf8'));
      else reject(Object.assign(new Error('Transcription process failed (' + (signal || code) + ')'), {
        code: code === 2 ? 'invalid_audio' : 'asr_failed',
      }));
    });
    process.stdin.end(audio);
  });
}
