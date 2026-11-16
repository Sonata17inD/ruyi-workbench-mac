'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { createAgentResults } = require('../../ruyi-workbench/app/backend/agent-results.cjs');
function fixture() {
  const listeners = new Set();
  const state = { live: true, reads: 0, pending: false, delivered: new Set() };
  const records = {
    readAgentRunRecord: async id => { state.reads++; return { live: state.live, run: { id: 'run', status: state.live ? 'running' : 'succeeded' } }; },
    buildAgentRunEnvelope: run => ({ ok: true, runId: run.id, status: run.status, nodes: [{ nodeId: 'node', status: run.status, summary: 'result' }] }),
  };
  const emit = (name, sessionId = 'session') => { for (const listener of listeners) listener(name, { sessionId }); };
  const service = createAgentResults({ records,
    delivery: { pendingAgentMessages: () => state.pending,
      isAgentEnvelopeDelivered: (s, id) => state.delivered.has(id),
      markAgentEnvelopeDelivered: (s, id) => state.delivered.add(id), notifyAgentRunEnvelope() {} },
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, safeSessionId: id => id, logEvent() {},
  });
  return { state, records, service, listeners, emit };
}
test('completion event wakes a pending wait and releases subscription and abort listener', async () => {
  const f = fixture(), ctrl = new AbortController();
  const result = f.service.waitForAgentRunResults('session', ['run'], 10000, ctrl.signal, () => {
    setImmediate(() => { f.state.live = false; f.emit('thread.state'); });
  });
  const out = await result;
  assert.equal(out.settled, true); assert.equal(out.timedOut, false);
  assert.equal(f.state.reads, 2); assert.equal(f.listeners.size, 0);
  assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0);
});
test('an event during the first read cannot be lost before the wait subscribes', async () => {
  const f = fixture(); let reads = 0;
  // The factory captures the supplied function; a separate fixture permits this read barrier.
  const service = createAgentResults({
    records: { readAgentRunRecord: async () => {
      reads++;
      if (reads === 1) { f.emit('thread.state'); return { live: true, run: { id: 'run' } }; }
      return { live: false, run: { id: 'run', status: 'succeeded' } };
    }, buildAgentRunEnvelope: run => ({ runId: run.id, status: run.status }) },
    delivery: { pendingAgentMessages: () => false },
    subscribe: fn => { f.listeners.add(fn); return () => f.listeners.delete(fn); }, safeSessionId: id => id,
  });
  const out = await service.waitForAgentRunResults('session', ['run'], 10000);
  assert.equal(out.settled, true); assert.equal(reads, 2); assert.equal(f.listeners.size, 0);
});
test('cancellation from the heartbeat callback is immediate and is not reported as timeout', async () => {
  const f = fixture(), ctrl = new AbortController();
  const out = await f.service.waitForAgentRunResults('session', ['run'], 10000, ctrl.signal, () => ctrl.abort());
  assert.equal(out.cancelled, true); assert.equal(out.timedOut, false);
  assert.equal(f.listeners.size, 0); assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0);
});
test('peer mail ends the wait without terminating the run; delivery remains exactly once', async () => {
  const f = fixture();
  const out = await f.service.waitForAgentRunResults('session', ['run'], 10000, null, () => {
    setImmediate(() => { f.state.pending = true; f.emit('background.completed'); });
  });
  assert.equal(out.messageReady, true); assert.equal(out.timedOut, false); assert.equal(out.runs[0].live, true);
  const result = { runs: [{ runId: 'run', status: 'succeeded', nodes: [{ nodeId: 'node', summary: 'body' }] }] };
  f.service.settleWaitEnvelopes({}, result); assert.equal(result.runs[0].nodes[0].summary, 'body');
  f.service.settleWaitEnvelopes({}, result); assert.equal(result.runs[0].kind, 'agent_envelope_receipt');
  assert.equal(result.runs[0].nodes[0].summary, undefined); assert.equal(f.listeners.size, 0);
});
test('failed reads release the subscription', async () => {
  let subscribed = false;
  const service = createAgentResults({ records: { readAgentRunRecord: async () => { throw new Error('read failed'); } }, delivery: {},
    subscribe: () => { subscribed = true; return () => { subscribed = false; }; }, safeSessionId: id => id });
  await assert.rejects(service.waitForAgentRunResults('session', ['run'], 10000), /read failed/);
  assert.equal(subscribed, false);
});
test('quiet waits retain a one-second fallback and unrelated sessions cannot wake them', async t => {
  const f = fixture(); let delay;
  t.mock.method(global, 'setTimeout', (finish, ms) => {
    delay = ms;
    setImmediate(() => {
      f.emit('thread.state', 'another-session');
      assert.equal(f.state.reads, 1);
      f.state.live = false;
      finish();
    });
    return { unref() {} };
  });
  t.mock.method(global, 'clearTimeout', () => {});
  const out = await f.service.waitForAgentRunResults('session', ['run'], 10000);
  assert.equal(delay, 1000); assert.equal(out.settled, true); assert.equal(f.state.reads, 2);
  assert.equal(f.listeners.size, 0);
});
