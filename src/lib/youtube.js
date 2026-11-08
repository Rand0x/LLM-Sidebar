// YouTube support: video detection, transcript extraction and clickable timestamps.
// Pure module (no browser APIs at load time). `extractYouTubeVideo` and `seekYouTubeVideo` are
// serialized by scripting.executeScript and run inside the YouTube tab, so they MUST stay
// self-contained: no imports, no closures over module scope. They report problems as codes
// (see VIDEO_PROBLEM_KEYS), which describeVideoProblem() translates outside the tab.

import { t } from './i18n.js';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOST_RE = /^(?:www\.|m\.)?youtube\.com$/i;

/** True for a syntactically valid YouTube video id (11 characters of [A-Za-z0-9_-]). */
export function isVideoId(id) {
  return typeof id === 'string' && VIDEO_ID_RE.test(id);
}

/**
 * The video id of a YouTube video page, or null. Recognised: youtube.com/watch?v=…,
 * /shorts/…, /live/…, /embed/… (www. and m.), youtu.be/….
 */
export function parseYouTubeUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  let id = null;
  if (host === 'youtu.be') {
    id = u.pathname.split('/')[1] || null;
  } else if (YOUTUBE_HOST_RE.test(host)) {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(?:shorts|live|embed)\/([^/?#]+)/.exec(u.pathname);
      id = m ? m[1] : null;
    }
  }
  return isVideoId(id) ? id : null;
}

/** Canonical watch URL (no tracking parameters), optionally starting at `seconds`. */
export function youTubeWatchUrl(videoId, seconds = null) {
  const base = `https://www.youtube.com/watch?v=${videoId}`;
  return Number.isFinite(seconds) && seconds > 0 ? `${base}&t=${Math.floor(seconds)}s` : base;
}

