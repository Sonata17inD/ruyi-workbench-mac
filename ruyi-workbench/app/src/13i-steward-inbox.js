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
