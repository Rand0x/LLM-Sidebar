// Message list rendering: bubbles, streaming updates (one render per animation frame),
// scroll pinning, inline editing and per-message actions.
import { h, autosize, toast } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { renderMarkdown } from '../lib/markdown.js';
import { copyText, hostnameOf, truncate } from '../lib/utils.js';
import { t } from '../lib/i18n.js';
import { fullDateTime, shortTime } from './format.js';
import { openImageInTab, downloadImage } from './attachments.js';
import { isVideoId, linkifyTimestamps, parseTimestampLink } from '../lib/youtube.js';

// Model output must never trigger remote image loads (privacy / prompt-injection exfiltration).
const MD_OPTS = { allowRemoteImages: false };
const PIN_THRESHOLD = 48;

// `label` is a getter: the UI language is only known after initI18n().
export const IMAGE_SIZES = [
  { value: '1024x1024', key: 'square', ratio: '1 / 1' },
  { value: '1536x1024', key: 'landscape', ratio: '3 / 2' },
  { value: '1024x1536', key: 'portrait', ratio: '2 / 3' },
].map((s) => Object.defineProperty(s, 'label', { get: () => t(`sidepanel.image.size.${s.key}`), enumerable: true }));

function sizeInfo(size) {
  return IMAGE_SIZES.find((s) => s.value === size) || null;
}

// Stored messages can come from imports – render only well-formed image entries.
function validImages(msg) {
  return (Array.isArray(msg.images) ? msg.images : []).filter((img) => typeof img?.src === 'string' && img.src);
}

