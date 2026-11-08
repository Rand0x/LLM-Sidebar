// LLM Sidebar – dev harness UI (dev/harness.html) and the dynamic part of dev/test-page.html.
// Classic script without inline handlers; the page is chosen via <body data-dev-page="…">.
// Developer tool only – never part of the extension build.
(() => {
  'use strict';

  const DEV_PAGE = document.body ? document.body.dataset.devPage : '';
  if (DEV_PAGE === 'test-page') initTestPage();
  else if (DEV_PAGE === 'harness') initHarness();

  // ---------------------------------------------------------------------------
  // Test page: "Load another comment" appends new content (MutationObserver translation test)
  // ---------------------------------------------------------------------------

  function initTestPage() {
    const EXTRA_COMMENTS = [
      { author: 'Amara', text: 'My kitchen is quite cold in winter, so I proof the dough inside the oven with only the light switched on.' },
      { author: 'Henrik', text: 'Does anyone else find that a little rye flour makes the starter much more active? Mine doubles in four hours now.' },
      { author: 'Sofia', text: 'I tried the weekend schedule and it worked perfectly. The crust kept crackling for minutes after it came out of the oven.' },
      { author: 'Daniel', text: 'A tip for sticky dough: wet your hands instead of adding more flour. It made shaping so much easier for me.' },
      { author: 'Mei', text: 'The code snippet is a nice touch. I turned it into a small spreadsheet for planning bigger batches for our café.' },
    ];
    const list = document.getElementById('comments');
    const button = document.getElementById('load-more');
    if (!list || !button) return;
    let index = 0;
    button.addEventListener('click', () => {
      const entry = EXTRA_COMMENTS[index % EXTRA_COMMENTS.length];
      index += 1;
      const wrap = document.createElement('div');
      wrap.className = 'comment';
      const meta = document.createElement('p');
      meta.className = 'comment-meta';
      meta.textContent = `${entry.author} · just now`;
      const text = document.createElement('p');
      text.textContent = entry.text;
      wrap.append(meta, text);
      list.append(wrap);
    });
  }

  // ---------------------------------------------------------------------------
  // Harness
  // ---------------------------------------------------------------------------

  function initHarness() {
    const $ = (id) => document.getElementById(id);
    const bgFrame = $('bg-frame');
    const pageFrame = $('page-frame');
    const panelFrame = $('panel-frame');
    const ctxButton = $('btn-ctx');
    const ctxMenu = $('ctx-menu');
    const resizer = $('resizer');
    const noticeBox = $('notices');
    const debugBox = $('chk-debug');

    const DEFAULT_WIDTH = 420;
    const MIN_WIDTH = 280;
    const PREF_WIDTH = 'harness:panelWidth';
    const MAX_NOTICES = 5;
    const ROOT = '\u0000root';

    const hostShim = window.__shim && window.__shim.isShim ? window.__shim : null;
    let bgError = null; // { message, frameId }
    let selection = { text: '', editable: false, at: 0 };
    let currentWidth = DEFAULT_WIDTH;

    if (!hostShim) {
      notify('error', 'ext-shim.js wurde nicht geladen. Starte den Dev-Server mit „npm run dev“ und öffne http://localhost:8787/dev/harness.html.', { sticky: true });
    }

    // ----- helpers -----

    function frameShim(frame) {
      try {
        const shim = frame.contentWindow && frame.contentWindow.__shim;
        return shim && shim.isShim ? shim : null;
      } catch {
        return null;
      }
    }

    function truncate(text, max) {
      const s = String(text ?? '').replace(/\s+/g, ' ').trim();
      return s.length > max ? `${s.slice(0, max - 1)}…` : s;
    }

    function safeLink(url) {
      try {
        const u = new URL(url, location.href);
        return ['http:', 'https:', 'about:'].includes(u.protocol) ? u.href : '';
      } catch {
        return '';
      }
    }

    function notify(type, text, { link = '', linkText = 'Öffnen', sticky = false, timeout = 6000 } = {}) {
      const notice = document.createElement('div');
      notice.className = `notice notice-${type}`;
      notice.setAttribute('role', type === 'error' ? 'alert' : 'status');
      const body = document.createElement('div');
      body.className = 'notice-text';
      body.textContent = text;
      const href = link ? safeLink(link) : '';
      if (href) {
        const a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = linkText;
        a.addEventListener('click', () => notice.remove());
        body.append(' ', a);
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'notice-close';
      close.title = 'Hinweis schließen';
      close.setAttribute('aria-label', 'Hinweis schließen');
      close.textContent = '×';
      close.addEventListener('click', () => notice.remove());
      notice.append(body, close);
      noticeBox.append(notice);
      while (noticeBox.children.length > MAX_NOTICES) noticeBox.firstElementChild.remove();
      if (!sticky) setTimeout(() => notice.remove(), timeout);
    }

    function reloadFrame(frame) {
      try {
        frame.contentWindow.location.reload();
      } catch {
        frame.src = frame.getAttribute('src');
      }
    }

    function pageUrl() {
      try {
        return pageFrame.contentWindow.location.href;
      } catch {
        return new URL(pageFrame.getAttribute('src'), location.href).href;
      }
    }

    function isTextField(el) {
      if (el.tagName === 'TEXTAREA') return true;
      if (el.tagName !== 'INPUT') return false;
      return ['text', 'search', 'url', 'email', 'tel'].includes(String(el.type || 'text').toLowerCase());
    }

    // Current selection of the test page, including <textarea>/<input> selections.
    function readSelection() {
      const out = { text: '', editable: false, at: Date.now() };
      try {
        const win = pageFrame.contentWindow;
        const el = win.document.activeElement;
        if (el && isTextField(el)) {
          out.editable = !el.readOnly && !el.disabled;
          const start = el.selectionStart;
          const end = el.selectionEnd;
          if (typeof start === 'number' && typeof end === 'number' && end > start) out.text = el.value.slice(start, end);
        } else if (el && el.isContentEditable) {
          out.editable = true;
        }
        if (!out.text) {
          const sel = win.getSelection();
          out.text = sel ? sel.toString() : '';
        }
      } catch {
        /* test page not reachable */
      }
      if (!out.text.trim()) out.text = '';
      return out;
    }

    function fireInBackground(name, args) {
      const bg = frameShim(bgFrame);
      if (!bg) {
        notify('error', 'Der Hintergrund-Frame ist (noch) nicht geladen.');
        return null;
      }
      try {
        return bg.fire(name, args, { gesture: true });
      } catch (e) {
        notify('error', `${name}: ${e && e.message ? e.message : e}`);
        return null;
      }
    }

    // ----- top bar buttons -----

    $('btn-reload-page').addEventListener('click', () => reloadFrame(pageFrame));
    $('btn-reload-panel').addEventListener('click', () => reloadFrame(panelFrame));

    $('btn-options').addEventListener('click', () => {
      const url = '/src/options/options.html';
      const win = window.open(url, '_blank');
      if (!win) notify('warn', 'Das Popup wurde blockiert.', { link: url, linkText: 'Optionen öffnen', sticky: true });
    });

    // In the iframe the test page is a sub-frame (window.top !== window); as its own tab it is the
    // top frame like a real tab. The shim always talks to the most recently loaded test page.
    $('btn-page-tab').addEventListener('click', () => {
      const url = '/dev/test-page.html';
      const win = window.open(url, '_blank');
      if (!win) notify('warn', 'Das Popup wurde blockiert.', { link: url, linkText: 'Test-Seite öffnen', sticky: true });
      else notify('info', 'Test-Seite als eigener Tab geöffnet – Nachrichten an Tab 1 gehen jetzt dorthin, bis du ihn schließt.', { timeout: 6000 });
    });

    $('btn-cmd-translate').addEventListener('click', () => {
      const bg = frameShim(bgFrame);
      const count = fireInBackground('commands.onCommand', ['translate-page', bg ? bg.tab() : null]);
      if (count === 0) notify('warn', 'Im Hintergrund ist kein commands.onCommand-Listener registriert.');
      else if (count) notify('info', 'commands.onCommand("translate-page") ausgelöst.', { timeout: 2500 });
    });

    $('btn-reset').addEventListener('click', () => {
      const ok = window.confirm('Shim-Speicher zurücksetzen?\n\nstorage.local (Einstellungen inkl. API-Schlüssel) und storage.session werden gelöscht, die Mock-Anbieter werden neu angelegt und runtime.onInstalled meldet „install“. Chats in IndexedDB bleiben erhalten.');
      if (!ok) return;
      const params = new URLSearchParams(location.search);
      params.set('reset', '1');
      location.replace(`${location.pathname}?${params.toString()}${location.hash}`);
    });

    // ----- debug log toggle -----

    const readDebug = () => {
      try {
        return localStorage.getItem('shim:debug') === '1';
      } catch {
        return false;
      }
    };
    debugBox.checked = readDebug();
    debugBox.addEventListener('change', () => {
      if (hostShim) {
        hostShim.setDebug(debugBox.checked);
      } else {
        try {
          if (debugBox.checked) localStorage.setItem('shim:debug', '1');
          else localStorage.removeItem('shim:debug');
        } catch {
          /* ignore */
        }
      }
      notify('info', debugBox.checked ? 'Shim-Log aktiviert – alle API-Aufrufe erscheinen mit [shim] in der Konsole.' : 'Shim-Log deaktiviert.', { timeout: 2500 });
    });
    window.addEventListener('storage', (event) => {
      if (event.key === 'shim:debug' || event.key === null) debugBox.checked = readDebug();
    });

    // ----- context menu simulation -----

    const menuKey = (id) => `${typeof id}:${id}`;

    function visibleInContext(contexts, sel) {
      const list = Array.isArray(contexts) && contexts.length ? contexts : ['page'];
      if (list.includes('all')) return true;
      if (sel.text && list.includes('selection')) return true;
      if (sel.editable && list.includes('editable')) return true;
      return !sel.text && !sel.editable && list.includes('page');
    }

    function addMenuNote(text, cls) {
      const note = document.createElement('div');
      note.className = cls;
      note.textContent = text;
      ctxMenu.append(note);
    }

    function buildMenu() {
      ctxMenu.textContent = '';
      const sel = selection;
      let infoText;
      if (sel.text) infoText = `Auswahl: „${truncate(sel.text, 90)}“${sel.editable ? ' (in einem Eingabefeld)' : ''}`;
      else infoText = sel.editable ? 'Keine Auswahl – Cursor in einem Eingabefeld.' : 'Keine Auswahl – Seitenkontext.';
      addMenuNote(infoText, 'hmenu-info');

      const bg = frameShim(bgFrame);
      if (!bg) {
        addMenuNote('Der Hintergrund-Frame ist (noch) nicht geladen.', 'hmenu-empty');
        return;
      }
      const items = bg.menus().filter((item) => item.visible !== false);
      if (!items.length) {
        addMenuNote('Der Hintergrund hat keine Kontextmenü-Einträge registriert.', 'hmenu-empty');
        return;
      }
      const known = new Set(items.map((item) => menuKey(item.id)));
      const children = new Map();
      for (const item of items) {
        const hasParent = item.parentId !== undefined && item.parentId !== null && known.has(menuKey(item.parentId));
        const parent = hasParent ? menuKey(item.parentId) : ROOT;
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(item);
      }
      const selectionLabel = truncate(sel.text, 40);
      const render = (parentKey, depth) => {
        for (const item of children.get(parentKey) || []) {
          if (item.type === 'separator') {
            const sep = document.createElement('div');
            sep.className = 'hmenu-sep';
            sep.setAttribute('role', 'separator');
            ctxMenu.append(sep);
            continue;
          }
          const title = String(item.title || item.id).replace(/%s/g, selectionLabel);
          const kids = children.get(menuKey(item.id));
          if (kids && kids.length) {
            const group = document.createElement('div');
            group.className = 'hmenu-group';
            group.style.paddingLeft = `${8 + depth * 14}px`;
            group.textContent = title;
            ctxMenu.append(group);
            render(menuKey(item.id), depth + 1);
            continue;
          }
          const shown = visibleInContext(item.contexts, sel);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `hmenu-item${shown ? '' : ' dim'}`;
          btn.setAttribute('role', 'menuitem');
          btn.style.paddingLeft = `${8 + depth * 14}px`;
          btn.disabled = item.enabled === false;
          btn.title = `id: ${item.id} · Kontexte: ${(item.contexts || ['page']).join(', ')}${shown ? '' : ' – in Chrome in diesem Kontext nicht sichtbar'}`;
          const label = document.createElement('span');
          label.className = 'hmenu-title';
          label.textContent = item.type === 'checkbox' || item.type === 'radio' ? `${item.checked ? '☑' : '☐'} ${title}` : title;
          const ctx = document.createElement('span');
          ctx.className = 'hmenu-ctx';
          ctx.textContent = (item.contexts || ['page']).join(' · ');
          btn.append(label, ctx);
          btn.addEventListener('click', () => {
            closeMenu(true);
            dispatchMenuClick(item, sel);
          });
          ctxMenu.append(btn);
        }
      };
      render(ROOT, 0);
    }

    function dispatchMenuClick(item, sel) {
      const bg = frameShim(bgFrame);
      if (!bg) {
        notify('error', 'Der Hintergrund-Frame ist (noch) nicht geladen.');
        return;
      }
      const info = { menuItemId: item.id, editable: !!sel.editable, frameId: 0, pageUrl: pageUrl() };
      if (item.parentId !== undefined && item.parentId !== null) info.parentMenuItemId = item.parentId;
      if (sel.text) info.selectionText = sel.text;
      if (item.type === 'checkbox' || item.type === 'radio') {
        info.wasChecked = !!item.checked;
        info.checked = item.type === 'radio' ? true : !item.checked;
      }
      const count = fireInBackground('contextMenus.onClicked', [info, bg.tab()]);
      if (count === 0) notify('warn', 'Im Hintergrund ist kein contextMenus.onClicked-Listener registriert.');
      else if (count) notify('info', `contextMenus.onClicked: ${truncate(String(item.title || item.id).replace(/%s/g, truncate(sel.text, 30)), 60)}`, { timeout: 2500 });
    }

    function menuButtons() {
      return [...ctxMenu.querySelectorAll('.hmenu-item:not(:disabled)')];
    }

    function openMenu(focusFirst) {
      buildMenu();
      ctxMenu.hidden = false;
      ctxButton.setAttribute('aria-expanded', 'true');
      if (focusFirst) {
        const first = menuButtons()[0];
        if (first) first.focus();
      }
    }

    function closeMenu(restoreFocus) {
      if (ctxMenu.hidden) return;
      ctxMenu.hidden = true;
      ctxButton.setAttribute('aria-expanded', 'false');
      if (restoreFocus) ctxButton.focus();
    }

    // Snapshot the selection before the click moves the focus out of the test page.
    ctxButton.addEventListener('pointerdown', () => {
      selection = readSelection();
    });
    ctxButton.addEventListener('click', (event) => {
      if (!ctxMenu.hidden) {
        closeMenu(false);
        return;
      }
      if (Date.now() - selection.at > 1500) selection = readSelection();
      openMenu(event.detail === 0); // detail 0 = keyboard activation
    });
    ctxMenu.addEventListener('keydown', (event) => {
      const buttons = menuButtons();
      const index = buttons.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!buttons.length) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        buttons[(index + step + buttons.length) % buttons.length].focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        if (buttons.length) buttons[event.key === 'Home' ? 0 : buttons.length - 1].focus();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !ctxMenu.hidden) {
        event.preventDefault();
        closeMenu(true);
      }
    });
    document.addEventListener('pointerdown', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!ctxMenu.hidden && !(target && target.closest('.menu-wrap'))) closeMenu(false);
    });
    window.addEventListener('blur', () => closeMenu(false)); // focus moved into an iframe

    // ----- resizable side panel -----

    function applyWidth(px, save) {
      const max = Math.max(MIN_WIDTH, window.innerWidth - 240);
      const width = Math.round(Math.min(max, Math.max(MIN_WIDTH, Number(px) || DEFAULT_WIDTH)));
      currentWidth = width;
      document.documentElement.style.setProperty('--panel-width', `${width}px`);
      resizer.setAttribute('aria-valuemin', String(MIN_WIDTH));
      resizer.setAttribute('aria-valuemax', String(max));
      resizer.setAttribute('aria-valuenow', String(width));
      if (save) {
        try {
          localStorage.setItem(PREF_WIDTH, String(width));
        } catch {
          /* ignore */
        }
      }
    }

    let savedWidth = DEFAULT_WIDTH;
    try {
      savedWidth = Number(localStorage.getItem(PREF_WIDTH)) || DEFAULT_WIDTH;
    } catch {
      /* ignore */
    }
    applyWidth(savedWidth, false);

    let drag = null;
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      document.body.classList.remove('dragging');
      resizer.classList.remove('active');
      applyWidth(currentWidth, true);
    };
    resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = { startX: event.clientX, startWidth: currentWidth };
      try {
        resizer.setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      document.body.classList.add('dragging');
      resizer.classList.add('active');
    });
    resizer.addEventListener('pointermove', (event) => {
      if (drag) applyWidth(drag.startWidth + (drag.startX - event.clientX), false);
    });
    resizer.addEventListener('pointerup', endDrag);
    resizer.addEventListener('pointercancel', endDrag);
    resizer.addEventListener('lostpointercapture', endDrag);
    resizer.addEventListener('dblclick', () => applyWidth(DEFAULT_WIDTH, true));
    resizer.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 64 : 16;
      if (event.key === 'ArrowLeft') applyWidth(currentWidth + step, true);
      else if (event.key === 'ArrowRight') applyWidth(currentWidth - step, true);
      else if (event.key === 'Home') applyWidth(MIN_WIDTH, true);
      else if (event.key === 'End') applyWidth(window.innerWidth, true);
      else return;
      event.preventDefault();
    });
    window.addEventListener('resize', () => applyWidth(currentWidth, false));

    // ----- status indicator -----

    function setStatus(id, state, title) {
      const el = $(id);
      el.classList.remove('ok', 'warn', 'error');
      if (state) el.classList.add(state);
      el.title = title;
    }

    function renderStatus() {
      const frames = hostShim ? hostShim.registry() : [];
      const isAlive = (shim) => !!shim && frames.some((f) => f.frameId === shim.frameId);

      const bg = frameShim(bgFrame);
      if (bgError && bg && bgError.frameId !== bg.frameId) bgError = null; // background was reloaded
      if (!bg || !isAlive(bg)) setStatus('status-bg', '', 'Hintergrund: lädt oder nicht erreichbar');
      else if (bgError) setStatus('status-bg', 'error', `Hintergrund: Fehler – ${bgError.message}`);
      else if (!bg.isPrimaryBackground()) setStatus('status-bg', 'warn', 'Hintergrund: inaktiv – eine neuere Harness-Instanz in einem anderen Tab ist aktiv');
      else setStatus('status-bg', 'ok', 'Hintergrund: läuft');

      const page = frameShim(pageFrame);
      setStatus('status-page', isAlive(page) ? 'ok' : '', isAlive(page) ? `Test-Seite: ${pageUrl()}` : 'Test-Seite: lädt oder nicht erreichbar');

      const panel = frameShim(panelFrame);
      setStatus('status-panel', isAlive(panel) ? 'ok' : '', isAlive(panel) ? 'Seitenleiste: geladen' : 'Seitenleiste: lädt oder nicht erreichbar');
    }

    window.addEventListener('shim:registry', renderStatus);
    for (const frame of [bgFrame, pageFrame, panelFrame]) frame.addEventListener('load', renderStatus);
    setInterval(renderStatus, 2000);
    renderStatus();

    // ----- events reported by the shim -----

    window.addEventListener('shim:bg-error', (event) => {
      const detail = event.detail || {};
      const bg = frameShim(bgFrame);
      if (bg && detail.frameId && detail.frameId !== bg.frameId) return; // another harness instance
      bgError = { message: String(detail.message || 'Unbekannter Fehler'), frameId: detail.frameId || (bg && bg.frameId) };
      notify('error', `Hintergrund: ${bgError.message} (Details in der Konsole)`, { sticky: true });
      renderStatus();
    });

    // tabs.create / runtime.openOptionsPage that the shim did not open itself.
    window.addEventListener('shim:open-blocked', (event) => {
      const detail = event.detail || {};
      const url = String(detail.url || '');
      const shown = truncate(url.replace(location.origin, ''), 80);
      if (detail.reason === 'unsupported') {
        notify('warn', `Ein neuer Tab mit ${shown} wurde angefordert – diese Adresse lässt sich aus der Harness nicht öffnen.`, { timeout: 8000 });
      } else if (detail.reason === 'no-gesture') {
        notify('info', `Ein neuer Tab wurde ohne Nutzeraktion angefordert: ${shown}`, { link: url, linkText: 'In neuem Tab öffnen', sticky: true });
      } else {
        notify('warn', `Das Popup wurde blockiert: ${shown}`, { link: url, linkText: 'Jetzt öffnen', sticky: true });
      }
    });

    // ----- toolbar icon (action badge + title) -----

    const actionIcon = $('action-icon');
    const actionBadge = $('action-badge');
    let lastBadge = '';

    function renderAction(state) {
      const s = state || {};
      const title = String(s.title || 'LLM Sidebar');
      const text = String(s.text || '');
      actionIcon.title = title;
      actionIcon.setAttribute('aria-label', `Erweiterungssymbol: ${title}${text ? ` (Badge „${text}“)` : ''}`);
      actionBadge.textContent = text;
      actionBadge.hidden = !text;
      if (s.color) actionBadge.style.background = s.color;
      // Badge and title are usually set in a row – announce once the title has arrived too.
      if (text && text !== lastBadge) {
        setTimeout(() => {
          if (actionBadge.textContent) notify('warn', `Symbol-Badge „${actionBadge.textContent}“: ${actionIcon.title}`, { timeout: 8000 });
        }, 150);
      }
      lastBadge = text;
    }

    window.addEventListener('shim:action', (event) => {
      const detail = event.detail || {};
      const bg = frameShim(bgFrame);
      if (detail.fromRole === 'background' && bg && detail.frameId !== bg.frameId) return; // another harness instance
      renderAction(detail);
    });
    // A reloaded background starts with the default icon state (like a restarted browser).
    bgFrame.addEventListener('load', () => {
      const bg = frameShim(bgFrame);
      renderAction(bg && typeof bg.action === 'function' ? bg.action() : null);
    });

    let flashTimer = 0;
    window.addEventListener('shim:sidepanel-open', () => {
      panelFrame.classList.add('flash');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => panelFrame.classList.remove('flash'), 900);
    });
  }
})();
