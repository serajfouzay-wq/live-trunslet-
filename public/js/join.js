import { connect, Store, applyLook, renderHeader } from '/assets/js/common.js';

const $ = (s) => document.querySelector(s);
const q = new URLSearchParams(location.search);
const preview = q.has('preview');
const store = new Store();
const cards = new Map();
let lang = null;
let fs = 22;
let showOrig = false;
let stick = true;

const load = (k, d) => { try { return localStorage.getItem(`lt.${k}`) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(`lt.${k}`, v); } catch { /* private mode */ } };

fs = Number(load('fs', 22));
showOrig = load('orig', '0') === '1';
lang = q.get('lang') || (preview ? null : load('lang', null));
document.documentElement.style.setProperty('--fs', `${fs}px`);

const conn = connect('phone', {
  lang,
  preview,
  onMessage(m) {
    const t = store.handle(m);
    if (t === 'hello') {
      if (lang && !store.settings.phoneLangs.includes(lang)) lang = null;
      if (!lang) openPicker(true);
      $('#speak-toggle').hidden = !('speechSynthesis' in window);
      rebuild();
    } else if (t === 'clear') { cards.clear(); $('#feed').replaceChildren(); render(); } else render();
    onEvent?.(t, m);
  },
  onOpen: () => $('#conn').classList.remove('off'),
  onClose: () => $('#conn').classList.add('off'),
});
let onEvent = null;

let raf = 0;
function render() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }

function rebuild() { cards.clear(); $('#feed').replaceChildren(); render(); }

function draw() {
  const s = store.settings;
  if (!s) return;
  const portrait = innerHeight >= innerWidth * 0.9;
  applyLook(s, { portrait: true }); // phones prefer the tall picture
  renderHeader($('.hdr'), s);
  document.body.classList.toggle('no-orig', !showOrig);
  const L = lang && store.langs[lang];
  $('#lang-name').textContent = L ? L.native : 'Language';
  if (L) document.documentElement.style.setProperty('--lc', L.color);
  drawFeed(L);
  drawLive(s, L);
  void portrait;
}

function drawFeed(L) {
  const feed = $('#feed');
  if (!L) return;
  const segs = store.segments.slice(-60);
  const keep = new Set();
  segs.forEach((seg, i) => {
    keep.add(seg.id);
    let c = cards.get(seg.id);
    if (!c) {
      const el = document.createElement('article');
      el.className = 'card';
      el.innerHTML = '<span class="spk" hidden></span><div class="txt"></div><div class="src"></div>';
      c = { el, txt: el.querySelector('.txt'), src: el.querySelector('.src'), spk: el.querySelector('.spk') };
      cards.set(seg.id, c);
      feed.append(el);
    }
    const text = seg.tr[lang] ?? (seg.src === lang ? seg.text : '');
    c.el.dir = L.dir;
    if (c.txt.textContent !== text) c.txt.textContent = text;
    const showSrc = seg.src !== lang;
    c.src.hidden = !showSrc;
    if (showSrc && c.src.textContent !== seg.text) { c.src.textContent = seg.text; c.src.dir = store.langs[seg.src]?.dir || 'ltr'; }
    c.spk.hidden = !seg.speaker || !store.settings.showSpeaker;
    c.spk.textContent = seg.speaker || '';
    const isLast = i === segs.length - 1;
    c.el.classList.toggle('pending', !text);
    c.el.classList.toggle('old', !isLast);
  });
  for (const [id, c] of cards) if (!keep.has(id)) { c.el.remove(); cards.delete(id); }
  if (!segs.length && !feed.querySelector('.empty')) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Waiting for the speaker…';
    feed.append(e);
  } else if (segs.length) feed.querySelector('.empty')?.remove();
  if (stick) feed.scrollTop = feed.scrollHeight;
}

function drawLive(s, L) {
  const el = $('#live-orig');
  const p = store.partial;
  const show = showOrig && p && p.lang !== lang && p.text;
  el.hidden = !show;
  if (show) { el.textContent = p.text; el.dir = store.langs[p.lang]?.dir || 'ltr'; }
  void s; void L;
}

/* Scrolling: stay pinned to the newest text unless the reader scrolls up. */
const feedEl = $('#feed');
feedEl.addEventListener('scroll', () => {
  stick = feedEl.scrollTop + feedEl.clientHeight >= feedEl.scrollHeight - 60;
  $('#jump').hidden = stick;
}, { passive: true });
$('#jump').onclick = () => { stick = true; feedEl.scrollTop = feedEl.scrollHeight; $('#jump').hidden = true; };

/* Language picker */
function guessLang(codes) {
  for (const l of navigator.languages || [navigator.language || 'en']) {
    const c = l.toLowerCase().slice(0, 2);
    if (codes.includes(c)) return c;
  }
  return null;
}

function openPicker(first) {
  const s = store.settings;
  const box = $('#picker-langs');
  box.replaceChildren();
  const guess = guessLang(s.phoneLangs);
  const order = [...s.phoneLangs].sort((a, b) => (a === guess ? -1 : b === guess ? 1 : 0));
  for (const code of order) {
    const L = store.langs[code];
    const b = document.createElement('button');
    b.style.setProperty('--lc', L.color);
    b.classList.toggle('on', code === lang);
    b.innerHTML = '<i></i><span></span><small></small>';
    b.querySelector('span').textContent = L.native;
    b.querySelector('small').textContent = L.name;
    b.onclick = () => choose(code);
    box.append(b);
  }
  $('#picker-sub').textContent = first ? 'You will read everything the speaker says in this language.' : '';
  $('#picker').hidden = false;
}

function choose(code) {
  lang = code;
  conn.lang = code;
  save('lang', code);
  $('#picker').hidden = true;
  conn.send({ type: 'lang', lang: code });
  stick = true;
  rebuild();
  onEvent?.('lang', { lang: code });
}
$('#lang-btn').onclick = () => openPicker(false);
$('#picker').addEventListener('click', (e) => { if (e.target.id === 'picker' && lang) $('#picker').hidden = true; });

/* Text size + original toggle */
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

/* Keep the screen on while reading */
async function keepAwake() {
  try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch { /* not allowed */ }
}
if (!preview) {
  keepAwake();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && keepAwake());
}

/* Hook for optional features (read aloud etc.) */
export function onPhoneEvent(fn) { onEvent = fn; }
export const getLang = () => lang;
export { store, conn };
