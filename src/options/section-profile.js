// "Personalisierung": personal profile used by the "Personalisieren" action ({{profile}}) and optionally in chats.

import { h } from '../lib/ui.js';
import { t, formatNumber } from '../lib/i18n.js';
import { group, panel, field, switchField, textArea, callout } from './dom.js';

const MAX_RECOMMENDED = 2000;

function counter(value) {
  const n = value.length;
  const el = h('span', { class: 'char-count', 'aria-live': 'off' });
  const update = (len) => {
    el.textContent = t('options.profile.chars', { count: len, n: formatNumber(len) });
    el.classList.toggle('is-warning', len > MAX_RECOMMENDED);
    el.title = len > MAX_RECOMMENDED ? t('options.profile.tooLong') : '';
  };
  update(n);
  return { el, update };
}

export function createProfileSection(ctx) {
  function textField(s, { id, key, field: name, label, hint, placeholder }) {
    const count = counter(s.profile[name]);
    const ta = textArea({
      id,
      key,
      value: s.profile[name],
      rows: 4,
      placeholder,
      onInput: (value) => {
        count.update(value.length);
        ctx.commit(`profile.${name}`, (x) => { x.profile[name] = value; });
      },
    });
    return field({ label, hint, control: ta, controlId: id, stacked: true, extra: count.el });
  }

  function render(s) {
    return h('div', { class: 'section-body' },
      callout('info', 'user', t('options.profile.intro.title'),
        h('p', {}, t('options.profile.intro.text'))),
      group({ title: t('options.profile.group') }, panel(
        textField(s, {
          id: 'profile-about',
          key: 'profile:aboutMe',
          field: 'aboutMe',
          label: t('options.profile.aboutMe.label'),
          hint: t('options.profile.aboutMe.hint'),
          placeholder: t('options.profile.aboutMe.placeholder'),
        }),
        textField(s, {
          id: 'profile-style',
          key: 'profile:writingStyle',
          field: 'writingStyle',
          label: t('options.profile.writingStyle.label'),
          hint: t('options.profile.writingStyle.hint'),
          placeholder: t('options.profile.writingStyle.placeholder'),
        }),
        switchField({
          label: t('options.profile.useInChat.label'),
          hint: t('options.profile.useInChat.hint'),
          checked: s.chat.useProfileInChat,
          key: 'profile:useInChat',
          onChange: (v) => ctx.commit('chat.useProfileInChat', (x) => { x.chat.useProfileInChat = v; }),
        }))));
  }

  return {
    id: 'personalisierung',
    deps: (s) => [s.profile, s.chat.useProfileInChat],
    render,
  };
}
