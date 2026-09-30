import { connect, Store, applyLook, renderHeader } from '/assets/js/common.js';

const $ = (s) => document.querySelector(s);
const q = new URLSearchParams(location.search);
const preview = q.has('preview');
const MAX_LANGS = 4;
const store = new Store();
const cards = new Map();

const load = (k, d) => { try { return localStorage.getItem(`lt.${k}`) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(`lt.${k}`, v); } catch { /* private mode */ } };

let fs = Number(load('fs', 22));
let showOrig = load('orig', '0') === '1';
let stick = true;
let langs = [];
{
  const fromUrl = (q.get('langs') || q.get('lang') || '').split(',').filter(Boolean);
  let saved = [];
  try { saved = JSON.parse(load('langs', '[]')); } catch { /* ignore */ }
  if (!saved.length && load('lang', '')) saved = [load('lang', '')]; // older single-language version
  langs = (fromUrl.length ? fromUrl : preview ? [] : saved).slice(0, MAX_LANGS);
}
document.documentElement.style.setProperty('--fs', `${fs}px`);

const conn = connect('phone', {
  langs,
  preview,
  onMessage(m) {
    const t = store.handle(m);
    if (t === 'hello') {
      langs = langs.filter((l) => store.langs[l] && store.settings.phoneLangs.includes(l));
      conn.langs = langs;
      if (!langs.length) openPicker(true);
      rebuild();
    } else if (t === 'clear') rebuild();
    else render();
    onEvent(t, m);
  },
  onOpen: () => $('#conn').classList.remove('off'),
  onClose: () => $('#conn').classList.add('off'),
});

let raf = 0;
function render() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }
function rebuild() { cards.clear(); $('#feed').replaceChildren(); render(); }

const icon = (name, cls = '') => `<svg class="ic ${cls}"><use href="/assets/icons.svg#i-${name}"/></svg>`;

function draw() {
  const s = store.settings;
  if (!s) return;
  applyLook(s, { portrait: true }); // phones prefer the tall picture
  renderHeader($('.hdr'), s);
  document.body.classList.toggle('no-orig', !showOrig);
  const live = $('#livepill');
  live.classList.toggle('on', !!store.live);
  live.querySelector('span').textContent = store.live ? 'Live' : 'Waiting';
  drawChips();
  drawFeed();
  drawLive();
}

/* ------------------------------------------------------------ language chips */
function drawChips() {
  const box = $('#chips');
  const sig = langs.join();
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.replaceChildren();
  for (const code of langs) {
    const L = store.langs[code];
    if (!L) continue;
    const b = document.createElement('button');
    b.className = 'chip';
    b.style.setProperty('--lc', L.color);
    b.innerHTML = '<i></i><span></span>';
    b.querySelector('span').textContent = L.native;
    b.onclick = () => openPicker(false);
    box.append(b);
  }
  const edit = document.createElement('button');
  edit.className = 'chip edit';
  edit.innerHTML = `${icon('plus')}<span>Languages</span>`;
  edit.onclick = () => openPicker(false);
  box.append(edit);
}

/* ----------------------------------------------------------------- the feed */
function makeCard() {
  const el = document.createElement('article');
  el.className = 'card';
  el.classList.toggle('solo', langs.length === 1);
  el.innerHTML = '<span class="spk" hidden></span>';
  const lines = langs.map((code, i) => {
    const L = store.langs[code];
    const ln = document.createElement('div');
    ln.className = `ln${i === 0 ? ' main' : ''}`;
    ln.dir = L.dir;
    ln.style.setProperty('--lc', L.color);
    ln.innerHTML = '<span class="tag"></span><div class="txt"></div>';
    ln.querySelector('.tag').textContent = L.native;
    el.append(ln);
    return { code, ln, txt: ln.querySelector('.txt') };
  });
  const src = document.createElement('div');
  src.className = 'src';
  src.hidden = true;
  el.append(src);
  return { el, lines, src, spk: el.querySelector('.spk') };
}

function drawFeed() {
  const feed = $('#feed');
  if (!langs.length) return;
  const segs = store.segments.slice(-60);
  const keep = new Set();
  segs.forEach((seg, i) => {
    keep.add(seg.id);
    let c = cards.get(seg.id);
    if (!c) { c = makeCard(); cards.set(seg.id, c); feed.append(c.el); }
    for (const l of c.lines) {
      const text = seg.tr[l.code] ?? (seg.src === l.code ? seg.text : '');
      if (l.txt.textContent !== text) l.txt.textContent = text;
      l.ln.classList.toggle('pending', !text);
    }
    const showSrc = !langs.includes(seg.src);
    c.src.hidden = !showSrc;
    if (showSrc && c.src.textContent !== seg.text) { c.src.textContent = seg.text; c.src.dir = store.langs[seg.src]?.dir || 'ltr'; }
    c.spk.hidden = !seg.speaker || !store.settings.showSpeaker;
    c.spk.textContent = seg.speaker || '';
    c.el.classList.toggle('old', i !== segs.length - 1);
  });
  for (const [id, c] of cards) if (!keep.has(id)) { c.el.remove(); cards.delete(id); }
  const empty = feed.querySelector('.empty');
  if (!segs.length && !empty) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.innerHTML = `${icon('mic')}<div>Waiting for the speaker…</div>`;
    feed.append(e);
  } else if (segs.length) empty?.remove();
  if (stick) feed.scrollTop = feed.scrollHeight;
}

function drawLive() {
  const el = $('#live-orig');
  const p = store.partial;
  const show = showOrig && p && !langs.includes(p.lang) && p.text;
  el.hidden = !show;
  if (show) { el.textContent = p.text; el.dir = store.langs[p.lang]?.dir || 'ltr'; }
}

