const { levenshtein } = require('./backend/path-patterns.cjs');
const { ssrfCheck } = require('./backend/network-policy.cjs');
const { httpGetGuarded } = require('./backend/http-transport.cjs');
const { httpRequest, webFetchFailMessage } = require('./backend/http-request.cjs');
const { boundedReadPage } = require('./backend/text-pages.cjs');
const BackgroundJobs = require('./backend/background-jobs.cjs').createBackgroundJobs({
  sessionsDir: paths.sessions, safeSessionId, sessionPath,
  getActiveSession: id => activeChildren.get(id)?.session,
  getActiveRun: id => activeAgentRuns.get(id),
  emitCompleted: metadata => RUYI_EVENTS.emit('background.completed', metadata),
  onAgentEnvelopePersisted: job => EventStreamHooks.onAgentEnvelopePersisted?.(job),
  logEvent, neutralizeInjectedPrefixes, MAIL_TEXT_MAX, nowIso,
});
const { readBackgroundJobs, writeBackgroundJobRows, persistBackgroundJob } = BackgroundJobs;
EventStreamHooks.mergeBackgroundJobs = BackgroundJobs.mergeBackgroundJobs;
EventStreamHooks.forgetBackgroundJobs = BackgroundJobs.forgetBackgroundJobs;
EventStreamHooks.drainBackgroundJobs = BackgroundJobs.drainBackgroundJobs;
EventStreamHooks.drainAgentEnvelopesText = BackgroundJobs.drainAgentEnvelopesText;
EventStreamHooks.notifyAgentMessage = BackgroundJobs.notifyAgentMessage;
EventStreamHooks.agentMessageStatus = BackgroundJobs.agentMessageStatus;
EventStreamHooks.pendingAgentMessages = BackgroundJobs.pendingAgentMessages;
EventStreamHooks.projectAgentMessageReceipts = BackgroundJobs.projectAgentMessageReceipts;
EventStreamHooks.agentEnvelopeJobId = BackgroundJobs.agentEnvelopeJobId;
EventStreamHooks.isAgentEnvelopeDelivered = BackgroundJobs.isAgentEnvelopeDelivered;
EventStreamHooks.markAgentEnvelopeDelivered = BackgroundJobs.markAgentEnvelopeDelivered;
EventStreamHooks.notifyAgentRunEnvelope = BackgroundJobs.notifyAgentRunEnvelope;
EventStreamHooks.pendingAgentWakeJobs = BackgroundJobs.pendingAgentWakeJobs;
EventStreamHooks.recentBackgroundAgentJobSessions = BackgroundJobs.recentBackgroundAgentJobSessions;

const ShellSessions = require('./backend/shell-sessions.cjs').createShellSessions({
  ProcessRuntime, killChildTree, nowIso, persistBackgroundJob,
  redact, runKeyedChain, safeSessionId, sessionPath,
});
const { shellStart, shellVisibleTo, shellSend, shellPoll, shellKill, shellList,
  killAllShellSessions, shellMcpChildGuard, shellSessions } = ShellSessions;
EventStreamHooks.backgroundShells = ShellSessions.backgroundShells;

