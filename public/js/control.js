import { connect, Store } from '/assets/js/common.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = new Store();
let status = { running: false, engine: null, stt: { state: 'idle' }, translator: 'demo' };
let cfg = { hasDeepgram: false, hasAnthropic: false, model: '', sttEngine: 'deepgram' };
let net = { addresses: [], joinUrl: '' };
let viewers = { display: 0, phone: 0, langs: {} };

/* ------------------------------------------------------------------ toasts */
function toast(msg, level = '') {
  const t = document.createElement('div');
  t.className = `toast ${level}`;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), level === 'error' ? 8000 : 4000);
}

/* -------------------------------------------------------------- connection */
const conn = connect('control', {
  onMessage(m) {
    const type = store.handle(m);
    switch (type) {
      case 'hello': if (m.status) status = m.status; renderAll(); break;
      case 'settings': renderSettings(); break;
      case 'segment': case 'tr': case 'segupdate': case 'partial': case 'clear': scheduleFeed(); break;
      case 'status': status = m; renderStatus(); break;
      case 'viewers': viewers = m; renderStatus(); break;
      case 'notice': toast(m.message, m.level); break;
      case 'info': net.joinUrl = m.joinUrl; renderNet(); break;
      default: break;
    }
  },
  onOpen: () => setPill('#pill-stt', 'connecting', 'Connecting…'),
  onClose: () => setPill('#pill-stt', 'error', 'Disconnected'),
});

