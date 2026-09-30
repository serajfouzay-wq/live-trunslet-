import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { DIRS, config } from './config.js';
import { LANGUAGES } from './languages.js';
import { DEFAULT_SETTINGS, sanitize, saveSettings, viewerSettings } from './settings.js';
import { detectLang } from './detect.js';
import { translate } from './translate.js';
import { createDeepgram } from './stt/deepgram.js';
import { runDemo } from './demo.js';

const CJK_END = /[㐀-鿿]$/;
const CJK_START = /^[㐀-鿿]/;
const join = (a, b) => (!a ? b : CJK_END.test(a) && CJK_START.test(b) ? a + b : `${a} ${b}`);
const SENTENCE_END = /[.!?…。！？؟]["'”’)\]]*$/;
const SOFT_END = /[,;:،؛，、：]$/;

export class Hub {
  constructor(settings) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.clients = new Set();
    this.segments = [];
    this.screenFrom = 0; // "clear screen" hides older segments from viewers without deleting the transcript
    this.buf = { text: '', lang: null, speaker: null, t0: 0 };
    this.interim = '';
    this.flushTimer = null;
    this.partialTimer = null;
    this.trTimers = new Map();
    this.inflight = new Set();
    this.engine = null;
    this.running = false;
    this.stt = { state: 'idle', detail: '' };
    this.dg = null;
    this.demoAbort = null;
    this.joinUrl = '';
    this.newSession();
  }

  /* ---------------------------------------------------------------- sessions */

  newSession(name) {
    if (this.session) this.persistNow();
    const now = new Date();
    this.session = {
      id: now.toISOString().replace(/[:.]/g, '-').slice(0, 19),
      name: name || this.settings.title || 'Session',
      startedAt: now.getTime(),
    };
    this.segments = [];
    this.screenFrom = 0;
    this.buf = { text: '', lang: null, speaker: null, t0: 0 };
    this.interim = '';
    this.broadcast({ type: 'clear' });
    this.broadcast({ type: 'session', session: this.session }, ['control']);
  }

  persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistNow(), 1500);
  }

  persistNow() {
    clearTimeout(this.persistTimer);
    if (!this.segments.length) return;
    try {
      fs.writeFileSync(
        path.join(DIRS.sessions, `${this.session.id}.json`),
        JSON.stringify({ ...this.session, settings: viewerSettings(this.settings), segments: this.segments }),
      );
    } catch (e) { console.error('Could not save session:', e.message); }
  }

  /* ----------------------------------------------------------------- clients */

  addClient(ws, role, lang) {
    const client = { ws, role, lang: lang || null };
    this.clients.add(client);
    this.sendHello(client);
    this.scheduleStats();
    return client;
  }

  removeClient(client) {
    this.clients.delete(client);
    this.scheduleStats();
  }

  sendHello(client) {
    const control = client.role === 'control';
    const list = this.segments.slice(control ? -300 : this.screenFrom).slice(-60);
    this.send(client, {
      type: 'hello',
      role: client.role,
      settings: control ? this.settings : viewerSettings(this.settings),
      segments: list.map((s) => this.segmentView(s, client)),
      partial: this.currentPartial(),
      langs: LANGUAGES,
      joinUrl: this.joinUrl,
      session: this.session,
      status: control ? this.statusMsg() : undefined,
    });
  }

  send(client, msg) {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg));
  }

  broadcast(msg, roles) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (roles && !roles.includes(c.role)) continue;
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }

  wants(client, lang) {
    if (client.role === 'control') return true;
    if (client.role === 'display') return this.settings.screenLangs.includes(lang);
    if (client.role === 'phone') return client.lang === lang;
    return false;
  }

  segmentView(seg, client) {
    const tr = {}, trDone = {};
    for (const l of Object.keys(seg.tr)) {
      if (this.wants(client, l)) { tr[l] = seg.tr[l]; trDone[l] = !!seg.trDone[l]; }
    }
    return { id: seg.id, t: seg.t, speaker: seg.speaker, src: seg.src, text: seg.text, tr, trDone };
  }

  scheduleStats() {
    clearTimeout(this.statsTimer);
    this.statsTimer = setTimeout(() => this.broadcast(this.statsMsg(), ['control']), 300);
  }

  statsMsg() {
    const stats = { display: 0, phone: 0, langs: {} };
    for (const c of this.clients) {
      if (c.role === 'display') stats.display += 1;
      if (c.role === 'phone') {
        stats.phone += 1;
        if (c.lang) stats.langs[c.lang] = (stats.langs[c.lang] || 0) + 1;
      }
    }
    return { type: 'viewers', ...stats };
  }

  statusMsg() {
    return {
      type: 'status',
      running: this.running,
      engine: this.engine,
      stt: this.stt,
      translator: config.anthropicKey ? 'claude' : 'demo',
    };
  }

  setStt(state, detail = '') {
    this.stt = { state, detail };
    this.broadcast(this.statusMsg(), ['control']);
  }

  notify(level, message) {
    this.broadcast({ type: 'notice', level, message }, ['control']);
  }

  setJoinUrl(url) {
    this.joinUrl = url;
    this.broadcast({ type: 'info', joinUrl: url });
  }

  /* ---------------------------------------------------------------- settings */

  updateSettings(patch) {
    const clean = sanitize(patch);
    const before = this.settings.screenLangs.join();
    Object.assign(this.settings, clean);
    saveSettings(this.settings);
    for (const c of this.clients) {
      this.send(c, { type: 'settings', settings: c.role === 'control' ? this.settings : viewerSettings(this.settings) });
    }
    if (this.settings.screenLangs.join() !== before) this.backfill();
    return this.settings;
  }

  replaceSettings(next) {
    this.updateSettings({ ...DEFAULT_SETTINGS, ...next });
  }

  clearScreen() {
    this.screenFrom = this.segments.length;
    this.broadcast({ type: 'clear' }, ['display', 'phone']);
  }

  /* ------------------------------------------------------------ speech input */

  resolveLang(ev, text) {
    if (this.engine === 'demo' && ev.lang) return ev.lang;
    const s = this.settings.sourceLang;
    if (s !== 'auto') return s;
    if (ev.lang && LANGUAGES[ev.lang]) return ev.lang;
    return detectLang(text, this.buf.lang || 'en');
  }

  ingestStt(ev) {
    if (ev.utteranceEnd) { this.commit(); return; }
    const text = (ev.text || '').trim();
    const multi = this.settings.speakerMode === 'multi';
    const speaker = multi ? ev.speaker ?? null : null;

    if (speaker && this.buf.speaker && speaker !== this.buf.speaker && this.buf.text) this.commit();

    if (text) {
      const lang = this.resolveLang(ev, join(this.buf.text, text));
      if (this.buf.lang && lang !== this.buf.lang && this.buf.text && this.settings.sourceLang === 'auto') this.commit();
      this.buf.lang = lang;
      if (speaker) this.buf.speaker = speaker;
    }

    if (ev.final) {
      if (text) {
        if (!this.buf.text) this.buf.t0 = Date.now();
        this.buf.text = join(this.buf.text, text);
      }
      this.interim = '';
      const words = this.buf.lang === 'zh' ? this.buf.text.length / 2 : this.buf.text.split(/\s+/).length;
      const done = ev.speechFinal || SENTENCE_END.test(this.buf.text) || words >= 32 || (words >= 14 && SOFT_END.test(this.buf.text));
      if (done) this.commit();
      else this.scheduleFlush();
    } else {
      if (!this.buf.text && text) this.buf.t0 = this.buf.t0 || Date.now();
      this.interim = text;
      this.scheduleFlush(2500);
    }
    this.pushPartial();
  }

  scheduleFlush(ms = 1800) {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.commit(), ms);
  }

  currentPartial() {
    const text = join(this.buf.text, this.interim);
    if (!text) return null;
    return { text, lang: this.buf.lang || detectLang(text, 'en'), speaker: this.buf.speaker };
  }

  pushPartial() {
    if (this.partialTimer) return;
    this.partialTimer = setTimeout(() => {
      this.partialTimer = null;
      this.broadcast({ type: 'partial', partial: this.currentPartial() });
    }, 60);
  }

  commit() {
    clearTimeout(this.flushTimer);
    const text = this.buf.text.trim();
    const lang = this.buf.lang || (text ? detectLang(text, 'en') : 'en');
    const speaker = this.buf.speaker;
    const t0 = this.buf.t0 || Date.now();
    this.buf = { text: '', lang: null, speaker: null, t0: 0 };
    this.interim = '';
    if (!text) { this.pushPartial(); return; }

    const seg = {
      id: crypto.randomUUID().slice(0, 8),
      t: Math.max(0, t0 - this.session.startedAt),
      te: Date.now() - this.session.startedAt,
      speaker: speaker ? `Speaker ${speaker}` : null,
      src: lang,
      text,
      tr: {},
      trDone: {},
    };
    this.segments.push(seg);
    this.persist();
    this.broadcast({ type: 'segment', seg: this.segmentView(seg, { role: 'control' }) }, ['control']);
    for (const c of this.clients) {
      if (c.role !== 'control') this.send(c, { type: 'segment', seg: this.segmentView(seg, c) });
    }
    this.broadcast({ type: 'partial', partial: null });
    this.translateSeg(seg, this.wantedLangs());
  }

  /* ------------------------------------------------------------- translation */

  wantedLangs() {
    const set = new Set(this.settings.screenLangs);
    for (const c of this.clients) if (c.role === 'phone' && c.lang) set.add(c.lang);
    return [...set];
  }

  backfill(n = 8) {
    const langs = this.wantedLangs();
    for (const seg of this.segments.slice(-n)) this.translateSeg(seg, langs);
  }

  translateSeg(seg, langs) {
    for (const lang of langs) {
      if (seg.trDone[lang]) continue;
      const key = `${seg.id}:${lang}`;
      if (this.inflight.has(key)) continue;
      if (lang === seg.src) {
        seg.tr[lang] = seg.text;
        seg.trDone[lang] = true;
        this.emitTr(seg, lang, true);
        continue;
      }
      this.inflight.add(key);
      this.runTranslation(seg, lang).finally(() => this.inflight.delete(key));
    }
  }

  async runTranslation(seg, lang) {
    const idx = this.segments.indexOf(seg);
    const history = this.segments.slice(Math.max(0, idx - 3), Math.max(0, idx)).map((s) => ({ src: s.text, tr: s.tr[lang] }));
    try {
      const out = await translate({
        text: seg.text,
        from: seg.src,
        to: lang,
        history,
        glossary: this.settings.glossary,
        context: this.settings.context,
        onDelta: (partial) => {
          seg.tr[lang] = partial;
          this.emitTr(seg, lang, false);
        },
      });
      seg.tr[lang] = out;
      seg.trDone[lang] = true;
      this.emitTr(seg, lang, true);
      this.persist();
    } catch (e) {
      console.error(`Translation to ${lang} failed:`, e.message);
      this.notify('error', `Translation to ${LANGUAGES[lang].name} failed: ${e.message}`);
    }
  }

  emitTr(seg, lang, done) {
    const key = `${seg.id}:${lang}`;
    const send = () => {
      this.trTimers.delete(key);
      const msg = JSON.stringify({ type: 'tr', id: seg.id, lang, text: seg.tr[lang] ?? '', done: !!seg.trDone[lang] });
      for (const c of this.clients) if (this.wants(c, lang) && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
    };
    if (done) {
      clearTimeout(this.trTimers.get(key));
      send();
    } else if (!this.trTimers.has(key)) {
      this.trTimers.set(key, setTimeout(send, 50));
    }
  }

  editSegment(id, text) {
    const seg = this.segments.find((s) => s.id === id);
    if (!seg || typeof text !== 'string' || !text.trim()) return;
    seg.text = text.trim().slice(0, 4000);
    seg.tr = {};
    seg.trDone = {};
    for (const c of this.clients) this.send(c, { type: 'segupdate', seg: this.segmentView(seg, c) });
    this.translateSeg(seg, this.wantedLangs());
    this.persist();
  }

  /* --------------------------------------------------------------- engines */

  async start({ engine }) {
    if (this.running) this.stop();
    engine = ['deepgram', 'browser', 'demo'].includes(engine) ? engine : config.sttEngine;
    this.engine = engine;
    if (engine === 'deepgram') {
      if (!config.deepgramKey) {
        this.engine = null;
        this.notify('error', 'No Deepgram API key yet. Add it under Settings, or choose the Browser or Demo engine.');
        this.setStt('error', 'No Deepgram key');
        return;
      }
      this.openDeepgram();
    } else if (engine === 'demo') {
      this.demoAbort = new AbortController();
      runDemo(this, this.demoAbort.signal);
      this.setStt('connected', 'demo');
    } else {
      this.setStt('connected', 'browser');
    }
    this.running = true;
    this.broadcast(this.statusMsg(), ['control']);
  }

  openDeepgram() {
    this.dg?.close();
    const auto = this.settings.sourceLang === 'auto';
    this.dg = createDeepgram({
      key: config.deepgramKey,
      lang: LANGUAGES[auto ? 'en' : this.settings.sourceLang].dg,
      multi: auto,
      diarize: this.settings.speakerMode === 'multi',
      onResult: (ev) => this.ingestStt(ev),
      onStatus: ({ state, detail }) => {
        this.setStt(state, detail);
        if (state === 'error') this.notify('error', detail);
      },
    });
  }

  /** Source language or speaker mode changed while live: reconnect speech recognition. */
  reconfigure() {
    if (this.running && this.engine === 'deepgram') {
      this.commit();
      this.openDeepgram();
    }
  }

  audio(buf) {
    this.dg?.send(buf);
  }

  stop() {
    this.commit();
    this.dg?.close();
    this.dg = null;
    this.demoAbort?.abort();
    this.demoAbort = null;
    this.running = false;
    this.engine = null;
    this.setStt('idle', '');
    this.broadcast(this.statusMsg(), ['control']);
  }
}
