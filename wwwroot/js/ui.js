// Small DOM helpers shared by every view. Text always goes in as text nodes, never as markup,
// because titles and artist names come from files and from Apple's servers.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'icon') { el.innerHTML = icon(value); el.dataset.icon = value; }
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid);
  }
  return el;
}

/** Replaces an element's children. Accepts nested lists and skips empty slots, like `h` does. */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((kid) => kid != null && kid !== false));
  return el;
}

export const $ = (id) => document.getElementById(id);

// Real third-party brand marks (fetched via icons.mjs into wwwroot/icons/, never hand-drawn).
const BRAND_ICONS = {
  apple: 'icons/applemusic.svg',
  youtube: 'icons/youtubemusic.svg',
  youtubeVideo: 'icons/youtube.svg',
  spotify: 'icons/spotify.svg',
  discord: 'icons/discord.svg',
};

// Unified interface glyphs from Lucide (@iconify-json/lucide@1.2.100, ISC).
// Primary transport controls and active-saved markers use solid fills; utility glyphs share one 1.85px line weight.
const ICONS = {
  play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" fill="currentColor" stroke="none"/>',
  pause: '<rect width="5" height="18" x="14" y="3" rx="1" fill="currentColor" stroke="none"/><rect width="5" height="18" x="5" y="3" rx="1" fill="currentColor" stroke="none"/>',
  next: '<path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z" fill="currentColor" stroke="none"/><path d="M20 4.5v15" stroke-width="2.2"/>',
  prev: '<path d="M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z" fill="currentColor" stroke="none"/><path d="M4 4.5v15" stroke-width="2.2"/>',
  shuffle: '<path d="m18 14 4 4-4 4m0-20 4 4-4 4"/><path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22M2 6h1.972a4 4 0 0 1 3.6 2.2M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  repeatOne: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3m8-8h1v4"/>',
  volume: '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298zM16 9a5 5 0 0 1 0 6m3.364 3.364a9 9 0 0 0 0-12.728"/>',
  volumeLow: '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298zM16 9a5 5 0 0 1 0 6"/>',
  mute: '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298zM22 9l-6 6m0-6 6 6"/>',
  search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  settings: '<path d="M10 5H3m9 14H3M14 3v4m2 10v4m5-9h-9m9 7h-5m5-14h-7m-6 5v4m0-2H3"/>',
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  more: '<circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.25" fill="currentColor" stroke="none"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  mini: '<path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"/><rect width="10" height="7" x="12" y="13" rx="2"/>',
  expand: '<path d="M15 3h6v6m0-6-7 7M3 21l7-7m-1 7H3v-6"/>',
  share: '<path d="M12 2v13m4-9-4-4-4 4m-4 6v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>',
  lyrics: '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2zM7 11h10M7 15h6M7 7h8"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  note: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  pc: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5m5 4a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  pin: '<path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  bookmark: '<path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"/>',
  saved: '<path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z" fill="currentColor"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  plus: '<path d="M5 12h14m-7-7v14"/>',
  pen: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".75" fill="currentColor"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  download: '<path d="M12 15V3m9 12v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  heartFilled: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" fill="currentColor"/>',
  listPlus: '<path d="M11 12H3m13-6H3m13 12H3m15-9v6m3-3h-6"/>',
  listStart: '<path d="M16 12H3m13 6H3M10 6H3m18 12V8a2 2 0 0 0-2-2h-5"/><path d="m16 8-2-2 2-2"/>',
  listEnd: '<path d="M16 12H3m13-6H3m7 12H3M21 6v10a2 2 0 0 1-2 2h-5"/><path d="m16 16-2 2 2 2"/>',
  trash: '<path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  disc: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="2"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  listMusic: '<path d="M21 15V6m-2.5 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM12 12H3m13-6H3m9 12H3"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/>',
  terminal: '<path d="M12 19h8M4 17l6-6-6-6"/>',
  palette: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  // Official Simple Icons monochrome paths for subtle source indicators beside artist names (inherit currentColor).
  appleMono: '<path fill="currentColor" stroke="none" d="M23.994 6.124a9.23 9.23 0 00-.24-2.19c-.317-1.31-1.062-2.31-2.18-3.043a5.022 5.022 0 00-1.877-.726 10.496 10.496 0 00-1.564-.15c-.04-.003-.083-.01-.124-.013H5.986c-.152.01-.303.017-.455.026-.747.043-1.49.123-2.193.4-1.336.53-2.3 1.452-2.865 2.78-.192.448-.292.925-.363 1.408-.056.392-.088.785-.1 1.18 0 .032-.007.062-.01.093v12.223c.01.14.017.283.027.424.05.815.154 1.624.497 2.373.65 1.42 1.738 2.353 3.234 2.801.42.127.856.187 1.293.228.555.053 1.11.06 1.667.06h11.03a12.5 12.5 0 001.57-.1c.822-.106 1.596-.35 2.295-.81a5.046 5.046 0 001.88-2.207c.186-.42.293-.87.37-1.324.113-.675.138-1.358.137-2.04-.002-3.8 0-7.595-.003-11.393zm-6.423 3.99v5.712c0 .417-.058.827-.244 1.206-.29.59-.76.962-1.388 1.14-.35.1-.706.157-1.07.173-.95.045-1.773-.6-1.943-1.536a1.88 1.88 0 011.038-2.022c.323-.16.67-.25 1.018-.324.378-.082.758-.153 1.134-.24.274-.063.457-.23.51-.516a.904.904 0 00.02-.193c0-1.815 0-3.63-.002-5.443a.725.725 0 00-.026-.185c-.04-.15-.15-.243-.304-.234-.16.01-.318.035-.475.066-.76.15-1.52.303-2.28.456l-2.325.47-1.374.278c-.016.003-.032.01-.048.013-.277.077-.377.203-.39.49-.002.042 0 .086 0 .13-.002 2.602 0 5.204-.003 7.805 0 .42-.047.836-.215 1.227-.278.64-.77 1.04-1.434 1.233-.35.1-.71.16-1.075.172-.96.036-1.755-.6-1.92-1.544-.14-.812.23-1.685 1.154-2.075.357-.15.73-.232 1.108-.31.287-.06.575-.116.86-.177.383-.083.583-.323.6-.714v-.15c0-2.96 0-5.922.002-8.882 0-.123.013-.25.042-.37.07-.285.273-.448.546-.518.255-.066.515-.112.774-.165.733-.15 1.466-.296 2.2-.444l2.27-.46c.67-.134 1.34-.27 2.01-.403.22-.043.442-.088.663-.106.31-.025.523.17.554.482.008.073.012.148.012.223.002 1.91.002 3.822 0 5.732z"/>',
  youtubeMono: '<path fill="currentColor" stroke="none" d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm0 19.104c-3.924 0-7.104-3.18-7.104-7.104S8.076 4.896 12 4.896s7.104 3.18 7.104 7.104-3.18 7.104-7.104 7.104zm0-13.332c-3.432 0-6.228 2.796-6.228 6.228S8.568 18.228 12 18.228s6.228-2.796 6.228-6.228S15.432 5.772 12 5.772zM9.684 15.54V8.46L15.816 12l-6.132 3.54z"/>',
  spotifyMono: '<g transform="scale(0.09375)"><path fill="currentColor" stroke="none" d="M127.999236,0 C57.3087105,0 0,57.3085507 0,128.000764 C0,198.696035 57.3087105,256 127.999236,256 C198.697403,256 256,198.696035 256,128.000764 C256,57.3131363 198.697403,0.00611405337 127.997707,0.00611405337 L127.999236,0 Z M186.69886,184.613841 C184.406145,188.373984 179.48445,189.566225 175.724397,187.258169 C145.671485,168.900724 107.838626,164.743168 63.2835265,174.923067 C58.990035,175.901315 54.7102999,173.211132 53.7320747,168.916009 C52.7492641,164.620887 55.428684,160.34105 59.7328748,159.362801 C108.491286,148.222996 150.314998,153.019471 184.054595,173.639116 C187.814648,175.947171 189.00686,180.853699 186.69886,184.613841 L186.69886,184.613841 Z M202.365748,149.76068 C199.476927,154.456273 193.33245,155.938931 188.640026,153.050041 C154.234012,131.90153 101.787386,125.776777 61.0916907,138.130222 C55.8138602,139.724462 50.2395052,136.749975 48.6376614,131.481189 C47.0480455,126.203233 50.0239899,120.639444 55.2926496,119.034505 C101.778216,104.929384 159.568396,111.761839 199.079523,136.042273 C203.771946,138.931163 205.254569,145.075787 202.365748,149.762209 L202.365748,149.76068 Z M203.710807,113.467659 C162.457218,88.964062 94.394144,86.7110334 55.0068244,98.6655362 C48.6819873,100.58382 41.9933726,97.0132133 40.0766627,90.6882251 C38.1599527,84.3601798 41.7274177,77.675991 48.0568402,75.7531212 C93.2707135,62.0270714 168.433562,64.6790421 215.929451,92.8755277 C221.63067,96.2520136 223.495412,103.599577 220.117478,109.281061 C216.754829,114.970188 209.38757,116.845674 203.716921,113.467659 L203.710807,113.467659 Z"/></g>',
  discordMono: '<path fill="currentColor" stroke="none" d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>',
};