async function api(method, url, body) {
  const r = await fetch(`/api${url}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}

let patchTimer;
let pending = {};
function patchSettings(p, immediate) {
  Object.assign(store.settings, p);
  pending = { ...pending, ...p };
  clearTimeout(patchTimer);
  const send = () => { const body = pending; pending = {}; api('PATCH', '/settings', body).catch((e) => toast(e.message, 'error')); };
  if (immediate) send(); else patchTimer = setTimeout(send, 120);
}

/* -------------------------------------------------------------------- tabs */
$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  $$('#nav button').forEach((x) => x.classList.toggle('on', x === b));
  $$('.tab').forEach((x) => x.classList.toggle('on', x.id === `tab-${b.dataset.tab}`));
  try { localStorage.setItem('tab', b.dataset.tab); } catch { /* ignore */ }
});
try { const t = localStorage.getItem('tab'); if (t) $(`#nav button[data-tab="${t}"]`)?.click(); } catch { /* ignore */ }

$('#open-display').onclick = () => window.open('/display', 'display', 'width=1280,height=720');

/* ---------------------------------------------------------------- status */
function setPill(sel, state, text) {
  const p = $(sel);
  p.dataset.state = state;
  p.querySelector('span').textContent = text;
}

function renderStatus() {
  const s = status.stt || {};
  const label = { idle: 'Speech: idle', connecting: 'Speech: connecting…', connected: `Speech: ${status.engine || 'ready'}`, error: `Speech: ${s.detail || 'error'}` }[s.state] || 'Speech';
  setPill('#pill-stt', s.state === 'idle' ? 'idle' : s.state, label);
  setPill('#pill-tr', status.translator === 'claude' ? 'ok' : 'idle', status.translator === 'claude' ? 'Translation: Claude' : 'Translation: demo (no key)');
  const v = $('#pill-viewers');
  v.hidden = false;
  v.dataset.state = viewers.display + viewers.phone > 0 ? 'ok' : 'idle';
  v.querySelector('span').textContent = `Viewers: ${viewers.display} screen${viewers.display === 1 ? '' : 's'} · ${viewers.phone} phone${viewers.phone === 1 ? '' : 's'}`;
  const go = $('#go');
  go.classList.toggle('live', status.running);
  $('#go-text').textContent = status.running ? 'Stop listening' : 'Start listening';
  $('#engine').disabled = status.running;
}

/* ------------------------------------------------------------- renderers */
function renderAll() {
  renderSource();
  renderSettings();
  renderStatus();
  scheduleFeed();
}

const LAYOUTS = {
  stack: ['Stacked rows', '<rect x="2" y="3" width="56" height="12" rx="2"/><rect x="2" y="18" width="56" height="12" rx="2"/><rect x="2" y="33" width="56" height="12" rx="2"/>'],
  columns: ['Columns', '<rect x="2" y="3" width="17" height="42" rx="2"/><rect x="21" y="3" width="17" height="42" rx="2"/><rect x="40" y="3" width="18" height="42" rx="2"/>'],
  grid: ['Grid', '<rect x="2" y="3" width="27" height="19" rx="2"/><rect x="31" y="3" width="27" height="19" rx="2"/><rect x="2" y="26" width="27" height="19" rx="2"/><rect x="31" y="26" width="27" height="19" rx="2"/>'],
  focus: ['Focus', '<rect x="2" y="3" width="56" height="26" rx="2"/><rect x="2" y="32" width="27" height="13" rx="2"/><rect x="31" y="32" width="27" height="13" rx="2"/>'],
  subtitles: ['Subtitles', '<rect x="2" y="3" width="56" height="20" rx="2" opacity=".25"/><rect x="2" y="27" width="56" height="8" rx="2"/><rect x="2" y="37" width="56" height="8" rx="2"/>'],
};
const THEMES = { midnight: 'Midnight', aurora: 'Aurora', gold: 'Gold', light: 'Light', contrast: 'High contrast' };

function renderSource() {
  const box = $('#source');
  box.replaceChildren();
  const opts = [['auto', 'Auto', ''], ...Object.values(store.langs).map((l) => [l.code, l.native, l.code.toUpperCase()])];
  opts.forEach(([code, name, sub], i) => {
    const b = document.createElement('button');
    b.dataset.lang = code;
    b.innerHTML = `<span></span><small>${i + 1}</small>`;
    b.firstChild.textContent = name;
    b.onclick = () => setSource(code);
    box.append(b);
  });
  const th = $('#themes');
  th.replaceChildren();
  for (const [k, name] of Object.entries(THEMES)) {
    const b = document.createElement('button'); b.textContent = name; b.dataset.theme = k;
    b.onclick = () => patchSettings({ theme: k }, true);
    th.append(b);
  }
  const lay = $('#layouts');
  lay.replaceChildren();
  for (const [k, [name, svg]] of Object.entries(LAYOUTS)) {
    const b = document.createElement('button'); b.dataset.layout = k;
    b.innerHTML = `<svg viewBox="0 0 60 48">${svg}</svg>${name}`;
    b.onclick = () => patchSettings({ layout: k }, true);
    lay.append(b);
  }
}

function setSource(code) {
  patchSettings({ sourceLang: code }, true);
  conn.send({ type: 'source', lang: code, speakerMode: store.settings.speakerMode });
  restartBrowserRecognition();
}

function renderSettings() {
  const s = store.settings;
  if (!s) return;
  for (const el of $$('[data-set]')) {
    const k = el.dataset.set;
    if (document.activeElement === el) continue;
    if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
  }
  for (const o of $$('[data-out]')) {
    const k = o.dataset.out;
    o.textContent = k === 'blur' ? `${s[k]} px` : k === 'maxLines' ? s[k] : `${s[k]}${k === 'dim' || k === 'fontScale' ? '%' : ''}`;
  }
  $$('#source button').forEach((b) => b.classList.toggle('on', b.dataset.lang === s.sourceLang));
  $$('#themes button').forEach((b) => b.classList.toggle('on', b.dataset.theme === s.theme));
  $$('#layouts button').forEach((b) => b.classList.toggle('on', b.dataset.layout === s.layout));
  $('#multi').checked = s.speakerMode === 'multi';
  $('#auto-hint').hidden = s.sourceLang !== 'auto';
  $('#blank').classList.toggle('on', s.blank);
  for (const kind of ['logo', 'bgLandscape', 'bgPortrait']) {
    const t = $(`#thumb-${kind}`);
    t.style.backgroundImage = s[kind] ? `url("${s[kind]}")` : '';
    t.classList.toggle('has', !!s[kind]);
  }
  renderLanguages();
  scheduleFeed();
}

function renderLanguages() {
  const s = store.settings;
  const list = $('#lang-list');
  const order = [...s.screenLangs, ...Object.keys(store.langs).filter((c) => !s.screenLangs.includes(c))];
  list.replaceChildren();
  order.forEach((code) => {
    const L = store.langs[code];
    const on = s.screenLangs.includes(code);
    const row = document.createElement('div');
    row.className = `lang-row ${on ? '' : 'off'}`;
    row.innerHTML = '<input type="checkbox"><span class="dot"></span><span class="nm"></span><button class="btn ghost" data-d="-1">↑</button><button class="btn ghost" data-d="1">↓</button>';
    row.querySelector('.dot').style.background = L.color;
    row.querySelector('.nm').innerHTML = `${L.native}<small>${L.name}</small>`;
    const cb = row.querySelector('input');
    cb.checked = on;
    cb.onchange = () => {
      const next = cb.checked ? [...s.screenLangs, code] : s.screenLangs.filter((c) => c !== code);
      if (!next.length) { cb.checked = true; return toast('Keep at least one language on the screen.'); }
      patchSettings({ screenLangs: next }, true);
    };
    row.querySelectorAll('button').forEach((b) => {
      b.disabled = !on;
      b.onclick = () => {
        const arr = [...s.screenLangs];
        const i = arr.indexOf(code);
        const j = i + Number(b.dataset.d);
        if (j < 0 || j >= arr.length) return;
        [arr[i], arr[j]] = [arr[j], arr[i]];
        patchSettings({ screenLangs: arr }, true);
      };
    });
    list.append(row);
  });
  $('#lang-warn').textContent = s.screenLangs.length > 4 ? `${s.screenLangs.length} languages at once: text will be smaller. The "Grid" layout works best with many languages.` : '';
}

/* Generic bindings for every [data-set] input */
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-set]');
  if (!el || !store.settings) return;
  const k = el.dataset.set;
  const v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
  patchSettings({ [k]: v });
  const out = $(`[data-out="${k}"]`);
  if (out) renderSettings();
});
$('#multi').onchange = (e) => {
  const speakerMode = e.target.checked ? 'multi' : 'single';
  patchSettings({ speakerMode }, true);
  conn.send({ type: 'source', lang: store.settings.sourceLang, speakerMode });
};
$('#blank').onclick = () => patchSettings({ blank: !store.settings.blank }, true);
$('#clear').onclick = () => conn.send({ type: 'clearScreen' });
$('#new-session').onclick = () => {
  if (confirm('Start a new session? The current transcript is saved and the screen is cleared.')) conn.send({ type: 'newSession' });
};

