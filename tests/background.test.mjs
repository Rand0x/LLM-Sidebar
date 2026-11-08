// Tests for src/background/background.js, src/lib/tabs.js and src/lib/page.js.
// A fake `chrome` API and a mocked fetch (SSE) are installed BEFORE background.js is imported.

import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Fake extension API
// ---------------------------------------------------------------------------

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const callLog = [];
let syncDepth = 0; // > 0 while an event is being dispatched synchronously ("user gesture")
let lastError;
const uncheckedErrors = [];

function makeEvent() {
  const listeners = [];
  return {
    addListener: (fn) => {
      listeners.push(fn);
    },
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    get count() {
      return listeners.length;
    },
    dispatch(...args) {
      syncDepth += 1;
      try {
        return listeners.map((fn) => fn(...args));
      } finally {
        syncDepth -= 1;
      }
    },
  };
}

let lastErrorChecked = false;

// Like Chrome: lastError is only set while the callback runs; unread errors are "unchecked".
function withLastError(message, fn) {
  lastError = message ? { message } : undefined;
  lastErrorChecked = false;
  try {
    fn();
  } finally {
    if (message && !lastErrorChecked) uncheckedErrors.push(message);
    lastError = undefined;
  }
}

const storageData = { local: {}, session: {} };
const storageOnChanged = makeEvent();
let accessLevelCalls = [];

function makeArea(areaName) {
  const data = storageData[areaName];
  return {
    async get(keys) {
      callLog.push(`storage.${areaName}.get`);
      if (keys == null) return clone(data);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) {
        if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = clone(data[k]);
        else if (keys && typeof keys === 'object' && !Array.isArray(keys)) out[k] = keys[k];
      }
      return out;
    },
    async set(items) {
      callLog.push(`storage.${areaName}.set`);
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: clone(data[k]), newValue: clone(v) };
        data[k] = clone(v);
      }
      setTimeout(() => storageOnChanged.dispatch(changes, areaName), 0);
    },
    async remove(keys) {
      callLog.push(`storage.${areaName}.remove`);
      for (const k of typeof keys === 'string' ? [keys] : keys) delete data[k];
    },
    async clear() {
      for (const k of Object.keys(data)) delete data[k];
    },
  };
}

const runtime = {
  id: 'test-extension',
  getURL: (p = '') => `chrome-extension://test-extension/${String(p).replace(/^\/+/, '')}`,
  getManifest: () => ({ version: '1.0.0', action: { default_title: 'LLM Sidebar öffnen' } }),
  onMessage: makeEvent(),
  onConnect: makeEvent(),
  onInstalled: makeEvent(),
  onStartup: makeEvent(),
  async getPlatformInfo() {
    callLog.push('runtime.getPlatformInfo');
    return { os: 'win', arch: 'x86-64' };
  },
  async openOptionsPage() {
    callLog.push('runtime.openOptionsPage');
    optionsOpened += 1;
  },
};
Object.defineProperty(runtime, 'lastError', {
  configurable: true,
  get() {
    lastErrorChecked = true;
    return lastError;
  },
});
let optionsOpened = 0;

const localArea = makeArea('local');
localArea.setAccessLevel = async (opts) => {
  accessLevelCalls.push(clone(opts));
};

const menuItems = new Map();
const menuErrors = [];
let removeAllCalls = 0;
const contextMenus = {
  create(props, cb) {
    callLog.push('contextMenus.create');
    let err = null;
    if (menuItems.has(props.id)) err = `Cannot create item with duplicate id ${props.id}`;
    else if (props.parentId !== undefined && !menuItems.has(props.parentId)) err = `Cannot find menu item with id ${props.parentId}`;
    else menuItems.set(props.id, clone(props));
    if (err) menuErrors.push(err);
    setTimeout(() => {
      if (cb) withLastError(err, cb);
      else if (err) uncheckedErrors.push(err);
    }, 0);
    return props.id;
  },
  removeAll(cb) {
    callLog.push('contextMenus.removeAll');
    removeAllCalls += 1;
    // Asynchronous (like the real browser) so interleaving rebuilds would produce duplicate ids.
    const done = new Promise((resolve) => setTimeout(() => {
      menuItems.clear();
      resolve();
    }, 5));
    if (cb) {
      done.then(() => withLastError(null, cb));
      return undefined;
    }
    return done;
  },
  onClicked: makeEvent(),
};

const panelOpens = [];
let panelBehavior = null;
const sidePanel = {
  open(opts) {
    callLog.push('sidePanel.open');
    const sync = syncDepth > 0;
    panelOpens.push({ opts: clone(opts), sync });
    return sync ? Promise.resolve() : Promise.reject(new Error('`sidePanel.open()` may only be called in response to a user gesture.'));
  },
  setPanelBehavior(behavior) {
    callLog.push('sidePanel.setPanelBehavior');
    panelBehavior = clone(behavior);
    return Promise.resolve();
  },
};

const TAB = { id: 7, windowId: 3, url: 'https://example.com/artikel', title: 'Beispielartikel', active: true };
const RESTRICTED_TAB = { id: 9, windowId: 3, url: 'chrome://extensions/', title: 'Erweiterungen', active: false };
let contentScriptAlive = true; // top frame
const aliveSubFrames = new Set();
const blockedFrames = new Set(); // executeScript fails for these frame ids
let liveSelectionText = ''; // what the content script answers to getSelection
let pageResponder = null; // optional (msg) => response of the content script
const tabMessages = [];
const injections = [];
let executeScriptImpl = null;

const tabs = {
  async query() {
    callLog.push('tabs.query');
    return [clone(TAB)];
  },
  async get(id) {
    if (id === TAB.id) return clone(TAB);
    if (id === RESTRICTED_TAB.id) return clone(RESTRICTED_TAB);
    throw new Error(`No tab with id: ${id}.`);
  },
  async sendMessage(tabId, msg, options = {}) {
    callLog.push('tabs.sendMessage');
    const frameId = options?.frameId ?? 0;
    tabMessages.push({ tabId, msg: clone(msg), frameId });
    const alive = frameId === 0 ? contentScriptAlive : aliveSubFrames.has(frameId);
    if (!alive) throw new Error('Could not establish connection. Receiving end does not exist.');
    if (msg.type === 'getSelection') return { ok: true, text: liveSelectionText };
    if (pageResponder) return pageResponder(msg);
    return { ok: true };
  },
};

const scripting = {
  async executeScript(details) {
    callLog.push('scripting.executeScript');
    injections.push({ target: clone(details.target), files: clone(details.files), func: details.func, args: clone(details.args) });
    if (executeScriptImpl) return executeScriptImpl(details);
    if (details.files) {
      const frameIds = details.target.frameIds ?? [0];
      if (frameIds.some((f) => blockedFrames.has(f))) {
        throw new Error('Cannot access contents of url "about:srcdoc". Extension manifest must request permission to access this host.');
      }
      for (const f of frameIds) {
        if (f === 0) contentScriptAlive = true;
        else aliveSubFrames.add(f);
      }
      return frameIds.map((frameId) => ({ frameId, result: undefined }));
    }
    throw new Error('Kein Testergebnis definiert.');
  },
};

// Toolbar icon state per tab (badge text, colour, title).
const badges = new Map();
const badgeOf = (tabId) => badges.get(tabId) ?? {};
const setBadge = (key) => async (details) => {
  callLog.push(`action.${key}`);
  badges.set(details.tabId, { ...badgeOf(details.tabId), [key]: details[key] });
};

const commands = { onCommand: makeEvent() };
const action = {
  onClicked: makeEvent(),
  setBadgeText: setBadge('text'),
  setBadgeBackgroundColor: setBadge('color'),
  setTitle: setBadge('title'),
};

// The UI language follows the browser (settings.general.language 'auto'): pin it to German so the
// German assertions do not depend on the machine's locale (navigator.language in Node).
const i18n = { getUILanguage: () => 'de' };

globalThis.chrome = {
  runtime,
  i18n,
  storage: { local: localArea, session: makeArea('session'), onChanged: storageOnChanged },
  contextMenus,
  commands,
  action,
  sidePanel,
  tabs,
  scripting,
};

// ---------------------------------------------------------------------------
// Mocked fetch (SSE)
// ---------------------------------------------------------------------------

const API_KEY = 'sk-test-SECRET-KEY-123456';
const enc = new TextEncoder();
const fetchCalls = [];
let fetchHandler = null;

globalThis.fetch = async (url, init = {}) => {
  callLog.push('fetch');
  const call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : null, signal: init.signal };
  fetchCalls.push(call);
  if (!fetchHandler) throw new TypeError('fetch: kein Handler');
  return fetchHandler(call);
};

const sseEvent = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const textChunks = (parts) => [
  { choices: [{ index: 0, delta: { role: 'assistant' } }] },
  ...parts.map((content) => ({ choices: [{ index: 0, delta: { content } }] })),
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
];

