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

const maybeAutoCompactAgentSession = require('./backend/agent-auto-compaction.cjs').createAgentAutoCompaction({
  loadSession,
  agentConversationContextMeta: (...args) => agentConversationContextMeta(...args),
  runAgentExternalCompact: (...args) => runAgentExternalCompact(...args),
});
