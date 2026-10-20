// Finding the lyrics of the song playing, timed line by line where possible. Apple Music's own
// come first for a song from Apple Music; then the host asks YouTube Music (for the song's video
// there, or the same recording found by name) and LRCLIB (Lyrics.cs). Untimed lyrics are only
// kept when nobody has timed ones.

import { lyricsOf } from './apple.js';
import { linkFor, videoIn } from './youtube.js';
import { get } from './api.js';

// Song id → lookup. A lookup that failed (offline, a service busy) is forgotten and tried again.
const found = new Map();

/** `{ lines: [{ time, text }], source }` or `{ text, source }`, or null when nobody has lyrics for it. */
export function lyricsFor(track) {
  if (!found.has(track.id)) {
    if (found.size >= 50) found.delete(found.keys().next().value);
    const lookup = look(track);
    lookup.catch(() => found.delete(track.id));
    found.set(track.id, lookup);
  }
  return found.get(track.id);
}

async function look(track) {
  const ttml = await lyricsOf(track).catch(() => null);
  const apple = ttml ? readTtml(ttml) : null;
  if (apple?.lines) return apple;

  const videoId = track.youtubeId || videoIn((await linkFor(track).catch(() => null)) || '');
  const question = new URLSearchParams({
    title: track.title || '', artist: track.artist || '', album: track.album || '',
    duration: String(Math.round(track.duration || 0)),
  });
  if (videoId) question.set('youtube', videoId);
  try {
    const { found: other } = await get('/api/lyrics?' + question);
    return other?.lines || !apple ? other : apple;
  } catch (e) {
    if (apple) return apple;
    throw new Error("The lyrics services didn't answer. Try again in a moment.");
  }
}

// ---- Apple's TTML -------------------------------------------------------------------------------

/** "62.5", "1:02.5", "0:01:02.5" or "62.5s", in seconds. */
function seconds(text) {
  if (!text) return null;
  const parts = text.replace(/s$/, '').split(':').map(Number);
  return parts.some(Number.isNaN) ? null : parts.reduce((sum, part) => sum * 60 + part, 0);
}

// A line's background vocals sit in a span of their own; they read best in brackets.
const lineText = (p) => [...p.childNodes]
  .map((node) => (node.nodeType === 1 && /x-bg/.test(node.getAttribute('ttm:role') || '') ? ` (${node.textContent.trim()})` : node.textContent))
  .join('').replace(/\s+/g, ' ').trim();

function readTtml(ttml) {
  const doc = new DOMParser().parseFromString(ttml, 'application/xml');
  const body = doc.getElementsByTagName('body')[0];
  if (!body) return null;
  const paragraphs = [...body.getElementsByTagName('p')];
  if (!paragraphs.length) return null;

  const timed = doc.documentElement.getAttribute('itunes:timing') !== 'None' && paragraphs.every((p) => seconds(p.getAttribute('begin')) !== null);
  if (timed) {
    const lines = [];
    paragraphs.forEach((p, i) => {
      lines.push({ time: seconds(p.getAttribute('begin')), text: lineText(p) });
      // A long instrumental stretch shows as a pause rather than the last line staying lit.
      const end = seconds(p.getAttribute('end'));
      const next = paragraphs[i + 1] ? seconds(paragraphs[i + 1].getAttribute('begin')) : null;
      if (end !== null && next !== null && next - end > 5) lines.push({ time: end, text: '' });
    });
    return { lines, source: 'Apple Music' };
  }
  // Untimed: one verse per <div>, with a blank line between verses.
  const verses = [...body.getElementsByTagName('div')].map((div) => [...div.getElementsByTagName('p')].map(lineText).join('\n'));
  return { text: (verses.length ? verses : paragraphs.map(lineText)).join('\n\n'), source: 'Apple Music' };
}
