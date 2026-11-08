// Background: Chrome service worker / Firefox event page (ARCHITECTURE §7, §8).
// Service-worker safe: no window, DOM, localStorage, FileReader or dynamic import(). Every
// listener is registered synchronously at top level; initialization is idempotent.

import { ext, IS_FIREFOX, sessionArea } from '../lib/ext.js';
import { SETTINGS_KEY, getSettings as getStoredSettings, updateSettings, resolveTarget, getContentConfig } from '../lib/settings.js';
import '../locales/all.js'; // registers every UI catalog (no dynamic import() in a service worker)
import { setLanguage, resolveLanguage, messagesWithPrefix, t } from '../lib/i18n.js';
import { languageLabel } from '../lib/languages.js';
import {
  buildActionRequest, buildTranslateRequest, buildSegmentsRequest, parseSegmentsResponse,
  profileText, summarizePagePrompt, getDefaultQuickActions, quickActionName,
} from '../lib/prompts.js';
import { streamChat, describeError } from '../lib/llm.js';
import { getActiveTab, sendToTab, tryMessageTab, injectIntoOpenTabs, restrictedPageMessage } from '../lib/tabs.js';
import { uid, isRestrictedUrl, hostnameOf, truncate, normalizeQuote } from '../lib/utils.js';
import { recordUsage, usageRecord, cleanUsage, sumUsage } from '../lib/usage.js';

// UI language: the browser language until the settings are read, then the configured one.
setLanguage(resolveLanguage());

let languageApplied = false;

function applyLanguage(settings) {
  setLanguage(resolveLanguage(settings?.general?.language));
  languageApplied = true;
}

/** Settings + switches t() to the configured UI language (menus, notices, error messages). */
async function getSettings() {
  const settings = await getStoredSettings();
  applyLanguage(settings);
  return settings;
}

// A freshly started worker still uses the browser language: read the settings once before
// showing anything (toolbar-icon notices of menu clicks and shortcuts).
async function ensureLanguage() {
  if (languageApplied) return;
  try {
    await getSettings();
  } catch {
    // keep the browser language
  }
}

const LOG = '[LLM Sidebar]';
const STREAM_PORT_NAME = 'llm-stream';
const PENDING_CHAT_KEY = 'pendingChat';
const MENU_SIGNATURE_KEY = 'menuSignature';
const MENU_REBUILD_DELAY_MS = 300;
const API_TIMEOUT_MS = 5000;
const KEEP_ALIVE_INTERVAL_MS = 20000;
const SELECTION_TIMEOUT_MS = 1500;
const PENDING_KINDS = ['prefill', 'send', 'continue'];
// A PendingChat that nobody claimed in time is dropped; an auto-sent one expires much sooner.
const PENDING_MAX_AGE_MS = { prefill: 24 * 60 * 60 * 1000, continue: 24 * 60 * 60 * 1000, send: 10 * 60 * 1000 };
const NOTICE_DURATION_MS = 10000;
const NOTICE_COLOR = '#e5484d';