function sseResponse(chunks) {
  const events = [...chunks.map(sseEvent), 'data: [DONE]\n\n'];
  return new Response(new ReadableStream({
    pull(controller) {
      const next = events.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(enc.encode(next));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// Sends the first chunks, then stays open until the request is aborted.
function hangingResponse(signal, chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(sseEvent(c)));
      signal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('Aborted', 'AbortError'));
        } catch {
          // already closed
        }
      });
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function requestedSegments(body) {
  const content = body.messages[body.messages.length - 1].content;
  return [...content.matchAll(/^\[\[(\d+)\]\] (.*)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
}

const segmentAnswer = (segments) => sseResponse(textChunks([segments.map((s) => `[[${s.n}]] DE:${s.text}`).join('\n')]));

// ---------------------------------------------------------------------------
// Settings seed + import
// ---------------------------------------------------------------------------

const PROVIDER = {
  id: 'custom-test',
  presetId: 'custom',
  name: 'Testanbieter',
  protocol: 'openai',
  baseUrl: 'https://llm.test/v1',
  apiKey: API_KEY,
  enabled: true,
  models: ['test-model'],
  defaultModel: 'test-model',
  imageApi: 'none',
};

function seedSettings(overrides = {}) {
  storageData.local.settings = clone({ schemaVersion: 1, providers: [PROVIDER], ...overrides });
}
seedSettings();

const { DEFAULT_QUICK_ACTIONS, SUMMARIZE_PAGE_PROMPT, ACTION_SYSTEM_PROMPT } = await import('../src/lib/prompts.js');
await import('../src/background/background.js');
const tabsLib = await import('../src/lib/tabs.js');
const { extractPageContent } = await import('../src/lib/page.js');
const { setLanguage } = await import('../src/lib/i18n.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(condition, { timeout = 3000, interval = 5, message = 'Bedingung nicht erfüllt' } = {}) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error(`waitFor: ${message}`);
    await sleep(interval);
  }
}

const CONTENT_SENDER = { id: 'test-extension', url: TAB.url, tab: clone(TAB), frameId: 0 };
const PANEL_SENDER = { id: 'test-extension', url: 'chrome-extension://test-extension/sidepanel/sidepanel.html' };

function sendMessage(message, sender = CONTENT_SENDER) {
  return new Promise((resolve) => {
    const results = runtime.onMessage.dispatch(clone(message), sender, (response) => resolve(clone(response)));
    if (!results.includes(true)) setTimeout(() => resolve(undefined), 0);
  });
}

function connect(name = 'llm-stream') {
  const posted = [];
  const port = {
    name,
    sender: { id: 'test-extension', tab: clone(TAB) },
    onMessage: makeEvent(),
    onDisconnect: makeEvent(),
    disconnected: false,
    postedAfterDisconnect: 0,
    postMessage(msg) {
      if (port.disconnected) {
        port.postedAfterDisconnect += 1;
        throw new Error('Attempting to use a disconnected port object');
      }
      posted.push(clone(msg));
    },
    disconnect() {
      port.disconnected = true;
    },
  };
  runtime.onConnect.dispatch(port);
  return {
    port,
    posted,
    send: (msg) => port.onMessage.dispatch(clone(msg), port),
    clientDisconnect: () => {
      port.disconnected = true;
      port.onDisconnect.dispatch(port);
    },
  };
}

const isTerminal = (posted) => posted.some((m) => m.type === 'done' || m.type === 'error');
const EXPECTED_MENU_COUNT = 1 + DEFAULT_QUICK_ACTIONS.filter((a) => a.contextMenu && a.id !== 'translate').length + 1 + 1 + 1 + 4;

after(() => {
  delete globalThis.chrome;
});

// ---------------------------------------------------------------------------
// Tests: setup
// ---------------------------------------------------------------------------

test('registers every listener at top level and hardens storage', () => {
  assert.equal(runtime.onMessage.count, 1);
  assert.equal(runtime.onConnect.count, 1);
  assert.equal(runtime.onInstalled.count, 1);
  assert.equal(runtime.onStartup.count, 1);
  assert.equal(contextMenus.onClicked.count, 1);
  assert.equal(commands.onCommand.count, 1);
  assert.equal(action.onClicked.count, 1);
  assert.ok(storageOnChanged.count >= 1);
  assert.deepEqual(accessLevelCalls[0], { accessLevel: 'TRUSTED_CONTEXTS' });
  assert.deepEqual(panelBehavior, { openPanelOnActionClick: true });
});

test('context menu: root plus items built from the quick actions', async () => {
  await waitFor(() => menuItems.size === EXPECTED_MENU_COUNT, { message: 'Menü nicht aufgebaut' });
  await sleep(20);
  const root = menuItems.get('llm-root');
  assert.equal(root.title, 'LLM Sidebar');
  assert.deepEqual(root.contexts, ['selection', 'page', 'editable']);

  const improve = menuItems.get('qa:improve');
  assert.equal(improve.title, '✨ Verbessern');
  assert.equal(improve.parentId, 'llm-root');
  assert.deepEqual(improve.contexts, ['selection']);
  assert.ok(menuItems.has('qa:personalize'));
  assert.equal(menuItems.has('qa:translate'), false, 'translate is covered by "Übersetzen nach …"');

  assert.equal(menuItems.get('translate-selection').title, '🌐 Übersetzen nach Deutsch');
  assert.deepEqual(menuItems.get('ask-selection').contexts, ['selection']);
  assert.equal(menuItems.get('separator-page').type, 'separator');
  for (const id of ['translate-page', 'restore-page', 'summarize-page', 'open-sidebar']) {
    assert.ok(menuItems.get(id).contexts.includes('page'), id);
  }
  // Order: quick actions → translate → ask → separator → page items.
  const ids = [...menuItems.keys()];
  assert.ok(ids.indexOf('qa:improve') < ids.indexOf('translate-selection'));
  assert.ok(ids.indexOf('separator-page') < ids.indexOf('translate-page'));
  assert.deepEqual(menuErrors, []);
  assert.deepEqual(uncheckedErrors, []);
});

test('context menu: rebuild is debounced on settings changes and follows the quick actions', async () => {
  const before = removeAllCalls;
  const actions = [
    { id: 'improve', name: 'Verbessern', icon: '✨', prompt: '', toolbar: true, contextMenu: true },
    { id: 'qa-custom', name: 'Reimen', icon: '🎵', prompt: 'Reime: {{text}}', toolbar: false, contextMenu: true },
    { id: 'qa-hidden', name: 'Versteckt', icon: '🙈', prompt: 'x {{text}}', toolbar: false, contextMenu: false },
    { id: 'translate', name: 'Übersetzen', icon: '🌐', prompt: '', toolbar: true, contextMenu: true },
  ];
  for (let i = 0; i < 4; i++) {
    seedSettings({ quickActions: actions, translate: { targetLang: i === 3 ? 'Englisch' : 'Spanisch' } });
    storageOnChanged.dispatch({ settings: { newValue: clone(storageData.local.settings) } }, 'local');
    await sleep(40);
  }
  await waitFor(() => menuItems.get('translate-selection')?.title === '🌐 Übersetzen nach Englisch', { message: 'kein Rebuild' });
  await sleep(50);
  assert.equal(removeAllCalls - before, 1, 'four quick changes → one rebuild');
  assert.ok(menuItems.has('qa:qa-custom'));
  assert.equal(menuItems.get('qa:qa-custom').title, '🎵 Reimen');
  assert.equal(menuItems.has('qa:qa-hidden'), false);
  assert.equal(menuItems.has('qa:rewrite'), false);

  // A settings change that does not affect the menus does not rebuild them.
  const afterRebuild = removeAllCalls;
  seedSettings({ quickActions: actions, translate: { targetLang: 'Englisch' }, profile: { aboutMe: 'Ich', writingStyle: '' } });
  storageOnChanged.dispatch({ settings: { newValue: clone(storageData.local.settings) } }, 'local');
  await sleep(400);
  assert.equal(removeAllCalls, afterRebuild);
  assert.deepEqual(menuErrors, []);
});

test('context menu: forced rebuilds (startup + update) are serialized without duplicate ids', async () => {
  seedSettings();
  runtime.onStartup.dispatch();
  runtime.onInstalled.dispatch({ reason: 'update', previousVersion: '0.9.0' });
  runtime.onStartup.dispatch();
  await sleep(300);
  await waitFor(() => menuItems.size === EXPECTED_MENU_COUNT && menuItems.get('translate-selection')?.title.endsWith('Deutsch'));
  await sleep(400);
  assert.equal(menuItems.size, EXPECTED_MENU_COUNT);
  assert.deepEqual(menuErrors, []);
  assert.deepEqual(uncheckedErrors, []);
  assert.equal(optionsOpened, 0, 'no onboarding on update');
});

test('UI language: menus and content config follow settings.general.language', async () => {
  seedSettings({ general: { language: 'en' } });
  storageOnChanged.dispatch({ settings: { newValue: clone(storageData.local.settings) } }, 'local');
  try {
    await waitFor(() => menuItems.get('translate-selection')?.title === '🌐 Translate to English', { message: 'no English menu' });
    await sleep(20);
    assert.equal(menuItems.get('llm-root').title, 'LLM Sidebar');
    assert.equal(menuItems.get('ask-selection').title, '💬 Ask in chat');
    assert.equal(menuItems.get('translate-page').title, '🌍 Translate page');
    assert.equal(menuItems.get('restore-page').title, '🔙 Restore original page');
    assert.equal(menuItems.get('summarize-page').title, '📄 Summarize page');
    assert.equal(menuItems.get('open-sidebar').title, '🗂️ Open sidebar');
    // Built-in quick actions that were not renamed follow the UI language.
    assert.equal(menuItems.get('qa:improve').title, '✨ Improve');

    const res = await sendMessage({ type: 'getContentConfig' });
    assert.equal(res.config.uiLanguage, 'en');
    assert.equal(res.config.translate.targetLang, 'en');
    assert.equal(res.config.messages['common.language.auto'], 'Interface language ({language})');

    // An explicit target language is shown in the UI language.
    seedSettings({ general: { language: 'en' }, translate: { targetLang: 'fr' } });
    storageOnChanged.dispatch({ settings: { newValue: clone(storageData.local.settings) } }, 'local');
    await waitFor(() => menuItems.get('translate-selection')?.title === '🌐 Translate to French', { message: 'no rebuild' });
  } finally {
    seedSettings();
    storageOnChanged.dispatch({ settings: { newValue: clone(storageData.local.settings) } }, 'local');
    await waitFor(() => menuItems.get('translate-selection')?.title === '🌐 Übersetzen nach Deutsch', { message: 'not back to German' });
    await sleep(50);
  }
  assert.equal(menuItems.get('ask-selection').title, '💬 Im Chat fragen');
  assert.deepEqual(menuErrors, []);
});

test('summarize page (shortcut): the chat title is prefixed in the UI language', async () => {
  delete storageData.session.pendingChat;
  commands.onCommand.dispatch('summarize-page', clone(TAB));
  await waitFor(() => storageData.session.pendingChat, { message: 'no PendingChat' });
  assert.equal(storageData.session.pendingChat.title, 'Zusammenfassung: Beispielartikel');
  assert.equal(storageData.session.pendingChat.kind, 'send');
  delete storageData.session.pendingChat;
});

test('injectIntoOpenTabs: only loaded web pages, all frames, failures skipped', async () => {
  const originalQuery = tabs.query;
  tabs.query = async () => [
    clone(TAB),
    { id: 11, url: 'https://kaputt.example/', windowId: 3 },
    { id: 12, url: 'http://example.org/', windowId: 3, discarded: true },
    { id: 13, url: 'chrome://settings/', windowId: 3 },
    { id: 14, url: 'https://chromewebstore.google.com/detail/x', windowId: 3 },
    { id: 15, url: '', windowId: 3 },
    { id: 16, url: 'file:///C:/notiz.html', windowId: 3 },
  ];
  executeScriptImpl = (details) => {
    if (details.target.tabId === 11) throw new Error('Frame with ID 0 is showing error page');
    return [{ frameId: 0, result: undefined }];
  };
  injections.length = 0;
  try {
    assert.equal(await tabsLib.injectIntoOpenTabs(), 2);
    assert.deepEqual(injections.map((i) => i.target), [
      { tabId: TAB.id, allFrames: true }, { tabId: 11, allFrames: true }, { tabId: 16, allFrames: true },
    ]);
    assert.ok(injections.every((i) => i.files?.[0] === 'content/content.js'));
    tabs.query = async () => {
      throw new Error('kaputt');
    };
    assert.equal(await tabsLib.injectIntoOpenTabs(), 0);
  } finally {
    tabs.query = originalQuery;
    executeScriptImpl = null;
  }
});

test('onInstalled (install/update): the content script is injected into open web pages (Chrome)', async () => {
  const opened = optionsOpened;
  for (const reason of ['install', 'update']) {
    injections.length = 0;
    runtime.onInstalled.dispatch({ reason });
    await waitFor(() => injections.some((i) => i.target?.allFrames), { message: `keine Injektion bei ${reason}` });
    const inj = injections.find((i) => i.target?.allFrames);
    assert.deepEqual(inj.target, { tabId: TAB.id, allFrames: true });
    assert.deepEqual(inj.files, ['content/content.js']);
  }
  // A browser update reloads the tabs anyway.
  injections.length = 0;
  runtime.onInstalled.dispatch({ reason: 'chrome_update' });
  await sleep(50);
  assert.equal(injections.some((i) => i.target?.allFrames), false);
  await waitFor(() => optionsOpened === opened + 1, { message: 'Onboarding nicht geöffnet' });
  optionsOpened = opened; // the onboarding itself is tested below
  seedSettings();
  await sleep(400); // let the triggered menu syncs settle
});

test('onInstalled (install) saves normalized settings and opens the options page', async () => {
  delete storageData.local.settings;
  runtime.onInstalled.dispatch({ reason: 'install' });
  await waitFor(() => optionsOpened === 1, { message: 'Optionen nicht geöffnet' });
  const saved = storageData.local.settings;
  assert.equal(saved.schemaVersion, 1);
  assert.ok(saved.providers.length >= 11);
  assert.ok(Array.isArray(saved.quickActions) && saved.quickActions.length === DEFAULT_QUICK_ACTIONS.length);
  seedSettings();
  await sleep(400); // let the triggered menu sync settle
});

// ---------------------------------------------------------------------------
// Tests: runtime messages
// ---------------------------------------------------------------------------

test('getContentConfig: key-free config', async () => {
  const res = await sendMessage({ type: 'getContentConfig' });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.config).sort(), ['languages', 'messages', 'quickActions', 'ready', 'showUsage', 'theme', 'toolbar', 'translate', 'uiLanguage']);
  assert.equal(res.config.ready, true);
  assert.equal(res.config.translate.targetLang, 'de'); // 'auto' → the UI language
  assert.equal(res.config.uiLanguage, 'de');
  // The content script cannot load catalogs: its strings (content.*, common.*) come along.
  assert.equal(res.config.messages['common.appName'], 'LLM Sidebar');
  assert.ok(Object.keys(res.config.messages).every((k) => k.startsWith('content.') || k.startsWith('common.')));
  assert.ok(res.config.quickActions.some((a) => a.id === 'improve' && a.icon === '✨'));
  const json = JSON.stringify(res);
  assert.equal(json.includes(API_KEY), false);
  assert.equal(/apiKey|baseUrl|llm\.test/i.test(json), false);
});