export function icon(name) {
  if (BRAND_ICONS[name]) {
    return `<img class="brand-icon" src="${BRAND_ICONS[name]}" alt="" draggable="false" aria-hidden="true">`;
  }
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60), m = Math.floor(seconds / 60) % 60, hrs = Math.floor(seconds / 3600);
  const ss = String(s).padStart(2, '0');
  return hrs ? `${hrs}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "42 minutes", "1 hour 5 minutes" — for album and playlist summaries. */
export function fmtLength(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hrs = Math.floor(minutes / 60), mins = minutes % 60;
  const part = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (!hrs) return part(mins, 'minute');
  return mins ? `${part(hrs, 'hour')} ${part(mins, 'minute')}` : part(hrs, 'hour');
}

export const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Plays a CSS entrance animation from the start on an element that is already on the page. */
export function replay(el, name) {
  el.classList.remove(name);
  void el.offsetWidth; // makes the browser notice the class went away before it comes back
  el.classList.add(name);
}

// ---- artwork ------------------------------------------------------------------------------------

const DPR = Math.min(2, window.devicePixelRatio || 1);

/** The URL of an artwork at roughly `size` CSS pixels. Local art comes in three cached sizes. */
export function artSrc(art, size) {
  if (!art) return null;
  const px = Math.round(size * DPR);
  if (art.key) return `art/${art.key}?s=${px <= 128 ? 96 : px <= 400 ? 320 : 640}`;
  if (art.url) {
    const snapped = px <= 80 ? 80 : px <= 160 ? 160 : px <= 320 ? 320 : px <= 480 ? 480 : 720;
    return art.url.replace('{w}', snapped).replace('{h}', snapped).replace('{f}', 'jpg').replace('{c}', 'bb');
  }
  return null;
}

// A music video's "cover" is its thumbnail, sent small in lists; the video keeps a 1280-pixel one too.
const VIDEO_THUMB = /^https:\/\/i\.ytimg\.com\/vi\/([\w-]{11})\//;
const bigThumb = (url) => { const id = url?.match(VIDEO_THUMB)?.[1]; return id ? `https://i.ytimg.com/vi/${id}/maxresdefault.jpg` : null; };

