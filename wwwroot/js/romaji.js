// Japanese lyrics in romaji. Kana can be spelled out directly, but kanji need a dictionary to know
// how they're read here, so kuromoji (wwwroot/vendor/kuromoji) splits each line into words and
// gives their readings. Its dictionary is fetched by the host the first time (JapaneseDictionary.cs).
// Spelling is Hepburn as lyric sites write it: long vowels doubled ("dou", "kooru"), no macrons.

export const hasJapanese = (text) => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text || '');

let tokenizer = null;

function loadScript() {
  if (window.kuromoji) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/kuromoji/kuromoji.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error("Tint's Japanese reader didn't load."));
    document.head.append(script);
  });
}

/** kuromoji, ready to read. The first time this downloads the dictionary (17 MB). */
function ready() {
  tokenizer ??= (async () => {
    await loadScript();
    return new Promise((resolve, reject) => window.kuromoji.builder({ dicPath: 'api/japanese/' })
      .build((error, built) => (error ? reject(new Error("The Japanese dictionary couldn't be downloaded. Try again in a moment.")) : resolve(built))));
  })();
  tokenizer.catch(() => { tokenizer = null; });
  return tokenizer;
}

/** Each text in romaji; texts without Japanese come back as they are. */
export async function romanize(texts) {
  const reader = await ready();
  return texts.map((text) => (hasJapanese(text) ? lineOf(reader.tokenize(text)) : text));
}

// ---- kana to Latin letters ----------------------------------------------------------------------

const SOUNDS = {
  ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o',
  カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko', ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go',
  サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so', ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo',
  タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to', ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do',
  ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no',
  ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho', バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo',
  パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po',
  マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo',
  ヤ: 'ya', ユ: 'yu', ヨ: 'yo',
  ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro',
  ワ: 'wa', ヰ: 'i', ヱ: 'e', ヲ: 'o', ン: 'n', ヴ: 'vu',
  ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o', ヮ: 'wa',
};
const SMALL_Y = { ャ: 'a', ュ: 'u', ョ: 'o' };
const SMALL_VOWEL = { ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o' };

const toKatakana = (text) => text.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

function spell(kana) {
  const chars = [...toKatakana(kana)];
  let out = '';
  let double = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === 'ッ') { double = true; continue; }
    if (c === 'ー') { out += out.match(/[aeiou](?=[^aeiou]*$)/)?.[0] || ''; continue; }
    let syllable;
    if (SMALL_Y[c] && /i$/.test(out)) {
      // キャ kya; シャ sha, チャ cha and ジャ ja drop their y.
      const base = out.replace(/i$/, '');
      out = /(sh|ch|j)$/.test(base) ? base + SMALL_Y[c] : base + 'y' + SMALL_Y[c];
      continue;
    }
    if (SMALL_VOWEL[c] && /[aeiou]$/.test(out) && i > 0) {
      // ファ fa, ティ ti, ウィ wi, シェ she.
      out = chars[i - 1] === 'ウ' ? out.replace(/u$/, 'w') + SMALL_VOWEL[c] : out.replace(/[aeiou]$/, '') + SMALL_VOWEL[c];
      continue;
    }
    syllable = SOUNDS[c] ?? c;
    if (double) {
      // っち is "tchi"; otherwise the next consonant doubles.
      out += syllable.startsWith('ch') ? 't' : /^[a-z]/.test(syllable) && !/^[aeiou]/.test(syllable) ? syllable[0] : '';
      double = false;
    }
    out += syllable;
  }
  return out;
}

// ---- words to a line ----------------------------------------------------------------------------

const PUNCTUATION = { '、': ',', '。': '.', '！': '!', '？': '?', '「': '"', '」': '"', '『': '"', '』': '"', '（': '(', '）': ')', '〜': '~', '～': '~', '…': '...', '・': ' ', '　': ' ' };
const isKana = (text) => /^[ぁ-ゖァ-ー]+$/.test(text);
const isKatakana = (text) => /^[ァ-ー]+$/.test(text);

/** How a word is read, in katakana, or null for one written in something other than Japanese. */
function readingOf(token) {
  const surface = token.surface_form;
  if (token.pos === '助詞') {
    // The particles written は, へ and を are said wa, e and o.
    if (surface === 'は') return 'ワ';
    if (surface === 'へ') return 'エ';
    if (surface === 'を') return 'オ';
  }
  if (token.reading && token.reading !== '*') return token.reading;
  return isKana(surface) ? toKatakana(surface) : null;
}

/** Whether a word is written onto the one before it: verb endings, suffixes and punctuation are. */
function joinsPrevious(token, previous) {
  if (!previous) return false;
  if (previous.pos === '接頭詞' || token.pos_detail_1 === '接尾') return true;
  // A loanword the dictionary doesn't know comes in pieces ("ファ", "タール").
  if (isKatakana(previous.surface_form) && isKatakana(token.surface_form)) return true;
  // Verb and adjective endings ("datta", "naranai") join; "de" after a noun stands apart.
  if (token.pos === '助動詞') return /^(動詞|形容詞|助動詞)$/.test(previous.pos);
  if (token.pos === '助詞' && token.pos_detail_1 === '接続助詞' && /^(て|で|ば)$/.test(token.surface_form)) return true;
  return token.pos === '記号' && !/^\s+$/.test(token.surface_form) && !/[「『（(]/.test(token.surface_form);
}

function lineOf(tokens) {
  let line = '';
  let previous = null;
  // A small ッ at the end of one word doubles the first sound of the next (なっ + て is "natte").
  let pause = '';
  for (const token of tokens) {
    if (/^\s+$/.test(token.surface_form)) { line += ' '; previous = null; continue; }
    let reading = readingOf(token);
    let word;
    if (reading) {
      reading = pause + reading;
      pause = reading.endsWith('ッ') ? 'ッ' : '';
      word = spell(pause ? reading.slice(0, -1) : reading);
    } else {
      pause = '';
      word = [...token.surface_form].map((c) => PUNCTUATION[c] ?? c).join('');
    }
    line += (line && !line.endsWith(' ') && !joinsPrevious(token, previous) ? ' ' : '') + word;
    previous = token;
  }
  return line.replace(/\s+/g, ' ').replace(/\s+([,.!?)~])/g, '$1').replace(/\(\s+/g, '(').trim();
}