test('unknown message types are left to other listeners', () => {
  const results = runtime.onMessage.dispatch({ type: 'somethingElse' }, {}, () => assert.fail('must not respond'));
  assert.deepEqual(results, [false]);
});

test('translateSegments: success (blank segments are skipped)', async () => {
  fetchCalls.length = 0;
  fetchHandler = (call) => segmentAnswer(requestedSegments(call.body));
  const res = await sendMessage({ type: 'translateSegments', segments: ['Hello world', '   ', 'Second line'], lang: 'Deutsch' });
  assert.deepEqual(res, { ok: true, translations: ['DE:Hello world', null, 'DE:Second line'] });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://llm.test/v1/chat/completions');
  assert.equal(fetchCalls[0].body.stream, true);
  assert.equal(fetchCalls[0].body.model, 'test-model');
  const user = fetchCalls[0].body.messages.at(-1).content;
  assert.match(user, /\[\[1\]\] Hello world/);
  assert.match(user, /\[\[2\]\] Second line/);
  assert.match(fetchCalls[0].body.messages[0].content, /Deutsch/);
});

test('translateSegments: more than half missing → split in two and retry each half once', async () => {
  fetchCalls.length = 0;
  fetchHandler = (call) => {
    const segments = requestedSegments(call.body);
    // The full batch only gets one marker back; the halves are answered completely.
    return segmentAnswer(segments.length === 4 ? segments.slice(0, 1) : segments);
  };
  const res = await sendMessage({ type: 'translateSegments', segments: ['A1', 'B2', 'C3', 'D4'] });
  assert.deepEqual(res, { ok: true, translations: ['DE:A1', 'DE:B2', 'DE:C3', 'DE:D4'] });
  assert.equal(fetchCalls.length, 3);
  assert.deepEqual(fetchCalls.slice(1).map((c) => requestedSegments(c.body).map((s) => s.text)), [['A1', 'B2'], ['C3', 'D4']]);
});

test('translateSegments: returns the summed usage of all requests (incl. split retries) with the estimated cost', async () => {
  seedSettings({ providers: [{ ...PROVIDER, modelInfo: { 'test-model': { inputPrice: 1, outputPrice: 2 } } }] });
  fetchCalls.length = 0;
  fetchHandler = (call) => {
    const segments = requestedSegments(call.body);
    const answer = segments.length === 4 ? segments.slice(0, 1) : segments;
    const tokens = segments.length === 4 ? { prompt_tokens: 100, completion_tokens: 10 } : { prompt_tokens: 50, completion_tokens: 5 };
    return sseResponse([
      ...textChunks([answer.map((x) => `[[${x.n}]] DE:${x.text}`).join('\n')]),
      { choices: [], usage: { ...tokens, total_tokens: tokens.prompt_tokens + tokens.completion_tokens } },
    ]);
  };
  try {
    const res = await sendMessage({ type: 'translateSegments', segments: ['A1', 'B2', 'C3', 'D4'], lang: 'de' });
    assert.equal(fetchCalls.length, 3);
    assert.deepEqual(res.translations, ['DE:A1', 'DE:B2', 'DE:C3', 'DE:D4']);
    assert.equal(res.usage.inputTokens, 200);
    assert.equal(res.usage.outputTokens, 20);
    assert.ok(Math.abs(res.usage.cost - (200 * 1 + 20 * 2) / 1e6) < 1e-12);
    assert.equal(res.usage.estimated, true);
  } finally {
    seedSettings();
  }
});

