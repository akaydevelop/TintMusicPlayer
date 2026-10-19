// Apple Music, through Apple's own MusicKit library. MusicKit handles sign-in, streaming and
// the DRM; this module loads it on demand and turns its responses into the app's plain objects.

import { get } from './api.js';
import { bestMatch } from './match.js';

const MUSICKIT_URL = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';

let music = null;
let status = 'off'; // off | loading | ready | error
let problem = null;
let tokenSource = null; // pasted | key | web
const wired = new WeakSet();
const listeners = new Set();

export const instance = () => music;
export const getStatus = () => status;
export const getProblem = () => problem;
export const isSignedIn = () => !!music?.isAuthorized;
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const changed = () => listeners.forEach((fn) => fn());

function loadMusicKit() {
  if (window.MusicKit) return Promise.resolve();
  // An earlier build switched MusicKit to its experimental HLS song route to get around refused
  // explicit songs. It didn't help (Apple's licence server makes the same refusal) and it started
  // playback less reliably, so make sure the switch is gone before the script reads it.
  try { localStorage.removeItem('mk-hlsjs-song-playback'); } catch { /* storage unavailable */ }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Apple's player didn't load. Check your internet connection.")), 20000);
    document.addEventListener('musickitloaded', () => { clearTimeout(timer); resolve(); }, { once: true });
    const script = document.createElement('script');
    script.src = MUSICKIT_URL;
    script.async = true;
    script.onerror = () => { clearTimeout(timer); reject(new Error("Apple's player didn't load. Check your internet connection.")); };
    document.head.append(script);
  });
}

async function configure(token) {
  music = await window.MusicKit.configure({
    developerToken: token,
    app: { name: 'Tint', build: '0.1.0' },
  });
  try { music.bitrate = window.MusicKit.PlaybackBitrate.HIGH; } catch { /* older builds */ }
  if (!wired.has(music)) {
    wired.add(music);
    music.addEventListener('authorizationStatusDidChange', () => { clearLibrary(); changed(); });
  }
}

/** Sets MusicKit up if a developer token is available. Safe to call again after settings change. */
export async function init() {
  if (status === 'loading') return;
  status = 'loading';
  problem = null;
  changed();
  try {
    let { token, error, source } = await get('/api/apple-token');
    if (!token) {
      status = 'off';
      problem = error || null;
      return;
    }
    tokenSource = source;
    await loadMusicKit();
    await configure(token);
    // One cheap request proves Apple accepts the token, so a bad one shows up here and not at sign-in.
    try {
      await call('/v1/storefronts/us');
    } catch (e) {
      if (source !== 'web') throw e;
      // Apple rotates the web player's token now and then. Read the current one and try once more.
      ({ token, error } = await get('/api/apple-token?fresh=1'));
      if (!token) throw new Error(error || e.message);
      await configure(token);
      await call('/v1/storefronts/us');
    }
    status = 'ready';
  } catch (e) {
    music = null;
    status = 'error';
    problem = e?.message || String(e);
  } finally {
    changed();
  }
}

export async function signIn() {
  if (!music) throw new Error('Apple Music is not set up yet.');
  await music.authorize();
  clearLibrary();
  changed();
}

export async function signOut() {
  if (!music) return;
  await music.unauthorize();
  clearLibrary();
  changed();
}

// ---- explicit songs -----------------------------------------------------------------------------

// Apple's player keeps explicit songs switched off by default for accounts in some countries
// (Brazil among them) and remembers the choice per sign-in. Apple's servers hold a second,
// account-wide restriction that only Apple's own settings can lift.

export const explicitAllowed = () => !!music && music.restrictedEnabled !== true;

export function setExplicitAllowed(on) {
  if (!music) return;
  music.restrictedEnabled = !on;
  changed();
}

// ---- requests -----------------------------------------------------------------------------------

/** MusicKit reports failures as bare status codes. Say what they mean and what to do. */
function explain(e) {
  const text = String(e?.message || e?.errorCode || e);
  const code = Number(e?.status || e?.response?.status || (/^\d{3}$/.test(text) ? text : 0));
  if (code === 401) {
    return new Error(tokenSource === 'web'
      ? "Apple didn't accept the web player's token. Their site may have changed; try again later."
      : "Apple didn't accept the developer token. Check the Team ID, the Key ID and the key in Settings.");
  }
  if (code === 403) return new Error(isSignedIn() ? "Apple Music refused that. Your sign-in may have expired: sign out and in again in Settings." : 'Sign in to Apple Music first.');
  if (code === 404) return new Error("Apple Music doesn't have that any more.");
  if (code === 429) return new Error('Apple Music is asking us to slow down. Try again in a moment.');
  if (code >= 500) return new Error('Apple Music is having trouble right now. Try again in a moment.');
  if (/failed to fetch|network/i.test(text)) return new Error("Can't reach Apple Music. Check your internet connection.");
  return e instanceof Error ? e : new Error(text);
}

