'use strict';

// v1.0 收官安全加固(对抗复核 CONFIRMED·CRITICAL):git 会执行由被操作仓库自带 `.git/config` 指定的
// 外部程序 —— `core.fsmonitor`(status/diff 读 index 时执行)、`diff.external` / textconv(diff 时执行)。
// git_status/git_diff 是 read 档、所有权限模式恒放行零弹窗,若不覆盖这些键,「看一眼陌生仓库的 git 状态」
// 即等于在受害仓库自带的 hook 程序下无提示 RCE(两面均实弹已证:fsmonitor 用 sh hook + fsmonitorHookVersion=2
// 触发;diff.external 裸 git diff 即执行)。命令行 `-c core.fsmonitor=`(空=关闭)优先级最高,覆盖各级配置且
// 对功能零损失(fsmonitor 纯读性能优化)。**注意**:`-c diff.external=`(空)不能用——git 会把空值当成「要 spawn
// 的外部差异器」而报 `external diff died`,反而破坏正常 diff;diff.external / textconv 面改由 gitDiff 的
// `--no-ext-diff --no-textconv` 关闭(diff 子命令专用选项,见 gitDiff)。GIT_SAFE_FLAGS 对 ALL git 调用统一
// 前置(commit 亦安全:它不读 fsmonitor;合法 pre-commit hook 走 core.hooksPath,未被触碰,仍在 exec 档权限门下)。
// NE-7:core.quotepath=false —— 否则中文路径在 status/diff 里被写成 "\346\226\260..." 八进制转义,模型和用户都读不了。
const GIT_SAFE_FLAGS = ['-c', 'core.fsmonitor=', '-c', 'core.fsmonitorHookVersion=0', '-c', 'core.quotepath=false'];
// git 单条命令的超时上限(模型经 timeoutMs 能放宽到的最大值):钩子再慢也不该让一个工具调用挂过十分钟。
const GIT_TIMEOUT_MAX_MS = 10 * 60 * 1000;

// 安全修复(审计 B):read 档的 git 调用还会执行仓库自带配置指定的【过滤器】—— `.gitattributes` 里一行
// `* filter=x` 加 `.git/config` 里 `[filter "x"] clean = <命令>`,git status / git diff 在比对工作区文件时就会
// spawn 那条命令(stat 变了就重算哈希,先过 clean)。子模块同理:status/diff 会在子模块里再起一个 git,
// 子模块自己的 config 里的过滤器不归上面那几个 -c 管。修法:
//   ① 先读一遍配置里【所有】filter.<name>.(clean|smudge|process) 键(git config 只读配置、不执行任何东西),
//      对每个 name 追加 `-c filter.<name>.clean= -c …smudge= -c …process= -c …required=false`(空值 = 不跑;
//      实弹验证 status/diff 不再触发,输出照常);名字里带 `=`(`-c` 的键值分隔符,覆盖不到)一律拒绝执行(fail-closed);
//   ② `--ignore-submodules=dirty`:不进子模块跑 status(子模块提交指针变了仍会报,只是不看子模块工作区脏不脏);
//   ③ 另外关掉会 spawn 子进程的展示项:status.submoduleSummary(跑子模块 log)、log.showSignature(跑 gpg.program)。
// 代价:用 git-lfs 之类 clean 过滤器的仓库,stat 变过的受管文件会被报成「已修改」(按原始字节比);结果里
// filtersNeutralized 如实列出被关掉的过滤器名。git_commit(exec 档,要真的按过滤器入库)不走这条。
const GIT_READ_ONLY_FLAGS = ['-c', 'status.submoduleSummary=false', '-c', 'log.showSignature=false', '-c', 'diff.submodule=short'];

function createGitRuntime({ ProcessRuntime, killChildTree }) {
  async function runGit(args, cwd, timeoutMs, opts = {}) {
    const askedMs = Number(timeoutMs);
    const limitMs = Math.min(GIT_TIMEOUT_MAX_MS, Math.max(1000, Number.isFinite(askedMs) && askedMs > 0 ? askedMs : 15000));
    const executionOptions = {
      signal: opts.signal,
      cwd: cwd || process.cwd(),
      maxBuffer: opts.maxBuffer || 24 * 1024 * 1024,
      encoding: opts.encoding === 'buffer' ? 'buffer' : 'utf8',
    };
    let capture;
    try {
      capture = await ProcessRuntime.capture('git', [...GIT_SAFE_FLAGS, ...args], executionOptions, { ...ProcessRuntime.currentOwner(), kind: 'git', ...opts.owner });
    } catch (error) {
      return { ok: false, code: -1, stdout: '', stderr: '', error };
    }

    const { child, output } = capture;
    let timer;
    let cleanupTimer;
    let timedOut = false;
    let cleanup;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        try { cleanup = killChildTree(child); }
        catch { cleanup = { scope: 'unknown', incomplete: true }; }
        cleanupTimer = setTimeout(() => {
          try { ProcessRuntime.stopChild(child); } catch { /* preserve incomplete evidence */ }
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolve({ error: Object.assign(new Error('git 超时被终止'), { killed: true }), stdout: '', stderr: '' });
        }, 5000);
        cleanupTimer.unref();
      }, limitMs);
    });
    let result;
    try { result = await Promise.race([output, timeout]); }
    finally { clearTimeout(timer); clearTimeout(cleanupTimer); }

    cleanup = ProcessRuntime.result(child) || cleanup;
    let { error } = result;
    let code = typeof error?.code === 'number' ? error.code : error ? -1 : 0;
    const reply = { stdout: result.stdout || '', stderr: result.stderr || '' };
    if (!timedOut && child.pid && cleanup?.incomplete) {
      reply.commandExitCode = code;
      code = -1;
      error = Object.assign(new Error('Git process cleanup has not been confirmed'), { code: 'ERR_PROCESS_CLEANUP_INCOMPLETE' });
    }
    if (timedOut) Object.assign(reply, { timedOut: true, timeoutMs: limitMs });
    if (cleanup) {
      Object.assign(reply, { cleanupScope: cleanup.scope, cleanupIncomplete: cleanup.incomplete === true });
      if (cleanup.escapeCoverage) Object.assign(reply, { cleanupEscapeCoverage: cleanup.escapeCoverage, cleanupUnconfirmed: cleanup.unconfirmed });
    }
    return { ...reply, ok: !timedOut && !error, code, error: error || null };
  }

  async function gitReadOnlyGuard(cwd, timeoutMs) {
    const res = await runGit(['-C', cwd, 'config', '-z', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], cwd, timeoutMs || 15000);
    // exit 1 = 没有匹配的键(也包括「不是仓库」时只剩全局/系统配置且没有过滤器);其余非零 = 读配置本身就失败了。
    if (res.cleanupIncomplete || (!res.ok && res.code !== 1)) return { ok: false, res };
    const names = [];
    for (const entry of String(res.stdout || '').split('\0')) {
      const key = entry.split('\n')[0];
      const m = /^filter\.(.+)\.(?:clean|smudge|process)$/i.exec(key);
      if (m && !names.includes(m[1])) names.push(m[1]);
    }
    const bad = names.find(n => /[=\r\n]/.test(n));
    if (bad) return { ok: false, refused: true, name: bad };
    const flags = [...GIT_READ_ONLY_FLAGS];
    for (const n of names) flags.push('-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`);
    return { ok: true, flags, names };
  }

  return { runGit, gitReadOnlyGuard };
}

module.exports = { createGitRuntime, GIT_READ_ONLY_FLAGS };
