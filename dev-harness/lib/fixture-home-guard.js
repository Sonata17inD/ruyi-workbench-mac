'use strict';
// Guard fixture spawns that explicitly select a Ruyi data root. Its HOME must also be isolated.
const cp = require('child_process');
const { REAL_HOME, REAL_HOME_SOURCE, normalizeHome, isFakeHome } = require('./fixture-home');

// 覆盖 spawn-family 全部入口(任务点名的四个 + exec/execSync/fork 三个同形状的)。
// 这些包装只在 env 真带 RUYI_HOME 时才会红,没带的调用完全不受影响。
const PATCHED_METHODS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];

// options 在参数表里的位置:spawn(cmd, [args], [options]) —— 从后往前找第一个「不是数组的对象」。
// 末位可能是回调函数(string/function 都会被排除),所以只认 object 且排除 Array/Buffer/URL。
function optionsIndexOf(argv) {
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i];
    if (a && typeof a === 'object' && !Array.isArray(a) && !Buffer.isBuffer(a) && !(a instanceof URL)) return i;
  }
  return -1;
}

// 返回问题列表(空数组 = 通过)。判据本身是纯函数,便于本件之外复用/复核。
function violationsOf(env) {
  if (!env || typeof env !== 'object') return [];
  if (!Object.prototype.hasOwnProperty.call(env, 'RUYI_HOME')) return [];
  const problems = [];
  if (!normalizeHome(env.HOME)) problems.push('HOME 没设(git/npm 一类会读它)');
  else if (!isFakeHome(env.HOME)) problems.push('HOME 就是真机家:' + env.HOME);
  if (normalizeHome(env.RUYI_HOME) && !isFakeHome(env.RUYI_HOME)) {
    problems.push('RUYI_HOME 自己就指向真机家:' + env.RUYI_HOME);
  }
  return problems;
}

function die(methodName, target, problems) {
  const bar = '='.repeat(78);
  process.stderr.write([
    '',
    bar,
    'FAIL 夹具 HOME 守卫红(fixture-home-guard):子进程带了 RUYI_HOME,家目录却没一起隔离',
    '  夹具: ' + (process.argv[1] || '(未知)'),
    '  调用: child_process.' + methodName + '(' + String(target) + ')',
    ...problems.map(p => '  问题: ' + p),
    '  真机家(来自 ' + REAL_HOME_SOURCE + '): ' + REAL_HOME,
    '  将 HOME 指向夹具的临时目录。',
    bar,
    '',
  ].join('\n'));
  process.exit(1);
}

function wrap(methodName) {
  const original = cp[methodName];
  if (typeof original !== 'function') return;
  cp[methodName] = function guardedFixtureSpawn(...argv) {
    const oi = optionsIndexOf(argv);
    if (oi > 0) {
      const opts = argv[oi];
      const problems = violationsOf(opts && opts.env);
      if (problems.length) die(methodName, argv[0], problems);
    }
    return original.apply(this, argv);
  };
}

for (const m of PATCHED_METHODS) wrap(m);
