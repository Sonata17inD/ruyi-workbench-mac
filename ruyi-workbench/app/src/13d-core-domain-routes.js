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
    getPretenderProjectionIndex, overlayMissionCard, missionPendingCounts: (...args) => missionPendingCounts(...args), pretenderHash,
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
    pretenderNotModified, pretenderIndexMeta, emptyMissionUsage, missionPendingCounts: (...args) => missionPendingCounts(...args),
    missionCardStatus: (...args) => missionCardStatus(...args), missionRunDigest: (...args) => missionRunDigest(...args),
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
    getPretenderIndexRuntime: () => pretenderIndexRuntime, pretenderIndexMeta, getPretenderProjectionIndex, paginatePretenderProjection,
    pretenderEtag, pretenderLiveOverlayRevision, pretenderNotModified, pretenderHash,
  },
});

const handleAgentRunApiRoutes = require('./backend/agent-run-routes.cjs').createAgentRunRoutes({
  tokenOk, safeSessionId, activeAgentRuns, agentRunActionCommand, decideIntervention, agentRunFile,
  AgentRunStore, applyAgentWorktree, cleanupAgentWorktree, bumpMissionChangeSeq, RUYI_EVENTS, EventStreamHooks,
});
