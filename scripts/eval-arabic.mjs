// Measures offline Arabic -> English quality on Libyan-dialect sentences (needs the offline translation pack).
// node scripts/eval-arabic.mjs <dataDirWithModels>
import fs from 'node:fs';
process.env.DATA_DIR = process.argv[2] || process.env.DATA_DIR;
const { offline } = await import('../server/offline/manager.js');
let normalize = null;
try { ({ normalizeLibyan: normalize } = await import('../server/offline/arabic.js')); } catch { /* not built yet */ }
const file = process.argv.find((a) => a.endsWith('.json')) || '../test/fixtures/libyan-eval.json';
const set = JSON.parse(fs.readFileSync(file.startsWith('..') ? new URL(file, import.meta.url) : file));

export function chrf(hyp, ref) {
  const clean = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  hyp = clean(hyp); ref = clean(ref);
  let p = 0, r = 0, n = 0;
  for (let k = 1; k <= 6; k += 1) {
    const g = (s) => { const m = new Map(); const t = s.replace(/ /g, ''); for (let i = 0; i + k <= t.length; i++) { const x = t.slice(i, i + k); m.set(x, (m.get(x) || 0) + 1); } return m; };
    const H = g(hyp), R = g(ref); let match = 0, hc = 0, rc = 0;
    for (const v of H.values()) hc += v; for (const v of R.values()) rc += v;
    for (const [x, v] of H) match += Math.min(v, R.get(x) || 0);
    if (hc && rc) { p += match / hc; r += match / rc; n += 1; }
  }
  p /= n; r /= n; return p + r ? (100 * 5 * p * r) / (4 * p + r) : 0;
}
const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length);
const rows = { dialect: [], normalized: [], msa: [], msaNorm: [] };
const show = process.argv.includes('--show');
for (const s of set) {
  const raw = await offline.mt.translate(s.ly, 'ar', 'en');
  rows.dialect.push(chrf(raw, s.en));
  let norm = null;
  if (normalize) { norm = await offline.mt.translate(normalize(s.ly), 'ar', 'en'); rows.normalized.push(chrf(norm, s.en)); }
  const msa = await offline.mt.translate(s.msa, 'ar', 'en');
  rows.msa.push(chrf(msa, s.en));
  if (normalize) rows.msaNorm.push(chrf(await offline.mt.translate(normalize(s.msa), 'ar', 'en'), s.en));
  if (show) console.log(`\n${s.ly}\n  ref : ${s.en}\n  raw : ${raw}${norm ? `\n  norm: ${normalize(s.ly)}  =>  ${norm}` : ''}`);
}
console.log(`\nLibyan dialect, offline Arabic->English chrF (0-100), ${set.length} sentences`);
console.log(`  dialect as spoken            : ${avg(rows.dialect).toFixed(1)}`);
if (rows.normalized.length) console.log(`  after Libyan normalizer      : ${avg(rows.normalized).toFixed(1)}`);
console.log(`  same sentences in formal MSA : ${avg(rows.msa).toFixed(1)}  (ceiling for this engine)`);
if (rows.msaNorm.length) console.log(`  formal MSA through normalizer: ${avg(rows.msaNorm).toFixed(1)}  (must not drop: the normalizer must not harm formal Arabic)`);
await offline.mt.close();
process.exit(0);
