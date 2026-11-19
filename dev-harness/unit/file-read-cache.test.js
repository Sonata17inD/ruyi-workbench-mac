'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { createFileReadCache } = require('../../ruyi-workbench/app/backend/file-read-cache.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-read-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'data'); await fs.writeFile(target, 'before'); await fs.utimes(target, 1700000000, 1700000000);
  const make = () => createFileReadCache({ execResultCacheEnabled: () => true, execResultCacheMaxEntries: () => 3, logEvent() {} });
  const cache = make(); const context = () => cache.context('file_read', {}, { sessionId: 'a' }, target);
  const c = context(); assert.equal(await cache.lookup(c), null); await cache.store(c, { ok: true, content: 'before' });
  return { target, root, cache, context, make };
}
test('atomic file replacement invalidates same-length cache even if modification time is preserved', async t => {
  const f = await fixture(t), old = await fs.stat(f.target);
  const replacement = path.join(f.root, 'replacement'); await fs.writeFile(replacement, 'after!');
  await fs.utimes(replacement, old.atime, old.mtime); await fs.rename(replacement, f.target);
  assert.equal(await f.cache.lookup(f.context()), null);
});
test('cache ownership is private to each service and each session', async t => {
  const f = await fixture(t);
  assert.equal((await f.cache.lookup(f.context())).content, 'before');
  const other = f.make(); assert.equal(await other.lookup(other.context('file_read', {}, { sessionId: 'a' }, f.target)), null);
  assert.equal(await f.cache.lookup(f.cache.context('file_read', {}, { sessionId: 'b' }, f.target)), null);
});
