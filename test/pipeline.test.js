// End-to-end test of the real server against mock Deepgram and Anthropic services.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const anthropicCalls = [];
const dgConnections = [];
let mockAnthropic, mockDeepgram, server, base, dataDir;

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sse(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } });
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const part of text.match(/.{1,6}/gs)) ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } });
  ev('content_block_stop', { type: 'content_block_stop', index: 0 });
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  ev('message_stop', { type: 'message_stop' });
  res.end();
}

before(async () => {
  mockAnthropic = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/projects')) {
      res.writeHead(req.headers.authorization === 'Token dg-key' ? 200 : 401, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      anthropicCalls.push(json);
      const user = json.messages[0].content;
      const lang = /into (\w+):/.exec(user)?.[1] || '?';
      const text = /<text>([\s\S]*?)<\/text>/.exec(user)?.[1] || '';
      sse(res, `[${lang}] ${text}`);
    });
  });
  const aPort = await listen(mockAnthropic);

  mockDeepgram = new WebSocketServer({
    host: '127.0.0.1', port: 0,
    verifyClient: (info, cb) => {
      const q = new URL(info.req.url, 'http://x').searchParams;
      dgConnections.push({ model: q.get('model'), language: q.get('language'), auth: info.req.headers.authorization, diarize: q.get('diarize') });
      // Pretend nova-3 does not know Chinese so the fallback to nova-2 is exercised.
      if (q.get('model') === 'nova-3' && q.get('language') === 'zh') return cb(false, 400, 'unsupported');
      cb(true);
    },
  });
  await new Promise((r) => mockDeepgram.on('listening', r));
  mockDeepgram.on('connection', (ws) => {
    let n = 0;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      n += 1;
      if (n === 1) ws.send(JSON.stringify({ type: 'Results', is_final: false, speech_final: false, channel: { alternatives: [{ transcript: '你好', words: [] }] } }));
      if (n === 2) ws.send(JSON.stringify({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: '你好，欢迎大家。', words: [{ speaker: 1 }] }] } }));
    });
  });
  const dgPort = mockDeepgram.address().port;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-test-'));
  const port = 3900 + Math.floor(Math.random() * 90);
  base = `127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${aPort}`, DEEPGRAM_API_KEY: 'dg-key', DEEPGRAM_URL: `ws://127.0.0.1:${dgPort}`, DEEPGRAM_REST_URL: `http://127.0.0.1:${aPort}` },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => d.toString().includes('running') && resolve());
    server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});

