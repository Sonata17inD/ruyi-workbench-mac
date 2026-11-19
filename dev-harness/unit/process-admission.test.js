'use strict';
require('../lib/self-isolate-home');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadServerInternals } = require('../lib/server-internals');
const S = loadServerInternals(['ProcessRuntime', 'ProcessRuntimeHooks', 'shellStart', 'shellKill', 'shellSessions', 'McpStdioClient']);
const { createProcessRuntime } = require('../../ruyi-workbench/app/backend/process-runtime.cjs');
const runtime = createProcessRuntime({ hooks: S.ProcessRuntimeHooks, desktopCapabilities: async () => ({ ready: false }) });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-admission-'));
const helper = path.join(root, 'helper');
const launches = path.join(root, 'launches');
const probes = path.join(root, 'probes');
const original = S.ProcessRuntimeHooks.helperPath;
const report = { protocolVersion: 3, guardian: true, supervise: true, privateFd: true, identityCleanup: true, escapeCoverage: 'observed-only', deadline: true };
let version = 0;
function fixture(delay = 180) {
  fs.writeFileSync(helper, `#!${process.execPath}\n// version ${++version}\nconst fs=require('fs');if(process.argv[2]==='--capabilities'){fs.appendFileSync(${JSON.stringify(probes)},'p');setTimeout(()=>console.log(${JSON.stringify(JSON.stringify(report))}),${delay});}else{fs.writeFileSync(${JSON.stringify(launches)},'unexpected target');}\n`, { mode: 0o700 });
  S.ProcessRuntimeHooks.helperPath = () => helper;
}
after(() => { S.ProcessRuntimeHooks.helperPath = original; fs.rmSync(root, { recursive: true, force: true }); });

test('start/spawn/capture cancelled during cold admission never launch and do not block the event loop', async () => {
  for (const method of ['start', 'spawn', 'capture']) {
    fixture();
    const controller = new AbortController();
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 5);
    const pending = method === 'start'
      ? runtime.start({ executable: '/usr/bin/true', signal: controller.signal })
      : runtime[method]('/usr/bin/true', [], { signal: controller.signal, maxBuffer: 4096 }, { kind: 'admission-test' });
    setTimeout(() => controller.abort('test-cancel'), 30);
    try { await assert.rejects(pending, { code: 'ABORT_ERR' }); }
    finally { clearInterval(ticker); }
    assert.ok(ticks > 1, method + ' yielded while probing');
    await runtime.helperCapabilityAsync(); // shared probe may finish after this caller cancels
    assert.equal(fs.existsSync(launches), false, method + ' did not launch');
  }
});

test('capability cache follows executable identity, not a one-second expiry', async () => {
  fixture(20);
  const before = fs.readFileSync(probes, 'utf8').length;
  await Promise.all([runtime.helperCapabilityAsync(), runtime.helperCapabilityAsync()]);
  assert.equal(fs.readFileSync(probes, 'utf8').length, before + 1);
  await new Promise(resolve => setTimeout(resolve, 1100));
  await runtime.helperCapabilityAsync();
  assert.equal(fs.readFileSync(probes, 'utf8').length, before + 1);
  fixture(20);
  await runtime.helperCapabilityAsync();
  assert.equal(fs.readFileSync(probes, 'utf8').length, before + 2);
});

test('lifecycle guard is checked after the asynchronous probe', async () => {
  fixture();
  let closed = false;
  const pending = runtime.spawn('/usr/bin/true', [], {
    admit() { if (closed) throw Object.assign(new Error('owner closed'), { code: 'ABORT_ERR' }); },
  });
  closed = true;
  await assert.rejects(pending, { code: 'ABORT_ERR' });
  assert.equal(fs.existsSync(launches), false);
});


test('interactive shell reserves capacity and can be killed while admission is pending', async () => {
  fixture();
  const first = S.shellStart({ shellId: 'pending-shell', cwd: root }, { shellSessionMax: 1 }, { sessionId: 'owner' });
  const second = await S.shellStart({ cwd: root }, { shellSessionMax: 1 }, { sessionId: 'owner' });
  assert.equal(second.ok, false);
  assert.match(second.error, /上限/);
  assert.equal(S.shellKill({ shellId: 'pending-shell' }, { sessionId: 'owner' }).ok, true);
  const cancelled = await first;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, 'ABORT_ERR');
  assert.equal(S.shellSessions.size, 0);
  assert.equal(fs.existsSync(launches), false);
});

test('closing an MCP client during admission prevents the connector process from starting', async () => {
  fixture();
  const client = new S.McpStdioClient({ id: 'pending-mcp', command: '/usr/bin/true', args: [], env: {} });
  const pending = client.start();
  client.kill();
  await assert.rejects(pending, /cancelled/);
  assert.equal(client.child, null);
  assert.equal(fs.existsSync(launches), false);
});
