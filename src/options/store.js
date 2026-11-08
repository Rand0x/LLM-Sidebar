// Settings state for the options page.
//
// Every edit is a keyed patch function `(settings) => void` that sets absolute values. Patches are
// applied to the local working copy right away and saved debounced through updateSettings(), which
// re-reads storage first – so a save only touches the fields the user changed and never overwrites
// changes made elsewhere (side panel, background, another options tab) with a stale copy.
//
// working = normalize(base + recently saved + in-flight + pending patches), where base is the latest
// value seen in storage. External changes therefore merge naturally with unsaved local edits.

import { getSettings, saveSettings, updateSettings, onSettingsChanged, normalizeSettings } from '../lib/settings.js';
import { deepClone, debounce } from '../lib/utils.js';

const SAVE_DELAY = 400;
// Saved patches stay applied a little longer, until storage.onChanged has delivered the write.
const RECENT_MS = 2500;

export function createStore() {
  let base = null;
  let working = null;
  let pending = [];
  let inflight = [];
  let recent = [];
  let saving = false;
  let savePromise = Promise.resolve();
  let eventSeq = 0;
  let lastError = null;
  const invalid = new Set();
  const listeners = new Set();
  const statusListeners = new Set();
  const savedListeners = new Set();
  const errorListeners = new Set();

  const schedule = debounce(() => {
    flush();
  }, SAVE_DELAY);

  function runPatches(target, list) {
    for (const patch of list) {
      try {
        patch.fn(target);
      } catch (err) {
        console.error('[LLM Sidebar] Could not apply change:', err);
      }
    }
    return target;
  }

  function recompute() {
    const now = Date.now();
    recent = recent.filter((r) => r.until > now);
    working = normalizeSettings(runPatches(deepClone(base), [...recent, ...inflight, ...pending]));
  }

  function emit(info) {
    for (const listener of listeners) {
      try {
        listener(info);
      } catch (err) {
        console.error('[LLM Sidebar] Updating the settings page failed:', err);
      }
    }
  }

  function getStatus() {
    if (lastError && (pending.length || inflight.length)) return 'error';
    if (saving) return 'saving';
    if (pending.length) return 'pending';
    if (invalid.size) return 'invalid';
    return 'saved';
  }

  function emitStatus() {
    const status = getStatus();
    for (const listener of statusListeners) listener(status, lastError);
  }

  async function init() {
    let seenEvent = false;
    onSettingsChanged((next) => {
      eventSeq += 1;
      seenEvent = true;
      base = next;
      if (!working) return; // still loading: the event value wins over the initial read
      recompute();
      emit({ external: true });
    });
    const loaded = await getSettings();
    if (!seenEvent) base = loaded;
    recompute();
    return working;
  }

  /**
   * Applies `fn` to the working copy and schedules a save. `key` identifies the edited field:
   * a newer patch with the same key replaces the older one (keystrokes coalesce).
   * opts.source: id of the section that made the change (it is not re-rendered unless opts.refresh).
   */
  function commit(key, fn, { source = null, refresh = false } = {}) {
    if (!working) return;
    pending = pending.filter((p) => p.key !== key);
    pending.push({ key, fn });
    working = normalizeSettings(runPatches(working, [{ key, fn }]));
    lastError = null;
    schedule();
    emit({ external: false, source, refresh });
    emitStatus();
  }

  async function flush() {
    schedule.cancel();
    if (saving) {
      await savePromise;
      if (pending.length) return flush();
      return undefined;
    }
    if (!pending.length) {
      emitStatus();
      return undefined;
    }
    saving = true;
    inflight = pending;
    pending = [];
    const seq = eventSeq;
    emitStatus();
    savePromise = (async () => {
      try {
        const batch = inflight;
        const saved = await updateSettings((fresh) => {
          runPatches(fresh, batch);
        });
        // Only adopt the save result when no newer storage event arrived meanwhile.
        if (eventSeq === seq) base = saved;
        const until = Date.now() + RECENT_MS;
        recent = [...recent.filter((r) => !batch.some((p) => p.key === r.key)), ...batch.map((p) => ({ ...p, until }))];
        inflight = [];
        lastError = null;
        recompute();
        emit({ external: false, saved: true });
        for (const listener of savedListeners) listener();
      } catch (err) {
        lastError = err;
        // Back to the queue; newer edits of the same field win.
        pending = [...inflight.filter((p) => !pending.some((q) => q.key === p.key)), ...pending];
        inflight = [];
        for (const listener of errorListeners) listener(err);
      } finally {
        saving = false;
        emitStatus();
        if (pending.length && !lastError) schedule();
      }
    })();
    return savePromise;
  }

  /** Replaces all settings (import, reset). Unsaved edits are discarded. */
  async function replaceAll(next) {
    schedule.cancel();
    await savePromise;
    pending = [];
    recent = [];
    invalid.clear();
    const saved = await saveSettings(next);
    base = saved;
    recompute();
    emit({ external: true, replaced: true });
    emitStatus();
    return working;
  }

  function setInvalid(key, isInvalid) {
    const had = invalid.has(key);
    if (isInvalid) invalid.add(key);
    else invalid.delete(key);
    if (had !== Boolean(isInvalid)) emitStatus();
  }

  return {
    init,
    get: () => working,
    commit,
    flush,
    replaceAll,
    setInvalid,
    clearInvalid: (prefix) => {
      for (const key of [...invalid]) if (key.startsWith(prefix)) invalid.delete(key);
      emitStatus();
    },
    hasUnsaved: () => pending.length > 0 || inflight.length > 0 || saving,
    hasInvalid: () => invalid.size > 0,
    status: getStatus,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onSaved(listener) {
      savedListeners.add(listener);
      return () => savedListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
  };
}