// v0.8-S1: glob → RegExp. Self-written, zero-dep. Semantics: `**` crosses directory separators,
// `*` matches within one path segment (not `/` or `\`), `?` matches one non-separator char; every
// other regex metacharacter is escaped literally. Matches against the relative path (with either
// slash flavor accepted). Anchored full-match (^…$).
const BINARY_READ_SUFFIXES = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tif', 'tiff',
  'pdf', 'zip', 'gz', 'tar', 'rar', '7z', 'exe', 'dll', 'so', 'dylib', 'bin',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'wav', 'flac', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'class', 'o', 'obj', 'pyc', 'wasm',
  // 2026-10 走查(R2):Office / 压缩容器 / 数据库。它们按 UTF-8 宽松解码是一堆乱码,修前 file_read 回 ok:true 还把乱码当内容交给模型
  // (.docx/.xlsx/.pptx 本质是 zip;.jar/.apk 同理;.sqlite/.db 是二进制页)。按扩展名直接拒,并在 hint 里指向该用的工具。
  'doc', 'docx', 'docm', 'dot', 'dotx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ppt', 'pptx', 'pptm', 'odt', 'ods', 'odp',
  'jar', 'war', 'ear', 'apk', 'whl', 'nupkg', 'bz2', 'xz', 'zst', 'cab', 'iso', 'msi',
  'sqlite', 'sqlite3', 'db', 'mdb', 'accdb',
]);
function isBinaryReadPath(p) {
  const ext = path.extname(String(p || '')).replace(/^\./, '').toLowerCase();
  return ext !== '' && BINARY_READ_SUFFIXES.has(ext);
}
// 被 file_read 按扩展名拒绝时的下一步:按文件类型指向真正该用的工具(模型据此改道,而不是反复重试 file_read)。
const BINARY_READ_OFFICE = new Set(['doc', 'docx', 'docm', 'dot', 'dotx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ppt', 'pptx', 'pptm', 'odt', 'ods', 'odp']);
const BINARY_READ_ZIPLIKE = new Set(['zip', 'jar', 'war', 'ear', 'apk', 'whl', 'nupkg']);
const BINARY_READ_DB = new Set(['sqlite', 'sqlite3', 'db', 'mdb', 'accdb']);
function binaryReadHint(p) {
  const ext = path.extname(String(p || '')).replace(/^\./, '').toLowerCase();
  if (BINARY_READ_OFFICE.has(ext)) return '新版 Office/ODF 可直接 file_read 读取文字与内嵌图片,不需要桌面控制;旧 .doc/.xls/.ppt 请先另存为 .docx/.xlsx/.pptx,或用 script_run 解析';
  if (ext === 'pdf') return 'PDF 可直接 file_read {path,pageOffset,pageLimit} 读取文字与页面图像(需要 Python + pdfplumber),不需要桌面控制';
  if (BINARY_READ_ZIPLIKE.has(ext)) return '这是 zip 类压缩包:先用 archive_unzip {list:true} 看条目清单,再解压到工作区后读取需要的文件';
  if (BINARY_READ_DB.has(ext)) return '这是数据库文件,不是文本:没有原生读取工具,请用 script_run 写 python(sqlite3 模块)或命令行查询';
  return '图片可直接 file_read,视觉模型会收到图像;其它二进制文件不能按文本读取';
}

const RgProbe = require('./backend/rg-probe.cjs').createRgProbe({
  ProcessRuntime, vendorBinDir: ruyiVendorBinDir, pathBeforeVendor: RUYI_PATH_BEFORE_VENDOR,
});
let { probeRgAsync, probeRgInfoSync, peekRgProbe, probeRg, hasRg, hasRgAsync, rgProbeCandidates } = RgProbe;

// 安全修复(审计 F · ReDoS 后续):file_list 的 pattern 是模型给的正则,逐项同步 `re.test(相对路径)`。
// `(a+)+$` 碰上一个 60 个 a 加 b 的文件名(模型自己就能用 file_write 造出来)要回溯 2^60 步,整个服务的事件循环
// 冻死 —— 与 file_search 修前同一类问题(见下方 regexScanFilesBounded)。file_list 是热路径,不能每次都起 worker:
//   · 词法上「回溯有界」的模式(无分组、无分支、无反向引用、至多一个量词 —— 常见的 `\.js$`、`^src/.*\.ts$`)
//     仍在主线程直接匹配:最坏 O(n²),n = 相对路径长度;
//   · 其余模式交给一个随本次遍历存活的 worker 分批匹配(每批 WALK_PATTERN_BATCH 条相对路径),worker 实际计算
//     累计超过 WALK_PATTERN_BUDGET_MS 就 terminate —— 已匹配到的照常返回,另挂 patternTimedOut(调用方标
//     truncated + patternNote),遍历就此停下;
//   · 模式超过 WALK_PATTERN_MAX_CHARS 直接拒。遍历顺序、maxFiles 截断与 truncated 口径与主线程路径一致。
const { walkFiles, walkDepthHint, walkEnvelopeEntries, walkTruncationHint } = require('./backend/file-walker.cjs').createFileWalker({ ensureDataRootReal, isSensitiveDataPath, isSensitiveHardlinkAlias, pathWithinRoot, realpathForContainment, sensitiveFileIdentities });

