// Every page in the browsing pane. A view is a function that returns { el, refresh?, destroy? }.
// `refresh` is called when the data behind the page changes (a scan finished, more of the Apple
// Music library arrived, a different song started).

import { h, fill, cover, fmtTime, fmtLength, plural, showMenu, showPopover, closeMenu, toast, replay, fadeInWhenSeen, copyText, VirtualList, VirtualGrid } from './ui.js';
import * as player from './player.js';
import * as apple from './apple.js';
import * as youtube from './youtube.js';
import * as spotify from './spotify.js';
import * as collection from './collection.js';
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

function segmented(label, options, value, onPick) {
  return h('div', { class: 'segmented', role: 'group', 'aria-label': label },
    options.map(([id, text]) => h('button', {
      'aria-pressed': String(id === value),
      onclick: () => onPick(id),
    }, text)));
}

function select(label, options, value, onPick) {
  return h('label', { class: 'select' },
    h('span', { class: 'sr' }, label),
    h('select', { onchange: (e) => onPick(e.target.value) },
      options.map(([id, text]) => h('option', { value: id, selected: id === value }, text))));
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

function trackMenu(x, y, track) {
  showMenu(x, y, [
    { label: 'Play next', run: () => { player.playNext([track]); toast(`"${track.title}" plays next`); } },
    { label: 'Add to queue', run: () => { player.addToQueue([track]); toast(`Added "${track.title}" to the queue`); } },
    track.artist && { label: 'Go to artist', run: () => { location.hash = artistHref(track); } },
    track.albumHref && { label: 'Go to album', run: () => { location.hash = track.albumHref; } },
    { label: 'Copy title', run: () => copyText(track.title, 'Title copied') },
    { label: 'Share YouTube Music link', run: () => youtube.share(track) },
  ]);
}

function trackRow(tracks, i, { numbered = false, showAlbum = true, albumArtist = null } = {}) {
  const track = tracks[i];
  const isCurrent = player.current()?.id === track.id;
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
    onclick: (e) => { if (!e.target.closest('.row-more')) play(); },
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) play(); },
    oncontextmenu: (e) => { e.preventDefault(); trackMenu(e.clientX, e.clientY, track); },
  },
    h('span', { class: 'row-lead' }, lead),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title' }, track.title, track.explicit && h('span', { class: 'explicit', title: 'Explicit' }, 'E'),
        // Album pages name a Japanese song in English too, unless its title already does.
        numbered && track.englishTitle && !track.title.includes(track.englishTitle) && h('span', { class: 'row-english' }, track.englishTitle)),
      // On an album page the artist is in the heading; only guests need naming on the rows.
      track.artist !== albumArtist && h('span', { class: 'row-sub' }, track.artist)),
    showAlbum && h('span', { class: 'row-album' }, track.album),
    h('span', { class: 'row-time' }, track.duration ? fmtTime(track.duration) : ''),
    h('button', {
      class: 'icon-btn small row-more', icon: 'more', 'aria-label': `More for ${track.title}`, title: 'More',
      onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); trackMenu(r.right - 180, r.bottom + 4, track); },
    }));
}

// Set while a page swaps a kept copy for the service's newer answer, so nothing on it fades in again.
let calmDraw = false;

/**
 * A track list. Only the rows on screen (and a few either side) exist at any time, however long it
 * is. `only` limits it to some of `tracks` (one disc of an album), still playing from the whole.
 */
function trackList(scroller, tracks, options = {}) {
  const only = options.only || null;
  const count = only ? only.length : tracks.length;
  // Each song fades in the first time it comes into view. Redrawn rows (a new song started, or the
  // list moving its window) that were already seen stay put.
  const seen = new Set(calmDraw ? Array.from({ length: count }, (_, i) => i) : []);
  const row = (i) => {
    const el = trackRow(tracks, only ? only[i] : i, options);
    return seen.has(i) ? el : fadeInWhenSeen(el, () => seen.add(i));
  };
  const list = new VirtualList({ scroller, rowHeight: ROW, count, className: 'tracks', render: row });
  return { el: list.el, refresh: () => list.refresh(), destroy: () => list.destroy() };
}

async function tracksOf(item) {
  if (item.source === 'tint') return collection.find(item.href)?.tracks || item.tracks || [];
  const saved = collection.find(item.href);
  if (item.tracks && !saved) return item.tracks;
  pagecache.used(item.href);
  const isPlaylist = item.href.includes('#/playlist/');
  const from = item.source === 'youtube' ? youtube : apple;
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
    oncontextmenu: isPlaylist ? (e) => { e.preventDefault(); playlistMenu(e.clientX, e.clientY, item); } : null,
    // On the Playlists page a playlist can be picked up and dropped on a tag to be given it.
    draggable: false,
    onpointerdown: isPlaylist ? (e) => liftPlaylist(e, item, el) : null,
  },
    h('span', { class: 'card-art' },
      cover(item.art, 200),
      isPlaylist && h('button', {
        class: 'card-pin' + (saved?.pinned ? ' is-pinned' : ''), icon: 'pin',
        title: saved?.pinned ? 'Unpin' : 'Pin to the top', 'aria-label': `${saved?.pinned ? 'Unpin' : 'Pin'} ${item.title}`,
        'aria-pressed': String(!!saved?.pinned), onclick: pinIt,
      }),
      item.href.includes('#/artist/') ? null : h('button', { class: 'card-play', icon: 'play', 'aria-label': `Play ${item.title}`, onclick: playIt })),
    h('span', { class: 'card-title' }, item.title),
    item.artist && h('span', { class: 'card-sub' }, item.artist),
    marks.length ? h('button', { class: 'card-tags', title: 'Change the tags', 'aria-label': `Tags of ${item.title}`, onclick: openTags }, marks.map(tagLabel)) : null);
  // Each card glides in the first time it comes into view, and stays still when a page redraws.
  return cardsSeen.has(item.href) ? el : fadeInWhenSeen(el, () => cardsSeen.add(item.href));
}

