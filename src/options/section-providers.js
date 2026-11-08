// "Anbieter": one card per provider – key, connection test, model lists, image API, advanced fields.

import { h, toast, confirmDialog, promptDialog } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { getPreset, createCustomProvider, createProviderFromPreset } from '../lib/providers.js';
import { getProvider } from '../lib/settings.js';
import { listModels, testConnection, describeError } from '../lib/llm.js';
import { deepClone, hostnameOf } from '../lib/utils.js';
import { t, hasMessage, formatNumber } from '../lib/i18n.js';
import {
  button, callout, externalLink, preserveFocus, focusKey, textArea, formDialog, dialogField, setBusy,
} from './dom.js';
import {
  llmProvider, providerStatus, isProviderUsable, shouldAutoLoadModels, needsKey, mergeFetchedModels, describeMerge,
  splitModelIds, validateBaseUrl, parseHeadersJson, headersToText,
} from './models.js';

const CHIP_LIMIT = 24;
const CUSTOM_VALUE = '__custom__';
const imageApis = () => [
  { value: 'none', label: t('options.providers.imageApi.none') },
  { value: 'openai-images', label: t('options.providers.imageApi.openaiImages') },
  { value: 'openrouter-chat', label: t('options.providers.imageApi.openrouterChat') },
];
const protocols = () => [
  { value: 'openai', label: t('options.providers.protocol.openaiPath') },
  { value: 'anthropic', label: t('options.providers.protocol.anthropicPath') },
];

