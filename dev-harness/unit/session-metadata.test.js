'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionMetadata } = require('../../ruyi-workbench/app/backend/session-metadata.cjs');
function fixture() {
  const state = { live: true, generation: 0 };
  const service = createSessionMetadata({
    safeSessionId: id => typeof id === 'string' && id.startsWith('sess_') ? id : null,
    sessionPermissionModeOf: value => value.permissionMode || null,
    resolvePermissionMode: ({ session, config }) => session.permissionMode || config.permissionMode,
    isLive: () => state.live, rewindGeneration: () => state.generation,
  });
  return { state, service };
}
test('title overlays are instance-owned and generated titles expire on rewind', () => {
  const { state, service: a } = fixture(), { service: b } = fixture();
  a.setSessionTitleOverride('sess_one', { threadBrief: { title: 'generated' }, rewindGen: 0 });
  assert.equal(a.sessionDisplayTitle(a.applySessionTitleOverride({ id: 'sess_one', title: 'New session' })), 'generated');
  assert.equal(b.getSessionTitleOverride('sess_one'), undefined);
  state.generation = 1;
  const old = { id: 'sess_one', title: 'old', rewindGen: 0 };
  assert.equal(a.applySessionTitleOverride(old).threadBrief, undefined);
  assert.equal(a.getSessionTitleOverride('sess_one'), undefined);
  a.setSessionTitleOverride('sess_one', { title: 'user', titleSource: 'user' });
  assert.equal(a.sessionDisplayTitle(a.applySessionTitleOverride(old)), 'user');
});
test('metadata uses live overlays without mutating input and preserves authoritative idle index titles', () => {
  const { state, service } = fixture();
  service.setSessionTitleOverride('sess_one', { title: 'live', titleSource: 'user' });
  const source = { id: 'sess_one', title: 'disk', kind: 'steward', messageCount: 4 };
  const meta = service.sessionMeta(source);
  assert.equal(meta.title, 'live');
  assert.equal(meta.rawKind, 'steward');
  assert.equal(meta.messageCount, 4);
  assert.equal(source.title, 'disk');
  state.live = false;
  assert.equal(service.sessionMeta(source).title, 'disk');
  assert.equal(service.sessionMeta(source, 1).effectivePermissionMode, undefined);
  assert.equal(service.sessionMeta(source, { permissionMode: 'ask' }).effectivePermissionMode, 'ask');
});
test('recent request skips agent wake messages and title excerpts preserve Unicode characters', () => {
  const { service } = fixture();
  const messages = [{ role: 'user', content: '🚀'.repeat(25), turnSeq: 2 }, { role: 'user', content: 'wake', meta: { origin: 'agent_wake' } }];
  assert.equal(service.sessionDisplayTitle({ title: 'New session', messages }), '🚀'.repeat(24) + '…');
  assert.equal(service.sessionRecentUserRequest({ messages }).turnSeq, 2);
});
