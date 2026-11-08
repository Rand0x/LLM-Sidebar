# OpenAI and xAI (Grok) API findings (verified 2026-11-03)

Sources are official docs at developers.openai.com and docs.x.ai. The CORS and error-shape findings come from live `curl` probes I ran today against api.openai.com and api.x.ai, using an invalid key and no real credentials.

---

## 0. CORS and Origin (both providers, tested live)

**Neither provider needs a special browser header.** Anthropic needs `anthropic-dangerous-direct-browser-access`; OpenAI and xAI do not.

- **OpenAI:**
  - A preflight `OPTIONS /v1/chat/completions` with `Origin: chrome-extension://…` returned `200`.
  - It echoed `Access-Control-Allow-Origin: chrome-extension://…`, `access-control-allow-headers: authorization,content-type` and `access-control-allow-methods: GET, OPTIONS, POST`.
  - Actual responses carry `Access-Control-Allow-Origin: *`.
  - Requests with an `Origin` header (chrome-extension and moz-extension) are not rejected.
- **xAI:**
  - Preflight returns `access-control-allow-origin: *`, `allow-methods: *` and `allow-headers: *`, for both `/v1/chat/completions` and `/v1/images/generations`.
  - Responses also carry `access-control-expose-headers: *`.
- **Error shapes differ, so normalize them:**
  - OpenAI, bad key: HTTP **401** `{"error":{"message":"Incorrect API key provided…","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}`
  - OpenAI, missing key: 401 `"Missing bearer authentication in header"`
  - xAI, bad key: HTTP **400** (not 401) `{"code":"invalid-argument","error":"Incorrect API key provided…"}`. Here `error` is a **string**.
  - xAI, missing key: 401 `{"code":"unauthenticated:no-credentials","error":"No credentials presented."}`

---

## 1. OpenAI Chat Completions: `POST https://api.openai.com/v1/chat/completions`

Auth header: `Authorization: Bearer <key>`. Reference: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create

### Status
- **Chat Completions is not deprecated.** The deprecations page lists no shutdown for it. The Assistants API is the one being removed (Aug 26, 2026). https://developers.openai.com/api/docs/deprecations
- **Responses (`/v1/responses`) is recommended** for "better model intelligence and performance". https://developers.openai.com/api/docs/guides/reasoning
- **All current models list `v1/chat/completions` as supported:** `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna`.
- **Tool calling is the catch:**
  - "GPT-6 Astra, GPT-6.1 Sol, and GPT-6.1 Terra support Chat Completions, but tool calling requires Responses."
  - GPT-6 Sol and GPT-6 Luna support function calling in Chat Completions only with `reasoning_effort: "none"`.
  - Source: https://developers.openai.com/api/docs/guides/latest-model
  - Plain chat, rewrite and translate work fine on Chat Completions. Any future tools or agent features should go through Responses.

### Streaming (SSE)
- Request `"stream": true`. To get token usage, add `"stream_options": {"include_usage": true}`.
- Each event is a `data: {json}` line, with `object: "chat.completion.chunk"`:
  ```
  data: {"id":"…","object":"chat.completion.chunk","created":…,"model":"…","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}],"usage":null}
  data: {…"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]…}
  data: {…"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]…}
  data: {…"choices":[],"usage":{"prompt_tokens":…,"completion_tokens":…,"total_tokens":…}}   // only with include_usage
  data: [DONE]
  ```
- The usage chunk always has `choices: []`, so guard `choices[0]`. It may be missing if the stream is interrupted.
- `usage` is `null` on every other chunk.
- Optional `stream_options.include_obfuscation` adds an `obfuscation` field. Ignore it.
- Chat Completions does not stream reasoning text from OpenAI reasoning models. You only get `content`.

### Parameter rules (current GPT-6 and other reasoning models)
- **`max_tokens`:** deprecated, and "not compatible with o-series models". Always send **`max_completion_tokens`**, which includes reasoning tokens.
- **`temperature`, `top_p`, `top_logprobs` and `logprobs`:** "When reasoning effort is not `none`, remove `temperature`, `top_p`, and `top_logprobs`… For Chat Completions, also remove `logprobs`."
  - `gpt-6-astra` and `gpt-6.1-sol` **do not support `none`**, so never send these to them. The Sep 3 changelog says Astra doesn't support custom temperature, top_p or logprobs.
  - Sources: https://developers.openai.com/api/docs/guides/latest-model and https://developers.openai.com/api/docs/changelog
