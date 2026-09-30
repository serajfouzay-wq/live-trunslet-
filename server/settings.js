import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { LANG_CODES, isLang } from './languages.js';

export const THEMES = ['midnight', 'aurora', 'gold', 'light', 'contrast'];
export const LAYOUTS = ['stack', 'columns', 'grid', 'focus', 'subtitles'];
export const LOGO_POS = ['top-left', 'top-center', 'top-right'];
export const QR_POS = ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'center'];

export const DEFAULT_SETTINGS = {
  title: 'Welcome',
  subtitle: 'Live translation',
  showHeader: true,
  logo: '',
  logoPos: 'top-left',
  logoSize: 100, // % of the default size
  bgLandscape: '',
  bgPortrait: '',
  theme: 'midnight',
  accent: '#5aa2ff',
  dim: 45, // background darkening, %
  blur: 0, // background blur, px
  layout: 'stack',
  screenLangs: ['en', 'ar'],
  phoneLangs: [...LANG_CODES],
  fontScale: 100,
  uniformSize: true, // same text size in every language lane
  maxLines: 2,
  showOriginal: true,
  showLabels: true,
  showSpeaker: true,
  showQR: false,
  qrPos: 'bottom-right',
  blank: false,
  sourceLang: 'en', // a language code or "auto"
  speakerMode: 'single', // single | multi
  glossary: '',
  context: '',
};

const path_ = path.join(DATA, 'settings.json');

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : undefined);
const oneOf = (v, list) => (list.includes(v) ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const langList = (v) => (Array.isArray(v) ? [...new Set(v.filter(isLang))] : undefined);
const asset = (v) => (typeof v === 'string' && (v === '' || /^\/uploads\/[\w.-]+$/.test(v)) ? v : undefined);

const RULES = {
  title: (v) => str(v, 140),
  subtitle: (v) => str(v, 200),
  showHeader: bool,
  logo: asset,
  logoPos: (v) => oneOf(v, LOGO_POS),
  logoSize: (v) => num(v, 30, 250),
  bgLandscape: asset,
  bgPortrait: asset,
  theme: (v) => oneOf(v, THEMES),
  accent: (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined),
  dim: (v) => num(v, 0, 90),
  blur: (v) => num(v, 0, 30),
  layout: (v) => oneOf(v, LAYOUTS),
  screenLangs: (v) => { const l = langList(v); return l && l.length ? l.slice(0, 7) : undefined; },
  phoneLangs: (v) => { const l = langList(v); return l && l.length ? l : undefined; },
  fontScale: (v) => num(v, 50, 160),
  uniformSize: bool,
  maxLines: (v) => Math.round(num(v, 1, 5) ?? NaN) || undefined,
  showOriginal: bool,
  showLabels: bool,
  showSpeaker: bool,
  showQR: bool,
  qrPos: (v) => oneOf(v, QR_POS),
  blank: bool,
  sourceLang: (v) => (v === 'auto' || isLang(v) ? v : undefined),
  speakerMode: (v) => oneOf(v, ['single', 'multi']),
  glossary: (v) => str(v, 8000),
  context: (v) => str(v, 1000),
};

/** Whitelist + validate a patch. Unknown or invalid keys are dropped. */
export function sanitize(patch) {
  const out = {};
  for (const [k, rule] of Object.entries(RULES)) {
    if (patch && k in patch) {
      const v = rule(patch[k]);
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...sanitize(JSON.parse(fs.readFileSync(path_, 'utf8'))) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let timer;
export function saveSettings(settings) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { fs.writeFileSync(path_, JSON.stringify(settings, null, 2)); } catch { /* ignore */ }
  }, 400);
}

/** Settings a viewer (screen/phone) may see: everything except the glossary text. */
export function viewerSettings(s) {
  const { glossary, context, ...rest } = s; // eslint-disable-line no-unused-vars
  return rest;
}
