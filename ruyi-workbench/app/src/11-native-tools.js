const { levenshtein } = require('./backend/path-patterns.cjs');
const { httpRequest, webFetchFailMessage } = require('./backend/http-request.cjs');
const { boundedReadPage } = require('./backend/text-pages.cjs');
const BackgroundJobs = require('./backend/background-jobs.cjs').createBackgroundJobs({
  paths, safeSessionId, sessionPath,
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
  redact,  safeSessionId, sessionPath,
});
const { shellStart, shellVisibleTo, shellSend, shellPoll, shellKill, shellList,
  killAllShellSessions, shellMcpChildGuard, shellSessions } = ShellSessions;
EventStreamHooks.backgroundShells = ShellSessions.backgroundShells;

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

const { searchFileContent, regexScanFilesBounded, searchMaxFileBytes, explicitAllowDirs, prunedDirsHint, searchFileContentJs, searchFileContentRg } = require('./backend/content-search.cjs').createContentSearch({
  ProcessRuntime, walkFiles, sensitiveGlobsForRg,
  probe: { hasRgAsync: () => hasRgAsync(), probeRg: () => probeRg() },
  privacy: { privacyProjectSearch, privacySourceActive, privacySourceMark, sourceViewOf },
});

// Git tools share supervised execution and explicit source-privacy ports.
const { gitStatus, gitDiff, gitLog, gitCommit } = require('./backend/git-tools.cjs').createGitTools({
  git: GitRuntime,
  privacy: { PrivacyGateway, privacySourceActive, privacySourceLine, privacySourceLineOffsets },
});

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
  paths,
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
