const { gitExec, createAgentWorktree, finalizeAgentWorktree, applyAgentWorktree, cleanupAgentWorktree, cleanupAgentWorktreeForRetry } = require('./backend/agent-worktrees.cjs').createAgentWorktrees({
  paths, runGit, safeSessionId, nowIso, agentRunFile, saveAgentRun,
});

const { runSubAgent, runSubAgentCore } = require('./backend/subagent-runner.cjs').createSubagentRunner({
  logEvent, makeId, neutralizeInjectedPrefixes, normalizeCwd, nowIso,
  providers: {
    applyProviderReasoningEffort, cachedInputTokensFromUsage, computeProviderCost, isContextOverflowError,
    openAiStreamOnce, providerCallIsTransient, providerServerSearchCard, providerWireProtocol,
    withTransientRetry, runClaudeSubAgentOnce,
  },
  context: {
    appendResponseLanguagePolicy, buildProviderSystemPrompt, estimateBucketsEnabled, estimateContentTokens,
    estimateFactor: (...args) => estimateFactor(...args), estimateHistoryTokens,
    noteWindowOvershoot: (...args) => noteWindowOvershoot(...args), providerHistoryToolCalls,
    setEstimateBucketsV1, writeHistorySnapshot,
  },
  compaction: {
    maybeCompactSubHistory: (...args) => SessionCompaction.maybeCompactSubHistory(...args),
    recordCompactUsage: (...args) => recordCompactUsage(...args),
    runForcedOverflowCompaction: (...args) => runForcedOverflowCompaction(...args),
  },
  usage: { appendUsageLedger },
  memory: { MEMORY_WRITE_TOOL_NAMES, SubAgentMemoryHooks, readProjectMemory },
  tools: {
    LOOP_GUARD_LIMITS, TOOL_ITERATION_BUDGETS, TOOL_TIER_RANK, boundToolResultForDisplay, buildOpenAiTools,
    classifyToolPacks, isProviderToolArgsObject, loopAbortExempt, loopWarnOnly, nativeToolTier,
    providerWireOutputLimited, resolveToolIterationBudget, shouldExtendToolIterationBudget,
    toolCall: (...args) => toolCall(...args), toolFailureResult: (...args) => toolFailureResult(...args),
    toolPackForName, truncateToolResult,
  },
  bridge: {
    bridgedOfficeScriptGate, bridgedReadPathGate, bridgedServerUnavailableMessage, bridgedToolTier,
    bridgedWriteRelativePathArg, collectBridgedTools, dropPolicyDisabledBridgedTools, getBridgedClient,
    journalBridgedWrite, resolveBridge,
  },
  permissions: {
    clampAgentRoleToParent, liveSessionPermissionMode, nativeToolGate, pendingPermissions, permissionWaitMs,
    preflightWriteBoundary, requestNativePermission, runAutomaticInterventionDecision, sessionDesktopToolsOf,
    stewardAutoAskReason, toolDisabledByPolicy, toolDisabledResult, webPayloadReason,
  },
  resources: { acquireResourceLease, inferToolResources, normalizeAgentResources, releaseResourceLease },
  services: { DesktopExecutionHooks, PrivacyGateway, VisualPipeline, getCapabilities },
});

const { sanitizeAgentOutputSchema, structuredJsonCandidates, balancedJsonSpan, repairJson, parseStructuredAgentOutput, validateAgentJsonSchema, normalizeAgentGate, verdictPasses, structuredOfNode, aggregateAgentVote, findingHandledItems, aggregateCoverage, propagateAssignments, dedupeAgentFindings, EVIDENCE_REFS_MAX_ITEMS, QUALITY_GATE_OUTPUT_SCHEMA } = require('./backend/agent-quality.cjs');

const { evalWaitCondition } = require('./backend/workflow-wait.cjs').createWorkflowWait({
  guardWorkspacePath, httpGetGuarded, ssrfCheck,
});

const {
  agentRunCapabilities, agentRunRoster, materializePoolItem, nodeDeliveryEligibility, poolChainDepth,
} = require('./backend/agent-run-pool.cjs').createAgentRunPool({
  EventStreamHooks, MAIL_QUEUE_MAX, TOOL_TIER_RANK, activeAgentRuns, neutralizeInjectedPrefixes,
  normalizeAgentResources, resolveNodeModel,
});

const {
  agentEnvelopeArtifacts, agentRunResultSlice, buildAgentRunEnvelope, cutAtSentence, ownAgentMessageReceipt,
  readAgentRunRecord,
} = require('./backend/agent-run-envelope.cjs').createAgentRunEnvelope({
  EventStreamHooks, activeAgentRuns, agentRunCapabilities, agentRunFile, safeJsonParse, safeSessionId,
});

const {
  resolveAgentTeamRoute, orchestrateArgsProblem, orchestrateModelNotes, resolveOrchestrateFollowup,
  resolveOrchestrateNodes, singleAgentShorthandNode,
} = require('./backend/agent-workflow-input.cjs').createAgentWorkflowInput({
  neutralizeInjectedPrefixes, samePathKey,
  routing: { fetchOpenAiModels, providerBaseWithV1, resolveProvider },
  workflows: { agentEnvelopeArtifacts, getAgentWorkflows, readAgentRunRecord },
});

const {
  NODE_WRITE_FAMILY, deriveNodeOutputs, evaluateNodeToolEvidence, evaluateWorkflowCondition,
  workflowProgressFingerprint,
} = require('./backend/workflow-node-outcomes.cjs').createWorkflowNodeOutcomes();

const { runWorkspaceHash, workflowDependencyClosure, buildNodeEvidenceCatalog, formatNodeEvidencePrompt, indexNodeEvidence, purgeNodeEvidence, verifyNodeClaims } = require('./backend/agent-evidence.cjs').createAgentEvidence({ redact, nowIso });

const {
  buildUpstreamContext, summarizeAgentWorkflowRun, recordAgentNodeProgress,
} = require('./backend/agent-workflow-report.cjs').createAgentWorkflowReport({
  appendAgentRunEvent, estimateContentTokens, nowIso,
});

const { computeSchedulerStep, computeWaveSeq } = require('./backend/workflow-scheduler.cjs');
