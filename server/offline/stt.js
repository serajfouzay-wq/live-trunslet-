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
  const worker = new Worker(path.join(here, 'stt-worker.cjs'));
  let ready = false;
  const queue = [];
  onStatus?.({ state: 'connecting', detail: `offline ${size === 'base' ? 'fast' : 'accurate'} model` });
  worker.on('message', (m) => {
    if (m.type === 'ready') {
      ready = true;
      onStatus?.({ state: 'connected', detail: `offline · ${size === 'base' ? 'fast' : 'accurate'}` });
      for (const b of queue.splice(0)) worker.postMessage({ type: 'audio', data: b });
    } else if (m.type === 'final' || m.type === 'partial') {
      const detected = m.lang && LANGUAGES[m.lang] ? m.lang : undefined;
      onResult({ text: m.text, final: m.type === 'final', speechFinal: m.type === 'final', lang: lang === 'auto' ? detected : lang });
    } else if (m.type === 'error') onStatus?.({ state: 'error', detail: `Offline speech: ${m.message}` });
  });
  worker.on('error', (e) => onStatus?.({ state: 'error', detail: `Offline speech stopped: ${e.message}` }));
  worker.postMessage({
    type: 'init',
    opts: { ...files, language: lang === 'auto' ? '' : lang, threads: Math.max(1, Math.min(4, os.cpus().length - 1)), partials: size === 'base' },
  });
  return {
    size,
    send(buf) {
      const copy = Buffer.from(buf);
      if (ready) worker.postMessage({ type: 'audio', data: copy }); else if (queue.length < 100) queue.push(copy);
    },
    close() { worker.postMessage({ type: 'flush' }); setTimeout(() => worker.terminate(), 3000); },
  };
}