test('llm-stream: done carries the usage of the request', async () => {
  seedSettings({ providers: [{ ...PROVIDER, modelInfo: { 'test-model': { inputPrice: 3, outputPrice: 15 } } }] });
  fetchCalls.length = 0;
  fetchHandler = () => sseResponse([
    ...textChunks(['Hello']),
    { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } },
  ]);
  try {
    const client = connect();
    client.send({ type: 'start', task: { kind: 'translate', text: 'Hallo', lang: 'en' } });
    await waitFor(() => isTerminal(client.posted), { message: 'kein Ende' });
    const done = client.posted.at(-1);
    assert.equal(done.type, 'done');
    assert.deepEqual(done.usage, { inputTokens: 1000, outputTokens: 100, cost: (1000 * 3 + 100 * 15) / 1e6, estimated: true });
  } finally {
    seedSettings();
  }
});

test('translateSegments: halves are not split again; provider errors become German messages', async () => {
  fetchCalls.length = 0;
  fetchHandler = () => sseResponse(textChunks(['Ich kann das nicht übersetzen.']));
  const res = await sendMessage({ type: 'translateSegments', segments: ['A', 'B', 'C', 'D'] });
  assert.deepEqual(res, { ok: true, translations: [null, null, null, null] });
  assert.equal(fetchCalls.length, 3);

  fetchHandler = () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
    status: 401, headers: { 'content-type': 'application/json' },
  });
  const failed = await sendMessage({ type: 'translateSegments', segments: ['A'] });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /API-Schlüssel/);
  assert.equal(failed.error.includes(API_KEY), false);

  const invalid = await sendMessage({ type: 'translateSegments', segments: 'nope' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /Textsegmente/);
});

test('openInChat (Chrome): opens the panel synchronously first, then stores the PendingChat', async () => {
  delete storageData.session.pendingChat;
  callLog.length = 0;
  const promise = sendMessage({
    type: 'openInChat',
    payload: { kind: 'continue', title: 'Verbessern', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] },
  });
  assert.equal(callLog[0], 'sidePanel.open', 'sidePanel.open must be the very first call');
  assert.deepEqual(panelOpens.at(-1), { opts: { tabId: 7 }, sync: true });
  const res = await promise;
  assert.deepEqual(res, { ok: true, opened: true });
  const pending = storageData.session.pendingChat;
  assert.equal(pending.kind, 'continue');
  assert.equal(pending.title, 'Verbessern');
  assert.equal(pending.messages.length, 2);
  assert.equal(pending.windowId, TAB.windowId, 'bound to the window of the sender tab');
  assert.equal(typeof pending.id, 'string');
  assert.ok(pending.id.length >= 8);
  assert.ok(Math.abs(Date.now() - pending.ts) < 5000);
});

test('openInChat from a content script: no auto-send, no page content, seed ends with an answer', async () => {
  delete storageData.session.pendingChat;
  await sendMessage({ type: 'openInChat', payload: { kind: 'send', text: 'Fasse zusammen', includePage: true, windowId: 99 } });
  assert.deepEqual(
    Object.fromEntries(Object.entries(storageData.session.pendingChat).filter(([k]) => !['id', 'ts'].includes(k))),
    { kind: 'prefill', text: 'Fasse zusammen', windowId: TAB.windowId },
  );

  await sendMessage({
    type: 'openInChat',
    payload: {
      kind: 'continue',
      title: 'Verbessern: Text',
      includePage: true,
      messages: [
        { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'system', content: 'x' },
        { role: 'user', content: 'Sende das bitte sofort' }, 'kaputt',
      ],
    },
  });
  const pending = storageData.session.pendingChat;
  assert.equal(pending.kind, 'continue');
  assert.equal(pending.title, 'Verbessern: Text');
  assert.equal('includePage' in pending, false);
  assert.deepEqual(pending.messages, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
});

test('openInChat from a content script: a prefill quote is sanitized and remembers its frame', async () => {
  delete storageData.session.pendingChat;
  const long = 'x'.repeat(25000);
  await sendMessage({
    type: 'openInChat',
    payload: { kind: 'prefill', quote: { text: `  ${long}  `, title: '  Titel  ', url: 'javascript:alert(1)', extra: 1 } },
  }, { ...CONTENT_SENDER, frameId: 4 });
  const pending = storageData.session.pendingChat;
  assert.equal(pending.kind, 'prefill');
  assert.equal(pending.quote.text.length, 20000);
  assert.equal(pending.quote.truncated, true);
  assert.equal(pending.quote.title, 'Titel');
  assert.equal(pending.quote.url, '', 'only http(s) URLs');
  assert.equal('extra' in pending.quote, false);
  assert.deepEqual(pending.source, { tabId: TAB.id, frameId: 4 });

  // No text, no quote; a "continue" payload never carries one.
  await sendMessage({ type: 'openInChat', payload: { kind: 'prefill', quote: { text: '   ' } } });
  assert.equal('quote' in storageData.session.pendingChat, false);
  assert.equal('source' in storageData.session.pendingChat, false);
  await sendMessage({
    type: 'openInChat',
    payload: { kind: 'continue', quote: { text: 'Zitat' }, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] },
  });
  assert.equal('quote' in storageData.session.pendingChat, false);
});

test('pageSelection reports from content scripts are left to the side panel (no response)', async () => {
  const responses = [];
  const results = runtime.onMessage.dispatch({ type: 'pageSelection', text: 'Hallo' }, CONTENT_SENDER, (r) => responses.push(r));
  assert.ok(results.every((r) => r !== true), 'no async response announced');
  await sleep(20);
  assert.deepEqual(responses, []);
});

test('openInChat (Firefox): opened reflects whether the sidebar of that window is open', async () => {
  const savedPanel = globalThis.chrome.sidePanel;
  const sidebarCalls = [];
  let sidebarOpen = false;
  delete globalThis.chrome.sidePanel;
  globalThis.chrome.sidebarAction = {
    open: () => {
      sidebarCalls.push('open');
      return Promise.resolve();
    },
    toggle: () => {
      sidebarCalls.push(syncDepth > 0 ? 'toggle-sync' : 'toggle-async');
      return Promise.resolve();
    },
    isOpen: (details) => {
      sidebarCalls.push(`isOpen:${details?.windowId}`);
      return Promise.resolve(sidebarOpen);
    },
  };
  try {
    delete storageData.session.pendingChat;
    const res = await sendMessage({ type: 'openInChat', payload: { kind: 'prefill', text: 'Hallo' } });
    assert.deepEqual(res, { ok: true, opened: false });
    assert.equal(storageData.session.pendingChat.text, 'Hallo');
    assert.equal(storageData.session.pendingChat.windowId, TAB.windowId);
    assert.deepEqual(sidebarCalls, ['isOpen:3'], 'never opens (no user action), only asks');

    // Already open: the sidebar claims the PendingChat itself → opened:true (no "click the icon" hint).
    sidebarOpen = true;
    assert.deepEqual(await sendMessage({ type: 'openInChat', payload: { kind: 'prefill', text: 'Noch mal' } }), { ok: true, opened: true });
    sidebarCalls.length = 0;

    // Toolbar click toggles the sidebar synchronously.
    action.onClicked.dispatch(clone(TAB));
    assert.deepEqual(sidebarCalls, ['toggle-sync']);

    // Context menu "Seitenleiste öffnen" → sidebarAction.open() inside the handler.
    contextMenus.onClicked.dispatch({ menuItemId: 'open-sidebar', pageUrl: TAB.url }, clone(TAB));
    assert.deepEqual(sidebarCalls, ['toggle-sync', 'open']);

    // Without isOpen (older Firefox): opened:false.
    delete globalThis.chrome.sidebarAction.isOpen;
    assert.deepEqual(await sendMessage({ type: 'openInChat', payload: { kind: 'prefill', text: 'x' } }), { ok: true, opened: false });
  } finally {
    delete globalThis.chrome.sidebarAction;
    globalThis.chrome.sidePanel = savedPanel;
  }
});

// ---------------------------------------------------------------------------
// Tests: claimPendingChat
// ---------------------------------------------------------------------------

const claim = (windowId, sender = PANEL_SENDER) => sendMessage({ type: 'claimPendingChat', windowId }, sender);
const storedPending = (props) => {
  storageData.session.pendingChat = { id: `p-${Math.random()}`, ts: Date.now(), kind: 'prefill', text: 'Hallo', ...props };
  return clone(storageData.session.pendingChat);
};

test('claimPendingChat: only the panel of the same window gets it, exactly once', async () => {
  const entry = storedPending({ windowId: 3 });
  assert.deepEqual(await claim(5), { ok: true, pending: null });
  assert.deepEqual(storageData.session.pendingChat, entry, 'other windows leave it in place');
  assert.deepEqual(await claim(undefined), { ok: true, pending: null });

  const [first, second] = await Promise.all([claim(3), claim(3)]);
  assert.deepEqual(first, { ok: true, pending: entry });
  assert.deepEqual(second, { ok: true, pending: null });
  assert.equal(storageData.session.pendingChat, undefined, 'removed on claim');
  assert.deepEqual(await claim(3), { ok: true, pending: null });

  // Without a window id (unknown origin) any panel may take it.
  const free = storedPending({});
  assert.deepEqual(await claim(8), { ok: true, pending: free });
});

