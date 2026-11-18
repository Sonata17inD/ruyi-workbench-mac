const CONTEXT_GOVERNANCE_RULES = require('./backend/context-governance-rules.json');
if (CONTEXT_GOVERNANCE_RULES.schema !== 1) throw new Error('unsupported context-governance-rules schema');
const { COMPACTION_TOOL_INDEX_HEADER, historyUnitStarts } = require('./backend/provider-history.cjs');
const { providerContextWindow, noteEstimateSample, estimateFactor, noteWindowOvershoot, learnedWindowCap, calibratedEstimate } =
  require('./backend/context-calibration.cjs').createContextCalibration({
    DurableJsonStore, dataDirectory: () => paths.data, logEvent, nowIso, estimateHistoryTokens, resolveContextWindow,
  });
const {
  buildObservationRecallPrompt, evaporateBudgetBoundary, fileReadDedupKey, dedupeRepeatedReads,
  evaporateHistory, measureObservationReductionShadow, reduceObservationContent,
} = require('./backend/observation-reduction.cjs').createObservationReduction({ estimateHistoryTokens });
const { createCompactionRefetchGuard, compactionRefetchRefusal, compactionRefetchWarning } = require('./backend/compaction-refetch.cjs');

const { SUMMARY_PROMPT, SUMMARY_PROMPT_EN, summaryPromptWithGuidance,
  summarySectionLocations, validateStructuredSummary } = require('./backend/summary-format.cjs');

const { extractSummaryEntities, checkSummaryEntities, buildSummaryFactTableMessages,
  summaryTaskSourceHistory, extractSummaryTaskEvidence } = require('./backend/summary-evidence.cjs');
const { createProviderSummary, buildSummaryRefineMessages, summaryMaxConcurrent, mapSummaryWithLimit } =
  require('./backend/provider-summary.cjs');
const { providerSummaryCall, fitHistoryForSummary, chunkHistoryByBudget,
  summarySingleShotCap, summarySingleShotReserveTokens, resolveSummaryCallPolicy } = createProviderSummary({
  providerWireProtocol, normalizeProviderApiStyle, providerBaseWithV1,
  resolveContextWindow, providerContextWindow, fetchOpenAiModels, isContextOverflowError,
  estimateHistoryTokens, estimateTextTokens, PrivacyGateway, DesktopExecutionHooks, readConfig, logEvent,
});

const { createCompactionRouting, resolveCompactionProvider, lastSessionContextTokens,
  contextWindowOverrideKey, configuredConversationWindow } = require('./backend/compaction-routing.cjs');
const { compactHistoryFromSession, providerConversationContextWindow, agentNodeContextWindow, agentConversationContextMeta } =
  createCompactionRouting({ resolveContextWindow, providerContextWindow, PrivacyGateway, agentCliContextWindowProbes: AGENT_CLI_CONTEXT_WINDOW_PROBES });
const { createCompactionRecords, COMPACT_MARKER_MIN_SAVED_TOKENS } = require('./backend/compaction-records.cjs');
const { recordCompactUsage, openCompactMarker, upsertCompactMarker } = createCompactionRecords({
  estimateContentTokens, fmtTokensServer, appendUsageLedger, nowIso,
});
const { createCompactionPlan, compactionTaskText, buildCompactionToolIndex,
  COMPACT_RESEED_TAIL_MAX_TOKENS } = require('./backend/compaction-plan.cjs');
const { CompactionPlan, recentTurnsBoundary, recentFileReads } = createCompactionPlan({
  estimateHistoryTokens, estimateTextTokens, providerContextWindow, providerConversationContextWindow,
});

const CompactionKernel = require('./backend/compaction-kernel.cjs').createCompactionKernel({
  CompactionPlan, estimateHistoryTokens, calibratedEstimate, evaporateHistory, measureObservationReductionShadow,
  providerSummaryCall, repairProviderHistoryPairing, PrivacyGateway, logEvent,
});
const { runForcedOverflowCompaction } = CompactionKernel;
const SessionCompaction = require('./backend/session-compaction.cjs').createSessionCompaction({
  kernel: CompactionKernel, CompactionPlan, estimateHistoryTokens, estimateContentTokens, calibratedEstimate, evaporateHistory,
  readConfig, configForSessionEngineRoute, loadSession, saveSession, mutateSession, sessionObjectIsStale, writeHistorySnapshot,
  providerSummaryCall, providerConversationContextWindow, agentConversationContextMeta, compactHistoryFromSession,
  buildOpenAiTools, buildStableSystemPrompt, sessionDesktopToolsOf,
  recordCompactUsage, upsertCompactMarker, maybeWriteSessionNotes, PrivacyGateway, StewardHooks, logEvent, nowIso,
});
const { runAgentExternalCompact, runProviderCompact, maybeAutoCompact } = SessionCompaction;
