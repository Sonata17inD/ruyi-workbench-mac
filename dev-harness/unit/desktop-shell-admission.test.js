'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopShell } = require('../../ruyi-workbench/app/backend/desktop-shell.cjs');
test('async admission returns cancellation and capability failures without accessing a child', async () => {
  for (const error of [Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }), Object.assign(new Error('missing helper'), { code: 'process_helper_missing', capability: { ready: false } })]) {
    let admitted;
    const signal = AbortSignal.abort();
    const shell = createDesktopShell({ ProcessRuntime: {
      currentOwner: () => ({ sessionId: 'test' }),
      start: async spec => { admitted = spec; throw error; },
      child: () => { throw Error('child must not be accessed'); },
    } });
    const result = await shell.runProcess('/usr/bin/true', [], { signal });
    assert.equal(admitted.signal, signal);
    assert.equal(admitted.owner.sessionId, 'test');
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, error.code);
    assert.equal(result.interrupted, error.code === 'ABORT_ERR');
  }
});
test('unexpected admission failure rejects instead of leaving a pending result', async () => {
  const error = new Error('fixture transport failure');
  const shell = createDesktopShell({ ProcessRuntime: { currentOwner: () => ({}), start: async () => { throw error; } } });
  await assert.rejects(shell.runProcess('/usr/bin/true', []), value => value === error);
});
