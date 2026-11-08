// Pure helpers for the provider cards: status, model-list merging, field validation.
// No DOM access, so the logic can be exercised outside the browser.

import { getPreset } from '../lib/providers.js';
import { isImageModelId } from '../lib/llm.js';
import { t } from '../lib/i18n.js';

export const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const trim = (v) => (typeof v === 'string' ? v.trim() : '');

function unique(list) {
  const out = [];
  for (const item of list) {
    const id = trim(item);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Provider config enriched with the preset facts lib/llm.js cannot know on its own. */
export function llmProvider(provider) {
  const preset = getPreset(provider?.presetId);
  return { ...provider, requiresKey: preset.requiresKey, supportsModelList: preset.supportsModelList };
}

export function needsKey(provider) {
  return getPreset(provider?.presetId).requiresKey && !trim(provider?.apiKey);
}

/** → { ready, label, cls } for the status badge of a provider card. */
export function providerStatus(provider) {
  const missingKey = needsKey(provider);
  if (!provider?.enabled) {
    return { ready: false, label: missingKey ? t('options.providers.status.noKey') : t('options.providers.status.disabled'), cls: '' };
  }
  if (!trim(provider.baseUrl)) return { ready: false, label: t('options.providers.status.noBaseUrl'), cls: 'badge-danger' };
  if (missingKey) return { ready: false, label: t('options.providers.status.noKey'), cls: 'badge-warning' };
  // Without a model resolveTarget() skips the provider, so it is not usable yet.
  const hasImage = provider.imageApi !== 'none' && Boolean(trim(provider.defaultImageModel) || provider.imageModels?.length);
  if (!hasChatModel(provider) && !hasImage) return { ready: false, label: t('options.providers.status.noModel'), cls: 'badge-warning' };
  return { ready: true, label: t('options.providers.status.ready'), cls: 'badge-success' };
}

/** Enabled, configured and with at least one model – what the summary, nav badge and welcome count. */
export function isProviderUsable(provider) {
  return providerStatus(provider).ready;
}

function hasChatModel(provider) {
  return Boolean(trim(provider?.defaultModel) || provider?.models?.some((m) => trim(m)));
}

/**
 * True when an enabled provider can list its models but has none yet (Ollama, LM Studio, custom):
 * the options page then loads the list right away instead of leaving the provider unusable.
 */
export function shouldAutoLoadModels(provider) {
  if (!provider?.enabled || !trim(provider.baseUrl) || needsKey(provider)) return false;
  if (!getPreset(provider.presetId).supportsModelList) return false;
  return !hasChatModel(provider);
}

/** Splits manually entered model ids (one or several, separated by whitespace, comma or semicolon). */
export function splitModelIds(text) {
  return unique(String(text ?? '').split(/[\s,;]+/));
}

/**
 * Merges a listModels() result into a provider.
 * - fetched ids replace the previous list; ids the user added by hand (not fetched before, not a preset
 *   suggestion) are kept,
 * - image models (imageOutput or an image-like id) go to imageModels,
 * - the current default models are kept (and stay in the lists); empty defaults get a sensible pick.
 * → { models, imageModels, modelInfo, defaultModel, defaultImageModel, stats }
 */
export function mergeFetchedModels(provider, list) {
  const preset = getPreset(provider?.presetId);
  const fetchedChat = [];
  const fetchedImage = [];
  const modelInfo = {};
  for (const entry of Array.isArray(list) ? list : []) {
    const id = trim(entry?.id);
    if (!id || modelInfo[id]) continue;
    const image = entry.imageOutput === true || isImageModelId(id);
    (image ? fetchedImage : fetchedChat).push(id);
    const info = {};
    if (trim(entry.name)) info.name = trim(entry.name);
    if (entry.vision === true) info.vision = true;
    if (image) info.imageOutput = true;
    if (Number.isFinite(entry.contextLength) && entry.contextLength > 0) info.contextLength = entry.contextLength;
    if (Number.isFinite(entry.inputPrice) && Number.isFinite(entry.outputPrice)) {
      info.inputPrice = entry.inputPrice;
      info.outputPrice = entry.outputPrice;
    }
    modelInfo[id] = info;
  }

  const fetched = new Set([...fetchedChat, ...fetchedImage]);
  const knownBefore = new Set(Object.keys(provider?.modelInfo ?? {}));
  const userAdded = (ids, suggestions) => unique(ids ?? []).filter(
    (id) => !fetched.has(id) && !knownBefore.has(id) && !suggestions.includes(id),
  );
  const keptChat = userAdded(provider?.models, preset.defaultModels);
  const keptImage = userAdded(provider?.imageModels, preset.defaultImageModels);

  const models = unique([...fetchedChat, ...keptChat]);
  const imageModels = unique([...fetchedImage, ...keptImage]);

  let defaultModel = trim(provider?.defaultModel);
  let missingDefault = '';
  if (defaultModel) {
    if (!models.includes(defaultModel)) {
      if (!fetched.has(defaultModel)) missingDefault = defaultModel;
      if (!fetchedImage.includes(defaultModel)) models.unshift(defaultModel);
    }
  } else {
    defaultModel = fetchedChat.includes(preset.defaultModel) ? preset.defaultModel : (models[0] ?? '');
  }

  let defaultImageModel = trim(provider?.defaultImageModel);
  if (defaultImageModel) {
    if (!imageModels.includes(defaultImageModel)) imageModels.unshift(defaultImageModel);
  } else {
    defaultImageModel = fetchedImage.includes(preset.defaultImageModel) ? preset.defaultImageModel : (imageModels[0] ?? '');
  }

  return {
    models,
    imageModels,
    modelInfo,
    defaultModel,
    defaultImageModel,
    stats: {
      chat: fetchedChat.length,
      image: fetchedImage.length,
      kept: keptChat.length + keptImage.length,
      missingDefault,
    },
  };
}

/** Summary line (UI language) for a merge result. */
export function describeMerge(provider, merged) {
  const { chat, image, kept, missingDefault } = merged.stats;
  if (!chat && !image) {
    if (provider?.presetId === 'ollama') return t('options.providers.merge.none.ollama');
    if (provider?.presetId === 'lmstudio') return t('options.providers.merge.none.lmstudio');
    return t('options.providers.merge.none.generic');
  }
  const chatText = t('options.providers.merge.chatModels', { count: chat });
  const parts = [image
    ? t('options.providers.merge.loadedBoth', { chat: chatText, image: t('options.providers.merge.imageModels', { count: image }) })
    : t('options.providers.merge.loaded', { models: chatText })];
  if (kept) parts.push(t('options.providers.merge.kept', { count: kept }));
  if (missingDefault) parts.push(t('options.providers.merge.missingDefault', { model: missingDefault }));
  if (image && provider?.imageApi === 'none' && provider?.protocol !== 'anthropic') {
    parts.push(t('options.providers.merge.chooseImageApi'));
  }
  return parts.join(' ');
}

/** → { ok: true, value } | { ok: false, error } for the base URL field. Empty is allowed (warned). */
export function validateBaseUrl(text) {
  const value = trim(text);
  if (!value) return { ok: true, value: '', warning: t('options.providers.url.empty') };
  if (!/^https?:\/\//i.test(value)) {
    return { ok: false, error: t('options.providers.url.scheme') };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: t('options.providers.url.invalid') };
  }
  if (!url.hostname) return { ok: false, error: t('options.providers.url.invalid') };
  if (/\s/.test(value)) return { ok: false, error: t('options.providers.url.spaces') };
  let warning = '';
  if (url.protocol === 'http:' && !isLocalHostname(url.hostname)) {
    warning = t('options.providers.url.insecure');
  } else if (/\/(chat\/completions|messages)\/?$/i.test(url.pathname)) {
    warning = t('options.providers.url.fullPath');
  }
  return { ok: true, value: value.replace(/\/+$/, ''), warning };
}

function isLocalHostname(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1'
    || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || h === 'host.docker.internal';
}

/** → { ok: true, value: object } | { ok: false, error } for the extra-headers JSON textarea. */
export function parseHeadersJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: true, value: {} };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: t('options.providers.headers.invalidJson') };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: t('options.providers.headers.notObject') };
  }
  const value = {};
  for (const [name, val] of Object.entries(data)) {
    const key = name.trim();
    if (!HEADER_NAME_RE.test(key)) return { ok: false, error: t('options.providers.headers.invalidName', { name }) };
    if (typeof val !== 'string' && typeof val !== 'number') {
      return { ok: false, error: t('options.providers.headers.invalidValue', { name: key }) };
    }
    value[key] = String(val);
  }
  return { ok: true, value };
}

