// Drives the real control page in Chromium with a fake microphone and checks that audio reaches the
// speech service and the transcript/translation comes back. Run: node scripts/mic-e2e.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const require = createRequire(process.env.PLAYWRIGHT_MODULES || '/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');

let audioBytes = 0;
const dg = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => dg.on('listening', r));
dg.on('connection', (ws) => {
  let sent = 0;
  ws.on('message', (d, bin) => {
    if (!bin) return;
    audioBytes += d.length;
    if (audioBytes > 16000 && sent === 0) { sent = 1; ws.send(JSON.stringify({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'hello there', words: [] }] } })); }
    if (audioBytes > 48000 && sent === 1) { sent = 2; ws.send(JSON.stringify({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'hello there everyone.', words: [] }] } })); }
  });
});
const an = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const u = JSON.parse(b).messages[0].content; const l = /into (\w+):/.exec(u)?.[1]; const t = /<text>([\s\S]*?)<\/text>/.exec(u)?.[1];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (n, d) => res.write(`event: ${n}\ndata: ${JSON.stringify(d)}\n\n`);
    ev('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `[${l}] ${t}` } });
    ev('content_block_stop', { type: 'content_block_stop', index: 0 });
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    ev('message_stop', { type: 'message_stop' }); res.end();
  });
});
await new Promise((r) => an.listen(0, '127.0.0.1', r));

const port = 4100 + Math.floor(Math.random() * 800);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-mic-'));
const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, DEEPGRAM_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: `http://127.0.0.1:${an.address().port}`, DEEPGRAM_URL: `ws://127.0.0.1:${dg.address().port}` }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.on('data', (d) => d.toString().includes('running') && r()));

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${port}/control`);
await page.selectOption('#engine', 'deepgram');
await page.click('#go');
let ok = false;
for (let i = 0; i < 40 && !ok; i += 1) { await page.waitForTimeout(250); ok = (await page.locator('#feed .fs .tr span', { hasText: '[' }).count()) > 0; }
const label = await page.textContent('#go-text');
console.log(JSON.stringify({ audioBytes, stillListening: label, translated: ok, errors }));
await browser.close(); server.kill(); dg.close(); an.close(); fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(ok && audioBytes > 48000 ? 0 : 1);
