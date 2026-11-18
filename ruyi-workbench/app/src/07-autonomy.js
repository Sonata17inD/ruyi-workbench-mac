const { fetchOpenAiModels, probeProviderCompletion } = require('./backend/provider-probes.cjs').createProviderProbes({
  providerWireProtocol, PrivacyGateway, extractContextLength, cacheContextLength,
});

const { bridgedToolTier, dropPolicyDisabledBridgedTools } = require('./backend/bridged-tool-policy.cjs');

const {
  MEMORY_WRITE_TOOL_NAMES, policySessionFor, policyDesktopOverrideFor, toolDisabledResult, nativeToolSchema,
  nativeToolsAcceptingArgKeys, buildOpenAiTools,
} = require('./backend/provider-tool-offer.cjs').createProviderToolOffer({
  sessions: { loadSession, sessionDesktopToolsOf },
  policy: { TOOL_TIER_RANK, isStewardToolName },
});

const { loopAbortExempt, loopWarnOnly, LOOP_GUARD_LIMITS } = require('./backend/tool-loop-policy.cjs');

const {
  NATIVE_TOOL_PACKS, toolPackForName, classifyToolPacks, buildToolCatalog, searchToolCatalog,
  compareToolRetrievalShadow, listCompactTools, toolArgsSkeleton, createToolLoader,
} = require('./backend/tool-catalog.cjs');
const createToolLoadingState = createToolLoader({ logEvent });
const { classifyRuntimeToolFailure } = require('./backend/runtime-tool-telemetry.cjs');

const { createNativeToolApproval, webPayloadReason } = require('./backend/native-tool-approval.cjs');
const { httpRequestInternalTargetReason, nativeToolGate } = createNativeToolApproval({
  network: { providerBaseIsLocalOrLan },
  steward: {
    stewardAutoAskIndirect, stewardAutoAskScanIncomplete, stewardAutoAskSensitiveKind,
    stewardToolPermanentlyExempt,
  },
});

const {
  toolIsRevertible, schedulerAskWaitSessions, schedulerAskWaitOverrideMs, requestNativePermission,
  looksLikePlan, requestPlanApproval,
} = require('./backend/native-approval-waiters.cjs').createNativeApprovalWaiters({
  pending: { pendingPermissions, pendingPlans },
  interventions: {
    makeId, promptWaitMs, registerIntervention, runAutomaticInterventionDecision, settleIntervention,
  },
});

PermissionWaitHooks.scheduler = schedulerAskWaitOverrideMs;

Object.assign(ProviderWireHooks, { makeId, redact, repairProviderHistoryPairing, repairProviderHistoryToolArgs });

const {
  ACTION_VIEW_TOOLS, ACTION_VIEW_MIN_CHARS, actionTargetMeta, projectActionModelView,
} = require('./backend/provider-action-history.cjs');

let openAiStreamOnce = require('./backend/provider-stream.cjs').createProviderStream({
  providerWireProtocolForBody, PrivacyGateway, DesktopExecutionHooks, isContextOverflowError,
});

const {
  hasInterruptingSteer, drainSteerQueue, STEER_QUEUE_MAX, MAIL_QUEUE_MAX, MAIL_TEXT_MAX, MAIL_PER_SENDER_MAX,
  neutralizeInjectedPrefixes,
} = require('./backend/agent-steering.cjs').createAgentSteering({
  sessions: { VisualPipeline, buildAttachmentPrompt, nowIso, saveSession },
});

const { projectCwdDirectoryFailure } = require('./backend/project-directory-check.cjs');

const { classifyClaudeSubagentFailure, runClaudeSubAgentOnce } = require('./backend/claude-subagent.cjs').createClaudeSubagent({
  runtime: {
    DesktopExecutionHooks, PrivacyGateway, ProcessRuntime, createNdjsonLineFeeder, existsExecutableAsync,
    killChildTree, logEvent, readConfig, safeJsonParse, withTransientRetry,
  },
  cli: {
    CONTEXT_OVERFLOW_PATTERNS, buildUserEnvelope, clampAgentRoleToParent, claudePermissionMode,
    decodeClaudeCliText, detectClaudePath, effectiveAnthropicEnv, generateAgentNodeMcpConfig, parseClaudeEvent,
  },
  turn: { appendResponseLanguagePolicy, appendUsageLedger, claudeCostFields },
});