- **`reasoning_effort`:** a top-level field in Chat Completions; in Responses it is `reasoning.effort`.
  - Enum: `none|minimal|low|medium|high|xhigh|max`, default `medium`. "Not all reasoning models support every value."
  - Astra or 6.1 Sol with `none` returns **HTTP 400**.
  - For `minimal`, the migration guide says to use `low` instead.
- **`stop`:** "Not supported with latest reasoning models `o3` and `o4-mini`". Avoid it on reasoning models.
- **`verbosity`:** `low|medium|high`, default `medium`.
- **Roles:** `developer`, `system`, `user`, `assistant` and `tool` are all accepted.

### Vision input
Send content parts. `image_url.url` is "Either a URL of the image or the base64 encoded image data", so a data URL works:
```json
{"role":"user","content":[
  {"type":"text","text":"Describe this"},
  {"type":"image_url","image_url":{"url":"data:image/png;base64,iVBOR…","detail":"auto"}}
]}
```
- `detail` accepts `auto` (default), `low`, `high` and **`original`**, which is new.
- All GPT-6 models accept text and image input and produce text output only.

### Current chat model IDs (late 2026)
Source: https://developers.openai.com/api/docs/models. All have a 1.05M context window, 922K max input and 128K max output.

| Tier | ID | $/MTok in/out | Reasoning efforts |
|---|---|---|---|
| Flagship ("start here") | `gpt-6-astra` (released Sep 3) | 10 / 50 | low to max (no `none`) |
| Balanced (recommended default) | `gpt-6.1-sol` (Sep 29) | 2 / 10 | low to max (no `none`) |
| Mid | `gpt-6.1-terra` (Oct 26) | 1 / 5 | none to max |
| Cheap, high-volume | `gpt-6-luna` (Sep 22) | 0.10 / 0.50 | none to max |
| Older, still listed | `gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-pro`, `gpt-5.2`, `gpt-5.2-pro` | | |
| ChatGPT alias | `chat-latest` (moving target, "not for production") | 5 / 30 | |

- The models page has no "mini/nano" labels any more. `gpt-6-luna` is the cheap tier.
- **Do not hard-code these; they are shut down or about to be.** Source: https://developers.openai.com/api/docs/deprecations

  | Shutdown | Models |
  |---|---|
  | Oct 23, 2026 (already gone) | `o1`, `o3-mini`, `o4-mini`, `gpt-4`, `gpt-4-turbo`, `gpt-4.1-nano` |
  | Dec 11, 2026 | `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `o3`, `gpt-5-pro`, `o3-pro` |
  | Jan 14, 2027 | `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini` |
  | Apr 1, 2027 | `gpt-5.1`, `gpt-5.4-nano` |

---

## 2. OpenAI image generation: `POST https://api.openai.com/v1/images/generations`

Reference: https://developers.openai.com/api/reference/resources/images/methods/generate. Guide: https://developers.openai.com/api/docs/guides/image-generation

### Model IDs
- **Current:**
  - `gpt-image-2.5-flare`: fast, everyday. Snapshot `-2026-09-08`.
  - `gpt-image-2.5-sunburst`: most capable. Snapshot `-2026-09-08`.
  - `gpt-image-2` (snapshot `gpt-image-2-2026-04-21`).
  - Both 2.5 models were released Sep 8, 2026.
- **Gone or going:**
  - `gpt-image-1` was **shut down Oct 23, 2026**.
  - `gpt-image-1-mini`, `gpt-image-1.5` and `chatgpt-image-latest` shut down **Dec 1, 2026**.
  - `dall-e-2` and `dall-e-3` were shut down May 12, 2026.
- "Specify a model explicitly". The docs list no usable default.
- You may need **API Organization Verification** before using GPT Image models.

