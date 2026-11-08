// "Standardmodelle": default target per purpose (chat, quick actions, translation, images).

import { h } from '../lib/ui.js';
import {
  listChatModels, listImageModels, resolveTarget, getProvider, isProviderReady, getReadyProviders,
} from '../lib/settings.js';
import { t } from '../lib/i18n.js';
import { button, callout, group, panel, field } from './dom.js';

const STALE = '__stale__';

const PURPOSE_IDS = ['chat', 'actions', 'translate', 'image'];

/** Purposes with their (translated) texts – a function, because t() needs the active language. */
function purposes() {
  return PURPOSE_IDS.map((id) => ({
    id,
    label: t(`optionsSections.defaults.purpose.${id}.label`),
    hint: t(`optionsSections.defaults.purpose.${id}.hint`),
    auto: t(`optionsSections.defaults.purpose.${id}.auto`),
    image: id === 'image',
  }));
}

function withoutDefault(settings, purpose) {
  return { ...settings, defaults: { ...settings.defaults, [purpose]: null } };
}

function targetLabel(target) {
  return target ? `${target.provider.name} · ${target.model}` : '';
}

export function createDefaultsSection(ctx) {
  function render(s) {
    const chatOptions = listChatModels(s);
    const imageOptions = listImageModels(s);
    const ready = getReadyProviders(s);
    const body = h('div', { class: 'section-body' });

    if (!chatOptions.length && !imageOptions.length) {
      body.append(callout('warning', 'alert', ready.length
        ? t('optionsSections.defaults.empty.noModelTitle')
        : t('optionsSections.defaults.empty.noProviderTitle'),
      h('p', {}, ready.length
        ? t('optionsSections.defaults.empty.noModelText')
        : t('optionsSections.defaults.empty.noProviderText')),
      h('p', {}, button(t('optionsSections.defaults.goProviders'), {
        icon: 'arrow-right', size: 'sm', dataset: { key: 'def:goProviders' }, onClick: () => ctx.navigate('anbieter'),
      }))));
    }

    body.append(group({ title: t('optionsSections.defaults.group.title'), description: t('optionsSections.defaults.group.desc') },
      panel(...purposes().map((purpose) => purposeField(s, purpose, purpose.image ? imageOptions : chatOptions)))));

    if (!imageOptions.length) {
      body.append(h('p', { class: 'hint section-foot' }, t('optionsSections.defaults.imageHint')));
    }
    return body;
  }

  function purposeField(s, purpose, options) {
    const id = `def-${purpose.id}`;
    const current = s.defaults?.[purpose.id] ?? null;
    const auto = resolveTarget(withoutDefault(s, purpose.id), purpose.id);
    const effective = resolveTarget(s, purpose.id);
    const select = h('select', { class: 'select', id, dataset: { key: `def:${purpose.id}` } });
    select.append(h('option', { value: '' }, auto
      ? t('optionsSections.defaults.option.autoWith', { target: targetLabel(auto) })
      : t('optionsSections.defaults.option.auto')));

    // Options grouped by provider; values are indexes into `entries`.
    const entries = [...options];
    let selected = '';
    let stale = null;
    if (current) {
      const provider = getProvider(s, current.providerId);
      const fallbackModel = purpose.image
        ? provider?.defaultImageModel || provider?.imageModels?.[0] || ''
        : provider?.defaultModel || provider?.models?.[0] || '';
      const model = current.model || fallbackModel;
      const usable = provider && isProviderReady(provider) && (!purpose.image || provider.imageApi !== 'none');
      let index = entries.findIndex((o) => o.providerId === current.providerId && o.model === model);
      if (index < 0 && usable && model) {
        entries.push({ providerId: provider.id, providerName: provider.name, model, label: `${provider.name} · ${model}` });
        index = entries.length - 1;
      }
      if (index >= 0) selected = String(index);
      else stale = { name: provider?.name || current.providerId, model: model || t('optionsSections.defaults.option.defaultModel'), provider };
    }

    const groups = new Map();
    entries.forEach((entry, index) => {
      if (!groups.has(entry.providerId)) groups.set(entry.providerId, h('optgroup', { label: entry.providerName }));
      groups.get(entry.providerId).append(h('option', { value: String(index) }, entry.model));
    });
    select.append(...groups.values());
    if (stale) {
      select.append(h('option', { value: STALE }, t('optionsSections.defaults.option.unavailable', { name: stale.name, model: stale.model })));
      selected = STALE;
      select.setAttribute('aria-invalid', 'true');
    }
    select.value = selected;

    select.addEventListener('change', () => {
      const value = select.value;
      if (value === STALE) return;
      const entry = value === '' ? null : entries[Number(value)];
      const next = entry ? { providerId: entry.providerId, model: entry.model } : null;
      ctx.commit(`def:${purpose.id}`, (x) => {
        x.defaults = x.defaults || {};
        x.defaults[purpose.id] = next ? { ...next } : null;
      }, { refresh: true });
    });

    let status;
    if (stale) {
      const reason = !stale.provider
        ? t('optionsSections.defaults.status.providerGone')
        : !isProviderReady(stale.provider)
          ? t('optionsSections.defaults.status.notReady', { name: stale.name })
          : t('optionsSections.defaults.status.noImages', { name: stale.name });
      const fallback = effective
        ? t('optionsSections.defaults.status.fallback', { target: targetLabel(effective) })
        : t('optionsSections.defaults.status.noFallback');
      status = h('div', { class: 'def-status is-warning' }, `${reason} ${fallback}`);
    } else if (!current) {
      const now = auto
        ? t('optionsSections.defaults.status.current', { target: targetLabel(auto) })
        : t('optionsSections.defaults.status.none');
      status = h('div', { class: 'def-status' }, `${purpose.auto} ${now}`);
    } else {
      status = h('div', { class: 'def-status is-active' }, t('optionsSections.defaults.status.active', { target: targetLabel(effective) }));
    }
    return field({ label: purpose.label, hint: purpose.hint, control: select, controlId: id, extra: status, className: 'field-wide-control' });
  }

  return {
    id: 'standardmodelle',
    deps: (s) => [s.defaults, s.providers.map((p) => [
      p.id, p.name, p.enabled, Boolean(p.apiKey), p.baseUrl, p.models, p.defaultModel, p.imageApi, p.imageModels, p.defaultImageModel,
    ])],
    render,
  };
}
