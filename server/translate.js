import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { LANGUAGES } from './languages.js';
import { DEMO_TRANSLATIONS } from './demo.js';
import { offline } from './offline/manager.js';
import { parseGlossary, protect, restore, intact } from './offline/glossary.js';
import { log } from './log.js';
import { normalizeLibyan } from './offline/arabic.js';

let client = null;
let clientKey = '';
function getClient() {
  if (!config.anthropicKey) return null;
  if (!client || clientKey !== config.anthropicKey) {
    client = new Anthropic({ apiKey: config.anthropicKey, maxRetries: 2 });
    clientKey = config.anthropicKey;
  }
  return client;
}

export function translatorReady() {
  return !!config.anthropicKey;
}

const SYSTEM = `You are a professional simultaneous interpreter working at a live event. Your translation appears on a big screen while the speaker is still talking.

Rules:
- Output ONLY the translation of the given text: no quotes, notes, labels, or explanations.
- Be faithful and natural. Keep the speaker's tone and register. Do not add or omit meaning.
- Use the previous sentences only for context, terminology and consistency. Never translate or repeat them.
- Keep names, brands and numbers correct. Follow the glossary exactly when a term appears.
- If the text is already in the target language, return it unchanged.
- The text is a fragment of live speech and may be imperfect (it may stop mid-sentence); translate it as it is.`;

const GOVERNMENT = `This is an official government event. Use a formal, respectful register suitable for official communication.
- Render official titles, honorifics and institution names correctly and consistently (for example معالي / سعادة = Your Excellency, وزير = Minister, عميد البلدية = Mayor, رئيس الوزراء = Prime Minister).
- Translate religious and ceremonial formulas (بسم الله الرحمن الرحيم, السلام عليكم ورحمة الله وبركاته, حفظ الله ليبيا) with their conventional equivalents.
- Translate exactly what was said: never add commentary, opinions or political judgement.`;

const LIBYAN = `The Arabic comes from live speech recognition. Speakers often use Libyan Arabic mixed with Modern Standard Arabic. Common Libyan words:
توا / تو = now; هلبا = a lot, very; باهي = good, okay; نبي = I want; نبو = we want; يبي = he wants; شن / شنو = what; علاش = why; وين = where; كيفاش = how;
امتاع / متاع = of, belonging to; بـ before a verb = future (بنبدو = we will start, بيكون = it will be); ما...ش = negation (مانبوش = we don't want, ما فيش = there is no);
قاعد + verb = ongoing action (قاعدين نخدمو = we are working); نخدم = I work; زادة = also; ديما = always; غدوة = tomorrow; اللي = who / which / that;
حنا = we; هكي = like this; شوية = a little; باش = in order to; يعطيك الصحة = thank you; مرحبتين = welcome; درتو = you did.
Speech recognition may contain errors (wrong or split words): infer the most likely intended meaning from context and translate that meaning, not word by word.`;

/** The system prompt for this request (stable per event setup, so it caches well). */
function systemFor({ from, eventType, dialect }) {
  let sys = SYSTEM;
  if (eventType === 'government') sys += `\n\n${GOVERNMENT}`;
  if (from === 'ar' && dialect !== 'msa') sys += `\n\n${LIBYAN}`;
  return sys;
}

/** Claude model for this sentence: Arabic speech can use the stronger model (dialect needs more nuance). */
function modelFor({ from, strongArabic }) {
  if (from === 'ar' && strongArabic !== false && /haiku/.test(config.model)) return 'claude-sonnet-5-5';
  return config.model;
}

const CLEAN_SYSTEM = `You clean up live speech-recognition transcripts of Arabic speech for display on a screen at an official event.
Rewrite the text in clear, correct Modern Standard Arabic: fix recognition errors, change Libyan dialect words into their standard equivalents, and add correct punctuation.
Keep every name, number and the speaker's meaning and order. Do not summarise, add, or remove content. Output only the rewritten Arabic text.

${LIBYAN}`;

function buildUser({ text, from, to, history, glossary, context }) {
  const parts = [];
  if (context) parts.push(`Event context: ${context}`);
  if (glossary) parts.push(`Glossary (source term = required rendering, or just a term to keep unchanged):\n${glossary}`);
  if (history?.length) {
    parts.push('Previous sentences (context only):\n' + history.map((h) => `- ${h.src}${h.tr ? `  =>  ${h.tr}` : ''}`).join('\n'));
  }
  const fromName = from && LANGUAGES[from] ? LANGUAGES[from].name : 'the detected language';
  parts.push(`Translate from ${fromName} into ${LANGUAGES[to].name}:\n<text>${text}</text>`);
  return parts.join('\n\n');
}

