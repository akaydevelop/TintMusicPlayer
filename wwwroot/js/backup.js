// Everything Tint keeps lives on this PC, with no account behind it. A backup is how it moves to
// another PC or survives a reinstall: saved playlists and tags, the songs played lately, and the
// choices made in Settings. Sign-ins, keys and tokens are never in it.

import { post } from './api.js';
import * as prefs from './prefs.js';
import * as collection from './collection.js';
import * as history from './history.js';

// The settings a backup carries, with the type each must have to be taken back in.
const SETTINGS = {
  mainService: 'string', keepDark: 'boolean', youtube: 'boolean', youtubePlayer: 'string',
  pauseFadeMs: 'number', crossfadeMs: 'number', cacheKeepDays: 'number',
};
// Choices the page keeps itself.
const PAGE_KEYS = ['tint.lyrics.romaji', 'tint.lyrics.translate'];

function readKey(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** Writes a backup to the Downloads folder and returns its path. */
export async function exportAll() {
  const settings = Object.fromEntries(Object.keys(SETTINGS).map((key) => [key, prefs.prefs[key]]));
  settings.folders = prefs.prefs.folders;
  const backup = {
    tint: 1,
    made: new Date().toISOString(),
    settings,
    collection: collection.snapshot(),
    history: history.songs(),
    page: Object.fromEntries(PAGE_KEYS.map((key) => [key, readKey(key)]).filter(([, value]) => value != null)),
  };
  const { path } = await post('/api/export', backup);
  if (!path) throw new Error("The backup couldn't be written to the Downloads folder.");
  return path;
}

export const show = (path) => post('/api/show-export', { path }).catch(() => {});

/**
 * Takes a backup file back in. Playlists and songs already here stay; the backup's are added to
 * them. Its settings replace these, and its music folders join the ones here that exist on this PC.
 */
export async function importFrom(file) {
  let backup = null;
  try { backup = JSON.parse(await file.text()); } catch { /* answered below */ }
  if (backup?.tint !== 1) throw new Error("That file isn't a Tint backup.");

  const given = backup.settings || {};
  const changes = { welcomed: true };
  for (const [key, type] of Object.entries(SETTINGS)) {
    if (typeof given[key] === type && (type !== 'string' || given[key])) changes[key] = given[key];
  }
  if (Array.isArray(given.folders)) {
    changes.folders = [...new Set([...prefs.prefs.folders, ...given.folders.filter((f) => typeof f === 'string')])];
  }
  await prefs.save(changes);

  const added = collection.merge(backup.collection);
  history.merge(backup.history);
  for (const [key, value] of Object.entries(backup.page || {})) {
    if (PAGE_KEYS.includes(key) && typeof value === 'string') {
      try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
    }
  }
  return { added, songs: Array.isArray(backup.history) ? backup.history.length : 0 };
}
