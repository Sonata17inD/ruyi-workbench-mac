'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decodeConsoleText } = require('./text-codecs.cjs');
const { readFileWindow } = require('./file-text-io.cjs').FileTextIo;
function createGitTools({ ProcessRuntime, killChildTree, privacy }) {
  const { PrivacyGateway, privacySourceActive, privacySourceLine, privacySourceLineOffsets } = privacy;
const GIT_DIFF_MAX_CHARS = 40000;
const GIT_DIFF_STAT_MAX_CHARS = 6000;
const GIT_DIFF_MAX_BUFFER = 8 * 1024 * 1024; // diff 只需要开头一段;超出就停,不再把几十 MB 读进内存(整体 maxBuffer 24MB 会让超大 diff 直接失败)
const GIT_UNTRACKED_LIST_MAX = 50;
const GIT_STATUS_MAX_LINES = 300;   // git_status 回给模型的 porcelain 行数上限(计数不受影响)
// 只保留开头、使序列化(JSON 转义后:换行/引号会变长)长度不超过 budget,尽量收在整行边界。返回 { text }。
// (不复用 04 DesktopShell 的同类函数:11 引用 04 会在依赖图里新增一条循环边。)
function gitHeadToJsonBudget(text, budget) {
  const s = String(text == null ? '' : text);
  const len = x => JSON.stringify(x).length;
  if (len(s) <= budget) return { text: s };
  let n = Math.min(s.length, budget);
  let cut = s.slice(0, n);
  for (let i = 0; i < 8 && len(cut) > budget; i += 1) {
    n = Math.max(1, Math.floor(n * (budget / len(cut)) * 0.95));
    cut = s.slice(0, n);
  }
  const nl = cut.lastIndexOf('\n');
  if (nl >= cut.length * 0.5) cut = cut.slice(0, nl + 1);
  else if (/[\ud800-\udbff]/.test(cut[cut.length - 1] || '')) cut = cut.slice(0, -1);
  return { text: cut };
}
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
// ProcessRuntime.capture 的 Promise 包装:无 shell。返回 { ok, code, stdout, stderr, error?(ENOENT等), timedOut?, timeoutMs? }。
// 永不 reject —— 传输层错误(git 缺失、cwd 不存在)落在 result.error / result.code<0 上,由调用方转人话。
// opts.encoding:'buffer' 时 stdout/stderr 是原字节(Buffer)—— 读文件内容(blob)必须走这条,按 utf8 解码会把
// GBK 等非 UTF-8 字节变成 U+FFFD(hunt2 #4)。
// 走查 W1·F6:超时由自己的计时器管,不用 execFile 的 timeout 选项 —— 后者只给 git 本身发 SIGTERM,
// pre-commit 钩子起的子进程(lint / 测试)成了孤儿,还攥着 stdout 管道,execFile 的回调要等它们退出才来;而且超时后的错误形状
// (code:null、killed:true)被 gitCommit 当成「钩子拒绝」。现在:到点 → timedOut:true,用 killChildTree 整棵树杀(128i:只认
// 自己的子孙);树杀不掉、管道仍不关(杀树命令失败 / 极端孤儿)时,5 秒后强行收尾,不让调用方永远挂着。
function runGit(args, cwd, timeoutMs, opts = {}) {
  return new Promise((resolve, reject) => {
    void (async () => {
    // 非数字(模型给 git_status 之类自造 timeoutMs:"30s")回落缺省:修前 NaN 一路传到 setTimeout,等于 1 ms 就把跑完的 git 杀掉、报「超过 0 秒」。
    const askedMs = Number(timeoutMs);
    const limitMs = Math.min(GIT_TIMEOUT_MAX_MS, Math.max(1000, Number.isFinite(askedMs) && askedMs > 0 ? askedMs : 15000));
    let child, timer = null, grace = null, timedOut = false, settled = false, cleanup = null;
    const settle = r => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(grace);
      if (child) cleanup = ProcessRuntime.result(child) || cleanup;
      if (!timedOut && child?.pid && cleanup?.incomplete) {
        r = { ...r, ok: false, code: -1, commandExitCode: r.code, error: Object.assign(new Error('Git process cleanup has not been confirmed'), { code: 'ERR_PROCESS_CLEANUP_INCOMPLETE' }) };
      }
      const cleanupFields = cleanup ? { cleanupScope: cleanup.scope, cleanupIncomplete: cleanup.incomplete === true,
        ...(cleanup.escapeCoverage ? { cleanupEscapeCoverage: cleanup.escapeCoverage, cleanupUnconfirmed: cleanup.unconfirmed } : {}) } : {};
      resolve(timedOut ? { ...r, ok: false, timedOut: true, timeoutMs: limitMs, ...cleanupFields } : { ...r, ...cleanupFields });
    };
    try {
      // 安全加固前缀(GIT_SAFE_FLAGS)必须在子命令之前;args 以 `-C <dir> <subcmd> …` 开头,故整体前置合法。
      const executionOptions = {
        signal: opts.signal, cwd: cwd || process.cwd(),
        maxBuffer: opts && opts.maxBuffer ? opts.maxBuffer : 24 * 1024 * 1024,
        encoding: opts && opts.encoding === 'buffer' ? 'buffer' : 'utf8',
      };
      const complete = (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : (error ? -1 : 0);
        settle({ ok: !error, code, stdout: stdout || '', stderr: stderr || '', error: error || null });
      };
      const capture = await ProcessRuntime.capture('git', [...GIT_SAFE_FLAGS, ...args], executionOptions, { ...ProcessRuntime.currentOwner(), kind: 'git', ...opts.owner });
      child = capture.child;
      void capture.output.then(result => complete(result.error, result.stdout, result.stderr));
    } catch (e) {
      settle({ ok: false, code: -1, stdout: '', stderr: '', error: e });
      return;
    }
    child.on('error', () => { /* handled via the callback's `error` arg */ });
    timer = setTimeout(() => {
      timedOut = true;
      try { cleanup = killChildTree(child); } catch { cleanup = { scope: 'unknown', incomplete: true }; }
      grace = setTimeout(() => {
        try { if (!ProcessRuntime.stopChild(child)) child.kill('SIGKILL'); } catch { /* 已经退出 */ }
        try { if (child.stdout) child.stdout.destroy(); if (child.stderr) child.stderr.destroy(); } catch { /* ignore */ }
        settle({ ok: false, code: -1, stdout: '', stderr: '', error: Object.assign(new Error('git 超时被终止'), { killed: true }) });
      }, 5000);
      if (grace.unref) grace.unref();
    }, limitMs);
  })().catch(reject);
    });
}
// git 单条命令的超时上限(模型经 timeoutMs 能放宽到的最大值):钩子再慢也不该让一个工具调用挂过十分钟。
const GIT_TIMEOUT_MAX_MS = 10 * 60 * 1000;
// git_commit 默认超时:提交会跑 pre-commit / commit-msg 钩子(lint、测试常要几十秒),30s 对真实仓库偏紧;给 90s,模型可经 timeoutMs 放宽。
const GIT_COMMIT_TIMEOUT_DEFAULT_MS = 90 * 1000;
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