/* At most a few requests at once, so a burst (8 languages x several sentences) can't trip rate limits. */
const MAX_PARALLEL = 10;
let active = 0;
const waiters = [];
async function takeSlot(signal) {
  if (active < MAX_PARALLEL) { active += 1; return; }
  await new Promise((resolve, reject) => {
    const w = () => resolve();
    waiters.push(w);
    signal?.addEventListener('abort', () => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); } }, { once: true });
  });
}
function freeSlot() {
  const next = waiters.shift();
  if (next) next(); else active -= 1;
}

export class MissingKeyError extends Error {
  constructor() { super('NO_KEY'); this.name = 'MissingKeyError'; }
}

/** A readable explanation for an error from the Claude API or the network. */
export function explain(e) {
  if (e?.name === 'MissingKeyError') return 'No Claude API key yet. Open Settings, paste your Anthropic key, and press Save.';
  const status = e?.status;
  if (status === 401 || status === 403) return 'Claude rejected the API key. Check it in Settings.';
  if (status === 404) return 'The selected Claude model was not found. Pick another model in Settings.';
  if (status === 429) return 'Claude is rate-limiting requests (too many at once). It will catch up in a moment.';
  if (status === 529 || status >= 500) return 'Claude is temporarily overloaded. Retrying…';
  if (e?.name === 'APIConnectionError' || e?.name === 'APIConnectionTimeoutError' || /ENOTFOUND|ECONN|ETIMEDOUT|fetch failed|timed out/i.test(e?.message || '')) return "Can't reach Claude. Check this computer's internet connection.";
  return `Translation problem: ${e?.message || e}`;
}

/** Errors where trying again cannot help. */
export const isFatal = (e) => e?.name === 'MissingKeyError' || [400, 401, 403, 404].includes(e?.status);

/* ------------------------------------------------------------------ routing */
// Which engine translates a sentence:
//   1. the translation memory (hand-written phrasebook + everything Claude translated before) — instant, free
//   2. Claude, when there is a key and internet (and the mode allows it)
//   3. the offline engine on this laptop — when offline, when Claude can't be reached, or in "offline" mode
let offlineUntil = 0; // after a network failure, use the offline engine for a while before trying Claude again
let lastEngine = null;

const isNetworkError = (e) => e?.name === 'APIConnectionError' || e?.name === 'APIConnectionTimeoutError' || /ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|timed out|network/i.test(e?.message || '');

export function translatorState() {
  const mode = config.translationMode || 'auto';
  const offlineReady = offline.translationReady();
  let engine;
  if (mode === 'offline') engine = offlineReady ? 'offline' : 'none';
  else if (mode === 'claude') engine = config.anthropicKey ? 'claude' : 'none';
  else if (config.anthropicKey && Date.now() >= offlineUntil) engine = 'claude';
  else engine = offlineReady ? 'offline' : 'none';
  return { mode, engine, offlineReady, internetLost: Date.now() < offlineUntil, lastEngine };
}

export async function offlineTranslate({ text, from, to, glossary, onDelta, dialect }) {
  const entries = parseGlossary(glossary);
  const prep = (t) => (from === 'ar' && dialect !== 'msa' ? normalizeLibyan(t) : t); // Libyan words -> formal Arabic
  let out = null;
  if (entries.length) {
    const { text: masked, slots } = protect(text, entries);
    if (slots.length) {
      const raw = await offline.mt.translate(prep(masked), from, to);
      if (intact(raw, slots)) out = await restore(raw, slots, to, (term) => offline.mt.translate(term, from, to));
    }
  }
  if (out === null) out = await offline.mt.translate(prep(text), from, to);
  onDelta?.(out);
  return out;
}

/**
 * Translate `text` into `to`. Streams partial output via onDelta(fullTextSoFar)
 * and resolves with the final string. Pass `signal` to cancel (used by draft mode).
 */
export async function translate(opts) {
  const { text, from, to, signal } = opts;
  if (from === to) return text;

  const remembered = offline.memory.lookup(text, from, to) || (from === 'ar' && opts.dialect !== 'msa' ? offline.memory.lookup(normalizeLibyan(text), from, to) : null);
  if (remembered) { lastEngine = 'memory'; opts.onDelta?.(remembered.text); return remembered.text; }

  const { mode } = translatorState();
  const canOffline = offline.mt.canTranslate(from, to);
  const preferOffline = mode === 'offline' || (mode === 'auto' && (!config.anthropicKey || Date.now() < offlineUntil));

  if (preferOffline && canOffline) { lastEngine = 'offline'; return offlineTranslate(opts); }
  if (!getClient()) return demoTranslate(opts);

  try {
    const out = await claudeTranslate(opts);
    lastEngine = 'claude';
    if (!signal && out) offline.memory.add(from, to, text, out, 'claude'); // the offline mode learns from Claude
    return out;
  } catch (e) {
    if (e?.name === 'RefusalError' && canOffline) { lastEngine = 'offline'; return offlineTranslate(opts); }
    if (e?.name !== 'AbortError' && mode !== 'claude' && canOffline && isNetworkError(e)) {
      if (Date.now() >= offlineUntil) log('warn', 'Claude unreachable: translating offline for now');
      offlineUntil = Date.now() + 45000;
      lastEngine = 'offline';
      return offlineTranslate(opts);
    }
    throw e;
  }
}

