const {
  stewardCanonWorkspacePath, stewardFoldWorkspacePath, stewardKnownWorkspaces, stewardMatchKnownWorkspace,
  stewardWorkspaceNameOf, stewardValidateCwd, stewardResolveThreadCwd, stewardRecordMissionWorkspace, stewardDeriveThreadCwd,
} = require('./backend/steward-workspaces.cjs').createStewardWorkspaces({
  dataRoot, dataRootAliases, nowIso, sanitizeFsSegmentName, safeSessionId, mutateConfig, normalizeWorkspacePathString,
  sessions: { listSessions, sessionMetaIsSteward, stewardRawKind, stewardReadSessionHead },
  missions: { readMissionContainer, withMissionContainerLock, writeMissionContainer },
  rules: { STEWARD_WORKSPACE_TABLE_MAX, stewardRuyiOwnedPath, stewardWorkspaceLabels, stewardFail },
});

const {
  stewardPendingExecutionSummary, stewardExemptPendingSummary, stewardLiveTurnPermissionMode,
  stewardExemptLiveTurn, stewardExemptDelegatedLog, stewardEnrichInboxRows, stewardQuickClose,
} = require('./backend/steward-thread-delivery.cjs').createStewardThreadDelivery({
  logEvent, nowIso, redact, safeSessionId, activeChildren, loadSession, readInterventions, updateSessionMeta,
  contracts: {
    STEWARD_DELIVERABLE_CHARS, STEWARD_EXEMPT_INPUT_CHARS, STEWARD_QUICK_ANSWER_CHARS, STEWARD_QUICK_KIND,
    stewardExemptExcerpt, stewardExemptHits, stewardExemptInputText, stewardExemptScanInput, stewardSanitizeBlock,
    stewardSanitizeText, stewardTurnTaint, stewardWatchedThread,
  },
  threads: {
    stewardLastAssistantText, stewardQuickClosed, stewardRawKind, stewardReadSessionHead, stewardTurnAssistantText,
    stewardTurnFiles,
  },
});

const {
  threadRelationsIndex, threadRelatedThreads, stewardThreadDisplayTitle,
  stewardImplThreadsSearch, stewardImplThreadStatus, stewardImplThreadRead, stewardToolCallLine, stewardToolCallVerdict,
} = require('./backend/steward-thread-queries.cjs').createStewardThreadQueries({
  redact, safeSessionId, getPromptPack,
  sessions: {
    isUntitledSessionTitle, listSessions, loadSession, readInterventions, readMissionContainer,
    SESSION_BRIEF_TITLE_CHARS, sessionBriefOf, sessionDisplayTitle, sessionMeta, sessionMetaIsSteward,
    sessionMissionId, stewardReadSessionHead,
  },
  projection: {
    buildMissionAggregateRows, getPretenderProjectionIndex, missionPendingCounts, overlayMissionCard,
    searchSessionsByContent, sessionSearchScope, sessionSearchIndexEnabled,
    stewardPendingExecutionSummary, stewardExemptPendingSummary,
  },
  runtime: {
    activeChildren, sessionExecutionSnapshot, sessionPermissionModeOf, StewardHooks,
  },
  workspaces: {
    stewardKnownWorkspaces, stewardWorkspaceNameOf, stewardCanonWorkspacePath, stewardFoldWorkspacePath,
  },
  policy: {
    deriveStewardThreadState, stewardAsksYouForThread, stewardClipSay, stewardForeignProjection,
    stewardPendingOneLine, stewardPermissionLabel, stewardSanitizeBlock, stewardSanitizeText,
    stewardThreadStateFromCard, stewardThreadStateFromHead, waitReasonFor,
  },
  tools: {
    stewardClampInt, stewardDisplayKind, stewardEngineOf, stewardFail, stewardLastAssistantText,
    stewardQuickClosed, stewardQuickThread, stewardRawKind, stewardReadBucket, stewardThreadPermissionMode,
    stewardTurnKeyOf,
  },
  limits: {
    STEWARD_PENDING_SUMMARY_MAX, STEWARD_READ_CALLS_PER_TURN, STEWARD_READ_CHARS_DEFAULT, STEWARD_READ_CHARS_MAX,
    STEWARD_READ_CHARS_MIN, STEWARD_READ_CLIP_MARK, STEWARD_READ_ROW_OVERHEAD, STEWARD_READ_TAIL_DEFAULT,
    STEWARD_READ_TAIL_MAX, STEWARD_SEARCH_LIMIT_DEFAULT, STEWARD_SEARCH_LIMIT_MAX,
  },
});

