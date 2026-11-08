import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ---- fake WebExtension API (must exist before settings.js / ext.js are imported) ----
const store = new Map();
const changeListeners = new Set();

function fireChanged(changes) {
  for (const listener of [...changeListeners]) listener(structuredClone(changes), 'local');
}

globalThis.chrome = {
  runtime: {
    id: 'test-extension',
    getURL: (path = '') => `chrome-extension://test-extension/${path}`,
  },
  storage: {
    local: {
      async get(keys) {
        const list = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
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
        queueMicrotask(() => fireChanged(changes));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
      },
      async clear() {
        store.clear();
      },
    },
    onChanged: {
      addListener: (fn) => changeListeners.add(fn),
      removeListener: (fn) => changeListeners.delete(fn),
    },
  },
};

const settingsModule = await import('../src/lib/settings.js');
const {
  SETTINGS_KEY, getDefaultSettings, normalizeSettings, getSettings, saveSettings, updateSettings,
  onSettingsChanged, getProvider, isProviderReady, getReadyProviders, resolveTarget, listChatModels,
  listImageModels, getContentConfig, exportSettings, parseImportedSettings,
} = settingsModule;
const { PROVIDER_PRESETS } = await import('../src/lib/providers.js');
const { DEFAULT_QUICK_ACTIONS, getDefaultQuickActions, getDefaultPersonas } = await import('../src/lib/prompts.js');
const { registerCatalog, setLanguage } = await import('../src/lib/i18n.js');
const { default: en } = await import('../src/locales/en/index.js');

const BUILTIN_COUNT = PROVIDER_PRESETS.filter((p) => p.id !== 'custom').length;

function withReady(settings, id, patch = {}) {
  const provider = getProvider(settings, id);
  Object.assign(provider, { enabled: true, apiKey: `key-${id}`, ...patch });
  return provider;
}

describe('defaults', () => {
  test('getDefaultSettings has the documented shape', () => {
    const s = getDefaultSettings();
    assert.equal(s.schemaVersion, 1);
    assert.equal(s.providers.length, BUILTIN_COUNT);
    assert.ok(!s.providers.some((p) => p.id === 'custom' || p.presetId === 'custom'));
    assert.equal(new Set(s.providers.map((p) => p.id)).size, s.providers.length);
    for (const p of s.providers) {
      assert.equal(p.id, p.presetId);
      assert.equal(p.apiKey, '');
      assert.equal(p.enabled, false);
      assert.ok(Array.isArray(p.models) && Array.isArray(p.imageModels));
      assert.deepEqual(p.modelInfo, {});
    }
    assert.deepEqual(s.defaults, { chat: null, actions: null, translate: null, image: null });
    assert.deepEqual(s.general, { theme: 'system', language: 'auto', sendWithEnter: true, streaming: true });
    assert.equal(s.chat.personaId, 'default');
    assert.equal(s.chat.temperature, null);
    assert.equal(s.chat.maxTokens, null);
    assert.equal(s.chat.contextMessages, 30);
    assert.deepEqual(s.translate, { targetLang: 'auto', batchChars: 2500, concurrency: 3 });
    assert.deepEqual(s.toolbar, { enabled: true, disabledHosts: [] });
    assert.equal(s.quickActions.length, DEFAULT_QUICK_ACTIONS.length);
    assert.ok(s.personas.some((p) => p.id === 'default' && p.prompt === ''));
  });

  test('target languages: legacy names become codes, free text is kept', () => {
    const norm = (targetLang) => normalizeSettings({ translate: { targetLang } }).translate.targetLang;
    assert.equal(norm('Deutsch'), 'de');
    assert.equal(norm('Chinesisch (vereinfacht)'), 'zh-Hans');
    assert.equal(norm('English'), 'en');
    assert.equal(norm('fr'), 'fr');
    assert.equal(norm('auto'), 'auto');
    assert.equal(norm('Klingonisch'), 'Klingonisch');
    assert.equal(norm(''), 'auto');
    assert.equal(normalizeSettings({ youtube: { summaryLang: 'Japanisch' } }).youtube.summaryLang, 'ja');
  });

  test('UI language: supported codes are kept, everything else becomes auto', () => {
    const lang = (language) => normalizeSettings({ general: { language } }).general.language;
    assert.equal(lang('en'), 'en');
    assert.equal(lang('pt-br'), 'pt-BR');
    assert.equal(lang('de-AT'), 'de');
    assert.equal(lang('xx'), 'auto');
    assert.equal(lang(undefined), 'auto');
  });

  test('getDefaultSettings returns a fresh copy each time', () => {
    const a = getDefaultSettings();
    a.providers[0].models.push('mutated');
    a.quickActions[0].name = 'mutated';
    const b = getDefaultSettings();
    assert.ok(!b.providers[0].models.includes('mutated'));
    assert.notEqual(b.quickActions[0].name, 'mutated');
    assert.notEqual(DEFAULT_QUICK_ACTIONS[0].name, 'mutated');
  });

  test('normalizing the defaults is idempotent', () => {
    const s = getDefaultSettings();
    assert.deepEqual(normalizeSettings(s), s);
    assert.deepEqual(normalizeSettings(normalizeSettings(s)), s);
  });
});

