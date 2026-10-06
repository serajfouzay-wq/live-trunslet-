// The desktop app (Electron) working fully offline: node scripts/desktop-offline-e2e.mjs <dataDirWithModels> <micWav> [shots]
// (Linux needs a display: xvfb-run -a ...)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(process.env.PLAYWRIGHT_MODULES || '/opt/node22/lib/node_modules/');
const { _electron } = require('playwright');
const [dataDir, wav, shots = os.tmpdir()] = process.argv.slice(2);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-eo-'));
const app = await _electron.launch({
  executablePath: path.resolve('node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, `--user-data-dir=${home}`, '.'],
  env: { ...process.env, HOME: home, LT_DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', DEEPGRAM_API_KEY: '', DEEPGRAM_REST_URL: 'http://127.0.0.1:9' },
  timeout: 60000,
});
const out = { ok: false };
try {
  let page;
  for (let i = 0; i < 60 && !page; i += 1) { page = app.windows().find((w) => w.url().includes('/control')); if (!page) await new Promise((r) => setTimeout(r, 500)); }
  await page.waitForSelector('#go');
  await page.evaluate(() => localStorage.setItem('wizardSeen', '1'));
  await page.selectOption('#engine', 'auto');
  await page.click('#go');
  const done = () => [...document.querySelectorAll('#feed .fs:not(.live)')].find((f) => /conference/i.test(f.textContent) && f.querySelectorAll('.tr').length >= 1 && [...f.querySelectorAll('.tr')].every((t) => !t.classList.contains('pending')));
  await page.waitForFunction(done, null, { timeout: 90000 });
  out.result = await page.evaluate((fn) => eval(fn)()?.innerText.replace(/\s+/g, ' '), `(${done})`);
  out.pills = await page.$$eval('.pills .pill span', (p) => p.map((x) => x.textContent));
  await page.click('#nav button[data-tab="settings"]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, 'desktop-offline-settings.png') });
  out.ok = /conference/i.test(out.result || '') && out.pills.some((p) => /offline/.test(p));
} catch (e) { out.error = String(e).slice(0, 400); }
await app.close().catch(() => {});
fs.rmSync(home, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));
process.exit(out.ok ? 0 : 1);