/* Stay pinned to the newest text unless the reader scrolls up. */
const feedEl = $('#feed');
feedEl.addEventListener('scroll', () => {
  stick = feedEl.scrollTop + feedEl.clientHeight >= feedEl.scrollHeight - 60;
  $('#jump').hidden = stick;
}, { passive: true });
$('#jump').onclick = () => { stick = true; feedEl.scrollTop = feedEl.scrollHeight; $('#jump').hidden = true; };

/* ------------------------------------------------------------ language picker */
let draft = [];

function guessLang(codes) {
  for (const l of navigator.languages || [navigator.language || 'en']) {
    const c = l.toLowerCase().slice(0, 2);
    if (codes.includes(c)) return c;
  }
  return null;
}

function openPicker(first) {
  const s = store.settings;
  draft = langs.length ? [...langs] : [guessLang(s.phoneLangs)].filter(Boolean);
  const box = $('#picker-langs');
  box.replaceChildren();
  for (const code of s.phoneLangs) {
    const L = store.langs[code];
    if (!L) continue;
    const b = document.createElement('button');
    b.className = 'tile';
    b.dataset.lang = code;
    b.style.setProperty('--lc', L.color);
    b.innerHTML = '<i></i><b></b><small></small><span class="num"></span>';
    b.querySelector('b').textContent = L.native;
    b.querySelector('small').textContent = L.name;
    b.onclick = () => toggleDraft(code);
    box.append(b);
  }
  $('#picker-sub').textContent = first
    ? `Pick up to ${MAX_LANGS}. You will read all of them together, the first one biggest.`
    : 'Tap to add or remove. The number is the order: 1 is shown biggest.';
  paintPicker();
  $('#picker').hidden = false;
}

function toggleDraft(code) {
  const i = draft.indexOf(code);
  if (i >= 0) draft.splice(i, 1);
  else if (draft.length < MAX_LANGS) draft.push(code);
  else { $('#picker-sub').textContent = `You can choose up to ${MAX_LANGS} languages. Tap one to remove it first.`; return; }
  paintPicker();
}

function paintPicker() {
  for (const b of $('#picker-langs').children) {
    const i = draft.indexOf(b.dataset.lang);
    b.classList.toggle('on', i >= 0);
    b.querySelector('.num').textContent = i + 1;
  }
  const done = $('#picker-done');
  done.disabled = !draft.length;
  done.textContent = draft.length > 1 ? `Show ${draft.length} languages` : 'Continue';
}

$('#picker-done').onclick = () => {
  if (!draft.length) return;
  langs = [...draft];
  conn.langs = langs;
  save('langs', JSON.stringify(langs));
  $('#picker').hidden = true;
  conn.send({ type: 'lang', langs });
  stick = true;
  rebuild();
  onEvent('lang', {});
};
$('#picker').addEventListener('click', (e) => { if (e.target.id === 'picker' && langs.length) $('#picker').hidden = true; });

/* --------------------------------------------------------- text size + original */
function setSize(n) {
  fs = Math.max(14, Math.min(44, n));
  document.documentElement.style.setProperty('--fs', `${fs}px`);
  save('fs', fs);
  if (stick) feedEl.scrollTop = feedEl.scrollHeight;
}
$('#smaller').onclick = () => setSize(fs - 2);
$('#bigger').onclick = () => setSize(fs + 2);
$('#orig-toggle').setAttribute('aria-pressed', showOrig);
$('#orig-toggle').onclick = () => {
  showOrig = !showOrig;
  $('#orig-toggle').setAttribute('aria-pressed', showOrig);
  save('orig', showOrig ? '1' : '0');
  render();
};

async function keepAwake() {
  try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch { /* not allowed */ }
}
if (!preview) {
  keepAwake();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && keepAwake());
}

/* ---------------------------------------------------------------- read aloud */
// Speaks each finished sentence in the reader's first language, using the phone's own voices.
const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
let speaking = false;
let queued = 0;
const spoken = new Set();

function voiceFor(code) {
  const web = store.langs[code]?.web || code;
  const voices = synth.getVoices();
  return voices.find((v) => v.lang.replace('_', '-') === web) || voices.find((v) => v.lang.toLowerCase().startsWith(code));
}

function say(id) {
  const code = langs[0];
  const seg = store.byId.get(id);
  const text = seg && (seg.tr[code] || (seg.src === code ? seg.text : ''));
  if (!text || spoken.has(id)) return;
  spoken.add(id);
  if (queued >= 3) { synth.cancel(); queued = 0; } // fell behind: skip ahead to the newest sentence
  const u = new SpeechSynthesisUtterance(text);
  u.lang = store.langs[code].web;
  const v = voiceFor(code);
  if (v) u.voice = v;
  u.rate = 1.05;
  u.onend = u.onerror = () => { queued = Math.max(0, queued - 1); };
  queued += 1;
  synth.speak(u);
}

function onEvent(type, m) {
  if (!speaking || !synth) return;
  if (type === 'tr' && m.done && m.lang === langs[0]) say(m.id);
  if (type === 'lang') { synth.cancel(); queued = 0; }
}

const speakBtn = $('#speak-toggle');
if (synth) {
  speakBtn.hidden = false;
  speakBtn.onclick = () => {
    speaking = !speaking;
    speakBtn.setAttribute('aria-pressed', speaking);
    synth.cancel();
    queued = 0;
    if (speaking) {
      synth.speak(new SpeechSynthesisUtterance(' ')); // unlocks audio on iPhones (needs a tap)
      store.segments.forEach((s) => spoken.add(s.id)); // only read what comes next
      if (langs[0] && !voiceFor(langs[0])) speakBtn.title = 'This phone has no voice for this language';
    }
  };
}