describe('normalizeSettings', () => {
  test('non-object input yields defaults', () => {
    const defaults = getDefaultSettings();
    for (const garbage of [undefined, null, 'abc', 42, true, [], [1, 2]]) {
      assert.deepEqual(normalizeSettings(garbage), defaults);
    }
  });

  test('repairs providers: wrong types, duplicates, missing ids, missing presets', () => {
    const s = normalizeSettings({
      providers: [
        null,
        5,
        'x',
        { id: 'openai', apiKey: '  sk-test  ', enabled: 'yes', models: 'gpt', extraHeaders: [1], imageApi: 'bogus', protocol: 'grpc' },
        { id: 'openai', apiKey: 'duplicate' },
        { name: 'Mein Proxy', baseUrl: ' https://proxy.test/v1/// ', protocol: 'anthropic', enabled: true },
        { presetId: 'anthropic', apiKey: 'a-key', enabled: true, models: ['claude-x', '', 7, 'claude-x'] },
        { id: 'custom-abc', presetId: 'nope', name: '', extraHeaders: { 'X-Ok': 'yes', 'bad header': 'x', 'X-Num': 3, 'X-Obj': {} } },
      ],
    });

    assert.equal(new Set(s.providers.map((p) => p.id)).size, s.providers.length, 'ids are unique');
    for (const preset of PROVIDER_PRESETS.filter((p) => p.id !== 'custom')) {
      assert.ok(getProvider(s, preset.id), `preset ${preset.id} is present`);
    }

    const openai = getProvider(s, 'openai');
    assert.equal(openai.apiKey, 'sk-test', 'key is trimmed, first duplicate wins');
    assert.equal(openai.enabled, false, 'non-boolean enabled → false');
    assert.deepEqual(openai.models, PROVIDER_PRESETS.find((p) => p.id === 'openai').defaultModels);
    assert.equal(openai.imageApi, 'openai-images');
    assert.equal(openai.protocol, 'openai');
    assert.deepEqual(openai.extraHeaders, {});

    const proxy = s.providers.find((p) => p.name === 'Mein Proxy');
    assert.match(proxy.id, /^custom-/);
    assert.equal(proxy.presetId, 'custom');
    assert.equal(proxy.baseUrl, 'https://proxy.test/v1');
    assert.equal(proxy.protocol, 'anthropic');
    assert.equal(proxy.enabled, true);

    const anthropic = getProvider(s, 'anthropic');
    assert.equal(anthropic.presetId, 'anthropic');
    assert.deepEqual(anthropic.models, ['claude-x']);

    const custom = getProvider(s, 'custom-abc');
    assert.equal(custom.presetId, 'custom');
    assert.equal(custom.name, 'Eigener Anbieter');
    assert.deepEqual(custom.extraHeaders, { 'X-Ok': 'yes', 'X-Num': '3' });
  });

  test('defaults pointing to unknown providers or with wrong types become null', () => {
    const s = normalizeSettings({
      defaults: {
        chat: { providerId: 'does-not-exist', model: 'x' },
        actions: 'openai',
        translate: { providerId: 'openai', model: 42 },
        image: { providerId: 'xai', model: ' grok-imagine-image ' },
      },
    });
    assert.equal(s.defaults.chat, null);
    assert.equal(s.defaults.actions, null);
    assert.deepEqual(s.defaults.translate, { providerId: 'openai', model: '' });
    assert.deepEqual(s.defaults.image, { providerId: 'xai', model: 'grok-imagine-image' });
  });

  test('clamps and coerces numbers, fixes enums and booleans', () => {
    const s = normalizeSettings({
      general: { theme: 'neon', sendWithEnter: 'no', streaming: false },
      chat: { temperature: '0,7', maxTokens: -3, contextMessages: 'abc', personaId: 'missing', systemPrompt: 5 },
      translate: { targetLang: '  ', batchChars: 10, concurrency: 0 },
      toolbar: { enabled: 0, disabledHosts: 'Example.com\nhttps://B.test/path?q=1\n\nexample.com, *.c.test:8080' },
    });
    assert.equal(s.general.theme, 'system');
    assert.equal(s.general.sendWithEnter, true);
    assert.equal(s.general.streaming, false);
    assert.equal(s.chat.temperature, 0.7);
    assert.equal(s.chat.maxTokens, null);
    assert.equal(s.chat.contextMessages, 30);
    assert.equal(s.chat.personaId, 'default');
    assert.equal(s.chat.systemPrompt, '');
    assert.equal(s.translate.targetLang, 'auto');
    assert.equal(s.translate.batchChars, 500);
    assert.equal(s.translate.concurrency, 1);
    assert.equal(s.toolbar.enabled, true);
    assert.deepEqual(s.toolbar.disabledHosts, ['example.com', 'b.test', 'c.test']);

    const high = normalizeSettings({ chat: { temperature: 9, maxTokens: '4096', contextMessages: 9999 }, translate: { concurrency: 99, batchChars: 1e9 } });
    assert.equal(high.chat.temperature, 2);
    assert.equal(high.chat.maxTokens, 4096);
    assert.equal(high.chat.contextMessages, 200);
    assert.equal(high.translate.concurrency, 10);
    assert.equal(high.translate.batchChars, 20000);

    assert.equal(normalizeSettings({ chat: { temperature: '' } }).chat.temperature, null);
    assert.equal(normalizeSettings({ chat: { temperature: 0 } }).chat.temperature, 0);
  });

  test('disabled hosts: IDNs become punycode (like location.hostname), junk is dropped', () => {
    const s = normalizeSettings({
      toolbar: { disabledHosts: ['münchen.de', 'https://www.Bücher.de/pfad', 'example.org.', 'localhost:3000', 'foo bar', 'http://'] },
    });
    assert.deepEqual(s.toolbar.disabledHosts, ['xn--mnchen-3ya.de', 'www.xn--bcher-kva.de', 'example.org', 'localhost']);
  });

  test('repairs quick actions: missing/duplicate ids, built-in fallbacks', () => {
    const s = normalizeSettings({
      quickActions: [
        { name: 'Meine Aktion', prompt: 'Mach was mit {{text}}', toolbar: true },
        { id: 'improve' },
        { id: 'improve', name: 'Doppelt', prompt: 'x' },
        null,
        { id: 'own', builtin: true, prompt: 7 },
      ],
    });
    assert.equal(s.quickActions.length, 4);
    const ids = s.quickActions.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);

    const [mine, improve, dup, own] = s.quickActions;
    assert.match(mine.id, /^qa-/);
    assert.equal(mine.builtin, false);
    assert.equal(mine.toolbar, true);
    assert.equal(mine.contextMenu, true);
    assert.equal(mine.icon, '⚡');

    const builtinImprove = DEFAULT_QUICK_ACTIONS.find((a) => a.id === 'improve');
    assert.equal(improve.name, builtinImprove.name);
    assert.equal(improve.prompt, builtinImprove.prompt);
    assert.equal(improve.icon, builtinImprove.icon);
    assert.equal(improve.builtin, true);

    assert.notEqual(dup.id, 'improve');
    assert.equal(dup.builtin, false);
    assert.equal(own.builtin, false, 'unknown ids are never built-in');
    assert.equal(own.prompt, '');

    assert.deepEqual(normalizeSettings({ quickActions: [] }).quickActions, []);
    assert.equal(normalizeSettings({ quickActions: 'x' }).quickActions.length, DEFAULT_QUICK_ACTIONS.length);
  });

  test('personas always contain "default" first; personaId must exist', () => {
    const s = normalizeSettings({
      personas: [{ id: 'pirate', name: 'Pirat', prompt: 'Arr' }, { name: 'Ohne ID' }, 'junk'],
      chat: { personaId: 'pirate' },
    });
    assert.equal(s.personas[0].id, 'default');
    assert.equal(s.personas[1].id, 'pirate');
    assert.match(s.personas[2].id, /^persona-/);
    assert.equal(s.personas[2].name, 'Ohne ID');
    assert.equal(s.chat.personaId, 'pirate');

    const moved = normalizeSettings({ personas: [{ id: 'x', name: 'X', prompt: '' }, { id: 'default', name: 'Std', prompt: '' }] });
    assert.deepEqual(moved.personas.map((p) => p.id), ['default', 'x']);
  });

  test('does not mutate or alias its input and keeps unknown keys', () => {
    const raw = { providers: [{ id: 'openai', models: ['a'] }], extra: { keep: true } };
    const snapshot = structuredClone(raw);
    const s = normalizeSettings(raw);
    assert.deepEqual(raw, snapshot);
    s.providers[0].models.push('b');
    assert.deepEqual(raw.providers[0].models, ['a']);
    assert.deepEqual(s.extra, { keep: true });
  });
});

