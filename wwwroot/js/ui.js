// Small DOM helpers shared by every view. Text always goes in as text nodes, never as markup,
// because titles and artist names come from files and from Apple's servers.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'icon') el.innerHTML = icon(value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid);
  }
  return el;
}

/** Replaces an element's children. Accepts nested lists and skips empty slots, like `h` does. */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((kid) => kid != null && kid !== false));
  return el;
}

export const $ = (id) => document.getElementById(id);

const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  play: '<path d="M8 5.6v12.8a1 1 0 0 0 1.52.85l10.4-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6z"/>',
  pause: '<rect x="6.2" y="5" width="4.3" height="14" rx="1.3"/><rect x="13.5" y="5" width="4.3" height="14" rx="1.3"/>',
  next: '<path d="M5 6.4v11.2a.9.9 0 0 0 1.4.75l8.5-5.6a.9.9 0 0 0 0-1.5L6.4 5.65A.9.9 0 0 0 5 6.4z"/><rect x="16.6" y="5.5" width="2.6" height="13" rx="1.1"/>',
  prev: '<path d="M19 6.4v11.2a.9.9 0 0 1-1.4.75l-8.5-5.6a.9.9 0 0 1 0-1.5l8.5-5.6a.9.9 0 0 1 1.4.75z"/><rect x="4.8" y="5.5" width="2.6" height="13" rx="1.1"/>',
  shuffle: `<g ${STROKE}><path d="M3 7h3.2c1.8 0 3 .8 4 2.3l3.6 5.4c1 1.5 2.2 2.3 4 2.3H21"/><path d="M18.2 14.2 21 17l-2.8 2.8"/><path d="M3 17h3.2c1.2 0 2.2-.4 3-1.1"/><path d="M21 7h-3.2c-1.2 0-2.2.4-3 1.1"/><path d="M18.2 4.2 21 7l-2.8 2.8"/></g>`,
  repeat: `<g ${STROKE}><path d="M17 3.5 20 6.5l-3 3"/><path d="M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H20"/><path d="M7 20.5 4 17.5l3-3"/><path d="M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H4"/></g>`,
  repeatOne: `<g ${STROKE}><path d="M17 3.5 20 6.5l-3 3"/><path d="M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H20"/><path d="M7 20.5 4 17.5l3-3"/><path d="M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H4"/><path d="M11.3 10.6l1.3-.9v4.8" stroke-width="1.6"/></g>`,
  volume: `<path d="M4 9.6h2.8L11 6.2a.6.6 0 0 1 1 .46v10.68a.6.6 0 0 1-1 .46L6.8 14.4H4a.8.8 0 0 1-.8-.8v-3.2a.8.8 0 0 1 .8-.8z"/><g ${STROKE}><path d="M15.3 9.2a4 4 0 0 1 0 5.6"/><path d="M17.9 6.6a7.6 7.6 0 0 1 0 10.8"/></g>`,
  volumeLow: `<path d="M4 9.6h2.8L11 6.2a.6.6 0 0 1 1 .46v10.68a.6.6 0 0 1-1 .46L6.8 14.4H4a.8.8 0 0 1-.8-.8v-3.2a.8.8 0 0 1 .8-.8z"/><g ${STROKE}><path d="M15.3 9.2a4 4 0 0 1 0 5.6"/></g>`,
  mute: `<path d="M4 9.6h2.8L11 6.2a.6.6 0 0 1 1 .46v10.68a.6.6 0 0 1-1 .46L6.8 14.4H4a.8.8 0 0 1-.8-.8v-3.2a.8.8 0 0 1 .8-.8z"/><g ${STROKE}><path d="m15.5 9.5 5 5"/><path d="m20.5 9.5-5 5"/></g>`,
  search: `<g ${STROKE}><circle cx="11" cy="11" r="6.2"/><path d="m15.8 15.8 4.2 4.2"/></g>`,
  settings: `<g ${STROKE}><path d="M4 7.5h8"/><path d="M17 7.5h3"/><circle cx="14.5" cy="7.5" r="2.3"/><path d="M4 16.5h3"/><path d="M12 16.5h8"/><circle cx="9.5" cy="16.5" r="2.3"/></g>`,
  back: `<g ${STROKE}><path d="M14.5 5.5 8 12l6.5 6.5"/></g>`,
  more: '<circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/>',
  close: `<g ${STROKE}><path d="m6.5 6.5 11 11"/><path d="m17.5 6.5-11 11"/></g>`,
  mini: `<g ${STROKE}><rect x="3.5" y="5" width="17" height="14" rx="2.5"/></g><rect x="11.5" y="11.5" width="6.5" height="5" rx="1.2"/>`,
  expand: `<g ${STROKE}><path d="M9.5 4.5h-5v5"/><path d="M4.5 4.5 10 10"/><path d="M14.5 19.5h5v-5"/><path d="M19.5 19.5 14 14"/></g>`,
  folder: `<g ${STROKE}><path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></g>`,
  note: `<g ${STROKE}><path d="M9.5 17.5V6l9-2v11.5"/></g><circle cx="7" cy="17.5" r="2.6"/><circle cx="16" cy="15.5" r="2.6"/>`,
  // Where a song comes from: a screen for this PC, an apple, and a play button in a rounded box.
  pc: `<g ${STROKE}><rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/><path d="M12 16v3.5"/><path d="M8.5 19.5h7"/></g>`,
  apple: '<path d="M12 8.3c-1.2-.9-2.6-1.2-3.9-.7C6 8.400 4.800 10.500 5 13c.2 2.900 2.100 6 4.200 6 1 0 1.700-.6 2.800-.6s1.800.6 2.800.6c2.100 0 4-3.100 4.200-6 .2-2.500-1-4.600-3.100-5.400-1.300-.5-2.700-.2-3.900.7z"/><path d="M12.200 6.900c0-1.700 1.300-3.200 3-3.400.1 1.800-1.200 3.300-3 3.400z"/>',
  youtube: '<path fill-rule="evenodd" d="M6.500 5.500h11a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4h-11a4 4 0 0 1-4-4v-5a4 4 0 0 1 4-4zm3.700 3.600v5.800l5.100-2.900z"/>',
};