test('claimPendingChat: expired entries are dropped (send after 10 min, prefill/continue after 24 h)', async () => {
  const MIN = 60 * 1000;
  storedPending({ kind: 'send', ts: Date.now() - 11 * MIN, windowId: 3 });
  assert.deepEqual(await claim(3), { ok: true, pending: null });
  assert.equal(storageData.session.pendingChat, undefined);

  const send = storedPending({ kind: 'send', ts: Date.now() - 9 * MIN, windowId: 3 });
  assert.deepEqual(await claim(3), { ok: true, pending: send });

  const prefill = storedPending({ kind: 'prefill', ts: Date.now() - 23 * 60 * MIN });
  assert.deepEqual(await claim(3), { ok: true, pending: prefill });
  storedPending({ kind: 'continue', ts: Date.now() - 25 * 60 * MIN, windowId: 1 });
  assert.deepEqual(await claim(3), { ok: true, pending: null });
  assert.equal(storageData.session.pendingChat, undefined, 'expired entries of other windows are removed too');
});

test('claimPendingChat: content scripts may not claim', async () => {
  const entry = storedPending({ windowId: 3 });
  const res = await claim(3, CONTENT_SENDER);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'not_allowed');
  assert.deepEqual(storageData.session.pendingChat, entry);
  // An extension page open in a tab (sender.tab set) is still trusted.
  assert.deepEqual(await claim(3, { ...PANEL_SENDER, tab: clone(TAB) }), { ok: true, pending: entry });
});

test('disableToolbarOnHost: content scripts can only hide their own site; openOptions opens the options page', async () => {
  seedSettings();
  // Content script: the host comes from the sender, never from the message.
  assert.deepEqual(await sendMessage({ type: 'disableToolbarOnHost', host: 'com' }), { ok: true });
  assert.deepEqual(storageData.local.settings.toolbar.disabledHosts, ['example.com']);
  const frameSender = { ...CONTENT_SENDER, url: 'https://Widget.Example.NET/frame?x=1', frameId: 4 };
  assert.deepEqual(await sendMessage({ type: 'disableToolbarOnHost', host: 'widget.example.net' }, frameSender), { ok: true });
  assert.deepEqual(await sendMessage({ type: 'disableToolbarOnHost' }, frameSender), { ok: true });
  assert.deepEqual(storageData.local.settings.toolbar.disabledHosts, ['example.com', 'widget.example.net']);
  // Extension pages may name the host (normalized, once).
  assert.deepEqual(await sendMessage({ type: 'disableToolbarOnHost', host: 'News.Example.ORG' }, PANEL_SENDER), { ok: true });
  assert.deepEqual(await sendMessage({ type: 'disableToolbarOnHost', host: 'news.example.org' }, PANEL_SENDER), { ok: true });
  assert.deepEqual(storageData.local.settings.toolbar.disabledHosts, ['example.com', 'widget.example.net', 'news.example.org']);
  const invalid = await sendMessage({ type: 'disableToolbarOnHost' }, PANEL_SENDER);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'bad_request');

  const opened = optionsOpened;
  assert.deepEqual(await sendMessage({ type: 'openOptions' }), { ok: true });
  assert.equal(optionsOpened, opened + 1);
  seedSettings();
  await sleep(400);
});

// ---------------------------------------------------------------------------
// Tests: port 'llm-stream'
// ---------------------------------------------------------------------------

