// Side panel controller: chat state, sending (chat + image generation), pickers, page context,
// tools menu, history, PendingChat hand-over and keyboard shortcuts (ARCHITECTURE §8).
import { ext } from '../lib/ext.js';
import {
  getSettings, getDefaultSettings, normalizeSettings, updateSettings, onSettingsChanged, getProvider,
  isProviderReady, resolveTarget, listChatModels, listImageModels,
} from '../lib/settings.js';
import { getPreset } from '../lib/providers.js';
import { createChat, createMessage, saveChat, getChat, deleteChat, onChatsChanged } from '../lib/db.js';
import {
  streamChat, generateImage, describeError, fetchBalance, canFetchBalance, supportsBalance, balanceNeedsManagementKey,
} from '../lib/llm.js';
import {
  usageRecord, recordUsage, sumUsage, formatCost, formatMoney, formatTokens, describeUsage,
  getUsageStats, statsRows, monthKey,
} from '../lib/usage.js';
import * as prompts from '../lib/prompts.js';
import {
  buildChatSystemPrompt, buildVideoSummaryPrompt, formatPageContext, formatSelectionQuote, formatVideoContext,
  personaName, promptLanguage,
} from '../lib/prompts.js';
import { initI18n, applyI18n, resolveLanguage, t } from '../lib/i18n.js';
import { AUTO_TARGET, languageLabel, languageOptions, normalizeTargetLanguage } from '../lib/languages.js';
import { h, toast, confirmDialog, promptDialog } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import {
  applyTheme, copyText, debounce, downloadFile, hostnameOf, isRestrictedUrl, normalizeQuote, truncate, MAX_QUOTE_CHARS,
} from '../lib/utils.js';
import {
  getActiveTab, sendToTab, getPageContent, getVideoContent, seekVideoInTab, tryMessageTab,
} from '../lib/tabs.js';
import { isVideoId, parseYouTubeUrl, youTubeWatchUrl } from '../lib/youtube.js';
import { createChatView, IMAGE_SIZES } from './chat-view.js';
import { createComposer, IMAGE_COMMAND } from './composer.js';
import { createHistory } from './history.js';
import { openMenu, openPicker, openPopup, closePopup, isPopupOpen } from './popup.js';
import { chatToMarkdown, chatFilename } from './export.js';

const PENDING_KEY = 'pendingChat';
// "Resume last chat" is remembered per browser window: `${LAST_CHAT_PREFIX}:${windowId}`.
const LAST_CHAT_PREFIX = 'llm-sidebar:sidepanel:lastChat';
const PREFS_KEY = 'llm-sidebar:sidepanel:prefs';
const RESUME_WINDOW = 60 * 60 * 1000;
const TITLE_MAX = 48;
// Default titles of older chats (created before the UI language could change).
const LEGACY_DEFAULT_TITLES = new Set(['Neuer Chat', 'New chat']);

const defaultTitle = () => t('sidepanel.chat.defaultTitle');
const isDefaultTitle = (title) => !title || title === defaultTitle() || LEGACY_DEFAULT_TITLES.has(title);
const errorText = (err) => err?.message || err;

// Welcome chips and the page-summary prompt come from lib/prompts.js. Read them through the
// namespace (function or constant), so they can follow the UI language there.
function suggestions() {
  const value = prompts.getSuggestions();
  return Array.isArray(value) ? value : [];
}

function summarizePagePrompt() {
  return prompts.summarizePagePrompt();
}

const $ = (id) => document.getElementById(id);
const els = {
  main: $('main'),
  historyBtn: $('btn-history'),
  titleBtn: $('chat-title'),
  titleText: $('chat-title-text'),
  newBtn: $('btn-new'),
  toolsBtn: $('btn-tools'),
  settingsBtn: $('btn-settings'),
  modelBtn: $('model-btn'),
  modelDot: $('model-dot'),
  modelLabel: $('model-label'),
  personaBtn: $('persona-btn'),
  personaLabel: $('persona-label'),
  pageChip: $('page-chip'),
  pageChipText: $('page-chip-text'),
  permBanner: $('perm-banner'),
  permGrant: $('perm-grant'),
  scroller: $('scroller'),
  welcome: $('welcome'),
  messages: $('messages'),
  scrollBottom: $('scroll-bottom'),
  composer: $('composer'),
  imageBar: $('image-bar'),
  videoBar: $('video-bar'),
  composerStatus: $('composer-status'),
  composerBox: $('composer-box'),
  attachList: $('attach-list'),
  selectionRef: $('selection-ref'),
  input: $('input'),
  attachBtn: $('btn-attach'),
  imageBtn: $('btn-image-mode'),
  pageBtn: $('btn-page'),
  balanceBtn: $('btn-balance'),
  sendBtn: $('btn-send'),
  fileInput: $('file-input'),
  drawer: $('history'),
  drawerBackdrop: $('drawer-backdrop'),
  dropOverlay: $('drop-overlay'),
};

const state = {
  settings: getDefaultSettings(),
  chat: null,
  saved: false,
  imageMode: false,
  imageSize: '1024x1024',
  imageTarget: null, // { providerId, model } chosen in the image bar
  busy: null, // { controller, chat, messageId }
  tab: null,
  windowId: null,
  lastPendingId: null,
  selection: null, // page selection offered as reference: { text, title, url, truncated?, tabId, frameId }
  selectionIgnored: null, // { tabId, frameId, text } – used or dismissed, not offered again
  videoAttach: null, // YouTube video id whose transcript goes with the next chat message
  videoDismissed: null, // YouTube video id whose offer bar was closed
  videoKey: '', // video shown by the welcome card / video bar (re-render only on change)
};

// Chat objects that have a DB record, and chats deleted elsewhere that must never be saved again.
const storedChats = new WeakSet();
const discardedChats = new WeakSet();

let view;
let composer;
let history;
let uiLanguage = null; // UI language the panel was rendered in (resolved from the setting)

// ------------------------------------------------------------------------------------------
// Small helpers

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable – preferences are optional
  }
}

function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.querySelector(':scope > svg.icon')) continue;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, { size: Number(el.dataset.iconSize) || 18 }));
  }
}

function hashHue(text) {
  let hash = 0;
  for (const ch of String(text)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash % 360;
}

function providerColor(provider) {
  if (!provider) return 'var(--text-faint)';
  if (provider.presetId === 'custom') return `hsl(${hashHue(provider.id)} 62% 52%)`;
  return getPreset(provider.presetId)?.color || 'var(--accent)';
}

function providerLabel(msg) {
  const name = getProvider(state.settings, msg.providerId)?.name || '';
  if (msg.model) return name ? `${name} · ${msg.model}` : msg.model;
  return name || t('sidepanel.message.assistant');
}

function findPersona(id) {
  const personas = state.settings.personas || [];
  return personas.find((p) => p.id === id) || personas.find((p) => p.id === 'default') || personas[0] || null;
}

function sendWithEnter() {
  return state.settings?.general?.sendWithEnter !== false;
}

function isSendKey(event) {
  if (event.key !== 'Enter' || event.isComposing) return false;
  if (sendWithEnter()) return !event.shiftKey && !event.altKey;
  return event.ctrlKey || event.metaKey;
}

function makeTitle(text) {
  return truncate(String(text || '').replace(/\s+/g, ' ').trim(), TITLE_MAX) || defaultTitle();
}

async function openOptions() {
  try {
    await ext.runtime.openOptionsPage();
  } catch {
    try {
      await ext.tabs.create({ url: ext.runtime.getURL('options/options.html') });
    } catch (err) {
      toast(t('sidepanel.errors.openSettings', { error: errorText(err) }), { type: 'error' });
    }
  }
}

// An empty URL means "unknown" (e.g. no host permission yet), not "restricted" – try anyway.
function knownRestricted(url) {
  return Boolean(url) && isRestrictedUrl(url);
}

/** The browser window this panel belongs to (side panels / sidebars exist per window). */
async function resolveWindowId() {
  try {
    const win = await ext.windows?.getCurrent?.();
    if (Number.isInteger(win?.id) && win.id >= 0) return win.id;
  } catch {
    // fall back to the active tab's window
  }
  try {
    const tab = await getActiveTab();
    if (Number.isInteger(tab?.windowId) && tab.windowId >= 0) return tab.windowId;
  } catch {
    // unknown
  }
  return null;
}

// ------------------------------------------------------------------------------------------
// Targets

function resolveChatTarget(chat = state.chat) {
  const settings = state.settings;
  if (chat?.providerId) {
    const provider = getProvider(settings, chat.providerId);
    if (provider && isProviderReady(provider)) {
      const model = chat.model || provider.defaultModel || provider.models?.[0];
      if (model) return { provider, model };
    }
  }
  return resolveTarget(settings, 'chat');
}

function resolveImageTarget() {
  const settings = state.settings;
  const chosen = state.imageTarget;
  if (chosen) {
    const provider = getProvider(settings, chosen.providerId);
    if (provider && isProviderReady(provider) && provider.imageApi && provider.imageApi !== 'none' && chosen.model) {
      return { provider, model: chosen.model };
    }
  }
  return resolveTarget(settings, 'image');
}

function notifyNoProvider() {
  toast(t('sidepanel.errors.noProvider'), { type: 'error', timeout: 6000 });
  renderWelcome();
}

function notifyNoImageProvider() {
  if (!state.imageMode) setImageMode(true);
  toast(t('sidepanel.image.noModelToast'), { type: 'warning', timeout: 4000 });
}

// ------------------------------------------------------------------------------------------
// Persistence

function lastChatKey() {
  return state.windowId == null ? LAST_CHAT_PREFIX : `${LAST_CHAT_PREFIX}:${state.windowId}`;
}

function rememberChat() {
  if (state.saved && state.chat?.messages.length) writeJson(lastChatKey(), { id: state.chat.id, ts: Date.now() });
  else writeJson(lastChatKey(), null);
}

// Drops expired resume entries of other (closed) windows and the old global key.
function pruneResumeKeys() {
  try {
    const own = lastChatKey();
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith(LAST_CHAT_PREFIX) || key === own) continue;
      if (!(Date.now() - Number(readJson(key)?.ts) < RESUME_WINDOW)) localStorage.removeItem(key);
    }
  } catch {
    // storage unavailable
  }
}

/** Saves the chat. snapshot: store the current message list (later pushes are not included). */
async function persist(chat, { keepTime = false, snapshot = false } = {}) {
  if (!chat?.messages.length || discardedChats.has(chat)) return false;
  try {
    // A chat deleted elsewhere (other panel, options page) must not be brought back.
    if (storedChats.has(chat) && !(await getChat(chat.id))) {
      dropChat(chat, { notice: t('sidepanel.chat.deletedElsewhere') });
      return false;
    }
    if (discardedChats.has(chat)) return false;
    const record = snapshot ? { ...chat, messages: chat.messages.slice() } : chat;
    await saveChat(record, { keepTime });
    if (discardedChats.has(chat)) {
      // Deleted while this write was in flight – undo it.
      deleteChat(chat.id).catch(() => {});
      return false;
    }
    chat.updatedAt = record.updatedAt;
    storedChats.add(chat);
    if (chat === state.chat) {
      state.saved = true;
      rememberChat();
    }
    return true;
  } catch (err) {
    toast(t('sidepanel.errors.saveChat', { error: errorText(err) }), { type: 'error' });
    return false;
  }
}

