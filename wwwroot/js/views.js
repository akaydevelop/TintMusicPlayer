// Every page in the browsing pane. A view is a function that returns { el, refresh?, destroy? }.
// `refresh` is called when the data behind the page changes (a scan finished, more of the Apple
// Music library arrived, a different song started).

import { h, fill, cover, fmtTime, fmtLength, plural, showMenu, showPopover, closeMenu, toast, replay, copyText, VirtualList, VirtualGrid } from './ui.js';
import * as player from './player.js';
import * as apple from './apple.js';
import * as youtube from './youtube.js';
import * as spotify from './spotify.js';
import * as collection from './collection.js';
import * as likes from './likes.js';
import * as history from './history.js';
import * as pagecache from './pagecache.js';
import * as backup from './backup.js';
import * as update from './update.js';
import { local, compareText, searchLocal, nudge } from './library.js';
import { get, post } from './api.js';
import { prefs, save as savePrefs } from './prefs.js';
import { LANGUAGES, lyricsFor, translationOf } from './lyrics.js';
import { hasJapanese, romanize } from './romaji.js';
import { profile as artistProfile, artistHref } from './artist.js';

const ROW = 52;

// Choices that should survive moving between pages (but not a restart).
const memory = { albumSource: 'all', albumSort: 'artist', songSource: 'all', songSort: 'artist', playlistSource: 'all', playlistTag: null };

// ---- shared pieces ------------------------------------------------------------------------------

function pageHead(title, summary, ...controls) {
  return h('header', { class: 'page-head' },
    h('div', { class: 'page-head-text' },
      h('h1', {}, title),
      summary && h('p', { class: 'quiet' }, summary)),
    controls.length ? h('div', { class: 'page-head-controls' }, controls) : null);
}

// Remembers each segmented control's last pill position so the highlight pill glides smoothly even across redraws.
const segMemory = new Map();

function segmented(label, options, value, onPick, { iconsOnly = false } = {}) {
  const pill = h('span', { class: 'seg-pill', 'aria-hidden': 'true' });
  const btns = options.map(([id, text, glyph]) => h('button', {
    type: 'button',
    'aria-pressed': String(id === value),
    'aria-label': iconsOnly ? text : null,
    title: iconsOnly ? text : null,
    onclick: () => {
      const cur = wrap.querySelector("button[aria-pressed='true']");
      if (cur) segMemory.set(label, { left: cur.offsetLeft, width: cur.offsetWidth });
      onPick(id);
    },
  },
    glyph && h('span', { class: 'seg-icon', icon: glyph }),
    !iconsOnly && text));
  const wrap = h('div', { class: 'segmented' + (iconsOnly ? ' is-icons' : ''), role: 'group', 'aria-label': label }, pill, ...btns);

  function place(animate) {
    const active = wrap.querySelector("button[aria-pressed='true']");
    if (!active || !wrap.isConnected) return;
    const to = { left: active.offsetLeft, width: active.offsetWidth };
    if (!to.width) return;
    const from = animate ? segMemory.get(label) : null;
    if (animate) segMemory.delete(label);
    if (from && (from.left !== to.left || from.width !== to.width) && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      pill.classList.add('no-slide');
      pill.style.width = `${from.width}px`;
      pill.style.translate = `${from.left}px 0`;
      pill.classList.add('is-on');
      void pill.offsetWidth;
      pill.classList.remove('no-slide');
    } else {
      pill.classList.add('no-slide');
      pill.classList.add('is-on');
    }
    pill.style.width = `${to.width}px`;
    pill.style.translate = `${to.left}px 0`;
    if (pill.classList.contains('no-slide')) requestAnimationFrame(() => pill.classList.remove('no-slide'));
  }

  // Place as soon as connected (avoiding a frame-0 flash) and re-sync if layout/fonts settle.
  queueMicrotask(() => place(true));
  requestAnimationFrame(() => { if (!pill.classList.contains('is-on')) place(true); });
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (!wrap.isConnected) { ro.disconnect(); return; }
      place(false);
    });
    ro.observe(wrap);
  }
  return wrap;
}

function select(label, options, value, onPick) {
  const current = options.find(([id]) => id === value) || options[0] || ['', ''];
  let open = false;
  const btn = h('button', {
    type: 'button',
    class: 'select-btn',
    'aria-label': `${label}: ${current[1]}`,
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
  },
    h('span', { class: 'select-label' }, current[1]),
    h('span', { class: 'select-chev', icon: 'chevronDown' }));

  function toggle() {
    if (open) { closeMenu(); return; }
    open = true;
    btn.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    const list = h('div', { class: 'select-menu', role: 'listbox', 'aria-label': label },
      options.map(([id, text]) => {
        const active = id === value;
        return h('button', {
          type: 'button',
          role: 'option',
          class: 'select-opt' + (active ? ' is-active' : ''),
          'aria-selected': String(active),
          onclick: () => {
            closeMenu();
            if (id !== value) onPick(id);
            btn.focus({ preventScroll: true });
          },
        },
          h('span', { class: 'select-opt-mark', icon: active ? 'check' : null }),
          h('span', { class: 'select-opt-text' }, text));
      }));
    list.style.minWidth = Math.max(168, Math.round(r.width)) + 'px';
    list.addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const opts = [...list.querySelectorAll('.select-opt')];
      if (!opts.length) return;
      e.preventDefault();
      const at = opts.indexOf(document.activeElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? opts.length - 1
        : (at + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts[next].focus();
    });
    const alignRight = r.left + Math.max(168, r.width) > window.innerWidth - 16;
    showPopover(r.left, r.bottom + 6, list, {
      anchor: r,
      align: alignRight ? 'right' : 'left',
      onClose: () => {
        open = false;
        btn.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
      },
    });
    (list.querySelector('.select-opt.is-active') || list.querySelector('.select-opt'))?.focus();
  }

  btn.addEventListener('click', toggle);
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!open) toggle(); }
  });
  return h('div', { class: 'select' }, btn);
}

function emptyState(title, body, ...actions) {
  return h('div', { class: 'empty' },
    h('h2', {}, title),
    body && h('p', {}, body),
    actions.length ? h('div', { class: 'empty-actions' }, actions) : null);
}

const button = (text, onclick, kind = '') => h('button', { class: 'btn ' + kind, onclick }, text);
const linkButton = (text, href, kind = '') => h('a', { class: 'btn ' + kind, href }, text);

function loading(text = 'Loading…') {
  return h('p', { class: 'quiet loading' }, text);
}

function failure(error, retry) {
  return emptyState("That didn't load", error?.message || String(error), button('Try again', retry));
}

/** The three bars that mark the song playing right now. */
function playingMark() {
  return h('span', { class: 'eq', 'aria-label': 'Playing' }, h('i'), h('i'), h('i'));
}

/** Square artwork for a playlist, giving Liked songs its own tinted heart cover. */
function playlistArt(item, size, opts) {
  if (item?.href === collection.LIKED_HREF || item?.kind === 'liked') {
    return h('span', { class: 'cover is-liked', 'aria-hidden': 'true' },
      h('span', { class: 'liked-mark', icon: 'heartFilled' }));
  }
  return cover(item?.art, size, opts);
}

const SOURCE_ICON = { local: 'pc', apple: 'appleMono', youtube: 'youtubeMono', spotify: 'spotifyMono', tint: 'listMusic' };
const SOURCE_LABEL = { local: 'This PC', apple: 'Apple Music', youtube: 'YouTube Music', spotify: 'Spotify', tint: 'In Tint' };
const DEST_LABEL = { tint: 'Tint', apple: 'Apple Music', youtube: 'YouTube Music', spotify: 'Spotify' };

async function runLike(track) {
  try {
    const res = await likes.toggleLike(track);
    toast(res.liked ? `Liked "${track.title}" on ${res.syncedTo.join(', ')}` : `Removed "${track.title}" from Liked (${res.syncedTo.join(', ')})`);
  } catch (e) {
    toast(e?.message || "Couldn't sync like.", { ms: 5000 });
  }
}

/** Popover to add one or more tracks to platform-synced playlists (YouTube Music, Apple Music, Spotify) or Tint playlists. */
export function playlistPanel(x, y, tracks = null, { anchor = null } = {}) {
  const listTracks = Array.isArray(tracks) ? tracks.filter((t) => t?.id) : [];
  const adding = listTracks.length > 0;
  const primarySrc = listTracks[0]?.source;
  const signedDestinations = [
    ['tint', 'Tint', 'listMusic'],
    apple.isSignedIn() && ['apple', 'Apple Music', 'appleMono'],
    youtube.isSignedIn() && ['youtube', 'YouTube Music', 'youtubeMono'],
    spotify.isSignedIn() && ['spotify', 'Spotify', 'spotifyMono'],
  ].filter(Boolean);
  let createDest = signedDestinations.some(([id]) => id === primarySrc) ? primarySrc : 'tint';
  const addedThisOpen = new Set(); // hrefs of remote playlists added during this popover session
  let busy = false;

  // Ensure signed-in platforms have started loading their playlists so they appear right away.
  if (apple.isSignedIn()) apple.libraryPlaylists();
  if (youtube.isSignedIn()) youtube.libraryPlaylists();
  if (spotify.isSignedIn()) spotify.libraryPlaylists();

  const panel = h('div', {
    class: 'tag-panel pl-panel' + (adding ? '' : ' is-create'),
    role: 'dialog',
    'aria-label': adding ? 'Add to playlist' : 'New playlist',
  });

  const createBtn = !adding ? h('button', {
    type: 'button',
    class: 'btn primary pl-create-btn',
    disabled: true,
    onclick: () => enter(true),
  }, 'Create') : null;

  const find = h('input', {
    type: 'text', class: 'tag-find', maxLength: 80, spellcheck: false,
    placeholder: adding ? 'Find or make a playlist' : 'Playlist name',
    'aria-label': adding ? 'Find or make a playlist' : 'Playlist name',
    oninput: () => draw(),
    onkeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); enter(); }
      if (e.key === 'ArrowDown' && adding) { e.preventDefault(); list.querySelector('button')?.focus(); }
    },
  });
  const destHost = h('div', { class: 'pl-dest-host' });
  const list = h('div', { class: 'tag-list' });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const picks = [...list.querySelectorAll('.tag-pick')];
    const at = picks.indexOf(document.activeElement.closest('.tag-row')?.querySelector('.tag-pick'));
    if (at < 0) return;
    e.preventDefault();
    const next = at + (e.key === 'ArrowDown' ? 1 : -1);
    (next < 0 ? find : picks[Math.min(next, picks.length - 1)]).focus();
  });

  /** Editable playlists grouped with the track's own service first, then other signed-in services, then Tint. */
  function groups() {
    const order = [primarySrc, 'apple', 'youtube', 'spotify', 'tint']
      .filter((s, i, arr) => s && ['apple', 'youtube', 'spotify', 'tint'].includes(s) && arr.indexOf(s) === i);
    const out = [];
    for (const src of order) {
      let items = [];
      if (src === 'tint') items = collection.customPlaylists().map((p) => ({ ...p, source: 'tint' }));
      else if (src === 'apple' && apple.isSignedIn()) items = apple.editablePlaylists();
      else if (src === 'youtube' && youtube.isSignedIn()) items = youtube.editablePlaylists();
      else if (src === 'spotify' && spotify.isSignedIn()) items = spotify.editablePlaylists();
      if (items.length) out.push({ source: src, label: SOURCE_LABEL[src], icon: SOURCE_ICON[src], items });
    }
    return out;
  }

  const flatAll = () => groups().flatMap((g) => g.items);
  const named = (name) => flatAll().find((p) => p.title.toLowerCase() === name.trim().toLowerCase());

  function picked() {
    const q = find.value.trim().toLowerCase();
    if (!q || !adding) return null;
    return named(q) || flatAll().find((p) => p.title.toLowerCase().includes(q)) || null;
  }

  async function toggleIn(pl) {
    if (!adding || busy) return;
    if (pl.source === 'tint') {
      const allIn = listTracks.every((t) => collection.hasTrack(pl.href, t));
      if (allIn && listTracks.length === 1) {
        collection.removeTrack(pl.href, listTracks[0].id);
        toast(`Removed from "${pl.title}"`);
      } else if (allIn) {
        toast(`Already in "${pl.title}"`);
      } else {
        const n = collection.addTracks(pl.href, listTracks);
        toast(n === 1 ? `Added to "${pl.title}"` : `Added ${plural(n, 'song')} to "${pl.title}"`);
      }
      draw(true);
      return;
    }

    busy = true;
    const svcName = DEST_LABEL[pl.source];
    toast(`Syncing to "${pl.title}" on ${svcName}…`, { ms: 2000 });
    try {
      let added = 0;
      if (pl.source === 'youtube') added = await youtube.addToPlaylist(pl.id, listTracks);
      else if (pl.source === 'apple') added = await apple.addToPlaylist(pl.id, listTracks);
      else if (pl.source === 'spotify') added = await spotify.addToPlaylist(pl.id, listTracks);
      addedThisOpen.add(pl.href);
      // If saved locally in Tint too, add locally so saved copies stay fresh.
      if (collection.find(pl.href)) collection.save({ ...collection.find(pl.href), tracks: [...(collection.find(pl.href).tracks || []), ...listTracks] });
      toast(added === 1 ? `Added to "${pl.title}" on ${svcName}` : `Added ${plural(added, 'song')} to "${pl.title}" on ${svcName}`);
    } catch (e) {
      toast(e?.message || `Couldn't add to "${pl.title}" on ${svcName}.`, { ms: 6000 });
    } finally {
      busy = false;
      draw(true);
    }
  }

  async function makeNew(name) {
    const clean = name.trim();
    if (!clean || busy) return;
    if (createDest === 'tint') {
      const made = collection.createPlaylist(clean, listTracks);
      if (!made) return;
      if (adding) {
        toast(listTracks.length === 1 ? `Created "${made.title}" in Tint and added song` : `Created "${made.title}" with ${plural(listTracks.length, 'song')}`);
        find.value = '';
        draw();
        find.focus();
      } else {
        closeMenu();
        toast(`Created playlist "${made.title}"`);
        location.hash = made.href;
      }
      return;
    }

    busy = true;
    if (createBtn) createBtn.disabled = true;
    const svcName = DEST_LABEL[createDest];
    toast(`Creating "${clean}" on ${svcName}…`, { ms: 2500 });
    try {
      let made = null;
      if (createDest === 'youtube') made = await youtube.createPlaylist(clean, listTracks);
      else if (createDest === 'apple') made = await apple.createPlaylist(clean, listTracks);
      else if (createDest === 'spotify') made = await spotify.createPlaylist(clean, listTracks);
      if (made) {
        addedThisOpen.add(made.href);
        toast(adding ? `Created "${made.title}" on ${svcName} and added songs` : `Created "${made.title}" on ${svcName}`);
        if (!adding) { closeMenu(); location.hash = made.href; return; }
      }
      find.value = '';
      draw();
      find.focus();
    } catch (e) {
      toast(e?.message || `Couldn't create playlist on ${svcName}.`, { ms: 6000 });
    } finally {
      busy = false;
      if (createBtn) createBtn.disabled = !find.value.trim();
    }
  }

  function enter(forceMake = false) {
    const name = find.value.trim();
    if (!name) return;
    if (!adding || forceMake) { makeNew(name); return; }
    const same = picked();
    if (same) {
      toggleIn(same);
      find.value = '';
      draw();
      find.focus();
    } else {
      makeNew(name);
    }
  }

  function row(pl, isNext = false) {
    const isTint = pl.source === 'tint';
    const hasAll = adding && (isTint ? listTracks.every((t) => collection.hasTrack(pl.href, t)) : addedThisOpen.has(pl.href));
    const hasSome = adding && isTint && !hasAll && listTracks.some((t) => collection.hasTrack(pl.href, t));
    return h('div', { class: 'tag-row' + (hasAll ? ' is-on' : '') },
      h('div', { class: 'tag-row-main' },
        h('button', {
          class: 'tag-pick' + (isNext ? ' is-next' : ''), dataset: { key: `pl-${pl.source}-${pl.id}` },
          role: 'menuitemcheckbox', 'aria-checked': hasAll ? 'true' : hasSome ? 'mixed' : 'false',
          onclick: () => toggleIn(pl),
        },
          h('span', { class: 'tag-box', icon: hasAll ? 'check' : null }),
          h('span', { class: 'pl-thumb' }, pl.art ? cover(pl.art, 28) : h('span', { class: 'pl-thumb-icon', icon: SOURCE_ICON[pl.source] || 'listMusic' })),
          h('span', { class: 'tag-row-name' }, pl.title),
          isTint && h('span', { class: 'tag-row-count' }, String(pl.tracks?.length || 0)))));
  }

  function drawDest() {
    if (signedDestinations.length <= 1) { fill(destHost); return; }
    fill(destHost,
      h('div', { class: 'pl-dest' },
        h('span', { class: 'pl-dest-lbl' }, `Save to ${DEST_LABEL[createDest]}`),
        segmented('Create playlist in', signedDestinations, createDest, (v) => { createDest = v; drawDest(); draw(true); }, { iconsOnly: true })));
  }

  function draw(keepFocus = false) {
    const key = keepFocus ? document.activeElement?.dataset?.key : null;
    const q = find.value.trim();
    if (createBtn) createBtn.disabled = !q || busy;
    if (!adding) return;
    const ql = q.toLowerCase();
    const grouped = groups().map((g) => ({ ...g, items: g.items.filter((p) => p.title.toLowerCase().includes(ql)) })).filter((g) => g.items.length);
    const making = !!q && !named(q);
    const next = picked();
    const rows = [];
    for (const g of grouped) {
      rows.push(h('div', { class: 'pl-group-head' },
        h('span', { class: 'pl-group-icon', icon: g.icon }),
        h('span', {}, g.label)));
      for (const p of g.items) rows.push(row(p, p === next));
    }
    const where = createDest === 'tint' ? 'in Tint' : `on ${DEST_LABEL[createDest]}`;
    fill(list,
      rows,
      making ? h('div', { class: 'tag-make' },
        h('button', { class: 'tag-pick' + (rows.length ? '' : ' is-next'), dataset: { key: 'make' }, onclick: () => enter(true) },
          h('span', { class: 'tag-box', icon: 'plus' }),
          h('span', { class: 'tag-row-name' }, `Create "${q}" ${where} & add`))) : null,
      !grouped.length && !q ? h('p', { class: 'quiet tag-panel-hint' }, 'Type a name to create your first playlist.') : null);
    if (key) list.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
    if (panel.isConnected) {
      const r = panel.getBoundingClientRect();
      if (r.bottom > innerHeight - 8) panel.style.top = Math.max(8, innerHeight - 8 - panel.offsetHeight) + 'px';
    }
  }

  const heading = !adding ? 'New playlist'
    : listTracks.length === 1 ? `Add "${listTracks[0].title}" to…`
      : `Add ${plural(listTracks.length, 'song')} to…`;
  drawDest();
  if (adding) {
    fill(panel, h('p', { class: 'tag-panel-title' }, heading), find, signedDestinations.length > 1 ? destHost : null, list);
  } else {
    fill(panel, h('p', { class: 'tag-panel-title' }, heading), h('div', { class: 'pl-create-row' }, find, createBtn), signedDestinations.length > 1 ? destHost : null);
  }
  draw();
  // Live-refresh as platform playlists finish loading while popover is open.
  const offs = adding ? [apple.onChange(() => draw(true)), youtube.onChange(() => draw(true)), spotify.onChange(() => draw(true))] : [];
  showPopover(x, y, panel, { anchor, onClose: () => offs.forEach((off) => off()) });
  find.focus();
}

function renamePlaylistPanel(x, y, item) {
  const panel = h('div', { class: 'tag-panel rename-panel', role: 'dialog', 'aria-label': `Rename ${item.title}` });
  const input = h('input', {
    type: 'text', class: 'tag-find', maxLength: 80, value: item.title, spellcheck: false, 'aria-label': 'Playlist name',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } },
  });
  function commit() {
    const clean = input.value.trim();
    if (!clean) return;
    if (clean !== item.title) {
      collection.renamePlaylist(item.href, clean);
      toast(`Renamed playlist to "${clean}"`);
    }
    closeMenu();
  }
  fill(panel,
    h('p', { class: 'tag-panel-title' }, 'Rename playlist'),
    input,
    h('div', { class: 'rename-actions' },
      h('button', { class: 'btn', onclick: closeMenu }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: commit }, 'Save')));
  showPopover(x, y, panel);
  input.focus();
  input.select();
}

function trackMenu(x, y, track, { playlistHref = null, playlistSource = null, playlistId = null, onRemoved = null } = {}) {
  const liked = likes.isLiked(track);
  const inEditableTint = playlistHref && playlistHref !== collection.LIKED_HREF && collection.isEditable(collection.find(playlistHref));
  const inEditableRemote = (playlistSource === 'youtube' && youtube.isSignedIn() && playlistId && playlistId !== 'VLLM')
    || (playlistSource === 'spotify' && spotify.isSignedIn() && playlistId);
  showMenu(x, y, [
    {
      icon: liked ? 'heartFilled' : 'heart',
      label: liked ? 'Remove from Liked songs' : 'Like',
      active: liked,
      run: () => runLike(track),
    },
    { icon: 'listPlus', label: 'Add to playlist…', run: () => playlistPanel(x, y, [track]) },
    (inEditableTint || inEditableRemote) && {
      icon: 'trash',
      label: inEditableRemote ? `Remove from ${SOURCE_LABEL[playlistSource]} playlist` : 'Remove from playlist',
      danger: true,
      run: async () => {
        if (inEditableTint) {
          collection.removeTrack(playlistHref, track.id);
          toast(`Removed "${track.title}" from playlist`);
          return;
        }
        try {
          if (playlistSource === 'youtube') await youtube.removeFromPlaylist(playlistId, track);
          else if (playlistSource === 'spotify') await spotify.removeFromPlaylist(playlistId, track);
          toast(`Removed "${track.title}" from ${SOURCE_LABEL[playlistSource]} playlist`);
          onRemoved?.(track);
        } catch (e) {
          toast(e?.message || "Couldn't remove from playlist.", { ms: 5000 });
        }
      },
    },
    { sep: true },
    { icon: 'listStart', label: 'Play next', run: () => { player.playNext([track]); toast(`"${track.title}" plays next`); } },
    { icon: 'listEnd', label: 'Add to queue', run: () => { player.addToQueue([track]); toast(`Added "${track.title}" to the queue`); } },
    { sep: true },
    track.artist && { icon: 'user', label: 'Go to artist', run: () => { location.hash = artistHref(track); } },
    track.albumHref && { icon: 'disc', label: 'Go to album', run: () => { location.hash = track.albumHref; } },
    { icon: 'copy', label: 'Copy title', run: () => copyText(track.title, 'Title copied') },
    { icon: 'share', label: 'Share YouTube Music link', run: () => youtube.share(track) },
  ]);
}

