import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ---- fake WebExtension permissions API (must exist before ext.js is imported) ----
const perm = { granted: false, requestResult: true, throwOnRequest: false, added: new Set() };
globalThis.chrome = {
  runtime: { id: 'test-extension', getURL: (path = '') => `chrome-extension://test-extension/${path}` },
  permissions: {
    async contains(query) {
      assert.deepEqual(query, { origins: ['<all_urls>'] });
      return perm.granted;
    },
    request(query) {
      assert.deepEqual(query, { origins: ['<all_urls>'] });
      if (perm.throwOnRequest) throw new Error('permissions.request may only be called from a user input handler');
      if (perm.requestResult) perm.granted = true;
      return Promise.resolve(perm.requestResult);
    },
    onAdded: { addListener: (fn) => perm.added.add(fn) },
    onRemoved: { addListener: () => {} },
  },
};

const { createProviderFromPreset, createCustomProvider, PROVIDER_PRESETS } = await import('../src/lib/providers.js');
const {
  providerStatus, isProviderUsable, shouldAutoLoadModels, describeImportedProviders, describeMerge, mergeFetchedModels,
  validateBaseUrl, parseHeadersJson,
} = await import('../src/options/models.js');
const { registerCatalog, setLanguage } = await import('../src/lib/i18n.js');
const { default: en } = await import('../src/locales/en/index.js');
const { default: deOptions } = await import('../src/locales/de/options.js');
const { default: enOptions } = await import('../src/locales/en/options.js');
registerCatalog('en', en);
const { hostAccessState, requestHostAccess, onHostAccessChange } = await import('../src/options/permission.js');

const provider = (presetId, overrides = {}) => createProviderFromPreset(presetId, overrides);

describe('providerStatus / isProviderUsable', () => {
  test('an enabled local provider without models is not ready', () => {
    const ollama = provider('ollama', { enabled: true });
    assert.deepEqual(providerStatus(ollama), { ready: false, label: 'Kein Modell', cls: 'badge-warning' });
    assert.equal(isProviderUsable(ollama), false);
  });

  test('a provider with a chat model or an image model is ready', () => {
    assert.equal(providerStatus(provider('ollama', { enabled: true, models: ['llama3.3'] })).label, 'Bereit');
    assert.equal(isProviderUsable(provider('ollama', { enabled: true, defaultModel: 'llama3.3' })), true);
    const imageOnly = provider('custom', {
      enabled: true, baseUrl: 'https://img.example/v1', models: [], defaultModel: '', imageApi: 'openai-images', imageModels: ['img-1'],
    });
    assert.equal(isProviderUsable(imageOnly), true);
  });

  test('disabled, keyless or URL-less providers are not usable', () => {
    assert.equal(isProviderUsable(provider('openai')), false);
    assert.equal(isProviderUsable(provider('openai', { enabled: true })), false);
    assert.equal(isProviderUsable(provider('openai', { enabled: true, apiKey: 'sk-test' })), true);
    assert.equal(isProviderUsable(provider('ollama', { enabled: true, baseUrl: '', models: ['x'] })), false);
  });
});

describe('shouldAutoLoadModels', () => {
  test('true for an enabled keyless provider that has no models yet', () => {
    assert.equal(shouldAutoLoadModels(provider('ollama', { enabled: true })), true);
    assert.equal(shouldAutoLoadModels(provider('lmstudio', { enabled: true })), true);
    assert.equal(shouldAutoLoadModels(createCustomProvider({ baseUrl: 'http://localhost:4000/v1' })), true);
  });

  test('false when disabled, already set up, missing a key or a base URL', () => {
    assert.equal(shouldAutoLoadModels(provider('ollama')), false);
    assert.equal(shouldAutoLoadModels(provider('ollama', { enabled: true, models: ['llama3.3'] })), false);
    assert.equal(shouldAutoLoadModels(provider('ollama', { enabled: true, models: [], defaultModel: 'qwen3' })), false);
    assert.equal(shouldAutoLoadModels(provider('ollama', { enabled: true, baseUrl: '' })), false);
    assert.equal(shouldAutoLoadModels(provider('openai', { enabled: true, models: [], defaultModel: '' })), false);
  });
});

