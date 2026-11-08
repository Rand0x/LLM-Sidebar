// Floating popups for the side panel: action menus and a searchable, grouped picker.
// Only one popup is open at a time; it closes on outside click, Escape, resize and blur.
import { h } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { clamp, uid } from '../lib/utils.js';
import { t } from '../lib/i18n.js';

let current = null; // { el, anchor, close }

export function isPopupOpen() {
  return Boolean(current);
}

export function closePopup({ restoreFocus = false } = {}) {
  current?.close({ restoreFocus });
}

export function isPopupFor(anchor) {
  return Boolean(current && current.anchor === anchor);
}

function place(el, anchor, placement) {
  const margin = 8;
  const gap = 6;
  const rect = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  el.style.position = 'fixed';
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.maxWidth = `${Math.max(160, vw - margin * 2)}px`;

  const spaceBelow = vh - rect.bottom - gap - margin;
  const spaceAbove = rect.top - gap - margin;
  const natural = el.scrollHeight;
  const preferTop = placement.startsWith('top');
  const up = preferTop ? (spaceAbove >= Math.min(natural, 200) || spaceAbove > spaceBelow)
    : (spaceBelow < Math.min(natural, 200) && spaceAbove > spaceBelow);
  const available = Math.max(120, up ? spaceAbove : spaceBelow);
  el.style.maxHeight = `${available}px`;

  const width = el.offsetWidth;
  const height = Math.min(el.offsetHeight, available);
  let left = placement.endsWith('end') ? rect.right - width : rect.left;
  left = clamp(left, margin, Math.max(margin, vw - width - margin));
  const top = up ? Math.max(margin, rect.top - gap - height) : rect.bottom + gap;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.dataset.side = up ? 'top' : 'bottom';
}

/**
 * Shows `el` anchored to `anchor`. Clicking the same anchor again toggles it closed.
 * Returns the close function (or null when this call only closed the open popup).
 */
export function openPopup(anchor, el, { placement = 'bottom-start', onClose, initialFocus } = {}) {
  if (current) {
    const same = current.anchor === anchor;
    current.close({ restoreFocus: false });
    if (same) return null;
  }

  let closed = false;
  const onPointerDown = (event) => {
    if (el.contains(event.target) || anchor.contains(event.target)) return;
    close({ restoreFocus: false });
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
    } else if (event.key === 'Tab' && el.contains(document.activeElement)) {
      close({ restoreFocus: false });
    }
  };
  const onViewport = () => close({ restoreFocus: false });
  // Only scrolling that moves the anchor closes the popup – not e.g. the message list
  // following a streamed answer.
  const onScroll = (event) => {
    const target = event.target;
    if (el.contains(target)) return;
    if (typeof target?.contains === 'function' && target.contains(anchor)) close({ restoreFocus: false });
  };

  function close({ restoreFocus = false } = {}) {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onViewport);
    window.removeEventListener('blur', onViewport);
    document.removeEventListener('scroll', onScroll, true);
    anchor.setAttribute('aria-expanded', 'false');
    el.remove();
    if (current?.el === el) current = null;
    if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
    onClose?.();
  }

  el.classList.add('popup');
  document.body.appendChild(el);
  place(el, anchor, placement);
  anchor.setAttribute('aria-expanded', 'true');
  current = { el, anchor, close };

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onViewport);
  window.addEventListener('blur', onViewport);
  document.addEventListener('scroll', onScroll, true);

  const focusTarget = typeof initialFocus === 'function' ? initialFocus() : initialFocus;
  if (focusTarget) focusTarget.focus({ preventScroll: true });
  return close;
}

function moveFocus(items, delta) {
  if (!items.length) return;
  const index = items.indexOf(document.activeElement);
  const next = index === -1 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length;
  items[next].focus({ preventScroll: false });
}

/**
 * Action menu. items: [{ label, icon, hint, danger, disabled, checked, onSelect } | { separator: true } | { heading }]
 */
