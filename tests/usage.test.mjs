import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ---- fake storage (must exist before usage.js / ext.js are imported) ----
const store = new Map();
const changeListeners = new Set();
globalThis.chrome = {
  runtime: { id: 'test-extension', getURL: (path = '') => `chrome-extension://test-extension/${path}` },
  storage: {
    local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) if (store.has(key)) out[key] = structuredClone(store.get(key));
        return out;
      },
      async set(items) {
        const changes = {};
        for (const [key, value] of Object.entries(items)) {
          changes[key] = { oldValue: store.get(key), newValue: structuredClone(value) };
          store.set(key, structuredClone(value));
        }
        queueMicrotask(() => {
          for (const fn of changeListeners) fn(structuredClone(changes), 'local');
        });
      },
    },
    onChanged: {
      addListener: (fn) => changeListeners.add(fn),
      removeListener: (fn) => changeListeners.delete(fn),
    },
  },
};

const {
  priceFor, automaticPriceFor, usageRecord, cleanUsage, sumUsage, addToStats, emptyStats, normalizeStats,
  statsRows, recordUsage, getUsageStats, clearUsageStats, monthKey, formatMoney, formatTokens, formatCost, describeUsage,
} = await import('../src/lib/usage.js');
const { registerCatalog, setLanguage } = await import('../src/lib/i18n.js');
const { default: en } = await import('../src/locales/en/index.js');
const { fetchBalance, supportsBalance, listModels, streamChat } = await import('../src/lib/llm.js');
const { normalizeSettings, getDefaultSettings } = await import('../src/lib/settings.js');
const { createMessage } = await import('../src/lib/db.js');

const KEY = 'sk-test-0123456789abcdefghij';

let restoreFetch = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init, headers: new Headers(init.headers || {}) };
    calls.push(call);
    return handler(call);
  };
  restoreFetch = () => {
    globalThis.fetch = original;
  };
  return calls;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const openai = (overrides = {}) => ({
  id: 'openai', presetId: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1',
  apiKey: KEY, modelInfo: {}, prices: {}, ...overrides,
});

// ---------------------------------------------------------------------------------------------
// Prices and per-request cost

test('priceFor: built-in list price, model-list price, own price (also partial)', () => {
  assert.deepEqual(priceFor(openai(), 'gpt-6.1-sol'), { input: 2, output: 10, source: 'builtin' });
  assert.equal(priceFor(openai(), 'unknown-model'), null);
  const fromApi = openai({ modelInfo: { m: { inputPrice: 0.5, outputPrice: 1.5 } } });
  assert.deepEqual(priceFor(fromApi, 'm'), { input: 0.5, output: 1.5, source: 'api' });
  const own = openai({ prices: { 'gpt-6.1-sol': { input: 3, output: null } } });
  assert.deepEqual(priceFor(own, 'gpt-6.1-sol'), { input: 3, output: 10, source: 'custom' });
  assert.deepEqual(automaticPriceFor(own, 'gpt-6.1-sol'), { input: 2, output: 10, source: 'builtin' });
  // A custom provider never uses another preset's list.
  assert.equal(priceFor({ presetId: 'custom', prices: {} }, 'gpt-6.1-sol'), null);
});

