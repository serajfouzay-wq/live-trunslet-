import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { LANGUAGES } from './languages.js';
import { DEMO_TRANSLATIONS } from './demo.js';
import { offline } from './offline/manager.js';
import { parseGlossary, protect, restore, intact } from './offline/glossary.js';
import { log } from './log.js';

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

export async function offlineTranslate({ text, from, to, glossary, onDelta }) {
  const entries = parseGlossary(glossary);
  let out = null;
  if (entries.length) {
    const { text: masked, slots } = protect(text, entries);
    if (slots.length) {
      const raw = await offline.mt.translate(masked, from, to);
      if (intact(raw, slots)) out = await restore(raw, slots, to, (term) => offline.mt.translate(term, from, to));
    }
  }
  if (out === null) out = await offline.mt.translate(text, from, to);
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

  const remembered = offline.memory.lookup(text, from, to);
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
    if (e?.name !== 'AbortError' && mode !== 'claude' && canOffline && isNetworkError(e)) {
      if (Date.now() >= offlineUntil) log('warn', 'Claude unreachable: translating offline for now');
      offlineUntil = Date.now() + 45000;
      lastEngine = 'offline';
      return offlineTranslate(opts);
    }
    throw e;
  }
}

async function claudeTranslate(opts) {
  const { text, to, onDelta, signal } = opts;
  const c = getClient();
  if (!c) throw new MissingKeyError();
  await takeSlot(signal);
  try {
    const isHaiku = /haiku/.test(config.model);
    const params = {
      model: config.model,
      max_tokens: Math.min(4000, Math.max(300, text.length * 6)),
      system: SYSTEM,
      messages: [{ role: 'user', content: buildUser(opts) }],
      // Newer models think by default; keep interpretation snappy.
      ...(isHaiku ? {} : { output_config: { effort: 'low' } }),
    };
    let acc = '';
    const stream = c.messages.stream(params, { signal, timeout: 25000, maxRetries: 1 });
    stream.on('text', (delta) => {
      acc += delta;
      onDelta?.(acc);
    });
    const final = await stream.finalMessage();
    const out = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    void to;
    return out || acc.trim();
  } finally {
    freeSlot();
  }
}

/** Ask Claude to translate prepared text (a speech, an agenda) into every language, and remember it for offline use. */
export async function teach(sentences, langs, { from: fixedFrom, glossary, context, onProgress } = {}) {
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
      const out = await claudeTranslate({ text: j.s, from: j.from, to: j.to, glossary, context });
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