const cardsSeen = new Set();

// ---- saved playlists, pins and tags -------------------------------------------------------------

/** Gives an element its tag's colour, which the stylesheet reads as --tag. */
function tagged(el, color) {
  el.style.setProperty('--tag', color);
  return el;
}

const tagLabel = (t) => tagged(h('span', { class: 'tag-label' }, h('span', { class: 'tag-dot' }), t.name), t.color);
const nextColor = (color) => collection.COLORS[(collection.COLORS.indexOf(color) + 1) % collection.COLORS.length];

/** Saves a playlist in Tint with its songs. Returns the saved copy, or null when it couldn't be. */
async function saveInTint(item, quiet = false) {
  try {
    const tracks = item.tracks || await tracksOf(item);
    collection.save({ ...item, tracks });
    if (!quiet) toast(`Saved "${item.title}" in Tint`);
    return collection.find(item.href);
  } catch (e) {
    toast(e?.message || "That playlist couldn't be saved.");
    return null;
  }
}

/** What can be done with a saved playlist: pin it, tag it, or let it go. */
function savedMenuItems(x, y, saved) {
  return [
    { label: saved.pinned ? 'Unpin' : 'Pin to the top', run: () => collection.setPinned(saved.href, !saved.pinned) },
    { label: 'Tags…', run: () => tagPanel(x, y, saved.href) },
    { label: 'Remove from Tint', run: () => { collection.remove(saved.href); toast(`Removed "${saved.title}" from Tint`); } },
  ];
}

