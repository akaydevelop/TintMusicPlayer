// An artist's profile, put together from both services. Apple Music gives the photo, the genres,
// the top songs and the discography (albums, EPs and singles apart, which YouTube Music lumps
// together); YouTube Music gives the "About" text and how many people listen. Whichever service
// the page was opened from, the artist is looked up on the other one: by the same name, or failing
// that (a name written in another script, say) through who sings the same top songs there.

import * as apple from './apple.js';
import * as youtube from './youtube.js';
import { local, compareText } from './library.js';

const profiles = new Map();

/** `ref` is { apple } or { youtube } (an artist id there) or { name } (an artist on this PC). */
export async function profile(ref) {
  // Opened as Tint starts, the page waits for Apple Music rather than make do without it.
  await apple.settled();
  const on = { apple: !!apple.instance(), youtube: youtube.isReady() };
  const key = JSON.stringify([ref, on]);
  if (!profiles.has(key)) {
    if (profiles.size >= 20) profiles.delete(profiles.keys().next().value);
    const made = build(ref, on);
    made.catch(() => profiles.delete(key));
    profiles.set(key, made);
  }
  return profiles.get(key);
}

// A miss on the other service, or that service being off or offline, still leaves a page to show.
const quietly = (promise) => promise.catch(() => null);

async function build(ref, { apple: appleOn, youtube: youtubeOn }) {

  let [fromApple, fromYouTube] = await Promise.all([
    ref.apple && appleOn ? apple.artistProfile(ref.apple) : null,
    ref.youtube && youtubeOn ? youtube.artist(ref.youtube) : null,
  ]);
  const name = fromApple?.title || fromYouTube?.title || ref.name || '';
  if (!name) throw new Error(ref.apple ? 'Apple Music is not set up yet.' : 'YouTube Music is off. Switch it on in Settings.');

  if (!fromApple && appleOn && name) {
    const id = await quietly((async () => (await byName(name, apple.findArtist))
      ?? (await viaSongs(fromYouTube?.songs, apple.findSong, apple.artistOfSong)))());
    if (id) fromApple = await quietly(apple.artistProfile(id));
  }
  if (!fromYouTube && youtubeOn && name) {
    const id = await quietly((async () => (await byName(name, youtube.findArtist))
      ?? (await viaSongs(fromApple?.songs, youtube.findSong, async (song) => song.artistId)))());
    if (id) fromYouTube = await quietly(youtube.artist(id));
  }

  // YouTube's shelves, when Apple Music can't give the discography: releases, then similar artists.
  const shelves = fromYouTube?.shelves || [];
  const releases = shelves.filter((s) => s.items.every((item) => item.href.includes('#/album/')));
  const similar = shelves.find((s) => s.items.every((item) => item.href.includes('#/artist/')))?.items || [];

  const names = [name, fromApple?.title, fromYouTube?.title, ref.name].filter(Boolean);
  const mine = (text) => names.some((n) => compareText(text, n) === 0);

  return {
    // Found by the first of several names ("A & B"), the page is that artist's.
    name: fromApple?.title || fromYouTube?.title || name,
    art: fromApple?.art || fromYouTube?.art || null,
    genres: fromApple?.genres || [],
    about: fromYouTube?.about || '',
    aboutFrom: fromYouTube?.aboutFrom || null,
    audience: fromYouTube?.audience || '',
    subscribers: fromYouTube?.subscribers || '',
    songs: fromApple?.songs.length ? fromApple.songs : fromYouTube?.songs || [],
    sections: fromApple
      ? [['Albums', fromApple.albums], ['EPs', fromApple.eps], ['Singles', fromApple.singles],
        ['Live albums', fromApple.live], ['Compilations', fromApple.compilations]]
      : releases.map((s) => [s.title, s.items]),
    similar: fromApple?.similar.length ? fromApple.similar : similar,
    local: {
      albums: local.albums.filter((a) => mine(a.artist)),
      songs: local.tracks.filter((t) => mine(t.artist) || mine(t.albumArtist)),
    },
    from: { apple: !!fromApple, youtube: !!fromYouTube },
  };
}

/** Where an artist page for the singer of `track` is. A song from YouTube Music knows its artist's page. */
export const artistHref = (track) => (track.artistId
  ? `#/artist/y/${encodeURIComponent(track.artistId)}`
  : `#/artist/l/${encodeURIComponent(track.albumArtist || track.artist)}`);

/** A song's artist is often several ("A, B", "A feat. B"). The whole name first, then the first of them. */
async function byName(name, find) {
  const first = name.split(/\s*(?:,|&|\bfeat\.?|\bft\.|\bwith\b|×)\s*/i)[0].trim();
  return (await find(name)) ?? (first && first !== name ? find(first) : null);
}

/**
 * The artist who sings `songs` on the other service. A song can be credited to a guest first, so
 * two of the top three have to agree (or the only one there is).
 */
async function viaSongs(songs, find, artistOf) {
  const tried = (songs || []).slice(0, 3);
  const ids = await Promise.all(tried.map(async (song) => {
    const found = await quietly(find(song));
    return found ? quietly(artistOf(found)) : null;
  }));
  const counts = new Map();
  for (const id of ids.filter(Boolean)) counts.set(id, (counts.get(id) || 0) + 1);
  const [best, times] = [...counts].sort((a, b) => b[1] - a[1])[0] || [];
  return best && (times >= 2 || tried.length === 1) ? best : null;
}