/**
 * The chat must not be saved any more (deleted here or elsewhere): stop its request and,
 * if it is the open chat, switch to a fresh one.
 */
function dropChat(chat, { notice = '' } = {}) {
  if (!chat) return;
  discardedChats.add(chat);
  storedChats.delete(chat);
  if (state.busy?.chat === chat) stopGeneration();
  if (state.chat !== chat) return;
  state.saved = false;
  setChat(newChatObject());
  if (notice) toast(notice, { timeout: 5000 });
}

/** Re-checks the open chat against the DB after a change made by another page (C8). */
async function syncCurrentChat() {
  const chat = state.chat;
  if (!chat || !storedChats.has(chat) || discardedChats.has(chat)) return;
  let stored;
  try {
    stored = await getChat(chat.id);
  } catch {
    return;
  }
  if (chat !== state.chat || discardedChats.has(chat)) return;
  if (!stored) {
    dropChat(chat, { notice: t('sidepanel.chat.deletedElsewhere') });
    return;
  }
  if (state.busy || view.isEditing()) return;
  if (Number(stored.updatedAt) > Number(chat.updatedAt)) setChat(createChat(stored), { saved: true });
}

function handleChatsChanged(event) {
  history?.refresh();
  if (!event || typeof event !== 'object') return;
  // Deferred, so the continuation of our own write (state.saved, updatedAt) has run first.
  setTimeout(() => {
    const chat = state.chat;
    if (!chat) return;
    const own = event.id === chat.id;
    if ((event.type === 'deleted' && own) || event.type === 'cleared' || event.type === 'imported'
      || (event.type === 'saved' && own && Number(event.updatedAt) > Number(chat.updatedAt))) {
      syncCurrentChat();
    }
  }, 0);
}

// ------------------------------------------------------------------------------------------
// Chat lifecycle

function newChatObject() {
  return createChat({
    title: defaultTitle(),
    personaId: findPersona(state.settings.chat.personaId)?.id || 'default',
    includePage: Boolean(state.settings.chat.includePageByDefault),
  });
}

function setChat(chat, { saved = false } = {}) {
  if (state.busy) stopGeneration();
  state.chat = chat;
  state.saved = saved;
  if (saved) storedChats.add(chat);
  if (typeof chat.includePage !== 'boolean') chat.includePage = Boolean(state.settings.chat.includePageByDefault);
  view.render(chat);
  renderWelcome();
  renderHeader();
  renderModelButton();
  renderPersonaButton();
  renderPageChip();
  renderVideoBar();
  rememberChat();
}

function newChat({ focus = true } = {}) {
  history.close({ restoreFocus: false });
  if (!state.chat.messages.length && !state.busy) {
    if (focus) composer.focus();
    return;
  }
  setChat(newChatObject());
  if (focus) composer.focus();
}

async function openChatById(id) {
  if (state.chat?.id === id) {
    composer.focus();
    return;
  }
  try {
    const stored = await getChat(id);
    if (!stored) {
      toast(t('sidepanel.chat.notFound'), { type: 'error' });
      history.refresh();
      return;
    }
    setChat(createChat(stored), { saved: true });
    composer.focus();
  } catch (err) {
    toast(err?.message || t('sidepanel.errors.loadChat'), { type: 'error' });
  }
}

async function openInitialChat() {
  const last = readJson(lastChatKey());
  if (last?.id && Date.now() - Number(last.ts) < RESUME_WINDOW) {
    try {
      const stored = await getChat(last.id);
      if (stored?.messages?.length) {
        setChat(createChat(stored), { saved: true });
        return;
      }
    } catch {
      // fall through to a fresh chat
    }
  }
  setChat(newChatObject());
}

function pushMessage(msg) {
  const chat = state.chat;
  chat.messages.push(msg);
  if (msg.role === 'user' && !chat.titleEdited && isDefaultTitle(chat.title)) {
    chat.title = makeTitle(msg.content || (msg.attachments.length ? t('sidepanel.chat.imageAnalysisTitle') : ''));
    renderHeader();
  }
  renderWelcome();
  view.append(msg);
}

// ------------------------------------------------------------------------------------------
// Usage and costs

/** Stores the request's usage on the message and adds it to the statistics (via the background). */
function trackUsage(msg, target, usage, { kind = 'chat' } = {}) {
  const record = usageRecord(target.provider, target.model, usage, { kind });
  if (record) msg.usage = record;
  const entry = {
    providerId: target.provider.id, providerName: target.provider.name, model: target.model, usage: record,
  };
  Promise.resolve()
    .then(() => ext.runtime.sendMessage({ type: 'recordUsage', entry }))
    .then((res) => {
      if (!res?.ok) throw new Error(res?.error || 'no response');
    })
    // Background unreachable: write directly (the statistics are only a convenience).
    .catch(() => recordUsage(entry));
}

/** Header label of an answer: { text, title } or null. */
function usageLabel(msg) {
  if (state.settings.usage?.showInChat === false || !msg.usage) return null;
  const u = msg.usage;
  const tokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  const parts = [];
  if (tokens) parts.push(t('sidepanel.usage.tokens', { tokens: formatTokens(tokens) }));
  const cost = formatCost(u);
  if (cost) parts.push(cost);
  if (!parts.length) return null;
  return { text: parts.join(' · '), title: describeUsage(u) };
}

function chatCostSummary(chat) {
  const total = sumUsage(chat.messages.filter((m) => m.role === 'assistant').map((m) => m.usage));
  if (!total.requests) return null;
  const tokens = t('sidepanel.usage.tokens', { tokens: formatTokens(total.inputTokens + total.outputTokens) });
  if (!total.priced) return { label: t('sidepanel.usage.costUnknown'), hint: tokens };
  return { label: costText(total), hint: tokens };
}

/** Total cost: "≈ 0,12 $" when estimated, "mind. 0,12 $" when some requests have no known price (lower bound). */
function costText(total) {
  const amount = formatMoney(total.cost);
  if (total.unpriced) return t('sidepanel.usage.atLeast', { amount });
  return total.estimated ? `≈ ${amount}` : amount;
}

async function showBalance(provider) {
  toast(t('sidepanel.balance.fetching', { provider: provider.name }));
  try {
    const res = await fetchBalance(provider);
    const main = res.balances.map((b) => `${b.label}: ${formatMoney(b.amount, b.currency)}`);
    const extra = res.details.slice(0, 2).map((d) => `${d.label}: ${formatMoney(d.amount, d.currency)}`);
    const lines = [...main, ...extra];
    if (!main.length && res.notes.length) lines.push(res.notes[0]);
    toast(`${provider.name} – ${lines.join(' · ') || t('sidepanel.balance.noData')}`, { type: 'success', timeout: 9000 });
  } catch (err) {
    toast(describeError(err), { type: 'error', timeout: 8000 });
  }
}

// ------------------------------------------------------------------------------------------
// Balance popover (composer button): remaining credit of every set-up provider.

const BALANCE_CACHE_MS = 60 * 1000;
const balanceCache = new Map(); // providerId → { sig, at, promise }
const LOCAL_PRESETS = new Set(['ollama', 'lmstudio']);

function balanceSig(provider) {
  const tail = (v) => String(v || '').slice(-6);
  return `${provider.baseUrl}|${tail(provider.apiKey)}|${tail(provider.billing?.managementKey)}|${provider.billing?.teamId || ''}`;
}

function cachedBalance(provider, { force = false } = {}) {
  const sig = balanceSig(provider);
  const hit = balanceCache.get(provider.id);
  if (!force && hit && hit.sig === sig && Date.now() - hit.at < BALANCE_CACHE_MS) return hit.promise;
  const promise = fetchBalance(provider);
  const entry = { sig, at: Date.now(), promise };
  balanceCache.set(provider.id, entry);
  promise.catch(() => {
    if (balanceCache.get(provider.id) === entry) balanceCache.delete(provider.id); // retry errors next time
  });
  return promise;
}

/** One-line summary of a fetchBalance() result: { text, title }. */
function balanceSummary(res) {
  const lines = [
    ...res.balances.map((b) => `${b.label}: ${formatMoney(b.amount, b.currency)}`),
    ...res.details.map((d) => `${d.label}: ${formatMoney(d.amount, d.currency)}`),
    ...res.notes,
  ];
  if (res.balances.length) {
    return { text: res.balances.map((b) => formatMoney(b.amount, b.currency)).join(' · '), title: lines.join('\n'), ok: true };
  }
  // OpenRouter without a key limit: only the spending is known (prefer this month's).
  const spent = res.details.find((d) => d.id === 'usage_monthly') || res.details[res.details.length - 1];
  if (spent) return { text: t('sidepanel.balance.spent', { amount: formatMoney(spent.amount, spent.currency) }), title: lines.join('\n'), ok: false };
  return { text: t('sidepanel.balance.none'), title: lines.join('\n'), ok: false };
}

function balanceProviders() {
  const current = resolveChatTarget()?.provider;
  const list = state.settings.providers.filter((p) => isProviderReady(p) && !LOCAL_PRESETS.has(p.presetId)
    && (p.apiKey || getPreset(p.presetId).requiresKey));
  return list.sort((a, b) => (b.id === current?.id) - (a.id === current?.id));
}

function balanceRow(provider) {
  const preset = getPreset(provider.presetId);
  const value = h('span', { class: 'bal-value' });
  const row = h('div', { class: 'bal-row' },
    h('span', { class: 'bal-dot', style: { background: providerColor(provider) }, 'aria-hidden': 'true' }),
    h('span', { class: 'bal-name truncate', title: provider.name }, provider.name),
    value);
  const link = (label, href) => h('a', { class: 'bal-link', href, target: '_blank', rel: 'noopener noreferrer' }, label);

  if (canFetchBalance(provider)) {
    value.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, t('sidepanel.balance.loading')));
    value.setAttribute('aria-busy', 'true');
    cachedBalance(provider).then((res) => {
      const summary = balanceSummary(res);
      value.replaceChildren(h('span', { class: summary.ok ? 'bal-amount' : 'bal-muted' }, summary.text));
      value.title = summary.title;
    }, (err) => {
      value.replaceChildren(h('span', { class: 'bal-error' }, t('sidepanel.balance.error')));
      value.title = describeError(err);
    }).finally(() => value.removeAttribute('aria-busy'));
  } else if (supportsBalance(provider) && balanceNeedsManagementKey(provider)) {
    value.append(h('button', {
      type: 'button', class: 'bal-link', title: t('sidepanel.balance.needsManagementKey'),
      onClick: () => {
        closePopup();
        openCostSettings();
      },
    }, t('sidepanel.balance.setup')));
  } else if (preset.billingUrl) {
    value.append(link(t('sidepanel.balance.viewInAccount'), preset.billingUrl));
    value.title = t('sidepanel.balance.notViaApi', { provider: provider.name });
  } else {
    value.append(h('span', { class: 'bal-muted' }, t('sidepanel.balance.unavailable')));
  }
  return row;
}

