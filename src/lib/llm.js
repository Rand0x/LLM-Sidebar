// Unified LLM client: chat streaming, image generation and model listing for
// OpenAI-compatible and Anthropic-compatible providers.
// Runs in Chrome MV3 service workers, Firefox background pages and extension pages
// (uses only fetch, Headers, Blob, TextDecoder, AbortController, btoa).
// NOTE: deliberately does not import lib/providers.js – all provider quirks are keyed by
// provider.presetId (with base-URL and model-name heuristics as fallback), see ARCHITECTURE §6.

import { readSSE } from './sse.js';
import { truncate, hostnameOf, dataUrlParts, clamp } from './utils.js';
import { t, getLocale } from './i18n.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LLM_ERROR_CODES = Object.freeze([
  'no_provider', 'no_key', 'auth', 'forbidden', 'not_found', 'rate_limit', 'quota',
  'bad_request', 'server', 'network', 'aborted', 'parse', 'unsupported',
]);
const ERROR_CODE_SET = new Set(LLM_ERROR_CODES);

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_DEFAULT_MAX_TOKENS = 16000;
const CLAUDE_THINKING_MODEL = /^claude-(opus|sonnet|haiku|fable)-5/;
const ANTHROPIC_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const IMAGE_MODEL_RE = /gpt-image|dall-e|imagine|imagen|image-gen|nano-banana|cogview|glm-image|flux|stable-diffusion|sdxl|-image\b|image-preview/i;
const NON_CHAT_MODEL_RE = /embed|tts|whisper|transcribe|audio|realtime|moderation|rerank|babbage|davinci|sora|video|\bveo\b|lyria|speech/i;
const VIDEO_MODEL_RE = /video|sora|\bveo\b/i;
// Vision input formats per family where the provider is stricter than the usual four
// (docs/research: xAI takes only JPEG/PNG, Gemini no GIF); other formats are re-encoded to PNG.
const IMAGE_INPUT_TYPES = {
  xai: ['image/jpeg', 'image/png'],
  gemini: ['image/jpeg', 'image/png', 'image/webp'],
};

const KNOWN_FAMILIES = new Set([
  'openai', 'anthropic', 'openrouter', 'xai', 'zai', 'gemini', 'mistral', 'deepseek', 'groq',
  'ollama', 'ollama-cloud', 'lmstudio',
]);
const MAX_COMPLETION_TOKENS_FAMILIES = new Set(['openai', 'xai', 'groq']);
const NO_TEMPERATURE_FAMILIES = new Set(['openai', 'gemini']);
// Families known to accept stream_options.include_usage (Mistral rejects it, OpenRouter ignores it).
const STREAM_USAGE_FAMILIES = new Set(['openai', 'xai', 'gemini', 'deepseek', 'groq', 'ollama', 'ollama-cloud']);
// Presets (and URL-derived families) that work without a key: local servers and own endpoints.
const KEYLESS_FAMILIES = new Set(['ollama', 'lmstudio', 'custom']);
const MISTRAL_BODY_FIELDS = ['model', 'messages', 'stream', 'max_tokens', 'temperature'];
// Models that reject or ignore sampling parameters (bare id, vendor prefix stripped).
const NO_TEMPERATURE_MODEL_RE = /^(o\d|gpt-[5-9]|gpt-\d{2}|gemini-|claude-)/i;
const MAX_COMPLETION_TOKENS_MODEL_RE = /^(o\d|gpt-[5-9]|gpt-\d{2})/i;

const QUOTA_RE = /quota|billing|credit|balance|insufficient_funds|payment required|guthaben/i;
const AUTH_RE = /api[\s_-]?key|credential|unauthori[sz]ed|authenticat|invalid[\s_-]?token/i;
const RATE_RE = /rate[\s_-]?limit|too many requests/i;

const ERROR_TYPE_CODES = {
  authentication_error: 'auth',
  invalid_api_key: 'auth',
  unauthenticated: 'auth',
  permission_error: 'forbidden',
  permission_denied: 'forbidden',
  forbidden: 'forbidden',
  not_found_error: 'not_found',
  not_found: 'not_found',
  model_not_found: 'not_found',
  rate_limit_error: 'rate_limit',
  rate_limit_exceeded: 'rate_limit',
  resource_exhausted: 'rate_limit',
  billing_error: 'quota',
  insufficient_quota: 'quota',
  invalid_request_error: 'bad_request',
  invalid_argument: 'bad_request',
  request_too_large: 'bad_request',
  overloaded_error: 'server',
  api_error: 'server',
  server_error: 'server',
  internal: 'server',
  unavailable: 'server',
};

// Z.AI business error codes (strings).
const ZAI_ERROR_CODES = {
  1000: 'auth', 1001: 'auth', 1002: 'auth', 1003: 'auth', 1004: 'auth',
  1113: 'quota', 1304: 'quota', 1308: 'quota', 1309: 'quota', 1310: 'quota',
  1302: 'rate_limit', 1303: 'rate_limit', 1305: 'rate_limit',
  1211: 'not_found',
};

const FINISH_MAP = {
  stop: 'stop',
  end_turn: 'stop',
  stop_sequence: 'stop',
  eos: 'stop',
  length: 'length',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  content_filter: 'content_filter',
  sensitive: 'content_filter',
  refusal: 'refusal',
  tool_calls: 'tool_calls',
  tool_use: 'tool_calls',
  function_call: 'tool_calls',
};

const MAX_IMAGE_DOWNLOAD_BYTES = 30 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// User-facing messages are in the UI language (t()); `{http}` is " (HTTP 401)" or ''.
function defaultMessage(code, { name = '', status = 0, model = '' } = {}) {
  const http = status ? ` (HTTP ${status})` : '';
  const named = (key) => t(name ? `${key}Named` : key, { name, http });
  switch (code) {
    case 'no_provider':
      return t('core.llm.error.noProvider');
    case 'no_key':
      return named('core.llm.error.noKey');
    case 'auth':
      return named('core.llm.error.auth');
    case 'forbidden':
      return named('core.llm.error.forbidden');
    case 'not_found':
      return model
        ? t('core.llm.error.notFoundModel', { model, http })
        : t('core.llm.error.notFound', { http });
    case 'rate_limit':
      return named('core.llm.error.rateLimit');
    case 'quota':
      return named('core.llm.error.quota');
    case 'bad_request':
      return named('core.llm.error.badRequest');
    case 'server':
      return named('core.llm.error.server');
    case 'network':
      return named('core.llm.error.network');
    case 'aborted':
      return t('core.llm.error.aborted');
    case 'parse':
      return named('core.llm.error.parse');
    case 'unsupported':
      return named('core.llm.error.unsupported');
    default:
      return t('core.llm.error.unknown');
  }
}

function safeProviderInfo(provider) {
  if (!provider || typeof provider !== 'object') return null;
  return {
    id: String(provider.id || ''),
    presetId: String(provider.presetId || ''),
    name: String(provider.name || ''),
    baseUrl: String(provider.baseUrl || ''),
  };
}

/**
 * Error thrown by every function of this module.
 * new LLMError(code, message?, { status, details, provider, model, providerCode, cause })
 * - code: one of LLM_ERROR_CODES
 * - message: text in the UI language (defaults to a generic sentence for the code)
 * - status: HTTP status (0 if none); details: provider's own error message ('' if none)
 * - provider: { id, presetId, name, baseUrl } (never contains the API key)
 * - partial: { text, reasoning, images } for errors during streaming (set by streamChat)
 */
export class LLMError extends Error {
  constructor(code, message = '', options = {}) {
    const { status = 0, details = '', provider = null, model = '', providerCode = '', cause } = options || {};
    const info = safeProviderInfo(provider);
    super(message || defaultMessage(code, { name: info?.name, status, model }), cause !== undefined ? { cause } : undefined);
    this.name = 'LLMError';
    this.code = code;
    this.status = Number(status) || 0;
    this.details = details ? String(details) : '';
    this.provider = info;
    this.model = model ? String(model) : '';
    this.providerCode = providerCode !== undefined && providerCode !== null ? String(providerCode) : '';
    this.partial = null;
  }
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 'aborted';
}

