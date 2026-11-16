'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createMissionChanges } = require('../../ruyi-workbench/app/backend/mission-changes.cjs');
test('mission journal owns revisions and exposes a head/journal gap after append failure', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-mission-changes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionPath = id => path.join(root, id + '.json'), queues = new Map();
  let invalidations = 0;
  const options = {
    paths: { sessions: root }, sessionPath, sessionWriteChains: queues,
    readFileTail: async () => ({ size: 0, bytesRead: 0, buf: Buffer.alloc(0) }),
    runKeyedChain: async (chains, key, work) => {
      const next = (chains.get(key) || Promise.resolve()).catch(() => {}).then(work); chains.set(key, next);
      try { return await next; } finally { if (chains.get(key) === next) chains.delete(key); }
    },
    atomicWriteJson: (file, data) => fs.writeFile(file, data), nowIso: () => new Date().toISOString(),
    sessionMissionId: head => head.id, invalidateReads: () => { invalidations++; }, events: { emit() {} },
  };
  const changes = createMissionChanges(options), id = 'sess_changes';
  await fs.writeFile(sessionPath(id), JSON.stringify({ id, mission: { changeSeq: 4 } }));
  changes.seedRevision(id, 4); changes.seedRevision(id, 2);
  assert.equal(changes.revisionOf(id), 4);
  assert.equal(createMissionChanges(options).revisionOf(id), 0);
  assert.deepEqual(await Promise.all([changes.bumpMissionChangeSeq(id), changes.bumpMissionChangeSeq(id)]), [5, 6]);
  assert.equal(changes.revisionOf(id), 6); assert.equal(queues.size, 0);
  const before = await changes.readMissionChangesWithMeta(id);
  assert.equal(before.degraded, false); assert.deepEqual(before.records.map(r => r.seq), [5, 6]);
  const append = fs.appendFile;
  t.mock.method(fs, 'appendFile', async (file, ...args) => {
    if (file === changes.missionChangeFilePath(id)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return append(file, ...args);
  });
  assert.equal(await changes.bumpMissionChangeSeq(id), null);
  const failed = await changes.readMissionChangesWithMeta(id);
  assert.equal(failed.currentRevision, 7); assert.equal(failed.lastRevision, 6);
  assert.equal(failed.degraded, true); assert.equal(failed.gap.tail, true);
  assert.equal(invalidations, 3); assert.equal(queues.size, 0);
});
