// Starts the real desktop app (Electron) with a fake microphone and mock services, then checks that it
// hears, transcribes and translates. Linux needs a display: xvfb-run -a node scripts/desktop-e2e.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMocks } from './mocks.mjs';

const require = createRequire(process.env.PLAYWRIGHT_MODULES || '/opt/node22/lib/node_modules/');
const { _electron } = require('playwright');
const shotDir = process.argv[2] || os.tmpdir();

const mocks = await startMocks();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-electron-'));
const app = await _electron.launch({
  executablePath: path.resolve('node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--user-data-dir=' + home, '.'],
  env: { ...process.env, ...mocks.env, HOME: home, XDG_CONFIG_HOME: home },
  timeout: 60000,
});
const result = { ok: false };
try {
  // first window is the splash, the control window follows
  let page;
  for (let i = 0; i < 60 && !page; i += 1) {
    page = app.windows().find((w) => w.url().includes('/control'));
    if (!page) await new Promise((r) => setTimeout(r, 500));
  }
  if (!page) throw new Error('control window never opened');
  await page.waitForSelector('#go');
  result.title = await page.title();
  result.desktopBridge = await page.evaluate(() => !!window.desktop?.isDesktop);
  result.info = await page.evaluate(() => window.desktop.info());
  result.displays = await page.evaluate(() => window.desktop.displays());
  result.browserEngineHidden = (await page.locator('#opt-browser').count()) === 0;
  await page.setViewportSize?.({ width: 1500, height: 950 });

  await page.selectOption('#engine', 'deepgram');
  await page.click('#go');
  let ok = false;
  for (let i = 0; i < 60 && !ok; i += 1) { await page.waitForTimeout(250); ok = (await page.locator('#feed .fs .tr span', { hasText: '[' }).count()) > 0; }
  result.translated = ok;
  result.audioBytes = mocks.stats.audioBytes;
  await page.waitForTimeout(1500);
  result.pipeline = await page.$$eval('#pipe .node', (n) => n.map((x) => `${x.querySelector('b').textContent}:${x.dataset.s}:${x.querySelector('small').textContent}`));
  await page.screenshot({ path: path.join(shotDir, 'desktop-control.png') });

  // big screen opens as its own window
  await page.evaluate(() => window.desktop.openDisplay('window'));
  let disp;
  for (let i = 0; i < 40 && !disp; i += 1) { disp = app.windows().find((w) => w.url().includes('/display')); if (!disp) await new Promise((r) => setTimeout(r, 250)); }
  result.displayWindow = !!disp;
  if (disp) { await disp.waitForTimeout(1500); await disp.screenshot({ path: path.join(shotDir, 'desktop-display.png') }); }
  result.dataDirInUserData = fs.existsSync(path.join(result.info.dataDir, 'settings.json')) || fs.existsSync(result.info.dataDir);
  result.ok = ok && result.desktopBridge && result.audioBytes > 48000 && result.displayWindow;
} catch (e) {
  result.error = String(e);
} finally {
  await app.close().catch(() => {});
  mocks.close();
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 1));
process.exit(result.ok ? 0 : 1);
