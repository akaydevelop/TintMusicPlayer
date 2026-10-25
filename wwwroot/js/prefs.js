// Settings kept by the host (music folders, Apple Music details, appearance).

import { get, post } from './api.js';

export const prefs = {
  folders: [],
  keepDark: false,
  apple: { teamId: '', keyId: '', hasKey: false, hasToken: false, useWeb: false },
  discord: { enabled: false, appId: '' },
  youtube: false,
  youtubePlayer: 'page', // page | ytdlp
  pauseFadeMs: 150,  // how long playing and pausing fade in and out
  crossfadeMs: 800,  // how long a skipped song fades into the next
};

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function take(next) {
  Object.assign(prefs, next);
  listeners.forEach((fn) => fn());
}

export async function load() {
  take(await get('/api/settings'));
}

export async function save(changes) {
  take(await post('/api/settings', changes));
}