let fallbacksOk = true; // server-side refusal fallback (beta); switched off if the API does not accept it

async function claude({ system, user, model, maxTokens, onDelta, signal }) {
  const c = getClient();
  if (!c) throw new MissingKeyError();
  await takeSlot(signal);
  try {
    const isHaiku = /haiku/.test(model);
    const extra = isHaiku ? {} : { output_config: { effort: 'low' } };
    const useFallbacks = fallbacksOk && /sonnet-5-5|opus-5-5/.test(model);
    const params = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], ...extra, ...(useFallbacks ? { fallbacks: 'default' } : {}) };
    const reqOpts = { signal, timeout: 25000, maxRetries: 1, ...(useFallbacks ? { headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } } : {}) };
    let acc = '';
    let final;
    try {
      const stream = c.messages.stream(params, reqOpts);
      stream.on('text', (delta) => { acc += delta; onDelta?.(acc); });
      final = await stream.finalMessage();
    } catch (e) {
      if (useFallbacks && e?.status === 400 && /fallback/i.test(e?.message || '')) {
        fallbacksOk = false;
        log('warn', 'refusal fallback not accepted by the API; continuing without it');
        delete params.fallbacks;
        acc = '';
        const stream = c.messages.stream(params, { signal, timeout: 25000, maxRetries: 1 });
        stream.on('text', (delta) => { acc += delta; onDelta?.(acc); });
        final = await stream.finalMessage();
      } else throw e;
    }
    if (final.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined to translate this sentence'), { name: 'RefusalError' });
    const out = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return out || acc.trim();
  } finally {
    freeSlot();
  }
}

async function claudeTranslate(opts) {
  const { text } = opts;
  return claude({
    system: systemFor(opts),
    user: buildUser(opts),
    model: modelFor(opts),
    maxTokens: Math.min(4000, Math.max(300, text.length * 6)),
    onDelta: opts.onDelta,
    signal: opts.signal,
  });
}

/**
 * Arabic speech shown on screen as clean formal Arabic (fixes recognition errors and dialect words).
 * Online: Claude rewrites it. Offline: the Libyan normalizer.
 */
export async function cleanArabic(opts) {
  const { text, onDelta } = opts;
  const { engine } = translatorState();
  if (engine === 'claude') {
    try {
      return await claude({ system: CLEAN_SYSTEM, user: `<text>${text}</text>`, model: modelFor({ ...opts, from: 'ar' }), maxTokens: Math.min(3000, Math.max(200, text.length * 4)), onDelta, signal: opts.signal });
    } catch (e) {
      if (!isNetworkError(e) && e?.name !== 'RefusalError') throw e;
    }
  }
  const out = normalizeLibyan(text);
  onDelta?.(out);
  return out;
}

/** Ask Claude to translate prepared text (a speech, an agenda) into every language, and remember it for offline use. */
export async function teach(sentences, langs, { from: fixedFrom, onProgress, ...langOpts } = {}) {
  if (!getClient()) throw new MissingKeyError();
  const { detectLang } = await import('./detect.js');
  const jobs = [];
  for (const s of sentences) {
    const from = fixedFrom && fixedFrom !== 'auto' ? fixedFrom : detectLang(s, 'en');
    for (const to of langs) if (to !== from) jobs.push({ s, from, to });
  }
  let done = 0, failed = 0;
  await Promise.all(jobs.map(async (j) => {
    try {
      const out = await claudeTranslate({ ...langOpts, text: j.s, from: j.from, to: j.to });
      offline.memory.add(j.from, j.to, j.s, out, 'taught');
    } catch { failed += 1; }
    done += 1;
    onProgress?.(done, jobs.length);
  }));
  return { total: jobs.length, failed };
}

// Without an Anthropic key only the built-in demo talk can be translated (it has ready translations).
// Anything else fails clearly instead of pretending to translate.
async function demoTranslate({ text, to, onDelta }) {
  const hit = DEMO_TRANSLATIONS.get(text);
  if (!hit?.[to]) throw new MissingKeyError();
  const out = hit[to];
  let shown = '';
  for (const ch of Array.from(out)) {
    shown += ch;
    onDelta?.(shown);
    await new Promise((r) => setTimeout(r, 14));
  }
  return out;
}

export async function testAnthropic() {
  const c = getClient();
  if (!c) throw new MissingKeyError();
  const stream = c.messages.stream({
    model: config.model,
    max_tokens: 40,
    messages: [{ role: 'user', content: 'Translate "Good evening" into French. Output only the translation.' }],
    ...(/haiku/.test(config.model) ? {} : { output_config: { effort: 'low' } }),
  }, { timeout: 20000, maxRetries: 0 });
  const r = await stream.finalMessage();
  return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}
