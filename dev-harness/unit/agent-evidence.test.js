'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentEvidence } = require('../../ruyi-workbench/app/backend/agent-evidence.cjs');
const create = () => createAgentEvidence({ redact: text => text, nowIso: () => 'now' });
const node = id => ({ id, continuation: { attemptId: 0, steps: [{ tool: 'file_read', argsHash: 'hash', resultDigest: 'digest' }] } });
test('retry cleanup removes only its exact node, retaining evidence of prefix-sharing siblings', () => {
  const evidence = create(); const run = { id: 'run_abc', cwd: '/workspace', nodes: [node('audit'), node('audit_security')] };
  for (const n of run.nodes) evidence.indexNodeEvidence(run, n);
  evidence.purgeNodeEvidence(run, 'audit');
  assert.equal(run.evidence.length, 1);
  assert.equal(run.evidence[0].ref.nodeId, 'audit_security');
  evidence.indexNodeEvidence(run, run.nodes[1]); assert.equal(run.evidence.length, 1);
  evidence.indexNodeEvidence(run, run.nodes[0]); assert.equal(run.evidence.length, 2);
});
test('restored snapshots rebuild private dedup state and preserve dependency visibility', () => {
  const evidence = create(); const source = node('source'), other = node('other');
  const reviewer = { id: 'review', dependsOn: ['source'], structuredResult: { findings: [] } };
  let run = { id: 'run_abc', cwd: '/workspace', nodes: [source, other, reviewer] };
  evidence.indexNodeEvidence(run, source); evidence.indexNodeEvidence(run, other);
  run = JSON.parse(JSON.stringify(run));
  const restored = create(); restored.indexNodeEvidence(run, run.nodes[0]);
  assert.equal(run.evidence.length, 2);
  const catalog = restored.buildNodeEvidenceCatalog(run, reviewer);
  assert.deepEqual(catalog.entries.map(e => e.nodeId), ['source']);
  reviewer.structuredResult.findings = [{ evidenceRefs: [run.evidence[0].eventId] }, { evidenceRefs: [run.evidence[1].eventId] }];
  const result = restored.verifyNodeClaims(run, reviewer);
  assert.equal(result.verified, 1); assert.equal(result.unverified, 1);
});