const { privacySourceActive, privacySourceMark, privacySourceLineOffsets, privacySourceLine, privacySourceFragment, privacyReadTextWindow, privacyProjectSearch, readIfExists, sourceViewOf } = require('./backend/privacy-sources.cjs').createPrivacySources({ PrivacyGateway });

function sensitiveGlobsForRg(base) {
  const globs = [];
  if (path.sep === '/') {
    for (const directory of ['/private/tmp', '/tmp', '/System/Volumes/Data/private/tmp', '/System/Volumes/Data/tmp']) {
      const relative = path.relative(base, directory);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        globs.push('!/' + (relative ? relative + '/' : '') + 'ruyi-serve-v1-[0-9]*/');
      }
    }
  }
  try {
    // 安全走查 S7:名单与 03 的 isSensitiveDataPath 内的那份一致(unit/unc-and-traversal-gates.test.js 逐名比对);根要把【realpath 后的数据根】也算进来 ——
    // 遍历根已换成 guardFileToolPath 给的 realpath,词法数据根与它不一定同一拼法(联接 / 短名 / 大小写),只认词法会让 !glob 落空。
    const roots = [...new Set([dataRoot(), ...(_dataRootReal ? [_dataRootReal] : []), ...dataRootAliases()])];
    for (const r of roots) {
      for (const n of ['config.json', 'runtime.json', 'sessions', 'memory', 'usage', 'logs', 'generated', 'agent-runs', 'steward', 'missions', 'scheduler', 'migrations', 'engine-transcripts.json', 'credential-vault-v1.json', 'credential-import-v1.json', 'privacy-scopes', 'external-bot-credentials.json', 'external-bots', 'desktop']) {
        const rel = path.relative(base, path.join(r, n));
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) globs.push('!/' + rel.split(path.sep).join('/'));
      }
      const relRoot = path.relative(base, r);
      if (relRoot && !relRoot.startsWith('..') && !path.isAbsolute(relRoot)) globs.push('!/' + relRoot.split(path.sep).join('/') + '/config.json*');
      if (relRoot && !relRoot.startsWith('..') && !path.isAbsolute(relRoot)) globs.push('!/' + relRoot.split(path.sep).join('/') + '/external-bot-credentials.json*');
      if (relRoot && !relRoot.startsWith('..') && !path.isAbsolute(relRoot)) globs.push('!/' + relRoot.split(path.sep).join('/') + '/credential-vault-v1.json*');
    }
  } catch { /* 取不到数据根 → 只剩结果层过滤 */ }
  return globs;
}

const { searchFileContent, regexScanFilesBounded, searchMaxFileBytes, explicitAllowDirs, prunedDirsHint, searchFileContentJs, searchFileContentRg } = require('./backend/content-search.cjs').createContentSearch({
  ProcessRuntime, walkFiles, sensitiveGlobsForRg,
  probe: { hasRgAsync: () => hasRgAsync(), probeRg: () => probeRg() },
  privacy: { privacyProjectSearch, privacySourceActive, privacySourceMark, sourceViewOf },
});

