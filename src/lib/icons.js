// Inline SVG icon set: original, simple stroke icons on a 24x24 grid.
// Every icon inherits its color from `currentColor`, so it follows the surrounding text color.
import { escapeHtml } from './utils.js';

// Small filled dot (used for "more" style icons); stroke dots would look too thin.
const dot = (cx, cy, r = 1.4) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

// Body markup per icon (children of the <svg> element). Keep it to self-closing primitives.
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  'chevron-down': '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
  'chevron-up': '<path d="M6.5 14.5L12 9l5.5 5.5"/>',
  'chevron-right': '<path d="M9.5 6.5l5.5 5.5-5.5 5.5"/>',
  'chevron-left': '<path d="M14.5 6.5L9 12l5.5 5.5"/>',
  'arrow-up': '<path d="M12 19.5v-15M6 10.5l6-6 6 6"/>',
  'arrow-down': '<path d="M12 4.5v15M6 13.5l6 6 6-6"/>',
  'arrow-right': '<path d="M4.5 12h15M13.5 6l6 6-6 6"/>',
  'arrow-left': '<path d="M19.5 12h-15M10.5 6l-6 6 6 6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/>' + dot(4.5, 6.5, 1.2) + dot(4.5, 12, 1.2) + dot(4.5, 17.5, 1.2),
  more: dot(5.5, 12) + dot(12, 12) + dot(18.5, 12),
  'more-vertical': dot(12, 5.5) + dot(12, 12) + dot(12, 18.5),
  settings:
    '<path d="M10.13 5.25L10.43 2.63A9.5 9.5 0 0 1 13.57 2.63L13.87 5.25A7 7 0 0 1 15.45 5.91L17.52 4.27A9.5 9.5 0 0 1 19.73 6.48L18.09 8.55A7 7 0 0 1 18.75 10.13L21.37 10.43A9.5 9.5 0 0 1 21.37 13.57L18.75 13.87A7 7 0 0 1 18.09 15.45L19.73 17.52A9.5 9.5 0 0 1 17.52 19.73L15.45 18.09A7 7 0 0 1 13.87 18.75L13.57 21.37A9.5 9.5 0 0 1 10.43 21.37L10.13 18.75A7 7 0 0 1 8.55 18.09L6.48 19.73A9.5 9.5 0 0 1 4.27 17.52L5.91 15.45A7 7 0 0 1 5.25 13.87L2.63 13.57A9.5 9.5 0 0 1 2.63 10.43L5.25 10.13A7 7 0 0 1 5.91 8.55L4.27 6.48A9.5 9.5 0 0 1 6.48 4.27L8.55 5.91A7 7 0 0 1 10.13 5.25z"/>' +
    '<circle cx="12" cy="12" r="2.75"/>',
  sliders:
    '<path d="M4 6h9.5M18.5 6H20M4 12h1.5M10.5 12H20M4 18h6.5M15.5 18H20"/>' +
    '<circle cx="16" cy="6" r="2.25"/><circle cx="8" cy="12" r="2.25"/><circle cx="13" cy="18" r="2.25"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5"/><path d="M3.5 4v4.5H8"/><path d="M12 7.5V12l3 2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  send: '<path d="M20.5 3.5L3.5 10l6.8 3.2 3.2 7.3z"/><path d="M10.3 13.2l4.4-4.4"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/>',
  play: '<path d="M7.5 5v14l11.5-7z"/>',
  copy:
    '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/>' +
    '<path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
  refresh:
    '<path d="M20 11.5A8 8 0 0 0 5.4 7.5"/><path d="M4 12.5a8 8 0 0 0 14.6 4"/>' +
    '<path d="M5.4 3v4.5h4.5"/><path d="M18.6 21v-4.5h-4.5"/>',
  edit: '<path d="M4 20h4L18.8 9.2a2.83 2.83 0 0 0-4-4L4 16z"/><path d="M13.3 6.7l4 4"/>',
  trash:
    '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/>' +
    '<path d="M6 7l1 12.6A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.4L18 7"/><path d="M10 11v6M14 11v6"/>',
  pin: '<path d="M9 3.5h6"/><path d="M10 3.5V9l-3.5 4v1.5h11V13L14 9V3.5"/><path d="M12 14.5V21"/>',
  image:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.75"/>' +
    '<path d="M20.5 15.5L16 11l-9.5 8.5"/>',
  paperclip:
    '<path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.07-7.07l8.13-8.13a3.33 3.33 0 0 1 4.71 4.71l-8.13 8.13a1.67 1.67 0 0 1-2.36-2.36L15 7"/>',
  page:
    '<path d="M14 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5V9z"/>' +
    '<path d="M14 3.5V9h5.5"/><path d="M8.5 13h7M8.5 16.5h5"/>',
  file:
    '<path d="M14 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5V9z"/>' +
    '<path d="M14 3.5V9h5.5"/>',
  // Quoted text: a bar in front of the lines (page selection referenced in the chat).
  quote: '<path d="M4.5 5.5v13M9 6h10.5M9 10h10.5M9 14h8M9 18h6"/>',
  message: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17A1.5 1.5 0 0 1 4 15.5z"/>',
  globe:
    '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/>' +
    '<path d="M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5s1.2-6.2 3.6-8.5z"/>',
  languages:
    '<path d="M3.5 5.5h9M8 3.5v2"/><path d="M5 5.5c.6 3.4 2.9 6.2 6.5 7.5"/><path d="M11 5.5c-.6 3.4-2.9 6.2-6.5 7.5"/>' +
    '<path d="M12.5 20.5l4-9.5 4 9.5"/><path d="M14 17h5"/>',
  sparkles:
    '<path d="M11 3Q12.2 7.8 17 9Q12.2 10.2 11 15Q9.8 10.2 5 9Q9.8 7.8 11 3z"/>' +
    '<path d="M18.5 2.5v4M16.5 4.5h4"/><path d="M17.5 16v4M15.5 18h4"/>',
  wand:
    '<path d="M4.2 17.7L14.9 7a1.4 1.4 0 0 1 2 0l.1.1a1.4 1.4 0 0 1 0 2L6.3 19.8a1.4 1.4 0 0 1-2 0l-.1-.1a1.4 1.4 0 0 1 0-2z"/>' +
    '<path d="M13 9l2 2"/><path d="M6.5 3v3.5M4.75 4.75h3.5"/><path d="M19 13v3.5M17.25 14.75h3.5"/><path d="M20 4.5l-1 1"/>',
  download:
    '<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/>' +
    '<path d="M4.5 16.5V18A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5v-1.5"/>',
  upload:
    '<path d="M12 15V4"/><path d="M7.5 8.5L12 4l4.5 4.5"/>' +
    '<path d="M4.5 16.5V18A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5v-1.5"/>',
  external:
    '<path d="M13.5 4.5h6v6"/><path d="M19.5 4.5L11 13"/>' +
    '<path d="M17.5 14v3.5a2.5 2.5 0 0 1-2.5 2.5H7a2.5 2.5 0 0 1-2.5-2.5V9.5A2.5 2.5 0 0 1 7 7h3.5"/>',
  link:
    '<path d="M10 13.5a4 4 0 0 0 5.7.3l3-3a4 4 0 0 0-5.6-5.6l-1.6 1.6"/>' +
    '<path d="M14 10.5a4 4 0 0 0-5.7-.3l-3 3a4 4 0 0 0 5.6 5.6l1.6-1.6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20 20"/>',
  sun:
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7.5 7.5 0 0 0 10.5 10.5z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/>',
  key: '<circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8L20 3"/><path d="M16.5 6.5L19 9"/><path d="M14 9l2 2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/><path d="M12 14.5v2"/>',
  eye:
    '<path d="M2.5 12C4.5 8 8 5.5 12 5.5s7.5 2.5 9.5 6.5c-2 4-5.5 6.5-9.5 6.5S4.5 16 2.5 12z"/>' +
    '<circle cx="12" cy="12" r="3"/>',
  'eye-off':
    '<path d="M10.6 5.6a9.6 9.6 0 0 1 1.4-.1c4 0 7.5 2.5 9.5 6.5a12.6 12.6 0 0 1-2.3 3.2"/>' +
    '<path d="M6.6 6.9C4.9 8.1 3.5 9.8 2.5 12c2 4 5.5 6.5 9.5 6.5 1.9 0 3.6-.6 5.1-1.5"/>' +
    '<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3.5 3.5l17 17"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c.8-3.8 3.8-6 7.5-6s6.7 2.2 7.5 6"/>',
  bot:
    '<rect x="4.5" y="8" width="15" height="12" rx="3"/><path d="M12 8V5"/>' +
    dot(12, 3.75, 1.25) +
    '<path d="M9.5 13v1.5M14.5 13v1.5"/><path d="M2 12.5v3M22 12.5v3"/>',
  alert:
    '<path d="M10.3 4.4L2.9 17.5a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0z"/>' +
    '<path d="M12 9.5v4"/>' + dot(12, 16.9, 1.15),
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/>' + dot(12, 7.9, 1.15),
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 0 1 4.85.85c0 1.65-2.45 2.15-2.45 3.4"/>' + dot(12, 16.6, 1.15),
  wallet: '<path d="M17.5 7.5V5.8A1.8 1.8 0 0 0 15.3 4L5.6 6.2A2.5 2.5 0 0 0 3.5 8.6V18a2.5 2.5 0 0 0 2.5 2.5h12A2.5 2.5 0 0 0 20.5 18v-8A2.5 2.5 0 0 0 18 7.5H6"/><path d="M20.5 12h-3.5a2 2 0 0 0 0 4h3.5"/>',
  bolt: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
  brain:
    '<path d="M12 5.5C12 4 10.9 3 9.5 3S7 4 7 5.2C5.3 5.3 4 6.6 4 8.3C4 9 4.2 9.6 4.6 10.1C3.6 10.7 3 11.8 3 13C3 14.5 3.9 15.8 5.2 16.3C5.1 16.6 5 17 5 17.4C5 19.4 6.6 21 8.6 21C10.5 21 12 19.5 12 17.6z"/>' +
    '<path d="M12 5.5C12 4 13.1 3 14.5 3S17 4 17 5.2C18.7 5.3 20 6.6 20 8.3C20 9 19.8 9.6 19.4 10.1C20.4 10.7 21 11.8 21 13C21 14.5 20.1 15.8 18.8 16.3C18.9 16.6 19 17 19 17.4C19 19.4 17.4 21 15.4 21C13.5 21 12 19.5 12 17.6"/>' +
    '<path d="M7 5.2c0 1 .5 1.8 1.3 2.3M4.6 10.1c.8.5 1.8.7 2.9.5M5.2 16.3c.9-.4 1.6-1.1 2-2"/>' +
    '<path d="M17 5.2c0 1-.5 1.8-1.3 2.3M19.4 10.1c-.8.5-1.8.7-2.9.5M18.8 16.3c-.9-.4-1.6-1.1-2-2"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.1 8.1-7.5 9.5-4.4-1.4-7.5-4.9-7.5-9.5V6z"/>',
  keyboard:
    '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/>' +
    '<path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M6.5 14h.01M17.5 14h.01M9.5 14h5"/>',
  code: '<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5"/><path d="M13.5 5l-3 14"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M4 7.5l8 5.5 8-5.5"/>',
  database:
    '<ellipse cx="12" cy="6" rx="7.5" ry="2.75"/><path d="M4.5 6v12c0 1.5 3.4 2.75 7.5 2.75s7.5-1.25 7.5-2.75V6"/>' +
    '<path d="M4.5 12c0 1.5 3.4 2.75 7.5 2.75s7.5-1.25 7.5-2.75"/>',
  palette:
    '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.1 0 1.7-.7 1.7-1.6 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6h2A4.2 4.2 0 0 0 20.5 10.7c0-4-3.8-7.2-8.5-7.2z"/>' +
    dot(7.75, 11.5, 1.15) + dot(10, 7.75, 1.15) + dot(14.5, 7.75, 1.15),
  grip: dot(9, 6, 1.25) + dot(15, 6, 1.25) + dot(9, 12, 1.25) + dot(15, 12, 1.25) + dot(9, 18, 1.25) + dot(15, 18, 1.25),
  maximize: '<path d="M14.5 4.5h5v5M9.5 19.5h-5v-5M19.5 4.5l-6 6M4.5 19.5l6-6"/>',
  minimize: '<path d="M19.5 9.5h-5v-5M4.5 14.5h5v5M14.5 9.5l6-6M9.5 14.5l-6 6"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
};