function playlistMenu(x, y, item) {
  const saved = collection.find(item.href);
  showMenu(x, y, saved ? savedMenuItems(x, y, saved) : [
    { label: 'Save in Tint', run: () => saveInTint(item) },
    { label: 'Pin to the top', run: async () => { if (await saveInTint(item, true)) collection.setPinned(item.href, true); } },
    { label: 'Tags…', run: async () => { if (await saveInTint(item, true)) tagPanel(x, y, item.href); } },
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
      title: saved ? 'Saved in Tint. Pin it or tag it' : 'Keep this playlist in Tint',
      onclick: (e) => {
        const now = collection.find(playlist.href);
        if (!now) {
          collection.save(playlist);
          toast(`Saved "${playlist.title}" in Tint`);
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
function tagFilter(all, current, onPick) {
  return h('div', { class: 'tag-filter', role: 'group', 'aria-label': 'Show playlists tagged' },
    all.length ? h('button', { class: 'tag-chip', 'aria-pressed': String(!current), onclick: () => onPick(null) }, 'Any tag') : null,
    all.map((t) => tagged(h('button', {
      class: 'tag-chip', 'aria-pressed': String(current === t.id), onclick: () => onPick(current === t.id ? null : t.id),
      title: 'Show only these. Drop a playlist here to tag it', dataset: { tag: t.id },
    }, h('span', { class: 'tag-dot' }), t.name, h('span', { class: 'tag-chip-count' }, String(tagUses(t.id)))), t.color)),
    h('button', {
      class: 'tag-chip tag-chip-edit', title: 'Make, rename, recolour or delete tags',
      onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); tagPanel(r.left, r.bottom + 6, null); },
    }, h('span', { class: 'tag-add-icon', icon: all.length ? 'pen' : 'plus' }), all.length ? 'Edit tags' : 'Make a tag'));
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
  return [['all', 'All'], ['local', 'On this PC'],
    apple.isSignedIn() && ['apple', 'Apple Music'],
    youtube.isSignedIn() && ['youtube', 'YouTube Music']].filter(Boolean);
}

/** One kind of thing (albums, songs) from this PC and from each signed-in library, narrowed to the chosen source. */
function gather(wanted, mine, fromApple, fromYouTube) {
  const choices = sources();
  const source = choices.some(([id]) => id === wanted) ? wanted : 'all';
  const parts = { apple: apple.isSignedIn() ? fromApple() : null, youtube: youtube.isSignedIn() ? fromYouTube() : null };
  let items = source === 'all' || source === 'local' ? mine.slice() : [];
  for (const [name, part] of Object.entries(parts)) {
    if (part && (source === 'all' || source === name)) items = items.concat(part.items);
  }
  const notes = [libraryNote('Apple Music', parts.apple), libraryNote('YouTube Music', parts.youtube)].filter(Boolean);
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
    'Add a folder that holds your music, or connect Apple Music to bring in your library.',
    linkButton('Open settings', '#/settings', 'primary'));
}

// ---- Albums -------------------------------------------------------------------------------------

function albumsView() {
  const el = h('section', { class: 'page' });

  function draw() {
    const { items: found, source, choices, notes, remote } = gather(memory.albumSource, local.albums, apple.libraryAlbums, youtube.libraryAlbums);
    const items = source === 'all' && remote ? withoutDoubles(found) : found;

    const sort = memory.albumSort;
    items.sort(sort === 'title' ? (a, b) => compareText(a.title, b.title)
      : sort === 'recent' ? (a, b) => (b.added || 0) - (a.added || 0)
        : (a, b) => compareText(a.artist, b.artist) || (a.year || '').localeCompare(b.year || '') || compareText(a.title, b.title));

    fill(el,
      pageHead('Albums', [plural(items.length, 'album'), ...notes].join('. '),
        remote && segmented('Show albums from', choices, source, (v) => { memory.albumSource = v; draw(); }),
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
    const { items, source, choices, notes, remote } = gather(memory.songSource, local.tracks, apple.librarySongs, youtube.librarySongs);
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
        remote && segmented('Show songs from', choices, source, (v) => { memory.songSource = v; draw(); }),
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
    const parts = [
      apple.isSignedIn() && ['Apple Music', apple.libraryPlaylists()],
      youtube.isSignedIn() && ['YouTube Music', youtube.libraryPlaylists()],
    ].filter(Boolean);
    const saved = collection.items();
    if (!parts.length && !saved.length) {
      fill(el, pageHead('Playlists'), connectPrompt('Your playlists live in Apple Music and YouTube Music'),
        h('p', { class: 'quiet' }, 'Or paste a YouTube or Spotify playlist link in the search box to open it and save it here.'));
      return;
    }
    // The list can be narrowed to the playlists saved in Tint, or to one service's.
    const choices = [['all', 'All'], saved.length && ['saved', 'Saved in Tint'], ...parts.map(([name]) => [name, name])].filter(Boolean);
    const source = choices.some(([id]) => id === memory.playlistSource) ? memory.playlistSource : 'all';
    // A saved playlist stands in for the same one in a service's library, so it shows once.
    const savedHere = new Set(saved.map((item) => item.href));
    let items = [
      ...(source === 'all' || source === 'saved' ? saved : []),
      ...parts.filter(([name]) => source === 'all' || source === name).flatMap(([, part]) => part.items)
        .filter((item) => source !== 'all' || !savedHere.has(item.href)),
    ];
    const allTags = collection.tags();
    const tagWanted = allTags.some((t) => t.id === memory.playlistTag) ? memory.playlistTag : null;
    if (tagWanted) items = items.filter((item) => collection.find(item.href)?.tags?.includes(tagWanted));
    items.sort((a, b) => compareText(a.title, b.title));
    // Pinned playlists come first, in the order they were pinned.
    const pinnedAt = (item) => collection.find(item.href)?.pinnedAt || 0;
    const pinned = items.filter((item) => collection.find(item.href)?.pinned).sort((a, b) => pinnedAt(a) - pinnedAt(b));
    const rest = items.filter((item) => !pinned.includes(item));

    const notes = parts.map(([name, part]) => libraryNote(name, part)).filter(Boolean);
    const waiting = parts.some(([, part]) => part.state === 'idle' || part.state === 'loading');
    const section = (title, body) => h('section', { class: 'shelf' }, h('h2', {}, title), body);
    let body;
    if (pinned.length) body = [section('Pinned', grid(pinned)), rest.length ? section('Everything else', grid(rest)) : null];
    else if (rest.length) body = grid(rest);
    else if (tagWanted) body = emptyState(`Nothing tagged "${collection.tag(tagWanted).name}"`, 'Drag a playlist onto this tag above, or right-click it and choose Tags….');
    else if (waiting) body = loading();
    else body = emptyState('No playlists yet', 'Playlists you make in Apple Music or YouTube Music, or save in Tint, show up here. Paste a YouTube or Spotify playlist link in the search box to open one.');
    fill(el,
      pageHead('Playlists', [plural(items.length, 'playlist'), ...notes].join('. '),
        choices.length > 2 && segmented('Show playlists from', choices, source, (v) => { memory.playlistSource = v; draw(); })),
      allTags.length || items.length ? tagFilter(allTags, tagWanted, (id) => { memory.playlistTag = id; draw(); }) : null,
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
    const saved = collection.items();
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
      else if (why === 'track' || why === 'collection' || why === 'local') draw();
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

function detailHead({ art, kind, title, byline, bylineHref, facts, description, tracks, saveAs }) {
  const playable = tracks.filter((t) => t.playable !== false);
  const save = saveAs && saveArea(saveAs);
  return h('header', { class: 'detail-head' },
    h('div', { class: 'detail-art' }, cover(art, 240, { lazy: false })),
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
        h('button', {
          class: 'icon-btn', icon: 'more', 'aria-label': 'More', title: 'More', disabled: !playable.length,
          onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.left, r.bottom + 4, [
              { label: 'Play next', run: () => { player.playNext(tracks); toast(`"${title}" plays next`); } },
              { label: 'Add to queue', run: () => { player.addToQueue(tracks); toast(`Added "${title}" to the queue`); } },
              { label: 'Copy title', run: () => copyText(title, 'Title copied') },
            ]);
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
    refresh: (why) => { if (why === 'track') parts.forEach((p) => p.refresh()); else if (why === 'local') draw(); },
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
    calmDraw = !animate;
    try {
      const built = build(data);
      parts = built.parts || [];
      fill(el, ...built.nodes);
      // A quiet swap draws its rows now rather than a frame later, so the list never shows empty.
      if (!animate) parts.forEach((p) => p.refresh());
    } finally {
      calmDraw = false;
    }
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
    refresh: (why) => { if (why === 'track') parts.forEach((p) => p.refresh()); },
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
  return asyncView(() => liveOrSaved(href, apple.playlist(params[0])), (playlist) => {
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
        }),
        playlist.tracks.length ? list.el : emptyState('This playlist is empty'),
      ],
    };
  }, { cacheKey: href });
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
  return asyncView(() => liveOrSaved(href, youtube.playlist(params[0])), (playlist) => {
    const list = trackList(scroller, playlist.tracks);
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
        }),
        playlist.tracks.length ? list.el : emptyState('This playlist is empty'),
      ],
    };
  }, {
    needsApple: false, cacheKey: href,
    waiting: () => (pasted
      ? h('div', { class: 'link-opening' }, pastedNote('youtube', 'YouTube playlist link', 'Opening the playlist…'), h('div', { class: 'match-progress-bar is-busy' }, h('span')))
      : loading()),
  });
}

const SERVICE_NAMES = { apple: 'Apple Music', youtube: 'YouTube Music' };

/** A playlist made in Tint itself (from a Spotify link, say): its songs are the copy kept with it. */
function tintPlaylistView({ scroller, params }) {
  const href = `#/playlist/t/${encodeURIComponent(params[0])}`;
  return asyncView(async () => {
    const saved = collection.find(href);
    if (!saved) throw new Error('This playlist is no longer saved in Tint.');
    return saved;
  }, (playlist) => {
    const list = trackList(scroller, playlist.tracks);
    const length = playlist.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    const from = playlist.from?.kind === 'spotify'
      ? `Made from a Spotify ${playlist.from.what === 'album' ? 'album' : 'playlist'}, with its songs found on ${SERVICE_NAMES[playlist.from.service] || 'Apple Music and YouTube Music'}.`
      : '';
    return {
      parts: [list],
      nodes: [
        detailHead({
          art: playlist.art || playlist.tracks[0]?.art, kind: 'Playlist in Tint',
          title: playlist.title, byline: playlist.artist,
          facts: [plural(playlist.tracks.length, 'song'), length ? fmtLength(length) : null].filter(Boolean).join(', '),
          description: from, tracks: playlist.tracks, saveAs: playlist,
        }),
        playlist.tracks.length ? list.el : emptyState('This playlist is empty'),
      ],
    };
  }, { needsApple: false });
}

// ---- Artists ------------------------------------------------------------------------------------

/**
 * One artist page, whichever service it was opened from, or this PC (artist.js puts it together).
 * The discography is Apple Music's when Apple Music is set up; YouTube Music's otherwise.
 */
function artistView(kind) {
  return ({ scroller, params }) => {
    const ref = kind === 'a' ? { apple: params[0] } : kind === 'y' ? { youtube: params[0] } : { name: params[0] };
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
        : 'Neither Apple Music nor YouTube Music lists anything by this artist.'));
      const from = [artist.from.apple && 'Apple Music', artist.from.youtube && 'YouTube Music'].filter(Boolean);
      if (from.length) nodes.push(h('p', { class: 'quiet artist-from' }, `From ${from.join(' and ')}.`));
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
  // A pasted YouTube link: the song it points at goes first, then the rest found by its name.
  const linked = youtube.videoIn(term);
  let fromLink = linked ? 'loading' : null;
  // A pasted Spotify link: the same songs found on Apple Music and YouTube Music.
  const spotted = linked ? null : spotify.linkIn(term);
  let fromSpotify = spotted ? 'loading' : null; // then null (nothing there), an Error, or what spotifyFound() takes
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
      if (!apple.instance() && !youtube.isReady()) {
        nodes.push(emptyState('Nowhere to look', "Tint can't play from Spotify. Set up Apple Music or YouTube Music in Settings, and the same songs are found there."));
        fill(el, ...nodes);
        return;
      }
      if (fromSpotify === 'loading') nodes.push(loading('Reading the Spotify link…'));
      else if (fromSpotify instanceof Error) nodes.push(h('p', { class: 'quiet' }, `Spotify didn't answer: ${fromSpotify.message}`));
      else if (!fromSpotify) nodes.push(emptyState('Nothing at that link', "Spotify doesn't have anything there, or it's private."));
      else nodes.push(...spotifyFound(fromSpotify, songList));
    }

    // The songs a Spotify link was matched to are already at the top.
    const shown = new Set(fromSpotify?.found ? [fromSpotify.apple, fromSpotify.tube].filter((song) => song?.id).map((song) => song.id) : []);

    if (mine.songs.length) nodes.push(songList('Songs on this PC', mine.songs));
    if (mine.albums.length) nodes.push(h('section', { class: 'shelf' }, h('h2', {}, 'Albums on this PC'), grid(mine.albums)));

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
      count(remote, 'songs', 'albums', 'artists', 'playlists') + count(tube, 'songs', 'albums', 'artists');
    if (!found && query && remote !== 'loading' && tube !== 'loading') {
      nodes.push(emptyState('Nothing matched', apple.instance() || tube
        ? 'Check the spelling, or try fewer words.'
        : 'Only the music on this PC was searched. Set up Apple Music or YouTube Music in Settings to search their catalogs too.'));
    }
    fill(el, ...nodes);
    reveal();
  }

  function lookUp() {
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
  if (spotted) {
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
    refresh: (why) => { if (why === 'track') parts.forEach((p) => p.refresh()); else if (why === 'local') draw(); },
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
    h('span', { class: 'pasted-icon', icon: service }),
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

/** Where a Spotify list lives once it is saved in Tint. The same link always lands on the same playlist. */
const convertedHref = (link) => `#/playlist/t/spotify-${link.kind}-${link.id}`;

function saveConverted(state, songs, href) {
  const { found, link } = state;
  collection.save({
    id: `spotify-${link.kind}-${link.id}`, source: 'tint', href,
    title: found.title.trim(), artist: found.artist.trim(),
    art: found.art ? { url: found.art } : songs[0]?.art || null,
    tracks: songs,
    from: { kind: 'spotify', what: link.kind, url: `https://open.spotify.com/${link.kind}/${link.id}`, service: state.prefer, at: Date.now() },
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
  let choice = ['apple', 'youtube', 'pc'].includes(prefs.mainService) ? prefs.mainService : null;
  const returning = !!choice;
  let busy = false;
  const start = h('button', { class: 'btn primary', onclick: () => finish() }, 'Start listening');
  const services = [
    ['apple', 'Apple Music', 'Your Apple Music library, and the whole catalog with a subscription.'],
    ['youtube', 'YouTube Music', 'Your YouTube Music library and the whole catalog.'],
    ['pc', 'Only music on this PC', 'The music files in your folders. Either service can be set up later.'],
  ];
  const ready = () => { start.disabled = !choice || busy; start.title = choice ? '' : 'Choose where you listen first'; };

  async function finish() {
    if (!choice || busy) return;
    busy = true;
    ready();
    try {
      await savePrefs({ mainService: choice, welcomed: true, ...(choice === 'youtube' ? { youtube: true } : {}) });
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
          lineTexts[i] && { label: 'Copy this line', run: () => copyText(lineTexts[i], 'Line copied') },
          { label: 'Choose lines to copy…', run: () => startPicking(i) },
          { label: 'Copy all the lyrics', run: () => copyText(lineTexts.join('\n'), 'Lyrics copied') },
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

function settingsView({ params } = {}) {
  const el = h('section', { class: 'page settings' });
  let busy = false;

  const field = (label, input, hint) => h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label), input, hint && h('span', { class: 'quiet field-hint' }, hint));

  async function reconnect() {
    await apple.init();
    if (apple.getStatus() === 'error') toast(apple.getProblem());
  }

  function foldersSection() {
    let status = 'Scanning…';
    if (!local.scanning) {
      status = `${plural(local.tracks.length, 'song')} found.`;
      if (local.skippedProtected) {
        status += ` ${plural(local.skippedProtected, 'downloaded Apple Music file')} left out. Those are locked to Apple's own apps, so they play from Apple Music instead.`;
      }
    }
    return h('section', { class: 'panel' },
      h('h2', {}, 'Music on this PC'),
      h('p', { class: 'quiet' }, status),
      h('ul', { class: 'folders' },
        prefs.folders.map((folder) => h('li', {},
          h('span', { class: 'folder-icon', icon: 'folder' }),
          h('span', { class: 'folder-path', title: folder }, folder),
          h('button', {
            class: 'text-btn', 'aria-label': `Remove ${folder}`,
            onclick: async () => { await savePrefs({ folders: prefs.folders.filter((f) => f !== folder) }); nudge(); },
          }, 'Remove'))),
        !prefs.folders.length && h('li', { class: 'quiet' }, 'No folders yet.')),
      h('div', { class: 'panel-actions' },
        button('Add a folder', async () => {
          const { path } = await post('/api/pick-folder');
          if (!path) return;
          await savePrefs({ folders: [...prefs.folders, path] });
          nudge();
        }),
        button('Scan again', async () => { await post('/api/rescan'); nudge(); })));
  }

  let ownKeyOpen = false;

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
    const via = prefs.apple.useWeb && !ownKey ? " Tint is using the web player's token." : '';

    if (signedIn) {
      return h('section', { class: 'panel' },
        h('h2', {}, 'Apple Music'),
        h('p', {}, 'Signed in. Your library, playlists and the whole catalog are ready to play.' + via),
        h('label', { class: 'check explicit-check' },
          h('input', { type: 'checkbox', checked: apple.explicitAllowed(), onchange: (e) => apple.setExplicitAllowed(e.target.checked) }),
          h('span', {},
            h('span', {}, 'Play explicit songs'),
            h('span', { class: 'quiet' }, 'In some countries, Brazil included, Apple leaves explicit songs switched off until you allow them.'))),
        h('p', { class: 'quiet explicit-help' },
          "If they still won't play, Apple's own servers are refusing them for your account. Tint can't change that. Apple's own message and other people's reports point to these places:"),
        h('ol', { class: 'steps explicit-steps' },
          h('li', {}, 'At music.apple.com, in Settings under Parental Controls, turn Content Restrictions ', h('strong', {}, 'on'), ' and set Music to ', h('strong', {}, 'Explicit'), '. In some countries, leaving restrictions off still counts as blocked. ',
            h('button', { class: 'text-btn', onclick: () => post('/api/open', { url: 'https://music.apple.com/account/settings' }) }, 'Open that page')),
          h('li', {}, 'On an iPhone or iPad with the same Apple Account: Settings, Screen Time, Content & Privacy Restrictions, then allow Explicit for music.'),
          h('li', {}, 'In the Apple Music app for Windows: Settings, Restrictions, and untick music with explicit content.')),
        h('p', { class: 'quiet explicit-help' }, 'Then play the song again. If it is still refused, sign out here and sign back in.'),
        h('div', { class: 'panel-actions' },
          button('Sign out', () => apple.signOut().catch((e) => toast(e?.message || String(e)))),
          button('Remove setup', removeSetup)));
    }

    if (configured && status === 'ready') {
      return h('section', { class: 'panel' },
        h('h2', {}, 'Apple Music'),
        h('p', {}, 'Setup is done. Sign in with the Apple Account that has your subscription.' + via),
        h('div', { class: 'panel-actions' },
          button('Sign in to Apple Music', () => apple.signIn().catch((e) => toast(e?.message || 'Sign-in was cancelled.')), 'primary'),
          button('Remove setup', removeSetup)));
    }

    if (configured && status === 'loading') {
      return h('section', { class: 'panel' }, h('h2', {}, 'Apple Music'), loading('Connecting to Apple Music…'));
    }

    // The web player's token was chosen but Apple couldn't be reached or didn't accept it.
    if (prefs.apple.useWeb && !ownKey) {
      return h('section', { class: 'panel' },
        h('h2', {}, 'Apple Music'),
        h('p', { class: 'warn' }, apple.getProblem() || "Apple Music isn't connected."),
        h('div', { class: 'panel-actions' },
          button('Try again', reconnect, 'primary'),
          button('Remove setup', removeSetup)));
    }

    const team = h('input', { type: 'text', value: prefs.apple.teamId, placeholder: 'A1B2C3D4E5', maxLength: 16, spellcheck: false, autocomplete: 'off' });
    const key = h('input', { type: 'text', value: prefs.apple.keyId, placeholder: 'ABC123DEFG', maxLength: 16, spellcheck: false, autocomplete: 'off' });
    const token = h('textarea', { rows: 3, placeholder: 'eyJhbGciOiJFUzI1NiIs…', spellcheck: false });
    const problem = apple.getProblem();

    return h('section', { class: 'panel' },
      h('h2', {}, 'Apple Music'),
      problem && h('p', { class: 'warn' }, problem),
      h('p', {},
        'Apple only lets an app play subscription music if the app shows a developer token. ',
        "Tint can use the one Apple's own web player gives to every visitor, so you don't need a paid developer account."),
      h('p', {},
        'With it, Tint presents itself to Apple as music.apple.com. You still sign in with your own Apple Account, ',
        "and the music plays through Apple's own player and copy protection. Other third-party players work the same way, ",
        "but Apple's terms don't provide for it, and it can stop working whenever Apple changes their site."),
      h('div', { class: 'panel-actions' },
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

      h('details', { open: ownKeyOpen || prefs.apple.hasKey, ontoggle: (e) => { ownKeyOpen = e.target.open; } },
        h('summary', {}, 'Use my own Apple Developer key instead'),
        h('p', {}, 'Members of the Apple Developer Program can make a MusicKit key, which is the way Apple intends apps to connect.'),
        h('ol', { class: 'steps' },
          h('li', {}, 'At developer.apple.com, open Certificates, Identifiers & Profiles, then Keys. Create a key with ', h('strong', {}, 'Media Services (MusicKit)'), ' ticked and download the .p8 file.'),
          h('li', {}, 'Copy the Key ID shown next to the key, and your Team ID from the Membership page.'),
          h('li', {}, 'Enter both here and choose the .p8 file.')),
        h('p', {}, h('button', { class: 'text-btn', onclick: () => post('/api/open', { url: 'https://developer.apple.com/account/resources/authkeys/list' }) }, 'Open the Keys page at developer.apple.com')),
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
          (prefs.apple.hasKey || prefs.apple.hasToken) && button('Clear', removeSetup))));
  }

  // ---- YouTube Music ----

  let fetching = false;
  let working = null; // 'signin' | 'tokens' while one of those is under way

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

  /** Premium's better audio takes two things: asking as the account that has Premium, and a token. */
  function premiumParts(status) {
    const signIn = status.signedIn
      ? [
        h('p', {}, 'Signed in to Google. yt-dlp asks YouTube as you, using a copy of the sign-in kept in a file in Tint\'s data folder.'),
        h('div', { class: 'panel-actions' }, button('Sign out of Google', () => youtubeStep('signin', () => youtube.signOut()))),
      ]
      : [
        h('p', {}, 'Sign in with the Google account that has YouTube Premium. Tint keeps a copy of that sign-in (YouTube\'s part of it only) in a file in its data folder, and yt-dlp asks YouTube as you.'),
        h('p', { class: 'warn' }, "yt-dlp's makers warn that YouTube can restrict or close an account that is used this way."),
        // In the browser-hosted build the sign-in window is a browser Tint can't see into, so it
        // waits for the window to be closed.
        working === 'signin' && window.tintBrowserHost
          ? h('p', {}, 'Sign in in the window that opened. When YouTube Music shows there, close that window and Tint takes the sign-in from it.')
          : null,
        h('div', { class: 'panel-actions' },
          h('button', {
            class: 'btn primary', disabled: !!working,
            onclick: () => youtubeStep('signin', async () => {
              if (!await youtube.signIn()) toast("Tint didn't get a sign-in. If Google refused to sign you in in that window, Tint needs another way to get it.", { ms: 9000 });
            }),
          }, working === 'signin' ? 'Waiting for the sign-in window…' : 'Sign in to Google')),
      ];

    const helper = [
      h('p', {}, status.tokens
        ? 'The token helper is set up. It starts when a YouTube song is fetched and stops ten minutes after the last one.'
        : 'YouTube Music also wants proof that a real player is asking. yt-dlp can\'t make that proof, so its guide recommends a helper that can. It is a download of about 190 MB, runs on Deno, and uses about 170 MB of memory while YouTube songs are being fetched.'),
      !status.deno && h('p', { class: 'warn' }, "The helper runs on Deno, which isn't on this PC. Install Deno, then start Tint again."),
      h('div', { class: 'panel-actions' },
        h('button', {
          class: 'btn', disabled: !!working || !status.deno,
          onclick: () => youtubeStep('tokens', async () => { await youtube.installTokens(); toast('The token helper is set up.'); }),
        }, working === 'tokens' ? 'Downloading, this takes a minute…' : status.tokens ? 'Update the token helper' : 'Set up the token helper')),
    ];

    let verdict = 'Signed out, YouTube sends its standard audio, about 128 kbps, and now and then refuses a song altogether.';
    if (status.signedIn && status.tokens) verdict = 'Both parts are in place. A Premium account should now get about 256 kbps.';
    else if (status.signedIn) verdict = 'Signed in, but without the token helper YouTube Music keeps its Premium audio back.';
    else if (status.tokens) verdict = 'The helper is ready, but signed out YouTube sends its standard audio, about 128 kbps.';

    const players = [['page', "YouTube Music's own player"], ['ytdlp', 'yt-dlp']];
    const playWith = status.signedIn ? [
      h('h3', {}, 'How songs are played'),
      segmented('Play YouTube songs with', players, prefs.youtubePlayer === 'ytdlp' ? 'ytdlp' : 'page', (v) => savePrefs({ youtubePlayer: v })),
      h('p', { class: 'quiet player-note' }, "YouTube Music's own player is the site itself, kept open out of sight. A song starts in about a second, at the audio quality set in your YouTube Music account (Tint sets it to High). yt-dlp takes several seconds a song, and is what plays a song the site's player can't."),
    ] : [];

    return [
      ...playWith,
      h('h3', {}, 'Premium audio'),
      h('p', { class: 'quiet' }, verdict + ' While a YouTube song plays, the line under the progress bar says what is really being sent.'),
      status.signedIn && h('p', { class: 'quiet' }, 'Your YouTube Music albums, songs and playlists are on the Albums, Songs and Playlists pages, under their own source.'),
      ...signIn,
      ...helper,
    ];
  }

  function youtubeSection() {
    const status = youtube.getStatus();
    let found = "Tint couldn't check whether yt-dlp is on this PC.";
    if (status && !status.tool) found = "yt-dlp isn't installed. Sign in to Google to use YouTube Music's own player; install yt-dlp only if you want the alternative player and fallback.";
    else if (status) found = `Using yt-dlp ${status.version || '(it was found, but it would not start)'}, ${status.tool === 'own' ? "Tint's own copy" : 'the copy installed on this PC'}.`;

    return h('section', { class: 'panel' },
      h('h2', {}, 'YouTube Music'),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: prefs.youtube, onchange: (e) => savePrefs({ youtube: e.target.checked }) }),
        h('span', {},
          h('span', {}, 'Search and play from YouTube Music'),
          h('span', { class: 'quiet' }, "Search then also looks through YouTube Music's catalog. Sign in to play through YouTube Music's own player, or use the optional yt-dlp player."))),
      h('p', { class: 'quiet youtube-found' }, found),
      status?.tool && !status.runtime && h('p', { class: 'warn' }, "yt-dlp needs Deno or Node.js on this PC to read YouTube's player. Install either one, then start Tint again."),
      h('p', { class: 'quiet' }, "YouTube changes often and an old yt-dlp stops working. If its songs stop playing, get the latest one here. Tint keeps that copy in its own data folder."),
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
        }, fetching ? 'Downloading…' : status?.tool === 'own' ? 'Update yt-dlp' : 'Download the latest yt-dlp')),
      status ? premiumParts(status) : null);
  }

  // ---- Discord ----

  const discordStatus = h('p', { class: 'quiet discord-status', 'aria-live': 'polite' });

  async function drawDiscordStatus() {
    let text = '';
    if (!prefs.discord.appId) text = 'Add an application ID to switch this on.';
    else if (!prefs.discord.enabled) text = 'Switched off. Nothing is shared.';
    else {
      try {
        const s = await get('/api/discord/status');
        if (s.status === 'connected') {
          text = s.user ? `Connected to Discord as ${s.user}.` : 'Connected to Discord.';
          if (s.problem) text += ` Discord's last reply: ${s.problem}`;
        } else {
          text = s.problem || 'Connecting to Discord…';
        }
      } catch {
        text = '';
      }
    }
    discordStatus.textContent = text;
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
      // Pasting an ID is a clear sign the person wants it on.
      await savePrefs(value ? { discordAppId: value, discordEnabled: true } : { discordAppId: '', discordEnabled: false });
      id.blur();
      draw();
    };
    drawDiscordStatus();

    return h('section', { class: 'panel' },
      h('h2', {}, 'Discord'),
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', checked: prefs.discord.enabled, disabled: !prefs.discord.appId,
          onchange: async (e) => { await savePrefs({ discordEnabled: e.target.checked }); drawDiscordStatus(); },
        }),
        h('span', {},
          h('span', {}, "Show what I'm listening to on Discord"),
          h('span', { class: 'quiet' }, 'Your profile shows the song, the artist, the cover and a progress bar while music plays. It clears when you pause or close Tint.'))),
      discordStatus,
      h('p', {}, 'Discord shows a status under the name of an application, so this needs one of your own. It is free and takes about a minute.'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Open the Discord Developer Portal and choose ', h('strong', {}, 'New Application'), '. The name you give it is shown on your profile above the song, so pick something like "Music" or "Tint".'),
        h('li', {}, 'On its General Information page, copy the ', h('strong', {}, 'Application ID'), '.'),
        h('li', {}, 'Paste it here and save.')),
      h('p', {}, h('button', { class: 'text-btn', onclick: () => post('/api/open', { url: 'https://discord.com/developers/applications' }) }, 'Open the Discord Developer Portal')),
      h('div', { class: 'fields' },
        field('Application ID', h('div', { class: 'id-row' }, id, button('Save', saveId, 'primary')),
          'For songs stored on this PC, the cover is found by looking up the album name in Apple\'s public catalog.')));
  }

  /** A slider for a length of time, saved when let go. */
  function duration(label, hint, key, max, step) {
    const said = (ms) => (ms === 0 ? 'Off' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
    const value = h('span', { class: 'quiet' }, said(prefs[key]));
    const show = (input) => {
      input.style.setProperty('--fill', `${(input.value / max) * 100}%`);
      value.textContent = said(Number(input.value));
    };
    const input = h('input', {
      type: 'range', class: 'slider', min: 0, max, step, value: prefs[key], 'aria-label': label,
      oninput: (e) => show(e.target),
      onchange: (e) => savePrefs({ [key]: Number(e.target.value) }),
    });
    show(input);
    return h('div', { class: 'duration' },
      h('div', { class: 'duration-head' }, h('span', { class: 'field-label' }, label), value),
      input,
      h('span', { class: 'quiet field-hint' }, hint));
  }

  function mainSection() {
    return h('section', { class: 'panel' },
      h('h2', {}, 'Main service'),
      h('p', { class: 'quiet' }, "Where you listen most. Songs from a Spotify link are looked for there first, and on the other service when it doesn't have them."),
      segmented('Main service', [['apple', 'Apple Music'], ['youtube', 'YouTube Music'], ['pc', 'Only this PC']], prefs.mainService || 'pc',
        (v) => savePrefs({ mainService: v })));
  }

  function playbackSection() {
    return h('section', { class: 'panel' },
      h('h2', {}, 'Playback'),
      duration('Fade when playing and pausing', 'A short fade instead of the sound cutting in and out.', 'pauseFadeMs', 1000, 10),
      duration('Crossfade when skipping', 'How long a song you skip fades into the next. Two Apple Music songs, or two from the YouTube Music player, fade one after the other rather than over each other, since each of those players sounds one song at a time.', 'crossfadeMs', 5000, 100));
  }

  function lookSection() {
    return h('section', { class: 'panel' },
      h('h2', {}, 'Colors'),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: prefs.keepDark, onchange: (e) => savePrefs({ keepDark: e.target.checked }) }),
        h('span', {},
          h('span', {}, 'Keep the window dark'),
          h('span', { class: 'quiet' }, 'Normally a light cover gives you a light window. Turn this on to stay dark for every cover.'))));
  }

  // ---- what Tint keeps on this PC ----
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
    return h('section', { class: 'panel' },
      h('h2', {}, 'Saved data'),
      h('p', {},
        'Everything Tint keeps stays on this PC: saved playlists and tags, the songs played lately, and these settings. ',
        "None of it is in an account, so to move it to another PC or keep it through a reinstall, export a backup and import it there. Sign-ins aren't part of it."),
      h('div', { class: 'panel-actions' },
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
        }, h('span', { class: 'btn-icon', icon: 'download' }), exporting ? 'Exporting…' : 'Export a backup'),
        button('Import a backup', () => pickBackup(draw)),
        exported && h('button', { class: 'text-btn', title: exported, onclick: () => backup.show(exported) }, 'Show the backup')),
      h('p', { class: 'quiet cache-about' },
        'Playlists and albums you open are also kept, so they open at once next time while Tint checks for changes. ' + summary),
      h('div', { class: 'field cache-keep' },
        h('span', { class: 'field-label' }, 'Forget pages not opened or played for'),
        select('Forget pages not opened or played for', keep.map(([days, text]) => [String(days), text]), String(prefs.cacheKeepDays ?? 30),
          async (v) => { await savePrefs({ cacheKeepDays: Number(v) }); loadCacheSize(); }),
        h('span', { class: 'quiet field-hint' }, 'Playlists saved in Tint always keep their songs; only the extra copies are forgotten.')),
      h('div', { class: 'panel-actions' },
        button('Clear kept pages', async () => {
          const { gone } = await pagecache.clear();
          toast(gone ? `Cleared ${plural(gone, 'page')}` : 'There was nothing to clear');
          loadCacheSize();
        })));
  }

  let checking = false;

  function updateSection() {
    const s = update.getStatus();
    if (!s?.possible) return null;
    const text = update.describe() || (checking ? 'Looking for a newer version…' : 'This is the newest version.');
    return h('section', { class: 'panel' },
      h('h2', {}, 'Updates'),
      h('p', {}, `This is Tint ${s.current}. ${text}`),
      s.state === 'downloading' && h('div', { class: 'update-bar' }, h('span', { style: { width: `${update.percent()}%` } })),
      h('div', { class: 'panel-actions' },
        update.actions(button),
        s.state !== 'downloading' && s.state !== 'ready' && button('Check now', async () => {
          checking = true;
          draw();
          await update.check(true);
          checking = false;
          draw();
        }),
        s.latest && s.page && h('button', { class: 'text-btn', onclick: update.openNotes }, "What's new")));
  }

  function draw() {
    // Typing shouldn't be interrupted by a background refresh.
    if (el.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    fill(el, pageHead('Settings'), mainSection(), foldersSection(), appleSection(), youtubeSection(), discordSection(), playbackSection(), lookSection(), cacheSection(), updateSection(),
      h('p', { class: 'quiet about' }, `Tint${update.getStatus() ? ' ' + update.getStatus().current : ''}. Space plays and pauses, Ctrl+Right and Ctrl+Left change songs, Ctrl+F searches.`));
  }

  draw();
  loadCacheSize();
  // Opened at one section (#/settings/apple, say), as the welcome does.
  const wanted = { apple: 'Apple Music', youtube: 'YouTube Music', data: 'Saved data' }[params?.[0]];
  if (wanted) {
    requestAnimationFrame(() => [...el.querySelectorAll('.panel > h2')].find((title) => title.textContent === wanted)
      ?.parentElement.scrollIntoView({ block: 'start' }));
  }
  return {
    el,
    refresh: (why) => { if (why !== 'track') draw(); },
    destroy: () => clearInterval(discordTimer),
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
  'playlist/t': tintPlaylistView,
  welcome: welcomeView,
  'artist/y': artistView('y'),
};
