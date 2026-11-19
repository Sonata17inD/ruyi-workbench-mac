const { proposeReplanPatch, recordNodeContinuation, validateReplanPatch, applyReplanPatch } = require('./backend/replan-ledger.cjs').createReplanLedger({
  hashArgs, makeId, nowIso, TOOL_TIER_RANK,
});

// 子代理核心胶囊的实现(口住 00-boot 的 SubAgentMemoryHooks,理由见那里)。只取【核心】:relevance 压到 0,相关召回是按主线那句话排的,
// 子任务是另一件事,顺带也让 preflight 不给没注入的条目记 use。走 parentSession:会话级排除 / 固定选择 / 关闭记忆同样管着子代理。
Object.assign(SubAgentMemoryHooks, {
  async coreSnapshot({ parentSession, workingDir, task, config }) {
    const preflight = await resolveMemoryPreflight(parentSession, workingDir, String(task || ''), undefined, { ...config, memoryRelevanceMaxV1: 0 }, {});
    const entries = Array.isArray(preflight.coreEntries) ? preflight.coreEntries : [];
    return { entries, conflicts: entries.length ? await buildMemoryConflictMap(workingDir).catch(() => null) : null };
  },
});

const agentWorkflowPorts = {
  activeAgentRuns, sessionSaveIsTombstoned, safeSessionId, makeId, nowIso,
  runs: AgentRunStore,
  worktrees: { createAgentWorktree, finalizeAgentWorktree, cleanupAgentWorktree, cleanupAgentWorktreeForRetry },
  roles: {
    agentNodeContextWindow: (...args) => agentNodeContextWindow(...args),
    getAgentRoleLibrary, resolveAgentTeamRoute, resolveNodeModel,
  },
  memory: {
    buildMemoryCheckPrompt, buildMemoryConflictMap, buildMemoryPromptSection, extractMemoryRelationProposals,
    filterMemoryForNativeCli, proposeMemoryRelation, resolveMemoryPreflight,
  },
  evidence: { formatNodeEvidencePrompt, indexNodeEvidence, purgeNodeEvidence, verifyNodeClaims },
  nodes: {
    buildUpstreamContext, deriveNodeOutputs, evalWaitCondition, evaluateNodeToolEvidence, evaluateWorkflowCondition,
    recordAgentNodeProgress, repairNodeJsonViaProvider, runSubAgent, summarizeAgentWorkflowRun, workflowProgressFingerprint,
  },
  team: {
    agentRunRoster, materializePoolItem, nodeDeliveryEligibility, ownAgentMessageReceipt, poolChainDepth,
    MAIL_PER_SENDER_MAX, MAIL_QUEUE_MAX, MAIL_TEXT_MAX,
  },
  replan: { proposeReplanPatch, recordNodeContinuation, validateReplanPatch },
  resources: { normalizeAgentResources, remapAgentResources },
  interventions: { registerIntervention, settleIntervention },
  hooks: { DesktopExecutionHooks, EventStreamHooks },
};
const AgentWorkflow = require('./backend/agent-workflow.cjs').createAgentWorkflow(agentWorkflowPorts);
function runAgentWorkflow(options) { return AgentWorkflow.runAgentWorkflow(options); }

