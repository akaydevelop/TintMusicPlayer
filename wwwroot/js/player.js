// One queue, three engines. Local files play through an <audio> element. Apple Music songs play
// through MusicKit. YouTube songs play in the YouTube Music site's own player, kept open out of
// sight by the host, or failing that through the <audio> element once yt-dlp has found where
// their audio is. The queue lives here so every kind of song can sit in the same line.

import * as apple from './apple.js';
import * as youtube from './youtube.js';
import { toast } from './ui.js';
import { prefs } from './prefs.js';

// Two elements, so a skipped song can fade out on one while the next fades in on the other.
const players = [document.getElementById('audio'), document.createElement('audio')];
players[1].preload = 'auto';
players[0].after(players[1]);
let audio = players[0]; // the one playing the current song

export const state = {
  queue: [],
  index: -1,
  playing: false,
  loading: false,
  time: 0,
  duration: 0,
  shuffle: false,
  repeat: 'off', // off | all | one
  volume: 0.8,
  muted: false,
  error: null,
  format: null, // what a YouTube song is being played as: { codec, kbps }
};

export const current = () => state.queue[state.index] || null;

const listeners = new Set();
/** fn(kind) is called with: track, state, time, seek, queue, modes, volume. */
export const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (kind) => listeners.forEach((fn) => fn(kind));

let engine = null;        // 'local' | 'apple' | 'page' | null (nothing loaded yet)
let session = 0;          // bumps every time a different song is started
let unshuffled = null;    // the queue order from before shuffle was switched on
let failures = 0;
let appleChain = Promise.resolve();
let appleBusy = false;
let appleWired = null;

// ---- fades --------------------------------------------------------------------------------------
// Each engine sounds at Tint's volume times a gain of its own, which fades move between 0 and 1.
// The YouTube Music page does its own fading, being told how long to take (see youtube-page.js).

const level = () => (state.muted ? 0 : state.volume);
// Equal power, so two songs crossing don't dip in loudness halfway.
const curve = (gain) => Math.sin(gain * Math.PI / 2);

function fader(apply) {
  let gain = 1;
  let run = 0;
  const self = {
    apply: () => apply(level() * curve(gain)),
    /** Fades to `target` in `ms` for the whole way (part of the way takes part of the time). True once there, false if overtaken. */
    to(target, ms) {
      const my = ++run;
      const from = gain;
      const span = ms * Math.abs(target - from);
      const began = performance.now();
      return new Promise((resolve) => {
        // Worked out from the clock, so a late timer only makes the fade coarser, never longer.
        const step = () => {
          if (my !== run) return resolve(false);
          const t = span > 0 ? Math.min(1, (performance.now() - began) / span) : 1;
          gain = from + (target - from) * t;
          self.apply();
          if (t < 1) setTimeout(step, 10);
          else resolve(true);
        };
        step();
      });
    },
  };
  return self;
}

const gains = new Map(players.map((el) => [el, fader((v) => { el.volume = v; })]));
const localGain = () => gains.get(audio);
const appleGain = fader((v) => { const music = apple.instance(); if (music) music.volume = v; });

let blend = 0;       // the crossfade the song being started gets, used up by the first engine to hand over
let rise = 0;        // and how long it fades in over
let fadeIn = null;   // { my, ms }: fade the song in once it is actually sounding
let pausing = false; // a pause is fading out and hasn't reached the engine yet

/** The new song starts silent and fades in over `ms`, or at full volume when that is 0. */
function startQuiet(my, gain, ms) {
  gain.to(ms ? 0 : 1, 0);
  fadeIn = ms ? { my, ms } : null;
}

/** The engine has started sounding: carry out a fade-in waiting for that. */
function sounding(gain) {
  if (fadeIn?.my !== session) return;
  gain.to(1, fadeIn.ms);
  fadeIn = null;
}

/** Pauses MusicKit without caring whether it had anything to pause. */
function hushApple() {
  try { apple.instance()?.pause()?.catch?.(() => {}); } catch { /* nothing was playing */ }
}

/** Asks the hidden YouTube Music page to do something (see youtube-page.js for what it understands). */
const tellPage = (ask) => window.chrome?.webview?.postMessage({ to: 'youtube', ...ask });

