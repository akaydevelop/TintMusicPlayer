// Copies of the playlist and album pages opened lately, kept by the host (PageCache.cs), so a page
// opened again shows at once while the service is asked for anything new. Settings can empty it,
// and copies not opened or played from for a while are forgotten on their own.

import { get, post } from './api.js';

const key = (href) => encodeURIComponent(href);

// This run's copies, so going back and forth between pages doesn't even ask the host.
const memory = new Map();

/** The copy kept for a page (by its address), or null. Reading it counts as using it. */
export async function read(href) {
  if (memory.has(href)) {
    post(`/api/cache/touch?key=${key(href)}`).catch(() => {});
    return memory.get(href);
  }
  try {
    const kept = await get(`/api/cache?key=${key(href)}`);
    if (!kept || kept.missing) return null;
    memory.set(href, kept);
    return kept;
  } catch {
    return null;
  }
}

/** Keeps the copy of a page as it is now. */
export function keep(href, page) {
  memory.set(href, page);
  post(`/api/cache?key=${key(href)}`, page).catch(() => {});
}

/** Something was played from a page, which keeps its copy from being forgotten. */
export function used(href) {
  if (href) post(`/api/cache/touch?key=${key(href)}`).catch(() => {});
}

export const size = () => get('/api/cache/size');

export async function clear() {
  memory.clear();
  return post('/api/cache/clear');
}
