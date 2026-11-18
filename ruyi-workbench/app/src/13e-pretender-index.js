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