export function headersToText(headers) {
  const entries = headers && typeof headers === 'object' ? Object.keys(headers) : [];
  return entries.length ? JSON.stringify(headers, null, 2) : '';
}

const endpointOf = (p) => `${p?.protocol === 'anthropic' ? 'anthropic' : 'openai'} ${trim(p?.baseUrl).replace(/\/+$/, '')}`;

/**
 * What a parsed settings import changes for providers that exist already – for the confirmation
 * dialog. A changed endpoint (base URL or protocol) means the stored key is not carried over.
 * → { endpoints: [{ id, name, from, to, keyDropped, keyKept }], blankHeaders: [provider name] }
 */
export function describeImportedProviders(currentSettings, imported) {
  const current = Array.isArray(currentSettings?.providers) ? currentSettings.providers : [];
  const endpoints = [];
  const blankHeaders = [];
  for (const p of Array.isArray(imported?.providers) ? imported.providers : []) {
    const before = current.find((x) => x?.id === p?.id);
    if (before && endpointOf(before) !== endpointOf(p)) {
      const oldKey = trim(before.apiKey);
      const newKey = trim(p.apiKey);
      endpoints.push({
        id: p.id,
        name: p.name || p.id,
        from: trim(before.baseUrl),
        to: trim(p.baseUrl),
        keyDropped: Boolean(oldKey) && !newKey,
        keyKept: Boolean(oldKey) && newKey === oldKey,
      });
    }
    const headers = p?.extraHeaders && typeof p.extraHeaders === 'object' ? Object.values(p.extraHeaders) : [];
    if (p?.enabled && headers.some((v) => !trim(String(v ?? '')))) blankHeaders.push(p.name || p.id);
  }
  return { endpoints, blankHeaders };
}
