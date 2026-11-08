# LLM Sidebar

**English** · [Deutsch](README.de.md)

An AI sidebar for **Chrome** and **Firefox** that uses **your own API key** and **your choice of
provider**: OpenAI, Claude (Anthropic), Grok (xAI), OpenRouter, Z.AI (GLM), Google Gemini,
Mistral, DeepSeek, Groq, Ollama Cloud, local models via Ollama or LM Studio, and any custom
OpenAI- or Anthropic-compatible endpoint.

Everything stays in your browser: settings, API keys and chat history. There is no server of our
own, no account and no telemetry. Only your actual request goes directly to the provider you
selected.

## Features

- **Chat in the sidebar**: multiple chats with history and search, streaming answers, Markdown
  with code blocks, a model switch per chat, personas and your own system prompts
- **Chat with the web page**: turn on "Page" and the content of the active tab is sent along as
  context – to summarize it or ask questions about an article
- **Summarize YouTube videos**: when a YouTube video is open, the sidebar offers "Summarize video".
  It works from the video's transcript (or title, description and chapters if there is none). The
  summary is written in the language you pick in the card or under **Settings → Translation &
  toolbar → YouTube videos** and contains timestamps: clicking `[3:15]` jumps to that point in the
  video. Afterwards you can keep asking questions about the video.
- **Images**: attach images (for models with vision) and generate images (OpenAI, Grok, Gemini,
  Z.AI, OpenRouter …) with 🖼 or `/image <description>` (`/bild` works too)
- **Text tools on every web page**: select text and a small toolbar appears with Improve,
  Rewrite, Correct, Shorten, Expand, More formal, More casual, Personalize, Summarize, Explain,
  Draft reply and Translate. Copy the result, replace the text in the input field, refine it
  ("shorter", "less formal") or continue in the chat. This also works in embedded editors
  (iframes) as used by many webmail and CMS apps.
- **Translation**: the selected text or the **whole page**, in place. Switch between original and
  translation with one click; content loaded later is translated as well.
- **Context menu** (right-click → "LLM Sidebar") with all quick actions, translate, "Ask in chat",
  translate page, restore original page and summarize page
