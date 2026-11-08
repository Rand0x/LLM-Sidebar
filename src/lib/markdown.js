// Safe markdown -> HTML renderer for model output (CommonMark core + GFM tables, task lists,
// strikethrough and autolinks, rendered "chat style": every line break becomes <br>).
//
// Safety model: input HTML is never passed through. Every text fragment is escaped, only tags
// generated here are emitted, attribute values are escaped and URLs must pass a strict
// allow-list after normalisation. Parsing is linear-ish (no backtracking-prone regexes, explicit
// limits on nesting) and the function never throws (it falls back to escaped plain text).

import { escapeHtml } from './utils.js';
import { t } from './i18n.js';

const MAX_DEPTH = 16; // max nesting of block containers (blockquotes / list items)
const MAX_PAREN_DEPTH = 32; // max nested parentheses in a link destination
const MAX_TABLE_COLUMNS = 64;
const MAX_TABLE_CELLS = 50000; // padding short rows must not amplify tiny input into huge output
const MAX_LANG_LENGTH = 40;

/**
 * Renders markdown to a safe HTML string.
 * @param {string} markdown
 * @param {{ allowRemoteImages?: boolean }} [options] allowRemoteImages=false renders https images
 *   as links instead of <img> (prevents automatic requests to URLs chosen by the model).
 * @returns {string}
 */
export function renderMarkdown(markdown, options = {}) {
  const src = normalizeSource(markdown);
  if (!/\S/.test(src)) return '';
  const ctx = { allowRemoteImages: !(options && options.allowRemoteImages === false) };
  try {
    return renderBlocks(parseBlocks(src.split('\n'), 0), ctx);
  } catch {
    return `<p>${escapeHtml(src).replace(/\n/g, '<br>')}</p>`;
  }
}

function normalizeSource(markdown) {
  if (markdown == null) return '';
  return String(markdown).replace(/\r\n?/g, '\n').replace(/\u0000/g, '\ufffd');
}

// ---------------------------------------------------------------------------
// Line helpers

function isSpaceOrTab(code) {
  return code === 32 || code === 9;
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    if (!isSpaceOrTab(line.charCodeAt(i))) return false;
  }
  return true;
}

// Columns of leading whitespace (a tab advances to the next multiple of 4).
function indentOf(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Removes up to `cols` columns of leading whitespace; a partially consumed tab becomes spaces.
function stripCols(line, cols) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w > cols) return ' '.repeat(col + w - cols) + line.slice(i + 1);
      col += w;
      i++;
    } else {
      break;
    }
  }
  return i ? line.slice(i) : line;
}

function stripLeading(line) {
  let i = 0;
  while (i < line.length && isSpaceOrTab(line.charCodeAt(i))) i++;
  return i ? line.slice(i) : line;
}

function stripTrailing(line) {
  let e = line.length;
  while (e > 0 && isSpaceOrTab(line.charCodeAt(e - 1))) e--;
  return e === line.length ? line : line.slice(0, e);
}

// ---------------------------------------------------------------------------
// Block detectors

function parseAtx(line) {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+([\s\S]*))?$/.exec(line);
  if (!m) return null;
  return { level: m[1].length, text: stripClosingHashes(m[2] || '') };
}

function stripClosingHashes(text) {
  let end = stripTrailing(text).length;
  let h = end;
  while (h > 0 && text.charCodeAt(h - 1) === 35) h--;
  if (h < end && (h === 0 || isSpaceOrTab(text.charCodeAt(h - 1)))) end = h;
  return stripTrailing(stripLeading(text.slice(0, end)));
}

