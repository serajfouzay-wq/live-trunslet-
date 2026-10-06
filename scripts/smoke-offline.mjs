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
for (const pack of ['translation', 'speech-fast']) {
  const t0 = Date.now();
  await offline.download(pack);
  const st = offline.status();
  if (!st.packs[pack].installed) fail(`${pack} not installed: ${st.job?.error}`);
  console.log(`${pack} installed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

for (const [text, from, to] of [['Good evening everyone, and welcome to our conference.', 'en', 'ar'], ['Bienvenue à tous.', 'fr', 'zh'], ['Herkese iyi akşamlar.', 'tr', 'de']]) {
  const t0 = Date.now();
  const out = await offlineTranslate({ text, from, to, glossary: 'conference = ar: المؤتمر' });
  if (!out || out === text) fail(`translation ${from}->${to} gave "${out}"`);
  console.log(`${from}->${to} ${Date.now() - t0} ms: ${out}`);
}

// Speech: feed the recorded welcome sentence (16 kHz mono) in 100 ms chunks, like a microphone.
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