/* ------------------------------------------------------------------ feed */
let feedTimer;
function scheduleFeed() {
  if (feedTimer) return;
  feedTimer = setTimeout(() => { feedTimer = null; renderFeed(); }, 100);
}

function renderFeed() {
  const feed = $('#feed');
  if (!store.settings || feed.contains(document.activeElement) && document.activeElement.classList.contains('src')) return;
  const langs = store.settings.screenLangs;
  const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 40;
  const frag = document.createDocumentFragment();
  const rows = store.segments.slice(-40);
  for (const seg of rows) frag.append(feedItem(seg, langs));
  if (store.partial) {
    const L = store.langs[store.partial.lang];
    const d = document.createElement('div');
    d.className = 'fs live';
    d.innerHTML = '<div class="meta"><span class="chip"></span><span>listening…</span></div><div class="src"></div>';
    const chip = d.querySelector('.chip');
    chip.textContent = store.partial.lang.toUpperCase(); chip.style.background = L.color;
    const src = d.querySelector('.src'); src.textContent = store.partial.text; src.dir = L.dir;
    frag.append(d);
  }
  if (!rows.length && !store.partial) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Nothing yet. Press "Start listening" and speak, or try the Demo engine.';
    frag.append(e);
  }
  feed.replaceChildren(frag);
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

function feedItem(seg, langs) {
  const L = store.langs[seg.src] || { color: '#888', dir: 'ltr' };
  const d = document.createElement('div');
  d.className = 'fs';
  const time = new Date(seg.t ? Date.now() : Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  d.innerHTML = '<div class="meta"><span class="chip"></span><span class="who"></span></div><div class="src" contenteditable="plaintext-only" spellcheck="false" title="Click to correct the text; it is translated again"></div>';
  const chip = d.querySelector('.chip'); chip.textContent = seg.src.toUpperCase(); chip.style.background = L.color;
  d.querySelector('.who').textContent = seg.speaker || '';
  const src = d.querySelector('.src'); src.textContent = seg.text; src.dir = L.dir;
  src.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); src.blur(); } if (e.key === 'Escape') { src.textContent = seg.text; src.blur(); } });
  src.addEventListener('blur', () => { const t = src.textContent.trim(); if (t && t !== seg.text) conn.send({ type: 'edit', id: seg.id, text: t }); });
  for (const code of langs) {
    if (code === seg.src) continue;
    const T = store.langs[code];
    const line = document.createElement('div');
    line.className = `tr ${seg.trDone[code] ? '' : 'pending'}`;
    line.innerHTML = '<b></b><span></span>';
    line.firstChild.textContent = code;
    const span = line.lastChild; span.textContent = seg.tr[code] || '…'; span.dir = T.dir;
    d.append(line);
  }
  return d;
}