after(() => {
  server?.kill();
  mockAnthropic?.close();
  mockDeepgram?.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function client(role, lang) {
  const ws = new WebSocket(`ws://${base}/ws?role=${role}${lang ? `&lang=${lang}` : ''}`);
  const msgs = [];
  ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(d.toString())));
  const ready = new Promise((r) => ws.on('open', r));
  const until = async (fn, ms = 4000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { const hit = msgs.find(fn); if (hit) return hit; await sleep(30); }
    throw new Error(`timeout; got ${msgs.map((m) => m.type).join(',')}`);
  };
  return { ws, msgs, ready, until, send: (o) => ws.send(typeof o === 'string' || Buffer.isBuffer(o) ? o : JSON.stringify(o)) };
}
const api = (method, url, body) => fetch(`http://${base}/api${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('settings are validated', async () => {
  const r = await api('PATCH', '/settings', { title: 'Summit', theme: 'nope', dim: 999, screenLangs: ['ar', 'xx', 'fr'], logo: 'http://evil/x.png', maxLines: 3 });
  const s = await r.json();
  assert.equal(s.title, 'Summit');
  assert.equal(s.theme, 'midnight'); // invalid value dropped
  assert.equal(s.dim, 90); // clamped
  assert.deepEqual(s.screenLangs, ['ar', 'fr']);
  assert.equal(s.logo, ''); // only /uploads/ paths accepted
});

test('typed line is translated with glossary, context and history; phones only get their language', async () => {
  await api('PATCH', '/settings', { screenLangs: ['en', 'ar'], sourceLang: 'en', glossary: 'Seraj\nnet zero = صافي الصفر', context: 'Energy conference' });
  const ctl = client('control');
  const phoneFr = client('phone', 'fr');
  await Promise.all([ctl.ready, phoneFr.ready]);

  ctl.send({ type: 'stt', text: 'Welcome to the summit.', final: true, speechFinal: true, lang: 'en' });
  const ar = await ctl.until((m) => m.type === 'tr' && m.lang === 'ar' && m.done);
  assert.equal(ar.text, '[Arabic] Welcome to the summit.');
  await phoneFr.until((m) => m.type === 'tr' && m.lang === 'fr' && m.done);
  assert.ok(!phoneFr.msgs.some((m) => m.type === 'tr' && m.lang === 'ar'), 'phone must not receive Arabic');

  ctl.send({ type: 'stt', text: 'Seraj will talk about net zero.', final: true, speechFinal: true, lang: 'en' });
  await ctl.until((m) => m.type === 'tr' && m.lang === 'ar' && m.done && m.text.includes('Seraj'));

  const call = anthropicCalls.find((c) => c.messages[0].content.includes('Seraj will talk'));
  assert.equal(call.model, 'claude-haiku-4-5');
  assert.equal(call.stream, true);
  const prompt = call.messages[0].content;
  assert.match(prompt, /Energy conference/);
  assert.match(prompt, /net zero = صافي الصفر/);
  assert.match(prompt, /Welcome to the summit\./, 'previous sentence is passed as context');
  assert.match(call.system, /simultaneous interpreter/);
  ctl.ws.close(); phoneFr.ws.close();
});

test('phone can switch language and gets the backlog', async () => {
  const phone = client('phone');
  await phone.ready;
  phone.send({ type: 'lang', lang: 'it' });
  const hello = await phone.until((m) => m.type === 'hello' && Object.values(m.segments[0]?.tr || {}).length >= 0 && m.segments.length > 0);
  assert.ok(hello.segments.length >= 2);
  await phone.until((m) => m.type === 'tr' && m.lang === 'it' && m.done);
  phone.ws.close();
});

test('Deepgram: falls back to nova-2, streams audio, builds a Chinese segment', async () => {
  const ctl = client('control');
  await ctl.ready;
  ctl.send({ type: 'source', lang: 'zh', speakerMode: 'multi' });
  ctl.send({ type: 'start', engine: 'deepgram' });
  await ctl.until((m) => m.type === 'status' && m.stt?.state === 'connected');
  const models = dgConnections.filter((c) => c.language === 'zh').map((c) => c.model);
  assert.deepEqual(models, ['nova-3', 'nova-2']);
  assert.equal(dgConnections.at(-1).auth, 'Token dg-key');
  assert.equal(dgConnections.at(-1).diarize, 'true');

  ctl.send(Buffer.alloc(3200));
  await ctl.until((m) => m.type === 'partial' && m.partial?.text === '你好');
  ctl.send(Buffer.alloc(3200));
  const seg = await ctl.until((m) => m.type === 'segment' && m.seg.src === 'zh');
  assert.equal(seg.seg.text, '你好，欢迎大家。');
  assert.equal(seg.seg.speaker, 'Speaker 2');
  await ctl.until((m) => m.type === 'tr' && m.lang === 'en' && m.done && m.id === seg.seg.id);
  ctl.send({ type: 'stop' });
  ctl.ws.close();
});

test('phones can read several languages at once, including German', async () => {
  const phone = client('phone');
  await phone.ready;
  phone.send({ type: 'lang', langs: ['de', 'fr', 'de', 'xx', 'ar', 'it', 'es'] }); // duplicates/invalid dropped, max 4
  const hello = await phone.until((m) => m.type === 'hello' && m.segments.length > 0);
  assert.ok(hello.langs.de, 'German is available');
  const ctl = client('control');
  await ctl.ready;
  ctl.send({ type: 'source', lang: 'de', speakerMode: 'single' });
  ctl.send({ type: 'stt', text: 'Guten Abend zusammen.', final: true, speechFinal: true, lang: 'de' });
  const seg = await phone.until((m) => m.type === 'segment' && m.seg.text.startsWith('Guten Abend'));
  assert.equal(seg.seg.src, 'de');
  for (const l of ['fr', 'ar', 'it']) await phone.until((m) => m.type === 'tr' && m.lang === l && m.done && m.id === seg.seg.id);
  assert.ok(!phone.msgs.some((m) => m.type === 'tr' && (m.lang === 'es' || m.lang === 'en')), 'only chosen languages are sent');
  phone.ws.close(); ctl.ws.close();
});

test('export: srt, txt, html and json', async () => {
  const { current } = await (await api('GET', '/sessions')).json();
  const get = async (fmt, extra = '') => (await fetch(`http://${base}/api/sessions/${current}/export?format=${fmt}&langs=en,ar${extra}`)).text();
  const srt = await get('srt');
  assert.match(srt, /1\n00:00:0\d,\d{3} --> /);
  assert.match(srt, /Welcome to the summit\./);
  assert.match(await get('txt'), /EN: Welcome to the summit\./);
  assert.match(await get('html'), /<table>[\s\S]*dir="rtl"/);
  const json = JSON.parse(await get('json'));
  assert.ok(json.segments.length >= 3);
  const filled = await get('txt', '&fill=1');
  assert.ok(!/AR: —/.test(filled), 'missing translations are filled on request');
});