test('usageRecord: reported cost wins, otherwise estimate from the price; images only with reported cost', () => {
  assert.deepEqual(
    usageRecord(openai(), 'gpt-6.1-sol', { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
    { inputTokens: 1000, outputTokens: 500, cost: (1000 * 2 + 500 * 10) / 1e6, estimated: true },
  );
  assert.deepEqual(
    usageRecord(openai(), 'gpt-6.1-sol', { inputTokens: 10, outputTokens: 5, cost: 0.25 }),
    { inputTokens: 10, outputTokens: 5, cost: 0.25 },
  );
  assert.deepEqual(usageRecord(openai(), 'unknown', { inputTokens: 1, outputTokens: 2 }), { inputTokens: 1, outputTokens: 2 });
  assert.deepEqual(usageRecord(openai(), 'gpt-6.1-sol', { inputTokens: 10, outputTokens: 5 }, { kind: 'image' }), { inputTokens: 10, outputTokens: 5 });
  assert.equal(usageRecord(openai(), 'gpt-6.1-sol', null), null);
});

test('cleanUsage / sumUsage', () => {
  assert.deepEqual(cleanUsage({ inputTokens: 5, outputTokens: -1, cost: 'x', estimated: true }), { inputTokens: 5 });
  const total = sumUsage([
    { inputTokens: 10, outputTokens: 5, cost: 0.1, estimated: true },
    { inputTokens: 1, outputTokens: 1 },
    undefined,
    { inputTokens: 2, outputTokens: 2, cost: 0.2 },
  ]);
  assert.equal(total.requests, 3);
  assert.equal(total.inputTokens, 13);
  assert.equal(total.priced, 2);
  assert.equal(total.unpriced, 1);
  assert.equal(total.estimated, true);
  assert.ok(Math.abs(total.cost - 0.3) < 1e-12);
});

// ---------------------------------------------------------------------------------------------
// Statistics

test('addToStats / statsRows: groups by month, provider and model', () => {
  const stats = emptyStats();
  const nov = new Date(2026, 10, 8).getTime();
  const oct = new Date(2026, 9, 3).getTime();
  addToStats(stats, { providerId: 'openai', providerName: 'OpenAI', model: 'a', usage: { inputTokens: 10, outputTokens: 5, cost: 0.5, estimated: true }, at: nov });
  addToStats(stats, { providerId: 'openai', providerName: 'OpenAI', model: 'a', usage: { inputTokens: 1, outputTokens: 1 }, at: nov });
  addToStats(stats, { providerId: 'openrouter', providerName: 'OpenRouter', model: 'b', usage: { cost: 1.25 }, at: oct });
  addToStats(stats, { providerId: '', model: 'ignored', at: nov });

  const novRows = statsRows(stats, monthKey(nov));
  assert.equal(novRows.rows.length, 1);
  assert.deepEqual(novRows.total, { requests: 2, inputTokens: 11, outputTokens: 6, cost: 0.5, estimated: 1, unpriced: 1 });

  const all = statsRows(stats, 'all');
  assert.equal(all.rows.length, 2);
  assert.equal(all.rows[0].providerId, 'openrouter', 'most expensive first');
  assert.equal(all.total.cost, 1.75);

  assert.deepEqual(normalizeStats(JSON.parse(JSON.stringify(stats))).months, stats.months);
  assert.deepEqual(normalizeStats('garbage').months, {});
});

test('recordUsage: concurrent writes are all kept; clearUsageStats empties', async () => {
  await clearUsageStats();
  await Promise.all(Array.from({ length: 5 }, (_, i) => recordUsage({
    providerId: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-flash', usage: { inputTokens: i + 1, outputTokens: 1 },
  })));
  const { total } = statsRows(await getUsageStats(), monthKey());
  assert.equal(total.requests, 5);
  assert.equal(total.inputTokens, 15);
  await clearUsageStats();
  assert.equal(statsRows(await getUsageStats(), 'all').rows.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Formatting

test('formatMoney / formatTokens / formatCost / describeUsage (German)', () => {
  const nb = (s) => s.replace(/ /g, ' ');
  assert.equal(nb(formatMoney(1.5)), '1,50 $');
  assert.equal(nb(formatMoney(0.0021)), '0,0021 $');
  assert.equal(nb(formatMoney(0)), '0,00 $');
  assert.equal(nb(formatMoney(12.3, 'CNY')), '12,30 CN¥');
  assert.equal(formatTokens(850), '850');
  assert.equal(formatTokens(1234), '1.234');
  assert.equal(formatTokens(12345), '12,3 Tsd.');
  assert.equal(formatTokens(2_500_000), '2,5 Mio.');
  assert.equal(nb(formatCost({ cost: 0.5, estimated: true })), '≈ 0,50 $');
  assert.equal(formatCost({ inputTokens: 3 }), '');
  assert.match(describeUsage({ inputTokens: 3, outputTokens: 4, reasoningTokens: 2 }), /Gedankengang: 2[\s\S]*Kosten: unbekannt/);
});

test('formatting follows the UI language (English)', () => {
  registerCatalog('en', en);
  setLanguage('en');
  try {
    assert.equal(formatMoney(1.5), '$1.50');
    assert.equal(formatTokens(1234), '1,234');
    assert.equal(formatTokens(12345), '12.3K');
    assert.equal(formatTokens(2_500_000), '2.5M');
    assert.equal(
      describeUsage({ inputTokens: 1200, outputTokens: 4, reasoningTokens: 2, cost: 0.5 }),
      ['Input: 1,200 tokens', 'Output: 4 tokens (including reasoning: 2)', 'Cost: $0.50 (reported by the provider)'].join('\n'),
    );
  } finally {
    setLanguage('de');
  }
});

// ---------------------------------------------------------------------------------------------
// Settings, messages, model list, usage parsing

test('settings keep user prices, model-list prices and usage.showInChat', () => {
  const raw = getDefaultSettings();
  const p = raw.providers.find((x) => x.id === 'openai');
  p.prices = { 'gpt-6.1-sol': { input: '2,5', output: null }, bad: { input: 'x' }, '': { input: 1 } };
  p.modelInfo = { m: { inputPrice: 1, outputPrice: 2 }, n: { inputPrice: -1, outputPrice: 2 } };
  raw.usage = { showInChat: 'nope' };
  const s = normalizeSettings(raw);
  const q = s.providers.find((x) => x.id === 'openai');
  assert.deepEqual(q.prices, { 'gpt-6.1-sol': { input: 2.5, output: null } });
  assert.deepEqual(q.modelInfo, { m: { inputPrice: 1, outputPrice: 2 }, n: {} });
  assert.equal(s.usage.showInChat, true);
});

test('createMessage keeps a valid usage record and drops an invalid one', () => {
  assert.deepEqual(createMessage({ role: 'assistant', usage: { inputTokens: 3, cost: 0.1, estimated: true, junk: 1 } }).usage,
    { inputTokens: 3, cost: 0.1, estimated: true });
  assert.equal('usage' in createMessage({ role: 'assistant', usage: 'x' }), false);
  assert.equal('usage' in createMessage({ role: 'assistant' }), false);
});

test('listModels: OpenRouter pricing (USD per token) becomes USD per 1M tokens', async () => {
  mockFetch((call) => {
    if (call.url.includes('output_modalities')) return json({ data: [] });
    return json({ data: [{ id: 'a/b', pricing: { prompt: '0.000002', completion: '0.00001' } }, { id: 'c/d', pricing: { prompt: '0', completion: '0' } }] });
  });
  const list = await listModels({ id: 'openrouter', presetId: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY });
  assert.deepEqual(list.find((m) => m.id === 'a/b'), { id: 'a/b', inputPrice: 2, outputPrice: 10 });
  assert.deepEqual(list.find((m) => m.id === 'c/d'), { id: 'c/d', inputPrice: 0, outputPrice: 0 });
});

test('streamChat: xAI cost_in_usd_ticks becomes cost in USD', async () => {
  mockFetch(() => json({
    choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost_in_usd_ticks: 25_000_000 },
  }));
  const result = await streamChat({
    provider: { id: 'xai', presetId: 'xai', name: 'xAI', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', apiKey: KEY },
    model: 'grok-4.3', messages: [{ role: 'user', content: 'Hi' }], stream: false,
  });
  assert.equal(result.usage.cost, 0.0025);
});

// ---------------------------------------------------------------------------------------------
// Balance

test('supportsBalance: OpenRouter and DeepSeek only', () => {
  assert.equal(supportsBalance({ presetId: 'openrouter' }), true);
  assert.equal(supportsBalance({ presetId: 'deepseek' }), true);
  assert.equal(supportsBalance({ presetId: 'custom', baseUrl: 'https://api.deepseek.com/v1' }), true);
  assert.equal(supportsBalance({ presetId: 'openai' }), false);
});

test('fetchBalance: OpenRouter key with limit', async () => {
  const calls = mockFetch(() => json({ data: { limit: 20, limit_remaining: 12.5, limit_reset: 'monthly', usage: 7.5, usage_daily: 0.5, usage_monthly: 3, is_free_tier: false } }));
  const res = await fetchBalance({ id: 'openrouter', presetId: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY });
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/key');
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${KEY}`);
  assert.deepEqual(res.balances, [{ label: 'Verbleibendes Limit dieses Schlüssels', amount: 12.5, currency: 'USD' }]);
  assert.deepEqual(res.details[0], { label: 'Limit (pro Monat)', amount: 20, currency: 'USD' });
  assert.equal(res.details.length, 4);
  assert.deepEqual(res.notes, []);
});

test('fetchBalance: OpenRouter key without limit explains where the account credit is', async () => {
  mockFetch(() => json({ data: { limit: null, limit_remaining: null, usage: 1.25, is_free_tier: true } }));
  const res = await fetchBalance({ id: 'openrouter', presetId: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY });
  assert.deepEqual(res.balances, []);
  assert.equal(res.details.length, 1);
  assert.equal(res.notes.length, 2);
  assert.match(res.notes[1], /Management-Schlüssel/);
});

test('fetchBalance: DeepSeek string amounts, URL without /v1', async () => {
  const calls = mockFetch(() => json({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
  }));
  const res = await fetchBalance({ id: 'deepseek', presetId: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY });
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance');
  assert.deepEqual(res.balances, [{ label: 'Guthaben', amount: 110, currency: 'CNY' }]);
  assert.deepEqual(res.details, [
    { label: 'davon aufgeladen', amount: 100, currency: 'CNY' },
    { label: 'davon geschenkt', amount: 10, currency: 'CNY' },
  ]);
});

test('fetchBalance: errors and unsupported providers', async () => {
  await assert.rejects(fetchBalance(openai()), (err) => err.code === 'unsupported');
  await assert.rejects(
    fetchBalance({ id: 'deepseek', presetId: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: '' }),
    (err) => err.code === 'no_key',
  );
  mockFetch(() => json({ error: { message: 'Authentication Fails', type: 'authentication_error' } }, 401));
  await assert.rejects(
    fetchBalance({ id: 'deepseek', presetId: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: KEY }),
    (err) => err.code === 'auth',
  );
});

// ---------------------------------------------------------------------------------------------
// xAI balance (Management API)

const { canFetchBalance, balanceNeedsManagementKey } = await import('../src/lib/llm.js');
const { exportSettings, parseImportedSettings } = await import('../src/lib/settings.js');
const xai = (billing) => ({ id: 'xai', presetId: 'xai', name: 'xAI (Grok)', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', apiKey: KEY, billing });

test('xAI: balance needs a management key', async () => {
  assert.equal(supportsBalance(xai()), true);
  assert.equal(balanceNeedsManagementKey(xai()), true);
  assert.equal(canFetchBalance(xai()), false, 'the normal API key is not enough');
  assert.equal(canFetchBalance(xai({ managementKey: 'mk', teamId: '' })), true);
  assert.equal(canFetchBalance({ presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: '' }), false);
  await assert.rejects(fetchBalance(xai({ managementKey: '' })), (err) => err.code === 'no_key' && /Management-Schlüssel/.test(err.message));
});

test('xAI: team id is discovered, balance in cents becomes USD', async () => {
  const calls = mockFetch((call) => {
    if (call.url.endsWith('/auth/management-keys/validation')) return json({ apiKeyId: 'k', scope: 'SCOPE_TEAM', scopeId: 'team-42' });
    return json({
      changes: [
        { changeOrigin: 'PURCHASE', amount: { val: '-2500' } },
        { changeOrigin: 'SPEND', amount: { val: '734' } },
      ],
      total: { val: '-1766' },
    });
  });
  const res = await fetchBalance(xai({ managementKey: 'Bearer mk-secret', teamId: '' }));
  assert.equal(calls[0].url, 'https://management-api.x.ai/auth/management-keys/validation');
  assert.equal(calls[1].url, 'https://management-api.x.ai/v1/billing/teams/team-42/prepaid/balance');
  assert.equal(calls[1].headers.get('authorization'), 'Bearer mk-secret', 'management key, not the API key');
  assert.deepEqual(res.balances, [{ label: 'Prepaid-Guthaben', amount: 17.66, currency: 'USD' }]);
  assert.deepEqual(res.details, [
    { label: 'Aufgeladen insgesamt', amount: 25, currency: 'USD' },
    { label: 'Verbraucht insgesamt', amount: 7.34, currency: 'USD' },
  ]);
  assert.equal(res.teamId, 'team-42');
});

test('xAI: given team id skips discovery; rejected key gets its own message', async () => {
  const calls = mockFetch(() => json({ total: { val: '0' }, changes: [] }));
  const res = await fetchBalance(xai({ managementKey: 'mk', teamId: 'team 1' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://management-api.x.ai/v1/billing/teams/team%201/prepaid/balance');
  assert.match(res.notes[0], /aufgebraucht/);

  mockFetch(() => json({ code: 'unauthenticated', error: 'Invalid management key' }, 401));
  await assert.rejects(fetchBalance(xai({ managementKey: 'mk', teamId: 't' })), (err) => err.code === 'auth' && /Management-Schlüssel/.test(err.message));
});

test('settings: management key is normalized, blanked in key-less exports and kept on import', () => {
  const raw = getDefaultSettings();
  raw.providers.find((p) => p.id === 'xai').billing = { managementKey: ' mk ', teamId: ' t1 ' };
  const s = normalizeSettings(raw);
  assert.deepEqual(s.providers.find((p) => p.id === 'xai').billing, { managementKey: 'mk', teamId: 't1' });
  assert.deepEqual(s.providers.find((p) => p.id === 'openai').billing, { managementKey: '', teamId: '' });
  const exported = exportSettings(s);
  assert.equal(exported.includes('"mk"'), false);
  const imported = parseImportedSettings(exported, { currentSettings: s });
  assert.equal(imported.providers.find((p) => p.id === 'xai').billing.managementKey, 'mk');
  assert.ok(exportSettings(s, { includeKeys: true }).includes('"mk"'));
});
