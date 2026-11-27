// Starts everything and moves between pages.

import { $, icon, debounce, closeMenu, toast } from './ui.js';
import * as player from './player.js';
import * as apple from './apple.js';
import * as youtube from './youtube.js';
import * as spotify from './spotify.js';
import * as library from './library.js';
import * as prefs from './prefs.js';
import * as update from './update.js';
import * as collection from './collection.js';
import * as likes from './likes.js';
import * as backup from './backup.js';
import * as played from './history.js';
import { initDeck, themeNow } from './deck.js';
import { initPresence } from './presence.js';
import { initSystem } from './system.js';
import { routes, notePasted, playlistPanel } from './views.js';
import { get, post } from './api.js';

const scroller = $('scroller');
const viewHost = $('view');
const searchBox = $('q');
const HOME = '#/home';

let view = null;
let viewHash = null;
let viewName = null;
let traversing = false;
const scrollMemory = new Map();

// ---- routing ------------------------------------------------------------------------------------

function parse(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/');
  try {
    const two = parts.slice(0, 2).join('/');
    if (routes[two]) return { name: two, params: parts.slice(2).map(decodeURIComponent) };
    if (routes[parts[0]]) return { name: parts[0], params: parts.slice(1).map(decodeURIComponent) };
  } catch { /* a mangled address falls through to the albums page */ }
  return null;
}

function show() {
  const hash = location.hash || HOME;
  const route = parse(hash);
  if (!route) {
    location.replace(HOME);
    return;
  }

  closeMenu();
  if (view) {
    scrollMemory.set(viewHash, scroller.scrollTop);
    view.destroy?.();
  }
  view = routes[route.name]({ scroller, params: route.params });
  viewHash = hash;
  // Pages rise into view. Typing in the search box redraws one page, which shouldn't flash each time.
  view.el.classList.toggle('arrive', !(route.name === 'search' && viewName === 'search'));
  viewName = route.name;
  viewHost.replaceChildren(view.el);
  // Going back returns to where you were on the page; going somewhere new starts at the top.
  scroller.scrollTop = traversing ? scrollMemory.get(hash) || 0 : 0;
  traversing = false;

  for (const tab of document.querySelectorAll('#tabs a')) {
    if (tab.getAttribute('href') === '#/' + route.name) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  moveInk();
  $('b-settings').classList.toggle('is-here', route.name === 'settings');
  $('b-lyrics').classList.toggle('is-here', route.name === 'lyrics');
  // The welcome is a page of its own: nothing to search or browse to until it is answered.
  document.body.classList.toggle('is-welcoming', route.name === 'welcome');
  $('b-back').disabled = !(window.navigation?.canGoBack ?? history.length > 1);
  // Home is where everything starts, so there is nothing to go back to from it.
  const atHome = route.name === 'home';
  $('b-back').classList.toggle('is-gone', atHome);
  $('b-back').tabIndex = atHome ? -1 : 0;
  $('b-back').toggleAttribute('aria-hidden', atHome);

  if (route.name === 'search') {
    if (document.activeElement !== searchBox) searchBox.value = route.params[0] || '';
  } else if (document.activeElement !== searchBox) {
    searchBox.value = '';
  }
}

window.navigation?.addEventListener('navigate', (e) => { traversing = e.navigationType === 'traverse'; });
window.addEventListener('hashchange', show);

// Tell the open page when its data changed. Bursts (a scan, library pages arriving) are merged.
const refreshSoon = {};
function refresh(why) {
  if (why === 'track') return view?.refresh?.('track');
  refreshSoon[why] ??= debounce(() => view?.refresh?.(why), 140);
  refreshSoon[why]();
}

// ---- top bar ------------------------------------------------------------------------------------

function initTitlebar() {
  const bar = $('titlebar');
  // Integrated frameless titlebar runs on Windows WebView2; Linux ChromeHost keeps its browser window frame.
  if (!bar || window.tintBrowserHost || !window.chrome?.webview) return;
  bar.hidden = false;
  document.documentElement.classList.add('has-titlebar');

  const tell = (action) => window.chrome.webview.postMessage({ to: 'window', do: action });
  const drag = $('tb-drag');
  drag.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.detail >= 2) return;
    tell('drag');
  });
  drag.addEventListener('dblclick', () => tell('max'));
  $('tb-min').addEventListener('click', () => tell('min'));
  $('tb-max').addEventListener('click', () => tell('max'));
  $('tb-close').addEventListener('click', () => tell('close'));

  const maxBtn = $('tb-max');
  const setMax = (on) => {
    maxBtn.setAttribute('aria-label', on ? 'Restore' : 'Maximize');
    maxBtn.title = on ? 'Restore' : 'Maximize';
    maxBtn.innerHTML = on
      ? '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3.5 4.2V2.8a.8.8 0 0 1 .8-.8h4.9a.8.8 0 0 1 .8.8v4.9a.8.8 0 0 1-.8.8H7.8" stroke="currentColor" stroke-width="1.1" fill="none"/><rect x="2" y="4.2" width="5.8" height="5.8" rx=".8" stroke="currentColor" stroke-width="1.15" fill="none"/></svg>'
      : '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1" stroke="currentColor" stroke-width="1.15" fill="none"/></svg>';
  };
  window.chrome.webview.addEventListener('message', ({ data }) => {
    if (data?.is === 'window') setMax(!!data.maximized);
  });
  tell('ready');

  const titleEl = $('tb-title');
  const syncTitle = () => {
    const t = player.current();
    titleEl.textContent = t && player.state.playing ? `${t.title} – ${t.artist}` : 'Tint';
  };
  player.on((kind) => { if (kind === 'track' || kind === 'state') syncTitle(); });
  syncTitle();
}

