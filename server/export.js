import { LANGUAGES, isLang } from './languages.js';
import { translate } from './translate.js';

const pad = (n, w = 2) => String(n).padStart(w, '0');
export function clock(ms, srt = false) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000), m = Math.floor((t % 3600000) / 60000), s = Math.floor((t % 60000) / 1000);
  return srt ? `${pad(h)}:${pad(m)}:${pad(s)},${pad(t % 1000, 3)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const slug = (s) => String(s || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 40) || 'transcript';

/** Text of a segment in a language ('' if it was never translated or is still being written). */
const textOf = (seg, lang) => {
  if (seg.src === lang) return seg.text;
  const finished = seg.trDone ? !!seg.trDone[lang] : true; // sessions saved by older versions have no flags
  return finished ? seg.tr?.[lang] || '' : '';
};

/** Translate whatever is missing (used when exporting languages nobody was reading live). */
async function fillMissing(segments, langs, opts) {
  const jobs = [];
  for (const seg of segments) for (const lang of langs) if (!textOf(seg, lang)) jobs.push([seg, lang]);
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < jobs.length) {
      const [seg, lang] = jobs[i++];
      const idx = segments.indexOf(seg);
      const history = segments.slice(Math.max(0, idx - 2), idx).map((s) => ({ src: s.text, tr: textOf(s, lang) }));
      try {
        seg.tr = seg.tr || {};
        seg.tr[lang] = await translate({ text: seg.text, from: seg.src, to: lang, history, glossary: opts.glossary, context: opts.context });
      } catch { /* leave blank */ }
    }
  }));
}

export async function buildExport({ session, segments, settings }, { format, langs, fill }) {
  langs = (langs || []).filter(isLang);
  if (!langs.length) langs = [...new Set(segments.map((s) => s.src))].slice(0, 3);
  const segs = segments.map((s) => ({ ...s, tr: { ...s.tr } })); // never mutate the live transcript
  if (fill) await fillMissing(segs, langs, { glossary: settings?.glossary, context: settings?.context });

  const title = session.name || settings?.title || 'Transcript';
  const started = new Date(session.startedAt);
  const base = `${slug(title)}-${started.toISOString().slice(0, 10)}`;
  const name = (l) => LANGUAGES[l].name;

  if (format === 'json') {
    return { type: 'application/json', file: `${base}.json`, body: JSON.stringify({ title, startedAt: session.startedAt, languages: langs, segments: segs.map((s) => ({ time: clock(s.t), speaker: s.speaker, source: s.src, original: s.text, translations: Object.fromEntries(langs.map((l) => [l, textOf(s, l)])) })) }, null, 2) };
  }

  if (format === 'srt') {
    const cues = segs.map((s, i) => {
      const next = segs[i + 1]?.t;
      const minEnd = s.t + 1200;
      let end = s.te && s.te > s.t ? s.te : s.t + Math.max(1500, s.text.length * 65);
      end = Math.max(end, minEnd);
      if (next && end > next - 40) end = Math.max(minEnd, next - 40);
      const lines = langs.map((l) => textOf(s, l)).filter(Boolean).join('\n');
      return `${i + 1}\n${clock(s.t, true)} --> ${clock(end, true)}\n${lines}\n`;
    });
    return { type: 'application/x-subrip; charset=utf-8', file: `${base}.srt`, body: `﻿${cues.join('\n')}` };
  }

  if (format === 'md') {
    const out = [`# ${title}`, `*${started.toLocaleString('en-GB')} · ${langs.map(name).join(', ')}*`, ''];
    for (const s of segs) {
      out.push(`**${clock(s.t)}**${s.speaker ? ` · ${s.speaker}` : ''}  `);
      for (const l of langs) out.push(`- **${l.toUpperCase()}**: ${textOf(s, l) || '—'}`);
      out.push('');
    }
    return { type: 'text/markdown; charset=utf-8', file: `${base}.md`, body: `﻿${out.join('\n')}` };
  }

  if (format === 'html') {
    const head = langs.map((l) => `<th>${esc(LANGUAGES[l].native)}</th>`).join('');
    const rows = segs.map((s) => `<tr><td class="t">${clock(s.t)}${s.speaker ? `<br><small>${esc(s.speaker)}</small>` : ''}</td>${langs.map((l) => `<td dir="${LANGUAGES[l].dir}" lang="${l}">${esc(textOf(s, l)) || '<span class="na">—</span>'}</td>`).join('')}</tr>`).join('\n');
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
      body{font:15px/1.55 'Segoe UI',system-ui,'Microsoft YaHei',Tahoma,sans-serif;color:#111;margin:32px auto;max-width:1100px;padding:0 20px}
      h1{margin:0 0 4px;font-size:26px} .meta{color:#666;margin-bottom:22px}
      table{width:100%;border-collapse:collapse} th{position:sticky;top:0;background:#f2f4f8;text-align:start;padding:8px 10px;border-bottom:2px solid #cfd6e4;font-size:13px}
      td{vertical-align:top;padding:9px 10px;border-bottom:1px solid #e6e9f0} td.t{white-space:nowrap;color:#777;font-size:12px;width:1%} td.t small{color:#999}
      .na{color:#bbb} .bar{position:fixed;top:12px;right:12px} button{padding:8px 14px;border:0;border-radius:8px;background:#2f6bff;color:#fff;font:inherit;cursor:pointer}
      @media print{.bar{display:none} body{margin:0;max-width:none} th{position:static} tr{break-inside:avoid}}
    </style></head><body><div class="bar"><button onclick="print()">Print / Save as PDF</button></div>
    <h1>${esc(title)}</h1><div class="meta">${esc(started.toLocaleString('en-GB'))} · ${segs.length} sentences</div>
    <table><thead><tr><th>Time</th>${head}</tr></thead><tbody>${rows}</tbody></table></body></html>`;
    return { type: 'text/html; charset=utf-8', file: `${base}.html`, body, inline: true };
  }

  // Plain text
  const out = [title, started.toLocaleString('en-GB'), '='.repeat(40), ''];
  for (const s of segs) {
    out.push(`[${clock(s.t)}]${s.speaker ? ` ${s.speaker}` : ''}`);
    for (const l of langs) out.push(`  ${l.toUpperCase()}: ${textOf(s, l) || '—'}`);
    out.push('');
  }
  return { type: 'text/plain; charset=utf-8', file: `${base}.txt`, body: `﻿${out.join('\n')}` };
}
