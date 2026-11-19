'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function createWorkbenchDataRoots({ process }) {
  // 3.0 收口(原 v1.0-S9「建议 v2.0 收口」):数据目录缺省名改为 .ruyi-workbench。解析顺序:
  //   RUYI_HOME → WIN_CLAUDE_WORKBENCH_HOME(旧变量名,只读兼容,不再往子进程里写)→ ~/.ruyi-workbench;
  //   新目录还不存在、旧目录 ~/.win-claude-workbench 是真目录(迁移没成或还没轮到)时继续用旧目录 —— 数据不会因为改名「消失」。
  // 迁移(把旧目录搬成新名、原处留一个指回来的目录联接)只在直接运行 serve 时做一次,见 migrateLegacyDataRoot。
  const RUYI_DATA_DIR_NAME = '.ruyi-workbench';
  const LEGACY_DATA_DIR_NAME = '.win-claude-workbench';
  function defaultDataRoots() {
    const home = os.homedir();
    return { next: path.join(home, RUYI_DATA_DIR_NAME), legacy: path.join(home, LEGACY_DATA_DIR_NAME) };
  }
  function lstatOrNull(p) {
    try { return fs.lstatSync(p); } catch { return null; }
  }
  // dataRoot() / dataRootAliases() 在文件遍历的热路径上逐项被调(03 isSensitiveDataPath);每次都 lstat 两个目录在大树上是秒级开销。
  // 结果按「两个环境变量 + 家目录」记住:进程内能改变答案的只有这三样(迁移发生在启动时,迁移后清一次缓存)。
  let _dataRootMemo = null;
  function dataRootMemoKey() {
    return [process.env.RUYI_HOME || '', process.env.WIN_CLAUDE_WORKBENCH_HOME || '', os.homedir()].join('\0');
  }
  function resolveDataRootUncached() {
    if (process.env.RUYI_HOME) return path.resolve(process.env.RUYI_HOME);
    if (process.env.WIN_CLAUDE_WORKBENCH_HOME) return path.resolve(process.env.WIN_CLAUDE_WORKBENCH_HOME);
    const { next, legacy } = defaultDataRoots();
    if (lstatOrNull(next)) return next;
    const old = lstatOrNull(legacy);
    if (old && old.isDirectory() && !old.isSymbolicLink()) return legacy;
    // 旧位置是用户自己建的链接 / 联接(数据挪去了别的盘)、新目录还没有:照旧用它。修前这里会落到一个空的新目录,
    // 配置、会话、密钥看起来全没了。迁移不搬链接(见 migrateLegacyDataRoot)。
    if (old && old.isSymbolicLink()) { try { if (fs.statSync(legacy).isDirectory()) return legacy; } catch { /* 断链:当它不存在 */ } }
    return next;
  }
  function dataRoot() {
    const key = dataRootMemoKey();
    if (_dataRootMemo && _dataRootMemo.key === key && _dataRootMemo.root) return _dataRootMemo.root;
    const root = resolveDataRootUncached();
    _dataRootMemo = { key, root, aliases: null };
    return root;
  }
  // 数据根的别名:指向同一个目录的其它写法 —— 迁移后旧位置上留的目录联接,或者新位置是指向旧目录的链接。敏感子树判定
  // (03 isSensitiveDataPath 与文件遍历的跳过)是按词法前缀比的,只认数据根本身的话,经别名的写法就能读到 config.json /
  // runtime.json(token)/ 会话。**与环境变量无关**:Claude / Kimi 的 MCP 子进程总带 RUYI_HOME,修前在那里一律返回空,
  // 旧路径上的链接也要纳入保护。按 realpath 对照，数据根暂缺时留到下次计算。
  function dataRootAliases() {
    const root = dataRoot();
    if (_dataRootMemo && _dataRootMemo.root === root && Array.isArray(_dataRootMemo.aliases)) return _dataRootMemo.aliases;
    const norm = p => (String(p));
    let rootReal = '';
    try { rootReal = norm(fs.realpathSync(root)); } catch { return []; }
    const { next, legacy } = defaultDataRoots();
    const out = [];
    for (const candidate of [legacy, next]) {
      if (norm(path.resolve(candidate)) === norm(path.resolve(root))) continue;
      try { if (norm(fs.realpathSync(candidate)) === rootReal) out.push(candidate); } catch { /* 不存在 */ }
    }
    if (_dataRootMemo && _dataRootMemo.root === root) _dataRootMemo.aliases = out;
    return out;
  }
  function pidAlive(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0 || n === process.pid) return false;
    try { process.kill(n, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); }
  }
  // 一次性迁移:~/.win-claude-workbench → ~/.ruyi-workbench,原处留目录符号链接
  // 指回新目录 —— 用户全局 Claude 配置里登记的 MCP 路径、计划任务、快捷方式里写死的旧路径照样能用。
  // 只在:直接运行、缺省命令 serve、没有任何数据根环境变量、新目录不存在、旧目录是真目录、旧目录里没有别的活实例
  // (runtime.json 的 pid 还活着就不动)时做。搬不动(被占用、跨卷、权限)就原样继续用旧目录,下次启动再试。
  function migrateLegacyDataRoot() {
    if (process.env.RUYI_HOME || process.env.WIN_CLAUDE_WORKBENCH_HOME) return { moved: false, reason: 'env' };
    const { next, legacy } = defaultDataRoots();
    if (lstatOrNull(next)) return { moved: false, reason: 'next-exists' };
    const old = lstatOrNull(legacy);
    if (old && old.isSymbolicLink()) return { moved: false, reason: 'legacy-is-link' }; // 用户自己建的链接:不搬,dataRoot() 照旧用它
    if (!old || !old.isDirectory()) return { moved: false, reason: 'no-legacy' };
    try {
      const rt = JSON.parse(fs.readFileSync(path.join(legacy, 'runtime.json'), 'utf8'));
      if (rt && pidAlive(rt.pid)) return { moved: false, reason: 'legacy-in-use', pid: rt.pid };
    } catch { /* 没有 runtime.json 或读不了:没有活实例的证据,照常迁移 */ }
    try { fs.renameSync(legacy, next); } catch (e) { return { moved: false, reason: 'rename-failed', error: String(e && e.code || e) }; }
    _dataRootMemo = null; // 数据根从旧目录换成了新目录
    let junction = true;
    try { fs.symlinkSync(next, legacy, 'dir'); } catch { junction = false; }
    return { moved: true, from: legacy, to: next, junction };
  }
  return { defaultDataRoots, lstatOrNull, dataRoot, dataRootAliases, migrateLegacyDataRoot };
}

