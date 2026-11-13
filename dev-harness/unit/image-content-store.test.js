'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createImageContentStore } = require('../../ruyi-workbench/app/backend/image-content.cjs');

test('identical pixels share a content reference without sharing frame identity', () => {
  const store = createImageContentStore();
  const pixels = Buffer.from('synthetic pixels');
  const a = store.intern(pixels, 'image/png');
  const b = store.intern(Buffer.from(pixels), 'image/png');
  assert.equal(a, b);
  assert.equal(a.hash, createHash('sha256').update(pixels).digest('hex'));
  assert.equal(Object.isFrozen(a), true);
  const frames = [{ id: 'a', origin: { x: -10, y: 0 }, content: a },
    { id: 'b', origin: { x: 0, y: 0 }, content: b }];
  assert.notEqual(frames[0].id, frames[1].id);
  assert.equal(frames[0].content, frames[1].content);
  store.clear();
  assert.equal(store.stats().bytes, 0);
  assert.equal(frames[0].content.uri, 'data:image/png;base64,' + pixels.toString('base64'));
});
test('LRU cache bounds entries and bytes; evicted and oversize content remains usable', () => {
  const store = createImageContentStore({ maxBytes: 200, maxEntries: 2 });
  const a = store.intern(Buffer.from('a'), 'image/png');
  store.intern(Buffer.from('b'), 'image/png');
  assert.equal(store.intern(Buffer.from('a'), 'image/png'), a);
  store.intern(Buffer.from('c'), 'image/png');
  assert.equal(store.intern(Buffer.from('a'), 'image/png'), a);
  assert.equal(store.stats().entries, 2);
  assert.ok(store.stats().bytes <= 200);
  const large = store.intern(Buffer.alloc(200), 'image/png');
  assert.equal(large.bytes, 200);
  assert.equal(store.stats().entries, 2);
});
