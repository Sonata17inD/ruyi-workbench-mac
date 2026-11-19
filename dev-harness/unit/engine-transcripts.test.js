'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngineTranscriptStore } = require('../../ruyi-workbench/app/backend/engine-transcripts.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
test('concurrent cold admission waits for the same ledger read before recording any new identity', async () => {
  let release, reads = 0;
  const writes = [], input = new Promise(resolve => { release = resolve; });
  const store = createEngineTranscriptStore({ paths: { data: '/fixture', sessions: '/fixture/sessions' },
    sessionIndexFile: 'index.json', safeJsonParse: JSON.parse, nowIso: () => 'fixture-time',
    fsp: { readFile: () => { reads++; return input; } },
    atomicWriteJson: async (_file, data) => { writes.push(structuredClone(data)); },
  });
  const one = store.recordEngineTranscript('new-session-one', '/one');
  const two = store.recordEngineTranscript('new-session-two', '/two');
  const existing = store.engineTranscriptCwd('existing-session');
  await tick();
  assert.equal(reads, 1); assert.equal(writes.length, 0);
  release(JSON.stringify({ version: 1, known: { 'existing-session': { cwd: '/original', firstSeen: 'before' } } }));
  await Promise.all([one, two]);
  assert.equal(await existing, '/original');
  assert.deepEqual(Object.keys(writes.at(-1).known).sort(), ['existing-session', 'new-session-one', 'new-session-two']);
  assert.equal(writes.at(-1).known['existing-session'].firstSeen, 'before');
  const count = writes.length;
  await store.recordEngineTranscript('new-session-one', '/replacement');
  assert.equal(writes.length, count); assert.equal(await store.engineTranscriptCwd('new-session-one'), '/one');
});
test('untrusted transcript identity cannot read or write the ledger', async () => {
  const forbidden = () => { throw Error('unexpected IO'); };
  const store = createEngineTranscriptStore({ paths: {}, nowIso: forbidden, safeJsonParse: JSON.parse,
    atomicWriteJson: forbidden, fsp: { readFile: forbidden } });
  for (const id of ['../outside', 'x', 'a/bbbbbbb', 'a\\bbbbbbb']) {
    await store.recordEngineTranscript(id, '/fixture');
    assert.equal(await store.engineTranscriptCwd(id), '');
  }
});