const MENU = {
  root: 'llm-root',
  actionPrefix: 'qa:',
  translateSelection: 'translate-selection',
  askSelection: 'ask-selection',
  separator: 'separator-page',
  translatePage: 'translate-page',
  restorePage: 'restore-page',
  summarizePage: 'summarize-page',
  openSidebar: 'open-sidebar',
};
const ROOT_CONTEXTS = ['selection', 'page', 'editable'];
const SELECTION_CONTEXTS = ['selection'];
const PAGE_CONTEXTS = ['page', 'selection', 'editable'];
// Menu items and commands that need the panel; it is opened synchronously in the event handler.
const PANEL_TRIGGERS = new Set([MENU.askSelection, MENU.summarizePage, MENU.openSidebar]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
const optionalString = (v) => (typeof v === 'string' && v.trim() ? v : undefined);
const validTabId = (id) => Number.isInteger(id) && id >= 0;
const validWindowId = (id) => Number.isInteger(id) && id >= 0;
const frameOf = (info) => (Number.isInteger(info?.frameId) && info.frameId >= 0 ? info.frameId : 0);

// Adds a finished (or stopped) request to the cost statistics. Never throws.
// Returns the usage record (tokens, cost) so callers can show it, or null.
function trackUsage(target, usage) {
  try {
    const record = usageRecord(target.provider, target.model, usage);
    settle(recordUsage({
      providerId: target.provider.id, providerName: target.provider.name, model: target.model, usage: record,
    }), 'Could not save usage:');
    return record;
  } catch (err) {
    warn('Could not save usage:', err);
    return null;
  }
}

/** Total of several usage records for a content script: { inputTokens, outputTokens, cost?, estimated? } or null. */
function usageTotal(records) {
  const total = sumUsage(records.filter(Boolean));
  if (!total.requests) return null;
  const out = { inputTokens: total.inputTokens, outputTokens: total.outputTokens };
  // A cost is only meaningful when every request had a price.
  if (total.priced && !total.unpriced) {
    out.cost = total.cost;
    if (total.estimated) out.estimated = true;
  }
  return out;
}

function extensionBaseUrl() {
  try {
    return String(ext.runtime.getURL('') || '');
  } catch {
    return '';
  }
}

// Content scripts share the renderer with the web page, so their messages are not trusted like
// those of extension pages (side panel, options – even when one of them is open in a tab).
function isContentScriptSender(sender) {
  if (!sender?.tab) return false;
  const base = extensionBaseUrl();
  return !(base && typeof sender.url === 'string' && sender.url.startsWith(base));
}

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function errorResponse(err) {
  const response = { ok: false, error: describeError(err) };
  if (typeof err?.code === 'string' && err.code) response.code = err.code;
  return response;
}

function warn(context, err) {
  console.warn(LOG, context, err ? describeError(err) : '');
}

// Swallows the rejection of an API call that may return a promise (or nothing at all).
function settle(value, context) {
  if (value && typeof value.then === 'function') value.then(null, (err) => warn(context, err));
}

// Calls a Chrome-style API with a completion callback. The callback reads runtime.lastError, so
// errors (e.g. duplicate menu ids) never surface as "Unchecked runtime.lastError"; promise-returning
// implementations (Firefox `browser.*`) are handled too.
function callWithCallback(fn, thisArg, args = [], timeoutMs = API_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    timer = setTimeout(() => finish(new Error(t('core.background.apiTimeout'))), timeoutMs);
    const handleReturn = (ret) => {
      if (ret && typeof ret.then === 'function') ret.then((value) => finish(null, value), (err) => finish(err));
    };
    try {
      handleReturn(fn.apply(thisArg, [...args, (value) => {
        const lastError = ext.runtime?.lastError;
        finish(lastError ? new Error(lastError.message || String(lastError)) : null, value);
      }]));
    } catch (err) {
      // An implementation that rejects the callback argument: retry once in promise form.
      if (!(err instanceof TypeError)) {
        finish(err);
        return;
      }
      try {
        const ret = fn.apply(thisArg, args);
        if (ret && typeof ret.then === 'function') handleReturn(ret);
        else finish(null, ret);
      } catch (retryErr) {
        finish(retryErr);
      }
    }
  });
}

async function readSession(key) {
  try {
    const result = await sessionArea.get(key);
    return result?.[key];
  } catch {
    return undefined;
  }
}

async function writeSession(key, value) {
  try {
    await sessionArea.set({ [key]: value });
  } catch (err) {
    warn(`Could not write session storage (${key}):`, err);
  }
}

// ---------------------------------------------------------------------------
// Keep-alive: Chrome terminates idle service workers; ping while requests are in flight.
// ---------------------------------------------------------------------------

let activeRequests = 0;
let keepAliveTimer = null;

function keepAlivePing() {
  try {
    settle(ext.runtime.getPlatformInfo(), 'Keep-alive:');
  } catch {
    // ignore
  }
}

function beginRequest() {
  activeRequests += 1;
  if (keepAliveTimer === null) keepAliveTimer = setInterval(keepAlivePing, KEEP_ALIVE_INTERVAL_MS);
}

