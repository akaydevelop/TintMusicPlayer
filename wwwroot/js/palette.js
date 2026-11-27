// Reads a cover's colours and turns them into the app's theme.
// Everything is worked out in OKLCH so that "same lightness" really looks like the same lightness
// across hues, which is what keeps text readable whatever the cover.

import { post } from './api.js';
import { artSrc } from './ui.js';

// ---- colour maths -------------------------------------------------------------------------------

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToOklab(r, g, b) {
  r = toLinear(r / 255); g = toLinear(g / 255); b = toLinear(b / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklchToLinearRgb(L, C, H) {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH to a hex colour, easing chroma down until the colour fits in sRGB. */
export function oklch(L, C, H) {
  let rgb = oklchToLinearRgb(L, C, H);
  for (let i = 0; i < 24 && rgb.some((v) => v < -0.0005 || v > 1.0005); i++) {
    C *= 0.92;
    rgb = oklchToLinearRgb(L, C, H);
  }
  return '#' + rgb.map((v) => Math.round(255 * toGamma(Math.min(1, Math.max(0, v)))).toString(16).padStart(2, '0')).join('');
}

function hexToLch(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  if (!Number.isFinite(n)) return null;
  const [L, a, b] = rgbToOklab((n >> 16) & 255, (n >> 8) & 255, n & 255);
  return { l: L, c: Math.hypot(a, b), h: (Math.atan2(b, a) * 180) / Math.PI };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => toLinear(c / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Picks a vibrant accent in OKLCH without washing rich reds/blues into pastel, while guaranteeing
 * readable contrast against `bg` and choosing the sharper dark or light foreground for `onAccent`.
 */
function vibrantAccent(acc, bg, mode) {
  // Hue-aware lightness floor: yellows/ambers/greens turn muddy brown below L=0.72, while reds,
  // magentas and blues hit peak sRGB chroma around L=0.57-0.64.
  const h = ((acc.h % 360) + 360) % 360;
  const minDarkL = h >= 48 && h <= 170 ? 0.74 : 0.57;
  const targetC = clamp(Math.max(acc.c * 1.3, 0.17), 0.16, 0.27);
  let L = mode === 'dark' ? clamp(acc.l, minDarkL, 0.87) : clamp(acc.l, 0.42, 0.55);
  let accent = oklch(L, targetC, acc.h);

  // Nudge lightness only as far as needed so buttons, sliders and indicators pop cleanly on the window ground.
  const minOnBg = mode === 'dark' ? 3.8 : 4.5;
  for (let i = 0; i < 16 && contrastRatio(accent, bg) < minOnBg; i++) {
    L = mode === 'dark' ? Math.min(0.88, L + 0.02) : Math.max(0.32, L - 0.02);
    accent = oklch(L, targetC, acc.h);
  }

  const darkInk = oklch(0.16, 0.04, acc.h);
  const lightInk = '#ffffff';
  const lightC = contrastRatio(lightInk, accent);
  // Crisp white looks cleaner on rich reds/blues/magentas; bright greens/yellows/ambers take dark ink.
  const onAccent = lightC >= 3.4 ? lightInk : darkInk;
  return { accent, onAccent };
}

// ---- reading a cover ----------------------------------------------------------------------------

const SAMPLE = 64;
const canvas = document.createElement('canvas');
canvas.width = canvas.height = SAMPLE;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const cache = new Map();

function hueDistance(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * Finds the cover's dominant colour (what most of it is) and its accent (preferring a vivid
 * contrasting highlight — including small focal colour spots on monochrome art, like a red eye on
 * a black-and-white cover — and falling back to the dominant hue when the art has no colour).
 */
function extract(pixels) {
  const domBins = new Map();
  const hueBins = new Map();
  let total = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const [L, a, b] = rgbToOklab(pixels[i], pixels[i + 1], pixels[i + 2]);
    const C = Math.hypot(a, b);
    const H = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
    const domKey = C < 0.03
      ? 1000 + Math.round(L * 4)
      : Math.round(L * 4) * 100 + Math.min(3, Math.floor(C / 0.06)) * 20 + Math.floor(H / 30);
    let bin = domBins.get(domKey);
    if (!bin) domBins.set(domKey, (bin = { L: 0, a: 0, b: 0, n: 0 }));
    bin.L += L; bin.a += a; bin.b += b; bin.n++;

    // Group coloured pixels by hue slice so small focal accents aren't shattered across L/C sub-bins.
    if (C >= 0.035) {
      const hKey = Math.floor(H / 30);
      let hb = hueBins.get(hKey);
      if (!hb) hueBins.set(hKey, (hb = { L: 0, a: 0, b: 0, w: 0, n: 0, peakC: 0 }));
      const w = C * C;
      hb.L += L * w; hb.a += a * w; hb.b += b * w; hb.w += w; hb.n++;
      if (C > hb.peakC) hb.peakC = C;
    }
    total++;
  }
  if (!total) return null;

  let dominant = null;
  for (const bin of domBins.values()) {
    const swatch = {
      l: bin.L / bin.n,
      c: Math.hypot(bin.a / bin.n, bin.b / bin.n),
      h: (Math.atan2(bin.b / bin.n, bin.a / bin.n) * 180) / Math.PI,
      share: bin.n / total,
    };
    if (!dominant || swatch.share > dominant.share) dominant = swatch;
  }

  let accent = null, accentScore = 0;
  const domColored = dominant.c >= 0.035;
  for (const hb of hueBins.values()) {
    const share = hb.n / total;
    if (share < 0.002) continue;
    const swatch = {
      l: hb.L / hb.w,
      c: Math.hypot(hb.a / hb.w, hb.b / hb.w),
      h: (Math.atan2(hb.b / hb.w, hb.a / hb.w) * 180) / Math.PI,
      share,
    };
    const usable = swatch.l > 0.25 && swatch.l < 0.94 ? 1 : 0.45;
    const dh = domColored ? hueDistance(swatch.h, dominant.h) : 0;
    let contrastBoost = 1;
    if (!domColored && hb.peakC >= 0.055) {
      contrastBoost = 2.8;
    } else if (domColored && swatch.c >= 0.065 && dh >= 35) {
      contrastBoost = 1 + Math.min(1.8, ((dh - 25) / 90) * 1.5) * (dominant.l < 0.45 && swatch.l > 0.5 ? 1.35 : 1);
    }
    const lightPop = dominant.l < 0.45 && swatch.l > 0.55 && swatch.c >= 0.09 ? 1.35 : 1;
    const score = swatch.c * share ** 0.18 * usable * contrastBoost * lightPop;
    if (score > accentScore) { accentScore = score; accent = swatch; }
  }
  return { dom: dominant, acc: accent || dominant };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The cover could not be loaded.'));
    img.src = url;
  });
}

/** The palette of an artwork, or null when there is none. Results are remembered per image. */
export async function paletteOf(art) {
  const url = artSrc(art, 48);
  if (!url) return null;
  if (cache.has(url)) return cache.get(url);

  let palette = null;
  try {
    const img = await loadImage(url);
    ctx.clearRect(0, 0, SAMPLE, SAMPLE);
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    palette = extract(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
  } catch {
    // Apple includes a cover's main colours with its metadata, which covers the case where the
    // image itself can't be read.
    const dom = art.bg && hexToLch(art.bg), acc = art.fg && hexToLch(art.fg);
    if (dom) palette = { dom, acc: acc || dom };
  }
  cache.set(url, palette);
  return palette;
}

// ---- building the theme -------------------------------------------------------------------------

export const IDLE_THEME = {
  mode: 'dark',
  bg: '#14262b', deep: '#0e1c20', raise: '#1e353b',
  ink: '#edf2ef', dim: '#a4b8b7',
  accent: '#f0b254', onAccent: '#2a1c05',
};

/**
 * A theme from a palette. The cover picks the hue and how colourful things are; lightness is set
 * here, so text keeps its contrast on every cover. Light covers get a light window unless the
 * person has asked to keep it dark.
 */
export function themeFrom(palette, { keepDark = false } = {}) {
  if (!palette) return IDLE_THEME;
  const { dom, acc } = palette;

  const tinted = dom.c >= 0.025;
  const hue = tinted ? dom.h : acc.h;
  const base = tinted ? Math.min(dom.c, 0.12) : Math.min(acc.c, 0.1) * 0.3;
  const vivid = acc.c >= 0.04;

  if (dom.l > 0.72 && !keepDark) {
    const L = 0.955 - 0.03 * (1 - dom.l) / 0.28;
    const C = base * 0.32;
    const bg = oklch(L, C, hue);
    const { accent, onAccent } = vivid
      ? vibrantAccent(acc, bg, 'light')
      : { accent: oklch(0.3, 0.02, hue), onAccent: oklch(0.98, 0.01, hue) };
    return {
      mode: 'light',
      bg,
      deep: oklch(L - 0.03, C * 1.15, hue),
      raise: oklch(L - 0.055, C * 1.2, hue),
      ink: oklch(0.24, 0.03, hue),
      dim: oklch(0.47, 0.035, hue),
      accent,
      onAccent,
    };
  }

  const L = 0.2 + 0.06 * Math.min(1, dom.l / 0.72);
  const C = base * 0.6;
  const bg = oklch(L, C, hue);
  const { accent, onAccent } = vivid
    ? vibrantAccent(acc, bg, 'dark')
    : { accent: oklch(0.93, 0.012, hue), onAccent: oklch(0.18, 0.04, hue) };
  return {
    mode: 'dark',
    bg,
    deep: oklch(L - 0.045, C * 0.9, hue),
    raise: oklch(L + 0.055, C, hue),
    ink: oklch(0.96, 0.012, hue),
    dim: oklch(0.77, Math.min(0.045, C + 0.012), hue),
    accent,
    onAccent,
  };
}

let applied = null;

/** The page's <meta name="theme-color">, made on first use. */
function themeColor() {
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  return meta;
}

/** Updates the SVG favicon so browser / Linux windows also carry the live cover-tinted brush-note icon. */
function updateFavicon(theme) {
  const link = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
  if (!link) return;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="none">` +
    `<defs><linearGradient id="g" x1="36" y1="20" x2="220" y2="240" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${theme.raise}"/><stop offset="1" stop-color="${theme.deep}"/>` +
    `</linearGradient></defs>` +
    `<rect x="14" y="14" width="228" height="228" rx="54" fill="url(#g)" stroke="${theme.ink}" stroke-opacity="0.14" stroke-width="4"/>` +
    `<g transform="translate(2 2)">` +
    `<path d="M124 126 V42 C124 37 129 34 134 37 C158 52 190 69 200 103 C205 120 201 137 191 150 C192 132 186 115 171 103 C161 95 152 90 146 87 V126 Z" fill="${theme.ink}"/>` +
    `<rect x="117" y="134" width="36" height="15" rx="5" fill="${theme.ink}" opacity="0.54"/>` +
    `<path d="M117 157 H153 C162 185 147 219 116 223 C91 226 70 214 58 197 C68 194 74 186 78 175 C84 160 99 157 117 157 Z" fill="${theme.accent}"/>` +
    `</g></svg>`;
  link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

export function applyTheme(theme, { instant = false } = {}) {
  if (applied && Object.keys(theme).every((k) => applied[k] === theme[k])) return;
  applied = theme;
  const root = document.documentElement;
  if (instant) root.classList.add('no-fade');
  root.dataset.mode = theme.mode;
  root.style.setProperty('--bg', theme.bg);
  root.style.setProperty('--deep', theme.deep);
  root.style.setProperty('--raise', theme.raise);
  root.style.setProperty('--ink', theme.ink);
  root.style.setProperty('--dim', theme.dim);
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--on-accent', theme.onAccent);
  if (instant) requestAnimationFrame(() => root.classList.remove('no-fade'));
  updateFavicon(theme);
  // The native title bar and taskbar icon follow along: on Windows the host colours both,
  // in a browser app window the browser follows theme-color and the live SVG favicon.
  post('/api/chrome', {
    bg: theme.bg,
    fg: theme.ink,
    accent: theme.accent,
    raise: theme.raise,
    deep: theme.deep,
    instant,
  }).catch(() => {});
  if (window.tintBrowserHost) themeColor().content = theme.bg;
}
