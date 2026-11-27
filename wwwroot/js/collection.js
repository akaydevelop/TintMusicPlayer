// Playlists saved in Tint itself, apart from any service's library: kept on this PC by the host
// (collection.json), each with a pin and any number of coloured tags. A saved playlist also keeps
// a copy of its songs, so it still plays if the service loses it.

import { get, post } from './api.js';

/** The colours a tag can take. Bright enough to read on any cover's palette, light or dark. */
export const COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#8e4ec6', '#d6409f', '#8d8d8d'];

const state = { items: [], tags: [] };
let loaded = false;
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export async function load() {
  try {
    const stored = await get('/api/collection');
    state.items = Array.isArray(stored.items) ? stored.items : [];
    state.tags = Array.isArray(stored.tags) ? stored.tags : [];
  } catch { /* an unreadable file starts empty rather than stopping the app */ }
  loaded = true;
  // Playlists saved before links were kept get theirs now.
  if (state.items.some((item) => !item.url && linkOf(item))) {
    state.items.forEach((item) => { item.url ||= linkOf(item) || undefined; });
    changed();
  } else {
    listeners.forEach((fn) => fn());
  }
}

/**
 * The web address a saved playlist came from: its YouTube Music or Apple Music page, or the
 * Spotify list a Tint playlist was made from. Kept with it, so its songs can be checked again later.
 */
function linkOf(item) {
  if (item.from?.url) return item.from.url;
  if (!item.id) return null;
  if (item.source === 'youtube') return `https://music.youtube.com/playlist?list=${encodeURIComponent(item.id)}`;
  if (item.source === 'spotify') return `https://open.spotify.com/playlist/${encodeURIComponent(item.id)}`;
  // Only Apple's catalog playlists have a page; one in someone's own library (p.…) doesn't.
  if (item.source === 'apple' && item.id.startsWith('pl.')) return `https://music.apple.com/playlist/${encodeURIComponent(item.id)}`;
  return null;
}

let saving = Promise.resolve();
function changed() {
  listeners.forEach((fn) => fn());
  // Writes go one after another, so an older one never lands last.
  const copy = JSON.parse(JSON.stringify({ items: state.items, tags: state.tags }));
  saving = saving.then(() => post('/api/collection', copy)).catch(() => {});
}

export const LIKED_HREF = '#/playlist/t/liked';

export const isLoaded = () => loaded;
export const items = () => state.items;
export const tags = () => state.tags;
export const find = (href) => state.items.find((item) => item.href === href) || null;
export const isSaved = (href) => !!find(href);
export const tag = (id) => state.tags.find((t) => t.id === id) || null;
export const tagsOf = (item) => (item?.tags || []).map(tag).filter(Boolean);
export const liked = () => find(LIKED_HREF);
export const isEditable = (item) => !!item && item.source === 'tint';

function cleanTrack(track) {
  return JSON.parse(JSON.stringify(track));
}

export function isLiked(track) {
  if (!track?.id) return false;
  return !!liked()?.tracks?.some((t) => t.id === track.id);
}

/** Likes or unlikes a song. New likes go to the top of the Liked songs playlist. Returns the new state. */
export function toggleLike(track) {
  if (!track?.id) return false;
  let list = liked();
  if (!list) {
    list = {
      id: 'liked', source: 'tint', href: LIKED_HREF, kind: 'liked',
      title: 'Liked songs', artist: 'In Tint', art: null,
      tracks: [cleanTrack(track)], pinned: true, pinnedAt: 1, tags: [], savedAt: Date.now(),
    };
    state.items.unshift(list);
    changed();
    return true;
  }
  const exists = list.tracks.some((t) => t.id === track.id);
  if (exists) {
    list.tracks = list.tracks.filter((t) => t.id !== track.id);
    if (!list.tracks.length) state.items = state.items.filter((item) => item.href !== LIKED_HREF);
  } else {
    list.tracks.unshift(cleanTrack(track));
    list.savedAt = Date.now();
  }
  changed();
  return !exists;
}