function trackRow(tracks, i, { numbered = false, showAlbum = true, albumArtist = null, showSource = false, playlistHref = null, playlistSource = null, playlistId = null, onRemoved = null } = {}) {
  const track = tracks[i];
  const isCurrent = player.current()?.id === track.id;
  const liked = likes.isLiked(track);
  const play = () => {
    if (track.playable === false) return toast(track.reason || "This song can't be played.");
    player.playList(tracks, i);
    pagecache.used(location.hash);
  };

  let lead;
  if (numbered) lead = isCurrent ? playingMark() : h('span', { class: 'row-no' }, String(track.trackNo || i + 1));
  else lead = h('span', { class: 'row-art' }, cover(track.art, 40), isCurrent && playingMark());

  return h('div', {
    class: 'row' + (isCurrent ? ' is-current' : '') + (track.playable === false ? ' is-off' : '') + (numbered ? ' is-numbered' : ''),
    role: 'listitem',
    tabIndex: 0,
    title: track.playable === false ? track.reason : null,
    onclick: (e) => { if (!e.target.closest('.row-more, .row-like')) play(); },
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) play(); },
    oncontextmenu: (e) => { e.preventDefault(); trackMenu(e.clientX, e.clientY, track, { playlistHref, playlistSource, playlistId, onRemoved }); },
  },
    h('span', { class: 'row-lead' }, lead),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title' }, track.title, track.explicit && h('span', { class: 'explicit', title: 'Explicit' }, 'E'),
        // Album pages name a Japanese song in English too, unless its title already does.
        numbered && track.englishTitle && !track.title.includes(track.englishTitle) && h('span', { class: 'row-english' }, track.englishTitle)),
      // On an album page the artist is in the heading; only guests need naming on the rows.
      track.artist !== albumArtist && h('span', { class: 'row-sub' }, track.artist)),
    showAlbum && h('span', { class: 'row-album' }, track.album),
    showSource && SOURCE_ICON[track.source] && h('span', { class: 'row-source', icon: SOURCE_ICON[track.source], title: SOURCE_LABEL[track.source] }),
    h('button', {
      class: 'icon-btn small row-like' + (liked ? ' is-liked' : ''),
      icon: liked ? 'heartFilled' : 'heart',
      'aria-label': liked ? `Unlike ${track.title}` : `Like ${track.title}`,
      'aria-pressed': String(liked),
      title: liked ? 'Remove from Liked songs' : 'Like',
      onclick: (e) => { e.stopPropagation(); runLike(track); },
    }),
    h('span', { class: 'row-time' }, track.duration ? fmtTime(track.duration) : ''),
    h('button', {
      class: 'icon-btn small row-more', icon: 'more', 'aria-label': `More for ${track.title}`, title: 'More',
      onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); trackMenu(r.right - 200, r.bottom + 4, track, { playlistHref, playlistSource, playlistId, onRemoved }); },
    }));
}

/**
 * A track list. Only the rows on screen (and a few either side) exist at any time, however long it
 * is. `only` limits it to some of `tracks` (one disc of an album), still playing from the whole.
 */
function trackList(scroller, tracks, options = {}) {
  const only = options.only || null;
  const count = only ? only.length : tracks.length;
  const row = (i) => trackRow(tracks, only ? only[i] : i, options);
  const list = new VirtualList({ scroller, rowHeight: ROW, count, className: 'tracks', render: row });
  return { el: list.el, refresh: () => list.refresh(), destroy: () => list.destroy() };
}

async function tracksOf(item) {
  if (item.href === likes.LIKED_HREF) return likes.merged().tracks;
  if (item.source === 'tint') return collection.find(item.href)?.tracks || item.tracks || [];
  const saved = collection.find(item.href);
  if (item.tracks && !saved) return item.tracks;
  // A playlist saved in Tint plays as it was saved, until Refresh is pressed.
  if (item.href.includes('#/playlist/') && saved?.tracks?.length) return saved.tracks;
  pagecache.used(item.href);
  const isPlaylist = item.href.includes('#/playlist/');
  const from = item.source === 'youtube' ? youtube : item.source === 'spotify' ? spotify : apple;
  const live = (isPlaylist ? from.playlist(item.id) : from.album(item.id)).then((detail) => {
    pagecache.keep(item.href, isPlaylist ? { ...detail, href: item.href } : detail);
    return detail.tracks;
  });
  live.catch(() => {}); // heard below, or not needed
  // A kept copy plays at once; the service's answer still freshens the copy for next time.
  const copy = await pagecache.read(item.href);
  if (copy?.tracks?.length) return copy.tracks;
  try {
    return await live;
  } catch (e) {
    // A playlist saved in Tint still plays from the copy kept with it.
    if (saved?.tracks?.length) return saved.tracks;
    throw e;
  }
}

function card(item) {
  const playIt = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const tracks = await tracksOf(item);
      if (!tracks.length) return toast('Nothing in there to play.');
      player.playList(tracks, 0, { shuffle: false });
    } catch (err) {
      toast(err?.message || "That couldn't be played.");
    }
  };
  const isPlaylist = item.href.includes('#/playlist/');
  const isArtist = item.href.includes('#/artist/');
  const saved = isPlaylist ? collection.find(item.href) : null;
  const marks = collection.tagsOf(saved);
  // The pin shows on hover, and stays while the playlist is pinned. Pinning saves it first.
  const pinIt = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const now = collection.find(item.href) || await saveInTint(item, true);
    if (!now) return;
    collection.setPinned(item.href, !now.pinned);
    toast(now.pinned ? `Pinned "${item.title}" to the top` : `Unpinned "${item.title}"`);
  };
  const openTags = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    tagPanel(r.left, r.bottom + 6, item.href);
  };
  const el = h('a', {
    class: 'card', href: item.href, title: item.title,
    oncontextmenu: (e) => {
      e.preventDefault();
      if (isPlaylist) playlistMenu(e.clientX, e.clientY, item);
      else if (isArtist) artistCardMenu(e.clientX, e.clientY, item);
      else albumCardMenu(e.clientX, e.clientY, item);
    },
    // On the Playlists page a playlist can be picked up and dropped on a tag to be given it.
    draggable: false,
    onpointerdown: isPlaylist ? (e) => liftPlaylist(e, item, el) : null,
  },
    h('span', { class: 'card-art' },
      isPlaylist ? playlistArt(item, 200) : cover(item.art, 200),
      isPlaylist && h('button', {
        class: 'card-pin' + (saved?.pinned ? ' is-pinned' : ''), icon: 'pin',
        title: saved?.pinned ? 'Unpin' : 'Pin to the top', 'aria-label': `${saved?.pinned ? 'Unpin' : 'Pin'} ${item.title}`,
        'aria-pressed': String(!!saved?.pinned), onclick: pinIt,
      }),
      isArtist ? null : h('button', { class: 'card-play', icon: 'play', 'aria-label': `Play ${item.title}`, onclick: playIt })),
    h('span', { class: 'card-title' }, item.title),
    item.artist && h('span', { class: 'card-sub' }, item.artist),
    marks.length ? h('button', { class: 'card-tags', title: 'Change the tags', 'aria-label': `Tags of ${item.title}`, onclick: openTags }, marks.map(tagLabel)) : null);
  return el;
}

async function runCardTracks(item, action) {
  try {
    const tracks = await tracksOf(item);
    if (!tracks.length) return toast('Nothing in there to play.');
    action(tracks);
  } catch (err) {
    toast(err?.message || "That couldn't be loaded.");
  }
}

function albumCardMenu(x, y, item) {
  showMenu(x, y, [
    { icon: 'play', label: 'Play', run: () => runCardTracks(item, (tracks) => player.playList(tracks, 0, { shuffle: false })) },
    { icon: 'shuffle', label: 'Shuffle', run: () => runCardTracks(item, (tracks) => player.playList(tracks, 0, { shuffle: true })) },
    { sep: true },
    { icon: 'listPlus', label: 'Add to playlist…', run: () => runCardTracks(item, (tracks) => playlistPanel(x, y, tracks)) },
    { icon: 'listStart', label: 'Play next', run: () => runCardTracks(item, (tracks) => { player.playNext(tracks); toast(`"${item.title}" plays next`); }) },
    { icon: 'listEnd', label: 'Add to queue', run: () => runCardTracks(item, (tracks) => { player.addToQueue(tracks); toast(`Added "${item.title}" to the queue`); }) },
    { sep: true },
    item.artist && { icon: 'user', label: 'Go to artist', run: () => { location.hash = artistHref(item); } },
    { icon: 'copy', label: 'Copy title', run: () => copyText(item.title, 'Title copied') },
  ]);
}

function artistCardMenu(x, y, item) {
  showMenu(x, y, [
    { icon: 'user', label: 'Open artist', run: () => { location.hash = item.href; } },
    { icon: 'copy', label: 'Copy name', run: () => copyText(item.title, 'Artist name copied') },
  ]);
}

// ---- saved playlists, pins and tags -------------------------------------------------------------

/** Gives an element its tag's colour, which the stylesheet reads as --tag. */
function tagged(el, color) {
  el.style.setProperty('--tag', color);
  return el;
}

const tagLabel = (t) => tagged(h('span', { class: 'tag-label' }, h('span', { class: 'tag-dot' }), t.name), t.color);
const nextColor = (color) => collection.COLORS[(collection.COLORS.indexOf(color) + 1) % collection.COLORS.length];

/** Whether a playlist currently lives in its source platform's library (Apple, YouTube, Spotify). */
function inPlatformLibrary(item) {
  if (!item?.id) return false;
  if (item.source === 'spotify' && spotify.isSignedIn()) return spotify.libraryPlaylists().items.some((p) => p.id === item.id);
  if (item.source === 'youtube' && youtube.isSignedIn()) return youtube.libraryPlaylists().items.some((p) => p.id === item.id || p.id.replace(/^VL/, '') === item.id.replace(/^VL/, ''));
  if (item.source === 'apple' && apple.isSignedIn()) return apple.libraryPlaylists().items.some((p) => p.id === item.id);
  return false;
}

/** Saves a playlist in Tint with its songs, and follows/saves it on its source platform when signed in. */
async function saveInTint(item, quiet = false) {
  try {
    const tracks = item.tracks || await tracksOf(item);
    collection.save({ ...item, tracks });
    let synced = null;
    if (!inPlatformLibrary(item)) {
      try {
        if (item.source === 'spotify' && spotify.isSignedIn()) { await spotify.savePlaylist(item.id); synced = 'Spotify'; }
        else if (item.source === 'youtube' && youtube.isSignedIn()) { await youtube.savePlaylist(item.id); synced = 'YouTube Music'; }
        else if (item.source === 'apple' && apple.isSignedIn()) { await apple.savePlaylist(item.id); synced = 'Apple Music'; }
      } catch { /* keep Tint save even if platform follow failed */ }
    }
    if (!quiet) toast(synced ? `Saved "${item.title}" in Tint & ${synced}` : `Saved "${item.title}" in Tint`);
    return collection.find(item.href);
  } catch (e) {
    toast(e?.message || "That playlist couldn't be saved.");
    return null;
  }
}

/** Removes a playlist from its source platform library and removes any saved copy in Tint. */
async function removeFromPlatform(item) {
  const svcName = SOURCE_LABEL[item.source];
  try {
    if (item.source === 'spotify') await spotify.removePlaylist(item.id);
    else if (item.source === 'youtube') await youtube.removePlaylist(item.id);
    else if (item.source === 'apple') await apple.removePlaylist(item.id);
    if (collection.find(item.href)) collection.remove(item.href);
    toast(`Removed "${item.title}" from ${svcName}`);
    if (location.hash === item.href) location.hash = '#/playlists';
  } catch (e) {
    toast(e?.message || `Couldn't remove "${item.title}" from ${svcName}.`, { ms: 6000 });
  }
}

/** What can be done with a saved playlist: pin it, tag it, rename it, or remove it. */
function savedMenuItems(x, y, saved) {
  const isCustom = saved.source === 'tint' && saved.href !== collection.LIKED_HREF;
  const isLiked = saved.href === collection.LIKED_HREF;
  const onPlatform = inPlatformLibrary(saved);
  return [
    { icon: 'pin', label: saved.pinned ? 'Unpin' : 'Pin to the top', active: !!saved.pinned, run: () => collection.setPinned(saved.href, !saved.pinned) },
    { icon: 'tag', label: 'Tags…', run: () => tagPanel(x, y, saved.href) },
    isCustom && { icon: 'pen', label: 'Rename…', run: () => renamePlaylistPanel(x, y, saved) },
    {
      icon: 'trash',
      label: isLiked ? 'Clear Liked songs' : isCustom ? 'Delete playlist' : 'Remove from Tint',
      danger: true,
      run: () => {
        collection.remove(saved.href);
        toast(isLiked ? 'Cleared Liked songs' : isCustom ? `Deleted "${saved.title}"` : `Removed "${saved.title}" from Tint`);
      },
    },
    onPlatform && {
      icon: 'trash',
      label: `Remove from ${SOURCE_LABEL[saved.source]}`,
      danger: true,
      run: () => removeFromPlatform(saved),
    },
  ];
}

function playlistMenu(x, y, item) {
  if (item.href === likes.LIKED_HREF) {
    showMenu(x, y, [
      { icon: 'play', label: 'Play', run: () => runCardTracks(item, (tracks) => player.playList(tracks, 0, { shuffle: false })) },
      { icon: 'shuffle', label: 'Shuffle', run: () => runCardTracks(item, (tracks) => player.playList(tracks, 0, { shuffle: true })) },
      { sep: true },
      { icon: 'listStart', label: 'Play next', run: () => runCardTracks(item, (tracks) => { player.playNext(tracks); toast('"Liked songs" plays next'); }) },
      { icon: 'listEnd', label: 'Add to queue', run: () => runCardTracks(item, (tracks) => { player.addToQueue(tracks); toast('Added "Liked songs" to the queue'); }) },
      { sep: true },
      { icon: 'copy', label: 'Copy title', run: () => copyText(item.title, 'Title copied') },
    ]);
    return;
  }
  const saved = collection.find(item.href);
  const onPlatform = !saved && inPlatformLibrary(item);
  showMenu(x, y, [
    { icon: 'play', label: 'Play', run: () => runCardTracks(item, (tracks) => player.playList(tracks, 0, { shuffle: false })) },
    { icon: 'shuffle', label: 'Shuffle', run: () => runCardTracks(item, (tracks) => player.playList(tracks, 0, { shuffle: true })) },
    { sep: true },
    ...(saved ? savedMenuItems(x, y, saved) : [
      { icon: 'bookmark', label: 'Save in Tint', run: () => saveInTint(item) },
      { icon: 'pin', label: 'Pin to the top', run: async () => { if (await saveInTint(item, true)) collection.setPinned(item.href, true); } },
      { icon: 'tag', label: 'Tags…', run: async () => { if (await saveInTint(item, true)) tagPanel(x, y, item.href); } },
      onPlatform && {
        icon: 'trash',
        label: `Remove from ${SOURCE_LABEL[item.source]}`,
        danger: true,
        run: () => removeFromPlatform(item),
      },
    ]),
    { sep: true },
    { icon: 'copy', label: 'Copy title', run: () => copyText(item.title, 'Title copied') },
  ]);
}

/** A colour no tag has yet, or the one fewest tags have. */
function freeColor() {
  const uses = (c) => collection.tags().filter((t) => t.color === c).length;
  return collection.COLORS.reduce((best, c) => (uses(c) < uses(best) ? c : best), collection.COLORS[0]);
}

const tagUses = (id) => collection.items().filter((item) => item.tags?.includes(id)).length;

/**
 * The tags. The box at the top finds a tag or makes a new one (Enter gives it to the playlist);
 * a click on a tag gives or takes it; the pen opens it to rename it, recolour it or delete it.
 * Without a playlist (`href` null) it only looks after the tags themselves.
 */
function tagPanel(x, y, href = null) {
  const panel = h('div', { class: 'tag-panel', role: 'dialog', 'aria-label': href ? 'Tags' : 'Your tags' });
  let open = null; // the tag being edited
  let deleting = null; // the tag whose Delete was pressed once
  let color = freeColor();

  const find = h('input', {
    type: 'text', class: 'tag-find', maxLength: 40, spellcheck: false,
    placeholder: href ? 'Find or make a tag' : 'Make a tag',
    'aria-label': href ? 'Find or make a tag' : 'Name of a new tag',
    oninput: () => draw(),
    onkeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); enter(e); }
      if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector('button')?.focus(); }
    },
  });
  const list = h('div', { class: 'tag-list' });
  // Up and down move between the tags, and back up into the box.
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const picks = [...list.querySelectorAll('.tag-pick')];
    const at = picks.indexOf(document.activeElement.closest('.tag-row')?.querySelector('.tag-pick'));
    if (at < 0) return;
    e.preventDefault();
    const next = at + (e.key === 'ArrowDown' ? 1 : -1);
    (next < 0 ? find : picks[Math.min(next, picks.length - 1)]).focus();
  });

  const item = () => (href ? collection.find(href) : null);
  const named = (name) => collection.tags().find((t) => t.name.toLowerCase() === name.trim().toLowerCase());

  function give(t) {
    const it = item();
    if (!it) return;
    collection.toggleTag(href, t.id);
  }

  /** The tag Enter picks: the one by that name, or else the first whose name holds what was typed. */
  function picked() {
    const q = find.value.trim().toLowerCase();
    if (!q) return null;
    return named(q) || collection.tags().filter((t) => t.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name))[0] || null;
  }

  function enter(e, make = false) {
    const name = find.value.trim();
    if (!name) return;
    const same = make ? named(name) : picked();
    if (same) {
      if (href) { if (!item()?.tags?.includes(same.id)) give(same); } else open = same.id;
    } else {
      const made = collection.addTag(name, color);
      if (made && href) give(made);
      color = freeColor();
    }
    find.value = '';
    draw();
    find.focus();
  }

  function editor(t) {
    const rename = h('input', {
      type: 'text', class: 'tag-rename', value: t.name, maxLength: 40, spellcheck: false, 'aria-label': `Name of the tag ${t.name}`,
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); open = null; draw(true); } },
      onchange: () => commit(),
    });
    function commit() {
      const name = rename.value.trim();
      if (!name || name === t.name) { rename.value = t.name; return; }
      const other = named(name);
      if (other && other.id !== t.id) { toast(`There's already a tag called "${other.name}"`); rename.value = t.name; return; }
      collection.editTag(t.id, { name });
    }
    const uses = tagUses(t.id);
    const sure = deleting === t.id;
    return h('div', { class: 'tag-editor' },
      rename,
      h('div', { class: 'tag-colors', role: 'radiogroup', 'aria-label': `Colour of ${t.name}` },
        collection.COLORS.map((c) => tagged(h('button', {
          class: 'tag-swatch', role: 'radio', 'aria-checked': String(c === t.color), 'aria-label': `Colour ${c}`,
          dataset: { key: `color-${t.id}-${c}` },
          onclick: () => { collection.editTag(t.id, { color: c }); draw(true); },
        }), c))),
      h('button', {
        class: 'tag-delete' + (sure ? ' is-sure' : ''), dataset: { key: `delete-${t.id}` },
        onclick: () => {
          if (!sure && uses) { deleting = t.id; draw(true); return; }
          collection.deleteTag(t.id);
          toast(`Deleted the tag "${t.name}"`);
          open = deleting = null;
          draw();
          find.focus();
        },
      }, sure ? `Take it off ${plural(uses, 'playlist')} and delete it` : 'Delete this tag'));
  }

  function row(t, it, isNext = false) {
    const on = !!it?.tags?.includes(t.id);
    const editing = open === t.id;
    return h('div', { class: 'tag-row' + (editing ? ' is-open' : '') + (on ? ' is-on' : '') },
      h('div', { class: 'tag-row-main' },
        h('button', {
          class: 'tag-pick' + (isNext ? ' is-next' : ''), dataset: { key: `pick-${t.id}` },
          role: href ? 'menuitemcheckbox' : null, 'aria-checked': href ? String(on) : null,
          'aria-expanded': href ? null : String(editing),
          title: href ? (on ? 'Take this tag off' : 'Give it this tag') : 'Rename, recolour or delete',
          onclick: () => { if (href) give(t); else { open = editing ? null : t.id; deleting = null; } draw(true); },
        },
          h('span', { class: 'tag-box', icon: on ? 'check' : null }),
          tagged(h('span', { class: 'tag-dot' }), t.color),
          h('span', { class: 'tag-row-name' }, t.name),
          h('span', { class: 'tag-row-count' }, String(tagUses(t.id)))),
        href ? h('button', {
          class: 'icon-btn small tag-edit', icon: 'pen', dataset: { key: `edit-${t.id}` },
          title: 'Rename, recolour or delete', 'aria-label': `Edit the tag ${t.name}`, 'aria-expanded': String(editing),
          onclick: () => { open = editing ? null : t.id; deleting = null; draw(true); },
        }) : null),
      editing ? editor(t) : null);
  }

  /** Draws the list again, keeping the focus where it was (`keepFocus`) and the panel on screen. */
  function draw(keepFocus = false) {
    const it = item();
    if (href && !it) { closeMenu(); return; }
    const key = keepFocus ? document.activeElement?.dataset?.key : null;
    const q = find.value.trim().toLowerCase();
    const all = collection.tags();
    // By name, so a tag stays where it is when it's ticked.
    const shown = all.filter((t) => t.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
    const making = q && !named(q);
    const next = picked();
    fill(list,
      shown.map((t) => row(t, it, t === next)),
      making ? h('div', { class: 'tag-make' },
        h('button', { class: 'tag-pick' + (shown.length ? '' : ' is-next'), dataset: { key: 'make' }, onclick: (e) => enter(e, true) },
          h('span', { class: 'tag-box', icon: 'plus' }),
          tagged(h('span', { class: 'tag-dot' }), color),
          h('span', { class: 'tag-row-name' }, `Make "${find.value.trim()}"`)),
        h('div', { class: 'tag-colors', role: 'radiogroup', 'aria-label': 'Colour of the new tag' },
          collection.COLORS.map((c) => tagged(h('button', {
            class: 'tag-swatch', role: 'radio', 'aria-checked': String(c === color), 'aria-label': `Colour ${c}`,
            dataset: { key: `new-${c}` },
            onclick: () => { color = c; draw(true); },
          }), c)))) : null,
      !all.length && !q ? h('p', { class: 'quiet tag-panel-hint' }, 'Type a name to make your first tag. A tag can go on as many playlists as you like.') : null,
      all.length && !shown.length && !making ? h('p', { class: 'quiet tag-panel-hint' }, 'No tag by that name.') : null);
    if (key) list.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
    if (panel.isConnected) {
      const r = panel.getBoundingClientRect();
      if (r.bottom > innerHeight - 8) panel.style.top = Math.max(8, innerHeight - 8 - panel.offsetHeight) + 'px';
    }
  }

  fill(panel,
    h('p', { class: 'tag-panel-title' }, href ? `Tags for "${item()?.title || ''}"` : 'Your tags'),
    find,
    list,
    href ? null : h('p', { class: 'quiet tag-panel-foot' }, 'Drag a playlist onto a tag to give it that tag.'));
  draw();
  if (href && !item()) return;
  showPopover(x, y, panel);
  find.focus();
}

