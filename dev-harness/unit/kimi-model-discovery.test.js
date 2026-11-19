'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: tick } = require('node:timers/promises');
const { createKimiModelDiscovery } = require('../../ruyi-workbench/app/backend/kimi-model-discovery.cjs');
test('timeout closes async admission before cleanup has settled', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let options, rejectSpawn, finishCleanup;
  const service = createKimiModelDiscovery({
    ProcessRuntime: {
      helperCapabilityAsync: async () => ({ ready: true }), currentOwner: () => ({}),
      spawn: (_command, _args, opts) => { options = opts; return new Promise((resolve, reject) => { rejectSpawn = reject; }); },
      waitForCleanup: () => new Promise(resolve => { finishCleanup = resolve; }),
    },
    selectedAgentCli: () => ({ path: '/fixture' }), prepareAgentCliSpawn: () => ({ command: '/fixture', args: [] }),
    killChildTree() {}, redact: String,
  });
  const pending = service.discoverKimiModels({ model: 'keep' });
  await tick();
  t.mock.timers.tick(10000);
  assert.throws(() => options.admit(), { code: 'ABORT_ERR' });
  rejectSpawn(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }));
  await tick();
  finishCleanup({ incomplete: false });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'process_timeout');
  assert.equal(result.models[1].id, 'keep');
});
