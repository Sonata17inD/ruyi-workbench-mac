'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createReplanLedger } = require('../../ruyi-workbench/app/backend/replan-ledger.cjs');

const timestamp = '2026-11-18T10:00:00.000Z';
const { applyReplanPatch } = createReplanLedger({
  nowIso: () => timestamp,
  TOOL_TIER_RANK: Object.freeze({ read: 0, edit: 1, exec: 2 }),
});

function runWithPatch(changes) {
  return {
    nodes: [{ id: 'task', toolTier: 'exec', status: 'failed', error: 'first attempt failed', errorClass: 'failed', completedAt: timestamp }],
    replanPatches: [{ id: 'patch', status: 'pending', trigger: { type: 'node_failed', nodeId: 'task' }, changes }],
  };
}

test('a rejected replan leaves earlier operations and the rollback baseline uncommitted', () => {
  for (const lastChange of [
    { op: 'rewire', target: 'task' },
    { op: 'add_node', target: 'followup', to: 'Duplicate node' },
    { op: 'change_tier', target: 'task', to: 'edit' },
  ]) {
    const run = runWithPatch([
      { op: 'change_tier', target: 'task', to: 'read' },
      { op: 'add_node', target: 'followup', to: 'Inspect the result' },
      lastChange,
    ]);
    const original = structuredClone(run);
    assert.equal(applyReplanPatch(run, 'patch').ok, false, lastChange.op);
    assert.deepEqual(run, original, lastChange.op);
  }
});

test('a successful replan commits all operations and preserves live node identity', () => {
  const run = runWithPatch([
    { op: 'change_tier', target: 'task', to: 'edit' },
    { op: 'change_tier', target: 'task', to: 'read' },
    { op: 'add_node', target: 'followup', to: 'Inspect the result' },
  ]);
  const nodes = run.nodes;
  const initialNode = nodes[0];
  const baseline = structuredClone(nodes);
  assert.deepEqual(applyReplanPatch(run, 'patch'), { ok: true, applied: 3, patchId: 'patch' });
  assert.equal(run.nodes, nodes);
  assert.equal(nodes[0], initialNode);
  assert.deepEqual(initialNode, { id: 'task', toolTier: 'read', status: 'queued', error: '', completedAt: null });
  assert.equal(nodes[1].id, 'followup');
  assert.deepEqual(nodes[1].dependsOn, ['task']);
  assert.deepEqual(run.replanBaseline, baseline);
  assert.equal(run.replanPatches[0].status, 'applied');
  assert.equal(run.replanPatches[0].appliedAt, timestamp);
});