// ---- dragging a playlist onto a tag --------------------------------------------------------------

/** Gives a playlist a tag, saving the playlist first if it isn't yet. */
async function giveTag(item, tagId) {
  const saved = collection.find(item.href) || await saveInTint(item, true);
  const t = collection.tag(tagId);
  if (!saved || !t) return;
  if (saved.tags?.includes(tagId)) { toast(`"${item.title}" already has the tag "${t.name}"`); return; }
  collection.toggleTag(item.href, tagId);
  toast(`Tagged "${item.title}" ${t.name}`);
}

/** The nearest ancestor that scrolls up and down. */
function scrollerOf(el) {
  for (let at = el.parentElement; at; at = at.parentElement) {
    if (at.scrollHeight > at.clientHeight && /auto|scroll/.test(getComputedStyle(at).overflowY)) return at;
  }
  return document.scrollingElement;
}

/**
 * On the Playlists page a card can be picked up and dropped on a tag above. Its cover lifts off
 * under the pointer, leans with the movement, and either drops into the tag or glides home.
 */
function liftPlaylist(e, item, card) {
  if (e.pointerType !== 'mouse' || e.button !== 0 || e.target.closest('button') || card.closest('.shelf-row')) return;
  if (!document.querySelector('.tag-chip[data-tag]')) return;
  const art = card.querySelector('.card-art');
  const start = { x: e.clientX, y: e.clientY };
  const scroller = scrollerOf(card);
  let ghost = null, over = null, tilt = 0, lastX = e.clientX, pointer = start, scrolling = 0;
  let grab = null; // where on the cover it was taken, and where the cover started

  const place = () => {
    ghost.style.translate = `${pointer.x - grab.dx}px ${pointer.y - grab.dy}px`;
    ghost.style.rotate = `${tilt}deg`;
  };

  function lift() {
    const r = art.getBoundingClientRect();
    grab = { dx: start.x - r.left, dy: start.y - r.top, left: r.left, top: r.top };
    ghost = h('div', { class: 'drag-ghost', 'aria-hidden': 'true' }, art.querySelector('.cover').cloneNode(true));
    Object.assign(ghost.style, { width: r.width + 'px', height: r.height + 'px', transformOrigin: `${grab.dx}px ${grab.dy}px` });
    document.body.append(ghost);
    place();
    // Shrinks into the hand around the point it was taken by.
    requestAnimationFrame(() => ghost.classList.add('is-lifted'));
    card.classList.add('is-lifted-away');
    document.body.classList.add('is-dragging-playlist');
    closeMenu();
  }

  // Near the top or bottom edge, the page scrolls on its own, faster the closer the pointer gets.
  function autoScroll() {
    const r = scroller.getBoundingClientRect();
    const edge = 70;
    const up = pointer.y - r.top, down = r.bottom - pointer.y;
    const speed = up < edge ? -(edge - up) / 4 : down < edge ? (edge - down) / 4 : 0;
    if (speed) scroller.scrollTop += speed;
    scrolling = requestAnimationFrame(autoScroll);
  }

  function move(ev) {
    pointer = { x: ev.clientX, y: ev.clientY };
    if (!ghost) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 8) return;
      lift();
      autoScroll();
    }
    tilt = Math.max(-9, Math.min(9, tilt * 0.7 + (ev.clientX - lastX) * 0.5));
    lastX = ev.clientX;
    place();
    const chip = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.tag-chip[data-tag]') || null;
    if (chip !== over) {
      over?.classList.remove('is-drop');
      chip?.classList.add('is-drop');
      over = chip;
      ghost.classList.toggle('is-over', !!chip);
    }
  }

  // The lean eases back upright when the pointer rests.
  const settle = setInterval(() => { if (ghost && Math.abs(tilt) > 0.1) { tilt *= 0.6; place(); } }, 60);

  function end(ev) {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    clearInterval(settle);
    cancelAnimationFrame(scrolling);
    if (!ghost) return;
    // The click that ends a drag doesn't also open the playlist.
    const eat = (c) => { c.preventDefault(); c.stopImmediatePropagation(); };
    card.addEventListener('click', eat, true);
    setTimeout(() => card.removeEventListener('click', eat, true), 0);
    document.body.classList.remove('is-dragging-playlist');
    const chip = ev.type === 'pointerup' ? over : null;
    over?.classList.remove('is-drop');
    const from = { translate: ghost.style.translate, rotate: ghost.style.rotate, scale: getComputedStyle(ghost).scale, opacity: 1 };
    ghost.classList.remove('is-lifted', 'is-over');
    ghost.classList.add('is-letting-go');
    const done = () => {
      ghost.remove();
      document.querySelectorAll('.is-lifted-away').forEach((c) => c.classList.remove('is-lifted-away'));
    };
    if (chip) {
      // Into the tag: the cover shrinks into the chip's middle, and the chip gives a little bounce.
      const r = chip.getBoundingClientRect();
      ghost.animate([from, {
        translate: `${r.left + r.width / 2 - grab.dx}px ${r.top + r.height / 2 - grab.dy}px`, rotate: '0deg', scale: 0.05, opacity: 0,
      }], { duration: 340, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' }).finished.then(done, done);
      chip.classList.remove('is-taken');
      void chip.offsetWidth;
      chip.classList.add('is-taken');
      chip.addEventListener('animationend', () => chip.classList.remove('is-taken'), { once: true });
      giveTag(item, chip.dataset.tag);
    } else {
      // Nowhere to go: it glides back to its card, settling as it lands.
      // The page may have been drawn again meanwhile, with a new card for the same playlist.
      const home = art.isConnected ? art : document.querySelector(`.card[href="${CSS.escape(item.href)}"] .card-art`);
      const r = home?.getBoundingClientRect() || { left: grab.left, top: grab.top };
      ghost.animate([from, { translate: `${r.left}px ${r.top}px`, rotate: '0deg', scale: 1, opacity: home ? 1 : 0 }],
        { duration: 420, easing: 'cubic-bezier(0.22, 1.2, 0.36, 1)', fill: 'forwards' }).finished.then(done, done);
    }
  }

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

/**
 * "Save" on a playlist's page. Once saved, it opens the pin and tag choices. Its `tagsEl` shows the
 * playlist's tags, wherever the page puts it, with a button to change them.
 */
function saveArea(playlist) {
  const area = h('span', { class: 'save-area' });
  area.playlist = playlist;
  area.tagsEl = h('div', { class: 'detail-tags' });
  drawSaveArea(area);
  return area;
}

function drawSaveArea(area) {
  const { playlist } = area;
  const saved = collection.find(playlist.href);
  const marks = collection.tagsOf(saved);
  const openTags = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    // Tagging a playlist keeps it in Tint.
    if (!collection.find(playlist.href)) collection.save(playlist);
    tagPanel(r.left, r.bottom + 6, playlist.href);
  };
  fill(area.tagsEl,
    marks.map((t) => h('button', { class: 'tag-label-btn', title: 'Change the tags', onclick: openTags }, tagLabel(t))),
    h('button', { class: 'tag-add', onclick: openTags },
      h('span', { class: 'tag-add-icon', icon: marks.length ? 'pen' : 'plus' }), marks.length ? 'Edit tags' : 'Add a tag'));
  fill(area,
    h('button', {
      class: 'btn' + (saved ? ' is-saved' : ''),
      title: saved ? 'Saved in Tint. Pin it, tag it, or remove it' : 'Keep this playlist in Tint and sync to its service',
      onclick: async (e) => {
        const now = collection.find(playlist.href);
        if (!now) {
          await saveInTint(playlist);
          return;
        }
        const r = e.currentTarget.getBoundingClientRect();
        showMenu(r.left, r.bottom + 4, savedMenuItems(r.left, r.bottom + 4, now));
      },
    }, h('span', { class: 'btn-icon', icon: saved ? 'saved' : 'bookmark' }), saved ? 'Saved' : 'Save'),
    h('button', {
      class: 'icon-btn detail-pin' + (saved?.pinned ? ' is-pinned' : ''), icon: 'pin',
      title: saved?.pinned ? 'Unpin' : 'Pin to the top', 'aria-label': saved?.pinned ? 'Unpin' : 'Pin to the top',
      'aria-pressed': String(!!saved?.pinned),
      onclick: () => {
        const now = collection.find(playlist.href);
        if (!now) collection.save(playlist);
        collection.setPinned(playlist.href, !now?.pinned);
        toast(now?.pinned ? `Unpinned "${playlist.title}"` : `Pinned "${playlist.title}" to the top`);
      },
    }));
}

collection.onChange(() => document.querySelectorAll('.save-area').forEach(drawSaveArea));

/** A playlist as the service has it now, or as it was saved in Tint when the service can't be reached. */
async function liveOrSaved(href, fetching) {
  try {
    const playlist = { ...await fetching, href };
    // A saved playlist's copy of its songs follows the playlist as it changes.
    const saved = collection.find(href);
    if (saved && playlist.tracks.length && !looksSame({ ...saved, description: playlist.description }, playlist)) {
      collection.save({ ...playlist, id: saved.id, source: saved.source });
    }
    return playlist;
  } catch (e) {
    const saved = collection.find(href);
    if (saved?.tracks?.length) return { ...saved, description: '', fromCopy: true };
    throw e;
  }
}

/** The tags above the playlists: one narrows the page to it, and takes a playlist dropped on it. */
function tagFilter(all, current, onPick, trailing = null) {
  return h('div', { class: 'tag-filter', role: 'group', 'aria-label': 'Show playlists tagged' },
    all.length ? h('button', { class: 'tag-chip', 'aria-pressed': String(!current), onclick: () => onPick(null) }, 'Any tag') : null,
    all.map((t) => tagged(h('button', {
      class: 'tag-chip', 'aria-pressed': String(current === t.id), onclick: () => onPick(current === t.id ? null : t.id),
      title: 'Show only these. Drop a playlist here to tag it', dataset: { tag: t.id },
    }, h('span', { class: 'tag-dot' }), t.name, h('span', { class: 'tag-chip-count' }, String(tagUses(t.id)))), t.color)),
    h('button', {
      class: 'tag-chip tag-chip-edit', title: 'Make, rename, recolour or delete tags',
      onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); tagPanel(r.left, r.bottom + 6, null); },
    }, h('span', { class: 'tag-add-icon', icon: all.length ? 'pen' : 'plus' }), all.length ? 'Edit tags' : 'Make a tag'),
    trailing);
}

/** A grid of covers. Only the rows of it on screen exist at any time, however many it holds. */
const grid = (items) => new VirtualGrid({ scroller: document.getElementById('scroller'), count: items.length, render: (i) => card(items[i]) }).el;

function shelf(title, items) {
  const row = h('div', { class: 'shelf-row', tabIndex: 0, 'aria-label': title }, items.map(card));
  const move = (direction) => {
    stopGlide();
    row.scrollBy({ left: direction * Math.max(170, row.clientWidth - 170), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const back = h('button', { class: 'shelf-arrow shelf-back', icon: 'back', 'aria-label': `Previous items in ${title}`, onclick: () => move(-1) });
  const next = h('button', { class: 'shelf-arrow shelf-next', icon: 'back', 'aria-label': `More items in ${title}`, onclick: () => move(1) });
  const update = () => {
    back.disabled = row.scrollLeft <= 1;
    next.disabled = row.scrollLeft + row.clientWidth >= row.scrollWidth - 1;
  };
  row.addEventListener('scroll', update, { passive: true });
  row.addEventListener('keydown', (e) => {
    if (e.target !== row || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault(); move(e.key === 'ArrowRight' ? 1 : -1);
  });
  let drag = null, suppressClick = false;
  let glide = 0;
  function stopGlide() {
    cancelAnimationFrame(glide);
    glide = 0;
    row.classList.remove('is-gliding');
  }
  /** Where the row can come to rest: at the start of each card, or at the very end. */
  function restingPoints() {
    const max = row.scrollWidth - row.clientWidth;
    const pad = parseFloat(getComputedStyle(row).scrollPaddingLeft) || 0;
    const origin = row.getBoundingClientRect().left - row.scrollLeft;
    return [...[...row.children].map((card) => card.getBoundingClientRect().left - origin - pad), max]
      .map((x) => Math.max(0, Math.min(max, x)));
  }
  /**
   * Let go of: the row coasts on at the speed it was thrown and eases to a stop at a card's edge.
   * It picks that edge itself and arrives there in one curve, so snapping never has to jump.
   */
  function release(velocity) {
    const from = row.scrollLeft;
    const v = Math.max(-3, Math.min(3, velocity));
    const projected = from + v * 300;
    const target = restingPoints().reduce((best, x) => (Math.abs(x - projected) < Math.abs(best - projected) ? x : best));
    const distance = target - from;
    if (Math.abs(distance) < 1 || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      row.scrollLeft = target;
      stopGlide();
      update();
      return;
    }
    // Ease-out cubic starts at 3 × distance / duration: matched to the throw, so it leaves the hand smoothly.
    const thrown = Math.sign(v) === Math.sign(distance) && Math.abs(v) > 0.05;
    const duration = thrown ? Math.max(320, Math.min(950, (3 * Math.abs(distance)) / Math.abs(v))) : 420;
    row.classList.add('is-gliding');
    const began = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - began) / duration);
      row.scrollLeft = from + distance * (1 - (1 - p) ** 3);
      if (!row.isConnected || p >= 1) { stopGlide(); update(); return; }
      glide = requestAnimationFrame(step);
    };
    glide = requestAnimationFrame(step);
  }
  row.addEventListener('wheel', stopGlide, { passive: true });
  row.addEventListener('dragstart', (e) => e.preventDefault(), true);
  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    stopGlide();
    suppressClick = false;
    drag = { id: e.pointerId, x: e.clientX, left: row.scrollLeft, moved: false, lastX: e.clientX, at: performance.now(), velocity: 0 };
  });
  row.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const distance = e.clientX - drag.x;
    if (!drag.moved && Math.abs(distance) < 6) return;
    const now = performance.now();
    const elapsed = now - drag.at;
    if (elapsed > 0) {
      const speed = (drag.lastX - e.clientX) / elapsed;
      drag.velocity = elapsed > 80 ? speed : drag.velocity * 0.35 + speed * 0.65;
    }
    drag.lastX = e.clientX;
    drag.at = now;
    drag.moved = true;
    row.setPointerCapture(e.pointerId);
    row.classList.add('is-dragging');
    row.scrollLeft = drag.left - distance;
    e.preventDefault();
  });
  const finish = (e) => {
    if (!drag) return;
    const { moved } = drag;
    suppressClick = moved;
    // Held still before letting go: no throw, it just settles on the nearest card.
    const velocity = moved && e.type === 'pointerup' && performance.now() - drag.at < 80 ? drag.velocity : 0;
    drag = null;
    // Snapping stays off until the row has come to rest, or the browser would jump it to a card first.
    if (moved) row.classList.add('is-gliding');
    row.classList.remove('is-dragging');
    if (moved) release(velocity);
    update();
  };
  row.addEventListener('pointerup', finish);
  row.addEventListener('pointercancel', finish);
  row.addEventListener('lostpointercapture', finish);
  row.addEventListener('pointerleave', () => { if (!drag?.moved) drag = null; });
  row.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false; e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  const el = h('section', { class: 'shelf', onpointerenter: update, onfocusin: update },
    h('h2', {}, title),
    h('div', { class: 'shelf-window' }, row, back, next));
  requestAnimationFrame(update);
  return el;
}

/** Where music can be shown from: everything, this PC, and each service that is signed in. */
function sources() {
  return [
    ['all', 'All', 'grid'],
    ['local', 'On this PC', 'pc'],
    apple.isSignedIn() && ['apple', 'Apple Music', 'appleMono'],
    youtube.isSignedIn() && ['youtube', 'YouTube Music', 'youtubeMono'],
    spotify.isSignedIn() && ['spotify', 'Spotify', 'spotifyMono'],
  ].filter(Boolean);
}

/** One kind of thing (albums, songs) from this PC and from each signed-in library, narrowed to the chosen source. */
function gather(wanted, mine, fromApple, fromYouTube, fromSpotify) {
  const choices = sources();
  const source = choices.some(([id]) => id === wanted) ? wanted : 'all';
  const parts = {
    apple: apple.isSignedIn() ? fromApple() : null,
    youtube: youtube.isSignedIn() ? fromYouTube() : null,
    spotify: spotify.isSignedIn() && fromSpotify ? fromSpotify() : null,
  };
  let items = source === 'all' || source === 'local' ? mine.slice() : [];
  for (const [name, part] of Object.entries(parts)) {
    if (part && (source === 'all' || source === name)) items = items.concat(part.items);
  }
  const notes = [
    libraryNote('Apple Music', parts.apple),
    libraryNote('YouTube Music', parts.youtube),
    libraryNote('Spotify', parts.spotify),
  ].filter(Boolean);
  return { items, source, choices, notes, remote: choices.length > 2 };
}

function libraryNote(name, part) {
  if (part?.state === 'loading') return `Still fetching your ${name} library…`;
  if (part?.state === 'error') return `${name} didn't answer: ${part.error}`;
  return null;
}

function nothingYet() {
  if (local.scanning) return emptyState('Looking through your music folders…', 'Songs appear here as they are found.');
  return emptyState('No music here yet',
    'Add a folder that holds your music, or connect Apple Music, YouTube Music or Spotify to bring in your library.',
    linkButton('Open settings', '#/settings', 'primary'));
}

// ---- Albums -------------------------------------------------------------------------------------

function albumsView() {
  const el = h('section', { class: 'page' });

  function draw() {
    const { items: found, source, choices, notes, remote } = gather(memory.albumSource, local.albums, apple.libraryAlbums, youtube.libraryAlbums, spotify.libraryAlbums);
    const items = source === 'all' && remote ? withoutDoubles(found) : found;

    const sort = memory.albumSort;
    items.sort(sort === 'title' ? (a, b) => compareText(a.title, b.title)
      : sort === 'recent' ? (a, b) => (b.added || 0) - (a.added || 0)
        : (a, b) => compareText(a.artist, b.artist) || (a.year || '').localeCompare(b.year || '') || compareText(a.title, b.title));

    fill(el,
      pageHead('Albums', [plural(items.length, 'album'), ...notes].join('. '),
        remote && segmented('Show albums from', choices, source, (v) => { memory.albumSource = v; draw(); }, { iconsOnly: true }),
        select('Sort albums by', [['artist', 'By artist'], ['title', 'By title'], ['recent', 'Recently added']], sort, (v) => { memory.albumSort = v; draw(); })),
      items.length ? grid(items) : nothingYet());
  }

  draw();
  return { el, refresh: (why) => { if (why !== 'track') draw(); } };
}

/** When an album is on this PC and in a streaming library, or in both libraries, show the fuller copy once. */
function withoutDoubles(items) {
  const best = new Map();
  for (const item of items) {
    const key = `${item.artist}\u0001${item.title}`.toLowerCase();
    const seen = best.get(key);
    if (!seen || (item.count || 0) > (seen.count || 0)) best.set(key, item);
  }
  return [...best.values()];
}

// ---- Songs --------------------------------------------------------------------------------------

function songsView({ scroller }) {
  const el = h('section', { class: 'page' });
  let list = null;
  let shown = [];

  function collect() {
    const { items, source, choices, notes, remote } = gather(memory.songSource, local.tracks, apple.librarySongs, youtube.librarySongs, spotify.librarySongs);
    const sort = memory.songSort;
    items.sort(sort === 'title' ? (a, b) => compareText(a.title, b.title)
      : sort === 'recent' ? (a, b) => (b.added || 0) - (a.added || 0)
        : (a, b) => compareText(a.artist, b.artist) || compareText(a.album, b.album) || a.discNo - b.discNo || a.trackNo - b.trackNo);
    return { items, source, choices, notes, remote, sort };
  }

  function draw() {
    const { items, source, choices, notes, remote, sort } = collect();
    shown = items;
    list?.destroy();
    list = items.length ? trackList(scroller, items) : null;
    fill(el,
      pageHead('Songs', [plural(items.length, 'song'), ...notes].join('. '),
        items.length > 1 && button('Shuffle all', () => player.playList(shown, 0, { shuffle: true })),
        remote && segmented('Show songs from', choices, source, (v) => { memory.songSource = v; draw(); }, { iconsOnly: true }),
        select('Sort songs by', [['artist', 'By artist'], ['title', 'By title'], ['recent', 'Recently added']], sort, (v) => { memory.songSort = v; draw(); })),
      list ? list.el : nothingYet());
  }

  draw();
  return {
    el,
    refresh: (why) => { if (why === 'track') list?.refresh(); else draw(); },
    destroy: () => list?.destroy(),
  };
}

// ---- Playlists ----------------------------------------------------------------------------------

function connectPrompt(title) {
  const status = apple.getStatus();
  if (status === 'ready') {
    return emptyState(title, 'Sign in with the Apple Account that has your Apple Music subscription.',
      button('Sign in to Apple Music', () => apple.signIn().catch((e) => toast(e?.message || 'Sign-in was cancelled.')), 'primary'));
  }
  if (status === 'loading') return loading("Getting Apple's player ready…");
  return emptyState(title, apple.getProblem() || 'Apple Music needs a one-time setup before it can play here.',
    linkButton('Set up Apple Music', '#/settings', 'primary'));
}

