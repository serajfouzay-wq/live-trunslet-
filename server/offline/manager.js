import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import bz2 from 'unbzip2-stream';
import tar from 'tar-stream';
import { DATA } from '../config.js';
import { log } from '../log.js';
import { OfflineTranslator } from './mt.js';
import { TranslationMemory } from './memory.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const catalog = JSON.parse(fs.readFileSync(path.join(here, 'catalog.json'), 'utf8'));
const MODELS = path.join(DATA, 'models');
const MT_DIR = path.join(MODELS, 'translation');
const SPEECH_DIR = path.join(MODELS, 'speech');

export const PACKS = {
  translation: { label: 'Translation (all 8 languages)', bytes: catalog.totalBytes },
  'speech-fast': { label: 'Speech recognition · fast', bytes: catalog.speech['whisper-base'].size + catalog.speech.vad.size },
  'speech-accurate': { label: 'Speech recognition · accurate', bytes: catalog.speech['whisper-small'].size + catalog.speech.vad.size },
};

const whisperDir = (size) => path.join(SPEECH_DIR, `whisper-${size}`);
export const speechFiles = (size) => ({
  encoder: path.join(whisperDir(size), `${size}-encoder.int8.onnx`),
  decoder: path.join(whisperDir(size), `${size}-decoder.int8.onnx`),
  tokens: path.join(whisperDir(size), `${size}-tokens.txt`),
  vad: path.join(SPEECH_DIR, 'silero_vad.onnx'),
});
const speechReady = (size) => Object.values(speechFiles(size)).every((f) => fs.existsSync(f));

/** Counts bytes going through a stream (for progress). */
const counter = (onBytes) => new Transform({ transform(chunk, _e, cb) { onBytes(chunk.length); cb(null, chunk); } });

class OfflineManager {
  constructor() {
    this.mt = new OfflineTranslator({ dir: MT_DIR, catalog, maxEngines: os.totalmem() < 9e9 ? 2 : 3 });
    this.memory = new TranslationMemory({ file: path.join(DATA, 'memory', 'learned.jsonl'), phrasebookFile: path.join(here, 'phrasebook.json') });
    this.job = null; // current download
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { const s = this.status(); for (const fn of this.listeners) fn(s); }

  translationReady() { return Object.keys(catalog.pairs).every((p) => this.mt.has(p)); }
  speechReady(size) { return speechReady(size); }
  /** Best installed speech model for a language ("auto" quality: accurate for Arabic & Italian, fast otherwise). */
  speechSizeFor(lang, quality = 'auto') {
    const want = quality === 'accurate' ? 'small' : quality === 'fast' ? 'base' : (['ar', 'it', 'auto'].includes(lang) ? 'small' : 'base');
    if (speechReady(want)) return want;
    const other = want === 'small' ? 'base' : 'small';
    return speechReady(other) ? other : null;
  }

  status() {
    return {
      packs: {
        translation: { ...PACKS.translation, installed: this.translationReady() },
        'speech-fast': { ...PACKS['speech-fast'], installed: speechReady('base') },
        'speech-accurate': { ...PACKS['speech-accurate'], installed: speechReady('small') },
      },
      job: this.job && { pack: this.job.pack, received: this.job.received, total: this.job.total, phase: this.job.phase, error: this.job.error },
      memory: this.memory.stats(),
    };
  }

  async download(pack) {
    if (this.job && !this.job.done) throw new Error('A download is already running.');
    if (!PACKS[pack]) throw new Error('Unknown pack');
    const ctl = new AbortController();
    this.job = { pack, received: 0, total: PACKS[pack].bytes, phase: 'Downloading', ctl };
    this.emit();
    let last = 0;
    const tick = (n) => { this.job.received += n; if (Date.now() - last > 300) { last = Date.now(); this.emit(); } };
    try {
      if (pack === 'translation') await this.#downloadTranslation(ctl.signal, tick);
      else {
        const size = pack === 'speech-fast' ? 'base' : 'small';
        await this.#downloadVad(ctl.signal, tick);
        await this.#downloadWhisper(size, ctl.signal, tick);
      }
      this.job.phase = 'Done';
      this.job.done = true;
      log('info', `offline pack installed: ${pack}`);
    } catch (e) {
      this.job.error = ctl.signal.aborted ? 'Cancelled' : `Download failed: ${e.message}. Check the internet connection and try again.`;
      this.job.done = true;
      log('error', `offline pack ${pack} failed: ${e.message}`);
    }
    this.emit();
  }

  cancel() { this.job?.ctl?.abort(); }

  async #fetch(url, signal) {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${path.basename(url)}`);
    return Readable.fromWeb(r.body);
  }

  async #downloadTranslation(signal, tick) {
    for (const [pair, entry] of Object.entries(catalog.pairs)) {
      for (const f of Object.values(entry.files)) {
        const dest = path.join(MT_DIR, pair, path.basename(f.path).replace(/\.gz$/, ''));
        if (fs.existsSync(dest)) { tick(f.size); continue; }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const md5 = crypto.createHash('md5');
        const body = await this.#fetch(`${catalog.baseUrl}/${f.path}`, signal);
        await pipeline(body, counter((n) => tick(n)), new Transform({ transform(c, _e, cb) { md5.update(c); cb(null, c); } }), zlib.createGunzip(), fs.createWriteStream(`${dest}.part`), { signal });
        if (f.md5 && md5.digest('base64') !== f.md5) { fs.rmSync(`${dest}.part`, { force: true }); throw new Error(`checksum mismatch for ${path.basename(f.path)}`); }
        fs.renameSync(`${dest}.part`, dest);
      }
    }
  }

  async #downloadVad(signal, tick) {
    const dest = speechFiles('base').vad;
    if (fs.existsSync(dest)) { tick(catalog.speech.vad.size); return; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const body = await this.#fetch(catalog.speech.vad.url, signal);
    await pipeline(body, counter(tick), fs.createWriteStream(`${dest}.part`), { signal });
    fs.renameSync(`${dest}.part`, dest);
  }

  async #downloadWhisper(size, signal, tick) {
    const spec = catalog.speech[`whisper-${size}`];
    if (speechReady(size)) { tick(spec.size); return; }
    const dir = whisperDir(size);
    fs.mkdirSync(dir, { recursive: true });
    const ex = tar.extract();
    ex.on('entry', (h, stream, next) => {
      const name = path.basename(h.name);
      if (spec.keep.includes(name)) {
        const tmp = path.join(dir, `${name}.part`);
        stream.pipe(fs.createWriteStream(tmp)).on('finish', () => { fs.renameSync(tmp, path.join(dir, name)); next(); }).on('error', next);
      } else { stream.on('end', next); stream.resume(); }
    });
    const body = await this.#fetch(spec.url, signal);
    // Decompress while downloading so the two overlap.
    await pipeline(body, counter(tick), bz2(), ex, { signal });
    if (!speechReady(size)) throw new Error('the speech model archive was incomplete');
  }

  remove(pack) {
    if (pack === 'translation') fs.rmSync(MT_DIR, { recursive: true, force: true });
    if (pack === 'speech-fast') fs.rmSync(whisperDir('base'), { recursive: true, force: true });
    if (pack === 'speech-accurate') fs.rmSync(whisperDir('small'), { recursive: true, force: true });
    this.emit();
  }
}

export const offline = new OfflineManager();
