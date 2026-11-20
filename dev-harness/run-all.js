#!/usr/bin/env node
// Mac E2E runner. Failed fixtures get one retry and retain their first failure diagnostics.
// 用法:
//   node dev-harness/run-all.js                  # 全量串行
//   node dev-harness/run-all.js --parallel 4     # unit 与 E2E 都限制为 4 路并行
//   node dev-harness/run-all.js --fast           # 仅快通道(.static 纯静态锁,秒级)
//   node dev-harness/run-all.js foo.e2e.js       # 仅指定件(可多个,空格分隔)
//
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pruneStaleFixtureDirs } = require('./lib/temp-janitor'); // 129i:夹具残留的扫地工(判据与纪律都在那个文件里)

const HARNESS = __dirname;
// Opt-in release evidence: preserve each attempt, including successful SKIP/INFO lines.
// Reserve a fresh directory so one run cannot overwrite another run's evidence.
const EVIDENCE_DIR = process.env.RUYI_E2E_EVIDENCE_DIR ? path.resolve(process.env.RUYI_E2E_EVIDENCE_DIR) : '';
if (EVIDENCE_DIR) fs.mkdirSync(EVIDENCE_DIR);
function recordAttempt(file, attempt, result) {
  if (!EVIDENCE_DIR) return;
  const name = path.basename(file) + '.attempt-' + attempt;
  fs.writeFileSync(path.join(EVIDENCE_DIR, name + '.txt'), result.out || '', { flag: 'wx' });
  fs.writeFileSync(path.join(EVIDENCE_DIR, name + '.json'), JSON.stringify({ file, attempt,
    ok: result.ok, status: result.status, timedOut: result.timedOut, ms: result.ms }, null, 2) + '\n', { flag: 'wx' });
}
const LIVE_GROUPS = new Set();
function killFixtureGroup(pid) {
  if (!LIVE_GROUPS.has(pid)) return;
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    if (error.code === 'EPERM') {
      const table = cp.spawnSync('/bin/ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' });
      if (table.status === 0 && !table.stdout.trim().split('\n').some(row => {
        const [group, state] = row.trim().split(/\s+/);
        return Number(group) === pid && !state.startsWith('Z');
      })) return;
    }
    return error;
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    for (const pid of LIVE_GROUPS) killFixtureGroup(pid);
    process.exit(130);
  });
}
const TIMEOUT_MS = 120000; // 单件超时;最硬的 autonomy-durability 实测 ~15s,留 8x 余量
// Run timing, focus and physical desktop fixtures without competing lanes.
const PARALLEL_EXCLUSIVE = new Set([
  'macos-desktop-host.e2e.js', 'macos-desktop-bridge.e2e.js',
  'macos-desktop-media.e2e.js', 'macos-desktop-lifecycle.e2e.js',
  'macos-capture.e2e.js', 'macos-capture-host.e2e.js', 'macos-capture-contract.e2e.js',
  'macos-input-events.e2e.js', 'macos-input-host.e2e.js', 'macos-input-apps.e2e.js',
  'macos-window-clipboard.e2e.js', 'macos-ax.e2e.js', 'macos-ocr.e2e.js',
  'macos-observe.e2e.js', 'macos-record.e2e.js', 'macos-manual-record.e2e.js',
  'steward-conversation.e2e.js',
  'event-stream-client.browser.e2e.js',
  'one-workbench-frame.browser.e2e.js',
  'workbench-thread-head.browser.e2e.js',
  'live-full-text.browser.e2e.js',
  'quiet-card.browser.e2e.js',
  'focus-rail.browser.e2e.js',
  'rail-pocket.browser.e2e.js',
  'walkthrough-round1.browser.e2e.js',
  'classic-window-live-steer.e2e.js',
  'shell-mode-late-config.browser.e2e.js',
  'quiet-card-typing.browser.e2e.js',
  'event-stream-replay.browser.e2e.js',
  'walkthrough-round2.browser.e2e.js',
  'a11y-walkthrough.browser.e2e.js',
  'quiet-card-snooze.browser.e2e.js',
  'scheduler-ui.browser.e2e.js',
  'composer-voice.browser.e2e.js',
  'agent-node-limits.e2e.js',
  'mission-index-scale.e2e.js',
  'ec-d-performance.e2e.js',
  'dom-screenshot.e2e.js',
  'dom-smoke.e2e.js',
  'perf.e2e.js',
  'boot-listen-budget.e2e.js',
  'event-stream.e2e.js',
  'steward-board.e2e.js',
  'scheduler-ready-queue.e2e.js',
  'autonomy-durability.e2e.js',
  'keyboard-walkthrough.browser.e2e.js',
  'steward-shell-pixels.browser.e2e.js',
]);

