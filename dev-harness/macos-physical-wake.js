'use strict';
require('./lib/self-isolate-home');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree, snapshotProcessTable } = require('./lib/kill-own-tree');
const { attachTrial, detachTrial, installTrial, verifyDistribution, verifyTrialDirectory, verifyInstalledApp } =
  require('../ruyi-workbench/tools/package-macos-trial');

// The operator controls sleep and wake. Only NSWorkspace callbacks from a real
// power cycle and the corresponding power log can satisfy this probe.
async function wakePage(marker) {
  const { api, apiRaw } = await import('/js/net.js');
  const { createEventStream } = await import('/js/event-stream.js');
  const cursors = [];
  const stream = createEventStream({ requestImpl: (url, options) => {
    cursors.push(options.headers['last-event-id'] || '');
    return apiRaw(url, options);
  } });
  const wait = async (predicate, timeout) => {
    const end = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() >= end) throw new Error('Wake page did not receive the expected SSE state');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const record = title => api('/api/sessions', { method: 'POST', body: JSON.stringify({ title }) });
  stream.start();
  await wait(() => stream.isConnected(), 10000);
  await record(marker + '-before');
  await wait(() => !!stream.stats().lastEventId, 10000);
  const observeStream = () => ({ ...stream.stats(), requestCount: cursors.length });
  let before = observeStream();
  globalThis.addEventListener('ruyi:host-suspend', () => { before = observeStream(); });
  globalThis.addEventListener('ruyi:host-wake', async () => {
    try {
      await wait(() => stream.isConnected() && stream.stats().connects > before.connects, 12000);
      const after = stream.stats();
      if (!before.lastEventId || !cursors.slice(before.requestCount).includes(before.lastEventId)
        || after.serverInstanceId !== before.serverInstanceId) throw new Error('SSE replay identity changed');
      await record(marker + '-awake');
    } catch {
      await record(marker + '-failed');
    }
  }, { once: true });
  return { cursor: before.lastEventId, serverInstanceId: before.serverInstanceId };
}

async function until(read, label, timeout) {
  const deadline = Date.now() + timeout;
  do {
    const result = await read();
    if (result) return result;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + label);
}

const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const command = (name, args, options = {}) => cp.execFileSync(name, args,
  { encoding: 'utf8', timeout: 12000, ...options });
function requireUnlockedConsole() {
  const session = command('/usr/sbin/ioreg', ['-l', '-w0', '-n', 'Root', '-d1']);
  if (!session.includes('"kCGSSessionOnConsoleKey"=Yes') || session.includes('"CGSSessionScreenIsLocked"=Yes')) {
    throw new Error('Physical wake qualification requires an unlocked local desktop');
  }
}

function powerCycleAfter(start) {
  const log = command('/usr/bin/pmset', ['-g', 'log'], { maxBuffer: 32 * 1024 * 1024 });
  let sleep;
  for (const line of log.split('\n')) {
    const match = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d{4})\s+(Sleep|Wake)\s+(.+)/.exec(line);
    if (!match) continue;
    const [, date, time, zone, kind, detail] = match;
    const at = Date.parse(date + 'T' + time + zone);
    if (!Number.isFinite(at) || at < start) continue;
    // Apple Silicon can record explicit System Sleep as an entry into DarkWake.
    if (kind === 'Sleep' && /^Entering (?:Sleep|DarkWake) state\b/.test(detail)) sleep = { at, line };
    if (sleep && kind === 'Wake' && at >= sleep.at && /Wake from|to FullWake/.test(detail)) {
      return { sleep: sleep.line, wake: line };
    }
  }
  return null;
}

function snapshot(report) {
  const table = snapshotProcessTable();
  assert.ok(table, 'Native process identities are available');
  const app = table.find(row => row.pid === report.nativePID);
  const service = table.find(row => row.pid === report.servicePID && row.ppid === report.nativePID);
  assert.ok(app && service && service.created >= app.created, 'Fixture App owns this backend');
  return { app: { pid: app.pid, birth: String(app.created) }, service: { pid: service.pid, birth: String(service.created) } };
}

