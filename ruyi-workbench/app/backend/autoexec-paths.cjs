'use strict';

// 第31波B(autonomy-shell-sandbox L1): 工具层 autoexec 路径黑名单 —— 从授权书层(consumeGrant)下沉到
// guardFileToolPath,让 bypass/plan/default 全模式都受 autoexec 保护,不再依赖"是否有授权书"。
// 117q-B2(30 号文 §4.2 拍板口径): 本表是 autoexec 条目的【唯一事实源】——授权书层 06f 的
// GRANT_EDIT_AUTOEXEC_DENY 不再自维护副本,而是 [...本条整条 .git/ 规则, ...AUTOEXEC_DENYLIST] 取并集
// (无人值守面更严:授权书层挡整条 .git/;工具层是有人值守面,保持只挡 hooks/config,扩严会误伤
// .git/COMMIT_EDITMSG 这类日常写)。改条目只改这里。
// 精确匹配 .git/hooks/ 等自动执行入口(不误伤 .gitignore/.gitattributes 等工作区根级文件)。
const AUTOEXEC_DENYLIST = [
  // git hooks（.git/hooks/ 内的任何文件，.githooks/，.husky/）；.git/config 可通过 core.hooksPath 把 hook 重定向到任意目录。
  /(^|[\\/])\.git[\\/]hooks[\\/]/i, /(^|[\\/])\.git[\\/]config(?:\.worktree)?$/i, /(^|[\\/])\.githooks[\\/]/i, /(^|[\\/])\.husky[\\/]/i,
  // IDE 任务
  /(^|[\\/])\.vscode[\\/]tasks\.json$/i, /(^|[\\/])\.vscode[\\/]launch\.json$/i,
  // CI/CD 配置（非高频开发编辑）
  /(^|[\\/])\.github[\\/]workflows[\\/]/i, /(^|[\\/])\.gitlab-ci\.yml$/i, /(^|[\\/])Jenkinsfile$/i,
  /(^|[\\/])\.claude[\\/]settings(?:\.local)?\.json$/i, /(^|[\\/])\.mcp\.json$/i, /(^|[\\/])\.claude\.json$/i,
  /(^|[\\/])\.kimi(?:-code)?[\\/]mcp\.json$/i, /(^|[\\/])\.ruyi-toolbox[\\/]components[\\/]/i,
  // 走查 W1·F2:子模块 / 链接工作树的 git 目录不在 .git 的直接子项下,而在 .git/modules/<名字,名字里可以有斜杠>/ 与 .git/worktrees/<id>/ ——
  // 它们各带一套 hooks/ 与 config(.worktree)。上面 .git/hooks/、.git/config 两条只认 .git 的直接子项,可写的 hook 或
  // core.hooksPath 就从这里绕过去(子模块里一次 git commit 即触发)。按段匹配,嵌套子模块(modules/a/modules/b/)也在内。
  /(^|[\\/])\.git[\\/]modules[\\/](?:[^\\/]+[\\/])*(?:hooks[\\/]|config(?:\.worktree)?$)/i,
  /(^|[\\/])\.git[\\/]worktrees[\\/][^\\/]+[\\/](?:hooks[\\/]|config(?:\.worktree)?$)/i,
  // 安全走查 S4:用户级【自启动 / 登录即执行 / 全局信任配置】落点。auto / bypass 宽写 + 出厂「家目录就是工作区」时,一次 file_write
  // 就能在这些位置留下下次登录 / 下次开终端 / 下次开 agent CLI 就替攻击者执行或改写提示词的东西。这里是【形状】判据(与路径在
  // 不在家目录下无关,Windows 形:大小写不敏感、\ / 都认,调用方已按 abs 与 realpath 各判一遍);必须挂在用户家目录根下才算的那批
  // (~/.bashrc、~/.gitconfig、~/.claude/CLAUDE.md、~/.codex/ 等)认的是真实家目录,见下面的 userHomePersistenceHit。
  //   · Windows 启动文件夹:%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup 与 %ProgramData%\…\StartUp(登录即运行);
  //   · PowerShell profile(WindowsPowerShell\ 与 PowerShell\ 下的 profile.ps1 / Microsoft.PowerShell_profile.ps1 等,每次开 PowerShell 都执行);
  //   · .ssh\authorized_keys(2)/ config / rc / environment(后门登录、ProxyCommand 执行、登录时执行);
  //   · XDG 自启动 .config/autostart/、用户级 systemd 单元 .config/systemd/user/、macOS LaunchAgents;
  //   · 计划任务目录 Windows\System32\Tasks(经文件直写注册任务,绕过 schtasks 的审计)。
  /(^|[\\/])start menu[\\/]programs[\\/]startup([\\/]|$)/i,
  /(^|[\\/])(?:windowspowershell|powershell)[\\/](?:[^\\/]+[\\/])?(?:[a-z0-9.]+_)?profile\.ps1$/i,
  /(^|[\\/])\.ssh[\\/](?:authorized_keys2?|config|rc|environment)$/i,
  /(^|[\\/])\.config[\\/](?:autostart|systemd[\\/]user)([\\/]|$)/i,
  /(^|[\\/])library[\\/]launchagents([\\/]|$)/i,
  /(^|[\\/])windows[\\/]system32[\\/]tasks(?:_migrated)?([\\/]|$)/i,   // 只认 system32\Tasks(Ansible 的 roles/windows/tasks/ 之类工程目录不能误伤)
];

module.exports = { AUTOEXEC_DENYLIST };
