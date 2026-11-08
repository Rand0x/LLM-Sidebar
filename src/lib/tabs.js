// Tab helpers: active tab, content-script injection, messaging and page extraction.
// Usable from the background and from extension pages (side panel, options).

import { ext } from './ext.js';
import { isRestrictedUrl } from './utils.js';
import { extractPageContent } from './page.js';
import { extractYouTubeVideo, seekYouTubeVideo, describeVideoProblem } from './youtube.js';
import { t } from './i18n.js';

const CONTENT_SCRIPT = 'content/content.js';
const PING_TIMEOUT_MS = 3000;
const PING_RETRIES = 5;
const PING_RETRY_DELAY_MS = 100;
const ALL_SITES = ['<all_urls>'];

// User-facing messages (UI language), by code.
const TAB_MESSAGE_KEYS = {
  restricted: 'core.tabs.restricted',
  noAccess: 'core.tabs.noAccess',
  fileAccess: 'core.tabs.fileAccess',
  errorPage: 'core.tabs.errorPage',
  tabGone: 'core.tabs.tabGone',
  notReachable: 'core.tabs.notReachable',
  injectFailed: 'core.tabs.injectFailed',
  readFailed: 'core.tabs.readFailed',
  videoReadFailed: 'core.tabs.videoReadFailed',
  actionFailed: 'core.tabs.actionFailed',
  noTab: 'core.tabs.noTab',
};

/** Message for a tab problem code (restricted, noAccess, notReachable …) in the UI language. */
export function tabMessage(code) {
  return t(TAB_MESSAGE_KEYS[code] ?? TAB_MESSAGE_KEYS.injectFailed);
}

/** "Extensions may not run on this page." in the UI language. */
export function restrictedPageMessage() {
  return tabMessage('restricted');
}

function rawMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return String(err.message || err);
}

// Maps scripting/tabs API errors (Chrome and Firefox wording) to a problem code, or null.
function tabErrorCode(err) {
  const msg = rawMessage(err);
  if (/cannot access a chrome|chrome:\/\/|extensions gallery|cannot be scripted|webstore|edge:\/\/|about:|moz-extension|chrome-extension|restricted|privileged|view-source|pdf viewer/i.test(msg)) {
    return 'restricted';
  }
  if (/no tab with id|invalid tab id|tab .*(closed|not found)|no such tab/i.test(msg)) return 'tabGone';
  if (/error page|showing error|frame with id \d+ (was removed|is not)/i.test(msg)) return 'errorPage';
  if (/permission|cannot access contents|host access|not allowed|access .*denied|missing host/i.test(msg)) return 'noAccess';
  if (/receiving end does not exist|could not establish connection|message port closed|disconnected port/i.test(msg)) {
    return 'notReachable';
  }
  return null;
}

// Maps scripting/tabs API errors (Chrome and Firefox wording) to a user-facing message (UI language).
export function describeTabError(err, fallback = tabMessage('injectFailed')) {
  const code = tabErrorCode(err);
  return code ? tabMessage(code) : fallback;
}

async function hasAllSitesAccess() {
  try {
    return typeof ext.permissions?.contains === 'function'
      && (await ext.permissions.contains({ origins: ALL_SITES })) === true;
  } catch {
    return false;
  }
}

// Like describeTabError, but a host-permission error on a file:// page needs the file-URL switch,
// and while access to all websites is granted it means a privileged page (Firefox hides the URL
// of about:newtab, about:home, … from extensions).
async function tabErrorMessage(err, fallback = tabMessage('injectFailed'), tab = null) {
  const code = tabErrorCode(err);
  if (code === 'noAccess' && /^file:/i.test(tab?.url || '')) return tabMessage('fileAccess');
  if (code === 'noAccess' && (await hasAllSitesAccess())) return tabMessage('restricted');
  return code ? tabMessage(code) : fallback;
}

function withTimeout(promise, ms, onTimeout) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(onTimeout()), ms);
    }),
  ]);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getTabSafe(tabId) {
  try {
    return (await ext.tabs.get(tabId)) || null;
  } catch {
    return null;
  }
}

// Only a known URL can be judged; an unknown URL (no permission yet) is attempted anyway.
const knownRestricted = (tab) => Boolean(tab?.url) && isRestrictedUrl(tab.url);

function assertTabId(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error(tabMessage('noTab'));
}

const validFrameId = (frameId) => (Number.isInteger(frameId) && frameId >= 0 ? frameId : 0);

// Query and fragment often carry tokens (password reset, OAuth) – never hand them on.
const stripQuery = (url) => url.split('#')[0].split('?')[0];

export async function getActiveTab() {
  let tabs = [];
  try {
    tabs = await ext.tabs.query({ active: true, currentWindow: true });
    if (!tabs?.length) tabs = await ext.tabs.query({ active: true, lastFocusedWindow: true });
  } catch (err) {
    console.warn('[LLM Sidebar] Could not determine the active tab:', rawMessage(err));
    return null;
  }
  const tab = tabs?.[0];
  if (!tab || !Number.isInteger(tab.id) || tab.id < 0) return null;
  return { id: tab.id, url: tab.url || '', title: tab.title || '', windowId: tab.windowId };
}

