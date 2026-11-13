'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const load = () => import(pathToFileURL(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/deadline-poll.js')));
test('deadline polling sleeps while idle/hidden, never postpones unchanged deadlines, and resumes', async () => {
  const { createDeadlinePoll } = await load();
  let now = 0, visible = true, active = false, last = 0, calls = 0;
  const timers = new Set();
  const p = createDeadlinePoll({ shouldRun: () => visible, clock: () => now,
    delay: () => active ? 30000 - (now - last) : Infinity,
    tick: async () => { calls++; last = now; },
    arm: (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; },
    disarm: timer => timers.delete(timer),
  });
  p.sync(); assert.equal(timers.size, 0);
  active = true; p.sync(); const first = [...timers][0];
  assert.equal(first.ms, 30000);
  now = 5000; p.sync(); assert.equal([...timers][0], first);
  visible = false; p.sync(); assert.equal(timers.size, 0);
  visible = true; p.sync(); const timer = [...timers][0];
  assert.equal(timer.ms, 25000);
  now = 30000; timers.delete(timer); await timer.fn();
  assert.equal(calls, 1); assert.equal([...timers][0].ms, 30000);
  active = false; p.sync(); assert.equal(timers.size, 0);
});
test('in-flight polling is serial and stop prevents settlement from restarting it', async () => {
  const { createDeadlinePoll } = await load();
  let run, finish, arms = 0;
  const p = createDeadlinePoll({ shouldRun: () => true, delay: () => 5000,
    tick: () => new Promise(resolve => { finish = resolve; }),
    arm: fn => { arms++; run = fn; return 1; }, disarm() {},
  });
  p.sync(); const pending = run(); p.sync(); p.sync();
  assert.equal(arms, 1);
  p.stop(); finish(); await pending;
  assert.equal(arms, 1); assert.equal(p.isRunning(), false);
});