describe('describeImportedProviders', () => {
  const current = {
    providers: [
      provider('openai', { enabled: true, apiKey: 'sk-old' }),
      provider('anthropic', { enabled: true, apiKey: 'sk-ant' }),
      provider('ollama', { enabled: true, models: ['llama3.3'] }),
    ],
  };

  test('lists changed endpoints and whether the stored key is carried over', () => {
    const imported = {
      providers: [
        provider('openai', { enabled: true, baseUrl: 'https://attacker.example/v1', apiKey: '' }),
        provider('anthropic', { enabled: true, baseUrl: 'https://proxy.example/v1', apiKey: 'sk-ant' }),
        provider('ollama', { enabled: true, baseUrl: 'http://localhost:11434/v1/' }),
        provider('xai', { enabled: true, baseUrl: 'https://new.example/v1' }),
      ],
    };
    const { endpoints, blankHeaders } = describeImportedProviders(current, imported);
    assert.deepEqual(endpoints.map((e) => [e.id, e.from, e.to, e.keyDropped, e.keyKept]), [
      ['openai', 'https://api.openai.com/v1', 'https://attacker.example/v1', true, false],
      ['anthropic', current.providers[1].baseUrl, 'https://proxy.example/v1', false, true],
    ]);
    assert.deepEqual(blankHeaders, []);
  });

  test('a protocol change counts as a changed endpoint', () => {
    const custom = createCustomProvider({ name: 'Proxy', baseUrl: 'https://proxy.example/v1', apiKey: 'k' });
    const imported = { providers: [{ ...custom, protocol: 'anthropic', apiKey: '' }] };
    const { endpoints } = describeImportedProviders({ providers: [custom] }, imported);
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0].keyDropped, true);
  });

  test('reports enabled providers whose header values are blank', () => {
    const imported = {
      providers: [
        provider('openai', { enabled: true, extraHeaders: { 'Helicone-Auth': '' } }),
        provider('xai', { enabled: false, extraHeaders: { 'X-Token': '' } }),
        provider('groq', { enabled: true, extraHeaders: { 'X-Title': 'LLM Sidebar' } }),
      ],
    };
    assert.deepEqual(describeImportedProviders(current, imported).blankHeaders, ['OpenAI']);
  });

  test('copes with missing input', () => {
    assert.deepEqual(describeImportedProviders(null, null), { endpoints: [], blankHeaders: [] });
  });
});

describe('host access permission', () => {
  test('hostAccessState reflects permissions.contains', async () => {
    perm.granted = false;
    assert.equal(await hostAccessState(), 'missing');
    perm.granted = true;
    assert.equal(await hostAccessState(), 'granted');
  });

  test('requestHostAccess asks synchronously and notifies listeners', async () => {
    perm.granted = false;
    perm.requestResult = true;
    let calls = 0;
    const off = onHostAccessChange(() => { calls += 1; });
    const pending = requestHostAccess();
    assert.equal(perm.granted, true, 'permissions.request must run before the first await');
    assert.equal(await pending, true);
    assert.equal(calls, 1);
    off();
    perm.requestResult = false;
    perm.granted = false;
    assert.equal(await requestHostAccess(), false);
    assert.equal(calls, 1);
  });

  test('requestHostAccess rejects when the browser refuses the call', async () => {
    perm.throwOnRequest = true;
    await assert.rejects(requestHostAccess(), /user input handler/);
    perm.throwOnRequest = false;
  });

  test('browser permission events notify listeners', () => {
    let calls = 0;
    const off = onHostAccessChange(() => { calls += 1; });
    for (const fn of perm.added) fn({ origins: ['<all_urls>'] });
    assert.equal(calls, 1);
    off();
  });
});

describe('options page translations', () => {
  const merged = (presetId, list, overrides = {}) => {
    const p = provider(presetId, { enabled: true, models: [], defaultModel: '', ...overrides });
    return describeMerge(p, mergeFetchedModels(p, list));
  };

  test('German is the default: merge summary with plural forms', () => {
    assert.equal(merged('openai', [{ id: 'a' }]), '1 Chat-Modell geladen.');
    assert.equal(merged('openrouter', [{ id: 'a' }, { id: 'b' }, { id: 'gpt-image-2', imageOutput: true }]),
      '2 Chat-Modelle und 1 Bildmodell geladen.');
    assert.match(merged('ollama', []), /^Ollama meldet keine Modelle/);
  });

  test('English after setLanguage("en")', () => {
    setLanguage('en');
    try {
      assert.equal(merged('openai', [{ id: 'a' }]), 'Loaded 1 chat model.');
      assert.equal(merged('openrouter', [{ id: 'a' }, { id: 'b' }, { id: 'gpt-image-2', imageOutput: true }]),
        'Loaded 2 chat models and 1 image model.');
      assert.equal(providerStatus(provider('ollama', { enabled: true })).label, 'No model');
      assert.equal(validateBaseUrl('ftp://x').error, 'The base URL must start with https:// or http://.');
      assert.equal(parseHeadersJson('{ "bad name": "x" }').error, 'Invalid header name: “bad name”.');
    } finally {
      setLanguage('de');
    }
    assert.equal(providerStatus(provider('ollama', { enabled: true })).label, 'Kein Modell');
  });

  test('every section and provider preset has its texts in German and English', () => {
    const keys = ['providers', 'defaults', 'costs', 'chat', 'quickActions', 'translate', 'profile', 'appearance', 'data', 'about']
      .flatMap((k) => [`options.section.${k}.label`, `options.section.${k}.description`]);
    for (const preset of PROVIDER_PRESETS) {
      keys.push(`options.providers.preset.${preset.id}.notes`);
      (preset.baseUrlOptions || []).forEach((option, i) => {
        keys.push(`options.providers.preset.${preset.id}.endpoint${i + 1}.label`);
        if (option.note) keys.push(`options.providers.preset.${preset.id}.endpoint${i + 1}.note`);
      });
    }
    for (const key of keys) {
      assert.ok(deOptions[key], `de: ${key}`);
      assert.ok(enOptions[key], `en: ${key}`);
    }
  });
});
