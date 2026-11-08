// Options page entry: navigation (hash routing), section mounting, autosave status, external changes,
// host-access banner.

import { h, toast } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { applyTheme } from '../lib/utils.js';
import { createStore } from './store.js';
import { preserveFocus, button } from './dom.js';
import { createProvidersSection } from './section-providers.js';
import { createDefaultsSection } from './section-defaults.js';
import { createCostsSection } from './section-costs.js';
import { createChatSection } from './section-chat.js';
import { createQuickActionsSection } from './section-quick-actions.js';
import { createTranslateSection } from './section-translate.js';
import { createProfileSection } from './section-profile.js';
import { createAppearanceSection } from './section-appearance.js';
import { createDataSection } from './section-data.js';
import { createAboutSection } from './section-about.js';
import { mountAccessBanner } from './access-banner.js';
import { t, initI18n, applyI18n, AUTO_LANGUAGE } from '../lib/i18n.js';

// Section table. Hash ids ('anbieter', 'standardmodelle', …) are part of URLs and bookmarks and
// stay German; labels are evaluated after initI18n().
const SECTION_DEFS = [
  { id: 'anbieter', key: 'providers', icon: 'key', factory: createProvidersSection },
  { id: 'standardmodelle', key: 'defaults', icon: 'star', factory: createDefaultsSection },
  { id: 'kosten', key: 'costs', icon: 'wallet', factory: createCostsSection },
  { id: 'chat', key: 'chat', icon: 'message', factory: createChatSection },
  { id: 'schnellaktionen', key: 'quickActions', icon: 'bolt', factory: createQuickActionsSection },
  { id: 'uebersetzung', key: 'translate', icon: 'languages', factory: createTranslateSection },
  { id: 'personalisierung', key: 'profile', icon: 'user', factory: createProfileSection },
  { id: 'darstellung', key: 'appearance', icon: 'palette', factory: createAppearanceSection },
  { id: 'daten', key: 'data', icon: 'shield', factory: createDataSection },
  { id: 'ueber', key: 'about', icon: 'info', factory: createAboutSection },
];

/** The sections with labels and descriptions in the active UI language. */
function getSections() {
  return SECTION_DEFS.map((def) => ({
    ...def,
    label: t(`options.section.${def.key}.label`),
    description: t(`options.section.${def.key}.description`),
  }));
}

const DEFAULT_SECTION = SECTION_DEFS[0].id;
const pageTitle = () => t('options.page.title');

const store = createStore();
const sections = new Map();
const navLinks = new Map();
let activeId = null;
let focusOnRoute = false;
let liveRegion = null;
let SECTIONS = [];
let languageSetting = null;
let reloading = false;

// ------------------------------------------------------------------------------------------------
// Helpers passed to sections

function announce(message) {
  if (!liveRegion || !message) return;
  liveRegion.textContent = '';
  requestAnimationFrame(() => {
    liveRegion.textContent = message;
  });
}

function navigate(id) {
  focusOnRoute = true;
  if (location.hash === `#${id}`) route();
  else location.hash = id;
}

function renderSection(sec) {
  const s = store.get();
  preserveFocus(() => {
    sec.content.replaceChildren(sec.api.render(s));
  });
  sec.lastDeps = depsOf(sec, s);
}

function depsOf(sec, s) {
  try {
    return JSON.stringify(sec.api.deps(s) ?? null);
  } catch {
    return String(Math.random());
  }
}

// ------------------------------------------------------------------------------------------------
// Layout

function buildNav() {
  const nav = document.getElementById('nav');
  for (const def of SECTIONS) {
    const badge = h('span', { class: 'nav-badge', hidden: true });
    const link = h('a', {
      class: 'nav-item',
      href: `#${def.id}`,
      dataset: { section: def.id },
      onClick: () => {
        focusOnRoute = true;
      },
    },
    h('span', { class: 'nav-icon', html: icon(def.icon, { size: 18 }) }),
    h('span', { class: 'nav-label' }, def.label),
    badge);
    navLinks.set(def.id, { link, badge });
    nav.append(link);
  }
}

