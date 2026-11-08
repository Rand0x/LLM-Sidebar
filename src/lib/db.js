// IndexedDB chat storage (ARCHITECTURE §4.4, §5 lib/db.js).

import { uid, normalizeQuote } from './utils.js';
import { cleanUsage } from './usage.js';
import { t } from './i18n.js';

const DB_NAME = 'llm-sidebar';
const DB_VERSION = 1;
const STORE = 'chats';
const CHANNEL_NAME = 'llm-sidebar-chats';
const EXPORT_FORMAT = 'llm-sidebar-chats';

/** Title of a chat without one ("Neuer Chat"), in the UI language. */
export function defaultChatTitle() {
  return t('core.chat.defaultTitle');
}

let dbPromise = null;

// ---------- change notifications (side panels, options page) ----------

const HAS_CHANNEL = typeof BroadcastChannel === 'function';
let sender = null;
// Subscribers without a BroadcastChannel (unsupported or failed) are called directly.
const localListeners = new Set();

function openChannel() {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.unref?.(); // Node only: an open channel must not keep the process alive
  return channel;
}

// A BroadcastChannel never receives its own messages, so the separate sender object also
// reaches subscribers in this page.
function broadcast(event) {
  for (const listener of [...localListeners]) queueMicrotask(() => listener(event));
  if (!HAS_CHANNEL) return;
  try {
    sender ??= openChannel();
    sender.postMessage(event);
  } catch (err) {
    console.warn('[LLM Sidebar] Could not broadcast a chat change:', err);
  }
}

/**
 * Calls cb({ type: 'saved', id, updatedAt } | { type: 'deleted', id } | { type: 'cleared' }
 * | { type: 'imported', count }) after every write in any extension page, this one included.
 * Returns an unsubscribe function.
 */
export function onChatsChanged(cb) {
  if (typeof cb !== 'function') return () => {};
  const deliver = (event) => {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
    try {
      cb(event);
    } catch (err) {
      console.error('[LLM Sidebar] onChatsChanged callback failed:', err);
    }
  };
  if (HAS_CHANNEL) {
    try {
      const receiver = openChannel();
      receiver.onmessage = (e) => deliver(e.data);
      return () => receiver.close();
    } catch {
      // fall back to same-page delivery
    }
  }
  localListeners.add(deliver);
  return () => localListeners.delete(deliver);
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error(t('core.db.unavailable')));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE)
        ? request.transaction.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: 'id' });
      if (!store.indexNames.contains('updatedAt')) store.createIndex('updatedAt', 'updatedAt');
    };
    request.onsuccess = () => {
      const db = request.result;
      // Let other pages upgrade/delete the DB; reopen lazily on next use.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      console.warn('[LLM Sidebar] The chat database is blocked by another tab.');
    };
  }).catch((err) => {
    dbPromise = null;
    throw new Error(t('core.db.openFailed', { error: err?.message || err }));
  });
  return dbPromise;
}

// Runs `work(store)` in one transaction; resolves with its return value (an IDBRequest's
// result is read after completion) once the transaction has committed.
async function withStore(mode, work, retried = false) {
  const db = await openDb();
  let tx;
  try {
    tx = db.transaction(STORE, mode);
  } catch (err) {
    // Connection was closed underneath us (e.g. versionchange) – reopen once.
    if (!retried && err?.name === 'InvalidStateError') {
      dbPromise = null;
      return withStore(mode, work, true);
    }
    throw err;
  }
  return new Promise((resolve, reject) => {
    let outcome;
    tx.oncomplete = () => resolve(outcome instanceof IDBRequest ? outcome.result : outcome);
    tx.onerror = () => reject(tx.error ?? new Error(t('core.db.error')));
    tx.onabort = () => reject(tx.error ?? new Error(t('core.db.aborted')));
    try {
      outcome = work(tx.objectStore(STORE));
    } catch (err) {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      reject(err);
    }
  });
}

