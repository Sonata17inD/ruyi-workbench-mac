'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createStewardCore } = require('../../ruyi-workbench/app/backend/steward-core.cjs');
const appRequire = createRequire(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { STEWARD_EVENT_KINDS, stewardSanitizeText, stewardCoveringLastTurn } = createStewardCore({});
const source = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/13i-steward-inbox.js'), 'utf8');
function harness() {
  const listeners = [], timers = new Set();
  const context = vm.createContext({
    require: appRequire, STEWARD_EVENT_KINDS, stewardSanitizeText, stewardCoveringLastTurn,
    RUYI_EVENTS: { subscribe(fn) { listeners.push(fn); } },
    safeSessionId: value => String(value || ''), STEWARD_SESSION_ID: 'steward',
    StewardHooks: {}, nowIso: () => new Date().toISOString(),
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    setInterval(fn, ms) { const timer = { fn, ms, unref() {} }; timers.add(timer); return timer; },
    clearInterval(timer) { timers.delete(timer); },
  });
  vm.runInContext(source, context);
  const evaluate = code => vm.runInContext(code, context);
  return { evaluate, timers, emit(name, sessionId = 'work') { for (const fn of listeners) fn(name, { sessionId, by: 'user' }); } };
}
test('lifecycle events wake inbox, coalesce without deadline starvation, and stop clears wakeups', () => {
  for (const event of ['thread.needs_you', 'thread.done', 'thread.state', 'thread.created', 'thread.removed', 'thread.adopted', 'background.completed']) {
    const h = harness();
    h.emit(event); assert.equal(h.timers.size, 0);
    h.evaluate('stewardRuntime.running = true');
    h.emit(event, 'steward'); assert.equal(h.timers.size, 0);
    h.emit('thread.delta'); assert.equal(h.timers.size, 0);
    h.emit(event, 'work2');
    assert.equal(h.timers.size, 2, event);
    const original = [...h.timers];
    for (let n = 0; n < 50; n++) h.emit(event, 'work' + n);
    assert.deepEqual([...h.timers], original);
    h.evaluate('stopStewardInbox()'); assert.equal(h.timers.size, 0);
  }
});
test('events received during an in-flight tick cause another pass after settlement', async () => {
  const h = harness();
  h.evaluate('stewardRuntime.running = true; var finish; stewardTickOnce = () => new Promise(resolve => { finish = resolve; });');
  const tick = h.evaluate('stewardRunTick()');
  h.emit('thread.done');
  for (const timer of [...h.timers]) { h.timers.delete(timer); timer.fn(); }
  assert.equal(h.timers.size, 0);
  h.evaluate('finish({ written: 0 })');
  await tick;
  assert.equal(h.timers.size, 2);
  h.evaluate('stopStewardInbox()');
});
test('consistency checks have a one-minute floor and startup still takes an immediate snapshot', async () => {
  const h = harness();
  h.evaluate('var ticks = 0; stewardTickOnce = async () => { ticks++; return { written: 0 }; };');
  await h.evaluate('startStewardInbox({ stewardEnabledV1: true, stewardPollMs: 5000 })');
  assert.equal(h.evaluate('ticks'), 1);
  assert.equal([...h.timers][0].ms, 60000);
  assert.equal(h.evaluate('stewardConsistencyMs(NaN)'), 60000);
  assert.equal(h.evaluate('stewardConsistencyMs(999999)'), 120000);
  h.evaluate('stopStewardInbox()'); assert.equal(h.timers.size, 0);
});