async function call(path, params) {
  if (!music) throw new Error('Apple Music is not set up yet.');
  try {
    const res = await music.api.music(path, params);
    return res.data;
  } catch (e) {
    throw explain(e);
  }
}

const englishTitles = new Map();
/** Read the official English catalog name for the same recording, without delaying playback. */
export async function englishTitle(track) {
  if (!/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(track?.title || '')) return null;
  if (track.englishTitle) return track.englishTitle;
  if (track.source !== 'apple' || !/^\d+$/.test(track.appleId || '') || !music) return null;
  const id = track.appleId;
  if (!englishTitles.has(id)) {
    if (englishTitles.size >= 200) englishTitles.delete(englishTitles.keys().next().value);
    const pending = call(`/v1/catalog/us/songs/${id}`, { l: 'en-US' }).then((res) => {
      const name = res.data?.[0]?.attributes?.name?.trim();
      return name && name !== track.title.trim() && /[A-Za-z]/.test(name) &&
        !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(name) ? name : null;
    }).catch(() => { englishTitles.delete(id); return null; });
    englishTitles.set(id, pending);
  }
  return englishTitles.get(id);
}

/** Walks a paged collection, handing each page to `onPage` as it arrives. */
async function eachPage(path, params, onPage, { max = 20000 } = {}) {
  let offset = 0;
  while (offset < max) {
    const page = await call(path, { ...params, limit: 100, offset });
    const items = page.data || [];
    if (items.length) onPage(items);
    if (!page.next || !items.length) break;
    offset += items.length;
  }
}

// ---- normalising --------------------------------------------------------------------------------

function artOf(artwork) {
  if (!artwork?.url) return null;
  return { url: artwork.url, bg: artwork.bgColor, fg: artwork.textColor1 };
}

function toSong(r) {
  const a = r.attributes || {};
  const play = a.playParams;
  return {
    id: 'a:' + r.id,
    source: 'apple',
    // Catalogue ids stream most reliably; library-only uploads fall back to their library id.
    appleId: play?.catalogId || play?.id || r.id,
    title: a.name || 'Untitled',
    artist: a.artistName || '',
    album: a.albumName || '',
    duration: (a.durationInMillis || 0) / 1000,
    trackNo: a.trackNumber || 0,
    discNo: a.discNumber || 1,
    art: artOf(a.artwork),
    explicit: a.contentRating === 'explicit',
    playable: !!play,
    reason: play ? null : "This song isn't available to stream.",
  };
}

function toAlbum(r) {
  const a = r.attributes || {};
  return {
    id: r.id,
    source: 'apple',
    title: a.name || 'Untitled',
    artist: a.artistName || '',
    year: (a.releaseDate || '').slice(0, 4),
    added: a.dateAdded ? Date.parse(a.dateAdded) / 1000 : 0,
    count: a.trackCount || 0,
    art: artOf(a.artwork),
    href: `#/album/a/${encodeURIComponent(r.id)}`,
  };
}

function toPlaylist(r) {
  const a = r.attributes || {};
  return {
    id: r.id,
    source: 'apple',
    title: a.name || 'Untitled',
    artist: a.curatorName || (r.type === 'library-playlists' ? 'Your playlist' : ''),
    description: a.description?.short || a.description?.standard || '',
    art: artOf(a.artwork),
    href: `#/playlist/a/${encodeURIComponent(r.id)}`,
  };
}

function toArtist(r) {
  const a = r.attributes || {};
  return {
    id: r.id,
    title: a.name || '',
    art: artOf(a.artwork),
    href: `#/artist/a/${encodeURIComponent(r.id)}`,
  };
}

const isSong = (r) => r.type === 'songs' || r.type === 'library-songs';

function toCard(r) {
  if (r.type === 'albums' || r.type === 'library-albums') return toAlbum(r);
  if (r.type === 'playlists' || r.type === 'library-playlists') return toPlaylist(r);
  return null;
}

// ---- the signed-in library ----------------------------------------------------------------------

const lib = {
  albums: { items: [], state: 'idle' },
  songs: { items: [], state: 'idle' },
  playlists: { items: [], state: 'idle' },
};

function clearLibrary() {
  for (const part of Object.values(lib)) {
    part.items = [];
    part.state = 'idle';
    part.error = null;
  }
}

