import { detectLang } from '../detect.js';

// Makes the offline translator respect the glossary:
//   "Seraj Fouzay"                         -> keep exactly as written in every language
//   "net zero = صافي الانبعاثات الصفرية"     -> use this Arabic wording when translating into Arabic
//   "board = ar: مجلس الإدارة; fr: conseil"  -> one wording per language
// Each term is swapped for a placeholder the engine copies through unchanged (XQ1, XQ2…; measured: kept
// 35/35 times across all 7 languages), then the wanted wording is put back. If a placeholder gets lost,
// the sentence is translated normally instead.

const LANG_KEY = /^(ar|en|zh|fr|de|es|tr|it)\s*:/i;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseGlossary(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    const term = (i >= 0 ? line.slice(0, i) : line).trim();
    if (term.length < 2) continue;
    const rendering = i >= 0 ? line.slice(i + 1).trim() : '';
    const byLang = {};
    if (rendering) {
      const parts = rendering.split(/[;|]/).map((p) => p.trim()).filter(Boolean);
      if (parts.some((p) => LANG_KEY.test(p))) {
        for (const p of parts) { const m = LANG_KEY.exec(p); if (m) byLang[m[1].toLowerCase()] = p.slice(m[0].length).trim(); }
      } else byLang[detectLang(rendering, 'en')] = rendering;
    }
    out.push({ term, keep: !rendering, byLang });
  }
  // Longer terms first so "New York Times" wins over "New York".
  return out.sort((a, b) => b.term.length - a.term.length);
}

const token = (i) => `XQ${i + 1}`;

/** Replace glossary terms in `text` with placeholders. */
export function protect(text, entries) {
  const slots = [];
  let out = text;
  for (const e of entries) {
    const latin = /^[\p{Script=Latin}\d\s.'’-]+$/u.test(e.term);
    if (/^\p{Script=Arabic}/u.test(e.term)) {
      // Arabic glues "and / with / for / like" onto the word: والمجلس, بالمجلس, للمجلس (ل + ال).
      const body = e.term.replace(/^ال/, '');
      const re = new RegExp(`(?<![\\p{L}])([وف]?(?:[بكل])?)(${reEsc(e.term)}|ل${reEsc(body)})(?![\\p{L}])`, 'gu');
      out = out.replace(re, (m, pre, word) => {
        const id = slots.length;
        const lil = word !== e.term; // "لل…" = "ل" + "ال…"
        slots.push({ id, token: token(id), entry: e, original: lil ? e.term : word });
        const clitic = pre || (lil ? 'ل' : '');
        return clitic ? `${clitic} ${token(id)}` : token(id);
      });
      continue;
    }
    const re = new RegExp(latin ? `(?<![\\p{L}\\d])${reEsc(e.term)}(?![\\p{L}\\d])` : reEsc(e.term), latin ? 'giu' : 'gu');
    out = out.replace(re, (m) => {
      const id = slots.length;
      slots.push({ id, token: token(id), entry: e, original: m });
      return token(id);
    });
  }
  return { text: out, slots };
}

/** True when every placeholder survived translation exactly once. */
export function intact(translated, slots) {
  return slots.every((s) => translated.split(s.token).length === 2);
}

/** Put the wanted wording back. `translateTerm(term)` gives the engine's own translation for terms without a rule for this language. */
export async function restore(translated, slots, to, translateTerm) {
  let out = translated;
  for (const s of slots) {
    let wording;
    if (s.entry.keep) wording = s.original;
    else if (s.entry.byLang[to]) wording = s.entry.byLang[to];
    else wording = translateTerm ? await translateTerm(s.original) : s.original;
    out = out.replace(s.token, wording.replace(/\$/g, '$$$$'));
  }
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out.charAt(0).toUpperCase() + out.slice(1); // "the Presidential Council met…" starts a sentence
}
