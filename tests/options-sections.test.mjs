import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.chrome ??= { runtime: { id: 'test-extension', getURL: (p = '') => `chrome-extension://test-extension/${p}` } };

const { t, setLanguage, registerCatalog } = await import('../src/lib/i18n.js');
const en = (await import('../src/locales/en/index.js')).default;
const deSections = (await import('../src/locales/de/options-sections.js')).default;
const enSections = (await import('../src/locales/en/options-sections.js')).default;
const { templateVariables } = await import('../src/options/section-quick-actions.js');

registerCatalog('en', en);
after(() => setLanguage('de'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECTION_FILES = ['chat', 'costs', 'data', 'defaults', 'quick-actions', 'translate']
  .map((name) => path.join(ROOT, 'src', 'options', `section-${name}.js`));

describe('optionsSections catalogs', () => {
  test('de and en have the same keys, all in the optionsSections namespace', () => {
    assert.deepEqual(Object.keys(enSections).sort(), Object.keys(deSections).sort());
    for (const key of Object.keys(deSections)) assert.ok(key.startsWith('optionsSections.'), key);
  });

  test('every key used by the sections exists', () => {
    for (const file of SECTION_FILES) {
      const src = readFileSync(file, 'utf8');
      for (const [, key] of src.matchAll(/\b(?:t|tCount|tNodes)\(\s*'(optionsSections\.[^']+)'/g)) {
        assert.ok(key in deSections || `${key}.other` in deSections, `${path.basename(file)}: ${key}`);
      }
    }
  });

  test('section files contain no hard-coded German UI text', () => {
    // Allowed: the starting prompt for new quick actions (an LLM prompt, de/en) and the
    // German fallback for the generic balance label returned by fetchBalance().
    const allowed = [/^\s*de: 'Bearbeite den folgenden Text/, /new Set\(\['Guthaben'/];
    for (const file of SECTION_FILES) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (line.trim().startsWith('//') || allowed.some((re) => re.test(line))) return;
        assert.doesNotMatch(line, /['`][^'`]*[äöüßÄÖÜ„][^'`]*['`]/, `${path.basename(file)}:${i + 1}`);
      });
    }
  });
});

describe('optionsSections texts follow the UI language', () => {
  test('German is the default, English after setLanguage("en")', () => {
    setLanguage('de');
    assert.equal(t('optionsSections.chat.systemPrompt.placeholder'), 'z. B. Antworte immer auf Deutsch und fasse dich kurz.');
    assert.equal(templateVariables()[0].description, 'der markierte Text');
    setLanguage('en');
    assert.equal(t('optionsSections.chat.systemPrompt.placeholder'), 'e.g. Always answer in English and keep it short.');
    assert.deepEqual(templateVariables()[0], { name: '{{text}}', description: 'the selected text' });
    setLanguage('de');
  });

  test('plural forms', () => {
    setLanguage('de');
    assert.equal(t('optionsSections.data.chats.count', { count: 1, n: '1' }), '1 gespeicherter Chat in diesem Browser.');
    assert.equal(t('optionsSections.data.chats.count', { count: 1234, n: '1.234' }), '1.234 gespeicherte Chats in diesem Browser.');
    assert.equal(t('optionsSections.quickActions.summary', { count: 3, toolbar: 2, menu: 1 }),
      '3 Aktionen · 2 in der Toolbar · 1 im Kontextmenü');
    setLanguage('en');
    assert.equal(t('optionsSections.translate.hosts.count', { count: 1, n: '1' }), '1 site excluded');
    assert.equal(t('optionsSections.translate.hosts.count', { count: 2, n: '2' }), '2 sites excluded');
    setLanguage('de');
  });
});