function initBar() {
  initTitlebar();
  $('b-back').innerHTML = icon('back');
  $('tab-start').innerHTML = icon('home');
  $('b-mini').innerHTML = icon('mini');
  $('b-settings').innerHTML = icon('settings');
  $('search-icon').innerHTML = icon('search');

  $('b-back').addEventListener('click', () => history.back());
  $('b-mini').addEventListener('click', () => post('/api/mini', { on: true }).catch(() => {}));

  const search = debounce(() => {
    const raw = searchBox.value.trim();
    if (openMusicLink(raw, { fromSearch: true })) return;
    const target = '#/search/' + encodeURIComponent(raw);
    // Typing refines one search; it shouldn't leave a trail of history entries.
    if (location.hash.startsWith('#/search')) location.replace(target);
    else location.hash = target;
  }, 260);
  searchBox.addEventListener('input', search);
  searchBox.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { searchBox.value = ''; searchBox.blur(); search(); }
  });
}

/** Unwraps tint:// links and routes Spotify, YouTube Music, or Apple Music URLs into the right Tint page. */
function unwrapTintLink(raw) {
  let s = (raw || '').trim();
  if (!s) return '';
  if (/^tint:/i.test(s)) {
    try {
      const u = new URL(s);
      const param = u.searchParams.get('url') || u.searchParams.get('q');
      if (param) return param.trim();
      const rest = s.replace(/^tint:\/*(open\/?)?/i, '').trim();
      return decodeURIComponent(rest);
    } catch {
      return s.replace(/^tint:\/*/i, '').trim();
    }
  }
  return s;
}

function appleLinkIn(text) {
  let s = (text || '').trim();
  if (/^(music|itmss):\/\//i.test(s)) s = 'https://' + s.replace(/^(music|itmss):\/\//i, '');
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/(^|\.)music\.apple\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i].toLowerCase();
    if (seg === 'playlist') {
      const id = parts.slice(i + 1).reverse().find((p) => /^pl\.[A-Za-z0-9._-]+$/.test(p));
      if (id) return { kind: 'playlist', id };
    }
    if (seg === 'album') {
      const id = parts.slice(i + 1).reverse().find((p) => /^\d+$/.test(p));
      if (id) return { kind: 'album', id };
    }
    if (seg === 'artist') {
      const id = parts.slice(i + 1).reverse().find((p) => /^\d+$/.test(p));
      if (id) return { kind: 'artist', id };
    }
  }
  return null;
}

