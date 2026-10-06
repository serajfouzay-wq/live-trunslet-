import fs from 'node:fs';
import path from 'node:path';

// Translation memory: sentences the app already knows how to translate.
//  - a hand-written phrasebook of common event sentences (all 8 languages)
//  - everything Claude translates while online ("learned"), so the same sentences come out the same offline
//  - sentences you teach it before an event (your speech, agenda, names)
// Matching ignores case, punctuation and Arabic vowel marks; numbers can differ ("in 10 minutes" ~ "in 15 minutes");
// near-identical sentences (small speech-recognition differences) also match.

const MAX = 50000;

export function norm(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '') // Arabic diacritics and tatweel
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const numbersOf = (s) => (String(s).match(/\d+(?:[.,:]\d+)*/g) || []);
const template = (n) => n.replace(/\d+(?:[.,:]\d+)*/g, '#');

function grams(s) {
  const t = ` ${s} `;
  const out = new Set();
  for (let i = 0; i < t.length - 2; i += 1) out.add(t.slice(i, i + 3));
  return out;
}

function similarity(a, b) {
  // Levenshtein ratio on characters (sentences are short).
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  if (Math.abs(m - n) / Math.max(m, n) > 0.2) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

export class TranslationMemory {
  constructor({ file, phrasebookFile }) {
    this.file = file;
    this.exact = new Map(); // from|to|norm -> { tr, src, origin }
    this.tmpl = new Map(); // from|to|template -> { tr, src, nums }
    this.byPair = new Map(); // from|to -> [{ n, tr, src }]
    this.index = new Map(); // from|to|gram -> Set(entry)
    this.learned = 0;
    this.pending = [];
    this.phrasebookFile = phrasebookFile;
    if (phrasebookFile) this.#loadPhrasebook(phrasebookFile);
    this.phrasebookSize = this.exact.size;
    this.#loadLearned();
  }

  #put(from, to, src, tr, origin) {
    const n = norm(src);
    if (!n || !tr) return;
    const key = `${from}|${to}|${n}`;
    const entry = { n, src, tr, origin, nums: numbersOf(src) };
    const isNew = !this.exact.has(key);
    this.exact.set(key, entry);
    if (entry.nums.length) this.tmpl.set(`${from}|${to}|${template(n)}`, entry);
    if (isNew) {
      const pk = `${from}|${to}`;
      if (!this.byPair.has(pk)) this.byPair.set(pk, []);
      this.byPair.get(pk).push(entry);
      for (const g of grams(n)) {
        const ik = `${pk}|${g}`;
        if (!this.index.has(ik)) this.index.set(ik, new Set());
        this.index.get(ik).add(entry);
      }
    }
  }

  #loadPhrasebook(file) {
    try {
      const { entries } = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const e of entries) {
        const { aliases = {}, ...langs } = e;
        for (const [from, src] of Object.entries(langs)) for (const [to, tr] of Object.entries(langs)) if (from !== to) this.#put(from, to, src, tr, 'phrasebook');
        // other ways of saying it (e.g. Libyan Arabic): recognised as source only, never produced as output
        for (const [from, list] of Object.entries(aliases)) for (const src of list) for (const [to, tr] of Object.entries(langs)) if (to !== from) this.#put(from, to, src, tr, 'phrasebook');
      }
    } catch { /* optional */ }
  }

  #loadLearned() {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-MAX);
      for (const l of lines) {
        try { const r = JSON.parse(l); this.#put(r.f, r.t, r.s, r.r, r.o || 'learned'); this.learned += 1; } catch { /* skip bad line */ }
      }
    } catch { /* first run */ }
  }

  /** Remember a good translation (from Claude, or taught by the user). */
  add(from, to, src, tr, origin = 'claude') {
    if (!src || !tr || src.length > 400 || from === to) return;
    const key = `${from}|${to}|${norm(src)}`;
    if (this.exact.get(key)?.tr === tr) return;
    this.#put(from, to, src, tr, origin);
    this.learned += 1;
    this.pending.push(JSON.stringify({ f: from, t: to, s: src, r: tr, o: origin }));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 1000);
  }

  flush() {
    if (!this.pending.length) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${this.pending.join('\n')}\n`);
    } catch { /* ignore */ }
    this.pending = [];
  }

  /** A known translation for this sentence, or null. */
  lookup(text, from, to) {
    const n = norm(text);
    if (!n) return null;
    const hit = this.exact.get(`${from}|${to}|${n}`);
    if (hit) return { text: hit.tr, how: 'exact', origin: hit.origin };

    const nums = numbersOf(text);
    if (nums.length) {
      const t = this.tmpl.get(`${from}|${to}|${template(n)}`);
      if (t && t.nums.length === nums.length) {
        let out = t.tr;
        let ok = true;
        t.nums.forEach((old, i) => { if (out.includes(old)) out = out.replace(old, `\u0000${i}\u0000`); else ok = false; });
        if (ok) {
          nums.forEach((nu, i) => { out = out.replace(`\u0000${i}\u0000`, nu); });
          return { text: out, how: 'numbers', origin: t.origin };
        }
      }
    }

    // Near-identical sentence (a word misheard, "the"/"a"...). Numbers must be the same.
    if (n.length >= 12) {
      const pk = `${from}|${to}|`;
      const counts = new Map();
      for (const g of grams(n)) for (const e of this.index.get(pk + g) || []) counts.set(e, (counts.get(e) || 0) + 1);
      let best = null, bestScore = 0;
      for (const [e, c] of counts) {
        if (c < 0.6 * Math.max(n.length, e.n.length)) continue;
        const s = similarity(n, e.n);
        if (s > bestScore) { best = e; bestScore = s; }
      }
      if (best && bestScore >= 0.9 && numbersOf(best.src).join() === nums.join()) return { text: best.tr, how: 'similar', origin: best.origin, score: bestScore };
    }
    return null;
  }

  stats() { return { learned: this.learned, phrasebook: this.phrasebookSize }; }

  clearLearned() {
    try { fs.unlinkSync(this.file); } catch { /* ignore */ }
    this.exact.clear(); this.tmpl.clear(); this.byPair.clear(); this.index.clear();
    this.learned = 0;
    if (this.phrasebookFile) this.#loadPhrasebook(this.phrasebookFile);
  }
}
