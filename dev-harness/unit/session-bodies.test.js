'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionBodies } = require('../../ruyi-workbench/app/backend/session-bodies.cjs');
const service = options => createSessionBodies({ isWriting: () => false, logEvent() {}, ...options });

test('cache state is bounded per service and active writers retain their comparison evidence', () => {
  const a = service({ isWriting: id => id === 'writer' }), b = service();
  const record = () => ({ msg: a.sessionBodyRecord(['{"role":"user"}']), bodiesOk: true });
  a.setSessionBodyState('writer', record());
  for (let i = 0; i < 129; i++) a.setSessionBodyState('s' + i, record());
  assert.equal(a.sessionBodyPerfStats.stateEntries, 128);
  assert.ok(a.getSessionBodyState('writer'));
  assert.equal(a.getSessionBodyState('s0'), undefined);
  assert.equal(b.sessionBodyPerfStats.stateEntries, 0);
  a.dropSessionBodyState('writer');
  assert.equal(a.sessionBodyPerfStats.stateEntries, 127);
});

test('NDJSON decoding reports torn bytes without changing storage and distinguishes missing from unreadable', async () => {
  let attempts = 0;
  const bytes = Buffer.from('{"text":"你好"}\n{"partial":');
  const store = service({ fsp: {
    async stat() { return { size: BigInt(bytes.length), mtimeNs: 1n, ino: 2n }; },
    async readFile() { if (++attempts === 1) throw Object.assign(new Error(), { code: 'EBUSY' }); return bytes; },
  } });
  assert.deepEqual(await store.readSessionBodyFile('fixture'), { unreadable: true, code: 'EBUSY' });
  assert.equal(attempts, 1);
  const body = await store.readSessionBodyFile('fixture');
  assert.equal(attempts, 2);
  assert.deepEqual(body.entries, [{ text: '你好' }]);
  assert.equal(body.tornAt, Buffer.byteLength('{"text":"你好"}\n'));
  for (const code of ['ENOENT', 'EIO']) {
    const failed = service({ fsp: { async stat() { return null; }, async readFile() { throw Object.assign(new Error(), { code }); } } });
    assert.deepEqual(await failed.readSessionBodyFile('fixture'), code === 'ENOENT' ? null : { unreadable: true, code });
  }
});

test('prefix proof rejects changed messages while canonical bytes produce identical stamps', () => {
  const store = service(), messages = [{ role: 'user', content: '你好' }, { role: 'assistant', content: 'answer' }];
  const stamp = store.sessionMessagesStamp(messages.slice(0, 1));
  const lines = messages.map(value => JSON.stringify(value) + '\n');
  const body = { buf: Buffer.from(lines.join('')), count: 2, lineEndBytes: [Buffer.byteLength(lines[0]), Buffer.byteLength(lines.join(''))] };
  assert.deepEqual(store.sessionMessagesDelta(messages, '1', stamp, body), store.sessionMessagesDelta(messages, '1', stamp));
  assert.equal(store.sessionMessagesDelta([{ role: 'user', content: 'changed' }, messages[1]], '1', stamp), null);
});
