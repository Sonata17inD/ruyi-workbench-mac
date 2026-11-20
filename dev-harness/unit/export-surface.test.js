'use strict';
// 入口导出须在测试或工具源码中有使用线索。允许刻意公开的接口登记理由。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-export-surface-'));
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));

const EXPORT_CEILING = 520;

// 刻意的公共接口:名字 → 理由。目前为空 —— 现有每个导出都有测试或工具在用。
const PUBLIC_API = {};

const CORPUS_ROOTS = ['dev-harness', path.join('ruyi-workbench', 'tools')];
const CODE_EXT = /\.(?:js|mjs|cjs|py)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'visual-baselines', 'manual-ruyi-full']);
const SELF = path.resolve(__filename);

function corpusIdentifiers() {
  const seen = new Set();
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
      if (!CODE_EXT.test(e.name) || path.resolve(p) === SELF) continue;
      const source = fs.readFileSync(p, 'utf8');
      for (const line of source.split(/\r?\n/)) {
        if (/^\s*(?:\/\/|\/\*|\*|#)/.test(line)) continue;
        for (const token of line.split(/[^A-Za-z0-9_$]+/)) if (token) seen.add(token);
      }
    }
  };
  for (const r of CORPUS_ROOTS) walk(path.join(repo, r));
  return seen;
}

const exported = Object.keys(srv);

test('[X1] 每个导出都有 dev-harness/ 或 ruyi-workbench/tools/ 的引用(或登记为公共接口)', () => {
  const ids = corpusIdentifiers();
  const orphans = exported.filter(name => !ids.has(name) && !Object.prototype.hasOwnProperty.call(PUBLIC_API, name));
  assert.deepEqual(orphans, [],
    `这些导出没有任何测试/工具引用,请从 14-main.js 的 module.exports 删掉(符号本身留着),或登记进 PUBLIC_API 并写理由:${orphans.join(', ')}`);
});

test('[X2] 导出总数只减不增', () => {
  assert.ok(exported.length <= EXPORT_CEILING,
    `module.exports 有 ${exported.length} 个键,超过上限 ${EXPORT_CEILING}。新导出须有测试直调;清理后把上限改成实数。`);
});

test('[X3] PUBLIC_API 的豁免都还在导出里', () => {
  const stale = Object.keys(PUBLIC_API).filter(name => !exported.includes(name));
  assert.deepEqual(stale, [], `过期豁免:${stale.join(', ')}`);
  for (const [name, why] of Object.entries(PUBLIC_API)) assert.ok(typeof why === 'string' && why.trim(), `${name} 缺理由`);
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