test('llm-stream: meta → deltas → done', async () => {
  fetchCalls.length = 0;
  fetchHandler = () => sseResponse(textChunks(['Hallo', ' Welt', '!']));
  const client = connect();
  client.send({ type: 'start', task: { kind: 'action', actionId: 'improve', text: 'hallo welt', page: { title: 'Seite', url: 'https://example.com/' } } });
  await waitFor(() => isTerminal(client.posted), { message: 'kein Ende' });

  assert.deepEqual(client.posted[0], { type: 'meta', provider: 'Testanbieter', model: 'test-model' });
  const deltas = client.posted.filter((m) => m.type === 'delta');
  assert.ok(deltas.length >= 2, 'incremental deltas');
  assert.equal(deltas.map((m) => m.delta).join(''), 'Hallo Welt!');
  assert.deepEqual(client.posted.at(-1), { type: 'done', text: 'Hallo Welt!', finishReason: 'stop' });

  const { body, init } = fetchCalls[0];
  assert.equal(body.stream, true);
  assert.equal(body.model, 'test-model');
  assert.ok(body.messages[0].content.startsWith(ACTION_SYSTEM_PROMPT));
  assert.match(body.messages.map((m) => m.content).join('\n'), /https:\/\/example\.com\//, 'page context is part of the request');
  assert.match(body.messages.at(-1).content, /hallo welt/);
  assert.equal(init.headers.get('authorization'), `Bearer ${API_KEY}`);
});

test('llm-stream: translate task uses the requested language', async () => {
  fetchCalls.length = 0;
  fetchHandler = () => sseResponse(textChunks(['Bonjour']));
  const client = connect();
  client.send({ type: 'start', task: { kind: 'translate', text: 'Guten Tag', lang: 'Französisch' } });
  await waitFor(() => isTerminal(client.posted));
  assert.deepEqual(client.posted.at(-1), { type: 'done', text: 'Bonjour', finishReason: 'stop' });
  assert.match(fetchCalls[0].body.messages.at(-1).content, /Französisch/);
  assert.match(fetchCalls[0].body.messages.at(-1).content, /Guten Tag/);
});

test('llm-stream: translation refinements keep instruction, previous answer and page (also without a translate action)', async () => {
  const refine = async (task, settings) => {
    seedSettings(settings);
    fetchCalls.length = 0;
    fetchHandler = () => sseResponse(textChunks(['Salut']));
    const client = connect();
    client.send({ type: 'start', task });
    await waitFor(() => isTerminal(client.posted));
    assert.equal(client.posted.at(-1).type, 'done');
    return fetchCalls[0].body.messages;
  };
  const task = {
    kind: 'translate', text: 'Guten Tag', lang: 'Französisch', instruction: 'förmlicher', previous: 'Salut',
    page: { title: 'Seite', url: 'https://example.com/' },
  };
  // The user deleted the "Übersetzen" quick action: the built-in prompt is used.
  const withoutAction = await refine(task, { quickActions: DEFAULT_QUICK_ACTIONS.filter((a) => a.id !== 'translate') });
  assert.equal(withoutAction.length, 4); // system, user, assistant (previous), user (instruction)
  assert.ok(withoutAction[0].content.startsWith(ACTION_SYSTEM_PROMPT));
  assert.match(`${withoutAction[0].content}\n${withoutAction[1].content}`, /https:\/\/example\.com\//, 'page context');
  assert.match(withoutAction[1].content, /Französisch/);
  assert.match(withoutAction[1].content, /Guten Tag/);
  assert.deepEqual(withoutAction[2], { role: 'assistant', content: 'Salut' });
  assert.match(withoutAction[3].content, /förmlicher/);

  // A customized translate action is honoured; an old-style refinement (action 'translate') works too.
  const custom = DEFAULT_QUICK_ACTIONS.map((a) => (a.id === 'translate' ? { ...a, prompt: 'Eigene Übersetzung nach {{lang}}: {{text}}' } : a));
  const viaAction = await refine({ ...task, kind: 'action', actionId: 'translate' }, { quickActions: custom });
  assert.ok(viaAction[1].content.endsWith('Eigene Übersetzung nach Französisch: Guten Tag'), viaAction[1].content);
  assert.match(viaAction[3].content, /förmlicher/);
  seedSettings();
});

test('llm-stream: always streams and never sends the chat length limit', async () => {
  seedSettings({ general: { streaming: false }, chat: { maxTokens: 300 } });
  fetchCalls.length = 0;
  fetchHandler = (call) => (call.body.messages.at(-1).content.includes('[[1]]')
    ? segmentAnswer(requestedSegments(call.body))
    : sseResponse(textChunks(['Fertig.'])));
  const client = connect();
  client.send({ type: 'start', task: { kind: 'action', actionId: 'grammar', text: 'Tex' } });
  await waitFor(() => isTerminal(client.posted));
  assert.deepEqual(client.posted.at(-1), { type: 'done', text: 'Fertig.', finishReason: 'stop' });
  const seg = await sendMessage({ type: 'translateSegments', segments: ['Hello'] });
  assert.deepEqual(seg, { ok: true, translations: ['DE:Hello'] });
  assert.equal(fetchCalls.length, 2);
  for (const { body } of fetchCalls) {
    assert.equal(body.stream, true);
    assert.equal('max_tokens' in body, false);
    assert.equal('max_completion_tokens' in body, false);
  }
  seedSettings();
});

test('llm-stream: done carries the finish reason (truncated / refused answers)', async () => {
  fetchHandler = () => sseResponse([
    { choices: [{ index: 0, delta: { content: 'Halber Te' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
  ]);
  const a = connect();
  a.send({ type: 'start', task: { kind: 'action', actionId: 'improve', text: 'Langer Text' } });
  await waitFor(() => isTerminal(a.posted));
  assert.deepEqual(a.posted.at(-1), { type: 'done', text: 'Halber Te', finishReason: 'length' });

  fetchHandler = () => sseResponse([{ choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }]);
  const b = connect();
  b.send({ type: 'start', task: { kind: 'action', actionId: 'improve', text: 'Text' } });
  await waitFor(() => isTerminal(b.posted));
  const last = b.posted.at(-1);
  // Either a done with the reason (the client shows a note) or – without any text – a refusal error.
  if (last.type === 'done') assert.equal(last.finishReason, 'content_filter');
  else assert.deepEqual([last.type, last.code], ['error', 'refusal']);
});

test('llm-stream: no ready provider → no_provider error, no request', async () => {
  seedSettings({ providers: [{ ...PROVIDER, enabled: false }] });
  fetchCalls.length = 0;
  const client = connect();
  client.send({ type: 'start', task: { kind: 'action', actionId: 'improve', text: 'Text' } });
  await waitFor(() => isTerminal(client.posted));
  assert.equal(client.posted.length, 1);
  assert.equal(client.posted[0].type, 'error');
  assert.equal(client.posted[0].code, 'no_provider');
  assert.match(client.posted[0].error, /Einstellungen/);
  assert.match(client.posted[0].error, /API-Schlüssel/);
  assert.equal(fetchCalls.length, 0);

  const seg = await sendMessage({ type: 'translateSegments', segments: ['Hello'] });
  assert.equal(seg.ok, false);
  assert.equal(seg.code, 'no_provider');
  const config = await sendMessage({ type: 'getContentConfig' });
  assert.equal(config.config.ready, false);
  seedSettings();
});

test('llm-stream: unknown quick action and empty text are reported', async () => {
  const a = connect();
  a.send({ type: 'start', task: { kind: 'action', actionId: 'does-not-exist', text: 'Text' } });
  await waitFor(() => isTerminal(a.posted));
  assert.equal(a.posted.at(-1).type, 'error');
  assert.equal(a.posted.at(-1).code, 'unknown_action');
  assert.match(a.posted.at(-1).error, /Schnellaktion/);

  const b = connect();
  b.send({ type: 'start', task: { kind: 'action', actionId: 'improve', text: '   ' } });
  await waitFor(() => isTerminal(b.posted));
  assert.equal(b.posted.at(-1).code, 'no_text');
});

test('llm-stream: provider errors are posted as German error messages', async () => {
  fetchHandler = () => new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), {
    status: 429, headers: { 'content-type': 'application/json' },
  });
  const client = connect();
  client.send({ type: 'start', task: { kind: 'action', actionId: 'improve', text: 'Text' } });
  await waitFor(() => isTerminal(client.posted));
  const last = client.posted.at(-1);
  assert.equal(last.type, 'error');
  assert.equal(last.code, 'rate_limit');
  assert.match(last.error, /Zu viele Anfragen/);
});

test('llm-stream: client disconnect aborts the fetch and nothing is posted afterwards', async () => {
  fetchCalls.length = 0;
  fetchHandler = (call) => hangingResponse(call.signal, textChunks(['Teil']).slice(0, 2));
  const client = connect();
  client.send({ type: 'start', task: { kind: 'action', actionId: 'improve', text: 'Langer Text' } });
  await waitFor(() => client.posted.some((m) => m.type === 'delta'), { message: 'kein Delta' });
  const signal = fetchCalls[0].signal;
  assert.equal(signal.aborted, false);
  const countBefore = client.posted.length;
  client.clientDisconnect();
  assert.equal(signal.aborted, true);
  await sleep(50);
  assert.equal(client.port.postedAfterDisconnect, 0);
  assert.equal(client.posted.length, countBefore);
});

test('llm-stream: abort message aborts the request without further messages', async () => {
  fetchCalls.length = 0;
  fetchHandler = (call) => hangingResponse(call.signal, textChunks(['Teil']).slice(0, 2));
  const client = connect();
  client.send({ type: 'start', task: { kind: 'translate', text: 'Langer Text' } });
  await waitFor(() => client.posted.some((m) => m.type === 'delta'));
  client.send({ type: 'abort' });
  assert.equal(fetchCalls[0].signal.aborted, true);
  const count = client.posted.length;
  await sleep(50);
  assert.equal(client.posted.length, count);
  assert.equal(isTerminal(client.posted), false);
});

// ---------------------------------------------------------------------------
// Tests: context menu clicks and commands
// ---------------------------------------------------------------------------

test('context menu "Seite zusammenfassen": sidePanel.open runs synchronously before any async work', async () => {
  delete storageData.session.pendingChat;
  callLog.length = 0;
  contextMenus.onClicked.dispatch({ menuItemId: 'summarize-page', pageUrl: TAB.url }, clone(TAB));
  // Still inside the same tick: the panel must already have been requested, before anything else.
  assert.equal(callLog[0], 'sidePanel.open');
  assert.ok(callLog.every((c, i) => i === 0 || !c.startsWith('sidePanel')));
  assert.deepEqual(panelOpens.at(-1), { opts: { tabId: 7 }, sync: true });

  await waitFor(() => storageData.session.pendingChat);
  assert.ok(callLog.indexOf('sidePanel.open') < callLog.indexOf('storage.session.set'));
  const pending = storageData.session.pendingChat;
  assert.equal(pending.kind, 'send');
  assert.equal(pending.text, SUMMARIZE_PAGE_PROMPT);
  assert.equal(pending.includePage, true);
  assert.equal(pending.title, 'Zusammenfassung: Beispielartikel');
  assert.equal(pending.windowId, TAB.windowId);
  assert.equal(typeof pending.id, 'string');
  assert.equal(typeof pending.ts, 'number');
});

test('context menu "Im Chat fragen": panel first, then the selection as reference (quote)', async () => {
  delete storageData.session.pendingChat;
  callLog.length = 0;
  const tab = { ...TAB, url: 'https://example.com/artikel?token=geheim#x' };
  contextMenus.onClicked.dispatch({ menuItemId: 'ask-selection', selectionText: 'Zeile eins\nZeile zwei', frameId: 0 }, clone(tab));
  assert.equal(callLog[0], 'sidePanel.open');
  assert.deepEqual(panelOpens.at(-1), { opts: { tabId: 7 }, sync: true });
  await waitFor(() => storageData.session.pendingChat);
  const pending = storageData.session.pendingChat;
  assert.equal(pending.kind, 'prefill');
  assert.equal(pending.text, '');
  assert.deepEqual(pending.quote, { text: 'Zeile eins\nZeile zwei', title: 'Beispielartikel', url: 'https://example.com/artikel' }, 'URL without query/fragment');
  assert.deepEqual(pending.source, { tabId: TAB.id, frameId: 0 });
  assert.equal(pending.windowId, TAB.windowId);
});

test('context menu "Im Chat fragen" without selection: empty prefill, no quote', async () => {
  delete storageData.session.pendingChat;
  contextMenus.onClicked.dispatch({ menuItemId: 'ask-selection', selectionText: '   ' }, clone(TAB));
  await waitFor(() => storageData.session.pendingChat);
  assert.equal(storageData.session.pendingChat.text, '');
  assert.equal('quote' in storageData.session.pendingChat, false);
  assert.equal('source' in storageData.session.pendingChat, false);
});

test('context menu "Im Chat fragen": the live selection of the frame keeps its line breaks', async () => {
  const ask = async (info, live) => {
    delete storageData.session.pendingChat;
    tabMessages.length = 0;
    liveSelectionText = live;
    contextMenus.onClicked.dispatch({ menuItemId: 'ask-selection', ...info }, clone(TAB));
    await waitFor(() => storageData.session.pendingChat);
    return storageData.session.pendingChat.quote?.text;
  };
  aliveSubFrames.add(4);
  try {
    // Chrome collapses line breaks in selectionText.
    assert.equal(await ask({ selectionText: 'Absatz eins Absatz zwei', frameId: 4 }, 'Absatz eins\n\nAbsatz zwei'), 'Absatz eins\n\nAbsatz zwei');
    assert.deepEqual(tabMessages.map((m) => [m.msg.type, m.frameId]), [['getSelection', 4]]);
    // A different live selection is not used.
    assert.equal(await ask({ selectionText: 'Absatz eins' }, 'Ganz anderer Text'), 'Absatz eins');
    // No content script: falls back to selectionText, nothing is injected for this.
    contentScriptAlive = false;
    injections.length = 0;
    assert.equal(await ask({ selectionText: 'Nur so' }, 'Nur\nso'), 'Nur so');
    assert.deepEqual(injections, []);
  } finally {
    contentScriptAlive = true;
    aliveSubFrames.clear();
    liveSelectionText = '';
  }
});

test('context menu quick action → content script injected if needed, then runAction', async () => {
  tabMessages.length = 0;
  injections.length = 0;
  contentScriptAlive = false;
  const opens = panelOpens.length;
  contextMenus.onClicked.dispatch({ menuItemId: 'qa:improve', selectionText: 'Ein Txt' }, clone(TAB));
  await waitFor(() => tabMessages.some((m) => m.msg.type === 'runAction'), { message: 'kein runAction' });
  assert.equal(panelOpens.length, opens, 'quick actions do not open the panel');
  assert.deepEqual(injections.map((i) => i.files), [['content/content.js']]);
  assert.deepEqual(injections[0].target, { tabId: 7, frameIds: [0] });
  assert.equal(tabMessages[0].msg.type, 'ping');
  assert.deepEqual(tabMessages.at(-1), { tabId: 7, msg: { type: 'runAction', actionId: 'improve', text: 'Ein Txt' }, frameId: 0 });

  tabMessages.length = 0;
  contextMenus.onClicked.dispatch({ menuItemId: 'translate-selection', selectionText: 'Hello' }, clone(TAB));
  await waitFor(() => tabMessages.some((m) => m.msg.type === 'translateSelection'));
  assert.deepEqual(tabMessages.at(-1).msg, { type: 'translateSelection', text: 'Hello' });
  assert.equal(injections.length, 1, 'no second injection when the ping answers');

  tabMessages.length = 0;
  contextMenus.onClicked.dispatch({ menuItemId: 'restore-page' }, clone(TAB));
  await waitFor(() => tabMessages.some((m) => m.msg.type === 'restorePage'));
});

test('context menu actions go to the frame holding the selection; page actions to the top frame', async () => {
  tabMessages.length = 0;
  injections.length = 0;
  contextMenus.onClicked.dispatch({ menuItemId: 'qa:improve', selectionText: 'Im Editor', frameId: 4 }, clone(TAB));
  await waitFor(() => tabMessages.some((m) => m.msg.type === 'runAction'));
  assert.deepEqual(injections.map((i) => i.target), [{ tabId: 7, frameIds: [4] }]);
  assert.ok(tabMessages.every((m) => m.frameId === 4));
  assert.deepEqual(tabMessages.at(-1).msg, { type: 'runAction', actionId: 'improve', text: 'Im Editor' });

  tabMessages.length = 0;
  contextMenus.onClicked.dispatch({ menuItemId: 'translate-selection', selectionText: 'Hi', frameId: 4 }, clone(TAB));
  contextMenus.onClicked.dispatch({ menuItemId: 'translate-page', frameId: 4 }, clone(TAB));
  await waitFor(() => tabMessages.some((m) => m.msg.type === 'translateSelection') && tabMessages.some((m) => m.msg.type === 'translatePage'));
  assert.equal(tabMessages.find((m) => m.msg.type === 'translateSelection').frameId, 4);
  assert.equal(tabMessages.find((m) => m.msg.type === 'translatePage').frameId, 0);

  // A frame the extension cannot script: the top frame shows the result instead, no error badge.
  tabMessages.length = 0;
  blockedFrames.add(6);
  badges.clear();
  try {
    contextMenus.onClicked.dispatch({ menuItemId: 'qa:improve', selectionText: 'Gesperrt', frameId: 6 }, clone(TAB));
    await waitFor(() => tabMessages.some((m) => m.msg.type === 'runAction'));
    assert.equal(tabMessages.at(-1).frameId, 0);
    await sleep(10);
    assert.equal(badgeOf(TAB.id).text, undefined);

    // A frame too small to show the result hands the action to the top frame.
    tabMessages.length = 0;
    aliveSubFrames.add(5);
    pageResponder = (msg) => (msg.type === 'runAction'
      ? { ok: false, code: 'tiny_frame', error: 'Dieser Seitenbereich ist zu klein, um das Ergebnis anzuzeigen.' }
      : { ok: true });
    contextMenus.onClicked.dispatch({ menuItemId: 'qa:improve', selectionText: 'Winzig', frameId: 5 }, clone(TAB));
    await waitFor(() => tabMessages.filter((m) => m.msg.type === 'runAction').length === 2, { message: 'kein Rückfall auf das Hauptdokument' });
    assert.deepEqual(tabMessages.filter((m) => m.msg.type === 'runAction').map((m) => m.frameId), [5, 0]);
  } finally {
    pageResponder = null;
    blockedFrames.clear();
    aliveSubFrames.clear();
  }
});

test('restricted pages: nothing is sent or injected; the toolbar icon shows why for 10 s', async () => {
  tabMessages.length = 0;
  injections.length = 0;
  badges.clear();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    contextMenus.onClicked.dispatch({ menuItemId: 'qa:improve', selectionText: 'x' }, clone(RESTRICTED_TAB));
    commands.onCommand.dispatch('translate-page', clone(RESTRICTED_TAB));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.deepEqual(badgeOf(RESTRICTED_TAB.id), {
      color: '#e5484d',
      text: '!',
      title: 'LLM Sidebar – Auf dieser Seite dürfen Erweiterungen nicht ausgeführt werden.',
    });
    mock.timers.tick(9000);
    assert.equal(badgeOf(RESTRICTED_TAB.id).text, '!');
    mock.timers.tick(1000);
    assert.equal(badgeOf(RESTRICTED_TAB.id).text, '');
    assert.equal(badgeOf(RESTRICTED_TAB.id).title, 'LLM Sidebar öffnen');
  } finally {
    mock.timers.reset();
  }
  await sleep(20);
  assert.deepEqual(tabMessages, []);
  assert.deepEqual(injections, []);
  assert.equal(badges.has(TAB.id), false);
});

test('failed page actions show a badge; errors the page shows itself and later successes clear it', async () => {
  badges.clear();
  contentScriptAlive = false;
  executeScriptImpl = () => {
    throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
  };
  try {
    commands.onCommand.dispatch('translate-page', clone(TAB));
    await waitFor(() => badgeOf(TAB.id).text === '!', { message: 'kein Badge' });
    assert.match(badgeOf(TAB.id).title, /^LLM Sidebar – Die Erweiterung hat keinen Zugriff auf diese Seite\./);
  } finally {
    executeScriptImpl = null;
    contentScriptAlive = true;
  }
  // Success on the same tab → notice cleared right away.
  commands.onCommand.dispatch('translate-page', clone(TAB));
  await waitFor(() => badgeOf(TAB.id).text === '', { message: 'Badge nicht entfernt' });
  assert.equal(badgeOf(TAB.id).title, 'LLM Sidebar öffnen');

  // The content script answers with an error (and shows it on the page): no badge.
  badges.clear();
  tabMessages.length = 0;
  pageResponder = (msg) => (msg.type === 'runAction' ? { ok: false, error: 'Es ist kein Text markiert.' } : { ok: true });
  try {
    contextMenus.onClicked.dispatch({ menuItemId: 'qa:improve', selectionText: 'x' }, clone(TAB));
    await waitFor(() => tabMessages.some((m) => m.msg.type === 'runAction'));
    await sleep(20);
    assert.equal(badges.has(TAB.id), false);
  } finally {
    pageResponder = null;
  }

  // Without the action badge API nothing throws.
  const saved = { ...action };
  delete action.setBadgeText;
  delete action.setBadgeBackgroundColor;
  delete action.setTitle;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const before = callLog.length;
    commands.onCommand.dispatch('translate-page', clone(RESTRICTED_TAB));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    mock.timers.tick(10000);
    assert.equal(callLog.slice(before).some((c) => c.startsWith('action.')), false);
  } finally {
    mock.timers.reset();
    Object.assign(action, saved);
  }
});

test('commands: translate-page goes to the given (or active) tab', async () => {
  tabMessages.length = 0;
  commands.onCommand.dispatch('translate-page', clone(TAB));
  await waitFor(() => tabMessages.some((m) => m.msg.type === 'translatePage'));
  tabMessages.length = 0;
  commands.onCommand.dispatch('translate-page');
  await waitFor(() => tabMessages.some((m) => m.msg.type === 'translatePage'), { message: 'kein Fallback auf aktiven Tab' });
  assert.equal(tabMessages.at(-1).tabId, 7);
});

// ---------------------------------------------------------------------------
// Tests: lib/tabs.js and lib/page.js
// ---------------------------------------------------------------------------

test('tabs.getActiveTab / sendToTab error mapping', async () => {
  assert.deepEqual(await tabsLib.getActiveTab(), { id: 7, url: TAB.url, title: TAB.title, windowId: 3 });
  await assert.rejects(tabsLib.sendToTab(RESTRICTED_TAB.id, { type: 'translatePage' }), {
    message: 'Auf dieser Seite dürfen Erweiterungen nicht ausgeführt werden.',
  });
  assert.equal(await tabsLib.ensureContentScript(RESTRICTED_TAB.id), false);

  contentScriptAlive = false;
  executeScriptImpl = () => {
    throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
  };
  try {
    await assert.rejects(tabsLib.sendToTab(TAB.id, { type: 'translatePage' }), /keinen Zugriff/);
    // With access to all websites granted, a host-permission error means a privileged page
    // (Firefox: about:newtab has no visible URL) – asking for permissions would not help.
    globalThis.chrome.permissions = { contains: async (p) => JSON.stringify(p) === JSON.stringify({ origins: ['<all_urls>'] }) };
    await assert.rejects(tabsLib.sendToTab(TAB.id, { type: 'translatePage' }), { message: 'Auf dieser Seite dürfen Erweiterungen nicht ausgeführt werden.' });
    globalThis.chrome.permissions = { contains: async () => false };
    await assert.rejects(tabsLib.sendToTab(TAB.id, { type: 'translatePage' }), /keinen Zugriff/);
  } finally {
    delete globalThis.chrome.permissions;
    executeScriptImpl = null;
    contentScriptAlive = true;
  }
  assert.equal(await tabsLib.ensureContentScript(TAB.id), true);

  // Errors reported by the content script keep its message and are marked as such.
  pageResponder = (msg) => (msg.type === 'ping' ? { ok: true } : { ok: false, error: 'Es ist kein Text markiert.' });
  try {
    await assert.rejects(tabsLib.sendToTab(TAB.id, { type: 'runAction' }), { message: 'Es ist kein Text markiert.', code: 'page_error' });
  } finally {
    pageResponder = null;
  }
});

test('tabs: frame-aware sendToTab / ensureContentScript and tryMessageTab', async () => {
  tabMessages.length = 0;
  injections.length = 0;
  try {
    assert.equal(await tabsLib.ensureContentScript(TAB.id, { frameId: 3 }), true);
    assert.deepEqual(injections.map((i) => i.target), [{ tabId: 7, frameIds: [3] }]);
    assert.deepEqual(await tabsLib.sendToTab(TAB.id, { type: 'runAction' }, { frameId: 3 }), { ok: true });
    assert.ok(tabMessages.every((m) => m.frameId === 3));
    // Invalid frame ids fall back to the top frame.
    tabMessages.length = 0;
    await tabsLib.sendToTab(TAB.id, { type: 'ping' }, { frameId: -1 });
    assert.ok(tabMessages.every((m) => m.frameId === 0));

    // tryMessageTab never injects and never throws.
    injections.length = 0;
    liveSelectionText = 'Auswahl';
    assert.deepEqual(await tabsLib.tryMessageTab(TAB.id, { type: 'getSelection' }, { frameId: 3 }), { ok: true, text: 'Auswahl' });
    assert.equal(await tabsLib.tryMessageTab(TAB.id, { type: 'getSelection' }, { frameId: 8 }), null);
    assert.equal(await tabsLib.tryMessageTab(-1, { type: 'ping' }), null);
    assert.deepEqual(injections, []);
  } finally {
    liveSelectionText = '';
    aliveSubFrames.clear();
  }
});

test('tabs.getPageContent: executes extractPageContent and normalizes the result', async () => {
  injections.length = 0;
  executeScriptImpl = () => [{ frameId: 0, result: { title: '', url: '', lang: 'en', description: 'D', selection: 'S', text: 'Inhalt', truncated: true } }];
  const savedGet = tabs.get;
  try {
    const page = await tabsLib.getPageContent(TAB.id, { maxChars: 1234 });
    assert.deepEqual(page, {
      title: TAB.title, url: TAB.url, lang: 'en', description: 'D', selection: 'S', text: 'Inhalt', truncated: true,
    });
    // The fallback tab URL loses query and fragment as well.
    tabs.get = async (id) => ({ ...(await savedGet(id)), url: 'https://example.com/reset?token=abc#frag' });
    assert.equal((await tabsLib.getPageContent(TAB.id)).url, 'https://example.com/reset');
    tabs.get = savedGet;
    assert.equal(injections[0].func, extractPageContent);
    assert.deepEqual(injections[0].args, [1234]);

    executeScriptImpl = () => {
      throw new Error('Frame with ID 0 is showing error page');
    };
    await assert.rejects(tabsLib.getPageContent(TAB.id), /nicht richtig geladen/);
    await assert.rejects(tabsLib.getPageContent(RESTRICTED_TAB.id), /dürfen Erweiterungen nicht/);
  } finally {
    tabs.get = savedGet;
    executeScriptImpl = null;
  }
});

test('tabs.getVideoContent: problem codes of the extractor become sentences in the UI language', async () => {
  const ID = 'dQw4w9WgXcQ';
  try {
    executeScriptImpl = () => [{ frameId: 0, result: { ok: true, id: ID, title: 'T', transcript: null, problem: 'no_transcript', problemParams: {} } }];
    const video = await tabsLib.getVideoContent(TAB.id, ID);
    assert.equal(video.problem, 'Für dieses Video gibt es kein Transkript.');
    assert.equal(video.problemCode, 'no_transcript');

    executeScriptImpl = () => [{ frameId: 0, result: { ok: false, problem: 'watch_http', problemParams: { status: 429 } } }];
    await assert.rejects(tabsLib.getVideoContent(TAB.id, ID), { message: 'Die Videoseite antwortete mit HTTP 429.' });

    setLanguage('en');
    await assert.rejects(tabsLib.getVideoContent(TAB.id, ID), { message: 'The video page responded with HTTP 429.' });
    executeScriptImpl = () => {
      throw new Error('Cannot access contents of url "https://www.youtube.com/". Extension manifest must request permission to access this host.');
    };
    await assert.rejects(tabsLib.getVideoContent(TAB.id, ID), { message: /^The extension has no access to this page\./ });
    assert.equal(tabsLib.restrictedPageMessage(), 'Extensions are not allowed to run on this page.');
  } finally {
    setLanguage('de');
    executeScriptImpl = null;
  }
});

function withFakeDom(dom, fn) {
  const keys = ['document', 'location', 'getSelection'];
  const saved = Object.fromEntries(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.document = dom.document;
  globalThis.location = dom.location;
  globalThis.getSelection = dom.getSelection;
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  }
}

function fakeDom({
  bodyText, articleText = null, title = '  Test   Seite ', withBody = true, selection = '', activeElement = null,
  href = 'https://example.com/seite',
} = {}) {
  const article = articleText === null ? null : { innerText: articleText, getClientRects: () => [{}] };
  const html = {
    innerText: 'Nur  das Wurzelelement',
    getAttribute: (name) => (name === 'lang' ? 'de-DE' : null),
  };
  return {
    document: {
      documentElement: html,
      body: withBody ? { innerText: bodyText, querySelectorAll: () => (article ? [article] : []) } : null,
      title,
      activeElement,
      querySelector: (sel) => (sel === 'meta[name="description" i]' ? { getAttribute: () => '  Eine   Beschreibung ' } : null),
    },
    location: { href },
    getSelection: () => ({ toString: () => selection }),
  };
}

function fakeField(tagName, { type, value = 'geheim123', autocomplete = null } = {}) {
  return {
    tagName,
    type,
    value,
    selectionStart: 0,
    selectionEnd: value.length,
    getAttribute: (name) => (name === 'autocomplete' ? autocomplete : null),
  };
}

test('page.extractPageContent: never reads password, one-time-code or card fields; URL without query/fragment', () => {
  const run = (activeElement, extra = {}) => withFakeDom(
    fakeDom({ bodyText: 'Text', selection: 'Dokument-Auswahl', activeElement, ...extra }),
    () => extractPageContent(1000),
  );
  // Sensitive fields: no value, and no fallback to the document selection (it may mirror the field).
  for (const field of [
    fakeField('INPUT', { type: 'password' }),
    fakeField('input', { type: 'PASSWORD' }),
    fakeField('INPUT', { type: 'text', autocomplete: 'one-time-code' }),
    fakeField('INPUT', { type: 'tel', autocomplete: 'section-pay cc-number' }),
    fakeField('TEXTAREA', { autocomplete: 'new-password' }),
  ]) {
    assert.equal(run(field).selection, '', `${field.tagName}/${field.type}/${field.getAttribute('autocomplete')}`);
  }
  // A password field inside an open shadow root is found as well.
  const host = { tagName: 'X-LOGIN', shadowRoot: { activeElement: fakeField('INPUT', { type: 'password' }) } };
  assert.equal(run(host).selection, '');

  // Text-like fields are read; other inputs (checkbox, email) fall back to the document selection.
  assert.equal(run(fakeField('INPUT', { type: 'search', value: 'Suchbegriff' })).selection, 'Suchbegriff');
  assert.equal(run(fakeField('TEXTAREA', { value: 'Mein Entwurf' })).selection, 'Mein Entwurf');
  assert.equal(run(fakeField('INPUT', { type: 'checkbox', value: 'on' })).selection, 'Dokument-Auswahl');

  assert.equal(run(null, { href: 'https://user:pw@example.com/reset?token=abc#access_token=x' }).url, 'https://example.com/reset');
  assert.equal(run(null, { href: 'https://example.com/a#b?c' }).url, 'https://example.com/a');
});

test('page.extractPageContent: prefers the main article, collapses whitespace, reports meta data', () => {
  const articleText = `Artikel   Überschrift\n\n\n\n  Erster    Absatz.  \nZweite Zeile ${'x'.repeat(300)}`;
  const result = withFakeDom(fakeDom({
    bodyText: `Menü Start Kontakt\n${articleText}\nFußzeile`,
    articleText,
    selection: '  markierter \n  Text ',
  }), () => extractPageContent(60000));
  assert.equal(result.title, 'Test Seite');
  assert.equal(result.url, 'https://example.com/seite');
  assert.equal(result.lang, 'de-DE');
  assert.equal(result.description, 'Eine Beschreibung');
  assert.equal(result.selection, 'markierter\nText');
  assert.ok(result.text.startsWith('Artikel Überschrift\n\nErster Absatz.\nZweite Zeile'));
  assert.equal(result.text.includes('Menü'), false);
  assert.equal(result.truncated, false);
});

test('page.extractPageContent: falls back to body, caps at maxChars, handles pages without body', () => {
  const bodyText = `${'Wort '.repeat(400)}Ende`;
  const capped = withFakeDom(fakeDom({ bodyText, articleText: 'Kurzer Teaser' }), () => extractPageContent(100));
  assert.ok(capped.text.length <= 100);
  assert.ok(capped.text.startsWith('Wort Wort'));
  assert.equal(capped.truncated, true);

  const noBody = withFakeDom(fakeDom({ withBody: false, title: '' }), () => extractPageContent());
  assert.equal(noBody.text, 'Nur das Wurzelelement');
  assert.equal(noBody.title, '');
  assert.equal(noBody.truncated, false);

  // It must be self-contained: serializing and re-evaluating it works without the module scope.
  const revived = (0, eval)(`(${extractPageContent.toString()})`);
  const again = withFakeDom(fakeDom({ bodyText: 'Hallo   Welt' }), () => revived(50));
  assert.equal(again.text, 'Hallo Welt');
});