### Parameters
| Parameter | Values and notes |
|---|---|
| `prompt` | Up to 32000 characters |
| `n` | 1 to 10, default 1 |
| `size` | `auto` (default), `1024x1024`, `1536x1024` or `1024x1536` |
| `quality` | `low`, `medium`, `high` or `auto` (default) |
| `output_format` | `png` (default), `jpeg` or `webp` |
| `output_compression` | 0 to 100, for jpeg and webp only |
| `background` | `transparent`, `opaque` or `auto`. Transparent needs png or webp, and is "in preview" for `gpt-image-2` |
| `moderation` | `auto` or `low` |
| `stream` and `partial_images` | `partial_images` is 0 to 3 |
| `user` | Deprecated. Use `safety_identifier` |

- **Custom sizes** work on gpt-image-2 and 2.5:
  - Any `WxH` with both sides divisible by 16, an aspect ratio between 1:3 and 3:1, and at most 3840 px per edge.
  - The guide gives 655,360 to 8,294,400 total pixels; anything above 2560x1440 is "experimental".
- **Quality `xhigh` and `max`** work only on the 2.5 models. Older GPT Image models stop at `high`.
- **`response_format` (`url`/`b64_json`) is "unsupported for GPT image models, which always return base64".** Omit it.
- **`style`** (`vivid`/`natural`) is also unsupported. It was DALL-E only.

### Response
```json
{"created":1730000000,
 "data":[{"b64_json":"iVBOR…"}],
 "background":"opaque","output_format":"png","quality":"high","size":"1024x1024",
 "usage":{"input_tokens":…, "output_tokens":…, "total_tokens":…,
          "input_tokens_details":{"text_tokens":…,"image_tokens":…},
          "output_tokens_details":{"text_tokens":…,"image_tokens":…}}}
```
- There is no `url` and no `revised_prompt`; GPT image models don't return them. Render as `data:image/<output_format>;base64,…`.
- **Streaming events:** the Image API sends `image_generation.partial_image` with `partial_image_index` and `b64_json`.
- **Latency:** "Complex prompts may take up to 2 minutes to process." Use a long fetch timeout.
- **Pricing (gpt-image-2.5-flare):** billed per token, not per image. Image output is $30/MTok, image input $8/MTok and text input $5/MTok. Default IPM is 20 at the lowest ("Build") tier.
- **Generating images inside a chat:** use the Responses API with `tools:[{"type":"image_generation","model":"gpt-image-2.5-sunburst"}]` and a mainline model such as `gpt-6-astra`. Chat Completions has no image tool.

---

## 3. OpenAI `GET https://api.openai.com/v1/models`

Source: https://developers.openai.com/api/reference/resources/models/methods/list
```json
{"object":"list","data":[
  {"id":"gpt-6.1-sol","object":"model","created":1686935002,"owned_by":"system","shutdown_date":null}
]}
```
- There is no pagination.
- `shutdown_date` is a newer nullable date field. Use it to hide models that are being retired.
- There are no capability or modality fields. The list includes embeddings, TTS, realtime and other non-chat models. Filter by ID prefix (for example `gpt-6`, `gpt-5.x`, `gpt-image-`), or keep a curated list and treat the API list as a validity check.

---

## 4. xAI (Grok)

- **Base URL:** `https://api.x.ai/v1`. It is OpenAI-SDK compatible.
- **Auth:** `Authorization: Bearer <XAI_API_KEY>`. Keys come from console.x.ai.
- **Docs index:** https://docs.x.ai/llms.txt

### Chat Completions status
- `POST /v1/chat/completions` still works, but it is **legacy**. The docs call it "the stateless, OpenAI-compatible predecessor of the Responses API", say "New integrations should use Responses", and say new features come to Responses first.
- No sunset date is given.
- Chat Completions has no field for encrypted reasoning, so multi-turn reasoning context is lost. Results "understate" what reasoning models can do.
- Sources: https://docs.x.ai/developers/rest-api-reference/inference/chat-completions, https://docs.x.ai/developers/model-capabilities/legacy/chat-completions and https://docs.x.ai/developers/model-capabilities/text/best-practices

