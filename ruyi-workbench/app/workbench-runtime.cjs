'use strict';
const { platformRuntimeEnvironment, platformOpenSpawn, platformShellEnvironment } = require('./backend/mac-launch-policy.cjs');

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// app/build.js 依据 src/manifest.json 生成 workbench-runtime.cjs。
// 此处装配 backend/ 下的服务。修改装配后运行 node app/build.js。
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

const cliEntryFile = path.join(__dirname, 'server.js');
let startedFromCommandLine = false;
// 默认命令是 serve。只有 CLI 启动服务才检查旧数据根迁移。
function isDirectServeInvocation() {
  if (!startedFromCommandLine) return false;
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

const { localTurnTimeParts } = require('./backend/engine-env-brief.cjs');

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
const ConfigWorkspaces = require('./backend/config-workspaces.cjs').createWorkspaceConfig();
const { normalizeWorkspacePathString } = ConfigWorkspaces;
const {
  defaultConfig, normalizeConfig, CONFIG_MIGRATIONS, configValueEquals, prepareConfigWrite,
} = createConfigSchema({
  CONFIG_SCHEMA, VERSION, SKILL_ID_RE, samePathKey, sanitizeProvider, PrivacyCore, workspaces: ConfigWorkspaces,
  detectClaudePath: () => detectClaudePath(),
});

// 本进程落进 sessions 目录【本层】的原子写次数(会话头、会话索引、搜索索引……)。13e 投影索引据此区分
// 「目录 mtime 变了是自己写的」还是外部改动(外部改动当次做全量比对,自己写的只比名单)。写前、写后各记一次:
// 临时文件落下与 rename 各改一次目录 mtime,两次之间来的读也得认得出是自己。
const { createAtomicFileStore, readFileTail } = require('./backend/file-persistence.cjs');
const AtomicFiles = createAtomicFileStore({ paths, process });
const { noteSessionsDirOwnWrite, getSessionsDirOwnWriteSeq } = AtomicFiles;
let atomicWriteJson = AtomicFiles.atomicWriteJson;

const { readInstallRegistry, writeInstallRegistry, recordInstallLaunch } = require('./backend/install-registry.cjs').createInstallRegistry({
  paths, externalRoot, samePathKey, nowIso, version: VERSION, atomicWriteJson,
});

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
  detectClaudePath: () => detectClaudePath(),
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
  paths, runtime: RUNTIME, hostFile: cliEntryFile, externalRoot, ensureDirs, readConfig, resolveExternalMcpServers,
  ensureDesktopMcpWarm: config => ensureDesktopMcpWarm(config), atomicWriteJson, process,
});
const { syncMcpServersToClaude } = require('./backend/cli-mcp-sync.cjs').createCliMcpSync({
  resolveExternalMcpServers, existsExecutableAsync, DesktopShell, logEvent,
});
const { autoImportClaudeCodeMcp, agentMcpImportSources, classifyAgentMcpCandidate } =
  require('./backend/cli-mcp-import.cjs').createCliMcpImport({
    paths, agentCliHomes, findRuyiPackageRootFor, mutateConfig, logEvent,
  });

const cliDiscoveryProbes = { spawnProbeSync, spawnProbeAsync };
const AgentCliDiscovery = require('./backend/agent-cli-discovery.cjs').createAgentCliDiscovery({
  probes: cliDiscoveryProbes, process,
});
const {
  detectClaudePathUncached, detectClaudePathUncachedAsync, claudeProbeCandidates,
  probeAgentCliLauncher, probeAgentCliLauncherVerdictAsync, agentCliProbeVerdict,
  agentCliLauncherOk, agentCliLauncherUsable, invalidateClaudePathCache, invalidateAgentCliPathCaches,
  beginBootCliPathProbes, finishBootCliPathProbes, waitForBootCliPathProbes,
} = AgentCliDiscovery;
function detectClaudePath() { return AgentCliDiscovery.detectClaudePath(); }

const AGENT_CLI_HOST = Object.freeze({
  detectClaudePath: () => detectClaudePath(),
  bundledNodeExe: () => bundledNodeExe(),
});
const { selectedAgentCli, prepareAgentCliSpawn } =
  require('./backend/agent-cli-discovery.cjs').createAgentCliSelection({ AGENT_CLI_TYPES, normalizeAgentCliType, AGENT_CLI_HOST });

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

const sweepStaleScriptFiles = require('./backend/file-persistence.cjs').createGeneratedScriptCleanup(paths);