async function request(report, runtime, endpoint) {
  const url = new URL(endpoint, report.url);
  assert.equal(url.origin, 'http://127.0.0.1:' + runtime.port);
  const response = await fetch(url, { headers: { 'x-wcw-token': runtime.token }, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200, endpoint);
  return response.json();
}

async function run() {
  const [full, slim, output, option, ...extra] = process.argv.slice(2);
  assert.ok(process.platform === 'darwin' && full && slim && output && !extra.length
    && (!option || option === '--preflight'), 'Usage: node dev-harness/macos-physical-wake.js FULL_TRIAL SLIM_TRIAL REPORT [--preflight]');
  const preflight = option === '--preflight';
  if (!preflight) requireUnlockedConsole();
  assert.ok(!fs.existsSync(output), 'Use a new evidence path');
  const distributions = [full, slim].map(directory => ({ directory: path.resolve(directory),
    details: verifyDistribution(path.resolve(directory)) }));
  assert.deepEqual(distributions.map(({ details }) => details.variant), ['full', 'slim']);
  assert.equal(distributions[0].details.applicationSourceCommit, distributions[1].details.applicationSourceCommit);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-physical-wake-'));
  const hosts = [];
  try {
    for (const { directory, details } of distributions) {
      const { variant, image, imageSha256, appTreeSha256, applicationSourceCommit } = details;
      const mount = path.join(root, variant + '-mount');
      attachTrial(path.join(directory, image), mount);
      let bundle, manifest;
      try {
        ({ manifest } = verifyTrialDirectory(mount));
        assert.equal(manifest.treeSha256, appTreeSha256);
        assert.equal(manifest.sourceCommit, applicationSourceCommit);
        bundle = installTrial(mount, path.join(root, variant + '-apps'));
      } finally { detachTrial(mount); }
      const fixture = fixtureChildEnv({ perTest: true });
      const host = { fixture, bundle, manifest, variant, imageSha256, appTreeSha256, marker: 'Wake-' + randomUUID() };
      hosts.push(host);
      const data = path.join(fixture.home, 'data'), workspace = path.join(fixture.home, 'workspace');
      fs.mkdirSync(data); fs.mkdirSync(workspace);
      fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 14, defaultWorkspace: workspace,
        workspaces: [{ path: workspace }], providers: [], stewardEnabledV1: false, schedulerEnabledV1: false,
        includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false,
        desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [] }));
      host.file = path.join(root, variant + '-host.json');
      const script = path.join(root, variant + '-page.js');
      fs.writeFileSync(script, 'return await (' + wakePage.toString() + ')(' + JSON.stringify(host.marker) + ');');
      host.child = cp.spawn(path.join(bundle, 'Contents/MacOS/RuyiDesktop'), ['--acceptance-report', host.file,
        '--acceptance-script', script], { cwd: root, env: { ...process.env, ...fixture.env,
        RUYI_HOME: data, RUYI_NODE_PATH: '/missing/node' }, stdio: 'ignore' });
      host.child.on('error', error => { host.error = error; });
      host.before = await until(() => {
        if (host.error) throw host.error;
        if (host.child.exitCode !== null || host.child.signalCode !== null) throw new Error(variant + ' exited during launch');
        if (!fs.existsSync(host.file)) return null;
        const state = json(host.file);
        if (state.state === 'failed') throw new Error(variant + ' native startup failed: ' + state.code);
        return state.state === 'ready' && state;
      }, variant + ' native startup', 60000);
      assert.equal(host.before.nativePID, host.child.pid);
      assert.equal(host.before.simulatedSystemEvents, false);
      assert.equal(host.before.sleepEvents + host.before.wakeEvents, 0);
      assert.ok(host.before.page.additional.cursor && host.before.page.additional.serverInstanceId);
      host.runtime = json(path.join(data, 'runtime.json'));
      assert.equal(host.runtime.pid, host.before.servicePID);
      host.identity = snapshot(host.before);
      host.health = await request(host.before, host.runtime, '/health');
      assert.ok(host.health.ok && host.health.overlayId);
    }

    const armed = Date.now();
    let power = null;
    if (!preflight) {
      requireUnlockedConsole();
      console.log('READY: both installed Apps are armed. Put the Mac to sleep and wake it once.');
      function currentReport(host) {
        assert.ok(host.child.exitCode === null && host.child.signalCode === null, host.variant + ' exited during power cycle');
        return json(host.file);
      }
      await Promise.all(hosts.map(host => until(() => currentReport(host).sleepEvents > 0,
        host.variant + ' sleep notification', 300000)));
      console.log('SLEEP: both Apps received the sleep notification. Wake and unlock the Mac.');
      await Promise.all(hosts.map(host => until(() => currentReport(host).wakeEvents > 0,
        host.variant + ' wake notification', 3600000)));
      await Promise.all(hosts.map(host => until(async () => {
        const current = currentReport(host);
        if (!current.wakeValidated) return false;
        assert.equal(current.simulatedSystemEvents, false);
        assert.ok(current.sleepEvents > 0 && current.wakeEvents > 0);
        assert.deepEqual(snapshot(current), host.identity);
        const health = await request(current, host.runtime, '/health');
        assert.ok(health.ok);
        assert.equal(health.overlayId, host.health.overlayId);
        const sessions = await request(current, host.runtime, '/api/sessions');
        assert.ok(!sessions.sessions?.some(row => row.title === host.marker + '-failed'), host.variant + ' SSE replay failed');
        if (!sessions.sessions?.some(row => row.title === host.marker + '-awake')) return false;
        host.after = { sleepEvents: current.sleepEvents, wakeEvents: current.wakeEvents, wakeValidated: current.wakeValidated,
          simulatedSystemEvents: current.simulatedSystemEvents, pageConfirmedSseResume: true };
        return true;
      }, host.variant + ' post-wake health and page recovery', 60000)));
      power = await until(() => powerCycleAfter(Math.floor(armed / 1000) * 1000), 'corresponding macOS power log', 12000);
    }

    for (const host of hosts) {
      host.child.kill('SIGTERM');
      await until(() => host.child.exitCode !== null || host.child.signalCode !== null, host.variant + ' exit', 15000);
      assert.equal(host.child.exitCode, 0);
      await until(() => {
        const table = snapshotProcessTable();
        return table && !table.some(row => row.pid === host.identity.service.pid && String(row.created) === host.identity.service.birth);
      }, host.variant + ' backend cleanup', 12000);
      verifyInstalledApp(host.bundle, host.manifest);
    }
    const evidence = { sourceCommit: distributions[0].details.applicationSourceCommit, preflight,
      qualified: !preflight, armedAt: new Date(armed).toISOString(), power,
      variants: hosts.map(({ variant, imageSha256, appTreeSha256, before, identity, health, after }) =>
        ({ variant, imageSha256, appTreeSha256, identity, overlayId: health.overlayId,
          pageBefore: before.page.additional, sleptAndWoke: after || null, exitedCleanly: true })) };
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(preflight ? 'Preflight passed. Real power cycle remains pending.' : 'Physical sleep/wake qualified both Apps.');
  } finally {
    for (const host of hosts) {
      killOwnTree(host.child);
      fs.rmSync(host.fixture.home, { recursive: true, force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
