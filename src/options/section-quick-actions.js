// "Schnellaktionen": list editor for the selection toolbar / context menu actions.

import { h, confirmDialog } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { t } from '../lib/i18n.js';
import * as prompts from '../lib/prompts.js';
import { deepClone, uid } from '../lib/utils.js';
import {
  button, callout, group, inlineSwitch, textArea, insertAtCaret, focusKey,
} from './dom.js';

const { quickActionName, promptLanguage } = prompts;

const TEMPLATE_VARIABLE_NAMES = ['text', 'lang', 'profile', 'title', 'url'];

/** Template placeholders with their (translated) descriptions. */
export function templateVariables() {
  return TEMPLATE_VARIABLE_NAMES.map((name) => ({
    name: `{{${name}}}`,
    description: t(`optionsSections.quickActions.var.${name}`),
  }));
}

// Starting template for a new action. It is an LLM prompt (not a UI string), so like the default
// prompts it exists in German (German UI) and English (every other UI language).
const NEW_PROMPT = {
  de: 'Bearbeite den folgenden Text: …\n\nSchreibe in derselben Sprache wie der Originaltext. Gib ausschließlich das Ergebnis aus – ohne Einleitung oder Erklärung.\n\n<text>\n{{text}}\n</text>',
  en: 'Edit the following text: …\n\nWrite in the same language as the original text. Output only the result – without an introduction or explanation.\n\n<text>\n{{text}}\n</text>',
};
const TOOLBAR_SOFT_LIMIT = 8;
const HAS_TEXT_VAR = /\{\{\s*text\s*\}\}/;

/** Built-in quick actions (language-aware when prompts.js offers getDefaultQuickActions()). */
function defaultQuickActions() {
  return prompts.getDefaultQuickActions?.() ?? prompts.DEFAULT_QUICK_ACTIONS;
}

