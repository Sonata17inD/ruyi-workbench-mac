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
