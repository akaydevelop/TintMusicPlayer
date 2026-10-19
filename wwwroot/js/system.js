// Windows' side of playback: the media panel in Quick Settings, the buttons under the taskbar
// preview, and the keyboard's media keys. The host owns all three. This tells it what is playing
// and carries out what it asks for.

import * as player from './player.js';
import { post } from './api.js';
import { artSrc, debounce } from './ui.js';

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
}, 80);

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
  report();
}
