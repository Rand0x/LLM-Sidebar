# Browser extension platform facts (verified 2026-11-03)

**Current versions:** Chrome stable is **157** (157.0.8103.27 on Windows, stable date 2026-11-03; 156 went stable 2026-10-20). Chrome for Testing stable is 156.0.8078.80 ([versionhistory API](https://versionhistory.googleapis.com/v1/chrome/platforms/win/channels/stable/versions), [CfT JSON](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json), [chromiumdash](https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=157)). Firefox release is **159** (2026-10-27). Firefox 160 is due 2026-11-10, and Firefox now ships about every 2 weeks ([whattrainisitnow](https://whattrainisitnow.com/calendar/)). Puppeteer 25.16.0 (2026-10-22) pins Chrome 156.0.8078.80 and Firefox stable_159.0 ([revisions.ts](https://raw.githubusercontent.com/puppeteer/puppeteer/main/packages/puppeteer-core/src/revisions.ts)).

---

## 1. Chrome `sidePanel` API
Source: [developer.chrome.com/docs/extensions/reference/api/sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel), plus MDN BCD.

**Manifest**
```json
"permissions": ["sidePanel"],
"side_panel": { "default_path": "sidepanel.html" },
"action": { "default_title": "AI Sidebar" }
```
- Do not set `action.default_popup` if the toolbar icon should open the panel.

**Method and event availability**

| API | Chrome version |
|---|---|
| `setOptions({tabId?, path?, enabled?})`, `getOptions`, `setPanelBehavior`, `getPanelBehavior` | 114 |
| `open({tabId?\|windowId})` | 116 |
| `getLayout()` (returns side left/right) | 140 |
| `close({tabId?\|windowId?})` | 141 |
| `onOpened(PanelOpenedInfo{path, tabId?, windowId})` | 141 |
| `onClosed(PanelClosedInfo{path, tabId?, windowId})` | 142 |

- **`setPanelBehavior({openPanelOnActionClick:true})`** makes a toolbar click toggle the panel. It is an "upsert", so call it at service-worker top level or in `onInstalled`. In practice `action.onClicked` stops firing once this is set (community knowledge, not stated in the docs).
- **`close()` gotcha:** since Chrome 145, calling `close({tabId})` when only the global panel is open rejects with an error. Before 145 it closed the global panel.
- **Toggle from a shortcut or menu:** track open state with `onOpened`/`onClosed`, then call `open()` or `close()`.

**User gesture rule for `open()`**
- The docs say `open()` "may only be called in response to a user action". Listed triggers are an action click, a keyboard shortcut (`commands`), a context menu, and "a user gesture on an extension page or content script".
- `contextMenus.onClicked(info, tab)` works: `chrome.sidePanel.open({ windowId: tab.windowId })`.
- `commands.onCommand(cmd, tab)` works the same way.
- **`runtime.onMessage` from a content-script click works.** The official sample sends `chrome.runtime.sendMessage({type:'open_side_panel'})` from a content-script button click. The service worker then calls `chrome.sidePanel.open({ tabId: sender.tab.id })` ([sample](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/cookbook.sidepanel-open)).
- **Gotcha:** call `open()` first and synchronously in the handler, before any `await` (for example a storage read). Otherwise the gesture is lost and you get "may only be called in response to a user gesture". Stash the payload (such as `info.selectionText`) in `storage.session` after calling `open()`. The panel then reads it on load or after a "ready" handshake.
- `tabId` opens a tab-specific panel; `windowId` opens the global panel.

## 2. Firefox

**Sidebar**
- Firefox has no `sidePanel` API or `side_panel` key. Chrome has no `sidebar_action` (MDN BCD).
- Manifest ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/sidebar_action)):
  ```json
  "sidebar_action": {
    "default_panel": "sidepanel.html",
    "default_title": "AI Sidebar",
    "default_icon": "icons/32.png",
    "open_at_install": false
  }
  ```
  - `open_at_install` defaults to `true`.
  - Never set `browser_style: true`; it is unsupported in MV3 from Firefox 118.
- APIs:
  - `sidebarAction.open()` and `close()`: Firefox 57.
  - `isOpen({windowId})`: Firefox 59.
  - `toggle()`: Firefox 73.
  - `setPanel`/`setTitle`/`setIcon` with `{tabId|windowId}`: Firefox 61.
  - No badge, `onFocus` or `onBlur`.
