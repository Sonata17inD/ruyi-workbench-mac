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