// "PNG, JPEG oder WebP" / "PNG, JPEG, or WebP" in the UI language.
function formatList(items) {
  try {
    return new Intl.ListFormat(getLocale(), { type: 'disjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

function ensurePeriod(text) {
  const s = String(text || '').trim();
  return !s || /[.!?…“"]$/.test(s) ? s : `${s}.`;
}

function familyOf(provider) {
  const preset = String(provider?.presetId || '').toLowerCase();
  if (KNOWN_FAMILIES.has(preset)) return preset;
  const baseUrl = String(provider?.baseUrl || '');
  const host = hostnameOf(baseUrl).toLowerCase();
  if (!host) return 'custom';
  const is = (domain) => host === domain || host.endsWith(`.${domain}`);
  if (is('openai.com')) return 'openai';
  if (is('anthropic.com')) return 'anthropic';
  if (is('openrouter.ai')) return 'openrouter';
  if (is('x.ai')) return 'xai';
  if (is('z.ai') || is('bigmodel.cn')) return 'zai';
  if (is('generativelanguage.googleapis.com')) return 'gemini';
  if (is('mistral.ai')) return 'mistral';
  if (is('deepseek.com')) return 'deepseek';
  if (is('groq.com')) return 'groq';
  if (is('ollama.com')) return 'ollama-cloud';
  if (isLocalHost(host)) {
    let port = '';
    try {
      port = new URL(baseUrl).port;
    } catch {
      port = '';
    }
    if (port === '11434') return 'ollama';
    if (port === '1234') return 'lmstudio';
  }
  return 'custom';
}

function isLocalHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || /^127\./.test(h)
    || h === '[::1]' || h === '::1' || h === '0.0.0.0' || h === 'host.docker.internal'
    || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

function hintFor(err) {
  const p = err.provider || {};
  const family = familyOf(p);
  const baseUrl = String(p.baseUrl || '');
  const local = isLocalHost(hostnameOf(baseUrl));
  const zaiCoding = /\/coding\//i.test(baseUrl);
  switch (err.code) {
    case 'forbidden':
      if (family === 'ollama') return t('core.llm.hint.ollamaOrigins');
      if (family === 'gemini') return t('core.llm.hint.geminiKey');
      if (family === 'lmstudio') return t('core.llm.hint.lmstudioCors');
      if (local) return t('core.llm.hint.localBlocked');
      return '';
    case 'network':
      if (family === 'ollama') return t('core.llm.hint.ollamaRunning', { hint: t('core.llm.hint.ollamaOrigins') });
      if (family === 'lmstudio') return t('core.llm.hint.lmstudioCors');
      if (local) return t('core.llm.hint.localServer', { url: baseUrl });
      return t('core.llm.hint.network');
    case 'auth':
      if (family === 'zai') return t(zaiCoding ? 'core.llm.hint.zaiCodingKey' : 'core.llm.hint.zaiGeneralKey');
      if (family === 'gemini') return t('core.llm.hint.geminiNewKey');
      if (family === 'lmstudio') return t('core.llm.hint.lmstudioAuth');
      if (family === 'ollama-cloud') return t('core.llm.hint.ollamaCloudKey');
      return '';
    case 'quota':
      if (family === 'zai' && !zaiCoding) return t('core.llm.hint.zaiGeneralKey');
      if (family === 'zai' && err.providerCode === '1309') return t('core.llm.hint.zaiExpired');
      return '';
    case 'not_found':
      if (family === 'ollama') return t('core.llm.hint.ollamaModel');
      if (family === 'lmstudio') return t('core.llm.hint.lmstudioModel');
      return '';
    default:
      return '';
  }
}

/** User-facing one-liner (UI language) for any error (LLMError, AbortError, TypeError, string). */
export function describeError(err) {
  if (err == null) return t('core.llm.error.unknown');
  if (typeof err === 'string') return err || t('core.llm.error.unknown');
  if (isAbortError(err)) return t('core.llm.error.aborted');
  if (err instanceof LLMError || (typeof err.code === 'string' && ERROR_CODE_SET.has(err.code))) {
    const provider = safeProviderInfo(err.provider);
    const base = ensurePeriod(err.message || defaultMessage(err.code, {
      name: provider?.name, status: err.status, model: err.model,
    }));
    const parts = [base];
    const details = cleanText(err.details);
    if (details && !['aborted', 'no_key', 'no_provider'].includes(err.code) && !base.includes(details)) {
      parts.push(t('core.llm.error.providerMessage', { details: truncate(details, 300) }));
    }
    const hint = hintFor({ code: err.code, provider, providerCode: err.providerCode });
    if (hint) parts.push(hint);
    return parts.join(' ');
  }
  if (err instanceof TypeError || err?.name === 'TypeError') {
    return t('core.llm.error.connection');
  }
  const msg = cleanText(err.message || '');
  return msg ? ensurePeriod(truncate(msg, 400)) : t('core.llm.error.unknown');
}

function cleanText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function sanitizeDetail(text, ctx) {
  let s = String(text ?? '');
  if (!s) return '';
  if (ctx?.apiKey && ctx.apiKey.length >= 6) s = s.split(ctx.apiKey).join('***');
  s = s.replace(/\b(sk-(?:proj-|ant-(?:api\d+-)?|or-v1-)?|xai-|gsk_|AIza)[A-Za-z0-9_-]{12,}/g, '$1***');
  if (/<\/?[a-z][\s\S]*>/i.test(s)) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
    s = title ? title[1] : s.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  }
  return truncate(cleanText(s), 1000);
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

function scalar(v) {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

function detailText(detail) {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (typeof d === 'string' ? d : str(d?.msg) || str(d?.message)))
      .filter(Boolean)
      .join('; ');
  }
  if (detail && typeof detail === 'object') return str(detail.message) || str(detail.msg);
  return '';
}

/** Extracts { message, code, type } from any known error payload shape. */
function extractErrorInfo(payload) {
  let node = payload;
  if (Array.isArray(node)) node = node.find((x) => x && typeof x === 'object') ?? node[0];
  if (typeof node === 'string') return { message: node, code: '', type: '' };
  if (!node || typeof node !== 'object') return { message: '', code: '', type: '' };
  let message = '';
  let code = '';
  let type = '';
  const err = node.error;
  if (typeof err === 'string') {
    message = err;
  } else if (err && typeof err === 'object') {
    message = str(err.message) || str(err.msg) || detailText(err.detail) || str(err.error_description)
      || str(err.error);
    code = scalar(err.code);
    type = str(err.type) || str(err.status);
    const raw = err.metadata?.raw;
    if (raw) {
      let rawMsg = '';
      if (typeof raw === 'string') {
        try {
          rawMsg = extractErrorInfo(JSON.parse(raw)).message || raw;
        } catch {
          rawMsg = raw;
        }
      } else {
        rawMsg = extractErrorInfo(raw).message;
      }
      if (rawMsg && !message.includes(rawMsg)) message = message ? `${message}: ${rawMsg}` : rawMsg;
    }
    if (!type && err.metadata?.error_type) type = str(err.metadata.error_type);
  }
  if (!message) {
    message = str(node.message) || detailText(node.detail) || str(node.msg) || str(node.error_description)
      || str(node.title);
  }
  if (!code) code = scalar(node.code);
  if (!type && node.type !== 'error') type = str(node.type) || str(node.status);
  return { message: message.trim(), code, type };
}

function parseErrorBody(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { message: '', code: '', type: '' };
  try {
    return extractErrorInfo(JSON.parse(text));
  } catch {
    // SSE-formatted error body?
    const dataLine = /^data:\s*(.+)$/m.exec(text);
    if (dataLine) {
      try {
        return extractErrorInfo(JSON.parse(dataLine[1]));
      } catch {
        // fall through
      }
    }
  }
  return { message: text, code: '', type: '' };
}

function classify(status, info, family) {
  // URLs are dropped first: rate-limit messages often link to …/settings/billing.
  const message = String(info.message || '').replace(/\bhttps?:\/\/\S+/gi, ' ');
  const hay = `${message} ${info.code} ${info.type}`;
  const key = (s) => String(s || '').toLowerCase().replace(/[\s-]+/g, '_');
  const byType = ERROR_TYPE_CODES[key(info.type)] || ERROR_TYPE_CODES[key(info.code)];
  if (family === 'zai' && ZAI_ERROR_CODES[info.code]) return ZAI_ERROR_CODES[info.code];
  if (status) {
    if (status === 401) return 'auth';
    if (status === 402) return 'quota';
    if (status === 403) return 'forbidden';
    if (status === 404 || status === 405 || status === 410) return 'not_found';
    if (status === 413) return 'bad_request';
    if (status === 429) {
      // An explicit code/type wins (Groq/OpenAI rate limits mention billing, Gemini says "quota").
      if (byType === 'quota' || byType === 'rate_limit') return byType;
      return !RATE_RE.test(message) && QUOTA_RE.test(hay) ? 'quota' : 'rate_limit';
    }
    if (status === 529 || status >= 500 || status === 408) return 'server';
    if (status >= 400) {
      // xAI and Gemini answer bad keys with 400; Anthropic reports a low credit balance with 400.
      if (AUTH_RE.test(hay)) return 'auth';
      if (QUOTA_RE.test(hay)) return 'quota';
      return 'bad_request';
    }
  }
  if (byType) return byType;
  if (QUOTA_RE.test(hay)) return 'quota';
  if (AUTH_RE.test(hay)) return 'auth';
  if (RATE_RE.test(hay)) return 'rate_limit';
  return 'server';
}

async function httpError(res, ctx) {
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    raw = '';
  }
  const info = parseErrorBody(raw);
  const status = res.status;
  return new LLMError(classify(status, info, ctx.family), '', {
    status,
    details: sanitizeDetail(info.message, ctx),
    providerCode: info.code,
    provider: ctx.info,
    model: ctx.model,
  });
}

/** Error delivered inside a 200 response (mid-stream chunk, error event, error JSON). */
function payloadError(payload, ctx) {
  const info = extractErrorInfo(payload);
  const numeric = Number(info.code);
  const status = Number.isInteger(numeric) && numeric >= 400 && numeric < 600 ? numeric : 0;
  return new LLMError(classify(status, info, ctx.family), '', {
    status,
    details: sanitizeDetail(info.message, ctx),
    providerCode: info.code,
    provider: ctx.info,
    model: ctx.model,
  });
}

function normalizeError(err, ctx, signal) {
  if (err instanceof LLMError) return err;
  const opts = { provider: ctx?.info, model: ctx?.model, cause: err };
  if (signal?.aborted || isAbortError(err)) return new LLMError('aborted', '', opts);
  if (err instanceof TypeError || err?.name === 'TypeError' || err?.name === 'NetworkError') {
    return new LLMError('network', '', opts);
  }
  if (err instanceof SyntaxError) {
    return new LLMError('parse', '', { ...opts, details: sanitizeDetail(err.message, ctx) });
  }
  return new LLMError('parse', '', { ...opts, details: sanitizeDetail(err?.message || String(err), ctx) });
}

// ---------------------------------------------------------------------------
// Provider context, headers, fetch
// ---------------------------------------------------------------------------

function providerContext(provider) {
  if (!provider || typeof provider !== 'object') throw new LLMError('no_provider');
  const info = safeProviderInfo(provider);
  info.name = info.name || info.id || t('core.llm.providerFallbackName');
  const baseUrl = String(provider.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new LLMError('no_provider', t('core.llm.error.noBaseUrl', { name: info.name }), { provider: info });
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new LLMError('bad_request', t('core.llm.error.invalidBaseUrl', { name: info.name }), { provider: info });
  }
  info.baseUrl = baseUrl;
  let extraHeaders = provider.extraHeaders;
  if (typeof extraHeaders === 'string') {
    try {
      extraHeaders = JSON.parse(extraHeaders);
    } catch {
      extraHeaders = null;
    }
  }
  return {
    provider,
    info,
    baseUrl,
    family: familyOf(provider),
    protocol: provider.protocol === 'anthropic' ? 'anthropic' : 'openai',
    apiKey: String(provider.apiKey || '').trim().replace(/^Bearer\s+/i, ''),
    extraHeaders: extraHeaders && typeof extraHeaders === 'object' && !Array.isArray(extraHeaders) ? extraHeaders : null,
    model: '',
  };
}

// Decided by presetId first (stored provider configs carry no requiresKey), then by URL heuristics.
function keyRequired(ctx) {
  if (typeof ctx.provider.requiresKey === 'boolean') return ctx.provider.requiresKey;
  const preset = String(ctx.provider.presetId || '').toLowerCase();
  if (KEYLESS_FAMILIES.has(preset)) return false;
  if (KNOWN_FAMILIES.has(preset)) return true;
  if (KEYLESS_FAMILIES.has(ctx.family)) return false;
  return !isLocalHost(hostnameOf(ctx.baseUrl));
}

function assertKey(ctx) {
  if (!ctx.apiKey && keyRequired(ctx)) throw new LLMError('no_key', '', { provider: ctx.info });
}

function buildHeaders(ctx, { json = true } = {}) {
  const headers = new Headers();
  if (json) headers.set('Content-Type', 'application/json');
  try {
    if (ctx.protocol === 'anthropic') {
      if (ctx.apiKey) {
        headers.set('x-api-key', ctx.apiKey);
        // Anthropic-compatible third-party endpoints (Z.AI, DeepSeek, proxies) often expect Bearer.
        if (ctx.family !== 'anthropic') headers.set('Authorization', `Bearer ${ctx.apiKey}`);
      }
      headers.set('anthropic-version', ANTHROPIC_VERSION);
      headers.set('anthropic-dangerous-direct-browser-access', 'true');
    } else if (ctx.apiKey) {
      headers.set('Authorization', `Bearer ${ctx.apiKey}`);
    }
  } catch {
    throw new LLMError('auth', t('core.llm.error.invalidKeyChars'), { provider: ctx.info });
  }
  if (ctx.extraHeaders) {
    for (const [name, value] of Object.entries(ctx.extraHeaders)) {
      if (!name || value === undefined || value === null || value === '') continue;
      try {
        headers.set(name, String(value));
      } catch {
        // invalid header name/value – skip
      }
    }
  }
  return headers;
}

async function doFetch(ctx, path, { method = 'GET', body, signal } = {}) {
  if (signal?.aborted) throw new LLMError('aborted', '', { provider: ctx.info, model: ctx.model });
  const hasBody = body !== undefined;
  const init = {
    method,
    headers: buildHeaders(ctx, { json: hasBody }),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  };
  if (hasBody) init.body = JSON.stringify(body);
  if (signal) init.signal = signal;
  let res;
  try {
    res = await globalThis.fetch(ctx.baseUrl + path, init);
  } catch (err) {
    throw normalizeError(err, ctx, signal);
  }
  if (!res.ok) throw await httpError(res, ctx);
  return res;
}

async function readJson(res, ctx) {
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw normalizeError(err, ctx);
  }
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new LLMError('parse', '', { provider: ctx.info, model: ctx.model, details: t('core.llm.error.emptyResponse') });
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new LLMError('parse', '', { provider: ctx.info, model: ctx.model, details: sanitizeDetail(truncate(trimmed, 300), ctx) });
  }
}

function getJson(ctx, path, signal) {
  return doFetch(ctx, path, { signal }).then((res) => readJson(res, ctx));
}

function isJsonResponse(res) {
  const type = String(res.headers?.get?.('content-type') || '').toLowerCase();
  return type.includes('application/json') && !type.includes('event-stream');
}

function bareModel(model) {
  return String(model || '').toLowerCase().split('/').pop();
}

function positiveInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Response accumulation (text, reasoning, <think> tags, images)
// ---------------------------------------------------------------------------

const THINK_TAGS = [['<think>', '</think>'], ['<thought>', '</thought>']];

function partialSuffixLength(text, tag) {
  for (let k = Math.min(tag.length - 1, text.length); k > 0; k -= 1) {
    if (text.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return;
  try {
    fn(...args);
  } catch (err) {
    console.warn('[llm] callback failed', err);
  }
}

function createAccumulator({ onText, onReasoning } = {}) {
  const acc = { text: '', reasoning: '', images: [], finishReason: null, rawUsage: null };
  const emitText = (delta) => {
    if (!delta) return;
    acc.text += delta;
    safeCall(onText, delta, acc.text);
  };
  const emitReasoning = (delta) => {
    if (typeof delta !== 'string' || !delta) return;
    acc.reasoning += delta;
    safeCall(onReasoning, delta, acc.reasoning);
  };

  // Routes a leading <think>…</think> block (local models, Groq raw format) into reasoning.
  let state = 'start'; // start | think | text
  let pending = '';
  let closeTag = '';
  let stripLead = false;

  const toText = (chunk) => {
    let c = chunk;
    if (stripLead) {
      c = c.replace(/^\s+/, '');
      if (!c) return;
      stripLead = false;
    }
    emitText(c);
  };

  const drainThink = () => {
    const idx = pending.indexOf(closeTag);
    if (idx !== -1) {
      const reasoning = pending.slice(0, idx);
      const rest = pending.slice(idx + closeTag.length);
      pending = '';
      state = 'text';
      stripLead = true;
      emitReasoning(reasoning);
      if (rest) toText(rest);
      return;
    }
    const keep = partialSuffixLength(pending, closeTag);
    const out = pending.slice(0, pending.length - keep);
    pending = pending.slice(pending.length - keep);
    emitReasoning(out);
  };

  acc.pushText = (chunk) => {
    if (typeof chunk !== 'string' || !chunk) return;
    if (state === 'text') {
      toText(chunk);
      return;
    }
    pending += chunk;
    if (state === 'start') {
      const trimmed = pending.replace(/^\s+/, '');
      if (!trimmed) return;
      let maybe = false;
      for (const [open, close] of THINK_TAGS) {
        if (trimmed.startsWith(open)) {
          state = 'think';
          closeTag = close;
          pending = trimmed.slice(open.length).replace(/^\s+/, '');
          drainThink();
          return;
        }
        if (open.startsWith(trimmed)) maybe = true;
      }
      if (maybe) return;
      state = 'text';
      const out = pending;
      pending = '';
      toText(out);
      return;
    }
    drainThink();
  };
  acc.pushReasoning = emitReasoning;
  acc.addImage = (url) => {
    if (typeof url === 'string' && url && !acc.images.includes(url)) acc.images.push(url);
  };
  acc.end = () => {
    if (state === 'start' && pending) {
      state = 'text';
      const out = pending;
      pending = '';
      emitText(out);
    } else if (state === 'think' && pending) {
      const out = pending;
      pending = '';
      emitReasoning(out);
    }
  };
  acc.appendNote = (note) => {
    acc.end();
    state = 'text';
    stripLead = false;
    emitText(acc.text.trim() ? `\n\n${note}` : note);
  };
  return acc;
}

function imageUrlOf(item) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  if (typeof item.image_url === 'string') return item.image_url;
  return str(item.image_url?.url) || str(item.url) || '';
}

function applyContentPart(part, acc) {
  if (typeof part === 'string') {
    acc.pushText(part);
    return;
  }
  if (!part || typeof part !== 'object') return;
  switch (part.type) {
    case 'thinking':
    case 'reasoning': {
      const t = part.thinking ?? part.reasoning ?? part.text;
      if (typeof t === 'string') acc.pushReasoning(t);
      else if (Array.isArray(t)) {
        for (const x of t) {
          if (typeof x === 'string') acc.pushReasoning(x);
          else if (typeof x?.text === 'string') acc.pushReasoning(x.text);
        }
      }
      return;
    }
    case 'text':
    case 'output_text':
      if (typeof part.text === 'string') acc.pushText(part.text);
      return;
    case 'image_url':
    case 'image':
      acc.addImage(imageUrlOf(part));
      return;
    default:
      if (!part.type && typeof part.text === 'string') acc.pushText(part.text);
  }
}

/** Applies an OpenAI-style delta or message object to the accumulator. */
function applyMessage(msg, acc) {
  if (!msg || typeof msg !== 'object') return;
  const reasoning = [msg.reasoning_content, msg.reasoning].find((v) => typeof v === 'string' && v);
  if (reasoning) {
    acc.pushReasoning(reasoning);
  } else if (Array.isArray(msg.reasoning_details)) {
    for (const d of msg.reasoning_details) {
      const t = d?.text ?? d?.summary;
      if (typeof t === 'string') acc.pushReasoning(t);
    }
  }
  const content = msg.content;
  if (typeof content === 'string') acc.pushText(content);
  else if (Array.isArray(content)) for (const part of content) applyContentPart(part, acc);
  if (typeof msg.refusal === 'string' && msg.refusal) acc.pushText(msg.refusal);
  if (Array.isArray(msg.images)) for (const img of msg.images) acc.addImage(imageUrlOf(img));
}

function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  let input = n(u.prompt_tokens);
  if (input === undefined && n(u.input_tokens) !== undefined) {
    input = n(u.input_tokens) + (n(u.cache_read_input_tokens) ?? 0) + (n(u.cache_creation_input_tokens) ?? 0);
  }
  const output = n(u.completion_tokens) ?? n(u.output_tokens);
  const total = n(u.total_tokens) ?? (input !== undefined && output !== undefined ? input + output : undefined);
  const reasoning = n(u.completion_tokens_details?.reasoning_tokens) ?? n(u.output_tokens_details?.thinking_tokens)
    ?? n(u.output_tokens_details?.reasoning_tokens) ?? n(u.reasoning_tokens);
  // OpenRouter reports `cost` in USD, xAI `cost_in_usd_ticks` (1 USD = 10^10 ticks).
  const ticks = n(u.cost_in_usd_ticks);
  const cost = n(u.cost) ?? (ticks !== undefined ? ticks / 1e10 : undefined);
  const out = {};
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (total !== undefined) out.totalTokens = total;
  if (reasoning !== undefined) out.reasoningTokens = reasoning;
  if (cost !== undefined) out.cost = cost;
  return Object.keys(out).length ? out : null;
}

function mergeUsage(acc, usage) {
  if (!usage || typeof usage !== 'object') return;
  const next = { ...(acc.rawUsage || {}) };
  for (const [k, v] of Object.entries(usage)) if (v !== null && v !== undefined) next[k] = v;
  acc.rawUsage = next;
}

function normalizeFinish(reason) {
  if (!reason) return null;
  const r = String(reason);
  return FINISH_MAP[r] ?? r;
}

async function finalizeResult(acc, signal) {
  acc.end();
  const fr = acc.finishReason;
  if (fr === 'refusal') acc.appendNote(t('core.llm.note.refusal'));
  else if (fr === 'sensitive' || fr === 'content_filter') acc.appendNote(t('core.llm.note.filter'));
  else if (fr === 'network_error') acc.appendNote(t('core.llm.note.providerNetwork'));
  const images = [];
  for (const url of acc.images) images.push(await ensureDataUrl(url, signal));
  return {
    text: acc.text,
    reasoning: acc.reasoning,
    images,
    finishReason: normalizeFinish(fr),
    usage: normalizeUsage(acc.rawUsage),
  };
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

function partText(part) {
  if (typeof part === 'string') return part;
  if (part && typeof part === 'object' && (part.type === 'text' || !part.type) && typeof part.text === 'string') return part.text;
  return null;
}

function partImageUrl(part) {
  if (!part || typeof part !== 'object') return '';
  if (part.type === 'image') return str(part.dataUrl) || str(part.url);
  if (part.type === 'image_url') return imageUrlOf(part);
  return '';
}

function toOpenAIContent(content, role) {
  if (typeof content === 'string') return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const part of content) {
    const text = partText(part);
    if (text !== null) {
      if (text.trim()) parts.push({ type: 'text', text });
      continue;
    }
    const url = partImageUrl(part);
    if (url && role === 'user') parts.push({ type: 'image_url', image_url: { url } });
  }
  if (!parts.length) return null;
  if (parts.every((p) => p.type === 'text')) return parts.map((p) => p.text).join('\n\n');
  return parts;
}

function toOpenAIMessages(messages, system) {
  const out = [];
  if (typeof system === 'string' && system.trim()) out.push({ role: 'system', content: system });
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    const content = toOpenAIContent(m.content, role);
    if (content === null) continue;
    out.push({ role, content });
  }
  // No assistant prefill: several providers (Gemini, Anthropic-backed routes) reject it.
  while (out.length && out[out.length - 1].role === 'assistant') out.pop();
  return out;
}

