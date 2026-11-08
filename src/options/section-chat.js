// "Chat & Personas": global chat behaviour plus the persona list editor.

import { h, confirmDialog } from '../lib/ui.js';
import { t } from '../lib/i18n.js';
import * as prompts from '../lib/prompts.js';
import { deepClone, uid } from '../lib/utils.js';
import {
  button, group, panel, field, switchField, numberInput, textArea, focusKey,
} from './dom.js';

const { personaName } = prompts;

/** Built-in personas (language-aware when prompts.js offers getDefaultPersonas()). */
function defaultPersonas() {
  return prompts.getDefaultPersonas?.() ?? prompts.DEFAULT_PERSONAS;
}

export function createChatSection(ctx) {
  const commit = (key, fn, opts) => ctx.commit(key, fn, opts);

  function render(s) {
    return h('div', { class: 'section-body' },
      group({ title: t('optionsSections.chat.behavior.title') }, panel(
        systemPromptField(s),
        personaSelectField(s),
        temperatureField(s),
        maxTokensField(s),
        contextField(s),
        switchField({
          label: t('optionsSections.chat.includePage.label'),
          hint: t('optionsSections.chat.includePage.hint'),
          checked: s.chat.includePageByDefault,
          key: 'chat:includePage',
          onChange: (v) => commit('chat.includePageByDefault', (x) => { x.chat.includePageByDefault = v; }),
        }),
        switchField({
          label: t('optionsSections.chat.sendWithEnter.label'),
          hint: t('optionsSections.chat.sendWithEnter.hint'),
          checked: s.general.sendWithEnter,
          key: 'chat:sendWithEnter',
          onChange: (v) => commit('general.sendWithEnter', (x) => { x.general.sendWithEnter = v; }),
        }),
        switchField({
          label: t('optionsSections.chat.streaming.label'),
          hint: t('optionsSections.chat.streaming.hint'),
          checked: s.general.streaming,
          key: 'chat:streaming',
          onChange: (v) => commit('general.streaming', (x) => { x.general.streaming = v; }),
        }))),
      personasGroup(s));
  }

  function systemPromptField(s) {
    const id = 'chat-system';
    const ta = textArea({
      id,
      key: 'chat:systemPrompt',
      value: s.chat.systemPrompt,
      rows: 3,
      placeholder: t('optionsSections.chat.systemPrompt.placeholder'),
      onInput: (value) => commit('chat.systemPrompt', (x) => { x.chat.systemPrompt = value; }),
    });
    return field({
      label: t('optionsSections.chat.systemPrompt.label'),
      hint: t('optionsSections.chat.systemPrompt.hint'),
      control: ta,
      controlId: id,
      stacked: true,
    });
  }

  function personaSelectField(s) {
    const id = 'chat-persona';
    const select = h('select', { class: 'select', id, dataset: { key: 'chat:personaId' } },
      s.personas.map((p) => h('option', { value: p.id }, personaName(p))));
    select.value = s.chat.personaId;
    select.addEventListener('change', () => {
      const value = select.value;
      commit('chat.personaId', (x) => { x.chat.personaId = value; }, { refresh: true });
    });
    return field({
      label: t('optionsSections.chat.persona.label'),
      hint: t('optionsSections.chat.persona.hint'),
      control: select,
      controlId: id,
    });
  }

  function temperatureField(s) {
    const id = 'chat-temperature';
    const { el } = numberInput({
      id,
      key: 'chat:temperature',
      value: s.chat.temperature,
      min: 0,
      max: 2,
      integer: false,
      decimal: true,
      allowEmpty: true,
      placeholder: t('optionsSections.chat.defaultPlaceholder'),
      setInvalid: ctx.setInvalid,
      onValue: (v) => commit('chat.temperature', (x) => { x.chat.temperature = v; }),
    });
    return field({
      label: t('optionsSections.chat.temperature.label'),
      hint: t('optionsSections.chat.temperature.hint'),
      control: el,
      controlId: id,
    });
  }

  function maxTokensField(s) {
    const id = 'chat-maxTokens';
    const { el } = numberInput({
      id,
      key: 'chat:maxTokens',
      value: s.chat.maxTokens,
      min: 1,
      max: 2000000,
      step: 1,
      allowEmpty: true,
      placeholder: t('optionsSections.chat.defaultPlaceholder'),
      unit: t('optionsSections.chat.maxTokens.unit'),
      setInvalid: ctx.setInvalid,
      onValue: (v) => commit('chat.maxTokens', (x) => { x.chat.maxTokens = v; }),
    });
    return field({
      label: t('optionsSections.chat.maxTokens.label'),
      hint: t('optionsSections.chat.maxTokens.hint'),
      control: el,
      controlId: id,
    });
  }

  function contextField(s) {
    const id = 'chat-context';
    const { el } = numberInput({
      id,
      key: 'chat:contextMessages',
      value: s.chat.contextMessages,
      min: 1,
      max: 200,
      step: 1,
      unit: t('optionsSections.chat.context.unit'),
      setInvalid: ctx.setInvalid,
      onValue: (v) => commit('chat.contextMessages', (x) => { x.chat.contextMessages = v; }),
    });
    return field({
      label: t('optionsSections.chat.context.label'),
      hint: t('optionsSections.chat.context.hint'),
      control: el,
      controlId: id,
    });
  }

  // ---------------------------------------------------------------- personas

  function personasGroup(s) {
    const actions = [
      button(t('optionsSections.chat.personas.reset'), { icon: 'refresh', size: 'sm', variant: 'ghost', dataset: { key: 'persona:reset' }, onClick: resetPersonas }),
      button(t('optionsSections.chat.personas.add'), { icon: 'plus', size: 'sm', dataset: { key: 'persona:add' }, onClick: addPersona }),
    ];
    return group({
      title: t('optionsSections.chat.personas.title'),
      description: t('optionsSections.chat.personas.desc'),
      actions,
    }, h('div', { class: 'item-list' }, s.personas.map((p) => personaItem(p, s))));
  }

  function personaItem(persona, s) {
    const isDefault = persona.id === 'default';
    const isStandard = s.chat.personaId === persona.id;
    const nameId = `persona-${persona.id}-name`;
    const promptId = `persona-${persona.id}-prompt`;
    const name = personaName(persona);

    if (isDefault) {
      return h('div', { class: 'item persona-item', dataset: { personaId: persona.id } },
        h('div', { class: 'item-head' },
          h('span', { class: 'item-title' }, name),
          isStandard ? h('span', { class: 'badge badge-accent' }, t('optionsSections.chat.persona.badgeDefaultForNew')) : null,
          h('span', { class: 'badge' }, t('optionsSections.chat.persona.badgeFixed'))),
        h('p', { class: 'hint' }, t('optionsSections.chat.persona.neutralHint')));
    }

    // Shows the display name (built-in personas follow the UI language); typing stores the
    // edited name in the settings as before.
    const nameInput = h('input', {
      class: 'input',
      id: nameId,
      value: name,
      maxlength: 60,
      autocomplete: 'off',
      'aria-label': t('optionsSections.chat.persona.nameLabel'),
      dataset: { key: `persona:${persona.id}:name` },
    });
    nameInput.addEventListener('input', () => {
      const value = nameInput.value.trim();
      if (!value) return;
      commit(`persona:${persona.id}:name`, (x) => {
        const p = x.personas.find((item) => item.id === persona.id);
        if (p) p.name = value;
      });
      const option = document.querySelector(`#chat-persona option[value="${CSS.escape(persona.id)}"]`);
      if (option) option.textContent = value;
    });
    nameInput.addEventListener('blur', () => {
      if (!nameInput.value.trim()) {
        const stored = ctx.get().personas.find((item) => item.id === persona.id);
        nameInput.value = (stored && personaName(stored)) || t('optionsSections.chat.persona.fallbackName');
      }
    });

    const promptLabel = t('optionsSections.chat.persona.promptLabel', { name });
    const promptArea = textArea({
      id: promptId,
      key: `persona:${persona.id}:prompt`,
      value: prompts.effectivePersonaPrompt(persona), // unchanged defaults in the prompt language
      rows: 3,
      placeholder: t('optionsSections.chat.persona.promptPlaceholder'),
      'aria-label': promptLabel,
      onInput: (value) => commit(`persona:${persona.id}:prompt`, (x) => {
        const p = x.personas.find((item) => item.id === persona.id);
        if (p) p.prompt = value;
      }),
    });

    const builtin = defaultPersonas().find((p) => p.id === persona.id);
    return h('div', { class: 'item persona-item', dataset: { personaId: persona.id } },
      h('div', { class: 'item-head' },
        h('div', { class: 'item-name-field' }, nameInput),
        isStandard ? h('span', { class: 'badge badge-accent' }, t('optionsSections.chat.persona.badgeDefault')) : null,
        builtin ? null : h('span', { class: 'badge' }, t('optionsSections.chat.persona.badgeCustom')),
        button(t('optionsSections.chat.persona.delete', { name }), {
          icon: 'trash', iconOnly: true, size: 'sm', className: 'item-delete', dataset: { key: `persona:${persona.id}:delete` }, onClick: () => deletePersona(persona.id),
        })),
      h('label', { class: 'sr-only', htmlFor: promptId }, promptLabel),
      promptArea);
  }

  function addPersona() {
    const persona = { id: uid('persona-'), name: t('optionsSections.chat.persona.newName'), prompt: '' };
    commit(`persona:add:${persona.id}`, (x) => {
      if (!x.personas.some((p) => p.id === persona.id)) x.personas.push({ ...persona });
    }, { refresh: true });
    focusKey(`persona:${persona.id}:name`, { select: true });
  }

  async function deletePersona(id) {
    const persona = ctx.get().personas.find((p) => p.id === id);
    if (!persona) return;
    const fallback = ctx.get().personas.find((p) => p.id === 'default') ?? defaultPersonas().find((p) => p.id === 'default');
    const ok = await confirmDialog(t('optionsSections.chat.persona.deleteConfirm', {
      name: personaName(persona),
      defaultName: personaName(fallback) || t('optionsSections.chat.persona.badgeDefault'),
    }), {
      title: t('optionsSections.chat.persona.deleteTitle'), okText: t('optionsSections.chat.persona.deleteOk'), danger: true,
    });
    if (!ok) return;
    const list = ctx.get().personas;
    const index = list.findIndex((p) => p.id === id);
    const next = list[index + 1] ?? list[index - 1];
    commit(`persona:del:${id}`, (x) => {
      x.personas = x.personas.filter((p) => p.id !== id);
      if (x.chat.personaId === id) x.chat.personaId = 'default';
    }, { refresh: true });
    if (!(next && next.id !== 'default' && focusKey(`persona:${next.id}:name`))) focusKey('persona:add');
  }

  async function resetPersonas() {
    const ok = await confirmDialog(t('optionsSections.chat.personas.resetConfirm'), {
      title: t('optionsSections.chat.personas.resetTitle'), okText: t('optionsSections.chat.personas.resetOk'),
    });
    if (!ok) return;
    const defaults = defaultPersonas();
    commit('persona:reset', (x) => {
      const custom = x.personas.filter((p) => !defaults.some((d) => d.id === p.id));
      x.personas = [...deepClone(defaults), ...custom];
    }, { refresh: true });
    focusKey('persona:reset');
  }

  return {
    id: 'chat',
    deps: (s) => [s.chat.systemPrompt, s.chat.personaId, s.chat.temperature, s.chat.maxTokens, s.chat.contextMessages,
      s.chat.includePageByDefault, s.general.sendWithEnter, s.general.streaming, s.personas],
    render,
  };
}
