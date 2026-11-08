// API costs: per-request cost (reported by the provider or estimated from list prices), the local
// usage statistics (storage.local key "usageStats") and formatting helpers (UI language).
// Service-worker safe (no DOM). The background is the only writer of the statistics during normal
// use (extension pages send `recordUsage`), so concurrent requests cannot lose updates.

import { ext } from './ext.js';
import { getPreset } from './providers.js';
import { t, getLocale } from './i18n.js';

export const USAGE_KEY = 'usageStats';
const STATS_VERSION = 1;
const MAX_MONTHS = 24;
const MAX_ENTRIES_PER_MONTH = 500;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const trim = (v) => (typeof v === 'string' ? v.trim() : '');

// ---------------------------------------------------------------------------------------------
// Prices (USD per 1 million tokens)

/** A price entry { input, output } with finite, non-negative numbers – or null. */
export function cleanPrice(raw) {
  if (Array.isArray(raw)) raw = { input: raw[0], output: raw[1] };
  if (!isObj(raw)) return null;
  const input = toPrice(raw.input);
  const output = toPrice(raw.output);
  if (input === null && output === null) return null;
  return { input, output };
}

function toPrice(v) {
  const n = typeof v === 'string' && v.trim() ? Number(v.trim().replace(',', '.')) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Price used for estimates: the user's own price, then the price from the provider's model list,
 * then the built-in list price of the preset. → { input, output, source: 'custom'|'api'|'builtin' } | null
 */
export function priceFor(provider, model) {
  const id = trim(model);
  if (!provider || !id) return null;
  const custom = cleanPrice(provider.prices?.[id]);
  if (custom && custom.input !== null && custom.output !== null) return { ...custom, source: 'custom' };
  const info = provider.modelInfo?.[id];
  const api = cleanPrice(info ? { input: info.inputPrice, output: info.outputPrice } : null);
  // A partial custom price completes the automatic one.
  const merge = (base) => ({
    input: custom?.input ?? base.input,
    output: custom?.output ?? base.output,
  });
  if (api && api.input !== null && api.output !== null) return { ...merge(api), source: custom ? 'custom' : 'api' };
  const builtin = cleanPrice(getPreset(provider.presetId)?.prices?.[id]);
  if (builtin && provider.presetId !== 'custom') return { ...merge(builtin), source: custom ? 'custom' : 'builtin' };
  return null;
}

/** The automatic price only (model list or built-in), ignoring the user's own price. */
export function automaticPriceFor(provider, model) {
  return priceFor(provider ? { ...provider, prices: {} } : provider, model);
}

// ---------------------------------------------------------------------------------------------
// Per-request usage

/**
 * Compact usage record for a message / the statistics.
 * → { inputTokens?, outputTokens?, reasoningTokens?, cost?, estimated? } | null
 * usage is the normalized result of lib/llm.js ({ inputTokens, outputTokens, reasoningTokens, cost }).
 * kind 'image': token prices of chat models do not apply, so only a reported cost counts.
 */
export function usageRecord(provider, model, usage, { kind = 'chat' } = {}) {
  if (!isObj(usage)) return null;
  const out = {};
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const reasoning = num(usage.reasoningTokens);
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (reasoning) out.reasoningTokens = reasoning;
  const reported = num(usage.cost);
  if (reported !== undefined) {
    out.cost = reported;
  } else if (kind !== 'image' && (input !== undefined || output !== undefined)) {
    const price = priceFor(provider, model);
    if (price && price.input !== null && price.output !== null) {
      out.cost = ((input ?? 0) * price.input + (output ?? 0) * price.output) / 1e6;
      out.estimated = true;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Sanitizes a stored or received usage record (same shape as usageRecord()). */
export function cleanUsage(raw) {
  if (!isObj(raw)) return null;
  const out = {};
  for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cost']) {
    const v = num(raw[key]);
    if (v !== undefined) out[key] = v;
  }
  if (out.cost !== undefined && raw.estimated === true) out.estimated = true;
  return Object.keys(out).length ? out : null;
}

/** Sum over messages (a chat). → { inputTokens, outputTokens, cost, priced, unpriced, estimated, requests } */
export function sumUsage(records) {
  const total = { inputTokens: 0, outputTokens: 0, cost: 0, priced: 0, unpriced: 0, estimated: false, requests: 0 };
  for (const raw of records) {
    const u = cleanUsage(raw);
    if (!u) continue;
    total.requests += 1;
    total.inputTokens += u.inputTokens ?? 0;
    total.outputTokens += u.outputTokens ?? 0;
    if (u.cost !== undefined) {
      total.cost += u.cost;
      total.priced += 1;
      if (u.estimated) total.estimated = true;
    } else {
      total.unpriced += 1;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
// Statistics (storage.local "usageStats")
//
// { version: 1, since: ts, months: { 'YYYY-MM': { '<providerId>|<model>': StatEntry } } }
// StatEntry = { providerId, providerName, model, requests, inputTokens, outputTokens, cost,
//               estimated /* requests with estimated cost */, unpriced /* requests without cost */ }

export function monthKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function emptyStats() {
  return { version: STATS_VERSION, since: Date.now(), months: {} };
}

function cleanEntry(raw) {
  if (!isObj(raw)) return null;
  const providerId = trim(raw.providerId);
  const model = trim(raw.model);
  if (!providerId) return null;
  const count = (v) => Math.round(num(v) ?? 0);
  return {
    providerId,
    providerName: trim(raw.providerName) || providerId,
    model,
    requests: count(raw.requests),
    inputTokens: count(raw.inputTokens),
    outputTokens: count(raw.outputTokens),
    cost: num(raw.cost) ?? 0,
    estimated: count(raw.estimated),
    unpriced: count(raw.unpriced),
  };
}

export function normalizeStats(raw) {
  if (!isObj(raw) || !isObj(raw.months)) return emptyStats();
  const months = {};
  const keys = Object.keys(raw.months).filter((k) => /^\d{4}-\d{2}$/.test(k)).sort().slice(-MAX_MONTHS);
  for (const key of keys) {
    const bucket = raw.months[key];
    if (!isObj(bucket)) continue;
    const out = {};
    for (const entry of Object.values(bucket).slice(0, MAX_ENTRIES_PER_MONTH)) {
      const clean = cleanEntry(entry);
      if (clean) out[`${clean.providerId}|${clean.model}`] = clean;
    }
    months[key] = out;
  }
  return { version: STATS_VERSION, since: num(raw.since) ?? Date.now(), months };
}

/** Adds one request to the statistics (mutates and returns stats). */
export function addToStats(stats, { providerId, providerName, model, usage, at = Date.now() }) {
  const id = trim(providerId);
  if (!id) return stats;
  const month = monthKey(at);
  const bucket = stats.months[month] ?? (stats.months[month] = {});
  const key = `${id}|${trim(model)}`;
  if (!bucket[key] && Object.keys(bucket).length >= MAX_ENTRIES_PER_MONTH) return stats;
  const entry = bucket[key] ?? (bucket[key] = cleanEntry({ providerId: id, providerName, model }));
  if (trim(providerName)) entry.providerName = trim(providerName);
  const u = cleanUsage(usage) ?? {};
  entry.requests += 1;
  entry.inputTokens += Math.round(u.inputTokens ?? 0);
  entry.outputTokens += Math.round(u.outputTokens ?? 0);
  if (u.cost !== undefined) {
    entry.cost += u.cost;
    if (u.estimated) entry.estimated += 1;
  } else {
    entry.unpriced += 1;
  }
  const keys = Object.keys(stats.months).sort();
  while (keys.length > MAX_MONTHS) delete stats.months[keys.shift()];
  return stats;
}

export async function getUsageStats() {
  const stored = await ext.storage.local.get(USAGE_KEY);
  return normalizeStats(stored?.[USAGE_KEY]);
}

let writeChain = Promise.resolve();

/** Records one request (serialized within this context). Never rejects. */
export function recordUsage(entry) {
  const run = writeChain.then(async () => {
    const stats = await getUsageStats();
    addToStats(stats, entry);
    await ext.storage.local.set({ [USAGE_KEY]: stats });
  });
  writeChain = run.catch(() => {});
  return writeChain;
}

export async function clearUsageStats() {
  await ext.storage.local.set({ [USAGE_KEY]: emptyStats() });
}

export function onUsageChanged(cb) {
  const listener = (changes, area) => {
    if (area === 'local' && changes[USAGE_KEY]) cb(normalizeStats(changes[USAGE_KEY].newValue));
  };
  ext.storage.onChanged.addListener(listener);
  return () => ext.storage.onChanged.removeListener(listener);
}

/**
 * Rows for a period: 'YYYY-MM' (one month) or 'all'. Grouped by provider and model, most expensive first.
 * → { rows: StatEntry[], total: StatEntry-like totals }
 */
export function statsRows(stats, period) {
  const months = period === 'all' ? Object.keys(stats.months) : [period];
  const merged = new Map();
  for (const m of months) {
    for (const entry of Object.values(stats.months[m] ?? {})) {
      const key = `${entry.providerId}|${entry.model}`;
      const row = merged.get(key) ?? cleanEntry({ providerId: entry.providerId, providerName: entry.providerName, model: entry.model });
      row.providerName = entry.providerName || row.providerName;
      for (const f of ['requests', 'inputTokens', 'outputTokens', 'cost', 'estimated', 'unpriced']) row[f] += entry[f];
      merged.set(key, row);
    }
  }
  const rows = [...merged.values()].sort((a, b) => b.cost - a.cost || b.requests - a.requests);
  const total = { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, estimated: 0, unpriced: 0 };
  for (const row of rows) for (const f of Object.keys(total)) total[f] += row[f];
  return { rows, total };
}

// ---------------------------------------------------------------------------------------------
// Formatting (in the UI language)

/** "0,0021 $", "0,042 $", "1,25 $" (German UI) – amounts below one cent with two significant digits. */
export function formatMoney(amount, currency = 'USD') {
  const value = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  const code = /^[A-Z]{3}$/.test(String(currency)) ? currency : 'USD';
  const abs = Math.abs(value);
  const opts = { style: 'currency', currency: code };
  if (abs === 0 || abs >= 1) {
    opts.minimumFractionDigits = 2;
    opts.maximumFractionDigits = 2;
  } else if (abs >= 0.01) {
    opts.minimumFractionDigits = 2;
    opts.maximumFractionDigits = 3;
  } else if (abs < 0.000001) {
    return `< ${new Intl.NumberFormat(getLocale(), { ...opts, maximumSignificantDigits: 1 }).format(0.000001)}`;
  } else {
    opts.maximumSignificantDigits = 2;
  }
  try {
    return new Intl.NumberFormat(getLocale(), opts).format(value);
  } catch {
    return `${value.toFixed(4)} ${code}`;
  }
}

/** "1.234" (German UI), "1,234" (English UI) */
export function formatNumber(n) {
  return new Intl.NumberFormat(getLocale()).format(Math.round(n || 0));
}

/** Short token count: "850", "12,3 Tsd.", "1,2 Mio." (German UI) / "12.3K", "1.2M" (English UI) */
export function formatTokens(n) {
  const v = Math.round(n || 0);
  if (v < 10000) return formatNumber(v);
  const short = (x) => x.toLocaleString(getLocale(), { maximumFractionDigits: 1 });
  if (v < 1e6) return t('core.usage.thousands', { value: short(v / 1000) });
  return t('core.usage.millions', { value: short(v / 1e6) });
}

/** "≈ 0,0021 $" (estimated) or "0,0021 $" (reported by the provider). */
export function formatCost(usage) {
  const u = cleanUsage(usage);
  if (!u || u.cost === undefined) return '';
  return `${u.estimated ? '≈ ' : ''}${formatMoney(u.cost)}`;
}

/** Multi-line tooltip for a message's usage. */
export function describeUsage(usage) {
  const u = cleanUsage(usage);
  if (!u) return '';
  const lines = [];
  if (u.inputTokens !== undefined) lines.push(t('core.usage.input', { tokens: formatNumber(u.inputTokens) }));
  if (u.outputTokens !== undefined) {
    lines.push(u.reasoningTokens
      ? t('core.usage.outputWithReasoning', { tokens: formatNumber(u.outputTokens), reasoning: formatNumber(u.reasoningTokens) })
      : t('core.usage.output', { tokens: formatNumber(u.outputTokens) }));
  }
  if (u.cost !== undefined) {
    lines.push(u.estimated
      ? t('core.usage.costEstimated', { cost: formatMoney(u.cost) })
      : t('core.usage.costReported', { cost: formatMoney(u.cost) }));
  } else {
    lines.push(t('core.usage.costUnknown'));
  }
  return lines.join('\n');
}
