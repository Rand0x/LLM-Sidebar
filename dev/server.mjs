#!/usr/bin/env node
// Zero-dependency dev server: serves /src/** and /dev/** (with the ext shim injected into every
// HTML page) and mock LLM APIs (OpenAI-compatible at /mock/v1, Anthropic at /mock-anthropic/v1).
//
//   node dev/server.mjs            → http://localhost:8787  (PORT / HOST env vars override)
//
// Mock triggers in the last user message: "denk" → reasoning first, lines starting with "[[n]] text"
// → segment mode, "Antworte nur mit OK" → "OK", "#fehler<status>" (e.g. #fehler429) → HTTP error,
// "#fehlerstream" → error in the middle of the stream, "#ablehnen" → refusal, "#langsam" → 3 s delay,
// "#abschneiden" → cut-off answer (finish reason length / max_tokens). A max_tokens /
// max_completion_tokens value smaller than the answer also cuts it off.

import { createReadStream, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodePng } from '../scripts/make-icons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 8787;
export const SHIM_TAG = '<script src="/dev/ext-shim.js"></script>';
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const CHUNK_DELAY_MS = 20;
// Mirrors the MV3 extension-page CSP (report-only: violations are logged in the console, nothing is blocked).
const EXTENSION_PAGE_CSP = "script-src 'self'; object-src 'self'";

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const randomId = (prefix) => prefix + randomBytes(9).toString('base64url');
const estimateTokens = (text) => Math.max(1, Math.ceil(String(text ?? '').length / 4));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Inserts the shim <script> right after <head> (fallback: after <html>, after the doctype, at the start). */
export function injectShim(html, tag = SHIM_TAG) {
  const text = String(html ?? '');
  if (text.includes(tag)) return text;
  const insertAfter = (match) => text.slice(0, match.index + match[0].length) + tag + text.slice(match.index + match[0].length);
  const head = /<head(?:\s[^>]*)?>/i.exec(text);
  if (head) return insertAfter(head);
  const htmlTag = /<html(?:\s[^>]*)?>/i.exec(text);
  if (htmlTag) return insertAfter(htmlTag);
  const doctype = /^﻿?\s*<!doctype[^>]*>/i.exec(text);
  if (doctype) return insertAfter(doctype);
  return tag + text;
}

/** Splits text into chunks of min..max characters (code-point safe). */
export function chunkText(text, min = 3, max = 8) {
  const chars = Array.from(String(text ?? ''));
  const out = [];
  for (let i = 0; i < chars.length;) {
    const n = min + Math.floor(Math.random() * (max - min + 1));
    out.push(chars.slice(i, i + n).join(''));
    i += n;
  }
  return out;
}

function truncateOneLine(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && (part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function countImages(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part && ['image_url', 'image', 'input_image'].includes(part.type)).length;
}

function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i];
  }
  return null;
}

const ERROR_MESSAGES = {
  400: 'Invalid request (Mock).',
  401: 'Incorrect API key provided (Mock).',
  402: 'Insufficient credits (Mock).',
  403: 'Access denied (Mock).',
  404: 'The model does not exist (Mock).',
  413: 'Request too large (Mock).',
  429: 'Rate limit reached, please try again later (Mock).',
  500: 'Internal server error (Mock).',
  503: 'Service unavailable (Mock).',
  529: 'Overloaded (Mock).',
};

// Segment lines of a page-translation batch. Only markers at a line start count, so a prompt header
// that merely mentions markers ("Gib [[1]] bis [[3]] aus") is not mistaken for segments.
const SEGMENT_LINE_RE = /^[ \t]*\[\[(\d+)\]\][ \t]*(.*)$/gm;

function cutOff(text, maxChars) {
  const chars = Array.from(text);
  return chars.length > maxChars ? chars.slice(0, Math.max(1, maxChars)).join('').trimEnd() : text;
}

/**
 * Builds the mock answer for the last user text.
 * → { text, reasoning, errorStatus?, midStreamError, refusal, slow, truncated }
 * `maxTokens` (the request's max_tokens) cuts the answer off like a real model (≈ 4 chars/token).
 */
