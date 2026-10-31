// Spotify links. Tint doesn't play from Spotify; the host reads what a link points at (titles,
// artists, lengths), and the same songs are looked up on Apple Music and YouTube Music by name.

import { get } from './api.js';
import * as apple from './apple.js';
import * as youtube from './youtube.js';

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

/** What the link points at: { kind, title, artist, art, songs: [{ title, artist, duration, explicit }] }, or null. */
export async function lookUp(link) {
  const res = await get(`/api/spotify?kind=${link.kind}&id=${link.id}`);
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

/**
 * Each song of a list on Apple Music where it's there, otherwise on YouTube Music, in the list's
 * order. A few are asked at a time; `progress(done, total)` is told as they come in.
 */
export async function matchAll(songs, progress) {
  const found = new Array(songs.length).fill(null);
  let next = 0, done = 0;
  async function worker() {
    while (next < songs.length) {
      const i = next++;
      found[i] = (await onApple(songs[i])) || (await onYouTube(songs[i]));
      progress?.(++done, songs.length);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return found;
}
