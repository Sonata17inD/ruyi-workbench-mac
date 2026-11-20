'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('MACOS OVERLAY BOUNDARY');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-overlay-mac-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
process.env.RUYI_HOME = path.join(root, 'loader-data');
const realFetch = global.fetch;
let child;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP requires macOS platform routes'); return; }
    const { CONFIG_SCHEMA } = loadServerInternals(['CONFIG_SCHEMA']);
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: CONFIG_SCHEMA, defaultWorkspace: root,
      stewardEnabledV1: false, schedulerEnabledV1: false, autoImportClaudeCodeMcp: false,
      includeWorkbenchMcp: false, enableMcpDropIn: false, desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [], providers: [] }));
    const calls = path.join(root, 'powershell-called');
    const preload = path.join(root, 'no-powershell.cjs');
    fs.writeFileSync(preload, `const cp=require('child_process'),fs=require('fs');const original=cp.execFile;cp.execFile=function(command,args,options,callback){if(/^powershell(?:\\.exe)?$/i.test(command)){fs.writeFileSync(${JSON.stringify(calls)},command);return original.call(this,process.execPath,['-e','process.exit(99)'],options,callback)}return original.apply(this,arguments)};`);
    const port = await getFreePort();
    const base = 'http://127.0.0.1:' + port;
    child = cp.spawn(process.execPath, ['--require', preload, path.resolve(__dirname, '../ruyi-workbench/app/server.js'), 'serve', '--port', String(port)], {
      cwd: root, env: { ...process.env, ...fixtureChildEnv(), RUYI_HOME: data }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output = (output + b).slice(-12000); });
    const deadline = Date.now() + 30000;
    let healthy = false;
    while (!healthy && Date.now() < deadline) {
      try { healthy = (await (await realFetch(base + '/health', { signal: AbortSignal.timeout(500) })).json()).ok; } catch { /* starting */ }
      if (!healthy) await sleep(50);
    }
    if (!healthy) throw new Error(output);
    const token = (await (await realFetch(base + '/api/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).token;
    if (!token) throw new Error('bootstrap token missing');
    const headers = { 'content-type': 'application/json', 'x-wcw-token': token };
    const zipPath = path.join(root, 'fixture.zip'); fs.writeFileSync(zipPath, 'fixture');
    for (const action of ['precheck', 'apply', 'rollback']) {
      const denied = await realFetch(base + '/api/overlay/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ zipPath }) });
      t.ok(denied.status === 403, action + ' retains authentication before platform rejection');
      const response = await realFetch(base + '/api/overlay/' + action, { method: 'POST', headers, body: JSON.stringify({ zipPath, force: true }) });
      t.ok(response.status === 403, action + ' is absent from the authorized route surface');
    }
    t.ok(!fs.existsSync(calls) && !fs.existsSync(path.join(data, 'overlay-tool')), 'rejected operations launch no PowerShell and create no extraction/cache directory');
    t.ok((await realFetch(base + '/api/overlay/status')).status === 403, 'read-only overlay status retains token authentication');
    t.ok((await realFetch(base + '/api/overlay/status', { headers })).status === 403, 'removed status endpoint is denied even with a token');

    const ui = fs.readFileSync(path.resolve(__dirname, '../ruyi-workbench/app/public/js/settings-operations.js'), 'utf8');
    t.ok(!ui.includes('/api/overlay/'), 'settings no longer exposes an overlay execution client');
    t.ok((await (await realFetch(base + '/health')).json()).ok, 'platform rejection leaves the service healthy');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    global.fetch = realFetch;
    if (child) { killOwnTree(child); if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('close', resolve)); }
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();