const TIMEOUT_OVERRIDES = {
  'macos-ocr.e2e.js': 300000,
  'macos-observe.e2e.js': 300000,
  'scheduler-ready-queue.e2e.js': 180000,
  'steward-board.e2e.js': 300000,
  'tools-v2.e2e.js': 300000,
  'classic-window-live-steer.e2e.js': 300000,
  'event-stream-client.browser.e2e.js': 420000,
  'one-workbench-frame.browser.e2e.js': 360000,
  'workbench-thread-head.browser.e2e.js': 300000,
  'rail-pocket.browser.e2e.js': 300000,
  'walkthrough-round1.browser.e2e.js': 300000,
  'frontend-wave3.browser.e2e.js': 300000,
};
function timeoutFor(file) { return TIMEOUT_OVERRIDES[file] || TIMEOUT_MS; }

// Live qualifications require credentials, a physical device or explicit opt-in.
const SKIP = new Set([
  'deepseek-live.e2e.js',
  'deepseek-tools.e2e.js',
  'desktop-bridge-live.e2e.js',
  // 第42b波: 真身 claude 二进制冒烟(真实 API 调用,需本机已登录 CLI;手工 node 直跑)
  'claude-binary-live.e2e.js',
  // 第45波45e: 压缩质量评测(真实 provider API,读真实 config 拿凭据;手工 node 直跑)
  'compact-quality-live.e2e.js',
  // 22号线#1 Prompt Cache 纪律验证(真实 DeepSeek API,argv 传 key,固定多轮冷/热对照;手工直跑)
  'prompt-cache-discipline-live.e2e.js',
  // P5 receipts: require explicit current Mac helper/Python/SDK and opt-in env.
  // These are independent live qualifications; an absent opt-in must not count as a pass.
  'macos-native-receipts.e2e.js',
  'macos-execution-context.e2e.js',
  'macos-execution-dispatch.e2e.js',
  'macos-execution-images.e2e.js',
  'macos-execution-subagents.e2e.js',
  'macos-execution-capture.e2e.js',
  'macos-execution-input.e2e.js',
]);

const isFast = f => /\.static\.e2e\.js$/.test(f);

// ─── 第36波(v1.7): 端口唯一性审计 ─────────────────────────────────────────────────────────────
// 串行时代跨文件撞端口无痛,但它是未来并行化的前置条件;且让"端口登记表"从人肉维护升级为机制断言
// (第34波亲验:README 登记 26 个、实际用 116 个,纯靠约定防撞)。占用即声明、撞车即红,新文件无需
// 任何登记动作。实现住 dev-harness/lib/port-audit.js(第46波46a 抽出真身,unit 测试同源 require,
// 杜绝"测复制副本"的 E2 漂移坑)。判定口径详见该模块头注。
const { portAuditFromDir } = require('./lib/port-audit');
// 107-F9b:每件开浏览器的测试一个自己的临时根,收尸只收这个根(头注在 lib/browser-profile-scope.js)。
const { SCOPE_ENV: BROWSER_SCOPE_ENV, SCOPE_FILE: BROWSER_SCOPE_FILE, createScope: createBrowserScope, reapScope: reapBrowserScope } = require('./lib/browser-profile-scope');
// 27 号文 §11.21.7 债④:夹具 HOME 守卫。夹具拿到的家目录是【临时家】,真机家另走 RUYI_REAL_HOME;
// 守卫以 --require 装进【每件夹具】,拦住「带了 RUYI_HOME 却没隔离家目录」的子进程(见 lib/fixture-home.js)。
const { GUARD_FILE: FIXTURE_GUARD, fixtureChildEnv, REAL_HOME, REAL_HOME_SOURCE } = require('./lib/fixture-home');
function portAudit() { return portAuditFromDir(HARNESS); }

function listE2e() {
  return fs.readdirSync(HARNESS)
    .filter(f => f.endsWith('.e2e.js') && !SKIP.has(f))
    .sort();
}

