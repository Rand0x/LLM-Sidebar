// Quick actions, personas and prompt builders. Pure module (no browser APIs).
//
// Texts sent to the model live in src/locales/{de,en}/prompts.js (prompts.* keys). They exist in
// German and English only: German UI → German prompts, every other UI language → English
// (promptLanguage()). Names and labels of built-in items are normal UI strings (t()).
// Stored quick actions / personas whose prompt still equals a default (in any prompt language)
// are sent in the current prompt language; edited prompts are used exactly as stored.

import { formatTimestamp } from './youtube.js';
import { getLanguage, format, t, onLanguageChanged } from './i18n.js';
import { AUTO_TARGET, TARGET_LANGUAGE_CODES, languageNameForPrompt } from './languages.js';
import dePrompts from '../locales/de/prompts.js';
import enPrompts from '../locales/en/prompts.js';

/** Languages the default prompts exist in. */
export const PROMPT_LANGUAGES = ['de', 'en'];
const PROMPT_CATALOGS = { de: dePrompts, en: enPrompts };

/** Language of the default prompts: German UI → German prompts, every other UI language → English. */
export function promptLanguage() {
  return getLanguage() === 'de' ? 'de' : 'en';
}

/** 'de' / 'en' as given; undefined → the current prompt language; anything else → English. */
function resolvePromptLanguage(lang) {
  if (lang === undefined || lang === null || lang === '') return promptLanguage();
  return lang === 'de' ? 'de' : 'en';
}

/** A prompt text in `lang` (not through t(): prompts must not depend on the UI catalog chain). */
function promptText(key, lang, params) {
  const template = PROMPT_CATALOGS[resolvePromptLanguage(lang)][key] ?? dePrompts[key] ?? key;
  return params ? format(template, params) : template;
}

const TEXT_BLOCK = '<text>\n{{text}}\n</text>';

// ---------- default quick actions & personas ----------

const QUICK_ACTION_DEFS = [
  { id: 'improve', icon: '✨', toolbar: true, contextMenu: true },
  { id: 'rewrite', icon: '🔁', toolbar: true, contextMenu: true },
  { id: 'grammar', icon: '✅', toolbar: true, contextMenu: true },
  { id: 'shorten', icon: '✂️', toolbar: false, contextMenu: true },
  { id: 'expand', icon: '➕', toolbar: false, contextMenu: true },
  { id: 'formal', icon: '🎩', toolbar: false, contextMenu: true },
  { id: 'casual', icon: '😊', toolbar: false, contextMenu: true },
  { id: 'personalize', icon: '👤', toolbar: false, contextMenu: true },
  { id: 'summarize', icon: '📝', toolbar: true, contextMenu: true },
  { id: 'explain', icon: '💡', toolbar: true, contextMenu: true },
  { id: 'reply', icon: '↩️', toolbar: false, contextMenu: true },
  { id: 'translate', icon: '🌐', toolbar: true, contextMenu: true },
];
export const DEFAULT_QUICK_ACTION_IDS = QUICK_ACTION_DEFS.map((a) => a.id);
export const DEFAULT_PERSONA_IDS = ['default', 'coder', 'translator', 'editor', 'researcher', 'teacher'];

/** Fresh copies of the built-in quick actions with names and prompts in `lang` ('de' / 'en'). */
export function getDefaultQuickActions(lang = promptLanguage()) {
  return QUICK_ACTION_DEFS.map(({ id, icon, toolbar, contextMenu }) => ({
    id,
    name: promptText(`prompts.action.${id}.name`, lang),
    icon,
    prompt: promptText(`prompts.action.${id}.prompt`, lang),
    toolbar,
    contextMenu,
    builtin: true,
  }));
}

/** Fresh copies of the built-in personas in `lang` ('de' / 'en'); 'default' has no prompt. */
export function getDefaultPersonas(lang = promptLanguage()) {
  return DEFAULT_PERSONA_IDS.map((id) => ({
    id,
    name: promptText(`prompts.persona.${id}.name`, lang),
    prompt: id === 'default' ? '' : promptText(`prompts.persona.${id}.prompt`, lang),
  }));
}