function endRequest() {
  activeRequests = Math.max(0, activeRequests - 1);
  if (activeRequests === 0 && keepAliveTimer !== null) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Toolbar-icon notice: visible feedback when a context-menu or shortcut action cannot run.
// ---------------------------------------------------------------------------

const noticeTimers = new Map(); // tabId → timer

function callAction(method, details) {
  const fn = ext.action?.[method];
  if (typeof fn !== 'function') return;
  try {
    settle(fn.call(ext.action, details), `action.${method}:`);
  } catch (err) {
    warn(`action.${method}:`, err);
  }
}

function defaultActionTitle() {
  try {
    return nonEmptyString(ext.runtime.getManifest?.()?.action?.default_title) || 'LLM Sidebar';
  } catch {
    return 'LLM Sidebar';
  }
}

function clearTabNotice(tabId) {
  if (!noticeTimers.has(tabId)) return;
  clearTimeout(noticeTimers.get(tabId));
  noticeTimers.delete(tabId);
  callAction('setBadgeText', { tabId, text: '' });
  callAction('setTitle', { tabId, title: defaultActionTitle() });
}

function showTabNotice(tabId, message) {
  if (!validTabId(tabId)) return;
  const text = nonEmptyString(message) || t('core.background.actionFailed');
  callAction('setBadgeBackgroundColor', { tabId, color: NOTICE_COLOR });
  callAction('setBadgeText', { tabId, text: '!' });
  callAction('setTitle', { tabId, title: `LLM Sidebar – ${text}` });
  clearTimeout(noticeTimers.get(tabId));
  noticeTimers.set(tabId, setTimeout(() => clearTabNotice(tabId), NOTICE_DURATION_MS));
}

// ---------------------------------------------------------------------------
// Side panel / sidebar
// ---------------------------------------------------------------------------

// Opens the Chrome side panel or the Firefox sidebar. MUST be called synchronously inside the
// user-gesture event handler (before any await). Resolves to true when the panel opened.
function openPanel({ tabId, windowId } = {}) {
  try {
    if (typeof ext.sidePanel?.open === 'function') {
      let options = null;
      if (validTabId(tabId)) options = { tabId };
      else if (validWindowId(windowId)) options = { windowId };
      if (!options) return Promise.resolve(false);
      return Promise.resolve(ext.sidePanel.open(options)).then(() => true, (err) => {
        warn('Could not open the side panel:', err);
        return false;
      });
    }
    if (typeof ext.sidebarAction?.open === 'function') {
      return Promise.resolve(ext.sidebarAction.open()).then(() => true, (err) => {
        warn('Could not open the side panel:', err);
        return false;
      });
    }
  } catch (err) {
    warn('Could not open the side panel:', err);
  }
  return Promise.resolve(false);
}

function configurePanelBehavior() {
  if (typeof ext.sidePanel?.setPanelBehavior !== 'function') return;
  try {
    settle(ext.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }), 'setPanelBehavior:');
  } catch (err) {
    warn('setPanelBehavior:', err);
  }
}

// Chrome only: keep storage.local (API keys) away from content scripts.
function hardenStorage() {
  const area = ext.storage?.local;
  if (typeof area?.setAccessLevel !== 'function') return;
  try {
    const ret = area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    if (ret && typeof ret.then === 'function') ret.then(null, () => {});
  } catch {
    // not supported – ignore
  }
}

// Firefox: is our sidebar already open in that window? (It then claims the PendingChat itself.)
function isSidebarOpen(windowId) {
  if (typeof ext.sidebarAction?.isOpen !== 'function') return Promise.resolve(false);
  try {
    const details = validWindowId(windowId) ? { windowId } : {};
    return Promise.resolve(ext.sidebarAction.isOpen(details)).then((open) => open === true, (err) => {
      warn('sidebarAction.isOpen:', err);
      return false;
    });
  } catch (err) {
    warn('sidebarAction.isOpen:', err);
    return Promise.resolve(false);
  }
}

// ---------------------------------------------------------------------------
// PendingChat: stored for one window, claimed exactly once by that window's panel.
// ---------------------------------------------------------------------------

let pendingChain = Promise.resolve();

// Stores and claims run one after another, so an entry can never be handed out twice or be
// removed by a claim that read the previous one.
function withPendingLock(fn) {
  const run = pendingChain.then(fn);
  pendingChain = run.catch(() => {});
  return run;
}

function storePendingChat(payload, windowId) {
  const source = isObject(payload) ? payload : {};
  const pendingChat = {
    ...source,
    kind: PENDING_KINDS.includes(source.kind) ? source.kind : 'prefill',
    id: uid(),
    ts: Date.now(),
  };
  delete pendingChat.windowId;
  if (validWindowId(windowId)) pendingChat.windowId = windowId;
  return withPendingLock(async () => {
    await sessionArea.set({ [PENDING_CHAT_KEY]: pendingChat });
    return pendingChat;
  });
}

function isPendingExpired(pending) {
  const ts = Number(pending.ts);
  const maxAge = PENDING_MAX_AGE_MS[pending.kind] ?? PENDING_MAX_AGE_MS.send;
  return !Number.isFinite(ts) || Date.now() - ts > maxAge;
}

// Content-script payloads: only what the in-page UI legitimately sends. A page must never be able
// to make the panel send a request on its own (kind 'send', a seed ending with a user turn) or to
// attach the content of the foreground tab (includePage).
function sanitizeContentPayload(payload) {
  const source = isObject(payload) ? payload : {};
  const out = { kind: source.kind === 'continue' ? 'continue' : 'prefill' };
  if (typeof source.text === 'string') out.text = source.text;
  if (typeof source.title === 'string' && source.title.trim()) out.title = source.title;
  const quote = out.kind === 'prefill' ? normalizeQuote(source.quote) : null;
  if (quote) out.quote = quote;
  if (out.kind === 'continue') {
    const messages = (Array.isArray(source.messages) ? source.messages : [])
      .filter((m) => isObject(m) && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }));
    while (messages.length && messages[messages.length - 1].role !== 'assistant') messages.pop();
    out.messages = messages;
  }
  return out;
}

