// Chat → Markdown export.

import { isVideoId, linkifyTimestamps } from '../lib/youtube.js';
import { t } from '../lib/i18n.js';
import { fullDateTime } from './format.js';

function fence(text) {
  // Use a fence longer than any backtick run inside the text.
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

// Drops blank lines around a block (never inside it – code keeps its spacing), so blocks are
// separated by exactly one empty line.
function block(text) {
  return String(text ?? '').replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
}

function quote(text) {
  return String(text).split('\n').map((line) => `> ${line}`).join('\n');
}

export function chatFilename(chat, extension = 'md') {
  const slug = String(chat?.title || 'chat')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/ß/g, 'ss')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'chat';
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${slug}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.${extension}`;
}

/** labelFor(msg) → 'Provider · Model' for assistant messages. Labels follow the UI language. */
export function chatToMarkdown(chat, { labelFor = () => '' } = {}) {
  const lines = [`# ${chat.title || 'Chat'}`, ''];
  const created = fullDateTime(chat.createdAt || Date.now());
  lines.push(`_${t('sidepanel.export.meta', { date: fullDateTime(Date.now()), created })}_`, '');

  for (const msg of chat.messages || []) {
    lines.push('---', '');
    const time = fullDateTime(msg.createdAt || Date.now());
    if (msg.role === 'user') {
      lines.push(`### ${t(msg.kind === 'image' ? 'sidepanel.export.youImage' : 'sidepanel.export.you')} · ${time}`, '');
      if (msg.page && (msg.page.title || msg.page.url)) {
        const title = msg.page.title || msg.page.url;
        const page = /^https?:/i.test(msg.page.url || '') ? `[${title}](${msg.page.url})` : title;
        lines.push(quote(t('sidepanel.export.page', { page })), '');
      }
      if (msg.quote?.text) {
        const source = msg.quote.title || msg.quote.url;
        const label = source && /^https?:/i.test(msg.quote.url || '') ? `[${source}](${msg.quote.url})` : source;
        lines.push(quote(label ? t('sidepanel.export.quoteOn', { source: label }) : t('sidepanel.export.quote')), '>', quote(msg.quote.text), '');
      }
      if (msg.attachments?.length) {
        const names = msg.attachments.map((a, i) => a?.name || t('sidepanel.attachments.imageN', { n: i + 1 })).join(', ');
        lines.push(quote(t('sidepanel.export.attached', { names })), '');
      }
      const content = block(msg.content);
      if (content) {
        // User text is plain text: keep it verbatim inside a fence when it contains markdown-ish syntax.
        const plain = !/[`*_#>\[\]|<-]/.test(content);
        if (plain) lines.push(content, '');
        else {
          const f = fence(content);
          lines.push(`${f}text`, content, f, '');
        }
      }
    } else {
      const label = labelFor(msg);
      lines.push(`### ${t('sidepanel.export.assistant')}${label ? ` (${label})` : ''} · ${time}`, '');
      const reasoning = block(msg.reasoning);
      if (reasoning) {
        lines.push(`<details><summary>${t('sidepanel.export.reasoning')}</summary>`, '', reasoning, '', '</details>', '');
      }
      const content = block(msg.content);
      if (content) lines.push(isVideoId(msg.video?.id) ? linkifyTimestamps(content, msg.video.id) : content, '');
      const images = (msg.images || []).filter((img) => typeof img?.src === 'string' && img.src);
      for (const [i, img] of images.entries()) {
        const alt = typeof img.prompt === 'string' && img.prompt ? img.prompt.replace(/[\[\]\n]/g, ' ').slice(0, 120) : t('sidepanel.attachments.imageN', { n: i + 1 });
        lines.push(`![${alt}](${img.src})`, '');
      }
      if (msg.stopped) lines.push(`_${t('sidepanel.export.stopped')}_`, '');
      if (msg.error) lines.push(quote(t('sidepanel.export.error', { error: msg.error })), '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