describe('provider readiness and resolveTarget', () => {
  test('isProviderReady rules', () => {
    const s = getDefaultSettings();
    assert.equal(isProviderReady(getProvider(s, 'openai')), false);
    withReady(s, 'openai');
    assert.equal(isProviderReady(getProvider(s, 'openai')), true);
    getProvider(s, 'openai').baseUrl = '';
    assert.equal(isProviderReady(getProvider(s, 'openai')), false);

    getProvider(s, 'anthropic').enabled = true; // enabled but no key
    assert.equal(isProviderReady(getProvider(s, 'anthropic')), false);

    getProvider(s, 'ollama').enabled = true; // no key required
    assert.equal(isProviderReady(getProvider(s, 'ollama')), true);
    assert.equal(isProviderReady(null), false);
    assert.equal(isProviderReady({}), false);
  });

  test('nothing ready → null for every purpose', () => {
    const s = getDefaultSettings();
    for (const purpose of ['chat', 'actions', 'translate', 'image']) {
      assert.equal(resolveTarget(s, purpose), null, purpose);
    }
    assert.deepEqual(getReadyProviders(s), []);
  });

  test('ready provider without any model is skipped', () => {
    const s = getDefaultSettings();
    getProvider(s, 'ollama').enabled = true; // ready, but no models
    assert.equal(resolveTarget(s, 'chat'), null);
    withReady(s, 'groq');
    const target = resolveTarget(s, 'chat');
    assert.equal(target.provider.id, 'groq');
    assert.equal(target.model, getProvider(s, 'groq').defaultModel);
  });

  test('first ready provider is the fallback (in settings order)', () => {
    const s = getDefaultSettings();
    withReady(s, 'mistral');
    withReady(s, 'anthropic');
    const target = resolveTarget(s, 'chat');
    assert.equal(target.provider.id, 'anthropic'); // anthropic comes before mistral in the list
    assert.equal(target.model, 'claude-sonnet-5-5');
    assert.equal(resolveTarget(s, 'actions').provider.id, 'anthropic');
    assert.equal(resolveTarget(s, 'translate').provider.id, 'anthropic');
  });

  test('chat / actions / translate fallback chains', () => {
    const s = getDefaultSettings();
    withReady(s, 'openai');
    withReady(s, 'anthropic');
    withReady(s, 'mistral');
    s.defaults.chat = { providerId: 'mistral', model: 'mistral-small-latest' };

    assert.deepEqual(pick(resolveTarget(s, 'chat')), ['mistral', 'mistral-small-latest']);
    assert.deepEqual(pick(resolveTarget(s, 'actions')), ['mistral', 'mistral-small-latest'], 'actions → chat');
    assert.deepEqual(pick(resolveTarget(s, 'translate')), ['mistral', 'mistral-small-latest'], 'translate → chat');

    s.defaults.actions = { providerId: 'anthropic', model: '' };
    assert.deepEqual(pick(resolveTarget(s, 'actions')), ['anthropic', 'claude-sonnet-5-5'], 'empty model → provider default');
    assert.deepEqual(pick(resolveTarget(s, 'translate')), ['anthropic', 'claude-sonnet-5-5'], 'translate → actions');
    assert.deepEqual(pick(resolveTarget(s, 'chat')), ['mistral', 'mistral-small-latest'], 'chat ignores actions');

    s.defaults.translate = { providerId: 'openai', model: 'gpt-6-luna' };
    assert.deepEqual(pick(resolveTarget(s, 'translate')), ['openai', 'gpt-6-luna']);

    // A default only counts when its provider is ready.
    getProvider(s, 'openai').enabled = false;
    assert.deepEqual(pick(resolveTarget(s, 'translate')), ['anthropic', 'claude-sonnet-5-5']);
    getProvider(s, 'anthropic').apiKey = '';
    assert.deepEqual(pick(resolveTarget(s, 'translate')), ['mistral', 'mistral-small-latest']);
    assert.deepEqual(pick(resolveTarget(s, 'actions')), ['mistral', 'mistral-small-latest']);

    // Default provider without models and without explicit model → skipped.
    getProvider(s, 'mistral').models = [];
    getProvider(s, 'mistral').defaultModel = '';
    s.defaults.chat = { providerId: 'mistral', model: '' };
    assert.equal(resolveTarget(s, 'chat'), null, 'remaining ready provider has no model either');
    s.defaults.chat = { providerId: 'mistral', model: 'explicit-model' };
    assert.deepEqual(pick(resolveTarget(s, 'chat')), ['mistral', 'explicit-model']);
  });

  test('model falls back to models[0] when defaultModel is empty', () => {
    const s = getDefaultSettings();
    const p = withReady(s, 'deepseek', { defaultModel: '', models: ['deepseek-v4-pro', 'deepseek-flash'] });
    assert.deepEqual(pick(resolveTarget(s, 'chat')), [p.id, 'deepseek-v4-pro']);
  });

  test('image purpose', () => {
    const s = getDefaultSettings();
    withReady(s, 'anthropic'); // ready but imageApi 'none'
    assert.equal(resolveTarget(s, 'image'), null);

    withReady(s, 'xai');
    assert.deepEqual(pick(resolveTarget(s, 'image')), ['xai', 'grok-imagine-image-2.0']);

    withReady(s, 'openai');
    assert.deepEqual(pick(resolveTarget(s, 'image')), ['openai', 'gpt-image-2.5-flare'], 'first ready image provider');

    s.defaults.image = { providerId: 'xai', model: 'grok-imagine-image' };
    assert.deepEqual(pick(resolveTarget(s, 'image')), ['xai', 'grok-imagine-image']);

    s.defaults.image = { providerId: 'anthropic', model: 'x' }; // no image API → ignored
    assert.deepEqual(pick(resolveTarget(s, 'image')), ['openai', 'gpt-image-2.5-flare']);

    // image never falls back to chat defaults
    s.defaults.image = null;
    s.defaults.chat = { providerId: 'xai', model: 'grok-4.7' };
    assert.equal(resolveTarget(s, 'image').provider.id, 'openai');

    // provider with image API but no image model is skipped
    getProvider(s, 'openai').imageModels = [];
    getProvider(s, 'openai').defaultImageModel = '';
    assert.equal(resolveTarget(s, 'image').provider.id, 'xai');
  });
});

