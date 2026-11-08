// Settings schema, defaults, persistence and resolution helpers (ARCHITECTURE §4.3, §5, §6).

import { ext } from './ext.js';
import { PROVIDER_PRESETS, getPreset, createProviderFromPreset, normalizeBaseUrl } from './providers.js';
import { getDefaultQuickActions, getDefaultPersonas, quickActionName } from './prompts.js';
import { uid, clamp, deepClone } from './utils.js';
import { cleanPrice } from './usage.js';
import { AUTO_LANGUAGE, matchLanguage, resolveLanguage, t } from './i18n.js';
import { AUTO_TARGET, normalizeTargetLanguage, resolveTargetLanguage, languageOptions } from './languages.js';

export const SETTINGS_KEY = 'settings';

const SCHEMA_VERSION = 1;
const PURPOSES = ['chat', 'actions', 'translate', 'image'];
const THEMES = ['system', 'light', 'dark'];
const PROTOCOLS = ['openai', 'anthropic'];
const IMAGE_APIS = ['openai-images', 'openrouter-chat', 'none'];
const BUILTIN_IDS = new Set(PROVIDER_PRESETS.filter((p) => p.id !== 'custom').map((p) => p.id));
const KNOWN_PRESET_IDS = new Set(PROVIDER_PRESETS.map((p) => p.id));
const SETTINGS_SECTIONS = ['schemaVersion', 'providers', 'defaults', 'general', 'chat', 'profile', 'toolbar', 'translate', 'youtube', 'usage', 'quickActions', 'personas'];

const LIMITS = {
  temperature: [0, 2],
  maxTokens: [1, 2000000],
  contextMessages: [1, 200],
  batchChars: [500, 20000],
  concurrency: [1, 10],
};

// Built-in quick actions and personas are created in the current prompt language (German UI →
// German, otherwise English); unchanged ones keep following the UI language (see prompts.js).
export function getDefaultSettings() {
  return {
    schemaVersion: SCHEMA_VERSION,
    providers: PROVIDER_PRESETS.filter((p) => p.id !== 'custom').map((p) => createProviderFromPreset(p.id)),
    defaults: { chat: null, actions: null, translate: null, image: null },
    general: { theme: 'system', language: AUTO_LANGUAGE, sendWithEnter: true, streaming: true },
    chat: {
      systemPrompt: '',
      personaId: 'default',
      temperature: null,
      maxTokens: null,
      contextMessages: 30,
      includePageByDefault: false,
      useProfileInChat: false,
    },
    profile: { aboutMe: '', writingStyle: '' },
    toolbar: { enabled: true, disabledHosts: [] },
    translate: { targetLang: AUTO_TARGET, batchChars: 2500, concurrency: 3 }, // 'auto' = UI language
    youtube: { summaryLang: AUTO_TARGET },  // language of YouTube video summaries
    usage: { showInChat: true },          // tokens and costs under each answer in the side panel
    quickActions: getDefaultQuickActions(),
    personas: getDefaultPersonas(),
  };
}

// ---------- normalization helpers ----------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const trimmed = (v, fallback = '') => (typeof v === 'string' ? v.trim() : fallback);
const nonEmpty = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim()) return Number(v.trim().replace(',', '.'));
  return NaN;
}

function intInRange(v, [min, max], fallback) {
  const n = toNumber(v);
  return Number.isFinite(n) ? clamp(Math.round(n), min, max) : fallback;
}

// null / '' / invalid → null ("don't send").
function optionalNumber(v, [min, max], { integer = false, positive = false } = {}) {
  const n = toNumber(v);
  if (!Number.isFinite(n)) return null;
  if (positive && n <= 0) return null;
  const value = integer ? Math.round(n) : n;
  return clamp(value, min, max);
}

