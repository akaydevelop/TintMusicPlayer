// An artist's profile, put together across Apple Music, Spotify, and YouTube Music.
// Cross-platform matches are ALWAYS verified against overlapping songs or releases so two artists
// who share a name (e.g. Japanese J-pop "Eve" vs. American rapper "Eve") are never mixed together.

import * as apple from './apple.js';
import * as youtube from './youtube.js';
import * as spotify from './spotify.js';
import { local, compareText } from './library.js';

const profiles = new Map();

/** `ref` is { apple }, { youtube }, { spotify } (an artist id there) or { name } (an artist on this PC). */
export async function profile(ref) {
  // Opened as Tint starts, the page waits for Apple Music rather than make do without it.
  await apple.settled();
  const on = { apple: !!apple.instance(), youtube: youtube.isReady(), spotify: spotify.isSignedIn() };
  const key = JSON.stringify([ref, on]);
  if (!profiles.has(key)) {
    if (profiles.size >= 20) profiles.delete(profiles.keys().next().value);
    const made = build(ref, on);
    made.catch(() => profiles.delete(key));
    profiles.set(key, made);
  }
  return profiles.get(key);
}

// A miss on another service, or that service being off or offline, still leaves a page to show.
const quietly = (promise) => promise.catch(() => null);

/** Normalizes a song or album title for cross-platform identity verification. */
function normTitle(text) {
  return String(text || '').toLowerCase()
    .replace(/\s*[\(\[](?:feat\.?|ft\.?|with|remaster(?:ed)?|live|version|radio edit|deluxe|bonus|single|ep)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*-\s*(?:ep|single|deluxe.*|remaster.*)$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Collects normalized song + release titles from an artist profile (or local tracks/albums). */
function catalogOf(p) {
  const out = new Set();
  if (!p) return out;
  for (const s of p.songs || []) {
    const n = normTitle(s?.title);
    if (n.length >= 2) out.add(n);
    const en = normTitle(s?.englishTitle);
    if (en.length >= 2) out.add(en);
    const alb = normTitle(s?.album);
    if (alb.length >= 2) out.add(alb);
  }
  for (const list of [p.albums, p.eps, p.singles, p.live, p.compilations]) {
    for (const item of list || []) {
      const n = normTitle(item?.title);
      if (n.length >= 2) out.add(n);
    }
  }
  for (const shelf of p.shelves || []) {
    for (const item of shelf.items || []) {
      if (item?.href?.includes('#/album/')) {
        const n = normTitle(item.title);
        if (n.length >= 2) out.add(n);
      }
    }
  }
  return out;
}

/** Returns true if `candidate` shares at least one song or album title with `anchor` (or anchor has no catalog). */
function verifiedMatch(anchorTitles, candidate) {
  if (!candidate) return false;
  if (!anchorTitles.size) return true;
  const candTitles = catalogOf(candidate);
  if (!candTitles.size) return false;
  for (const t of candTitles) {
    if (anchorTitles.has(t)) return true;
  }
  return false;
}

/**
 * Resolves the same artist on another service:
 * 1) First via the primary artist's songs (pinpoints the exact artist even for shared names like "Eve").
 * 2) Otherwise checks same-name candidates one by one, accepting ONLY one whose catalog overlaps.
 */
async function resolveVerified({ name, seedSongs, anchorTitles, findSong, artistOfSong, findArtists, loadProfile }) {
  // 1. Song-anchored lookup first (handles Japanese vs. English artists with identical names).
  if (seedSongs?.length) {
    const viaId = await quietly(viaSongs(seedSongs, findSong, artistOfSong));
    if (viaId) {
      const loaded = await quietly(loadProfile(viaId));
      if (loaded && verifiedMatch(anchorTitles, loaded)) return loaded;
    }
  }
  // 2. Fallback: check up to 3 same-name artist candidates and verify catalog overlap.
  const first = name.split(/\s*(?:,|&|\bfeat\.?|\bft\.|\bwith\b|×)\s*/i)[0].trim();
  const ids = [
    ...(await quietly(findArtists(name)) || []),
    ...(first && first !== name ? (await quietly(findArtists(first)) || []) : []),
  ].filter((id, i, arr) => id && arr.indexOf(id) === i).slice(0, 3);

  for (const id of ids) {
    const loaded = await quietly(loadProfile(id));
    if (loaded && verifiedMatch(anchorTitles, loaded)) return loaded;
  }
  return null;
}

async function build(ref, { apple: appleOn, youtube: youtubeOn, spotify: spotifyOn }) {
  let [fromApple, fromYouTube, fromSpotify] = await Promise.all([
    ref.apple && appleOn ? apple.artistProfile(ref.apple) : null,
    ref.youtube && youtubeOn ? youtube.artist(ref.youtube) : null,
    ref.spotify && spotifyOn ? spotify.artist(ref.spotify) : null,
  ]);
  const primary = fromApple || fromSpotify || fromYouTube || null;
  const name = primary?.title || ref.name || '';
  if (!name) throw new Error(ref.apple ? 'Apple Music is not set up yet.' : ref.spotify ? 'Sign in to Spotify in Settings first.' : 'YouTube Music is off. Switch it on in Settings.');

  // Local catalog for this artist name also helps verify identity when opened from a PC track.
  const localMine = (text) => compareText(text, name) === 0;
  const localAnchor = {
    songs: local.tracks.filter((t) => localMine(t.artist) || localMine(t.albumArtist)),
    albums: local.albums.filter((a) => localMine(a.artist)),
  };
  const anchorTitles = new Set([...catalogOf(primary), ...catalogOf(localAnchor)]);
  const seedSongs = primary?.songs?.length ? primary.songs : localAnchor.songs;

  // Enrich with secondary services in parallel, strictly verifying catalog identity!
  const [resolvedApple, resolvedYouTube, resolvedSpotify] = await Promise.all([
    !fromApple && appleOn && name ? resolveVerified({
      name, seedSongs, anchorTitles,
      findSong: apple.findSong, artistOfSong: apple.artistOfSong,
      findArtists: apple.findArtists, loadProfile: apple.artistProfile,
    }) : null,
    !fromYouTube && youtubeOn && name ? resolveVerified({
      name, seedSongs, anchorTitles,
      findSong: youtube.findSong, artistOfSong: async (song) => song.artistId,
      findArtists: youtube.findArtists, loadProfile: youtube.artist,
    }) : null,
    !fromSpotify && spotifyOn && name ? resolveVerified({
      name, seedSongs, anchorTitles,
      findSong: spotify.findSong, artistOfSong: async (song) => song.artistId,
      findArtists: spotify.findArtists, loadProfile: spotify.artist,
    }) : null,
  ]);

  fromApple ||= resolvedApple;
  fromYouTube ||= resolvedYouTube;
  fromSpotify ||= resolvedSpotify;

  // YouTube's shelves, when Apple Music can't give the discography: releases, then similar artists.
  const shelves = fromYouTube?.shelves || [];
  const releases = shelves.filter((s) => s.items.every((item) => item.href.includes('#/album/')));
  const similar = shelves.find((s) => s.items.every((item) => item.href.includes('#/artist/')))?.items || [];

  const names = [name, fromApple?.title, fromSpotify?.title, fromYouTube?.title, ref.name].filter(Boolean);
  const mine = (text) => names.some((n) => compareText(text, n) === 0);

  // Prefer the service the artist page was opened from when picking top songs and discography.
  const preferSpotify = !!ref.spotify && !!fromSpotify;
  const preferYouTube = !!ref.youtube && !!fromYouTube;
  const songs = preferSpotify && fromSpotify.songs.length ? fromSpotify.songs
    : preferYouTube && fromYouTube.songs.length ? fromYouTube.songs
      : fromApple?.songs.length ? fromApple.songs
        : fromSpotify?.songs.length ? fromSpotify.songs
          : fromYouTube?.songs || [];
  const sections = preferSpotify
    ? [['Albums', fromSpotify.albums], ['Singles & EPs', fromSpotify.singles]]
    : fromApple
      ? [['Albums', fromApple.albums], ['EPs', fromApple.eps], ['Singles', fromApple.singles],
        ['Live albums', fromApple.live], ['Compilations', fromApple.compilations]]
      : fromSpotify
        ? [['Albums', fromSpotify.albums], ['Singles & EPs', fromSpotify.singles]]
        : releases.map((s) => [s.title, s.items]);

  return {
    // Found by the first of several names ("A & B"), the page is that artist's.
    name: primary?.title || fromApple?.title || fromSpotify?.title || fromYouTube?.title || name,
    art: primary?.art || fromApple?.art || fromSpotify?.art || fromYouTube?.art || null,
    genres: fromApple?.genres?.length ? fromApple.genres : fromSpotify?.genres || [],
    about: fromYouTube?.about || '',
    aboutFrom: fromYouTube?.aboutFrom || null,
    audience: fromYouTube?.audience || '',
    subscribers: fromYouTube?.subscribers || '',
    songs,
    sections,
    similar: fromApple?.similar?.length ? fromApple.similar : similar,
    local: {
      albums: local.albums.filter((a) => mine(a.artist)),
      songs: local.tracks.filter((t) => mine(t.artist) || mine(t.albumArtist)),
    },
    from: { apple: !!fromApple, youtube: !!fromYouTube, spotify: !!fromSpotify },
  };
}

/** Where an artist page for the singer of `track` is. Songs from YouTube Music and Spotify know their artist's page. */
export const artistHref = (track) => {
  if (track.artistId && track.source === 'spotify') return `#/artist/s/${encodeURIComponent(track.artistId)}`;
  if (track.artistId) return `#/artist/y/${encodeURIComponent(track.artistId)}`;
  return `#/artist/l/${encodeURIComponent(track.albumArtist || track.artist)}`;
};

/**
 * The artist who sings `songs` on the other service. A song can be credited to a guest first, so
 * two of the top three agreeing wins, or the first confident match when only one is available.
 */
async function viaSongs(songs, find, artistOf) {
  const tried = (songs || []).slice(0, 4);
  const ids = await Promise.all(tried.map(async (song) => {
    const found = await quietly(find(song));
    return found ? quietly(artistOf(found)) : null;
  }));
  const counts = new Map();
  for (const id of ids.filter(Boolean)) counts.set(id, (counts.get(id) || 0) + 1);
  const [best, times] = [...counts].sort((a, b) => b[1] - a[1])[0] || [];
  return best && (times >= 2 || counts.size === 1) ? best : null;
}
