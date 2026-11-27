// Unified Liked songs across Apple Music, Spotify, YouTube Music, and Tint's own local collection.
// Likes sync straight back to the song's native platform when signed in; local PC tracks stay in Tint.

import * as collection from './collection.js';
import * as apple from './apple.js';
import * as youtube from './youtube.js';
import * as spotify from './spotify.js';
import { prefs } from './prefs.js';

export const LIKED_HREF = collection.LIKED_HREF;

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => fn());

// Optimistic heart state while a platform API call is in flight (keyed by track.id).
const pending = new Map();

// Forward changes from every underlying source.
collection.onChange(emit);
apple.onChange(() => { if (apple.isSignedIn()) apple.favoriteSongs(); emit(); });
youtube.onChange(() => { if (youtube.isSignedIn()) youtube.librarySongs(); emit(); });
spotify.onChange(() => { if (spotify.isSignedIn()) spotify.librarySongs(); emit(); });

/** Triggers loading of every signed-in platform's Liked playlist in the background. */
export function warm() {
  if (apple.isSignedIn()) apple.favoriteSongs();
  if (youtube.isSignedIn()) youtube.librarySongs();
  if (spotify.isSignedIn()) spotify.librarySongs();
}

/** Normalized "title + primary artist" fingerprint for cross-platform deduplication. */
function songKey(t) {
  if (!t?.title) return '';
  const title = t.title.toLowerCase()
    .replace(/\s*[\(\[](?:feat\.?|ft\.?|with|remaster(?:ed)?|live|version|radio edit|deluxe|bonus)[^\)\]]*[\)\]]/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const artist = (t.artist || '').toLowerCase()
    .split(/\s*(?:,|&|\bfeat\.?|\bft\.|\bwith\b|×)\s*/i)[0]
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return title ? `${title}\u0001${artist}` : '';
}

function sameTrack(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  if (a.appleId && b.appleId && a.appleId === b.appleId) return true;
  if (a.youtubeId && b.youtubeId && a.youtubeId === b.youtubeId) return true;
  if (a.spotifyId && b.spotifyId && a.spotifyId === b.spotifyId) return true;
  return false;
}

/** Raw per-source liked tracks (triggering loads when signed in). */
function rawSources() {
  const local = collection.liked()?.tracks || [];
  const am = apple.isSignedIn() ? apple.favoriteSongs() : null;
  const yt = youtube.isSignedIn() ? youtube.librarySongs() : null;
  const sp = spotify.isSignedIn() ? spotify.librarySongs() : null;
  return { local, apple: am, youtube: yt, spotify: sp };
}

/** Whether `track` is liked on its native platform, in Tint, or in another signed-in platform's Liked list. */
export function isLiked(track) {
  if (!track?.id) return false;
  if (pending.has(track.id)) return pending.get(track.id);
  const { local, apple: am, youtube: yt, spotify: sp } = rawSources();
  if (local.some((t) => sameTrack(t, track))) return true;
  if (track.source === 'apple' && am?.items.some((t) => sameTrack(t, track))) return true;
  if (track.source === 'youtube' && yt?.items.some((t) => sameTrack(t, track))) return true;
  if (track.source === 'spotify' && sp?.items.some((t) => sameTrack(t, track))) return true;
  // Also match across platforms by normalized title+artist if liked elsewhere.
  const key = songKey(track);
  if (!key) return false;
  for (const list of [am?.items, sp?.items, yt?.items]) {
    if (list?.some((t) => songKey(t) === key)) return true;
  }
  return false;
}

/**
 * Returns the merged Liked songs across all signed-in platforms + Tint's local likes,
 * deduplicated while preferring the user's main service.
 */
export function merged({ source = 'all' } = {}) {
  const raw = rawSources();
  const order = [prefs.mainService, 'apple', 'spotify', 'youtube', 'local']
    .filter((s, i, arr) => s && ['apple', 'spotify', 'youtube', 'local'].includes(s) && arr.indexOf(s) === i);

  const buckets = {
    local: raw.local,
    apple: raw.apple?.items || [],
    youtube: raw.youtube?.items || [],
    spotify: raw.spotify?.items || [],
  };

  const activeSources = [
    raw.apple && 'Apple Music',
    raw.spotify && 'Spotify',
    raw.youtube && 'YouTube Music',
    raw.local.length && 'This PC',
  ].filter(Boolean);

  const loading = [
    raw.apple?.state === 'loading' && 'Apple Music',
    raw.spotify?.state === 'loading' && 'Spotify',
    raw.youtube?.state === 'loading' && 'YouTube Music',
  ].filter(Boolean);

  if (source !== 'all') {
    return {
      tracks: (buckets[source] || []).filter((t) => pending.get(t.id) !== false),
      activeSources,
      loading,
      counts: {
        local: buckets.local.length,
        apple: buckets.apple.length,
        youtube: buckets.youtube.length,
        spotify: buckets.spotify.length,
      },
    };
  }

  const byKey = new Map();
  const tracks = [];
  for (const src of order) {
    for (const track of buckets[src] || []) {
      if (pending.get(track.id) === false) continue;
      const key = songKey(track) || track.id;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.likedSources.includes(src)) existing.likedSources.push(src);
        continue;
      }
      const entry = { track, likedSources: [src] };
      byKey.set(key, entry);
      tracks.push(entry);
    }
  }

  return {
    tracks: tracks.map((e) => e.track),
    activeSources,
    loading,
    counts: {
      local: buckets.local.length,
      apple: buckets.apple.length,
      youtube: buckets.youtube.length,
      spotify: buckets.spotify.length,
    },
  };
}

