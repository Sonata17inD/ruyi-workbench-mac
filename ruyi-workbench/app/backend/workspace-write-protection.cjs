'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathWithinRoot, sameFileIdentity } = require('./path-containment.cjs');

function createWorkspaceWriteProtection({
  agentCliHomes, externalRoot, mcpDropInDirs, toolboxComponentsDir, isSensitiveDataPath, sensitiveDataRoots,
}) {
  // 安全审计 #1/#8(数据根里会被【自动加载 / 执行 / 信任】的状态):dataRoot 是文件工具的写根,isSensitiveDataPath
  // 只挡了「读出来会泄密」的那一批。下面这批读是无害的(或本来就要能读:检查点内容、个人工作流模板),但【写】进去
  // 就等于在下一回合 / 下一次启动时让工作台替模型执行它:
  //   mcp/*/ruyi-mcp.json      —— scanMcpDropIns 不经审批就合并进 MCP 清单,每回合按里面的 command 起进程;
  //   agent-workflows/         —— 个人 DAG 模板(角色、工具、权限档位),一键运行;
  //   checkpoints/             —— 回滚按 index.json 里的 path 把 .gz 内容写回任意位置(#8);
  //   scheduler/               —— 定时任务(payload + autonomy)到点无人值守开回合;
  //   steward/ missions/       —— 管家收件箱/记忆/决策与事项容器,管家据此自动派活;
  //   migrations/              —— 迁移日志,撤销时按日志改写 ~/.claude.json / Kimi / Codex 配置;
  //   overlay-tool/            —— Manage-Overlay.ps1 等覆盖更新脚本,工作台直接执行;
  //   以及数据根顶层的几份状态文件(安装登记表记着别的包的启动位置、CLI 配置同步的所有权侧车等)。
  // 只拦【写】(guardFileToolPath write:true),读照旧 —— 不影响 file_read 检查点内容 / 工作流模板。uploads/、webcache/、
  // skills/、playbooks/、agent-worktrees/ 与会话自己放进数据根的普通文件不在此列(用户产物与写代理的隔离工作树)。
  const WRITE_PROTECTED_DATA_DIRS = Object.freeze(['mcp', 'agent-workflows', 'checkpoints', 'scheduler', 'steward', 'missions', 'migrations', 'overlay-tool', 'desktop']);
  const WRITE_PROTECTED_DATA_FILES = Object.freeze(['install-registry.json', 'claude-settings-sync.json', 'kimi-mcp-sync.json', 'engine-transcripts.json', 'context-calibration.json', 'proxy-models-cache.json', 'storage-trend.json', 'last-start-error.json']);
  function isWriteProtectedDataPath(p) {
    if (!p) return false;
    if (isSensitiveDataPath(p)) return true;
    // 同 isSensitiveDataPath 开头那一行:剥 NTFS 流后缀与尾随点 / 空格(`mcp.d::$INDEX_ALLOCATION\x.json`、`scheduler.\tasks.json`)。
    p = String(p).split(/([\\/])/).map(seg => (/^[a-z]:$/i.test(seg) || seg === '/' || seg === '\\') ? seg : seg.replace(/:.*$/, '').replace(/([^. ])[. ]+$/, '$1')).join('');
    const bases = sensitiveDataRoots();
    for (const b of bases) {
      for (const n of WRITE_PROTECTED_DATA_DIRS) if (pathWithinRoot(p, path.join(b, n))) return true;
      for (const n of WRITE_PROTECTED_DATA_FILES) if (pathWithinRoot(p, path.join(b, n))) return true;
    }
    return false;
  }
  // 安全审计 #1:数据根之外、同样会被【不经审批自动加载成可执行启动配置】的位置,按真实路径比(env 可改的那几处
  // 不能靠文件名正则):ruyi-toolbox 组件登记目录(04 scanToolboxComponents 按登记文件起服务进程,RUYI_TOOLBOX_HOME
  // 可改位置)、发行包 mcp/ 整棵(随包 drop-in 的清单与它要起的代码,同 scanMcpDropIns)、Kimi Code 的 mcp.json(KIMI_CODE_HOME
  // 可改位置)。缺省位置的文件名形状另由 AUTOEXEC_DENYLIST 的正则兜住,任何工作区里的同名路径也一并拦。
  function isAutoLoadedLaunchConfigPath(p, targetStat) {
    if (!p) return false;
    try {
      const packageRoot = fs.realpathSync.native(externalRoot());
      const nativeRoot = path.join(packageRoot, 'runtime', 'macos');
      const roots = [{ base: packageRoot, suffix: path.join('runtime', 'macos') }];
      try { roots.push({ base: fs.realpathSync.native(nativeRoot), suffix: '' }); } catch { /* runtime may not be installed yet */ }
      for (const root of roots) {
        if (pathWithinRoot(p, path.join(root.base, root.suffix))) return true;
        if (process.platform === 'darwin') {
          const prefix = '/System/Volumes/Data';
          const alternate = root.base.startsWith(prefix + '/') ? root.base.slice(prefix.length) : prefix + root.base;
          const source = fs.statSync(root.base, { bigint: true });
          let alias = null;
          try { alias = fs.statSync(alternate, { bigint: true }); } catch { /* this volume may have no Data alias */ }
          if (alias && source.dev === alias.dev && source.ino === alias.ino
              && pathWithinRoot(p, path.join(alternate, root.suffix))) return true;
        }
      }
      // A helper's hard links and symlink targets can live outside the runtime directory.
      if (targetStat && targetStat.ino) {
        for (const name of ['ruyi-process-helper', 'ruyi-keychain-helper']) {
          try {
            const executable = fs.statSync(path.join(nativeRoot, name), { bigint: true });
            if (sameFileIdentity(targetStat, executable)) return true;
          } catch { /* Either helper can be absent in a source checkout. */ }
        }
      }
    } catch { /* Source-only test contexts may not expose the external package root. */ }
    try {
      if (pathWithinRoot(p, path.resolve(toolboxComponentsDir()))) return true;
    } catch { /* 取不到登记目录:由正则兜底 */ }
    try {
      // 与 scanMcpDropIns 同一张目录表(发行包 mcp/ 与数据根 mcp/);数据根那一处另由 WRITE_PROTECTED_DATA_DIRS 整棵拦。
      for (const { root } of mcpDropInDirs()) if (pathWithinRoot(p, path.resolve(root))) return true;
    } catch { /* 同上 */ }
    const kimiHome = String(process.env.KIMI_CODE_HOME || '').trim();
    if (kimiHome) {
      try { if (pathWithinRoot(p, path.resolve(kimiHome, 'mcp.json'))) return true; } catch { /* 同上 */ }
    }
    return false;
  }

  // 安全走查 S4(续):必须落在【用户真实家目录】下才算的持久化落点 —— 这批文件名(.bashrc / .profile / AGENTS.md / .gitconfig …)在工作区里
  // 是普通工程文件(dotfiles 仓库、项目自己的 AGENTS.md),按「任何位置的同名路径」拦会误伤;只有挂在家目录根(或 ~/.claude/ 之类的
  // 固定子目录)下才是 shell / git / agent CLI 自己会读的那一份。家目录取 os.homedir() 与 USERPROFILE / HOME 三者(Windows 上可能不同),
  // 外加各自的 realpath(家目录是联接 / 重定向盘时 abs 与 real 拼法不同);agent CLI 的家目录取 agentCliHomes()(认 CODEX_HOME / KIMI_CODE_HOME)。
  // 返回 [{ p: 归一化(小写、/ 分隔、去尾点)路径, dir: 是否整棵子树 }]。每次现算(家目录随环境变量变,测试里会改),realpath 按输入缓存。
  const _homeRealCache = new Map();
  function homeRealpathSync(h) {
    if (_homeRealCache.has(h)) return _homeRealCache.get(h);
    let r = '';
    try { r = fs.realpathSync(h); } catch { r = ''; }
    if (_homeRealCache.size > 16) _homeRealCache.clear();
    _homeRealCache.set(h, r);
    return r;
  }
  const USER_HOME_PERSISTENCE_FILES = Object.freeze([
    '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout',
    '.gitconfig', '.config/git/config',
    'AGENTS.md', 'CLAUDE.md',                     // 家目录根下的全局指令(Claude Code / Codex 会按祖先目录读到);项目里的同名文件不在此列
    '.claude/CLAUDE.md',
  ]);
  const USER_HOME_PERSISTENCE_DIRS = Object.freeze([
    '.claude/agents', '.claude/commands', '.claude/skills',   // 子代理 / 斜杠命令 / 技能:启动即载入的提示词与权限声明
    '.codex', '.kimi', '.kimi-code',                           // Codex / Kimi Code 的全局配置与指令(config.toml、AGENTS.md、mcp.json …)
  ]);
  function userHomePersistenceTargets() {
    const homes = new Set();
    for (const h of [os.homedir(), process.env.USERPROFILE, process.env.HOME]) {
      if (typeof h !== 'string' || !h.trim()) continue;
      try { homes.add(path.resolve(h.trim())); } catch { /* skip */ }
      const real = homeRealpathSync(h.trim());
      if (real) homes.add(real);
    }
    const out = [];
    const add = (p, dir) => { try { out.push({ p: normalizeAutoexecPath(path.resolve(p)), dir }); } catch { /* skip */ } };
    for (const h of homes) {
      for (const rel of USER_HOME_PERSISTENCE_FILES) add(path.join(h, ...rel.split('/')), false);
      for (const rel of USER_HOME_PERSISTENCE_DIRS) add(path.join(h, ...rel.split('/')), true);
    }
    try {
      const cli = agentCliHomes();
      add(cli.codex, true); add(cli.kimi, true);   // CODEX_HOME / KIMI_CODE_HOME 改了位置:按真实路径拦
      add(path.join(cli.claude, 'CLAUDE.md'), false);
    } catch { /* 取不到:只剩上面的家目录相对表 */ }
    return out;
  }
  function userHomePersistenceHit(absPath) {
    if (!absPath) return false;
    let n = '';
    try { n = normalizeAutoexecPath(String(absPath)); } catch { return false; }
    for (const t of userHomePersistenceTargets()) {
      if (n === t.p || (t.dir && n.startsWith(t.p + '/'))) return true;
    }
    return false;
  }
  // 对路径做 Windows 语义归一:组件去尾点/尾空格 + 小写(Windows 不区分大小写,junction/短名由 realpath 化解)。
  // 第三波(安全走查复核 #1):再砍掉 NTFS 备用数据流后缀 —— `profile.ps1::$DATA` / `authorized_keys:stream` 与正名是同一个文件(`::$DATA` 就是默认数据流),
  // 目标还不存在时 realpath 不会替我们还原正名,于是以 `$` 收尾的正则与「整串相等」的家目录比对都会落空。Windows 文件名里除盘符外不可能出现 `:`,
  // 所以非盘符段(`C:` 这种单独的盘符段除外)从第一个 `:` 起整段丢掉;POSIX 上带冒号的怪文件名也只是被保守地并到前缀上,只会多拦不会漏。
  function normalizeAutoexecPath(absPath) {
    return absPath.split(/[\\/]/).map(s => (/^[a-z]:$/i.test(s) ? s : s.replace(/:.*$/, '')).replace(/[. ]+$/, '')).join('/').toLowerCase();
  }
  // v2.7.1 (opt#1 全自动宽写): 操作系统关键目录硬地板 -- bypass/auto 宽写模式下仍始终拒绝写入的 OS 系统路径。
  // 与 isSensitiveDataPath(应用自身数据) + AUTOEXEC_DENYLIST 互补,构成"系统级安全保护"三层地板的第三层:
  // 即便用户选了全自动(bypass)模式放开全盘写,Windows/Program Files/ProgramData 等系统关键目录也不可经文件工具写入
  // (改系统文件=蓝屏/无法启动风险,且非用户工作产物)。读不拦(只读访问系统文件无破坏性)。词法 abs 与 realpath 后
  // real 都查(junction/短名部署下两者不同)。env 缺失时回落到 C:\ 常见系统目录。模块加载时算一次(env 不变)。

  return { isWriteProtectedDataPath, isAutoLoadedLaunchConfigPath, userHomePersistenceHit, normalizeAutoexecPath };
}

module.exports = { createWorkspaceWriteProtection };