function anthropicImageBlock(url) {
  if (!url) return null;
  if (/^data:/i.test(url)) {
    const { mimeType, base64 } = dataUrlParts(url);
    const data = base64.replace(/\s+/g, '');
    // Anthropic checks media_type against the bytes; the declared type only follows the file name.
    const mediaType = sniffImageMime(data) || imageMime(mimeType);
    if (!ANTHROPIC_IMAGE_TYPES.has(mediaType) || !data) return null;
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  }
  if (/^https:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } };
  return null;
}

function toAnthropicBlocks(content, role) {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const images = [];
  const texts = [];
  for (const part of content) {
    const text = partText(part);
    if (text !== null) {
      if (text.trim()) texts.push({ type: 'text', text });
      continue;
    }
    if (role !== 'user') continue; // never images (or thinking) in assistant turns
    const block = anthropicImageBlock(partImageUrl(part));
    if (block) images.push(block);
  }
  return [...images, ...texts]; // images before text
}

function toAnthropicMessages(messages) {
  const merged = [];
  const extraSystem = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.role;
    if (role === 'system') {
      const text = typeof m.content === 'string' ? m.content : toAnthropicBlocks(m.content, 'assistant').map((b) => b.text).join('\n\n');
      if (text.trim()) extraSystem.push(text);
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue;
    const blocks = toAnthropicBlocks(m.content, role);
    if (!blocks.length) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else merged.push({ role, content: blocks });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  while (merged.length && merged[merged.length - 1].role !== 'user') merged.pop();
  return {
    messages: merged.map((m) => ({
      role: m.role,
      content: m.content.length === 1 && m.content[0].type === 'text' ? m.content[0].text : m.content,
    })),
    extraSystem: extraSystem.join('\n\n'),
  };
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

function maxTokensParamFor(ctx) {
  if (ctx.family === 'mistral') return 'max_tokens';
  const explicit = ctx.provider.maxTokensParam;
  if (explicit === 'max_tokens' || explicit === 'max_completion_tokens') return explicit;
  if (MAX_COMPLETION_TOKENS_FAMILIES.has(ctx.family)) return 'max_completion_tokens';
  if (ctx.family === 'custom' && MAX_COMPLETION_TOKENS_MODEL_RE.test(bareModel(ctx.model))) return 'max_completion_tokens';
  return 'max_tokens';
}

function effectiveTemperature(ctx, temperature) {
  if (temperature === null || temperature === undefined || temperature === '') return null;
  const n = Number(temperature);
  if (!Number.isFinite(n)) return null;
  if (ctx.protocol === 'anthropic' || NO_TEMPERATURE_FAMILIES.has(ctx.family)) return null;
  if (NO_TEMPERATURE_MODEL_RE.test(bareModel(ctx.model))) return null;
  // Z.AI allows 0–1, Mistral's strict schema 0–1.5, everyone else 0–2.
  const max = ctx.family === 'zai' ? 1 : ctx.family === 'mistral' ? 1.5 : 2;
  return clamp(n, 0, max);
}

function buildOpenAIBody(ctx, { messages, system, temperature, maxTokens, stream }) {
  const msgs = toOpenAIMessages(messages, system);
  if (!msgs.some((m) => m.role !== 'system')) {
    throw new LLMError('bad_request', t('core.llm.error.noMessage'), { provider: ctx.info, model: ctx.model });
  }
  const body = { model: ctx.model, messages: msgs, stream: Boolean(stream) };
  if (stream && STREAM_USAGE_FAMILIES.has(ctx.family)) body.stream_options = { include_usage: true };
  const temp = effectiveTemperature(ctx, temperature);
  if (temp !== null) body.temperature = temp;
  const max = positiveInt(maxTokens);
  if (max) body[maxTokensParamFor(ctx)] = max;
  if (ctx.family === 'mistral') {
    // Mistral rejects unknown fields (additionalProperties: false).
    for (const key of Object.keys(body)) if (!MISTRAL_BODY_FIELDS.includes(key)) delete body[key];
  }
  return body;
}

// ---------------------------------------------------------------------------
// Chat: protocol openai
// ---------------------------------------------------------------------------

function processOpenAIChunk(chunk, acc, ctx) {
  if (!chunk || typeof chunk !== 'object') return;
  if (Array.isArray(chunk)) {
    if (chunk.some((x) => x?.error)) throw payloadError(chunk, ctx);
    return;
  }
  if (chunk.error) throw payloadError(chunk, ctx);
  if (chunk.type === 'error') throw payloadError(chunk, ctx);
  if (chunk.usage && typeof chunk.usage === 'object') mergeUsage(acc, chunk.usage);
  else if (chunk.x_groq?.usage) mergeUsage(acc, chunk.x_groq.usage);
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (!choice) return;
  applyMessage(choice.delta ?? choice.message, acc);
  if (typeof choice.text === 'string') acc.pushText(choice.text);
  if (choice.finish_reason) {
    if (choice.finish_reason === 'error') {
      throw new LLMError('server', t('core.llm.error.streamError', { name: ctx.info.name }), {
        provider: ctx.info, model: ctx.model,
      });
    }
    acc.finishReason = choice.finish_reason;
  }
}

async function runOpenAI(ctx, opts, acc) {
  const body = buildOpenAIBody(ctx, { ...opts, messages: await prepareImageInputs(ctx, opts.messages) });
  const res = await doFetch(ctx, '/chat/completions', { method: 'POST', body, signal: opts.signal });
  if (!opts.stream || isJsonResponse(res)) {
    const json = await readJson(res, ctx);
    if (Array.isArray(json) || json?.error || json?.type === 'error') throw payloadError(json, ctx);
    if (!Array.isArray(json?.choices) || !json.choices.length) {
      throw new LLMError('parse', '', { provider: ctx.info, model: ctx.model, details: t('core.llm.error.noChoices') });
    }
    processOpenAIChunk(json, acc, ctx);
    return;
  }
  for await (const ev of readSSE(res, { signal: opts.signal })) {
    const data = ev.data.trim();
    if (!data) continue;
    if (data === '[DONE]') break;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      if (ev.event === 'error') {
        throw new LLMError('server', '', { provider: ctx.info, model: ctx.model, details: sanitizeDetail(data, ctx) });
      }
      continue; // keep-alive noise or non-JSON lines
    }
    if (ev.event === 'error') throw payloadError(chunk, ctx);
    processOpenAIChunk(chunk, acc, ctx);
  }
}

// ---------------------------------------------------------------------------
// Chat: protocol anthropic
// ---------------------------------------------------------------------------

function applyAnthropicMessage(json, acc) {
  for (const block of Array.isArray(json?.content) ? json.content : []) {
    if (block?.type === 'text') acc.pushText(block.text);
    else if (block?.type === 'thinking') acc.pushReasoning(block.thinking);
  }
  if (json?.stop_reason) acc.finishReason = json.stop_reason;
  mergeUsage(acc, json?.usage);
}

async function runAnthropic(ctx, opts, acc, { thinking = true } = {}) {
  const { messages, extraSystem } = toAnthropicMessages(opts.messages);
  if (!messages.length) {
    throw new LLMError('bad_request', t('core.llm.error.noMessage'), { provider: ctx.info, model: ctx.model });
  }
  const system = [opts.system, extraSystem].filter((s) => typeof s === 'string' && s.trim()).join('\n\n');
  const body = {
    model: ctx.model,
    max_tokens: positiveInt(opts.maxTokens) ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages,
    stream: Boolean(opts.stream),
  };
  if (system) body.system = system;
  if (thinking && CLAUDE_THINKING_MODEL.test(bareModel(ctx.model))) {
    body.thinking = { type: 'adaptive', display: 'summarized' };
  }

  let res;
  try {
    res = await doFetch(ctx, '/messages', { method: 'POST', body, signal: opts.signal });
  } catch (err) {
    if (body.thinking && err instanceof LLMError && err.status === 400 && /thinking/i.test(err.details)) {
      delete body.thinking;
      res = await doFetch(ctx, '/messages', { method: 'POST', body, signal: opts.signal });
    } else {
      throw err;
    }
  }

  if (!opts.stream || isJsonResponse(res)) {
    const json = await readJson(res, ctx);
    if (json?.type === 'error' || json?.error) throw payloadError(json, ctx);
    applyAnthropicMessage(json, acc);
    return;
  }

  for await (const ev of readSSE(res, { signal: opts.signal })) {
    const raw = ev.data.trim();
    if (!raw || raw === '[DONE]') continue;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      if (ev.event === 'error') {
        throw new LLMError('server', '', { provider: ctx.info, model: ctx.model, details: sanitizeDetail(raw, ctx) });
      }
      continue;
    }
    const type = data?.type || ev.event;
    if (type === 'message_stop') break;
    switch (type) {
      case 'message_start':
        mergeUsage(acc, data.message?.usage);
        break;
      case 'content_block_start': {
        const block = data.content_block;
        if (block?.type === 'text') acc.pushText(block.text);
        else if (block?.type === 'thinking') acc.pushReasoning(block.thinking);
        break;
      }
      case 'content_block_delta': {
        const delta = data.delta;
        if (delta?.type === 'text_delta') acc.pushText(delta.text);
        else if (delta?.type === 'thinking_delta') acc.pushReasoning(delta.thinking);
        break;
      }
      case 'message_delta':
        if (data.delta?.stop_reason) acc.finishReason = data.delta.stop_reason;
        mergeUsage(acc, data.usage);
        break;
      case 'error':
        throw payloadError(data, ctx);
      default:
        break; // ping, content_block_stop, unknown future events
    }
  }
}