/** The small version to fall back on when a big one (artAt, artFull) isn't there. */
export function artFallback(art) {
  return art?.url && VIDEO_THUMB.test(art.url) ? art.url : null;
}

/** A cover at about `px` pixels without the size steps lists use: for showing one cover large. */
export function artAt(art, px) {
  if (!art) return null;
  if (art.key) return `art/${art.key}?s=640`;
  if (px > 400 && bigThumb(art.url)) return bigThumb(art.url);
  if (art.url) {
    const size = Math.round(px * DPR);
    return art.url.replace('{w}', size).replace('{h}', size).replace('{f}', 'jpg').replace('{c}', 'bb');
  }
  return null;
}

/** The largest version of a cover its service offers, for saving. */
export function artFull(art) {
  if (!art) return null;
  if (art.key) return `art/${art.key}?s=640`;
  if (bigThumb(art.url)) return bigThumb(art.url);
  // Apple keeps covers at up to 3000 pixels; YouTube's are smaller to begin with.
  const size = art.url?.includes('mzstatic.com') ? 3000 : 1200;
  return art.url?.replace('{w}', size).replace('{h}', size).replace('{f}', 'jpg').replace('{c}', 'bb') || null;
}

/** A square cover image, or a quiet placeholder when there is no artwork. */
const shownArt = new Set();

