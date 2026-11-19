'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCheckpointJournal } = require('../../ruyi-workbench/app/backend/checkpoint-journal.cjs');

test('checkpoint service serializes entries and preserves denied rollback evidence', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-journal-service-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let allow = false;
  const service = createCheckpointJournal({
    paths: { checkpoints: path.join(root, 'checkpoints') },
    assertSessionIdForPath: id => { assert.match(id, /^sess_[a-z]+$/); return id; },
    atomicWriteJson: async (file, value) => { await fs.writeFile(file + '.tmp', typeof value === 'string' ? value : JSON.stringify(value)); await fs.rename(file + '.tmp', file); },

    safeJsonParse: (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } },
    logEvent() {}, nowIso: () => new Date().toISOString(), isSessionActive: () => false,
    getRollbackContext: async id => ({ session: { id } }),
    guardFileToolPath: async (_file, ctx) => { assert.equal(ctx.session.id, 'sess_test'); return { ok: allow, error: 'fixture deny' }; },
  });
  const target = path.join(root, 'target.txt');
  await fs.writeFile(target, 'current');
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => service.journalRecord('sess_test', 1, 'file_write', target, 'modify', Buffer.from('before-' + i))));
  assert.ok(results.every(result => result.ok));
  assert.deepEqual((await service.journalReadIndex('sess_test')).map(row => row.entrySeq), [0, 1, 2, 3, 4, 5, 6, 7]);
  const refused = await service.journalRollback('sess_test', 1);
  assert.equal(refused.failed.length, 8);
  assert.equal(await fs.readFile(target, 'utf8'), 'current');
  assert.equal((await service.journalReadIndex('sess_test')).length, 8);
  allow = true;
  const rollback = await service.journalRollback('sess_test', 1);
  assert.equal(rollback.failed.length, 0);
  assert.equal(await fs.readFile(target, 'utf8'), 'before-0');
  assert.equal((await service.journalReadIndex('sess_test')).length, 0);
});
