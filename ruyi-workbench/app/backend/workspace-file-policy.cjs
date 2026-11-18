'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { macPathAnchor, pathWithinAnyRoot, pathWithinRoot, sameFileIdentity } = require('./path-containment.cjs');
const { createRemoteUncDenial, uncHostAndPath, uncIsLocalHost } = require('./workspace-unc-policy.cjs');
const { createWorkspaceWriteProtection } = require('./workspace-write-protection.cjs');

function createWorkspaceFilePolicy({ locations, policy, paths, config }) {
  const {
    agentCliHomes, dataRoot, ensureDataRootReal, externalRoot, mcpDropInDirs, toolboxComponentsDir,
  } = locations;
  const {
    AUTOEXEC_DENYLIST, isSensitiveDataPath, isSensitiveHardlinkAlias, isSensitiveHardlinkStat,
    sensitiveDataRoots,
  } = policy;
  const { samePathKey } = paths;
  const { activeOpenAiProvider, logEvent, readConfig } = config;
  const remoteUncDenialResolved = createRemoteUncDenial({ realpathForContainment });
  const {
    isWriteProtectedDataPath, isAutoLoadedLaunchConfigPath, userHomePersistenceHit, normalizeAutoexecPath,
  } = createWorkspaceWriteProtection({
    agentCliHomes, externalRoot, mcpDropInDirs, toolboxComponentsDir, isSensitiveDataPath, sensitiveDataRoots,
  });

  // ===================================================================================================
  // v0.9-S4 (C4) — local file PREVIEW: path safety + content read.
  // The /api/file/preview endpoint returns file CONTENT (text / image dataURI / html source) to the UI's
  // 「产物」gallery + file tree. That is dangerous by nature (a mis-scoped read is an arbitrary-file-read
  // primitive), so it sits behind TWO gates: (1) the UI-token gate (needsToken whitelist), and (2) this
  // allowed-root containment check — the second, defence-in-depth闸. The requested `path` must be absolute
  // and, once resolved (symlink-agnostic lexical resolve is fine here — we compare canonicalized prefixes),
  // must sit UNDER one of the roots the workbench legitimately touches for this session:
  //   • the session's cwd (its working folder);
  //   • config.defaultWorkspace;
  //   • each of config.recentWorkspaces;
  //   • dataRoot (where the app writes generated artifacts / checkpoints / uploads).
  // Anything outside every root → 403. This is what stops a token-holding page (or a mistaken client) from
  // reading C:\Windows\win.ini or a user file outside any workspace.
  // ===================================================================================================
  function fileAllowedRoots(session, config) {
    const roots = [];
    const push = p => {
      if (typeof p !== 'string' || !p.trim()) return;
      try { roots.push(path.resolve(p.trim())); } catch { /* skip unresolvable */ }
    };
    if (session && typeof session.cwd === 'string') push(session.cwd);
    if (config && typeof config.defaultWorkspace === 'string') push(config.defaultWorkspace);
    for (const w of (config && Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [])) push(w);
    // v2.7 (workspace permissions): trusted workspaces with read access also join the read-root set.
    for (const w of (config && Array.isArray(config.workspaces) ? config.workspaces : [])) {
      if (w && typeof w === 'object' && w.read !== false) push(w.path);
    }
    push(dataRoot()); // generated artifacts, uploads, checkpoints all live here
    // De-dupe (case-insensitive on Windows).
    const seen = new Set();
    return roots.filter(r => { const k = samePathKey(r); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  // v2.7 (workspace permissions): roots where the native file tools may WRITE. session.cwd (current working
  // folder) and dataRoot (app artifacts) are always writable; every configured workspace with write !== false
  // is also writable — this is what lets a non-current but explicitly-trusted workspace be written to.
  // recentWorkspaces are intentionally read-only here (LRU history, not an explicit grant). allowOutsideWorkspace
  // bypasses this entire set.
  function workspaceWriteRoots(session, config) {
    const roots = [];
    const push = p => {
      if (typeof p !== 'string' || !p.trim()) return;
      try { roots.push(path.resolve(p.trim())); } catch { /* skip unresolvable */ }
    };
    if (session && typeof session.cwd === 'string') push(session.cwd);
    push(dataRoot());
    for (const w of (config && Array.isArray(config.workspaces) ? config.workspaces : [])) {
      if (w && typeof w === 'object' && w.write !== false) push(w.path);
    }
    // De-dupe (case-insensitive on Windows).
    const seen = new Set();
    return roots.filter(r => { const k = samePathKey(r); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  // Resolve the existing prefix of a path and then re-attach any missing tail. A plain realpath() fallback
  // to the lexical input is not enough for create destinations: on Windows the parent may be addressed via
  // an 8.3 short name (RUNNER~1) or a junction while the allowed root resolves to its long/real name. Comparing
  // those two spellings rejects a legitimate new file. Resolving the nearest existing ancestor preserves the
  // symlink/junction escape protection while also canonicalizing paths whose leaf does not exist yet.
  // 安全审计 #7(悬空链接越界写):修前 realpath 报 ENOENT 就一律当「这一段还不存在」往上走,于是工作区里一个
  // 【悬空】符号链接 / junction(ws\dangle.txt -> D:\outside\new.txt,目标尚不存在)被词法拼回 ws\dangle.txt,包含判定
  // 放行,而 writeFile 跟着链接把文件建在了工作区外。现在每走到一个 realpath 失败的段先 lstat 它:是链接就读出目标、
  // 把剩余尾巴接到目标上再整条重算(链接套链接逐层解开,上限 40 层);只有真正不存在的段才照旧词法补回。父目录链
  // (mkdir -p 要建的中间段)走同一条路:中间某段是悬空链接时,同样解到它的真实落点再判。Node 在 Windows 上把
  // junction 也报成 isSymbolicLink,readlink 能读出目标。链接读不出目标 / 层数超限 → unresolvable:true,两道护栏
  // (guardFileToolPath / guardWorkspacePath)据此 fail-closed 拒绝;realpathForContainment 保持「返回一个路径」的
  // 旧形状供其它调用方(根目录归一、Kimi 计划文件、exec 闸)。
  const REALPATH_LINK_DEPTH_MAX = 40;
  function stripWin32VerbatimPrefix(p) {
    // readlink 读 junction 在 Windows 上可能带 \\?\ 前缀(\\?\C:\x);去掉它,与 realpath 的输出同一种拼法再比包含。
    const s = String(p || '');
    const m = s.match(/^\\\\\?\\([A-Za-z]:(?:[\\/].*)?)$/);
    return m ? m[1] : s;
  }
  async function resolveContainmentPath(rawPath) {
    let abs = path.resolve(String(rawPath || ''));
    for (let depth = 0; ; depth += 1) {
      let probe = abs;
      const missing = [];
      let next = null;
      for (;;) {
        try {
          const real = await fsp.realpath(probe);
          return { path: missing.length ? path.join(real, ...missing) : real, unresolvable: false };
        } catch (err) {
          // 这一段本身在盘上、realpath 却解不开 → 悬空链接。跟着链接走,别把它当成「还不存在」。先 lstat 再看错误码:
          // Windows 上悬空 junction 的 realpath 错误码不保证是 ENOENT,不能让它落进下面「其它错误 → 词法回退」那一支。
          let lst = null;
          try { lst = await fsp.lstat(probe); } catch { lst = null; }
          if (!(lst && lst.isSymbolicLink()) && (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR'))) return { path: abs, unresolvable: true };
          if (lst && lst.isSymbolicLink()) {
            if (depth >= REALPATH_LINK_DEPTH_MAX) return { path: abs, unresolvable: true };
            let target;
            try { target = stripWin32VerbatimPrefix(await fsp.readlink(probe)); } catch { return { path: abs, unresolvable: true }; }
            const linkTarget = path.resolve(path.dirname(probe), target);
            next = missing.length ? path.join(linkTarget, ...missing) : linkTarget;
            break;
          }
          const parent = path.dirname(probe);
          if (parent === probe) return { path: abs, unresolvable: false };
          missing.unshift(path.basename(probe));
          probe = parent;
        }
      }
      abs = next;
    }
  }
  async function realpathForContainment(rawPath) {
    return (await resolveContainmentPath(rawPath)).path;
  }
  // v1.0.2-S3: shared allowed-root guard for the file endpoints (/api/file/preview borrows the inline version;
  // /api/file/reveal uses this). Resolves BOTH the target and every root via fs.realpath (symlink-agnostic) —
  // a symlink inside an allowed root but pointing outside must NOT pass. Returns {ok, code?, error?, absPath?}:
  //   code 'bad-path'    → not absolute (400-class);
  //   code 'not-allowed' → resolves outside every allowed root (403-class);
  //   ok:true            → absPath is the realpath'd, in-workspace target (存在性由调用方另判)。
  // Mirrors the containment logic already proven in the /api/file/preview handler; centralized so reveal can't
  // drift from preview's护栏。Never throws.
  async function guardWorkspacePath(rawPath, session, config) {
    if (!rawPath || !path.isAbsolute(rawPath)) return { ok: false, code: 'bad-path', error: '路径必须是绝对路径' };
    const targetRaw = path.resolve(rawPath);
    const target = normalizeGuardPath(targetRaw);
    const roots = fileAllowedRoots(session, config);
    // 安全走查 W1:非本机 UNC 在任何 I/O(下面的 realpath 会去连对方主机)之前按「不在工作区」拒,除非它落在用户配置的 UNC 工作区里。
    if (await remoteUncDenialResolved([String(rawPath), targetRaw, target], session, config)) return { ok: false, code: 'not-allowed', error: UNC_DENIED_ERROR };
    const resolved = await resolveContainmentPath(targetRaw);
    const real = normalizeGuardPath(resolved.path);
    // 安全审计 #7:链接读不出目标 / 链接层数超限 —— 不知道真实落点,不放行。
    if (resolved.unresolvable) return { ok: false, code: 'not-allowed', error: '路径经过无法解析的链接,已拒绝' };
    // 审计 P1(对抗轮补漏): reveal(在资源管理器打开/定位)与 bridged 写快照都经此护栏 —— 敏感控制面文件既
    // 不许暴露也不许被覆写(否则可覆写 config.json/runtime.json 致配置损毁/token 替换)。与文件工具同源拒绝。
    // (http_download 落盘自安全审计 #3 起改走 guardFileToolPath 写闸,见 11 guardDownloadDest。)
    await ensureDataRootReal();
    if (isSensitiveDataPath(target) || isSensitiveDataPath(real)) return { ok: false, code: 'not-allowed', error: '该路径属于应用内部数据,已禁止访问' };
    if (await isSensitiveHardlinkAlias(real)) return { ok: false, code: 'not-allowed', error: '该路径属于应用内部数据,已禁止访问' };   // 安全走查 S7:硬链接别名
    const realRoots = await Promise.all(roots.map(r => realpathForContainment(r)));
    if (!pathWithinAnyRoot(real, realRoots)) return { ok: false, code: 'not-allowed', error: '路径不在允许的工作区内' };
    return { ok: true, absPath: real };
  }
  // v1.4.6-S3: is the active OpenAI-compatible provider pointed at a LOCAL endpoint (loopback / private LAN)?
  // Used to relax the out-of-workspace READ guard: a local model (Ollama / LM Studio on 127.0.0.1) cannot
  // exfiltrate file contents to a third party, so reading outside the workspace is comparatively low-risk. A
  // remote/cloud provider (or the Claude cloud engine, or no configured provider) → treated as NON-local, so
  // out-of-workspace reads are denied. Pure lexical host check on the configured baseUrl (no DNS lookup).
  function providerIsLocal(config) {
    try {
      const p = activeOpenAiProvider(config);
      if (!p || !p.baseUrl) return false;
      const host = new URL(p.baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.endsWith('.localhost')) return true;
      if (/^127\./.test(host)) return true;
      if (/^10\./.test(host)) return true;
      if (/^192\.168\./.test(host)) return true;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
      if (/^169\.254\./.test(host)) return true;
      return false;
    } catch { return false; }
  }
  // v1.4.6-S3: workspace boundary for the NATIVE file tools (file_read/write/edit/delete/move/copy/list/
  // search/glob). Data-exfil defense: without this a REMOTE provider's model can drive file_read on ANY local
  // path (C:\Users\...\.ssh, etc.) and stream the bytes out. Policy (config.allowOutsideWorkspace, default
  // false, is the single explicit escape hatch for legitimate cross-workspace work):
  //   • within an allowed root (session.cwd ∪ defaultWorkspace ∪ recentWorkspaces ∪ dataRoot) → allow.
  //   • out of bounds + WRITE  → DENY always (destructive / exfil-staging), audit-logged.
  //   • out of bounds + READ   → allow only for a LOCAL provider (providerIsLocal); a remote/cloud model → DENY.
  //   • allowOutsideWorkspace === true → bypass (still audit-logged so an operator can see the crossings).
  const MAC_MANAGED_ROOTS = Object.freeze(['/Applications', '/Library', '/usr/local', '/opt/homebrew']);
  function macSystemPolicyPath(input) {
    const absolute = path.resolve(input);
    const match = /^\/System\/Volumes\/Data(?=\/)/i.exec(absolute);
    if (!match) return absolute;
    const anchor = macPathAnchor(absolute);
    if (!anchor || anchor.path.length <= match[0].length) return absolute;
    const alternate = anchor.path.slice(match[0].length);
    try {
      if (sameFileIdentity(anchor.stat, fs.statSync(alternate, { bigint: true }))) return path.join(alternate, ...anchor.missing);
    } catch { /* A textual Data prefix alone is not an identity proof. */ }
    return absolute;
  }
  function isMacManagedPath(input) {
    const target = macSystemPolicyPath(input);
    return MAC_MANAGED_ROOTS.some(root => pathWithinRoot(target, root));
  }
  const MAC_SYSTEM_ROOTS = Object.freeze(['/System', '/bin', '/sbin', '/dev', '/usr', '/etc', '/private/etc']);
  function isOsCriticalPath(absPath) {
    if (!absPath) return false;
    const target = macSystemPolicyPath(absPath);
    if (['/', '/private', '/Users', '/Volumes', '/tmp', '/private/tmp'].some(root => pathWithinRoot(target, root) && pathWithinRoot(root, target))) return true;
    if (pathWithinRoot(target, '/usr/local')) return false;
    if (pathWithinRoot(target, '/private/var') || pathWithinRoot(target, '/var')) {
      const temporary = ['/private/var/folders', '/private/var/tmp', '/var/folders', '/var/tmp'];
      return !temporary.some(root => pathWithinRoot(target, root) && !pathWithinRoot(root, target));
    }
    return MAC_SYSTEM_ROOTS.some(root => pathWithinRoot(target, root));
  }
  // v2.7.1 (opt#1): 宽写模式判定。bypass/bypassPermissions/auto 三种模式下 guardFileToolPath 把工作区写边界视为放开
  // (等同 allowOutsideWorkspace=on,但不改配置);三层硬地板(应用数据/autoexec/OS 关键目录)仍始终拦截。ctx.effectivePermissionMode
  // (主回合/子代理派发时注入)优先于 config.permissionMode;都缺时回落 'default'(fail-closed,配置真实默认)。传入已解析的 config 以覆盖 ctx=null
  // (一次性 MCP 子进程)的情况 -- 此时 config 由 readConfig() 从盘读出。
  function wideWriteModeEnabled(ctx, config) {
    const m = String((ctx && ctx.effectivePermissionMode) || (config && config.permissionMode) || 'default');
    return m === 'bypass' || m === 'bypassPermissions' || m === 'auto';
  }
  // v2.7.1 (对抗轮): 归一 Windows 扩展/UNC 路径形态供护栏判定(不改变实际 I/O 路径——handler 仍用调用方原路径)。
  // ① \\?\UNC\localhost\C$\... → C:\...: 本地回环主机(localhost/127.0.0.1/::1/本机名)的盘符$ 管理共享映射回盘符根,
  //    否则 guard 只查盘符路径地板, 而 fsp.realpath 把该形态解析为 \\host\C$\... 的 UNC → OS 地板/敏感地板全落空
  //    (对抗实测: \\?\UNC\localhost\C$\Windows\Temp\... 曾被放行)。
  // ② 其它 \\?\UNC\server\share → \\server\share: 远程共享不在盘符地板(非本地系统目录), 保持 UNC 原样。
  // ③ \\?\C:\ 与 \\.\C:\ 由 fsp.realpath 剥前缀(实测 async realpath 正常剥), 此处仅兜底词法 abs。
  function normalizeGuardPath(p) {
    let s = String(p || '');
    const unc = s.match(/^\\\\\?\\UNC\\(.+)$/i);
    if (unc || /^\\[^\/]/.test(s)) {
      if (unc) s = '\\\\' + unc[1];
      const parts = s.slice(2).split(/[\\/]/);
      const host = String(parts[0] || '').toLowerCase();
      const shareM = String(parts[1] || '').match(/^([A-Za-z])\$/);
      const selfHosts = ['localhost', '127.0.0.1', '::1', (os.hostname ? os.hostname() : '').toLowerCase()];
      if (shareM && selfHosts.includes(host)) {
        const rest = parts.slice(2).join('\\');
        return path.resolve(shareM[1] + ':\\' + (rest ? rest : ''));
      }
    }
    return s;
  }
  const UNC_DENIED_ERROR = '不允许经文件工具访问网络共享(\\\\主机\\共享 形式的路径):这会把文件内容或本机登录凭据交给对方主机。要使用某个网络共享,请先在「设置 › 基础 › 工作区权限」把它添加为工作区';
  // ctx may be null (the one-shot MCP child passes none): then config is read from disk and session is absent,
  // so dataRoot still bounds it. Returns { ok:true, absPath } or { ok:false, code:'not-allowed', error }.
  // 走查 U7:越界报错说人话、说清去哪儿改,不印配置键名(它也会原样出现在对话卡上)。
  const OUTSIDE_WORKSPACE_WRITE_ERROR = '这个位置在工作文件夹外面,已拒绝写入。要允许改工作文件夹外的文件,请在「设置 › 基础 › 工作区权限」勾选「允许工作区外读写」';
  const OUTSIDE_WORKSPACE_READ_ERROR = '这个位置在工作文件夹外面,当前用的不是本机模型,已拒绝读取。要允许,请在「设置 › 基础 › 工作区权限」勾选「允许工作区外读写」';
  async function guardFileToolPath(rawPath, ctx, opts) {
    const write = !!(opts && opts.write);
    const tool = (opts && opts.tool) || 'file';
    const absRaw = path.resolve(String(rawPath || ''));
    const abs = normalizeGuardPath(absRaw);
    let config = ctx && ctx.config ? ctx.config : null;
    if (!config) { try { config = await readConfig(); } catch { config = {}; } }
    const session = ctx && ctx.session ? ctx.session : null;
    // 安全走查 W1:非本机 UNC 在任何 I/O 之前拒(realpath 自己就会去连对方主机的 SMB),排在所有逃生舱与宽写之前。
    if (await remoteUncDenialResolved([String(rawPath || ''), absRaw, abs], session, config)) {
      logEvent({ kind: 'workspace_boundary', tool, op: write ? 'write' : 'read', decision: 'deny-unc', pathLen: abs.length });
      return { ok: false, code: 'not-allowed', error: UNC_DENIED_ERROR };
    }
    const resolved = await resolveContainmentPath(absRaw);
    const real = normalizeGuardPath(resolved.path);
    // 安全审计 #7:悬空链接已在 resolveContainmentPath 里解到真实落点(下面的包含判定与三层地板都按它判);
    // 链接读不出目标 / 层数超限时不知道会写到哪儿 —— 任何模式下都不放行(含宽写与越界豁免)。
    if (resolved.unresolvable) {
      logEvent({ kind: 'workspace_boundary', tool, op: write ? 'write' : 'read', decision: 'deny-unresolvable-link', pathLen: abs.length });
      return { ok: false, code: 'not-allowed', error: '该路径经过无法解析的符号链接/联接,已拒绝' };
    }
    // The resolved path can carry an external UNC spelling, so check it again before metadata or content I/O.
    const realUnc = uncHostAndPath(real);
    if (realUnc && !uncIsLocalHost(realUnc.host) && await remoteUncDenialResolved([real], session, config)) {
      logEvent({ kind: 'workspace_boundary', tool, op: write ? 'write' : 'read', decision: 'deny-unc', pathLen: abs.length });
      return { ok: false, code: 'not-allowed', error: UNC_DENIED_ERROR };
    }
    // 审计 P1: 敏感控制面文件二次拒绝(见 isSensitiveDataPath)。放在 allowOutsideWorkspace 逃生舱【之前】——即便用户
    // 开了越界豁免,应用自身的 config/runtime/sessions/memory 等也绝不可经文件工具读写(密钥/会话/token 外传面)。
    // 词法 abs 与 realpath 后 real 都查,双保险(junction/短名部署下两者不同)。
    await ensureDataRootReal();
    if (isSensitiveDataPath(abs) || isSensitiveDataPath(real)) {
      logEvent({ kind: 'workspace_boundary', tool, op: write ? 'write' : 'read', decision: 'deny-sensitive', pathLen: abs.length });
      return { ok: false, code: 'not-allowed', error: '该路径属于应用内部数据(配置/会话/记忆/日志等),已禁止文件工具访问' };
    }
    // 安全走查 S7:config.json / runtime.json 的【硬链接别名】(同一个 inode 的另一个名字,路径上看不出来)按 dev+ino 比一道。
    // 目标存在才比;不存在(要新建的文件)/ 目录 / nlink=1 的普通文件一次 stat 就过。读写都拒(写进别名就是改写 config.json)。
    let stTarget = null;
    try {
      stTarget = await fsp.stat(real, { bigint: true }).catch(() => null);
      if (stTarget && await isSensitiveHardlinkStat(stTarget)) {
        logEvent({ kind: 'workspace_boundary', tool, op: write ? 'write' : 'read', decision: 'deny-sensitive-hardlink', pathLen: abs.length });
        return { ok: false, code: 'not-allowed', error: '该路径属于应用内部数据(配置/会话/记忆/日志等),已禁止文件工具访问' };
      }
    } catch { /* stat 失败:交给后面的闸 */ }
    // 第31波B(L1): autoexec 检查下沉到 guardFileToolPath —— 全模式覆盖(含 bypass/plan/default),不再依赖授权书层。
    // 仅 write 时检查(读 .git/hooks 不会触发自动执行);对 abs 与 real 双路径归一后匹配 denylist,命中即拒。
    if (write) {
      // 安全审计 #1/#8:数据根里会被自动加载 / 执行 / 信任的状态(mcp drop-in、工作流模板、检查点、定时任务等,
      // 见 isWriteProtectedDataPath)—— 读照旧,写一律拒。与敏感名单一样放在逃生舱之前。
      if (isWriteProtectedDataPath(abs) || isWriteProtectedDataPath(real)) {
        logEvent({ kind: 'workspace_boundary', tool, op: 'write', decision: 'deny-protected-data', pathLen: abs.length });
        return { ok: false, code: 'not-allowed', error: '该路径属于应用内部数据(MCP 连接器/工作流/检查点/定时任务等),已禁止文件工具写入' };
      }
      const normAbs = normalizeAutoexecPath(abs);
      const normReal = normalizeAutoexecPath(real);
      if (AUTOEXEC_DENYLIST.some(re => re.test(normAbs) || re.test(normReal)) || isAutoLoadedLaunchConfigPath(abs, stTarget) || isAutoLoadedLaunchConfigPath(real, stTarget)) {
        logEvent({ kind: 'workspace_boundary', tool, op: 'write', decision: 'deny-autoexec', pathLen: abs.length });
        return { ok: false, code: 'autoexec-denied', error: '该路径属于自动执行文件(如 git hooks/CI 配置/agent CLI 与 MCP 启动配置/登录启动项、shell 与 SSH 配置),已禁止通过文件工具写入;如确需编辑,请直接在终端操作' };
      }
      // 安全走查 S4(续):挂在用户真实家目录下的 shell rc / .gitconfig / ~/.claude/CLAUDE.md / ~/.codex / ~/.kimi 等(见 userHomePersistenceHit)。
      if (userHomePersistenceHit(abs) || userHomePersistenceHit(real)) {
        logEvent({ kind: 'workspace_boundary', tool, op: 'write', decision: 'deny-user-persistence', pathLen: abs.length });
        return { ok: false, code: 'autoexec-denied', error: '该路径是用户级登录 / 全局配置(shell 启动脚本、.gitconfig、Claude / Codex / Kimi 的全局指令与配置等),改动会在之后每次开终端或开 agent CLI 时生效,已禁止通过文件工具写入;如确需编辑,请直接在终端操作' };
      }
      if (isMacManagedPath(abs) || isMacManagedPath(real)) {
        return { ok: false, code: 'managed-location-denied', error: '该路径属于应用或包管理目录，文件工具不可写入。维护此位置需要明确授权的执行操作。' };
      }
      // v2.7.1 (opt#1): OS 关键目录硬地板 -- bypass/auto 宽写下也始终拒写(系统级安全保护第三层)。abs 与 real 双查。
      if (isOsCriticalPath(abs) || isOsCriticalPath(real)) {
        logEvent({ kind: 'workspace_boundary', tool, op: 'write', decision: 'deny-os-critical', pathLen: abs.length });
        return { ok: false, code: 'os-critical-denied', error: '该路径属于 macOS 系统关键目录，已禁止通过文件工具写入。' };
      }
    }
    // v2.7.1 (opt#1): 全自动(bypass/bypassPermissions/auto)模式 = 宽【写】,等同 allowOutsideWorkspace=on(但不改配置)。
    // 仅对 write 生效 -- 读仍维持原 exfil 防护(远端 provider 越界读拒、本地放行),用户只要"写权限"放开。
    // 三层硬地板(应用数据/autoexec/OS 关键目录)已在上方拦截,此处放行的仅是"越工作区但非系统保护"的用户路径。
    const wideWrite = write && wideWriteModeEnabled(ctx, config);
    if ((config && config.allowOutsideWorkspace === true) || wideWrite) {
      const roots0 = fileAllowedRoots(session, config);
      const realRoots0 = await Promise.all(roots0.map(r => realpathForContainment(r)));
      if (!pathWithinAnyRoot(real, realRoots0)) logEvent({ kind: 'workspace_boundary', tool, op: write ? 'write' : 'read', decision: wideWrite ? 'allow-wide-mode' : 'allow-config', pathLen: abs.length });
      return { ok: true, absPath: real };
    }
    // opts.rootSet === 'read':写,但包含判定用读根集合(外加 defaultWorkspace / recentWorkspaces / 读授权工作区)——
    // 只给检查点回滚用(安全审计 #8):bridged 写快照当初按读根集合(guardWorkspacePath)入账,回滚写回同一处要认得它;
    // 三层硬地板与受保护数据照旧先拦。
    const roots = (write && !(opts && opts.rootSet === 'read')) ? workspaceWriteRoots(session, config) : fileAllowedRoots(session, config);
    const realRoots = await Promise.all(roots.map(r => realpathForContainment(r)));
    if (pathWithinAnyRoot(real, realRoots)) return { ok: true, absPath: real };
    if (write) {
      logEvent({ kind: 'workspace_boundary', tool, op: 'write', decision: 'deny', pathLen: abs.length });
      return { ok: false, code: 'not-allowed', error: OUTSIDE_WORKSPACE_WRITE_ERROR };
    }
    if (providerIsLocal(config)) {
      logEvent({ kind: 'workspace_boundary', tool, op: 'read', decision: 'allow-local', pathLen: abs.length });
      return { ok: true, absPath: real };
    }
    logEvent({ kind: 'workspace_boundary', tool, op: 'read', decision: 'deny-remote', pathLen: abs.length });
    return { ok: false, code: 'not-allowed', error: OUTSIDE_WORKSPACE_READ_ERROR };
  }

  return { fileAllowedRoots, workspaceWriteRoots, resolveContainmentPath, realpathForContainment, guardWorkspacePath, providerIsLocal, remoteUncDenialResolved, UNC_DENIED_ERROR, guardFileToolPath };
}

module.exports = { createWorkspaceFilePolicy };
