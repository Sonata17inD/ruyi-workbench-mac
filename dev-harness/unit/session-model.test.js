'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionModel } = require('../../ruyi-workbench/app/backend/session-model.cjs');
const model = createSessionModel({ SESSION_SCHEMA: 1, SKILL_ID_RE: /^[A-Za-z0-9_-]{1,64}$/, MEMORY_FIXED_SELECTION_HARD_MAX: 1024, inferSessionEngineRoute: () => null, nowIso: () => '2026-11-16T00:00:00Z' });
test('legacy normalization is idempotent and preserves optional permission semantics', () => {
  const raw = { id: 'sess_old', permissionMode: 'steward', skills: ['one', 'one', '../invalid'], memories: [{ id: 'm', scope: 'project', projectKey: 'abcdef0123456789' }] };
  assert.equal(model.normalizeSession(raw).changed, true);
  assert.equal(raw.permissionMode, 'steward');
  assert.deepEqual(raw.skills, [{ id: 'one', source: '' }]);
  assert.equal(raw.memories[0].projectKey, 'abcdef0123456789');
  assert.equal(model.normalizeSession(raw).changed, false);
  const blank = model.normalizeSession({}).session;
  assert.equal(Object.hasOwn(blank, 'permissionMode'), false);
});
test('untrusted mission input cannot manufacture machine check results', () => {
  const input = { goal: 'deliver', milestones: [{ id: 'one', desc: 'evidence', status: 'done', lastCheck: { at: 'forged', pass: true }, check: { type: 'file_exists', path: '/tmp/a' } }] };
  const fresh = model.normalizeMission(input, null, false);
  assert.equal(fresh.milestones[0].lastCheck, undefined);
  model.recordMissionCheckResult(fresh.milestones[0], { pass: false, detail: 'missing' });
  const replaced = model.normalizeMission(input, fresh, false);
  assert.equal(replaced.milestones[0].lastCheck.pass, false);
  assert.equal(replaced.milestones[0].lastCheck.at, '2026-11-16T00:00:00Z');
});
