// YouTube support: URL detection, timestamps, context formatting and the in-page extractor
// (run against mocked YouTube responses).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractYouTubeVideo, formatTimestamp, isVideoId, linkifyTimestamps, parseTimestamp, parseTimestampLink,
  parseYouTubeUrl, youTubeWatchUrl, describeVideoProblem,
} from '../src/lib/youtube.js';
import { registerCatalog, setLanguage } from '../src/lib/i18n.js';
import en from '../src/locales/en/index.js';
import { buildChatSystemPrompt, buildVideoSummaryPrompt, formatVideoContext } from '../src/lib/prompts.js';
import { normalizeSettings } from '../src/lib/settings.js';
import { chatToMarkdown } from '../src/sidepanel/export.js';

const ID = 'dQw4w9WgXcQ';

describe('parseYouTubeUrl', () => {
  test('recognises watch, short, live, embed and youtu.be links', () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/watch?app=desktop&v=${ID}&t=42s&list=PL1`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://youtube.com/shorts/${ID}`,
      `https://www.youtube.com/live/${ID}?si=abc`,
      `https://www.youtube.com/embed/${ID}`,
      `https://youtu.be/${ID}?t=10`,
    ]) assert.equal(parseYouTubeUrl(url), ID, url);
  });

  test('ignores other pages and invalid ids', () => {
    for (const url of [
      'https://www.youtube.com/', 'https://www.youtube.com/@kanal', 'https://www.youtube.com/results?search_query=x',
      'https://www.youtube.com/watch?v=kurz', `https://evil.example/watch?v=${ID}`, `https://notyoutube.com/watch?v=${ID}`,
      `javascript:alert(1)//youtube.com/watch?v=${ID}`, '', null,
    ]) assert.equal(parseYouTubeUrl(url), null, String(url));
  });

  test('watch URL and id check', () => {
    assert.equal(youTubeWatchUrl(ID), `https://www.youtube.com/watch?v=${ID}`);
    assert.equal(youTubeWatchUrl(ID, 75.9), `https://www.youtube.com/watch?v=${ID}&t=75s`);
    assert.ok(isVideoId(ID));
    assert.ok(!isVideoId('../../etc/x'));
  });
});

describe('timestamps', () => {
  test('format and parse', () => {
    assert.equal(formatTimestamp(0), '0:00');
    assert.equal(formatTimestamp(75), '1:15');
    assert.equal(formatTimestamp(3723), '1:02:03');
    assert.equal(parseTimestamp('1:15'), 75);
    assert.equal(parseTimestamp('01:02:03'), 3723);
    assert.equal(parseTimestamp('1:75'), null);
    assert.equal(parseTimestamp('abc'), null);
  });

  test('linkifyTimestamps links [m:ss] references, ranges and hours', () => {
    const md = linkifyTimestamps('- [0:00] Intro\n- [3:15 – 4:20] Teil\n- **[1:02:03]** Ende', ID);
    assert.ok(md.includes(`[0:00](https://www.youtube.com/watch?v=${ID})`));
    assert.ok(md.includes(`[3:15 – 4:20](https://www.youtube.com/watch?v=${ID}&t=195s)`));
    assert.ok(md.includes(`**[1:02:03](https://www.youtube.com/watch?v=${ID}&t=3723s)**`));
  });

  test('linkifyTimestamps leaves links, code and escaped brackets alone', () => {
    const src = [
      '[3:15](https://example.com) und [4:00][ref]',
      'Code: `[1:00]`',
      '```',
      '[2:00]',
      '```',
      '\\[5:00]',
    ].join('\n');
    assert.equal(linkifyTimestamps(src, ID), src);
    assert.equal(linkifyTimestamps('[1:00]', 'kaputt'), '[1:00]');
  });

  test('parseTimestampLink reads t= in seconds and h/m/s form', () => {
    assert.deepEqual(parseTimestampLink(`https://www.youtube.com/watch?v=${ID}&t=754s`), { videoId: ID, seconds: 754 });
    assert.deepEqual(parseTimestampLink(`https://youtu.be/${ID}?t=1h2m3s`), { videoId: ID, seconds: 3723 });
    assert.equal(parseTimestampLink(`https://www.youtube.com/watch?v=${ID}`), null);
    assert.equal(parseTimestampLink('https://example.com/?t=5'), null);
  });
});

