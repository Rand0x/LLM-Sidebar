# Anthropic (Claude) and Google Gemini: API facts for a BYOK browser extension (checked 2026-11-03)

Sources are primary docs unless marked otherwise. Items marked **probed** come from live `curl` calls I made today with a fake key, so no paid requests were sent.

---

## 1. Anthropic Messages API

### Endpoint and headers
- `POST https://api.anthropic.com/v1/messages` ([create](https://platform.claude.com/docs/en/api/messages/create)). The docs now live on platform.claude.com.
- Headers:
  - `content-type: application/json`
  - Auth: `x-api-key: <key>` **or** `Authorization: Bearer <key>`. "The Claude API accepts a key in either header." The new SDKs send Bearer ([migration 2026-10-21](https://platform.claude.com/docs/en/api/migration-2026-10-21)).
  - `anthropic-version: 2026-10-21`. This is the current version and the default in the new SDKs. `2023-06-01` is still accepted ([versioning](https://platform.claude.com/docs/en/api/versioning)).
  - `anthropic-dangerous-direct-browser-access: true`. Send it on every request from the extension.
  - `anthropic-beta: <ids>`, only for beta features.

**How the browser header works**
- The official TS SDK adds `anthropic-dangerous-direct-browser-access: 'true'` when `dangerouslyAllowBrowser` is set ([client.ts](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts)).
- If a request carries an `Origin` header but not this header, the API rejects it with `CORS requests must set 'anthropic-dangerous-direct-browser-access' header`. Users saw this in a Chrome/Firefox extension ([chatGPTBox #788](https://github.com/ChatGPTBox-dev/chatGPTBox/issues/788), [Willison](https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access)).
- **Probed:**
  - The preflight from `chrome-extension://` and `moz-extension://` returns 200 with `access-control-allow-origin: *` and allows `x-api-key, authorization, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access`.
  - On the real request, `access-control-allow-origin: *` and `access-control-expose-headers: *` are present only when the header is sent. The response carries `vary: ..., anthropic-dangerous-direct-browser-access`.
  - With a bad key, the auth check runs first and returns `401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_..."}` (also for Bearer). Test the CORS path with a real key.

### Breaking changes in API version 2026-10-21 (Messages)
- Sending `temperature`, `top_p` or `top_k` returns **400 on every model**, even at the default value. On `2023-06-01`, Claude 4.7 and later still reject non-default values. **The adapter must remove all sampling parameters.**
- A `document` block directly in an `assistant` message returns 400.
- A `text` block with non-empty `citations` in a `user` message returns 400.

### Request body
```json
{
  "model": "claude-sonnet-5-5",
  "max_tokens": 16000,
  "stream": true,
  "system": "You are ...",
  "thinking": {"type": "adaptive", "display": "summarized"},
  "output_config": {"effort": "medium"},
  "messages": [{"role": "user", "content": [
    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "<b64, no newlines>"}},
    {"type": "text", "text": "Improve this text: ..."}
  ]}]
}
```

**Fields**
- `max_tokens` is **required**. Minimum is 0 (0 only warms the cache). Thinking tokens count toward it. The maximum output is 128K on all current models; use streaming for large values.
- `system` is a string or an array of `{"type":"text","text":...,"cache_control"?}`. Claude 5.x models also accept `{"role":"system"}` messages appended to `messages`, which change instructions mid-chat without editing the history.
- `messages` alternate `user`/`assistant` turns.
- Other fields: `stop_sequences`, `metadata.user_id`, `tools`, `tool_choice`, `output_config.format` (JSON schema).

**Image blocks** ([vision](https://platform.claude.com/docs/en/build-with-claude/vision))
- `source` is either `{"type":"base64","media_type":...,"data":...}` or `{"type":"url","url":...}`.
- Allowed types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
- Size limits: 10 MB per image (base64) on the Claude API, 8000×8000 px maximum, up to 600 images, 128 MB per request.
- With more than 20 images, a stricter per-image limit applies. Keep each side at 3000 px or less.
- Put images before the text.

**Claude has no image-generation endpoint.** Route image generation to other providers.

### Non-streaming response
```json
{"id":"msg_...","type":"message","role":"assistant","model":"claude-opus-5-5",
 "content":[{"type":"thinking","thinking":"","signature":"..."},{"type":"text","text":"..."}],
 "stop_reason":"end_turn","stop_sequence":null,"stop_details":null,
 "usage":{"input_tokens":2095,"output_tokens":503,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,
          "output_tokens_details":{"thinking_tokens":0},"service_tier":"standard","speed":"standard"}}
```
- `stop_reason` is one of `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`, `model_context_window_exceeded`.
- A refusal comes back as **HTTP 200** with `stop_details: {"type":"refusal","category":"cyber|bio|frontier_llm|reasoning_extraction|general_harms|null","explanation":"..."}`.

### Streaming (SSE) ([streaming](https://platform.claude.com/docs/en/build-with-claude/streaming))
Event order: `message_start` → for each block (`content_block_start` → `content_block_delta`* → `content_block_stop`) → `message_delta`(s) → `message_stop`. `ping` events can appear anywhere. **Ignore event types you don't recognise.** There is no `[DONE]` event.
```
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"..."}}
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQB..."}}
event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ello frien"}}
event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\": \"San Fra"}}
event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":89}}
event: message_stop
data: {"type":"message_stop"}
event: error
data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
```
- `message_delta.usage` counts are **cumulative**. `message_delta.delta` can also carry `stop_details`. There is also a `citations_delta` type.
- With `display: "omitted"` (the default), a thinking block streams one empty `thinking_delta` plus a `signature_delta`, so the UI looks stalled.
- **Errors:** before the stream starts, errors are JSON `{"type":"error","error":{"type,message"},"request_id"}`.

| Status | Error type | Retry? |
|---|---|---|
| 400 | `invalid_request_error` | no |
| 401 | `authentication_error` | no |
| 402 | `billing_error` | no |
| 403 | `permission_error` | no |
| 404 | `not_found_error` | no |
| 413 | `request_too_large` | no |
| 429 | `rate_limit_error` | yes, honour `retry-after` |
| 500 | `api_error` | yes |
| 529 | `overloaded_error` | yes |

A `x-should-retry` header is present (**probed**).

### Thinking rules per model ([thinking](https://platform.claude.com/docs/en/build-with-claude/thinking))
- Thinking is on by default on all 5.x models. `{"type":"enabled","budget_tokens":N}` returns 400.
- Turning it off:
  - **Opus 5.5 / Fable 5.1:** can't be disabled (`disabled` returns 400). Use `output_config.effort` to control it.
  - **Sonnet 5.5:** `disabled` returns 400. Use `{"type":"between_tools"}` at effort `high` or lower. It takes no other field.
  - **Haiku 5.5:** `{"type":"disabled"}` works at effort `high` or lower.
- `display` can be `summarized`, `omitted` (default) or `updates` (beta). `display` is invalid together with `disabled` or `between_tools`.
- Effort levels are `low|medium|high|xhigh|max`. Default effort per model is in the model table below.
- Assistant **prefill** (last message is `assistant`) returns 400 on 4.6 and later. Don't build rewrite features on prefill.
- Changing the thinking config or effort invalidates the prompt cache.

### Gotcha: preserved thinking (affects edit, regenerate and model switching)
([thinking § Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/thinking), [preserved-thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking))
- Each thinking block's `signature` is bound to the exact earlier history: top-level `system`, `tools`, and all earlier messages. Accounts created **on or after 2026-08-31** get **400** if the history changed: `messages.N.content.0: Invalid signature in thinking block. The block is bound to a different conversation...`. This applies on Claude 5.1+ models, including Opus 5.5.
- What breaks it: editing or deleting an earlier message, rebuilding `system` or `tools` per request, or injecting per-request text into old turns.
- Fixes, any one of:
  1. Keep the history append-only.
  2. When the user edits history, **strip all `thinking`/`redacted_thinking` blocks** and resend.
  3. Use beta `anthropic-beta: thinking-binding-controls-2026-08-01` with `"thinking":{"type":"adaptive","block_binding":{"prefix_mismatch_behavior":"drop_block"}}`. Drops are reported in `input_transformations`.
- Switching models mid-chat: blocks the new model can't read are **dropped silently**, with no error and no billing. Keep passing them back unchanged.
- Sonnet 5.5 and Haiku 5.5 blocks only work in the account that produced them, so a user who switches API keys loses them.

### Models
- `GET /v1/models?limit=1000` (default 20, maximum 1000; `after_id`/`before_id`; `lifecycle=active|deprecated|retired`). By default the list includes active and deprecated models ([list](https://platform.claude.com/docs/en/api/models/list)).
- Each item: `{type:"model", id, display_name, created_at, lifecycle, line ("opus"|"sonnet"|"haiku"|"fable"|"mythos"|null), max_input_tokens, max_tokens, deprecated_at, retires_at, capabilities{image_input, pdf_input, thinking{types{adaptive,enabled,disabled,between_tools}}, effort{low..max}, structured_outputs, server_tools, ...}}`.
- Envelope: `{data, first_id, last_id, has_more}`.
- Use `capabilities` to detect features instead of hard-coding them.

### Current model IDs ([models overview](https://platform.claude.com/docs/en/about-claude/models/overview))
All four current models have 1M context and 128K max output. IDs carry no date suffix and are pinned snapshots; there is no `-latest` alias.

| ID | Price per MTok (in / out) | Default effort |
|---|---|---|
| `claude-fable-5-1` (top tier) | $10 / $50 | high |
| `claude-opus-5-5` | $4 / $20 | medium |
| `claude-sonnet-5-5` | $2 / $10 | high |
| `claude-haiku-5-5` | from $0.10 / $0.50 | medium |

- Legacy, still served: `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5-20251101`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`.
- `claude-sonnet-4-5` reaches end of life on 2026-11-30.
- `claude-mythos-5-1` is restricted to Project Glasswing.

---

## 2. Gemini OpenAI-compatible endpoint

The docs moved: `ai.google.dev/gemini-api/docs/openai` now returns 301 to [aistudio.google.com/docs/openai](https://aistudio.google.com/docs/openai).

### Basics
- Base URL `https://generativelanguage.googleapis.com/v1beta/openai/`, auth `Authorization: Bearer <GEMINI_API_KEY>`.
- Endpoints:
  - `chat/completions`, with streaming: `"stream":true`, `stream_options.include_usage`.
  - `embeddings`, `images/generations`, `batches`.
  - `GET models` and `GET models/{id}`.
  - Audio input works as an `input_audio` part in chat.
  - No Files upload; video is not supported on `/v1/videos`.
- **CORS (probed):** the preflight reflects any Origin (`chrome-extension://…`, `moz-extension://…`) with `authorization,content-type`. No special header is needed.

### Chat request
```json
{"model":"gemini-3.8-flash","stream":true,"stream_options":{"include_usage":true},
 "reasoning_effort":"low",
 "messages":[{"role":"system","content":"..."},
   {"role":"user","content":[{"type":"text","text":"What is in this image?"},
     {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,..."}}]}]}
```
- You can set thinking through `extra_body` instead of `reasoning_effort`, **not both**. In raw REST this is a literal top-level `"extra_body"` key:
  - `"extra_body":{"google":{"thinking_config":{"thinking_level":"low","include_thoughts":true}}}`
  - Other `extra_body.google` keys: `cached_content`, plus `aspect_ratio`, `generation_config`, `safety_settings`, `tools` for images.
- Streaming chunks follow the OpenAI shape (`choices[0].delta.content`). The docs don't show the raw SSE.
- `reasoning_effort` maps to:

| `reasoning_effort` | Gemini 4 Argon (`thinking_level`) | Gemini 3 Flash / 3.1 Flash-Lite (`thinking_level`) | Gemini 2.5 (`thinking_budget`) |
|---|---|---|---|
| `minimal` | low | minimal | 1024 |
| `low` | low | low | 1024 |
| `medium` | medium | medium | 8192 |
| `high` | high | high | 24576 |

- `"none"` turns thinking off **only on 2.5 Flash-family models**; 2.5 Pro and Gemini 3+ can't turn it off.
- Function calling uses the OpenAI `tools`/`tool_choice` shape. Gemini 3 returns `extra_content.google.thought_signature` on tool calls, and you must echo the assistant message back with `extra_content` unchanged ([Vertex compat doc](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-gemini-using-openai-library); a community report says streamed `tool_calls` may lack `index`).

### Image generation through the compat layer
`POST .../openai/images/generations`
```json
{"model":"gemini-2.5-flash-image","prompt":"...","response_format":"b64_json","n":1,"size":"1024x1024"}
```
- The response has `data[i].b64_json`.
- Supported fields: only `prompt`, `model`, `n`, `size`, `response_format`. Anything else is **silently ignored** unless it goes in `extra_body` (`aspect_ratio` like "16:9", `generation_config`, `safety_settings`; `tools:[{"google_search":{}}]` only on the pro image model).
- **The docs are stale here.** They name `gemini-2.5-flash-image` (shuts down 2027-03-15) and `gemini-3-pro-image-preview`, which was **shut down on 2026-06-25** ([deprecations](https://aistudio.google.com/docs/deprecations)).
- **Imagen is gone:** `imagen-4.0-generate-001` shut down on 2026-08-17. Don't use `/images/generations` with Imagen.
- Current image models ([image-generation](https://aistudio.google.com/docs/image-generation)):
  - `gemini-nano-banana-2.1` (Oct 2026, recommended)
  - `gemini-3.1-flash-image` (Nano Banana 2)
  - `gemini-3.1-flash-lite-image` (Nano Banana 2 Lite)
  - `gemini-3-pro-image` (Nano Banana Pro)
- **Native fallback (Interactions API):**
  - `POST https://generativelanguage.googleapis.com/v1beta/interactions` with headers `x-goog-api-key` and `Api-Revision: 2026-05-20`.
  - Body: `{"model":"gemini-nano-banana-2.1","input":[{"type":"text","text":"..."}]}`.
  - Response: `{"steps":[{"type":"model_output","content":[{"type":"image","data":"<b64>","mime_type":"image/png"}]}],"status":"completed","object":"interaction"}`.
  - **Probed:** a preflight that includes `api-revision` gets **403**. This only matters in contexts where CORS applies.

### Current Gemini chat model IDs ([models](https://aistudio.google.com/docs/models))
- `gemini-4-argon` ([latest-model](https://aistudio.google.com/docs/latest-model)):
  - Flagship, stable, Oct 2026.
  - 1,048,576 tokens shared by input and output; 65,536 default max output, up to 1M with background long decode.
  - Thinking `low|medium|high`, default medium.
  - Text output only. Explicit caching (`cached_content`) is unsupported.
  - Price $2/$10 per MTok until 2026-11-30, then **$4/$20**.
  - Docs say to set client timeouts to at least 15 minutes.
- `gemini-3.8-flash` ([whats-new-3.8](https://aistudio.google.com/docs/whats-new-gemini-3.8)):
  - 2026-09-02; 1M context / 64K output.
  - Thinking `low|medium|high`, default medium. **`minimal` returns an error.**
  - Introductory price $0.75/$3.75 through the end of 2026.
- `gemini-3.6-flash` and `gemini-3.5-flash-lite` (stable, both 2026-07-21).
- `gemini-3.1-flash-lite` (shuts down 2027-05-07).
- Previews: `gemini-3.1-pro-preview`, `gemini-3-flash-preview`.
- Auto-routed old IDs:
  - `gemini-3.7-flash` → `gemini-3.8-flash`
  - `gemini-3.5-flash` → `gemini-3.6-flash`
  - From 2026-12-01: `gemini-2.5-pro` → `gemini-3.8-flash` and `gemini-2.5-flash` → `gemini-3.5-flash-lite`
- 2.5 models are limited to existing users.
- Shut down: `gemini-3-pro-preview`, `gemini-2.0-flash*`.

### Gemini gotchas
- **Error shape (probed):** errors from `chat/completions` come wrapped in a JSON **array**, `[{"error":{"code":400,"message":"Please pass a valid API key","status":"INVALID_ARGUMENT"}}]`, even with `stream:true`. `models` and `images` return a plain object. A bad key gives **400, not 401**. `GET /models` without a key returns 404 NOT_FOUND. Parse errors defensively.
- **API keys** ([api-key](https://aistudio.google.com/docs/api-key)): unrestricted standard keys are rejected (403). Since 2026-05-28, new AI Studio keys are "auth keys". Dormant unrestricted keys have been blocked since 2026-05-07. Show this guidance in the UI on a 403.
- **Sampling parameters:** from Gemini 3.6 on, `temperature`, `top_p` and `top_k` are deprecated and ignored. Google says future model generations will return 400 ([3.6 API changes](https://aistudio.google.com/docs/whats-new-gemini-3.6#api-changes-and-parameter-updates)), so don't send them. `n>1` / `candidate_count` is unsupported on Gemini 3+.
- **Prefill:** a request whose last turn is a non-empty model (`assistant`) turn returns 400.
- **Unsupported parameters** are silently ignored (Vertex doc), so a request can succeed without doing what you asked.
- Google labels OpenAI compatibility "still in beta". Native docs now favour the Interactions API.

## Open questions
- Gemini compat: exact raw SSE chunk format for chat/completions (object/id fields, whether it ends with `data: [DONE]`) - not shown in docs and needs a real key to confirm.
- Gemini compat: how thoughts are returned when include_thoughts=true (delta.reasoning_content vs `<thought>` tags vs extra_content.google.thought) - undocumented for AI Studio; the Vertex docs mention `thought_tag_marker` and `extra_content.google.thought`.
- Gemini compat: does `/images/generations` accept the current image models (gemini-nano-banana-2.1, gemini-3.1-flash-image, gemini-3.1-flash-lite-image, gemini-3-pro-image)? The docs list only gemini-2.5-flash-image and the shut-down gemini-3-pro-image-preview.
- Gemini compat: can chat/completions with an image model plus `modalities:["text","image"]` return images on the AI Studio endpoint? The Vertex docs list `modalities` as supported; AI Studio docs say nothing.
- Gemini compat: exact `GET /openai/models` response shape. Likely `{object:"list",data:[{id,object,owned_by}]}`, possibly with ids prefixed `models/` (strip if present) - not verified.
- Gemini: do the new 'auth keys' behave the same with `Authorization: Bearer` on the compat endpoint? Assumed yes, not tested.
- Anthropic: with a real key, the exact status and message when `Origin` is present without `anthropic-dangerous-direct-browser-access`. Reported as 401 'CORS requests must set ...'; a fake key fails auth first, so I could not reproduce it.
- Anthropic: should the extension send `anthropic-version: 2026-10-21` (current; temperature/top_p/top_k return 400 on every model) or `2023-06-01` (still accepted; non-default sampling values are still rejected on Claude 4.7 and later)? Either way the adapter should drop sampling parameters for Claude.
- Edit/regenerate UX vs preserved thinking: should the extension strip thinking blocks whenever the user edits history (simple, loses the earlier reasoning), or adopt the `thinking-binding-controls-2026-08-01` beta with `drop_block`?
- Long-running requests (Opus 5.5 / Fable 5.1 at high effort, Gemini 4 Argon can take minutes): should streaming fetches run in the side-panel page rather than the MV3 service worker because of worker lifetime limits? Not researched here.
