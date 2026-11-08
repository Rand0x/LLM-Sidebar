// "Kosten & Guthaben": remaining balance per provider (where the API offers it), usage statistics
// with costs per provider and model, prices for estimates and the side-panel display switch.

import { h, toast, confirmDialog } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { t, formatNumber, formatDate } from '../lib/i18n.js';
import { getPreset } from '../lib/providers.js';
import {
  fetchBalance, supportsBalance, canFetchBalance, balanceNeedsManagementKey, describeError,
} from '../lib/llm.js';
import {
  getUsageStats, onUsageChanged, clearUsageStats, statsRows, monthKey, automaticPriceFor,
  formatMoney, formatTokens,
} from '../lib/usage.js';
import {
  group, panel, button, externalLink, callout, numberInput, switchField, setBusy, formDialog, dialogField,
} from './dom.js';
import { isProviderUsable } from './models.js';

const LOCAL_PRESETS = new Set(['ollama', 'lmstudio']);
// Providers that report the cost of every request themselves (no price needed).
const REPORTS_COST = new Set(['openrouter']);
const BALANCE_MAX_AGE = 60 * 1000;
const PRICE_MAX = 100000;
// Date of the list prices in src/lib/providers.js (shown as "Listenpreis (Stand …)").
const LIST_PRICES_AS_OF = new Date(2026, 10, 3);
const XAI_MANAGEMENT_KEYS_URL = 'https://console.x.ai/team/default/management-keys';
const XAI_TEAM_SETTINGS_URL = 'https://console.x.ai/team/default/settings/team';

/** Translates `key` and replaces {name} placeholders with DOM nodes (e.g. links). */
function tNodes(key, nodes) {
  return t(key).split(/(\{\w+\})/).filter(Boolean).map((part) => {
    const match = /^\{(\w+)\}$/.exec(part);
    return match && nodes[match[1]] !== undefined ? nodes[match[1]] : part;
  });
}

/** Whole numbers (request and token counts) in the UI language. */
const count = (n) => formatNumber(Math.round(n || 0));

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return formatDate(new Date(y, m - 1, 1), { month: 'long', year: 'numeric' });
}

function previousMonthKey() {
  const d = new Date();
  return monthKey(new Date(d.getFullYear(), d.getMonth() - 1, 15).getTime());
}

function keySignature(provider) {
  const sig = (v) => {
    const key = String(v || '');
    return `${key.length}:${key.slice(-6)}`;
  };
  return `${provider.baseUrl}|${sig(provider.apiKey)}|${sig(provider.billing?.managementKey)}|${provider.billing?.teamId || ''}`;
}

function paidProviders(s) {
  return s.providers.filter((p) => isProviderUsable(p) && !LOCAL_PRESETS.has(p.presetId));
}

