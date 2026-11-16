'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMissionControl } = require('../../ruyi-workbench/app/backend/mission-control.cjs');
function fixture(execution = {}) {
  return createMissionControl({
    storage: {}, checkpoints: {}, execution: { hasActiveTurn: () => false, hasActiveRun: () => false, ...execution },
    model: {}, events: {}, authorization: {},
    MISSION_DEFAULT_MAX_TURNS: 5, MISSION_MAX_MILESTONES: 20, MISSION_MAX_TEXT: 2000,
  });
}
test('settled or failed execution releases its timeout immediately', async t => {
  const timers = new Set();
  t.mock.method(global, 'setTimeout', () => { const timer = {}; timers.add(timer); return timer; });
  t.mock.method(global, 'clearTimeout', timer => timers.delete(timer));
  let settle;
  const promise = new Promise(resolve => { settle = resolve; });
  const control = fixture({ getTurnSettler: () => ({ promise }) });
  const pending = control.waitMissionTurnSettled('session');
  assert.equal(timers.size, 1);
  settle(); assert.equal(await pending, true); assert.equal(timers.size, 0);
  const failing = fixture({ getTurnSettler: () => ({ promise: Promise.reject(new Error('execution failed')) }) });
  await assert.rejects(failing.waitMissionTurnSettled('session'), /execution failed/);
  assert.equal(timers.size, 0);
});
test('control actions observe explicit execution ports, including live background runs', () => {
  const session = { id: 'session', mission: { autoMode: 'off', milestones: [{ status: 'pending' }], budget: { maxAutoTurns: 5 }, spent: {} } };
  let active = true;
  const control = fixture({ hasActiveTurn: () => active, hasActiveRun: id => id === 'run' });
  let view = control.missionControlView(session);
  assert.equal(view.actions.pause.enabled, true); assert.equal(view.actions.continue.enabled, false);
  active = false; view = control.missionControlView(session, { runs: [{ id: 'run' }] });
  assert.equal(view.actions.next_turn.enabled, false); assert.equal(view.actions.next_turn.reason, 'run_active');
  assert.equal(control.missionControlView(session).actions.next_turn.enabled, true);
});
test('result archive preserves deliverable text and bounds historical rounds', () => {
  const control = fixture(); const mission = { resultHistory: [] };
  for (let round = 0; round < 12; round++) { mission.result = { round, deliverableText: 'a'.repeat(4000) }; control.archiveMissionResult(mission); }
  assert.equal(mission.resultHistory.length, 10); assert.equal(mission.resultHistory[0].round, 2);
  assert.equal(mission.resultHistory[0].deliverableText.length, 4000);
});