test('export never includes a half-written translation', async () => {
  const { buildExport } = await import('../server/export.js');
  const seg = { id: 'a', t: 0, te: 2000, src: 'en', text: 'Hello everyone', tr: { ar: 'مرح' }, trDone: { ar: false } };
  const out = await buildExport({ session: { name: 'x', startedAt: 0 }, segments: [seg], settings: {} }, { format: 'txt', langs: ['en', 'ar'], fill: false });
  assert.match(out.body, /AR: —/);
  assert.ok(!out.body.includes('مرح'));
});

test('saved events round-trip', async () => {
  await api('PATCH', '/settings', { title: 'Saved Event', theme: 'gold' });
  const { id } = await (await api('POST', '/events', { name: 'Day 1' })).json();
  await api('PATCH', '/settings', { title: 'Something else', theme: 'light' });
  await api('POST', `/events/${id}/load`);
  const st = await (await api('GET', '/state')).json();
  assert.equal(st.settings.title, 'Saved Event');
  assert.equal(st.settings.theme, 'gold');
  const list = await (await api('GET', '/events')).json();
  assert.equal(list[0].name, 'Day 1');
  await api('DELETE', `/events/${id}`);
  assert.equal((await (await api('GET', '/events')).json()).length, 0);
});

test('keys can be tested and diagnostics are available', async () => {
  const dgTest = await (await api('POST', '/config/test/deepgram')).json();
  assert.equal(dgTest.ok, true);
  const anTest = await (await api('POST', '/config/test/anthropic')).json();
  assert.equal(anTest.ok, true);
  const d = await (await api('GET', '/diagnostics')).json();
  assert.equal(d.keys.deepgram, true);
  assert.ok(d.app && d.node && Array.isArray(d.log));
  assert.ok(!JSON.stringify(d).includes('dg-key'), 'diagnostics never contain keys');
});

test('fast mode shows a draft translation while the speaker is still talking', async () => {
  await api('PATCH', '/settings', { fastMode: true, screenLangs: ['en', 'fr'], sourceLang: 'en' });
  const ctl = client('control');
  await ctl.ready;
  ctl.send({ type: 'start', engine: 'browser' });
  await ctl.until((m) => m.type === 'status' && m.running);
  ctl.send({ type: 'stt', text: 'we are going to talk about the future of', final: false, lang: 'en' });
  const draft = await ctl.until((m) => m.type === 'draft' && m.lang === 'fr' && m.text.includes('the future'));
  assert.match(draft.text, /^\[French\]/);
  ctl.send({ type: 'stt', text: 'we are going to talk about the future of energy.', final: true, speechFinal: true, lang: 'en' });
  const seg = await ctl.until((m) => m.type === 'segment' && m.seg.text.endsWith('energy.'));
  assert.ok(seg.seg.tr.fr, 'the segment starts with the draft so the screen never goes blank');
  await ctl.until((m) => m.type === 'tr' && m.id === seg.seg.id && m.lang === 'fr' && m.done);
  const pipe = await ctl.until((m) => m.type === 'pipe');
  assert.equal(pipe.engine, 'browser');
  ctl.send({ type: 'stop' });
  await api('PATCH', '/settings', { fastMode: false });
  ctl.ws.close();
});

