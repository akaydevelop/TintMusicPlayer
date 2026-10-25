// Every page in the browsing pane. A view is a function that returns { el, refresh?, destroy? }.
// `refresh` is called when the data behind the page changes (a scan finished, more of the Apple
// Music library arrived, a different song started).

import { h, fill, cover, fmtTime, fmtLength, plural, showMenu, toast, replay, VirtualList } from './ui.js';
import * as player from './player.js';
import * as apple from './apple.js';
import * as youtube from './youtube.js';
import * as update from './update.js';
import { local, compareText, searchLocal, nudge } from './library.js';
import { get, post } from './api.js';
import { prefs, save as savePrefs } from './prefs.js';
import { lyricsFor } from './lyrics.js';
import { hasJapanese, romanize } from './romaji.js';
import { profile as artistProfile, artistHref } from './artist.js';

const ROW = 52;

// Choices that should survive moving between pages (but not a restart).
const memory = { albumSource: 'all', albumSort: 'artist', songSource: 'all', songSort: 'artist', playlistSource: 'all' };

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
    { label: 'Share YouTube Music link', run: () => youtube.share(track) },
  ]);
}

function trackRow(tracks, i, { numbered = false, showAlbum = true, albumArtist = null } = {}) {
  const track = tracks[i];
  const isCurrent = player.current()?.id === track.id;
  const play = () => {
    if (track.playable === false) return toast(track.reason || "This song can't be played.");
    player.playList(tracks, i);
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
      h('span', { class: 'row-title' }, track.title, track.explicit && h('span', { class: 'explicit', title: 'Explicit' }, 'E')),
      // On an album page the artist is in the heading; only guests need naming on the rows.
      track.artist !== albumArtist && h('span', { class: 'row-sub' }, track.artist)),
    showAlbum && h('span', { class: 'row-album' }, track.album),
    h('span', { class: 'row-time' }, track.duration ? fmtTime(track.duration) : ''),
    h('button', {
      class: 'icon-btn small row-more', icon: 'more', 'aria-label': `More for ${track.title}`, title: 'More',
      onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); trackMenu(r.right - 180, r.bottom + 4, track); },
    }));
}

/** A track list. Long lists are windowed; short ones are plain so they can sit mid-page. */
function trackList(scroller, tracks, options = {}) {
  if (tracks.length <= 60) {
    const el = h('div', { class: 'tracks', role: 'list' });
    const draw = () => fill(el, ...tracks.map((_, i) => trackRow(tracks, i, options)));
    draw();
    return { el, refresh: draw, destroy() {} };
  }
  const list = new VirtualList({
    scroller, rowHeight: ROW, count: tracks.length, className: 'tracks',
    render: (i) => trackRow(tracks, i, options),
  });
  return { el: list.el, refresh: () => list.refresh(), destroy: () => list.destroy() };
}

async function tracksOf(item) {
  if (item.tracks) return item.tracks;
  const from = item.source === 'youtube' ? youtube : apple;
  const detail = item.href.includes('#/playlist/') ? await from.playlist(item.id) : await from.album(item.id);
  return detail.tracks;
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
  return h('a', { class: 'card', href: item.href, title: item.title },
    h('span', { class: 'card-art' },
      cover(item.art, 200),
      item.href.includes('#/artist/') ? null : h('button', { class: 'card-play', icon: 'play', 'aria-label': `Play ${item.title}`, onclick: playIt })),
    h('span', { class: 'card-title' }, item.title),
    item.artist && h('span', { class: 'card-sub' }, item.artist));
}