export function cover(art, size, { lazy = true } = {}) {
  const box = h('span', { class: 'cover' });
  const src = artSrc(art, size);
  if (src) {
    const img = h('img', { alt: '', decoding: 'async', draggable: false });
    if (lazy) img.loading = 'lazy';
    // A picture fades in the first time it arrives, rather than snapping into an empty square. One
    // already shown appears at once: lists rebuild their rows as they scroll, and it would blink.
    if (shownArt.has(src)) img.classList.add('is-loaded');
    else img.addEventListener('load', () => {
      shownArt.add(src);
      img.classList.add('is-loaded');
    }, { once: true });
    img.addEventListener('error', () => { img.remove(); box.classList.add('is-blank'); box.innerHTML = icon('note'); }, { once: true });
    img.src = src;
    box.append(img);
  } else {
    box.classList.add('is-blank');
    box.innerHTML = icon('note');
  }
  return box;
}

// ---- toast --------------------------------------------------------------------------------------

export function toast(message, { ms = 3200 } = {}) {
  const host = $('toasts');
  const el = h('div', { class: 'toast' }, message);
  host.append(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

// ---- sharing ------------------------------------------------------------------------------------

/** Puts text on the clipboard and says so with `done`. Returns whether it worked. */
export async function copyText(text, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The clipboard API can be refused; the old way still copies from a click.
    const box = h('textarea', { value: text, readOnly: true, style: { position: 'fixed', opacity: '0' } });
    document.body.append(box);
    box.select();
    const copied = document.execCommand('copy');
    box.remove();
    if (!copied) { toast("That couldn't be copied."); return false; }
  }
  if (done) toast(done);
  return true;
}

/** Puts a song's link on the clipboard, to paste into a chat or anywhere else. */
export const shareLink = (link) => copyText(link, 'Link copied. Paste it wherever you want to share the song.');

// ---- menu ---------------------------------------------------------------------------------------

let openMenu = null;
let openMenuClose = null;

export function closeMenu() {
  const onClose = openMenuClose;
  openMenuClose = null;
  openMenu?.remove();
  openMenu = null;
  onClose?.();
}

/** Shows a small menu at a point. `items` is a list of { label, icon?, run, danger?, active? } or { sep: true }. */
export function showMenu(x, y, items) {
  closeMenu();
  const clean = [];
  for (const item of items) {
    if (!item) continue;
    if (item.sep) {
      if (clean.length && !clean.at(-1).sep) clean.push(item);
      continue;
    }
    clean.push(item);
  }
  if (clean.at(-1)?.sep) clean.pop();
  const hasIcons = clean.some((i) => !i.sep && i.icon);
  const menu = h('div', { class: 'menu' + (hasIcons ? ' has-icons' : ''), role: 'menu' },
    clean.map((item) => (item.sep
      ? h('hr', { class: 'menu-sep', role: 'separator' })
      : h('button', {
        role: 'menuitem',
        class: (item.danger ? 'is-danger ' : '') + (item.active ? 'is-active' : ''),
        onclick: () => { closeMenu(); item.run(); },
      },
        hasIcons && h('span', { class: 'menu-icon', icon: item.icon || null }),
        h('span', { class: 'menu-label' }, item.label)))));
  menu.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const btns = [...menu.querySelectorAll('button:not(:disabled)')];
    if (!btns.length) return;
    e.preventDefault();
    const at = btns.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1
      : (at + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
    btns[next].focus();
  });
  document.body.append(menu);
  // Measured by layout size: the menu is still growing into place, so it is drawn smaller than it is.
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  openMenu = menu;
  menu.querySelector('button')?.focus();
}

/** Shows any panel the way a menu is shown: at a point, and gone on a click elsewhere or Escape. */
export function showPopover(x, y, panel, { onClose = null, anchor = null, align = 'left' } = {}) {
  closeMenu();
  panel.classList.add('menu');
  document.body.append(panel);
  const w = panel.offsetWidth, height = panel.offsetHeight;
  let left = align === 'right' && anchor ? anchor.right - w : x;
  let originX = align === 'right' ? '100%' : '0%';
  if (anchor && align === 'left' && left + w > window.innerWidth - 8) {
    left = anchor.right - w;
    originX = '100%';
  }
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = y;
  let originY = '0%';
  if (anchor && y + height > window.innerHeight - 8) {
    top = Math.max(8, anchor.top - height - 6);
    originY = '100%';
  } else {
    top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
  }
  panel.style.transformOrigin = `${originX} ${originY}`;
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
  openMenu = panel;
  openMenuClose = onClose;
  return panel;
}

document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

// ---- virtual list -------------------------------------------------------------------------------

/**
 * Renders only the rows near the viewport, so a library of ten thousand songs costs the same as
 * one of fifty. Rows share a fixed height.
 */
