'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkbenchApiRouter } = require('../../ruyi-workbench/app/backend/workbench-api-router.cjs');
const { decisionPoints } = require('../../docs/architecture/route-inventory.json');

test('every inventoried API reaches its owning domain after authorization', async () => {
  const delegated = {
    handleMigrationApiRoutes: 'handleMcpApiRoutes',
    handleStewardRunnerApiRoutes: 'handleStewardApiRoutes',
  };
  const calls = [];
  const deps = new Proxy({ authorizeRoute() { calls.push('authorize'); } }, {
    get(target, name) {
      return target[name] || (() => { calls.push(name); });
    },
  });
  const route = createWorkbenchApiRouter(deps);
  const response = { writeHead() {}, end() {} };
  for (const point of decisionPoints.filter(p => p.path.startsWith('/api/'))) {
    calls.length = 0;
    await route({ method: point.methods[0] }, response, point.path.replace(/:\w+/g, 'fixture'));
    assert.equal(calls[0], 'authorize');
    assert.ok(calls.includes(delegated[point.handler] || point.handler), point.path + ' called ' + calls);
  }
  calls.length = 0;
  await route({ method: 'GET' }, response, '/api/sessions');
  assert.deepEqual(calls, ['authorize', 'handleSessionApiRoutes']);
});
