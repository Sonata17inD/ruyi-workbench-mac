const {
  stewardImplAuditTail, stewardImplHealth, stewardImplMissions, stewardImplPlaybooks,
  stewardImplProviders, stewardImplRunsStatus, stewardImplSelfStatus, stewardImplSkills, stewardImplUsage,
} = require('./backend/steward-status-tools.cjs').createStewardStatusTools({
  safeSessionId, redact, buildWorkbenchSelfStatus, collectAudit, computeHealth,
  stewardInboxState,
  runs: { activeAgentRuns, listAgentRuns, missionRunDigest },
  projection: { getPretenderProjectionIndex, buildMissionAggregateRows },
  usage: { forEachUsageRow, usageDayKey, usageDayKeyMemo },
  catalog: { loadSkillRegistry, listPlaybooksWithAvailability },
  threads: { stewardRawKind, stewardReadSessionHead, stewardKnownWorkspaces, stewardWorkspaceNameOf },
  rules: { stewardClampInt, stewardFail, stewardSanitizeText, stewardStateLabel },
  limits: {
    STEWARD_AUDIT_LIMIT_DEFAULT, STEWARD_AUDIT_LIMIT_MAX, STEWARD_RUNS_MAX, STEWARD_MISSIONS_LIMIT_DEFAULT,
    STEWARD_MISSIONS_LIMIT_MAX, STEWARD_CATALOG_DESC_CHARS, STEWARD_CATALOG_ROWS,
  },
});

const {
  stewardDecideAttempted, stewardImplDecide, stewardImplRunAction, stewardReadRunSnapshot,
  stewardRunResumeTier,
} = require('./backend/steward-decision-tools.cjs').createStewardDecisionTools({
  makeId, safeJsonParse, safeSessionId, stewardAppendDecision, stewardBasisOf, stewardFail,
  runs: { AgentRecovery, agentRunActionCommand, agentRunFile },
  sessions: {
    decideIntervention, readInterventions, stewardReadSessionHead, stewardRawKind,
    stewardThreadPermissionMode, threadOriginOf,
  },
  admission: {
    stewardMayAct, stewardPermissionLabel, stewardPermissionRank, stewardSeatedByUser, stewardSeatedFail,
    stewardStoppedRefusal, stewardStoppedTarget, stewardTurnTaintedBy, stewardUserDirected,
    stewardWatchedThread, stewardSanitizeText,
  },
  pending: {
    stewardExemptDelegatedLog, stewardExemptLiveTurn, stewardExemptPendingSummary,
    stewardLiveTurnPermissionMode,
  },
  exemptions: {
    stewardExemptDelegationRecord, stewardExemptDelegationVerdict, stewardExemptDelegationsInWindow,
    stewardExemptHits, stewardExemptReason, stewardExemptRiskNote, stewardExemptScanInput,
  },
  guardrails: {
    httpRequestInternalTargetReason, stewardAutoAskIndirect, stewardAutoAskScanIncomplete,
    stewardAutoAskSensitiveKind, webPayloadReason,
  },
  limits: { STEWARD_EXEMPT_CATEGORY_LABELS, STEWARD_STEER_TEXT_MAX },
});

const {
  stewardImplMemorySearch, stewardImplMemoryVeto, stewardImplMemoryWrite, stewardQuoteInSource,
  stewardSourceUserTexts,
} = require('./backend/steward-memory-tools.cjs').createStewardMemoryTools({
  loadSession, makeId, nowIso, safeSessionId, stewardAppendDecision, stewardClampInt, stewardFail,
  stewardSanitizeText,
  memory: {
    cleanMemoryDate, memoryIsExpired, memoryProposalLooksSensitive, stewardMemoryScopeMatches,
    stewardMemoryScopeOf, stewardMemoryTerms, stewardMutateMemory, stewardNormalizeMemoryScope,
    stewardReadMemoryStore, stewardTermJaccard,
  },
  evidence: { isStewardToolName, stewardToolCallLine, stewardToolCallVerdict },
  limits: { STEWARD_MEMORY_KINDS, STEWARD_MEMORY_LIMITS, STEWARD_MEMORY_MERGED_FROM_MAX },
});

const {
  stewardImplFileRead, stewardImplThreadArtifactRead, stewardImplWebFetch, stewardImplWebSearch,
} = require('./backend/steward-external-read-tools.cjs').createStewardExternalReadTools({
  TOOL_HANDLERS, safeSessionId, stewardClampInt, stewardFail, stewardSanitizeBlock, stewardSanitizeText,
  privacy: { privacySourceMark, sourceViewOf, stewardMarkTurnTainted, webPayloadReason },
  threads: { stewardReadBucket, stewardReadSessionHead, stewardThreadArtifactFiles, stewardTurnKeyOf },
  workspaces: { pathWithinRoot, realpathForContainment, stewardSamePath, stewardWorkspaceRootFor },
  network: { webFetch, webSearch },
  limits: { STEWARD_EYES_CHARS, STEWARD_READ_CALLS_PER_TURN },
});

const { stewardImplNotify } = require('./backend/steward-notification-tool.cjs').createStewardNotificationTool({
  RUYI_EVENTS, safeSessionId, stewardAppendDecision, stewardClampInt, stewardFail, stewardReadSessionHead,
  stewardSanitizeText, stewardSeatedByUser,
  quota: { stewardNotifiesInWindow, stewardNotifyRecord },
  limits: { STEWARD_NOTIFY_KINDS, STEWARD_NOTIFY_TEXT_CHARS },
});

const {
  stewardImplConfigGet, stewardImplConfigSet,
} = require('./backend/steward-settings-tools.cjs').createStewardSettingsTools({
  safeSessionId, stewardAppendDecision, stewardBasisOf, stewardFail, stewardPermissionLabel,
  configPolicy: {
    ConfigPatchHooks, KEY_MASK_PREFIX, PERMISSION_MODES_REQUIRING_CONFIRM, maskProviders,
    maskedSecretConflictMessage, maskedSecretConflicts, normalizeConfig, stewardConfigHelpFor,
    stewardConfigTierFor, unmaskSecrets,
  },
  evidence: { stewardQuoteInSource, stewardSourceUserTexts },
  privacy: { PrivacyCore },
});

const {
  stewardImplPlaybookDraft, stewardImplSkillToggle,
} = require('./backend/steward-content-tools.cjs').createStewardContentTools({
  draftPlaybookFromSession, playbookReuseSources, setSessionSkillsCore, safeSessionId, stewardAppendDecision,
  stewardBasisOf, stewardFail,
  threads: { stewardRawKind, stewardReadSessionHead, stewardThreadPermissionMode },
  quota: { stewardTurnQuotaRefund, stewardTurnQuotaTake },
  limits: { STEWARD_PLAYBOOK_DRAFTS_PER_TURN, STEWARD_SESSION_ID },
});
