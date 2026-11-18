const {
  stewardDowngradeActions, stewardExecuteActions, stewardSelfServeAllows, stewardTargetPermission,
} = require('./backend/steward-action-execution.cjs').createStewardActionExecution({
  safeSessionId, configValueEquals, stewardSanitizeText, stewardFail,
  actionHooks: { StewardHooks, STEWARD_ACTION_HOOKS },
  admission: {
    stewardAuthorizeExternalContext, stewardExternalOwnerDirected, stewardMayAct, stewardTurnTaintedBy,
  },
  sessions: { stewardReadSessionHead, stewardThreadPermissionMode, stewardPermissionLabel },
  proposals: { stewardActConfirmLines, stewardActConfirmSpec, stewardActLabel, stewardNormalizeAct },
  limits: { STEWARD_ACTS_MAX, STEWARD_ACT_LABEL_MAX, STEWARD_ANSWER_BASIS, STEWARD_SELF_SERVE_PER_TURN_MAX },
});

const {
  stewardCircuitCheck, stewardDayCost, stewardTurnsInWindow,
} = require('./backend/steward-turn-circuit.cjs').createStewardTurnCircuit({
  stewardRunnerRuntime, forEachUsageRow, usageDayKey, usageDayKeyMemo, usageRangeLowerMs,
  limits: { STEWARD_NO_PROGRESS_MAX, STEWARD_TURN_DAY_MS, STEWARD_TURN_WINDOW_MS },
});

const {
  stewardHumanizeSay, stewardLastAssistantContent, stewardLastAssistantFinalSegment,
  stewardNormalizeRouteHint, stewardStampReply, stewardTriggerStamp, stewardDisplayTitleOf,
} = require('./backend/steward-conversation-replies.cjs').createStewardConversationReplies({
  STEWARD_SESSION_ID, safeSessionId, stewardSanitizeText, sessionDisplayTitle, stewardHumanizeIds,
  sessions: { loadSession, mutateSession, stewardReadSessionHead },
});

const { stewardSelfServeInbox } = require('./backend/steward-autonomous-actions.cjs').createStewardAutonomousActions({
  logEvent, safeSessionId, stewardFail, stewardSanitizeText, stewardDisplayTitleOf, stewardRunnerRuntime,
  actionHooks: { StewardHooks, STEWARD_ACTION_HOOKS, stewardAppendDecision },
  sessions: {
    activeChildren, detectDanglingTurn, loadSession, readInterventions, sessionTodosSignature,
    stewardAsksYouForThread, stewardLastAssistantText, stewardReadSessionHead, stewardThreadPermissionMode,
  },
  runSnapshots: { stewardReadRunSnapshot, stewardRunResumeTier },
  admission: {
    stewardMayAct, stewardPermissionLabel, stewardSeatedByUser, stewardStoppedRefusal, stewardStoppedTarget,
    stewardTargetPermission,
  },
  budget: { stewardDayCost, stewardTurnsInWindow },
  limits: {
    SESSION_LOAD_OMIT_PROVIDER, STEWARD_CONTINUE_FRESH_MS, STEWARD_CONTINUE_NOPLAN_MAX,
    STEWARD_CONTINUE_PLAN_MAX, STEWARD_CONTINUE_PROMPT, STEWARD_SELF_SERVE_ATTEMPT_MAX,
    STEWARD_SELF_SERVE_PER_TURN_MAX, STEWARD_SELF_SERVE_RETRY_WINDOW_MS, STEWARD_TURN_WINDOW_MS,
  },
});

const { stewardInboxMessage } = require('./backend/steward-inbox-prompt.cjs').createStewardInboxPrompt({
  getPromptPack, safeSessionId, stewardDisplayTitleOf, stewardFailureExplain, stewardForeignProjection,
  stewardSanitizeBlock, stewardSanitizeText,
  limits: {
    STEWARD_EXEMPT_CATEGORY_LABELS, STEWARD_INBOX_DELIVERABLE_CHARS, STEWARD_INBOX_EVENTS_PER_TURN,
    STEWARD_INBOX_EVENT_CHARS, STEWARD_INBOX_MESSAGE_CHARS, STEWARD_SELF_SERVE_PER_TURN_MAX,
  },
});
