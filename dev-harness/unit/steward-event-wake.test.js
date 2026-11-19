'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStewardCore } = require('../../ruyi-workbench/app/backend/steward-core.cjs');
const { createStewardInboxEvents } = require('../../ruyi-workbench/app/backend/steward-inbox-events.cjs');
const { createStewardInbox } = require('../../ruyi-workbench/app/backend/steward-inbox.cjs');

const rules = createStewardCore({});
const inboxEvents = createStewardInboxEvents(rules);
const config = { stewardEnabledV1: true, stewardPollMs: 5000 };

function harness(getPretenderProjectionIndex = async () => ({ sessions: [] })) {
  const listeners = [];
  const wake = new Set();
  const consistency = new Set();
  const missing = async () => { throw Object.assign(new Error('fixture file missing'), { code: 'ENOENT' }); };
  function addTimer(group, fn, ms) {
    const timer = { fn, ms, unref() {} };
    group.add(timer);
    return timer;
  }
  const inbox = createStewardInbox({
    paths: { data: '/unused' },
    io: { fsp: { stat: missing, readFile: missing, async mkdir() {} }, async atomicWriteJson() {} },
    sources: { getPretenderProjectionIndex }, execution: {}, rules, inboxEvents,
    safeSessionId: value => String(value || ''), nowIso: () => new Date().toISOString(),
    EventStreamHooks: {}, StewardHooks: {}, logEvent() {},
    RUYI_EVENTS: { subscribe(fn) { listeners.push(fn); } },
    timers: {
      setTimeout(fn, ms) { return addTimer(wake, fn, ms); },
      clearTimeout(timer) { wake.delete(timer); },
      setInterval(fn, ms) { return addTimer(consistency, fn, ms); },
      clearInterval(timer) { consistency.delete(timer); },
    },
  });
  return { ...inbox, wake, consistency, emit(name, sessionId = 'work') {
    for (const fn of listeners) fn(name, { sessionId, by: 'user' });
  } };
}

test('lifecycle events wake inbox, coalesce without deadline starvation, and stop clears wakeups', async () => {
  for (const event of ['thread.needs_you', 'thread.done', 'thread.state', 'thread.created', 'thread.removed', 'thread.adopted', 'background.completed']) {
    const h = harness();
    h.emit(event);
    assert.equal(h.wake.size, 0);
    await h.startStewardInbox(config);
    h.emit(event, 'steward');
    assert.equal(h.wake.size, 0);
    h.emit('thread.delta');
    assert.equal(h.wake.size, 0);
    h.emit(event, 'work2');
    assert.equal(h.wake.size, 2, event);
    const original = [...h.wake];
    for (let n = 0; n < 50; n++) h.emit(event, 'work' + n);
    assert.deepEqual([...h.wake], original);
    h.stopStewardInbox();
    assert.equal(h.wake.size, 0);
    assert.equal(h.consistency.size, 0);
  }
});

test('events received during an in-flight tick cause another pass after settlement', async () => {
  let pause = false;
  let finish;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const h = harness(async () => {
    if (!pause) return { sessions: [] };
    return new Promise(resolve => { finish = resolve; started(); });
  });
  await h.startStewardInbox(config);
  pause = true;
  const tick = h.startStewardInbox(config);
  await entered;
  h.emit('thread.done');
  for (const timer of [...h.wake]) {
    h.wake.delete(timer);
    timer.fn();
  }
  assert.equal(h.wake.size, 0);
  finish({ sessions: [] });
  await tick;
  assert.equal(h.wake.size, 2);
  h.stopStewardInbox();
});

test('consistency checks have a one-minute floor and startup still takes an immediate snapshot', async () => {
  let ticks = 0;
  const h = harness(async () => { ticks++; return { sessions: [] }; });
  await h.startStewardInbox(config);
  assert.equal(ticks, 1);
  assert.equal([...h.consistency][0].ms, 60000);
  assert.equal((await h.stewardInboxState({ stewardPollMs: NaN })).pollMs, 60000);
  assert.equal((await h.stewardInboxState({ stewardPollMs: 999999 })).pollMs, 120000);
  h.stopStewardInbox();
  assert.equal(h.consistency.size, 0);
});

test('a stopped startup cannot install a second poller after a new startup', async () => {
  let release;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const h = harness(() => new Promise(resolve => { release = resolve; started(); }));
  const first = h.startStewardInbox(config);
  await entered;
  h.stopStewardInbox();
  await h.startStewardInbox(config);
  const [newPoller] = h.consistency;
  assert.ok(newPoller);
  release({ sessions: [] });
  await first;
  assert.deepEqual([...h.consistency], [newPoller]);
  h.stopStewardInbox();
  assert.equal(h.consistency.size, 0);
});