function playlistsView() {
  const el = h('section', { class: 'page' });
  function draw() {
    const openNewPlaylist = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      playlistPanel(r.right - 312, r.bottom + 6, null, { anchor: r });
    };
    const parts = [
      apple.isSignedIn() && ['Apple Music', apple.libraryPlaylists()],
      youtube.isSignedIn() && ['YouTube Music', youtube.libraryPlaylists()],
      spotify.isSignedIn() && ['Spotify', spotify.libraryPlaylists()],
    ].filter(Boolean);
    const unifiedLiked = likes.likedCard();
    const savedRaw = collection.items().filter((item) => item.href !== likes.LIKED_HREF);
    const saved = unifiedLiked ? [unifiedLiked, ...savedRaw] : savedRaw;
    if (!parts.length && !saved.length) {
      const newPlaylistBtn = h('button', { class: 'btn', onclick: openNewPlaylist },
        h('span', { class: 'btn-icon', icon: 'plus' }), 'New playlist');
      fill(el, pageHead('Playlists', null, newPlaylistBtn), connectPrompt('Your playlists live in Apple Music, YouTube Music and Spotify'),
        h('p', { class: 'quiet' }, 'Or make a playlist in Tint above, like any song, or paste a YouTube or Spotify playlist link in the search box.'));
      return;
    }
    // The list can be narrowed to the playlists saved in Tint, or to one service's.
    const serviceIcon = { 'Apple Music': 'appleMono', 'YouTube Music': 'youtubeMono', Spotify: 'spotifyMono' };
    const choices = [
      ['all', 'All', 'grid'],
      saved.length && ['saved', 'Saved in Tint', 'bookmark'],
      ...parts.map(([name]) => [name, name, serviceIcon[name] || 'grid']),
    ].filter(Boolean);
    const source = choices.some(([id]) => id === memory.playlistSource) ? memory.playlistSource : 'all';
    // A saved playlist stands in for the same one in a service's library, so it shows once.
    const savedHere = new Set(saved.map((item) => item.href));
    let items = [
      ...(source === 'all' || source === 'saved' ? saved : []),
      ...parts.filter(([name]) => source === 'all' || source === name).flatMap(([, part]) => part.items)
        .filter((item) => !likes.isPlatformLikedPlaylist(item))
        .filter((item) => source !== 'all' || !savedHere.has(item.href)),
    ];
    const allTags = collection.tags();
    const tagWanted = allTags.some((t) => t.id === memory.playlistTag) ? memory.playlistTag : null;
    if (tagWanted) items = items.filter((item) => collection.find(item.href)?.tags?.includes(tagWanted));
    items.sort((a, b) => compareText(a.title, b.title));
    // Pinned playlists come first, in the order they were pinned.
    const isPinned = (item) => (item.href === likes.LIKED_HREF ? item.pinned : !!collection.find(item.href)?.pinned);
    const pinnedAt = (item) => (item.href === likes.LIKED_HREF ? (item.pinnedAt || 1) : (collection.find(item.href)?.pinnedAt || 0));
    const pinned = items.filter(isPinned).sort((a, b) => pinnedAt(a) - pinnedAt(b));
    const rest = items.filter((item) => !pinned.includes(item));

    const notes = parts.map(([name, part]) => libraryNote(name, part)).filter(Boolean);
    const waiting = parts.some(([, part]) => part.state === 'idle' || part.state === 'loading');
    const ordered = [...pinned, ...rest];
    let body;
    if (ordered.length) body = grid(ordered);
    else if (tagWanted) body = emptyState(`Nothing tagged "${collection.tag(tagWanted).name}"`, 'Drag a playlist onto this tag above, or right-click it and choose Tags….');
    else if (waiting) body = loading();
    else body = emptyState('No playlists yet', 'Playlists you make in Apple Music, Spotify or YouTube Music, or save in Tint, show up here. Paste a YouTube or Spotify playlist link in the search box to open one.');
    const showFilterBar = !!(allTags.length || items.length);
    const newPlaylistBtn = h('button', {
      class: showFilterBar ? 'btn tag-filter-end' : 'btn',
      onclick: openNewPlaylist,
    }, h('span', { class: 'btn-icon', icon: 'plus' }), 'New playlist');
    fill(el,
      pageHead('Playlists', [plural(items.length, 'playlist'), ...notes].join('. '),
        !showFilterBar && newPlaylistBtn,
        choices.length > 2 && segmented('Show playlists from', choices, source, (v) => { memory.playlistSource = v; draw(); }, { iconsOnly: true })),
      showFilterBar ? tagFilter(allTags, tagWanted, (id) => { memory.playlistTag = id; draw(); }, newPlaylistBtn) : null,
      body);
  }
  draw();
  return { el, refresh: (why) => { if (why !== 'track') draw(); } };
}

// ---- Home ---------------------------------------------------------------------------------------

/** The page Tint opens on: pinned playlists, what was played lately, and what's new. */
function startView({ scroller }) {
  const el = h('section', { class: 'page' });
  let parts = [];
  let firstPlayed = null;

  function greeting() {
    const hour = new Date().getHours();
    return hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  }

  function draw() {
    parts.forEach((p) => p.destroy());
    parts = [];
    const unifiedLiked = likes.likedCard();
    const savedRaw = collection.items().filter((item) => item.href !== likes.LIKED_HREF);
    const saved = unifiedLiked ? [unifiedLiked, ...savedRaw] : savedRaw;
    const pinned = saved.filter((item) => item.pinned).sort((a, b) => (a.pinnedAt || 0) - (b.pinnedAt || 0));
    const lately = saved.filter((item) => !item.pinned).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, 14);
    const played = history.songs().slice(0, 8);
    const added = local.albums.filter((album) => album.added).sort((a, b) => b.added - a.added).slice(0, 14);
    firstPlayed = played[0]?.id || null;

    const nodes = [pageHead(greeting())];
    if (pinned.length) nodes.push(shelf('Pinned', pinned));
    if (played.length) {
      const list = trackList(scroller, played);
      parts.push(list);
      nodes.push(h('section', { class: 'shelf' }, h('h2', {}, 'Played lately'), list.el));
    }
    if (lately.length) nodes.push(shelf('Saved in Tint', lately));
    if (added.length) nodes.push(shelf('Added to this PC lately', added));
    if (nodes.length === 1) {
      nodes.push(emptyState('Welcome to Tint',
        'Play something and it shows up here. Paste a YouTube playlist link in the search box to open it, then save and pin it to keep it on this page.',
        linkButton('Browse albums', '#/albums', 'primary'), linkButton('Playlists', '#/playlists')));
    } else if (!pinned.length) {
      nodes.splice(1, 0, h('p', { class: 'quiet home-hint' }, 'Pin a saved playlist and it stays at the top of this page.'));
    }
    fill(el, ...nodes);
  }

  draw();
  return {
    el,
    refresh: (why) => {
      // A new song only redraws the page when it changes what was played lately.
      if (why === 'track' && history.songs()[0]?.id === firstPlayed) parts.forEach((p) => p.refresh());
      else if (why === 'track' || why === 'collection' || why === 'local' || why === 'apple' || why === 'youtube' || why === 'spotify') draw();
    },
    destroy: () => parts.forEach((p) => p.destroy()),
  };
}

// ---- Listen now ---------------------------------------------------------------------------------

function homeView() {
  const el = h('section', { class: 'page' });
  let asked = false;

  async function draw() {
    if (!apple.isSignedIn()) {
      asked = false;
      fill(el, pageHead('Listen now'), connectPrompt('Picks for you come from Apple Music'));
      return;
    }
    if (asked) return;
    asked = true;
    fill(el, pageHead('Listen now'), loading());
    try {
      const shelves = await apple.home();
      fill(el, pageHead('Listen now'),
        shelves.length ? shelves.map((s) => shelf(s.title, s.items))
          : emptyState('Nothing to suggest yet', 'Play a few things and Apple Music will start making picks.'));
      replay(el, 'arrive');
    } catch (e) {
      fill(el, pageHead('Listen now'), failure(e, () => { asked = false; draw(); }));
    }
  }

  draw();
  return { el, refresh: (why) => { if (why === 'apple') draw(); } };
}

// ---- Album, playlist ----------------------------------------------------------------------------

function detailHead({ art, artEl, kind, title, byline, bylineHref, facts, description, tracks, saveAs, extra, extraMenu }) {
  const playable = tracks.filter((t) => t.playable !== false);
  const save = saveAs && saveArea(saveAs);
  const moreDisabled = !playable.length && !extraMenu?.length;
  return h('header', { class: 'detail-head' },
    h('div', { class: 'detail-art' }, artEl || cover(art, 240, { lazy: false })),
    h('div', { class: 'detail-text' },
      h('p', { class: 'quiet' }, kind),
      h('h1', { class: title.length > 38 ? 'is-long' : '' }, title),
      byline && (bylineHref ? h('a', { class: 'detail-by', href: bylineHref }, byline) : h('p', { class: 'detail-by' }, byline)),
      facts && h('p', { class: 'quiet' }, facts),
      description && h('p', { class: 'detail-desc' }, description),
      save?.tagsEl,
      h('div', { class: 'detail-actions' },
        h('button', { class: 'btn primary', disabled: !playable.length, onclick: () => { player.playList(tracks, 0, { shuffle: false }); pagecache.used(location.hash); } },
          h('span', { class: 'btn-icon', icon: 'play' }), 'Play'),
        h('button', { class: 'btn', disabled: playable.length < 2, onclick: () => { player.playList(tracks, 0, { shuffle: true }); pagecache.used(location.hash); } },
          h('span', { class: 'btn-icon', icon: 'shuffle' }), 'Shuffle'),
        save,
        extra,
        h('button', {
          class: 'icon-btn', icon: 'more', 'aria-label': 'More', title: 'More', disabled: moreDisabled,
          onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const items = [
              playable.length && { icon: 'listPlus', label: 'Add all to playlist…', run: () => playlistPanel(r.left, r.bottom + 4, playable) },
              playable.length && { icon: 'listStart', label: 'Play next', run: () => { player.playNext(tracks); toast(`"${title}" plays next`); } },
              playable.length && { icon: 'listEnd', label: 'Add to queue', run: () => { player.addToQueue(tracks); toast(`Added "${title}" to the queue`); } },
              playable.length && { sep: true },
              { icon: 'copy', label: 'Copy title', run: () => copyText(title, 'Title copied') },
              ...(extraMenu ? [{ sep: true }, ...extraMenu(r)] : []),
            ];
            showMenu(r.left, r.bottom + 4, items);
          },
        }))));
}

// An album from someone's own library doesn't say which artist page is its artist's; the artist
// page finds it by name instead (artist.js).
const byName = (artist) => (artist ? `#/artist/l/${encodeURIComponent(artist)}` : null);

function albumFacts(album, tracks) {
  const length = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  return [album.year, plural(tracks.length, 'song'), length ? fmtLength(length) : null].filter(Boolean).join(', ');
}

/** Album pages number their rows; a line marks each new disc when there is more than one. */
function albumBody(scroller, tracks, albumArtist) {
  const options = { numbered: true, showAlbum: false, albumArtist };
  const discs = [...new Set(tracks.map((t) => t.discNo || 1))];
  if (discs.length < 2) return [trackList(scroller, tracks, options)];
  return discs.map((disc) => {
    const only = tracks.map((t, i) => ((t.discNo || 1) === disc ? i : -1)).filter((i) => i >= 0);
    const list = trackList(scroller, tracks, { ...options, only });
    return { el: h('section', { class: 'disc' }, h('h2', {}, `Disc ${disc}`), list.el), refresh: list.refresh, destroy: list.destroy };
  });
}

function localAlbumView({ scroller, params }) {
  const el = h('section', { class: 'page' });
  let parts = [];

  function draw() {
    parts.forEach((p) => p.destroy());
    parts = [];
    const album = local.byAlbum.get(params[0]);
    if (!album) {
      fill(el, local.loaded
        ? emptyState("This album isn't on this PC any more", 'Its files may have been moved or deleted.', linkButton('Back to albums', '#/albums'))
        : loading());
      return;
    }
    parts = albumBody(scroller, album.tracks, album.artist);
    fill(el,
      detailHead({
        art: album.art, kind: 'Album on this PC', title: album.title, byline: album.artist,
        bylineHref: byName(album.artist),
        facts: albumFacts(album, album.tracks), tracks: album.tracks,
      }),
      parts.map((p) => p.el));
  }

  draw();
  return {
    el,
    refresh: (why) => { if (why === 'track' || why === 'collection') parts.forEach((p) => p.refresh()); else if (why === 'local') draw(); },
    destroy: () => parts.forEach((p) => p.destroy()),
  };
}

/**
 * A page that has to fetch before it can draw. `build(data)` returns { nodes, parts }.
 * Apple Music pages offer to set Apple Music up when it isn't; YouTube pages need no setup to read.
 */
/**
 * A playlist, album or artist page opens in a quick cascade: the cover grows into place, the words
 * beside it rise line by line, and the first songs follow.
 */
function opening(el) {
  el.classList.remove('arrive', 'opening');
  el.querySelectorAll('.detail-text > *').forEach((line, i) => line.style.setProperty('--i', i));
  // A long list draws its rows in the next frame (VirtualList), so they're numbered then, before it's shown.
  const number = () => el.querySelectorAll('.tracks .row').forEach((row, i) => row.style.setProperty('--i', Math.min(i, 12)));
  number();
  requestAnimationFrame(number);
  void el.offsetWidth;
  el.classList.add('opening');
  // Rows a long list draws later, as it scrolls, simply appear.
  setTimeout(() => el.classList.remove('opening'), 900);
}

/** Whether two answers for a page would look the same on screen (a saved copy also carries its pin and tags). */
function looksSame(a, b) {
  const seen = (d) => JSON.stringify([d.title, d.artist, d.art, d.description || '', d.year,
    (d.tracks || []).map((t) => [t.id, t.title, t.artist, t.album, t.duration, t.art, t.playable, t.explicit])]);
  return seen(a) === seen(b);
}

/**
 * A page that has to ask a service first. With `cacheKey` (the page's address) a copy kept from an
 * earlier visit, or a playlist saved in Tint, shows at once; the service's answer then replaces it
 * quietly if anything changed, and is kept for next time.
 */
function asyncView(fetcher, build, { needsApple = true, cacheKey = null, waiting = loading } = {}) {
  const el = h('section', { class: 'page' }, waiting());
  let parts = [];
  let alive = true;
  let settledAt = 0; // when the page's opening animation will have finished

  function show(data, animate) {
    parts.forEach((p) => p.destroy());
    const built = build(data);
    parts = built.parts || [];
    fill(el, ...built.nodes);
    // A quiet swap draws its rows now rather than a frame later, so the list never shows empty.
    if (!animate) parts.forEach((p) => p.refresh());
    if (!animate) return;
    settledAt = performance.now() + 900;
    if (el.querySelector('.detail-head')) opening(el);
    else replay(el, 'arrive');
  }

  async function run() {
    let early = null;
    if (cacheKey) {
      const saved = collection.find(cacheKey);
      early = await pagecache.read(cacheKey) || (saved?.tracks?.length ? { ...saved, description: '' } : null);
      if (!alive) return;
    }
    if (early) show(early, true);
    else fill(el, waiting());
    try {
      const data = await fetcher();
      if (!alive) return;
      if (cacheKey && !data.fromCopy) pagecache.keep(cacheKey, data);
      if (!early) { show(data, true); return; }
      if (looksSame(early, data)) return;
      // Something changed: swapped in once the page has finished opening, and without opening again.
      const wait = settledAt - performance.now();
      if (wait > 0) await new Promise((done) => setTimeout(done, wait));
      if (!alive) return;
      el.classList.remove('opening', 'arrive');
      show(data, false);
    } catch (e) {
      // With a copy already on screen, it stays; the service is asked again next visit.
      if (alive && !early) fill(el, !needsApple || apple.instance() ? failure(e, run) : connectPrompt('This comes from Apple Music'));
    }
  }

  run();
  return {
    el,
    refresh: (why) => { if (why === 'track' || why === 'collection') parts.forEach((p) => p.refresh()); },
    destroy: () => { alive = false; parts.forEach((p) => p.destroy()); },
  };
}

function appleAlbumView({ scroller, params }) {
  return asyncView(() => apple.album(params[0]), (album) => {
    const parts = albumBody(scroller, album.tracks, album.artist);
    apple.findEnglishTitles(album.tracks).then((found) => { if (found) parts.forEach((p) => p.refresh()); });
    return {
      parts,
      nodes: [
        detailHead({
          art: album.art, kind: 'Album', title: album.title, byline: album.artist, bylineHref: album.artistHref || byName(album.artist),
          facts: albumFacts(album, album.tracks), tracks: album.tracks,
        }),
        ...parts.map((p) => p.el),
      ],
    };
  }, { cacheKey: `#/album/a/${encodeURIComponent(params[0])}` });
}

function applePlaylistView({ scroller, params }) {
  const href = `#/playlist/a/${encodeURIComponent(params[0])}`;
  // Saved in Tint, it opens as it was saved and Apple Music is asked only when Refresh is pressed.
  const saved = collection.find(href)?.tracks?.length ? collection.find(href) : null;
  const fetching = saved
    ? async () => ({ ...(collection.find(href) || saved), description: '' })
    : () => liveOrSaved(href, apple.playlist(params[0]));
  return asyncView(fetching, (playlist) => {
    const list = trackList(scroller, playlist.tracks);
    const length = playlist.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    return {
      parts: [list],
      nodes: [
        detailHead({
          art: playlist.art || playlist.tracks[0]?.art, kind: playlist.fromCopy ? 'Playlist (the copy saved in Tint)' : 'Playlist',
          title: playlist.title, byline: playlist.artist,
          facts: [plural(playlist.tracks.length, 'song'), length ? fmtLength(length) : null].filter(Boolean).join(', '),
          description: playlist.description, tracks: playlist.tracks,
          saveAs: { id: params[0], source: 'apple', ...playlist, href },
          extra: saved ? refreshButton(href) : null,
        }),
        playlist.tracks.length ? list.el : emptyState('This playlist is empty'),
      ],
    };
  }, { cacheKey: saved ? null : href, needsApple: !saved });
}

function youtubeAlbumView({ scroller, params }) {
  youtube.warm();
  return asyncView(() => youtube.album(params[0]), (album) => {
    const parts = albumBody(scroller, album.tracks, album.artist);
    return {
      parts,
      nodes: [
        detailHead({
          art: album.art, kind: 'Album on YouTube Music', title: album.title, byline: album.artist, bylineHref: album.artistHref || byName(album.artist),
          facts: albumFacts(album, album.tracks), tracks: album.tracks,
        }),
        ...parts.map((p) => p.el),
      ],
    };
  }, { needsApple: false, cacheKey: `#/album/y/${encodeURIComponent(params[0])}` });
}

/** The playlist whose link was just pasted in the search box, so its page can say so. */
let pastedPlaylist = null;
export const notePasted = (id) => { pastedPlaylist = id; };

function youtubePlaylistView({ scroller, params }) {
  const href = `#/playlist/y/${encodeURIComponent(params[0])}`;
  const pasted = pastedPlaylist === params[0];
  pastedPlaylist = null;
  const fromLink = () => pastedNote('youtube', 'From the YouTube playlist link you pasted', 'Play it here, or save it to keep it in Tint');
  // A pasted playlist link lands here even with YouTube Music switched off.
  if (!youtube.isReady()) {
    return { el: h('section', { class: 'page' }, pageHead('Playlist'),
      emptyState('YouTube Music is off', 'Switch on YouTube Music in Settings to open and play playlists from YouTube.', linkButton('Open settings', '#/settings', 'primary'))) };
  }
  youtube.warm();
  // Saved in Tint, it opens as it was saved and YouTube Music is asked only when Refresh is pressed.
  const saved = collection.find(href)?.tracks?.length ? collection.find(href) : null;
  const fetching = saved
    ? async () => ({ ...(collection.find(href) || saved), description: '' })
    : () => liveOrSaved(href, youtube.playlist(params[0]));
  return asyncView(fetching, (playlist) => {
    const canEdit = youtube.isSignedIn() && params[0] !== 'VLLM';
    const list = trackList(scroller, playlist.tracks, canEdit ? {
      playlistSource: 'youtube',
      playlistId: params[0],
      onRemoved: (gone) => {
        playlist.tracks = playlist.tracks.filter((t) => t.id !== gone.id);
        pagecache.keep(href, { ...playlist, href });
        if (collection.find(href)) collection.save({ ...collection.find(href), tracks: playlist.tracks });
        reopen(href);
      },
    } : {});
    const length = playlist.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    return {
      parts: [list],
      nodes: [
        pasted ? fromLink() : null,
        detailHead({
          art: playlist.art, kind: playlist.fromCopy ? 'Playlist (the copy saved in Tint)' : 'Playlist on YouTube Music',
          title: playlist.title, byline: playlist.artist,
          facts: [plural(playlist.tracks.length, 'song'), length ? fmtLength(length) : null].filter(Boolean).join(', '),
          description: playlist.description, tracks: playlist.tracks,
          saveAs: { id: params[0], source: 'youtube', ...playlist, href },
          extra: saved ? refreshButton(href) : null,
        }),
        playlist.tracks.length ? list.el : emptyState('This playlist is empty'),
      ],
    };
  }, {
    needsApple: false, cacheKey: saved ? null : href,
    waiting: () => (pasted
      ? h('div', { class: 'link-opening' }, pastedNote('youtube', 'YouTube playlist link', 'Opening the playlist…'), h('div', { class: 'match-progress-bar is-busy' }, h('span')))
      : loading()),
  });
}

const SERVICE_NAMES = { apple: 'Apple Music', youtube: 'YouTube Music', spotify: 'Spotify' };

function spotifyAlbumView({ scroller, params }) {
  if (!spotify.isSignedIn()) {
    return {
      el: h('section', { class: 'page' }, pageHead('Album'),
        emptyState('Sign in to Spotify', 'Connect your Spotify Premium account in Settings to open Spotify albums.', linkButton('Open settings', '#/settings/spotify', 'primary'))),
    };
  }
  return asyncView(() => spotify.album(params[0]), (album) => {
    const parts = albumBody(scroller, album.tracks, album.artist);
    return {
      parts,
      nodes: [
        detailHead({
          art: album.art, kind: 'Album on Spotify', title: album.title, byline: album.artist, bylineHref: album.artistHref || byName(album.artist),
          facts: albumFacts(album, album.tracks), tracks: album.tracks,
        }),
        ...parts.map((p) => p.el),
      ],
    };
  }, { needsApple: false, cacheKey: `#/album/s/${encodeURIComponent(params[0])}` });
}