### Chat Completions request parameters
- **`max_completion_tokens`:** defaults to 128,000. It counts visible output only. `max_tokens` is deprecated.
- **`temperature`:** 0 to 2, but values above 1 are sampled at 1.
- **`top_p`:** values above 0.95 are sampled at 0.95.
- **`reasoning_effort`:** depends on the model. Reasoning "cannot be disabled" on the 4.5+ reasoning models.
- **`presence_penalty`, `frequency_penalty` and `stop`:** not allowed on reasoning models. "Requests that include them return an error." Never send them to Grok.
- Source: https://docs.x.ai/developers/model-capabilities/text/reasoning

### Chat Completions response and streaming
- `choices[].message.reasoning_content` contains the reasoning trace, alongside `content`.
- `usage.completion_tokens_details.reasoning_tokens` counts reasoning tokens.
- `usage.cost_in_usd_ticks`: 1e10 ticks = $1.
- Streaming is OpenAI-shaped SSE with `chat.completion.chunk` and `data: [DONE]`.
  - `delta` can carry **`reasoning_content`** as well as `content`, for example `{"delta":{"reasoning_content":"The","role":"assistant"}}`. Show it as a collapsible "thinking" block, or skip it.
  - Example chunks carry `usage`. `stream_options.include_usage` is supported.
  - Reasoning can take long, so xAI's examples use timeouts of up to 3600 s. Don't abort early.
  - Source: https://docs.x.ai/docs/guides/streaming-response

### Vision
- Same `image_url` content part as OpenAI: `{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,…","detail":"high"}}`.
- `detail` accepts `auto`, `low` or `high`.
- Only **jpg/jpeg and png** are accepted, with a **20 MiB max per image**. There is no limit on image count, and images can appear in any order.
- The Responses API instead uses `{"type":"input_image","image_url":"data:…"}`.
- Source: https://docs.x.ai/docs/guides/image-understanding

### Current Grok model IDs
Source: https://docs.x.ai/docs/models

| ID | Context | $/MTok in/out | Notes |
|---|---|---|---|
| `grok-4.7` | 500k | 2 / 6 | Recommended for chat and code. Text and image input. Effort `low/medium/high/xhigh`, default `high`. Cutoff May 2026 |
| `grok-4.6`, `grok-4.5` | 500k | 2 / 6 | Older flagships. On 4.5, `xhigh` is treated as `high` |
| `grok-4.3` (alias `grok-4.3-latest`) | 1M | 1.25 / 2.50 | **Cheap default.** Text and image input. Effort `none/low/medium/high/xhigh`, default `low` |
| `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning` | 1M | 1.25 / 2.50 | |
| `grok-4.20-multi-agent-0309` | 1M | 1.25 / 2.50 | Effort sets the agent count |
| `grok-build-0.1` | 256k | 1 / 2 | Coding |

- `logprobs` is silently ignored on grok-4.20 and newer.
- **Alias scheme:** `<name>` is the latest stable, `<name>-latest` is the latest, and `<name>-<date>` is pinned.
- **Retired May 15, 2026:** `grok-4-1-fast-*`, `grok-4-fast-*`, `grok-4-0709`, `grok-3` and `grok-code-fast-1`. These now redirect to `grok-4.3` or `grok-build-0.1` and are billed at grok-4.3 rates. Source: https://docs.x.ai/developers/migration/may-15-retirement

### Image generation: `POST https://api.x.ai/v1/images/generations`
Sources: https://docs.x.ai/developers/rest-api-reference/inference/images and https://docs.x.ai/developers/model-capabilities/images/generation

**Models**
- `grok-imagine-image-2.0`: $0.04/image, 6 RPS.
- `grok-imagine-image` (v1.0): $0.02/image.
- **`grok-imagine-image-quality` was retired Nov 2, 2026.** It now serves `grok-imagine-image-2.0` at `low`. `grok-imagine-image-pro` follows the same redirect. Source: https://docs.x.ai/developers/migration/imagine-image-quality-nov-2