// Sends a message to the content script of one frame WITHOUT injecting it first.
// Resolves to the response, or null when nobody answers in time.
export async function tryMessageTab(tabId, message, { frameId = 0, timeoutMs = PING_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  try {
    const res = await withTimeout(
      ext.tabs.sendMessage(tabId, message, { frameId: validFrameId(frameId) }),
      timeoutMs,
      () => null,
    );
    return res ?? null;
  } catch {
    return null;
  }
}

async function ping(tabId, frameId) {
  return (await tryMessageTab(tabId, { type: 'ping' }, { frameId }))?.ok === true;
}

// → { ok: true } | { ok: false, error: message in the UI language }
async function prepareContentScript(tabId, frameId) {
  const tab = await getTabSafe(tabId);
  if (knownRestricted(tab)) return { ok: false, error: tabMessage('restricted') };
  if (await ping(tabId, frameId)) return { ok: true };
  try {
    await ext.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: [CONTENT_SCRIPT] });
  } catch (err) {
    return { ok: false, error: await tabErrorMessage(err, undefined, tab) };
  }
  for (let i = 0; i < PING_RETRIES; i++) {
    if (await ping(tabId, frameId)) return { ok: true };
    await delay(PING_RETRY_DELAY_MS);
  }
  return { ok: false, error: tabMessage('notReachable') };
}

/**
 * Injects the content script into every open web page (all frames). Chrome does not run declared
 * content scripts in tabs that were open before the extension was installed, updated or reloaded;
 * the script's double-injection guard makes it a no-op where an instance is already alive.
 * Failures (no access, error pages, discarded tabs) are skipped. → number of injected tabs.
 */
export async function injectIntoOpenTabs() {
  let tabs = [];
  try {
    tabs = await ext.tabs.query({});
  } catch {
    return 0;
  }
  const targets = (Array.isArray(tabs) ? tabs : []).filter((tab) => Number.isInteger(tab?.id) && tab.id >= 0
    && !tab.discarded && /^(https?|file):/i.test(tab.url || '') && !isRestrictedUrl(tab.url));
  const results = await Promise.all(targets.map(async (tab) => {
    try {
      await ext.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: [CONTENT_SCRIPT] });
      return true;
    } catch {
      return false;
    }
  }));
  return results.filter(Boolean).length;
}

export async function ensureContentScript(tabId, { frameId = 0 } = {}) {
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  return (await prepareContentScript(tabId, validFrameId(frameId))).ok;
}

// Rejects with a message in the UI language. An error the content script reported itself (it is reachable
// and normally shows the problem on the page) carries `code: 'page_error'` and its own
// `pageCode`, if any (e.g. 'tiny_frame').
export async function sendToTab(tabId, message, { frameId = 0 } = {}) {
  assertTabId(tabId);
  const frame = validFrameId(frameId);
  const prepared = await prepareContentScript(tabId, frame);
  if (!prepared.ok) throw new Error(prepared.error);
  let res;
  try {
    res = await ext.tabs.sendMessage(tabId, message, { frameId: frame });
  } catch (err) {
    throw new Error(await tabErrorMessage(err, tabMessage('notReachable')));
  }
  if (res && typeof res === 'object' && res.ok === false) {
    const err = new Error(typeof res.error === 'string' && res.error.trim() ? res.error : tabMessage('actionFailed'));
    err.code = 'page_error';
    if (typeof res.code === 'string') err.pageCode = res.code;
    throw err;
  }
  return res;
}

/**
 * Metadata and transcript of the YouTube video `videoId` shown in the tab (runs
 * extractYouTubeVideo inside the tab). → the extractor's result with ok: true (`problem` translated
 * into the UI language, the raw code in `problemCode`); throws an Error (UI language) when the video
 * cannot be read at all.
 */
export async function getVideoContent(tabId, videoId, { maxChars = 120000 } = {}) {
  assertTabId(tabId);
  const tab = await getTabSafe(tabId);
  if (knownRestricted(tab)) throw new Error(tabMessage('restricted'));
  let results;
  try {
    results = await ext.scripting.executeScript({
      target: { tabId },
      func: extractYouTubeVideo,
      args: [videoId, { maxChars }],
    });
  } catch (err) {
    throw new Error(await tabErrorMessage(err, tabMessage('videoReadFailed'), tab));
  }
  const result = Array.isArray(results) ? results[0]?.result : null;
  if (!result || typeof result !== 'object') throw new Error(tabMessage('videoReadFailed'));
  // The injected extractor reports problems as codes; translate them here.
  const problem = describeVideoProblem(result.problem, result.problemParams);
  if (result.ok !== true) throw new Error(problem || tabMessage('videoReadFailed'));
  return { ...result, problemCode: typeof result.problem === 'string' ? result.problem : '', problem };
}

/** Jumps to `seconds` in the video of the tab. → true when the tab shows that video. */
export async function seekVideoInTab(tabId, videoId, seconds) {
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  try {
    const results = await ext.scripting.executeScript({
      target: { tabId },
      func: seekYouTubeVideo,
      args: [videoId, seconds],
    });
    return Array.isArray(results) && results[0]?.result === true;
  } catch {
    return false;
  }
}

export async function getPageContent(tabId, { maxChars = 60000 } = {}) {
  assertTabId(tabId);
  const tab = await getTabSafe(tabId);
  if (knownRestricted(tab)) throw new Error(tabMessage('restricted'));
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 60000;
  let results;
  try {
    results = await ext.scripting.executeScript({
      target: { tabId },
      func: extractPageContent,
      args: [limit],
    });
  } catch (err) {
    throw new Error(await tabErrorMessage(err, tabMessage('readFailed'), tab));
  }
  const result = Array.isArray(results) ? results[0]?.result : null;
  if (!result || typeof result !== 'object') throw new Error(tabMessage('readFailed'));
  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    title: str(result.title) || str(tab?.title),
    url: str(result.url) || stripQuery(str(tab?.url)),
    lang: str(result.lang),
    description: str(result.description),
    selection: str(result.selection),
    text: str(result.text),
    truncated: result.truncated === true,
  };
}
