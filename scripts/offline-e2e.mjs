// Offline mode end to end (needs downloaded models): node scripts/offline-e2e.mjs <dataDirWithModels> <micWav> [shotsDir]
// No keys, no internet: speech from the fake microphone is recognised and translated on this machine.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(process.env.PLAYWRIGHT_MODULES || '/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const [dataDir, wav, shots = os.tmpdir()] = process.argv.slice(2);
const port = 5100 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', DEEPGRAM_API_KEY: '', DEEPGRAM_REST_URL: 'http://127.0.0.1:9', DEEPGRAM_URL: 'ws://127.0.0.1:9' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((r) => server.stdout.on('data', (d) => d.toString().includes('running') && r()));
const base = `http://localhost:${port}`;
const patch = (b) => fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const out = { ok: false };
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`] });
try {
  await patch({ screenLangs: ['en', 'ar', 'fr', 'zh'], sourceLang: 'en', layout: 'grid', title: 'Offline test', glossary: 'annual conference = ar: المؤتمر السنوي' });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  await page.goto(`${base}/control`);
  await page.evaluate(() => localStorage.setItem('wizardSeen', '1'));
  const st = await (await fetch(`${base}/api/offline`)).json();
  out.packsInstalled = Object.fromEntries(Object.entries(st.packs).map(([k, v]) => [k, v.installed]));
  out.translatorEngine = st.translator.engine;

  // typed line -> offline translation
  await page.fill('#type-input', 'Thank you all for coming.');
  await page.press('#type-input', 'Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#feed .fs .tr span')].some((s) => /شكر/.test(s.textContent)), null, { timeout: 15000 });
  out.phrasebookHit = await page.$$eval('#feed .fs:last-child .tr span', (s) => s.map((x) => x.textContent));

  // speaking -> offline speech recognition -> offline translation
  await page.selectOption('#engine', 'auto');
  await page.click('#go');
  await page.waitForFunction(() => [...document.querySelectorAll('#feed .fs .src')].some((s) => /conference/i.test(s.textContent)), null, { timeout: 60000 });
  const done = () => [...document.querySelectorAll('#feed .fs:not(.live)')].find((f) => /conference/i.test(f.textContent) && f.querySelectorAll('.tr').length >= 3 && [...f.querySelectorAll('.tr')].every((t) => !t.classList.contains('pending')));
  await page.waitForFunction(done, null, { timeout: 60000 });
  out.heard = await page.evaluate((fn) => eval(fn)()?.innerText.replace(/\s+/g, ' '), `(${done})`);
  await page.waitForTimeout(1200);
  out.pipeline = await page.$$eval('#pipe .node', (n) => n.map((x) => `${x.querySelector('b').textContent}:${x.dataset.s}:${x.querySelector('small').textContent}`));
  out.pills = await page.$$eval('.pills .pill span', (p) => p.map((x) => x.textContent));
  await page.screenshot({ path: path.join(shots, 'offline-control.png') });
  const disp = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await disp.goto(`${base}/display`);
  await disp.waitForTimeout(1500);
  await disp.screenshot({ path: path.join(shots, 'offline-display.png') });
  await page.click('#go');
  out.ok = out.translatorEngine === 'offline' && /شكر/.test(out.phrasebookHit.join(' ')) && /conference/i.test(out.heard || '') && out.pipeline.every((p) => p.includes(':ok:'));
} catch (e) { out.error = String(e).slice(0, 500); }
await browser.close(); server.kill();
console.log(JSON.stringify(out, null, 1));
process.exit(out.ok ? 0 : 1);