function gitReadOnlyGuardError(guard, cwd) {
  if (guard && guard.refused) {
    return { ok: false, error: '这个仓库的 git 配置里有无法安全关闭的过滤器,已拒绝执行只读 git 命令', hint: '过滤器名含「=」。请在终端里检查 .git/config 的 [filter] 段后再试。', cwd };
  }
  return gitHumanError(guard && guard.res, cwd);
}
// Resolve the working directory a git tool runs in. 工具分发(12)总是传入执行闸/会话解析好的绝对 cwd;这里只兜住没有 cwd 的
// 直接调用方(缺省家目录)。NE-6:显式给了却不存在/不是目录 → 返回 null(调用方报「目录不存在」),不再悄悄换成家目录 ——
// 修前手滑的 cwd 会让 git_status 在 $HOME 上报「不是 Git 仓库」、git_commit 甚至提交到 $HOME 所在的别的仓库。
function resolveGitCwd(raw) {
  const candidate = String(raw || '').trim();
  if (!candidate) return os.homedir();
  let resolved;
  try { resolved = path.resolve(candidate); } catch { return null; }
  try { if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved; } catch { /* fall through */ }
  return null;
}
function gitCwdMissingError(raw) {
  return { ok: false, error: `目录不存在: ${String(raw || '').trim()}`, hint: '确认 cwd 是已存在的仓库目录,或省略 cwd 使用当前对话的工作目录。' };
}
// Map a failed git invocation to a 中文人话引导错误. Order matters: binary-missing first (nothing else is
// meaningful without git), then the common "not a repo" and "missing identity" cases, else the raw stderr.
function gitHumanError(res, cwd) {
  // ENOENT (or the wrapper's -1 with an ENOENT-shaped error) → git isn't installed / not on PATH.
  const err = res && res.error;
  if (err && (err.code === 'ENOENT' || /ENOENT/.test(String(err.message || '')))) {
    return { ok: false, error: '未检测到 Git', hint: '请安装适用于 Mac 的 Git 或配置已有 Git 路径后重试。', cwd };
  }
  // 走查 W1·F6:超时被杀(runGit 打 timedOut)—— 说「被终止」,不要落进下面的泛化报错,更不能被 gitCommit 归因成钩子拒绝。
  if (res && res.timedOut) {
    const sec = Math.round(Number(res.timeoutMs || 0) / 1000);
    return {
      ok: false, timedOut: true, timeoutMs: Number(res.timeoutMs) || undefined, cwd,
      ...(res.cleanupScope ? { cleanupScope: res.cleanupScope, cleanupIncomplete: res.cleanupIncomplete === true,
        cleanupEscapeCoverage: res.cleanupEscapeCoverage, cleanupUnconfirmed: res.cleanupUnconfirmed } : {}),
      error: `git 命令超过 ${sec} 秒仍未结束,${res.cleanupIncomplete ? '子进程清理尚未确认完成' : res.cleanupScope ? '已被终止(已核验范围)' : '已被终止(进程树已一并结束)'}`,
      hint: '这不是失败原因,只是没跑完:先用 git_status 确认当前状态(文件是否还在暂存区、提交有没有生成),再决定重试。'
        + '常见原因:pre-commit / commit-msg 钩子(lint、测试)耗时过长或在等交互输入,或仓库很大。需要更久可传 timeoutMs(毫秒,最多 600000)重试。',
      detail: String((res && res.stderr) || '').trim().slice(0, 2000) || undefined,
    };
  }
  if (res?.cleanupIncomplete || (err && err.code === 'ERR_PROCESS_CLEANUP_INCOMPLETE')) {
    return { ok: false, error: 'Git 子进程清理尚未确认完成', cwd, commandExitCode: res.commandExitCode,
      hint: 'Git 命令可能已产生文件或提交变化，请先确认当前仓库状态再重试。', cleanupScope: res.cleanupScope, cleanupIncomplete: true,
      cleanupEscapeCoverage: res.cleanupEscapeCoverage, cleanupUnconfirmed: res.cleanupUnconfirmed };
  }
  const stderr = String((res && res.stderr) || '').trim();
  const low = stderr.toLowerCase();
  // 仓库外的 `git diff` 会退化成 `git diff --no-index` 并打印 7KB 的用法说明(退出码 129);那等于「不是仓库」,别把整段用法塞进 detail。
  if (/not a git repository/.test(low) || /^usage: git diff --no-index/m.test(low)) {
    return { ok: false, error: '这个文件夹还不是 Git 仓库', hint: '可以让 AI 运行 `git init` 把它变成一个 Git 仓库,再重试。', cwd, detail: /^usage: git diff --no-index/m.test(low) ? stderr.split('\n')[0].slice(0, 200) : stderr.slice(0, 300) };   // --no-index 退化时 stderr 带 7KB 用法说明,只留第一行警告
  }
  // 给了不存在的 ref / 范围(`git log nosuch`、`git diff a..b`)。
  if (/unknown revision or path|bad revision|ambiguous argument|bad object|not a valid object name|invalid revision range/.test(low)) {
    return { ok: false, error: '指定的 ref(提交/分支/范围)不存在或写法不对', hint: '用 git_log 看有哪些提交(hash 列),分支名可用 `git branch` 确认;范围写成 A..B。', cwd, detail: stderr.slice(0, 500) };
  }
  // git_commit without a configured identity — DO NOT auto-inject a fake user; guide the human instead.
  if (/please tell me who you are|user\.name|user\.email|empty ident/.test(low)) {
    return {
      ok: false, error: '还没配置 Git 身份(user.name / user.email)',
      hint: '请在设置里配置 Git 身份,或让 AI 用命令配置(例如 `git config user.name "你的名字"` 与 `git config user.email "you@example.com"`)。',
      cwd, detail: stderr,
    };
  }
  return { ok: false, error: 'Git 命令执行失败', hint: '请查看下方 detail 的原始报错,调整后重试。', cwd, detail: String(stderr || (err && err.message) || '未知错误').slice(0, 2000) };
}
// ref(提交/分支/范围)是模型给的、不可信:不允许以 `-` 开头(否则会被 git 当成选项 —— `--output=x` 之类),只允许 git 引用常见字符
// [A-Za-z0-9._/~^@{}:-](含 `..` / `...` 范围、HEAD~1、v1.0、origin/main、HEAD@{1}、abc123:path),不含空白/控制字符/引号/反引号/`!`;
// 并且调用处一律把它放在子命令之后、`--` 之前,即便合法也只可能被读作修订而不是路径。返回 { ref } 或 { error }。
const GIT_REF_RE = /^[A-Za-z0-9._\/~^@{}:][A-Za-z0-9._\/~^@{}:-]*$/;
function validateGitRef(raw) {
  const ref = String(raw == null ? '' : raw).trim();
  if (!ref) return { ref: '' };
  if (ref.length > 200) return { error: 'ref 过长(≤200 字符)' };
  if (ref.startsWith('-')) return { error: 'ref 不能以 - 开头(会被 git 当成选项)' };
  if (!GIT_REF_RE.test(ref)) return { error: 'ref 含非法字符;只允许字母数字和 . _ / ~ ^ @ { } : -(范围写成 A..B)' };
  return { ref };
}
// git_log 的 author / since:作为 `--author=<值>` / `--since=<值>` 单个参数传入(前缀固定,值再怪也成不了另一个选项)。
function validateGitLogFilter(raw, what, maxLen) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return { value: '' };
  if (v.length > maxLen) return { error: `${what} 过长(≤${maxLen} 字符)` };
  if (/[\x00-\x1f\x7f]/.test(v)) return { error: `${what} 含控制字符` };
  return { value: v };
}
// 钩子是否存在:core.hooksPath(相对路径相对仓库顶层)优先,否则 `git rev-parse --git-path hooks`。只用于失败时的归因,不执行任何东西。
async function gitHookNames(cwd, names) {
  try {
    let dir = '';
    const hp = await runGit(['-C', cwd, 'config', '--get', 'core.hooksPath'], cwd, 5000);
    if (hp.ok && String(hp.stdout || '').trim()) {
      dir = String(hp.stdout).trim();
      if (!path.isAbsolute(dir)) {
        const top = await runGit(['-C', cwd, 'rev-parse', '--show-toplevel'], cwd, 5000);
        dir = path.resolve(top.ok ? String(top.stdout).trim() : cwd, dir);
      }
    } else {
      const gp = await runGit(['-C', cwd, 'rev-parse', '--git-path', 'hooks'], cwd, 5000);
      if (!gp.ok) return [];
      dir = path.resolve(cwd, String(gp.stdout || '').trim());
    }
    return names.filter(n => fs.existsSync(path.join(dir, n)));
  } catch { return []; }
}
// 提交失败时已暂存的文件:修前 add 成功、commit 失败(缺身份/钩子拒绝)后文件还留在暂存区,失败结果只字不提。
async function gitStagedSnapshot(cwd) {
  const res = await runGit(['-C', cwd, 'diff', '--cached', '--name-only', '-z', '--no-ext-diff'], cwd, 8000);
  if (!res.ok) return null;
  const names = String(res.stdout || '').split('\0').filter(Boolean);
  return { staged: names.slice(0, 50), stagedCount: names.length };
}
// Parse `git status --porcelain=v1 -b` into a human summary line. First line is the branch header
// (## branch...tracking [ahead N, behind M]); remaining lines are XY-coded change entries.
function summarizeGitStatus(stdout) {
  const lines = String(stdout || '').split('\n').filter(l => l.length > 0);
  let branch = '(未知分支)', ahead = 0, behind = 0, changes = 0, untracked = 0, unborn = false, detached = false, conflicts = 0;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      // "branch...upstream [ahead 1, behind 2]" or "No commits yet on main" or "HEAD (no branch)"
      // 分支名本身可以带点(release-1.0、feature/v1.2.3):先按字面 `...` 切掉上游,再取到第一个空格。
      // 修前的正则在第一个点处截断,release-1.0 报成 release-1。
      if (head.startsWith('No commits yet on ')) { branch = head.slice('No commits yet on '.length).trim(); unborn = true; }
      else if (head.startsWith('HEAD (no branch)')) { branch = 'HEAD'; detached = true; }
      else branch = head.split('...')[0].split(' ')[0] || head;
      const am = head.match(/ahead (\d+)/); if (am) ahead = Number(am[1]);
      const bm = head.match(/behind (\d+)/); if (bm) behind = Number(bm[1]);
      continue;
    }
    changes++;
    if (line.startsWith('??')) untracked++;
    else if (/^(DD|AU|UD|UA|DU|AA|UU) /.test(line)) conflicts++;
  }
  const parts = [unborn ? `分支 ${branch}(还没有任何提交)` : detached ? '游离 HEAD(不在任何分支上)' : `分支 ${branch}`];
  if (conflicts) parts.push(`${conflicts} 个冲突未解决`);
  if (ahead) parts.push(`领先 ${ahead}`);
  if (behind) parts.push(`落后 ${behind}`);
  parts.push(changes === 0 ? '工作区干净,无改动' : `${changes} 个改动` + (untracked ? `(含 ${untracked} 个未跟踪)` : ''));
  return { summary: parts.join(' · '), branch, ahead, behind, changes, untracked, ...(unborn ? { unborn } : {}), ...(detached ? { detached } : {}), ...(conflicts ? { conflicts } : {}) };
}
// git_status {cwd?}: porcelain v1 + branch header, plus a 人话 summary line. tier: read.
async function gitStatus(args = {}) {
  const cwd = resolveGitCwd(args.cwd);
  if (!cwd) return gitCwdMissingError(args.cwd);
  const guard = await gitReadOnlyGuard(cwd, args.timeoutMs || 15000);   // 审计 B:关掉仓库自带过滤器与子模块递归
  if (!guard.ok) return gitReadOnlyGuardError(guard, cwd);
  const res = await runGit([...guard.flags, '-C', cwd, 'status', '--porcelain=v1', '-b', '--ignore-submodules=dirty'], cwd, args.timeoutMs || 15000);
  if (!res.ok) return gitHumanError(res, cwd);
  const parsed = summarizeGitStatus(res.stdout);
  // 计数(summary / changes / untracked)按【完整】输出算、始终精确;回给模型的 porcelain 文本封顶 GIT_STATUS_MAX_LINES 行
  // (修前 8000 个改动文件回 151KB,自己就超过 60K 模型可见上限被拦腰截断)。
  const all = String(res.stdout || '').split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  const statusTruncated = all.length > GIT_STATUS_MAX_LINES + 1;   // +1:分支头行 `## …` 不算改动
  const statusText = statusTruncated ? all.slice(0, GIT_STATUS_MAX_LINES + 1).join('\n') + '\n' : res.stdout;
  // 未跟踪【目录】在 porcelain 里折叠成一条 `?? dir/`(内含多少文件要 -uall 才展开);untracked 计数因此是「条目数」不是「文件数」。
  const untrackedDirs = all.filter(l => l.startsWith('?? ') && l.endsWith('/')).length;
  const hints = [];
  if (statusTruncated) hints.push(`改动共 ${parsed.changes} 项,status 只列出前 ${GIT_STATUS_MAX_LINES} 项(summary / changes / untracked 仍是完整计数);用 git_diff 的 path 看具体文件,或先 git_commit 分批提交`);
  if (untrackedDirs) hints.push(`其中 ${untrackedDirs} 个未跟踪【目录】在 status 里折叠成一条(untracked 按条目计,不是文件数),目录里可能有很多文件;用 file_list 查看内容`);
  return { ok: true, cwd, summary: parsed.summary, branch: parsed.branch, ahead: parsed.ahead, behind: parsed.behind, changes: parsed.changes, untracked: parsed.untracked, status: statusText,
    ...(statusTruncated ? { statusTruncated: true, statusLinesShown: GIT_STATUS_MAX_LINES } : {}), ...(untrackedDirs ? { untrackedDirs } : {}), ...(hints.length ? { hint: hints.join(';') } : {}),
    ...(parsed.unborn ? { unborn: true } : {}), ...(parsed.detached ? { detached: true } : {}), ...(parsed.conflicts ? { conflicts: parsed.conflicts } : {}),
    ...(guard.names.length ? { filtersNeutralized: guard.names } : {}) };
}

