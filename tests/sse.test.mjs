import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSSE } from '../src/lib/sse.js';

// Builds a Response whose body delivers `text` in byte chunks of the given sizes (cycled).
function chunkedResponse(input, sizes = [7]) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const chunks = [];
  for (let i = 0, k = 0; i < bytes.length; k += 1) {
    const n = sizes[k % sizes.length];
    chunks.push(bytes.slice(i, i + n));
    i += n;
  }
  const state = { cancelled: false, pulls: 0 };
  const body = new ReadableStream({
    pull(controller) {
      state.pulls += 1;
      if (chunks.length) controller.enqueue(chunks.shift());
      else controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  return { response, state };
}

async function collect(response, opts) {
  const out = [];
  for await (const ev of readSSE(response, opts)) out.push(ev);
  return out;
}

test('parses basic events with default and custom event names', async () => {
  const { response } = chunkedResponse('data: hello\n\nevent: ping\ndata: {"a":1}\n\n');
  assert.deepEqual(await collect(response), [
    { event: 'message', data: 'hello' },
    { event: 'ping', data: '{"a":1}' },
  ]);
});

test('handles \\r\\n, \\r and \\n line endings, also mixed', async () => {
  const text = 'data: a\r\n\r\ndata: b\r\rdata: c\n\nevent: x\r\ndata: d\r\n\n';
  for (const sizes of [[1], [2], [3, 1], [100]]) {
    const { response } = chunkedResponse(text, sizes);
    assert.deepEqual(await collect(response), [
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
      { event: 'message', data: 'c' },
      { event: 'x', data: 'd' },
    ], `chunk sizes ${sizes}`);
  }
});

test('a \\r\\n split across chunks is one line break, not two', async () => {
  // Chunk boundary right between \r and \n of the first line.
  const text = 'data: first\r\ndata: second\r\n\r\n';
  const { response } = chunkedResponse(text, [12, 100]);
  assert.deepEqual(await collect(response), [{ event: 'message', data: 'first\nsecond' }]);
});

test('joins multi-line data with \\n and keeps empty data lines', async () => {
  const { response } = chunkedResponse('data: line1\ndata:line2\ndata\ndata: \ndata: end\n\n');
  assert.deepEqual(await collect(response), [{ event: 'message', data: 'line1\nline2\n\n\nend' }]);
});

test('ignores comments, unknown fields and events without data', async () => {
  const text = ': OPENROUTER PROCESSING\n\n:keep-alive\nid: 5\nretry: 100\nfoo: bar\ndata: x\n\nevent: lonely\n\n';
  const { response } = chunkedResponse(text, [5]);
  assert.deepEqual(await collect(response), [{ event: 'message', data: 'x' }]);
});

test('only strips a single leading space from values', async () => {
  const { response } = chunkedResponse('data:   spaced\n\n');
  assert.deepEqual(await collect(response), [{ event: 'message', data: '  spaced' }]);
});

test('flushes the final event at EOF without trailing blank line', async () => {
  const { response: r1 } = chunkedResponse('data: one\n\ndata: two');
  assert.deepEqual(await collect(r1), [
    { event: 'message', data: 'one' },
    { event: 'message', data: 'two' },
  ]);
  const { response: r2 } = chunkedResponse('event: done\ndata: last\r');
  assert.deepEqual(await collect(r2), [{ event: 'done', data: 'last' }]);
});

test('decodes multi-byte UTF-8 characters split across chunks', async () => {
  const text = 'data: Grüße € 😀 – 日本語\n\ndata: ✓ fertig\n\n';
  for (const sizes of [[1], [2], [3], [5, 1, 2]]) {
    const { response } = chunkedResponse(text, sizes);
    assert.deepEqual(await collect(response), [
      { event: 'message', data: 'Grüße € 😀 – 日本語' },
      { event: 'message', data: '✓ fertig' },
    ], `chunk sizes ${sizes}`);
  }
});

test('strips a UTF-8 BOM at the start of the stream', async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('data: bom\n\n')]);
  const { response } = chunkedResponse(bytes, [1]);
  assert.deepEqual(await collect(response), [{ event: 'message', data: 'bom' }]);
});

test('aborting cancels the reader and throws AbortError', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let sent = false;
  const body = new ReadableStream({
    pull(c) {
      if (!sent) {
        sent = true;
        c.enqueue(new TextEncoder().encode('data: first\n\n'));
        return undefined;
      }
      return new Promise(() => {}); // never delivers more data
    },
    cancel() {
      cancelled = true;
    },
  });
  const seen = [];
  await assert.rejects(async () => {
    for await (const ev of readSSE(new Response(body), { signal: controller.signal })) {
      seen.push(ev.data);
      setTimeout(() => controller.abort(), 5);
    }
  }, (err) => err.name === 'AbortError');
  assert.deepEqual(seen, ['first']);
  assert.equal(cancelled, true);
});

test('an already aborted signal throws immediately', async () => {
  const controller = new AbortController();
  controller.abort();
  const { response, state } = chunkedResponse('data: x\n\n');
  await assert.rejects(collect(response, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(state.cancelled, true);
});

test('breaking out of the loop cancels the underlying stream', async () => {
  const { response, state } = chunkedResponse('data: 1\n\ndata: 2\n\ndata: 3\n\n', [9]);
  for await (const ev of readSSE(response)) {
    assert.equal(ev.data, '1');
    break;
  }
  assert.equal(state.cancelled, true);
});

test('works for responses without a stream body', async () => {
  const response = { body: null, text: async () => 'data: plain\n\n' };
  assert.deepEqual(await collect(response), [{ event: 'message', data: 'plain' }]);
});

test('propagates stream read errors', async () => {
  let pulls = 0;
  const body = new ReadableStream({
    pull(c) {
      pulls += 1;
      if (pulls === 1) c.enqueue(new TextEncoder().encode('data: ok\n\n'));
      else c.error(new TypeError('network error'));
    },
  });
  const seen = [];
  await assert.rejects(async () => {
    for await (const ev of readSSE(new Response(body))) seen.push(ev.data);
  }, TypeError);
  assert.deepEqual(seen, ['ok']);
});
