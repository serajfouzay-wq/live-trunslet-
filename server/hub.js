import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { DIRS, config } from './config.js';
import { LANGUAGES } from './languages.js';
import { DEFAULT_SETTINGS, sanitize, saveSettings, viewerSettings } from './settings.js';
import { detectLang } from './detect.js';
import { translate, explain, isFatal } from './translate.js';
import { log } from './log.js';
import { createDeepgram } from './stt/deepgram.js';
import { runDemo } from './demo.js';

const CJK_END = /[㐀-鿿]$/;
const CJK_START = /^[㐀-鿿]/;
const join = (a, b) => (!a ? b : CJK_END.test(a) && CJK_START.test(b) ? a + b : `${a} ${b}`);
const SENTENCE_END = /[.!?…。！？؟]["'”’)\]]*$/;
const SOFT_END = /[,;:،؛，、：]$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freshPipe = () => ({ audioChunks: 0, audioBytes: 0, lastAudioAt: 0, lastResultAt: 0, results: 0, segments: 0, trOk: 0, trFail: 0, trMs: 0, lastError: '', startedAt: Date.now() });

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
    this.pipe = freshPipe();
    this.draft = { lastAt: 0, lastLen: 0, ctl: new Map(), text: {}, timers: new Map() };
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

  addClient(ws, role, langs, preview = false) {
    const client = { ws, role, langs: langs || [], preview };
    this.clients.add(client);
    this.sendHello(client);
    if (role === 'phone' && client.langs.length) this.backfill();
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
      live: this.running,
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
    if (client.role === 'phone') return client.langs.includes(lang);
    return false;
  }

  segmentView(seg, client) {
    const tr = {}, trDone = {};
    for (const l of Object.keys(seg.tr)) {
      if (this.wants(client, l)) { tr[l] = seg.tr[l]; trDone[l] = !!seg.trDone[l]; }
    }
    const trErr = {};
    for (const l of Object.keys(seg.trErr || {})) if (seg.trErr[l] && this.wants(client, l)) trErr[l] = true;
    return { id: seg.id, t: seg.t, speaker: seg.speaker, src: seg.src, text: seg.text, tr, trDone, trErr };
  }

  scheduleStats() {
    clearTimeout(this.statsTimer);
    this.statsTimer = setTimeout(() => this.broadcast(this.statsMsg(), ['control']), 300);
  }

  statsMsg() {
    const stats = { display: 0, phone: 0, langs: {} };
    for (const c of this.clients) {
      if (c.preview) continue;
      if (c.role === 'display') stats.display += 1;
      if (c.role === 'phone') {
        stats.phone += 1;
        for (const l of c.langs) stats.langs[l] = (stats.langs[l] || 0) + 1;
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
      translator: config.anthropicKey ? 'claude' : this.engine === 'demo' ? 'demo' : 'missing',
    };
  }

  /** Live health of the whole chain (microphone -> speech -> text -> translation). */
  pipeMsg() {
    const p = this.pipe;
    const now = Date.now();
    return {
      type: 'pipe',
      running: this.running,
      engine: this.engine,
      audioKB: Math.round(p.audioBytes / 1024),
      audioAgo: p.lastAudioAt ? now - p.lastAudioAt : null,
      textAgo: p.lastResultAt ? now - p.lastResultAt : null,
      sinceStart: now - p.startedAt,
      results: p.results,
      segments: p.segments,
      trOk: p.trOk,
      trFail: p.trFail,
      avgMs: p.trOk ? Math.round(p.trMs / p.trOk) : null,
      lastError: p.lastError,
      stt: this.stt,
    };
  }

  diagnostics() {
    return {
      time: new Date().toISOString(),
      running: this.running,
      engine: this.engine,
      stt: this.stt,
      keys: { deepgram: !!config.deepgramKey, claude: !!config.anthropicKey },
      model: config.model,
      sourceLang: this.settings.sourceLang,
      screenLangs: this.settings.screenLangs,
      fastMode: this.settings.fastMode,
      viewers: this.statsMsg(),
      pipe: this.pipeMsg(),
      segments: this.segments.length,
    };
  }

  setStt(state, detail = '') {
    if (this.stt.state !== state || this.stt.detail !== detail) log(state === 'error' ? 'error' : 'info', `speech: ${state} ${detail}`);
    this.stt = { state, detail };
    this.broadcast(this.statusMsg(), ['control']);
  }

  setLive(live) {
    this.broadcast({ type: 'live', live }, ['display', 'phone']);
  }

  notify(level, message) {
    const now = Date.now();
    if (this.lastNotice?.message === message && now - this.lastNotice.at < 10000) return; // don't repeat the same error
    this.lastNotice = { message, at: now };
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
    if (text) { this.pipe.lastResultAt = Date.now(); this.pipe.results += 1; }
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
    this.maybeDraft();
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
      trErr: {},
    };
    this.pipe.segments += 1;
    this.stopDrafts(seg);
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
    for (const c of this.clients) if (c.role === 'phone') c.langs.forEach((l) => set.add(l));
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

  async runTranslation(seg, lang, attempt = 0) {
    const idx = this.segments.indexOf(seg);
    const history = this.segments.slice(Math.max(0, idx - 3), Math.max(0, idx)).map((s) => ({ src: s.text, tr: s.tr[lang] }));
    const t0 = Date.now();
    seg.trErr = seg.trErr || {};
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
          seg.trErr[lang] = false;
          this.emitTr(seg, lang, false);
        },
      });
      seg.tr[lang] = out;
      seg.trDone[lang] = true;
      seg.trErr[lang] = false;
      this.pipe.trOk += 1;
      this.pipe.trMs += Date.now() - t0;
      this.emitTr(seg, lang, true);
      this.persist();
    } catch (e) {
      if (e?.name === 'AbortError') return;
      if (!isFatal(e) && attempt < 1) {
        log('warn', `translation to ${lang} failed (${e.message}); retrying`);
        await sleep(1500);
        return this.runTranslation(seg, lang, attempt + 1);
      }
      const why = explain(e);
      log('error', `translation to ${lang} failed: ${e.message}`);
      this.pipe.trFail += 1;
      this.pipe.lastError = why;
      seg.trErr[lang] = true;
      this.emitTr(seg, lang, false);
      this.notify('error', why);
    }
  }

  /** Try again for every language of a sentence that failed. */
  retrySegment(id) {
    const seg = this.segments.find((s) => s.id === id);
    if (!seg) return;
    for (const lang of Object.keys(seg.trErr || {})) if (seg.trErr[lang]) { seg.trErr[lang] = false; seg.tr[lang] = ''; }
    this.translateSeg(seg, this.wantedLangs());
  }

  /* ----------------------------------------------------------- fast mode */
  // While the speaker is still talking, translate what has been said so far (at most once every ~1.5 s per
  // language) and show it as a draft. The final translation replaces it as soon as the sentence ends.

  maybeDraft() {
    if (!this.settings.fastMode || !this.running || this.engine === 'demo' || !config.anthropicKey) return;
    const part = this.currentPartial();
    if (!part) return;
    const cjk = part.lang === 'zh';
    const units = cjk ? part.text.length / 2 : part.text.split(/\s+/).length;
    const now = Date.now();
    if (units < 4 || now - this.draft.lastAt < 1500 || part.text.length - this.draft.lastLen < (cjk ? 5 : 14)) return;
    this.draft.lastAt = now;
    this.draft.lastLen = part.text.length;
    for (const lang of this.wantedLangs()) {
      if (lang === part.lang) continue;
      this.draft.ctl.get(lang)?.abort();
      const ctl = new AbortController();
      this.draft.ctl.set(lang, ctl);
      const idx = this.segments.length;
      const history = this.segments.slice(Math.max(0, idx - 2)).map((s) => ({ src: s.text, tr: s.tr[lang] }));
      translate({
        text: part.text, from: part.lang, to: lang, history, glossary: this.settings.glossary, context: this.settings.context, signal: ctl.signal,
        onDelta: (text) => { this.draft.text[lang] = text; this.emitDraft(lang); },
      }).catch((e) => { if (e?.name !== 'AbortError') log('warn', `draft translation to ${lang} failed: ${e.message}`); });
    }
  }

  emitDraft(lang) {
    if (this.draft.timers.has(lang)) return;
    this.draft.timers.set(lang, setTimeout(() => {
      this.draft.timers.delete(lang);
      const msg = JSON.stringify({ type: 'draft', lang, text: this.draft.text[lang] || '' });
      for (const c of this.clients) if ((c.role === 'display' || c.role === 'control') && this.wants(c, lang) && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
    }, 80));
  }

  /** The sentence ended: cancel pending drafts and use the latest one as the first text of the real translation. */
  stopDrafts(seg) {
    for (const ctl of this.draft.ctl.values()) ctl.abort();
    this.draft.ctl.clear();
    for (const t of this.draft.timers.values()) clearTimeout(t);
    this.draft.timers.clear();
    if (seg) for (const [lang, text] of Object.entries(this.draft.text)) if (text && lang !== seg.src) seg.tr[lang] = text;
    this.draft.text = {};
    this.draft.lastAt = 0;
    this.draft.lastLen = 0;
  }

  emitTr(seg, lang, done) {
    const key = `${seg.id}:${lang}`;
    const send = () => {
      this.trTimers.delete(key);
      const msg = JSON.stringify({ type: 'tr', id: seg.id, lang, text: seg.tr[lang] ?? '', done: !!seg.trDone[lang], error: !!seg.trErr?.[lang] });
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
    seg.trErr = {};
    for (const c of this.clients) this.send(c, { type: 'segupdate', seg: this.segmentView(seg, c) });
    this.translateSeg(seg, this.wantedLangs());
    this.persist();
  }

  /* --------------------------------------------------------------- engines */

  async start({ engine, owner }) {
    if (this.running) this.stop();
    this.owner = owner || null;
    engine = ['deepgram', 'browser', 'demo'].includes(engine) ? engine : config.sttEngine;
    if (engine === 'deepgram' && !config.deepgramKey) {
      this.owner = null;
      this.notify('error', 'No Deepgram API key yet. Add it under Settings, or choose the Demo engine.');
      this.setStt('error', 'No Deepgram key');
      return;
    }
    // Mark as running BEFORE opening the engine: engines report status while they connect.
    this.engine = engine;
    this.running = true;
    this.pipe = freshPipe();
    log('info', `start listening: engine=${engine} source=${this.settings.sourceLang} model=${config.model}`);
    clearInterval(this.pipeTimer);
    this.pipeTimer = setInterval(() => this.broadcast(this.pipeMsg(), ['control']), 1000);
    if (engine === 'deepgram') {
      this.openDeepgram();
    } else if (engine === 'demo') {
      this.demoAbort = new AbortController();
      runDemo(this, this.demoAbort.signal);
      this.setStt('connected', 'demo');
    } else {
      this.setStt('connected', 'browser');
    }
    this.broadcast(this.statusMsg(), ['control']);
    this.setLive(true);
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
    this.pipe.audioChunks += 1;
    this.pipe.audioBytes += buf.length;
    this.pipe.lastAudioAt = Date.now();
    this.dg?.send(buf);
  }

  stop() {
    this.commit();
    log('info', 'stop listening');
    clearInterval(this.pipeTimer);
    this.stopDrafts();
    this.dg?.close();
    this.dg = null;
    this.demoAbort?.abort();
    this.demoAbort = null;
    this.running = false;
    this.engine = null;
    this.owner = null;
    this.setStt('idle', '');
    this.broadcast(this.statusMsg(), ['control']);
    this.setLive(false);
  }
}