$('#type-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $('#type-input');
  const text = input.value.trim();
  if (!text) return;
  const lang = store.settings.sourceLang === 'auto' ? undefined : store.settings.sourceLang;
  conn.send({ type: 'stt', text, final: true, speechFinal: true, lang });
  input.value = '';
};

/* -------------------------------------------------------------- microphone */
let mic = null;
let recognition = null;
let lastSound = 0;

async function listDevices() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const sel = $('#device');
    const cur = sel.value;
    sel.replaceChildren(new Option('Default microphone', ''));
    devs.forEach((d) => d.deviceId && d.deviceId !== 'default' && sel.append(new Option(d.label || `Microphone ${sel.length}`, d.deviceId)));
    sel.value = cur;
  } catch { /* ignore */ }
}
navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
listDevices();

async function startMic() {
  const deviceId = $('#device').value;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/assets/audio-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-worklet');
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);
  node.port.onmessage = (e) => {
    if (e.data.pcm) { if (status.engine === 'deepgram') conn.send(e.data.pcm); }
    if (e.data.level !== undefined) {
      const lv = Math.min(1, Math.sqrt(e.data.level) * 1.2);
      $('#meter-bar').style.width = `${lv * 100}%`;
      if (e.data.level > 0.02) lastSound = Date.now();
    }
  };
  mic = { stream, ctx };
  listDevices(); // labels become available after permission
}

function stopMic() {
  mic?.stream.getTracks().forEach((t) => t.stop());
  mic?.ctx.close();
  mic = null;
  $('#meter-bar').style.width = '0';
}

function restartBrowserRecognition() {
  if (!recognition) return;
  const r = recognition;
  recognition = null;
  r.onend = null;
  r.abort();
  if (status.running && $('#engine').value === 'browser') startRecognition();
}

function startRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) throw new Error('This browser has no built-in speech recognition. Use Chrome or Edge, or the Deepgram engine.');
  const lang = store.settings.sourceLang;
  if (lang === 'auto') throw new Error('The Browser engine needs a specific language. Pick one above.');
  const r = new SR();
  r.lang = store.langs[lang].web;
  r.continuous = true;
  r.interimResults = true;
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      const res = e.results[i];
      conn.send({ type: 'stt', text: res[0].transcript, final: res.isFinal, speechFinal: res.isFinal, lang });
    }
  };
  r.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') toast(`Speech recognition: ${e.error}`, 'error'); };
  r.onend = () => { if (recognition === r && status.running) try { r.start(); } catch { /* already started */ } };
  recognition = r;
  r.start();
}

let busy = false;
async function toggleListening() {
  if (busy) return;
  busy = true;
  try {
    if (status.running) {
      recognition?.abort(); recognition = null;
      conn.send({ type: 'stop' });
      stopMic();
      $('#mic-warn').hidden = true;
    } else {
      const engine = $('#engine').value;
      try { localStorage.setItem('engine', engine); } catch { /* ignore */ }
      if (engine === 'deepgram' && !cfg.hasDeepgram) { toast('Add your Deepgram key in Settings first (or try the Demo engine).', 'error'); return; }
      if (engine !== 'demo') await startMic();
      conn.send({ type: 'start', engine });
      status = { ...status, running: true, engine };
      if (engine === 'browser') startRecognition();
      lastSound = Date.now();
    }
    renderStatus();
  } catch (e) {
    stopMic();
    toast(e.name === 'NotAllowedError' ? 'Microphone blocked. Allow it in the browser address bar and try again.' : e.message, 'error');
  } finally { busy = false; }
}
$('#go').onclick = toggleListening;

setInterval(() => {
  const w = $('#mic-warn');
  if (status.running && mic && status.engine !== 'demo' && Date.now() - lastSound > 6000) {
    w.hidden = false;
    w.textContent = 'No sound from the microphone. Check that it is plugged in, not muted, and selected above.';
  } else w.hidden = true;
}, 1500);

/* Keyboard shortcuts (ignored while typing) */
addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
  const codes = ['auto', ...Object.keys(store.langs)];
  if (/^[1-8]$/.test(e.key) && codes[Number(e.key) - 1]) setSource(codes[Number(e.key) - 1]);
  if (e.key === 'b' || e.key === 'B') patchSettings({ blank: !store.settings.blank }, true);
  if (e.key === 'c' || e.key === 'C') conn.send({ type: 'clearScreen' });
});