/** User-created Tint playlists (excluding Liked songs), newest first. */
export function customPlaylists() {
  return state.items
    .filter((item) => item.source === 'tint' && item.href !== LIKED_HREF)
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

/** Creates a new custom Tint playlist with optional initial tracks. */
export function createPlaylist(title, tracks = []) {
  const clean = String(title || '').trim().slice(0, 80);
  if (!clean) return null;
  const id = 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const href = `#/playlist/t/${id}`;
  const seen = new Set();
  const list = tracks.filter((t) => t?.id && !seen.has(t.id) && seen.add(t.id)).map(cleanTrack);
  const item = {
    id, source: 'tint', href,
    title: clean, artist: 'Playlist in Tint',
    art: list[0]?.art || null,
    tracks: list, pinned: false, tags: [], savedAt: Date.now(),
  };
  state.items.push(item);
  changed();
  return item;
}

export function renamePlaylist(href, title) {
  const item = find(href);
  const clean = String(title || '').trim().slice(0, 80);
  if (!item || item.source !== 'tint' || item.href === LIKED_HREF || !clean) return false;
  item.title = clean;
  changed();
  return true;
}

export function hasTrack(href, track) {
  if (!track?.id) return false;
  return !!find(href)?.tracks?.some((t) => t.id === track.id);
}

/** Adds one or more tracks to a Tint playlist (skipping duplicates). Returns how many were added. */
export function addTracks(href, tracks) {
  const item = find(href);
  if (!item || item.source !== 'tint') return 0;
  const have = new Set((item.tracks || []).map((t) => t.id));
  const added = [];
  for (const t of tracks) {
    if (t?.id && !have.has(t.id)) {
      have.add(t.id);
      added.push(cleanTrack(t));
    }
  }
  if (!added.length) return 0;
  item.tracks = [...(item.tracks || []), ...added];
  if (!item.art && item.href !== LIKED_HREF) item.art = added[0].art || null;
  item.savedAt = Date.now();
  changed();
  return added.length;
}

/** Removes a track from a Tint playlist (including Liked songs). */
export function removeTrack(href, trackId) {
  const item = find(href);
  if (!item || item.source !== 'tint' || !trackId) return false;
  const before = item.tracks?.length || 0;
  item.tracks = (item.tracks || []).filter((t) => t.id !== trackId);
  if (item.tracks.length === before) return false;
  if (item.href === LIKED_HREF && !item.tracks.length) {
    state.items = state.items.filter((x) => x.href !== LIKED_HREF);
  } else if (item.href !== LIKED_HREF && !item.from && !item.tracks.length) {
    item.art = null;
  }
  changed();
  return true;
}

/** Saves a playlist (or refreshes the saved copy of its songs, keeping its pin and tags). */
export function save(playlist) {
  const existing = find(playlist.href);
  const fields = {
    id: playlist.id, source: playlist.source, href: playlist.href,
    title: playlist.title, artist: playlist.artist || '', art: playlist.art || null,
    // Songs are plain data from apple.js and youtube.js, so a JSON copy keeps all a song needs to play.
    tracks: JSON.parse(JSON.stringify(playlist.tracks || [])),
  };
  // A playlist made in Tint remembers what it was made from (a Spotify link, say).
  if (playlist.from) fields.from = playlist.from;
  const url = linkOf(fields);
  if (url) fields.url = url;
  if (existing) Object.assign(existing, fields);
  else state.items.push({ ...fields, pinned: false, tags: [], savedAt: Date.now() });
  changed();
}

export function remove(href) {
  state.items = state.items.filter((item) => item.href !== href);
  changed();
}

export function setPinned(href, pinned) {
  const item = find(href);
  if (!item) return;
  item.pinned = pinned;
  item.pinnedAt = pinned ? Date.now() : undefined;
  changed();
}

export function toggleTag(href, tagId) {
  const item = find(href);
  if (!item) return;
  item.tags = item.tags?.includes(tagId) ? item.tags.filter((id) => id !== tagId) : [...(item.tags || []), tagId];
  changed();
}

export function addTag(name, color) {
  const clean = name.trim().slice(0, 40);
  if (!clean) return null;
  const same = state.tags.find((t) => t.name.toLowerCase() === clean.toLowerCase());
  if (same) return same;
  const made = addTagQuietly(clean, color);
  changed();
  return made;
}

export function editTag(id, changes) {
  const found = tag(id);
  if (!found) return;
  if (changes.name?.trim()) found.name = changes.name.trim().slice(0, 40);
  if (changes.color) found.color = changes.color;
  changed();
}

/** The saved playlists and tags as they are, for a backup. */
export const snapshot = () => JSON.parse(JSON.stringify({ items: state.items, tags: state.tags }));

/**
 * Takes in a backup's playlists and tags. Playlists already here keep their songs and gain the
 * backup's tags and pin; tags are matched by name, so the same tag isn't made twice.
 * Returns how many playlists were new.
 */
export function merge(backup) {
  const tagIds = new Map(); // the backup's tag id -> the id it has here
  for (const t of Array.isArray(backup?.tags) ? backup.tags : []) {
    if (!t?.id || typeof t.name !== 'string') continue;
    const here = state.tags.find((mine) => mine.name.toLowerCase() === t.name.trim().toLowerCase())
      || addTagQuietly(t.name, COLORS.includes(t.color) ? t.color : COLORS[state.tags.length % COLORS.length]);
    if (here) tagIds.set(t.id, here.id);
  }
  let added = 0;
  for (const item of Array.isArray(backup?.items) ? backup.items : []) {
    if (typeof item?.href !== 'string' || !item.href.startsWith('#/playlist/') || typeof item.title !== 'string') continue;
    const theirTags = (item.tags || []).map((id) => tagIds.get(id)).filter(Boolean);
    const existing = find(item.href);
    if (existing) {
      existing.tags = [...new Set([...(existing.tags || []), ...theirTags])];
      if (item.pinned && !existing.pinned) { existing.pinned = true; existing.pinnedAt = item.pinnedAt || Date.now(); }
      continue;
    }
    state.items.push({ ...item, tracks: Array.isArray(item.tracks) ? item.tracks : [], tags: theirTags, pinned: !!item.pinned, savedAt: item.savedAt || Date.now() });
    added++;
  }
  changed();
  return added;
}

function addTagQuietly(name, color) {
  const clean = String(name).trim().slice(0, 40);
  if (!clean) return null;
  const made = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: clean, color };
  state.tags.push(made);
  return made;
}

export function deleteTag(id) {
  state.tags = state.tags.filter((t) => t.id !== id);
  for (const item of state.items) item.tags = (item.tags || []).filter((t) => t !== id);
  changed();
}
