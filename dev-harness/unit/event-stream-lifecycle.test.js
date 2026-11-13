'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createEventStream } = require('../../ruyi-workbench/app/backend/event-stream.cjs');
test('SSE shutdown ends clients, unsubscribes sources, clears replay and refuses reopening', async () => {
  const hooks = {}, taps = new Set(), sources = new Set();
  const subscribe = set => fn => { set.add(fn); return () => set.delete(fn); };
  const service = createEventStream({ EventStreamHooks: hooks, RUYI_EVENTS: { subscribe: subscribe(sources) },
    subscribeActiveChildEvents: subscribe(taps), activeChildren: new Map(), URL, OVERLAY_ID: 'fixture',
    nowIso: () => '2026-11-13T00:00:00Z', safeSessionId: value => value,
    apiFailure: (code, params, message, status) => ({ code, status }), send: (res, value) => { res.failure = value; res.end(); },
  });
  const req = Object.assign(new EventEmitter(), { method: 'GET', url: '/api/events/stream', headers: {}, socket: { setNoDelay() {} } });
  const response = () => Object.assign(new EventEmitter(), { writableEnded: false, writeHead() {}, write() {},
    end() { this.writableEnded = true; this.emit('close'); } });
  const res = response();
  await hooks.handleApiRoutes(req, res, '/api/events/stream');
  assert.equal(hooks.presenceSnapshot().length, 1);
  assert.equal(sources.size, 1); assert.equal(taps.size, 1);
  service.close(); service.close();
  assert.equal(res.writableEnded, true); assert.equal(hooks.presenceSnapshot().length, 0);
  assert.equal(sources.size, 0); assert.equal(taps.size, 0); assert.equal(service.eventStreamRing.length, 0);
  const late = response(); await hooks.handleApiRoutes(req, late, '/api/events/stream');
  assert.equal(late.failure.status, 503);
});
