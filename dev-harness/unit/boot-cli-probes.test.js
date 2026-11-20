'use strict';
// No listener or CLI processes: exercise real config reads against controlled first probes.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process');
const { loadServerInternals } = require('../lib/server-internals');
const { releaseEnvironment } = require('../lib/release-checks');
const savedProcesses = new Map();
let processAttempts = 0;
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  savedProcesses.set(key, cp[key]);
  cp[key] = () => { processAttempts++; throw Error('A pure boot probe test cannot start a process.'); };
}
after(() => {
  for (const [key, value] of savedProcesses) cp[key] = value;
  assert.equal(processAttempts, 0);
});
function setup(t, explicit = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-boot-cli-unit-'));
  const envBefore = { ...process.env };
  Object.assign(process.env, releaseEnvironment(path.join(dir, 'home'), path.join(dir, 'data')));
  fs.mkdirSync(process.env.RUYI_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.RUYI_HOME, 'config.json'), JSON.stringify({
    configSchema: 13, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
    desktopMcp: { enabled: false, autodetect: false },
    ...(explicit ? { claudePath: 'configured-claude' } : {}),
  }));
  process.env.CLAUDE_CLI_PATH = 'found-claude';
  const s = loadServerInternals([
    'AgentCliDiscovery', 'cliDiscoveryProbes', 'beginBootCliPathProbes',
    'finishBootCliPathProbes', 'readConfig', 'detectClaudePath', 'invalidateClaudePathCache',
  ]);
  const pending = [];
  s.cliDiscoveryProbes.spawnProbeAsync = command => new Promise(resolve => {
    pending.push({ command, resolve: () => resolve({ status: 0 }) });
  });
  s.cliDiscoveryProbes.spawnProbeSync = () => ({ status: 0 });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { s, pending, dir };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('duplicate startup calls share the CLI check; boot reads retain explicit paths and API reads wait for real results', async t => {
  const { s, pending } = setup(t);
  s.beginBootCliPathProbes(); s.beginBootCliPathProbes();
  await tick();
  assert.deepEqual(pending.map(p => p.command), ['found-claude']);
  const boot = await s.readConfig();
  assert.equal(boot.claudePath, 'configured-claude');
  s.finishBootCliPathProbes();
  let settled = false;
  const api = s.readConfig().then(c => { settled = true; return c; });
  await tick(); assert.equal(settled, false);
  pending[0].resolve();
  const config = await api;
  assert.equal(config.claudePath, 'configured-claude');
  assert.equal(s.detectClaudePath(), 'found-claude');
});

test('auto paths use completed findings after listen instead of persisting provisional missing paths', async t => {
  const { s, pending, dir } = setup(t, false);
  s.beginBootCliPathProbes();
  const boot = await s.readConfig();
  assert.equal(boot.claudePath, '');
  s.finishBootCliPathProbes();
  pending[0].resolve();
  const config = await s.readConfig();
  assert.equal(config.claudePath, 'found-claude');
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'data/config.json'), 'utf8'));
  assert.equal(Object.hasOwn(disk, 'claudePath'), false);
});

test('probe invalidation prevents outstanding startup discoveries from overwriting the new generation', async t => {
  const { s, pending } = setup(t);
  s.beginBootCliPathProbes(); await tick();
  s.invalidateClaudePathCache(); s.finishBootCliPathProbes();
  process.env.CLAUDE_CLI_PATH = 'current-claude';
  pending[0].resolve();
  await s.AgentCliDiscovery.waitForBootCliPathProbes();
  assert.equal(s.AgentCliDiscovery.waitForConfigCliProbes(), undefined);
  assert.equal(s.detectClaudePath(), 'current-claude');
});
