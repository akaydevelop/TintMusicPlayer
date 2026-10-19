// YouTube Music. The catalog (search, albums, artists, playlists) comes from the service behind
// music.youtube.com, asked through the host. Its answers are pages described for YouTube's own
// site, nested many layers deep, so this module looks for the few pieces it knows by name wherever
// they sit and turns them into the app's plain objects. The audio itself is fetched by yt-dlp.

import { get, post } from './api.js';
import { prefs } from './prefs.js';
import { bestMatch } from './match.js';

let status = null; // what the host found: { tool, version, runtime, deno, signedIn, tokens }
const listeners = new Set();

export const getStatus = () => status;
/** Browser playback needs a Google sign-in; yt-dlp remains an optional playback route. */
export const isReady = () => !!prefs.youtube && (!!status?.tool || (prefs.youtubePlayer !== 'ytdlp' && !!status?.signedIn && !!window.chrome?.webview));
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

const changed = () => listeners.forEach((fn) => fn());

export async function init() {
  const was = !!status?.signedIn;
  try {
    status = await get('/api/youtube/status');
  } catch {
    status = null;
  }
  // A different sign-in, or none, means a different library.
  if (was !== !!status?.signedIn) clearLibrary();
  changed();
}

/** The person's own YouTube Music library can be read once YouTube Music is on and they are signed in to Google. */
export const isSignedIn = () => isReady() && !!status?.signedIn;

/** Has the host download the current yt-dlp into Tint's own folder. */
export async function install() {
  const res = await post('/api/youtube/install');
  await init();
  if (!res.ok) throw new Error(res.error || "yt-dlp couldn't be downloaded.");
}

/** Opens Google's sign-in window. Resolves to whether a sign-in came out of it. */
export async function signIn() {
  const res = await post('/api/youtube/signin');
  await init();
  return !!res.ok;
}

export async function signOut() {
  await post('/api/youtube/signout');
  await init();
}

/** Has the host download the helper that makes the tokens YouTube Music asks a player for. */
export async function installTokens() {
  const res = await post('/api/youtube/tokens');
  await init();
  if (!res.ok) throw new Error(res.error || "The token helper couldn't be set up.");
}

// ---- the site's own player ----------------------------------------------------------------------

let page = null;

/**
 * Has the host open music.youtube.com out of sight, so its player can play songs for Tint.
 * Resolves to whether it came up. Asking again while it is open costs nothing.
 */
export function openPage({ again = false } = {}) {
  if (again) page = null; // loads the site afresh, which is when it picks up a changed setting
  page ??= post('/api/youtube/page', { again }).then((res) => !!res.ok, () => false).then((open) => {
    if (!open) page = null;
    return open;
  });
  return page;
}

/** The page stopped answering; the next song should have it opened again. */
export function forgetPage() {
  page = null;
}

/** Opens the page ahead of the first song, when a page of YouTube music is being looked at. */
export function warm() {
  if (isSignedIn() && prefs.youtubePlayer !== 'ytdlp') openPage();
}

/** Where a song's audio is right now: { url, codec, kbps }. The address stops working after a few hours. */
export async function stream(id, { fresh = false } = {}) {
  const res = await get(`/api/youtube/stream?id=${encodeURIComponent(id)}${fresh ? '&fresh=1' : ''}`);
  // `refused` marks YouTube turning the whole connection away, not just this one song.
  if (res.error) throw Object.assign(new Error(res.error), { refused: !!res.refused });
  return res;
}

const call = (endpoint, body, next) => post('/api/youtube/call', { endpoint, body, next });

// ---- reading YouTube's answers ------------------------------------------------------------------

/** Every value stored under `key`, at any depth. */
function findAll(node, key, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, key, out);
  } else if (node && typeof node === 'object') {
    for (const [name, value] of Object.entries(node)) {
      if (name === key) out.push(value);
      findAll(value, key, out);
    }
  }
  return out;
}

const textOf = (node) => (node?.runs || []).map((run) => run.text).join('');
const pageOf = (endpoint) => endpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || '';
const isArtistPage = (page) => page === 'MUSIC_PAGE_TYPE_ARTIST' || page === 'MUSIC_PAGE_TYPE_USER_CHANNEL';

