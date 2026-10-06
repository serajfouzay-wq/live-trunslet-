import fs from 'node:fs';
import path from 'node:path';
import { BatchTranslator, TranslatorBacking } from './bergamot/translator.js';
import { log } from '../log.js';

// Offline translation with Mozilla's Firefox Translations models (Bergamot engine, runs on the CPU).
// Every model translates to or from English; other pairs go through English (e.g. Arabic -> English -> French).
//
// Memory: each engine (one worker thread with its own WebAssembly memory) safely holds about 3 models
// (~280 MB each). Each model is loaded into exactly one engine and engines are recycled when full.

const MAX_MODELS_PER_ENGINE = 3;

export class OfflineTranslator {
  constructor({ dir, catalog, maxEngines = 3 }) {
    this.dir = dir;
    this.maxEngines = maxEngines;
    this.catalog = catalog;
    this.engines = []; // { tr, models:Set<pair>, used:number }
    this.where = new Map(); // pair -> engine
  }

  has(pair) {
    const entry = this.catalog.pairs[pair];
    if (!entry) return false;
    return Object.values(entry.files).every((f) => fs.existsSync(this.file(pair, f)));
  }

  file(pair, f) { return path.join(this.dir, pair, path.basename(f.path).replace(/\.gz$/, '')); }

  /** Which models a translation needs: direct when English is on one side, otherwise via English. */
  route(from, to) {
    if (from === to) return [];
    if (from === 'en' || to === 'en') return [`${from}-${to}`];
    return [`${from}-en`, `en-${to}`];
  }

  canTranslate(from, to) { return this.route(from, to).every((p) => this.has(p)); }

  #backingFor(pair) {
    const self = this;
    const entry = this.catalog.pairs[pair];
    class OneModel extends TranslatorBacking {
      async loadModelRegistery() {
        const [from, to] = pair.split('-');
        const f = (k) => ({ name: self.file(pair, entry.files[k]) });
        const files = { model: f('model'), lex: f('lexicalShortlist') };
        if (entry.files.vocab) files.vocab = f('vocab');
        else { files.srcvocab = f('srcVocab'); files.trgvocab = f('trgVocab'); }
        return [{ from, to, files }];
      }
      async fetch(file) {
        const b = await fs.promises.readFile(file);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      }
    }
    return OneModel;
  }

  #engineFor(pair) {
    let e = this.where.get(pair);
    if (e) { e.used = Date.now(); return e; }
    e = this.engines.find((x) => x.models.size < MAX_MODELS_PER_ENGINE);
    if (!e && this.engines.length < this.maxEngines) e = this.#newEngine();
    if (!e) {
      // All engines full: recycle the one used least recently.
      const lru = this.engines.reduce((a, b) => (a.used <= b.used ? a : b));
      this.#dropEngine(lru);
      e = this.#newEngine();
    }
    e.models.add(pair);
    e.used = Date.now();
    this.where.set(pair, e);
    return e;
  }

  #newEngine() {
    const e = { models: new Set(), used: Date.now(), backings: new Map() };
    // One BatchTranslator per engine; its backing knows every model assigned to this engine.
    const self = this;
    class EngineBacking extends TranslatorBacking {
      async loadModelRegistery() { return []; }
      getModels({ from, to }) { return Promise.resolve([{ from, to, files: null, pair: `${from}-${to}` }]); }
      async getTranslationModel({ from, to }) {
        const B = self.#backingFor(`${from}-${to}`);
        return new B({}).loadTranslationModel({ from, to });
      }
    }
    e.tr = new BatchTranslator({ workers: 1, batchSize: 4, onerror: (err) => log('error', `offline translation engine: ${err?.message || err}`) }, new EngineBacking({}));
    this.engines.push(e);
    return e;
  }

  #dropEngine(e) {
    for (const p of e.models) this.where.delete(p);
    this.engines = this.engines.filter((x) => x !== e);
    e.tr.delete().catch(() => {});
  }

  async #hop(pair, text, html) {
    const [from, to] = pair.split('-');
    const e = this.#engineFor(pair);
    try {
      const r = await e.tr.translate({ from, to, text, html, qualityScores: false });
      return r.target.text;
    } catch (err) {
      // The engine may have run out of memory: start a fresh one and try once more.
      log('warn', `offline ${pair} failed (${err?.message || err}); restarting engine`);
      this.#dropEngine(e);
      const e2 = this.#engineFor(pair);
      const r = await e2.tr.translate({ from, to, text, html, qualityScores: false });
      return r.target.text;
    }
  }

  /** Translate text (plain, or HTML when `html` is true). */
  async translate(text, from, to, { html = false } = {}) {
    let out = text;
    for (const pair of this.route(from, to)) out = await this.#hop(pair, out, html);
    return out;
  }

  /** Load the models a language setup will need, so the first sentence is fast. */
  async warm(from, targets) {
    const pairs = new Set(targets.flatMap((t) => this.route(from, t)));
    for (const p of pairs) if (this.has(p)) await this.#hop(p, 'Hello.', false).catch(() => {});
  }

  async close() { for (const e of [...this.engines]) this.#dropEngine(e); }
}
