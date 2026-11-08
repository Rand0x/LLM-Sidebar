// DOM helpers for extension pages (side panel, options): element builder, toasts, dialogs.
// Styling lives in styles/theme.css (.toast*, .dialog*, .btn*, .input, .textarea).
import { icon } from './icons.js';
import { uid } from './utils.js';
import { t } from './i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
  'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'g', 'defs', 'use',
  'symbol', 'text', 'tspan', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop',
]);
// Attributes that carry URLs: block script-capable schemes as defense in depth.
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'xlink:href', 'data']);
// Set as DOM properties (attributes would only set the initial/default state).
const PROP_ATTRS = new Set(['checked', 'selected', 'indeterminate', 'muted']);

function isPlainAttrs(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    && !(typeof Node !== 'undefined' && value instanceof Node)
    && typeof value[Symbol.iterator] !== 'function';
}

function isSafeUrl(value) {
  // Browsers ignore control chars/whitespace inside the scheme, so strip them before checking.
  const normalized = String(value).replace(/[\u0000- \u007f-\u009f]/g, '');
  return !/^(?:javascript|vbscript):/i.test(normalized);
}

function classValue(value) {
  if (value == null || value === false) return '';
  if (Array.isArray(value)) return value.map(classValue).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    return Object.entries(value).filter(([, on]) => on).map(([name]) => name).join(' ');
  }
  return String(value).trim();
}

function applyStyle(el, style) {
  if (style == null || style === false) return;
  if (typeof style === 'string') {
    el.style.cssText = style;
    return;
  }
  for (const [prop, val] of Object.entries(style)) {
    if (val == null || val === false) continue;
    if (prop.startsWith('--') || prop.includes('-')) el.style.setProperty(prop, String(val));
    else el.style[prop] = String(val);
  }
}

function appendChildren(parent, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) {
      appendChildren(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else if (typeof child === 'object' && typeof child[Symbol.iterator] === 'function') {
      // NodeList, HTMLCollection, Set … (copy first: appending moves nodes out of live lists)
      appendChildren(parent, Array.from(child));
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

/**
 * Tiny element builder.
 * attrs: class/className (string | array | {name: bool}), dataset (object), style (string | object),
 * on<Event> (function → addEventListener, e.g. onClick, onKeydown), html (trusted innerHTML, e.g.
 * icon() output), text (textContent), value/checked/selected/indeterminate (set as properties),
 * htmlFor, boolean attrs (true → present, false/null/undefined → omitted), any other attribute.
 * children: Node | string | number | arrays thereof; null/undefined/false/true are skipped.
 * `attrs` may be omitted: h('p', 'Text') or h('div', [a, b]).
 */
export function h(tag, attrs = {}, ...children) {
  if (!isPlainAttrs(attrs)) {
    if (attrs != null) children.unshift(attrs);
    attrs = {};
  }
  const tagName = String(tag);
  const isSvg = SVG_TAGS.has(tagName);
  const el = isSvg ? document.createElementNS(SVG_NS, tagName) : document.createElement(tagName);
  let deferredValue;
  let hasValue = false;

  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class' || key === 'className') {
      const cls = classValue(value);
      if (cls) el.setAttribute('class', cls);
    } else if (key === 'dataset') {
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (v != null && v !== false) el.dataset[k] = String(v);
        }
      }
    } else if (key === 'style') {
      applyStyle(el, value);
    } else if (key === 'html') {
      if (value != null && value !== false) el.innerHTML = String(value);
    } else if (key === 'text' || key === 'textContent') {
      if (value != null && value !== false) el.textContent = String(value);
    } else if (/^on[A-Za-z]/.test(key)) {
      // Only functions: string handlers would be inline script (CSP violation / injection risk).
      if (typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (Array.isArray(value) && typeof value[0] === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value[0], value[1]);
      }
    } else if (key === 'value') {
      if (value != null) {
        deferredValue = value;
        hasValue = true;
      }
    } else if (PROP_ATTRS.has(key) && !isSvg) {
      el[key] = Boolean(value);
    } else if (value == null || value === false) {
      // omitted attribute
    } else {
      const name = key === 'htmlFor' ? 'for' : key;
      if (URL_ATTRS.has(name.toLowerCase()) && !isSafeUrl(value)) continue;
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }

  appendChildren(el, children);

  // Assign value after children exist (a <select> needs its <option>s first).
  if (hasValue) {
    if ('value' in el && !isSvg) el.value = String(deferredValue);
    else el.setAttribute('value', String(deferredValue));
  }
  return el;
}

