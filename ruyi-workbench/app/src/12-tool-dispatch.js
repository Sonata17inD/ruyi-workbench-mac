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
