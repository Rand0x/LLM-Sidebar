// "Über": version, keyboard shortcuts and how to change them, short usage guide.

import { h, toast } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { ext, IS_FIREFOX } from '../lib/ext.js';
import { t } from '../lib/i18n.js';
import { button, group, panel } from './dom.js';

const COMMAND_KEYS = {
  _execute_action: 'options.about.command.openSidebar',
  _execute_sidebar_action: 'options.about.command.toggleSidebar',
  _execute_browser_action: 'options.about.command.openSidebar',
  'translate-page': 'options.about.command.translatePage',
};
const commandLabel = (name) => (COMMAND_KEYS[name] ? t(COMMAND_KEYS[name]) : '');
const CHROME_SHORTCUTS_URL = 'chrome://extensions/shortcuts';

/** Splits a message at {code} and puts `code` in a <code> element. */
function withCode(message, code) {
  const [before, after = ''] = message.split('{code}');
  return [before, h('code', {}, code), after];
}

function keys(shortcut) {
  const text = String(shortcut || '').trim();
  if (!text) return h('span', { class: 'muted text-sm' }, t('options.about.notSet'));
  const parts = text.includes('+') ? text.split('+').map((p) => p.trim()).filter(Boolean) : [text];
  const out = h('span', { class: 'kbd-combo', 'aria-label': parts.join(' + ') });
  parts.forEach((part, i) => {
    if (i) out.append(h('span', { class: 'kbd-plus', 'aria-hidden': 'true' }, '+'));
    out.append(h('kbd', { class: 'kbd', 'aria-hidden': 'true' }, part));
  });
  return out;
}

export function createAboutSection() {
  let shortcutsEl = null;
  let commands = null;

  async function loadCommands() {
    try {
      commands = ext?.commands?.getAll ? await ext.commands.getAll() : [];
    } catch {
      commands = [];
    }
    renderShortcuts();
  }

  function shortcutFor(name) {
    return commands?.find((c) => c.name === name)?.shortcut || '';
  }

  function renderShortcuts() {
    if (!shortcutsEl) return;
    if (commands === null) {
      shortcutsEl.replaceChildren(h('div', { class: 'field' }, h('span', { class: 'muted' }, h('span', { class: 'spinner' }), ` ${t('options.about.loading')}`)));
      return;
    }
    if (!commands.length) {
      shortcutsEl.replaceChildren(h('div', { class: 'field' }, h('span', { class: 'muted' }, t('options.about.none'))));
      return;
    }
    shortcutsEl.replaceChildren(...commands.map((cmd) => {
      const label = commandLabel(cmd.name);
      return h('div', { class: 'field shortcut-row' },
        h('div', { class: 'field-text' },
          h('div', { class: 'field-label' }, label || cmd.description || cmd.name),
          cmd.description && label && cmd.description !== label
            ? h('div', { class: 'field-hint' }, cmd.description) : null),
        h('div', { class: 'field-control' }, keys(cmd.shortcut)));
    }));
    renderTips();
  }

  let tipsEl = null;
  function renderTips() {
    if (!tipsEl) return;
    const open = shortcutFor('_execute_action') || shortcutFor('_execute_sidebar_action');
    const translate = shortcutFor('translate-page');
    const tips = [
      ['sidebar', t('options.about.tip.sidebar.title'), open
        ? t('options.about.tip.sidebar.textShortcut', { shortcut: open })
        : t('options.about.tip.sidebar.text')],
      ['wand', t('options.about.tip.edit.title'), t('options.about.tip.edit.text')],
      ['menu', t('options.about.tip.menu.title'), t('options.about.tip.menu.text')],
      ['languages', t('options.about.tip.translate.title'), translate
        ? t('options.about.tip.translate.textShortcut', { shortcut: translate })
        : t('options.about.tip.translate.text')],
      ['image', t('options.about.tip.image.title'), t('options.about.tip.image.text')],
    ];
    tipsEl.replaceChildren(...tips.map(([iconName, title, text]) => h('li', { class: 'tip' },
      h('span', { class: 'tip-icon', html: icon(iconName, { size: 18 }) }),
      h('div', {}, h('div', { class: 'tip-title' }, title), h('div', { class: 'hint' }, text)))));
  }

  function openShortcutSettings() {
    try {
      Promise.resolve(ext.tabs.create({ url: CHROME_SHORTCUTS_URL })).catch(() => {
        toast(t('options.about.openManually', { url: CHROME_SHORTCUTS_URL }), { type: 'info', timeout: 6000 });
      });
    } catch {
      toast(t('options.about.openManually', { url: CHROME_SHORTCUTS_URL }), { type: 'info', timeout: 6000 });
    }
  }

  function render() {
    let manifest = {};
    try {
      manifest = ext.runtime.getManifest() || {};
    } catch {
      manifest = {};
    }
    shortcutsEl = h('div', { class: 'shortcut-list' });
    tipsEl = h('ul', { class: 'tips' });

    const changeHelp = IS_FIREFOX
      ? h('div', { class: 'field stacked' },
        h('div', { class: 'field-text' },
          h('div', { class: 'field-label' }, t('options.about.change.title')),
          h('ol', { class: 'steps' },
            h('li', {}, ...withCode(t('options.about.change.firefox.step1'), 'about:addons')),
            h('li', {}, t('options.about.change.firefox.step2')),
            h('li', {}, t('options.about.change.firefox.step3')))))
      : h('div', { class: 'field' },
        h('div', { class: 'field-text' },
          h('div', { class: 'field-label' }, t('options.about.change.title')),
          h('div', { class: 'field-hint' }, ...withCode(t('options.about.change.chrome'), CHROME_SHORTCUTS_URL))),
        h('div', { class: 'field-control' },
          button(t('options.about.change.open'), { icon: 'keyboard', size: 'sm', dataset: { key: 'about:shortcuts' }, onClick: openShortcutSettings })));

    const body = h('div', { class: 'section-body' },
      h('div', { class: 'about-hero card' },
        h('img', { src: '../icons/icon-128.png', alt: '', width: 64, height: 64, class: 'about-logo' }),
        h('div', { class: 'about-text' },
          h('h2', { class: 'about-name' }, manifest.name || 'LLM Sidebar'),
          h('p', { class: 'muted' }, t('options.about.tagline')),
          h('div', { class: 'row wrap' },
            h('span', { class: 'badge badge-accent' }, t('options.about.version', { version: manifest.version || '–' })),
            h('span', { class: 'badge' }, IS_FIREFOX ? 'Firefox' : 'Chrome / Chromium'),
            h('span', { class: 'badge' }, t('options.about.license')),
            h('span', { class: 'badge badge-success' }, t('options.about.noTracking'))))),
      group({ title: t('options.about.shortcuts.title') }, panel(shortcutsEl, changeHelp)),
      group({ title: t('options.about.guide.title') }, panel(h('div', { class: 'field stacked' }, tipsEl))));
    renderShortcuts();
    renderTips();
    if (commands === null) loadCommands();
    return body;
  }

  return {
    id: 'ueber',
    deps: () => null,
    render,
    onShow: loadCommands,
  };
}