function putRecord(store, record) {
  try {
    return store.put(record);
  } catch (err) {
    // Non-cloneable values (functions, DOM nodes, proxies) → retry with a plain JSON copy.
    if (err?.name === 'DataCloneError') return store.put(JSON.parse(JSON.stringify(record)));
    throw err;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const strOr = (v, fallback) => (typeof v === 'string' ? v : fallback);
const strOrNull = (v) => (typeof v === 'string' && v ? v : null);

function sortChats(chats) {
  return chats.sort((a, b) => (Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
    || (num(b.updatedAt, 0) - num(a.updatedAt, 0)));
}

export function createMessage(partial = {}) {
  const src = partial && typeof partial === 'object' ? partial : {};
  const message = {
    id: uid('msg-'),
    role: 'user',
    kind: 'chat',
    content: '',
    context: null,
    page: null,
    quote: null, // { text, title, url, truncated? } – text selected on a page, referenced by this message
    attachments: [],
    images: [],
    reasoning: '',
    providerId: null,
    model: null,
    error: null,
    createdAt: Date.now(),
  };
  for (const [key, value] of Object.entries(src)) {
    if (value !== undefined) message[key] = value;
  }
  if (typeof message.id !== 'string' || !message.id) message.id = uid('msg-');
  if (message.role !== 'user' && message.role !== 'assistant') message.role = 'user';
  if (message.kind !== 'chat' && message.kind !== 'image') message.kind = 'chat';
  if (typeof message.content !== 'string') message.content = message.content == null ? '' : String(message.content);
  if (typeof message.context !== 'string' || !message.context) message.context = null;
  if (!message.page || typeof message.page !== 'object') message.page = null;
  message.quote = normalizeQuote(message.quote);
  // Renderers rely on object entries (images with a string src).
  message.attachments = Array.isArray(message.attachments) ? message.attachments.filter(isObj) : [];
  message.images = Array.isArray(message.images)
    ? message.images.filter((img) => isObj(img) && typeof img.src === 'string' && img.src)
    : [];
  if (typeof message.reasoning !== 'string') message.reasoning = '';
  message.providerId = strOrNull(message.providerId);
  message.model = strOrNull(message.model);
  if (typeof message.error !== 'string' || !message.error) message.error = null;
  message.createdAt = num(message.createdAt, Date.now());
  if (message.usage !== undefined) {
    const usage = cleanUsage(message.usage);
    if (usage) message.usage = usage;
    else delete message.usage;
  }
  return message;
}

export function createChat(partial = {}) {
  const src = partial && typeof partial === 'object' ? partial : {};
  const now = Date.now();
  const chat = {
    id: uid('chat-'),
    title: defaultChatTitle(),
    createdAt: now,
    updatedAt: now,
    pinned: false,
    providerId: null,
    model: null,
    personaId: 'default',
    messages: [],
  };
  for (const [key, value] of Object.entries(src)) {
    if (value !== undefined) chat[key] = value;
  }
  if (typeof chat.id !== 'string' || !chat.id) chat.id = uid('chat-');
  chat.title = strOr(chat.title, '').trim() || defaultChatTitle();
  chat.createdAt = num(chat.createdAt, now);
  chat.updatedAt = num(chat.updatedAt, chat.createdAt);
  chat.pinned = chat.pinned === true;
  chat.providerId = strOrNull(chat.providerId);
  chat.model = strOrNull(chat.model);
  chat.personaId = strOr(chat.personaId, '') || 'default';
  chat.messages = Array.isArray(chat.messages)
    ? chat.messages.filter((m) => m && typeof m === 'object').map((m) => createMessage(m))
    : [];
  return chat;
}

export async function listChats() {
  const chats = await withStore('readonly', (store) => store.getAll());
  return sortChats(Array.isArray(chats) ? chats : []);
}

export async function getChat(id) {
  if (typeof id !== 'string' || !id) return null;
  const chat = await withStore('readonly', (store) => store.get(id));
  return chat ?? null;
}

// Mutates and returns `chat` (updatedAt is refreshed unless keepTime is set).
export async function saveChat(chat, { keepTime = false } = {}) {
  if (!chat || typeof chat !== 'object') throw new Error(t('core.db.invalidChat'));
  if (typeof chat.id !== 'string' || !chat.id) chat.id = uid('chat-');
  if (!Number.isFinite(chat.createdAt)) chat.createdAt = Date.now();
  if (!keepTime || !Number.isFinite(chat.updatedAt)) chat.updatedAt = Date.now();
  if (!Array.isArray(chat.messages)) chat.messages = [];
  await withStore('readwrite', (store) => putRecord(store, chat));
  broadcast({ type: 'saved', id: chat.id, updatedAt: chat.updatedAt });
  return chat;
}

export async function deleteChat(id) {
  if (typeof id !== 'string' || !id) return;
  await withStore('readwrite', (store) => store.delete(id));
  broadcast({ type: 'deleted', id });
}

export async function clearChats() {
  await withStore('readwrite', (store) => store.clear());
  broadcast({ type: 'cleared' });
}

export async function exportChats() {
  return listChats();
}

// ---------- export / import format ----------

/** The one chat export format (side panel and options page). */
export function serializeChatsExport(chats) {
  const list = Array.isArray(chats) ? chats : [];
  return { format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), count: list.length, chats: list };
}

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]*$/i;
const safeImageSrc = (src, { remote = false } = {}) => typeof src === 'string'
  && (IMAGE_DATA_URL.test(src) || (remote && /^https:\/\/[^\s]+$/i.test(src)));
const plainText = (v) => (typeof v === 'string' ? v : '');

// Imported files are untrusted: only raster data URLs (and https for generated images) survive,
// and hidden page context is kept only together with its visible page reference.
function sanitizeImportedChat(raw) {
  if (!isObj(raw) || !Array.isArray(raw.messages)) return null;
  const chat = createChat(raw);
  for (const msg of chat.messages) {
    msg.images = msg.images
      .filter((img) => safeImageSrc(img.src, { remote: true }))
      .map((img) => ({ src: img.src, prompt: plainText(img.prompt) }));
    msg.attachments = msg.attachments
      .filter((a) => safeImageSrc(a.dataUrl))
      .map((a) => ({ type: 'image', dataUrl: a.dataUrl, name: plainText(a.name), mimeType: a.dataUrl.slice(5, a.dataUrl.indexOf(';')) }));
    const page = msg.page && { title: plainText(msg.page.title), url: plainText(msg.page.url) };
    msg.page = page && (page.title || page.url) ? page : null;
    if (!msg.page) msg.context = null;
  }
  return chat;
}

/**
 * Parses a chat export (JSON text or parsed value): the export format or a plain array.
 * → sanitized chats (malformed entries dropped); throws an Error (UI language) for anything else.
 */
export function parseChatsImport(json) {
  let data = json;
  if (typeof json === 'string') {
    if (!json.trim()) throw new Error(t('core.import.empty'));
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error(t('core.import.invalidJson'));
    }
  }
  let list = null;
  if (Array.isArray(data)) list = data;
  else if (isObj(data) && Array.isArray(data.chats) && (data.format === undefined || data.format === EXPORT_FORMAT)) list = data.chats;
  if (!list) {
    if (isObj(data) && (data.format === 'llm-sidebar-settings' || isObj(data.settings) || Array.isArray(data.providers))) {
      throw new Error(t('core.import.settingsFile'));
    }
    throw new Error(t('core.import.notChats'));
  }
  return list.map(sanitizeImportedChat).filter(Boolean);
}

/** Stores chats from parseChatsImport (or anything it accepts); same ids are overwritten. */
export async function importChats(input) {
  const records = parseChatsImport(input);
  if (!records.length) return 0;
  await withStore('readwrite', (store) => {
    for (const record of records) putRecord(store, record);
  });
  broadcast({ type: 'imported', count: records.length });
  return records.length;
}
