'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const vm = require('node:vm');
const fixture = require('../lib/platform-shell-fixture');

test('POSIX fixture commands write exact literal paths without expanding shell syntax',
  { skip: process.platform === 'win32' }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-shell-fixture-'));
    try {
      const file = path.join(root, '测试 space\'";$(touch INJECTED).txt');
      const value = 'line one\n$HOME; "quoted" \'literal\'';
      const result = cp.spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', fixture.writeFile(file, value)], {
        cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root }, encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(file, 'utf8'), value + '\n');
      assert.equal(fs.existsSync(path.join(root, 'INJECTED')), false);
      assert.equal(fixture.shellTool, 'shell_run');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
