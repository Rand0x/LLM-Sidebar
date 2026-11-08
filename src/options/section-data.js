// "Daten & Datenschutz": privacy statement, host permission, settings/chat export & import, reset.

import { h, toast, confirmDialog } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { t, formatNumber } from '../lib/i18n.js';
import { ext, sessionArea, IS_FIREFOX } from '../lib/ext.js';
import { exportSettings, parseImportedSettings, getDefaultSettings } from '../lib/settings.js';
import {
  exportChats, importChats, clearChats, listChats, serializeChatsExport, parseChatsImport, onChatsChanged,
} from '../lib/db.js';
import { downloadFile } from '../lib/utils.js';
import {
  button, callout, group, panel, field, formDialog, dialogField, dateStamp, readFileText, filePicker, focusKey,
} from './dom.js';
import { describeImportedProviders } from './models.js';
import { hostAccessState, requestHostAccess, onHostAccessChange } from './permission.js';

/** Plural message `key` for `count`: {n} is the number formatted in the UI language. */
const tCount = (key, count, params = {}) => t(key, { ...params, count, n: formatNumber(count) });

const errorText = (err) => err?.message || String(err);

export function createDataSection(ctx) {
  const state = { permission: 'checking', chats: null, chatError: '' };
  let permissionSlot = null;
  let chatCountEl = null;
  let chatButtons = [];

  // ---------------------------------------------------------------- host permission

  async function checkPermission() {
    state.permission = await hostAccessState();
    renderPermission();
  }

  function requestPermission() {
    // Called directly from the click handler: requestHostAccess() asks before anything is awaited.
    requestHostAccess().then((granted) => {
      toast(granted ? t('optionsSections.data.access.grantedToast') : t('optionsSections.data.access.deniedToast'), { type: granted ? 'success' : 'warning' });
    }).catch((err) => {
      toast(t('optionsSections.data.access.requestFailed', { error: errorText(err) }), { type: 'error' });
    }).finally(() => checkPermission());
  }

  function renderPermission() {
    if (!permissionSlot) return;
    const p = state.permission;
    const badge = p === 'granted'
      ? h('span', { class: 'badge badge-success' }, h('span', { html: icon('check', { size: 12 }) }), t('optionsSections.data.access.granted'))
      : p === 'missing'
        ? h('span', { class: 'badge badge-warning' }, h('span', { html: icon('alert', { size: 12 }) }), t('optionsSections.data.access.missing'))
        : p === 'checking'
          ? h('span', { class: 'badge' }, t('optionsSections.data.access.checking'))
          : h('span', { class: 'badge' }, t('optionsSections.data.access.unknown'));
    const action = p === 'granted'
      ? null
      : button(t('optionsSections.data.access.allow'), { icon: 'shield', variant: p === 'missing' ? 'primary' : '', size: 'sm', dataset: { key: 'data:permission' }, onClick: requestPermission });
    const note = p === 'missing'
      ? h('p', { class: 'hint warning-text' }, IS_FIREFOX
        ? t('optionsSections.data.access.missingNoteFirefox')
        : t('optionsSections.data.access.missingNote'))
      : null;
    permissionSlot.replaceChildren(...[h('div', { class: 'row wrap' }, badge, action), note].filter(Boolean));
  }

  // ---------------------------------------------------------------- chats

  async function refreshChatCount() {
    try {
      const chats = await listChats();
      state.chats = chats.length;
      state.chatError = '';
    } catch (err) {
      state.chats = null;
      state.chatError = errorText(err);
    }
    renderChatCount();
  }

  function renderChatCount() {
    if (!chatCountEl) return;
    if (state.chatError) chatCountEl.textContent = t('optionsSections.data.chats.readError', { error: state.chatError });
    else if (state.chats === null) chatCountEl.textContent = t('optionsSections.data.chats.counting');
    else chatCountEl.textContent = state.chats ? tCount('optionsSections.data.chats.count', state.chats) : t('optionsSections.data.chats.none');
    // Disabling the focused button would drop focus to <body> – move it to the import button instead.
    const losingFocus = !state.chats && chatButtons.includes(document.activeElement);
    for (const btn of chatButtons) btn.disabled = !state.chats;
    if (losingFocus) focusKey('data:importChats');
  }

  async function exportChatsFile() {
    try {
      const chats = await exportChats();
      if (!chats.length) {
        toast(t('optionsSections.data.chats.nothingToExport'), { type: 'info' });
        return;
      }
      // Same file format as the side panel's history export.
      const json = JSON.stringify(serializeChatsExport(chats), null, 2);
      downloadFile(`llm-sidebar-chats-${dateStamp()}.json`, json, 'application/json');
      toast(tCount('optionsSections.data.chats.exported', chats.length), { type: 'success' });
    } catch (err) {
      toast(t('optionsSections.data.export.failed', { error: errorText(err) }), { type: 'error' });
    }
  }

  async function importChatsFile(file) {
    let text;
    try {
      text = await readFileText(file);
    } catch (err) {
      toast(t('optionsSections.data.import.readFailed', { error: errorText(err) }), { type: 'error' });
      return;
    }
    let chats;
    try {
      // Validates the format and sanitizes the chats (e.g. only safe image sources).
      chats = parseChatsImport(text);
    } catch (err) {
      let looksLikeSettings = false;
      try {
        const data = JSON.parse(text);
        looksLikeSettings = Boolean(data && typeof data === 'object' && !Array.isArray(data)
          && (data.format === 'llm-sidebar-settings' || data.settings || data.providers));
      } catch {
        looksLikeSettings = false;
      }
      toast(looksLikeSettings
        ? t('optionsSections.data.chats.isSettingsExport')
        : err?.message || t('optionsSections.data.import.failedGeneric'), { type: 'error' });
      return;
    }
    if (!chats?.length) {
      toast(t('optionsSections.data.chats.noneInFile'), { type: 'warning' });
      return;
    }
    const ok = await confirmDialog(tCount('optionsSections.data.chats.importConfirm', chats.length), {
      title: t('optionsSections.data.import.title', { name: file.name }), okText: t('optionsSections.data.import.ok'),
    });
    if (!ok) return;
    try {
      const count = await importChats(chats);
      toast(tCount('optionsSections.data.chats.imported', count), { type: 'success' });
    } catch (err) {
      toast(t('optionsSections.data.import.failed', { error: errorText(err) }), { type: 'error' });
    }
    refreshChatCount();
  }

  async function deleteAllChats() {
    const count = state.chats ?? 0;
    const ok = await confirmDialog(tCount('optionsSections.data.chats.deleteConfirm', count), {
      title: t('optionsSections.data.chats.deleteTitle'), okText: t('optionsSections.data.chats.deleteOk'), danger: true,
    });
    if (!ok) return;
    try {
      await clearChats();
      toast(t('optionsSections.data.chats.deleted'), { type: 'success' });
    } catch (err) {
      toast(t('optionsSections.data.chats.deleteFailed', { error: errorText(err) }), { type: 'error' });
    }
    refreshChatCount();
  }

  // ---------------------------------------------------------------- settings

  async function exportSettingsFile(includeKeys) {
    if (includeKeys) {
      const ok = await confirmDialog(t('optionsSections.data.export.keysConfirm'), {
        title: t('optionsSections.data.export.keysTitle'), okText: t('optionsSections.data.export.keysOk'), danger: true,
      });
      if (!ok) return;
    }
    try {
      const json = exportSettings(ctx.get(), { includeKeys });
      downloadFile(`llm-sidebar-einstellungen${includeKeys ? '-mit-schluesseln' : ''}-${dateStamp()}.json`, json, 'application/json');
      toast(includeKeys ? t('optionsSections.data.export.doneWithKeys') : t('optionsSections.data.export.done'), { type: 'success' });
    } catch (err) {
      toast(t('optionsSections.data.export.failed', { error: errorText(err) }), { type: 'error' });
    }
  }

  async function importSettingsFile(file) {
    let text;
    try {
      text = await readFileText(file);
    } catch (err) {
      toast(t('optionsSections.data.import.readFailed', { error: errorText(err) }), { type: 'error' });
      return;
    }
    let imported;
    try {
      imported = parseImportedSettings(text, { currentSettings: ctx.get() });
    } catch (err) {
      let isChatExport = false;
      try {
        const raw = JSON.parse(text);
        isChatExport = Array.isArray(raw) || raw?.format === 'llm-sidebar-chats';
      } catch {
        isChatExport = false;
      }
      toast(isChatExport
        ? t('optionsSections.data.import.isChatExport')
        : err?.message || t('optionsSections.data.import.failedGeneric'), { type: 'error' });
      return;
    }
    let fileHasKeys = false;
    try {
      const raw = JSON.parse(text);
      const candidate = raw?.settings ?? raw;
      fileHasKeys = Array.isArray(candidate?.providers)
        && candidate.providers.some((p) => typeof p?.apiKey === 'string' && p.apiKey.trim());
    } catch {
      fileHasKeys = false;
    }
    const custom = imported.providers.filter((p) => p.presetId === 'custom').length;
    const enabled = imported.providers.filter((p) => p.enabled).length;
    const providers = tCount('optionsSections.data.import.providers', enabled);
    const summary = [
      custom ? t('optionsSections.data.import.providersCustom', { providers, n: formatNumber(custom) }) : providers,
      tCount('optionsSections.data.import.quickActions', imported.quickActions.length),
      tCount('optionsSections.data.import.personas', imported.personas.length),
    ].join(', ');
    const keys = fileHasKeys
      ? t('optionsSections.data.import.keysIncluded')
      : t('optionsSections.data.import.keysNone');
    const changes = describeImportedProviders(ctx.get(), imported);
    const notes = [];
    if (changes.endpoints.length) {
      // Full URLs: a host alone would hide port or path changes.
      const url = (value) => value || t('optionsSections.data.import.noAddress');
      const lines = changes.endpoints.map((c) => {
        const key = c.keyDropped ? ` ${t('optionsSections.data.import.keyDropped')}`
          : c.keyKept ? ` ${t('optionsSections.data.import.keyKept')}` : '';
        return `• ${c.name}: ${url(c.from)} → ${url(c.to)}${key}`;
      });
      notes.push(`${tCount('optionsSections.data.import.endpoints', changes.endpoints.length)}\n${lines.join('\n')}\n${t('optionsSections.data.import.trust')}`);
    }
    if (changes.blankHeaders.length) {
      notes.push(t('optionsSections.data.import.blankHeaders', { providers: changes.blankHeaders.join(', ') }));
    }
    const message = [
      t('optionsSections.data.import.contains', { summary }),
      t('optionsSections.data.import.replaces', { keys }),
      ...notes,
    ].join('\n\n');
    const ok = await confirmDialog(message, {
      title: t('optionsSections.data.import.title', { name: file.name }), okText: t('optionsSections.data.import.ok'),
    });
    if (!ok) return;
    try {
      await ctx.store.replaceAll(imported);
      // The section was rebuilt: put focus back on the (new) import button.
      if (document.activeElement === document.body) focusKey('data:importSettings');
      toast(t('optionsSections.data.import.done'), { type: 'success' });
    } catch (err) {
      toast(t('optionsSections.data.import.failed', { error: errorText(err) }), { type: 'error' });
    }
  }

  async function resetEverything() {
    const resetWord = t('optionsSections.data.reset.word');
    const wordInput = h('input', { class: 'input', id: 'reset-confirm', autocomplete: 'off', spellcheck: 'false', placeholder: resetWord });
    const chatsBox = h('input', { type: 'checkbox', id: 'reset-chats' });
    const content = h('div', { class: 'dialog-fields' },
      h('label', { class: 'check-row', htmlFor: 'reset-chats' }, chatsBox, h('span', {}, t('optionsSections.data.reset.alsoChats'))),
      dialogField({ label: t('optionsSections.data.reset.typeToConfirm', { word: resetWord }), control: wordInput, id: 'reset-confirm' }));
    let alsoChats = false;
    const ok = await formDialog({
      title: t('optionsSections.data.reset.dialogTitle'),
      message: t('optionsSections.data.reset.dialogMessage'),
      content,
      okText: t('optionsSections.data.reset.ok'),
      danger: true,
      initialFocus: wordInput,
      canSubmit: () => wordInput.value.trim().toLocaleLowerCase() === resetWord.toLocaleLowerCase(),
      onSubmit: () => {
        alsoChats = chatsBox.checked;
        return true;
      },
    });
    if (!ok) return;
    try {
      await ext.storage.local.clear();
      if (sessionArea && sessionArea !== ext.storage.local) await sessionArea.clear();
    } catch (err) {
      console.warn('[LLM Sidebar] Storage could not be cleared completely:', err);
    }
    try {
      if (alsoChats) await clearChats();
      await ctx.store.replaceAll(getDefaultSettings());
      toast(alsoChats ? t('optionsSections.data.reset.doneWithChats') : t('optionsSections.data.reset.done'), { type: 'success' });
    } catch (err) {
      toast(t('optionsSections.data.reset.failed', { error: errorText(err) }), { type: 'error' });
    }
    refreshChatCount();
    ctx.navigate('anbieter');
  }

  // ---------------------------------------------------------------- render

  function render() {
    permissionSlot = h('div', { class: 'stack-sm' });
    chatCountEl = h('span', {});
    const settingsImport = filePicker({ key: 'settings', onFile: importSettingsFile });
    const chatsImport = filePicker({ key: 'chats', onFile: importChatsFile });
    const exportChatsBtn = button(t('optionsSections.data.chats.export'), { icon: 'download', size: 'sm', dataset: { key: 'data:exportChats' }, onClick: exportChatsFile });
    const deleteChatsBtn = button(t('optionsSections.data.chats.deleteAll'), { icon: 'trash', size: 'sm', variant: 'danger', dataset: { key: 'data:deleteChats' }, onClick: deleteAllChats });
    chatButtons = [exportChatsBtn, deleteChatsBtn];

    const body = h('div', { class: 'section-body' },
      callout('info', 'shield', t('optionsSections.data.privacy.title'),
        h('ul', { class: 'privacy-list' },
          h('li', {}, t('optionsSections.data.privacy.local')),
          h('li', {}, t('optionsSections.data.privacy.network')),
          h('li', {}, t('optionsSections.data.privacy.noTracking')),
          h('li', {}, t('optionsSections.data.privacy.providers')))),

      group({ title: t('optionsSections.data.access.title'), description: t('optionsSections.data.access.desc') },
        panel(field({ label: t('optionsSections.data.access.status'), control: permissionSlot, controlId: 'data-permission' }))),

      group({ title: t('optionsSections.data.backup.title'), description: t('optionsSections.data.backup.desc') }, panel(
        field({
          label: t('optionsSections.data.export.label'),
          hint: t('optionsSections.data.export.hint'),
          controlId: 'data-export',
          control: h('div', { class: 'row wrap justify-end', id: 'data-export' },
            button(t('optionsSections.data.export.withoutKeys'), { icon: 'download', size: 'sm', dataset: { key: 'data:exportSettings' }, onClick: () => exportSettingsFile(false) }),
            button(t('optionsSections.data.export.withKeys'), { icon: 'key', size: 'sm', variant: 'ghost', dataset: { key: 'data:exportSettingsKeys' }, onClick: () => exportSettingsFile(true) })),
        }),
        field({
          label: t('optionsSections.data.import.label'),
          hint: t('optionsSections.data.import.hint'),
          controlId: 'data-import',
          control: h('div', { class: 'row wrap justify-end', id: 'data-import' },
            button(t('optionsSections.data.import.chooseFile'), { icon: 'upload', size: 'sm', dataset: { key: 'data:importSettings' }, onClick: settingsImport.open }),
            settingsImport.input),
        }))),

      group({ title: t('optionsSections.data.chats.title'), description: t('optionsSections.data.chats.desc') }, panel(
        field({
          label: t('optionsSections.data.chats.saved'),
          hint: chatCountEl,
          controlId: 'data-chats',
          control: h('div', { class: 'row wrap justify-end', id: 'data-chats' },
            exportChatsBtn,
            button(t('optionsSections.data.chats.import'), { icon: 'upload', size: 'sm', dataset: { key: 'data:importChats' }, onClick: chatsImport.open }),
            chatsImport.input),
        }),
        field({
          label: t('optionsSections.data.chats.deleteAll'),
          hint: t('optionsSections.data.chats.deleteAllHint'),
          controlId: 'data-delete-chats',
          control: h('div', { class: 'row wrap justify-end', id: 'data-delete-chats' }, deleteChatsBtn),
        }))),

      group({ title: t('optionsSections.data.reset.title') }, h('div', { class: 'panel panel-danger' },
        field({
          label: t('optionsSections.data.reset.label'),
          hint: t('optionsSections.data.reset.hint'),
          controlId: 'data-reset',
          control: h('div', { class: 'row wrap justify-end', id: 'data-reset' },
            button(t('optionsSections.data.reset.button'), { icon: 'alert', size: 'sm', variant: 'danger', dataset: { key: 'data:reset' }, onClick: resetEverything })),
        }))));
    renderPermission();
    renderChatCount();
    return body;
  }

  // Keep status and counter current when the permission or the chats change elsewhere
  // (side panel, another options tab, browser settings).
  let countTimer = 0;
  const isVisible = (el) => Boolean(el?.isConnected && !el.closest('[hidden]'));
  onHostAccessChange(() => {
    if (permissionSlot?.isConnected) checkPermission();
  });
  onChatsChanged(() => {
    if (!isVisible(chatCountEl)) return;
    clearTimeout(countTimer);
    countTimer = setTimeout(refreshChatCount, 150);
  });

  return {
    id: 'daten',
    deps: () => null,
    render,
    onShow() {
      checkPermission();
      refreshChatCount();
    },
    onFocus() {
      checkPermission();
    },
  };
}
