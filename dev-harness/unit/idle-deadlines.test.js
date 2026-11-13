'use strict';
require('../lib/self-isolate-home');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadServerInternals } = require('../lib/server-internals');
const S = loadServerInternals(['shellSessions', 'scheduleShellReaper', 'killAllShellSessions',
  'SHELL_IDLE_MS', 'schedulerRuntime', 'schedulerEnsureTimer', 'stopScheduler'], { withEval: true });
after(() => { S.killAllShellSessions(); S.stopScheduler(); });

test('empty and running-background shell sets have no idle wakeup; expired idle entries are reaped', async () => {
  S.killAllShellSessions();
  assert.equal(S.__eval('shellIdleReaper'), null);
  const row = { mode: 'background', running: true, starting: true, lastUsedAt: Date.now() - S.SHELL_IDLE_MS - 100 };
  S.shellSessions.set('idle-fixture', row);
  S.scheduleShellReaper();
  assert.equal(S.__eval('shellIdleReaper'), null);
  row.running = false;
  S.scheduleShellReaper();
  assert.ok(S.__eval('shellIdleReaper'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(S.shellSessions.size, 0);
  assert.equal(S.__eval('shellIdleReaper'), null);
});

test('scheduler sleeps until the next due time instead of polling every 30 seconds', () => {
  delete process.env.WCW_SCHEDULER_CLOCK_FILE;
  delete process.env.WCW_SCHEDULER_TICK_MS;
  const runtime = S.schedulerRuntime;
  Object.assign(runtime, { enabled: true, started: true, lateQueue: [], tasks: [
    { id: 'future', state: { enabled: true, nextFireAt: new Date(Date.now() + 1800000).toISOString() } },
  ] });
  S.schedulerEnsureTimer();
  assert.ok(runtime.timer._idleTimeout > 1700000 && runtime.timer._idleTimeout <= 1800000);
  runtime.tasks[0].state.enabled = false;
  S.schedulerEnsureTimer();
  assert.equal(runtime.timer, null);
  runtime.tasks[0].state.enabled = true;
  runtime.inFlightTaskIds.add('future');
  S.schedulerEnsureTimer();
  assert.equal(runtime.timer, null);
  runtime.inFlightTaskIds.clear();
  runtime.enabled = false;
  S.schedulerEnsureTimer();
  assert.equal(runtime.timer, null);
});
