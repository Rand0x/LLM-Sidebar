// Server-Sent-Events reader for fetch() responses.
// Works in MV3 service workers, Firefox background pages, extension pages and Node (tests).

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Parses an SSE body into events.
 * Yields { event: string ('message' by default), data: string } per dispatched event.
 * Handles \n, \r\n and \r line endings (also split across chunks), multi-line data
 * (joined with \n), comment lines (':' prefix) and flushes the last event at EOF even
 * without a trailing blank line. The caller handles '[DONE]'.
 */
export async function* readSSE(response, { signal } = {}) {
  const body = response?.body ?? null;

  if (signal?.aborted) {
    try {
      await body?.cancel?.();
    } catch {
      // ignore
    }
    throw abortError();
  }

  const decoder = new TextDecoder('utf-8');
  const lineBreak = /\r\n?|\n/g;
  const queue = [];
  let buffer = '';
  let scanFrom = 0;
  let dataLines = [];
  let eventType = '';

  const processLine = (line) => {
    if (line === '') {
      if (dataLines.length) {
        queue.push({ event: eventType || 'message', data: dataLines.join('\n') });
      }
      dataLines = [];
      eventType = '';
      return;
    }
    if (line.charCodeAt(0) === 0x3a) return; // ':' comment / keep-alive
    const colon = line.indexOf(':');
    let field = line;
    let value = '';
    if (colon !== -1) {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charCodeAt(0) === 0x20) value = value.slice(1);
    }
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventType = value;
    // 'id' and 'retry' have no meaning for one-shot fetch streams.
  };

  const drain = (final) => {
    lineBreak.lastIndex = scanFrom;
    let start = 0;
    let pendingCR = false;
    let match;
    while ((match = lineBreak.exec(buffer)) !== null) {
      // A trailing '\r' may be the first half of '\r\n' – wait for the next chunk.
      if (!final && match[0] === '\r' && match.index === buffer.length - 1) {
        pendingCR = true;
        break;
      }
      processLine(buffer.slice(start, match.index));
      start = match.index + match[0].length;
    }
    if (start) buffer = buffer.slice(start);
    // Lines before scanFrom never contain terminators, so rescanning is unnecessary.
    scanFrom = pendingCR ? buffer.length - 1 : buffer.length;
    if (final) {
      if (buffer) processLine(buffer);
      buffer = '';
      scanFrom = 0;
      processLine(''); // dispatch a pending event at EOF
    }
  };

  // Bodiless responses (or exotic implementations): parse the full text at once.
  if (!body || typeof body.getReader !== 'function') {
    buffer = typeof response?.text === 'function' ? await response.text() : '';
    if (signal?.aborted) throw abortError();
    drain(true);
    for (const ev of queue.splice(0)) yield ev;
    return;
  }

  const reader = body.getReader();
  let streamDone = false;
  const onAbort = () => {
    reader.cancel(signal.reason).catch(() => {});
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });

  try {
    for (;;) {
      let result;
      try {
        result = await reader.read();
      } catch (err) {
        if (signal?.aborted) throw abortError();
        throw err;
      }
      if (signal?.aborted) throw abortError();
      if (result.done) {
        streamDone = true;
        break;
      }
      const chunk = result.value;
      if (chunk == null) continue;
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      drain(false);
      if (queue.length) {
        for (const ev of queue.splice(0)) {
          yield ev;
          if (signal?.aborted) throw abortError();
        }
      }
    }
    buffer += decoder.decode();
    drain(true);
    for (const ev of queue.splice(0)) {
      yield ev;
      if (signal?.aborted) throw abortError();
    }
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    if (!streamDone) {
      // Consumer stopped early, errored or aborted: release the connection.
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
