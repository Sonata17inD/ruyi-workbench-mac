'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAgentRunStore } = require('../../ruyi-workbench/app/backend/agent-run-store.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-run-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { fail: false, tombstone: false, events: [], writes: [] };
  const run = { id: 'run_abc', sessionId: 'sess_abc', status: 'running', nodes: [] };
  const live = { run, paused: false };
  const dir = id => path.join(root, id);
  const create = () => createAgentRunStore({
    files: { agentRunDir: dir, agentRunFile: (id, runId) => path.join(dir(id), runId + '.json'),
      atomicWriteJson: async (file, snapshot) => { if (state.fail) throw new Error('disk full'); state.writes.push(JSON.parse(snapshot)); await fs.writeFile(file, snapshot); },
      readFileTail: async () => { throw new Error('not needed for small fixture'); } },
    lifecycle: { sessionAssociatedSaveIsTombstoned: () => state.tombstone, hasLiveRun: () => true, getLiveRun: () => live },
    signals: { missionSignalThrottleAllow: () => true, MISSION_STALL_SIGNAL_WINDOW_MS: 1000, emit: (...args) => state.events.push(args), logEvent() {} },
    safeSessionId: id => /^[a-z_]+$/.test(id) ? id : null, safeJsonParse: (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } }, nowIso: () => new Date().toISOString(),

  });
  return { state, run, live, create, store: create() };
}
test('snapshot failure is visible, pauses repeated failures and recovery clears persisted degradation', async t => {
  const f = await fixture(t); f.state.fail = true;
  for (let i = 0; i < 8; i++) await assert.rejects(f.store.saveAgentRun(f.run), /disk full/);
  assert.equal(f.run.persistenceDegraded, true); assert.equal(f.live.paused, true);
  f.state.fail = false; await f.store.saveAgentRun(f.run);
  assert.equal(f.state.writes.at(-1).persistenceDegraded, false);
  await f.store.flushSessionAgentRuns(f.run.sessionId, [f.run.id]);
  const { events } = await f.store.readAgentRunEvents(f.run.sessionId, f.run.id, 0, 500);
  assert.ok(events.some(e => e.type === 'persistence_recovered'));
  assert.equal(events.filter(e => e.type === 'run_paused').length, 1);
});
test('queued snapshots keep submission-time state and cache invalidation observes replacement', async t => {
  const f = await fixture(t);
  const first = f.store.saveAgentRun(f.run); f.run.status = 'succeeded';
  const second = f.store.saveAgentRun(f.run); await Promise.all([first, second]);
  assert.deepEqual(f.state.writes.map(r => r.status), ['running', 'succeeded']);
  assert.equal((await f.store.listAgentRunDigests(f.run.sessionId))[0].status, 'succeeded');
  f.run.status = 'stopped'; await f.store.saveAgentRun(f.run);
  assert.equal((await f.store.listAgentRunDigests(f.run.sessionId))[0].status, 'stopped');
  assert.equal(f.create().stats.reads, 0);
});
test('tombstoned sessions do not queue events or snapshots', async t => {
  const f = await fixture(t); f.state.tombstone = true;
  f.store.appendAgentRunEvent(f.run, { type: 'run_start' }); await f.store.saveAgentRun(f.run);
  assert.equal(f.state.writes.length, 0); assert.equal(f.run.eventSeq, undefined);
  assert.deepEqual(await f.store.listAgentRuns(f.run.sessionId), []);
});