// git_diff {cwd?, path?, staged?, contextLines?}: unified diff text. tier: read.
// SECURITY: any model-controllable path goes AFTER `--`; a lone `-`-leading path with no separator is refused.
async function gitDiff(args = {}) {
  const cwd = resolveGitCwd(args.cwd);
  if (!cwd) return gitCwdMissingError(args.cwd);
  const refV = validateGitRef(args.ref);
  if (refV.error) return { ok: false, error: refV.error, code: 'invalid_ref', cwd };
  const ref = refV.ref;
  // 安全加固(对抗复核 CRITICAL 的 diff 面):--no-ext-diff 忽略仓库配置的 diff.external 外部差异器,
  // --no-textconv 关掉 gitattributes 指定的 textconv 过滤器 —— 两者都会执行仓库自带的外部程序,是 read 档
  // git_diff 下的代码执行面。用 diff 子命令专用选项关闭(不能用 `-c diff.external=` 空值,那会让 git 尝试
  // spawn 空命令而报错)。正常 diff 输出不受影响(已实弹验证:+/- 行照常产出、恶意 diff.external 不触发)。
  const guard = await gitReadOnlyGuard(cwd, args.timeoutMs || 15000);   // 审计 B:clean/smudge/process 过滤器与子模块递归
  if (!guard.ok) return gitReadOnlyGuardError(guard, cwd);
  const baseArgs = [...guard.flags, '-C', cwd, 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', ...(privacySourceActive() ? ['--full-index'] : [])];
  const gitArgs = [...baseArgs];
  const staged = args.staged === true;
  if (staged) gitArgs.push('--cached');
  // contextLines → -U<n> (clamped 0..50). Passed as a single joined arg so it can't be split/走私.
  const ctx = Number(args.contextLines);
  if (Number.isFinite(ctx)) gitArgs.push('-U' + String(Math.max(0, Math.min(50, Math.floor(ctx)))));
  // path is UNTRUSTED. Place it strictly after `--` so a value like `--output=x` is treated as a pathspec,
  // never a git flag. (We still pass it verbatim — execFile means no shell, so no further quoting needed.)
  const rawPath = (args.path != null && String(args.path).trim() !== '') ? String(args.path) : null;
  // ref(修订/范围):校验过的、不以 `-` 开头的单个参数,放在 `--` 之前;有 ref 就一定补 `--`,即便没给 path ——
  // 这样 git 永远不会把它当成路径、路径也永远不会被当成修订。
  if (ref) gitArgs.push(ref);
  if (rawPath || ref) gitArgs.push('--');
  if (rawPath) gitArgs.push(rawPath);
  // diff 按原始字节取、再按行判 UTF-8/GBK(GBK 源文件的 diff 不再变成 U+FFFD);maxBuffer 8MB —— 撞上限不算失败,按「太大」处理。
  const res = await runGit(gitArgs, cwd, args.timeoutMs || 15000, { encoding: 'buffer', maxBuffer: GIT_DIFF_MAX_BUFFER });
  const asText = b => (Buffer.isBuffer(b) ? decodeConsoleText(b) : String(b || ''));
  const overflow = !res.ok && res.error && res.error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  if (!res.ok && !overflow) return gitHumanError({ ...res, stdout: asText(res.stdout), stderr: asText(res.stderr) }, cwd);
  let full = asText(res.stdout), privacyDiffView = null;
  if (privacySourceActive()) {
    if (overflow) throw Object.assign(new Error('Privacy diff snapshot exceeds the complete source budget.'), { code: 'privacy.source_limit' });
    if (full.includes('[[RUYI_PVT:')) throw Object.assign(new Error('Raw source contains a reserved privacy marker.'), { code: 'privacy.reserved_literal' });
    const rawArgs = [...guard.flags, '-C', cwd, 'diff', '--raw', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty'];
    if (staged) rawArgs.push('--cached');
    if (ref) rawArgs.push(ref);
    if (rawPath || ref) rawArgs.push('--');
    if (rawPath) rawArgs.push(rawPath);
    const inventory = await runGit(rawArgs, cwd, args.timeoutMs || 15000, { encoding: 'buffer', maxBuffer: GIT_DIFF_MAX_BUFFER });
    if (!inventory.ok) throw Object.assign(new Error('Privacy diff source inventory is unavailable.'), { code: 'privacy.source_snapshot_missing' });
    const records = [], parts = asText(inventory.stdout).split('\0'), diffBlocks = full.split(/^diff --git /m).slice(1);
    for (let i = 0; i < parts.length && parts[i];) {
      const match = /^:\d+ \d+ ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z][0-9]*)$/.exec(parts[i++]);
      if (!match || !parts[i]) throw Object.assign(new Error('Privacy diff source inventory cannot be verified.'), { code: 'privacy.source_snapshot_missing' });
      const from = parts[i++], to = /^[RC]/.test(match[3]) ? parts[i++] : from;
      // Mode/rename-only and binary diffs contain no source text. Do not pre-read their
      // potentially huge blobs merely to return the existing metadata-only result.
      if (diffBlocks[records.length] !== undefined && !/^@@ /m.test(diffBlocks[records.length])) {
        records.push({ metadataOnly: true, old: { hash: match[1], view: null }, next: { hash: match[2], view: null } }); continue;
      }
      const load = async (hash, name, current) => {
        if (/^0+$/.test(hash) && !current) return { raw: '', view: null, offsets: [0], hash };
        if (typeof args.privacyGuard === 'function') await args.privacyGuard(path.resolve(cwd, name));
        let raw, actualHash = hash;
        if (/^0+$/.test(hash)) {
          const target = path.resolve(cwd, name);
          const snapshot = await readFileWindow(target, 4 * 1048576);
          if (snapshot.error || snapshot.buf.length !== snapshot.fileBytes) throw Object.assign(new Error('Privacy diff working source is unavailable.'), { code: 'privacy.source_snapshot_missing' });
          actualHash = require('node:crypto').createHash(hash.length === 64 ? 'sha256' : 'sha1').update(Buffer.from('blob ' + snapshot.buf.length + '\0')).update(snapshot.buf).digest('hex');
          raw = decodeConsoleText(snapshot.buf);
        } else {
          const blob = await runGit([...guard.flags, '-C', cwd, 'cat-file', 'blob', hash], cwd, args.timeoutMs || 15000, { encoding: 'buffer', maxBuffer: 4 * 1048576 });
          if (!blob.ok) throw Object.assign(new Error('Privacy diff revision source is unavailable.'), { code: 'privacy.source_snapshot_missing' });
          raw = asText(blob.stdout);
        }
        return { raw, view: await PrivacyGateway.projectSource(raw), offsets: privacySourceLineOffsets(raw), hash: actualHash };
      };
      records.push({ old: await load(match[1], from, false), next: await load(match[2], to, !staged && !/^D/.test(match[3])) });
    }
    let record = null, index = -1, oldLine = 0, nextLine = 0, contextWork = 32 * 1048576;
    const sectionContext = (record, text) => {
      if (!text || !record || record.metadataOnly) return '';
      let found = false;
      for (const side of [record.old, record.next]) {
        if (!side.view) continue;
        let from = 0;
        while (from < side.raw.length) {
          contextWork -= side.raw.length - from;
          if (contextWork < 0) throw Object.assign(new Error('Privacy diff context exceeds its comparison budget.'), { code: 'privacy.source_limit' });
          const at = side.raw.indexOf(text, from); if (at < 0) break;
          found = true;
          const projected = PrivacyGateway.sliceSource(side.view, at, at + text.length).text;
          if (projected !== text) return projected;
          from = at + 1;
        }
      }
      return found ? text : '[source context unavailable]';
    };
    const projected = full.split('\n').map(line => {
      if (line.startsWith('diff --git ')) {
        record = records[++index]; oldLine = 0; nextLine = 0;
        if (!record) throw Object.assign(new Error('Privacy diff source inventory changed during collection.'), { code: 'privacy.source_changed' });
        return line;
      }
      const hashes = /^index ([0-9a-f]{40,64})\.\.([0-9a-f]{40,64})(?: |$)/.exec(line);
      if (hashes && (!record || !record.metadataOnly && (hashes[1] !== record.old.hash || hashes[2] !== record.next.hash))) throw Object.assign(new Error('Privacy diff source changed during collection.'), { code: 'privacy.source_changed' });
      const hunk = /^(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@)(?: (.*))?$/.exec(line);
      if (hunk) { oldLine = Number(hunk[2]); nextLine = Number(hunk[3]); const suffix = sectionContext(record, hunk[4] || ''); return hunk[1] + (suffix ? ' ' + suffix : ''); }
      if (!record || record.metadataOnly || !oldLine && !nextLine || !/^[ +\-]/.test(line)) return line;
      const side = line[0] === '+' ? record.next : record.old, no = line[0] === '+' ? nextLine : oldLine;
      const original = side.raw.slice(side.offsets[no - 1] ?? side.raw.length, side.offsets[no] === undefined ? side.raw.length : side.offsets[no] - 1).replace(/\r$/, '');
      if (original !== line.slice(1).replace(/\r$/, '')) throw Object.assign(new Error('Privacy diff source changed during collection.'), { code: 'privacy.source_changed' });
      const text = side.view ? privacySourceLine(side.view, side.raw, side.offsets, no, Infinity) : '';
      if (line[0] !== '+') oldLine += 1;
      if (line[0] !== '-') nextLine += 1;
      return line[0] + text;
    }).join('\n');
    if (index + 1 !== records.length) throw Object.assign(new Error('Privacy diff source inventory changed during collection.'), { code: 'privacy.source_changed' });
    // Re-project the host-built safe representation to obtain one proof for its final leaf.
    privacyDiffView = { records, text: projected }; full = projected;
  }
  let diff = full;
  let truncated = false;
  let stat = '', privacyStatView = null;
  if (overflow || JSON.stringify(full).length > GIT_DIFF_MAX_CHARS) {
    truncated = true;
    const cut = gitHeadToJsonBudget(full, GIT_DIFF_MAX_CHARS);
    if (privacyDiffView) {
      const at = cut.text.lastIndexOf('[[RUYI_PVT:');
      if (at >= 0 && cut.text.indexOf(']]', at) < 0) {
        const end = full.indexOf(']]', at); if (end >= 0) cut.text = full.slice(0, end + 2);
      }
    }
    const total = overflow ? `超过 ${Math.round(GIT_DIFF_MAX_BUFFER / 1024 / 1024)}MB` : `${full.length} 字符`;
    diff = cut.text + `\n\n[已截断:diff 共 ${total},只显示前 ${cut.text.length} 字符。文件清单见 stat;用 path 参数只看单个文件,或减小 contextLines。]`;
    const statArgs = [...baseArgs, ...(privacyDiffView ? ['--numstat', '-z'] : ['--stat=120,60', '--stat-count=60'])];
    if (staged) statArgs.push('--cached');
    if (ref) statArgs.push(ref);
    if (rawPath || ref) statArgs.push('--');
    if (rawPath) statArgs.push(rawPath);
    const st = await runGit(statArgs, cwd, args.timeoutMs || 15000, { encoding: 'buffer', maxBuffer: GIT_DIFF_MAX_BUFFER });
    if (st.cleanupIncomplete) return gitHumanError(st, cwd);
    if (st.ok || (st.error && st.error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) {
      if (privacyDiffView) {
        if (!st.ok) throw Object.assign(new Error('Privacy diff metadata exceeds the complete source budget.'), { code: 'privacy.source_limit' });
        const rawStat = asText(st.stdout); privacyStatView = await PrivacyGateway.projectSource(rawStat);
        stat = PrivacyGateway.sliceSource(privacyStatView, 0, Math.min(rawStat.length, GIT_DIFF_STAT_MAX_CHARS)).text.replace(/\0/g, '\n').trimEnd();
      } else stat = gitHeadToJsonBudget(asText(st.stdout), GIT_DIFF_STAT_MAX_CHARS).text.trimEnd();
    }
  }
  const out = { ok: true, cwd, staged, path: rawPath || undefined, ...(ref ? { ref } : {}), truncated };
  // NE-7:git diff 不含未跟踪文件 —— 只有新文件时不能对模型说「没有改动」。列出来(≤50)并提示用 file_read 看内容。
  // 给了 ref 就是在比修订,未跟踪文件与之无关,不列。
  let untracked = [];
  let untrackedCount = 0;
  if (!truncated && !staged && !ref) {
    const lsArgs = [...guard.flags, '-C', cwd, 'ls-files', '--others', '--exclude-standard', '-z'];
    if (rawPath) lsArgs.push('--', rawPath);
    const ls = await runGit(lsArgs, cwd, args.timeoutMs || 15000, { encoding: 'buffer' });
    if (ls.cleanupIncomplete) return gitHumanError(ls, cwd);
    if (ls.ok) {
      const names = asText(ls.stdout).split('\0').filter(Boolean);
      untrackedCount = names.length;
      untracked = names.slice(0, GIT_UNTRACKED_LIST_MAX);
    }
  }
  out.empty = diff.trim() === '' && untrackedCount === 0;
  if (untrackedCount) {
    out.untracked = untracked;
    out.untrackedCount = untrackedCount;
    out.hint = diff.trim() === ''
      ? `没有已跟踪文件的改动,但有 ${untrackedCount} 个未跟踪的新文件(git diff 不含它们);用 file_read 看内容,或 git_commit 时用 paths/addAll 纳入。`
      : `另有 ${untrackedCount} 个未跟踪的新文件不在上面的 diff 里(见 untracked);用 file_read 看内容。`;
  }
  // 未暂存那边是空的、改动却全在暂存区:修前只回 empty:true,模型以为没有改动。
  if (!staged && !ref && diff.trim() === '' && !untrackedCount) {
    const cached = await runGit([...guard.flags, '-C', cwd, 'diff', '--cached', '--quiet', '--ignore-submodules=dirty', ...(rawPath ? ['--', rawPath] : [])], cwd, args.timeoutMs || 15000);
    if (cached.cleanupIncomplete) return gitHumanError(cached, cwd);
    if (!cached.ok && cached.code === 1) {
      out.empty = false;
      out.hint = '未暂存的改动是空的,但暂存区里有改动;传 staged:true 查看。';
    }
  }
  if (rawPath && out.empty && !out.hint) {
    const missing = gitMissingPathHint(cwd, rawPath);
    if (missing) out.hint = missing;
  }
  if (stat) out.stat = stat;
  if (stat && privacyStatView) { out.statFormat = 'numstat'; PrivacyGateway.markSourceView(out, ['/stat'], privacyStatView); }
  out.diff = diff;
  if (privacyDiffView) {
    const views = privacyDiffView.records.flatMap(record => [record.old.view, record.next.view]).filter(Boolean);
    if (views.length) PrivacyGateway.markSourceView(out, ['/diff'], views);
  }
  if (guard.names.length) out.filtersNeutralized = guard.names;
  return out;
}
// path 指向工作区里根本不存在的东西时,「空结果」其实是拼写错误:修前 git_diff/git_log {path:'nonexistent'} 成功返回空、没有任何提示。
// 只对【不含通配/pathspec 魔法】且【落在 cwd 之内】的路径判断(区外路径不替它探测存在与否);已删除但有历史的文件 log 非空,不会走到这里。
function gitMissingPathHint(cwd, rawPath) {
  if (/[*?[\]:]/.test(rawPath)) return '';
  try {
    const full = path.resolve(cwd, rawPath);
    const rel = path.relative(cwd, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
    if (fs.existsSync(full)) return '';
  } catch { return ''; }
  return `路径 ${JSON.stringify(rawPath)} 在 ${cwd} 里不存在(相对 cwd 解析),所以结果为空;检查拼写与大小写,可用 glob / file_list 确认路径。`;
}

// git_log {cwd?, maxCount?, path?, ref?, author?, since?}: recent commits as a row table. tier: read.
// ref:修订或范围(A..B 形式的两个分支之间、HEAD~5、某个 hash 起往前的历史);author / since:按作者(子串)/ 时间过滤。
async function gitLog(args = {}) {
  const cwd = resolveGitCwd(args.cwd);
  if (!cwd) return gitCwdMissingError(args.cwd);
  const n = Math.max(1, Math.min(100, Math.floor(Number(args.maxCount) || 10)));
  const refV = validateGitRef(args.ref);
  if (refV.error) return { ok: false, error: refV.error, code: 'invalid_ref', cwd };
  const authorV = validateGitLogFilter(args.author, 'author', 200);
  if (authorV.error) return { ok: false, error: authorV.error, code: 'invalid_author', cwd };
  const sinceV = validateGitLogFilter(args.since, 'since', 64);
  if (sinceV.error) return { ok: false, error: sinceV.error, code: 'invalid_since', cwd };
  // 审计 B:log.showSignature=true 的仓库会让 git log 跑 gpg.program(仓库配置可指任意程序)—— 显式关掉。
  // 字段:短 hash / 完整 hash / 日期 / 作者 / 标题(\x1f 分隔)。
  const gitArgs = [...GIT_READ_ONLY_FLAGS, '-C', cwd, 'log', '--date=iso', '--pretty=format:%h%x1f%H%x1f%ad%x1f%an%x1f%s', '-n', String(n)];
  // author / since 以 `--author=<值>` / `--since=<值>` 的单参数形式传入(前缀固定,值不可能变成另一个选项);
  // --fixed-strings 让 author 按字面子串匹配(否则是正则,作者名里的 . + 会误伤)。
  if (authorV.value) gitArgs.push('--fixed-strings', '--regexp-ignore-case', '--author=' + authorV.value);
  if (sinceV.value) gitArgs.push('--since=' + sinceV.value);
  const rawPath = (args.path != null && String(args.path).trim() !== '') ? String(args.path) : null;
  // ref 在 `--` 之前(已校验、不以 `-` 开头);有 ref 或 path 就补 `--`,路径(不可信)永远在它之后。
  if (refV.ref) gitArgs.push(refV.ref);
  if (rawPath || refV.ref) gitArgs.push('--');
  if (rawPath) gitArgs.push(rawPath); // UNTRUSTED path after the `--` separator
  const res = await runGit(gitArgs, cwd, args.timeoutMs || 15000);
  if (!res.ok) {
    // 空仓库(还没有任何提交):不是故障,如实说「还没有提交」,不要报成通用的「Git 命令执行失败」。
    if (/does not have any commits yet|bad default revision 'HEAD'|unknown revision or path not in the working tree/i.test(String(res.stderr || '')) && !refV.ref) {
      return { ok: true, cwd, count: 0, maxCount: n, path: rawPath || undefined, commits: [], unborn: true, hint: '这个仓库还没有任何提交(git_commit 做第一次提交后这里才有历史)。' };
    }
    return gitHumanError(res, cwd);
  }
  const commits = String(res.stdout || '').split('\n').filter(l => l.length > 0).map(line => {
    // 字段间用 \x1f(单元分隔符):修前用 `|`,作者名里带竖线就把 subject 拆坏了。
    const [hash, fullHash, date, author, ...rest] = line.split('\x1f');
    return { hash: hash || '', fullHash: fullHash || '', date: date || '', author: author || '', subject: rest.join('\x1f') };
  });
  const out = { ok: true, cwd, count: commits.length, maxCount: n, path: rawPath || undefined, ...(refV.ref ? { ref: refV.ref } : {}), ...(authorV.value ? { author: authorV.value } : {}), ...(sinceV.value ? { since: sinceV.value } : {}), commits };
  if (!commits.length && rawPath) {
    const missing = gitMissingPathHint(cwd, rawPath);
    if (missing) out.hint = missing;
  }
  return out;
}

// git_commit {cwd?, message(必填), addAll?, paths?}: stage then commit. tier: exec (hooks run arbitrary code).
// SECURITY: message via `-m <message>` (two elements); paths after `--`; NEVER --no-verify; NEVER fake identity.
async function gitCommit(args = {}) {
  const cwd = resolveGitCwd(args.cwd);
  if (!cwd) return gitCwdMissingError(args.cwd);
  const message = String(args.message != null ? args.message : '').trim();
  if (!message) return { ok: false, error: 'message 不能为空', hint: '请给这次提交写一句说明(例如「修好登录按钮」)。', cwd };
  const paths = Array.isArray(args.paths) ? args.paths.filter(p => typeof p === 'string' && p.trim() !== '') : [];
  const addAll = args.addAll === true && paths.length === 0; // b2-P1: addAll 默认 false —— 一次 git add -A + commit 会全量暂存(密钥/大文件/临时产物),必须显式 opt-in
  // Stage. addAll → `git add -A`; else `git add -- <paths...>` (paths strictly after `--`).
  if (addAll) {
    const addRes = await runGit(['-C', cwd, 'add', '-A'], cwd, args.timeoutMs || 30000);
    if (!addRes.ok) return gitHumanError(addRes, cwd);
  } else if (paths.length) {
    const addRes = await runGit(['-C', cwd, 'add', '--', ...paths], cwd, args.timeoutMs || 30000);
    if (!addRes.ok) return gitHumanError(addRes, cwd);
  }
  // Commit. `-m <message>` as two separate array elements (no shell → no injection). No --no-verify: hooks
  // are honest behavior, gated by the exec-tier permission门.
  // 给了 paths 就【只】提交这些文件(--only):修前是 add 之后裸 commit,索引里早就暂存着的别的文件被一起提交了,
  // 与 schema「只暂存这些文件」不符。路径照旧严格放在 `--` 之后。
  const commitArgs = paths.length
    ? ['-C', cwd, 'commit', '--only', '-m', message, '--', ...paths]
    : ['-C', cwd, 'commit', '-m', message];
  const res = await runGit(commitArgs, cwd, args.timeoutMs || GIT_COMMIT_TIMEOUT_DEFAULT_MS);
  if (!res.ok) {
    if (res.cleanupIncomplete) return gitHumanError(res, cwd);
    // "nothing to commit" is a benign, common case — surface it as a clear 人话 result, not a scary error.
    const low = (String(res.stdout || '') + String(res.stderr || '')).toLowerCase();
    if (typeof res.error?.code === 'number' && res.error.code > 0 && /nothing to commit|no changes added|nothing added to commit/.test(low)) {
      return { ok: false, error: '没有可提交的改动', hint: '工作区没有变化,或改动还没被暂存。有改动时传 addAll:true(暂存全部)或 paths:[...](只暂存这些文件)再提交。', cwd, detail: (res.stdout || res.stderr || '').trim() };
    }
    // 暂存之后才失败(缺身份 / 钩子拒绝 / …):文件还留在暂存区,失败结果要说 —— 否则模型以为「什么都没发生」,下一次提交会把它们一起带走。
    const failure = gitHumanError(res, cwd);
    const merged = (String(res.stdout || '') + '\n' + String(res.stderr || '')).trim();
    if (res.timedOut) {
      // 超时:可能是钩子慢(提示一句),但不是「被钩子拒绝」—— 不打 hookRejected。
      const hooks = await gitHookNames(cwd, ['pre-commit', 'commit-msg']);
      if (hooks.length) failure.hint += ` 这个仓库有 ${hooks.join(' / ')} 钩子,多半是钩子耗时过长${res.cleanupScope ? '，请结合清理结果确认状态' : '(钩子进程已随超时一并结束)'}。`;
    } else if (failure.error === 'Git 命令执行失败' && typeof res.error?.code === 'number' && res.error.code > 0) {
      // 钩子拒绝:git 自己不打任何标签,只有钩子的输出;失败码非 0 且仓库里确有 pre-commit / commit-msg 钩子时归因于钩子。
      const hooks = await gitHookNames(cwd, ['pre-commit', 'commit-msg']);
      if (hooks.length && !/^fatal:/m.test(merged)) {
        failure.error = `提交被 ${hooks.join(' / ')} 钩子拒绝`;
        failure.hint = '钩子返回了非零退出码(下方 detail 是钩子的输出)。按提示修好问题后重新 git_commit;不要用 --no-verify 绕过钩子。';
        failure.hookRejected = true;
        failure.detail = merged.slice(0, 2000);
      }
    }
    const snap = await gitStagedSnapshot(cwd);
    if (snap && snap.stagedCount) {
      Object.assign(failure, snap);
      failure.hint = (failure.hint ? failure.hint + ' ' : '') + `注意:${snap.stagedCount} 个文件已在暂存区(见 staged),这次提交没成功,它们仍是已暂存状态;修好后再 git_commit,或让 AI 运行 \`git reset\` 取消暂存。`;
    }
    return failure;
  }
  // Resolve the new commit's short hash for the return payload.
  const head = await runGit(['-C', cwd, 'rev-parse', '--short', 'HEAD'], cwd, 5000);
  if (head.cleanupIncomplete) return gitHumanError(head, cwd);
  const hash = head.ok ? String(head.stdout || '').trim() : '';
  return { ok: true, cwd, hash, message, summary: `已提交 ${hash ? hash + ' ' : ''}「${message}」`, output: (res.stdout || '').trim() };
}


return { runGit, gitReadOnlyGuard, gitHumanError, gitStatus, gitDiff, gitLog, gitCommit };
}
module.exports = { createGitTools };