function createWorkbenchPaths(dataRoot) {
  const paths = {
    data: dataRoot(),
    config: path.join(dataRoot(), 'config.json'),
    sessions: path.join(dataRoot(), 'sessions'),
    uploads: path.join(dataRoot(), 'uploads'),
    logs: path.join(dataRoot(), 'logs'),
    generated: path.join(dataRoot(), 'generated'),
    checkpoints: path.join(dataRoot(), 'checkpoints'), // v0.8-S4a: file-checkpoint journal (per-session)
    playbooks: path.join(dataRoot(), 'playbooks'), // v0.9-S2: user-authored playbooks (built-ins ship in resources/)
    skills: path.join(dataRoot(), 'skills'), // v1 技能体系: 用户级技能 skills/<id>/SKILL.md(内置技能仍在 resources/,项目技能在 <cwd>/.ruyi/skills)
    webcache: path.join(dataRoot(), 'webcache'), // v0.9-S9: web_fetch main-text cache (<sha256(url)>.json), offline-reusable
    agentRuns: path.join(dataRoot(), 'agent-runs'), // persistent DAG workflow state, grouped by session
    agentWorkflows: path.join(dataRoot(), 'agent-workflows'), // personal reusable DAG templates
    agentWorktrees: path.join(dataRoot(), 'agent-worktrees'), // optional isolated write-agent worktrees (outside the repo)
    usage: path.join(dataRoot(), 'usage'),
    memory: path.join(dataRoot(), 'memory'), // v2 跨会话记忆(团队模式 v2 Phase3): global/ 与 project/<projectKey>/ // v1.4-OSS 用量看板: append-only monthly cost ledgers usage/YYYY-MM.jsonl
  };

  async function ensureDirs() {
    await Promise.all([
      fsp.mkdir(paths.data, { recursive: true }),
      fsp.mkdir(paths.sessions, { recursive: true }),
      fsp.mkdir(paths.uploads, { recursive: true }),
      fsp.mkdir(paths.logs, { recursive: true }),
      fsp.mkdir(paths.generated, { recursive: true }),
      fsp.mkdir(paths.checkpoints, { recursive: true }),
      fsp.mkdir(paths.playbooks, { recursive: true }), // v0.9-S2
      fsp.mkdir(paths.skills, { recursive: true }), // v1 技能体系: 用户级技能目录
      fsp.mkdir(paths.webcache, { recursive: true }), // v0.9-S9
      fsp.mkdir(paths.agentRuns, { recursive: true }),
      fsp.mkdir(paths.agentWorkflows, { recursive: true }),
      fsp.mkdir(paths.agentWorktrees, { recursive: true }),
      fsp.mkdir(paths.usage, { recursive: true }), // v1.4-OSS 用量看板: append-only monthly ledgers
      fsp.mkdir(paths.memory, { recursive: true }), // v2 跨会话记忆: 记忆库根(global/ 与 project/<projectKey>/ 按需建)
    ]);
  }
  return { paths, ensureDirs };
}

module.exports = { createWorkbenchDataRoots, createWorkbenchPaths };
