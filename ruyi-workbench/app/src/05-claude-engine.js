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