/* ------------------------------------------------------------------ images */
const LIMITS = { logo: [800, 800], bgLandscape: [2560, 1440], bgPortrait: [1440, 2560] };

async function prepareImage(kind, file) {
  const bmp = await createImageBitmap(file);
  const [mw, mh] = LIMITS[kind];
  if (kind === 'bgLandscape' && bmp.height > bmp.width * 1.1) toast('That picture is tall. Did you mean the phone picture? Using it as the big-screen background anyway.');
  if (kind === 'bgPortrait' && bmp.width > bmp.height * 1.1) toast('That picture is wide. Did you mean the big-screen picture? Using it as the phone background anyway.');
  const scale = Math.min(1, mw / bmp.width, mh / bmp.height);
  const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type);
  if (ok && scale === 1 && file.size < 1_500_000) return file;
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const type = kind === 'logo' ? 'image/png' : 'image/jpeg';
  return new Promise((res) => c.toBlob(res, type, 0.86));
}

document.addEventListener('change', async (e) => {
  const input = e.target.closest('input[data-upload]');
  if (!input || !input.files[0]) return;
  const kind = input.dataset.upload;
  try {
    const blob = await prepareImage(kind, input.files[0]);
    const r = await fetch(`/api/upload/${kind}`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
    if (!r.ok) throw new Error((await r.json()).error || 'Upload failed');
    toast('Image updated.');
  } catch (err) { toast(`Could not use that image: ${err.message}`, 'error'); }
  input.value = '';
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-remove]');
  if (b) patchSettings({ [b.dataset.remove]: '' }, true);
});

/* ---------------------------------------------------------------- settings */
function renderNet() {
  const sel = $('#host');
  const current = cfg.publicHost || net.addresses[0]?.address || '';
  sel.replaceChildren();
  net.addresses.forEach((a) => sel.append(new Option(`${a.address}  (${a.name}${a.virtual ? ', virtual' : ''})`, a.address)));
  if (cfg.publicHost && !net.addresses.some((a) => a.address === cfg.publicHost)) sel.append(new Option(cfg.publicHost, cfg.publicHost));
  if (!net.addresses.length) sel.append(new Option('No network found (localhost only)', ''));
  sel.value = current;
  $('#join-url').textContent = net.joinUrl;
}

function renderConfig() {
  $('#badge-dg').textContent = cfg.hasDeepgram ? 'Key saved ✓' : 'Not set';
  $('#badge-dg').classList.toggle('ok', cfg.hasDeepgram);
  $('#badge-an').textContent = cfg.hasAnthropic ? 'Key saved ✓' : 'Not set (demo mode)';
  $('#badge-an').classList.toggle('ok', cfg.hasAnthropic);
  $('#model').value = cfg.model;
  let saved = null;
  try { saved = localStorage.getItem('engine'); } catch { /* ignore */ }
  const eng = $('#engine');
  if (!eng.dataset.init) {
    eng.value = saved || (cfg.hasDeepgram ? cfg.sttEngine : 'demo');
    eng.dataset.init = '1';
  }
}

async function loadState() {
  const st = await api('GET', '/state');
  cfg = st.config; net = st.net;
  renderConfig(); renderNet();
}
loadState().catch((e) => toast(e.message, 'error'));

$('#save-keys').onclick = async () => {
  try {
    const r = await api('PUT', '/config', { deepgramKey: $('#key-dg').value, anthropicKey: $('#key-an').value, model: $('#model').value });
    cfg = r.config; net = r.net;
    $('#key-dg').value = ''; $('#key-an').value = '';
    renderConfig(); renderNet();
    toast('Saved.');
  } catch (e) { toast(e.message, 'error'); }
};
$('#test-an').onclick = async () => {
  $('#test-result').textContent = 'Testing…';
  await $('#save-keys').onclick();
  const r = await api('POST', '/config/test/anthropic');
  $('#test-result').textContent = r.ok ? `Works: "Good evening" → "${r.sample}"` : `Failed: ${r.error}`;
};
$('#host').onchange = async () => {
  const r = await api('PUT', '/config', { publicHost: $('#host').value });
  cfg = r.config; net = r.net; renderNet();
};

/* ---------------------------------------------------------------- previews */
function fitPreviews() {
  for (const box of $$('.pv-screen')) {
    const f = box.querySelector('iframe');
    f.style.transform = `scale(${box.clientWidth / 1280})`;
  }
}
new ResizeObserver(fitPreviews).observe($('#pv-screen'));
fitPreviews();