function parseFenceOpen(line) {
  const m = /^( {0,3})(`{3,}|~{3,})([\s\S]*)$/.exec(line);
  if (!m) return null;
  if (m[2][0] === '`' && m[3].includes('`')) return null;
  return { indent: m[1].length, char: m[2].charCodeAt(0), len: m[2].length, info: m[3].trim() };
}

function isFenceClose(line, fence) {
  let p = 0;
  while (p < 3 && line.charCodeAt(p) === 32) p++;
  let q = p;
  while (q < line.length && line.charCodeAt(q) === fence.char) q++;
  if (q - p < fence.len) return false;
  for (; q < line.length; q++) {
    if (!isSpaceOrTab(line.charCodeAt(q))) return false;
  }
  return true;
}

function fenceLang(info) {
  if (!info) return '';
  let word = info.split(/[ \t]/, 1)[0];
  word = unescapeString(word).replace(/^\{?\.?/, '').replace(/\}$/, '');
  return word.replace(/[^\w+#.-]/g, '').slice(0, MAX_LANG_LENGTH);
}

function isHr(line) {
  if (indentOf(line) > 3) return false;
  let ch = 0;
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (isSpaceOrTab(c)) continue;
    if (c !== 45 && c !== 42 && c !== 95) return false; // - * _
    if (!ch) ch = c;
    else if (c !== ch) return false;
    count++;
  }
  return count >= 3;
}

function setextLevel(line) {
  if (indentOf(line) > 3) return 0;
  const t = line.trim();
  if (/^=+$/.test(t)) return 1;
  // A single '-' is far more likely the start of a list item that is still streaming in.
  if (/^-{2,}$/.test(t)) return 2;
  return 0;
}

function isBlockquoteStart(line) {
  return /^ {0,3}>/.test(line);
}

function stripBlockquoteMarker(line) {
  let p = 0;
  while (p < 3 && line.charCodeAt(p) === 32) p++;
  p++; // '>'
  const c = line.charCodeAt(p);
  if (c === 32) return line.slice(p + 1);
  if (c === 9) return ' '.repeat(3 - (p % 4)) + line.slice(p + 1);
  return line.slice(p);
}

// Parses a list item marker ("-", "+", "*", "1.", "1)") with at most 3 columns of indentation.
function parseListMarker(line) {
  let p = 0;
  let col = 0;
  while (p < line.length) {
    const c = line.charCodeAt(p);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else break;
    p++;
  }
  if (col > 3 || p >= line.length) return null;
  const c = line.charCodeAt(p);
  let q = p;
  let ordered = false;
  let start = 1;
  let markerChar;
  if (c === 45 || c === 43 || c === 42) {
    markerChar = line[p];
    q = p + 1;
  } else if (c >= 48 && c <= 57) {
    while (q < line.length && q - p < 9 && isDigit(line.charCodeAt(q))) q++;
    if (isDigit(line.charCodeAt(q))) return null; // more than 9 digits
    const d = line[q];
    if (d !== '.' && d !== ')') return null;
    ordered = true;
    start = parseInt(line.slice(p, q), 10);
    markerChar = d;
    q++;
  } else {
    return null;
  }
  if (q < line.length && !isSpaceOrTab(line.charCodeAt(q))) return null;
  const markerEnd = col + (q - p);
  let r = q;
  let c2 = markerEnd;
  while (r < line.length && isSpaceOrTab(line.charCodeAt(r))) {
    c2 += line.charCodeAt(r) === 9 ? 4 - (c2 % 4) : 1;
    r++;
  }
  const spaces = c2 - markerEnd;
  const rest = line.slice(r);
  let contentCol;
  let firstLine;
  if (rest === '') {
    contentCol = markerEnd + 1;
    firstLine = '';
  } else if (spaces > 4) {
    // Content starts with indented code: only one space belongs to the marker.
    contentCol = markerEnd + 1;
    firstLine = ' '.repeat(spaces - 1) + rest;
  } else {
    contentCol = c2;
    firstLine = rest;
  }
  return { indent: col, ordered, start, markerChar, contentCol, firstLine, empty: rest === '' };
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

// Can `line` interrupt a paragraph at the same container level (CommonMark rules)?
function interruptsParagraph(line, depth) {
  if (indentOf(line) > 3) return false;
  if (parseAtx(line) || parseFenceOpen(line) || isHr(line)) return true;
  if (depth < MAX_DEPTH) {
    if (isBlockquoteStart(line)) return true;
    const lm = parseListMarker(line);
    if (lm && !lm.empty && (!lm.ordered || lm.start === 1)) return true;
  }
  return false;
}

// Does `line` start a block, so it cannot be a lazy continuation of a paragraph in a container?
function breaksLazy(line) {
  if (indentOf(line) > 3) return false;
  return Boolean(parseAtx(line) || parseFenceOpen(line) || isHr(line) || isBlockquoteStart(line) || parseListMarker(line));
}

// Is `line` (inside a container) paragraph text, so that the next line may continue it lazily?
function isParagraphLine(line) {
  let s = line;
  for (let guard = 0; guard < MAX_DEPTH; guard++) {
    if (isBlank(s) || indentOf(s) > 3) return false;
    if (isBlockquoteStart(s)) {
      s = stripBlockquoteMarker(s);
      continue;
    }
    if (!isHr(s)) {
      const lm = parseListMarker(s);
      if (lm) {
        s = lm.firstLine;
        continue;
      }
    }
    break;
  }
  return !isBlank(s) && !parseAtx(s) && !parseFenceOpen(s) && !isHr(s);
}

// A lazy continuation line is always paragraph text; keep "===" from becoming a setext underline.
function escapeLazyLine(line) {
  const t = stripLeading(line);
  return setextLevel(t) ? '\\' + t : t;
}

// ---------------------------------------------------------------------------
// Tables

function splitTableRow(line) {
  const s = line.trim();
  const cells = [];
  let cur = '';
  let endsWithPipe = false;
  for (let i = s[0] === '|' ? 1 : 0; i < s.length; i++) {
    const c = s[i];
    endsWithPipe = false;
    if (c === '\\' && i + 1 < s.length) {
      cur += s[i + 1] === '|' ? '|' : c + s[i + 1];
      i++;
    } else if (c === '|') {
      cells.push(cur.trim());
      cur = '';
      endsWithPipe = true;
    } else {
      cur += c;
    }
  }
  if (!endsWithPipe) cells.push(cur.trim());
  return cells;
}

function parseDelimiterRow(line) {
  const cells = splitTableRow(line);
  if (cells.length > MAX_TABLE_COLUMNS) return null;
  const aligns = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    const left = c[0] === ':';
    const right = c[c.length - 1] === ':';
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : '');
  }
  return aligns;
}

function tableAt(lines, i) {
  const header = lines[i];
  const delim = lines[i + 1];
  if (delim === undefined || !header.includes('|') || !delim.includes('|') || !delim.includes('-')) return null;
  if (indentOf(header) > 3 || indentOf(delim) > 3) return null;
  const aligns = parseDelimiterRow(delim);
  if (!aligns) return null;
  const head = splitTableRow(header);
  if (head.length !== aligns.length) return null;
  return { head, aligns };
}

function parseTable(lines, i, table) {
  const rows = [];
  const maxRows = Math.floor(MAX_TABLE_CELLS / table.aligns.length) - 1;
  let j = i + 2;
  while (j < lines.length && rows.length < maxRows) {
    const l = lines[j];
    if (isBlank(l) || !l.includes('|') || breaksLazy(l)) break;
    const cells = splitTableRow(l);
    rows.push(table.aligns.map((_, c) => cells[c] ?? ''));
    j++;
  }
  return { block: { type: 'table', aligns: table.aligns, head: table.head, rows }, next: j };
}

// ---------------------------------------------------------------------------
// Block parser

function parseBlocks(lines, depth) {
  const blocks = [];
  const n = lines.length;
  let i = 0;
  let sawBlank = false;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      sawBlank = true;
      i++;
      continue;
    }
    let block;
    let fence;
    let atx;
    let marker;
    let table;
    if (indentOf(line) >= 4) {
      let j = i + 1;
      let last = i;
      while (j < n && (isBlank(lines[j]) || indentOf(lines[j]) >= 4)) {
        if (!isBlank(lines[j])) last = j;
        j++;
      }
      block = { type: 'code', lang: '', text: lines.slice(i, last + 1).map((l) => stripCols(l, 4)).join('\n') };
      i = last + 1;
    } else if ((fence = parseFenceOpen(line))) {
      const content = [];
      let j = i + 1;
      while (j < n && !isFenceClose(lines[j], fence)) {
        content.push(stripCols(lines[j], fence.indent));
        j++;
      }
      if (j >= n) {
        // Unterminated fence (e.g. while streaming): runs to the end of its container.
        while (content.length && isBlank(content[content.length - 1])) content.pop();
      }
      block = { type: 'code', lang: fenceLang(fence.info), text: content.join('\n') };
      i = j < n ? j + 1 : j;
    } else if ((atx = parseAtx(line))) {
      block = { type: 'heading', level: atx.level, text: atx.text };
      i++;
    } else if (isHr(line)) {
      block = { type: 'hr' };
      i++;
    } else if (depth < MAX_DEPTH && isBlockquoteStart(line)) {
      const r = collectBlockquote(lines, i);
      block = { type: 'blockquote', children: parseBlocks(r.body, depth + 1) };
      i = r.next;
    } else if (depth < MAX_DEPTH && (marker = parseListMarker(line))) {
      const r = parseList(lines, i, marker, depth);
      block = r.block;
      i = r.next;
    } else if ((table = tableAt(lines, i))) {
      const r = parseTable(lines, i, table);
      block = r.block;
      i = r.next;
    } else {
      const r = parseParagraph(lines, i, depth);
      block = r.block;
      i = r.next;
    }
    block.blankBefore = sawBlank && blocks.length > 0;
    sawBlank = false;
    blocks.push(block);
  }
  return blocks;
}

function parseParagraph(lines, i, depth) {
  const n = lines.length;
  const parts = [stripLeading(lines[i])];
  let j = i + 1;
  let level = 0;
  while (j < n) {
    const l = lines[j];
    if (isBlank(l)) break;
    const sl = setextLevel(l);
    if (sl) {
      level = sl;
      j++;
      break;
    }
    if (interruptsParagraph(l, depth) || tableAt(lines, j)) break;
    parts.push(stripLeading(l));
    j++;
  }
  const text = stripTrailing(parts.join('\n'));
  return { block: level ? { type: 'heading', level, text } : { type: 'paragraph', text }, next: j };
}

function collectBlockquote(lines, i) {
  const body = [];
  let j = i;
  let fence = null;
  let lastPara = false;
  while (j < lines.length) {
    const l = lines[j];
    if (isBlockquoteStart(l)) {
      const s = stripBlockquoteMarker(l);
      body.push(s);
      if (fence) {
        if (isFenceClose(s, fence)) fence = null;
        lastPara = false;
      } else if ((fence = parseFenceOpen(s))) {
        lastPara = false;
      } else {
        lastPara = isParagraphLine(s);
      }
    } else if (!fence && lastPara && !isBlank(l) && !breaksLazy(l)) {
      body.push(escapeLazyLine(l)); // lazy continuation
    } else {
      break;
    }
    j++;
  }
  return { body, next: j };
}

function parseList(lines, i, first, depth) {
  const list = { type: 'list', ordered: first.ordered, start: first.start, loose: false, items: [] };
  let marker = first;
  let j = i;
  for (;;) {
    const r = collectItem(lines, j, marker, depth);
    list.items.push(r.item);
    if (r.item.loose) list.loose = true;
    j = r.next;
    let k = j;
    while (k < lines.length && isBlank(lines[k])) k++;
    if (k >= lines.length || isHr(lines[k])) break;
    const nm = parseListMarker(lines[k]);
    if (!nm || nm.ordered !== first.ordered || nm.markerChar !== first.markerChar) break;
    if (k > j) list.loose = true;
    marker = nm;
    j = k;
  }
  return { block: list, next: j };
}

const RE_TASK = /^\[([ xX])\](?:[ \t]+|$)/;

function collectItem(lines, i, marker, depth) {
  const m = marker.indent;
  let w = marker.contentCol;
  let first = marker.firstLine;
  let task = null;
  const tm = RE_TASK.exec(first);
  if (tm) {
    task = tm[1] === ' ' ? 'open' : 'done';
    first = first.slice(tm[0].length);
  }
  const raw = [];
  let fence = parseFenceOpen(first);
  let lastPara = !fence && isParagraphLine(first);
  let blank = false;
  let lastContent = -1;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (isBlank(l)) {
      raw.push({ line: l, lazy: false });
      blank = true;
      lastPara = false;
      continue;
    }
    const k = indentOf(l);
    let lazy = false;
    if (k >= w) {
      // regular content of this item
    } else if (fence) {
      break;
    } else if (k >= m + 2) {
      // Lenient nesting for chat output ("1. foo\n  - bar"): treat deeper-than-marker lines as
      // item content and shift the content column left.
      if (!blank && lastPara && !breaksLazy(l)) lazy = true;
      else w = k;
    } else if (!blank && lastPara && !breaksLazy(l)) {
      lazy = true;
    } else {
      break;
    }
    raw.push({ line: l, lazy });
    lastContent = raw.length - 1;
    blank = false;
    if (lazy) {
      lastPara = true;
      continue;
    }
    const s = stripCols(l, w);
    if (fence) {
      if (isFenceClose(s, fence)) fence = null;
      lastPara = false;
    } else if ((fence = parseFenceOpen(s))) {
      lastPara = false;
    } else {
      lastPara = isParagraphLine(s);
    }
  }
  const body = [first];
  for (let r = 0; r <= lastContent; r++) {
    const { line, lazy } = raw[r];
    if (lazy) body.push(escapeLazyLine(line));
    else if (isBlank(line)) body.push('');
    else body.push(stripCols(line, Math.min(w, indentOf(line))));
  }
  const children = parseBlocks(body, depth + 1);
  const loose = children.some((b, idx) => idx > 0 && b.blankBefore);
  return { item: { children, task, loose }, next: i + 1 + lastContent + 1 };
}

// ---------------------------------------------------------------------------
// Block renderer

function renderBlocks(blocks, ctx) {
  const out = [];
  for (const b of blocks) out.push(renderBlock(b, ctx, false));
  return out.join('\n');
}

function renderBlock(b, ctx, tight) {
  switch (b.type) {
    case 'paragraph': {
      const html = renderInline(b.text, ctx);
      return tight ? html : `<p>${html}</p>`;
    }
    case 'heading':
      return `<h${b.level}>${renderInline(b.text, ctx)}</h${b.level}>`;
    case 'code':
      return renderCodeBlock(b.lang, b.text);
    case 'hr':
      return '<hr>';
    case 'blockquote':
      return `<blockquote>\n${renderBlocks(b.children, ctx)}\n</blockquote>`;
    case 'list':
      return renderList(b, ctx);
    case 'table':
      return renderTable(b, ctx);
    default:
      return '';
  }
}

function renderCodeBlock(lang, text) {
  const cls = lang ? ` class="language-${escapeHtml(lang.toLowerCase())}"` : '';
  return '<div class="code-block"><div class="code-head">'
    + `<span class="code-lang">${escapeHtml(lang || t('core.markdown.code'))}</span>`
    + `<button class="copy-code" type="button" title="${escapeHtml(t('core.markdown.copyCode'))}">${escapeHtml(t('core.markdown.copy'))}</button></div>`
    + `<pre><code${cls}>${escapeHtml(text)}</code></pre></div>`;
}

function renderList(list, ctx) {
  const tag = list.ordered ? 'ol' : 'ul';
  let attrs = '';
  if (list.ordered && list.start !== 1) attrs += ` start="${list.start}"`;
  if (list.items.some((it) => it.task)) attrs += ' class="contains-task-list"';
  const tight = !list.loose;
  const items = list.items.map((item) => {
    const checkbox = item.task
      ? `<input type="checkbox"${item.task === 'done' ? ' checked' : ''} disabled> `
      : '';
    const parts = item.children.map((c, idx) => {
      if (c.type !== 'paragraph') return renderBlock(c, ctx, false);
      const inner = (idx === 0 ? checkbox : '') + renderInline(c.text, ctx);
      return tight ? inner : `<p>${inner}</p>`;
    });
    if (checkbox && item.children[0]?.type !== 'paragraph') parts.unshift(checkbox.trimEnd());
    return `<li${item.task ? ' class="task-list-item"' : ''}>${parts.join('\n')}</li>`;
  });
  return `<${tag}${attrs}>\n${items.join('\n')}\n</${tag}>`;
}

function renderTable(t, ctx) {
  const styles = t.aligns.map((a) => (a ? ` style="text-align:${a}"` : ''));
  const row = (cells, tag) => {
    let html = '<tr>';
    for (let c = 0; c < cells.length; c++) html += `<${tag}${styles[c]}>${cells[c] ? renderInline(cells[c], ctx) : ''}</${tag}>`;
    return html + '</tr>';
  };
  const head = `<thead>\n${row(t.head, 'th')}\n</thead>`;
  const body = t.rows.length ? `\n<tbody>\n${t.rows.map((r) => row(r, 'td')).join('\n')}\n</tbody>` : '';
  return `<div class="table-wrap"><table>\n${head}${body}\n</table></div>`;
}

// ---------------------------------------------------------------------------
// Inline parser (CommonMark delimiter algorithm on a doubly linked node list)

const C_NL = 10;
const C_BANG = 33;
const C_AMP = 38;
const C_LPAREN = 40;
const C_RPAREN = 41;
const C_STAR = 42;
const C_LT = 60;
const C_GT = 62;
const C_LBRACK = 91;
const C_BSLASH = 92;
const C_RBRACK = 93;
const C_UNDERSCORE = 95;
const C_BACKTICK = 96;
const C_TILDE = 126;

const SPECIAL = new Uint8Array(128);
for (const c of [C_NL, C_BANG, C_AMP, C_STAR, C_LT, C_LBRACK, C_BSLASH, C_RBRACK, C_UNDERSCORE, C_BACKTICK, C_TILDE]) {
  SPECIAL[c] = 1;
}

const RE_WS_CHAR = /^\s$/u;
const RE_PUNCT_CHAR = /^[\p{P}\p{S}]$/u;
const RE_ENTITY = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/y;
const RE_BR_TAG = /<br[ \t]*\/?>/iy;
const RE_URI_AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\u0000-\u001f\u007f]*)>/y;
const RE_EMAIL_AUTOLINK = /<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;

function isAsciiPunct(code) {
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

function textNode(text) {
  return { type: 'text', text, prev: null, next: null };
}

function append(st, node) {
  node.prev = st.last;
  node.next = null;
  if (st.last) st.last.next = node;
  else st.first = node;
  st.last = node;
}

function pushText(st, src, from, to) {
  if (to > from) append(st, textNode(src.slice(from, to)));
}

function skipSpaces(src, pos) {
  while (pos < src.length && isSpaceOrTab(src.charCodeAt(pos))) pos++;
  return pos;
}

function parseInline(src) {
  const bottom = { idx: -1, prev: null, next: null };
  const st = {
    src,
    first: null,
    last: null,
    delimTail: bottom,
    bracketTop: null,
    linksClosed: 0,
    seq: 0,
    backtickMiss: new Map(),
  };
  const n = src.length;
  let pos = 0;
  let textStart = 0;
  while (pos < n) {
    const c = src.charCodeAt(pos);
    if (c >= 128 || !SPECIAL[c]) {
      pos++;
      continue;
    }
    switch (c) {
      case C_NL: {
        let e = pos;
        while (e > textStart && isSpaceOrTab(src.charCodeAt(e - 1))) e--;
        pushText(st, src, textStart, e);
        append(st, { type: 'br' });
        pos = skipSpaces(src, pos + 1);
        textStart = pos;
        break;
      }
      case C_BSLASH: {
        const nc = src.charCodeAt(pos + 1);
        if (nc === C_NL) {
          pushText(st, src, textStart, pos);
          append(st, { type: 'br' });
          pos = skipSpaces(src, pos + 2);
          textStart = pos;
        } else if (isAsciiPunct(nc)) {
          pushText(st, src, textStart, pos);
          append(st, textNode(src[pos + 1]));
          pos += 2;
          textStart = pos;
        } else {
          pos++;
        }
        break;
      }
      case C_BACKTICK: {
        let q = pos;
        while (q < n && src.charCodeAt(q) === C_BACKTICK) q++;
        const len = q - pos;
        const close = findBacktickCloser(st, q, len);
        if (close < 0) {
          pos = q; // unmatched run stays literal text
          break;
        }
        pushText(st, src, textStart, pos);
        append(st, { type: 'code', text: normalizeCodeSpan(src.slice(q, close)) });
        pos = close + len;
        textStart = pos;
        break;
      }
      case C_STAR:
      case C_UNDERSCORE:
      case C_TILDE: {
        let q = pos;
        while (q < n && src.charCodeAt(q) === c) q++;
        const len = q - pos;
        const f = c === C_TILDE && len !== 2 ? null : flanking(src, pos, q, c);
        if (!f || (!f.canOpen && !f.canClose)) {
          pos = q;
          break;
        }
        pushText(st, src, textStart, pos);
        const node = textNode(src.slice(pos, q));
        append(st, node);
        pushDelim(st, node, c, len, f.canOpen, f.canClose);
        pos = q;
        textStart = pos;
        break;
      }
      case C_BANG: {
        if (src.charCodeAt(pos + 1) !== C_LBRACK) {
          pos++;
          break;
        }
        pushText(st, src, textStart, pos);
        pushBracket(st, '![', true);
        pos += 2;
        textStart = pos;
        break;
      }
      case C_LBRACK: {
        pushText(st, src, textStart, pos);
        pushBracket(st, '[', false);
        pos++;
        textStart = pos;
        break;
      }
      case C_RBRACK: {
        pushText(st, src, textStart, pos);
        pos = closeBracket(st, pos);
        textStart = pos;
        break;
      }
      case C_LT: {
        const r = matchAngle(src, pos);
        if (!r) {
          pos++;
          break;
        }
        pushText(st, src, textStart, pos);
        append(st, r.node);
        pos = r.end;
        textStart = pos;
        break;
      }
      case C_AMP: {
        RE_ENTITY.lastIndex = pos;
        const m = RE_ENTITY.exec(src);
        const decoded = m ? decodeEntity(m[1]) : null;
        if (decoded === null) {
          pos++;
          break;
        }
        pushText(st, src, textStart, pos);
        append(st, textNode(decoded));
        pos += m[0].length;
        textStart = pos;
        break;
      }
      default:
        pos++;
    }
  }
  pushText(st, src, textStart, n);
  processEmphasis(st, bottom);
  return st.first;
}

// Finds the next backtick run of exactly `len` starting at `from`; caches misses per length so
// many unmatched runs stay linear.
function findBacktickCloser(st, from, len) {
  const missFrom = st.backtickMiss.get(len);
  if (missFrom !== undefined && from >= missFrom) return -1;
  const src = st.src;
  let p = from;
  for (;;) {
    const b = src.indexOf('`', p);
    if (b < 0) {
      st.backtickMiss.set(len, from);
      return -1;
    }
    let e = b;
    while (e < src.length && src.charCodeAt(e) === C_BACKTICK) e++;
    if (e - b === len) return b;
    p = e;
  }
}