/** True when `value` equals the default text of `key` in any prompt language (or the active UI catalog). */
function isDefaultText(key, value, { includeUi = false } = {}) {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (!clean) return false;
  if (PROMPT_LANGUAGES.some((lang) => PROMPT_CATALOGS[lang][key]?.trim() === clean)) return true;
  return includeUi && t(key).trim() === clean;
}

// Built-in items keep following the UI language as long as they are not renamed.
// TODO(i18n): names of other registered catalogs (e.g. a stored French name after switching to
// Spanish) are only recognized when i18n.js offers a way to look a key up in every catalog;
// stored names are always German or English defaults today, so this does not happen.
function displayName(kind, ids, item) {
  const name = typeof item?.name === 'string' ? item.name : '';
  const id = item?.id;
  if (!ids.includes(id) || item.builtin === false) return name;
  const key = `prompts.${kind}.${id}.name`;
  return !name.trim() || isDefaultText(key, name, { includeUi: true }) ? t(key) : name;
}

/** Display name of a quick action (built-in, unrenamed actions follow the UI language). */
export function quickActionName(action) {
  return displayName('action', DEFAULT_QUICK_ACTION_IDS, action);
}

/** Display name of a persona (built-in, unrenamed personas follow the UI language). */
export function personaName(persona) {
  return displayName('persona', DEFAULT_PERSONA_IDS, persona);
}

/**
 * The prompt template sent for a quick action: an empty prompt or an unchanged default (German or
 * English) of a built-in action → the default in `lang`; edited prompts are returned as stored.
 */
export function effectivePrompt(action, lang = promptLanguage()) {
  const prompt = typeof action?.prompt === 'string' ? action.prompt : '';
  const id = action?.id;
  if (!DEFAULT_QUICK_ACTION_IDS.includes(id)) return prompt;
  const key = `prompts.action.${id}.prompt`;
  return !prompt.trim() || isDefaultText(key, prompt) ? promptText(key, lang) : prompt;
}

/** Persona prompt: an unchanged default (German or English) → the default in `lang`. */
export function effectivePersonaPrompt(persona, lang = promptLanguage()) {
  const prompt = typeof persona?.prompt === 'string' ? persona.prompt : '';
  const id = persona?.id;
  if (id === 'default' || !DEFAULT_PERSONA_IDS.includes(id)) return prompt;
  const key = `prompts.persona.${id}.prompt`;
  return isDefaultText(key, prompt) ? promptText(key, lang) : prompt;
}

/** System prompt for quick actions. */
export function actionSystemPrompt(lang = promptLanguage()) {
  return promptText('prompts.action.system', lang);
}

/**
 * "Summarize this page" prompt; the summary language is `target` (code, 'auto' = UI language,
 * or free text).
 */
export function summarizePagePrompt(lang = promptLanguage(), target = AUTO_TARGET) {
  const l = resolvePromptLanguage(lang);
  return promptText('prompts.summarizePage', l, { language: languageNameForPrompt(target, l) });
}

// Welcome chips of the side panel. Chips with `action` trigger a feature instead of sending
// `prompt` ('translatePage' = translate the active tab, 'image' = switch to image mode).
export function getSuggestions(lang = promptLanguage()) {
  const chip = (id, icon, prompt, includePage, action) => ({
    id, icon, label: t(`prompts.suggestion.${id}.label`), prompt, includePage, ...(action ? { action } : {}),
  });
  return [
    chip('summarize', '📝', summarizePagePrompt(lang), true),
    chip('keyPoints', '🎯', promptText('prompts.suggestion.keyPoints.prompt', lang), true),
    chip('explainSimply', '💡', promptText('prompts.suggestion.explainSimply.prompt', lang), true),
    chip('review', '🔍', promptText('prompts.suggestion.review.prompt', lang), true),
    chip('translatePage', '🌐', '', false, 'translatePage'),
    chip('image', '🖼️', '', false, 'image'),
  ];
}

// ---------- deprecated exports (transition) ----------
// Live bindings that follow the active language; new code should call the functions above.

