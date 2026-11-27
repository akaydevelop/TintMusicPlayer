// Spotify: native Premium playback via the official Web Playback SDK + Web API (OAuth 2.0 PKCE),
// plus public link lookup so pasted Spotify links work both signed in (native) and signed out (matched).

import { get, post } from './api.js';
import * as apple from './apple.js';
import * as youtube from './youtube.js';
import { prefs } from './prefs.js';
import { bestMatch, sameName } from './match.js';

const API = 'https://api.spotify.com/v1';
const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';

let status = null; // { configured, signedIn, enabled, clientId, redirectUri, user, premium, error }
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const changed = () => listeners.forEach((fn) => fn());

export const getStatus = () => status;
export const isSignedIn = () => !!status?.signedIn && !!prefs.spotify?.enabled;
export const isReady = () => isSignedIn();
export const songLink = (track) => (track?.spotifyId ? `https://open.spotify.com/track/${encodeURIComponent(track.spotifyId)}` : null);

export async function init() {
  const was = !!status?.signedIn;
  try {
    status = await get('/api/spotify/status');
  } catch {
    status = null;
  }
  if (was !== !!status?.signedIn) {
    clearLibrary();
    disconnectPlayer();
  }
  changed();
}

export async function signIn() {
  const res = await post('/api/spotify/signin');
  await init();
  if (!res.ok) throw new Error(res.error || 'Spotify sign-in was cancelled.');
  return true;
}

export async function signOut() {
  disconnectPlayer();
  await post('/api/spotify/signout');
  clearLibrary();
  await init();
}

export async function getToken(fresh = false) {
  const res = await get(`/api/spotify/token${fresh ? '?fresh=1' : ''}`);
  if (!res.token) throw new Error(res.error || 'Not signed in to Spotify.');
  return res.token;
}

