// Shared DOM helpers for the options page: fields, buttons, dialogs and focus-preserving re-renders.

import { h, autosize } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { uid, clamp } from '../lib/utils.js';
import { t, getLocale, formatNumber as formatLocaleNumber } from '../lib/i18n.js';

export const TEXTAREA_MAX = 360;

const TEXT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password', 'email', 'number', '']);

function isTextField(el) {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_TYPES.has(el.type);
}

/**
 * Runs `fn` (which replaces DOM) and restores focus, caret, the typed value and the on-screen
 * position of the focused control afterwards. Controls are matched by their `data-key`.
 */
export function preserveFocus(fn, { within = null } = {}) {
  const active = document.activeElement;
  let state = null;
  if (active && active !== document.body && active.dataset?.key && (!within || within.contains(active))) {
    state = { key: active.dataset.key, top: active.getBoundingClientRect().top };
    if (isTextField(active)) {
      state.value = active.value;
      state.scrollTop = active.scrollTop;
      try {
        state.start = active.selectionStart;
        state.end = active.selectionEnd;
        state.dir = active.selectionDirection;
      } catch {
        // number inputs have no selection API
      }
    }
  }
  fn();
  if (!state) return;
  const el = document.querySelector(`[data-key="${CSS.escape(state.key)}"]`);
  if (!el || el.disabled) return;
  if (state.value !== undefined && isTextField(el) && el.value !== state.value) {
    el.value = state.value;
    if (el.tagName === 'TEXTAREA' && el.dataset.autosize) autosize(el, Number(el.dataset.autosize) || TEXTAREA_MAX);
  }
  try {
    el.focus({ preventScroll: true });
  } catch {
    return;
  }
  if (state.start != null) {
    try {
      el.setSelectionRange(state.start, state.end, state.dir || 'none');
    } catch {
      // ignore
    }
  }
  if (state.scrollTop) el.scrollTop = state.scrollTop;
  const delta = el.getBoundingClientRect().top - state.top;
  if (Math.abs(delta) > 1) window.scrollBy(0, delta);
}

/** Focuses the control with the given data-key (after a re-render). */
export function focusKey(key, { select = false } = {}) {
  const el = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!el || el.disabled) return false;
  el.focus({ preventScroll: true });
  if (select && typeof el.select === 'function') el.select();
  el.scrollIntoView({ block: 'nearest' });
  return true;
}

export function iconHtml(name, size = 16) {
  return icon(name, { size });
}

/**
 * Button helper. variant: 'primary' | 'ghost' | 'danger' | ''; size: 'sm' | ''.
 * iconOnly buttons use `label` as title + aria-label.
 */
export function button(label, {
  icon: iconName = null, variant = '', size = '', iconOnly = false, className = '', title = null, ...attrs
} = {}) {
  const cls = [iconOnly ? 'btn-icon' : 'btn', variant && `btn-${variant}`, size && `btn-${size}`, className];
  return h('button', {
    type: 'button',
    class: cls,
    title: title ?? (iconOnly ? label : null),
    'aria-label': iconOnly ? label : null,
    html: iconName ? icon(iconName, { size: size === 'sm' ? 14 : 16 }) : null,
    ...attrs,
  }, iconOnly ? null : label);
}

/**
 * Marks a button as busy: spinner + label, aria-disabled (not `disabled`, so keyboard focus stays).
 * Click handlers must check their own busy state.
 */
export function setBusy(btn, busy, label = null) {
  if (!btn) return;
  if (busy) {
    btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('aria-busy', 'true');
    if (label) btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), label);
  } else {
    btn.removeAttribute('aria-disabled');
    btn.removeAttribute('aria-busy');
  }
}

export function externalLink(href, label, { className = '' } = {}) {
  return h('a', {
    class: ['ext-link', className],
    href,
    target: '_blank',
    rel: 'noopener noreferrer',
  }, label, h('span', { class: 'ext-icon', html: icon('external', { size: 13 }) }), h('span', { class: 'sr-only' }, ` ${t('options.dom.opensInNewTab')}`));
}

export function callout(type, iconName, title, ...body) {
  return h('div', { class: ['callout', `callout-${type}`] },
    h('span', { class: 'callout-icon', html: icon(iconName, { size: 18 }) }),
    h('div', { class: 'callout-body' },
      title ? h('p', { class: 'callout-title' }, title) : null,
      ...body));
}