/** @deprecated Use languageOptions()/TARGET_LANGUAGE_CODES from languages.js. */
export const LANGUAGES = TARGET_LANGUAGE_CODES;
/** @deprecated Use getDefaultQuickActions(). */
export let DEFAULT_QUICK_ACTIONS = [];
/** @deprecated Use getDefaultPersonas(). */
export let DEFAULT_PERSONAS = [];
/** @deprecated Use actionSystemPrompt(). */
export let ACTION_SYSTEM_PROMPT = '';
/** @deprecated Use summarizePagePrompt(). */
export let SUMMARIZE_PAGE_PROMPT = '';
/** @deprecated Use getSuggestions(). */
export let SUGGESTIONS = [];

function refreshDeprecatedExports() {
  DEFAULT_QUICK_ACTIONS = getDefaultQuickActions();
  DEFAULT_PERSONAS = getDefaultPersonas();
  ACTION_SYSTEM_PROMPT = actionSystemPrompt();
  SUMMARIZE_PAGE_PROMPT = summarizePagePrompt();
  SUGGESTIONS = getSuggestions();
}
refreshDeprecatedExports();
onLanguageChanged(refreshDeprecatedExports);

// ---------- request builders ----------

export function fillTemplate(template, vars = {}) {
  const values = vars && typeof vars === 'object' ? vars : {};
  // Single pass: substituted values are never re-scanned, so user text containing {{x}} stays as is.
  return String(template ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, name) => {
    const value = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
    return value == null ? '' : String(value);
  });
}

export function profileText(settings, lang = promptLanguage()) {
  const profile = settings?.profile ?? {};
  const aboutMe = typeof profile.aboutMe === 'string' ? profile.aboutMe.trim() : '';
  const writingStyle = typeof profile.writingStyle === 'string' ? profile.writingStyle.trim() : '';
  const parts = [];
  if (aboutMe) parts.push(`${promptText('prompts.profile.aboutMe', lang)}\n${aboutMe}`);
  if (writingStyle) parts.push(`${promptText('prompts.profile.writingStyle', lang)}\n${writingStyle}`);
  return parts.join('\n\n');
}

function resolveAction(action, lang) {
  if (typeof action === 'string') return getDefaultQuickActions(lang).find((a) => a.id === action) ?? null;
  return action && typeof action === 'object' ? action : null;
}

// Title and URL are controlled by the page: they go into the user message as JSON-quoted data,
// never into the system prompt.
function pageHint(page, lang) {
  const title = typeof page?.title === 'string' ? page.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const url = typeof page?.url === 'string' ? page.url.trim().slice(0, 500) : '';
  if (!title && !url) return '';
  const data = {};
  if (title) data[lang === 'de' ? 'titel' : 'title'] = title;
  if (url) data.url = url;
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return promptText('prompts.action.pageHint', lang, { json });
}

/**
 * `lang` (target language for {{lang}}): a code ('de', 'zh-Hans'), 'auto' (= UI language) or
 * free text (also old German names); it becomes a language name in the prompt language.
 */
export function buildActionRequest(action, { text = '', lang, profile, instruction, previous, page } = {}) {
  const pl = promptLanguage();
  const resolved = resolveAction(action, pl);
  if (!resolved) throw new Error(t('prompts.error.unknownAction'));

  let template = effectivePrompt(resolved, pl);
  if (!template.trim()) template = TEXT_BLOCK;
  // Custom templates without {{text}} still need the selected text.
  if (!/\{\{\s*text\s*\}\}/.test(template)) template = `${template.trimEnd()}\n\n${TEXT_BLOCK}`;

  const profileValue = typeof profile === 'string' && profile.trim() ? profile.trim() : promptText('prompts.profile.fallback', pl);
  const filled = fillTemplate(template, {
    text: String(text ?? ''),
    lang: languageNameForPrompt(lang, pl),
    profile: profileValue,
    title: typeof page?.title === 'string' ? page.title : '',
    url: typeof page?.url === 'string' ? page.url : '',
  }).trim();
  const hint = pageHint(page, pl);
  const userContent = hint ? `${hint}\n\n${filled}` : filled;

  const instr = typeof instruction === 'string' ? instruction.trim() : '';
  const prev = typeof previous === 'string' ? previous.trim() : '';

  let messages;
  if (instr && prev) {
    messages = [
      { role: 'user', content: userContent },
      { role: 'assistant', content: prev },
      { role: 'user', content: promptText('prompts.action.revise', pl, { instruction: instr }) },
    ];
  } else if (instr) {
    messages = [{ role: 'user', content: `${userContent}\n\n${promptText('prompts.action.extraInstruction', pl, { instruction: instr })}` }];
  } else {
    messages = [{ role: 'user', content: userContent }];
  }
  return { system: actionSystemPrompt(pl), messages };
}