async function api(path, { method = 'GET', body = null, retry = true } = {}) {
  const token = await getToken(false);
  const url = path.startsWith('http') ? path : API + path;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry) {
    await getToken(true);
    return api(path, { method, body, retry: false });
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const msg = json?.error?.message || `Spotify answered ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ---- Web Playback SDK ---------------------------------------------------------------------------

let sdkPromise = null;
let sdkPlayer = null;
let deviceId = null;
let connectPromise = null;
let lastVolume = 0.8;
const playbackListeners = new Set();
export const onPlayback = (fn) => { playbackListeners.add(fn); return () => playbackListeners.delete(fn); };
const emitPlayback = (ev) => playbackListeners.forEach((fn) => fn(ev));

function loadSdk() {
  if (window.Spotify?.Player) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const prev = window.onSpotifyWebPlaybackSDKReady;
    window.onSpotifyWebPlaybackSDKReady = () => { prev?.(); resolve(); };
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onerror = () => { sdkPromise = null; reject(new Error("Couldn't load Spotify's web player.")); };
    document.head.append(script);
  });
  return sdkPromise;
}

export function disconnectPlayer() {
  if (sdkPlayer) {
    try { sdkPlayer.disconnect(); } catch { /* already gone */ }
    sdkPlayer = null;
  }
  deviceId = null;
  connectPromise = null;
}

export function connectPlayer() {
  if (deviceId && sdkPlayer) return Promise.resolve(deviceId);
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    await loadSdk();
    const token = await getToken(false);
    if (!token) throw new Error('Sign in to Spotify in Settings first.');

    return await new Promise((resolve, reject) => {
      let settled = false;
      const done = (ok, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) resolve(val);
        else { connectPromise = null; reject(val); }
      };
      const timer = setTimeout(() => done(false, new Error("Spotify's web player timed out. Check your internet connection.")), 18000);

      const p = new window.Spotify.Player({
        name: 'Tint',
        getOAuthToken: (cb) => { getToken(false).then(cb, () => cb('')); },
        volume: lastVolume,
      });

      p.addListener('ready', ({ device_id }) => {
        deviceId = device_id;
        sdkPlayer = p;
        done(true, device_id);
      });
      p.addListener('not_ready', () => {
        deviceId = null;
        connectPromise = null;
      });
      p.addListener('initialization_error', ({ message }) => done(false, new Error(`Spotify player error: ${message}`)));
      p.addListener('authentication_error', ({ message }) => done(false, new Error(`Spotify sign-in expired (${message}). Sign in again in Settings.`)));
      p.addListener('account_error', ({ message }) => done(false, new Error(message || 'Spotify playback requires Spotify Premium.')));
      p.addListener('playback_error', ({ message }) => emitPlayback({ type: 'error', message }));
      p.addListener('player_state_changed', (s) => {
        if (!s) return;
        emitPlayback({ type: 'state', state: s });
      });

      p.connect().then((ok) => {
        if (!ok) done(false, new Error("Couldn't connect to Spotify's web player."));
      });
    });
  })();
  return connectPromise;
}

export async function playTrack(spotifyId) {
  const dev = await connectPlayer();
  try {
    await api(`/me/player/play?device_id=${encodeURIComponent(dev)}`, {
      method: 'PUT',
      body: { uris: [`spotify:track:${spotifyId}`] },
    });
  } catch (e) {
    // Device may have dropped; reconnect once and retry.
    if (e?.status === 404) {
      disconnectPlayer();
      const freshDev = await connectPlayer();
      await api(`/me/player/play?device_id=${encodeURIComponent(freshDev)}`, {
        method: 'PUT',
        body: { uris: [`spotify:track:${spotifyId}`] },
      });
    } else {
      throw e;
    }
  }
}

export const pausePlayback = () => sdkPlayer?.pause?.().catch(() => {});
export const resumePlayback = () => sdkPlayer?.resume?.().catch(() => {});
export const seekPlayback = (seconds) => sdkPlayer?.seek?.(Math.max(0, Math.round(seconds * 1000))).catch(() => {});
export const getPlaybackState = () => sdkPlayer?.getCurrentState?.().catch(() => null) || Promise.resolve(null);
export function setPlayerVolume(level) {
  lastVolume = Math.max(0, Math.min(1, Number(level) || 0));
  sdkPlayer?.setVolume?.(lastVolume).catch(() => {});
}

// ---- normalizing Spotify Web API shapes ---------------------------------------------------------

function pickArt(images) {
  if (!Array.isArray(images) || !images.length) return null;
  const sorted = [...images].filter((i) => i?.url).sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url ? { url: sorted[0].url } : null;
}

function toTrack(t, albumFallback = null) {
  if (!t?.id || t.type === 'episode') return null;
  const alb = t.album || albumFallback || null;
  const artists = (t.artists || []).map((a) => a?.name).filter(Boolean);
  const firstArtist = t.artists?.[0];
  return {
    id: 's:' + t.id,
    source: 'spotify',
    spotifyId: t.id,
    title: t.name || 'Untitled',
    artist: artists.join(', ') || '',
    artistId: firstArtist?.id || null,
    album: alb?.name || '',
    albumHref: alb?.id ? `#/album/s/${encodeURIComponent(alb.id)}` : null,
    duration: (t.duration_ms || 0) / 1000,
    trackNo: t.track_number || 0,
    discNo: t.disc_number || 1,
    art: pickArt(alb?.images) || pickArt(t.images) || null,
    explicit: !!t.explicit,
    playable: t.is_playable !== false && !t.is_local,
    reason: t.is_local ? 'Local Spotify files cannot be streamed here.' : t.is_playable === false ? "This song isn't available in your region." : null,
  };
}

function toAlbumCard(a, added = 0) {
  if (!a?.id) return null;
  const artists = (a.artists || []).map((x) => x?.name).filter(Boolean);
  return {
    id: a.id,
    source: 'spotify',
    title: a.name || 'Untitled',
    artist: artists.join(', '),
    year: (a.release_date || '').slice(0, 4),
    art: pickArt(a.images),
    count: a.total_tracks || 0,
    added,
    href: `#/album/s/${encodeURIComponent(a.id)}`,
  };
}

function toArtistCard(a) {
  if (!a?.id) return null;
  return {
    id: a.id,
    source: 'spotify',
    title: a.name || 'Unknown artist',
    art: pickArt(a.images),
    href: `#/artist/s/${encodeURIComponent(a.id)}`,
  };
}

