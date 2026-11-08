// Banner at the top of the options page while <all_urls> is not granted. The options page opens
// on first install, so this is the onboarding step for Firefox, where the host permission is
// often missing until the user allows it once.

import { h, toast } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { button, preserveFocus } from './dom.js';
import { t } from '../lib/i18n.js';
import { hostAccessState, requestHostAccess, onHostAccessChange } from './permission.js';

const TITLE_ID = 'access-banner-title';

export function mountAccessBanner(slot) {
  if (!slot) return;
  let state = 'checking';
  let denied = false;
  let busy = false;
  let shown = '';
  let actionBtn = null;

  async function check() {
    state = await hostAccessState();
    render();
  }

  function request() {
    if (busy) return;
    busy = true;
    // No await before the request (user-gesture rule); only mark the button.
    actionBtn?.setAttribute('aria-busy', 'true');
    requestHostAccess().then((granted) => {
      denied = !granted;
      toast(granted ? t('options.access.granted') : t('options.access.notGranted'), {
        type: granted ? 'success' : 'warning',
      });
    }).catch((err) => {
      toast(t('options.access.requestFailed', { error: err?.message || err }), { type: 'error' });
    }).finally(() => {
      busy = false;
      actionBtn?.removeAttribute('aria-busy');
      check();
    });
  }

  function render() {
    const view = state === 'missing' ? `missing:${denied}` : 'hidden';
    if (view === shown) return;
    shown = view;
    if (view === 'hidden') {
      const hadFocus = slot.contains(document.activeElement);
      slot.hidden = true;
      slot.replaceChildren();
      actionBtn = null;
      if (hadFocus) document.querySelector('.section:not([hidden]) h1')?.focus({ preventScroll: true });
      return;
    }
    actionBtn = button(t('options.access.allow'), {
      icon: 'shield', variant: 'primary', dataset: { key: 'banner:access' }, onClick: request,
    });
    const body = h('div', { class: 'callout callout-warning access-banner' },
      h('span', { class: 'callout-icon', html: icon('shield', { size: 22 }) }),
      h('div', { class: 'callout-body' },
        h('p', { class: 'callout-title', id: TITLE_ID }, t('options.access.title')),
        h('p', {}, t('options.access.why')),
        h('p', { class: 'muted' }, t('options.access.privacy')),
        h('div', { class: 'access-banner-actions' }, actionBtn),
        denied
          ? h('p', { class: 'hint warning-text' }, t('options.access.denied'))
          : null));
    preserveFocus(() => {
      slot.replaceChildren(body);
      slot.hidden = false;
    });
  }

  slot.setAttribute('aria-labelledby', TITLE_ID);
  onHostAccessChange(check);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  check();
}