- **User-action rule** ([MDN User_actions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/User_actions)):
  - Valid triggers are an action click, an extension menu item, an extension keyboard shortcut (Firefox 63+), a click on a page bundled with the extension, and an omnibox suggestion (Firefox 142+).
  - **A content-script click relayed by message is NOT a user action** (stated explicitly).
  - **Any `await` before the call loses user-action status.**
- **Pattern:** `browser.action.onClicked.addListener(() => browser.sidebarAction.toggle())`. The special command `_execute_sidebar_action` opens the sidebar from a shortcut ([commands](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/commands)).
- **Possible workaround for in-page buttons (my inference, not tested):** render the button inside a `moz-extension://` iframe (web_accessible_resources). That counts as "a page bundled with the extension", so it can call `sidebarAction.open()` directly.
- **New sidebar:** the revamped sidebar is on for all release users from **Firefox 157** (2026-09-29, "Nova" UI). `sidebar.revamp=false` restores the old one until the end of 2027 ([157 release notes](https://www.firefox.com/en-US/firefox/157.0/releasenotes/)).
  - Extension sidebars appear as icons in the sidebar launcher.
  - Earlier user threads said users could not unpin extension icons from the launcher, so keep `open_at_install` deliberate.
  - The sidebar is one panel per window, shared with built-in tools.

**Background**
- Firefox still does **not** support `background.service_worker` (BCD `version_added: false`; [bug 1573659](https://bugzil.la/1573659)).
- Use `background.scripts`, which runs as a non-persistent event page. `"type":"module"` is supported in Firefox 112+ and Chrome 92+. `preferred_environment` is Firefox 136+ and is ignored by Chrome.
- A dual manifest is the documented cross-browser pattern ([MDN background](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)):
  ```json
  "background": { "service_worker": "bg.js", "scripts": ["bg.js"], "type": "module" }
  ```
  - Chrome 121+ uses `service_worker` and ignores `scripts` in MV3. Before 121 it refused to load.
  - Firefox 121+ uses `scripts`. In Firefox ≤120 the background did not start when `service_worker` was present.
  - If only `service_worker` is given, Firefox fails with "background.service_worker is currently disabled".
- Shared `bg.js` must be service-worker-safe: no DOM, `window`, `localStorage`, `XMLHttpRequest` or `DOMParser`, and no dynamic `import()` in Chrome's service worker.

**`host_permissions` in Firefox MV3**
- From Firefox 127, entries in `host_permissions` and `content_scripts` are shown in the install prompt and granted when the user accepts it.
- Users can revoke them at any time in about:addons > Permissions.
- New host permissions added in an update are not prompted for ([bug 1893232](https://bugzil.la/1893232)).
- Always check `permissions.contains({origins})`. If missing, call `permissions.request({origins})` from a click handler on an onboarding or options page ([MDN host_permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions)).
- **Gotcha: Firefox match patterns with a port silently match nothing.** For example `http://localhost:11434/*` stays CORS-blocked even though about:addons shows it as granted. Use `http://localhost/*` instead ([bug 2052000](https://bugzilla.mozilla.org/show_bug.cgi?id=2052000), a duplicate of 1362809).
- Firefox 153 made `file://` access a separate opt-in permission. `<all_urls>` no longer grants it ([blog](https://blog.mozilla.org/addons/2026/07/23/firefox-153-webextensions-api-updates/)).

**`browser_specific_settings.gecko`** ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings))
```json
"browser_specific_settings": {
  "gecko": {
    "id": "ai-sidebar@example.org",
    "strict_min_version": "140.0",
    "data_collection_permissions": { "required": ["websiteContent"], "optional": ["technicalAndInteraction"] }
  },
  "gecko_android": {}
}
```
- **`id` is required to sign MV3.** AMO does not assign one. Use an email-like string of 80 characters or fewer.
- **`data_collection_permissions` is mandatory for new AMO submissions since 2025-11-03.** Missing or incorrect values are rejected at signing.
  - Built-in consent works on Firefox desktop 140+ and Android 142+ ([Extension Workshop](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)).
  - `required` is `["none"]` or a list from: `authenticationInfo, bookmarksInfo, browsingActivity, financialAndPaymentInfo, healthInfo, locationInfo, personalCommunications, personallyIdentifyingInfo, searchTerms, websiteActivity, websiteContent`.
  - `technicalAndInteraction` can only be `optional`.
  - `personalCommunications` (which covers "chat messages") is not eligible for implicit consent. `websiteContent` is.
  - Request optional types at runtime with `permissions.request({data_collection:[...]})` from a user action.
- Policy: "Data may be transmitted only as a direct, immediate consequence of a single, deliberate user command." No passive or background transmission without explicit consent ([add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)).

**Firefox MV3 default CSP gotcha**
- The default CSP is `script-src 'self'; upgrade-insecure-requests;`, so `http:` and `ws:` requests are upgraded to `https:` ([MDN CSP](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_Security_Policy)).
- For user-entered HTTP endpoints (LAN Ollama, LM Studio), override it: `"content_security_policy": {"extension_pages": "script-src 'self'"}`.

## 3. Namespace
- **Chrome 148+ exposes `browser.*` for all extension APIs** in content scripts, service workers and offscreen documents. `chrome.tabs === browser.tabs` ([browser-namespace](https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace), [whats-new](https://developer.chrome.com/docs/extensions/whats-new) 2026-05-08).
  - Extensions with a DevTools page did not get it before Chrome 152.
  - webextension-polyfill does nothing on 148+.
- Recommended shim, placed first in every entry point:
  ```js
  if (!globalThis.browser) { globalThis.browser = chrome; }
  ```
  Or set `"minimum_chrome_version": "148"` and drop the shim.
- **Feature-detect the sidebar API:** `browser.sidePanel` for Chrome, `browser.sidebarAction` for Firefox.
- **`onMessage` returning a Promise** is supported in Chrome 148, but [messaging docs](https://developer.chrome.com/docs/extensions/develop/concepts/messaging) say it is "rolling out gradually". For portability use `sendResponse` plus `return true` (a literal `true`).
  - Since Chrome 146, a listener that throws or rejects with an `Error` rejects the sender's promise.
  - Do not register a catch-all `async` listener: it returns a promise for every message and claims all responses.
- **Message serialization:**
  - Chrome uses JSON by default, with a 64 MiB limit. Firefox uses structured clone.
  - Chrome 148+ can opt in with the manifest key `"message_serialization": "structured_clone"` ([blog](https://developer.chrome.com/blog/structured-clone-messaging)). Endpoints with mismatched modes cannot talk to each other.
  - For images, pass data URLs or IndexedDB keys rather than Blobs.

## 4. Content scripts, storage, service worker lifetime, fetch

**Storage** ([chrome.storage](https://developer.chrome.com/docs/extensions/reference/api/storage))

| Area | Quota | Content-script access by default |
|---|---|---|
| `storage.local` | 10 MB (5 MB in Chrome ≤113); `unlimitedStorage` removes the cap | Yes |
| `storage.sync` | 100 KB total, 8 KB per item, 512 items, 120 writes/min | Yes |
| `storage.session` | 10 MB | No (Chrome can change it with `setAccessLevel({accessLevel:'TRUSTED_AND_UNTRUSTED_CONTEXTS'})`) |

- Chrome now also documents `storage.local/sync.setAccessLevel()`. Firefox does **not** support `setAccessLevel`; it has `storage.session` from Firefox 115 and `getKeys` from Firefox 143 (Chrome 130).
- **Security:** API keys in `storage.local` are readable by content scripts in both browsers. They are stored unencrypted, and they must not go in `sync`.
  - In Chrome, consider `storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})`.
  - In both browsers, keep the keys out of content scripts entirely: content scripts message the background or panel and never read the keys.

**Chrome MV3 service worker lifetime** ([lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [blog](https://developer.chrome.com/blog/longer-esw-lifetimes))
- Terminated after 30 s idle.
- Since Chrome 110, any event or extension API call resets the idle timer.
- Since Chrome 114, sending messages on a `runtime.connect` port keeps the worker alive. **Opening a port alone no longer resets the timers.**
- Since Chrome 116, WebSocket activity resets the timer.
- Also terminated if a single event or API call takes more than 5 minutes, or "when a `fetch()` response takes more than 30 seconds to arrive".
- **Implications for streaming:**
  - Each `port.postMessage(chunk)` is an API call, so an active stream keeps the worker alive.
  - Danger zone: time-to-first-byte over 30 s. Reasoning models and non-streaming image generation can exceed this. Mitigate with a heartbeat, for example `chrome.runtime.getPlatformInfo()` or a port ping every ~20 s.
  - Abort the fetch on `port.onDisconnect`.
- **Better architecture:** run provider fetches inside the side-panel document itself. It is an extension page with the same host-permission CORS bypass and lives as long as the panel is open. Use the service worker only for content-script flows when the panel is closed.

**Firefox event page**
- Firefox uses activity-based idle. MDN text is contradictory about whether ports keep it alive; Firefox tests show an open port postpones suspension ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)).
- Use the same heartbeat and port strategy.

**Fetch and CORS**
- The service worker and extension pages bypass CORS for origins in granted `host_permissions` ([network-requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)).
- **Content scripts do not bypass CORS** (Chrome 85+, [chromium.org](https://www.chromium.org/Home/chromium-security/extension-content-script-fetches/); MDN says the same for Firefox). Relay through the background and don't accept arbitrary URLs from content scripts.
- If the user withholds site access, the bypass is lost.
- **Origin header:** in practice extension-origin requests carry `Origin: chrome-extension://<id>` or `moz-extension://<uuid>`, at least on POST. Evidence:
  - Anthropic returns 401 "CORS requests must set 'anthropic-dangerous-direct-browser-access' header" to extensions in both browsers ([chatGPTBox#788](https://github.com/ChatGPTBox-dev/chatGPTBox/issues/788), [page-assist#511](https://github.com/n4ze3m/page-assist/issues/511)). Send `anthropic-dangerous-direct-browser-access: true`.
  - The Ollama FAQ says to set `OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*,safari-web-extension://*` ([FAQ](https://docs.ollama.com/faq.md)).
  - A Chrome engineer described host-permitted requests as same-site, and said the browser does not set Origin on them ([w3 list](https://lists.w3.org/Archives/Public/public-webapps-github/2025Nov/0193.html)). Do not rely on Origin being absent.
- Removing Origin is possible via DNR `modifyHeaders` (`declarativeNetRequestWithHostAccess`, `initiatorDomains:[chrome.runtime.id]`). This is unverified on current versions.

## 5. Automated testing (Chrome 137+ branded builds have no `--load-extension`)
- Chrome 137 removed `--load-extension` from branded Chrome. It still works in Chromium and Chrome for Testing ([PSA](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)). Chrome 139 also removed `--disable-extensions-except` and `--extensions-on-chrome-urls` from branded builds.
- **CDP:** `Extensions.loadUnpacked{path, enableInIncognito?} -> {id}`, plus `getExtensions`, `uninstall`, `triggerAction{id,targetId}`, and `get/set/remove/clearStorageItems{id, storageArea}` ([pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Extensions.pdl)).
  - It used to require `--remote-debugging-pipe` plus `--enable-unsafe-extension-debugging`.
  - Puppeteer **25.2.0** (2026-06-22, Chrome 150) removed that requirement ("allow extensions to run over websockets", commit b84d8a1).
- **Minimal Chrome setup (recommended): Puppeteer ≥25.2.** It downloads Chrome for Testing.
  ```js
  const browser = await puppeteer.launch({ enableExtensions: [absPath] }); // headless default = new headless, supports extensions
  const sw = await browser.waitForTarget(t => t.type()==='service_worker' && t.url().startsWith('chrome-extension://'));
  const id = new URL(sw.url()).host;
  const page = await browser.newPage(); await page.goto(`chrome-extension://${id}/sidepanel.html`); // test panel UI as a tab
  ```
  - Alternatives: `enableExtensions:true` plus `await browser.installExtension(absPath)`, and `page.extensionRealms()` for content scripts.
  - Caveat: Puppeteer's `Promise.all([array.map(...)])` does not await each install, so wait for the service worker target.
  - For older Puppeteer (24.8–25.1) use `pipe:true`.
- **Playwright** ([docs](https://playwright.dev/docs/chrome-extensions)):
  ```js
  chromium.launchPersistentContext(dir, { channel: 'chromium', args: [`--disable-extensions-except=${p}`, `--load-extension=${p}`] })
  ```
  - Get the extension ID with `(context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')).url().split('/')[2]`.
  - Playwright cannot load Firefox extensions.
- **Firefox:** use `web-ext run` (temporary install) or Puppeteer with `browser:'firefox'` and `browser.installExtension(path)` (WebDriver BiDi `webExtension.install`).
- **web-ext ≥8.8.0** supports `run -t chromium` on Chrome 137+ via CDP. The latest is 10.8.0 (2026-10-15), with lint schemas up to Firefox 158.

## 6. Packaging and distribution

**Chrome Web Store** ([prepare](https://developer.chrome.com/docs/webstore/prepare), [publish](https://developer.chrome.com/docs/webstore/publish), [MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements))
- **Zip:** `manifest.json` must be in the zip root, not in a folder. No comments in the manifest. Each upload needs a higher version. Size limit is 2 GB.
- **Privacy tab:** declare the single purpose, permission justifications and data use.
- New publishers can have at most 2 published extensions. Visibility can be Public, Unlisted or Private.
- **No remote code:** no remote `<script>`, and no `eval` of fetched strings. Never execute LLM output; render Markdown through a sanitizer.
- Off-store `.crx` installs are blocked on Windows and macOS except through enterprise policy. For personal use, use "Load unpacked" in developer mode.

**AMO** ([web-ext reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/))
- `web-ext lint` checks the package.
- `web-ext build` writes `./web-ext-artifacts/{name}-{version}.zip`; add `-o` to overwrite.
- Signing command (`--channel` is mandatory in web-ext 10):
  ```
  web-ext sign --channel=unlisted --api-key=$WEB_EXT_API_KEY --api-secret=$WEB_EXT_API_SECRET [--upload-source-code src.zip]
  ```
  `unlisted` downloads a signed XPI for self-distribution; `listed` needs `--amo-metadata` on the first version.
- If you use a bundler or minifier, upload source code. AMO runs a `build-for-amo` npm script when `package.json` has one.
- Release and Beta builds require signed add-ons. Developer Edition and Nightly allow `xpinstall.signatures.required=false`.

**Temporary loading in Firefox** ([guide](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/))
- Go to `about:debugging` > This Firefox > Load Temporary Add-on, and pick any file in the extension folder or the .zip.
- The add-on is removed on restart. "Reload" re-reads the manifest.
- Install-time permission prompts are not shown. Verify host access in about:addons > Permissions, or request it from a click.

**Manifest strategy:** each browser warns about the other's keys (`side_panel`/`sidePanel`, `sidebar_action`, `browser_specific_settings`, `minimum_chrome_version`). Generate one manifest per browser at build time, with a shared core and per-browser overrides.

## Open questions
- Which Firefox data_collection_permissions should be declared for an AI chat sidebar? Candidates are websiteContent (selection or page sent on a user command, eligible for implicit consent) and personalCommunications (user chat text, which needs explicit consent). AMO reviewer interpretation is not documented.
- Does Firefox MV3's default 'upgrade-insecure-requests' also upgrade http://localhost or 127.0.0.1 requests (for local Ollama or LM Studio), or only LAN and remote http hosts? Not documented. Test it, or override extension_pages CSP.
- With openPanelOnActionClick:true, does the '_execute_action' keyboard command also toggle Chrome's side panel? Not confirmed in official docs.
- In Firefox, does a click inside a web-accessible moz-extension:// iframe injected into a page count as a user action for sidebarAction.open()? This is inferred from MDN's 'page bundled with the extension' rule, not tested.
- Exact Origin header behavior: Chrome may omit Origin on GET from the service worker or extension pages to host-permitted origins, while POSTs evidently carry chrome-extension:// or moz-extension:// (per Anthropic 401 reports). A Chrome engineer's 'same-site, no Origin' statement conflicts with this. Verify empirically per provider.
- Does a pending (not yet responding) fetch in a Chrome service worker trigger termination after 30 s even when other extension API calls keep resetting the idle timer? The docs list it as a separate condition. The heartbeat mitigation is assumed sufficient but unverified.
- Are MV3 host_permissions automatically granted for temporarily installed Firefox add-ons (about:debugging), given that no install prompt is shown?
- Does DNR modifyHeaders (remove Origin) reliably apply to the extension's own fetches in current Chrome and Firefox?
