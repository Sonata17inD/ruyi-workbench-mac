'use strict';
// 常用文件夹去重不看结尾分隔符(代码走查 C14)。真源码 normalizeConfig,临时 HOME。
// 修前:服务端清洗只剥引号、去重只比小写 —— 同一个文件夹带不带结尾「\」存成两条,前端收藏里出现两行同名。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ws-sep-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const { loadServerInternals } = require('../lib/server-internals');
const { normalizeConfig } = loadServerInternals(['normalizeConfig']);

test('[W1] trailing separators deduplicate without conflating differently cased Mac paths', () => {
  const { config } = normalizeConfig({ workspaces: [
    { path: '/Users/me/Projects' }, { path: '/Users/me/Projects/' }, { path: '/Users/me/projects//' },
  ] });
  assert.deepEqual(config.workspaces.map(w => w.path), ['/Users/me/Projects', '/Users/me/projects']);
});

test('[W2] stored paths strip trailing separators and preserve the volume root', () => {
  assert.equal(normalizeConfig({ defaultWorkspace: '/Users/me/work/' }).config.defaultWorkspace, '/Users/me/work');
  const inputs = ['/', '/Users/me/', '/Volumes/Data/'];
  const expected = ['/', '/Users/me', '/Volumes/Data'];
  const { config } = normalizeConfig({ workspaces: inputs.map(path => ({ path })), recentWorkspaces: inputs });
  assert.deepEqual(config.workspaces.map(w => w.path), expected);
  assert.deepEqual(config.recentWorkspaces, expected);
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
