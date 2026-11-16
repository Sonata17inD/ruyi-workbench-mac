'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMissionDriver } = require('../../ruyi-workbench/app/backend/mission-driver.cjs');
function fixture() {
  const state = { alive: true, owned: true, stale: false, turns: 0, saves: [], events: [] };
  const owner = { driverRunId: 'owner' };
  const session = { id: 'sess_driver', cwd: '/tmp', mission: {
    goal: 'task', autoMode: 'until-done', milestones: [{ id: 'step', desc: 'step', status: 'pending', check: {} }],
    budget: { maxAutoTurns: 2, maxTokens: 0 }, spent: { autoTurns: 0, tokens: 0 }, stall: { lastDigest: '', sameCount: 0 },
  } };
  const storage = { saveSession: async (s, opts) => { state.saves.push(opts); }, sessionObjectIsStale: () => state.stale };
  const checks = { evaluateMissionCheck: async () => null, recordMissionCheckResult: (m, r) => { m.result = r; }, maybeFinalizeMission: async () => false };
  const create = () => createMissionDriver({ storage, checks,
    model: { missionProgressDigest: () => 'unchanged', MISSION_MAX_TEXT: 100, MISSION_STALL_LIMIT: 3 },
    normalizeCwd: cwd => cwd, neutralizeFenceTag: text => text, getPromptPack: () => ({}), nowIso: () => 'now', logEvent() {},
  }).runMissionDriver({ session, config: {}, emit: e => state.events.push(e),
    runTurn: async () => { state.turns++; session.mission.autoMode = 'off'; },
    isAlive: () => state.alive, ownsSession: () => state.owned, executionOwner: owner,
  });
  return { state, owner, session, storage, checks, create };
}
test('stop during machine validation never starts a new turn and demotes only the owned mission', async () => {
  const f = fixture();
  f.checks.evaluateMissionCheck = async () => { f.state.alive = false; return { pass: true }; };
  await f.create();
  assert.equal(f.state.turns, 0); assert.equal(f.session.mission.autoMode, 'supervised');
  assert.equal(f.session.mission.milestones[0].result, undefined);
  assert.equal(f.state.saves.length, 1); assert.equal(f.state.saves[0].executionOwner, f.owner);
});
test('ownership replacement during validation never saves or starts another turn', async () => {
  const f = fixture(); f.checks.evaluateMissionCheck = async () => { f.state.owned = false; return { pass: true }; };
  await f.create(); assert.equal(f.state.turns, 0); assert.equal(f.state.saves.length, 0);
});
test('progress must commit before continuation and stop during that commit is rechecked', async () => {
  const f = fixture(); let saves = 0;
  f.storage.saveSession = async (s, opts) => { assert.equal(opts.requirePersisted, true); saves++; f.state.alive = false; };
  await f.create(); assert.equal(f.state.turns, 0); assert.equal(saves, 2);
  const failed = fixture(); failed.storage.saveSession = async () => { throw new Error('disk full'); };
  await assert.rejects(failed.create(), /disk full/); assert.equal(failed.state.turns, 0);
});
test('synchronous cancellation from the continuation event is observed before running the turn', async () => {
  const f = fixture(); f.state.events.push = event => { if (event.state === 'continue') f.state.alive = false; };
  await f.create(); assert.equal(f.state.turns, 0); assert.equal(f.session.mission.autoMode, 'supervised');
});