// ---------------------------------------------------------------------------
// Public: chat
// ---------------------------------------------------------------------------

async function runChat(options, { thinking = true } = {}) {
  const {
    provider, model, messages, system = '', temperature = null, maxTokens = null,
    signal, onText, onReasoning, stream = true,
  } = options || {};
  const ctx = providerContext(provider);
  assertKey(ctx);
  const modelId = String(model || provider.defaultModel || '').trim();
  if (!modelId) throw new LLMError('bad_request', t('core.llm.error.noModel'), { provider: ctx.info });
  ctx.model = modelId;
  if (signal?.aborted) throw new LLMError('aborted', '', { provider: ctx.info, model: modelId });

  const acc = createAccumulator({ onText, onReasoning });
  const opts = { messages, system, temperature, maxTokens, stream: stream !== false, signal };
  try {
    if (ctx.protocol === 'anthropic') await runAnthropic(ctx, opts, acc, { thinking });
    else await runOpenAI(ctx, opts, acc);
    return await finalizeResult(acc, signal);
  } catch (err) {
    const e = normalizeError(err, ctx, signal);
    e.partial = { text: acc.text, reasoning: acc.reasoning, images: acc.images.slice(), usage: normalizeUsage(acc.rawUsage) };
    throw e;
  }
}

/**
 * Sends a chat request (streaming by default).
 * → { text, reasoning, images: string[], finishReason, usage }
 * onText(delta, fullText) / onReasoning(delta, fullReasoning) are called while streaming.
 */