// If this page is loaded afresh while the site's player is going, nothing would be left in charge of it.
tellPage({ do: 'stop' });

/** Stops whichever engine was playing, when a different one is about to: at once, or fading out across a skip. */
function hushOthers(next) {
  const ms = blend;
  blend = 0;
  if (engine === 'local' && ms) {
    // The song fades out on its own element, and the next one plays on the other.
    const old = audio;
    audio = players.find((el) => el !== old);
    gains.get(old).to(0, ms).then((done) => {
      if (!done || old === audio) return;
      old.pause();
      old.removeAttribute('src');
      old.load();
    });
    return;
  }
  if (engine === next) return;
  if (engine === 'apple') {
    if (ms) appleGain.to(0, ms).then((done) => { if (done && engine !== 'apple') hushApple(); });
    else hushApple();
  } else if (engine === 'page') tellPage({ do: 'stop', fade: ms });
  else if (engine === 'local') audio.pause();
}

// ---- starting songs -----------------------------------------------------------------------------

function fail(my, message, { skip = true, last = false } = {}) {
  if (my !== session || seeking === my) return;
  // Before giving up on a song, see whether the other service has it.
  const track = current();
  if (!last && track && otherService(track) && !sought.has(track)) return playElsewhere(my, track, message, { skip });
  state.loading = false;
  state.playing = false;
  state.error = message;
  emit('state');
  // Skip past a song that won't play, but don't run through the whole queue if nothing will.
  if (skip && ++failures <= 3 && state.index < state.queue.length - 1) setTimeout(() => { if (my === session) advance(false); }, 1200);
}

// ---- the same song from the other service ------------------------------------------------------

const NAMES = { apple: 'Apple Music', youtube: 'YouTube Music' };
const sought = new WeakSet(); // songs already looked for elsewhere, found or not
const told = new Set();       // which way round the person has been told about, once each
let seeking = -1;             // the session a search is running for, so a second failure report can't cut in
let appleRefusesExplicit = false;

/** Where else a streamed song could come from, if that service is set up to play. */
function otherService(track) {
  if (track.source === 'apple' && youtube.isReady()) return youtube;
  if (track.source === 'youtube' && apple.isSignedIn()) return apple;
  return null;
}

/**
 * Looks for a song that wouldn't play on the other service and plays it from there. The song
 * keeps its place, title and cover; only where its audio comes from changes, for the rest of the
 * session, so every list showing it plays it the same way.
 */
async function playElsewhere(my, track, message, options) {
  const from = track.source;
  const other = otherService(track);
  sought.add(track);
  seeking = my;
  state.loading = true;
  emit('state');

  let found = null;
  try { found = await other.findSong(track); } catch { /* that service didn't answer: same as not found */ }
  seeking = -1;
  if (my !== session) return;
  if (!found) return fail(my, `${message} It wasn't found on ${NAMES[from === 'apple' ? 'youtube' : 'apple']} either.`, { ...options, last: true });

  Object.assign(track, { source: found.source, appleId: found.appleId, youtubeId: found.youtubeId, duration: found.duration || track.duration, movedFrom: from });
  if (!told.has(from)) {
    told.add(from);
    toast(`${NAMES[from]} wouldn't play this song, so it is coming from ${NAMES[found.source]}. Others it won't play will do the same.`, { ms: 6000 });
  }
  start(state.index);
}