function openBalancePopover() {
  const providers = balanceProviders();
  const monthCost = h('span', { class: 'bal-muted' }, '…');
  getUsageStats().then((stats) => {
    const { total } = statsRows(stats, monthKey());
    monthCost.textContent = total.requests ? costText(total) : formatMoney(0);
  }, () => {
    monthCost.textContent = '–';
  });
  const chat = chatCostSummary(state.chat);
  const el = h('div', { class: 'menu bal-pop', role: 'dialog', 'aria-label': t('sidepanel.balance.title') },
    h('div', { class: 'bal-head' },
      h('span', { class: 'bal-title' }, t('sidepanel.balance.title')),
      h('button', {
        type: 'button', class: 'btn-icon btn-sm', title: t('sidepanel.balance.refresh'), 'aria-label': t('sidepanel.balance.refresh'),
        html: icon('refresh', { size: 14 }),
        onClick: () => {
          for (const p of providers) if (canFetchBalance(p)) cachedBalance(p, { force: true }).catch(() => {});
          closePopup();
          openBalancePopover();
        },
      })),
    providers.length
      ? h('div', { class: 'bal-list' }, providers.map(balanceRow))
      : h('p', { class: 'bal-empty' }, t('sidepanel.balance.empty')),
    h('div', { class: 'bal-foot' },
      h('div', { class: 'bal-row' }, h('span', { class: 'bal-name' }, t('sidepanel.balance.thisChat')),
        h('span', { class: 'bal-muted' }, chat ? chat.label : formatMoney(0))),
      h('div', { class: 'bal-row' }, h('span', { class: 'bal-name' }, t('sidepanel.balance.thisMonth')), monthCost),
      h('button', {
        type: 'button', class: 'bal-link bal-more',
        onClick: () => {
          closePopup();
          openCostSettings();
        },
      }, t('sidepanel.balance.openCosts'))));
  openPopup(els.balanceBtn, el, { placement: 'top-start', initialFocus: () => el.querySelector('button, a') });
}

async function openCostSettings() {
  try {
    await ext.tabs.create({ url: ext.runtime.getURL('options/options.html#kosten') });
  } catch {
    openOptions();
  }
}

// ------------------------------------------------------------------------------------------
// Requests

function beginRun(assistant) {
  const run = { controller: new AbortController(), chat: state.chat, messageId: assistant.id };
  state.busy = run;
  view.setBusy(assistant.id);
  composer.setBusy(true);
  return run;
}

let idleWaiters = [];

/** Resolves once no request is running (PendingChats wait for this instead of aborting). */
function whenIdle() {
  if (!state.busy) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

function releaseRun(run) {
  state.busy = null;
  if (state.chat === run.chat) view.setBusy(null);
  composer.setBusy(false);
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const resolve of waiters) resolve();
}

function endRun(run) {
  if (state.busy === run) releaseRun(run);
}

const isCurrentRun = (run) => state.chat === run.chat;

function stopGeneration() {
  const run = state.busy;
  if (!run) return;
  run.controller.abort();
  // Release the UI right away; the request settles (and saves) on its own.
  releaseRun(run);
}

function applyError(msg, err) {
  const partial = err?.partial;
  if (partial) {
    if (partial.text) msg.content = partial.text;
    if (partial.reasoning) msg.reasoning = partial.reasoning;
    if (Array.isArray(partial.images) && partial.images.length && !msg.images.length) {
      msg.images = partial.images.map((src) => ({ src, prompt: '' }));
    }
  }
  if (err?.code === 'aborted' || err?.name === 'AbortError') {
    msg.stopped = true;
    msg.error = null;
  } else {
    msg.error = describeError(err);
  }
}

async function finishRun(run, assistant) {
  endRun(run);
  if (isCurrentRun(run)) view.updateNow(assistant);
  await persist(run.chat);
}

/** LLM messages from the chat history (last N, page contexts de-duplicated per URL). */
function buildRequestMessages(history, limit) {
  const failed = (m) => m?.role === 'assistant' && m.error && !m.content?.trim();
  // Page context only counts together with its visible page reference (no hidden context
  // smuggled in through imported chats); attachments must be image data URLs.
  const contextOf = (m) => (m.page && typeof m.context === 'string' ? m.context : '');
  const imagesOf = (m) => (Array.isArray(m.attachments) ? m.attachments : [])
    .filter((a) => typeof a?.dataUrl === 'string' && /^data:image\//i.test(a.dataUrl));
  const usable = history.filter((m, i) => {
    if (m.kind === 'image') return false;
    // A turn that only produced an error is dropped completely, so e.g. an image the
    // model rejected does not break every following request of this chat.
    if (m.role === 'user') return Boolean(m.content || contextOf(m) || m.quote || imagesOf(m).length) && !failed(history[i + 1]);
    return Boolean(m.content?.trim()) && !m.error;
  });
  const slice = usable.slice(-Math.max(1, Number(limit) || 30));
  // A long conversation about a video keeps the latest transcript, even when the message that
  // carried it no longer fits into the context window.
  const lastVideo = [...usable].reverse().find((m) => m.role === 'user' && isVideoId(m.video?.id) && contextOf(m));
  const keptVideoContext = lastVideo && !slice.includes(lastVideo) ? contextOf(lastVideo) : '';
  const seenPages = new Set();
  const out = [];
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    const m = slice[i];
    if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.content });
      continue;
    }
    let context = contextOf(m);
    const url = m.page?.url;
    if (context && url) {
      if (seenPages.has(url)) {
        const page = m.page.title || url;
        // Sent to the model, not shown: follows the prompt language (German UI → German, else English).
        context = promptLanguage() === 'de'
          ? `(Seitenkontext von „${page}“ ausgelassen – eine aktuellere Fassung derselben Seite folgt weiter unten.)`
          : `(Page context of "${page}" omitted – a more recent version of the same page follows further below.)`;
      } else {
        seenPages.add(url);
      }
    }
    const text = [context, formatSelectionQuote(m.quote), m.content].filter(Boolean).join('\n\n');
    const images = imagesOf(m).map((a) => ({ type: 'image', dataUrl: a.dataUrl }));
    if (images.length) out.push({ role: 'user', content: text ? [...images, { type: 'text', text }] : images });
    else out.push({ role: 'user', content: text });
  }
  if (keptVideoContext) out.push({ role: 'user', content: keptVideoContext });
  return out.reverse();
}

/** Id of the YouTube video the latest video message among `messages` refers to, or null. */
function latestVideoId(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === 'user' && m.page && isVideoId(m.video?.id)) return m.video.id;
  }
  return null;
}

async function runCompletion(run, assistant, target) {
  const chat = run.chat;
  const settings = state.settings;
  const index = chat.messages.indexOf(assistant);
  const messages = buildRequestMessages(chat.messages.slice(0, index), settings.chat.contextMessages);
  const system = buildChatSystemPrompt(settings, findPersona(chat.personaId));
  try {
    const result = await streamChat({
      provider: target.provider,
      model: target.model,
      messages,
      system,
      temperature: settings.chat.temperature,
      maxTokens: settings.chat.maxTokens,
      signal: run.controller.signal,
      stream: settings.general.streaming !== false,
      onText: (_delta, full) => {
        assistant.content = full;
        if (isCurrentRun(run)) view.update(assistant);
      },
      onReasoning: (_delta, full) => {
        assistant.reasoning = full;
        if (isCurrentRun(run)) view.update(assistant);
      },
    });
    assistant.content = result.text || '';
    assistant.reasoning = result.reasoning || assistant.reasoning || '';
    if (Array.isArray(result.images) && result.images.length) {
      assistant.images = result.images.map((src) => ({ src, prompt: '' }));
    }
    if (result.finishReason === 'length') assistant.truncated = true;
    trackUsage(assistant, target, result.usage);
  } catch (err) {
    applyError(assistant, err);
    // Stopped mid-answer: the tokens so far are billed anyway.
    if (err?.partial?.usage) trackUsage(assistant, target, err.partial.usage);
  }
}

/** "(3) Titel - YouTube" → "Titel". */
function videoTitleOf(title) {
  return String(title || '').replace(/^\(\d+\+?\)\s*/, '').replace(/\s*[-–]\s*YouTube\s*$/i, '').trim();
}

/** The YouTube video shown in the active tab: its id, or null. */
function activeVideoId() {
  return parseYouTubeUrl(state.tab?.url || '');
}

/**
 * Reads the YouTube video of the tab (metadata + transcript). → { page, problem, notice } like
 * readActivePage; page.video holds the extractor result. A video without transcript is still
 * usable (title, description, chapters) – that only yields a notice.
 */
async function readVideo(tab, videoId) {
  try {
    const video = await getVideoContent(tab.id, videoId);
    const page = { title: video.title || videoTitleOf(tab.title), url: youTubeWatchUrl(videoId), video };
    const notice = video.transcript ? '' : t('sidepanel.video.metadataOnly', { problem: video.problem || t('sidepanel.video.noTranscript') });
    return { page, problem: '', notice };
  } catch (err) {
    return { page: null, problem: String(err?.message || t('sidepanel.video.readFailed')).replace(/\.?\s*$/, '.'), notice: '' };
  }
}

/** → { page, problem, notice? }: page is null when it could not be read; problem is a sentence in the UI language. */
async function readActivePage() {
  const tab = await refreshActiveTab();
  if (!tab?.id) return { page: null, problem: t('sidepanel.page.noActiveTab') };
  if (knownRestricted(tab.url)) {
    return { page: null, problem: t('sidepanel.page.restricted') };
  }
  const videoId = parseYouTubeUrl(tab.url);
  if (videoId) return readVideo(tab, videoId);
  try {
    const page = await getPageContent(tab.id);
    if (!page) throw new Error(t('sidepanel.page.noContent'));
    const result = { ...page, title: page.title || tab.title || '', url: page.url || tab.url || '' };
    if (!String(result.text || '').trim() && !String(result.selection || '').trim()) {
      return { page: result, problem: t('sidepanel.page.noText') };
    }
    return { page: result, problem: '' };
  } catch (err) {
    return { page: null, problem: String(err?.message || t('sidepanel.page.readFailed')).replace(/\.?\s*$/, '.') };
  }
}

/**
 * Sends a chat message. Returns false (without side effects) when no provider is ready.
 * requirePage: the prompt only makes sense with the page (summary, page suggestions) – it is
 * not sent at all when the page cannot be read.
 */