// Git tools share supervised execution and explicit source-privacy ports.
const { runGit, gitReadOnlyGuard, gitStatus, gitDiff, gitLog, gitCommit } = require('./backend/git-tools.cjs').createGitTools({
  ProcessRuntime, killChildTree,
  privacy: { PrivacyGateway, privacySourceActive, privacySourceLine, privacySourceLineOffsets },
});
AgentWorktreeHooks.runGit = runGit;

const { dependencyInventory, codeReviewScan, frontendAudit, claudeMdAudit } = require('./backend/code-audits.cjs').createCodeAudits({
  files: { readIfExists, walkFiles },
  privacy: { PrivacyGateway, privacySourceActive, privacySourceFragment, privacySourceLine, privacySourceLineOffsets, privacySourceMark },
});
const { docsSearch, codebaseSymbolSearch } = require('./backend/code-search.cjs').createCodeSearch({
  files: { readIfExists, regexScanFilesBounded, searchMaxFileBytes, walkFiles },
  privacy: { PrivacyGateway, privacySourceActive, privacySourceLine, privacySourceLineOffsets, privacySourceMark, privacyProjectSearch },
});

// ============================================================================
// v2.6 (M5 候选 D 波 #2): debug_hypothesis — 假设/实验/证伪确定性状态机(二分复现记录器)。
// 对症 07 §6「loop 早停」前科:调试的排除法需要机器追踪「哪些假设已验证/证伪/未碰」,否则模型易
// 反复验证同一假设(loop)或只验证第一条看似合理的就下结论(早停)。纯函数、无内部持久化:台账
// (ledger)快照由模型在对话中自持,每轮把上一轮返回的 ledger 原样传回(对话历史即 run 持久化)。
// ============================================================================
const { debugHypothesis } = require('./backend/debug-hypothesis.cjs');

// ============================================================================
const { dataProfile } = require('./backend/data-profiler.cjs').createDataProfiler({ PrivacyGateway, privacySourceActive, privacySourceMark });

// Compose web tools with storage and connectivity ports; URL policy lives in network-policy.
const { webFetch, webSearch, webCachePath, readWebCache, writeWebCache } = require('./backend/web-tools.cjs').createWebTools({
  cacheDirectory: paths.webcache,
  atomicWriteJson,
  network: { markOnline: markNetworkOnline, probe: async timeoutMs => probeAny(networkAnchors(await readConfig().catch(() => ({}))), timeoutMs) },
});

// ============================================================================
// v1.1-W2 (T1) — 零依赖 ZIP 编解码器 + 五个新内建工具的实现辅助函数。
// ============================================================================
// 【格式说明·把关人可据此审】本 ZIP 读写器只用 Node 内建 zlib（deflateRawSync / inflateRawSync）+ 手写的
// CRC32、local file header、central directory、EOCD。故意 NOT 用 stored 模式（不压缩）——deflate 已内建，无
// 任何 npm 依赖，压缩率还更好。仅实现 ZIP 规范的一个安全子集：
//   • 压缩方法：写入统一用 method 8 (deflate)；空文件退化为 method 0 (stored, size 0)。读取仅认 0/8，其它报错。
//   • 无加密、无 zip64、无 data descriptor（写入端把 CRC/size 直接写进 local header，因为我们先算好再写）。
//   • 文件名一律用 '/' 分隔（ZIP 规范要求），并置 general-purpose bit 11（UTF-8 flag）→ 中文文件名正确往返。
//   • 目录条目名以 '/' 结尾、大小为 0。
//
// CRC32：标准 IEEE 多项式 0xEDB88320 的反射查表实现（256 项预计算表，纯 JS，无依赖）。与 PKZIP/zlib 兼容。
const { crc32, zipWrite, zipReadCentralDir, zipReadEntryData } = require('./backend/archive-codec.cjs');
const { zipCollectEntries } = require('./backend/archive-collector.cjs').createArchiveCollector({ ensureDataRootReal, isSensitiveDataPath, isSensitiveHardlinkAlias });

