import { connect, Store } from '/assets/js/common.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = new Store();
let status = { running: false, engine: null, stt: { state: 'idle' }, translator: 'demo' };
let cfg = { hasDeepgram: false, hasAnthropic: false, model: '', sttEngine: 'deepgram' };
let net = { addresses: [], joinUrl: '' };
let viewers = { display: 0, phone: 0, langs: {} };
let pipe = null;
let offlineState = null;
const desktop = window.desktop || null;

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
      case 'hello': if (m.status) status = m.status; renderAllWithPhone(); break;
      case 'settings': renderSettings(); break;
      case 'segment': case 'tr': case 'segupdate': case 'partial': case 'clear': scheduleFeed(); break;
      case 'status':
        status = m;
        // Another page (or a server restart) stopped listening: release our microphone. The grace period
        // ignores the status messages that arrive while a start we just requested is still settling.
        if (!m.running && (mic || recognition) && Date.now() - startedAt > 4000) { recognition?.abort(); recognition = null; stopMic(); $('#mic-warn').hidden = true; }
        renderStatus();
        break;
      case 'viewers': viewers = m; renderStatus(); renderPhoneLangs(); break;
      case 'pipe': pipe = m; renderPipe(); break;
      case 'offline': offlineState = m; renderOffline(); break;
      case 'draft': scheduleFeed(); break;
      case 'notice': toast(m.message, m.level); break;
      case 'info': net.joinUrl = m.joinUrl; renderNet(); renderJoin(); break;
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
const PAGES = {
  live: ['Live', 'Start listening and watch the translation appear.'],
  design: ['Design', 'Title, logo, backgrounds and the look of every screen.'],
  languages: ['Languages', 'What the big screen shows, and what phones can choose.'],
  glossary: ['Glossary', 'Names and terms that must be translated the way you want.'],
  events: ['Events', 'Save a whole setup and bring it back in one click.'],
  transcript: ['Transcript', 'Download what was said, in any language.'],
  settings: ['Settings', 'Keys, translation model and network.'],
};
$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  $('#page-title').textContent = PAGES[b.dataset.tab][0];
  $('#page-sub').textContent = PAGES[b.dataset.tab][1];
  $$('#nav button').forEach((x) => x.classList.toggle('on', x === b));
  $$('.tab').forEach((x) => x.classList.toggle('on', x.id === `tab-${b.dataset.tab}`));
  try { localStorage.setItem('tab', b.dataset.tab); } catch { /* ignore */ }
});
$('#page-sub').textContent = PAGES.live[1];
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
  const label = { idle: 'Speech: idle', connecting: 'Speech: connecting…', connected: `Speech: ${{ deepgram: 'Deepgram', local: 'offline', browser: 'browser', demo: 'demo' }[status.engine] || 'ready'}`, error: `Speech: ${s.detail || 'error'}` }[s.state] || 'Speech';
  setPill('#pill-stt', s.state === 'idle' ? 'idle' : s.state, label);
  setPill('#pill-tr', ['claude', 'offline'].includes(status.translator) ? 'ok' : status.translator === 'demo' ? 'idle' : 'error', { claude: 'Translation: Claude', offline: 'Translation: offline', demo: 'Translation: demo' }[status.translator] || 'Translation: not set up');
  const v = $('#pill-viewers');
  v.hidden = false;
  v.dataset.state = viewers.display + viewers.phone > 0 ? 'ok' : 'idle';
  v.querySelector('span').textContent = `Viewers: ${viewers.display} screen${viewers.display === 1 ? '' : 's'} · ${viewers.phone} phone${viewers.phone === 1 ? '' : 's'}`;
  const go = $('#go');
  go.classList.toggle('live', status.running);
  $('#go-text').textContent = status.running ? 'Stop listening' : 'Start listening';
  $('#go-ico').setAttribute('href', `/assets/icons.svg#i-${status.running ? 'stop' : 'mic'}`);
  $('#engine').disabled = status.running;
  $('.hero').classList.toggle('live', !!status.running);
  const oa = $('#onair');
  oa.hidden = !status.running;
  if (status.running && !onAirSince) onAirSince = Date.now();
  if (!status.running) onAirSince = 0;
  renderPipe();
}