const grid = (items) => h('div', { class: 'grid' }, items.map(card));

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
  function release(velocity) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(velocity) < 0.05) return;
    // A short coast with exponential friction, independent of the display's refresh rate.
    velocity = Math.max(-1.5, Math.min(1.5, velocity));
    row.classList.add('is-gliding');
    let previous = performance.now();
    const step = (now) => {
      const elapsed = Math.min(40, now - previous);
      previous = now;
      const decay = Math.exp(-elapsed / 140);
      const before = row.scrollLeft;
      row.scrollLeft += velocity * 140 * (1 - decay);
      velocity *= decay;
      if (!row.isConnected || Math.abs(velocity) < 0.025 || Math.abs(row.scrollLeft - before) < 0.1) {
        stopGlide(); update(); return;
      }
      glide = requestAnimationFrame(step);
    };
    glide = requestAnimationFrame(step);
  }
  row.addEventListener('wheel', stopGlide, { passive: true });
  row.addEventListener('dragstart', (e) => e.preventDefault());
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
    suppressClick = drag.moved;
    const velocity = drag.moved && performance.now() - drag.at < 80 ? drag.velocity : 0;
    drag = null;
    row.classList.remove('is-dragging');
    if (e.type === 'pointerup') release(velocity);
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
    if (!parts.length) {
      fill(el, pageHead('Playlists'), connectPrompt('Your playlists live in Apple Music and YouTube Music'));
      return;
    }
    // With both services signed in, the list can be narrowed to one of them.
    const choices = [['all', 'All'], ...parts.map(([name]) => [name, name])];
    const source = choices.some(([id]) => id === memory.playlistSource) ? memory.playlistSource : 'all';
    const items = parts.filter(([name]) => source === 'all' || source === name).flatMap(([, part]) => part.items)
      .sort((a, b) => compareText(a.title, b.title));
    const notes = parts.map(([name, part]) => libraryNote(name, part)).filter(Boolean);
    const waiting = parts.some(([, part]) => part.state === 'idle' || part.state === 'loading');
    fill(el,
      pageHead('Playlists', [plural(items.length, 'playlist'), ...notes].join('. '),
        parts.length > 1 && segmented('Show playlists from', choices, source, (v) => { memory.playlistSource = v; draw(); })),
      items.length ? grid(items)
        : waiting ? loading()
          : emptyState('No playlists yet', 'Playlists you make in Apple Music or YouTube Music will show up here.'));
  }
  draw();
  return { el, refresh: (why) => { if (why !== 'track') draw(); } };
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