function buildSections() {
  const container = document.getElementById('sections');
  const fragment = document.createDocumentFragment();
  for (const def of SECTIONS) {
    const headingId = `heading-${def.id}`;
    const content = h('div', { class: 'section-content' });
    const el = h('section', {
      class: 'section',
      id: `section-${def.id}`,
      'aria-labelledby': headingId,
      hidden: true,
    },
    h('header', { class: 'section-head' },
      h('h1', { id: headingId, tabindex: '-1' }, def.label),
      h('p', { class: 'section-desc' }, def.description)),
    content);
    const sec = { def, el, content, api: null, lastDeps: null };
    const ctx = {
      store,
      get: () => store.get(),
      commit: (key, fn, opts = {}) => store.commit(key, fn, { source: def.id, ...opts }),
      rerender: () => renderSection(sec),
      navigate,
      announce,
      setInvalid: (key, invalid) => store.setInvalid(key, invalid),
    };
    sec.api = def.factory(ctx);
    sections.set(def.id, sec);
    fragment.append(el);
  }
  container.replaceChildren(fragment);
  for (const sec of sections.values()) renderSection(sec);
}

function updateNavBadges() {
  const s = store.get();
  for (const sec of sections.values()) {
    const entry = navLinks.get(sec.def.id);
    if (!entry || typeof sec.api.badge !== 'function') continue;
    const badge = sec.api.badge(s);
    entry.badge.hidden = !badge;
    if (badge) {
      entry.badge.textContent = badge.text;
      entry.badge.className = ['nav-badge', badge.cls].filter(Boolean).join(' ');
      entry.badge.title = badge.title || '';
      entry.badge.setAttribute('aria-label', badge.title || badge.text);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Routing (#anbieter, #anbieter/<providerId>, …)

function parseHash() {
  let raw = location.hash.replace(/^#/, '');
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // keep raw
  }
  const [id, ...rest] = raw.split('/');
  return { id: sections.has(id) ? id : null, param: rest.join('/') || null, raw };
}

function route() {
  const { id, param, raw } = parseHash();
  const target = id || DEFAULT_SECTION;
  if (!id && raw) history.replaceState(null, '', `#${target}`);
  const changed = target !== activeId;
  activeId = target;
  for (const sec of sections.values()) sec.el.hidden = sec.def.id !== target;
  for (const [sectionId, { link }] of navLinks) {
    if (sectionId === target) {
      link.setAttribute('aria-current', 'page');
      // Narrow layout: the nav is a horizontally scrolling bar – keep the active item visible.
      const nav = link.parentElement;
      if (nav && nav.scrollWidth > nav.clientWidth + 1) {
        nav.scrollTo({ left: link.offsetLeft - (nav.clientWidth - link.offsetWidth) / 2 });
      }
    } else {
      link.removeAttribute('aria-current');
    }
  }
  const sec = sections.get(target);
  document.title = `${sec.def.label} – ${pageTitle()}`;
  if (changed) {
    window.scrollTo(0, 0);
    sec.api.onShow?.();
  }
  if (param) sec.api.onParam?.(param);
  if (focusOnRoute) {
    focusOnRoute = false;
    if (!param) sec.el.querySelector('h1')?.focus({ preventScroll: true });
  }
}

// ------------------------------------------------------------------------------------------------
// Store events

// The UI language is applied once at startup: when it changes (here or in another tab), save
// everything and reload so every section re-renders in the new language.
function reloadForLanguage() {
  if (reloading) return;
  reloading = true;
  Promise.resolve(store.flush()).catch(() => {}).finally(() => location.reload());
}

function onStoreChange(info) {
  const s = store.get();
  if (s.general.language !== languageSetting) {
    reloadForLanguage();
    return;
  }
  applyTheme(s.general.theme);
  updateNavBadges();
  for (const sec of sections.values()) {
    const deps = depsOf(sec, s);
    const isSource = !info.external && info.source === sec.def.id;
    if (info.replaced || (isSource && info.refresh)) {
      renderSection(sec);
      continue;
    }
    if (deps === sec.lastDeps) continue;
    if (isSource) {
      sec.lastDeps = deps;
      continue;
    }
    renderSection(sec);
  }
}

function renderSaveStatus(status, error) {
  const el = document.getElementById('save-status');
  if (!el) return;
  const views = {
    saved: ['check', t('options.save.saved'), 'is-saved'],
    pending: ['spinner', t('options.save.saving'), 'is-pending'],
    saving: ['spinner', t('options.save.saving'), 'is-pending'],
    invalid: ['alert', t('options.save.invalid'), 'is-warning'],
    error: ['alert', t('options.save.error'), 'is-error'],
  };
  const [iconName, text, cls] = views[status] || views.saved;
  el.className = `save-status ${cls}`;
  const iconEl = iconName === 'spinner'
    ? h('span', { class: 'spinner', 'aria-hidden': 'true' })
    : h('span', { class: 'save-icon', html: icon(iconName, { size: 15 }) });
  const children = [iconEl, h('span', { class: 'save-text', title: error?.message || '' }, text)];
  if (status === 'error') {
    children.push(button(t('options.save.retry'), { size: 'sm', variant: 'ghost', onClick: () => store.flush() }));
  }
  el.replaceChildren(...children);
}

// ------------------------------------------------------------------------------------------------
// Startup

function showFatal(err) {
  const container = document.getElementById('sections');
  container.replaceChildren(h('div', { class: 'fatal card' },
    h('span', { class: 'fatal-icon', html: icon('alert', { size: 28 }) }),
    h('h1', {}, t('options.fatal.title')),
    h('p', { class: 'muted' }, err?.message || String(err)),
    h('p', { class: 'muted' }, t('options.fatal.locked')),
    button(t('options.fatal.reload'), { icon: 'refresh', variant: 'primary', onClick: () => location.reload() })));
}

function bindPageEvents() {
  window.addEventListener('hashchange', () => route());
  window.addEventListener('beforeunload', (event) => {
    const unsaved = store.hasUnsaved();
    if (unsaved) store.flush();
    if (unsaved || store.hasInvalid()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') store.flush();
    else sections.get(activeId)?.api.onFocus?.();
  });
  window.addEventListener('pagehide', () => {
    store.flush();
  });
  window.addEventListener('focus', () => {
    sections.get(activeId)?.api.onFocus?.();
  });
  document.getElementById('skip-link')?.addEventListener('click', () => {
    sections.get(activeId)?.el.querySelector('h1')?.focus();
  });
  // Ctrl/Cmd+S saves immediately (habit from other apps).
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (store.hasUnsaved()) store.flush();
      else toast(t('options.save.alreadySaved'), { type: 'success', timeout: 1400 });
    }
  });
}

async function main() {
  liveRegion = document.getElementById('live-region');
  let initError = null;
  try {
    await store.init();
  } catch (err) {
    console.error('[LLM Sidebar] Settings could not be loaded:', err);
    initError = err;
  }
  // The language must be known before anything is rendered.
  languageSetting = initError ? AUTO_LANGUAGE : store.get().general.language;
  await initI18n(languageSetting);
  applyI18n(document);
  document.title = pageTitle();
  SECTIONS = getSections();
  buildNav();
  mountAccessBanner(document.getElementById('access-banner'));
  if (initError) {
    showFatal(initError);
    return;
  }
  applyTheme(store.get().general.theme);
  buildSections();
  updateNavBadges();
  store.subscribe(onStoreChange);
  store.onStatus(renderSaveStatus);
  store.onSaved(() => {
    if (!reloading) toast(t('options.save.toastSaved'), { type: 'success', timeout: 1600 });
  });
  store.onError((err) => toast(t('options.save.toastError', { error: err?.message || err }), { type: 'error' }));
  renderSaveStatus(store.status());
  bindPageEvents();
  route();
  document.body.classList.add('is-ready');
}

main();