function normalizeCodeSpan(s) {
  let t = s.replace(/\n/g, ' ');
  if (t.length >= 2 && t[0] === ' ' && t[t.length - 1] === ' ' && /[^ ]/.test(t)) t = t.slice(1, -1);
  return t;
}

function charBefore(src, i) {
  if (i <= 0) return '';
  const c = src.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const h = src.charCodeAt(i - 2);
    if (h >= 0xd800 && h <= 0xdbff) return src.slice(i - 2, i);
  }
  return src[i - 1];
}

function charAfter(src, i) {
  if (i >= src.length) return '';
  return String.fromCodePoint(src.codePointAt(i));
}

function flanking(src, start, end, code) {
  const before = charBefore(src, start);
  const after = charAfter(src, end);
  const bWs = before === '' || RE_WS_CHAR.test(before);
  const aWs = after === '' || RE_WS_CHAR.test(after);
  const bP = !bWs && RE_PUNCT_CHAR.test(before);
  const aP = !aWs && RE_PUNCT_CHAR.test(after);
  const left = !aWs && (!aP || bWs || bP);
  const right = !bWs && (!bP || aWs || aP);
  if (code === C_UNDERSCORE) {
    // No intraword emphasis with underscores (snake_case stays intact).
    return { canOpen: left && (!right || bP), canClose: right && (!left || aP) };
  }
  return { canOpen: left, canClose: right };
}

