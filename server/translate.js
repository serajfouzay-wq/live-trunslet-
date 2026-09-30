import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { LANGUAGES } from './languages.js';
import { DEMO_TRANSLATIONS } from './demo.js';

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
- The text is a fragment of live speech and may be imperfect; translate it as it is.`;

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

/**
 * Translate `text` into `to`. Streams partial output via onDelta(fullTextSoFar)
 * and resolves with the final string.
 */
export async function translate(opts) {
  const { text, from, to, onDelta } = opts;
  if (from === to) return text;

  const c = getClient();
  if (!c) return demoTranslate(opts);

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
  const stream = c.messages.stream(params);
  stream.on('text', (delta) => {
    acc += delta;
    onDelta?.(acc);
  });
  const final = await stream.finalMessage();
  const out = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return out || acc.trim();
}

// Without an Anthropic key the app still runs: the built-in demo script has
// ready translations, anything else is echoed with a language tag.
async function demoTranslate({ text, to, onDelta }) {
  const hit = DEMO_TRANSLATIONS.get(text);
  const out = hit?.[to] ?? `[${to}] ${text}`;
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
  if (!c) throw new Error('No Anthropic API key set');
  const r = await c.messages.create({
    model: config.model,
    max_tokens: 40,
    messages: [{ role: 'user', content: 'Translate "Good evening" into French. Output only the translation.' }],
    ...(/haiku/.test(config.model) ? {} : { output_config: { effort: 'low' } }),
  });
  return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}
