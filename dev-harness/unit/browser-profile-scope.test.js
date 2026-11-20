const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');

const repo = path.resolve(__dirname, '../..');
const scopeLib = require(path.join(repo, 'dev-harness', 'lib', 'browser-profile-scope.js'));
const { SCOPE_ENV, SCOPE_FILE, createScope, reapScope } = scopeLib;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-browser-scope-unit-'));

// 在一个真子进程里跑一段探针：可选装上范围（--require 那个文件 + 注入环境变量），探针把读数打成一行 JSON。
function probe(script, { scope, extraEnv } = {}) {
  const env = { ...process.env, ...(extraEnv || {}) };
  delete env[SCOPE_ENV];
  if (scope) env[SCOPE_ENV] = scope;
  const args = scope ? ['--require', SCOPE_FILE, '-e', script] : ['-e', script];
  const r = cp.spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000, env });
  const line = String(r.stdout || '').split(/\r?\n/).find(l => l.startsWith('PROBE '));
  return { status: r.status, out: line ? JSON.parse(line.slice(6)) : null, stderr: String(r.stderr || ''), stdout: String(r.stdout || '') };
}

// 探针：试着 spawnSync 一个「带 --user-data-dir 的子进程」（它只会写一个标记文件，不是浏览器）。
// 被拦下 → blocked:true 且标记文件不存在；放行 → 标记文件存在。
const SPAWN_WITH_PROFILE = `
  const cp = require('child_process'), fs = require('fs');
  const mark = process.env.PROBE_MARK, dir = process.env.PROBE_PROFILE;
  let blocked = false, message = '';
  try {
    const r = cp.spawnSync(process.execPath, ['-e', "require('fs').writeFileSync(process.env.PROBE_MARK, 'x')", '--', '--user-data-dir=' + dir], { timeout: 20000 });
    if (r.error) message = String(r.error);
  } catch (e) { blocked = true; message = e.message; }
  process.stdout.write('PROBE ' + JSON.stringify({ blocked, message, spawned: fs.existsSync(mark) }) + '\\n');
`;

