'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { releaseEnvironment } = require('../lib/release-checks');

test('release child paths cannot inherit another installation, CLI home or injected test server', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-release-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inherited = { ...process.env, RUYI_HOME: 'external-data', WCW_DATA_DIR: 'external-acc',
    CLAUDE_CONFIG_DIR: 'external-claude', RUYI_TOOLBOX_HOME: 'external-toolbox', WCW_CLAUDE_PROJECTS_DIR: 'external-projects',
    HOMEDRIVE: 'Z:', HOMEPATH: '\\external-home', NODE_OPTIONS: '--require=external.js', RUYI_TEST_SERVER_JS: 'external-server.js' };
  const env = releaseEnvironment(path.join(root, 'home'), path.join(root, 'data'), inherited);
  const result = cp.execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { env, encoding: 'utf8' });
  const actual = JSON.parse(result);
  for (const key of ['RUYI_HOME', 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'RUYI_TOOLBOX_HOME', 'WCW_CLAUDE_PROJECTS_DIR', 'WCW_DATA_DIR', 'ACC_INSTALL_DIR', 'TMPDIR']) {
    assert.ok(path.resolve(actual[key]).startsWith(root + path.sep), key);
  }
  for (const key of ['NODE_OPTIONS', 'RUYI_TEST_SERVER_JS', 'PYTHONHOME', 'PYTHONPATH']) assert.equal(actual[key], undefined, key);
  assert.equal(inherited.RUYI_HOME, 'external-data', 'parent environment is unchanged');
});