export async function streamChat(options = {}) {
  return runChat(options, { thinking: true });
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const XAI_ASPECTS = ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '9:19.5', '19.5:9', '9:20', '20:9', '1:2', '2:1', '21:9', '5:2'];
const OPENAI_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536', 'auto']);
const ZAI_SIZES = { '1024x1024': '1280x1280', '1536x1024': '1568x1056', '1024x1536': '1056x1568', auto: '1280x1280' };

function normalizeSize(size) {
  const s = String(size || '').trim().toLowerCase().replace(/\s+/g, '').replace('×', 'x');
  if (s === 'auto' || /^\d{2,5}x\d{2,5}$/.test(s)) return s;
  return '1024x1024';
}

function aspectRatioFor(size) {
  const s = normalizeSize(size);
  if (s === 'auto') return 'auto';
  const [w, h] = s.split('x').map(Number);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h) || 1;
  const ratio = `${w / g}:${h / g}`;
  if (XAI_ASPECTS.includes(ratio)) return ratio;
  // Nearest supported ratio.
  const target = w / h;
  let best = '1:1';
  let bestDiff = Infinity;
  for (const r of XAI_ASPECTS) {
    const [a, b] = r.split(':').map(Number);
    const diff = Math.abs(a / b - target);
    if (diff < bestDiff) {
      best = r;
      bestDiff = diff;
    }
  }
  return best;
}

function imageStyle(family, model) {
  if (family === 'openai' || family === 'xai' || family === 'zai' || family === 'gemini') return family;
  const m = bareModel(model);
  if (/^(gpt-image|chatgpt-image|dall-e)/.test(m)) return 'openai';
  if (/grok-imagine|^grok-.*image/.test(m)) return 'xai';
  if (/^(glm-image|cogview)/.test(m)) return 'zai';
  if (/^(gemini|imagen|nano-banana)/.test(m)) return 'gemini';
  return 'generic';
}