export class VirtualList {
  constructor({ scroller, rowHeight, count, render, className = '' }) {
    this.scroller = scroller;
    this.rowHeight = rowHeight;
    this.count = count;
    this.render = render;
    this.el = h('div', { class: 'vlist ' + className, role: 'list' });
    this.inner = h('div', { class: 'vlist-inner' });
    this.el.append(this.inner);
    this.el.style.height = count * rowHeight + 'px';
    this.from = -1;
    this.to = -1;
    this.frame = 0;
    this.onScroll = () => {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
    };
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onScroll);
    // Drawn next frame, or a few frames on if the page takes that long to put the list in place.
    let tries = 0;
    const first = () => {
      if (this.el.isConnected || ++tries > 30) this.update();
      else requestAnimationFrame(first);
    };
    requestAnimationFrame(first);
  }

  setCount(count) {
    this.count = count;
    this.el.style.height = count * this.rowHeight + 'px';
    this.update(true);
  }

  update(force = false) {
    // A page that went away without saying so (a list inside a redrawn section) lets go of the scroller.
    if (!this.el.isConnected) { if (this.drawn) this.destroy(); return; }
    this.drawn = true;
    const top = this.el.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top;
    const viewport = this.scroller.clientHeight;
    const overscan = 6;
    const from = Math.max(0, Math.floor(-top / this.rowHeight) - overscan);
    const to = Math.min(this.count, Math.ceil((viewport - top) / this.rowHeight) + overscan);
    if (!force && from === this.from && to === this.to) return;
    this.from = from;
    this.to = to;
    const rows = [];
    for (let i = from; i < to; i++) rows.push(this.render(i));
    this.inner.style.transform = `translateY(${from * this.rowHeight}px)`;
    this.inner.replaceChildren(...rows);
  }

  refresh() { this.update(true); }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.scroller.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('resize', this.onScroll);
  }
}

/**
 * A grid of covers where only the rows near the screen exist, like VirtualList. The columns are the
 * stylesheet's own (.grid fills the width with --card-wide cells); rows are as tall as the tallest
 * card drawn so far, since a tagged playlist runs taller than a plain album.
 */
export class VirtualGrid {
  constructor({ scroller, count, render }) {
    this.scroller = scroller;
    this.count = count;
    this.render = render;
    this.el = h('div', { class: 'vgrid' });
    this.inner = h('div', { class: 'grid vgrid-inner' });
    this.el.append(this.inner);
    this.cols = 1;
    this.rowHeight = 0;
    this.width = 0;
    this.from = -1;
    this.to = -1;
    this.frame = 0;
    this.onScroll = () => {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
    };
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.sizes = new ResizeObserver(() => {
      if (this.el.clientWidth !== this.width) this.update(true);
    });
    this.sizes.observe(this.el);
    requestAnimationFrame(() => this.update());
  }

  update(force = false) {
    if (!this.el.isConnected) { if (this.drawn) this.destroy(); return; }
    this.drawn = true;
    const style = getComputedStyle(this.inner);
    const card = parseFloat(style.getPropertyValue('--card')) || 150;
    const colGap = parseFloat(style.columnGap) || 20;
    const rowGap = parseFloat(style.rowGap) || 26;
    this.width = this.el.clientWidth;
    // The same count CSS's auto-fill arrives at.
    const cols = Math.max(1, Math.floor((this.width + colGap) / (card + colGap)));
    if (cols !== this.cols) { this.cols = cols; force = true; }
    const rows = Math.ceil(this.count / cols);
    const pitch = (this.rowHeight || card + 60) + rowGap;
    const top = this.el.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top;
    const from = Math.max(0, Math.floor(-top / pitch) - 1);
    const to = Math.min(rows, Math.ceil((this.scroller.clientHeight - top) / pitch) + 1);
    if (force || from !== this.from || to !== this.to) {
      this.from = from;
      this.to = to;
      const cells = [];
      for (let i = from * cols; i < Math.min(this.count, to * cols); i++) cells.push(this.render(i));
      this.inner.replaceChildren(...cells);
    }
    const tallest = Math.max(this.rowHeight, ...[...this.inner.children].map((cell) => cell.offsetHeight));
    if (tallest !== this.rowHeight) {
      this.rowHeight = tallest;
      this.update(true);
      return;
    }
    this.inner.style.gridAutoRows = `${this.rowHeight}px`;
    this.inner.style.transform = `translateY(${from * pitch}px)`;
    this.el.style.height = `${Math.max(0, rows * pitch - rowGap)}px`;
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.sizes.disconnect();
  }
}