const {
  stewardLaunchTurn, stewardLaunchPending, stewardErrorDetail, stewardUserDirected,
  stewardUnattendedByModel, stewardRelayAutoAllowed,
} = require('./backend/steward-thread-launch.cjs').createStewardThreadLauncher({
  ExternalBotHooks, logEvent, nowIso, safeSessionId, updateSessionMeta, runSessionTurn,
});

const { stewardImplThreadNew, stewardImplQuickAsk } = require('./backend/steward-thread-create.cjs').createStewardThreadCreation({
  nowIso, safeSessionId, stewardAppendDecision, stewardBasisOf, stewardFail, stewardTurnKeyOf, stewardTurnQuotaTake, stewardLaunchTurn,
  sessions: {
    createSession, listSessions, missionIndexAdd, readMissionContainer, saveSession, sessionMetaIsSteward,
    sessionMissionId, stewardRawKind, stewardReadSessionHead, stewardThreadPermissionMode,
  },
  workspaces: {
    stewardDeriveThreadCwd, stewardRecordMissionWorkspace, stewardResolveThreadCwd, stewardWorkspaceNameOf,
  },
  policy: {
    StewardHooks, stewardUnattendedByModel, stewardOpenAiFallback, stewardSanitizeText,
  },
  content: {
    listPlaybooksWithAvailability, buildStewardBrief, stewardAssemblePlaybookPrompt,
    stewardPlaybookMissingInputs,
  },
  limits: {
    STEWARD_QUICK_KIND, STEWARD_QUICK_QUESTION_CHARS, STEWARD_QUICK_ASKS_PER_TURN, STEWARD_TITLE_MAX,
  },
});

const {
  stewardSeatedByUser, stewardMediatedPermissionWaitMs, stewardMediatesPermissions, stewardSeatedFail,
  stewardAnswerGate,
} = require('./backend/steward-thread-admission.cjs').createStewardThreadAdmission({
  EventStreamHooks, sessionMissionId, memoryIsExpired, STEWARD_ANSWER_BASIS,
  STEWARD_SESSION_ID, stewardMayAct, stewardPermissionLabel, stewardSanitizeText, stewardWatchedThread,
  threadOriginOf, stewardFail, stewardReadMemoryStore, stewardThreadPermissionMode, stewardTurnTaintedBy,
  stewardUserDirected,
});
PermissionWaitHooks.steward = stewardMediatedPermissionWaitMs;

const {
  stewardContinueAttachments, stewardImplThreadContinue, stewardImplThreadRename, stewardImplThreadWorkspace,
  stewardImplThreadPermission, stewardImplThreadNote,
} = require('./backend/steward-thread-edits.cjs').createStewardThreadEdits({
  paths, safeSessionId, pathWithinRoot, decodeTextFileBytes, realpathForContainment, sanitizeFsSegmentName,
  activeChildren, steerSessionCore, stewardLaunchTurn, stewardAppendDecision, stewardBasisOf, stewardFail,
  stewardErrorDetail,
  sessions: {
    sessionDisplayTitle, updateSessionMeta, sessionDesktopToolsOf, sessionPermissionModeOf, stewardReadSessionHead,
    stewardRawKind, stewardThreadPermissionMode,
  },
  workspaces: {
    stewardKnownWorkspaces, stewardMatchKnownWorkspace, stewardSamePath, stewardWorkspaceRootFor,
  },
  policy: {
    StewardHooks, stewardMayAct, stewardMayTightenTo, stewardPermissionLabel, stewardSanitizeText,
    stewardStoppedRefusal, stewardStoppedTarget, stewardAnswerGate, stewardRelayAutoAllowed, stewardSeatedByUser,
    stewardSeatedFail, stewardUnattendedByModel, stewardUserDirected,
  },
  limits: {
    PERMISSION_MODES, STEWARD_NOTE_PREFIX, STEWARD_NOTE_TEXT_MAX, STEWARD_TITLE_MAX,
  },
});