function detailHead({ art, kind, title, byline, bylineHref, facts, description, tracks }) {
  const playable = tracks.filter((t) => t.playable !== false);
  return h('header', { class: 'detail-head' },
    h('div', { class: 'detail-art' }, cover(art, 240, { lazy: false })),
    h('div', { class: 'detail-text' },
      h('p', { class: 'quiet' }, kind),
      h('h1', { class: title.length > 38 ? 'is-long' : '' }, title),
      byline && (bylineHref ? h('a', { class: 'detail-by', href: bylineHref }, byline) : h('p', { class: 'detail-by' }, byline)),
      facts && h('p', { class: 'quiet' }, facts),
      description && h('p', { class: 'detail-desc' }, description),
      h('div', { class: 'detail-actions' },
        h('button', { class: 'btn primary', disabled: !playable.length, onclick: () => player.playList(tracks, 0, { shuffle: false }) },
          h('span', { class: 'btn-icon', icon: 'play' }), 'Play'),
        h('button', { class: 'btn', disabled: playable.length < 2, onclick: () => player.playList(tracks, 0, { shuffle: true }) },
          h('span', { class: 'btn-icon', icon: 'shuffle' }), 'Shuffle'),
        h('button', {
          class: 'icon-btn', icon: 'more', 'aria-label': 'More', title: 'More', disabled: !playable.length,
          onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.left, r.bottom + 4, [
              { label: 'Play next', run: () => { player.playNext(tracks); toast(`"${title}" plays next`); } },
              { label: 'Add to queue', run: () => { player.addToQueue(tracks); toast(`Added "${title}" to the queue`); } },
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
    const mine = tracks.filter((t) => (t.discNo || 1) === disc);
    const list = {
      el: h('div', { class: 'tracks', role: 'list' }),
      refresh() { fill(this.el, mine.map((t) => trackRow(tracks, tracks.indexOf(t), options))); },
      destroy() {},
    };
    list.refresh();
    return { el: h('section', { class: 'disc' }, h('h2', {}, `Disc ${disc}`), list.el), refresh: () => list.refresh(), destroy() {} };
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
function asyncView(fetcher, build, { needsApple = true } = {}) {
  const el = h('section', { class: 'page' }, loading());
  let parts = [];
  let alive = true;

  async function run() {
    fill(el, loading());
    try {
      const data = await fetcher();
      if (!alive) return;
      const built = build(data);
      parts = built.parts || [];
      fill(el, ...built.nodes);
      replay(el, 'arrive');
    } catch (e) {
      if (alive) fill(el, !needsApple || apple.instance() ? failure(e, run) : connectPrompt('This comes from Apple Music'));
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
  });
}

function applePlaylistView({ scroller, params }) {
  return asyncView(() => apple.playlist(params[0]), (playlist) => {
    const list = trackList(scroller, playlist.tracks);
    const length = playlist.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    return {
      parts: [list],
      nodes: [
        detailHead({
          art: playlist.art || playlist.tracks[0]?.art, kind: 'Playlist', title: playlist.title, byline: playlist.artist,
          facts: [plural(playlist.tracks.length, 'song'), length ? fmtLength(length) : null].filter(Boolean).join(', '),
          description: playlist.description, tracks: playlist.tracks,
        }),
        playlist.tracks.length ? list.el : emptyState('This playlist is empty'),
      ],
    };
  });
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
  }, { needsApple: false });
}

function youtubePlaylistView({ scroller, params }) {
  youtube.warm();
  return asyncView(() => youtube.playlist(params[0]), (playlist) => {
    const list = trackList(scroller, playlist.tracks);
    const length = playlist.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    return {
      parts: [list],
      nodes: [
        detailHead({
          art: playlist.art, kind: 'Playlist on YouTube Music', title: playlist.title, byline: playlist.artist,
          facts: [plural(playlist.tracks.length, 'song'), length ? fmtLength(length) : null].filter(Boolean).join(', '),
          description: playlist.description, tracks: playlist.tracks,
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
  let query = linked ? '' : term;
  let alive = true;

  function draw() {
    parts.forEach((p) => p.destroy());
    parts = [];
    if (!term) {
      fill(el, pageHead('Search'), emptyState('Search your music', 'Type a song, an album or an artist in the box above.'));
      return;
    }

    const mine = query ? searchLocal(query) : { songs: [], albums: [] };
    const nodes = [pageHead(linked ? 'From a YouTube link' : `Results for "${term}"`)];
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

    if (mine.songs.length) nodes.push(songList('Songs on this PC', mine.songs));
    if (mine.albums.length) nodes.push(h('section', { class: 'shelf' }, h('h2', {}, 'Albums on this PC'), grid(mine.albums)));

    if (remote === 'loading') nodes.push(loading('Searching Apple Music…'));
    else if (remote instanceof Error) nodes.push(h('p', { class: 'quiet' }, `Apple Music didn't answer: ${remote.message}`));
    else if (remote) {
      if (remote.songs.length) nodes.push(songList('Songs on Apple Music', remote.songs));
      if (remote.albums.length) nodes.push(shelf('Albums on Apple Music', remote.albums));
      if (remote.artists.length) nodes.push(shelf('Artists', remote.artists));
      if (remote.playlists.length) nodes.push(shelf('Playlists', remote.playlists));
    }

    if (tube === 'loading') nodes.push(loading('Searching YouTube Music…'));
    else if (tube instanceof Error) nodes.push(h('p', { class: 'quiet' }, `YouTube Music didn't answer: ${tube.message}`));
    else if (tube) {
      if (tube.songs.length) nodes.push(songList('Songs on YouTube Music', tube.songs));
      if (tube.albums.length) nodes.push(shelf('Albums on YouTube Music', tube.albums));
      if (tube.artists.length) nodes.push(shelf('Artists on YouTube Music', tube.artists));
    }

    const count = (results, ...kinds) => (results && results !== 'loading' && !(results instanceof Error)
      ? kinds.reduce((sum, kind) => sum + results[kind].length, 0) : 0);
    const found = mine.songs.length + mine.albums.length +
      count(remote, 'songs', 'albums', 'artists', 'playlists') + count(tube, 'songs', 'albums', 'artists');
    if (!found && query && remote !== 'loading' && tube !== 'loading') {
      nodes.push(emptyState('Nothing matched', apple.instance() || tube
        ? 'Check the spelling, or try fewer words.'
        : 'Only the music on this PC was searched. Set up Apple Music or YouTube Music in Settings to search their catalogs too.'));
    }
    fill(el, ...nodes);
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
  lookUp();
  draw();
  return {
    el,
    refresh: (why) => { if (why === 'track') parts.forEach((p) => p.refresh()); else if (why === 'local') draw(); },
    destroy: () => { alive = false; parts.forEach((p) => p.destroy()); },
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

function lyricsView({ scroller }) {
  const el = h('section', { class: 'page lyrics-page' });
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  let track = null;
  let result = null; // 'loading', an Error, null (none found), or what lyricsFor() found
  let rows = [];
  let lit = -1;
  let heldUntil = 0;
  let alive = true;
  // The player reports its position a few times a second; between reports it is worked out.
  let clock = { time: player.state.time, at: performance.now() };

  const now = () => clock.time + (player.state.playing ? (performance.now() - clock.at) / 1000 : 0);

  function load() {
    track = player.current();
    result = track ? 'loading' : null;
    draw();
    if (!track) return;
    const mine = track;
    lyricsFor(track).then((r) => { result = r; }, (e) => { result = e instanceof Error ? e : new Error(String(e)); })
      .then(() => { if (alive && player.current() === mine) draw(); });
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
    if (!result) return fill(el, pageHead('Lyrics', summary), emptyState('No lyrics for this song', "Apple Music, YouTube Music and LRCLIB don't have lyrics for it."));

    const texts = result.lines ? result.lines.map((line) => line.text) : result.text.split('\n');
    const shown = shownTexts(texts);
    // Japanese lyrics can be shown in romaji instead.
    const head = hasJapanese(texts.join('\n'))
      ? pageHead('Lyrics', summary, segmented('Show the lyrics', [['original', 'Original'], ['romaji', 'Romaji']], romajiWanted() ? 'romaji' : 'original', (id) => {
        localStorage.setItem(ROMAJI_KEY, id === 'romaji' ? 'on' : 'off');
        draw();
      }))
      : pageHead('Lyrics', summary);
    const working = shown === texts && romajiWanted() && result.romajiPending
      ? h('p', { class: 'quiet lyrics-working' }, 'Working out the romaji… The first time, this downloads a Japanese dictionary (17 MB).')
      : null;

    if (!result.lines) {
      return fill(el, head, working,
        h('div', { class: 'lyrics is-plain' }, shown.map((line) => h('p', {}, line || '\u00a0'))),
        h('p', { class: 'quiet lyrics-source' }, `These lyrics aren't timed to the song. From ${result.source}.`));
    }
    rows = result.lines.map((line, i) => h('button', {
      class: 'lyric' + (line.text ? '' : ' is-gap'),
      onclick: () => { heldUntil = 0; player.seek(line.time); if (!player.state.playing) player.toggle(); },
    }, shown[i] || '♪'));
    fill(el, head, working, h('div', { class: 'lyrics' }, rows), h('p', { class: 'quiet lyrics-source' }, `Lyrics from ${result.source}`));
    follow(true);
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
    if (performance.now() < heldUntil) return;
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
    },
  };
}

// ---- Settings -----------------------------------------------------------------------------------

function settingsView() {
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
    fill(el, pageHead('Settings'), foldersSection(), appleSection(), youtubeSection(), discordSection(), playbackSection(), lookSection(), updateSection(),
      h('p', { class: 'quiet about' }, `Tint${update.getStatus() ? ' ' + update.getStatus().current : ''}. Space plays and pauses, Ctrl+Right and Ctrl+Left change songs, Ctrl+F searches.`));
  }

  draw();
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
  home: homeView,
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
};