function startChat({ text, attachments = [], includePage = false, requirePage = false, quote = null }) {
  const target = resolveChatTarget();
  if (!target) {
    notifyNoProvider();
    return false;
  }
  const user = createMessage({
    role: 'user', kind: 'chat', content: text, attachments, quote: quote || undefined, requirePage: requirePage || undefined,
  });
  pushMessage(user);
  runChatTurn(target, { user, includePage: includePage || requirePage, requirePage });
  return true;
}

/** Turn options for re-sending `user`: a page-only prompt whose page was never read reads it again. */
function resendOptions(user) {
  return user?.requirePage && !user.context ? { user, includePage: true, requirePage: true } : {};
}

/** Appends an assistant answer for the chat's current last user message. */
async function runChatTurn(target, { user = null, includePage = false, requirePage = false } = {}) {
  const chat = state.chat;
  chat.providerId = target.provider.id;
  chat.model = target.model;
  renderModelButton();
  persist(chat, { snapshot: true });

  const assistant = createMessage({ role: 'assistant', kind: 'chat', providerId: target.provider.id, model: target.model });
  chat.messages.push(assistant);
  const readingVideo = includePage && user && Boolean(activeVideoId());
  view.append(assistant, { status: includePage ? t(readingVideo ? 'sidepanel.status.readingVideo' : 'sidepanel.status.readingPage') : '' });
  const run = beginRun(assistant);

  if (includePage && user) {
    const { page, problem, notice } = await readActivePage();
    if (run.controller.signal.aborted) {
      assistant.stopped = true;
      await finishRun(run, assistant);
      return;
    }
    if (problem && requirePage) {
      assistant.error = t('sidepanel.page.notSent', { problem });
      await finishRun(run, assistant);
      return;
    }
    if (problem) {
      toast(t(page ? 'sidepanel.page.titleOnly' : 'sidepanel.page.withoutContent', { problem }), { type: 'warning', timeout: 5000 });
    }
    if (notice) toast(notice, { type: 'warning', timeout: 6000 });
    if (page) {
      const context = page.video ? formatVideoContext(page.video) : formatPageContext(page);
      if (context) {
        user.context = context;
        user.page = { title: page.title || '', url: page.url || '' };
        if (page.video) {
          user.video = {
            id: page.video.id,
            title: page.video.title || '',
            transcript: Boolean(page.video.transcript),
          };
        }
        if (isCurrentRun(run)) view.updateNow(user);
      }
    }
    if (isCurrentRun(run)) view.setStatus(assistant.id, '');
  }

  // Timestamps in the answer link into the video this conversation is about.
  const videoId = latestVideoId(chat.messages.slice(0, chat.messages.indexOf(assistant)));
  if (videoId) assistant.video = { id: videoId };
  if (chat === state.chat) renderVideoUi();

  await runCompletion(run, assistant, target);
  await finishRun(run, assistant);
}

/** Starts an image generation. Returns false when no image-capable provider is ready. */
function startImage(prompt, { user = null } = {}) {
  const target = resolveImageTarget();
  if (!target) {
    notifyNoImageProvider();
    return false;
  }
  let request = user;
  if (!request) {
    request = createMessage({ role: 'user', kind: 'image', content: prompt, size: state.imageSize });
    pushMessage(request);
  }
  runImageTurn(target, request);
  return true;
}

async function runImageTurn(target, user) {
  const chat = state.chat;
  const size = user.size || state.imageSize;
  persist(chat, { snapshot: true });
  const assistant = createMessage({
    role: 'assistant', kind: 'image', providerId: target.provider.id, model: target.model, size,
  });
  chat.messages.push(assistant);
  view.append(assistant, { status: t('sidepanel.status.generatingImage') });
  const run = beginRun(assistant);
  try {
    const res = await generateImage({
      provider: target.provider, model: target.model, prompt: user.content, size, signal: run.controller.signal,
    });
    assistant.images = (res.images || []).map((img) => ({ src: img.src, prompt: img.revisedPrompt || user.content }));
    assistant.content = res.text || '';
    trackUsage(assistant, target, res.usage, { kind: 'image' });
  } catch (err) {
    applyError(assistant, err);
  }
  await finishRun(run, assistant);
}

function submitComposer() {
  if (state.busy || composer.isProcessing()) return;
  const text = composer.getText().trim();
  const attachments = composer.getAttachments();
  const command = IMAGE_COMMAND.exec(text);

  if (state.imageMode || command) {
    const prompt = command ? text.slice(command[0].length).trim() : text;
    if (!prompt) {
      toast(command ? t('sidepanel.image.describeAfterCommand', { command: `/${command[1]}` }) : t('sidepanel.image.describe'), { type: 'warning' });
      return;
    }
    if (startImage(prompt)) {
      composer.clearText();
      if (attachments.length) toast(t('sidepanel.image.attachmentsIgnored'), { timeout: 4500 });
    }
    return;
  }

  if (!text && !attachments.length) return;
  const quote = state.selection;
  // "Fragen zum Video": the transcript goes with this one message, later ones use the history.
  const withVideo = Boolean(state.videoAttach) && state.videoAttach === activeVideoId();
  if (startChat({ text, attachments, includePage: Boolean(state.chat.includePage) || withVideo, quote })) {
    composer.clear();
    if (quote) dismissSelection(); // used once – the message keeps it
    if (state.videoAttach) setVideoAttach(null);
  }
}

function regenerate(msg) {
  if (state.busy) return;
  const chat = state.chat;
  const index = chat.messages.indexOf(msg);
  if (index < 0) return;
  const prev = chat.messages[index - 1];
  if (!prev || prev.role !== 'user') {
    toast(t('sidepanel.message.nothingToResend'), { type: 'warning' });
    return;
  }
  if (prev.kind === 'image') {
    const target = resolveImageTarget();
    if (!target) {
      notifyNoImageProvider();
      return;
    }
    chat.messages.splice(index);
    view.render(chat);
    runImageTurn(target, prev);
  } else {
    const target = resolveChatTarget();
    if (!target) {
      notifyNoProvider();
      return;
    }
    chat.messages.splice(index);
    view.render(chat);
    runChatTurn(target, resendOptions(prev));
  }
}

function editAndResend(msg, text) {
  if (state.busy) return;
  const chat = state.chat;
  const index = chat.messages.indexOf(msg);
  if (index < 0) return;
  const command = IMAGE_COMMAND.exec(text);
  const isImage = msg.kind === 'image' || Boolean(command);
  const content = command ? text.slice(command[0].length).trim() : text;
  if (isImage && !content) {
    toast(t('sidepanel.image.describe'), { type: 'warning' });
    view.startEdit(msg.id);
    return;
  }
  const target = isImage ? resolveImageTarget() : resolveChatTarget();
  if (!target) {
    view.cancelEdit();
    if (isImage) notifyNoImageProvider();
    else notifyNoProvider();
    return;
  }
  msg.content = content;
  msg.kind = isImage ? 'image' : 'chat';
  if (isImage && !msg.size) msg.size = state.imageSize;
  chat.messages.splice(index + 1);
  const firstUser = chat.messages.find((m) => m.role === 'user');
  if (firstUser === msg && !chat.titleEdited) {
    chat.title = makeTitle(content);
    renderHeader();
  }
  view.render(chat);
  if (isImage) runImageTurn(target, msg);
  else runChatTurn(target, resendOptions(msg));
}

async function deleteMessage(msg) {
  if (state.busy) return;
  const chat = state.chat;
  const index = chat.messages.indexOf(msg);
  if (index < 0) return;
  chat.messages.splice(index, 1);
  view.remove(msg.id);
  if (!chat.messages.length) {
    // The now empty chat starts over: no DB record, and the next message names it again.
    const wasSaved = state.saved;
    state.saved = false;
    storedChats.delete(chat);
    if (!chat.titleEdited) chat.title = defaultTitle();
    renderHeader();
    rememberChat();
    renderWelcome();
    if (wasSaved) {
      try {
        await deleteChat(chat.id);
      } catch (err) {
        toast(err?.message || t('sidepanel.errors.deleteChat'), { type: 'error' });
      }
    }
  } else {
    await persist(chat, { keepTime: true });
  }
  toast(t('sidepanel.message.deleted'));
}

async function copyMessage(msg, btn) {
  const ok = await copyText(msg.content || '');
  if (!ok) {
    toast(t('sidepanel.message.copyFailed'), { type: 'error' });
    return;
  }
  toast(t('sidepanel.message.copied'), { type: 'success', timeout: 1600 });
  if (btn?.isConnected) {
    btn.innerHTML = icon('check', { size: 15 });
    btn.classList.add('copied');
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.innerHTML = icon('copy', { size: 15 });
      btn.classList.remove('copied');
    }, 1500);
  }
}

function editLastUserMessage() {
  if (state.busy) return false;
  const last = [...state.chat.messages].reverse().find((m) => m.role === 'user');
  return last ? view.startEdit(last.id) : false;
}

// ------------------------------------------------------------------------------------------
// Header & sub-header

function renderHeader() {
  const stored = state.chat?.title;
  // An unnamed chat shows the default title of the current UI language.
  const title = isDefaultTitle(stored) && !state.chat?.titleEdited ? defaultTitle() : stored;
  els.titleText.textContent = title;
  els.titleBtn.title = t('sidepanel.header.titleHint', { title });
  els.titleBtn.setAttribute('aria-label', t('sidepanel.header.titleLabel', { title }));
}

async function renameCurrentChat() {
  const value = await promptDialog(t('sidepanel.rename.title'), {
    value: state.chat.title, okText: t('sidepanel.rename.save'), placeholder: t('sidepanel.rename.placeholder'), maxLength: 120,
  });
  const title = value?.trim();
  if (!title || title === state.chat.title) return;
  state.chat.title = title;
  state.chat.titleEdited = true;
  renderHeader();
  if (state.saved) await persist(state.chat, { keepTime: true });
}

function renderModelButton() {
  const target = resolveChatTarget();
  const { modelBtn, modelLabel, modelDot } = els;
  if (!target) {
    modelLabel.textContent = t('sidepanel.model.none');
    modelDot.style.background = 'var(--warning)';
    modelBtn.classList.add('is-missing');
    modelBtn.title = t('sidepanel.model.noneHint');
    modelBtn.setAttribute('aria-label', t('sidepanel.model.noneLabel'));
    return;
  }
  const info = target.provider.modelInfo?.[target.model];
  modelLabel.textContent = info?.name || target.model;
  modelDot.style.background = providerColor(target.provider);
  modelBtn.classList.remove('is-missing');
  const chosen = state.chat?.providerId;
  const fallback = Boolean(chosen) && chosen !== target.provider.id;
  modelBtn.classList.toggle('is-fallback', fallback);
  const names = { provider: target.provider.name, model: target.model };
  modelBtn.title = t(fallback ? 'sidepanel.model.buttonTitleFallback' : 'sidepanel.model.buttonTitle', names);
  modelBtn.setAttribute('aria-label', t('sidepanel.model.buttonLabel', names));
}