function pick(target) {
  return target ? [target.provider.id, target.model] : null;
}

describe('model lists', () => {
  test('listChatModels: ready providers only, label format, defaultModel included', () => {
    const s = getDefaultSettings();
    withReady(s, 'anthropic');
    withReady(s, 'groq', { models: [], defaultModel: 'llama-x' });
    const list = listChatModels(s);
    assert.ok(list.every((m) => ['anthropic', 'groq'].includes(m.providerId)));
    const groq = list.filter((m) => m.providerId === 'groq');
    assert.deepEqual(groq, [{ providerId: 'groq', providerName: 'Groq', model: 'llama-x', label: 'Groq · llama-x' }]);
    const claude = list.find((m) => m.model === 'claude-opus-5-5');
    assert.equal(claude.label, `${claude.providerName} · claude-opus-5-5`);
    assert.equal(list.filter((m) => m.providerId === 'anthropic').length, 4, 'no duplicate default model');
  });

  test('listImageModels: only providers with an image API', () => {
    const s = getDefaultSettings();
    withReady(s, 'anthropic');
    withReady(s, 'xai');
    const list = listImageModels(s);
    assert.deepEqual(list.map((m) => m.model), ['grok-imagine-image-2.0', 'grok-imagine-image']);
    assert.equal(list[0].label, 'xAI (Grok) · grok-imagine-image-2.0');
  });
});