const initial = (name) => (String(name || '?').match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
const protocolLabel = (p) => (p.protocol === 'anthropic'
  ? t('options.providers.protocol.anthropic')
  : t('options.providers.protocol.openai'));

// Preset texts live in lib/providers.js (German). Translated versions are looked up by preset id;
// unknown presets fall back to the preset's own text.
function presetText(key, fallback) {
  return hasMessage(key) ? t(key) : (fallback || '');
}
const presetNotes = (preset) => presetText(`options.providers.preset.${preset.id}.notes`, preset.notes);
const endpointKey = (preset, index) => `options.providers.preset.${preset.id}.endpoint${index + 1}`;

export function createProvidersSection(ctx) {
  const ui = {
    expanded: new Set(),
    revealed: new Set(),
    advanced: new Set(),
    busy: new Map(), // id → 'test' | 'models'
    results: new Map(), // id → { type, text, models? }
    showAll: new Set(), // `${id}:${kind}`
    chipFilter: new Map(), // `${id}:${kind}` → text
    drafts: new Map(), // `${id}:baseUrl|headers` → raw text that is not valid yet
    query: '',
    onlyActive: false,
  };
  const cards = new Map();
  let listEl = null;
  let emptyEl = null;
  let summaryEl = null;
  let welcomeEl = null;

  const providerOf = (id) => getProvider(ctx.get(), id);

  function patchProvider(id, field, fn, opts) {
    ctx.commit(`p:${id}:${field}`, (s) => {
      const p = getProvider(s, id);
      if (p) fn(p, s);
    }, opts);
  }

  // ---------------------------------------------------------------- rendering

  function render(s) {
    cards.clear();
    listEl = h('div', { class: 'provider-list' });
    for (const p of s.providers) {
      const card = buildCard(p);
      cards.set(p.id, card);
      listEl.append(card);
    }
    emptyEl = h('div', { class: 'empty-state', hidden: true },
      h('span', { class: 'empty-icon', html: icon('search', { size: 22 }) }),
      h('p', {}, t('options.providers.filter.noMatch')),
      button(t('options.providers.filter.reset'), { size: 'sm', onClick: resetFilter }));
    welcomeEl = h('div', { class: 'welcome-slot' });
    summaryEl = h('span', { class: 'toolbar-summary muted text-sm', 'aria-live': 'polite' });
    const root = h('div', { class: 'section-body' },
      welcomeEl,
      buildToolbar(),
      listEl,
      emptyEl,
      h('p', { class: 'hint section-foot' },
        h('span', { class: 'inline-icon', html: icon('shield', { size: 14 }) }),
        t('options.providers.footer')));
    refreshSummary();
    applyFilter();
    return root;
  }

  function buildWelcome(s) {
    if (s.providers.some(isProviderUsable)) return null;
    return callout('info', 'sparkles', t('options.providers.welcome.title'),
      h('ol', { class: 'welcome-steps' },
        h('li', {}, t('options.providers.welcome.step1')),
        h('li', {}, t('options.providers.welcome.step2')),
        h('li', {}, t('options.providers.welcome.step3'))),
      h('p', { class: 'hint' }, t('options.providers.welcome.local')));
  }

  function buildToolbar() {
    const search = h('input', {
      class: 'input',
      type: 'search',
      placeholder: t('options.providers.search.placeholder'),
      'aria-label': t('options.providers.search.label'),
      value: ui.query,
      autocomplete: 'off',
      spellcheck: 'false',
      dataset: { key: 'p:search' },
    });
    search.addEventListener('input', () => {
      ui.query = search.value;
      applyFilter();
    });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && search.value) {
        event.preventDefault();
        search.value = '';
        ui.query = '';
        applyFilter();
      }
    });
    const activeChip = h('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(ui.onlyActive),
      dataset: { key: 'p:onlyActive' },
      title: t('options.providers.onlyActive.title'),
      onClick: () => {
        ui.onlyActive = !ui.onlyActive;
        activeChip.setAttribute('aria-pressed', String(ui.onlyActive));
        applyFilter();
      },
    }, t('options.providers.onlyActive.label'));
    return h('div', { class: 'section-toolbar' },
      h('div', { class: 'search-wrap' }, h('span', { class: 'search-icon', html: icon('search', { size: 16 }) }), search),
      activeChip,
      summaryEl,
      h('span', { class: 'spacer' }),
      button(t('options.providers.custom.add'), { icon: 'plus', variant: 'primary', dataset: { key: 'p:addCustom' }, onClick: addCustomProvider }));
  }

  function refreshSummary() {
    const s = ctx.get();
    const ready = s.providers.filter(isProviderUsable).length;
    if (summaryEl) {
      summaryEl.textContent = ready
        ? t('options.providers.summary.ready', { ready, total: s.providers.length })
        : t('options.providers.summary.none');
    }
    if (welcomeEl) welcomeEl.replaceChildren(...[buildWelcome(s)].filter(Boolean));
  }

  function matches(p) {
    if (ui.onlyActive && !p.enabled) return false;
    const q = ui.query.trim().toLowerCase();
    if (!q) return true;
    const preset = getPreset(p.presetId);
    return [p.name, p.id, p.baseUrl, preset.name].some((v) => String(v || '').toLowerCase().includes(q));
  }

  function applyFilter() {
    const s = ctx.get();
    let visible = 0;
    for (const p of s.providers) {
      const card = cards.get(p.id);
      if (!card) continue;
      const show = matches(p);
      card.hidden = !show;
      if (show) visible += 1;
    }
    if (emptyEl) emptyEl.hidden = visible > 0;
  }

  function resetFilter({ focus = true } = {}) {
    ui.query = '';
    ui.onlyActive = false;
    const search = document.querySelector('[data-key="p:search"]');
    if (search) search.value = '';
    document.querySelector('[data-key="p:onlyActive"]')?.setAttribute('aria-pressed', 'false');
    applyFilter();
    if (focus) focusKey('p:search');
  }

  function refreshCard(id, { focus = null, fallback = null } = {}) {
    const old = cards.get(id);
    const p = providerOf(id);
    if (!old || !old.isConnected) return;
    if (!p) {
      old.remove();
      cards.delete(id);
      return;
    }
    preserveFocus(() => {
      const fresh = buildCard(p);
      fresh.hidden = old.hidden;
      old.replaceWith(fresh);
      cards.set(id, fresh);
    });
    if (focus && !focusKey(focus) && fallback) focusKey(fallback);
    refreshSummary();
  }

  function refreshHead(id) {
    const card = cards.get(id);
    const p = providerOf(id);
    if (!card || !p) return;
    const oldHead = card.querySelector(':scope > .pc-head');
    if (oldHead) oldHead.replaceWith(buildHead(p));
    const keyHint = card.querySelector('.pc-key-hint');
    if (keyHint) keyHint.textContent = keyHintText(p, getPreset(p.presetId));
    card.classList.toggle('is-ready', providerStatus(p).ready);
    refreshSummary();
  }

  function buildCard(p) {
    const expanded = ui.expanded.has(p.id);
    const card = h('article', {
      class: ['card', 'provider-card', expanded && 'expanded', providerStatus(p).ready && 'is-ready'],
      id: `provider-${p.id}`,
      dataset: { providerId: p.id },
      'aria-label': p.name,
    }, buildHead(p));
    if (expanded) card.append(buildBody(p));
    return card;
  }

  function buildHead(p) {
    const preset = getPreset(p.presetId);
    const status = providerStatus(p);
    const expanded = ui.expanded.has(p.id);
    const isCustom = p.presetId === 'custom';
    const subtitle = isCustom
      ? `${protocolLabel(p)} · ${p.baseUrl || t('options.providers.card.noBaseUrl')}`
      : presetNotes(preset);
    const toggle = h('button', {
      type: 'button',
      class: 'pc-toggle',
      'aria-expanded': String(expanded),
      'aria-controls': `provider-body-${p.id}`,
      title: expanded ? t('options.providers.card.hideDetails') : t('options.providers.card.showDetails'),
      dataset: { key: `p:${p.id}:toggle` },
      onClick: () => toggleExpanded(p.id),
    },
    h('span', { class: 'pc-avatar', style: { '--pc-color': preset.color || '#6d5efc' }, 'aria-hidden': 'true' }, initial(p.name)),
    h('span', { class: 'pc-title' },
      h('span', { class: 'pc-name-row' },
        h('span', { class: 'pc-name' }, p.name),
        h('span', { class: ['badge', status.cls] }, status.label),
        isCustom ? h('span', { class: 'badge badge-accent' }, t('options.providers.card.customBadge')) : null),
      subtitle ? h('span', { class: 'pc-sub' }, subtitle) : null),
    h('span', { class: 'pc-chevron', html: icon('chevron-down', { size: 18 }) }));

    const switchInput = h('input', {
      type: 'checkbox',
      role: 'switch',
      checked: p.enabled,
      'aria-label': t('options.providers.card.enableNamed', { name: p.name }),
      dataset: { key: `p:${p.id}:enabled` },
      onChange: (event) => setEnabled(p.id, event.target.checked),
    });
    return h('div', { class: 'pc-head' },
      toggle,
      h('label', { class: 'switch pc-switch', title: p.enabled ? t('options.providers.card.disable') : t('options.providers.card.enable') },
        switchInput, h('span', { 'aria-hidden': 'true' })));
  }

  function buildBody(p) {
    const preset = getPreset(p.presetId);
    return h('div', { class: 'pc-body', id: `provider-body-${p.id}` },
      buildKeyBlock(p, preset),
      buildActions(p, preset),
      buildModelBlock(p, 'chat'),
      buildImageBlock(p),
      buildAdvanced(p, preset));
  }

  // ---------------------------------------------------------------- API key

  function buildKeyBlock(p, preset) {
    const inputId = `p-${p.id}-key`;
    const revealed = ui.revealed.has(p.id);
    const input = h('input', {
      class: 'input mono',
      id: inputId,
      type: revealed ? 'text' : 'password',
      placeholder: preset.requiresKey ? t('options.providers.key.placeholder') : t('options.providers.key.notRequired'),
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      'aria-invalid': p.enabled && needsKey(p) ? 'true' : null,
      dataset: { key: `p:${p.id}:apiKey` },
    });
    input.value = p.apiKey;
    input.addEventListener('input', () => onKeyInput(p.id, input));
    input.addEventListener('change', () => {
      const trimmed = input.value.trim();
      if (trimmed !== input.value) input.value = trimmed;
    });

    const eye = h('button', {
      type: 'button',
      class: 'btn-icon btn-sm input-addon',
      'aria-pressed': String(revealed),
      'aria-controls': inputId,
      title: revealed ? t('options.providers.key.hide') : t('options.providers.key.show'),
      'aria-label': revealed ? t('options.providers.key.hide') : t('options.providers.key.show'),
      html: icon(revealed ? 'eye-off' : 'eye', { size: 16 }),
      dataset: { key: `p:${p.id}:reveal` },
    });
    eye.addEventListener('click', () => {
      const show = !ui.revealed.has(p.id);
      if (show) ui.revealed.add(p.id);
      else ui.revealed.delete(p.id);
      input.type = show ? 'text' : 'password';
      const label = show ? t('options.providers.key.hide') : t('options.providers.key.show');
      eye.title = label;
      eye.setAttribute('aria-label', label);
      eye.setAttribute('aria-pressed', String(show));
      eye.innerHTML = icon(show ? 'eye-off' : 'eye', { size: 16 });
    });

    const label = preset.requiresKey ? t('options.providers.key.label') : t('options.providers.key.labelOptional');
    return h('div', { class: 'pc-block' },
      h('label', { class: 'pc-label', htmlFor: inputId }, label),
      h('div', { class: 'pc-key-row' },
        h('div', { class: 'input-wrap' }, input, eye),
        preset.keyUrl
          ? externalLink(preset.keyUrl, preset.requiresKey ? t('options.providers.key.create') : t('options.providers.key.website'), { className: 'pc-key-link' })
          : null),
      h('div', { class: 'hint pc-key-hint', id: `${inputId}-hint` }, keyHintText(p, preset)));
  }

  function keyHintText(p, preset) {
    if (!preset.requiresKey) return t('options.providers.key.hintOptional');
    const host = hostnameOf(p.baseUrl);
    return host
      ? t('options.providers.key.hintHost', { host })
      : t('options.providers.key.hintProvider');
  }

  function onKeyInput(id, input) {
    const value = input.value.trim();
    const before = providerOf(id);
    if (!before) return;
    const autoEnable = Boolean(value) && !before.apiKey && !before.enabled;
    patchProvider(id, 'apiKey', (p) => {
      p.apiKey = value;
    });
    if (autoEnable) {
      patchProvider(id, 'enabled', (p) => {
        p.enabled = true;
      });
      ctx.announce(t('options.providers.announce.enabled', { name: before.name }));
    }
    if (value) input.removeAttribute('aria-invalid');
    ui.results.delete(id);
    refreshHead(id);
    const resultEl = cards.get(id)?.querySelector('.pc-result');
    if (resultEl) resultEl.remove();
  }

  function setEnabled(id, enabled) {
    patchProvider(id, 'enabled', (p) => {
      p.enabled = enabled;
    });
    const p = providerOf(id);
    if (enabled && p && needsKey(p)) {
      ui.expanded.add(id);
      refreshCard(id, { focus: `p:${id}:apiKey` });
      return;
    }
    if (enabled && p && shouldAutoLoadModels(p)) {
      // Local servers ship without models: fetch the list (and a default) right away and show the
      // result – including connection hints such as OLLAMA_ORIGINS – in the opened card.
      ui.expanded.add(id);
      if (!ui.busy.has(id)) {
        runLoad(id);
        return;
      }
    }
    refreshCard(id);
  }

  function toggleExpanded(id) {
    if (ui.expanded.has(id)) ui.expanded.delete(id);
    else ui.expanded.add(id);
    refreshCard(id);
  }

  // ---------------------------------------------------------------- test & model loading

  function buildActions(p, preset) {
    const busy = ui.busy.get(p.id);
    const noUrl = !p.baseUrl;
    const testBtn = button(t('options.providers.test.button'), {
      icon: 'bolt',
      size: 'sm',
      disabled: noUrl,
      title: noUrl ? t('options.providers.needBaseUrl') : t('options.providers.test.title'),
      dataset: { key: `p:${p.id}:test` },
      onClick: () => runTest(p.id),
    });
    const loadBtn = preset.supportsModelList ? button(t('options.providers.load.button'), {
      icon: 'refresh',
      size: 'sm',
      disabled: noUrl,
      title: noUrl ? t('options.providers.needBaseUrl') : t('options.providers.load.title'),
      dataset: { key: `p:${p.id}:load` },
      onClick: () => runLoad(p.id),
    }) : null;
    if (busy) {
      setBusy(testBtn, true, busy === 'test' ? t('options.providers.test.busy') : null);
      setBusy(loadBtn, true, busy === 'models' ? t('options.providers.load.busy') : null);
    }

    const result = ui.results.get(p.id);
    let resultEl = null;
    if (result) {
      const iconName = result.type === 'success' ? 'check' : result.type === 'error' ? 'alert' : 'info';
      resultEl = h('div', { class: ['pc-result', `is-${result.type}`] },
        h('span', { class: 'pc-result-icon', html: icon(iconName, { size: 16 }) }),
        h('span', { class: 'pc-result-text' }, result.text),
        result.models?.length ? button(t('options.providers.result.adopt'), {
          size: 'sm',
          className: 'pc-result-action',
          dataset: { key: `p:${p.id}:adopt` },
          onClick: () => applyModelList(p.id, result.models),
        }) : null,
        button(t('options.providers.result.close'), {
          icon: 'x',
          iconOnly: true,
          size: 'sm',
          className: 'pc-result-close',
          dataset: { key: `p:${p.id}:closeResult` },
          onClick: () => {
            ui.results.delete(p.id);
            refreshCard(p.id, { focus: `p:${p.id}:test` });
          },
        }));
    }
    return h('div', { class: 'pc-block' },
      h('div', { class: 'pc-actions' }, testBtn, loadBtn),
      resultEl);
  }

  async function runTest(id) {
    const p = providerOf(id);
    if (!p || ui.busy.has(id)) return;
    ui.busy.set(id, 'test');
    ui.results.delete(id);
    refreshCard(id);
    let result;
    try {
      result = await testConnection(llmProvider(p));
    } catch (err) {
      result = { ok: false, message: describeError(err) };
    }
    ui.busy.delete(id);
    ui.results.set(id, result.ok
      ? { type: 'success', text: result.message, models: result.models?.length ? result.models : null }
      : { type: 'error', text: result.message });
    refreshCard(id, { focus: document.activeElement === document.body ? `p:${id}:test` : null });
    ctx.announce(result.message);
  }

  async function runLoad(id, { quiet = false } = {}) {
    const p = providerOf(id);
    if (!p || ui.busy.has(id)) return;
    ui.busy.set(id, 'models');
    ui.results.delete(id);
    refreshCard(id);
    let message;
    try {
      const list = await listModels(llmProvider(p));
      ui.busy.delete(id);
      message = applyModelList(id, list, { silent: true });
    } catch (err) {
      ui.busy.delete(id);
      message = describeError(err);
      ui.results.set(id, { type: 'error', text: message });
      refreshCard(id, { focus: document.activeElement === document.body ? `p:${id}:load` : null });
      if (!quiet) ctx.announce(message);
      return;
    }
    refreshCard(id, { focus: document.activeElement === document.body ? `p:${id}:load` : null });
    if (!quiet) ctx.announce(message);
  }

  // Merges a fetched list into the provider; returns the summary text.
  function applyModelList(id, list, { silent = false } = {}) {
    const current = providerOf(id);
    if (!current) return '';
    const merged = mergeFetchedModels(current, list);
    patchProvider(id, 'models', (p) => {
      p.models = [...merged.models];
      p.imageModels = [...merged.imageModels];
      p.modelInfo = deepClone(merged.modelInfo);
      p.defaultModel = merged.defaultModel;
      p.defaultImageModel = merged.defaultImageModel;
    });
    const text = describeMerge(current, merged);
    const total = merged.stats.chat + merged.stats.image;
    ui.results.set(id, { type: total ? 'success' : 'info', text });
    if (!silent) {
      refreshCard(id, { focus: `p:${id}:test` });
      ctx.announce(text);
    }
    return text;
  }

  // ---------------------------------------------------------------- model lists

  function listOf(p, kind) {
    return kind === 'image' ? p.imageModels : p.models;
  }

  function defaultOf(p, kind) {
    return kind === 'image' ? p.defaultImageModel : p.defaultModel;
  }

  function buildModelBlock(p, kind) {
    const ids = listOf(p, kind);
    const isImage = kind === 'image';
    const selectId = `p-${p.id}-default-${kind}`;
    const countLabel = t('options.providers.models.count', { count: ids.length, n: formatNumber(ids.length) });
    const chips = buildChipList(p, kind);
    const filterKey = `${p.id}:${kind}`;
    const filter = ids.length > CHIP_LIMIT ? h('input', {
      class: 'input input-sm chip-filter',
      type: 'search',
      placeholder: t('options.providers.models.filterPlaceholder'),
      'aria-label': isImage ? t('options.providers.models.filterImage') : t('options.providers.models.filterChat'),
      value: ui.chipFilter.get(filterKey) || '',
      autocomplete: 'off',
      spellcheck: 'false',
      dataset: { key: `p:${p.id}:filter:${kind}` },
    }) : null;
    if (filter) {
      filter.addEventListener('input', () => {
        ui.chipFilter.set(filterKey, filter.value);
        const container = cards.get(p.id)?.querySelector(`[data-chips="${kind}"]`);
        const fresh = providerOf(p.id);
        if (container && fresh) container.replaceWith(buildChipList(fresh, kind));
      });
    }

    const addId = `p-${p.id}-add-${kind}`;
    const addInput = h('input', {
      class: 'input input-sm mono',
      id: addId,
      placeholder: isImage ? t('options.providers.models.addImagePlaceholder') : t('options.providers.models.addChatPlaceholder'),
      'aria-label': isImage ? t('options.providers.models.addImageLabel') : t('options.providers.models.addChatLabel'),
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      dataset: { key: `p:${p.id}:add:${kind}` },
    });
    const add = () => {
      const text = addInput.value;
      addInput.value = '';
      addModels(p.id, kind, text);
    };
    addInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        add();
      }
    });

    return h('div', { class: 'pc-block pc-models' },
      h('div', { class: 'pc-block-head' },
        h('h3', { class: 'pc-block-title' }, isImage ? t('options.providers.models.imageTitle') : t('options.providers.models.chatTitle')),
        h('span', { class: 'badge' }, countLabel),
        h('span', { class: 'spacer' }),
        filter),
      h('div', { class: 'pc-inline-field' },
        h('label', { class: 'pc-label', htmlFor: selectId }, isImage ? t('options.providers.models.defaultImage') : t('options.providers.models.defaultChat')),
        buildDefaultSelect(p, kind, selectId)),
      chips,
      h('div', { class: 'add-row' },
        addInput,
        button(t('options.providers.models.add'), {
          icon: 'plus',
          size: 'sm',
          dataset: { key: `p:${p.id}:addBtn:${kind}` },
          onClick: () => {
            add();
            focusKey(`p:${p.id}:add:${kind}`);
          },
        })));
  }

  function buildChipList(p, kind) {
    const ids = listOf(p, kind);
    const current = defaultOf(p, kind);
    const info = p.modelInfo || {};
    const filterKey = `${p.id}:${kind}`;
    const query = (ui.chipFilter.get(filterKey) || '').trim().toLowerCase();
    const filtered = query
      ? ids.filter((id) => id.toLowerCase().includes(query) || String(info[id]?.name || '').toLowerCase().includes(query))
      : ids;
    const showAll = ui.showAll.has(filterKey) || Boolean(query);
    const visible = showAll ? filtered : filtered.slice(0, CHIP_LIMIT);
    const container = h('div', { class: 'chip-list', dataset: { chips: kind }, role: 'list', 'aria-label': kind === 'image' ? t('options.providers.models.imageTitle') : t('options.providers.models.chatTitle') });

    if (!ids.length) {
      container.append(h('p', { class: 'hint chip-empty' }, kind === 'image'
        ? t('options.providers.models.emptyImage')
        : t('options.providers.models.emptyChat')));
      return container;
    }
    if (!filtered.length) {
      container.append(h('p', { class: 'hint chip-empty' }, t('options.providers.models.noMatch')));
      return container;
    }
    for (const id of visible) {
      const meta = info[id] || {};
      const isDefault = id === current;
      const title = [meta.name && meta.name !== id ? meta.name : '', meta.vision ? t('options.providers.models.visionShort') : '',
        meta.contextLength ? t('options.providers.models.context', { tokens: formatNumber(meta.contextLength) }) : '']
        .filter(Boolean).join(' · ');
      container.append(h('span', {
        class: ['chip', 'model-chip', isDefault && 'active'],
        role: 'listitem',
        title: title || id,
      },
      meta.vision && kind === 'chat' ? h('span', { class: 'chip-icon', html: icon('eye', { size: 12 }), title: t('options.providers.models.vision') }) : null,
      h('span', { class: 'chip-text' }, id),
      isDefault ? h('span', { class: 'chip-tag' }, t('options.providers.models.defaultTag')) : null,
      h('button', {
        type: 'button',
        title: t('options.providers.models.removeTitle', { model: id }),
        'aria-label': t('options.providers.models.removeLabel', { model: id }),
        html: icon('x', { size: 12 }),
        dataset: { key: `p:${p.id}:rm:${kind}:${id}` },
        onClick: () => removeModel(p.id, kind, id),
      })));
    }
    if (filtered.length > CHIP_LIMIT && !query) {
      container.append(h('button', {
        type: 'button',
        class: 'chip chip-more',
        dataset: { key: `p:${p.id}:more:${kind}` },
        onClick: () => {
          if (ui.showAll.has(filterKey)) ui.showAll.delete(filterKey);
          else ui.showAll.add(filterKey);
          refreshCard(p.id);
        },
      }, showAll ? t('options.providers.models.showLess') : t('options.providers.models.showAll', { count: filtered.length, n: formatNumber(filtered.length) })));
    }
    return container;
  }

  function buildDefaultSelect(p, kind, selectId) {
    const ids = listOf(p, kind);
    const current = defaultOf(p, kind);
    const info = p.modelInfo || {};
    const select = h('select', { class: 'select', id: selectId, dataset: { key: `p:${p.id}:default:${kind}` } });
    if (!current) {
      select.append(h('option', { value: '' }, ids.length ? t('options.providers.models.choose') : t('options.providers.models.noneYet')));
    }
    const all = current && !ids.includes(current) ? [current, ...ids] : ids;
    for (const id of all) {
      const name = info[id]?.name;
      select.append(h('option', { value: id }, name && name !== id ? `${id} – ${name}` : id));
    }
    select.append(h('option', { value: CUSTOM_VALUE }, t('options.providers.models.customOption')));
    select.value = current || '';
    select.addEventListener('change', async () => {
      if (select.value !== CUSTOM_VALUE) {
        setDefaultModel(p.id, kind, select.value);
        return;
      }
      const value = await promptDialog(kind === 'image' ? t('options.providers.models.customImageTitle') : t('options.providers.models.customChatTitle'), {
        message: t('options.providers.models.customMessage'),
        placeholder: t('options.providers.models.customPlaceholder', { example: kind === 'image' ? 'gpt-image-2' : 'gpt-6.1-sol' }),
        okText: t('options.providers.models.customOk'),
        cancelText: t('options.dialog.cancel'),
      });
      const id = value?.trim();
      if (!id) {
        select.value = current || '';
        return;
      }
      setDefaultModel(p.id, kind, id);
    });
    return select;
  }

  function setDefaultModel(id, kind, model) {
    patchProvider(id, `default-${kind}`, (p) => {
      const list = kind === 'image' ? p.imageModels : p.models;
      if (model && !list.includes(model)) list.unshift(model);
      if (kind === 'image') p.defaultImageModel = model;
      else p.defaultModel = model;
    });
    refreshCard(id);
  }

  function addModels(id, kind, text) {
    const ids = splitModelIds(text);
    if (!ids.length) return;
    const p = providerOf(id);
    if (!p) return;
    const existing = listOf(p, kind);
    const fresh = ids.filter((m) => !existing.includes(m));
    if (!fresh.length) {
      toast(ids.length === 1
        ? t('options.providers.models.alreadyOne', { model: ids[0] })
        : t('options.providers.models.alreadyMany'), { type: 'info' });
      return;
    }
    patchProvider(id, `add-${kind}-${fresh.join(',')}`, (x) => {
      const list = kind === 'image' ? x.imageModels : x.models;
      for (const m of fresh) if (!list.includes(m)) list.push(m);
      if (kind === 'image' && !x.defaultImageModel) x.defaultImageModel = fresh[0];
      if (kind === 'chat' && !x.defaultModel) x.defaultModel = fresh[0];
    });
    refreshCard(id, { focus: `p:${id}:add:${kind}` });
    ctx.announce(fresh.length === 1
      ? t('options.providers.models.addedOne', { model: fresh[0] })
      : t('options.providers.models.addedMany', { count: fresh.length }));
  }

  function removeModel(id, kind, model) {
    const p = providerOf(id);
    if (!p) return;
    const list = listOf(p, kind);
    const index = list.indexOf(model);
    const next = list[index + 1] ?? list[index - 1] ?? null;
    patchProvider(id, `rm-${kind}-${model}`, (x) => {
      if (kind === 'image') {
        x.imageModels = x.imageModels.filter((m) => m !== model);
        if (x.defaultImageModel === model) x.defaultImageModel = x.imageModels[0] ?? '';
      } else {
        x.models = x.models.filter((m) => m !== model);
        if (x.defaultModel === model) x.defaultModel = x.models[0] ?? '';
      }
    });
    refreshCard(id, { focus: next ? `p:${id}:rm:${kind}:${next}` : `p:${id}:add:${kind}`, fallback: `p:${id}:add:${kind}` });
    ctx.announce(t('options.providers.models.removed', { model }));
  }

  // ---------------------------------------------------------------- images

  function buildImageBlock(p) {
    const selectId = `p-${p.id}-imageApi`;
    if (p.protocol === 'anthropic') {
      return h('div', { class: 'pc-block' },
        h('h3', { class: 'pc-block-title' }, t('options.providers.images.title')),
        h('p', { class: 'hint' }, t('options.providers.images.anthropic')));
    }
    const select = h('select', { class: 'select', id: selectId, dataset: { key: `p:${p.id}:imageApi` } },
      imageApis().map((o) => h('option', { value: o.value }, o.label)));
    select.value = p.imageApi;
    select.addEventListener('change', () => {
      const value = select.value;
      patchProvider(p.id, 'imageApi', (x) => {
        x.imageApi = value;
      });
      refreshCard(p.id);
    });
    return h('div', { class: 'pc-block' },
      h('h3', { class: 'pc-block-title' }, t('options.providers.images.title')),
      h('div', { class: 'pc-inline-field' },
        h('label', { class: 'pc-label', htmlFor: selectId }, t('options.providers.images.api')),
        select),
      p.imageApi === 'none' ? null : buildModelBlock(p, 'image'));
  }

  // ---------------------------------------------------------------- advanced

  function buildAdvanced(p, preset) {
    const isCustom = p.presetId === 'custom';
    const details = h('details', { class: 'pc-advanced', open: ui.advanced.has(p.id) || null });
    details.addEventListener('toggle', () => {
      if (details.open) ui.advanced.add(p.id);
      else ui.advanced.delete(p.id);
    });
    const content = h('div', { class: 'pc-advanced-body' });
    details.append(
      h('summary', { dataset: { key: `p:${p.id}:advanced` } },
        h('span', { class: 'summary-chevron', html: icon('chevron-right', { size: 16 }) }),
        t('options.providers.advanced.title')),
      content);

    if (isCustom) content.append(buildNameField(p), buildProtocolField(p));
    content.append(buildBaseUrlField(p, preset), buildHeadersField(p));

    const links = [];
    if (preset.docsUrl) links.push(externalLink(preset.docsUrl, t('options.providers.advanced.docs')));
    const actions = h('div', { class: 'pc-danger-row' },
      ...links,
      h('span', { class: 'spacer' }),
      isCustom
        ? button(t('options.providers.delete.button'), { icon: 'trash', size: 'sm', variant: 'danger', dataset: { key: `p:${p.id}:delete` }, onClick: () => deleteProvider(p.id) })
        : button(t('options.providers.reset.button'), { icon: 'refresh', size: 'sm', dataset: { key: `p:${p.id}:reset` }, onClick: () => resetProvider(p.id) }));
    content.append(actions);
    return details;
  }

  function buildNameField(p) {
    const id = `p-${p.id}-name`;
    const input = h('input', { class: 'input', id, value: p.name, autocomplete: 'off', maxlength: 60, dataset: { key: `p:${p.id}:name` } });
    input.addEventListener('input', () => {
      const name = input.value.trim();
      if (!name) return;
      patchProvider(p.id, 'name', (x) => {
        x.name = name;
      });
      refreshHead(p.id);
    });
    input.addEventListener('blur', () => {
      if (!input.value.trim()) input.value = providerOf(p.id)?.name || '';
    });
    return h('div', { class: 'pc-field' }, h('label', { class: 'pc-label', htmlFor: id }, t('options.providers.field.name')), input);
  }

  function buildProtocolField(p) {
    const id = `p-${p.id}-protocol`;
    const select = h('select', { class: 'select', id, dataset: { key: `p:${p.id}:protocol` } },
      protocols().map((o) => h('option', { value: o.value }, o.label)));
    select.value = p.protocol;
    select.addEventListener('change', () => {
      const value = select.value;
      patchProvider(p.id, 'protocol', (x) => {
        x.protocol = value;
        if (value === 'anthropic') x.imageApi = 'none';
      });
      refreshCard(p.id);
    });
    return h('div', { class: 'pc-field' },
      h('label', { class: 'pc-label', htmlFor: id }, t('options.providers.field.protocol')),
      select,
      h('div', { class: 'hint' }, t('options.providers.field.protocolHint')));
  }

  function buildBaseUrlField(p, preset) {
    const id = `p-${p.id}-baseUrl`;
    const draftKey = `${p.id}:baseUrl`;
    const errorId = `${id}-err`;
    const input = h('input', {
      class: 'input mono',
      id,
      type: 'url',
      placeholder: preset.baseUrl || 'https://example.com/v1',
      autocomplete: 'off',
      spellcheck: 'false',
      dataset: { key: `p:${p.id}:baseUrl` },
      'aria-describedby': `${id}-hint ${errorId}`,
    });
    input.value = ui.drafts.has(draftKey) ? ui.drafts.get(draftKey) : p.baseUrl;
    const message = h('div', { class: 'field-error', id: errorId, hidden: true });
    const showValidation = (result) => {
      const text = result.ok ? (result.warning || '') : result.error;
      message.hidden = !text;
      message.textContent = text;
      message.classList.toggle('is-warning', result.ok);
      if (result.ok) input.removeAttribute('aria-invalid');
      else input.setAttribute('aria-invalid', 'true');
    };
    showValidation(validateBaseUrl(input.value));

    const options = Array.isArray(preset.baseUrlOptions) ? preset.baseUrlOptions : [];
    let endpointSelect = null;
    let noteEl = null;
    const currentOption = () => options.find((o) => o.url === providerOf(p.id)?.baseUrl) ?? null;
    if (options.length) {
      endpointSelect = h('select', { class: 'select', id: `${id}-preset`, dataset: { key: `p:${p.id}:endpoint` } },
        options.map((o, i) => h('option', { value: o.url }, presetText(`${endpointKey(preset, i)}.label`, o.label))),
        h('option', { value: '' }, t('options.providers.field.customUrl')));
      endpointSelect.value = currentOption()?.url ?? '';
      const noteIndex = options.indexOf(currentOption());
      const note = noteIndex >= 0 && options[noteIndex].note
        ? presetText(`${endpointKey(preset, noteIndex)}.note`, options[noteIndex].note)
        : '';
      noteEl = note ? callout('warning', 'alert', null, h('p', {}, note)) : null;
      endpointSelect.addEventListener('change', () => {
        const url = endpointSelect.value;
        if (!url) {
          focusKey(`p:${p.id}:baseUrl`, { select: true });
          return;
        }
        ui.drafts.delete(draftKey);
        ctx.setInvalid(`p:${p.id}:baseUrl`, false);
        patchProvider(p.id, 'baseUrl', (x) => {
          x.baseUrl = url;
        });
        refreshCard(p.id);
      });
    }

    input.addEventListener('input', () => {
      const result = validateBaseUrl(input.value);
      showValidation(result);
      if (!result.ok) {
        ui.drafts.set(draftKey, input.value);
        ctx.setInvalid(`p:${p.id}:baseUrl`, true);
        return;
      }
      ui.drafts.delete(draftKey);
      ctx.setInvalid(`p:${p.id}:baseUrl`, false);
      patchProvider(p.id, 'baseUrl', (x) => {
        x.baseUrl = result.value;
      });
      if (endpointSelect) {
        const match = options.find((o) => o.url === result.value);
        endpointSelect.value = match?.url ?? '';
      }
      refreshHead(p.id);
    });

    const hintParts = [];
    if (preset.baseUrl) hintParts.push(t('options.providers.field.baseUrlDefault', { url: preset.baseUrl }));
    else hintParts.push(t('options.providers.field.baseUrlHint'));
    return h('div', { class: 'pc-field' },
      options.length ? h('label', { class: 'pc-label', htmlFor: `${id}-preset` }, t('options.providers.field.endpoint')) : null,
      endpointSelect,
      noteEl,
      h('label', { class: 'pc-label', htmlFor: id }, t('options.providers.field.baseUrl')),
      input,
      message,
      h('div', { class: 'hint', id: `${id}-hint` }, hintParts.join(' ')));
  }

  function buildHeadersField(p) {
    const id = `p-${p.id}-headers`;
    const draftKey = `${p.id}:headers`;
    const errorId = `${id}-err`;
    const ta = textArea({
      id,
      key: `p:${p.id}:headers`,
      value: ui.drafts.has(draftKey) ? ui.drafts.get(draftKey) : headersToText(p.extraHeaders),
      rows: 3,
      max: 220,
      placeholder: t('options.providers.field.headersPlaceholder'),
      className: 'mono',
      spellcheck: 'false',
      'aria-describedby': `${id}-hint ${errorId}`,
    });
    const message = h('div', { class: 'field-error', id: errorId, hidden: true });
    ta.addEventListener('input', () => {
      const result = parseHeadersJson(ta.value);
      message.hidden = result.ok;
      message.textContent = result.ok ? '' : result.error;
      if (!result.ok) {
        ta.setAttribute('aria-invalid', 'true');
        ui.drafts.set(draftKey, ta.value);
        ctx.setInvalid(`p:${p.id}:headers`, true);
        return;
      }
      ta.removeAttribute('aria-invalid');
      ui.drafts.delete(draftKey);
      ctx.setInvalid(`p:${p.id}:headers`, false);
      patchProvider(p.id, 'headers', (x) => {
        x.extraHeaders = { ...result.value };
      });
    });
    if (ui.drafts.has(draftKey)) {
      const result = parseHeadersJson(ta.value);
      if (!result.ok) {
        message.hidden = false;
        message.textContent = result.error;
        ta.setAttribute('aria-invalid', 'true');
      }
    }
    return h('div', { class: 'pc-field' },
      h('label', { class: 'pc-label', htmlFor: id }, t('options.providers.field.headers')),
      ta,
      message,
      h('div', { class: 'hint', id: `${id}-hint` }, t('options.providers.field.headersHint')));
  }

  async function resetProvider(id) {
    const p = providerOf(id);
    if (!p) return;
    const ok = await confirmDialog(
      t('options.providers.reset.message'),
      { title: t('options.providers.reset.title', { name: p.name }), okText: t('options.providers.reset.ok'), cancelText: t('options.dialog.cancel') },
    );
    if (!ok) return;
    ctx.commit(`p:${id}:reset`, (s) => {
      const index = s.providers.findIndex((x) => x.id === id);
      if (index < 0) return;
      const old = s.providers[index];
      s.providers[index] = createProviderFromPreset(old.presetId, { apiKey: old.apiKey, enabled: old.enabled });
    });
    ui.drafts.delete(`${id}:baseUrl`);
    ui.drafts.delete(`${id}:headers`);
    ui.results.delete(id);
    ctx.setInvalid(`p:${id}:baseUrl`, false);
    ctx.setInvalid(`p:${id}:headers`, false);
    refreshCard(id, { focus: `p:${id}:reset` });
    toast(t('options.providers.reset.done', { name: p.name }), { type: 'success' });
  }

  async function deleteProvider(id) {
    const p = providerOf(id);
    if (!p) return;
    const ok = await confirmDialog(
      t('options.providers.delete.message'),
      { title: t('options.providers.delete.title', { name: p.name }), okText: t('options.providers.delete.ok'), cancelText: t('options.dialog.cancel'), danger: true },
    );
    if (!ok) return;
    ctx.commit(`p:${id}:delete`, (s) => {
      s.providers = s.providers.filter((x) => x.id !== id);
      for (const purpose of Object.keys(s.defaults || {})) {
        if (s.defaults[purpose]?.providerId === id) s.defaults[purpose] = null;
      }
    });
    for (const map of [ui.busy, ui.results]) map.delete(id);
    ui.expanded.delete(id);
    ui.drafts.delete(`${id}:baseUrl`);
    ui.drafts.delete(`${id}:headers`);
    ctx.setInvalid(`p:${id}:baseUrl`, false);
    ctx.setInvalid(`p:${id}:headers`, false);
    const card = cards.get(id);
    card?.remove();
    cards.delete(id);
    refreshSummary();
    applyFilter();
    focusKey('p:addCustom');
    toast(t('options.providers.delete.done', { name: p.name }), { type: 'success' });
  }

  // ---------------------------------------------------------------- custom providers

  async function addCustomProvider() {
    const nameInput = h('input', { class: 'input', id: 'cp-name', placeholder: t('options.providers.custom.namePlaceholder'), autocomplete: 'off', maxlength: 60 });
    const urlInput = h('input', {
      class: 'input mono', id: 'cp-url', type: 'url', placeholder: 'https://example.com/v1', autocomplete: 'off', spellcheck: 'false',
    });
    const protocolSelect = h('select', { class: 'select', id: 'cp-protocol' }, protocols().map((o) => h('option', { value: o.value }, o.label)));
    const keyInput = h('input', {
      class: 'input mono', id: 'cp-key', type: 'password', placeholder: t('options.providers.custom.keyPlaceholder'), autocomplete: 'off', spellcheck: 'false',
    });
    const urlMessage = h('div', { class: 'field-error', hidden: true });
    urlInput.addEventListener('input', () => {
      urlMessage.hidden = true;
      urlInput.removeAttribute('aria-invalid');
    });
    const content = h('div', { class: 'dialog-fields' },
      dialogField({ label: t('options.providers.field.name'), control: nameInput, id: 'cp-name' }),
      dialogField({ label: t('options.providers.field.baseUrl'), control: urlInput, id: 'cp-url', hint: t('options.providers.custom.urlHint') }),
      urlMessage,
      dialogField({ label: t('options.providers.field.protocol'), control: protocolSelect, id: 'cp-protocol' }),
      dialogField({ label: t('options.providers.key.label'), control: keyInput, id: 'cp-key', hint: t('options.providers.custom.keyHint') }));

    let created = null;
    const ok = await formDialog({
      title: t('options.providers.custom.add'),
      message: t('options.providers.custom.message'),
      content,
      okText: t('options.providers.models.add'),
      initialFocus: nameInput,
      canSubmit: () => Boolean(urlInput.value.trim()),
      onSubmit: () => {
        const result = validateBaseUrl(urlInput.value);
        if (!result.ok || !result.value) {
          urlInput.setAttribute('aria-invalid', 'true');
          urlInput.focus();
          return result.error || t('options.providers.custom.urlRequired');
        }
        created = createCustomProvider({
          name: nameInput.value,
          baseUrl: result.value,
          protocol: protocolSelect.value,
          apiKey: keyInput.value,
        });
        return true;
      },
    });
    if (!ok || !created) return;
    const provider = created;
    ui.expanded.add(provider.id);
    ui.query = '';
    ui.onlyActive = false;
    ctx.commit(`p:add:${provider.id}`, (s) => {
      if (!getProvider(s, provider.id)) s.providers.push(deepClone(provider));
    }, { refresh: true });
    const card = cards.get(provider.id);
    card?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    focusKey(`p:${provider.id}:toggle`);
    toast(t('options.providers.custom.added', { name: provider.name }), { type: 'success' });
    runLoad(provider.id, { quiet: true });
  }

  // ---------------------------------------------------------------- deep links (#anbieter/<id>)

  function onParam(param) {
    if (!param || !providerOf(param)) return;
    ui.expanded.add(param);
    resetFilter({ focus: false });
    refreshCard(param);
    requestAnimationFrame(() => cards.get(param)?.scrollIntoView({ block: 'start' }));
  }

  return {
    id: 'anbieter',
    deps: (s) => s.providers,
    render,
    onParam,
    badge: (s) => {
      const ready = s.providers.filter(isProviderUsable).length;
      return ready
        ? { text: formatNumber(ready), cls: 'nav-badge-success', title: t('options.providers.badge.ready', { count: ready }) }
        : { text: '!', cls: 'nav-badge-warning', title: t('options.providers.summary.none') };
    },
  };
}