function spotifyPlaylistView({ scroller, params }) {
  const href = `#/playlist/s/${encodeURIComponent(params[0])}`;
  const saved = collection.find(href)?.tracks?.length ? collection.find(href) : null;
  if (!spotify.isSignedIn() && !saved) {
    return {
      el: h('section', { class: 'page' }, pageHead('Playlist'),
        emptyState('Sign in to Spotify', 'Connect your Spotify Premium account in Settings to open and play Spotify playlists.', linkButton('Open settings', '#/settings/spotify', 'primary'))),
    };
  }
  const fetching = saved
    ? async () => ({ ...(collection.find(href) || saved), description: '' })
    : () => liveOrSaved(href, spotify.playlist(params[0]));
  return asyncView(fetching, (playlist) => {
    const canEdit = spotify.isSignedIn() && spotify.editablePlaylists().some((p) => p.id === params[0]);
    const list = trackList(scroller, playlist.tracks, canEdit ? {
      playlistSource: 'spotify',
      playlistId: params[0],
      onRemoved: (gone) => {
        playlist.tracks = playlist.tracks.filter((t) => t.id !== gone.id);
        pagecache.keep(href, { ...playlist, href });
        if (collection.find(href)) collection.save({ ...collection.find(href), tracks: playlist.tracks });
        reopen(href);
      },
    } : {});
    const length = playlist.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    return {
      parts: [list],
      nodes: [
        detailHead({
          art: playlist.art || playlist.tracks[0]?.art,
          kind: playlist.fromCopy ? 'Playlist (the copy saved in Tint)' : 'Playlist on Spotify',
          title: playlist.title, byline: playlist.artist,
          facts: [plural(playlist.tracks.length, 'song'), length ? fmtLength(length) : null].filter(Boolean).join(', '),
          description: playlist.description, tracks: playlist.tracks,
          saveAs: { id: params[0], source: 'spotify', ...playlist, href },
          extra: saved ? refreshButton(href) : null,
        }),
        playlist.tracks.length ? list.el : emptyState('This playlist is empty'),
      ],
    };
  }, { needsApple: false, cacheKey: saved ? null : href });
}

/** A playlist made in Tint itself (unified Liked songs, custom playlists, or saved from Spotify): reacts live. */
function tintPlaylistView({ scroller, params }) {
  const href = `#/playlist/t/${encodeURIComponent(params[0])}`;
  const isLikedPage = href === likes.LIKED_HREF;
  const el = h('section', { class: 'page' });
  let list = null;
  let likedFilter = 'all';

  if (isLikedPage) likes.warm();

  function draw() {
    list?.destroy();
    list = null;

    if (isLikedPage) {
      const info = likes.merged({ source: likedFilter });
      const filterChoices = [
        ['all', 'All liked', 'grid'],
        info.counts.local > 0 && ['local', 'On this PC', 'pc'],
        apple.isSignedIn() && ['apple', 'Apple Music', 'appleMono'],
        youtube.isSignedIn() && ['youtube', 'YouTube Music', 'youtubeMono'],
        spotify.isSignedIn() && ['spotify', 'Spotify', 'spotifyMono'],
      ].filter(Boolean);
      if (!filterChoices.some(([id]) => id === likedFilter)) likedFilter = 'all';
      const tracks = likes.merged({ source: likedFilter }).tracks;
      const length = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
      const loadingNote = info.loading.length ? `Syncing ${info.loading.join(', ')}…` : null;
      const sourceText = info.activeSources.length ? `Merged from ${info.activeSources.join(', ')}` : 'In Tint';
      const facts = [plural(tracks.length, 'song'), length ? fmtLength(length) : null, loadingNote].filter(Boolean).join(' · ');
      const showSource = filterChoices.length > 2;
      list = tracks.length ? trackList(scroller, tracks, { playlistHref: href, showSource }) : null;

      fill(el,
        detailHead({
          artEl: playlistArt({ href, kind: 'liked' }, 240, { lazy: false }),
          kind: 'Unified Liked songs',
          title: 'Liked songs',
          byline: sourceText,
          facts,
          tracks,
          extra: filterChoices.length > 2
            ? segmented('Show liked songs from', filterChoices, likedFilter, (v) => { likedFilter = v; draw(); }, { iconsOnly: true })
            : null,
        }),
        list ? list.el
          : info.loading.length ? loading(`Syncing liked songs from ${info.loading.join(', ')}…`)
            : emptyState('No liked songs yet', 'Click the heart on any song to like it — likes sync with Apple Music, YouTube Music and Spotify automatically.'));
      return;
    }

    const playlist = collection.find(href);
    if (!playlist) {
      fill(el, emptyState('This playlist is no longer in Tint', 'It may have been deleted or cleared.', linkButton('Back to playlists', '#/playlists')));
      return;
    }
    const isCustom = !playlist.from;
    const tracks = playlist.tracks || [];
    list = tracks.length ? trackList(scroller, tracks, { playlistHref: href }) : null;
    const length = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    const from = playlist.from?.kind === 'spotify'
      ? `Made from a Spotify ${playlist.from.what === 'album' ? 'album' : 'playlist'}, with its songs found on ${SERVICE_NAMES[playlist.from.service] || 'Apple Music and YouTube Music'}.`
      : '';
    const extraMenu = isCustom
      ? (r) => [
        { icon: 'pen', label: 'Rename playlist…', run: () => renamePlaylistPanel(r.left, r.bottom + 4, playlist) },
        {
          icon: 'trash',
          label: 'Delete playlist',
          danger: true,
          run: () => {
            collection.remove(href);
            toast(`Deleted "${playlist.title}"`);
            location.hash = '#/playlists';
          },
        },
      ]
      : null;

    fill(el,
      detailHead({
        art: playlist.art || tracks[0]?.art,
        kind: 'Playlist in Tint',
        title: playlist.title,
        byline: playlist.artist,
        facts: [plural(tracks.length, 'song'), length ? fmtLength(length) : null].filter(Boolean).join(', '),
        description: from,
        tracks,
        saveAs: playlist,
        extra: playlist.from?.kind === 'spotify' && playlist.from.url ? refreshButton(href) : null,
        extraMenu,
      }),
      list ? list.el : emptyState('This playlist is empty', 'Right-click any song or album and choose Add to playlist… to put songs here.'));
  }

  draw();
  return {
    el,
    refresh: (why) => {
      if (why === 'track') list?.refresh();
      else if (why === 'collection' || (isLikedPage && (why === 'apple' || why === 'youtube' || why === 'spotify'))) draw();
    },
    destroy: () => list?.destroy(),
  };
}

// ---- Artists ------------------------------------------------------------------------------------

/**
 * One artist page, whichever service it was opened from, or this PC (artist.js puts it together).
 * The discography is Apple Music's when Apple Music is set up; YouTube Music's otherwise.
 */
function artistView(kind) {
  return ({ scroller, params }) => {
    const ref = kind === 'a' ? { apple: params[0] } : kind === 'y' ? { youtube: params[0] } : kind === 's' ? { spotify: params[0] } : { name: params[0] };
    if (youtube.isReady()) youtube.warm();
    return asyncView(() => artistProfile(ref), (artist) => {
      const parts = [];
      const songList = (tracks) => { const list = trackList(scroller, tracks); parts.push(list); return list.el; };
      const top = artist.songs.slice(0, 10);
      const mine = artist.local;
      const section = (title, ...body) => h('section', { class: 'shelf' }, h('h2', {}, title), body);
      const nodes = [
        artistHead(artist, top.length ? artist.songs : mine.songs),
        top.length ? section('Top songs', songList(top)) : null,
        mine.albums.length ? section('On this PC', grid(mine.albums)) : null,
        !top.length && mine.songs.length ? section(mine.albums.length ? 'Songs on this PC' : 'On this PC', songList(mine.songs)) : null,
        ...artist.sections.filter(([, items]) => items.length)
          .map(([title, items]) => (title === 'Albums' ? section(title, grid(items)) : shelf(title, items))),
        artist.similar.length ? shelf('Similar artists', artist.similar) : null,
      ].filter(Boolean);
      if (nodes.length === 1) nodes.push(emptyState('Nothing by this artist yet', kind === 'l'
        ? 'Nothing by this artist is on this PC any more.'
        : 'No connected streaming service lists anything by this artist.'));
      const from = [artist.from.apple && 'Apple Music', artist.from.spotify && 'Spotify', artist.from.youtube && 'YouTube Music'].filter(Boolean);
      if (from.length) nodes.push(h('p', { class: 'quiet artist-from' }, `From ${from.join(', ')}.`));
      return { parts, nodes };
    }, { needsApple: false });
  };
}

function artistHead(artist, tracks) {
  const playable = tracks.filter((t) => t.playable !== false);
  const facts = [artist.genres.slice(0, 2).join(', '), artist.audience,
    artist.subscribers && `${artist.subscribers} subscribers`].filter(Boolean).join(' · ');
  // The "About" text is cut to three lines until it is clicked.
  const about = artist.about && h('p', {
    class: 'detail-desc artist-about', title: 'Show all',
    onclick: (e) => { e.currentTarget.classList.toggle('is-open'); e.currentTarget.title = ''; },
  }, artist.about);
  return h('header', { class: 'detail-head artist-head' },
    h('div', { class: 'detail-art' }, cover(artist.art, 240, { lazy: false })),
    h('div', { class: 'detail-text' },
      h('p', { class: 'quiet' }, 'Artist'),
      h('h1', { class: artist.name.length > 38 ? 'is-long' : '' }, artist.name),
      facts && h('p', { class: 'quiet' }, facts),
      about,
      artist.aboutFrom && h('p', { class: 'quiet artist-credit' }, artist.aboutFrom),
      h('div', { class: 'detail-actions' },
        h('button', { class: 'btn primary', disabled: !playable.length, onclick: () => player.playList(tracks, 0, { shuffle: false }) },
          h('span', { class: 'btn-icon', icon: 'play' }), 'Play'),
        h('button', { class: 'btn', disabled: playable.length < 2, onclick: () => player.playList(tracks, 0, { shuffle: true }) },
          h('span', { class: 'btn-icon', icon: 'shuffle' }), 'Shuffle'))));
}

// ---- Search -------------------------------------------------------------------------------------

function searchView({ scroller, params }) {
  const term = (params[0] || '').trim();
  const el = h('section', { class: 'page' });
  let parts = [];
  let remote = null; // null = not asked, 'loading', { ...results }, or an Error
  let tube = null;   // the same, for YouTube Music
  let spot = null;   // the same, for Spotify
  // A pasted YouTube link: the song it points at goes first, then the rest found by its name.
  const linked = youtube.videoIn(term);
  let fromLink = linked ? 'loading' : null;
  // A pasted Spotify link: native track when signed in, or matched to Apple/YouTube when signed out.
  const spotted = linked ? null : spotify.linkIn(term);
  let fromSpotify = spotted ? 'loading' : null; // then null (nothing there), an Error, or what spotifyFound() takes
  let nativeSpotifyTrack = null; // playable native Spotify track when signed in & link is a track
  let matchRun = 0; // a new search for a list's songs makes the one before stop
  let query = linked || spotted ? '' : term;
  let alive = true;
  // When each section of results first appeared, so it rises in once and isn't replayed when
  // later results (another service answering) redraw the page.
  const arrived = new Map();
  const REVEAL_MS = 1200;

  function reveal() {
    const now = performance.now();
    for (const node of el.children) {
      const key = node.matches('.shelf, .empty') && (node.querySelector('h2')?.textContent || node.className);
      if (!key) continue;
      if (!arrived.has(key)) arrived.set(key, now);
      const past = now - arrived.get(key);
      if (past > REVEAL_MS) continue;
      // A section redrawn mid-rise carries on from where it was.
      node.style.setProperty('--past', `${Math.round(past)}ms`);
      node.classList.add('reveal');
      const number = () => node.querySelectorAll('.row, .card').forEach((item, i) => item.style.setProperty('--i', Math.min(i, 14)));
      number();
      // Lists and grids draw what's on screen a frame later.
      requestAnimationFrame(number);
      // Once risen, rows a long list draws later as it scrolls simply appear.
      setTimeout(() => node.classList.remove('reveal'), REVEAL_MS - past);
    }
  }

  function draw() {
    parts.forEach((p) => p.destroy());
    parts = [];
    if (!term) {
      fill(el, pageHead('Search'), emptyState('Search your music', 'Type a song, an album or an artist in the box above.'));
      return;
    }

    const mine = query ? searchLocal(query) : { songs: [], albums: [] };
    const nodes = [pageHead(linked ? 'From a YouTube link' : spotted ? 'From a Spotify link' : `Results for "${term}"`)];
    const songList = (title, tracks) => {
      const list = trackList(scroller, tracks);
      parts.push(list);
      return h('section', { class: 'shelf' }, h('h2', {}, title), list.el);
    };

    if (linked) {
      if (!youtube.isReady()) {
        nodes.push(emptyState('YouTube Music is off', 'Switch on YouTube Music in Settings to play songs from YouTube links.'));
        fill(el, ...nodes);
        return;
      }
      if (fromLink === 'loading') nodes.push(loading('Opening the link on YouTube Music…'));
      else if (fromLink instanceof Error) nodes.push(h('p', { class: 'quiet' }, `YouTube Music didn't answer: ${fromLink.message}`));
      else if (!fromLink) nodes.push(emptyState('Nothing at that link', "YouTube Music doesn't have a video there, or it's private."));
      else nodes.push(songList('On YouTube Music', [fromLink]));
    }

    if (spotted) {
      if (spotify.isSignedIn() && spotted.kind === 'track') {
        if (nativeSpotifyTrack === 'loading') nodes.push(loading('Opening on Spotify…'));
        else if (nativeSpotifyTrack instanceof Error) nodes.push(h('p', { class: 'quiet' }, `Spotify didn't answer: ${nativeSpotifyTrack.message}`));
        else if (nativeSpotifyTrack) nodes.push(songList('On Spotify', [nativeSpotifyTrack]));
      }
      if (!spotify.isSignedIn() && !apple.instance() && !youtube.isReady()) {
        nodes.push(emptyState('Nowhere to look', 'Connect Spotify in Settings to play it directly, or set up Apple Music or YouTube Music to find the same songs there.', linkButton('Open settings', '#/settings/spotify', 'primary')));
        fill(el, ...nodes);
        return;
      }
      if (!spotify.isSignedIn() || spotted.kind !== 'track') {
        if (fromSpotify === 'loading') nodes.push(loading('Reading the Spotify link…'));
        else if (fromSpotify instanceof Error) nodes.push(h('p', { class: 'quiet' }, `Spotify didn't answer: ${fromSpotify.message}`));
        else if (!fromSpotify) nodes.push(emptyState('Nothing at that link', "Spotify doesn't have anything there, or it's private."));
        else nodes.push(...spotifyFound(fromSpotify, songList));
      }
    }

    // The songs a Spotify link was matched to are already at the top.
    const shown = new Set([
      ...(fromSpotify?.found ? [fromSpotify.apple, fromSpotify.tube] : []),
      nativeSpotifyTrack && typeof nativeSpotifyTrack === 'object' && !(nativeSpotifyTrack instanceof Error) ? nativeSpotifyTrack : null,
    ].filter((song) => song?.id).map((song) => song.id));

    if (mine.songs.length) nodes.push(songList('Songs on this PC', mine.songs));
    if (mine.albums.length) nodes.push(h('section', { class: 'shelf' }, h('h2', {}, 'Albums on this PC'), grid(mine.albums)));

    if (spot === 'loading') nodes.push(loading('Searching Spotify…'));
    else if (spot instanceof Error) nodes.push(h('p', { class: 'quiet' }, `Spotify didn't answer: ${spot.message}`));
    else if (spot) {
      const songs = spot.songs.filter((song) => !shown.has(song.id));
      if (songs.length) nodes.push(songList('Songs on Spotify', songs));
      if (spot.albums.length) nodes.push(shelf('Albums on Spotify', spot.albums));
      if (spot.artists.length) nodes.push(shelf('Artists on Spotify', spot.artists));
      if (spot.playlists.length) nodes.push(shelf('Playlists on Spotify', spot.playlists));
    }

    if (remote === 'loading') nodes.push(loading('Searching Apple Music…'));
    else if (remote instanceof Error) nodes.push(h('p', { class: 'quiet' }, `Apple Music didn't answer: ${remote.message}`));
    else if (remote) {
      const songs = remote.songs.filter((song) => !shown.has(song.id));
      if (songs.length) nodes.push(songList('Songs on Apple Music', songs));
      if (remote.albums.length) nodes.push(shelf('Albums on Apple Music', remote.albums));
      if (remote.artists.length) nodes.push(shelf('Artists', remote.artists));
      if (remote.playlists.length) nodes.push(shelf('Playlists', remote.playlists));
    }

    if (tube === 'loading') nodes.push(loading('Searching YouTube Music…'));
    else if (tube instanceof Error) nodes.push(h('p', { class: 'quiet' }, `YouTube Music didn't answer: ${tube.message}`));
    else if (tube) {
      const songs = tube.songs.filter((song) => !shown.has(song.id));
      if (songs.length) nodes.push(songList('Songs on YouTube Music', songs));
      if (tube.albums.length) nodes.push(shelf('Albums on YouTube Music', tube.albums));
      if (tube.artists.length) nodes.push(shelf('Artists on YouTube Music', tube.artists));
    }

    const count = (results, ...kinds) => (results && results !== 'loading' && !(results instanceof Error)
      ? kinds.reduce((sum, kind) => sum + results[kind].length, 0) : 0);
    const found = (spotted ? 1 : 0) + mine.songs.length + mine.albums.length +
      count(spot, 'songs', 'albums', 'artists', 'playlists') +
      count(remote, 'songs', 'albums', 'artists', 'playlists') +
      count(tube, 'songs', 'albums', 'artists');
    if (!found && query && spot !== 'loading' && remote !== 'loading' && tube !== 'loading') {
      nodes.push(emptyState('Nothing matched', apple.instance() || tube || spotify.isSignedIn()
        ? 'Check the spelling, or try fewer words.'
        : 'Only the music on this PC was searched. Set up Spotify, Apple Music or YouTube Music in Settings to search their catalogs too.'));
    }
    fill(el, ...nodes);
    reveal();
  }

  function lookUp() {
    if (query && spotify.isSignedIn()) {
      spot = 'loading';
      spotify.search(query).then((r) => { spot = r; }, (e) => { spot = e instanceof Error ? e : new Error(String(e)); })
        .then(() => { if (alive) draw(); });
    }
    if (query && apple.instance()) {
      remote = 'loading';
      apple.search(query).then((r) => { remote = r; }, (e) => { remote = e instanceof Error ? e : new Error(String(e)); })
        .then(() => { if (alive) draw(); });
    }
    if (query && youtube.isReady()) {
      youtube.warm();
      tube = 'loading';
      // The linked song itself is already at the top.
      const notIt = (r) => (fromLink ? { ...r, songs: r.songs.filter((song) => song.id !== fromLink.id) } : r);
      youtube.search(query).then((r) => { tube = notIt(r); }, (e) => { tube = e instanceof Error ? e : new Error(String(e)); })
        .then(() => { if (alive) draw(); });
    }
  }

  if (linked && youtube.isReady()) {
    youtube.warm();
    youtube.fromLink(linked).then((song) => {
      fromLink = song;
      if (song) query = `${song.title} ${song.artist}`.trim();
    }, (e) => { fromLink = e instanceof Error ? e : new Error(String(e)); })
      .then(() => { if (!alive) return; lookUp(); draw(); });
  }
  if (spotted && spotify.isSignedIn() && spotted.kind === 'track') {
    nativeSpotifyTrack = 'loading';
    spotify.track(spotted.id).then((song) => {
      nativeSpotifyTrack = song;
      if (song) query = `${song.title} ${song.artist.split(',')[0]}`.trim();
    }, (e) => { nativeSpotifyTrack = e instanceof Error ? e : new Error(String(e)); })
      .then(() => { if (!alive) return; lookUp(); draw(); });
  } else if (spotted) {
    spotify.lookUp(spotted).then((found) => {
      if (!found) { fromSpotify = null; return; }
      const first = found.songs[0];
      if (found.kind === 'track') {
        fromSpotify = { found, apple: 'loading', tube: 'loading' };
        // Searched by the first artist only: a song credited to three names is listed under one elsewhere.
        query = first ? `${first.title} ${first.artist.split(',')[0]}`.trim() : '';
        const settle = (key, finding) => finding.then((song) => { fromSpotify[key] = song; }).then(() => { if (alive) draw(); });
        settle('apple', spotify.onApple(first));
        settle('tube', spotify.onYouTube(first));
      } else {
        fromSpotify = { found, link: spotted, matched: null, done: 0, prefer: spotify.firstChoice() };
        // An album may well be on Apple Music or YouTube Music whole, so it is searched for too.
        if (found.kind === 'album') query = `${found.title} ${found.artist.split(',')[0]}`.trim();
        const match = (prefer) => {
          const run = ++matchRun;
          const state = fromSpotify;
          Object.assign(state, { prefer, matched: null, done: 0 });
          spotify.matchAll(found.songs, (done) => {
            if (run !== matchRun) return;
            state.done = done;
            if (alive && done % 5 === 0) draw();
          }, prefer, () => !alive || run !== matchRun).then((matched) => {
            if (run !== matchRun) return;
            state.matched = matched;
            if (alive) draw();
          });
        };
        // Nothing is searched until a service is chosen (see spotifyPicker).
        fromSpotify.rematch = (prefer) => { fromSpotify.started = true; match(prefer); draw(); };
      }
    }, (e) => { fromSpotify = e instanceof Error ? e : new Error(String(e)); })
      .then(() => { if (!alive) return; lookUp(); draw(); });
  }
  lookUp();
  draw();
  return {
    el,
    refresh: (why) => { if (why === 'track' || why === 'collection') parts.forEach((p) => p.refresh()); else if (why === 'local') draw(); },
    destroy: () => { alive = false; parts.forEach((p) => p.destroy()); },
  };
}

