// Telling whether two services are listing the same song. Each writes titles and names its own
// way ("Song (feat. X)", "曲 - Song", an artist in kana on one and in Latin letters on the other),
// so nothing here expects an exact copy: the title, the artist and the length each count towards
// a score, and a song has to be convincing on more than one of them.

/** Lower case, no accents, no brackets and what is in them, punctuation as spaces. */
function plain(text) {
  return (text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Whether two names are the same once case, accents and punctuation are set aside ("polyphia", "Polyphia"). */
export const sameName = (a, b) => !!plain(a) && plain(a) === plain(b);

function alike(a, b) {
  a = plain(a); b = plain(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // One service's title often holds the other's with something added, such as a translation.
  if (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `)) return 0.7;
  return 0;
}

function sameArtist(a, b) {
  const whole = alike(a, b);
  if (whole) return whole;
  // "A & B", "A, B" and "A feat. B" against plain "A" still share an artist.
  const names = (text) => (text || '').split(/,|&|\bfeat\.?|\bwith\b|\bx\b/i).map(plain).filter(Boolean);
  const theirs = names(b);
  return names(a).some((name) => theirs.includes(name)) ? 0.6 : 0;
}

// Words that mark another version of a song. plain() drops brackets, where these usually sit, so
// "Song (Instrumental)" would pass for "Song"; a version only matches the same kind of version.
const VERSIONS = /\b(instrumental|inst\b\.?|off ?vocal|karaoke|remix|mix|live|acoustic|sped ?up|slowed|nightcore|cover|tv ?size|short ?ver(sion)?|demo)\b/gi;

function versionOf(title) {
  const words = ((title || '').toLowerCase().match(VERSIONS) || [])
    .map((word) => word.replace(/[\s.]/g, ''))
    .map((word) => (word === 'inst' ? 'instrumental' : word));
  return [...new Set(words)].sort().join(' ');
}

/** The entry of `candidates` that is the same recording as `wanted`, or null when none is convincing. */
export function bestMatch(wanted, candidates) {
  let best = null, bestScore = 0;
  for (const song of candidates) {
    const title = alike(wanted.title, song.title);
    if (!title || versionOf(wanted.title) !== versionOf(song.title)) continue;
    const artist = sameArtist(wanted.artist, song.artist);
    const apart = wanted.duration && song.duration ? Math.abs(wanted.duration - song.duration) : null;
    // A live take, a remix or a karaoke track shares the title but runs to a different length.
    if (apart !== null && apart > 12) continue;
    const length = apart === null ? 0 : apart <= 2 ? 1 : apart <= 5 ? 0.6 : 0.2;
    // With no artist in common, only the very same title at the very same length will do.
    if (!artist && !(title === 1 && length === 1)) continue;

    const score = title * 2 + artist * 1.5 + length * 1.5 + (!!wanted.explicit === !!song.explicit ? 0.3 : 0);
    if (score > bestScore) { best = song; bestScore = score; }
  }
  return best;
}
