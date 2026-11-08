# Contributing

Thanks for helping to improve LLM Sidebar! Bug reports, translations and pull requests are welcome.

## Development setup

Requirements: [Node.js](https://nodejs.org) 22 or newer. There are no npm dependencies – no
`npm install` needed.

```bash
npm test          # unit tests (node:test)
npm run build     # builds dist/chrome and dist/firefox
npm run dev       # dev harness with a mock AI server on http://localhost:8787
```

The dev harness runs the side panel, the content script and the background script in a normal
browser tab with an emulated extension API, so you can try everything without an API key. See
the "Development" section of the [README](README.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

To try a real build, load `dist/chrome` as an unpacked extension (`chrome://extensions`,
developer mode) or `dist/firefox/manifest.json` as a temporary add-on (`about:debugging`).

## Pull requests

- Keep changes focused; one topic per pull request.
- Plain ES modules, no build step, no runtime dependencies. Please don't add any.
- Add or update tests for behaviour changes and make sure `npm test` passes.
- Every user-visible string goes through `t()` – see [docs/I18N.md](docs/I18N.md). Add the German
  and English text; other languages may fall back to English until a translator updates them.
- Never log or transmit API keys, page contents or chat contents anywhere except to the
  provider the user selected.

## Translations

Translations live in `src/locales/<code>/`. To improve a translation, edit the values in those
files (keep the keys, `{placeholders}`, emoji and keyboard shortcuts). To add a language, follow
[docs/I18N.md](docs/I18N.md#adding-a-language). `npm test` checks that every catalog has the same
keys and placeholders as the German source.

## Reporting bugs

Please include the browser and version, the provider and model you used, what you did, what you
expected and what happened instead. Remove API keys and personal data from screenshots and logs.