function modelItems(models) {
  return models.map((m) => {
    const provider = getProvider(state.settings, m.providerId);
    const info = provider?.modelInfo?.[m.model] || {};
    const badges = [];
    if (info.vision) badges.push({ icon: 'eye', title: t('sidepanel.model.vision') });
    return {
      key: `${m.providerId}\n${m.model}`,
      providerId: m.providerId,
      model: m.model,
      label: info.name || m.model,
      sublabel: info.name && info.name !== m.model ? m.model : '',
      group: m.providerName,
      keywords: `${m.model} ${m.providerName}`,
      dot: providerColor(provider),
      badges,
      title: m.label,
    };
  });
}

function openModelPicker() {
  const models = listChatModels(state.settings);
  const target = resolveChatTarget();
  openPicker(els.modelBtn, {
    items: modelItems(models),
    selectedKey: target ? `${target.provider.id}\n${target.model}` : null,
    title: t('sidepanel.model.choose'),
    searchable: true,
    searchPlaceholder: t('sidepanel.model.search'),
    emptyText: t(models.length ? 'sidepanel.model.noMatch' : 'sidepanel.model.noProvider'),
    wide: true,
    footer: [{ label: t('sidepanel.model.manage'), icon: 'settings', onSelect: openOptions }],
    onSelect: (item) => selectChatModel(item.providerId, item.model),
  });
}

function selectChatModel(providerId, model) {
  const chat = state.chat;
  chat.providerId = providerId;
  chat.model = model;
  renderModelButton();
  if (state.saved) persist(chat, { keepTime: true });
  updateSettings((settings) => {
    settings.defaults.chat = { providerId, model };
  }).catch((err) => toast(t('sidepanel.errors.saveDefaultModel', { error: errorText(err) }), { type: 'error' }));
}

function renderPersonaButton() {
  const persona = findPersona(state.chat?.personaId);
  const name = personaName(persona) || t('sidepanel.persona.default');
  els.personaLabel.textContent = name;
  els.personaBtn.title = t('sidepanel.persona.buttonTitle', { name });
  els.personaBtn.setAttribute('aria-label', t('sidepanel.persona.buttonLabel', { name }));
  els.personaBtn.classList.toggle('is-default', !persona || persona.id === 'default');
}

function openPersonaPicker() {
  const personas = state.settings.personas || [];
  openPicker(els.personaBtn, {
    items: personas.map((p) => {
      const prompt = prompts.effectivePersonaPrompt(p);
      return {
        key: p.id,
        label: personaName(p),
        sublabel: prompt ? truncate(prompt.replace(/\s+/g, ' '), 80) : t('sidepanel.persona.noInstructions'),
        title: prompt || personaName(p),
      };
    }),
    selectedKey: findPersona(state.chat.personaId)?.id,
    title: t('sidepanel.persona.choose'),
    searchable: personas.length > 8,
    searchPlaceholder: t('sidepanel.persona.search'),
    footer: [{ label: t('sidepanel.persona.manage'), icon: 'settings', onSelect: openOptions }],
    onSelect: (item) => {
      state.chat.personaId = item.key;
      renderPersonaButton();
      if (state.saved) persist(state.chat, { keepTime: true });
    },
  });
}

// ------------------------------------------------------------------------------------------
// Page context

async function refreshActiveTab() {
  try {
    state.tab = await getActiveTab();
  } catch {
    state.tab = null;
  }
  renderPageChip();
  renderVideoUi();
  syncSelectionWithTab().catch(() => {});
  return state.tab;
}

const refreshActiveTabSoon = debounce(refreshActiveTab, 150);

function renderPageChip() {
  const on = Boolean(state.chat?.includePage);
  const tab = state.tab;
  const host = hostnameOf(tab?.url || '');
  const available = Boolean(tab?.id) && !knownRestricted(tab?.url);
  const name = tab?.title || host || t('sidepanel.page.chip');
  els.pageChipText.textContent = tab ? name : t('sidepanel.page.chip');
  els.pageChip.setAttribute('aria-pressed', String(on));
  els.pageChip.classList.toggle('unavailable', Boolean(tab) && !available);
  let title;
  if (!tab) title = t('sidepanel.page.noTab');
  else if (!available) title = t('sidepanel.page.unreadable', { name });
  else title = t(on ? 'sidepanel.page.sending' : 'sidepanel.page.send', { page: `${tab.title || host}${host && tab.title ? ` (${host})` : ''}` });
  els.pageChip.title = available ? t(on ? 'sidepanel.page.clickToTurnOff' : 'sidepanel.page.clickToTurnOn', { title }) : title;
  els.pageChip.setAttribute('aria-label', on ? t('sidepanel.page.sendIsOn', { name }) : t('sidepanel.page.send', { page: name }));
  composer?.setPage({ on, available: available || !tab, title: els.pageChip.title });
}

function togglePage() {
  const chat = state.chat;
  chat.includePage = !chat.includePage;
  renderPageChip();
  if (chat.includePage && state.tab && knownRestricted(state.tab.url)) {
    toast(t('sidepanel.page.restrictedToggle'), { type: 'warning', timeout: 4000 });
  }
  if (state.saved) persist(chat, { keepTime: true });
}

// ------------------------------------------------------------------------------------------
// Page selection as reference (ARCHITECTURE §8.6). The content scripts of the window report
// every change of the selection ('pageSelection'); while text is selected on the active tab the
// composer shows it, and the next chat message quotes it (once).

const sameFrame = (a, tabId, frameId) => Boolean(a) && a.tabId === tabId
  && (a.frameId == null || frameId == null || a.frameId === frameId);

function renderSelectionRef() {
  const ref = state.imageMode ? null : state.selection;
  const box = els.selectionRef;
  box.textContent = '';
  box.hidden = !ref;
  box.removeAttribute('title');
  composer?.setChatPlaceholder(ref ? t('sidepanel.composer.placeholderSelection') : (state.videoAttach ? t('sidepanel.composer.placeholderVideo') : null));
  if (!ref) return;
  const source = ref.title || hostnameOf(ref.url);
  box.title = `${truncate(ref.text, 1500)}${ref.truncated ? `\n${t('sidepanel.selection.truncated')}` : ''}`;
  box.append(
    h('span', { class: 'selection-ref-icon', html: icon('quote', { size: 15 }) }),
    h('div', { class: 'selection-ref-body' },
      h('div', { class: 'selection-ref-label' },
        h('span', { style: { flex: 'none' } }, t('sidepanel.selection.label')),
        source ? h('span', { class: 'selection-ref-source truncate' }, `· ${source}`) : null),
      h('div', { class: 'selection-ref-text' }, truncate(ref.text.replace(/\s+/g, ' '), 400))),
    h('button', {
      type: 'button',
      class: 'btn-icon btn-sm selection-ref-close',
      title: t('sidepanel.selection.dismissTitle'),
      'aria-label': t('sidepanel.selection.dismissLabel'),
      html: icon('x', { size: 14 }),
      onClick: () => {
        dismissSelection();
        composer.focus();
      },
    }),
  );
}

function setSelection(ref) {
  state.selection = ref;
  renderSelectionRef();
}

/** The reference was sent or dismissed: the same selection is not offered again. */
function dismissSelection() {
  const ref = state.selection;
  if (ref) state.selectionIgnored = { tabId: ref.tabId, frameId: ref.frameId, text: ref.text };
  setSelection(null);
}

function forgetSelectionOfTab(tabId) {
  if (state.selection?.tabId === tabId) setSelection(null);
  if (state.selectionIgnored?.tabId === tabId) state.selectionIgnored = null;
}

/** A selection reported by a page (`text` '' = the selection is gone). */
function applyPageSelection(raw, tabId, frameId) {
  const quote = normalizeQuote(raw);
  if (!quote) {
    if (sameFrame(state.selectionIgnored, tabId, frameId)) state.selectionIgnored = null;
    if (sameFrame(state.selection, tabId, frameId)) setSelection(null);
    return;
  }
  const ignored = state.selectionIgnored;
  if (ignored && ignored.tabId === tabId && ignored.text === quote.text) return;
  const current = state.selection;
  if (current && current.tabId === tabId && current.text === quote.text && current.title === quote.title) return;
  setSelection({ ...quote, tabId, frameId });
}

// Content scripts → all extension pages; only the active tab of this panel's window counts.
function handleRuntimeMessage(message, sender) {
  if (!message || typeof message !== 'object' || message.type !== 'pageSelection') return undefined;
  const tab = sender?.tab;
  if (!tab || !Number.isInteger(tab.id) || tab.active === false) return undefined;
  if (state.windowId != null && tab.windowId !== state.windowId) return undefined;
  applyPageSelection(message, tab.id, Number.isInteger(sender.frameId) ? sender.frameId : 0);
  return undefined; // no response
}

let selectionQuery = 0;

/** Another tab became active (or the panel opened): show the selection of that tab, if any. */
async function syncSelectionWithTab() {
  const tab = state.tab;
  const current = state.selection;
  if (current && current.tabId != null && current.tabId !== tab?.id) setSelection(null);
  if (!tab?.id || knownRestricted(tab.url) || state.selection) return;
  const query = ++selectionQuery;
  // Asks the top frame only and never injects: a page without content script has no selection
  // worth offering.
  const res = await tryMessageTab(tab.id, { type: 'getSelection', maxChars: MAX_QUOTE_CHARS }, { timeoutMs: 1500 });
  if (query !== selectionQuery || state.tab?.id !== tab.id || state.selection || !res?.ok) return;
  applyPageSelection(res, tab.id, 0);
}

// ------------------------------------------------------------------------------------------
// Image mode

function setImageMode(on) {
  state.imageMode = Boolean(on);
  composer.setImageMode(state.imageMode);
  renderSelectionRef();
  renderImageBar();
  renderVideoBar();
  updateComposerStatus();
  if (state.imageMode) composer.focus();
}

function openImageModelPicker(anchor) {
  const models = listImageModels(state.settings);
  const target = resolveImageTarget();
  openPicker(anchor, {
    items: modelItems(models),
    selectedKey: target ? `${target.provider.id}\n${target.model}` : null,
    title: t('sidepanel.image.chooseModel'),
    searchable: models.length > 6,
    searchPlaceholder: t('sidepanel.image.searchModel'),
    emptyText: t('sidepanel.image.noModel'),
    placement: 'top-start',
    footer: [{ label: t('sidepanel.image.manageModels'), icon: 'settings', onSelect: openOptions }],
    onSelect: (item) => {
      state.imageTarget = { providerId: item.providerId, model: item.model };
      renderImageBar();
      updateComposerStatus();
      updateSettings((settings) => {
        settings.defaults.image = { providerId: item.providerId, model: item.model };
      }).catch((err) => toast(t('sidepanel.errors.saveImageModel', { error: errorText(err) }), { type: 'error' }));
    },
  });
}

