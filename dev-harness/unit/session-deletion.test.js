'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionDeletion } = require('../../ruyi-workbench/app/backend/session-deletion.cjs');
const { createSessionTombstones } = require('../../ruyi-workbench/app/backend/session-tombstones.cjs');
test('deletion records shared tombstones, drains writes before unlink and cancels its settled deadline', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-deletion-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = name => path.join(root, name);
  const timers = new Set(), originalSet = global.setTimeout, originalClear = global.clearTimeout;
  t.mock.method(global, 'setTimeout', (fn, delay, ...args) => {
    const timer = originalSet(fn, delay, ...args); if (delay === 8000) timers.add(timer); return timer;
  });
  t.mock.method(global, 'clearTimeout', timer => { timers.delete(timer); return originalClear(timer); });
  let finishWrite, observedStop;
  const pending = new Promise(resolve => { finishWrite = resolve; });
  const stopped = new Promise(resolve => { observedStop = resolve; });
  const sessionWriteChains = new Map([['sess_owned', pending]]), events = [];
  const tombstones = createSessionTombstones();
  const options = {
    paths: { uploads: root, generated: root, memory: root, sessions: root },
    assertSessionIdForPath: id => assert.equal(id, 'sess_owned'), safeSessionId: id => id, logEvent() {},
    markSessionDeleted: tombstones.markSessionDeleted,
    files: { sessionPath: id => file(id + '.json'), sessionBodyPaths: id => ({ messages: file(id + '.messages'), provider: file(id + '.provider') }),
      interventionFilePath: id => file(id + '.iv'), missionChangeFilePath: id => file(id + '.change'),
      removeSessionNotes: id => fs.promises.rm(file(id + '.notes'), { force: true }),
      sessionScratchpadPath: id => file(id + '.scratch'), journalDir: id => file(id + '.journal'), agentRunDir: id => file(id + '.runs') },
    pendingWrites: { sessionWriteChains, sessionScratchpadChains: new Map() },
    execution: { stop: id => { assert.equal(tombstones.sessionSaveIsTombstoned({ id }), true); observedStop(); }, activeRuns: () => [], stopRuns: async () => {},
      settler: () => ({ promise: Promise.resolve() }), isActive: () => false, revokeGrants() {}, flushRuns: async () => {} },
    membership: { readHead: async () => null, ownerOf: () => null, remove: async () => {} },
    index: { list: async () => [], remove: id => events.push(['index', id]) },
    invalidateSessionState: id => events.push(['invalidate', id]), events: { emit: name => events.push([name]) },
  };
  const service = createSessionDeletion(options);
  fs.writeFileSync(file('sess_owned.json'), '{}');
  const deletion = service.deleteSession('sess_owned', { purgeAssociated: true });
  await stopped;
  assert.equal(fs.existsSync(file('sess_owned.json')), true);
  assert.equal(tombstones.sessionAssociatedSaveIsTombstoned('sess_owned'), true);
  assert.equal(createSessionTombstones().sessionAssociatedSaveIsTombstoned('sess_owned'), false);
  finishWrite();
  await deletion;
  assert.equal(fs.existsSync(file('sess_owned.json')), false);
  assert.equal(timers.size, 0);
  assert.deepEqual(events.map(row => row[0]), ['invalidate', 'index', 'projection.invalidated', 'thread.removed']);
  tombstones.clearDeletedSession('sess_owned');
  assert.equal(tombstones.sessionSaveIsTombstoned({ id: 'sess_owned' }), false);
});
