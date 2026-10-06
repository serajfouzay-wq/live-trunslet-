// Fresh install (no keys): the setup guide opens, accepts keys, and announcements reach screen + phone.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMocks } from './mocks.mjs';

const require = createRequire(process.env.PLAYWRIGHT_MODULES || '/opt/node22/lib/node_modules/');
const { chromium, devices } = require('playwright');
const shots = process.argv[2] || os.tmpdir();
const mocks = await startMocks();
const { DEEPGRAM_API_KEY, ANTHROPIC_API_KEY, ...env } = mocks.env; // start WITHOUT keys
const port = 4900 + Math.floor(Math.random() * 90);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-wz-'));
const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, ...env, PORT: String(port), DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.on('data', (d) => d.toString().includes('running') && r()));
const base = `http://localhost:${port}`;
const out = { ok: false };
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.goto(`${base}/control`);
  await page.waitForSelector('#wizard:not([hidden])', { timeout: 5000 });
  out.wizardAutoOpened = true;
  await page.screenshot({ path: path.join(shots, 'wizard-0.png') });
  await page.click('#wz-next');
  await page.fill('#wz-dg', 'dg-test-key');
  await page.click('[data-wz-save="dg"]');
  await page.waitForFunction(() => document.querySelector('.wz-step[data-step="2"]:not([hidden])'), null, { timeout: 6000 });
  out.deepgramStepWorked = true;
  await page.screenshot({ path: path.join(shots, 'wizard-2.png') });
  await page.fill('#wz-an', 'an-test-key');
  await page.click('[data-wz-save="an"]');
  await page.waitForFunction(() => document.querySelector('.wz-step[data-step="3"]:not([hidden])'), null, { timeout: 8000 });
  out.claudeStepWorked = true;
  await page.click('#wz-mic');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shots, 'wizard-3.png') });
  await page.click('#wz-mic'); // stop test
  await page.click('#wz-next');
  await page.click('#wz-next'); // finish
  out.setupCardHidden = await page.locator('#setup').isHidden();

  // announcement
  const disp = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await disp.goto(`${base}/display`);
  const phone = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
  await phone.goto(`${base}/join`);
  await phone.locator('.tile', { hasText: 'Français' }).click();
  await phone.click('#picker-done');
  await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screenLangs: ['en', 'ar'], title: 'Global Summit 2026' }) });
  await page.fill('#ann-text', 'Coffee break, we continue at 15:30');
  await page.click('#ann-form button.primary');
  await disp.waitForSelector('.announce:not([hidden]) .a-line >> nth=1', { timeout: 6000 });
  await phone.waitForSelector('#notice:not([hidden])', { timeout: 6000 });
  await disp.waitForTimeout(600);
  out.displayLines = await disp.$$eval('.a-line p', (p) => p.map((x) => x.textContent));
  out.phoneLines = await phone.$$eval('#notice p', (p) => p.map((x) => x.textContent));
  await disp.screenshot({ path: path.join(shots, 'announce-display.png') });
  await phone.screenshot({ path: path.join(shots, 'announce-phone.png') });
  await page.click('#ann-hide');
  await disp.waitForSelector('.announce', { state: 'hidden', timeout: 4000 });
  out.hidden = true;
  out.ok = out.wizardAutoOpened && out.deepgramStepWorked && out.claudeStepWorked && out.setupCardHidden && out.displayLines.length === 2 && out.phoneLines.length >= 1 && out.hidden;
} catch (e) { out.error = String(e).slice(0, 400); }
await browser.close(); server.kill(); mocks.close(); fs.rmSync(dataDir, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));
process.exit(out.ok ? 0 : 1);