describe('getContentConfig', () => {
  test('contains no keys and has the documented shape', () => {
    const s = getDefaultSettings();
    withReady(s, 'openai', { apiKey: 'sk-SECRET-123', extraHeaders: { Authorization: 'Bearer SECRET-H' } });
    s.toolbar.disabledHosts = ['example.com'];
    const config = getContentConfig(s);
    const json = JSON.stringify(config);
    assert.ok(!json.includes('SECRET'));
    assert.ok(!json.includes('apiKey'));
    assert.ok(!('providers' in config));
    assert.deepEqual(Object.keys(config).sort(), ['languages', 'quickActions', 'ready', 'showUsage', 'theme', 'toolbar', 'translate', 'uiLanguage']);
    assert.equal(config.ready, true);
    assert.deepEqual(config.toolbar, { enabled: true, disabledHosts: ['example.com'] });
    // 'auto' is resolved to the UI language (German in the tests).
    assert.deepEqual(config.translate, { targetLang: 'de', batchChars: 2500, concurrency: 3 });
    assert.ok(config.languages.some((l) => l.value === 'de' && l.label === 'Deutsch'));
    assert.equal(config.theme, 'system');
    for (const action of config.quickActions) {
      assert.deepEqual(Object.keys(action).sort(), ['contextMenu', 'icon', 'id', 'name', 'toolbar']);
    }
    assert.equal(getContentConfig(getDefaultSettings()).ready, false);
  });
});

