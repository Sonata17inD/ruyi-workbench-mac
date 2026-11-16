'use strict';
require('../lib/self-isolate-home');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadServerInternals } = require('../lib/server-internals');
const S = loadServerInternals(['shellSessions', 'scheduleShellReaper', 'killAllShellSessions',
  'SHELL_IDLE_MS'], { withEval: true });
after(() => { S.killAllShellSessions(); });

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