export function mockReply(userText, { images = 0, model = '', messageCount = 0, systemChars = 0, maxTokens = null } = {}) {
  const text = String(userText ?? '');
  const reply = {
    text: '',
    reasoning: '',
    errorStatus: null,
    midStreamError: /#fehlerstream/i.test(text),
    refusal: /#ablehnen/i.test(text),
    slow: /#langsam/i.test(text),
    truncated: false,
  };
  const errorMatch = /#fehler(\d{3})\b/i.exec(text);
  if (errorMatch) {
    reply.errorStatus = Number(errorMatch[1]);
    return reply;
  }
  if (/denk/i.test(text)) {
    reply.reasoning = [
      'Okay, ich denke kurz darüber nach.',
      `Die Anfrage lautet: „${truncateOneLine(text, 60)}“.`,
      'Ich sammle die wichtigsten Punkte, prüfe sie und formuliere dann eine knappe Antwort mit einem kleinen Beispiel.',
    ].join(' ');
  }
  if (reply.refusal) {
    reply.text = 'Dabei kann ich leider nicht helfen.';
    return reply;
  }
  const finish = (answer) => {
    reply.text = answer;
    if (/#abschneiden/i.test(text)) {
      reply.text = cutOff(answer, Math.ceil(Array.from(answer).length / 2));
      reply.truncated = true;
    }
    const limit = Number(maxTokens);
    if (Number.isInteger(limit) && limit > 0 && estimateTokens(reply.text) > limit) {
      reply.text = cutOff(reply.text, limit * 4);
      reply.truncated = true;
    }
    return reply;
  };
  if (/antworte nur mit ok/i.test(text)) return finish('OK');
  const segments = [...text.matchAll(SEGMENT_LINE_RE)];
  if (segments.length) return finish(segments.map((m) => `[[${m[1]}]] [DE] ${m[2].trim()}`).join('\n'));

  const stats = [`Modell: \`${model || 'unbekannt'}\``, `Nachrichten: ${messageCount}`, `System-Prompt: ${systemChars} Zeichen`];
  if (images) stats.push(`${images} ${images === 1 ? 'Bild' : 'Bilder'} empfangen`);
  return finish([
    `**Mock-Antwort** auf: ${truncateOneLine(text, 80) || '(leer)'}`,
    '',
    'Das ist eine simulierte Antwort des lokalen Mock-Servers:',
    '',
    '- Punkt eins mit **fett** und *kursiv*',
    '- Punkt zwei mit `Inline-Code`',
    '- Punkt drei als Abschluss',
    '',
    '```js',
    'function hallo(name) {',
    '  return `Hallo, ${name}!`;',
    '}',
    "console.log(hallo('Welt'));",
    '```',
    '',
    `_${stats.join(' · ')}_`,
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// Image generation (256×256 gradient PNG)
// ---------------------------------------------------------------------------

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export function generateMockImage(prompt, variant = 0, size = 256) {
  const hue = (hashString(String(prompt)) + variant * 97) % 360;
  const c1 = hslToRgb(hue, 0.75, 0.62);
  const c2 = hslToRgb((hue + 70) % 360, 0.7, 0.42);
  const px = new Uint8Array(size * size * 4);
  const sunX = size * 0.68;
  const sunY = size * 0.32;
  const sunR = size * 0.16;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * (size - 1));
      let r = c1[0] + (c2[0] - c1[0]) * t;
      let g = c1[1] + (c2[1] - c1[1]) * t;
      let b = c1[2] + (c2[2] - c1[2]) * t;
      const d = Math.hypot(x + 0.5 - sunX, y + 0.5 - sunY);
      const glow = Math.max(0, Math.min(1, (sunR - d) + 0.5)) * 0.85 + Math.max(0, 1 - d / (sunR * 2.2)) * 0.15;
      r += (255 - r) * glow;
      g += (255 - g) * glow;
      b += (255 - b) * glow;
      const i = (y * size + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return encodePng(size, size, px);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers']
      || 'Authorization, Content-Type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access, anthropic-beta, HTTP-Referer, X-Title',
  );
  res.setHeader('Access-Control-Expose-Headers', 'request-id, x-request-id');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(res, status, obj, headers = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(String(text));
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'Request body too large (Mock).'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.length) throw new HttpError(400, 'Request body is empty – JSON expected.');
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

// Tracks whether the client went away (stream aborted).
function watchClose(res) {
  const state = { closed: false };
  res.on('close', () => {
    if (!res.writableFinished) state.closed = true;
  });
  return state;
}

async function waitAbortable(ms, state) {
  const end = Date.now() + ms;
  while (!state.closed && Date.now() < end) await sleep(Math.min(100, end - Date.now()));
}

function startSse(req, res, headers = {}) {
  req.socket?.setNoDelay?.(true);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...headers,
  });
  res.flushHeaders?.();
}

// ---------------------------------------------------------------------------
// Mock: OpenAI-compatible (/mock/v1)
// ---------------------------------------------------------------------------

const OPENAI_MODELS = ['mock-chat', 'mock-reasoner', 'mock-image'];
const DISCOURAGED_PARAMS = ['temperature', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty'];

function openaiError(res, status, message, { type, code } = {}) {
  const errType = type ?? (status === 401 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error');
  sendJson(res, status, { error: { message, type: errType, param: null, code: code ?? (status === 401 ? 'invalid_api_key' : null) } });
}

function checkOpenAiAuth(req, res) {
  const auth = String(req.headers.authorization ?? '');
  if (/^Bearer\s+(invalid|falsch)$/i.test(auth)) {
    openaiError(res, 401, ERROR_MESSAGES[401]);
    return false;
  }
  return true;
}

function handleOpenAiModels(req, res) {
  if (!checkOpenAiAuth(req, res)) return;
  const created = nowSec() - 86400;
  sendJson(res, 200, {
    object: 'list',
    data: OPENAI_MODELS.map((id) => ({ id, object: 'model', created, owned_by: 'llm-sidebar-mock' })),
  });
}

async function handleOpenAiChat(req, res, ctx) {
  if (!checkOpenAiAuth(req, res)) return;
  const body = await readJsonBody(req);
  if (!body.model) return openaiError(res, 400, 'You must provide a model parameter.');
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return openaiError(res, 400, "'messages' must be a non-empty array.");
  }
  const discouraged = DISCOURAGED_PARAMS.filter((p) => body[p] !== undefined && body[p] !== null);
  if (discouraged.length) ctx.log(`  Hinweis: Anfrage enthält Sampling-/Stop-Parameter: ${discouraged.join(', ')}`);

  const user = lastUserMessage(body.messages);
  const system = body.messages.filter((m) => m?.role === 'system' || m?.role === 'developer').map((m) => contentText(m.content)).join('\n');
  const reply = mockReply(contentText(user?.content), {
    images: countImages(user?.content),
    model: body.model,
    messageCount: body.messages.filter((m) => m?.role !== 'system' && m?.role !== 'developer').length,
    systemChars: system.length,
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
  });
  if (reply.errorStatus) return openaiError(res, reply.errorStatus, ERROR_MESSAGES[reply.errorStatus] ?? `Mock error ${reply.errorStatus}.`);

  const state = watchClose(res);
  if (reply.slow) await waitAbortable(3000, state);
  if (state.closed) return;

  const id = randomId('chatcmpl-mock');
  const created = nowSec();
  const finishReason = reply.refusal ? 'content_filter' : reply.truncated ? 'length' : 'stop';
  const usage = {
    prompt_tokens: estimateTokens(JSON.stringify(body.messages)),
    completion_tokens: estimateTokens(reply.text + reply.reasoning),
  };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

  if (body.stream !== true) {
    await waitAbortable(150, state);
    if (state.closed) return;
    const message = { role: 'assistant', content: reply.text };
    if (reply.reasoning) message.reasoning_content = reply.reasoning;
    return sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: body.model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    });
  }

  startSse(req, res);
  const base = { id, object: 'chat.completion.chunk', created, model: body.model, system_fingerprint: 'fp_mock' };
  const send = (obj) => {
    if (!state.closed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  for (const part of chunkText(reply.reasoning)) {
    if (state.closed) break;
    send({ ...base, choices: [{ index: 0, delta: { reasoning_content: part }, finish_reason: null }] });
    await sleep(CHUNK_DELAY_MS);
  }
  const parts = chunkText(reply.text);
  for (let i = 0; i < parts.length; i++) {
    if (state.closed) break;
    if (reply.midStreamError && i === Math.min(3, parts.length - 1)) {
      send({ ...base, error: { message: 'Mock-Fehler mitten im Stream.', code: 502 }, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] });
      res.end();
      return;
    }
    send({ ...base, choices: [{ index: 0, delta: { content: parts[i] }, finish_reason: null }] });
    await sleep(CHUNK_DELAY_MS);
  }
  if (state.closed) {
    ctx.log('  Client hat den Stream abgebrochen.');
    return;
  }
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
  if (body.stream_options?.include_usage) send({ ...base, choices: [], usage });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleOpenAiImages(req, res) {
  if (!checkOpenAiAuth(req, res)) return;
  const body = await readJsonBody(req);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return openaiError(res, 400, "'prompt' is required.");
  const reply = mockReply(prompt);
  if (reply.errorStatus) return openaiError(res, reply.errorStatus, ERROR_MESSAGES[reply.errorStatus] ?? `Mock error ${reply.errorStatus}.`);
  const n = Math.max(1, Math.min(4, Number.parseInt(body.n, 10) || 1));
  const state = watchClose(res);
  await waitAbortable(reply.slow ? 3000 : 300, state);
  if (state.closed) return;
  const data = [];
  for (let i = 0; i < n; i++) {
    data.push({ b64_json: generateMockImage(prompt, i).toString('base64'), revised_prompt: prompt });
  }
  sendJson(res, 200, { created: nowSec(), data, output_format: 'png', size: '256x256' });
}

// ---------------------------------------------------------------------------
// Mock: Anthropic (/mock-anthropic/v1)
// ---------------------------------------------------------------------------

const ANTHROPIC_MODELS = [
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5 (Mock)', vision: true, thinking: true },
  { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5 (Mock)', vision: true, thinking: true },
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5 (Mock)', vision: true, thinking: true },
  { id: 'mock-claude-nothink', display_name: 'Mock-Claude ohne Thinking', vision: false, thinking: false },
];

const ANTHROPIC_ERROR_TYPES = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'billing_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  529: 'overloaded_error',
};

function anthropicError(res, status, message) {
  const requestId = randomId('req_mock_');
  sendJson(
    res,
    status,
    { type: 'error', error: { type: ANTHROPIC_ERROR_TYPES[status] ?? (status >= 500 ? 'api_error' : 'invalid_request_error'), message }, request_id: requestId },
    { 'request-id': requestId },
  );
}

function checkAnthropicAuth(req, res) {
  const key = String(req.headers['x-api-key'] ?? '').trim();
  if (!key) {
    anthropicError(res, 401, 'x-api-key header is required');
    return false;
  }
  if (/^(invalid|falsch)$/i.test(key)) {
    anthropicError(res, 401, 'invalid x-api-key');
    return false;
  }
  return true;
}

function handleAnthropicModels(req, res, url) {
  if (!checkAnthropicAuth(req, res)) return;
  const limit = Math.max(1, Math.min(1000, Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20));
  const data = ANTHROPIC_MODELS.slice(0, limit).map((m, i) => ({
    type: 'model',
    id: m.id,
    display_name: m.display_name,
    created_at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
    lifecycle: 'active',
    max_input_tokens: 1000000,
    max_tokens: 128000,
    capabilities: {
      image_input: m.vision,
      pdf_input: m.vision,
      thinking: { types: { adaptive: m.thinking, enabled: false, disabled: !m.thinking } },
    },
  }));
  sendJson(res, 200, { data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: data.length < ANTHROPIC_MODELS.length });
}

async function handleAnthropicMessages(req, res, ctx) {
  if (!checkAnthropicAuth(req, res)) return;
  if (!req.headers['anthropic-version']) return anthropicError(res, 400, 'anthropic-version: header is required');
  const body = await readJsonBody(req);
  if (!body.model) return anthropicError(res, 400, 'model: Field required');
  if (typeof body.max_tokens !== 'number') return anthropicError(res, 400, 'max_tokens: Field required');
  if (!Array.isArray(body.messages) || body.messages.length === 0) return anthropicError(res, 400, 'messages: at least one message is required');
  const badRole = body.messages.findIndex((m) => !['user', 'assistant', 'system'].includes(m?.role));
  if (badRole >= 0) return anthropicError(res, 400, `messages.${badRole}.role: Input should be 'user' or 'assistant'`);
  const convo = body.messages.filter((m) => m.role !== 'system');
  if (convo.at(-1)?.role !== 'user') {
    return anthropicError(res, 400, 'This model does not support assistant message prefill. The conversation must end with a user message.');
  }
  if (body.thinking && /nothink/i.test(body.model)) {
    return anthropicError(res, 400, 'thinking: this model does not support extended thinking (Mock).');
  }
  const discouraged = ['temperature', 'top_p', 'top_k'].filter((p) => body[p] !== undefined && body[p] !== null);
  if (discouraged.length) ctx.log(`  Hinweis: Anfrage enthält Sampling-Parameter: ${discouraged.join(', ')}`);

  const user = lastUserMessage(convo);
  const systemText = typeof body.system === 'string' ? body.system : contentText(body.system);
  const reply = mockReply(contentText(user?.content), {
    images: countImages(user?.content),
    model: body.model,
    messageCount: convo.length,
    systemChars: systemText.length,
    maxTokens: body.max_tokens,
  });
  if (reply.errorStatus) return anthropicError(res, reply.errorStatus, ERROR_MESSAGES[reply.errorStatus] ?? `Mock error ${reply.errorStatus}.`);

  const state = watchClose(res);
  if (reply.slow) await waitAbortable(3000, state);
  if (state.closed) return;

  const id = randomId('msg_mock_');
  const signature = randomBytes(48).toString('base64');
  const stopReason = reply.refusal ? 'refusal' : reply.truncated ? 'max_tokens' : 'end_turn';
  const inputTokens = estimateTokens(JSON.stringify(body.messages) + systemText);
  const outputTokens = estimateTokens(reply.text + reply.reasoning);
  const requestId = randomId('req_mock_');

  if (body.stream !== true) {
    await waitAbortable(150, state);
    if (state.closed) return;
    const content = [];
    if (reply.reasoning) content.push({ type: 'thinking', thinking: reply.reasoning, signature });
    content.push({ type: 'text', text: reply.text });
    return sendJson(res, 200, {
      id,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: reply.refusal ? { type: 'refusal', category: null, explanation: 'Mock-Ablehnung.' } : null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }, { 'request-id': requestId });
  }

  startSse(req, res, { 'request-id': requestId });
  const send = (event, data) => {
    if (!state.closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model: body.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  });
  send('ping', { type: 'ping' });

  let index = 0;
  if (reply.reasoning) {
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    for (const part of chunkText(reply.reasoning)) {
      if (state.closed) break;
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: part } });
      await sleep(CHUNK_DELAY_MS);
    }
    send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } });
    send('content_block_stop', { type: 'content_block_stop', index });
    index++;
  }

  send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
  const parts = chunkText(reply.text);
  for (let i = 0; i < parts.length; i++) {
    if (state.closed) break;
    if (reply.midStreamError && i === Math.min(3, parts.length - 1)) {
      send('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded (Mock-Fehler mitten im Stream)' } });
      res.end();
      return;
    }
    send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: parts[i] } });
    await sleep(CHUNK_DELAY_MS);
  }
  if (state.closed) {
    ctx.log('  Client hat den Stream abgebrochen.');
    return;
  }
  send('content_block_stop', { type: 'content_block_stop', index });
  const delta = { stop_reason: stopReason, stop_sequence: null };
  if (reply.refusal) delta.stop_details = { type: 'refusal', category: null, explanation: 'Mock-Ablehnung.' };
  send('message_delta', { type: 'message_delta', delta, usage: { output_tokens: outputTokens } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function resolveStaticPath(rootDir, pathname) {
  const match = /^\/(src|dev)(\/.*)?$/.exec(pathname);
  if (!match) return null;
  const baseDir = path.join(rootDir, match[1]);
  const rel = (match[2] ?? '/').slice(1);
  const segments = rel.split('/').filter((s) => s !== '');
  for (const seg of segments) {
    if (seg === '..' || seg === '.' || seg.startsWith('.') || /[\\:\0]/.test(seg)) throw new HttpError(403, 'Zugriff verweigert.');
  }
  const abs = path.resolve(baseDir, ...segments);
  if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) throw new HttpError(403, 'Zugriff verweigert.');
  return { abs, isSrc: match[1] === 'src' };
}

async function serveStatic(req, res, pathname, rootDir) {
  const resolved = resolveStaticPath(rootDir, pathname);
  if (!resolved) return sendText(res, 404, `Nicht gefunden: ${pathname}\nStartseite: /dev/harness.html`);
  let { abs } = resolved;
  let st = await fs.stat(abs).catch(() => null);
  if (st?.isDirectory()) {
    abs = path.join(abs, 'index.html');
    st = await fs.stat(abs).catch(() => null);
  }
  if (!st?.isFile()) return sendText(res, 404, `Nicht gefunden: ${pathname}`);

  const ext = path.extname(abs).toLowerCase();
  const type = MIME_TYPES[ext] ?? 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

  if (ext === '.html' || ext === '.htm') {
    const html = injectShim(await fs.readFile(abs, 'utf8'));
    const body = Buffer.from(html, 'utf8');
    if (resolved.isSrc) headers['Content-Security-Policy-Report-Only'] = EXTENSION_PAGE_CSP;
    res.writeHead(200, { ...headers, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await new Promise((resolve) => {
    const stream = createReadStream(abs);
    stream.on('error', () => {
      res.destroy();
      resolve();
    });
    stream.on('end', resolve);
    res.on('close', () => {
      stream.destroy();
      resolve();
    });
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Creates the request handler (exported for tests). */
export function createRequestHandler({ rootDir = ROOT, log = console.log } = {}) {
  return async function handle(req, res) {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendText(res, 400, 'Ungültige URL.');
      return;
    }
    const rawPath = url.pathname;
    res.on('close', () => {
      const status = res.writableFinished ? res.statusCode : `${res.statusCode}, abgebrochen`;
      log(`${req.method} ${rawPath} → ${status} (${Date.now() - started} ms)`);
    });

    const isOpenAi = rawPath.startsWith('/mock/');
    const isAnthropic = rawPath.startsWith('/mock-anthropic/');
    const ctx = { log };

    try {
      if (isOpenAi || isAnthropic) {
        setCors(req, res);
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Cache-Control': 'no-store', 'Content-Length': 0 });
          res.end();
          return;
        }
        const route = `${req.method} ${rawPath.replace(/\/+$/, '')}`;
        switch (route) {
          case 'GET /mock/v1/models': return handleOpenAiModels(req, res);
          case 'POST /mock/v1/chat/completions': return await handleOpenAiChat(req, res, ctx);
          case 'POST /mock/v1/images/generations': return await handleOpenAiImages(req, res);
          case 'GET /mock-anthropic/v1/models': return handleAnthropicModels(req, res, url);
          case 'POST /mock-anthropic/v1/messages': return await handleAnthropicMessages(req, res, ctx);
          default: {
            const known = ['/mock/v1/models', '/mock/v1/chat/completions', '/mock/v1/images/generations', '/mock-anthropic/v1/models', '/mock-anthropic/v1/messages'];
            const status = known.includes(rawPath.replace(/\/+$/, '')) ? 405 : 404;
            const message = status === 405 ? `Method ${req.method} not allowed (Mock).` : `Unknown mock route ${rawPath}.`;
            return isAnthropic ? anthropicError(res, status, message) : openaiError(res, status, message);
          }
        }
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, { Allow: 'GET, HEAD, OPTIONS', 'Content-Length': 0 });
        res.end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Methode nicht erlaubt.', { Allow: 'GET, HEAD' });
        return;
      }
      if (rawPath === '/') {
        res.writeHead(302, { Location: `/dev/harness.html${url.search}`, 'Cache-Control': 'no-store', 'Content-Length': 0 });
        res.end();
        return;
      }
      if (rawPath === '/favicon.ico') {
        const icon = path.join(rootDir, 'src', 'icons', 'icon-32.png');
        const data = await fs.readFile(icon).catch(() => null);
        if (!data) {
          res.writeHead(204, { 'Cache-Control': 'no-store', 'Content-Length': 0 });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : data);
        return;
      }
      let pathname;
      try {
        pathname = decodeURIComponent(rawPath);
      } catch {
        sendText(res, 400, 'Ungültige URL-Kodierung.');
        return;
      }
      await serveStatic(req, res, pathname, rootDir);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`  Fehler: ${err?.stack ?? err}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = err instanceof HttpError ? err.message : 'Interner Fehler im Dev-Server.';
      if (isAnthropic) anthropicError(res, status, message);
      else if (isOpenAi) openaiError(res, status, message);
      else sendText(res, status, message);
    }
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Starts the dev server. Without `host` it binds loopback only (127.0.0.1 and, if available, ::1).
 * → { port, servers, close(): Promise<void> }
 */
export async function startDevServer({ port = DEFAULT_PORT, host, rootDir = ROOT, quiet = false } = {}) {
  const log = quiet ? () => {} : (msg) => console.log(msg);
  const handler = createRequestHandler({ rootDir, log });
  const servers = [];
  const make = () => {
    const server = http.createServer((req, res) => {
      handler(req, res).catch((err) => {
        log(`  Fehler: ${err?.stack ?? err}`);
        if (!res.headersSent) sendText(res, 500, 'Interner Fehler im Dev-Server.');
        else res.destroy();
      });
    });
    server.keepAliveTimeout = 5000;
    servers.push(server);
    return server;
  };

  let boundPort;
  if (host) {
    boundPort = await listen(make(), port, host);
  } else {
    boundPort = await listen(make(), port, '127.0.0.1');
    const v6 = make();
    try {
      await listen(v6, boundPort, '::1');
    } catch {
      servers.pop(); // no IPv6 loopback – fine
    }
  }

  const close = () => Promise.all(servers.map((s) => new Promise((resolve) => {
    s.close(() => resolve());
    s.closeAllConnections?.();
  }))).then(() => undefined);
  return { port: boundPort, servers, close };
}

function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  if (metaUrl === pathToFileURL(path.resolve(entry)).href) return true;
  try {
    const a = realpathSync(fileURLToPath(metaUrl));
    const b = realpathSync(path.resolve(entry));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

async function main() {
  const rawPort = process.env.PORT;
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Ungültiger PORT „${rawPort}“ – erwartet wird eine Zahl zwischen 0 und 65535.`);
    process.exitCode = 1;
    return;
  }
  let server;
  try {
    server = await startDevServer({ port, host: process.env.HOST || undefined });
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      console.error(`Port ${port} ist schon belegt. Beende den anderen Prozess oder starte mit einem anderen Port, z. B. PORT=8790 node dev/server.mjs`);
    } else {
      console.error(`Dev-Server konnte nicht starten: ${err?.message ?? err}`);
    }
    process.exitCode = 1;
    return;
  }
  const base = `http://localhost:${server.port}`;
  console.log([
    'LLM Sidebar – Dev-Server läuft',
    `  Harness:        ${base}/dev/harness.html   (?reset=1 setzt den Shim-Speicher zurück)`,
    `  Optionen:       ${base}/src/options/options.html`,
    `  Mock OpenAI:    ${base}/mock/v1`,
    `  Mock Anthropic: ${base}/mock-anthropic/v1`,
    'Beenden mit Strg+C.',
    '',
  ].join('\n'));
  const shutdown = () => {
    console.log('\nDev-Server wird beendet …');
    server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (isMainModule(import.meta.url)) {
  main();
}
