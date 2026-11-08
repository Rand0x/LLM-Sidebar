// Cross-browser access to the WebExtension API.
// Firefox exposes a promise-based `browser`; Chrome's MV3 `chrome` returns promises as well.
export const ext = globalThis.browser ?? globalThis.chrome;

export const IS_FIREFOX = (() => {
  try {
    return ext.runtime.getURL('').startsWith('moz-extension:') || typeof ext.runtime.getBrowserInfo === 'function';
  } catch {
    return false;
  }
})();

// storage.session is available in Chrome >= 102 and Firefox >= 115; fall back to local otherwise.
export const sessionArea = ext?.storage?.session ?? ext?.storage?.local;

export function lastErrorMessage(e) {
  if (!e) return ext?.runtime?.lastError?.message ?? '';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}
