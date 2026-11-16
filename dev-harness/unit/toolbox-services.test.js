'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createToolboxServices } = require('../../ruyi-workbench/app/backend/toolbox-services.cjs');
test('stop during initial health probe cannot adopt or start a service afterward', async () => {
  let release, starts = 0;
  const service = createToolboxServices({
    ProcessRuntime: { spawn: async () => { starts++; throw Error('must not start'); } },
    safeJsonParse: JSON.parse, logEvent() {},
    fetch: () => new Promise(resolve => { release = () => resolve({ ok: true, text: async () => '{"component":"fixture"}' }); }),
  });
  const pending = service.start({ id: 'fixture', service: { port: 12345, health: '/health', component: 'fixture' } });
  service.stop('fixture'); release();
  const entry = await pending;
  assert.equal(entry.state, 'stopped');
  assert.equal(starts, 0);
});
test('stop during process admission keeps stopped state when admission rejects cancellation', async () => {
  let rejectAdmission, entered;
  const admitted = new Promise(resolve => { entered = resolve; });
  const service = createToolboxServices({
    ProcessRuntime: { spawn: () => new Promise((resolve, reject) => { rejectAdmission = reject; entered(); }) },
    safeJsonParse: JSON.parse, logEvent() {},
    fetch: async () => ({ ok: true, text: async () => '{}' }),
  });
  const pending = service.start({ id: 'fixture', service: { port: 0, health: '/health', component: 'fixture', portEnv: 'PORT' }, run: { command: '/usr/bin/true', args: [] } });
  await admitted; service.stop('fixture');
  rejectAdmission(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }));
  const entry = await pending;
  assert.equal(entry.state, 'stopped');
  assert.equal(entry.failures, undefined);
});