export function buildTranslateRequest(text, lang) {
  const translate = getDefaultQuickActions().find((a) => a.id === 'translate');
  return buildActionRequest(translate, { text, lang });
}

function cleanSegment(segment) {
  return String(segment ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    // Neutralize marker look-alikes inside the text so they cannot break parsing.
    .replace(/[[［]{2}\s*(\d+)\s*[\]］]{2}/g, '[$1]')
    .trim();
}

/** `lang`: code, 'auto' (= UI language) or free text, see buildActionRequest. */
export function buildSegmentsRequest(segments, lang) {
  const pl = promptLanguage();
  const list = Array.isArray(segments) ? segments : [];
  const language = languageNameForPrompt(lang, pl);
  const lines = list.map((segment, i) => `[[${i + 1}]] ${cleanSegment(segment)}`);
  const count = list.length;
  // No literal markers in the header: an echoed header must not look like segment output.
  const header = count === 1
    ? promptText('prompts.segments.headerOne', pl, { language })
    : promptText('prompts.segments.headerOther', pl, { count, language });
  return {
    system: promptText('prompts.segments.system', pl, { language }),
    messages: [{ role: 'user', content: `${header}\n\n${lines.join('\n')}` }],
  };
}

export function parseSegmentsResponse(output, count) {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  const result = new Array(n).fill(null);
  if (typeof output !== 'string' || !n) return result;

  // Drop code-fence lines; tolerate "[[ 3 ]]" and full-width brackets.
  const text = output.replace(/\r\n?/g, '\n').replace(/^[ \t]*(```|~~~).*$/gm, '');
  const marker = /[[［]{2}\s*(\d+)\s*[\]］]{2}/g;
  const all = [...text.matchAll(marker)].map((m) => ({
    m,
    lineStart: !text.slice(text.lastIndexOf('\n', m.index - 1) + 1, m.index).trim(),
  }));
  // A marker at a line start beats the same number inside a line (e.g. an echoed instruction);
  // inline markers still count when the model put several segments on one line.
  const atLineStart = new Set(all.filter((x) => x.lineStart).map((x) => Number(x.m[1])));
  const matches = all.filter((x) => x.lineStart || !atLineStart.has(Number(x.m[1]))).map((x) => x.m);

  for (let i = 0; i < matches.length; i++) {
    const index = Number(matches[i][1]) - 1;
    if (index < 0 || index >= n || result[index] !== null) continue;
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    // A blank line ends the segment (drops trailing chatter); remaining line breaks become spaces.
    const value = text.slice(start, end).trim().split(/\n[ \t]*\n/)[0].replace(/\s*\n\s*/g, ' ').trim();
    if (value) result[index] = value;
  }
  return result;
}

function resolvePersona(settings, persona) {
  const personas = Array.isArray(settings?.personas) ? settings.personas : [];
  if (persona && typeof persona === 'object') return persona;
  const id = typeof persona === 'string' && persona ? persona : settings?.chat?.personaId;
  return personas.find((p) => p?.id === id) ?? personas.find((p) => p?.id === 'default') ?? null;
}

export function buildChatSystemPrompt(settings, persona) {
  const pl = promptLanguage();
  const parts = [];
  const resolved = resolvePersona(settings, persona);
  const personaPrompt = effectivePersonaPrompt(resolved, pl).trim();
  parts.push(personaPrompt || promptText('prompts.chat.base', pl));

  const globalPrompt = typeof settings?.chat?.systemPrompt === 'string' ? settings.chat.systemPrompt.trim() : '';
  if (globalPrompt) parts.push(globalPrompt);

  if (settings?.chat?.useProfileInChat) {
    const profile = profileText(settings, pl);
    if (profile) parts.push(promptText('prompts.chat.profile', pl, { profile }));
  }

  // The date belongs to the prompt, so it is written in the prompt language.
  const date = new Date().toLocaleDateString(pl, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  parts.push([
    promptText('prompts.chat.date', pl, { date }),
    promptText('prompts.chat.markdown', pl),
    promptText('prompts.chat.pageContext', pl),
    promptText('prompts.chat.selection', pl),
    promptText('prompts.chat.video', pl),
  ].join('\n'));

  return parts.join('\n\n');
}

export function formatPageContext(page) {
  if (!page || typeof page !== 'object') return '';
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const title = str(page.title);
  const url = str(page.url);
  const description = str(page.description);
  const selection = str(page.selection);
  const text = str(page.text);
  if (!title && !url && !selection && !text) return '';

  const pl = promptLanguage();
  const p = (key, value) => promptText(`prompts.pageContext.${key}`, pl, value === undefined ? undefined : { value });
  const lines = [p('start')];
  if (title) lines.push(p('title', title));
  if (url) lines.push(`URL: ${url}`);
  if (description) lines.push(p('description', description));
  if (selection) lines.push('', p('selection'), selection);
  if (text) lines.push('', p('text'), text);
  if (page.truncated) lines.push('', p('truncated'));
  lines.push(p('end'));
  return lines.join('\n');
}

/**
 * A YouTube video (result of extractYouTubeVideo) as context block for the model: metadata,
 * chapters, description and the transcript with [m:ss] timestamps ('' without title and id).
 */
export function formatVideoContext(video) {
  if (!video || typeof video !== 'object') return '';
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const title = str(video.title);
  const url = str(video.url);
  if (!title && !url) return '';
  const pl = promptLanguage();
  const p = (key, params) => promptText(`prompts.videoContext.${key}`, pl, params);
  const lines = [p('start')];
  if (title) lines.push(p('title', { value: title }));
  if (str(video.author)) lines.push(p('channel', { value: str(video.author) }));
  if (url) lines.push(`URL: ${url}`);
  if (Number(video.lengthSeconds) > 0) lines.push(p('length', { value: formatTimestamp(Number(video.lengthSeconds)) }));
  if (video.isLive) lines.push(p('live'));
  const chapters = Array.isArray(video.chapters) ? video.chapters.filter((c) => c && str(c.title)) : [];
  if (chapters.length) {
    lines.push('', p('chapters'));
    for (const c of chapters) lines.push(`[${formatTimestamp(Number(c.start) || 0)}] ${str(c.title)}`);
  }
  if (str(video.description)) lines.push('', p('description'), str(video.description));
  const transcript = video.transcript && typeof video.transcript === 'object' && str(video.transcript.text) ? video.transcript : null;
  if (transcript) {
    const lang = str(transcript.language);
    const kind = transcript.auto && !/auto/i.test(lang) ? p('autoGenerated') : '';
    const info = [lang, kind].filter(Boolean).join(', ');
    lines.push('', info ? p('transcriptWithInfo', { info }) : p('transcript'), str(transcript.text));
    if (transcript.truncated) {
      lines.push('', p('truncated', { time: formatTimestamp(Number(transcript.coveredSeconds) || 0) }));
    }
  } else {
    lines.push('', p('noTranscript'));
  }
  lines.push(p('end'));
  return lines.join('\n');
}

/**
 * User prompt for a video summary in `lang` (the language the user picked: code, 'auto' = UI
 * language, or free text).
 */
export function buildVideoSummaryPrompt(lang) {
  const pl = promptLanguage();
  return promptText('prompts.videoSummary', pl, { language: languageNameForPrompt(lang, pl) });
}

/** The quoted page selection of a chat message as a block for the model ('' without text). */
export function formatSelectionQuote(quote) {
  if (!quote || typeof quote !== 'object') return '';
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const text = str(quote.text);
  if (!text) return '';
  const title = str(quote.title);
  const url = str(quote.url);
  const pl = promptLanguage();
  const lines = [promptText('prompts.quote.start', pl)];
  if (title) lines.push(promptText('prompts.quote.page', pl, { value: title }));
  if (url) lines.push(`URL: ${url}`);
  if (title || url) lines.push('');
  lines.push(text);
  if (quote.truncated) lines.push('', promptText('prompts.quote.truncated', pl));
  lines.push(promptText('prompts.quote.end', pl));
  return lines.join('\n');
}