function pushDelim(st, node, code, count, canOpen, canClose) {
  const d = { node, code, count, origCount: count, canOpen, canClose, prev: st.delimTail, next: null, idx: ++st.seq };
  st.delimTail.next = d;
  st.delimTail = d;
}

function removeDelim(st, d) {
  d.prev.next = d.next;
  if (d.next) d.next.prev = d.prev;
  else st.delimTail = d.prev;
}

function pushBracket(st, text, image) {
  const node = textNode(text);
  append(st, node);
  st.bracketTop = { node, image, bottom: st.delimTail, linkSeq: st.linksClosed, prev: st.bracketTop };
}

function closeBracket(st, pos) {
  const br = st.bracketTop;
  if (br) {
    st.bracketTop = br.prev;
    // Links may not contain links: a '[' opened before the last completed link is inactive.
    const active = br.image || br.linkSeq === st.linksClosed;
    if (active && st.src.charCodeAt(pos + 1) === C_LPAREN) {
      const tail = parseLinkTail(st.src, pos + 2);
      if (tail) {
        processEmphasis(st, br.bottom);
        makeLink(st, br, tail.dest, tail.title);
        if (!br.image) st.linksClosed++;
        return tail.end;
      }
    }
  }
  append(st, textNode(']'));
  return pos + 1;
}

