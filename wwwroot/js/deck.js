// The now-playing column: cover, transport, and the line of songs coming up.
// It also owns the theme, because the theme is whatever the current cover says it is.

import * as player from './player.js';
import { englishTitle } from './apple.js';
import { prefs, onChange as onPrefs } from './prefs.js';
import { post } from './api.js';
import { $, h, icon, fmtTime, artSrc, cover, toast, replay, showMenu } from './ui.js';
import { linkFor, share } from './youtube.js';
import { paletteOf, themeFrom, applyTheme, IDLE_THEME } from './palette.js';

const QUEUE_ROWS = 80;
// The little mark beside the artist that says where the song is playing from.
const FROM = {
  local: { icon: 'pc', label: 'Playing from this PC' },
  apple: { icon: 'apple', label: 'Playing from Apple Music' },
  youtube: { icon: 'youtube', label: 'Playing from YouTube Music' },
};
const WHEEL_NOTCH = 100;  // what one click of a mouse wheel reports
const WHEEL_STEP = 0.05;  // how much volume that click is worth
const GLIDE_MS = 240;

const stillMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const els = {};
let scrubbing = false;
let shownArt = null;
let shownSong = null;
let shownPlaying = null;
let shownError = null;
let themedFor = null;
let queueHead = null;    // the song that was first in line when the queue was last drawn
let volumeShown = null;  // where the volume slider is drawn, on its way to the real level
let volumeFrame = 0;
let volumeByHand = false;

export function initDeck() {
  for (const id of ['deck-art', 'deck-title', 'deck-title-english', 'deck-source', 'deck-artist', 'seek', 't-now', 't-format', 't-left', 'b-shuffle', 'b-prev', 'b-play',
    'b-next', 'b-repeat', 'b-mute', 'vol', 'b-expand', 'b-clear', 'queue', 'queue-empty', 'b-share', 'b-lyrics']) els[id] = $(id);

  els['b-prev'].innerHTML = icon('prev');
  els['b-next'].innerHTML = icon('next');
  els['b-shuffle'].innerHTML = icon('shuffle');
  els['b-expand'].innerHTML = icon('expand');
  els['b-share'].innerHTML = icon('share');
  els['b-lyrics'].innerHTML = icon('lyrics');
  els['b-lyrics'].addEventListener('click', () => {
    if (location.hash === '#/lyrics') {
      if (history.length > 1) history.back(); else location.hash = '#/albums';
      return;
    }
    // The mini player has no room for the page, so the window opens up first.
    if (getComputedStyle($('browse')).display === 'none') post('/api/mini', { on: false }).catch(() => {});
    location.hash = '#/lyrics';
  });
  // A song from Apple Music or this PC is looked up on YouTube Music when the pointer comes near,
  // so the link is usually there by the click (the clipboard only takes it soon after one).
  const lookAhead = () => { const track = player.current(); if (track) linkFor(track).catch(() => {}); };
  els['b-share'].addEventListener('pointerenter', lookAhead);
  els['b-share'].addEventListener('focus', lookAhead);
  els['b-share'].addEventListener('click', () => { const track = player.current(); if (track) share(track); });

  els['b-play'].addEventListener('click', player.toggle);
  els['b-prev'].addEventListener('click', player.prev);
  els['b-next'].addEventListener('click', player.next);
  els['b-shuffle'].addEventListener('click', () => player.setShuffle(!player.state.shuffle));
  els['b-repeat'].addEventListener('click', player.cycleRepeat);
  els['b-clear'].addEventListener('click', player.clearUpcoming);
  els['b-expand'].addEventListener('click', () => post('/api/mini', { on: false }).catch(() => {}));
  // Right-clicking the song playing offers its YouTube Music link too.
  for (const part of [els['deck-art'], els['deck-title'].closest('.deck-text')]) {
    part.addEventListener('contextmenu', (e) => {
      const track = player.current();
      if (!track) return;
      e.preventDefault();
      linkFor(track).catch(() => {});
      showMenu(e.clientX, e.clientY, [{ label: 'Share YouTube Music link', run: () => share(track) }]);
    });
  }
  els['b-mute'].addEventListener('click', () => player.setVolume(player.state.volume || 0.5, { muted: !player.state.muted }));

  const seek = els.seek;
  seek.addEventListener('pointerdown', () => { scrubbing = true; });
  seek.addEventListener('input', () => {
    scrubbing = true;
    drawTime((seek.value / 1000) * player.state.duration);
  });
  seek.addEventListener('change', () => {
    scrubbing = false;
    player.seek((seek.value / 1000) * player.state.duration);
  });

  els.vol.addEventListener('input', () => {
    // The slider is already where the pointer put it, so it mustn't glide there as well.
    volumeByHand = true;
    player.setVolume(els.vol.value / 100);
    volumeByHand = false;
  });
  // The wheel works anywhere on the volume row, not only on the thin line of the slider.
  els.vol.closest('.volume').addEventListener('wheel', (e) => {
    e.preventDefault();
    // A mouse wheel moves in whole notches. A touchpad sends many small amounts, which add up the same way.
    const notches = -e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 100 / 3 : 1) / WHEEL_NOTCH;
    const { volume, muted } = player.state;
    if (!notches || (muted && notches < 0)) return;
    // Scrolling up from mute climbs from silence instead of jumping back to the old level.
    player.setVolume(Math.round(((muted ? 0 : volume) + notches * WHEEL_STEP) * 1000) / 1000);
  }, { passive: false });

  player.on((kind) => {
    if (kind === 'track') { drawTrack(); drawQueue(); drawTime(player.state.time); }
    else if (kind === 'state') drawState();
    else if (kind === 'time') { if (!scrubbing) drawTime(player.state.time); }
    else if (kind === 'queue') drawQueue();
    else if (kind === 'modes') drawModes();
    else if (kind === 'volume') drawVolume();
  });
  onPrefs(() => { themedFor = null; retheme(); });

  drawTrack(); drawState(); drawModes(); drawVolume(); drawQueue(); drawTime(0);
}