function validAttachments(msg) {
  return (Array.isArray(msg.attachments) ? msg.attachments : [])
    .filter((a) => typeof a?.dataUrl === 'string' && /^data:image\//i.test(a.dataUrl));
}

function dateStamp(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * handlers: { onCopy(msg, btn), onRegenerate(msg), onRetry(msg), onDelete(msg), onEditSubmit(msg, text),
 *             providerLabel(msg) → string, isSendKey(event) → bool, isBusy() → bool,
 *             onTimestamp?(videoId, seconds) – click on a YouTube timestamp link in an answer }
 */
export function createChatView({ scroller, list, scrollButton, handlers }) {
  const views = new Map();
  const dirty = new Set();
  let chat = null;
  let busyId = null;
  let editingId = null;
  let pinned = true;
  let frame = 0;

  // ---------------------------------------------------------------- scrolling

  const distance = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;

  function updateScrollButton() {
    scrollButton.hidden = pinned || !list.childElementCount || distance() < PIN_THRESHOLD;
  }

  function scrollToBottom({ smooth = false } = {}) {
    pinned = true;
    if (smooth) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    else scroller.scrollTop = scroller.scrollHeight;
    updateScrollButton();
  }

  // Only an upward scroll unpins; layout changes (images loading, re-renders) never do.
  let lastTop = 0;
  scroller.addEventListener('scroll', () => {
    const top = scroller.scrollTop;
    if (distance() < PIN_THRESHOLD) pinned = true;
    else if (top < lastTop - 1) pinned = false;
    lastTop = top;
    updateScrollButton();
  }, { passive: true });
  // Images change the height after rendering; stay at the bottom when following.
  list.addEventListener('load', (event) => {
    if (event.target?.tagName === 'IMG' && pinned) scroller.scrollTop = scroller.scrollHeight;
  }, true);
  // Scrolling up is an explicit "stop following" signal, even before the scroll event lands.
  scroller.addEventListener('wheel', (event) => {
    if (event.deltaY < 0 && distance() > 2) pinned = false;
  }, { passive: true });
  scroller.addEventListener('keydown', (event) => {
    if (['PageUp', 'ArrowUp', 'Home'].includes(event.key)) pinned = false;
  });
  scrollButton.addEventListener('click', () => {
    scrollToBottom({ smooth: true });
  });

  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      if (pinned) scroller.scrollTop = scroller.scrollHeight;
      updateScrollButton();
    });
    ro.observe(list);
    ro.observe(scroller);
  }

  // Timestamp links in answers ("[12:34]" → youtube.com/watch?v=…&t=754s) seek the video in the
  // tab instead of opening a new one (Ctrl/Shift/middle click keep the browser's behaviour).
  list.addEventListener('click', (event) => {
    if (!handlers.onTimestamp || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('.msg-content a[href]');
    if (!link || !list.contains(link)) return;
    const target = parseTimestampLink(link.href);
    if (!target) return;
    event.preventDefault();
    handlers.onTimestamp(target.videoId, target.seconds);
  });

  // Delegated copy handler for code blocks produced by renderMarkdown.
  list.addEventListener('click', async (event) => {
    const btn = event.target.closest?.('.copy-code');
    if (!btn || !list.contains(btn)) return;
    const pre = btn.closest('.code-block')?.querySelector('pre');
    if (!pre) return;
    const ok = await copyText(pre.textContent);
    btn.classList.toggle('copied', ok);
    btn.textContent = t(ok ? 'sidepanel.code.copied' : 'sidepanel.code.error');
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.classList.remove('copied');
      btn.textContent = t('sidepanel.code.copy');
    }, 1600);
  });

  // ---------------------------------------------------------------- building blocks

  function actionButton(name, iconName, label, onClick) {
    return h('button', {
      type: 'button',
      class: 'btn-icon btn-sm msg-action',
      title: label,
      'aria-label': label,
      dataset: { action: name },
      html: icon(iconName, { size: 15 }),
      onClick: (event) => onClick(event.currentTarget),
    });
  }

  function actionsBar(msg) {
    const bar = h('div', { class: 'msg-actions', role: 'toolbar', 'aria-label': t('sidepanel.message.actions') });
    bar.appendChild(actionButton('copy', 'copy', t('sidepanel.message.copy'), (btn) => handlers.onCopy(msg, btn)));
    if (msg.role === 'user') {
      bar.appendChild(actionButton('edit', 'edit', t('sidepanel.message.edit'), () => startEdit(msg.id)));
    } else {
      bar.appendChild(actionButton('regenerate', 'refresh', t('sidepanel.message.regenerate'), () => handlers.onRegenerate(msg)));
    }
    bar.appendChild(actionButton('delete', 'trash', t('sidepanel.message.delete'), () => handlers.onDelete(msg)));
    const time = new Date(msg.createdAt || Date.now());
    bar.appendChild(h('time', {
      class: 'msg-time',
      datetime: time.toISOString(),
      title: fullDateTime(time),
    }, shortTime(msg.createdAt || Date.now())));
    return bar;
  }

  function pageTag(page, video = null) {
    const url = String(page.url || '');
    const label = page.title || hostnameOf(url) || url || t('sidepanel.message.webpage');
    const safe = /^https?:\/\//i.test(url);
    const isVideo = isVideoId(video?.id);
    const what = isVideo
      ? t(video.transcript === false ? 'sidepanel.message.videoNoTranscript' : 'sidepanel.message.videoWithTranscript')
      : t('sidepanel.message.pageSent');
    return h(safe ? 'a' : 'span', {
      class: `msg-page${isVideo ? ' msg-page-video' : ''}`,
      href: safe ? url : null,
      target: safe ? '_blank' : null,
      rel: safe ? 'noopener noreferrer' : null,
      title: `${what}: ${page.title || ''}${url ? `\n${url}` : ''}`.trim(),
      html: icon(isVideo ? 'play' : 'page', { size: 13 }),
    }, h('span', { class: 'truncate' }, label));
  }

  // The page selection this message refers to.
  function quoteBlock(quote) {
    const url = String(quote.url || '');
    const safe = /^https?:\/\//i.test(url);
    const source = quote.title || hostnameOf(url);
    return h('figure', { class: 'msg-quote' },
      h('blockquote', {
        class: 'msg-quote-text',
        title: quote.text.length > 400 ? truncate(quote.text, 2000) : null,
      }, truncate(quote.text, 400)),
      h('figcaption', { class: 'msg-quote-source', html: icon('quote', { size: 12 }) },
        h(safe ? 'a' : 'span', {
          class: 'truncate',
          href: safe ? url : null,
          target: safe ? '_blank' : null,
          rel: safe ? 'noopener noreferrer' : null,
          title: safe ? url : null,
        }, source ? t('sidepanel.message.quoteFrom', { source }) : t('sidepanel.selection.label')),
        quote.truncated ? h('span', { class: 'msg-quote-note' }, t('sidepanel.selection.truncated')) : null));
  }

  function attachmentsRow(attachments) {
    return h('div', { class: 'msg-attachments' }, attachments.map((a, i) => {
      const name = a.name || t('sidepanel.attachments.imageN', { n: i + 1 });
      return h('button', {
        type: 'button',
        class: 'msg-thumb',
        title: t('sidepanel.attachments.openInTab', { name }),
        'aria-label': t('sidepanel.attachments.open', { name }),
        onClick: () => openImage(a.dataUrl),
      }, h('img', { src: a.dataUrl, alt: '', loading: 'lazy', decoding: 'async' }));
    }));
  }

  function openImage(src) {
    if (!openImageInTab(src)) toast(t('sidepanel.image.cannotOpen'), { type: 'error' });
  }

  async function saveImage(src, base) {
    if (!(await downloadImage(src, base))) toast(t('sidepanel.image.cannotSave'), { type: 'error' });
  }

  function generatedImages(images, msg) {
    return images.map((img, i) => {
      const caption = typeof img.prompt === 'string' ? img.prompt : '';
      const prompt = caption || msg.content || '';
      const base = `${t('sidepanel.image.filePrefix')}-${dateStamp(msg.createdAt)}${images.length > 1 ? `-${i + 1}` : ''}`;
      return h('figure', { class: 'gen-image' },
        h('button', {
          type: 'button',
          class: 'gen-image-view',
          title: t('sidepanel.image.openInTab'),
          'aria-label': t('sidepanel.image.openInTabLabel'),
          onClick: () => openImage(img.src),
        }, h('img', {
          src: img.src,
          alt: prompt ? t('sidepanel.image.generatedAlt', { prompt: truncate(prompt, 160) }) : t('sidepanel.image.generated'),
          decoding: 'async',
          referrerpolicy: 'no-referrer',
        })),
        h('div', { class: 'gen-image-actions' },
          h('button', {
            type: 'button',
            class: 'btn btn-sm',
            title: t('sidepanel.image.download'),
            html: icon('download', { size: 14 }),
            onClick: () => saveImage(img.src, base),
          }, t('sidepanel.image.save')),
          h('button', {
            type: 'button',
            class: 'btn btn-sm btn-ghost',
            title: t('sidepanel.image.openInTabLabel'),
            html: icon('external', { size: 14 }),
            onClick: () => openImage(img.src),
          }, t('sidepanel.image.open'))),
        caption && caption !== msg.content
          ? h('figcaption', { class: 'gen-image-caption', title: caption }, truncate(caption, 200))
          : null);
    });
  }

  // ---------------------------------------------------------------- user messages

  function fillUser(view) {
    const { el, msg } = view;
    el.textContent = '';
    el.classList.remove('editing');
    const body = h('div', { class: 'msg-body' });
    if (msg.page && (msg.page.title || msg.page.url)) body.appendChild(pageTag(msg.page, msg.video));
    if (msg.quote?.text) body.appendChild(quoteBlock(msg.quote));
    const attachments = validAttachments(msg);
    if (attachments.length) body.appendChild(attachmentsRow(attachments));
    if (msg.content || msg.kind === 'image') {
      const size = sizeInfo(msg.size);
      body.appendChild(h('div', { class: 'bubble' },
        msg.kind === 'image'
          ? h('span', { class: 'bubble-kind', html: icon('image', { size: 13 }) }, size ? t('sidepanel.image.kindWithSize', { size: size.label }) : t('sidepanel.image.label'))
          : null,
        msg.content ? h('div', { class: 'bubble-text' }, msg.content) : null));
    }
    view.actions = actionsBar(msg);
    el.append(body, view.actions);
  }

  function buildUser(msg) {
    const view = { msg, el: h('article', { class: 'msg msg-user', dataset: { id: msg.id }, 'aria-label': t('sidepanel.message.yours') }) };
    fillUser(view);
    return view;
  }

  // ---------------------------------------------------------------- assistant messages

  function buildAssistant(msg) {
    const modelEl = h('span', { class: 'msg-model truncate' });
    const statusEl = h('span', { class: 'msg-status' });
    const usageEl = h('span', { class: 'msg-usage', hidden: true });
    const reasoningStatus = h('span', { class: 'reasoning-status' });
    const reasoningBody = h('div', { class: 'reasoning-body md' });
    const reasoning = h('details', { class: 'reasoning', hidden: true },
      h('summary', { html: icon('brain', { size: 14 }) }, h('span', {}, t('sidepanel.message.reasoning')), reasoningStatus,
        h('span', { class: 'reasoning-chevron', html: icon('chevron-down', { size: 14 }) })),
      reasoningBody);
    const content = h('div', { class: 'msg-content md' });
    const typing = h('div', { class: 'typing', hidden: true, role: 'status', 'aria-label': t('sidepanel.message.typing') },
      h('span', { class: 'typing-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('span', { class: 'typing-text' }));
    const images = h('div', { class: 'gen-images', hidden: true });
    const note = h('div', { class: 'msg-note', hidden: true });
    const error = h('div', { class: 'msg-error', role: 'alert', hidden: true });
    const el = h('article', { class: 'msg msg-assistant', dataset: { id: msg.id }, 'aria-label': t('sidepanel.message.answer') },
      h('div', { class: 'msg-head' },
        h('span', { class: 'msg-avatar', html: icon('sparkles', { size: 13 }) }),
        modelEl,
        statusEl,
        usageEl),
      reasoning, content, typing, images, note, error);
    const view = {
      msg, el, modelEl, statusEl, usageEl, reasoning, reasoningBody, reasoningStatus, content, typing, images, note, error,
      actions: actionsBar(msg), renderedText: null, renderedReasoning: null, imagesKey: null, errorKey: null, status: '',
    };
    el.appendChild(view.actions);
    reasoning.open = msg.id === busyId;
    updateAssistant(view);
    return view;
  }

  // Tokens and cost of the answer ("1.234 Tokens · ≈ 0,0021 $"), hidden while streaming.
  function updateUsage(view, streaming = view.msg.id === busyId) {
    const info = streaming ? null : handlers.usageLabel?.(view.msg);
    view.usageEl.hidden = !info;
    view.usageEl.textContent = info?.text || '';
    if (info?.title) view.usageEl.title = info.title;
    else view.usageEl.removeAttribute('title');
    if (info) view.usageEl.setAttribute('aria-label', info.title ? info.title.replace(/\n/g, ', ') : info.text);
    else view.usageEl.removeAttribute('aria-label');
  }

  function updateAssistant(view) {
    const { msg } = view;
    const streaming = msg.id === busyId;
    view.el.classList.toggle('streaming', streaming);
    view.el.setAttribute('aria-busy', String(streaming));
    view.modelEl.textContent = handlers.providerLabel(msg);
    view.modelEl.title = view.modelEl.textContent;
    updateUsage(view, streaming);

    // Reasoning ("Gedankengang")
    if (msg.reasoning) {
      view.reasoning.hidden = false;
      if (view.renderedReasoning !== msg.reasoning) {
        view.reasoningBody.innerHTML = renderMarkdown(msg.reasoning, MD_OPTS);
        view.renderedReasoning = msg.reasoning;
        if (streaming) view.reasoningBody.scrollTop = view.reasoningBody.scrollHeight;
      }
      view.reasoningStatus.textContent = streaming && !msg.content ? t('sidepanel.message.thinking') : '';
    } else {
      view.reasoning.hidden = true;
    }

    // Text
    if (view.renderedText !== msg.content) {
      const markdown = isVideoId(msg.video?.id) ? linkifyTimestamps(msg.content, msg.video.id) : msg.content;
      view.content.innerHTML = markdown ? renderMarkdown(markdown, MD_OPTS) : '';
      view.renderedText = msg.content;
    }
    view.content.hidden = !msg.content;

    // Typing indicator / status (e.g. "Reading page …")
    view.typing.hidden = !(streaming && !msg.content && !msg.reasoning && msg.kind !== 'image');
    view.typing.querySelector('.typing-text').textContent = view.status || '';

    // Images (generated or returned by chat models)
    const images = validImages(msg);
    if (msg.kind === 'image' && streaming) {
      const size = sizeInfo(msg.size);
      if (view.imagesKey !== 'pending') {
        view.images.textContent = '';
        view.images.appendChild(h('div', { class: 'gen-placeholder', style: { aspectRatio: size?.ratio || '1 / 1' } },
          h('span', { class: 'spinner' }), h('span', {}, view.status || t('sidepanel.status.generatingImage'))));
        view.imagesKey = 'pending';
      }
      view.images.hidden = false;
    } else {
      const key = images.map((i) => `${i.src.length}:${i.src.slice(-24)}`).join('|');
      if (view.imagesKey !== key) {
        view.images.textContent = '';
        view.images.append(...generatedImages(images, msg));
        view.imagesKey = key;
      }
      view.images.hidden = !images.length;
    }

    // Notes
    let noteText = '';
    if (!streaming && !msg.error) {
      if (msg.stopped) noteText = t(msg.content || images.length ? 'sidepanel.message.stoppedPartial' : 'sidepanel.message.stopped');
      else if (!msg.content && !images.length) noteText = t(msg.reasoning ? 'sidepanel.message.reasoningOnly' : 'sidepanel.message.noAnswer');
      else if (msg.truncated) noteText = t('sidepanel.message.truncated');
    }
    view.note.textContent = noteText;
    view.note.hidden = !noteText;

    // Error
    const errorKey = msg.error || '';
    if (view.errorKey !== errorKey) {
      view.error.textContent = '';
      if (msg.error) {
        view.error.append(
          h('span', { class: 'msg-error-icon', html: icon('alert', { size: 16 }) }),
          h('div', { class: 'msg-error-body' },
            h('p', {}, msg.error),
            h('button', {
              type: 'button',
              class: 'btn btn-sm retry-btn',
              html: icon('refresh', { size: 14 }),
              onClick: () => handlers.onRetry(msg),
            }, t('sidepanel.message.retry'))));
      }
      view.errorKey = errorKey;
    }
    view.error.hidden = !msg.error;
  }

  // ---------------------------------------------------------------- list management

  function build(msg) {
    const view = msg.role === 'user' ? buildUser(msg) : buildAssistant(msg);
    views.set(msg.id, view);
    return view.el;
  }

  function refreshActions() {
    if (!chat) return;
    const busy = handlers.isBusy();
    const last = chat.messages[chat.messages.length - 1];
    for (const view of views.values()) {
      const m = view.msg;
      const isLast = m === last;
      view.el.classList.toggle('is-last', isLast);
      const bar = view.actions;
      if (!bar) continue;
      const copyBtn = bar.querySelector('[data-action="copy"]');
      if (copyBtn) copyBtn.hidden = !m.content;
      const regen = bar.querySelector('[data-action="regenerate"]');
      if (regen) {
        regen.hidden = !isLast;
        regen.disabled = busy;
      }
      const edit = bar.querySelector('[data-action="edit"]');
      if (edit) edit.disabled = busy;
      const del = bar.querySelector('[data-action="delete"]');
      if (del) del.disabled = busy;
      const retry = view.error?.querySelector('.retry-btn');
      if (retry) {
        retry.hidden = !isLast;
        retry.disabled = busy;
      }
      bar.hidden = m.id === busyId;
    }
  }

  function flush() {
    frame = 0;
    for (const id of dirty) {
      const view = views.get(id);
      if (!view) continue;
      if (view.msg.role === 'assistant') updateAssistant(view);
      else if (id !== editingId) fillUser(view);
    }
    dirty.clear();
    refreshActions();
    if (pinned) scroller.scrollTop = scroller.scrollHeight;
    updateScrollButton();
  }

  function schedule(msg) {
    dirty.add(msg.id);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  function flushNow() {
    if (frame) cancelAnimationFrame(frame);
    flush();
  }

  // ---------------------------------------------------------------- editing

  function startEdit(msgId) {
    const view = views.get(msgId);
    if (!view || view.msg.role !== 'user' || handlers.isBusy()) return false;
    cancelEdit();
    editingId = msgId;
    const msg = view.msg;
    const index = chat.messages.indexOf(msg);
    const later = index >= 0 ? chat.messages.length - index - 1 : 0;
    const input = h('textarea', { class: 'textarea edit-input', rows: 2, 'aria-label': t('sidepanel.edit.label') });
    input.value = msg.content;
    const cancel = () => {
      editingId = null;
      fillUser(view);
      refreshActions();
    };
    const save = () => {
      const text = input.value.trim();
      if (!text && !msg.attachments.length) {
        input.focus();
        return;
      }
      editingId = null;
      handlers.onEditSubmit(msg, text);
    };
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      } else if (event.key === 'Enter' && handlers.isSendKey(event)) {
        event.preventDefault();
        save();
      }
    });
    view.el.textContent = '';
    view.el.classList.add('editing');
    view.el.appendChild(h('div', { class: 'edit-box' },
      input,
      h('div', { class: 'edit-actions' },
        h('span', { class: 'edit-hint' }, later ? t('sidepanel.edit.replaces', { count: later }) : ''),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: cancel }, t('sidepanel.edit.cancel')),
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', html: icon('send', { size: 14 }), onClick: save }, t('sidepanel.edit.send')))));
    autosize(input, 280);
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    view.el.scrollIntoView({ block: 'nearest' });
    return true;
  }

  function cancelEdit() {
    if (!editingId) return false;
    const view = views.get(editingId);
    editingId = null;
    if (view) fillUser(view);
    refreshActions();
    return true;
  }

  // ---------------------------------------------------------------- public API

  return {
    render(nextChat) {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      dirty.clear();
      chat = nextChat;
      editingId = null;
      views.clear();
      list.textContent = '';
      for (const msg of chat?.messages || []) list.appendChild(build(msg));
      refreshActions();
      scrollToBottom();
    },
    append(msg, { status = '' } = {}) {
      const el = build(msg);
      if (status) this.setStatus(msg.id, status);
      list.appendChild(el);
      refreshActions();
      scrollToBottom();
    },
    update(msg) {
      schedule(msg);
    },
    updateNow(msg) {
      dirty.add(msg.id);
      flushNow();
    },
    remove(msgId) {
      const view = views.get(msgId);
      view?.el.remove();
      views.delete(msgId);
      if (editingId === msgId) editingId = null;
      refreshActions();
      updateScrollButton();
    },
    setBusy(msgId) {
      const prev = busyId;
      busyId = msgId || null;
      if (prev && views.has(prev)) {
        const view = views.get(prev);
        if (view.msg.role === 'assistant') {
          view.status = '';
          view.reasoning.open = false;
          dirty.add(prev);
        }
      }
      if (busyId && views.has(busyId)) {
        const view = views.get(busyId);
        if (view.reasoning) view.reasoning.open = true;
        dirty.add(busyId);
      }
      flushNow();
    },
    setStatus(msgId, text) {
      const view = views.get(msgId);
      if (!view || view.msg.role !== 'assistant') return;
      view.status = text || '';
      if (view.imagesKey === 'pending') view.imagesKey = null;
      dirty.add(msgId);
      if (!frame) frame = requestAnimationFrame(flush);
    },
    startEdit,
    cancelEdit,
    isEditing: () => Boolean(editingId),
    scrollToBottom,
    refreshActions,
    refreshLabels() {
      for (const view of views.values()) {
        if (view.msg.role !== 'assistant') continue;
        view.modelEl.textContent = handlers.providerLabel(view.msg);
        updateUsage(view);
      }
    },
  };
}
