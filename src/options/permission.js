// Host permission (<all_urls>) shared by the onboarding banner and the "Daten & Datenschutz" section.

import { ext } from '../lib/ext.js';

export const ALL_URLS = { origins: ['<all_urls>'] };

const listeners = new Set();

function notify() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[LLM Sidebar] Could not update the permission display:', err);
    }
  }
}

/** → 'granted' | 'missing' | 'unknown' */
export async function hostAccessState() {
  if (!ext?.permissions?.contains) return 'unknown';
  try {
    return (await ext.permissions.contains(ALL_URLS)) ? 'granted' : 'missing';
  } catch {
    return 'unknown';
  }
}

/**
 * Asks the browser for <all_urls>. Call it synchronously from a click handler: nothing may be
 * awaited before permissions.request() (user-gesture rule). → Promise<boolean>
 */
export function requestHostAccess() {
  let pending;
  try {
    pending = ext.permissions.request(ALL_URLS);
  } catch (err) {
    return Promise.reject(err);
  }
  return Promise.resolve(pending).then((granted) => {
    notify();
    return granted === true;
  });
}

/** `cb` runs whenever the permission may have changed (here, in another tab or in the browser settings). */
export function onHostAccessChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

try {
  ext?.permissions?.onAdded?.addListener?.(notify);
  ext?.permissions?.onRemoved?.addListener?.(notify);
} catch {
  // permission events are optional (dev shim)
}
