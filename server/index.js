import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { ROOT, DIRS, config, saveConfig, publicConfig } from './config.js';
import { Hub } from './hub.js';
import { loadSettings, viewerSettings } from './settings.js';
import { isLang } from './languages.js';
import { lanAddresses, isLoopback } from './net.js';
import { testAnthropic, explain } from './translate.js';
import { testDeepgram } from './health.js';
import { log, recentLog, LOG_DIR } from './log.js';
import { registerLibrary } from './library.js';

process.on('uncaughtException', (e) => log('error', `uncaught: ${e.stack || e}`));
process.on('unhandledRejection', (e) => log('error', `unhandled: ${e?.stack || e}`));

const app = express();
const server = http.createServer(app);
const hub = new Hub(loadSettings());
export const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function joinUrl() {
  const host = config.publicHost || lanAddresses()[0]?.address || 'localhost';
  return `http://${host}:${config.port}/join`;
}
hub.setJoinUrl(joinUrl());

/* Everything that can change the event is reachable from this laptop only. */
const localOnly = (req, res, next) => (isLoopback(req.socket.remoteAddress) ? next() : res.status(403).send('This page is only available on the computer running the app.'));

app.disable('x-powered-by');
app.use('/uploads', express.static(DIRS.uploads, { maxAge: '30d', immutable: true }));
app.use('/assets', express.static(path.join(ROOT, 'public'), { maxAge: 0 }));

const page = (file) => (req, res) => res.sendFile(path.join(ROOT, file));
app.get('/', (req, res) => res.redirect(isLoopback(req.socket.remoteAddress) ? '/control' : '/join'));
app.get('/control', localOnly, page('views/control.html'));
app.get('/display', page('public/display.html'));
app.get('/join', page('public/join.html'));

app.get('/favicon.ico', (req, res) => res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#3f6eff"/><path d="M16 6a10 10 0 1 0 0 20z" fill="#fff"/></svg>'));

app.get('/qr.svg', async (req, res) => {
  const text = String(req.query.text || hub.joinUrl).slice(0, 300);
  if (!/^https?:\/\//.test(text)) return res.status(400).end();
  res.type('image/svg+xml').send(await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }));
});

/* ------------------------------------------------------------------ API */
const api = express.Router();
api.use(localOnly);
api.use(express.json({ limit: '1mb' }));

const netInfo = () => ({ addresses: lanAddresses(), joinUrl: hub.joinUrl, port: config.port });

api.get('/state', (req, res) => res.json({ settings: hub.settings, config: publicConfig(), net: netInfo() }));

api.patch('/settings', (req, res) => res.json(hub.updateSettings(req.body || {})));

api.put('/config', (req, res) => {
  saveConfig(req.body || {});
  hub.setJoinUrl(joinUrl());
  hub.broadcast(hub.statusMsg(), ['control']);
  res.json({ config: publicConfig(), net: netInfo() });
});

api.post('/config/test/anthropic', async (req, res) => {
  try { res.json({ ok: true, sample: await testAnthropic() }); } catch (e) { res.json({ ok: false, error: explain(e) }); }
});
api.post('/config/test/deepgram', async (req, res) => res.json(await testDeepgram()));

/** Everything useful for finding out why something does not work (no keys, no transcript text). */
api.get('/diagnostics', (req, res) => {
  res.json({ app: APP_VERSION, node: process.version, platform: `${process.platform} ${process.arch}`, port: config.port, logDir: LOG_DIR, ...hub.diagnostics(), log: recentLog(120) });
});

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const KINDS = { logo: 'logo', bgLandscape: 'bgLandscape', bgPortrait: 'bgPortrait' };
api.post('/upload/:kind', express.raw({ type: Object.keys(EXT), limit: '25mb' }), (req, res) => {
  const kind = KINDS[req.params.kind];
  const ext = EXT[(req.headers['content-type'] || '').split(';')[0]];
  if (!kind || !ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Send a PNG, JPG, WebP or GIF image.' });
  const name = `${kind}-${Date.now().toString(36)}.${ext}`;
  fs.writeFileSync(path.join(DIRS.uploads, name), req.body);
  hub.updateSettings({ [kind]: `/uploads/${name}` });
  res.json({ url: `/uploads/${name}` });
});

registerLibrary(api, hub);
app.use('/api', api);

/* ------------------------------------------------------------ WebSockets */
/** "ar,en" -> ['ar','en'] (valid, unique, at most 4: each extra language costs a translation). */
const MAX_PHONE_LANGS = 4;
const parseLangs = (v) => [...new Set(String(v || '').split(',').filter(isLang))].slice(0, MAX_PHONE_LANGS);

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') return socket.destroy();
  const role = url.searchParams.get('role');
  if (role === 'control' && !isLoopback(req.socket.remoteAddress)) return socket.destroy();
  if (!['control', 'display', 'phone'].includes(role)) return socket.destroy();
  if (hub.clients.size > 3000) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, role, parseLangs(url.searchParams.get('langs') || url.searchParams.get('lang')), url.searchParams.has('preview')));
});