const AgentResults = require('./backend/agent-results.cjs').createAgentResults({
  records: { readAgentRunRecord, buildAgentRunEnvelope },
  delivery: {
    pendingAgentMessages: (...args) => EventStreamHooks.pendingAgentMessages?.(...args),
    isAgentEnvelopeDelivered: (...args) => EventStreamHooks.isAgentEnvelopeDelivered?.(...args),
    markAgentEnvelopeDelivered: (...args) => EventStreamHooks.markAgentEnvelopeDelivered?.(...args),
    notifyAgentRunEnvelope: (...args) => EventStreamHooks.notifyAgentRunEnvelope?.(...args),
  },
  subscribe: listener => RUYI_EVENTS.subscribe(listener), safeSessionId, logEvent,
});
const { AGENT_RUN_TERMINAL, WAIT_AGENTS_DEFAULT_MS, WAIT_AGENTS_MAX_MS } = AgentResults;
function waitAgentsMaxMs(...args) { return AgentResults.waitAgentsMaxMs(...args); }
function resolveWaitAgentsMs(...args) { return AgentResults.resolveWaitAgentsMs(...args); }
function waitForAgentRunResults(...args) { return AgentResults.waitForAgentRunResults(...args); }
function settleWaitEnvelopes(...args) { return AgentResults.settleWaitEnvelopes(...args); }
function deliverAgentRunEnvelope(...args) { return AgentResults.deliverAgentRunEnvelope(...args); }

const { legacySpawnToOrchestrateArgs, LEGACY_SPAWN_NOTE } = require('./backend/agent-workflow.cjs');

const launchPersistedAgentRun = require('./backend/persisted-agent-launch.cjs').createPersistedAgentLaunch({
  activeAgentRuns, activeChildren, agentRunFile, safeJsonParse, nowIso, readConfig,
  loadSession, mutateSession, runs: AgentRunStore, EventStreamHooks,
  runAgentWorkflow: options => runAgentWorkflow(options), deliverAgentRunEnvelope,
});

const ToolPolicy = require('./backend/tool-policy.cjs').createToolPolicy({
  TOOL_TIER_RANK, resolveBridge, bridgedToolTier, nativeToolTier,
});
function unwrapProxiedControlCall(...args) { return ToolPolicy.unwrapProxiedControlCall(...args); }
function canonicalToolInvokeCall(...args) { return ToolPolicy.canonicalToolInvokeCall(...args); }
function retierToolInvokeCall(...args) { return ToolPolicy.retierToolInvokeCall(...args); }
function planDiscoveryToolBatchAllowed(...args) { return ToolPolicy.planDiscoveryToolBatchAllowed(...args); }
function planParallelReadIsland(...args) { return ToolPolicy.planParallelReadIsland(...args); }