function runOne(file) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const full = path.join(HARNESS, file);
    // 128d:用公共夹具 lib/browser-fixture 的件,`--user-data-dir=` 写在 lib 里、不在件的源码里 —— 按 require 认。
    const fileSrc = fs.readFileSync(full, 'utf8');
    const ownsBrowserProfile = fileSrc.includes('--user-data-dir=') || /require\(['"]\.\/lib\/browser-fixture['"]\)/.test(fileSrc);
    const { env: childEnv, home: childHome } = fixtureChildEnv({ perTest: true });
    const browserScope = ownsBrowserProfile ? createBrowserScope() : '';
    if (browserScope) childEnv[BROWSER_SCOPE_ENV] = browserScope;
    const scopeArgs = browserScope ? ['--require', BROWSER_SCOPE_FILE] : [];
    const child = cp.spawn(process.execPath, ['--require', FIXTURE_GUARD, ...scopeArgs, full], {
      cwd: HARNESS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
      detached: true,
    });
    if (child.pid) LIVE_GROUPS.add(child.pid);
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killFixtureGroup(child.pid);
    }, timeoutFor(file));
    child.on('close', code => {
      clearTimeout(timer);
      const cleanupError = killFixtureGroup(child.pid);
      LIVE_GROUPS.delete(child.pid);
      if (browserScope) reapBrowserScope(browserScope);
      const ok = code === 0 && !timedOut && !cleanupError;
      let out = stdout + stderr;
      if (cleanupError) out += `\nFAIL fixture process group cleanup: ${cleanupError.message}`;
      if (ok) {
        try { fs.rmSync(childHome, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 回收不了不影响结果 */ }
      } else {
        out += `\n[fixture home 保留取证] ${childHome}`;
        if (browserScope && fs.existsSync(browserScope)) out += `\n[browser scope 保留取证] ${browserScope}`;
      }
      resolve({ file, ok, timedOut, status: code, out, ms: Date.now() - t0 });
    });
    child.on('error', e => {
      clearTimeout(timer);
      if (browserScope) reapBrowserScope(browserScope);
      resolve({ file, ok: false, timedOut: false, status: -1, out: stdout + stderr + '\n[spawn error] ' + e + `\n[fixture home 保留取证] ${childHome}`, ms: Date.now() - t0 });
    });
  });
}

async function runWithRetry(file) {
  const first = await runOne(file);
  recordAttempt(file, 1, first);
  if (first.ok) return { r: first, flaky: false };
  const second = await runOne(file);
  recordAttempt(file, 2, second);
  if (second.ok) {
    const firstFail = failLines(first.out);
    return {
      r: {
        ...second, ms: first.ms + second.ms,
        firstFail,
        firstTimedOut: first.timedOut, firstStatus: first.status,
        firstTail: firstFail.length ? [] : tailLines(first.out, 12).split(String.fromCharCode(10)).filter(Boolean),
      },
      flaky: true,
    };
  }
  return { r: { ...second, out: `[retry] 首跑 tail:\n${tailLines(first.out, 8)}\n[retry] 重跑 tail:\n${second.out}`, ms: first.ms + second.ms }, flaky: false };
}
function tailLines(s, n) {
  return String(s || '').split(/\r?\n/).filter(Boolean).slice(-n).join('\n');
}
// 一次运行的输出里所有 FAIL 行(封顶 12 条;再多也是同一个根因的连坐)。失败件与 flaky 件共用它。
// 128f:同时收首跑里的 `<名>-DIAG` 诊断行(H8／E1 那种「红时就地留证据」的件)。flaky 的首跑现场在重跑通过之后
// 就被清掉了(夹具目录跟着删),只剩这几行能说明它抖在哪 —— 修前 H8 第四次红时探针打出的证据就这么丢了。
// 每行截 2000 字,FAIL 与 DIAG 合计至多 20 行。
function failLines(s) {
  return String(s || '').split(/\r?\n/)
    .filter(line => /^\s*FAIL\b/.test(line) || /^\s*[A-Z0-9]+-DIAG\b/.test(line))
    .map(line => (line.length > 2000 ? line.slice(0, 2000) + '…' : line))
    .slice(0, 20);
}