// ---- theme --------------------------------------------------------------------------------------

async function retheme({ instant = false } = {}) {
  const track = player.current();
  const key = (track ? artSrc(track.art, 48) : null) + '|' + prefs.keepDark;
  if (key === themedFor) return;
  themedFor = key;
  const palette = track ? await paletteOf(track.art) : null;
  if (themedFor !== key) return; // the song changed while the cover was loading
  applyTheme(palette ? themeFrom(palette, { keepDark: prefs.keepDark }) : IDLE_THEME, { instant });
}

/** Themes the window before first paint settles, so a restored queue doesn't flash the idle colours. */
export const themeNow = () => retheme({ instant: true });

// ---- drawing ------------------------------------------------------------------------------------

function drawTrack() {
  const track = player.current();
  els['deck-title'].textContent = track ? track.title : 'Nothing playing';
  els['deck-artist'].textContent = track ? track.artist : 'Choose an album or a song to start.';
  els['deck-title'].title = track ? track.title : '';
  els['b-share'].hidden = !track;
  els['b-lyrics'].hidden = !track;
  const secondary = els['deck-title-english'];
  secondary.textContent = '';
  secondary.hidden = true;
  if (track) englishTitle(track).then((name) => {
    if (player.current() !== track || !name) return;
    secondary.textContent = name;
    secondary.title = name;
    secondary.hidden = false;
  });
  els.seek.disabled = !track;

  const from = FROM[track?.source];
  els['deck-source'].hidden = !from;
  els['deck-source'].innerHTML = from ? icon(from.icon) : '';
  els['deck-source'].title = from?.label || '';
  els['deck-source'].setAttribute('aria-label', from?.label || '');
  if ((track?.id ?? null) !== shownSong) {
    shownSong = track?.id ?? null;
    replay(els['deck-title'].closest('.deck-meta'), 'arrive');
  }

  const src = track ? artSrc(track.art, 320) : null;
  if (src !== shownArt) {
    shownArt = src;
    const box = els['deck-art'];
    const old = box.querySelector('img');
    if (src) {
      const img = h('img', { alt: '', draggable: false, class: 'is-entering' });
      img.addEventListener('load', () => {
        img.classList.remove('is-entering');
        if (old) setTimeout(() => old.remove(), 600);
      }, { once: true });
      img.addEventListener('error', () => { img.remove(); old?.remove(); box.classList.remove('has-art'); }, { once: true });
      img.src = src;
      box.append(img);
      box.classList.add('has-art');
    } else {
      old?.remove();
      box.classList.remove('has-art');
    }
  }
  retheme();
}

