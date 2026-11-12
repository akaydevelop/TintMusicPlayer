// Starts everything and moves between pages.

import { $, icon, debounce, closeMenu } from './ui.js';
import * as player from './player.js';
import * as apple from './apple.js';
import * as youtube from './youtube.js';
import * as library from './library.js';
import * as prefs from './prefs.js';
import * as update from './update.js';
import * as collection from './collection.js';
import * as backup from './backup.js';
import * as played from './history.js';
import { initDeck, themeNow } from './deck.js';
import { initPresence } from './presence.js';
import { initSystem } from './system.js';
import { routes } from './views.js';
import { post } from './api.js';

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

function initBar() {
  $('b-back').innerHTML = icon('back');
  $('tab-start').innerHTML = icon('home');
  $('b-mini').innerHTML = icon('mini');
  $('b-settings').innerHTML = icon('settings');
  $('search-icon').innerHTML = icon('search');

  $('b-back').addEventListener('click', () => history.back());
  $('b-mini').addEventListener('click', () => post('/api/mini', { on: true }).catch(() => {}));

  const search = debounce(() => {
    // A pasted playlist link opens the playlist, where it can be played and saved.
    const listed = youtube.playlistIn(searchBox.value);
    if (listed) {
      searchBox.value = '';
      searchBox.blur();
      location.hash = '#/playlist/y/' + encodeURIComponent(listed);
      return;
    }
    const target = '#/search/' + encodeURIComponent(searchBox.value.trim());
    // Typing refines one search; it shouldn't leave a trail of history entries.
    if (location.hash.startsWith('#/search')) location.replace(target);
    else location.hash = target;
  }, 260);
  searchBox.addEventListener('input', search);
  searchBox.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { searchBox.value = ''; searchBox.blur(); search(); }
  });
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
  initDeck();
  await prefs.load().catch(() => {});
  initPresence();
  initSystem();
  player.restore();
  await themeNow();

  library.onChange(() => refresh('local'));
  prefs.onChange(() => refresh('prefs'));
  apple.onChange(() => { drawAppleTabs(); refresh('apple'); });
  youtube.onChange(() => refresh('youtube'));
  update.onChange(() => refresh('update'));
  // Before the page hears of a new song, so Home already lists it.
  played.init();
  collection.onChange(() => refresh('collection'));
  player.on((kind) => { if (kind === 'track') refresh('track'); });

  await Promise.all([library.start(), youtube.init(), collection.load()]);
  // A first start opens on the welcome, which asks where the music comes from.
  if (!prefs.prefs.welcomed) history.replaceState(null, '', '#/welcome');
  show();

  // Apple's player loads after the local library is already on screen.
  apple.init();
  update.init();
}

// A handle for poking at the app from DevTools.
window.tint = { player, apple, youtube, library, prefs, update, collection, backup };

boot();
