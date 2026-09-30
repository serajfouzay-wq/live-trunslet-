// Shared by the big screen (display.js), the phone page (join.js) and previews.

export function connect(role, { lang, preview, onOpen, onMessage, onClose } = {}) {
  let ws;
  let retry = 0;
  const api = {
    lang,
    send(obj) { if (ws?.readyState === 1) ws.send(typeof obj === 'string' || obj instanceof ArrayBuffer ? obj : JSON.stringify(obj)); },
    get open() { return ws?.readyState === 1; },
    get socket() { return ws; },
  };
  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?role=${role}${api.lang ? `&lang=${api.lang}` : ''}${preview ? '&preview=1' : ''}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { retry = 0; onOpen?.(); };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => { onClose?.(); setTimeout(open, Math.min(4000, 400 * ++retry)); };
  }
  open();
  return api;
}

export class Store {
  constructor() {
    this.settings = null;
    this.segments = [];
    this.byId = new Map();
    this.partial = null;
    this.langs = {};
    this.joinUrl = '';
  }
  #add(seg) {
    const old = this.byId.get(seg.id);
    if (old) Object.assign(old, seg); else { this.segments.push(seg); this.byId.set(seg.id, seg); }
    if (this.segments.length > 400) { const gone = this.segments.splice(0, 100); gone.forEach((s) => this.byId.delete(s.id)); }
  }
  /** Applies a server message; returns its type so callers can react. */
  handle(m) {
    switch (m.type) {
      case 'hello':
        this.settings = m.settings; this.langs = m.langs; this.joinUrl = m.joinUrl; this.partial = m.partial;
        this.segments = []; this.byId.clear();
        m.segments.forEach((s) => this.#add(s));
        break;
      case 'segment': case 'segupdate': this.#add(m.seg); break;
      case 'tr': {
        const s = this.byId.get(m.id);
        if (s) { s.tr[m.lang] = m.text; s.trDone[m.lang] = m.done; }
        break;
      }
      case 'partial': this.partial = m.partial; break;
      case 'settings': this.settings = m.settings; break;
      case 'clear': this.segments = []; this.byId.clear(); this.partial = null; break;
      case 'info': this.joinUrl = m.joinUrl; break;
      default: break;
    }
    return m.type;
  }
}

/** Theme, accent, dimming and the right background image for this screen shape. */
export function applyLook(s, { portrait } = {}) {
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.style.setProperty('--accent', s.accent);
  root.style.setProperty('--dim', s.dim);
  root.style.setProperty('--blur', `${s.blur}px`);
  root.style.setProperty('--logo-scale', s.logoSize / 100);
  const img = portrait ? s.bgPortrait || s.bgLandscape : s.bgLandscape || s.bgPortrait;
  const el = document.querySelector('.bg-img');
  if (el) {
    const want = img ? `url("${img}")` : '';
    if (el.dataset.src !== want) { el.dataset.src = want; el.style.backgroundImage = want; }
  }
  document.body.classList.toggle('has-image', !!img);
}

export function renderHeader(el, s) {
  el.hidden = !s.showHeader;
  el.dataset.pos = s.logoPos;
  const sig = `${s.logo}|${s.title}|${s.subtitle}`;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.replaceChildren();
  if (s.logo) {
    const img = document.createElement('img');
    img.className = 'logo'; img.src = s.logo; img.alt = '';
    el.append(img);
  }
  const t = document.createElement('div');
  t.className = 'titles';
  const h = document.createElement('h1'); h.textContent = s.title;
  t.append(h);
  if (s.subtitle) { const p = document.createElement('p'); p.textContent = s.subtitle; t.append(p); }
  if (s.title || s.subtitle) el.append(t);
}

/** Keep `inner`'s children in sync with `items` without re-creating unchanged nodes. */
export function reconcile(inner, items) {
  const existing = new Map();
  for (const el of inner.children) existing.set(el.dataset.k, el);
  items.forEach((it, i) => {
    let el = existing.get(it.key);
    if (!el) { el = document.createElement('p'); el.dataset.k = it.key; }
    existing.delete(it.key);
    if (el.textContent !== it.text) el.textContent = it.text;
    if (el.className !== it.cls) el.className = it.cls;
    if (it.spk) el.dataset.spk = it.spk; else delete el.dataset.spk;
    if (inner.children[i] !== el) inner.insertBefore(el, inner.children[i] || null);
  });
  existing.forEach((el) => el.remove());
}

export const isPortrait = () => window.innerHeight > window.innerWidth * 1.05;