/** True when any signed-in service or local collection can supply Liked songs. */
export function hasUnifiedLiked() {
  const { local, apple: am, youtube: yt, spotify: sp } = rawSources();
  return local.length > 0 || !!am || !!yt || !!sp;
}

/** Synthetic pinned card for the unified Liked songs playlist shown in Home and Playlists. */
export function likedCard() {
  if (!hasUnifiedLiked()) return null;
  const info = merged();
  const saved = collection.liked();
  const subtitle = info.activeSources.length
    ? info.activeSources.join(' · ')
    : 'In Tint';
  return {
    id: 'liked',
    source: 'tint',
    href: LIKED_HREF,
    kind: 'liked',
    title: 'Liked songs',
    artist: subtitle,
    art: null,
    tracks: info.tracks,
    pinned: saved ? !!saved.pinned : true,
    pinnedAt: saved?.pinnedAt || 1,
    tags: saved?.tags || [],
  };
}

/** Identifies a platform's standalone Liked playlist so Playlists can replace it with the unified one. */
export function isPlatformLikedPlaylist(item) {
  if (!item) return false;
  if (item.source === 'youtube' && item.id === 'VLLM') return true;
  if (apple.isFavoritePlaylist(item)) return true;
  return false;
}

const SERVICE_LABEL = { apple: 'Apple Music', youtube: 'YouTube Music', spotify: 'Spotify', local: 'Tint' };

/**
 * Likes or unlikes a song and syncs it to the song's native platform (or Tint for local tracks).
 * When unliking a track that's liked on multiple signed-in platforms, removes it across them too.
 */
export async function toggleLike(track) {
  if (!track?.id) return { liked: false, syncedTo: [] };
  const next = !isLiked(track);
  pending.set(track.id, next);
  emit();

  const synced = [];
  const tasks = [];

  try {
    if (next) {
      if (track.source === 'apple' && apple.isSignedIn()) {
        tasks.push(apple.setLiked(track, true).then(() => synced.push('Apple Music')));
      } else if (track.source === 'youtube' && youtube.isSignedIn()) {
        tasks.push(youtube.setLiked(track, true).then(() => synced.push('YouTube Music')));
      } else if (track.source === 'spotify' && spotify.isSignedIn()) {
        tasks.push(spotify.setLiked(track, true).then(() => synced.push('Spotify')));
      } else {
        if (!collection.isLiked(track)) collection.toggleLike(track);
        synced.push('Tint');
      }
    } else {
      const { local, apple: am, youtube: yt, spotify: sp } = rawSources();
      const key = songKey(track);
      const matchIn = (list) => list?.find((t) => sameTrack(t, track) || (key && songKey(t) === key));

      if (local.some((t) => sameTrack(t, track) || (key && songKey(t) === key))) {
        const hit = matchIn(local);
        if (hit) collection.removeTrack(LIKED_HREF, hit.id);
        synced.push('Tint');
      }
      if (apple.isSignedIn()) {
        const hit = track.source === 'apple' ? track : matchIn(am?.items);
        if (hit && (track.source === 'apple' || matchIn(am?.items))) {
          tasks.push(apple.setLiked(hit, false).then(() => synced.push('Apple Music')));
        }
      }
      if (youtube.isSignedIn()) {
        const hit = track.source === 'youtube' ? track : matchIn(yt?.items);
        if (hit && (track.source === 'youtube' || matchIn(yt?.items))) {
          tasks.push(youtube.setLiked(hit, false).then(() => synced.push('YouTube Music')));
        }
      }
      if (spotify.isSignedIn()) {
        const hit = track.source === 'spotify' ? track : matchIn(sp?.items);
        if (hit && (track.source === 'spotify' || matchIn(sp?.items))) {
          tasks.push(spotify.setLiked(hit, false).then(() => synced.push('Spotify')));
        }
      }
    }

    if (tasks.length) await Promise.all(tasks);
    pending.delete(track.id);
    emit();
    return { liked: next, syncedTo: synced.length ? synced : [SERVICE_LABEL[track.source] || 'Tint'] };
  } catch (e) {
    pending.delete(track.id);
    emit();
    throw e;
  }
}
