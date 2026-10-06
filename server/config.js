import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* optional */ }

export const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
export const DIRS = {
  uploads: path.join(DATA, 'uploads'),
  events: path.join(DATA, 'events'),
  sessions: path.join(DATA, 'sessions'),
};
for (const d of [DATA, ...Object.values(DIRS)]) fs.mkdirSync(d, { recursive: true });

const FILE = path.join(DATA, 'config.json');
const defaults = {
  deepgramKey: '',
  anthropicKey: '',
  model: 'claude-haiku-4-5',
  sttEngine: 'auto', // auto | deepgram | local | browser | demo
  port: 3000,
  publicHost: '', // override the LAN address shown in the QR code
  translationMode: 'auto', // auto (Claude online, offline otherwise) | claude | offline
  speechQuality: 'auto', // offline speech model: auto | fast | accurate
};

let cfg = { ...defaults };
try { cfg = { ...defaults, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first run */ }
if (process.env.DEEPGRAM_API_KEY) cfg.deepgramKey = process.env.DEEPGRAM_API_KEY;
if (process.env.ANTHROPIC_API_KEY) cfg.anthropicKey = process.env.ANTHROPIC_API_KEY;
if (process.env.PORT) cfg.port = Number(process.env.PORT);

export const config = cfg;

export function saveConfig(patch) {
  const allowed = ['deepgramKey', 'anthropicKey', 'model', 'sttEngine', 'publicHost', 'translationMode', 'speechQuality'];
  for (const k of allowed) {
    if (typeof patch[k] === 'string') {
      // Empty string for a key means "leave unchanged" so the UI never has to echo secrets back.
      if ((k === 'deepgramKey' || k === 'anthropicKey') && patch[k].trim() === '') continue;
      cfg[k] = patch[k].trim();
    }
  }
  if (patch.clearDeepgramKey) cfg.deepgramKey = '';
  if (patch.clearAnthropicKey) cfg.anthropicKey = '';
  const persist = { ...cfg };
  // Keys coming from the environment stay in the environment.
  if (process.env.DEEPGRAM_API_KEY) persist.deepgramKey = '';
  if (process.env.ANTHROPIC_API_KEY) persist.anthropicKey = '';
  fs.writeFileSync(FILE, JSON.stringify(persist, null, 2));
}

/** Config as the browser may see it: never includes secrets. */
export function publicConfig() {
  return {
    hasDeepgram: !!cfg.deepgramKey,
    hasAnthropic: !!cfg.anthropicKey,
    model: cfg.model,
    sttEngine: cfg.sttEngine,
    publicHost: cfg.publicHost,
    port: cfg.port,
    translationMode: cfg.translationMode,
    speechQuality: cfg.speechQuality,
  };
}