/** 75 → '1:15', 3723 → '1:02:03'. */
export function formatTimestamp(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** '1:15' → 75, '1:02:03' → 3723; null for anything else. */
export function parseTimestamp(text) {
  const m = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const [h, min, s] = [Number(m[1] || 0), Number(m[2]), Number(m[3])];
  if (s > 59 || (m[1] && min > 59)) return null;
  return h * 3600 + min * 60 + s;
}

/** { videoId, seconds } for a YouTube link with a start time (t= / start=), else null. */
export function parseTimestampLink(href) {
  const videoId = parseYouTubeUrl(href);
  if (!videoId) return null;
  let raw = '';
  try {
    const u = new URL(href);
    raw = u.searchParams.get('t') || u.searchParams.get('start') || '';
  } catch {
    return null;
  }
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(raw.trim());
  if (!raw || !m) return null;
  const seconds = Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  return { videoId, seconds };
}

const TIMESTAMP = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}`;
// "[12:34]" or a range "[12:34 – 15:00]" that is not already a markdown link ("[..](" / "[..][").
const TIMESTAMP_REF_RE = new RegExp(String.raw`\[(${TIMESTAMP})(\s*[-–—]\s*${TIMESTAMP})?\](?![(\[])`, 'g');

/**
 * Turns timestamp references like "[12:34]" in model output into markdown links to that position
 * of the video. Code spans and fenced code blocks stay untouched.
 */
export function linkifyTimestamps(markdown, videoId) {
  const text = typeof markdown === 'string' ? markdown : '';
  if (!text || !isVideoId(videoId) || !text.includes(':')) return text;
  const replaceIn = (chunk) => chunk.replace(TIMESTAMP_REF_RE, (all, start, range, offset, whole) => {
    if (offset > 0 && whole[offset - 1] === '\\') return all; // escaped "\[12:34]"
    const seconds = parseTimestamp(start);
    if (seconds == null) return all;
    return `[${start}${range ? range.replace(/\s+/g, ' ') : ''}](${youTubeWatchUrl(videoId, seconds)})`;
  });
  let fence = null;
  return text.split('\n').map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return line;
    }
    if (marker) {
      fence = marker[1];
      return line;
    }
    // Odd parts are inline code spans.
    return line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : replaceIn(part))).join('');
  }).join('\n');
}

/**
 * Reads metadata and transcript of a YouTube video. Runs INSIDE the YouTube tab (same origin, so
 * the user's cookies and consent apply) and never throws.
 *
 * Strategies for the transcript, in order:
 *  1. the caption track listed in the player response (timedtext, json3 or XML),
 *  2. the transcript endpoint the "Transkript anzeigen" panel uses (youtubei get_transcript),
 *  3. the transcript panel, if the user has opened it on the page.
 *
 * → { ok: true, id, url, title, author, lengthSeconds, isLive, description, chapters: [{ start, title }],
 *     transcript: { text, language, auto, source, truncated, coveredSeconds, lines } | null,
 *     problem: '' | problem code, problemParams }
 *   | { ok: false, problem: problem code, problemParams }
 * Problem codes: invalid_id, watch_http ({ status }), watch_failed, unreadable, transcript_failed,
 * no_transcript – describeVideoProblem() turns them into a sentence in the UI language.
 */
export async function extractYouTubeVideo(videoId, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 1000 ? Math.floor(opts.maxChars) : 120000;
  const lineSeconds = Number.isFinite(opts.lineSeconds) && opts.lineSeconds > 0 ? opts.lineSeconds : 20;
  const lineChars = 300;
  const id = String(videoId || '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return { ok: false, problem: 'invalid_id', problemParams: {} };

  const origin = /^https:\/\/(?:www\.|m\.)?youtube\.com$/i.test(location.origin) ? location.origin : 'https://www.youtube.com';

  // Firefox: content.fetch() sends the request as the page itself (same origin, page cookies).
  const doFetch = async (url, init) => {
    try {
      // eslint-disable-next-line no-undef
      if (typeof content === 'object' && content && typeof content.fetch === 'function') {
        // eslint-disable-next-line no-undef
        return await content.fetch(url, init);
      }
    } catch {
      // fall back to the content script's own fetch
    }
    return fetch(url, init);
  };

  const clean = (value) => String(value == null ? '' : value)
    .replace(/[​‌‍⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const textOf = (t) => {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (typeof t.simpleText === 'string') return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map((r) => (r && typeof r.text === 'string' ? r.text : '')).join('');
    if (t.content && typeof t.content === 'string') return t.content;
    return '';
  };

  // Decodes a JS string literal body ('…' / "…") as YouTube writes it on m.youtube.com.
  const decodeJsString = (body) => body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_, e) => {
    if (e[0] === 'x' || (e[0] === 'u' && e.length === 5)) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === 'n') return '\n';
    if (e === 'r') return '\r';
    if (e === 't') return '\t';
    return e;
  });

  // Finds `name = {…}` / `"name": {…}` / `name = '…json…'` in a page source and parses the JSON.
  const findJson = (source, name) => {
    let from = 0;
    for (let guard = 0; guard < 50; guard++) {
      const at = source.indexOf(name, from);
      if (at < 0) return null;
      from = at + name.length;
      const sep = /^\s*["']?\]?\s*[=:]\s*/.exec(source.slice(from, from + 20));
      if (!sep) continue;
      const start = from + sep[0].length;
      const first = source[start];
      if (first === '{') {
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let i = start; i < source.length; i++) {
          const c = source[i];
          if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
          }
          if (c === '"') inStr = true;
          else if (c === '{') depth++;
          else if (c === '}') {
            depth--;
            if (depth === 0) {
              try {
                return JSON.parse(source.slice(start, i + 1));
              } catch {
                break;
              }
            }
          }
        }
      } else if (first === "'" || first === '"') {
        let i = start + 1;
        for (; i < source.length; i++) {
          if (source[i] === '\\') i++;
          else if (source[i] === first) break;
        }
        try {
          return JSON.parse(decodeJsString(source.slice(start + 1, i)));
        } catch {
          // keep looking
        }
      }
    }
    return null;
  };

  // All values stored under `key` anywhere in a JSON tree (document order for arrays).
  const collect = (root, key, limit = 20000) => {
    const out = [];
    const stack = [root];
    let visited = 0;
    while (stack.length && visited < 400000) {
      const node = stack.pop();
      visited++;
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
        continue;
      }
      const keys = Object.keys(node);
      for (let i = keys.length - 1; i >= 0; i--) {
        const value = node[keys[i]];
        if (keys[i] === key) {
          out.push(value);
          if (out.length >= limit) return out;
        }
        if (value && typeof value === 'object') stack.push(value);
      }
    }
    return out;
  };

  const problems = [];

  // ---- watch page: player response, initial data, client config
  let html = '';
  try {
    const res = await doFetch(`${origin}/watch?v=${id}`, { credentials: 'include' });
    if (res.ok) html = await res.text();
    else problems.push({ code: 'watch_http', params: { status: res.status } });
  } catch {
    problems.push({ code: 'watch_failed', params: {} });
  }
  let player = html ? findJson(html, 'ytInitialPlayerResponse') : null;
  if (player && player.videoDetails && player.videoDetails.videoId && player.videoDetails.videoId !== id) player = null;
  const initialData = html ? findJson(html, 'ytInitialData') : null;
  const cfgString = (name) => {
    const m = new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`).exec(html);
    return m ? m[1] : '';
  };
  const apiKey = cfgString('INNERTUBE_API_KEY');
  const clientVersion = cfgString('INNERTUBE_CLIENT_VERSION');
  const clientNameNum = (/"INNERTUBE_CONTEXT_CLIENT_NAME"\s*:\s*(\d+)/.exec(html) || [])[1] || '1';
  let innertubeContext = html ? findJson(html, '"INNERTUBE_CONTEXT"') : null;
  if (!innertubeContext || typeof innertubeContext !== 'object' || !innertubeContext.client) {
    innertubeContext = {
      client: {
        clientName: 'WEB',
        clientVersion: clientVersion || '2.20261101.00.00',
        hl: (document.documentElement.getAttribute('lang') || 'de').split('-')[0],
      },
    };
  }

  // ---- metadata
  const details = (player && player.videoDetails) || {};
  const micro = (player && player.microformat && player.microformat.playerMicroformatRenderer) || {};
  let title = clean(details.title || textOf(micro.title));
  if (!title) {
    title = clean(String(document.title || '').replace(/\s*-\s*YouTube\s*$/i, '').replace(/^\(\d+\)\s*/, ''));
  }
  const author = clean(details.author || micro.ownerChannelName || '');
  const lengthSeconds = Number(details.lengthSeconds) || Number(micro.lengthSeconds) || 0;
  const isLive = details.isLive === true || details.isLiveContent === true;
  let description = String(details.shortDescription || textOf(micro.description) || '').replace(/\r\n?/g, '\n').trim();
  if (description.length > 5000) description = `${description.slice(0, 5000).trimEnd()} …`;

  const chapters = [];
  const seenChapters = new Set();
  for (const ch of collect(initialData, 'chapterRenderer', 500)) {
    if (!ch || typeof ch !== 'object') continue;
    const start = Math.floor(Number(ch.timeRangeStartMillis) / 1000);
    const chTitle = clean(textOf(ch.title));
    if (!Number.isFinite(start) || !chTitle || seenChapters.has(start)) continue;
    seenChapters.add(start);
    chapters.push({ start, title: chTitle.slice(0, 200) });
  }
  chapters.sort((a, b) => a.start - b.start);

  // ---- transcript
  let segments = null; // [{ start (s), text }]
  let language = '';
  let auto = false;
  let source = '';

  const tracks = (player && player.captions && player.captions.playerCaptionsTracklistRenderer
    && Array.isArray(player.captions.playerCaptionsTracklistRenderer.captionTracks))
    ? player.captions.playerCaptionsTracklistRenderer.captionTracks.filter((t) => t && typeof t.baseUrl === 'string')
    : [];

  if (tracks.length) {
    // The automatic track tells the spoken language; a manual track in that language is better.
    const asr = tracks.find((t) => t.kind === 'asr');
    const spoken = asr ? String(asr.languageCode || '') : '';
    const base = (code) => String(code || '').toLowerCase().split(/[-_]/)[0];
    const manual = tracks.filter((t) => t.kind !== 'asr');
    const pick = (spoken && (manual.find((t) => t.languageCode === spoken) || manual.find((t) => base(t.languageCode) === base(spoken))))
      || asr || manual[0];
    try {
      const url = new URL(pick.baseUrl, origin);
      url.searchParams.set('fmt', 'json3');
      const res = await doFetch(url.href, { credentials: 'include' });
      const body = res.ok ? await res.text() : '';
      const parsed = [];
      if (body.trim().startsWith('{')) {
        const data = JSON.parse(body);
        for (const ev of Array.isArray(data.events) ? data.events : []) {
          if (!ev || !Array.isArray(ev.segs)) continue;
          const text = ev.segs.map((s) => (s && typeof s.utf8 === 'string' ? s.utf8 : '')).join('');
          if (clean(text)) parsed.push({ start: (Number(ev.tStartMs) || 0) / 1000, text });
        }
      } else if (body.trim().startsWith('<')) {
        const doc = new DOMParser().parseFromString(body, 'text/xml');
        for (const node of doc.querySelectorAll('text, p')) {
          const start = node.hasAttribute('start') ? Number(node.getAttribute('start')) : Number(node.getAttribute('t')) / 1000;
          const text = String(node.textContent || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
          if (Number.isFinite(start) && clean(text)) parsed.push({ start, text });
        }
      }
      if (parsed.length) {
        segments = parsed;
        language = clean(textOf(pick.name)) || String(pick.languageCode || '');
        auto = pick.kind === 'asr';
        source = 'captions';
      }
    } catch {
      // try the next strategy
    }
  }

  if (!segments && initialData) {
    const endpoint = collect(initialData, 'getTranscriptEndpoint', 20).find((e) => e && typeof e.params === 'string');
    if (endpoint) {
      try {
        const res = await doFetch(`${origin}/youtubei/v1/get_transcript?prettyPrint=false${apiKey ? `&key=${encodeURIComponent(apiKey)}` : ''}`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Youtube-Client-Name': clientNameNum,
            'X-Youtube-Client-Version': (innertubeContext.client && innertubeContext.client.clientVersion) || clientVersion || '2.20261101.00.00',
          },
          body: JSON.stringify({ context: innertubeContext, params: endpoint.params }),
        });
        if (res.ok) {
          const data = await res.json();
          const parsed = [];
          for (const seg of collect(data, 'transcriptSegmentRenderer')) {
            if (!seg || typeof seg !== 'object') continue;
            const text = textOf(seg.snippet);
            const start = Number(seg.startMs) / 1000;
            if (Number.isFinite(start) && clean(text)) parsed.push({ start, text });
          }
          if (parsed.length) {
            segments = parsed;
            source = 'transcript';
            const selected = collect(data, 'subMenuItems', 5).flat().find((item) => item && item.selected);
            language = selected ? clean(textOf(selected.title)) : '';
            auto = /auto|automatisch/i.test(language);
          }
        }
      } catch {
        // try the next strategy
      }
    }
  }

  if (!segments) {
    // The transcript panel the user opened on the page (only if it shows this video).
    let current = '';
    try {
      current = new URL(location.href).searchParams.get('v') || (/\/(?:shorts|live)\/([^/?#]+)/.exec(location.pathname) || [])[1] || '';
    } catch {
      current = '';
    }
    if (current === id) {
      const parsed = [];
      for (const el of document.querySelectorAll('ytd-transcript-segment-renderer, transcript-segment-view-model')) {
        const raw = String(el.innerText || el.textContent || '').trim();
        const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+([\s\S]+)$/.exec(raw);
        if (!m) continue;
        const start = Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        if (clean(m[4])) parsed.push({ start, text: m[4] });
      }
      if (parsed.length) {
        segments = parsed;
        source = 'panel';
      }
    }
  }

  let transcript = null;
  if (segments) {
    segments.sort((a, b) => a.start - b.start);
    const fmt = (sec) => {
      const total = Math.max(0, Math.floor(sec));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const pad = (n) => String(n).padStart(2, '0');
      return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    };
    // Groups the short caption snippets into lines of ~20 s, each starting with its timestamp.
    const lines = [];
    let cur = null;
    let lastText = '';
    for (const seg of segments) {
      const text = clean(seg.text);
      if (!text || text === lastText) continue;
      lastText = text;
      if (!cur || seg.start - cur.start >= lineSeconds || cur.text.length >= lineChars) {
        if (cur) lines.push(cur);
        cur = { start: seg.start, text };
      } else {
        cur.text += ` ${text}`;
      }
    }
    if (cur) lines.push(cur);

    let text = '';
    let truncated = false;
    let coveredSeconds = 0;
    let count = 0;
    for (const line of lines) {
      const entry = `[${fmt(line.start)}] ${line.text}`;
      if (text.length + entry.length + 1 > maxChars) {
        truncated = true;
        break;
      }
      text += (text ? '\n' : '') + entry;
      coveredSeconds = line.start;
      count++;
    }
    if (text) transcript = { text, language, auto, source, truncated, coveredSeconds: Math.floor(coveredSeconds), lines: count };
  }

  if (!player && !transcript && !html) {
    const first = problems[0] || { code: 'unreadable', params: {} };
    return { ok: false, problem: first.code, problemParams: first.params };
  }
  let problem = '';
  if (!transcript) {
    problem = tracks.length || (initialData && collect(initialData, 'getTranscriptEndpoint', 1).length)
      ? 'transcript_failed'
      : 'no_transcript';
  }

  return {
    ok: true,
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title,
    author,
    lengthSeconds,
    isLive,
    description,
    chapters,
    transcript,
    problem,
    problemParams: {},
  };
}

const VIDEO_PROBLEM_KEYS = {
  invalid_id: 'core.youtube.invalidId',
  watch_http: 'core.youtube.watchHttp',
  watch_failed: 'core.youtube.watchFailed',
  unreadable: 'core.youtube.unreadable',
  transcript_failed: 'core.youtube.transcriptFailed',
  no_transcript: 'core.youtube.noTranscript',
};

/**
 * Sentence (UI language) for a problem code reported by extractYouTubeVideo; '' for no problem.
 * Unknown codes are returned unchanged (older extractors reported German sentences).
 */
export function describeVideoProblem(code, params) {
  if (typeof code !== 'string' || !code) return '';
  const key = Object.hasOwn(VIDEO_PROBLEM_KEYS, code) ? VIDEO_PROBLEM_KEYS[code] : null;
  return key ? t(key, params && typeof params === 'object' ? params : undefined) : code;
}

/** Jumps to `seconds` in the video playing in this tab. Runs INSIDE the YouTube tab. */
export function seekYouTubeVideo(videoId, seconds) {
  let current = '';
  try {
    current = new URL(location.href).searchParams.get('v') || (/\/(?:shorts|live)\/([^/?#]+)/.exec(location.pathname) || [])[1] || '';
  } catch {
    current = '';
  }
  if (current !== videoId) return false;
  const video = document.querySelector('#movie_player video.html5-main-video')
    || document.querySelector('#movie_player video')
    || document.querySelector('video.html5-main-video')
    || document.querySelector('video');
  if (!video) return false;
  video.currentTime = Math.max(0, Number(seconds) || 0);
  try {
    const played = video.play();
    if (played && typeof played.catch === 'function') played.catch(() => {});
  } catch {
    // autoplay may be blocked – the position is set anyway
  }
  return true;
}
