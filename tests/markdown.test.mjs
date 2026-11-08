import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/lib/markdown.js';
import { registerCatalog, setLanguage } from '../src/lib/i18n.js';
import en from '../src/locales/en/index.js';

const md = (s, opts) => renderMarkdown(s, opts);

const codeBlock = (code, lang = '') =>
  '<div class="code-block"><div class="code-head">'
  + `<span class="code-lang">${lang || 'Code'}</span>`
  + '<button class="copy-code" type="button" title="Code kopieren">Kopieren</button></div>'
  + `<pre><code${lang ? ` class="language-${lang.toLowerCase()}"` : ''}>${code}</code></pre></div>`;

const A = (href, text, title = '') =>
  `<a href="${href}"${title ? ` title="${title}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`;

// ---------------------------------------------------------------------------
// Structural safety validator: every tag/attribute must come from the renderer's vocabulary,
// all text must be escaped and every URL must satisfy the allow-list.

const ALLOWED = {
  p: [], br: [], strong: [], em: [], del: [], code: ['class'], pre: [], hr: [], blockquote: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  ul: ['class'], ol: ['start', 'class'], li: ['class'], input: ['type', 'checked', 'disabled'],
  a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'title', 'loading', 'referrerpolicy'],
  div: ['class'], span: ['class'], button: ['class', 'type', 'title'],
  table: [], thead: [], tbody: [], tr: [], th: ['style'], td: ['style'],
};
const VOID = new Set(['br', 'hr', 'img', 'input']);
const TAG_RE = /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>/y;
const ATTR_RE = /\s+([a-z-]+)(?:="([^"]*)")?/g;