function spotifyArtistIn(text) {
  const s = (text || '').trim();
  const uri = s.match(/^spotify:artist:([A-Za-z0-9]{22})$/i);
  if (uri) return uri[1];
  try {
    const u = new URL(s);
    if (!/(^|\.)spotify\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/artist\/([A-Za-z0-9]{22})\b/);
    return m ? m[1] : null;
  } catch { return null; }
}

function openMusicLink(raw, { fromSearch = false, notify = false } = {}) {
  const s = unwrapTintLink(raw);
  if (!s) return false;
  const clearBox = () => { if (fromSearch) { searchBox.value = ''; searchBox.blur(); } };

  // YouTube / YouTube Music playlist
  const listed = youtube.playlistIn(s);
  if (listed) {
    clearBox();
    notePasted(listed);
    location.hash = '#/playlist/y/' + encodeURIComponent(listed);
    if (notify) toast('Opened YouTube Music playlist in Tint');
    return true;
  }

  // Spotify playlist, album, artist, or track
  const spotted = spotify.linkIn(s);
  const spottedArtist = !spotted ? spotifyArtistIn(s) : null;
  if (spotted && spotify.isSignedIn() && (spotted.kind === 'playlist' || spotted.kind === 'album')) {
    clearBox();
    location.hash = `#/${spotted.kind}/s/${encodeURIComponent(spotted.id)}`;
    if (notify) toast(`Opened Spotify ${spotted.kind} in Tint`);
    return true;
  }
  if (spottedArtist && spotify.isSignedIn()) {
    clearBox();
    location.hash = `#/artist/s/${encodeURIComponent(spottedArtist)}`;
    if (notify) toast('Opened Spotify artist in Tint');
    return true;
  }

  // Apple Music playlist, album, or artist
  const appleLink = appleLinkIn(s);
  if (appleLink && apple.isSignedIn()) {
    clearBox();
    location.hash = `#/${appleLink.kind}/a/${encodeURIComponent(appleLink.id)}`;
    if (notify) toast(`Opened Apple Music ${appleLink.kind} in Tint`);
    return true;
  }

  // Any other external link (tracks, signed-out Spotify/Apple links, YouTube songs) opens via search.
  if (!fromSearch) {
    location.hash = '#/search/' + encodeURIComponent(s);
    if (notify) toast('Opened link in Tint');
    return true;
  }
  return false;
}

let lastExternalLink = '';
let lastExternalAt = 0;

function isMusicLink(raw) {
  const s = unwrapTintLink(raw);
  if (!s || /^tint:/i.test(s)) return false;
  if (/^spotify:(track|album|playlist|artist):[A-Za-z0-9]{22}$/i.test(s)) return true;
  let norm = s;
  if (/^(music|itmss):\/\//i.test(norm)) norm = 'https://' + norm.replace(/^(music|itmss):\/\//i, '');
  let u;
  try { u = new URL(norm); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'open.spotify.com' || host === 'play.spotify.com' || host === 'spotify.link') return true;
  if (host === 'music.apple.com' || host.endsWith('.music.apple.com')) return true;
  if (host === 'music.youtube.com' || host === 'youtu.be') return true;
  if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
    const p = u.pathname.toLowerCase();
    return p === '/watch' || p === '/playlist';
  }
  return false;
}

function handleExternalLink(raw) {
  const url = (raw || '').trim();
  if (!url) return;
  if (!isMusicLink(url)) {
    toast('Only Spotify, Apple Music, and YouTube Music links can be opened.', { ms: 4000 });
    return;
  }
  const now = Date.now();
  if (url === lastExternalLink && now - lastExternalAt < 1500) return;
  lastExternalLink = url;
  lastExternalAt = now;
  openMusicLink(url, { notify: true });
}

async function checkPendingLink() {
  try {
    const res = await get('/api/pending-link');
    if (res?.url) handleExternalLink(res.url);
  } catch { }
}