export function group({ title, description = null, actions = null, id = null }, ...children) {
  const headingId = id || uid('grp-');
  return h('section', { class: 'group', 'aria-labelledby': headingId },
    h('div', { class: 'group-head' },
      h('div', { class: 'group-head-text' },
        h('h2', { class: 'group-title', id: headingId }, title),
        description ? h('p', { class: 'group-desc' }, description) : null),
      actions ? h('div', { class: 'group-actions' }, actions) : null),
    ...children);
}

export function panel(...children) {
  return h('div', { class: 'panel' }, ...children);
}

/**
 * Labelled settings row: text (label + hint) left, control right; `stacked` puts the control below.
 * `control` must carry the id `controlId` so the <label> points at it.
 */
export function field({ label, hint = null, control, controlId, stacked = false, className = '', extra = null }) {
  const hintId = hint ? `${controlId}-hint` : null;
  const labelId = `${controlId}-label`;
  let target = null;
  if (control instanceof Element) {
    target = control.id === controlId ? control : control.querySelector(`#${CSS.escape(controlId)}`);
  }
  const labelable = Boolean(target?.matches?.('input, select, textarea'));
  if (target) {
    if (hintId) {
      const existing = target.getAttribute('aria-describedby');
      target.setAttribute('aria-describedby', existing ? `${hintId} ${existing}` : hintId);
    }
    // Button groups etc. are labelled as a group instead of via <label for>.
    if (!labelable) {
      target.setAttribute('role', target.getAttribute('role') || 'group');
      target.setAttribute('aria-labelledby', labelId);
    }
  }
  return h('div', { class: ['field', stacked && 'stacked', className] },
    h('div', { class: 'field-text' },
      labelable
        ? h('label', { class: 'field-label', htmlFor: controlId, id: labelId }, label)
        : h('div', { class: 'field-label', id: labelId }, label),
      hint ? h('div', { class: 'field-hint', id: hintId }, hint) : null),
    h('div', { class: 'field-control' }, control, extra));
}

/** Settings row with a switch on the right. */
export function switchField({ label, hint = null, checked, key, onChange, disabled = false }) {
  const id = uid('sw-');
  const hintId = hint ? `${id}-hint` : null;
  const input = h('input', {
    type: 'checkbox',
    role: 'switch',
    id,
    checked: Boolean(checked),
    disabled,
    dataset: { key },
    'aria-describedby': hintId,
    onChange: (event) => onChange(event.target.checked),
  });
  return h('div', { class: 'field field-switch' },
    h('div', { class: 'field-text' },
      h('label', { class: 'field-label', htmlFor: id }, label),
      hint ? h('div', { class: 'field-hint', id: hintId }, hint) : null),
    h('div', { class: 'field-control' },
      h('label', { class: 'switch', title: label }, input, h('span', { 'aria-hidden': 'true' }))));
}

/** Small inline switch with a text label (e.g. "Toolbar"). */
export function inlineSwitch({ label, checked, key, onChange, title = null }) {
  return h('label', { class: 'switch switch-inline', title: title || label },
    h('input', {
      type: 'checkbox',
      role: 'switch',
      checked: Boolean(checked),
      dataset: { key },
      onChange: (event) => onChange(event.target.checked),
    }),
    h('span', { 'aria-hidden': 'true' }),
    h('span', { class: 'switch-text' }, label));
}

/** Auto-growing textarea. onInput(value) fires on every change. */
export function textArea({ id, key, value = '', rows = 3, placeholder = null, onInput, max = TEXTAREA_MAX, className = '', ...attrs }) {
  const ta = h('textarea', {
    class: ['textarea', className],
    id,
    rows,
    placeholder,
    dataset: { key, autosize: max },
    ...attrs,
  });
  ta.value = value ?? '';
  if (onInput) ta.addEventListener('input', () => onInput(ta.value));
  autosize(ta, max);
  return ta;
}

