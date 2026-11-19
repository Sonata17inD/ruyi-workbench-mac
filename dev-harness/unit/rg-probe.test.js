'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRgProbe } = require('../../ruyi-workbench/app/backend/rg-probe.cjs');
function fixture(t, statuses) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-rg-probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidates = statuses.map((status, i) => ({ command: path.join(root, String(i)), source: i ? 'system' : 'env' }));
  candidates.forEach(c => fs.writeFileSync(c.command, 'fixture'));
  let ready = true;
  const calls = [];
  const runtime = { helperCapability: () => ({ ready, deadline: true }),
    probeSync: command => { const i = candidates.findIndex(c => c.command === command); calls.push(i); return statuses[i]; } };
  const service = createRgProbe({ ProcessRuntime: runtime, candidates: () => candidates });
  return { service, runtime, calls, candidates, setReady: value => { ready = value; } };
}
test('nonzero version exit is not installed; first existing PATH candidate shadows later ones', t => {
  const { service, calls } = fixture(t, [{ status: 1 }, { status: 1 }, { status: 0 }]);
  assert.equal(service.probeRgInfoSync(), null);
  assert.deepEqual(calls, [0, 1]);
});
test('missing supervisor leaves probe unknown and recovery uses same service', t => {
  const { service, calls, candidates, setReady } = fixture(t, [{ status: 0 }, { status: 0 }]);
  setReady(false);
  assert.equal(service.probeRgInfoSync(), null);
  assert.equal(service.peekRgProbe(), undefined);
  assert.deepEqual(calls, []);
  setReady(true);
  assert.deepEqual(service.probeRgInfoSync(), { path: candidates[0].command, source: 'env', shell: 'system' });
  service.probeRgInfoSync();
  assert.deepEqual(calls, [0, 1]);
});
test('cleanup uncertainty neither tries another candidate nor caches absence', t => {
  const { service, calls } = fixture(t, [{ cleanupIncomplete: true, status: 0 }, { status: 0 }]);
  assert.throws(() => service.probeRgInfoSync(), error => error.cleanupIncomplete);
  assert.deepEqual(calls, [0]);
  assert.equal(service.peekRgProbe(), undefined);
});
test('candidate paths are explicit and vendor path is not also classified as system', () => {
  const service = createRgProbe({ ProcessRuntime: {}, vendorBinDir: () => '/vendor',
    pathBeforeVendor: '/vendor:/opt/homebrew/bin:relative::"/usr/local/bin"', env: { RUYI_RG_PATH: '/custom rg' } });
  assert.deepEqual(service.rgProbeCandidates(), [
    { command: '/custom rg', source: 'env' }, { command: '/vendor/rg', source: 'bundled' },
    { command: '/opt/homebrew/bin/rg', source: 'system' }, { command: '/usr/local/bin/rg', source: 'system' },
  ]);
});
