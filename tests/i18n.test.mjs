import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  t, format, setLanguage, getLanguage, registerCatalog, matchLanguage, resolveLanguage,
  messagesWithPrefix, UI_LANGUAGES, hasMessage,
} from '../src/lib/i18n.js';
import {
  normalizeTargetLanguage, resolveTargetLanguage, languageLabel, languageNameForPrompt,
  languageOptions, targetForUiLanguage,
} from '../src/lib/languages.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = path.join(ROOT, 'src', 'locales');
const SOURCE = 'de';
// Default prompt texts exist only in German and English; other languages fall back to English.
const PROMPT_ONLY_LANGS = new Set(['de', 'en']);
const isPromptText = (key) => key.startsWith('prompts.') && !key.startsWith('prompts.error.')
  && !/\.(name|label|title)$/.test(key);

const codes = UI_LANGUAGES.map((l) => l.code);
const catalogs = {};
const manifests = {};
for (const code of codes) {
  catalogs[code] = (await import(pathToFileURL(path.join(LOCALES, code, 'index.js')).href)).default;
  manifests[code] = (await import(pathToFileURL(path.join(LOCALES, code, 'manifest.js')).href)).default;
}
const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

after(() => setLanguage('de'));

describe('catalogs', () => {
  test('one folder per UI language, all registered in locales/all.js', () => {
    const folders = readdirSync(LOCALES).filter((name) => statSync(path.join(LOCALES, name)).isDirectory()).sort();
    assert.deepEqual(folders, [...codes].sort());
    const all = readFileSync(path.join(LOCALES, 'all.js'), 'utf8');
    for (const code of codes) assert.ok(all.includes(`registerCatalog('${code}'`), `${code} missing in all.js`);
  });

  for (const code of codes.filter((c) => c !== SOURCE)) {
    test(`${code}: same keys and placeholders as German`, () => {
      const source = catalogs[SOURCE];
      const catalog = catalogs[code];
      const expected = Object.keys(source).filter((key) => PROMPT_ONLY_LANGS.has(code) || !isPromptText(key));
      const missing = expected.filter((key) => typeof catalog[key] !== 'string' || !catalog[key]);
      assert.deepEqual(missing, [], `${code}: missing translations`);
      // Additional plural forms (Russian/Polish "few"/"many" …) are allowed where German has ".other".
      const isExtraPlural = (key) => /\.(zero|two|few|many)$/.test(key) && `${key.replace(/\.\w+$/, '')}.other` in source;
      const extra = Object.keys(catalog).filter((key) => !(key in source) && !isExtraPlural(key));
      assert.deepEqual(extra, [], `${code}: keys that German does not have`);
      for (const key of Object.keys(catalog)) {
        // Plural forms may legitimately drop {count} (e.g. "one" → "a chat").
        if (/\.(zero|one|two|few|many)$/.test(key)) continue;
        assert.deepEqual(placeholders(catalog[key]), placeholders(source[key] ?? ''), `${code}: placeholders of ${key}`);
      }
      if (!PROMPT_ONLY_LANGS.has(code)) {
        assert.deepEqual(Object.keys(catalog).filter(isPromptText), [], `${code}: prompt texts belong to de/en only`);
      }
    });
  }

  test('manifest strings: every language complete, descriptions within the Chrome limit', () => {
    const keys = Object.keys(manifests.en).sort();
    for (const code of codes) {
      assert.deepEqual(Object.keys(manifests[code]).sort(), keys, `${code}: manifest keys`);
      assert.ok(manifests[code]['manifest.description'].length <= 132, `${code}: description too long`);
    }
  });

  test('every key used in the code exists in the German catalog', () => {
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const abs = path.join(dir, name);
        if (statSync(abs).isDirectory()) {
          if (name !== 'locales') walk(abs);
        } else if (/\.(js|html)$/.test(name) && name !== 'i18n.js') files.push(abs); // i18n.js documents the syntax
      }
    };
    walk(path.join(ROOT, 'src'));
    const unknown = [];
    const patterns = [/\bt\(\s*'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g, /\bt\(\s*"([a-zA-Z][\w-]*(?:\.[\w-]+)+)"/g,
      /data-i18n(?:-[a-z-]+)?="([^"]+)"/g];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const re of patterns) {
        for (const [, key] of text.matchAll(re)) {
          if (!(key in catalogs.de) && !(`${key}.other` in catalogs.de)) unknown.push(`${path.relative(ROOT, file)}: ${key}`);
        }
      }
    }
    assert.deepEqual(unknown, []);
  });
});