describe('video prompts', () => {
  const video = {
    id: ID,
    url: youTubeWatchUrl(ID),
    title: 'Ein Testvideo',
    author: 'Kanal',
    lengthSeconds: 3723,
    description: 'Beschreibung',
    chapters: [{ start: 0, title: 'Intro' }, { start: 95, title: 'Hauptteil' }],
    transcript: { text: '[0:00] Hallo\n[0:20] Welt', language: 'Englisch', auto: true, truncated: true, coveredSeconds: 20 },
  };

  test('formatVideoContext contains metadata, chapters and transcript', () => {
    const ctx = formatVideoContext(video);
    const lines = ctx.split('\n');
    assert.ok(lines[0].startsWith('=== Videokontext'));
    assert.ok(lines.at(-1).startsWith('=== Ende des Videokontexts'));
    for (const part of ['Titel: Ein Testvideo', 'Kanal: Kanal', `URL: https://www.youtube.com/watch?v=${ID}`, 'Länge: 1:02:03',
      '[1:35] Hauptteil', 'Beschreibung:', 'Transkript (Englisch, automatisch erstellt)', '[0:20] Welt', 'reicht nur bis 0:20']) {
      assert.ok(ctx.includes(part), part);
    }
  });

  test('formatVideoContext without transcript says so', () => {
    const ctx = formatVideoContext({ ...video, transcript: null });
    assert.ok(ctx.includes('Kein Transkript verfügbar'));
    assert.equal(formatVideoContext({}), '');
  });

  test('summary prompt uses the chosen language and asks for timestamps', () => {
    const prompt = buildVideoSummaryPrompt('Spanisch');
    assert.ok(prompt.includes('auf Spanisch zusammen'));
    assert.ok(prompt.includes('[3:15]'));
    assert.ok(buildVideoSummaryPrompt('').includes('auf Deutsch'));
    // Settings store codes ('auto' = UI language); they become language names in the prompt.
    assert.ok(buildVideoSummaryPrompt('es').includes('auf Spanisch zusammen'));
    assert.ok(buildVideoSummaryPrompt('auto').includes('auf Deutsch zusammen'));
    assert.ok(buildVideoSummaryPrompt('zh-Hans').includes('auf Chinesisch (vereinfacht) zusammen'));
  });

  test('chat system prompt explains the video block and timestamp format', () => {
    assert.match(buildChatSystemPrompt({ chat: {} }), /„Videokontext“.*\[12:34\]/s);
  });

  test('settings keep the summary language', () => {
    assert.equal(normalizeSettings({}).youtube.summaryLang, 'auto');
    assert.equal(normalizeSettings({ youtube: { summaryLang: ' Englisch ' } }).youtube.summaryLang, 'en');
    assert.equal(normalizeSettings({ youtube: { summaryLang: 5 } }).youtube.summaryLang, 'auto');
  });

  test('markdown export links timestamps of video answers', () => {
    const md = chatToMarkdown({
      title: 'Video',
      messages: [{ role: 'assistant', content: '- [1:15] Punkt', video: { id: ID }, createdAt: 0, images: [] }],
    });
    assert.ok(md.includes(`[1:15](https://www.youtube.com/watch?v=${ID}&t=75s)`));
  });
});

// ---------------------------------------------------------------------------------------------
// extractYouTubeVideo against mocked YouTube responses

const CONTEXT = { client: { clientName: 'WEB', clientVersion: '2.20261105.01.00', hl: 'de' } };

function playerResponse({ tracks = [] } = {}) {
  return {
    videoDetails: {
      videoId: ID, title: 'Mein "Video" {mit} Klammern', author: 'Testkanal', lengthSeconds: '620',
      shortDescription: 'Zeile 1\nZeile 2', isLiveContent: false,
    },
    captions: tracks.length ? { playerCaptionsTracklistRenderer: { captionTracks: tracks } } : undefined,
  };
}

function initialData({ transcript = true } = {}) {
  return {
    playerOverlays: {
      decoratedPlayerBarRenderer: {
        markersMap: [{ value: { chapters: [
          { chapterRenderer: { title: { simpleText: 'Einleitung' }, timeRangeStartMillis: 0 } },
          { chapterRenderer: { title: { simpleText: 'Teil 2' }, timeRangeStartMillis: 125000 } },
        ] } }],
      },
    },
    engagementPanels: transcript ? [{
      engagementPanelSectionListRenderer: {
        content: { continuationItemRenderer: { continuationEndpoint: { getTranscriptEndpoint: { params: 'PARAMS123' } } } },
      },
    }] : [],
  };
}

function watchHtml({ player, data, stringData = false }) {
  const dataJs = stringData
    ? `var ytInitialData = '${JSON.stringify(data).replace(/[{}"]/g, (c) => `\\x${c.charCodeAt(0).toString(16)}`)}';`
    : `var ytInitialData = ${JSON.stringify(data)};`;
  return `<html><script>ytcfg.set({"INNERTUBE_API_KEY":"KEY1","INNERTUBE_CLIENT_VERSION":"2.20261105.01.00","INNERTUBE_CONTEXT_CLIENT_NAME":1,"INNERTUBE_CONTEXT":${JSON.stringify(CONTEXT)}});</script>`
    + `<script>window.ytInitialPlayerResponse = null; var ytInitialPlayerResponse = ${JSON.stringify(player)};var meta = 1;</script>`
    + `<script>${dataJs}</script></html>`;
}