// ---------------------------------------------------------------------------------------------
// Animation helper

function removeAfterAnimation(el, fallbackMs) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.removeEventListener('animationend', onEnd);
    el.remove();
  };
  const onEnd = (event) => {
    if (event.target === el) finish();
  };
  el.addEventListener('animationend', onEnd);
  setTimeout(finish, fallbackMs);
}

function mountPoint() {
  return document.body || document.documentElement;
}

// ---------------------------------------------------------------------------------------------
// Toasts

const TOAST_TYPES = { info: 'info', success: 'check', error: 'alert', warning: 'alert' };
const MAX_TOASTS = 4;
const toastState = new WeakMap();
let toastContainer = null;

function getToastContainer() {
  if (toastContainer && toastContainer.isConnected) return toastContainer;
  toastContainer = h('div', { class: 'toast-container', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  mountPoint().appendChild(toastContainer);
  return toastContainer;
}

/**
 * Shows a small notification. timeout in ms; 0/negative/Infinity = stays until clicked.
 * Errors default to 5000 ms when no timeout is given. An identical visible toast is reused
 * (timer restarted) instead of stacking duplicates.
 * Returns { element, close }.
 */
export function toast(message, { type = 'info', timeout } = {}) {
  const kind = Object.hasOwn(TOAST_TYPES, type) ? type : 'info';
  const text = message instanceof Error ? message.message : String(message ?? '');
  const ms = timeout ?? (kind === 'error' ? 5000 : 2500);
  const sticky = !(Number.isFinite(ms) && ms > 0);
  const container = getToastContainer();

  for (const existing of container.children) {
    const state = toastState.get(existing);
    if (state && !state.closing && state.text === text && state.kind === kind) {
      state.restart(ms);
      existing.classList.remove('toast-bump');
      void existing.offsetWidth; // restart the bump animation
      existing.classList.add('toast-bump');
      return state.api;
    }
  }

  // The container is a polite live region; errors are announced assertively.
  const el = h('div', {
    class: `toast toast-${kind}`,
    role: kind === 'error' ? 'alert' : null,
  },
  h('span', { class: 'toast-icon', html: icon(TOAST_TYPES[kind], { size: 16 }) }),
  h('span', { class: 'toast-message' }, text));

  const state = { text, kind, closing: false, timer: null, ms, api: null, restart: null };

  const close = () => {
    if (state.closing) return;
    state.closing = true;
    clearTimeout(state.timer);
    el.classList.add('leaving');
    removeAfterAnimation(el, 260);
  };
  const schedule = () => {
    clearTimeout(state.timer);
    if (Number.isFinite(state.ms) && state.ms > 0) state.timer = setTimeout(close, state.ms);
  };
  state.restart = (newMs) => {
    state.ms = newMs;
    schedule();
  };
  state.api = { element: el, close };

  if (sticky || kind === 'error') {
    el.appendChild(h('button', {
      type: 'button',
      class: 'toast-close',
      title: t('core.ui.close'),
      'aria-label': t('core.ui.close'),
      html: icon('x', { size: 14 }),
      onClick: (event) => {
        event.stopPropagation();
        close();
      },
    }));
  }
  el.addEventListener('click', close);
  // Pause while the pointer or keyboard focus is on the toast.
  el.addEventListener('mouseenter', () => clearTimeout(state.timer));
  el.addEventListener('mouseleave', () => { if (!state.closing) schedule(); });
  el.addEventListener('focusin', () => clearTimeout(state.timer));
  el.addEventListener('focusout', () => { if (!state.closing) schedule(); });

  toastState.set(el, state);
  container.appendChild(el);

  const open = [...container.children].filter((child) => !toastState.get(child)?.closing);
  for (const old of open.slice(0, Math.max(0, open.length - MAX_TOASTS))) toastState.get(old)?.api.close();

  schedule();
  return state.api;
}

// ---------------------------------------------------------------------------------------------
// Dialogs

const dialogStack = [];
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

function focusableIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden]') && el.getClientRects().length > 0);
}

