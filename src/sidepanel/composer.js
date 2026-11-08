// Composer: auto-growing input, image attachments (button / paste / drag & drop), send ⇄ stop,
// image-mode and page toggles.
import { h, autosize, toast } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { MAX_ATTACHMENTS, isImageFile, processImageFile, openImageInTab } from './attachments.js';
import { t } from '../lib/i18n.js';

// "/bild …" and "/image …" work in every UI language; hints show the localized command.
export const IMAGE_COMMAND = /^\/(bild|image)(?:\s+|$)/i;

/**
 * els: { box, input, sendBtn, attachBtn, imageBtn, pageBtn, fileInput, attachList, status, dropOverlay }
 * opts: { onSubmit(), onStop(), onEditLast() → bool, onToggleImage(), onTogglePage(), isSendKey(event),
 *         onInput(text) }
 */
export function createComposer(els, opts) {
  const { box, input, sendBtn, attachBtn, imageBtn, pageBtn, fileInput, attachList, status, dropOverlay } = els;
  let attachments = [];
  let busy = false;
  let imageMode = false;
  let chatPlaceholder = null; // null = default placeholder
  let processing = 0;
  const resize = autosize(input, 220);

  function hasContent() {
    return Boolean(input.value.trim()) || attachments.length > 0;
  }

  function refreshSend() {
    if (busy) {
      sendBtn.disabled = false;
      sendBtn.classList.add('is-stop');
      sendBtn.innerHTML = icon('stop', { size: 16 });
      sendBtn.title = t('sidepanel.composer.stopHint');
      sendBtn.setAttribute('aria-label', t('sidepanel.composer.stop'));
      return;
    }
    sendBtn.classList.remove('is-stop');
    sendBtn.innerHTML = icon(imageMode || IMAGE_COMMAND.test(input.value) ? 'sparkles' : 'arrow-up', { size: 17 });
    const label = t(imageMode || IMAGE_COMMAND.test(input.value) ? 'sidepanel.composer.generateImage' : 'sidepanel.composer.send');
    sendBtn.title = `${label} (${opts.sendHint?.() || 'Enter'})`;
    sendBtn.setAttribute('aria-label', label);
    sendBtn.disabled = !hasContent() || processing > 0;
  }

  function renderAttachments() {
    attachList.textContent = '';
    attachList.hidden = attachments.length === 0 && processing === 0;
    attachments.forEach((a, index) => {
      attachList.appendChild(h('div', { class: 'attach-item', title: a.name },
        h('button', {
          type: 'button',
          class: 'attach-thumb',
          'aria-label': t('sidepanel.attachments.view', { name: a.name }),
          onClick: () => openImageInTab(a.dataUrl),
        }, h('img', { src: a.dataUrl, alt: '' })),
        h('button', {
          type: 'button',
          class: 'attach-remove',
          title: t('sidepanel.attachments.remove'),
          'aria-label': t('sidepanel.attachments.removeNamed', { name: a.name }),
          html: icon('x', { size: 12 }),
          onClick: () => {
            attachments.splice(index, 1);
            renderAttachments();
            refreshSend();
            input.focus();
          },
        })));
    });
    for (let i = 0; i < processing; i += 1) {
      attachList.appendChild(h('div', { class: 'attach-item attach-loading', 'aria-label': t('sidepanel.attachments.processing') }, h('span', { class: 'spinner' })));
    }
    attachBtn.classList.toggle('has-items', attachments.length > 0);
  }

  async function addFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const images = files.filter(isImageFile);
    if (images.length < files.length) {
      toast(t(images.length ? 'sidepanel.attachments.onlyImagesIgnored' : 'sidepanel.attachments.onlyImages'), { type: 'warning' });
    }
    const free = MAX_ATTACHMENTS - attachments.length - processing;
    if (free <= 0) {
      toast(t('sidepanel.attachments.max', { max: MAX_ATTACHMENTS }), { type: 'warning' });
      return;
    }
    if (images.length > free) {
      toast(t('sidepanel.attachments.maxSkipped', { max: MAX_ATTACHMENTS, count: images.length - free }), { type: 'warning' });
    }
    const batch = images.slice(0, free);
    processing += batch.length;
    renderAttachments();
    refreshSend();
    await Promise.all(batch.map(async (file, i) => {
      try {
        const item = await processImageFile(file, t('sidepanel.attachments.imageN', { n: attachments.length + i + 1 }));
        attachments.push(item);
      } catch (err) {
        toast(err?.message || t('sidepanel.attachments.processFailed'), { type: 'error' });
      } finally {
        processing -= 1;
        renderAttachments();
        refreshSend();
      }
    }));
  }

  // ---------------------------------------------------------------- events

  input.addEventListener('input', () => {
    refreshSend();
    opts.onInput?.(input.value);
  });

  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && opts.isSendKey(event)) {
      event.preventDefault();
      if (!busy && hasContent() && processing === 0) opts.onSubmit();
      return;
    }
    if (event.key === 'ArrowUp' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
      && !input.value && !attachments.length) {
      if (opts.onEditLast?.()) event.preventDefault();
    }
  });

  input.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])].filter(isImageFile);
    if (!files.length) return;
    // Keep text pastes untouched; only intercept when the clipboard carries images.
    const text = event.clipboardData.getData('text/plain');
    if (!text) event.preventDefault();
    addFiles(files);
  });

  sendBtn.addEventListener('click', () => {
    if (busy) opts.onStop();
    else if (hasContent() && processing === 0) opts.onSubmit();
  });
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });
  imageBtn.addEventListener('click', () => opts.onToggleImage());
  pageBtn.addEventListener('click', () => opts.onTogglePage());
  box.addEventListener('click', (event) => {
    if (event.target === box) input.focus();
  });

  // Drag & drop anywhere in the panel.
  let dragDepth = 0;
  const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    dropOverlay.hidden = false;
  });
  document.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropOverlay.hidden = true;
  });
  document.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    addFiles(event.dataTransfer.files);
    input.focus();
  });

  refreshSend();
  renderAttachments();

  return {
    getText: () => input.value,
    setText(text, { append = false, focus = true } = {}) {
      const value = String(text ?? '');
      input.value = append && input.value.trim() ? `${input.value.replace(/\s+$/, '')}\n\n${value}` : value;
      resize();
      refreshSend();
      opts.onInput?.(input.value);
      if (focus) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      }
    },
    focus() {
      input.focus({ preventScroll: true });
    },
    getAttachments: () => attachments.map((a) => ({ type: 'image', dataUrl: a.dataUrl, name: a.name, mimeType: a.mimeType })),
    isProcessing: () => processing > 0,
    clear() {
      input.value = '';
      attachments = [];
      resize();
      renderAttachments();
      refreshSend();
      opts.onInput?.('');
    },
    clearText() {
      input.value = '';
      resize();
      refreshSend();
      opts.onInput?.('');
    },
    addFiles,
    setBusy(value) {
      busy = Boolean(value);
      box.classList.toggle('is-busy', busy);
      refreshSend();
    },
    setImageMode(value) {
      imageMode = Boolean(value);
      imageBtn.setAttribute('aria-pressed', String(imageMode));
      imageBtn.title = t(imageMode ? 'sidepanel.image.exitMode' : 'sidepanel.composer.imageModeHint');
      imageBtn.setAttribute('aria-label', t(imageMode ? 'sidepanel.image.exitMode' : 'sidepanel.composer.imageMode'));
      box.classList.toggle('image-mode', imageMode);
      input.placeholder = imageMode ? t('sidepanel.composer.placeholderImage') : (chatPlaceholder || t('sidepanel.composer.placeholder'));
      pageBtn.hidden = imageMode;
      refreshSend();
    },
    /** Chat placeholder (e.g. while a page selection is referenced); null restores the default. */
    setChatPlaceholder(text) {
      chatPlaceholder = typeof text === 'string' && text ? text : null;
      if (!imageMode) input.placeholder = chatPlaceholder || t('sidepanel.composer.placeholder');
    },
    setPage({ on, available, title }) {
      pageBtn.setAttribute('aria-pressed', String(Boolean(on)));
      pageBtn.classList.toggle('unavailable', !available);
      pageBtn.title = title;
      pageBtn.setAttribute('aria-label', t(on ? 'sidepanel.composer.pageOn' : 'sidepanel.composer.page'));
    },
    setStatus(text, { tone = 'info' } = {}) {
      status.textContent = '';
      status.hidden = !text;
      status.dataset.tone = tone;
      if (text) {
        status.append(h('span', { class: 'composer-status-icon', html: icon(tone === 'image' ? 'image' : 'info', { size: 13 }) }), h('span', { class: 'truncate' }, text));
      }
    },
    refresh: refreshSend,
  };
}
