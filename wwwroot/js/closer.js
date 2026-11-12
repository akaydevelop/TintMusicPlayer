// The song playing, up close: its cover as large as the window allows, over a blur of itself, with
// its title (click to copy), artist and album, and a way to save the cover. Opened by clicking the
// cover or title in the now-playing panel; it follows the music if the song changes while open.

import { h, fill, cover, copyText, artAt, artFull, artFallback, closeMenu } from './ui.js';
import * as player from './player.js';
import { artistHref } from './artist.js';
import { post } from './api.js';

let current = null;

export const isOpen = () => !!current;

/** The mini player has no room for this, or for the library: the window is made whole first. */
function leaveMini() {
  if (getComputedStyle(document.getElementById('browse')).display === 'none') post('/api/mini', { on: false }).catch(() => {});
}

function go(hash) {
  leaveMini();
  location.hash = hash;
}

export function open() {
  const first = player.current();
  if (current || !first) return;
  closeMenu();
  leaveMini();
  const returnFocus = document.activeElement;
  const backdrop = h('div', { class: 'closer-backdrop', 'aria-hidden': 'true' });
  const body = h('div', { class: 'closer-body' });
  const closeButton = h('button', { class: 'icon-btn closer-close', icon: 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => close() });
  const el = h('div', { class: 'closer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'The song playing, up close' },
    backdrop, body, closeButton);
  // A click on the empty space around the cover closes it, like a lightbox.
  el.addEventListener('click', (e) => { if (e.target === el || e.target === body || e.target === backdrop) close(); });

  let shownId = null;
  let savedTo = null; // where this song's cover was saved, once it is

  function draw() {
    const track = player.current();
    if (!track) { close(); return; }
    const changed = track.id !== shownId;
    shownId = track.id;
    if (changed) savedTo = null;

    const small = artAt(track.art, 160);
    backdrop.style.backgroundImage = small ? `url("${small}")` : '';
    const big = artAt(track.art, 1000);
    const art = big
      ? h('img', { class: 'closer-img', src: big, alt: `Cover of ${track.album || track.title}`, draggable: false })
      : h('div', { class: 'closer-img is-blank' }, cover(null, 400));
    // Not every video has its big thumbnail; then the small one it was listed with.
    if (big && artFallback(track.art)) art.addEventListener('error', () => { art.src = artFallback(track.art); }, { once: true });

    const saveCover = async (button) => {
      if (savedTo) { post('/api/show-saved-art').catch(() => {}); return; }
      button.disabled = true;
      button.lastChild.textContent = 'Saving…';
      try {
        const name = [track.artist, track.album || track.title].filter(Boolean).join(' - ');
        let { path } = await post('/api/save-art', { url: artFull(track.art), name });
        if (!path && artFallback(track.art)) ({ path } = await post('/api/save-art', { url: artFallback(track.art), name }));
        if (!path) throw new Error();
        savedTo = path;
      } catch {
        button.disabled = false;
        button.lastChild.textContent = "Couldn't save. Try again";
        return;
      }
      draw();
    };

    fill(body,
      h('figure', { class: 'closer-art' + (changed ? ' is-new' : '') }, art),
      h('div', { class: 'closer-text' },
        h('button', {
          class: 'closer-title', title: 'Copy the title',
          onclick: () => copyText(track.title, 'Title copied'),
        }, h('span', {}, track.title), h('span', { class: 'closer-copy', icon: 'copy', 'aria-hidden': 'true' })),
        h('p', { class: 'closer-by' },
          track.artist && h('button', { class: 'closer-link', onclick: () => { close(); go(artistHref(track)); } }, track.artist),
          track.artist && track.album && h('span', { class: 'closer-dot', 'aria-hidden': 'true' }, '·'),
          track.album && (track.albumHref
            ? h('button', { class: 'closer-link', onclick: () => { close(); go(track.albumHref); } }, track.album)
            : h('span', {}, track.album)))),
      h('div', { class: 'closer-actions' },
        track.art && h('button', {
          class: 'btn' + (savedTo ? ' is-done' : ''),
          title: savedTo ? `Saved as ${savedTo}` : 'Save the cover to Pictures\\Tint',
          onclick: (e) => saveCover(e.currentTarget),
        }, h('span', { class: 'btn-icon', icon: savedTo ? 'folder' : 'download' }), h('span', {}, savedTo ? 'Saved · Show in folder' : 'Save cover')),
        h('button', { class: 'btn', onclick: () => copyText(`${track.title}${track.artist ? ' - ' + track.artist : ''}`, 'Title and artist copied') },
          h('span', { class: 'btn-icon', icon: 'copy' }), 'Copy title and artist'),
        h('button', { class: 'btn', onclick: () => { close(); go('#/lyrics'); } },
          h('span', { class: 'btn-icon', icon: 'lyrics' }), 'Lyrics')));
  }

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    // Keyboard focus stays inside while it is open.
    if (e.key === 'Tab') {
      const stops = [...el.querySelectorAll('button:not(:disabled)')];
      const at = stops.indexOf(document.activeElement);
      if (e.shiftKey && at <= 0) { e.preventDefault(); stops.at(-1)?.focus(); }
      else if (!e.shiftKey && at === stops.length - 1) { e.preventDefault(); stops[0]?.focus(); }
    }
  };
  const off = player.on((kind) => { if (kind === 'track') draw(); });

  function close() {
    if (current?.el !== el) return;
    current = null;
    off();
    document.removeEventListener('keydown', onKey, true);
    el.classList.remove('is-open');
    el.classList.add('is-closing');
    setTimeout(() => el.remove(), 260);
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  draw();
  document.addEventListener('keydown', onKey, true);
  document.body.append(el);
  current = { el, close };
  void el.offsetWidth;
  el.classList.add('is-open');
  closeButton.focus({ preventScroll: true });
}

export const close = () => current?.close();