/** `skip`: someone moving to another song, which crossfades from one still playing. `fadeUp`: fade in as playing does. */
function start(index, { autoplay = true, skip = false, fadeUp = false } = {}) {
  const track = state.queue[index];
  if (!track) return;
  blend = skip && autoplay && engine && state.playing && !state.loading ? prefs.crossfadeMs || 0 : 0;
  rise = blend || (fadeUp && autoplay ? prefs.pauseFadeMs || 0 : 0);
  pausing = false;
  const my = ++session;
  state.index = index;
  state.time = 0;
  state.duration = track.duration || 0;
  state.loading = autoplay;
  state.playing = false;
  state.error = null;
  state.format = null;
  emit('track');
  emit('state');
  save();

  if (track.playable === false) {
    fail(my, track.reason || "This song can't be played.");
    return;
  }

  if (track.source === 'local') {
    const ms = rise;
    hushOthers('local');
    engine = 'local';
    startQuiet(my, localGain(), ms);
    audio.src = `media/${track.fileId}`;
    if (autoplay) audio.play().catch((e) => { if (e?.name !== 'AbortError') fail(my, "This file couldn't be played."); });
    return;
  }

  if (track.source === 'youtube') {
    if (usesPage(track)) startOnPage(my, track);
    else startWithDlp(my, track, autoplay);
    return;
  }

  // Once Apple has refused one explicit song this session it refuses them all, so don't ask again.
  if (track.explicit && appleRefusesExplicit && otherService(track) && !sought.has(track)) {
    hushOthers(null);
    return playElsewhere(my, track, "Apple's servers are blocking explicit songs for your account.", {});
  }

  // MusicKit sounds one song at a time, so across a skip from one of its own the last fades out first.
  const ms = rise;
  const quiet = blend && engine === 'apple' ? appleGain.to(0, blend) : null;
  hushOthers('apple');
  engine = 'apple';
  const music = apple.instance();
  if (!music) {
    fail(my, 'Connect Apple Music in Settings to play this song.');
    return;
  }
  wireApple(music);
  // MusicKit doesn't like overlapping queue changes, so quick skips are fed to it one at a time.
  appleChain = appleChain.then(async () => {
    await quiet;
    if (my !== session) return;
    startQuiet(my, appleGain, ms);
    appleBusy = true;
    try {
      await music.setQueue({ song: track.appleId, startPlaying: autoplay });
      if (my === session && !autoplay) state.loading = false;
    } catch (e) {
      fail(my, appleMessage(e));
    } finally {
      appleBusy = false;
      if (engine !== 'apple') hushApple();
    }
  });
}

// ---- YouTube songs ------------------------------------------------------------------------------

const PAGE_WAIT = 12000;      // how long the site's player gets to start a song before yt-dlp is asked instead
const notOnPage = new WeakSet(); // songs the site's player couldn't play this session
let pagePlayed = -1;          // the session whose song the site's player has got going
let pageTimer = 0;
// The site plays at the quality set in the account. Tint sets that to High, but a page that was
// already loading can miss the change, so one that plays below it is loaded afresh once, between songs.
const HIGH_KBPS = 200;
let reloadPage = false;
let reloadedPage = false;

/** The site's own player is used when Tint is signed in to Google (signed out, the site plays adverts). */
const usesPage = (track) => prefs.youtubePlayer !== 'ytdlp' && youtube.isSignedIn() && !!window.chrome?.webview && !notOnPage.has(track);

function startOnPage(my, track) {
  const ms = rise;
  hushOthers('page');
  engine = 'page';
  clearTimeout(pageTimer);
  const again = reloadPage;
  reloadPage = false;
  youtube.openPage({ again }).then((open) => {
    if (my !== session) return;
    if (!open) return leavePage(my, track);
    tellPage({ do: 'volume', level: state.muted ? 0 : state.volume });
    tellPage({ do: 'load', id: track.youtubeId, fade: ms });
    pageTimer = setTimeout(() => { if (pagePlayed !== my) leavePage(my, track); }, PAGE_WAIT);
  });
}

/** The site's player didn't manage this song, so it is fetched the slower way. */
function leavePage(my, track) {
  if (my !== session || engine !== 'page') return;
  notOnPage.add(track);
  youtube.forgetPage(); // in case the page itself has gone, the next song opens it afresh
  startWithDlp(my, track, true);
}

window.chrome?.webview?.addEventListener('message', ({ data }) => {
  const track = current();
  if (!data || typeof data !== 'object' || engine !== 'page' || track?.source !== 'youtube' || data.id !== track.youtubeId) return;
  if (data.is === 'ended') return finished();
  if (data.is === 'error') return leavePage(session, track);
  if (data.is !== 'state') return;

  if (data.state === 'playing' && pagePlayed !== session) {
    pagePlayed = session;
    failures = 0;
  }
  // Until the song has started, the player's own "paused" is only it getting ready.
  const playing = data.state === 'playing';
  const loading = data.state === 'loading' || (data.state === 'paused' && pagePlayed !== session);
  const format = data.format || state.format;
  if (data.format && data.format.kbps < HIGH_KBPS && !reloadedPage) reloadPage = reloadedPage = true;
  const changed = playing !== state.playing || loading !== state.loading || format?.kbps !== state.format?.kbps || format?.codec !== state.format?.codec;
  state.playing = playing;
  state.loading = loading;
  state.format = format;
  if (playing) state.error = null;
  if (data.duration > 0) state.duration = data.duration;
  state.time = Number(data.time) || 0;
  if (changed) emit('state');
  emit('time');
});