const reply = (body, { status = 200 } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});

describe('extractYouTubeVideo', () => {
  const saved = {};
  let routes;
  let calls;

  beforeEach(() => {
    for (const key of ['location', 'fetch', 'document']) saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    routes = [];
    calls = [];
    Object.defineProperty(globalThis, 'location', {
      configurable: true, writable: true, value: { origin: 'https://www.youtube.com', href: `https://www.youtube.com/watch?v=${ID}`, pathname: '/watch' },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: { title: '(2) Fallback - YouTube', documentElement: { getAttribute: () => 'de-DE' }, querySelectorAll: () => [] },
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async (url, init = {}) => {
        calls.push({ url, init });
        const route = routes.find((r) => r.match(url, init));
        return route ? route.respond(url, init) : reply('', { status: 404 });
      },
    });
  });

  afterEach(() => {
    for (const [key, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  });

  const onWatch = (html) => routes.push({ match: (u) => u.includes('/watch?v='), respond: () => reply(html) });

  test('uses the caption track in the spoken language (json3) and groups lines with timestamps', async () => {
    onWatch(watchHtml({
      player: playerResponse({ tracks: [
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=de', languageCode: 'de', name: { simpleText: 'Deutsch' } },
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=en', languageCode: 'en', name: { simpleText: 'Englisch' } },
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=en&kind=asr', languageCode: 'en', kind: 'asr', name: { simpleText: 'Englisch (automatisch erzeugt)' } },
      ] }),
      data: initialData(),
    }));
    routes.push({
      match: (u) => u.includes('/api/timedtext') && u.includes('lang=en') && !u.includes('asr'),
      respond: () => reply({ events: [
        { tStartMs: 0, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
        { tStartMs: 5000, segs: [{ utf8: '\n' }] },
        { tStartMs: 8000, segs: [{ utf8: 'second part' }] },
        { tStartMs: 25000, segs: [{ utf8: 'new line' }] },
        { tStartMs: 3725000, segs: [{ utf8: 'late' }] },
      ] }),
    });
    const res = await extractYouTubeVideo(ID, {});
    assert.equal(res.ok, true);
    assert.equal(res.title, 'Mein "Video" {mit} Klammern');
    assert.equal(res.author, 'Testkanal');
    assert.equal(res.lengthSeconds, 620);
    assert.deepEqual(res.chapters, [{ start: 0, title: 'Einleitung' }, { start: 125, title: 'Teil 2' }]);
    assert.equal(res.transcript.source, 'captions');
    assert.equal(res.transcript.language, 'Englisch');
    assert.equal(res.transcript.auto, false);
    assert.equal(res.transcript.text, '[0:00] Hello world second part\n[0:25] new line\n[1:02:05] late');
    assert.ok(calls.some((c) => c.url.includes('fmt=json3')));
    assert.equal(res.problem, '');
  });

  test('falls back to the transcript endpoint when timedtext returns nothing', async () => {
    onWatch(watchHtml({
      player: playerResponse({ tracks: [{ baseUrl: '/api/timedtext?v=x&lang=de&kind=asr', languageCode: 'de', kind: 'asr' }] }),
      data: initialData(),
    }));
    routes.push({ match: (u) => u.includes('/api/timedtext'), respond: () => reply('') });
    routes.push({
      match: (u, init) => u.includes('/youtubei/v1/get_transcript') && init.method === 'POST',
      respond: () => reply({
        actions: [{ updateEngagementPanelAction: { content: { transcriptRenderer: { content: { transcriptSearchPanelRenderer: {
          body: { transcriptSegmentListRenderer: { initialSegments: [
            { transcriptSegmentRenderer: { startMs: '0', endMs: '4000', snippet: { runs: [{ text: 'Erster' }, { text: ' Satz' }] } } },
            { transcriptSegmentRenderer: { startMs: '61000', endMs: '64000', snippet: { simpleText: 'Zweiter Satz' } } },
          ] } },
          footer: { transcriptFooterRenderer: { languageMenu: { sortFilterSubMenuRenderer: { subMenuItems: [
            { title: 'Deutsch (automatisch erzeugt)', selected: true },
          ] } } } },
        } } } } } }],
      }),
    });
    const res = await extractYouTubeVideo(ID, {});
    assert.equal(res.transcript.source, 'transcript');
    assert.equal(res.transcript.text, '[0:00] Erster Satz\n[1:01] Zweiter Satz');
    assert.equal(res.transcript.language, 'Deutsch (automatisch erzeugt)');
    assert.equal(res.transcript.auto, true);
    const post = calls.find((c) => c.url.includes('get_transcript'));
    assert.ok(post.url.includes('key=KEY1'));
    const body = JSON.parse(post.init.body);
    assert.equal(body.params, 'PARAMS123');
    assert.deepEqual(body.context, CONTEXT);
    assert.equal(post.init.headers['X-Youtube-Client-Version'], '2.20261105.01.00');
  });

  test('reads string-encoded initial data (m.youtube.com) and truncates long transcripts', async () => {
    Object.assign(globalThis.location, { origin: 'https://m.youtube.com' });
    onWatch(watchHtml({ player: playerResponse({ tracks: [{ baseUrl: '/api/timedtext?asr', languageCode: 'en', kind: 'asr' }] }), data: initialData(), stringData: true }));
    const events = Array.from({ length: 400 }, (_, i) => ({ tStartMs: i * 30000, segs: [{ utf8: `Satz Nummer ${i} `.repeat(4) }] }));
    routes.push({ match: (u) => u.includes('/api/timedtext'), respond: () => reply({ events }) });
    const res = await extractYouTubeVideo(ID, { maxChars: 5000 });
    assert.ok(calls[0].url.startsWith('https://m.youtube.com/watch'));
    assert.equal(res.chapters.length, 2);
    assert.equal(res.transcript.truncated, true);
    assert.ok(res.transcript.text.length <= 5000);
    assert.equal(res.transcript.coveredSeconds, (res.transcript.lines - 1) * 30);
  });

  test('without any transcript: metadata only, with a problem note', async () => {
    onWatch(watchHtml({ player: playerResponse(), data: initialData({ transcript: false }) }));
    const res = await extractYouTubeVideo(ID, {});
    assert.equal(res.ok, true);
    assert.equal(res.transcript, null);
    // Codes inside the tab; the caller translates them.
    assert.equal(res.problem, 'no_transcript');
    assert.equal(describeVideoProblem(res.problem, res.problemParams), 'Für dieses Video gibt es kein Transkript.');
    assert.equal(res.description, 'Zeile 1\nZeile 2');
  });

  test('uses the open transcript panel as last resort', async () => {
    routes.push({ match: (u) => u.includes('/watch?v='), respond: () => reply('<html>nichts</html>') });
    globalThis.document.querySelectorAll = (sel) => (sel.includes('transcript-segment')
      ? [{ innerText: '0:05\nAus dem Panel' }, { innerText: '1:10:00\nSpät' }, { innerText: 'kaputt' }]
      : []);
    const res = await extractYouTubeVideo(ID, {});
    assert.equal(res.title, 'Fallback');
    assert.equal(res.transcript.source, 'panel');
    assert.equal(res.transcript.text, '[0:05] Aus dem Panel\n[1:10:00] Spät');
  });

  test('a page that cannot be loaded at all yields ok: false', async () => {
    const res = await extractYouTubeVideo(ID, {});
    assert.equal(res.ok, false);
    assert.equal(res.problem, 'watch_http');
    assert.deepEqual(res.problemParams, { status: 404 });
    assert.match(describeVideoProblem(res.problem, res.problemParams), /HTTP 404/);
    assert.equal((await extractYouTubeVideo('x', {})).ok, false);
  });

  test('problem codes are translated outside the tab (UI language)', () => {
    assert.equal(describeVideoProblem(''), '');
    assert.equal(describeVideoProblem(undefined), '');
    assert.equal(describeVideoProblem('invalid_id'), 'Keine gültige Video-ID.');
    assert.equal(describeVideoProblem('Alter Text.'), 'Alter Text.', 'unknown codes are passed through');
    registerCatalog('en', en);
    setLanguage('en');
    try {
      assert.equal(describeVideoProblem('no_transcript'), 'This video has no transcript.');
      assert.equal(describeVideoProblem('watch_http', { status: 500 }), 'The video page responded with HTTP 500.');
    } finally {
      setLanguage('de');
    }
  });

  test('is self-contained (serializable for scripting.executeScript)', async () => {
    const src = extractYouTubeVideo.toString();
    // eslint-disable-next-line no-new-func
    const clone = new Function(`return (${src});`)();
    onWatch(watchHtml({ player: playerResponse(), data: initialData({ transcript: false }) }));
    const res = await clone(ID, {});
    assert.equal(res.ok, true);
    assert.equal(res.author, 'Testkanal');
  });
});
