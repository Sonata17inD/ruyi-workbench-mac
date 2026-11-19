'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createMissionStore } = require('../../ruyi-workbench/app/backend/mission-store.cjs');
const { createMissionMembership } = require('../../ruyi-workbench/app/backend/mission-membership.cjs');

test('membership commits the head before reverse indexing and emits adoption only once', async t => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-mission-services-'));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  let sequence = 0, refuse = true;
  const safeSessionId = id => typeof id === 'string' && /^[a-z0-9_]+$/.test(id) ? id : null;
  const store = createMissionStore({
    paths: { data }, safeSessionId, makeId: prefix => prefix + '_' + ++sequence,
    nowIso: () => new Date().toISOString(), logEvent() {},
    atomicWriteJson: async (file, value) => { await fs.writeFile(file + '.tmp', value); await fs.rename(file + '.tmp', file); },
    runKeyedChain: async (map, key, work) => {
      const next = (map.get(key) || Promise.resolve()).catch(() => {}).then(work); map.set(key, next);
      try { return await next; } finally { if (map.get(key) === next) map.delete(key); }
    },
  });
  const { mission } = await store.createMissionContainer({ title: 'task' });
  const head = { id: 'sess_one', title: 'thread', missionId: 'sess_one' }, emitted = [];
  const membership = createMissionMembership({ store, safeSessionId, logEvent() {}, events: { emit: (...args) => emitted.push(args) }, sessions: {
    readHead: async () => ({ ...head }), list: async () => [{ ...head }], missionId: value => value.missionId,
    updateMeta: async (_id, patch) => { if (refuse) throw new Error('commit failed'); Object.assign(head, patch); },
    recordChange: async () => {},
  } });
  await assert.rejects(membership.missionAttachThread(mission.missionId, head.id), /commit failed/);
  assert.deepEqual((await store.readMissionContainer(mission.missionId)).sessionIds, []);
  assert.deepEqual(emitted, []);
  refuse = false;
  assert.equal((await membership.missionAttachThread(mission.missionId, head.id)).changed, true);
  assert.equal((await membership.missionAttachThread(mission.missionId, head.id)).changed, false);
  assert.deepEqual((await store.readMissionContainer(mission.missionId)).sessionIds, [head.id]);
  assert.equal(emitted.length, 1);
  assert.equal((await membership.missionDetachThread(mission.missionId, head.id)).changed, true);
  assert.equal(head.missionId, head.id);
  assert.deepEqual((await store.readMissionContainer(mission.missionId)).sessionIds, []);
});
