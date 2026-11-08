// "Übersetzung & Toolbar": target language, page-translation batching, selection toolbar.

import { h } from '../lib/ui.js';
import { t, formatNumber } from '../lib/i18n.js';
import {
  AUTO_TARGET, languageOptions, normalizeTargetLanguage, findTargetLanguage,
} from '../lib/languages.js';
import {
  group, panel, field, switchField, numberInput, textArea,
} from './dom.js';

const OTHER = '__other__';

function parseHosts(text) {
  return String(text ?? '').split(/[\n,;]+/).map((line) => line.trim()).filter(Boolean);
}

/** Translates `key` and replaces {name} placeholders with DOM nodes (e.g. links). */
function tNodes(key, nodes) {
  return t(key).split(/(\{\w+\})/).filter(Boolean).map((part) => {
    const match = /^\{(\w+)\}$/.exec(part);
    return match && nodes[match[1]] !== undefined ? nodes[match[1]] : part;
  });
}

function languageSelect(id, key, current, extra = null) {
  return h('select', { class: 'select', id, dataset: { key } },
    languageOptions({ current, includeAuto: true }).map((o) => h('option', { value: o.value }, o.label)),
    extra);
}

export function createTranslateSection(ctx) {
  const ui = { otherMode: false, otherDraft: '' };

  function render(s) {
    return h('div', { class: 'section-body' },
      group({ title: t('optionsSections.translate.group.title') }, panel(
        languageField(s),
        batchField(s),
        concurrencyField(s))),
      h('p', { class: 'hint section-foot' },
        ...tNodes('optionsSections.translate.foot.text', {
          defaultsLink: h('a', { href: '#standardmodelle' }, t('optionsSections.translate.foot.defaultsLink')),
          aboutLink: h('a', { href: '#ueber' }, t('optionsSections.translate.foot.aboutLink')),
        })),
      group({ title: t('optionsSections.translate.youtube.title'), description: t('optionsSections.translate.youtube.desc') }, panel(
        videoLangField(s))),
      group({ title: t('optionsSections.translate.toolbar.title'), description: t('optionsSections.translate.toolbar.desc') }, panel(
        switchField({
          label: t('optionsSections.translate.toolbar.enabled.label'),
          hint: t('optionsSections.translate.toolbar.enabled.hint'),
          checked: s.toolbar.enabled,
          key: 'tb:enabled',
          onChange: (v) => ctx.commit('toolbar.enabled', (x) => { x.toolbar.enabled = v; }, { refresh: true }),
        }),
        hostsField(s))));
  }

  // Stored value: a language code, 'auto' (= UI language) or free text (see lib/languages.js).
  // Free text appears as its own option; "Andere …" opens the input for a new one.
  function languageField(s) {
    const id = 'tr-lang';
    const current = normalizeTargetLanguage(s.translate.targetLang);
    const known = current === AUTO_TARGET || Boolean(findTargetLanguage(current));
    const select = languageSelect(id, 'tr:lang', current,
      h('option', { value: OTHER }, t('optionsSections.translate.lang.other')));
    select.value = ui.otherMode ? OTHER : current;

    const otherId = 'tr-lang-other';
    const otherInput = h('input', {
      class: 'input',
      id: otherId,
      placeholder: t('optionsSections.translate.lang.otherPlaceholder'),
      'aria-label': t('optionsSections.translate.lang.otherLabel'),
      autocomplete: 'off',
      maxlength: 60,
      hidden: !ui.otherMode,
      dataset: { key: 'tr:langOther' },
    });
    otherInput.value = known ? ui.otherDraft : current;
    const error = h('div', { class: 'field-error', hidden: true }, t('optionsSections.translate.lang.otherRequired'));

    select.addEventListener('change', () => {
      if (select.value === OTHER) {
        ui.otherMode = true;
        otherInput.hidden = false;
        otherInput.focus();
        if (otherInput.value.trim()) commitLang(otherInput.value.trim());
        return;
      }
      ui.otherMode = false;
      otherInput.hidden = true;
      error.hidden = true;
      ctx.setInvalid('tr:langOther', false);
      commitLang(select.value);
    });
    otherInput.addEventListener('input', () => {
      const value = otherInput.value.trim();
      ui.otherDraft = otherInput.value;
      error.hidden = Boolean(value);
      if (value) otherInput.removeAttribute('aria-invalid');
      else otherInput.setAttribute('aria-invalid', 'true');
      ctx.setInvalid('tr:langOther', !value);
      if (value) commitLang(value);
    });

    return field({
      label: t('optionsSections.translate.lang.label'),
      hint: t('optionsSections.translate.lang.hint'),
      control: h('div', { class: 'stack-sm' }, select, otherInput, error),
      controlId: id,
    });
  }

  function videoLangField(s) {
    const id = 'yt-lang';
    const current = normalizeTargetLanguage(s.youtube?.summaryLang, AUTO_TARGET);
    const select = languageSelect(id, 'yt:lang', current);
    select.value = current;
    select.addEventListener('change', () => {
      const value = select.value;
      ctx.commit('youtube.summaryLang', (x) => {
        x.youtube = { ...(x.youtube || {}), summaryLang: value };
      });
    });
    return field({
      label: t('optionsSections.translate.videoLang.label'),
      hint: t('optionsSections.translate.videoLang.hint'),
      control: select,
      controlId: id,
    });
  }

  function commitLang(lang) {
    ctx.commit('translate.targetLang', (x) => { x.translate.targetLang = lang; });
  }

  function batchField(s) {
    const id = 'tr-batch';
    const { el } = numberInput({
      id,
      key: 'tr:batch',
      value: s.translate.batchChars,
      min: 500,
      max: 20000,
      step: 500,
      unit: t('optionsSections.translate.batch.unit'),
      setInvalid: ctx.setInvalid,
      onValue: (v) => ctx.commit('translate.batchChars', (x) => { x.translate.batchChars = v; }),
    });
    return field({
      label: t('optionsSections.translate.batch.label'),
      hint: t('optionsSections.translate.batch.hint'),
      control: el,
      controlId: id,
    });
  }

  function concurrencyField(s) {
    const id = 'tr-concurrency';
    const { el } = numberInput({
      id,
      key: 'tr:concurrency',
      value: s.translate.concurrency,
      min: 1,
      max: 10,
      step: 1,
      unit: t('optionsSections.translate.concurrency.unit'),
      setInvalid: ctx.setInvalid,
      onValue: (v) => ctx.commit('translate.concurrency', (x) => { x.translate.concurrency = v; }),
    });
    return field({
      label: t('optionsSections.translate.concurrency.label'),
      hint: t('optionsSections.translate.concurrency.hint'),
      control: el,
      controlId: id,
    });
  }

  function hostsField(s) {
    const id = 'tb-hosts';
    const count = h('span', { class: 'hint' });
    const updateCount = (n) => {
      count.textContent = n
        ? t('optionsSections.translate.hosts.count', { count: n, n: formatNumber(n) })
        : t('optionsSections.translate.hosts.none');
    };
    updateCount(s.toolbar.disabledHosts.length);
    const ta = textArea({
      id,
      key: 'tb:hosts',
      value: s.toolbar.disabledHosts.join('\n'),
      rows: 4,
      max: 260,
      className: 'mono',
      spellcheck: 'false',
      placeholder: 'docs.google.com\nmail.example.com',
      onInput: (value) => {
        const hosts = parseHosts(value);
        ctx.commit('toolbar.disabledHosts', (x) => { x.toolbar.disabledHosts = hosts; });
        updateCount(ctx.get().toolbar.disabledHosts.length);
      },
    });
    ta.addEventListener('blur', () => {
      const normalized = ctx.get().toolbar.disabledHosts.join('\n');
      if (ta.value.trim() !== normalized) {
        ta.value = normalized;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    return field({
      label: t('optionsSections.translate.hosts.label'),
      hint: t('optionsSections.translate.hosts.hint'),
      control: ta,
      controlId: id,
      stacked: true,
      extra: count,
    });
  }

  return {
    id: 'uebersetzung',
    deps: (s) => [s.translate, s.youtube, s.toolbar],
    render,
  };
}