function drawAppleTabs() {
  // "Listen now" only makes sense once Apple Music is set up.
  $('tab-home').hidden = apple.getStatus() !== 'ready';
  moveInk();
}

/**
 * Glides the underline to the open page's tab, as wide as the tab's words. On a page without a tab
 * (an album, settings) it fades away, and fades back in place rather than sliding from where it was.
 */
function moveInk() {
  const ink = $('tab-ink');
  const tab = document.querySelector('#tabs a[aria-current="page"]');
  if (!tab || tab.hidden) { ink.classList.remove('is-on'); return; }
  const wasOn = ink.classList.contains('is-on');
  if (!wasOn) ink.classList.add('no-slide');
  const pad = parseFloat(getComputedStyle(tab).paddingLeft) || 0;
  ink.style.width = `${tab.offsetWidth - pad * 2}px`;
  ink.style.translate = `${tab.offsetLeft + pad}px 0`;
  if (!wasOn) {
    void ink.offsetWidth; // takes the new place before transitions return
    ink.classList.remove('no-slide');
  }
  ink.classList.add('is-on');
}
window.addEventListener('resize', () => moveInk());
document.fonts?.ready.then(() => moveInk());

// Keep the app feeling native: block the browser's default right-click menu outside text fields
// and text selections. Cards, songs, lyrics and the deck provide Tint's own context menus.
document.addEventListener('contextmenu', (e) => {
  if (e.defaultPrevented) return;
  const target = e.target;
  if (target?.closest?.('input, textarea, [contenteditable]')) return;
  if (window.getSelection?.()?.toString().trim()) return;
  e.preventDefault();
});

// ---- keyboard -----------------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  const typing = tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox' || tag === 'TEXTAREA' || tag === 'SELECT';

  if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing)) {
    e.preventDefault();
    searchBox.focus();
    searchBox.select();
    return;
  }
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); history.back(); return; }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); history.forward(); return; }
  if (typing) return;

  if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'A' && tag !== 'SUMMARY') {
    e.preventDefault();
    player.toggle();
  } else if (e.ctrlKey && e.key === 'ArrowRight') {
    e.preventDefault();
    player.next();
  } else if (e.ctrlKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    player.prev();
  }
});

// ---- start --------------------------------------------------------------------------------------

async function boot() {
  initBar();
  initDeck({ onAddToPlaylist: playlistPanel });
  await prefs.load().catch(() => {});
  initPresence();
  initSystem();
  player.restore();
  await themeNow();

  library.onChange(() => refresh('local'));
  prefs.onChange(() => refresh('prefs'));
  apple.onChange(() => { drawAppleTabs(); refresh('apple'); });
  youtube.onChange(() => refresh('youtube'));
  spotify.onChange(() => refresh('spotify'));
  update.onChange(() => refresh('update'));
  // Before the page hears of a new song, so Home already lists it.
  played.init();
  collection.onChange(() => refresh('collection'));
  likes.onChange(() => refresh('collection'));
  player.on((kind) => { if (kind === 'track') refresh('track'); });

  await Promise.all([library.start(), youtube.init(), spotify.init(), collection.load()]);
  // A first start opens on the welcome, which asks where the music comes from.
  if (!prefs.prefs.welcomed) history.replaceState(null, '', '#/welcome');
  show();

  // Receive links opened from other apps (via tint://, spotify:, music:, or CLI handoff).
  window.chrome?.webview?.addEventListener('message', ({ data }) => {
    if (data?.is === 'open-link' && data.url) {
      handleExternalLink(data.url);
      get('/api/pending-link').catch(() => {}); // drain queue copy
    }
  });
  window.addEventListener('focus', () => checkPendingLink());
  checkPendingLink();

  // Apple's player loads after the local library is already on screen; warm merged Liked songs too.
  apple.init().then(() => likes.warm());
  likes.warm();
  update.init();
}

// A handle for poking at the app from DevTools.
window.tint = { player, apple, youtube, spotify, library, prefs, update, collection, likes, backup };

boot();
