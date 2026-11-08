// "Darstellung": UI language and theme choice with live preview.

import { h } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { applyTheme } from '../lib/utils.js';
import { t, getLanguage, UI_LANGUAGES, AUTO_LANGUAGE } from '../lib/i18n.js';
import { group, panel, field } from './dom.js';

const THEMES = [
  { value: 'system', key: 'system', icon: 'monitor' },
  { value: 'light', key: 'light', icon: 'sun' },
  { value: 'dark', key: 'dark', icon: 'moon' },
];

function miniPreview(kind) {
  return h('span', { class: ['theme-thumb', `theme-thumb-${kind}`], 'aria-hidden': 'true' },
    h('span', { class: 'tt-side' }),
    h('span', { class: 'tt-main' },
      h('span', { class: 'tt-bubble tt-bubble-user' }),
      h('span', { class: 'tt-bubble' }),
      h('span', { class: 'tt-bubble tt-bubble-short' })));
}

export function createAppearanceSection(ctx) {
  function languageGroup(s) {
    const id = 'appearance-language';
    const select = h('select', { class: 'select', id, dataset: { key: 'appearance:language' } },
      h('option', { value: AUTO_LANGUAGE }, t('common.uiLanguage.auto')),
      UI_LANGUAGES.map((lang) => h('option', { value: lang.code, lang: lang.code }, lang.name)));
    select.value = s.general.language || AUTO_LANGUAGE;
    select.addEventListener('change', () => {
      const value = select.value;
      // The options page saves and reloads itself when general.language changes (options.js).
      ctx.commit('general.language', (x) => { x.general.language = value; }, { refresh: true });
    });
    // Keep the English word next to the title so the setting is easy to find in any language.
    const title = getLanguage() === 'en'
      ? t('options.appearance.language.title')
      : `${t('options.appearance.language.title')} · Language`;
    return group({ title, description: t('options.appearance.language.description') },
      panel(field({
        label: t('options.appearance.language.label'),
        hint: t('options.appearance.language.hint'),
        control: select,
        controlId: id,
      })));
  }

  function render(s) {
    const current = s.general.theme;
    const options = THEMES.map((theme) => {
      const id = `theme-${theme.value}`;
      const input = h('input', {
        type: 'radio',
        name: 'theme',
        id,
        value: theme.value,
        class: 'theme-radio',
        checked: current === theme.value,
        dataset: { key: `theme:${theme.value}` },
      });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        applyTheme(theme.value);
        ctx.commit('general.theme', (x) => { x.general.theme = theme.value; }, { refresh: true });
      });
      return h('label', { class: 'theme-option', htmlFor: id },
        input,
        miniPreview(theme.value),
        h('span', { class: 'theme-label' },
          h('span', { class: 'theme-icon', html: icon(theme.icon, { size: 16 }) }),
          t(`options.appearance.theme.${theme.key}.label`)),
        h('span', { class: 'theme-hint' }, t(`options.appearance.theme.${theme.key}.hint`)));
    });

    return h('div', { class: 'section-body' },
      languageGroup(s),
      group({ title: t('options.appearance.theme.title'), description: t('options.appearance.theme.description') },
        h('fieldset', { class: 'theme-options' },
          h('legend', { class: 'sr-only' }, t('options.appearance.theme.title')),
          options)),
      group({ title: t('options.appearance.preview.title') }, preview()));
  }

  function preview() {
    return h('div', { class: 'preview card', 'aria-hidden': 'true' },
      h('div', { class: 'preview-head' },
        h('span', { class: 'preview-title' }, t('options.appearance.preview.chatTitle')),
        h('span', { class: 'chip active' }, t('options.appearance.preview.chipPage')),
        h('span', { class: 'chip' }, t('options.appearance.preview.chipDefault'))),
      h('div', { class: 'preview-msg preview-msg-user' }, t('options.appearance.preview.question')),
      h('div', { class: 'preview-msg' },
        h('strong', {}, t('options.appearance.preview.answerLead')),
        t('options.appearance.preview.answer')),
      h('div', { class: 'preview-actions' },
        h('span', { class: 'btn btn-primary btn-sm' }, t('options.appearance.preview.send')),
        h('span', { class: 'btn btn-sm' }, t('options.appearance.preview.copy')),
        h('span', { class: 'badge badge-success' }, t('options.appearance.preview.ready'))));
  }

  return {
    id: 'darstellung',
    deps: (s) => [s.general.theme, s.general.language],
    render,
  };
}