/** The shelves for a pasted Spotify link, from what the search page found for it so far. */
function spotifyFound(state, songList) {
  const { found } = state;
  const nodes = [];
  if (found.kind === 'track') {
    const song = found.songs[0];
    const named = song ? `"${song.title}" by ${song.artist}` : 'This song';
    const pending = (state.apple === 'loading' && apple.instance()) || (state.tube === 'loading' && youtube.isReady());
    if (state.apple && state.apple !== 'loading') nodes.push(songList('On Apple Music', [state.apple]));
    if (state.tube && state.tube !== 'loading') nodes.push(songList('On YouTube Music', [state.tube]));
    if (pending) nodes.push(loading(`Looking for ${named}…`));
    else if (!nodes.length) nodes.push(emptyState('Not found', `${named} wasn't found on ${[apple.instance() && 'Apple Music', youtube.isReady() && 'YouTube Music'].filter(Boolean).join(' or ')}. Anything close is below.`));
    return nodes;
  }

  const what = found.kind === 'album' ? 'album' : 'playlist';
  const total = found.songs.length;
  const other = state.prefer === 'youtube' ? 'apple' : 'youtube';
  if (!state.started) return [spotifyPicker(state)];
  // Once found, the songs can be looked for again on the other service first.
  const ready = { apple: !!apple.instance(), youtube: youtube.isReady() };
  const chooser = ready[other]
    ? h('button', { class: 'btn', onclick: () => state.rematch(other) },
      h('span', { class: 'btn-icon', icon: other }), `Look on ${SERVICE_NAMES[other]} instead`)
    : null;
  if (!state.matched) {
    nodes.push(pastedNote('spotify', `The Spotify ${what} you pasted`, found.title.trim()));
    nodes.push(h('div', { class: 'match-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': state.done },
      h('div', { class: 'match-progress-head' },
        h('span', { class: 'match-progress-icon', icon: state.prefer }),
        h('span', {}, `Finding its songs on ${SERVICE_NAMES[state.prefer]}…`),
        h('span', { class: 'quiet' }, `${state.done} of ${total}`)),
      h('div', { class: 'match-progress-bar' }, h('span', { style: { width: `${total ? (state.done / total) * 100 : 0}%` } }))));
    return nodes;
  }
  const songs = state.matched.filter(Boolean);
  const missing = found.songs.filter((_, i) => !state.matched[i]);
  const title = `${found.title}${found.artist ? ` · ${found.artist}` : ''}`;
  if (songs.length) {
    // Kept as a playlist in Tint, the songs found stay together without searching again.
    const href = convertedHref(state.link);
    const saved = collection.find(href);
    const keep = () => { saveConverted(state, songs, href); location.hash = href; };
    nodes.push(h('div', { class: 'spotify-tools' },
      saved
        ? [linkButton('Open the saved playlist', href, 'primary'), button('Replace its songs with these', keep)]
        : h('button', { class: 'btn primary', onclick: keep }, h('span', { class: 'btn-icon', icon: 'bookmark' }), 'Save as a playlist in Tint'),
      chooser && h('span', { class: 'spotify-gap' }),
      chooser));
    nodes.push(songList(title, songs));
    const elsewhere = songs.filter((song) => song.source !== state.prefer).length;
    // Spotify's player lists a playlist's first 100 songs only.
    const note = [songs.length < total ? `${songs.length} of ${total} songs found` : `All ${total} songs found`,
      elsewhere ? `: ${songs.length - elsewhere} on ${SERVICE_NAMES[state.prefer]}, and ${elsewhere} on ${SERVICE_NAMES[other]} where ${SERVICE_NAMES[state.prefer]} didn't have them.` : ` on ${SERVICE_NAMES[state.prefer]}.`,
      what === 'playlist' && total === 100 ? ' Only the first 100 songs of a playlist can be read from Spotify.' : ''].join('');
    nodes.push(h('p', { class: 'quiet' }, note));
  } else {
    nodes.push(emptyState('Not found', `None of the ${what}'s songs were found.`));
  }
  if (missing.length) {
    nodes.push(h('p', { class: 'quiet' }, 'Not found: ' + missing.map((song) => `${song.title} (${song.artist})`).join(', ') + '.'));
  }
  return nodes;
}

/** A line saying where a page came from: the link that was pasted, with its service's mark. */
function pastedNote(service, what, name) {
  return h('div', { class: 'pasted-note pasted-' + service },
    h('span', { class: 'pasted-icon', icon: service === 'youtube' ? 'youtubeVideo' : service }),
    h('span', { class: 'pasted-text' }, h('span', { class: 'quiet' }, what), h('strong', {}, name)));
}

/**
 * A pasted Spotify album or playlist, before anything is searched: which service to find its
 * songs on. The main service is chosen to start with; one not set up can't be picked.
 */
function spotifyPicker(state) {
  const { found } = state;
  const what = found.kind === 'album' ? 'album' : 'playlist';
  const ready = { apple: !!apple.instance(), youtube: youtube.isReady() };
  if (!ready[state.prefer] && ready[state.prefer === 'apple' ? 'youtube' : 'apple']) state.prefer = state.prefer === 'apple' ? 'youtube' : 'apple';
  const start = h('button', { class: 'btn primary', onclick: () => state.rematch(state.prefer) });
  const label = () => fill(start, h('span', { class: 'btn-icon', icon: 'search' }), `Find the songs on ${SERVICE_NAMES[state.prefer]}`);
  label();
  const notes = {
    apple: !ready.apple ? 'Set up Apple Music in Settings to use it.'
      : ready.youtube ? 'Songs it lacks are looked for on YouTube Music.' : 'Each song is looked for in its catalog.',
    youtube: !ready.youtube ? 'Switch on YouTube Music in Settings to use it.'
      : ready.apple ? 'Songs it lacks are looked for on Apple Music.' : 'Each song is looked for in its catalog.',
  };
  const art = found.art ? { url: found.art } : found.songs[0]?.art;
  return h('div', { class: 'spotify-picker' },
    h('div', { class: 'spotify-picker-head' },
      h('div', { class: 'spotify-picker-art' }, cover(art, 120, { lazy: false }), h('span', { class: 'spotify-badge', icon: 'spotify' })),
      h('div', {},
        h('p', { class: 'quiet' }, `Spotify ${what} from the link you pasted`),
        h('h2', {}, found.title.trim()),
        h('p', { class: 'quiet' }, [found.artist?.trim(), plural(found.songs.length, 'song')].filter(Boolean).join(' · ')))),
    !ready.apple && !ready.youtube
      ? emptyState('Nowhere to look yet', "Spotify's songs can't be played here, so Tint finds the same songs on Apple Music or YouTube Music. Set one of them up first.", linkButton('Open settings', '#/settings', 'primary'))
      : [
        h('h3', { class: 'spotify-picker-ask' }, 'Where should Tint find these songs?'),
        h('div', { class: 'welcome-choices spotify-choices', role: 'radiogroup', 'aria-label': 'Where to find the songs' },
          ['apple', 'youtube'].map((id) => h('label', { class: 'welcome-choice' + (ready[id] ? '' : ' is-off') },
            h('input', {
              type: 'radio', name: 'spotify-service', value: id, checked: state.prefer === id, disabled: !ready[id],
              onchange: () => { state.prefer = id; label(); },
            }),
            h('span', { class: 'welcome-choice-icon', icon: id }),
            h('span', { class: 'welcome-choice-text' },
              h('strong', {}, SERVICE_NAMES[id], prefs.mainService === id ? h('span', { class: 'choice-mark' }, 'Main') : null),
              h('span', { class: 'quiet' }, notes[id]))))),
        h('div', { class: 'spotify-picker-go' }, start,
          what === 'playlist' && found.songs.length === 100 ? h('span', { class: 'quiet' }, 'Only the first 100 songs of a playlist can be read from Spotify.') : null),
      ]);
}

/**
 * Brings a saved playlist up to date with where it came from, only when asked: an Apple Music or
 * YouTube Music playlist takes its songs as they are now, and one made from a Spotify list gains the songs put in it since.
 */
function refreshButton(href) {
  const btn = h('button', { class: 'btn', title: 'Get the songs added since it was saved' });
  const label = (text) => fill(btn, h('span', { class: 'btn-icon', icon: 'refresh' }), text);
  label('Refresh');
  btn.onclick = async () => {
    const saved = collection.find(href);
    if (!saved) return;
    btn.disabled = true;
    label('Checking…');
    try {
      if (saved.source === 'apple' || saved.source === 'youtube' || saved.source === 'spotify') await refreshFromService(saved);
      else await refreshFromSpotify(saved, label);
    } catch (e) {
      toast(e?.message || "The playlist couldn't be checked.");
    } finally {
      btn.disabled = false;
      label('Refresh');
    }
  };
  return btn;
}

/** The page shows the playlist's songs as they were when it opened, so it opens again with the new ones. */
function reopen(href) {
  if (location.hash === href) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

async function refreshFromService(saved) {
  if (saved.source === 'apple' && !apple.instance()) throw new Error('Set up Apple Music in Settings to refresh this playlist.');
  if (saved.source === 'spotify' && !spotify.isSignedIn()) throw new Error('Sign in to Spotify in Settings to refresh this playlist.');
  const live = await (saved.source === 'apple' ? apple.playlist(saved.id) : saved.source === 'spotify' ? spotify.playlist(saved.id) : youtube.playlist(saved.id));
  const before = new Set(saved.tracks.map((t) => t.id));
  const now = new Set(live.tracks.map((t) => t.id));
  const added = live.tracks.filter((t) => !before.has(t.id)).length;
  const removed = saved.tracks.filter((t) => !now.has(t.id)).length;
  collection.save({ ...live, id: saved.id, source: saved.source, href: saved.href });
  pagecache.keep(saved.href, { ...live, href: saved.href });
  if (added || removed) reopen(saved.href);
  toast(added || removed
    ? [added && `Added ${plural(added, 'new song')}`, removed && `${added ? 'removed' : 'Removed'} ${plural(removed, 'song')} no longer in it`].filter(Boolean).join(', ') + '.'
    : 'Already up to date.', { ms: 5000 });
}

async function refreshFromSpotify(saved, label) {
  const link = spotify.linkIn(saved.from?.url);
  if (!link) throw new Error("This playlist doesn't remember its Spotify link.");
  const found = await spotify.lookUp(link, true);
  if (!found) throw new Error("That Spotify list can't be found anymore.");
  const key = (song) => song.spotifyId || `${song.title}\u0001${song.artist}`.toLowerCase();
  // Songs found before are skipped; ones missing before get another try. Lists saved before
  // songs were kept with them are compared with the playlist's own songs by name.
  const before = new Map((saved.from.songs || saved.tracks.map((t) => ({ title: t.title, artist: t.artist, found: true })))
    .map((song) => [key(song), song.found]));
  const look = found.songs.filter((song) => !before.get(key(song)));
  const matched = look.length
    ? await spotify.matchAll(look, (done, total) => label(`Finding ${done} of ${total}…`), saved.from.service)
    : [];
  const have = new Set(saved.tracks.map((t) => t.id));
  const added = matched.filter((t) => t && !have.has(t.id) && have.add(t.id));
  const nowFound = new Set(look.filter((_, i) => matched[i]).map(key));
  collection.save({
    ...saved,
    tracks: [...saved.tracks, ...added],
    from: {
      ...saved.from, at: Date.now(),
      songs: found.songs.map((song) => ({
        spotifyId: song.spotifyId || null, title: song.title, artist: song.artist,
        found: !!before.get(key(song)) || nowFound.has(key(song)),
      })),
    },
  });
  if (added.length) reopen(saved.href);
  const stillMissing = look.length - nowFound.size;
  toast(added.length
    ? `Added ${plural(added.length, 'new song')} to "${saved.title}"${stillMissing ? `. ${plural(stillMissing, 'song')} still not found.` : ''}`
    : stillMissing ? `No new songs found. ${plural(stillMissing, 'song')} still not found.` : 'Already up to date.', { ms: 5000 });
}

/** Where a Spotify list lives once it is saved in Tint. The same link always lands on the same playlist. */
const convertedHref = (link) => `#/playlist/t/spotify-${link.kind}-${link.id}`;

function saveConverted(state, songs, href) {
  const { found, link } = state;
  collection.save({
    id: `spotify-${link.kind}-${link.id}`, source: 'tint', href,
    title: found.title.trim(), artist: found.artist.trim(),
    art: found.art ? { url: found.art } : songs[0]?.art || null,
    tracks: songs,
    from: {
      kind: 'spotify', what: link.kind, url: `https://open.spotify.com/${link.kind}/${link.id}`, service: state.prefer, at: Date.now(),
      // Every song the list had when it was saved, found or not, so an update later can tell which songs are new.
      songs: found.songs.map((song, i) => ({ spotifyId: song.spotifyId || null, title: song.title, artist: song.artist, found: !!state.matched[i] })),
    },
  });
  toast(`Saved "${found.title.trim()}" in Tint`);
}

// ---- Welcome ------------------------------------------------------------------------------------

/** Opens the file picker for a backup and takes it in. */
function pickBackup(done) {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const { added, songs } = await backup.importFrom(file);
      toast(`Backup imported: ${plural(added, 'new playlist')}${songs ? `, ${plural(songs, 'song')} played lately` : ''}.`, { ms: 5000 });
      done?.();
    } catch (e) {
      toast(e?.message || "That backup couldn't be read.", { ms: 6000 });
    }
  });
  input.click();
}

/** The first page of a new install: where the music comes from, and where it is on this PC. */
function welcomeView() {
  const el = h('section', { class: 'page welcome' });
  let choice = ['apple', 'youtube', 'spotify', 'pc'].includes(prefs.mainService) ? prefs.mainService : null;
  const returning = !!choice;
  let busy = false;
  const start = h('button', { class: 'btn primary', onclick: () => finish() }, 'Start listening');
  const services = [
    ['apple', 'Apple Music', 'Your Apple Music library, and the whole catalog with a subscription.'],
    ['youtube', 'YouTube Music', 'Your YouTube Music library and the whole catalog.'],
    ['spotify', 'Spotify', 'Your Spotify library, playlists and full catalog with Spotify Premium.'],
    ['pc', 'Only music on this PC', 'The music files in your folders. Any service can be set up later.'],
  ];
  const ready = () => { start.disabled = !choice || busy; start.title = choice ? '' : 'Choose where you listen first'; };

  async function finish() {
    if (!choice || busy) return;
    busy = true;
    ready();
    try {
      await savePrefs({ mainService: choice, welcomed: true, ...(choice === 'youtube' ? { youtube: true } : {}), ...(choice === 'spotify' ? { spotifyEnabled: true } : {}) });
    } catch {
      busy = false;
      ready();
      toast("That couldn't be saved. Try again.");
      return;
    }
    // A service still to be set up is taken to its place in Settings.
    if (choice === 'apple' && !apple.isSignedIn()) {
      location.replace('#/settings/apple');
      toast('Set up Apple Music here, then sign in.', { ms: 5000 });
    } else if (choice === 'youtube' && !youtube.isSignedIn()) {
      location.replace('#/settings/youtube');
      toast('Sign in to Google here to play from YouTube Music.', { ms: 5000 });
    } else if (choice === 'spotify' && !spotify.isSignedIn()) {
      location.replace('#/settings/spotify');
      toast('Connect your Spotify Premium account here.', { ms: 5000 });
    } else {
      location.replace('#/home');
    }
  }

  function draw() {
    ready();
    fill(el,
      // Someone updating already has a main service, read from their setup: nothing of theirs changes.
      returning
        ? pageHead('Welcome to the new Tint', 'Tint now starts by asking two things. Your playlists, library and settings are just as they were.')
        : pageHead('Welcome to Tint', 'Two questions, and then the music.'),
      h('section', { class: 'welcome-step' },
        h('h2', {}, 'Where do you listen most?'),
        h('p', { class: 'quiet' }, 'Songs from links to other services, like Spotify, are looked for there first. This can be changed in Settings.'),
        h('div', { class: 'welcome-choices', role: 'radiogroup', 'aria-label': 'Where do you listen most?' },
          services.map(([id, name, text]) => h('label', { class: 'welcome-choice' },
            h('input', { type: 'radio', name: 'main-service', value: id, checked: choice === id, onchange: () => { choice = id; ready(); } }),
            h('span', { class: 'welcome-choice-icon', icon: id }),
            h('span', { class: 'welcome-choice-text' }, h('strong', {}, name), h('span', { class: 'quiet' }, text)))))),
      h('section', { class: 'welcome-step' },
        h('h2', {}, 'Music on this PC'),
        h('p', { class: 'quiet' }, prefs.folders.length
          ? 'Tint found these folders. Add any other folder with music in it, or go on without.'
          : 'If you keep music files on this PC, add the folder they are in. Or go on without.'),
        prefs.folders.length ? h('ul', { class: 'folders' },
          prefs.folders.map((folder) => h('li', {},
            h('span', { class: 'folder-icon', icon: 'folder' }),
            h('span', { class: 'folder-path', title: folder }, folder),
            h('button', {
              class: 'text-btn', 'aria-label': `Remove ${folder}`,
              onclick: () => savePrefs({ folders: prefs.folders.filter((f) => f !== folder) }),
            }, 'Remove')))) : null,
        h('div', { class: 'panel-actions' },
          button(prefs.folders.length ? 'Add another folder' : 'Add a folder', async () => {
            const { path } = await post('/api/pick-folder');
            if (path) await savePrefs({ folders: [...prefs.folders, path] });
          }))),
      h('aside', { class: 'welcome-note' },
        h('span', { class: 'welcome-note-icon', icon: 'pc' }),
        h('div', {},
          h('strong', {}, 'Everything stays on this PC'),
          h('p', {},
            'Saved playlists, tags, the songs you play and these choices are kept here, not in an account. ',
            'To keep them when you change PCs or reinstall, export a backup from Settings (under Saved data) and import it there.'))),
      h('div', { class: 'welcome-actions' },
        start,
        h('button', { class: 'text-btn', onclick: () => pickBackup(() => location.replace('#/home')) }, 'Import a backup instead')));
  }

  draw();
  return {
    el,
    // Folders added or removed show at once; the choice made so far is kept.
    refresh: (why) => { if (why === 'prefs' && !busy) draw(); },
  };
}

// ---- Lyrics -------------------------------------------------------------------------------------

// A line lights a moment early, as the singer reaches it rather than after.
const LYRICS_LEAD = 0.2;
// Scrolling by hand stops the page following the song for a while.
const LYRICS_HOLD_MS = 4000;
// Whether Japanese lyrics are shown in romaji, kept by the page between runs.
const ROMAJI_KEY = 'tint.lyrics.romaji';
const romajiWanted = () => localStorage.getItem(ROMAJI_KEY) === 'on';
// The language lyrics are translated to, if any, kept the same way.
const TRANSLATE_KEY = 'tint.lyrics.translate';
const translateWanted = () => localStorage.getItem(TRANSLATE_KEY) || '';

