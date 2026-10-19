// Tells the person when a newer Tint is out, downloads it when they say so, and restarts into it.
// The host does the work (Updater.cs); this only shows where it is.

import { $, h, fill, toast } from './ui.js';
import { get, post } from './api.js';

const LOOK_EVERY = 6 * 3600e3;

let status = null;
let polling = null;
// "Later" puts the notice away for that version until Tint is next started. Settings still shows it.
let putAway = null;
const listeners = new Set();

export const getStatus = () => status;
export const onChange = (fn) => listeners.add(fn);

function set(next) {
  if (!next) return;
  status = next;
  if (status.state === 'downloading') poll();
  drawNotice();
  for (const fn of listeners) fn();
}

function poll() {
  polling ??= setInterval(async () => {
    const next = await get('/api/update').catch(() => null);
    if (next && next.state !== 'downloading') {
      clearInterval(polling);
      polling = null;
    }
    set(next);
  }, 400);
}

export async function check(force = false) {
  set(await get(`/api/update?check=1${force ? '&force=1' : ''}`).catch(() => null));
}

export async function download() {
  putAway = null;
  set(await post('/api/update/download').catch(() => null));
}

export async function restart() {
  const next = await post('/api/update/restart').catch(() => null);
  set(next);
  if (next?.state === 'failed') toast(next.error, { ms: 8000 });
}

export const openNotes = () => status?.page && post('/api/open', { url: status.page });

export function percent() {
  return status?.total ? Math.min(100, Math.floor(status.received / status.total * 100)) : 0;
}

/** What the update is doing, in words, or null when there is nothing newer. */
export function describe() {
  if (!status?.possible) return null;
  switch (status.state) {
    case 'idle': return status.latest ? `Tint ${status.latest} is out.` : null;
    case 'downloading': return `Downloading Tint ${status.latest}… ${percent()}%`;
    case 'ready': return `Tint ${status.latest} is ready. Restarting puts it in place; the music stops for a moment.`;
    case 'failed': return status.error || "The update didn't work.";
    default: return null;
  }
}

/** The buttons that go with describe(), for the notice and for Settings. */
export function actions(button) {
  switch (status?.state) {
    case 'idle': return status.latest ? [button('Update', download, 'primary')] : [];
    case 'ready': return [button('Restart now', restart, 'primary')];
    case 'failed': return status.latest ? [button('Try again', download, 'primary')] : [];
    default: return [];
  }
}

const noticeButton = (text, onclick, kind = '') => h('button', { class: 'btn ' + kind, onclick }, text);

function drawNotice() {
  const el = $('update');
  const text = describe();
  el.hidden = !text || putAway === `${status.latest}/${status.state}`;
  if (el.hidden) return;

  fill(el,
    h('p', {}, text),
    status.state === 'downloading' && h('div', { class: 'update-bar' }, h('span', { style: { width: `${percent()}%` } })),
    h('div', { class: 'update-actions' },
      ...actions(noticeButton),
      status.state !== 'downloading' && status.page && h('button', { class: 'text-btn', onclick: openNotes }, "What's new"),
      status.state !== 'downloading' && h('button', {
        class: 'text-btn',
        onclick: () => { putAway = `${status.latest}/${status.state}`; drawNotice(); },
      }, 'Later')));
}

export function init() {
  check();
  setInterval(check, LOOK_EVERY);
}
