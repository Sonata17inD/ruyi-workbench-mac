'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAgentRecovery } = require('../../ruyi-workbench/app/backend/agent-recovery.cjs');
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'session'));
  const run = { id: 'run', sessionId: 'session', status: 'interrupted', permissionModeAtLaunch: 'ask', nodes: [{ id: 'read', toolTier: 'read' }] };
  const calls = []; let live = false;
  const service = createAgentRecovery({
    agentRunsRoot: root, safeSessionId: id => id === 'session', nowIso: () => 'now', isWriteTool: name => name === 'file_write',
    sessions: { readSessionHeadResilient: async () => ({}), applySessionPermissionModeOverride: x => x, resolvePermissionMode: () => 'ask' },
    runs: { listAgentRuns: async () => [run], syncRunEventSeq: async () => {}, appendAgentRunEvent: (r, e) => calls.push(e.type), saveAgentRun: async r => calls.push(['save', r.autoResumeCount]), ...overrides.runs },
    execution: { hasLiveRun: () => live, launchPersistedAgentRun: async () => calls.push('launch'), ...overrides.execution },
    interventions: { settleIntervention() {}, readInterventions: async () => [], registerIntervention() {} },
    readConfig: async () => ({ autonomyAutoResume: true }), notifyInterruptedRun() {},
  });
  return { service, run, calls, setLive: () => { live = true; } };
}
test('auto recovery persists crash-loop guard before launch and fails closed on storage errors', async t => {
  const f = await fixture(t); await f.service.autoResumeInterruptedRuns();
  assert.deepEqual(f.calls, ['run_auto_resume', ['save', 1], 'launch']);
  const broken = await fixture(t, { runs: { saveAgentRun: async () => { throw new Error('disk full'); } } });
  await broken.service.autoResumeInterruptedRuns();
  assert.deepEqual(broken.calls, ['run_auto_resume']);
});
test('live ownership acquired during sequence synchronization prevents stale recovery writes', async t => {
  let f;
  f = await fixture(t, { runs: { syncRunEventSeq: async () => f.setLive() } });
  await f.service.autoResumeInterruptedRuns();
  assert.deepEqual(f.calls, []); assert.equal(f.run.autoResumeCount, undefined);
});
test('exhausted retry budget pauses without launch', async t => {
  const f = await fixture(t); f.run.autoResumeCount = 2;
  await f.service.autoResumeInterruptedRuns();
  assert.equal(f.run.status, 'paused');
  assert.deepEqual(f.run.resumeTierReasons, [{ nodeId: '', reason: 'auto_resume_loop' }]);
  assert.ok(!f.calls.includes('launch'));
});