- **Keyboard shortcuts**: `Alt+Shift+L` opens the sidebar, `Alt+Shift+T` translates the page. You
  can assign your own shortcuts to "Restore original page" and "Summarize page"
  (see [Usage](#usage)).
- **Custom quick actions**: prompts, icons and order are fully customizable
- **Personalization**: store "About me" and your writing style. The "Personalize" action (and the
  chat, if you like) uses them.
- **Costs & balance**: every answer shows the tokens used and its cost (reported by OpenRouter and
  xAI, otherwise estimated from the per-token price; the chat total is in the ⋯ menu). Quick action
  results and translations show their tokens and cost too – for a page translation the total of
  all requests on the page, right in the status pill. **Settings →
  Costs & balance** shows usage per month, provider and model (chat, quick actions, translations,
  images) and lets you enter your own prices. OpenRouter (key limit and usage) and DeepSeek report
  the remaining balance directly, xAI with an additional management key (**Costs & balance → xAI
  → Set up**). OpenAI, Anthropic, Google and the other providers don't expose it with a normal API
  key, so there is a link to your account instead.
- **Multilingual**: the interface is available in English, German, Spanish, French, Italian,
  Portuguese (Brazil), Dutch, Polish, Turkish, Russian, Japanese and Simplified Chinese. It follows
  your browser language and can be changed under **Settings → Appearance → Language**.
  Translations and video summaries default to the interface language.
- Light and dark theme, export and import of settings and chats

**Scope:** from the provider APIs the extension uses text chat, image understanding (attached
images, if the model supports it) and image generation (if the provider offers it), plus the
content of the current web page as context. Chat, quick actions and translation build on that.
Other features some providers offer are deliberately **not** supported: text-to-speech, speech
input/transcription, video generation, the providers' built-in web search, file and PDF
attachments, and tool calls (tools/agents).

## Installation

Building requires [Node.js](https://nodejs.org) 22 or newer. No packages are installed.

```bash
npm run build
```

The finished extensions are then in `dist/chrome` and `dist/firefox`.
Supported: Chrome, Edge and Brave 116+ and Firefox 142+.

### Chrome, Edge, Brave

1. Open `chrome://extensions` (Edge: `edge://extensions`)
2. Turn on **Developer mode** (top right)
3. Click **"Load unpacked"** and select the `dist/chrome` folder
4. Pin the icon via the puzzle menu. Clicking it opens the sidebar.

### Firefox

**To try it out (until the next restart):**

1. Open `about:debugging#/runtime/this-firefox`
2. Click **"Load Temporary Add-on…"** and select `dist/firefox/manifest.json`
3. **Allow access to websites** (see below)
4. Open the sidebar via the toolbar icon or with `Alt+Shift+L`

**Permanent installation:** Firefox only installs signed add-ons permanently. You have two options:

- Have it signed for free on [addons.mozilla.org](https://addons.mozilla.org/developers/) as
  "unlisted" (self-distribution). `npm run zip` creates the zip file for that.
  With [web-ext](https://github.com/mozilla/web-ext) it also works from the command line:
  `web-ext sign --channel=unlisted --source-dir dist/firefox --api-key=… --api-secret=…`
- Or use **Firefox Developer Edition / Nightly** and set `xpinstall.signatures.required` to
  `false` in `about:config`

**Allow access to websites:** the toolbar, page translation, page context in the chat and requests
to some providers need access to all websites. Firefox doesn't always grant it automatically: a
permanent installation asks in the install dialog, a temporary add-on may lack it, and you can
revoke it at any time.

1. If access is missing, the settings (they open automatically after installation) and the
   sidebar show a notice with an **"Allow access"** button.
2. Click it and confirm Firefox's prompt with **"Allow"**.
3. Alternatively: `about:addons` → LLM Sidebar → **Permissions** tab → turn on "Access your data
   for all websites". You can revoke access there as well.

Reload tabs that were already open afterwards.

## Getting started

1. After installation the **settings** open automatically (otherwise: right-click the icon →
   Options, or the gear in the sidebar).
2. Enter your API key under **Providers**. This enables the provider automatically. **"Test
   connection"** checks the key, **"Load models"** fetches the current model list.
3. Optionally choose under **Default models** which model is used for chat, quick actions,
   translation and images. Without a choice, the extension uses the first ready provider.

| Provider | Create a key | Image generation |
|---|---|---|
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | yes (GPT Image) |
| Claude (Anthropic) | [console.anthropic.com](https://console.anthropic.com/settings/keys) | no |
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | yes (depending on the model) |
| Grok (xAI) | [console.x.ai](https://console.x.ai) | yes (Grok Imagine) |
| Z.AI (GLM) | [z.ai](https://z.ai/manage-apikey/apikey-list) | yes (GLM-Image) |
| Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | yes |
| Mistral | [console.mistral.ai](https://console.mistral.ai/api-keys) | no |
| DeepSeek | [platform.deepseek.com](https://platform.deepseek.com/api_keys) | no |
| Groq | [console.groq.com/keys](https://console.groq.com/keys) | no |
| Ollama Cloud | [ollama.com/settings/keys](https://ollama.com/settings/keys) (Ollama subscription or pay-as-you-go) | no |
| Ollama / LM Studio (local) | no key needed | no |
| Custom provider | any OpenAI- or Anthropic-compatible URL | depends on the server |

### Local models (fully offline)

- **Ollama**: Ollama only accepts requests from browser extensions if you allow it. Set the
  environment variable `OLLAMA_ORIGINS` to `chrome-extension://*,moz-extension://*` and restart
  Ollama. On Windows: Settings → System → About → Advanced system settings → Environment
  variables → user variable "New". Then quit Ollama via its tray icon and start it again.
- **LM Studio**: turn on **"Enable CORS"** under Developer → Server Settings and start the server.

## Usage

| What | How |
|---|---|
| Open the sidebar | Click the icon or `Alt+Shift+L` |
| Edit text | Select text → toolbar, or right-click → LLM Sidebar |
| Translate the whole page | `Alt+Shift+T`, right-click → "Translate page" or the ⋯ menu in the sidebar |
| Restore the original | "Original" in the status pill at the bottom right, right-click → "Restore original page" or the ⋯ menu in the sidebar |
| Summarize the page | "Summarize page" suggestion in the sidebar or right-click |
| Summarize a YouTube video | Open the video → video card in the sidebar, or ⋯ menu → "Summarize video"; on YouTube "Summarize page" uses the transcript as well |
| Generate an image | 🖼 in the input row or `/image <description>` |
| Hide the toolbar on a website | ⋯ in the toolbar → "Hide on this website" |
| Change the interface language | Settings → Appearance → Language |

Only two shortcuts are preset: `Alt+Shift+L` (open the sidebar, or show/hide it in Firefox) and
`Alt+Shift+T` (translate page). "Restore original page" and "Summarize page" have no shortcut, but
you can assign one: in Chrome under `chrome://extensions/shortcuts`, in Firefox under
`about:addons` → gear → "Manage Extension Shortcuts". If a shortcut is already taken by the
browser or another extension it may have no effect – pick a different one.

## Privacy

- Settings, API keys and the cost statistics are stored in `storage.local` of your browser
  profile, chats in IndexedDB. None of it is synced or uploaded.
- The balance is only requested when you open **Costs & balance** or click it in the sidebar's ⋯
  menu, directly from the provider.
- A request is only sent when you trigger it (send a message, click an action, translate a page).
  It goes directly to the provider you chose. What the provider does with the data is governed by
  its terms.
- Web page content is only sent when you turn on "Page" or start an action or translation. The
  page address is sent without query parameters and anchors (`?…`, `#…`); the contents of
  password and one-time-code fields never are.
- Under **Settings → Data & privacy** you can export and delete everything. The settings export
  "Without keys" leaves out API keys and the values of additional HTTP headers, but contains your
  profile ("About me", writing style), personas and quick actions.

## Troubleshooting

- **"Invalid API key"**: paste the key again, watch out for spaces, check your balance with the
  provider.
- **Network error with Ollama / LM Studio**: see "Local models" above (`OLLAMA_ORIGINS` or CORS).
- **Gemini reports "403"**: create a new key in AI Studio. Older unrestricted keys are rejected.
- **The toolbar doesn't appear**: extensions can't run on browser-internal pages (`chrome://`, Web
  Store, addons.mozilla.org). Reload tabs that were open before the installation. In Firefox also
  check the website access (see [Installation](#firefox)).
- **Red "!" on the extension icon**: an action from the context menu or a shortcut couldn't run on
  this page (e.g. protected page, no access, no provider set up). Hover over the icon to see the
  reason. The notice disappears after a few seconds.
- **Firefox: "Continue in chat" or "Ask in chat" doesn't open the sidebar**: Firefox only allows
  opening it after a direct click on the icon. If the sidebar is already open, the chat appears
  there right away. Otherwise the result window shows a hint: open the sidebar via the LLM Sidebar
  icon, the chat waits there (for up to 24 hours).

## Development

```bash
npm test          # unit tests (node:test, no dependencies)
npm run build     # build dist/chrome and dist/firefox
npm run zip       # also create zip files for the Chrome Web Store / AMO
npm run icons     # re-render the icons
npm run dev       # dev harness on http://localhost:8787
```

The **dev harness** (`npm run dev`) runs the complete extension in a normal browser tab – test
page, sidebar and background script – with an emulated extension API and a **mock AI server**, so
you can try everything without a real API key. The mock reacts to keywords in the message:
"denk" (reasoning), `#langsam` (slow), `#ablehnen` (refusal), `#abschneiden` (length limit),
`#fehler429` (any HTTP status) and `#fehlerstream`. Append `?reset=1` to the harness URL to reset
the emulated storage.

Architecture and interfaces are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
translations of the interface in [docs/I18N.md](docs/I18N.md), and the researched provider API
details (as of November 2026) in [docs/research](docs/research).

```
src/
  background/   background script (context menu, shortcuts, requests from the page tools)
  content/      toolbar, result popover and page translation on web pages
  sidepanel/    chat sidebar
  options/      settings
  lib/          shared modules (LLM client, settings, prompts, i18n, Markdown, database …)
  locales/      interface texts, one file per area and language
  styles/       design system
manifests/      manifest parts for Chrome and Firefox
scripts/        build and icon generation
dev/            dev harness and mock server
tests/          unit tests
```

## Contributing & license

Bug reports, translations and pull requests are welcome – see [CONTRIBUTING.md](CONTRIBUTING.md).
Please report security issues privately, see [SECURITY.md](SECURITY.md).
Licensed under the [MIT License](LICENSE).