// Friendly synonyms so callers can use the names they expect.
const ALIASES = {
  close: 'x',
  delete: 'trash',
  pencil: 'edit',
  warning: 'alert',
  error: 'alert',
  gear: 'settings',
  cog: 'settings',
  zap: 'bolt',
  attach: 'paperclip',
  translate: 'languages',
  'external-link': 'external',
  'more-horizontal': 'more',
  chat: 'message',
  robot: 'bot',
  reload: 'refresh',
};

const FALLBACK = ICONS.circle;

export const ICON_NAMES = Object.freeze([...Object.keys(ICONS), ...Object.keys(ALIASES)]);

function normalizeSize(size) {
  if (typeof size === 'number' && Number.isFinite(size) && size > 0) return String(size);
  if (typeof size === 'string' && /^\d+(\.\d+)?(px|em|rem|%)?$/.test(size.trim())) return size.trim();
  return '18';
}

// Returns SVG markup for `name`; unknown names render a neutral circle.
// The markup is trusted and may be inserted via innerHTML (e.g. h('button', { html: icon('copy') })).
export function icon(name, { size = 18, cls = '' } = {}) {
  const key = String(name ?? '');
  const body = (Object.hasOwn(ICONS, key) && ICONS[key])
    || (Object.hasOwn(ALIASES, key) && ICONS[ALIASES[key]])
    || FALLBACK;
  const s = normalizeSize(size);
  const extra = String(cls ?? '').trim();
  const className = extra ? `icon ${escapeHtml(extra)}` : 'icon';
  return `<svg xmlns="http://www.w3.org/2000/svg" class="${className}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
