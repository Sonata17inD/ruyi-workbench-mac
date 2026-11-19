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
