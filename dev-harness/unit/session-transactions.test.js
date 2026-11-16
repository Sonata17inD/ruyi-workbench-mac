'use strict';
require('../lib/self-isolate-home');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionTransactions } = require('../../ruyi-workbench/app/backend/session-transactions.cjs');
const { runKeyedChain } = require('../../ruyi-workbench/app/server.js');
function fixture(overrides = {}) {
  let stored = { id: 's', rewindGen: 0, count: 0 };
  const service = createSessionTransactions({
    runKeyedChain, logEvent() {}, loadSession: async () => structuredClone(stored),
    saveSession: async value => { stored = structuredClone(value); }, ...overrides,
  });
  return { service, read: () => stored };
}
test('same-session recursive mutation fails promptly and does not poison the queue', { timeout: 2000 }, async () => {
  const { service, read } = fixture();
  await assert.rejects(service.mutateSession('s', () => service.mutateSession('s', () => {})), { code: 'SESSION_MUTATION_REENTRANT' });
  await assert.rejects(service.withSessionMutateLock('s', () => service.withSessionMutateLock('other', () => service.mutateSession('s', () => {}))), { code: 'SESSION_MUTATION_REENTRANT' });
  await Promise.all(Array.from({ length: 8 }, () => service.mutateSession('s', s => { s.count++; })));
  assert.equal(read().count, 8);
});
test('detached continuation may start a fresh transaction after its inherited scope has finished', { timeout: 2000 }, async () => {
  const { service, read } = fixture();
  let release, later;
  const gate = new Promise(resolve => { release = resolve; });
  await service.mutateSession('s', s => {
    s.count++;
    later = gate.then(() => service.mutateSession('s', next => { next.count++; }));
  });
  release(); await later;
  assert.equal(read().count, 2);
});
test('rewind retries are bounded and an expected generation never replays calculated work', async () => {
  let writes = 0, mutations = 0;
  const { service } = fixture({ saveSession: async () => { writes++; throw Object.assign(new Error('stale'), { code: 'SESSION_STALE_SAVE' }); } });
  await assert.rejects(service.mutateSession('s', () => { mutations++; }), { code: 'session.rewound_during_write' });
  assert.equal(mutations, 3); assert.equal(writes, 3);
  mutations = writes = 0;
  await assert.rejects(service.mutateSession('s', () => { mutations++; }, { expectGen: 0 }), { code: 'session.rewound_during_write' });
  assert.equal(mutations, 1); assert.equal(writes, 1);
});
