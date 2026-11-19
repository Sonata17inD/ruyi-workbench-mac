'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createCliDiagnostics } = require('../../ruyi-workbench/app/backend/cli-diagnostics.cjs');
test('doctor severity and argument parsing retain their CLI contract', () => {
  const api = createCliDiagnostics({});
  assert.deepEqual(api.parseArgs(['doctor', '--human', '--port', '9000']), { _: ['doctor'], human: true, port: '9000' });
  assert.equal(api.doctorHealthSeverity({ id: 'process-supervisor', ok: false }), 'error');
  assert.equal(api.doctorHealthSeverity({ id: 'desktop-control', detail: 'preparing: probe' }), 'warn');
  assert.equal(api.doctorHealthSeverity({ id: 'search-ripgrep', detail: 'absent: missing' }), 'warn');
  const lines = api.doctorHumanLines([{ id: 'process-supervisor', ok: false, detail: 'missing' }], {});
  assert.ok(lines.some(line => line.includes('error')));
  assert.ok(lines.some(line => line.includes('process-supervisor · missing')));
});
test('actual doctor exits with JSON by default and localized human output on request', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-doctor-'));
  try {
    const env = { ...process.env, HOME: root, USERPROFILE: root, RUYI_HOME: path.join(root, 'data'), WIN_CLAUDE_WORKBENCH_HOME: path.join(root, 'data') };
    const entry = path.resolve(__dirname, '../../ruyi-workbench/app/server.js');
    const plain = cp.spawnSync(process.execPath, [entry, 'doctor'], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(plain.status, 0, plain.stderr);
    const info = JSON.parse(plain.stdout);
    assert.equal(info.platform, process.platform);
    assert.equal(info.dataRoot, env.RUYI_HOME);
    const human = cp.spawnSync(process.execPath, [entry, 'doctor', '--human'], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(human.status, 0, human.stderr);
    assert.ok(human.stdout.startsWith(plain.stdout.trimEnd()));
    assert.ok(human.stdout.length > plain.stdout.length);
    assert.match(human.stdout, /process-supervisor/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
