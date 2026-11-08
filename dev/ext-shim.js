// LLM Sidebar – fake `chrome.*` extension API for the dev harness (docs/ARCHITECTURE.md §9, §11).
//
// Classic script; dev/server.mjs injects it as the first element of <head> of every HTML page.
// It lets background.js, content.js, the side panel and the options page run as normal pages on
// http://localhost:8787 and talk to each other through BroadcastChannel('llm-sidebar-shim').
// Developer tool only – it is never part of the extension build.
//
// Roles (from location.pathname):
//   /dev/bg.html         → 'background' (hosts src/background/background.js)
//   /dev/test-page.html  → 'content'    (tab 1, loads src/content/content.js)
//   /src/**              → 'extension'  (side panel, options page)
//   anything else        → 'host'       (dev/harness.html; full API, receives no messages)
//
// Known differences from real Chrome (see also the report of this module):
// - Message, port, storage and executeScript payloads use JSON semantics (Chrome's default).
// - A listener that throws is logged and skipped; a listener that returns a Promise gets a warning
//   and is treated like Chrome < 148 (no async response). Use sendResponse + `return true`.
// - executeScript runs in the page's main world (not an isolated world); a throwing func rejects.
// - Only one window (id 1) and one tab (id 1 = the test page) with a single frame (frameId 0)
//   exist; tabs.sendMessage / executeScript to any other frame fail like a missing frame. Inside
//   the harness the test page is an iframe (window.top !== window); opened as its own browser tab
//   it is a top frame. The most recently loaded test page is "tab 1".
// - sidePanel.open() requires a (synchronous) user gesture: events fired by the harness buttons,
//   runtime messages sent while the sender had transient user activation.
// - tabs.create / runtime.openOptionsPage open a new browser tab only while the harness window has
//   transient user activation (e.g. right after a click in the side panel or test page). Otherwise
//   the harness shows a notice with a link – some embedded browsers turn a window.open() without
//   activation into a navigation of the current tab, which would replace the harness.
// - action.setBadgeText / setBadgeBackgroundColor / setTitle are shown on the icon in the harness
//   top bar (state of tab 1); the state lives in the frame that set it (normally the background).
// - If several harness tabs are open, the most recently started background frame is the active one.
(() => {
  'use strict';

  if (window.__shim && window.__shim.isShim) return;

  // ---------------------------------------------------------------------------
  // Constants & role
  // ---------------------------------------------------------------------------

  const EXTENSION_ID = 'shim-extension';
  const VERSION = '1.0.0-dev';
  const CHANNEL_NAME = 'llm-sidebar-shim';
  const TAB_ID = 1;
  const WINDOW_ID = 1;
  const BG_PAGE_PATH = '/dev/bg.html';
  const TEST_PAGE_PATH = '/dev/test-page.html';

  const WARMUP_MS = 120; // time to learn about the already running frames after start
  const BG_WAIT_MS = 5000; // max wait for a background frame (harness may still be loading)
  const CONTENT_WAIT_MS = 1500; // max wait for the test page (e.g. while it reloads)
  const STALE_MS = 4000; // a frame that does not acknowledge a request within this time is dropped

  const ERR = {
    noReceiver: 'Could not establish connection. Receiving end does not exist.',
    portClosed: 'The message port closed before a response was received.',
    disconnected: 'Attempting to use a disconnected port object',
    frameRemoved: 'Frame with ID 0 was removed.',
    sessionAccess: 'Access to storage is not allowed from this context.',
    gesture: '`sidePanel.open()` may only be called in response to a user gesture.',
  };

  const LS = {
    local: 'shim:local:',
    session: 'shim:session:',
    installed: 'shim:installed',
    debug: 'shim:debug',
  };

  const ROLE = (() => {
    const p = location.pathname;
    if (p === BG_PAGE_PATH) return 'background';
    if (p === TEST_PAGE_PATH) return 'content';
    if (p.startsWith('/src/')) return 'extension';
    return 'host';
  })();
  const IS_EXTENSION_CONTEXT = ROLE === 'background' || ROLE === 'extension';
  const FRAME_ID = randomId();
  const STARTED_AT = Date.now();

  const COMMANDS = [
    { name: '_execute_action', description: 'LLM Sidebar öffnen', shortcut: 'Alt+Shift+L' },
    { name: 'translate-page', description: 'Aktuelle Seite übersetzen', shortcut: 'Alt+Shift+T' },
    { name: 'restore-page', description: 'Originalseite wiederherstellen', shortcut: '' },
    { name: 'summarize-page', description: 'Seite zusammenfassen', shortcut: '' },
  ];

  const ICONS = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' };
  const MANIFEST = {
    manifest_version: 3,
    name: 'LLM Sidebar',
    version: VERSION,
    description: 'KI-Seitenleiste mit eigenem API-Schlüssel: chatten, Texte verbessern, übersetzen und Bilder generieren – mit OpenAI, Claude, Grok, OpenRouter, Z.AI und vielen mehr.',
    minimum_chrome_version: '116',
    icons: ICONS,
    action: { default_title: 'LLM Sidebar öffnen', default_icon: ICONS },
    options_ui: { page: 'options/options.html', open_in_tab: true },
    background: { service_worker: 'background/background.js', type: 'module' },
    side_panel: { default_path: 'sidepanel/sidepanel.html' },
    permissions: ['storage', 'unlimitedStorage', 'contextMenus', 'scripting', 'activeTab', 'sidePanel'],
    host_permissions: ['<all_urls>'],
    content_scripts: [{ matches: ['<all_urls>'], js: ['content/content.js'], run_at: 'document_idle', all_frames: true, match_about_blank: true }],
    commands: {
      _execute_action: { suggested_key: { default: 'Alt+Shift+L' }, description: 'LLM Sidebar öffnen' },
      'translate-page': { suggested_key: { default: 'Alt+Shift+T' }, description: 'Aktuelle Seite übersetzen' },
      'restore-page': { description: 'Originalseite wiederherstellen' },
      'summarize-page': { description: 'Seite zusammenfassen' },
    },
  };

  // Events that other frames may trigger in the background via a 'fire' envelope.
  const FIREABLE_EVENTS = new Set(['commands.onCommand', 'contextMenus.onClicked', 'action.onClicked', 'runtime.onStartup']);
  // Envelope kinds that wait until this frame's own scripts have run (like Chrome waking a worker).
  const QUEUED_KINDS = new Set(['msg', 'connect', 'port-msg', 'port-close', 'exec', 'fire']);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const events = Object.create(null);
  const registry = new Map(); // frameId → { frameId, role, startedAt, url, title, status } (other frames only)
  const registryWaiters = new Set();
  const pending = new Map(); // request id → outgoing request state
  const pendingResponders = new Map(); // request id → closes an async (return true) response on unload
  const ports = new Map(); // portId → port state
  const queue = [];
  const menuItems = new Map();
  const warnedPromiseListeners = new WeakSet();
  const warmup = new Promise((resolve) => setTimeout(resolve, WARMUP_MS));
  let resolveReady = null;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  let ready = false;
  let alive = true;
  let channel = null;
  let counter = 0;
  let gestureDepth = 0;
  let lastErrorValue;
  let lastErrorChecked = false;
  let lastTab = null;
  let menuAutoId = 0;
  let nextTabId = TAB_ID + 1;
  let noBackgroundWarned = false;
  let installedScheduled = false;
  let installedFired = false;
  const panelBehavior = { openPanelOnActionClick: false };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function randomId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function nextId(prefix) {
    counter += 1;
    return `${prefix}-${FRAME_ID}-${counter}`;
  }

  function errMsg(e) {
    if (e && typeof e.message === 'string' && e.message) return e.message;
    return String(e);
  }

  // Chrome serializes extension messages as JSON by default – emulate exactly that.
  function jsonClone(value, what = 'message') {
    if (value === undefined) return undefined;
    let json;
    try {
      json = JSON.stringify(value);
    } catch (e) {
      throw new Error(`Could not serialize ${what}: ${errMsg(e)}`);
    }
    return json === undefined ? undefined : JSON.parse(json);
  }

  function parseJson(text) {
    if (text === null || text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function globMatch(glob, text) {
    const re = new RegExp(`^${String(glob).split('*').map(escapeRegExp).join('.*')}$`, 's');
    return re.test(String(text ?? ''));
  }

  // Minimal WebExtension match-pattern check (used by tabs.query({ url })).
  function matchPattern(pattern, url) {
    if (pattern === '<all_urls>') return /^(https?|file|ftp|wss?):/i.test(String(url));
    const m = /^(\*|https?|file|ftp|wss?):\/\/([^/]*)(\/.*)$/.exec(String(pattern));
    if (!m) return false;
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    const scheme = u.protocol.slice(0, -1);
    if (m[1] === '*' ? !/^https?$/.test(scheme) : m[1] !== scheme) return false;
    const host = m[2];
    if (host && host !== '*') {
      if (host.startsWith('*.')) {
        const base = host.slice(2);
        if (u.hostname !== base && !u.hostname.endsWith(`.${base}`)) return false;
      } else if (host !== u.host && host !== u.hostname) {
        return false;
      }
    }
    return globMatch(m[3], u.pathname + u.search);
  }

  function emitDom(type, detail) {
    try {
      window.dispatchEvent(new CustomEvent(type, { detail }));
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // localStorage backend (falls back to memory if localStorage is unavailable)
  // ---------------------------------------------------------------------------

  const store = (() => {
    try {
      const s = window.localStorage;
      const probe = 'shim:__probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch {
      console.warn('[shim] localStorage ist nicht verfügbar – der Speicher ist nur flüchtig und nicht zwischen Frames geteilt.');
      const map = new Map();
      return {
        get length() {
          return map.size;
        },
        key: (i) => [...map.keys()][i] ?? null,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => {
          map.set(k, String(v));
        },
        removeItem: (k) => {
          map.delete(k);
        },
      };
    }
  })();

  function storeKeys() {
    const keys = [];
    try {
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i);
        if (k !== null) keys.push(k);
      }
    } catch {
      /* ignore */
    }
    return keys;
  }

  function storeGet(key) {
    try {
      return store.getItem(key);
    } catch {
      return null;
    }
  }

  function storeRemove(key) {
    try {
      store.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Debug logging (localStorage 'shim:debug' = '1'); secrets are redacted
  // ---------------------------------------------------------------------------

  const SECRET_KEY_RE = /^(api[-_]?key|x-api-key|authorization|proxy-authorization|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|token|password)$/i;

  function debugOn() {
    return storeGet(LS.debug) === '1';
  }

  function redact(value, depth = 0) {
    if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}… (${value.length} Zeichen)` : value;
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (!value || typeof value !== 'object') return value;
    if (depth > 6) return '[…]';
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY_RE.test(k) && v ? '***' : redact(v, depth + 1);
    return out;
  }

  function log(name, args = []) {
    if (!debugOn()) return;
    try {
      console.log('[shim]', `[${ROLE}]`, name, ...args.map((a) => redact(a)));
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Events, lastError, user gestures, promise/callback API wrapper
  // ---------------------------------------------------------------------------

  function makeEvent(name, { register = true, onAdd = null } = {}) {
    const listeners = [];
    const ev = {
      addListener(fn) {
        if (typeof fn !== 'function') throw new TypeError(`${name}.addListener: Listener muss eine Funktion sein.`);
        if (!listeners.includes(fn)) listeners.push(fn);
        if (onAdd) onAdd();
      },
      removeListener(fn) {
        const i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      },
      hasListener(fn) {
        return listeners.includes(fn);
      },
      hasListeners() {
        return listeners.length > 0;
      },
    };
    Object.defineProperty(ev, '__listeners', { value: listeners });
    if (register) events[name] = ev;
    return ev;
  }

  function listenersOf(ev) {
    return ev ? ev.__listeners.slice() : [];
  }

  function withGesture(fn) {
    gestureDepth += 1;
    try {
      return fn();
    } finally {
      gestureDepth -= 1;
    }
  }

  function hasUserGesture() {
    if (gestureDepth > 0) return true;
    try {
      const ua = navigator.userActivation;
      return ua ? ua.isActive : ROLE !== 'background';
    } catch {
      return false;
    }
  }

  // Dispatches a global event in this frame; returns the number of listeners.
  function dispatch(name, args = [], { gesture = false } = {}) {
    const fns = listenersOf(events[name]);
    if (fns.length) log(`⚡ ${name}`, args);
    const run = () => {
      for (const fn of fns) {
        try {
          fn(...args);
        } catch (e) {
          console.error(`[shim] Fehler in einem ${name}-Listener:`, e);
        }
      }
    };
    if (gesture) withGesture(run);
    else run();
    return fns.length;
  }

  function withLastError(message, fn) {
    lastErrorValue = message ? { message } : undefined;
    lastErrorChecked = false;
    try {
      fn();
    } finally {
      if (message && !lastErrorChecked) console.error(`Unchecked runtime.lastError: ${message}`);
      lastErrorValue = undefined;
      lastErrorChecked = false;
    }
  }

  function callWithLastError(cb, message, ...args) {
    withLastError(message, () => {
      try {
        cb(...args);
      } catch (e) {
        console.error('[shim] Fehler in einem API-Callback:', e);
      }
    });
  }

  // Promise-returning API method that also accepts a trailing Chrome-style callback.
  // `impl` is called synchronously so that gesture checks see the caller's stack.
  function asyncFn(name, impl) {
    return function shimApi(...args) {
      let callback = null;
      if (args.length && typeof args[args.length - 1] === 'function') callback = args.pop();
      log(name, args);
      let promise;
      try {
        promise = Promise.resolve(impl(...args));
      } catch (e) {
        promise = Promise.reject(e);
      }
      if (!callback) return promise;
      promise.then(
        (result) => callWithLastError(callback, null, result),
        (err) => callWithLastError(callback, errMsg(err)),
      );
      return undefined;
    };
  }

  // ---------------------------------------------------------------------------
  // BroadcastChannel transport & frame registry
  // ---------------------------------------------------------------------------

  function post(env) {
    if (!channel) return;
    const full = { ...env, from: FRAME_ID, fromRole: ROLE, fromStart: STARTED_AT };
    try {
      channel.postMessage(full);
    } catch (e) {
      console.error('[shim] Nachricht konnte nicht übertragen werden:', e);
    }
  }

  function selfInfo() {
    const info = { role: ROLE, startedAt: STARTED_AT, url: location.href };
    if (ROLE === 'content') {
      const own = ownTabInfo();
      info.title = own.title;
      info.status = own.status;
    }
    return info;
  }

  function framesWithRole(...roles) {
    return [...registry.values()].filter((f) => roles.includes(f.role));
  }

  function newestFrame(frames) {
    let best = null;
    for (const f of frames) {
      if (!best || f.startedAt > best.startedAt || (f.startedAt === best.startedAt && f.frameId > best.frameId)) best = f;
    }
    return best;
  }

  function isPrimaryBackground() {
    if (ROLE !== 'background') return false;
    const best = newestFrame([...framesWithRole('background'), { frameId: FRAME_ID, startedAt: STARTED_AT }]);
    return best.frameId === FRAME_ID;
  }

  function registryChanged() {
    for (const waiter of [...registryWaiters]) waiter();
    if (ROLE === 'host') emitDom('shim:registry', null);
  }

  function waitFor(predicate, timeoutMs) {
    if (predicate()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = 0;
      const finish = (value) => {
        registryWaiters.delete(check);
        clearTimeout(timer);
        resolve(value);
      };
      const check = () => {
        if (predicate()) finish(true);
      };
      timer = setTimeout(() => finish(predicate()), timeoutMs);
      registryWaiters.add(check);
    });
  }

  function rememberTab(entry) {
    if (entry && entry.role === 'content') lastTab = { url: entry.url, title: entry.title, status: entry.status };
  }

  // Every envelope carries from/fromRole/fromStart, so any traffic keeps the registry fresh.
  function noteFrame(env) {
    if (!env.from || env.from === FRAME_ID || env.kind === 'bye' || !env.fromRole) return;
    let entry = registry.get(env.from);
    const isNew = !entry;
    if (isNew) {
      entry = { frameId: env.from, role: env.fromRole, startedAt: Number(env.fromStart) || 0, url: '', title: '', status: '' };
      registry.set(env.from, entry);
    }
    if (env.kind === 'hello' || env.kind === 'here') {
      if (typeof env.url === 'string') entry.url = env.url;
      if (typeof env.title === 'string') entry.title = env.title;
      if (typeof env.status === 'string') entry.status = env.status;
      rememberTab(entry);
    }
    if (isNew || env.kind === 'hello' || env.kind === 'here') registryChanged();
  }

  function removeFrame(frameId) {
    const entry = registry.get(frameId);
    if (entry) {
      registry.delete(frameId);
      if (entry.role === 'content') lastTab = { url: entry.url, title: entry.title, status: 'loading' };
      registryChanged();
    }
    onFrameGone(frameId);
  }

  // A frame that did not acknowledge in time is forgotten (it re-appears with its next envelope).
  function dropUnresponsiveFrame(frameId) {
    const entry = registry.get(frameId);
    if (!entry) return;
    console.warn(`[shim] Frame antwortet nicht und wird ignoriert: ${entry.role} ${entry.url}`);
    registry.delete(frameId);
    registryChanged();
  }

  function onFrameGone(frameId) {
    for (const p of [...pending.values()]) {
      if (!p.expected.has(frameId) || p.replied.has(frameId)) continue;
      p.expected.delete(frameId);
      if (p.seen.has(frameId)) p.closed = true;
      checkDone(p);
    }
    for (const st of [...ports.values()]) handlePortPeerGone(st, frameId);
  }

  // runtime.sendMessage / runtime.connect reach extension contexts – never another background
  // frame (that would be a second harness instance, not a second listener).
  function receivesRuntime(env) {
    return IS_EXTENSION_CONTEXT && !(ROLE === 'background' && env.fromRole === 'background');
  }

  function receivesMessage(env) {
    return env.target === 'tab' ? ROLE === 'content' : receivesRuntime(env);
  }

  function runtimeTargets() {
    return (ROLE === 'background' ? framesWithRole('extension') : framesWithRole('background', 'extension')).map((f) => f.frameId);
  }

  function acknowledge(env) {
    if (env.kind === 'msg' && receivesMessage(env)) post({ kind: 'seen', ref: env.id, to: env.from });
    else if (env.kind === 'connect' && receivesRuntime(env)) post({ kind: 'seen', ref: env.portId, to: env.from });
    else if (env.kind === 'exec' && ROLE === 'content') post({ kind: 'seen', ref: env.id, to: env.from });
  }

  function onEnvelope(event) {
    const env = event && event.data;
    if (!alive || !env || typeof env !== 'object' || typeof env.kind !== 'string' || env.from === FRAME_ID) return;
    noteFrame(env);
    if (env.to && env.to !== FRAME_ID) return;
    if (QUEUED_KINDS.has(env.kind)) {
      acknowledge(env);
      if (!ready) {
        queue.push(env);
        return;
      }
    }
    handleEnvelope(env);
  }

  function handleEnvelope(env) {
    try {
      switch (env.kind) {
        case 'hello':
          post({ kind: 'here', to: env.from, ...selfInfo() });
          break;
        case 'here':
          break;
        case 'bye':
          removeFrame(env.from);
          break;
        case 'seen':
          onSeen(env);
          break;
        case 'msg-reply':
          onMsgReply(env);
          break;
        case 'exec-reply':
          onExecReply(env);
          break;
        case 'connect-ack':
          onConnectAck(env);
          break;
        case 'msg':
          if (receivesMessage(env)) handleIncomingMessage(env);
          break;
        case 'connect':
          if (receivesRuntime(env)) handleIncomingConnect(env);
          break;
        case 'port-msg':
          onPortMessage(env);
          break;
        case 'port-close':
          onPortClose(env);
          break;
        case 'exec':
          if (ROLE === 'content') handleExec(env);
          break;
        case 'storage':
          if (env.area === 'local' || env.area === 'session') dispatchStorage(env.area, env.changes || {});
          break;
        case 'tab-update':
          onTabUpdate(env);
          break;
        case 'fire':
          handleFire(env);
          break;
        case 'open-blocked':
          if (ROLE === 'host') emitDom('shim:open-blocked', { url: String(env.url || ''), reason: String(env.reason || 'blocked'), frameId: env.from });
          break;
        case 'open-tab':
          if (ROLE === 'host') openTabHere(String(env.url || ''));
          break;
        case 'action-state':
          if (ROLE === 'host') emitDom('shim:action', { ...(env.state || {}), frameId: env.from, fromRole: env.fromRole });
          break;
        case 'sidepanel-open':
          if (ROLE === 'host') emitDom('shim:sidepanel-open', { frameId: env.from });
          break;
        case 'bg-error':
          if (ROLE === 'host') emitDom('shim:bg-error', { message: String(env.message || ''), frameId: env.from });
          break;
        default:
          break;
      }
    } catch (e) {
      console.error(`[shim] Fehler beim Verarbeiten von „${env.kind}“:`, e);
    }
  }

  function markReady() {
    if (ready) return;
    ready = true;
    resolveReady();
    for (const env of queue.splice(0)) handleEnvelope(env);
  }

  // ---------------------------------------------------------------------------
  // Outgoing requests (runtime.sendMessage, tabs.sendMessage, executeScript)
  // ---------------------------------------------------------------------------

  function startRequest(kind, envelope, expectedIds) {
    return new Promise((resolve, reject) => {
      const id = nextId(kind);
      const p = {
        id,
        kind,
        expected: new Set(expectedIds),
        seen: new Set(),
        replied: new Set(),
        listeners: 0,
        closed: false,
        settled: false,
        resolve,
        reject,
        timer: 0,
      };
      pending.set(id, p);
      p.timer = setTimeout(() => onStale(p), STALE_MS);
      post({ ...envelope, kind, id });
    });
  }

  function settle(p, fn) {
    if (p.settled) return;
    p.settled = true;
    clearTimeout(p.timer);
    pending.delete(p.id);
    fn();
  }

  function checkDone(p) {
    if (p.settled) return;
    for (const f of p.expected) if (!p.replied.has(f)) return;
    if (p.kind === 'exec') settle(p, () => p.reject(new Error(ERR.frameRemoved)));
    else if (p.closed) settle(p, () => p.reject(new Error(ERR.portClosed)));
    else if (p.listeners === 0) settle(p, () => p.reject(new Error(ERR.noReceiver)));
    else settle(p, () => p.resolve(undefined));
  }

  function onStale(p) {
    if (p.settled) return;
    for (const f of [...p.expected]) {
      if (p.seen.has(f) || p.replied.has(f)) continue;
      p.expected.delete(f);
      dropUnresponsiveFrame(f);
    }
    checkDone(p);
  }

  function onSeen(env) {
    const p = pending.get(env.ref);
    if (p) {
      p.seen.add(env.from);
      p.expected.add(env.from); // a frame we did not know yet – wait for its reply too
      return;
    }
    const st = ports.get(env.ref);
    if (st && st.side === 'opener') {
      st.seen.add(env.from);
      if (!st.acked.has(env.from)) st.pendingAcks.add(env.from);
    }
  }

  function onMsgReply(env) {
    const p = pending.get(env.ref);
    if (!p || p.kind !== 'msg') return;
    p.replied.add(env.from);
    p.expected.add(env.from);
    p.listeners += Number(env.listeners) || 0;
    if (env.closed) p.closed = true;
    if (env.responded) settle(p, () => p.resolve(env.response));
    else checkDone(p);
  }

  function onExecReply(env) {
    const p = pending.get(env.ref);
    if (!p || p.kind !== 'exec') return;
    settle(p, () => (env.ok ? p.resolve(env.result) : p.reject(new Error(env.error || 'Fehler im injizierten Skript.'))));
  }

  function warnNoBackground() {
    if (noBackgroundWarned) return;
    noBackgroundWarned = true;
    console.warn('[shim] Kein Hintergrund-Frame gefunden. Öffne die Dev-Harness (/dev/harness.html), damit background.js läuft.');
  }

  function ownSender() {
    const sender = { id: EXTENSION_ID, url: location.href, origin: location.origin };
    if (ROLE === 'content') {
      sender.tab = currentTab();
      sender.frameId = 0;
      sender.documentId = FRAME_ID;
    }
    return sender;
  }

  async function runtimeSendMessage(...args) {
    // Signature: ([extensionId], message, [options])
    if (args.length >= 2 && typeof args[0] === 'string' && (args[0] === EXTENSION_ID || args.length >= 3)) args.shift();
    const gesture = hasUserGesture(); // captured synchronously, Chrome forwards the gesture
    const message = jsonClone(args[0]);
    const sender = ownSender();
    await warmup;
    if (ROLE !== 'background') await waitFor(() => framesWithRole('background').length > 0, BG_WAIT_MS);
    const expected = runtimeTargets();
    if (!expected.length) {
      if (ROLE !== 'background') warnNoBackground();
      throw new Error(ERR.noReceiver);
    }
    return startRequest('msg', { target: 'runtime', message, sender, gesture }, expected);
  }

  async function tabsSendMessage(tabId, message, options) {
    const data = jsonClone(message);
    const sender = ownSender();
    if (tabId !== TAB_ID) throw new Error(ERR.noReceiver);
    if (options && options.frameId !== undefined && options.frameId !== null && options.frameId !== 0) throw new Error(ERR.noReceiver);
    await warmup;
    await waitFor(() => framesWithRole('content').length > 0, CONTENT_WAIT_MS);
    const target = newestFrame(framesWithRole('content'));
    if (!target) throw new Error(ERR.noReceiver);
    return startRequest('msg', { target: 'tab', to: target.frameId, message: data, sender }, [target.frameId]);
  }

  // target.frameIds / target.allFrames → the frame ids to run in (only frame 0 exists).
  function injectionFrames(target, tabId) {
    if (target.frameIds === undefined || target.frameIds === null) return [0];
    if (!Array.isArray(target.frameIds)) throw new TypeError('scripting.executeScript: „target.frameIds“ muss ein Array sein.');
    if (target.allFrames) throw new Error("Cannot specify both 'allFrames' and 'frameIds'.");
    const missing = target.frameIds.find((id) => id !== 0);
    if (missing !== undefined) throw new Error(`No frame with id ${missing} in tab with id ${tabId}`);
    return target.frameIds.length ? [0] : [];
  }

  async function executeScript(injection) {
    if (!injection || typeof injection !== 'object') throw new TypeError('scripting.executeScript: Parameter „injection“ fehlt.');
    const where = injection.target && typeof injection.target === 'object' ? injection.target : {};
    const tabId = where.tabId;
    if (tabId !== TAB_ID) throw new Error(`No tab with id: ${tabId}.`);
    const frames = injectionFrames(where, tabId);
    const hasFiles = Array.isArray(injection.files) && injection.files.length > 0;
    const hasFunc = typeof injection.func === 'function';
    if (hasFiles === hasFunc) throw new Error("Exactly one of 'func' and 'files' must be specified.");
    if (!frames.length) return [];
    // The test page loads content/content.js itself, so file injection is a no-op.
    if (hasFiles) return [{ frameId: 0, result: undefined }];
    const args = jsonClone(injection.args === undefined ? [] : injection.args, 'args');
    if (!Array.isArray(args)) throw new TypeError('scripting.executeScript: „args“ muss ein Array sein.');
    const src = Function.prototype.toString.call(injection.func);
    await warmup;
    await waitFor(() => framesWithRole('content').length > 0, CONTENT_WAIT_MS);
    const target = newestFrame(framesWithRole('content'));
    if (!target) throw new Error(ERR.frameRemoved);
    const result = await startRequest('exec', { to: target.frameId, src, args }, [target.frameId]);
    return [{ frameId: 0, documentId: target.frameId, result }];
  }

  // ---------------------------------------------------------------------------
  // Incoming one-time messages (runtime.onMessage semantics)
  // ---------------------------------------------------------------------------

  function warnPromiseListener(fn) {
    if (warnedPromiseListeners.has(fn)) return;
    warnedPromiseListeners.add(fn);
    console.warn('[shim] Ein runtime.onMessage-Listener hat ein Promise zurückgegeben. Chrome < 148 ignoriert das – antworte mit sendResponse(...) und „return true“.', fn);
  }

  function handleIncomingMessage(env) {
    const reply = (extra) => post({ kind: 'msg-reply', ref: env.id, to: env.from, listeners: 0, ...extra });
    if (ROLE === 'background' && !isPrimaryBackground()) {
      reply({ listeners: 0 });
      return;
    }
    const fns = listenersOf(events['runtime.onMessage']);
    const count = fns.length;
    if (!count) {
      reply({ listeners: 0 });
      return;
    }
    let state = 'sync'; // 'sync' → 'async' → 'done'
    const sendResponse = (response) => {
      if (state === 'done') return; // first response wins, later calls are ignored (like Chrome)
      let payload;
      try {
        payload = jsonClone(response, 'response');
      } catch (e) {
        console.error('[shim] sendResponse:', errMsg(e));
        payload = undefined;
      }
      state = 'done';
      pendingResponders.delete(env.id);
      reply({ listeners: count, responded: true, response: payload });
    };
    const message = env.message;
    const sender = env.sender;
    let keepOpen = false;
    const run = () => {
      for (const fn of fns) {
        let ret;
        try {
          ret = fn(message, sender, sendResponse);
        } catch (e) {
          console.error('[shim] Fehler in einem runtime.onMessage-Listener:', e);
          continue;
        }
        if (ret === true) keepOpen = true;
        else if (ret && typeof ret.then === 'function') warnPromiseListener(fn);
      }
    };
    log('⚡ runtime.onMessage', [message, sender]);
    if (env.gesture) withGesture(run);
    else run();
    if (state === 'done') return;
    if (keepOpen) {
      state = 'async';
      pendingResponders.set(env.id, () => {
        if (state === 'done') return;
        state = 'done';
        reply({ listeners: count, closed: true });
      });
      return;
    }
    state = 'done';
    reply({ listeners: count });
  }

  // ---------------------------------------------------------------------------
  // Ports (runtime.connect / runtime.onConnect)
  // ---------------------------------------------------------------------------

  function createPortState({ portId, name, side, sender = null, openerFrame = null }) {
    const st = {
      portId,
      name,
      side, // 'opener' | 'receiver'
      openerFrame,
      remotes: new Set(),
      pendingAcks: new Set(),
      acked: new Set(),
      seen: new Set(),
      connected: true,
      started: side === 'receiver',
      everAccepted: false,
      outbox: [],
      timer: 0,
      onMessage: makeEvent(`Port(${name}).onMessage`, { register: false }),
      onDisconnect: makeEvent(`Port(${name}).onDisconnect`, { register: false }),
      port: null,
    };
    const port = {
      name,
      onMessage: st.onMessage,
      onDisconnect: st.onDisconnect,
      postMessage(message) {
        if (!st.connected) throw new Error(ERR.disconnected);
        const data = jsonClone(message);
        log(`Port(${name}).postMessage`, [message]);
        if (st.side === 'receiver') post({ kind: 'port-msg', portId, to: st.openerFrame, data });
        else if (!st.started) st.outbox.push(data);
        else post({ kind: 'port-msg', portId, data });
      },
      disconnect() {
        if (!st.connected) return;
        log(`Port(${name}).disconnect`);
        st.connected = false;
        cleanupPort(st);
        if (st.started) post({ kind: 'port-close', portId });
      },
    };
    if (sender) port.sender = sender;
    st.port = port;
    ports.set(portId, st);
    return st;
  }

  function cleanupPort(st) {
    clearTimeout(st.timer);
    ports.delete(st.portId);
  }

  function firePortDisconnect(st, error) {
    if (!st.connected) return;
    st.connected = false;
    cleanupPort(st);
    log(`⚡ Port(${st.name}).onDisconnect`, error ? [error] : []);
    const fns = listenersOf(st.onDisconnect);
    withLastError(error, () => {
      for (const fn of fns) {
        try {
          fn(st.port);
        } catch (e) {
          console.error('[shim] Fehler in einem Port.onDisconnect-Listener:', e);
        }
      }
    });
  }

  function checkOpenerPort(st) {
    if (st.side !== 'opener' || !st.connected || !st.started || st.pendingAcks.size || st.remotes.size) return;
    firePortDisconnect(st, st.everAccepted ? null : ERR.noReceiver);
  }

  function handlePortPeerGone(st, frameId) {
    if (!st.connected) return;
    if (st.side === 'receiver') {
      if (frameId === st.openerFrame) firePortDisconnect(st, null);
      return;
    }
    const wasRemote = st.remotes.delete(frameId);
    const wasPending = st.pendingAcks.delete(frameId);
    if (wasRemote || wasPending) checkOpenerPort(st);
  }

  function runtimeConnect(...args) {
    if (typeof args[0] === 'string') args.shift(); // extensionId
    const info = args[0] && typeof args[0] === 'object' ? args[0] : {};
    const name = info.name === undefined || info.name === null ? '' : String(info.name);
    log('runtime.connect', [info]);
    const st = createPortState({ portId: nextId('port'), name, side: 'opener' });
    const sender = ownSender();
    (async () => {
      await warmup;
      if (ROLE !== 'background') await waitFor(() => framesWithRole('background').length > 0, BG_WAIT_MS);
      if (!st.connected) return;
      const expected = runtimeTargets();
      if (!expected.length) {
        if (ROLE !== 'background') warnNoBackground();
        st.started = true;
        firePortDisconnect(st, ERR.noReceiver);
        return;
      }
      st.pendingAcks = new Set(expected);
      st.started = true;
      post({ kind: 'connect', portId: st.portId, name, sender });
      for (const data of st.outbox.splice(0)) post({ kind: 'port-msg', portId: st.portId, data });
      st.timer = setTimeout(() => {
        if (!st.connected) return;
        for (const f of [...st.pendingAcks]) {
          if (st.seen.has(f)) continue;
          st.pendingAcks.delete(f);
          dropUnresponsiveFrame(f);
        }
        checkOpenerPort(st);
      }, STALE_MS);
    })().catch((e) => console.error('[shim] runtime.connect:', e));
    return st.port;
  }

  function handleIncomingConnect(env) {
    const ack = (accepted) => post({ kind: 'connect-ack', portId: env.portId, to: env.from, accepted });
    if (ROLE === 'background' && !isPrimaryBackground()) {
      ack(false);
      return;
    }
    const fns = listenersOf(events['runtime.onConnect']);
    if (!fns.length) {
      ack(false);
      return;
    }
    const st = createPortState({ portId: env.portId, name: String(env.name ?? ''), side: 'receiver', sender: env.sender || null, openerFrame: env.from });
    ack(true);
    log('⚡ runtime.onConnect', [{ name: st.name }]);
    for (const fn of fns) {
      try {
        fn(st.port);
      } catch (e) {
        console.error('[shim] Fehler in einem runtime.onConnect-Listener:', e);
      }
    }
    // The opener may have unloaded while this connect waited in the start-up queue.
    if (!registry.has(env.from)) setTimeout(() => handlePortPeerGone(st, env.from), 0);
  }

  function onConnectAck(env) {
    const st = ports.get(env.portId);
    if (!st || st.side !== 'opener') return;
    st.acked.add(env.from);
    st.seen.add(env.from);
    st.pendingAcks.delete(env.from);
    if (env.accepted && st.connected) {
      st.remotes.add(env.from);
      st.everAccepted = true;
    }
    checkOpenerPort(st);
  }

  function onPortMessage(env) {
    const st = ports.get(env.portId);
    if (!st || !st.connected) return;
    if (st.side === 'receiver' && env.from !== st.openerFrame) return;
    if (st.side === 'opener' && !st.remotes.has(env.from)) return;
    log(`⚡ Port(${st.name}).onMessage`, [env.data]);
    for (const fn of listenersOf(st.onMessage)) {
      try {
        fn(env.data, st.port);
      } catch (e) {
        console.error('[shim] Fehler in einem Port.onMessage-Listener:', e);
      }
    }
  }

  function onPortClose(env) {
    const st = ports.get(env.portId);
    if (st) handlePortPeerGone(st, env.from);
  }

  // ---------------------------------------------------------------------------
  // executeScript target side (content role)
  // ---------------------------------------------------------------------------

  async function handleExec(env) {
    let reply;
    try {
      // Indirect eval is fine here: the shim runs on a normal http page, never inside the extension.
      const fn = (0, eval)(`(${env.src})`);
      if (typeof fn !== 'function') throw new TypeError('„func“ ist keine Funktion.');
      let result = fn(...(Array.isArray(env.args) ? env.args : []));
      if (result && typeof result.then === 'function') result = await result;
      reply = { ok: true, result: jsonClone(result, 'result') };
    } catch (e) {
      console.error('[shim] scripting.executeScript: Fehler im injizierten Skript:', e);
      reply = { ok: false, error: errMsg(e) };
    }
    post({ kind: 'exec-reply', ref: env.id, to: env.from, ...reply });
  }

  // ---------------------------------------------------------------------------
  // Background-only event triggers & onInstalled
  // ---------------------------------------------------------------------------

  function handleFire(env) {
    if (ROLE !== 'background' || !isPrimaryBackground() || !FIREABLE_EVENTS.has(env.event)) return;
    const args = Array.isArray(env.args) ? env.args : [];
    if (env.event === 'commands.onCommand' && (args[1] === undefined || args[1] === null)) args[1] = currentTab();
    if (env.event === 'action.onClicked' && (args[0] === undefined || args[0] === null)) args[0] = currentTab();
    dispatch(env.event, args, { gesture: !!env.gesture });
  }

  function scheduleInstalled() {
    if (ROLE !== 'background' || installedScheduled) return;
    installedScheduled = true;
    readyPromise.then(() => setTimeout(fireInstalled, 30));
  }

  function fireInstalled() {
    if (installedFired || !alive) return;
    installedFired = true;
    if (!isPrimaryBackground()) {
      console.warn('[shim] Ein neuerer Hintergrund-Frame ist aktiv – runtime.onInstalled wird hier nicht ausgelöst.');
      return;
    }
    const first = storeGet(LS.installed) === null;
    try {
      store.setItem(LS.installed, '1');
    } catch {
      /* ignore */
    }
    const details = first ? { reason: 'install' } : { reason: 'update', previousVersion: VERSION };
    dispatch('runtime.onInstalled', [details]);
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  function ownTabInfo() {
    return {
      url: location.href,
      title: document.title || 'Testseite',
      status: document.readyState === 'complete' ? 'complete' : 'loading',
    };
  }

  function makeTab(info) {
    return {
      id: TAB_ID,
      index: 0,
      windowId: WINDOW_ID,
      active: true,
      highlighted: true,
      selected: true,
      pinned: false,
      audible: false,
      discarded: false,
      autoDiscardable: true,
      frozen: false,
      incognito: false,
      groupId: -1,
      mutedInfo: { muted: false },
      status: (info && info.status) || 'complete',
      url: (info && info.url) || `${location.origin}${TEST_PAGE_PATH}`,
      title: (info && info.title) || 'Testseite',
    };
  }

  function currentTab() {
    if (ROLE === 'content') return makeTab(ownTabInfo());
    const c = newestFrame(framesWithRole('content'));
    return makeTab(c || lastTab || { url: `${location.origin}${TEST_PAGE_PATH}`, title: '', status: 'complete' });
  }

  function queryTabs(queryInfo) {
    const q = queryInfo && typeof queryInfo === 'object' ? queryInfo : {};
    const tab = currentTab();
    const ok = [
      q.active === undefined || q.active === true,
      q.highlighted === undefined || q.highlighted === true,
      q.currentWindow === undefined || q.currentWindow === true,
      q.lastFocusedWindow === undefined || q.lastFocusedWindow === true,
      q.windowId === undefined || q.windowId === WINDOW_ID || q.windowId === -2,
      q.windowType === undefined || q.windowType === 'normal',
      q.index === undefined || q.index === 0,
      q.pinned === undefined || q.pinned === false,
      q.audible === undefined || q.audible === false,
      q.muted === undefined || q.muted === false,
      q.discarded === undefined || q.discarded === false,
      q.status === undefined || q.status === tab.status,
      q.title === undefined || globMatch(q.title, tab.title),
      q.url === undefined || [].concat(q.url).some((pattern) => matchPattern(pattern, tab.url)),
    ].every(Boolean);
    return ok ? [tab] : [];
  }

  function onTabUpdate(env) {
    if (ROLE === 'content') return;
    const entry = registry.get(env.from);
    if (!entry || entry.role !== 'content') return;
    const changeInfo = env.changeInfo && typeof env.changeInfo === 'object' ? env.changeInfo : {};
    if (typeof changeInfo.url === 'string') entry.url = changeInfo.url;
    if (typeof changeInfo.title === 'string') entry.title = changeInfo.title;
    if (typeof changeInfo.status === 'string') entry.status = changeInfo.status;
    rememberTab(entry);
    const newest = newestFrame(framesWithRole('content'));
    if (newest && newest.frameId !== entry.frameId) return;
    dispatch('tabs.onUpdated', [TAB_ID, jsonClone(changeInfo), currentTab()]);
  }

  const OPEN_HINTS = {
    'no-gesture': 'ohne Nutzeraktion angefordert, deshalb nicht automatisch geöffnet',
    unsupported: 'kann aus einer normalen Webseite nicht geöffnet werden',
    blocked: 'wurde vom Popup-Blocker verhindert',
  };

  function reportNotOpened(url, reason) {
    console.warn(`[shim] Neuer Tab ${OPEN_HINTS[reason] || OPEN_HINTS.blocked}: ${url}`);
    if (ROLE === 'host') emitDom('shim:open-blocked', { url, reason, frameId: FRAME_ID });
    else post({ kind: 'open-blocked', url, reason });
  }

  // The harness window this frame is embedded in (its shim handle), if any.
  function harnessHost() {
    try {
      const top = window.top;
      const shim = top && top !== window ? top.__shim : null;
      return shim && shim.isShim && shim.role === 'host' ? shim : null;
    } catch {
      return null;
    }
  }

  // Opens `url` in a NEW browser tab, never in the current one. Without transient activation
  // nothing is opened (see the header notes) – the harness shows a notice with a link instead.
  function openTabHere(url) {
    if (!/^(https?:|about:blank$)/i.test(url)) {
      reportNotOpened(url, 'unsupported');
      return null;
    }
    const activation = navigator.userActivation;
    if (activation && !activation.isActive) {
      reportNotOpened(url, 'no-gesture');
      return null;
    }
    let win = null;
    try {
      win = window.open(url, '_blank');
    } catch {
      win = null;
    }
    if (!win) reportNotOpened(url, 'blocked');
    return win;
  }

  // Frames inside the harness let the harness window open the tab (in its own task, so it is the
  // opener): a click in the side panel or test page activates that window too, while the hidden
  // background frame never has user activation of its own.
  function openWindow(url) {
    const host = ROLE === 'host' ? null : harnessHost();
    if (host) post({ kind: 'open-tab', to: host.frameId, url });
    else openTabHere(url);
  }

  function createTab(props) {
    const p = props && typeof props === 'object' ? props : {};
    // Relative URLs resolve against the calling extension page (the worker lives in background/).
    const base = ROLE === 'background' ? `${location.origin}/src/background/background.js` : location.href;
    let url = 'about:blank';
    if (p.url !== undefined && p.url !== null && p.url !== '') {
      try {
        url = new URL(String(p.url), base).href;
      } catch {
        throw new Error(`Invalid url: "${p.url}".`);
      }
    }
    openWindow(url);
    const active = p.active !== false;
    nextTabId += 1;
    return { ...makeTab({ url, title: '', status: 'loading' }), id: nextTabId - 1, index: 1, active, highlighted: active, selected: active, pendingUrl: url };
  }

  function getURL(path) {
    return `${location.origin}/src/${String(path ?? '').replace(/^\/+/, '')}`;
  }

  // ---------------------------------------------------------------------------
  // Toolbar icon (action.setBadgeText / setBadgeBackgroundColor / setTitle)
  // ---------------------------------------------------------------------------

  const actionGlobal = { title: MANIFEST.action.default_title, text: '', color: '#5f6368' };
  const actionTabs = new Map(); // tabId → tab-specific overrides { title?, text?, color? }

  function actionDetails(details, name) {
    const d = details && typeof details === 'object' ? details : null;
    if (!d) throw new TypeError(`action.${name}: Parameter „details“ fehlt.`);
    if (d.tabId !== undefined && d.tabId !== null && d.tabId !== TAB_ID) throw new Error(`No tab with id: ${d.tabId}.`);
    return d;
  }

  function badgeColor(color) {
    if (Array.isArray(color) && color.length >= 3 && color.length <= 4 && color.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      const [r, g, b, a = 255] = color;
      return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 100) / 100})`;
    }
    if (typeof color === 'string' && color.trim() && (typeof CSS === 'undefined' || CSS.supports('color', color))) return color.trim();
    throw new Error('The color specification could not be parsed.');
  }

  // Tab-specific value (tabId given) or the global default; `value === null` drops the override.
  function setActionValue(d, key, value) {
    if (d.tabId === undefined || d.tabId === null) {
      actionGlobal[key] = value === null ? (key === 'title' ? MANIFEST.action.default_title : '') : value;
    } else {
      const entry = actionTabs.get(d.tabId) || {};
      if (value === null) delete entry[key];
      else entry[key] = value;
      actionTabs.set(d.tabId, entry);
    }
    post({ kind: 'action-state', state: actionState() });
    if (ROLE === 'host') emitDom('shim:action', { ...actionState(), frameId: FRAME_ID, fromRole: ROLE });
  }

  function actionValue(details, key) {
    const tabId = details && typeof details === 'object' ? details.tabId : undefined;
    const entry = tabId === undefined || tabId === null ? null : actionTabs.get(tabId);
    return entry && key in entry ? entry[key] : actionGlobal[key];
  }

  // Effective icon state of the test page tab (what the harness shows).
  function actionState() {
    const d = { tabId: TAB_ID };
    return { title: actionValue(d, 'title'), text: actionValue(d, 'text'), color: actionValue(d, 'color') };
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  function storageKeysFor(area) {
    const prefix = LS[area];
    return storeKeys().filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }

  function readValue(area, key) {
    return parseJson(storeGet(LS[area] + key));
  }

  function emitStorageChanges(area, changes) {
    if (!Object.keys(changes).length) return;
    post({ kind: 'storage', area, changes });
    setTimeout(() => dispatchStorage(area, changes), 0); // Chrome notifies asynchronously, the writer too
  }

  function dispatchStorage(area, changes) {
    if (ROLE === 'content' && area === 'session') return; // content scripts cannot see storage.session
    dispatch('storage.onChanged', [jsonClone(changes), area]);
    dispatch(`storage.${area}.onChanged`, [jsonClone(changes)]);
  }

  function applySet(area, items) {
    const changes = {};
    let failure = null;
    for (const [key, value] of Object.entries(items)) {
      const json = JSON.stringify(value);
      if (json === undefined) continue;
      const full = LS[area] + key;
      const oldJson = storeGet(full);
      if (oldJson === json) continue; // Chrome only reports real changes
      try {
        store.setItem(full, json);
      } catch (e) {
        failure = new Error(`QUOTA_BYTES quota exceeded (${errMsg(e)})`);
        break;
      }
      changes[key] = oldJson === null ? { newValue: value } : { oldValue: parseJson(oldJson), newValue: value };
    }
    emitStorageChanges(area, changes);
    if (failure) throw failure;
  }

  function applyRemove(area, keys) {
    const changes = {};
    for (const key of keys) {
      const full = LS[area] + key;
      const oldJson = storeGet(full);
      if (oldJson === null) continue;
      storeRemove(full);
      changes[key] = { oldValue: parseJson(oldJson) };
    }
    emitStorageChanges(area, changes);
  }

  function makeStorageArea(area) {
    const name = `storage.${area}`;
    const denied = ROLE === 'content' && area === 'session';
    const guard = () => {
      if (denied) throw new Error(ERR.sessionAccess);
    };
    return {
      QUOTA_BYTES: 10485760,
      get: asyncFn(`${name}.get`, (keys) => {
        guard();
        const out = {};
        if (keys === null || keys === undefined) {
          for (const key of storageKeysFor(area)) {
            const v = readValue(area, key);
            if (v !== undefined) out[key] = v;
          }
          return out;
        }
        if (typeof keys === 'string' || Array.isArray(keys)) {
          for (const key of [].concat(keys)) {
            const v = readValue(area, String(key));
            if (v !== undefined) out[key] = v;
          }
          return out;
        }
        if (typeof keys === 'object') {
          for (const [key, fallback] of Object.entries(keys)) {
            const v = readValue(area, key);
            out[key] = v !== undefined ? v : jsonClone(fallback, 'default value');
          }
          return out;
        }
        throw new TypeError(`${name}.get: ungültiger Parameter „keys“.`);
      }),
      set: asyncFn(`${name}.set`, (items) => {
        guard();
        if (!items || typeof items !== 'object' || Array.isArray(items)) throw new TypeError(`${name}.set: „items“ muss ein Objekt sein.`);
        applySet(area, jsonClone(items, 'value'));
      }),
      remove: asyncFn(`${name}.remove`, (keys) => {
        guard();
        if (typeof keys !== 'string' && !Array.isArray(keys)) throw new TypeError(`${name}.remove: „keys“ muss ein String oder Array sein.`);
        applyRemove(area, [].concat(keys).map(String));
      }),
      clear: asyncFn(`${name}.clear`, () => {
        guard();
        applyRemove(area, storageKeysFor(area));
      }),
      onChanged: makeEvent(`${name}.onChanged`),
    };
  }

  function resetShimStorage() {
    const changes = { local: {}, session: {} };
    for (const key of storeKeys()) {
      for (const area of ['local', 'session']) {
        if (!key.startsWith(LS[area])) continue;
        changes[area][key.slice(LS[area].length)] = { oldValue: parseJson(storeGet(key)) };
        storeRemove(key);
      }
      if (key === LS.installed) storeRemove(key);
    }
    console.info('[shim] Shim-Speicher wurde zurückgesetzt (?reset=1).');
    return changes;
  }

  function buildSeedSettings() {
    const origin = location.origin;
    return {
      schemaVersion: 1,
      providers: [
        {
          id: 'custom-mock',
          presetId: 'custom',
          name: 'Mock (lokal)',
          protocol: 'openai',
          baseUrl: `${origin}/mock/v1`,
          apiKey: 'mock-key',
          enabled: true,
          models: ['mock-chat', 'mock-reasoner'],
          defaultModel: 'mock-chat',
          imageApi: 'openai-images',
          imageModels: ['mock-image'],
          defaultImageModel: 'mock-image',
          extraHeaders: {},
          modelInfo: {},
        },
        {
          id: 'custom-mock-claude',
          presetId: 'custom',
          name: 'Mock Claude (lokal)',
          protocol: 'anthropic',
          baseUrl: `${origin}/mock-anthropic/v1`,
          apiKey: 'mock-key',
          enabled: true,
          models: ['mock-claude'],
          defaultModel: 'mock-claude',
          imageApi: 'none',
          imageModels: [],
          defaultImageModel: '',
          extraHeaders: {},
          modelInfo: {},
        },
      ],
      defaults: {
        chat: { providerId: 'custom-mock', model: 'mock-chat' },
        actions: null,
        translate: null,
        image: { providerId: 'custom-mock', model: 'mock-image' },
      },
    };
  }

  function seedSettings() {
    const full = `${LS.local}settings`;
    if (storeGet(full) !== null) return {};
    const settings = buildSeedSettings();
    try {
      store.setItem(full, JSON.stringify(settings));
    } catch (e) {
      console.error('[shim] Mock-Einstellungen konnten nicht gespeichert werden:', e);
      return {};
    }
    console.info('[shim] Mock-Einstellungen angelegt (Anbieter „Mock (lokal)“ und „Mock Claude (lokal)“).');
    return { settings: { newValue: settings } };
  }

  // ---------------------------------------------------------------------------
  // Context menus
  // ---------------------------------------------------------------------------

  function menuSnapshot() {
    return [...menuItems.values()].map((item) => jsonClone(item));
  }

  function menuError(cb, message) {
    if (cb) setTimeout(() => callWithLastError(cb, message), 0);
    else console.error(`Unchecked runtime.lastError: ${message}`);
  }

  function removeMenuTree(id) {
    for (const item of [...menuItems.values()]) if (item.parentId === id) removeMenuTree(item.id);
    menuItems.delete(id);
  }

  function menuCreate(createProperties, callback) {
    const cb = typeof callback === 'function' ? callback : null;
    const p = createProperties && typeof createProperties === 'object' ? createProperties : {};
    log('contextMenus.create', [p]);
    const id = p.id !== undefined && p.id !== null ? p.id : (menuAutoId += 1);
    const type = p.type || 'normal';
    if (typeof p.onclick === 'function' && ROLE === 'background') {
      menuError(cb, 'Extensions using event pages or Service Workers cannot pass an onclick parameter to chrome.contextMenus.create. Instead, use the chrome.contextMenus.onClicked event.');
      return id;
    }
    if (menuItems.has(id)) {
      menuError(cb, `Cannot create item with duplicate id ${id}`);
      return id;
    }
    if (p.parentId !== undefined && p.parentId !== null && !menuItems.has(p.parentId)) {
      menuError(cb, `Cannot find menu item with id ${p.parentId}`);
      return id;
    }
    if (type !== 'separator' && !p.title) console.warn(`[shim] contextMenus.create: Eintrag „${id}“ hat keinen Titel.`);
    const item = {
      id,
      type,
      title: p.title === undefined ? '' : String(p.title),
      contexts: Array.isArray(p.contexts) && p.contexts.length ? p.contexts.map(String) : ['page'],
      enabled: p.enabled !== false,
      visible: p.visible !== false,
      checked: !!p.checked,
    };
    if (p.parentId !== undefined && p.parentId !== null) item.parentId = p.parentId;
    if (Array.isArray(p.documentUrlPatterns)) item.documentUrlPatterns = p.documentUrlPatterns.map(String);
    if (Array.isArray(p.targetUrlPatterns)) item.targetUrlPatterns = p.targetUrlPatterns.map(String);
    menuItems.set(id, item);
    if (cb) setTimeout(() => callWithLastError(cb, null), 0);
    return id;
  }

  function menuUpdate(id, props) {
    const item = menuItems.get(id);
    if (!item) throw new Error(`Cannot find menu item with id ${id}`);
    const p = props && typeof props === 'object' ? props : {};
    if (p.parentId !== undefined && p.parentId !== null && !menuItems.has(p.parentId)) throw new Error(`Cannot find menu item with id ${p.parentId}`);
    if (p.title !== undefined) item.title = String(p.title);
    if (p.type !== undefined) item.type = String(p.type);
    if (Array.isArray(p.contexts) && p.contexts.length) item.contexts = p.contexts.map(String);
    if (p.enabled !== undefined) item.enabled = !!p.enabled;
    if (p.visible !== undefined) item.visible = !!p.visible;
    if (p.checked !== undefined) item.checked = !!p.checked;
    if (p.parentId !== undefined && p.parentId !== null) item.parentId = p.parentId;
    if (Array.isArray(p.documentUrlPatterns)) item.documentUrlPatterns = p.documentUrlPatterns.map(String);
    if (Array.isArray(p.targetUrlPatterns)) item.targetUrlPatterns = p.targetUrlPatterns.map(String);
  }

  function menuRemove(id) {
    if (!menuItems.has(id)) throw new Error(`Cannot find menu item with id ${id}`);
    removeMenuTree(id);
  }

  // ---------------------------------------------------------------------------
  // Build the API surface
  // ---------------------------------------------------------------------------

  const onMessage = makeEvent('runtime.onMessage');
  const onConnect = makeEvent('runtime.onConnect');
  const runtimeSend = asyncFn('runtime.sendMessage', runtimeSendMessage);
  const lastErrorDescriptor = {
    get() {
      lastErrorChecked = true;
      return lastErrorValue;
    },
    enumerable: true,
    configurable: true,
  };

  const runtime = {
    id: EXTENSION_ID,
    getURL,
    getManifest: () => jsonClone(MANIFEST),
    sendMessage: runtimeSend,
    onMessage,
    connect: runtimeConnect,
    onConnect,
    openOptionsPage: asyncFn('runtime.openOptionsPage', () => {
      openWindow(getURL('options/options.html'));
    }),
    getPlatformInfo: asyncFn('runtime.getPlatformInfo', () => ({ os: 'win', arch: 'x86-64', nacl_arch: 'x86-64' })),
    onInstalled: makeEvent('runtime.onInstalled', { onAdd: scheduleInstalled }),
    onStartup: makeEvent('runtime.onStartup'),
  };
  Object.defineProperty(runtime, 'lastError', lastErrorDescriptor);

  const storage = {
    local: makeStorageArea('local'),
    session: makeStorageArea('session'),
    onChanged: makeEvent('storage.onChanged'),
  };

  const tabs = {
    TAB_ID_NONE: -1,
    query: asyncFn('tabs.query', (queryInfo) => queryTabs(queryInfo)),
    get: asyncFn('tabs.get', (tabId) => {
      if (tabId !== TAB_ID) throw new Error(`No tab with id: ${tabId}.`);
      return currentTab();
    }),
    create: asyncFn('tabs.create', createTab),
    sendMessage: asyncFn('tabs.sendMessage', tabsSendMessage),
    onActivated: makeEvent('tabs.onActivated'),
    onUpdated: makeEvent('tabs.onUpdated'),
  };

  const scripting = {
    executeScript: asyncFn('scripting.executeScript', executeScript),
  };

  const contextMenus = {
    ACTION_MENU_TOP_LEVEL_LIMIT: 6,
    create: menuCreate,
    update: asyncFn('contextMenus.update', menuUpdate),
    remove: asyncFn('contextMenus.remove', menuRemove),
    removeAll: asyncFn('contextMenus.removeAll', () => {
      menuItems.clear();
    }),
    onClicked: makeEvent('contextMenus.onClicked'),
  };

  const commands = {
    getAll: asyncFn('commands.getAll', () => jsonClone(COMMANDS)),
    onCommand: makeEvent('commands.onCommand'),
  };

  const action = {
    setBadgeText: asyncFn('action.setBadgeText', (details) => {
      const d = actionDetails(details, 'setBadgeText');
      if (d.text !== undefined && d.text !== null && typeof d.text !== 'string') throw new TypeError('action.setBadgeText: „text“ muss ein String sein.');
      setActionValue(d, 'text', d.text ?? null);
    }),
    setBadgeBackgroundColor: asyncFn('action.setBadgeBackgroundColor', (details) => {
      const d = actionDetails(details, 'setBadgeBackgroundColor');
      setActionValue(d, 'color', badgeColor(d.color));
    }),
    setTitle: asyncFn('action.setTitle', (details) => {
      const d = actionDetails(details, 'setTitle');
      if (d.title !== undefined && d.title !== null && typeof d.title !== 'string') throw new TypeError('action.setTitle: „title“ muss ein String sein.');
      setActionValue(d, 'title', d.title ?? null);
    }),
    getBadgeText: asyncFn('action.getBadgeText', (details) => actionValue(details, 'text')),
    getTitle: asyncFn('action.getTitle', (details) => actionValue(details, 'title')),
    onClicked: makeEvent('action.onClicked'),
  };

  const sidePanel = {
    setPanelBehavior: asyncFn('sidePanel.setPanelBehavior', (behavior) => {
      if (behavior && typeof behavior === 'object' && 'openPanelOnActionClick' in behavior) {
        panelBehavior.openPanelOnActionClick = !!behavior.openPanelOnActionClick;
      }
    }),
    getPanelBehavior: asyncFn('sidePanel.getPanelBehavior', () => ({ ...panelBehavior })),
    open: asyncFn('sidePanel.open', (options) => {
      if (!options || typeof options !== 'object' || (options.tabId === undefined && options.windowId === undefined)) {
        throw new Error('sidePanel.open(): At least one of tabId or windowId must be provided.');
      }
      if (!hasUserGesture()) throw new Error(ERR.gesture);
      post({ kind: 'sidepanel-open' });
      if (ROLE === 'host') emitDom('shim:sidepanel-open', { frameId: FRAME_ID });
    }),
  };

  const permissions = {
    contains: asyncFn('permissions.contains', () => true),
    request: asyncFn('permissions.request', () => true),
    getAll: asyncFn('permissions.getAll', () => ({ permissions: MANIFEST.permissions.slice(), origins: ['<all_urls>'] })),
  };

  const windows = {
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    getCurrent: asyncFn('windows.getCurrent', () => ({
      id: WINDOW_ID,
      focused: true,
      incognito: false,
      alwaysOnTop: false,
      type: 'normal',
      state: 'normal',
    })),
  };

  let api;
  if (ROLE === 'content') {
    // Content scripts only get a small subset of the API (like in Chrome).
    const contentRuntime = {
      id: EXTENSION_ID,
      getURL,
      getManifest: runtime.getManifest,
      sendMessage: runtimeSend,
      onMessage,
      connect: runtimeConnect,
      onConnect,
    };
    Object.defineProperty(contentRuntime, 'lastError', lastErrorDescriptor);
    api = { runtime: contentRuntime, storage };
  } else {
    api = { runtime, storage, tabs, scripting, contextMenus, commands, action, sidePanel, permissions, windows };
  }

  // ---------------------------------------------------------------------------
  // Install into the page
  // ---------------------------------------------------------------------------

  function installGlobal(name, value) {
    try {
      window[name] = value;
    } catch {
      /* ignore */
    }
    if (window[name] === value) return;
    try {
      Object.defineProperty(window, name, { value, configurable: true, writable: true });
    } catch {
      /* ignore */
    }
    if (window[name] === value) return;
    try {
      Object.assign(window[name], value); // last resort: extend the existing object
    } catch (e) {
      console.error(`[shim] window.${name} konnte nicht gesetzt werden:`, e);
    }
  }

  installGlobal('chrome', api);
  if (window.browser !== undefined) {
    try {
      delete window.browser;
    } catch {
      /* ignore */
    }
    if (window.browser !== undefined) {
      try {
        Object.defineProperty(window, 'browser', { value: undefined, configurable: true, writable: true });
      } catch {
        console.warn('[shim] window.browser ist gesetzt – der Erweiterungscode nutzt dann nicht den chrome-Pfad.');
      }
    }
  }

  const shimHandle = {
    isShim: true,
    role: ROLE,
    frameId: FRAME_ID,
    version: VERSION,
    // Fires a global event in THIS frame, e.g. fire('contextMenus.onClicked', [info, tab], { gesture: true }).
    // Arguments are JSON-cloned into this frame's realm. Returns the number of listeners.
    fire(name, args = [], options = {}) {
      if (!events[name]) throw new Error(`[shim] Unbekanntes Event: ${name}`);
      const cloned = jsonClone(Array.isArray(args) ? args : [args], 'event arguments') || [];
      return dispatch(name, cloned, { gesture: !!(options && options.gesture) });
    },
    menus: menuSnapshot,
    action: () => actionState(),
    registry: () => [...registry.values()].map((f) => ({ ...f })),
    tab: () => currentTab(),
    isPrimaryBackground: () => isPrimaryBackground(),
    setDebug(on) {
      try {
        if (on) store.setItem(LS.debug, '1');
        else store.removeItem(LS.debug);
      } catch {
        /* ignore */
      }
    },
  };
  try {
    Object.defineProperty(window, '__shim', { value: shimHandle, configurable: true });
    Object.defineProperty(window, '__shimMenus', { get: menuSnapshot, configurable: true });
  } catch (e) {
    console.error('[shim] Debug-Hilfen konnten nicht installiert werden:', e);
  }

  // ---------------------------------------------------------------------------
  // Start-up
  // ---------------------------------------------------------------------------

  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener('message', onEnvelope);
  } catch (e) {
    console.error('[shim] BroadcastChannel ist nicht verfügbar – Frames können nicht miteinander kommunizieren.', e);
  }

  let resetChanges = null;
  if (ROLE === 'host') {
    try {
      const params = new URLSearchParams(location.search);
      if (params.get('reset') === '1') {
        resetChanges = resetShimStorage();
        params.delete('reset');
        const query = params.toString();
        history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
      }
    } catch (e) {
      console.error('[shim] Zurücksetzen fehlgeschlagen:', e);
    }
  }
  const seedChanges = seedSettings();

  post({ kind: 'hello', ...selfInfo() });

  if (resetChanges) {
    emitStorageChanges('session', resetChanges.session);
    const local = resetChanges.local;
    if (seedChanges.settings) {
      local.settings = local.settings ? { oldValue: local.settings.oldValue, newValue: seedChanges.settings.newValue } : seedChanges.settings;
    }
    emitStorageChanges('local', local);
  } else {
    emitStorageChanges('local', seedChanges);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(markReady, 0), { once: true });
  } else {
    setTimeout(markReady, 0);
  }

  window.addEventListener('pagehide', () => {
    if (!alive) return;
    for (const close of [...pendingResponders.values()]) close();
    pendingResponders.clear();
    for (const st of [...ports.values()]) {
      if (st.connected && st.started) post({ kind: 'port-close', portId: st.portId });
      st.connected = false;
      cleanupPort(st);
    }
    post({ kind: 'bye' });
    alive = false;
  });

  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || alive) return;
    alive = true; // restored from the back/forward cache: announce ourselves again
    registry.clear();
    post({ kind: 'hello', ...selfInfo() });
  });

  if (ROLE === 'content') {
    let lastTitle = document.title;
    let lastUrl = location.href;
    const sendUpdate = (changeInfo) => post({ kind: 'tab-update', changeInfo });
    const checkTitle = () => {
      const title = document.title;
      if (title === lastTitle) return;
      lastTitle = title;
      sendUpdate({ title: title || 'Testseite' });
    };
    const checkUrl = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      sendUpdate({ url: lastUrl });
    };
    sendUpdate({ status: 'loading', url: location.href });
    document.addEventListener('DOMContentLoaded', () => {
      checkTitle();
      try {
        new MutationObserver(checkTitle).observe(document.head || document.documentElement, { subtree: true, childList: true, characterData: true });
      } catch {
        /* ignore */
      }
    }, { once: true });
    window.addEventListener('load', () => {
      checkTitle();
      sendUpdate({ status: 'complete' });
    }, { once: true });
    window.addEventListener('hashchange', checkUrl);
    window.addEventListener('popstate', checkUrl);
  }

  if (ROLE === 'background') {
    window.addEventListener('error', (event) => {
      const target = event.target;
      const message = target && target !== window && target.src
        ? `Skript konnte nicht geladen werden: ${target.src}`
        : (event.message || 'Unbekannter Fehler');
      post({ kind: 'bg-error', message });
    }, true);
    window.addEventListener('unhandledrejection', (event) => {
      post({ kind: 'bg-error', message: `Unbehandelte Promise-Ablehnung: ${errMsg(event.reason)}` });
    });
  } else {
    // Global keyboard shortcut of the 'translate-page' command (Alt+Shift+T).
    window.addEventListener('keydown', (event) => {
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.code !== 'KeyT' || event.repeat) return;
      event.preventDefault();
      post({ kind: 'fire', event: 'commands.onCommand', args: ['translate-page', null], gesture: true });
    }, true);
  }

  log('bereit', [{ role: ROLE, frameId: FRAME_ID, url: location.href }]);
})();
