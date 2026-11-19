'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Read the runtime composition and verify its bytes against the ordered source manifest.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const APP = path.join(REPO, 'ruyi-workbench', 'app');
const SINGLE_FILE = path.join(APP, 'server.js');
const COMPOSITION_FILE = path.join(APP, 'workbench-runtime.cjs');
const MANIFEST = path.join(APP, 'src', 'manifest.json');

let cache = null; // 单测进程内只读一次(源码在测试运行期不变)

function resolveRuntimeComposition(entryFile) {
  const entry = path.resolve(entryFile);
  if (path.basename(entry) === 'server.js'
    && fs.readFileSync(entry, 'utf8').includes("require('./workbench-runtime.cjs')")) {
    return path.join(path.dirname(entry), 'workbench-runtime.cjs');
  }
  return entry;
}

function readServerSource() {
  if (cache) return cache;
  if (fs.existsSync(MANIFEST)) {
    const mods = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).modules;
    // manifest.modules 条目兼容两种形状:'NN-name.js' 或 {file, startLine, endLine, note}(43 波带行区间元数据)
    cache = mods.map(m => fs.readFileSync(path.join(APP, 'src', typeof m === 'string' ? m : m.file), 'utf8')).join('\n');
    // 43e 对抗轮:直接单件跑测试(不走 run-all 的 freshness 门)时,「锁读新 src、server 跑旧产物」
    // 的错配无任何提示。拼接后与产物做一次全量比对 —— 不一致即 fail 并指路,1.3MB×2 读取 ~ms 级。
    const artifact = fs.readFileSync(COMPOSITION_FILE, 'utf8');
    if (artifact !== cache) {
      throw new Error('src-reader freshness: app/src/ 与 workbench-runtime.cjs 不一致。先运行 node ruyi-workbench/app/build.js');
    }
  } else {
    cache = fs.readFileSync(SINGLE_FILE, 'utf8');
  }
  return cache;
}

module.exports = { readServerSource, resolveRuntimeComposition, SINGLE_FILE, COMPOSITION_FILE, MANIFEST };