function renderImageBar() {
  const bar = els.imageBar;
  bar.hidden = !state.imageMode;
  if (!state.imageMode) return;
  bar.textContent = '';
  const closeBtn = h('button', {
    type: 'button',
    class: 'btn-icon btn-sm',
    title: t('sidepanel.image.exitMode'),
    'aria-label': t('sidepanel.image.exitMode'),
    html: icon('x', { size: 14 }),
    onClick: () => {
      setImageMode(false);
      composer.focus();
    },
  });
  const target = resolveImageTarget();
  if (!target) {
    bar.classList.add('is-empty');
    bar.append(
      h('span', { class: 'image-bar-icon', html: icon('alert', { size: 16 }) }),
      h('div', { class: 'image-bar-text' }, h('strong', {}, t('sidepanel.image.noModel')), ' ', t('sidepanel.image.noProviderHelp'),
        h('div', { class: 'image-bar-cta' }, h('button', { type: 'button', class: 'btn btn-sm', html: icon('settings', { size: 14 }), onClick: openOptions }, t('sidepanel.image.openSettings')))),
      closeBtn);
    return;
  }
  bar.classList.remove('is-empty');
  const modelBtn = h('button', {
    type: 'button',
    class: 'picker-btn picker-btn-sm',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    title: t('sidepanel.image.modelTitle', { provider: target.provider.name, model: target.model }),
    'aria-label': t('sidepanel.image.modelLabel', { provider: target.provider.name, model: target.model }),
    onClick: () => openImageModelPicker(modelBtn),
  },
  h('span', { class: 'picker-dot', style: { background: providerColor(target.provider) }, 'aria-hidden': 'true' }),
  h('span', { class: 'picker-btn-text truncate' }, target.provider.modelInfo?.[target.model]?.name || target.model),
  h('span', { class: 'picker-chevron', html: icon('chevron-down', { size: 13 }), 'aria-hidden': 'true' }));
  const sizeSelect = h('select', {
    class: 'select select-sm',
    title: t('sidepanel.image.format'),
    'aria-label': t('sidepanel.image.format'),
    onChange: (event) => {
      state.imageSize = event.target.value;
      writeJson(PREFS_KEY, { ...(readJson(PREFS_KEY) || {}), imageSize: state.imageSize });
    },
  }, IMAGE_SIZES.map((s) => h('option', { value: s.value, selected: s.value === state.imageSize }, s.label)));
  bar.append(
    h('span', { class: 'image-bar-label', html: icon('image', { size: 14 }) }, h('span', {}, t('sidepanel.image.label'))),
    modelBtn,
    sizeSelect,
    h('span', { class: 'spacer' }),
    closeBtn);
}

function updateComposerStatus(text = composer.getText()) {
  if (!state.imageMode && IMAGE_COMMAND.test(text.trimStart())) {
    const target = resolveImageTarget();
    composer.setStatus(target
      ? t('sidepanel.image.willGenerate', { provider: target.provider.name, model: target.model })
      : t('sidepanel.image.noModelSetup'), { tone: 'image' });
  } else {
    composer.setStatus('');
  }
}

// ------------------------------------------------------------------------------------------
// Welcome & onboarding

function greeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) return t('sidepanel.welcome.morning');
  if (hour >= 18 || hour < 2) return t('sidepanel.welcome.evening');
  return t('sidepanel.welcome.hello');
}

function runSuggestion(suggestion) {
  if (suggestion.action === 'translatePage') {
    translatePage();
    return;
  }
  if (suggestion.action === 'image') {
    setImageMode(true);
    return;
  }
  if (state.busy) return;
  if (suggestion.prompt === summarizePagePrompt() && activeVideoId()) {
    summarizeVideo();
    return;
  }
  // Page suggestions ("Seite zusammenfassen", "Wichtigste Punkte" …) need the page.
  startChat({ text: suggestion.prompt, includePage: Boolean(suggestion.includePage), requirePage: Boolean(suggestion.includePage) });
}

function renderWelcome() {
  const empty = !state.chat?.messages.length;
  els.welcome.hidden = !empty;
  els.messages.hidden = empty;
  if (!empty) return;
  const ready = Boolean(resolveTarget(state.settings, 'chat'));
  els.welcome.textContent = '';
  const inner = h('div', { class: 'welcome-inner' },
    h('div', { class: 'welcome-logo', html: icon('sparkles', { size: 24 }) }),
    h('p', { class: 'welcome-greeting' }, greeting()),
    h('h1', { class: 'welcome-title' }, t('sidepanel.welcome.title')),
    h('p', { class: 'welcome-sub' }, t('sidepanel.welcome.subtitle')));

  if (!ready) {
    inner.appendChild(h('div', { class: 'card onboarding' },
      h('div', { class: 'onboarding-icon', html: icon('key', { size: 20 }) }),
      h('h2', {}, t('sidepanel.onboarding.title')),
      h('p', {}, t('sidepanel.onboarding.text')),
      h('button', { type: 'button', class: 'btn btn-primary', html: icon('settings', { size: 16 }), onClick: openOptions }, t('sidepanel.onboarding.button')),
      h('p', { class: 'onboarding-note' }, h('span', { html: icon('lock', { size: 13 }) }), t('sidepanel.onboarding.note'))));
  } else {
    if (activeVideoId()) inner.appendChild(videoCard());
    inner.appendChild(h('div', { class: 'suggestions', role: 'list', 'aria-label': t('sidepanel.welcome.suggestions') },
      suggestions().map((s) => h('button', {
        type: 'button',
        class: 'suggestion',
        role: 'listitem',
        title: s.action ? s.label : truncate(s.prompt, 200),
        onClick: () => runSuggestion(s),
      }, h('span', { class: 'suggestion-icon', 'aria-hidden': 'true' }, s.icon), h('span', { class: 'suggestion-label' }, s.label)))));
    inner.appendChild(h('p', { class: 'welcome-tips' },
      `${t('sidepanel.welcome.tip')} `, h('span', { class: 'kbd' }, t('sidepanel.composer.imageCommand')), ` ${t('sidepanel.welcome.tipImage')} · `,
      h('span', { class: 'kbd' }, t('sidepanel.keys.ctrl')), '+', h('span', { class: 'kbd' }, t('sidepanel.keys.shift')), '+', h('span', { class: 'kbd' }, 'O'),
      ` ${t('sidepanel.welcome.tipNewChat')}`));
  }
  els.welcome.appendChild(inner);
}

async function checkPermissions() {
  if (!ext.permissions?.contains) return;
  try {
    const granted = await ext.permissions.contains({ origins: ['<all_urls>'] });
    els.permBanner.hidden = Boolean(granted);
  } catch {
    els.permBanner.hidden = true;
  }
}

function requestPermissions() {
  // Must be called synchronously from the click (user gesture) – no await before it.
  let request;
  try {
    request = ext.permissions.request({ origins: ['<all_urls>'] });
  } catch (err) {
    toast(t('sidepanel.permissions.requestFailed', { error: errorText(err) }), { type: 'error' });
    return;
  }
  Promise.resolve(request).then((granted) => {
    if (granted) {
      els.permBanner.hidden = true;
      toast(t('sidepanel.permissions.granted'), { type: 'success' });
      refreshActiveTab();
    } else {
      toast(t('sidepanel.permissions.denied'), { type: 'warning', timeout: 5000 });
    }
  }).catch((err) => toast(t('sidepanel.permissions.requestFailed', { error: errorText(err) }), { type: 'error' }));
}

// ------------------------------------------------------------------------------------------
// Tools menu

/** restrictedKey: message key shown when the page cannot be read (e.g. 'sidepanel.tools.cannotTranslate'). */
async function activeReadableTab(restrictedKey) {
  const tab = await refreshActiveTab();
  if (!tab?.id) {
    toast(t('sidepanel.tools.noActiveTab'), { type: 'error' });
    return null;
  }
  if (knownRestricted(tab.url)) {
    toast(t(restrictedKey), { type: 'warning', timeout: 4500 });
    return null;
  }
  return tab;
}

async function translatePage() {
  if (!resolveTarget(state.settings, 'translate')) {
    notifyNoProvider();
    return;
  }
  const tab = await activeReadableTab('sidepanel.tools.cannotTranslate');
  if (!tab) return;
  try {
    const res = await sendToTab(tab.id, { type: 'translatePage' });
    if (res && res.ok === false) throw new Error(res.error || t('sidepanel.translate.startFailed'));
    toast(t('sidepanel.translate.started', { language: translateLangLabel() }), { type: 'success' });
  } catch (err) {
    toast(err?.message || t('sidepanel.translate.startFailed'), { type: 'error' });
  }
}

async function restorePage() {
  const tab = await activeReadableTab('sidepanel.tools.cannotRestore');
  if (!tab) return;
  try {
    const res = await sendToTab(tab.id, { type: 'restorePage' });
    if (res && res.ok === false) throw new Error(res.error || t('sidepanel.restore.failed'));
    toast(t('sidepanel.restore.done'), { type: 'success' });
  } catch (err) {
    toast(err?.message || t('sidepanel.restore.failed'), { type: 'error' });
  }
}

function summarizePage() {
  if (activeVideoId()) {
    summarizeVideo();
    return;
  }
  if (state.busy) {
    toast(t('sidepanel.busy.wait'), { type: 'warning' });
    return;
  }
  if (state.imageMode) setImageMode(false);
  const chat = state.chat;
  if (!chat.messages.length && !chat.titleEdited && state.tab?.title) {
    chat.title = truncate(t('sidepanel.chat.summaryTitle', { title: state.tab.title.replace(/\s+/g, ' ').trim() }), 60);
  }
  if (!startChat({ text: summarizePagePrompt(), requirePage: true }) && !chat.messages.length) chat.title = defaultTitle();
  renderHeader();
}

// ------------------------------------------------------------------------------------------
// YouTube videos: summary with timestamps in the chosen language, chatting about the video,
// jumping to a timestamp.

/** Stored summary language: a language code, 'auto' (= UI language) or free text. */
function summaryLang() {
  return state.settings.youtube?.summaryLang || AUTO_TARGET;
}

/** Display names (UI language) of the summary / translation target languages. */
const summaryLangLabel = () => languageLabel(summaryLang());
const translateLangLabel = () => languageLabel(state.settings.translate?.targetLang || AUTO_TARGET);

/** Summarizes the video of the active tab (transcript if available) in the chosen language. */
function summarizeVideo() {
  if (state.busy) {
    toast(t('sidepanel.busy.wait'), { type: 'warning' });
    return false;
  }
  if (!activeVideoId()) {
    toast(t('sidepanel.video.noVideo'), { type: 'warning' });
    return false;
  }
  if (state.imageMode) setImageMode(false);
  setVideoAttach(null);
  const chat = state.chat;
  const name = videoTitleOf(state.tab?.title);
  if (!chat.messages.length && !chat.titleEdited && name) {
    chat.title = truncate(t('sidepanel.chat.videoTitle', { title: name.replace(/\s+/g, ' ') }), 60);
  }
  const ok = startChat({ text: buildVideoSummaryPrompt(summaryLang()), requirePage: true });
  if (!ok && !chat.messages.length) chat.title = defaultTitle();
  renderHeader();
  return ok;
}

