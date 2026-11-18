// ===================================================================================================
// v1.2-B (本切片灵魂): 机制性防漏 —— 把「新增桥接写族工具时逐个补 BRIDGED_WRITE_PATH_ARGS」从人肉纪律
// 升级成【离线回归可断言】的机制。前科:ACC v1.6 四个 Office 写族上线时漏进快照表,用户真机撞出「PPT/Excel
// 不能撤销」。此后每补一个是被动的;auditBridgedWriteCoverage 让「漏表」在 e2e 里直接变红。
//
// 判定:一个 bridged 工具的【裸名】命中「写语义命名模式」(见下)却不在 BRIDGED_WRITE_PATH_ARGS 里 → 判为
//   uncovered(疑似漏进快照表)。命名模式覆盖大厂/社区 MCP 的常见写族命名法:
//     ^(write_|save_|export_|create_)  —— 产出/覆盖文件
//     ^(delete_|remove_)               —— 删除文件
//     ^(move_|copy_|rename_)           —— 移动/复制/改名
//   名字命中但【逻辑上不动文件系统】的工具(如 create_session / create_task)由显式豁免表放行 —— 每条都要
//   写清为什么豁免,豁免是「我看过、确认它不写用户文件」的证据,不是「懒得补表」的地毯。
// ⚠️ 局限(诚实):这是【命名启发式】,只能抓「名字看着像写族却漏表」的。像 excel_beautify / chart_image /
//   window_screenshot 这类【真写文件但名字不含写族前缀】的,命名模式抓不到 —— 它们靠 B1 人工盘点入表(已入),
//   审计函数对它们无能为力(不在 uncovered 里也不在豁免表里,因为名字压根不匹配)。所以本函数是「防回潮网」,
//   不是「盘点器」:它保证【叫 write_*/save_*/… 的新工具】不会静默漏表,人工盘点保证【命名不规范的写族】入表。
const BRIDGED_WRITE_NAME_PATTERN = /^(write_|save_|export_|create_|delete_|remove_|move_|copy_|rename_)/;
// 写语义命名模式命中、但【逻辑上不动用户文件系统】故不需要进快照表的桥接工具裸名。每条注释=豁免理由。
// 这张表是审计的「白名单例外」:auditBridgedWriteCoverage 命中命名模式但在此表里的,不算 uncovered。
// 维护纪律:往这里加名字前必须确认该工具【真的不写用户磁盘文件】(读源码,别信名字);写清一句话理由。
const BRIDGED_WRITE_AUDIT_EXEMPT = new Set([
  // —— ACC v1.6(93 工具)现状:命中命名模式但不动用户文件系统的,逐条豁免 ——
  // move_window:命中 ^move_ 但它是【把窗口挪到屏幕新位置】(window.py: move_window(x,y,title,handle)),
  //   零文件 I/O。命名启发式的典型误报 —— 审计报了、人核实了、显式豁免。这正是豁免表存在的意义(不是地毯,
  //   是「我读过源码确认不写文件」的证据)。ACC 里目前唯一的这类误报。
  'move_window',
  // 下面几条是「防未来」的通用逻辑性名字豁免,以及对社区 drop-in MCP 常见命名法的预置豁免,避免把
  // create_session / create_window 之类误判成漏表(它们即便某天出现在某个 MCP 里,也不动用户文件)。
  'create_session',   // 逻辑会话对象(内存/DB),不落用户文件
  'create_task',      // 任务对象,不动文件系统
  'create_context',   // 浏览器/自动化上下文,不落盘
  'create_window',    // 开窗口(UI),不写文件
  'create_directory', // 建目录 —— 目录不是字节级可快照对象(checkpoint 存文件内容),回滚语义=删空目录,
                      //   价值低且易误删用户既有目录;明确不纳入快照(与内建 file_* 不含 mkdir 一致)。
  'save_session',     // 保存会话到 MCP 内部存储(非用户工作区文件),护栏外不快照。
  'export_macro',     // 若某 MCP 提供:宏导出到其内部数据目录(如 ACC record_stop 写 <data>/macros),
                      //   落在工作区护栏外 → journalBridgedWrite 本就跳过;此处豁免让审计不误报。
]);
// 纯函数:给一批桥接工具【裸名】,返回 { uncovered:[...] } —— 名字像写族(命中命名模式)、非豁免、却不在
// 快照表(BRIDGED_WRITE_PATH_ARGS)里的工具名列表(去重、稳定排序)。uncovered 非空 = 有写族工具漏进快照表,
// 用户将撞「该工具产出/删除的文件不能撤销」—— e2e 断言 uncovered 为空即机制性杜绝 v1.6 事故重演。
// 输入既接受裸名(delete_file)也接受带前缀的桥接名(acc__delete_file),内部统一去前缀。无 I/O、可离线直测。
function auditBridgedWriteCoverage(toolNames) {
  const uncovered = new Set();
  for (const name of (Array.isArray(toolNames) ? toolNames : [])) {
    const bare = unprefixedBridgedName(name);
    if (!bare) continue;
    if (!BRIDGED_WRITE_NAME_PATTERN.test(bare)) continue;               // 名字不像写族 → 审计不管
    if (BRIDGED_WRITE_AUDIT_EXEMPT.has(bare)) continue;                 // 显式豁免(逻辑性名字/护栏外)
    if (Object.prototype.hasOwnProperty.call(BRIDGED_WRITE_PATH_ARGS, bare)) continue; // 已在快照表 → 覆盖到了
    uncovered.add(bare);                                                // 像写族、没豁免、没进表 → 疑似漏
  }
  return { uncovered: [...uncovered].sort() };
}
// v1.2 提示词三层防御·工具层缝隙收口:script_run 已有 Office 软闸,但模型仍可绕道 ACC 的
// run_command/execute_command 用 `python -c "...openpyxl...xxx.xlsx..."` 内联手写 Office(实测续聊惯性
// 场景确实这么干过)。同一启发式在 bridged 分发点(callTool 之前)再设一道同款软闸;force:true 泄压。
// 纯函数,导出供 e2e 单测;返回拒绝对象或 null(放行)。
const BRIDGED_SCRIPT_TOOLS = new Set(['run_command', 'execute_command', 'shell', 'powershell']);
// v1.4.1 (audit #6/#7):Office 手写检测的库/写法特征。旧版只认 pip 库 import,漏了【离线运行时里也捆绑的】
// win32com/comtypes COM 自动化(Dispatch/CreateObject Excel|Word|PowerPoint + .SaveAs)、importlib 动态导入
// 绕过、matplotlib savefig —— 模型可借此绕过软闸手写不可撤销 Office。此处集中强化,两道软闸共用。
const OFFICE_WRITER_LIB_RE = /(openpyxl|xlsxwriter|python-docx|from\s+docx|import\s+docx|python-pptx|from\s+pptx|import\s+pptx|reportlab|win32com|comtypes|Dispatch\s*\(\s*['"](?:Excel|Word|PowerPoint)|CreateObject\s*\(\s*['"](?:Excel|Word|PowerPoint)|GetActiveObject\s*\(\s*['"](?:Excel|Word|PowerPoint)|\.SaveAs\b|importlib\.import_module\s*\(\s*['"](?:openpyxl|docx|pptx|xlsxwriter|reportlab)|\.savefig\s*\(|matplotlib)/i;
function bridgedOfficeScriptGate(bridgedName, args) {
  const bare = unprefixedBridgedName(bridgedName);
  if (!BRIDGED_SCRIPT_TOOLS.has(bare)) return null;
  if (args && args.force === true) return null;
  const cmd = String((args && (args.command || args.cmd || args.code)) || '');
  const officeLib = OFFICE_WRITER_LIB_RE.test(cmd);
  const officeFile = /\.(xlsx|xlsm|docx|pptx|pdf)\b/i.test(cmd);
  if (officeLib && officeFile) {
    return {
      ok: false,
      error: '检测到终端命令在手写 Office 文件。请改用现成工具:Excel = write_excel → excel_beautify →(需图表)excel_chart;PPT = write_pptx;Word = write_document;PDF = write_pdf——统一模板、可一键撤销。若现成工具确实覆盖不了(特殊格式需求),重新调用并加参数 force:true,同时向用户说明该产出不可自动撤销。',
      hint: 'Office 产出规程(工具层强制,v1.2)',
    };
  }
  return null;
}

// v0.8-S0 cwd guardrail: a resolved working dir sitting AT the user's home or its Desktop/Documents/
// Downloads root is the highest-risk "tidy this folder" target (it acts on everything the user owns).
// Returns { path, reason } to attach to the turn's meta event, or null when the dir is task-specific.
function cwdWarning(resolvedDir) {
  if (!resolvedDir) return null;
  const norm = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const home = os.homedir();
  const roots = new Set([home, path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads')].map(norm));
  if (roots.has(norm(resolvedDir))) {
    return { path: resolvedDir, reason: 'working-dir-is-user-root' };
  }
  return null;
}

// ===================================================================================================
// v0.9-S3 (C3) — folder-drag → workspace by FINGERPRINT.
// The browser sandbox never exposes a dropped folder's absolute path (webkitGetAsEntry gives name +
// first-level child names only). So we locate the real directory by fingerprint: given {name, children}
// (children = the folder's first-level entry names, ≤50), search a bounded set of CANDIDATE roots for a
// directory whose basename matches `name` (case-insensitive) AND whose own first-level entry names overlap
// the supplied children by ≥ MATCH_THRESHOLD (Jaccard: |intersect| / |union|). Returns matches sorted by
// score DESC, ≤5. Purely READ-ONLY (readdir); never mutates anything.
//
// Candidate roots (one directory level scanned under each):
//   • each existing drive root (A:\ .. Z:\)     — one level of dirs only
//   • home dir and its first level              — home itself + one level
//   • the current defaultWorkspace's parent      — one level (sibling projects)
//   • config.recentWorkspaces                    — the exact dirs (their basenames can match directly)
//
// PERFORMANCE GUARDRAILS: every readdir is try/catch (a permission-denied root is skipped, never fatal);
// candidate directory total is capped at CANDIDATE_CAP (truncated:true when exceeded); a wall-clock budget
// (RESOLVE_BUDGET_MS) stops the scan early (truncated:true). A huge child list is clamped to CHILDREN_CAP.
// ===================================================================================================
const WORKSPACE_MATCH_THRESHOLD = 0.8;   // Jaccard overlap of child-name sets required to count as a hit
const WORKSPACE_CANDIDATE_CAP = 2000;    // hard cap on candidate directories scanned
const WORKSPACE_RESOLVE_BUDGET_MS = 3000; // overall wall-clock budget for the scan (now covers candidate BUILD too)
const WORKSPACE_CHILDREN_CAP = 50;       // clamp on the incoming child-name list
// PF3: a single dead/offline mapped network drive used to block the WHOLE process, because the resolver
// enumerated drives with fs.readdirSync/existsSync. Every directory listing now goes through fsp.readdir
// (async, yields the event loop) wrapped in a HARD per-directory timeout so one slow root can never stall
// the scan (or the chat stream sharing the loop). On timeout/error the root is simply skipped.
// PF3 fix: 600ms was too tight — a slow-but-ALIVE network drive (700-900ms to list) was routinely misjudged as
// dead and its real workspaces dropped. Widened to 1000ms; the overall RESOLVE_BUDGET_MS still bounds the worst
// case so a genuinely dead drive can never block indefinitely.
const WORKSPACE_DIR_TIMEOUT_MS = 1000;   // hard per-directory readdir/stat timeout (dead network drive can't block)
// PF3 fix: distinguish a TIMEOUT from a real empty/absent/denied directory. The old readdirTimed collapsed both
// to null, so a slow-but-alive dir looked identical to a non-existent one — a real workspace on a laggy drive
// scored 0 (empty child set) and was silently dropped, with no way to flag the result as incomplete. These
// sentinels let callers tell "slow, unknown" (mark truncated / fall back to a bounded stat) apart from "known
// empty/absent" (skip). A readdir that resolves AFTER we've timed out is simply discarded. Never throws.
const READDIR_TIMEOUT = Symbol('readdir-timeout');
const STAT_TIMEOUT = Symbol('stat-timeout');
function readdirTimed(dir, opts, timeoutMs) {
  return Promise.race([
    fsp.readdir(dir, opts).catch(() => null),                                      // null = error (ENOENT / denied / not a dir)
    new Promise(resolve => setTimeout(() => resolve(READDIR_TIMEOUT), timeoutMs)), // sentinel = timed out (alive but slow)
  ]);
}
// PF3 fix: bounded existence probe for an EXPLICITLY-KNOWN candidate path (a recentWorkspace). Confirms the dir
// is still there WITHOUT listing it, so a known workspace on a slow drive isn't dropped just because its own
// readdir timed out. Resolves to a Stats, null (error/absent), or STAT_TIMEOUT. Never throws.
function statTimed(p, timeoutMs, options) {
  return Promise.race([
    fsp.stat(p, options).catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(STAT_TIMEOUT), timeoutMs)),
  ]);
}
// Jaccard similarity of two name Sets: |A ∩ B| / |A ∪ B|. Empty-vs-empty → 1 (both truly empty folders
// fingerprint-match); one-empty → 0.
function nameSetJaccard(a, b) {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
// List first-level SUBDIRECTORIES of `root` (absolute paths). Bounded; never throws. Returns { dirs, timedOut }:
// timedOut:true means the listing was ABANDONED at the per-dir timeout (alive but slow) so the caller can mark
// the overall result truncated (a partial candidate set must not be mistaken for the authoritative one). An
// error/absent root yields { dirs:[], timedOut:false } — nothing to discover, and it's not "slow".
async function listChildDirs(root) {
  // PF3: async + hard timeout. A non-existent drive letter rejects fast (ENOENT → null → []); a live-but-slow
  // network root times out instead of blocking the event loop. Replaces the old existsSync gate: attempting the
  // timed readdir directly both tests existence AND lists in one non-blocking call.
  const ents = await readdirTimed(root, { withFileTypes: true }, WORKSPACE_DIR_TIMEOUT_MS);
  if (ents === READDIR_TIMEOUT) return { dirs: [], timedOut: true };
  if (!ents) return { dirs: [], timedOut: false };
  const out = [];
  for (const e of ents) {
    // isDirectory() can throw on a broken symlink entry on some FS — guard it.
    let isDir = false;
    try { isDir = e.isDirectory(); } catch { isDir = false; }
    if (isDir) out.push(path.join(root, e.name));
    if (out.length >= 4096) break; // sanity guard for a pathological root
  }
  return { dirs: out, timedOut: false };
}

// Core resolver (pure-ish: reads the FS, takes config for candidate roots). Exposed for e2e unit testing.
// Returns { ok:true, matches:[{path, score}], truncated }.
async function resolveWorkspace({ name, children, selectedPath }, config) {
  // Native macOS pickers resolve aliases such as /var -> /private/var. Preserve
  // an existing favorite's spelling and permissions when it names the same directory.
  if (process.platform === 'darwin' && typeof selectedPath === 'string') {
    if (!path.isAbsolute(selectedPath)) throw new Error('selectedPath must be absolute');
    let timer;
    const canonical = await Promise.race([fsp.realpath(selectedPath).catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), WORKSPACE_DIR_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (!canonical) throw new Error('selectedPath could not be resolved');
    const selected = await statTimed(canonical, WORKSPACE_DIR_TIMEOUT_MS, { bigint: true });
    if (!selected || selected === STAT_TIMEOUT || !selected.isDirectory()) throw new Error('selectedPath must identify a directory');
    const known = Array.isArray(config.workspaces) ? config.workspaces : [];
    const resolved = await Promise.all(known.map(async favorite => ({ favorite,
      stat: typeof favorite.path === 'string' && path.isAbsolute(favorite.path) ? await statTimed(favorite.path, WORKSPACE_DIR_TIMEOUT_MS, { bigint: true }) : null,
    })));
    const matching = resolved.filter(row => row.stat && row.stat !== STAT_TIMEOUT && row.stat.dev === selected.dev && row.stat.ino === selected.ino);
    const favorite = matching[0]?.favorite;
    return { ok: true, path: favorite?.path || canonical, ...(favorite ? { favorite } : {}),
      aliases: Array.from(new Set([canonical, selectedPath, ...matching.map(row => row.favorite.path)])), matches: [] };
  }
  const wantName = String(name || '').trim().toLowerCase();
  if (!wantName) return { ok: false, error: 'name is required', matches: [] };
  const wantChildren = new Set(
    (Array.isArray(children) ? children : [])
      .slice(0, WORKSPACE_CHILDREN_CAP)
      .filter(c => typeof c === 'string' && c)
      .map(c => c.toLowerCase())
  );

  const started = Date.now();
  let truncated = false;

  // ── build the candidate-directory list ──────────────────────────────────────────────────────────
  const candidates = [];        // absolute dir paths to test
  const candSeen = new Set();    // de-dupe by lowercased path
  const pushCand = p => {
    if (candidates.length >= WORKSPACE_CANDIDATE_CAP) { truncated = true; return; }
    const key = samePathKey(p);
    if (candSeen.has(key)) return;
    candSeen.add(key);
    candidates.push(p);
  };

  // PF3: the wall-clock budget now guards candidate BUILD (drive/home/parent enumeration), not just scoring,
  // so a slow root can't blow past it. Every listChildDirs() is async + per-directory timed (see WORKSPACE_DIR_TIMEOUT_MS).
  const overBudget = () => Date.now() - started > WORKSPACE_RESOLVE_BUDGET_MS;
  // (a) each existing drive root, one directory level. Enumerate A:..Z: that exist.
  // PF3 fix: a timed-out root enumeration marks the result truncated (its children weren't discovered — the
  // candidate set is incomplete, not authoritative).
  const addChildren = r => { if (r.timedOut) truncated = true; for (const d of r.dirs) pushCand(d); };
  addChildren(await listChildDirs('/'));
  // (b) home dir and its first level.
  const home = os.homedir();
  pushCand(home);
  if (!overBudget()) addChildren(await listChildDirs(home));
  // (c) the current defaultWorkspace's parent, one level (sibling projects).
  const dw = (config && typeof config.defaultWorkspace === 'string' && config.defaultWorkspace) ? config.defaultWorkspace : home;
  const dwParent = path.dirname(path.resolve(dw));
  if (!overBudget()) addChildren(await listChildDirs(dwParent));
  // (d) recentWorkspaces — the exact dirs (their basenames can match directly). PF3 fix: track these as KNOWN
  // paths so a timeout on their own listing falls back to a bounded stat instead of dropping a real workspace.
  const knownPaths = new Set(); // platform-aware resolved paths explicitly used by the user
  for (const w of (config && Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [])) {
    if (typeof w === 'string' && w) { const rp = path.resolve(w); pushCand(rp); knownPaths.add(samePathKey(rp)); }
  }

  // ── score candidates whose basename matches the wanted name ─────────────────────────────────────
  const matches = [];
  for (const dir of candidates) {
    if (Date.now() - started > WORKSPACE_RESOLVE_BUDGET_MS) { truncated = true; break; }
    if (path.basename(dir).toLowerCase() !== wantName) continue;
    const names = await readdirTimed(dir, undefined, WORKSPACE_DIR_TIMEOUT_MS);
    if (names === READDIR_TIMEOUT) {
      // PF3 fix: this candidate's fingerprint is unknowable (slow drive) → the result is INCOMPLETE, flag it.
      truncated = true;
      // Preserve the old "unreadable dir → empty fingerprint" scoring so an empty dropped folder still name-matches.
      const emptyScore = nameSetJaccard(wantChildren, new Set()); // 1 iff wantChildren is also empty, else 0
      if (emptyScore >= WORKSPACE_MATCH_THRESHOLD) {
        matches.push({ path: path.resolve(dir), score: Math.round(emptyScore * 1000) / 1000 });
      } else if (knownPaths.has(samePathKey(dir))) {
        // A KNOWN path (recentWorkspaces) with a non-empty fingerprint we couldn't read must NOT be dropped just
        // because its listing timed out. Confirm it still exists via a bounded stat and select it on the name
        // match alone (a workspace the user has actually used, basename == wanted name, is a real hit). Score at
        // the threshold so it surfaces yet never outranks a genuine fingerprint match (which scores on real overlap).
        const st = await statTimed(dir, WORKSPACE_DIR_TIMEOUT_MS);
        let isDir = false; try { isDir = !!(st && st !== STAT_TIMEOUT && st.isDirectory && st.isDirectory()); } catch { isDir = false; }
        if (isDir) matches.push({ path: path.resolve(dir), score: WORKSPACE_MATCH_THRESHOLD });
      }
      continue;
    }
    const have = names ? new Set(names.slice(0, 500).map(n => String(n).toLowerCase())) : new Set(); // null (error) → empty, as before
    const score = nameSetJaccard(wantChildren, have);
    if (score >= WORKSPACE_MATCH_THRESHOLD) matches.push({ path: path.resolve(dir), score: Math.round(score * 1000) / 1000 });
  }
  // De-dupe by resolved path (a dir can appear via two roots), keep the higher score; sort DESC; ≤5.
  const bestByPath = new Map();
  for (const m of matches) {
    const k = samePathKey(m.path);
    if (!bestByPath.has(k) || bestByPath.get(k).score < m.score) bestByPath.set(k, m);
  }
  const sorted = [...bestByPath.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  return { ok: true, matches: sorted, truncated };
}

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
  if (process.platform !== 'darwin') return false;
  const target = macSystemPolicyPath(input);
  return MAC_MANAGED_ROOTS.some(root => pathWithinRoot(target, root));
}
const OS_CRITICAL_ROOTS = (() => {
  if (process.platform === 'darwin') return ['/System', '/bin', '/sbin', '/dev', '/usr', '/etc', '/private/etc'];
  const out = [];
  const push = p => { if (p && typeof p === 'string') { try { out.push(path.resolve(p)); } catch { /* skip */ } } };
  push(process.env.SystemRoot || 'C:\\Windows');
  push(process.env.ProgramFiles || 'C:\\Program Files');
  push(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)');
  push(process.env.ProgramData || 'C:\\ProgramData');
  const sd = process.env.SystemDrive || 'C:';
  push(sd + '\\$Recycle.Bin');
  push(sd + '\\System Volume Information');
  push(sd + '\\Recovery');
  push(sd + '\\Boot');
  return out;
})();
const OS_CRITICAL_ROOT_FILES = new Set(['pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'bootmgr', 'ntldr', 'bootnxt', 'bootsect.bak']);
function isOsCriticalPath(absPath) {
  if (!absPath) return false;
  if (process.platform === 'darwin') {
    const target = macSystemPolicyPath(absPath);
    if (['/', '/private', '/Users', '/Volumes', '/tmp', '/private/tmp'].some(root => pathWithinRoot(target, root) && pathWithinRoot(root, target))) return true;
    if (pathWithinRoot(target, '/usr/local')) return false;
    if (pathWithinRoot(target, '/private/var') || pathWithinRoot(target, '/var')) {
      const temporary = ['/private/var/folders', '/private/var/tmp', '/var/folders', '/var/tmp'];
      return !temporary.some(root => pathWithinRoot(target, root) && !pathWithinRoot(root, target));
    }
    return OS_CRITICAL_ROOTS.some(root => pathWithinRoot(target, root));
  }
  const norm = path.resolve(absPath).split(/[\\/]/).join('/').toLowerCase();
  for (const r of OS_CRITICAL_ROOTS) {
    const rl = r.split(/[\\/]/).join('/').toLowerCase();
    if (norm === rl || norm.startsWith(rl + '/')) return true;
  }
  // 系统盘根目录的系统文件(如 C:\pagefile.sys): <drive>:/<file> 形态精确匹配。
  const sd = String(process.env.SystemDrive || 'C:').toLowerCase();
  const m = norm.match(/^([a-z]:)\/([^/]+)$/);
  if (m && m[1] === sd && OS_CRITICAL_ROOT_FILES.has(m[2])) return true;
  return false;
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
// 安全走查 W1(UNC 外联):`\\攻击者\share\x`(或 `//攻击者/share/x`)在 Windows 上被 realpath / readFile / writeFile 一碰就会去连那台主机的
// SMB —— 既是绕过 web_fetch SSRF 闸的无提示外传通道(宽写档下 file_write 直接写出去),也会把本机用户的 NTLM 哈希递给对方。
// 所以文件工具的读写闸对【非本机】UNC 路径一律拒绝,而且必须在任何 I/O(realpath 本身就会连网)【之前】判;唯一的例外是这条路径
// 本身落在用户配置的某个工作区根之内(用户自己把网络共享配成了工作区 / 工作文件夹),纯词法判。读、写、本地模型、allowOutsideWorkspace、
// 宽写档都一视同仁 —— 这道闸排在所有逃生舱之前。
//   · 本机主机名(localhost / 127.0.0.1 / ::1 / 本机名)不算外联:`\\localhost\C$\…` 由 normalizeGuardPath 映回盘符后照旧过各道地板;
//   · `\\?\C:\…`、`\\.\C:\…`(设备命名空间的本地盘)不是 UNC,不在此列;`\\?\UNC\主机\共享` 是。
// 正斜杠起头的 `//主机/共享` 只在 Windows 上当 UNC 认(POSIX 上 `//usr/lib` 就是 /usr/lib)。
function uncHostAndPath(p, forwardSlash) {
  const s = String(p == null ? '' : p);
  const fwd = !!forwardSlash;
  const isSep = ch => ch === '\\' || (fwd && ch === '/');
  if (s.length < 3 || !isSep(s[0]) || !isSep(s[1])) return null;
  let rest = s.slice(2);
  // 第三波(复核 #5):`\\.\UNC\主机\共享` 与 `\\?\UNC\…` 是同一个东西(`UNC` 是 \GLOBAL?? 下指向 \Device\Mup 的符号链接,`\\.\` 与 `\\?\` 都映射到它),
  // 再加 `\\?\Global\UNC\…`。其余设备命名空间写法(GLOBALROOT\Device\Mup\… 等)这里不当 UNC 解析,由 deviceNamespaceIsLocalVolume 一律按远端拒。
  const ext = /^[?.][\\/]+(?:Global[\\/]+)?UNC[\\/]+(.*)$/i.exec(rest);
  if (ext) rest = ext[1];
  else if (/^[?.](?:[\\/]|$)/.test(rest) || isSep(rest[0])) return null;   // \\?\C:\ 与 \\.\device;三个及以上的分隔符不是 UNC
  const segs = [];
  for (const seg of rest.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (segs.length > 2) segs.pop(); continue; }   // 不爬出 主机\共享 两段
    segs.push(seg.replace(/[. ]+$/, ''));
  }
  if (!segs.length || !segs[0]) return null;
  const host = segs[0].toLowerCase().replace(/^\[|\]$/g, '');
  // 第三波(复核 #6):`\\wsl$\发行版` 与 `\\wsl.localhost\发行版` 是同一个 WSL 共享的两种拼法(Windows 11 的 realpath 可能把前者还原成后者)。
  // host 原样保留(本机主机名判据不受影响),只在【比较用的 norm】里把两种拼法并成一个,工作区例外按 norm 比。
  const normSegs = host === 'wsl$' ? ['wsl.localhost', ...segs.slice(1)] : segs;
  return { host, norm: ('\\\\' + normSegs.join('\\')).toLowerCase() };
}
function uncIsLocalHost(host) {
  const h = String(host || '').toLowerCase();
  let me = '';
  try { me = (os.hostname ? os.hostname() : '').toLowerCase(); } catch { me = ''; }
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || (me !== '' && h === me);
}
// 第三波(复核 #5):设备命名空间前缀(`\\?\` / `\\.\` / NT 写法 `\??\`)后面接的东西,只有「盘符 `X:`」与「`Volume{GUID}`」(可带 `Global\`)是本地卷;
// 其余一律按远端(`\\?\GLOBALROOT\Device\Mup\…`、`\\.\pipe\…`、UNC 别名以外的未知写法)—— 文件工具没有任何理由去碰这些。
// 返回 null(不是设备命名空间写法)/ true(本地卷)/ false(其余)。UNC 别名写法由 uncHostAndPath 先认出主机,不走这里。
function deviceNamespaceIsLocalVolume(p, forwardSlash) {
  const s = String(p == null ? '' : p);
  const fwd = !!forwardSlash;
  const isSep = ch => ch === '\\' || (fwd && ch === '/');
  let rest = null;
  if (s.length >= 4 && isSep(s[0]) && isSep(s[1]) && (s[2] === '?' || s[2] === '.') && isSep(s[3])) rest = s.slice(4);
  else if (s.length >= 4 && s[0] === '\\' && s[1] === '?' && s[2] === '?' && s[3] === '\\') rest = s.slice(4);
  if (rest === null) return null;
  return /^(?:Global[\\/]+)?(?:[A-Za-z]:(?:[\\/]|$)|Volume\{[0-9a-fA-F-]+\}(?:[\\/]|$))/i.test(rest);
}
// 返回 '' = 不拦;否则是拒绝原因。candidates:要判的几种拼法(原串 / resolve 后 / realpath 后),任一是越界 UNC 即拒。
// extraRoots:调用方已经 realpath 过的 UNC 工作区根(见 remoteUncDenialResolved)—— 例外同时认「字面拼法」与「realpath 拼法」。
function remoteUncDenial(candidates, session, config, forwardSlash, extraRoots) {
  const hits = [];
  for (const c of candidates) {
    const u = uncHostAndPath(c, forwardSlash);
    if (u && !uncIsLocalHost(u.host)) hits.push(u);
    else if (!u && deviceNamespaceIsLocalVolume(c, forwardSlash) === false) hits.push({ host: '(device-namespace)', norm: '\\\\?\\' + String(c).toLowerCase() });
  }
  if (!hits.length) return '';
  const roots = [];
  const push = r => { const u = typeof r === 'string' ? uncHostAndPath(r.trim(), forwardSlash) : null; if (u && !uncIsLocalHost(u.host)) roots.push(u.norm); };
  if (session && typeof session.cwd === 'string') push(session.cwd);
  if (config && typeof config.defaultWorkspace === 'string') push(config.defaultWorkspace);
  for (const w of (config && Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [])) push(w);
  for (const w of (config && Array.isArray(config.workspaces) ? config.workspaces : [])) { if (w && typeof w === 'object') push(w.path); }
  for (const r of (Array.isArray(extraRoots) ? extraRoots : [])) push(r);
  for (const u of hits) {
    if (!roots.some(r => u.norm === r || u.norm.startsWith(r + '\\'))) return u.host;
  }
  return '';
}
// 第三波(复核 #6):工作区根可能是「映射盘 Z:\」「\\wsl$\…」「DFS 名字空间」—— 它们的 realpath(GetFinalPathNameByHandle)是另一种拼法
// (\\fileserver\dept\…、\\wsl.localhost\…、\\目标服务器\…)。纯词法的例外只认字面,于是工具回给模型的 realpath 拼法路径再喂回来就被当成「别人的共享」。
// 所以【只在字面判据要拒的时候】才把配置里的工作区根逐个 realpath(用户自己配的根;每个最多等 3 秒,连不上就当没有),
// 把其中仍是非本机 UNC 的拼法并进例外再判一次。热路径(绝大多数调用字面判据就放行)零额外 I/O。
async function realUncWorkspaceRoots(session, config) {
  const raw = [];
  if (session && typeof session.cwd === 'string') raw.push(session.cwd);
  if (config && typeof config.defaultWorkspace === 'string') raw.push(config.defaultWorkspace);
  for (const w of (config && Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [])) raw.push(w);
  for (const w of (config && Array.isArray(config.workspaces) ? config.workspaces : [])) { if (w && typeof w === 'object') raw.push(w.path); }
  const out = [];
  for (const r of [...new Set(raw.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))].slice(0, 32)) {
    let real = '';
    try { real = await Promise.race([realpathForContainment(r), new Promise(resolve => setTimeout(() => resolve(''), 3000).unref())]); } catch { real = ''; }
    const u = real ? uncHostAndPath(real) : null;
    if (u && !uncIsLocalHost(u.host)) out.push(real);
  }
  return out;
}
async function remoteUncDenialResolved(candidates, session, config) {
  const first = remoteUncDenial(candidates, session, config);
  if (!first) return '';
  let extra = [];
  try { extra = await realUncWorkspaceRoots(session, config); } catch { extra = []; }
  return extra.length ? remoteUncDenial(candidates, session, config, undefined, extra) : first;
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
  // 链接解出来落在非本机 UNC(本地路径里的符号链接指向 \\攻击者\share):同样按越界 UNC 拒。
  // 映射网络盘(Z:\ 本身就解到 \\服务器\共享)是用户自己挂的,realpath 把它还原成 UNC 不是「路径里的链接把请求带出去」—— 不拦;
  // 判据:盘符根自己的 realpath 就是非本机 UNC。只在 real 真的是非本机 UNC 时才多这一次解析。
  {
    const realUnc = uncHostAndPath(real);
    if (realUnc && !uncIsLocalHost(realUnc.host)) {
      let mappedDrive = false;
      const dm = /^([A-Za-z]:)[\\/]/.exec(abs);
      if (dm) {
        const du = uncHostAndPath(await realpathForContainment(dm[1] + '\\'));
        mappedDrive = !!(du && !uncIsLocalHost(du.host));
      }
      if (!mappedDrive && await remoteUncDenialResolved([real], session, config)) {
        logEvent({ kind: 'workspace_boundary', tool, op: write ? 'write' : 'read', decision: 'deny-unc', pathLen: abs.length });
        return { ok: false, code: 'not-allowed', error: UNC_DENIED_ERROR };
      }
    }
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
      return { ok: false, code: 'autoexec-denied', error: '该路径属于自动执行文件(如 git hooks/CI 配置/agent CLI 与 MCP 启动配置/启动文件夹/PowerShell profile/.ssh 配置),已禁止通过文件工具写入;如确需编辑,请直接在终端操作' };
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
      return { ok: false, code: 'os-critical-denied', error: process.platform === 'darwin' ? '该路径属于 macOS 系统关键目录，已禁止通过文件工具写入。' : '该路径属于操作系统关键目录(Windows/Program Files/ProgramData 等),已禁止通过文件工具写入;如确需修改系统文件,请直接在终端以管理员权限操作' };
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
// 安全修复(审计 A②):桥接(ACC 等)的【读文件内容】族工具走与原生 file_read 同一道读边界。
// 修前 read_file / list_directory / file_info / ocr_image 在 read 档(任何权限模式都零弹窗放行),却从不经
// guardFileToolPath —— 远端模型一句话就能读 <dataRoot>\config.json(API 密钥)、runtime.json(回环令牌)、
// ~\.ssh\*。现在分发前(callTool 之前、三个分发点同一个函数)对这些工具的路径参数过读闸:
//   · 应用内部数据(配置/会话/记忆/日志)一律拒(与 file_read 同一条 isSensitiveDataPath 地板);
//   · 工作区外:本机模型放行、远端模型拒(allowOutsideWorkspace 是唯一逃生舱)—— 口径逐字同 file_read;
//   · 必须是绝对路径:相对路径由 ACC 按它自己的工作目录解析,工作台这边判不准,缺省 '.' 同理 → 拒并提示改绝对路径。
// 仍是 read 档:工作区里的读照旧零弹窗,桌面自动化的日常用法不受影响。表按【裸名】登记,对任何桥接服务器
// 同名工具一视同仁(第三方 MCP 的 read_file 也是读文件)。
// 后续补漏:表覆盖 ACC 【全部只读】且带路径入参的工具(逐个对过 mcp/ai-computer-control 的函数签名)——
//   · 读内容 / 列目录 / 看元数据:path 必填(缺省即 ACC 按自己的 cwd 解析,判不准 → 拒);
//   · 模板匹配:find_template / find_all_templates / wait_for_image 的 template_path 与 template_b64 二选一
//     (vision.py _load_template_gray)→ 【给了才查】;find_on_screen 只收 template_path(screen.py,必填)。
//     修前它们在 read 档零弹窗,template_path 指向 config.json 也照读不误。
// 要动桌面 / 动文件的工具(vision_click、copy_file、image_resize、set_clipboard_image、play_sound ……)不在此表:
// 它们是 exec 档(非 bypass/auto 先问人),写路径另有 BRIDGED_WRITE_PATH_ARGS 与检查点。
// 条目形状:{ required: [参数名...], optional: [参数名...] }。
const BRIDGED_READ_PATH_ARGS = Object.freeze({
  read_file: { required: ['path'] }, list_directory: { required: ['path'] }, file_info: { required: ['path'] }, ocr_image: { required: ['path'] },
  read_document: { required: ['path'] }, excel_read: { required: ['path'] }, pdf_read_pages: { required: ['path'] }, image_info: { required: ['path'] },
  find_on_screen: { required: ['template_path'] },
  find_template: { optional: ['template_path'] }, find_all_templates: { optional: ['template_path'] }, wait_for_image: { optional: ['template_path'] },
});
async function bridgedReadPathGate(bridgedName, args, ctx) {
  const bare = unprefixedBridgedName(bridgedName);
  if (!Object.prototype.hasOwnProperty.call(BRIDGED_READ_PATH_ARGS, bare)) return null;
  const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  const spec = BRIDGED_READ_PATH_ARGS[bare];
  const fields = [...(spec.required || []).map(f => [f, true]), ...(spec.optional || []).map(f => [f, false])];
  for (const [field, required] of fields) {
    const raw = typeof a[field] === 'string' ? a[field].trim() : '';
    if (!raw && !required) continue;
    if (!raw || !path.isAbsolute(raw)) {
      return { ok: false, code: 'path-not-absolute', error: `桌面控制读文件必须用【绝对路径】。参数「${field}」${raw ? '是相对路径' : '缺失'},工作台无法判断它指向哪里。请用完整绝对路径重试。` };
    }
    const g = await guardFileToolPath(raw, ctx, { tool: bare, write: false });
    if (!g.ok) return { ok: false, error: g.error, code: g.code, path: raw };
  }
  return null;
}
// v2.7 (workspace permissions): exec gate. A configured workspace with execute === false denies the exec-tier
// command/shell tools (shell_run / script_run / shell_*) when their effective cwd resolves inside it.
// Backward compatible: no workspace entries, or every entry execute:true, leaves behavior unchanged (exec
// tools are NOT otherwise contained by the workspace boundary). Only consults the per-workspace execute flag;
// sensitive/autoexec path checks remain the file guard's responsibility.
// 107-S0(46 号文 §1.5 ②):执行类工具的【有效工作目录】单点解析,闸与执行共用。修前闸在这里按「显式 cwd → 会话
// cwd → defaultWorkspace → 家目录」判,而 shell_start／shell_run／script_run 缺省 cwd 时直接起在家目录 ——
// 闸判一个目录、命令跑在另一个:模型以为在线程工作夹里,相对路径实际落在家目录(45 号文 §9.6.4 真模型实测),
// 授权书「cwd 须在 grantRoot 内」也因为不传 cwd 就被绕开。现在 guardWorkspaceExecute 把解析结果随 ok 一并
// 交回(cwd 字段),三个工具只用交回的这一个值,不各自再推一遍。
// ctx.workingDir 排在会话 cwd 前:原生回合把它注入 ctx(09 runOpenAiTurn:请求级 cwd,缺省会话 cwd),提示词里的
// 「工作目录」、文件工具根(12 resolveFileToolRoot)、资源租约(06g)用的都是它;没有它的调用方(Kimi 桥、
// /api/tools 直调、MCP 子进程)逐字节同修前的判法。
function resolveExecCwd(cwd, ctx, config) {
  const session = ctx && ctx.session ? ctx.session : null;
  const base = (ctx && ctx.workingDir) || (session && session.cwd) || (config && config.defaultWorkspace) || os.homedir();
  if (!cwd) return path.resolve(String(base));
  // 相对 cwd(`src`、`sub\\repo`)接在【回合工作目录】下面:修前直接 path.resolve(cwd),落到服务进程自己的
  // 启动目录,报出来的「工作目录不存在: <进程目录>\\src」模型从没见过。按 Windows 形判绝对路径(盘符/UNC),
  // 宿主上的绝对路径也认。
  const raw = String(cwd);
  if (path.win32.isAbsolute(raw) || path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(String(base), raw);
}
async function guardWorkspaceExecute(cwd, ctx) {
  let config = ctx && ctx.config ? ctx.config : null;
  if (!config) { try { config = await readConfig(); } catch { config = {}; } }
  const abs = resolveExecCwd(cwd, ctx, config);
  const list = (config && Array.isArray(config.workspaces)) ? config.workspaces : [];
  const deny = [];
  for (const w of list) {
    if (w && typeof w === 'object' && w.execute === false && typeof w.path === 'string' && w.path.trim()) {
      try { deny.push(path.resolve(w.path.trim())); } catch { /* skip unresolvable */ }
    }
  }
  if (!deny.length) return { ok: true, cwd: abs };
  const real = await realpathForContainment(abs);
  const realDeny = await Promise.all(deny.map(r => realpathForContainment(r)));
  if (pathWithinAnyRoot(real, realDeny)) {
    logEvent({ kind: 'workspace_boundary', tool: 'exec', op: 'execute', decision: 'deny-workspace-exec', pathLen: abs.length });
    return { ok: false, code: 'not-allowed', error: '该工作区未授权执行命令(execute=false),已拒绝;如需执行请在工作区权限中开启' };
  }
  return { ok: true, cwd: abs };
}
// v1.0.2-S3: build the explorer.exe argv for /api/file/reveal WITHOUT touching a shell (路径含用户可控字符,
// shell 拼接 = 命令注入)。绝不走 cmd.exe:调用方用 cp.spawn('explorer.exe', args, {detached,stdio:'ignore'}).unref()。
//   mode='select' → ['/select,' + absPath]  (注意 /select, 与路径是同一个参数, 逗号后直接拼路径, 资源管理器定位)
//   mode='open'   → [absPath]               (explorer 按默认关联程序打开该文件)
// 把关加固(收官复核):mode='open' 对可执行/脚本类扩展名自动降级为 'select'——否则被提示注入的模型可在
// 工作区造 .bat/.exe/.js(Windows 上 .js 默认关联是脚本宿主, 会直接执行!), 再诱导用户点「打开」= 一键执行
// 任意程序。降级后仅在资源管理器中定位, 是否运行由用户在资源管理器里自己决定。返回 {command,args,mode,degraded}。
// Pure (no I/O, no spawn) — exposed for e2e 单测护栏逻辑。默认 mode='open'。
// v1.4.1 (audit #3):由「黑名单可执行扩展名」改为【白名单默认拒绝】—— 旧黑名单漏了 .settingcontent-ms /
// .msc / .chm / .hta / .wsc / .sct / .appref-ms / .library-ms / .diagcab 等一大票 LOLBin「一键代码执行」文件类型,
// 被提示注入的模型在工作区造这类文件再诱导用户点「打开」= 任意执行。反转:只有【已知安全的查看类】扩展名才允许
// 'open'(文档/Office/图片/媒体/纯文本/网页),其余一律降级为资源管理器「定位」,由用户自行决定是否运行。
const REVEAL_OPEN_SAFE_EXTS = new Set([
  // 纯文本 / 数据(默认由文本编辑器打开)
  'txt', 'md', 'markdown', 'rtf', 'csv', 'tsv', 'log', 'json', 'xml', 'yaml', 'yml', 'ini', 'toml', 'conf',
  // 文档 / Office(查看器打开;Office 默认受保护视图 + 宏禁用)
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'heic',
  // 音视频
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv',
  // 网页(浏览器沙箱打开)
  'html', 'htm',
]);
function buildRevealSpawn(mode, absPath, platform = process.platform) {
  const p = String(absPath || '');
  const ext = path.extname(p).slice(1).toLowerCase();
  const wantOpen = mode !== 'select';
  // 白名单默认拒绝:仅安全查看类扩展名可 'open',其余(可执行/脚本/LOLBin/未知/无扩展名)→ 降级 'select'。
  const effMode = (wantOpen && REVEAL_OPEN_SAFE_EXTS.has(ext)) ? 'open' : 'select';
  return { ...platformOpenSpawn(p, effMode, platform), mode: effMode, degraded: wantOpen && effMode === 'select' };
}
// v1.4.6-S2: build the argv to open a URL / file with the OS default handler WITHOUT a shell. browser_open /
// office_open used to do `cp.spawn('cmd.exe', ['/c','start','', target])` — cmd.exe splits a model-controlled
// target on & | && metacharacters, so `http://x&calc` ran calc.exe (command injection,实测复现). Spawning
// explorer.exe directly (Node CreateProcess passes argv verbatim — no shell) hands the URL/path to the
// default browser/handler and never interprets shell metacharacters. Pure (no spawn); exposed for e2e argv
// assertions. NB: the caller must still spawn with {detached, stdio:'ignore'}.unref().
function buildOpenSpawn(target, platform = process.platform) {
  return platformOpenSpawn(target, 'open', platform);
}

// User-clicked code handoff is intentionally separate from office_open / file reveal. A source file may be
// associated with an executable script host on Windows (`.js` -> WScript.exe is still a common default), so
// blindly asking ShellExecute to "open" model-written code can execute it. Resolve the file association, but
// only accept a known editor/IDE executable; otherwise fall back to another editor already chosen as the
// default for a common code/text extension, then to a conservative installed-editor probe.
function resolvePreferredCodeEditor(filePath) {
  // Test-only seam: route e2e can assert argv/materialized snapshots without opening a real desktop app.
  if (process.env.RUYI_TEST_HOOKS === '1' && process.env.RUYI_TEST_CODE_EDITOR) {
    return { command: String(process.env.RUYI_TEST_CODE_EDITOR), kind: 'vscode', label: 'Test Editor', source: 'test' };
  }
  if (process.platform === 'darwin') {
    const applications = ['Visual Studio Code', 'Visual Studio Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium'];
    for (const directory of [path.join(os.homedir(), 'Applications'), '/Applications']) {
      for (const name of applications) {
        const application = path.join(directory, name + '.app');
        if (fs.existsSync(path.join(application, 'Contents', 'Info.plist'))) {
          return { command: '/usr/bin/open', application, kind: 'mac-vscode', label: name, source: 'installed-fallback' };
        }
      }
    }
    const application = '/System/Applications/TextEdit.app';
    if (fs.existsSync(application)) return { command: '/usr/bin/open', application, kind: 'mac-app', label: 'TextEdit', source: 'system-fallback' };
    return null;
  }
  return null;
}

function buildCodeEditorSpawn(editor, action, beforePath, afterPath) {
  if (!editor || !editor.command) return { ok: false, error: '未检测到可安全打开代码的本机编辑器' };
  const current = String(afterPath || beforePath || '');
  if (editor.kind === 'mac-vscode') {
    const args = action === 'diff'
      ? ['-n', '-a', editor.application, '--args', '--reuse-window', '--diff', String(beforePath || ''), String(afterPath || '')]
      : ['-a', editor.application, '--', current];
    if (action === 'diff' && (!beforePath || !afterPath)) return { ok: false, error: 'Diff 两侧文件路径不完整' };
    return { ok: true, command: editor.command, args, mode: action === 'diff' ? 'diff' : 'open', editor: editor.label, source: editor.source };
  }
  if (editor.kind === 'mac-app') {
    const fileOpenPrefix = ['-a', editor.application, '--'];
    return { ok: true, command: editor.command, args: [...fileOpenPrefix, current], fileOpenPrefix,
      mode: 'open', editor: editor.label, source: editor.source, diffUnsupported: action === 'diff' };
  }
  if (action !== 'diff') return { ok: true, command: editor.command, args: [current], mode: 'open', editor: editor.label, source: editor.source };
  const before = String(beforePath || ''), after = String(afterPath || '');
  if (!before || !after) return { ok: false, error: 'Diff 两侧文件路径不完整' };
  if (editor.kind === 'vscode') return { ok: true, command: editor.command, args: ['--reuse-window', '--diff', before, after], mode: 'diff', editor: editor.label, source: editor.source };
  return { ok: true, command: editor.command, args: [current], mode: 'open', editor: editor.label, source: editor.source, diffUnsupported: true };
}

async function launchCodeEditor(spawnSpec) {
  if (!spawnSpec || !spawnSpec.ok || !spawnSpec.command) return false;
  if (process.env.RUYI_TEST_HOOKS === '1' && process.env.RUYI_TEST_EXTERNAL_EDITOR_CAPTURE) {
    await fsp.writeFile(process.env.RUYI_TEST_EXTERNAL_EDITOR_CAPTURE, JSON.stringify(spawnSpec, null, 2), 'utf8');
    return true;
  }
  try {
    // 编辑器 exe 可能已卸载/被拦:ENOENT 是异步 'error',要等到 spawn/error 才知道成没成,否则调用方的失败分支永远走不到。
    const started = await spawnDetachedChecked(spawnSpec.command, spawnSpec.args || [], { detached: true, stdio: 'ignore' });
    return started.ok;
  } catch { return false; }
}

// Browser navigation has an extra invariant beyond shell-safety: never reuse the current Workbench tab.
// For web pages, resolve the user's default HTTP handler and pass its documented new-tab switch. Local folders
// intentionally retain the Explorer behavior used by the "open data directory" UI action.
function isBrowserDocumentTarget(target) {
  const value = String(target || '').trim();
  return /^(https?:|file:)/i.test(value) || /\.html?$/i.test(value);
}
function buildBrowserOpenSpawn(target) {
  const spec = buildOpenSpawn(String(target || ''));
  return { ...spec, mode: spec.mode === 'select' ? 'file-selection' : 'system-default',
    preservesWorkbench: isBrowserDocumentTarget(target) ? null : true };
}