function buildImageBody(style, model, prompt, size) {
  const s = normalizeSize(size);
  switch (style) {
    case 'openai':
      // GPT image models always return base64 – response_format is not supported.
      return { model, prompt, n: 1, size: OPENAI_SIZES.has(s) || /^\d+x\d+$/.test(s) ? s : '1024x1024' };
    case 'xai':
      return { model, prompt, n: 1, response_format: 'b64_json', aspect_ratio: aspectRatioFor(s) };
    case 'zai':
      return { model, prompt, size: ZAI_SIZES[s] || s };
    case 'gemini':
    default:
      return { model, prompt, n: 1, size: s === 'auto' ? '1024x1024' : s, response_format: 'b64_json' };
  }
}

function mimeFromFormat(format) {
  const f = String(format || '').toLowerCase();
  if (f === 'jpg' || f === 'jpeg') return 'image/jpeg';
  if (f === 'png' || f === 'webp' || f === 'gif') return `image/${f}`;
  return '';
}

function sniffImageMime(base64) {
  const b = String(base64 || '');
  if (b.startsWith('iVBORw0KGg')) return 'image/png';
  if (b.startsWith('/9j/')) return 'image/jpeg';
  if (b.startsWith('R0lGOD')) return 'image/gif';
  if (b.startsWith('UklGR')) return 'image/webp';
  return '';
}

function imageMime(mime) {
  const m = String(mime || '').toLowerCase().trim();
  return m === 'image/jpg' ? 'image/jpeg' : m;
}

/** PNG data URL of an image (first frame for GIFs); '' without canvas support or on failure. */
async function reencodeAsPng(base64, type) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return '';
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return `data:image/png;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
  } catch {
    return '';
  }
}

const FORMAT_NAMES = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP', 'image/gif': 'GIF' };

/** Re-encodes user images the family does not accept (IMAGE_INPUT_TYPES) as PNG. */
async function prepareImageInputs(ctx, messages) {
  const allowed = IMAGE_INPUT_TYPES[ctx.family];
  if (!allowed || !Array.isArray(messages)) return messages;
  const out = [];
  for (const m of messages) {
    if (m?.role !== 'user' || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const content = [];
    for (const part of m.content) {
      const url = partText(part) === null ? partImageUrl(part) : '';
      const { mimeType, base64 } = /^data:/i.test(url) ? dataUrlParts(url) : { mimeType: '', base64: '' };
      const type = base64 ? sniffImageMime(base64) || imageMime(mimeType) : '';
      if (!type.startsWith('image/') || allowed.includes(type)) {
        content.push(part);
        continue;
      }
      const png = await reencodeAsPng(base64.replace(/\s+/g, ''), type);
      if (!png) {
        const names = allowed.map((mime) => FORMAT_NAMES[mime]);
        throw new LLMError('bad_request', t('core.llm.error.imageFormats', { name: ctx.info.name, formats: formatList(names) }), {
          provider: ctx.info, model: ctx.model,
        });
      }
      content.push({ type: 'image', dataUrl: png });
    }
    out.push({ ...m, content });
  }
  return out;
}

function base64ToDataUrl(b64, mime) {
  const data = String(b64 || '').replace(/\s+/g, '');
  if (/^data:/i.test(data)) return data;
  const type = (typeof mime === 'string' && /^image\/[\w.+-]+$/i.test(mime) ? mime.toLowerCase() : '')
    || sniffImageMime(data) || 'image/png';
  return `data:${type};base64,${data}`;
}

function bytesToBase64(bytes) {
  let out = '';
  const step = 3 * 8192; // multiple of 3 → no padding between chunks
  for (let i = 0; i < bytes.length; i += step) {
    const slice = bytes.subarray(i, i + step);
    let binary = '';
    for (let j = 0; j < slice.length; j += 1) binary += String.fromCharCode(slice[j]);
    out += btoa(binary);
  }
  return out;
}

/** Downloads a (temporary) image URL and returns a data URL; falls back to the URL. */
async function ensureDataUrl(url, signal) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return url;
  try {
    // Third-party host: never send provider credentials here.
    const res = await globalThis.fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) return url;
    const blob = await res.blob();
    if (!blob.size || blob.size > MAX_IMAGE_DOWNLOAD_BYTES) return url;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const base64 = bytesToBase64(bytes);
    const type = String(blob.type || '').split(';')[0].trim().toLowerCase();
    const mime = type.startsWith('image/') ? type : sniffImageMime(base64);
    if (!mime) return url;
    return `data:${mime};base64,${base64}`;
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) throw err;
    return url;
  }
}

async function parseImagesResponse(json, ctx, signal) {
  if (Array.isArray(json) || json?.error || json?.type === 'error') throw payloadError(json, ctx);
  const items = Array.isArray(json?.data) ? json.data : Array.isArray(json?.images) ? json.images : [];
  const fallbackMime = mimeFromFormat(json?.output_format);
  const images = [];
  for (const item of items) {
    if (!item) continue;
    let src = '';
    if (typeof item === 'string') src = /^https?:/i.test(item) ? await ensureDataUrl(item, signal) : base64ToDataUrl(item);
    else if (typeof item.b64_json === 'string' && item.b64_json) {
      src = base64ToDataUrl(item.b64_json, item.mime_type || item.media_type || fallbackMime);
    } else if (typeof item.url === 'string' && item.url) {
      src = await ensureDataUrl(item.url, signal);
    }
    if (!src) continue;
    const revised = str(item.revised_prompt);
    images.push(revised ? { src, revisedPrompt: revised } : { src });
  }
  if (!images.length) {
    throw new LLMError('parse', t('core.llm.error.noImageReturned'), { provider: ctx.info, model: ctx.model });
  }
  const usage = normalizeUsage(json?.usage);
  return usage ? { images, usage } : { images };
}

async function openAIImages(ctx, prompt, size, signal) {
  const body = buildImageBody(imageStyle(ctx.family, ctx.model), ctx.model, prompt, size);
  const res = await doFetch(ctx, '/images/generations', { method: 'POST', body, signal });
  return parseImagesResponse(await readJson(res, ctx), ctx, signal);
}

async function openRouterImages(ctx, prompt, size, signal) {
  const aspect = aspectRatioFor(size);
  const body = { model: ctx.model, prompt, n: 1 };
  if (aspect !== 'auto') body.aspect_ratio = aspect;
  let primary;
  try {
    const res = await doFetch(ctx, '/images', { method: 'POST', body, signal });
    return await parseImagesResponse(await readJson(res, ctx), ctx, signal);
  } catch (err) {
    if (!(err instanceof LLMError) || ![400, 404, 405].includes(err.status)) throw err;
    primary = err;
  }
  // Fallback: chat completions with image output modality.
  try {
    const chatBody = {
      model: ctx.model,
      messages: [{ role: 'user', content: prompt }],
      modalities: ['image', 'text'],
      stream: false,
    };
    if (aspect !== 'auto') chatBody.image_config = { aspect_ratio: aspect };
    const res = await doFetch(ctx, '/chat/completions', { method: 'POST', body: chatBody, signal });
    const json = await readJson(res, ctx);
    if (Array.isArray(json) || json?.error) throw payloadError(json, ctx);
    const acc = createAccumulator();
    applyMessage(json?.choices?.[0]?.message, acc);
    acc.end();
    const text = acc.text.trim();
    if (!acc.images.length) {
      throw new LLMError('parse', t('core.llm.error.noImageGenerated'), {
        provider: ctx.info, model: ctx.model, details: sanitizeDetail(text, ctx),
      });
    }
    const images = [];
    for (const url of acc.images) images.push({ src: await ensureDataUrl(url, signal) });
    const result = text ? { images, text } : { images };
    const usage = normalizeUsage(json?.usage);
    if (usage) result.usage = usage;
    return result;
  } catch (err) {
    // A real request problem on the dedicated route is more informative than the fallback's 400/404.
    if (err instanceof LLMError && primary.status === 400 && [400, 404, 405].includes(err.status)) throw primary;
    throw err;
  }
}

/**
 * Generates an image. → { images: [{ src, revisedPrompt? }], text?, usage? }
 * src is a data: URL whenever possible (temporary provider URLs are downloaded).
 */
export async function generateImage({ provider, model, prompt, size = '1024x1024', signal } = {}) {
  const ctx = providerContext(provider);
  assertKey(ctx);
  const firstImageModel = Array.isArray(provider.imageModels) ? provider.imageModels[0] : '';
  const imageModel = String(model || provider.defaultImageModel || firstImageModel || '').trim();
  ctx.model = imageModel;
  let api = provider.imageApi;
  if (ctx.family === 'openrouter' && api === 'openai-images') api = 'openrouter-chat';
  if (ctx.protocol === 'anthropic' || (api !== 'openai-images' && api !== 'openrouter-chat')) {
    throw new LLMError('unsupported', t('core.llm.error.imageUnsupported', { name: ctx.info.name }), { provider: ctx.info, model: imageModel });
  }
  if (!imageModel) throw new LLMError('bad_request', t('core.llm.error.noImageModel'), { provider: ctx.info });
  const text = String(prompt ?? '').trim();
  if (!text) throw new LLMError('bad_request', t('core.llm.error.noImagePrompt'), { provider: ctx.info, model: imageModel });
  if (signal?.aborted) throw new LLMError('aborted', '', { provider: ctx.info, model: imageModel });
  try {
    if (api === 'openrouter-chat') return await openRouterImages(ctx, text, size, signal);
    return await openAIImages(ctx, text, size, signal);
  } catch (err) {
    throw normalizeError(err, ctx, signal);
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** True for ids that look like image-generation models. */
export function isImageModelId(id) {
  const s = String(id || '');
  return IMAGE_MODEL_RE.test(s) && !VIDEO_MODEL_RE.test(s);
}

/** True for ids that are clearly not chat models (embeddings, TTS, audio, video, …). */
export function isNonChatModelId(id) {
  return NON_CHAT_MODEL_RE.test(String(id || ''));
}

// Ollama Cloud documents its model list only in the native API (GET https://ollama.com/api/tags);
// the OpenAI-compatible /v1/models is the fallback.
async function listOllamaCloudModels(ctx, map, signal) {
  let json;
  try {
    json = await getJson({ ...ctx, baseUrl: ctx.baseUrl.replace(/\/v1$/i, '') }, '/api/tags', signal);
  } catch (err) {
    if (!(err instanceof LLMError) || (err.status !== 404 && err.status !== 405)) throw err;
    json = await getJson(ctx, '/models', signal);
  }
  if (!Array.isArray(json?.models) && !Array.isArray(json?.data)) {
    throw new LLMError('parse', t('core.llm.error.modelListFormat'), { provider: ctx.info });
  }
  for (const raw of modelEntries(json)) addModel(map, toModelInfo(raw));
}

function modelEntries(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.models)) return json.models;
  return [];
}

function toTime(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  return Date.parse(String(v));
}

function isRetired(raw) {
  if (String(raw.lifecycle || '').toLowerCase() === 'retired') return true;
  const now = Date.now();
  for (const key of ['shutdown_date', 'retires_at', 'expiration_date']) {
    const t = toTime(raw[key]);
    if (Number.isFinite(t) && t <= now) return true;
  }
  return false;
}

function modalitiesOf(value) {
  if (Array.isArray(value)) return value.map((x) => String(x).toLowerCase());
  return [];
}

function toModelInfo(raw, extra = {}) {
  const entry = typeof raw === 'string' ? { id: raw } : raw;
  if (!entry || typeof entry !== 'object') return null;
  const id = String(entry.id ?? entry.name ?? entry.model ?? '').trim().replace(/^models\//, '');
  if (!id) return null;
  if (isRetired(entry) || entry.active === false) return null;

  const arch = entry.architecture && typeof entry.architecture === 'object' ? entry.architecture : {};
  const caps = entry.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : {};
  const input = modalitiesOf(arch.input_modalities ?? entry.input_modalities ?? entry.inputModalities);
  const output = modalitiesOf(arch.output_modalities ?? entry.output_modalities ?? entry.outputModalities);
  const modality = typeof arch.modality === 'string' ? arch.modality.toLowerCase() : '';
  if (modality.includes('->')) {
    const [inSide, outSide] = modality.split('->');
    if (!input.length) input.push(...inSide.split('+'));
    if (!output.length) output.push(...outSide.split('+'));
  }
  const imageInputCap = caps.image_input;
  const vision = input.includes('image') || caps.vision === true || imageInputCap === true
    || imageInputCap?.supported === true;
  const imageOutput = !VIDEO_MODEL_RE.test(id) && (output.includes('image') || IMAGE_MODEL_RE.test(id) || extra.imageOutput === true);
  const nonChat = NON_CHAT_MODEL_RE.test(id) || caps.completion_chat === false
    || (output.length > 0 && !output.includes('text') && !output.includes('image'));
  if (nonChat && !imageOutput) return null;

  const info = { id };
  const rawName = entry.display_name ?? entry.displayName ?? entry.name;
  if (typeof rawName === 'string' && rawName.trim() && rawName !== entry.id && !rawName.startsWith('models/') && rawName !== id) {
    info.name = rawName.trim();
  }
  if (vision) info.vision = true;
  if (imageOutput) info.imageOutput = true;
  const ctxLen = [
    entry.context_length, entry.context_window, entry.max_context_length, entry.max_input_tokens,
    entry.inputTokenLimit, entry.top_provider?.context_length,
  ].map(Number).find((n) => Number.isFinite(n) && n > 0);
  if (ctxLen) info.contextLength = ctxLen;
  // OpenRouter: pricing.prompt / pricing.completion are USD per token (strings) → USD per 1M tokens.
  const perMillion = (v) => {
    const x = typeof v === 'string' && v.trim() ? Number(v) : v;
    return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x * 1e12) / 1e6 : undefined;
  };
  const inputPrice = perMillion(entry.pricing?.prompt);
  const outputPrice = perMillion(entry.pricing?.completion);
  if (inputPrice !== undefined && outputPrice !== undefined) {
    info.inputPrice = inputPrice;
    info.outputPrice = outputPrice;
  }
  return info;
}

function addModel(map, info) {
  if (!info) return;
  const existing = map.get(info.id);
  if (!existing) {
    map.set(info.id, info);
    return;
  }
  if (!existing.name && info.name) existing.name = info.name;
  if (info.vision) existing.vision = true;
  if (info.imageOutput) existing.imageOutput = true;
  if (!existing.contextLength && info.contextLength) existing.contextLength = info.contextLength;
  if (existing.inputPrice === undefined && info.inputPrice !== undefined) {
    existing.inputPrice = info.inputPrice;
    existing.outputPrice = info.outputPrice;
  }
}

async function listAnthropicModels(ctx, map, signal) {
  let after = '';
  for (let page = 0; page < 10; page += 1) {
    const query = `?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const json = await getJson(ctx, `/models${query}`, signal);
    for (const raw of modelEntries(json)) addModel(map, toModelInfo(raw));
    if (!json?.has_more || !json.last_id || json.last_id === after) break;
    after = String(json.last_id);
  }
}