function summarizePayload(tab) {
  const payload = { kind: 'send', text: summarizePagePrompt(), includePage: true };
  const title = nonEmptyString(tab?.title);
  if (title) payload.title = truncate(t('core.background.summaryTitle', { title }), 60);
  return payload;
}

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

function menuTitle(text) {
  const title = String(text ?? '').replace(/\s+/g, ' ').trim();
  // Firefox treats '&' as access-key marker; '&&' renders a literal ampersand.
  return IS_FIREFOX ? title.replace(/&/g, '&&') : title;
}

function buildMenuItems(settings) {
  const actions = Array.isArray(settings?.quickActions) ? settings.quickActions : [];
  // Stored value: a language code, 'auto' (= UI language) or free text.
  const lang = languageLabel(nonEmptyString(settings?.translate?.targetLang) || 'auto');
  const items = [{ id: MENU.root, title: t('common.appName'), contexts: ROOT_CONTEXTS }];
  const child = (props) => items.push({ parentId: MENU.root, ...props });

  for (const action of actions) {
    // The built-in translate action is represented by the "Übersetzen nach …" item below.
    if (!isObject(action) || !action.contextMenu || !action.id || action.id === 'translate') continue;
    child({
      id: MENU.actionPrefix + action.id,
      title: menuTitle(`${action.icon || '⚡'} ${quickActionName(action) || t('core.menu.actionFallback')}`),
      contexts: SELECTION_CONTEXTS,
    });
  }
  const translateAction = actions.find((a) => a?.id === 'translate');
  if (!translateAction || translateAction.contextMenu !== false) {
    child({
      id: MENU.translateSelection,
      title: menuTitle(`${translateAction?.icon || '🌐'} ${t('core.menu.translateTo', { language: lang })}`),
      contexts: SELECTION_CONTEXTS,
    });
  }
  child({ id: MENU.askSelection, title: menuTitle(`💬 ${t('core.menu.askInChat')}`), contexts: SELECTION_CONTEXTS });
  child({ id: MENU.separator, type: 'separator', contexts: SELECTION_CONTEXTS });
  child({ id: MENU.translatePage, title: menuTitle(`🌍 ${t('core.menu.translatePage')}`), contexts: PAGE_CONTEXTS });
  child({ id: MENU.restorePage, title: menuTitle(`🔙 ${t('core.menu.restorePage')}`), contexts: PAGE_CONTEXTS });
  child({ id: MENU.summarizePage, title: menuTitle(`📄 ${t('core.menu.summarizePage')}`), contexts: PAGE_CONTEXTS });
  child({ id: MENU.openSidebar, title: menuTitle(`🗂️ ${t('core.menu.openSidebar')}`), contexts: PAGE_CONTEXTS });
  return items;
}

let menuChain = Promise.resolve();
let builtMenuSignature = null;
let menuTimer = null;

async function rebuildMenus(force) {
  if (typeof ext.contextMenus?.create !== 'function') return;
  const items = buildMenuItems(await getSettings());
  const signature = JSON.stringify(items);
  if (!force) {
    if (signature === builtMenuSignature) return;
    // A restarted worker: the menus of the previous instance are still registered.
    if (builtMenuSignature === null && (await readSession(MENU_SIGNATURE_KEY)) === signature) {
      builtMenuSignature = signature;
      return;
    }
  }
  builtMenuSignature = null;
  await callWithCallback(ext.contextMenus.removeAll, ext.contextMenus);
  // create() calls are queued in order, so the root exists before its children.
  const results = await Promise.all(items.map((item) => callWithCallback(ext.contextMenus.create, ext.contextMenus, [item])
    .then(() => true, (err) => {
      warn(`Could not create context menu item "${item.id}":`, err);
      return false;
    })));
  if (results.every(Boolean)) {
    builtMenuSignature = signature;
    await writeSession(MENU_SIGNATURE_KEY, signature);
  } else {
    await writeSession(MENU_SIGNATURE_KEY, '');
  }
}

// Serialized: two rebuilds never interleave (removeAll/create of one run cannot mix with another).
function syncMenus({ force = false } = {}) {
  menuChain = menuChain
    .then(() => rebuildMenus(force))
    .catch((err) => warn('Could not update the context menu:', err));
  return menuChain;
}

function scheduleMenuSync() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(() => {
    menuTimer = null;
    syncMenus();
  }, MENU_REBUILD_DELAY_MS);
}

async function resolveTab(tab) {
  if (tab && validTabId(tab.id)) return tab;
  return getActiveTab();
}