function drawState() {
  const { playing, loading, error } = player.state;
  const btn = els['b-play'];
  // The icon pops in when it is put there, so it is only replaced when it really changes.
  if (playing !== shownPlaying) {
    shownPlaying = playing;
    btn.innerHTML = icon(playing ? 'pause' : 'play');
  }
  btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  btn.title = playing ? 'Pause' : 'Play';
  btn.classList.toggle('is-loading', loading && !playing);
  btn.disabled = !player.current();
  document.documentElement.classList.toggle('is-playing', playing);
  // Between two songs nothing is playing for a moment, which isn't the same as being paused.
  document.documentElement.classList.toggle('is-paused', !!player.current() && !playing && !loading);

  // YouTube offers different audio to different listeners, so say which one is playing.
  const { format } = player.state;
  els['t-format'].textContent = format ? `${format.codec} ${format.kbps} kbps` : '';
  els['t-format'].title = format ? 'What YouTube is sending for this song' : '';

  if (error && error !== shownError) toast(error, { ms: 5000 });
  shownError = error;
}

function drawTime(time) {
  const duration = player.state.duration || 0;
  const ratio = duration ? Math.min(1, time / duration) : 0;
  if (!scrubbing) els.seek.value = Math.round(ratio * 1000);
  els.seek.style.setProperty('--fill', (scrubbing ? els.seek.value / 10 : ratio * 100) + '%');
  els['t-now'].textContent = fmtTime(time);
  els['t-left'].textContent = duration ? '-' + fmtTime(Math.max(0, duration - time)) : '0:00';
}

function drawModes() {
  const { shuffle, repeat } = player.state;
  els['b-shuffle'].setAttribute('aria-pressed', String(shuffle));
  els['b-repeat'].innerHTML = icon(repeat === 'one' ? 'repeatOne' : 'repeat');
  els['b-repeat'].setAttribute('aria-pressed', String(repeat !== 'off'));
  const label = repeat === 'one' ? 'Repeating this song' : repeat === 'all' ? 'Repeating the queue' : 'Repeat';
  els['b-repeat'].title = label;
  els['b-repeat'].setAttribute('aria-label', label);
}

function drawVolume() {
  const { volume, muted } = player.state;
  glideVolume({ thumb: volume * 100, fill: muted ? 0 : volume * 100 });
  els['b-mute'].innerHTML = icon(muted || volume === 0 ? 'mute' : volume < 0.5 ? 'volumeLow' : 'volume');
  els['b-mute'].setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  els['b-mute'].title = muted ? 'Unmute' : 'Mute';
}

/** Moves the volume slider to a new level with a short ease-out, so wheel steps don't jump. */
function glideVolume(to) {
  cancelAnimationFrame(volumeFrame);
  const from = volumeShown;
  const paint = (at) => {
    volumeShown = at;
    if (!volumeByHand) els.vol.value = Math.round(at.thumb);
    els.vol.style.setProperty('--fill', at.fill + '%');
  };
  if (!from || volumeByHand || stillMotion.matches) return paint(to);

  const began = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - began) / GLIDE_MS);
    const eased = t === 1 ? 1 : 1 - 2 ** (-10 * t);
    paint({ thumb: from.thumb + (to.thumb - from.thumb) * eased, fill: from.fill + (to.fill - from.fill) * eased });
    if (t < 1) volumeFrame = requestAnimationFrame(step);
  };
  volumeFrame = requestAnimationFrame(step);
}

function drawQueue() {
  const { queue, index } = player.state;
  const upcoming = queue.slice(index + 1, index + 1 + QUEUE_ROWS);
  const rows = upcoming.map((track, offset) => {
    const at = index + 1 + offset;
    return h('li', {},
      h('button', { class: 'q-row', onclick: () => player.jumpTo(at), title: `Play ${track.title}` },
        cover(track.art, 36),
        h('span', { class: 'q-text' },
          h('span', { class: 'q-title' }, track.title),
          h('span', { class: 'q-artist' }, track.artist))),
      h('button', { class: 'icon-btn small q-remove', icon: 'close', 'aria-label': `Remove ${track.title} from the queue`, title: 'Remove', onclick: () => player.removeAt(at) }));
  });
  const more = queue.length - (index + 1) - upcoming.length;
  if (more > 0) rows.push(h('li', { class: 'q-more quiet' }, `and ${more.toLocaleString()} more`));

  // When the song at the head of the line becomes the one playing, the rest move up a place.
  const movedUp = queueHead !== null && queueHead === player.current();
  queueHead = queue[index + 1] || null;

  els.queue.replaceChildren(...rows);
  if (movedUp && rows.length) replay(els.queue, 'shift');
  else els.queue.classList.remove('shift');
  els['queue-empty'].hidden = rows.length > 0;
  els['b-clear'].hidden = rows.length === 0;
}