export function icon(name) {
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60), m = Math.floor(seconds / 60) % 60, hrs = Math.floor(seconds / 3600);
  const ss = String(s).padStart(2, '0');
  return hrs ? `${hrs}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "42 minutes", "1 hour 5 minutes" — for album and playlist summaries. */
export function fmtLength(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hrs = Math.floor(minutes / 60), mins = minutes % 60;
  const part = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (!hrs) return part(mins, 'minute');
  return mins ? `${part(hrs, 'hour')} ${part(mins, 'minute')}` : part(hrs, 'hour');
}

export const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Plays a CSS entrance animation from the start on an element that is already on the page. */
export function replay(el, name) {
  el.classList.remove(name);
  void el.offsetWidth; // makes the browser notice the class went away before it comes back
  el.classList.add(name);
}

// ---- artwork ------------------------------------------------------------------------------------

const DPR = Math.min(2, window.devicePixelRatio || 1);

/** The URL of an artwork at roughly `size` CSS pixels. Local art comes in three cached sizes. */
export function artSrc(art, size) {
  if (!art) return null;
  const px = Math.round(size * DPR);
  if (art.key) return `art/${art.key}?s=${px <= 128 ? 96 : px <= 400 ? 320 : 640}`;
  if (art.url) {
    const snapped = px <= 80 ? 80 : px <= 160 ? 160 : px <= 320 ? 320 : px <= 480 ? 480 : 720;
    return art.url.replace('{w}', snapped).replace('{h}', snapped).replace('{f}', 'jpg').replace('{c}', 'bb');
  }
  return null;
}

/** A square cover image, or a quiet placeholder when there is no artwork. */
export function cover(art, size, { lazy = true } = {}) {
  const box = h('span', { class: 'cover' });
  const src = artSrc(art, size);
  if (src) {
    const img = h('img', { alt: '', decoding: 'async', draggable: false });
    if (lazy) img.loading = 'lazy';
    img.addEventListener('error', () => { img.remove(); box.classList.add('is-blank'); box.innerHTML = icon('note'); }, { once: true });
    img.src = src;
    box.append(img);
  } else {
    box.classList.add('is-blank');
    box.innerHTML = icon('note');
  }
  return box;
}

// ---- toast --------------------------------------------------------------------------------------

export function toast(message, { ms = 3200 } = {}) {
  const host = $('toasts');
  const el = h('div', { class: 'toast' }, message);
  host.append(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

// ---- menu ---------------------------------------------------------------------------------------

let openMenu = null;

export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

/** Shows a small menu at a point. `items` is a list of { label, run } (falsy entries are skipped). */
export function showMenu(x, y, items) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' },
    items.filter(Boolean).map((item) => h('button', {
      role: 'menuitem',
      onclick: () => { closeMenu(); item.run(); },
    }, item.label)));
  document.body.append(menu);
  // Measured by layout size: the menu is still growing into place, so it is drawn smaller than it is.
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  openMenu = menu;
  menu.querySelector('button')?.focus();
}

document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

// ---- virtual list -------------------------------------------------------------------------------

/**
 * Renders only the rows near the viewport, so a library of ten thousand songs costs the same as
 * one of fifty. Rows share a fixed height.
 */
export class VirtualList {
  constructor({ scroller, rowHeight, count, render, className = '' }) {
    this.scroller = scroller;
    this.rowHeight = rowHeight;
    this.count = count;
    this.render = render;
    this.el = h('div', { class: 'vlist ' + className, role: 'list' });
    this.inner = h('div', { class: 'vlist-inner' });
    this.el.append(this.inner);
    this.el.style.height = count * rowHeight + 'px';
    this.from = -1;
    this.to = -1;
    this.frame = 0;
    this.onScroll = () => {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
    };
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onScroll);
    requestAnimationFrame(() => this.update());
  }

  setCount(count) {
    this.count = count;
    this.el.style.height = count * this.rowHeight + 'px';
    this.update(true);
  }

  update(force = false) {
    if (!this.el.isConnected) return;
    const top = this.el.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top;
    const viewport = this.scroller.clientHeight;
    const overscan = 6;
    const from = Math.max(0, Math.floor(-top / this.rowHeight) - overscan);
    const to = Math.min(this.count, Math.ceil((viewport - top) / this.rowHeight) + overscan);
    if (!force && from === this.from && to === this.to) return;
    this.from = from;
    this.to = to;
    const rows = [];
    for (let i = from; i < to; i++) rows.push(this.render(i));
    this.inner.style.transform = `translateY(${from * this.rowHeight}px)`;
    this.inner.replaceChildren(...rows);
  }

  refresh() { this.update(true); }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.scroller.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('resize', this.onScroll);
  }
}
