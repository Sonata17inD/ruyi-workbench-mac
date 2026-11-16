'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createShellSessions } = require('../../ruyi-workbench/app/backend/shell-sessions.cjs');
function create(t, ports = {}) {
  const service = createShellSessions({ safeSessionId: id => id, killChildTree: () => {}, ...ports });
  t.after(() => service.killAllShellSessions());
  return service;
}

test('empty and running-background shell sets have no idle wakeup; expired idle entries are reaped', async t => {
  const S = create(t);
  assert.equal(S.hasIdleWakeup(), false);
  const row = { mode: 'background', running: true, starting: true, lastUsedAt: Date.now() - S.SHELL_IDLE_MS - 100 };
  S.shellSessions.set('idle-fixture', row);
  S.scheduleShellReaper();
  assert.equal(S.hasIdleWakeup(), false);
  row.running = false;
  S.scheduleShellReaper();
  assert.ok(S.hasIdleWakeup());
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(S.shellSessions.size, 0);
  assert.equal(S.hasIdleWakeup(), false);
});

test('idle cleanup waits for async completion without repeated stop requests', async t => {
  let finish, stops = 0;
  const cleanup = new Promise(resolve => { finish = resolve; });
  const S = create(t, { killChildTree: () => { stops++; }, ProcessRuntime: { waitForCleanup: () => cleanup } });
  S.shellSessions.set('delayed', { child: { pid: 42, stdio: [] }, mode: 'interactive', running: true,
    lastUsedAt: Date.now() - S.SHELL_IDLE_MS - 1 });
  S.scheduleShellReaper();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(stops, 1);
  assert.equal(S.hasIdleWakeup(), false);
  finish({ incomplete: false });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(S.shellSessions.size, 0);
  assert.equal(S.hasIdleWakeup(), false);
});

test('unconfirmed idle cleanup retains ownership and backs off retry', async t => {
  let stops = 0;
  const S = create(t, { killChildTree: () => { stops++; }, ProcessRuntime: { waitForCleanup: async () => ({ incomplete: true }) } });
  S.shellSessions.set('failed', { child: { pid: 42 }, mode: 'interactive', running: true,
    lastUsedAt: Date.now() - S.SHELL_IDLE_MS - 1 });
  S.scheduleShellReaper();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(stops, 1);
  assert.equal(S.shellSessions.size, 1);
  assert.equal(S.hasIdleWakeup(), true);
});
