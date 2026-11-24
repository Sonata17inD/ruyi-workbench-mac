'use strict';
require('./lib/self-isolate-home.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness.js');
const t = createRunner('CODEX CLI');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-codex-e2e-'));
process.env.RUYI_HOME = path.join(root, 'ruyi');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
const { loadServerInternals } = require('./lib/server-internals.js');
(async () => {
  // Replace the account in the same runtime as the turn; the binary communicates over real pipes.
  const runtime = loadServerInternals([
    'CodexAccount',
    'LocalSecretCryptoHooks',
    'activeChildren',
    'stopSession',
    'steerSessionCore',
    'pendingPermissions',
    'runSessionTurn',
    'createSession',
    'loadSession',
    'mutateConfig',
  ]);
  const keychain = require('./lib/isolated-keychain-fixture').createIsolatedKeychain(root);
  runtime.LocalSecretCryptoHooks.helperPath = () => keychain;
  runtime.CodexAccount.access = async () => ({ id: 'fixture-account', token: 'fixture-token' });
  const fake = path.join(root, 'codex');
  fs.copyFileSync(path.join(__dirname, 'fixtures/fake-codex.cjs'), fake);
  fs.chmodSync(fake, 0o700);
  await runtime.mutateConfig(async (c) => {
    c.codexPath = fake;
    c.defaultWorkspace = workspace;
    c.includeWorkbenchMcp = false;
  });
  const s = await runtime.createSession({
    cwd: workspace,
    engineRoute: { engine: 'agent', agentCliType: 'codex', model: 'test-model' },
  });
  async function run(message, handle, sessionId = s.id) {
    const events = [];
    await runtime.runSessionTurn({
      sessionId,
      source: 'http',
      message,
      onEvent: (e) => {
        events.push(e);
        handle?.(e);
      },
    });
    return events;
  }
  const first = await run('hello');
  assert.ok(
    first.some((e) => e.type === 'result' && e.ok),
    JSON.stringify(first),
  );
  let saved = await runtime.loadSession(s.id);
  assert.equal(saved.messages.at(-1).content, '你好，Ruyi');
  assert.equal(saved.messages.at(-1).agentCliType, 'codex');
  const nativeId = saved.codexThread.id;
  assert.ok(nativeId);
  assert.equal(saved.messages.at(-1).usage.contextWindow, 200000);
  assert.equal(saved.messages.at(-1).usage.contextTokens, 15);
  assert.deepEqual(saved.messages.at(-1).usage.usage, {
    input_tokens: 7,
    cache_read_input_tokens: 3,
    output_tokens: 5,
  });
  t.ok(true, 'first turn streams a split reply once and persists its native thread');
  const events = await run('approve', (e) => {
    if (e.type === 'permission_request')
      setImmediate(() => runtime.pendingPermissions.get(e.requestId).resolve({ behavior: 'deny' }));
  });
  assert.ok(
    events.some((e) => e.type === 'result' && e.ok),
    JSON.stringify(events),
  );
  saved = await runtime.loadSession(s.id);
  assert.equal(saved.messages.at(-1).content, 'decline');
  const calls = fs.readFileSync(path.join(workspace, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    calls.map((c) => c.method),
    ['thread/start', 'thread/resume'],
  );
  assert.equal(saved.codexThread.id, nativeId);
  t.ok(true, 'follow-up resumes original thread and returns a UI denial to the child');
  const compacted = await run('/compact');
  assert.ok(compacted.some((e) => e.type === 'result' && e.ok));
  assert.equal((await runtime.loadSession(s.id)).codexThread.id, nativeId);
  t.ok(true, 'manual compaction uses the native compaction RPC on the same thread');
  const failed = await run('quota');
  assert.ok(failed.some((e) => e.type === 'result' && !e.ok && /quota/.test(e.error)));
  const partial = (await runtime.loadSession(s.id)).messages.at(-1);
  assert.equal(partial.content, 'partial');
  assert.match(partial.error, /quota/);
  t.ok(true, 'a late quota error preserves partial text and the failed result');
  runtime.CodexAccount.access = async () => ({ id: 'another-fixture-account', token: 'fixture-token-2' });
  await run('another account');
  const switched = await runtime.loadSession(s.id);
  assert.notEqual(switched.codexThread.id, nativeId);
  const latestInput = JSON.parse(
    fs.readFileSync(path.join(workspace, 'inputs.jsonl'), 'utf8').trim().split('\n').at(-1),
  );
  assert.equal(latestInput, 'another account');
  t.ok(true, 'changing accounts starts a new native thread without replaying the other account');
  // The default workbench scheduler serializes writers sharing a workspace.
  const otherWorkspace = fs.mkdtempSync(path.join(root, 'parallel-'));
  const second = await runtime.createSession({
    cwd: otherWorkspace,
    engineRoute: { engine: 'agent', agentCliType: 'codex', model: 'test-model' },
  });
  let signalWaiting;
  const waiting = new Promise(resolve => { signalWaiting = resolve; });
  const activeTurn = run('wait', (event) => {
    if (event.type === 'assistant_delta') signalWaiting();
  });
  let stopped;
  try {
    await Promise.race([waiting, activeTurn.then(() => { throw new Error('turn ended before waiting'); })]);
    const active = runtime.activeChildren.get(s.id);
    let secondPid;
    const crashed = await run('crash', (event) => {
      if (event.type === 'process' && event.state === 'running') secondPid = runtime.activeChildren.get(second.id).pid;
    }, second.id);
    assert.ok(secondPid && secondPid !== active.pid);
    assert.equal(runtime.activeChildren.get(s.id)?.pid, active.pid);
    assert.equal(runtime.activeChildren.has(second.id), false);
    const results = crashed.filter(event => event.type === 'result');
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /disconnected/);
    const other = await runtime.loadSession(second.id);
    assert.notEqual(other.codexThread.id, switched.codexThread.id);
    assert.deepEqual(other.messages.map(m => m.content), ['crash', 'before disconnect']);
    t.ok(true, 'a second concurrent CLI can exit unexpectedly without replay or interruption of its neighbor');
    const steering = await runtime.steerSessionCore({ sessionId: s.id, text: 'use a shorter answer' });
    assert.deepEqual(steering.body, { ok: true, injected: true });
  } finally {
    runtime.stopSession(s.id);
    stopped = await activeTurn;
  }
  assert.ok(stopped.some(e => e.type === 'steered' && e.text === 'use a shorter answer'));
  const afterStop = await runtime.loadSession(s.id);
  assert.equal(afterStop.messages.filter(m => m.steered && m.content === 'use a shorter answer').length, 1);
  t.ok(true, 'the Ruyi steering entry delivers and persists one mid-turn message on the active Codex turn');
  assert.ok(
    stopped.some((e) => e.type === 'result' && e.aborted && !e.ok),
    JSON.stringify(stopped),
  );
  assert.equal(runtime.activeChildren.size, 0);
  t.ok(true, 'stop interrupts the correct child and settles the session');
  let accountRequests = 0;
  runtime.CodexAccount.access = async () => { accountRequests++; throw new Error('unexpected account request'); };
  await runtime.mutateConfig(async config => {
    config.credentialEncryptionV1 = true;
    config.privacyModeV1 = 'enhanced';
  });
  const privateTurn = await run('private message');
  assert.ok(privateTurn.some(e => e.type === 'error' && /privacy\.engine_not_supported/.test(e.error)));
  assert.equal(accountRequests, 0);
  assert.ok(!privateTurn.some(e => e.type === 'process' && e.state === 'running'));
  t.ok(true, 'enhanced privacy refuses a Codex turn before account access or CLI execution');
})()
  .catch((e) => t.fail(e.stack))
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
    t.done();
  });
