// Downloads the offline packs into a temporary folder and checks both engines really work on this machine.
// Used by the Windows build on GitHub: node scripts/smoke-offline.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'lt-smoke-'));
const { offline } = await import('../server/offline/manager.js');
const { createLocalStt } = await import('../server/offline/stt.js');
const { offlineTranslate } = await import('../server/translate.js');

const fail = (m) => { console.error(`SMOKE FAILED: ${m}`); process.exit(1); };
let phase = 'start';
const step = (p) => { phase = p; console.log(`[${new Date().toISOString().slice(11, 19)}] ${p}`); };
setTimeout(() => fail(`timed out during: ${phase}`), 12 * 60 * 1000).unref();
let lastPct = -1;
offline.onChange((st) => { const j = st.job; if (!j) return; const pct = Math.floor((j.received / j.total) * 10) * 10; if (pct !== lastPct) { lastPct = pct; console.log(`   ${j.pack}: ${j.phase} ${pct}%`); } });
for (const pack of ['translation', 'speech-fast']) {
  const t0 = Date.now();
  step(`download ${pack}`);
  await offline.download(pack);
  const st = offline.status();
  if (!st.packs[pack].installed) fail(`${pack} not installed: ${st.job?.error}`);
  console.log(`${pack} installed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

for (const [text, from, to] of [['Good evening everyone, and welcome to our conference.', 'en', 'ar'], ['Bienvenue à tous.', 'fr', 'zh'], ['Herkese iyi akşamlar.', 'tr', 'de']]) {
  const t0 = Date.now();
  step(`translate ${from}->${to}`);
  const out = await offlineTranslate({ text, from, to, glossary: 'conference = ar: المؤتمر' });
  if (!out || out === text) fail(`translation ${from}->${to} gave "${out}"`);
  console.log(`${from}->${to} ${Date.now() - t0} ms: ${out}`);
}

// Speech: feed the recorded welcome sentence (16 kHz mono) in 100 ms chunks, like a microphone.
step('speech recognition');
const wav = fs.readFileSync(new URL('../test/fixtures/en-welcome.wav', import.meta.url));
const pcm = wav.subarray(44);
const text = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no transcript within 60 s')), 60000);
  const stt = createLocalStt({
    lang: 'en', quality: 'fast',
    onStatus: (s) => { if (s.state === 'error') reject(new Error(s.detail)); },
    onResult: (r) => { if (r.final) { clearTimeout(timer); stt.close(); resolve(r.text); } },
  });
  for (let i = 0; i < pcm.length; i += 3200) stt.send(pcm.subarray(i, Math.min(pcm.length, i + 3200)));
}).catch((e) => fail(`speech: ${e.message}`));
if (!/conference/i.test(text)) fail(`speech heard "${text}"`);
console.log(`speech: ${text}`);
await offline.mt.close();
console.log('SMOKE OK');
process.exit(0);
