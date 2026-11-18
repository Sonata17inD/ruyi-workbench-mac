'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProviderHistory } = require('../../ruyi-workbench/app/backend/provider-history.cjs');
function fixture() {
  const logs = [];
  return { logs, ...createProviderHistory({ logEvent: e => logs.push(e) }) };
}
test('large interrupted histories preserve original objects, order, uncertainty and repair idempotently', () => {
  const service = fixture(); const history = [], originals = [];
  for (let n = 0; n < 5000; n++) {
    const call = { role: 'assistant', tool_calls: [{ id: 'existing-' + n }, { id: 'missing-' + n }] };
    const reply = { role: 'tool', tool_call_id: 'existing-' + n, content: 'original' };
    const user = { role: 'user', content: String(n) };
    originals.push(call, reply, user); history.push(call, reply, user);
  }
  assert.equal(service.repairProviderHistoryPairing(history), 5000);
  assert.equal(history.length, 20000);
  for (let n = 0; n < 5000; n++) {
    assert.equal(history[n * 4], originals[n * 3]); assert.equal(history[n * 4 + 1], originals[n * 3 + 1]);
    assert.equal(history[n * 4 + 3], originals[n * 3 + 2]);
    assert.equal(history[n * 4 + 2].tool_call_id, 'missing-' + n);
    assert.match(history[n * 4 + 2].content, /未确认.*勿自动重放/);
  }
  assert.equal(service.repairProviderHistoryPairing(history), 0);
});
test('valid arguments retain exact bytes; malformed fragments are repaired without logging secrets', () => {
  const service = fixture(); const secret = 'secret-input';
  const calls = [{ id: 'good', name: 'read', rawArgs: '{ "path": "a" }' }, { id: 'bad', name: 'read', rawArgs: '{"secret":"' + secret }];
  const wire = service.providerHistoryToolCalls(calls);
  assert.equal(wire[0].function.arguments, calls[0].rawArgs); assert.equal(wire[1].function.arguments, '{}');
  assert.equal(calls[1].rawArgs.includes(secret), true); assert.equal(JSON.stringify(service.logs).includes(secret), false);
});
test('engine switching mirrors new display messages once without embedding historical image bytes', () => {
  const service = fixture();
  const attachment = { path: '/fixture/photo.png', data: 'pixel-secret' };
  const session = { messages: [{ role: 'user', content: 'question', attachments: [attachment] }, { role: 'assistant', content: 'answer', engine: 'claude' }] };
  service.syncProviderHistoryFromDisplay(session); service.syncProviderHistoryFromDisplay(session);
  assert.equal(session.providerHistory.length, 2); assert.equal(JSON.stringify(session.providerHistory).includes('pixel-secret'), false);
  assert.match(session.providerHistory[0].content, /photo\.png/);
  session.messages.push({ role: 'user', content: 'followup' }); service.syncProviderHistoryFromDisplay(session);
  assert.equal(session.providerHistory.length, 3); assert.equal(session.providerHistoryCursor, 3);
});