wss.on('connection', (ws, role, langs, preview) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const client = hub.addClient(ws, role, langs, preview);

  ws.on('message', (data, isBinary) => {
    if (role === 'control') return controlMessage(client, data, isBinary);
    if (role === 'phone') return phoneMessage(client, data);
  });
  ws.on('close', () => {
    hub.removeClient(client);
    // The microphone lives in the control page that pressed Start: if that page goes away, stop listening.
    if (hub.owner === client) hub.stop();
  });
  ws.on('error', () => {});
});

function phoneMessage(client, data) {
  let m;
  try { m = JSON.parse(data.toString()); } catch { return; }
  if (m.type !== 'lang') return;
  const langs = parseLangs(Array.isArray(m.langs) ? m.langs.join(',') : m.lang).filter((l) => hub.settings.phoneLangs.includes(l));
  if (!langs.length) return;
  client.langs = langs;
  hub.sendHello(client);
  hub.backfill();
  hub.scheduleStats();
}

function controlMessage(client, data, isBinary) {
  if (isBinary) return hub.audio(data);
  let m;
  try { m = JSON.parse(data.toString()); } catch { return; }
  switch (m.type) {
    case 'start': hub.start({ engine: m.engine, owner: client }); break;
    case 'stop': hub.stop(); break;
    case 'stt': hub.ingestStt({ text: String(m.text || ''), final: !!m.final, speechFinal: !!m.speechFinal, lang: m.lang }); break;
    case 'source': {
      hub.updateSettings({ sourceLang: m.lang, speakerMode: m.speakerMode ?? hub.settings.speakerMode });
      hub.reconfigure();
      break;
    }
    case 'clearScreen': hub.clearScreen(); break;
    case 'newSession': hub.newSession(m.name); break;
    case 'edit': hub.editSegment(m.id, m.text); break;
    case 'retry': hub.retrySegment(m.id); break;
    case 'announce': hub.announce(m.text, Number(m.seconds) || 30); break;
    case 'announceClear': hub.clearAnnouncement(); break;
    default: break;
  }
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

function shutdown() { hub.stop(); hub.persistNow(); process.exit(0); }
export { shutdown, hub };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/** Listen on the configured port, or the next free one if another program is using it. */
function listen(port, triesLeft = 20) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      if (e.code === 'EADDRINUSE' && triesLeft > 0) { server.off('error', onError); listen(port + 1, triesLeft - 1).then(resolve, reject); } else reject(e);
    };
    server.once('error', onError);
    server.listen(port, '0.0.0.0', () => { server.off('error', onError); resolve(port); });
  });
}

export const ready = listen(config.port).then((port) => {
  config.port = port;
  hub.setJoinUrl(joinUrl());
  const local = `http://localhost:${port}`;
  log('info', `Live Translate ${APP_VERSION} running on port ${port}`);
  console.log('\n  Live Translate is running\n');
  console.log(`  Control panel  ${local}/control   (this computer only)`);
  console.log(`  Big screen     ${local}/display`);
  console.log(`  Phones join    ${hub.joinUrl}\n`);
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', `${local}/control`]] : process.platform === 'darwin' ? ['open', [`${local}/control`]] : ['xdg-open', [`${local}/control`]];
    try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); } catch { /* ignore */ }
  }
  return { port, hub };
});
ready.catch((e) => { console.error('Could not start the server:', e.message); process.exit(1); });