describe('export / import', () => {
  function sampleSettings() {
    const s = getDefaultSettings();
    withReady(s, 'openai', { apiKey: 'sk-SECRET-openai' });
    withReady(s, 'openrouter', { apiKey: 'or-SECRET', extraHeaders: { 'X-Title': 'LLM Sidebar', Authorization: 'Bearer SECRET-hdr' } });
    s.defaults.chat = { providerId: 'openai', model: 'gpt-6-luna' };
    s.profile.aboutMe = 'Ich bin Alex.';
    s.chat.temperature = 0.3;
    return s;
  }

  test('export without keys blanks every apiKey and every non-preset header value', () => {
    const s = sampleSettings();
    s.providers.push({
      id: 'custom-proxy', presetId: 'custom', name: 'Proxy', baseUrl: 'https://proxy.example/v1', enabled: true,
      extraHeaders: { 'Helicone-Auth': 'Bearer sk-helicone-SECRET', 'Ocp-Apim-Subscription-Key': 'azure-SECRET', 'X-Title': 'Mein Titel' },
    });
    const json = exportSettings(s);
    assert.ok(!json.includes('SECRET'));
    const parsed = JSON.parse(json);
    assert.equal(parsed.keysIncluded, false);
    assert.ok(parsed.settings.providers.every((p) => p.apiKey === ''));
    const or = parsed.settings.providers.find((p) => p.id === 'openrouter');
    assert.equal(or.extraHeaders['X-Title'], 'LLM Sidebar', 'preset defaults are no secrets');
    assert.equal(or.extraHeaders.Authorization, '');
    const proxy = parsed.settings.providers.find((p) => p.id === 'custom-proxy');
    assert.deepEqual(proxy.extraHeaders, { 'Helicone-Auth': '', 'Ocp-Apim-Subscription-Key': '', 'X-Title': '' });
    assert.equal(JSON.parse(exportSettings(s, { includeKeys: true })).keysIncluded, true);
  });

  test('export with keys keeps them; import round-trip is lossless', () => {
    const original = sampleSettings();
    const json = exportSettings(original, { includeKeys: true });
    assert.ok(json.includes('sk-SECRET-openai'));
    const imported = parseImportedSettings(json);
    assert.deepEqual(imported, normalizeSettings(original));
  });

  test('import accepts the raw settings object and {settings: …}', () => {
    const original = normalizeSettings(sampleSettings());
    assert.deepEqual(parseImportedSettings(JSON.stringify(original)), original);
    assert.deepEqual(parseImportedSettings({ settings: original }), original);
    assert.deepEqual(parseImportedSettings(original), original);
  });

  test('import without keys can keep the current keys', () => {
    const current = sampleSettings();
    const json = exportSettings(current);
    const plain = parseImportedSettings(json);
    assert.equal(getProvider(plain, 'openai').apiKey, '');
    const merged = parseImportedSettings(json, { currentSettings: current });
    assert.equal(getProvider(merged, 'openai').apiKey, 'sk-SECRET-openai');
    // Blanked header values come back from the current settings as well.
    assert.equal(getProvider(merged, 'openrouter').extraHeaders.Authorization, 'Bearer SECRET-hdr');
  });

  test('import never re-attaches a key to a provider whose endpoint the file changed', () => {
    const current = sampleSettings();
    const file = { settings: { providers: [
      { id: 'openai', baseUrl: 'https://attacker.example/v1', enabled: true },
      { id: 'openrouter', protocol: 'anthropic', enabled: true, extraHeaders: { Authorization: '' } },
    ], quickActions: [] } };
    const imported = parseImportedSettings(JSON.stringify(file), { currentSettings: current });
    const openai = getProvider(imported, 'openai');
    assert.equal(openai.baseUrl, 'https://attacker.example/v1');
    assert.equal(openai.apiKey, '');
    assert.equal(isProviderReady(openai), false);
    const or = getProvider(imported, 'openrouter');
    assert.equal(or.apiKey, '');
    assert.equal(or.extraHeaders.Authorization, '');
    // Same endpoint (trailing slash is irrelevant) keeps the key.
    const same = parseImportedSettings({ providers: [{ id: 'openai', baseUrl: 'https://api.openai.com/v1/', enabled: true }] }, { currentSettings: current });
    assert.equal(getProvider(same, 'openai').apiKey, 'sk-SECRET-openai');
  });

  test('invalid input throws German errors', () => {
    const cases = ['', '   ', 'kein json', '[]', '[{"id":"chat"}]', '42', 'null', '{"foo":1}', '{"providers":"x"}'];
    for (const input of cases) {
      assert.throws(() => parseImportedSettings(input), (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Datei|Format|Einstellungen/);
        return true;
      }, `input: ${input}`);
    }
    assert.throws(() => parseImportedSettings(null), Error);
    assert.throws(() => parseImportedSettings(undefined), Error);
  });
});

