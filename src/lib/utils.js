// Small helpers shared by all extension pages and the background.

import { t, getLocale } from './i18n.js';

export function uid(prefix = '') {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += b.toString(36).padStart(2, '0');
  return prefix + id.slice(0, 14);
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

export function debounce(fn, ms) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const wait = ms - (now - last);
    clearTimeout(timer);
    if (wait <= 0) {
      last = now;
      fn(...args);
    } else {
      timer = setTimeout(() => {
        last = Date.now();
        fn(...args);
      }, wait);
    }
  };
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function truncate(str, max) {
  const s = String(str ?? '');
  return s.length > max ? s.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : s;
}

/** Longest selected text that is kept as a reference ("quote") for the chat. */
export const MAX_QUOTE_CHARS = 20000;

/**
 * A text selected on a web page, referenced in the chat: { text, title, url, truncated }.
 * Untrusted input (content scripts, stored or imported chats) → normalized copy, or null when
 * there is no text. Only http(s) URLs are kept, without query and fragment (they often carry tokens).
 */
export function normalizeQuote(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let text = typeof raw.text === 'string' ? raw.text.replace(/\r\n?/g, '\n').trim() : '';
  if (!text) return null;
  let truncated = raw.truncated === true;
  if (text.length > MAX_QUOTE_CHARS) {
    text = text.slice(0, MAX_QUOTE_CHARS).trimEnd();
    truncated = true;
  }
  const title = typeof raw.title === 'string' ? truncate(raw.title.replace(/\s+/g, ' ').trim(), 300) : '';
  let url = '';
  if (typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url.trim())) {
    try {
      const u = new URL(raw.url.trim());
      url = `${u.origin}${u.pathname}`.slice(0, 2048);
    } catch {
      url = '';
    }
  }
  const quote = { text, title, url };
  if (truncated) quote.truncated = true;
  return quote;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function deepClone(obj) {
  if (obj === undefined) return undefined;
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj));
  }
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Date group of a timestamp: 'today' | 'yesterday' | 'week' (last 7 days) | 'older'. */
export function dateGroupKey(ts) {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  const diffDays = Math.round((today - day) / 86400000);
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return 'week';
  return 'older';
}

/** Label of a date group (key from dateGroupKey, or 'pinned') in the UI language. */
export function dateGroupLabel(key) {
  return t(`core.dateGroup.${key}`);
}

/** "Heute", "Gestern", "Letzte 7 Tage", "Älter" – in the UI language. */
export function formatDateGroup(ts) {
  return dateGroupLabel(dateGroupKey(ts));
}

export function formatTime(ts) {
  const d = new Date(ts);
  if (startOfDay(ts) === startOfDay(Date.now())) {
    return d.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(getLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// file: is not listed – the content script runs there once the user allows file access, so
// scripting.executeScript decides (describeTabError maps its failure).
const RESTRICTED_PREFIXES = [
  'chrome:', 'chrome-extension:', 'chrome-search:', 'chrome-untrusted:', 'devtools:', 'edge:',
  'brave:', 'opera:', 'vivaldi:', 'about:', 'moz-extension:', 'resource:', 'view-source:',
  'data:', 'javascript:',
];
const RESTRICTED_HOSTS = ['chromewebstore.google.com', 'addons.mozilla.org', 'microsoftedge.microsoft.com'];

export function isRestrictedUrl(url) {
  if (!url) return true;
  const lower = String(url).toLowerCase();
  if (RESTRICTED_PREFIXES.some((p) => lower.startsWith(p))) return true;
  const host = hostnameOf(url);
  if (RESTRICTED_HOSTS.includes(host)) return true;
  if (host === 'chrome.google.com' && lower.includes('/webstore')) return true;
  return false;
}

export function dataUrlParts(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl ?? ''));
  if (!match) return { mimeType: '', base64: '' };
  const mimeType = match[1] || 'application/octet-stream';
  const base64 = match[2] ? match[3] : btoa(unescape(encodeURIComponent(decodeURIComponent(match[3]))));
  return { mimeType, base64 };
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function readFileAsDataUrl(file) {
  return blobToDataUrl(file);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

// content: Blob, string, or a plain object/array (written as indented JSON).
export function downloadFile(filename, content, mime = 'text/plain') {
  const data = content !== null && typeof content === 'object' && !(content instanceof Blob)
    && !ArrayBuffer.isView(content) && !(content instanceof ArrayBuffer)
    ? JSON.stringify(content, null, 2)
    : content;
  const blob = data instanceof Blob ? data : new Blob([data], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}