async function main() {
  {
    const stats = pruneStaleFixtureDirs({ root: os.tmpdir() });
    if (stats.deleted || stats.failed) {
      console.log(`# 夹具残留清理: 扫 ${stats.scanned} 个,清掉 ${stats.deleted} 个陈年的,`
        + `留下 ${stats.keptFresh} 个新的与 ${stats.keptExcluded} 个非夹具,删不掉 ${stats.failed} 个`);
    }
  }
  const argv = process.argv.slice(2);
  // --parallel N: 并行路数(默认1=串行)
  const parallelIdx = argv.indexOf('--parallel');
  const PARALLEL = parallelIdx >= 0 ? Math.max(1, parseInt(argv[parallelIdx + 1], 10) || 4) : 1;
  const argvClean = parallelIdx >= 0 ? argv.filter((_, i) => i !== parallelIdx && i !== parallelIdx + 1) : argv;

  const targeted = argvClean.length > 0 && !argvClean[0].startsWith('-');
  let files;
  if (argvClean.includes('--fast')) {
    files = listE2e().filter(isFast);
  } else if (targeted) {
    files = argvClean.filter(f => f.endsWith('.e2e.js'));
  } else {
    files = listE2e();
    // 快通道先跑(秒级反馈),再跑主序(起 server 的件)
    files = [...files.filter(isFast), ...files.filter(f => !isFast(f))];
  }

  console.log(`# Ruyi e2e runner`);
  console.log(`# 件数: ${files.length} ran / ${SKIP.size} skipped(live)`);
  console.log(`# 超时: ${TIMEOUT_MS / 1000}s/件,${PARALLEL > 1 ? `并行(${PARALLEL}路)` : '串行'}`);
  console.log(`# Node ${process.version}, platform ${process.platform}`);
  // 27 号文 §11.21.7 债④:夹具一律拿临时家,真机家只以 RUYI_REAL_HOME 的形式传下去(守卫的判据源)。
  // 122 波 §2.7:不再是整轮共用一份 —— 每一件各自 mkdtemp 一份独立临时家,跑完(仅 ok 件)即删,
  // 失败件保留目录并在该件输出里打印路径,避免先跑的件污染后跑的件(websearch 8 路红的真根)。
  console.log(`# 夹具家目录隔离: 每件独立临时家(mkdtemp per test),ok 件跑完即删 / 失败件保留取证`);
  console.log(`# 夹具 HOME 守卫: --require ${path.relative(path.join(HARNESS, '..'), FIXTURE_GUARD)} 装进每件夹具(真机家来自 ${REAL_HOME_SOURCE}: ${REAL_HOME})`);
  // 第36波: 端口唯一性审计(见 stripJsComments 上方说明)。撞车即拒跑 —— 带病跑完全量也是浪费。
  const audit = portAudit();
  if (audit.collisions.length) {
    console.error(`#\n# 端口唯一性审计失败(${audit.collisions.length} 处跨文件撞车),请先改端口再跑:`);
    for (const c of audit.collisions) console.error('#   ' + c);
    process.exit(2);
  }
  console.log(`# 端口审计: ${audit.count} 个带内端口,跨文件零撞车\n`);
  const buildJs = path.join(HARNESS, '..', 'ruyi-workbench', 'app', 'build.js');
  const build = cp.spawnSync(process.execPath, [buildJs], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(build.stderr || build.stdout || String(build.error));
  console.log('# ' + build.stdout.trim());

  if (!targeted) {
    const unitGlob = path.join(HARNESS, 'unit', '*.test.js');
    const unitArgs = ['--test', ...(parallelIdx >= 0 ? ['--test-concurrency=' + PARALLEL] : []), unitGlob];
    const logPath = path.join(HARNESS, 'last-unit-run.log');
    const log = fs.openSync(logPath, 'w');
    let unit;
    try {
      unit = cp.spawnSync(process.execPath, unitArgs, { stdio: ['ignore', log, log] });
    } finally {
      fs.closeSync(log);
    }
    const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
    if (unit.status !== 0) throw new Error(unit.error?.message || lines.slice(-40).join('\n'));
    console.log('# unit 测试: ' + lines.filter(l => /^(?:#|ℹ) (pass|fail|tests|skipped)\b/.test(l)).join(' / '));
  }

  const results = [];
  async function runFixture(file, lane) {
    let row;
    try {
      const { r, flaky } = await runWithRetry(file);
      row = { ...r, flaky };
    } catch (error) {
      row = { file, ok: false, status: -1, out: String(error.stack || error), ms: 0 };
    }
    const status = row.ok ? (row.flaky ? 'FLAKY_PASS' : 'PASS')
      : row.timedOut ? 'TIMEOUT' : 'FAIL exit=' + row.status;
    console.log(`${lane} ${file} ${status} (${row.ms}ms)`);
    if (row.ok) delete row.out;
    results.push(row);
  }

  if (PARALLEL === 1) {
    for (const file of files) await runFixture(file, isFast(file) ? '[fast]' : '[main]');
  } else {
    const buckets = Array.from({ length: PARALLEL }, () => []);
    const exclusive = [];
    let nextLane = 0;
    for (const file of files) {
      if (PARALLEL_EXCLUSIVE.has(file)) exclusive.push(file);
      else buckets[nextLane++ % PARALLEL].push(file);
    }
    await Promise.all(buckets.map(async (bucket, index) => {
      for (const file of bucket) await runFixture(file, '[B' + index + ']');
    }));
    for (const file of exclusive) await runFixture(file, '[exclusive]');
  }

  const failed = results.filter(row => !row.ok);
  const flakyFiles = results.filter(row => row.flaky).map(row => row.file);
  const fail = failed.length;
  const summary = `${results.length - fail} pass / ${fail} fail / ${flakyFiles.length} flaky / ${results.length} ran / ${SKIP.size} skipped`;
  console.log('# 汇总: ' + summary);
  if (flakyFiles.length) {
    console.log(`# [flaky] 名单(首跑失败重跑通过,时序可疑,建议后续波治理):`);
    for (const f of flakyFiles) {
      console.log('#   ' + f);
      // 125:把首跑那次的 FAIL 行一并打出来。只报件名等于只说「它抖」,而治它要的是「抖在哪一条」。
      const row = results.find(x => x && x.file === f) || null;
      const lines = (row && Array.isArray(row.firstFail)) ? row.firstFail : [];
      if (lines.length) for (const line of lines) console.log('#     [首跑] ' + line.trim());
      else {
        // 没有 FAIL 行 = 它不是断言红,是【死了】。把怎么死的与临死前说的话打出来 ——
        // 修前这里只有一句「多半是超时」的猜测,而猜测查不下去。
        const how = row && row.firstTimedOut ? 'TIMEOUT(撞了本件的超时墙)' : ('exit=' + (row ? row.firstStatus : '?'));
        console.log('#     [首跑] 没有断言红 —— 它是怎么死的: ' + how);
        for (const line of ((row && row.firstTail) || [])) console.log('#     [首跑·末尾] ' + line.trim().slice(0, 300));
      }
    }
  }
  if (failed.length) {
    console.log(`\n# 失败件:先列该件【所有 FAIL 行】,再给末 25 行现场`);
    for (const r of failed) {
      console.log(`\n=== ${r.file} (${r.timedOut ? 'TIMEOUT' : 'exit=' + r.status}) ===`);
      const lines = String(r.out || '').split(/\r?\n/).filter(Boolean);
      // 125 顺带还的债(40 号文 §8.4 ⓪ 的第一步「先把失败行落盘」):此前这里只给末 25 行,而断言
      // 往往红在中间 —— 三件常客 flaky 每次上榜都只留下一串 PASS 加一行「FAIL (1)」,到底哪一条红的
      // 查不到,于是「先定机制」这一步永远迈不出去。FAIL 行封顶 40 条(再多也是同一个根因的连坐)。
      const failLines = lines.filter(line => /^\s*FAIL\b/.test(line));
      if (failLines.length) {
        console.log(`--- FAIL 行 ${failLines.length} 条${failLines.length > 40 ? '(只列前 40)' : ''} ---`);
        console.log(failLines.slice(0, 40).join('\n'));
        console.log(`--- 末 25 行 ---`);
      }
      console.log(lines.slice(-25).join('\n'));
    }
  }
  // 紧凑日志(供 CI artifact 上传;失败 tail 见 step 输出)
  try {
    fs.writeFileSync(path.join(HARNESS, 'last-run.log'), [
      `# Ruyi e2e last-run log`,
      '# ' + summary,
      `# Node ${process.version}, platform ${process.platform}, parallel=${PARALLEL}`,
      ...results.map(r => `${r.ok ? (r.flaky ? 'FLAKY_PASS' : 'PASS') : 'FAIL'}\t${r.ms}ms\t${r.file}`),
    ].join('\n') + '\n');
  } catch { /* 只读环境(CI 沙箱)忽略 */ }

  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