describe('storage', () => {
  beforeEach(() => {
    store.clear();
  });

  test('getSettings returns defaults when nothing is stored and does not write', async () => {
    const s = await getSettings();
    assert.deepEqual(s, getDefaultSettings());
    assert.equal(store.has(SETTINGS_KEY), false);
  });

  test('saveSettings normalizes and persists; getSettings reads it back', async () => {
    const saved = await saveSettings({ general: { theme: 'dark' }, chat: { contextMessages: 1000 } });
    assert.equal(saved.general.theme, 'dark');
    assert.equal(saved.chat.contextMessages, 200);
    assert.deepEqual(store.get(SETTINGS_KEY), saved);
    assert.deepEqual(await getSettings(), saved);
  });

  test('onSettingsChanged delivers normalized settings and unsubscribes', async () => {
    const received = [];
    const unsubscribe = onSettingsChanged((s) => received.push(s));
    const otherKey = chrome.storage.local.set({ unrelated: 1 });
    await otherKey;
    await saveSettings({ general: { theme: 'light' } });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(received.length, 1, 'only changes of the settings key are reported');
    assert.equal(received[0].general.theme, 'light');
    assert.equal(received[0].providers.length, BUILTIN_COUNT);

    // other storage areas are ignored
    for (const listener of changeListeners) listener({ settings: { newValue: {} } }, 'session');
    assert.equal(received.length, 1);

    unsubscribe();
    await saveSettings({ general: { theme: 'dark' } });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(received.length, 1);
  });

  test('updateSettings applies mutators (in place or returning a new object) without losing updates', async () => {
    await Promise.all([
      updateSettings((s) => { s.profile.aboutMe = 'A'; }),
      updateSettings((s) => ({ ...s, profile: { ...s.profile, writingStyle: 'B' } })),
      updateSettings(async (s) => { s.translate.targetLang = 'Englisch'; }),
    ]);
    const s = await getSettings();
    assert.equal(s.profile.aboutMe, 'A');
    assert.equal(s.profile.writingStyle, 'B');
    assert.equal(s.translate.targetLang, 'en'); // legacy German names are migrated to codes
  });

  test('a failing mutator rejects but does not block later updates', async () => {
    await assert.rejects(updateSettings(() => { throw new Error('boom'); }), /boom/);
    const saved = await updateSettings((s) => { s.general.theme = 'dark'; });
    assert.equal(saved.general.theme, 'dark');
  });
});

