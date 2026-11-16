'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSessionPersistence } = require('../../ruyi-workbench/app/backend/session-persistence.cjs');
const { createSessionBodies } = require('../../ruyi-workbench/app/backend/session-bodies.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-persistence-port-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coordination = { sessionWriteChains: new Map(), sessionRewindGenHighWater: new Map(), missionChangeSeqHighWater: new Map() };
  const sessionPath = id => path.join(root, id + '.json');
  const sessionBodyPaths = id => ({ messages: path.join(root, id + '.messages.ndjson'), provider: path.join(root, id + '.provider.ndjson') });
  const published = [];
  const files = { sessionPath, sessionBodyPaths, ensureDirs: async () => {}, atomicWriteJson: async (file, payload) => {
    await fs.promises.writeFile(file + '.tmp', payload); await fs.promises.rename(file + '.tmp', file);
  } };
  const service = createSessionPersistence({
    files, coordination, bodies: createSessionBodies({ isWriting: id => coordination.sessionWriteChains.has(id), logEvent() {} }),
    model: { normalizeSession: session => ({ session, changed: false }), healStalePendingSegments: () => false, mergeMissionBeforeSave() {} },
    lifecycle: { isActive: () => false, protectedHistoryEnabled: () => false, ownsExecution: () => true, isTombstoned: () => false, mergeBackgroundJobs() {} },
    metadata: { applyOverrides() {}, applyRouteOverride() {}, sessionMeta: s => ({ id: s.id, title: s.title }), sessionRecentUserRequest: () => '', scheduleIndexUpdate: (...args) => published.push(args) },
    events: { emit() {} }, safeSessionId: id => /^sess_[a-z]+$/.test(id) ? id : null,
    safeJsonParse: (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } },
    nowIso: () => new Date().toISOString(), logEvent() {}, storageVersion: 2,
  });
  return { service, files, coordination, published };
}
test('persistence ports commit body/head, reject stale rewind copies, and publish only committed metadata', async t => {
  const { service, files, coordination, published } = fixture(t);
  const session = { id: 'sess_ports', title: 'first', messages: [{ role: 'user', content: 'kept' }], providerHistory: [], rewindGen: 0 };
  await service.saveSession(session, { requirePersisted: true });
  const stale = structuredClone(await service.loadSession(session.id));
  session.messages.push({ role: 'assistant', content: 'after rewind' });
  await service.saveSession(session, { rewindBump: true, requirePersisted: true });
  await assert.rejects(service.saveSession(stale, { requirePersisted: true }), { code: 'SESSION_SAVE_NOT_COMMITTED' });
  assert.equal(published.length, 2);
  assert.deepEqual((await service.loadSession(session.id)).messages, session.messages);
  assert.equal(coordination.sessionWriteChains.size, 0);
  const before = fs.readFileSync(files.sessionPath(session.id));
  assert.equal((await service.readSessionRouteHead(session.id)).rewindGen, 1);
  assert.deepEqual(fs.readFileSync(files.sessionPath(session.id)), before);
  assert.equal(await service.readSessionRouteHead('../bad'), null);
});
test('persistence reads recover the committed body and append without resurrecting an uncommitted tail', async t => {
  const { service, files } = fixture(t);
  const session = { id: 'sess_tail', messages: [{ role: 'user', content: 'committed' }], providerHistory: [] };
  await service.saveSession(session);
  const body = files.sessionBodyPaths(session.id).messages;
  fs.appendFileSync(body, JSON.stringify({ role: 'user', content: 'not committed' }) + '\n');
  const loaded = await service.loadSession(session.id);
  assert.deepEqual(loaded.messages, session.messages);
  loaded.messages.push({ role: 'assistant', content: 'new' });
  await service.saveSession(loaded);
  assert.deepEqual((await service.loadSession(session.id)).messages, loaded.messages);
  assert.ok(!fs.readFileSync(body, 'utf8').includes('not committed'));
});