export function createCostsSection(ctx) {
  let stats = null;
  let period = monthKey();
  const balances = new Map(); // providerId → { sig, status: 'loading'|'ok'|'error', data?, error?, at }

  getUsageStats().then((value) => {
    stats = value;
    ctx.rerender();
  }).catch(() => {
    stats = null;
  });
  onUsageChanged((value) => {
    stats = value;
    ctx.rerender();
  });

  // ------------------------------------------------------------------------------------ balance

  async function loadBalance(provider) {
    const sig = keySignature(provider);
    balances.set(provider.id, { sig, status: 'loading', at: Date.now() });
    ctx.rerender();
    try {
      const data = await fetchBalance(provider);
      balances.set(provider.id, { sig, status: 'ok', data, at: Date.now() });
    } catch (err) {
      balances.set(provider.id, { sig, status: 'error', error: describeError(err), at: Date.now() });
    }
    ctx.rerender();
  }

  function refreshBalances({ force = false } = {}) {
    for (const provider of paidProviders(ctx.get())) {
      if (!canFetchBalance(provider)) continue;
      const entry = balances.get(provider.id);
      const fresh = entry && entry.sig === keySignature(provider) && Date.now() - entry.at < BALANCE_MAX_AGE;
      if (force || !fresh) loadBalance(provider);
    }
  }

  function avatar(provider) {
    const color = getPreset(provider.presetId).color || 'var(--accent)';
    return h('span', { class: 'cost-avatar', style: { background: color }, 'aria-hidden': 'true' },
      (provider.name || '?').trim().charAt(0).toUpperCase());
  }

  // xAI: management key (and optional team id) in a dialog, checked with a real request before saving.
  async function setupManagementKey(provider) {
    const keyInput = h('input', {
      class: 'input', id: 'mk-key', type: 'password', autocomplete: 'off', spellcheck: 'false',
      placeholder: provider.billing?.managementKey ? t('optionsSections.costs.mk.keyPlaceholderSaved') : 'xai-…',
    });
    const teamInput = h('input', {
      class: 'input', id: 'mk-team', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: t('optionsSections.costs.mk.teamPlaceholder'),
    });
    teamInput.value = provider.billing?.teamId || '';
    let result = null;
    const ok = await formDialog({
      title: t('optionsSections.costs.mk.title'),
      message: t('optionsSections.costs.mk.message'),
      content: h('div', { class: 'dialog-stack' },
        dialogField({
          label: t('optionsSections.costs.mk.keyLabel'),
          control: keyInput,
          id: 'mk-key',
          hint: h('span', {}, ...tNodes('optionsSections.costs.mk.keyHint', {
            link: externalLink(XAI_MANAGEMENT_KEYS_URL, t('optionsSections.costs.mk.keyLink')),
          })),
        }),
        dialogField({
          label: t('optionsSections.costs.mk.teamLabel'),
          control: teamInput,
          id: 'mk-team',
          hint: h('span', {}, ...tNodes('optionsSections.costs.mk.teamHint', {
            link: externalLink(XAI_TEAM_SETTINGS_URL, t('optionsSections.costs.mk.teamLink')),
          })),
        }),
        callout('warning', 'alert', t('optionsSections.costs.mk.warningTitle'),
          h('p', {}, t('optionsSections.costs.mk.warningText')))),
      okText: t('optionsSections.costs.mk.ok'),
      initialFocus: keyInput,
      canSubmit: () => Boolean(keyInput.value.trim() || provider.billing?.managementKey),
      onSubmit: async () => {
        const billing = {
          managementKey: keyInput.value.trim() || provider.billing?.managementKey || '',
          teamId: teamInput.value.trim(),
        };
        try {
          result = await fetchBalance({ ...provider, billing });
        } catch (err) {
          return describeError(err);
        }
        result.billing = { ...billing, teamId: billing.teamId || result.teamId || '' };
        return true;
      },
    });
    if (!ok || !result) return;
    const { billing } = result;
    ctx.commit(`billing:${provider.id}`, (x) => {
      const p = x.providers.find((item) => item.id === provider.id);
      if (p) p.billing = { ...billing };
    }, { refresh: true });
    balances.set(provider.id, { sig: keySignature({ ...provider, billing }), status: 'ok', data: result, at: Date.now() });
    ctx.rerender();
    toast(t('optionsSections.costs.mk.saved'), { type: 'success' });
  }

  async function removeManagementKey(provider) {
    const ok = await confirmDialog(t('optionsSections.costs.mk.removeConfirm'), {
      title: t('optionsSections.costs.mk.removeTitle'), okText: t('optionsSections.costs.mk.removeOk'), danger: true,
    });
    if (!ok) return;
    balances.delete(provider.id);
    ctx.commit(`billing:${provider.id}`, (x) => {
      const p = x.providers.find((item) => item.id === provider.id);
      if (p) p.billing = { managementKey: '', teamId: '' };
    }, { refresh: true });
  }

  function managementButtons(provider) {
    if (!balanceNeedsManagementKey(provider) || !provider.billing?.managementKey) return [];
    return [
      button(t('optionsSections.costs.mk.change'), {
        icon: 'settings', iconOnly: true, size: 'sm', variant: 'ghost', onClick: () => setupManagementKey(provider),
      }),
      button(t('optionsSections.costs.mk.remove'), {
        icon: 'trash', iconOnly: true, size: 'sm', variant: 'ghost', onClick: () => removeManagementKey(provider),
      }),
    ];
  }

  function balanceValue(provider) {
    const preset = getPreset(provider.presetId);
    const accountLink = preset.billingUrl ? externalLink(preset.billingUrl, t('optionsSections.costs.balance.viewInAccount')) : null;
    if (!supportsBalance(provider)) {
      return h('div', { class: 'balance-value' },
        h('span', { class: 'muted' }, t('optionsSections.costs.balance.notAvailable')),
        accountLink);
    }
    if (!canFetchBalance(provider) && balanceNeedsManagementKey(provider)) {
      return h('div', { class: 'balance-value' },
        h('span', { class: 'muted' }, t('optionsSections.costs.balance.needsManagementKey')),
        button(t('optionsSections.costs.balance.setup'), {
          size: 'sm', dataset: { key: `balance-setup:${provider.id}` }, onClick: () => setupManagementKey(provider),
        }),
        accountLink);
    }
    const entry = balances.get(provider.id);
    const current = entry && entry.sig === keySignature(provider) ? entry : null;
    const reload = button(t('optionsSections.costs.balance.reload'), {
      icon: 'refresh', iconOnly: true, size: 'sm', variant: 'ghost',
      dataset: { key: `balance:${provider.id}` },
      onClick: () => {
        if (balances.get(provider.id)?.status !== 'loading') loadBalance(provider);
      },
    });
    if (!current) {
      return h('div', { class: 'balance-value' },
        button(t('optionsSections.costs.balance.fetch'), { size: 'sm', dataset: { key: `balance:${provider.id}` }, onClick: () => loadBalance(provider) }),
        accountLink);
    }
    if (current.status === 'loading') {
      setBusy(reload, true);
      return h('div', { class: 'balance-value' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'muted' }, t('optionsSections.costs.balance.loading')), reload);
    }
    if (current.status === 'error') {
      return h('div', { class: 'balance-value balance-error' },
        h('span', {}, current.error), reload, ...managementButtons(provider));
    }
    const { balances: main, details, notes } = current.data;
    // Labels come from fetchBalance(); the plain "balance" label is not repeated below the amount.
    const genericLabels = new Set(['Guthaben', t('core.llm.balance.balance'), t('optionsSections.costs.balance.genericLabel')]);
    return h('div', { class: 'balance-result' },
      h('div', { class: 'balance-value' },
        ...main.map((b) => h('span', { class: 'balance-amount', title: b.label }, formatMoney(b.amount, b.currency))),
        main.length ? null : h('span', { class: 'muted' }, t('optionsSections.costs.balance.noValue')),
        reload,
        ...managementButtons(provider),
        accountLink),
      main.length > 1 || (main[0] && !genericLabels.has(main[0].label))
        ? h('div', { class: 'balance-detail' }, main.map((b) => b.label).join(' · '))
        : null,
      details.length
        ? h('div', { class: 'balance-detail' }, details.map((d) => `${d.label}: ${formatMoney(d.amount, d.currency)}`).join(' · '))
        : null,
      ...notes.map((n) => h('div', { class: 'balance-detail' }, n)));
  }

  function balanceGroup(s) {
    const providers = paidProviders(s);
    const body = providers.length
      ? panel(...providers.map((p) => h('div', { class: 'cost-row' },
        h('div', { class: 'cost-row-name' }, avatar(p), h('span', { class: 'truncate' }, p.name)),
        balanceValue(p))))
      : h('div', { class: 'empty-state' },
        h('span', { class: 'empty-icon', html: icon('wallet', { size: 28 }) }),
        h('p', {}, t('optionsSections.costs.balance.empty')),
        button(t('optionsSections.costs.goProviders'), { size: 'sm', onClick: () => ctx.navigate('anbieter') }));
    return group({
      title: t('optionsSections.costs.balance.title'),
      description: t('optionsSections.costs.balance.desc'),
      actions: providers.some((p) => canFetchBalance(p))
        ? button(t('optionsSections.costs.balance.refreshAll'), { icon: 'refresh', size: 'sm', onClick: () => refreshBalances({ force: true }) })
        : null,
    }, body);
  }

  // ------------------------------------------------------------------------------------ usage

  function periodOptions() {
    const current = monthKey();
    const previous = previousMonthKey();
    const keys = new Set([current, ...Object.keys(stats?.months ?? {})]);
    const months = [...keys].sort().reverse();
    const options = months.map((key) => ({
      value: key,
      label: key === current
        ? t('optionsSections.costs.period.thisMonth', { month: monthLabel(key) })
        : key === previous
          ? t('optionsSections.costs.period.lastMonth', { month: monthLabel(key) })
          : monthLabel(key),
    }));
    options.push({ value: 'all', label: t('optionsSections.costs.period.all') });
    return options;
  }

  function costText(row) {
    if (!row.requests) return '–';
    if (row.cost === 0 && row.unpriced === row.requests) return t('optionsSections.costs.cost.unknown');
    return `${row.estimated ? '≈ ' : ''}${formatMoney(row.cost)}${row.unpriced ? ' +?' : ''}`;
  }

  function tile(label, value, hint = null) {
    return h('div', { class: 'cost-tile' },
      h('div', { class: 'cost-tile-label' }, label),
      h('div', { class: 'cost-tile-value' }, value),
      hint ? h('div', { class: 'cost-tile-hint' }, hint) : null);
  }

  function usageGroup() {
    const options = periodOptions();
    if (!options.some((o) => o.value === period)) period = monthKey();
    const select = h('select', {
      class: 'select select-sm',
      'aria-label': t('optionsSections.costs.period.label'),
      dataset: { key: 'usage-period' },
      onChange: (event) => {
        period = event.target.value;
        ctx.rerender();
      },
    }, options.map((o) => h('option', { value: o.value, selected: o.value === period }, o.label)));
    const reset = button(t('optionsSections.costs.usage.reset'), {
      icon: 'trash', size: 'sm', variant: 'ghost',
      onClick: async () => {
        const ok = await confirmDialog(t('optionsSections.costs.usage.resetConfirm'), {
          title: t('optionsSections.costs.usage.resetTitle'), okText: t('optionsSections.costs.usage.resetOk'), danger: true,
        });
        if (!ok) return;
        try {
          await clearUsageStats();
          toast(t('optionsSections.costs.usage.resetDone'), { type: 'success' });
        } catch (err) {
          toast(err?.message || t('optionsSections.costs.usage.resetFailed'), { type: 'error' });
        }
      },
    });

    let body;
    if (!stats) {
      body = h('div', { class: 'empty-state' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', {}, t('optionsSections.costs.usage.loading')));
    } else {
      const { rows, total } = statsRows(stats, period);
      if (!rows.length) {
        body = h('div', { class: 'empty-state' },
          h('span', { class: 'empty-icon', html: icon('wallet', { size: 28 }) }),
          h('p', {}, t('optionsSections.costs.usage.empty')));
      } else {
        const tokens = total.inputTokens + total.outputTokens;
        body = h('div', { class: 'cost-usage' },
          h('div', { class: 'cost-tiles' },
            tile(t('optionsSections.costs.tile.cost'), costText(total), total.unpriced
              ? t('optionsSections.costs.tile.unpriced', { count: total.unpriced, n: count(total.unpriced) })
              : null),
            tile(t('optionsSections.costs.tile.requests'), count(total.requests)),
            tile(t('optionsSections.costs.tile.tokens'), formatTokens(tokens), t('optionsSections.costs.tile.tokensHint', {
              input: formatTokens(total.inputTokens), output: formatTokens(total.outputTokens),
            }))),
          h('div', { class: 'table-wrap' },
            h('table', { class: 'cost-table' },
              h('thead', {}, h('tr', {},
                h('th', { scope: 'col' }, t('optionsSections.costs.table.model')),
                h('th', { scope: 'col', class: 'num' }, t('optionsSections.costs.table.requests')),
                h('th', { scope: 'col', class: 'num' }, t('optionsSections.costs.table.input')),
                h('th', { scope: 'col', class: 'num' }, t('optionsSections.costs.table.output')),
                h('th', { scope: 'col', class: 'num' }, t('optionsSections.costs.table.cost')))),
              h('tbody', {}, rows.map((row) => h('tr', {},
                h('td', {},
                  h('div', { class: 'cost-model' }, row.model || '–'),
                  h('div', { class: 'cost-provider' }, row.providerName)),
                h('td', { class: 'num' }, count(row.requests)),
                h('td', { class: 'num', title: t('optionsSections.costs.table.tokens', { n: count(row.inputTokens) }) }, formatTokens(row.inputTokens)),
                h('td', { class: 'num', title: t('optionsSections.costs.table.tokens', { n: count(row.outputTokens) }) }, formatTokens(row.outputTokens)),
                h('td', { class: 'num' }, costText(row))))))),
          h('p', { class: 'hint' }, [
            t('optionsSections.costs.usage.legend'),
            t('optionsSections.costs.usage.since', { date: formatDate(stats.since) }),
            t('optionsSections.costs.usage.binding'),
          ].join(' ')));
      }
    }
    return group({
      title: t('optionsSections.costs.usage.title'),
      description: t('optionsSections.costs.usage.desc'),
      actions: [select, reset],
    }, body);
  }

  // ------------------------------------------------------------------------------------ prices

  function modelsForPrices(provider) {
    const ids = [];
    const add = (id) => {
      const v = String(id || '').trim();
      if (v && !ids.includes(v)) ids.push(v);
    };
    add(provider.defaultModel);
    for (const id of Object.keys(provider.prices || {})) add(id);
    for (const bucket of Object.values(stats?.months ?? {})) {
      for (const entry of Object.values(bucket)) if (entry.providerId === provider.id) add(entry.model);
    }
    return ids.filter((id) => !provider.modelInfo?.[id]?.imageOutput && !(provider.imageModels || []).includes(id));
  }

  function priceInput(provider, model, field) {
    const own = provider.prices?.[model]?.[field] ?? null;
    const auto = automaticPriceFor(provider, model);
    const autoValue = auto?.[field];
    const key = `price:${provider.id}:${model}:${field}`;
    const { el } = numberInput({
      id: `price-${provider.id}-${model}-${field}`.replace(/[^\w-]/g, '_'),
      key,
      value: own,
      min: 0,
      max: PRICE_MAX,
      integer: false,
      decimal: true,
      allowEmpty: true,
      placeholder: autoValue !== null && autoValue !== undefined
        ? formatNumber(autoValue, { useGrouping: false, maximumFractionDigits: 10 })
        : '–',
      unit: '$',
      setInvalid: ctx.setInvalid,
      onValue: (value) => {
        ctx.commit(key, (x) => {
          const p = x.providers.find((item) => item.id === provider.id);
          if (!p) return;
          if (!p.prices || typeof p.prices !== 'object') p.prices = {};
          const next = { input: null, output: null, ...(p.prices[model] || {}), [field]: value };
          if (next.input === null && next.output === null) delete p.prices[model];
          else p.prices[model] = next;
        }, { refresh: true }); // updates the "eigener Preis" label (focus and caret are kept)
      },
    });
    el.querySelector('input')?.setAttribute('aria-label', field === 'input'
      ? t('optionsSections.costs.prices.inputLabel', { model })
      : t('optionsSections.costs.prices.outputLabel', { model }));
    return el;
  }

  function sourceLabel(provider, model) {
    const own = provider.prices?.[model];
    if (own && (own.input !== null || own.output !== null)) return t('optionsSections.costs.prices.sourceOwn');
    const auto = automaticPriceFor(provider, model);
    if (!auto) return t('optionsSections.costs.prices.sourceNone');
    return auto.source === 'api'
      ? t('optionsSections.costs.prices.sourceApi')
      : t('optionsSections.costs.prices.sourceList', { date: formatDate(LIST_PRICES_AS_OF) });
  }

  function pricesGroup(s) {
    const providers = paidProviders(s).filter((p) => !REPORTS_COST.has(p.presetId));
    const blocks = [];
    for (const provider of providers) {
      const models = modelsForPrices(provider);
      if (!models.length) continue;
      blocks.push(h('div', { class: 'price-block' },
        h('div', { class: 'price-block-head' }, avatar(provider), h('span', {}, provider.name)),
        h('div', { class: 'price-head', 'aria-hidden': 'true' },
          h('span', {}, t('optionsSections.costs.prices.model')),
          h('span', {}, t('optionsSections.costs.prices.input')),
          h('span', {}, t('optionsSections.costs.prices.output'))),
        ...models.map((model) => h('div', { class: 'price-row' },
          h('div', { class: 'price-model' },
            h('div', { class: 'cost-model' }, model),
            h('div', { class: 'cost-provider' }, sourceLabel(provider, model))),
          priceInput(provider, model, 'input'),
          priceInput(provider, model, 'output')))));
    }
    return group({
      title: t('optionsSections.costs.prices.title'),
      description: t('optionsSections.costs.prices.desc'),
    }, blocks.length
      ? panel(...blocks)
      : h('p', { class: 'hint' }, t('optionsSections.costs.prices.empty')));
  }

  // ------------------------------------------------------------------------------------ render

  function render(s) {
    return h('div', { class: 'section-body' },
      balanceGroup(s),
      usageGroup(),
      pricesGroup(s),
      group({ title: t('optionsSections.costs.display.title') },
        panel(switchField({
          label: t('optionsSections.costs.display.showInChat.label'),
          hint: t('optionsSections.costs.display.showInChat.hint'),
          checked: s.usage.showInChat,
          key: 'usage.showInChat',
          onChange: (checked) => ctx.commit('usage.showInChat', (x) => { x.usage.showInChat = checked; }),
        }))),
      callout('info', 'info', t('optionsSections.costs.accuracy.title'),
        h('p', {}, t('optionsSections.costs.accuracy.text'))));
  }

  return {
    id: 'kosten',
    deps: (s) => ({
      providers: paidProviders(s).map((p) => [p.id, p.name, p.presetId, keySignature(p), p.defaultModel, p.prices, p.imageModels,
        Object.fromEntries(Object.entries(p.modelInfo || {}).filter(([, i]) => i.inputPrice !== undefined || i.imageOutput))]),
      show: s.usage.showInChat,
    }),
    render,
    onShow: () => refreshBalances(),
  };
}
