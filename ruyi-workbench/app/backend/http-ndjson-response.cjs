'use strict';

function createHttpNdjsonResponse(req, res, nowIso) {
  let deltaBuffer = [];
  let flushTimer = null;
  const closed = () => res.writableEnded || res.destroyed;

  function takeDeltas() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    const pending = deltaBuffer;
    deltaBuffer = [];
    return pending;
  }

  function emit(event) {
    try { res.write(`${JSON.stringify({ ...event, ts: nowIso() })}\n`); } catch { /* Client disconnected. */ }
  }

  function flushDeltas() {
    const pending = takeDeltas();
    if (!pending.length || closed()) return;
    const merged = [];
    for (const event of pending) {
      const previous = merged[merged.length - 1];
      if (previous && previous.type === event.type) previous.text = (previous.text || '') + (event.text || '');
      else merged.push({ ...event });
    }
    for (const event of merged) emit(event);
  }

  function writeEvent(event) {
    if (closed()) return;
    if (event && (event.type === 'assistant_delta' || event.type === 'thinking_delta')) {
      deltaBuffer.push(event);
      if (!flushTimer) flushTimer = setTimeout(flushDeltas, 50);
      return;
    }
    // Emit buffered deltas before the event that ends their batch.
    flushDeltas();
    if (!closed()) emit(event);
  }

  function start() {
    try { req.socket.setNoDelay(true); } catch { /* No socket in in-memory callers. */ }
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    try { res.flushHeaders(); } catch { /* Client disconnected. */ }
    res.on('error', () => {});
    res.on('close', takeDeltas);
  }

  return { start, writeEvent, flushDeltas };
}

module.exports = { createHttpNdjsonResponse };