// Sends a command to the content script of a tab (or one of its frames). When it cannot run there
// (restricted page, injection failed, no access), the toolbar icon of that tab shows why; errors
// the content script reports itself are shown on the page by the content script.
async function sendToPage(tab, message, { frameId = 0 } = {}) {
  const target = await resolveTab(tab);
  if (!target) {
    console.info(LOG, 'No suitable tab found.');
    return;
  }
  if (target.url && isRestrictedUrl(target.url)) {
    console.info(LOG, 'Extensions may not run on this page:', target.url);
    showTabNotice(target.id, restrictedPageMessage());
    return;
  }
  try {
    try {
      await sendToTab(target.id, message, { frameId });
    } catch (err) {
      // A frame without (injectable) content script, or one too small for the result: the top
      // frame still shows it.
      if (frameId === 0 || (err?.code === 'page_error' && err.pageCode !== 'tiny_frame')) throw err;
      warn(`Frame ${frameId} not reachable, using the top document:`, err);
      await sendToTab(target.id, message, { frameId: 0 });
    }
    clearTabNotice(target.id);
  } catch (err) {
    warn(`"${message.type}" failed:`, err);
    if (err?.code !== 'page_error') showTabNotice(target.id, err?.message);
  }
}

// Chrome collapses the line breaks of info.selectionText; the content script still knows the
// selection with its structure. Used only when both describe the same text.
async function liveSelection(tab, frameId, given) {
  if (!validTabId(tab?.id) || (tab.url && isRestrictedUrl(tab.url))) return given;
  const res = await tryMessageTab(tab.id, { type: 'getSelection' }, { frameId, timeoutMs: SELECTION_TIMEOUT_MS });
  const live = typeof res?.text === 'string' ? res.text.trim() : '';
  const squash = (s) => s.replace(/\s+/g, '');
  return live && squash(live) === squash(given) ? live : given;
}

async function handleMenuClick(id, info, tab) {
  await ensureLanguage();
  const windowId = tab?.windowId;
  switch (id) {
    case MENU.openSidebar:
      return; // the panel was opened synchronously by the listener
    case MENU.askSelection: {
      const given = String(info.selectionText ?? '').trim();
      const selection = given ? await liveSelection(tab, frameOf(info), given) : '';
      const quote = normalizeQuote({ text: selection, title: tab?.title, url: tab?.url });
      const payload = { kind: 'prefill', text: '' };
      if (quote) {
        payload.quote = quote;
        if (validTabId(tab?.id)) payload.source = { tabId: tab.id, frameId: frameOf(info) };
      }
      await storePendingChat(payload, windowId);
      return;
    }
    case MENU.summarizePage:
      await storePendingChat(summarizePayload(tab), windowId);
      return;
    case MENU.translateSelection:
      await sendToPage(tab, { type: 'translateSelection', text: info.selectionText }, { frameId: frameOf(info) });
      return;
    case MENU.translatePage:
      await sendToPage(tab, { type: 'translatePage' });
      return;
    case MENU.restorePage:
      await sendToPage(tab, { type: 'restorePage' });
      return;
    default:
      if (id.startsWith(MENU.actionPrefix)) {
        await sendToPage(
          tab,
          { type: 'runAction', actionId: id.slice(MENU.actionPrefix.length), text: info.selectionText },
          { frameId: frameOf(info) },
        );
      }
  }
}

async function handleCommand(command, tab) {
  await ensureLanguage();
  switch (command) {
    case 'translate-page':
      await sendToPage(tab, { type: 'translatePage' });
      return;
    case 'restore-page':
      await sendToPage(tab, { type: 'restorePage' });
      return;
    case 'summarize-page': {
      const target = tab ?? await getActiveTab();
      await storePendingChat(summarizePayload(target), target?.windowId);
      return;
    }
    default:
      // 'open-sidebar' is fully handled by the listener; '_execute_*' commands by the browser.
  }
}

// ---------------------------------------------------------------------------
// LLM tasks (port 'llm-stream') and page translation
// ---------------------------------------------------------------------------

function sanitizePage(page) {
  if (!isObject(page)) return undefined;
  const title = typeof page.title === 'string' ? truncate(page.title.trim(), 300) : '';
  const url = typeof page.url === 'string' ? page.url.trim().slice(0, 2048) : '';
  return title || url ? { title, url } : undefined;
}

// A refinement of a translation may still arrive as action 'translate' (older content scripts).
const isTranslateTask = (task) => task.kind === 'translate' || (task.kind === 'action' && task.actionId === 'translate');

function buildTaskRequest(settings, task) {
  const text = typeof task.text === 'string' ? task.text : '';
  if (!text.trim()) throw codedError('no_text', t('core.background.noText'));
  const options = {
    text,
    lang: nonEmptyString(task.lang) || settings.translate.targetLang,
    profile: profileText(settings),
    instruction: optionalString(task.instruction),
    previous: optionalString(task.previous),
    page: sanitizePage(task.page),
  };
  const actions = Array.isArray(settings.quickActions) ? settings.quickActions : [];

  if (isTranslateTask(task)) {
    // Honour a customized "Übersetzen" quick action; it may also have been deleted.
    const translateAction = actions.find((a) => a?.id === 'translate') ?? getDefaultQuickActions().find((a) => a.id === 'translate');
    return translateAction ? buildActionRequest(translateAction, options) : buildTranslateRequest(text, options.lang);
  }
  const action = actions.find((a) => a?.id === task.actionId);
  if (!action) {
    throw codedError('unknown_action', t('core.background.unknownAction'));
  }
  return buildActionRequest(action, options);
}