function stringList(v, fallback) {
  if (!Array.isArray(v)) return fallback;
  const out = [];
  for (const item of v) {
    const s = trimmed(item);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function normalizeHeaders(v, fallback) {
  if (!isObj(v)) return fallback;
  const out = {};
  for (const [name, value] of Object.entries(v)) {
    const key = name.trim();
    if (!key || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) continue;
    if (typeof value === 'string' || typeof value === 'number') out[key] = String(value).replace(/[\r\n]+/g, ' ').trim();
  }
  return out;
}

function normalizeModelInfo(v) {
  if (!isObj(v)) return {};
  const out = {};
  for (const [modelId, info] of Object.entries(v)) {
    if (!modelId || !isObj(info)) continue;
    const entry = {};
    if (typeof info.name === 'string' && info.name.trim()) entry.name = info.name.trim();
    if (typeof info.vision === 'boolean') entry.vision = info.vision;
    if (typeof info.imageOutput === 'boolean') entry.imageOutput = info.imageOutput;
    if (Number.isFinite(info.contextLength) && info.contextLength > 0) entry.contextLength = info.contextLength;
    const price = cleanPrice({ input: info.inputPrice, output: info.outputPrice });
    if (price && price.input !== null && price.output !== null) {
      entry.inputPrice = price.input;
      entry.outputPrice = price.output;
    }
    out[modelId] = entry;
  }
  return out;
}

function normalizeProvider(raw) {
  if (!isObj(raw)) return null;
  let id = trimmed(raw.id);
  let presetId;
  if (BUILTIN_IDS.has(id)) {
    presetId = id; // built-in ids always belong to their own preset
  } else if (id) {
    presetId = KNOWN_PRESET_IDS.has(raw.presetId) ? raw.presetId : 'custom';
  } else if (BUILTIN_IDS.has(raw.presetId)) {
    id = raw.presetId;
    presetId = raw.presetId;
  } else {
    id = `custom-${uid()}`;
    presetId = 'custom';
  }

  const base = createProviderFromPreset(presetId, { id });
  return {
    ...raw, // keep unknown fields other modules may have added
    id,
    presetId,
    name: nonEmpty(raw.name, base.name),
    protocol: oneOf(raw.protocol, PROTOCOLS, base.protocol),
    baseUrl: typeof raw.baseUrl === 'string' ? normalizeBaseUrl(raw.baseUrl) : base.baseUrl,
    apiKey: trimmed(raw.apiKey),
    enabled: bool(raw.enabled, false),
    models: stringList(raw.models, base.models),
    defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel.trim() : base.defaultModel,
    imageApi: oneOf(raw.imageApi, IMAGE_APIS, base.imageApi),
    imageModels: stringList(raw.imageModels, base.imageModels),
    defaultImageModel: typeof raw.defaultImageModel === 'string' ? raw.defaultImageModel.trim() : base.defaultImageModel,
    extraHeaders: normalizeHeaders(raw.extraHeaders, base.extraHeaders),
    modelInfo: normalizeModelInfo(raw.modelInfo),
    prices: normalizePrices(raw.prices),
    billing: {
      managementKey: trimmed(raw.billing?.managementKey),
      teamId: trimmed(raw.billing?.teamId).slice(0, 200),
    },
  };
}

// User prices per model: { [modelId]: { input, output } } (USD per 1M tokens, null = automatic).
function normalizePrices(v) {
  if (!isObj(v)) return {};
  const out = {};
  for (const [modelId, raw] of Object.entries(v)) {
    const id = modelId.trim();
    const price = cleanPrice(raw);
    if (id && price) out[id] = price;
  }
  return out;
}

function normalizeProviders(raw) {
  const out = [];
  const seen = new Set();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const provider = normalizeProvider(item);
      if (!provider || seen.has(provider.id)) continue;
      seen.add(provider.id);
      out.push(provider);
    }
  }
  for (const preset of PROVIDER_PRESETS) {
    if (preset.id === 'custom' || seen.has(preset.id)) continue;
    seen.add(preset.id);
    out.push(createProviderFromPreset(preset.id));
  }
  return out;
}

function normalizeDefaults(raw, providers) {
  const src = isObj(raw) ? raw : {};
  const ids = new Set(providers.map((p) => p.id));
  const out = {};
  for (const purpose of PURPOSES) {
    const entry = src[purpose];
    const providerId = isObj(entry) ? trimmed(entry.providerId) : '';
    out[purpose] = providerId && ids.has(providerId)
      ? { providerId, model: trimmed(entry.model) }
      : null;
  }
  return out;
}