function setVideoAttach(videoId) {
  state.videoAttach = videoId || null;
  composer?.setChatPlaceholder(state.videoAttach ? t('sidepanel.composer.placeholderVideo') : (state.selection ? t('sidepanel.composer.placeholderSelection') : null));
  renderVideoBar();
}

/** "Fragen zum Video": the next message carries the transcript. */
function askAboutVideo() {
  const videoId = activeVideoId();
  if (!videoId) return;
  if (state.imageMode) setImageMode(false);
  setVideoAttach(videoId);
  composer.focus();
}

function setSummaryLang(lang) {
  updateSettings((settings) => {
    settings.youtube = { ...(settings.youtube || {}), summaryLang: lang };
  }).catch((err) => toast(t('sidepanel.errors.saveLanguage', { error: errorText(err) }), { type: 'error' }));
}

function summaryLangSelect() {
  // Stored values are codes, 'auto' or free text (older versions: German names) – compare normalized.
  const current = normalizeTargetLanguage(summaryLang());
  const options = languageOptions({ current });
  return h('select', {
    class: 'select select-sm',
    title: t('sidepanel.video.summaryLanguage'),
    'aria-label': t('sidepanel.video.summaryLanguage'),
    onChange: (event) => setSummaryLang(event.target.value),
  }, options.map((o) => h('option', { value: o.value, selected: o.value === current }, o.label)));
}

/** Does the open chat already contain the transcript of this video? */
function chatHasVideo(videoId) {
  return Boolean(videoId) && state.chat?.messages.some((m) => m.role === 'user' && m.video?.id === videoId && m.context);
}

/**
 * Bar above the composer: the attached transcript ("wird mitgesendet"), or – in a chat with
 * messages that is not about this video yet – an offer to summarize it or ask about it.
 */
function renderVideoBar() {
  const bar = els.videoBar;
  if (!bar) return;
  const videoId = activeVideoId();
  if (state.videoAttach && state.videoAttach !== videoId) state.videoAttach = null;
  const attached = Boolean(state.videoAttach);
  const offer = !attached && Boolean(videoId) && !state.imageMode && Boolean(state.chat?.messages.length)
    && !chatHasVideo(videoId) && state.videoDismissed !== videoId && Boolean(resolveTarget(state.settings, 'chat'));
  bar.hidden = !(attached || offer);
  bar.textContent = '';
  if (bar.hidden) return;
  const name = videoTitleOf(state.tab?.title) || t('sidepanel.video.fallbackTitle');
  const close = h('button', {
    type: 'button',
    class: 'btn-icon btn-sm',
    title: t(attached ? 'sidepanel.video.dontSendTranscript' : 'sidepanel.video.hide'),
    'aria-label': t(attached ? 'sidepanel.video.dontSendTranscript' : 'sidepanel.video.hideLabel'),
    html: icon('x', { size: 14 }),
    onClick: () => {
      if (attached) setVideoAttach(null);
      else {
        state.videoDismissed = videoId;
        renderVideoBar();
      }
      composer.focus();
    },
  });
  const label = h('div', { class: 'video-bar-body' },
    h('div', { class: 'video-bar-label' }, t(attached ? 'sidepanel.video.transcriptAttached' : 'sidepanel.video.detected')),
    h('div', { class: 'video-bar-title truncate', title: name }, name));
  bar.append(h('span', { class: 'video-bar-icon', html: icon('play', { size: 14 }) }), label);
  if (!attached) {
    bar.append(
      h('button', {
        type: 'button',
        class: 'btn btn-sm btn-primary',
        title: t('sidepanel.video.summarizeIn', { language: summaryLangLabel() }),
        onClick: summarizeVideo,
      }, t('sidepanel.video.summarize')),
      h('button', { type: 'button', class: 'btn btn-sm', title: t('sidepanel.video.askHint'), onClick: askAboutVideo }, t('sidepanel.video.ask')));
  }
  bar.append(close);
}

/** Welcome card / video bar follow the active tab; re-rendered only when the video changes. */
function renderVideoUi() {
  const key = `${activeVideoId() || ''}\n${videoTitleOf(state.tab?.title)}`;
  if (key !== state.videoKey) {
    state.videoKey = key;
    if (!state.chat?.messages.length) renderWelcome();
  }
  renderVideoBar();
}

function videoCard() {
  const name = videoTitleOf(state.tab?.title) || t('sidepanel.video.fallbackTitle');
  return h('div', { class: 'card video-card', role: 'group', 'aria-label': t('sidepanel.video.detected') },
    h('div', { class: 'video-card-head' },
      h('span', { class: 'video-card-icon', html: icon('play', { size: 16 }) }),
      h('div', { class: 'video-card-meta' },
        h('div', { class: 'video-card-kicker' }, t('sidepanel.video.detected')),
        h('div', { class: 'video-card-title', title: name }, name))),
    h('div', { class: 'video-card-row' },
      h('button', {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        html: icon('sparkles', { size: 14 }),
        onClick: summarizeVideo,
      }, t('sidepanel.video.summarizeVideo')),
      h('label', { class: 'video-card-lang' }, h('span', {}, t('sidepanel.video.in')), summaryLangSelect())),
    h('button', {
      type: 'button',
      class: 'btn btn-sm btn-ghost video-card-ask',
      html: icon('bot', { size: 14 }),
      onClick: askAboutVideo,
    }, t('sidepanel.video.askAbout')),
    h('p', { class: 'video-card-note' }, t('sidepanel.video.note')));
}