async function runStreamTask(task, signal, post) {
  beginRequest();
  let target = null;
  try {
    if (!isObject(task) || (task.kind !== 'action' && task.kind !== 'translate')) {
      throw codedError('bad_request', t('core.background.badRequest'));
    }
    const settings = await getSettings();
    if (signal.aborted) return;
    target = resolveTarget(settings, isTranslateTask(task) ? 'translate' : 'actions');
    if (!target) {
      post({ type: 'error', code: 'no_provider', error: t('core.background.noProvider') });
      return;
    }
    const request = buildTaskRequest(settings, task);
    post({ type: 'meta', provider: target.provider.name, model: target.model });

    let sentDelta = false;
    // Always streamed (whatever the chat setting says): bytes keep flowing, so Chrome does not
    // kill the worker on slow answers. No chat.maxTokens here – that limit is for the chat only.
    const result = await streamChat({
      provider: target.provider,
      model: target.model,
      system: request.system,
      messages: request.messages,
      stream: true,
      signal,
      onText: (delta) => {
        sentDelta = true;
        post({ type: 'delta', delta });
      },
    });
    const usage = usageTotal([trackUsage(target, result?.usage)]);
    if (signal.aborted) return;
    const text = typeof result?.text === 'string' ? result.text : '';
    const finishReason = nonEmptyString(result?.finishReason) || null;
    if (!text.trim()) {
      const refused = finishReason === 'refusal' || finishReason === 'content_filter';
      post({ type: 'error', code: refused ? 'refusal' : 'empty', error: t(refused ? 'core.background.refused' : 'core.background.emptyAnswer') });
      return;
    }
    if (!sentDelta) post({ type: 'delta', delta: text });
    post({ type: 'done', text, finishReason, ...(usage ? { usage } : {}) });
  } catch (err) {
    // Stopped or failed mid-stream: the tokens up to here are billed anyway.
    if (target && err?.partial?.usage) trackUsage(target, err.partial.usage);
    if (signal.aborted) return;
    post({ type: 'error', code: typeof err?.code === 'string' && err.code ? err.code : 'error', error: describeError(err) });
  } finally {
    endRequest();
  }
}

function handleStreamPort(port) {
  let connected = true;
  let current = null; // { controller } of the running task

  const post = (run, message) => {
    if (!connected || run !== current) return;
    try {
      port.postMessage(message);
    } catch {
      connected = false;
      run.controller.abort();
    }
  };

  port.onDisconnect.addListener(() => {
    void ext.runtime?.lastError; // read it so Chrome does not log "Unchecked runtime.lastError"
    connected = false;
    current?.controller.abort();
    current = null;
  });

  port.onMessage.addListener((message) => {
    if (!isObject(message)) return;
    if (message.type === 'abort') {
      const run = current;
      current = null;
      run?.controller.abort();
      return;
    }
    if (message.type === 'start') {
      current?.controller.abort(); // a new start supersedes a running task
      const run = { controller: new AbortController() };
      current = run;
      runStreamTask(message.task, run.controller.signal, (msg) => post(run, msg)).finally(() => {
        if (current === run) current = null;
      });
    }
  });
}

// `usages` collects the usage record of every request (including split retries).
async function translateBatch(target, segments, lang, allowSplit, usages = []) {
  const { system, messages } = buildSegmentsRequest(segments, lang);
  // Always streamed: bytes keep flowing, so Chrome does not kill the worker on slow answers.
  // Provider default length (chat.maxTokens would cut batches short).
  const result = await streamChat({
    provider: target.provider,
    model: target.model,
    system,
    messages,
    stream: true,
  });
  usages.push(trackUsage(target, result?.usage));
  const parsed = parseSegmentsResponse(result?.text ?? '', segments.length);
  const missing = parsed.filter((v) => v === null).length;
  if (!allowSplit || segments.length < 2 || missing <= segments.length / 2) return parsed;

  // More than half missing: split in two and retry each half once.
  const mid = Math.ceil(segments.length / 2);
  const halves = [[0, mid], [mid, segments.length]];
  const retries = await Promise.allSettled(
    halves.map(([start, end]) => translateBatch(target, segments.slice(start, end), lang, false, usages)),
  );
  const merged = parsed.slice();
  retries.forEach((res, h) => {
    if (res.status !== 'fulfilled') {
      warn('Partial translation failed:', res.reason);
      return;
    }
    res.value.forEach((value, k) => {
      if (value !== null) merged[halves[h][0] + k] = value;
    });
  });
  const failure = retries.find((r) => r.status === 'rejected');
  if (failure && merged.every((v) => v === null)) throw failure.reason;
  return merged;
}