// ── http_download 的文件名与错误翻译 ──────────────────────────────────────────────────────────────────────────
// dest 是文件夹(已存在的目录,或以 / \ 结尾)时,文件存进这个文件夹里,名字取 Content-Disposition 的 filename(优先 RFC 5987 的 filename*),
// 没有就取最终 URL 路径的最后一段,再没有叫 download。名字只留「一个文件名」:去掉任何目录部分(path.win32.basename 同时认 \ 与 /)、
// Windows 不允许的字符、保留设备名,并限长 —— 服务器给的名字不可信,不能借它跳出 dest 目录。
function downloadFileNameFrom(contentDisposition, finalUrl) {
  let name = '';
  const cd = String(contentDisposition || '');
  let m = /filename\*\s*=\s*(?:UTF-8|utf-8)?'[^']*'([^;]+)/i.exec(cd);
  if (m) { try { name = decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch { name = m[1].trim(); } }
  if (!name) { m = /filename\s*=\s*"([^"]*)"/i.exec(cd) || /filename\s*=\s*([^;]+)/i.exec(cd); if (m) name = m[1].trim(); }
  if (!name) {
    try { const seg = new URL(String(finalUrl || '')).pathname.split('/').filter(Boolean).pop() || ''; name = decodeURIComponent(seg); } catch { /* 取不到就用兜底名 */ }
  }
  name = path.win32.basename(String(name || '').replace(/\0/g, ''));
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').replace(/^\.+$/, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)) name = '_' + name;
  if (name.length > 150) { const ext = path.extname(name).slice(0, 20); name = name.slice(0, 150 - ext.length) + ext; }
  return name || 'download';
}
// fs 写盘失败的人话(原样的 EISDIR / ENAMETOOLONG 对模型没有可行动的信息)。
function describeFsWriteError(e, target) {
  const code = (e && e.code) || '';
  const msg = {
    EISDIR: '目标路径是一个文件夹,不能当文件写',
    ENAMETOOLONG: '文件名或路径太长(请缩短文件名或目录路径)',
    EACCES: '没有写入权限',
    EPERM: '没有写入权限(文件可能是只读,或被系统保护)',
    ENOENT: '目标路径的某一级不存在或无法创建',
    ENOTDIR: '目标路径中有一段是文件而不是文件夹',
    ENOSPC: '磁盘空间不足',
    EBUSY: '文件正被其它程序占用',
    EROFS: '目标位置是只读的',
  }[code] || ((e && e.message) || '写入失败');
  return { ok: false, code: code || 'write_failed', error: `无法保存到 ${target}:${msg}`, path: target };
}

// v1.1-W2 (T1) — http_download 的落盘目标护栏。thread 进来的 ctx 可能带 session/config（provider 引擎路径）
// 或不带（MCP child 路径）。带 → 走 guardWorkspacePath（realpath + fileAllowedRoots）；不带 → 退化护栏：
// dest 的父目录必须在 dataRoot 或 process.cwd 下（与文件工具「落盘落在工作区」同精神，绝不写系统任意路径）。
// 返回 {ok, absPath?} 或 {ok:false, error}。dest 尚不存在时对其父目录做包含判定。
// 安全审计 #3:修前两条路都比 file_write 松 —— 带 ctx 走的是 guardWorkspacePath(读根集合,不查 autoexec / OS 关键目录,
// ws\.git\hooks\pre-commit 照下不误);不带 ctx(MCP 子进程、tool_invoke_edit、不带 sessionId 的 /api/tools/http_download)
// 只看父目录在不在 dataRoot / process.cwd 下,连敏感名单都没查,实测直接盖掉了 <dataRoot>\config.json。现在两条路都走
// 文件工具的同一个【写】闸 guardFileToolPath(敏感/受保护数据 + autoexec + OS 关键目录三层地板,写根包含判定,宽写档
// 语义一致)。ctx 缺会话时按 file_* 工具在 MCP 子进程里的同一口径补:WCW_SESSION_ID 指向的会话 cwd;MCP 子进程
// 连它也没有时,子进程的 cwd 就是 CLI 给的会话工作目录(沿用修前「当前工作目录可下」的那一半,但它在 serve 进程
// 里是安装目录,所以只在 MCP 子进程认)。配置照旧由 guardFileToolPath 在缺 ctx.config 时从盘读。
async function guardDownloadDest(rawDest, ctx) {
  const dest = String(rawDest || '');
  if (!dest || !path.isAbsolute(dest)) return { ok: false, error: '下载目标必须是绝对路径' };
  const abs = path.resolve(dest);
  let gctx = ctx || null;
  if (!(gctx && gctx.session)) {
    let session = null;
    const sid = (gctx && gctx.sessionId) || process.env.WCW_SESSION_ID || '';
    if (sid) { try { session = await loadSession(String(sid)); } catch { session = null; } }
    if (!session && RUNTIME.isMcpChild) session = { cwd: process.cwd() };
    if (session) gctx = { ...(gctx || {}), session };
  }
  const g = await guardFileToolPath(abs, gctx, { tool: 'http_download', write: true });
  if (!g.ok) return { ok: false, error: g.error || '下载目标不在允许的工作区内', code: g.code };
  return { ok: true, absPath: g.absPath };
}

