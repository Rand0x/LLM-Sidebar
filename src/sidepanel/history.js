// History drawer: search (titles + message text), date groups, pin / rename / delete,
// export all chats as JSON and delete all.
import { h, toast, confirmDialog, promptDialog } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { listChats, getChat, saveChat, deleteChat, clearChats, exportChats, serializeChatsExport } from '../lib/db.js';
import { debounce, downloadFile } from '../lib/utils.js';
import { t } from '../lib/i18n.js';
import { dateGroup, relativeDay } from './format.js';

// Group ids (labels: sidepanel.history.group.<id>).
const GROUP_ORDER = ['pinned', 'today', 'yesterday', 'week', 'older'];
const CLOSE_MS = 200;

function snippetFor(chat, query) {
  for (const msg of chat.messages || []) {
    const text = String(msg.content || '');
    const index = text.toLowerCase().indexOf(query);
    if (index === -1) continue;
    const start = Math.max(0, index - 28);
    const end = Math.min(text.length, index + query.length + 60);
    return {
      before: `${start > 0 ? '…' : ''}${text.slice(start, index)}`.replace(/\s+/g, ' '),
      match: text.slice(index, index + query.length),
      after: `${text.slice(index + query.length, end)}${end < text.length ? '…' : ''}`.replace(/\s+/g, ' '),
    };
  }
  return null;
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * opts: { drawer, backdrop, toggleBtn, inertRoot, getCurrentChat() → { chat, saved },
 *         onOpenChat(chat), onCurrentChanged(chat), onCurrentDeleted(), onAllDeleted() }
 * onCurrentDeleted / onAllDeleted run before the delete. The list reloads itself after
 * writes through the panel's lib/db change events (refresh()).
 */
export function createHistory(opts) {
  const { drawer, backdrop, toggleBtn, inertRoot } = opts;
  let chats = [];
  let open = false;
  let closeTimer = 0;
  let loading = false;
  let loadPromise = null;
  let reloadWanted = false;

  const search = h('input', {
    type: 'search',
    class: 'input input-sm',
    placeholder: t('sidepanel.history.search'),
    'aria-label': t('sidepanel.history.searchLabel'),
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const listEl = h('div', { class: 'history-list', role: 'list', 'aria-label': t('sidepanel.history.list') });
  const countEl = h('span', { class: 'history-count' });
  const exportBtn = h('button', {
    type: 'button',
    class: 'btn btn-sm btn-ghost',
    title: t('sidepanel.history.exportHint'),
    html: icon('download', { size: 14 }),
    onClick: exportAll,
  }, t('sidepanel.history.export'));
  const clearBtn = h('button', {
    type: 'button',
    class: 'btn btn-sm btn-ghost danger-text',
    title: t('sidepanel.history.deleteAllHint'),
    html: icon('trash', { size: 14 }),
    onClick: deleteAll,
  }, t('sidepanel.history.deleteAll'));

  drawer.append(
    h('div', { class: 'drawer-head' },
      h('h2', { class: 'drawer-title', id: 'history-title' }, t('sidepanel.history.title')),
      countEl,
      h('span', { class: 'spacer' }),
      h('button', {
        type: 'button',
        class: 'btn-icon btn-sm',
        title: t('sidepanel.history.closeHint'),
        'aria-label': t('sidepanel.history.close'),
        html: icon('x', { size: 16 }),
        onClick: () => close(),
      })),
    h('div', { class: 'drawer-search' }, h('span', { class: 'drawer-search-icon', html: icon('search', { size: 14 }) }), search),
    listEl,
    h('div', { class: 'drawer-foot' }, exportBtn, h('span', { class: 'spacer' }), clearBtn));
  drawer.setAttribute('aria-labelledby', 'history-title');

  search.addEventListener('input', debounce(() => render(), 120));
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      listEl.querySelector('.history-open')?.focus();
    }
  });
  listEl.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const items = [...listEl.querySelectorAll('.history-open')];
    const index = items.indexOf(document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    const next = items[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) next.focus();
    else if (event.key === 'ArrowUp') search.focus();
  });
  backdrop.addEventListener('click', () => close());
  drawer.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      if (search.value && document.activeElement === search) {
        search.value = '';
        render();
      } else {
        close();
      }
    }
  });

  async function fetchChats() {
    loading = true;
    try {
      chats = await listChats();
    } catch (err) {
      chats = [];
      toast(err?.message || t('sidepanel.history.loadFailed'), { type: 'error' });
    } finally {
      loading = false;
    }
    // The open chat in memory may be ahead of its stored copy (e.g. while streaming).
    const { chat: current, saved } = opts.getCurrentChat();
    if (current && saved) {
      const index = chats.findIndex((c) => c.id === current.id);
      if (index >= 0 && !(Number(chats[index].updatedAt) > Number(current.updatedAt))) chats[index] = current;
    }
    render();
  }

  // Coalesces bursts of change events into at most one extra reload.
  function load() {
    if (loadPromise) {
      reloadWanted = true;
      return loadPromise;
    }
    loadPromise = (async () => {
      do {
        reloadWanted = false;
        await fetchChats();
      } while (reloadWanted && open);
    })().finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  }

  function itemFor(chat, query, currentId) {
    const snippet = query ? snippetFor(chat, query) : null;
    const count = chat.messages?.length || 0;
    const openBtn = h('button', {
      type: 'button',
      class: 'history-open',
      title: chat.title,
      'aria-current': chat.id === currentId ? 'true' : null,
      onClick: () => select(chat),
    },
    h('span', { class: 'history-title' },
      chat.pinned ? h('span', { class: 'history-pin', html: icon('pin', { size: 12 }), title: t('sidepanel.history.group.pinned') }) : null,
      h('span', { class: 'truncate' }, chat.title || t('sidepanel.chat.defaultTitle'))),
    snippet
      ? h('span', { class: 'history-snippet' }, snippet.before, h('mark', {}, snippet.match), snippet.after)
      : h('span', { class: 'history-meta' }, `${relativeDay(chat.updatedAt)} · ${t('sidepanel.history.messages', { count })}`));

    const action = (name, iconName, label, fn, extra = {}) => h('button', {
      type: 'button',
      class: ['btn-icon', 'btn-sm', 'history-action', name === 'delete' && 'danger-text'],
      title: label,
      'aria-label': `${label}: ${chat.title}`,
      html: icon(iconName, { size: 14 }),
      onClick: (event) => {
        event.stopPropagation();
        fn();
      },
      ...extra,
    });

    return h('div', { class: ['history-item', chat.id === currentId && 'active'], role: 'listitem' },
      openBtn,
      h('div', { class: 'history-actions' },
        action('pin', 'pin', t(chat.pinned ? 'sidepanel.history.unpin' : 'sidepanel.history.pin'), () => togglePin(chat), { 'aria-pressed': String(Boolean(chat.pinned)) }),
        action('rename', 'edit', t('sidepanel.history.rename'), () => rename(chat)),
        action('delete', 'trash', t('sidepanel.history.delete'), () => remove(chat))));
  }

  function render() {
    const query = search.value.trim().toLowerCase();
    const { chat: current } = opts.getCurrentChat();
    const currentId = current?.id;
    const filtered = query
      ? chats.filter((c) => String(c.title || '').toLowerCase().includes(query)
        || (c.messages || []).some((m) => String(m.content || '').toLowerCase().includes(query)))
      : chats;

    countEl.textContent = chats.length ? String(chats.length) : '';
    exportBtn.disabled = !chats.length;
    clearBtn.disabled = !chats.length;
    listEl.textContent = '';

    if (!filtered.length) {
      listEl.appendChild(h('div', { class: 'history-empty' },
        h('span', { html: icon(query ? 'search' : 'history', { size: 22 }) }),
        h('p', {}, t(loading ? 'sidepanel.history.loading' : query ? 'sidepanel.history.noResults' : 'sidepanel.history.empty')),
        !query && !loading ? h('p', { class: 'faint' }, t('sidepanel.history.emptyHint')) : null));
      return;
    }

    const groups = new Map();
    for (const chat of filtered) {
      const group = chat.pinned ? 'pinned' : dateGroup(chat.updatedAt);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(chat);
    }
    for (const group of GROUP_ORDER) {
      const items = groups.get(group);
      if (!items?.length) continue;
      listEl.appendChild(h('div', { class: 'history-group', role: 'presentation' }, t(`sidepanel.history.group.${group}`)));
      for (const chat of items) listEl.appendChild(itemFor(chat, query, currentId));
    }
  }

  function select(chat) {
    close({ restoreFocus: false });
    opts.onOpenChat(chat.id);
  }

  async function freshCopy(chat) {
    const { chat: current, saved } = opts.getCurrentChat();
    if (current && saved && current.id === chat.id) return { record: current, isCurrent: true };
    const stored = await getChat(chat.id);
    return { record: stored || chat, isCurrent: false };
  }

  async function togglePin(chat) {
    try {
      const { record, isCurrent } = await freshCopy(chat);
      record.pinned = !record.pinned;
      await saveChat(record, { keepTime: true });
      if (isCurrent) opts.onCurrentChanged(record);
      toast(t(record.pinned ? 'sidepanel.history.pinnedToast' : 'sidepanel.history.unpinnedToast'), { type: 'success' });
    } catch (err) {
      toast(err?.message || t('sidepanel.errors.saveChatPlain'), { type: 'error' });
    }
  }

  async function rename(chat) {
    const value = await promptDialog(t('sidepanel.rename.title'), {
      value: chat.title, okText: t('sidepanel.rename.save'), maxLength: 120, placeholder: t('sidepanel.rename.placeholder'),
    });
    const title = value?.trim();
    if (!title || title === chat.title) return;
    try {
      const { record, isCurrent } = await freshCopy(chat);
      record.title = title;
      record.titleEdited = true;
      await saveChat(record, { keepTime: true });
      if (isCurrent) opts.onCurrentChanged(record);
    } catch (err) {
      toast(err?.message || t('sidepanel.history.renameFailed'), { type: 'error' });
    }
  }

  async function remove(chat) {
    const ok = await confirmDialog(t('sidepanel.delete.confirm', { title: chat.title }), {
      title: t('sidepanel.delete.title'), okText: t('sidepanel.delete.ok'), danger: true,
    });
    if (!ok) return;
    try {
      // Let the panel drop the open chat first, so a settling request cannot save it again.
      const { chat: current } = opts.getCurrentChat();
      if (current?.id === chat.id) opts.onCurrentDeleted();
      await deleteChat(chat.id);
      toast(t('sidepanel.delete.done'), { type: 'success' });
    } catch (err) {
      toast(err?.message || t('sidepanel.errors.deleteChat'), { type: 'error' });
    }
  }

  async function exportAll() {
    try {
      const all = await exportChats();
      if (!all.length) {
        toast(t('sidepanel.history.nothingToExport'));
        return;
      }
      // Same file format as Options → Daten (importable there).
      downloadFile(`llm-sidebar-chats-${today()}.json`, JSON.stringify(serializeChatsExport(all), null, 2), 'application/json');
      toast(t('sidepanel.history.exported', { count: all.length }), { type: 'success' });
    } catch (err) {
      toast(err?.message || t('sidepanel.history.exportFailed'), { type: 'error' });
    }
  }

  async function deleteAll() {
    const ok = await confirmDialog(t('sidepanel.history.deleteAllConfirm', { count: chats.length }), {
      title: t('sidepanel.history.deleteAllTitle'), okText: t('sidepanel.history.deleteAll'), danger: true,
    });
    if (!ok) return;
    try {
      opts.onAllDeleted();
      await clearChats();
      toast(t('sidepanel.history.deletedAll'), { type: 'success' });
    } catch (err) {
      toast(err?.message || t('sidepanel.history.deleteAllFailed'), { type: 'error' });
    }
  }

  function show() {
    if (open) return;
    open = true;
    clearTimeout(closeTimer);
    drawer.hidden = false;
    backdrop.hidden = false;
    if (inertRoot) inertRoot.inert = true;
    toggleBtn.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => {
      drawer.classList.add('open');
      backdrop.classList.add('open');
    });
    search.value = '';
    render();
    load();
    setTimeout(() => search.focus({ preventScroll: true }), 30);
  }

  function close({ restoreFocus = true } = {}) {
    if (!open) return;
    open = false;
    drawer.classList.remove('open');
    backdrop.classList.remove('open');
    if (inertRoot) inertRoot.inert = false;
    toggleBtn.setAttribute('aria-expanded', 'false');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      drawer.hidden = true;
      backdrop.hidden = true;
    }, CLOSE_MS);
    if (restoreFocus) toggleBtn.focus({ preventScroll: true });
  }

  return {
    open: show,
    close,
    toggle: () => (open ? close() : show()),
    isOpen: () => open,
    refresh: () => (open ? load() : Promise.resolve()),
  };
}
