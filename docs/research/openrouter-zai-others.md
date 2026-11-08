# Provider research: OpenRouter, Z.AI, DeepSeek, Mistral, Groq, Perplexity, Ollama, LM Studio
Checked on 2026-11-03. Sources were official docs, live unauthenticated requests (curl) and the OpenRouter OpenAPI spec (`https://openrouter.ai/openapi.json`).

## 0. Findings that apply to every provider (live CORS probe)
- I sent `POST` and `OPTIONS` to each chat endpoint with `Origin: chrome-extension://…`. **None of the cloud providers rejected the extension Origin.** All returned a normal 401 for the fake key, with permissive CORS:
  - OpenRouter, Mistral, Groq and Perplexity send `Access-Control-Allow-Origin: *`.
  - Z.AI and DeepSeek echo the origin back and add `Allow-Credentials: true`.
  - So none of them needs a special header like Anthropic's `anthropic-dangerous-direct-browser-access`.
- The headers each preflight allows differ:
  - OpenRouter: `HTTP-Referer, X-Title, X-OpenRouter-Title, X-OpenRouter-Categories, …`
  - Groq and Z.AI: only `authorization, content-type`
  - Mistral: `Authorization, Content-Type, User-Agent, Cache-Control, …`
  - Requests from extension pages or the service worker that have `host_permissions` skip CORS, so this only matters if you fetch from a content script. **Always send requests through the background script.**
- Firefox MV3: the user can withhold or revoke host permissions. Check with `permissions.contains` or `permissions.request` before calling.
- Use one SSE parser for every provider. It must:
  - ignore comment lines that start with `:` (OpenRouter sends `: OPENROUTER PROCESSING`, DeepSeek sends `: keep-alive`)
  - ignore blank lines
  - stop on `data: [DONE]`
- Reasoning arrives in a different field per provider, so normalise it:
  - `delta.reasoning` / `reasoning_details`: OpenRouter, Groq
  - `delta.reasoning_content`: Z.AI, DeepSeek, probably LM Studio
  - `content` as an array with `type:"thinking"` chunks: Mistral
  - `<think>` tags inside the text: Groq with `reasoning_format: raw`

