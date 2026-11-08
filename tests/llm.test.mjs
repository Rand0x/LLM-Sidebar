import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  LLMError, describeError, streamChat, generateImage, listModels, testConnection,
  isImageModelId, isNonChatModelId,
} from '../src/lib/llm.js';
import { registerCatalog, setLanguage } from '../src/lib/i18n.js';
import en from '../src/locales/en/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function byteStream(text, sizes = [5, 1, 9, 2, 13, 3]) {
  const bytes = enc.encode(text);
  const chunks = [];
  for (let i = 0, k = 0; i < bytes.length; k += 1) {
    const n = sizes[k % sizes.length];
    chunks.push(bytes.slice(i, i + n));
    i += n;
  }
  return new ReadableStream({
    pull(controller) {
      if (chunks.length) controller.enqueue(chunks.shift());
      else controller.close();
    },
  });
}

function sseText(items, eol = '\n') {
  return items.map((item) => {
    if (typeof item === 'string') return item;
    if (item && item.event) return `event: ${item.event}${eol}data: ${JSON.stringify(item.data)}${eol}${eol}`;
    return `data: ${JSON.stringify(item)}${eol}${eol}`;
  }).join('');
}

function sseResponse(items, { sizes, eol, status = 200 } = {}) {
  const text = typeof items === 'string' ? items : sseText(items, eol);
  return new Response(byteStream(text, sizes), { status, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(body, status = 200, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json', ...headers } });
}

let restoreFetch = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      init,
      method: init.method || 'GET',
      headers: new Headers(init.headers || {}),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (init.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
    return handler(call, calls.length - 1);
  };
  restoreFetch = () => {
    globalThis.fetch = original;
  };
  return calls;
}

const KEY = 'sk-test-0123456789abcdefghij';

function provider(presetId, overrides = {}) {
  const base = {
    openai: { name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', imageApi: 'openai-images' },
    anthropic: { name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', imageApi: 'none' },
    openrouter: {
      name: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', imageApi: 'openrouter-chat',
      extraHeaders: { 'HTTP-Referer': 'https://github.com/llm-sidebar', 'X-Title': 'LLM Sidebar' },
    },
    xai: { name: 'xAI', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', imageApi: 'openai-images' },
    zai: { name: 'Z.AI', protocol: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', imageApi: 'openai-images' },
    gemini: { name: 'Google Gemini', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', imageApi: 'openai-images' },
    mistral: { name: 'Mistral', protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1', imageApi: 'none' },
    deepseek: { name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', imageApi: 'none' },
    groq: { name: 'Groq', protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1', imageApi: 'none' },
    ollama: { name: 'Ollama', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', imageApi: 'none', apiKey: '' },
    'ollama-cloud': { name: 'Ollama Cloud', protocol: 'openai', baseUrl: 'https://ollama.com/v1', imageApi: 'none' },
    lmstudio: { name: 'LM Studio', protocol: 'openai', baseUrl: 'http://localhost:1234/v1', imageApi: 'none', apiKey: '' },
    custom: { name: 'Mein Proxy', protocol: 'openai', baseUrl: 'https://llm.example.com/v1', imageApi: 'openai-images' },
  }[presetId];
  return {
    id: presetId === 'custom' ? 'custom-abc' : presetId,
    presetId,
    apiKey: KEY,
    enabled: true,
    models: [],
    defaultModel: '',
    imageModels: [],
    defaultImageModel: '',
    extraHeaders: {},
    ...base,
    ...overrides,
  };
}

function collector() {
  const textCalls = [];
  const reasoningCalls = [];
  return {
    textCalls,
    reasoningCalls,
    onText: (delta, full) => textCalls.push([delta, full]),
    onReasoning: (delta, full) => reasoningCalls.push([delta, full]),
  };
}

function assertDeltasConsistent(calls, finalText) {
  let acc = '';
  for (const [delta, full] of calls) {
    assert.ok(delta.length > 0, 'delta must not be empty');
    acc += delta;
    assert.equal(full, acc);
  }
  assert.equal(acc, finalText);
}

async function expectLLMError(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof LLMError, `expected LLMError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code} (${err.message} / ${err.details})`);
    return err;
  }
  assert.fail(`expected LLMError ${code}`);
  return null;
}

const userMsg = (content) => [{ role: 'user', content }];

// ---------------------------------------------------------------------------
// streamChat – protocol openai
// ---------------------------------------------------------------------------

test('OpenAI-style stream with reasoning_content, usage chunk with empty choices and [DONE]', async () => {
  const events = [
    { id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Ich über' }, finish_reason: null }], usage: null },
    { choices: [{ index: 0, delta: { reasoning_content: 'lege … ✓' } }] },
    { choices: [{ index: 0, delta: { content: 'Grüße ' } }] },
    { choices: [{ index: 0, delta: { content: 'aus 😀 Köln' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 3 } } },
    'data: [DONE]\n\n',
    { choices: [{ index: 0, delta: { content: 'NACH DONE' } }] },
  ];
  for (const sizes of [[1], [3, 7], [2, 1]]) {
    const calls = mockFetch(() => sseResponse(events, { sizes }));
    const c = collector();
    const result = await streamChat({
      provider: provider('xai'), model: 'grok-4.3', messages: userMsg('Hallo'), system: 'Sei hilfreich.', ...c,
    });
    assert.equal(result.text, 'Grüße aus 😀 Köln');
    assert.equal(result.reasoning, 'Ich überlege … ✓');
    assert.deepEqual(result.images, []);
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 3 });
    assertDeltasConsistent(c.textCalls, result.text);
    assertDeltasConsistent(c.reasoningCalls, result.reasoning);

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, 'https://api.x.ai/v1/chat/completions');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.get('authorization'), `Bearer ${KEY}`);
    assert.equal(call.headers.get('content-type'), 'application/json');
    assert.deepEqual(call.body, {
      model: 'grok-4.3',
      messages: [{ role: 'system', content: 'Sei hilfreich.' }, { role: 'user', content: 'Hallo' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    restoreFetch();
  }
});

test('OpenRouter: comment lines are skipped and a mid-stream error chunk throws', async () => {
  const text = ': OPENROUTER PROCESSING\n\n'
    + sseText([{ choices: [{ index: 0, delta: { content: 'Teil' } }] }])
    + ': OPENROUTER PROCESSING\n\n'
    + sseText([{
      id: 'gen-1',
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
      error: { code: 429, message: 'Rate limit exceeded', metadata: { error_type: 'rate_limit_exceeded' } },
    }]);
  const calls = mockFetch(() => sseResponse(text, { sizes: [4] }));
  const c = collector();
  const err = await expectLLMError(streamChat({
    provider: provider('openrouter'), model: 'z-ai/glm-5.3', messages: userMsg('Hi'), maxTokens: 300, ...c,
  }), 'rate_limit');
  assert.equal(err.status, 429);
  assert.equal(err.details, 'Rate limit exceeded');
  assert.equal(err.partial.text, 'Teil');
  assert.match(describeError(err), /Zu viele Anfragen an OpenRouter.*Rate limit exceeded/);

  const [call] = calls;
  assert.equal(call.headers.get('http-referer'), 'https://github.com/llm-sidebar');
  assert.equal(call.headers.get('x-title'), 'LLM Sidebar');
  assert.equal(call.body.max_tokens, 300);
  assert.equal('max_completion_tokens' in call.body, false);
  assert.equal('stream_options' in call.body, false);
});

test('OpenRouter: finish_reason "error" without error object still throws', async () => {
  mockFetch(() => sseResponse([
    { choices: [{ index: 0, delta: { content: 'abc' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'error' }] },
  ]));
  const err = await expectLLMError(streamChat({ provider: provider('openrouter'), model: 'x/y', messages: userMsg('Hi') }), 'server');
  assert.equal(err.partial.text, 'abc');
});

test('OpenRouter: usage chunk repeating finish_reason is not an error; reasoning not duplicated; images', async () => {
  mockFetch(() => sseResponse([
    { choices: [{ index: 0, delta: { reasoning: 'Denke', reasoning_details: [{ type: 'reasoning.text', text: 'Denke', index: 0 }] } }] },
    { choices: [{ index: 0, delta: { reasoning_details: [{ type: 'reasoning.summary', summary: ' nach' }] } }] },
    { choices: [{ index: 0, delta: { content: 'Antwort', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }] }, finish_reason: 'stop' }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, cost: 0.001 } },
    'data: [DONE]\n\n',
  ]));
  const result = await streamChat({ provider: provider('openrouter'), model: 'google/gemini-3.1-flash-image', messages: userMsg('Hi') });
  assert.equal(result.reasoning, 'Denke nach');
  assert.equal(result.text, 'Antwort');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.images, [`data:image/png;base64,${PNG_B64}`]);
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7, cost: 0.001 });
});

test('Mistral: content arrays with thinking chunks, whitelisted body fields', async () => {
  const calls = mockFetch(() => sseResponse([
    { choices: [{ index: 0, delta: { role: 'assistant', content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Hmm, ' }] }] } }] },
    { choices: [{ index: 0, delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'okay.' }] }] } }] },
    { choices: [{ index: 0, delta: { content: [{ type: 'text', text: 'Hallo' }] } }] },
    { choices: [{ index: 0, delta: { content: ' Welt' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
    'data: [DONE]\n\n',
  ], { sizes: [6, 1] }));
  const c = collector();
  const result = await streamChat({
    provider: provider('mistral'), model: 'mistral-large-4', messages: userMsg('Hi'), system: 'S',
    temperature: 0.3, maxTokens: 100, ...c,
  });
  assert.equal(result.reasoning, 'Hmm, okay.');
  assert.equal(result.text, 'Hallo Welt');
  assertDeltasConsistent(c.reasoningCalls, result.reasoning);
  const body = calls[0].body;
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.max_tokens, 100);
});

test('Mistral: non-stream message.content array', async () => {
  const calls = mockFetch(() => jsonResponse({
    choices: [{ index: 0, message: { role: 'assistant', content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Gedanke' }] }, { type: 'text', text: 'Ergebnis' }] }, finish_reason: 'stop' }],
  }));
  const result = await streamChat({ provider: provider('mistral'), model: 'mistral-small-latest', messages: userMsg('Hi'), stream: false });
  assert.equal(result.text, 'Ergebnis');
  assert.equal(result.reasoning, 'Gedanke');
  assert.equal(calls[0].body.stream, false);
});

test('<think> tags at the start of content are moved into reasoning (split across chunks)', async () => {
  mockFetch(() => sseResponse([
    { choices: [{ delta: { content: '\n<thi' } }] },
    { choices: [{ delta: { content: 'nk>Überlegung' } }] },
    { choices: [{ delta: { content: ' läuft</th' } }] },
    { choices: [{ delta: { content: 'ink>\n\nDie Antwort' } }] },
    { choices: [{ delta: { content: ' ist 42.' }, finish_reason: 'stop' }] },
    'data: [DONE]\n\n',
  ], { sizes: [1] }));
  const c = collector();
  const result = await streamChat({ provider: provider('ollama'), model: 'qwen3:8b', messages: userMsg('Frage'), ...c });
  assert.equal(result.reasoning, 'Überlegung läuft');
  assert.equal(result.text, 'Die Antwort ist 42.');
  assertDeltasConsistent(c.textCalls, result.text);
  assertDeltasConsistent(c.reasoningCalls, result.reasoning);
});

test('content that merely starts with "<" is not treated as thinking', async () => {
  mockFetch(() => sseResponse([
    { choices: [{ delta: { content: '<' } }] },
    { choices: [{ delta: { content: 'b>fett</b> und <think>bleibt</think>' } }] },
    'data: [DONE]\n\n',
  ]));
  const result = await streamChat({ provider: provider('lmstudio'), model: 'local', messages: userMsg('x') });
  assert.equal(result.text, '<b>fett</b> und <think>bleibt</think>');
  assert.equal(result.reasoning, '');
});

test('Ollama: no key required, no Authorization header, no prefill', async () => {
  const calls = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  await streamChat({
    provider: provider('ollama'),
    model: 'llama3.2',
    stream: false,
    messages: [
      { role: 'user', content: 'Hallo' },
      { role: 'assistant', content: '' },
      { role: 'user', content: [{ type: 'text', text: 'Was ist das?' }, { type: 'image', dataUrl: `data:image/png;base64,${PNG_B64}` }] },
      { role: 'assistant', content: 'Vorgabe' },
    ],
  });
  const [call] = calls;
  assert.equal(call.url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(call.headers.has('authorization'), false);
  assert.deepEqual(call.body.messages, [
    { role: 'user', content: 'Hallo' },
    { role: 'user', content: [
      { type: 'text', text: 'Was ist das?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
    ] },
  ]);
});

test('text-only part arrays are sent as a plain string', async () => {
  const calls = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
  await streamChat({
    provider: provider('deepseek'), model: 'deepseek-v4-pro', stream: false,
    messages: userMsg([{ type: 'text', text: 'Teil 1' }, { type: 'text', text: 'Teil 2' }]),
  });
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'Teil 1\n\nTeil 2' }]);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
});

test('non-stream request returns content, reasoning and images; onText called once', async () => {
  const calls = mockFetch(() => jsonResponse('\n\n' + JSON.stringify({
    choices: [{ message: { content: 'Fertig', reasoning_content: 'Weil', images: [{ image_url: { url: `data:image/png;base64,${PNG_B64}` } }] }, finish_reason: 'length' }],
    usage: { prompt_tokens: 2, completion_tokens: 3 },
  })));
  const c = collector();
  const result = await streamChat({ provider: provider('openai'), model: 'gpt-6.1-sol', messages: userMsg('x'), stream: false, ...c });
  assert.equal(result.text, 'Fertig');
  assert.equal(result.reasoning, 'Weil');
  assert.equal(result.finishReason, 'length');
  assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  assert.equal(result.images.length, 1);
  assert.deepEqual(c.textCalls, [['Fertig', 'Fertig']]);
  assert.equal(calls[0].body.stream, false);
  assert.equal('stream_options' in calls[0].body, false);
});

test('stream requested but server answers with JSON → parsed as a normal response', async () => {
  mockFetch(() => jsonResponse({ choices: [{ message: { content: 'JSON statt SSE' }, finish_reason: 'stop' }] }));
  const result = await streamChat({ provider: provider('custom'), model: 'm', messages: userMsg('x') });
  assert.equal(result.text, 'JSON statt SSE');
});

test('Z.AI finish_reason "sensitive" appends a German note', async () => {
  mockFetch(() => sseResponse([
    { choices: [{ delta: { reasoning_content: 'r' } }] },
    { choices: [{ delta: { content: 'Halb' } }] },
    { choices: [{ delta: {}, finish_reason: 'sensitive' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    'data: [DONE]\n\n',
  ]));
  const c = collector();
  const result = await streamChat({ provider: provider('zai'), model: 'glm-5.3', messages: userMsg('x'), ...c });
  assert.equal(result.text, 'Halb\n\nDie Antwort wurde vom Inhaltsfilter des Anbieters gestoppt.');
  assert.equal(result.finishReason, 'content_filter');
  assertDeltasConsistent(c.textCalls, result.text);
});

test('max-tokens parameter and temperature per preset', async () => {
  const cases = [
    ['openai', 'gpt-6.1-sol', 'max_completion_tokens', false],
    ['xai', 'grok-4.3', 'max_completion_tokens', true],
    ['groq', 'llama-3.3-70b-versatile', 'max_completion_tokens', true],
    ['openrouter', 'z-ai/glm-5.3', 'max_tokens', true],
    ['openrouter', 'openai/gpt-6.1-sol', 'max_tokens', false],
    ['zai', 'glm-5.3', 'max_tokens', true],
    ['gemini', 'gemini-3.8-flash', 'max_tokens', false],
    ['mistral', 'mistral-large-4', 'max_tokens', true],
    ['deepseek', 'deepseek-v4-pro', 'max_tokens', true],
    ['ollama', 'llama3.2', 'max_tokens', true],
    ['lmstudio', 'qwen3', 'max_tokens', true],
    ['custom', 'my-model', 'max_tokens', true],
    ['custom', 'gpt-6.1-sol', 'max_completion_tokens', false],
  ];
  for (const [presetId, model, param, sendsTemperature] of cases) {
    const calls = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await streamChat({ provider: provider(presetId), model, messages: userMsg('x'), stream: false, maxTokens: 500, temperature: 0.5 });
    const body = calls[0].body;
    assert.equal(body[param], 500, `${presetId}/${model}: ${param}`);
    const other = param === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
    assert.equal(other in body, false, `${presetId}/${model}: no ${other}`);
    assert.equal('temperature' in body, sendsTemperature, `${presetId}/${model}: temperature`);
    for (const forbidden of ['stop', 'presence_penalty', 'frequency_penalty', 'top_p']) assert.equal(forbidden in body, false);
    restoreFetch();

    // Without explicit values nothing is sent.
    const calls2 = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await streamChat({ provider: provider(presetId), model, messages: userMsg('x'), stream: false });
    assert.equal('temperature' in calls2[0].body, false);
    assert.equal('max_tokens' in calls2[0].body || 'max_completion_tokens' in calls2[0].body, false);
    restoreFetch();
  }
  // Z.AI clamps temperature to 0..1, Mistral to 0..1.5.
  const calls = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
  await streamChat({ provider: provider('zai'), model: 'glm-5.3', messages: userMsg('x'), stream: false, temperature: 1.6 });
  assert.equal(calls[0].body.temperature, 1);
  await streamChat({ provider: provider('mistral'), model: 'mistral-large-4', messages: userMsg('x'), stream: false, temperature: 1.8 });
  assert.equal(calls[1].body.temperature, 1.5);
  await streamChat({ provider: provider('deepseek'), model: 'deepseek-v4-pro', messages: userMsg('x'), stream: false, temperature: 1.8 });
  assert.equal(calls[2].body.temperature, 1.8);
});

test('keyless presets (ollama, lmstudio, custom) never require a key, whatever the base URL', async () => {
  const calls = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
  for (const [presetId, baseUrl] of [['custom', 'https://api.openai.com/v1'], ['ollama', 'https://ollama.com/v1'], ['lmstudio', 'http://192.168.1.20:1234/v1']]) {
    const result = await streamChat({ provider: provider(presetId, { apiKey: '', baseUrl }), model: 'm', messages: userMsg('x'), stream: false });
    assert.equal(result.text, 'ok', presetId);
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => !c.headers.has('authorization')));
  // Built-in key presets still do, even behind a custom base URL.
  await expectLLMError(streamChat({ provider: provider('openai', { apiKey: '', baseUrl: 'https://llm.example.com/v1' }), model: 'm', messages: userMsg('x') }), 'no_key');
  // An explicit requiresKey (options page passes the preset's value) wins.
  await expectLLMError(streamChat({ provider: provider('custom', { apiKey: '', requiresKey: true }), model: 'm', messages: userMsg('x') }), 'no_key');
});

test('xAI/Gemini: WebP/GIF attachments are re-encoded as PNG (or rejected clearly without canvas support)', async () => {
  const WEBP = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=';
  const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const msgs = (b64, mime) => [{ role: 'user', content: [{ type: 'image', dataUrl: `data:${mime};base64,${b64}` }, { type: 'text', text: 'Was ist das?' }] }];
  let calls = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
  const err = await expectLLMError(streamChat({ provider: provider('xai'), model: 'grok-4.3', messages: msgs(WEBP, 'image/webp'), stream: false }), 'bad_request');
  assert.match(describeError(err), /xAI akzeptiert nur Bilder im Format JPEG oder PNG/);
  assert.equal(calls.length, 0);
  // Allowed formats pass through untouched; Gemini accepts WebP but not GIF; OpenAI takes all four.
  await streamChat({ provider: provider('xai'), model: 'grok-4.3', messages: msgs(PNG_B64, 'image/png'), stream: false });
  await streamChat({ provider: provider('gemini'), model: 'gemini-3.8-flash', messages: msgs(WEBP, 'image/webp'), stream: false });
  await streamChat({ provider: provider('openai'), model: 'gpt-6.1-sol', messages: msgs(GIF, 'image/gif'), stream: false });
  assert.deepEqual(calls.map((c) => c.body.messages[0].content[0].image_url.url.slice(0, 15)), ['data:image/png;', 'data:image/webp', 'data:image/gif;']);
  await expectLLMError(streamChat({ provider: provider('gemini'), model: 'gemini-3.8-flash', messages: msgs(GIF, 'image/gif'), stream: false }), 'bad_request');
  restoreFetch();

  // With canvas support (extension pages, service worker) the image is converted.
  const saved = { createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas };
  const drawn = [];
  globalThis.createImageBitmap = async (blob) => ({ width: 3, height: 2, type: blob.type, close() {} });
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.size = [w, h]; }
    getContext() { return { drawImage: (bmp) => drawn.push([bmp.type, ...this.size]) }; }
    async convertToBlob({ type }) { return new Blob([Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0))], { type }); }
  };
  try {
    calls = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    // A mislabeled file is judged by its bytes: "image/png" with WebP bytes is converted, too.
    await streamChat({ provider: provider('xai'), model: 'grok-4.3', messages: msgs(WEBP, 'image/png'), stream: false });
    assert.deepEqual(drawn, [['image/webp', 3, 2]]);
    assert.deepEqual(calls[0].body.messages[0].content[0], { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } });
  } finally {
    globalThis.createImageBitmap = saved.createImageBitmap;
    globalThis.OffscreenCanvas = saved.OffscreenCanvas;
  }
});

test('extra headers are added, invalid ones skipped', async () => {
  const calls = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
  await streamChat({
    provider: provider('custom', { extraHeaders: { 'X-Custom': 'eins', 'Bad Header': 'x', 'X-Empty': '' } }),
    model: 'm', messages: userMsg('x'), stream: false,
  });
  assert.equal(calls[0].headers.get('x-custom'), 'eins');
  assert.equal(calls[0].headers.has('x-empty'), false);
  assert.equal(calls[0].init.credentials, 'omit');
});

// ---------------------------------------------------------------------------
// streamChat – protocol anthropic
// ---------------------------------------------------------------------------

function anthropicEvents({ stopReason = 'end_turn' } = {}) {
  return [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', usage: { input_tokens: 12, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
    { event: 'ping', data: { type: 'ping' } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Ich denke ' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'nach.' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQB' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hallo ' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Welt ✓' } } },
    { event: 'some_future_event', data: { type: 'some_future_event' } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 42 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

test('Anthropic event stream: thinking + text + message_delta', async () => {
  for (const eol of ['\n', '\r\n']) {
    mockFetch(() => sseResponse(anthropicEvents(), { eol, sizes: [3, 1, 17] }));
    const c = collector();
    const result = await streamChat({ provider: provider('anthropic'), model: 'claude-sonnet-5-5', messages: userMsg('Hi'), ...c });
    assert.equal(result.text, 'Hallo Welt ✓');
    assert.equal(result.reasoning, 'Ich denke nach.');
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 42, totalTokens: 54 });
    assertDeltasConsistent(c.textCalls, result.text);
    assertDeltasConsistent(c.reasoningCalls, result.reasoning);
    restoreFetch();
  }
});

test('Anthropic refusal appends the German note', async () => {
  mockFetch(() => sseResponse(anthropicEvents({ stopReason: 'refusal' })));
  const result = await streamChat({ provider: provider('anthropic'), model: 'claude-opus-5-5', messages: userMsg('Hi') });
  assert.equal(result.text, 'Hallo Welt ✓\n\nDie Anfrage wurde vom Modell abgelehnt.');
  assert.equal(result.finishReason, 'refusal');
});

test('Anthropic error event mid-stream throws', async () => {
  mockFetch(() => sseResponse([
    anthropicEvents()[0],
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anfang' } } },
    { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
  ]));
  const err = await expectLLMError(streamChat({ provider: provider('anthropic'), model: 'claude-haiku-5-5', messages: userMsg('Hi') }), 'server');
  assert.equal(err.details, 'Overloaded');
  assert.equal(err.partial.text, 'Anfang');
});

test('Anthropic request shape: headers, no sampling params, merged roles, images first, thinking', async () => {
  const calls = mockFetch(() => sseResponse(anthropicEvents()));
  await streamChat({
    provider: provider('anthropic'),
    model: 'claude-sonnet-5-5',
    system: 'Sei nett.',
    temperature: 0.7,
    messages: [
      { role: 'assistant', content: 'Willkommen!' },
      { role: 'user', content: 'Erste Frage' },
      { role: 'user', content: [{ type: 'text', text: 'Was ist das?' }, { type: 'image', dataUrl: `data:image/png;base64,${PNG_B64}` }] },
      { role: 'assistant', content: 'Antwort A' },
      { role: 'assistant', content: [{ type: 'text', text: 'Antwort B' }, { type: 'image', dataUrl: `data:image/png;base64,${PNG_B64}` }] },
      { role: 'user', content: 'Danke' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'Prefill' },
    ],
  });
  const [call] = calls;
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.headers.get('x-api-key'), KEY);
  assert.equal(call.headers.get('anthropic-version'), '2023-06-01');
  assert.equal(call.headers.get('anthropic-dangerous-direct-browser-access'), 'true');
  assert.equal(call.headers.get('content-type'), 'application/json');
  assert.equal(call.headers.has('authorization'), false);
  assert.deepEqual(call.body, {
    model: 'claude-sonnet-5-5',
    max_tokens: 16000,
    stream: true,
    system: 'Sei nett.',
    thinking: { type: 'adaptive', display: 'summarized' },
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'Erste Frage' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
        { type: 'text', text: 'Was ist das?' },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'Antwort A' }, { type: 'text', text: 'Antwort B' }] },
      { role: 'user', content: 'Danke' },
    ],
  });
});

test('Anthropic: image media_type follows the bytes, not the declared MIME type', async () => {
  const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  const calls = mockFetch(() => sseResponse(anthropicEvents()));
  await streamChat({
    provider: provider('anthropic'),
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: [
      { type: 'image', dataUrl: `data:image/png;base64,${JPEG}` },
      { type: 'image', dataUrl: `data:image/jpg;base64,${JPEG}` },
      { type: 'text', text: 'Was ist das?' },
    ] }],
  });
  const images = calls[0].body.messages[0].content.filter((b) => b.type === 'image');
  assert.deepEqual(images.map((b) => b.source.media_type), ['image/jpeg', 'image/jpeg']);
  assert.equal(images[0].source.data, JPEG);
});

test('Anthropic: no thinking for older models, explicit max tokens, Bearer for compatible endpoints', async () => {
  const calls = mockFetch(() => sseResponse(anthropicEvents()));
  await streamChat({ provider: provider('anthropic'), model: 'claude-haiku-4-5-20251001', messages: userMsg('x'), maxTokens: 1234 });
  assert.equal('thinking' in calls[0].body, false);
  assert.equal(calls[0].body.max_tokens, 1234);
  restoreFetch();

  const calls2 = mockFetch(() => sseResponse(anthropicEvents()));
  await streamChat({
    provider: provider('custom', { protocol: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic' }),
    model: 'glm-5.3', messages: userMsg('x'),
  });
  assert.equal(calls2[0].url, 'https://api.z.ai/api/anthropic/messages');
  assert.equal(calls2[0].headers.get('x-api-key'), KEY);
  assert.equal(calls2[0].headers.get('authorization'), `Bearer ${KEY}`);
});

test('Anthropic: 400 mentioning thinking → one retry without the thinking field', async () => {
  const calls = mockFetch((call, i) => (i === 0
    ? jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking.type: adaptive thinking is not supported for this model' } }, 400)
    : sseResponse(anthropicEvents())));
  const result = await streamChat({ provider: provider('anthropic'), model: 'claude-fable-5-1', messages: userMsg('Hi') });
  assert.equal(result.text, 'Hallo Welt ✓');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal('thinking' in calls[1].body, false);
});

test('Anthropic: other 400 errors are not retried', async () => {
  const calls = mockFetch(() => jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } }, 400));
  const err = await expectLLMError(streamChat({ provider: provider('anthropic'), model: 'claude-sonnet-5-5', messages: userMsg('Hi') }), 'bad_request');
  assert.equal(calls.length, 1);
  assert.equal(err.details, 'prompt is too long');
});

