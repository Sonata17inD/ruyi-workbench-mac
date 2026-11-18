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