const { buildUserEnvelope, writeToChild, isAskUserTool } =
  require('./backend/cli-interactive-input.cjs').createCliInteractiveInput({ activeChildren, PrivacyCore });

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

const { createSessionFiles } = require('./backend/session-files.cjs');
const { safeSessionId, assertSessionIdForPath, sessionPath, sessionBodyPaths } = createSessionFiles({ paths });

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

const {
  sessionEngineRouteOverrides, sessionEngineRouteScopeOverrides, sessionPermissionModeOverrides,
  normalizeSessionPermissionMode, sessionPermissionModeOf, applySessionPermissionModeOverride, liveSessionPermissionMode,
  normalizeSessionDesktopTools, sessionDesktopToolsOf, sessionDesktopToolsOverrides, applySessionDesktopToolsOverride,
} = require('./backend/session-overrides.cjs').createSessionOverrides({ PERMISSION_MODES });

const {
  normalizeSessionEngineRoute, sessionEngineRouteFromConfig, inferSessionEngineRoute, configForSessionEngineRoute,
  createSessionRoutePreferences,
} = require('./backend/session-engine-route.cjs');

const { unprefixedBridgedName, unwrapToolInvokeCall, toolInvokeEnvelopeRepair, normalizeToolInvokeArgs } = require('./backend/turn-effect-kinds.cjs');

const { prepareDesktopExecutionArguments } = require('./backend/execution-arguments.cjs');

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

const { sessionRewindGenHighWater, sessionObjectIsStale } =
  require('./backend/session-files.cjs').createSessionRewindWatermark();

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
const { agentRunDir, agentRunFile } =
  require('./backend/session-files.cjs').createAgentRunPaths({ paths, safeSessionId });

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
const { sessionMessagesStamp, sessionMessagesDelta, sessionBodyRecord, setSessionBodyState, dropSessionBodyState, sessionBodyRecordFromRead, sessionBodyDanglingFromLines, readSessionBodyFile, planSessionBodyAppend, serializeSessionBody, sessionBodyText, sessionBodyDigest, sessionBodyCommitValid, sessionBodiesMatchCommit, rebaseStaleSessionBody, sessionBodyPerfStats, danglingTurnState, getSessionBodyState } = SessionBodies;


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
const { sessionOmittedProviderHistory, sessionProviderHistoryLength, SESSION_LOAD_OMIT_PROVIDER, readSessionRouteHead, reconcileTurnMetadata } = SessionPersistence;
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
const { checkpointRollbackContext, journalSessionCtx } =
  require('./backend/checkpoint-journal.cjs').createCheckpointContext({
    loadSession, readConfig, resolvePermissionMode, process,
    journalResolveTurnSeq: (...args) => journalResolveTurnSeq(...args),
  });

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

const readMissionSessionHead = require('./backend/session-files.cjs').createMissionSessionHeadReader({
  safeSessionId, sessionPath, applySessionTitleOverride, safeJsonParse,
});

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
  nativeClaudeAgentResultInfo, parseClaudeEvent, parseClaudeTaskNotification,
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

// Explicit shared prompt-registry service.
const { PROMPT_EN, PROMPT_PACK_VERSION, PROMPT_ZH, getPromptPack, revertNoticeTurns } = require('./backend/prompt-registry.cjs');
const { appendMemorySection, clampAppendWithSkills, fenceSafeSlice, shrinkFencedSection } = require('./backend/prompt-budget.cjs');
const { appendResponseLanguagePolicy, appendTurnPolicies, buildAgentTeamHint, buildClaudeNativeAgentPolicy, buildPromptTaskContext, buildSoftwareEngineeringPolicy, softwareEngineeringTaskProfile } = require('./backend/turn-prompt-policy.cjs');

const {
  BUILTIN_AGENT_WORKFLOWS, agentWorkflowSaveProblem, buildOrchestrateHint, createAgentWorkflowCatalog,
  normalizeAgentWorkflow, normalizeWaitSpec, normalizeWorkflowLoop,
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
    maybeAutoCompactAgentSession: (...args) => maybeAutoCompactAgentSession(...args),
    nativeClaudeAgentResultInfo, sameClaudeResumeCwd, selectedAgentCli,
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
    finalizeMissionAfterTurn, isUntitledSessionTitle, journalReadIndex, lastAssistantEngine,
    reconcileTurnMetadata, reconcileWorkspaceTurnBaseline, saveSession, saveTurnFinalSession,
  },
});

const maybeAutoCompactAgentSession = require('./backend/agent-auto-compaction.cjs').createAgentAutoCompaction({
  loadSession,
  agentConversationContextMeta: (...args) => agentConversationContextMeta(...args),
  runAgentExternalCompact: (...args) => runAgentExternalCompact(...args),
});

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

const buildRuntimeIdentityFacts = require('./backend/engine-env-brief.cjs').createRuntimeIdentityFacts({
  RUNTIME, DEFAULT_PORT, APP_NAME, VERSION, OVERLAY_ID, externalRoot, dataRoot,
});

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

const applyConfigPatch = require('./backend/config-patch.cjs').createConfigPatch({
  policy: {
    PERMISSION_MODES_REQUIRING_CONFIRM, maskedSecretConflictMessage, maskedSecretConflicts, unmaskSecrets,
  },
  storage: { mutateConfig, paths, logEvent },
  hooks: { StewardHooks, ToolboxHooks },
  cli: {
    invalidateAgentCliPathCaches, rememberLastUsedEngineRoute, sessionEngineRouteFromConfig,
    syncAgentRolesToClaude, syncClaudeCliSettings,
  },
  mcp: { invalidateMcpRuntime, syncMcpServersToClaude },
});

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
  backgroundChanged: sessionId => RUYI_EVENTS.emit('background.changed', { sessionId }),
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

const { legacySpawnToOrchestrateArgs, LEGACY_SPAWN_NOTE } = require('./backend/agent-workflow.cjs');

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
    loadSession, reconcileTurnMetadata, saveSession, saveTurnFinalSession, sessionDesktopToolsOf, isUntitledSessionTitle,
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
    applyMissionUpdate, bumpMissionChangeSeq, finalizeMissionAfterTurn,
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
  createCompactionRouting({ resolveContextWindow, providerContextWindow, PrivacyGateway });
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
  backgroundChanged: sessionId => RUYI_EVENTS.emit('background.changed', { sessionId }),
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

const adaptiveCatalogForMcp = require('./backend/adaptive-mcp-catalog.cjs').createAdaptiveMcpCatalog({
  MCP_TOOLS, ProcessRuntime, observationRecallEnabled, runtimeToolRequirementsMet, nativeToolDisabledByPolicy,
  isStewardToolName, collectBridgedTools, dropPolicyDisabledBridgedTools, buildToolCatalog,
});

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
});

