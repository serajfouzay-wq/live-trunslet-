import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';

// Small file logger: data/logs/app-YYYY-MM-DD.log (kept 14 days). Transcript text is never logged.
const dir = path.join(DATA, 'logs');
fs.mkdirSync(dir, { recursive: true });
const recent = [];

try {
  const cutoff = Date.now() - 14 * 86400000;
  for (const f of fs.readdirSync(dir)) if (fs.statSync(path.join(dir, f)).mtimeMs < cutoff) fs.unlinkSync(path.join(dir, f));
} catch { /* ignore */ }

export function log(level, message, extra) {
  const now = new Date();
  const line = `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
  recent.push(line);
  if (recent.length > 400) recent.shift();
  try { fs.appendFileSync(path.join(dir, `app-${now.toISOString().slice(0, 10)}.log`), `${line}\n`); } catch { /* disk full etc. */ }
  (level === 'error' ? console.error : console.log)(line);
}

export const recentLog = (n = 150) => recent.slice(-n);
export const LOG_DIR = dir;
