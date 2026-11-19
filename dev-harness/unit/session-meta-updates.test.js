'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionMetaUpdates } = require('../../ruyi-workbench/app/backend/session-meta-updates.cjs');
function fixture(saveError = null) {
  const activeChildren = new Map([['s', {}]]), turnSettlers = new Map();
  let settle;
  turnSettlers.set('s', { promise: new Promise(resolve => { settle = resolve; }) });
  const timers = new Set(), events = [], logs = [], saved = [];
  const stored = { id: 's', title: 'old', messages: [{ content: 'latest body' }], rewindGen: 1 };
  const service = createSessionMetaUpdates({
    metadata: { setSessionTitleOverride() {}, SESSION_BRIEF_TITLE_CHARS: 80, SESSION_BRIEF_GIST_CHARS: 200 },
    overrides: {}, lifecycle: { activeChildren, turnSettlers },
    safeSessionId: value => value, logEvent: row => logs.push(row), RUYI_EVENTS: { emit: (...args) => events.push(args) },
    sessions: { withSessionMutateLock: (id, fn) => fn(), loadSession: async () => structuredClone(stored), saveSession: async row => { if (saveError) throw saveError; saved.push(row); } },
    timers: { setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); } },
  });
  return { service, timers, events, logs, saved, stored, settle() { activeChildren.clear(); turnSettlers.clear(); settle(); } };
}
async function drained(f) {
  for (let i = 0; i < 20 && f.service.hasPending('s'); i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.hasPending('s'), false);
}

test('settled metadata update releases the fallback timeout and reloads the latest body', async () => {
  const f = fixture();
  const projection = await f.service.updateSessionMeta('s', { title: 'renamed' });
  assert.equal(projection.title, 'renamed');
  f.stored.messages.push({ content: 'committed while waiting' });
  f.settle(); await drained(f);
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].messages.length, 2);
  assert.equal(f.timers.size, 0);
});

test('failed deferred persistence is recorded without emitting a successful adoption event', async () => {
  const f = fixture(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
  await f.service.updateSessionMeta('s', { stewardWatch: true, stewardWatchNote: 'watch this' });
  f.settle(); await drained(f);
  assert.equal(f.events.length, 0);
  assert.ok(f.logs.some(row => row.kind === 'session_meta_deferred_failed' && row.sessionId === 's'));
});

test('fallback timeout is audited and releases its timer after the forced write', async () => {
  const f = fixture();
  await f.service.updateSessionMeta('s', { title: 'timed out' });
  for (const timeout of f.timers) timeout();
  await drained(f);
  assert.equal(f.saved.length, 1);
  assert.equal(f.timers.size, 0);
  assert.ok(f.logs.some(row => row.kind === 'session_meta_defer_forced' && row.stillActive && row.stillSettling));
  f.settle();
});
