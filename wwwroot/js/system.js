// The system's side of playback: on Windows, the media panel in Quick Settings, the buttons under
// the taskbar preview, and the keyboard's media keys, all owned by the host, which this tells what
// is playing and takes commands from. In a browser app window (the Linux build) the browser owns
// them instead (MPRIS on Linux), fed from the page's Media Session, which this keeps up to date.

import * as player from './player.js';
import { post } from './api.js';
import { artSrc, debounce } from './ui.js';

// Set by host-bridge.js, which only the browser-hosted build puts into the page.
const session = window.tintBrowserHost && 'mediaSession' in navigator ? claim(navigator.mediaSession) : null;

/**
 * MusicKit fills in the Media Session for the one song it is given, and would take the media keys
 * with it. Tint owns the queue, so from here on only this file's calls reach the real session.
 */
function claim(real) {
  const proto = Object.getPrototypeOf(real);
  const field = (name) => Object.getOwnPropertyDescriptor(proto, name);
  const metadata = field('metadata'), playbackState = field('playbackState');
  const setHandler = real.setActionHandler.bind(real), setPosition = real.setPositionState.bind(real);
  Object.defineProperty(real, 'metadata', { get: () => metadata.get.call(real), set: () => {} });
  Object.defineProperty(real, 'playbackState', { get: () => playbackState.get.call(real), set: () => {} });
  real.setActionHandler = () => {};
  real.setPositionState = () => {};
  return {
    set metadata(value) { metadata.set.call(real, value); },
    set playbackState(value) { playbackState.set.call(real, value); },
    setActionHandler: setHandler,
    setPositionState: (...state) => setPosition(...state),
  };
}

const report = debounce(() => {
  const track = player.current();
  const { playing, loading } = player.state;
  post('/api/system', {
    at: Date.now(),
    title: track?.title || '',
    artist: track?.artist || '',
    album: track?.album || '',
    artKey: track?.art?.key || null,
    artUrl: track?.art?.url ? artSrc(track.art, 320) : null,
    // The gap while the next song loads still counts as playing, so the buttons don't flicker.
    playing: playing || loading,
  }).catch(() => {});
  if (session) describe(track, playing || loading);
}, 80);

/** What the browser shows for the song: in its own media controls, and through them the system's. */
function describe(track, playing) {
  const art = track?.art ? artSrc(track.art, 320) : null;
  // A full address: the browser fetches the picture itself, as this page would.
  const artwork = art ? [{ src: new URL(art, location.href).href, sizes: '320x320', type: 'image/jpeg' }] : [];
  session.metadata = track ? new MediaMetadata({ title: track.title || '', artist: track.artist || '', album: track.album || '', artwork }) : null;
  session.playbackState = !track ? 'none' : playing ? 'playing' : 'paused';
  place();

  // A YouTube song plays in the hidden YouTube Music page, so that is the page the browser
  // reports as playing. It is told the same, and passes the media keys back (youtube-page.js).
  // Only a public address is of use to it for the cover.
  window.chrome.webview.postMessage({
    to: 'youtube', do: 'session', playing,
    title: track?.title || '', artist: track?.artist || '', album: track?.album || '',
    art: track?.art?.url ? art : null,
  });
}

/** Where in the song playback is, for the system's seek bar. */
function place() {
  const { duration, time } = player.state;
  try {
    if (duration > 0) session.setPositionState({ duration, position: Math.min(Math.max(time, 0), duration), playbackRate: 1 });
    else session.setPositionState();
  } catch { /* a moment where the time is past a duration not yet updated */ }
}

const commands = {
  play: () => { if (!player.state.playing && !player.state.loading) player.toggle(); },
  pause: () => { if (player.state.playing) player.toggle(); },
  toggle: player.toggle,
  next: player.next,
  previous: player.prev,
};

export function initSystem() {
  player.on((kind) => { if (kind === 'track' || kind === 'state') report(); });
  window.chrome?.webview?.addEventListener('message', (e) => commands[e.data]?.());
  if (session) {
    session.setActionHandler('play', commands.play);
    session.setActionHandler('pause', commands.pause);
    session.setActionHandler('nexttrack', commands.next);
    session.setActionHandler('previoustrack', commands.previous);
    session.setActionHandler('seekto', (details) => player.seek(details.seekTime));
    // A seek moves the bar at once; between seeks it runs on from where it was last placed.
    player.on((kind) => { if (kind === 'seek') place(); });
  }
  report();
}