function safeFocus(el) {
  try {
    el.focus({ preventScroll: true });
  } catch {
    // element vanished or is not focusable
  }
}

/**
 * Shared dialog shell. `field` (optional) is an input/textarea placed below the message.
 * Resolves with getValue() on OK and with cancelValue otherwise.
 */
function openDialog({ title, message, field = null, okText, cancelText, danger = false, getValue, cancelValue, submitOnEnter }) {
  return new Promise((resolve) => {
    const id = uid('dlg-');
    const previouslyFocused = document.activeElement;
    let settled = false;

    const titleEl = title ? h('h2', { class: 'dialog-title', id: `${id}-title` }, title) : null;
    const messageEl = message
      ? h('p', { class: titleEl ? 'dialog-message' : 'dialog-message dialog-message-lone', id: `${id}-msg` }, message)
      : null;
    const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost' }, cancelText);
    const okBtn = h('button', { type: 'button', class: danger ? 'btn btn-danger' : 'btn btn-primary' }, okText);

    const labelledBy = titleEl ? titleEl.id : messageEl ? messageEl.id : null;
    const dialog = h('div', {
      class: danger ? 'dialog dialog-danger' : 'dialog',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': labelledBy,
      'aria-label': labelledBy ? null : t('core.ui.dialog'),
      'aria-describedby': titleEl && messageEl ? messageEl.id : null,
      tabindex: '-1',
    },
    titleEl,
    messageEl || field ? h('div', { class: 'dialog-body' }, messageEl, field) : null,
    h('div', { class: 'dialog-actions' }, cancelBtn, okBtn));

    if (field && !field.hasAttribute('aria-label') && labelledBy) field.setAttribute('aria-labelledby', labelledBy);

    const backdrop = h('div', { class: 'dialog-backdrop' }, dialog);
    const entry = { dialog };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      const index = dialogStack.indexOf(entry);
      if (index >= 0) dialogStack.splice(index, 1);
      backdrop.classList.add('closing');
      removeAfterAnimation(backdrop, 200);
      if (previouslyFocused && previouslyFocused.isConnected && typeof previouslyFocused.focus === 'function') {
        safeFocus(previouslyFocused);
      }
      resolve(result);
    };
    const ok = () => finish(getValue());
    const cancel = () => finish(cancelValue);

    function onKeyDown(event) {
      if (dialogStack[dialogStack.length - 1] !== entry) return;
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      if (event.key === 'Tab') {
        const items = focusableIn(dialog);
        if (!items.length) {
          event.preventDefault();
          safeFocus(dialog);
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        const inside = dialog.contains(active);
        if (event.shiftKey && (!inside || active === first || active === dialog)) {
          event.preventDefault();
          safeFocus(last);
        } else if (!event.shiftKey && (!inside || active === last)) {
          event.preventDefault();
          safeFocus(first);
        }
        return;
      }
      if (event.key === 'Enter' && !event.isComposing && submitOnEnter?.(event)) {
        event.preventDefault();
        event.stopPropagation();
        ok();
      }
    }

    function onFocusIn(event) {
      if (dialogStack[dialogStack.length - 1] !== entry) return;
      if (!dialog.contains(event.target)) safeFocus(field || okBtn);
    }

    // Close on a click that starts and ends on the backdrop (not on text-selection drags).
    let downOnBackdrop = false;
    backdrop.addEventListener('pointerdown', (event) => {
      downOnBackdrop = event.target === backdrop;
    });
    backdrop.addEventListener('click', (event) => {
      if (downOnBackdrop && event.target === backdrop) cancel();
      downOnBackdrop = false;
    });
    okBtn.addEventListener('click', ok);
    cancelBtn.addEventListener('click', cancel);

    dialogStack.push(entry);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    mountPoint().appendChild(backdrop);

    if (field) {
      safeFocus(field);
      if (typeof field.select === 'function' && field.tagName === 'INPUT') field.select();
      else if (typeof field.setSelectionRange === 'function') {
        const end = field.value.length;
        field.setSelectionRange(end, end);
        field.scrollTop = field.scrollHeight;
      }
    } else {
      // Destructive confirmations focus "Abbrechen" so a stray Enter does not delete anything.
      safeFocus(danger ? cancelBtn : okBtn);
    }
  });
}

