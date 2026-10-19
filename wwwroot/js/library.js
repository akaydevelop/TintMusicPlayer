// The music files on this PC, as scanned by the host.

import { get } from './api.js';

export const local = { tracks: [], albums: [], byAlbum: new Map(), scanning: false, skippedProtected: 0, loaded: false };

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
export const compareText = (a, b) => collator.compare(a || '', b || '');

let version = -1;
let pollTimer = 0;

function build(payload) {
  const tracks = payload.tracks.map((t) => ({
    id: 'l:' + t.id,
    source: 'local',
    fileId: t.id,
    title: t.title,
    artist: t.artist,
    albumArtist: t.albumArtist || t.artist,
    album: t.album || 'Unknown album',
    genre: t.genre || '',
    trackNo: t.trackNo,
    discNo: t.discNo || 1,
    year: t.year,
    duration: t.duration,
    added: t.added,
    art: t.art ? { key: t.art } : null,
    playable: t.playable,
    reason: t.reason,
    haystack: `${t.title}\n${t.artist}\n${t.album || ''}`.toLowerCase(),
  }));

  const byAlbum = new Map();
  for (const t of tracks) {
    const key = `${t.albumArtist}\u0001${t.album}`.toLowerCase();
    let album = byAlbum.get(key);
    if (!album) {
      album = {
        id: key,
        source: 'local',
        title: t.album,
        artist: t.albumArtist,
        year: '',
        added: 0,
        art: null,
        tracks: [],
        href: `#/album/l/${encodeURIComponent(key)}`,
      };
      byAlbum.set(key, album);
    }
    album.tracks.push(t);
    t.albumHref = album.href;
    if (!album.art && t.art) album.art = t.art;
    if (!album.year && t.year) album.year = String(t.year);
    if (t.added > album.added) album.added = t.added;
  }
  for (const album of byAlbum.values()) {
    album.tracks.sort((a, b) => a.discNo - b.discNo || a.trackNo - b.trackNo || compareText(a.title, b.title));
    album.count = album.tracks.length;
  }

  tracks.sort((a, b) => compareText(a.artist, b.artist) || compareText(a.album, b.album) || a.discNo - b.discNo || a.trackNo - b.trackNo || compareText(a.title, b.title));

  local.tracks = tracks;
  local.byAlbum = byAlbum;
  local.albums = [...byAlbum.values()];
  local.skippedProtected = payload.skippedProtected;
  local.loaded = true;
}

async function refresh() {
  const payload = await get('/api/library');
  version = payload.version;
  local.scanning = payload.scanning;
  build(payload);
  listeners.forEach((fn) => fn());
}

/** Loads the library and keeps it current: the host bumps its version whenever a scan finds changes. */
export async function start() {
  await refresh().catch(() => {});
  const poll = async () => {
    let delay = 15000;
    try {
      const status = await get('/api/library/status');
      const wasScanning = local.scanning;
      local.scanning = status.scanning;
      if (status.version !== version) await refresh();
      else if (wasScanning !== status.scanning) listeners.forEach((fn) => fn());
      if (status.scanning) delay = 900;
    } catch {
      delay = 5000;
    }
    pollTimer = setTimeout(poll, delay);
  };
  pollTimer = setTimeout(poll, 600);
}

/** Ask for a status check right away (after changing folders or pressing "Scan again"). */
export function nudge() {
  clearTimeout(pollTimer);
  local.scanning = true;
  listeners.forEach((fn) => fn());
  start();
}

export function searchLocal(term) {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { songs: [], albums: [] };
  const matches = (text) => words.every((w) => text.includes(w));
  return {
    songs: local.tracks.filter((t) => matches(t.haystack)).slice(0, 60),
    albums: local.albums.filter((a) => matches(`${a.title}\n${a.artist}`.toLowerCase())).slice(0, 18),
  };
}
