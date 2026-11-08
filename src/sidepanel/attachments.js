// Image attachments: validation and conversion. Every provider accepts JPEG and PNG (xAI accepts
// nothing else, Gemini no GIF), so all other formats (WebP, GIF → first frame, BMP, AVIF, SVG …)
// are re-encoded; large images are downscaled (max 1600 px, JPEG 0.9 unless transparent → PNG).
import { readFileAsDataUrl } from '../lib/utils.js';
import { t } from '../lib/i18n.js';

export const MAX_ATTACHMENTS = 6;
const MAX_DIMENSION = 1600;
const MAX_INPUT_BYTES = 40 * 1024 * 1024;
const PASSTHROUGH_BYTES = 3.5 * 1024 * 1024;
const PASSTHROUGH_TYPES = new Set(['image/jpeg', 'image/png']);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico|tiff?)$/i;
// Raster formats that may be opened or saved from a data: URL (never HTML, SVG or scripts).
const SAFE_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;

/** True when a file of this MIME type and size can be sent unchanged. */
export function canPassThrough({ type, width, height, size }) {
  return PASSTHROUGH_TYPES.has(String(type || '').toLowerCase())
    && Math.max(width, height) <= MAX_DIMENSION
    && size <= PASSTHROUGH_BYTES;
}

export function isImageFile(file) {
  if (!file) return false;
  return /^image\//i.test(file.type || '') || IMAGE_EXT.test(file.name || '');
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = url;
  });
}

function hasTransparency(ctx, width, height) {
  let data;
  try {
    data = ctx.getImageData(0, 0, width, height).data;
  } catch {
    return true; // unreadable → keep PNG to be safe
  }
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}

function baseName(name) {
  return String(name || '').replace(/\.[^.]+$/, '') || t('sidepanel.image.filePrefix');
}

/** → { type: 'image', dataUrl, name, mimeType, width, height } ; throws an Error with a translated message. */
export async function processImageFile(file, fallbackName = t('sidepanel.image.label')) {
  const name = file?.name || fallbackName;
  if (!isImageFile(file)) throw new Error(t('sidepanel.attachments.notImage', { name }));
  if (file.size > MAX_INPUT_BYTES) throw new Error(t('sidepanel.attachments.tooLarge', { name }));

  const url = URL.createObjectURL(file);
  try {
    let img;
    try {
      img = await loadImage(url);
    } catch {
      throw new Error(t('sidepanel.attachments.unreadable', { name }));
    }
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) throw new Error(t('sidepanel.attachments.invalidSize', { name }));

    const type = String(file.type || '').toLowerCase();
    if (canPassThrough({ type, width, height, size: file.size })) {
      return { type: 'image', dataUrl: await readFileAsDataUrl(file), name, mimeType: type, width, height };
    }

    const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const hgt = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error(t('sidepanel.attachments.processFailed'));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, hgt);

    const keepPng = type !== 'image/jpeg' && hasTransparency(ctx, w, hgt);
    const mimeType = keepPng ? 'image/png' : 'image/jpeg';
    let dataUrl = '';
    try {
      dataUrl = canvas.toDataURL(mimeType, 0.9);
    } catch {
      // e.g. a tainted canvas (SVG with external content)
    }
    if (!dataUrl.startsWith(`data:${mimeType}`)) throw new Error(t('sidepanel.attachments.convertFailed', { name }));
    const ext = keepPng ? 'png' : 'jpg';
    return { type: 'image', dataUrl, name: `${baseName(name)}.${ext}`, mimeType, width: w, height: hgt };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Image data URL → object URL (for opening images in a new tab; data: URLs are blocked as
 * top-level navigations). Only raster image types – an HTML or SVG blob would become a document
 * in the extension's origin. Returns '' otherwise.
 */
export function dataUrlToObjectUrl(dataUrl) {
  const match = /^data:([^;,]+)?((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
  if (!match) return '';
  const mime = String(match[1] || '').trim().toLowerCase();
  if (!SAFE_IMAGE_MIME.test(mime)) return '';
  let bytes;
  try {
    if (match[3]) {
      const binary = atob(match[4].replace(/\s+/g, ''));
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(match[4]));
    }
  } catch {
    return '';
  }
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

export function extensionForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'png';
}

export function mimeOfDataUrl(src) {
  const match = /^data:([^;,]+)/.exec(String(src || ''));
  return match ? match[1] : '';
}

/** Opens an image (data: or http(s):) in a new tab via a user-initiated anchor click. */
export function openImageInTab(src) {
  let url = src;
  let revoke = false;
  if (/^data:/i.test(src)) {
    url = dataUrlToObjectUrl(src);
    revoke = true;
  } else if (!/^https?:/i.test(src)) {
    return false;
  }
  if (!url) return false;
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

/** Downloads an image; returns false when the source cannot be saved directly. */
export async function downloadImage(src, filenameBase = t('sidepanel.image.filePrefix')) {
  const a = document.createElement('a');
  let url = src;
  let revoke = false;
  let ext = 'png';
  if (/^data:/i.test(src)) {
    ext = extensionForMime(mimeOfDataUrl(src));
    url = dataUrlToObjectUrl(src);
    if (!url) return false;
    revoke = true;
  } else if (/^https?:/i.test(src)) {
    try {
      const res = await fetch(src, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      if (!SAFE_IMAGE_MIME.test(String(blob.type || '').split(';')[0].trim())) throw new Error('not an image');
      ext = extensionForMime(blob.type);
      url = URL.createObjectURL(blob);
      revoke = true;
    } catch {
      return openImageInTab(src);
    }
  } else {
    return false;
  }
  a.href = url;
  a.download = `${filenameBase}.${ext}`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(url), 20000);
  return true;
}