---
## 1. OpenRouter
- **Base URL:** `https://openrouter.ai/api/v1` (taken from the OpenAPI `servers` entry).
- **Auth:** `Authorization: Bearer <key>`.
- **Other endpoints:** `/chat/completions`, `/responses`, `/messages`, `/images`, `/images/models`, `/models`, `/key`, `/credits`, `/videos`, `/audio/speech`, `/audio/transcriptions`, `/embeddings` ([blog](https://openrouter.ai/blog/insights/every-modality-one-api/)).

### Attribution headers (optional)
Source: [app-attribution](https://openrouter.ai/docs/app-attribution.md)
- `HTTP-Referer: <app URL>`: this is the main app identifier, and without it no app page is created. It is not a forbidden fetch header (only `Referer` is), and the CORS preflight allows it.
- `X-OpenRouter-Title: <name>`: the current title header. `X-Title` is the legacy name and still works. The title only counts when sent together with `HTTP-Referer`. Apps on localhost must send it.
- Also available: `X-OpenRouter-Categories` (up to 2, comma-separated) and `X-OpenRouter-App-Visibility: hidden`.

### Streaming quirks
Source: [streaming](https://openrouter.ai/docs/api_reference/streaming.md)
- SSE `data:` lines, ending with `data: [DONE]`. Comment lines such as `: OPENROUTER PROCESSING` arrive and **must be skipped before `JSON.parse`**.
- Errors before the stream starts are plain JSON: `{"error":{"code":400,"message":"..."}}`. The possible statuses are 400, 401, 402 (no credits), 429, 502 and 503.
- **Errors after the stream starts** come with HTTP 200. The last chunk has a top-level `error`, and its choice has `finish_reason:"error"`:
  ```json
  {"id":"…","choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}],
   "error":{"code":429,"message":"Rate limit exceeded","metadata":{"error_type":"rate_limit_exceeded","provider_code":"…"}}}
  ```
  A 200 response that contains only an error chunk is a failure.
- **Usage chunk:** sent just before `[DONE]`, always included (`stream_options.include_usage` is deprecated and does nothing). Unlike OpenAI, this chunk has **one choice with an empty delta that repeats `finish_reason`**. Treat it as accounting data, not as a second end-of-stream.
- `usage` fields: `prompt_tokens`, `completion_tokens`, `total_tokens`, `cost`, `is_byok`, `completion_tokens_details.reasoning_tokens`.
- `finish_reason` values: `tool_calls | stop | length | content_filter | error | null`.
- **Cancelling:** abort the fetch. Billing stops only for providers that support cancellation. Groq, Bedrock and Google keep generating and bill the full response.
- The `X-Generation-Id` response header is exposed through CORS (`/generation?id=` returns stats).

### Reasoning
Sources: [reasoning-tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md), OpenAPI spec
- **Request:**
  - `"reasoning": {"effort":"max|xhigh|high|medium|low|minimal|none", "max_tokens":N, "enabled":bool, "exclude":bool}`
  - Use either `effort` or `max_tokens`, not both. The top-level shorthand `reasoning_effort` also works.
- **Stream delta** (`ChatStreamDelta`): `content`, `reasoning` (string), `reasoning_details` (array), `refusal`, `role`, `tool_calls`, `audio`.
- **Full response:** `message.reasoning` and `message.reasoning_details[]`.
- **`reasoning_details` items** all have `{id, format, index}` plus a `type`-specific field:
  - `reasoning.text` → `text`, `signature`
  - `reasoning.summary` → `summary`
  - `reasoning.encrypted` → `data`
  - `reasoning.server_tool_call`
- For multi-turn conversations with tools, send `reasoning_details` back unchanged and in the original order.
- **Per-model metadata** in `/models` (`data[].reasoning`), for example `{"mandatory":true,"default_enabled":true,"supported_efforts":["max","high","low"],"default_effort":"max","supports_max_tokens":true}`. `mandatory: true` means effort `"none"` is rejected. Build the effort selector from this.

### GET /models
Source: [models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md)
- The spec says Bearer auth, but the live request **returned 200 without a key**.
- Response: `{data:[…], total_count, links:{next}}`.
- Each item has:
  - `id`, `canonical_slug`, `name`, `created`, `description`, `context_length`
  - `architecture:{modality:"text+image->text", input_modalities:[…], output_modalities:[…], tokenizer, instruct_type}`
  - `pricing:{prompt, completion, image, request, image_output, internal_reasoning, input_cache_read, …}` (strings, USD per token)
  - `top_provider:{context_length, max_completion_tokens, is_moderated}`
  - `supported_parameters[]`, `default_parameters`, `reasoning`, `expiration_date`, `knowledge_cutoff`
  - **`endpoints[]`** (for example `["/api/v1/chat/completions","/api/v1/images"]`)
- **Gotcha:** `output_modalities` **defaults to `text`**:
  - default call: 451 models
  - `?output_modalities=all`: 685 models
  - `?output_modalities=image`: 63 models
- Other query parameters: `input_modalities`, `supported_parameters`, `category`, `q`, `offset`, `limit` (default 500).

### Image generation: two routes
**A) Chat completions with `modalities`.** Only works for models whose `endpoints` includes `/api/v1/chat/completions` and whose output includes `image`. The fields are in the OpenAPI spec.
```json
{"model":"google/gemini-3.1-flash-image","messages":[{"role":"user","content":"a red fox, watercolor"}],
 "modalities":["image","text"], "image_config":{"aspect_ratio":"16:9"}}
```
Response: `choices[0].message.images = [{"image_url":{"url":"data:image/png;base64,…"}}]`. Text may also come back in `content`.
- **Streaming:** the current `ChatStreamDelta` schema has **no `images` field**. Older docs (and a search snippet) say images arrive in `delta.images[]` during streaming. I couldn't confirm this, so either use `stream:false` for image requests or read `delta.images` defensively.
- `image_config` keys depend on the provider. The documented examples are `aspect_ratio` and `quality`.

**B) Dedicated `POST /api/v1/images`.** This is now the main documented route, and **it is the only route for image-only models** ([image-generation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)).
- Request: `{model, prompt, n, size, resolution, aspect_ratio, quality, output_format, background, output_compression, seed, stream, input_references:[{"type":"image_url","image_url":{"url":"…"}}], provider}`
- Response:
  ```json
  {"created":1748372400,"data":[{"b64_json":"…","media_type":"image/png"}],"usage":{"prompt_tokens":0,"completion_tokens":4175,"total_tokens":4175,"cost":0.04}}
  ```
- Streaming (only when the model has `supports_streaming:true`). Events:
  - `{"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"…"}`
  - `{"type":"image_generation.completed","b64_json":"…","media_type":"image/png","usage":{…}}`
  - `{"type":"image_generation.text_chunk","phase":"content|reasoning|draft","text":"<svg…"}` (for SVG)
  - `{"type":"error","error":{"message":"…","code":"server_error"}}`
  - then `[DONE]`
- `GET /api/v1/images/models` (works without auth, 61 models) returns per model: `supported_parameters` as typed descriptors (for example `{"resolution":{"type":"enum","values":["1K","2K","4K"]},"n":{"type":"range","min":1,"max":6}}`), plus `supports_streaming` and `endpoints`. **Build the image-settings UI from this.**

### Current model IDs (live `/models`, 2026-11-03)
- **Image + text output** (chat route and `/images`):
  - `google/gemini-nano-banana-2.1`, `google/gemini-3.1-flash-image`, `google/gemini-3-pro-image`, `google/gemini-3.1-flash-lite-image`
  - `openai/gpt-5.4-image-2`, `openai/gpt-5-image`, `openai/gpt-5-image-mini`
  - `google/gemini-2.5-flash-image`
- **Image only** (`/images` only):
  - `openai/gpt-image-2`, `openai/gpt-image-2.5-flare`, `openai/gpt-image-2.5-sunburst`, `openai/gpt-image-1(-mini)`
  - `black-forest-labs/flux-3-image`, `flux-3-image-klein`, `flux.2-pro/max/flex`
  - `bytedance-seed/seedream-5-0-pro|lite|flash`
  - `x-ai/grok-imagine-image-2.0`
  - `qwen/qwen-image-3(-pro)`, `qwen/qwen-image-2.1-pro|turbo`
  - `microsoft/mai-image-2.6(-flash)`, `recraft/recraft-v4.1*`, `meta/muse-image`, `krea/krea-2-*`, `sourceful/riverflow-v2.6-pro`
- **Text flagships:**
  - `openai/gpt-6.1-terra(-pro)`, `openai/gpt-6.1-sol(-pro)`
  - `anthropic/claude-opus-5.5`, `anthropic/claude-sonnet-5.5`, `anthropic/claude-haiku-5.5`
  - `google/gemini-4-argon`, `google/gemini-3.8-flash`
  - `x-ai/grok-4.7`
  - `z-ai/glm-5.3`, `z-ai/glm-5.3-flash(x)`
  - `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4.1-flash`
  - `moonshotai/kimi-k3.1-pro`, `mistralai/mistral-large-4-0`, `qwen/qwen3.8-max-prime`
  - `openrouter/auto`
  - Each also has a `:batch` variant.
- **Other useful endpoints:** `GET /api/v1/key` checks the key (limits, `is_free_tier`, budgets). OAuth PKCE uses `/auth/keys` ([oauth](https://openrouter.ai/docs/guides/overview/auth/oauth.md)).

---
## 2. Z.AI (Zhipu GLM, international)
Sources: [quick-start](https://docs.z.ai/guides/overview/quick-start), [chat-completion](https://docs.z.ai/api-reference/llm/chat-completion.md)
- **General API:** `https://api.z.ai/api/paas/v4/`, chat at `POST /chat/completions`.
- **GLM Coding Plan** ([devpack](https://docs.z.ai/devpack/quick-start.md)):
  - OpenAI-compatible: `https://api.z.ai/api/coding/paas/v4`
  - Anthropic-compatible: `https://api.z.ai/api/anthropic`
  - Responses: `https://api.z.ai/api/v1`
  - Coding Plan keys and standard API keys are **not interchangeable**.
  - The terms say the plan is "strictly limited to use within officially supported tools". Use the general endpoint by default and show a warning for the Coding Plan option.
- **Auth and headers:** `Authorization: Bearer <key>`, optional `Accept-Language: en-US,en`. Works with OpenAI SDKs.
- **Model IDs:**
  - Text: `glm-5.3` (default, 1M context), `glm-5.2`, `glm-5.1`, `glm-5`, `glm-4.7`, `glm-4.6`
  - **Vision:** `glm-5.3-flashx` (vision default), `glm-5.3-flash`, `glm-5.3-flashx-legal`. Vision content parts are `image_url` (URL or base64, ≤5 MB, ≤6000×6000), `video_url` and `file`.
- **Thinking** ([thinking-mode](https://docs.z.ai/guides/capabilities/thinking-mode.md)):
  - Request: `"thinking":{"type":"enabled"|"disabled","clear_thinking":true|false}`, enabled by default.
  - `glm-5.3` and `glm-5.3-flash` always think and cannot be switched off.
  - Depth is set with `reasoning_effort` (default `max`). GLM-5.3 and the vision models accept only `low|high|max`.
  - `clear_thinking:false` turns on "Preserved Thinking". It is **on by default on the Coding Plan endpoint** and off on the general one. When it is on, send back the full, unmodified `reasoning_content` in assistant messages.
- **Streaming** ([streaming](https://docs.z.ai/guides/capabilities/streaming.md)):
  - Chunks look like OpenAI's: `delta.content` and `delta.reasoning_content`.
  - The last chunk has `finish_reason` and `usage:{prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details:{cached_tokens}}` (usage appears only there). Then `data: [DONE]`.
  - `tool_stream:true` streams tool-call arguments.
  - `finish_reason` values: `stop | tool_calls | length | sensitive | network_error | model_context_window_exceeded`. Errors during the stream show up only in `finish_reason`.
- **Request gotchas:**
  - `temperature` 0–1, `do_sample`
  - `tool_choice` accepts only `auto`
  - `response_format` accepts `text` or `json_object`
  - built-in `web_search` tool; the response then has a top-level `web_search[]`
- **Errors** ([api-code](https://docs.z.ai/api-reference/api-code.md)):
  - Format: `{"error":{"code":"1001","message":"…"}}`. The **code is a string**; this matched the live probe.
  - 1001: auth header missing
  - 1113: no balance
  - 1211: unknown model
  - 1301: content filter
  - 1302, 1305: rate limit or overload
  - 1308, 1310: quota reached, with `next_flush_time`
  - 1309: Coding Plan expired
- **Images** ([generate-image](https://docs.z.ai/api-reference/image/generate-image.md)):
  - `POST /api/paas/v4/images/generations` with `{model:"glm-image", prompt, quality:"hd"|"standard", size:"1280x1280", user_id}`
  - The model enum lists only `glm-image`, not CogView-4.
  - `glm-image` sizes: 1024–2048 px, multiple of 32, at most 2^22 px total. Recommended: `1568x1056`, `1056x1568`, `1472x1088`, `1728x960`, ….
  - Response: `{"created":…,"data":[{"url":"…"}],"content_filter":[{"role":"assistant","level":0-3}]}`. The URL **expires after 30 days**, so download it and store it locally.
  - Async version: `POST /api/paas/v4/async/images/generations` returns `{id, task_status:PROCESSING|SUCCESS|FAIL, model, request_id}`, which you then poll. The poll path is in "get-image-status" ([link](https://docs.z.ai/api-reference/image/get-image-status.md)); I didn't fetch that page.
- **Model list:** not documented. `GET /api/paas/v4/models` returns 401 without a key, so the route may exist but is unconfirmed. Use a hard-coded list, with a fallback to calling the endpoint.

---
## 3. Brief notes on the other providers
### DeepSeek
Sources: [docs](https://api-docs.deepseek.com/), [pricing](https://api-docs.deepseek.com/quick_start/pricing), [changelog](https://api-docs.deepseek.com/updates)
- **Base URL:** `https://api.deepseek.com` (`/v1` also works; the probe returned 401, not 404). Chat at `POST /chat/completions`. Anthropic-compatible at `https://api.deepseek.com/anthropic`.
- **Models** (`GET /models` returns `{object:"list",data:[{id, owned_by, name, context_window, max_output_tokens, input_modalities, output_modalities, effort:{supported_levels, default_level}}]}`):
  - `deepseek-flash`: V4.1-Flash-1017, 1M context, **vision**
  - `deepseek-v4-pro`: V4-Pro-0813, 1M context, text only
  - `deepseek-v4-flash` and `-vision-exp` are legacy names that now route to V4.1-Flash.
  - **`deepseek-chat` and `deepseek-reasoner` were discontinued on 2026-07-24.**
- **Thinking** ([guide](https://api-docs.deepseek.com/guides/thinking_mode)):
  - On by default. `"thinking":{"type":"enabled"|"disabled"}`, `reasoning_effort: low|high|max` (default `high`).
  - Output goes to `message.reasoning_content` / `delta.reasoning_content`.
  - **When tools are used, every earlier turn's `reasoning_content` must be sent back, otherwise the API returns 400.** Without tools it is ignored.
  - In thinking mode, `temperature` and penalties are ignored.
- **Keep-alive:** streams send `: keep-alive` SSE comments and non-streaming responses send blank lines. The server closes the connection if inference hasn't started after 10 minutes ([rate_limit](https://api-docs.deepseek.com/quick_start/rate_limit)).

### Mistral
Sources: [models](https://docs.mistral.ai/models.md), [reasoning](https://docs.mistral.ai/capabilities/reasoning/), [openapi.yaml](https://docs.mistral.ai/openapi.yaml)
- **Base URL:** `https://api.mistral.ai/v1`. Chat at `POST /chat/completions`; models at `GET /models`.
- `/models` cards include `capabilities:{completion_chat, function_calling, reasoning, vision, ocr, audio, …}`, `max_context_length`, `aliases`, `deprecation`, `deprecation_replacement_model`.
- **Models:**
  - `mistral-large-4` / `mistral-large-4-0`: 1M context, vision, reasoning, public preview
  - `mistral-small-2603` / `mistral-small-latest`: 256k context, vision, hybrid reasoning
  - `mistral-medium-3-5`: retires 2027-04-30
  - `ministral-14b|8b|3b-2512`, `codestral-2508`
  - Third-party models hosted on Mistral: `zai-glm-5-3`, `zai-glm-5-3-flash`, `deepseek-v4-1-flash-1017`
- **Reasoning:** `reasoning_effort` enum is `none|minimal|low|medium|high|xhigh` (the values each model accepts differ). There is also `prompt_mode:"reasoning"`.
- **There is no `reasoning_content` field.** When reasoning is on, `message.content` is an array:
  `[{"type":"thinking","thinking":[{"type":"text","text":"…"}],"signature":…},{"type":"text","text":"…"}]`
  In a stream, `delta.content` starts as a list of thinking chunks, switches over, and then becomes plain strings.
- **Gotcha:** `ChatCompletionRequest` has **`additionalProperties: false`**. Unknown fields are rejected, including `stream_options`, `seed` (Mistral uses `random_seed`), `max_completion_tokens`, `thinking` and `user`. Strip them.
- **Images:** only through the Agents/Conversations API, with tool `{"type":"image_generation"}` (`POST /v1/agents`, then `POST /v1/conversations`). The output contains a `tool_file` chunk with `file_id`; download it with `GET /v1/files/{id}/content` ([docs](https://docs.mistral.ai/studio/agents/agent-tools/image_generation.md)). It is not available on chat completions.

### Groq
Sources: [models](https://console.groq.com/docs/models), [reasoning](https://console.groq.com/docs/reasoning), [api-reference](https://console.groq.com/docs/api-reference)
- **Base URL:** `https://api.groq.com/openai/v1`. Chat at `POST /chat/completions`.
- `GET /models` returns `{object:"list",data:[{id, object, created, owned_by, active, context_window, public_apps}]}`.
- **Production models:** `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `whisper-large-v3(-turbo)`.
- **Preview models:** `qwen/qwen3.8-27b`, `minimaxai/minimax-m2.7`, `meta-models/muse-spark-open`, `canopylabs/orpheus-*` (TTS).
- **No vision model is listed at the moment.**
- **Reasoning:** comes back in **`message.reasoning`** (not `reasoning_content`).
  - `reasoning_format: parsed|raw|hidden` (not for GPT-OSS). `raw` puts it in `<think>` tags and returns 400 when combined with JSON mode or tools.
  - `include_reasoning` (bool, for GPT-OSS) cannot be combined with `reasoning_format`.
  - `reasoning_effort` is checked per model, and unsupported values return 400.
- **Unsupported:** only `n=1` works; `logprobs`, `logit_bias`, penalties, `metadata` and `store` are not supported. `max_tokens` is deprecated in favour of `max_completion_tokens`.

### Perplexity
Sources: [openai-compat](https://docs.perplexity.ai/docs/sonar/openai-compatibility), [migrate-from-sonar](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar.md), [how-to](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/how-to.md), [changelog](https://docs.perplexity.ai/changelog)
- **Support for Sonar chat completions ended on 2026-09-27.**
  - Synchronous and streaming requests are being converted to Agent API requests, model by model. Async Sonar requests no longer work.
  - Live probe: `POST https://api.perplexity.ai/chat/completions` still routes (401); `/v1/chat/completions` returns 404.
- **Use the Agent API instead:** `POST https://api.perplexity.ai/v1/agent` (alias `/v1/responses`). It uses the OpenAI Responses format.
  ```json
  {"model":"perplexity/sonar" /* or omit and use */, "effort":"fast|low|medium|high|xhigh",
   "instructions":"…","input":[{"type":"message","role":"user","content":"…"}],
   "tools":[{"type":"web_search"}],"max_output_tokens":1024,"stream":true}
  ```
  - Old Sonar models map to effort levels: sonar and sonar-pro → `fast`, sonar-reasoning-pro → `low`, sonar-deep-research → `high`.
  - The stream uses typed events. Text arrives in `response.output_text.delta` (`event.delta`). Tool steps use `response.output_item.*` and reasoning uses `response.reasoning.*`.
  - Sources are in the `output[]` item with `type:"search_results"`, as `results[{id,title,url,snippet,date,source}]`. Citations appear as `[n]` or `[web:n]` in the text.
  - Agent API model IDs include `perplexity/sonar`, `perplexity/glm-5.3`, `perplexity/kimi-k3`, `openai/gpt-5.6-sol`, `anthropic/claude-sonnet-5-5`, ….
- `GET /v1/models` was added in April 2026, and the changelog says it needs no auth. The **live probe returned 401 without a key**, so send the key.
- The CORS preflight allows `x-title` and `X-Pplx-Integration`.

---
## 4. Local servers
### Ollama
Sources: [openai-compat](https://docs.ollama.com/api/openai-compatibility), [faq](https://docs.ollama.com/faq)
- **OpenAI-compatible base:** `http://localhost:11434/v1/`. Ollama Cloud: `https://ollama.com/v1` with a real key.
- Endpoints: `/chat/completions`, `/completions`, `/models`, `/models/{m}`, `/embeddings`, `/responses` (stateless), `/audio/*`.
- The API key can be any placeholder.
- Supported: `reasoning_effort` / `reasoning.effort`, `stream_options.include_usage`, `tools`, JSON mode.
- **Vision accepts only base64 `image_url`**; remote image URLs are not supported. Not supported: `tool_choice`, `logprobs`, `n`, `user`.
- Native API: `/api/chat` (NDJSON, `think` parameter), `/api/tags`, `/api/show`.
- **CORS / origin check:**
  - By default only `127.0.0.1` and `0.0.0.0` origins are allowed.
  - Ollama itself rejects other `Origin` headers with **403**. `host_permissions` don't help, because the browser still sends `Origin: chrome-extension://<id>` or `moz-extension://<uuid>`. The Firefox UUID is random per install, so use a wildcard.
  - The user has to set `OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*,safari-web-extension://*` (or the exact IDs) and restart Ollama.
    - Windows: user environment variable, then quit and restart from the Start menu.
    - macOS: `launchctl setenv`.
    - Linux: `systemctl edit ollama.service` with `Environment=`.
  - `OLLAMA_HOST` changes the bind address (default `127.0.0.1:11434`).
  - Show these steps in the UI when the extension gets a 403.

### LM Studio
Sources: [openai-compat](https://lmstudio.ai/docs/developer/openai-compat), [cli server-start](https://lmstudio.ai/docs/cli/server-start), [auth](https://lmstudio.ai/docs/developer/core/authentication)
- **Base:** `http://localhost:1234/v1`. Endpoints: `GET /models`, `POST /chat/completions`, `/responses`, `/completions`, `/embeddings`, `/decisions`.
- The API key is a placeholder unless "Require Authentication" is turned on (version 0.4.0 and later). In that case send `Authorization: Bearer <LM token>`.
- **CORS is off by default.** Turn it on with `lms server start --cors` or the "Enable CORS" toggle under Developer > Server Settings (the toggle name comes from third-party guides). The user must turn it on.
- The docs don't say which field carries reasoning. It is probably `reasoning_content`, so handle `reasoning_content`, `reasoning` and `<think>` tags.


## Open questions
- OpenRouter chat-completions image output while streaming: the current OpenAPI ChatStreamDelta has no `images` field, but older docs describe `delta.images[]`. Needs a live test with a real key; until then use stream:false for image requests or parse defensively.
- OpenRouter /api/v1/models: the spec says Bearer auth, but live unauthenticated requests returned 200. This could change; send the key when there is one.
- Z.AI: is there an OpenAI-style GET /api/paas/v4/models? It's undocumented and returns 401 without a key. Also not fetched: the async image poll path (get-image-status page) and the non-streaming field name `message.reasoning_content` (implied by the streaming field and the assistant-message example).
- Z.AI: are older CogView-4 models still accepted on /images/generations? The enum lists only `glm-image`, but the size rules mention 'other models'.
- Perplexity: how long will legacy POST /chat/completions keep working after support ended on 2026-09-27? Also, the changelog says GET /v1/models needs no auth, but the live probe returned 401.
- Groq: does streaming send reasoning in `delta.reasoning`, and does usage arrive in `x_groq.usage` or through stream_options.include_usage? Not shown in the docs I read.
- Ollama and LM Studio: exact reasoning field name in OpenAI-compatible responses (`reasoning` vs `reasoning_content`) isn't documented. Also unverified: whether Firefox sends an Origin header on privileged background fetches to localhost, and whether a Chrome declarativeNetRequest rule can strip the Origin header from the extension's own requests (a possible workaround for OLLAMA_ORIGINS).
- Mistral: exact aliases like `mistral-large-latest` aren't listed on the model pages; use `aliases` from GET /v1/models at runtime.
