'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createToolPolicy } = require('../../ruyi-workbench/app/backend/tool-policy.cjs');
const policy = createToolPolicy({ TOOL_TIER_RANK: { read: 0, edit: 1, exec: 2 },
  nativeToolTier: name => ({ file_read: 'read', file_write: 'edit', shell_run: 'exec', tool_invoke_read: 'read', todo_write: 'read' })[name] || 'exec',
  resolveBridge: (routes, name) => routes[name], bridgedToolTier: (name, config, args) => (typeof args === 'string' ? JSON.parse(args) : args).mode === 'write' ? 'edit' : 'read',
});
const proxy = (name, args = {}) => ({ id: 'call', name: 'tool_invoke_read', rawArgs: JSON.stringify({ name, arguments: args }) });
test('plan discovery uses the actual proxy target, including argument-dependent bridges', () => {
  assert.equal(policy.planDiscoveryToolBatchAllowed([proxy('file_read')], {}, {}), true);
  for (const target of ['file_write', 'shell_run', 'unknown', 'todo_write']) {
    assert.equal(policy.planDiscoveryToolBatchAllowed([proxy(target)], {}, {}), false, target);
  }
  assert.equal(policy.planDiscoveryToolBatchAllowed([proxy('external', { mode: 'write' })], { external: { toolName: 'operation' } }, {}), false);
  assert.equal(policy.planDiscoveryToolBatchAllowed([proxy('external', { mode: 'read' })], { external: { toolName: 'operation' } }, {}), true);
});
test('proxy tier correction never lowers authorization and preserves identity and arguments', () => {
  const call = proxy('shell_run', { command: 'true' });
  const raised = policy.retierToolInvokeCall(call, [{ name: 'shell_run', tier: 'exec' }], {}, {});
  assert.equal(raised.name, 'tool_invoke_exec'); assert.equal(raised.rawArgs, call.rawArgs); assert.equal(raised.id, call.id);
  const alreadyHigh = { ...proxy('file_read'), name: 'tool_invoke_exec' };
  assert.equal(policy.retierToolInvokeCall(alreadyHigh, [{ name: 'file_read', tier: 'read' }], {}, {}), alreadyHigh);
});
test('unoffered agent targets cannot bypass the offered-tool gate through a proxy', () => {
  const call = proxy('orchestrate_agents');
  assert.equal(policy.unwrapProxiedControlCall(call, new Set()), call);
  assert.equal(policy.unwrapProxiedControlCall(call, new Set(['orchestrate_agents'])).name, 'orchestrate_agents');
});