function startWithDlp(my, track, autoplay) {
  const ms = rise;
  hushOthers('local');
  engine = 'local';
  startQuiet(my, localGain(), ms);
  // Finding the audio takes a few seconds. The last song mustn't carry on, or come back, meanwhile.
  audio.removeAttribute('src');
  audio.load();
  youtube.stream(track.youtubeId).then((found) => {
    if (my !== session) return;
    state.format = { codec: found.codec, kbps: found.kbps };
    audio.src = found.url;
    if (autoplay) audio.play().catch((e) => { if (e?.name !== 'AbortError') fail(my, "YouTube's audio for this song wouldn't play."); });
    else state.loading = false;
    emit('state');
    // Look the next two songs up now, so they start without the wait.
    for (const after of state.queue.slice(state.index + 1, state.index + 3)) {
      if (after?.source === 'youtube' && !usesPage(after)) youtube.stream(after.youtubeId).catch(() => {});
    }
    // When YouTube turns the connection away, trying the next song would only knock again.
  }, (e) => fail(my, e?.message || "This song couldn't be fetched from YouTube.", { skip: !e?.refused }));
}

function appleMessage(e) {
  const text = e?.message || e?.errorCode || String(e);
  if (e?.errorCode === 'CONTENT_RESTRICTED') {
    // Two separate locks give this same error: the player's own switch, and Apple's account setting.
    if (apple.explicitAllowed()) appleRefusesExplicit = true;
    return apple.explicitAllowed()
      ? "Apple's servers are blocking explicit songs for your account. Settings, under Apple Music, lists what to try."
      : 'Explicit songs are switched off. You can allow them in Settings, under Apple Music.';
  }
  if (/CONTENT_UNAVAILABLE/i.test(e?.errorCode || text)) return "This song isn't available in your region.";
  if (/AUTHORIZATION|SUBSCRIPTION|TOKEN/i.test(text)) return 'Apple Music needs you to sign in again (Settings).';
  if (/NETWORK/i.test(text)) return "Can't reach Apple Music. Check your internet connection.";
  return `Apple Music couldn't play this song (${text}).`;
}

function wireApple(music) {
  if (appleWired === music) return;
  appleWired = music;
  const S = window.MusicKit.PlaybackStates;
  appleGain.apply();

  music.addEventListener('playbackStateDidChange', ({ state: s }) => {
    if (engine !== 'apple') return;
    if (s === S.ended || s === S.completed) {
      if (!appleBusy) finished();
      return;
    }
    if (pausing) return; // still sounding while it fades, but as far as anyone can tell it has paused
    state.playing = s === S.playing;
    state.loading = s === S.loading || s === S.waiting || s === S.stalled || s === S.seeking;
    if (state.playing) { failures = 0; state.error = null; sounding(appleGain); }
    emit('state');
  });

  music.addEventListener('playbackTimeDidChange', () => {
    if (engine !== 'apple') return;
    state.time = music.currentPlaybackTime || 0;
    state.duration = music.currentPlaybackDuration || state.duration;
    emit('time');
  });

  music.addEventListener('mediaPlaybackError', (e) => {
    if (engine === 'apple') fail(session, appleMessage(e));
  });
}

// ---- local engine events ------------------------------------------------------------------------

/** Listens to both elements, but only hears from the one playing the current song. */
const onAudio = (name, fn) => players.forEach((el) => el.addEventListener(name, () => { if (el === audio && engine === 'local') fn(); }));

onAudio('playing', () => {
  failures = 0;
  state.playing = true; state.loading = false; state.error = null;
  sounding(localGain());
  emit('state');
});
onAudio('pause', () => {
  if (audio.ended) return;
  state.playing = false;
  emit('state');
});
onAudio('waiting', () => {
  state.loading = true;
  emit('state');
});
onAudio('timeupdate', () => {
  state.time = audio.currentTime;
  emit('time');
});
onAudio('durationchange', () => {
  if (!Number.isFinite(audio.duration)) return;
  state.duration = audio.duration;
  emit('time');
});
onAudio('ended', () => finished());
onAudio('error', () => {
  if (!audio.getAttribute('src')) return;
  if (current()?.source === 'youtube') refetch();
  else fail(session, "This file couldn't be played. It may have moved, or be in a format Windows can't decode.");
});