describe('UI language', () => {
  registerCatalog('en', en);
  afterEach(() => setLanguage('de'));

  test('defaults are created in the current prompt language', () => {
    const de = getDefaultSettings();
    assert.deepEqual(de.quickActions, getDefaultQuickActions('de'));
    assert.deepEqual(de.personas, getDefaultPersonas('de'));
    setLanguage('en');
    const enDefaults = getDefaultSettings();
    assert.deepEqual(enDefaults.quickActions, getDefaultQuickActions('en'));
    assert.equal(enDefaults.personas[1].name, 'Developer');
    assert.deepEqual(normalizeSettings({}).quickActions, getDefaultQuickActions('en'));
  });

  test('built-in fallbacks work for German and English stored defaults; stored values are kept', () => {
    const stored = { quickActions: [...getDefaultQuickActions('de').slice(0, 1), ...getDefaultQuickActions('en').slice(1, 2), { id: 'grammar' }, { name: '' }] };
    setLanguage('en');
    const [improve, rewrite, grammar, custom] = normalizeSettings(stored).quickActions;
    assert.equal(improve.name, 'Verbessern', 'normalization never rewrites stored names');
    assert.equal(improve.builtin, true);
    assert.equal(rewrite.name, 'Rewrite');
    assert.equal(rewrite.builtin, true);
    assert.equal(grammar.name, 'Correct');
    assert.equal(grammar.prompt, getDefaultQuickActions('en')[2].prompt);
    assert.equal(custom.name, 'Action');
    assert.equal(normalizeSettings({ personas: [{ id: 'x' }] }).personas[1].name, 'Persona');
    assert.equal(normalizeSettings({ personas: [{ id: 'teacher' }] }).personas[1].name, 'Teacher');
  });

  test('the content script gets display names in the UI language', () => {
    const s = getDefaultSettings(); // German defaults
    s.quickActions[1].name = 'Neu formulieren';
    s.quickActions.push({ id: 'qa-1', name: 'Mein Ding', icon: '⚡', prompt: '{{text}}', toolbar: true, contextMenu: true });
    assert.equal(getContentConfig(s).quickActions[0].name, 'Verbessern');
    setLanguage('en');
    const names = getContentConfig(s).quickActions.map((a) => a.name);
    assert.equal(names[0], 'Improve');
    assert.equal(names[1], 'Neu formulieren', 'renamed built-in actions keep their name');
    assert.equal(names[2], 'Correct');
    assert.equal(names.at(-1), 'Mein Ding');
  });

  test('import errors follow the UI language', () => {
    setLanguage('en');
    assert.throws(() => parseImportedSettings(''), /^Error: The file is empty\.$/);
    assert.throws(() => parseImportedSettings('kein json'), /valid JSON/);
    assert.throws(() => parseImportedSettings('[]'), /chat export/);
    assert.throws(() => parseImportedSettings('{"foo":1}'), /LLM Sidebar settings/);
    assert.throws(() => parseImportedSettings('{"providers":"x"}'), /“providers” must be a list/);
  });
});