// Turns the bracket's text node into a link/image container holding everything after it.
function makeLink(st, br, dest, title) {
  const node = br.node;
  node.type = br.image ? 'image' : 'link';
  node.text = '';
  node.dest = dest;
  node.title = title;
  node.first = node.next;
  node.last = node.next ? st.last : null;
  if (node.first) node.first.prev = null;
  node.next = null;
  st.last = node;
}

function skipLinkSpace(src, p) {
  while (p < src.length) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9 && c !== C_NL) break;
    p++;
  }
  return p;
}

// Parses `dest "title")` after "](". Returns { dest, title, end } or null.
function parseLinkTail(src, p) {
  const n = src.length;
  p = skipLinkSpace(src, p);
  if (p >= n) return null;
  if (src.charCodeAt(p) === C_RPAREN) return { dest: '', title: '', end: p + 1 };
  let dest;
  if (src.charCodeAt(p) === C_LT) {
    let q = p + 1;
    for (; q < n; q++) {
      const ch = src.charCodeAt(q);
      if (ch === C_BSLASH && q + 1 < n && isAsciiPunct(src.charCodeAt(q + 1))) {
        q++;
        continue;
      }
      if (ch === C_GT || ch === C_NL || ch === C_LT) break;
    }
    if (q >= n || src.charCodeAt(q) !== C_GT) return null;
    dest = src.slice(p + 1, q);
    p = q + 1;
  } else {
    let q = p;
    let depth = 0;
    for (; q < n; q++) {
      const ch = src.charCodeAt(q);
      if (ch === C_BSLASH && q + 1 < n && isAsciiPunct(src.charCodeAt(q + 1))) {
        q++;
        continue;
      }
      if (ch === C_LPAREN) {
        if (++depth > MAX_PAREN_DEPTH) return null;
      } else if (ch === C_RPAREN) {
        if (depth === 0) break;
        depth--;
      } else if (ch <= 32 || ch === 127) {
        break;
      }
    }
    if (q === p || depth !== 0) return null;
    dest = src.slice(p, q);
    p = q;
  }
  let title = '';
  const afterDest = p;
  p = skipLinkSpace(src, p);
  if (p > afterDest && p < n) {
    const open = src.charCodeAt(p);
    const close = open === 34 ? 34 : open === 39 ? 39 : open === C_LPAREN ? C_RPAREN : 0;
    if (close) {
      let q = p + 1;
      for (; q < n; q++) {
        const ch = src.charCodeAt(q);
        if (ch === C_BSLASH && q + 1 < n && isAsciiPunct(src.charCodeAt(q + 1))) {
          q++;
          continue;
        }
        if (ch === close) break;
        if (open === C_LPAREN && ch === C_LPAREN) return null;
      }
      if (q >= n) return null;
      title = src.slice(p + 1, q);
      p = skipLinkSpace(src, q + 1);
    }
  }
  if (src.charCodeAt(p) !== C_RPAREN) return null;
  return { dest: unescapeString(dest), title: unescapeString(title), end: p + 1 };
}

