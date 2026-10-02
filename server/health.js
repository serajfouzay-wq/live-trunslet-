import { config } from './config.js';

/** Checks the Deepgram key with a cheap authenticated request (no audio, no cost). */
export async function testDeepgram() {
  if (!config.deepgramKey) return { ok: false, error: 'No Deepgram key yet. Paste it above and press Save.' };
  const base = process.env.DEEPGRAM_REST_URL || 'https://api.deepgram.com';
  try {
    const r = await fetch(`${base}/v1/projects`, { headers: { Authorization: `Token ${config.deepgramKey}` }, signal: AbortSignal.timeout(10000) });
    if (r.ok) return { ok: true };
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'Deepgram rejected this key. Copy it again from the Deepgram console (API Keys).' };
    return { ok: false, error: `Deepgram answered with an unexpected error (HTTP ${r.status}).` };
  } catch (e) {
    return { ok: false, error: `Can't reach Deepgram (${e.cause?.code || e.name}). Check this computer's internet connection.` };
  }
}