/** Click on a timestamp link: seek the video in the active tab, or open it at that position. */
async function jumpToTimestamp(videoId, seconds) {
  const tab = await refreshActiveTab();
  if (tab?.id && parseYouTubeUrl(tab.url) === videoId && (await seekVideoInTab(tab.id, videoId, seconds))) return;
  const url = youTubeWatchUrl(videoId, seconds);
  try {
    await ext.tabs.create({ url });
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

function exportMarkdown() {
  const chat = state.chat;
  if (!chat.messages.length) {
    toast(t('sidepanel.export.empty'));
    return;
  }
  downloadFile(chatFilename(chat, 'md'), chatToMarkdown(chat, { labelFor: providerLabel }), 'text/markdown');
  toast(t('sidepanel.export.done'), { type: 'success' });
}

async function deleteCurrentChat() {
  const chat = state.chat;
  if (!chat.messages.length) return;
  const ok = await confirmDialog(t('sidepanel.delete.confirm', { title: chat.title }), {
    title: t('sidepanel.delete.title'), okText: t('sidepanel.delete.ok'), danger: true,
  });
  if (!ok || chat !== state.chat) return;
  const wasStored = state.saved || storedChats.has(chat);
  // Discard first: a request that settles during the delete must not write the chat back.
  discardedChats.add(chat);
  storedChats.delete(chat);
  if (state.busy) stopGeneration();
  try {
    if (wasStored) await deleteChat(chat.id);
  } catch (err) {
    discardedChats.delete(chat);
    if (wasStored) storedChats.add(chat);
    toast(err?.message || t('sidepanel.errors.deleteChat'), { type: 'error' });
    return;
  }
  if (state.chat === chat) setChat(newChatObject());
  toast(t('sidepanel.delete.done'), { type: 'success' });
}

function costMenuItems() {
  const items = [{ separator: true }, { heading: t('sidepanel.tools.costs') }];
  const summary = chatCostSummary(state.chat);
  items.push({
    label: summary ? t('sidepanel.tools.thisChatCost', { cost: summary.label }) : t('sidepanel.tools.thisChatNoCost'),
    icon: 'wallet',
    hint: summary?.hint,
    onSelect: openCostSettings,
  });
  const target = resolveChatTarget();
  if (target && canFetchBalance(target.provider)) {
    items.push({ label: t('sidepanel.tools.balanceAt', { provider: target.provider.name }), icon: 'refresh', onSelect: () => showBalance(target.provider) });
  }
  items.push({ label: t('sidepanel.tools.costSettings'), icon: 'settings', onSelect: openCostSettings });
  return items;
}

function openTools() {
  const hasMessages = state.chat.messages.length > 0;
  openMenu(els.toolsBtn, [
    { heading: t('sidepanel.tools.currentPage') },
    { label: t('sidepanel.tools.translate'), icon: 'languages', hint: translateLangLabel(), onSelect: translatePage },
    { label: t('sidepanel.tools.restore'), icon: 'refresh', onSelect: restorePage },
    { label: t('sidepanel.tools.summarizePage'), icon: 'sparkles', onSelect: summarizePage, disabled: Boolean(state.busy) },
    ...(activeVideoId() ? [{
      label: t('sidepanel.video.summarizeVideo'), icon: 'play', hint: summaryLangLabel(), onSelect: summarizeVideo, disabled: Boolean(state.busy),
    }] : []),
    { separator: true },
    { heading: t('sidepanel.tools.chat') },
    { label: t('sidepanel.tools.exportMarkdown'), icon: 'download', onSelect: exportMarkdown, disabled: !hasMessages },
    { label: t('sidepanel.tools.deleteChat'), icon: 'trash', danger: true, onSelect: deleteCurrentChat, disabled: !hasMessages },
    ...costMenuItems(),
  ], { label: t('sidepanel.header.tools'), placement: 'bottom-end' });
}

/** Is `text` the built-in page-summary prompt (in any prompt language)? */
function isSummarizePrompt(text) {
  const value = String(text || '').trim();
  return Boolean(value) && prompts.PROMPT_LANGUAGES.some((lang) => value === prompts.summarizePagePrompt(lang));
}

// ------------------------------------------------------------------------------------------
// PendingChat (context menu / content script → side panel). The background hands each entry
// to exactly one panel – the one in the entry's window – via `claimPendingChat` (C1).

async function claimPending() {
  try {
    const res = await ext.runtime.sendMessage({ type: 'claimPendingChat', windowId: state.windowId ?? undefined });
    const pending = res?.ok ? res.pending : null;
    return pending && typeof pending === 'object' ? pending : null;
  } catch (err) {
    console.warn('[LLM Sidebar] Could not claim the PendingChat:', err?.message || err);
    return null;
  }
}

let pendingQueue = Promise.resolve();

/** Claims a waiting PendingChat (if any) and applies it – after a running answer has finished. */
async function consumePending() {
  const pending = await claimPending();
  if (!pending || (pending.id && pending.id === state.lastPendingId)) return;
  state.lastPendingId = pending.id || null;
  if (pending.kind === 'prefill') {
    applyPrefill(pending);
    return;
  }
  if (state.busy) toast(t('sidepanel.pending.queued'), { timeout: 4500 });
  pendingQueue = pendingQueue.then(() => handlePending(pending)).catch((err) => {
    console.error('[LLM Sidebar] PendingChat failed:', err);
  });
  await pendingQueue;
}

// Prefilling the composer does not disturb a running answer, so it is applied right away.
function applyPrefill(pending) {
  const text = typeof pending.text === 'string' ? pending.text : '';
  const quote = normalizeQuote(pending.quote);
  history.close({ restoreFocus: false });
  closePopup();
  if (state.imageMode) setImageMode(false);
  if (quote) {
    // "Im Chat fragen": the selection becomes the reference of the next message.
    const source = pending.source && typeof pending.source === 'object' ? pending.source : {};
    const tabId = Number.isInteger(source.tabId) ? source.tabId : (state.tab?.id ?? null);
    const frameId = Number.isInteger(source.frameId) ? source.frameId : null;
    state.selectionIgnored = null;
    setSelection({ ...quote, tabId, frameId });
  }
  if (text) composer.setText(text, { append: true });
  else composer.focus();
}

async function handlePending(pending) {
  // Never abort a running answer: wait until it has finished (or was stopped).
  while (state.busy) await whenIdle();
  history.close({ restoreFocus: false });
  closePopup();

  const text = typeof pending.text === 'string' ? pending.text : '';
  if (pending.kind === 'send') {
    if (!text.trim()) return;
    if (state.chat.messages.length) setChat(newChatObject());
    if (state.imageMode) setImageMode(false);
    if (pending.title && !state.chat.titleEdited) state.chat.title = truncate(String(pending.title).replace(/\s+/g, ' ').trim(), 80);
    const includePage = Boolean(pending.includePage);
    // "Seite zusammenfassen" (context menu / shortcut) on a YouTube video → video summary.
    if (includePage && isSummarizePrompt(text) && parseYouTubeUrl((await refreshActiveTab())?.url || '')) {
      summarizeVideo();
      return;
    }
    if (!startChat({ text: text.trim(), includePage, requirePage: includePage })) {
      if (!state.chat.messages.length) state.chat.title = defaultTitle();
      composer.setText(text);
    }
    renderHeader();
    return;
  }

  if (pending.kind === 'continue') {
    const seed = (Array.isArray(pending.messages) ? pending.messages : [])
      .filter((m) => m && typeof m.content === 'string' && m.content.trim())
      .map((m) => createMessage({ role: m.role === 'assistant' ? 'assistant' : 'user', kind: 'chat', content: m.content }));
    if (!seed.length) {
      if (text) composer.setText(text);
      return;
    }
    const firstUser = seed.find((m) => m.role === 'user');
    const chat = createChat({
      title: pending.title ? truncate(String(pending.title).replace(/\s+/g, ' ').trim(), 80) : makeTitle(firstUser?.content || seed[0].content),
      titleEdited: Boolean(pending.title),
      personaId: findPersona(state.settings.chat.personaId)?.id || 'default',
      includePage: false,
      messages: seed,
    });
    setChat(chat);
    if (state.imageMode) setImageMode(false);
    await persist(chat);
    if (seed[seed.length - 1].role === 'user') {
      const target = resolveChatTarget();
      if (target) runChatTurn(target);
      else notifyNoProvider();
    }
    if (text) composer.setText(text);
    else composer.focus();
  }
}

// ------------------------------------------------------------------------------------------
// Settings

function handleSettingsChanged(settings) {
  // Another UI language: reload, so every static and rendered text is rebuilt in it. (Compared
  // with the requested language, not getLanguage(): a missing catalog falls back to English.)
  if (resolveLanguage(settings?.general?.language) !== uiLanguage) {
    location.reload();
    return;
  }
  state.settings = settings;
  applyTheme(settings.general.theme);
  if (isPopupOpen()) closePopup();
  renderModelButton();
  renderPersonaButton();
  renderImageBar();
  renderWelcome();
  renderVideoBar();
  updateComposerStatus();
  view.refreshLabels();
  composer.refresh();
}

// ------------------------------------------------------------------------------------------
// Keyboard

function handleGlobalKeydown(event) {
  if (event.defaultPrevented) return;
  const key = event.key;
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && (event.code === 'KeyO' || key.toLowerCase() === 'o')) {
    event.preventDefault();
    newChat();
    return;
  }
  if (key !== 'Escape' || event.isComposing) return;
  if (document.querySelector('.dialog-backdrop:not(.closing)')) return;
  if (isPopupOpen()) {
    closePopup({ restoreFocus: true });
    event.preventDefault();
    return;
  }
  if (history.isOpen()) {
    history.close();
    event.preventDefault();
    return;
  }
  if (view.isEditing()) {
    view.cancelEdit();
    event.preventDefault();
    return;
  }
  if (state.busy) {
    stopGeneration();
    event.preventDefault();
    return;
  }
  if (state.imageMode && document.activeElement === els.input && !els.input.value) {
    setImageMode(false);
    event.preventDefault();
  }
}

// ------------------------------------------------------------------------------------------
// Init

function bindUi() {
  els.historyBtn.addEventListener('click', () => history.toggle());
  els.titleBtn.addEventListener('click', renameCurrentChat);
  els.newBtn.addEventListener('click', () => newChat());
  els.toolsBtn.addEventListener('click', openTools);
  els.settingsBtn.addEventListener('click', openOptions);
  els.modelBtn.addEventListener('click', openModelPicker);
  els.personaBtn.addEventListener('click', openPersonaPicker);
  els.pageChip.addEventListener('click', togglePage);
  els.balanceBtn.addEventListener('click', openBalancePopover);
  els.permGrant.addEventListener('click', requestPermissions);
  document.addEventListener('keydown', handleGlobalKeydown);

  // Keep toasts above the composer.
  const setToastOffset = () => document.documentElement.style.setProperty('--toast-offset', `${els.composer.offsetHeight + 10}px`);
  if (typeof ResizeObserver === 'function') new ResizeObserver(setToastOffset).observe(els.composer);
  setToastOffset();

  window.addEventListener('focus', () => {
    refreshActiveTabSoon();
    checkPermissions();
  });

  // Best effort: keep partial answers when the panel is closed mid-stream.
  window.addEventListener('pagehide', () => {
    const run = state.busy;
    if (!run || discardedChats.has(run.chat)) return;
    const msg = run.chat.messages.find((m) => m.id === run.messageId);
    if (msg) msg.stopped = true;
    run.controller.abort();
    saveChat(run.chat).catch(() => {});
  });
}

function bindBrowserEvents() {
  onSettingsChanged(handleSettingsChanged);
  onChatsChanged(handleChatsChanged);
  ext.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'session' && area !== 'local') return;
    if (changes?.[PENDING_KEY]?.newValue) consumePending();
  });
  // Access granted or revoked elsewhere (options page, browser add-on settings).
  ext.permissions?.onAdded?.addListener?.(() => checkPermissions());
  ext.permissions?.onRemoved?.addListener?.(() => checkPermissions());
  ext.runtime?.onMessage?.addListener(handleRuntimeMessage);
  ext.tabs?.onActivated?.addListener(() => refreshActiveTabSoon());
  ext.tabs?.onRemoved?.addListener((tabId) => forgetSelectionOfTab(tabId));
  ext.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (changeInfo && 'url' in changeInfo) forgetSelectionOfTab(tabId); // navigated away
    if (tabId !== state.tab?.id && !tab?.active) return;
    if (!changeInfo) return;
    if ('title' in changeInfo || 'url' in changeInfo || changeInfo.status === 'complete') refreshActiveTabSoon();
  });
}

async function init() {
  hydrateIcons();
  const prefs = readJson(PREFS_KEY);
  if (IMAGE_SIZES.some((s) => s.value === prefs?.imageSize)) state.imageSize = prefs.imageSize;

  let settingsError = null;
  try {
    state.settings = await getSettings();
  } catch (err) {
    state.settings = normalizeSettings(getDefaultSettings());
    settingsError = err;
  }
  // The UI language is known now: load it before anything is rendered.
  uiLanguage = resolveLanguage(state.settings.general?.language);
  await initI18n(state.settings.general?.language);
  applyI18n(document);
  if (settingsError) toast(t('sidepanel.errors.loadSettings', { error: errorText(settingsError) }), { type: 'error' });
  applyTheme(state.settings.general.theme);

  view = createChatView({
    scroller: els.scroller,
    list: els.messages,
    scrollButton: els.scrollBottom,
    handlers: {
      onCopy: copyMessage,
      onRegenerate: regenerate,
      onRetry: regenerate,
      onDelete: deleteMessage,
      onEditSubmit: editAndResend,
      providerLabel,
      usageLabel,
      isSendKey,
      isBusy: () => Boolean(state.busy),
      onTimestamp: jumpToTimestamp,
    },
  });

  composer = createComposer({
    box: els.composerBox,
    input: els.input,
    sendBtn: els.sendBtn,
    attachBtn: els.attachBtn,
    imageBtn: els.imageBtn,
    pageBtn: els.pageBtn,
    fileInput: els.fileInput,
    attachList: els.attachList,
    status: els.composerStatus,
    dropOverlay: els.dropOverlay,
  }, {
    onSubmit: submitComposer,
    onStop: stopGeneration,
    onEditLast: editLastUserMessage,
    onToggleImage: () => setImageMode(!state.imageMode),
    onTogglePage: togglePage,
    onInput: (text) => updateComposerStatus(text),
    isSendKey,
    sendHint: () => (sendWithEnter() ? 'Enter' : t('sidepanel.keys.ctrlEnter')),
  });
  composer.setImageMode(false);

  history = createHistory({
    drawer: els.drawer,
    backdrop: els.drawerBackdrop,
    toggleBtn: els.historyBtn,
    inertRoot: els.main,
    getCurrentChat: () => ({ chat: state.chat, saved: state.saved }),
    onOpenChat: openChatById,
    onCurrentChanged: (record) => {
      if (record.id !== state.chat.id) return;
      if (record !== state.chat) Object.assign(state.chat, { title: record.title, pinned: record.pinned, titleEdited: record.titleEdited });
      renderHeader();
    },
    // Called before the delete, so a settling request cannot write the chat back.
    onCurrentDeleted: () => dropChat(state.chat),
    onAllDeleted: () => dropChat(state.chat),
  });

  bindUi();
  state.windowId = await resolveWindowId();
  pruneResumeKeys();
  await openInitialChat();
  bindBrowserEvents();
  refreshActiveTab();
  checkPermissions();
  await consumePending();
  if (!state.busy) composer.focus();
  document.documentElement.classList.add('ready');
}

init().catch((err) => {
  console.error('[LLM Sidebar] Side panel init failed:', err);
  toast(t('sidepanel.errors.init', { error: errorText(err) }), { type: 'error', timeout: 0 });
});