function toPlaylistCard(p) {
  if (!p?.id) return null;
  const ownerId = p.owner?.id || null;
  const editable = !!p.collaborative || (!!ownerId && !!status?.userId && ownerId === status.userId)
    || (!status?.userId && !!status?.user && p.owner?.display_name === status.user);
  return {
    id: p.id,
    source: 'spotify',
    title: p.name || 'Untitled playlist',
    artist: p.owner?.display_name || 'Spotify',
    art: pickArt(p.images),
    editable,
    href: `#/playlist/s/${encodeURIComponent(p.id)}`,
  };
}

// ---- library (saved albums, liked songs, playlists) ---------------------------------------------

function createShelf(loader) {
  const shelf = { state: 'idle', items: [], error: null };
  let task = null;
  return {
    read() {
      if (shelf.state === 'idle' && isSignedIn()) {
        shelf.state = 'loading';
        shelf.error = null;
        task = loader().then((items) => {
          shelf.items = items;
          shelf.state = 'ready';
          changed();
        }, (e) => {
          shelf.error = e?.message || String(e);
          shelf.state = 'error';
          changed();
        });
      }
      return shelf;
    },
    clear() {
      shelf.state = 'idle';
      shelf.items = [];
      shelf.error = null;
      task = null;
    },
  };
}

async function paginate(firstPath, maxPages = 8) {
  const out = [];
  let next = firstPath;
  for (let i = 0; i < maxPages && next; i++) {
    const page = await api(next);
    if (!page) break;
    const rows = page.items || [];
    out.push(...rows);
    next = page.next || null;
  }
  return out;
}

const albumsShelf = createShelf(async () => {
  const rows = await paginate('/me/albums?limit=50', 8);
  return rows.map((r) => toAlbumCard(r.album, r.added_at ? Date.parse(r.added_at) || 0 : 0)).filter(Boolean);
});

const songsShelf = createShelf(async () => {
  const rows = await paginate('/me/tracks?limit=50', 10);
  return rows.map((r) => {
    const t = toTrack(r.track || r.item);
    if (t && r.added_at) t.added = Date.parse(r.added_at) || 0;
    return t;
  }).filter(Boolean);
});

const playlistsShelf = createShelf(async () => {
  const rows = await paginate('/me/playlists?limit=50', 4);
  return rows.map(toPlaylistCard).filter(Boolean);
});

export function clearLibrary() {
  albumsShelf.clear();
  songsShelf.clear();
  playlistsShelf.clear();
}

export const libraryAlbums = () => albumsShelf.read();
export const librarySongs = () => songsShelf.read();
export const libraryPlaylists = () => playlistsShelf.read();

// ---- syncing likes and playlists with Spotify ---------------------------------------------------

/** User-owned or collaborative Spotify playlists. */
export function editablePlaylists() {
  if (!isSignedIn()) return [];
  return libraryPlaylists().items.filter((p) => p.editable);
}

/** Likes or unlikes a song on Spotify and updates the cached Liked Songs list. */
export async function setLiked(track, liked) {
  if (!isSignedIn()) throw new Error('Sign in to Spotify in Settings first.');
  const id = track?.spotifyId;
  if (!id) throw new Error("This song doesn't have a Spotify ID.");
  const method = liked ? 'PUT' : 'DELETE';
  // Try Spotify's 2026 unified library route first, falling back to /me/tracks for older token scopes.
  try {
    await api(`/me/tracks?ids=${encodeURIComponent(id)}`, { method });
  } catch (e) {
    if (e?.status === 400 || e?.status === 403 || e?.status === 404) {
      await api(`/me/library?uris=${encodeURIComponent('spotify:track:' + id)}`, { method });
    } else {
      throw e;
    }
  }
  const shelf = songsShelf.read();
  const exists = shelf.items.some((t) => t.spotifyId === id || t.id === track.id);
  if (liked && !exists) shelf.items = [track, ...shelf.items];
  else if (!liked && exists) shelf.items = shelf.items.filter((t) => t.spotifyId !== id && t.id !== track.id);
  changed();
}

