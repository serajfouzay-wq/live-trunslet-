import { connect, Store, applyLook, renderHeader, reconcile, isPortrait } from '/assets/js/common.js';

const $ = (s) => document.querySelector(s);
const lanesEl = $('.lanes');
const origEl = $('.orig');
const qrEl = $('.qr');
const store = new Store();
const laneEls = new Map();
const preview = new URLSearchParams(location.search).has('preview');
let raf = 0;

const conn = connect('display', {
  onMessage: (m) => { store.handle(m); schedule(); },
  onOpen: () => $('.dot').classList.remove('on'),
  onClose: () => $('.dot').classList.add('on'),
});

function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }
window.addEventListener('resize', schedule);

function render() {
  const s = store.settings;
  if (!s) return;
  applyLook(s, { portrait: isPortrait() });
  renderHeader($('.hdr'), s);
  document.body.classList.toggle('blank', s.blank);
  document.body.classList.toggle('labels-off', !s.showLabels);
  renderLanes(s);
  renderOriginal(s);
  renderQR(s);
}

function buildLanes(s) {
  const key = `${s.layout}|${s.screenLangs.join()}`;
  if (lanesEl.dataset.key === key) return;
  lanesEl.dataset.key = key;
  lanesEl.dataset.layout = s.layout;
  lanesEl.dataset.n = s.screenLangs.length;
  lanesEl.style.setProperty('--n', s.screenLangs.length);
  lanesEl.style.setProperty('--rows', Math.ceil(s.screenLangs.length / 2));
  lanesEl.replaceChildren();
  laneEls.clear();
  for (const code of s.screenLangs) {
    const L = store.langs[code];
    if (!L) continue;
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.lang = code;
    lane.dir = L.dir;
    lane.style.setProperty('--lc', L.color);
    lane.innerHTML = '<div class="tag"></div><div class="body"><div class="inner"></div></div>';
    lane.querySelector('.tag').textContent = L.native;
    lanesEl.append(lane);
    laneEls.set(code, lane);
  }
}

function renderLanes(s) {
  buildLanes(s);
  const shown = s.maxLines;
  const sizes = new Map();
  for (const [code, lane] of laneEls) {
    const inner = lane.querySelector('.inner');
    const live = store.partial && store.partial.lang === code;
    const segs = store.segments.slice(-(live ? Math.max(1, shown - 1) : shown));
    const items = [];
    segs.forEach((seg, i) => {
      const text = seg.tr[code] ?? (seg.src === code ? seg.text : '');
      const last = i === segs.length - 1 && !live;
      if (!text && !last) return;
      const done = seg.trDone[code] || seg.src === code;
      items.push({
        key: seg.id,
        text,
        cls: `seg ${last ? 'cur' : 'old'}${!text ? ' pending' : ''}${!done && text ? ' streaming' : ''}`,
        spk: s.showSpeaker ? seg.speaker : '',
      });
    });
    if (live) items.push({ key: 'live', text: store.partial.text, cls: 'seg live cur', spk: s.showSpeaker ? store.partial.speaker && `Speaker ${store.partial.speaker}` : '' });
    reconcile(inner, items);
    sizes.set(lane, fitSize(lane, inner, `${items.map((i) => i.text).join('¶')}|${s.fontScale}|${s.layout}`));
  }
  // Uniform mode: lanes in the same group share the smallest size, so the screen looks calm.
  const lanes = [...laneEls.values()];
  const groups = s.layout === 'focus' && lanes.length > 1 ? [[lanes[0]], lanes.slice(1)] : [lanes];
  for (const g of groups) {
    const common = Math.min(...g.map((l) => sizes.get(l)));
    for (const lane of g) lane.querySelector('.inner').style.fontSize = `${s.uniformSize ? common : sizes.get(lane)}px`;
  }
}

/** Largest font size (px) at which everything in the lane still fits. Cached until content or size changes. */
function fitSize(lane, inner, sig) {
  const body = inner.parentElement;
  const h = body.clientHeight;
  const w = body.clientWidth;
  const full = `${sig}|${w}x${h}`;
  if (lane._fitSig === full) return lane._fit;
  lane._fitSig = full;
  let hi = Math.min(h * 0.6, w * 0.14) * (store.settings.fontScale / 100);
  let lo = 14;
  if (!h || !w) return (lane._fit = lo);
  inner.style.fontSize = `${hi}px`;
  if (inner.offsetHeight > h) {
    while (hi - lo > 1) {
      const mid = (hi + lo) / 2;
      inner.style.fontSize = `${mid}px`;
      if (inner.offsetHeight <= h) lo = mid; else hi = mid;
    }
    hi = lo;
  }
  return (lane._fit = hi);
}

function renderOriginal(s) {
  const p = store.partial;
  const last = store.segments[store.segments.length - 1];
  const src = p ? { lang: p.lang, text: p.text } : last ? { lang: last.src, text: last.text } : null;
  const visible = src && !s.blank && s.showOriginal && !s.screenLangs.includes(src.lang);
  origEl.classList.toggle('on', !!visible);
  if (!visible) return;
  const L = store.langs[src.lang];
  origEl.style.setProperty('--lc', L.color);
  origEl.dir = L.dir;
  origEl.querySelector('b').textContent = L.native;
  origEl.querySelector('span').textContent = src.text;
}

function renderQR(s) {
  qrEl.classList.toggle('on', s.showQR && !!store.joinUrl);
  if (!s.showQR || !store.joinUrl) return;
  qrEl.dataset.pos = s.qrPos;
  const img = qrEl.querySelector('img');
  const want = `/qr.svg?text=${encodeURIComponent(store.joinUrl)}`;
  if (img.getAttribute('src') !== want) img.src = want;
  qrEl.querySelector('small').textContent = store.joinUrl.replace(/^https?:\/\//, '');
}

/* Kiosk niceties: F = full screen, hide the cursor when idle. */
addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
  }
});
let idle;
addEventListener('mousemove', () => {
  document.body.classList.remove('idle-cursor');
  clearTimeout(idle);
  idle = setTimeout(() => document.body.classList.add('idle-cursor'), 2000);
});
if (!preview) {
  const hint = $('.hint');
  setTimeout(() => hint.classList.add('on'), 800);
  setTimeout(() => hint.classList.remove('on'), 5500);
}