let onAirSince = 0;
setInterval(() => {
  if (!onAirSince) return;
  const t = Math.floor((Date.now() - onAirSince) / 1000);
  $('#onair-time').textContent = `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}, 1000);

/* ---- the pipeline strip: shows exactly where things stop (mic -> speech -> text -> translation) */
function setNode(id, state, text) {
  const n = $(`#${id}`);
  n.dataset.s = state;
  n.querySelector('small').textContent = text;
}

function renderPipe() {
  const running = !!status.running;
  const msg = $('#mic-warn');
  if (!running) {
    const testing = !!mic;
    setNode('n-mic', testing ? (Date.now() - lastSound < 3000 ? 'ok' : 'warn') : 'off', testing ? (Date.now() - lastSound < 3000 ? 'Hearing sound' : 'Quiet') : 'Off');
    setNode('n-stt', 'off', 'Off'); setNode('n-txt', 'off', 'Off');
    setNode('n-tr', status.translator === 'missing' ? 'warn' : 'off', status.translator === 'missing' ? 'Not set up' : status.translator === 'offline' ? 'Offline ready' : 'Ready');
    if (!testing) msg.hidden = true;
    return;
  }
  const p = pipe || {};
  const engine = status.engine;
  const sinceStart = p.sinceStart ?? 0;
  let advice = '';

  // microphone
  if (engine === 'demo') setNode('n-mic', 'ok', 'Demo voice');
  else if (!mic) { setNode('n-mic', 'bad', 'Not active'); advice = 'The microphone is not active. Press Stop, then Start again and allow microphone access.'; }
  else if (Date.now() - lastSound > 6000) { setNode('n-mic', 'warn', 'No sound'); advice = 'No sound from the microphone. Check that it is plugged in, not muted, and selected above.'; }
  else setNode('n-mic', 'ok', 'Hearing sound');

  // speech service
  const st = (p.stt || status.stt || {});
  if (engine === 'browser') setNode('n-stt', 'ok', 'Browser');
  else if (st.state === 'error') { setNode('n-stt', 'bad', st.detail || 'Error'); advice ||= `Speech service problem: ${st.detail || 'unknown'}.`; }
  else if (st.state === 'connecting') setNode('n-stt', 'warn', 'Connecting…');
  else if (st.state === 'connected') setNode('n-stt', 'ok', engine === 'deepgram' ? `Deepgram · ${p.audioKB ?? 0} KB` : engine === 'local' ? 'Offline · this laptop' : 'Connected');
  else setNode('n-stt', 'warn', 'Starting…');

  // text coming back
  if ((engine === 'deepgram' || engine === 'local') && sinceStart > 9000 && !p.results && lastSound && Date.now() - lastSound < 4000) {
    setNode('n-txt', 'warn', 'No text yet');
    advice ||= `The speech service hears audio but returned no text. Check that the speaker's language (${store.settings.sourceLang === 'auto' ? 'Auto' : store.langs[store.settings.sourceLang]?.name}) is right, and speak a little louder or closer.`;
  } else if (p.results) setNode('n-txt', p.textAgo != null && p.textAgo < 20000 ? 'ok' : 'warn', `${p.segments || 0} sentence${p.segments === 1 ? '' : 's'}`);
  else setNode('n-txt', 'warn', 'Listening…');

  // translation
  if (status.translator === 'missing') { setNode('n-tr', 'bad', 'Not set up'); advice ||= 'Text is arriving, but nothing can translate it: add a Claude key, or download the offline translation pack (Settings → Offline mode).'; }
  else if (p.trFail && (p.trFail > p.trOk * 0.3)) { setNode('n-tr', 'bad', 'Problem'); advice ||= p.lastError || 'Translation is failing.'; }
  else if (p.trOk) setNode('n-tr', 'ok', `${status.translator === 'offline' ? 'Offline' : 'Claude'} · ${(p.avgMs / 1000).toFixed(1)} s`);
  else setNode('n-tr', 'warn', status.translator === 'demo' ? 'Demo' : 'Waiting');

  msg.hidden = !advice;
  msg.textContent = advice;
}
setInterval(() => { if (status.running || mic) renderPipe(); }, 1000);

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
const THEMES = { midnight: 'Midnight', aurora: 'Aurora', neon: 'Neon', sunset: 'Sunset', emerald: 'Emerald', gold: 'Gold', light: 'Light', contrast: 'High contrast' };

const THEME_BG = {
  midnight: 'linear-gradient(135deg,#08101f,#16305f,#0e6b8a)', aurora: 'linear-gradient(135deg,#0a1a24,#2c1163,#0b8f7a)',
  neon: 'linear-gradient(135deg,#07040f,#2a0a52,#0a6cff)', sunset: 'linear-gradient(135deg,#1a0a1f,#6b1d4a,#f0742e)', emerald: 'linear-gradient(135deg,#04140f,#0b4a3a,#1fb58a)',
  gold: 'linear-gradient(135deg,#070707,#2b2010,#5c4310)', light: 'linear-gradient(135deg,#f6f8fc,#dbe6f8,#c5dcf5)', contrast: 'linear-gradient(135deg,#000,#000 60%,#ffe600)',
};

function renderSource() {
  const box = $('#source');
  box.replaceChildren();
  const opts = [['auto', 'Auto', '#8b9bbd'], ...Object.values(store.langs).map((l) => [l.code, l.native, l.color])];
  opts.forEach(([code, name, color], i) => {
    const b = document.createElement('button');
    b.dataset.lang = code;
    b.style.setProperty('--lc', color);
    b.innerHTML = '<i class="dot"></i><span></span><kbd></kbd>';
    b.querySelector('span').textContent = name;
    b.querySelector('kbd').textContent = i + 1;
    b.onclick = () => setSource(code);
    box.append(b);
  });
  const th = $('#themes');
  th.replaceChildren();
  for (const [k, name] of Object.entries(THEMES)) {
    const b = document.createElement('button');
    b.dataset.theme = k;
    b.innerHTML = '<i></i><span></span>';
    b.querySelector('i').style.background = THEME_BG[k];
    b.querySelector('span').textContent = name;
    b.onclick = () => patchSettings({ theme: k }, true);
    th.append(b);
  }
  renderLooks();
  const lay = $('#layouts');
  lay.replaceChildren();
  for (const [k, [name, svg]] of Object.entries(LAYOUTS)) {
    const b = document.createElement('button'); b.dataset.layout = k;
    b.innerHTML = `<svg viewBox="0 0 60 48">${svg}</svg>${name}`;
    b.onclick = () => patchSettings({ layout: k }, true);
    lay.append(b);
  }
}

const LOOKS = [
  { name: 'Conference', note: 'Calm and clear', set: { theme: 'midnight', layout: 'stack', dim: 45, uniformSize: true } },
  { name: 'Cinema', note: 'Subtitles over a picture', set: { theme: 'contrast', layout: 'subtitles', dim: 20, uniformSize: true } },
  { name: 'Gala', note: 'Gold, big first language', set: { theme: 'gold', layout: 'focus', dim: 50 } },
  { name: 'Fresh', note: 'Green, side by side', set: { theme: 'emerald', layout: 'columns', dim: 40 } },
  { name: 'Neon night', note: 'Bold and modern', set: { theme: 'neon', layout: 'grid', dim: 45 } },
  { name: 'Sunset', note: 'Warm tones', set: { theme: 'sunset', layout: 'stack', dim: 40 } },
  { name: 'Clean light', note: 'Bright rooms', set: { theme: 'light', layout: 'stack', dim: 30 } },
];

function renderLooks() {
  const box = $('#looks');
  box.replaceChildren();
  for (const l of LOOKS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '<i></i><span></span><small></small>';
    b.querySelector('i').style.background = THEME_BG[l.set.theme];
    b.querySelector('span').textContent = l.name;
    b.querySelector('small').textContent = l.note;
    b.onclick = () => { patchSettings(l.set, true); toast(`Look: ${l.name}`); };
    box.append(b);
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
  fillRanges();
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
  renderJoin();
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
    row.style.setProperty('--lc', L.color);
    row.innerHTML = '<label class="check"><input type="checkbox"></label><span class="nm"></span><button class="btn ghost" data-d="-1" aria-label="Move up"><svg class="ic"><use href="/assets/icons.svg#i-up"/></svg></button><button class="btn ghost" data-d="1" aria-label="Move down"><svg class="ic"><use href="/assets/icons.svg#i-down"/></svg></button>';
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
  renderPhoneLangs();
  $('#lang-warn').textContent = s.screenLangs.length > 4 ? `${s.screenLangs.length} languages at once: text will be smaller. The Grid layout works best with many languages.` : '';
}

function fillRanges() {
  for (const r of $$('input[type=range]')) r.style.setProperty('--p', `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
}

/* Generic bindings for every [data-set] input */
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-set]');
  if (!el || !store.settings) return;
  const k = el.dataset.set;
  const v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
  patchSettings({ [k]: v });
  if (el.type === 'range') el.style.setProperty('--p', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
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
    d.style.setProperty('--lc', L.color);
    d.innerHTML = '<div class="meta"><span class="chip"></span><span>listening…</span></div><div class="src"></div>';
    const chip = d.querySelector('.chip');
    chip.textContent = store.partial.lang.toUpperCase(); chip.style.background = L.color;
    const src = d.querySelector('.src'); src.textContent = store.partial.text; src.dir = L.dir;
    for (const code of store.settings.screenLangs) {
      if (code === store.partial.lang || !store.draft?.[code]) continue;
      const line = document.createElement('div');
      line.className = 'tr pending';
      line.innerHTML = '<b></b><span></span>';
      line.firstChild.textContent = code;
      line.lastChild.textContent = store.draft[code]; line.lastChild.dir = store.langs[code].dir;
      d.append(line);
    }
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
  d.style.setProperty('--lc', L.color);
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
    if (seg.trErr?.[code]) {
      line.className = 'tr err';
      span.textContent = 'Translation failed';
      if (!d.querySelector('.retry')) {
        const b = document.createElement('button');
        b.className = 'retry'; b.type = 'button'; b.textContent = 'Retry';
        b.onclick = () => conn.send({ type: 'retry', id: seg.id });
        d.querySelector('.meta').append(b);
      }
    }
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
  if (ctx.state === 'suspended') await ctx.resume();
  await ctx.audioWorklet.addModule('/assets/audio-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-worklet');
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);
  node.port.onmessage = (e) => {
    if (e.data.pcm) { if (status.running && !['demo', 'browser'].includes(status.engine)) conn.send(e.data.pcm); }
    if (e.data.level !== undefined) {
      waveTarget = Math.min(1, Math.sqrt(e.data.level) * 1.2);
      if (e.data.level > 0.02) lastSound = Date.now();
    }
  };
  mic = { stream, ctx };
  stream.getAudioTracks().forEach((t) => t.addEventListener('ended', onMicEnded));
  listDevices(); // labels become available after permission
}

let micRecovering = false;
/** The microphone disappeared (unplugged, or taken by another program): keep trying to get it back. */
async function onMicEnded() {
  if (!mic || micRecovering) return;
  micRecovering = true;
  toast('The microphone was disconnected. Trying to reconnect…', 'error');
  stopMic();
  for (let i = 0; i < 15 && status.running; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!status.running) break;
    try { await startMic(); toast('The microphone is back.'); break; } catch { /* keep trying */ }
  }
  micRecovering = false;
}

function stopMic() {
  mic?.stream.getTracks().forEach((t) => t.stop());
  mic?.ctx.close();
  mic = null;
  waveTarget = 0;
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
let startedAt = 0;
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
      if (engine === 'deepgram' && !cfg.hasDeepgram) { toast('Add your Deepgram key in Settings first, or use the Offline engine.', 'error'); return; }
      startedAt = Date.now();
      if (engine !== 'demo') await startMic();
      startedAt = Date.now();
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



/* Keyboard shortcuts (ignored while typing) */
addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
  const codes = ['auto', ...Object.keys(store.langs)];
  if (/^[1-9]$/.test(e.key) && codes[Number(e.key) - 1]) setSource(codes[Number(e.key) - 1]);
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
  $('#setup').hidden = cfg.hasDeepgram && cfg.hasAnthropic;
  $('#step-dg').classList.toggle('done', cfg.hasDeepgram);
  $('#step-an').classList.toggle('done', cfg.hasAnthropic);
  let saved = null;
  try { saved = localStorage.getItem('engine'); } catch { /* ignore */ }
  const eng = $('#engine');
  if (!eng.dataset.init) {
    eng.value = [...eng.options].some((o) => o.value === saved) ? saved : 'auto';
    eng.dataset.init = '1';
  }
}

async function loadState() {
  const st = await api('GET', '/state');
  cfg = st.config; net = st.net;
  renderConfig(); renderNet();
}
loadState().catch((e) => toast(e.message, 'error'));

async function saveKeys() {
  const r = await api('PUT', '/config', { deepgramKey: $('#key-dg').value, anthropicKey: $('#key-an').value, model: $('#model').value });
  cfg = r.config; net = r.net;
  const hadKeys = $('#key-dg').value || $('#key-an').value;
  $('#key-dg').value = ''; $('#key-an').value = '';
  renderConfig(); renderNet();
  return hadKeys;
}

function showTest(id, ok, text) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('ok', ok);
  el.classList.toggle('bad', !ok);
}

async function testKey(kind) {
  const out = kind === 'dg' ? '#dg-result' : '#test-result';
  showTest(out, true, 'Testing…');
  try {
    await saveKeys();
    const r = await api('POST', `/config/test/${kind === 'dg' ? 'deepgram' : 'anthropic'}`);
    if (r.ok) showTest(out, true, kind === 'dg' ? 'The key works ✓' : `The key works ✓  "Good evening" → "${r.sample}"`);
    else showTest(out, false, r.error);
  } catch (e) { showTest(out, false, e.message); }
}
$$('.save-keys').forEach((b) => { b.onclick = async () => { try { await saveKeys(); toast('Saved.'); } catch (e) { toast(e.message, 'error'); } }; });
$('#test-dg').onclick = () => testKey('dg');
$('#test-an').onclick = () => testKey('an');
$('#model').onchange = () => saveKeys().catch(() => {});
$$('[data-goto]').forEach((b) => { b.onclick = () => $(`#nav button[data-tab="${b.dataset.goto}"]`).click(); });
$('#try-demo').onclick = () => { $('#engine').value = 'demo'; if (!status.running) toggleListening(); };

$('#copy-diag').onclick = async () => {
  try {
    const d = await api('GET', '/diagnostics');
    d.desktop = desktop ? await desktop.info() : null;
    d.browser = navigator.userAgent;
    d.micActive = !!mic;
    await navigator.clipboard.writeText(JSON.stringify(d, null, 2));
    toast('Diagnostics copied. Paste them into your message.');
  } catch (e) { toast(`Could not copy: ${e.message}`, 'error'); }
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

/* --------------------------------------------------- phones: QR + languages */
function renderJoin() {
  const url = net.joinUrl || store.joinUrl;
  if (!url) return;
  const img = $('#qr');
  const want = `/qr.svg?text=${encodeURIComponent(url)}`;
  if (img.getAttribute('src') !== want) img.src = want;
  $('#join-link').textContent = url;
}
$('#copy-link').onclick = async () => {
  try { await navigator.clipboard.writeText(net.joinUrl || store.joinUrl); toast('Link copied.'); } catch { toast('Copy failed. Select the link and copy it by hand.', 'error'); }
};

function renderPhoneLangs() {
  const s = store.settings;
  const box = $('#phone-langs');
  box.replaceChildren();
  for (const L of Object.values(store.langs)) {
    const label = document.createElement('label');
    const on = s.phoneLangs.includes(L.code);
    label.className = `pick ${on ? 'on' : ''}`;
    label.style.setProperty('--lc', L.color);
    label.innerHTML = '<input type="checkbox"><i class="dot"></i><span></span>';
    label.querySelector('span').textContent = L.native;
    const cb = label.querySelector('input');
    cb.checked = on;
    cb.onchange = () => {
      const next = cb.checked ? [...s.phoneLangs, L.code] : s.phoneLangs.filter((c) => c !== L.code);
      if (!next.length) { cb.checked = true; return; }
      patchSettings({ phoneLangs: next }, true);
    };
    const n = viewers.langs[L.code];
    if (n) { const b = document.createElement('span'); b.className = 'count'; b.textContent = n; label.append(b); }
    box.append(label);
  }
  const total = viewers.phone;
  $('#phone-stats').textContent = total ? `${total} phone${total === 1 ? '' : 's'} connected.` : 'No phones connected yet. The numbers show how many people are reading each language.';
}

/* Phone preview */
function setupPhonePreview() {
  const sel = $('#pv-lang');
  sel.replaceChildren();
  const codes = Object.keys(store.langs);
  for (const c of codes) sel.append(new Option(store.langs[c].native, c));
  for (const c of codes) if (c !== 'en') sel.append(new Option(`${store.langs[c].native} + English`, `${c},en`));
  let cur = 'ar,en';
  try { cur = localStorage.getItem('pvLangs') || 'ar,en'; } catch { /* ignore */ }
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'en';
  const load = () => {
    $('#pv-phone iframe').src = `/join?preview=1&langs=${sel.value}`;
    try { localStorage.setItem('pvLangs', sel.value); } catch { /* ignore */ }
  };
  sel.onchange = load;
  load();
}
let phonePreviewReady = false;
const baseRenderAll = renderAll;
function renderAllWithPhone() {
  baseRenderAll();
  if (!phonePreviewReady && Object.keys(store.langs).length) { phonePreviewReady = true; setupPhonePreview(); }
}

/* ------------------------------------------------------- glossary tab */
// (textarea/input use the generic data-set bindings; nothing else to do)

/* ---------------------------------------------------------- events tab */
async function loadEvents() {
  const list = await api('GET', '/events');
  const box = $('#event-list');
  box.replaceChildren();
  if (!list.length) { const p = document.createElement('p'); p.className = 'empty-note'; p.textContent = 'No saved events yet.'; box.append(p); return; }
  for (const e of list) {
    const d = document.createElement('div');
    d.className = 'ev';
    d.innerHTML = '<div class="pic"></div><div class="info"><b></b><small></small></div><div class="acts"><button class="btn on">Use</button><button class="btn ghost">Delete</button></div>';
    const pic = d.querySelector('.pic');
    if (e.bg) pic.style.backgroundImage = `url("${e.bg}")`;
    if (e.logo) { const img = document.createElement('img'); img.src = e.logo; img.alt = ''; pic.append(img); }
    d.querySelector('b').textContent = e.name;
    d.querySelector('small').textContent = `${e.title || ''} · ${(e.langs || []).join(' ')} · ${new Date(e.savedAt).toLocaleDateString()}`;
    const [use, del] = d.querySelectorAll('button');
    use.onclick = async () => { await api('POST', `/events/${e.id}/load`); toast(`Loaded “${e.name}”.`); };
    del.onclick = async () => { if (confirm(`Delete “${e.name}”?`)) { await api('DELETE', `/events/${e.id}`); loadEvents(); } };
    box.append(d);
  }
}
$('#event-form').onsubmit = async (ev) => {
  ev.preventDefault();
  const name = $('#event-name').value.trim();
  if (!name) return;
  try { await api('POST', '/events', { name }); $('#event-name').value = ''; toast('Event saved.'); loadEvents(); } catch (e) { toast(e.message, 'error'); }
};

/* ------------------------------------------------------ transcript tab */
async function loadSessions() {
  const { current, sessions } = await api('GET', '/sessions');
  const sel = $('#tx-session');
  const keep = sel.value;
  sel.replaceChildren();
  for (const s of sessions) sel.append(new Option(`${new Date(s.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${s.name} · ${s.count} sentences${s.id === current ? ' (current)' : ''}`, s.id));
  sel.value = sessions.some((s) => s.id === keep) ? keep : current;
  const box = $('#tx-langs');
  if (!box.children.length) {
    for (const L of Object.values(store.langs)) {
      const label = document.createElement('label'); label.className = 'pick';
      label.style.setProperty('--lc', L.color);
      label.innerHTML = '<input type="checkbox"><i class="dot"></i><span></span>';
      label.querySelector('span').textContent = L.native;
      const cb = label.querySelector('input'); cb.value = L.code;
      cb.onchange = () => label.classList.toggle('on', cb.checked);
      box.append(label);
    }
  }
  const want = new Set(store.settings.screenLangs);
  if (!box.dataset.init) { box.dataset.init = '1'; box.querySelectorAll('input').forEach((c) => { c.checked = want.has(c.value); c.parentElement.classList.toggle('on', c.checked); }); }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-export]');
  if (!b) return;
  const langs = [...$$('#tx-langs input:checked')].map((c) => c.value);
  if (!langs.length) return toast('Tick at least one language.');
  const url = `/api/sessions/${encodeURIComponent($('#tx-session').value)}/export?format=${b.dataset.export}&langs=${langs.join(',')}&fill=${$('#tx-fill').checked ? 1 : 0}`;
  if (b.dataset.export === 'html') window.open(url, '_blank'); else location.href = url;
  $('#tx-hint').textContent = $('#tx-fill').checked ? 'Preparing… translating missing languages can take up to a minute for long sessions.' : '';
});
$('#nav').addEventListener('click', (e) => {
  const t = e.target.closest('button[data-tab]')?.dataset.tab;
  if (t === 'events') loadEvents().catch((x) => toast(x.message, 'error'));
  if (t === 'transcript' && store.settings) loadSessions().catch((x) => toast(x.message, 'error'));
});

try { const t = localStorage.getItem('tab'); if (t === 'events' || t === 'transcript') setTimeout(() => $(`#nav button[data-tab="${t}"]`)?.click(), 400); } catch { /* ignore */ }

/* ------------------------------------------------------------- live waveform */
const wave = $('#wave');
const wctx = wave.getContext('2d');
const BARS = 64;
const hist = new Array(BARS).fill(0);
let waveTarget = 0;
let waveLevel = 0;
let waveTick = 0;

function drawWave(t) {
  const dpr = window.devicePixelRatio || 1;
  const w = wave.clientWidth;
  const h = 64;
  if (wave.width !== Math.round(w * dpr)) { wave.width = Math.round(w * dpr); wave.height = h * dpr; }
  if (status.running && status.engine === 'demo') waveTarget = store.partial ? 0.28 + 0.3 * Math.abs(Math.sin(t / 140)) * Math.random() * 1.6 : 0.03;
  waveLevel += (waveTarget - waveLevel) * 0.4;
  if ((waveTick += 1) % 2 === 0) { hist.shift(); hist.push(waveLevel); }
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wctx.clearRect(0, 0, w, h);
  const gap = 4;
  const bw = Math.max(2, (w - gap * (BARS - 1)) / BARS);
  const grad = wctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#3b82ff');
  grad.addColorStop(1, '#a06bff');
  for (let i = 0; i < BARS; i += 1) {
    const idle = status.running ? 0 : 0.045 + 0.03 * Math.sin(t / 700 + i / 4);
    const v = Math.max(idle, hist[i]);
    const bh = Math.max(4, v * h * 0.95);
    wctx.fillStyle = grad;
    wctx.globalAlpha = status.running ? 0.55 + 0.45 * (i / BARS) : 0.3;
    const x = i * (bw + gap);
    if (wctx.roundRect) { wctx.beginPath(); wctx.roundRect(x, (h - bh) / 2, bw, bh, bw / 2); wctx.fill(); } else wctx.fillRect(x, (h - bh) / 2, bw, bh);
  }
  wctx.globalAlpha = 1;
  requestAnimationFrame(drawWave);
}
requestAnimationFrame(drawWave);

/* ------------------------------------------------------------- microphone test */
let micTestTimer = 0;
$('#test-mic').onclick = async () => {
  if (status.running) return toast('Stop listening first, then test the microphone.');
  if (mic) { stopMic(); clearTimeout(micTestTimer); $('#test-mic').lastChild.textContent = 'Test'; renderPipe(); return; }
  try {
    lastSound = 0;
    await startMic();
    $('#test-mic').lastChild.textContent = 'Stop test';
    toast('Say something. The bars should move.');
    micTestTimer = setTimeout(() => { if (!status.running) { stopMic(); $('#test-mic').lastChild.textContent = 'Test'; renderPipe(); } }, 20000);
  } catch (e) { toast(e.name === 'NotAllowedError' ? 'Microphone blocked. Allow it and try again.' : e.message, 'error'); }
};

/* ----------------------------------------------------------- desktop app extras */
if (desktop) {
  $('#opt-browser')?.remove(); // the free browser speech engine does not exist inside the desktop app
  (async () => {
    const info = await desktop.info();
    $('#app-version').textContent = `Live Translate ${info.version} · desktop app`;
    $('#open-data').hidden = false;
    $('#open-data').onclick = () => desktop.openDataFolder();
    $('#desktop-card').hidden = false;
    const pick = $('#display-pick');
    const list = await desktop.displays();
    pick.replaceChildren(new Option('A window on this screen', 'window'));
    list.forEach((d) => pick.append(new Option(`${d.label}${d.primary ? ' (main)' : ''} · ${d.width}×${d.height}`, String(d.id))));
    const external = list.find((d) => !d.primary);
    let saved = null;
    try { saved = localStorage.getItem('displayPick'); } catch { /* ignore */ }
    pick.value = [...pick.options].some((o) => o.value === saved) ? saved : external ? String(external.id) : 'window';
    pick.onchange = () => { try { localStorage.setItem('displayPick', pick.value); } catch { /* ignore */ } updateHint(); };
    const updateHint = () => { $('#display-hint').textContent = list.length > 1 ? 'A second screen is connected. Pick it to show the translation full screen there.' : 'Only one screen found. Connect a projector or second monitor and reopen the app to see it here.'; };
    updateHint();
    $('#open-display').onclick = () => desktop.openDisplay(pick.value);
  })();
  document.title = 'Live Translate';
} else {
  $('#app-version').textContent = 'Running in a browser';
}

/* ------------------------------------------------------------- announcements */
const PRESETS = ['Coffee break', 'We start in 5 minutes', 'Please silence your phones', 'Lunch break', 'Thank you for coming!'];
for (const t of PRESETS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = t;
  b.onclick = () => { $('#ann-text').value = t; $('#ann-text').focus(); };
  $('#ann-presets').append(b);
}
$('#ann-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#ann-text').value.trim();
  if (!text) return;
  conn.send({ type: 'announce', text, seconds: Number($('#ann-sec').value) });
  toast('Announcement is on the screens.');
};
$('#ann-hide').onclick = () => conn.send({ type: 'announceClear' });

/* ----------------------------------------------------------------- setup guide */
const wz = { step: 0, last: 4 };
function openWizard(step = 0) {
  wz.step = step;
  $('#wizard').hidden = false;
  try { localStorage.setItem('wizardSeen', '1'); } catch { /* ignore */ }
  renderWizard();
}
function closeWizard() { $('#wizard').hidden = true; if (mic && !status.running) { stopMic(); } }

function renderWizard() {
  $$('.wz-step').forEach((el) => { el.hidden = Number(el.dataset.step) !== wz.step; });
  $('#wz-dots').replaceChildren(...Array.from({ length: wz.last + 1 }, (_, i) => { const d = document.createElement('i'); d.className = i <= wz.step ? 'on' : ''; return d; }));
  $('#wz-back').style.visibility = wz.step > 0 ? 'visible' : 'hidden';
  const haveKey = (wz.step === 1 && cfg.hasDeepgram) || (wz.step === 2 && cfg.hasAnthropic);
  $('#wz-skip').hidden = !(wz.step >= 1 && wz.step <= 3) || haveKey;
  $('#wz-next').textContent = wz.step === 0 ? "Let's start" : wz.step === wz.last ? 'Finish' : 'Next';
  $('#wz-next').disabled = (wz.step === 1 && !cfg.hasDeepgram) || (wz.step === 2 && !cfg.hasAnthropic);
  if (wz.step === 1 || wz.step === 2) {
    const kind = wz.step === 1 ? 'dg' : 'an';
    const res = $(`#wz-${kind}-res`);
    if ((kind === 'dg' ? cfg.hasDeepgram : cfg.hasAnthropic) && !res.textContent) showWz(res, true, '✓ A key is already saved. Paste a new one only if you want to replace it.');
  }
}
function showWz(el, ok, text) { el.textContent = text; el.classList.toggle('ok', ok); el.classList.toggle('bad', !ok); }

async function wzSave(kind) {
  const input = $(`#wz-${kind}`);
  const res = $(`#wz-${kind}-res`);
  const value = input.value.trim();
  if (!value) return showWz(res, false, 'Paste the key into the box first.');
  showWz(res, true, 'Checking…');
  try {
    const r = await api('PUT', '/config', { [kind === 'dg' ? 'deepgramKey' : 'anthropicKey']: value });
    cfg = r.config; input.value = ''; renderConfig();
    const t = await api('POST', `/config/test/${kind === 'dg' ? 'deepgram' : 'anthropic'}`);
    if (t.ok) { showWz(res, true, '✓ It works! The key is saved.'); renderWizard(); setTimeout(() => { if (!$('#wizard').hidden && wz.step === (kind === 'dg' ? 1 : 2)) { wz.step += 1; renderWizard(); } }, 1100); }
    else showWz(res, false, t.error);
  } catch (e) { showWz(res, false, e.message); }
}

$('#wz-next').onclick = () => { if (wz.step >= wz.last) closeWizard(); else { wz.step += 1; renderWizard(); } };
$('#wz-back').onclick = () => { wz.step = Math.max(0, wz.step - 1); renderWizard(); };
$('#wz-skip').onclick = () => { wz.step += 1; renderWizard(); };
$('#wz-close').onclick = closeWizard;
$('#wizard').addEventListener('click', (e) => { if (e.target.id === 'wizard') closeWizard(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#wizard').hidden) closeWizard(); });
$('#wz-mic').onclick = () => $('#test-mic').click();
document.addEventListener('click', (e) => {
  const w = e.target.closest('[data-wizard]');
  if (w) openWizard(Number(w.dataset.wizard));
  const o = e.target.closest('[data-open]');
  if (o) window.open(o.dataset.open, '_blank', 'noopener');
  const sv = e.target.closest('[data-wz-save]');
  if (sv) wzSave(sv.dataset.wzSave);
});
for (const id of ['wz-dg', 'wz-an']) $(`#${id}`).addEventListener('keydown', (e) => { if (e.key === 'Enter') wzSave(id.slice(3)); });

// First time with no keys at all: guide the person straight away.
function maybeAutoGuide() {
  let seen = '';
  try { seen = localStorage.getItem('wizardSeen') || ''; } catch { /* ignore */ }
  const offlineReady = offlineState?.packs?.translation?.installed && (offlineState.packs['speech-fast']?.installed || offlineState.packs['speech-accurate']?.installed);
  if (!seen && !cfg.hasDeepgram && !cfg.hasAnthropic && !offlineReady) openWizard(0);
}
Promise.all([loadState(), loadOffline()]).then(maybeAutoGuide).catch(() => {});

/* small meter inside the guide's microphone step */
const wzWave = $('#wz-wave');
function drawWzWave() {
  if (!$('#wizard').hidden && wz.step === 3) {
    const dpr = window.devicePixelRatio || 1;
    const w = wzWave.clientWidth;
    const h = 56;
    if (wzWave.width !== Math.round(w * dpr)) { wzWave.width = Math.round(w * dpr); wzWave.height = h * dpr; }
    const c = wzWave.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const n = 40;
    const bw = (w - 4 * (n - 1)) / n;
    for (let i = 0; i < n; i += 1) {
      const v = Math.max(0.06, hist[Math.floor((i / n) * hist.length)] || 0);
      c.fillStyle = i / n < waveLevel + 0.02 ? '#3ecf8e' : 'rgba(255,255,255,0.14)';
      const bh = Math.max(5, v * h);
      c.fillRect(i * (bw + 4), (h - bh) / 2, bw, bh);
    }
    $('#wz-mic').lastChild.textContent = mic ? 'Stop test' : 'Test microphone';
  }
  requestAnimationFrame(drawWzWave);
}
requestAnimationFrame(drawWzWave);

/* --------------------------------------------------------------- offline mode */
const mb = (b) => `${Math.round(b / 1e6)} MB`;
function renderOffline() {
  const o = offlineState;
  if (!o) return;
  const box = $('#packs');
  box.replaceChildren();
  for (const [id, p] of Object.entries(o.packs)) {
    const row = document.createElement('div');
    row.className = `pack ${p.installed ? 'ok' : ''}`;
    const busy = o.job && !o.job.done && o.job.pack === id;
    row.innerHTML = '<span class="pk-dot"></span><div class="pk-main"><b></b><small></small><div class="bar" hidden><i></i></div></div><div class="pk-act"></div>';
    row.querySelector('b').textContent = p.label;
    row.querySelector('small').textContent = p.installed ? `Installed ✓ · ${mb(p.bytes)}` : `${mb(p.bytes)} download, once`;
    const act = row.querySelector('.pk-act');
    if (busy) {
      const pct = Math.min(100, Math.round((o.job.received / o.job.total) * 100));
      row.querySelector('.bar').hidden = false;
      row.querySelector('.bar i').style.width = `${pct}%`;
      row.querySelector('small').textContent = `${o.job.phase}… ${pct}% (${mb(o.job.received)} of ${mb(o.job.total)})`;
      const c = document.createElement('button'); c.className = 'btn ghost'; c.textContent = 'Cancel';
      c.onclick = () => api('POST', '/offline/cancel');
      act.append(c);
    } else if (p.installed) {
      const r = document.createElement('button'); r.className = 'btn ghost'; r.textContent = 'Remove';
      r.onclick = async () => { if (confirm(`Remove "${p.label}"? You can download it again later.`)) offlineState = await api('DELETE', `/offline/pack/${id}`), renderOffline(); };
      act.append(r);
    } else {
      const d = document.createElement('button'); d.className = 'btn primary'; d.textContent = 'Download';
      d.disabled = !!(o.job && !o.job.done);
      d.onclick = () => api('POST', '/offline/download', { pack: id });
      act.append(d);
    }
    box.append(row);
  }
  $('#all-packs').hidden = Object.values(o.packs).every((p) => p.installed);
  if (o.job?.done && o.job.error) $('#pack-err').textContent = o.job.error; else $('#pack-err').textContent = '';
  const m = o.memory || {};
  $('#mem-count').textContent = `${m.learned || 0} learned from Claude and your texts · ${m.phrasebook || 0} built-in event phrases`;
  const t = o.teach;
  const tb = $('#teach-go');
  if (t && !t.done) { tb.disabled = true; tb.textContent = `Learning… ${t.finished}/${t.total || '…'}`; }
  else { tb.disabled = false; tb.textContent = 'Learn it with Claude'; }
  $('#teach-res').textContent = t?.done ? (t.error ? t.error : `Learned ${t.sentences} sentences in every language${t.failed ? ` (${t.failed} translations failed)` : ''}. They will be used offline.`) : '';
  const tr = o.translator || {};
  $('#offline-now').textContent = tr.engine === 'offline' ? (tr.internetLost ? 'Internet lost: translating offline right now.' : 'Translating offline right now.') : tr.engine === 'claude' ? (tr.offlineReady ? 'Using Claude now. If the internet drops, it switches to offline by itself.' : 'Using Claude now. Download the translation pack to keep working without internet.') : 'Translation is not set up yet.';
  $('#tmode').value = cfg.translationMode || 'auto';
  $('#squality').value = cfg.speechQuality || 'auto';
}

async function loadOffline() { try { offlineState = await api('GET', '/offline'); renderOffline(); } catch { /* ignore */ } }
loadOffline();
$('#all-packs').onclick = async () => {
  for (const id of ['translation', 'speech-fast', 'speech-accurate']) {
    if (offlineState?.packs[id]?.installed) continue;
    await api('POST', '/offline/download', { pack: id });
    // wait for this pack to finish before starting the next one
    await new Promise((r) => { const t = setInterval(() => { if (!offlineState?.job || offlineState.job.done) { clearInterval(t); r(); } }, 800); });
    if (offlineState?.job?.error) break;
  }
};
$('#tmode').onchange = async () => { const r = await api('PUT', '/config', { translationMode: $('#tmode').value }); cfg = r.config; loadOffline(); };
$('#squality').onchange = async () => { const r = await api('PUT', '/config', { speechQuality: $('#squality').value }); cfg = r.config; };
$('#teach-go').onclick = async () => {
  const text = $('#teach-text').value.trim();
  if (!text) return toast('Paste your speech, agenda or names first.');
  try { const r = await api('POST', '/offline/teach', { text }); toast(`Learning ${r.sentences} sentences…`); } catch (e) { toast(e.message, 'error'); }
};
$('#mem-forget').onclick = async () => { if (confirm('Forget everything learned from Claude and your texts? The built-in phrases stay.')) { offlineState = await api('POST', '/offline/forget'); renderOffline(); } };
$('#try-go').onclick = async () => {
  const out = $('#try-out');
  out.textContent = 'Translating…';
  try {
    const r = await api('POST', '/offline/try', { text: $('#try-text').value });
    out.replaceChildren();
    for (const [l, v] of Object.entries(r.results)) {
      const row = document.createElement('div'); row.className = 'try-row';
      row.innerHTML = '<b></b><span></span><small></small>';
      row.querySelector('b').textContent = l.toUpperCase();
      row.querySelector('span').textContent = v.text || v.error; row.querySelector('span').dir = store.langs[l]?.dir || 'ltr';
      row.querySelector('small').textContent = v.how === 'offline' ? `${v.ms} ms` : v.how ? 'from memory' : '';
      out.append(row);
    }
  } catch (e) { out.textContent = e.message; }
};