let refetched = -1;

/** A YouTube address stops working after a few hours. Get a new one, once, and pick up where it was. */
function refetch() {
  const my = session;
  if (refetched === my) return fail(my, "YouTube's audio for this song wouldn't play.");
  refetched = my;
  const at = state.time;
  const resume = state.playing || state.loading;
  state.loading = resume;
  emit('state');
  youtube.stream(current().youtubeId, { fresh: true }).then((found) => {
    if (my !== session) return;
    state.format = { codec: found.codec, kbps: found.kbps };
    audio.src = found.url;
    audio.currentTime = at;
    if (resume) audio.play().catch(() => {});
    else state.loading = false;
    emit('state');
  }, (e) => fail(my, e?.message || "This song couldn't be fetched from YouTube."));
}

// ---- moving through the queue -------------------------------------------------------------------

let finishedSession = -1;

/** The current song reached its end on its own. */
function finished() {
  if (finishedSession === session) return;
  finishedSession = session;
  advance(true);
}

function advance(auto) {
  if (auto && state.repeat === 'one') return start(state.index);
  let next = state.index + 1;
  if (next >= state.queue.length) {
    if (state.repeat !== 'all' || !state.queue.length) {
      if (auto) {
        state.playing = false;
        state.loading = false;
        state.time = 0;
        emit('state');
        emit('time');
      }
      return;
    }
    next = 0;
  }
  start(next, { skip: !auto });
}

export const next = () => advance(false);

export function prev() {
  if (state.time > 3 || state.index <= 0) return seek(0);
  start(state.index - 1, { skip: true });
}

export function toggle() {
  const track = current();
  if (!track) return;
  if (!engine || state.error) return start(state.index, { fadeUp: true });
  const ms = prefs.pauseFadeMs || 0;
  if (engine === 'page') return tellPage({ do: state.playing || state.loading ? 'pause' : 'play', fade: ms });

  const music = apple.instance();
  if (engine === 'apple' && !music) return;
  const local = engine === 'local';
  const gain = local ? localGain() : appleGain;
  if (local ? !audio.paused && !pausing : state.playing) {
    // Shown as paused straight away; the engine itself is paused once the fade is over.
    const my = session;
    pausing = true;
    state.playing = false;
    emit('state');
    gain.to(0, ms).then((done) => {
      if (!done || my !== session || !pausing) return;
      pausing = false;
      if (local) audio.pause();
      else music.pause()?.catch?.(() => {});
    });
  } else if (pausing) {
    // Played again before the pause took hold: it never stopped, so it only needs to come back up.
    pausing = false;
    state.playing = true;
    emit('state');
    gain.to(1, ms);
  } else {
    startQuiet(session, gain, ms);
    if (local) audio.play().catch(() => {});
    else music.play()?.catch?.((e) => fail(session, appleMessage(e)));
  }
}

export function seek(seconds) {
  seconds = Math.max(0, Math.min(seconds, Math.max(0, state.duration - 0.25)));
  if (engine === 'local') audio.currentTime = seconds;
  else if (engine === 'page') tellPage({ do: 'seek', at: seconds });
  else if (engine === 'apple') apple.instance()?.seekToTime(seconds)?.catch?.(() => {});
  state.time = seconds;
  emit('time');
  emit('seek');
}

export function jumpTo(index) {
  if (index >= 0 && index < state.queue.length) start(index, { skip: true });
}

// ---- building the queue -------------------------------------------------------------------------

