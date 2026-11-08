// LLM Sidebar – content script: selection toolbar, result popover and in-place page translation.
// Classic, self-contained script (no imports). It talks to the background only through
// runtime.sendMessage and the 'llm-stream' port and never sees API keys.
(() => {
  'use strict';

  // Chrome < 148 has no `browser` in isolated worlds, so `browser` may resolve to a page element
  // with id/name "browser" (window named property) – only trust it when it is the real API.
  const ext = (() => {
    try {
      const b = globalThis.browser;
      if (b && b.runtime && b.runtime.id) return b;
    } catch {
      // ignore
    }
    return globalThis.chrome;
  })();
  if (!ext || !ext.runtime || typeof document === 'undefined') return;
  const docEl = document.documentElement;
  if (!docEl || docEl.namespaceURI !== 'http://www.w3.org/1999/xhtml') return; // skip SVG/XML documents

  const GUARD_KEY = '__llmSidebarContentScript';
  const EXT_ID = (() => {
    try {
      return String(ext.runtime.id || '');
    } catch {
      return '';
    }
  })();
  // Sub-frames (all_frames): selection toolbar + popover only; page translation is top-frame only.
  const IS_TOP = (() => {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  })();

  function isAlive() {
    try {
      return Boolean(ext.runtime && ext.runtime.id);
    } catch {
      return false;
    }
  }

  // Double-injection guard. An orphaned instance (extension reloaded) is torn down and replaced.
  try {
    const previous = window[GUARD_KEY];
    if (previous && typeof previous.alive === 'function') {
      if (previous.alive()) return;
      try {
        previous.destroy();
      } catch {
        // ignore
      }
    }
  } catch {
    // dead wrapper of a previous instance – continue with a fresh one
  }

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ZWSP = String.fromCharCode(0x200b);
  const VS16 = new RegExp(String.fromCharCode(0xfe0f), 'g');
  const IS_MAC = /Mac|iPhone|iPad|iPod/i.test((navigator.platform || '') + ' ' + (navigator.userAgent || ''));

  const CONFIG_TTL = 5000;
  const DEFAULT_BATCH_CHARS = 2500;
  const DEFAULT_CONCURRENCY = 3;
  const MAX_BATCH_SEGMENTS = 60;
  const MUTATION_DEBOUNCE = 800;
  const MUTATION_MAX_WAIT = 3000;
  const POPOVER_WIDTH = 440;
  const HINT_WIDTH = 330;
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel']);
  const SETTINGS_CODES = new Set(['no_provider', 'no_key', 'auth', 'forbidden', 'quota']);
  const MIN_FRAME_W = 120; // sub-frames smaller than this stay idle (ads, trackers, widgets)
  const MIN_FRAME_H = 60;
  const LARGE_SELECTION = 2000; // chars – above this only the selection ends are measured
  const MAX_REPORTED_SELECTION = 20000; // chars of a selection handed to the side panel (MAX_QUOTE_CHARS)
  const DEFAULT_CONFIG = Object.freeze({
    ready: false,
    toolbar: { enabled: true, disabledHosts: [] },
    quickActions: [],
    uiLanguage: 'en',
    messages: {},
    languages: [],
    translate: { targetLang: 'en', batchChars: DEFAULT_BATCH_CHARS, concurrency: DEFAULT_CONCURRENCY },
    theme: 'system',
    showUsage: true,
  });
  // Without a name the display name comes from actionName() (UI language).
  const DEFAULT_TRANSLATE_ACTION = Object.freeze({ id: 'translate', name: '', icon: '🌐' });

  // Built-in action id → [default emoji, own SVG icon]. A user-changed emoji is shown as is.
  const BUILTIN_ICONS = {
    improve: ['✨', 'sparkles'],
    rewrite: ['🔁', 'pen'],
    grammar: ['✅', 'spellcheck'],
    shorten: ['✂️', 'scissors'],
    expand: ['➕', 'expand'],
    formal: ['🎩', 'briefcase'],
    casual: ['😊', 'smile'],
    personalize: ['👤', 'user'],
    summarize: ['📝', 'summary'],
    explain: ['💡', 'bulb'],
    reply: ['↩️', 'reply'],
    translate: ['🌐', 'languages'],
  };

  // UI strings come from the background with the config (config.messages: content.* and common.*
  // in the active UI language, see src/locales/*/content.js). Only for the moments before any
  // config could be loaded (extension unreachable, service worker starting): minimal English texts
  // for the toolbar, the "not ready" hint and connection errors. Must equal src/locales/en/content.js.
  const FALLBACK_MESSAGES = Object.freeze({
    'content.toolbar.label': 'LLM Sidebar – Quick actions',
    'content.toolbar.more': 'More actions',
    'content.menu.quickActions': 'Quick actions',
    'content.menu.askInChat': 'Ask in chat',
    'content.menu.hideOnSite': 'Hide on this website',
    'content.menu.settings': 'Settings',
    'content.action.translate': 'Translate',
    'content.action.untitled': 'Action',
    'content.hint.title': 'No AI provider set up yet',
    'content.hint.text': 'Add an API key in Settings (e.g. for OpenAI, Claude or OpenRouter) – then you can improve, translate and do more with selected text right on the page.',
    'content.hint.later': 'Later',
    'content.openSettings': 'Open settings',
    'content.close': 'Close (Esc)',
    'content.panelHint': 'Open the sidebar with the LLM Sidebar icon – your chat is waiting there.',
    'content.error.unknown': 'Unknown error.',
    'content.error.invalidated': 'The extension was reloaded or updated. Reload the page to use it again.',
    'content.error.noReceiver': 'The extension is not responding. Reload the page and try again.',
    'content.error.portClosed': 'The extension did not respond. Please try again.',
    'content.error.disconnected': 'The connection to the extension was interrupted. Please try again.',
  });

  // Own simple stroke icons (24×24 grid).
  const DOT = { fill: 'currentColor', stroke: 'none' };
  const CHAT_PATH = 'M20 14.5a2 2 0 0 1-2 2H9l-4.5 3.5V6.5a2 2 0 0 1 2-2H18a2 2 0 0 1 2 2z';
  const ICONS = {
    sparkles: [['path', { d: 'M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z' }], ['path', { d: 'M18.5 14.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z' }]],
    pen: [['path', { d: 'M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16v4z' }], ['path', { d: 'M13.5 6.5l4 4' }]],
    spellcheck: [['path', { d: 'M3.5 15.5L7.5 5l4 10.5' }], ['path', { d: 'M5 11.5h5' }], ['path', { d: 'M13 16l2.8 2.8L21 13.5' }]],
    scissors: [['circle', { cx: '6', cy: '6.5', r: '2.5' }], ['circle', { cx: '6', cy: '17.5', r: '2.5' }], ['path', { d: 'M8.2 8L20 16.5' }], ['path', { d: 'M8.2 16L20 7.5' }]],
    expand: [['path', { d: 'M4 6h16' }], ['path', { d: 'M4 11h10' }], ['path', { d: 'M4 16h6' }], ['path', { d: 'M17 13v7' }], ['path', { d: 'M13.5 16.5h7' }]],
    briefcase: [['rect', { x: '3', y: '7.5', width: '18', height: '12.5', rx: '2' }], ['path', { d: 'M9 7.5v-2A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5v2' }], ['path', { d: 'M3 13h18' }]],
    smile: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8' }], ['circle', { cx: '9', cy: '9.8', r: '1.1', ...DOT }], ['circle', { cx: '15', cy: '9.8', r: '1.1', ...DOT }]],
    user: [['circle', { cx: '12', cy: '8', r: '3.8' }], ['path', { d: 'M4.5 20.5c.8-3.8 3.8-6 7.5-6s6.7 2.2 7.5 6' }]],
    summary: [['path', { d: 'M5 6h14' }], ['path', { d: 'M5 10.5h14' }], ['path', { d: 'M5 15h9' }], ['path', { d: 'M5 19.5h5.5' }]],
    bulb: [['path', { d: 'M9.5 18h5' }], ['path', { d: 'M10.5 21h3' }], ['path', { d: 'M12 3a6 6 0 0 0-3.5 10.9c.7.5 1 1.2 1 2v.1h5v-.1c0-.8.3-1.5 1-2A6 6 0 0 0 12 3z' }]],
    reply: [['path', { d: 'M10 7.5L5 12l5 4.5' }], ['path', { d: 'M5 12h9a5 5 0 0 1 5 5v2' }]],
    languages: [['path', { d: 'M3.5 5.5h9' }], ['path', { d: 'M8 3.5v2' }], ['path', { d: 'M10.6 5.5c-1 3.9-3.6 6.9-7.1 8.5' }], ['path', { d: 'M5.6 9c1.1 2 2.8 3.6 5 4.6' }], ['path', { d: 'M12.5 20.5l4-9 4 9' }], ['path', { d: 'M13.8 17.5h5.4' }]],
    more: [['circle', { cx: '5', cy: '12', r: '1.7', ...DOT }], ['circle', { cx: '12', cy: '12', r: '1.7', ...DOT }], ['circle', { cx: '19', cy: '12', r: '1.7', ...DOT }]],
    x: [['path', { d: 'M6.5 6.5l11 11' }], ['path', { d: 'M17.5 6.5l-11 11' }]],
    minus: [['path', { d: 'M6 12h12' }]],
    check: [['path', { d: 'M5 12.5l4.2 4.2L19 7' }]],
    copy: [['rect', { x: '8.5', y: '8.5', width: '11.5', height: '11.5', rx: '2.2' }], ['path', { d: 'M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5' }]],
    replace: [['path', { d: 'M4 6h10' }], ['path', { d: 'M4 11h6' }], ['path', { d: 'M4 16h5' }], ['path', { d: 'M20 7v6.5a3 3 0 0 1-3 3h-5' }], ['path', { d: 'M14.5 13.5l-3 3 3 3' }]],
    refresh: [['path', { d: 'M17.75 7.18A7.5 7.5 0 1 1 10.7 4.6' }], ['path', { d: 'M8.1 3.1l2.6 1.5-1.9 2.3' }]],
    stop: [['rect', { x: '6.5', y: '6.5', width: '11', height: '11', rx: '2', ...DOT }]],
    send: [['path', { d: 'M12 19V5.5' }], ['path', { d: 'M6 11.5l6-6 6 6' }]],
    chat: [['path', { d: CHAT_PATH }]],
    'chat-ask': [['path', { d: CHAT_PATH }], ['path', { d: 'M8.5 9h7' }], ['path', { d: 'M8.5 12.5h4' }]],
    sliders: [['path', { d: 'M4 7h9' }], ['path', { d: 'M18 7h2' }], ['path', { d: 'M4 17h3' }], ['path', { d: 'M12 17h8' }], ['circle', { cx: '15.5', cy: '7', r: '2.3' }], ['circle', { cx: '9.5', cy: '17', r: '2.3' }]],
    'eye-off': [['path', { d: 'M3 3l18 18' }], ['path', { d: 'M10.6 5.6c.5-.1.9-.1 1.4-.1 5 0 8.4 4.2 9.5 6.5-.5 1.1-1.4 2.4-2.6 3.6' }], ['path', { d: 'M6.4 6.9C4.6 8.2 3.3 10 2.5 12c1.1 2.3 4.5 6.5 9.5 6.5 1.6 0 3-.4 4.3-1' }], ['path', { d: 'M9.9 9.9a3 3 0 0 0 4.2 4.2' }]],
    alert: [['path', { d: 'M10.3 4.3L2.9 17.5a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z' }], ['path', { d: 'M12 9.5v4' }], ['circle', { cx: '12', cy: '17', r: '1.1', ...DOT }]],
    info: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M12 11v5.5' }], ['circle', { cx: '12', cy: '7.8', r: '1.1', ...DOT }]],
    globe: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M3 12h18' }], ['path', { d: 'M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z' }]],
    key: [['circle', { cx: '8', cy: '15', r: '4' }], ['path', { d: 'M11 12l8.5-8.5' }], ['path', { d: 'M16.5 6.5L19 9' }], ['path', { d: 'M14 9l2 2' }]],
    bolt: [['path', { d: 'M13 3L5 13.5h6L10 21l8-10.5h-6z' }]],
  };

  // ---------------------------------------------------------------------------
  // Styles (inside the closed shadow root only)
  // ---------------------------------------------------------------------------

  const LIGHT_VARS = `
    --bg: #fbfbfc; --bg-elev: #ffffff; --bg-sunken: #f3f3f6; --bg-hover: rgba(24,24,40,.06); --bg-active: rgba(24,24,40,.1);
    --border: #e4e4eb; --border-strong: #d2d2dc; --text: #1b1b22; --text-muted: #5f5f6d; --text-faint: #868693;
    --accent: #6d5efc; --accent-hover: #5b4cf0; --accent-contrast: #ffffff; --accent-soft: rgba(109,94,252,.12); --accent-text: #5a4bef;
    --danger: #d93a3f; --danger-soft: rgba(217,58,63,.1); --success: #1a7f53; --warning: #b45309; --warning-soft: rgba(180,83,9,.12);
    --input-bg: #ffffff; --selection: rgba(109,94,252,.22);
    --tip-bg: #1f1d2b; --tip-text: #f5f4fb; --tip-success: #6ee7a8; --tip-danger: #ff8a8f; --tip-info: #b9b2ff;
    --scrollbar: rgba(24,24,40,.2);
    --shadow: 0 1px 2px rgba(16,16,32,.06), 0 4px 14px rgba(16,16,32,.1);
    --shadow-lg: 0 0 0 1px rgba(16,16,32,.02), 0 4px 10px rgba(16,16,32,.08), 0 16px 40px rgba(16,16,32,.18);
    --focus: 0 0 0 3px rgba(109,94,252,.28);
    color-scheme: light;`;
  const DARK_VARS = `
    --bg: #17171b; --bg-elev: #1f1f25; --bg-sunken: #121215; --bg-hover: rgba(255,255,255,.07); --bg-active: rgba(255,255,255,.11);
    --border: #303039; --border-strong: #44444f; --text: #ececf1; --text-muted: #a6a6b3; --text-faint: #777785;
    --accent: #8b7fff; --accent-hover: #9d93ff; --accent-contrast: #0f0b29; --accent-soft: rgba(139,127,255,.18); --accent-text: #aaa1ff;
    --danger: #ff6369; --danger-soft: rgba(255,99,105,.15); --success: #3dd68c; --warning: #f0b429; --warning-soft: rgba(240,180,41,.15);
    --input-bg: #141418; --selection: rgba(139,127,255,.34);
    --tip-bg: #f0eff6; --tip-text: #18171f; --tip-success: #14804a; --tip-danger: #c62828; --tip-info: #5a4bef;
    --scrollbar: rgba(255,255,255,.18);
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 6px 18px rgba(0,0,0,.35);
    --shadow-lg: 0 0 0 1px rgba(255,255,255,.05), 0 4px 12px rgba(0,0,0,.4), 0 18px 44px rgba(0,0,0,.55);
    --focus: 0 0 0 3px rgba(139,127,255,.4);
    color-scheme: dark;`;

  const CSS = `
:host { all: initial !important; }
[hidden] { display: none !important; }
.root {${LIGHT_VARS}
  --font: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif;
  --emoji: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'Segoe UI Symbol', sans-serif;
  --brand: linear-gradient(135deg, #9a8cff 0%, #6d5efc 55%, #4f3fe0 100%);
  --ease: cubic-bezier(.2, .7, .2, 1);
  --dur: .14s;
  font: 400 13px/1.45 var(--font);
  color: var(--text);
  text-align: left; direction: ltr; letter-spacing: normal; word-spacing: normal; text-transform: none;
  text-indent: 0; text-shadow: none; white-space: normal; font-style: normal; font-variant: normal;
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; -webkit-text-size-adjust: 100%;
  pointer-events: none;
}
@media (prefers-color-scheme: dark) { .root:not([data-theme="light"]) {${DARK_VARS} } }
.root[data-theme="dark"] {${DARK_VARS} }
.root *, .root *::before, .root *::after { box-sizing: border-box; }
.root > * { pointer-events: auto; }
.root > .toasts { pointer-events: none; }
.root ::selection { background: var(--selection); }
.root button {
  font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; cursor: pointer;
  text-align: inherit; line-height: inherit; -webkit-appearance: none; appearance: none; -webkit-tap-highlight-color: transparent;
}
.root button:disabled { cursor: default; opacity: .45; }
.root button:focus-visible, .root input:focus-visible, .root [tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.root .pop:focus-visible, .root .hint:focus-visible { outline: none; box-shadow: var(--shadow-lg), var(--focus); }
.root svg { display: block; flex: none; overflow: visible; }
.emoji { font-family: var(--emoji); font-size: 15px; line-height: 1; font-style: normal; }

/* Toolbar */
.toolbar {
  position: fixed; z-index: 30; display: flex; align-items: center; flex-wrap: wrap; gap: 2px;
  max-width: calc(100vw - 16px); padding: 4px; background: var(--bg-elev); color: var(--text);
  border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-lg);
  user-select: none; -webkit-user-select: none; animation: llm-in .14s var(--ease) both;
}
.tb-brand {
  width: 26px; height: 26px; margin: 0 3px 0 1px; border-radius: 8px; display: grid; place-items: center;
  color: #fff; background: var(--brand); box-shadow: inset 0 0 0 1px rgba(255,255,255,.18);
}
.tb-brand svg * { fill: currentColor; stroke: none; }
.tb-btn {
  position: relative; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px;
  color: var(--text-muted); transition: background-color var(--dur), color var(--dur);
}
.tb-btn:hover, .tb-btn[aria-expanded="true"] { background: var(--bg-hover); color: var(--text); }
.tb-btn:active { background: var(--bg-active); }
.tb-btn::after {
  content: attr(data-tip); position: absolute; left: 50%; top: calc(100% + 8px); transform: translate(-50%, -2px);
  padding: 4px 8px; border-radius: 6px; background: var(--tip-bg); color: var(--tip-text); box-shadow: var(--shadow);
  font: 500 11.5px/1.3 var(--font); white-space: nowrap; pointer-events: none; opacity: 0; z-index: 2;
  transition: opacity .12s, transform .12s;
}
.tb-btn.tip-start::after { left: 0; transform: translate(0, -2px); }
.tb-btn.tip-end::after { left: auto; right: 0; transform: translate(0, -2px); }
.tb-btn:hover::after, .tb-btn:focus-visible::after { opacity: 1; transform: translate(-50%, 0); transition-delay: .35s; }
.tb-btn.tip-start:hover::after, .tb-btn.tip-start:focus-visible::after,
.tb-btn.tip-end:hover::after, .tb-btn.tip-end:focus-visible::after { transform: translate(0, 0); }
.toolbar.tips-up .tb-btn::after { top: auto; bottom: calc(100% + 8px); }
.toolbar.menu-open .tb-btn::after { display: none; }
.tb-sep { width: 1px; height: 18px; margin: 0 3px; background: var(--border); }

/* Menu */
.menu {
  position: absolute; z-index: 3; right: 0; top: calc(100% + 6px); min-width: 230px; max-width: min(310px, calc(100vw - 16px));
  max-height: min(380px, calc(100vh - 96px)); overflow-y: auto; overscroll-behavior: contain; padding: 5px;
  background: var(--bg-elev); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-lg);
  animation: llm-in .12s var(--ease) both; scrollbar-width: thin; scrollbar-color: var(--scrollbar) transparent;
}
.toolbar.menu-up .menu { top: auto; bottom: calc(100% + 6px); }
.toolbar.menu-left .menu { right: auto; left: 0; }
.menu-label { padding: 6px 9px 4px; font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--text-faint); }
.menu-item {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 32px; padding: 5px 9px; border-radius: 7px;
  color: var(--text); font-size: 13px; text-align: left;
}
.menu-item:hover, .menu-item:focus-visible { background: var(--bg-hover); outline: none; }
.menu-item:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.mi-icon { width: 18px; height: 18px; display: grid; place-items: center; flex: none; color: var(--text-muted); }
.mi-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu-sep { height: 1px; margin: 5px 4px; background: var(--border); }

/* Shared buttons */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 10px;
  border-radius: 8px; border: 1px solid transparent; font-size: 12.5px; font-weight: 500; color: var(--text);
  white-space: nowrap; transition: background-color var(--dur), border-color var(--dur), color var(--dur);
}
.btn:hover:not(:disabled) { background: var(--bg-hover); }
.btn:active:not(:disabled) { background: var(--bg-active); }
.btn-outline { border-color: var(--border); background: var(--bg-elev); }
.btn-primary { background: var(--accent); color: var(--accent-contrast); }
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn-primary:active:not(:disabled) { background: var(--accent-hover); filter: brightness(.95); }
.btn.is-done { color: var(--success); }
.btn.btn-primary.is-done { color: var(--accent-contrast); }
.icon-btn {
  width: 28px; height: 28px; display: grid; place-items: center; flex: none; border-radius: 8px; color: var(--text-muted);
  transition: background-color var(--dur), color var(--dur);
}
.icon-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
.lbl-short { display: none; }

/* Result popover + hint */
.pop, .hint {
  position: fixed; z-index: 20; display: flex; flex-direction: column; min-height: 0;
  background: var(--bg-elev); color: var(--text); border: 1px solid var(--border); border-radius: 14px;
  box-shadow: var(--shadow-lg); overflow: hidden; outline: none; animation: llm-in .16s var(--ease) both;
  container-type: inline-size;
}
.pop.dragging { transition: none; user-select: none; -webkit-user-select: none; box-shadow: var(--shadow-lg), 0 0 0 1px var(--accent-soft); }
.pop-head { display: flex; align-items: center; gap: 10px; padding: 9px 8px 8px 11px; cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; flex: none; }
.pop.dragging .pop-head { cursor: grabbing; }
.pop-icon, .hint-icon {
  width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; flex: none;
  background: var(--accent-soft); color: var(--accent-text);
}
.pop-titles { min-width: 0; flex: 1 1 auto; }
.pop-title { font-weight: 600; font-size: 13.5px; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pop-meta { font-size: 11.5px; line-height: 1.35; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 15px; }
.pop-lang {
  max-width: 100%; margin: 0; padding: 0 2px; border: 1px solid transparent; border-radius: 6px; background: transparent;
  color: var(--accent-text); font: inherit; cursor: pointer;
}
.pop-lang:hover { border-color: var(--border); }
.pop-lang:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.pop-lang option { color: var(--text); background: var(--bg-elev); }
.pop-source {
  flex: none; margin: 0 12px 8px; padding: 5px 9px; border-inline-start: 2px solid var(--border-strong);
  border-start-end-radius: 6px; border-end-end-radius: 6px; text-align: start;
  background: var(--bg-sunken); color: var(--text-muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pop-instr { flex: none; margin: -2px 12px 8px; text-align: start; font-size: 11.5px; color: var(--accent-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pop-body {
  flex: 1 1 auto; min-height: 44px; overflow-y: auto; overscroll-behavior: contain; padding: 2px 14px 12px;
  scrollbar-width: thin; scrollbar-color: var(--scrollbar) transparent;
}
.pop-body::-webkit-scrollbar { width: 8px; }
.pop-body::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
.pop-result {
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; font-size: 13.5px; line-height: 1.55; color: var(--text); text-align: start;
  user-select: text; -webkit-user-select: text; cursor: text;
}
.pop-result.streaming::after {
  content: ''; display: inline-block; width: 7px; height: 1.05em; margin-left: 2px; vertical-align: -2px;
  border-radius: 1px; background: var(--accent); animation: llm-blink 1s steps(2, start) infinite;
}
.pop-loading { display: flex; align-items: center; gap: 10px; min-height: 30px; color: var(--text-muted); font-size: 12.5px; }
.dots { display: inline-flex; gap: 4px; }
.dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); opacity: .3; animation: llm-dot 1.1s infinite ease-in-out; }
.dots i:nth-child(2) { animation-delay: .15s; }
.dots i:nth-child(3) { animation-delay: .3s; }
.pop-note { margin-top: 8px; font-size: 11.5px; color: var(--text-faint); }
.pop-error {
  display: flex; gap: 10px; margin-top: 4px; padding: 10px 11px; border-radius: 10px;
  background: var(--danger-soft); color: var(--text);
}
.pop-result:not([hidden]) + .pop-note + .pop-error { margin-top: 10px; }
.pop-error-icon { color: var(--danger); padding-top: 1px; }
.pop-error-main { min-width: 0; flex: 1; }
.pop-error-text { font-size: 12.5px; line-height: 1.45; overflow-wrap: anywhere; }
.pop-error-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.pop-foot { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 8px 10px 10px; border-top: 1px solid var(--border); background: var(--bg); }
.pop-foot:empty { display: none; }
.pop-hint { display: flex; align-items: flex-start; gap: 8px; padding: 7px 9px; border-radius: 8px; background: var(--accent-soft); color: var(--text); font-size: 12px; line-height: 1.4; }
.pop-hint svg { margin-top: 1px; color: var(--accent-text); }
.pop-stream-row { display: flex; align-items: center; gap: 10px; }
.pop-stream-hint { font-size: 11.5px; color: var(--text-faint); }
.pop-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.refine {
  display: flex; align-items: center; gap: 4px; padding: 2px 2px 2px 10px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--input-bg); transition: border-color var(--dur), box-shadow var(--dur);
}
.refine:focus-within { border-color: var(--accent); box-shadow: var(--focus); }
.refine input {
  flex: 1 1 auto; min-width: 0; height: 28px; margin: 0; padding: 0; border: 0; outline: none; background: transparent;
  color: var(--text); font: 400 12.5px/1.3 var(--font); -webkit-appearance: none; appearance: none;
}
.refine input::placeholder { color: var(--text-faint); opacity: 1; }
.refine input:focus-visible { outline: none; }
.refine .icon-btn { width: 28px; height: 28px; background: var(--accent); color: var(--accent-contrast); border-radius: 8px; }
.refine .icon-btn:hover:not(:disabled) { background: var(--accent-hover); color: var(--accent-contrast); }
@container (max-width: 380px) {
  .lbl-full { display: none; }
  .lbl-short { display: inline; }
  .pop-actions .btn { padding: 0 8px; }
}
.hint-head { display: flex; align-items: center; gap: 10px; padding: 10px 8px 4px 12px; }
.hint-title { flex: 1; min-width: 0; font-weight: 600; font-size: 13px; line-height: 1.3; }
.hint-text { margin: 0; padding: 2px 14px 12px 50px; color: var(--text-muted); font-size: 12.5px; line-height: 1.5; }
.hint-actions { display: flex; justify-content: flex-end; gap: 6px; padding: 8px 10px 10px; border-top: 1px solid var(--border); background: var(--bg); }

/* Page translation pill */
.pill {
  position: fixed; z-index: 10; right: 16px; bottom: 16px; max-width: min(480px, calc(100vw - 24px));
  display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 8px; overflow: hidden;
  background: var(--bg-elev); color: var(--text); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow-lg);
  animation: llm-up .18s var(--ease) both;
}
.pill .pill-icon { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; flex: none; background: var(--accent-soft); color: var(--accent-text); cursor: default; }
.pill.collapsed { gap: 0; padding: 4px; border-radius: 999px; }
.pill.collapsed .pill-text, .pill.collapsed .pill-actions, .pill.collapsed .pill-progress { display: none; }
.pill.collapsed .pill-icon { cursor: pointer; }
.pill[data-tone="error"] .pill-icon { background: var(--danger-soft); color: var(--danger); }
.pill[data-tone="warn"] .pill-icon { background: var(--warning-soft); color: var(--warning); }
.pill[data-tone="idle"] .pill-icon { background: var(--bg-sunken); color: var(--text-muted); }
.pill-text { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; padding-right: 2px; }
.pill-title { font-weight: 600; font-size: 12.5px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pill-sub {
  font-size: 11.5px; line-height: 1.35; color: var(--text-muted); overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere;
}
.pill-actions { display: flex; align-items: center; gap: 2px; flex: none; }
.pill-actions .btn { height: 28px; padding: 0 9px; }
.pill-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; }
.pill-progress > span { display: block; height: 100%; width: 0; background: var(--accent); transition: width .3s var(--ease); }
.spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: llm-spin .7s linear infinite; }
@media (max-width: 440px) {
  .pill { left: 12px; right: 12px; bottom: 12px; max-width: none; }
  .pill.collapsed { left: auto; }
}

/* Toasts */
.toasts {
  position: fixed; z-index: 40; left: 50%; bottom: 20px; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 6px; width: max-content; max-width: calc(100vw - 24px);
}
.root.has-pill .toasts { bottom: 78px; }
.toast {
  display: flex; align-items: flex-start; gap: 8px; max-width: 440px; padding: 9px 14px; border-radius: 10px;
  background: var(--tip-bg); color: var(--tip-text); box-shadow: var(--shadow-lg); font-size: 12.5px; line-height: 1.4;
  animation: llm-up .18s var(--ease) both;
}
.toast svg { margin-top: 1px; color: var(--tip-info); }
.toast-success svg { color: var(--tip-success); }
.toast-error svg { color: var(--tip-danger); }
.toast.leaving { opacity: 0; transform: translateY(4px); transition: opacity .18s, transform .18s; }

@keyframes llm-in { from { opacity: 0; transform: translateY(3px) scale(.985); } to { opacity: 1; transform: none; } }
@keyframes llm-up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes llm-spin { to { transform: rotate(360deg); } }
@keyframes llm-blink { 0% { opacity: 1; } 50% { opacity: 0; } }
@keyframes llm-dot { 0%, 80%, 100% { opacity: .25; transform: scale(.8); } 40% { opacity: 1; transform: scale(1); } }
@media (prefers-reduced-motion: reduce) {
  .root *, .root *::before, .root *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition: none !important; }
  .spinner { animation: llm-spin 1.6s linear infinite !important; }
}
`;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const listeners = new AbortController();
  let destroyed = false;

  let host = null; // <llm-sidebar-ui>
  let shadow = null; // closed shadow root
  let rootEl = null; // .root wrapper inside the shadow root
  let hostObserver = null;
  let hostObserverDeep = null; // observer mode: subtree while the host sits in a page dialog
  let uiContainer = null; // modal <dialog> / popover / focus-trapping dialog that holds the host
  let containerWatch = null; // AbortController for the container's close/toggle listeners
  let uiListeners = false; // listeners only needed once our UI exists
  let reattachCount = 0;
  let reattachWindow = 0;

  let config = null;
  let configAt = 0;
  let configPromise = null;

  let pointerDown = false; // primary button held on the page
  let uiPointerDown = false; // pointer held inside our UI
  let lastUiPointerAt = 0;
  let lastInputAt = 0;
  let lastPointer = null; // where the last press on the page ended: { x, y, sx, sy, at }
  let reportedSelection = ''; // last selection told to the side panel
  let checkTimer = 0;
  let selectionTimer = 0;
  let lastSnap = null;
  let idCounter = 0;

  const toolbar = { el: null, snap: null, pointer: null, menu: null, moreBtn: null, visible: false, raf: null };
  let popover = null;
  let hint = null;
  let toastsEl = null;
  let pill = null;
  let pt = null; // page translation state

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const now = () => Date.now();
  const uid = (prefix) => `llms-${prefix}-${++idCounter}`;
  const clamp = (n, min, max) => Math.min(Math.max(n, min), Math.max(min, max));
  const squash = (s) => String(s || '').replace(/\s+/g, '');
  const collapseWs = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const sameText = (a, b) => squash(a) === squash(b);
  const isValidSelectionText = (s) => squash(s).length >= 1;
  const hasTwoLetters = (s) => /\p{L}[\s\S]*?\p{L}/u.test(s);

  // ----- strings (i18n) -----

  const uiLanguage = () => (config && config.uiLanguage) || 'en';
  const intlCache = { lang: '', plural: null, number: null };

  function intlFor(lang) {
    if (intlCache.lang !== lang) {
      intlCache.lang = lang;
      try {
        intlCache.plural = new Intl.PluralRules(lang);
        intlCache.number = new Intl.NumberFormat(lang);
      } catch {
        intlCache.plural = null;
        intlCache.number = null;
      }
    }
    return intlCache;
  }

  function formatNumber(n) {
    const { number } = intlFor(uiLanguage());
    try {
      return number ? number.format(n) : String(n);
    } catch {
      return String(n);
    }
  }

  function lookupMessage(key) {
    const messages = config && config.messages;
    if (messages && Object.prototype.hasOwnProperty.call(messages, key)) return messages[key];
    return Object.prototype.hasOwnProperty.call(FALLBACK_MESSAGES, key) ? FALLBACK_MESSAGES[key] : undefined;
  }

  // t(key, { name }) – {placeholders}; with a numeric `count` the plural form
  // `key.one` / `key.other` … (Intl.PluralRules of the UI language) is used when present.
  function t(key, params) {
    let template;
    if (params && typeof params.count === 'number') {
      const { plural } = intlFor(uiLanguage());
      let form = params.count === 1 ? 'one' : 'other';
      try {
        if (plural) form = plural.select(params.count);
      } catch {
        // keep the simple rule
      }
      template = lookupMessage(`${key}.${form}`);
      if (template === undefined) template = lookupMessage(`${key}.other`);
    }
    if (template === undefined) template = lookupMessage(key);
    if (template === undefined) return key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => {
      if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
      const value = params[name];
      if (value === undefined || value === null) return match;
      return typeof value === 'number' ? formatNumber(value) : String(value);
    });
  }

  // ----- usage (tokens and costs reported by the background) -----

  const finiteNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

  /** { inputTokens, outputTokens, cost?, estimated? } from a response, or null. */
  function cleanUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const input = finiteNum(raw.inputTokens);
    const output = finiteNum(raw.outputTokens);
    if (input === undefined && output === undefined) return null;
    const out = { inputTokens: input || 0, outputTokens: output || 0 };
    const cost = finiteNum(raw.cost);
    if (cost !== undefined) {
      out.cost = cost;
      if (raw.estimated === true) out.estimated = true;
    }
    return out;
  }

  /** Running total over several requests; the cost stays known only while every request had one. */
  function addUsage(total, raw) {
    const u = cleanUsage(raw);
    if (!u) return total;
    if (!total) return { ...u, requests: 1, unpriced: u.cost === undefined ? 1 : 0, cost: u.cost || 0 };
    total.requests += 1;
    total.inputTokens += u.inputTokens;
    total.outputTokens += u.outputTokens;
    if (u.cost === undefined) total.unpriced += 1;
    else total.cost += u.cost;
    if (u.estimated) total.estimated = true;
    return total;
  }

  // Same rules as formatMoney() in lib/usage.js: below one cent with two significant digits.
  function formatMoney(amount) {
    const value = finiteNum(amount) || 0;
    const opts = { style: 'currency', currency: 'USD' };
    if (value === 0 || value >= 1) {
      opts.minimumFractionDigits = 2;
      opts.maximumFractionDigits = 2;
    } else if (value >= 0.01) {
      opts.minimumFractionDigits = 2;
      opts.maximumFractionDigits = 3;
    } else if (value < 0.000001) {
      return `< ${formatMoney(0.000001)}`;
    } else {
      opts.maximumSignificantDigits = 2;
    }
    try {
      return new Intl.NumberFormat(uiLanguage(), opts).format(value);
    } catch {
      return `$${value.toFixed(4)}`;
    }
  }

  function formatTokens(n) {
    try {
      return new Intl.NumberFormat(uiLanguage(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
    } catch {
      return String(n);
    }
  }

  /**
   * Usage total → { text: '1.2K tokens · ≈ $0.0004', title: details (multi-line) },
   * or null when the setting hides it or nothing is known.
   */
  function describeUsage(usage) {
    if (!usage || (config && config.showUsage === false)) return null;
    const tokens = usage.inputTokens + usage.outputTokens;
    const priced = usage.cost !== undefined && !usage.unpriced;
    const cost = priced ? `${usage.estimated ? '≈ ' : ''}${formatMoney(usage.cost)}` : '';
    const text = [t('content.usage.tokens', { count: tokens, tokens: formatTokens(tokens) }), cost].filter(Boolean).join(' · ');
    const lines = [t('content.usage.detail', { input: formatNumber(usage.inputTokens), output: formatNumber(usage.outputTokens) })];
    if (usage.requests > 1) lines.push(t('content.usage.requests', { count: usage.requests }));
    if (!priced) lines.push(t('content.usage.costUnknown'));
    else lines.push(t(usage.estimated ? 'content.usage.costEstimated' : 'content.usage.costReported'));
    return { text, title: lines.join('\n') };
  }

  // Display name of a translation target language (code or free text) in the UI language.
  function languageLabel(value) {
    const v = String(value || '').trim();
    const list = (config && config.languages) || [];
    const lower = v.toLowerCase();
    const found = list.find((l) => l.value === v) || list.find((l) => l.value.toLowerCase() === lower);
    return found ? found.label : v;
  }

  // Quick action names arrive as display names; unnamed ones get a generic one.
  function actionName(action) {
    if (action && action.name) return action.name;
    return t(action && action.id === 'translate' ? 'content.action.translate' : 'content.action.untitled');
  }

  // rAF with a timer fallback: rAF never fires in hidden/throttled frames, which would
  // otherwise leave a pending reposition stuck forever. Returns a cancel function.
  function nextFrame(fn) {
    let done = false;
    let raf = 0;
    let timer = 0;
    const cancel = () => {
      done = true;
      clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
    };
    const run = () => {
      if (done) return;
      cancel();
      fn();
    };
    timer = setTimeout(run, 100);
    try {
      raf = requestAnimationFrame(run);
    } catch {
      // no rAF – the timer runs it
    }
    return cancel;
  }

  function truncate(str, max) {
    const s = String(str || '');
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
  }

  function clampInt(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(clamp(n, min, max)) : fallback;
  }

  function report(err) {
    try {
      console.warn('[LLM Sidebar]', err);
    } catch {
      // ignore
    }
  }

  // Wraps every handler so neither page scripts nor our own bugs can break the page.
  function safe(fn) {
    return function safeHandler(...args) {
      try {
        return fn.apply(this, args);
      } catch (err) {
        report(err);
        return undefined;
      }
    };
  }

  // Global listeners also detect an orphaned instance (extension reloaded/updated) and tear it down,
  // so a freshly injected instance can take over.
  function on(target, type, fn, options = {}) {
    const handler = safe(fn);
    target.addEventListener(type, (e) => {
      if (destroyed) return;
      if (!isAlive()) {
        destroy();
        return;
      }
      handler(e);
    }, { ...options, signal: listeners.signal });
  }

  function errorText(err) {
    if (!err) return t('content.error.unknown');
    if (typeof err === 'string') return err;
    return err.message || String(err);
  }

  function readLastError() {
    try {
      const e = ext.runtime.lastError;
      return e ? e.message || String(e) : '';
    } catch {
      return '';
    }
  }

  function mapRuntimeError(err) {
    const msg = errorText(err);
    if (!isAlive() || /context invalidated|extension context|dead object/i.test(msg)) return t('content.error.invalidated');
    if (/receiving end does not exist|could not establish connection/i.test(msg)) return t('content.error.noReceiver');
    if (/message port closed|port closed/i.test(msg)) return t('content.error.portClosed');
    return msg;
  }

  function viewportSize() {
    const de = document.documentElement;
    const standards = document.compatMode === 'CSS1Compat';
    const w = (standards && de && de.clientWidth) || window.innerWidth || 0;
    const h = (standards && de && de.clientHeight) || window.innerHeight || 0;
    return { w, h };
  }

  // Our UI inherits CSS `zoom` from the page (<html>/<body>), so it is laid out in "UI px"
  // (viewport px / zoom). Rects and pointer coordinates are viewport px and get divided.
  function uiZoom() {
    let z = 1;
    try {
      z = Number(host && host.currentCSSZoom) || 1;
    } catch {
      z = 1;
    }
    return z > 0 ? z : 1;
  }

  function uiViewport() {
    const { w, h } = viewportSize();
    const z = uiZoom();
    return { w: w / z, h: h / z, z };
  }

  function scaleBox(r, z) {
    if (!r || z === 1) return r;
    const point = (p) => p && { x: p.x / z, top: p.top / z, bottom: p.bottom / z };
    return {
      left: r.left / z, top: r.top / z, right: r.right / z, bottom: r.bottom / z,
      width: (r.right - r.left) / z, height: (r.bottom - r.top) / z, start: point(r.start), end: point(r.end),
    };
  }

  const uiRect = (el, z) => scaleBox(el.getBoundingClientRect(), z);

  // Tiny sub-frames (ads, trackers, widgets) stay idle; the top frame always works.
  function frameTooSmall() {
    if (IS_TOP) return false;
    const { w, h } = viewportSize();
    return w < MIN_FRAME_W || h < MIN_FRAME_H;
  }

  function matches(el, selector) {
    try {
      return el.matches(selector);
    } catch {
      return false; // selector not supported by this browser
    }
  }

  function guardAlive() {
    if (isAlive()) return true;
    destroy();
    return false;
  }

  // ---------------------------------------------------------------------------
  // DOM builders
  // ---------------------------------------------------------------------------

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = String(value);
        else if (key === 'on') {
          for (const type of Object.keys(value)) el.addEventListener(type, safe(value[type]));
        } else el.setAttribute(key, value === true ? '' : String(value));
      }
    }
    appendChildren(el, children);
    return el;
  }

  function appendChildren(el, children) {
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) appendChildren(el, child);
      else el.append(child); // strings become text nodes
    }
  }

  function svg(name, size = 16) {
    const el = document.createElementNS(SVG_NS, 'svg');
    const attrs = {
      viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
    };
    for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    for (const [tag, a] of ICONS[name] || ICONS.bolt) {
      const child = document.createElementNS(SVG_NS, tag);
      for (const k of Object.keys(a)) child.setAttribute(k, a[k]);
      el.append(child);
    }
    return el;
  }

  function actionIcon(action, size = 16) {
    const builtin = action && BUILTIN_ICONS[action.id];
    const icon = action && typeof action.icon === 'string' ? action.icon.trim() : '';
    if (builtin && (!icon || icon.replace(VS16, '') === builtin[0].replace(VS16, ''))) return svg(builtin[1], size);
    if (icon) return h('span', { class: 'emoji', 'aria-hidden': 'true', text: icon });
    return svg('bolt', size);
  }

  function button(label, iconName, onClick, { cls = '', title = '', shortLabel = '' } = {}) {
    const labelNodes = shortLabel
      ? [h('span', { class: 'lbl-full', text: label }), h('span', { class: 'lbl-short', text: shortLabel })]
      : [h('span', { text: label })];
    return h('button', { type: 'button', class: `btn ${cls}`.trim(), title: title || null, on: { click: onClick } },
      iconName ? svg(iconName, 15) : null, labelNodes);
  }

  function iconButton(iconName, label, onClick, cls = '') {
    return h('button', { type: 'button', class: `icon-btn ${cls}`.trim(), title: label, 'aria-label': label, on: { click: onClick } }, svg(iconName, 16));
  }

  function setLabel(iconBtn, label) {
    iconBtn.title = label;
    iconBtn.setAttribute('aria-label', label);
  }

  // ---------------------------------------------------------------------------
  // Shadow host
  // ---------------------------------------------------------------------------

  const HOST_STYLE = [
    ['display', 'block'], ['position', 'fixed'], ['inset', '0 auto auto 0'], ['top', '0'], ['left', '0'],
    ['z-index', '2147483647'], ['width', '0'], ['height', '0'], ['margin', '0'], ['padding', '0'], ['border', '0'],
    ['overflow', 'visible'], ['visibility', 'visible'], ['opacity', '1'], ['transform', 'none'], ['filter', 'none'],
    ['pointer-events', 'none'],
  ];
  // Events that must not reach page handlers (hotkeys, focus traps, click-outside logic).
  const ISOLATED_EVENTS = [
    'keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'compositionstart', 'compositionend', 'mousedown', 'mouseup',
    'click', 'dblclick', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel', 'copy', 'cut', 'paste',
    'focusin', 'focusout', 'contextmenu', 'selectstart', 'dragstart',
  ];
  const stopEvent = (e) => e.stopPropagation();

  function styleHost(el) {
    const s = el.style;
    s.setProperty('all', 'initial', 'important');
    for (const [prop, value] of HOST_STYLE) s.setProperty(prop, value, 'important');
  }

  function installStyles(root) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
      if (root.adoptedStyleSheets.length === 1) return;
    } catch {
      // Firefox content scripts / old engines: fall back to a <style> element
    }
    const style = document.createElement('style');
    style.textContent = CSS;
    root.prepend(style);
  }

  // `anchorNode` = the page node the UI belongs to (selection). Inside a modal <dialog>, an open
  // popover or a focus-trapping dialog the host must live in that container (everything outside
  // is inert or bounces focus) and in the top layer (above it, not clipped by its transform).
  // Without an anchor the current container is kept while it is still open.
  function ensureUi(anchorNode) {
    if (!host) {
      host = document.createElement('llm-sidebar-ui');
      styleHost(host);
      if (EXT_ID) host.setAttribute('data-ext', EXT_ID);
      shadow = host.attachShadow({ mode: 'closed' });
      installStyles(shadow);
      rootEl = h('div', { class: 'root', translate: 'no' });
      shadow.append(rootEl);
      for (const type of ISOLATED_EVENTS) shadow.addEventListener(type, stopEvent);
      applyTheme();
      installUiListeners();
    }
    const container = anchorNode ? uiContainerFor(anchorNode) : uiContainer && isUiContainer(uiContainer) ? uiContainer : null;
    if (container !== uiContainer || !host.isConnected) {
      uiContainer = container;
      attachHost();
    }
    return rootEl;
  }

  const DIALOG_SELECTOR = '[aria-modal="true"], [role="dialog"], [role="alertdialog"]';

  function isUiContainer(el) {
    if (!el || el === host || el.nodeType !== 1 || !el.isConnected) return false;
    if (matches(el, ':modal') || matches(el, ':popover-open')) return true;
    return matches(el, DIALOG_SELECTOR) && el.getClientRects().length > 0;
  }

  // Nearest container ancestor of `node` (crossing shadow roots), or null for the document itself.
  function uiContainerFor(node) {
    let el = node && (node.nodeType === 1 ? node : node.parentNode);
    while (el) {
      if (el.nodeType === 11) {
        el = el.host || null;
        continue;
      }
      if (el.nodeType !== 1 || el === document.documentElement || el === document.body) return null;
      if (isUiContainer(el)) return el;
      el = el.parentNode;
    }
    return null;
  }

  function attachHost() {
    const root = document.documentElement;
    if (!root || !host) return;
    if (uiContainer && !uiContainer.isConnected) uiContainer = null;
    const parent = uiContainer || root;
    const t = now();
    if (t - reattachWindow > 60000) {
      reattachWindow = t;
      reattachCount = 0;
    }
    if (++reattachCount > 30) return; // the page keeps removing us – stop fighting
    try {
      // Hosts of an orphaned instance of this extension (other installs carry another id).
      for (const stale of root.querySelectorAll('llm-sidebar-ui')) {
        if (stale !== host && (!stale.dataset.ext || stale.dataset.ext === EXT_ID)) stale.remove();
      }
    } catch {
      // ignore
    }
    if (host.parentNode !== parent) parent.append(host);
    watchContainer(uiContainer);
    const deep = Boolean(uiContainer); // also notice the container itself being removed
    if (!hostObserver || hostObserverDeep !== deep) {
      if (hostObserver) hostObserver.disconnect();
      hostObserver = new MutationObserver(safe(onHostMutation));
      hostObserver.observe(root, { childList: true, subtree: deep });
      hostObserverDeep = deep;
    }
    syncTopLayer(false);
  }

  function watchContainer(el) {
    if (containerWatch && containerWatch.el === el) return;
    if (containerWatch) containerWatch.ctl.abort();
    containerWatch = null;
    if (!el) return;
    const ctl = new AbortController();
    const relocate = safe(() => {
      if (uiContainer === el && !isUiContainer(el)) {
        uiContainer = null;
        attachHost();
      }
    });
    // 'close' (dialog) and 'toggle' (popover) fire after the container was dismissed.
    for (const type of ['close', 'toggle']) el.addEventListener(type, () => setTimeout(relocate, 0), { signal: ctl.signal });
    containerWatch = { el, ctl };
  }

  // The host always lives in the top layer (popover API): no z-index of the page or of another
  // extension's overlay can cover our toolbar, menu or popover. `raise` re-shows it so it stacks
  // above top-layer elements that appeared later (fullscreen, page popovers, other overlays).
  function syncTopLayer(raise) {
    if (!host || !host.isConnected || typeof host.showPopover !== 'function') return;
    try {
      if (!host.hasAttribute('popover')) host.setAttribute('popover', 'manual');
      const open = host.matches(':popover-open');
      if (open && !raise) return;
      const focused = shadow ? shadow.activeElement : null;
      if (open) host.hidePopover();
      host.showPopover();
      if (focused && focused.isConnected && shadow.activeElement !== focused) focused.focus({ preventScroll: true });
    } catch (err) {
      report(err);
    }
  }

  function onHostMutation() {
    if (!isAlive()) {
      destroy();
      return;
    }
    if (!host) return;
    if (uiContainer && !uiContainer.isConnected) {
      uiContainer = null; // the page removed the dialog that held our UI
      if (hasVisibleUi()) attachHost();
      return;
    }
    if (!host.isConnected && hasVisibleUi()) attachHost();
  }

  function hasVisibleUi() {
    return Boolean(toolbar.visible || popover || hint || pt || (toastsEl && toastsEl.childElementCount));
  }

  function applyTheme() {
    if (!rootEl) return;
    const theme = config && (config.theme === 'light' || config.theme === 'dark') ? config.theme : 'system';
    rootEl.dataset.theme = theme;
    rootEl.lang = uiLanguage();
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  // Calls runtime.sendMessage synchronously (keeps user-gesture status) and unwraps { ok, error }.
  async function send(message) {
    if (!isAlive()) throw new Error(t('content.error.invalidated'));
    let res;
    try {
      res = await ext.runtime.sendMessage(message);
    } catch (err) {
      throw new Error(mapRuntimeError(err));
    }
    if (!res || typeof res !== 'object') throw new Error(t('content.error.portClosed'));
    if (res.ok === false) {
      const e = new Error(typeof res.error === 'string' && res.error ? res.error : t('content.error.unknown'));
      e.code = res.code || '';
      throw e;
    }
    return res;
  }

  function normalizeConfig(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const tb = c.toolbar && typeof c.toolbar === 'object' ? c.toolbar : {};
    const tr = c.translate && typeof c.translate === 'object' ? c.translate : {};
    return {
      ready: c.ready === true,
      toolbar: {
        enabled: tb.enabled !== false,
        disabledHosts: Array.isArray(tb.disabledHosts)
          ? tb.disabledHosts.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)
          : [],
      },
      quickActions: Array.isArray(c.quickActions)
        ? c.quickActions
          .filter((a) => a && typeof a.id === 'string' && a.id)
          .map((a) => ({
            id: a.id,
            name: truncate(String(a.name || '').trim(), 60), // '' → actionName()
            icon: typeof a.icon === 'string' ? a.icon.trim().slice(0, 16) : '',
            toolbar: a.toolbar === true,
            contextMenu: a.contextMenu !== false,
          }))
        : [],
      uiLanguage: typeof c.uiLanguage === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(c.uiLanguage) ? c.uiLanguage : 'en',
      messages: normalizeMessages(c.messages),
      languages: Array.isArray(c.languages)
        ? c.languages
          .filter((l) => l && typeof l.value === 'string' && l.value.trim())
          .slice(0, 300)
          .map((l) => ({
            value: l.value.trim(),
            label: typeof l.label === 'string' && l.label.trim() ? l.label.trim() : l.value.trim(),
          }))
        : [],
      translate: {
        targetLang: typeof tr.targetLang === 'string' && tr.targetLang.trim() && tr.targetLang.trim().toLowerCase() !== 'auto'
          ? tr.targetLang.trim()
          : 'en',
        batchChars: clampInt(tr.batchChars, 500, 20000, DEFAULT_BATCH_CHARS),
        concurrency: clampInt(tr.concurrency, 1, 10, DEFAULT_CONCURRENCY),
      },
      theme: c.theme === 'light' || c.theme === 'dark' ? c.theme : 'system',
      showUsage: c.showUsage !== false,
    };
  }

  // Only content.* / common.* string entries (the background sends nothing else).
  function normalizeMessages(raw) {
    const out = Object.create(null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const key of Object.keys(raw)) {
      if (typeof raw[key] === 'string' && (key.startsWith('content.') || key.startsWith('common.'))) out[key] = raw[key];
    }
    return out;
  }

  function getConfig(maxAge = CONFIG_TTL) {
    if (config && now() - configAt < maxAge) return Promise.resolve(config);
    if (!configPromise) {
      configPromise = send({ type: 'getContentConfig' })
        .then((res) => {
          const previousLanguage = config ? config.uiLanguage : '';
          config = normalizeConfig(res.config);
          configAt = now();
          applyTheme();
          // The toolbar, menu, popover and hint are rebuilt when shown; the pill is re-labelled now.
          if (previousLanguage && previousLanguage !== config.uiLanguage && pt && pill) renderPill();
          return config;
        })
        .catch((err) => {
          if (config) return config;
          throw err;
        })
        .finally(() => {
          configPromise = null;
        });
    }
    return configPromise;
  }

  async function configOrDefault(maxAge) {
    try {
      return await getConfig(maxAge);
    } catch {
      return config || normalizeConfig(DEFAULT_CONFIG);
    }
  }

  // about:blank / srcdoc frames (rich-text editors) have no hostname of their own – use their origin.
  function pageHostname() {
    let name = location.hostname || '';
    if (!name) {
      try {
        const origin = self.origin;
        if (origin && origin !== 'null') name = new URL(origin).hostname;
      } catch {
        name = '';
      }
    }
    return String(name || '').toLowerCase().replace(/\.$/, '');
  }

  function isHostDisabled(cfg) {
    const hostname = pageHostname();
    if (!hostname) return false;
    return cfg.toolbar.disabledHosts.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  }

  const toolbarAllowed = (cfg) => cfg.toolbar.enabled && !isHostDisabled(cfg);

  function findAction(cfg, id) {
    const found = cfg.quickActions.find((a) => a.id === id);
    if (found) return found;
    return id === 'translate' ? DEFAULT_TRANSLATE_ACTION : null;
  }

  function pageInfo() {
    let doc = document;
    let href = location.href;
    if (!IS_TOP && !/^https?:/.test(href)) {
      try {
        // about:blank / srcdoc editor frame: the (same-origin) top page is the real context
        href = window.top.location.href;
        doc = window.top.document;
      } catch {
        // cross-origin top
      }
    }
    let url = '';
    try {
      const u = new URL(href);
      url = /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}` : ''; // no query/hash (tokens)
    } catch {
      url = '';
    }
    return { title: truncate(collapseWs(doc.title), 200), url };
  }

  function openSettings() {
    send({ type: 'openOptions' }).catch((err) => toast(errorText(err), { type: 'error' }));
  }

  // ---------------------------------------------------------------------------
  // Selection snapshots
  // ---------------------------------------------------------------------------

  // Shadow root of an element – closed ones too (extension-only APIs) –, never the one of our UI.
  function shadowRootOf(el) {
    if (!el || el.nodeType !== 1 || el === host) return null;
    let root = null;
    try {
      root = el.shadowRoot;
      if (!root) {
        if (ext.dom && typeof ext.dom.openOrClosedShadowRoot === 'function') root = ext.dom.openOrClosedShadowRoot(el);
        else if ('openOrClosedShadowRoot' in el) root = el.openOrClosedShadowRoot;
      }
    } catch {
      root = null;
    }
    return root && root.nodeType === 11 ? root : null;
  }

  function deepActiveElement() {
    let el = document.activeElement;
    try {
      for (let depth = 0; el && depth < 32; depth += 1) {
        const root = shadowRootOf(el);
        if (!root || !root.activeElement) break;
        el = root.activeElement;
      }
    } catch {
      // ignore
    }
    return el;
  }

  function isTextControl(el) {
    if (!el) return false;
    if (el.localName === 'textarea') return true;
    return el.localName === 'input' && TEXT_INPUT_TYPES.has(String(el.type || 'text').toLowerCase());
  }

  function isOwnNode(node, offset) {
    if (!node || !host) return false;
    if (node === host) return true;
    try {
      if (shadow && node.getRootNode && node.getRootNode() === shadow) return true;
      if (node === host.parentNode) {
        const kids = node.childNodes;
        return kids[offset] === host || kids[offset - 1] === host;
      }
    } catch {
      // ignore
    }
    return false;
  }

  function editingHost(node) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el || !el.isContentEditable) return null;
    while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement;
    return el;
  }

  function isBackward(sel) {
    try {
      if (sel.anchorNode === sel.focusNode) return sel.focusOffset < sel.anchorOffset;
      return Boolean(sel.anchorNode.compareDocumentPosition(sel.focusNode) & Node.DOCUMENT_POSITION_PRECEDING);
    } catch {
      return false;
    }
  }

  // Current selection: { kind: 'text'|'input'|'editable', text, element?, start?, end?, range?, editable, backward }
  function takeSnapshot() {
    const active = deepActiveElement();
    if (host && active === host) return null; // focus inside our own UI
    let start = null;
    let end = null;
    if (isTextControl(active)) {
      try {
        start = active.selectionStart;
        end = active.selectionEnd;
      } catch {
        start = null;
      }
    }
    // A focused field without own selection (email/number/password fields cannot report one, or
    // nothing is selected in it) does not hide a selection elsewhere on the page.
    if (typeof start === 'number' && typeof end === 'number' && end > start) {
      const value = String(active.value || '');
      const text = value.slice(start, end);
      return {
        kind: 'input', text, element: active, start, end, at: now(),
        // surrounding text: finds the right occurrence again if the value changes meanwhile
        before: value.slice(Math.max(0, start - 40), start), after: value.slice(end, end + 40),
        editable: !active.readOnly && !active.disabled,
        backward: active.selectionDirection === 'backward',
      };
    }
    let sel;
    try {
      sel = window.getSelection();
    } catch {
      return null;
    }
    if (!sel || !sel.rangeCount) return null;
    if (isOwnNode(sel.anchorNode, sel.anchorOffset) || isOwnNode(sel.focusNode, sel.focusOffset)) return null;
    const text = sel.toString();
    if (!text) return null;
    let range = sel.getRangeAt(0);
    if (range.collapsed) range = composedSelectionRange(sel); // inside web components (Chrome)
    if (!range) return null;
    const editHost = editingHost(range.commonAncestorContainer);
    return {
      kind: editHost ? 'editable' : 'text', text, range: range.cloneRange(), element: editHost, at: now(),
      editable: Boolean(editHost), backward: isBackward(sel),
    };
  }

  // Chrome reports a selection inside a shadow tree as collapsed at its host (only toString() has
  // the text); Firefox returns the real range. Walks down through the shadow roots on the way.
  // → live, non-collapsed Range, or null.
  function composedSelectionRange(sel) {
    const childAt = (node, offset) => (node && node.nodeType === 1 && offset >= 0 ? node.childNodes[offset] || null : null);
    const toLive = (r) => {
      try {
        const range = document.createRange();
        range.setStart(r.startContainer, r.startOffset);
        range.setEnd(r.endContainer, r.endOffset);
        return range.collapsed ? null : range;
      } catch {
        return null;
      }
    };
    if (typeof sel.getComposedRanges === 'function') { // Chrome 137+
      const roots = [];
      const add = (node) => {
        const root = shadowRootOf(node);
        if (!root || roots.includes(root)) return false;
        roots.push(root);
        return true;
      };
      for (let depth = 0; depth < 16; depth += 1) {
        let r;
        try {
          r = sel.getComposedRanges({ shadowRoots: roots })[0];
        } catch {
          return null;
        }
        if (!r) return null;
        // An end point inside an unlisted shadow tree is moved next to its host.
        const added = [
          childAt(r.startContainer, r.startOffset), childAt(r.startContainer, r.startOffset - 1),
          childAt(r.endContainer, r.endOffset - 1), childAt(r.endContainer, r.endOffset),
        ].map(add).some(Boolean);
        if (added) continue;
        // Start and end in different trees: one Range cannot span them – take the hosts instead.
        if (toLive(r)) return toLive(r);
        try {
          const outer = sel.getComposedRanges({ shadowRoots: [] })[0];
          return outer ? toLive(outer) : null;
        } catch {
          return null;
        }
      }
      return null;
    }
    // Older Chrome: ShadowRoot.getSelection() (non-standard), one level at a time.
    let current = sel;
    for (let depth = 0; depth < 16; depth += 1) {
      const root = [childAt(current.anchorNode, current.anchorOffset), childAt(current.anchorNode, current.anchorOffset - 1)]
        .map(shadowRootOf).find(Boolean);
      if (!root || typeof root.getSelection !== 'function') return null;
      let next = null;
      try {
        next = root.getSelection();
      } catch {
        return null;
      }
      if (!next || !next.rangeCount) return null;
      const range = next.getRangeAt(0);
      if (!range.collapsed) return range.cloneRange();
      current = next;
    }
    return null;
  }

  const snapNode = (snap) => (snap ? snap.element || (snap.range && snap.range.commonAncestorContainer) || null : null);

  function sameSelection(a, b) {
    if (!a || !b || a.kind !== b.kind || a.text !== b.text || a.element !== b.element) return false;
    return a.kind !== 'input' || (a.start === b.start && a.end === b.end);
  }

  // Geometry of a snapshot: { left, top, right, bottom, start: {x, top, bottom}, end: {x, top, bottom} }
  function snapRect(snap) {
    if (!snap) return null;
    try {
      if (snap.kind === 'input') return controlRect(snap.element, snap.start, snap.end);
      if (snap.range) return rangeRect(snap.range, snap.text.length > LARGE_SELECTION);
    } catch (err) {
      report(err);
    }
    return null;
  }

  function rangeRect(range, large) {
    if (!range.startContainer || !range.startContainer.isConnected) return null;
    const caret = (toStart) => {
      const c = range.cloneRange();
      c.collapse(toStart);
      const cr = Array.from(c.getClientRects()).find((r) => r.height > 0.5);
      return cr ? { x: cr.left, top: cr.top, bottom: cr.bottom } : null;
    };
    if (large) return edgesRect(range, caret);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) {
      const b = range.getBoundingClientRect();
      if (!b.width && !b.height) return null;
      rects.push(b);
    }
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const r of rects) {
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    const first = rects[0];
    const last = rects[rects.length - 1];
    let start = caret(true) || { x: first.left, top: first.top, bottom: first.bottom };
    let end = caret(false) || { x: last.right, top: last.top, bottom: last.bottom };
    // A selection that ends at offset 0 of the next block reports a caret below the selection.
    if (end.top >= bottom - 1) end = { x: last.right, top: last.top, bottom: last.bottom };
    if (start.bottom <= top + 1) start = { x: first.left, top: first.top, bottom: first.bottom };
    return { left, top, right, bottom, start, end };
  }

  // Huge selections (Ctrl+A on a long page): measuring every line box costs tens of ms per frame,
  // so only the two ends are measured (falling back to the boundary element's box).
  function edgesRect(range, caret) {
    const edge = (toStart) => {
      const c = caret(toStart);
      if (c) return c;
      let node = toStart ? range.startContainer : range.endContainer;
      const offset = toStart ? range.startOffset : range.endOffset - 1;
      if (node.nodeType === 1 && node.childNodes.length) node = node.childNodes[clamp(offset, 0, node.childNodes.length - 1)];
      const el = node.nodeType === 1 ? node : node.parentElement;
      const r = el && el.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) return null;
      return toStart
        ? { x: r.left, top: r.top, bottom: Math.min(r.bottom, r.top + 24) }
        : { x: r.right, top: Math.max(r.top, r.bottom - 24), bottom: r.bottom };
    };
    const s = edge(true);
    const e = edge(false);
    if (!s && !e) return null;
    const start = s || e;
    const end = e || s;
    return {
      left: Math.min(start.x, end.x), top: Math.min(start.top, end.top),
      right: Math.max(start.x, end.x), bottom: Math.max(start.bottom, end.bottom), start, end,
    };
  }

  const MIRROR_PROPS = [
    'direction', 'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight', 'font-stretch',
    'font-feature-settings', 'font-kerning', 'line-height', 'letter-spacing', 'word-spacing', 'text-transform',
    'text-indent', 'text-align', 'tab-size', 'word-break', 'padding-top', 'padding-right', 'padding-bottom',
    'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  ];

  // Approximates the selection geometry inside a <textarea>/<input> with a hidden mirror element.
  function controlRect(el, start, end) {
    if (!el || !el.isConnected) return null;
    const box = el.getBoundingClientRect();
    if (!box.width && !box.height) return null;
    const cs = getComputedStyle(el);
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    const isInput = el.localName === 'input';
    const inner = {
      left: box.left + bl, top: box.top + bt,
      right: box.left + bl + (el.clientWidth || box.width), bottom: box.top + bt + (el.clientHeight || box.height),
    };
    let marks = null;
    if (shadow) {
      const mirror = document.createElement('div');
      try {
        const st = mirror.style;
        for (const p of MIRROR_PROPS) st.setProperty(p, cs.getPropertyValue(p));
        st.setProperty('position', 'fixed');
        st.setProperty('left', `${box.left}px`);
        st.setProperty('top', `${box.top}px`);
        st.setProperty('box-sizing', 'border-box');
        const mirrorWidth = (el.clientWidth || box.width) + bl + br;
        st.setProperty('width', `${mirrorWidth}px`);
        st.setProperty('height', 'auto');
        st.setProperty('margin', '0');
        st.setProperty('border-style', 'solid');
        st.setProperty('border-color', 'transparent');
        st.setProperty('visibility', 'hidden');
        st.setProperty('pointer-events', 'none');
        st.setProperty('overflow', 'visible');
        st.setProperty('white-space', isInput ? 'pre' : 'pre-wrap');
        st.setProperty('overflow-wrap', isInput ? 'normal' : 'break-word');
        const value = String(el.value || '');
        mirror.append(value.slice(0, start));
        const mark = document.createElement('span');
        mark.textContent = value.slice(start, end) || ZWSP;
        mirror.append(mark, `${value.slice(end)}${ZWSP}`);
        shadow.append(mirror);
        const rects = Array.from(mark.getClientRects()).filter((r) => r.height > 0);
        if (rects.length) {
          // relative to the mirror's own box: stays right when page zoom scales our UI
          const mr = mirror.getBoundingClientRect();
          const k = mirrorWidth > 0 && mr.width > 0 ? mr.width / mirrorWidth : 1; // zoom factor
          const dx = box.left - mr.left - el.scrollLeft * k;
          const dy = box.top - mr.top - el.scrollTop * k;
          const f = rects[0];
          const l = rects[rects.length - 1];
          marks = {
            start: { x: f.left + dx, top: f.top + dy, bottom: f.bottom + dy },
            end: { x: l.right + dx, top: l.top + dy, bottom: l.bottom + dy },
          };
        }
      } finally {
        mirror.remove();
      }
    }
    if (!marks) {
      return {
        left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        start: { x: box.left, top: box.top, bottom: box.bottom }, end: { x: box.right, top: box.top, bottom: box.bottom },
      };
    }
    const fix = (m) => ({
      x: clamp(m.x, inner.left, inner.right),
      top: isInput ? box.top : clamp(m.top, inner.top, inner.bottom),
      bottom: isInput ? box.bottom : clamp(m.bottom, inner.top, inner.bottom),
    });
    const s = fix(marks.start);
    const e = fix(marks.end);
    const multiLine = Math.abs(s.top - e.top) > 1;
    return {
      left: multiLine ? inner.left : Math.min(s.x, e.x),
      right: multiLine ? inner.right : Math.max(s.x, e.x),
      top: Math.min(s.top, e.top),
      bottom: Math.max(s.bottom, e.bottom),
      start: s,
      end: e,
    };
  }

  function pickSnapshot(givenText) {
    const candidates = [];
    try {
      const current = takeSnapshot();
      if (current && isValidSelectionText(current.text)) candidates.push(current);
    } catch {
      // ignore
    }
    if (lastSnap && now() - lastSnap.at < 30 * 60 * 1000) candidates.push(lastSnap);
    if (givenText && givenText.trim()) return candidates.find((c) => sameText(c.text, givenText)) || null;
    return candidates[0] || null;
  }

  // ---------------------------------------------------------------------------
  // Selection → side panel (ARCHITECTURE §7.4)
  // ---------------------------------------------------------------------------

  function selectionQuote(text) {
    const value = String(text || '');
    const info = pageInfo();
    return {
      text: value.slice(0, MAX_REPORTED_SELECTION),
      truncated: value.length > MAX_REPORTED_SELECTION,
      title: info.title,
      url: info.url,
    };
  }

  // Every change of the selection goes to the extension pages: an open side panel offers it as
  // reference for the chat. The background ignores the message; nothing leaves the browser here.
  function reportSelection(text) {
    const quote = selectionQuote(isValidSelectionText(text) ? text : '');
    if (quote.text === reportedSelection || !isAlive()) return;
    reportedSelection = quote.text;
    try {
      const sent = ext.runtime.sendMessage({ type: 'pageSelection', ...quote });
      if (sent && typeof sent.catch === 'function') sent.catch(() => {}); // no panel open
    } catch {
      // extension reloaded
    }
  }

  // ---------------------------------------------------------------------------
  // Selection toolbar
  // ---------------------------------------------------------------------------

  function scheduleCheck(delay, reason) {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(safe(() => {
      checkSelection(reason).catch(report);
    }), delay);
  }

  async function checkSelection(reason) {
    if (!guardAlive()) return;
    if (pointerDown || uiPointerDown || (popover && popover.drag)) return;
    if (now() - lastUiPointerAt < 400) return; // selection made inside our own UI
    if (host && document.activeElement === host) return; // keyboard focus is in our UI
    if (frameTooSmall()) {
      hideToolbar();
      return;
    }
    const snap = takeSnapshot();
    const valid = Boolean(snap) && isValidSelectionText(snap.text);
    reportSelection(valid ? snap.text : '');
    if (!valid) {
      hideToolbar();
      return;
    }
    lastSnap = snap;
    // A visible toolbar follows the selection – also when it changes without pointer/key input
    // (touch selection handles), so its buttons never act on outdated text.
    if (toolbar.visible && (sameSelection(toolbar.snap, snap) || reason === 'selectionchange')) {
      toolbar.snap = snap;
      positionToolbar();
      return;
    }
    if (reason === 'selectionchange' && now() - lastInputAt > 1200) return; // programmatic selection
    // Settings unreachable for a moment (service worker starting): the defaults still show the toolbar.
    const cfg = await configOrDefault();
    if (!toolbarAllowed(cfg)) {
      hideToolbar();
      return;
    }
    if (pointerDown || uiPointerDown) return;
    const current = takeSnapshot();
    if (!current || current.text !== snap.text) return;
    lastSnap = current;
    showToolbar(current, cfg);
  }

  function showToolbar(snap, cfg) {
    ensureUi(snapNode(snap));
    closeMenu(false);
    if (!toolbar.el) {
      toolbar.el = h('div', { class: 'toolbar', role: 'toolbar', 'aria-orientation': 'horizontal' });
      // Keep the page selection and focus while clicking our buttons.
      toolbar.el.addEventListener('mousedown', (e) => e.preventDefault());
      toolbar.el.addEventListener('keydown', safe(onToolbarKeydown));
    }
    // Labels are set on every show: the UI language may have changed meanwhile.
    toolbar.el.setAttribute('aria-label', t('content.toolbar.label'));
    // Every action – "Übersetzen" included – honours its toolbar switch and list position.
    const language = languageLabel(cfg.translate.targetLang);
    const buttons = cfg.quickActions.filter((a) => a.toolbar).map((a) => {
      const label = a.id === 'translate' ? t('content.translateTo', { language }) : actionName(a);
      return h('button', {
        type: 'button', class: 'tb-btn', 'aria-label': label, 'data-tip': label,
        on: { click: (e) => onToolbarAction(a, e) },
      }, actionIcon(a, 17));
    });
    toolbar.moreBtn = h('button', {
      type: 'button', class: 'tb-btn tip-end', 'aria-label': t('content.toolbar.more'), 'data-tip': t('content.toolbar.more'),
      'aria-haspopup': 'menu', 'aria-expanded': 'false',
      on: { click: (e) => toggleMenu(e.detail === 0) },
    }, svg('more', 17));
    if (buttons.length) buttons[0].classList.add('tip-start');
    toolbar.el.replaceChildren(
      h('span', { class: 'tb-brand', title: 'LLM Sidebar', 'aria-hidden': 'true' }, svg('sparkles', 15)),
      ...buttons,
      ...(buttons.length ? [h('span', { class: 'tb-sep', 'aria-hidden': 'true' })] : []),
      toolbar.moreBtn,
    );
    toolbar.snap = snap;
    toolbar.pointer = lastPointer && now() - lastPointer.at < 1500 ? lastPointer : null;
    toolbar.visible = true;
    toolbar.el.style.visibility = 'hidden';
    if (!toolbar.el.isConnected) rootEl.append(toolbar.el);
    syncTopLayer(true);
    positionToolbar();
  }

  function hideToolbar() {
    if (!toolbar.visible) return;
    closeMenu(false);
    toolbar.visible = false;
    toolbar.snap = null;
    toolbar.pointer = null;
    if (toolbar.raf) toolbar.raf();
    toolbar.raf = null;
    if (toolbar.el) toolbar.el.remove();
  }

  function positionToolbar() {
    const el = toolbar.el;
    if (!toolbar.visible || !el || !toolbar.snap) return;
    const { w: vw, h: vh, z } = uiViewport();
    const r = scaleBox(snapRect(toolbar.snap) || fallbackRect(toolbar.snap), z);
    if (!r || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) {
      el.style.visibility = 'hidden';
      return;
    }
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    const backward = toolbar.snap.backward;
    const line = backward ? r.start : r.end;
    const gap = 8;
    const fits = (t) => t >= 4 && t + th <= vh - 4;
    const below = line.bottom + gap;
    const above = line.top - gap - th;
    let top;
    if (backward) top = fits(above) ? above : fits(below) ? below : clamp(above, 4, vh - th - 4);
    else top = fits(below) ? below : fits(above) ? above : clamp(below, 4, vh - th - 4);
    const left = clamp(line.x - tw / 2, 8, vw - tw - 8);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.classList.toggle('tips-up', top < line.top);
    el.style.visibility = '';
    if (toolbar.menu) positionMenu();
  }

  // A selection the browser reports without geometry (some editors, SVG text, unusual layouts)
  // still gets its toolbar: where the pointer released it, else at the element holding it.
  function fallbackRect(snap) {
    const p = toolbar.pointer;
    if (p) {
      const x = p.x - (window.scrollX - p.sx);
      const y = p.y - (window.scrollY - p.sy);
      const caret = { x, top: y - 10, bottom: y + 10 };
      return { left: x, right: x, top: caret.top, bottom: caret.bottom, start: caret, end: caret };
    }
    let el = snapNode(snap);
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    let b;
    try {
      b = el.getBoundingClientRect();
    } catch {
      return null;
    }
    if (!b.width && !b.height) return null;
    const caret = { x: b.left + Math.min(b.width / 2, 60), top: b.top, bottom: Math.min(b.bottom, b.top + 24) };
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, start: caret, end: caret };
  }

  function requestToolbarReposition() {
    if (!toolbar.visible || toolbar.raf) return;
    toolbar.raf = nextFrame(safe(() => {
      toolbar.raf = null;
      positionToolbar();
    }));
  }

  function onToolbarKeydown(e) {
    if (toolbar.menu && toolbar.menu.contains(e.target)) return;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target === toolbar.moreBtn) {
      if (!toolbar.menu) openMenu(true);
      else toolbar.menu.querySelector('.menu-item')?.focus();
      e.preventDefault();
      return;
    }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    const items = Array.from(toolbar.el.querySelectorAll(':scope > .tb-btn'));
    if (!items.length) return;
    const i = items.indexOf(shadow.activeElement);
    let next = 0;
    if (e.key === 'ArrowRight') next = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'End') next = items.length - 1;
    items[next].focus();
    e.preventDefault();
  }

  // The live selection wins whenever it is valid (offsets/handles may have moved since the toolbar
  // was shown); the stored snapshot covers focus inside our own UI.
  function currentToolbarSnap() {
    const live = takeSnapshot();
    if (live && isValidSelectionText(live.text)) return live;
    return toolbar.snap || lastSnap;
  }

  function onToolbarAction(action, event) {
    const snap = currentToolbarSnap();
    const keyboard = Boolean(event && event.detail === 0);
    hideToolbar();
    if (!snap || !action) return;
    launch({ action, text: snap.text, snap, anchor: snapRect(snap), focus: keyboard }).catch(report);
  }

  async function launch({ action, text, snap, anchor, focus, lang }) {
    let cfg = await configOrDefault();
    if (!cfg.ready) cfg = await configOrDefault(0);
    if (!cfg.ready) {
      showHint(anchor, focus, snapNode(snap));
      return false;
    }
    const isTranslate = action.id === 'translate';
    openPopover({
      action, kind: isTranslate ? 'translate' : 'action', lang: lang || cfg.translate.targetLang,
      text, snap, anchor, focus,
    });
    return true;
  }

  // ----- ⋯ menu -----

  function toggleMenu(fromKeyboard) {
    if (toolbar.menu) closeMenu(true);
    else openMenu(fromKeyboard);
  }

  function menuItem(iconNode, label, onClick) {
    return h('button', { type: 'button', class: 'menu-item', role: 'menuitem', tabindex: '-1', on: { click: onClick } },
      h('span', { class: 'mi-icon', 'aria-hidden': 'true' }, iconNode), h('span', { class: 'mi-label', text: label }));
  }

  function openMenu(fromKeyboard) {
    if (!toolbar.el || !toolbar.visible) return;
    const cfg = config || normalizeConfig(DEFAULT_CONFIG);
    const menu = h('div', { class: 'menu', role: 'menu', 'aria-label': t('content.toolbar.more') });
    menu.append(h('div', { class: 'menu-label', 'aria-hidden': 'true', text: t('content.menu.quickActions') }));
    const actions = cfg.quickActions.length ? cfg.quickActions : [DEFAULT_TRANSLATE_ACTION];
    for (const a of actions) menu.append(menuItem(actionIcon(a, 16), actionName(a), (e) => onToolbarAction(a, e)));
    menu.append(h('div', { class: 'menu-sep', role: 'separator' }));
    menu.append(menuItem(svg('chat-ask', 16), t('content.menu.askInChat'), askInChat));
    if (pageHostname()) menu.append(menuItem(svg('eye-off', 16), t('content.menu.hideOnSite'), hideOnThisSite));
    menu.append(menuItem(svg('sliders', 16), t('content.menu.settings'), () => {
      hideToolbar();
      openSettings();
    }));
    menu.addEventListener('keydown', safe(onMenuKeydown));
    toolbar.menu = menu;
    toolbar.el.append(menu);
    toolbar.el.classList.add('menu-open');
    toolbar.moreBtn.setAttribute('aria-expanded', 'true');
    syncTopLayer(true); // overlays that appeared after the toolbar (e.g. other extensions) stay below
    positionMenu();
    const first = menu.querySelector('.menu-item');
    if (first) {
      first.tabIndex = 0;
      if (fromKeyboard) first.focus();
    }
  }

  function positionMenu() {
    const menu = toolbar.menu;
    if (!menu || !toolbar.el) return;
    const { w: vw, h: vh, z } = uiViewport();
    const tb = uiRect(toolbar.el, z);
    const mh = menu.offsetHeight;
    const mw = menu.offsetWidth;
    const spaceBelow = vh - tb.bottom - 14;
    const spaceAbove = tb.top - 14;
    const up = mh > spaceBelow && spaceAbove > spaceBelow;
    toolbar.el.classList.toggle('menu-up', up);
    menu.style.maxHeight = `${Math.max(120, Math.min(380, up ? spaceAbove : spaceBelow))}px`;
    toolbar.el.classList.toggle('menu-left', tb.right - mw < 8 && tb.left + mw <= vw - 8);
  }

  function closeMenu(focusMore) {
    const menu = toolbar.menu;
    if (!menu) return;
    const hadFocus = Boolean(shadow && menu.contains(shadow.activeElement));
    menu.remove();
    toolbar.menu = null;
    if (toolbar.el) toolbar.el.classList.remove('menu-open', 'menu-up', 'menu-left');
    if (toolbar.moreBtn) {
      toolbar.moreBtn.setAttribute('aria-expanded', 'false');
      if (focusMore && hadFocus) toolbar.moreBtn.focus();
    }
  }

  function onMenuKeydown(e) {
    const items = Array.from(toolbar.menu ? toolbar.menu.querySelectorAll('.menu-item') : []);
    if (!items.length) return;
    const i = items.indexOf(shadow.activeElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Tab') {
      closeMenu(true);
      return;
    }
    if (next < 0) return;
    for (const item of items) item.tabIndex = -1;
    items[next].tabIndex = 0;
    items[next].focus();
    e.preventDefault();
  }

  // Must call runtime.sendMessage synchronously inside the click (Chrome side panel gesture).
  function askInChat() {
    const snap = currentToolbarSnap();
    hideToolbar();
    if (!snap) return;
    send({ type: 'openInChat', payload: { kind: 'prefill', quote: selectionQuote(snap.text) } })
      .then((res) => {
        if (res.opened === false) toast(t('content.panelHint'), { timeout: 8000 });
      })
      .catch((err) => toast(errorText(err), { type: 'error' }));
  }

  function hideOnThisSite() {
    const hostname = pageHostname();
    hideToolbar();
    if (!hostname) return;
    send({ type: 'disableToolbarOnHost', host: hostname })
      .then(() => {
        if (config && !config.toolbar.disabledHosts.includes(hostname)) config.toolbar.disabledHosts.push(hostname);
        toast(t('content.toast.hiddenOnSite', { host: hostname }), { type: 'success', timeout: 5500 });
      })
      .catch((err) => toast(errorText(err), { type: 'error' }));
  }

  // ---------------------------------------------------------------------------
  // Floating placement (popover + hint)
  // ---------------------------------------------------------------------------

  const heightCap = (vh) => Math.min(560, Math.round(vh * 0.8));

  // `anchor` is in viewport px (a selection rect) or null.
  function placeFloating(el, viewportAnchor, width) {
    const { w: vw, h: vh, z } = uiViewport();
    const anchor = scaleBox(viewportAnchor, z);
    const w = Math.max(200, Math.min(width, vw - 16));
    const margin = 8;
    const cap = heightCap(vh);
    let left;
    let top = null;
    let bottom = null;
    let maxH;
    if (anchor) {
      const aTop = clamp(anchor.top, 0, vh);
      const aBottom = clamp(anchor.bottom, 0, vh);
      const below = vh - aBottom - margin * 2;
      const above = aTop - margin * 2;
      left = clamp(anchor.left, margin, vw - w - margin);
      if (below >= 240 || (below >= above && below >= 160)) {
        top = aBottom + margin;
        maxH = Math.min(cap, below);
      } else if (above >= 160) {
        bottom = vh - aTop + margin;
        maxH = Math.min(cap, above);
      } else {
        bottom = margin;
        maxH = Math.min(cap, vh - margin * 2);
      }
    } else {
      left = vw - w - 16;
      top = 16;
      maxH = Math.min(cap, vh - 32);
    }
    el.style.width = `${Math.round(w)}px`;
    el.style.left = `${Math.round(Math.max(margin, left))}px`;
    el.style.top = top === null ? 'auto' : `${Math.round(top)}px`;
    el.style.bottom = bottom === null ? 'auto' : `${Math.round(bottom)}px`;
    el.style.maxHeight = `${Math.round(Math.max(140, maxH))}px`;
  }

  function keepInViewport(el, width) {
    if (!el || !el.isConnected) return;
    const { w: vw, h: vh, z } = uiViewport();
    const w = Math.max(200, Math.min(width, vw - 16));
    el.style.width = `${Math.round(w)}px`;
    const r = uiRect(el, z);
    el.style.left = `${Math.round(clamp(r.left, 8, vw - w - 8))}px`;
    if (el.style.bottom && el.style.bottom !== 'auto') {
      const bottom = clamp(vh - r.bottom, 8, Math.max(8, vh - 140));
      el.style.bottom = `${Math.round(bottom)}px`;
      el.style.maxHeight = `${Math.round(Math.max(140, Math.min(heightCap(vh), vh - bottom - 8)))}px`;
    } else {
      const top = clamp(r.top, 8, Math.max(8, vh - 140));
      el.style.top = `${Math.round(top)}px`;
      el.style.maxHeight = `${Math.round(Math.max(140, Math.min(heightCap(vh), vh - top - 8)))}px`;
    }
  }

  // ---------------------------------------------------------------------------
  // "Not ready" hint
  // ---------------------------------------------------------------------------

  function showHint(anchor, focus, anchorNode) {
    closeHint();
    ensureUi(anchorNode);
    syncTopLayer(true);
    const titleId = uid('hint');
    const el = h('div', { class: 'hint', role: 'dialog', 'aria-labelledby': titleId, tabindex: '-1' },
      h('div', { class: 'hint-head' },
        h('span', { class: 'hint-icon', 'aria-hidden': 'true' }, svg('key', 16)),
        h('div', { class: 'hint-title', id: titleId, text: t('content.hint.title') }),
        iconButton('x', t('content.close'), closeHint)),
      h('p', { class: 'hint-text', text: t('content.hint.text') }),
      h('div', { class: 'hint-actions' },
        button(t('content.hint.later'), null, closeHint),
        button(t('content.openSettings'), 'sliders', () => {
          closeHint();
          openSettings();
        }, { cls: 'btn-primary' })));
    hint = { el };
    rootEl.append(el);
    placeFloating(el, anchor, HINT_WIDTH);
    if (focus) el.focus({ preventScroll: true });
  }

  function closeHint() {
    if (!hint) return;
    const { el } = hint;
    hint = null;
    el.remove();
  }

  // ---------------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------------

  function toast(message, { type = 'info', timeout } = {}) {
    if (!message) return;
    ensureUi();
    if (!toastsEl) toastsEl = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    if (!toastsEl.isConnected) rootEl.append(toastsEl);
    const iconName = type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info';
    const el = h('div', { class: `toast toast-${type}` }, svg(iconName, 15), h('span', { dir: 'auto', text: message }));
    toastsEl.append(el);
    while (toastsEl.childElementCount > 3) toastsEl.firstElementChild.remove();
    const ms = typeof timeout === 'number' ? timeout : type === 'error' ? 5500 : 3200;
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 220);
    }, ms);
  }

  // ---------------------------------------------------------------------------
  // Result popover
  // ---------------------------------------------------------------------------

  const currentTurn = (p) => p.turns[p.turns.length - 1] || null;
  const isBusy = (turn) => Boolean(turn && (turn.status === 'loading' || turn.status === 'streaming'));

  function openPopover({ action, kind, lang, text, snap, anchor, focus }) {
    closePopover({ restoreFocus: false });
    closeHint();
    hideToolbar();
    ensureUi(snapNode(snap));
    syncTopLayer(true);
    const editable = Boolean(snap && snap.editable && (snap.kind === 'input' || snap.kind === 'editable') && sameText(snap.text, text));
    const p = {
      action, kind, lang, text, snap: editable ? snap : null, editable,
      turns: [], port: null, runId: 0, meta: '', drag: null, paintTimer: 0, el: null, parts: null,
    };
    popover = p;
    buildPopover(p);
    rootEl.append(p.el);
    placeFloating(p.el, anchor, POPOVER_WIDTH);
    const turn = newTurn(baseTask(p), null);
    p.turns.push(turn);
    runTurn(p, turn);
    if (focus) p.el.focus({ preventScroll: true });
  }

  const newTurn = (task, instruction) => ({ task, instruction, text: '', status: 'loading', error: '', code: '', finishReason: '' });

  function baseTask(p) {
    if (p.kind === 'translate') return { kind: 'translate', text: p.text, lang: p.lang };
    return { kind: 'action', actionId: p.action.id, text: p.text, page: pageInfo() };
  }

  // Translations are refined as kind 'translate' (translation model, works without the quick action).
  function refineTask(p, instruction, previous) {
    if (p.kind === 'translate') return { kind: 'translate', text: p.text, lang: p.lang, instruction, previous, page: pageInfo() };
    return { kind: 'action', actionId: p.action.id, text: p.text, instruction, previous, page: pageInfo() };
  }

  // Translation popovers: "Übersetzen nach <Sprache ▾>" – another language re-runs the translation.
  function buildTitle(p, titleId) {
    if (p.kind !== 'translate') return h('div', { class: 'pop-title', id: titleId, text: actionName(p.action) });
    const known = (config && config.languages) || [];
    // A value outside the list (free text from the settings) stays selectable.
    const langs = known.some((l) => l.value === p.lang) ? known : [{ value: p.lang, label: languageLabel(p.lang) }, ...known];
    const select = h('select', { class: 'pop-lang', 'aria-label': t('content.popover.targetLanguage'), title: t('content.popover.chooseTargetLanguage') },
      langs.map((l) => h('option', { value: l.value, text: l.label })));
    select.value = p.lang;
    select.addEventListener('change', safe(() => changeLang(p, select.value)));
    return h('div', { class: 'pop-title', id: titleId }, templateNodes(t('content.translateTo'), { language: select }));
  }

  // 'Übersetzen nach {language}' → ['Übersetzen nach ', <select>]: the word order follows the language.
  function templateNodes(template, nodes) {
    const out = [];
    let last = 0;
    template.replace(/\{(\w+)\}/g, (match, name, offset) => {
      if (!Object.prototype.hasOwnProperty.call(nodes, name)) return match;
      if (offset > last) out.push(template.slice(last, offset));
      out.push(nodes[name]);
      last = offset + match.length;
      return match;
    });
    if (last < template.length) out.push(template.slice(last));
    return out;
  }

  function changeLang(p, lang) {
    if (popover !== p || !lang || lang === p.lang) return;
    p.lang = lang;
    p.turns = [];
    const turn = newTurn(baseTask(p), null);
    p.turns.push(turn);
    runTurn(p, turn); // drops the running answer (its port is disconnected)
  }

  function buildPopover(p) {
    const parts = {};
    const titleId = uid('pop');
    parts.title = buildTitle(p, titleId);
    parts.meta = h('div', { class: 'pop-meta', text: t('content.popover.connecting') });
    parts.head = h('div', { class: 'pop-head', title: t('content.popover.dragToMove') },
      h('span', { class: 'pop-icon', 'aria-hidden': 'true' }, p.kind === 'translate' ? svg('languages', 16) : actionIcon(p.action, 16)),
      h('div', { class: 'pop-titles' }, parts.title, parts.meta),
      iconButton('x', t('content.close'), () => closePopover()));
    const sourceText = collapseWs(p.text.slice(0, 400));
    parts.source = h('div', { class: 'pop-source', dir: 'auto', title: truncate(p.text, 800), text: sourceText });
    parts.instr = h('div', { class: 'pop-instr', dir: 'auto', hidden: true });

    parts.loading = h('div', { class: 'pop-loading' },
      h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('span', { text: t('content.popover.thinking') }));
    parts.result = h('div', { class: 'pop-result', dir: 'auto', 'aria-live': 'polite', hidden: true });
    parts.note = h('div', { class: 'pop-note', hidden: true });
    parts.errorText = h('div', { class: 'pop-error-text' });
    parts.errorActions = h('div', { class: 'pop-error-actions' });
    parts.error = h('div', { class: 'pop-error', role: 'alert', hidden: true },
      h('span', { class: 'pop-error-icon', 'aria-hidden': 'true' }, svg('alert', 16)),
      h('div', { class: 'pop-error-main' }, parts.errorText, parts.errorActions));
    parts.body = h('div', { class: 'pop-body' }, parts.loading, parts.result, parts.note, parts.error);

    parts.stopBtn = button(t('content.popover.stop'), 'stop', () => stopTurn(p), { cls: 'btn-outline', title: t('content.popover.stopTitle') });
    parts.streamRow = h('div', { class: 'pop-stream-row' }, parts.stopBtn, h('span', { class: 'pop-stream-hint', text: t('content.popover.generating') }));
    parts.copyBtn = button(t('content.popover.copy'), 'copy', () => copyResult(p), { cls: p.editable ? '' : 'btn-primary', title: t('content.popover.copyTitle') });
    parts.replaceBtn = p.editable
      ? button(t('content.popover.replace'), 'replace', () => replaceResult(p), { cls: 'btn-primary', title: t('content.popover.replaceTitle') })
      : null;
    parts.retryBtn = button(t('content.popover.retry'), 'refresh', () => rerun(p), { title: t('content.popover.retryTitle') });
    parts.chatBtn = button(t('content.popover.continueInChat'), 'chat', () => continueInChat(p), {
      title: t('content.popover.continueInChatTitle'), shortLabel: t('content.popover.continueInChatShort'),
    });
    parts.actions = h('div', { class: 'pop-actions' }, parts.replaceBtn, parts.copyBtn, parts.retryBtn, parts.chatBtn);
    // Firefox: the sidebar could not be opened programmatically – the chat waits there.
    parts.chatHint = h('div', { class: 'pop-hint', role: 'status', hidden: true }, svg('info', 14), h('span', { text: t('content.panelHint') }));
    parts.refineInput = h('input', {
      type: 'text', dir: 'auto', placeholder: t('content.popover.refinePlaceholder'), 'aria-label': t('content.popover.refineLabel'),
      autocomplete: 'off', spellcheck: 'true', maxlength: '500', enterkeyhint: 'send',
    });
    parts.refineInput.addEventListener('keydown', safe((e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        submitRefine(p);
      }
    }));
    parts.refine = h('div', { class: 'refine' }, parts.refineInput, iconButton('send', t('content.popover.refineSend'), () => submitRefine(p)));
    parts.foot = h('div', { class: 'pop-foot' }, parts.streamRow, parts.chatHint, parts.actions, parts.refine);

    p.el = h('div', { class: 'pop', role: 'dialog', 'aria-labelledby': titleId, tabindex: '-1' },
      parts.head, parts.source, parts.instr, parts.body, parts.foot);
    // Buttons do not take focus from the page (focus traps of page dialogs would pull it back).
    p.el.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest && e.target.closest('button')) e.preventDefault();
    });
    parts.head.addEventListener('pointerdown', safe((e) => startDrag(p, e)));
    parts.head.addEventListener('pointermove', safe((e) => moveDrag(p, e)));
    parts.head.addEventListener('pointerup', safe((e) => endDrag(p, e)));
    parts.head.addEventListener('pointercancel', safe((e) => endDrag(p, e)));
    parts.head.addEventListener('lostpointercapture', safe((e) => endDrag(p, e)));
    p.parts = parts;
  }

  function renderPopover(p) {
    const { parts } = p;
    const turn = currentTurn(p);
    const status = turn ? turn.status : 'loading';
    const hasText = Boolean(turn && turn.text);
    const busy = isBusy(turn);

    parts.instr.hidden = !(turn && turn.instruction);
    parts.instr.textContent = turn && turn.instruction ? t('content.popover.instruction', { instruction: truncate(turn.instruction, 120) }) : '';
    parts.loading.hidden = status !== 'loading';
    parts.result.hidden = !hasText;
    parts.result.classList.toggle('streaming', status === 'streaming');
    parts.result.setAttribute('aria-busy', String(busy));
    const reason = status === 'done' ? turn.finishReason : '';
    const refused = reason === 'refusal' || reason === 'content_filter';
    let note = '';
    if (status === 'stopped') note = hasText ? t('content.popover.stoppedPartial') : t('content.popover.stoppedEmpty');
    else if (reason === 'length') note = t('content.popover.truncated');
    else if (refused) note = t('content.popover.refused');
    parts.note.hidden = !note;
    parts.note.textContent = note;
    parts.error.hidden = status !== 'error';
    if (status === 'error') {
      parts.errorText.textContent = turn.error || t('content.error.unknown');
      const buttons = [button(t('content.tryAgain'), 'refresh', () => rerun(p), { cls: 'btn-outline' })];
      if (SETTINGS_CODES.has(turn.code)) buttons.push(button(t('content.openSettings'), 'sliders', openSettings, { cls: 'btn-outline' }));
      parts.errorActions.replaceChildren(...buttons);
    }
    parts.foot.hidden = status === 'error';
    parts.streamRow.hidden = !busy;
    parts.chatHint.hidden = !p.chatHint || busy || status === 'error';
    parts.actions.hidden = busy || status === 'error';
    parts.refine.hidden = busy || status === 'error' || !hasText;
    for (const b of [parts.copyBtn, parts.replaceBtn, parts.chatBtn]) if (b) b.disabled = !hasText;
    if (parts.replaceBtn && refused) parts.replaceBtn.disabled = true; // never paste a refusal into the page
    p.el.setAttribute('aria-busy', String(busy));
    // Keep keyboard focus inside the dialog when the focused control disappears.
    const active = shadow && shadow.activeElement;
    if (active && p.el.contains(active) && active !== p.el && !active.getClientRects().length) p.el.focus({ preventScroll: true });
  }

  function paintResult(p) {
    if (p.paintTimer) {
      clearTimeout(p.paintTimer);
      p.paintTimer = 0;
    }
    const turn = currentTurn(p);
    const body = p.parts.body;
    const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 28;
    p.parts.result.textContent = turn ? turn.text : '';
    if (stick) body.scrollTop = body.scrollHeight;
  }

  // Timer instead of rAF: keeps painting even when rAF is throttled (background tab, hidden frame).
  function schedulePaint(p) {
    if (p.paintTimer) return;
    p.paintTimer = setTimeout(safe(() => {
      p.paintTimer = 0;
      if (popover === p) paintResult(p);
    }), 32);
  }

  function finishPort(p) {
    const port = p.port;
    p.port = null;
    if (port) {
      try {
        port.disconnect();
      } catch {
        // already gone
      }
    }
  }

  function failTurn(p, turn, message, code = '') {
    finishPort(p);
    turn.status = 'error';
    turn.error = message || t('content.error.unknown');
    turn.code = code;
    if (!p.meta) p.parts.meta.textContent = '';
    paintResult(p);
    renderPopover(p);
  }

  function runTurn(p, turn) {
    finishPort(p);
    const runId = ++p.runId;
    turn.text = '';
    turn.status = 'loading';
    turn.error = '';
    turn.code = '';
    turn.finishReason = '';
    p.chatHint = false;
    paintResult(p);
    renderPopover(p);
    let port;
    try {
      if (!isAlive()) throw new Error(t('content.error.invalidated'));
      port = ext.runtime.connect({ name: 'llm-stream' });
    } catch (err) {
      failTurn(p, turn, mapRuntimeError(err), 'extension');
      return;
    }
    p.port = port;
    port.onMessage.addListener(safe((msg) => {
      if (popover !== p || runId !== p.runId || !msg || typeof msg !== 'object') return;
      if (msg.type === 'meta') {
        p.meta = [msg.provider, msg.model].filter((x) => typeof x === 'string' && x).join(' · ');
        p.parts.meta.textContent = p.meta;
        p.parts.meta.title = p.meta;
      } else if (msg.type === 'delta') {
        if (typeof msg.delta !== 'string' || !msg.delta) return;
        turn.text += msg.delta;
        if (turn.status !== 'streaming') {
          turn.status = 'streaming';
          renderPopover(p);
        }
        schedulePaint(p);
      } else if (msg.type === 'done') {
        if (typeof msg.text === 'string' && msg.text) turn.text = msg.text;
        turn.finishReason = typeof msg.finishReason === 'string' ? msg.finishReason : '';
        // Tokens and cost of this answer next to provider and model.
        const usage = describeUsage(addUsage(null, msg.usage));
        if (usage) {
          p.parts.meta.textContent = [p.meta, usage.text].filter(Boolean).join(' · ');
          p.parts.meta.title = [p.meta, usage.title].filter(Boolean).join('\n');
        }
        finishPort(p);
        turn.status = 'done';
        paintResult(p);
        renderPopover(p);
      } else if (msg.type === 'error') {
        failTurn(p, turn, typeof msg.error === 'string' && msg.error ? msg.error : t('content.error.unknown'), typeof msg.code === 'string' ? msg.code : '');
      }
    }));
    port.onDisconnect.addListener(safe(() => {
      const lastError = (port && port.error && port.error.message) || readLastError();
      if (popover !== p || runId !== p.runId || p.port !== port) return;
      p.port = null;
      if (isBusy(turn)) failTurn(p, turn, lastError ? mapRuntimeError(lastError) : t('content.error.disconnected'), 'disconnect');
    }));
    try {
      port.postMessage({ type: 'start', task: turn.task });
    } catch (err) {
      failTurn(p, turn, mapRuntimeError(err), 'extension');
    }
  }

  function stopTurn(p) {
    const turn = currentTurn(p);
    if (!turn || !isBusy(turn)) return;
    if (p.port) {
      try {
        p.port.postMessage({ type: 'abort' });
      } catch {
        // ignore
      }
    }
    finishPort(p);
    p.runId++; // ignore late messages
    turn.status = 'stopped';
    paintResult(p);
    renderPopover(p);
    const target = turn.text ? p.parts.copyBtn : p.parts.retryBtn;
    if (target && shadow && p.el.contains(shadow.activeElement)) target.focus();
  }

  function rerun(p) {
    const turn = currentTurn(p);
    if (!turn || isBusy(turn)) return;
    runTurn(p, turn);
  }

  function submitRefine(p) {
    const turn = currentTurn(p);
    const input = p.parts.refineInput;
    const instruction = input.value.trim();
    if (!instruction) {
      input.focus();
      return;
    }
    if (!turn || isBusy(turn) || !turn.text) return;
    const next = newTurn(refineTask(p, instruction, turn.text), instruction);
    p.turns.push(next);
    input.value = '';
    runTurn(p, next);
  }

  function closePopover({ restoreFocus = true } = {}) {
    const p = popover;
    if (!p) return;
    popover = null;
    if (p.port) {
      try {
        p.port.postMessage({ type: 'abort' });
      } catch {
        // ignore
      }
    }
    finishPort(p);
    if (p.paintTimer) clearTimeout(p.paintTimer);
    const hadFocus = Boolean(shadow && p.el.contains(shadow.activeElement));
    p.el.remove();
    if (hadFocus && restoreFocus && p.snap && p.snap.element && p.snap.element.isConnected) {
      try {
        p.snap.element.focus({ preventScroll: true });
      } catch {
        // ignore
      }
    }
  }

  function flashButton(btn, label) {
    if (!btn) return;
    const span = btn.querySelector('span');
    if (!span) return;
    const original = span.textContent;
    span.textContent = label;
    btn.classList.add('is-done');
    clearTimeout(btn.flashTimer);
    btn.flashTimer = setTimeout(() => {
      span.textContent = original;
      btn.classList.remove('is-done');
    }, 1600);
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // permission policy / focus – fall back
    }
    if (!shadow) return false;
    const previous = shadow.activeElement;
    const ta = document.createElement('textarea');
    // The 'copy' event is composed: page capture listeners see it first and could swap the data.
    // Our own listener sets the data last; if the page stops the event, report failure instead.
    let wrote = false;
    ta.addEventListener('copy', (e) => {
      try {
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
        wrote = true;
      } catch {
        wrote = false;
      }
    });
    try {
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      ta.style.opacity = '0';
      shadow.append(ta);
      ta.select();
      return document.execCommand('copy') && wrote;
    } catch {
      return false;
    } finally {
      ta.remove();
      if (previous && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    }
  }

  function copyResult(p) {
    const turn = currentTurn(p);
    if (!turn || !turn.text) return;
    copyToClipboard(turn.text).then((ok) => {
      if (ok) flashButton(p.parts.copyBtn, t('content.popover.copied'));
      else toast(t('content.toast.copyFailed'), { type: 'error' });
    }).catch(report);
  }

  function replaceResult(p) {
    const turn = currentTurn(p);
    if (!turn || !turn.text || !p.snap) return;
    try {
      const undoable = replaceSelectionWith(p.snap, turn.text);
      closePopover({ restoreFocus: false });
      const message = undoable
        ? t('content.toast.replacedUndo', { shortcut: IS_MAC ? '⌘Z' : t('content.shortcut.undo') })
        : t('content.toast.replaced');
      toast(message, { type: 'success' });
    } catch (err) {
      toast(errorText(err), { type: 'error' });
    }
  }

  // Replaces the snapshot's selection with `result`; returns true when the browser's undo stack has it.
  function replaceSelectionWith(snap, result) {
    const original = snap.text;
    const lead = original.slice(0, original.length - original.trimStart().length);
    const trail = original.slice(original.trimEnd().length);
    const text = `${lead}${String(result).trim()}${trail}`;
    if (snap.kind === 'input') return replaceInControl(snap, text);
    if (snap.kind === 'editable') return replaceInEditable(snap, text);
    throw new Error(t('content.error.cannotReplace'));
  }

  function replaceInControl(snap, rawText) {
    const el = snap.element;
    if (!el || !el.isConnected) throw new Error(t('content.error.fieldGone'));
    if (el.readOnly || el.disabled) throw new Error(t('content.error.fieldReadOnly'));
    const text = el.localName === 'input' ? rawText.replace(/\s*\r?\n\s*/g, ' ') : rawText;
    const value = String(el.value || '');
    const start = locateInValue(value, snap);
    if (start === -1) throw new Error(t('content.error.selectionChanged'));
    if (start === -2) throw new Error(t('content.error.selectionAmbiguous'));
    const end = start + snap.text.length;
    el.focus({ preventScroll: true });
    try {
      el.setSelectionRange(start, end);
    } catch {
      // ignore
    }
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text); // keeps undo history and framework state
    } catch {
      ok = false;
    }
    if (ok && el.value === value && text !== snap.text) ok = false;
    if (ok) return true;
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return false;
  }

  // Where the selected text is now: its old offsets, else the occurrence whose surroundings match
  // best (then the closest one). -1 = gone, -2 = several equally likely occurrences.
  function locateInValue(value, snap) {
    const { text, start } = snap;
    if (value.slice(start, start + text.length) === text) return start;
    const hits = [];
    for (let i = value.indexOf(text); i >= 0 && hits.length < 500; i = value.indexOf(text, i + 1)) hits.push(i);
    if (hits.length < 2) return hits.length ? hits[0] : -1;
    const before = snap.before || '';
    const after = snap.after || '';
    const score = (i) => {
      let s = 0;
      while (s < before.length && i - s - 1 >= 0 && value[i - s - 1] === before[before.length - s - 1]) s++;
      let a = 0;
      const tail = i + text.length;
      while (a < after.length && tail + a < value.length && value[tail + a] === after[a]) a++;
      return s + a;
    };
    const ranked = hits.map((i) => ({ i, s: score(i), d: Math.abs(i - start) })).sort((x, y) => y.s - x.s || x.d - y.d);
    return ranked[0].s === ranked[1].s ? -2 : ranked[0].i;
  }

  function replaceInEditable(snap, text) {
    const el = snap.element;
    const range = snap.range;
    if (!el || !el.isConnected || !range || !range.startContainer.isConnected || range.collapsed) {
      throw new Error(t('content.error.selectionGone'));
    }
    if (squash(range.toString()) !== squash(snap.text)) {
      throw new Error(t('content.error.selectionChanged'));
    }
    el.focus({ preventScroll: true });
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }
    if (ok) return true;
    range.deleteContents();
    const frag = document.createDocumentFragment();
    text.split('\n').forEach((line, i) => {
      if (i) frag.append(document.createElement('br'));
      if (line) frag.append(document.createTextNode(line));
    });
    const last = frag.lastChild;
    range.insertNode(frag);
    if (last) {
      range.setStartAfter(last);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: text }));
    return false;
  }

  function chatMessages(p) {
    const intro = p.kind === 'translate'
      ? t('content.chat.translateIntro', { language: languageLabel(p.lang), text: p.text })
      : t('content.chat.actionIntro', { name: actionName(p.action), text: p.text });
    const messages = [{ role: 'user', content: intro }];
    p.turns.forEach((turn, i) => {
      if (!turn.text || isBusy(turn)) return;
      if (i > 0) messages.push({ role: 'user', content: turn.instruction || t('content.chat.reviseDefault') });
      messages.push({ role: 'assistant', content: turn.text });
    });
    return messages;
  }

  // Must call runtime.sendMessage synchronously inside the click (Chrome side panel gesture).
  function continueInChat(p) {
    const turn = currentTurn(p);
    if (!turn || !turn.text || isBusy(turn)) return;
    const label = p.kind === 'translate' ? t('content.chat.translationTitle') : actionName(p.action);
    const payload = { kind: 'continue', title: truncate(`${label}: ${collapseWs(p.text)}`, 60), messages: chatMessages(p) };
    send({ type: 'openInChat', payload })
      .then((res) => {
        if (res.opened === false) {
          // The panel could not be opened (Firefox): keep the result and say where the chat waits.
          if (popover === p) {
            p.chatHint = true;
            renderPopover(p);
          } else toast(t('content.panelHint'), { timeout: 8000 });
          return;
        }
        if (popover === p) closePopover({ restoreFocus: false });
        toast(t('content.toast.openedInChat'), { type: 'success' });
      })
      .catch((err) => toast(errorText(err), { type: 'error' }));
  }

  // ----- dragging -----

  function startDrag(p, e) {
    if (e.button !== 0 || (e.target && e.target.closest && e.target.closest('button, input, select'))) return;
    const z = uiZoom();
    const r = uiRect(p.el, z);
    p.drag = { dx: e.clientX / z - r.left, dy: e.clientY / z - r.top, id: e.pointerId };
    p.el.style.top = `${Math.round(r.top)}px`;
    p.el.style.bottom = 'auto';
    p.el.classList.add('dragging');
    try {
      p.parts.head.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    e.preventDefault();
  }

  function moveDrag(p, e) {
    if (!p.drag || e.pointerId !== p.drag.id) return;
    const { w: vw, h: vh, z } = uiViewport();
    const width = p.el.offsetWidth;
    const left = clamp(e.clientX / z - p.drag.dx, 8, vw - width - 8);
    const top = clamp(e.clientY / z - p.drag.dy, 8, Math.max(8, vh - 140));
    p.el.style.left = `${Math.round(left)}px`;
    p.el.style.top = `${Math.round(top)}px`;
    p.el.style.maxHeight = `${Math.round(Math.max(140, Math.min(heightCap(vh), vh - top - 8)))}px`;
  }

  function endDrag(p, e) {
    if (!p.drag || (e && e.pointerId !== p.drag.id)) return;
    p.drag = null;
    p.el.classList.remove('dragging');
    uiPointerDown = false;
    lastUiPointerAt = now();
    try {
      if (e) p.parts.head.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }

  // ---------------------------------------------------------------------------
  // Requests from the background (context menu, side panel, shortcuts)
  // ---------------------------------------------------------------------------

  // The background shows no notice for errors the content script reports, so they appear here.
  function failVisibly(error) {
    toast(error, { type: 'error' });
    return { ok: false, error };
  }

  async function runFromBackground({ actionId, text, lang }) {
    const id = typeof actionId === 'string' ? actionId.trim() : '';
    if (frameTooSmall()) return { ok: false, code: 'tiny_frame', error: t('content.error.tinyFrame') }; // background retries in the top frame
    const given = typeof text === 'string' ? text : '';
    const snap = pickSnapshot(given);
    // Before any message: the strings (UI language) come with the config.
    const cfg = await configOrDefault(0); // explicit command: settings may have just changed
    if (!id) return failVisibly(t('content.error.unknownAction'));
    const finalText = given.trim() ? (snap ? snap.text : given) : snap ? snap.text : '';
    if (!isValidSelectionText(finalText)) {
      toast(t('content.toast.noText'));
      return { ok: false, error: t('content.error.noSelection') };
    }
    const action = findAction(cfg, id);
    if (!action) return failVisibly(t('content.error.actionGone'));
    const anchor = snap ? snapRect(snap) : null;
    await launch({ action, text: finalText, snap, anchor, focus: false, lang: typeof lang === 'string' ? lang.trim() : '' });
    return { ok: true };
  }

  function onRuntimeMessage(message, sender, sendResponse) {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return false;
    if (destroyed || !isAlive()) return false;
    const respond = (value) => {
      try {
        sendResponse(value);
      } catch {
        // sender gone
      }
    };
    const handle = (fn) => {
      Promise.resolve()
        .then(fn)
        .then((res) => respond(res || { ok: true }), (err) => respond({ ok: false, error: errorText(err) }));
      return true;
    };
    switch (message.type) {
      case 'ping':
        respond({ ok: true });
        return true;
      case 'getSelection': {
        let selected = '';
        try {
          const snap = takeSnapshot();
          selected = snap && isValidSelectionText(snap.text) ? snap.text : '';
        } catch {
          selected = '';
        }
        const max = Number.isInteger(message.maxChars) && message.maxChars > 0 ? message.maxChars : 0;
        const truncated = max > 0 && selected.length > max;
        respond({ ok: true, text: truncated ? selected.slice(0, max) : selected, truncated, ...pageInfo() });
        return true;
      }
      case 'runAction':
        return handle(() => runFromBackground({ actionId: message.actionId, text: message.text }));
      case 'translateSelection':
        return handle(() => runFromBackground({ actionId: 'translate', text: message.text, lang: message.lang }));
      case 'translatePage':
        if (!IS_TOP) return false; // page translation is top-frame only
        return handle(() => startPageTranslation(message.lang));
      case 'restorePage':
        if (!IS_TOP) return false;
        return handle(() => {
          ptRestore();
          return { ok: true };
        });
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Page translation
  // ---------------------------------------------------------------------------
  // Text nodes and placeholder/title/alt attributes (shadow roots included) are scanned in short
  // time slices and split into pieces – one per line where the page renders line breaks. Only
  // pieces near the viewport are sent; the rest waits for an IntersectionObserver. A
  // MutationObserver translates new content; a budget per user confirmation stops endless paid
  // requests on live pages, and nodes the page keeps rewriting are left to the page.

  const PT_SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'code', 'pre', 'kbd', 'samp', 'textarea', 'input', 'select', 'option',
    'optgroup', 'datalist', 'svg', 'math', 'iframe', 'frame', 'frameset', 'object', 'embed', 'canvas', 'video', 'audio',
    'head', 'title', 'meta', 'link', 'llm-sidebar-ui',
  ]);
  const PT_ATTRS = ['placeholder', 'title', 'alt'];
  const PT_OBSERVED_ATTRS = ['class', 'style', 'hidden', 'open', ...PT_ATTRS];
  const PT_OBSERVE = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: PT_OBSERVED_ATTRS };
  const PT_MAX_CHANGES = 4; // page rewrites of one node/element before we leave it to the page
  const PT_BUDGET_REQUESTS = 50; // per user confirmation ("Weiter übersetzen")
  const PT_BUDGET_CHARS = 120000;
  const PT_SCAN_SLICE = 12; // ms of scanning per task
  const PT_MAX_HIDDEN = 4000;
  const PT_COLLAPSE_AFTER = 6000; // the finished pill shrinks to a badge
  const PT_BLOCKS = 'p, li, dt, dd, td, th, h1, h2, h3, h4, h5, h6, blockquote, figcaption, caption, summary, label, button, pre, div, section, article, aside, header, footer, nav, main, form';

  function ptHardSkip(el) {
    if (el === host) return true;
    const tr = el.getAttribute('translate');
    if (tr && tr.trim().toLowerCase() === 'no') return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    if (el.hasAttribute('hidden')) return true;
    const ce = el.getAttribute('contenteditable');
    return ce !== null && ce.trim().toLowerCase() !== 'false';
  }

  // text/plain documents render as <body><pre> – that <pre> is the text to translate.
  const ptSkipTag = (state, el) => PT_SKIP_TAGS.has(el.localName) && !(state.plainText && el.localName === 'pre');

  // Parent element, crossing from a shadow root to its host.
  function ptParent(node) {
    const p = node.parentNode;
    if (!p) return null;
    if (p.nodeType === 11) return p.host || null;
    return p.nodeType === 1 ? p : null;
  }

  // True when an ancestor excludes `node` or it is not inside <body>.
  function ptInsideSkipped(state, node) {
    const body = document.body;
    if (!body || !node.isConnected) return true;
    for (let el = ptParent(node); el; el = ptParent(el)) {
      if (el === body) return false;
      if (ptHardSkip(el) || ptSkipTag(state, el)) return true;
    }
    return true;
  }

  function ptPriority(r, vh) {
    if (r.bottom < 0) return vh + -r.bottom * 1.5; // above the viewport
    if (r.top > vh) return r.top; // below
    return Math.max(0, r.top) - vh; // visible first, top to bottom
  }

  // Within one viewport above/below (half a width beside): translated right away. Matches the
  // IntersectionObserver's rootMargin '100% 50%' for everything else.
  const ptNear = (r, vw, vh) => r.bottom > -vh && r.top < vh * 2 && r.right > -vw / 2 && r.left < vw * 1.5;

  function ptPiece(value) {
    const core = value.trim();
    if (core.length < 2 || !hasTwoLetters(core)) return null;
    if (/^(https?:\/\/|www\.)\S+$/i.test(core) || /^\S+@\S+\.\S+$/.test(core)) return null;
    return {
      key: core.replace(/\s+/g, ' '),
      lead: value.slice(0, value.length - value.trimStart().length),
      trail: value.slice(value.trimEnd().length),
    };
  }

  // A job is one text node or attribute value: { orig, pieces: (string | piece)[], node | el+attr }.
  // `lines` translates line by line so rendered line breaks (pre-wrap & co.) survive.
  function ptJob(value, lines) {
    const pieces = [];
    let count = 0;
    (lines ? value.split('\n') : [value]).forEach((part, i) => {
      if (i) pieces.push('\n');
      const piece = ptPiece(part);
      if (piece) {
        pieces.push(piece);
        count++;
      } else if (part) pieces.push(part);
    });
    return count ? { orig: value, pieces } : null;
  }

  const ptJobValue = (job) => job.pieces.map((p) => (typeof p === 'string' ? p : `${p.lead}${p.tr}${p.trail}`)).join('');

  // Only the latest scan of a node/attribute may write it (older pending results are stale).
  function ptCurrent(state, job) {
    if (job.node) return state.seen.get(job.node) === job;
    const seen = state.attrSeen.get(job.el);
    return Boolean(seen && seen.get(job.attr) === job);
  }

  const ptJobAlive = (state, job) => ptCurrent(state, job) && (job.node || job.el).isConnected;

  function ptAttrNames(el) {
    const names = [];
    const tag = el.localName;
    if (el.hasAttribute('title')) names.push('title');
    if ((tag === 'input' || tag === 'textarea') && el.hasAttribute('placeholder')) names.push('placeholder');
    if ((tag === 'img' || tag === 'area' || (tag === 'input' && String(el.type).toLowerCase() === 'image')) && el.hasAttribute('alt')) names.push('alt');
    return names;
  }

  function ptShadowRoot(el) {
    let root = null;
    try {
      root = el.shadowRoot;
      if (!root && el.localName.includes('-')) { // closed roots: only custom elements are checked (cheap)
        if (ext.dom && typeof ext.dom.openOrClosedShadowRoot === 'function') root = ext.dom.openOrClosedShadowRoot(el);
        else if ('openOrClosedShadowRoot' in el) root = el.openOrClosedShadowRoot;
      }
    } catch {
      root = null;
    }
    return root && root.nodeType === 11 ? root : null;
  }

  function createPtState(lang, cfg) {
    return {
      lang,
      concurrency: cfg.translate.concurrency || DEFAULT_CONCURRENCY,
      batchChars: cfg.translate.batchChars || DEFAULT_BATCH_CHARS,
      plainText: document.contentType === 'text/plain',
      showing: 'translation',
      entries: new Map(), // text node → { orig, trans }
      attrEntries: new Map(), // element → Map(attr → { orig, trans })
      seen: new WeakMap(), // text node → its current job
      attrSeen: new WeakMap(), // element → Map(attr → job)
      fights: new WeakMap(), // node/element → page rewrites after we touched it
      givenUp: new WeakSet(), // left to the page – it keeps rewriting them
      cache: new Map(), // source text → translation
      pending: new Map(), // source text → unit (waiting, queued or in flight)
      queue: [], // units ready to send (near the viewport)
      failed: [],
      watch: new Map(), // element → Set(unit) waiting to come near the viewport
      io: null,
      inFlight: 0,
      flightUnits: 0,
      jobTotal: 0,
      jobDone: 0,
      appliedCount: 0,
      usage: null, // tokens and costs of all translation requests on this page
      lastError: '',
      initialDone: false,
      notReady: false,
      needsSettings: false,
      needsSort: false,
      paused: false,
      budget: { requests: 0, chars: 0 },
      collapsed: false,
      autoCollapsed: false,
      collapseTimer: 0,
      observer: null,
      observedBody: null,
      shadowRoots: new Set(),
      scanRoots: [],
      walker: null,
      scanCtx: null,
      scanOut: [],
      scanTimer: 0,
      hiddenEls: new Set(), // parents of unrendered text, re-checked when CSS may reveal them
      revealTimer: 0,
      dirty: new Set(),
      dirtySince: 0,
      flushTimer: 0,
      sortTimer: 0,
    };
  }

  async function startPageTranslation(langArg) {
    const cfg = await configOrDefault(0); // explicit command: never act on a stale cached config
    const lang = (typeof langArg === 'string' && langArg.trim()) || cfg.translate.targetLang;
    if (pt) {
      const state = pt;
      if (state.lang === lang && !state.notReady) {
        // Asked again: show the translation, retry failed parts, continue after a pause.
        if (state.showing === 'original') ptShowTranslation(state);
        state.collapsed = false;
        if (state.failed.length) ptRetryFailed(state);
        else if (state.paused) ptResume(state);
        else renderPill();
        return { ok: true };
      }
      ptRestore();
    }
    if (!document.body) return failVisibly(t('content.error.noTranslatableText'));
    const state = createPtState(lang, cfg);
    pt = state;
    if (!cfg.ready) {
      state.notReady = true;
      state.initialDone = true;
      renderPill();
      return { ok: false, error: t('content.notReadyShort') };
    }
    if (state.plainText) ptSplitPlainText();
    ptConnectObserver(state);
    ptQueueScan(state, [document.body]);
    renderPill();
    return { ok: true };
  }

  // A text/plain document is one huge text node: split it into paragraphs (no page scripts there)
  // so each is translated on its own – and only when scrolled near.
  function ptSplitPlainText() {
    try {
      for (const pre of document.body.querySelectorAll(':scope > pre')) {
        for (const node of Array.from(pre.childNodes)) {
          if (node.nodeType !== 3 || node.nodeValue.length < 400) continue;
          const text = node.nodeValue;
          const cuts = [];
          const re = /\n[ \t]*\n\s*/g;
          let m = re.exec(text);
          while (m && cuts.length < 20000) {
            if (m.index + m[0].length < text.length) cuts.push(m.index + m[0].length);
            m = re.exec(text);
          }
          for (let i = cuts.length - 1; i >= 0; i--) node.splitText(cuts[i]);
        }
      }
    } catch (err) {
      report(err);
    }
  }

  // ----- scanning (time-sliced) -----

  function ptQueueScan(state, roots) {
    if (pt !== state) return;
    for (const root of roots) if (root) state.scanRoots.push(root);
    if (!state.scanTimer) state.scanTimer = setTimeout(safe(() => ptRunScan(state)), 0);
  }

  const ptScanBusy = (state) => Boolean(state.walker || state.scanRoots.length || state.scanTimer);

  function ptRunScan(state) {
    state.scanTimer = 0;
    if (pt !== state) return;
    const { w, h } = viewportSize();
    state.scanCtx = { vw: w, vh: h, range: document.createRange(), rects: new Map(), breaks: new Map() };
    state.scanOut = [];
    const deadline = now() + PT_SCAN_SLICE;
    let steps = 0;
    try {
      for (;;) {
        if ((++steps & 63) === 0 && now() >= deadline) break;
        if (!state.walker) {
          if (!state.scanRoots.length) break;
          state.walker = ptBeginScan(state, state.scanRoots.shift());
          continue;
        }
        const node = state.walker.nextNode();
        if (!node) state.walker = null;
        else if (node.nodeType === 3) ptAddText(state, node);
      }
    } catch (err) {
      report(err);
      state.walker = null; // skip the rest of this root
    }
    const out = state.scanOut;
    state.scanOut = [];
    ptEnqueue(state, out);
    if (state.walker || state.scanRoots.length) state.scanTimer = setTimeout(safe(() => ptRunScan(state)), 0);
    ptCheckIdle(state);
    renderPill();
  }

  function ptBeginScan(state, root) {
    if (!root || !root.isConnected) return null;
    if (root.nodeType === 3) {
      if (!ptInsideSkipped(state, root)) ptAddText(state, root);
      return null;
    }
    if (root.nodeType === 11) {
      const owner = root.host;
      if (!owner || ptHardSkip(owner) || ptSkipTag(state, owner) || ptInsideSkipped(state, owner)) return null;
    } else if (root.nodeType === 1) {
      if (root !== document.body) {
        if (ptHardSkip(root) || ptInsideSkipped(state, root)) return null;
        if (ptSkipTag(state, root)) {
          if (root.localName === 'input' || root.localName === 'textarea') ptAddAttrs(state, root);
          return null;
        }
        ptAddAttrs(state, root);
      }
      ptAddShadow(state, root);
    } else return null;
    return document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: (node) => ptAccept(state, node) });
  }

  function ptAccept(state, node) {
    if (node.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
    if (ptHardSkip(node)) return NodeFilter.FILTER_REJECT;
    if (ptSkipTag(state, node)) {
      if (node.localName === 'input' || node.localName === 'textarea') ptAddAttrs(state, node);
      return NodeFilter.FILTER_REJECT;
    }
    ptAddAttrs(state, node);
    ptAddShadow(state, node);
    return NodeFilter.FILTER_SKIP;
  }

  // Shadow roots are scanned as roots of their own and observed like <body>.
  function ptAddShadow(state, el) {
    const root = ptShadowRoot(el);
    if (!root) return;
    state.scanRoots.push(root);
    if (!state.shadowRoots.has(root)) {
      state.shadowRoots.add(root);
      if (state.observer && state.showing === 'translation') state.observer.observe(root, PT_OBSERVE);
    }
  }

  function ptAddText(state, node) {
    if (state.seen.has(node) || state.givenUp.has(node)) return;
    const value = node.nodeValue;
    if (!value || value.length < 2 || !hasTwoLetters(value)) return;
    const ctx = state.scanCtx;
    ctx.range.selectNodeContents(node);
    const r = ctx.range.getBoundingClientRect();
    if (!r.width && !r.height) { // not rendered
      ptRememberHidden(state, node.parentElement);
      return;
    }
    const lines = !state.plainText && value.trim().includes('\n') && ptKeepsBreaks(state, node.parentElement);
    const job = ptJob(value, lines);
    if (!job) return;
    job.node = node;
    state.seen.set(node, job);
    ptCollect(state, job, ptPriority(r, ctx.vh), ptNear(r, ctx.vw, ctx.vh));
  }

  function ptAddAttrs(state, el) {
    const names = ptAttrNames(el);
    if (!names.length || state.givenUp.has(el)) return;
    let seen = state.attrSeen.get(el);
    for (const name of names) {
      if (seen && seen.has(name)) continue;
      const value = el.getAttribute(name);
      if (!value || !hasTwoLetters(value)) continue;
      const r = ptElementRect(state, el);
      if (!r) return; // not rendered
      const job = ptJob(value, false);
      if (!job) continue;
      job.el = el;
      job.attr = name;
      if (!seen) {
        seen = new Map();
        state.attrSeen.set(el, seen);
      }
      seen.set(name, job);
      const { vw, vh } = state.scanCtx;
      ptCollect(state, job, ptPriority(r, vh) + 50, ptNear(r, vw, vh)); // attributes after the surrounding text
    }
  }

  function ptCollect(state, job, prio, near) {
    for (const piece of job.pieces) {
      if (typeof piece === 'string') continue;
      piece.job = job;
      piece.prio = prio;
      piece.near = near;
      state.scanOut.push(piece);
    }
  }

  function ptElementRect(state, el) {
    const cache = state.scanCtx.rects;
    if (cache.has(el)) return cache.get(el);
    const r = el.getBoundingClientRect();
    const value = r.width || r.height ? r : null;
    cache.set(el, value);
    return value;
  }

  function ptKeepsBreaks(state, el) {
    if (!el) return false;
    const cache = state.scanCtx.breaks;
    if (cache.has(el)) return cache.get(el);
    let keep = false;
    try {
      const cs = getComputedStyle(el);
      const collapse = cs.whiteSpaceCollapse;
      keep = collapse
        ? collapse === 'preserve' || collapse === 'preserve-breaks' || collapse === 'break-spaces'
        : /^(pre|pre-wrap|pre-line|break-spaces)$/.test(cs.whiteSpace);
    } catch {
      keep = false;
    }
    cache.set(el, keep);
    return keep;
  }

  // CSS can reveal content without any DOM mutation (:hover menus, media queries, :target).
  function ptRememberHidden(state, el) {
    if (!el || state.hiddenEls.size >= PT_MAX_HIDDEN || state.hiddenEls.has(el)) return;
    if (!el.getClientRects().length) state.hiddenEls.add(el);
  }

  function ptCheckRevealed() {
    const state = pt;
    if (!state || !state.hiddenEls.size || state.revealTimer || state.showing !== 'translation') return;
    state.revealTimer = setTimeout(safe(() => {
      state.revealTimer = 0;
      if (pt !== state) return;
      for (const el of state.hiddenEls) {
        if (!el.isConnected) state.hiddenEls.delete(el);
        else if (el.getClientRects().length) {
          state.hiddenEls.delete(el);
          ptMarkDirty(state, el);
        }
      }
    }), 350);
  }

  // ----- queue -----

  function ptEnqueue(state, pieces) {
    if (pt !== state || !pieces.length) return;
    for (const t of pieces) {
      const cached = state.cache.get(t.key);
      if (cached !== undefined) {
        ptApply(state, t, cached);
        continue;
      }
      let unit = state.pending.get(t.key);
      if (!unit) {
        unit = { key: t.key, targets: [], prio: t.prio, near: false, error: '' };
        state.pending.set(t.key, unit);
      } else if (t.prio < unit.prio) {
        unit.prio = t.prio;
        state.needsSort = true;
      }
      unit.targets.push(t);
      if (t.near) ptPromote(state, unit);
      else if (!unit.near) ptWatch(state, unit, t);
    }
    ptPump(state);
  }

  function ptPromote(state, unit) {
    if (unit.near) return;
    unit.near = true;
    if (!state.inFlight && !state.queue.length) {
      state.jobTotal = 0;
      state.jobDone = 0;
    }
    state.queue.push(unit);
    state.jobTotal++;
    state.needsSort = true;
  }

  // The element whose visibility decides when a waiting piece is translated: its block, unless
  // that block is taller than the viewport.
  function ptAnchorEl(state, job) {
    let base = job.el || job.node.parentElement;
    if (!base && job.node.parentNode && job.node.parentNode.host) base = job.node.parentNode.host;
    if (!base) return null;
    const block = base.closest(PT_BLOCKS);
    if (block && block !== base) {
      const r = ptElementRect(state, block);
      if (r && r.height <= state.scanCtx.vh) return block;
    }
    return base.getClientRects().length ? base : null;
  }

  function ptWatch(state, unit, t) {
    const el = ptAnchorEl(state, t.job);
    if (!el || typeof IntersectionObserver !== 'function') {
      ptPromote(state, unit);
      return;
    }
    if (!state.io) state.io = new IntersectionObserver(safe((entries) => ptOnIntersect(state, entries)), { rootMargin: '100% 50%' });
    let units = state.watch.get(el);
    if (!units) {
      units = new Set();
      state.watch.set(el, units);
      state.io.observe(el);
    }
    units.add(unit);
  }

  function ptOnIntersect(state, entries) {
    if (pt !== state || state.showing !== 'translation') return; // re-observed when shown again
    const vh = viewportSize().h;
    let promoted = false;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      const units = state.watch.get(el);
      state.watch.delete(el);
      state.io.unobserve(el);
      if (!units) continue;
      for (const unit of units) {
        if (unit.near || state.pending.get(unit.key) !== unit) continue;
        unit.prio = ptPriority(entry.boundingClientRect, vh);
        ptPromote(state, unit);
        promoted = true;
      }
    }
    if (promoted) {
      ptPump(state);
      renderPill();
    }
  }

  function ptTakeBatch(state) {
    if (state.needsSort) {
      state.queue.sort((a, b) => a.prio - b.prio);
      state.needsSort = false;
    }
    const batch = [];
    let chars = 0;
    while (state.queue.length && batch.length < MAX_BATCH_SEGMENTS) {
      const unit = state.queue[0];
      if (!unit.targets.some((t) => ptJobAlive(state, t.job))) { // changed or removed by the page meanwhile
        state.queue.shift();
        if (state.pending.get(unit.key) === unit) state.pending.delete(unit.key);
        state.jobDone++;
        continue;
      }
      if (batch.length && chars + unit.key.length > state.batchChars) break;
      state.queue.shift();
      batch.push(unit);
      chars += unit.key.length;
    }
    return batch;
  }

  function ptPump(state) {
    while (pt === state && state.inFlight < state.concurrency && state.queue.length) {
      if (state.budget.requests >= PT_BUDGET_REQUESTS || state.budget.chars >= PT_BUDGET_CHARS) {
        state.paused = true; // "Weiter übersetzen" in the pill resets the budget
        break;
      }
      const batch = ptTakeBatch(state);
      if (!batch.length) break;
      state.budget.requests++;
      for (const unit of batch) state.budget.chars += unit.key.length;
      state.inFlight++;
      state.flightUnits += batch.length;
      ptRunBatch(state, batch)
        .catch(report)
        .finally(() => {
          state.inFlight--;
          state.flightUnits -= batch.length;
          if (pt !== state) return;
          ptPump(state);
          ptCheckIdle(state);
          renderPill();
        });
    }
  }

  function ptCheckIdle(state) {
    if (!state.inFlight && !state.queue.length && !ptScanBusy(state)) state.initialDone = true;
  }

  async function ptRunBatch(state, batch) {
    let translations = null;
    let error = '';
    try {
      const res = await send({ type: 'translateSegments', segments: batch.map((u) => u.key), lang: state.lang });
      translations = Array.isArray(res.translations) ? res.translations : [];
      if (pt === state) state.usage = addUsage(state.usage, res.usage);
    } catch (err) {
      error = mapRuntimeError(err);
      if (err && SETTINGS_CODES.has(err.code)) state.needsSettings = true;
    }
    if (pt !== state) return;
    batch.forEach((unit, i) => {
      if (state.pending.get(unit.key) === unit) state.pending.delete(unit.key);
      state.jobDone++;
      const tr = translations && typeof translations[i] === 'string' ? translations[i].trim() : '';
      if (tr) {
        state.cache.set(unit.key, tr);
        for (const piece of unit.targets) ptApply(state, piece, tr);
      } else {
        unit.error = error || t('content.page.sectionMissing');
        state.failed.push(unit);
      }
    });
    if (error) state.lastError = error;
  }

  function ptApply(state, piece, translation) {
    const job = piece.job;
    if (!ptCurrent(state, job)) return; // superseded by a newer scan of the same node
    piece.tr = translation;
    if (job.pieces.some((p) => typeof p !== 'string' && p.tr === undefined)) return; // other lines pending
    const value = ptJobValue(job);
    if (job.node) {
      const node = job.node;
      if (!node.isConnected) {
        state.seen.delete(node);
        return;
      }
      if (node.nodeValue !== job.orig) { // changed while we did not observe it – rescan
        state.seen.delete(node);
        ptMarkDirty(state, node);
        return;
      }
      state.entries.set(node, { orig: job.orig, trans: value });
      state.appliedCount++;
      if (state.showing === 'translation' && value !== job.orig) node.nodeValue = value;
    } else {
      const el = job.el;
      if (!el.isConnected || el.getAttribute(job.attr) !== job.orig) {
        state.attrSeen.get(el).delete(job.attr);
        return;
      }
      let map = state.attrEntries.get(el);
      if (!map) {
        map = new Map();
        state.attrEntries.set(el, map);
      }
      map.set(job.attr, { orig: job.orig, trans: value });
      state.appliedCount++;
      if (state.showing === 'translation' && value !== job.orig) el.setAttribute(job.attr, value);
    }
  }

  // ----- observing the page -----

  function ptConnectObserver(state) {
    const body = document.body;
    if (!body) return;
    if (!state.observer) state.observer = new MutationObserver(safe((records) => ptOnMutations(state, records)));
    else state.observer.disconnect();
    state.observer.observe(body, PT_OBSERVE);
    const root = document.documentElement;
    if (root && root !== body) state.observer.observe(root, { childList: true }); // <body> swaps (Turbo, pjax)
    for (const shadowRoot of state.shadowRoots) {
      if (shadowRoot.host && shadowRoot.host.isConnected) state.observer.observe(shadowRoot, PT_OBSERVE);
      else state.shadowRoots.delete(shadowRoot);
    }
    state.observedBody = body;
  }

  function ptDisconnectObserver(state) {
    if (!state.observer) return;
    try {
      state.observer.takeRecords();
      state.observer.disconnect();
    } catch {
      // ignore
    }
  }

  // Counts a page rewrite of something we touched; true once we leave it to the page.
  function ptFight(state, key) {
    const n = (state.fights.get(key) || 0) + 1;
    state.fights.set(key, n);
    if (n <= PT_MAX_CHANGES) return false;
    state.givenUp.add(key);
    return true;
  }

  function ptOnMutations(state, records) {
    if (pt !== state || state.showing !== 'translation') return;
    for (const r of records) {
      const target = r.target;
      if (r.type === 'characterData') {
        if (state.givenUp.has(target)) continue;
        const entry = state.entries.get(target);
        const value = target.nodeValue;
        if (entry && value === entry.trans) continue; // our own replacement
        if (entry || state.seen.has(target)) {
          if (ptFight(state, target)) { // tickers, counters, re-rendering frameworks
            state.entries.delete(target);
            continue;
          }
          if (entry && value === entry.orig) {
            target.nodeValue = entry.trans; // the page re-rendered the original text – re-apply
            continue;
          }
          state.entries.delete(target);
          state.seen.delete(target); // pending results for the old text become stale
        }
        ptMarkDirty(state, target);
      } else if (r.type === 'childList') {
        if (target === document.documentElement) {
          if (document.body && document.body !== state.observedBody) ptMarkDirty(state, document.body);
          continue;
        }
        for (const n of r.addedNodes) {
          if (n !== host && (n.nodeType === 1 || n.nodeType === 3)) ptMarkDirty(state, n);
        }
      } else if (r.type === 'attributes') {
        if (target === host) continue;
        const name = r.attributeName;
        if (PT_ATTRS.includes(name)) {
          if (state.givenUp.has(target)) continue;
          const map = state.attrEntries.get(target);
          const entry = map && map.get(name);
          const value = target.getAttribute(name);
          if (entry && value === entry.trans) continue; // our own replacement
          const seen = state.attrSeen.get(target);
          if (entry || (seen && seen.has(name))) {
            if (ptFight(state, target)) {
              if (map) map.delete(name);
              continue;
            }
            if (entry && value === entry.orig) {
              target.setAttribute(name, entry.trans);
              continue;
            }
            if (map) map.delete(name);
            if (seen) seen.delete(name);
          }
        }
        ptMarkDirty(state, target); // visibility may have changed (class/style/hidden/open)
      }
    }
  }

  function ptMarkDirty(state, node) {
    if (!node || pt !== state) return;
    if (state.dirty.size < 300) state.dirty.add(node); // beyond that ptFlush rescans all of <body>
    ptScheduleFlush(state);
  }

  function ptScheduleFlush(state) {
    if (!state.dirty.size || document.hidden) return; // a hidden tab is handled when shown again
    const t = now();
    if (!state.dirtySince) state.dirtySince = t;
    clearTimeout(state.flushTimer);
    const wait = clamp(Math.min(MUTATION_DEBOUNCE, state.dirtySince + MUTATION_MAX_WAIT - t), 0, MUTATION_DEBOUNCE);
    state.flushTimer = setTimeout(safe(() => ptFlush(state)), wait);
  }

  function ptFlush(state) {
    state.flushTimer = 0;
    if (pt !== state || document.hidden) return;
    state.dirtySince = 0;
    const nodes = Array.from(state.dirty);
    state.dirty.clear();
    const body = document.body;
    if (state.showing !== 'translation' || !body) return;
    let roots;
    if (state.observedBody !== body) { // <body> was replaced: watch and scan the new one
      ptConnectObserver(state);
      ptPrune(state, true);
      roots = [body];
    } else if (nodes.length >= 300 || nodes.includes(body)) roots = [body];
    else {
      const live = nodes.filter((n) => n.isConnected);
      roots = live.filter((n) => !live.some((o) => o !== n && o.nodeType === 1 && o.contains(n)));
    }
    ptPrune(state, false);
    ptQueueScan(state, roots);
  }

  function ptPrune(state, force) {
    if (force || state.entries.size >= 400) {
      for (const node of state.entries.keys()) if (!node.isConnected) state.entries.delete(node);
      for (const el of state.attrEntries.keys()) if (!el.isConnected) state.attrEntries.delete(el);
    }
    if (force || state.watch.size >= 2000) {
      for (const el of state.watch.keys()) {
        if (el.isConnected) continue;
        state.watch.delete(el);
        if (state.io) state.io.unobserve(el);
      }
    }
    if (force || state.pending.size >= 1000) { // waiting units whose text the page removed or changed
      for (const [key, unit] of state.pending) {
        if (unit.near) continue;
        unit.targets = unit.targets.filter((t) => ptJobAlive(state, t.job));
        if (!unit.targets.length) state.pending.delete(key);
      }
    }
  }

  function ptReprioritize() {
    const state = pt;
    if (!state || !state.queue.length) return;
    clearTimeout(state.sortTimer);
    state.sortTimer = setTimeout(safe(() => {
      if (pt !== state || !state.queue.length || state.queue.length > 4000) return;
      const vh = viewportSize().h;
      const range = document.createRange();
      for (const unit of state.queue) {
        const job = unit.targets[0] && unit.targets[0].job;
        let r = null;
        if (job && job.node && job.node.isConnected) {
          range.selectNodeContents(job.node);
          r = range.getBoundingClientRect();
        } else if (job && job.el && job.el.isConnected) {
          r = job.el.getBoundingClientRect();
        }
        unit.prio = r && (r.width || r.height) ? ptPriority(r, vh) : Number.MAX_SAFE_INTEGER;
      }
      state.needsSort = true;
    }), 200);
  }

  // ----- original ⇄ translation, retry, restore -----

  function ptShowOriginal(state) {
    if (state.showing === 'original') return;
    ptDisconnectObserver(state);
    clearTimeout(state.flushTimer);
    state.dirty.clear();
    state.dirtySince = 0;
    state.showing = 'original';
    for (const [node, e] of state.entries) {
      if (node.nodeValue === e.trans) node.nodeValue = e.orig;
      else if (node.nodeValue !== e.orig) {
        state.entries.delete(node);
        state.seen.delete(node);
      }
    }
    for (const [el, map] of state.attrEntries) {
      for (const [name, e] of map) if (el.getAttribute(name) === e.trans) el.setAttribute(name, e.orig);
    }
    renderPill();
  }

  function ptShowTranslation(state) {
    if (state.showing === 'translation') return;
    state.showing = 'translation';
    for (const [node, e] of state.entries) if (node.nodeValue === e.orig) node.nodeValue = e.trans;
    for (const [el, map] of state.attrEntries) {
      for (const [name, e] of map) if (el.getAttribute(name) === e.orig) el.setAttribute(name, e.trans);
    }
    ptConnectObserver(state);
    if (state.io) { // fresh callbacks for everything that came near while the original was shown
      state.io.disconnect();
      for (const el of state.watch.keys()) state.io.observe(el);
    }
    if (document.body) ptMarkDirty(state, document.body); // content added while the original was shown
    renderPill();
  }

  function ptRetryFailed(state) {
    const units = state.failed.splice(0);
    state.lastError = '';
    state.needsSettings = false;
    state.paused = false; // an explicit user action – new budget
    state.budget = { requests: 0, chars: 0 };
    if (!state.appliedCount) state.initialDone = false; // show the progress again
    for (const unit of units) {
      const live = unit.targets.filter((t) => ptJobAlive(state, t.job)
        && (t.job.node ? t.job.node.nodeValue === t.job.orig : t.job.el.getAttribute(t.job.attr) === t.job.orig));
      if (!live.length) continue;
      const existing = state.pending.get(unit.key);
      if (existing) {
        existing.targets.push(...live);
        ptPromote(state, existing);
        continue;
      }
      unit.targets = live;
      unit.error = '';
      unit.near = false;
      state.pending.set(unit.key, unit);
      ptPromote(state, unit);
    }
    ptPump(state);
    ptCheckIdle(state);
    renderPill();
  }

  function ptResume(state) {
    state.paused = false;
    state.budget = { requests: 0, chars: 0 };
    ptPump(state);
    ptCheckIdle(state);
    renderPill();
  }

  function ptRestore() {
    const state = pt;
    if (!state) return false;
    pt = null;
    ptDisconnectObserver(state);
    if (state.io) state.io.disconnect();
    for (const timer of [state.flushTimer, state.sortTimer, state.scanTimer, state.revealTimer, state.collapseTimer]) clearTimeout(timer);
    for (const [node, e] of state.entries) if (node.nodeValue === e.trans) node.nodeValue = e.orig;
    for (const [el, map] of state.attrEntries) {
      for (const [name, e] of map) if (el.getAttribute(name) === e.trans) el.setAttribute(name, e.orig);
    }
    state.entries.clear();
    state.attrEntries.clear();
    state.queue.length = 0;
    state.pending.clear();
    state.failed.length = 0;
    state.watch.clear();
    state.scanRoots.length = 0;
    state.walker = null;
    state.hiddenEls.clear();
    state.dirty.clear();
    hidePill();
    return true;
  }

  // ----- status pill -----

  function buildPill() {
    const p = {};
    // The icon doubles as the "show again" button of the collapsed badge.
    p.icon = h('button', { type: 'button', class: 'pill-icon', tabindex: '-1', 'aria-hidden': 'true', on: { click: () => setPillCollapsed(false) } });
    p.title = h('div', { class: 'pill-title' });
    p.sub = h('div', { class: 'pill-sub', hidden: true });
    // Labels are set in renderPill() (they follow the state and the UI language).
    p.toggleBtn = button('', null, () => {
      if (!pt) return;
      if (pt.showing === 'translation') ptShowOriginal(pt);
      else ptShowTranslation(pt);
    }, { cls: 'btn-outline' });
    p.retryBtn = button('', 'refresh', () => {
      const state = pt;
      if (!state) return;
      if (state.notReady) {
        const lang = state.lang;
        ptRestore();
        startPageTranslation(lang).catch(report);
      } else if (state.failed.length) ptRetryFailed(state);
      else ptResume(state);
    }, { cls: 'btn-outline' });
    p.settingsBtn = button('', 'sliders', openSettings, { cls: 'btn-outline' });
    p.hideBtn = iconButton('minus', '', () => setPillCollapsed(true));
    p.closeBtn = iconButton('x', '', () => ptRestore());
    p.bar = h('span');
    p.progress = h('div', { class: 'pill-progress', 'aria-hidden': 'true' }, p.bar);
    p.el = h('div', { class: 'pill', role: 'region' },
      p.icon,
      h('div', { class: 'pill-text', role: 'status', 'aria-live': 'polite' }, p.title, p.sub),
      h('div', { class: 'pill-actions' }, p.toggleBtn, p.retryBtn, p.settingsBtn, p.hideBtn, p.closeBtn),
      p.progress);
    pill = p;
  }

  function setPillCollapsed(collapsed) {
    const state = pt;
    if (!state || state.collapsed === collapsed) return;
    state.collapsed = collapsed;
    state.autoCollapsed = true; // the user decided – no automatic collapse any more
    const hadFocus = Boolean(pill && shadow && pill.el.contains(shadow.activeElement));
    renderPill();
    if (hadFocus && pill) (collapsed ? pill.icon : pill.hideBtn).focus({ preventScroll: true });
  }

  // A finished translation shrinks to a badge after a moment (not while hovered or focused).
  function ptArmCollapse(state) {
    clearTimeout(state.collapseTimer);
    state.collapseTimer = setTimeout(safe(() => {
      state.collapseTimer = 0;
      if (pt !== state || state.autoCollapsed || state.collapsed || !pill) return;
      if (pill.el.matches(':hover') || (shadow && pill.el.contains(shadow.activeElement))) {
        ptArmCollapse(state);
        return;
      }
      state.autoCollapsed = true;
      state.collapsed = true;
      renderPill();
    }), PT_COLLAPSE_AFTER);
  }

  function setPillIcon(name) {
    if (pill.iconName === name) return;
    pill.iconName = name;
    pill.icon.replaceChildren(name === 'spinner' ? h('span', { class: 'spinner' }) : svg(name, 16));
  }

  function renderPill() {
    const state = pt;
    if (!state) {
      hidePill();
      return;
    }
    ensureUi();
    if (!pill) buildPill();
    if (!pill.el.isConnected) rootEl.append(pill.el);
    rootEl.classList.add('has-pill');

    const running = state.inFlight > 0 || (state.queue.length > 0 && !state.paused) || ptScanBusy(state);
    const waiting = Math.max(0, state.pending.size - state.queue.length - state.flightUnits); // until scrolled near
    const failed = state.failed.length;
    const pct = state.jobTotal ? Math.min(99, Math.floor((state.jobDone / state.jobTotal) * 100)) : 0;
    let tone = 'ok';
    let icon = 'check';
    let title;
    let sub = '';
    let toggle = state.appliedCount > 0;
    let retry = false;
    let retryLabel = t('content.tryAgain');
    let settings = false;
    let progress = null;

    if (state.notReady) {
      tone = 'error';
      icon = 'alert';
      title = t('content.page.notPossible');
      sub = t('content.notReadyShort');
      retry = true;
      settings = true;
      toggle = false;
    } else if (state.paused) {
      tone = 'warn';
      icon = 'info';
      title = t('content.page.paused');
      sub = t('content.page.pausedText');
      retry = true;
      retryLabel = t('content.page.continue');
    } else if (running && !state.initialDone) {
      tone = 'busy';
      icon = 'spinner';
      title = t('content.page.progress', { percent: pct });
      progress = pct;
    } else if (state.showing === 'original') {
      tone = 'idle';
      icon = 'globe';
      title = t('content.page.showingOriginal');
      sub = running ? t('content.page.runningInBackground') : '';
    } else if (!state.appliedCount && failed) {
      tone = 'error';
      icon = 'alert';
      title = t('content.page.failed');
      sub = state.lastError || t('content.page.noResult');
      retry = !running;
      settings = Boolean(state.needsSettings);
    } else if (!state.appliedCount && !running && !waiting) {
      tone = 'idle';
      icon = 'info';
      title = t('content.page.nothingFound');
      sub = t('content.page.nothingFoundText');
    } else {
      title = t('content.page.translatedTo', { language: languageLabel(state.lang) });
      if (running) {
        tone = 'busy';
        icon = 'spinner';
        sub = t('content.page.translatingNew');
      } else if (failed) {
        tone = 'warn';
        icon = 'alert';
        sub = `${t('content.page.failedSections', { count: failed })}${state.lastError ? ` ${state.lastError}` : ''}`;
        retry = true;
        retryLabel = t('content.popover.retry');
      } else if (waiting) {
        sub = t('content.page.moreOnScroll');
      }
    }

    // Tokens and costs so far, while translating and afterwards.
    const usage = !state.notReady && (state.appliedCount || running) ? describeUsage(state.usage) : null;
    let subTitle = sub;
    if (usage) {
      sub = [sub, usage.text].filter(Boolean).join(' · ');
      subTitle = [subTitle, usage.title].filter(Boolean).join('\n');
    }

    // Problems always show the full pill (once per new problem state).
    if ((tone === 'error' || tone === 'warn') && pill.lastTone !== tone) state.collapsed = false;
    pill.lastTone = tone;
    const collapsed = state.collapsed;
    pill.el.classList.toggle('collapsed', collapsed);
    pill.el.dataset.tone = tone;
    setPillIcon(icon);
    pill.icon.tabIndex = collapsed ? 0 : -1;
    if (collapsed) {
      pill.icon.removeAttribute('aria-hidden');
      const expand = t('content.page.expand', { title });
      pill.icon.setAttribute('aria-label', expand);
      pill.icon.title = expand;
    } else {
      pill.icon.setAttribute('aria-hidden', 'true');
      pill.icon.removeAttribute('aria-label');
      pill.icon.removeAttribute('title');
    }
    pill.title.textContent = title;
    pill.title.title = title;
    pill.sub.textContent = sub;
    pill.sub.title = subTitle;
    pill.sub.hidden = !sub;
    const toggleLabel = state.showing === 'translation' ? t('content.page.original') : t('content.page.translation');
    pill.toggleBtn.querySelector('span').textContent = toggleLabel;
    pill.toggleBtn.title = state.showing === 'translation' ? t('content.page.showOriginal') : t('content.page.showTranslation');
    pill.toggleBtn.setAttribute('aria-pressed', String(state.showing === 'original'));
    pill.toggleBtn.hidden = !toggle;
    pill.retryBtn.hidden = !retry;
    pill.retryBtn.querySelector('span').textContent = retryLabel;
    pill.settingsBtn.hidden = !settings;
    pill.settingsBtn.querySelector('span').textContent = t('content.menu.settings');
    pill.settingsBtn.title = t('content.openSettings');
    setLabel(pill.hideBtn, t('content.page.hide'));
    setLabel(pill.closeBtn, t('content.page.close'));
    pill.el.setAttribute('aria-label', t('content.page.label'));
    pill.progress.hidden = progress === null;
    pill.bar.style.width = `${progress || 0}%`;

    const done = tone === 'ok' && !running && state.showing === 'translation';
    if (done && !state.autoCollapsed && !collapsed) {
      if (!state.collapseTimer) ptArmCollapse(state);
    } else if (state.collapseTimer) {
      clearTimeout(state.collapseTimer);
      state.collapseTimer = 0;
    }
  }

  function hidePill() {
    if (pill && pill.el.isConnected) pill.el.remove();
    if (rootEl) rootEl.classList.remove('has-pill');
  }

  // ---------------------------------------------------------------------------
  // Global listeners
  // ---------------------------------------------------------------------------

  function fromOwnUi(e) {
    return Boolean(host && e.target === host);
  }

  function onPointerDown(e) {
    lastInputAt = now();
    if (fromOwnUi(e)) {
      uiPointerDown = true;
      lastUiPointerAt = now();
      return;
    }
    if (e.button === 0) pointerDown = true;
    hideToolbar();
    if (hint) closeHint();
  }

  function onPointerUp(e) {
    if (uiPointerDown) {
      uiPointerDown = false;
      lastUiPointerAt = now();
      return;
    }
    const wasDown = pointerDown;
    pointerDown = false;
    if (typeof e.button === 'number' && e.button !== 0) return;
    if (!wasDown && fromOwnUi(e)) return; // a click inside our UI (pointerup + mouseup both land here)
    pressEnded(e);
  }

  function pressEnded(e) {
    lastInputAt = now();
    if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
      lastPointer = { x: e.clientX, y: e.clientY, sx: window.scrollX, sy: window.scrollY, at: now() };
    }
    scheduleCheck(20, 'pointer'); // pointerup and mouseup coalesce into one check
  }

  // A page may swallow pointerup/mouseup (stopImmediatePropagation in an earlier capture
  // listener), or the button is released outside the window: the next pointer event without a
  // pressed button ends the press, so the toolbar is never blocked.
  function onPointerMove(e) {
    if ((!pointerDown && !uiPointerDown) || (e.buttons & 1)) return;
    if (uiPointerDown) {
      uiPointerDown = false;
      lastUiPointerAt = now();
      return;
    }
    pointerDown = false;
    pressEnded(e);
  }

  function onClick(e) {
    if (!pointerDown || fromOwnUi(e)) return;
    pointerDown = false;
    pressEnded(e);
  }

  // A drag or touch gesture taken over by the browser: the selection may still have changed.
  function onPointerCancel() {
    const wasDown = pointerDown;
    onBlur();
    if (wasDown) {
      lastInputAt = now();
      scheduleCheck(250, 'pointer');
    }
  }

  function isSelectionKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return true;
    return ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Tab'].includes(e.key);
  }

  function onKeyDown(e) {
    lastInputAt = now();
    if (e.key === 'Escape' && !e.isComposing) {
      let handled = true;
      if (toolbar.menu) closeMenu(true);
      else if (hint) closeHint();
      else if (popover) closePopover();
      else if (toolbar.visible) hideToolbar();
      else handled = false;
      if (handled && fromOwnUi(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (fromOwnUi(e)) return;
    if (toolbar.visible && !isSelectionKey(e)) hideToolbar();
  }

  function onKeyUp(e) {
    lastInputAt = now(); // keydown is only observed once our UI exists
    if (fromOwnUi(e)) return;
    const selectAll = (e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A');
    if (e.key === 'Shift' || e.shiftKey || selectAll) scheduleCheck(220, 'key');
  }

  function onSelectionChange() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(safe(() => {
      if (pointerDown || uiPointerDown) return;
      checkSelection('selectionchange').catch(report);
    }), 250);
  }

  function onContextMenu(e) {
    if (fromOwnUi(e)) return;
    const snap = takeSnapshot();
    if (snap && isValidSelectionText(snap.text)) lastSnap = snap;
  }

  function onScroll() {
    if (toolbar.visible) requestToolbarReposition();
    if (pt && pt.queue.length) ptReprioritize();
  }

  function onResize() {
    if (toolbar.visible) requestToolbarReposition();
    if (popover && !popover.drag) keepInViewport(popover.el, POPOVER_WIDTH);
    if (hint) keepInViewport(hint.el, HINT_WIDTH);
    ptCheckRevealed(); // media queries may show more content
  }

  function onBlur() {
    pointerDown = false;
    uiPointerDown = false;
  }

  function onVisibilityChange() {
    if (!document.hidden && pt) ptScheduleFlush(pt); // changes collected while the tab was hidden
  }

  // A fullscreen element is a top-layer element: stack our UI above it (and drop it again after).
  function onFullscreenChange() {
    if (!host || !host.isConnected) return;
    if (uiContainer && !isUiContainer(uiContainer)) {
      uiContainer = null;
      attachHost();
    }
    syncTopLayer(true);
  }

  // Listeners that only matter once our UI exists (keeps tiny ad frames and idle pages cheap).
  function installUiListeners() {
    if (uiListeners || destroyed) return;
    uiListeners = true;
    on(window, 'keydown', onKeyDown, { capture: true });
    on(window, 'scroll', onScroll, { capture: true, passive: true });
    on(window, 'resize', onResize, { passive: true });
    on(document, 'visibilitychange', onVisibilityChange, { passive: true });
    on(document, 'fullscreenchange', onFullscreenChange, { passive: true });
    // CSS can reveal untranslated content without a DOM change (:hover, :focus-within, :checked, :target).
    for (const type of ['pointerover', 'focusin', 'click', 'transitionend']) on(window, type, ptCheckRevealed, { capture: true, passive: true });
    on(window, 'hashchange', ptCheckRevealed, { passive: true });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    try {
      listeners.abort();
    } catch {
      // ignore
    }
    try {
      ext.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // ignore
    }
    clearTimeout(checkTimer);
    clearTimeout(selectionTimer);
    try {
      hideToolbar();
      closeHint();
    } catch {
      // ignore
    }
    try {
      closePopover({ restoreFocus: false });
    } catch {
      // ignore
    }
    try {
      ptRestore();
    } catch {
      // ignore
    }
    try {
      if (containerWatch) containerWatch.ctl.abort();
      if (hostObserver) hostObserver.disconnect();
      if (host) host.remove();
    } catch {
      // ignore
    }
    containerWatch = null;
    hostObserver = null;
    uiContainer = null;
    host = null;
    shadow = null;
    rootEl = null;
    try {
      if (window[GUARD_KEY] === instance) delete window[GUARD_KEY];
    } catch {
      // ignore
    }
  }

  const instance = Object.freeze({ alive: () => !destroyed && isAlive(), destroy });
  try {
    Object.defineProperty(window, GUARD_KEY, { value: instance, configurable: true, enumerable: false, writable: false });
  } catch {
    // ignore
  }

  try {
    ext.runtime.onMessage.addListener(onRuntimeMessage);
  } catch (err) {
    report(err);
    destroy();
    return;
  }

  on(window, 'pointerdown', onPointerDown, { capture: true, passive: true });
  on(window, 'pointerup', onPointerUp, { capture: true, passive: true });
  on(window, 'mouseup', onPointerUp, { capture: true, passive: true });
  on(window, 'pointermove', onPointerMove, { capture: true, passive: true });
  on(window, 'click', onClick, { capture: true, passive: true });
  on(window, 'pointercancel', onPointerCancel, { capture: true, passive: true });
  on(window, 'keyup', onKeyUp, { capture: true, passive: true });
  on(window, 'contextmenu', onContextMenu, { capture: true, passive: true });
  on(window, 'blur', onBlur, { passive: true });
  on(document, 'selectionchange', onSelectionChange, { passive: true });
})();