/** Adds one or more songs to a Spotify playlist (matching cross-platform songs by name). */
export async function addToPlaylist(playlistId, tracks) {
  if (!isSignedIn()) throw new Error('Sign in to Spotify in Settings first.');
  const uris = [];
  const seen = new Set();
  for (const t of tracks) {
    let id = t?.source === 'spotify' ? t.spotifyId : null;
    if (!id && t?.title) {
      const match = await findSong(t).catch(() => null);
      id = match?.spotifyId || null;
    }
    if (id && !seen.has(id)) {
      seen.add(id);
      uris.push(`spotify:track:${id}`);
    }
  }
  if (!uris.length) throw new Error("Couldn't find matching songs on Spotify.");
  for (let i = 0; i < uris.length; i += 100) {
    const chunk = uris.slice(i, i + 100);
    try {
      await api(`/playlists/${encodeURIComponent(playlistId)}/items`, { method: 'POST', body: { uris: chunk } });
    } catch (e) {
      if (e?.status === 404 || e?.status === 405) {
        await api(`/playlists/${encodeURIComponent(playlistId)}/tracks`, { method: 'POST', body: { uris: chunk } });
      } else {
        throw e;
      }
    }
  }
  return uris.length;
}

/** Removes a song from a Spotify playlist. */
export async function removeFromPlaylist(playlistId, track) {
  if (!isSignedIn()) throw new Error('Sign in to Spotify in Settings first.');
  if (!track?.spotifyId) throw new Error("This song isn't from Spotify.");
  const uri = `spotify:track:${track.spotifyId}`;
  try {
    await api(`/playlists/${encodeURIComponent(playlistId)}/items`, { method: 'DELETE', body: { items: [{ uri }] } });
  } catch (e) {
    if (e?.status === 400 || e?.status === 404 || e?.status === 405) {
      await api(`/playlists/${encodeURIComponent(playlistId)}/tracks`, { method: 'DELETE', body: { tracks: [{ uri }] } });
    } else {
      throw e;
    }
  }
}

/** Creates a new private Spotify playlist, optionally seeded with songs. */
export async function createPlaylist(title, tracks = []) {
  if (!isSignedIn()) throw new Error('Sign in to Spotify in Settings first.');
  const clean = String(title || '').trim().slice(0, 80);
  if (!clean) return null;
  const created = await api('/me/playlists', { method: 'POST', body: { name: clean, public: false } });
  const card = toPlaylistCard(created);
  if (card) {
    card.editable = true;
    if (tracks.length) await addToPlaylist(card.id, tracks).catch(() => {});
    const shelf = playlistsShelf.read();
    shelf.items = [card, ...shelf.items];
    changed();
  }
  return card;
}

/** Follows (saves) a Spotify playlist to the user's Spotify library. */
export async function savePlaylist(playlistId) {
  if (!isSignedIn()) throw new Error('Sign in to Spotify in Settings first.');
  try {
    await api(`/playlists/${encodeURIComponent(playlistId)}/followers`, { method: 'PUT', body: { public: false } });
  } catch (e) {
    if (e?.status === 400 || e?.status === 403 || e?.status === 404) {
      await api(`/me/library?uris=${encodeURIComponent('spotify:playlist:' + playlistId)}`, { method: 'PUT' });
    } else {
      throw e;
    }
  }
}

/** Unfollows (removes) a playlist from the user's Spotify library. */
export async function removePlaylist(playlistId) {
  if (!isSignedIn()) throw new Error('Sign in to Spotify in Settings first.');
  try {
    await api(`/playlists/${encodeURIComponent(playlistId)}/followers`, { method: 'DELETE' });
  } catch (e) {
    if (e?.status === 400 || e?.status === 403 || e?.status === 404) {
      await api(`/me/library?uris=${encodeURIComponent('spotify:playlist:' + playlistId)}`, { method: 'DELETE' });
    } else {
      throw e;
    }
  }
  const shelf = playlistsShelf.read();
  shelf.items = shelf.items.filter((p) => p.id !== playlistId);
  changed();
}

// ---- catalog: search, album, playlist, artist, track --------------------------------------------

export async function search(query) {
  // Spotify Development Mode caps search `limit` at 10.
  const q = encodeURIComponent(query);
  const data = await api(`/search?q=${q}&type=track,album,artist,playlist&limit=10`);
  return {
    songs: (data?.tracks?.items || []).map((t) => toTrack(t)).filter(Boolean),
    albums: (data?.albums?.items || []).map((a) => toAlbumCard(a)).filter(Boolean),
    artists: (data?.artists?.items || []).map(toArtistCard).filter(Boolean),
    playlists: (data?.playlists?.items || []).map(toPlaylistCard).filter(Boolean),
  };
}