// ---------------------------------------------------------------------------
// runtime.onMessage handlers (§7.1)
// ---------------------------------------------------------------------------

async function handleGetContentConfig() {
  const config = getContentConfig(await getSettings());
  // Content scripts cannot load catalogs themselves: send their strings along.
  config.messages = messagesWithPrefix('content.', 'common.');
  return { ok: true, config };
}

async function handleTranslateSegments(message) {
  if (!Array.isArray(message.segments)) {
    throw codedError('bad_request', t('core.background.noSegments'));
  }
  const segments = message.segments.map((s) => (typeof s === 'string' ? s : s == null ? '' : String(s)));
  const translations = new Array(segments.length).fill(null);
  const indices = [];
  segments.forEach((s, i) => {
    if (s.trim()) indices.push(i);
  });
  if (!indices.length) return { ok: true, translations };

  const settings = await getSettings();
  const target = resolveTarget(settings, 'translate');
  if (!target) return { ok: false, code: 'no_provider', error: t('core.background.noProvider') };
  const lang = nonEmptyString(message.lang) || settings.translate.targetLang;

  beginRequest();
  const usages = [];
  try {
    const result = await translateBatch(target, indices.map((i) => segments[i]), lang, true, usages);
    indices.forEach((original, k) => {
      translations[original] = result[k] ?? null;
    });
    const usage = usageTotal(usages);
    return { ok: true, translations, ...(usage ? { usage } : {}) };
  } finally {
    endRequest();
  }
}

function handleOpenInChat(message, sender) {
  const tab = sender?.tab;
  // Chrome: a content-script click is still a user gesture here, but only synchronously –
  // so open the panel FIRST. Firefox does not treat relayed clicks as user actions: report
  // opened only when the sidebar of that window is already open (it claims the PendingChat).
  const opening = typeof ext.sidePanel?.open === 'function'
    ? openPanel({ tabId: tab?.id, windowId: tab?.windowId })
    : isSidebarOpen(tab?.windowId);
  const payload = isContentScriptSender(sender) ? sanitizeContentPayload(message.payload) : message.payload;
  if (isObject(payload) && payload.quote && validTabId(tab?.id)) {
    // The panel drops the reference again when this frame's selection goes away.
    payload.source = { tabId: tab.id, frameId: Number.isInteger(sender.frameId) ? sender.frameId : 0 };
  }
  return storePendingChat(payload, tab?.windowId)
    .then(() => opening)
    .then((opened) => ({ ok: true, opened }));
}

// → { ok: true, pending } for the panel of `windowId`, else { ok: true, pending: null }.
function handleClaimPendingChat(message, sender) {
  if (isContentScriptSender(sender)) throw codedError('not_allowed', t('core.background.panelOnly'));
  const windowId = validWindowId(message.windowId) ? message.windowId : undefined;
  return withPendingLock(async () => {
    const pending = await readSession(PENDING_CHAT_KEY);
    if (!isObject(pending)) return { ok: true, pending: null };
    if (isPendingExpired(pending)) {
      await sessionArea.remove(PENDING_CHAT_KEY);
      return { ok: true, pending: null };
    }
    if (validWindowId(pending.windowId) && pending.windowId !== windowId) return { ok: true, pending: null };
    await sessionArea.remove(PENDING_CHAT_KEY);
    return { ok: true, pending };
  });
}

function normalizeHost(value) {
  let host = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!host) return '';
  if (host.includes('://')) host = hostnameOf(host);
  return host.replace(/^\*\./, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
}

async function handleDisableToolbarOnHost(message, sender) {
  // A content script may only hide the toolbar on its own site (its frame, else its tab).
  const host = isContentScriptSender(sender)
    ? normalizeHost(hostnameOf(sender.url || '')) || normalizeHost(hostnameOf(sender.tab.url || ''))
    : normalizeHost(message.host) || normalizeHost(hostnameOf(sender?.tab?.url || ''));
  if (!host) throw codedError('bad_request', t('core.background.noHost'));
  await updateSettings((settings) => {
    const list = settings.toolbar.disabledHosts;
    if (!list.includes(host)) list.push(host);
  });
  return { ok: true };
}