**Parameters**
- `model`, `prompt`
- `n`: 1 to 10, default 1.
- **`response_format`:** `url` (default) or **`b64_json`**, which is supported.
- `aspect_ratio`: `1:1|3:4|4:3|9:16|16:9|2:3|3:2|9:19.5|19.5:9|9:20|20:9|1:2|2:1|21:9|5:2|auto`, default `auto`.
- `resolution`: `1k` (default), `2k`, or `1.5k`, which appears in the schema.
- `quality`: `low|medium|auto` on 2.0 only. `auto` means low for generation and medium for editing.
- `user`, and `deferred` (polled via `GET /v1/images/{request_id}`; url only).
- **There is no `size` parameter.** Map the UI's sizes to aspect_ratio and resolution, and don't send OpenAI-style `size`, `style` or `output_format`.

**Response**
```json
{"data":[{"url":"https://…","b64_json":null,"mime_type":"image/jpeg"}],
 "usage":{"cost_in_usd_ticks":…, "input_tokens":…, "output_tokens":…, "total_tokens":…}}
```
- URLs are "temporary". Download promptly or use `b64_json`, which is better for local storage.
- Image models don't stream.

**Editing:** `POST /v1/images/edits`
- Takes `image: {url | file_id}` (public URL or base64 data URL; jpeg, png or webp).
- Or takes `images: […]` with up to 5 images, referenced in the prompt as `<IMAGE_0>` and so on.

### Model listing endpoints
Source: https://docs.x.ai/developers/rest-api-reference/inference/models
- **`GET /v1/models`** returns `{"object":"list","data":[{"id","object":"model","created","owned_by","aliases",…}]}`. Entries may also carry `context_length`, `capabilities` (including `reasoning_effort` and `default_reasoning_effort`) and price fields.
- **`GET /v1/language-models`** returns `{"models":[{…,"input_modalities":["text","image"],"output_modalities":["text"],"aliases","version","fingerprint",…}]}`. **Use this one to detect vision support.**
- **`GET /v1/image-generation-models`** returns `{"models":[…]}` with modalities, `max_prompt_length` and `image_price`.
- `GET /v1/video-generation-models` also exists.
- Note the wrapper key: `data` for `/v1/models`, but `models` for the others.

---

## Recommended defaults for the extension
- **OpenAI:**
  - Chat: default `gpt-6.1-sol`, cheap `gpt-6-luna`, premium `gpt-6-astra`.
  - Images: default `gpt-image-2.5-flare`, premium `gpt-image-2.5-sunburst`.
  - Send only `model`, `messages`, `stream`, `stream_options` and `max_completion_tokens`, plus `reasoning_effort` where wanted. Send `temperature` only when the effort is `none` and the model supports it.
- **xAI:**
  - Chat: default `grok-4.3`, premium `grok-4.7`.
  - Images: `grok-imagine-image-2.0` with `response_format:"b64_json"` and an explicit `quality`.
  - Never send `stop`, `presence_penalty` or `frequency_penalty`.
- **Both:** the same OpenAI-compatible SSE parser works if it also handles an optional `delta.reasoning_content` and a final chunk with empty `choices`.

## Open questions
- Model IDs and some parameter details came from docs pages read through a page summarizer. Before shipping a hard-coded list, check it at runtime against GET /v1/models (OpenAI) and GET /v1/language-models (xAI).
- OpenAI: untested whether sending temperature or top_p to gpt-6-astra or gpt-6.1-sol (where reasoning effort cannot be none) returns HTTP 400 or is silently ignored. The docs say to 'remove' them; this needs a live test with a real key.
- OpenAI Images: untested whether sending response_format to gpt-image-* models returns HTTP 400 or is ignored. The docs only say it is unsupported, so omit it.
- OpenAI Images streaming: the final SSE event name (for example image_generation.completed) was not confirmed in the guide.
- OpenAI vision: the accepted input image formats and size limits for GPT-6 models (png/jpeg/webp/gif?) were not confirmed.
- xAI Images: untested whether an OpenAI-style 'size' parameter is rejected or ignored. Also how long generated image URLs stay valid ('temporary', no exact TTL given).
- xAI Chat Completions: the docs mark it legacy but give no sunset date. Whether to also implement the xAI Responses API (input_image parts, encrypted reasoning) needs a decision.
- xAI: whether reasoning_effort is accepted on Chat Completions for grok-4.7 with the same values as on Responses (low/medium/high/xhigh) was not explicitly confirmed on the chat-completions reference page.