describe('测试浏览器 profile 范围（107-F9b）', () => {
  it('A 承重：夹具里 mkdtemp(os.tmpdir()) 建的 profile 落在本件的根里，收尸的针扎得到、别的车道的针扎不到', () => {
    const scope = createScope(work);
    const otherLane = createScope(work);
    const p = probe(`
      const fs = require('fs'), os = require('os'), path = require('path');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-settings-'));
      const profile = path.join(root, 'profile');
      process.stdout.write('PROBE ' + JSON.stringify({ tmpdir: os.tmpdir(), profile }) + '\\n');
    `, { scope });
    assert.ok(p.out, `探针要交回读数（status=${p.status} stderr=${p.stderr.slice(-300)}）`);
    assert.equal(p.out.tmpdir, scope,
      `装上范围之后夹具的 os.tmpdir() 必须是本件的根（实得 ${p.out.tmpdir} —— 夹具建的 profile 落在全机共用的临时目录里，按根收尸收不到它）`);
    // 收尸器（lib/browser-cleanup.js）带范围时的判据就是「命令行含这根针」：原样比对子串。
    const commandLineFragment = '--user-data-dir=' + p.out.profile;
    assert.ok(commandLineFragment.includes(scope + path.sep), '本件收尸的针（根＋分隔符）扎得到本件的浏览器');
    assert.ok(!commandLineFragment.includes(otherLane + path.sep), '别的车道收尸的针扎不到本件的浏览器（F8 的原形就是一条车道收尾杀了别的车道）');
  });

  it('B 根外的 --user-data-dir 当场拦下，子进程根本没起', () => {
    const scope = createScope(work);
    const outside = path.join(work, 'ruyi-not-in-scope-' + Date.now(), 'profile');
    const mark = path.join(work, 'mark-B-' + Date.now());
    const p = probe(SPAWN_WITH_PROFILE, { scope, extraEnv: { PROBE_MARK: mark, PROBE_PROFILE: outside } });
    assert.ok(p.out, `探针要交回读数（status=${p.status} stderr=${p.stderr.slice(-300)}）`);
    assert.equal(p.out.blocked, true, `根外的 profile 必须被拦下（实得放行 —— 这个浏览器按根收尸收不到，漏出来的 Edge 再没人收）`);
    assert.equal(p.out.spawned, false, '被拦下的那一发子进程不许起');
    assert.ok(/FAIL 测试浏览器 profile 越界/.test(p.stderr), 'stderr 打出 FAIL 横幅（run-all 的失败行摘录抓得到它）');
  });

  it('C 根内的照常放行', () => {
    const scope = createScope(work);
    const inside = path.join(scope, 'ruyi-x-abc', 'profile');
    const mark = path.join(work, 'mark-C-' + Date.now());
    const p = probe(SPAWN_WITH_PROFILE, { scope, extraEnv: { PROBE_MARK: mark, PROBE_PROFILE: inside } });
    assert.ok(p.out, `探针要交回读数（status=${p.status} stderr=${p.stderr.slice(-300)}）`);
    assert.equal(p.out.blocked, false, `根内的 profile 不许误拦（${p.out.message}）`);
    assert.equal(p.out.spawned, true, '根内那一发子进程照常起了');
  });

  it('D 直跑（没有 run-all 注入的变量）什么都不做', () => {
    const outside = path.join(work, 'ruyi-direct-run', 'profile');
    const mark = path.join(work, 'mark-D-' + Date.now());
    const t = probe(`process.stdout.write('PROBE ' + JSON.stringify({ tmpdir: require('os').tmpdir() }) + '\\n');`);
    assert.equal(t.out && t.out.tmpdir, os.tmpdir(), '直跑时 os.tmpdir() 原样不动');
    // 直跑时即使 --require 了这个文件（变量没设）也不装：用 --require 但不给变量。
    const env = { ...process.env, PROBE_MARK: mark, PROBE_PROFILE: outside };
    delete env[SCOPE_ENV];
    const r = cp.spawnSync(process.execPath, ['--require', SCOPE_FILE, '-e', SPAWN_WITH_PROFILE], { encoding: 'utf8', timeout: 30000, env });
    const line = String(r.stdout || '').split(/\r?\n/).find(l => l.startsWith('PROBE '));
    const out = line ? JSON.parse(line.slice(6)) : null;
    assert.ok(out && out.blocked === false && out.spawned === true, `没有注入变量时不查 profile（实得 ${JSON.stringify(out)}）`);
  });

  it('removes an empty scope and preserves fixture output', () => {
    const empty = createScope(work);
    reapScope(empty);
    assert.ok(!fs.existsSync(empty));
    const kept = createScope(work);
    const shot = path.join(kept, 'frame.png');
    fs.writeFileSync(shot, 'fixture');
    reapScope(kept);
    assert.ok(fs.existsSync(shot));
  });

  it('I 测试浏览器默认 zh-CN、不减少动态效果；件自己给了就不动；不是拉浏览器不动', () => {
    const { withBrowserDefaults } = scopeLib;
    const base = ['--headless=new', '--user-data-dir=/tmp/scope/p', 'http://127.0.0.1:1/'];
    const a = withBrowserDefaults(['Chromium', base, { stdio: 'ignore' }]);
    assert.deepEqual(a[1].slice(0, 3), base, '原有实参顺序不变');
    assert.deepEqual(a[1].slice(3), ['--lang=zh-CN', '--accept-lang=zh-CN', '--force-prefers-no-reduced-motion'], '缺的三项补在末尾');
    const dd = withBrowserDefaults(['node', ['-e', 'x', '--', '--user-data-dir=/tmp/scope/p']]);
    assert.deepEqual(dd[1].slice(0, 4), ['-e', 'x', '--', '--user-data-dir=/tmp/scope/p'], '一律补在末尾(不是浏览器的程序也不会把它们当成自己的选项)');
    assert.deepEqual(a[2], { stdio: 'ignore' }, 'options 原样');
    const own = ['--lang=en-US', '--force-prefers-reduced-motion', ...base];
    assert.deepEqual(withBrowserDefaults(['Chromium', own])[1], [...own, '--accept-lang=zh-CN'], '件自己给了 --lang / --force-prefers-* 就只补缺的那项');
    const plain = ['node', ['-e', '1']];
    assert.equal(withBrowserDefaults(plain), plain, '没有 --user-data-dir 一律不动');
    const shell = ['"Chromium" --user-data-dir=x'];
    assert.equal(withBrowserDefaults(shell), shell, '字符串命令形态不改');
  });

  it('H 装上范围的夹具里：浏览器与普通子进程均继承隔离家目录', () => {
    const scope = createScope(work);
    const inside = path.join(scope, 'ruyi-x-h', 'profile');
    const script = `
      const cp = require('child_process');
      const show = "process.stdout.write(process.env.HOME)";
      const viaBrowser = cp.spawnSync(process.execPath, ['-e', show, '--', '--user-data-dir=' + process.env.PROBE_PROFILE], { encoding: 'utf8' }).stdout;
      const viaPlain = cp.spawnSync(process.execPath, ['-e', show], { encoding: 'utf8' }).stdout;
      process.stdout.write('PROBE ' + JSON.stringify({ viaBrowser, viaPlain }) + '\\n');
    `;
    const home = path.join(work, 'fixture-home');
    const p = probe(script, { scope, extraEnv: { PROBE_PROFILE: inside, HOME: home, RUYI_REAL_HOME: work } });
    assert.ok(p.out, p.stderr);
    assert.equal(p.out.viaBrowser, home);
    assert.equal(p.out.viaPlain, home);
  });
});

process.on('exit', () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ } });
