#!/usr/bin/env node
'use strict';
const { platformRuntimeEnvironment, platformOpenSpawn, platformShellEnvironment } = require('./backend/mac-launch-policy.cjs');

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 如意工作台 server(第43波 构建期拼接模块化)
//
// 本文件(app/src/00-boot.js)是【源码模块】之一:app/server.js 是由 app/build.js
// 把 app/src/*.js 按 src/manifest.json 顺序拼接出的【产物】。改代码请改 src/ 对应
// 模块,然后 `node app/build.js` 重建产物;不要手改 app/server.js(会被下次构建覆盖)。
// build --check 校验生成入口。入口装配 backend/ 下的 CommonJS 服务。
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');
const readline = require('readline');
const { URL } = require('url');

const APP_NAME = '如意 Ruyi'; // v0.8-S8 品牌落地(原 'Win Claude Workbench';去 Claude 化,开源商标合规)
const VERSION = '3.0.1'; // 如意 Ruyi 3.0.1 修复更新（2026-10-16）
// Unique per running server instance; lets an updater prove the process actually restarted
// after an overlay was applied (a version string alone can't prove a restart happened).
const OVERLAY_ID = crypto.randomBytes(6).toString('hex');
// Runtime execution admission/cancellation hooks; early declaration also serves session rewind.
const SessionExecutionHooks = {};
// Root desktop authority is registered by a late module, outside the existing SCC.
const DesktopExecutionHooks = {};
const DeliveryHooks = {};
const ExternalBotHooks = {};
const DEFAULT_PORT = 8765;
// 127-114b(26 号文 §3/45 号文 §2 ②): ASR 转写入站专用上限 25 MB —— 早于上面的 128 MB 总闸判定
// (同一请求流里先撞哪条闸,决定 26 MB 夹具拿到的是 413 还是放行;反向:把本常量换成 MAX_BODY_BYTES
// 或把判定挪到 readBody 之后,asr-transcribe.e2e.js 的 24.9/26 MB 返回码对照当场红)。
const ASR_MAX_BODY_BYTES = 25 * 1024 * 1024;
// 14(2026-10):出厂权限档翻成「智能自动」。<14 的存量文件里没存过档的,迁移钉回当年的默认 'default'
// (01-config CONFIG_MIGRATIONS to:14)—— 新默认只给全新安装,不悄悄放开老用户。
// 13(128a,48 号文 §2):配置只落「改过的键」——显式键集合 configExplicitKeysV1 ＋ 稀疏落盘,没碰过的设置跟随
// 产品当前默认;迁移按显式键判。本号本身不挂迁移(推断每次读都跑),只标记「这份文件是稀疏格式写的」。
// 12(v2.8 / 107-T1): 126-111b/111d/111e 三个压缩开关翻成默认开,并对 schema<12 的存量配置做一次性
// 迁移(盘上显式写着的 false → true)。11 = v2.8 selectable Agent CLI driver (Claude Code / Kimi Code)。
const CONFIG_SCHEMA = 14;
// v0.8-S0: session file schema. Bumped independently of CONFIG_SCHEMA; normalizeSession backfills.
const SESSION_SCHEMA = 1;

function exePath() {
  return process.argv[1];
}

function appRoot() {
  return path.resolve(__dirname, '..');
}

const { createWorkbenchDataRoots, createWorkbenchPaths } = require('./backend/workbench-data-roots.cjs');
const { defaultDataRoots, lstatOrNull, dataRoot, dataRootAliases, migrateLegacyDataRoot } =
  createWorkbenchDataRoots({ process });

// 默认命令是 serve。直接运行服务时才检查旧数据根迁移。
function isDirectServeInvocation() {
  if (require.main !== module) return false;
  return !process.argv.slice(2).some(a => ['mcp', 'install', 'doctor', 'mcp-config'].includes(String(a)));
}

function externalRoot() {
  return appRoot();
}

const { BUNDLED_PYTHON_RUNTIME, ruyiVendorBinDir, RUYI_PATH_BEFORE_VENDOR, RUYI_VENDOR_BIN_ON_PATH } =
  require('./backend/workbench-runtime-environment.cjs').configureWorkbenchRuntimeEnvironment({ externalRoot, process, platformRuntimeEnvironment });

const { paths, ensureDirs } = createWorkbenchPaths(dataRoot);

// v1 技能体系: 技能/目录名的安全字符集(供落盘 skills/<id>/、防路径穿越)。复用同 playbook id 的形状。
const SKILL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const { MAX_BODY_BYTES, normalizeApiErrorPayload, safeDecodeURIComponent, json, apiFailure, apiSessionIdInvalid, apiSessionNotFound, text, readBody, readJsonBody, send, contentTypeFor } = require('./backend/http-protocol.cjs');

const { runKeyedChain } = require('./backend/keyed-chain.cjs');
const { markSessionDeleted, sessionSaveIsTombstoned, sessionAssociatedSaveIsTombstoned, clearDeletedSession } = require('./backend/session-tombstones.cjs').createSessionTombstones();
const { truncateToolResult, createToolResultDisplay } = require('./backend/tool-result-view.cjs');
const boundToolResultForDisplay = createToolResultDisplay({ paths });
const { buildAttachmentPrompt, buildDeliveryRevisionPrompt } = require('./backend/attachment-prompt.cjs');
const { lastAssistantEngine, historyStartsWithCompactionSummary, compactionSummaryPairEnd, appendPromptToLastUserMessage } =
  require('./backend/provider-history.cjs');
const { readFilePreview } = require('./backend/file-preview.cjs');
const { normalizeStoragePolicy } = require('./backend/storage-policy.cjs');
const { NATIVE_COMMAND_TOOL_NAMES, NATIVE_DESKTOP_TOOL_NAMES, DESKTOP_MCP_SERVER_ID, ACC_POLICY_TOOL_FAMILIES, nativeToolDisabledByPolicy, bridgedToolDisabledByPolicy, toolDisabledByPolicy, accPolicyHiddenToolNames } = require('./backend/tool-access-policy.cjs');
const { _expandMcpVar, _tomlKeyPath, _parseTomlMcpServers, parseMcpConfigFile, scanMcpSources } = require('./backend/mcp-config-import.cjs');
const { ssrfCheck } = require('./backend/network-policy.cjs');
const { httpGetGuarded } = require('./backend/http-transport.cjs');
const { normalizeCwd, macPathAnchor, sameFileIdentity, pathWithinRoot, pathWithinAnyRoot } = require('./backend/path-containment.cjs');
const { BRIDGED_WRITE_PATH_ARGS, collectBridgedWriteTargets, collectBridgedWriteTarget, bridgedWriteRelativePathArg } = require('./backend/bridged-write-targets.cjs');
const { TOOL_REQUIRES, runtimeToolRequirementsMet, toolRequirementsMet } = require('./backend/tool-capability-policy.cjs');
const { redact } = require('./backend/secret-redaction.cjs');
const {
  KEY_MASK_PREFIX, maskKey, safeUrlForDisplay,
  configSecretValueOrCleared, configUrlOrCleared,
  maskSecrets, unmaskSecrets, maskProviders, unmaskProviders,
  maskedSecretConflicts, maskedSecretConflictMessage, providerLaunchVectorKey,
  collectDisplayUrlRestores, maskExternalMcpServerForDisplay,
  mcpArgsForDisplay, restoreExternalMcpServerSecrets, sanitizeExternalMcpServer,
} = require('./backend/config-secrets.cjs');
const {
  CONTEXT_WINDOW_FALLBACK, CONTEXT_OVERFLOW_PATTERNS,
  extractContextLength, cacheContextLength, cachedContextLength,
  contextWindowFromTable, resolveContextWindow, isContextOverflowError,
} = require('./backend/provider-context-policy.cjs').createProviderContextPolicy();
const {
  fmtTokensServer, setEstimateBucketsV1,
  classifyTextForEstimate, estimateContentTokens, estimateHistoryTokens, estimateTextTokens,
  estimateToolSchemaTokens,
} = require('./backend/token-estimation.cjs').createTokenEstimation();

const { adaptiveMetaToolSchemas, MCP_TOOLS, PROVIDER_SESSION_TOOL_SCHEMAS } = require('./backend/native-tool-schemas.cjs');

const spawnDetachedChecked = require('./backend/mac-launch-policy.cjs').createDetachedLauncher({ cp, process });

const { executionArgumentsDigest, hashArgs } = require('./backend/execution-arguments.cjs');

// Copy only ordinary JSON data properties; no getters, toJSON or inherited serialization hooks.
// Null prototypes make a prepared value stable across asynchronous serialization boundaries.
// JSON reads accept a leading UTF-8 BOM so edited manifests can still be loaded.
const { copyOrdinaryJsonData, safeJsonParse } = require('./backend/ordinary-json.cjs');

const { decodeConsoleText, createConsoleLineDecoder, decodeTextFileBytes, createNdjsonLineFeeder, createCappedDiagnosticText } = require('./backend/text-codecs.cjs');

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

const { neutralizeFenceTag } = require('./backend/prompt-budget.cjs');

// P2-9(30号文§3 总表 + §8.9②): 工具分级排序表 —— 现有 07-autonomy.js/08-agent-runs.js(×3)/
// 09b-replan-ledger.js(×2)六处独立声明字面量 `{read:0,edit:1,exec:2}`,判据一致(数值越大权限越宽)全靠
// 人工复制维持。这是【权限升级判据】—— 08/09b 拿它判"子代理这次调用的工具是否超出授权层级"、"replan
// 补丁是否试图把节点 tier 抬高",分叉的后果是越权。117q-B5 曾把它落在 07-autonomy.js,但 09b 此前从未
// 消费 07 的任何符号,那次收编因此新增了一条循环边 09b-replan-ledger.js->07-autonomy.js,被迫登记进
// module-dependency-policy.json 的白名单(117q-B7 已撤回该条目 —— 移完后 09b 不再引用 07 的任何符号,
// 那条边真的不存在了)。落回本文件(00-boot.js)则 07/08/09b 三个消费者全部已经依赖 00-boot,新增边数
// 为零——它本就只是一张纯查表常量,没有任何 autonomy 语义。冻结防意外改写。
const TOOL_TIER_RANK = Object.freeze({ read: 0, edit: 1, exec: 2 });

const { AUTOEXEC_DENYLIST } = require('./backend/autoexec-paths.cjs');
const { NATIVE_TOOL_TIER, nativeToolTier } = require('./backend/native-tool-tiers.cjs');
const { cliBridgeToolTier } = require('./backend/cli-tool-tiers.cjs');
const {
  ensureDataRootReal, sensitiveDataRoots, isSensitiveDataPath, sensitiveFileIdentities,
  isSensitiveHardlinkStat, isSensitiveHardlinkAlias, sensitiveGlobsForRg,
} = require('./backend/sensitive-paths.cjs').createSensitivePaths({ dataRoot, dataRootAliases });
const logEvent = require('./backend/audit-log.cjs').createAuditLog({ paths, nowIso });

const { CLAUDE_ENDPOINT_PRESETS, claudeCostFields, normalizePricing, cachedInputTokensFromUsage, computeProviderCost } = require('./backend/provider-pricing.cjs');

// 61-A3:给模型看的本地时间(provider 引擎每条 user 消息落历史时带一行,文案在 06b turnTime)。分钟粒度;
// weekday 0 = 周日;offset 形如 UTC+08:00(日志 ts 是 UTC,模型要换算时靠它)。
function localTurnTimeParts(ms) {
  const d = new Date(ms);
  const p2 = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return {
    stamp: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`,
    weekday: d.getDay(),
    offset: `UTC${off >= 0 ? '+' : '-'}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`,
  };
}
const RUYI_EVENTS = require('./backend/workbench-events.cjs').createWorkbenchEvents();

// 事件流模块(13r-event-stream.js)的延迟绑定命名空间 —— 先例是 06i 的 StewardHooks 与 06c 的
// AgentLoopHooks。13-http-router.js 排在 13r 【之前】,直接写 handleEventStreamRoutes 会是一条
// 新前向边;它只写 `EventStreamHooks.handleApiRoutes`(13 → 00-boot 是既有后向边),13r 加载时
// Object.assign 填充实现。未填充(理论上不可能)时那一行是无操作。
const EventStreamHooks = {};

// 子代理的记忆核心胶囊(走查 #15)的延迟绑定口。08-agent-runs 要在子代理系统提示里放用户的核心偏好,但直接引 06d 的
// resolveMemoryPreflight / buildMemoryConflictMap 会给 08 添一条【环内】新边(06d 已在那个强连通分量里,依赖图的环债上限不许涨)。
// 所以 08 只读 `SubAgentMemoryHooks.coreSnapshot`(08 → 00-boot 是既有后向边),由 09-workflow 加载时 Object.assign 填实现
// (09 本来就依赖 06d)。未填充时调用方当「没有胶囊」处理,子任务照跑。契约:coreSnapshot({ parentSession, workingDir, task, config })
// → Promise<{ entries: 已激活核心条目[], conflicts: Map|null }>,绝不抛(调用方也 try 包着)。
const SubAgentMemoryHooks = {};

const { agentCliHomes, tildePath, samePathKey, ruyiPackageInfo, findRuyiPackageRootFor } =
  require('./backend/workbench-path-discovery.cjs').createWorkbenchPathDiscovery({ process });

// One execution state per host; lifecycle services own the entries, never replace the maps.
const { createExecutionState, providerTurnQuotaKey } = require('./backend/execution-state.cjs');
const { sessionWriteChains, activeChildren, turnSettlers, pendingPermissions, pendingQuestions, pendingPlans, activeAgentRuns } = createExecutionState();

const { LEGACY_RUYI_MCP_SERVER_IDS, RUYI_MCP_CLI_TOOL_PREFIX, RUYI_MCP_SERVER_ID, canonicalRuyiMcpServerId, isRuyiMcpServerId } = require('./backend/product-identity.cjs');

const { ROUTE_AUTH } = require('./backend/http-route-policy.cjs');

const { observationRecallEnabled, evaporateBudgetBoundaryEnabled, historyReadDedupEnabled, reseedTailUnitsEnabled, reseedReattachFilesEnabled, summaryPromptI18nEnabled, sessionNotesEnabled, sessionNotesInjectEnabled, sessionNotesMergeEnabled, summaryEntityCheckEnabled, estimateBucketsEnabled, summarySingleShotEnabled, summaryFactTableEnabled, summaryFactTableCap, summaryRefineEnabled, budgetGuardEnabled, budgetGuardTurnTokens, budgetGuardWarnRatio, budgetGuardDecision, toolTimeBudgetEnabled, toolTimeBudgetShadowEnabled, toolTimeBudgetWarnMs, toolTimeBudgetHardMs, toolByteBudgetShadowBytes, volatileTailLayoutEnabled, appendOnlyToolSchemasEnabled, execResultCacheMaxEntries, execResultCacheEnabled, memoryVectorRecallEnabled, sessionSearchIndexEnabled, coreMemoryMaxItems, coreMemoryCharBudget, memoryRelevanceMax, MEMORY_FIXED_SELECTION_HARD_MAX, memoryFixedSelectionMax, memoryIndexCharCap } = require('./backend/runtime-policy.cjs');

const { claudePermissionMode, BUILTIN_AGENT_ROLES, CLAUDE_PERMISSION_MODE_MAP, PERMISSION_MODES, PERMISSION_MODES_REQUIRING_CONFIRM, PERMISSION_MODE_ALIASES, agentRoleIsUntrusted, annotateAgentRoleEffective, clampAgentRoleToParent, mergeAgentRole, normalizeAgentRole, permissionModeFrom, resolvePermissionMode } = require('./backend/agent-role-policy.cjs');

// Explicit agent-cli-types module.
const { AGENT_CLI_DEFAULT_TYPE, AGENT_CLI_TYPES, isAgentCliType, normalizeAgentCliType } = require('./backend/agent-cli-types.cjs');

// Explicit module boundary; implementation and tests belong to backend/server-ownership.cjs.
const { ServerOwnership } = require('./backend/server-ownership.cjs');

// P5 bounded native desktop IPC. The helper is a leaf and never starts child processes.
const MacDesktopAutomationHooks = { helperPath: () => process.env.RUYI_MACOS_AUTOMATION_HELPER
  || require('node:path').resolve(__dirname, '..', 'runtime', 'macos', 'ruyi-automation-helper') };
const MacDesktopAutomation = require('./backend/desktop-automation.cjs').createDesktopAutomation({ hooks: MacDesktopAutomationHooks, process });

// Composition only: process supervision owns its state in an explicit module.
const processHelperPath = () => path.join(externalRoot(), 'runtime', 'macos', 'ruyi-process-helper');
const ProcessRuntimeHooks = { helperPath: processHelperPath };
const ProcessRuntime = require('./backend/process-runtime.cjs').createProcessRuntime({
  hooks: ProcessRuntimeHooks,
  desktopCapabilities: () => MacDesktopAutomation.capabilitySnapshot(),
  process,
});

const { killChildTree, killPosixChildTree } = require('./backend/mac-child-cleanup.cjs').createMacChildCleanup({
  ProcessRuntime, helperPath: processHelperPath, process,
});
ProcessRuntimeHooks.stopUnsupervised = killChildTree;

const DesktopShell = require('./backend/desktop-shell.cjs').createDesktopShell({
  ProcessRuntime, killChildTree, spawnDetachedChecked,
});

const GitRuntime = require('./backend/git-runtime.cjs').createGitRuntime({ ProcessRuntime, killChildTree });
const { runGit, gitReadOnlyGuard } = GitRuntime;

const RgProbe = require('./backend/rg-probe.cjs').createRgProbe({
  ProcessRuntime, vendorBinDir: ruyiVendorBinDir, pathBeforeVendor: RUYI_PATH_BEFORE_VENDOR,
});
let { probeRgAsync, probeRgInfoSync, peekRgProbe, probeRg, hasRg, hasRgAsync, rgProbeCandidates } = RgProbe;

const { spawnProbeSync, spawnProbeAsync, existsExecutable, existsExecutableAsync, probeGitCli, probeGitCliAsync } = require('./backend/executable-probes.cjs').createExecutableProbes({ ProcessRuntime });

// 81-P1: Versioned offline rule extensions. Input and matching budgets are enforced by PrivacyCore;
// built-in delimiter runs are linear, and no user regex runs here.
const { PrivacyRuleCatalog } = require('./backend/privacy-rule-catalog.cjs');

// Explicit privacy service composition; implementations have no host dependency.
const PrivacyCore = require('./backend/privacy-core.cjs').createPrivacyCore();

// Explicit privacy service composition; implementations have no host dependency.
const PrivacyRegex = require('./backend/privacy-regex.cjs').createPrivacyRegex({ core: PrivacyCore });

// Mac credential protection. Unknown legacy ciphertext remains opaque and fails without mutation.
const LocalSecretCryptoHooks = { helperPath: () => require('node:path').resolve(__dirname, '..', 'runtime', 'macos', 'ruyi-keychain-helper') };
const LocalSecretCrypto = require('./backend/local-crypto.cjs').createLocalSecretCrypto({ hooks: LocalSecretCryptoHooks, process });

// Privacy model boundary; state and dependencies are private to this host.
const PrivacyGateway = require('./backend/privacy-gateway.cjs').createPrivacyGateway({ core: PrivacyCore, PrivacyRegex });

PrivacyCore.configHooks.configurePrivacy = PrivacyGateway.configure;
PrivacyCore.configHooks.assertCliAllowed = PrivacyGateway.assertCliAllowed;
PrivacyCore.configHooks.markPrivacyUnavailable = PrivacyGateway.markUnavailable;

const { privacySourceActive, privacySourceMark, privacySourceLineOffsets, privacySourceLine, privacySourceFragment, privacyReadTextWindow, privacyProjectSearch, readIfExists, sourceViewOf } = require('./backend/privacy-sources.cjs').createPrivacySources({ PrivacyGateway });

// Provider protocol composition with explicit service dependencies.
const { PROVIDER_LAN_HOST_SUFFIXES, ProviderHttpHooks, abortableDelay, providerApiBase, providerBaseIsLocalOrLan, providerBaseWithV1, providerCallIsTransient, providerCompletionUrl, providerPostJsonOnce, providerRequestHeaders, providerResponsesBase, providerSseAsCompletion, withTransientRetry } = require('./backend/provider-http.cjs').createProviderHttp({ PrivacyGateway });

// Provider protocol composition with explicit service dependencies.
const { ANTHROPIC_API_VERSION, ANTHROPIC_AUTH_MODES, ANTHROPIC_BETA_FALLBACK, ANTHROPIC_BETA_THINKING_BINDING, ANTHROPIC_COMPLETION_MAX_TOKENS, ANTHROPIC_EFFORTS, ANTHROPIC_EMPTY_TEXT, ANTHROPIC_FALLBACK_MODES, ANTHROPIC_STREAM_ERROR_STATUS, ANTHROPIC_STREAM_MAX_TOKENS, ANTHROPIC_STREAM_MAX_TOKENS_CLAUDE, ANTHROPIC_THINKING_BUDGET_MAX, ANTHROPIC_THINKING_BUDGET_MIN, ANTHROPIC_THINKING_EFFORT_BUDGET, ANTHROPIC_THINKING_MODES, anthropicApiBase, anthropicAssistantBlocks, anthropicBaseUrl, anthropicClassicThinking, anthropicFinishReason, anthropicImageBlock, anthropicLearnedCapKey, anthropicLearnedMaxTokens, anthropicMaxTokensCapFromError, anthropicMaxTokensFor, anthropicMergeUsage, anthropicMessagesFromHistory, anthropicMessagesUrl, anthropicModelTakesAdaptiveThinking, anthropicModelTraits, anthropicModelsUrl, anthropicNonEmpty, anthropicOfficialFeatures, anthropicOfficialHost, anthropicProviderBlocks, anthropicRefusalDetail, anthropicReplayBlock, anthropicReplayableBlocks, anthropicRequestHeaders, anthropicRetryBodyOn400, anthropicStreamErrorText, anthropicThinkingFor, anthropicToolId, anthropicToolInput, anthropicToolResultAsText, anthropicToolResultContent, anthropicTools, anthropicUserBlocks, applyAnthropicEffort, applyAnthropicTemperature, applyAnthropicTools, createAnthropicStreamDecoder, decodeAnthropicCompletion, encodeAnthropicMessages, encodeAnthropicQuick, normalizeAnthropicAuth, normalizeAnthropicFallbacks, normalizeAnthropicThinking, normalizeAnthropicUsage } = require('./backend/provider-anthropic.cjs').createAnthropicProtocol({ providerBaseWithV1 });

// Provider protocol composition with explicit service dependencies.
const { OPENAI_STREAM_ERROR_STATUS, PROVIDER_REASONING_EFFORTS, PROVIDER_WIRE_DEFAULT, PROVIDER_WIRE_PROTOCOLS, ProviderWireHooks, applyProviderReasoningEffort, buildResponsesInputItems, chatCompletionText, createChatStreamDecoder, createResponsesStreamDecoder, decodeChatCompletion, decodeResponsesCompletion, noRetryOn400, normalizeProviderApiStyle, providerReasoningEffort, providerServerSearchCard, providerWireContentFiltered, providerWireContextExceeded, providerWireDecoded, providerWireFailureDetail, providerWireIncomplete, providerWireModelsUrl, providerWireOutputLimited, providerWireProtocol, providerWireProtocolForBody, providerWireResponseIdOf, providerWireStreamErrorText, providerWireToolCallsFromSlots, reasoningContentField, responsesFailedText, responsesHistoryWithCompleteToolPairs, responsesIncompleteFinishReason, responsesInstructions, responsesOutputText, setTemperature, toResponsesContent, toResponsesTools } = require('./backend/provider-wire.cjs').createProviderWire({ providerApiBase, providerBaseWithV1, providerCompletionUrl, providerRequestHeaders, anthropicApiBase, anthropicMessagesUrl, anthropicModelsUrl, anthropicRequestHeaders, anthropicRetryBodyOn400, applyAnthropicEffort, applyAnthropicTemperature, applyAnthropicTools, createAnthropicStreamDecoder, decodeAnthropicCompletion, encodeAnthropicMessages, encodeAnthropicQuick, normalizeAnthropicUsage });

const { createProviderRawCompletion } = require('./backend/provider-raw-completion.cjs');
const providerRawCompletion = createProviderRawCompletion({
  providerWireProtocol, applyProviderReasoningEffort, providerPostJsonOnce,
});

const {
  PROVIDER_PRESETS, resolveProvider, activeOpenAiProvider, stripUrlUserinfo, createProviderConfigNormalizer,
} = require('./backend/provider-config.cjs');
const sanitizeProvider = createProviderConfigNormalizer({
  providerReasoningEffort, normalizeProviderApiStyle,
  normalizeAnthropicAuth, normalizeAnthropicThinking, normalizeAnthropicFallbacks,
});

const { createConfigSchema, BROWSER_AUTOMATION_MODES } = require('./backend/config-schema.cjs');
const { THREAD_INDEX_RECENT_DEFAULT, THREAD_INDEX_RECENT_MIN, THREAD_INDEX_RECENT_MAX } = require('./backend/config-defaults.cjs');
const ConfigWorkspaces = require('./backend/config-workspaces.cjs').createWorkspaceConfig({ platform: process.platform });
const { normalizeWorkspacePathString } = ConfigWorkspaces;
const {
  defaultConfig, normalizeConfig, CONFIG_MIGRATIONS, configValueEquals, prepareConfigWrite,
} = createConfigSchema({
  CONFIG_SCHEMA, VERSION, SKILL_ID_RE, samePathKey, sanitizeProvider, PrivacyCore, workspaces: ConfigWorkspaces,
  detectClaudePath: () => detectClaudePath(), detectKimiPath: () => detectKimiPath(),
});

// 本进程落进 sessions 目录【本层】的原子写次数(会话头、会话索引、搜索索引……)。13e 投影索引据此区分
// 「目录 mtime 变了是自己写的」还是外部改动(外部改动当次做全量比对,自己写的只比名单)。写前、写后各记一次:
// 临时文件落下与 rename 各改一次目录 mtime,两次之间来的读也得认得出是自己。
let sessionsDirOwnWriteSeq = 0;
function noteSessionsDirOwnWrite(file) {
  if (paths && paths.sessions && path.dirname(String(file || '')) === paths.sessions) sessionsDirOwnWriteSeq += 1;
}

// ============================================================================
// 原子 JSON 写入：唯一临时文件、可选私有权限，失败清理自己创建的临时文件。
// Mac rename 原子发布；权限或路径冲突立即报错，保留旧目标。
async function atomicWriteJson(finalPath, value, opts = {}) {
  // typeof 守卫:本函数体会被 autonomy-durability 单独抽取执行(那里没有这个钩子)。
  const noteOwn = typeof noteSessionsDirOwnWrite === 'function' ? noteSessionsDirOwnWrite : () => {};
  noteOwn(finalPath);
  try {
    const payload = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const tmpPath = finalPath + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    // 对抗轮修(第25波): writeFile 自身失败(ENOSPC 典型——目录项已建、写入失败)同样必须清 tmp,否则
    // 节流重试每 1.5s 造一个新孤儿(唯一名无覆写自愈路径)。不变量③对 write 与 rename 两个失败点都成立。
    if (opts.exclusiveTemp === true) {
      let file, created = false;
      try {
        file = await fsp.open(tmpPath, 'wx', Number.isInteger(opts.mode) ? opts.mode : 0o600);
        created = true;
        try { await file.writeFile(payload, 'utf8'); } finally { await file.close(); file = null; }
      } catch (error) {
        if (file) { try { await file.close(); } catch { /* preserve the failed write */ } }
        // EEXIST is someone else's inode. Never unlink it while recovering our own attempt.
        if (created) { try { await fsp.unlink(tmpPath); } catch { /* best effort; no publication */ } }
        throw error;
      }
    } else {
      try { await fsp.writeFile(tmpPath, payload, Number.isInteger(opts.mode) ? { encoding: 'utf8', mode: opts.mode } : 'utf8'); }
      catch (e) { fsp.unlink(tmpPath).catch(() => {}); throw e; }
    }
    try { await fsp.rename(tmpPath, finalPath); }
    catch (e) {
      try { await fsp.unlink(tmpPath); } catch { /* best-effort tmp cleanup */ }
      throw e;
    }
  } finally { noteOwn(finalPath); }
}

const { readInstallRegistry, writeInstallRegistry, recordInstallLaunch } = require('./backend/install-registry.cjs').createInstallRegistry({
  paths, externalRoot, samePathKey, nowIso, version: VERSION, atomicWriteJson,
});

// 117q-B6(30 号文 P2-10):「读文件末尾 N 字节」原语【统一入口】。此前四处独立手写同一套动作
// (stat 拿 size -> 算尾窗起点 -> open -> 分配 buffer -> read -> finally 关 fd):02-session-store.js 的
// repairMissionChangeTornTail/repairInterventionTornTail 两处【不检查 bytesRead】——直接对整段已分配
// buffer 取最后一字节 / lastIndexOf,若 fd.read 实际读到的字节数少于请求量(stat 与 read 之间文件被
// 截短等罕见竞态),就会对 buffer 里未被写入的那一截(未初始化或陈旧内存)算截断点——而这个截断点
// 会被直接拿去 fsp.truncate()。算错就是真的截错数据。08-agent-runs.js/13g-steward.js 的两处已经在
// 检查 bytesRead,行为不变,只是把手写的 open/alloc/read/close 换成本函数。
// 返回 { buf, bytesRead, size }：size < 0 表示文件不存在(或 stat 失败,与原四处"stat 出错即当无文件"
// 同口径)；buf.length === 请求要读的字节数(= min(maxBytes, size) 且已 clamp 到 >=0),但【只有
// buf[0..bytesRead) 是本次 read 实际写入的有效数据】——调用方必须按 bytesRead 定界(取最后一个有效
// 字节要用 buf[bytesRead-1],扫 \n 要把 lastIndexOf 的搜索起点钉在 bytesRead-1),不能假设 bytesRead
// === buf.length。空文件(size===0)与「尾窗一字节都不用读」的退化情形直接返回 bytesRead:0,不开 fd。
async function readFileTail(file, maxBytes) {
  let size = -1;
  try { size = (await fsp.stat(file)).size; } catch { return { buf: Buffer.alloc(0), bytesRead: 0, size: -1 }; }
  const max = Math.max(0, Math.floor(Number(maxBytes) || 0));
  const start = Math.max(0, size - max);
  const want = size - start;
  if (!want) return { buf: Buffer.alloc(0), bytesRead: 0, size };
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, start);
    return { buf, bytesRead, size };
  } finally { if (fh) await fh.close().catch(() => {}); }
}

// ── 103c: composable lifecycle for small durable JSON state ──────────────────
// This is deliberately narrower than a database abstraction. NDJSON append logs, session v2 bodies,
// exit-time synchronous snapshots and externally-owned files keep their dedicated protocols. The helper
// below only centralizes the lifecycle that small workbench-owned JSON stores were independently rebuilding:
// schema admission, sanitization, corruption quarantine, bounded collections, serialized atomic writes and
// an explicit process cache/invalidation contract.
// 架构还债批 2 B3:新写的小 JSON 存储一律用它(不再各自手写 read/parse/schema/隔离/原子写那一套)。两个可选项
// 让「坏了就当空」一族的存量存储能逐字节不变地迁进来:
//   quarantine: false —— 坏文件/读不动/错 schema 静默回落默认值,原文件留在原处、不复制成 .corrupt(onCorrupt 仍照常调,corruptPath 为空串);
//   read()           —— readSync 的异步版(fsp.readFile),同一套 prepare/回落/缓存规则,给本来就在 async 路径上的存储用。
const DurableJsonStore = require('./backend/durable-json-store.cjs').createDurableJsonStore({ fs, fsp, path, atomicWriteJson });

const { ACC_MEMORY_IMPORT_SCHEMA, accMemoryImportStore, legacyAccMemoryMigrationComplete } = require('./backend/acc-memory-import-marker.cjs').createAccMemoryImportMarker({
  DurableJsonStore, paths,
});

const ToolboxRegistry = require('./backend/toolbox-registry.cjs').createToolboxRegistry({ logEvent, safeJsonParse });
const { enabled: enabledToolboxComponents, directory: toolboxComponentsDir } = ToolboxRegistry;
const { mcpDropInDirs, scanMcpDropIns, invalidateMcpDropInCache, isEquivalentDesktopAccServer, resolveExternalMcpServers } = require('./backend/mcp-sources.cjs').createMcpSources({
  externalRoot, dataRoot, enabledToolboxComponents, detectDesktopMcp: () => detectDesktopMcp(), legacyAccMemoryMigrationComplete, logEvent,
});

const { projectAgentRoleFile, readProjectAgentRoles, readClaudeProjectAgentRoles, getAgentRoleLibrary, saveProjectAgentRoles, buildClaudeAgentDefinitions } = require('./backend/agent-role-library.cjs').createAgentRoleLibrary({ atomicWriteJson });


const {
  readConfig, writeConfig, writeConfigAtomic, mutateConfig, configEmitWritten, invalidateConfigRecoveryState,
} = require('./backend/config-store.cjs').createConfigStore({
  paths, ensureDirs, safeJsonParse, atomicWriteJson: (...args) => atomicWriteJson(...args),
  normalizeConfig, prepareConfigWrite, privacyHooks: PrivacyCore.configHooks, logEvent,
  detectClaudePath: () => detectClaudePath(), detectKimiPath: () => detectKimiPath(),
  waitForConfigCliProbes: () => AgentCliDiscovery.waitForConfigCliProbes(),
  onWritten: status => RUYI_EVENTS.emit('config.written', status),
});

// 架构还债批 2 B2:配置补丁的落盘与副作用 applyConfigPatch 住在 06k-config-patch.js(它要调 02 / 05 / 06i 的
// 同步原语,放在 01 里会造出 01->02、01->06i 两条新前向边)。两个调用方(13 的 POST /api/config、13l 的
// steward_config_set)经这个命名空间调,不直接引用 06k 的符号 —— 否则 06k 会被卷进唯一的大 SCC。
//   applyConfigPatch(rawBody) -> Promise<next>(06k 加载时填入;契约见 06k 里那个函数的头注)
const ConfigPatchHooks = {};

const { createClaudeConfigSync, RUYI_AGENT_FILE_MARKER } = require('./backend/claude-config-sync.cjs');
const { syncClaudeCliSettings, syncAgentRolesToClaude } = createClaudeConfigSync({
  paths, atomicWriteJson, getAgentRoleLibrary, logEvent,
});
// Loopback coordinates for per-session permission callbacks; only startMcp marks a child.
const RUNTIME = { port: DEFAULT_PORT, host: '127.0.0.1', token: '', isMcpChild: false, launchMode: 'unknown' };
const { externalServerJs, bundledNodeExe, commandForSelfMcp, mcpConfigFilePath, generateMcpConfig,
  generateSessionMcpConfig, generateAgentNodeMcpConfig } = require('./backend/mcp-manifests.cjs').createMcpManifests({
  paths, runtime: RUNTIME, hostFile: __filename, externalRoot, ensureDirs, readConfig, resolveExternalMcpServers,
  ensureDesktopMcpWarm: config => ensureDesktopMcpWarm(config), atomicWriteJson, process,
});
const { syncMcpServersToClaude, syncAgentCliMcpManifests, syncMcpServersToKimi } =
  require('./backend/cli-mcp-sync.cjs').createCliMcpSync({
    paths, ensureDirs, generateMcpConfig, resolveExternalMcpServers, existsExecutableAsync,
    DesktopShell, getAgentCliHost: () => AGENT_CLI_HOST, atomicWriteJson, logEvent,
  });
const { autoImportClaudeCodeMcp, agentMcpImportSources, kimiMcpManagedIds, classifyAgentMcpCandidate } =
  require('./backend/cli-mcp-import.cjs').createCliMcpImport({
    paths, agentCliHomes, findRuyiPackageRootFor, mutateConfig, logEvent,
  });

const cliDiscoveryProbes = { spawnProbeSync, spawnProbeAsync };
const AgentCliDiscovery = require('./backend/agent-cli-discovery.cjs').createAgentCliDiscovery({
  probes: cliDiscoveryProbes, bundledNodeExe, process,
});
const {
  detectClaudePathUncached, detectClaudePathUncachedAsync, claudeProbeCandidates,
  detectAgentCliPathUncachedAsync, agentCliInstallCandidates, resolveKimiNpmEntry,
  probeAgentCliLauncher, probeAgentCliLauncherVerdictAsync, agentCliProbeVerdict,
  agentCliLauncherOk, agentCliLauncherUsable, invalidateClaudePathCache, invalidateAgentCliPathCaches,
  beginBootCliPathProbes, finishBootCliPathProbes, waitForBootCliPathProbes,
} = AgentCliDiscovery;
function detectClaudePath() { return AgentCliDiscovery.detectClaudePath(); }
function detectAgentCliPath(type) { return AgentCliDiscovery.detectAgentCliPath(type); }

const AGENT_CLI_HOST = Object.freeze({
  detectClaudePath: () => detectClaudePath(),
  detectFromInstallCandidates: type => detectAgentCliPath(type),
  resolveKimiNpmEntry: command => resolveKimiNpmEntry(command),
  bundledNodeExe: () => bundledNodeExe(),
  syncMcpServersToKimi: config => syncMcpServersToKimi(config),
});
function detectKimiPath() { return detectAgentCliPath('kimi'); }
function selectedAgentCli(config) {
  const meta = AGENT_CLI_TYPES[normalizeAgentCliType(config && config.agentCliType)];
  const detected = meta.detectPath(AGENT_CLI_HOST);
  return { ...meta, path: String(config && config[meta.pathKey] || detected || ''), detected };
}
function prepareAgentCliSpawn(type, command, args) {
  const argv = Array.isArray(args) ? args : [];
  return AGENT_CLI_TYPES[normalizeAgentCliType(type)].prepareSpawn(AGENT_CLI_HOST, command, argv);
}

const { decodeClaudeCliText } = require('./backend/text-codecs.cjs');
const { buildClaudeCliEnv, effectiveAnthropicEnv } = require('./backend/claude-cli-env.cjs');

const { getProxyModelsCache, setProxyModelsCache, offlineModelList, modelCapabilityTier, buildModelHint, tierModelForNode, resolveNodeModel, fetchProxyModels, discoverModels } = require('./backend/model-selection.cjs').createModelSelection({
  paths, atomicWriteJson, effectiveAnthropicEnv,
});

const {
  pickPython, pickPythonAsync, probeDesktopPython, probeDesktopPythonAsync, desktopPythonCandidates,
} = require('./backend/desktop-python-selection.cjs').createDesktopPythonSelection({ ProcessRuntime, process });
const DesktopMcpDiscovery = require('./backend/desktop-mcp-discovery.cjs').createDesktopMcpDiscovery({
  appDirectory: __dirname, externalRoot, pickPython, pickPythonAsync, process,
});
const { detectDesktopMcp, detectDesktopMcpAsync, desktopMcpFromInstalledRoot, ensureDesktopMcpWarm } = DesktopMcpDiscovery;
function desktopMcpDetectionPending(config) { return DesktopMcpDiscovery.desktopMcpDetectionPending(config); }

// 走查 W1·F10:script_run 把脚本明文落在 <generated>/scripts/,正常路径执行完立刻删(12 script_run 的 finally);进程被强杀 / 杀毒占着删不掉时
// 会留下孤儿 —— 里面可能有模型嵌进去的密钥。这里按龄兜底:启动时扫一次(13 起服务处调),超过 SCRIPT_FILE_MAX_AGE_MS 没动过的删。
// 脚本最长跑 30 分钟(timeoutMs 上限 1800000),一天的余量足够不碰在跑的。只删 scripts/ 下的普通文件,失败静默(旁路清理)。
// screenshot-*.png 不在此列:聊天里的工具图片卡片经 /api/file/preview 按路径回读它们,清掉会让历史对话里的截图变成裂图。
const SCRIPT_FILE_MAX_AGE_MS = 24 * 3600 * 1000;
async function sweepStaleScriptFiles(nowMs = Date.now()) {
  const dir = path.join(paths.generated, 'scripts');
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = await fsp.lstat(file);
      if (st.isFile() && nowMs - st.mtimeMs > SCRIPT_FILE_MAX_AGE_MS) { await fsp.unlink(file); removed += 1; }
    } catch { /* 并发删除 / 一时被锁:下个进程再扫 */ }
  }
  return removed;
}

// --- Interactive stream-json envelopes (defensive; exact shapes are underdocumented). ---
function buildUserEnvelope(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text || '') }] } };
}
function writeToChild(sessionId, obj) {
  const reg = activeChildren.get(sessionId);
  if (!reg || !reg.child || !reg.child.stdin.writable) return false;
  try {
    if (typeof PrivacyCore !== 'undefined') PrivacyCore.configHooks.assertCliAllowed?.();
    reg.child.stdin.write(JSON.stringify(obj) + '\n', 'utf8'); return true;
  } catch { return false; }
}
// Tools the workbench OWNS the interactive answer for (never intercept tools the CLI runs itself).
function isAskUserTool(name) {
  return typeof name === 'string' && name.replace(/[^a-z]/gi, '').toLowerCase().includes('askuserquestion');
}

const { staticBase, serveStatic } = require('./backend/static-assets.cjs').createStaticAssets({
  externalRoot, publicDirectory: path.join(__dirname, 'public'), pathWithinRoot, requestIsLoopback, runtime: RUNTIME,
});

const HttpAuthorization = require('./backend/http-authorization.cjs').createHttpAuthorization(RUNTIME);
function hostAllowed(...args) { return HttpAuthorization.hostAllowed(...args); }
function isLoopbackAddress(...args) { return HttpAuthorization.isLoopbackAddress(...args); }
function requestIsLoopback(...args) { return HttpAuthorization.requestIsLoopback(...args); }
function isLoopbackBindHost(...args) { return HttpAuthorization.isLoopbackBindHost(...args); }
function originOk(...args) { return HttpAuthorization.originOk(...args); }
function tokenMatches(...args) { return HttpAuthorization.tokenMatches(...args); }
function tokenOk(...args) { return HttpAuthorization.tokenOk(...args); }
function authorizeRoute(...args) { return HttpAuthorization.authorizeRoute(...args); }

// F4 (安全·消毒): accept only a well-formed session id. Returns the id unchanged when it matches the
// canonical shape (letters/digits/_/-, 1..64), else null. Real ids look like `session_<hex>` → pass
// naturally. Callers treat null as a 400. Blocks path-ish / oversized / control-char ids from ever
// reaching loadSession / journal / activeChildren lookups.
// 会话目录里还住着不是会话的 .json:侧栏索引 index.json、内容搜索索引 _search-index-v1.json(13d)。它们的文件名
// 本身形状合法,修前 GET /api/sessions/_search-index-v1 会把搜索索引当成 v1 会话「懒迁移」(头被改写、旁边长出
// 两个正文),DELETE /api/sessions/index 直接 unlink 侧栏索引。所以保留名一律不是会话 id:`index`,以及任何以
// `_` 开头的名字(工作台自己往会话目录里放的旁车文件都用这个前缀,以后新加的也照此起名)。真会话 id 的形状是
// makeId('sess') 的 `sess_<16 hex>`、管家会话的 `steward`,都不受影响。
// 同一张表里还有 Windows 的保留设备名:`CON.json` / `NUL.json` 在 Win32 路径语义下指向设备而不是文件
// (大小写不敏感,所以比对前先转小写 —— `INDEX.json` 在 NTFS 上也就是 index.json)。
const RESERVED_SESSION_FILE_IDS = new Set([
  'index', 'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);
function safeSessionId(raw) {
  const s = String(raw == null ? '' : raw);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) return null;
  if (s.startsWith('_') || RESERVED_SESSION_FILE_IDS.has(s.toLowerCase())) return null;
  return s;
}

// 会话 id 拼成文件名的咽喉点:不合形的 id 在这里就拒掉(抛错),不靠每个调用方记得先 safeSessionId ——
// 修前有几条路由(/api/chat/stream、/api/session/skills、/api/session/memories、工具上下文)直接拿请求体里的
// sessionId 拼路径,`../config` 就读到了 <数据根>/config.json(连同服务商密钥)当会话回显出去。
function assertSessionIdForPath(id) {
  if (safeSessionId(id) === null) throw new Error('invalid session id');
  return String(id);
}
function sessionPath(id) {
  return path.join(paths.sessions, `${assertSessionIdForPath(id)}.json`);
}
// 第25波对抗轮: per-session 写链(见 saveSession)—— 与 agentRunWriteChains 同范式。

// 81-P1: Immutable encrypted credential records; config holds typed references, never vault plaintext.
const { CredentialVault } = require('./backend/credential-vault.cjs');

Object.assign(PrivacyCore.configHooks, CredentialVault.create({
  core: PrivacyCore, protector: LocalSecretCrypto,
  store: DurableJsonStore.create({ id: 'credential-vault-v1', file: () => path.join(paths.data, 'credential-vault-v1.json'), schemaVersion: 1,
    defaultValue: CredentialVault.empty, cache: false, strictRead: true, quarantine: false, validate: CredentialVault.validate }),
  size: async () => { try { return (await fsp.stat(path.join(paths.data, 'credential-vault-v1.json'))).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } },
  stamp: async () => {
    try { const stat = await fsp.stat(path.join(paths.data, 'credential-vault-v1.json'), { bigint: true }); return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`; }
    catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  },
  backups: {
    list: async () => (await fsp.readdir(paths.data)).filter(name => /^config\.json\.(?:prev|corrupt|bak[^/\\]*)$/.test(name)),
    read: async name => {
      const file = path.join(paths.data, name), stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CredentialVault.MAX.bytes) throw new Error('backup unavailable');
      return fsp.readFile(file, 'utf8');
    },
    write: (name, serialized) => atomicWriteJson(path.join(paths.data, name), serialized, { mode: 0o600 }),
  },
}));

// 81-P1: Import appends immutable vault records before a journaled config switch.
// An interrupted switch rolls back config on the next read; old encrypted records remain usable.
const { CredentialRecovery } = require('./backend/credential-recovery.cjs');

const credentialRecoveryJournal = DurableJsonStore.create({
  id: 'credential-import-v1', file: () => path.join(paths.data, 'credential-import-v1.json'), schemaKey: 'version', schemaVersion: 1,
  cache: false, strictRead: true, quarantine: false, defaultValue: () => null,
  validate: value => value.version === 1 && typeof value.instanceId === 'string' && !!value.envelope,
});
Object.assign(PrivacyCore.configHooks, CredentialRecovery.create({
  committed: configEmitWritten, vault: { ...PrivacyCore.configHooks }, normalize: normalizeConfig, readConfig, mutate: mutateConfig,
  busy: () => typeof PrivacyCore.configHooks.isBusy === 'function' && PrivacyCore.configHooks.isBusy(),
  readConfigFile: () => fsp.readFile(paths.config, 'utf8'),
  writeConfigFile: value => atomicWriteJson(paths.config, value, { mode: 0o600 }),
  readJournal: async () => {
    try { const file = path.join(paths.data, 'credential-import-v1.json'), stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('credential_recovery.journal_invalid');
      return credentialRecoveryJournal.read(); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  },
  writeJournal: value => credentialRecoveryJournal.write(value),
  removeJournal: () => fsp.unlink(path.join(paths.data, 'credential-import-v1.json')).catch(error => { if (error.code !== 'ENOENT') throw error; }),
  invalidate: invalidateConfigRecoveryState,
}));

// Explicit module boundary; implementation and tests belong to backend/turn-segments.cjs.
const { createTurnSegmentBuilder } = require('./backend/turn-segments.cjs');

// 02d-session-overrides.js - 架构还债批 3·B: 从 02-session-store.js 搬出的会话级内存覆盖表(引擎路由/权限档/桌面工具的 live-turn stale-save guard;纯搬家,零行为变更)。
const sessionEngineRouteOverrides = new Map(); // live-turn stale-save guard for UI route changes
const sessionEngineRouteScopeOverrides = new Map(); // 与路由同寿命，守住显式“仅此任务”的选择
// 116-2a(27 号文 §3.3/§8.6 线程权限就地快切):会话级权限档的内存权威副本 —— 与上面那张 engineRoute
// 覆盖表同款「live-turn stale-save guard」。值为档名,或 ''(= 用户清除了会话级设置,回落全局)。
// 为什么需要它:活回合手里那份会话内存副本是回合开始时的快照,不带用户刚切的权限档;它的收尾 save
// 会把整个会话头写回「没有该字段」的样子。loadSession / saveSession 两侧都应用这张表,任何顺序下
// 快切都不会被回合的陈旧副本吞掉,也让「点开即换、立即生效」对所有读者(含还没落盘的那一刻)成立。
// 表为空时全部应用点都是零操作 —— 没有设过会话级权限的会话(含全部存量会话)行为逐字节不变。
const sessionPermissionModeOverrides = new Map();
// 会话头 permissionMode 的白名单归一:''/null/非法值一律归成 ''(= 清除会话级设置,回落全局默认)。
function normalizeSessionPermissionMode(value) {
  const mode = value == null ? '' : String(value);
  return PERMISSION_MODES.includes(mode) ? mode : '';
}
// 会话级权限档的读形:合法则返回档名,否则 null(【不】在这里填全局值 —— 见 sessionMeta 的注释)。
function sessionPermissionModeOf(o) {
  const mode = normalizeSessionPermissionMode(o && o.permissionMode);
  return mode || null;
}
// 把内存覆盖表盖到一个会话对象/会话头上(装载时与落盘前各一次)。没有条目就原样返回。
function applySessionPermissionModeOverride(session) {
  const id = session && session.id;
  if (!id || !sessionPermissionModeOverrides.has(id)) return session;
  const mode = sessionPermissionModeOverrides.get(id);
  if (mode) session.permissionMode = mode; else delete session.permissionMode;
  return session;
}
// 117m-A1(用户第六轮走查②;27 号文 §3.3/§8.6):活回合中途改档,闸门要读【此刻】的会话级档,
// 而不是回合开始时的那个快照。修前 10-context-governance 在回合开始时把三层解析成一个不可变快照
// (resolvePermissionMode(request > session > config)),09/08 全程读它 —— 上面 sessionMetaDeferChains
// 的设计注释 ② 自称「permissionMode 先进内存覆盖表…对所有读者立刻是新值」,但 09 的闸门从来没读过
// 这张表,那句话对活回合从未成立。后果是用户在最该收紧/放宽的那几分钟里改档等于没改(放宽只是费
// token,反过来「想临时收紧」失效则是安全问题)。
// 本函数【只读】,不碰延后落盘那条链;档位仍然只有 PATCH 一个写口。
// '' = 用户清了会话级设置(回落全局),此时返回 null 让调用方继续用它自己的解析结果 —— 中途「清除」
// 要到下一个回合才生效。这是有意的保守取舍:清除是回落全局,方向不定,不在活回合里替用户猜。
function liveSessionPermissionMode(id) {
  const mode = sessionPermissionModeOverrides.get(String(id || ''));
  return mode ? mode : null;
}

// ── 117z-E2 提交①(27 号文 §11.21.3):会话级【桌面工具】覆盖 ───────────────────────────────
// 修前 `allowDesktopTools` 是【全局唯一】的一把闸(07-autonomy:99),在 buildOpenAiTools 的注册层
// 决定桌面工具要不要提供给模型;没有任何会话级覆盖。本波加的是【另一把钥匙】,不动那把全局闸:
//   · session.desktopTools === true   -> 这条线程拿得到桌面工具(与全局值无关);
//   · session.desktopTools === false  -> 这条线程拿不到(与全局值无关);
//   · 缺席 / null                     -> 跟随全局 allowDesktopTools(= 全部存量会话的行为逐字节不变)。
// 三态而不是布尔:两态分不出「这条线程自己定了」与「跟着全局走」,与 permissionMode 的 chip 同一条
// 理由(见 sessionMeta 里那段注释)。
function normalizeSessionDesktopTools(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;   // null/''/缺席/任何野值 -> 跟随全局(fail-open 到【修前行为】,不是 fail-open 到放行)
}
// 读形:true / false / null(null = 没设过会话级覆盖)。
function sessionDesktopToolsOf(o) {
  return normalizeSessionDesktopTools(o && o.desktopTools);
}
// 与 sessionPermissionModeOverrides 同款「live-turn stale-save guard」:活回合手里那份会话内存副本是
// 回合开始时的快照,不带刚写下的覆盖值;它的收尾 save 会把整个会话头写回「没有该字段」的样子。
// loadSession / saveSession 两侧都盖一次,任何顺序下这次改动都不会被回合的陈旧副本吞掉。
// 表为空时全部应用点都是零操作 —— 没设过会话级桌面覆盖的会话(含全部存量会话)行为逐字节不变。
const sessionDesktopToolsOverrides = new Map();   // id -> true | false | null(null = 清除,回落全局)
function applySessionDesktopToolsOverride(session) {
  const id = session && session.id;
  if (!id || !sessionDesktopToolsOverrides.has(id)) return session;
  const value = sessionDesktopToolsOverrides.get(id);
  if (value === null) delete session.desktopTools; else session.desktopTools = value;
  return session;
}

const {
  normalizeSessionEngineRoute, sessionEngineRouteFromConfig, inferSessionEngineRoute, configForSessionEngineRoute,
  createSessionRoutePreferences,
} = require('./backend/session-engine-route.cjs');

const { unprefixedBridgedName, unwrapToolInvokeCall, toolInvokeEnvelopeRepair, normalizeToolInvokeArgs } = require('./backend/turn-effect-kinds.cjs');

// Prepare once at the final host dispatch boundary. Reject values whose implicit JSON conversion
// could change approved data; copy property descriptors without invoking getters or toJSON hooks.
// The returned bytes, decoded-value fingerprint and frozen outgoing object describe the same JSON.
function prepareDesktopExecutionArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('tool arguments must be a JSON object');
  const snapshot = copyOrdinaryJsonData(value);
  const semanticSha256 = executionArgumentsDigest(snapshot);
  const json = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > 8 * 1024 * 1024) throw new Error('execution argument snapshot exceeds capacity');
  return Object.freeze(Object.assign(Object.create(null), { snapshot, json, bytes, sha256: crypto.createHash('sha256').update(json, 'utf8').digest('hex'),
    codec: 'javascript-json-utf8-v1', semanticSha256, semanticCodec: 'ruyi-sdk-json-v1' }));
}

// Root-owned execution preparation/result ledger; this factory itself performs no MCP/native IO.
// The default-off root/provider candidate supplies actual OS ownership and live turn assertions.
// The state file holds identity fields, digests and flags. Explicit delivery snapshots are private, bounded,
// immutable files containing the actual projected consumer history, not raw ACC results.
const DesktopExecutionLedger = require('./backend/desktop-execution-ledger.cjs').createDesktopExecutionLedger({
  storage: { DurableJsonStore, runKeyedChain },
  execution: { nowIso, prepareDesktopExecutionArguments, process },
});

// Explicit authority service: grants and driver bindings stay private and ephemeral.
const { grantIssueTierInfo, resolveToolPermissionContext, normalizeGrant, consumeGrant, revokeGrant, revokeAllGrants, revokeGrantsForRun, bindDriverRun, listGrantsView, dryRunGrantFiles, installGrant, activeDriverRunOf, endDriverRun } = require('./backend/autonomy-grants.cjs').createAutonomyGrants({
  hashArgs, makeId, isSensitiveDataPath, logEvent,
});

// ===== v1.9 会话存储 v2(head JSON + append-only NDJSON 正文)=====================================
// 背景:旧格式把整个 messages+providerHistory 塞进单个 <id>.json,saveSession 每轮全量序列化+原子重写
// —— 写放大 O(会话总历史)/轮:5MB 会话 = 每轮重写 5MB。v2 拆分为:
//   <id>.json              「头」:全部标量/小字段 + messageCount/providerHistoryCount + storageVersion:2(小,每次重写)
//   <id>.messages.ndjson   展示消息正文,一行一条 JSON,append-only
//   <id>.provider.ndjson   provider 引擎历史正文,同上
// 快路径(saveSession):两个数组只在尾部增长 → 每文件一次 append,O(增量)/轮。
// 慢路径(全量重写正文):任何前缀变化自动触发 —— rewind(slice)/compaction(reseed)/pop/蒸发改写。
// 检测机制【不靠调用方自觉打标记】:进程内状态表记着盘上每一行(行原文;内存预算不够时退成每行 sha1-16),
// save 时把前缀逐条重新序列化、逐行比对;任何对不上(含未来新代码忘了声明的中间改写)都安全降级为全量重写
// —— 失配只可能损失性能,不可能丢数据。(perf:比对用的是行原文,见 sessionBodyState 头注。)
// 崩溃语义:头是提交点(正文先写、头后写)。append 崩溃中途 → 无 \n 终结的撕裂尾行,读取时物理截断;
// append 完成但头写未完成 → 正文比头声明的多出「未提交尾巴」,读取时按头计数截断;慢路径(全量重写)
// 崩溃 → .prevbody 快照(重写前旧正文)恢复与旧头重新配对;正文比头声明的短 / 中间行损坏且无快照可退
// = 真损坏 → v1bak 回退(迁移期)或隔离为 .corrupt(与旧单文件损坏同纪律)。
// 迁移:legacy <id>.json 首次 load 时原样备份 <id>.json.v1bak 再落 v2;v2 下次成功读取后自动删 v1bak。
const SESSION_STORAGE_VERSION = 2;
// 架构还债批 3·B: 会话级内存覆盖表(sessionEngineRouteOverrides/权限档/桌面工具)与其归一、应用函数抽至 02d-session-overrides.js。

function sessionBodyPaths(id) {
  assertSessionIdForPath(id);
  return {
    messages: path.join(paths.sessions, `${id}.messages.ndjson`),
    provider: path.join(paths.sessions, `${id}.provider.ndjson`),
  };
}

const { createSessionNotes, extractSessionNotes, renderSessionNotesMarkdown, parseSessionNotesMarkdown,
  mergeSessionNotes, buildSessionNotesInjectPrompt } = require('./backend/session-notes.cjs');
const { sessionNotesPath, readSessionNotes, writeSessionNotes, removeSessionNotes, maybeWriteSessionNotes } =
  createSessionNotes({ paths, assertSessionIdForPath, atomicWriteJson, sessionObjectIsStale, sessionSaveIsTombstoned, logEvent });

const {
  createSessionScratchpad, SESSION_SCRATCHPAD_LIMITS, normalizeScratchpadKey, normalizeScratchpadText, scratchpadTotalChars,
} = require('./backend/session-scratchpad.cjs');
const { sessionScratchpadPath, scratchpadWriteInFlight, readSessionScratchpad, updateSessionScratchpad } = createSessionScratchpad({
  paths, assertSessionIdForPath, DurableJsonStore, logEvent, sessionSaveIsTombstoned, nowIso,
});

// ── 第71波 EC-E 切片二:未决事项 Intervention 持久化(append-only NDJSON)──────────────────────────
// permission/question/plan 三类未决事项此前是纯内存 Map(04-permission-runtime:191/194/199),进程重启即消失
// -- 无审计、无终态化,/api/missions 的 missionPendingCounts(13d:59)前三类读空 Map 归零,与前端 stale 卡片
// 不一致。本波把它们旁路持久化为 Intervention 记录:注册时 append 一行(pending),决策/超时/清理时 append 一行
// (终态),读时按 id 后写胜折叠。**不参与 promise resolve 链** -- 超时自动拒绝、权限默认不放宽语义完全不动,
// Intervention 只是审计/读模型/重启终态化的旁路记录(执行权威源仍是内存 Map)。
// 第71b波:task-pool proposed 统一进来(第四类 type:'pool')——提案注册/审批/拒绝/过期全部旁路记账,
// missionPendingCounts 四源统一从本店读;pool 与前三类的重启语义不同(提案随 run 快照存活,paused run
// 恢复后仍可审批),故 markInterruptedInterventions 对 pool 型按 run 状态分流(见下),不一刀切 cancelled_restart。
//
// 崩溃语义:同 messages.ndjson -- append 永远「整行 + 尾随 \n」一次写,撕裂尾行(无 \n 终结)读取时 JSON.parse
// 失败被跳过(append-only,丢一条审计记录不致命:执行语义走内存 Map,读模型少一条不阻断)。后写胜折叠保证
// 同一 ivId 的多条记录(request -> settle -> cancel_restart)取最后一条为权威终态。
// 107-F7b(撤回被陈旧快照盖回):会话的【撤回代数】高水位 —— 与上面 missionChangeSeqHighWater 同一个模具,
// 被护住的是正文而不是账本计数。症状:用户递话后立刻点「撤回」,撤回回 ok:true,消息却还在。取证(红轮
// 日志):撤回那一存无条件写 providerHistoryCursor=0,盘上却是 2 —— 撤回那一存被一个【撤回之前就攥在手里】
// 的会话对象整份盖回了。这类写者不止垂死回合一个(回合 settle 之后才动手的 updateSessionMeta 读改写、
// 收工补写 threadBrief、手动压缩等等都能恰好把 load 落在撤回之前、把 save 落在撤回之后),69 波那道
// 「自动停回合 + 等 settle」的闸只管得住垂死回合自己。
// 机制:会话头上一个单调整数 rewindGen(缺省视为 0);撤回那一存在【入写链的同一拍】把自己那份对象的
// rewindGen 加一,并抬高本表。saveSession 在写链里、真正落盘之前比对:对象的
// rewindGen 低于高水位 = 这是撤回之前的快照 = 整次写丢弃(正文与头都不写),落 session_stale_save_dropped。
// 只在进程内:重启后表为空,所有对象都从盘上新读(loadSession 每次都 JSON.parse 新解析,没有对象缓存),
// 不会误丢。loadSession 另有一道自愈:读到的代数低于高水位 = 这次读恰好落在「代数已抬、撤回那一存还没
// 落盘」的窗口里 → 等写链跑完再读一次,所以撤回【之后】才读的人永远拿到撤回之后的状态。
const sessionRewindGenHighWater = new Map();
// 第79波:changeSeq 不再只有一个计数器。每次事实推进同时写一条 append-only change record，
// 让回来摘要可以严格消费 (lastSeenRevision,currentRevision]，并保留可追溯的原始 source cursor。
// 老任务可能已有 changeSeq、却没有本流水：首条记录的前缀被视为 migration baseline；前端首读
// 从当前 revision 建基线。若已读游标落在 baseline 之前、或流水内部/尾部缺号，则显式 degraded。
const MissionChanges = require('./backend/mission-changes.cjs').createMissionChanges({
  paths, sessionPath, sessionWriteChains, readFileTail, atomicWriteJson, nowIso,
  sessionMissionId: session => sessionMissionId(session),
  invalidateReads: id => SessionPersistence.invalidateReads(id), events: RUYI_EVENTS,
});
const { missionChangeFilePath, boundedChangeText, normalizeMissionChangePayload, repairMissionChangeTornTail, appendMissionChangeRecord, foldMissionChangeJournalText, readMissionChangesWithMeta, bumpMissionChangeSeq, missionSignalThrottleAllow, recordMissionStalledChange, recordMissionBudgetTrippedChange, MISSION_CHANGE_TYPES, MISSION_STALL_SIGNAL_WINDOW_MS } = MissionChanges;
function agentRunDir(sessionId) { return path.join(paths.agentRuns, safeSessionId(sessionId)); }
function agentRunFile(sessionId, runId) { return path.join(agentRunDir(sessionId), `${safeSessionId(runId)}.json`); }

const AgentRunStore = require('./backend/agent-run-store.cjs').createAgentRunStore({
  files: { agentRunDir, agentRunFile, atomicWriteJson, readFileTail },
  lifecycle: { sessionAssociatedSaveIsTombstoned, hasLiveRun: id => activeAgentRuns.has(id), getLiveRun: id => activeAgentRuns.get(id) },
  signals: { missionSignalThrottleAllow, MISSION_STALL_SIGNAL_WINDOW_MS, emit: (...args) => RUYI_EVENTS.emit(...args), logEvent },
  safeSessionId, safeJsonParse, nowIso,
});
const {
  agentRunEventsFile, syncRunEventSeq, appendAgentRunEvent, flushAgentRunEvents,
  recordRunStalledEvent, recordRunBudgetTrippedEvent, parseEventWindow, readAgentRunEvents,
  bumpRunIntervention, classifyNodeErrorText, accumulateRunUsage, agentRunHealth, agentRunHealthChanged,
  saveAgentRun, listAgentRuns, agentRunDigestShadow, listAgentRunDigests, agentRunDigestRow,
} = AgentRunStore;

const { interventionFilePath, dropInterventionSessionState, appendIntervention, registerIntervention, settleIntervention, foldInterventionJournalText, readInterventionsWithMeta, readInterventions, interventionJournalWorthCompacting, compactInterventionJournal, markInterruptedInterventions, transitionInterventionState, INTERVENTION_TERMINAL } = require('./backend/intervention-journal.cjs').createInterventionJournal({
  paths, nowIso, atomicWriteJson, events: RUYI_EVENTS, listAgentRuns,
  repairTornTail: repairMissionChangeTornTail, recordChange: bumpMissionChangeSeq, logEvent,
});
// ── perf(会话正文逐行 sha1 的去重):进程内确定性计数器 ───────────────────────────────────────────────────
// perfCounters.sessionBody(unit/session-body-line-cache 读):只数「做了多少活」,不计时,断言不受机器快慢影响。
//   lineHashes           单行 sha1 算了几次。修前:每次装载 = 两个正文的总行数,每次保存 = 两个数组的总条数(外加
//                        严格前缀判定那一遍);现在只在行原文被挤出内存预算、退成 hash 时才算(见 sessionBodyState 头注)。
//   bodyReads            正文文件读了几次(messages / provider 各算一次)。
//   providerBodySkips    增量取的装载有几次证明了 provider 正文没变、没去读它(loadSession 的 omitProviderHistory 视图)。
//   deltaStampFromBytes  增量取的前缀戳有几次是直接对盘上字节算的(不逐条 JSON.stringify)。
//   deltaStampSerialized 同上,逐条序列化算的(修前的算法;字节路径的前提不成立时仍走它)。
const SessionBodies = require('./backend/session-bodies.cjs').createSessionBodies({
  isWriting: id => sessionWriteChains.has(id), logEvent,
});
const { sessionMessagesStamp, sessionMessagesDelta, sessionBodyRecord, setSessionBodyState, dropSessionBodyState, sessionBodyRecordFromRead, sessionBodyDanglingFromLines, readSessionBodyFile, planSessionBodyAppend, serializeSessionBody, sessionBodyText, sessionBodyDigest, sessionBodyCommitValid, sessionBodiesMatchCommit, rebaseStaleSessionBody, sessionBodyPerfStats, SESSION_BODY_READ_TRANSIENT, SESSION_HEAD_READ_RETRIES, danglingTurnState, getSessionBodyState } = SessionBodies;


// ===== PF2: session metadata index (sessions/index.json) =====================================================
// listSessions used to JSON.parse EVERY session file in full just to show 7 sidebar fields, and saveSession
// rewrote each session whole; both costs grow with session count/size. We keep a lightweight index of just
// those 7 fields, incrementally maintained by saveSession/deleteSession. CRITICAL SAFETY INVARIANT: the index
// is ONLY a cache; each per-session JSON file remains the single source of truth. listSessions trusts the
// index only when its id-set EXACTLY matches the session files on disk; on any mismatch/missing/corrupt index
// it falls back to scanning the real files (and rebuilds the index). On any index write failure we DELETE the
// index so the next read rebuilds from truth. Sessions are single-writer (the serve process only; the MCP
// child never writes session files), so a process-global write lock is enough to serialize index mutations.

// 第70波(EC-E):会话类型显式标识 —— 'quick_ask'(纯问答,默认) | 'mission'(任务会话,mission start 时显式翻转,
// 非启发式文本猜测)。旧会话(第70波前落盘)无 kind 字段:有 mission 派生 'mission',否则 'quick_ask'。
// 迁移契约:只读派生,绝不把派生结果回写磁盘(无破坏性批量改写)。
const { sessionRecentUserRequest, sessionKind, sessionMissionId, SESSION_BRIEF_TITLE_CHARS, SESSION_BRIEF_GIST_CHARS, applySessionTitleOverride, sessionDisplayTitle, sessionMeta, sessionBriefOf, sessionMetaIsSteward, sortSessionMetas, isUntitledSessionTitle, getSessionTitleOverride, setSessionTitleOverride, dropSessionTitleOverride } = require('./backend/session-metadata.cjs').createSessionMetadata({
  safeSessionId, sessionPermissionModeOf, resolvePermissionMode,
  isLive: id => activeChildren.has(id) || turnSettlers.has(id) || SessionMetaUpdates.hasPending(id),
  rewindGeneration: id => sessionRewindGenHighWater.get(id) || 0,
});

// Read the index array, or null when missing/corrupt/not-an-array (caller falls back to a full scan).
const { readSessionIndex, invalidateSessionIndex, setSessionIndexRebuildScanHookForTest, scheduleSessionIndexUpdate, flushSessionIndex, overlayUnflushedSessionIndex, flushSessionIndexSync, listSessions, SESSION_INDEX_FILE, SESSION_TOMBSTONE, sessionIndexPath } = require('./backend/session-index.cjs').createSessionIndex({
  paths, safeJsonParse, atomicWriteJson, noteSessionsDirOwnWrite, safeSessionId, ensureDirs, sessionMeta, sessionMetaIsSteward, sortSessionMetas,
});

// 计划条(session.todos)的指纹:管家「没做完就续」只认【这一回合里动过的】计划(13p stewardContinueUnfinishedGate)——
// 回合开头记一笔、收尾写进 stewardLastTurn.todosStartSig,与收尾时的现值不同才算这一回合在推进这份计划。
// 早就搁下、用户已经换了话题的旧计划不该让每个新回合都被当成「没做完」。
const { rememberLastUsedEngineRoute, newSessionEngineRoute } = createSessionRoutePreferences({ mutateConfig, selectedAgentCli, logEvent });

const SessionMetaUpdates = require('./backend/session-meta-updates.cjs').createSessionMetaUpdates({
  safeSessionId, logEvent: (...args) => logEvent(...args), RUYI_EVENTS,
  metadata: { setSessionTitleOverride, SESSION_BRIEF_TITLE_CHARS, SESSION_BRIEF_GIST_CHARS },
  overrides: { normalizeSessionEngineRoute, sessionEngineRouteOverrides, sessionEngineRouteScopeOverrides, rememberLastUsedEngineRoute, normalizeSessionPermissionMode, sessionPermissionModeOverrides, normalizeSessionDesktopTools, sessionDesktopToolsOverrides },
  sessions: { withSessionMutateLock: (...args) => withSessionMutateLock(...args), loadSession: (...args) => loadSession(...args), saveSession: (...args) => saveSession(...args) },
  lifecycle: { activeChildren, turnSettlers },
});
const { sessionTodosSignature, updateSessionMeta } = SessionMetaUpdates;

// v0.8-S0: fold an older/partial session onto the current schema. Mirrors normalizeConfig's shape:
// returns { session, changed }. Backfills schemaVersion + turnSeq and guarantees the array fields so
// no downstream code has to defend against missing/typo'd properties.
const { normalizeSession, normalizeMetaToolArgs, normalizeTodoItems, normalizeMissionCheck, recordMissionCheckResult, normalizeMission, applyMissionUpdate, missionProgressDigest, missionContainerAcceptanceStamp, buildMissionAcceptanceProjection, foldTurnSummaries, followupAcceptanceCriterion, MISSION_MAX_MILESTONES, MISSION_MAX_TEXT, MISSION_DEFAULT_MAX_TURNS, MISSION_STALL_LIMIT } = require('./backend/session-model.cjs').createSessionModel({ SESSION_SCHEMA, SKILL_ID_RE, MEMORY_FIXED_SELECTION_HARD_MAX, inferSessionEngineRoute, nowIso });

const {
  buildMissionResult, archiveMissionResult, maybeFinalizeMission,
  finalizeMissionAfterTurn, mergeMissionBeforeSave, evaluateMissionCheck,
} = require('./backend/mission-lifecycle.cjs').createMissionLifecycle({
  journalReadIndex: (...args) => journalReadIndex(...args), foldTurnSummaries, applyMissionUpdate, nowIso,
  runProcess: DesktopShell.runProcess,
});

const { stopMissionAgentRuns, cancelModelRunsOfDiscardedTurns } =
  require('./backend/session-run-cancellation.cjs').createSessionRunCancellation({
    activeAgentRuns, bumpRunIntervention, appendAgentRunEvent, saveAgentRun, logEvent,
  });

// 110-3b: createTurnSegmentBuilder 回合分段构建器抽至 02c-turn-segments.js。

// v0.8-S3/S4a: derive a turn_summary from the turn's tool records + checkpoint journal. Both engines call
// this with their own toolCalls array (provider: {name,input,result}; claude: {name,input,result} where
// result is the raw MCP text) AND this turn's journal entries (index rows for this turnSeq). DATA SOURCE:
//  - journal entries (S4a) are the authoritative source for file changes: merged into filesChanged by
//    path, their `op` (create/modify/delete) is used (more accurate than the tool record's guess), and
//    they are `revertible:true` (skipped:true entries stay revertible:false — no `before` was stored);
//  - tool records supply files NOT covered by the journal (e.g. CLI-native tools) at revertible:false,
//    and the command count. When a path appears in BOTH, the journal entry wins.
//  Rules:
//  - file_write → op create/modify; file_edit → modify; file_delete → delete; path=input.path
//  - powershell_run/script_run/shell_send (and, for the claude engine, any non-workbench-file tool) → commands+1
//  - artifacts is always [] (field established for C4/v0.9).
const { kindForPath, projectBridgedIrreversible, buildTurnSummary } = require('./backend/turn-summary.cjs');

const ProviderHistory = require('./backend/provider-history.cjs').createProviderHistory({ logEvent });
function repairProviderHistoryPairing(...args) { return ProviderHistory.repairProviderHistoryPairing(...args); }
function isProviderToolArgsObject(...args) { return ProviderHistory.isProviderToolArgsObject(...args); }
function providerHistoryToolCalls(...args) { return ProviderHistory.providerHistoryToolCalls(...args); }
function repairProviderHistoryToolArgs(...args) { return ProviderHistory.repairProviderHistoryToolArgs(...args); }
function appendDisplayMessagesToProviderHistory(...args) { return ProviderHistory.appendDisplayMessagesToProviderHistory(...args); }
function syncProviderHistoryFromDisplay(...args) { return ProviderHistory.syncProviderHistoryFromDisplay(...args); }

// Returns the normalized session, or null when the file is missing/unreadable. A file that exists but
// fails to parse is renamed to <id>.json.corrupt (isolated, not deleted) so a truncated write can't
// keep 500-ing every read; callers treat null as "not found".
// v1.9 存储 v2:头(storageVersion:2)从两个 NDJSON 正文装配 messages/providerHistory;正文缺失/坏 →
// v1bak 回退(迁移备份),无 v1bak 才按损坏隔离。legacy 单文件首次加载后打非枚举 __v1bakPending 标记,
// 由 saveSession 完成「先备份 v1bak、再落 v2」的懒迁移(对调用方完全透明)。
const { detectDanglingTurn, healStalePendingSegments } =
  require('./backend/session-recovery.cjs').createSessionRecovery({
    danglingTurnState, sessionOmittedProviderHistory: session => sessionOmittedProviderHistory(session),
    pendingPermissions, pendingPlans, pendingQuestions,
  });

const SessionPersistence = require('./backend/session-persistence.cjs').createSessionPersistence({
  files: { sessionPath, sessionBodyPaths, ensureDirs, atomicWriteJson: (...args) => atomicWriteJson(...args) },
  model: { normalizeSession, healStalePendingSegments, mergeMissionBeforeSave },
  coordination: { sessionWriteChains, sessionRewindGenHighWater }, missionChanges: MissionChanges,
  bodies: SessionBodies,
  lifecycle: {
    isActive: id => activeChildren.has(id) || turnSettlers.has(id),
    protectedHistoryEnabled: () => DesktopExecutionHooks.enabled(),
    ownsExecution: (id, owner) => typeof SessionExecutionHooks.owns === 'function' && SessionExecutionHooks.owns(id, owner),
    isTombstoned: sessionSaveIsTombstoned,
    mergeBackgroundJobs: session => { if (EventStreamHooks.mergeBackgroundJobs) EventStreamHooks.mergeBackgroundJobs(session); },
  },
  metadata: {
    sessionMeta, sessionRecentUserRequest, scheduleIndexUpdate: scheduleSessionIndexUpdate,
    applyOverrides: session => { applySessionTitleOverride(session); applySessionPermissionModeOverride(session); applySessionDesktopToolsOverride(session); },
    applyRouteOverride: session => {
      const id = session.id, route = sessionEngineRouteOverrides.get(id);
      if (route) session.engineRoute = { ...route };
      if (sessionEngineRouteScopeOverrides.has(id)) {
        if (sessionEngineRouteScopeOverrides.get(id) === 'thread') session.engineRouteScope = 'thread';
        else delete session.engineRouteScope;
      }
    },
  },
  events: RUYI_EVENTS, safeSessionId, safeJsonParse, nowIso, logEvent, storageVersion: SESSION_STORAGE_VERSION,
});
const { sessionOmittedProviderHistory, sessionProviderHistoryLength, SESSION_LOAD_OMIT_PROVIDER, readSessionRouteHead } = SessionPersistence;
// Legacy host adapters disappear with the HTTP/engine composition migration.
async function loadSession(...args) { return SessionPersistence.loadSession(...args); }
async function saveSession(...args) { return SessionPersistence.saveSession(...args); }
async function readSessionHeadResilient(...args) { return SessionPersistence.readSessionHeadResilient(...args); }

// ── 回合收尾那一存(三个引擎共用):带回合代数闸 ──────────────────────────────────────────────────────
// 现象(审计 t4):回合 1 卡在不理会中止的工具里,用户在同一会话发回合 2,回合 2 跑完;回合 1 的工具稍后返回,
// 收尾那一存拿着回合 1 起跑时的旧对象把整份正文写回去 —— 回合 2 的 user/assistant 消息与 providerHistory 全没了。
// 这里用 saveSession 的 throwIfTurnSuperseded:盘上的 turnSeq 比这份对象大就不写。返回 true = 已落盘;
// false = 本回合已被更新的回合顶替,收尾存被丢弃 —— 调用方据此不再派 thread.done / 任务进度(否则把一个
// 过期回合当成「最新一回合结束」广播出去)。一次普通的停止(没有更新的回合)turnSeq 相等,照常落盘。
const { saveTurnFinalSession, withSessionMutateLock, mutateSession } = require('./backend/session-transactions.cjs').createSessionTransactions({
  loadSession, saveSession, logEvent,
});

// 一份内存里的会话对象是不是撤回之前读出来的(驱动器、旁车写入用它判「还该不该接着干」)。
function sessionObjectIsStale(session) {
  if (!session || !session.id) return false;
  return (Number(session.rewindGen) || 0) < (sessionRewindGenHighWater.get(session.id) || 0);
}

// 50-fix(标题卡死):未命名标题判定 —— 后端占位 'New session' 与历史前端本地化占位('新会话'/'New chat')
// 均视为未命名,两引擎回合结束据此自动命名(历史会话下一轮补名)。
const createSession = require('./backend/session-creation.cjs').createSessionService({
  SESSION_SCHEMA, makeId, clearDeletedSession, readConfig, nowIso, newSessionEngineRoute,
  isUntitledSessionTitle, normalizeSession, saveSession, RUYI_EVENTS,
});

// ============================================================================
// v0.8-S4a — Checkpoint journal (信任层核心). Layout under dataRoot/checkpoints/<sessionId>/:
//   index.json                 [{turnSeq, entrySeq, tool, path, op:'create'|'modify'|'delete', bytes, skipped?, ts}]
//   <turnSeq>-<entrySeq>.gz    zlib.gzipSync(before content) — op:'create' has NO .gz (before never existed)
//   history-<turnSeq>.json.gz  (S5 providerHistory snapshot — only the directory convention is reserved here)
//
// DUAL-PROCESS INVARIANT: the journal is FILESYSTEM-LEVEL shared state. Both engines write the SAME
// dataRoot/checkpoints dir — the provider engine's toolCall() runs in the serve process; the Claude
// engine's workbench tools run in the one-shot MCP child. This is race-free by construction: within one
// session, only ONE engine runs a turn at any instant, so there is never concurrent writing to a given
// session's checkpoints dir. The MCP child must NOT write session files (S3 invariant) but CAN write the
// checkpoints dir (independent of session files → no contention with the serve process's saveSession).
//
// SAFETY-NET, NOT A GATE: any journal failure is swallowed (try/catch) and MUST NOT block tool execution.
// A journal write that throws simply skips its index entry; the tool runs regardless. The trade-off is
// deliberate — a checkpoint is a safety net, and a broken safety net must never stop the user's work.
// ============================================================================
async function checkpointRollbackContext(sessionId) {
  let guardSession = null, guardConfig = null;
  try { guardSession = await loadSession(sessionId); } catch { guardSession = null; }
  try { guardConfig = await readConfig(); } catch { guardConfig = {}; }
  return {
    session: guardSession, config: guardConfig,
    effectivePermissionMode: resolvePermissionMode({ session: guardSession, config: guardConfig }),
  };
}
const { journalRevertLogRead, JOURNAL_KEEP_TURNS, JOURNAL_MAX_BEFORE_BYTES, journalGcProbe, journalBytesAdjust, withJournalWriteLock, journalDir, journalReadIndex, journalResolveTurnSeq, journalRecord, journalRecordMany, workspaceBaselinePathKey, workspaceBaselineIsCodePath, captureWorkspaceTurnBaseline, reconcileWorkspaceTurnBaseline, journalDropEntries, journalGc, journalRollback, journalRevertLogRecord, journalRevertNoticesPeek, journalRevertNoticesAck, journalRevertLogPrune } = require('./backend/checkpoint-journal.cjs').createCheckpointJournal({
  paths, assertSessionIdForPath, atomicWriteJson, gitReadOnlyGuard, logEvent, nowIso, pathWithinRoot, runGit,
  safeJsonParse, sessionPath, getRollbackContext: checkpointRollbackContext, isSessionActive: id => activeChildren.has(id),
  guardFileToolPath: (...args) => guardFileToolPath(...args),
  realpathForContainment: (...args) => realpathForContainment(...args),
});

const { fileToolWorkspaceDir, resolveFileToolRoot, resolveFileToolPath } = require('./backend/file-tool-paths.cjs').createFileToolPaths({
  loadSession, readConfig, normalizeCwd, getMcpSessionId: () => process.env.WCW_SESSION_ID || '',
});
const preflightWriteBoundary = require('./backend/file-write-preflight.cjs').createWriteBoundaryPreflight({
  resolveFileToolPath, guardFileToolPath: (...args) => guardFileToolPath(...args),
});

let journalBridgedWrite = require('./backend/bridged-write-journal.cjs').createBridgedWriteJournal({
  journalSessionCtx, guardWorkspacePath: (...args) => guardWorkspacePath(...args), journalRecord,
});
const { writeHistorySnapshot, rehydrateObservation } = require('./backend/history-snapshot-store.cjs').createHistorySnapshotStore({
  journalDir, journalBytesAdjust, withJournalWriteLock, journalGc,
});
const materializeCheckpointEditorDiff = require('./backend/checkpoint-editor-diff.cjs').createCheckpointEditorDiff({ journalDir });

// v0.8-S4b B2 — conversation REWIND (Claude Code-style "back up to just before this message"). Truncates
// the session to the state right BEFORE `targetTurnSeq` began: removes that turn's user message and
// everything after it, returns the removed user text so the front-end can refill the composer (话还在输入
// 框里可改可重发), and OPTIONALLY rolls back the files of every discarded turn.
//
// Key决策 (locked in this slice):
//  - providerHistory is CLEARED to [] — NOT surgically truncated. The provider engine's lazy-reseed
//    (runOpenAiTurn, seeds from session.messages when providerHistory is empty) rebuilds the user/assistant
//    text context on the very next turn. Simple and ALWAYS correct (including after a compaction, where a
//    surgical truncation of the summarized history would be meaningless). The trade-off is losing the tool
//    trace from prior turns; the reseed carries text only. Documented here.
//  - session.turnSeq is NOT rewound — monotonicity is the journal's primary key; a new turn after a rewind
//    keeps incrementing (never reuses a discarded seq).
//  - session.todos is KEPT — rewinding the CONVERSATION is not abandoning the TASK LIST.
//  - claudeSessionId is nulled — the CLI's --resume context no longer matches the truncated history, so a
//    stale resume would splice removed context back in.
// Returns {ok, removedTurns, lastUserText, filesReverted:[], filesFailed:[]} (or {ok:false,error} when a
// turn is live or the target can't be located; 107-F7b: error 'rewind_superseded' when a newer rewind of the
// same session landed first and this one's truncation was dropped by the rewind-generation gate).
// A guarded rewind owns admission until stopping, settlement, file rollback and persistence all finish.
// This is process-local coordination, never a durable session field or a reusable authorization.
const SessionRewind = require('./backend/session-rewind.cjs').createSessionRewind({
  execution: SessionExecutionHooks, state: { activeChildren, turnSettlers },
  storage: { loadSession, saveSession, bumpMissionChangeSeq },
  checkpoints: { rollback: journalRollback, prune: journalRevertLogPrune },
  effects: {
    cancelModelRunsOfDiscardedTurns,
    forgetBackgroundJobs: (...args) => EventStreamHooks.forgetBackgroundJobs?.(...args),
    onSessionRewound: (...args) => EventStreamHooks.onSessionRewound?.(...args),
  },
  events: RUYI_EVENTS, logEvent,
});
const { rewindSession } = SessionRewind;
SessionExecutionHooks.admissionBlocked = SessionRewind.admissionBlocked;

// Resolve the journal {sessionId, turnSeq} for a file-mutating toolCall. Priority:
//  - ctx (provider loop passes its live session.id + session.turnSeq) → authoritative;
//  - else the MCP child reads WCW_SESSION_ID env + the session file's turnSeq (read-only, no race).
// Returns {sessionId, turnSeq} where either may be falsy/null → journalRecord then no-ops gracefully.
async function journalSessionCtx(ctx) {
  if (ctx && ctx.sessionId && Number.isFinite(ctx.turnSeq)) return { sessionId: ctx.sessionId, turnSeq: Number(ctx.turnSeq) };
  const sessionId = (ctx && ctx.sessionId) || process.env.WCW_SESSION_ID || '';
  const turnSeq = await journalResolveTurnSeq(sessionId, ctx && ctx.turnSeq);
  return { sessionId, turnSeq };
}

// ============================================================================
// 第 116 波 116g(27 号文 §3.1「事项跨会话升格」):事项(Mission)容器。
//
// 为什么要有这一层:`sessionMeta.missionId` 从 75a 起就在会话头里了,但它一直只是「= sessionId」的
// 稳定主键 —— 一个事项永远只有一条线程。116g 把 mission 升格成【跨会话容器】:一个事项可以有多条
// 线程(会话),线程可以加入/移出事项,事项可以合并与拆分。
//
// 三条边界(改这段前先读):
//   ① **事项级字段的唯一归属在事项文件**。`goal` / `acceptance` / `budget` 只存在 `<data>/missions/
//      <missionId>.json` 里。会话头里那个 `head.mission`(第26波b 的【会话内任务账本】:目标、里程碑、
//      until-done 预算、停滞标记、结果章)**一个字节都不动**,它仍然是「这条线程自己的里程碑」,
//      不再是事项级权威。两者同名不同物,不要互相回写。
//   ② **零迁移**。没有事项文件的 missionId 一律视为「未归类」,按需从会话头【只读派生】一个不落盘的
//      视图(`derived:true`,标题取会话标题)。存量会话不批量重写、不补建文件。
//   ③ **反向索引的权威是事项文件的 `sessionIds`**,但读侧一律与会话头 `missionId` 对账 —— 文件丢了
//      或损坏了,索引就从会话头重建,不需要任何修复流程。
//
// 落点为什么在 02 而不是 06e(事项域):这一节是【持久化面】—— 文件读写、原子写、损坏隔离、写链、
// 反向索引与会话头两侧同写。02 已经是会话头、正文、变更流水、待决流水的唯一持有者,事项容器与它们
// 共用 atomicWriteJson / safeSessionId / updateSessionMeta / bumpMissionChangeSeq 这几件同样的东西;
// 放在 06e 会让引擎层凭空多出一条到 01-config 的边(见 module-dependency-policy.json 的债务上限)。
// 06e 仍然是【会话内任务账本】的域(buildMissionPromptSection / runMissionDriver),两者同名不同物。
//
// 聚合状态的唯一定义在 06i 的 `aggregateMissionState` —— 它与五态判据 `deriveStewardThreadState` /
// `stewardThreadStateFromCard`(mission-state.js 的服务端抄写件)同住一屋,入参是子线程五态数组。
// 13d / 13g / 13h 一律调它,禁止另写一份判据。
// ============================================================================

const MissionStore = require('./backend/mission-store.cjs').createMissionStore({ paths, safeSessionId, makeId, nowIso, logEvent, atomicWriteJson });
const { safeMissionId, readMissionContainer, withMissionContainerLock, writeMissionContainer, listMissionContainers, createMissionContainer, patchMissionContainer, missionIndexAdd, missionIndexRemove, MISSION_CONTAINER_MAX_FILES } = MissionStore;

async function readMissionSessionHead(sessionId) {
  const sid = safeSessionId(sessionId);
  if (!sid) return null;
  try { return applySessionTitleOverride(safeJsonParse(await fsp.readFile(sessionPath(sid), 'utf8'), null)); } catch { return null; }
}

const { missionAttachThread, missionDetachThread, missionMergeInto, missionSplitThreads } = require('./backend/mission-membership.cjs').createMissionMembership({
  store: MissionStore,
  sessions: { readHead: readMissionSessionHead, updateMeta: updateSessionMeta, list: listSessions, recordChange: bumpMissionChangeSeq, missionId: sessionMissionId },
  events: RUYI_EVENTS, logEvent, safeSessionId,
});

// Usage storage reports committed rows through this workbench composition boundary.
const {
  appendUsageLedger, flushUsageLedgerSync, forEachUsageRow, readUsageRows, usageLedgerCacheStats,
  usageLedgerChangesSince, usageDayKey, usageDayKeyMemo, usageRangeLowerMs,
} = require('./backend/usage-ledger.cjs').createUsageLedger({
  paths,
  onAppend(rec) {
    RUYI_EVENTS.emit('projection.invalidated', { sessionId: rec.sessionId, reason: 'usage' });
    if (rec.kind === 'turn') bumpMissionChangeSeq(rec.sessionId, {
      type: 'budget',
      cursor: { turnSeq: rec.turnSeq, engine: rec.engine },
      detail: { inTok: rec.inTok, outTok: rec.outTok, cachedInTok: rec.cachedInTok, cost: rec.cost, currency: rec.currency || '', estimated: rec.estimated },
    });
  },
});

const { auditBridgedWriteCoverage, OFFICE_WRITER_LIB_RE, bridgedOfficeScriptGate } = require('./backend/bridged-tool-guards.cjs');

const { cwdWarning, resolveWorkspace } = require('./backend/workspace-discovery.cjs').createWorkspaceDiscovery({
  paths: { samePathKey },
});

const {
  fileAllowedRoots, workspaceWriteRoots, resolveContainmentPath, realpathForContainment, guardWorkspacePath,
  providerIsLocal, remoteUncDenialResolved, UNC_DENIED_ERROR, guardFileToolPath,
} = require('./backend/workspace-file-policy.cjs').createWorkspaceFilePolicy({
  locations: {
    agentCliHomes, dataRoot, ensureDataRootReal, externalRoot: () => externalRoot(), mcpDropInDirs,
    toolboxComponentsDir,
  },
  policy: {
    AUTOEXEC_DENYLIST, isSensitiveDataPath, isSensitiveHardlinkAlias, isSensitiveHardlinkStat,
    sensitiveDataRoots,
  },
  paths: { samePathKey },
  config: { activeOpenAiProvider, logEvent, readConfig },
});

const { bridgedReadPathGate, resolveExecCwd, guardWorkspaceExecute } = require('./backend/workspace-tool-policy.cjs').createWorkspaceToolPolicy({
  policy: { guardFileToolPath, realpathForContainment },
  config: { logEvent, readConfig },
});

const {
  REVEAL_OPEN_SAFE_EXTS, buildRevealSpawn, buildOpenSpawn, resolvePreferredCodeEditor, buildCodeEditorSpawn,
  launchCodeEditor, isBrowserDocumentTarget, buildBrowserOpenSpawn,
} = require('./backend/desktop-file-handoff.cjs').createDesktopFileHandoff({
  desktop: { spawnDetachedChecked },
});

// The visual service owns image payload interning and history retention.
const VisualPipeline = require('./backend/visual-pipeline.cjs').createVisualPipeline();

const { createAttachmentStore, sanitizeFsSegmentName } = require('./backend/attachment-store.cjs');
const { makeAttachmentRecord } = createAttachmentStore({ paths, ensureDirs, makeId, nowIso });

const {
  appendLiveTail, installActiveChildEventFanout, subscribeActiveChildEvents,
} = require('./backend/active-child-events.cjs').createActiveChildEvents({
  nowIso,
});

const {
  PermissionWaitHooks, permissionWaitMs, promptDeadlineIsReal, promptWaitMs,
} = require('./backend/permission-wait-policy.cjs').createPermissionWaitPolicy();

const turnOutcomePending = new Set();

const driverAutoSessions = new Set();

const { kimiModelList, discoverKimiModels, kimiContextWindow } = require('./backend/kimi-model-discovery.cjs').createKimiModelDiscovery({
  ProcessRuntime, selectedAgentCli, prepareAgentCliSpawn, killChildTree, redact, safeJsonParse,
});
const AGENT_CLI_CONTEXT_WINDOW_PROBES = Object.freeze({ kimi: kimiContextWindow });

const AgentLoopHooks = require('./backend/agent-loop-hooks.cjs').createAgentLoopHooks({
  makeId, logEvent: (...args) => logEvent(...args), redact,
});

const { createInterventionDecisions, interventionCommandFailure } = require('./backend/intervention-decisions.cjs');
const decideInterventionCommand = createInterventionDecisions({
  safeSessionId, makeId, readSessionHeadResilient, sessionMissionId, readInterventions,
  transitionInterventionState, pendingPermissions, pendingQuestions, pendingPlans,
  logEvent: (...args) => logEvent(...args),
});

const { normalizeUserQuestions, normalizeQuestionAnswer, formatQuestionGuidance, normalizeQuestionContext } = require('./backend/user-question-protocol.cjs');

const {
  clearPendingPermissions, runAutomaticInterventionDecision, clearPendingPlans, clearPendingQuestions,
  extendUserQuestion, hasPendingPermissionForSession, hasPendingQuestionForSession, registerUserQuestion,
  requestUserQuestion, stopSession,
} = require('./backend/session-intervention-runtime.cjs').createSessionInterventionRuntime({
  activeChildren, decideInterventionCommand, killChildTree, logEvent, makeId, promptWaitMs,
  registerIntervention, settleIntervention,
  pending: { pendingPermissions, pendingPlans, pendingQuestions },
});

const { recordSessionExecutionOwner, sessionExecutionObservation, sessionExecutionSnapshot, sessionExecutionCheck, sessionExecutionCheckRewind, assertSessionExecutionOwner, registerSessionExecutionChild, requestSessionExecutionStop } = require('./backend/session-executions.cjs').createSessionExecutions({
  activeChildren, turnSettlers, serverInstanceId: OVERLAY_ID, hooks: SessionExecutionHooks, stopChild: stopSession,
});
SessionExecutionHooks.owns = (sessionId, owner) => Boolean(owner && turnSettlers.get(sessionId) === owner);
SessionExecutionHooks.observation = sessionExecutionObservation;
SessionExecutionHooks.snapshot = sessionExecutionSnapshot;
SessionExecutionHooks.checkRewind = sessionExecutionCheckRewind;
SessionExecutionHooks.check = sessionExecutionCheck;
SessionExecutionHooks.stop = requestSessionExecutionStop;

const { createMcpTransports, mcpChildExitResult } = require('./backend/mcp-transports.cjs');
const { McpStdioClient, McpHttpClient, mcpToolAllowed, normalizeMcpToolResult, mcpCallToolParams } = createMcpTransports({
  safeJsonParse, DesktopExecutionHooks, ProcessRuntime, killChildTree, _expandMcpVar, RUYI_MCP_SERVER_ID, VERSION,
});

const { probeDesktopExecutionReceipts } = require('./backend/mcp-execution-receipts.cjs').createMcpExecutionReceipts({
  executionArgumentsDigest,
});

const ToolboxHooks = {};

const {
  mcpClients, mcpStartingClients, invalidateMcpRuntime, bridgedServerUnavailableMessage, getBridgedClient,
  killAllMcpClients, collectBridgedTools, sanitizeServerId, MCP_COMPAT_MATRIX, buildMcpConnectorInventory,
  classifyMcpError, probeMcpConnector,
} = require('./backend/mcp-client-runtime.cjs').createMcpClientRuntime({
  McpHttpClient, McpStdioClient, logEvent, readConfig, mcpToolAllowed, resolveExternalMcpServers,
  discovery: {
    detectDesktopMcp, enabledToolboxComponents, ensureDesktopMcpWarm, invalidateMcpDropInCache,
    scanMcpDropIns,
  },
  masking: { maskKey, safeUrlForDisplay },
});

const {
  safeMcpInventory, configureMcpFromTool, mutateMcpConnector,
} = require('./backend/mcp-connector-settings.cjs').createMcpConnectorSettings({
  BROWSER_AUTOMATION_MODES, generateMcpConfig, invalidateMcpRuntime, isRuyiMcpServerId, logEvent,
  mutateConfig, resolveExternalMcpServers, sanitizeExternalMcpServer, scanMcpDropIns,
  privacy: {
    collectDisplayUrlRestores, mcpArgsForDisplay, restoreExternalMcpServerSecrets, safeUrlForDisplay,
  },
});

const {
  nativeClaudeAgentResultInfo, parseAgentCliEvent, parseClaudeEvent, parseClaudeTaskNotification,
  parseKimiStreamJsonEvent,
} = require('./backend/agent-cli-events.cjs').createAgentCliEvents({
  safeJsonParse,
});

const {
  buildClaudeRecoveryHistory, claudeProviderTailSince, claudeResumeRouteKey, isClaudeResumeMissingError,
  lastSuccessfulClaudeModel, sameClaudeResumeCwd,
} = require('./backend/claude-resume-recovery.cjs').createClaudeResumeRecovery({
  selectedAgentCli,
});

const { resolveBridge } = require('./backend/bridged-tool-policy.cjs');

// Deletion coordinates live turns with the session store and shared tombstone state.
const { deleteSession, bulkDeleteUnpinnedSessions, removeSessionToolImages } = require('./backend/session-deletion.cjs').createSessionDeletion({
  paths, assertSessionIdForPath, safeSessionId, logEvent, markSessionDeleted,
  files: { sessionPath, sessionBodyPaths, interventionFilePath, missionChangeFilePath,
    removeSessionNotes, sessionScratchpadPath, journalDir, agentRunDir },
  pendingWrites: { sessionWriteChains, scratchpadWriteInFlight },
  execution: {
    stop: stopSession, activeRuns: () => activeAgentRuns.values(), stopRuns: stopMissionAgentRuns,
    settler: id => turnSettlers.get(id), isActive: id => activeChildren.has(id),
    revokeGrants: revokeAllGrants,
    flushRuns: AgentRunStore.flushSessionAgentRuns,
  },
  membership: { readHead: readMissionSessionHead, ownerOf: sessionMissionId, remove: missionIndexRemove },
  index: { list: listSessions, remove: id => scheduleSessionIndexUpdate(id, SESSION_TOMBSTONE) },
  invalidateSessionState: id => {
    dropSessionBodyState(id); SessionPersistence.invalidateReads(id);
    dropSessionTitleOverride(id); sessionEngineRouteOverrides.delete(id); sessionEngineRouteScopeOverrides.delete(id);
    sessionPermissionModeOverrides.delete(id); sessionDesktopToolsOverrides.delete(id); dropInterventionSessionState(id);
  },
  events: RUYI_EVENTS,
});

Object.assign(ToolboxHooks, require('./backend/toolbox-services.cjs').createToolboxServices({
  ProcessRuntime, killChildTree, readConfig, mutateConfig, registry: ToolboxRegistry, logEvent, redact, safeJsonParse,
}));

const { HanziPinyin } = require('./backend/hanzi-pinyin.cjs');

const { VoiceLexicon } = require('./backend/voice-lexicon.cjs');

const { VoiceLearn } = require('./backend/voice-learn.cjs');

// Explicit shared prompt-registry service.
const { PROMPT_EN, PROMPT_PACK_VERSION, PROMPT_ZH, getPromptPack, revertNoticeTurns } = require('./backend/prompt-registry.cjs');
const { appendMemorySection, clampAppendWithSkills, fenceSafeSlice, shrinkFencedSection } = require('./backend/prompt-budget.cjs');
const { appendResponseLanguagePolicy, appendTurnPolicies, buildAgentTeamHint, buildClaudeNativeAgentPolicy, buildPromptTaskContext, buildSoftwareEngineeringPolicy, softwareEngineeringTaskProfile } = require('./backend/turn-prompt-policy.cjs');

const {
  BUILTIN_AGENT_WORKFLOWS, agentWorkflowSaveProblem, buildOrchestrateHint, createAgentWorkflowCatalog,
  normalizeAgentWorkflow, normalizeWaitSpec, normalizeWorkflowCondition, normalizeWorkflowLoop,
} = require('./backend/agent-workflow-catalog.cjs');
const { getAgentWorkflows, saveAgentWorkflow, deleteAgentWorkflow } = createAgentWorkflowCatalog({
  paths, atomicWriteJson,
});

// Both turn assembly and tool dispatch consume the same skill registry.
const { createSkillRegistry, effectiveSkillSelection } = require('./backend/skill-registry.cjs');
const SkillRegistry = createSkillRegistry({ SKILL_ID_RE, agentCliHomes, externalRoot, paths, readIfExists, safeJsonParse });
const { resolveEnabledSkillEntries } = SkillRegistry;

// Compose voice, auxiliary correction, and lexicon persistence below tool dispatch.
const {
  asrFixMessages, asrFixModeOf, asrFixSanity, providerFixCompletion,
  resolveAsrFixProvider, resolveAsrProvider, resolveAsrStreamProvider, transcribeAudioViaProvider,
  voiceLexiconAsrPromptFor, voiceLexiconRead, voiceLexiconUpdate,
} = require('./backend/voice-service.cjs').createVoiceService({
  paths, DurableJsonStore, appendUsageLedger, readConfig, logEvent, PrivacyGateway, ToolboxHooks,
  providerBaseWithV1, providerPostJsonOnce, providerWireProtocol,
});

// ===== v1.9 P-B: 引擎转录 GC(claude CLI 的 ~/.claude/projects)====================================
// 背景:claude 引擎每会话/每子代理在 ~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl 留转录,
// 无人管理、只增不减(实测重度用户单项目目录数百 MB)。工作台是唯一知道「哪些转录是自己 spawn 的」
// 角色(会话里存 claudeSessionId),据此做【白名单式】GC:
//   ① 账本(dataRoot/engine-transcripts.json)只记本工作台 spawn 过的 sessionId → cwd(saveSession 时登记);
//   ② sweep 只考虑账本内的 id,且要求【当前无活会话引用】+【mtime 超保留期】同时成立;
//   ③ 删除 = 该 id 的 .jsonl + 同名目录(子代理侧录);绝不按目录通配,绝不碰账本外任何文件
//      (用户的 Claude Code 自己产生的转录永远安全)。
// 会话删除时不立即连带(保守)—— 活引用消失后由保留期兜底清理。
// Owned transcript ledger; storage announces durable sessions without depending on an engine.
const { claudeProjectsRoot, claudeProjectDirKey, recordEngineTranscript, engineTranscriptCwd, sweepEngineTranscriptsStore } = require('./backend/engine-transcripts.cjs').createEngineTranscriptStore({
  paths, atomicWriteJson, nowIso, safeJsonParse, sessionIndexFile: SESSION_INDEX_FILE,
});
RUYI_EVENTS.subscribe((name, payload) => {
  if (name === 'session.transcript.observed') void recordEngineTranscript(payload.claudeSessionId, payload.cwd).catch(() => {});
});

const { collectAudit, buildOpsMetrics, desktopAuditEntriesFromResult } = require('./backend/audit-timeline.cjs').createAuditTimeline({
  paths, collectBridgedTools, resolveExternalMcpServers, sanitizeServerId,
  getMcpClient: id => mcpClients.get(id),
});
const { collectStorageStats, storageSweep } = require('./backend/storage-steward.cjs').createStorageSteward({
  paths, safeSessionId, nowIso, logEvent, claudeProjectsRoot, sweepEngineTranscriptsStore,
});
const { recordRequestMetric, normalizeMetricsPath, readStorageTrend, maybeRecordStorageTrend, buildMetricsPayload } =
  require('./backend/runtime-metrics.cjs').createRuntimeMetrics({
    paths, activeChildren, mcpClients, collectStorageStats, atomicWriteJson, nowIso,
  });

// Both discovery and execution use one cached capability matrix.
const probeDesktopMcp = require('./backend/desktop-capability-probe.cjs').createDesktopCapabilityProbe({
  collectBridgedTools, resolveExternalMcpServers, sanitizeServerId, DesktopExecutionHooks,
  getMcpClient: id => mcpClients.get(id),
});
const { CAP_UNKNOWN_TTL_MS, createCapabilityService } = require('./backend/capability-service.cjs');
const { getCapabilities, peekCapabilities, invalidateCapabilityCache, markNetworkOnline, networkAnchors, probeAny } =
  createCapabilityService({
    readConfig, nowIso, providerBaseIsLocalOrLan, providerBaseWithV1,
    probeDesktopMcp, probeRgAsync, existsExecutableAsync, probeGitCliAsync,
    runtimeCapabilitySnapshot: () => ProcessRuntime.capabilitySnapshot(),
  });

const { AGENT_CLI_ADAPTERS, agentCliAdapter } = require('./backend/agent-cli-adapters.cjs').createAgentCliAdapters({
  cli: { AGENT_CLI_TYPES, normalizeAgentCliType, prepareAgentCliSpawn },
  claude: {
    CLAUDE_PERMISSION_MODE_MAP, RUYI_MCP_CLI_TOOL_PREFIX, buildClaudeAgentDefinitions, claudeCostFields,
    discoverModels, effectiveAnthropicEnv, isClaudeResumeMissingError, offlineModelList, parseClaudeEvent,
  },
  kimi: {
    applyKimiStatusToSession: (...args) => applyKimiStatusToSession(...args), discoverKimiModels,
    kimiContextWindow, kimiModelList, kimiSessionStatus: (...args) => kimiSessionStatus(...args),
    kimiUsageFromStatus: (...args) => kimiUsageFromStatus(...args), parseKimiStreamJsonEvent,
    runKimiAcpTurnPrepared: (...args) => runKimiAcpTurnPrepared(...args),
    runKimiCompact: (...args) => runKimiCompact(...args),
    syncKimiSessionUsage: (...args) => syncKimiSessionUsage(...args),
    syncKimiTurnPreferences: (...args) => syncKimiTurnPreferences(...args), syncMcpServersToKimi,
    watchKimiWire: (...args) => watchKimiWire(...args),
  },
  tools: {
    classifyToolPacks: (...args) => classifyToolPacks(...args), generateSessionMcpConfig,
    sessionDesktopToolsOf,
  },
  usage: { appendUsageLedger },
});

const { runClaudeTurn } = require('./backend/agent-cli-turn.cjs').createAgentCliTurn({
  cli: {
    agentCliAdapter, agentCliLauncherUsable, buildClaudeRecoveryHistory, claudeProviderTailSince,
    claudeResumeRouteKey, decodeClaudeCliText, engineTranscriptCwd, lastSuccessfulClaudeModel,
    maybeAutoCompactAgentSession, nativeClaudeAgentResultInfo, sameClaudeResumeCwd, selectedAgentCli,
    writeToChild,
  },
  runtime: {
    AgentLoopHooks, DeliveryHooks, DesktopExecutionHooks, EventStreamHooks, PrivacyGateway, ProcessRuntime,
    RUYI_EVENTS, RUYI_MCP_CLI_TOOL_PREFIX, activeChildren, activeOpenAiProvider, createCappedDiagnosticText,
    createNdjsonLineFeeder, cwdWarning, killChildTree, logEvent, normalizeCwd, nowIso, paths, readConfig,
    redact, safeJsonParse,
  },
  execution: {
    appendLiveTail, assertSessionExecutionOwner, clearPendingPermissions, clearPendingQuestions,
    formatQuestionGuidance, hasPendingPermissionForSession, hasPendingQuestionForSession,
    installActiveChildEventFanout, isAskUserTool, permissionWaitMs, registerSessionExecutionChild,
    registerUserQuestion, stopSession,
  },
  prompts: {
    PROMPT_PACK_VERSION, appendMemorySection, appendTurnPolicies, buildAttachmentPrompt,
    buildBrowserAutomationHint: (...args) => buildBrowserAutomationHint(...args), buildDeliveryRevisionPrompt,
    buildMemoryCheckPrompt: (...args) => buildMemoryCheckPrompt(...args),
    buildMemoryConflictMap: (...args) => buildMemoryConflictMap(...args),
    buildMemoryPromptSection: (...args) => buildMemoryPromptSection(...args),
    buildMissionPromptSection: (...args) => buildMissionPromptSection(...args), buildModelHint,
    buildOrchestrateHint, buildPlaybookIndexSection: (...args) => buildPlaybookIndexSection(...args),
    buildPromptTaskContext, buildSkillsPromptSection: (...args) => buildSkillsPromptSection(...args),
    buildToolCustomizationHint: (...args) => buildToolCustomizationHint(...args), buildUserEnvelope,
    effectiveSkillSelection, evalPlaybookAvailability: (...args) => evalPlaybookAvailability(...args),
    filterMemoryForNativeCli: (...args) => filterMemoryForNativeCli(...args), getAgentWorkflows,
    getCapabilities, getPromptPack, loadAllPlaybooks: (...args) => loadAllPlaybooks(...args),
    memoryGlobalDir: (...args) => memoryGlobalDir(...args),
    memoryProjectDir: (...args) => memoryProjectDir(...args), peekCapabilities, resolveEnabledSkillEntries,
    resolveEngineEnvBrief: (...args) => resolveEngineEnvBrief(...args),
    resolveMemoryPreflight: (...args) => resolveMemoryPreflight(...args), softwareEngineeringTaskProfile,
  },
  storage: {
    buildTurnSummary, bumpMissionChangeSeq, captureWorkspaceTurnBaseline, createTurnSegmentBuilder,
    finalizeMissionAfterTurn, isUntitledSessionTitle, journalReadIndex, lastAssistantEngine, loadSession,
    mergeMissionBeforeSave, reconcileWorkspaceTurnBaseline, saveSession, saveTurnFinalSession,
  },
});

// Kimi Code integration. Turns use the official ACP JSON-RPC/NDJSON protocol; the local Server API remains
// operation-scoped for native compaction, and the documented wire transcript supplements ACP's usage update
// with exact compaction/failure state. A separate ACP process is kept for the whole Ruyi turn so reverse RPC
// (permissions/questions) and queued follow-up steering share one live native Kimi session.
const { classifyKimiAcpReadonlySearch, KIMI_ACP_SEARCH_BLOCKED_ENV_RE } =
  require('./backend/kimi-search-policy.cjs').createKimiSearchPolicy({
    dataRoot, appRoot, pathWithinRoot, fileAllowedRoots, realpathForContainment, isSensitiveDataPath, guardFileToolPath,
  });
const buildKimiAcpPromptParts = require('./backend/kimi-prompt-parts.cjs').createKimiPromptParts({
  guardFileToolPath, realpathForContainment,
});


const { createKimiAcpRpc: createAcpRpc } = require('./backend/kimi-acp-rpc.cjs');
const {
  kimiAcpSessionRestoreMethods, kimiAcpUnknownSessionError, kimiAcpModeOptionFromActivated, kimiAcpFreshActualForOperation,
} = require('./backend/kimi-acp-session.cjs');
const { parseKimiWireCompaction, parseKimiWireAgentEvents, watchKimiWire } = require('./backend/kimi-wire.cjs');

const { createKimiAcpInterventions, kimiAcpSamePath } = require('./backend/kimi-acp-interventions.cjs');
const KimiAcpInterventions = createKimiAcpInterventions({
  dataRoot, fileAllowedRoots, workspaceWriteRoots, guardFileToolPath, realpathForContainment,
  makeId, requestNativePermission: (...args) => requestNativePermission(...args), requestUserQuestion,
  permissionWaitMs, runAutomaticInterventionDecision, buildOpenSpawn, spawnDetachedChecked, process,
});
const {
  kimiAcpInferConcreteToolInput, kimiAcpPermissionToolCall, handleKimiAcpPermissionRequest, consumeKimiAcpApproval,
  kimiAcpSuccessfulEnterPlanMode, kimiAcpNativeShellQuote, kimiAcpNativeBashWrapperTexts, kimiAcpNativeBashWrapperCandidate,
  ensureKimiAcpOperationPermission,
} = KimiAcpInterventions;
const KimiAcpFiles = require('./backend/kimi-acp-files.cjs').createKimiAcpFiles({
  realpathForContainment, kimiAcpSamePath, guardFileToolPath, ensureKimiAcpOperationPermission,
  toolCall: (...args) => toolCall(...args), normalizeTodoItems,
});
const { isKimiAcpPlanFilePath, resolveKimiAcpPlanFilePath } = KimiAcpFiles;
const KimiAcpTerminals = require('./backend/kimi-acp-terminals.cjs').createKimiAcpTerminals({
  classifyKimiAcpReadonlySearch, KIMI_ACP_SEARCH_BLOCKED_ENV_RE, guardWorkspaceExecute,
  ensureKimiAcpOperationPermission, kimiAcpNativeBashWrapperCandidate, ProcessRuntime, killChildTree, makeId,
});
const { handleKimiAcpTerminalRequest, cleanupKimiAcpTerminals, killKimiAcpTerminal } = KimiAcpTerminals;

function createKimiAcpRpc(child, handlers) {
  return createAcpRpc(child, handlers, () => PrivacyGateway.assertCliAllowed());
}

const {
  syncKimiTurnPreferences, kimiSessionStatus, kimiUsageFromStatus, applyKimiStatusToSession, kimiStatusFingerprint,
  syncKimiSessionUsage, runKimiCompact,
} = require('./backend/kimi-native-operations.cjs').createKimiNativeOperations({
  selectedAgentCli, agentCliLauncherUsable, prepareAgentCliSpawn, ProcessRuntime, killChildTree, PrivacyGateway,
  readConfig, loadSession, mutateSession, kimiContextWindow, nowIso, logEvent, process,
  runAgentExternalCompact: (...args) => runAgentExternalCompact(...args),
  upsertCompactMarker: (...args) => upsertCompactMarker(...args),
});

const { runKimiAcpTurnPrepared, prepareKimiAcpSpawn } = require('./backend/kimi-acp-turn.cjs').createKimiAcpTurn({
  paths, dataRoot, runtime: RUNTIME, externalRoot, process,
  files: KimiAcpFiles, terminals: KimiAcpTerminals, interventions: KimiAcpInterventions,
  createKimiAcpRpc, prepareAgentCliSpawn, syncMcpServersToKimi, buildKimiAcpPromptParts, syncKimiSessionUsage,
  processRuntime: { ProcessRuntime, killChildTree, assertSessionExecutionOwner, registerSessionExecutionChild, activeChildren, stopSession },
  sessions: { readConfig, loadSession, saveSession, saveTurnFinalSession, isUntitledSessionTitle },
  permissions: { permissionWaitMs, clearPendingPermissions, clearPendingQuestions, clearPendingPlans, hasPendingPermissionForSession },
  journal: { captureWorkspaceTurnBaseline, reconcileWorkspaceTurnBaseline, journalReadIndex },
  mission: { bumpMissionChangeSeq, finalizeMissionAfterTurn, mergeMissionBeforeSave },
  hooks: { AgentLoopHooks, PrivacyGateway, RUYI_EVENTS, logEvent, nowIso, cwdWarning },
});

async function replaceSessionObject(target, fresh) {
  if (!target || !fresh) return;
  for (const key of Object.keys(target)) if (!Object.prototype.hasOwnProperty.call(fresh, key)) delete target[key];
  Object.assign(target, fresh);
}

// hunt2-engines#7:Agent CLI 回合前自动压缩的滞回与失败退避。修前每个回合都会重判、重试:Kimi 原生压缩坏了时
// 每回合开头都要白等最多 3 分钟(compactKimiNative 的轮询上限),外部摘要模型坏了时每回合都再烧一次摘要调用。
//   ① 成功后:runKimiCompact / runAgentExternalCompact 已把压后实测写进 session.autoCompactWatermark,这里照 10
//      runAutoCompaction 的口径把触发线抬到 max(阈值线, 水位 + max(2K, 2% 窗口)) —— 两路引擎同一种滞回。
//   ② 失败后:只在内存里记「哪条会话、在多少 token 时、何时失败」(不进会话头:它是运行时退避,重启即清零合理);
//      冷却期内且上下文没有再涨过一个重武装余量,就不再尝试。
const AGENT_AUTO_COMPACT_FAIL_COOLDOWN_MS = 10 * 60 * 1000;
const agentAutoCompactFailures = new Map();   // sessionId -> { at, tokens }
function agentAutoCompactTrigger(session, threshold, limit) {
  const base = threshold * limit;
  const rearmMargin = Math.max(2000, Math.round(limit * 0.02));
  const wm = Number(session && session.autoCompactWatermark);
  return { trigger: Number.isFinite(wm) && wm > 0 ? Math.max(base, wm + rearmMargin) : base, rearmMargin };
}
function agentAutoCompactBackingOff(sessionId, used, rearmMargin) {
  const failed = agentAutoCompactFailures.get(String(sessionId || ''));
  if (!failed) return false;
  if (Date.now() - failed.at >= AGENT_AUTO_COMPACT_FAIL_COOLDOWN_MS || used >= failed.tokens + rearmMargin) {
    agentAutoCompactFailures.delete(String(sessionId || ''));
    return false;
  }
  return true;
}
function noteAgentAutoCompactFailure(sessionId, used) {
  agentAutoCompactFailures.set(String(sessionId || ''), { at: Date.now(), tokens: Number(used) || 0 });
  while (agentAutoCompactFailures.size > 500) agentAutoCompactFailures.delete(agentAutoCompactFailures.keys().next().value);
}

// Called before an Agent CLI turn. A CLI with a native status surface (adapter.contextStatus; Kimi) uses its
// authoritative status; Claude can opt into an external model and uses the latest measured CLI usage. The
// default Claude path remains Claude's own auto-compact.
// 架构还债批 4:第三个参数由 CLI 类型名改成该 CLI 的适配器(05 runClaudeTurn 传入;05b 不反向引用 05 的符号)。
async function maybeAutoCompactAgentSession(session, config, cliAdapter, onEvent) {
  const nativeStatus = cliAdapter.contextStatus;
  const nativeCompact = cliAdapter.nativeCompact;
  try {
    const threshold = Number(config.autoCompactThreshold) || 0.8;
    if (config.compactProviderId) {
      let used = lastSessionContextTokens(session);
      const contextMeta = await agentConversationContextMeta({ ...config, agentCliType: cliAdapter.id }, session);
      let limit = contextMeta.contextWindow;
      if (nativeStatus && session.claudeSessionId) {
        const status = await nativeStatus.read(config, session);
        if (status.ok) {
          used = status.contextTokens;
          if (contextMeta.contextWindowSource !== 'manual' && status.contextWindow > 0) limit = status.contextWindow;
          nativeStatus.apply(session, status);
        }
      }
      const armed = limit > 0 ? agentAutoCompactTrigger(session, threshold, limit) : null;
      if (used > 0 && armed && used >= armed.trigger && !agentAutoCompactBackingOff(session.id, used, armed.rearmMargin)) {
        onEvent({ type: 'compact', mode: 'external-summary', phase: 'started', trigger: 'auto', beforeTokens: used, contextWindow: limit });
        const result = await runAgentExternalCompact(session.id, config, 'auto');
        if (!result.ok) {
          noteAgentAutoCompactFailure(session.id, used);
          onEvent({ type: 'compact', mode: 'external-summary', phase: 'failed', error: result.error });
          return false;
        }
        agentAutoCompactFailures.delete(String(session.id));
        const fresh = await loadSession(session.id);
        await replaceSessionObject(session, fresh);
        onEvent({ type: 'compact', mode: 'external-summary', phase: 'completed', trigger: 'auto', beforeTokens: result.beforeTokens, afterTokens: result.afterTokens });
        return true;
      }
      return false;
    }
    if (!nativeStatus || !nativeCompact || !session.claudeSessionId) return false;
    const status = await nativeStatus.read(config, session);
    if (!status.ok) return false;
    nativeStatus.apply(session, status);
    onEvent({ type: 'usage', ...nativeStatus.usage(status) });
    const armed = status.contextWindow > 0 ? agentAutoCompactTrigger(session, threshold, status.contextWindow) : null;
    if (armed && status.contextTokens >= armed.trigger && !agentAutoCompactBackingOff(session.id, status.contextTokens, armed.rearmMargin)) {
      const result = await nativeCompact.run(session.id, config, 'auto', onEvent);
      if (!result.ok) {
        noteAgentAutoCompactFailure(session.id, status.contextTokens);
        onEvent({ type: 'compact', mode: nativeCompact.mode, phase: 'failed', error: result.error });
        return false;
      }
      agentAutoCompactFailures.delete(String(session.id));
      const fresh = await loadSession(session.id);
      await replaceSessionObject(session, fresh);
      return true;
    }
    return false;
  } catch (error) {
    try { onEvent({ type: 'compact', mode: nativeCompact ? nativeCompact.mode : 'external-summary', phase: 'failed', error: (error && error.message) || String(error) }); } catch { /* ignore */ }
    return false;
  }
}

// Compose the Provider helpers and prompt services used by the execution engines.
const { ERROR_CLASSES } = require('./backend/turn-error-classes.cjs');
const { TOOL_ITERATION_BUDGETS, resolveToolIterationBudget, shouldExtendToolIterationBudget } = require('./backend/tool-iteration-budget.cjs');
const {
  buildBrowserAutomationHint, buildToolCustomizationHint, readProjectMemory, buildSkillsPromptSection,
  buildPlaybookIndexSection, neutralizeAuthoredText, buildSessionScratchpadInjectPrompt,
} = require('./backend/prompt-context.cjs');

const { evalPlaybookAvailability, matchServiceEntry } = require('./backend/playbook-policy.cjs');
const { normalizePlaybook, loadAllPlaybooks, listPlaybooksWithAvailability, saveUserPlaybook, deleteUserPlaybook, playbookReuseSources, draftPlaybookFromSession } = require('./backend/playbooks.cjs').createPlaybooks({ safeSessionId, externalRoot, paths, safeJsonParse, getCapabilities, atomicWriteJson, loadSession, readConfig, activeOpenAiProvider, providerRawCompletion, appendUsageLedger });

const { createThreadBriefService, parseThreadBrief } = require('./backend/thread-brief.cjs');
const { maybeWriteThreadBrief, settleThreadBrief, updateAutomaticThreadTitle } = createThreadBriefService({
  safeSessionId, loadSession, updateSessionMeta, getSessionTitleOverride, setSessionTitleOverride,
  PrivacyGateway, providerRawCompletion,
  appendUsageLedger, RUYI_EVENTS, nowIso, logEvent,
});

const repairNodeJsonViaProvider = require('./backend/provider-raw-completion.cjs').createNodeJsonRepair({
  providerRawCompletion, appendUsageLedger,
});

function buildRuntimeIdentityFacts() {
  const host = (typeof RUNTIME !== 'undefined' && RUNTIME && RUNTIME.host) || '127.0.0.1';
  const port = (typeof RUNTIME !== 'undefined' && RUNTIME && RUNTIME.port) || DEFAULT_PORT;
  return {
    appName: APP_NAME,
    version: VERSION,
    launchMode: 'node',
    installDir: externalRoot(),
    dataDir: dataRoot(),
    address: 'http://' + host + ':' + port,
    instanceId: OVERLAY_ID,
  };
}

const { buildEngineEnvBrief, resolveEngineEnvBrief } = require('./backend/engine-env-brief.cjs').createEngineEnvBrief({
  appName: APP_NAME, buildRuntimeIdentityFacts, probeRgAsync,
});
const CORE_MEMORY_SUMMARY_CAP = 520;
const MemoryPrompts = require('./backend/memory-prompts.cjs').createMemoryPrompts({ neutralizeFenceTag, summaryCap: CORE_MEMORY_SUMMARY_CAP });
const { buildMemoryPromptSection, buildMemoryTurnSection, buildCoreMemoryPromptSection, buildMemoryCheckPrompt } = MemoryPrompts;

const { buildStableSystemPrompt, buildVolatileParts, buildProviderSystemPrompt } = require('./backend/provider-prompt.cjs').createProviderPrompt({
  buildRuntimeIdentityFacts, buildEngineEnvBrief,
  buildMemoryCheckPrompt, buildMemoryPromptSection,
  buildMissionPromptSection: (...args) => buildMissionPromptSection(...args),
});

// Retrieval owns its corpus and vocabulary caches; consumers hold separate instances.
const { createRetrievalCorpusCache, rankRetrievalCorpus, reciprocalRankFusion, retrievalTerms } = require('./backend/retrieval-index.cjs');

// Explicit Steward rule service; each host owns its hooks.
const {
  STEWARD_ANSWER_BASIS,
  STEWARD_ASKS_YOU_CHARS,
  STEWARD_AUTO_ASK_CWD_KEY_RE,
  STEWARD_AUTO_ASK_DATAROOT_PATTERNS,
  STEWARD_AUTO_ASK_EGRESS_PATTERNS,
  STEWARD_AUTO_ASK_INDIRECT_PATTERNS,
  STEWARD_AUTO_ASK_PROSE_TOOLS,
  STEWARD_BRIEF_CLOSE,
  STEWARD_BRIEF_LIMITS,
  STEWARD_BRIEF_OPEN,
  STEWARD_BRIEF_TRUNCATED,
  STEWARD_CATALOG_DESC_CHARS,
  STEWARD_CATALOG_ROWS,
  STEWARD_CONFIG_HELP,
  STEWARD_CONFIG_SECRET_PATTERN,
  STEWARD_CONFIG_TIERS,
  STEWARD_CONFIG_TIER_CONFIRM,
  STEWARD_CONFIG_TIER_FORBIDDEN_NOTE,
  STEWARD_CONFIG_TIER_FREE,
  STEWARD_DEICTIC_EN_RE,
  STEWARD_DEICTIC_ZH_RE,
  STEWARD_DELIVERABLE_CHARS,
  STEWARD_DIGEST_LIMITS,
  STEWARD_EVENT_KINDS,
  STEWARD_EXEMPT_ABSOLUTE_TARGET,
  STEWARD_EXEMPT_CATEGORY_LABELS,
  STEWARD_EXEMPT_CONTENT_GROUPS,
  STEWARD_EXEMPT_DELEGATIONS_PER_HOUR,
  STEWARD_EXEMPT_DELEGATION_GATES,
  STEWARD_EXEMPT_DELEGATION_TEXT_MAX,
  STEWARD_EXEMPT_DELEGATION_WINDOW_MS,
  STEWARD_EXEMPT_EXCERPT_CHARS,
  STEWARD_EXEMPT_FLOOR_DELETE_TARGET,
  STEWARD_EXEMPT_FLOOR_DELETE_VERBS,
  STEWARD_EXEMPT_INDIRECT_PATTERNS,
  STEWARD_EXEMPT_INPUT_CHARS,
  STEWARD_EXEMPT_INPUT_DEPTH,
  STEWARD_EXEMPT_NAME_CARVEOUTS,
  STEWARD_EXEMPT_READ_METHODS,
  STEWARD_EXEMPT_RISK_NOTE_CHARS,
  STEWARD_EXEMPT_TAINT_CATEGORIES,
  STEWARD_EXEMPT_TOOL_PATTERNS,
  STEWARD_EYES_CHARS,
  STEWARD_ID_OPAQUE_RE,
  STEWARD_ID_SESSION_RE,
  STEWARD_KNOWN_WORKSPACE_LIMITS,
  STEWARD_LAST_SAY_CHARS,
  STEWARD_MEMORY_KINDS,
  STEWARD_MEMORY_LIMITS,
  STEWARD_NEUTRAL_GT,
  STEWARD_NEUTRAL_LT,
  STEWARD_NOTIFY_KINDS,
  STEWARD_NOTIFY_TEXT_CHARS,
  STEWARD_NOTIFY_WINDOW_MS,
  STEWARD_PERMISSION_LABELS,
  STEWARD_PERMISSION_MODE,
  STEWARD_PERMISSION_RANK,
  STEWARD_PERMISSION_VERBS,
  STEWARD_PHRASE_RE,
  STEWARD_PLAYBOOK_CLOSE,
  STEWARD_PLAYBOOK_OPEN,
  STEWARD_PREROUTE_DEFAULTS,
  STEWARD_PREROUTE_QUERY_MAX,
  STEWARD_QUESTION_LEAD_RE,
  STEWARD_QUESTION_TAIL_RE,
  STEWARD_QUICK_ANSWER_CHARS,
  STEWARD_QUICK_KIND,
  STEWARD_QUICK_QUESTION_CHARS,
  STEWARD_SAY_SENTENCE_ENDS,
  STEWARD_SAY_TRIMMED_NOTE,
  STEWARD_SCHEDULE_RE,
  STEWARD_SESSION_ID,
  STEWARD_SESSION_TITLE,
  STEWARD_STATE_LABELS,
  STEWARD_STOPPED_SAY,
  STEWARD_TAINT_TOOL_NAMES,
  STEWARD_THREAD_STATES,
  STEWARD_THREAD_STATE_ORDER,
  STEWARD_THREAD_STATE_RULES,
  STEWARD_TOOL_PREFIX,
  STEWARD_WAIT_LABELS,
  STEWARD_WAIT_REASONS,
  STEWARD_WORKSPACE_TABLE_MAX,
  StewardHooks,
  THREAD_ORIGINS,
  THREAD_VISIBLE_TODAY_MS,
  aggregateMissionState,
  buildStewardBrief,
  buildStewardDigestLine,
  deriveStewardThreadState,
  isStewardToolName,
  prerouteText,
  stewardActConfirmSpec,
  stewardAsksYou,
  stewardAsksYouForThread,
  stewardAssemblePlaybookPrompt,
  stewardAutoAskEgressText,
  stewardAutoAskIndirect,
  stewardAutoAskReason,
  stewardAutoAskScanIncomplete,
  stewardAutoAskSensitiveKind,
  stewardChatCapableProvider,
  stewardClipSay,
  stewardConfigHelpFor,
  stewardConfigTierFor,
  stewardCoveringLastTurn,
  stewardExemptAbsoluteDeleteTarget,
  stewardExemptCatastrophicDelete,
  stewardExemptDelegationVerdict,
  stewardExemptExcerpt,
  stewardExemptHits,
  stewardExemptIndirectConstruction,
  stewardExemptInputText,
  stewardExemptReason,
  stewardExemptRiskNote,
  stewardExemptScanInput,
  stewardExemptStructuredWrite,
  stewardForeignProjection,
  stewardHasText,
  stewardHumanizeIds,
  stewardMayAct,
  stewardMayTightenTo,
  stewardMemoryTerms,
  stewardOpenAiFallback,
  stewardPendingOneLine,
  stewardPendingTotal,
  stewardPermissionLabel,
  stewardPermissionPlain,
  stewardPermissionRank,
  stewardPermissionTarget,
  stewardPlaybookMissingInputs,
  stewardPrerouteContainsPhrase,
  stewardPrerouteDeicticHit,
  stewardPrerouteExtractPhrases,
  stewardPrerouteFieldMatch,
  stewardPrerouteHit,
  stewardPrerouteIsDeictic,
  stewardPrerouteIsQuestion,
  stewardPrerouteIsSchedule,
  stewardPrerouteMemoryHit,
  stewardPrerouteReason,
  stewardPrerouteScoreThread,
  stewardRuyiOwnedPath,
  stewardSamePath,
  stewardSanitizeBlock,
  stewardSanitizeText,
  stewardStateLabel,
  stewardStoppedRefusal,
  stewardStoppedTarget,
  stewardTaintToolCall,
  stewardTaintToolName,
  stewardTermJaccard,
  stewardThreadArtifactFiles,
  stewardThreadEngineRoute,
  stewardThreadStateFromCard,
  stewardThreadStateFromHead,
  stewardThreadStateRank,
  stewardThreadTurnQueued,
  stewardToolPermanentlyExempt,
  stewardTrimSayAtSentence,
  stewardTurnTaint,
  stewardWatchedThread,
  stewardWorkspaceLabels,
  stewardWorkspaceRootFor,
  threadOriginOf,
  threadVisible,
  waitReasonFor
} = require('./backend/steward-core.cjs').createStewardCore({ PrivacyGateway });

// ============================================================================
// v2 跨会话记忆(团队模式 v2 Phase 3, 设计稿 C0-C5)。文件型记忆库 + 起草-确认写入 + 围栏式渐进注入。
// 与 <project-memory>(CLAUDE.md,作者=仓库)分工(C0):本库作者=用户+AI 经确认,随工作台走。注入标签
// <workbench-memory>、UI 一律称「工作台记忆」。存储:dataRoot()/memory/{global,project/<projectKey>}/<id>.md。
// ============================================================================
const MEMORY_TYPES = new Set(['preference', 'convention', 'lesson', 'reference']);
const MEMORY_METADATA_READ_CAP = 16 * 1024;
const MEMORY_USAGE_TOUCH_MS = 60 * 60 * 1000; // 主动检索/读取最多每小时记一次 use
const MEMORY_RULE_TOUCH_MS = 24 * 60 * 60 * 1000; // 核心偏好/惯例被基础提示词采用时每天记一次隐式 use
// frontmatter 单行值消毒:去换行(parseFrontmatter 按行 key: value 解析,值里的换行会破坏结构)。
const MemoryStore = require('./backend/memory-store.cjs').createMemoryStore({
  paths, atomicWriteJson, safeJsonParse, SKILL_ID_RE, makeId, nowIso,
  limits: { MEMORY_TYPES, MEMORY_METADATA_READ_CAP, CORE_MEMORY_SUMMARY_CAP, MEMORY_USAGE_TOUCH_MS, MEMORY_RULE_TOUCH_MS },
});
const { fmVal, memoryGlobalDir, memoryProjectDir, projectKeyForCwd, cleanMemoryDate, memoryIsExpired,
  loadMemoryRegistry, listMemoryProjectGroups, readMemoryItem, saveMemory, deleteMemory } = MemoryStore;

const { createAgentInstructionImports, filterMemoryForNativeCli } = require('./backend/agent-instruction-imports.cjs');
const AgentInstructionImports = createAgentInstructionImports({
  paths, DurableJsonStore, agentCliHomes, tildePath, nowIso, logEvent, atomicWriteJson, store: MemoryStore,
  summaryCap: CORE_MEMORY_SUMMARY_CAP,
});
const { syncAgentInstructionImports } = AgentInstructionImports;

// ============================================================================
// R4 Local Memory Graph(设计稿 docs/optimization-plan/15-r4-memory-graph.md)。
// 给已确认工作台记忆加 supports/contradicts/supersedes/derived_from 关系边。模型只 propose(confirmed:false),
// 用户 confirm/delete。边按 scope+projectKey 隔离;pending 不进检索;confirmed contradicts 在注入时双向标记。
// 不建全局跨项目索引(evidenceRef 只存 eventId 不存原文,与 R1 同纪律)。
// ============================================================================
const MemoryRelations = require('./backend/memory-relations.cjs').createMemoryRelations({
  storage: { memoryGlobalDir, memoryProjectDir, readMemoryDir: MemoryStore.readMemoryDir, writeMemoryMeta: MemoryStore.writeMemoryMeta, atomicWriteJson },
  safeJsonParse, SKILL_ID_RE, makeId, nowIso, fmVal, logEvent, memoryIsExpired,
});
const { analyzeMemoryMaintenance, listMemoryRelations, proposeMemoryRelation, confirmMemoryRelation, deleteMemoryRelation,
  buildMemoryConflictMap, readConfirmedSupersedeEdges, extractMemoryRelationProposals, removeMemoryRelationsFor } = MemoryRelations;

const MemoryRecall = require('./backend/memory-recall.cjs').createMemoryRecall();
const { rankRelevantMemories } = MemoryRecall;

const { MEMORY_EXCLUSION_MAX, createMemorySelection, memorySelectionSignature } = require('./backend/memory-selection.cjs');
const MemorySelection = createMemorySelection({
  store: MemoryStore, prompts: MemoryPrompts, recall: MemoryRecall, relations: MemoryRelations, readConfig,
});
const { memoryExclusionSet, resolveCoreMemoryState, resolveMemoryPreflight } = MemorySelection;

const { memoryProposalLooksSensitive } = require('./backend/memory-sensitivity.cjs');
const MemoryMigrations = require('./backend/memory-migrations.cjs').createMemoryMigrations({
  paths, store: MemoryStore, removeMemoryRelationsFor, atomicWriteJson, SKILL_ID_RE,
  logEvent, nowIso, accMemoryImportStore, ACC_MEMORY_IMPORT_SCHEMA, legacyAccMemoryMigrationComplete,
});
const { moveMemoryScope, migrateLegacyAccMemory, migrateMemory } = MemoryMigrations;
const { resolveWorkbenchMemoryToolContext, listWorkbenchMemories, readWorkbenchMemory } = require('./backend/memory-tools.cjs').createMemoryTools({
  store: MemoryStore, selection: MemorySelection, recall: MemoryRecall, relations: MemoryRelations,
  activeChildren, loadSession, readConfig, safeSessionId, SKILL_ID_RE,
});
const MemoryProposals = require('./backend/memory-proposals.cjs').createMemoryProposals({
  paths, store: MemoryStore, relations: MemoryRelations, memorySearchTerms: MemoryRecall.memorySearchTerms, resolveWorkbenchMemoryToolContext,
  moveMemoryScope, activeChildren, loadSession, readConfig, safeSessionId, providerRawCompletion, appendUsageLedger,
  atomicWriteJson, makeId, nowIso, SKILL_ID_RE, MEMORY_TYPES,
});
const {
  proposeWorkbenchMemory, proposeMemoryRelationTool, proposeMemoryRevision, proposeMemoryRelationRevoke,
  draftMemoryFromSession, proposeMemoryFromSession, replayPendingMemoryProposal, decideMemoryProposal,
  applyMemoryRelationProposal, validateMemoryProposalSave,
  memoryProposalPrefilter, parseMemoryProposalDecision, memoryProposalSimilarity, memoryProposalIsDuplicate,
} = MemoryProposals;

// Mission orchestration depends on explicit storage, checks and model contracts.
const { buildMissionPromptSection, runMissionDriver, MISSION_DIGEST_CAP } = require('./backend/mission-driver.cjs').createMissionDriver({
  storage: { saveSession, sessionObjectIsStale },
  checks: { evaluateMissionCheck, recordMissionCheckResult, maybeFinalizeMission },
  model: { missionProgressDigest, MISSION_MAX_TEXT, MISSION_STALL_LIMIT },
  normalizeCwd, neutralizeFenceTag, getPromptPack, nowIso, logEvent,
});

const {
  missionRollbackTarget, missionBudgetRemaining, missionControlView,
  waitMissionTurnSettled, missionControlFailure, missionControlCommand,
} = require('./backend/mission-control.cjs').createMissionControl({
  storage: { loadSession, saveSession, mutateSession },
  checkpoints: { journalReadIndex, rewindSession },
  execution: {
    hasActiveTurn: id => activeChildren.has(id),
    getActiveTurn: id => activeChildren.get(id),
    hasActiveRun: id => activeAgentRuns.has(id),
    getTurnSettler: id => turnSettlers.get(id),
    stopSession, stopMissionAgentRuns, listAgentRuns,
  },
  model: { normalizeMission, normalizeMissionCheck, followupAcceptanceCriterion },
  lifecycle: { buildMissionResult, archiveMissionResult },
  events: { bumpMissionChangeSeq, logEvent },
  authorization: { revokeAllGrants },
  MISSION_DEFAULT_MAX_TURNS, MISSION_MAX_MILESTONES, MISSION_MAX_TEXT, nowIso, makeId,
});

// Resource scheduling is an explicit service; lease state is private to this runtime.
const { normalizeAgentResource, normalizeAgentResources, remapAgentResources, agentResourcesConflict, inferToolResources, acquireResourceLease, releaseResourceLease, resourceBlockers, bridgedDesktopLeaseMode } = require('./backend/resource-leases.cjs').createResourceLeases({
  makeId, nowIso,
});

// Explicit scheduler-core module.
const { SCHEDULER_CODE_CR, SCHEDULER_CODE_DEL, SCHEDULER_CODE_LF, SCHEDULER_CODE_SPACE, SCHEDULER_CODE_TAB, SCHEDULER_CREATORS, SCHEDULER_CRON_DAY_SCAN, SCHEDULER_DEFAULT_POLICY, SCHEDULER_DESCRIBE_KEYS, SCHEDULER_DOW_KEYS, SCHEDULER_FIRE_MODES, SCHEDULER_FORBIDDEN_PAYLOAD_KEYS, SCHEDULER_LIMITS, SCHEDULER_ON_FAILURE, SCHEDULER_ON_MISSED, SCHEDULER_OUTCOMES, SCHEDULER_PAYLOAD_KINDS, SCHEDULER_PHASES, SCHEDULER_SCHEDULE_KINDS, SCHEDULER_TARGET_MODES, SCHEDULER_TEXT_LF, SCHEDULER_TEXT_SPACE, SCHEDULER_THREAD_TIERS, SCHEDULER_WORKDIR_CHARS, SchedulerHooks, describeSchedule, missedOccurrence, nextFireAt, normalizeSchedulerTask, occurrenceKey, parseCronExpr, schedulerClampInt, schedulerCleanBlock, schedulerCleanLine, schedulerCronDayMatches, schedulerCronField, schedulerCronNextFireAt, schedulerDaysInMonth, schedulerFail, schedulerFindForbiddenKey, schedulerLocalMs, schedulerParseHhMm, schedulerParseYmd, schedulerStripControl } = require('./backend/scheduler-core.cjs').createSchedulerCore();

// ============================================================================
// 架构还债批 2 B2:配置补丁的落盘与副作用 —— 配置域的业务规则,不是传输层的事。
//
// applyConfigPatch 原先住在 13-http-router.js:掩码密钥冲突检测、toolbox- 服务商归属、服务商缩水自动备份 +
// 审计事件、Claude CLI / agent roles / MCP 同步触发,全是配置域的规矩;13l 的 steward_config_set 为了走同一条
// 落盘路径,只能回头伸进路由文件里调它。现在它住在这里,路由层只剩 body 解析与错误翻译。
//
// 为什么是一个排在 06j 之后的独立模块、而不是塞进 01-config.js:
//   · 它要调 02(rememberLastUsedEngineRoute / sessionEngineRouteFromConfig)、05(掩码三件)、06i(StewardHooks):
//     放在 01 里就是 01->02、01->06i 两条新前向边;放在这里全是后向边。
//   · 两个调用方(13、13l)若直接引用 applyConfigPatch,本模块就会经 13 -> 06k -> 01 被卷进唯一的大 SCC(已在
//     上限 32)。所以调用方经 01 的 ConfigPatchHooks 调(与 06j / 13t 同一个模具),本模块零入边、不进任何环。
// ============================================================================

// 第 116 波 116-2e:POST /api/config 的落盘与全部副作用,零行为抽出为 applyConfigPatch(body)。
// 为什么抽:`steward_config_set`(§3.5「如意设置」行)必须经【同一个落盘函数】写入 —— 116h 的
// arbiterRefresh、Claude CLI settings 同步、agent roles 同步、MCP 同步都挂在这条路径上,管家走
// 另一条路就会静默漏掉它们(「改了上限要等下一条线程跑完才生效」正是这种漏的样子)。
// 入参 body = 用户/管家提交的 patch(未 normalize);返回 writeConfig 之后已 normalize 的 next。
// 路由层(13 的 POST /api/config)只剩 body 解析与错误翻译、掩码回包;13l 的 steward_config_set 同样调它。
// 架构还债批 2 B2:从 13-http-router.js 原样搬到这里(同名、同行为)。两个调用方都经 01 的 ConfigPatchHooks 调,
// 不直接引用本模块的符号 —— 本模块因此零入边、挂在唯一大 SCC 之外(见文件头)。
async function applyConfigPatch(rawBody, options = {}) {
  // 116-3 B1(会话/权限口径子审查):把全局默认权限切到「全自动」此前【没有服务端门】——
  // §8.6 那条二次确认只由界面出,任何别的调用方(脚本、117 壳、管家自己)一个 POST 就能把全局
  // 默认档改成 auto/bypass。13d 的 PATCH /api/sessions/:id 早就有这道门(同一张
  // PERMISSION_MODES_REQUIRING_CONFIRM、同一个 permission.confirm_required 错误码),这里补齐另一半。
  // `confirm` 是请求级信号不是配置键,判完就从 patch 里剥掉,绝不能跟着 merged 落进 config.json。
  const raw = (rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)) ? rawBody : {};
  const confirmed = raw.confirm === true;
  const body = { ...raw };
  delete body.confirm;
  if (['privacyModeV1', 'privacyTechnicalV1', 'privacyRulesV1', 'privacyPolicyRecoveryRequiredV1', 'credentialEncryptionV1'].some(key => Object.hasOwn(body, key))) {
    throw Object.assign(new Error('Use the dedicated privacy settings endpoint.'), { code: 'privacy.dedicated_settings_required', statusCode: 409 });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'permissionMode')) {
    const requested = body.permissionMode == null ? '' : String(body.permissionMode);
    if (PERMISSION_MODES_REQUIRING_CONFIRM.includes(requested) && !confirmed) {
      throw Object.assign(new Error('switching the global default to full-auto requires an explicit confirm:true (it can change files and run commands while you are away)'), {
        code: 'permission.confirm_required', statusCode: 409, permissionMode: requested,
      });
    }
  }
  // 117n-M2:整段「读 current -> merge -> 落盘」搬进 mutateConfig 的临界区。外部契约与顺序不变
  // (确认门仍在读之前、三路同步仍在写之后),变的只是这段临界区不再能被并发的另一次配置改动
  //  穿插 —— 此前 /api/config 与 storage/policy、agent-roles、连接器启停彼此吞字段。
  const patched = await mutateConfig(async (current) => {
    // 设置回执的撤销与提议使用同一写锁比对现值，不能以锁外快照覆盖用户后来改的值。
    const expected = options.expected ? unmaskSecrets(options.expected, current) : null;
    if (expected && Object.keys(expected).some(key => JSON.stringify(current[key]) !== JSON.stringify(expected[key]))) {
      throw Object.assign(new Error('settings changed since this receipt; read the current values before changing them again'), { code: 'config.conflict', statusCode: 409 });
    }
    const merged = { ...current, ...body };
    // F2 (安全·防掩码覆盖): if the payload carries providers[] or searchBackend, any apiKey still the mask
    // (`••••…`) means the UI round-tripped the masked value from GET /api/status — restore the real key
    // from the same-id provider (or on-disk searchBackend) before persisting, so a save never wipes the
    // stored key. unmaskSecrets covers BOTH secret sites in one pass (v0.9-S9).
    // 107-S0:modelsApiKey 也在 GET /api/status 里掩码下发了,设置页把掩码原样回传 —— 同一处还原,否则一次保存就把
    // 真密钥写成「••••末四位」。
    // 107-S0b:externalMcpServers 的 env／headers／args 也在 GET /api/status(与 steward_config_get)里掩码下发了 ——
    // 调用方原样回传时同一处按 id＋键名还原;不还原的话残留掩码会被 sanitize 那道闸清空,等于一次保存抹掉连接器密钥。
    // 107-S2(46 号文 §5 ⑦b M5):启动向量闸。掩码回传只有在「密钥会去的地址一个都没变」时才算
    // 「用户没动这个框」;地址变了(或压根没有同 id 那一条)就整份拒绝、零写入,并如实告诉用户要重填
    // 哪几条的密钥 —— 不静默把旧密钥贴到新端点上(那是 M5 的洞),也不静默清空(那是用户看不见的丢失)。
    // 判据在 05 的 maskedSecretConflicts;它与 unmaskSecrets 读的是【同一份 current】(都在这个临界区里),
    // 所以不存在「检查用的是旧快照、落盘用的是新快照」那一类竞态。
    const conflicts = maskedSecretConflicts(body, current);
    if (conflicts.length) {
      throw Object.assign(new Error(maskedSecretConflictMessage(conflicts)), {
        code: 'config.masked_secret_vector_changed', statusCode: 409, conflicts,
      });
    }
    // 107-S2:modelsApiBase 也进这一组 —— 它自己可能带凭据(`?api_key=…`),下发时被 safeUrlForDisplay
    // 遮过,原样回传要对回真值;不写回的话一次保存就把它写成脱敏形(且 normalizeConfig 那道闸会清空它)。
    if ((body && Array.isArray(body.providers)) || (body && body.searchBackend && typeof body.searchBackend === 'object')
      || (body && typeof body.modelsApiKey === 'string') || (body && typeof body.modelsApiBase === 'string')
      || (body && Array.isArray(body.externalMcpServers))) {
      const restored = unmaskSecrets(body, current);
      if (Array.isArray(body.providers)) merged.providers = restored.providers;
      if (body.searchBackend && typeof body.searchBackend === 'object') merged.searchBackend = restored.searchBackend;
      if (typeof body.modelsApiKey === 'string') merged.modelsApiKey = restored.modelsApiKey;
      if (typeof body.modelsApiBase === 'string') merged.modelsApiBase = restored.modelsApiBase;
      if (Array.isArray(body.externalMcpServers)) merged.externalMcpServers = restored.externalMcpServers;
    }
    // 2026-09-21(用户真机,日志 config_providers_shrunk lost:['toolbox-asr-shim']):`toolbox-` 前缀的服务商归自动发现所有 ——
    // 04f syncToolboxProviders 增删它们,走 mutateConfig 不经这里。设置页整份保存上传的是一份【草稿快照】:页面加载时播种,
    // 而 toolbox 组件要晚一两秒才起好、才把自己的条目写进配置;快照里没有它,一次保存就把它撤掉,normalizeConfig 随即把
    // 指着它的语音识别选择清空 —— 用户看到的是「本地语音识别突然没了、设置里也不见、再配也配不上」。所以来件里的
    // toolbox- 条目一律以【现值】为准:改不了、造不出、也撤不掉(现值有、来件没有的补回末尾,位置照 04f)。
    // 停用／卸载才是撤走它的正途,那条路(04f)不经过本函数。只在来件真带了 providers 时做,别的保存一字不动。
    if (Array.isArray(body.providers) && Array.isArray(merged.providers)) {
      const isToolbox = p => Boolean(p && typeof p === 'object' && String(p.id || '').startsWith('toolbox-'));
      const owned = (Array.isArray(current.providers) ? current.providers : []).filter(isToolbox);
      const foreign = merged.providers.filter(p => !isToolbox(p));
      if (owned.length || foreign.length !== merged.providers.length) merged.providers = [...foreign, ...owned];
    }
    // Remember an explicitly-chosen model so it persists in the list even if the proxy later drops it.
    if (body && typeof body.model === 'string' && body.model && !(merged.knownModels || []).includes(body.model)) {
      merged.knownModels = [...(merged.knownModels || []), body.model];
    }
    // 2026-09-06 事故(用户的五个 Provider 连同密钥被一次整份保存写成 providers: [])后的服务端保险:
    // 现值有 Provider、来件要把它清成空数组时,先把当前 config 原样另存一份(config.json.bak-providers-
    // <时间戳>,与既有 config.json.bak-<日期> 同一目录同一命名族),并记一条审计事件。【不拦截】——
    // 逐个删除到最后一个也是合法的 [],这里只保证永远有得救。备份失败不阻塞写入。
    // 设置弹窗子审查追加：不只「清空」，任何【缩水】（现值里某个 id 在来件里没了）都先备份——用户以为在
    // 原有列表上加一条、实际把整份换成只剩一条，正是那种既不为空也没告警的丢法。
    if (Array.isArray(current.providers) && current.providers.length > 0 && Array.isArray(merged.providers)) {
      const nextIds = new Set(merged.providers.map(p => String((p && p.id) || '')));
      const lost = current.providers.map(p => String((p && p.id) || '')).filter(id => id && !nextIds.has(id));
      if (lost.length) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `config.json.bak-providers-${stamp}`;
        try {
          const backupPath = path.join(path.dirname(paths.config), backupName);
          await fsp.copyFile(paths.config, backupPath);
          await fsp.chmod(backupPath, 0o600).catch(() => {});   // 安全走查 S11:备份里是真 apiKey,只给属主读写
        } catch { /* 备份失败不阻塞写入 */ }
        logEvent({ kind: merged.providers.length === 0 ? 'config_providers_cleared' : 'config_providers_shrunk', before: current.providers.length, after: merged.providers.length, lost, backup: backupName });
      }
    }
    return { next: merged, value: current };
  });
  const next = patched.config;
  const current = patched.value; // 落盘前那一份(锁内读到的),下面的三路同步判「改没改」要用它
  // 133(用户 2026-09-21「切走了大模型就立刻从显存里卸掉」):整段识别的选择换了(换模型／换服务商／关掉)→ 04f 去打
  // 原来那个组件的 unload 路。fire-and-forget:保存的回包不等它;没登记 unload 路的组件只靠自己的空闲卸载。
  if (typeof ToolboxHooks.asrSelectionChanged === 'function') void ToolboxHooks.asrSelectionChanged(current, next).catch(() => {});
  // 116h(27 号文 §8.10「并发上限就地可调,改完立即生效,不需重启」):配置落盘后立刻唤醒线程仲裁器
  // 的队列 —— 仲裁器每次唤醒都重读配置(不缓存),但唤醒本身只由「入队/释放/插队」触发,没有这一行
  // 的话调大上限要等下一条线程跑完才生效。队列为空(含管家关着)时是无操作。
  if (typeof StewardHooks.arbiterRefresh === 'function') { try { StewardHooks.arbiterRefresh(); } catch { /* best-effort */ } }
  if (body && ['agentCliType', 'claudePath', 'kimiPath'].some(k => Object.prototype.hasOwnProperty.call(body, k))) {
    invalidateAgentCliPathCaches();
  }
  // 123-N2 合并复核（主会话）：用户在设置里改全局引擎（activeProvider／agentCliType／model）也是一次
  // 【显式选择】，要成为「上次用的」—— 否则改完全局、新开一条线程，仍跟着改之前的那一路走
  // （agent-team-mode.e2e 合并后串行必红：切回 Claude 驱动后新会话仍走上一轮的 fake 端点）。
  // 只在这三个键真的在 body 里时记；与现值相同则 rememberLastUsedEngineRoute 自己短路不落盘。
  // 【await 而不是 void】：保存请求回 200 之前记录就得落盘——调用方（设置页、e2e）改完全局马上
  // 新开线程是常见序列，fire-and-forget 会让那条新线程仍跟着上一路走（本机实测 agent-team-mode 就这么红）。
  if (body && ['activeProvider', 'agentCliType', 'model'].some(k => Object.prototype.hasOwnProperty.call(body, k))) {
    await rememberLastUsedEngineRoute(sessionEngineRouteFromConfig(next), next);
  }
  // v1.4.3: keep ~/.claude/ in sync — settings.json + agent roles + MCP servers
  if (body && (Object.prototype.hasOwnProperty.call(body, 'permissionMode') || Object.prototype.hasOwnProperty.call(body, 'model') || Object.prototype.hasOwnProperty.call(body, 'thinkingBudget') || Object.prototype.hasOwnProperty.call(body, 'appendSystemPrompt'))) {
    await syncClaudeCliSettings(next);
  }
  if (body && (Object.prototype.hasOwnProperty.call(body, 'agentRoleOverrides') || Object.prototype.hasOwnProperty.call(body, 'permissionMode'))) {
    await syncAgentRolesToClaude(next.defaultWorkspace || os.homedir(), next);
  }
  if (body && Object.prototype.hasOwnProperty.call(body, 'externalMcpServers')) {
    // hunt2-mcp:设置页整份保存改了哪条连接器(改命令 / 停用 / 删除 / 新增同 id),就作废那条的活进程、在途启动与
    // 60s 失败冷却 —— 修前只有启停/删除路由会作废,在这里改好一个坏连接器,旧冷却期内照样「连不上」,删掉的进程也还活着。
    const mcpById = list => new Map((Array.isArray(list) ? list : []).filter(x => x && x.id).map(x => [x.id, JSON.stringify(x)]));
    const beforeMcp = mcpById(current && current.externalMcpServers);
    const afterMcp = mcpById(next && next.externalMcpServers);
    for (const id of new Set([...beforeMcp.keys(), ...afterMcp.keys()])) {
      if (beforeMcp.get(id) !== afterMcp.get(id)) invalidateMcpRuntime(id);
    }
    await syncMcpServersToClaude(next);
    await syncAgentCliMcpManifests(next, null, { requireWorkbenchMcp: true });
  } else if (body && ['allowCommandTools', 'allowDesktopTools'].some(k => Object.prototype.hasOwnProperty.call(body, k)
      && (current && current[k]) !== (next && next[k]))) {
    // 2026-10 能力总闸:两个开关一变,写给 CLI 的直挂 ACC 条目里的 ACC_HIDE_TOOLS 就过时了 —— 推一次
    // Claude 的用户级条目与 Kimi 的 mcp.json(同一次保存里 externalMcpServers 也改了的话上面那支已经推过)。不等它:claude mcp
    // add-json 串行可达十几秒,开关的保存不该卡在这里;Kimi 每个回合起手还会再推一次(05b),这里只是把空窗缩短。
    void syncMcpServersToClaude(next).catch(() => {});
    void syncAgentCliMcpManifests(next, null, { requireWorkbenchMcp: true }).catch(() => {});
  }
  // 选中的 CLI 若从用户配置读 MCP(登记表 syncMcpManifest),推一次;从这样一家切走时把如意接管的条目清掉(见 01)。
  if (body && (Object.prototype.hasOwnProperty.call(body, 'agentCliType') || Object.prototype.hasOwnProperty.call(body, 'includeWorkbenchMcp'))) {
    await syncAgentCliMcpManifests(next, current);
  }
  return options.capture === true ? { config: next, previous: current } : next;
}

// 加载即登记:13 / 13l 只经这个键调(见 01 的 ConfigPatchHooks)。
ConfigPatchHooks.applyConfigPatch = applyConfigPatch;

const { fetchOpenAiModels, probeProviderCompletion } = require('./backend/provider-probes.cjs').createProviderProbes({
  providerWireProtocol, PrivacyGateway, extractContextLength, cacheContextLength,
});

const { bridgedToolTier, dropPolicyDisabledBridgedTools } = require('./backend/bridged-tool-policy.cjs');

const {
  MEMORY_WRITE_TOOL_NAMES, policySessionFor, policyDesktopOverrideFor, toolDisabledResult, nativeToolSchema,
  nativeToolsAcceptingArgKeys, buildOpenAiTools,
} = require('./backend/provider-tool-offer.cjs').createProviderToolOffer({
  sessions: { loadSession, sessionDesktopToolsOf },
  policy: { TOOL_TIER_RANK, isStewardToolName },
});

const { loopAbortExempt, loopWarnOnly, LOOP_GUARD_LIMITS } = require('./backend/tool-loop-policy.cjs');

const {
  NATIVE_TOOL_PACKS, toolPackForName, classifyToolPacks, buildToolCatalog, searchToolCatalog,
  compareToolRetrievalShadow, listCompactTools, toolArgsSkeleton, createToolLoader,
} = require('./backend/tool-catalog.cjs');
const createToolLoadingState = createToolLoader({ logEvent });
const { classifyRuntimeToolFailure } = require('./backend/runtime-tool-telemetry.cjs');

const { createNativeToolApproval, webPayloadReason } = require('./backend/native-tool-approval.cjs');
const { httpRequestInternalTargetReason, nativeToolGate } = createNativeToolApproval({
  network: { providerBaseIsLocalOrLan },
  steward: {
    stewardAutoAskIndirect, stewardAutoAskScanIncomplete, stewardAutoAskSensitiveKind,
    stewardToolPermanentlyExempt,
  },
});

const {
  toolIsRevertible, schedulerAskWaitSessions, schedulerAskWaitOverrideMs, requestNativePermission,
  looksLikePlan, requestPlanApproval,
} = require('./backend/native-approval-waiters.cjs').createNativeApprovalWaiters({
  pending: { pendingPermissions, pendingPlans },
  interventions: {
    makeId, promptWaitMs, registerIntervention, runAutomaticInterventionDecision, settleIntervention,
  },
});

PermissionWaitHooks.scheduler = schedulerAskWaitOverrideMs;

Object.assign(ProviderWireHooks, { makeId, redact, repairProviderHistoryPairing, repairProviderHistoryToolArgs });

const {
  ACTION_VIEW_TOOLS, ACTION_VIEW_MIN_CHARS, actionTargetMeta, projectActionModelView,
} = require('./backend/provider-action-history.cjs');

let openAiStreamOnce = require('./backend/provider-stream.cjs').createProviderStream({
  providerWireProtocolForBody, PrivacyGateway, DesktopExecutionHooks, isContextOverflowError,
});

const {
  hasInterruptingSteer, drainSteerQueue, STEER_QUEUE_MAX, MAIL_QUEUE_MAX, MAIL_TEXT_MAX, MAIL_PER_SENDER_MAX,
  neutralizeInjectedPrefixes,
} = require('./backend/agent-steering.cjs').createAgentSteering({
  sessions: { VisualPipeline, buildAttachmentPrompt, nowIso, saveSession },
});

const { projectCwdDirectoryFailure } = require('./backend/project-directory-check.cjs');

const { classifyClaudeSubagentFailure, runClaudeSubAgentOnce } = require('./backend/claude-subagent.cjs').createClaudeSubagent({
  runtime: {
    DesktopExecutionHooks, PrivacyGateway, ProcessRuntime, createNdjsonLineFeeder, existsExecutableAsync,
    killChildTree, logEvent, readConfig, safeJsonParse, withTransientRetry,
  },
  cli: {
    CONTEXT_OVERFLOW_PATTERNS, buildUserEnvelope, clampAgentRoleToParent, claudePermissionMode,
    decodeClaudeCliText, detectClaudePath, effectiveAnthropicEnv, generateAgentNodeMcpConfig, parseClaudeEvent,
  },
  turn: { appendResponseLanguagePolicy, appendUsageLedger, claudeCostFields },
});

const { gitExec, createAgentWorktree, finalizeAgentWorktree, applyAgentWorktree, cleanupAgentWorktree, cleanupAgentWorktreeForRetry } = require('./backend/agent-worktrees.cjs').createAgentWorktrees({
  paths, runGit, safeSessionId, nowIso, agentRunFile, saveAgentRun,
});

const { runSubAgent, runSubAgentCore } = require('./backend/subagent-runner.cjs').createSubagentRunner({
  logEvent, makeId, neutralizeInjectedPrefixes, normalizeCwd, nowIso,
  providers: {
    applyProviderReasoningEffort, cachedInputTokensFromUsage, computeProviderCost, isContextOverflowError,
    openAiStreamOnce, providerCallIsTransient, providerServerSearchCard, providerWireProtocol,
    withTransientRetry, runClaudeSubAgentOnce,
  },
  context: {
    appendResponseLanguagePolicy, buildProviderSystemPrompt, estimateBucketsEnabled, estimateContentTokens,
    estimateFactor: (...args) => estimateFactor(...args), estimateHistoryTokens,
    noteWindowOvershoot: (...args) => noteWindowOvershoot(...args), providerHistoryToolCalls,
    setEstimateBucketsV1, writeHistorySnapshot,
  },
  compaction: {
    maybeCompactSubHistory: (...args) => SessionCompaction.maybeCompactSubHistory(...args),
    recordCompactUsage: (...args) => recordCompactUsage(...args),
    runForcedOverflowCompaction: (...args) => runForcedOverflowCompaction(...args),
  },
  usage: { appendUsageLedger },
  memory: { MEMORY_WRITE_TOOL_NAMES, SubAgentMemoryHooks, readProjectMemory },
  tools: {
    LOOP_GUARD_LIMITS, TOOL_ITERATION_BUDGETS, TOOL_TIER_RANK, boundToolResultForDisplay, buildOpenAiTools,
    classifyToolPacks, isProviderToolArgsObject, loopAbortExempt, loopWarnOnly, nativeToolTier,
    providerWireOutputLimited, resolveToolIterationBudget, shouldExtendToolIterationBudget,
    toolCall: (...args) => toolCall(...args), toolFailureResult: (...args) => toolFailureResult(...args),
    toolPackForName, truncateToolResult,
  },
  bridge: {
    bridgedOfficeScriptGate, bridgedReadPathGate, bridgedServerUnavailableMessage, bridgedToolTier,
    bridgedWriteRelativePathArg, collectBridgedTools, dropPolicyDisabledBridgedTools, getBridgedClient,
    journalBridgedWrite, resolveBridge,
  },
  permissions: {
    clampAgentRoleToParent, liveSessionPermissionMode, nativeToolGate, pendingPermissions, permissionWaitMs,
    preflightWriteBoundary, requestNativePermission, runAutomaticInterventionDecision, sessionDesktopToolsOf,
    stewardAutoAskReason, toolDisabledByPolicy, toolDisabledResult, webPayloadReason,
  },
  resources: { acquireResourceLease, inferToolResources, normalizeAgentResources, releaseResourceLease },
  services: { DesktopExecutionHooks, PrivacyGateway, VisualPipeline, getCapabilities },
});

const { sanitizeAgentOutputSchema, structuredJsonCandidates, balancedJsonSpan, repairJson, parseStructuredAgentOutput, validateAgentJsonSchema, normalizeAgentGate, verdictPasses, structuredOfNode, aggregateAgentVote, findingHandledItems, aggregateCoverage, propagateAssignments, dedupeAgentFindings, EVIDENCE_REFS_MAX_ITEMS, QUALITY_GATE_OUTPUT_SCHEMA } = require('./backend/agent-quality.cjs');

const { evalWaitCondition } = require('./backend/workflow-wait.cjs').createWorkflowWait({
  guardWorkspacePath, httpGetGuarded, ssrfCheck,
});

const {
  agentRunCapabilities, agentRunRoster, materializePoolItem, nodeDeliveryEligibility, poolChainDepth,
} = require('./backend/agent-run-pool.cjs').createAgentRunPool({
  EventStreamHooks, MAIL_QUEUE_MAX, TOOL_TIER_RANK, activeAgentRuns, neutralizeInjectedPrefixes,
  normalizeAgentResources, resolveNodeModel,
});

const {
  agentEnvelopeArtifacts, agentRunResultSlice, buildAgentRunEnvelope, cutAtSentence, ownAgentMessageReceipt,
  readAgentRunRecord,
} = require('./backend/agent-run-envelope.cjs').createAgentRunEnvelope({
  EventStreamHooks, activeAgentRuns, agentRunCapabilities, agentRunFile, safeJsonParse, safeSessionId,
});

const {
  resolveAgentTeamRoute, orchestrateArgsProblem, orchestrateModelNotes, resolveOrchestrateFollowup,
  resolveOrchestrateNodes, singleAgentShorthandNode,
} = require('./backend/agent-workflow-input.cjs').createAgentWorkflowInput({
  neutralizeInjectedPrefixes, samePathKey,
  routing: { fetchOpenAiModels, providerBaseWithV1, resolveProvider },
  workflows: { agentEnvelopeArtifacts, getAgentWorkflows, readAgentRunRecord },
});

const {
  NODE_WRITE_FAMILY, deriveNodeOutputs, evaluateNodeToolEvidence, evaluateWorkflowCondition,
  workflowProgressFingerprint,
} = require('./backend/workflow-node-outcomes.cjs').createWorkflowNodeOutcomes();

const { runWorkspaceHash, workflowDependencyClosure, buildNodeEvidenceCatalog, formatNodeEvidencePrompt, indexNodeEvidence, purgeNodeEvidence, verifyNodeClaims } = require('./backend/agent-evidence.cjs').createAgentEvidence({ redact, nowIso });

const {
  buildUpstreamContext, summarizeAgentWorkflowRun, recordAgentNodeProgress,
} = require('./backend/agent-workflow-report.cjs').createAgentWorkflowReport({
  appendAgentRunEvent, estimateContentTokens, nowIso,
});

const { computeSchedulerStep, computeWaveSeq } = require('./backend/workflow-scheduler.cjs');

const { proposeReplanPatch, recordNodeContinuation, validateReplanPatch, applyReplanPatch } = require('./backend/replan-ledger.cjs').createReplanLedger({
  hashArgs, makeId, nowIso, TOOL_TIER_RANK,
});

// 子代理核心胶囊的实现(口住 00-boot 的 SubAgentMemoryHooks,理由见那里)。只取【核心】:relevance 压到 0,相关召回是按主线那句话排的,
// 子任务是另一件事,顺带也让 preflight 不给没注入的条目记 use。走 parentSession:会话级排除 / 固定选择 / 关闭记忆同样管着子代理。
Object.assign(SubAgentMemoryHooks, {
  async coreSnapshot({ parentSession, workingDir, task, config }) {
    const preflight = await resolveMemoryPreflight(parentSession, workingDir, String(task || ''), undefined, { ...config, memoryRelevanceMaxV1: 0 }, {});
    const entries = Array.isArray(preflight.coreEntries) ? preflight.coreEntries : [];
    return { entries, conflicts: entries.length ? await buildMemoryConflictMap(workingDir).catch(() => null) : null };
  },
});

const agentWorkflowPorts = {
  activeAgentRuns, sessionSaveIsTombstoned, safeSessionId, makeId, nowIso,
  runs: AgentRunStore,
  worktrees: { createAgentWorktree, finalizeAgentWorktree, cleanupAgentWorktree, cleanupAgentWorktreeForRetry },
  roles: {
    agentNodeContextWindow: (...args) => agentNodeContextWindow(...args),
    getAgentRoleLibrary, resolveAgentTeamRoute, resolveNodeModel,
  },
  memory: {
    buildMemoryCheckPrompt, buildMemoryConflictMap, buildMemoryPromptSection, extractMemoryRelationProposals,
    filterMemoryForNativeCli, proposeMemoryRelation, resolveMemoryPreflight,
  },
  evidence: { formatNodeEvidencePrompt, indexNodeEvidence, purgeNodeEvidence, verifyNodeClaims },
  nodes: {
    buildUpstreamContext, deriveNodeOutputs, evalWaitCondition, evaluateNodeToolEvidence, evaluateWorkflowCondition,
    recordAgentNodeProgress, repairNodeJsonViaProvider, runSubAgent, summarizeAgentWorkflowRun, workflowProgressFingerprint,
  },
  team: {
    agentRunRoster, materializePoolItem, nodeDeliveryEligibility, ownAgentMessageReceipt, poolChainDepth,
    MAIL_PER_SENDER_MAX, MAIL_QUEUE_MAX, MAIL_TEXT_MAX,
  },
  replan: { proposeReplanPatch, recordNodeContinuation, validateReplanPatch },
  resources: { normalizeAgentResources, remapAgentResources },
  interventions: { registerIntervention, settleIntervention },
  hooks: { DesktopExecutionHooks, EventStreamHooks },
};
const AgentWorkflow = require('./backend/agent-workflow.cjs').createAgentWorkflow(agentWorkflowPorts);
function runAgentWorkflow(options) { return AgentWorkflow.runAgentWorkflow(options); }

const AgentResults = require('./backend/agent-results.cjs').createAgentResults({
  records: { readAgentRunRecord, buildAgentRunEnvelope },
  delivery: {
    pendingAgentMessages: (...args) => EventStreamHooks.pendingAgentMessages?.(...args),
    isAgentEnvelopeDelivered: (...args) => EventStreamHooks.isAgentEnvelopeDelivered?.(...args),
    markAgentEnvelopeDelivered: (...args) => EventStreamHooks.markAgentEnvelopeDelivered?.(...args),
    notifyAgentRunEnvelope: (...args) => EventStreamHooks.notifyAgentRunEnvelope?.(...args),
  },
  subscribe: listener => RUYI_EVENTS.subscribe(listener), safeSessionId, logEvent,
});
const { AGENT_RUN_TERMINAL, WAIT_AGENTS_DEFAULT_MS, WAIT_AGENTS_MAX_MS } = AgentResults;
function waitAgentsMaxMs(...args) { return AgentResults.waitAgentsMaxMs(...args); }
function resolveWaitAgentsMs(...args) { return AgentResults.resolveWaitAgentsMs(...args); }
function waitForAgentRunResults(...args) { return AgentResults.waitForAgentRunResults(...args); }
function settleWaitEnvelopes(...args) { return AgentResults.settleWaitEnvelopes(...args); }
function deliverAgentRunEnvelope(...args) { return AgentResults.deliverAgentRunEnvelope(...args); }

// 旧 spawn_agent 调用 → 单节点 orchestrate 参数(dependsOn 在单节点里无意义,提示改为一次 orchestrate 的 nodes)。
function legacySpawnToOrchestrateArgs(args) {
  const a = args && typeof args === 'object' ? args : {};
  // 旧模型常把任务写在 prompt / description 里(Claude Code Task 工具的字段名):修前只认 task,于是零节点启动,
  // 还配着一句「本次已按单节点代理执行」的说明。
  const out = { task: a.task != null ? a.task : (a.prompt != null ? a.prompt : a.description), background: a.background === true };
  for (const k of ['role', 'agentKey', 'toolTier', 'maxIters', 'model', 'resources']) if (a[k] != null) out[k] = a[k];
  return out;
}
const LEGACY_SPAWN_NOTE = 'spawn_agent 已并入 orchestrate_agents(本次已按单节点代理执行)。下次请直接调用 orchestrate_agents({task, role?, background?});多代理依赖请在同一次调用的 nodes 里用 dependsOn 表达。';

const launchPersistedAgentRun = require('./backend/persisted-agent-launch.cjs').createPersistedAgentLaunch({
  activeAgentRuns, activeChildren, agentRunFile, safeJsonParse, nowIso, readConfig,
  loadSession, mutateSession, runs: AgentRunStore, EventStreamHooks,
  runAgentWorkflow: options => runAgentWorkflow(options), deliverAgentRunEnvelope,
});

const ToolPolicy = require('./backend/tool-policy.cjs').createToolPolicy({
  TOOL_TIER_RANK, resolveBridge, bridgedToolTier, nativeToolTier,
});
function unwrapProxiedControlCall(...args) { return ToolPolicy.unwrapProxiedControlCall(...args); }
function canonicalToolInvokeCall(...args) { return ToolPolicy.canonicalToolInvokeCall(...args); }
function retierToolInvokeCall(...args) { return ToolPolicy.retierToolInvokeCall(...args); }
function planDiscoveryToolBatchAllowed(...args) { return ToolPolicy.planDiscoveryToolBatchAllowed(...args); }
function planParallelReadIsland(...args) { return ToolPolicy.planParallelReadIsland(...args); }

const runOpenAiTurn = require('./backend/provider-turn.cjs').createProviderTurn({
  appendUsageLedger, cwdWarning, isStewardToolName, logEvent, makeId, nowIso, readConfig, safeSessionId,
  session: {
    loadSession, saveSession, saveTurnFinalSession, sessionDesktopToolsOf, isUntitledSessionTitle,
    normalizeTodoItems, liveSessionPermissionMode,
  },
  history: {
    providerHistoryToolCalls, isProviderToolArgsObject, repairProviderHistoryPairing,
    repairProviderHistoryToolArgs, syncProviderHistoryFromDisplay, writeHistorySnapshot,
  },
  ownership: {
    activeChildren, assertSessionExecutionOwner, registerSessionExecutionChild, appendLiveTail,
    installActiveChildEventFanout, stopSession, drainSteerQueue, hasInterruptingSteer,
  },
  provider: {
    openAiStreamOnce: (...args) => openAiStreamOnce(...args),
    withTransientRetry, providerCallIsTransient,
    isContextOverflowError, providerWireProtocol, applyProviderReasoningEffort,
    providerServerSearchCard, providerWireContentFiltered, providerWireContextExceeded,
    providerWireOutputLimited,
  },
  prompts: {
    buildStableSystemPrompt, buildVolatileParts, buildModelHint, getAgentRoleLibrary, getAgentWorkflows,
    getCapabilities, resolveEnabledSkillEntries, loadAllPlaybooks, localTurnTimeParts,
  },
  memory: {
    MemoryStore, buildMemoryConflictMap, buildMemoryTurnSection, memoryExclusionSet, memoryIsExpired,
    memorySelectionSignature, readConfirmedSupersedeEdges, resolveMemoryPreflight, readSessionNotes,
    maybeWriteSessionNotes, readSessionScratchpad,
  },
  compaction: {
    setEstimateBucketsV1, estimateContentTokens, estimateHistoryTokens, estimateToolSchemaTokens,
    providerContextWindow: (...args) => providerContextWindow(...args),
    estimateFactor: (...args) => estimateFactor(...args),
    noteEstimateSample: (...args) => noteEstimateSample(...args),
    noteWindowOvershoot: (...args) => noteWindowOvershoot(...args),
    buildObservationRecallPrompt: (...args) => buildObservationRecallPrompt(...args),
    maybeAutoCompact: (...args) => maybeAutoCompact(...args),
    runForcedOverflowCompaction: (...args) => runForcedOverflowCompaction(...args),
    recordCompactUsage: (...args) => recordCompactUsage(...args),
    upsertCompactMarker: (...args) => upsertCompactMarker(...args),
  },
  permissions: {
    clearPendingPermissions, clearPendingPlans, clearPendingQuestions, hasPendingPermissionForSession,
    hasPendingQuestionForSession, looksLikePlan, permissionWaitMs, requestNativePermission,
    requestPlanApproval, requestUserQuestion, nativeToolGate, consumeGrant,
  },
  tools: {
    buildOpenAiTools, compareToolRetrievalShadow, createToolLoadingState, nativeToolTier,
    canonicalToolInvokeCall, planDiscoveryToolBatchAllowed, planParallelReadIsland, retierToolInvokeCall,
    unwrapProxiedControlCall, toolDisabledResult, classifyRuntimeToolFailure, acquireResourceLease,
    inferToolResources, releaseResourceLease, LOOP_GUARD_LIMITS, loopAbortExempt, loopWarnOnly,
    ACTION_VIEW_MIN_CHARS, ACTION_VIEW_TOOLS, actionTargetMeta, projectActionModelView,
    boundToolResultForDisplay, webPayloadReason,
    validateNativeToolArgs: (...args) => validateNativeToolArgs(...args),
    toolCall: (...args) => toolCall(...args),
    toolFailureResult: (...args) => toolFailureResult(...args),
  },
  bridge: {
    bridgedOfficeScriptGate, bridgedReadPathGate, bridgedServerUnavailableMessage, bridgedToolTier,
    dropPolicyDisabledBridgedTools, resolveBridge,
    collectBridgedTools: (...args) => collectBridgedTools(...args),
    getBridgedClient: (...args) => getBridgedClient(...args),
  },
  agents: {
    activeAgentRuns, AGENT_RUN_TERMINAL, agentRunCapabilities, agentRunResultSlice, agentRunRoster,
    buildAgentRunEnvelope, deliverAgentRunEnvelope, LEGACY_SPAWN_NOTE, legacySpawnToOrchestrateArgs,
    MAIL_PER_SENDER_MAX, MAIL_TEXT_MAX, orchestrateArgsProblem, orchestrateModelNotes,
    ownAgentMessageReceipt, readAgentRunRecord, resolveOrchestrateFollowup, resolveOrchestrateNodes,
    resolveWaitAgentsMs, saveAgentRun, settleWaitEnvelopes, waitForAgentRunResults,
    runAgentWorkflow: (...args) => runAgentWorkflow(...args),
  },
  missions: {
    applyMissionUpdate, bumpMissionChangeSeq, finalizeMissionAfterTurn, mergeMissionBeforeSave,
    recordMissionBudgetTrippedChange, recordMissionStalledChange, normalizeMetaToolArgs,
  },
  checkpoints: {
    captureWorkspaceTurnBaseline, reconcileWorkspaceTurnBaseline, journalReadIndex, journalRevertNoticesAck,
    journalRevertNoticesPeek, preflightWriteBoundary,
    journalBridgedWrite: (...args) => journalBridgedWrite(...args),
  },
  hooks: {
    AgentLoopHooks, DeliveryHooks, DesktopExecutionHooks, EventStreamHooks, PrivacyGateway, StewardHooks,
    VisualPipeline, RUYI_EVENTS,
  },
});

// Boot recovery restarts runs through the actual workflow launcher.
const AgentRecovery = require('./backend/agent-recovery.cjs').createAgentRecovery({
  paths, isWriteTool: name => NODE_WRITE_FAMILY.has(name), safeSessionId, nowIso,
  sessions: { readSessionHeadResilient, applySessionPermissionModeOverride, resolvePermissionMode },
  runs: { listAgentRuns, syncRunEventSeq, appendAgentRunEvent, saveAgentRun },
  execution: { hasLiveRun: id => activeAgentRuns.has(id), launchPersistedAgentRun },
  interventions: { settleIntervention, readInterventions, registerIntervention },
  readConfig, notifyInterruptedRun: run => EventStreamHooks.notifyAgentRunEnvelope?.(run.sessionId, run, buildAgentRunEnvelope(run)),
});
const { autoResumeInterruptedRuns, markInterruptedAgentRuns } = AgentRecovery;

const CONTEXT_GOVERNANCE_RULES = require('./backend/context-governance-rules.json');
if (CONTEXT_GOVERNANCE_RULES.schema !== 1) throw new Error('unsupported context-governance-rules schema');
const { COMPACTION_TOOL_INDEX_HEADER, historyUnitStarts } = require('./backend/provider-history.cjs');
const { providerContextWindow, noteEstimateSample, estimateFactor, noteWindowOvershoot, learnedWindowCap, calibratedEstimate } =
  require('./backend/context-calibration.cjs').createContextCalibration({
    DurableJsonStore, dataDirectory: () => paths.data, logEvent, nowIso, estimateHistoryTokens, resolveContextWindow,
  });
const {
  buildObservationRecallPrompt, evaporateBudgetBoundary, fileReadDedupKey, dedupeRepeatedReads,
  evaporateHistory, measureObservationReductionShadow, reduceObservationContent,
} = require('./backend/observation-reduction.cjs').createObservationReduction({ estimateHistoryTokens });
const { createCompactionRefetchGuard, compactionRefetchRefusal, compactionRefetchWarning } = require('./backend/compaction-refetch.cjs');

const { SUMMARY_PROMPT, SUMMARY_PROMPT_EN, summaryPromptWithGuidance,
  summarySectionLocations, validateStructuredSummary } = require('./backend/summary-format.cjs');

const { extractSummaryEntities, checkSummaryEntities, buildSummaryFactTableMessages,
  summaryTaskSourceHistory, extractSummaryTaskEvidence } = require('./backend/summary-evidence.cjs');
const { createProviderSummary, buildSummaryRefineMessages, summaryMaxConcurrent, mapSummaryWithLimit } =
  require('./backend/provider-summary.cjs');
const { providerSummaryCall, fitHistoryForSummary, chunkHistoryByBudget,
  summarySingleShotCap, summarySingleShotReserveTokens, resolveSummaryCallPolicy } = createProviderSummary({
  providerWireProtocol, normalizeProviderApiStyle, providerBaseWithV1,
  resolveContextWindow, providerContextWindow, fetchOpenAiModels, isContextOverflowError,
  estimateHistoryTokens, estimateTextTokens, PrivacyGateway, DesktopExecutionHooks, readConfig, logEvent,
});

const { createCompactionRouting, resolveCompactionProvider, lastSessionContextTokens,
  contextWindowOverrideKey, configuredConversationWindow } = require('./backend/compaction-routing.cjs');
const { compactHistoryFromSession, providerConversationContextWindow, agentNodeContextWindow, agentConversationContextMeta } =
  createCompactionRouting({ resolveContextWindow, providerContextWindow, PrivacyGateway, agentCliContextWindowProbes: AGENT_CLI_CONTEXT_WINDOW_PROBES });
const { createCompactionRecords, COMPACT_MARKER_MIN_SAVED_TOKENS } = require('./backend/compaction-records.cjs');
const { recordCompactUsage, openCompactMarker, upsertCompactMarker } = createCompactionRecords({
  estimateContentTokens, fmtTokensServer, appendUsageLedger, nowIso,
});
const { createCompactionPlan, compactionTaskText, buildCompactionToolIndex,
  COMPACT_RESEED_TAIL_MAX_TOKENS } = require('./backend/compaction-plan.cjs');
const { CompactionPlan, recentTurnsBoundary, recentFileReads } = createCompactionPlan({
  estimateHistoryTokens, estimateTextTokens, providerContextWindow, providerConversationContextWindow,
});

const CompactionKernel = require('./backend/compaction-kernel.cjs').createCompactionKernel({
  CompactionPlan, estimateHistoryTokens, calibratedEstimate, evaporateHistory, measureObservationReductionShadow,
  providerSummaryCall, repairProviderHistoryPairing, PrivacyGateway, logEvent,
});
const { runForcedOverflowCompaction } = CompactionKernel;
const SessionCompaction = require('./backend/session-compaction.cjs').createSessionCompaction({
  kernel: CompactionKernel, CompactionPlan, estimateHistoryTokens, estimateContentTokens, calibratedEstimate, evaporateHistory,
  readConfig, configForSessionEngineRoute, loadSession, saveSession, mutateSession, sessionObjectIsStale, writeHistorySnapshot,
  providerSummaryCall, providerConversationContextWindow, agentConversationContextMeta, compactHistoryFromSession,
  buildOpenAiTools, buildStableSystemPrompt, sessionDesktopToolsOf,
  recordCompactUsage, upsertCompactMarker, maybeWriteSessionNotes, PrivacyGateway, StewardHooks, logEvent, nowIso,
});
const { runAgentExternalCompact, runProviderCompact, maybeAutoCompact } = SessionCompaction;

// Compose shared session admission and background wake above the execution engines.
const SessionTurnRuntime = require('./backend/session-turn-runtime.cjs').createSessionTurnRuntime({
  readConfig, safeSessionId, makeId, nowIso, logEvent,
  sessions: { createSession, loadSession, rememberLastUsedEngineRoute, sessionMessagesDelta, sessionMessagesStamp, sessionMissionId, sessionTodosSignature, updateSessionMeta },
  routing: { configForSessionEngineRoute, inferSessionEngineRoute, normalizeSessionEngineRoute, sessionEngineRouteFromConfig, sessionEngineRouteScopeOverrides },
  execution: { activeChildren, turnSettlers, turnOutcomePending, driverAutoSessions, assertSessionExecutionOwner, recordSessionExecutionOwner, requestSessionExecutionStop, sessionExecutionSnapshot, stopSession, SessionExecutionHooks, DesktopExecutionHooks },
  engines: { runOpenAiTurn, runClaudeTurn, runProviderCompact, maybeWriteThreadBrief, settleThreadBrief },
  mission: { runMissionDriver, bindDriverRun, endDriverRun, revokeGrantsForRun },
  steward: { STEWARD_SESSION_ID, StewardHooks, stewardTaintToolCall, stewardWatchedThread },
  EventStreamHooks, PrivacyCore, PrivacyGateway,
});
const { runSessionTurn, runProviderCompactTracked, scheduleAgentWakesAtBoot } = SessionTurnRuntime;

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

// Explicit shared file-text-io service.
const { FileTextIo } = require('./backend/file-text-io.cjs');

// Native media service; all subprocesses use the shared Mac supervisor.
const FileVisualIo = require('./backend/file-visual-io.cjs').createFileVisualIo({ ProcessRuntime });

// Native media service; all subprocesses use the shared Mac supervisor.
const MediaInspection = require('./backend/media-inspection.cjs').createMediaInspection({ ProcessRuntime });

const { accCpName, buildNonAsciiReport, accAnnotateNonAscii, detectTextLineEnding, normalizeTextLineEndings, hasTextLineBreak, isUtf8Encoding, defaultTextLineEnding, textFileWantsUtf8Bom, UTF8_BOM_BYTES } = require('./backend/file-text-format.cjs');

const {
  fileToolWriteLockKey, journalCheckpointWarn, withFileToolWriteLock,
} = require('./backend/file-tool-mutations.cjs').createFileToolMutations();

const { httpRequestTargetsWorkbench, openToolUncDenied } = require('./backend/tool-target-policy.cjs').createToolTargetPolicy({
  RUNTIME, readConfig, remoteUncDenialResolved,
});

const {
  invokeAdaptiveMcpTool, toolArgsMissingRequired, toolInvokeMissingNameResult, withToolArgsGuide,
} = require('./backend/adaptive-tool-invocation.cjs').createAdaptiveToolInvocation({
  DesktopExecutionHooks, loadSession, readConfig,
  catalog: { adaptiveCatalogForMcp, nativeToolsAcceptingArgKeys, toolArgsSkeleton },
  dispatch: {
    isControlPlaneToolName: (...args) => isControlPlaneToolName(...args),
    suggestToolNames: (...args) => suggestToolNames(...args), toolCall: (...args) => toolCall(...args),
    toolFailureResult: (...args) => toolFailureResult(...args),
  },
  bridge: {
    bridgedOfficeScriptGate, bridgedReadPathGate, bridgedServerUnavailableMessage, bridgedToolTier,
    bridgedWriteRelativePathArg, getBridgedClient, journalBridgedWrite, resolveBridge,
  },
  policy: {
    TOOL_TIER_RANK, isStewardToolName, policyDesktopOverrideFor, runtimeToolRequirementsMet,
    toolDisabledByPolicy, toolDisabledResult,
  },
});

const { computeHealth } = require('./backend/workbench-health.cjs').createWorkbenchHealth({
  OVERLAY_ID, ProcessRuntime, appDirectory: __dirname, externalRoot, externalServerJs, paths, staticBase,
  probes: {
    agentCliLauncherOk, commandForSelfMcp, ensureDesktopMcpWarm, peekCapabilities, probeRgAsync,
    resolveExternalMcpServers, selectedAgentCli,
  },
});

const { INTEGRATION_TOOL_HANDLERS, loadSkillRegistry } = require('./backend/integration-tool-handlers.cjs').createIntegrationToolHandlers({
  SkillRegistry, defaultConfig, normalizeCwd, policySessionFor, readConfig, realpathForContainment,
  skills: { effectiveSkillSelection, getCapabilities, neutralizeAuthoredText },
  playbooks: {
    listPlaybooksWithAvailability, loadAllPlaybooks, stewardAssemblePlaybookPrompt,
    stewardPlaybookMissingInputs,
  },
  mcp: { configureMcpFromTool, safeMcpInventory },
});

const { buildWorkbenchSelfStatus } = require('./backend/workbench-self-status.cjs').createWorkbenchSelfStatus({
  RUNTIME, ProcessRuntime, buildRuntimeIdentityFacts, computeHealth,
  nativeToolCount: () => Object.keys(TOOL_HANDLERS).length, readConfig,
  catalog: { BUILTIN_AGENT_WORKFLOWS, getAgentWorkflows, getCapabilities, loadSkillRegistry },
  providers: { activeOpenAiProvider, providerWireProtocol, resolveAsrProvider, selectedAgentCli },
});

const { CORE_TOOL_HANDLERS } = require('./backend/workbench-core-tools.cjs').createWorkbenchCoreTools({
  RUNTIME, httpRequest, loadSession, logEvent, nowIso, readConfig, safeJsonParse, safeSessionId,
  buildWorkbenchSelfStatus,
  memory: {
    listWorkbenchMemories, proposeMemoryRelationRevoke, proposeMemoryRelationTool, proposeMemoryRevision,
    proposeWorkbenchMemory, readWorkbenchMemory,
  },
  context: {
    SESSION_SCRATCHPAD_LIMITS, boundedReadPage, normalizeScratchpadKey, normalizeScratchpadText,
    normalizeTodoItems, observationRecallEnabled, providerTurnQuotaKey, readSessionScratchpad,
    rehydrateObservation, scratchpadTotalChars, updateAutomaticThreadTitle, updateSessionScratchpad,
  },
  journal: { JOURNAL_KEEP_TURNS, journalReadIndex, journalRevertLogRead },
  catalog: {
    adaptiveCatalogForMcp, compareToolRetrievalShadow, invokeAdaptiveMcpTool, listCompactTools,
    policyDesktopOverrideFor, searchToolCatalog,
  },
});

const { STEWARD_TOOL_HANDLERS } = require('./backend/steward-tool-handlers.cjs').createStewardToolHandlers({
  StewardHooks,
});

const { FILE_TOOL_HANDLERS, ARCHIVE_TOOL_HANDLERS, fileToolBeforeForCheckpoint, fileToolPrivacySourceOptions, fileToolFsFailure, guardedWalkRoot, respellWalkPaths, toolRootProblem } = require('./backend/file-tools.cjs').createFileTools({
  paths: { fileToolWorkspaceDir, resolveFileToolPath, resolveFileToolRoot, guardFileToolPath, pathWithinRoot, isSensitiveDataPath, isSensitiveHardlinkAlias, sensitiveFileIdentities },
  checkpoints: { JOURNAL_MAX_BEFORE_BYTES, journalCheckpointWarn, journalDropEntries, journalRecord, journalRecordMany, journalSessionCtx },
  source: { FileVisualIo, MediaInspection, PrivacyGateway, privacyReadTextWindow, privacySourceActive, privacySourceLine, privacySourceLineOffsets, privacySourceMark, sourceViewOf },
  search: { explicitAllowDirs, prunedDirsHint, searchFileContent, walkDepthHint, walkEnvelopeEntries, walkFiles, walkTruncationHint },
  archive: { zipCollectEntries },
  runtime: { execResultCacheEnabled, execResultCacheMaxEntries, externalRoot, logEvent, readConfig, toolCall: (...args) => toolCall(...args) },
  mutations: { fileToolWriteLockKey, withFileToolWriteLock },
});

const { SHELL_TOOL_HANDLERS, resolveGitToolCwd } = require('./backend/shell-tool-handlers.cjs').createShellToolHandlers({
  DesktopShell, OFFICE_WRITER_LIB_RE, RUNTIME, makeId, paths, readConfig,
  policy: { guardFileToolPath, guardWorkspaceExecute, resolveExecCwd, shellMcpChildGuard },
  shells: { shellKill, shellList, shellPoll, shellSend, shellStart },
});

const { DESKTOP_TOOL_HANDLERS, attachScreenshotImage } = require('./backend/desktop-tool-handlers.cjs').createDesktopToolHandlers({
  FileTextIo, MacDesktopAutomation, VisualPipeline, REVEAL_OPEN_SAFE_EXTS, UNC_DENIED_ERROR, paths,
  launch: { buildOpenSpawn, buildRevealSpawn, spawnDetachedChecked },
  policy: { guardFileToolPath, openToolUncDenied, resolveFileToolPath },
});

const { httpDownloadTool, guardDownloadDest } = require('./backend/http-download.cjs').createHttpDownload({
  guardFileToolPath, loadSession, isMcpChild: () => RUNTIME.isMcpChild,
  fileToolBeforeForCheckpoint, journalSessionCtx, journalRecord, journalCheckpointWarn,
  markNetworkOnline,
});

const { NETWORK_TOOL_HANDLERS } = require('./backend/network-tool-handlers.cjs').createNetworkToolHandlers({
  UNC_DENIED_ERROR, readConfig, httpDownloadTool, httpRequest, webFetch, webSearch,
  launch: { buildBrowserOpenSpawn, isBrowserDocumentTarget, spawnDetachedChecked },
  policy: { httpRequestTargetsWorkbench, openToolUncDenied },
});

const { CODE_TOOL_HANDLERS } = require('./backend/code-tool-handlers.cjs').createCodeToolHandlers({
  readConfig, dataProfile,
  search: {
    claudeMdAudit, codeReviewScan, codebaseSymbolSearch, debugHypothesis, dependencyInventory, docsSearch,
    frontendAudit,
  },
  paths: {
    fileToolFsFailure, fileToolPrivacySourceOptions, guardFileToolPath, guardedWalkRoot, resolveFileToolPath,
    resolveFileToolRoot, respellWalkPaths, toolRootProblem,
  },
  git: { gitCommit, gitDiff, gitLog, gitStatus, resolveGitToolCwd },
  asr: { ASR_MAX_BODY_BYTES, resolveAsrProvider, transcribeAudioViaProvider, voiceLexiconAsrPromptFor },
});

const { AGENT_TOOL_HANDLERS } = require('./backend/agent-tool-handlers.cjs').createAgentToolHandlers({
  RUNTIME, httpRequest, safeJsonParse,
});

const { TOOL_HANDLERS, isControlPlaneToolName, suggestToolNames, unknownToolError, toolFailureResult, jsonSchemaTypeName, jsonSchemaValueProblems, jsonSchemaObjectProblems, jsonSchemaCoerceValue, jsonSchemaCoerceObject, validateNativeToolArgs, toolCall } = require('./backend/tool-dispatcher.cjs').createToolDispatcher({
  groups: [CORE_TOOL_HANDLERS, FILE_TOOL_HANDLERS, ARCHIVE_TOOL_HANDLERS, SHELL_TOOL_HANDLERS, DESKTOP_TOOL_HANDLERS, NETWORK_TOOL_HANDLERS, CODE_TOOL_HANDLERS, AGENT_TOOL_HANDLERS, INTEGRATION_TOOL_HANDLERS, STEWARD_TOOL_HANDLERS],
  levenshtein, isStewardToolName, nativeToolSchema, DesktopExecutionHooks, PrivacyGateway, readConfig, NATIVE_COMMAND_TOOL_NAMES, NATIVE_DESKTOP_TOOL_NAMES, policySessionFor, nativeToolDisabledByPolicy, sessionDesktopToolsOf, toolDisabledResult, normalizeToolInvokeArgs, toolInvokeMissingNameResult, normalizeMetaToolArgs, ProcessRuntime, makeId, FileTextIo,
});

const handleChatApiRoute = require('./backend/http-chat-stream.cjs').createChatApiRoute({
  runSessionTurn, PrivacyGateway, safeSessionId, nowIso,
});

const handleToolApiRoutes = require('./backend/tool-routes.cjs').createToolRoutes({
  TOOL_HANDLERS, loadSession, readConfig, toolCall,
});

const buildUsageSummary = require('./backend/usage-summary.cjs').createUsageSummary({
  readConfig, forEachUsageRow, usageRangeLowerMs, usageDayKeyMemo,
  async readSessionTitles() {
    // Include pending index writes so a just-renamed session already has its current title.
    const index = await readSessionIndex();
    const entries = new Map((Array.isArray(index) ? index : [])
      .filter(entry => entry && entry.id).map(entry => [String(entry.id), entry]));
    const titles = new Map();
    for (const [id, entry] of overlayUnflushedSessionIndex(entries)) {
      titles.set(String(id), (entry && entry.title) || '');
    }
    return titles;
  },
});

const { handleUsageApiRoutes, handleDiagnosticsApiRoutes } =
  require('./backend/diagnostic-routes.cjs').createDiagnosticRoutes({
    tokenOk, readConfig, buildUsageSummary, buildOpsMetrics, collectAudit,
    collectStorageStats, maybeRecordStorageTrend, buildMetricsPayload,
  });

const handleLocalSupportApiRoutes = require('./backend/local-support-routes.cjs').createLocalSupportRoutes({
  externalRoot, manualsDirectory: path.join(__dirname, '..', 'docs', 'manuals'), paths,
  tokenOk, safeSessionId, readConfig, loadSession, process, DesktopShell, logEvent,
  fileAllowedRoots, remoteUncDenialResolved, ensureDataRootReal, isSensitiveDataPath, isSensitiveHardlinkAlias,
  guardWorkspacePath, buildRevealSpawn,
});

const { handleCheckpointQueryApiRoutes, handleCheckpointApiRoutes } =
  require('./backend/checkpoint-routes.cjs').createCheckpointRoutes({
    tokenOk, safeSessionId, readConfig, loadSession, mutateSession, mutateConfig, nowIso, logEvent,
    execution: { activeChildren, activeAgentRuns, rewindSession },
    journal: { journalReadIndex, journalDir, journalRollback, journalRevertLogRecord,
      workspaceBaselinePathKey, workspaceBaselineIsCodePath, bumpMissionChangeSeq },
    editor: { guardWorkspacePath, resolvePreferredCodeEditor, buildCodeEditorSpawn, materializeCheckpointEditorDiff, launchCodeEditor },
    storage: { normalizeStoragePolicy, storageSweep }, process,
  });

const ServerStartNotices = require('./backend/server-start-notices.cjs').createServerStartNotices({
  paths, DesktopExecutionHooks, atomicWriteJson, nowIso, safeJsonParse,
});

const { handleSkillApiRoutes, setSessionSkillsCore } = require('./backend/skill-routes.cjs').createSkillRoutes({
  paths, SKILL_ID_RE, readConfig, loadSkillRegistry, fileAllowedRoots, logEvent,
  loadSession, mutateSession, activeChildren,
});

const handleMemoryApiRoutes = require('./backend/memory-routes.cjs').createMemoryRoutes({
  tokenOk, safeSessionId, readConfig, fileAllowedRoots, logEvent, MEMORY_EXCLUSION_MAX,
  loadSession, mutateSession, activeChildren,
  store: { loadMemoryRegistry, projectKeyForCwd, resolveCoreMemoryState, listMemoryProjectGroups,
    readMemoryItem, migrateMemory, moveMemoryScope, saveMemory, deleteMemory },
  proposals: { replayPendingMemoryProposal, proposeMemoryFromSession, decideMemoryProposal,
    applyMemoryRelationProposal, draftMemoryFromSession, validateMemoryProposalSave },
  relations: { listMemoryRelations, analyzeMemoryMaintenance, proposeMemoryRelation,
    confirmMemoryRelation, deleteMemoryRelation },
});

const handlePlaybookApiRoutes = require('./backend/playbook-routes.cjs').createPlaybookRoutes({
  safeSessionId, readConfig, listPlaybooksWithAvailability, normalizePlaybook,
  saveUserPlaybook, deleteUserPlaybook, playbookReuseSources, draftPlaybookFromSession,
});

const handleSessionExecutionApiRoutes = require('./backend/session-execution-routes.cjs').createSessionExecutionRoutes({
  safeSessionId, readConfig, loadSession, mutateSession, logEvent, activeChildren, requestSessionExecutionStop, StewardHooks,
  compaction: { runProviderCompactTracked, runAgentExternalCompact, configForSessionEngineRoute, agentCliAdapter },
  kimi: { kimiSessionStatus, kimiStatusFingerprint, applyKimiStatusToSession, kimiUsageFromStatus },
});

const handleStatusApiRoutes = require('./backend/status-routes.cjs').createStatusRoutes({
  paths, RUNTIME, ServerStartNotices, readConfig, maskProviders, requestIsLoopback, computeHealth, getCapabilities, probeRgAsync,
  identity: { APP_NAME, VERSION, CONFIG_SCHEMA, OVERLAY_ID, dataRootAliases, exePath },
  conversation: { safeSessionId, readSessionRouteHead, configForSessionEngineRoute, activeOpenAiProvider,
    agentConversationContextMeta, configuredConversationWindow, resolveContextWindow, learnedWindowCap },
  cli: { agentCliAdapter, detectClaudePath, detectKimiPath, AGENT_CLI_TYPES, selectedAgentCli },
  desktopMcp: { desktopMcpDetectionPending, mcpConfigFilePath, generateMcpConfig, ensureDesktopMcpWarm,
    detectDesktopMcp, resolveExternalMcpServers },
  tools: { MCP_TOOLS, runtimeToolRequirementsMet, nativeToolDisabledByPolicy, observationRecallEnabled, isStewardToolName },
  ToolboxHooks, PROVIDER_PRESETS, CLAUDE_ENDPOINT_PRESETS,
});

const handleWorkspaceApiRoutes = require('./backend/workspace-routes.cjs').createWorkspaceRoutes({
  readConfig, resolveWorkspace, DesktopShell,
});

const { handleModelsApiRoute, handleProviderTestApiRoute } = require('./backend/provider-routes.cjs').createProviderRoutes({
  readConfig, safeSessionId, readSessionRouteHead, configForSessionEngineRoute, agentCliAdapter,
  catalog: { activeOpenAiProvider, fetchOpenAiModels, cachedContextLength, contextWindowFromTable },
  credentials: { maskedSecretConflicts, maskedSecretConflictMessage, unmaskProviders, redact },
  probe: { sanitizeProvider, normalizeProviderApiStyle, probeProviderCompletion },
});

const handleConfigurationApiRoutes = require('./backend/configuration-routes.cjs').createConfigurationRoutes({
  readConfig, mutateConfig, maskProviders, ConfigPatchHooks, ToolboxHooks, projectCwdDirectoryFailure, resolveExternalMcpServers,
  roles: { getAgentRoleLibrary, readProjectAgentRoles, readClaudeProjectAgentRoles, buildClaudeAgentDefinitions,
    saveProjectAgentRoles, projectAgentRoleFile },
  workflows: { getAgentWorkflows, normalizeAgentWorkflow, agentWorkflowSaveProblem, saveAgentWorkflow, deleteAgentWorkflow },
});

const handleMissionLedgerApiRoutes = require('./backend/mission-ledger-routes.cjs').createMissionLedgerRoutes({
  tokenOk, tokenMatches, safeSessionId, loadSession, mutateSession, activeChildren, readConfig, nowIso, logEvent,
  todos: { normalizeTodoItems },
  missions: { missionControlCommand, evaluateMissionCheck, recordMissionCheckResult, MISSION_MAX_TEXT,
    maybeFinalizeMission, bumpMissionChangeSeq, normalizeMission, applyMissionUpdate },
});

const handleAutonomyGrantApiRoutes = require('./backend/autonomy-grant-routes.cjs').createAutonomyGrantRoutes({
  tokenOk, safeSessionId, loadSession, activeChildren, readConfig, logEvent, activeDriverRunOf,
  grants: { listGrantsView, normalizeGrant, dryRunGrantFiles, installGrant, revokeAllGrants, revokeGrant },
});

const handleAgentWorkflowApiRoutes = require('./backend/agent-workflow-routes.cjs').createAgentWorkflowRoutes({
  process, tokenOk, tokenMatches, safeSessionId, loadSession, mutateSession, activeChildren, readConfig, nowIso, makeId,
  engines: { resolveProvider, activeOpenAiProvider, detectClaudePath, existsExecutableAsync },
  workflow: { resolveOrchestrateNodes, runAgentWorkflow, activeAgentRuns, saveAgentRun, AGENT_RUN_TERMINAL },
  delivery: { EventStreamHooks, waitForAgentRunResults, resolveWaitAgentsMs, settleWaitEnvelopes, agentRunResultSlice,
    deliverAgentRunEnvelope, buildAgentRunEnvelope },
});

const { doctor, parseArgs, doctorHealthSeverity, doctorHumanLines } = require('./backend/cli-diagnostics.cjs').createCliDiagnostics({
  externalRoot, publicDirectory: path.join(__dirname, 'public'), ensureDirs, readConfig, generateMcpConfig,
  APP_NAME, VERSION, exePath, paths, detectClaudePath, existsExecutable, computeHealth,
});

const MigrationCenter = require('./backend/migration-center.cjs').createMigrationCenter({
  paths, nowIso, logEvent, VERSION, SKILL_ID_RE, process,
  MigrationTrashHooks: {
    helperPath: () => path.resolve(__dirname, '..', 'runtime', 'macos', 'ruyi-trash-helper'),
    run: (...args) => DesktopShell.runProcess(...args),
  },
  packages: { externalRoot, findRuyiPackageRootFor, ruyiPackageInfo, samePathKey, readInstallRegistry, writeInstallRegistry },
  config: { readConfig, mutateConfig, atomicWriteJson, agentMcpImportSources, classifyAgentMcpCandidate, generateMcpConfig, kimiMcpManagedIds },
  skills: { agentCliHomes, tildePath, SkillRegistry, syncAgentInstructionImports },
});
const handleMigrationApiRoutes = require('./backend/migration-routes.cjs').createMigrationRoutes({ migration: MigrationCenter });

const handleMcpApiRoutes = require('./backend/mcp-routes.cjs').createMcpRoutes({
  paths, logEvent, readConfig, mutateConfig, generateMcpConfig, resolveExternalMcpServers, handleMigrationApiRoutes,
  invalidateMcpRuntime, buildMcpConnectorInventory, MCP_COMPAT_MATRIX, probeMcpConnector, mutateMcpConnector,
});

const { steerSessionCore, handleSteerApiRoute } = require('./backend/session-steering.cjs').createSessionSteering({
  paths, activeChildren, safeSessionId, nowIso, logEvent, saveSession, buildUserEnvelope, writeToChild,
  VisualPipeline, sanitizeFsSegmentName, hasPendingQuestionForSession, STEER_QUEUE_MAX,
});

const handleAudioApiRoutes = require('./backend/audio-routes.cjs').createAudioRoutes({
  ASR_MAX_BODY_BYTES, PrivacyGateway, ToolboxHooks, nowIso, logEvent, readConfig, appendUsageLedger,
  voiceLexiconRead, voiceLexiconUpdate, resolveAsrFixProvider, providerFixCompletion, transcribeAudioViaProvider,
  resolveAsrProvider, asrFixModeOf, voiceLexiconAsrPromptFor, asrFixMessages, asrFixSanity, resolveAsrStreamProvider,
});

const { maybeTranscribeAudioAttachment, maybeOcrImageAttachment, maybeCompressImageAttachment } =
  require('./backend/attachment-enrichment.cjs').createAttachmentEnrichment({
    ASR_MAX_BODY_BYTES, readConfig, PrivacyGateway, activeOpenAiProvider,
    collectBridgedTools, resolveBridge, getBridgedClient,
    resolveAsrProvider, voiceLexiconAsrPromptFor, transcribeAudioViaProvider,
  });

const handleAttachmentApiRoutes = require('./backend/attachment-routes.cjs').createAttachmentRoutes({
  paths, tokenOk, makeAttachmentRecord,
  maybeTranscribeAudioAttachment, maybeOcrImageAttachment, maybeCompressImageAttachment,
});

const { buildMissionCard, missionCardStatus, missionPendingCounts, missionRunDigest, missionHealthRuns } =
  require('./backend/mission-card-projection.cjs').createMissionCardProjection({
    readInterventions, computeWaveSeq, nodeDeliveryEligibility, activeAgentRuns, agentRunHealth,
    sessionMissionId, sessionKind, sessionDisplayTitle, sessionBriefOf, activeChildren,
    sessionExecutionSnapshot, stewardThreadTurnQueued,
  });

const { pretenderHash, paginatePretenderProjection, pretenderEtag, pretenderNotModified } = require('./backend/pretender-http-projection.cjs');

const {
  markPretenderIndexDirty, invalidatePretenderIndex, getIndexedPretenderSessionIds, pretenderIndexMeta,
  getPretenderProjectionIndex, warmPretenderProjectionIndex, pretenderIndexTestHooks, emptyMissionUsage,
} = require('./backend/pretender-index.cjs').createPretenderIndex({
  storage: {
    agentRunDir, atomicWriteJson, compactInterventionJournal, interventionFilePath,
    interventionJournalWorthCompacting, listAgentRuns, readInterventionsWithMeta, safeJsonParse, safeSessionId,
    sessionPath,
  },
  projection: {
    activeChildren, buildMissionCard, nowIso, sessionKind, sessionMissionId, stewardWatchedThread,
    threadOriginOf, threadVisible,
  },
  usage: { forEachUsageRow, usageLedgerChangesSince },
  config: {
    THREAD_INDEX_RECENT_DEFAULT, THREAD_INDEX_RECENT_MAX, THREAD_INDEX_RECENT_MIN, paths, readConfig,
    getSessionsDirOwnWriteSeq: () => sessionsDirOwnWriteSeq,
  },
});

const { pretenderLiveOverlayRevision, overlayMissionCard } = require('./backend/pretender-live-overlay.cjs').createPretenderLiveOverlay({
  state: {
    EventStreamHooks, activeAgentRuns, activeChildren, agentRunHealth, getIndexedPretenderSessionIds,
    sessionExecutionSnapshot, stewardThreadTurnQueued,
  },
  cards: { missionRunDigest, nowIso, stewardAsksYouForThread },
});

// Invalidation is synchronous with authoritative writes; readers never observe an unmarked commit.
RUYI_EVENTS.subscribe((name, payload) => {
  if (name === 'projection.invalidated') markPretenderIndexDirty(payload?.sessionId, payload?.reason);
});

const { sessionSearchScope, searchSessionsByContent } = require('./backend/session-search.cjs').createSessionSearch({
  paths, nowIso, atomicWriteJson, sessionBodyPaths, sessionBriefOf, listSessions,
});

const { sessionEnvelopeStamp, sessionEnvelopeEtag, sessionEnvelopeLiveParts } =
  require('./backend/session-envelope.cjs').createSessionEnvelope({
    paths, safeSessionId, sessionPath, sessionBodyPaths, pretenderEtag, pretenderHash, StewardHooks,
    execution: { activeChildren, activeAgentRuns, turnSettlers, sessionExecutionSnapshot, sessionExecutionObservation },
    overrides: { sessionPermissionModeOverrides, sessionDesktopToolsOverrides },
  });

const { sessionBackgroundRunRows, agentRunActionCommand } = require('./backend/agent-run-control.cjs').createAgentRunControl({
  activeAgentRuns, safeSessionId, redact, nowIso, STEER_QUEUE_MAX,
  appendAgentRunEvent, saveAgentRun, bumpRunIntervention, launchPersistedAgentRun, nodeDeliveryEligibility,
});

const handleSessionApiRoutes = require('./backend/session-routes.cjs').createSessionRoutes({
  tokenOk, safeSessionId, safeDecodeURIComponent, readConfig, logEvent, PrivacyGateway, STEWARD_SESSION_ID,
  resolveContainmentPath, pretenderNotModified, searchSessionsByContent,
  execution: { sessionExecutionSnapshot, sessionExecutionObservation, EventStreamHooks, sessionBackgroundRunRows, agentRunActionCommand },
  envelope: { sessionEnvelopeStamp, sessionEnvelopeEtag, sessionEnvelopeLiveParts },
  sessions: {
    listSessions, createSession, readSessionHeadResilient, loadSession, updateSessionMeta, sessionMeta,
    SESSION_LOAD_OMIT_PROVIDER, sessionOmittedProviderHistory, sessionMessagesDelta, sessionProviderHistoryLength,
    detectDanglingTurn, sessionDisplayTitle, sessionDesktopToolsOf, bulkDeleteUnpinnedSessions, deleteSession,
  },
});

const { buildMissionAggregateRows, overlayMissionAggregateFields, missionAggregateStats } =
  require('./backend/mission-aggregate.cjs').createMissionAggregate({
    paths, dataRootAliases, nowIso, activeChildren, readConfig, listSessions, listMissionContainers,
    readMissionSessionHead, sessionDisplayTitle, sessionBriefOf, StewardHooks,
    stewardRuyiOwnedPath, stewardThreadStateFromCard, stewardThreadStateFromHead, deriveStewardThreadState,
    stewardSanitizeText, waitReasonFor, stewardThreadStateRank, aggregateMissionState,
    getPretenderProjectionIndex, overlayMissionCard, missionPendingCounts, pretenderHash,
  });

const handleMissionsApiRoutes = require('./backend/mission-routes.cjs').createMissionRoutes({
  tokenOk, safeSessionId, safeDecodeURIComponent, nowIso, activeChildren, activeAgentRuns,
  STEWARD_SESSION_ID, stewardThreadStateRank, stewardThreadStateFromCard, stewardThreadTurnQueued,
  buildMissionAggregateRows, overlayMissionAggregateFields, missionControlCommand, missionControlView,
  membership: { createMissionContainer, patchMissionContainer, missionAttachThread, missionDetachThread, missionMergeInto, missionSplitThreads },
  sessions: {
    loadSession, sessionMissionId, readMissionChangesWithMeta, readMissionContainer, missionContainerAcceptanceStamp,
    listAgentRuns, buildMissionAcceptanceProjection, foldTurnSummaries, journalReadIndex, sessionKind,
  },
  projection: {
    getPretenderProjectionIndex, overlayMissionCard, paginatePretenderProjection, pretenderEtag, pretenderLiveOverlayRevision,
    pretenderNotModified, pretenderIndexMeta, emptyMissionUsage, missionPendingCounts,
    missionCardStatus, missionRunDigest,
  },
});

const agentInterventionAction = require('./backend/agent-intervention-actions.cjs').createAgentInterventionActions({
  activeAgentRuns, agentRunFile, nowIso, readConfig, loadSession: (...args) => loadSession(...args),
  normalizeCwd, getAgentRoleLibrary, materializePoolItem, applyReplanPatch, bumpRunIntervention,
  appendAgentRunEvent, saveAgentRun,
});
function decideIntervention(command) {
  return decideInterventionCommand(command, agentInterventionAction);
}

const handleInterventionApiRoutes = require('./backend/intervention-routes.cjs').createInterventionRoutes({
  tokenOk, tokenMatches, safeSessionId, safeDecodeURIComponent, makeId, logEvent, readConfig, RUYI_MCP_CLI_TOOL_PREFIX,
  execution: { pendingPermissions, pendingQuestions, pendingPlans, activeAgentRuns, activeChildren, driverAutoSessions },
  permissions: {
    interventionCommandFailure, extendUserQuestion, requestUserQuestion, permissionWaitMs, runAutomaticInterventionDecision,
    bridgedReadPathGate, consumeGrant, toolDisabledResult, nativeToolGate, toolIsRevertible, sessionDesktopToolsOf,
  },
  sessions: {
    compactInterventionJournal, readSessionHeadResilient, readMissionContainer, registerIntervention,
    loadSession, saveSession, settleIntervention, transitionInterventionState, decideIntervention,
  },
  projection: {
    invalidatePretenderIndex, pretenderIndexMeta, getPretenderProjectionIndex, paginatePretenderProjection,
    pretenderEtag, pretenderLiveOverlayRevision, pretenderNotModified, pretenderHash,
  },
});

const handleAgentRunApiRoutes = require('./backend/agent-run-routes.cjs').createAgentRunRoutes({
  tokenOk, safeSessionId, activeAgentRuns, agentRunActionCommand, decideIntervention, agentRunFile,
  AgentRunStore, applyAgentWorktree, cleanupAgentWorktree, bumpMissionChangeSeq, RUYI_EVENTS, EventStreamHooks,
});

const { createStewardInboxEvents, stewardPendingKeyOf } = require('./backend/steward-inbox-events.cjs');
const StewardInboxEvents = createStewardInboxEvents({ STEWARD_EVENT_KINDS, stewardSanitizeText, stewardCoveringLastTurn });
const {
  STEWARD_SOURCE_EVENT_MAP, stewardClipSummary, stewardIsoAt, stewardEventDedupeKey,
  stewardNormalizeMissionChange, stewardNormalizeRunEvent, stewardNormalizePendingIntervention,
  stewardNormalizeBudgetExhausted, stewardMergeInboxEvents, stewardInboxRowDedupeKeys,
} = StewardInboxEvents;
const {
  stewardDir, stewardInboxRead, stewardInboxState, stewardAppendInboxRows, stewardImplInboxRead,
  stewardPendingStillOpen, stewardViewingSessionIds, stewardPresenceRows, startStewardInbox, stopStewardInbox,
} = require('./backend/steward-inbox.cjs').createStewardInbox({
  paths, readConfig, safeSessionId, safeJsonParse, nowIso, logEvent,
  io: { atomicWriteJson, repairMissionChangeTornTail },
  sources: { getPretenderProjectionIndex, sessionPath, listAgentRuns, readAgentRunEvents, readMissionChangesWithMeta },
  execution: { activeAgentRuns, activeChildren, turnSettlers, turnOutcomePending },
  rules: { STEWARD_EVENT_KINDS, STEWARD_SESSION_ID, stewardForeignProjection, stewardWatchedThread },
  inboxEvents: StewardInboxEvents, RUYI_EVENTS, EventStreamHooks, StewardHooks,
});

const {
  createStewardToolContext,
  STEWARD_SEARCH_LIMIT_DEFAULT, STEWARD_SEARCH_LIMIT_MAX, STEWARD_READ_TAIL_DEFAULT,
  STEWARD_READ_TAIL_MAX, STEWARD_READ_CHARS_DEFAULT, STEWARD_READ_CHARS_MIN,
  STEWARD_READ_CHARS_MAX, STEWARD_READ_CALLS_PER_TURN, STEWARD_READ_ROW_OVERHEAD,
  STEWARD_READ_CLIP_MARK, STEWARD_AUDIT_LIMIT_DEFAULT, STEWARD_AUDIT_LIMIT_MAX,
  STEWARD_MISSIONS_LIMIT_DEFAULT, STEWARD_MISSIONS_LIMIT_MAX, STEWARD_TITLE_MAX,
  STEWARD_STEER_TEXT_MAX, STEWARD_NOTE_TEXT_MAX, STEWARD_NOTE_PREFIX,
  STEWARD_PENDING_SUMMARY_MAX, STEWARD_RUNS_MAX, STEWARD_MEMORY_NEW_WINDOW_MS,
  STEWARD_PLAYBOOK_DRAFTS_PER_TURN, STEWARD_QUICK_ASKS_PER_TURN,
} = require('./backend/steward-tool-context.cjs');
const {
  stewardFail, stewardClampInt, stewardReadSessionHead, stewardRawKind, stewardThreadPermissionMode,
  stewardLastAssistantText, stewardTurnAssistantText, stewardTurnFiles, stewardEngineOf,
  stewardQuickClosed, stewardQuickThread, stewardDisplayKind,
} = createStewardToolContext({
  safeSessionId, safeJsonParse, sessionPath, applySessionPermissionModeOverride, resolvePermissionMode, foldTurnSummaries, stewardSanitizeText,
});

const StewardDecisions = require('./backend/steward-decisions.cjs').createStewardDecisions({
  stewardDir, nowIso, safeJsonParse, safeSessionId, readFileTail, repairMissionChangeTornTail, STEWARD_CONFIG_SECRET_PATTERN,
});
const { stewardAppendDecision, stewardBasisOf, stewardDecisionsRead } = StewardDecisions;
const { createStewardMemoryStore, STEWARD_MEMORY_SCHEMA, STEWARD_MEMORY_MERGED_FROM_MAX } = require('./backend/steward-memory-store.cjs');
const {
  stewardMemoryScopeOf, stewardNormalizeMemoryScope, stewardMemoryScopeMatches, stewardMemoryScopeLabel,
  stewardReadMemoryStore, stewardMutateMemory,
} = createStewardMemoryStore({
  stewardDir, nowIso, safeJsonParse, atomicWriteJson, projectKeyForCwd, cleanMemoryDate,
  STEWARD_MEMORY_KINDS, STEWARD_MEMORY_LIMITS, stewardSanitizeText,
});

const {
  stewardReadBucket, clearStewardReadBudget, stewardTurnKeyOf, stewardTurnQuotaTake, stewardTurnQuotaRefund,
  stewardMarkTurnTainted, stewardTurnTaintedBy, stewardNotifiesInWindow, stewardNotifyRecord,
  stewardExemptDelegationsInWindow, stewardExemptDelegationRecord,
} = require('./backend/steward-tool-budget.cjs').createStewardToolBudget({
  providerTurnQuotaKey, STEWARD_NOTIFY_WINDOW_MS, STEWARD_EXEMPT_DELEGATION_WINDOW_MS,
});

// 3.x 第四轮：只读交付投影。证据随既有 turnSummary 保存，不另建成果或验收账本。
// 引擎及工具通过 StewardHooks 迟绑定，避免给既有依赖环增加成员。
const STEWARD_DELIVERY_LIMITS = Object.freeze({ files: 20, checks: 50, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 });
function stewardDeliveryRows(session, turnSeq) {
  return (Array.isArray(session.messages) ? session.messages : []).filter(row => Number(row && row.turnSeq) === turnSeq);
}
function stewardDeliveryFiles(summary, cwd) {
  const pathsByKey = new Map();
  for (const row of [...(Array.isArray(summary.artifacts) ? summary.artifacts : []), ...(Array.isArray(summary.filesChanged) ? summary.filesChanged : [])]) {
    if (!row || typeof row.path !== 'string' || !row.path.trim()) continue;
    const absolute = path.resolve(cwd || '', row.path);
    const key = absolute;
    pathsByKey.set(key, { path: absolute, name: path.basename(absolute), kind: kindForPath(absolute) });
  }
  return [...pathsByKey.values()];
}
function stewardDeliveryReferencedFiles(session, summary, text) {
  const keyFor = value => value;
  const files = new Map(stewardDeliveryFiles(summary, session.cwd).map(file => [keyFor(file.path), file]));
  // 只接受本任务此前执行记录中已有的产物，且本轮原文用行内代码或 Markdown 链接明确引用路径。
  // 不扫描任意路径、不把用户文字或导入摘要变成本机产物证据，也不凭文件同名猜测。
  const references = new Set();
  const prose = String(text || '').slice(0, 200000).replace(/```[^]*?(?:```|$)/g, '');
  const addReference = (raw, encoded = false) => {
    let value = raw.trim();
    if (encoded) { try { value = decodeURIComponent(value); } catch { return; } }
    if (!value || /[\x00-\x1f]/.test(value) || /^\/\//.test(value)) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return;
    references.add(keyFor(path.resolve(session.cwd || '', value)));
  };
  for (const match of prose.matchAll(/`([^`\r\n]{1,4096})`/g)) addReference(match[1]);
  for (const match of prose.matchAll(/\[[^\]\r\n]{0,4096}\]\(\s*(?:<([^>\r\n]{1,4096})>|([^\s()]{1,4096}))(?:\s+["'][^\r\n]*?["'])?\s*\)/g)) addReference(match[1] || match[2], true);
  if (!references.size) return [...files.values()];
  for (const row of Array.isArray(session.messages) ? session.messages : []) {
    if (row.role !== 'assistant' || row.meta?.imported || !row.turnSummary || !(Number(row.turnSeq) < Number(summary.turnSeq))) continue;
    for (const file of stewardDeliveryFiles(row.turnSummary, session.cwd)) {
      const key = keyFor(file.path);
      if (references.has(key) && !files.has(key)) files.set(key, { ...file, referenced: true });
    }
  }
  return [...files.values()];
}
async function stewardDeliveryInspect(file, session, config, budget, keepBytes = false) {
  const target = file.path;
  try {
    if (await remoteUncDenialResolved([target], session, config)) return { ...file, status: 'blocked' };
    const real = await fsp.realpath(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!real) return { ...file, status: 'missing' };
    await ensureDataRootReal();
    const roots = await Promise.all(fileAllowedRoots(session, config).map(root => fsp.realpath(root).catch(() => root)));
    if (!pathWithinAnyRoot(real, roots) || isSensitiveDataPath(target) || isSensitiveDataPath(real) || await isSensitiveHardlinkAlias(real)) return { ...file, status: 'blocked' };
    const handle = await fsp.open(real, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile()) return { ...file, status: 'unavailable' };
      if (before.size > STEWARD_DELIVERY_LIMITS.fileBytes || budget.bytes + before.size > STEWARD_DELIVERY_LIMITS.totalBytes) return { ...file, status: 'unverified', size: before.size };
      budget.bytes += before.size;
      // 限额读取而不是 readFile：文件在 stat 之后增长也不能越过预算。
      const buffer = Buffer.alloc(before.size + 1);
      let read = 0;
      while (read < buffer.length) {
        const got = await handle.read(buffer, read, buffer.length - read, read);
        if (!got.bytesRead) break;
        read += got.bytesRead;
      }
      const after = await handle.stat();
      if (read !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return { ...file, status: 'unavailable' };
      return { ...file, status: 'available', size: read, fingerprint: crypto.createHash('sha256').update(buffer.subarray(0, read)).digest('hex'), ...(keepBytes ? { bytes: buffer.subarray(0, read) } : {}) };
    } finally { await handle.close(); }
  } catch { return { ...file, status: 'unavailable' }; }
}
async function stewardCaptureDelivery(session, summary, options = {}) {
  if (stewardRawKind(session) === 'steward') return;
  const config = await readConfig();
  if (config.stewardEnabledV1 !== true) return;
  const all = stewardDeliveryReferencedFiles(session, summary, options.finalText);
  const budget = { bytes: 0 }, files = [];
  for (const file of all.slice(0, STEWARD_DELIVERY_LIMITS.files)) files.push(await stewardDeliveryInspect(file, session, config, budget));
  const missionId = sessionMissionId(session);
  const container = missionId && missionId !== session.id ? await readMissionContainer(missionId).catch(() => null) : null;
  const acceptance = buildMissionAcceptanceProjection(session.mission, container);
  const checks = acceptance.items.slice(0, STEWARD_DELIVERY_LIMITS.checks).map(item => {
    const humanAt = item.provenance === 'human' ? acceptance.container?.items.find(row => row.done && row.text.trim() === item.desc.trim())?.doneAt : '';
    const checkedAt = item.provenance === 'human' ? humanAt || '' : item.checkedAt || '';
    return { ...item, checkedAt, currentTurn: !!checkedAt && Date.parse(checkedAt) >= Number(options.startedAt || Infinity) };
  });
  if (!acceptance.ledger && acceptance.container) {
    for (const item of acceptance.container.items.slice(0, STEWARD_DELIVERY_LIMITS.checks)) checks.push({ id: item.id, desc: item.text,
      status: item.done ? 'done' : 'pending', provenance: item.done ? 'human' : 'open', checkState: 'none', checkedAt: item.doneAt,
      currentTurn: !!item.doneAt && Date.parse(item.doneAt) >= Number(options.startedAt || Infinity) });
  }
  summary.deliveryEvidence = { schema: 1, capturedAt: nowIso(), files, filesTruncated: all.length > files.length,
    checks: checks.slice(0, STEWARD_DELIVERY_LIMITS.checks), checksRecorded: acceptance.ledger || !!(acceptance.container && acceptance.container.total) };
}
function stewardDeliverySource(session, turnSeq) {
  const rows = stewardDeliveryRows(session, turnSeq);
  if (!rows.length) return null;
  const summaryRow = [...rows].reverse().find(row => row.role === 'assistant' && row.turnSummary && Number(row.turnSummary.turnSeq) === turnSeq);
  const summary = summaryRow ? summaryRow.turnSummary : { artifacts: [], filesChanged: [] };
  // 导入内容不是本机执行证据；旧回合没有快照时也不能借当前任务的检查充数。
  const evidence = summaryRow && !summaryRow.meta?.imported && summary.deliveryEvidence?.schema === 1 ? summary.deliveryEvidence : null;
  const stamp = crypto.createHash('sha256').update(JSON.stringify({ sessionId: session.id, cwd: session.cwd, rewindGen: session.rewindGen || 0,
    turnSeq, rows: rows.map(row => ({ role: row.role, content: row.content, segments: row.segments, turnSummary: row.turnSummary })) })).digest('hex');
  return { rows, summary, evidence, stamp };
}
async function stewardDeliveryProjection(sessionId, turnSeq, config) {
  const session = await loadSession(sessionId, { omitProviderHistory: true });
  if (!session || stewardRawKind(session) === 'steward') return stewardFail('not_found', '交付来源任务不存在');
  const source = stewardDeliverySource(session, turnSeq);
  if (!source) return stewardFail('delivery_not_found', '指定回合已不存在,没有使用其它回合代替');
  const recorded = source.evidence;
  const all = stewardDeliveryReferencedFiles(session, source.summary, source.rows.filter(row => row.role === 'assistant' && !row.meta?.imported).map(row => row.content || '').join('\n'));
  const files = [], budget = { bytes: 0 };
  for (const file of all.slice(0, STEWARD_DELIVERY_LIMITS.files)) {
    const current = await stewardDeliveryInspect(file, session, config, budget);
    const previous = recorded && recorded.files.find(row => row.path === file.path);
    const version = current.status === 'available' ? (!previous?.fingerprint ? 'unverified' : current.fingerprint === previous.fingerprint ? 'same' : 'changed') : current.status;
    files.push({ ...current, status: version });
  }
  const allFilesSame = files.every(file => file.status === 'same') && !(recorded && recorded.filesTruncated);
  const inProgress = !!sessionExecutionSnapshot(sessionId);
  const fileStamp = crypto.createHash('sha256').update(JSON.stringify(files.map(file => [file.path, file.status, file.fingerprint || '', file.size]))).digest('hex');
  const checks = recorded ? recorded.checks.map(item => ({ ...item,
    applicable: item.currentTurn === true && allFilesSame && !inProgress && Number(session.turnSeq) === turnSeq })) : [];
  return { ok: true, sessionId, title: sessionDisplayTitle(session), turnSeq, latestTurnSeq: Number(session.turnSeq) || 0,
    sourceStamp: source.stamp, fileStamp, capturedAt: recorded?.capturedAt || '', evidenceRecorded: !!recorded,
    files, filesTruncated: all.length > files.length, checks, checksRecorded: recorded?.checksRecorded === true,
    unfinished: checks.filter(item => item.status !== 'done').map(item => ({ id: item.id, desc: item.desc, status: item.status })),
    outdated: Number(session.turnSeq) > turnSeq, inProgress };
}
async function stewardValidateDeliveryReference(sessionId, reference, config) {
  if (!reference || !Number.isSafeInteger(reference.turnSeq) || reference.turnSeq <= 0 || !/^[a-f0-9]{64}$/.test(reference.sourceStamp || '') || !Number.isSafeInteger(reference.latestTurnSeq)) return stewardFail('invalid_request', '修订来源无效,请重新打开交付卡');
  const current = await stewardDeliveryProjection(sessionId, reference.turnSeq, config);
  if (!current.ok) return current;
  if (current.sourceStamp !== reference.sourceStamp || current.fileStamp !== reference.fileStamp || current.latestTurnSeq !== reference.latestTurnSeq) return stewardFail('delivery_changed', '来源、文件或任务已有变化,请刷新交付卡并重新发起修订');
  return { ok: true, reference: { sessionId, turnSeq: reference.turnSeq, sourceStamp: reference.sourceStamp,
    latestTurnSeq: reference.latestTurnSeq, fileStamp: reference.fileStamp, files: current.files.map(file => file.path) } };
}
DeliveryHooks.capture = stewardCaptureDelivery;
StewardHooks.deliveryProjection = stewardDeliveryProjection;
StewardHooks.validateDeliveryReference = stewardValidateDeliveryReference;

const {
  stewardCanonWorkspacePath, stewardFoldWorkspacePath, stewardKnownWorkspaces, stewardMatchKnownWorkspace,
  stewardWorkspaceNameOf, stewardValidateCwd, stewardResolveThreadCwd, stewardRecordMissionWorkspace, stewardDeriveThreadCwd,
} = require('./backend/steward-workspaces.cjs').createStewardWorkspaces({
  dataRoot, dataRootAliases, nowIso, sanitizeFsSegmentName, safeSessionId, mutateConfig, normalizeWorkspacePathString,
  sessions: { listSessions, sessionMetaIsSteward, stewardRawKind, stewardReadSessionHead },
  missions: { readMissionContainer, withMissionContainerLock, writeMissionContainer },
  rules: { STEWARD_WORKSPACE_TABLE_MAX, stewardRuyiOwnedPath, stewardWorkspaceLabels, stewardFail },
});

const {
  stewardPendingExecutionSummary, stewardExemptPendingSummary, stewardLiveTurnPermissionMode,
  stewardExemptLiveTurn, stewardExemptDelegatedLog, stewardEnrichInboxRows, stewardQuickClose,
} = require('./backend/steward-thread-delivery.cjs').createStewardThreadDelivery({
  logEvent, nowIso, redact, safeSessionId, activeChildren, loadSession, readInterventions, updateSessionMeta,
  contracts: {
    STEWARD_DELIVERABLE_CHARS, STEWARD_EXEMPT_INPUT_CHARS, STEWARD_QUICK_ANSWER_CHARS, STEWARD_QUICK_KIND,
    stewardExemptExcerpt, stewardExemptHits, stewardExemptInputText, stewardExemptScanInput, stewardSanitizeBlock,
    stewardSanitizeText, stewardTurnTaint, stewardWatchedThread,
  },
  threads: {
    stewardLastAssistantText, stewardQuickClosed, stewardRawKind, stewardReadSessionHead, stewardTurnAssistantText,
    stewardTurnFiles,
  },
});

const {
  threadRelationsIndex, threadRelatedThreads, stewardThreadDisplayTitle,
  stewardImplThreadsSearch, stewardImplThreadStatus, stewardImplThreadRead, stewardToolCallLine, stewardToolCallVerdict,
} = require('./backend/steward-thread-queries.cjs').createStewardThreadQueries({
  redact, safeSessionId, getPromptPack,
  sessions: {
    isUntitledSessionTitle, listSessions, loadSession, readInterventions, readMissionContainer,
    SESSION_BRIEF_TITLE_CHARS, sessionBriefOf, sessionDisplayTitle, sessionMeta, sessionMetaIsSteward,
    sessionMissionId, stewardReadSessionHead,
  },
  projection: {
    buildMissionAggregateRows, getPretenderProjectionIndex, missionPendingCounts, overlayMissionCard,
    searchSessionsByContent, sessionSearchScope, sessionSearchIndexEnabled,
    stewardPendingExecutionSummary, stewardExemptPendingSummary,
  },
  runtime: {
    activeChildren, sessionExecutionSnapshot, sessionPermissionModeOf, StewardHooks,
  },
  workspaces: {
    stewardKnownWorkspaces, stewardWorkspaceNameOf, stewardCanonWorkspacePath, stewardFoldWorkspacePath,
  },
  policy: {
    deriveStewardThreadState, stewardAsksYouForThread, stewardClipSay, stewardForeignProjection,
    stewardPendingOneLine, stewardPermissionLabel, stewardSanitizeBlock, stewardSanitizeText,
    stewardThreadStateFromCard, stewardThreadStateFromHead, waitReasonFor,
  },
  tools: {
    stewardClampInt, stewardDisplayKind, stewardEngineOf, stewardFail, stewardLastAssistantText,
    stewardQuickClosed, stewardQuickThread, stewardRawKind, stewardReadBucket, stewardThreadPermissionMode,
    stewardTurnKeyOf,
  },
  limits: {
    STEWARD_PENDING_SUMMARY_MAX, STEWARD_READ_CALLS_PER_TURN, STEWARD_READ_CHARS_DEFAULT, STEWARD_READ_CHARS_MAX,
    STEWARD_READ_CHARS_MIN, STEWARD_READ_CLIP_MARK, STEWARD_READ_ROW_OVERHEAD, STEWARD_READ_TAIL_DEFAULT,
    STEWARD_READ_TAIL_MAX, STEWARD_SEARCH_LIMIT_DEFAULT, STEWARD_SEARCH_LIMIT_MAX,
  },
});

const {
  stewardLaunchTurn, stewardLaunchPending, stewardErrorDetail, stewardUserDirected,
  stewardUnattendedByModel, stewardRelayAutoAllowed,
} = require('./backend/steward-thread-launch.cjs').createStewardThreadLauncher({
  ExternalBotHooks, logEvent, nowIso, safeSessionId, updateSessionMeta, runSessionTurn,
});

const { stewardImplThreadNew, stewardImplQuickAsk } = require('./backend/steward-thread-create.cjs').createStewardThreadCreation({
  nowIso, safeSessionId, stewardAppendDecision, stewardBasisOf, stewardFail, stewardTurnKeyOf, stewardTurnQuotaTake, stewardLaunchTurn,
  sessions: {
    createSession, listSessions, missionIndexAdd, readMissionContainer, saveSession, sessionMetaIsSteward,
    sessionMissionId, stewardRawKind, stewardReadSessionHead, stewardThreadPermissionMode,
  },
  workspaces: {
    stewardDeriveThreadCwd, stewardRecordMissionWorkspace, stewardResolveThreadCwd, stewardWorkspaceNameOf,
  },
  policy: {
    StewardHooks, stewardUnattendedByModel, stewardOpenAiFallback, stewardSanitizeText,
  },
  content: {
    listPlaybooksWithAvailability, buildStewardBrief, stewardAssemblePlaybookPrompt,
    stewardPlaybookMissingInputs,
  },
  limits: {
    STEWARD_QUICK_KIND, STEWARD_QUICK_QUESTION_CHARS, STEWARD_QUICK_ASKS_PER_TURN, STEWARD_TITLE_MAX,
  },
});

const {
  stewardSeatedByUser, stewardMediatedPermissionWaitMs, stewardMediatesPermissions, stewardSeatedFail,
  stewardAnswerGate,
} = require('./backend/steward-thread-admission.cjs').createStewardThreadAdmission({
  EventStreamHooks, sessionMissionId, memoryIsExpired, STEWARD_ANSWER_BASIS,
  STEWARD_SESSION_ID, stewardMayAct, stewardPermissionLabel, stewardSanitizeText, stewardWatchedThread,
  threadOriginOf, stewardFail, stewardReadMemoryStore, stewardThreadPermissionMode, stewardTurnTaintedBy,
  stewardUserDirected,
});
PermissionWaitHooks.steward = stewardMediatedPermissionWaitMs;

const {
  stewardContinueAttachments, stewardImplThreadContinue, stewardImplThreadRename, stewardImplThreadWorkspace,
  stewardImplThreadPermission, stewardImplThreadNote,
} = require('./backend/steward-thread-edits.cjs').createStewardThreadEdits({
  paths, safeSessionId, pathWithinRoot, decodeTextFileBytes, realpathForContainment, sanitizeFsSegmentName,
  activeChildren, steerSessionCore, stewardLaunchTurn, stewardAppendDecision, stewardBasisOf, stewardFail,
  stewardErrorDetail,
  sessions: {
    sessionDisplayTitle, updateSessionMeta, sessionDesktopToolsOf, sessionPermissionModeOf, stewardReadSessionHead,
    stewardRawKind, stewardThreadPermissionMode,
  },
  workspaces: {
    stewardKnownWorkspaces, stewardMatchKnownWorkspace, stewardSamePath, stewardWorkspaceRootFor,
  },
  policy: {
    StewardHooks, stewardMayAct, stewardMayTightenTo, stewardPermissionLabel, stewardSanitizeText,
    stewardStoppedRefusal, stewardStoppedTarget, stewardAnswerGate, stewardRelayAutoAllowed, stewardSeatedByUser,
    stewardSeatedFail, stewardUnattendedByModel, stewardUserDirected,
  },
  limits: {
    PERMISSION_MODES, STEWARD_NOTE_PREFIX, STEWARD_NOTE_TEXT_MAX, STEWARD_TITLE_MAX,
  },
});

const {
  stewardImplAuditTail, stewardImplHealth, stewardImplMissions, stewardImplPlaybooks,
  stewardImplProviders, stewardImplRunsStatus, stewardImplSelfStatus, stewardImplSkills, stewardImplUsage,
} = require('./backend/steward-status-tools.cjs').createStewardStatusTools({
  safeSessionId, redact, buildWorkbenchSelfStatus, collectAudit, computeHealth,
  stewardInboxState,
  runs: { activeAgentRuns, listAgentRuns, missionRunDigest },
  projection: { getPretenderProjectionIndex, buildMissionAggregateRows },
  usage: { forEachUsageRow, usageDayKey, usageDayKeyMemo },
  catalog: { loadSkillRegistry, listPlaybooksWithAvailability },
  threads: { stewardRawKind, stewardReadSessionHead, stewardKnownWorkspaces, stewardWorkspaceNameOf },
  rules: { stewardClampInt, stewardFail, stewardSanitizeText, stewardStateLabel },
  limits: {
    STEWARD_AUDIT_LIMIT_DEFAULT, STEWARD_AUDIT_LIMIT_MAX, STEWARD_RUNS_MAX, STEWARD_MISSIONS_LIMIT_DEFAULT,
    STEWARD_MISSIONS_LIMIT_MAX, STEWARD_CATALOG_DESC_CHARS, STEWARD_CATALOG_ROWS,
  },
});

const {
  stewardDecideAttempted, stewardImplDecide, stewardImplRunAction, stewardReadRunSnapshot,
  stewardRunResumeTier,
} = require('./backend/steward-decision-tools.cjs').createStewardDecisionTools({
  makeId, safeJsonParse, safeSessionId, stewardAppendDecision, stewardBasisOf, stewardFail,
  runs: { AgentRecovery, agentRunActionCommand, agentRunFile },
  sessions: {
    decideIntervention, readInterventions, stewardReadSessionHead, stewardRawKind,
    stewardThreadPermissionMode, threadOriginOf,
  },
  admission: {
    stewardMayAct, stewardPermissionLabel, stewardPermissionRank, stewardSeatedByUser, stewardSeatedFail,
    stewardStoppedRefusal, stewardStoppedTarget, stewardTurnTaintedBy, stewardUserDirected,
    stewardWatchedThread, stewardSanitizeText,
  },
  pending: {
    stewardExemptDelegatedLog, stewardExemptLiveTurn, stewardExemptPendingSummary,
    stewardLiveTurnPermissionMode,
  },
  exemptions: {
    stewardExemptDelegationRecord, stewardExemptDelegationVerdict, stewardExemptDelegationsInWindow,
    stewardExemptHits, stewardExemptReason, stewardExemptRiskNote, stewardExemptScanInput,
  },
  guardrails: {
    httpRequestInternalTargetReason, stewardAutoAskIndirect, stewardAutoAskScanIncomplete,
    stewardAutoAskSensitiveKind, webPayloadReason,
  },
  limits: { STEWARD_EXEMPT_CATEGORY_LABELS, STEWARD_STEER_TEXT_MAX },
});

const {
  stewardImplMemorySearch, stewardImplMemoryVeto, stewardImplMemoryWrite, stewardQuoteInSource,
  stewardSourceUserTexts,
} = require('./backend/steward-memory-tools.cjs').createStewardMemoryTools({
  loadSession, makeId, nowIso, safeSessionId, stewardAppendDecision, stewardClampInt, stewardFail,
  stewardSanitizeText,
  memory: {
    cleanMemoryDate, memoryIsExpired, memoryProposalLooksSensitive, stewardMemoryScopeMatches,
    stewardMemoryScopeOf, stewardMemoryTerms, stewardMutateMemory, stewardNormalizeMemoryScope,
    stewardReadMemoryStore, stewardTermJaccard,
  },
  evidence: { isStewardToolName, stewardToolCallLine, stewardToolCallVerdict },
  limits: { STEWARD_MEMORY_KINDS, STEWARD_MEMORY_LIMITS, STEWARD_MEMORY_MERGED_FROM_MAX },
});

const {
  stewardImplFileRead, stewardImplThreadArtifactRead, stewardImplWebFetch, stewardImplWebSearch,
} = require('./backend/steward-external-read-tools.cjs').createStewardExternalReadTools({
  TOOL_HANDLERS, safeSessionId, stewardClampInt, stewardFail, stewardSanitizeBlock, stewardSanitizeText,
  privacy: { privacySourceMark, sourceViewOf, stewardMarkTurnTainted, webPayloadReason },
  threads: { stewardReadBucket, stewardReadSessionHead, stewardThreadArtifactFiles, stewardTurnKeyOf },
  workspaces: { pathWithinRoot, realpathForContainment, stewardSamePath, stewardWorkspaceRootFor },
  network: { webFetch, webSearch },
  limits: { STEWARD_EYES_CHARS, STEWARD_READ_CALLS_PER_TURN },
});

const { stewardImplNotify } = require('./backend/steward-notification-tool.cjs').createStewardNotificationTool({
  RUYI_EVENTS, safeSessionId, stewardAppendDecision, stewardClampInt, stewardFail, stewardReadSessionHead,
  stewardSanitizeText, stewardSeatedByUser,
  quota: { stewardNotifiesInWindow, stewardNotifyRecord },
  limits: { STEWARD_NOTIFY_KINDS, STEWARD_NOTIFY_TEXT_CHARS },
});

const {
  stewardImplConfigGet, stewardImplConfigSet,
} = require('./backend/steward-settings-tools.cjs').createStewardSettingsTools({
  safeSessionId, stewardAppendDecision, stewardBasisOf, stewardFail, stewardPermissionLabel,
  configPolicy: {
    ConfigPatchHooks, KEY_MASK_PREFIX, PERMISSION_MODES_REQUIRING_CONFIRM, maskProviders,
    maskedSecretConflictMessage, maskedSecretConflicts, normalizeConfig, stewardConfigHelpFor,
    stewardConfigTierFor, unmaskSecrets,
  },
  evidence: { stewardQuoteInSource, stewardSourceUserTexts },
  privacy: { PrivacyCore },
});

const {
  stewardImplPlaybookDraft, stewardImplSkillToggle,
} = require('./backend/steward-content-tools.cjs').createStewardContentTools({
  draftPlaybookFromSession, playbookReuseSources, setSessionSkillsCore, safeSessionId, stewardAppendDecision,
  stewardBasisOf, stewardFail,
  threads: { stewardRawKind, stewardReadSessionHead, stewardThreadPermissionMode },
  quota: { stewardTurnQuotaRefund, stewardTurnQuotaTake },
  limits: { STEWARD_PLAYBOOK_DRAFTS_PER_TURN, STEWARD_SESSION_ID },
});

// ============================================================================
// 第 116 波 116c(27 号文 §3.5「管家工具面设计」/ §4「管家记忆层」):管家(Steward)
// 记忆面板服务、管家工具的门控壳与 StewardHooks 注册表。
//
// 落点(transport 层,manifest 中位于 13l-steward-ops.js 之后、13h-steward-runner.js 之前)。
// 116-2e 拆分:收件箱轮询与游标(原本是本文件的前半)整体前移到 `13i-steward-inbox.js`,零行为搬家;
//   本文件引用它的符号(stewardDir / stewardInboxRead / stewardInboxState / startStewardInbox …)
//   全部是后向边。理由见 13i 的文件头。
// 第 117 波 T1 拆分(32 号文 §2.1):本文件曾 2088 行(`steward-runner.static` ①「≤2000 行」长期红),
//   工具实现与共享原语整体前移到三个新文件,同样是零行为搬家 ——
//   `13j-steward-tool-base.js`(共享常量、稳定信封、决策日志、记忆存储、深读预算、配额桶)、
//   `13k-steward-threads.js`(线程族:派活原语与 thread_* / quick_ask / threads_search)、
//   `13l-steward-ops.js`(观察族 / 决策族 / 记忆族 / 设置族 / 内容管理族)。
//   三者都排在本文件【之前】:注册表要引用它们的 stewardImpl*,排在后面才是后向边。
//   本文件装配管家工具与记忆面板服务，HTTP 路由由 steward-routes.cjs 实现。
//
// 依赖纪律(§11.3「不得新增前向边」):
//   · 13g 只引用拼接顺序在它之前的模块符号(00/01/01b/02/06d/06i/13i/13j/13k/13l …),全部后向边;
//   · 12-tool-dispatch.js 的管家工具 handler 同理,只写 `StewardHooks.<键>(args, ctx)`。
//
// 开关(§3.4 红线):`stewardEnabledV1 !== true` 时路由 409 `steward.disabled`、工具门控壳零写入。
// ============================================================================

// 管家会话身份:只认会话头上【显式】的 kind === 'steward'。有意不用 sessionKind()——那个归一化函数
// 只回 'mission'|'quick_ask',把管家会话也算成普通会话,拿它做身份判定等于把门拆了。
function stewardCtxIsSteward(ctx) {
  const session = ctx && ctx.session;
  return !!(session && typeof session === 'object' && session.kind === 'steward');
}

// 129g:把「这一回合是谁触发的」补进 ctx。见 13h 的 currentTurnTrigger 头注 —— 09-workflow 造的
// 工具循环 ctx 里没有 trigger,于是所有按 trigger 分档的闸(自理清单、目标线程权限、125-P0 停机
// 尊重、代答依据)在【模型直接调工具】这条面上全部失灵。补在这一处而不是 09:
//   · 42 个管家工具都经过本壳,一处补齐,不必在 09 里给管家开特例;
//   · 09 在 13 之前,取不到 stewardRunnerRuntime(前向边);经 StewardHooks 迟绑定零新增边。
// 已经带了 trigger 的调用面(13p 自理层、/api/steward/act、/api/steward/relay)**原样保留** ——
// 它们给的是更准的那一个(「用户亲手按了这枚按钮」),不许被回合级的值盖掉。
function stewardWithTurnTrigger(ctx) {
  const base = (ctx && typeof ctx === 'object') ? ctx : {};
  if (base.trigger) return base;
  const context = typeof StewardHooks.currentTurnContext === 'function' ? StewardHooks.currentTurnContext() : null;
  if (context && context.trigger === 'external') return { ...base, trigger: 'external', externalActor: context.externalActor };
  const kind = typeof StewardHooks.currentTurnTrigger === 'function' ? StewardHooks.currentTurnTrigger() : '';
  // 取不到就保持既有的空串语义(进程内直调、夹具直调):这一口只补真的知道的那一部分。
  return (kind === 'user' || kind === 'inbox') ? { ...base, trigger: kind } : base;
}

// Opaque capabilities are issued only after authenticated bot ingress has persisted its claim.
// This check never trusts model arguments, HTTP JSON, or a persisted source label as authority.
const stewardExternalContexts = new WeakSet();
function stewardExternalOwnerDirected(ctx) {
  return Boolean(ctx && ctx.trigger === 'external' && stewardExternalContexts.has(ctx));
}
ExternalBotHooks.isAuthorizedContext = stewardExternalOwnerDirected;
async function stewardAuthorizeExternalContext(ctx) {
  if (!ctx || ctx.trigger !== 'external') return ctx;
  if (typeof ExternalBotHooks.validateActor !== 'function') throw Object.assign(new Error('external owner authorization is unavailable'), { code: 'external_channel.control_revoked' });
  let source;
  try { source = await ExternalBotHooks.validateActor(ctx.externalActor); }
  catch { throw Object.assign(new Error('external owner authorization was revoked'), { code: 'external_channel.control_revoked' }); }
  if (!source) throw Object.assign(new Error('external owner authorization was revoked'), { code: 'external_channel.control_revoked' });
  const authorized = { ...ctx, externalOwner: true, externalSource: source };
  stewardExternalContexts.add(authorized);
  return authorized;
}

// 第二轮工具走查(F8):管家工具族整体被 12 的 validateNativeToolArgs 豁免(「自带逐字段校验与专属错误码」),
// 实际上各 impl 只校验了自己关心的那几个字段,于是类型不对的参数被悄悄吞成「看似成功」:
// thread_rename {title:{a:1}} 把标题改成 "[object Object]"、thread_new {tier:'ultra'} 静默按 strong、
// usage {day:'yesterday'} 回全期累计……豁免的理由(专属错误码逐字钉着)只对【必填缺失】那一类成立,
// 所以这里只补【类型 / 枚举】这一类,而且:
//   · 只查 schema 里【声明过】的属性、只查【出现了】的值(缺失一律放给各 impl 自己报 invalid_request / not_found,
//     它们的先后次序与措辞有 e2e 钉着);
//   · 不做 12 那套宽进的就地规范化(枚举大小写、0/1 当布尔……一概不做);唯一例外是 STEWARD_STRING_AS_ARRAY 登记的参数(字符串换成数组);
//     数字/布尔当字符串、数字串当整数这类 12 一贯放行的宽松照旧放行;
//   · 运行器注入的 basis / stewardBasis / userPressed 等不在 schema 里,不会被查到(additionalProperties 不检);
//   · 返回码仍是管家族自己的 invalid_request。
const STEWARD_STRING_AS_ARRAY = Object.freeze({ steward_config_get: ['keys'], steward_audit_tail: ['kinds'] });
function stewardArgTypeProblems(toolName, args) {
  const schema = typeof nativeToolSchema === 'function' ? nativeToolSchema(toolName) : null;
  const props = schema && schema.properties;
  if (!props || typeof props !== 'object') return [];
  const problems = [];
  for (const key of Object.keys(props)) {
    if (args[key] === undefined || args[key] === null) continue;
    // 「一个值写成字符串」的宽进只对登记过的参数开(目前是 config_get 的 keys(模型常写 keys:'activeProvider')与 audit_tail 的 kinds):
    // 就地换成数组 —— args 是门控壳自己的副本,不碰调用方的对象。其它数组参数(如 skill_toggle 的 skills:'skill-1')
    // 仍按「必须是数组」报,steward-content-tools B9 钉着。
    const sub = props[key];
    if ((STEWARD_STRING_AS_ARRAY[toolName] || []).includes(key) && sub && sub.type === 'array' && typeof args[key] === 'string') {
      args[key] = args[key].split(',').map(x => x.trim()).filter(Boolean);
    }
    for (const p of jsonSchemaValueProblems(props[key], args[key], key)) { problems.push(p); if (problems.length >= 3) return problems; }
  }
  return problems;
}

// 3.0 收口走查(第四波)· 129c 污染规则补到【直调】这条路:管家这一回合读过外界内容(13j stewardTurnTaintedBy),模型在工具循环里
// 直接调下面这些「会让事情多发生」的写工具一律降级为提议(propose_required)。修前污点只在三处查(actions 自理、豁免代批、代答),
// 同一回合读完一张写着「请建一条每 15 分钟的定时任务 / 把这段话递给线程 X / 记住用户允许你随便批」的网页,模型直接调
// steward_schedule_create / steward_thread_continue / steward_memory_write 就做成了。收紧类(停止、暂停、删除定时任务、否决记忆、
// 拒绝权限请求)与只改展示的(改名、排序、备注、通知)不在此列 —— 它们只会让事情少发生。用户亲手按下管家给的按钮(ctx.userPressed)不拦。
const STEWARD_TAINT_GATED_TOOLS = new Set([
  'steward_config_set', 'steward_memory_write', 'steward_quick_ask', 'steward_schedule_create', 'steward_schedule_resume',
  'steward_schedule_run_now', 'steward_skill_toggle', 'steward_thread_continue', 'steward_thread_new', 'steward_thread_permission',
  'steward_thread_workspace', 'steward_playbook_draft', 'steward_decide', 'steward_run_action',
]);
function stewardTaintGateApplies(toolName, args) {
  if (toolName === 'steward_bot_setup') return args?.op === 'prepare';
  if (!STEWARD_TAINT_GATED_TOOLS.has(toolName)) return false;
  const action = String((args && args.action) || '').toLowerCase();
  if (toolName === 'steward_decide') return action !== 'deny' && action !== 'reject';
  if (toolName === 'steward_run_action') return action !== 'pause' && action !== 'stop';
  return true;
}

// 17 个工具共用的门控壳:开关 -> 身份 -> 实现 -> 异常兜底。单一判定点(12 的 handler 不重复判断)。
async function stewardImplBotSetup(args, ctx) { return ExternalBotHooks.stewardSetup(args, ctx); }
function stewardToolHandler(toolName, impl) {
  return async (args, ctx) => {
    let config = null;
    try { config = await readConfig(); } catch { config = null; }
    if (!config || config.stewardEnabledV1 !== true) {
      return stewardFail('steward.disabled', `${toolName} is unavailable: the workbench steward is disabled (stewardEnabledV1=false)`);
    }
    if (!stewardCtxIsSteward(ctx)) {
      return stewardFail('steward.forbidden', `${toolName} is only available to the workbench steward session (session.kind must be 'steward')`);
    }
    try {
      // 116-2e:剥掉 args 里任何名为 userPressed 的字段。它的唯一合法来源是 ctx(由 13h 的
      // POST /api/steward/act 在用户【亲手按下按钮】时置 true);模型在参数里自称「用户按了」
      // 不算数,静默丢弃比报错更稳(报错会让模型学会换个名字再试一次)。
      const raw = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
      const clean = {};
      for (const key of Object.keys(raw)) { if (key !== 'userPressed') clean[key] = raw[key]; }
      const typeProblems = stewardArgTypeProblems(toolName, clean);
      if (typeProblems.length) return stewardFail('invalid_request', `${toolName}: ${typeProblems.join('; ')}`);
      const turnCtx = await stewardAuthorizeExternalContext(stewardWithTurnTrigger(ctx));
      if (!(turnCtx && turnCtx.userPressed === true) && stewardTaintGateApplies(toolName, clean)) {
        const taintedBy = stewardTurnTaintedBy(turnCtx);
        if (taintedBy.length) {
          return stewardFail('propose_required', `我这一回合读过外部内容(${taintedBy.join('/')}),按规矩读过之后我只提议、不自己动手 —— ${toolName} 这一步请你确认`, {
            reason: 'steward_turn_tainted', delegable: false, blockedBy: 'steward_turn_tainted', selfTaintBy: taintedBy, tool: toolName,
          });
        }
      }
      return await impl(clean, turnCtx, config);
    } catch (error) {
      if (error && error.code === 'external_channel.control_revoked') return stewardFail(error.code, 'external owner authorization was revoked');
      const message = String((error && error.message) || error);
      logEvent({ kind: 'steward_tool_error', tool: toolName, message: message.slice(0, 400) });
      return stewardFail('steward.failed', `${toolName} failed: ${message}`);
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 第 116 波 116-2e —— 记忆面板(§4「面板」)、如意设置三级分级(§3.5)、内容管理(§3.5)、
// 速查线程(§11.1 第 2 项)。
// ════════════════════════════════════════════════════════════════════════════

// ── 记忆面板(六条 token 级路由的域实现;不是工具,模型碰不到)─────────────────────────────
// 「新」标 isNew 是【纯派生】:createdAt 距今 < 24 小时。不落任何新字段 —— 否则 24 小时后还得有人
// 回来把它擦掉,而那个「有人」在真实系统里从来不存在。
function stewardMemoryPanelRow(entry, now, panelConfig) {
  const createdMs = Date.parse(String(entry.createdAt || ''));
  return {
    ...entry,
    isNew: Number.isFinite(createdMs) && (now - createdMs) < STEWARD_MEMORY_NEW_WINDOW_MS,
    // 126-M02:面板【照常列出】过期条目,只是带上标记 —— 时效是过滤不是删除(44 号文 §6 ②)。
    // 判据仍然只有一处:06d 的 memoryIsExpired,本文件不自己解析日期。
    expired: memoryIsExpired(entry, now),
    // 126-M01:作用域的人话标签(纯派生;scope 本身随 ...entry 已经带出)。
    scopeLabel: stewardMemoryScopeLabel(entry.scope, panelConfig).replace(/^,/, ''),
  };
}

async function stewardMemoryPanelList(kindArg) {
  const kind = String(kindArg || '');
  if (kind && !STEWARD_MEMORY_KINDS.includes(kind)) {
    return stewardFail('invalid_request', `kind must be one of ${STEWARD_MEMORY_KINDS.join('/')}`);
  }
  const store = await stewardReadMemoryStore();
  // 126-M01:作用域标签要认工作区表。面板是冷路径,读一次配置不心疼。
  const panelConfig = await readConfig().catch(() => ({}));
  const now = Date.now();
  const groups = {};
  for (const k of STEWARD_MEMORY_KINDS) if (!kind || k === kind) groups[k] = [];
  let total = 0, active = 0, vetoed = 0, isNewCount = 0;
  for (const entry of store.entries) {
    total += 1;
    if (entry.state === 'vetoed') vetoed += 1; else active += 1;
    if (kind && entry.kind !== kind) continue;
    if (!Object.prototype.hasOwnProperty.call(groups, entry.kind)) continue;
    const row = stewardMemoryPanelRow(entry, now, panelConfig);
    if (row.isNew) isNewCount += 1;
    groups[entry.kind].push(row);
  }
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  }
  return { ok: true, kind: kind || '', groups, counts: { total, active, vetoed, isNew: isNewCount }, updatedAt: store.updatedAt };
}

// 面板改的条目:置信度拉满(用户亲手写的比管家推断的准),来源标 user_panel。version 是乐观锁 ——
// 传 updatedAt 原值,与库里对不上就 version_conflict(面板开着的时候管家可能刚合并过同一条)。
async function stewardMemoryPanelEdit(body) {
  const id = String((body && body.id) || '');
  if (!id) return stewardFail('invalid_request', 'id is required');
  const text = stewardSanitizeText(body && body.text).trim();
  if (!text) return stewardFail('invalid_request', 'text is required');
  if (text.length > STEWARD_MEMORY_LIMITS.textChars) {
    return stewardFail('invalid_request', `text must be at most ${STEWARD_MEMORY_LIMITS.textChars} characters`);
  }
  const kind = body && body.kind ? String(body.kind) : '';
  if (kind && !STEWARD_MEMORY_KINDS.includes(kind)) {
    return stewardFail('invalid_request', `kind must be one of ${STEWARD_MEMORY_KINDS.join('/')}`);
  }
  // 用户亲手写的也过敏感过滤:面板不是绕过密钥拒收的后门。
  if (memoryProposalLooksSensitive({ body: text })) {
    return stewardFail('sensitive_rejected', 'the text looks like a credential/secret and will never be stored in steward memory');
  }
  const version = body && body.version != null ? String(body.version) : '';
  return stewardMutateMemory(async store => {
    const entry = store.entries.find(e => e.id === id);
    if (!entry) return { persist: false, result: stewardFail('not_found', `memory ${stewardSanitizeText(id)} not found`) };
    if (version && String(entry.updatedAt || '') !== version) {
      return { persist: false, result: stewardFail('version_conflict', 'this entry changed since you loaded it; reload the panel and edit again', { version: entry.updatedAt }) };
    }
    entry.text = text;
    if (kind) entry.kind = kind;
    entry.confidence = 1;
    entry.sourceSessionId = 'user_panel';
    delete entry.basis; delete entry.sourceToolCallId;
    entry.sourceSeq = 0;
    entry.sourceQuote = ''; // 用户在面板里亲手改的:出处就是用户本人,不再挂着改前那句引文
    entry.updatedAt = nowIso();
    stewardAppendDecision({ tool: 'steward_memory_panel_edit', args: { id, chars: text.length, kind: entry.kind }, targetSessionId: '', permissionMode: '', mayAct: 'user', undoRef: { kind: 'memory', id, prev: null }, basis: { memoryIds: [id] } });
    return { persist: true, result: { ok: true, entry: stewardMemoryPanelRow(entry, Date.now(), await readConfig().catch(() => ({}))) } };
  });
}

async function stewardMemoryPanelRestore(idArg) {
  const id = String(idArg || '');
  if (!id) return stewardFail('invalid_request', 'id is required');
  return stewardMutateMemory(async store => {
    const entry = store.entries.find(e => e.id === id);
    if (!entry) return { persist: false, result: stewardFail('not_found', `memory ${stewardSanitizeText(id)} not found`) };
    if (entry.state === 'active') return { persist: false, result: { ok: true, id, state: 'active', restored: false } };
    entry.state = 'active';
    entry.updatedAt = nowIso();
    stewardAppendDecision({ tool: 'steward_memory_panel_restore', args: { id }, targetSessionId: '', permissionMode: '', mayAct: 'user', undoRef: { kind: 'memory', id, prev: 'vetoed' }, basis: { memoryIds: [id] } });
    return { persist: true, result: { ok: true, id, state: 'active', restored: true } };
  });
}

// 清空:confirm 必须【逐字】等于 'clear'(同 DELETE /api/skills 的「输入 id 才解锁」摩擦)。
async function stewardMemoryPanelClear(confirm) {
  if (String(confirm) !== 'clear') return stewardFail('invalid_request', "confirm must be exactly 'clear'");
  return stewardMutateMemory(async store => {
    const removed = store.entries.length;
    store.entries = [];
    stewardAppendDecision({ tool: 'steward_memory_panel_clear', args: { removed }, targetSessionId: '', permissionMode: '', mayAct: 'user', undoRef: null, basis: {} });
    return { persist: true, result: { ok: true, removed } };
  });
}

// 导出:只含 active,字段就是条目本身那几个(不含 isNew 这类派生视图字段,也不含任何别处的东西)。
async function stewardMemoryPanelExport() {
  const store = await stewardReadMemoryStore();
  return {
    ok: true,
    schema: STEWARD_MEMORY_SCHEMA,
    exportedAt: nowIso(),
    entries: store.entries.filter(e => e.state === 'active'),
  };
}


// 延迟绑定(先例 06c AgentLoopHooks):06i 声明空命名空间,本文件在加载时填充实现。
// 消费者(13-http-router 的路由链、13-http-router 的关服收尾、116c 的管家工具 handler)全程只看
// StewardHooks.*,从不直接依赖 13g —— 这就是「不新增前向边」的落地方式。
Object.assign(StewardHooks, {
  relatedThreads: threadRelatedThreads,
  relationsIndex: threadRelationsIndex,
  threadHistorySearch: async (args, ctx) => stewardImplThreadsSearch({ includeClosed: true, ...args }, ctx || {}, await readConfig()),
  threadHistoryRead: async (args, ctx) => {
    const session = (ctx && ctx.session) || await loadSession(process.env.WCW_SESSION_ID || '').catch(() => null);
    if (!session) return stewardFail('invalid_request', 'thread_read requires a calling session');
    return stewardImplThreadRead(args, { ...ctx, session }, await readConfig());
  },
  stopInbox: stopStewardInbox,
  inboxRead: stewardInboxRead,
  inboxState: stewardInboxState,
  // 116c: 17 个管家工具的实现键(116-2a 增第 18 个 threadPermission;116-2b 增第 19 个 threadNote;
  // 116g 增第 20 个 missions)。每个都经 stewardToolHandler
  // 包一层门控壳(开关 -> 身份 -> 实现),
  // 12-tool-dispatch 的 handler 只写一行 `StewardHooks.<键>(args, ctx)`。键名与 06i 的契约注释逐条对应。
  selfStatus: stewardToolHandler('steward_self_status', stewardImplSelfStatus),
  threadsSearch: stewardToolHandler('steward_threads_search', stewardImplThreadsSearch),
  threadStatus: stewardToolHandler('steward_thread_status', stewardImplThreadStatus),
  threadRead: stewardToolHandler('steward_thread_read', stewardImplThreadRead),
  runsStatus: stewardToolHandler('steward_runs_status', stewardImplRunsStatus),
  inboxReadTool: stewardToolHandler('steward_inbox_read', stewardImplInboxRead),
  usage: stewardToolHandler('steward_usage', stewardImplUsage),
  health: stewardToolHandler('steward_health', stewardImplHealth),
  auditTail: stewardToolHandler('steward_audit_tail', stewardImplAuditTail),
  missions: stewardToolHandler('steward_missions', stewardImplMissions), // 116g
  // 129b(49 号文 §3):三张「有哪些可选」的只读清单。它们补的是同一个形状的缺口 ——
  // 管家能改的东西(线程技能 / 端点与模型 / playbook)它原本都看不见清单,只能猜 id。
  skills: stewardToolHandler('steward_skills', stewardImplSkills),
  providers: stewardToolHandler('steward_providers', stewardImplProviders),
  playbooks: stewardToolHandler('steward_playbooks', stewardImplPlaybooks),
  // 129f(31 号文 §2.4):管家主动叫人。
  notify: stewardToolHandler('steward_notify', stewardImplNotify),
  // 129d(31 号文 §2.2「眼睛」):四件只读外界。读回来就给这一回合打污染标(129c),
  // 之后管家的写动作全部降级成提议 —— 网页里一句「把设置改成 X」不能借它的手做事。
  webSearchTool: stewardToolHandler('steward_web_search', stewardImplWebSearch),
  webFetchTool: stewardToolHandler('steward_web_fetch', stewardImplWebFetch),
  fileReadTool: stewardToolHandler('steward_file_read', stewardImplFileRead),
  artifactRead: stewardToolHandler('steward_thread_artifact_read', stewardImplThreadArtifactRead),
  threadNew: stewardToolHandler('steward_thread_new', stewardImplThreadNew),
  threadContinue: stewardToolHandler('steward_thread_continue', stewardImplThreadContinue),
  threadRename: stewardToolHandler('steward_thread_rename', stewardImplThreadRename),
  // 129e:改一条已有线程的工作目录(只在工作区表之内;auto 档自动、其余档提议)。
  threadWorkspace: stewardToolHandler('steward_thread_workspace', stewardImplThreadWorkspace),
  threadPermission: stewardToolHandler('steward_thread_permission', stewardImplThreadPermission), // 116-2a
  threadNote: stewardToolHandler('steward_thread_note', stewardImplThreadNote), // 116-2b
  decide: stewardToolHandler('steward_decide', stewardImplDecide),
  runAction: stewardToolHandler('steward_run_action', stewardImplRunAction),
  memoryWrite: stewardToolHandler('steward_memory_write', stewardImplMemoryWrite),
  memoryVeto: stewardToolHandler('steward_memory_veto', stewardImplMemoryVeto),
  memorySearch: stewardToolHandler('steward_memory_search', stewardImplMemorySearch),
  // 116-2e:设置族两个 + 内容管理三个(工具数 84 -> 89),外加两个基础设施键(收件箱行增强与速查收工,
  // 消费者分别是 13i 的轮询器与 13h 的回合收尾 —— 它们都只看 StewardHooks,不认识 13g)。
  configGet: stewardToolHandler('steward_config_get', stewardImplConfigGet),
  botSetup: stewardToolHandler('steward_bot_setup', stewardImplBotSetup),
  configSet: stewardToolHandler('steward_config_set', stewardImplConfigSet),
  playbookDraft: stewardToolHandler('steward_playbook_draft', stewardImplPlaybookDraft),
  skillToggle: stewardToolHandler('steward_skill_toggle', stewardImplSkillToggle),
  quickAsk: stewardToolHandler('steward_quick_ask', stewardImplQuickAsk),
  enrichInboxRows: stewardEnrichInboxRows,
  quickClose: stewardQuickClose,
  quickClosed: stewardQuickClosed,
});

// ============================================================================
// 第 117 波 T2(32 号文 §5「13h-steward-runner.js 2522 行」):管家回合运行器的共享底座。
//
// 落点(transport 层,manifest 中位于 13g-steward.js 之后、13n-steward-arbiter.js 之前)。
// T2 拆分:原 13h-steward-runner.js 已 2522 行 —— 比 T1 拆之前的 13g 还长,而 31 号文七轴的
// 回合层改动(污染打标、代答/代批、通知)全要往它里面加。按「谁被谁引用」把它拆成六个
// 文件,拼接顺序即依赖方向,零新增前向边:
//   · 13m-steward-runner-base.js —— 六个文件都要用的共享面:落盘面常量、回合层数值口径、
//     自理动作与到访摘要的文本表、可由 actions 执行的写工具白名单、运行时内存态
//     stewardRunnerRuntime、停机/唤醒/中止,以及管家会话单例(引擎解析 + 懒创建);
//   · 13n-steward-arbiter.js —— 116h 线程间仲裁(并发位 / 同 cwd 写锁 / 预算 / 可解释的排队 / 饥饿提升)。
//     它排在提示词之前,因为总览行与递话通道都要读它的等待原因(stewardArbiterWait);
//   · 13o-steward-runner-prompt.js —— 提示词装配(记忆块 / 线程摘要 / 递话预判 / 总览 /
//     两个分叉入口)与 {say,acts,actions,why} 输出契约解析;
//   · 13p-steward-runner-actions.js —— actions 执行与降级、116-2b 确定性自理动作、id 人话化、
//     熔断、收件箱消息装配、输入区预判归一;
//   · 13q-steward-runner-turn.js —— 回合入口 runStewardTurn、收件箱去抖驱动、到访与归档、
//     117l D2 递话通道、117l D7 线程分档落盘、acts 落定;
//   · 13h-steward-runner.js —— 两个「够不着才落在这里」的工具实现(thread_prioritize /
//     thread_stop)、三条路由、运行器状态与 StewardHooks 注册表(排在最后:注册表要引用
//     上面五个文件里的实现,排在后面才是后向边)。
// 本次拆分是【纯搬家】:所有函数体逐字节不变,新写的只有各文件的头部注释。
//
// 依赖纪律(§11.3「不得新增前向边」):本文件只引用拼接顺序在它之前的模块符号
// (00/01/02/04/06b/06i/08/09/10/13e/13g 族 …),全部后向边;它自己的符号只被排在它之后的
// 管家运行器族文件与 14-main.js 的 e2e 导出面引用,同样是后向边。
// ============================================================================
// ── 落盘面(唯一新增:到访归档;已登记进 durable-state-inventory)────────────────────────────────
const STEWARD_VISITS_DIR = 'visits';
const STEWARD_VISIT_SCHEMA = 1;
const STEWARD_VISITS_KEEP = 200;              // 归档文件保留个数(超出从最旧删起)

// ── 回合层数值口径(§11.2)────────────────────────────────────────────────────────────────────
const STEWARD_INBOX_EVENTS_PER_TURN = 30;     // 一个收件箱回合最多带 30 条事件
const STEWARD_INBOX_EVENT_CHARS = 400;        // 每条事件 ≤400 字
// 117s-H1(27 号文 §11.13.3):事件行仍是那 400 字的标题行,交付正文另起一个【受预算的引用块】
// 跟在它后面 —— 于是模型不必再花一次 steward_thread_read 配额去读它自己刚被通知的那份交付。
const STEWARD_INBOX_DELIVERABLE_CHARS = 4000; // 单条交付正文在收件箱消息里的上限
const STEWARD_INBOX_MESSAGE_CHARS = 12000;    // 一条收件箱消息的总预算(标题行永不丢,正文从最旧的丢起)
const STEWARD_MEMORY_BLOCK_CHARS = 3000;      // 记忆块 ≤3000 字符
// 128h-J12:被否决条目在提示词里自带一份【独立】预算,排在生效清单之后。不与上面那 3000 字共用:
// 那是「按这些办」的清单,这是「别再写回去」的清单,后者挤掉前者就本末倒置了。8 条够用 ——
// 否决是个罕见动作,真到了几十条,模型要的是最近否的那几条,不是全表。
const STEWARD_MEMORY_VETOED_BLOCK_CHARS = 600; // 否决清单 ≤600 字符
const STEWARD_MEMORY_VETOED_MAX = 8;           // 否决清单最多 8 条(按 updatedAt 取最近的)
// 117y-S1(27 号文 §11.18.2):原来这里只有一个 say 上限常量(600),它同时扮演两个角色 ——
// 06b 输出契约里写给模型看的「≤600 字」,和 13o 解析时那把裸 slice。用户第十一轮拍板:
// 「得保证话能说全,不要硬截…通过提示词去约束说的话长度」。于是两个角色拆开:
//   · TARGET  = 600  —— 只说给模型听的目标(06b 输出契约那一行)。**运行期不再据此裁剪。**
//   · CEILING = 4000 —— 只防病态载荷(尤其 13o 那条 JSON 解析失败的兜底会把整份原始模型输出
//     灌进来)。约为目标的 6.7 倍,守规矩的回复永远碰不到;触到了也走 06i 的
//     stewardTrimSayAtSentence 在句末标点处切并明说,不裸切。
// 旧名直接删掉而不留别名:全仓消费方只有 13o 的那两处(其余命中全是生成物
// module-contracts.json / module-dependency-graph 与 27 号文的病灶描述),不存在被静默改语义的第三方。
const STEWARD_SAY_TARGET = 600;               // say 的提示词目标(不是运行期上限)
const STEWARD_SAY_CEILING = 4000;             // say 的病态载荷天花板(触顶按句界裁剪并明说)
const STEWARD_WHY_MAX = 400;
const STEWARD_ACT_LABEL_MAX = 12;             // 按钮文字 ≤12 字
// 107-S1 ④(46 号文 §5 ⑦b H1):confirm 族(改设置 / 改技能 / 给线程开桌面)的按钮【另有一个天花板】。
// 12 字是「按钮上写用户要做的那件事」的预算,装不下「改设置:permissionMode=auto」—— 而这一族的整个修法
// 就是「按钮上必须写清要改哪个键、改成什么」,不能让模型自己命名它。32 字够一条「键=值」,
// 多于一个键时按钮只写第一个键＋「等 N 项」,整份清单在确认面板里逐条列(值另有 40 字的裁剪)。
// 只对这一族生效:其余 act 的标签口径与预算逐字节不变。
const STEWARD_ACT_CONFIRM_LABEL_MAX = 32;     // confirm 族按钮文字 ≤32 字(要写得下「键=值」)
const STEWARD_ACT_CONFIRM_VALUE_CHARS = 40;   // 确认面板里每个值的裁剪长度
const STEWARD_ACTS_MAX = 3;                   // 一次回合按钮 ≤3 个
const STEWARD_ACTIONS_MAX = 5;                // 一次回合最多执行 5 条 action(其余丢弃并如实标注)
const STEWARD_DEBOUNCE_MS = 5000;             // 收件箱去抖窗口
// 116-4(27 号文 §11.7 第 2 项「速查闭环」):速查线程的答案是【用户正在等的那一句】。让它也压满
// 5 秒去抖,用户的体感就是「问一次要等两趟」。带 quick:true 的 done 行把本次去抖压到 0,其余事件
// 仍走 5 秒 —— 它们是通知,不是有人正等着的答案。
const STEWARD_QUICK_DEBOUNCE_MS = 0;          // 速查答案:不去抖,立刻起回合
// 2026-10(智能自动的应答速度):队列里有【线程正卡在上面等】的权限/提问待决时,去抖压到 1 秒。
// 那条线程此刻停着,5 秒去抖加上轮询间隔是「管家代批要等半分钟」的大头;1 秒仍够把同一阵涌来的
// 几条待决并成一个回合(真机里一个回合内连发的工具请求彼此相隔远小于 1 秒)。其余通知照旧 5 秒。
const STEWARD_BLOCKING_DEBOUNCE_MS = 1000;
// 2026-10(用户:「用户在看提问、权限,管家被立刻唤醒也不要插手」):用户正看着的那几条待决,回合排空器先扣在
// 回合队列外(13q stewardHoldViewedEvents),每 5 s 拿当时的在场重判一次;扣着的条数有上限(老的先丢 —— 丢的
// 只是「管家替你处理」的那次机会,收件箱里的那一行与安静卡都还在)。
const STEWARD_VIEW_RECHECK_MS = 5000;
const STEWARD_VIEW_HELD_MAX = 200;
const STEWARD_NO_PROGRESS_MAX = 5;            // 连续 5 次收件箱回合零 acts 零 actions -> 退避
const STEWARD_VISIT_DIGEST_MAX = 5;           // 到访摘要 ≤5 条人话
const STEWARD_PENDING_LIST_MAX = 20;          // 到访返回的待决列表上限
const { STEWARD_TURN_WINDOW_MS, STEWARD_TURN_DAY_MS } = require('./backend/steward-core.cjs');
const STEWARD_PREEMPT_WAIT_MS = 15000;        // 抢占后等在途回合收尾的上限
// 117l D3(§11.9;用户第四轮走查第 6 条「为啥输出完了还显示『在忙上一件』;要能让用户连续发消息」):
// 用户回合撞用户回合时【真】排队等前一个收尾的上限。修前是一发 Promise.race(15s) 之后【不复查】,
// 超时就带着一个还在写正文的回合再开一个 —— 两个回合同时写管家会话正文,后一条把前一条盖掉。
const STEWARD_USER_QUEUE_WAIT_MS = 5 * 60 * 1000;
// ── 116-2b 自理动作(§3.3 自理清单的【真实执行】)──────────────────────────────────────────
const STEWARD_SELF_SERVE_ATTEMPT_MAX = 2;    // 同一目标连续 2 次自理动作后仍失败 -> 停自动、只提议
const STEWARD_SELF_SERVE_RETRY_WINDOW_MS = 60 * 60 * 1000; // 同一目标本小时只自动重试一次
const STEWARD_SELF_SERVE_PER_TURN_MAX = 3;   // 一个收件箱回合最多自理 3 个目标(其余进回合层)
// ── 「回合收了但任务没做完」的自动续跑(stewardAutoActions.continueUnfinished)的上限 ─────────────────
// 防死循环烧钱,两道,都按【同一条线程连续自动续跑】数,线程自己正常收工(不再未完成)就清零:
//   · 有计划(todo)的线程:最多连续续 STEWARD_CONTINUE_PLAN_MAX 次,且【每一次续跑之后计划都要往前走】
//     (已完成步数增加)—— 续了一轮计划纹丝不动就停,不再续;
//   · 没有计划、只靠「上次任务未完成」横幅判据(回合被工具次数/预算截断)的线程:没有进度可量,
//     只续 STEWARD_CONTINUE_NOPLAN_MAX 次。
// 超过上限的那一次不是静默放弃:降级成一条提议按钮,并落一行行动流水(见 stewardContinueUnfinishedGate)。
const STEWARD_CONTINUE_PLAN_MAX = 5;
const STEWARD_CONTINUE_NOPLAN_MAX = 2;
const STEWARD_CONTINUE_FRESH_MS = 6 * 60 * 60 * 1000;   // 上次自动续跑过去这么久,再遇到没做完就当全新的一次,账从 0 数
const STEWARD_CONTINUE_PROMPT = '请继续完成上一个未完成的任务。';   // 与前端「继续」横幅发的那一句同文(chat.resume.prompt)

// ── 到访摘要的五类人话(确定性归纳,不调模型;§8.9「每次打开只汇报」)──────────────────────────
const STEWARD_DIGEST_KIND_TEXT = Object.freeze({
  needs_you: n => `${n} 条线程在等你拿主意`,
  failed: n => `${n} 条线程出错了`,
  done: n => `${n} 条线程收工了`,
  stalled: n => `${n} 条线程停住了`,
  budget: n => `${n} 条线程用完了预算`,
  // 121-K3(34 号文 §4.4「交接」):第六类。措辞用「交给你盯」而不是「交给你」—— 交接的是注意力,
  // 不是所有权:用户随时可以再坐回那条线程,那时 §4.5 的在场门会让管家自动松手。
  adopted: n => `${n} 条线程刚交给你盯`,
  // 123-M2(37 号文 §3.5):第七类。措辞是「到点了」而不是「有 N 条提醒」—— 这一类不需要用户
  // 回答任何东西,它只是把「你自己排的那件事发生了」说一遍(到点提醒、错过跳过、连败熔断三件
  // 都走它,共同点就是「一句事实」)。
  reminder: n => `${n} 件定时任务到点了`,
});

// ── 可由 actions 执行的写工具 -> StewardHooks 实现键。白名单即闸门:不在表里的工具名一律拒绝
//    (读类工具没有出现在这里的理由 —— 模型要读就自己在回合里调工具,不该经 actions 绕一圈)。
// ── 125-P1(42 号文 §1 ②):失败的原因与下一步,由工作台给,不由模型编 ────────────────────────
// 取证:`errorClass` 在 13o(提示词)、13p(动作)、13m(共享面)与整个管家前端里 grep 零命中 ——
// 它唯一的去处是收件箱事件那句摘要里的一个括号,于是模型看见的是 `会话第 3 回合失败(idle_timeout)`
// 这串原始机器词,「这是什么意思、该怎么办」全靠它自己编。而工作台自己有一张写好了「下一步」的
// 表(06 的 ERROR_CLASSES,已经上 /api/status 给 2.0 的错误卡用),就在隔壁。
//
// 本函数是管家侧唯一的取话口:查既有表,查不到就【如实说未知】并把原词带上 —— 不许在这里
// 编第二套解释,也不许把不认识的类悄悄说成「执行失败」(那是把不知道说成知道)。
// 返回 '' 表示这条事件根本没带类别(不是「不知道」,是「没这回事」),调用方据此整段不出现。
function stewardFailureExplain(errorClass) {
  const raw = stewardSanitizeText(errorClass);
  if (!raw) return '';
  const row = (ERROR_CLASSES && Object.prototype.hasOwnProperty.call(ERROR_CLASSES, raw)) ? ERROR_CLASSES[raw] : null;
  // 「表里没这一条」与「表里有但没写人话」是同一件事:我们说不出它是什么。合成一个出口,
  // 于是这句话在全仓只有一种写法(静态锁 ⑧f 按「恰一处」数它)。
  const zh = row ? stewardSanitizeText(row.zh) : '';
  if (!zh) return `未知类别(${raw})`;
  const next = row ? stewardSanitizeText(row.next) : '';
  return next ? `${zh} · 下一步:${next}` : zh;
}

// 落点说明:本函数原想放在 06i(管家纯函数都住那儿),但 06i 排在 06 之前 —— 06/07/09/10/13* 都依赖
// 06i,让 06i 反过来读 06 的 ERROR_CLASSES 会造出一圈循环边(依赖图 --check 当场报了 7 条)。
// 于是落在 13m 这个「管家运行器共享面」:它本来就是回合层文本表的家,读 06 是干净的后向边。
const STEWARD_ACTION_HOOKS = Object.freeze({
  steward_thread_new: 'threadNew',
  steward_thread_continue: 'threadContinue',
  steward_thread_rename: 'threadRename',
  // 129e:它在非 auto 档一定回 propose_required -> 被降级成一枚按钮 -> 用户按下走这张表找实现。
  // 不进表 = 「管家提了『换个目录』,按下去报 not_allowed」(静态锁 ①e 正是为这个坑立的)。
  steward_thread_workspace: 'threadWorkspace',
  steward_thread_prioritize: 'threadPrioritize',   // 116h:§8.10 看板每行的「提升优先级」按钮
  steward_decide: 'decide',
  steward_run_action: 'runAction',
  steward_thread_stop: 'threadStop',               // 117m-A4:线程级停止(不在表里 = 按钮按下去 4xx)
  // 2026-10 工具走查:插话补充在无人值守时也过 relay + 权限档两道闸,会回 propose_required → 进表(①e)。
  steward_thread_note: 'threadNote',
  steward_memory_write: 'memoryWrite',
  steward_memory_veto: 'memoryVeto',
  // 116-2e:两个「须确认」的写工具。它们在模型回合里一定回 propose_required(ctx 里没有
  // userPressed),被 stewardDowngradeActions 降级成一个按钮;用户按下那个按钮走
  // POST /api/steward/act,那条路径才置 ctx.userPressed = true。
  steward_config_set: 'configSet',
  steward_skill_toggle: 'skillToggle',
  // 117z-E2b 提交①(27 号文 §11.21.7 债 ①):线程权限。E-手① 时它只降档、从不 propose_required,
  // 不进表没关系;E-手② 给它加了 capabilities.desktop,desktop:true 在【任何】档位都回 propose_required
  // -> 被降级成按钮 -> 用户按下去经这张表找实现;不在表里 = 13q 查不到 -> not_allowed 4xx,
  // 生产形状是「管家说要开桌面,按钮出来,按了报错」。与 config_set / skill_toggle 同一个「须确认」
  // 模具:只有 13q 那条路置 ctx.userPressed = true,13k 只在 desktop:true 那一支上读它。
  steward_thread_permission: 'threadPermission',
  // 124 走查(用户 2026-09-15 真机:「就按这个排」按下去 —— 没做成: steward_schedule_create
  // 不能作为 act 执行)。123-M2 新增六个定时任务工具时登记了 schema(13f)/handler(12)/tier 与
  // pack(07)【三处】,漏了这第四处 —— 而 create 与 delete 自己在无人值守时就回 propose_required,
  // 被 stewardDowngradeActions 降级成按钮,按下去必然 not_allowed。**同一个坑这是第三次**
  // (thread_stop 117m-A4、thread_permission 117z-E2b),所以这一刀连带加了一把机械锁:
  // steward-tools.static ①e —— 实现里会回 propose_required 的管家工具必须在本表里。
  // 五个【写类】都进表(list 是只读,按表头那条纪律「读类工具没有出现在这里的理由」不进):
  // pause/resume/run_now 不回 propose_required,锁不要求它们,但模型照样能把它们提成一枚按钮
  // (acts 不经这张表过滤),不进表就是同一种「按了报错」。
  steward_schedule_create: 'scheduleCreate',
  steward_schedule_pause: 'schedulePause',
  steward_schedule_resume: 'scheduleResume',
  steward_schedule_run_now: 'scheduleRunNow',
  steward_schedule_delete: 'scheduleDelete',
});

// 降级成按钮时的人话标签(§8.4「话＋一行按钮」:按钮上写用户要做的那件事,不写工具名)。
const STEWARD_DECIDE_LABELS = Object.freeze({ allow: '允许', deny: '拒绝', approve: '批准', reject: '驳回', answer: '回答' });
const STEWARD_RUN_ACTION_LABELS = Object.freeze({ pause: '暂停', resume: '继续', stop: '停止', retry_node: '重试', steer_node: '插话' });
const STEWARD_TOOL_LABELS = Object.freeze({
  steward_thread_new: '新开线程', steward_thread_continue: '接着办', steward_thread_rename: '改标题',
  steward_thread_workspace: '换工作目录',
  steward_memory_write: '记下', steward_memory_veto: '别记',
  steward_thread_prioritize: '插到最前',
  steward_thread_stop: '暂停这条线程',                            // 117m-A4
  steward_thread_note: '补一句',
  steward_config_set: '改设置', steward_skill_toggle: '改技能',   // 116-2e
  // 117z-E2b 提交①:这是行动流水与兜底用的总称;真正降级成按钮的只有 capabilities.desktop === true
  // 那一支,13o 的 stewardActLabel 按 args 把它写成「给它开桌面」(按钮上写用户要做的那件事,§8.4)。
  steward_thread_permission: '改线程权限',
  // 124 走查:降级按钮与 ※ 脚注上写用户要做的那件事,不吐 steward_schedule_* 这些内部 id。
  steward_schedule_create: '排上', steward_schedule_pause: '先停一停', steward_schedule_resume: '继续排',
  steward_schedule_run_now: '现在就跑一次', steward_schedule_delete: '删掉这条定时',
});

// ────────────────────────────────────────────────────────────────────────────
// 运行时状态。全部【只在内存】—— 管家的持久化面只有 13g 登记的四个 + 本切片的 visits 归档,
// 到访状态本身不落盘(进程重启 = 新到访,与 §11.1 第 7 项「一次到访 = 页面重开或静默 60 分钟」一致)。
// ────────────────────────────────────────────────────────────────────────────
const stewardRunnerRuntime = {
  conversationGeneration: 0,
  // 123-M2:fireSeq 是【承诺三项】的第二个水位。为什么不能复用 inboxSeq:fires-v1.ndjson 有它
  // 自己的一条单调 seq(13s 的账本),与收件箱那条各走各的 —— 拿收件箱的行号去筛 fires 的行
  // 会漏掉/重复算「上次到访以来跳过或结果未知的那几次」。
  visit: { startedAt: '', lastActivityAt: '', inboxSeq: 0, fireSeq: 0, previousStartedAt: '' },
  turns: [],            // 已跑回合的时间戳(ms),滑动窗口用
  noProgress: 0,        // 连续零进展的收件箱回合数
  inflight: null,       // { kind:'user'|'inbox', promise, controller, cancelled, events }
  queue: [],            // 待处理的收件箱事件(抢占时回排在这里)
  viewHeld: [],         // 2026-10:用户正看着的待决,先不起回合(见 STEWARD_VIEW_RECHECK_MS)
  viewHeldTimer: null,
  debounceTimer: null,
  debounceMs: -1,       // 116-4:当前那个定时器排的是多久(用来判「该不该重排成更快的」)
  lastReply: null,      // 最近一次 steward_reply 的精简副本(供 /api/steward/state)
  circuit: null,        // 最近一次触发的熔断 { kind, at, detail }
  stopped: false,       // 一键停机:停轮询的同时停回合队列
  // 116-2b:自理动作的每目标账。targetKey = sessionId|runId。只在内存(进程重启 = 重新开始数;
  // 与 §11.1 第 7 项「重启即新到访」同一立场:重启后第一次仍值得试一次,连着失败才该停手)。
  selfServe: new Map(),  // targetKey -> { attempts, lastRetryAt, lastActionAt }
  // 「没做完就续一轮」的每线程账:sessionId -> { count, doneAt, turnSeq, at }。count = 连续自动续跑次数;
  // doneAt = 上次续跑那一刻计划已完成的步数(下一次到访拿它判「计划有没有往前走」);turnSeq = 续跑前的回合号。
  // 只在内存,与上面 selfServe 同一立场(重启即重新数)。线程恢复正常收工时删除该条。
  continueUnfinished: new Map(),
};

function stewardStopRunner() {
  stewardRunnerRuntime.stopped = true;
  if (stewardRunnerRuntime.debounceTimer) { clearTimeout(stewardRunnerRuntime.debounceTimer); stewardRunnerRuntime.debounceTimer = null; }
  stewardRunnerRuntime.queue = [];
  const inflight = stewardRunnerRuntime.inflight;
  if (inflight) {
    inflight.cancelled = 'stopped';
    stewardAbortInflight(inflight);
  }
  return { ok: true, stopped: true };
}
function stewardResumeRunner() {
  stewardRunnerRuntime.stopped = false;
  return { ok: true, stopped: false };
}

// 停一个在途管家回合:先 stopSession(既有停止原语 —— 它拿到 activeChildren 里的 abort 句柄直接掐
// 在途 fetch,不依赖 killOnDisconnect 配置),再 abort 我们自己的 signal(双保险;runSessionTurn 的
// 断线语义走的是这条)。线程自己的回合不受影响 —— 这里停的只有管家会话。
function stewardAbortInflight(inflight) {
  try { stopSession(STEWARD_SESSION_ID, 'steward-preempt'); } catch { /* 没有在途子进程即无操作 */ }
  try { if (inflight && inflight.controller) inflight.controller.abort(); } catch { /* 无 AbortController 环境 */ }
}

// ────────────────────────────────────────────────────────────────────────────
// 管家会话(单例)。
// ────────────────────────────────────────────────────────────────────────────

// 引擎解析:stewardProviderId/stewardModel 为空则跟随主端点(§11.1 第 5 项)。
// 返回 { ok:true, route } 或 { ok:false, error:'steward.unsupported_engine', engine }。
function stewardResolveRoute(config) {
  const cfg = (config && typeof config === 'object') ? config : {};
  const explicitId = String(cfg.stewardProviderId || '').trim();
  if (explicitId) {
    const provider = (cfg.providers || []).find(p => p && p.id === explicitId);
    if (!provider) {
      return { ok: false, error: 'steward.unsupported_engine', engine: explicitId, message: `管家要用的模型服务「${explicitId}」已经不在了,请到设置 › 管家里重新挑一个` };
    }
    const route = normalizeSessionEngineRoute({ engine: 'openai', providerId: explicitId, model: String(cfg.stewardModel || '').trim() || provider.model || '' });
    return route ? { ok: true, route } : { ok: false, error: 'steward.unsupported_engine', engine: explicitId, message: `管家要用的模型服务「${explicitId}」不是 OpenAI 兼容的,请到设置 › 管家里换一个` };
  }
  // 跟随主端点。CLI 引擎(Claude / Kimi)在本切片不支持:管家回合的事件流与工具协议要另接一套,
  // 属 116-2。fail-closed 返回稳定信封,而不是悄悄换成别的端点跑起来。
  const route = sessionEngineRouteFromConfig(cfg);
  if (!route || route.engine !== 'openai') {
    const engine = route ? (route.agentCliType || 'claude') : 'none';
    return { ok: false, error: 'steward.unsupported_engine', engine, message: (engine === 'none' || !(cfg.providers || []).some(p => p && (!p.type || String(p.type).startsWith('openai')))) ? '还没接上能用的模型,管家暂时回不了话。先在向导或设置里接一个模型(本机或云端都行)' : `管家要用一个 OpenAI 兼容的模型服务才能回话,现在的主模型走的是命令行引擎(${AGENT_CLI_TYPES[normalizeAgentCliType(engine)].label})。请到设置 › 管家里给它单独挑一个` };   // 走查 #1:不出配置键名
  }
  const model = String(cfg.stewardModel || '').trim();
  return { ok: true, route: model ? { ...route, model } : route };
}

// 懒创建管家会话。不用 createSession(它生成 sess_* 随机 id;管家要的是固定 id,见 06i 的注释),
// 但字段形状与 createSession 逐条对齐,以便所有既有会话原语(load/save/rewind/压缩)照常可用。
async function ensureStewardSession(config) {
  const resolved = stewardResolveRoute(config);
  if (!resolved.ok) return resolved;
  const existing = await loadSession(STEWARD_SESSION_ID).catch(() => null);
  if (existing && existing.id === STEWARD_SESSION_ID) {
    // 引擎/模型可能在设置里被改过 —— 每次唤醒对齐一次(会话头是路由的权威源,configForSessionEngineRoute
    // 读它)。kind 一旦被外部改坏就纠回来:身份判据全靠它。
    let dirty = false;
    if (existing.kind !== 'steward') { existing.kind = 'steward'; dirty = true; }
    if (JSON.stringify(existing.engineRoute || null) !== JSON.stringify(resolved.route)) { existing.engineRoute = resolved.route; dirty = true; }
    if (dirty) await saveSession(existing).catch(() => {});
    return { ok: true, session: existing, route: resolved.route };
  }
  const now = nowIso();
  const session = {
    id: STEWARD_SESSION_ID,
    schemaVersion: SESSION_SCHEMA,
    turnSeq: 0,
    title: STEWARD_SESSION_TITLE,
    summary: '',
    pinned: false,
    // cwd = 数据根:管家没有工作目录的概念(它不动文件),但回合机器要一个存在的目录做 workingDir。
    cwd: paths.data,
    createdAt: now,
    updatedAt: now,
    claudeSessionId: null,
    messages: [],
    providerHistory: [],
    providerHistoryCursor: 0,
    attachments: [],
    engineRoute: resolved.route,
    mission: null,
    missionId: STEWARD_SESSION_ID,
    kind: 'steward',                 // 身份:所有排除面按【这个原始值】判定
    permissionMode: STEWARD_PERMISSION_MODE, // 独立模式,不进 PERMISSION_MODES
  };
  await saveSession(session);
  logEvent({ kind: 'steward_session_created', sessionId: STEWARD_SESSION_ID, providerId: resolved.route.providerId, model: resolved.route.model });
  return { ok: true, session, route: resolved.route };
}

const {
  stewardAcquireTurnSlot, stewardArbiterWait, stewardArbiterPrioritize, stewardArbiterState,
  stewardArbiterRefresh, stewardCancelQueuedTurn,
} = require('./backend/steward-thread-arbiter.cjs').createStewardArbiter({
  readConfig, safeSessionId, readInterventions, assertSessionExecutionOwner,
  ownsSessionExecution: SessionExecutionHooks.owns,
  forEachUsageRow, usageDayKey, usageDayKeyMemo, usageRangeLowerMs, recordMissionBudgetTrippedChange,
  notifyThreadState: sessionId => RUYI_EVENTS.emit('thread.state', { sessionId }),
  logEvent, serverInstanceId: OVERLAY_ID, STEWARD_SESSION_ID, stewardSanitizeText, waitReasonFor,
});

const { stewardMemoryBlock } = require('./backend/steward-prompt-memory.cjs').createStewardPromptMemory({
  policy: {
    STEWARD_MEMORY_BLOCK_CHARS, STEWARD_MEMORY_KINDS, STEWARD_MEMORY_LIMITS, STEWARD_MEMORY_VETOED_BLOCK_CHARS,
    STEWARD_MEMORY_VETOED_MAX,
  },
  dependencies: { StewardHooks, memoryIsExpired, stewardMemoryScopeLabel, stewardSanitizeText },
});

const { stewardThreadDigestRows, stewardOverviewBlock } = require('./backend/steward-thread-overview.cjs').createStewardThreadOverview({
  sessions: {
    STEWARD_SESSION_ID, activeChildren, applySessionPermissionModeOverride, getPretenderProjectionIndex,
    listSessions, overlayMissionCard, readMissionContainer, safeSessionId, sessionMeta, sessionMissionId,
  },
  projection: {
    STEWARD_DIGEST_LIMITS, StewardHooks, buildStewardDigestLine, redact, stewardArbiterWait,
    stewardForeignProjection, stewardQuickThread, stewardRawKind, stewardReadSessionHead, stewardSanitizeText,
    stewardSeatedByUser, stewardThreadDisplayTitle, stewardThreadPermissionMode, stewardThreadStateFromCard,
    stewardThreadStateFromHead, waitReasonFor,
  },
});

const { stewardPreroute, stewardPrerouteIndexRows } = require('./backend/steward-preroute.cjs').createStewardPreroute({
  dependencies: {
    getPretenderProjectionIndex, memoryIsExpired, prerouteText, readConfig, safeSessionId,
    stewardForeignProjection, stewardReadMemoryStore, stewardThreadDigestRows,
  },
});

const { stewardKnownWorkspaceRows, stewardWorkspaceTableBlock } = require('./backend/steward-workspace-overview.cjs').createStewardWorkspaceOverview({
  sessions: { listSessions, readMissionContainer, sessionDisplayTitle, sessionMetaIsSteward },
  workspaces: {
    STEWARD_KNOWN_WORKSPACE_LIMITS, STEWARD_WORKSPACE_TABLE_MAX, redact, stewardCanonWorkspacePath,
    stewardFoldWorkspacePath, stewardKnownWorkspaces, stewardSanitizeText,
  },
});

const { buildStewardSystemPrompt, stewardContextBudget, stewardVisitNotesPrompt } = require('./backend/steward-system-prompt.cjs').createStewardSystemPrompt({
  sections: {
    getPromptPack,
    getStewardRouteHint: () => stewardRunnerRuntime.inflight && stewardRunnerRuntime.inflight.routeHint,
    stewardKnownWorkspaceRows, stewardMemoryBlock, stewardOverviewBlock, stewardSanitizeText,
    stewardThreadDigestRows, stewardWorkspaceTableBlock,
  },
});

const { stewardActConfirmLines, stewardActLabel, stewardNormalizeAct, stewardParseReply } = require('./backend/steward-action-contract.cjs').createStewardActionContract({
  limits: {
    STEWARD_ACTIONS_MAX, STEWARD_ACTION_HOOKS, STEWARD_ACTS_MAX, STEWARD_ACT_CONFIRM_LABEL_MAX,
    STEWARD_ACT_CONFIRM_VALUE_CHARS, STEWARD_ACT_LABEL_MAX, STEWARD_SAY_CEILING, STEWARD_WHY_MAX,
  },
  labels: { STEWARD_DECIDE_LABELS, STEWARD_RUN_ACTION_LABELS, STEWARD_TOOL_LABELS },
  tools: {
    isStewardToolName, jsonSchemaObjectProblems, logEvent, nativeToolSchema, normalizeSchedulerTask,
    parseStructuredAgentOutput, redact, safeSessionId, stewardActConfirmSpec, stewardSanitizeText,
    stewardTrimSayAtSentence,
  },
});

const {
  stewardDowngradeActions, stewardExecuteActions, stewardSelfServeAllows, stewardTargetPermission,
} = require('./backend/steward-action-execution.cjs').createStewardActionExecution({
  safeSessionId, configValueEquals, stewardSanitizeText, stewardFail,
  actionHooks: { StewardHooks, STEWARD_ACTION_HOOKS },
  admission: {
    stewardAuthorizeExternalContext, stewardExternalOwnerDirected, stewardMayAct, stewardTurnTaintedBy,
  },
  sessions: { stewardReadSessionHead, stewardThreadPermissionMode, stewardPermissionLabel },
  proposals: { stewardActConfirmLines, stewardActConfirmSpec, stewardActLabel, stewardNormalizeAct },
  limits: { STEWARD_ACTS_MAX, STEWARD_ACT_LABEL_MAX, STEWARD_ANSWER_BASIS, STEWARD_SELF_SERVE_PER_TURN_MAX },
});

const {
  stewardCircuitCheck, stewardDayCost, stewardTurnsInWindow,
} = require('./backend/steward-turn-circuit.cjs').createStewardTurnCircuit({
  stewardRunnerRuntime, forEachUsageRow, usageDayKey, usageDayKeyMemo, usageRangeLowerMs,
  limits: { STEWARD_NO_PROGRESS_MAX, STEWARD_TURN_DAY_MS, STEWARD_TURN_WINDOW_MS },
});

const {
  stewardHumanizeSay, stewardLastAssistantContent, stewardLastAssistantFinalSegment,
  stewardNormalizeRouteHint, stewardStampReply, stewardTriggerStamp, stewardDisplayTitleOf,
} = require('./backend/steward-conversation-replies.cjs').createStewardConversationReplies({
  STEWARD_SESSION_ID, safeSessionId, stewardSanitizeText, sessionDisplayTitle, stewardHumanizeIds,
  sessions: { loadSession, mutateSession, stewardReadSessionHead },
});

const { stewardSelfServeInbox } = require('./backend/steward-autonomous-actions.cjs').createStewardAutonomousActions({
  logEvent, safeSessionId, stewardFail, stewardSanitizeText, stewardDisplayTitleOf, stewardRunnerRuntime,
  actionHooks: { StewardHooks, STEWARD_ACTION_HOOKS, stewardAppendDecision },
  sessions: {
    activeChildren, detectDanglingTurn, loadSession, readInterventions, sessionTodosSignature,
    stewardAsksYouForThread, stewardLastAssistantText, stewardReadSessionHead, stewardThreadPermissionMode,
  },
  runSnapshots: { stewardReadRunSnapshot, stewardRunResumeTier },
  admission: {
    stewardMayAct, stewardPermissionLabel, stewardSeatedByUser, stewardStoppedRefusal, stewardStoppedTarget,
    stewardTargetPermission,
  },
  budget: { stewardDayCost, stewardTurnsInWindow },
  limits: {
    SESSION_LOAD_OMIT_PROVIDER, STEWARD_CONTINUE_FRESH_MS, STEWARD_CONTINUE_NOPLAN_MAX,
    STEWARD_CONTINUE_PLAN_MAX, STEWARD_CONTINUE_PROMPT, STEWARD_SELF_SERVE_ATTEMPT_MAX,
    STEWARD_SELF_SERVE_PER_TURN_MAX, STEWARD_SELF_SERVE_RETRY_WINDOW_MS, STEWARD_TURN_WINDOW_MS,
  },
});

const { stewardInboxMessage } = require('./backend/steward-inbox-prompt.cjs').createStewardInboxPrompt({
  getPromptPack, safeSessionId, stewardDisplayTitleOf, stewardFailureExplain, stewardForeignProjection,
  stewardSanitizeBlock, stewardSanitizeText,
  limits: {
    STEWARD_EXEMPT_CATEGORY_LABELS, STEWARD_INBOX_DELIVERABLE_CHARS, STEWARD_INBOX_EVENTS_PER_TURN,
    STEWARD_INBOX_EVENT_CHARS, STEWARD_INBOX_MESSAGE_CHARS, STEWARD_SELF_SERVE_PER_TURN_MAX,
  },
});

const {
  stewardOnInboxBatch, stewardRequeueFailedInboxBatch, stewardScheduleInboxDrain,
} = require('./backend/steward-inbox-queue.cjs').createStewardInboxQueue({
  logEvent, stewardRunnerRuntime, pendingPermissions, runStewardTurn: input => runStewardTurn(input),
  presence: { stewardPendingKeyOf, stewardPendingStillOpen, stewardPresenceRows, stewardViewingSessionIds },
  limits: {
    STEWARD_BLOCKING_DEBOUNCE_MS, STEWARD_DEBOUNCE_MS, STEWARD_INBOX_EVENTS_PER_TURN,
    STEWARD_QUICK_DEBOUNCE_MS, STEWARD_VIEW_HELD_MAX, STEWARD_VIEW_RECHECK_MS,
  },
});

const {
  runStewardTurn, stewardMergeDelegationReceipts,
} = require('./backend/steward-turn-runner.cjs').createStewardTurnRunner({
  RUYI_EVENTS, StewardHooks, logEvent, nowIso, safeSessionId, readConfig, stewardRunnerRuntime, stewardFail,
  stewardSanitizeText,
  sessions: { ensureStewardSession, loadSession, runSessionTurn, stewardReadSessionHead },
  admission: {
    pendingPermissions, promptDeadlineIsReal, stewardAbortInflight, stewardAuthorizeExternalContext,
    stewardCircuitCheck, stewardMediatesPermissions,
  },
  actions: {
    STEWARD_ACTION_HOOKS, STEWARD_TOOL_LABELS, stewardDecideAttempted, stewardDowngradeActions,
    stewardExecuteActions, stewardSelfServeInbox,
  },
  replies: {
    stewardHumanizeSay, stewardLastAssistantContent, stewardLastAssistantFinalSegment, stewardStampReply,
    stewardTriggerStamp,
  },
  prompts: { stewardInboxMessage, stewardNormalizeRouteHint, stewardParseReply },
  queue: { stewardRequeueFailedInboxBatch, stewardScheduleInboxDrain },
  limits: { STEWARD_ACTS_MAX, STEWARD_INBOX_EVENTS_PER_TURN, STEWARD_SESSION_ID, STEWARD_USER_QUEUE_WAIT_MS },
});

const {
  stewardResetConversation, stewardVisit, stewardVisitDigest,
} = require('./backend/steward-conversation-visits.cjs').createStewardConversationVisits({
  logEvent, makeId, nowIso, readConfig, safeSessionId, stewardDir, stewardFail, stewardRunnerRuntime,
  SchedulerHooks,
  sessions: {
    loadSession, mutateSession, readSessionNotes, writeSessionNotes, stopSession, waitMissionTurnSettled,
  },
  inbox: { getPretenderProjectionIndex, stewardInboxRead, stewardPendingOneLine, stewardThreadDigestRows },
  lifecycle: { clearStewardReadBudget, stewardAbortInflight, stewardScheduleInboxDrain },
  persistence: { atomicWriteJson },
  constants: {
    STEWARD_DIGEST_KIND_TEXT, STEWARD_DIGEST_LIMITS, STEWARD_EVENT_KINDS, STEWARD_PENDING_LIST_MAX,
    STEWARD_PREEMPT_WAIT_MS, STEWARD_SESSION_ID, STEWARD_VISITS_DIR, STEWARD_VISITS_KEEP,
    STEWARD_VISIT_DIGEST_MAX, STEWARD_VISIT_SCHEMA,
  },
});

const {
  stewardApplyThreadTier, stewardEnsureOpenAiRoute, stewardRelayChannelFor, stewardRelayDeliver,
} = require('./backend/steward-thread-relay.cjs').createStewardThreadRelay({
  logEvent, safeSessionId, stewardErrorDetail, stewardFail, stewardSanitizeText,
  sessions: {
    normalizeSessionEngineRoute, steerSessionCore, stewardOpenAiFallback, stewardThreadEngineRoute,
  },
  active: { activeChildren, stewardLaunchPending, turnSettlers },
  pending: { decideIntervention, normalizeQuestionAnswer, pendingPermissions, pendingQuestions },
  wait: { stewardArbiterWait, waitReasonFor },
});

const { stewardRunAct } = require('./backend/steward-act-receipts.cjs').createStewardActReceipts({
  OVERLAY_ID, STEWARD_ACTION_HOOKS, StewardHooks, ensureStewardSession, logEvent, safeSessionId, stewardFail,
  stewardSanitizeText,

});

// ============================================================================
// 第 117 波 T2(32 号文 §5「13h-steward-runner.js 2522 行」):管家回合运行器族的注册表、
// 三条路由与两个「够不着才落在这里」的工具实现。
//
// 落点(transport 层,manifest 中位于 13q-steward-runner-turn.js 之后、14-main.js 之前)。
// T2 拆分:本文件曾 2522 行(比 T1 拆之前的 13g 还长,而 31 号文七轴的回合层改动全要往它
// 里面加)。按「谁被谁引用」拆成六个文件,拼接顺序即依赖方向,零新增前向边:
//   · 13m-steward-runner-base.js —— 六个文件都要用的共享面:落盘面常量、回合层数值口径、
//     自理动作与到访摘要的文本表、可由 actions 执行的写工具白名单、运行时内存态
//     stewardRunnerRuntime、停机/唤醒/中止,以及管家会话单例(引擎解析 + 懒创建);
//   · 13n-steward-arbiter.js —— 116h 线程间仲裁(并发位 / 同 cwd 写锁 / 预算 / 可解释的排队 / 饥饿提升)。
//     它排在提示词之前,因为总览行与递话通道都要读它的等待原因(stewardArbiterWait);
//   · 13o-steward-runner-prompt.js —— 提示词装配(记忆块 / 线程摘要 / 递话预判 / 总览 /
//     两个分叉入口)与 {say,acts,actions,why} 输出契约解析;
//   · 13p-steward-runner-actions.js —— actions 执行与降级、116-2b 确定性自理动作、id 人话化、
//     熔断、收件箱消息装配、输入区预判归一;
//   · 13q-steward-runner-turn.js —— 回合入口 runStewardTurn、收件箱去抖驱动、到访与归档、
//     117l D2 递话通道、117l D7 线程分档落盘、acts 落定;
//   · 13h-steward-runner.js —— 两个「够不着才落在这里」的工具实现(thread_prioritize /
//     thread_stop)、三条路由、运行器状态与 StewardHooks 注册表(排在最后:注册表要引用
//     上面五个文件里的实现,排在后面才是后向边)。
// 本次拆分是【纯搬家】:所有函数体逐字节不变,新写的只有各文件的头部注释。
//
// 下面这段 116f 的横幅逐字节原样保留。它描述的是【整个 13h 族】合起来做的那件事 ——
// 里面的「本文件」如今指的是 13m/13n/13o/13p/13q/13h 这六个文件,不再只是一个文件;
// 开关红线、零入边、steward_reply 投放口径三条铁律一字未改,对整族同样成立。
// ============================================================================
// ============================================================================
// 第 116 波 116f(27 号文 §11.3「116f 回合运行器与到访」):管家回合运行器、输出契约、熔断与到访。
//
// 定位(transport 层,manifest 中位于 13g-steward.js 之后、14-main.js 之前):
//   13g 是「箱子与工具」,本文件是「回合与到访」—— 它把用户消息或收件箱事件组装成一个回合,交给既有
//   回合机器(runSessionTurn)去跑,再把模型的结构化输出解析成 {say, acts, actions, why},按【目标线程】
//   的权限执行 actions 或把它降级成一个提议按钮,最后落决策日志并把结构化结果返回给调用方。
//
// steward_reply 的投放口径(有意与回合流事件分开):它【不是】回合流事件,而是管家通道这一次请求的
//   响应载荷 —— 回合早已收尾、模型也早已说完,它是工作台【事后】按契约解析并执行完 actions 之后
//   拼出来的东西。所以运行器只把它放进返回值与 stewardRunnerRuntime.lastReply(/api/steward/state 可读),
//   由 /api/steward/message 的 SSE 壳作为流的最后一帧写出;回合过程中的既有事件(session/
//   assistant_delta/tool_use/result …)照旧原样透传给调用方的 onEvent。这样经典壳与 Preview 壳的
//   回合事件契约(112b progress-events 的双向登记表)一条都不用动 —— 那两个壳根本不接管家通道。
//
// 依赖纪律(§11.3「不得新增前向边」):
//   · 13h 只引用拼接顺序在它之前的模块符号(00/01/02/04/06b/06i/08/09/10/13e/13g …),全部后向边;
//   · 没有任何模块引用 13h 的符号 —— 09(提示词分叉)、10(预算分叉)、13g(轮询器出口/state/路由转交)
//     一律经 06i 的 StewardHooks 延迟绑定拿实现,故 13h 零入边、不进任何强连通分量;
//   · 反过来 13h 直接调 13g 的内部函数(stewardDir/stewardFail/stewardAppendDecision …)是后向边,合法。
//     13g 想复用本文件的东西则【不可以】—— 那是前向边,故总览行的装配在本文件里另写一份(用的仍是
//     06i/13g 的同一批原语与同一批事实源,不新造第二个事实源)。
//
// 开关(§3.4 红线):`stewardEnabledV1 !== true` 时本文件【零副作用】—— 不建管家会话、不起任何 timer、
// 不写任何文件;三条路由仍在(路由清册不因开关变化),一律返回 409 `steward.disabled`。
//
// 管家会话(§3.1「管家自身是 kind:'steward' 的特殊会话」):
//   固定 id `steward`(06i 的 STEWARD_SESSION_ID)、标题「如意管家」、cwd = 数据根;开关开且首次被唤醒时
//   懒创建。排除面(会话列表 / 113b 内容搜索 / 13e 投影 / 116b 收件箱)一律按会话头【原始】 kind 判定,
//   不经 sessionKind()(它会把 steward 归一成 quick_ask,拿它当身份判据等于把门拆了)。
//
// 本切片只支持 OpenAI 兼容 provider:解析到 Claude / Kimi CLI 引擎时返回稳定信封
// `steward.unsupported_engine`(116-2 候选:CLI 引擎的管家回合要另接 runClaudeTurn 的事件流与工具协议)。
// ============================================================================
// ── steward_thread_prioritize(116h,§8.10「每行可提升优先级＝插队占下一个并发位」)──────────────
// 落在 13h 而不是 13g:实现要直接调本文件的仲裁器原语,而 13g 在拼接顺序上更早(引用本文件 = 前向边);
// 13g 也已顶到 SPEC §2 的 2000 行目标,再往里塞就要为它另起一次拆分。门控壳仍用 13g 的
// stewardToolHandler(13h -> 13g 是后向边),开关/身份两道 fail-closed 与其余 20 个工具逐字一致。
//
// 语义刻意做窄:只把【还在排队】的那一条提到队首,下一个释放出来的并发位归它。不预留、不抢占 ——
// 已经在跑的回合不会因为别人插队被打断(那会把一条线程做到一半的活扔掉,代价远大于早跑几秒的收益)。
// 目标不在队列里(在跑 / 已收工 / 根本没开回合)不是错误:返回 prioritized:false + reason,
// 让模型如实告诉用户「它没在排队,不用插」,而不是重试或编一个成功。
async function stewardImplThreadPrioritize(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session is not a thread');
  const result = stewardArbiterPrioritize(sessionId);
  if (!result || result.ok !== true) {
    return stewardFail(String((result && result.error) || 'steward.failed'), String((result && result.message) || 'prioritize failed'), { sessionId });
  }
  if (result.prioritized !== true) {
    return { ok: true, sessionId, prioritized: false, reason: String(result.reason || 'not_queued'), wait: null };
  }
  stewardAppendDecision({
    tool: 'steward_thread_prioritize',
    args: { sessionId },
    targetSessionId: sessionId,
    permissionMode: stewardThreadPermissionMode(head, config),
    mayAct: 'auto',
    undoRef: { kind: 'prioritize', sessionId },
    basis: {},
  });
  return { ok: true, sessionId, prioritized: true, wait: waitReasonFor({ pending: 0 }, stewardArbiterWait(sessionId)) };
}

// ── steward_thread_stop(117m-A4,27 号文 §11.10 用户第六轮走查第 ③ 条「暂停这个线程,会显示 invalid」)──
// 根因:管家手里【只有】班组级的 steward_run_action(13g 的 stewardImplRunAction 头一行就要 sessionId
// 与 runId)。普通线程回合根本没有班组,模型想「暂停这条线程」只能拿它凑 -> 必然 invalid_request ->
// 前端 errGeneric 把机器码原样贴出来,就是用户看到的那个「invalid」。抽屉底部那枚「停止」按钮走的是
// POST /api/stop,管家一直没有对应的原语。这里补的就是那条路,不是第二条停机路径:
//   ① stopSession(既有停止原语:拿 activeChildren 里的 abort 句柄直接掐,并清掉该会话的三张待决表);
//   ② stewardCancelQueuedTurn(116h 仲裁器:stopSession 只认活回合,【还在排队】的回合它看不见);
//   ③ revokeAllGrants(第 27 波:显式停止 = 夺回控制,该会话的授权书连 scope:'session' 一并撤)。
// 三件都是既有核心,本函数一行停机逻辑都不自己写。
//
// 落在 13h 而不是 13g:与 stewardImplThreadPrioritize 同一条理由 —— 它要直接调本文件的仲裁器原语,
// 而 13g 已经顶到 SPEC §2 的 2000 行目标。门控壳仍用 13g 的 stewardToolHandler(13h -> 13g 是后向边),
// 开关/身份两道 fail-closed 与其余工具逐字一致。
//
// 权限:停止是【收紧类】—— 与 STEWARD_RUN_TIGHTENING 同款,任何权限档都 mayAct='auto'(连「每步都问」
// 的线程也允许管家替你按停,因为它只会让事情【少】发生)。只放开了收紧:同一条线程的 thread_continue /
// decide / run_action{resume} 仍各自过自己的权限门,一条都没松。
//
// 没在跑时不许回 invalid:那不是「请求非法」,是「不用停」。信封 not_running + 一句人话,模型照直说给
// 用户听就行(schema 的 description 里写明了拿到它不要重试)。也不许有副作用 —— 所以先看 activeChildren
// 再决定要不要调 stopSession:stopSession 即使拿不到条目也会清一遍三张待决表,那是【停一个真在跑的
// 回合】的收尾语义,不该发生在一个 not_running 的信封上;revokeAllGrants 同理,只在真停下了什么之后才撤。
const STEWARD_STOP_REASON_MAX = 200;
async function stewardImplThreadStop(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('invalid_request', 'sessionId is required');
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session cannot stop its own turn');
  const reason = stewardSanitizeText(args.reason).trim().slice(0, STEWARD_STOP_REASON_MAX);

  const receipt = requestSessionExecutionStop(sessionId, args.expectedExecution, 'steward-stop');
  if (!receipt.ok) return stewardFail(receipt.error, receipt.error + ': read thread_status before stopping', { sessionId });
  const { stopped, queuedStopped, alreadyRequested } = receipt;
  if (!stopped && !queuedStopped) return stewardFail('not_running', '这条线程现在没有在跑,不用停', { sessionId });

  // 停下的回合【不能】原样续上(它的半截输出已经落进会话正文;要撤销那一整回合是 rewind,另一件事)。
  // undoRef 诚实标 none,并把用户真正该走的那条路写进 note。
  const undoRef = { kind: 'none', note: '停下的回合不能原样续上;要继续用「接着办」' };
  if (!alreadyRequested) stewardAppendDecision({
    tool: 'steward_thread_stop',
    args: { stopped, queuedStopped, ...(reason ? { reason } : {}) },
    targetSessionId: sessionId,
    permissionMode: stewardThreadPermissionMode(head, config),
    mayAct: 'auto',
    undoRef,
    basis: stewardBasisOf(args, {}),
  });
  return { ok: true, sessionId, stopped, queuedStopped, undoRef };
}

// ── 用户手按的停止也进决策日志(121-K5;33 号文 §0 末段记的那条不对称,34 号文 §4.4 末条)────────
// 事实:全仓只有一个停止原语(04 的 stopSession),两条路都落到它 —— 管家按的走上面那个
// steward_thread_stop(写一行决策日志),用户按的走 POST /api/stop(什么都不写)。于是「行动流水」
// 上看得见模型停了哪条线程,看不见人停了哪条;116-3 P1-13 当初以「全部行动经命令核心与审计」为由
// 把「提升优先级」改走工具实现时,「停止」没照做。这里还的就是这一笔。
//
// 为什么住 13h:13-http-router.js 拼在 13h 【之前】,直接调 13j 的 stewardAppendDecision 是前向边
// (32 号文 §4 纪律 1 的例 3 同一个模具)。所以走 StewardHooks 迟绑定 —— 与它旁边那个
// cancelQueuedTurn 逐字同一个挂法:路由那一侧只认 typeof StewardHooks.x === 'function'。
//
// 行形状对齐上面那一条(tool/args/targetSessionId/permissionMode/mayAct/undoRef/basis):
//   · tool = 'user_stop' —— 它不是一个管家工具,所以不叫 steward_*;读流水的人一眼分得出是谁按的;
//   · mayAct = 'user' —— 真值表里没有这一档,因为【压根没有过权限判定】:人手按的停止不需要管家
//     有没有资格,记的是「这一下是人做的」;
//   · basis.origin = 'ui_stop' —— 与 revokeAllGrants(sid,'ui-stop') 同源的那句话,来路一眼可查;
//   · undoRef 与 steward_thread_stop 那一条逐字相同(停下的回合不能原样续上,这一点与谁按的无关)。
// 开关关时【不写】:决策日志住 stewardDir(),27 号文 §3.4 的红线是「开关关时零持久化写入」。
// 记账失败绝不影响停止本身(stewardAppendDecision 自己就是 fire-and-forget)。
async function stewardAppendUserStop(sessionId, facts) {
  const sid = safeSessionId(sessionId);
  if (!sid) return false;
  const config = await readConfig().catch(() => null);
  if (!config || config.stewardEnabledV1 !== true) return false;
  const head = await stewardReadSessionHead(sid).catch(() => null);
  if (!head || !head.id) return false;
  if (stewardRawKind(head) === 'steward') return false;   // 管家自己那条会话不进线程流水
  const f = (facts && typeof facts === 'object') ? facts : {};
  stewardAppendDecision({
    tool: 'user_stop',
    args: { stopped: f.stopped === true, queuedStopped: f.queuedStopped === true },
    targetSessionId: sid,
    permissionMode: stewardThreadPermissionMode(head, config),
    mayAct: 'user',
    undoRef: { kind: 'none', note: '停下的回合不能原样续上;要继续用「接着办」' },
    basis: { origin: 'ui_stop' },
  });
  return true;
}

const { handleStewardApiRoutes, handleStewardRunnerApiRoutes } =
  require('./backend/steward-routes.cjs').createStewardRoutes({
    tokenOk: req => tokenOk(req), readConfig, safeSessionId, nowIso, StewardHooks, PrivacyGateway,
    STEWARD_SESSION_ID, STEWARD_PREROUTE_QUERY_MAX,
    inbox: { startStewardInbox, stopStewardInbox, stewardInboxRead, stewardInboxState: config => stewardInboxState(config) },
    memory: { stewardMemoryPanelList, stewardMemoryPanelExport, stewardMemoryPanelEdit, stewardImplMemoryVeto,
      stewardMemoryPanelRestore, stewardMemoryPanelClear, stewardDecisionsRead },
    runner: { stewardArbiterState, stewardImplThreadPrioritize, stewardResetConversation, stewardVisit, stewardRunAct,
      ensureStewardSession, stewardSanitizeAttachments, runStewardTurn: opts => runStewardTurn(opts) },
    delivery: { stewardDeliveryProjection, stewardDeliveryInspect, loadSession, readFilePreview },
  });

// GET /api/steward/state 的运行器半边(13g 把它并进收件箱状态里一起下发)。
async function stewardRunnerState(config) {
  const now = Date.now();
  return {
    visit: { startedAt: stewardRunnerRuntime.visit.startedAt, lastActivityAt: stewardRunnerRuntime.visit.lastActivityAt },
    turns: { hour: stewardTurnsInWindow(now, STEWARD_TURN_WINDOW_MS), day: stewardTurnsInWindow(now, STEWARD_TURN_DAY_MS) },
    cost: { day: await stewardDayCost(config).catch(() => 0) },
    circuit: stewardRunnerRuntime.circuit,
    lastReply: stewardRunnerRuntime.lastReply,
    stopped: stewardRunnerRuntime.stopped,
    inflight: stewardRunnerRuntime.inflight ? stewardRunnerRuntime.inflight.kind : '',
    queued: stewardRunnerRuntime.queue.length,
    noProgress: stewardRunnerRuntime.noProgress,
    // 116h:线程仲裁器的快照并进同一条状态路由 —— 看板顶部的「同时最多 N 条」与每行的等待原因
    // 读的是同一份事实,不必再多请求一次(独立的 GET /api/steward/arbiter 仍在,供只关心仲裁的调用方)。
    arbiter: await stewardArbiterState(config).catch(() => null),
  };
}

// 延迟绑定(与 13g 同一手法):06i 声明空命名空间,本文件在加载时填充 116f 的实现键。
// 消费者 09(提示词分叉)、10(预算分叉与摘要 prompt)、13g(轮询器出口/state/路由转交)全程只看
// StewardHooks.*,从不直接引用 13h —— 13h 因此零入边,不进任何强连通分量。
Object.assign(StewardHooks, {
  buildSystemPrompt: buildStewardSystemPrompt,
  contextBudget: stewardContextBudget,
  visitNotesPrompt: stewardVisitNotesPrompt,
  onInboxBatch: stewardOnInboxBatch,
  runnerState: stewardRunnerState,
  handleApiRoutes: handleStewardApiRoutes,
  stopRunner: stewardStopRunner,
  resumeRunner: stewardResumeRunner,
  // 116-pre(§11.3):117 壳层与其它旁路消费者经这个键调,不必知道 13h 的存在。
  preroute: stewardPreroute,
  // 116h(§3.1/§8.10)线程间仲裁。消费者:10 的回合入口(acquireTurnSlot)、13 的 /api/stop
  // (cancelQueuedTurn)、13d 的事项聚合行与 13g 的 thread_status(arbiterWait)、13 的 POST /api/config
  // (arbiterRefresh)。一律经 06i,零前向边。
  // stewardArbiterPrioritize 与 stewardArbiterState 【不】进命名空间:它们的消费者全在本文件内
  // (两条 /api/steward/arbiter* 路由、steward_thread_prioritize 实现、并进 state 的 stewardRunnerState),
  // 挂上去就是没人用的钩子(= 死代码)。
  acquireTurnSlot: stewardAcquireTurnSlot,
  arbiterWait: stewardArbiterWait,
  cancelQueuedTurn: stewardCancelQueuedTurn,
  // 121-K5:用户在界面上手按的停止也记一行决策日志(33 号文 §0 的不对称)。挂法与上一行同款,
  // 消费者只有 13 的 POST /api/stop —— 它拼在 13h 之前,经 06i 的命名空间调,零新增前向边。
  appendUserStop: stewardAppendUserStop,
  arbiterRefresh: stewardArbiterRefresh,
  // 116h 的第 21 个管家工具:实现住本文件(要直接调仲裁器原语),门控壳仍是 13g 的 stewardToolHandler。
  threadPrioritize: stewardToolHandler('steward_thread_prioritize', stewardImplThreadPrioritize),
  // 117m-A4 的第 27 个管家工具:线程级停止。住本文件的理由与 threadPrioritize 同款(要直接调仲裁器
  // 原语,且 13g 已顶到 2000 行闸);门控壳仍是 13g 的 stewardToolHandler。
  threadStop: stewardToolHandler('steward_thread_stop', stewardImplThreadStop),
  // 117l D2(§11.9):递话通道的判定与执行。实现住本文件的理由与 threadPrioritize 同款 ——
  // 它要同时够到 04 的三张待决内存表、13b 的 steerSessionCore、13d 的 decideIntervention 与
  // 09 的 activeChildren,而 13g 在 13b/13d 之后、13h 之前,由 13h 来当这个汇合点边最少。
  // 消费者:13g 的 steward_thread_continue(经 StewardHooks,零前向边)与本文件的 /api/steward/relay。
  // 117s-G(27 号文 §11.13.1 ②):stewardRelayChannelFor 现在【也】上命名空间 —— 它有了第一个
  // 13h 之外的消费者:13d 的 GET /api/sessions/:id 要把「这条线程此刻该走哪条通道」下发给经典壳
  // (前端此前只认 activeTurns = 本页自己起的流,别处起的回合一律判成空闲,一发消息就把它顶掉)。
  // 判定仍然只有这一份:13d 不重编第二条阶梯,只把结果投影成 relay:{channel,wait}。挂法与 arbiterWait
  // 同款(13d -> 06i 是后向边,零新增前向边)。上一版那条「消费者全在 13h 内部,挂上去就是死代码」的
  // 理由随第一个外部消费者出现而失效 —— 纪律没变,变的是事实。
  relayChannel: stewardRelayChannelFor,
  relayDeliver: stewardRelayDeliver,
  // 129g:此刻【正在跑的那个管家回合】是谁触发的('user' | 'inbox' | '')。
  // 为什么要有这一口:管家工具有两条调用面 —— ① 模型在回合的工具循环里直接调(09-workflow 造的
  // ctx 是 {sessionId,turnSeq,session,config,workingDir,signal},**没有 trigger**);② 13p 的自理层
  // 与 /api/steward/act 显式带 trigger。于是 stewardTriggerOf(ctx) 在【第一条面上恒为空串】,
  // 而 stewardUnattendedByModel 恒为 false —— 无人值守回合里模型直接调 steward_thread_continue,
  // 自理清单闸与目标线程权限闸**一道都不过**,拿到的是「用户就在跟前」的直递待遇。
  // (既有 e2e 全部手工往 ctx 里塞 trigger,所以这个缺口一直没被照到。)
  // 补法放在 13g 的 stewardToolHandler 一处(42 个工具的唯一咽喉),它经本口取真值;
  // inflight 在回合本体开跑【前】同步认领、收尾时清空,所以工具循环期间它就是当前回合的那一个。
  currentTurnTrigger: () => (stewardRunnerRuntime.inflight ? String(stewardRunnerRuntime.inflight.kind || '') : ''),
  currentTurnContext: () => {
    const entry = stewardRunnerRuntime.inflight;
    return entry ? { trigger: String(entry.kind || ''), ...(entry.kind === 'external' ? { externalActor: entry.externalActor } : {}) } : null;
  },
  // 117l D7:同理住 13h —— 它要 02 的 normalizeSessionEngineRoute 与 04 的 logEvent,06i 够不着那两个。
  applyThreadTier: stewardApplyThreadTier,
});

// 133e:/api/steward/message 带来的附件记录 —— 与 04 makeAttachmentRecord 同形(id/name/path/size/kind),只收这几个字段、≤12 条。
function stewardSanitizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw.slice(0, 12)) {
    if (!a || typeof a !== 'object') continue;
    const id = String(a.id || '').slice(0, 80), name = String(a.name || '').slice(0, 260);
    if (!id || !name) continue;
    const rec = { id, name, path: String(a.path || '').slice(0, 1200), size: Math.max(0, Number(a.size) || 0) };
    if (a.kind === 'audio') rec.kind = 'audio';
    if (typeof a.textPreview === 'string') rec.textPreview = a.textPreview.slice(0, 4000);
    out.push(rec);
  }
  return out;
}

SessionExecutionHooks.cancelQueuedTurn = stewardCancelQueuedTurn;
SessionExecutionHooks.revokeGrants = sessionId => revokeAllGrants(sessionId, 'explicit-stop');

// SSE transport owns subscriptions, clients and heartbeat lifetime.
const EventStreamService = require('./backend/event-stream.cjs').createEventStream({
  apiFailure,
  EventStreamHooks,
  nowIso,
  OVERLAY_ID,
  RUYI_EVENTS,
  URL,
  safeSessionId,
  send,
  readMissionSessionHead,
  sessionDisplayTitle,
  sessionMissionId,
  activeChildren,
  subscribeActiveChildEvents,
  STEWARD_SESSION_ID,
  stewardThreadStateFromHead,
  stewardWatchedThread,
  threadOriginOf,
  missionPendingCounts
});
const { eventStreamEmitThreadState, eventStreamRing } = EventStreamService;

const SchedulerRuntime = require('./backend/scheduler-runtime.cjs').createSchedulerRuntime({
  paths, RUYI_EVENTS, readConfig, logEvent, makeId, nowIso,
  domain: { PERMISSION_MODES, STEWARD_SESSION_ID, stewardPermissionRank, missedOccurrence, nextFireAt, normalizeSchedulerTask, occurrenceKey, SCHEDULER_LIMITS, SCHEDULER_OUTCOMES, SCHEDULER_PHASES, SchedulerHooks },
  sessions: { createSession, loadSession, saveSession, updateSessionMeta },
  storage: { atomicWriteJson, repairMissionChangeTornTail },
  execution: { stopSession, StewardHooks, schedulerAskWaitSessions, runSessionTurn },
});
const { schedulerPermissionModeFor, startScheduler, stopScheduler, schedulerRuntimeSnapshot } = SchedulerRuntime;

const { handleSchedulerApiRoutes } = require('./backend/scheduler-routes.cjs').createSchedulerRoutes({
  scheduler: SchedulerRuntime, describeSchedule, normalizeSchedulerTask, SCHEDULER_LIMITS, readConfig, safeDecodeURIComponent, makeId,
});

const { stewardImplScheduleCreate, stewardImplScheduleList, stewardImplSchedulePause, stewardImplScheduleResume, stewardImplScheduleRunNow, stewardImplScheduleDelete, schedulerOnReminderDue, schedulerOnSchedulerNotice, schedulerCommitmentsSince, schedulerPrepareThread } = require('./backend/scheduler-steward.cjs').createSchedulerSteward({
  scheduler: SchedulerRuntime, makeId, nowIso, readConfig, safeSessionId,
  domain: { STEWARD_SESSION_ID, describeSchedule, nextFireAt, normalizeSchedulerTask, SCHEDULER_LIMITS },
  inbox: { stewardAppendInboxRows, stewardClipSummary, stewardIsoAt, stewardAppendDecision },
  workspaces: { stewardCanonWorkspacePath, stewardDeriveThreadCwd, stewardValidateCwd, stewardEnsureOpenAiRoute },
  policy: { stewardSanitizeText, stewardFail, stewardRawKind, stewardReadSessionHead, stewardUnattendedByModel, StewardHooks },
});

// ── 延迟绑定注册(先例:13g / 13h 各自往 StewardHooks 上填自己那一份)────────────────────────
// 六个工具沿 13g 的 stewardToolHandler 门控壳(开关 -> 身份 -> 实现 -> 异常兜底);12-tool-dispatch
// 的 handler 仍然只写一行 `StewardHooks.<键>(args, ctx)`,与既有 27 个逐字同型。
Object.assign(StewardHooks, {
  scheduleCreate: stewardToolHandler('steward_schedule_create', stewardImplScheduleCreate),
  scheduleList: stewardToolHandler('steward_schedule_list', stewardImplScheduleList),
  schedulePause: stewardToolHandler('steward_schedule_pause', stewardImplSchedulePause),
  scheduleResume: stewardToolHandler('steward_schedule_resume', stewardImplScheduleResume),
  scheduleRunNow: stewardToolHandler('steward_schedule_run_now', stewardImplScheduleRunNow),
  scheduleDelete: stewardToolHandler('steward_schedule_delete', stewardImplScheduleDelete),
});
// 06j 的两个旁路口(M1 只调用、不实现)在这里落地;第三个键是 13q 的承诺三项读口;
// 第四个键是 127 波 2-ter 的开线程前置(档位 + 任务自己的工作文件夹),消费者是 13s 的触发分支。
Object.assign(SchedulerHooks, {
  onReminderDue: schedulerOnReminderDue,
  onSchedulerNotice: schedulerOnSchedulerNotice,
  commitmentsSince: schedulerCommitmentsSince,
  prepareThread: schedulerPrepareThread,
});

// 81: This administration surface requires the workbench token, including loopback clients.
PrivacyGateway.setHost({ paths, isRegisteredTool: name => Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name) || Boolean(nativeToolSchema(name)), normalizeToolInvokeArgs: args => normalizeToolInvokeArgs(args), makeStore: (file, key) => DurableJsonStore.create({
  id: 'privacy-mapping-' + key, file, schemaKey: 'version', schemaVersion: 1, cache: false, strictRead: true, quarantine: false,
  defaultValue: () => ({}), validate: value => value.version === 1 && typeof value.instanceId === 'string' && !!value.envelope,
}) });
PrivacyCore.configHooks.isBusy = () => activeChildren.size > 0 || turnSettlers.size > 0;
const PrivacySettings = require('./backend/privacy-settings-service.cjs').createPrivacySettings({
  configHooks: PrivacyCore.configHooks, PrivacyGateway, PrivacyRegex, LocalSecretCrypto,
  turnSettlers, readConfig, mutateConfig, sessionEngineRouteFromConfig, stewardAppendDecision,
});
Object.assign(PrivacyCore.configHooks, {
  stewardPrivacy: PrivacySettings.administer,
  settleStewardPrivacy: PrivacySettings.settle,
  handleApiRoutes: require('./backend/privacy-routes.cjs').createPrivacyRoutes({
    configHooks: PrivacyCore.configHooks, PrivacySettings, PrivacyGateway, PrivacyRegex, PrivacyRuleCatalog, LocalSecretCrypto,
    readConfig,
  }),
});

const ExternalBotCredentials = require('./backend/external-bot-credentials.cjs').createExternalBotCredentials({ DurableJsonStore, LocalSecretCrypto, fsp, paths, process });
const ExternalBotLedger = require('./backend/external-bot-ledger.cjs').createExternalBotLedger({ paths, DurableJsonStore });
const ExternalBotInbox = require('./backend/external-bot-inbox.cjs').createExternalBotInbox({
  ledger: ExternalBotLedger, ExternalBotCredentials, LocalSecretCrypto,
  runStewardTurn, OVERLAY_ID, nowIso, makeId,
});
Object.assign(ExternalBotHooks, ExternalBotInbox.lifecycle, {
  handleApiRoutes: require('./backend/external-bot-routes.cjs').createExternalBotRoutes({
    inbox: ExternalBotInbox, tokenOk, originOk,
  }),
});

// Root execution authority. MCP children never open this ledger; they need the root service.
const DesktopExecutionRuntime = require('./backend/desktop-execution-runtime.cjs').createDesktopExecutionRuntime({
  host: { ServerOwnership, activeAgentRuns, paths, process, turnSettlers },
  ledger: { DesktopExecutionLedger },
  connector: { McpStdioClient, isEquivalentDesktopAccServer, mcpClients, probeDesktopExecutionReceipts },
  sessions: { loadSession, saveSession, sessionObjectIsStale, sessionRewindGenHighWater, sessionSaveIsTombstoned },
});

Object.assign(DesktopExecutionHooks, DesktopExecutionRuntime);
ProviderHttpHooks.beforeModelRequest = DesktopExecutionRuntime.beforeModelRequest;

const handleApi = require('./backend/workbench-api-router.cjs').createWorkbenchApiRouter({
  authorizeRoute, privacyRoutes: PrivacyCore.configHooks, ExternalBotHooks, StewardHooks, EventStreamHooks,
  handleStatusApiRoutes, handlePlaybookApiRoutes, handleWorkspaceApiRoutes, handleModelsApiRoute,
  handleConfigurationApiRoutes, handleProviderTestApiRoute, handleSessionApiRoutes, handleMissionsApiRoutes,
  handleSkillApiRoutes, handleMemoryApiRoutes, handleSessionExecutionApiRoutes, handleInterventionApiRoutes,
  handleMissionLedgerApiRoutes, handleAutonomyGrantApiRoutes, handleAgentWorkflowApiRoutes,
  handleUsageApiRoutes, handleAgentRunApiRoutes, handleCheckpointQueryApiRoutes, handleLocalSupportApiRoutes,
  handleMcpApiRoutes, handleDiagnosticsApiRoutes, handleCheckpointApiRoutes, handleSteerApiRoute, handleAudioApiRoutes,
  handleSchedulerApiRoutes, handleAttachmentApiRoutes, handleChatApiRoute, handleToolApiRoutes,
});

const { startMcp, installIntegration } = require('./backend/integration-commands.cjs').createIntegrationCommands({
  paths, RUNTIME, process, APP_NAME, VERSION, ensureDirs, readConfig, generateMcpConfig,
  existsExecutable, DesktopShell, syncClaudeCliSettings, syncAgentRolesToClaude, syncMcpServersToClaude,
  mcpServices: { PrivacyGateway, ProcessRuntime, observationRecallEnabled, policyDesktopOverrideFor,
    runtimeToolRequirementsMet, nativeToolDisabledByPolicy, isStewardToolName, toolPackForName, toolCall,
    VisualPipeline, truncateToolResult, maskProviders, samePathKey, killAllMcpClients, safeJsonParse, MCP_TOOLS },
});

const { createOwnedServerStartup, createServerStartup } = require('./backend/server-startup.cjs');
const { startServerInner, resolveBindHost, stopAllActiveTurnsSync } = createServerStartup({
  paths, RUNTIME, process, identity: { APP_NAME, VERSION, OVERLAY_ID, DEFAULT_PORT, externalServerJs },
  notices: ServerStartNotices,
  network: { isLoopbackBindHost, recordRequestMetric, hostAllowed, handleApi, serveStatic },
  storage: { ensureDirs, mutateSession, safeJsonParse, invalidateSessionIndex, flushSessionIndexSync,
    flushUsageLedgerSync, atomicWriteJson, storageSweep, sweepStaleScriptFiles },
  recovery: { markInterruptedAgentRuns, markInterruptedInterventions, scheduleAgentWakesAtBoot,
    warmPretenderProjectionIndex, autoResumeInterruptedRuns, migrateLegacyAccMemory },
  config: { readConfig, syncClaudeCliSettings, syncAgentRolesToClaude, autoImportClaudeCodeMcp,
    recordInstallLaunch, syncAgentInstructionImports, syncMcpServersToClaude,
    syncAgentCliMcpManifests, getCapabilities, generateMcpConfig },
  probes: { beginBootCliPathProbes, waitForBootCliPathProbes, finishBootCliPathProbes, ensureDesktopMcpWarm },
  runtime: { activeChildren, stopSession, startScheduler, stopScheduler, killAllMcpClients, killAllShellSessions,
    EventStreamHooks, ExternalBotHooks, StewardHooks, ToolboxHooks, platformOpenSpawn, spawnDetachedChecked },
  nowIso, logEvent,
});
const startServer = createOwnedServerStartup({
  paths, process, resolveBindHost, defaultDataRoots, lstatOrNull, isDirectServeInvocation, migrateLegacyDataRoot,
  ServerOwnership, DesktopExecutionHooks, finishBootCliPathProbes, startServerInner,
  startupGuidance: error => PrivacyCore.configHooks.startupGuidance?.(error),
  writeStartError: ServerStartNotices.writeStartError,
});

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const command = argv._[0] || 'serve';
  if (command === 'serve') {
    const served = await startServer(argv);
    // 第116波116b(27号文§11.3): 服务就绪(已 listen、runtime.json 已落)之后才起管家收件箱轮询。
    // stewardEnabledV1 !== true 时 startStewardInbox 立即返回,不建目录、不起 interval、零写入。
    // 失败绝不阻断已经开起来的服务(管家是旁路,不是主链路)。
    await startStewardInbox(await readConfig()).catch(() => {});
    return served;
  }
  if (command === 'mcp') return startMcp();
  if (command === 'install') return installIntegration();
  if (command === 'doctor') return doctor(argv); // 118b: --human 走人话体检,默认仍只打 JSON
  if (command === 'mcp-config') {
    console.log(await generateMcpConfig());
    return;
  }
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}

// Run the CLI only when executed directly; when require()'d (e.g. by an offline self-test) just export
// the internals so tests can exercise McpStdioClient / detectDesktopMcp without spawning a full server.
if (require.main === module) {
  main().catch(err => {
    const recoveryHelp = PrivacyCore.configHooks.startupGuidance?.(err);
    console.error(recoveryHelp || err.stack || err.message || String(err));
    // Startup can create watchers/timers before listen() discovers a non-Ruyi port occupant. Merely setting
    // exitCode leaves those handles alive and makes the failed CLI look hung; a direct invocation must fail fast.
    process.exit(1);
  });
}

module.exports = {
  // 工具分发批(审计 N1/N4/N5/N6/N7/A2/A14/F3/NE-12;走查 W1·F10 的 sweepStaleScriptFiles)的纯函数与钩子,一个键收口 —— unit/tool-dispatch-hardening.test.js 直调(sweepStaleScriptFiles:unit/script-run-cleanup.test.js)。
  // 2026-10 能力总闸补桥接面:toolDisabledByPolicy / accPolicyHiddenToolNames / dropPolicyDisabledBridgedTools / ACC_POLICY_TOOL_FAMILIES 同住这个键(unit/acc-capability-gates.test.js 直调)。
  dispatchTestHooks: { sweepStaleScriptFiles, validateNativeToolArgs, suggestToolNames, toolFailureResult, nativeToolDisabledByPolicy, toolDisabledByPolicy, accPolicyHiddenToolNames, dropPolicyDisabledBridgedTools, ACC_POLICY_TOOL_FAMILIES, unwrapToolInvokeCall, toolInvokeEnvelopeRepair, toolArgsSkeleton, withToolArgsGuide, toolArgsMissingRequired, normalizeMcpToolResult, attachScreenshotImage, desktopAuditEntriesFromResult, bridgedDesktopLeaseMode, mcpChildExitResult, bridgedServerUnavailableMessage },
  spawnDetachedChecked, // 分离式外部启动带 'error' 监听的唯一入口(unit/http-input-hardening.test.js 直测 ENOENT 不成 uncaughtException)
  // 架构还债批 2·A:服务商 HTTP 原语(04h)与两个非流式补全外壳 —— unit/provider-http.test.js 钉请求逐字节形状;
  // 瞬时错误重试骨架 —— unit/transient-retry.test.js 钉判据、次数、退避序列与「首字节后不重试」。
  providerBaseWithV1, providerResponsesBase, providerApiBase, providerCompletionUrl, providerRequestHeaders, providerRawCompletion, providerFixCompletion,
  providerCallIsTransient, abortableDelay, withTransientRetry, openAiStreamOnce,
  // 58 号批 1:服务商线协议登记表(04i)—— unit/provider-wire-protocols.test.js 钉成员齐全、归一口径与各成员金样。
  PROVIDER_WIRE_PROTOCOLS, normalizeProviderApiStyle, providerWireProtocol,
  // 131b(52 号文):句尾改错的三个纯函数 — exposed for unit(提示词加固形状／出参合理性／端点解析的失败码)。
  asrFixMessages,
  asrFixSanity,
  resolveAsrFixProvider,
  // 59 号文:语音词库的纯函数内核(04j 冻结对象,一个键收口)—— unit/voice-lexicon.test.js 直调(文本读写、清洗、挑词、三处出形、原厂表自检)。
  // 59 号文 §6:从修改里学的纯函数内核(04j 冻结对象,一个键收口;拼音表经它的 HanziPinyin 属性带出)—— unit/voice-learn.test.js 直调。
  McpStdioClient,
  McpHttpClient, // 49c: 远程 MCP transport(sse/streamable-http) — exposed for e2e 直连契约断言。
  estimateHistoryTokens, // v0.8-S5: exposed for e2e direct unit testing (parts-aware token estimate v2)
  // 129a:提示词预算的尺子。管家稳定层/规则层的闸从「字符数」改成「token 估算」——
  // 字符闸对两种语言的真实成本不等价(2500 字符 ≈ 中文 1660 tok / 英文 695 tok),
  // 于是英文包被挤得塞不下规则,中文包的「余量」又是假的。静态锁要用同一把尺子,故导出。
  estimateTextTokens,
  // 第45波(压缩 v2):摘要内核 + 45a 预算适配/map-reduce 分组 — exposed for e2e(死锁角回归)。
  providerSummaryCall,
  validateStructuredSummary,
  fitHistoryForSummary,
  chunkHistoryByBudget,
  recentTurnsBoundary,
  CompactionPlan,
  // 126-111a: L1 蒸发与它的两个新原语 — exposed for e2e 白盒契约(开关关时逐字节等价老边界、
  // 开关开时按 token 预算护住尾部、边界永不落在 tool 上)。
  evaporateHistory,
  evaporateBudgetBoundary,
  historyUnitStarts,
  evaporateBudgetBoundaryEnabled,
  // 126-111e: 历史内重复读取去重 — exposed for e2e 白盒契约(键零误报/最新一次留全文/幂等)。
  dedupeRepeatedReads,
  fileReadDedupKey,
  historyReadDedupEnabled,
  // 126-111d: 摘要 prompt 双语 — exposed for e2e(开关判定/语言选择/标题容错)。
  summaryPromptI18nEnabled,
  summaryPromptWithGuidance,
  // 126-111b/111c: L2 尾部按单元保留 ＋ 重附最近读过的文件 — exposed for e2e 白盒契约。
  reseedTailUnitsEnabled,
  recentFileReads,
  reseedReattachFilesEnabled,
  COMPACT_RESEED_TAIL_MAX_TOKENS,
  resolveCompactionProvider,
  // 105b: session-notes.md 状态外置 — exposed for e2e 白盒契约(确定性切节/写读回环/显式关闭门)。
  sessionNotesEnabled,
  extractSessionNotes,
  renderSessionNotesMarkdown,
  sessionNotesPath,
  writeSessionNotes,
  readSessionNotes,
  maybeWriteSessionNotes,
  // 105d: session notes 回注 + 增量合并 — exposed for e2e 白盒契约(开关判定/有界 prompt/解析/合并)。
  sessionNotesInjectEnabled,
  sessionNotesMergeEnabled,
  buildSessionNotesInjectPrompt,
  parseSessionNotesMarkdown,
  mergeSessionNotes,
  historyStartsWithCompactionSummary,
  appendPromptToLastUserMessage,
  // 105c: 摘要实体确定性抽检 — exposed for e2e 白盒契约(抽取/检查/开关唯一判定点)。
  summaryEntityCheckEnabled,
  extractSummaryEntities,
  checkSummaryEntities,
  // 105e: 估算因子分桶 — exposed for e2e 白盒契约(开关唯一判定点/镜像 setter/三桶分类器)。
  estimateBucketsEnabled,
  setEstimateBucketsV1,
  classifyTextForEstimate,
  // 105f: 摘要单发优先 — exposed for e2e 白盒契约(开关唯一判定点/上限解析/reserve 预算)。
  summarySingleShotEnabled,
  summarySingleShotCap,
  summarySingleShotReserveTokens,
  resolveSummaryCallPolicy,
  // 105g(4.3 首项): map-reduce 全局事实表 — exposed for e2e 白盒契约(开关唯一判定点/注入消息构建)。
  summaryFactTableEnabled,
  summaryFactTableCap,
  buildSummaryFactTableMessages,
  // 105h(4.3 第二项): <=4 块顺序 refine — exposed for e2e 白盒契约。
  summaryRefineEnabled,
  buildSummaryRefineMessages,
  // 105i: map-reduce 有界并发 + fail-fast 取消 — exposed for e2e 白盒契约(上限解析/并发助手)。
  summaryMaxConcurrent,
  mapSummaryWithLimit,
  // 106 #13a/13a-t: 预算保护基础层 + 长命令时间预算 — exposed for e2e 白盒契约(开关唯一判定点/阈值解析)。
  budgetGuardEnabled,
  budgetGuardTurnTokens,
  budgetGuardWarnRatio,
  budgetGuardDecision,
  toolTimeBudgetEnabled,
  toolTimeBudgetShadowEnabled,
  toolTimeBudgetWarnMs,
  toolTimeBudgetHardMs,
  toolByteBudgetShadowBytes,
  // 106 #1 G1/G2: 前缀缓存布局开关 — exposed for e2e 白盒契约(开关唯一判定点)。
  volatileTailLayoutEnabled,
  appendOnlyToolSchemasEnabled,
  execResultCacheEnabled,
  execResultCacheMaxEntries,
  contextWindowOverrideKey,
  configuredConversationWindow,
  providerConversationContextWindow,
  agentConversationContextMeta,
  // 代理模式 v2:信封/取全文/窗口链(e2e 白盒直调)。
  agentNodeContextWindow,
  buildAgentRunEnvelope,
  cutAtSentence,
  singleAgentShorthandNode,
  legacySpawnToOrchestrateArgs,
  waitForAgentRunResults,
  parseKimiWireCompaction,
  parseKimiWireAgentEvents,
  isKimiAcpPlanFilePath,
  resolveKimiAcpPlanFilePath,
  kimiAcpSessionRestoreMethods,
  kimiAcpUnknownSessionError,
  kimiAcpModeOptionFromActivated,
  kimiAcpFreshActualForOperation,
  kimiAcpInferConcreteToolInput,
  consumeKimiAcpApproval,
  kimiAcpSuccessfulEnterPlanMode,
  kimiAcpNativeShellQuote,
  kimiAcpNativeBashWrapperTexts,
  kimiAcpNativeBashWrapperCandidate,
  kimiAcpPermissionToolCall,
  prepareKimiAcpSpawn,
  watchKimiWire,
  kimiSessionStatus,
  runKimiCompact,
  // 20-T1/20-C1/20-F1 runtime optimization pure primitives. Exported for offline replay/e2e; the master
  // shadow switch only measures candidates, while production behavior remains behind strict active flags.
  searchToolCatalog,
  compareToolRetrievalShadow,
  reduceObservationContent,
  buildObservationRecallPrompt,
  measureObservationReductionShadow,
  rehydrateObservation,
  classifyRuntimeToolFailure,
  // 第45波 45b/45d:context-400 判定 + 估算自校准/窗口学习 — exposed for e2e(校准 EMA/只降不升/超窗重试)。
  isContextOverflowError,
  noteEstimateSample,
  estimateFactor,
  noteWindowOvershoot,
  learnedWindowCap,
  calibratedEstimate,
  // v1.0.2-S2: context-window three-level resolution — exposed for e2e direct units.
  resolveContextWindow,
  providerContextWindow,
  contextWindowFromTable,
  extractContextLength,
  fetchOpenAiModels,
  CONTEXT_WINDOW_FALLBACK,
  // v2.6.2 压缩标记合并 + token 读数 — exposed for e2e direct units(合并/门槛/滞回/尾零回归)。
  fmtTokensServer,
  openCompactMarker,
  upsertCompactMarker,
  COMPACT_MARKER_MIN_SAVED_TOKENS,
  detectDesktopMcp,
  pickPython,
  desktopPythonCandidates,
  desktopMcpFromInstalledRoot,
  // 39 号文:异步孪生与预热闸门 — 单测直接拿它们量「探针不占事件循环」与「预热之后同步那支零探针」。
  detectDesktopMcpAsync,
  pickPythonAsync,
  ensureDesktopMcpWarm,
  resolveExternalMcpServers,
  safeMcpInventory,
  configureMcpFromTool,
  buildBrowserAutomationHint,
  buildToolCustomizationHint,
  // v1.1-W2 (T2): MCP drop-in scan — exposed for mcp-config e2e (invalidate cache after fixturing folders).
  invalidateMcpDropInCache,
  collectBridgedTools,
  adaptiveCatalogForMcp, // 105a: exposed for e2e 直测(observation_recall 目录门)
  resolveBridge, // v1.4.1: bridged-name prefix-tolerant routing (models that drop the serverId__ prefix)
  // 第55波 EC-C(55a): MCP 运维闭环 -- 统一读模型 + 健康探针 + 错误归类 + 兼容矩阵 - exposed for e2e 直测。
  MCP_COMPAT_MATRIX,
  classifyMcpError,
  probeMcpConnector,
  buildMcpConnectorInventory,
  safeUrlForDisplay, // 55a:远程 URL 展示脱敏 - exposed for e2e 直测
  killChildTree, // 128i:发出去就算的那一支(14 处调用点的旧形状)—— exposed for unit/kill-own-process-tree.test.js [R2]
  killAllMcpClients, // 55a:e2e 直测探针后清理 spawn 的 fake-mcp 子进程(避免 unref 子进程泄漏)
  normalizeConfig, CONFIG_MIGRATIONS, // 架构还债批 2 B1:一次性 schema 迁移表(unit/config-migrations.test.js 钉顺序与金样)
  // 128a:读-改-写整条环 exposed for unit/config-explicit-keys.test.js(真读盘、真写盘,临时 HOME)。
  readConfig,
  mutateConfig,
  AGENT_CLI_TYPES,
  normalizeAgentCliType, syncAgentCliMcpManifests, // 架构还债批 4:CLI 类型归一与 MCP 清单同步 —— exposed for unit/agent-cli-registry.test.js
  probeAgentCliLauncher,
  prepareAgentCliSpawn,
  syncMcpServersToKimi,
  parseAgentCliEvent,
  AGENT_CLI_ADAPTERS, agentCliAdapter, // 架构还债批 3 A:CLI 适配器 —— exposed for unit/agent-cli-adapters.test.js(方法集同构 + 金样)
  providerReasoningEffort,
  applyProviderReasoningEffort,
  buildClaudeCliEnv,
  decodeClaudeCliText,
  // v1.9 数据管家 — exposed for e2e direct unit assertions(保留策略归一/统计/sweep/归档读取回退)。
  normalizeStoragePolicy,
  collectStorageStats,
  storageSweep,
  readAgentRunEvents, appendAgentRunEvent, flushAgentRunEvents, runSubAgentCore,
  // 第40波:boot 恢复并发化 + syncRunEventSeq 尾窗化 — exposed for e2e(尾窗/全读回落/池语义直测)。
  syncRunEventSeq,
  autoResumeInterruptedRuns,
  markInterruptedAgentRuns,
  // 第40波:性能观测面 — exposed for e2e(路径归一化/直方图分桶/趋势节流直测)。
  recordRequestMetric,
  normalizeMetricsPath,
  maybeRecordStorageTrend,
  readStorageTrend,
  buildMetricsPayload,
  // v1.9 会话存储 v2 + 引擎转录 GC — exposed for e2e(迁移/快路径/撕裂容忍/白名单账本/保留期清理)。
  loadSession,
  createSession,
  updateSessionMeta,
  sessionMeta, // 116-2a: 侧栏/索引同源的元数据读形(含会话级 permissionMode 与派生 effectivePermissionMode)
  normalizeSessionEngineRoute,
  sessionEngineRouteFromConfig,
  configForSessionEngineRoute,
  saveSession,
  deleteSession,
  listSessions,
  mutateSession, // 128b:会话读改写原语 —— exposed for unit/session-mutate.test.js
  sessionObjectIsStale, // 128b
  runMissionDriver, // 128b:驱动器撤回后收手 —— exposed for unit/session-mutate.test.js [D1]
  rewindSession, // 107-F7b: exposed for unit(撤回代数闸:撤回之前攥在手里的副本写不回去、之后新读的照常落盘)
  flushSessionIndexSync, // 107-F9a: exposed for unit(退出时的同步刷写要把「在途」那一批也写进去,不许随被放弃的异步写一起丢)
  // 第75c波:可重建 Mission/Intervention 索引与无损 journal 压缩原语。
  getPretenderProjectionIndex,
  warmPretenderProjectionIndex,
  compactInterventionJournal,
  bumpMissionChangeSeq,
  sessionBodyPaths,
  // 117q-B6(30 号文 P2-10/P2-11):尾窗读原语 + 撕裂尾修复合一 — exposed for e2e 字节级直测
  // (造真撕裂尾文件、跑修复、断言截断后字节逐字节等于预期;不经 HTTP,直接函数调用可控)。
  readFileTail,
  repairMissionChangeTornTail,
  recordEngineTranscript,
  claudeProjectsRoot,
  claudeProjectDirKey,
  fenceSafeSlice,
  shrinkFencedSection,
  clampAppendWithSkills,
  normalizeAgentRole,
  getAgentRoleLibrary,
  readClaudeProjectAgentRoles,
  saveProjectAgentRoles,
  buildClaudeAgentDefinitions,
  classifyClaudeSubagentFailure, // cmd8191: 「命令行太长。」→ definitive 签名 — exposed for e2e unit assertions
  parseClaudeTaskNotification,
  nativeClaudeAgentResultInfo,
  BUILTIN_AGENT_ROLES,
  normalizeSession,
  isUntitledSessionTitle, // 50-fix: 未命名标题判定(双引擎自动命名共用) — exposed for e2e
  // 第 116 波 116-5a(27 号文 §11.8「线程自动摘要」):线程的名字与一句概括。
  //   sessionDisplayTitle —— 「这条线程该显示什么名字」的唯一判据(人起的 > 生成的 > 原话),
  //     服务端一处装配、多处消费,前端不许各算一遍;
  //   maybeWriteThreadBrief / parseThreadBrief —— exposed for e2e 与单测直测(生成与解析各自可判定)。
  sessionDisplayTitle,
  // 117j 收尾:会话头的【带瞬时重试】读取。Windows 的 rename 替换会开一个 ENOENT 窗口,
  // 单发 readFile 会把「正在被原子替换」误判成「不存在」。exposed for unit/session-head-read.test.js。
  readSessionHeadResilient, registerIntervention, transitionInterventionState, readInterventions, makeAttachmentRecord, threadVisible,
  maybeWriteThreadBrief,
  parseThreadBrief,
  detectDanglingTurn,
  repairProviderHistoryPairing, // 配对铁律自愈(孤儿 tool_calls 补合成 tool 回复) — exposed for e2e 直测
  repairProviderHistoryToolArgs, // 参数铁律自愈(arguments 不是 JSON 对象 -> 改写成实际执行用的 '{}') — exposed for e2e 直测
  bridgedToolTier,
  bridgedReadPathGate,   // 安全修复(审计 A②):桥接读文件的读边界 —— unit/security-audit-fixes.test.js 直调
  cwdWarning,
  defaultConfig,
  DurableJsonStore,
  sanitizeExternalMcpServer,
  // 启动时把本机 Claude Code(~/.claude.json)的 MCP 自动映射进 Ruyi(e2e 直测:幂等/上限/dismissed 跳过)。
  autoImportClaudeCodeMcp,
  // 48c: MCP 配置导入器解析器(e2e 直测 TOML/JSON 边角)。
  parseMcpConfigFile,
  scanMcpSources,
  // v0.8-S6: capability matrix + layered prompt + error枚举 (exposed for e2e + UI).
  getCapabilities,
  invalidateCapabilityCache,
  CAP_UNKNOWN_TTL_MS,
  // 128f-⑧:unit/session-index-rebuild-race 用。
  buildUsageSummary,
  forEachUsageRow, readUsageRows, usageLedgerCacheStats,   // 性能批 P1:unit/usage-ledger-cache 直调(新旧两条读账路径差分 + 增量计数)
  pretenderIndexTestHooks,   // 性能批 P2:unit/pretender-index-incremental 直调(名单比对 / 后台校验 / 延迟落盘的计数)
  flushSessionIndex,
  invalidateSessionIndex,
  setSessionIndexRebuildScanHookForTest,
  // 128f-⑪:unit/permission-wait 用。
  permissionWaitMs,
  stewardMediatedPermissionWaitMs,
  hasPendingPermissionForSession,
  requestNativePermission,
  clearPendingPermissions,
  schedulerAskWaitSessions,
  // 129f — exposed for e2e:事件总线。「该不该叫」这道门只能在总线上验 —— 经 SSE 验的话
  // 测的就成了事件流那一层的转发与前端订阅,不是这道门本身(那一层另有 event-stream 的件在钉)。
  RUYI_EVENTS,
  EventStreamHooks,
  // 128f-⑥:unit/usage-ledger-exit-flush 用。
  appendUsageLedger,
  flushUsageLedgerSync,
  peekCapabilities, // 108b-fix2:非阻塞能力缓存读取(不触发探测)
  buildProviderSystemPrompt,
  PROMPT_PACK_VERSION, // 52d: 提示词包版本(语义化版本检查)
  getPromptPack, // 116f: 提示词包选择器(locale 感知) — exposed for 静态锁直读 steward 段的分层预算
  buildStableSystemPrompt, // 51d C1a:稳定层(prefix-cache 友好)
  buildRuntimeIdentityFacts, // 108a:运行时身份事实(进程内恒定量,e2e 直测)
  buildEngineEnvBrief, resolveEngineEnvBrief, probeRgAsync, peekRgProbe, // 145-W3:引擎运行环境说明 + rg 来源探测(静态件直测)
  buildVolatileParts, // 51d C1a:易变层(C1b 移 user 侧)
  buildPlaybookIndexSection, // 108b:Playbook 精简索引段(e2e 直测围栏/上限/尾行)
  buildAgentTeamHint,
  buildClaudeNativeAgentPolicy,
  softwareEngineeringTaskProfile,
  buildPromptTaskContext,
  buildSoftwareEngineeringPolicy,
  planDiscoveryToolBatchAllowed,
  appendTurnPolicies,
  appendResponseLanguagePolicy,
  resolveToolIterationBudget,
  shouldExtendToolIterationBudget,
  TOOL_ITERATION_BUDGETS,
  buildOpenAiTools,
  AGENT_LOOP_HOOK_PHASES: AgentLoopHooks.AGENT_LOOP_HOOK_PHASES,
  registerAgentLoopHook: AgentLoopHooks.registerAgentLoopHook,
  unregisterAgentLoopHook: AgentLoopHooks.unregisterAgentLoopHook,
  listAgentLoopHooks: AgentLoopHooks.listAgentLoopHooks,
  dispatchAgentLoopHooks: AgentLoopHooks.dispatchAgentLoopHooks,
  summarizeAgentLoopToolResult: AgentLoopHooks.summarizeAgentLoopToolResult,
  // 第116波116a(27号文§11.3): 管家(Steward)引擎侧纯函数与延迟绑定命名空间 — exposed for e2e/单测。
  StewardHooks,
  STEWARD_EVENT_KINDS,
  STEWARD_DIGEST_LIMITS,
  stewardMayAct,
  // 125-P0/P1:被停下来的目标判据(06i)与失败类别的取话口(13m)—— exposed for 单测
  //   (unit/steward-inbox-core.test.js 直测两者的真值表与「未知类别」诚实回退)。
  stewardStoppedTarget,
  stewardFailureExplain,
  buildStewardDigestLine,
  // 第117波117y-S1(27号文§11.18.2): 管家正文的天花板裁剪(句界 + 诚实标记)与它【绝不能被误伤】的
  // 那个同名邻居 stewardClipSay(总览行/待决一行话的 200 字 + 省略号)—— 两个都 exposed for
  // unit/steward-core.test.js:一个正测句界裁剪,一个做反向保护断言。
  stewardTrimSayAtSentence,
  stewardClipSay,
  STEWARD_SAY_TARGET,
  STEWARD_SAY_CEILING,
  // 第116波116-2a(27号文§3.3/§8.6): 线程级权限 — 三层解析纯函数(请求级>会话级>全局)与
  // 「管家只能收紧」的序表。exposed for 单测(permission-resolve.test.js)与 e2e 直测。
  resolvePermissionMode,
  // 第117波117m-A1(27号文§3.3/§8.6): 原生引擎权限闸门本体(mode,tier,toolName,input)与「活回合此刻
  // 的会话级档」只读访问器 — exposed for e2e 直测(auto 档的高风险判据、中途改档立刻生效两条)。
  nativeToolGate,
  liveSessionPermissionMode,
  PERMISSION_MODES_REQUIRING_CONFIRM,
  STEWARD_PERMISSION_RANK,
  stewardPermissionRank,
  stewardMayTightenTo,
  // 第116波116-pre(27号文§8.12/§11.3): 递话预判纯函数 — exposed for 单测(steward-preroute.test.js)。
  STEWARD_PREROUTE_DEFAULTS,
  prerouteText,
  // 第116波116h(27号文§3.1 116h 行/§8.10): 等待原因的唯一判定点(等你>等锁>等预算>等并发位)
  //   与它的两张常量表 — exposed for 单测(steward-wait-reason.test.js)与 e2e 直测形状对账。
  STEWARD_WAIT_REASONS,
  STEWARD_WAIT_LABELS,
  waitReasonFor,
  // 第117波117l-A1(27号文§11.9 D5/D7/D4): id 人话化、新线程模型分档、「它在问你」三态 —— 三个纯
  //   函数(只吃入参、无 IO),exposed for 单测(unit/steward-humanize.test.js)与 e2e 直测。
  stewardHumanizeIds,
  stewardThreadEngineRoute,
  stewardOpenAiFallback,   // 133d:管家线程只走 OpenAI 兼容端点的回落顺序(纯函数,unit/steward-config-tier.test.js 直测)
  stewardAsksYou,
  // 第117波117q-B5(30号文§3 总表 P2-8): 中和伪造围栏标签 —— 纯函数(只吃入参、无 IO),六个调用点(06d/06e/06/09)
  //   的单一事实源。exposed for 单测(unit/neutralize-fence-tag.test.js)。
  neutralizeFenceTag,
  // 第117波117q-B7(30号文§3 总表 P2-16): argsHash 指纹算法 —— 纯函数(只吃入参、无 IO),06f-autonomy-grants.js
  //   ::consumeGrant 与 09b-replan-ledger.js::recordNodeContinuation 两个调用点的单一事实源。
  //   exposed for 单测(unit/hash-args.test.js)。
  hashArgs,
  // 第116波116c-0(27号文§1/§3.5): 会话回合核心 —— 进程内(不经 HTTP)在任意会话上发起一个完整回合,
  //   自带 sink;HTTP 的 /api/chat/stream 现在也只是它的一层壳。exposed for e2e 等价性直测与后续切片调用。
  runSessionTurn,
  // 第116波116b(27号文§11.3): 管家收件箱 — 生命周期 + 归一化/合并/去重纯函数(exposed for 单测/e2e)。
  startStewardInbox,
  stopStewardInbox,
  STEWARD_SOURCE_EVENT_MAP,
  stewardNormalizeMissionChange,
  stewardNormalizeRunEvent,
  stewardNormalizePendingIntervention,
  stewardNormalizeBudgetExhausted,
  stewardMergeInboxEvents,
  stewardEventDedupeKey,
  stewardInboxRowDedupeKeys,
  // 第116波116c(27号文§3.3/§3.5/§4): 管家工具集 — 06i 纯函数(委托书/五态判据/豁免正则/记忆去重)
  // exposed for 单测与 e2e 直测;工具实现本身经 StewardHooks 与 TOOL_HANDLERS 触达,不另开导出面。
  STEWARD_EXEMPT_TOOL_PATTERNS,
  stewardToolPermanentlyExempt,
  // 127 波 2-bis:豁免原因(单点判据,布尔由它派生)/ 精确名出口 / 类别人话表 —— 单测与 e2e 直测。
  stewardExemptReason,
  STEWARD_EXEMPT_NAME_CARVEOUTS,
  STEWARD_EXEMPT_CATEGORY_LABELS,
  // 127 波 2-quater B1:全部命中 + 底线 + 扫没扫全 / tier 口径单点 / 命令摘录(中和 + 截 300)/ 摘录上游的脱敏,
  // 以及收件箱消息装配与降级按钮 —— 单测与 e2e 直测(13k 的摘要生产者经 StewardHooks.enrichInboxRows 与
  // steward_thread_status 触达,不另开导出面:14-main -> 13k 会是一条新边)。
  stewardExemptHits,
  stewardExemptScanInput,
  stewardExemptExcerpt,
  redact,
  stewardInboxMessage,
  stewardDowngradeActions,
  // 127 波 2-quater B2:代批十道闸的纯判据 / 污染判据(工具名 + 活回合段表)/ riskNote 清洗 / 闸名表与小时上限,
  // 以及 13q 的确定性回执合并 —— 单测直测(13k 的活回合读取经 steward_decide 真路径触达,不另开导出面)。
  stewardExemptDelegationVerdict,
  // 129c 污染规则(31 号文红线 4)的两个判定面 —— exposed for e2e:「读过外界内容之后写动作
  // 降级成提议」只有把这两个直调起来才测得出【判据本身】,否则只能经一次真模型回合间接看结果。
  // 129e — exposed for e2e:「活回合期间不许换工作目录」这条忙锁,只有把在跑的那一格摆出来才测得到
  // (起一个真回合再去改,测的就成了回合调度的时序,不是这条闸本身)。
  activeChildren,
  stewardSelfServeAllows,
  stewardTurnTaintedBy,
  stewardTurnTaint,
  stewardTaintToolName,
  stewardTaintToolCall,
  stewardExemptRiskNote,
  STEWARD_EXEMPT_DELEGATION_GATES,
  STEWARD_EXEMPT_DELEGATIONS_PER_HOUR,
  STEWARD_EXEMPT_DELEGATION_TEXT_MAX,
  stewardMergeDelegationReceipts,
  // 107-S1(46 号文 §5 S1):①②③④ 的四个新纯判据 —— 摘录长度常量(闸 5 绑在它上面)、间接构造、
  // 删数据的绝对目标、confirm 族的确认清单。单测直测;act 的服务端标签与确认行经 stewardNormalizeAct
  // 的真路径(管家回合 / 降级按钮)在 e2e 里读。
  STEWARD_EXEMPT_EXCERPT_CHARS,
  stewardActConfirmSpec,
  stewardNormalizeAct,
  stewardActLabel,
  isStewardToolName,
  buildStewardBrief,
  // 129h:两个纯函数 —— 占位组装与「哪些参数没给值」。导出只为单测直测
  // (unit/steward-playbook-run.test.js 拿前端那份 assemblePlaybookPrompt 与它逐例对照)。
  stewardAssemblePlaybookPrompt,
  stewardPlaybookMissingInputs,
  STEWARD_BRIEF_LIMITS,
  deriveStewardThreadState,
  stewardThreadStateFromCard,
  stewardThreadStateFromHead,   // 架构还债批 1 #1:会话头 → 五态证据的唯一适配器(unit/steward-head-adapter.test.js)
  // 第116波116g(§3.1 事项跨会话升格): 事项级聚合状态的唯一定义(纯函数,unit 穷举真值表)。
  aggregateMissionState,
  // 117s-A D1(§11.13 ③):行序的状态秩(纯函数,单测/e2e 直测)。
  stewardThreadStateRank,
  STEWARD_MEMORY_KINDS,
  stewardTermJaccard,
  // 第116波116-2e(27号文§3.5「如意设置」行): steward_config_* 的三级分级(allowlist + fail-closed)。
  //   exposed for 单测 unit/steward-config-tier.test.js —— 它拿 Object.keys(normalizeConfig({}).config)
  //   遍历默认表的每一个键,要求逐个落到 free/confirm/forbidden 三级之一,不许漏。
  STEWARD_CONFIG_TIERS,
  stewardConfigTierFor,
  STEWARD_QUICK_ANSWER_CHARS,
  // 117s-H1(27 号文 §11.13.3「交付进箱」): 交付正文的三个预算 —— e2e 直接拿它们断言,
  //   数字只许有一份(06i 一份、13h 两份),测试不再自带字面量。
  STEWARD_DELIVERABLE_CHARS,
  STEWARD_INBOX_MESSAGE_CHARS,
  // 第116波116g: 事项容器(02 持久化面)—— e2e 直测反向索引、损坏隔离与四个归属操作的幂等。
  readMissionContainer,
  listMissionContainers,
  createMissionContainer,
  patchMissionContainer,
  missionAttachThread,
  missionMergeInto,
  missionSplitThreads,
  MISSION_CONTAINER_MAX_FILES,
  // 第116波116f(27号文§11.3): 管家回合运行器与到访 — 会话单例常量、回合入口、到访、输出契约解析器
  // 与两个分叉入口(提示词/预算)。exposed for e2e 直测;09/10/13g 侧一律经 StewardHooks 触达。
  STEWARD_SESSION_ID,
  STEWARD_SESSION_TITLE,
  runStewardTurn,
  stewardResetConversation,
  nativeToolSchema,
  // 第117波117m-A1: 熔断判据本体 — exposed for e2e 直测(小时窗只节流 trigger!=='user' 的自主回合)。
  stewardCircuitCheck,
  stewardVisit,
  stewardParseReply,
  stewardResolveRoute,
  ensureStewardSession,
  buildStewardSystemPrompt,
  stewardContextBudget,
  // 116-pre(27号文§8.12/§11.3): 递话预判端点的装配层 — exposed for e2e 直测(缓存命中/未命中两路径)。
  stewardPreroute,
  // 116c: 班组动作核心(从 POST /api/agent-runs/:id 路由零行为抽出)与 108c 自状态装配 — e2e 直测等价性。
  // 第41波(41a/41b): 表驱动工具注册表 — exposed for e2e(guard 声明化行为锁内省 + 分发行为直测)。
  TOOL_HANDLERS,
  NATIVE_TOOL_TIER,
  NATIVE_TOOL_PACKS,
  toolCall,
  classifyToolPacks,
  toolPackForName,
  buildToolCatalog,
  createToolLoadingState,
  adaptiveMetaToolSchemas,
  generateSessionMcpConfig,
  toolRequirementsMet,
  TOOL_REQUIRES,
  ERROR_CLASSES,
  CONFIG_SCHEMA,
  PERMISSION_MODES,
  ROUTE_AUTH,
  // v0.9-S2: playbooks — exposed for e2e direct unit testing (normalize / availability / draft-parse).
  normalizePlaybook,
  evalPlaybookAvailability,
  matchServiceEntry, // 127-⑧:服务入口整体序(可用 > 需配置 > 未知 > 暂无模板)的进程内单测
  // v0.9-S3 (C3): workspace-by-fingerprint — exposed for e2e direct unit testing of the resolver.
  resolveWorkspace,
  // PF1: checkpoint GC size-cap cache — exposed for e2e (assert no per-write full sweep + still purges over-cap).
  journalRecord,
  journalGc,
  journalGcProbe,
  writeHistorySnapshot, // PF1 fix: history snapshots also grow the cap-governed tree — exposed so the e2e can
                        // assert repeated snapshots move the cache AND auto-trigger a purge (bug: neither happened).
  // v0.9-S4 (C4): artifacts kind classifier + preview path-safety + summary builder — exposed for e2e units.
  kindForPath,
  buildTurnSummary,
  // v1.5-W1.5 (T3): bridged 写族路径提取 — exposed for e2e 直接单测(args→目标路径+op)。
  collectBridgedWriteTarget,
  // v1.2-B: 多目标路径提取(move/copy 两条式)+ 机制性防漏审计 — exposed for checkpoint-coverage e2e 直测。
  collectBridgedWriteTargets,
  auditBridgedWriteCoverage,
  BRIDGED_WRITE_PATH_ARGS,
  // v1.2: 终端命令内联手写 Office 的桥接分发软闸 — exposed for e2e 直接单测。
  bridgedOfficeScriptGate,
  pathWithinRoot,
  pathWithinAnyRoot,
  // v1.0.2-S3: reveal-in-explorer path guard + spawn-argv builder — exposed for e2e 单测护栏逻辑。
  guardWorkspacePath,
  buildRevealSpawn,
  // Native code-editor handoff + exact turn baselines — exposed for offline regression tests.
  buildCodeEditorSpawn,
  captureWorkspaceTurnBaseline,
  reconcileWorkspaceTurnBaseline,
  // v1.4.6-S2/S3: shell-free open-spawn argv builders + native file-tool workspace boundary guard + local
  // provider detection — exposed for e2e (pure argv / containment assertions).
  buildOpenSpawn,
  buildBrowserOpenSpawn,
  guardFileToolPath,
  providerIsLocal,
  // 第31波B(L1): autoexec denylist + 路径归一 — exposed for shell-sandbox e2e 直接单测。
  AUTOEXEC_DENYLIST,
  // v0.9-S9: web_search / web_fetch — SSRF guard + main-text extraction + cache (exposed for e2e direct units).
  ssrfCheck,
  webCachePath,
  readWebCache,
  writeWebCache,
  webFetch,
  webSearch,
  // v1.1-W1a (T1/T2/T3): fetch error classification + multi-target probe + builtin HTML search — exposed for e2e units.
  // v1.1-W2 (T1): zero-dep ZIP codec + download dest guard — exposed for tools-v3 e2e direct units.
  crc32,
  zipWrite,
  zipReadCentralDir,
  zipReadEntryData,
  guardDownloadDest,
  probeAny,
  networkAnchors,
  // Resource-aware DAG scheduler primitives (pure normalization/conflict checks plus lease integration tests).
  normalizeAgentResource,
  normalizeAgentResources,
  remapAgentResources,
  agentResourcesConflict,
  inferToolResources,
  acquireResourceLease,
  releaseResourceLease,
  resourceBlockers,
  parseStructuredAgentOutput,
  repairJson, // v1.5 (Judge JSON 修复): 零依赖修复器 — exposed for judge-json-repair e2e 直接单测。
  validateAgentJsonSchema,
  normalizeAgentGate,
  aggregateAgentVote,
  dedupeAgentFindings,
  aggregateCoverage,
  propagateAssignments,
  QUALITY_GATE_OUTPUT_SCHEMA,
  BUILTIN_AGENT_WORKFLOWS,
  normalizeWorkflowCondition,
  normalizeWorkflowLoop,
  workflowProgressFingerprint,
  evaluateNodeToolEvidence,
  // R1(13-r1-evidence-graph.md): evidence 索引 + claim 引用校验 - exposed for e2e 直测(四态:verified/unverified/跨工作区/无refs)。
  indexNodeEvidence,
  verifyNodeClaims,
  purgeNodeEvidence,
  runWorkspaceHash,
  buildNodeEvidenceCatalog,
  formatNodeEvidencePrompt,
  // R4(15-r4-memory-graph.md): 记忆关系边 + 冲突感知检索 - exposed for e2e 直测(propose/confirm/scope隔离/conflict)。
  saveMemory,
  loadMemoryRegistry,
  listWorkbenchMemories,
  readWorkbenchMemory,
  proposeWorkbenchMemory,
  proposeMemoryFromSession,
  migrateLegacyAccMemory,
  legacyAccMemoryMigrationComplete,
  buildMemoryPromptSection,
  buildCoreMemoryPromptSection,
  buildMemoryCheckPrompt,
  rankRelevantMemories,
  resolveMemoryPreflight,
  resolveCoreMemoryState,
  listMemoryRelations,
  proposeMemoryRelation,
  confirmMemoryRelation,
  deleteMemoryRelation,
  buildMemoryConflictMap,
  extractMemoryRelationProposals,
  analyzeMemoryMaintenance,
  proposeMemoryRelationTool,
  proposeMemoryRevision,
  proposeMemoryRelationRevoke,
  applyMemoryRelationProposal,
  memoryProposalPrefilter,
  parseMemoryProposalDecision,
  memoryProposalSimilarity,
  memoryProposalIsDuplicate,
  normalizeAgentWorkflow,
  resolveAgentTeamRoute,
  getAgentWorkflows,
  saveAgentWorkflow,
  deleteAgentWorkflow,
  evaluateWorkflowCondition,
  createAgentWorktree,
  finalizeAgentWorktree,
  applyAgentWorktree,
  maskSecrets,
  unmaskSecrets,
  unmaskProviders,
  // 107-S2:掩码回传的启动向量闸(providers/searchBackend/modelsApiKey 的密钥会去哪几个地址)- exposed for e2e 直测。
  maskedSecretConflicts,
  providerLaunchVectorKey,
  // Responses strict pairing adapter — exposed for e2e: shallow-copy repair must not mutate persisted history.
  responsesHistoryWithCompleteToolPairs,
  buildResponsesInputItems,
  // 117q-B1(30 号文 §4.1): 子进程 NDJSON 逐行喂入器 — exposed for unit 直测(chunk 边界切开 CJK 字节不得产生 U+FFFD)。
  createNdjsonLineFeeder,
  // 第 123 波 M1 §3.1(37 号文):定时任务纯函数内核 —— 零 I/O、时间全由入参喂,
  //   exposed for 单测 unit/scheduler-core.test.js 与三件 scheduler*.e2e.js 的直测。
  normalizeSchedulerTask,
  nextFireAt,
  parseCronExpr,
  describeSchedule,
  occurrenceKey,
  missedOccurrence,
  SCHEDULER_FIRE_MODES,
  SCHEDULER_OUTCOMES,
  SCHEDULER_FORBIDDEN_PAYLOAD_KEYS,
  SCHEDULER_LIMITS,
  SCHEDULER_DEFAULT_POLICY,
  SCHEDULER_DESCRIBE_KEYS,
  SCHEDULER_DOW_KEYS,
  // 127 波 2-ter S-a:档位值域 —— exposed for unit/scheduler-core ⑧ 与 13f steward_thread_new 枚举的相等锁。
  SCHEDULER_THREAD_TIERS,
  // 第 123 波 M1 §3.2/§3.4:调度器生命周期与假时钟 —— exposed for e2e 直测与 14 的 boot 起停。
  startScheduler,
  stopScheduler,
  schedulerRuntimeSnapshot,
  // 安全修复(审计 D):定时回合权限档的天花板(= 全局档,永不含 bypass)—— unit/security-permission-ceilings.test.js 直调整张真值表。
  schedulerPermissionModeFor,
  // 127 波 2-ter S-b:六条路由的处理函数本体 —— exposed for scheduler-steward.e2e.js 在进程内挂一个 http 壳直测
  //   「HTTP 新建 / PATCH 写不进 workdir、PATCH 保住服务端那一份」(workdir 只在管家开着且真触发过之后才有,
  //   而那件是进程内夹具;鉴权表是另一件事,由 scheduler-api.e2e.js 经真服务钉着)。
  handleSchedulerApiRoutes,
  // 第 123 波 M2 §3.5:管家面的两个观测口 —— 定时任务回调/承诺读口的延迟绑定命名空间,
  //   与「回来摘要」那一支(七类事件 + 承诺三项) exposed for scheduler-steward.e2e.js 的直测。
  stewardVisitDigest,
  // 性能批(GET /api/missions 聚合装配 + GET /api/agent-runs?view=digest 摘要缓存):unit/poll-path-caches.test.js 直调
  //   两个装配/列举函数、用 saveAgentRun 验「进程内写即作废」,并读确定性计数器(perfCounters)断言「没重算 / 没重读」。
  buildMissionAggregateRows,
  listAgentRunDigests,
  saveAgentRun,
  // 会话正文 perf(逐行 sha1 去重 + 增量取不读 provider 正文):unit/session-body-line-cache.test.js 读 perfCounters.sessionBody
  //   的确定性计数器,并把 sessionMessagesDelta 的字节戳路径与逐条序列化路径逐格比对。
  perfCounters: { missionAggregate: missionAggregateStats, agentRunDigest: AgentRunStore.stats, sessionBody: sessionBodyPerfStats },
  sessionMessagesDelta,
};
