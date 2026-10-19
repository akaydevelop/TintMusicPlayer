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

// ---- reading a cover ----------------------------------------------------------------------------

const SAMPLE = 40;
const canvas = document.createElement('canvas');
canvas.width = canvas.height = SAMPLE;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const cache = new Map();

/**
 * Finds the cover's dominant colour (what most of it is) and its accent (the most vivid colour
 * that still covers a real part of it). Pixels are grouped into coarse lightness/chroma/hue bins
 * and each bin is averaged.
 */
function extract(pixels) {
  const bins = new Map();
  let total = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const [L, a, b] = rgbToOklab(pixels[i], pixels[i + 1], pixels[i + 2]);
    const C = Math.hypot(a, b);
    const key = C < 0.03
      ? 1000 + Math.round(L * 4)
      : Math.round(L * 4) * 100 + Math.min(3, Math.floor(C / 0.06)) * 20 + Math.floor((((Math.atan2(b, a) * 180) / Math.PI + 360) % 360) / 30);
    let bin = bins.get(key);
    if (!bin) bins.set(key, (bin = { L: 0, a: 0, b: 0, n: 0 }));
    bin.L += L; bin.a += a; bin.b += b; bin.n++;
    total++;
  }
  if (!total) return null;

  let dominant = null, accent = null, accentScore = 0;
  for (const bin of bins.values()) {
    const swatch = {
      l: bin.L / bin.n,
      c: Math.hypot(bin.a / bin.n, bin.b / bin.n),
      h: (Math.atan2(bin.b / bin.n, bin.a / bin.n) * 180) / Math.PI,
      share: bin.n / total,
    };
    if (!dominant || swatch.share > dominant.share) dominant = swatch;
    if (swatch.share < 0.012) continue;
    // Very dark and very light pixels carry little usable colour, so they count for less.
    const usable = swatch.l > 0.3 && swatch.l < 0.92 ? 1 : 0.55;
    const score = swatch.c * swatch.share ** 0.25 * usable;
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
  ink: '#edf2ef', dim: '#9db1b0',
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
    return {
      mode: 'light',
      bg: oklch(L, C, hue),
      deep: oklch(L - 0.03, C * 1.15, hue),
      raise: oklch(L - 0.055, C * 1.2, hue),
      ink: oklch(0.24, 0.03, hue),
      dim: oklch(0.47, 0.035, hue),
      accent: vivid ? oklch(clamp(acc.l, 0.44, 0.54), clamp(acc.c, 0.1, 0.2), acc.h) : oklch(0.3, 0.02, hue),
      onAccent: oklch(0.98, 0.01, vivid ? acc.h : hue),
    };
  }

  const L = 0.2 + 0.06 * Math.min(1, dom.l / 0.72);
  const C = base * 0.6;
  return {
    mode: 'dark',
    bg: oklch(L, C, hue),
    deep: oklch(L - 0.045, C * 0.9, hue),
    raise: oklch(L + 0.055, C, hue),
    ink: oklch(0.96, 0.012, hue),
    dim: oklch(0.77, Math.min(0.045, C + 0.012), hue),
    accent: vivid ? oklch(clamp(acc.l, 0.78, 0.88), clamp(acc.c, 0.08, 0.17), acc.h) : oklch(0.93, 0.012, hue),
    onAccent: oklch(0.2, 0.04, vivid ? acc.h : hue),
  };
}

let applied = null;

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
  // The native title bar follows along.
  post('/api/chrome', { bg: theme.bg, fg: theme.ink, instant }).catch(() => {});
}