// v0.8-S4a: `ctx` optionally carries checkpoint-journal context {sessionId, turnSeq}. The provider loop
// passes its live session.id/turnSeq; the MCP child passes nothing (journalSessionCtx resolves both from
// the injected WCW_SESSION_ID env + the session file). File-mutating tools (file_write/file_edit/
// file_delete) record a `before` checkpoint immediately before executing.
// 116c: opts.stewardSession === true 时才把 steward_* 放进目录(四个 offer 面之一);缺省 fail-closed
// 隐藏 —— list_tools/tool_search/tool_invoke_* 三条控制面都走本目录,普通会话既检索不到也代理不到管家工具。
async function adaptiveCatalogForMcp(config, opts) {
  const runtime = await ProcessRuntime.capabilitySnapshot();
  const recallEnabled = observationRecallEnabled(config);
  const stewardSession = !!(opts && opts.stewardSession === true);
  const desktopOverride = (opts && opts.desktopOverride != null) ? opts.desktopOverride : null;
  const native = MCP_TOOLS
    .filter(t => t && t.name && !t.name.startsWith('tool_invoke_') && t.name !== 'tool_load' && t.name !== 'permission_prompt') // permission_prompt 是 CLI 权限桥的内部入口,不能代理调用,别进 list_tools / tool_search
    .filter(t => runtimeToolRequirementsMet(t.name, runtime).met)
    .filter(t => !nativeToolDisabledByPolicy(t.name, config, desktopOverride))
    .filter(t => t.name !== 'observation_recall' || recallEnabled) // 105a: 目录同样按双开关隐藏
    .filter(t => !isStewardToolName(t.name) || stewardSession) // 116c: 管家工具只进管家会话的目录
    .map(t => ({ type: 'function', function: { name: t.name, description: t.description || t.name, parameters: t.inputSchema || { type: 'object', properties: {} } } }));
  let bridged = { tools: [], route: {} };
  try { bridged = await collectBridgedTools(config); } catch { /* native-only catalog is still useful */ }
  // 2026-10 能力总闸补桥接面:被 allowCommandTools / allowDesktopTools(+ opts.desktopOverride,调用方按会话取)关掉的内置
  // 桌面 MCP 工具不进 list_tools / tool_search / 代理的目录。route 原样交回:12 invokeAdaptiveMcpTool 先按它认出被关的目标、回 tool-disabled。
  const offeredBridged = dropPolicyDisabledBridgedTools(bridged.tools, bridged.route, config, desktopOverride);
  return { bridged, runtime, catalog: buildToolCatalog(native.concat(offeredBridged), bridged.route, config) };
}