export async function track(id) {
  const data = await api(`/tracks/${encodeURIComponent(id)}`);
  return toTrack(data);
}

export async function album(id) {
  const data = await api(`/albums/${encodeURIComponent(id)}`);
  const firstPage = data.tracks?.items || [];
  let extra = [];
  if (data.tracks?.next) extra = await paginate(data.tracks.next, 8);
  const tracks = [...firstPage, ...extra].map((t) => toTrack(t, data)).filter(Boolean);
  const firstArtist = data.artists?.[0];
  return {
    id: data.id,
    source: 'spotify',
    title: data.name || 'Untitled',
    artist: (data.artists || []).map((a) => a.name).join(', '),
    artistHref: firstArtist?.id ? `#/artist/s/${encodeURIComponent(firstArtist.id)}` : null,
    year: (data.release_date || '').slice(0, 4),
    art: pickArt(data.images),
    tracks,
  };
}

export async function playlist(id) {
  const data = await api(`/playlists/${encodeURIComponent(id)}`);
  // 2026 Spotify Web API renamed `tracks` -> `items` and nested `entry.track` -> `entry.item`.
  const container = data.items || data.tracks;
  let rows = Array.isArray(container?.items) ? container.items.slice() : [];
  if (container?.next) {
    try { rows.push(...await paginate(container.next, 8)); } catch { /* partial list is still useful */ }
  }
  let tracks = rows.map((r) => toTrack(r?.item || r?.track)).filter(Boolean);

  // In Spotify Development Mode, Web API omits items for playlists the user doesn't own/collaborate on.
  // Fall back to Tint's embed reader to get the track IDs and play them natively via Spotify Premium!
  if (!tracks.length) {
    const embed = await lookUp({ kind: 'playlist', id }).catch(() => null);
    if (embed?.songs?.length) {
      tracks = embed.songs.filter((s) => s.spotifyId).map((s, idx) => ({
        id: 's:' + s.spotifyId,
        source: 'spotify',
        spotifyId: s.spotifyId,
        title: s.title,
        artist: s.artist,
        album: '',
        duration: s.duration || 0,
        trackNo: idx + 1,
        discNo: 1,
        art: embed.art ? { url: embed.art } : null,
        explicit: !!s.explicit,
        playable: true,
      }));
    }
  }

  return {
    id: data.id,
    source: 'spotify',
    title: data.name || 'Untitled playlist',
    artist: data.owner?.display_name || 'Spotify',
    description: (data.description || '').replace(/<[^>]+>/g, ''),
    art: pickArt(data.images) || tracks[0]?.art || null,
    tracks,
  };
}

export async function artist(id) {
  const data = await api(`/artists/${encodeURIComponent(id)}`);
  const [albumsRes, topRes] = await Promise.all([
    api(`/artists/${encodeURIComponent(id)}/albums?limit=10&include_groups=album,single`).catch(() => null),
    api(`/artists/${encodeURIComponent(id)}/top-tracks`).catch(() => null),
  ]);
  const rawReleases = albumsRes?.items || [];
  let songs = (topRes?.tracks || []).map((t) => toTrack(t)).filter(Boolean);

  // In Spotify Development Mode, /top-tracks may be restricted. Only keep tracks whose Spotify artist ID
  // matches `id` strictly, and pull tracks directly from this artist's own albums/singles as primary fallback.
  if (!songs.length) {
    const seen = new Set();
    const seenTitles = new Set();
    const collected = [];
    const pushIfMine = (t, rawArtists) => {
      if (!t || seen.has(t.id)) return;
      if (rawArtists && !rawArtists.some((a) => a?.id === id)) return;
      const key = t.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (key && seenTitles.has(key)) return;
      seen.add(t.id);
      if (key) seenTitles.add(key);
      collected.push(t);
    };
    if (data?.name) {
      const q = encodeURIComponent(`artist:"${data.name}"`);
      const res = await api(`/search?q=${q}&type=track&limit=10`).catch(() => null);
      for (const raw of res?.tracks?.items || []) pushIfMine(toTrack(raw), raw.artists);
    }
    if (collected.length < 6 && rawReleases.length) {
      const sample = rawReleases.slice(0, 4);
      const fetched = await Promise.all(sample.map((r) => api(`/albums/${encodeURIComponent(r.id)}`).catch(() => null)));
      for (const alb of fetched) {
        if (!alb) continue;
        for (const raw of (alb.tracks?.items || []).slice(0, 4)) {
          pushIfMine(toTrack(raw, alb), raw.artists);
          if (collected.length >= 10) break;
        }
        if (collected.length >= 10) break;
      }
    }
    songs = collected;
  }

  const allReleases = rawReleases.map((a) => ({ ...toAlbumCard(a), group: a.album_group || a.album_type }));
  const albums = allReleases.filter((a) => a.group === 'album');
  const singles = allReleases.filter((a) => a.group !== 'album');
  return {
    id: data.id,
    title: data.name || 'Unknown artist',
    art: pickArt(data.images),
    genres: data.genres || [],
    songs,
    albums,
    singles,
  };
}