describe('t()', () => {
  test('placeholders, plurals, fallback chain and unknown keys', () => {
    registerCatalog('en', { 'x.hello': 'Hello {name}', 'x.items.one': '{count} item', 'x.items.other': '{count} items' });
    registerCatalog('fr', { 'x.hello': 'Bonjour {name}' });
    setLanguage('fr');
    assert.equal(getLanguage(), 'fr');
    assert.equal(t('x.hello', { name: 'Ada' }), 'Bonjour Ada');
    assert.equal(t('x.items', { count: 1 }), '1 item'); // falls back to English
    assert.equal(t('x.items', { count: 3 }), '3 items');
    assert.equal(t('no.such.key'), 'no.such.key');
    assert.ok(hasMessage('x.items'));
    assert.equal(format('{a} {b}', { a: 1 }), '1 {b}');
    assert.deepEqual(Object.keys(messagesWithPrefix('x.')).sort(), ['x.hello', 'x.items.one', 'x.items.other']);
    // restore the real catalogs
    registerCatalog('en', catalogs.en);
    registerCatalog('fr', catalogs.fr);
    setLanguage('de');
    assert.equal(getLanguage(), 'de');
  });

  test('matchLanguage / resolveLanguage', () => {
    assert.equal(matchLanguage('de-AT'), 'de');
    assert.equal(matchLanguage('pt-PT'), 'pt-BR');
    assert.equal(matchLanguage('zh-TW'), 'zh-CN');
    assert.equal(matchLanguage('en_GB'), 'en');
    assert.equal(matchLanguage('xx'), null);
    assert.equal(resolveLanguage('fr'), 'fr');
  });
});

describe('target languages', () => {
  test('normalize, resolve and label', () => {
    assert.equal(normalizeTargetLanguage('Deutsch'), 'de');
    assert.equal(normalizeTargetLanguage('Spanish'), 'es');
    assert.equal(normalizeTargetLanguage('  '), 'auto');
    assert.equal(normalizeTargetLanguage('Plattdeutsch'), 'Plattdeutsch');
    setLanguage('de');
    assert.equal(resolveTargetLanguage('auto'), 'de');
    assert.equal(languageLabel('fr'), 'Französisch');
    assert.equal(languageNameForPrompt('zh-Hans', 'en'), 'Chinese (Simplified)');
    assert.equal(languageNameForPrompt('zh-Hans', 'de'), 'Chinesisch (vereinfacht)');
    assert.equal(languageNameForPrompt('Plattdeutsch', 'en'), 'Plattdeutsch');
    assert.equal(targetForUiLanguage('pt-BR'), 'pt');
    assert.equal(targetForUiLanguage('zh-CN'), 'zh-Hans');
    setLanguage('en');
    assert.equal(resolveTargetLanguage('auto'), 'en');
    assert.equal(languageLabel('fr'), 'French');
    setLanguage('de');
  });

  test('options: auto first, free text kept, then all languages', () => {
    const options = languageOptions({ current: 'Plattdeutsch' });
    assert.equal(options[0].value, 'auto');
    assert.equal(options[1].value, 'Plattdeutsch');
    assert.ok(options.some((o) => o.value === 'ja'));
    assert.equal(new Set(options.map((o) => o.value)).size, options.length);
  });
});

test('built extension locales exist for every language (after npm run build)', { skip: !existsSync(path.join(ROOT, 'dist', 'chrome', '_locales')) }, () => {
  for (const code of codes) {
    const dir = path.join(ROOT, 'dist', 'chrome', '_locales', code.replace('-', '_'));
    assert.ok(existsSync(path.join(dir, 'messages.json')), `${dir} missing`);
  }
});
