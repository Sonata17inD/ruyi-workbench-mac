'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createMemoryStore } = require('../../ruyi-workbench/app/backend/memory-store.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-memory-store-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createMemoryStore({ memoryRoot: root,
    atomicWriteJson: (file, value) => fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)),
    parseFrontmatter: raw => Object.fromEntries(raw.split('\n').filter(l => l.includes(': ')).map(l => [l.slice(0, l.indexOf(': ')).toLowerCase(), l.slice(l.indexOf(': ') + 2)])),
    firstParaDesc: () => '', safeJsonParse: (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } },
    SKILL_ID_RE: /^[a-z0-9_-]+$/i, makeId: () => 'new', nowIso: () => new Date().toISOString(),
    limits: { MEMORY_TYPES: new Set(['reference']), MEMORY_METADATA_READ_CAP: 16384, CORE_MEMORY_SUMMARY_CAP: 520, MEMORY_USAGE_TOUCH_MS: 3600000, MEMORY_RULE_TOUCH_MS: 86400000 },
  });
  return { root, store };
}
test('memory registry invalidates same-length atomic replacement with preserved mtime', async t => {
  const { root, store } = await fixture(t), dir = store.memoryGlobalDir(); await fs.mkdir(dir);
  const file = path.join(dir, 'entry.md'), content = '---\nname: before\ndescription: memo\n---\nbody';
  await fs.writeFile(file, content); await fs.utimes(file, 1700000000, 1700000000);
  assert.equal((await store.readMemoryDir(dir, 'global')).get('entry').name, 'before');
  const temp = path.join(root, 'replacement'); await fs.writeFile(temp, content.replace('before', 'after!')); await fs.utimes(temp, 1700000000, 1700000000); await fs.rename(temp, file);
  assert.equal((await store.readMemoryDir(dir, 'global')).get('entry').name, 'after!');
});
test('usage touch and explicit mutation serialize without losing records', async t => {
  const { store } = await fixture(t);
  await Promise.all([store.touchMemoryUsage([{ id: 'a', scope: 'global' }], ''), store.mutateMemoryUsageState(entries => { entries.other = { useCount: 9 }; })]);
  const state = await store.readMemoryUsageState(); assert.equal(state.entries['global:a'].useCount, 1); assert.equal(state.entries.other.useCount, 9);
  await store.touchMemoryUsage([{ id: 'a', scope: 'global' }], ''); assert.equal((await store.readMemoryUsageState()).entries['global:a'].useCount, 1);
});
