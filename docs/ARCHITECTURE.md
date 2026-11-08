# LLM Sidebar – Architecture & Module Contracts

This document is the single source of truth for every module. Implementers MUST follow the
file layout, exported names, function signatures, message types and data shapes below exactly,
because modules are written in parallel by different people. If something is missing, choose the
simplest option that is consistent with this document and note it in a `// NOTE:` comment.

## 0. Product summary

A cross-browser (Chrome ≥ 116, Firefox ≥ 142) Manifest V3 extension: an AI sidebar with
**bring-your-own API key** and **freely selectable providers** (OpenAI, Anthropic/Claude, xAI/Grok,
OpenRouter, Z.AI/GLM, Google Gemini, Mistral, DeepSeek, Groq, Perplexity, Ollama, LM Studio and any
number of custom OpenAI-compatible or Anthropic-compatible endpoints).

Features:
1. **Side panel chat** (Chrome side panel / Firefox sidebar): multiple chats, history, streaming,
   markdown, model switcher, personas/system prompts, include current page as context, image
   attachments (vision), image generation (where the provider supports it), export.
2. **Selection toolbar** on every web page: when text is selected a small floating toolbar offers
   quick actions (improve, rewrite, shorten, expand, fix grammar, formal, casual, personalize,
   summarize, explain, translate, …). Results stream into a popover with Copy / Replace /
   Refine / Continue in chat.
3. **Translation** of the selection or the **whole page** (in-place, restorable).
4. **Context menu** entries for all of the above; keyboard shortcuts `Alt+Shift+L` (open the
   panel) and `Alt+Shift+T` (translate the page); "restore page" and "summarize page" are commands
   without a default key that the user can assign.
   Not in scope (stated in the README): TTS, transcription, video generation, provider web
   search, file/PDF attachments, tool calls.
5. **Options page**: providers & keys, default models per purpose, quick-action editor, personas,
   personal profile ("über mich / Schreibstil" for the *Personalisieren* action), translation,
   appearance, data export/import/delete.
6. **Privacy**: everything is stored locally (`storage.local` + IndexedDB). The only network
   traffic is the direct request to the provider the user configured. No analytics, no own server.

UI language: **multilingual** (12 languages, German is the source language, English the fallback;
informal "du" in German). Every visible string goes through `t()` from `lib/i18n.js` – see
[I18N.md](I18N.md). This document was written when the UI was German-only: wherever it says
"German message/text", read "message in the UI language". Language values in settings
(`translate.targetLang`, `youtube.summaryLang`) are codes or `'auto'` (see `lib/languages.js`),
not German names. Code identifiers and code comments: English.

## 1. Hard technical rules

- Plain modern JavaScript (ES2022), **no frameworks, no npm runtime dependencies, no CDN, no build
  step for the code itself**. Extension pages and the background use **ES modules**
  (`<script type="module">`, `import … from '../lib/x.js'` – always relative paths with `.js`).
- The content script (`src/content/content.js`) is a **classic, self-contained script** (no
  imports) wrapped in an IIFE with a double-injection guard.
- MV3 CSP: no inline `<script>` blocks, no inline event handler attributes (`onclick=`), no `eval`,
  no `new Function`, no remote scripts. Inline `style=""` attributes are fine.
- Any HTML built from untrusted strings (model output, page text, user input) MUST be escaped
  (`escapeHtml`) or go through `renderMarkdown` (which is safe by construction). Never put API
  keys anywhere but `storage.local`. Never send keys to content scripts.
- Browser API access only through `ext` (see `lib/ext.js`); in the content script use
  `const ext = globalThis.browser ?? globalThis.chrome;`. Always use the **promise** form of APIs.
- `runtime.onMessage` listeners: answer by calling `sendResponse(...)` (possibly async) and
  `return true` – do **not** return a Promise (Chrome does not support that).
- Only use the browser APIs listed in §9 (the dev harness emulates exactly those).
- Accessibility: buttons have `title`/`aria-label`; keyboard usable; visible focus rings.

## 2. File layout

```
LLM-Sidebar/
  package.json                 type: module; scripts: build, zip, test, icons, dev
  README.md                    German user documentation (install Chrome/Firefox, providers, features)
  docs/ARCHITECTURE.md         this file
  manifests/
    base.json                  shared manifest fields
    chrome.json                Chrome-only fields (merged over base)
    firefox.json               Firefox-only fields (merged over base)
  scripts/
    build.mjs                  node scripts/build.mjs [--target chrome|firefox|all] [--zip]
    make-icons.mjs             procedurally renders src/icons/icon-{16,32,48,128}.png (zero deps)
  src/                         extension root (copied 1:1 into dist/<target>/ + manifest.json)
    background/background.js   ES module (service worker in Chrome, event page in Firefox)
    content/content.js         classic script: selection toolbar, popover, page translation
    sidepanel/sidepanel.html
    sidepanel/sidepanel.css
    sidepanel/sidepanel.js     (may be split into more modules inside sidepanel/)
    options/options.html
    options/options.css
    options/options.js         (may be split into more modules inside options/)
    lib/ext.js                 browser API shim
    lib/utils.js               small helpers
    lib/ui.js                  DOM helpers: toast, dialogs (extension pages only)
    lib/icons.js               inline SVG icon set
    lib/providers.js           provider presets catalogue
    lib/settings.js            settings schema, defaults, load/save, resolution helpers
    lib/prompts.js             quick actions, personas, prompt builders, languages
    lib/db.js                  IndexedDB chat storage
    lib/llm.js                 unified LLM client (chat streaming, images, model listing, balance)
    lib/usage.js               API costs: per-request cost, prices, usage statistics, money formatting
    lib/sse.js                 Server-Sent-Events reader for fetch responses
    lib/markdown.js            safe markdown → HTML renderer
    lib/tabs.js                active tab, content-script injection, page extraction
    lib/page.js                self-contained page-content extraction function
    lib/youtube.js             YouTube: URL detection, transcript extraction (self-contained), timestamp links
    styles/theme.css           design tokens + shared components (sidepanel + options)
    icons/icon-16.png … icon-128.png
  tests/                       node:test unit tests (*.test.mjs), run with `node --test tests/`
  dev/
    server.mjs                 static server for /src and /dev + mock LLM APIs (port 8787)
    ext-shim.js                fake `chrome` API for running pages outside an extension
    harness.html               test page + side panel + hidden background in one window
    bg.html                    hosts background.js inside the harness
    test-page.html             sample web page for content-script testing
  dist/chrome/, dist/firefox/  build output (load these unpacked)
```

## 3. Manifests (`manifests/*.json`, merged by `scripts/build.mjs`)

Merge rule: deep-merge objects, **concatenate + dedupe arrays**, scalar overrides win. `version`
comes from `package.json`.

