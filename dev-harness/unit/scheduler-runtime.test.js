'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchedulerRuntime } = require('../../ruyi-workbench/app/backend/scheduler-runtime.cjs');
const { createSchedulerCore } = require('../../ruyi-workbench/app/backend/scheduler-core.cjs');
function fixture(tasks = []) {
  const writes = [], listeners = [];
  let reads = 0, release;
  const wait = new Promise(resolve => { release = resolve; });
  const service = createSchedulerRuntime({
    paths: { data: '/synthetic-scheduler' },
    RUYI_EVENTS: { emit() {}, subscribe(fn) { listeners.push(fn); } },
    readConfig: async () => ({ schedulerEnabledV1: true }), logEvent() {},
    makeId: () => 'synthetic', nowIso: () => new Date().toISOString(),
    domain: { ...createSchedulerCore(), PERMISSION_MODES: {}, STEWARD_SESSION_ID: 'steward', stewardPermissionRank: () => 0 },
    sessions: {}, execution: {},
    storage: { atomicWriteJson: async (...args) => writes.push(args), repairMissionChangeTornTail: async () => {} },
    io: {
      async readFile() { reads++; await wait; return JSON.stringify({ schema: 1, tasks, globalRuns: {} }); },
      async stat() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      async mkdir() {}, async appendFile(...args) { writes.push(args); },
    },
  });
  return { service, release, writes, reads: () => reads, config: enabled => listeners.forEach(fn => fn('config.written', { schedulerEnabledV1: enabled })) };
}

test('concurrent load requests share one snapshot read', async () => {
  const f = fixture();
  const a = f.service.schedulerLoad(), b = f.service.schedulerLoad();
  try { assert.equal(f.reads(), 1); }
  finally { f.release(); await Promise.all([a, b]); f.service.stopScheduler(); }
});

test('stop during initial load prevents recovery writes and a successful start report', async () => {
  const core = createSchedulerCore();
  const normalized = core.normalizeSchedulerTask({ title: 'recovery', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'test' } }, Date.now());
  assert.equal(normalized.ok, true);
  const task = normalized.task; task.id = 'sch_recovery'; task.state.inFlightRunId = 'interrupted';
  const f = fixture([task]);
  const starting = f.service.startScheduler({ schedulerEnabledV1: true });
  f.service.stopScheduler(); f.release();
  assert.equal(await starting, false);
  assert.equal(f.writes.length, 0);
  assert.equal(f.service.schedulerRuntimeSnapshot().timerActive, false);
});

test('configuration changes during load do not bypass startup recovery', async () => {
  const core = createSchedulerCore();
  const task = core.normalizeSchedulerTask({ title: 'recovery', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'test' } }, Date.now()).task;
  task.id = 'sch_recovery'; task.state.inFlightRunId = 'interrupted';
  const f = fixture([task]);
  try {
    const starting = f.service.startScheduler({ schedulerEnabledV1: true });
    f.config(false); f.config(true);
    assert.equal(f.service.schedulerRuntimeSnapshot().timerActive, false);
    f.release();
    assert.equal(await starting, true);
    assert.equal(f.service.schedulerRuntime.tasks[0].state.inFlightRunId, '');
    assert.ok(f.writes.length > 0);
  } finally { f.release(); f.service.stopScheduler(); }
});
