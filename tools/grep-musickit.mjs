// Research helper: prints the parts of Apple's MusicKit script that mention a term, to see how
// it decides something.   node tools/grep-musickit.mjs restrictedEnabled [contextChars]

const term = process.argv[2];
const span = Number(process.argv[3] || 260);
if (!term) { console.error('usage: node tools/grep-musickit.mjs <term> [contextChars]'); process.exit(2); }

const src = await (await fetch('https://js-cdn.music.apple.com/musickit/v3/musickit.js')).text();
let at = -1, shown = 0, lastEnd = -1;
while ((at = src.indexOf(term, at + 1)) >= 0 && shown < 14) {
  if (at < lastEnd) continue; // already inside the previous excerpt
  lastEnd = at + span;
  console.log(`--- @${at}\n${src.slice(Math.max(0, at - span), at + span).replace(/\s+/g, ' ')}\n`);
  shown++;
}
console.log(`script length ${src.length}, excerpts shown ${shown}`);