test('without a Claude key only the demo talk is translated, and the error is clear', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-nokey-'));
  delete process.env.ANTHROPIC_API_KEY;
  const { translate, explain, MissingKeyError } = await import('../server/translate.js');
  await assert.rejects(() => translate({ text: 'Something new', from: 'en', to: 'ar' }), MissingKeyError);
  assert.match(explain(new MissingKeyError()), /Anthropic key/);
  const hit = await translate({ text: 'Good evening everyone, and welcome to our annual conference.', from: 'en', to: 'fr' });
  assert.match(hit, /Bonsoir/);
  assert.match(explain({ status: 401 }), /rejected/);
  assert.match(explain({ status: 429 }), /rate/);
});

test('announcements are translated and reach screens and phones in their languages', async () => {
  await api('PATCH', '/settings', { screenLangs: ['en', 'ar'], sourceLang: 'en' });
  const display = client('display');
  const phone = client('phone', 'de');
  const ctl = client('control');
  await Promise.all([display.ready, phone.ready, ctl.ready]);
  ctl.send({ type: 'announce', text: 'Coffee break, back at 15:30', seconds: 30 });
  const d = await display.until((m) => m.type === 'announce' && m.announce?.texts.ar);
  assert.equal(d.announce.texts.ar, '[Arabic] Coffee break, back at 15:30');
  assert.ok(!d.announce.texts.de, 'the screen only gets its own languages');
  const p = await phone.until((m) => m.type === 'announce' && m.announce?.texts.de);
  assert.equal(p.announce.texts.de, '[German] Coffee break, back at 15:30');
  ctl.send({ type: 'announceClear' });
  await display.until((m) => m.type === 'announce' && m.announce === null);
  for (const c of [display, phone, ctl]) c.ws.close();
});

test('the offline mode learns from Claude and from taught text', async () => {
  await api('PATCH', '/settings', { screenLangs: ['en', 'ar'], sourceLang: 'en', glossary: '' });
  await api('PUT', '/config', { translationMode: 'auto' });
  const ctl = client('control');
  await ctl.ready;
  const before = (await (await api('GET', '/offline')).json()).memory.learned;
  ctl.send({ type: 'stt', text: 'The solar panels arrive next week.', final: true, speechFinal: true, lang: 'en' });
  await ctl.until((m) => m.type === 'tr' && m.lang === 'ar' && m.done && m.text.includes('solar panels'));
  await sleep(200);
  const after = (await (await api('GET', '/offline')).json()).memory.learned;
  assert.ok(after > before, 'Claude translations are remembered');

  // teach a prepared text: Claude translates it once into every language
  const r = await (await api('POST', '/offline/teach', { text: 'Our CEO will speak at noon. Then we have lunch together.' })).json();
  assert.equal(r.sentences, 2);
  let st;
  for (let i = 0; i < 50; i += 1) { st = await (await api('GET', '/offline')).json(); if (st.teach?.done) break; await sleep(100); }
  assert.ok(st.teach.done && !st.teach.error, JSON.stringify(st.teach));
  assert.ok(st.memory.learned >= after + 2 * 6, 'every sentence in every other language');

  // offline mode (no models installed in this test): remembered sentences still translate
  await api('PUT', '/config', { translationMode: 'offline' });
  ctl.send({ type: 'stt', text: 'Our CEO will speak at noon.', final: true, speechFinal: true, lang: 'en' });
  const tr = await ctl.until((m) => m.type === 'tr' && m.lang === 'ar' && m.done && m.text.includes('noon'));
  assert.equal(tr.text, '[Arabic] Our CEO will speak at noon.');
  await api('PUT', '/config', { translationMode: 'auto' });
  ctl.ws.close();
});