function shuffled(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Replaces the queue with `tracks` and plays from `startIndex`. */
export function playList(tracks, startIndex = 0, { shuffle = null } = {}) {
  const wanted = tracks[startIndex];
  tracks = tracks.filter((t) => t.playable !== false || t === wanted);
  if (!tracks.length) return;
  if (shuffle !== null && shuffle !== state.shuffle) {
    state.shuffle = shuffle;
    emit('modes');
  }
  const first = wanted || tracks[0];
  failures = 0;
  if (state.shuffle) {
    unshuffled = tracks.slice();
    const rest = tracks.filter((t) => t !== first);
    const lead = shuffle === true ? shuffled(tracks) : [first, ...shuffled(rest)];
    state.queue = lead;
    emit('queue');
    start(0, { skip: true });
  } else {
    unshuffled = null;
    state.queue = tracks.slice();
    emit('queue');
    start(tracks.indexOf(first), { skip: true });
  }
}

export function playNext(tracks) {
  tracks = tracks.filter((t) => t.playable !== false);
  if (!tracks.length) return;
  if (!state.queue.length) return playList(tracks, 0);
  state.queue.splice(state.index + 1, 0, ...tracks);
  unshuffled?.push(...tracks);
  emit('queue');
  save();
}

export function addToQueue(tracks) {
  tracks = tracks.filter((t) => t.playable !== false);
  if (!tracks.length) return;
  if (!state.queue.length) return playList(tracks, 0);
  state.queue.push(...tracks);
  unshuffled?.push(...tracks);
  emit('queue');
  save();
}

export function removeAt(index) {
  if (index === state.index || index < 0 || index >= state.queue.length) return;
  const [gone] = state.queue.splice(index, 1);
  if (unshuffled) {
    const at = unshuffled.indexOf(gone);
    if (at >= 0) unshuffled.splice(at, 1);
  }
  if (index < state.index) state.index--;
  emit('queue');
  save();
}

/** Drops everything waiting after the current song. */
export function clearUpcoming() {
  const kept = state.queue.slice(0, state.index + 1);
  if (unshuffled) unshuffled = unshuffled.filter((t) => kept.includes(t));
  state.queue = kept;
  emit('queue');
  save();
}

export function setShuffle(on) {
  if (on === state.shuffle) return;
  state.shuffle = on;
  const now = current();
  if (now) {
    if (on) {
      unshuffled = state.queue.slice();
      state.queue = [...state.queue.slice(0, state.index + 1), ...shuffled(state.queue.slice(state.index + 1))];
    } else if (unshuffled) {
      state.queue = unshuffled;
      state.index = Math.max(0, state.queue.indexOf(now));
      unshuffled = null;
    }
    emit('queue');
  }
  emit('modes');
  save();
}

export function cycleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  emit('modes');
  save();
}

export function setVolume(volume, { muted = false } = {}) {
  state.volume = Math.max(0, Math.min(1, volume));
  state.muted = muted;
  for (const gain of gains.values()) gain.apply();
  appleGain.apply();
  if (engine === 'page') tellPage({ do: 'volume', level: level() });
  emit('volume');
  save();
}

// ---- window title -------------------------------------------------------------------------------

on((kind) => {
  if (kind === 'track' || kind === 'state') {
    const track = current();
    document.title = track && state.playing ? `${track.title} – ${track.artist}` : 'Tint';
  }
});

// ---- remembering between launches ---------------------------------------------------------------

const STORE = 'tint.player';
let saveTimer = 0;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Keep the saved queue to a sensible size around the current song.
    const from = Math.max(0, state.index - 50);
    const queue = state.queue.slice(from, from + 500).map(({ haystack, ...rest }) => rest);
    try {
      localStorage.setItem(STORE, JSON.stringify({
        queue, index: state.index - from, shuffle: state.shuffle, repeat: state.repeat, volume: state.volume, muted: state.muted,
      }));
    } catch { /* storage full or unavailable: nothing to remember this time */ }
  }, 400);
}

/** Brings back the last queue, paused on the song that was current. */
export function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved) {
      state.shuffle = !!saved.shuffle;
      state.repeat = ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'off';
      state.volume = typeof saved.volume === 'number' ? saved.volume : 0.8;
      state.muted = !!saved.muted;
      if (Array.isArray(saved.queue) && saved.queue.length) {
        state.queue = saved.queue;
        state.index = Math.max(0, Math.min(saved.index ?? 0, saved.queue.length - 1));
        state.duration = current()?.duration || 0;
      }
    }
  } catch { /* a damaged save is just ignored */ }
  for (const gain of gains.values()) gain.apply();
  emit('queue'); emit('track'); emit('modes'); emit('volume'); emit('state');
}