// Always goes through URL so IDNs end up in punycode, like location.hostname.
function normalizeHost(value) {
  const raw = trimmed(value).toLowerCase();
  if (!raw) return '';
  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`).hostname;
  } catch {
    return '';
  }
  return host.replace(/^\*\./, '').replace(/\.$/, '');
}

function normalizeHosts(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string') list = raw.split(/[\n,;\s]+/);
  const out = [];
  for (const item of list) {
    const host = normalizeHost(item);
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

// Built-in fallbacks are looked up by id, so they work for stored German and English defaults alike.
function normalizeQuickActions(raw) {
  const defaults = getDefaultQuickActions();
  if (!Array.isArray(raw)) return defaults;
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!isObj(item)) continue;
    let id = trimmed(item.id);
    if (!id || seen.has(id)) id = `qa-${uid()}`;
    seen.add(id);
    const builtin = defaults.find((a) => a.id === id) ?? null;
    out.push({
      ...item,
      id,
      name: nonEmpty(item.name, builtin?.name ?? t('core.settings.fallback.actionName')),
      icon: [...nonEmpty(item.icon, builtin?.icon ?? '⚡')].slice(0, 8).join(''),
      // Empty prompts are kept (the user may be editing); buildActionRequest falls back for built-ins.
      prompt: str(item.prompt, builtin?.prompt ?? ''),
      toolbar: bool(item.toolbar, builtin?.toolbar ?? false),
      contextMenu: bool(item.contextMenu, builtin?.contextMenu ?? true),
      builtin: Boolean(builtin),
    });
  }
  return out;
}

function normalizePersonas(raw) {
  const defaults = getDefaultPersonas();
  if (!Array.isArray(raw)) return defaults;
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!isObj(item)) continue;
    let id = trimmed(item.id);
    if (!id || seen.has(id)) {
      if (id === 'default') continue; // only one default persona
      id = `persona-${uid()}`;
    }
    seen.add(id);
    const known = defaults.find((p) => p.id === id);
    out.push({
      ...item,
      id,
      name: nonEmpty(item.name, known?.name ?? t('core.settings.fallback.personaName')),
      prompt: str(item.prompt, known?.prompt ?? ''),
    });
  }
  const index = out.findIndex((p) => p.id === 'default');
  if (index === -1) out.unshift(defaults[0]);
  else if (index > 0) out.unshift(...out.splice(index, 1));
  return out;
}

export function normalizeSettings(raw) {
  // Work on a copy so the result never aliases (or mutates) the input.
  const src = isObj(raw) ? deepClone(raw) : {};
  const defaults = getDefaultSettings();

  const providers = normalizeProviders(src.providers);
  const personas = normalizePersonas(src.personas);

  const general = isObj(src.general) ? src.general : {};
  const chat = isObj(src.chat) ? src.chat : {};
  const profile = isObj(src.profile) ? src.profile : {};
  const toolbar = isObj(src.toolbar) ? src.toolbar : {};
  const translate = isObj(src.translate) ? src.translate : {};
  const youtube = isObj(src.youtube) ? src.youtube : {};
  const usage = isObj(src.usage) ? src.usage : {};
  const personaId = trimmed(chat.personaId);

  return {
    ...src, // unknown top-level keys are kept
    schemaVersion: SCHEMA_VERSION,
    providers,
    defaults: normalizeDefaults(src.defaults, providers),
    general: {
      ...general,
      theme: oneOf(general.theme, THEMES, defaults.general.theme),
      language: matchLanguage(general.language) ?? AUTO_LANGUAGE,
      sendWithEnter: bool(general.sendWithEnter, defaults.general.sendWithEnter),
      streaming: bool(general.streaming, defaults.general.streaming),
    },
    chat: {
      ...chat,
      systemPrompt: str(chat.systemPrompt),
      personaId: personas.some((p) => p.id === personaId) ? personaId : 'default',
      temperature: optionalNumber(chat.temperature, LIMITS.temperature),
      maxTokens: optionalNumber(chat.maxTokens, LIMITS.maxTokens, { integer: true, positive: true }),
      contextMessages: intInRange(chat.contextMessages, LIMITS.contextMessages, defaults.chat.contextMessages),
      includePageByDefault: bool(chat.includePageByDefault, defaults.chat.includePageByDefault),
      useProfileInChat: bool(chat.useProfileInChat, defaults.chat.useProfileInChat),
    },
    profile: {
      ...profile,
      aboutMe: str(profile.aboutMe),
      writingStyle: str(profile.writingStyle),
    },
    toolbar: {
      ...toolbar,
      enabled: bool(toolbar.enabled, defaults.toolbar.enabled),
      disabledHosts: normalizeHosts(toolbar.disabledHosts),
    },
    translate: {
      ...translate,
      targetLang: normalizeTargetLanguage(translate.targetLang, defaults.translate.targetLang),
      batchChars: intInRange(translate.batchChars, LIMITS.batchChars, defaults.translate.batchChars),
      concurrency: intInRange(translate.concurrency, LIMITS.concurrency, defaults.translate.concurrency),
    },
    youtube: {
      ...youtube,
      summaryLang: normalizeTargetLanguage(youtube.summaryLang, defaults.youtube.summaryLang),
    },
    usage: {
      ...usage,
      showInChat: bool(usage.showInChat, defaults.usage.showInChat),
    },
    quickActions: normalizeQuickActions(src.quickActions),
    personas,
  };
}

// ---------- persistence ----------

export async function getSettings() {
  const stored = await ext.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored?.[SETTINGS_KEY]);
}

export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  await ext.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

// Serialize read-modify-write cycles within one context so concurrent updates don't get lost.
let updateQueue = Promise.resolve();

export async function updateSettings(mutator) {
  const run = updateQueue.then(async () => {
    const current = await getSettings();
    const result = typeof mutator === 'function' ? await mutator(current) : undefined;
    return saveSettings(isObj(result) ? result : current);
  });
  updateQueue = run.catch(() => {});
  return run;
}

export function onSettingsChanged(cb) {
  const listener = (changes, areaName) => {
    if (areaName !== 'local' || !changes || !Object.prototype.hasOwnProperty.call(changes, SETTINGS_KEY)) return;
    try {
      cb(normalizeSettings(changes[SETTINGS_KEY].newValue));
    } catch (err) {
      console.error('[LLM Sidebar] onSettingsChanged callback failed:', err);
    }
  };
  ext.storage.onChanged.addListener(listener);
  return () => ext.storage.onChanged.removeListener(listener);
}

// ---------- providers & targets ----------

export function getProvider(settings, providerId) {
  if (!providerId || !Array.isArray(settings?.providers)) return null;
  return settings.providers.find((p) => p?.id === providerId) ?? null;
}

export function isProviderReady(provider) {
  if (!isObj(provider) || provider.enabled !== true) return false;
  if (!trimmed(provider.baseUrl)) return false;
  return Boolean(trimmed(provider.apiKey)) || !getPreset(provider.presetId).requiresKey;
}

export function getReadyProviders(settings) {
  return Array.isArray(settings?.providers) ? settings.providers.filter(isProviderReady) : [];
}

const supportsImages = (provider) => Boolean(provider?.imageApi) && provider.imageApi !== 'none';

function chatModelOf(provider, preferred = '') {
  return trimmed(preferred) || trimmed(provider.defaultModel) || trimmed(provider.models?.[0]);
}

function imageModelOf(provider, preferred = '') {
  return trimmed(preferred) || trimmed(provider.defaultImageModel) || trimmed(provider.imageModels?.[0]);
}

const FALLBACK_CHAINS = {
  chat: ['chat'],
  actions: ['actions', 'chat'],
  translate: ['translate', 'actions', 'chat'],
  image: ['image'],
};

export function resolveTarget(settings, purpose) {
  const isImage = purpose === 'image';
  const chain = FALLBACK_CHAINS[purpose] ?? FALLBACK_CHAINS.chat;
  const modelOf = isImage ? imageModelOf : chatModelOf;

  for (const key of chain) {
    const entry = settings?.defaults?.[key];
    if (!isObj(entry)) continue;
    const provider = getProvider(settings, entry.providerId);
    if (!isProviderReady(provider) || (isImage && !supportsImages(provider))) continue;
    const model = modelOf(provider, entry.model);
    if (model) return { provider, model };
  }

  for (const provider of getReadyProviders(settings)) {
    if (isImage && !supportsImages(provider)) continue;
    const model = modelOf(provider);
    if (model) return { provider, model };
  }
  return null;
}

function modelEntries(provider, models, preferred) {
  const list = [];
  const first = trimmed(preferred);
  if (first) list.push(first);
  for (const m of Array.isArray(models) ? models : []) {
    const id = trimmed(m);
    if (id && !list.includes(id)) list.push(id);
  }
  return list.map((model) => ({
    providerId: provider.id,
    providerName: provider.name,
    model,
    label: `${provider.name} · ${model}`,
  }));
}

export function listChatModels(settings) {
  return getReadyProviders(settings).flatMap((p) => modelEntries(p, p.models, p.defaultModel));
}

export function listImageModels(settings) {
  return getReadyProviders(settings)
    .filter(supportsImages)
    .flatMap((p) => modelEntries(p, p.imageModels, p.defaultImageModel));
}

// ---------- content script config ----------

export function getContentConfig(settings) {
  const s = normalizeSettings(settings);
  return {
    ready: resolveTarget(s, 'actions') !== null,
    toolbar: { enabled: s.toolbar.enabled, disabledHosts: [...s.toolbar.disabledHosts] },
    // Display names: built-in, unrenamed actions follow the UI language.
    quickActions: s.quickActions.map((a) => ({
      id: a.id, name: quickActionName(a), icon: a.icon, toolbar: a.toolbar, contextMenu: a.contextMenu,
    })),
    // Labels are in the active UI language: call setLanguage() before (the background does).
    uiLanguage: resolveLanguage(s.general.language),
    languages: languageOptions({ current: s.translate.targetLang, includeAuto: false }),
    translate: {
      targetLang: resolveTargetLanguage(s.translate.targetLang),
      batchChars: s.translate.batchChars,
      concurrency: s.translate.concurrency,
    },
    theme: s.general.theme,
    showUsage: s.usage.showInChat, // tokens and costs of translations and quick actions
  };
}

// ---------- export / import ----------

const protocolOf = (provider) => (provider?.protocol === 'anthropic' ? 'anthropic' : 'openai');
const sameEndpoint = (a, b) => normalizeBaseUrl(a?.baseUrl) === normalizeBaseUrl(b?.baseUrl) && protocolOf(a) === protocolOf(b);

export function exportSettings(settings, { includeKeys = false } = {}) {
  const s = normalizeSettings(settings);
  if (!includeKeys) {
    for (const provider of s.providers) {
      provider.apiKey = '';
      provider.billing.managementKey = '';
      // Header values may carry credentials (proxy tokens, subscription keys): keep the names,
      // blank every value except the preset's own non-secret defaults.
      const presetHeaders = getPreset(provider.presetId).extraHeaders;
      for (const [name, value] of Object.entries(provider.extraHeaders)) {
        if (value !== presetHeaders[name]) provider.extraHeaders[name] = '';
      }
    }
  }
  return JSON.stringify({
    format: 'llm-sidebar-settings',
    exportedAt: new Date().toISOString(),
    keysIncluded: Boolean(includeKeys),
    settings: s,
  }, null, 2);
}

export function parseImportedSettings(json, { currentSettings } = {}) {
  let data = json;
  if (typeof json === 'string') {
    if (!json.trim()) throw new Error(t('core.settings.import.empty'));
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error(t('core.settings.import.invalidJson'));
    }
  }
  if (Array.isArray(data)) {
    throw new Error(t('core.settings.import.chatExport'));
  }
  if (!isObj(data)) throw new Error(t('core.settings.import.noSettings'));

  const candidate = isObj(data.settings) ? data.settings : data;
  if (!SETTINGS_SECTIONS.some((key) => Object.prototype.hasOwnProperty.call(candidate, key))) {
    throw new Error(t('core.settings.import.notSidebarSettings'));
  }
  if (candidate.providers !== undefined && !Array.isArray(candidate.providers)) {
    throw new Error(t('core.settings.import.providersNotList'));
  }

  const imported = normalizeSettings(candidate);
  // Keep the current key (and blanked header values) for providers the file has none for – but
  // only while base URL and protocol are unchanged, so a shared file cannot redirect a key.
  if (currentSettings && Array.isArray(currentSettings.providers)) {
    for (const provider of imported.providers) {
      const existing = getProvider(currentSettings, provider.id);
      if (!isObj(existing) || !sameEndpoint(provider, existing)) continue;
      if (!provider.apiKey && trimmed(existing.apiKey)) provider.apiKey = trimmed(existing.apiKey);
      const existingMgmt = trimmed(existing.billing?.managementKey);
      if (!provider.billing.managementKey && existingMgmt) provider.billing.managementKey = existingMgmt;
      const currentHeaders = isObj(existing.extraHeaders) ? existing.extraHeaders : {};
      for (const [name, value] of Object.entries(provider.extraHeaders)) {
        const current = currentHeaders[name];
        if (value === '' && typeof current === 'string' && current) provider.extraHeaders[name] = current;
      }
    }
  }
  return imported;
}
