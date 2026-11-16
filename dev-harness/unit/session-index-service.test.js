'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSessionIndex } = require('../../ruyi-workbench/app/backend/session-index.cjs');

test('index instances isolate pending overlays and rebuild from heads after invalidation', async t => {
  const timers = new Set();
  t.mock.method(global, 'setTimeout', () => { const timer = { unref() {} }; timers.add(timer); return timer; });
  t.mock.method(global, 'clearTimeout', timer => timers.delete(timer));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-index-service-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function fixture(name) {
    const sessions = path.join(root, name);
    await fs.mkdir(sessions);
    const store = createSessionIndex({
      paths: { sessions }, safeJsonParse: (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } },
      atomicWriteJson: async (file, value) => { await fs.writeFile(file + '.tmp', JSON.stringify(value)); await fs.rename(file + '.tmp', file); },
      noteSessionsDirOwnWrite() {}, safeSessionId: id => id === 's' ? id : null,
      ensureDirs: async () => {}, sessionMeta: value => value, sessionMetaIsSteward: () => false, sortSessionMetas: list => list,
    });
    await fs.writeFile(path.join(sessions, 's.json'), JSON.stringify({ id: 's', title: name }));
    return store;
  }
  const a = await fixture('a'), b = await fixture('b');
  assert.deepEqual(await a.listSessions(), [{ id: 's', title: 'a' }]);
  assert.deepEqual(await b.listSessions(), [{ id: 's', title: 'b' }]);
  a.scheduleSessionIndexUpdate('s', { id: 's', title: 'new-a' });
  assert.equal((await a.listSessions())[0].title, 'new-a');
  assert.equal((await b.listSessions())[0].title, 'b');
  assert.equal(timers.size, 1);
  await a.flushSessionIndex();
  assert.equal(timers.size, 0, 'explicit flush cancels the now-unnecessary wakeup');
  assert.equal((await a.readSessionIndex())[0].title, 'new-a');
  await a.invalidateSessionIndex();
  assert.equal((await a.listSessions())[0].title, 'a', 'cache loss rebuilds from authoritative head');
  a.scheduleSessionIndexUpdate('s', a.SESSION_TOMBSTONE);
  assert.equal(a.overlayUnflushedSessionIndex(new Map([['s', { id: 's' }]])).size, 0);
  await a.flushSessionIndex();
});
