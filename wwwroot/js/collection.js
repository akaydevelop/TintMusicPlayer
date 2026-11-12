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
  listeners.forEach((fn) => fn());
}

let saving = Promise.resolve();
function changed() {
  listeners.forEach((fn) => fn());
  // Writes go one after another, so an older one never lands last.
  const copy = JSON.parse(JSON.stringify({ items: state.items, tags: state.tags }));
  saving = saving.then(() => post('/api/collection', copy)).catch(() => {});
}

export const isLoaded = () => loaded;
export const items = () => state.items;
export const tags = () => state.tags;
export const find = (href) => state.items.find((item) => item.href === href) || null;
export const isSaved = (href) => !!find(href);
export const tag = (id) => state.tags.find((t) => t.id === id) || null;
export const tagsOf = (item) => (item?.tags || []).map(tag).filter(Boolean);

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