function loadPart(name, path, map) {
  const part = lib[name];
  if (part.state !== 'idle' || !isSignedIn()) return part;
  part.state = 'loading';
  eachPage(path, {}, (items) => {
    part.items = part.items.concat(items.map(map).filter(Boolean));
    changed();
  }).then(
    () => { part.state = 'done'; changed(); },
    (e) => { part.state = 'error'; part.error = e?.message || String(e); changed(); },
  );
  return part;
}

/** Each returns { items, state } straight away and fills in as pages arrive (see onChange). */
export const libraryAlbums = () => loadPart('albums', '/v1/me/library/albums', toAlbum);
export const librarySongs = () => loadPart('songs', '/v1/me/library/songs', (r) => (isSong(r) ? toSong(r) : null));
export const libraryPlaylists = () => loadPart('playlists', '/v1/me/library/playlists', toPlaylist);

// ---- detail pages -------------------------------------------------------------------------------

export async function album(id) {
  const inLibrary = id.startsWith('l.');
  const base = inLibrary ? `/v1/me/library/albums/${id}` : `/v1/catalog/{{storefrontId}}/albums/${id}`;
  const res = await call(base, { include: 'tracks,artists' });
  const r = res.data[0];
  const info = toAlbum(r);
  let rows = r.relationships?.tracks?.data || [];
  if (r.relationships?.tracks?.next) {
    rows = [];
    await eachPage(`${base}/tracks`, {}, (items) => { rows = rows.concat(items); });
  }
  const tracks = rows.filter(isSong).map((row) => {
    const song = toSong(row);
    if (!song.art) song.art = info.art;
    if (!song.album) song.album = info.title;
    return song;
  });
  const artistId = !inLibrary ? r.relationships?.artists?.data?.[0]?.id : null;
  return { ...info, tracks, artistHref: artistId ? `#/artist/a/${encodeURIComponent(artistId)}` : null };
}

export async function playlist(id) {
  const inLibrary = id.startsWith('p.');
  const base = inLibrary ? `/v1/me/library/playlists/${id}` : `/v1/catalog/{{storefrontId}}/playlists/${id}`;
  const res = await call(base, inLibrary ? {} : { include: 'tracks' });
  const r = res.data[0];
  const info = toPlaylist(r);
  let rows = r.relationships?.tracks?.data || [];
  if (inLibrary || r.relationships?.tracks?.next) {
    rows = [];
    await eachPage(`${base}/tracks`, {}, (items) => { rows = rows.concat(items); });
  }
  return { ...info, tracks: rows.filter(isSong).map(toSong) };
}

export async function artist(id) {
  const res = await call(`/v1/catalog/{{storefrontId}}/artists/${id}`, { views: 'top-songs,full-albums,singles' });
  const r = res.data[0];
  const views = r.views || {};
  return {
    ...toArtist(r),
    songs: (views['top-songs']?.data || []).filter(isSong).map(toSong),
    albums: (views['full-albums']?.data || []).map(toAlbum),
    singles: (views.singles?.data || []).map(toAlbum),
  };
}

export async function search(term) {
  const res = await call('/v1/catalog/{{storefrontId}}/search', { term, types: 'songs,albums,playlists,artists', limit: 20 });
  const r = res.results || {};
  return {
    songs: (r.songs?.data || []).map(toSong),
    albums: (r.albums?.data || []).map(toAlbum),
    playlists: (r.playlists?.data || []).map(toPlaylist),
    artists: (r.artists?.data || []).map(toArtist),
  };
}

/** The same recording as `song` (a song from somewhere else) in Apple Music's catalog, or null. */
export async function findSong(song) {
  const res = await call('/v1/catalog/{{storefrontId}}/search', { term: `${song.title} ${song.artist}`.trim(), types: 'songs', limit: 15 });
  return bestMatch(song, (res.results?.songs?.data || []).map(toSong).filter((found) => found.playable));
}

/** Shelves for the Listen now page: what was played lately, then Apple's picks for this person. */
export async function home() {
  const shelves = [];
  const [recent, picks] = await Promise.allSettled([
    call('/v1/me/recent/played', { limit: 10 }),
    call('/v1/me/recommendations', {}),
  ]);
  if (recent.status === 'fulfilled') {
    const items = (recent.value.data || []).map(toCard).filter(Boolean);
    if (items.length) shelves.push({ title: 'Recently played', items });
  }
  if (picks.status === 'fulfilled') {
    for (const shelf of picks.value.data || []) {
      const items = (shelf.relationships?.contents?.data || []).map(toCard).filter(Boolean);
      const title = shelf.attributes?.title?.stringForDisplay;
      if (items.length && title) shelves.push({ title, items });
    }
  }
  if (!shelves.length && recent.status === 'rejected' && picks.status === 'rejected') throw recent.reason;
  return shelves;
}