base.json essentials:
- `manifest_version: 3`, `name: "LLM Sidebar"`, German `description`
  ("KI-Seitenleiste mit eigenem API-Schlüssel: chatten, Texte verbessern, übersetzen und Bilder
  generieren – mit OpenAI, Claude, Grok, OpenRouter, Z.AI und vielen mehr."),
- `icons` 16/32/48/128, `action: { default_title: "LLM Sidebar öffnen", default_icon: {...} }`
- `options_ui: { page: "options/options.html", open_in_tab: true }`
- `permissions: ["storage", "unlimitedStorage", "contextMenus", "scripting", "activeTab"]`
- `host_permissions: ["<all_urls>"]`
- `content_scripts: [{ matches: ["<all_urls>"], js: ["content/content.js"], run_at: "document_idle",
  all_frames: true, match_about_blank: true }]` – the content script also runs in iframes
  (iframe-based rich-text editors, about:blank editor frames); see §8 for what sub-frames do.
- `commands`: `translate-page` (suggested `Alt+Shift+T`, description "Aktuelle Seite übersetzen"),
  `restore-page` ("Originalseite wiederherstellen") and `summarize-page` ("Seite zusammenfassen")
  **without** `suggested_key` (listed as unassigned on the browser's shortcut page; this also keeps
  us below Chrome's limit of 4 suggested keys).

chrome.json: `background: { service_worker: "background/background.js", type: "module" }`,
`side_panel: { default_path: "sidepanel/sidepanel.html" }`, `permissions: ["sidePanel"]`,
`minimum_chrome_version: "116"`, `commands._execute_action` (suggested `Alt+Shift+L`).

firefox.json: `background: { scripts: ["background/background.js"], type: "module" }`,
`sidebar_action: { default_panel: "sidepanel/sidepanel.html", default_title: "LLM Sidebar",
default_icon: {...}, open_at_install: false }`, `commands._execute_sidebar_action`
(suggested `Alt+Shift+L`), `browser_specific_settings.gecko: { id: "llm-sidebar@local",
strict_min_version: "142.0", data_collection_permissions: { required: ["websiteContent"] } }`
(selected text / page content is sent to the user-chosen provider on an explicit user command;
`data_collection_permissions` needs Firefox 140 on desktop and 142 on Android, and `web-ext lint`
warns below 142),
and `content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" }` –
Firefox's default MV3 CSP contains `upgrade-insecure-requests`, which would break
`http://localhost` endpoints (Ollama, LM Studio).

Platform facts (see `docs/research/browser-platform.md`): Firefox has no `background.service_worker`
→ the background must be event-page/service-worker safe (no DOM, no `window`, no
`localStorage`, no dynamic `import()`); Chrome 148+ also exposes `browser.*`.

## 4. Data shapes

### 4.1 ProviderPreset (`lib/providers.js`)
```js
{
  id: 'openai',                 // preset id
  name: 'OpenAI',
  protocol: 'openai' | 'anthropic',
  baseUrl: 'https://api.openai.com/v1',   // no trailing slash
  requiresKey: true,
  keyUrl: 'https://platform.openai.com/api-keys',   // where to get a key (shown as link)
  docsUrl: '…',
  supportsModelList: true,      // GET {baseUrl}/models works
  defaultModels: ['…'],         // suggestions shown before the user fetches the list
  defaultModel: '…',
  imageApi: 'openai-images' | 'openrouter-chat' | 'none',
  defaultImageModels: ['…'],
  defaultImageModel: '…' | '',
  extraHeaders: {},             // e.g. OpenRouter: { 'HTTP-Referer': '…', 'X-Title': 'LLM Sidebar' }
  maxTokensParam: 'max_tokens' | 'max_completion_tokens',   // openai protocol only
  baseUrlOptions: [{ label, url, note? }],  // optional alternative endpoints (e.g. Z.AI Coding Plan)
  notes: 'German one-liner shown in the options card' ,
  color: '#10a37f'              // brand-ish accent for the card avatar (just a color, no logos)
}
```
Preset ids: `openai, anthropic, openrouter, xai, zai, gemini, mistral, deepseek, groq,
ollama-cloud, ollama, lmstudio, custom`. `custom` is a template only (not in default settings).
(Perplexity is intentionally not a preset: its chat-completions API was discontinued in 2026.)

Preset data (verified 2026-11-03, see `docs/research/`; `models` are only suggestions – the user
fetches the live list with "Modelle laden"):
| id | baseUrl | maxTokensParam | defaultModels (first = default) | imageApi / image models |
|---|---|---|---|---|
| openai | https://api.openai.com/v1 | max_completion_tokens | gpt-6.1-sol, gpt-6-luna, gpt-6.1-terra, gpt-6-astra | openai-images: gpt-image-2.5-flare, gpt-image-2.5-sunburst, gpt-image-2 |
| anthropic | https://api.anthropic.com/v1 | – | claude-sonnet-5-5, claude-haiku-5-5, claude-opus-5-5, claude-fable-5-1 | none |
| openrouter | https://openrouter.ai/api/v1 | max_tokens | openrouter/auto, anthropic/claude-sonnet-5.5, openai/gpt-6.1-sol, google/gemini-3.8-flash, x-ai/grok-4.7, z-ai/glm-5.3, deepseek/deepseek-v4-pro | openrouter-chat: google/gemini-nano-banana-2.1, google/gemini-3.1-flash-image, openai/gpt-image-2.5-flare, black-forest-labs/flux-3-image |
| xai | https://api.x.ai/v1 | max_completion_tokens | grok-4.3, grok-4.7 | openai-images: grok-imagine-image-2.0, grok-imagine-image |
| zai | https://api.z.ai/api/paas/v4 (option "GLM Coding Plan": https://api.z.ai/api/coding/paas/v4 – note: separate key, only for officially supported tools) | max_tokens | glm-5.3, glm-5.3-flash, glm-5.3-flashx (vision) | openai-images: glm-image |
| gemini | https://generativelanguage.googleapis.com/v1beta/openai | max_tokens | gemini-3.8-flash, gemini-4-argon, gemini-3.6-flash, gemini-3.5-flash-lite | openai-images: gemini-3.1-flash-image, gemini-nano-banana-2.1 |
| mistral | https://api.mistral.ai/v1 | max_tokens | mistral-large-4, mistral-small-latest | none |
| deepseek | https://api.deepseek.com | max_tokens | deepseek-flash, deepseek-v4-pro | none |
| groq | https://api.groq.com/openai/v1 | max_completion_tokens | llama-3.3-70b-versatile, openai/gpt-oss-120b, openai/gpt-oss-20b | none |
| ollama-cloud | https://ollama.com/v1 (key from ollama.com/settings/keys; models listed via GET https://ollama.com/api/tags, fallback /v1/models) | max_tokens | gpt-oss:120b, gpt-oss:20b | none |
| ollama | http://localhost:11434/v1 (requiresKey false) | max_tokens | (empty – load list) | none |
| lmstudio | http://localhost:1234/v1 (requiresKey false) | max_tokens | (empty – load list) | none |
| custom | '' | max_tokens | – | none |

### 4.2 ProviderConfig (stored in settings.providers[])
```js
{
  id: 'openai' | 'custom-<uid>',  // equals presetId for built-ins
  presetId: 'openai',
  name: 'OpenAI',
  protocol: 'openai' | 'anthropic',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  enabled: false,
  models: string[],               // chat model ids (fetched or added manually)
  defaultModel: string,
  imageApi: 'openai-images' | 'openrouter-chat' | 'none',
  imageModels: string[],
  defaultImageModel: string,
  extraHeaders: { [name]: value },
  modelInfo: { [modelId]: { name?, vision?, imageOutput?, contextLength?,
                            inputPrice?, outputPrice? } },  // from listModels; prices USD / 1M tokens
  prices: { [modelId]: { input: number|null, output: number|null } },  // user prices, USD / 1M tokens
}
```
A provider is **ready** when `enabled && baseUrl && (apiKey || !preset.requiresKey)`.
Entering an API key in the options page auto-enables the provider.

### 4.3 Settings (`storage.local` key `"settings"`)
```js
{
  schemaVersion: 1,
  providers: ProviderConfig[],          // all presets except 'custom' + user custom providers
  defaults: {                           // each: { providerId, model } | null
    chat: null, actions: null, translate: null, image: null,
  },
  general: { theme: 'system' | 'light' | 'dark', sendWithEnter: true, streaming: true },
  chat: {
    systemPrompt: '',                   // global extra system prompt
    personaId: 'default',               // default persona for new chats
    temperature: null,                  // null = don't send
    maxTokens: null,                    // side-panel chat only; null = don't send (anthropic
                                        // falls back to 16000). Background requests never send it.
    contextMessages: 30,                // max previous messages sent to the model
    includePageByDefault: false,
    useProfileInChat: false,            // append profile to system prompt
  },
  profile: { aboutMe: '', writingStyle: '' },
  toolbar: { enabled: true, disabledHosts: [] },   // hostnames without toolbar
  translate: { targetLang: 'Deutsch', batchChars: 2500, concurrency: 3 },
  usage: { showInChat: true },          // tokens + cost in the header of side-panel answers
  quickActions: QuickAction[],
  personas: Persona[],
}
```

Costs (`lib/usage.js`): a request's cost is the provider's own figure (`usage.cost` from
OpenRouter, `cost_in_usd_ticks` / 1e10 from xAI) or an estimate from the price per 1M tokens:
`provider.prices[model]` (user) → `modelInfo[model].inputPrice/outputPrice` (model list) →
preset `prices[model]` (built-in list prices, OpenAI and Anthropic). Image requests count only a
reported cost. Statistics live in `storage.local` key `"usageStats"`:
`{ version: 1, since, months: { 'YYYY-MM': { '<providerId>|<model>': { providerId, providerName,
model, requests, inputTokens, outputTokens, cost, estimated, unpriced } } } }` (last 24 months).
The background is the only regular writer: its own requests directly, side panel requests via
`recordUsage` (§7.1). Balance (`fetchBalance` in lib/llm.js): OpenRouter `GET /key` (per-key limit
and usage – the account credit needs a management key), DeepSeek `GET /user/balance` and xAI via
its Management API (`provider.billing = { managementKey, teamId }`; team id discovered with
`GET /auth/management-keys/validation` when empty, then `GET /v1/billing/teams/{id}/prepaid/balance`,
USD cents, remaining = -total). Key-less exports blank `billing.managementKey` like `apiKey`. Every
other provider has no endpoint for a normal key, the UI links to the preset's `billingUrl`.
QuickAction: `{ id, name, icon /* one emoji */, prompt /* template */, toolbar: bool,
contextMenu: bool, builtin: bool }`. Template variables: `{{text}}`, `{{lang}}`, `{{profile}}`,
`{{title}}`, `{{url}}`.
Persona: `{ id, name, prompt }` (`id: 'default'` has an empty prompt and cannot be deleted).

### 4.4 Chat (IndexedDB)
```js
Chat = {
  id, title, createdAt, updatedAt, pinned: false,
  providerId, model,            // last used target
  personaId,                    // persona used for this chat
  messages: Message[],
}
Message = {
  id, role: 'user' | 'assistant',
  kind: 'chat' | 'image',       // 'image' = image-generation request/response
  content: string,              // markdown/plain text as shown
  context: string | null,       // hidden context sent with a user message (page text block)
  page: { title, url } | null,  // shown as a chip on the user message when context present
  quote: Quote | null,          // user: page selection this message refers to (shown as quote,
                                // sent before the content via formatSelectionQuote)
  attachments: [{ type: 'image', dataUrl, name, mimeType }],   // user images (vision)
  images: [{ src /* data: or https: URL */, prompt }],         // generated images (assistant)
  reasoning: string,            // assistant "thinking" text if the provider streamed it
  usage?: { inputTokens?, outputTokens?, reasoningTokens?, cost? /* USD */, estimated? },  // assistant
  providerId, model,            // assistant: who answered
  error: string | null,         // assistant: German error text if the request failed
  createdAt,
}
```

`Quote = { text, title, url, truncated? }` – normalized by `normalizeQuote` (lib/utils.js): text
trimmed and at most `MAX_QUOTE_CHARS` (20 000) characters (`truncated: true` when cut), title ≤ 300
characters, url only http(s) without query and fragment, otherwise `''`.

### 4.5 Internal LLM message format (input to `lib/llm.js`)
`{ role: 'user' | 'assistant', content: string | Part[] }` with
`Part = { type: 'text', text } | { type: 'image', dataUrl }`.
The system prompt is passed separately (`system` option).

### 4.6 PendingChat (`storage.session` key `"pendingChat"`, fallback `storage.local`)
```js
{ id, ts, kind: 'prefill' | 'send' | 'continue',
  windowId?: number,                 // window it belongs to: sender.tab.windowId (openInChat) or
                                     // tab.windowId (context menu / command); omitted if unknown
  text?: string,                     // prefill: composer text; send: message to send
  quote?: Quote,                     // prefill: selection shown as reference above the composer
  source?: { tabId, frameId },       // prefill with quote: where the selection is (set by the
                                     // background); the panel drops the reference when it goes away
  includePage?: boolean,             // send: attach current page content
  messages?: [{ role, content }],    // continue: seed messages for a new chat
  title?: string }
```
Only the background reads and removes it. It is **claimed exactly once** with the runtime message
`{ type: 'claimPendingChat', windowId }` (§7.1): the background atomically reads it and, if it is
present, not expired and `!pending.windowId || pending.windowId === windowId`, removes it and
answers `{ ok: true, pending }`, otherwise `{ ok: true, pending: null }`.
Expiry: kinds `continue` and `prefill` 24 h, kind `send` 10 min.
The side panel never touches the key itself: on load and on `storage.onChanged` for
`pendingChat` (with a `newValue`) it sends `claimPendingChat` with its own window id
(`(await ext.windows.getCurrent()).id`). If an answer is streaming, it queues the claimed entry
and applies it after the stream ends – it never aborts a running answer.

## 5. Module APIs

### lib/ext.js
```js
export const ext;                // globalThis.browser ?? globalThis.chrome
export const IS_FIREFOX;         // boolean (runtime URL starts with 'moz-extension:' or browser.runtime.getBrowserInfo exists)
export const sessionArea;        // ext.storage.session if available, else ext.storage.local
export function lastErrorMessage(e) // string from Error / chrome.runtime.lastError
```

### lib/utils.js
```js
export function uid(prefix = '')            // short random id (crypto.getRandomValues)
export function escapeHtml(str)
export function debounce(fn, ms)
export function throttle(fn, ms)
export function clamp(n, min, max)
export function truncate(str, max)          // adds '…'
export const MAX_QUOTE_CHARS                // 20000 – longest page selection kept as chat reference
export function normalizeQuote(raw)         // untrusted { text, title, url, truncated } → Quote | null (§4.4)
export function sleep(ms)
export function deepClone(obj)              // structuredClone fallback JSON
export function formatDateGroup(ts)         // 'Heute' | 'Gestern' | 'Letzte 7 Tage' | 'Älter'
export function formatTime(ts)              // 'HH:MM' or 'DD.MM.YYYY' (de-DE)
export function hostnameOf(url)             // '' on failure
export function isRestrictedUrl(url)        // chrome://, edge://, about:, view-source:, *-extension://,
                                            // chromewebstore.google.com, chrome.google.com/webstore,
                                            // addons.mozilla.org, file:// (true = scripts can't run)
export function dataUrlParts(dataUrl)       // { mimeType, base64 }
export function blobToDataUrl(blob)         // Promise<string>
export function readFileAsDataUrl(file)     // Promise<string>
export async function copyText(text)        // navigator.clipboard with textarea fallback
export function downloadFile(filename, content, mime = 'text/plain')  // content: string | Blob
export function applyTheme(theme)           // sets/removes document.documentElement.dataset.theme
```

### lib/ui.js (extension pages only)
```js
export function h(tag, attrs = {}, ...children)   // tiny element builder; attrs: class, dataset,
                                                  // on<Event> functions, other attrs; children: Node|string
export function toast(message, { type = 'info' | 'success' | 'error', timeout = 2500 } = {})
export function confirmDialog(message, { title, okText = 'OK', cancelText = 'Abbrechen', danger = false } = {}) // Promise<boolean>
export function promptDialog(title, { value = '', placeholder = '', okText = 'OK', multiline = false } = {})  // Promise<string|null>
export function autosize(textarea, maxPx = 240)   // auto-growing textarea
```

### lib/icons.js
```js
export function icon(name, { size = 18, cls = '' } = {})   // returns an SVG markup string
export const ICON_NAMES                                      // array of available names
```
Names (at least): `plus, settings, menu, history, send, stop, copy, check, refresh, edit, trash,
pin, image, paperclip, page, globe, languages, sparkles, wand, x, chevron-down, chevron-right,
chevron-left, download, upload, external, search, sun, moon, monitor, key, eye, eye-off, more,
user, bot, alert, info, bolt, brain, link, play, list, sliders, shield, keyboard`.
Original simple stroke icons (24×24 viewBox, `stroke="currentColor"`, `fill="none"`, width 2).

### lib/providers.js
```js
export const PROVIDER_PRESETS          // ProviderPreset[] in display order
export function getPreset(presetId)    // preset or the 'custom' preset as fallback
export function createProviderFromPreset(presetId, overrides = {})  // → ProviderConfig
export function createCustomProvider({ name, baseUrl, protocol = 'openai', apiKey = '' })  // id 'custom-<uid>'
```

### lib/settings.js
```js
export const SETTINGS_KEY = 'settings'
export function getDefaultSettings()           // fresh deep copy
export function normalizeSettings(raw)         // merge with defaults, add missing presets, fix types
export async function getSettings()            // load + normalize (does not write)
export async function saveSettings(settings)   // normalize + write
export async function updateSettings(mutator)  // load, mutator(settings) (may return new obj), save; returns saved
export function onSettingsChanged(cb)          // cb(newSettings); returns unsubscribe
export function getProvider(settings, providerId)
export function isProviderReady(provider)
export function getReadyProviders(settings)
export function resolveTarget(settings, purpose)   // purpose 'chat'|'actions'|'translate'|'image'
                                                   // → { provider, model } | null (see §6)
export function listChatModels(settings)       // [{ providerId, providerName, model, label }] of ready providers
export function listImageModels(settings)      // same for image models (imageApi !== 'none')
export function getContentConfig(settings)     // key-free config for content scripts (see §7)
export function exportSettings(settings, { includeKeys = false } = {})   // JSON string
    // without keys: blanks every apiKey AND every extraHeaders value (header names stay) and
    // marks the file { …, keysIncluded: false }. The profile (Über mich / Schreibstil) is included
    // – the options UI says so.
export function parseImportedSettings(json)    // → normalized settings (throws German Error on invalid)
    // never keeps an existing API key for a provider whose imported baseUrl differs from the
    // current one
```

### lib/prompts.js
```js
export const LANGUAGES                 // ['Deutsch','Englisch','Französisch','Spanisch','Italienisch',
                                       //  'Portugiesisch','Niederländisch','Polnisch','Tschechisch','Türkisch',
                                       //  'Russisch','Ukrainisch','Griechisch','Schwedisch','Dänisch','Norwegisch',
                                       //  'Finnisch','Ungarisch','Rumänisch','Arabisch','Hebräisch','Hindi',
                                       //  'Chinesisch (vereinfacht)','Chinesisch (traditionell)','Japanisch','Koreanisch',
                                       //  'Vietnamesisch','Thailändisch','Indonesisch']
export const DEFAULT_QUICK_ACTIONS     // see below
export const DEFAULT_PERSONAS          // default, Programmierer, Übersetzer, Lektor, Recherche, Lehrer (German prompts)
export const ACTION_SYSTEM_PROMPT      // "return only the resulting text, no preamble/quotes, keep formatting & language unless asked"
export const SUMMARIZE_PAGE_PROMPT     // German user prompt for page summaries
export const SUGGESTIONS               // [{ icon, label, prompt, includePage }] welcome chips of the side panel
export function fillTemplate(template, vars)          // replaces {{name}}; unknown → ''
export function profileText(settings)                 // combined profile string ('' if empty)
export function buildActionRequest(action, { text, lang, profile, instruction, previous, page })
    // → { system, messages }. With previous+instruction: [user(original), assistant(previous),
    //   user('Überarbeite deine letzte Antwort: <instruction>')]. With instruction only: appended.
export function buildTranslateRequest(text, lang)     // → { system, messages } (selection translation)
export function buildSegmentsRequest(segments, lang)  // → { system, messages } page-translation batch
export function parseSegmentsResponse(output, count)  // → (string|null)[] length = count
export function buildChatSystemPrompt(settings, persona)   // persona prompt + settings.chat.systemPrompt
                                                           // + profile (if useProfileInChat) + date (de-DE) + markdown hint
export function formatPageContext(page)               // page = { title, url, text, selection? } → string block
export function formatSelectionQuote(quote)           // Quote → '=== Markierter Text (von der Webseite) ===' block | ''
```
Default quick actions (ids are stable): `improve` ✨ Verbessern, `rewrite` 🔁 Umschreiben,
`grammar` ✅ Korrigieren, `shorten` ✂️ Kürzen, `expand` ➕ Ausführlicher, `formal` 🎩 Formeller,
`casual` 😊 Lockerer, `personalize` 👤 Personalisieren (uses `{{profile}}`), `summarize` 📝
Zusammenfassen, `explain` 💡 Erklären, `reply` ↩️ Antwort entwerfen, `translate` 🌐 Übersetzen
(uses `{{lang}}`). Toolbar defaults: improve, rewrite, grammar, translate, explain, summarize.

Segment format for page translation (robust against quotes/JSON breakage):
request lines `[[1]] text`, `[[2]] text` …, one per segment at the line start; the model must
answer with the same markers in the same order and nothing else. The text around the segment
lines (header, system prompt) never contains a literal `[[n]]` marker, so only line-start markers
are segments (the dev mock relies on that). `parseSegmentsResponse` splits on `/\[\[(\d+)\]\]/`,
trims, maps by number, returns `null` for missing ones. Newlines inside a segment are replaced by
spaces before sending.

### lib/db.js
```js
export async function listChats()          // Chat[] sorted: pinned first, then updatedAt desc
export async function getChat(id)          // Chat | null
export async function saveChat(chat)       // sets updatedAt = Date.now() unless opts.keepTime; returns chat
export async function deleteChat(id)
export async function clearChats()
export async function exportChats()        // Chat[]
export async function importChats(chats)   // upsert; returns count
export function createChat(partial = {})   // new Chat object (not saved), title 'Neuer Chat'
export function createMessage(partial)     // new Message object with id/createdAt/defaults
export function serializeChatsExport(chats) // → { format: 'llm-sidebar-chats', version: 1, exportedAt, count, chats }
export function parseChatsImport(json)     // accepts that format or a plain Chat[]; throws a German Error
                                           // otherwise; keeps image src only for data:image/(png|jpeg|gif|webp)
                                           // or https: URLs and drops malformed entries
export function onChatsChanged(cb)         // cb(event) for every write, also from this page; → unsubscribe
```
DB name `llm-sidebar`, version 1, store `chats` (keyPath `id`, index `updatedAt`).
After every write `db.js` posts on `BroadcastChannel('llm-sidebar-chats')`:
`{ type: 'saved', id, updatedAt }`, `{ type: 'deleted', id }`, `{ type: 'cleared' }`,
`{ type: 'imported', count }` (own writes are recognised via `id` + `updatedAt`).
Side panel and options both use the one export format (`serializeChatsExport` /
`parseChatsImport`).

### lib/sse.js
```js
export async function* readSSE(response, { signal } = {})
// yields { event: string ('message' default), data: string } for each event;
// handles \r\n, multi-line data, comment lines (':' prefix), stops at end of stream.
// The caller handles '[DONE]'.
```

### lib/llm.js
```js
export class LLMError extends Error { /* name 'LLMError'; fields: code, status, details */ }
// code: 'no_provider' | 'no_key' | 'auth' | 'forbidden' | 'not_found' | 'rate_limit' | 'quota' |
//       'bad_request' | 'server' | 'network' | 'aborted' | 'parse' | 'unsupported'
export function describeError(err)   // German, user-facing one-liner (includes provider message if useful)

export async function streamChat({
  provider, model, messages, system = '', temperature = null, maxTokens = null,
  signal, onText, onReasoning, stream = true,
}) // → { text, reasoning, images: string[] /* data/https URLs */, finishReason, usage }
   // onText(deltaString, fullText), onReasoning(deltaString, fullReasoning)
   // stream=false → single request without SSE (same return value)

export async function generateImage({ provider, model, prompt, size = '1024x1024', signal })
   // → { images: [{ src, revisedPrompt? }], text? }

export async function listModels(provider, { signal } = {})
   // → [{ id, name?, vision?, imageOutput?, contextLength? }] sorted by id

export async function testConnection(provider)   // → { ok: true, message, models } | { ok: false, message }
```
Behaviour details in §6.

### lib/markdown.js
```js
export function renderMarkdown(markdown)   // → safe HTML string
```
Escapes all HTML first; supports headings, paragraphs, line breaks, **bold**, *italic*,
~~strike~~, `inline code`, fenced code blocks (also unterminated while streaming) rendered as
`<div class="code-block"><div class="code-head"><span class="code-lang">js</span><button class="copy-code" type="button" title="Code kopieren">Kopieren</button></div><pre><code>…</code></pre></div>`,
block quotes, ordered/unordered/nested/task lists, GFM tables, horizontal rules, links
(`http:`, `https:`, `mailto:` only; `target="_blank" rel="noopener noreferrer"`), autolinks,
images (`https:` / `data:image/` only, `loading="lazy"`). Inline math `$…$` is left as text.
The consumer attaches a delegated click handler for `.copy-code` (copies the sibling `<pre>` text).

### lib/tabs.js
```js
export async function getActiveTab()                 // { id, url, title, windowId } | null (current window)
export async function tryMessageTab(tabId, message, { frameId = 0, timeoutMs = 3000 } = {})
    // tabs.sendMessage WITHOUT injecting first → response | null (nobody answered in time)
export async function injectIntoOpenTabs()
    // 'content/content.js' into every open, loaded http(s)/file tab (allFrames); failures skipped
    // → number of injected tabs (Chrome onInstalled, see §8 Background)
export async function ensureContentScript(tabId, { frameId = 0 } = {})
    // ping that frame → inject 'content/content.js' with target { tabId, frameIds: [frameId] } if
    // needed → boolean
export async function sendToTab(tabId, message, { frameId = 0 } = {})
    // ensureContentScript then tabs.sendMessage(tabId, message, { frameId }); throws German Error
export async function getPageContent(tabId, { maxChars = 60000 } = {})
    // scripting.executeScript({ target: { tabId }, func: extractPageContent, args: [maxChars] })
    // → { title, url, lang, description, selection, text, truncated }; throws German Error on restricted pages
```

### lib/page.js
```js
export function extractPageContent(maxChars)  // MUST be self-contained (no closure/imports): it is
                                              // serialized by scripting.executeScript.
```
Prefers `article`, `main`, `[role=main]` when they hold most of the text, otherwise `body`;
uses `innerText`; collapses whitespace runs; returns the current selection too.
Privacy: `url` is returned without query string and fragment; the value of password fields
(`input[type=password]`) and one-time-code fields (`autocomplete="one-time-code"`) never appears in
`selection` or `text`.

### lib/youtube.js
```js
export function isVideoId(id)                 // /^[A-Za-z0-9_-]{11}$/
export function parseYouTubeUrl(url)          // watch?v=, /shorts/, /live/, /embed/ (www., m.), youtu.be → id | null
export function youTubeWatchUrl(id, seconds?) // canonical https://www.youtube.com/watch?v=<id>[&t=<s>s]
export function formatTimestamp(s) / parseTimestamp(str) / parseTimestampLink(href)
export function linkifyTimestamps(markdown, videoId)  // "[12:34]" / "[1:02:03]" / ranges → markdown links (not in code)
export async function extractYouTubeVideo(videoId, { maxChars = 120000 })   // self-contained, runs in the tab
    // → { ok, id, url, title, author, lengthSeconds, isLive, description, chapters, transcript, problem }
export function seekYouTubeVideo(videoId, seconds)    // self-contained, runs in the tab
```
Transcript strategies (in the tab, same origin, user's cookies; Firefox uses `content.fetch`): watch
page HTML → `ytInitialPlayerResponse` caption track (manual track in the spoken language, else ASR;
`fmt=json3`, XML fallback) → `youtubei/v1/get_transcript` with the `getTranscriptEndpoint.params` from
`ytInitialData` → an opened transcript panel in the DOM. Lines of ~20 s, each `[m:ss] text`.
`lib/tabs.js` adds `getVideoContent(tabId, videoId)` and `seekVideoInTab(tabId, videoId, seconds)`;
`lib/prompts.js` adds `formatVideoContext(video)` ("=== Videokontext …" block) and
`buildVideoSummaryPrompt(lang)`. Setting: `youtube: { summaryLang: 'Deutsch' }`.
Side panel: when the active tab is a video, reading "the page" reads the video instead (user message
gets `context` = video block, `page` = { title, canonical url }, `video` = { id, title, transcript });
assistant answers get `video: { id }` and their `[m:ss]` timestamps render as links that seek the
video in the active tab (or open it at that time). Welcome card "YouTube-Video erkannt" (summarize
with language picker, "Fragen zum Video stellen" = transcript with the next message), compact bar
above the composer in chats not yet about that video, ⋯ menu entry. The latest video context is
always sent, even when its message fell out of `contextMessages`.

## 6. LLM client behaviour (`lib/llm.js`)

Research notes with verified late-2026 API facts live in `docs/research/*.md` – read the one for
your area before implementing provider-specific code.

`lib/llm.js` does **not** import `lib/providers.js`: every provider quirk (max-tokens parameter
name, which body fields are allowed, image request style, error hints) is keyed by
`provider.presetId` (with model-name heuristics as fallback) inside `lib/llm.js`, so the client
also works for custom providers. `maxTokensParam` in the preset table is informational.

Common:
- URL = `provider.baseUrl` (trailing slash stripped) + path.
- Missing ready provider → `LLMError('no_provider')`; key required but empty → `'no_key'`.
- HTTP errors → map status: 401 auth, 402 quota, 403 forbidden, 404 not_found, 413 bad_request,
  429 rate_limit (or quota when the body mentions quota/billing/credit/balance), 400/422
  bad_request (but 'auth' when the message mentions "api key"/"credentials" – xAI and Gemini answer
  bad keys with 400), ≥500/529 server. Extract the provider's message defensively from
  `{error:{message}}`, `{error:"…"}` (xAI), `[{error:{message}}]` (Gemini wraps errors in an
  array), `{type:'error', error:{type,message}}` (Anthropic), `{message}`, `{detail}`, `{msg}`.
- **Never send sampling parameters** (`temperature`, `top_p`, …) unless the user explicitly set a
  temperature; and even then never for protocol `anthropic` and never for presets `openai`,
  `gemini` (current models reject or ignore them). Never send `stop`, `presence_penalty`,
  `frequency_penalty`.
- Long requests are normal (reasoning models may think for minutes): no client-side timeout
  except the user's Stop button (AbortController).
- fetch TypeError → 'network' (German hint: Netzwerk/CORS/URL prüfen; for localhost mention
  OLLAMA_ORIGINS / LM-Studio CORS). AbortError → 'aborted'.
- `provider.extraHeaders` are added to every request.

protocol `openai` (`POST {base}/chat/completions`):
- headers: `Content-Type: application/json`, `Authorization: Bearer <key>` if key.
- body: `{ model, messages: [{role:'system',content:system}?, …], stream }`; `temperature` only if
  not null; max tokens only if not null using `preset.maxTokensParam`.
- parts: text → `{type:'text',text}`, image → `{type:'image_url', image_url:{url:dataUrl}}`; a
  message whose parts are all text is sent as a plain string.
- streaming: SSE `data:` JSON chunks; `choices[0].delta.content` → text;
  `delta.reasoning_content` or `delta.reasoning` → reasoning; `delta.images` (OpenRouter) → images;
  `finish_reason`; `usage`; `[DONE]` ends; a chunk with `error` → throw.
- non-stream: `choices[0].message.content`, `.reasoning_content|reasoning`, `.images[].image_url.url`.

protocol `anthropic` (`POST {base}/messages`):
- headers: `x-api-key`, `anthropic-version: 2023-06-01`,
  `anthropic-dangerous-direct-browser-access: true`, `Content-Type`.
- body: `{ model, max_tokens: maxTokens ?? 16000, system?, messages, stream }` – no sampling
  params. For Claude 5.x models (`/^claude-(opus|sonnet|haiku|fable)-5/`) add
  `thinking: { type: 'adaptive', display: 'summarized' }` so reasoning is visible; if the request
  fails with 400 and the message mentions `thinking`, retry once without the `thinking` field.
- Only text (and image parts) of previous turns are sent – never thinking blocks – and the last
  message is always `user` (no prefill: it returns 400 on current models).
- messages must start with `user` and alternate: merge consecutive same-role messages, drop
  leading assistant messages. Image part → `{type:'image', source:{type:'base64', media_type, data}}`
  placed before the text part.
- SSE: `content_block_delta` with `delta.type === 'text_delta'` (`delta.text`) /
  `'thinking_delta'` (`delta.thinking`); `message_delta.delta.stop_reason` (`refusal` → append a
  German note "Die Anfrage wurde vom Modell abgelehnt."); `error` event → throw; ignore `ping`
  and unknown event types. No `[DONE]`.
- models: `GET {base}/models?limit=1000` → `data[].id`, `display_name`,
  `capabilities.image_input` → vision.

Image generation (`imageApi 'openai-images'`, `POST {base}/images/generations`). Body per
provider family (decide by `provider.presetId`, then by model name):
- OpenAI / `gpt-image-*`: `{ model, prompt, n: 1, size }` with size `1024x1024 | 1536x1024 |
  1024x1536 | auto` – **never** `response_format` (always returns `b64_json`; mime from
  `output_format`, default png).
- xAI / `grok-imagine*`: `{ model, prompt, n: 1, response_format: 'b64_json', aspect_ratio }` –
  **no** `size`; map 1024x1024→`1:1`, 1536x1024→`3:2`, 1024x1536→`2:3`, auto→`auto`. Response
  items may carry `mime_type`.
- Gemini: `{ model, prompt, n: 1, size, response_format: 'b64_json' }`.
- Z.AI / `cogview*` / `glm-image*`: see `docs/research/openrouter-zai-others.md` (returns `url`).
- Any other provider: `{ model, prompt, n: 1, size, response_format: 'b64_json' }`.
- Response: `data[].b64_json` → `data:<mime>;base64,…`; or `data[].url` (try to fetch it and
  convert to a data URL so it persists – provider URLs are temporary; fall back to the URL).
- Z.AI (`glm-image`, `cogview*`): `{ model, prompt, size }` with size mapped
  1024x1024→`1280x1280`, 1536x1024→`1568x1056`, 1024x1536→`1056x1568`; response `data[].url`
  (expires after 30 days → always convert to a data URL).
- `imageApi 'openrouter-chat'` (OpenRouter): first `POST {base}/images`
  `{ model, prompt, n: 1, aspect_ratio }` → `data[].b64_json` + `media_type`; if that returns
  400/404/405, fall back to a non-stream chat completion with `modalities: ['image','text']` →
  images from `choices[0].message.images[].image_url.url` (text from `message.content`).
  OpenRouter image models are listed with `GET {base}/models?output_modalities=image`.
- `imageApi 'none'` → `LLMError('unsupported')`. Image size option in the UI:
  Quadratisch (1024x1024), Querformat (1536x1024), Hochformat (1024x1536).

Provider quirks for protocol `openai` (see research notes):
- `delta.content` may be an **array** (Mistral reasoning): items `{type:'thinking', thinking:[{type:'text',text}]}`
  → reasoning, `{type:'text', text}` → text. Same for non-stream `message.content`.
- Reasoning fields: `delta.reasoning_content` (Z.AI, DeepSeek, xAI, LM Studio), `delta.reasoning`
  (OpenRouter, Groq), Mistral arrays (above). `<think>…</think>` at the start of `content` (some
  local models) → move into reasoning.
- OpenRouter: mid-stream errors arrive as a chunk with top-level `error` (HTTP 200) or
  `finish_reason: 'error'` → throw. The usage chunk repeats `finish_reason` – not an error.
- Z.AI: errors may only show as `finish_reason` `sensitive` / `network_error` → append a German
  note. Error codes are strings (`{"error":{"code":"1113","message":"…"}}`: 1113 → quota).
- Mistral rejects unknown body fields: send only `model, messages, stream, max_tokens,
  temperature` there.
- Ollama answers 403 when the extension origin is not allowed → `describeError` explains
  `OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*` (Windows: Benutzer-Umgebungsvariable
  setzen, Ollama neu starten). LM Studio: "CORS aktivieren" in den Server-Einstellungen.
- Gemini: a 403 often means an unrestricted/old key → hint to create a new key in AI Studio.

Model listing: `GET {base}/models` → `data[]` (or `models[]`); strip a leading `models/`
(Gemini); skip entries whose `shutdown_date`/`retires_at` lies in the past; OpenRouter fields
`name`, `context_length`, `architecture.input_modalities` (contains `image` → vision),
`architecture.output_modalities` (contains `image` → imageOutput). Classify ids: image models =
`imageOutput` or id matching `/gpt-image|dall-e|imagine|image-gen|nano-banana|cogview|glm-image|flux|stable-diffusion|sdxl|-image\b|image-preview/i`;
exclude non-chat ids from the chat list (`/embed|tts|whisper|transcribe|audio|realtime|moderation|rerank|babbage|davinci|sora|video|speech/i`).

`resolveTarget(settings, purpose)` fallback chain:
- chat: `defaults.chat` → first ready provider.
- actions: `defaults.actions` → `defaults.chat` → first ready provider.
- translate: `defaults.translate` → `defaults.actions` → `defaults.chat` → first ready.
- image: `defaults.image` → first ready provider with `imageApi !== 'none'` and an image model.
A default only counts if its provider exists and is ready. Model falls back to
`provider.defaultModel || provider.models[0]` (image: `defaultImageModel || imageModels[0]`).
No model → skip that candidate. Nothing found → `null`.

## 7. Messaging protocol

### 7.1 `runtime.sendMessage` → background
| request | response |
|---|---|
| `{ type: 'getContentConfig' }` | `{ ok: true, config }` – `config = { ready: bool, toolbar: { enabled, disabledHosts }, quickActions: [{ id, name, icon, toolbar, contextMenu }], translate: { targetLang, batchChars, concurrency }, theme }` |
| `{ type: 'translateSegments', segments: string[], lang? }` | `{ ok: true, translations: (string\|null)[] }` or `{ ok: false, error }` |
| `{ type: 'openInChat', payload: PendingChat-without-id/ts/windowId }` | `{ ok: true, opened: bool }` – the background stores the PendingChat with `windowId = sender.tab.windowId`. Chrome: `opened` = `sidePanel.open` succeeded. Firefox: `opened = await browser.sidebarAction.isOpen({ windowId })` (an open panel claims the entry; a closed one cannot be opened from a relayed content-script click) |
| `{ type: 'claimPendingChat', windowId }` | `{ ok: true, pending }` – `pending` is the PendingChat or `null`; atomic read + remove, see §4.6 (side panel only) |
| `{ type: 'disableToolbarOnHost', host }` | `{ ok: true }` |
| `{ type: 'pageSelection', text, title, url, truncated }` | none – sent by content scripts to all extension pages whenever their selection changes (`text: ''` = gone); the background ignores it, the side panel uses it (§8 Side panel) |
| `{ type: 'openOptions' }` | `{ ok: true }` |
| `{ type: 'recordUsage', entry: { providerId, providerName, model, usage } }` | `{ ok: true }` – adds one request to `usageStats`; extension pages only (content scripts are rejected) |

All handlers catch errors and respond `{ ok: false, error: '<German message>' }`.

### 7.2 Port `name: 'llm-stream'` (content script → background)
client → bg: `{ type: 'start', task }` then optionally `{ type: 'abort' }`.
`task = { kind: 'action', actionId, text, instruction?, previous?, page?: { title, url } }`
or `{ kind: 'translate', text, lang?, instruction?, previous?, page? }`. Refinements of a
translation ("Anpassen …") are sent as kind `translate` with `instruction` + `previous` – never as
kind `action` with id `translate`.
bg → client: `{ type: 'meta', provider: '<name>', model }`, `{ type: 'delta', delta }`
(incremental), `{ type: 'done', text, finishReason }`, `{ type: 'error', error: '<German message>', code }`.
`finishReason` is the LLM client's value (`'stop'`, `'length'`, `'refusal'`, `'content_filter'`, …
or `null`). The background aborts the fetch when the port disconnects.

### 7.3 `tabs.sendMessage` → content script
Sent with `tabs.sendMessage(tabId, message, { frameId })`: context-menu actions go to the frame the
menu was opened in (`info.frameId ?? 0`), everything else to frame 0 (top frame).
`{ type: 'ping' }` → `{ ok: true }`;
`{ type: 'runAction', actionId, text? }` (popover near selection; `text` from context menu);
`{ type: 'translateSelection', text? }`; `{ type: 'translatePage', lang? }`;
`{ type: 'restorePage' }` (both top frame only – sub-frames ignore them);
`{ type: 'getSelection', maxChars? }` → `{ ok: true, text, truncated, title, url }` (the live selection
of that frame, '' if none; never injected for this).
Responses: `{ ok: true }` / `{ ok: false, error, code? }`. The content script shows its own errors on
the page (toast), so the background sets no badge for them (`sendToTab` rejects with
`code: 'page_error'` and `pageCode` = the response's `code`). Exception: a sub-frame smaller than
120×60 px answers `{ ok: false, code: 'tiny_frame', error }` and the background retries in frame 0.

### 7.4 Selection → side panel
Each content script (not in frames below 120×60 px) reports every change of its selection with
`runtime.sendMessage({ type: 'pageSelection', text, title, url, truncated })` – only changes, text
at most 20 000 characters, `text: ''` when the selection is gone. Nothing leaves the browser: the
background ignores the message, an open side panel shows it (§8). The side panel asks the top frame
of a newly activated tab with `getSelection` (no injection).

## 8. Behaviour per component

### Background (`src/background/background.js`)
- `onInstalled`: normalize+save settings; build context menus; Chrome:
  `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`; on `reason === 'install'` open
  the options page (onboarding). Chrome, `reason` `install` or `update`: `injectIntoOpenTabs()` –
  Chrome runs declared content scripts only in pages loaded afterwards, so without it the toolbar
  is missing in every tab that was open (Firefox injects itself). `onStartup`: setPanelBehavior + rebuild menus. Also run both at
  module top level (service worker restarts). Hardening (Chrome only, feature-detect, ignore
  errors): `storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` so content scripts
  cannot read API keys.
- The background code must be service-worker safe (no `window`, DOM, `localStorage`,
  `FileReader`, dynamic `import()`); register all listeners synchronously at top level.
- All LLM requests made by the background **always stream** (`stream: true`, also
  page-translation batches; accumulate the text), whatever `general.streaming` says, so bytes keep
  flowing – Chrome kills a service worker whose fetch takes > 30 s to deliver a response.
- Background quick actions, selection translation and page translation send **no** `maxTokens`
  (provider default; the LLM client's Anthropic fallback 16000 applies). `settings.chat.maxTokens`
  is for side-panel chat requests only.
- PendingChat (§4.6): stored as `{ …payload, id, ts, windowId }` with `windowId` =
  `sender.tab.windowId` (openInChat) or `tab.windowId` (context menu / command), omitted if
  unknown; handed out only through `claimPendingChat` (atomic read + remove, window match,
  expiry 24 h for `continue`/`prefill`, 10 min for `send`).
- `openInChat` from a content-script click: Chrome allows `sidePanel.open({ tabId: sender.tab.id })`
  if it is called **synchronously first** in the `onMessage` handler (before any await). Firefox
  does NOT treat relayed content-script clicks as user actions: the PendingChat is stored anyway
  and the answer is `opened: await browser.sidebarAction.isOpen({ windowId })` – an open panel
  claims the entry right away; when it is closed the content script keeps its popover open and
  shows the hint there (see Content script).
- Firefox: `action.onClicked` → `sidebarAction.toggle()` (call synchronously, no await before).
- Context menu (root "LLM Sidebar", contexts selection/page/editable): one item per quick action
  with `contextMenu: true` (selection), "Übersetzen nach <lang>" (selection), "Im Chat fragen"
  (selection → PendingChat prefill with `quote` = live selection of that frame, `source` = tab/frame), separator, "Seite übersetzen",
  "Originalseite wiederherstellen", "Seite zusammenfassen" (PendingChat send + includePage),
  "Seitenleiste öffnen". Rebuild (debounced) when settings change. Menu actions on a selection are
  sent to the frame the menu was opened in: `sendToTab(tab.id, msg, { frameId: info.frameId ?? 0 })`
  (selections inside iframe editors get their popover and "Ersetzen" in that frame).
- Opening the panel from a user gesture (context menu / command): call
  `chrome.sidePanel.open({ tabId })` resp. `browser.sidebarAction.open()` **first, synchronously
  inside the event handler**, then do async work (write PendingChat).
- Commands: `translate-page` → `sendToTab(activeTab, { type: 'translatePage' })`, `restore-page` →
  `{ type: 'restorePage' }`, `summarize-page` → open the panel + PendingChat `send` with
  `includePage` (top frame).
- Visible failures: when a context-menu or command action cannot run (restricted page, injection
  failed, no access, no provider), the background marks the toolbar icon for that tab:
  `action.setBadgeBackgroundColor({ tabId, color: '#e5484d' })`,
  `action.setBadgeText({ tabId, text: '!' })`,
  `action.setTitle({ tabId, title: 'LLM Sidebar – <German message>' })`, cleared after 10 s
  (default title restored). Each call is feature-detected and never throws. If the content script
  is reachable it shows the message itself instead (e.g. the no-provider hint).
- Port 'llm-stream': resolve target `actions` (kind action) or `translate`, build the request with
  `lib/prompts.js`, call `streamChat` (always streaming), forward deltas, finish with
  `{ type: 'done', text, finishReason }`; abort on disconnect. Kind `translate`: target
  `resolveTarget(settings, 'translate')`, request = `buildActionRequest(translateAction, { text,
  lang, profile, instruction, previous, page })` where `translateAction` is the user's quick action
  with id `translate` if it exists, else the `translate` entry of `DEFAULT_QUICK_ACTIONS`
  (`buildTranslateRequest` is only a fallback).
- `translateSegments`: target `translate`, `buildSegmentsRequest`, streaming call,
  `parseSegmentsResponse`; if more than half are missing and segments.length > 1, split the batch
  in two and retry each half once.
- Keep the Chrome service worker alive while requests run: call `ext.runtime.getPlatformInfo()`
  every 20 s while at least one request is in flight.

### Content script (`src/content/content.js`)
- UI lives in a **closed shadow root** on a custom element `<llm-sidebar-ui>` appended to
  `document.documentElement`; host styled `all: initial; position: fixed; z-index: 2147483647`.
  All CSS inside the shadow root; light/dark via `prefers-color-scheme` (and config.theme).
- Selection toolbar: show after mouseup / keyup (shift+arrows) when the selection has at least one
  non-space char, the toolbar is enabled and the host is not disabled (settings not reachable for a
  moment → defaults, i.e. shown); position
  near the selection end, kept inside the viewport; buttons: toolbar quick actions (icon + tooltip),
  "Übersetzen", "⋯" menu (all actions, "Im Chat fragen", "Auf dieser Website ausblenden",
  "Einstellungen"). Hide on Escape, mousedown outside, selection cleared, scroll (reposition).
  Works for normal text, `<textarea>`, text `<input>` and contenteditable (remember element +
  range/offsets at selection time). If `config.ready` is false, a click shows a hint with a button
  that opens the options page.
- The toolbar must appear for every selection:
  - A focused field without own selection (email/number fields, empty text field) does not hide
    a page selection.
  - Chrome reports a selection inside a shadow tree (web components) as collapsed at its host:
    the real range comes from `Selection.getComposedRanges({ shadowRoots })` (Chrome 137+), else
    `ShadowRoot.getSelection()`, walking through the shadow roots on the way. Closed roots are
    reached with `chrome.dom.openOrClosedShadowRoot` / `element.openOrClosedShadowRoot`.
  - A swallowed pointerup/mouseup (page listener with `stopImmediatePropagation`) or a release
    outside the window: the next `pointermove` without pressed button (or `click`) ends the press.
    `pointercancel` also checks the selection.
  - A selection without geometry is placed where the pointer released it, else at its element.
  - Every check also reports the selection to the side panel (§7.4).
- Frames (`all_frames: true`): in a sub-frame (`window.top !== window`) selection toolbar,
  popover and replace work as usual, `translatePage` / `restorePage` are ignored (top frame only),
  and in frames smaller than 120×60 px the script stays idle (no UI, no listeners beyond cheap
  selection handling).
- Orphaned instances (extension reloaded/updated): an old instance detects `!ext.runtime?.id` and
  tears down its UI and listeners; a newly injected instance takes over.
- Result popover: header (action icon+name, provider · model, close), streaming result
  (`white-space: pre-wrap`), footer buttons: Kopieren, Ersetzen (only when the selection came from
  an editable element: textarea/input via `setRangeText` + `input` event, contenteditable via
  restoring the range + `execCommand('insertText')` with fallback), Erneut, Im Chat fortsetzen
  (`openInChat` kind `continue`; "Im Chat fragen" sends kind `prefill` with `quote`; it closes the popover only when `opened` is true – otherwise
  the popover stays open and shows the hint "Öffne die Seitenleiste über das LLM-Sidebar-Symbol –
  der Chat wartet dort."; same for "Im Chat fragen"), plus a small input "Anpassen … (z. B.
  kürzer)" that re-runs with `instruction` + `previous` (translations as kind `translate`, §7.2).
  On `done` it shows a small note under the result when `finishReason === 'length'` ("Die Antwort
  wurde wegen der Längenbegrenzung abgeschnitten.") or `'refusal'` / `'content_filter'` ("Das
  Modell hat die Anfrage abgelehnt."); for refusals "Ersetzen" is disabled. Draggable by its
  header, closes on Escape.
- Page translation: collect visible text nodes (skip script/style/noscript/template/code/pre/
  kbd/samp/textarea/input/select/option/svg/math/iframe, `[contenteditable]`, `[translate=no]`,
  `.notranslate`, our own host, nodes with < 2 letters); viewport nodes first; batches of
  `batchChars`; `translateSegments` with `translate.concurrency` parallel requests; replace
  `nodeValue` preserving leading/trailing whitespace; keep originals in a `Map` for restore; also
  translate `placeholder`/`title`/`alt` attributes of visible elements (optional). Floating status
  pill (bottom-right): progress "Übersetze … 40 %", then "Übersetzt nach Deutsch" with buttons
  "Original" ⇄ "Übersetzung" and ×. A `MutationObserver` translates newly added content while the
  translation is active (debounced 800 ms). Errors are shown in the pill.

### Side panel (`src/sidepanel/*`)
- Header: history button, chat title (click → rename), "Neuer Chat", tools menu (⋯: Seite
  übersetzen, Original wiederherstellen, Seite zusammenfassen, Chat als Markdown exportieren,
  Chat löschen), settings button (opens options).
- Sub-header: model picker (searchable dropdown grouped by provider, from `listChatModels`;
  selection is stored on the chat and as `defaults.chat`), persona picker, "Seite" chip toggle
  (shows the active tab's title/host; when on, the page content is fetched with `getPageContent`
  at send time and stored as `message.context` + `message.page`).
- Empty state: greeting + `SUGGESTIONS` chips; when no provider is ready, an onboarding card with a
  button to the options page. If `permissions.contains({ origins: ['<all_urls>'] })` is false
  (Firefox temporary installs / revoked access), show a prominent banner at the top (also on first
  run) "Die Erweiterung braucht Zugriff auf Webseiten und KI-Anbieter" with a "Zugriff erlauben"
  button calling `permissions.request(...)` from the click.
- The side panel performs its own LLM requests directly (extension page, lives as long as the
  panel is open) – it does not route chat requests through the background.
- Messages: user and assistant bubbles, markdown for assistant, attachments thumbnails, generated
  images with download/open buttons, collapsible "Gedankengang" for reasoning, error bubble with
  "Erneut versuchen". Hover actions: Kopieren, Bearbeiten (user → edit & resend, drops later
  messages), Neu generieren (last assistant), Löschen. Auto-scroll while streaming unless the user
  scrolled up.
- Composer: auto-growing textarea, Enter sends (Shift+Enter newline; configurable), image attach
  (button, paste, drag & drop; downscale large images to max 1600 px JPEG/PNG), image-generation
  mode toggle (🖼; uses `resolveTarget(settings,'image')`, shows a small image-model picker), page
  toggle, send ⇄ stop button. `/bild <prompt>` or `/image <prompt>` triggers image generation.
- History drawer: search, groups via `formatDateGroup`, pinned first, rename/pin/delete, export
  all chats (JSON via `serializeChatsExport`, import via `parseChatsImport`), delete all.
- Requests: built from the last `settings.chat.contextMessages` messages (`context` and then
  `formatSelectionQuote(quote)` are prefixed to the user content), system prompt from `buildChatSystemPrompt`
  (`settings.chat.maxTokens` applies here). Saves the chat after every completed (or
  failed/stopped) assistant message; title = first user message truncated to 48 chars.
- Page selection as reference: `pageSelection` messages (§7.4) from the active tab of the panel's
  window (other windows and inactive tabs are ignored) show the selection above the composer
  ("Markierter Text · <page>", × to dismiss; the placeholder becomes "Frag etwas zum markierten
  Text …"). The next chat message takes it as `message.quote` (shown as quote with source, sent
  via `formatSelectionQuote` before the text) – once: a sent or dismissed selection is not offered
  again until that frame reports a different or no selection. `text: ''` from the same frame, a
  navigation or a closed tab removes it; on a tab switch the panel asks the new tab's top frame
  (`getSelection`). Image mode hides it and does not use it. A PendingChat prefill with `quote`
  ("Im Chat fragen") sets it the same way.
- PendingChat: claimed via `claimPendingChat` with its own window id on load and on
  `storage.onChanged` for `pendingChat` (§4.6); while an answer streams the claimed entry is queued
  and applied afterwards.
- Chats changed elsewhere (`onChatsChanged`, §5 lib/db.js): current chat deleted/cleared → switch
  to a fresh unsaved chat (abort a running stream first and do not save it again); current chat
  saved elsewhere with a newer `updatedAt` and nothing streaming → reload it from the DB; refresh
  the history drawer on every event. Before `saveChat`, a chat that was saved once but no longer
  exists in the DB is not resurrected. The "resume last chat" key is per window (includes the
  window id).
- Reacts to `onSettingsChanged` (model list, theme), active tab changes (`tabs.onActivated`,
  `tabs.onUpdated`), PendingChat and chat broadcasts.

### Options (`src/options/*`)
Left navigation with sections: **Anbieter**, **Standardmodelle**, **Kosten & Guthaben**, **Chat & Personas**,
**Schnellaktionen**, **Übersetzung & Toolbar**, **Personalisierung**, **Darstellung**,
**Daten & Datenschutz**, **Über**. Autosave (debounced 400 ms) with a small "Gespeichert" toast.
- Anbieter: one card per provider (avatar letter with preset color, name, status badge
  "Bereit" / "Kein Schlüssel" / "Deaktiviert", enable toggle, API key field with show/hide and
  link "Schlüssel erstellen ↗" (`keyUrl`), "Verbindung testen", "Modelle laden" (`listModels` →
  fills `models`, `imageModels` (ids that look like image models or `imageOutput`), `modelInfo`),
  model chips with remove + manual add, default model select, image API + default image model,
  advanced: base URL, extra headers (JSON), reset to preset). "Eigenen Anbieter hinzufügen"
  (name, base URL, protocol). Custom providers can be deleted.
- Standardmodelle: Chat, Schnellaktionen, Übersetzung, Bildgenerierung – each a select of
  `listChatModels`/`listImageModels` plus "Automatisch".
- Chat & Personas: global system prompt, persona list editor, default persona, temperature
  (empty = Standard), max tokens, context messages, page-by-default, send-with-Enter, streaming.
- Schnellaktionen: list editor (emoji, name, prompt template, toolbar/context-menu checkboxes,
  move up/down, delete, add), "Standard wiederherstellen", variable help.
- Übersetzung & Toolbar: target language (LANGUAGES + free text), batch size, concurrency,
  toolbar enabled, disabled hosts (one per line).
- Personalisierung: profile.aboutMe, profile.writingStyle, useProfileInChat.
- Darstellung: theme (System/Hell/Dunkel).
- Daten & Datenschutz: privacy statement, export settings (with/without keys – the UI says that
  "without keys" also drops header values but includes the profile "Über mich" / "Schreibstil"),
  import settings, export/import chats (`serializeChatsExport` / `parseChatsImport`), delete all
  chats, reset everything; host-permission check with a "Zugriff erlauben" button
  (`permissions.request({ origins: ['<all_urls>'] })`) – needed in Firefox.
- Host-permission onboarding: while `<all_urls>` is not granted (first run in Firefox), a
  prominent banner at the top of the page with "Zugriff erlauben".
- Über: version (`runtime.getManifest().version`), keyboard shortcuts (`commands.getAll`; commands
  without a key show "Nicht festgelegt"), hint how to change them (Chrome:
  chrome://extensions/shortcuts, Firefox: about:addons → Zahnrad).

## 9. Allowed browser APIs (emulated by `dev/ext-shim.js`)
`runtime`: `id, getURL, getManifest, sendMessage, onMessage, connect, onConnect, openOptionsPage,
onInstalled, onStartup, getPlatformInfo, lastError` · `storage.local|session`: `get, set, remove,
clear`, `storage.onChanged` · `tabs`: `query, get, create, sendMessage` (with
`{ frameId }`), `onActivated, onUpdated` · `scripting.executeScript` (`func`+`args` or `files`;
`target: { tabId, frameIds? }`) · `contextMenus`: `create, removeAll, onClicked` · `commands`:
`onCommand, getAll` · `action`: `onClicked, setBadgeText, setBadgeBackgroundColor, setTitle`
(always `{ tabId, … }`) · `sidePanel`: `setPanelBehavior, open` (Chrome only – feature-detect) ·
`sidebarAction`: `open, toggle, isOpen` (Firefox only – feature-detect; not emulated, the harness
behaves like Chrome) · `permissions`: `contains, request` · `windows.getCurrent`.

## 10. Design tokens (`src/styles/theme.css`)
CSS custom properties on `:root` (light) with dark overrides for
`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` and
`:root[data-theme="dark"] {…}`:
`--bg, --bg-elev, --bg-sunken, --bg-hover, --border, --border-strong, --text, --text-muted,
--text-faint, --accent, --accent-hover, --accent-contrast, --accent-soft, --danger, --danger-soft,
--success, --success-soft, --warning, --radius-lg (14px), --radius (10px), --radius-sm (6px),
--shadow-sm, --shadow, --shadow-lg, --font, --mono, --focus-ring`.
Accent: violet `#6d5efc` (dark: `#8b7fff`).
Shared classes: `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.btn-icon`, `.btn-sm`,
`.input`, `.textarea`, `.select`, `.switch` (checkbox toggle: `<label class="switch"><input
type="checkbox"><span></span></label>`), `.card`, `.chip`, `.chip.active`, `.badge`,
`.badge-success|warning|danger`, `.muted`, `.row`, `.stack`, `.spacer`, `.divider`, `.kbd`,
`.spinner`, `.toast-container`/`.toast`, `.dialog-backdrop`/`.dialog`, `.menu`/`.menu-item`
(dropdown menus), `.md` (markdown typography incl. `.code-block`, tables, blockquotes), custom
thin scrollbars. Base font size 14px, `color-scheme: light dark`.

## 11. Dev harness (`dev/`)
`node dev/server.mjs` → http://localhost:8787
- Serves `/src/**` and `/dev/**`. For every HTML file it injects
  `<script src="/dev/ext-shim.js"></script>` as the first element of `<head>`.
- Mock OpenAI-compatible API at `/mock/v1`: `GET /models`, `POST /chat/completions` (streams the
  answer in small SSE chunks with ~20 ms delay; if lines of the last user message **start** with
  a `[[n]]` marker it answers each such line with `[[n]] [DE] <text>` – markers in the middle of a
  line (e.g. in a prompt header) are ignored; otherwise "**Mock-Antwort** auf: …" plus a short
  markdown sample incl. a code block; supports `stream:false`; emits `delta.reasoning_content`
  first when the prompt contains "denk"), `POST /images/generations` (returns a small generated
  PNG as `b64_json`). Further triggers: `#langsam` (3 s delay), `#ablehnen` (refusal:
  `finish_reason: 'content_filter'`), `#abschneiden` (cut-off answer: `finish_reason: 'length'`;
  a `max_tokens` / `max_completion_tokens` smaller than the answer does the same), `#fehler<status>`
  (HTTP error), `#fehlerstream` (error in the middle of the stream).
- Mock Anthropic API at `/mock-anthropic/v1`: `POST /messages` (SSE event sequence; same triggers,
  stop reasons `refusal` / `max_tokens`) and `GET /models`.
- `dev/harness.html`: left iframe `test-page.html` (tab id 1), right iframe
  `/src/sidepanel/sidepanel.html` (≈ 400 px), hidden iframe `bg.html` (loads background.js as
  module), a button to open `/src/options/options.html` and the extension's toolbar icon, which
  shows the badge text/colour and title set via `action.*` for tab 1 (a new badge also raises a
  notice with the title). Inside the harness the test page is an iframe, so content.js sees
  `window.top !== window` and behaves as a sub-frame (no page translation, §8); "Test-Seite als
  Tab" opens it as a top-level tab, which then receives all tab-1 messages until it is closed.
- `dev/ext-shim.js` emulates §9 for three roles detected from the URL path: background
  (`/dev/bg.html`), content (`/dev/test-page.html`, which also loads `/src/content/content.js`),
  extension page (everything under `/src/`). Cross-frame/tab messaging via `BroadcastChannel`;
  `storage` backed by `localStorage` (prefix `shim:`) with `onChanged` broadcast;
  `scripting.executeScript({func,args})` executes in the test page; `{files}` is a no-op (the test
  page already loads the content script); `tabs.query` returns the test page tab
  `{ id: 1, windowId: 1, url, title, active: true }`, `windows.getCurrent()` window 1. The tab has
  one frame (frameId 0): `tabs.sendMessage(…, { frameId })` and `executeScript` with
  `target.frameIds` fail for any other frame like in Chrome. `tabs.create` / `openOptionsPage`
  always open a **new** browser tab through the harness window and only while it has transient
  user activation (a click in the side panel or test page); otherwise (e.g. the onboarding open
  after `?reset=1`) the harness shows a notice with a link instead, so the harness is never
  replaced. On first load it seeds settings with an
  enabled "Mock (lokal)" custom provider (`baseUrl: http://localhost:8787/mock/v1`,
  models `['mock-chat','mock-reasoner']`, imageApi `openai-images`, imageModels `['mock-image']`)
  and an enabled Anthropic-protocol mock (`http://localhost:8787/mock-anthropic/v1`), unless
  settings already exist. `?reset=1` on harness.html clears shim storage.
