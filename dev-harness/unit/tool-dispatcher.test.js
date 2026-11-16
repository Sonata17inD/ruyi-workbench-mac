'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createToolDispatcher } = require('../../ruyi-workbench/app/backend/tool-dispatcher.cjs');

function fixture(overrides = {}) {
  const calls = [];
  const dispatcher = createToolDispatcher({
    groups: [{ write: { handler: async (args, ctx) => { calls.push(['handler', args, ctx]); return { ok: true }; } } }],
    levenshtein: () => 0, isStewardToolName: () => false,
    nativeToolSchema: () => ({ type: 'object', required: ['path'], properties: { path: { type: 'string' } } }),
    DesktopExecutionHooks: { enabled: () => true, guard: async id => calls.push(['guard', id]) },
    PrivacyGateway: { active: () => false, assertSupported: config => calls.push(['privacy', config]), assertToolChannel: () => calls.push(['channel']) },
    readConfig: async () => ({ persisted: true }),
    NATIVE_COMMAND_TOOL_NAMES: new Set(['write']), NATIVE_DESKTOP_TOOL_NAMES: new Set(),
    policySessionFor: async () => null, nativeToolDisabledByPolicy: () => '',
    sessionDesktopToolsOf: () => null, toolDisabledResult: () => ({ ok: false, code: 'tool-disabled' }),
    normalizeMetaToolArgs: (name, args) => args,
    ProcessRuntime: { withOwner: async (owner, run) => { calls.push(['owner', owner]); return run(); } },
    makeId: () => 'invocation', FileTextIo: { fsErrorEnvelope: () => ({ ok: false, code: 'bad_path' }) },
    ...overrides,
  });
  return { dispatcher, calls };
}

test('registration rejects duplicates and cannot resolve inherited object names', async () => {
  assert.throws(() => createToolDispatcher({ groups: [{ x: {} }, { x: {} }] }), /duplicate tool: x/);
  const { dispatcher } = fixture();
  assert.ok(Object.isFrozen(dispatcher.TOOL_HANDLERS));
  for (const name of ['constructor', 'toString', '__proto__']) await assert.rejects(dispatcher.toolCall(name), /Unknown tool/);
});

test('execution checks receipt and persisted privacy before handler, with explicit owner identity', async () => {
  const { dispatcher, calls } = fixture();
  const ctx = { sessionId: 's', turnSeq: 7, toolCallId: 't' };
  assert.deepEqual(await dispatcher.toolCall('write', { path: 'a' }, ctx), { ok: true });
  assert.deepEqual(calls.map(row => row[0]), ['guard', 'privacy', 'channel', 'owner', 'handler']);
  assert.deepEqual(calls[1][1], { persisted: true });
  assert.deepEqual(calls[3][1], { toolName: 'write', sessionId: 's', turnSeq: 7, toolCallId: 't', invocationId: 'invocation' });
  assert.equal(calls[4][2], ctx);
});

test('policy rejection and schema errors never reach the handler', async () => {
  const denied = fixture({ nativeToolDisabledByPolicy: () => 'command-disabled' });
  assert.equal((await denied.dispatcher.toolCall('write', { path: 'x' })).code, 'tool-disabled');
  assert.ok(!denied.calls.some(row => row[0] === 'handler'));
  const invalid = fixture();
  assert.equal((await invalid.dispatcher.toolCall('write', {})).code, 'invalid-arguments');
  assert.ok(!invalid.calls.some(row => row[0] === 'handler'));
});

test('incomplete cleanup remains structured and unrelated failures propagate', async () => {
  const failure = { searchExecutionFailure: true, code: 'cancelled', message: 'stopped', cleanupIncomplete: true, cleanupScope: 'observed-only' };
  const { dispatcher } = fixture({ groups: [{ write: { handler: async () => { throw failure; } } }] });
  assert.deepEqual(await dispatcher.toolCall('write', { path: 'x' }), { ok: false, code: 'cancelled', error: 'stopped', cleanupIncomplete: true, cleanupScope: 'observed-only' });
  const error = new Error('failed');
  const other = fixture({ groups: [{ write: { handler: async () => { throw error; } } }] });
  await assert.rejects(other.dispatcher.toolCall('write', { path: 'x' }), e => e === error);
});