// `<br>` tags (common in model-written tables) and <scheme:…> / <email> autolinks.
function matchAngle(src, pos) {
  RE_BR_TAG.lastIndex = pos;
  let m = RE_BR_TAG.exec(src);
  if (m) return { node: { type: 'br' }, end: pos + m[0].length };
  RE_URI_AUTOLINK.lastIndex = pos;
  m = RE_URI_AUTOLINK.exec(src);
  let href = null;
  if (m) {
    href = sanitizeLinkUrl(m[1]);
  } else {
    RE_EMAIL_AUTOLINK.lastIndex = pos;
    m = RE_EMAIL_AUTOLINK.exec(src);
    if (m) href = sanitizeLinkUrl('mailto:' + m[1]);
  }
  if (!m || !href) return null;
  const label = textNode(m[1]);
  return { node: { type: 'link', dest: href, title: '', safe: true, first: label, last: label }, end: pos + m[0].length };
}

function processEmphasis(st, bottom) {
  const openersBottom = new Map();
  let closer = bottom.next;
  while (closer) {
    if (!closer.canClose) {
      closer = closer.next;
      continue;
    }
    const key = closer.code * 8 + (closer.canOpen ? 4 : 0) + (closer.origCount % 3);
    const floor = openersBottom.has(key) ? openersBottom.get(key) : bottom.idx;
    let opener = closer.prev;
    let found = null;
    while (opener.idx > floor) {
      if (opener.code === closer.code && opener.canOpen) {
        if (closer.code === C_TILDE) {
          found = opener;
          break;
        }
        const oddMatch = (opener.canClose || closer.canOpen)
          && (opener.origCount + closer.origCount) % 3 === 0
          && !(opener.origCount % 3 === 0 && closer.origCount % 3 === 0);
        if (!oddMatch) {
          found = opener;
          break;
        }
      }
      opener = opener.prev;
    }
    if (found) {
      let use;
      let type;
      if (closer.code === C_TILDE) {
        use = 2;
        type = 'del';
      } else {
        use = found.count >= 2 && closer.count >= 2 ? 2 : 1;
        type = use === 2 ? 'strong' : 'em';
      }
      found.count -= use;
      closer.count -= use;
      found.node.text = found.node.text.slice(0, found.count);
      closer.node.text = closer.node.text.slice(0, closer.count);
      wrapBetween(found.node, closer.node, type);
      for (let d = found.next; d !== closer;) {
        const nx = d.next;
        removeDelim(st, d);
        d = nx;
      }
      if (found.count === 0) removeDelim(st, found);
      if (closer.count === 0) {
        const nx = closer.next;
        removeDelim(st, closer);
        closer = nx;
      }
    } else {
      openersBottom.set(key, closer.prev.idx);
      const nx = closer.next;
      if (!closer.canOpen) removeDelim(st, closer);
      closer = nx;
    }
  }
  while (st.delimTail !== bottom) removeDelim(st, st.delimTail);
}