const runOpenAiTurn = require('./backend/provider-turn.cjs').createProviderTurn({
  appendUsageLedger, cwdWarning, isStewardToolName, logEvent, makeId, nowIso, readConfig, safeSessionId,
  session: {
    loadSession, saveSession, saveTurnFinalSession, sessionDesktopToolsOf, isUntitledSessionTitle,
    normalizeTodoItems, liveSessionPermissionMode,
  },
  history: {
    providerHistoryToolCalls, isProviderToolArgsObject, repairProviderHistoryPairing,
    repairProviderHistoryToolArgs, syncProviderHistoryFromDisplay, writeHistorySnapshot,
  },
  ownership: {
    activeChildren, assertSessionExecutionOwner, registerSessionExecutionChild, appendLiveTail,
    installActiveChildEventFanout, stopSession, drainSteerQueue, hasInterruptingSteer,
  },
  provider: {
    openAiStreamOnce: (...args) => openAiStreamOnce(...args),
    withTransientRetry, providerCallIsTransient,
    isContextOverflowError, providerWireProtocol, applyProviderReasoningEffort,
    providerServerSearchCard, providerWireContentFiltered, providerWireContextExceeded,
    providerWireOutputLimited,
  },
  prompts: {
    buildStableSystemPrompt, buildVolatileParts, buildModelHint, getAgentRoleLibrary, getAgentWorkflows,
    getCapabilities, resolveEnabledSkillEntries, loadAllPlaybooks, localTurnTimeParts,
  },
  memory: {
    MemoryStore, buildMemoryConflictMap, buildMemoryTurnSection, memoryExclusionSet, memoryIsExpired,
    memorySelectionSignature, readConfirmedSupersedeEdges, resolveMemoryPreflight, readSessionNotes,
    maybeWriteSessionNotes, readSessionScratchpad,
  },
  compaction: {
    setEstimateBucketsV1, estimateContentTokens, estimateHistoryTokens, estimateToolSchemaTokens,
    providerContextWindow: (...args) => providerContextWindow(...args),
    estimateFactor: (...args) => estimateFactor(...args),
    noteEstimateSample: (...args) => noteEstimateSample(...args),
    noteWindowOvershoot: (...args) => noteWindowOvershoot(...args),
    buildObservationRecallPrompt: (...args) => buildObservationRecallPrompt(...args),
    maybeAutoCompact: (...args) => maybeAutoCompact(...args),
    runForcedOverflowCompaction: (...args) => runForcedOverflowCompaction(...args),
    recordCompactUsage: (...args) => recordCompactUsage(...args),
    upsertCompactMarker: (...args) => upsertCompactMarker(...args),
  },
  permissions: {
    clearPendingPermissions, clearPendingPlans, clearPendingQuestions, hasPendingPermissionForSession,
    hasPendingQuestionForSession, looksLikePlan, permissionWaitMs, requestNativePermission,
    requestPlanApproval, requestUserQuestion, nativeToolGate, consumeGrant,
  },
  tools: {
    buildOpenAiTools, compareToolRetrievalShadow, createToolLoadingState, nativeToolTier,
    canonicalToolInvokeCall, planDiscoveryToolBatchAllowed, planParallelReadIsland, retierToolInvokeCall,
    unwrapProxiedControlCall, toolDisabledResult, classifyRuntimeToolFailure, acquireResourceLease,
    inferToolResources, releaseResourceLease, LOOP_GUARD_LIMITS, loopAbortExempt, loopWarnOnly,
    ACTION_VIEW_MIN_CHARS, ACTION_VIEW_TOOLS, actionTargetMeta, projectActionModelView,
    boundToolResultForDisplay, webPayloadReason,
    validateNativeToolArgs: (...args) => validateNativeToolArgs(...args),
    toolCall: (...args) => toolCall(...args),
    toolFailureResult: (...args) => toolFailureResult(...args),
  },
  bridge: {
    bridgedOfficeScriptGate, bridgedReadPathGate, bridgedServerUnavailableMessage, bridgedToolTier,
    dropPolicyDisabledBridgedTools, resolveBridge,
    collectBridgedTools: (...args) => collectBridgedTools(...args),
    getBridgedClient: (...args) => getBridgedClient(...args),
  },
  agents: {
    activeAgentRuns, AGENT_RUN_TERMINAL, agentRunCapabilities, agentRunResultSlice, agentRunRoster,
    buildAgentRunEnvelope, deliverAgentRunEnvelope, LEGACY_SPAWN_NOTE, legacySpawnToOrchestrateArgs,
    MAIL_PER_SENDER_MAX, MAIL_TEXT_MAX, orchestrateArgsProblem, orchestrateModelNotes,
    ownAgentMessageReceipt, readAgentRunRecord, resolveOrchestrateFollowup, resolveOrchestrateNodes,
    resolveWaitAgentsMs, saveAgentRun, settleWaitEnvelopes, waitForAgentRunResults,
    runAgentWorkflow: (...args) => runAgentWorkflow(...args),
  },
  missions: {
    applyMissionUpdate, bumpMissionChangeSeq, finalizeMissionAfterTurn, mergeMissionBeforeSave,
    recordMissionBudgetTrippedChange, recordMissionStalledChange, normalizeMetaToolArgs,
  },
  checkpoints: {
    captureWorkspaceTurnBaseline, reconcileWorkspaceTurnBaseline, journalReadIndex, journalRevertNoticesAck,
    journalRevertNoticesPeek, preflightWriteBoundary,
    journalBridgedWrite: (...args) => journalBridgedWrite(...args),
  },
  hooks: {
    AgentLoopHooks, DeliveryHooks, DesktopExecutionHooks, EventStreamHooks, PrivacyGateway, StewardHooks,
    VisualPipeline, RUYI_EVENTS,
  },
});
