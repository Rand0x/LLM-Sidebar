// Node-testable parts of the side panel (pure modules without DOM access at load time).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { chatToMarkdown, chatFilename } from '../src/sidepanel/export.js';
import { canPassThrough, dataUrlToObjectUrl, extensionForMime, mimeOfDataUrl } from '../src/sidepanel/attachments.js';
import { IMAGE_COMMAND } from '../src/sidepanel/composer.js';
import { dateGroup, daysAgo, relativeDay, shortTime } from '../src/sidepanel/format.js';
import { registerCatalog, setLanguage, t } from '../src/lib/i18n.js';
import en from '../src/locales/en/index.js';
import de from '../src/locales/de/index.js';

const msg = (partial) => ({ createdAt: Date.UTC(2026, 0, 2, 10, 0), attachments: [], images: [], ...partial });

describe('chatToMarkdown', () => {
  test('keeps blank lines inside code blocks and fenced user text', () => {
    const code = '```python\ndef a():\n    pass\n\n\ndef b():\n    pass\n```';
    const md = chatToMarkdown({
      title: 'Code',
      createdAt: Date.UTC(2026, 0, 2),
      messages: [
        msg({ role: 'user', content: 'Zeile 1\n\n\n- Punkt' }),
        msg({ role: 'assistant', content: `Hier:\n\n${code}\n` }),
      ],
    });
    assert.ok(md.includes('def a():\n    pass\n\n\ndef b():'), 'code block spacing preserved');
    assert.ok(md.includes('Zeile 1\n\n\n- Punkt'), 'fenced user text verbatim');
    assert.ok(md.endsWith('```\n'));
  });

  test('separates blocks by exactly one blank line', () => {
    const md = chatToMarkdown({
      title: 'Chat',
      messages: [
        msg({ role: 'user', content: '\n\nFrage\n\n' }),
        msg({ role: 'assistant', content: 'Antwort\n\n\n', reasoning: '\nDenken\n' }),
      ],
    });
    assert.doesNotMatch(md, /\n{3,}/);
    assert.ok(md.includes('Frage\n\n---'));
    assert.ok(md.includes('<details><summary>Gedankengang</summary>\n\nDenken\n\n</details>'));
  });

  test('skips malformed image entries (e.g. from imported chats)', () => {
    const md = chatToMarkdown({
      title: 'Bilder',
      messages: [msg({ role: 'assistant', kind: 'image', images: [null, { url: 'x' }, { src: 'data:image/png;base64,AAAA', prompt: 'Ein [Hund]' }] })],
    });
    assert.ok(md.includes('![Ein  Hund ](data:image/png;base64,AAAA)'));
    assert.equal(md.match(/!\[/g).length, 1);
  });

  test('a referenced page selection is exported as quote with its source', () => {
    const md = chatToMarkdown({
      title: 'Zitat',
      messages: [msg({ role: 'user', content: 'Was heißt das?', quote: { text: 'Zeile 1\nZeile 2', title: 'Artikel', url: 'https://x.test/a' } })],
    });
    assert.ok(md.includes('> Markierter Text auf [Artikel](https://x.test/a):\n>\n> Zeile 1\n> Zeile 2\n\nWas heißt das?'));
    const plain = chatToMarkdown({ title: 'Z', messages: [msg({ role: 'user', content: 'x', quote: { text: 'Nur', title: '', url: '' } })] });
    assert.ok(plain.includes('> Markierter Text:\n>\n> Nur'));
  });

  test('filename slug', () => {
    assert.match(chatFilename({ title: 'Größe & Maß!' }), /^grosse-mass-\d{4}-\d{2}-\d{2}\.md$/);
  });
});

describe('attachments', () => {
  test('only small JPEG/PNG pass through unchanged – WebP, GIF and others are re-encoded', () => {
    const small = { width: 800, height: 600, size: 200_000 };
    assert.equal(canPassThrough({ ...small, type: 'image/jpeg' }), true);
    assert.equal(canPassThrough({ ...small, type: 'image/PNG' }), true);
    for (const type of ['image/webp', 'image/gif', 'image/bmp', 'image/avif', 'image/svg+xml', '']) {
      assert.equal(canPassThrough({ ...small, type }), false, type);
    }
    assert.equal(canPassThrough({ type: 'image/png', width: 1601, height: 10, size: 1000 }), false);
    assert.equal(canPassThrough({ type: 'image/jpeg', width: 100, height: 100, size: 4 * 1024 * 1024 }), false);
  });

  test('dataUrlToObjectUrl accepts raster images only', async () => {
    const png = dataUrlToObjectUrl('data:image/png;base64,iVBORw0KGgo=');
    assert.match(png, /^blob:/);
    URL.revokeObjectURL(png);
    const withParams = dataUrlToObjectUrl('data:image/jpeg;name=a.jpg;base64,/9j/4A==');
    assert.match(withParams, /^blob:/);
    URL.revokeObjectURL(withParams);
    assert.equal(dataUrlToObjectUrl('data:text/html;base64,PGgxPmhpPC9oMT4='), '');
    assert.equal(dataUrlToObjectUrl('data:image/svg+xml;utf8,<svg onload="x()"></svg>'), '');
    assert.equal(dataUrlToObjectUrl('data:;base64,AAAA'), '');
    assert.equal(dataUrlToObjectUrl('data:image/png;base64,***'), '');
    assert.equal(dataUrlToObjectUrl('https://example.com/a.png'), '');
  });

  test('mime helpers', () => {
    assert.equal(mimeOfDataUrl('data:image/webp;base64,AAAA'), 'image/webp');
    assert.equal(extensionForMime('image/jpeg'), 'jpg');
    assert.equal(extensionForMime('image/gif'), 'gif');
    assert.equal(extensionForMime('image/png'), 'png');
  });
});

describe('i18n', () => {
  const english = (fn) => {
    registerCatalog('en', en);
    setLanguage('en');
    try {
      return fn();
    } finally {
      setLanguage('de');
    }
  };

  test('German and English side panel catalogs have the same keys and placeholders', () => {
    const keys = (catalog) => Object.keys(catalog).filter((k) => k.startsWith('sidepanel.')).sort();
    assert.deepEqual(keys(en), keys(de));
    const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
    for (const key of keys(de)) assert.equal(placeholders(en[key]), placeholders(de[key]), key);
  });

  test('the Markdown export follows the UI language', () => {
    const chat = {
      title: 'Chat',
      messages: [
        msg({ role: 'user', kind: 'image', content: 'cat', attachments: [{ dataUrl: 'data:image/png;base64,AA' }] }),
        msg({ role: 'assistant', content: '', reasoning: 'hmm', stopped: true, error: 'boom' }),
      ],
    };
    const german = chatToMarkdown(chat);
    assert.match(german, /^_Exportiert aus LLM Sidebar am /m);
    assert.ok(german.includes('### Du (Bildgenerierung) · '));
    assert.ok(german.includes('> Angehängt: Bild 1'));
    assert.ok(german.includes('_(Abgebrochen)_') && german.includes('> Fehler: boom'));

    const md = english(() => chatToMarkdown(chat));
    assert.match(md, /^_Exported from LLM Sidebar on .+ · Chat started on .+_$/m);
    assert.ok(md.includes('### You (image generation) · '));
    assert.ok(md.includes('> Attached: Image 1'));
    assert.ok(md.includes('### Assistant · '));
    assert.ok(md.includes('<details><summary>Reasoning</summary>'));
    assert.ok(md.includes('_(Stopped)_') && md.includes('> Error: boom'));
    assert.doesNotMatch(md, /Du|Assistent|Gedankengang|Abgebrochen|Fehler/);
  });

  test('plural forms', () => {
    assert.equal(t('sidepanel.history.messages', { count: 1 }), '1 Nachricht');
    assert.equal(t('sidepanel.history.messages', { count: 3 }), '3 Nachrichten');
    assert.equal(english(() => t('sidepanel.edit.replaces', { count: 2 })), 'The following 2 messages will be replaced.');
    assert.equal(english(() => t('sidepanel.history.exported', { count: 1 })), '1 chat exported.');
  });

  test('/bild and /image both start an image prompt', () => {
    for (const text of ['/bild ein Hund', '/image a dog', '/IMAGE', '/Bild']) assert.ok(IMAGE_COMMAND.test(text), text);
    for (const text of ['/bilder', '/imagine x', 'bild', ' /image']) assert.ok(!IMAGE_COMMAND.test(text), text);
  });
});

describe('date formatting', () => {
  const now = new Date(2026, 4, 15, 12, 0).getTime();
  const at = (days, hour = 9) => new Date(2026, 4, 15 - days, hour, 30).getTime();

  test('history groups', () => {
    assert.equal(daysAgo(at(0), now), 0);
    assert.equal(dateGroup(at(0), now), 'today');
    assert.equal(dateGroup(at(1, 23), now), 'yesterday');
    assert.equal(dateGroup(at(6), now), 'week');
    assert.equal(dateGroup(at(7), now), 'older');
  });

  test('times and dates follow the UI language', () => {
    assert.equal(shortTime(at(0), now), '09:30');
    assert.equal(shortTime(at(30), now), '15.04.2026');
    assert.equal(relativeDay(at(1), now), 'gestern');
    assert.equal(relativeDay(at(3), now), 'vor 3 Tagen');
    registerCatalog('en', en);
    setLanguage('en');
    try {
      assert.equal(shortTime(at(30), now), '04/15/2026');
      assert.equal(relativeDay(at(1), now), 'yesterday');
      assert.equal(relativeDay(at(3), now), '3 days ago');
      assert.match(shortTime(at(0), now), /^09:30\s?AM$/);
    } finally {
      setLanguage('de');
    }
  });
});
