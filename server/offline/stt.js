import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { offline, speechFiles } from './manager.js';
import { LANGUAGES } from '../languages.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Offline speech recognition with the same shape as the Deepgram client: send(pcm), close(). */
export function createLocalStt({ lang, quality, onResult, onStatus }) {
  const size = offline.speechSizeFor(lang || 'auto', quality);
  if (!size) { onStatus?.({ state: 'error', detail: 'Offline speech model not installed' }); return null; }
  const files = speechFiles(size);
  const label = size === 'base' ? 'fast' : 'accurate';
  let worker = null;
  let ready = false;
  let closed = false;
  let restarts = 0;
  const queue = [];

  // If the recogniser crashes (for example out of memory during a long event), start it again by itself.
  function spawn() {
    ready = false;
    worker = new Worker(path.join(here, 'stt-worker.cjs'));
    onStatus?.({ state: 'connecting', detail: `offline ${label} model` });
    worker.on('message', (m) => {
      if (m.type === 'ready') {
        ready = true;
        onStatus?.({ state: 'connected', detail: `offline · ${label}` });
        for (const b of queue.splice(0)) worker.postMessage({ type: 'audio', data: b });
      } else if (m.type === 'final' || m.type === 'partial') {
        restarts = 0;
        const detected = m.lang && LANGUAGES[m.lang] ? m.lang : undefined;
        onResult({ text: m.text, final: m.type === 'final', speechFinal: m.type === 'final', lang: lang === 'auto' ? detected : lang });
      } else if (m.type === 'error') onStatus?.({ state: 'error', detail: `Offline speech: ${m.message}` });
    });
    worker.on('error', (e) => onStatus?.({ state: 'error', detail: `Offline speech stopped: ${e.message}` }));
    worker.on('exit', () => {
      if (closed) return;
      restarts += 1;
      if (restarts > 5) { onStatus?.({ state: 'error', detail: 'Offline speech keeps stopping. Try the fast offline model.' }); return; }
      setTimeout(() => { if (!closed) spawn(); }, 1000);
    });
    worker.postMessage({
      type: 'init',
      opts: { ...files, language: lang === 'auto' ? '' : lang, threads: Math.max(1, Math.min(4, os.cpus().length - 1)), partials: size === 'base' },
    });
  }
  spawn();

  return {
    size,
    send(buf) {
      const copy = Buffer.from(buf);
      if (ready) worker.postMessage({ type: 'audio', data: copy }); else if (queue.length < 100) queue.push(copy);
    },
    close() {
      closed = true;
      const w = worker;
      w.postMessage({ type: 'flush' });
      setTimeout(() => w.terminate(), 3000);
    },
  };
}
