// Spotify links. Tint doesn't play from Spotify; the host reads what a link points at (titles,
// artists, lengths), and the same songs are looked up on Apple Music and YouTube Music by name.

import { get } from './api.js';
import * as apple from './apple.js';
import * as youtube from './youtube.js';
import { prefs } from './prefs.js';

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