const handleStatusApiRoutes = require('./backend/status-routes.cjs').createStatusRoutes({
  paths, RUNTIME, ServerStartNotices, readConfig, maskProviders, requestIsLoopback, computeHealth, getCapabilities, probeRgAsync,
  identity: { APP_NAME, VERSION, CONFIG_SCHEMA, OVERLAY_ID, dataRootAliases, exePath },
  conversation: { safeSessionId, readSessionRouteHead, configForSessionEngineRoute, activeOpenAiProvider,
    agentConversationContextMeta, configuredConversationWindow, resolveContextWindow, learnedWindowCap },
  cli: { agentCliAdapter, detectClaudePath, AGENT_CLI_TYPES, selectedAgentCli },
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
  config: { readConfig, mutateConfig, atomicWriteJson, agentMcpImportSources, classifyAgentMcpCandidate, generateMcpConfig },
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
    getSessionsDirOwnWriteSeq,
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

const {
  stewardCaptureDelivery, stewardDeliveryFiles, stewardDeliveryInspect, stewardDeliveryProjection,
  stewardValidateDeliveryReference,
} = require('./backend/steward-delivery-evidence.cjs').createStewardDeliveryEvidence({
  files: {
    ensureDataRootReal, fileAllowedRoots, isSensitiveDataPath, isSensitiveHardlinkAlias, kindForPath,
    pathWithinAnyRoot, remoteUncDenialResolved,
  },
  sessions: {
    loadSession, readMissionContainer, sessionDisplayTitle, sessionExecutionSnapshot, sessionMissionId,
    stewardRawKind,
  },
  evidence: { buildMissionAcceptanceProjection, nowIso, readConfig, stewardFail },
});

DeliveryHooks.capture = stewardCaptureDelivery;
StewardHooks.deliveryProjection = stewardDeliveryProjection;
StewardHooks.validateDeliveryReference = stewardValidateDeliveryReference;

const {
  stewardCanonWorkspacePath, stewardKnownWorkspaces, stewardMatchKnownWorkspace,
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
    stewardKnownWorkspaces, stewardWorkspaceNameOf, stewardCanonWorkspacePath,
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

const { stewardAuthorizeExternalContext, stewardExternalOwnerDirected, stewardImplBotSetup, stewardToolHandler } =
  require('./backend/steward-tool-admission.cjs').createStewardToolAdmission({
    hooks: { ExternalBotHooks, StewardHooks },
    tools: { jsonSchemaValueProblems, nativeToolSchema, stewardFail, stewardTurnTaintedBy },
    runtime: { readConfig, logEvent },
  });

// ════════════════════════════════════════════════════════════════════════════
// 第 116 波 116-2e —— 记忆面板(§4「面板」)、如意设置三级分级(§3.5)、内容管理(§3.5)、
// 速查线程(§11.1 第 2 项)。
// ════════════════════════════════════════════════════════════════════════════

const { stewardMemoryPanelList, stewardMemoryPanelEdit, stewardMemoryPanelRestore, stewardMemoryPanelClear, stewardMemoryPanelExport } =
  require('./backend/steward-memory-panel.cjs').createStewardMemoryPanel({
    policy: { STEWARD_MEMORY_KINDS, STEWARD_MEMORY_LIMITS, STEWARD_MEMORY_NEW_WINDOW_MS, STEWARD_MEMORY_SCHEMA, memoryIsExpired, memoryProposalLooksSensitive },
    store: { stewardMemoryScopeLabel, stewardMutateMemory, stewardReadMemoryStore },
    runtime: { nowIso, readConfig, stewardAppendDecision, stewardFail, stewardSanitizeText },
  });

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

const {
  STEWARD_VISITS_DIR, STEWARD_VISIT_SCHEMA, STEWARD_VISITS_KEEP, STEWARD_INBOX_EVENTS_PER_TURN,
  STEWARD_INBOX_EVENT_CHARS, STEWARD_INBOX_DELIVERABLE_CHARS, STEWARD_INBOX_MESSAGE_CHARS,
  STEWARD_MEMORY_BLOCK_CHARS, STEWARD_MEMORY_VETOED_BLOCK_CHARS, STEWARD_MEMORY_VETOED_MAX, STEWARD_SAY_TARGET,
  STEWARD_SAY_CEILING, STEWARD_WHY_MAX, STEWARD_ACT_LABEL_MAX, STEWARD_ACT_CONFIRM_LABEL_MAX,
  STEWARD_ACT_CONFIRM_VALUE_CHARS, STEWARD_ACTS_MAX, STEWARD_ACTIONS_MAX, STEWARD_DEBOUNCE_MS,
  STEWARD_QUICK_DEBOUNCE_MS, STEWARD_BLOCKING_DEBOUNCE_MS, STEWARD_VIEW_RECHECK_MS, STEWARD_VIEW_HELD_MAX,
  STEWARD_NO_PROGRESS_MAX, STEWARD_VISIT_DIGEST_MAX, STEWARD_PENDING_LIST_MAX, STEWARD_TURN_WINDOW_MS,
  STEWARD_TURN_DAY_MS, STEWARD_PREEMPT_WAIT_MS, STEWARD_USER_QUEUE_WAIT_MS, STEWARD_SELF_SERVE_ATTEMPT_MAX,
  STEWARD_SELF_SERVE_RETRY_WINDOW_MS, STEWARD_SELF_SERVE_PER_TURN_MAX, STEWARD_CONTINUE_PLAN_MAX,
  STEWARD_CONTINUE_NOPLAN_MAX, STEWARD_CONTINUE_FRESH_MS, STEWARD_CONTINUE_PROMPT, STEWARD_DIGEST_KIND_TEXT,
  stewardFailureExplain, STEWARD_ACTION_HOOKS, STEWARD_DECIDE_LABELS, STEWARD_RUN_ACTION_LABELS,
  STEWARD_TOOL_LABELS,
} = require('./backend/steward-runner-policy.cjs').createStewardRunnerPolicy({
  labels: { ERROR_CLASSES, stewardSanitizeText },
});

const {
  stewardRunnerRuntime, stewardStopRunner, stewardResumeRunner, stewardAbortInflight, stewardResolveRoute,
  ensureStewardSession,
} = require('./backend/steward-runner-lifecycle.cjs').createStewardRunnerLifecycle({
  sessions: {
    SESSION_SCHEMA, STEWARD_SESSION_ID, STEWARD_SESSION_TITLE, STEWARD_PERMISSION_MODE, loadSession,
    saveSession, stopSession,
  },
  routing: {
    AGENT_CLI_TYPES, normalizeAgentCliType, normalizeSessionEngineRoute, sessionEngineRouteFromConfig,
  },
  runtime: { paths, nowIso, logEvent },
});

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
    stewardKnownWorkspaces, stewardSanitizeText,
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

const { stewardImplThreadPrioritize, stewardImplThreadStop, stewardAppendUserStop } =
  require('./backend/steward-thread-control.cjs').createStewardThreadControl({
    execution: { requestSessionExecutionStop, stewardArbiterPrioritize, stewardArbiterWait },
    sessions: { safeSessionId, stewardRawKind, stewardReadSessionHead, stewardThreadPermissionMode },
    audit: { readConfig, stewardAppendDecision, stewardBasisOf, stewardFail, stewardSanitizeText, waitReasonFor },
  });
const { stewardSanitizeAttachments } = require('./backend/steward-runner-state.cjs');

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

const stewardRunnerState = require('./backend/steward-runner-state.cjs').createStewardRunnerState({
  STEWARD_TURN_DAY_MS, STEWARD_TURN_WINDOW_MS, stewardArbiterState, stewardDayCost, stewardRunnerRuntime, stewardTurnsInWindow,
});

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
  authorizeRoute, handlePrivacyApiRoutes: PrivacyCore.configHooks.handleApiRoutes,
  handleExternalBotApiRoutes: ExternalBotHooks.handleApiRoutes, handleStewardApiRoutes: StewardHooks.handleApiRoutes,
  handleEventStreamApiRoutes: EventStreamHooks.handleApiRoutes,
  handleStatusApiRoutes, handlePlaybookApiRoutes, handleWorkspaceApiRoutes, handleModelsApiRoute,
  handleConfigurationApiRoutes, handleProviderTestApiRoute, handleSessionApiRoutes, handleMissionsApiRoutes,
  handleSkillApiRoutes, handleMemoryApiRoutes, handleSessionExecutionApiRoutes, handleInterventionApiRoutes,
  handleMissionLedgerApiRoutes, handleAutonomyGrantApiRoutes, handleAgentWorkflowApiRoutes,
  handleUsageApiRoutes, handleAgentRunApiRoutes, handleCheckpointQueryApiRoutes, handleLocalSupportApiRoutes,
  handleMcpApiRoutes, handleDiagnosticsApiRoutes, handleCheckpointApiRoutes, handleSteerApiRoute, handleAudioApiRoutes,
  handleSchedulerApiRoutes, handleAttachmentApiRoutes, handleChatApiRoute, handleToolApiRoutes,
});

const { createIntegrationCommands, createWorkbenchCli } = require('./backend/integration-commands.cjs');
const { startMcp, installIntegration } = createIntegrationCommands({
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
    getCapabilities, generateMcpConfig },
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

function startWorkbenchFromCommandLine() {
  startedFromCommandLine = true;
  return createWorkbenchCli({ process, parseArgs, startServer, startStewardInbox, readConfig,
    startMcp, installIntegration, doctor, generateMcpConfig,
    startupGuidance: error => PrivacyCore.configHooks.startupGuidance?.(error),
  })();
}

const createWorkbenchApi = () => ({
  dispatchTestHooks: { sweepStaleScriptFiles, validateNativeToolArgs, suggestToolNames, toolFailureResult, nativeToolDisabledByPolicy, toolDisabledByPolicy, accPolicyHiddenToolNames, dropPolicyDisabledBridgedTools, ACC_POLICY_TOOL_FAMILIES, unwrapToolInvokeCall, toolInvokeEnvelopeRepair, toolArgsSkeleton, withToolArgsGuide, toolArgsMissingRequired, normalizeMcpToolResult, attachScreenshotImage, desktopAuditEntriesFromResult, bridgedDesktopLeaseMode, mcpChildExitResult, bridgedServerUnavailableMessage },
  spawnDetachedChecked,
  providerBaseWithV1, providerResponsesBase, providerApiBase, providerCompletionUrl, providerRequestHeaders, providerRawCompletion, providerFixCompletion,
  providerCallIsTransient, abortableDelay, withTransientRetry, openAiStreamOnce,
  PROVIDER_WIRE_PROTOCOLS, normalizeProviderApiStyle, providerWireProtocol,
  asrFixMessages,
  asrFixSanity,
  resolveAsrFixProvider,
  McpStdioClient,
  McpHttpClient,
  estimateHistoryTokens,
  estimateTextTokens,
  providerSummaryCall,
  validateStructuredSummary,
  fitHistoryForSummary,
  chunkHistoryByBudget,
  recentTurnsBoundary,
  CompactionPlan,
  evaporateHistory,
  evaporateBudgetBoundary,
  historyUnitStarts,
  evaporateBudgetBoundaryEnabled,
  dedupeRepeatedReads,
  fileReadDedupKey,
  historyReadDedupEnabled,
  summaryPromptI18nEnabled,
  summaryPromptWithGuidance,
  reseedTailUnitsEnabled,
  recentFileReads,
  reseedReattachFilesEnabled,
  COMPACT_RESEED_TAIL_MAX_TOKENS,
  resolveCompactionProvider,
  sessionNotesEnabled,
  extractSessionNotes,
  renderSessionNotesMarkdown,
  sessionNotesPath,
  writeSessionNotes,
  readSessionNotes,
  maybeWriteSessionNotes,
  sessionNotesInjectEnabled,
  sessionNotesMergeEnabled,
  buildSessionNotesInjectPrompt,
  parseSessionNotesMarkdown,
  mergeSessionNotes,
  historyStartsWithCompactionSummary,
  appendPromptToLastUserMessage,
  summaryEntityCheckEnabled,
  extractSummaryEntities,
  checkSummaryEntities,
  estimateBucketsEnabled,
  setEstimateBucketsV1,
  classifyTextForEstimate,
  summarySingleShotEnabled,
  summarySingleShotCap,
  summarySingleShotReserveTokens,
  resolveSummaryCallPolicy,
  summaryFactTableEnabled,
  summaryFactTableCap,
  buildSummaryFactTableMessages,
  summaryRefineEnabled,
  buildSummaryRefineMessages,
  summaryMaxConcurrent,
  mapSummaryWithLimit,
  budgetGuardEnabled,
  budgetGuardTurnTokens,
  budgetGuardWarnRatio,
  budgetGuardDecision,
  toolTimeBudgetEnabled,
  toolTimeBudgetShadowEnabled,
  toolTimeBudgetWarnMs,
  toolTimeBudgetHardMs,
  toolByteBudgetShadowBytes,
  volatileTailLayoutEnabled,
  appendOnlyToolSchemasEnabled,
  execResultCacheEnabled,
  execResultCacheMaxEntries,
  contextWindowOverrideKey,
  configuredConversationWindow,
  providerConversationContextWindow,
  agentConversationContextMeta,
  agentNodeContextWindow,
  buildAgentRunEnvelope,
  cutAtSentence,
  singleAgentShorthandNode,
  legacySpawnToOrchestrateArgs,
  waitForAgentRunResults,
  searchToolCatalog,
  compareToolRetrievalShadow,
  reduceObservationContent,
  buildObservationRecallPrompt,
  measureObservationReductionShadow,
  rehydrateObservation,
  classifyRuntimeToolFailure,
  isContextOverflowError,
  noteEstimateSample,
  estimateFactor,
  noteWindowOvershoot,
  learnedWindowCap,
  calibratedEstimate,
  resolveContextWindow,
  providerContextWindow,
  contextWindowFromTable,
  extractContextLength,
  fetchOpenAiModels,
  CONTEXT_WINDOW_FALLBACK,
  fmtTokensServer,
  openCompactMarker,
  upsertCompactMarker,
  COMPACT_MARKER_MIN_SAVED_TOKENS,
  detectDesktopMcp,
  pickPython,
  desktopPythonCandidates,
  desktopMcpFromInstalledRoot,
  detectDesktopMcpAsync,
  pickPythonAsync,
  ensureDesktopMcpWarm,
  resolveExternalMcpServers,
  safeMcpInventory,
  configureMcpFromTool,
  buildBrowserAutomationHint,
  buildToolCustomizationHint,
  invalidateMcpDropInCache,
  collectBridgedTools,
  adaptiveCatalogForMcp,
  resolveBridge,
  MCP_COMPAT_MATRIX,
  classifyMcpError,
  probeMcpConnector,
  buildMcpConnectorInventory,
  safeUrlForDisplay,
  killChildTree,
  killAllMcpClients,
  normalizeConfig, CONFIG_MIGRATIONS,
  readConfig,
  mutateConfig,
  AGENT_CLI_TYPES,
  normalizeAgentCliType,
  probeAgentCliLauncher,
  prepareAgentCliSpawn,
  AGENT_CLI_ADAPTERS, agentCliAdapter,
  providerReasoningEffort,
  applyProviderReasoningEffort,
  buildClaudeCliEnv,
  decodeClaudeCliText,
  normalizeStoragePolicy,
  collectStorageStats,
  storageSweep,
  readAgentRunEvents, appendAgentRunEvent, flushAgentRunEvents, runSubAgentCore,
  syncRunEventSeq,
  autoResumeInterruptedRuns,
  markInterruptedAgentRuns,
  recordRequestMetric,
  normalizeMetricsPath,
  maybeRecordStorageTrend,
  readStorageTrend,
  buildMetricsPayload,
  loadSession,
  createSession,
  updateSessionMeta,
  sessionMeta,
  configForSessionEngineRoute,
  saveSession,
  deleteSession,
  listSessions,
  mutateSession,
  sessionObjectIsStale,
  runMissionDriver,
  rewindSession,
  flushSessionIndexSync,
  getPretenderProjectionIndex,
  compactInterventionJournal,
  bumpMissionChangeSeq,
  sessionBodyPaths,
  readFileTail,
  repairMissionChangeTornTail,
  recordEngineTranscript,
  claudeProjectDirKey,
  fenceSafeSlice,
  shrinkFencedSection,
  clampAppendWithSkills,
  normalizeAgentRole,
  getAgentRoleLibrary,
  readClaudeProjectAgentRoles,
  saveProjectAgentRoles,
  buildClaudeAgentDefinitions,
  classifyClaudeSubagentFailure,
  parseClaudeTaskNotification,
  nativeClaudeAgentResultInfo,
  BUILTIN_AGENT_ROLES,
  normalizeSession,
  isUntitledSessionTitle,
  sessionDisplayTitle,
  readSessionHeadResilient, registerIntervention, transitionInterventionState, readInterventions, makeAttachmentRecord, threadVisible,
  maybeWriteThreadBrief,
  parseThreadBrief,
  detectDanglingTurn,
  bridgedToolTier,
  bridgedReadPathGate,
  cwdWarning,
  defaultConfig,
  DurableJsonStore,
  sanitizeExternalMcpServer,
  autoImportClaudeCodeMcp,
  parseMcpConfigFile,
  scanMcpSources,
  getCapabilities,
  invalidateCapabilityCache,
  CAP_UNKNOWN_TTL_MS,
  buildUsageSummary,
  forEachUsageRow, readUsageRows, usageLedgerCacheStats,
  pretenderIndexTestHooks,
  flushSessionIndex,
  invalidateSessionIndex,
  setSessionIndexRebuildScanHookForTest,
  permissionWaitMs,
  stewardMediatedPermissionWaitMs,
  hasPendingPermissionForSession,
  requestNativePermission,
  clearPendingPermissions,
  schedulerAskWaitSessions,
  RUYI_EVENTS,
  EventStreamHooks,
  appendUsageLedger,
  flushUsageLedgerSync,
  peekCapabilities,
  buildProviderSystemPrompt,
  PROMPT_PACK_VERSION,
  getPromptPack,
  buildStableSystemPrompt,
  buildRuntimeIdentityFacts,
  buildEngineEnvBrief, resolveEngineEnvBrief, probeRgAsync, peekRgProbe,
  buildVolatileParts,
  buildPlaybookIndexSection,
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
  StewardHooks,
  STEWARD_EVENT_KINDS,
  STEWARD_DIGEST_LIMITS,
  stewardMayAct,
  stewardStoppedTarget,
  stewardFailureExplain,
  buildStewardDigestLine,
  stewardTrimSayAtSentence,
  stewardClipSay,
  STEWARD_SAY_TARGET,
  STEWARD_SAY_CEILING,
  resolvePermissionMode,
  nativeToolGate,
  liveSessionPermissionMode,
  PERMISSION_MODES_REQUIRING_CONFIRM,
  STEWARD_PERMISSION_RANK,
  stewardPermissionRank,
  stewardMayTightenTo,
  STEWARD_PREROUTE_DEFAULTS,
  prerouteText,
  STEWARD_WAIT_REASONS,
  STEWARD_WAIT_LABELS,
  waitReasonFor,
  stewardHumanizeIds,
  stewardThreadEngineRoute,
  stewardOpenAiFallback,
  stewardAsksYou,
  neutralizeFenceTag,
  runSessionTurn,
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
  STEWARD_EXEMPT_TOOL_PATTERNS,
  stewardToolPermanentlyExempt,
  stewardExemptReason,
  STEWARD_EXEMPT_NAME_CARVEOUTS,
  STEWARD_EXEMPT_CATEGORY_LABELS,
  stewardExemptHits,
  stewardExemptScanInput,
  stewardExemptExcerpt,
  redact,
  stewardInboxMessage,
  stewardDowngradeActions,
  stewardExemptDelegationVerdict,
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
  STEWARD_EXEMPT_EXCERPT_CHARS,
  stewardActConfirmSpec,
  stewardNormalizeAct,
  stewardActLabel,
  isStewardToolName,
  buildStewardBrief,
  stewardAssemblePlaybookPrompt,
  stewardPlaybookMissingInputs,
  STEWARD_BRIEF_LIMITS,
  deriveStewardThreadState,
  stewardThreadStateFromCard,
  stewardThreadStateFromHead,
  aggregateMissionState,
  STEWARD_MEMORY_KINDS,
  stewardTermJaccard,
  STEWARD_CONFIG_TIERS,
  stewardConfigTierFor,
  STEWARD_QUICK_ANSWER_CHARS,
  STEWARD_DELIVERABLE_CHARS,
  STEWARD_INBOX_MESSAGE_CHARS,
  readMissionContainer,
  listMissionContainers,
  createMissionContainer,
  patchMissionContainer,
  missionAttachThread,
  missionMergeInto,
  missionSplitThreads,
  MISSION_CONTAINER_MAX_FILES,
  STEWARD_SESSION_ID,
  STEWARD_SESSION_TITLE,
  runStewardTurn,
  stewardResetConversation,
  nativeToolSchema,
  stewardCircuitCheck,
  stewardVisit,
  stewardParseReply,
  stewardResolveRoute,
  ensureStewardSession,
  buildStewardSystemPrompt,
  stewardContextBudget,
  stewardPreroute,
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
  normalizePlaybook,
  evalPlaybookAvailability,
  matchServiceEntry,
  resolveWorkspace,
  journalRecord,
  journalGc,
  journalGcProbe,
  writeHistorySnapshot,
  kindForPath,
  buildTurnSummary,
  collectBridgedWriteTarget,
  collectBridgedWriteTargets,
  auditBridgedWriteCoverage,
  BRIDGED_WRITE_PATH_ARGS,
  bridgedOfficeScriptGate,
  pathWithinRoot,
  pathWithinAnyRoot,
  guardWorkspacePath,
  buildRevealSpawn,
  buildCodeEditorSpawn,
  captureWorkspaceTurnBaseline,
  reconcileWorkspaceTurnBaseline,
  buildOpenSpawn,
  buildBrowserOpenSpawn,
  guardFileToolPath,
  providerIsLocal,
  AUTOEXEC_DENYLIST,
  ssrfCheck,
  webCachePath,
  readWebCache,
  writeWebCache,
  webFetch,
  webSearch,
  crc32,
  zipWrite,
  zipReadCentralDir,
  zipReadEntryData,
  guardDownloadDest,
  probeAny,
  networkAnchors,
  normalizeAgentResource,
  normalizeAgentResources,
  remapAgentResources,
  agentResourcesConflict,
  inferToolResources,
  acquireResourceLease,
  releaseResourceLease,
  resourceBlockers,
  parseStructuredAgentOutput,
  repairJson,
  validateAgentJsonSchema,
  normalizeAgentGate,
  aggregateAgentVote,
  dedupeAgentFindings,
  aggregateCoverage,
  propagateAssignments,
  QUALITY_GATE_OUTPUT_SCHEMA,
  BUILTIN_AGENT_WORKFLOWS,
  normalizeWorkflowLoop,
  workflowProgressFingerprint,
  evaluateNodeToolEvidence,
  indexNodeEvidence,
  verifyNodeClaims,
  purgeNodeEvidence,
  runWorkspaceHash,
  buildNodeEvidenceCatalog,
  formatNodeEvidencePrompt,
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
  maskedSecretConflicts,
  providerLaunchVectorKey,
  responsesHistoryWithCompleteToolPairs,
  buildResponsesInputItems,
  createNdjsonLineFeeder,
  startScheduler,
  stopScheduler,
  schedulerRuntimeSnapshot,
  schedulerPermissionModeFor,
  handleSchedulerApiRoutes,
  stewardVisitDigest,
  buildMissionAggregateRows,
  listAgentRunDigests,
  saveAgentRun,
  perfCounters: { missionAggregate: missionAggregateStats, agentRunDigest: AgentRunStore.stats, sessionBody: sessionBodyPerfStats },
  sessionMessagesDelta,
});

module.exports = { startWorkbenchFromCommandLine, createWorkbenchApi };