export function createQuickActionsSection(ctx) {
  const ui = { expanded: new Set() };
  const builtinOf = (id) => defaultQuickActions().find((a) => a.id === id) ?? null;
  const findAction = (s, id) => s.quickActions.find((a) => a.id === id);
  const displayName = (action) => quickActionName(action) || t('optionsSections.quickActions.item.fallbackName');

  function patchAction(id, field, fn, opts) {
    ctx.commit(`qa:${id}:${field}`, (s) => {
      const action = findAction(s, id);
      if (action) fn(action);
    }, opts);
  }

  function render(s) {
    const actions = s.quickActions;
    const inToolbar = actions.filter((a) => a.toolbar).length;
    const inMenu = actions.filter((a) => a.contextMenu).length;
    const summary = h('p', { class: 'hint qa-summary' },
      t('optionsSections.quickActions.summary', { count: actions.length, toolbar: inToolbar, menu: inMenu }),
      inToolbar > TOOLBAR_SOFT_LIMIT ? h('span', { class: 'warning-text' }, ` ${t('optionsSections.quickActions.manyToolbar')}`) : null);

    const list = h('div', { class: 'item-list qa-list' });
    actions.forEach((action, index) => list.append(actionItem(action, index, actions.length)));
    if (!actions.length) {
      list.append(h('div', { class: 'empty-state' },
        h('span', { class: 'empty-icon', html: icon('bolt', { size: 22 }) }),
        h('p', {}, t('optionsSections.quickActions.empty')),
        button(t('optionsSections.quickActions.restoreDefaultActions'), { size: 'sm', onClick: resetAll })));
    }

    return h('div', { class: 'section-body' },
      callout('info', 'info', t('optionsSections.quickActions.howto.title'),
        h('p', {}, t('optionsSections.quickActions.howto.intro')),
        h('ul', { class: 'var-list' }, templateVariables().map((v) => h('li', {},
          h('code', {}, v.name), ` – ${v.description}`))),
        h('p', {}, t('optionsSections.quickActions.howto.noText'))),
      group({
        title: t('optionsSections.quickActions.group.title'),
        description: t('optionsSections.quickActions.group.desc'),
        actions: [
          button(t('optionsSections.quickActions.reset'), { icon: 'refresh', size: 'sm', variant: 'ghost', dataset: { key: 'qa:reset' }, onClick: resetAll }),
          button(t('optionsSections.quickActions.add'), { icon: 'plus', size: 'sm', dataset: { key: 'qa:add' }, onClick: addAction }),
        ],
      }, summary, list));
  }

  function actionItem(action, index, count) {
    const expanded = ui.expanded.has(action.id);
    const bodyId = `qa-body-${action.id}`;
    const name = displayName(action);
    const item = h('div', { class: ['item', 'qa-item', expanded && 'expanded'], dataset: { actionId: action.id } });

    const toggle = h('button', {
      type: 'button',
      class: 'qa-toggle',
      'aria-expanded': String(expanded),
      'aria-controls': bodyId,
      title: expanded ? t('optionsSections.quickActions.item.closeEdit') : t('optionsSections.quickActions.item.edit'),
      dataset: { key: `qa:${action.id}:toggle` },
      onClick: () => {
        if (ui.expanded.has(action.id)) ui.expanded.delete(action.id);
        else ui.expanded.add(action.id);
        ctx.rerender();
      },
    },
    h('span', { class: 'qa-icon', 'aria-hidden': 'true' }, action.icon),
    h('span', { class: 'qa-name' }, name),
    action.builtin ? null : h('span', { class: 'badge' }, t('optionsSections.quickActions.item.badgeCustom')),
    h('span', { class: 'qa-chevron', html: icon('chevron-down', { size: 16 }) }));

    const controls = h('div', { class: 'qa-controls' },
      inlineSwitch({
        label: t('optionsSections.quickActions.item.toolbar'),
        title: t('optionsSections.quickActions.item.toolbarTitle'),
        checked: action.toolbar,
        key: `qa:${action.id}:toolbar`,
        onChange: (v) => patchAction(action.id, 'toolbar', (a) => { a.toolbar = v; }, { refresh: true }),
      }),
      inlineSwitch({
        label: t('optionsSections.quickActions.item.contextMenu'),
        title: t('optionsSections.quickActions.item.contextMenuTitle'),
        checked: action.contextMenu,
        key: `qa:${action.id}:contextMenu`,
        onChange: (v) => patchAction(action.id, 'contextMenu', (a) => { a.contextMenu = v; }, { refresh: true }),
      }),
      h('span', { class: 'qa-move' },
        button(t('optionsSections.quickActions.item.moveUp', { name }), {
          icon: 'chevron-up', iconOnly: true, size: 'sm', disabled: index === 0, dataset: { key: `qa:${action.id}:up` }, onClick: () => move(action.id, -1),
        }),
        button(t('optionsSections.quickActions.item.moveDown', { name }), {
          icon: 'chevron-down', iconOnly: true, size: 'sm', disabled: index === count - 1, dataset: { key: `qa:${action.id}:down` }, onClick: () => move(action.id, 1),
        })),
      button(t('optionsSections.quickActions.item.delete', { name }), {
        icon: 'trash', iconOnly: true, size: 'sm', className: 'item-delete', dataset: { key: `qa:${action.id}:delete` }, onClick: () => deleteAction(action.id),
      }));

    item.append(h('div', { class: 'qa-head' }, toggle, controls));
    if (expanded) item.append(actionBody(action, bodyId));
    return item;
  }

  function actionBody(action, bodyId) {
    const builtin = builtinOf(action.id);
    const iconId = `qa-${action.id}-icon`;
    const nameId = `qa-${action.id}-name`;
    const promptId = `qa-${action.id}-prompt`;

    const iconInput = h('input', {
      class: 'input qa-icon-input', id: iconId, value: action.icon, maxlength: 16, autocomplete: 'off', dataset: { key: `qa:${action.id}:icon` },
    });
    iconInput.addEventListener('input', () => {
      const value = [...iconInput.value.trim()].slice(0, 8).join('');
      if (!value) return;
      patchAction(action.id, 'icon', (a) => { a.icon = value; });
      const head = document.querySelector(`[data-action-id="${CSS.escape(action.id)}"] .qa-icon`);
      if (head) head.textContent = value;
    });
    iconInput.addEventListener('blur', () => {
      if (!iconInput.value.trim()) iconInput.value = findAction(ctx.get(), action.id)?.icon || '⚡';
    });

    // Shows the display name (built-in actions follow the UI language); typing stores the edited
    // name in the settings as before.
    const nameInput = h('input', {
      class: 'input', id: nameId, value: quickActionName(action), maxlength: 40, autocomplete: 'off', dataset: { key: `qa:${action.id}:name` },
    });
    nameInput.addEventListener('input', () => {
      const value = nameInput.value.trim();
      if (!value) return;
      patchAction(action.id, 'name', (a) => { a.name = value; });
      const head = document.querySelector(`[data-action-id="${CSS.escape(action.id)}"] .qa-name`);
      if (head) head.textContent = value;
    });
    nameInput.addEventListener('blur', () => {
      if (!nameInput.value.trim()) nameInput.value = displayName(findAction(ctx.get(), action.id));
    });

    const noTextHint = h('p', { class: 'hint warning-text', hidden: HAS_TEXT_VAR.test(action.prompt) || !action.prompt.trim() },
      t('optionsSections.quickActions.edit.noTextHint'));
    const emptyHint = h('p', { class: 'hint', hidden: Boolean(action.prompt.trim()) },
      builtin ? t('optionsSections.quickActions.edit.emptyBuiltin') : t('optionsSections.quickActions.edit.emptyCustom'));
    let resetBtn = null;

    const promptArea = textArea({
      id: promptId,
      key: `qa:${action.id}:prompt`,
      // An unchanged built-in prompt is shown in the current prompt language.
      value: builtin ? prompts.effectivePrompt(action) : action.prompt,
      rows: 6,
      max: 420,
      className: 'qa-prompt',
      spellcheck: 'true',
      onInput: (value) => {
        patchAction(action.id, 'prompt', (a) => { a.prompt = value; });
        noTextHint.hidden = HAS_TEXT_VAR.test(value) || !value.trim();
        emptyHint.hidden = Boolean(value.trim());
        if (resetBtn) resetBtn.disabled = value === builtin.prompt;
      },
    });

    const varButtons = h('div', { class: 'var-buttons', role: 'group', 'aria-label': t('optionsSections.quickActions.edit.varsLabel') },
      h('span', { class: 'hint' }, t('optionsSections.quickActions.edit.varsInsert')),
      templateVariables().map((v) => h('button', {
        type: 'button',
        class: 'chip chip-code',
        title: t('optionsSections.quickActions.edit.varTitle', { name: v.name, description: v.description }),
        dataset: { key: `qa:${action.id}:var:${v.name}` },
        onClick: () => insertAtCaret(promptArea, v.name),
      }, v.name)));

    if (builtin) {
      resetBtn = button(t('optionsSections.quickActions.edit.resetPrompt'), {
        icon: 'refresh',
        size: 'sm',
        variant: 'ghost',
        disabled: prompts.effectivePrompt(action) === builtin.prompt,
        dataset: { key: `qa:${action.id}:resetPrompt` },
        onClick: () => {
          promptArea.value = builtin.prompt;
          promptArea.dispatchEvent(new Event('input', { bubbles: true }));
          promptArea.focus();
        },
      });
    }

    return h('div', { class: 'qa-body', id: bodyId },
      h('div', { class: 'qa-row' },
        h('div', { class: 'qa-field qa-field-icon' }, h('label', { class: 'label', htmlFor: iconId }, t('optionsSections.quickActions.edit.icon')), iconInput),
        h('div', { class: 'qa-field qa-field-name' }, h('label', { class: 'label', htmlFor: nameId }, t('optionsSections.quickActions.edit.name')), nameInput)),
      h('div', { class: 'qa-field' },
        h('label', { class: 'label', htmlFor: promptId }, t('optionsSections.quickActions.edit.prompt')),
        promptArea,
        noTextHint,
        emptyHint),
      h('div', { class: 'qa-body-foot' }, varButtons, h('span', { class: 'spacer' }), resetBtn));
  }

  function move(id, delta) {
    const order = ctx.get().quickActions.map((a) => a.id);
    const index = order.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return;
    order.splice(index, 1);
    order.splice(target, 0, id);
    ctx.commit('qa:order', (s) => {
      const rank = new Map(order.map((actionId, i) => [actionId, i]));
      s.quickActions = [...s.quickActions].sort((a, b) => (rank.get(a.id) ?? 1e6) - (rank.get(b.id) ?? 1e6));
    }, { refresh: true });
    const wanted = `qa:${id}:${delta < 0 ? 'up' : 'down'}`;
    if (!focusKey(wanted)) focusKey(`qa:${id}:${delta < 0 ? 'down' : 'up'}`);
    const name = displayName(findAction(ctx.get(), id));
    ctx.announce(t('optionsSections.quickActions.moved', { name, position: target + 1, total: order.length }));
  }

  function addAction() {
    const action = {
      id: uid('qa-'),
      name: t('optionsSections.quickActions.item.newName'),
      icon: '⚡',
      prompt: NEW_PROMPT[promptLanguage()] ?? NEW_PROMPT.en,
      toolbar: false,
      contextMenu: true,
      builtin: false,
    };
    ui.expanded.add(action.id);
    ctx.commit(`qa:add:${action.id}`, (s) => {
      if (!s.quickActions.some((a) => a.id === action.id)) s.quickActions.push({ ...action });
    }, { refresh: true });
    document.querySelector(`[data-action-id="${CSS.escape(action.id)}"]`)?.scrollIntoView({ block: 'center' });
    focusKey(`qa:${action.id}:name`, { select: true });
  }

  async function deleteAction(id) {
    const action = findAction(ctx.get(), id);
    if (!action) return;
    const name = displayName(action);
    const ok = await confirmDialog(action.builtin
      ? t('optionsSections.quickActions.delete.confirmBuiltin', { name })
      : t('optionsSections.quickActions.delete.confirmCustom', { name }), {
      title: t('optionsSections.quickActions.delete.title'), okText: t('optionsSections.quickActions.delete.ok'), danger: true,
    });
    if (!ok) return;
    const list = ctx.get().quickActions;
    const index = list.findIndex((a) => a.id === id);
    const next = list[index + 1] ?? list[index - 1];
    ui.expanded.delete(id);
    ctx.commit(`qa:del:${id}`, (s) => {
      s.quickActions = s.quickActions.filter((a) => a.id !== id);
    }, { refresh: true });
    if (!(next && focusKey(`qa:${next.id}:toggle`))) focusKey('qa:add');
    ctx.announce(t('optionsSections.quickActions.deleted', { name }));
  }

  async function resetAll() {
    const ok = await confirmDialog(t('optionsSections.quickActions.resetAll.confirm'), {
      title: t('optionsSections.quickActions.resetAll.title'), okText: t('optionsSections.quickActions.resetAll.ok'), danger: true,
    });
    if (!ok) return;
    ui.expanded.clear();
    const defaults = defaultQuickActions();
    ctx.commit('qa:reset', (s) => {
      s.quickActions = deepClone(defaults);
    }, { refresh: true });
    focusKey('qa:reset');
    ctx.announce(t('optionsSections.quickActions.resetAll.done'));
  }

  return {
    id: 'schnellaktionen',
    deps: (s) => s.quickActions,
    render,
  };
}