test('Anthropic non-stream response', async () => {
  const calls = mockFetch(() => jsonResponse({
    id: 'msg', type: 'message', role: 'assistant',
    content: [{ type: 'thinking', thinking: 'Kurz', signature: 's' }, { type: 'text', text: 'OK' }],
    stop_reason: 'max_tokens', usage: { input_tokens: 5, output_tokens: 16 },
  }));
  const result = await streamChat({ provider: provider('anthropic'), model: 'claude-sonnet-5-5', messages: userMsg('x'), stream: false });
  assert.equal(result.text, 'OK');
  assert.equal(result.reasoning, 'Kurz');
  assert.equal(result.finishReason, 'length');
  assert.equal(calls[0].body.stream, false);
});

test('Anthropic: only assistant messages → bad_request without a request', async () => {
  const calls = mockFetch(() => jsonResponse({}));
  await expectLLMError(streamChat({
    provider: provider('anthropic'), model: 'claude-sonnet-5-5', messages: [{ role: 'assistant', content: 'x' }],
  }), 'bad_request');
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test('HTTP error mapping', async () => {
  const cases = [
    ['openai', 401, { error: { message: 'Incorrect API key provided: sk-test***ij.', type: 'invalid_request_error', code: 'invalid_api_key' } }, 'auth', /Incorrect API key/],
    ['xai', 400, { code: 'invalid-argument', error: 'Incorrect API key provided: xa***Qz. You can obtain an API key from https://console.x.ai.' }, 'auth', /Incorrect API key/],
    ['gemini', 400, [{ error: { code: 400, message: 'Please pass a valid API key', status: 'INVALID_ARGUMENT' } }], 'auth', /Please pass a valid API key/],
    ['openai', 429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } }, 'quota', /exceeded your current quota/],
    ['openai', 429, { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }, 'rate_limit', /Rate limit reached/],
    ['groq', 429, { error: { message: 'Rate limit reached for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 6000. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', type: 'tokens', code: 'rate_limit_exceeded' } }, 'rate_limit', /tokens per minute/],
    ['gemini', 429, [{ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' } }], 'rate_limit', /exceeded your current quota/],
    ['openrouter', 429, { error: { code: 429, message: 'Rate limit exceeded: free-models-per-min. Add credits to raise the limit.' } }, 'rate_limit', /free-models-per-min/],
    ['xai', 429, { code: 'Some resource has been exhausted', error: 'Your team has either used all available credits or reached its monthly spending limit.' }, 'quota', /used all available credits/],
    ['openai', 429, { error: { message: 'Too many requests. See https://platform.openai.com/account/billing for limits.' } }, 'rate_limit', /Too many requests/],
    ['zai', 429, { error: { code: '1113', message: 'Insufficient balance or no resource package. Please recharge.' } }, 'quota', /Insufficient balance/],
    ['zai', 429, { error: { code: '1302', message: 'High concurrency' } }, 'rate_limit', /High concurrency/],
    ['openrouter', 402, { error: { code: 402, message: 'Insufficient credits' } }, 'quota', /Insufficient credits/],
    ['anthropic', 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'server', /Overloaded/],
    ['anthropic', 403, { type: 'error', error: { type: 'permission_error', message: 'Not allowed' } }, 'forbidden', /Not allowed/],
    ['anthropic', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 'quota', /credit balance is too low/],
    ['anthropic', 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' }, request_id: 'req_1' }, 'auth', /invalid x-api-key/],
    ['openai', 404, { error: { message: 'The model `gpt-x` does not exist', code: 'model_not_found' } }, 'not_found', /does not exist/],
    ['mistral', 422, { detail: [{ loc: ['body', 'foo'], msg: 'Extra inputs are not permitted', type: 'extra_forbidden' }] }, 'bad_request', /Extra inputs/],
    ['groq', 413, { error: { message: 'Request too large' } }, 'bad_request', /Request too large/],
    ['deepseek', 500, '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>', 'server', /502 Bad Gateway/],
    ['openrouter', 400, { error: { code: 400, message: 'Provider returned error', metadata: { raw: '{"error":{"message":"Invalid image"}}' } } }, 'bad_request', /Provider returned error: Invalid image/],
  ];
  for (const [presetId, status, body, code, detailRe] of cases) {
    mockFetch(() => jsonResponse(body, status));
    const err = await expectLLMError(streamChat({ provider: provider(presetId), model: 'gpt-x', messages: userMsg('x') }), code);
    assert.equal(err.status, status);
    assert.match(err.details, detailRe, `${presetId} ${status}`);
    const text = describeError(err);
    assert.match(text, detailRe);
    assert.doesNotMatch(text, /\n/);
    restoreFetch();
  }
});

test('describeError adds provider-specific hints', async () => {
  mockFetch(() => new Response('', { status: 403 }));
  let err = await expectLLMError(streamChat({ provider: provider('ollama'), model: 'llama3', messages: userMsg('x') }), 'forbidden');
  assert.match(describeError(err), /OLLAMA_ORIGINS=chrome-extension:\/\/\*,moz-extension:\/\/\*/);
  restoreFetch();

  mockFetch(() => jsonResponse({ error: { code: 403, message: 'Your API key was reported as leaked.', status: 'PERMISSION_DENIED' } }, 403));
  err = await expectLLMError(streamChat({ provider: provider('gemini'), model: 'gemini-3.8-flash', messages: userMsg('x') }), 'forbidden');
  assert.match(describeError(err), /AI Studio/);
  restoreFetch();

  mockFetch(() => jsonResponse({ error: { code: '1113', message: 'Insufficient balance' } }, 429));
  err = await expectLLMError(streamChat({ provider: provider('zai'), model: 'glm-5.3', messages: userMsg('x') }), 'quota');
  assert.match(describeError(err), /Coding Plan/);
  restoreFetch();

  mockFetch(() => jsonResponse({ error: { code: '1001', message: 'Authorization failed' } }, 401));
  err = await expectLLMError(streamChat({
    provider: provider('zai', { baseUrl: 'https://api.z.ai/api/coding/paas/v4' }), model: 'glm-5.3', messages: userMsg('x'),
  }), 'auth');
  assert.match(describeError(err), /Coding-Plan-Endpunkt/);
  restoreFetch();

  mockFetch(() => {
    throw new TypeError('Failed to fetch');
  });
  err = await expectLLMError(streamChat({ provider: provider('lmstudio'), model: 'qwen', messages: userMsg('x') }), 'network');
  assert.match(describeError(err), /CORS aktivieren/);
  err = await expectLLMError(streamChat({ provider: provider('ollama'), model: 'qwen', messages: userMsg('x') }), 'network');
  assert.match(describeError(err), /OLLAMA_ORIGINS/);
  err = await expectLLMError(streamChat({ provider: provider('openai'), model: 'gpt-6.1-sol', messages: userMsg('x') }), 'network');
  assert.match(describeError(err), /^Keine Verbindung zu OpenAI möglich\./);
  restoreFetch();
});

test('error details never contain the API key and are truncated in describeError', async () => {
  const longTail = 'x'.repeat(1000);
  mockFetch(() => jsonResponse({ error: { message: `Key ${KEY} is invalid. ${longTail}` } }, 401));
  const err = await expectLLMError(streamChat({ provider: provider('custom'), model: 'm', messages: userMsg('x') }), 'auth');
  assert.equal(err.details.includes(KEY), false);
  assert.equal(JSON.stringify(err).includes(KEY), false);
  const text = describeError(err);
  assert.equal(text.includes(KEY), false);
  assert.ok(text.length < 600, `too long: ${text.length}`);
  assert.equal(JSON.stringify(err.provider), JSON.stringify({ id: 'custom-abc', presetId: 'custom', name: 'Mein Proxy', baseUrl: 'https://llm.example.com/v1' }));
});

test('validation errors: no_provider, no_key, missing model', async () => {
  const calls = mockFetch(() => jsonResponse({}));
  await expectLLMError(streamChat({ provider: null, model: 'x', messages: userMsg('x') }), 'no_provider');
  await expectLLMError(streamChat({ provider: provider('openai', { baseUrl: '' }), model: 'x', messages: userMsg('x') }), 'no_provider');
  const noKey = await expectLLMError(streamChat({ provider: provider('openai', { apiKey: '' }), model: 'x', messages: userMsg('x') }), 'no_key');
  assert.match(describeError(noKey), /Für OpenAI ist kein API-Schlüssel hinterlegt/);
  await expectLLMError(streamChat({ provider: provider('openai'), model: '', messages: userMsg('x') }), 'bad_request');
  await expectLLMError(streamChat({ provider: provider('openai'), model: 'm', messages: [] }), 'bad_request');
  assert.equal(calls.length, 0);
  assert.equal(describeError(new LLMError('no_provider')), 'Kein KI-Anbieter eingerichtet. Hinterlege in den Einstellungen einen Anbieter mit API-Schlüssel.');
});

test('describeError for non-LLM errors', () => {
  assert.equal(describeError(new DOMException('x', 'AbortError')), 'Abgebrochen.');
  assert.match(describeError(new TypeError('Failed to fetch')), /Keine Verbindung/);
  assert.equal(describeError('Eigener Text'), 'Eigener Text');
  assert.equal(describeError(null), 'Unbekannter Fehler.');
  assert.equal(describeError(new Error('Kaputt')), 'Kaputt.');
  assert.equal(describeError({ code: 'quota', message: 'Kontingent leer.' }), 'Kontingent leer.');
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

test('abort before the request → aborted, no fetch', async () => {
  const calls = mockFetch(() => jsonResponse({}));
  const controller = new AbortController();
  controller.abort();
  const err = await expectLLMError(streamChat({ provider: provider('openai'), model: 'm', messages: userMsg('x'), signal: controller.signal }), 'aborted');
  assert.equal(describeError(err), 'Abgebrochen.');
  assert.equal(calls.length, 0);
});

test('abort during fetch → aborted', async () => {
  const controller = new AbortController();
  mockFetch((call) => new Promise((resolve, reject) => {
    call.init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  }));
  setTimeout(() => controller.abort(), 5);
  await expectLLMError(streamChat({ provider: provider('openai'), model: 'm', messages: userMsg('x'), signal: controller.signal }), 'aborted');
});

test('abort mid-stream → aborted with partial text', async () => {
  const controller = new AbortController();
  let cancelled = false;
  mockFetch(() => {
    let sent = false;
    const body = new ReadableStream({
      pull(c) {
        if (sent) return new Promise(() => {});
        sent = true;
        c.enqueue(enc.encode(sseText([{ choices: [{ delta: { content: 'Bis hier' } }] }])));
        return undefined;
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  const err = await expectLLMError(streamChat({
    provider: provider('openai'), model: 'gpt-6.1-sol', messages: userMsg('x'), signal: controller.signal,
    onText: () => setTimeout(() => controller.abort(), 5),
  }), 'aborted');
  assert.equal(err.partial.text, 'Bis hier');
  assert.equal(cancelled, true);
});

test('abort mid-stream for Anthropic', async () => {
  const controller = new AbortController();
  mockFetch(() => {
    let sent = false;
    return new Response(new ReadableStream({
      pull(c) {
        if (sent) return new Promise(() => {});
        sent = true;
        c.enqueue(enc.encode(sseText(anthropicEvents().slice(7, 9))));
        return undefined;
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const err = await expectLLMError(streamChat({
    provider: provider('anthropic'), model: 'claude-sonnet-5-5', messages: userMsg('x'), signal: controller.signal,
    onText: () => controller.abort(),
  }), 'aborted');
  assert.equal(err.partial.text, 'Hallo ');
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

test('generateImage: OpenAI gpt-image body has no response_format; mime from output_format', async () => {
  const calls = mockFetch(() => jsonResponse({ created: 1, data: [{ b64_json: PNG_B64 }], output_format: 'webp' }));
  const result = await generateImage({ provider: provider('openai'), model: 'gpt-image-2.5-flare', prompt: 'Ein Fuchs', size: '1536x1024' });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations');
  assert.deepEqual(calls[0].body, { model: 'gpt-image-2.5-flare', prompt: 'Ein Fuchs', n: 1, size: '1536x1024' });
  assert.deepEqual(result, { images: [{ src: `data:image/webp;base64,${PNG_B64}` }] });
});

test('generateImage: custom provider with gpt-image model uses the OpenAI body', async () => {
  const calls = mockFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  const result = await generateImage({ provider: provider('custom'), model: 'gpt-image-2', prompt: 'x', size: 'auto' });
  assert.deepEqual(calls[0].body, { model: 'gpt-image-2', prompt: 'x', n: 1, size: 'auto' });
  assert.equal(result.images[0].src, `data:image/png;base64,${PNG_B64}`);
});

test('generateImage: xAI uses aspect_ratio and b64_json, no size', async () => {
  const sizes = { '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3', auto: 'auto' };
  for (const [size, ratio] of Object.entries(sizes)) {
    const calls = mockFetch(() => jsonResponse({ data: [{ url: null, b64_json: '/9j/4AAQSkZJRg==', mime_type: 'image/jpeg', revised_prompt: 'Ein roter Fuchs' }] }));
    const result = await generateImage({ provider: provider('xai'), model: 'grok-imagine-image-2.0', prompt: 'Fuchs', size });
    assert.deepEqual(calls[0].body, { model: 'grok-imagine-image-2.0', prompt: 'Fuchs', n: 1, response_format: 'b64_json', aspect_ratio: ratio });
    assert.deepEqual(result.images, [{ src: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', revisedPrompt: 'Ein roter Fuchs' }]);
    restoreFetch();
  }
});

test('generateImage: Gemini body with size and response_format', async () => {
  const calls = mockFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  await generateImage({ provider: provider('gemini'), model: 'gemini-3.1-flash-image', prompt: 'Berg' });
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/images/generations');
  assert.deepEqual(calls[0].body, { model: 'gemini-3.1-flash-image', prompt: 'Berg', n: 1, size: '1024x1024', response_format: 'b64_json' });
});

test('generateImage: Z.AI size mapping and temporary URL converted to a data URL', async () => {
  const pngBytes = Uint8Array.from(Buffer.from(PNG_B64, 'base64'));
  const calls = mockFetch((call) => {
    if (call.url.startsWith('https://cdn.example-zai.com/')) {
      return new Response(new Blob([pngBytes], { type: 'image/png' }), { status: 200 });
    }
    return jsonResponse({ created: 1, data: [{ url: 'https://cdn.example-zai.com/img/abc.png' }], content_filter: [{ role: 'assistant', level: 3 }] });
  });
  const result = await generateImage({ provider: provider('zai'), model: 'glm-image', prompt: 'Stadt', size: '1536x1024' });
  assert.deepEqual(calls[0].body, { model: 'glm-image', prompt: 'Stadt', size: '1568x1056' });
  assert.equal(calls[1].url, 'https://cdn.example-zai.com/img/abc.png');
  assert.equal(calls[1].headers.has('authorization'), false, 'never send the key to the image host');
  assert.deepEqual(result.images, [{ src: `data:image/png;base64,${PNG_B64}` }]);

  for (const [size, mapped] of [['1024x1024', '1280x1280'], ['1024x1536', '1056x1568']]) {
    restoreFetch();
    const c2 = mockFetch((call) => (call.url.includes('cdn') ? new Response('nope', { status: 404 }) : jsonResponse({ data: [{ url: 'https://cdn.example-zai.com/x.png' }] })));
    const r2 = await generateImage({ provider: provider('zai'), model: 'glm-image', prompt: 'x', size });
    assert.equal(c2[0].body.size, mapped);
    assert.deepEqual(r2.images, [{ src: 'https://cdn.example-zai.com/x.png' }], 'falls back to the URL');
  }
});

test('generateImage: large binary is base64-encoded correctly in chunks', async () => {
  const bytes = new Uint8Array(100003);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) % 256;
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  mockFetch((call) => (call.url.includes('cdn')
    ? new Response(new Blob([bytes]), { status: 200 }) // no content type → sniffed
    : jsonResponse({ data: [{ url: 'https://cdn.example.com/big' }] })));
  const result = await generateImage({ provider: provider('custom'), model: 'flux-pro', prompt: 'x' });
  const expected = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  assert.ok(result.images[0].src === expected, `unexpected src: ${result.images[0].src.slice(0, 80)}…`);
});

test('generateImage: OpenRouter /images route', async () => {
  const calls = mockFetch(() => jsonResponse({ created: 1, data: [{ b64_json: '/9j/abc=', media_type: 'image/jpeg' }] }));
  const result = await generateImage({ provider: provider('openrouter'), model: 'black-forest-labs/flux-3-image', prompt: 'See' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/images');
  assert.deepEqual(calls[0].body, { model: 'black-forest-labs/flux-3-image', prompt: 'See', n: 1, aspect_ratio: '1:1' });
  assert.equal(calls[0].headers.get('x-title'), 'LLM Sidebar');
  assert.deepEqual(result, { images: [{ src: 'data:image/jpeg;base64,/9j/abc=' }] });
});

test('generateImage: OpenRouter falls back to chat completions with modalities', async () => {
  const calls = mockFetch((call) => (call.url.endsWith('/images')
    ? jsonResponse({ error: { code: 404, message: 'Not found' } }, 404)
    : jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Hier ist dein Bild.', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }] } }] })));
  const result = await generateImage({ provider: provider('openrouter'), model: 'google/gemini-3.1-flash-image', prompt: 'Wald', size: '1536x1024' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, { model: 'google/gemini-3.1-flash-image', prompt: 'Wald', n: 1, aspect_ratio: '3:2' });
  assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.deepEqual(calls[1].body, {
    model: 'google/gemini-3.1-flash-image',
    messages: [{ role: 'user', content: 'Wald' }],
    modalities: ['image', 'text'],
    stream: false,
    image_config: { aspect_ratio: '3:2' },
  });
  assert.deepEqual(result, { images: [{ src: `data:image/png;base64,${PNG_B64}` }], text: 'Hier ist dein Bild.' });
});

test('generateImage: OpenRouter fallback without image → parse error with model text', async () => {
  mockFetch((call) => (call.url.endsWith('/images')
    ? jsonResponse({ error: { message: 'Method not allowed' } }, 405)
    : jsonResponse({ choices: [{ message: { content: 'Das kann ich nicht zeichnen.' } }] })));
  const err = await expectLLMError(generateImage({ provider: provider('openrouter'), model: 'x/y', prompt: 'p' }), 'parse');
  assert.match(describeError(err), /Das kann ich nicht zeichnen/);
});

test('generateImage: unsupported providers and validation', async () => {
  const calls = mockFetch(() => jsonResponse({}));
  await expectLLMError(generateImage({ provider: provider('anthropic'), model: 'claude-sonnet-5-5', prompt: 'x' }), 'unsupported');
  await expectLLMError(generateImage({ provider: provider('mistral'), model: 'm', prompt: 'x' }), 'unsupported');
  await expectLLMError(generateImage({ provider: provider('openai'), model: '', prompt: 'x' }), 'bad_request');
  await expectLLMError(generateImage({ provider: provider('openai'), model: 'gpt-image-2', prompt: '  ' }), 'bad_request');
  await expectLLMError(generateImage({ provider: provider('openai', { apiKey: '' }), model: 'gpt-image-2', prompt: 'x' }), 'no_key');
  assert.equal(calls.length, 0);
});

test('generateImage: error responses are mapped', async () => {
  mockFetch(() => jsonResponse({ error: { message: 'Your organization must be verified to use the model `gpt-image-2.5-flare`.', type: 'invalid_request_error' } }, 403));
  const err = await expectLLMError(generateImage({ provider: provider('openai'), model: 'gpt-image-2.5-flare', prompt: 'x' }), 'forbidden');
  assert.match(describeError(err), /must be verified/);
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

test('listModels: OpenAI filters retired and non-chat models, flags image models', async () => {
  const calls = mockFetch(() => jsonResponse({
    object: 'list',
    data: [
      { id: 'gpt-6.1-sol', object: 'model', created: 1, owned_by: 'system', shutdown_date: null },
      { id: 'gpt-5', shutdown_date: '2020-01-01' },
      { id: 'gpt-6-luna', shutdown_date: '2999-01-01' },
      { id: 'text-embedding-3-large' },
      { id: 'gpt-image-2.5-flare' },
      { id: 'tts-1' },
      { id: 'whisper-1' },
      { id: 'sora-2' },
      { id: 'gpt-realtime' },
      { id: 'omni-moderation-latest' },
      { id: 'gpt-6.1-sol' },
    ],
  }));
  const models = await listModels(provider('openai'));
  assert.deepEqual(models, [
    { id: 'gpt-6-luna' },
    { id: 'gpt-6.1-sol' },
    { id: 'gpt-image-2.5-flare', imageOutput: true },
  ]);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${KEY}`);
  assert.equal(calls[0].headers.has('content-type'), false);
});

test('listModels: Gemini strips the models/ prefix', async () => {
  mockFetch(() => jsonResponse({
    object: 'list',
    data: [
      { id: 'models/gemini-3.8-flash', object: 'model', owned_by: 'google' },
      { id: 'models/gemini-embedding-001' },
      { id: 'models/gemini-3.1-flash-image' },
      { id: 'models/veo-4-video' },
      { id: 'models/veo-3.0-generate-001' },
      { id: 'models/imagen-4.0-generate-001' },
      { id: 'models/gemini-2.5-flash-preview-tts' },
    ],
  }));
  const models = await listModels(provider('gemini'));
  assert.deepEqual(models, [
    { id: 'gemini-3.1-flash-image', imageOutput: true },
    { id: 'gemini-3.8-flash' },
    { id: 'imagen-4.0-generate-001', imageOutput: true },
  ]);
});

test('listModels: OpenRouter modalities, context length and image list (works without key)', async () => {
  const calls = mockFetch((call) => {
    if (call.url.endsWith('/models?output_modalities=image')) {
      return jsonResponse({ data: [
        { id: 'google/gemini-3.1-flash-image', name: 'Google: Nano Banana 2', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image', 'text'] } },
        { id: 'black-forest-labs/flux-3-image', name: 'FLUX 3', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
      ] });
    }
    return jsonResponse({ data: [
      { id: 'openai/gpt-6.1-sol', name: 'OpenAI: GPT-6.1 Sol', context_length: 1050000, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'] } },
      { id: 'google/gemini-3.1-flash-image', name: 'Google: Nano Banana 2', context_length: 65536, architecture: { input_modalities: ['text', 'image'], output_modalities: ['image', 'text'] } },
      { id: 'old/model', expiration_date: '2020-05-01' },
      { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', top_provider: { context_length: 1000000 }, architecture: { modality: 'text->text' } },
    ] });
  });
  const models = await listModels(provider('openrouter', { apiKey: '' }));
  assert.deepEqual(models, [
    { id: 'black-forest-labs/flux-3-image', name: 'FLUX 3', imageOutput: true },
    { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextLength: 1000000 },
    { id: 'google/gemini-3.1-flash-image', name: 'Google: Nano Banana 2', vision: true, imageOutput: true, contextLength: 65536 },
    { id: 'openai/gpt-6.1-sol', name: 'OpenAI: GPT-6.1 Sol', vision: true, contextLength: 1050000 },
  ]);
  assert.deepEqual(calls.map((c) => c.url).sort(), [
    'https://openrouter.ai/api/v1/models',
    'https://openrouter.ai/api/v1/models?output_modalities=image',
  ]);
  assert.equal(calls[0].headers.has('authorization'), false);
});

test('listModels: Anthropic pagination, display_name and capabilities', async () => {
  const calls = mockFetch((call) => {
    if (call.url.includes('after_id=')) {
      return jsonResponse({ data: [
        { type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', capabilities: { image_input: true } },
        { type: 'model', id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', retires_at: '2020-11-30T00:00:00Z' },
      ], has_more: false, first_id: 'claude-haiku-5-5', last_id: 'claude-sonnet-4-5' });
    }
    return jsonResponse({ data: [
      { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', max_input_tokens: 1000000, capabilities: { image_input: { supported: true } } },
    ], has_more: true, first_id: 'claude-sonnet-5-5', last_id: 'claude-sonnet-5-5' });
  });
  const models = await listModels(provider('anthropic'));
  assert.deepEqual(models, [
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', vision: true },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', vision: true, contextLength: 1000000 },
  ]);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(calls[1].url, 'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-sonnet-5-5');
  assert.equal(calls[0].headers.get('x-api-key'), KEY);
  assert.equal(calls[0].headers.get('anthropic-version'), '2023-06-01');
  assert.equal(calls[0].headers.get('anthropic-dangerous-direct-browser-access'), 'true');
});

test('listModels: xAI vision enrichment via /language-models, failures ignored', async () => {
  mockFetch((call) => {
    if (call.url.endsWith('/language-models')) {
      return jsonResponse({ models: [
        { id: 'grok-4.7', aliases: ['grok-4.7-latest'], input_modalities: ['text', 'image'], output_modalities: ['text'] },
        { id: 'grok-4.3', input_modalities: ['text'], output_modalities: ['text'] },
      ] });
    }
    if (call.url.endsWith('/image-generation-models')) return jsonResponse({ error: 'boom' }, 500);
    return jsonResponse({ object: 'list', data: [
      { id: 'grok-4.3', object: 'model', owned_by: 'xai' },
      { id: 'grok-4.7-latest', object: 'model', owned_by: 'xai' },
      { id: 'grok-4.7', object: 'model', owned_by: 'xai' },
      { id: 'grok-imagine-image-2.0', object: 'model' },
      { id: 'grok-imagine-video', object: 'model' },
    ] });
  });
  const models = await listModels(provider('xai'));
  assert.deepEqual(models, [
    { id: 'grok-4.3' },
    { id: 'grok-4.7', vision: true },
    { id: 'grok-4.7-latest', vision: true },
    { id: 'grok-imagine-image-2.0', imageOutput: true },
  ]);
  restoreFetch();

  mockFetch((call) => (call.url.endsWith('/models') ? jsonResponse({ data: [{ id: 'grok-4.3' }] }) : new Response('', { status: 404 })));
  assert.deepEqual(await listModels(provider('xai')), [{ id: 'grok-4.3' }]);
});

test('listModels: Mistral capabilities (vision, non-chat)', async () => {
  mockFetch(() => jsonResponse({ object: 'list', data: [
    { id: 'mistral-large-4', name: 'mistral-large-4', capabilities: { completion_chat: true, vision: true }, max_context_length: 1000000 },
    { id: 'mistral-ocr-latest', capabilities: { completion_chat: false, ocr: true } },
    { id: 'mistral-embed', capabilities: { completion_chat: false } },
  ] }));
  assert.deepEqual(await listModels(provider('mistral')), [{ id: 'mistral-large-4', vision: true, contextLength: 1000000 }]);
});

test('Ollama Cloud: key required, Bearer auth, chat via /v1/chat/completions with usage', async () => {
  await expectLLMError(streamChat({ provider: provider('ollama-cloud', { apiKey: '' }), model: 'gpt-oss:120b', messages: userMsg('x') }), 'no_key');
  const calls = mockFetch(() => sseResponse([
    { choices: [{ index: 0, delta: { content: 'Hallo' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    'data: [DONE]\n\n',
  ]));
  const result = await streamChat({ provider: provider('ollama-cloud'), model: 'gpt-oss:120b', messages: userMsg('Frage') });
  assert.equal(result.text, 'Hallo');
  assert.equal(calls[0].url, 'https://ollama.com/v1/chat/completions');
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${KEY}`);
  assert.deepEqual(calls[0].body.stream_options, { include_usage: true });
});

test('listModels: Ollama Cloud uses /api/tags, falls back to /v1/models, URL alone selects it', async () => {
  let calls = mockFetch(() => jsonResponse({ models: [
    { name: 'gpt-oss:120b', model: 'gpt-oss:120b', size: 65000000000 },
    { name: 'gemma4:31b', model: 'gemma4:31b' },
    { name: 'nomic-embed-text', model: 'nomic-embed-text' },
  ] }));
  assert.deepEqual(await listModels(provider('ollama-cloud')), [{ id: 'gemma4:31b' }, { id: 'gpt-oss:120b' }]);
  assert.equal(calls[0].url, 'https://ollama.com/api/tags');
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${KEY}`);
  restoreFetch();

  calls = mockFetch((call) => (call.url.endsWith('/api/tags')
    ? jsonResponse({ error: 'not found' }, 404)
    : jsonResponse({ object: 'list', data: [{ id: 'kimi-k2.6', object: 'model', owned_by: 'library' }] })));
  assert.deepEqual(await listModels(provider('ollama-cloud')), [{ id: 'kimi-k2.6' }]);
  assert.deepEqual(calls.map((c) => c.url), ['https://ollama.com/api/tags', 'https://ollama.com/v1/models']);
  restoreFetch();

  // An own provider pointed at ollama.com lists its models the same way.
  calls = mockFetch(() => jsonResponse({ models: [{ name: 'glm-5.3' }] }));
  assert.deepEqual(await listModels(provider('custom', { baseUrl: 'https://ollama.com/v1/' })), [{ id: 'glm-5.3' }]);
  assert.equal(calls[0].url, 'https://ollama.com/api/tags');
});

test('Ollama Cloud: a rejected key points to ollama.com/settings/keys', async () => {
  mockFetch(() => jsonResponse({ error: 'unauthorized' }, 401));
  const err = await expectLLMError(listModels(provider('ollama-cloud')), 'auth');
  assert.match(describeError(err), /ollama\.com\/settings\/keys/);
});

test('listModels: errors are mapped and keys are required', async () => {
  const calls = mockFetch(() => jsonResponse({ error: { message: 'bad key' } }, 401));
  await expectLLMError(listModels(provider('openai')), 'auth');
  await expectLLMError(listModels(provider('openai', { apiKey: '' })), 'no_key');
  assert.equal(calls.length, 1);
  restoreFetch();
  mockFetch(() => jsonResponse({ foo: 'bar' }));
  await expectLLMError(listModels(provider('custom')), 'parse');
});

test('model id helpers', () => {
  assert.equal(isImageModelId('gpt-image-2.5-flare'), true);
  assert.equal(isImageModelId('google/gemini-3.1-flash-image'), true);
  assert.equal(isImageModelId('grok-imagine-video'), false);
  assert.equal(isImageModelId('gpt-6.1-sol'), false);
  assert.equal(isImageModelId('imagen-4.0-generate-001'), true);
  assert.equal(isImageModelId('veo-3.0-generate-001'), false);
  assert.equal(isNonChatModelId('text-embedding-3-small'), true);
  assert.equal(isNonChatModelId('veo-3.0-generate-001'), true);
  assert.equal(isNonChatModelId('gpt-6.1-sol'), false);
});

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

test('testConnection: model list success', async () => {
  mockFetch(() => jsonResponse({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }] }));
  const result = await testConnection(provider('openai'));
  assert.equal(result.ok, true);
  assert.match(result.message, /Verbindung zu OpenAI erfolgreich – 2 Modelle gefunden/);
  assert.deepEqual(result.models.map((m) => m.id), ['gpt-6-luna', 'gpt-6.1-sol']);
});

test('testConnection: /models 404 → tiny chat request', async () => {
  const calls = mockFetch((call) => (call.method === 'GET'
    ? jsonResponse({ error: { message: 'Not Found' } }, 404)
    : jsonResponse({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })));
  const result = await testConnection(provider('zai', { defaultModel: 'glm-5.3' }));
  assert.equal(result.ok, true);
  assert.match(result.message, /glm-5\.3/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.z.ai/api/paas/v4/chat/completions');
  assert.deepEqual(calls[1].body, {
    model: 'glm-5.3',
    messages: [{ role: 'user', content: 'Antworte nur mit OK' }],
    stream: false,
    max_tokens: 16,
  });
});

test('testConnection: supportsModelList false + Anthropic → chat without thinking', async () => {
  const calls = mockFetch(() => jsonResponse({ type: 'message', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
  const result = await testConnection(provider('anthropic', { supportsModelList: false, defaultModel: 'claude-sonnet-5-5' }));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.max_tokens, 16);
  assert.equal('thinking' in calls[0].body, false);
});

test('testConnection: failures return ok:false with German message', async () => {
  mockFetch(() => jsonResponse({ error: { message: 'Incorrect API key provided' } }, 401));
  let result = await testConnection(provider('openai'));
  assert.equal(result.ok, false);
  assert.match(result.message, /API-Schlüssel wurde von OpenAI abgelehnt/);
  restoreFetch();

  result = await testConnection(provider('openai', { apiKey: '' }));
  assert.deepEqual(result, { ok: false, message: 'Für OpenAI ist kein API-Schlüssel hinterlegt. Trage ihn in den Einstellungen ein.' });

  // OpenRouter lists models without a key, so the key is verified via /key first.
  const calls = mockFetch((call) => (call.url.endsWith('/key')
    ? jsonResponse({ error: { code: 401, message: 'User not found.' } }, 401)
    : jsonResponse({ data: [{ id: 'openai/gpt-6.1-sol' }] })));
  result = await testConnection(provider('openrouter'));
  assert.equal(result.ok, false);
  assert.match(result.message, /abgelehnt/);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/key');
  restoreFetch();

  mockFetch(() => jsonResponse({ error: { message: 'nope' } }, 404));
  result = await testConnection(provider('custom'));
  assert.equal(result.ok, false);
  assert.match(result.message, /Modell/);
});

test('error messages and hints follow the UI language', () => {
  const provider = { id: 'ollama', presetId: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1' };
  registerCatalog('en', en);
  setLanguage('en');
  try {
    assert.equal(describeError(new DOMException('x', 'AbortError')), 'Stopped.');
    assert.equal(describeError(null), 'Unknown error.');
    assert.equal(
      describeError(new LLMError('auth', '', { status: 401, provider: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' } })),
      'OpenAI rejected the API key (HTTP 401). Check it in the settings.',
    );
    const network = describeError(new LLMError('network', '', { provider }));
    assert.match(network, /^Could not connect to Ollama\. Is Ollama running\? If so: Ollama blocks requests/);
    assert.equal(
      describeError(new LLMError('bad_request', '', { status: 400, details: 'bad model', provider: { name: 'X', baseUrl: 'https://x.test' } })),
      'X rejected the request (HTTP 400). Provider message: “bad model”',
    );
  } finally {
    setLanguage('de');
  }
  assert.equal(describeError(new LLMError('network', '', { provider })).startsWith('Keine Verbindung zu Ollama möglich. Läuft Ollama?'), true);
});