function decodeAttr(v) {
  return v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function assertSafeHtml(html, input = '') {
  const ctx = () => `\ninput: ${JSON.stringify(input).slice(0, 300)}\nhtml: ${html.slice(0, 600)}`;
  const stack = [];
  let i = 0;
  while (i <= html.length) {
    const lt = html.indexOf('<', i);
    const text = html.slice(i, lt < 0 ? html.length : lt);
    assert.ok(!/[<>"']/.test(text), `unescaped character in text: ${JSON.stringify(text)}${ctx()}`);
    assert.ok(!/&(?!(?:amp|lt|gt|quot|#39);)/.test(text), `raw ampersand in text${ctx()}`);
    if (lt < 0) break;
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(html);
    assert.ok(m, `unparseable tag at ${lt}: ${html.slice(lt, lt + 60)}${ctx()}`);
    const [, closing, name, attrs] = m;
    assert.ok(Object.hasOwn(ALLOWED, name), `tag <${name}> not allowed${ctx()}`);
    if (closing) {
      assert.equal(stack.pop(), name, `mismatched </${name}>${ctx()}`);
    } else {
      const seen = new Set();
      for (const [, an, av = ''] of attrs.matchAll(ATTR_RE)) {
        assert.ok(ALLOWED[name].includes(an), `attribute ${an} on <${name}>${ctx()}`);
        seen.add(an);
        const val = decodeAttr(av);
        assert.ok(!/[\u0000-\u001f]/.test(val), `control char in ${an}${ctx()}`);
        if (an === 'href') assert.match(val, /^(?:https?:\/\/[^\s/?#]+[^\s]*|mailto:\S+)$/, `bad href ${val}${ctx()}`);
        if (an === 'src') {
          assert.match(val, /^(?:https:\/\/[^\s/?#]+\S*|data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*)$/i, `bad src ${val}${ctx()}`);
        }
        if (an === 'style') assert.match(val, /^text-align:(?:left|center|right)$/, `bad style${ctx()}`);
        if (an === 'class') assert.match(val, /^[\w+#. -]+$/, `bad class${ctx()}`);
        if (an === 'target') assert.equal(val, '_blank');
        if (an === 'rel') assert.equal(val, 'noopener noreferrer');
        if (an === 'type') assert.ok(['checkbox', 'button'].includes(val), `bad type${ctx()}`);
        if (an === 'start') assert.match(val, /^\d{1,9}$/);
        if (an === 'loading') assert.equal(val, 'lazy');
      }
      if (name === 'a') {
        assert.ok(seen.has('href') && seen.has('target') && seen.has('rel'), `incomplete <a>${ctx()}`);
        assert.ok(!stack.includes('a'), `nested <a>${ctx()}`);
      }
      if (name === 'img') assert.ok(seen.has('src') && seen.has('alt') && seen.has('loading'), `incomplete <img>${ctx()}`);
      if (!VOID.has(name)) stack.push(name);
    }
    i = lt + m[0].length;
  }
  assert.deepEqual(stack, [], `unclosed tags${ctx()}`);
}

function safe(input, opts) {
  const html = md(input, opts);
  assertSafeHtml(html, input);
  return html;
}

// ---------------------------------------------------------------------------

describe('basics', () => {
  test('empty and non-string input', () => {
    assert.equal(md(''), '');
    assert.equal(md('   \n\t\n'), '');
    assert.equal(md(null), '');
    assert.equal(md(undefined), '');
    assert.equal(md(42), '<p>42</p>');
  });

  test('paragraphs with chat-style line breaks', () => {
    assert.equal(md('Hallo Welt'), '<p>Hallo Welt</p>');
    assert.equal(md('eins\nzwei\ndrei'), '<p>eins<br>zwei<br>drei</p>');
    assert.equal(md('eins\n\nzwei'), '<p>eins</p>\n<p>zwei</p>');
    assert.equal(md('  eingerückt\n   weiter  '), '<p>eingerückt<br>weiter</p>');
    assert.equal(md('a\r\nb\rc'), '<p>a<br>b<br>c</p>');
  });

  test('hard breaks (two spaces, backslash) and <br> tags', () => {
    assert.equal(md('a  \nb'), '<p>a<br>b</p>');
    assert.equal(md('a\\\nb'), '<p>a<br>b</p>');
    assert.equal(md('x<br>y<br/>z<BR />w'), '<p>x<br>y<br>z<br>w</p>');
    assert.equal(md('<br onclick="x">'), '<p>&lt;br onclick=&quot;x&quot;&gt;</p>');
  });

  test('raw HTML is shown escaped', () => {
    assert.equal(md('<b>fett</b>'), '<p>&lt;b&gt;fett&lt;/b&gt;</p>');
    assert.equal(md('<div>\nblock\n</div>'), '<p>&lt;div&gt;<br>block<br>&lt;/div&gt;</p>');
    assert.equal(md('<!-- comment -->'), '<p>&lt;!-- comment --&gt;</p>');
    assert.equal(md('a & b "c" \'d\''), '<p>a &amp; b &quot;c&quot; &#39;d&#39;</p>');
  });

  test('NUL characters are replaced', () => {
    assert.equal(md('a\u0000b'), '<p>a\uFFFDb</p>');
  });

  test('backslash escapes', () => {
    assert.equal(md('\\*nicht kursiv\\*'), '<p>*nicht kursiv*</p>');
    assert.equal(md('\\# kein Titel'), '<p># kein Titel</p>');
    assert.equal(md('\\[kein](link)'), '<p>[kein](link)</p>');
    assert.equal(md('C:\\Pfad\\datei'), '<p>C:\\Pfad\\datei</p>');
    assert.equal(md('\\<script>'), '<p>&lt;script&gt;</p>');
  });

  test('character references are decoded and re-escaped', () => {
    assert.equal(md('&amp; &lt;b&gt; &copy; &#x41; &#66; &auml;'), '<p>&amp; &lt;b&gt; © A B ä</p>');
    assert.equal(md('&bogus; &#0; &'), '<p>&amp;bogus; \uFFFD &amp;</p>');
    assert.equal(md('&lt;script&gt;alert(1)&lt;/script&gt;'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  test('inline math is left as text', () => {
    assert.equal(md('$a_1 + b_2$ und $$x$$'), '<p>$a_1 + b_2$ und $$x$$</p>');
  });

  test('never throws on odd input types', () => {
    assert.doesNotThrow(() => md({ toString: () => '**x**' }));
    assert.equal(md({ toString: () => '**x**' }), '<p><strong>x</strong></p>');
  });
});

describe('headings', () => {
  test('ATX headings h1-h6', () => {
    for (let l = 1; l <= 6; l++) assert.equal(md(`${'#'.repeat(l)} Titel`), `<h${l}>Titel</h${l}>`);
  });

  test('closing hashes, inline content, edge cases', () => {
    assert.equal(md('## Titel ##'), '<h2>Titel</h2>');
    assert.equal(md('## Titel #nicht'), '<h2>Titel #nicht</h2>');
    assert.equal(md('# C\\#'), '<h1>C#</h1>');
    assert.equal(md('# **fett** `code`'), '<h1><strong>fett</strong> <code>code</code></h1>');
    assert.equal(md('#'), '<h1></h1>');
    assert.equal(md('#hashtag'), '<p>#hashtag</p>');
    assert.equal(md('####### sieben'), '<p>####### sieben</p>');
    assert.equal(md('    # code'), codeBlock('# code'));
  });

  test('setext headings', () => {
    assert.equal(md('Titel\n====='), '<h1>Titel</h1>');
    assert.equal(md('Titel\n---\nText'), '<h2>Titel</h2>\n<p>Text</p>');
    // a lone "-" is treated as an incoming list item while streaming
    assert.equal(md('Text\n-'), '<p>Text<br>-</p>');
  });

  test('headings interrupt paragraphs', () => {
    assert.equal(md('Absatz\n# Titel\nmehr'), '<p>Absatz</p>\n<h1>Titel</h1>\n<p>mehr</p>');
  });
});

describe('emphasis', () => {
  test('bold, italic, strike', () => {
    assert.equal(md('**fett** __fett__'), '<p><strong>fett</strong> <strong>fett</strong></p>');
    assert.equal(md('*kursiv* _kursiv_'), '<p><em>kursiv</em> <em>kursiv</em></p>');
    assert.equal(md('~~weg~~'), '<p><del>weg</del></p>');
    assert.equal(md('***beides***'), '<p><em><strong>beides</strong></em></p>');
    assert.equal(md('**fett *kursiv* fett**'), '<p><strong>fett <em>kursiv</em> fett</strong></p>');
    assert.equal(md('*a **b** c*'), '<p><em>a <strong>b</strong> c</em></p>');
    assert.equal(md('~~**beides**~~'), '<p><del><strong>beides</strong></del></p>');
  });

  test('intraword rules', () => {
    assert.equal(md('snake_case_name'), '<p>snake_case_name</p>');
    assert.equal(md('__init__ ist _toll_'), '<p><strong>init</strong> ist <em>toll</em></p>');
    assert.equal(md('foo*bar*baz'), '<p>foo<em>bar</em>baz</p>');
    assert.equal(md('2 * 3 * 4'), '<p>2 * 3 * 4</p>');
    assert.equal(md('~5 bis ~10 Minuten'), '<p>~5 bis ~10 Minuten</p>');
    assert.equal(md('a ~~~drei~~~'), '<p>a ~~~drei~~~</p>');
    assert.equal(md('a ~weg~'), '<p>a ~weg~</p>');
  });

  test('emphasis spans soft line breaks', () => {
    assert.equal(md('**zwei\nZeilen**'), '<p><strong>zwei<br>Zeilen</strong></p>');
  });

  test('unclosed delimiters degrade to text (streaming)', () => {
    assert.equal(md('**fett'), '<p>**fett</p>');
    assert.equal(md('*kursiv und **fett'), '<p>*kursiv und **fett</p>');
    assert.equal(md('~~weg'), '<p>~~weg</p>');
    assert.equal(md('**fett** und *'), '<p><strong>fett</strong> und *</p>');
  });

  test('rule of three', () => {
    assert.equal(md('*foo**bar**baz*'), '<p><em>foo<strong>bar</strong>baz</em></p>');
    assert.equal(md('**foo*'), '<p>*<em>foo</em></p>');
  });
});

describe('code spans', () => {
  test('content is escaped and not parsed', () => {
    assert.equal(md('`a <b> & *c*`'), '<p><code>a &lt;b&gt; &amp; *c*</code></p>');
    assert.equal(md('`[x](javascript:alert(1))`'), '<p><code>[x](javascript:alert(1))</code></p>');
    assert.equal(md('`&amp;`'), '<p><code>&amp;amp;</code></p>');
    assert.equal(md('`\\*`'), '<p><code>\\*</code></p>');
    assert.equal(md('`https://example.com`'), '<p><code>https://example.com</code></p>');
  });

  test('backtick runs', () => {
    assert.equal(md('``a ` b``'), '<p><code>a ` b</code></p>');
    assert.equal(md('`` `x` ``'), '<p><code>`x`</code></p>');
    assert.equal(md('`zwei\nZeilen`'), '<p><code>zwei Zeilen</code></p>');
    assert.equal(md('`offen'), '<p>`offen</p>');
    assert.equal(md('```nicht``'), '<p>```nicht``</p>');
  });

  test('code spans bind tighter than emphasis and links', () => {
    assert.equal(md('*a `*` b*'), '<p><em>a <code>*</code> b</em></p>');
    assert.equal(md('[`a]`](https://x.de)'), `<p>${A('https://x.de/', '<code>a]</code>')}</p>`);
  });
});

describe('code blocks', () => {
  test('exact fenced markup with language', () => {
    assert.equal(md('```js\nconst a = 1;\n```'), codeBlock('const a = 1;', 'js'));
  });

  test('no language, tildes, longer fences', () => {
    assert.equal(md('```\nplain\n```'), codeBlock('plain'));
    assert.equal(md('~~~python\nprint(1)\n~~~'), codeBlock('print(1)', 'python'));
    assert.equal(md('````\n```\ninnen\n```\n````'), codeBlock('```\ninnen\n```'));
    assert.equal(md('```\na\n`````'), codeBlock('a'));
    assert.equal(md('~~~\na\n```\nb\n~~~'), codeBlock('a\n```\nb'));
  });

  test('language label normalisation', () => {
    assert.equal(md('```JavaScript title="x"\nx\n```'), codeBlock('x', 'JavaScript'));
    assert.equal(md('```c++\nx\n```'), codeBlock('x', 'c++'));
    assert.equal(md('```{.rust}\nx\n```'), codeBlock('x', 'rust'));
    assert.equal(md('```"><img src=x onerror=alert(1)>\nx\n```'), codeBlock('x', 'img'));
  });

  test('HTML and markdown inside code blocks is escaped verbatim', () => {
    assert.equal(
      md('```html\n<script>alert("x")</script>\n**nicht fett** &amp;\n```'),
      codeBlock('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;\n**nicht fett** &amp;amp;', 'html'),
    );
  });

  test('preserves inner indentation and blank lines, strips fence indentation', () => {
    assert.equal(md('```\nif (a) {\n\n    b();\n}\n```'), codeBlock('if (a) {\n\n    b();\n}'));
    assert.equal(md('  ```\n  a\n    b\n c\n  ```'), codeBlock('a\n  b\nc'));
    assert.equal(md('```\n\tgo\n```'), codeBlock('\tgo'));
  });

  test('unterminated fence renders as code until the end (streaming)', () => {
    assert.equal(md('Text\n\n```js\nconst a = 1;\nconst b'), '<p>Text</p>\n' + codeBlock('const a = 1;\nconst b', 'js'));
    assert.equal(md('```\nunterminated\n'), codeBlock('unterminated'));
    assert.equal(md('```py'), codeBlock('', 'py'));
  });

  test('backtick fence info may not contain backticks', () => {
    assert.equal(md('``` a`b\nc'), '<p>``` a`b<br>c</p>');
  });

  test('fences interrupt paragraphs', () => {
    assert.equal(md('Beispiel:\n```\nx\n```\nDanach'), '<p>Beispiel:</p>\n' + codeBlock('x') + '\n<p>Danach</p>');
  });

  test('indented code blocks', () => {
    assert.equal(md('    a\n\n    b\n\nText'), codeBlock('a\n\nb') + '\n<p>Text</p>');
    assert.equal(md('Absatz\n    keine Code-Zeile'), '<p>Absatz<br>keine Code-Zeile</p>');
    assert.equal(md('\tTab'), codeBlock('Tab'));
  });
});

describe('horizontal rules', () => {
  test('variants', () => {
    assert.equal(md('---'), '<hr>');
    assert.equal(md('***'), '<hr>');
    assert.equal(md('___'), '<hr>');
    assert.equal(md('- - -'), '<hr>');
    assert.equal(md(' * * * *'), '<hr>');
    assert.equal(md('a\n\n---\n\nb'), '<p>a</p>\n<hr>\n<p>b</p>');
    assert.equal(md('--'), '<p>--</p>');
    assert.equal(md('-*-'), '<p>-*-</p>');
  });

  test('hr ends a list', () => {
    assert.equal(md('- a\n* * *\n- b'), '<ul>\n<li>a</li>\n</ul>\n<hr>\n<ul>\n<li>b</li>\n</ul>');
  });
});

describe('blockquotes', () => {
  test('simple and multi-line', () => {
    assert.equal(md('> Zitat'), '<blockquote>\n<p>Zitat</p>\n</blockquote>');
    assert.equal(md('> a\n> b'), '<blockquote>\n<p>a<br>b</p>\n</blockquote>');
    assert.equal(md('>ohne Leerzeichen'), '<blockquote>\n<p>ohne Leerzeichen</p>\n</blockquote>');
    assert.equal(md('> a\n>\n> b'), '<blockquote>\n<p>a</p>\n<p>b</p>\n</blockquote>');
  });

  test('lazy continuation', () => {
    assert.equal(md('> a\nb'), '<blockquote>\n<p>a<br>b</p>\n</blockquote>');
    assert.equal(md('> a\n===\n'), '<blockquote>\n<p>a<br>===</p>\n</blockquote>');
    assert.equal(md('> a\n\nb'), '<blockquote>\n<p>a</p>\n</blockquote>\n<p>b</p>');
    assert.equal(md('> a\n# b'), '<blockquote>\n<p>a</p>\n</blockquote>\n<h1>b</h1>');
    assert.equal(md('> a\n- b'), '<blockquote>\n<p>a</p>\n</blockquote>\n<ul>\n<li>b</li>\n</ul>');
  });

  test('nested', () => {
    assert.equal(
      md('> a\n> > b\n> > c\n> d'),
      '<blockquote>\n<p>a</p>\n<blockquote>\n<p>b<br>c<br>d</p>\n</blockquote>\n</blockquote>',
    );
    assert.equal(md('>>> tief'), '<blockquote>\n<blockquote>\n<blockquote>\n<p>tief</p>\n</blockquote>\n</blockquote>\n</blockquote>');
  });

  test('containing lists, code and headings', () => {
    assert.equal(
      md('> ## Titel\n> - eins\n> - zwei\n>\n> ```js\n> x\n> ```'),
      '<blockquote>\n<h2>Titel</h2>\n<ul>\n<li>eins</li>\n<li>zwei</li>\n</ul>\n' + codeBlock('x', 'js') + '\n</blockquote>',
    );
  });

  test('code inside a quote does not swallow following lines', () => {
    assert.equal(md('> ```\n> code\nplain'), '<blockquote>\n' + codeBlock('code') + '\n</blockquote>\n<p>plain</p>');
  });
});

describe('lists', () => {
  test('unordered with all markers', () => {
    assert.equal(md('- a\n- b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    assert.equal(md('* a\n* b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    assert.equal(md('+ a\n+ b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
  });

  test('changing the bullet starts a new list', () => {
    assert.equal(md('- a\n* b'), '<ul>\n<li>a</li>\n</ul>\n<ul>\n<li>b</li>\n</ul>');
  });

  test('ordered lists, start attribute and ) delimiter', () => {
    assert.equal(md('1. a\n2. b'), '<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
    assert.equal(md('3. a\n4. b'), '<ol start="3">\n<li>a</li>\n<li>b</li>\n</ol>');
    assert.equal(md('1) a\n2) b'), '<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
    assert.equal(md('1. a\n1) b'), '<ol>\n<li>a</li>\n</ol>\n<ol>\n<li>b</li>\n</ol>');
    assert.equal(md('0. null'), '<ol start="0">\n<li>null</li>\n</ol>');
    assert.equal(md('1234567890. zu lang'), '<p>1234567890. zu lang</p>');
  });

  test('lists interrupt paragraphs (ordered only when starting at 1)', () => {
    assert.equal(md('Schritte:\n1. eins\n2. zwei'), '<p>Schritte:</p>\n<ol>\n<li>eins</li>\n<li>zwei</li>\n</ol>');
    assert.equal(md('Punkte:\n- a'), '<p>Punkte:</p>\n<ul>\n<li>a</li>\n</ul>');
    assert.equal(md('Im Jahr\n2024. passierte'), '<p>Im Jahr<br>2024. passierte</p>');
    assert.equal(md('Text\n*'), '<p>Text<br>*</p>');
  });

  test('not list markers', () => {
    assert.equal(md('-nicht'), '<p>-nicht</p>');
    assert.equal(md('1.5 Liter'), '<p>1.5 Liter</p>');
    assert.equal(md('+1 dafür'), '<p>+1 dafür</p>');
    assert.equal(md('**fett** am Anfang'), '<p><strong>fett</strong> am Anfang</p>');
  });

  test('nesting by indentation (2, 3 and 4 spaces)', () => {
    assert.equal(md('- a\n  - b\n    - c\n- d'),
      '<ul>\n<li>a\n<ul>\n<li>b\n<ul>\n<li>c</li>\n</ul></li>\n</ul></li>\n<li>d</li>\n</ul>');
    assert.equal(md('1. a\n   - b\n2. c'), '<ol>\n<li>a\n<ul>\n<li>b</li>\n</ul></li>\n<li>c</li>\n</ol>');
    assert.equal(md('- a\n    - b\n        - c'), '<ul>\n<li>a\n<ul>\n<li>b\n<ul>\n<li>c</li>\n</ul></li>\n</ul></li>\n</ul>');
    assert.equal(md('1. a\n   1. b\n   2. c\n2. d'),
      '<ol>\n<li>a\n<ol>\n<li>b</li>\n<li>c</li>\n</ol></li>\n<li>d</li>\n</ol>');
  });

  test('lenient nesting for under-indented sub lists', () => {
    assert.equal(md('1. a\n  - b\n    - c\n2. d'),
      '<ol>\n<li>a\n<ul>\n<li>b\n<ul>\n<li>c</li>\n</ul></li>\n</ul></li>\n<li>d</li>\n</ol>');
    assert.equal(md('10. a\n  - b'), '<ol start="10">\n<li>a\n<ul>\n<li>b</li>\n</ul></li>\n</ol>');
    // one extra space is a sibling (CommonMark)
    assert.equal(md('- a\n - b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
  });

  test('item continuation, lazy lines and multiple paragraphs', () => {
    assert.equal(md('- a\n  weiter'), '<ul>\n<li>a<br>weiter</li>\n</ul>');
    assert.equal(md('- a\nlazy'), '<ul>\n<li>a<br>lazy</li>\n</ul>');
    assert.equal(md('1. a\n\n   b\n2. c'), '<ol>\n<li><p>a</p>\n<p>b</p></li>\n<li><p>c</p></li>\n</ol>');
    assert.equal(md('- a\n\nAbsatz'), '<ul>\n<li>a</li>\n</ul>\n<p>Absatz</p>');
  });

  test('tight vs loose', () => {
    assert.equal(md('- a\n- b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    assert.equal(md('- a\n\n- b'), '<ul>\n<li><p>a</p></li>\n<li><p>b</p></li>\n</ul>');
    // a blank line inside a nested list only loosens the nested list
    assert.equal(md('- a\n  - b\n\n  - c\n- d'),
      '<ul>\n<li>a\n<ul>\n<li><p>b</p></li>\n<li><p>c</p></li>\n</ul></li>\n<li>d</li>\n</ul>');
  });

  test('code blocks inside list items', () => {
    assert.equal(md('1. Installieren:\n   ```bash\n   npm i\n   ```\n2. Starten'),
      '<ol>\n<li>Installieren:\n' + codeBlock('npm i', 'bash') + '</li>\n<li>Starten</li>\n</ol>');
    assert.equal(md('- a\n  ```\n  x\n\n  y\n  ```\n- b'),
      '<ul>\n<li>a\n' + codeBlock('x\n\ny') + '</li>\n<li>b</li>\n</ul>');
    // unindented fence ends the list, numbering continues through start=
    assert.equal(md('1. a\n```\nx\n```\n2. b'),
      '<ol>\n<li>a</li>\n</ol>\n' + codeBlock('x') + '\n<ol start="2">\n<li>b</li>\n</ol>');
  });

  test('blockquote inside list item and list inside blockquote', () => {
    assert.equal(md('- a\n  > zitat'), '<ul>\n<li>a\n<blockquote>\n<p>zitat</p>\n</blockquote></li>\n</ul>');
    assert.equal(md('> 1. a\n>    - b'), '<blockquote>\n<ol>\n<li>a\n<ul>\n<li>b</li>\n</ul></li>\n</ol>\n</blockquote>');
  });

  test('empty items and streaming partial markers', () => {
    assert.equal(md('-'), '<ul>\n<li></li>\n</ul>');
    assert.equal(md('1.'), '<ol>\n<li></li>\n</ol>');
    assert.equal(md('- a\n-'), '<ul>\n<li>a</li>\n<li></li>\n</ul>');
  });

  test('task lists', () => {
    assert.equal(md('- [ ] offen\n- [x] fertig\n- [X] auch'),
      '<ul class="contains-task-list">\n'
      + '<li class="task-list-item"><input type="checkbox" disabled> offen</li>\n'
      + '<li class="task-list-item"><input type="checkbox" checked disabled> fertig</li>\n'
      + '<li class="task-list-item"><input type="checkbox" checked disabled> auch</li>\n</ul>');
    assert.equal(md('- [ ] a\n\n- [x] b'),
      '<ul class="contains-task-list">\n<li class="task-list-item"><p><input type="checkbox" disabled> a</p></li>\n'
      + '<li class="task-list-item"><p><input type="checkbox" checked disabled> b</p></li>\n</ul>');
    assert.equal(md('1. [x] nummeriert'),
      '<ol class="contains-task-list">\n<li class="task-list-item"><input type="checkbox" checked disabled> nummeriert</li>\n</ol>');
    assert.equal(md('- [x](https://a.de)'), `<ul>\n<li>${A('https://a.de/', 'x')}</li>\n</ul>`);
    assert.equal(md('- [y] kein Task'), '<ul>\n<li>[y] kein Task</li>\n</ul>');
    assert.equal(md('[ ] kein Listeneintrag'), '<p>[ ] kein Listeneintrag</p>');
  });

  test('tabs as indentation', () => {
    assert.equal(md('-\ta\n\t-\tb'), '<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul></li>\n</ul>');
  });
});

describe('tables', () => {
  test('basic table with alignment', () => {
    assert.equal(md('| Name | Wert | Mitte |\n|:-----|-----:|:----:|\n| a | 1 | x |\n| b | 2 | y |'),
      '<div class="table-wrap"><table>\n<thead>\n<tr><th style="text-align:left">Name</th>'
      + '<th style="text-align:right">Wert</th><th style="text-align:center">Mitte</th></tr>\n</thead>\n<tbody>\n'
      + '<tr><td style="text-align:left">a</td><td style="text-align:right">1</td><td style="text-align:center">x</td></tr>\n'
      + '<tr><td style="text-align:left">b</td><td style="text-align:right">2</td><td style="text-align:center">y</td></tr>\n'
      + '</tbody>\n</table></div>');
  });

  test('without outer pipes, no alignment, header only', () => {
    assert.equal(md('a | b\n--- | ---\n1 | 2'),
      '<div class="table-wrap"><table>\n<thead>\n<tr><th>a</th><th>b</th></tr>\n</thead>\n<tbody>\n'
      + '<tr><td>1</td><td>2</td></tr>\n</tbody>\n</table></div>');
    assert.equal(md('| a |\n|---|'), '<div class="table-wrap"><table>\n<thead>\n<tr><th>a</th></tr>\n</thead>\n</table></div>');
  });

  test('missing cells are padded, extra cells dropped', () => {
    assert.equal(md('|a|b|\n|-|-|\n|1|\n|1|2|3|'),
      '<div class="table-wrap"><table>\n<thead>\n<tr><th>a</th><th>b</th></tr>\n</thead>\n<tbody>\n'
      + '<tr><td>1</td><td></td></tr>\n<tr><td>1</td><td>2</td></tr>\n</tbody>\n</table></div>');
  });

  test('inline markdown and escaped pipes in cells', () => {
    assert.equal(md('| Code | Info |\n|---|---|\n| `a \\| b` | **fett** [l](https://x.de) |\n| x<br>y | a \\| b |'),
      '<div class="table-wrap"><table>\n<thead>\n<tr><th>Code</th><th>Info</th></tr>\n</thead>\n<tbody>\n'
      + `<tr><td><code>a | b</code></td><td><strong>fett</strong> ${A('https://x.de/', 'l')}</td></tr>\n`
      + '<tr><td>x<br>y</td><td>a | b</td></tr>\n</tbody>\n</table></div>');
  });

  test('table ends at blank line or non-table line', () => {
    assert.equal(md('|a|\n|-|\n|1|\nText danach'),
      '<div class="table-wrap"><table>\n<thead>\n<tr><th>a</th></tr>\n</thead>\n<tbody>\n<tr><td>1</td></tr>\n</tbody>\n</table></div>\n<p>Text danach</p>');
  });

  test('table directly after a paragraph line', () => {
    assert.equal(md('Übersicht:\n| a | b |\n|---|---|\n| 1 | 2 |'),
      '<p>Übersicht:</p>\n<div class="table-wrap"><table>\n<thead>\n<tr><th>a</th><th>b</th></tr>\n</thead>\n<tbody>\n'
      + '<tr><td>1</td><td>2</td></tr>\n</tbody>\n</table></div>');
  });

  test('not a table', () => {
    assert.equal(md('| a | b |\n|---|'), '<p>| a | b |<br>|---|</p>');
    assert.equal(md('| a | b |\n| x | y |'), '<p>| a | b |<br>| x | y |</p>');
    assert.equal(md('| a |'), '<p>| a |</p>');
  });

  test('streaming: partial delimiter row is a paragraph', () => {
    assert.equal(md('| a | b |\n|--'), '<p>| a | b |<br>|--</p>');
  });

  test('tables inside list items and blockquotes', () => {
    const html = md('> | a |\n> |---|\n> | 1 |');
    assert.ok(html.startsWith('<blockquote>\n<div class="table-wrap"><table>'));
  });
});

describe('links', () => {
  test('inline links get target and rel', () => {
    assert.equal(md('[Seite](https://example.com)'), `<p>${A('https://example.com/', 'Seite')}</p>`);
    assert.equal(md('[Seite](http://example.com/a?b=1&c=2#d)'), `<p>${A('http://example.com/a?b=1&amp;c=2#d', 'Seite')}</p>`);
    assert.equal(md('[Mail](mailto:info@example.com)'), `<p>${A('mailto:info@example.com', 'Mail')}</p>`);
  });

  test('titles', () => {
    assert.equal(md('[a](https://x.de "Ti\ntel")'), `<p>${A('https://x.de/', 'a', 'Ti tel')}</p>`);
    assert.equal(md('[a](https://x.de "Titel")'), `<p>${A('https://x.de/', 'a', 'Titel')}</p>`);
    assert.equal(md("[a](https://x.de 'Titel')"), `<p>${A('https://x.de/', 'a', 'Titel')}</p>`);
    assert.equal(md('[a](https://x.de (Titel))'), `<p>${A('https://x.de/', 'a', 'Titel')}</p>`);
    assert.equal(md('[a](https://x.de "Ti\\"tel")'), `<p>${A('https://x.de/', 'a', 'Ti&quot;tel')}</p>`);
  });

  test('destinations: angle brackets, parentheses, escapes, entities', () => {
    assert.equal(md('[a](<https://x.de/mit leer>)'), `<p>${A('https://x.de/mit%20leer', 'a')}</p>`);
    assert.equal(md('[W](https://de.wikipedia.org/wiki/Foo_(Bar))'), `<p>${A('https://de.wikipedia.org/wiki/Foo_(Bar)', 'W')}</p>`);
    assert.equal(md('[a](https://x.de/\\(y)'), `<p>${A('https://x.de/(y', 'a')}</p>`);
    assert.equal(md('[a](https://x.de/?a=1&amp;b=2)'), `<p>${A('https://x.de/?a=1&amp;b=2', 'a')}</p>`);
    assert.equal(md('[a]( https://x.de )'), `<p>${A('https://x.de/', 'a')}</p>`);
  });

  test('formatting inside link text', () => {
    assert.equal(md('[**fett** `c`](https://x.de)'), `<p>${A('https://x.de/', '<strong>fett</strong> <code>c</code>')}</p>`);
    assert.equal(md('*[kursiv](https://x.de)*'), `<p><em>${A('https://x.de/', 'kursiv')}</em></p>`);
    assert.equal(md('**[a](https://x.de)**'), `<p><strong>${A('https://x.de/', 'a')}</strong></p>`);
  });

  test('emphasis cannot cross link boundaries', () => {
    assert.equal(md('*[a*](https://x.de)'), `<p>*${A('https://x.de/', 'a*')}</p>`);
  });

  test('no nested anchors', () => {
    assert.equal(md('[https://a.de](https://b.de)'), `<p>${A('https://b.de/', 'https://a.de')}</p>`);
    assert.equal(md('[<https://a.de>](https://b.de)'), `<p>${A('https://b.de/', 'https://a.de')}</p>`);
    assert.equal(md('[a [b](https://b.de) c](https://a.de)'),
      `<p>[a ${A('https://b.de/', 'b')} c](${A('https://a.de/', 'https://a.de')})</p>`);
  });

  test('image inside a link', () => {
    assert.equal(md('[![Logo](https://x.de/l.png)](https://x.de)'),
      `<p>${A('https://x.de/', '<img src="https://x.de/l.png" alt="Logo" loading="lazy" referrerpolicy="no-referrer">')}</p>`);
  });

  test('disallowed or relative destinations render only the text', () => {
    assert.equal(md('[a](/relativ)'), '<p>a</p>');
    assert.equal(md('[a](#anker)'), '<p>a</p>');
    assert.equal(md('[a](//evil.com)'), '<p>a</p>');
    assert.equal(md('[a](\\\\evil.com)'), '<p>a</p>');
    assert.equal(md('[a](ftp://x.de)'), '<p>a</p>');
    assert.equal(md('[a]()'), '<p>a</p>');
    assert.equal(md('[a](mailto:)'), '<p>a</p>');
  });

  test('not links', () => {
    assert.equal(md('[nur Klammern]'), '<p>[nur Klammern]</p>');
    assert.equal(md('[ref][1]'), '<p>[ref][1]</p>');
    assert.equal(md('[a] (https://x.de)'), `<p>[a] (${A('https://x.de/', 'https://x.de')})</p>`);
    assert.equal(md('[a](https://x.de "offen'), `<p>[a](${A('https://x.de/', 'https://x.de')} &quot;offen</p>`);
  });

  test('unclosed links degrade gracefully (streaming)', () => {
    assert.equal(md('[Lin'), '<p>[Lin</p>');
    assert.equal(md('[Link]('), '<p>[Link](</p>');
    assert.equal(md('[Link](https://x.'), `<p>[Link](${A('https://x/', 'https://x')}.</p>`);
    assert.equal(md('![Bi'), '<p>![Bi</p>');
  });
});

describe('autolinks', () => {
  test('angle-bracket autolinks', () => {
    assert.equal(md('<https://example.com/a?b>'), `<p>${A('https://example.com/a?b', 'https://example.com/a?b')}</p>`);
    assert.equal(md('<mailto:a@b.de>'), `<p>${A('mailto:a@b.de', 'mailto:a@b.de')}</p>`);
    assert.equal(md('<info@example.com>'), `<p>${A('mailto:info@example.com', 'info@example.com')}</p>`);
    assert.equal(md('<ftp://x.de>'), '<p>&lt;ftp://x.de&gt;</p>');
    assert.equal(md('<javascript:alert(1)>'), '<p>&lt;javascript:alert(1)&gt;</p>');
  });

  test('bare URLs with trailing punctuation excluded', () => {
    assert.equal(md('Siehe https://example.com.'), `<p>Siehe ${A('https://example.com/', 'https://example.com')}.</p>`);
    assert.equal(md('(https://example.com/a)'), `<p>(${A('https://example.com/a', 'https://example.com/a')})</p>`);
    assert.equal(md('https://x.de/a_(b), ok?'), `<p>${A('https://x.de/a_(b)', 'https://x.de/a_(b)')}, ok?</p>`);
    assert.equal(md('"https://x.de/q?a=1&b=2"'), `<p>&quot;${A('https://x.de/q?a=1&amp;b=2', 'https://x.de/q?a=1&amp;b=2')}&quot;</p>`);
    assert.equal(md('**https://x.de**'), `<p><strong>${A('https://x.de/', 'https://x.de')}</strong></p>`);
    assert.equal(md('www.example.com!'), `<p>${A('https://www.example.com/', 'www.example.com')}!</p>`);
    assert.equal(md('[siehe https://x.de]'), `<p>[siehe ${A('https://x.de/', 'https://x.de')}]</p>`);
  });

  test('bare URL edge cases', () => {
    assert.equal(md('xhttps://x.de'), '<p>xhttps://x.de</p>');
    assert.equal(md('https://'), '<p>https://</p>');
    assert.equal(md('https://.'), '<p>https://.</p>');
    assert.equal(md('https://x.de/snake_case_pfad'), `<p>${A('https://x.de/snake_case_pfad', 'https://x.de/snake_case_pfad')}</p>`);
    assert.equal(md('HTTPS://X.DE'), `<p>${A('https://x.de/', 'HTTPS://X.DE')}</p>`);
    assert.equal(md('https://x.de<script>'), `<p>${A('https://x.de/', 'https://x.de')}&lt;script&gt;</p>`);
  });
});

describe('images', () => {
  test('https images are lazy', () => {
    assert.equal(md('![Alt](https://x.de/a.png "T")'),
      '<p><img src="https://x.de/a.png" alt="Alt" title="T" loading="lazy" referrerpolicy="no-referrer"></p>');
  });

  test('data:image allow-list', () => {
    assert.equal(md('![d](data:image/png;base64,iVBORw0KGgo=)'),
      '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="d" loading="lazy" referrerpolicy="no-referrer"></p>');
    for (const t of ['jpeg', 'jpg', 'gif', 'webp']) {
      assert.match(md(`![d](data:image/${t};base64,AAAA)`), /<img src="data:image\//);
    }
    assert.equal(md('![d](data:image/svg+xml;base64,PHN2Zz4=)'), '<p>d</p>');
    assert.equal(md('![d](data:text/html;base64,PHNjcmlwdD4=)'), '<p>d</p>');
    assert.equal(md('![d](data:image/png,rawdata)'), '<p>d</p>');
    assert.equal(md('![d](data:image/png;base64,ab"cd)'), '<p>d</p>');
  });

  test('alt text is plain text', () => {
    assert.equal(md('![**fett** `c` [l](https://x.de)](https://x.de/i.png)'),
      '<p><img src="https://x.de/i.png" alt="fett c l" loading="lazy" referrerpolicy="no-referrer"></p>');
    assert.equal(md('![a "quote" <b>](https://x.de/i.png)'),
      '<p><img src="https://x.de/i.png" alt="a &quot;quote&quot; &lt;b&gt;" loading="lazy" referrerpolicy="no-referrer"></p>');
  });

  test('http images become links, unsafe ones plain alt text', () => {
    assert.equal(md('![Alt](http://x.de/a.png)'), `<p>${A('http://x.de/a.png', 'Alt')}</p>`);
    assert.equal(md('![](http://x.de/a.png)'), `<p>${A('http://x.de/a.png', 'Bild')}</p>`);
    assert.equal(md('![Alt](javascript:alert(1))'), '<p>Alt</p>');
    assert.equal(md('![Alt](/relativ.png)'), '<p>Alt</p>');
  });

  test('control characters in alt text are collapsed', () => {
    assert.equal(md('![a\u0001b\tc](https://x.de/i.png)'),
      '<p><img src="https://x.de/i.png" alt="a b c" loading="lazy" referrerpolicy="no-referrer"></p>');
  });

  test('allowRemoteImages: false renders remote images as links', () => {
    assert.match(md('![Alt](https://x.de/a.png)', null), /<img /);
    assert.match(md('![Alt](https://x.de/a.png)', { allowRemoteImages: true }), /<img /);
    assert.equal(md('![Alt](https://x.de/a.png)', { allowRemoteImages: false }), `<p>${A('https://x.de/a.png', 'Alt')}</p>`);
    assert.match(md('![d](data:image/png;base64,AAAA)', { allowRemoteImages: false }), /<img src="data:image\/png/);
  });
});

describe('XSS vectors', () => {
  const vectors = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x]( javascript:alert(1))',
    '[x](<javascript:alert(1)>)',
    '[x](jav&#x09;ascript:alert(1))',
    '[x](jav&#9;ascript:alert(1))',
    '[x](&#106;avascript:alert(1))',
    '[x](&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;alert(1))',
    '[x](javascript&colon;alert(1))',
    '[x](jav\\ascript:alert(1))',
    '[x](java%0ascript:alert(1))',
    '[x](\u0001javascript:alert(1))',
    '[x](java\u200bscript:alert(1))',
    '[x](java\u00adscript:alert(1))',
    '[x](vbscript:msgbox(1))',
    '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[x](data:text/html,<script>alert(1)</script>)',
    '[x](file:///etc/passwd)',
    '[x](https://ok.de "x\\" onmouseover=\\"alert(1))',
    '[x](https://ok.de"onmouseover="alert(1))',
    '[x](https://ok.de/" onmouseover="alert(1))',
    '[x](<https://ok.de/" onclick="alert(1)>)',
    "[x](https://ok.de 'a\\' onclick=\\'alert(1)')",
    '![x](javascript:alert(1))',
    '![x" onerror="alert(1)](https://ok.de/a.png)',
    '![x](https://ok.de/a.png" onerror="alert(1))',
    '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
    '![x](data:image/png;base64,AAAA" onerror="alert(1))',
    '<javascript:alert(1)>',
    '<JAVASCRIPT:alert(1)>',
    '<vbscript:alert(1)>',
    '<https://ok.de/"onmouseover="alert(1)>',
    '[<img src=x onerror=alert(1)>](https://ok.de)',
    '[*<script>*](https://ok.de)',
    '**<script>alert(1)</script>**',
    '`<script>alert(1)</script>`',
    '```\n<script>alert(1)</script>\n```',
    '```<script>\nx\n```',
    '```js" onmouseover="alert(1)\nx\n```',
    '| <script> | x |\n|---|---|\n| <img src=x onerror=alert(1)> | [a](javascript:alert(1)) |',
    '- [x] <img src=x onerror=alert(1)>',
    '> <iframe src=javascript:alert(1)>',
    '# <script>alert(1)</script>',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    '&#60;script&#62;alert(1)&#60;/script&#62;',
    '\\<script>alert(1)\\</script>',
    'https://ok.de/"><script>alert(1)</script>',
    'www.ok.de/"onmouseover="alert(1)',
    '<br><script>alert(1)</script>',
    '<br onload=alert(1)>',
    '[a](https://ok.de)<img src=x onerror=alert(1)>',
    '![a](https://ok.de/a.png)<svg/onload=alert(1)>',
  ];

  for (const v of vectors) {
    test(`safe: ${JSON.stringify(v).slice(0, 70)}`, () => {
      const html = safe(v);
      assert.ok(!/javascript:|vbscript:|data:text/i.test(html.replace(/>[^<]*</g, '><')), `dangerous URL in markup: ${html}`);
      assert.ok(!/<(script|iframe|svg|object|embed|style|form)\b/i.test(html), `dangerous tag: ${html}`);
      // Attribute values are escaped text; only real attribute names matter.
      const tagsOnly = html.replace(/="[^"]*"/g, '=""');
      assert.ok(!/<[^>]*\son[a-z]+=/i.test(tagsOnly), `event handler attribute: ${html}`);
    });
  }

  test('javascript links keep only their text', () => {
    assert.equal(md('[klick](javascript:alert(1))'), '<p>klick</p>');
    assert.equal(md('[klick](jav&#x09;ascript:alert(1))'), '<p>klick</p>');
    assert.equal(md('[klick](JaVaScRiPt:alert(1))'), '<p>klick</p>');
  });

  test('quotes cannot break out of attributes', () => {
    assert.equal(md('[x](https://ok.de "a\\" onclick=\\"b")'), `<p>${A('https://ok.de/', 'x', 'a&quot; onclick=&quot;b')}</p>`);
    assert.equal(md('[x](<https://ok.de/" onclick="b>)'), `<p>${A('https://ok.de/%22%20onclick=%22b', 'x')}</p>`);
  });

  test('random token soup is always structurally safe', () => {
    const tokens = [
      '*', '**', '_', '__', '~~', '~', '`', '``', '```', '~~~', '[', ']', '(', ')', '![', '<', '>', '"', "'", '&',
      '&#x09;', '&quot;', '&#106;', '&amp;', '\\', '\n', '\n\n', '# ', '## ', '> ', '>', '- ', '* ', '1. ', '2) ',
      '| ', ' |', '|---|', '|:-:|', '    ', '  ', '\t', 'javascript:', 'JaVaScRiPt:', 'data:text/html,',
      'data:image/png;base64,AAAA', 'https://', 'http://', 'www.', 'mailto:', 'x.com', 'a@b.de', '<script>',
      '<img src=x onerror=alert(1)>', ' onerror=', 'alert(1)', ' ', 'a', 'b', 'Wort', ':', '=', '[ ] ', '[x] ',
      '<br>', '---', '===', '"title"', '\u200b', '\u0001',
    ];
    let seed = 0x9e3779b9;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    for (let iter = 0; iter < 3000; iter++) {
      const len = 1 + Math.floor(rand() * 40);
      let s = '';
      for (let k = 0; k < len; k++) s += tokens[Math.floor(rand() * tokens.length)];
      safe(s);
    }
  });
});

describe('streaming', () => {
  const doc = [
    '# Überschrift',
    '',
    'Ein **fetter** Satz mit *Kursiv*, `code` und einem [Link](https://example.com "Titel").',
    '',
    '1. Erster Punkt',
    '   - Unterpunkt mit ~~Streichung~~',
    '2. Zweiter Punkt',
    '',
    '- [ ] offen',
    '- [x] erledigt',
    '',
    '> Zitat mit https://example.org/pfad_(x).',
    '',
    '| Spalte | Wert |',
    '|:--|--:|',
    '| a | 1 |',
    '',
    '```js',
    'const x = "<b>";',
    '```',
    '',
    '![Bild](https://example.com/bild.png)',
    '',
    '---',
    'Ende.',
  ].join('\n');

  test('every prefix renders without throwing and stays safe', () => {
    for (let i = 0; i <= doc.length; i++) safe(doc.slice(0, i));
  });

  test('full document renders all features', () => {
    const html = safe(doc);
    for (const needle of ['<h1>', '<strong>fetter</strong>', '<em>Kursiv</em>', '<code>code</code>', '<ol>', '<ul>',
      '<del>Streichung</del>', 'class="task-list-item"', '<blockquote>', '<table>', 'class="language-js"',
      '<img src="https://example.com/bild.png"', '<hr>']) {
      assert.ok(html.includes(needle), `missing ${needle}`);
    }
  });

  test('partial constructs degrade to text', () => {
    assert.equal(md('Ein **fet'), '<p>Ein **fet</p>');
    assert.equal(md('Ein [Li'), '<p>Ein [Li</p>');
    assert.equal(md('Ein `co'), '<p>Ein `co</p>');
    assert.equal(md('![Bild](https://exa'), `<p>![Bild](${A('https://exa/', 'https://exa')}</p>`);
  });
});

describe('performance', () => {
  const N = 20000;
  const fill = (unit) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  let backtickRuns = '';
  for (let k = 1; backtickRuns.length < N; k++) backtickRuns += '`'.repeat(k) + 'a';
  let nestedList = '';
  for (let k = 0; nestedList.length < N; k++) nestedList += ' '.repeat(k % 40) + '- x\n';
  const cases = {
    stars: fill('*a'),
    doubleStars: fill('**a'),
    underscores: fill('_a'),
    mixedDelims: fill('*_'),
    mixedEmphasis: fill('*a **b ***c '),
    tildes: fill('~~a'),
    deepEmphasis: '*'.repeat(N / 2) + 'a' + '*'.repeat(N / 2),
    openBrackets: fill('['),
    closeBrackets: fill(']'),
    bracketPairs: fill('[a]'),
    linkOpeners: fill('[a]('),
    emptyLinkOpeners: fill('[]('),
    parenDest: '[a](' + '('.repeat(N),
    balancedParens: '[a](' + fill('()'),
    titleQuotes: fill('[a](b "'),
    titleParens: fill('[a](b ('),
    imageOpeners: fill('!['),
    nestedLinks: '['.repeat(N / 4) + fill('a](b)').slice(0, N / 2),
    backtickRuns,
    backticks: fill('`'),
    lessThan: fill('<'),
    angleScheme: fill('<a:'),
    angleEmail: fill('<a@'),
    ampersands: fill('&'),
    entities: fill('&#'),
    backslashes: fill('\\'),
    plain: fill('a'),
    spaces: ' '.repeat(N - 1) + 'x',
    innerSpaces: 'a' + ' '.repeat(N) + 'b',
    urls: fill('https://'),
    www: fill('www.'),
    urlParens: 'https://x.de/' + fill(')'),
    longUrl: 'https://x.de/' + fill('a'),
    hashes: fill('#'),
    headingHashes: '# ' + fill(' #') + 'x',
    pipes: fill('|'),
    dashes: fill('-') + 'x',
    quoteNesting: fill('> ') + 'x',
    listNesting: fill('- ') + 'x',
    orderedNesting: fill('1. ') + 'x',
    quoteLines: fill('> a\n'),
    listLines: fill('- a\n'),
    lazyLines: '- a\n' + fill('b\n'),
    fenceLines: fill('```\n'),
    tildeFenceLines: fill('~~~\n'),
    nestedList,
    indentedLines: fill('    a\n\n'),
    tableRows: '| a | b |\n|---|---|\n' + fill('| x | y |\n'),
    wideTable: '|a'.repeat(64) + '|\n' + '|-'.repeat(64) + '|\n' + fill('|\n'),
    setext: fill('a\n=\n'),
    newlines: fill('\n'),
    taskLines: fill('- [ ] a\n'),
    mixedInline: fill('*a_ [b](c "d") `e` <f> &g; **h~~ !['),
    ruleOfThreeA: fill('a**a*'),
    ruleOfThreeB: fill('a*a**'),
    ruleOfThreeC: fill('a***a*'),
    openerRuns: fill('*a**'),
    closerRuns: fill('a** a*'),
    intrawordUnderscore: fill('a_'),
    spacedUnderscore: fill('_ '),
    shortUrls: fill('https://a.de/x '),
    angleUrls: fill('<https://a.de> '),
    emails: fill('<a@b.de> '),
    deepQuoteLines: fill('> '.repeat(20) + 'x\n'),
    deepListLines: fill('- '.repeat(20) + 'x\n'),
    indentedListLines: (() => {
      let s = '';
      for (let k = 0; s.length < N; k++) s += '  '.repeat(k % 20) + '1. x\n';
      return s;
    })(),
    lazyQuote: '> a\n' + fill('b\n'),
    longParagraph: fill('Wort **fett** _kursiv_ `code` [l](https://x.de) \n'),
  };

  // warm up the JIT
  renderMarkdown(fill('*a [b](c) `d` **e**\n- f\n> g\n'));

  for (const [name, input] of Object.entries(cases)) {
    test(`${name} (${input.length} chars) < 200 ms`, () => {
      const t0 = performance.now();
      const html = renderMarkdown(input);
      const ms = performance.now() - t0;
      assert.equal(typeof html, 'string');
      assert.ok(ms < 200, `${name} took ${ms.toFixed(1)} ms`);
    });
  }

  test('adversarial outputs are still safe', () => {
    for (const name of ['mixedInline', 'titleQuotes', 'angleScheme', 'nestedLinks', 'quoteNesting', 'listNesting',
      'deepQuoteLines', 'deepListLines', 'ruleOfThreeA', 'shortUrls']) {
      safe(cases[name]);
    }
  });

  test('deep emphasis nesting renders without stack overflow', () => {
    const html = renderMarkdown(cases.deepEmphasis);
    assert.ok(html.startsWith('<p><strong><strong>'));
    assert.ok(html.endsWith('</strong></strong></p>'));
  });
});

test('code block labels follow the UI language', () => {
  registerCatalog('en', en);
  setLanguage('en');
  try {
    const html = md('```\nx\n```');
    assert.ok(html.includes('<button class="copy-code" type="button" title="Copy code">Copy</button>'), html);
    assert.ok(html.includes('<span class="code-lang">Code</span>'));
  } finally {
    setLanguage('de');
  }
  assert.ok(md('```\nx\n```').includes('title="Code kopieren">Kopieren</button>'));
});