export async function findSong(target) {
  if (!isSignedIn() || !target?.title) return null;
  const q = `${target.title} ${target.artist || ''}`.trim();
  const res = await search(q).catch(() => null);
  return res?.songs?.length ? bestMatch(target, res.songs) : null;
}

export async function findArtist(name) {
  return (await findArtists(name))[0] || null;
}

export async function findArtists(name) {
  if (!isSignedIn() || !name) return [];
  const res = await search(name).catch(() => null);
  return [...new Set((res?.artists || []).filter((a) => sameName(a.title, name)).map((a) => a.id))].slice(0, 5);
}

// ---- public Spotify link parsing & cross-service matching (works signed out too) ----------------

/** { kind, id } for a Spotify track, album or playlist link (or spotify: address), or null. */
export function linkIn(text) {
  text = (text || '').trim();
  const uri = text.match(/^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/);
  if (uri) return { kind: uri[1], id: uri[2] };
  let url;
  try { url = new URL(text); } catch { return null; }
  if (!/^(open|play)\.spotify\.com$/.test(url.hostname)) return null;
  // Shared links can carry a language first: /intl-pt/track/…
  const path = url.pathname.match(/^(?:\/intl-[\w-]+)?\/(?:embed\/)?(track|album|playlist)\/([A-Za-z0-9]{22})/);
  return path ? { kind: path[1], id: path[2] } : null;
}

/** What the link points at: { kind, title, artist, art, songs: [{ title, artist, duration, explicit, spotifyId }] }, or null. */
export async function lookUp(link, fresh = false) {
  const res = await get(`/api/spotify?kind=${link.kind}&id=${link.id}${fresh ? '&fresh=1' : ''}`);
  return res.found;
}

/** The same recording on Apple Music, or null. Not set up or not answering counts as not found. */
export async function onApple(song) {
  if (!apple.instance()) return null;
  return apple.findSong(song).catch(() => null);
}

/** The same recording on YouTube Music, or null. */
export async function onYouTube(song) {
  if (!youtube.isReady()) return null;
  return youtube.findSong(song).catch(() => null);
}

/** Where a link's songs are looked for first: the main service chosen at the welcome, when it is ready. */
export function firstChoice() {
  const ready = { apple: !!apple.instance(), youtube: youtube.isReady() };
  if (ready[prefs.mainService]) return prefs.mainService;
  return ready.apple || !ready.youtube ? 'apple' : 'youtube';
}

/**
 * Each song found on `prefer` ('apple' or 'youtube'), or on the other service when that one lacks
 * it; null where neither has it. In the list's order; a few are asked at a time, and
 * `progress(done, total)` is told as they come in. `stopped()` ends it early when no one is waiting.
 */
export async function matchAll(songs, progress, prefer = firstChoice(), stopped = () => false) {
  const found = new Array(songs.length).fill(null);
  const [first, second] = prefer === 'youtube' ? [onYouTube, onApple] : [onApple, onYouTube];
  let next = 0, done = 0;
  async function worker() {
    while (next < songs.length && !stopped()) {
      const i = next++;
      found[i] = (await first(songs[i])) || (await second(songs[i]));
      progress?.(++done, songs.length);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return found;
}
