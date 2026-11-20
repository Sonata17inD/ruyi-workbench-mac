'use strict';
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCOPE_ENV = 'RUYI_E2E_TEST_TMPDIR';
const SCOPE_PREFIX = 'ruyi-e2e-tmp-';
const SCOPE_FILE = __filename;
const PATCHED_METHODS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];

function isInsideScope(dir, scope) {
  if (!dir || !scope) return false;
  const relative = path.relative(scope, dir);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// 从一次 spawn-family 调用的实参里挑出所有 `--user-data-dir=` 的值（数组实参逐项认；字符串命令按引号/空白切）。
function profileDirsOf(argv) {
  const dirs = [];
  const fromString = s => {
    const re = /--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/g;
    let m;
    while ((m = re.exec(s))) dirs.push(m[1] || m[2] || m[3]);
  };
  for (const a of argv) {
    if (typeof a === 'string') fromString(a);
    else if (Array.isArray(a)) {
      for (const item of a) {
        if (typeof item !== 'string') continue;
        const m = /^--user-data-dir=(.*)$/.exec(item);
        if (m) dirs.push(m[1].replace(/^"(.*)"$/, '$1'));
      }
    }
  }
  return dirs;
}

// run-all 侧：给一件测试建它自己的根（与夹具临时家平级，不放进家里 —— 放进去会让夹具的工作目录变成
// 「在家目录下面」，那是另一个产品分支）。
function createScope(base) {
  return fs.mkdtempSync(path.join(base || os.tmpdir(), SCOPE_PREFIX));
}

function reapScope(scope) {
  try { fs.rmdirSync(scope); } catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
  }
}

// 用固定语言和动画设置运行 UI 夹具。显式传入的浏览器参数优先。
const BROWSER_DEFAULT_FLAGS = Object.freeze([
  { prefix: '--lang=', flag: '--lang=zh-CN' },
  { prefix: '--accept-lang=', flag: '--accept-lang=zh-CN' },
  { prefix: '--force-prefers-', flag: '--force-prefers-no-reduced-motion' },
]);
// 纯函数：只认 spawn-family 的「命令 + 实参数组」形态且数组里带 --user-data-dir= 的调用(即拉起测试浏览器)。
function withBrowserDefaults(argv) {
  const args = Array.isArray(argv[1]) ? argv[1] : null;
  if (!args || !args.some(a => typeof a === 'string' && a.startsWith('--user-data-dir='))) return argv;
  const missing = BROWSER_DEFAULT_FLAGS
    .filter(({ prefix }) => !args.some(a => typeof a === 'string' && a.startsWith(prefix)))
    .map(({ flag }) => flag);
  if (!missing.length) return argv;
  // 一律补在末尾：Chromium 不论位置都认 `--` 开头的开关(测试里拉浏览器从不带单独的 `--`)；补在前面的话，
  // 被拉起的若不是浏览器(单测探针就是 `node -e … -- --user-data-dir=…`)会把它们当成自己的选项拒掉。
  const next = argv.slice();
  next[1] = [...args, ...missing];
  return next;
}

// 夹具侧：装上范围。只在 run-all 注入了 SCOPE_ENV 的夹具进程里跑（见文件末尾）。
function install(scope) {
  os.tmpdir = () => scope;
  for (const methodName of PATCHED_METHODS) {
    const original = cp[methodName];
    if (typeof original !== 'function') continue;
    cp[methodName] = function scopedBrowserSpawn(...argv) {
      const outside = profileDirsOf(argv).filter(dir => !isInsideScope(dir, scope));
      if (outside.length) {
        const bar = '='.repeat(78);
        const lines = [
          '', bar,
          'FAIL 测试浏览器 profile 越界(browser-profile-scope):--user-data-dir 不在本件的临时根下',
          '  夹具: ' + (process.argv[1] || '(未知)'),
          '  调用: child_process.' + methodName + '(' + String(argv[0]) + ')',
          ...outside.map(dir => '  profile: ' + dir),
          '  本件的根: ' + scope,
          '  修法: profile 用 fs.mkdtempSync(path.join(os.tmpdir(), \'ruyi-…\')) 建(os.tmpdir() 已指到本件的根)。',
          bar, '',
        ];
        process.stderr.write(lines.join('\n'));
        throw new Error('browser profile outside the per-test scope: ' + outside.join(', '));
      }
      return original.apply(this, withBrowserDefaults(argv));
    };
  }
}

module.exports = { SCOPE_ENV, SCOPE_PREFIX, SCOPE_FILE, isInsideScope, profileDirsOf, createScope, reapScope, install, withBrowserDefaults };

// 以 `--require` 装进夹具时：带着 run-all 注入的根才生效；直跑（没有这个变量）什么都不做。
// run-all 自己 require 本文件只为拿常量与 createScope/reapScope —— 它自己的环境里没有这个变量，不会装。
if (process.env[SCOPE_ENV]) install(process.env[SCOPE_ENV]);
