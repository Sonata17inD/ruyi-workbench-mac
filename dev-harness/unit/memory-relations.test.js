'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createMemoryRelations } = require('../../ruyi-workbench/app/backend/memory-relations.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-relations-')); let next = 0;
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return createMemoryRelations({ storage: {
    memoryGlobalDir: () => path.join(root, 'global'), memoryProjectDir: cwd => path.join(root, cwd),
    readMemoryDir: async () => new Map(['a', 'b', 'c', 'd', 'e'].map(id => [id, { id }])), writeMemoryMeta: async () => {},
    atomicWriteJson: async (file, data) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      const temp = file + '.' + (++next); await fs.writeFile(temp, JSON.stringify(data)); await fs.rename(temp, file);
    },
  }, safeJsonParse: (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } },
  SKILL_ID_RE: /^[a-z0-9_-]{1,64}$/i, makeId: () => 'rel_' + (++next), nowIso: () => 'now', fmVal: s => s.trim(), logEvent() {}, memoryIsExpired: () => false,
   });
}
test('concurrent proposals preserve all edges and duplicate proposals do not overwrite or duplicate', async t => {
  const graph = await fixture(t);
  const rows = await Promise.all(['b', 'c', 'd', 'e'].map(to => graph.proposeMemoryRelation({ from: 'a', to, type: 'supports' }, 'one')));
  assert.ok(rows.every(r => r.ok)); assert.equal((await graph.readMemoryRelations('project', 'one')).length, 4);
  const dup = await Promise.all([1, 2].map(() => graph.proposeMemoryRelation({ from: 'b', to: 'c', type: 'contradicts' }, 'one')));
  assert.equal(dup.filter(r => r.ok).length, 1);
  assert.equal((await graph.readMemoryRelations('project', 'two')).length, 0);
  assert.equal((await graph.buildMemoryConflictMap('one')).size, 0);
  await graph.confirmMemoryRelation(dup.find(r => r.ok).relation.id, 'one');
  assert.deepEqual([...((await graph.buildMemoryConflictMap('one')).get('b'))], ['c']);
});
test('concurrent relation removal and proposal retain unrelated updates', async t => {
  const graph = await fixture(t);
  await graph.proposeMemoryRelation({ from: 'a', to: 'b', type: 'supports' }, 'one');
  await Promise.all([graph.removeMemoryRelationsFor('a', 'project', 'one'), graph.proposeMemoryRelation({ from: 'c', to: 'd', type: 'supports' }, 'one')]);
  const rows = await graph.readMemoryRelations('project', 'one');
  assert.deepEqual(rows.map(r => [r.from, r.to]), [['c', 'd']]);
});