function wrapBetween(a, b, type) {
  const node = { type, first: null, last: null, prev: a, next: b };
  if (a.next !== b) {
    node.first = a.next;
    node.last = b.prev;
    node.first.prev = null;
    node.last.next = null;
  }
  a.next = node;
  b.prev = node;
}

// ---------------------------------------------------------------------------
// Inline renderer (iterative, so deeply nested emphasis cannot overflow the stack)

function renderInline(text, ctx) {
  if (!text) return '';
  return renderNodes(parseInline(text), ctx);
}

function renderNodes(first, ctx) {
  let out = '';
  let pending = '';
  let linkDepth = 0;
  const stack = [];
  const flush = () => {
    if (pending) {
      out += linkDepth > 0 ? escapeHtml(pending) : linkify(pending);
      pending = '';
    }
  };
  let node = first;
  for (;;) {
    if (!node) {
      if (!stack.length) break;
      flush();
      const frame = stack.pop();
      out += frame.close;
      if (frame.link) linkDepth--;
      node = frame.next;
      continue;
    }
    switch (node.type) {
      case 'text':
        pending += node.text;
        break;
      case 'br':
        flush();
        out += '<br>';
        break;
      case 'code':
        flush();
        out += `<code>${escapeHtml(node.text)}</code>`;
        break;
      case 'em':
      case 'strong':
      case 'del':
        flush();
        out += `<${node.type}>`;
        stack.push({ close: `</${node.type}>`, next: node.next, link: false });
        node = node.first;
        continue;
      case 'link': {
        flush();
        const href = linkDepth > 0 ? null : node.safe ? node.dest : sanitizeLinkUrl(node.dest);
        if (href) {
          const title = node.title ? ` title="${attrText(node.title)}"` : '';
          out += `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer">`;
          stack.push({ close: '</a>', next: node.next, link: true });
          linkDepth++;
        } else {
          // Disallowed URL or a link inside a link: keep only the text.
          stack.push({ close: '', next: node.next, link: false });
        }
        node = node.first;
        continue;
      }
      case 'image':
        flush();
        out += renderImage(node, ctx, linkDepth > 0);
        break;
      default:
        break;
    }
    node = node.next;
  }
  flush();
  return out;
}

// Escaped attribute text with control characters (incl. line breaks) collapsed to spaces.
function attrText(s) {
  return escapeHtml(s.replace(/[\u0000-\u001f\u007f]+/g, ' '));
}

function renderImage(node, ctx, insideLink) {
  const alt = plainText(node.first);
  const src = sanitizeImageUrl(node.dest);
  const title = node.title ? ` title="${attrText(node.title)}"` : '';
  if (src && (ctx.allowRemoteImages || src.startsWith('data:'))) {
    return `<img src="${escapeHtml(src)}" alt="${attrText(alt)}"${title} loading="lazy" referrerpolicy="no-referrer">`;
  }
  const href = insideLink ? null : sanitizeLinkUrl(node.dest);
  if (href) {
    return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer">${escapeHtml(alt || t('core.markdown.image'))}</a>`;
  }
  return escapeHtml(alt);
}

