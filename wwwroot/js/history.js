// The songs played lately, newest first, for the Home page. Kept in the page's own storage, like
// the player's queue, so it survives a restart.

import * as player from './player.js';

const STORE = 'tint.recent';
const KEEP = 40;

let recent = [];
try { recent = JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { recent = []; }
if (!Array.isArray(recent)) recent = [];

export const songs = () => recent;

function note(track) {
  if (!track?.id || recent[0]?.id === track.id) return;
  // Songs are plain data, so a JSON copy is all that's needed to play one again.
  const copy = JSON.parse(JSON.stringify(track));
  recent = [copy, ...recent.filter((t) => t.id !== track.id)].slice(0, KEEP);
  try { localStorage.setItem(STORE, JSON.stringify(recent)); } catch { /* storage full or blocked: only Home misses out */ }
}

/** Takes in a backup's songs, keeping the newest first and none twice. */
export function merge(songs) {
  if (!Array.isArray(songs)) return;
  const ids = new Set();
  recent = [...recent, ...songs.filter((t) => t?.id && t.title)].filter((t) => !ids.has(t.id) && ids.add(t.id)).slice(0, KEEP);
  try { localStorage.setItem(STORE, JSON.stringify(recent)); } catch { /* storage full or blocked */ }
}

export function init() {
  player.on((kind) => { if (kind === 'track') note(player.current()); });
}
