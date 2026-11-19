'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFileMutationQueue } = require('../../ruyi-workbench/app/backend/file-mutation-queue.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
test('queued cancellation settles before active transaction releases and never mutates', async () => {
  const q = createFileMutationQueue(); let release, ran = false;
  const active = q.run(null, () => new Promise(resolve => { release = resolve; })); await tick();
  const ctrl = new AbortController();
  const queued = q.run(ctrl.signal, () => { ran = true; }); assert.equal(q.pendingCount, 1);
  ctrl.abort(); assert.equal((await queued).code, 'aborted');
  assert.equal(q.pendingCount, 0); assert.equal(q.busy, true); assert.equal(ran, false);
  release(); await active; await tick(); assert.equal(q.busy, false);
});
test('transaction failures release FIFO lane; active cancellation does not roll back commit', async () => {
  const q = createFileMutationQueue(), order = [], ctrl = new AbortController();
  const first = q.run(ctrl.signal, async () => { order.push(1); ctrl.abort(); await tick(); order.push(2); return 'committed'; });
  const second = q.run(null, () => { order.push(3); throw new Error('failure'); });
  const failed = assert.rejects(second, /failure/);
  const third = q.run(null, () => { order.push(4); return 'next'; });
  assert.equal(await first, 'committed'); await failed; assert.equal(await third, 'next');
  assert.deepEqual(order, [1, 2, 3, 4]); await tick(); assert.equal(q.busy, false);
});
test('cancellation between admission and execution prevents work', async () => {
  const q = createFileMutationQueue(), ctrl = new AbortController(); let ran = false;
  const result = q.run(ctrl.signal, () => { ran = true; }); ctrl.abort();
  assert.equal((await result).code, 'aborted'); assert.equal(ran, false);
});