/** Inserts `text` at the caret of an input/textarea and fires an input event. */
export function insertAtCaret(el, text) {
  el.focus();
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  el.setRangeText(text, start, end, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Decimal separator of the UI language ("," for German, "." for English …). */
function decimalSeparator() {
  try {
    return new Intl.NumberFormat(getLocale()).formatToParts(1.5).find((p) => p.type === 'decimal')?.value || '.';
  } catch {
    return '.';
  }
}

function formatNumber(value, decimal) {
  if (value == null || value === '') return '';
  return decimal ? String(value).replace('.', decimalSeparator()) : String(value);
}

/**
 * Validated number input. Values out of range are flagged while typing and clamped on blur.
 * allowEmpty: empty input = null ("Standard"). decimal: text input accepting "0,7" and "0.7" (shown with
 * the decimal separator of the UI language).
 * onValue(numberOrNull) is called for every valid value. Returns { el, input }.
 */
export function numberInput({
  id, key, value, min, max, step = 1, integer = true, allowEmpty = false, decimal = false,
  placeholder = '', unit = '', onValue, setInvalid,
}) {
  const errId = `${id}-err`;
  const input = h('input', {
    class: 'input input-num',
    id,
    type: decimal ? 'text' : 'number',
    inputmode: decimal ? 'decimal' : 'numeric',
    min: decimal ? null : min,
    max: decimal ? null : max,
    step: decimal ? null : step,
    placeholder: placeholder || null,
    autocomplete: 'off',
    dataset: { key },
    'aria-errormessage': errId,
  });
  input.value = formatNumber(value, decimal);
  const error = h('div', { class: 'field-error', id: errId, hidden: true });
  let lastValid = value ?? null;

  const range = t('options.number.range', { min: formatLocaleNumber(min), max: formatLocaleNumber(max) });

  function parse() {
    if (input.validity?.badInput) return { ok: false, msg: t('options.number.invalid') };
    const raw = input.value.trim().replace(',', '.');
    if (!raw) return allowEmpty ? { ok: true, value: null } : { ok: false, msg: t('options.number.enterRange', { range }), empty: true };
    if (!/^[+-]?(\d+([.]\d*)?|[.]\d+)$/.test(raw)) return { ok: false, msg: t('options.number.invalid') };
    let n = Number(raw);
    if (integer && !Number.isInteger(n)) n = Math.round(n);
    if (n < min || n > max) return { ok: false, msg: t('options.number.allowedRange', { range }), clamp: clamp(n, min, max) };
    return { ok: true, value: n };
  }

  function showError(msg) {
    error.hidden = !msg;
    error.textContent = msg || '';
    if (msg) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    setInvalid?.(key, Boolean(msg));
  }

  input.addEventListener('input', () => {
    const result = parse();
    if (result.ok) {
      showError('');
      lastValid = result.value;
      onValue(result.value);
    } else {
      showError(result.msg);
    }
  });
  input.addEventListener('blur', () => {
    const result = parse();
    if (result.ok) {
      input.value = formatNumber(result.value, decimal);
      return;
    }
    if (result.clamp !== undefined) {
      lastValid = result.clamp;
      onValue(result.clamp);
    }
    input.value = formatNumber(lastValid, decimal);
    showError('');
  });

  const wrap = h('div', { class: 'num-wrap' }, input, unit ? h('span', { class: 'num-unit' }, unit) : null);
  return { el: h('div', { class: 'num-field' }, wrap, error), input };
}

// ------------------------------------------------------------------------------------------------
// Form dialog (several fields). Uses the .dialog styles from theme.css.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Opens a modal dialog with arbitrary `content`. onSubmit() may return an error string to keep
 * the dialog open (shown inline), or anything else to close it. canSubmit() toggles the OK button.
 * Resolves true (submitted) or false (cancelled).
 */
export function formDialog({
  title, message = '', content = null, okText = t('options.dialog.ok'), cancelText = t('options.dialog.cancel'), danger = false,
  initialFocus = null, onSubmit = null, canSubmit = null, wide = false,
}) {
  return new Promise((resolve) => {
    const id = uid('fdlg-');
    const previouslyFocused = document.activeElement;
    const errorEl = h('p', { class: 'dialog-error', role: 'alert', hidden: true });
    const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost' }, cancelText);
    const okBtn = h('button', { type: 'button', class: danger ? 'btn btn-danger' : 'btn btn-primary' }, okText);
    const dialog = h('div', {
      class: ['dialog', 'dialog-form', wide && 'dialog-wide', danger && 'dialog-danger'],
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': `${id}-title`,
      'aria-describedby': message ? `${id}-msg` : null,
      tabindex: '-1',
    },
    h('h2', { class: 'dialog-title', id: `${id}-title` }, title),
    h('div', { class: 'dialog-body' },
      message ? h('p', { class: 'dialog-message', id: `${id}-msg` }, message) : null,
      content,
      errorEl),
    h('div', { class: 'dialog-actions' }, cancelBtn, okBtn));
    const backdrop = h('div', { class: 'dialog-backdrop' }, dialog);
    let settled = false;
    let submitting = false;

    const isTop = () => {
      const open = [...document.querySelectorAll('.dialog-backdrop:not(.closing)')];
      return open[open.length - 1] === backdrop;
    };
    const updateOk = () => {
      okBtn.disabled = submitting || (canSubmit ? !canSubmit() : false);
    };
    const close = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      backdrop.classList.add('closing');
      setTimeout(() => backdrop.remove(), 200);
      if (previouslyFocused && previouslyFocused.isConnected && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus({ preventScroll: true });
      }
      resolve(result);
    };
    const submit = async () => {
      if (submitting || okBtn.disabled) return;
      submitting = true;
      updateOk();
      let outcome;
      try {
        outcome = onSubmit ? await onSubmit() : true;
      } catch (err) {
        outcome = err?.message || t('options.dialog.unknownError');
      }
      submitting = false;
      if (typeof outcome === 'string' && outcome) {
        errorEl.textContent = outcome;
        errorEl.hidden = false;
        updateOk();
        return;
      }
      close(true);
    };

    function onKeyDown(event) {
      if (!isTop()) return;
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        close(false);
        return;
      }
      if (event.key === 'Tab') {
        const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const activeEl = document.activeElement;
        if (event.shiftKey && (activeEl === first || !dialog.contains(activeEl) || activeEl === dialog)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (activeEl === last || !dialog.contains(activeEl))) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key === 'Enter' && !event.isComposing) {
        const target = event.target;
        if (target instanceof HTMLInputElement && TEXT_TYPES.has(target.type) && dialog.contains(target)) {
          event.preventDefault();
          submit();
        }
      }
    }
    function onFocusIn(event) {
      if (!isTop()) return;
      if (!dialog.contains(event.target)) (initialFocus || okBtn).focus();
    }

    let downOnBackdrop = false;
    backdrop.addEventListener('pointerdown', (event) => {
      downOnBackdrop = event.target === backdrop;
    });
    backdrop.addEventListener('click', (event) => {
      if (downOnBackdrop && event.target === backdrop) close(false);
      downOnBackdrop = false;
    });
    dialog.addEventListener('input', () => {
      errorEl.hidden = true;
      updateOk();
    });
    dialog.addEventListener('change', updateOk);
    okBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', () => close(false));

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.body.appendChild(backdrop);
    updateOk();
    const focusTarget = initialFocus || (danger ? cancelBtn : okBtn);
    focusTarget.focus({ preventScroll: true });
  });
}

/** Labelled control inside a dialog form. */
export function dialogField({ label, control, id, hint = null }) {
  const hintId = hint ? `${id}-hint` : null;
  if (hintId) control.setAttribute('aria-describedby', hintId);
  return h('div', { class: 'dialog-field' },
    h('label', { class: 'label', htmlFor: id }, label),
    control,
    hint ? h('div', { class: 'hint', id: hintId }, hint) : null);
}

/** Today as YYYY-MM-DD (local time) for export file names. */
export function dateStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Reads a File as text. */
export function readFileText(file) {
  if (typeof file?.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error(t('options.file.readError')));
    reader.readAsText(file);
  });
}

/**
 * Hidden file input + trigger: returns { input, open() }. onFile(file) runs after the user picked a
 * file; the input is reset afterwards so the same file can be chosen again.
 */
export function filePicker({ accept = 'application/json,.json', key, onFile }) {
  const input = h('input', {
    type: 'file',
    accept,
    class: 'file-input',
    tabindex: '-1',
    'aria-hidden': 'true',
    dataset: { file: key },
  });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      await onFile(file);
    } finally {
      input.value = '';
    }
  });
  return { input, open: () => input.click() };
}