function plainText(first) {
  let out = '';
  const stack = [];
  let node = first;
  for (;;) {
    if (!node) {
      if (!stack.length) break;
      node = stack.pop();
      continue;
    }
    if (node.type === 'text' || node.type === 'code') out += node.text;
    else if (node.type === 'br') out += ' ';
    else if (node.first) {
      stack.push(node.next);
      node = node.first;
      continue;
    }
    node = node.next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bare URL autolinking (GFM "extended autolinks") on merged text outside of links

const RE_URL_START = /https?:\/\/|www\./gi;
const RE_DOMAIN_START = /^[\p{L}\p{N}]$/u;
const RE_WORD_CHAR = /^[\p{L}\p{N}_]$/u;
const TRAILING_URL_PUNCT = new Set([...'?!.,:;*_~\'"', '…', '。', '，', '、', '！', '？', '：', '；', '“', '”', '‘', '’', '«', '»']);

function isUrlStop(code) {
  return code <= 32 || code === C_LT || code === C_GT || code === 0x7f || code === 0xa0 || code === 0x3000
    || (code >= 0x2000 && code <= 0x200b) || code === 0x2028 || code === 0x2029 || code === 0x202f
    || code === 0x205f || code === 0xfeff;
}

function linkify(text) {
  RE_URL_START.lastIndex = 0;
  if (!RE_URL_START.test(text)) return escapeHtml(text);
  RE_URL_START.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = RE_URL_START.exec(text))) {
    const start = m.index;
    let end = start + m[0].length;
    while (end < text.length && !isUrlStop(text.charCodeAt(end))) end++;
    RE_URL_START.lastIndex = end;
    if (start > 0 && RE_WORD_CHAR.test(charBefore(text, start))) continue; // e.g. "xhttps://"
    end = trimUrlEnd(text, start, end);
    const raw = text.slice(start, end);
    const prefixLen = m[0].length;
    if (raw.length <= prefixLen || !RE_DOMAIN_START.test(charAfter(raw, prefixLen))) continue;
    const href = sanitizeLinkUrl(/^www\./i.test(raw) ? 'https://' + raw : raw);
    if (!href) continue;
    out += escapeHtml(text.slice(last, start))
      + `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(raw)}</a>`;
    last = end;
  }
  return out + escapeHtml(text.slice(last));
}

// Excludes trailing punctuation and unbalanced closing parentheses/brackets from a bare URL.
function trimUrlEnd(text, start, end) {
  let open = 0;
  let close = 0;
  let sqOpen = 0;
  let sqClose = 0;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === C_LPAREN) open++;
    else if (c === C_RPAREN) close++;
    else if (c === C_LBRACK) sqOpen++;
    else if (c === C_RBRACK) sqClose++;
  }
  while (end > start) {
    const ch = text[end - 1];
    if (TRAILING_URL_PUNCT.has(ch)) {
      end--;
    } else if (ch === ')' && close > open) {
      close--;
      end--;
    } else if (ch === ']' && sqClose > sqOpen) {
      sqClose--;
      end--;
    } else {
      break;
    }
  }
  return end;
}

// ---------------------------------------------------------------------------
// URL validation

// Characters browsers drop or that can hide a scheme: C0/C1 controls, soft hyphen, zero-width,
// bidi controls, BOM.
const RE_URL_INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const RE_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]{0,31}):/;
const RE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i;
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function normalizeUrl(raw) {
  return String(raw ?? '').replace(RE_URL_INVISIBLE, '').trim();
}

// → normalized absolute URL (http:, https:, mailto:) or null.
function sanitizeLinkUrl(raw) {
  const s = normalizeUrl(raw);
  const scheme = RE_SCHEME.exec(s);
  if (!scheme || !LINK_PROTOCOLS.has(scheme[1].toLowerCase() + ':')) return null;
  let url;
  try {
    url = new URL(s.replace(/\s/g, '%20'));
  } catch {
    return null;
  }
  if (!LINK_PROTOCOLS.has(url.protocol)) return null;
  if (url.protocol === 'mailto:') return url.href.length > 7 ? url.href : null;
  return url.hostname ? url.href : null;
}

// → https: URL or data:image/(png|jpeg|gif|webp);base64 URL, or null.
function sanitizeImageUrl(raw) {
  const s = normalizeUrl(raw);
  if (/^data:/i.test(s)) {
    const compact = s.replace(/\s+/g, '');
    return RE_DATA_IMAGE.test(compact) ? compact : null;
  }
  const scheme = RE_SCHEME.exec(s);
  if (!scheme || scheme[1].toLowerCase() !== 'https') return null;
  let url;
  try {
    url = new URL(s.replace(/\s/g, '%20'));
  } catch {
    return null;
  }
  return url.protocol === 'https:' && url.hostname ? url.href : null;
}

// ---------------------------------------------------------------------------
// Backslash escapes and character references

const RE_UNESCAPE = /\\([!-/:-@[-`{-~])|&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g;

function unescapeString(s) {
  if (!s.includes('\\') && !s.includes('&')) return s;
  return s.replace(RE_UNESCAPE, (match, esc, ent) => {
    if (esc !== undefined) return esc;
    const decoded = decodeEntity(ent);
    return decoded === null ? match : decoded;
  });
}

const NAMED_ENTITIES = Object.assign(Object.create(null), {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003',
  thinsp: '\u2009', shy: '\u00ad', zwj: '\u200d', zwnj: '\u200c', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', minus: '−', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  ldquo: '“', rdquo: '”', bdquo: '„', lsquo: '‘', rsquo: '’', sbquo: '‚', euro: '€', pound: '£',
  yen: '¥', cent: '¢', sect: '§', para: '¶', deg: '°', plusmn: '±', times: '×', divide: '÷',
  middot: '·', bull: '•', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', lArr: '⇐',
  rArr: '⇒', hArr: '⇔', le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', micro: 'µ', sup2: '²',
  sup3: '³', frac12: '½', frac14: '¼', frac34: '¾', iexcl: '¡', iquest: '¿', auml: 'ä', ouml: 'ö',
  uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', ecirc: 'ê',
  aacute: 'á', agrave: 'à', acirc: 'â', ccedil: 'ç', ntilde: 'ñ', oacute: 'ó', iacute: 'í',
  uacute: 'ú', Eacute: 'É', check: '✓', star: '☆', hearts: '♥',
});

function decodeEntity(body) {
  if (body[0] === '#') {
    const hex = body[1] === 'x' || body[1] === 'X';
    const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(cp);
  }
  return body in NAMED_ENTITIES ? NAMED_ENTITIES[body] : null;
}
