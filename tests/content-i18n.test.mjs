// Strings of the content script (src/content/content.js): it cannot import the catalogs, so the
// background sends content.* / common.* with the config and the script has its own small t().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import de from '../src/locales/de/content.js';
import en from '../src/locales/en/content.js';

const source = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');

const hasKey = (catalog, key) => Object.hasOwn(catalog, key) || Object.hasOwn(catalog, `${key}.other`);
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `section ${start} … ${end} not found`);
  return source.slice(from, to);
}

// The i18n helpers of content.js, evaluated on their own with a settable config.
function loadHelpers() {
  const code = `
    let config = null;
    ${between('const FALLBACK_MESSAGES', '// Own simple stroke icons')}
    ${between('// ----- strings (i18n) -----', '// rAF with a timer fallback')}
    return { setConfig: (c) => { config = c; }, t, languageLabel, actionName };
  `;
  return new Function(code)();
}

test('every content.* key used in content.js exists in the de and en catalogs', () => {
  const used = new Set([...source.matchAll(/'(content\.[A-Za-z0-9.]+)'/g)].map((m) => m[1]));
  assert.ok(used.size > 50);
  for (const key of used) {
    assert.ok(hasKey(de, key), `de is missing ${key}`);
    assert.ok(hasKey(en, key), `en is missing ${key}`);
  }
});

test('de and en content catalogs have the same keys and placeholders', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(de).sort());
  for (const key of Object.keys(de)) {
    assert.ok(key.startsWith('content.'), key);
    assert.deepEqual(placeholders(en[key]), placeholders(de[key]), key);
  }
});

test('no hard-coded German UI strings or language list remain in content.js', () => {
  const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\/ .*$/gm, '');
  assert.doesNotMatch(code, /[äöüßÄÖÜ„“]/);
  assert.doesNotMatch(code, /\bSTR\./);
  assert.doesNotMatch(code, /\bLANGUAGES\b/);
  assert.doesNotMatch(code, /'Deutsch'/);
});

test('the built-in fallback texts equal the English catalog', () => {
  const { setConfig, t } = loadHelpers();
  setConfig(null);
  const keys = [...between('const FALLBACK_MESSAGES', '});').matchAll(/'(content\.[\w.]+)':/g)].map((m) => m[1]);
  assert.ok(keys.length > 5);
  for (const key of keys) assert.equal(t(key), en[key], key);
});

test('t() uses config.messages with placeholders, plurals and number formatting', () => {
  const { setConfig, t } = loadHelpers();
  setConfig({ uiLanguage: 'de', messages: { ...de }, languages: [] });
  assert.equal(t('content.translateTo', { language: 'Englisch' }), 'Übersetzen nach Englisch');
  assert.equal(t('content.page.failedSections', { count: 1 }), '1 Abschnitt wurde nicht übersetzt.');
  assert.equal(t('content.page.failedSections', { count: 1200 }), '1.200 Abschnitte wurden nicht übersetzt.');
  assert.equal(t('content.popover.instruction', { instruction: 'kürzer' }), 'Anpassung: „kürzer“');
  // inserted values are not scanned for placeholders again
  assert.equal(t('content.chat.actionIntro', { name: 'X', text: '{name}' }), 'Schnellaktion „X“ für diesen Text:\n\n{name}');

  setConfig({ uiLanguage: 'en', messages: { ...en }, languages: [] });
  assert.equal(t('content.page.failedSections', { count: 1 }), '1 section was not translated.');
  assert.equal(t('content.page.failedSections', { count: 1200 }), '1,200 sections were not translated.');
  assert.equal(t('content.page.progress', { percent: 42 }), 'Translating … 42%');
  assert.equal(t('content.unknown.key'), 'content.unknown.key');
});

test('languageLabel() and actionName() use the config of the UI language', () => {
  const { setConfig, languageLabel, actionName } = loadHelpers();
  setConfig({
    uiLanguage: 'en',
    messages: { ...en },
    languages: [{ value: 'de', label: 'German' }, { value: 'zh-Hans', label: 'Chinese (Simplified)' }],
  });
  assert.equal(languageLabel('de'), 'German');
  assert.equal(languageLabel('zh-hans'), 'Chinese (Simplified)');
  assert.equal(languageLabel('Klingonisch'), 'Klingonisch'); // free text stays as is
  assert.equal(actionName({ id: 'translate', name: '' }), 'Translate');
  assert.equal(actionName({ id: 'x', name: '' }), 'Action');
  assert.equal(actionName({ id: 'improve', name: 'Improve writing' }), 'Improve writing');
});
