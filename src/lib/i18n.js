// UI translations.
//
// Catalogs are flat `key → string` maps in src/locales/<code>/index.js, split into one file per
// area (common, core, sidepanel, options, options-sections, content, prompts). German is the
// source language and is bundled statically, so `t()` works synchronously everywhere (also in
// unit tests); every other catalog is loaded by `initI18n()`. The background script cannot use
// dynamic import() (service worker), so it imports src/locales/all.js, which registers all of them.
//
// Message syntax:
//   {name}            placeholder, filled from the params object
//   key.one / .other  plural forms (Intl.PluralRules), chosen by params.count
// Lookup order: active language → English → German → the key itself.

import { ext } from './ext.js';
import de from '../locales/de/index.js';

export const SOURCE_LANGUAGE = 'de';
export const FALLBACK_LANGUAGE = 'en';
export const AUTO_LANGUAGE = 'auto';

/** Supported UI languages, each with its own (native) name. */
export const UI_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'it', name: 'Italiano' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'ru', name: 'Русский' },
  { code: 'ja', name: '日本語' },
  { code: 'zh-CN', name: '简体中文' },
];

const CODES = UI_LANGUAGES.map((l) => l.code);
const catalogs = new Map([[SOURCE_LANGUAGE, de]]);
let language = SOURCE_LANGUAGE;
let chain = [de];
let pluralRules = null;
const listeners = new Set();

export function registerCatalog(code, messages) {
  if (CODES.includes(code) && messages && typeof messages === 'object') catalogs.set(code, messages);
}

/** Maps a BCP 47 tag (de-AT, pt, zh-Hans-CN …) to a supported UI language, or null. */
export function matchLanguage(tag) {
  if (typeof tag !== 'string' || !tag.trim()) return null;
  const clean = tag.trim().replace(/_/g, '-').toLowerCase();
  const exact = CODES.find((c) => c.toLowerCase() === clean);
  if (exact) return exact;
  const base = clean.split('-')[0];
  if (base === 'pt') return 'pt-BR';
  if (base === 'zh') return 'zh-CN';
  return CODES.find((c) => c.toLowerCase() === base) ?? null;
}

/** The browser's UI language (BCP 47), '' when unknown. */
export function browserLanguage() {
  try {
    const lang = ext?.i18n?.getUILanguage?.();
    if (typeof lang === 'string' && lang) return lang;
  } catch {
    // ignore
  }
  return typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : '';
}

/** 'auto' (or anything unknown) → the browser language if supported, else English. */
export function resolveLanguage(setting = AUTO_LANGUAGE) {
  if (setting && setting !== AUTO_LANGUAGE) {
    const chosen = matchLanguage(setting);
    if (chosen) return chosen;
  }
  return matchLanguage(browserLanguage()) ?? FALLBACK_LANGUAGE;
}

async function loadCatalog(code) {
  if (catalogs.has(code)) return;
  const mod = await import(`../locales/${code}/index.js`);
  registerCatalog(code, mod.default);
}

/**
 * Loads the catalogs for `setting` ('auto' or a language code) and activates them.
 * Resolves to the active language code. Never rejects: a missing catalog falls back to English.
 */
export async function initI18n(setting = AUTO_LANGUAGE) {
  const code = resolveLanguage(setting);
  await Promise.all([...new Set([code, FALLBACK_LANGUAGE])].map((c) => loadCatalog(c).catch((err) => {
    console.warn(`[LLM Sidebar] Language "${c}" could not be loaded:`, err);
  })));
  setLanguage(code);
  return language;
}

/** Synchronously switches to an already loaded (or registered) language. */
export function setLanguage(code) {
  const next = matchLanguage(code) ?? FALLBACK_LANGUAGE;
  const order = [...new Set([next, FALLBACK_LANGUAGE, SOURCE_LANGUAGE])];
  const nextChain = order.map((c) => catalogs.get(c)).filter(Boolean);
  const active = catalogs.has(next) ? next : (catalogs.has(FALLBACK_LANGUAGE) ? FALLBACK_LANGUAGE : SOURCE_LANGUAGE);
  const changed = active !== language;
  language = active;
  chain = nextChain;
  pluralRules = null;
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = language;
  if (changed) for (const fn of listeners) fn(language);
  return language;
}

/** The active UI language code (en, de, pt-BR …). Also usable as Intl locale. */
export function getLanguage() {
  return language;
}

export const getLocale = getLanguage;

export function onLanguageChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function lookup(key) {
  for (const catalog of chain) {
    const value = catalog[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

export function hasMessage(key) {
  return lookup(key) !== undefined || lookup(`${key}.other`) !== undefined;
}

function pluralForm(count) {
  try {
    pluralRules ??= new Intl.PluralRules(language);
    return pluralRules.select(count);
  } catch {
    return count === 1 ? 'one' : 'other';
  }
}

/** Replaces {name} placeholders. Unknown placeholders are left untouched. */
export function format(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined && params[name] !== null
      ? String(params[name])
      : match
  ));
}

/**
 * Translates `key`. With a numeric `params.count`, the plural form `key.<rule>` (falling back to
 * `key.other`) is used when present. Returns the key itself when no catalog has it.
 */
export function t(key, params) {
  let template;
  if (params && typeof params.count === 'number') {
    template = lookup(`${key}.${pluralForm(params.count)}`) ?? lookup(`${key}.other`);
  }
  template ??= lookup(key);
  if (template === undefined) return key;
  return format(template, params);
}

/** All messages whose key starts with one of `prefixes`, resolved through the fallback chain. */
export function messagesWithPrefix(...prefixes) {
  const out = {};
  for (const catalog of [...chain].reverse()) {
    for (const [key, value] of Object.entries(catalog)) {
      if (typeof value === 'string' && prefixes.some((p) => key.startsWith(p))) out[key] = value;
    }
  }
  return out;
}

const ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];

/**
 * Translates static HTML: data-i18n="key" sets textContent; data-i18n-title,
 * data-i18n-placeholder, data-i18n-aria-label and data-i18n-alt set the attribute.
 */
export function applyI18n(root = typeof document !== 'undefined' ? document : null) {
  if (!root?.querySelectorAll) return;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const attr of ATTRIBUTES) {
    const data = `data-i18n-${attr}`;
    for (const el of root.querySelectorAll(`[${data}]`)) el.setAttribute(attr, t(el.getAttribute(data)));
  }
  if (root.documentElement) root.documentElement.lang = language;
}

/** Locale-aware number formatting in the active language. */
export function formatNumber(value, options) {
  try {
    return new Intl.NumberFormat(language, options).format(value);
  } catch {
    return String(value);
  }
}

/** Locale-aware date/time formatting in the active language. */
export function formatDate(value, options) {
  try {
    return new Intl.DateTimeFormat(language, options).format(value instanceof Date ? value : new Date(value));
  } catch {
    return String(value);
  }
}