async function optionalJson(ctx, path, signal) {
  try {
    return await getJson(ctx, path, signal);
  } catch {
    return null; // enrichment only – failures are irrelevant
  }
}

// Extra listings fetched in parallel with GET /models (never rejects).
async function fetchEnrichment(ctx, signal) {
  if (ctx.family === 'xai') {
    const [lang, images] = await Promise.all([
      optionalJson(ctx, '/language-models', signal),
      optionalJson(ctx, '/image-generation-models', signal),
    ]);
    return { lang, images };
  }
  if (ctx.family === 'openrouter') {
    return { lang: null, images: await optionalJson(ctx, '/models?output_modalities=image', signal) };
  }
  return null;
}

function applyEnrichment(ctx, map, extra) {
  if (!extra) return;
  // xAI /language-models carries the modalities that /models lacks (vision detection).
  for (const raw of modelEntries(extra.lang)) {
    const info = toModelInfo(raw);
    if (!info) continue;
    const ids = [info.id, ...(Array.isArray(raw?.aliases) ? raw.aliases.map(String) : [])];
    let matched = false;
    for (const id of ids) {
      const existing = map.get(id);
      if (!existing) continue;
      matched = true;
      addModel(map, { ...info, id });
    }
    if (!matched) addModel(map, info);
  }
  for (const raw of modelEntries(extra.images)) {
    const info = toModelInfo(raw, { imageOutput: true });
    if (!info) continue;
    // Image-input on a pure image generator means editing, not chat vision.
    if (ctx.family === 'xai') delete info.vision;
    addModel(map, info);
  }
}

/**
 * Lists the provider's models. → [{ id, name?, vision?, imageOutput?, contextLength?, inputPrice?, outputPrice? }]
 * sorted by id (prices in USD per 1M tokens where the list carries them, e.g. OpenRouter).
 * Non-chat models (embeddings, TTS, …) are dropped unless they generate images;
 * image models are flagged with imageOutput: true.
 */