export function openMenu(anchor, items, { placement = 'bottom-end', label = t('sidepanel.popup.menu') } = {}) {
  const buttons = [];
  const menu = h('div', { class: 'menu sp-menu', role: 'menu', 'aria-label': label });
  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      menu.appendChild(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if (item.heading) {
      menu.appendChild(h('div', { class: 'menu-label', role: 'presentation' }, item.heading));
      continue;
    }
    const btn = h('button', {
      type: 'button',
      class: ['menu-item', item.danger && 'danger'],
      role: item.checked === undefined ? 'menuitem' : 'menuitemcheckbox',
      'aria-checked': item.checked === undefined ? null : String(Boolean(item.checked)),
      disabled: Boolean(item.disabled),
      title: item.title || null,
      html: item.icon ? icon(item.icon, { size: 16 }) : '',
      onClick: () => {
        closePopup({ restoreFocus: true });
        item.onSelect?.();
      },
    }, h('span', { class: 'menu-text' }, item.label), item.hint ? h('span', { class: 'menu-hint' }, item.hint) : null);
    buttons.push(btn);
    menu.appendChild(btn);
  }
  menu.addEventListener('keydown', (event) => {
    const enabled = buttons.filter((b) => !b.disabled);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(enabled, 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(enabled, -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      enabled[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      enabled[enabled.length - 1]?.focus();
    }
  });
  return openPopup(anchor, menu, {
    placement,
    initialFocus: () => buttons.find((b) => !b.disabled) || null,
  });
}

function matches(item, tokens) {
  if (!tokens.length) return true;
  const hay = `${item.label} ${item.group || ''} ${item.sublabel || ''} ${item.keywords || ''}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/**
 * Searchable picker grouped by `item.group`.
 * items: [{ key, label, group?, sublabel?, keywords?, dot?, badges?: [{ icon, title }] }]
 * footer: [{ label, icon, onSelect }]
 */
export function openPicker(anchor, {
  items = [], selectedKey = null, onSelect, title = t('sidepanel.popup.picker'), searchable = items.length > 6,
  searchPlaceholder = t('sidepanel.popup.search'), emptyText = t('sidepanel.popup.noMatches'), footer = [], placement = 'bottom-start', wide = false,
} = {}) {
  const listId = uid('pk-');
  const root = h('div', { class: ['menu', 'picker', wide && 'picker-wide'], role: 'dialog', 'aria-label': title });
  const search = searchable ? h('input', {
    type: 'search',
    class: 'input input-sm picker-search',
    placeholder: searchPlaceholder,
    'aria-label': searchPlaceholder,
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': listId,
    'aria-autocomplete': 'list',
    autocomplete: 'off',
    spellcheck: 'false',
  }) : null;
  const list = h('div', { class: 'picker-list', id: listId, role: 'listbox', 'aria-label': title, tabindex: searchable ? '-1' : '0' });
  if (search) root.appendChild(h('div', { class: 'picker-search-wrap' }, h('span', { class: 'picker-search-icon', html: icon('search', { size: 14 }) }), search));
  root.appendChild(list);

  if (footer.length) {
    root.appendChild(h('div', { class: 'menu-sep' }));
    const foot = h('div', { class: 'picker-footer' });
    for (const f of footer) {
      foot.appendChild(h('button', {
        type: 'button',
        class: 'menu-item',
        html: f.icon ? icon(f.icon, { size: 16 }) : '',
        onClick: () => {
          closePopup({ restoreFocus: false });
          f.onSelect?.();
        },
      }, h('span', { class: 'menu-text' }, f.label)));
    }
    root.appendChild(foot);
  }

  let visible = [];
  let active = -1;

  function setActive(index, { scroll = true } = {}) {
    visible.forEach((v) => v.el.classList.remove('active'));
    active = visible.length ? clamp(index, 0, visible.length - 1) : -1;
    const entry = visible[active];
    if (!entry) {
      (search || list).removeAttribute('aria-activedescendant');
      return;
    }
    entry.el.classList.add('active');
    (search || list).setAttribute('aria-activedescendant', entry.el.id);
    if (scroll) entry.el.scrollIntoView({ block: 'nearest' });
  }

  function choose(item) {
    closePopup({ restoreFocus: true });
    onSelect?.(item);
  }

  function render() {
    const tokens = (search?.value || '').toLowerCase().split(/\s+/).filter(Boolean);
    list.textContent = '';
    visible = [];
    let lastGroup = null;
    for (const item of items) {
      if (!matches(item, tokens)) continue;
      if (item.group && item.group !== lastGroup) {
        lastGroup = item.group;
        list.appendChild(h('div', { class: 'menu-label picker-group', role: 'presentation' }, item.group));
      }
      const selected = item.key === selectedKey;
      const el = h('div', {
        class: ['menu-item', 'picker-item', selected && 'selected'],
        role: 'option',
        id: uid('pko-'),
        'aria-selected': String(selected),
        title: item.title || item.label,
      },
      item.dot ? h('span', { class: 'picker-dot', style: { background: item.dot }, 'aria-hidden': 'true' }) : null,
      h('span', { class: 'picker-text' },
        h('span', { class: 'picker-label' }, item.label),
        item.sublabel ? h('span', { class: 'picker-sub' }, item.sublabel) : null),
      ...(item.badges || []).map((b) => h('span', { class: 'picker-badge', title: b.title, 'aria-label': b.title, html: icon(b.icon, { size: 13 }) })),
      h('span', { class: 'picker-check', html: selected ? icon('check', { size: 15 }) : '' }));
      const index = visible.length;
      el.addEventListener('pointermove', () => {
        if (active !== index) setActive(index, { scroll: false });
      });
      el.addEventListener('click', () => choose(item));
      visible.push({ item, el });
      list.appendChild(el);
    }
    if (!visible.length) list.appendChild(h('div', { class: 'picker-empty' }, emptyText));
    const selectedIndex = visible.findIndex((v) => v.item.key === selectedKey);
    setActive(tokens.length ? 0 : Math.max(0, selectedIndex));
  }

  function onKey(event) {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(active + 1 >= visible.length ? 0 : active + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(active - 1 < 0 ? visible.length - 1 : active - 1);
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      setActive(active + 8);
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      setActive(active - 8);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (visible[active]) choose(visible[active].item);
    } else if (!search && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : visible.length - 1);
    }
  }

  (search || list).addEventListener('keydown', onKey);
  search?.addEventListener('input', () => render());
  render();

  const close = openPopup(anchor, root, { placement, initialFocus: () => search || list });
  // Re-centre the selected entry once the popup has its final size.
  if (close && visible[active]) visible[active].el.scrollIntoView({ block: 'nearest' });
  return close;
}