function artOf(node) {
  const best = findAll(node, 'thumbnails')[0]?.at(-1)?.url;
  if (!best) return null;
  // Google's image addresses end in the size wanted, so any size can be asked for.
  return { url: best.replace(/=w\d+-h\d+/, '=w{w}-h{h}') };
}

function seconds(text) {
  if (!/^\d+(:\d\d){1,2}$/.test(text || '')) return 0;
  return text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

// A row's second line mixes names with facts such as "Song", "7.1M plays" or "2023".
const NOT_A_NAME = /^(song|video|album|single|ep|playlist|auto playlist|artist|episode|podcast|\d{4}|[\d.,]+[kmb]? (plays|views|songs?|tracks?|subscribers|monthly audience))$/i;

/** A row in a list of songs. `known` fills in what an album page doesn't repeat on every row. */
function toSong(row, known = {}) {
  const columns = [...(row.flexColumns || []), ...(row.fixedColumns || [])].map((column) => Object.values(column)[0]?.text);
  const runs = columns.flatMap((text) => text?.runs || []);
  const videoId = row.playlistItemData?.videoId || runs.find((run) => run.navigationEndpoint?.watchEndpoint)?.navigationEndpoint.watchEndpoint.videoId;
  if (!videoId) return null;

  const others = runs.slice((columns[0]?.runs || []).length);
  let artists = others.filter((run) => isArtistPage(pageOf(run.navigationEndpoint))).map((run) => run.text);
  const albumRun = others.find((run) => pageOf(run.navigationEndpoint) === 'MUSIC_PAGE_TYPE_ALBUM');
  if (!artists.length && !known.artist) {
    // Artists without a page of their own are plain text: the first thing on the line that isn't a fact.
    const name = others.map((run) => run.text.trim()).find((text) => text && text !== '•' && !NOT_A_NAME.test(text) && !seconds(text));
    if (name) artists = [name];
  }
  const badges = findAll(row.badges, 'iconType');

  return {
    id: 'y:' + videoId,
    source: 'youtube',
    youtubeId: videoId,
    title: textOf(columns[0]) || 'Untitled',
    artist: artists.join(', ') || known.artist || '',
    album: albumRun?.text || known.album || '',
    albumHref: albumRun ? `#/album/y/${encodeURIComponent(albumRun.navigationEndpoint.browseEndpoint.browseId)}` : known.albumHref || null,
    duration: runs.map((run) => seconds(run.text)).find(Boolean) || 0,
    trackNo: known.trackNo || 0,
    discNo: 1,
    art: artOf(row.thumbnail) || known.art || null,
    explicit: badges.includes('MUSIC_EXPLICIT_BADGE'),
    playable: true,
  };
}

/** An album, artist or playlist, from either of the two shapes YouTube lists them in. */
function toCard(item) {
  const endpoint = item.navigationEndpoint;
  const id = endpoint?.browseEndpoint?.browseId;
  const page = pageOf(endpoint);
  if (!id) return null;

  // Search rows put everything in columns; shelves use a title and a subtitle.
  const columns = (item.flexColumns || []).map((column) => Object.values(column)[0]?.text);
  const title = item.title ? textOf(item.title) : textOf(columns[0]);
  const facts = (item.subtitle?.runs || columns.slice(1).flatMap((text) => text?.runs || [])).map((run) => run.text.trim()).filter((text) => text && text !== '•');
  const art = artOf(item.thumbnailRenderer || item.thumbnail);
  const names = facts.filter((text) => !NOT_A_NAME.test(text));

  if (page === 'MUSIC_PAGE_TYPE_ALBUM') {
    return {
      id, source: 'youtube', title, art, artist: names.join(', '),
      year: facts.find((text) => /^\d{4}$/.test(text)) || '',
      href: `#/album/y/${encodeURIComponent(id)}`,
    };
  }
  if (isArtistPage(page)) return { id, source: 'youtube', title, art, href: `#/artist/y/${encodeURIComponent(id)}` };
  if (page === 'MUSIC_PAGE_TYPE_PLAYLIST') return { id, source: 'youtube', title, art, artist: names.join(', '), href: `#/playlist/y/${encodeURIComponent(id)}` };
  return null;
}

const rowsOf = (answer) => findAll(answer, 'musicResponsiveListItemRenderer');

/** The heading of an album, playlist or artist page, whichever of YouTube's layouts it came in. */
function headOf(answer) {
  for (const key of ['musicResponsiveHeaderRenderer', 'musicImmersiveHeaderRenderer', 'musicDetailHeaderRenderer', 'musicVisualHeaderRenderer']) {
    const head = findAll(answer, key)[0];
    if (head) return head;
  }
  return null;
}

// ---- long lists ---------------------------------------------------------------------------------

// YouTube sends a long list a page at a time. These are its names for a list, and for "more of one".
const SONG_LISTS = ['musicPlaylistShelfRenderer', 'musicShelfRenderer', 'musicPlaylistShelfContinuation', 'musicShelfContinuation'];
const CARD_LISTS = ['gridRenderer', 'gridContinuation', 'musicShelfRenderer', 'musicShelfContinuation'];

function listIn(answer, kinds) {
  for (const kind of kinds) {
    const list = findAll(answer, kind)[0];
    if (list) return list;
  }
  // The newer answer to "more, please" is a bare run of items.
  const appended = findAll(answer, 'continuationItems')[0];
  return appended ? { contents: appended } : null;
}

/** How to ask for the rest of a list, in whichever of YouTube's two styles it was offered. */
function moreOf(list) {
  const older = list.continuations?.[0]?.nextContinuationData?.continuation;
  if (older) return { next: older };
  const token = findAll(findAll(list.contents || list.items, 'continuationItemRenderer'), 'token')[0];
  return token ? { body: { continuation: token } } : null;
}

/** Hands `onPage` the list in an answer, then each further page of it. Returns whether a list was found. */
async function eachPage(answer, kinds, onPage, { max = 80 } = {}) {
  let found = false;
  for (let pages = 0; pages < max; pages++) {
    const list = listIn(answer, kinds);
    if (!list) break;
    found = true;
    onPage(list);
    const more = moreOf(list);
    if (!more) break;
    answer = await call('browse', more.body || {}, more.next);
  }
  return found;
}

// ---- the signed-in library ----------------------------------------------------------------------

const lib = {
  albums: { items: [], state: 'idle' },
  songs: { items: [], state: 'idle' },
  playlists: { items: [], state: 'idle' },
};
let libraryOf = 0; // goes up when the sign-in changes, so pages of the old library are dropped

function clearLibrary() {
  libraryOf++;
  for (const part of Object.values(lib)) {
    part.items = [];
    part.state = 'idle';
    part.error = null;
  }
}

function loadPart(name, browseId, kinds, read) {
  const part = lib[name];
  if (part.state !== 'idle' || !isSignedIn()) return part;
  part.state = 'loading';
  const mine = libraryOf;
  call('browse', { browseId })
    .then((answer) => eachPage(answer, kinds, (list) => {
      if (mine !== libraryOf) return;
      part.items = part.items.concat(read(list));
      changed();
    }))
    .then(
      () => { if (mine === libraryOf) { part.state = 'done'; changed(); } },
      (e) => { if (mine === libraryOf) { part.state = 'error'; part.error = e?.message || String(e); changed(); } },
    );
  return part;
}

const cardsIn = (list, kind) => [...findAll(list, 'musicTwoRowItemRenderer'), ...rowsOf(list)]
  .map(toCard).filter((item) => item?.href.includes(kind));

/** Each returns { items, state } straight away and fills in as pages arrive (see onChange). */
export const libraryAlbums = () => loadPart('albums', 'FEmusic_liked_albums', CARD_LISTS, (list) => cardsIn(list, '#/album/'));
export const librarySongs = () => loadPart('songs', 'FEmusic_liked_videos', SONG_LISTS, (list) => rowsOf(list).map((row) => toSong(row)).filter(Boolean));
export const libraryPlaylists = () => loadPart('playlists', 'FEmusic_liked_playlists', CARD_LISTS, (list) => cardsIn(list, '#/playlist/')
  // "Episodes for Later" is YouTube's queue of podcast episodes, which isn't music.
  .filter((item) => item.id !== 'VLSE')
  // The owner of your own playlists is you, so say where the playlist lives instead.
  .map((item) => ({ ...item, artist: 'YouTube Music' })));

// ---- search -------------------------------------------------------------------------------------

// YouTube's own names for "only songs", "only albums" and "only artists".
const ONLY = {
  songs: 'EgWKAQIIAWoMEA4QChADEAQQCRAF',
  albums: 'EgWKAQIYAWoMEA4QChADEAQQCRAF',
  artists: 'EgWKAQIgAWoMEA4QChADEAQQCRAF',
};

export async function search(term) {
  const [songs, albums, artists] = await Promise.allSettled(
    Object.values(ONLY).map((params) => call('search', { query: term, params })));
  if (songs.status === 'rejected' && albums.status === 'rejected' && artists.status === 'rejected') throw songs.reason;
  const cards = (result) => (result.status === 'fulfilled' ? rowsOf(result.value).map(toCard).filter(Boolean) : []);
  return {
    songs: songs.status === 'fulfilled' ? rowsOf(songs.value).map((row) => toSong(row)).filter(Boolean) : [],
    albums: cards(albums),
    artists: cards(artists),
  };
}

/** The same recording as `song` (a song from somewhere else) on YouTube Music, or null. */
export async function findSong(song) {
  const answer = await call('search', { query: `${song.title} ${song.artist}`.trim(), params: ONLY.songs });
  return bestMatch(song, rowsOf(answer).map((row) => toSong(row)).filter(Boolean));
}

// ---- detail pages -------------------------------------------------------------------------------

export async function album(id) {
  const answer = await call('browse', { browseId: id });
  const head = headOf(answer);
  if (!head) throw new Error("YouTube Music doesn't have that album any more.");

  const title = textOf(head.title) || 'Untitled';
  const by = head.straplineTextOne?.runs?.find((run) => isArtistPage(pageOf(run.navigationEndpoint)));
  const artist = textOf(head.straplineTextOne);
  const art = artOf(head.thumbnail);
  const href = `#/album/y/${encodeURIComponent(id)}`;
  const tracks = rowsOf(answer)
    .map((row, i) => toSong(row, { artist, album: title, art, albumHref: href, trackNo: i + 1 }))
    .filter(Boolean)
    // On its own album a song shows the album's cover, like the rest of the page.
    .map((song) => ({ ...song, album: title, albumHref: href, art: art || song.art }));

  return {
    id, source: 'youtube', title, artist, art, href, tracks,
    year: (head.subtitle?.runs || []).map((run) => run.text).find((text) => /^\d{4}$/.test(text)) || '',
    artistHref: by ? `#/artist/y/${encodeURIComponent(by.navigationEndpoint.browseEndpoint.browseId)}` : null,
  };
}

export async function playlist(id) {
  const answer = await call('browse', { browseId: id.startsWith('VL') ? id : 'VL' + id });
  const head = headOf(answer);
  let rows = [];
  // A long playlist arrives a page at a time.
  if (!await eachPage(answer, SONG_LISTS, (list) => { rows = rows.concat(rowsOf(list)); })) rows = rowsOf(answer);
  const tracks = rows.map((row) => toSong(row)).filter(Boolean);
  if (!head && !tracks.length) throw new Error("YouTube Music doesn't have that playlist any more.");
  return {
    id, source: 'youtube', tracks,
    title: textOf(head?.title) || 'Playlist',
    artist: textOf(head?.straplineTextOne) || '',
    description: textOf(findAll(head?.description, 'description')[0] || head?.description) || '',
    art: artOf(head?.thumbnail) || tracks[0]?.art || null,
    href: `#/playlist/y/${encodeURIComponent(id)}`,
  };
}

export async function artist(id) {
  const answer = await call('browse', { browseId: id });
  const head = headOf(answer);
  if (!head) throw new Error("YouTube Music doesn't have that artist any more.");
  const name = textOf(head.title);

  // The page is a column of shelves: the top songs as rows, then albums, singles and so on as cards.
  const songs = rowsOf(findAll(answer, 'musicShelfRenderer')[0]).map((row) => toSong(row, { artist: name })).filter(Boolean);
  const shelves = findAll(answer, 'musicCarouselShelfRenderer').map((shelf) => ({
    title: textOf(findAll(shelf.header, 'title')[0]),
    items: findAll(shelf.contents, 'musicTwoRowItemRenderer').map(toCard).filter(Boolean),
  })).filter((shelf) => shelf.title && shelf.items.length);

  return { id, title: name, art: artOf(head.thumbnail), songs, shelves };
}
