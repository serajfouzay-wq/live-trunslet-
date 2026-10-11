import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { offline, speechFiles } from './manager.js';
import fs from 'node:fs';
import { LANGUAGES } from '../languages.js';
import { DATA } from '../config.js';
import { log } from '../log.js';

// How fast this computer runs each speech model (one decode, measured when it loads), remembered between starts.
// Whisper always processes 30 s windows, so a sentence costs about twice this. Over ~2 s the accurate model
// cannot keep up with a live speaker, and the fast one is used instead.
const SPEED_FILE = path.join(DATA, 'speech-speed.json');
const tooSlowMs = () => Number(process.env.LT_SLOW_MS || 2000);
const readSpeed = () => { try { return JSON.parse(fs.readFileSync(SPEED_FILE, 'utf8')); } catch { return {}; } };
const saveSpeed = (size, ms) => { try { fs.writeFileSync(SPEED_FILE, JSON.stringify({ ...readSpeed(), [size]: ms })); } catch { /* ignore */ } };

const here = path.dirname(fileURLToPath(import.meta.url));

/** Offline speech recognition with the same shape as the Deepgram client: send(pcm), close(). */
export function createLocalStt({ lang, quality, onResult, onStatus, onStat, onNotice }) {
  let size = offline.speechSizeFor(lang || 'auto', quality);
  if (!size) { onStatus?.({ state: 'error', detail: 'Offline speech model not installed' }); return null; }
  // Measured too slow here before: go straight to the fast model (automatic quality only).
  if (size !== 'base' && quality !== 'accurate' && readSpeed()[size] > tooSlowMs() && offline.speechReady('base')) {
    log('info', `offline speech: the ${size} model was too slow on this computer (${readSpeed()[size]} ms); using the fast model`);
    size = 'base';
  }
  let worker = null;
  let ready = false;
  let closed = false;
  let restarts = 0;
  let slow = 0;
  const queue = [];
  const label = () => (size === 'base' ? 'fast' : 'accurate');

  /** The accurate model is too slow on this laptop: continue with the fast one (only in automatic quality). */
  let warned = false;
  function downgrade(why) {
    if (size === 'base' || quality === 'accurate') return false;
    if (!offline.speechReady('base')) {
      if (!warned) onNotice?.('warn', `This laptop is too slow for the accurate offline speech model (${why}), so text will lag behind. Download "Speech recognition · fast" in Settings → Offline mode and it will be used automatically.`);
      warned = true;
      return false;
    }
    size = 'base';
    onNotice?.('warn', `This laptop is too slow for the accurate offline speech model (${why}); switched to the fast one so text keeps up with the speaker.`);
    const old = worker;
    spawn();
    old.removeAllListeners('exit');
    old.terminate();
    return true;
  }

  // If the recogniser crashes (for example out of memory during a long event), start it again by itself.
  function spawn() {
    ready = false;
    slow = 0;
    const w = new Worker(path.join(here, 'stt-worker.cjs'));
    worker = w;
    onStatus?.({ state: 'connecting', detail: `offline ${label()} model` });
    w.on('message', (m) => {
      if (w !== worker) return;
      if (m.type === 'ready') {
        // One decode of padded audio costs about the same as a real sentence: over ~4 s is too slow for live use.
        saveSpeed(size, m.warmMs);
        if (m.warmMs > tooSlowMs() && downgrade(`${((m.warmMs * 2) / 1000).toFixed(0)} s per sentence`)) return;
        if (size !== 'base' && m.warmMs < 1200) w.postMessage({ type: 'partials', on: true }); // fast laptop: live preview too
        ready = true;
        onStat?.({ model: label(), warmMs: m.warmMs });
        onStatus?.({ state: 'connected', detail: `offline · ${label()}` });
        for (const b of queue.splice(0)) w.postMessage({ type: 'audio', data: b });
      } else if (m.type === 'final' || m.type === 'partial') {
        restarts = 0;
        const detected = m.lang && LANGUAGES[m.lang] ? m.lang : undefined;
        onResult({ text: m.text, final: m.type === 'final', speechFinal: m.type === 'final', lang: lang === 'auto' ? detected : lang });
      } else if (m.type === 'stat') {
        onStat?.({ model: label(), ...m });
        // Falling behind the speaker (decoding takes longer than the speech itself), twice in a row.
        slow = m.decodeMs > Math.max(3000, m.speechMs) ? slow + 1 : 0;
        if (slow >= 2) downgrade('it falls behind the speaker');
      } else if (m.type === 'error') onStatus?.({ state: 'error', detail: `Offline speech: ${m.message}` });
    });
    w.on('error', (e) => { if (w === worker) onStatus?.({ state: 'error', detail: `Offline speech stopped: ${e.message}` }); });
    w.on('exit', () => {
      if (closed || w !== worker) return;
      restarts += 1;
      if (restarts > 5) { onStatus?.({ state: 'error', detail: 'Offline speech keeps stopping. Try the fast offline model.' }); return; }
      setTimeout(() => { if (!closed && w === worker) spawn(); }, 1000);
    });
    w.postMessage({
      type: 'init',
      opts: { ...speechFiles(size), language: lang === 'auto' ? '' : lang, threads: Math.max(1, Math.min(4, os.cpus().length - 1)), partials: size === 'base' },
    });
  }
  spawn();

  return {
    get size() { return size; },
    send(buf) {
      const copy = Buffer.from(buf);
      if (ready) worker.postMessage({ type: 'audio', data: copy }); else if (queue.length < 300) queue.push(copy); // up to 30 s while the model loads
    },
    close() {
      closed = true;
      const w = worker;
      w.postMessage({ type: 'flush' });
      setTimeout(() => w.terminate(), 3000);
    },
  };
}
