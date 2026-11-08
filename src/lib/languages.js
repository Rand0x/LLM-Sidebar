// Target languages for translations and YouTube summaries.
//
// Settings store a language code (de, en, zh-Hans …), the special value 'auto' (= the UI
// language), or – for languages not in this list – free text the user typed. Older versions
// stored German names ('Deutsch', 'Englisch' …); normalizeTargetLanguage() migrates those.

import { getLanguage, t } from './i18n.js';

export const AUTO_TARGET = 'auto';

// en/de: names used inside prompts (deterministic, independent of the ICU data of the browser).
export const TARGET_LANGUAGES = [
  { code: 'de', en: 'German', de: 'Deutsch' },
  { code: 'en', en: 'English', de: 'Englisch' },
  { code: 'fr', en: 'French', de: 'Französisch' },
  { code: 'es', en: 'Spanish', de: 'Spanisch' },
  { code: 'it', en: 'Italian', de: 'Italienisch' },
  { code: 'pt', en: 'Portuguese', de: 'Portugiesisch' },
  { code: 'nl', en: 'Dutch', de: 'Niederländisch' },
  { code: 'pl', en: 'Polish', de: 'Polnisch' },
  { code: 'cs', en: 'Czech', de: 'Tschechisch' },
  { code: 'tr', en: 'Turkish', de: 'Türkisch' },
  { code: 'ru', en: 'Russian', de: 'Russisch' },
  { code: 'uk', en: 'Ukrainian', de: 'Ukrainisch' },
  { code: 'el', en: 'Greek', de: 'Griechisch' },
  { code: 'sv', en: 'Swedish', de: 'Schwedisch' },
  { code: 'da', en: 'Danish', de: 'Dänisch' },
  { code: 'nb', en: 'Norwegian', de: 'Norwegisch' },
  { code: 'fi', en: 'Finnish', de: 'Finnisch' },
  { code: 'hu', en: 'Hungarian', de: 'Ungarisch' },
  { code: 'ro', en: 'Romanian', de: 'Rumänisch' },
  { code: 'ar', en: 'Arabic', de: 'Arabisch' },
  { code: 'he', en: 'Hebrew', de: 'Hebräisch' },
  { code: 'hi', en: 'Hindi', de: 'Hindi' },
  { code: 'zh-Hans', en: 'Chinese (Simplified)', de: 'Chinesisch (vereinfacht)' },
  { code: 'zh-Hant', en: 'Chinese (Traditional)', de: 'Chinesisch (traditionell)' },
  { code: 'ja', en: 'Japanese', de: 'Japanisch' },
  { code: 'ko', en: 'Korean', de: 'Koreanisch' },
  { code: 'vi', en: 'Vietnamese', de: 'Vietnamesisch' },
  { code: 'th', en: 'Thai', de: 'Thailändisch' },
  { code: 'id', en: 'Indonesian', de: 'Indonesisch' },
];

export const TARGET_LANGUAGE_CODES = TARGET_LANGUAGES.map((l) => l.code);
const BY_CODE = new Map(TARGET_LANGUAGES.map((l) => [l.code.toLowerCase(), l]));
const BY_NAME = new Map(TARGET_LANGUAGES.flatMap((l) => [[l.de.toLowerCase(), l], [l.en.toLowerCase(), l]]));

export function findTargetLanguage(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return BY_CODE.get(key) ?? BY_NAME.get(key) ?? null;
}

/** Target language that matches a UI language (pt-BR → pt, zh-CN → zh-Hans). */
export function targetForUiLanguage(uiLang = getLanguage()) {
  const lang = String(uiLang || '').toLowerCase();
  if (lang.startsWith('zh')) return lang.includes('tw') || lang.includes('hant') ? 'zh-Hant' : 'zh-Hans';
  const base = lang.split('-')[0];
  if (base === 'no' || base === 'nn') return 'nb';
  return BY_CODE.get(base)?.code ?? 'en';
}

/**
 * Stored value → canonical value: known codes and names (German or English) become the code,
 * 'auto' stays, other text is kept (trimmed, max. 60 chars). Empty → fallback.
 */
export function normalizeTargetLanguage(value, fallback = AUTO_TARGET) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const clean = value.trim();
  if (clean.toLowerCase() === AUTO_TARGET) return AUTO_TARGET;
  return findTargetLanguage(clean)?.code ?? clean.slice(0, 60);
}

/** 'auto' → the code that matches the UI language; everything else unchanged. */
export function resolveTargetLanguage(value) {
  const normalized = normalizeTargetLanguage(value);
  return normalized === AUTO_TARGET ? targetForUiLanguage() : normalized;
}

/** Display name of a target language in the UI language (free text is returned as is). */
export function languageLabel(value, uiLang = getLanguage()) {
  const normalized = normalizeTargetLanguage(value);
  if (normalized === AUTO_TARGET) return languageLabel(targetForUiLanguage(uiLang), uiLang);
  const entry = findTargetLanguage(normalized);
  if (!entry) return normalized;
  if (uiLang === 'de') return entry.de;
  try {
    const name = new Intl.DisplayNames([uiLang, 'en'], { type: 'language' }).of(entry.code);
    if (name && name !== entry.code) return name.charAt(0).toLocaleUpperCase(uiLang) + name.slice(1);
  } catch {
    // ignore – fall back to English
  }
  return entry.en;
}

/** Name used inside prompts: German prompts get the German name, all others the English one. */
export function languageNameForPrompt(value, promptLang = 'en') {
  const resolved = resolveTargetLanguage(value);
  const entry = findTargetLanguage(resolved);
  if (!entry) return resolved;
  return promptLang === 'de' ? entry.de : entry.en;
}

/**
 * Options for a <select>: [{ value, label }], sorted by label, with 'auto' first.
 * A stored free-text value that is not in the list is added so it stays selectable.
 */
export function languageOptions({ current, includeAuto = true, uiLang = getLanguage() } = {}) {
  const collator = new Intl.Collator(uiLang);
  const list = TARGET_LANGUAGES
    .map((l) => ({ value: l.code, label: languageLabel(l.code, uiLang) }))
    .sort((a, b) => collator.compare(a.label, b.label));
  const out = [];
  if (includeAuto) {
    out.push({ value: AUTO_TARGET, label: t('common.language.auto', { language: languageLabel(AUTO_TARGET, uiLang) }) });
  }
  const normalized = current === undefined ? null : normalizeTargetLanguage(current);
  if (normalized && normalized !== AUTO_TARGET && !findTargetLanguage(normalized)) {
    out.push({ value: normalized, label: normalized });
  }
  return [...out, ...list];
}