/** Yes/no dialog. Resolves true (OK) or false (cancel, Escape, backdrop click). */
export function confirmDialog(message, { title, okText = t('core.ui.ok'), cancelText = t('core.ui.cancel'), danger = false } = {}) {
  return openDialog({
    title,
    message: message == null ? '' : String(message),
    okText,
    cancelText,
    danger,
    getValue: () => true,
    cancelValue: false,
    submitOnEnter: null,
  });
}

/**
 * Text input dialog. Resolves with the entered string (untrimmed) or null when cancelled.
 * Single-line: Enter = OK. Multiline: Ctrl/Cmd+Enter = OK, Enter = newline.
 * Extra options: cancelText, message (hint text above the field), maxLength.
 */
export function promptDialog(title, {
  value = '', placeholder = '', okText = t('core.ui.ok'), multiline = false,
  cancelText = t('core.ui.cancel'), message = '', maxLength = null,
} = {}) {
  const field = multiline
    ? h('textarea', { class: 'textarea', rows: 4, placeholder: placeholder || null, maxlength: maxLength || null, spellcheck: 'true' })
    : h('input', { class: 'input', type: 'text', placeholder: placeholder || null, maxlength: maxLength || null, autocomplete: 'off', spellcheck: 'false' });
  field.value = value == null ? '' : String(value);
  if (multiline) autosize(field, 280);

  return openDialog({
    title,
    message,
    field,
    okText,
    cancelText,
    danger: false,
    getValue: () => field.value,
    cancelValue: null,
    submitOnEnter: (event) => {
      if (event.target !== field) return false;
      return multiline ? event.ctrlKey || event.metaKey : !event.shiftKey;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Auto-growing textarea

const autosized = new WeakMap();

/**
 * Makes a textarea grow with its content up to maxPx (then it scrolls).
 * Returns an update function; call it after setting `textarea.value` programmatically.
 * The function has a destroy() method that removes the listeners. Calling autosize() again on the
 * same element only updates maxPx and returns the same function.
 */
export function autosize(textarea, maxPx = 240) {
  if (!textarea) return () => {};
  const existing = autosized.get(textarea);
  if (existing) {
    existing.maxPx = maxPx;
    existing.update();
    return existing.update;
  }

  const state = { maxPx, lastWidth: -1, observer: null };
  const update = () => {
    if (!textarea.isConnected) return;
    const cs = getComputedStyle(textarea);
    const borderY = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    const paddingY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const extra = cs.boxSizing === 'border-box' ? borderY : -paddingY;
    textarea.style.height = 'auto';
    const wanted = textarea.scrollHeight + extra;
    const limit = Number.isFinite(state.maxPx) && state.maxPx > 0 ? state.maxPx : Infinity;
    textarea.style.height = `${Math.min(wanted, limit)}px`;
    textarea.style.overflowY = wanted > limit ? 'auto' : 'hidden';
  };
  state.update = update;

  textarea.addEventListener('input', update);
  if (typeof ResizeObserver === 'function') {
    // Re-measure when the width changes (line wrapping); ignore our own height changes.
    state.observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - state.lastWidth) > 0.5) {
        state.lastWidth = width;
        // Deferred so the height change does not happen inside the observer callback.
        requestAnimationFrame(update);
      }
    });
    state.observer.observe(textarea);
  }
  update.destroy = () => {
    textarea.removeEventListener('input', update);
    state.observer?.disconnect();
    autosized.delete(textarea);
  };

  autosized.set(textarea, state);
  update();
  // Elements created detached get measured once they are in the document.
  if (!textarea.isConnected) requestAnimationFrame(update);
  return update;
}
