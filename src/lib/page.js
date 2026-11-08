// Page-content extraction. extractPageContent is serialized by scripting.executeScript and runs
// inside the web page, so it MUST stay self-contained: no imports, no closures over module scope.

export function extractPageContent(maxChars) {
  const limit = typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : 60000;
  const doc = document;
  const root = doc.documentElement;

  // Collapse horizontal whitespace runs, trim lines, keep at most one blank line between blocks.
  const normalize = (value) => String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[​‌‍⁠﻿]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const cut = (value, max) => {
    if (value.length <= max) return value;
    let out = value.slice(0, max);
    const lastBreak = Math.max(out.lastIndexOf('\n'), out.lastIndexOf(' '));
    if (lastBreak > max * 0.9) out = out.slice(0, lastBreak);
    // Never leave half a surrogate pair at the end.
    if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
    return out.trimEnd();
  };

  const textOf = (el) => {
    if (!el) return '';
    let raw = '';
    try {
      raw = typeof el.innerText === 'string' ? el.innerText : el.textContent;
    } catch {
      raw = el.textContent;
    }
    return normalize(raw);
  };

  const isRendered = (el) => {
    try {
      return el.getClientRects().length > 0;
    } catch {
      return true;
    }
  };

  const metaContent = (selector) => {
    try {
      const el = doc.querySelector(selector);
      return el ? normalize(el.getAttribute('content')) : '';
    } catch {
      return '';
    }
  };

  // Main text: prefer article/main/[role=main] when one of them holds most of the visible text.
  const body = doc.body;
  let text = '';
  if (body) {
    text = textOf(body);
    let best = '';
    try {
      const candidates = body.querySelectorAll('article, main, [role="main"]');
      const count = Math.min(candidates.length, 50);
      for (let i = 0; i < count; i++) {
        const el = candidates[i];
        if (!isRendered(el)) continue;
        const candidate = textOf(el);
        if (candidate.length > best.length) best = candidate;
      }
    } catch {
      best = '';
    }
    if (best && best.length >= text.length * 0.5) text = best;
  } else if (root) {
    text = textOf(root);
  }

  let truncated = false;
  if (text.length > limit) {
    text = cut(text, limit);
    truncated = true;
  }

  let title = normalize(doc.title);
  if (!title) title = metaContent('meta[property="og:title" i], meta[name="twitter:title" i]');
  if (!title) {
    try {
      title = normalize(doc.querySelector('h1')?.textContent).slice(0, 300);
    } catch {
      title = '';
    }
  }

  let lang = '';
  if (root) lang = normalize(root.getAttribute('lang') || root.getAttribute('xml:lang'));
  if (!lang) lang = metaContent('meta[http-equiv="content-language" i]');

  const description = cut(
    metaContent('meta[name="description" i]')
      || metaContent('meta[property="og:description" i]')
      || metaContent('meta[name="twitter:description" i]'),
    1000,
  );

  // Selection: text fields first (window.getSelection() does not cover them), then the document.
  // Password, one-time-code and credit-card fields are never read.
  let selection = '';
  let sensitive = false;
  try {
    let active = doc.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    const tag = active && active.tagName ? String(active.tagName).toUpperCase() : '';
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      const type = tag === 'INPUT' ? String(active.type || 'text').toLowerCase() : 'textarea';
      const autocomplete = String((active.getAttribute && active.getAttribute('autocomplete')) || '').toLowerCase().split(/\s+/);
      sensitive = type === 'password'
        || autocomplete.some((t) => t === 'current-password' || t === 'new-password' || t === 'one-time-code' || t.startsWith('cc-'));
      const textLike = type === 'textarea' || type === 'text' || type === 'search' || type === 'url' || type === 'tel';
      if (!sensitive && textLike) {
        const start = active.selectionStart;
        const end = active.selectionEnd;
        if (typeof start === 'number' && typeof end === 'number' && end > start) {
          selection = String(active.value || '').slice(start, end);
        }
      }
    }
  } catch {
    selection = '';
    sensitive = true;
  }
  if (!selection && !sensitive) {
    try {
      const sel = typeof getSelection === 'function' ? getSelection() : null;
      selection = sel ? String(sel.toString()) : '';
    } catch {
      selection = '';
    }
  }
  selection = cut(normalize(selection), limit);

  // Without credentials, query and fragment: they often carry tokens (password reset, OAuth).
  let url = '';
  try {
    url = String(location.href).split('#')[0].split('?')[0].replace(/^([a-z][\w+.-]*:\/\/)[^/@]*@/i, '$1');
  } catch {
    url = '';
  }

  return { title, url, lang, description, selection, text, truncated };
}