function lyricsView({ scroller }) {
  const el = h('section', { class: 'page lyrics-page' });
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  let track = null;
  let result = null; // 'loading', an Error, null (none found), or what lyricsFor() found
  let translation = null; // null (none wanted, or it failed), 'working', or a line for each line
  let rows = [];
  let lit = -1;
  let heldUntil = 0;
  let alive = true;
  // Choosing lines to copy: clicking a line picks it instead of jumping the song there.
  let picking = false;
  const picked = new Set();
  let anchor = -1;
  let lineEls = [];   // every line on screen, timed or not, in order
  let lineTexts = []; // what each says as shown (romaji, and its translation, when those are on)
  const pickBar = h('div', { class: 'pick-bar', role: 'toolbar', 'aria-label': 'Copy lines' });
  let pickButton = null;
  // The player reports its position a few times a second; between reports it is worked out.
  let clock = { time: player.state.time, at: performance.now() };

  const now = () => clock.time + (player.state.playing ? (performance.now() - clock.at) / 1000 : 0);

  function load() {
    track = player.current();
    result = track ? 'loading' : null;
    translation = null;
    picking = false;
    picked.clear();
    draw();
    if (!track) return;
    const mine = track;
    lyricsFor(track).then((r) => { result = r; }, (e) => { result = e instanceof Error ? e : new Error(String(e)); })
      .then(() => {
        if (!alive || player.current() !== mine) return;
        translate();
        draw();
      });
  }

  const textsOf = (lyrics) => (lyrics.lines ? lyrics.lines.map((line) => line.text) : lyrics.text.split('\n'));

  /** Starts on the translation wanted for the lyrics showing, and draws again once it's there. */
  function translate() {
    const language = translateWanted();
    translation = null;
    if (!language || !result || result === 'loading' || result instanceof Error) return;
    translation = 'working';
    const mine = result;
    const current = () => alive && result === mine && translateWanted() === language;
    translationOf(mine, textsOf(mine), language).then((lines) => {
      if (!current()) return;
      translation = lines;
      draw();
    }, () => {
      if (!current()) return;
      translation = null;
      toast("The translation service didn't answer. Try again in a moment.", { ms: 6000 });
      draw();
    });
  }

  /** A line's translation to show under it. Nothing for a line that's the same either way. */
  function translationUnder(i, text, tag = 'span') {
    const line = Array.isArray(translation) ? translation[i] : null;
    return line && line !== text ? h(tag, { class: 'lyric-translation', dir: 'auto', lang: translateWanted() }, line) : null;
  }

  /** The lyrics' lines as they should be shown: as written, or in romaji once that is worked out. */
  function shownTexts(texts) {
    if (!romajiWanted() || !hasJapanese(texts.join('\n'))) return texts;
    if (result.romaji) return result.romaji;
    if (!result.romajiPending) {
      const mine = result;
      mine.romajiPending = romanize(texts).then((romaji) => { mine.romaji = romaji; }, (e) => {
        mine.romajiPending = null;
        localStorage.setItem(ROMAJI_KEY, 'off');
        toast(e.message, { ms: 6000 });
      }).then(() => { if (alive && result === mine) draw(); });
    }
    return texts;
  }

  function draw() {
    rows = [];
    lit = -1;
    const summary = track ? `${track.title}${track.artist ? ' · ' + track.artist : ''}` : null;
    if (!track) return fill(el, pageHead('Lyrics', summary), emptyState('Nothing playing', 'The lyrics of the song playing show here.'));
    if (result === 'loading') return fill(el, pageHead('Lyrics', summary), loading('Looking for lyrics…'));
    if (result instanceof Error) return fill(el, pageHead('Lyrics', summary), failure(result, load));
    if (!result) return fill(el, pageHead('Lyrics', summary), emptyState('No lyrics for this song', "Apple Music, YouTube Music, LRCLIB and Genius don't have lyrics for it."));

    const texts = textsOf(result);
    const shown = shownTexts(texts);
    // Japanese lyrics can be shown in romaji instead.
    const romajiSwitch = hasJapanese(texts.join('\n'))
      ? segmented('Show the lyrics', [['original', 'Original'], ['romaji', 'Romaji']], romajiWanted() ? 'romaji' : 'original', (id) => {
        localStorage.setItem(ROMAJI_KEY, id === 'romaji' ? 'on' : 'off');
        draw();
      })
      : null;
    const languages = select('Translate the lyrics to', [['', 'No translation'], ...LANGUAGES], translateWanted(), (id) => {
      localStorage.setItem(TRANSLATE_KEY, id);
      translate();
      draw();
    });
    const copyLines = h('button', {
      class: 'btn', title: 'Choose lines to copy', 'aria-pressed': String(picking),
      onclick: () => (picking ? stopPicking() : startPicking()),
    }, h('span', { class: 'btn-icon', icon: 'copy' }), 'Copy lines');
    pickButton = copyLines;
    const head = pageHead('Lyrics', summary, copyLines, romajiSwitch, languages);
    const working = shown === texts && romajiWanted() && result.romajiPending
      ? h('p', { class: 'quiet lyrics-working' }, 'Working out the romaji… The first time, this downloads a Japanese dictionary (17 MB).')
      : translation === 'working' ? h('p', { class: 'quiet lyrics-working' }, 'Translating…') : null;
    const translated = Array.isArray(translation) && translation.some((line, i) => line && line !== texts[i]) ? ' Translated by Google.' : '';

    lineTexts = shown.map((line, i) => {
      const under = Array.isArray(translation) && translation[i] && translation[i] !== texts[i] ? translation[i] : '';
      return [line, under].filter(Boolean).join('\n');
    });
    const lineEvents = (i) => ({
      oncontextmenu: (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          lineTexts[i] && { icon: 'copy', label: 'Copy this line', run: () => copyText(lineTexts[i], 'Line copied') },
          { icon: 'check', label: 'Choose lines to copy…', run: () => startPicking(i) },
          { icon: 'copy', label: 'Copy all the lyrics', run: () => copyText(lineTexts.join('\n'), 'Lyrics copied') },
        ]);
      },
    });

    if (!result.lines) {
      rows = [];
      lineEls = shown.map((line, i) => h('p', {
        class: 'lyric-plain', ...lineEvents(i),
        onclick: (e) => { if (picking) pick(i, e.shiftKey); },
      }, line || '\u00a0', translationUnder(i, texts[i])));
      fill(el, head, working,
        h('div', { class: 'lyrics is-plain' }, lineEls),
        h('p', { class: 'quiet lyrics-source' }, `These lyrics aren't timed to the song. From ${result.source}.${translated}`),
        pickBar);
      markPicked();
      return;
    }
    rows = result.lines.map((line, i) => h('button', {
      class: 'lyric' + (line.text ? '' : ' is-gap'), ...lineEvents(i),
      onclick: (e) => {
        if (picking) { pick(i, e.shiftKey); return; }
        heldUntil = 0; player.seek(line.time); if (!player.state.playing) player.toggle();
      },
    }, shown[i] || '♪', translationUnder(i, line.text)));
    lineEls = rows;
    fill(el, head, working, h('div', { class: 'lyrics' }, rows), h('p', { class: 'quiet lyrics-source' }, `Lyrics from ${result.source}${translated && '.' + translated}`), pickBar);
    markPicked();
    follow(true);
  }

  // ---- choosing lines to copy ----

  function startPicking(first = null) {
    picking = true;
    picked.clear();
    anchor = -1;
    if (first != null && lineTexts[first]) { picked.add(first); anchor = first; }
    markPicked();
  }

  function stopPicking() {
    picking = false;
    picked.clear();
    anchor = -1;
    markPicked();
  }

  /** Picks a line, or (holding Shift) every line from the last one picked to this one. */
  function pick(i, run) {
    if (!lineTexts[i]) return; // the pauses between verses have nothing to copy
    if (run && anchor >= 0) {
      for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) if (lineTexts[k]) picked.add(k);
    } else if (picked.has(i)) {
      picked.delete(i);
    } else {
      picked.add(i);
    }
    anchor = i;
    markPicked();
  }

  async function copyPicked() {
    const text = [...picked].sort((a, b) => a - b).map((i) => lineTexts[i]).join('\n');
    if (await copyText(text, picked.size === 1 ? 'Line copied' : `${picked.size} lines copied`)) stopPicking();
  }

  function markPicked() {
    el.classList.toggle('is-picking', picking);
    pickButton?.setAttribute('aria-pressed', String(picking));
    lineEls.forEach((line, i) => {
      line.classList.toggle('is-picked', picked.has(i));
      if (picking) line.setAttribute('aria-pressed', String(picked.has(i)));
      else line.removeAttribute('aria-pressed');
    });
    pickBar.classList.toggle('is-up', picking);
    fill(pickBar,
      h('span', { class: 'pick-count' }, picked.size ? `${plural(picked.size, 'line')} chosen` : 'Click lines to choose them. Shift-click picks a run.'),
      h('span', { class: 'pick-actions' },
        h('button', { class: 'text-btn', onclick: () => { lineTexts.forEach((t, i) => { if (t) picked.add(i); }); markPicked(); } }, 'All'),
        h('button', { class: 'text-btn', onclick: stopPicking }, 'Cancel'),
        h('button', { class: 'btn primary small', disabled: !picked.size, onclick: copyPicked },
          h('span', { class: 'btn-icon', icon: 'copy' }), 'Copy')));
  }

  /** Lights the line being sung and keeps it in view. */
  function follow(jump = false) {
    if (!rows.length) return;
    const t = now() + LYRICS_LEAD;
    const lines = result.lines;
    let line = -1;
    while (line + 1 < lines.length && lines[line + 1].time <= t) line++;
    if (line === lit && !jump) return;
    rows.forEach((row, i) => { row.classList.toggle('is-past', i < line); row.classList.toggle('is-now', i === line); });
    lit = line;
    // Choosing lines to copy holds the page still.
    if (picking || performance.now() < heldUntil) return;
    const row = rows[Math.max(line, 0)];
    const box = scroller.getBoundingClientRect(), at = row.getBoundingClientRect();
    // The line being sung sits a little above the middle, with what comes next below it.
    const top = scroller.scrollTop + at.top - box.top + at.height / 2 - scroller.clientHeight * 0.38;
    scroller.scrollTo({ top: line < 0 ? 0 : top, behavior: jump || still.matches ? 'instant' : 'smooth' });
  }

  let frame = requestAnimationFrame(function tick() {
    frame = requestAnimationFrame(tick);
    follow();
  });

  const hold = () => { heldUntil = performance.now() + LYRICS_HOLD_MS; };
  const onKey = (e) => { if (e.key === 'Escape' && picking) stopPicking(); };
  document.addEventListener('keydown', onKey);
  scroller.addEventListener('wheel', hold, { passive: true });
  scroller.addEventListener('touchmove', hold, { passive: true });

  const off = player.on((kind) => {
    if (kind === 'track') load();
    else if (kind === 'time' || kind === 'state' || kind === 'seek') {
      const guess = now(), real = player.state.time;
      // A report a hair behind the worked-out time is the report being late; keeping the guess stops
      // the light stepping back a line and forward again.
      clock = { time: kind === 'time' && player.state.playing && real < guess && guess - real < 0.4 ? guess : real, at: performance.now() };
      if (kind === 'seek') { heldUntil = 0; follow(true); }
    }
  });

  load();
  return {
    el,
    destroy: () => {
      alive = false;
      cancelAnimationFrame(frame);
      off();
      scroller.removeEventListener('wheel', hold);
      scroller.removeEventListener('touchmove', hold);
      document.removeEventListener('keydown', onKey);
    },
  };
}

// ---- Settings -----------------------------------------------------------------------------------

