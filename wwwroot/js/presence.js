// Tells the host what is playing so it can show it on Discord ("Listening to ...").
// The host owns the Discord connection; this only reports changes worth showing.

import * as player from './player.js';
import { prefs, onChange as onPrefs } from './prefs.js';
import { post } from './api.js';
import { artSrc, debounce } from './ui.js';

let sent = null; // what the host was last told: { id, startedAt } or 'nothing'

const report = debounce(() => {
  if (!prefs.discord?.enabled) {
    sent = null;
    return;
  }

  const track = player.current();
  if (!track || !player.state.playing) {
    if (sent !== 'nothing') post('/api/presence', { playing: false }).catch(() => {});
    sent = 'nothing';
    return;
  }

  // Discord draws its own progress bar from a start time, so an update is only needed when the
  // song changes or playback jumps (a seek, or a pause that shifted everything later).
  const position = player.state.time || 0;
  const startedAt = Date.now() - position * 1000;
  if (sent && sent !== 'nothing' && sent.id === track.id && Math.abs(sent.startedAt - startedAt) < 2000) return;
  sent = { id: track.id, startedAt };

  post('/api/presence', {
    playing: true,
    title: track.title,
    artist: track.artist || '',
    album: track.album || '',
    duration: player.state.duration || track.duration || 0,
    position,
    // Apple Music and YouTube covers are public addresses Discord can load. Covers of files on
    // this PC are not, so the host looks those up by album name instead.
    art: track.art?.url ? artSrc(track.art, 256) : null,
  }).catch(() => {});
}, 250);

export function initPresence() {
  player.on((kind) => { if (kind === 'track' || kind === 'state' || kind === 'seek') report(); });
  onPrefs(() => { sent = null; report(); });
}