export async function listModels(provider, { signal } = {}) {
  const ctx = providerContext(provider);
  if (ctx.family !== 'openrouter') assertKey(ctx); // OpenRouter lists models without a key
  if (signal?.aborted) throw new LLMError('aborted', '', { provider: ctx.info });
  const map = new Map();
  try {
    if (ctx.protocol === 'anthropic') {
      await listAnthropicModels(ctx, map, signal);
    } else if (ctx.family === 'ollama-cloud') {
      await listOllamaCloudModels(ctx, map, signal);
    } else {
      const [json, extra] = await Promise.all([getJson(ctx, '/models', signal), fetchEnrichment(ctx, signal)]);
      if (!Array.isArray(json) && !Array.isArray(json?.data) && !Array.isArray(json?.models)) {
        throw new LLMError('parse', t('core.llm.error.modelListFormat'), { provider: ctx.info });
      }
      for (const raw of modelEntries(json)) addModel(map, toModelInfo(raw));
      applyEnrichment(ctx, map, extra);
    }
  } catch (err) {
    throw normalizeError(err, ctx, signal);
  }
  if (signal?.aborted) throw new LLMError('aborted', '', { provider: ctx.info });
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

const BALANCE_FAMILIES = new Set(['openrouter', 'deepseek', 'xai']);
// xAI reports the prepaid credit only through its Management API (separate management key).
const XAI_MANAGEMENT_URL = 'https://management-api.x.ai';

/** True when the provider offers a balance endpoint at all. */
export function supportsBalance(provider) {
  return BALANCE_FAMILIES.has(familyOf(provider));
}

/** True when the balance needs an extra management key (provider.billing.managementKey). */
export function balanceNeedsManagementKey(provider) {
  return familyOf(provider) === 'xai';
}

/** True when everything needed for fetchBalance() is configured. */
export function canFetchBalance(provider) {
  if (!supportsBalance(provider)) return false;
  if (balanceNeedsManagementKey(provider)) return Boolean(String(provider?.billing?.managementKey || '').trim());
  return Boolean(String(provider?.apiKey || '').trim());
}

function moneyValue(v) {
  const x = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function currencyCode(v) {
  const c = String(v || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : 'USD';
}

// GET /key (works with the normal key). The account credit (/credits) needs a management key.
function parseOpenRouterKey(json) {
  const d = json?.data && typeof json.data === 'object' ? json.data : json || {};
  const result = { balances: [], details: [], notes: [] };
  const remaining = moneyValue(d.limit_remaining);
  const limit = moneyValue(d.limit);
  if (remaining !== null) {
    result.balances.push({ label: t('core.llm.balance.keyRemaining'), amount: remaining, currency: 'USD' });
    if (limit !== null) {
      const reset = ['daily', 'weekly', 'monthly'].includes(d.limit_reset) ? d.limit_reset : '';
      result.details.push({ label: t(reset ? `core.llm.balance.limit.${reset}` : 'core.llm.balance.limit'), amount: limit, currency: 'USD' });
    }
  }
  const usage = [['usage_daily', 'usageToday'], ['usage_monthly', 'usageMonth'], ['usage', 'usageTotal']];
  for (const [key, label] of usage) {
    const value = moneyValue(d[key]);
    if (value !== null) result.details.push({ id: key, label: t(`core.llm.balance.${label}`), amount: value, currency: 'USD' });
  }
  if (d.is_free_tier === true) result.notes.push(t('core.llm.balance.freeTier'));
  if (remaining === null) result.notes.push(t('core.llm.balance.openrouterAccount'));
  return result;
}

// GET /user/balance – amounts are strings, currency CNY or USD.
function parseDeepSeekBalance(json) {
  const result = { balances: [], details: [], notes: [] };
  for (const info of Array.isArray(json?.balance_infos) ? json.balance_infos : []) {
    const currency = currencyCode(info?.currency);
    const total = moneyValue(info?.total_balance);
    if (total === null) continue;
    result.balances.push({ label: t('core.llm.balance.balance'), amount: total, currency });
    const topped = moneyValue(info?.topped_up_balance);
    const granted = moneyValue(info?.granted_balance);
    if (topped !== null) result.details.push({ label: t('core.llm.balance.toppedUp'), amount: topped, currency });
    if (granted !== null) result.details.push({ label: t('core.llm.balance.granted'), amount: granted, currency });
  }
  if (json?.is_available === false) result.notes.push(t('core.llm.balance.insufficient'));
  if (!result.balances.length && !result.notes.length) result.notes.push(t('core.llm.balance.noneReported', { name: 'DeepSeek' }));
  return result;
}

// GET /v1/billing/teams/{teamId}/prepaid/balance – values are USD cents as strings. Purchases are
// negative and spending positive, so the remaining credit is -total.
function parseXaiBalance(json) {
  const result = { balances: [], details: [], notes: [] };
  const total = moneyValue(json?.total?.val);
  if (total === null) {
    result.notes.push(t('core.llm.balance.noneReported', { name: 'xAI' }));
    return result;
  }
  const remaining = -total / 100;
  result.balances.push({ label: t('core.llm.balance.prepaid'), amount: remaining, currency: 'USD' });
  let purchased = 0;
  let spent = 0;
  for (const change of Array.isArray(json?.changes) ? json.changes : []) {
    const value = moneyValue(change?.amount?.val);
    if (value === null) continue;
    const origin = String(change?.changeOrigin || '').toUpperCase();
    if (origin === 'SPEND') spent += value;
    else if (origin === 'PURCHASE' || origin === 'AUTO_PURCHASE') purchased -= value;
  }
  if (purchased > 0) result.details.push({ label: t('core.llm.balance.purchasedTotal'), amount: purchased / 100, currency: 'USD' });
  if (spent > 0) result.details.push({ label: t('core.llm.balance.spentTotal'), amount: spent / 100, currency: 'USD' });
  if (remaining <= 0) result.notes.push(t('core.llm.balance.prepaidEmpty'));
  return result;
}

async function fetchXaiBalance(ctx, provider, signal) {
  const key = String(provider.billing?.managementKey || '').trim().replace(/^Bearer\s+/i, '');
  if (!key) {
    throw new LLMError('no_key', t('core.llm.balance.xaiNeedsManagementKey'), { provider: ctx.info });
  }
  const mctx = { ...ctx, baseUrl: XAI_MANAGEMENT_URL, apiKey: key, protocol: 'openai', extraHeaders: null };
  try {
    let teamId = String(provider.billing?.teamId || '').trim();
    if (!teamId) {
      const info = await getJson(mctx, '/auth/management-keys/validation', signal);
      teamId = str(info?.teamId).trim() || (/team/i.test(str(info?.scope)) ? str(info?.scopeId).trim() : '');
      if (!teamId) {
        throw new LLMError('bad_request', t('core.llm.balance.xaiTeamId'), { provider: ctx.info });
      }
    }
    const json = await getJson(mctx, `/v1/billing/teams/${encodeURIComponent(teamId)}/prepaid/balance`, signal);
    return { ...parseXaiBalance(json), teamId };
  } catch (err) {
    const e = normalizeError(err, mctx, signal);
    if (e.code === 'auth') {
      throw new LLMError('auth', t('core.llm.balance.xaiKeyRejected'), { provider: ctx.info, status: e.status });
    }
    if (e.code === 'forbidden' || e.code === 'not_found') {
      throw new LLMError(e.code, t('core.llm.balance.xaiForbidden'), { provider: ctx.info, status: e.status });
    }
    throw e;
  }
}

/**
 * Reads the remaining balance (OpenRouter and DeepSeek with the API key, xAI with a management key).
 * → { balances: [{ label, amount, currency }], details: [{ label, amount, currency }], notes: string[], teamId? }
 * Throws LLMError ('unsupported' for providers without such an endpoint).
 */
export async function fetchBalance(provider, { signal } = {}) {
  const ctx = providerContext(provider);
  if (!BALANCE_FAMILIES.has(ctx.family)) {
    throw new LLMError('unsupported', t('core.llm.balance.unsupported', { name: ctx.info.name }), { provider: ctx.info });
  }
  if (ctx.family === 'xai') return fetchXaiBalance(ctx, provider, signal);
  if (!ctx.apiKey) throw new LLMError('no_key', '', { provider: ctx.info });
  try {
    if (ctx.family === 'openrouter') return parseOpenRouterKey(await getJson(ctx, '/key', signal));
    // The balance lives at the API root, also when the base URL ends in /v1 or /beta.
    const rootCtx = { ...ctx, baseUrl: ctx.baseUrl.replace(/\/(v1|beta)$/i, '') };
    return parseDeepSeekBalance(await getJson(rootCtx, '/user/balance', signal));
  } catch (err) {
    throw normalizeError(err, ctx, signal);
  }
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

async function verifyOpenRouterKey(ctx) {
  try {
    await getJson(ctx, '/key');
  } catch (err) {
    if (err instanceof LLMError && (err.status === 404 || err.status === 405 || err.code === 'parse')) return;
    throw err;
  }
}

function modelCount(n) {
  return t('core.llm.test.models', { count: n });
}

/**
 * Tests the provider. → { ok: true, message, models } | { ok: false, message } (never throws).
 * Tries GET /models first; on 404/405 (or supportsModelList === false) sends a tiny chat request.
 */
export async function testConnection(provider) {
  let ctx;
  try {
    ctx = providerContext(provider);
    assertKey(ctx);
  } catch (err) {
    return { ok: false, message: describeError(err) };
  }
  const name = ctx.info.name;
  if (provider.supportsModelList !== false) {
    try {
      if (ctx.family === 'openrouter' && ctx.apiKey) await verifyOpenRouterKey(ctx);
      const models = await listModels(provider);
      return {
        ok: true,
        message: models.length
          ? t('core.llm.test.successModels', { name, models: modelCount(models.length) })
          : t('core.llm.test.successEmpty', { name }),
        models,
      };
    } catch (err) {
      if (!(err instanceof LLMError) || !(err.status === 404 || err.status === 405)) {
        return { ok: false, message: describeError(err) };
      }
      // GET /models is not offered – fall through to a tiny chat request.
    }
  }
  const model = String(provider.defaultModel || (Array.isArray(provider.models) ? provider.models[0] : '') || '').trim();
  if (!model) {
    return {
      ok: false,
      message: t('core.llm.test.noModelList', { name }),
    };
  }
  try {
    await runChat({
      provider,
      model,
      messages: [{ role: 'user', content: 'Antworte nur mit OK' }],
      maxTokens: 16,
      stream: false,
    }, { thinking: false });
    return { ok: true, message: t('core.llm.test.successModel', { name, model }), models: [] };
  } catch (err) {
    return { ok: false, message: describeError(err) };
  }
}