function settingsView({ scroller, params } = {}) {
  const el = h('section', { class: 'page settings' });
  let busy = false;
  let searchQuery = '';
  let activeSec = { updates: 'updates', apple: 'apple', youtube: 'youtube', spotify: 'spotify', data: 'data' }[params?.[0]] || 'updates';

  const field = (label, input, hint) => h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label), input, hint && h('span', { class: 'quiet field-hint' }, hint));

  /** A Cutflow-style horizontal settings row: label + description left, control right. */
  const setRow = (title, desc, control, { stack = false, cls = '' } = {}) => h('div', { class: 'set-row' + (stack ? ' is-stack' : '') + (cls ? ' ' + cls : '') },
    h('div', { class: 'set-lbl' },
      h('b', {}, title),
      desc && (typeof desc === 'string' ? h('span', {}, desc) : desc)),
    control && h('div', { class: 'set-ctl' }, control));

  /** A pill toggle switch matching Tint's dynamic accent. */
  const toggleSwitch = (checked, onchange, { disabled = false, label = '' } = {}) => h('label', { class: 'switch' + (disabled ? ' is-disabled' : '') },
    h('input', { type: 'checkbox', checked, disabled, 'aria-label': label || null, onchange }),
    h('span', { class: 'switch-track', 'aria-hidden': 'true' }));

  const setSec = (id, title, navIcon, ...content) => h('section', { class: 'set-sec', id: `set-${id}`, dataset: { sec: id } },
    h('h2', { class: 'set-sec-head' },
      navIcon && h('span', { class: 'set-sec-icon', icon: navIcon }),
      h('span', {}, title)),
    h('div', { class: 'set-card' }, ...content));

  async function reconnect() {
    await apple.init();
    if (apple.getStatus() === 'error') toast(apple.getProblem());
  }

  function generalSection() {
    let status = 'Scanning…';
    if (!local.scanning) {
      status = `${plural(local.tracks.length, 'song')} found.`;
      if (local.skippedProtected) {
        status += ` ${plural(local.skippedProtected, 'downloaded Apple Music file')} left out (locked to Apple's own apps, so they play from Apple Music instead).`;
      }
    }
    return setSec('general', 'General & library', 'pc',
      setRow('Main service', 'Where you listen most. Pasted links are looked up there first.',
        segmented('Main service', [
          ['apple', 'Apple Music', 'appleMono'],
          ['youtube', 'YouTube Music', 'youtubeMono'],
          ['spotify', 'Spotify', 'spotifyMono'],
          ['pc', 'Only this PC', 'pc'],
        ], prefs.mainService || 'pc', (v) => savePrefs({ mainService: v }), { iconsOnly: true })),
      h('div', { class: 'set-row is-stack' },
        h('div', { class: 'set-row-head' },
          h('div', { class: 'set-lbl' }, h('b', {}, 'Music folders on this PC'), h('span', {}, status)),
          h('div', { class: 'set-inline-actions' },
            button('Add a folder', async () => {
              const { path } = await post('/api/pick-folder');
              if (!path) return;
              await savePrefs({ folders: [...prefs.folders, path] });
              nudge();
            }),
            button('Scan again', async () => { await post('/api/rescan'); nudge(); }))),
        h('ul', { class: 'folders' },
          prefs.folders.map((folder) => h('li', {},
            h('span', { class: 'folder-icon', icon: 'folder' }),
            h('span', { class: 'folder-path', title: folder }, folder),
            h('button', {
              class: 'text-btn', 'aria-label': `Remove ${folder}`,
              onclick: async () => { await savePrefs({ folders: prefs.folders.filter((f) => f !== folder) }); nudge(); },
            }, 'Remove'))),
          !prefs.folders.length && h('li', { class: 'quiet' }, 'No folders yet.'))),
      setRow(
        'Open links from other apps',
        'Experimental. Registers tint:// so other apps, shortcuts, or browsers can send Spotify, YouTube Music, or Apple Music links straight into Tint.',
        toggleSwitch(!!prefs.handleLinks, async (e) => {
          await savePrefs({ handleLinks: e.target.checked });
          toast(e.target.checked ? 'Tint can now open tint:// links from other apps' : 'Removed Tint link handler');
        }, { label: 'Open links from other apps' })),
      prefs.handleLinks && setRow(
        'Also catch spotify: & music: app links',
        'Handle "Open in Spotify" and Apple Music app links directly in Tint. Turning this off restores your previous app handler.',
        toggleSwitch(!!prefs.handleAppLinks, async (e) => {
          await savePrefs({ handleAppLinks: e.target.checked });
          toast(e.target.checked ? 'Tint now catches spotify: and music: links' : 'Restored previous spotify: and music: handlers');
        }, { label: 'Catch spotify and music app links' })),
      prefs.handleLinks && (() => {
        const testInput = h('input', {
          type: 'text',
          value: 'tint://open?url=https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
          placeholder: 'tint://open?url=https://...',
          spellcheck: false,
          'aria-label': 'Test link URL',
        });
        const runTest = async () => {
          const url = testInput.value.trim();
          if (!url) return;
          const res = await post('/api/test-link', { url }).catch(() => ({ ok: false }));
          if (!res?.ok) toast('Only Spotify, Apple Music, and YouTube Music links are accepted.', { ms: 4000 });
        };
        testInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runTest(); } });
        return h('div', { class: 'set-row is-stack' },
          field('Test protocol round-trip', h('div', { class: 'id-row' }, testInput, button('Test link', runTest)),
            'Only Spotify, Apple Music, and YouTube Music links are accepted.'));
      })());
  }

  function appearanceSection() {
    return setSec('appearance', 'Appearance', 'palette',
      setRow('Keep the window dark', 'Normally a light cover gives you a light window. Turn this on to stay dark for every cover.',
        toggleSwitch(prefs.keepDark, (e) => savePrefs({ keepDark: e.target.checked }), { label: 'Keep the window dark' })),
      setRow('Cover backdrop', "Use the playing song's cover as a soft, translucent blurred background across the whole window.",
        toggleSwitch(prefs.coverBackdrop, (e) => savePrefs({ coverBackdrop: e.target.checked }), { label: 'Cover backdrop' })));
  }

  /** A slider for a length of time, saved when let go. */
  function durationRow(title, hint, key, max, step) {
    const said = (ms) => (ms === 0 ? 'Off' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
    const value = h('span', { class: 'set-val' }, said(prefs[key]));
    const show = (input) => {
      input.style.setProperty('--fill', `${(input.value / max) * 100}%`);
      value.textContent = said(Number(input.value));
    };
    const input = h('input', {
      type: 'range', class: 'slider', min: 0, max, step, value: prefs[key], 'aria-label': title,
      oninput: (e) => show(e.target),
      onchange: (e) => savePrefs({ [key]: Number(e.target.value) }),
    });
    show(input);
    return setRow(title, hint, h('div', { class: 'set-slider' }, input, value));
  }

  function playbackSection() {
    return setSec('playback', 'Playback', 'play',
      durationRow('Fade on play & pause', 'A short fade instead of the sound cutting in and out.', 'pauseFadeMs', 1000, 10),
      durationRow('Crossfade when skipping', 'How long a skipped song fades into the next. Two Apple Music songs or two YouTube Music player songs fade sequentially.', 'crossfadeMs', 5000, 100));
  }

  let ownKeyOpen = false;
  let explicitHelpOpen = false;

  function appleSection() {
    const status = apple.getStatus();
    const signedIn = apple.isSignedIn();
    const ownKey = prefs.apple.hasToken || (prefs.apple.hasKey && prefs.apple.teamId && prefs.apple.keyId);
    const configured = ownKey || prefs.apple.useWeb;
    const removeSetup = async () => {
      await apple.signOut().catch(() => {});
      await savePrefs({ forgetApple: true });
      location.reload();
    };
    const via = prefs.apple.useWeb && !ownKey ? " Using the web player's token." : '';

    if (signedIn) {
      return setSec('apple', 'Apple Music', 'appleMono',
        setRow('Account', 'Signed in. Your library, playlists and the full catalog are ready to play.' + via,
          h('div', { class: 'set-inline-actions' },
            button('Sign out', () => apple.signOut().catch((e) => toast(e?.message || String(e)))),
            button('Remove setup', removeSetup))),
        setRow('Play explicit songs', 'In some countries, Brazil included, Apple leaves explicit songs switched off until you allow them.',
          toggleSwitch(apple.explicitAllowed(), (e) => apple.setExplicitAllowed(e.target.checked), { label: 'Play explicit songs' })),
        h('div', { class: 'set-row is-stack' },
          h('details', { open: explicitHelpOpen, ontoggle: (e) => { explicitHelpOpen = e.target.open; } },
            h('summary', {}, 'Explicit songs still blocked by Apple?'),
            h('p', { class: 'quiet set-note' },
              "If they still won't play, Apple's own servers are refusing them for your account. Tint can't change that. Check these places:"),
            h('ol', { class: 'steps explicit-steps' },
              h('li', {}, 'At music.apple.com, in Settings under Parental Controls, turn Content Restrictions ', h('strong', {}, 'on'), ' and set Music to ', h('strong', {}, 'Explicit'), '. ',
                h('button', { class: 'text-btn', onclick: () => post('/api/open', { url: 'https://music.apple.com/account/settings' }) }, 'Open that page')),
              h('li', {}, 'On an iPhone or iPad with the same Apple Account: Settings, Screen Time, Content & Privacy Restrictions, then allow Explicit for music.'),
              h('li', {}, 'In the Apple Music app for Windows: Settings, Restrictions, and untick music with explicit content.')),
            h('p', { class: 'quiet set-note' }, 'Then play the song again. If it is still refused, sign out here and sign back in.'))));
    }

    if (configured && status === 'ready') {
      return setSec('apple', 'Apple Music', 'appleMono',
        setRow('Sign in', 'Setup is done. Sign in with the Apple Account that has your subscription.' + via,
          h('div', { class: 'set-inline-actions' },
            button('Sign in to Apple Music', () => apple.signIn().catch((e) => toast(e?.message || 'Sign-in was cancelled.')), 'primary'),
            button('Remove setup', removeSetup))));
    }

    if (configured && status === 'loading') {
      return setSec('apple', 'Apple Music', 'appleMono',
        h('div', { class: 'set-row' }, loading('Connecting to Apple Music…')));
    }

    if (prefs.apple.useWeb && !ownKey) {
      return setSec('apple', 'Apple Music', 'appleMono',
        h('div', { class: 'set-row is-stack' },
          h('p', { class: 'warn' }, apple.getProblem() || "Apple Music isn't connected."),
          h('div', { class: 'set-inline-actions' },
            button('Try again', reconnect, 'primary'),
            button('Remove setup', removeSetup))));
    }

    const team = h('input', { type: 'text', value: prefs.apple.teamId, placeholder: 'A1B2C3D4E5', maxLength: 16, spellcheck: false, autocomplete: 'off' });
    const key = h('input', { type: 'text', value: prefs.apple.keyId, placeholder: 'ABC123DEFG', maxLength: 16, spellcheck: false, autocomplete: 'off' });
    const token = h('textarea', { rows: 3, placeholder: 'eyJhbGciOiJFUzI1NiIs…', spellcheck: false });
    const problem = apple.getProblem();

    return setSec('apple', 'Apple Music', 'appleMono',
      problem && h('div', { class: 'set-row is-stack' }, h('p', { class: 'warn' }, problem)),
      setRow("Use the web player's token",
        "No paid developer account needed. Tint presents itself as music.apple.com and plays through Apple's own player. Apple's terms don't provide for it, and it can break if Apple changes their site.",
        button("Use the web player's token", async () => {
          if (busy) return;
          busy = true;
          try {
            await savePrefs({ appleUseWeb: true });
            await reconnect();
          } finally {
            busy = false;
            draw();
          }
        }, 'primary')),
      h('div', { class: 'set-row is-stack' },
        h('details', { open: ownKeyOpen || prefs.apple.hasKey, ontoggle: (e) => { ownKeyOpen = e.target.open; } },
          h('summary', {}, 'Use my own Apple Developer key instead'),
          h('p', { class: 'set-note' }, 'Members of the Apple Developer Program can make a MusicKit key, which is the way Apple intends apps to connect.'),
          h('ol', { class: 'steps' },
            h('li', {}, 'At developer.apple.com, open Certificates, Identifiers & Profiles, then Keys. Create a key with ', h('strong', {}, 'Media Services (MusicKit)'), ' ticked and download the .p8 file.'),
            h('li', {}, 'Copy the Key ID shown next to the key, and your Team ID from the Membership page.'),
            h('li', {}, 'Enter both here and choose the .p8 file.')),
          h('p', { class: 'set-note' }, h('button', { class: 'text-btn', onclick: () => post('/api/open', { url: 'https://developer.apple.com/account/resources/authkeys/list' }) }, 'Open the Keys page at developer.apple.com')),
          h('div', { class: 'fields' },
            field('Team ID', team),
            field('Key ID', key),
            field('Private key', h('div', { class: 'key-row' },
              h('span', { class: prefs.apple.hasKey ? '' : 'quiet' }, prefs.apple.hasKey ? 'Key saved (encrypted for your Windows account)' : 'No key chosen'),
              button(prefs.apple.hasKey ? 'Replace…' : 'Choose .p8 file…', async () => {
                await savePrefs({ appleTeamId: team.value, appleKeyId: key.value });
                const res = await post('/api/pick-key');
                if (res.error) toast(res.error, { ms: 6000 });
                if (res.ok) { await savePrefs({}); draw(); }
              })))),
          h('div', { class: 'fields' },
            field('Or paste a developer token', token, 'A token you made yourself. It is used in place of the key until you clear it.')),
          h('div', { class: 'panel-actions' },
            h('button', {
              class: 'btn',
              onclick: async () => {
                if (busy) return;
                busy = true;
                try {
                  const changes = { appleTeamId: team.value, appleKeyId: key.value };
                  if (token.value.trim()) changes.appleToken = token.value;
                  await savePrefs(changes);
                  const ready = prefs.apple.hasToken || (prefs.apple.hasKey && prefs.apple.teamId && prefs.apple.keyId);
                  if (!ready) { toast('Add the Team ID, the Key ID and the .p8 key first.'); return; }
                  await reconnect();
                } finally {
                  busy = false;
                  draw();
                }
              },
            }, 'Save and connect'),
            (prefs.apple.hasKey || prefs.apple.hasToken) && button('Clear', removeSetup)))));
  }

  // ---- YouTube Music ----

  let fetching = false;
  let working = null; // 'signin' | 'tokens' while one of those is under way
  let ytdlpOpen = false;

  /** Runs one of the slower YouTube set-up steps, with its button showing that it is busy. */
  async function youtubeStep(name, step) {
    if (working) return;
    working = name;
    draw();
    try {
      await step();
    } catch (e) {
      toast(e?.message || String(e), { ms: 7000 });
    } finally {
      working = null;
      draw();
    }
  }

  function youtubeSection() {
    const status = youtube.getStatus();
    let found = "Tint couldn't check whether yt-dlp is on this PC.";
    if (status && !status.tool) found = "yt-dlp isn't installed. Sign in to Google to use YouTube Music's own player; install yt-dlp only if you want the fallback player.";
    else if (status) found = `Using yt-dlp ${status.version || '(found, but would not start)'} (${status.tool === 'own' ? "Tint's own copy" : 'system PATH'}).`;

    const rows = [
      setRow('Search & play from YouTube Music', "Include YouTube Music's catalog in search and open YouTube links.",
        toggleSwitch(prefs.youtube, (e) => savePrefs({ youtube: e.target.checked }), { label: 'Search and play from YouTube Music' })),
    ];

    if (status) {
      if (status.signedIn) {
        rows.push(setRow('Playback engine', "YouTube Music's own player starts in about a second at High quality. yt-dlp acts as a fallback.",
          segmented('Play YouTube songs with', [
            ['page', "YouTube Music's player", 'youtubeMono'],
            ['ytdlp', 'yt-dlp', 'terminal'],
          ], prefs.youtubePlayer === 'ytdlp' ? 'ytdlp' : 'page', (v) => savePrefs({ youtubePlayer: v })),
          { stack: true }));
      }

      let verdict = 'Signed out, YouTube sends standard audio (~128 kbps) and sometimes refuses songs.';
      if (status.signedIn && status.tokens) verdict = 'Signed in with token helper ready. A Premium account gets ~256 kbps.';
      else if (status.signedIn) verdict = 'Signed in to Google. Your YouTube Music library shows under Albums, Songs and Playlists.';
      else if (status.tokens) verdict = 'Token helper is ready; sign in for Premium audio.';

      rows.push(
        status.signedIn && !status.expired
          ? setRow('Google account', verdict, button('Sign out of Google', () => youtubeStep('signin', () => youtube.signOut())))
          : h('div', { class: 'set-row is-stack' },
            status.expired && h('p', { class: 'warn' }, "Google has ended Tint's sign-in, so YouTube treats Tint as signed out. Sign in again to get Premium back."),
            h('div', { class: 'set-row-head' },
              h('div', { class: 'set-lbl' },
                h('b', {}, 'Google account'),
                h('span', {}, verdict + " Sign in with the Google account that has YouTube Premium.")),
              h('button', {
                class: 'btn primary', disabled: !!working,
                onclick: () => youtubeStep('signin', async () => {
                  if (!await youtube.signIn()) toast("Tint didn't get a sign-in. If Google refused to sign you in in that window, Tint needs another way to get it.", { ms: 9000 });
                }),
              }, working === 'signin' ? 'Waiting…' : 'Sign in to Google')),
            working === 'signin' && window.tintBrowserHost
              ? h('p', { class: 'quiet' }, 'Sign in in the window that opened. When YouTube Music shows there, close that window and Tint takes the sign-in from it.')
              : null,
            h('p', { class: 'warn' }, "yt-dlp's makers warn that YouTube can restrict or close an account that is used this way.")));

      rows.push(h('div', { class: 'set-row is-stack' },
        h('details', { open: ytdlpOpen || (!!status.tool && !status.runtime), ontoggle: (e) => { ytdlpOpen = e.target.open; } },
          h('summary', {}, 'yt-dlp & token helper (advanced / fallback)'),
          h('p', { class: 'quiet set-note' }, found),
          status.tool && !status.runtime && h('p', { class: 'warn set-note' }, "yt-dlp needs Deno or Node.js on this PC to read YouTube's player. Install either one, then start Tint again."),
          h('div', { class: 'panel-actions' },
            h('button', {
              class: 'btn', disabled: fetching,
              onclick: async () => {
                if (fetching) return;
                fetching = true;
                draw();
                try {
                  await youtube.install();
                  toast(`yt-dlp ${youtube.getStatus()?.version || ''} is ready.`);
                } catch (e) {
                  toast(e?.message || "yt-dlp couldn't be downloaded.", { ms: 6000 });
                } finally {
                  fetching = false;
                  draw();
                }
              },
            }, fetching ? 'Downloading…' : status.tool === 'own' ? 'Update yt-dlp' : 'Download latest yt-dlp'),
            h('button', {
              class: 'btn', disabled: !!working || !status.deno,
              onclick: () => youtubeStep('tokens', async () => { await youtube.installTokens(); toast('The token helper is set up.'); }),
            }, working === 'tokens' ? 'Downloading…' : status.tokens ? 'Update token helper' : 'Set up token helper')),
          h('p', { class: 'quiet set-note' }, status.tokens
            ? 'The token helper is set up. It starts when a YouTube song is fetched via yt-dlp and stops ten minutes after the last one.'
            : 'The optional token helper (~190 MB, runs on Deno) lets yt-dlp prove a real player is asking for Premium audio.'),
          !status.deno && h('p', { class: 'warn set-note' }, "The token helper runs on Deno, which isn't on this PC. Install Deno, then start Tint again."))));
    }

    return setSec('youtube', 'YouTube Music', 'youtubeMono', ...rows);
  }

  // ---- Spotify ----

  let spotifyBusy = false;
  let spotifyHelpOpen = false;

  function spotifySection() {
    const s = spotify.getStatus();
    const redirectUri = s?.redirectUri || 'http://127.0.0.1:47813/spotify-callback';
    const signedIn = !!s?.signedIn;
    const configured = !!s?.configured;

    const doSignIn = async () => {
      if (spotifyBusy) return;
      spotifyBusy = true;
      draw();
      try {
        await spotify.signIn();
        await savePrefs({});
        toast('Signed in to Spotify');
      } catch (e) {
        toast(e?.message || 'Spotify sign-in was cancelled.', { ms: 6000 });
      } finally {
        spotifyBusy = false;
        draw();
      }
    };

    const removeSetup = async () => {
      await spotify.signOut().catch(() => {});
      await savePrefs({ forgetSpotify: true });
      await spotify.init();
      draw();
    };

    if (signedIn) {
      const who = s.user ? `Signed in as ${s.user}.` : 'Signed in.';
      const plan = s.premium === false
        ? ' Your account does not show Spotify Premium — playback via the web player requires Premium.'
        : ' Your Spotify library, playlists and full catalog are ready to play.';
      return setSec('spotify', 'Spotify', 'spotifyMono',
        setRow('Search & play from Spotify', 'Include your Spotify library in Albums, Songs, Playlists and Search.',
          toggleSwitch(!!prefs.spotify?.enabled, async (e) => {
            await savePrefs({ spotifyEnabled: e.target.checked });
            await spotify.init();
            draw();
          }, { label: 'Search and play from Spotify' })),
        s.premium === false && h('div', { class: 'set-row is-stack' },
          h('p', { class: 'warn' }, 'Spotify Web Playback SDK requires an active Spotify Premium subscription.')),
        setRow('Account', who + plan,
          h('div', { class: 'set-inline-actions' },
            button('Sign out', async () => { await spotify.signOut(); await savePrefs({}); draw(); }),
            button('Remove setup', removeSetup))));
    }

    const clientIdInput = h('input', {
      type: 'text',
      value: s?.clientId || prefs.spotify?.clientId || '',
      placeholder: '32-character Client ID',
      maxLength: 64,
      spellcheck: false,
      autocomplete: 'off',
    });

    const saveAndSignIn = async () => {
      const value = clientIdInput.value.trim();
      if (!/^[a-f0-9]{20,64}$/i.test(value)) {
        toast('Paste the Client ID from your Spotify Developer Dashboard app.');
        return;
      }
      await savePrefs({ spotifyClientId: value, spotifyEnabled: true });
      await spotify.init();
      await doSignIn();
    };

    const rows = [];
    if (s?.error) rows.push(h('div', { class: 'set-row is-stack' }, h('p', { class: 'warn' }, s.error)));

    if (configured) {
      rows.push(setRow('Sign in', 'Client ID saved. Sign in with your Spotify Premium account to browse your library and stream directly in Tint.',
        h('div', { class: 'set-inline-actions' },
          h('button', { class: 'btn primary', disabled: spotifyBusy, onclick: doSignIn }, spotifyBusy ? 'Waiting…' : 'Sign in to Spotify'),
          button('Remove setup', removeSetup))));
    }

    rows.push(h('div', { class: 'set-row is-stack' },
      field('Client ID', h('div', { class: 'id-row' },
        clientIdInput,
        h('button', { class: 'btn primary', disabled: spotifyBusy, onclick: saveAndSignIn }, spotifyBusy ? 'Waiting…' : configured ? 'Save & sign in' : 'Save & sign in')),
        'Uses OAuth PKCE — no Client Secret needed. Your sign-in token is encrypted locally for your Windows account.'),
      field('Redirect URI (add this in Spotify Dashboard)',
        h('div', { class: 'key-row' },
          h('span', { class: 'folder-path', title: redirectUri }, redirectUri),
          button('Copy', () => copyText(redirectUri, 'Redirect URI copied')))),
      h('details', { open: spotifyHelpOpen || !configured, ontoggle: (e) => { spotifyHelpOpen = e.target.open; } },
        h('summary', {}, 'How to connect Spotify Premium (1 minute)'),
        h('ol', { class: 'steps' },
          h('li', {}, 'Open the Spotify Developer Dashboard and click ', h('strong', {}, 'Create app'), ' (any name, e.g. "Tint").'),
          h('li', {}, 'Under ', h('strong', {}, 'Redirect URIs'), ', paste the Redirect URI shown above and tick ', h('strong', {}, 'Web API'), ' + ', h('strong', {}, 'Web Playback SDK'), ', then click ', h('strong', {}, 'Save'), '.'),
          h('li', {}, 'Copy the app\'s ', h('strong', {}, 'Client ID'), ' from Settings, paste it above, and click ', h('strong', {}, 'Save & sign in'), '.')),
        h('p', { class: 'set-note' },
          h('button', { class: 'text-btn', onclick: () => post('/api/open', { url: 'https://developer.spotify.com/dashboard' }) }, 'Open the Spotify Developer Dashboard')))));

    return setSec('spotify', 'Spotify', 'spotifyMono', ...rows);
  }

  // ---- Discord ----

  const discordStatus = h('span', { class: 'discord-pill', 'aria-live': 'polite' });
  let discordHelpOpen = false;

  async function drawDiscordStatus() {
    let text = '';
    let state = 'off';
    if (!prefs.discord.appId) text = 'Add an application ID';
    else if (!prefs.discord.enabled) text = 'Off';
    else {
      try {
        const s = await get('/api/discord/status');
        if (s.status === 'connected') {
          state = 'on';
          text = s.user ? `Connected as ${s.user}` : 'Connected';
          if (s.problem) text += ` · ${s.problem}`;
        } else {
          state = 'wait';
          text = s.problem || 'Connecting…';
        }
      } catch {
        text = '';
      }
    }
    discordStatus.textContent = text;
    discordStatus.dataset.state = state;
  }

  const discordTimer = setInterval(drawDiscordStatus, 2000);

  function discordSection() {
    const id = h('input', {
      type: 'text', value: prefs.discord.appId, placeholder: '1234567890123456789', maxLength: 22,
      inputMode: 'numeric', spellcheck: false, autocomplete: 'off',
    });
    const saveId = async () => {
      const value = id.value.trim();
      if (value && !/^\d{15,22}$/.test(value)) {
        toast('An application ID is a long number, like 1234567890123456789.');
        return;
      }
      await savePrefs(value ? { discordAppId: value, discordEnabled: true } : { discordAppId: '', discordEnabled: false });
      id.blur();
      draw();
    };
    drawDiscordStatus();

    return setSec('discord', 'Discord', 'discordMono',
      setRow("Show what I'm listening to",
        h('span', { class: 'discord-desc' }, 'Shows song, artist, cover and progress bar while playing. ', discordStatus),
        toggleSwitch(prefs.discord.enabled, async (e) => { await savePrefs({ discordEnabled: e.target.checked }); drawDiscordStatus(); },
          { disabled: !prefs.discord.appId, label: "Show what I'm listening to on Discord" })),
      h('div', { class: 'set-row is-stack' },
        field('Application ID', h('div', { class: 'id-row' }, id, button('Save', saveId, 'primary')),
          'For local songs, covers are looked up in Apple\'s public catalog.'),
        h('details', { open: discordHelpOpen || !prefs.discord.appId, ontoggle: (e) => { discordHelpOpen = e.target.open; } },
          h('summary', {}, 'How to get a Discord Application ID'),
          h('ol', { class: 'steps' },
            h('li', {}, 'Open the Discord Developer Portal and choose ', h('strong', {}, 'New Application'), '. Its name appears on your profile above the song (e.g. "Music" or "Tint").'),
            h('li', {}, 'On its General Information page, copy the ', h('strong', {}, 'Application ID'), '.'),
            h('li', {}, 'Paste it above and save.')),
          h('p', { class: 'set-note' }, h('button', { class: 'text-btn', onclick: () => post('/api/open', { url: 'https://discord.com/developers/applications' }) }, 'Open the Discord Developer Portal')))));
  }

  // ---- Data & cache ----
  let cacheSize = null;
  const sizeText = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
  const loadCacheSize = () => pagecache.size().then((s) => { cacheSize = s; draw(); }, () => {});
  let exported = null; // where the last backup went
  let exporting = false;

  function cacheSection() {
    const summary = !cacheSize ? 'Counting…'
      : cacheSize.count ? `${plural(cacheSize.count, 'page')} kept, ${sizeText(cacheSize.bytes)}.`
        : 'Nothing kept yet.';
    const keep = [[7, '1 week'], [14, '2 weeks'], [30, '1 month'], [90, '3 months'], [365, '1 year'], [0, 'Never']];
    return setSec('data', 'Data & cache', 'database',
      setRow('Backup & restore',
        "Saved playlists, tags, play history and settings stay on this PC (sign-ins aren't included). Export to move to another PC.",
        h('div', { class: 'set-inline-actions' },
          h('button', {
            class: 'btn', disabled: exporting,
            onclick: async () => {
              exporting = true;
              draw();
              try {
                exported = await backup.exportAll();
                toast('Backup saved in Downloads');
              } catch (e) {
                toast(e?.message || "The backup couldn't be saved.", { ms: 6000 });
              } finally {
                exporting = false;
                draw();
              }
            },
          }, h('span', { class: 'btn-icon', icon: 'download' }), exporting ? 'Exporting…' : 'Export'),
          button('Import', () => pickBackup(draw)),
          exported && h('button', { class: 'text-btn', title: exported, onclick: () => backup.show(exported) }, 'Show file'))),
      setRow('Keep opened pages for', 'Albums and playlists you open are cached so they load instantly. Saved playlists always keep their songs.',
        select('Forget pages not opened or played for', keep.map(([days, text]) => [String(days), text]), String(prefs.cacheKeepDays ?? 30),
          async (v) => { await savePrefs({ cacheKeepDays: Number(v) }); loadCacheSize(); })),
      setRow('Cached pages', summary,
        button('Clear cache', async () => {
          const { gone } = await pagecache.clear();
          toast(gone ? `Cleared ${plural(gone, 'page')}` : 'There was nothing to clear');
          loadCacheSize();
        })));
  }

  let checking = false;

  function updateSection() {
    const s = update.getStatus();
    const version = s?.current ? `Tint ${s.current}` : 'Tint';
    const canUpdate = !!s?.possible;
    const downloading = canUpdate && s.state === 'downloading';
    const ready = canUpdate && s.state === 'ready';
    const pct = downloading ? update.percent() : ready ? 100 : null;
    const text = canUpdate
      ? (update.describe() || (checking ? 'Looking for a newer version…' : 'This is the newest version.'))
      : 'Running a local build. Automatic updates are available in release builds.';
    const sec = setSec('updates', 'Updates', 'refresh',
      setRow(version, text,
        h('div', { class: 'set-inline-actions' },
          canUpdate && update.actions(button),
          canUpdate && !downloading && !ready && button('Check now', async () => {
            checking = true;
            draw();
            await update.check(true);
            checking = false;
            draw();
          }),
          downloading && h('span', { class: 'set-nav-pct' }, `${pct}%`),
          canUpdate && s.latest && s.page && h('button', { class: 'text-btn', onclick: update.openNotes }, "What's new"),
          !canUpdate && h('button', {
            class: 'text-btn',
            onclick: () => post('/api/open', { url: 'https://github.com/akaydevelop/TintMusicPlayer/releases' }),
          }, 'Releases'))));
    if (pct != null) {
      const card = sec.querySelector('.set-card');
      card.classList.add('is-progress');
      if (ready) card.classList.add('is-done');
      card.style.setProperty('--progress', `${pct}%`);
    }
    return sec;
  }

  // Persistent search box so typing never loses focus across background refreshes.
  const searchInput = h('input', {
    type: 'search',
    placeholder: 'Search settings',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Search settings',
    oninput: (e) => { searchQuery = e.target.value; applyFilter(); },
    onkeydown: (e) => { if (e.key === 'Escape' && searchInput.value) { searchInput.value = ''; searchQuery = ''; applyFilter(); } },
  });
  const searchWrap = h('label', { class: 'set-search' },
    h('span', { class: 'search-icon', icon: 'search' }),
    searchInput);
  const topBar = h('header', { class: 'set-top' },
    h('h1', {}, 'Settings'),
    searchWrap);
  const navEl = h('nav', { class: 'set-nav', 'aria-label': 'Settings sections' });
  const mainEl = h('div', { class: 'set-main' });
  const emptyMatch = h('p', { class: 'quiet set-empty', hidden: true }, 'No settings match that search.');
  const bodyEl = h('div', { class: 'set-body' }, navEl, mainEl);
  fill(el, topBar, bodyEl);

  function setActiveNav(id) {
    activeSec = id;
    navEl.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b.dataset.sec === id));
  }

  function applyFilter() {
    const q = searchQuery.trim().toLowerCase();
    const secs = [...mainEl.querySelectorAll('.set-sec')];
    let matched = 0;
    for (const sec of secs) {
      if (!q) {
        sec.hidden = false;
        sec.querySelectorAll('.set-row').forEach((r) => { r.hidden = false; });
        matched++;
        continue;
      }
      const titleHit = sec.querySelector('.set-sec-head')?.textContent.toLowerCase().includes(q);
      const rows = [...sec.querySelectorAll('.set-row')];
      let anyRow = false;
      for (const r of rows) {
        const hit = titleHit || r.textContent.toLowerCase().includes(q);
        r.hidden = !hit;
        if (hit) anyRow = true;
      }
      sec.hidden = !anyRow;
      if (anyRow) matched++;
    }
    navEl.querySelectorAll('button').forEach((b) => {
      const sec = mainEl.querySelector(`#set-${b.dataset.sec}`);
      b.hidden = !sec || sec.hidden;
    });
    emptyMatch.hidden = matched > 0;
  }

  function jumpTo(id, smooth = true) {
    setActiveNav(id);
    const target = mainEl.querySelector(`#set-${id}`);
    if (!target) return;
    target.scrollIntoView({ block: 'start', behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
  }

  const onScroll = () => {
    if (searchQuery.trim() || !scroller) return;
    const top = scroller.getBoundingClientRect().top + 96;
    const secs = [...mainEl.querySelectorAll('.set-sec')].filter((s) => !s.hidden);
    let current = secs[0]?.dataset.sec;
    for (const sec of secs) {
      if (sec.getBoundingClientRect().top <= top) current = sec.dataset.sec;
    }
    if (current && current !== activeSec) setActiveNav(current);
  };
  scroller?.addEventListener('scroll', onScroll, { passive: true });

  function draw() {
    // Typing in a settings input shouldn't be interrupted by a background refresh.
    if (mainEl.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const up = update.getStatus();
    const upDownloading = !!(up?.possible && up.state === 'downloading');
    const upReady = !!(up?.possible && up.state === 'ready');
    const upPct = upDownloading ? update.percent() : upReady ? 100 : null;
    const hasUpdate = !!(up?.possible && up.latest && !upDownloading && !upReady);
    const sections = [
      { id: 'updates', label: 'Updates', icon: 'refresh', el: updateSection(), progress: upPct, downloading: upDownloading, ready: upReady, dot: hasUpdate },
      { id: 'general', label: 'General & library', icon: 'pc', el: generalSection() },
      { id: 'appearance', label: 'Appearance', icon: 'palette', el: appearanceSection() },
      { id: 'playback', label: 'Playback', icon: 'play', el: playbackSection() },
      { id: 'apple', label: 'Apple Music', icon: 'appleMono', el: appleSection() },
      { id: 'youtube', label: 'YouTube Music', icon: 'youtubeMono', el: youtubeSection() },
      { id: 'spotify', label: 'Spotify', icon: 'spotifyMono', el: spotifySection() },
      { id: 'discord', label: 'Discord', icon: 'discordMono', el: discordSection() },
      { id: 'data', label: 'Data & cache', icon: 'database', el: cacheSection() },
    ].filter((s) => s.el);

    fill(navEl, sections.map((s) => {
      const hasProgress = s.progress != null;
      const btn = h('button', {
        type: 'button',
        class: 'set-nav-btn'
          + (s.id === activeSec ? ' is-active' : '')
          + (hasProgress ? ' has-progress' : '')
          + (s.downloading ? ' is-downloading' : ''),
        dataset: { sec: s.id },
        onclick: () => jumpTo(s.id, true),
      },
        h('span', { class: 'set-nav-icon', icon: s.icon }),
        h('span', {}, s.label),
        s.downloading && h('span', { class: 'set-nav-pct' }, `${s.progress}%`),
        s.ready && h('span', { class: 'set-nav-pct' }, 'Ready'),
        s.dot && h('span', { class: 'set-nav-dot', 'aria-label': 'Update available' }));
      if (hasProgress) btn.style.setProperty('--progress', `${s.progress}%`);
      return btn;
    }));

    fill(mainEl,
      ...sections.map((s) => s.el),
      emptyMatch,
      h('p', { class: 'quiet about' }, `Tint${update.getStatus() ? ' ' + update.getStatus().current : ''}. Space plays and pauses, Ctrl+Right and Ctrl+Left change songs, Ctrl+F searches. Product names and logos are trademarks of their owners.`));
    applyFilter();
  }

  draw();
  loadCacheSize();
  // Opened at one section (#/settings/apple, say), as the welcome does.
  const wanted = { updates: 'updates', apple: 'apple', youtube: 'youtube', spotify: 'spotify', data: 'data' }[params?.[0]];
  if (wanted) requestAnimationFrame(() => jumpTo(wanted, false));

  return {
    el,
    refresh: (why) => { if (why !== 'track') draw(); },
    destroy: () => {
      clearInterval(discordTimer);
      scroller?.removeEventListener('scroll', onScroll);
    },
  };
}

// ---- routes -------------------------------------------------------------------------------------

export const routes = {
  albums: albumsView,
  songs: songsView,
  playlists: playlistsView,
  home: startView,
  listen: homeView,
  search: searchView,
  settings: settingsView,
  lyrics: lyricsView,
  'album/l': localAlbumView,
  'album/a': appleAlbumView,
  'playlist/a': applePlaylistView,
  'artist/l': artistView('l'),
  'artist/a': artistView('a'),
  'album/y': youtubeAlbumView,
  'playlist/y': youtubePlaylistView,
  'artist/y': artistView('y'),
  'album/s': spotifyAlbumView,
  'playlist/s': spotifyPlaylistView,
  'artist/s': artistView('s'),
  'playlist/t': tintPlaylistView,
  welcome: welcomeView,
};