// Side panel / options report their own requests here, so the background is the only writer of
// the statistics. Content scripts (shared renderer with the page) may not add entries.
async function handleRecordUsage(message, sender) {
  if (isContentScriptSender(sender)) throw codedError('forbidden', t('core.background.forbidden'));
  const entry = isObject(message.entry) ? message.entry : {};
  const providerId = nonEmptyString(entry.providerId);
  if (!providerId) throw codedError('bad_request', t('core.background.invalidEntry'));
  await recordUsage({
    providerId: providerId.slice(0, 200),
    providerName: nonEmptyString(entry.providerName).slice(0, 200),
    model: nonEmptyString(entry.model).slice(0, 300),
    usage: cleanUsage(entry.usage),
  });
  return { ok: true };
}

async function handleOpenOptions() {
  await ext.runtime.openOptionsPage();
  return { ok: true };
}

const MESSAGE_HANDLERS = {
  getContentConfig: handleGetContentConfig,
  translateSegments: handleTranslateSegments,
  openInChat: handleOpenInChat,
  claimPendingChat: handleClaimPendingChat,
  disableToolbarOnHost: handleDisableToolbarOnHost,
  openOptions: handleOpenOptions,
  recordUsage: handleRecordUsage,
};

function onRuntimeMessage(message, sender, sendResponse) {
  const type = isObject(message) ? message.type : null;
  if (typeof type !== 'string' || !Object.hasOwn(MESSAGE_HANDLERS, type)) return false; // not ours
  const respond = (response) => {
    try {
      sendResponse(response);
    } catch {
      // the sender is gone (tab closed / navigated)
    }
  };
  let result;
  try {
    result = MESSAGE_HANDLERS[type](message, sender);
  } catch (err) {
    respond(errorResponse(err));
    return false;
  }
  Promise.resolve(result).then(respond, (err) => respond(errorResponse(err)));
  return true;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function persistNormalizedSettings() {
  try {
    await updateSettings((settings) => settings);
  } catch (err) {
    warn('Could not save the settings:', err);
  }
}

async function openOptionsPageSafe() {
  try {
    await ext.runtime.openOptionsPage();
  } catch (err) {
    warn('Could not open the settings:', err);
  }
}

function onInstalled(details) {
  configurePanelBehavior();
  hardenStorage();
  // Chrome runs declared content scripts only in pages loaded afterwards: without this, the
  // selection toolbar is missing in every tab that was already open (until it is reloaded).
  // Firefox injects into open tabs itself.
  if (!IS_FIREFOX && (details?.reason === 'install' || details?.reason === 'update')) {
    injectIntoOpenTabs().catch((err) => warn('Content script for open tabs:', err));
  }
  persistNormalizedSettings().then(() => {
    syncMenus({ force: true });
    if (details?.reason === 'install') openOptionsPageSafe(); // onboarding
  });
}

function onStartup() {
  configurePanelBehavior();
  syncMenus({ force: true });
}

function onMenuClicked(info, tab) {
  const id = String(info?.menuItemId ?? '');
  // User gesture: open the panel first and synchronously, then do the async work.
  if (PANEL_TRIGGERS.has(id)) openPanel({ tabId: tab?.id, windowId: tab?.windowId });
  handleMenuClick(id, info || {}, tab).catch((err) => warn('Menu action failed:', err));
}

function onCommand(command, tab) {
  if (command === MENU.openSidebar || command === MENU.summarizePage) {
    openPanel({ tabId: tab?.id, windowId: tab?.windowId });
  }
  handleCommand(command, tab).catch((err) => warn('Keyboard shortcut failed:', err));
}

function onActionClicked(tab) {
  // Firefox: toggle the sidebar synchronously (no await before – user-action rule).
  if (typeof ext.sidebarAction?.toggle === 'function') {
    try {
      settle(ext.sidebarAction.toggle(), 'sidebarAction.toggle:');
    } catch (err) {
      warn('sidebarAction.toggle:', err);
    }
    return;
  }
  // Chrome normally opens the panel itself (openPanelOnActionClick); fallback if that failed.
  openPanel({ tabId: tab?.id, windowId: tab?.windowId });
}

function onStorageChanged(changes, areaName) {
  if (areaName === 'local' && changes && Object.prototype.hasOwnProperty.call(changes, SETTINGS_KEY)) {
    scheduleMenuSync();
  }
}

// All listeners synchronously at top level (worker / event page wake-ups).
ext.runtime.onMessage.addListener(onRuntimeMessage);
ext.runtime.onConnect.addListener((port) => {
  if (port?.name === STREAM_PORT_NAME) handleStreamPort(port);
});
ext.runtime.onInstalled?.addListener(onInstalled);
ext.runtime.onStartup?.addListener(onStartup);
ext.storage?.onChanged?.addListener(onStorageChanged);
ext.contextMenus?.onClicked?.addListener(onMenuClicked);
ext.commands?.onCommand?.addListener(onCommand);
ext.action?.onClicked?.addListener(onActionClicked);

// Idempotent init on every start of the worker.
hardenStorage();
configurePanelBehavior();
syncMenus();
