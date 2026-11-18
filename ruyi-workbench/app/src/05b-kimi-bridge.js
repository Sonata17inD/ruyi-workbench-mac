// Kimi Code integration. Turns use the official ACP JSON-RPC/NDJSON protocol; the local Server API remains
// operation-scoped for native compaction, and the documented wire transcript supplements ACP's usage update
// with exact compaction/failure state. A separate ACP process is kept for the whole Ruyi turn so reverse RPC
// (permissions/questions) and queued follow-up steering share one live native Kimi session.
const { classifyKimiAcpReadonlySearch, KIMI_ACP_SEARCH_BLOCKED_ENV_RE } =
  require('./backend/kimi-search-policy.cjs').createKimiSearchPolicy({
    dataRoot, appRoot, pathWithinRoot, fileAllowedRoots, realpathForContainment, isSensitiveDataPath, guardFileToolPath,
  });
const buildKimiAcpPromptParts = require('./backend/kimi-prompt-parts.cjs').createKimiPromptParts({
  guardFileToolPath, realpathForContainment,
});


const { createKimiAcpRpc: createAcpRpc } = require('./backend/kimi-acp-rpc.cjs');
const {
  kimiAcpSessionRestoreMethods, kimiAcpUnknownSessionError, kimiAcpModeOptionFromActivated, kimiAcpFreshActualForOperation,
} = require('./backend/kimi-acp-session.cjs');
const { parseKimiWireCompaction, parseKimiWireAgentEvents, watchKimiWire } = require('./backend/kimi-wire.cjs');

const { createKimiAcpInterventions, kimiAcpSamePath } = require('./backend/kimi-acp-interventions.cjs');
const KimiAcpInterventions = createKimiAcpInterventions({
  dataRoot, fileAllowedRoots, workspaceWriteRoots, guardFileToolPath, realpathForContainment,
  makeId, requestNativePermission: (...args) => requestNativePermission(...args), requestUserQuestion,
  permissionWaitMs, runAutomaticInterventionDecision, buildOpenSpawn, spawnDetachedChecked, process,
});
const {
  kimiAcpInferConcreteToolInput, kimiAcpPermissionToolCall, handleKimiAcpPermissionRequest, consumeKimiAcpApproval,
  kimiAcpSuccessfulEnterPlanMode, kimiAcpNativeShellQuote, kimiAcpNativeBashWrapperTexts, kimiAcpNativeBashWrapperCandidate,
  ensureKimiAcpOperationPermission,
} = KimiAcpInterventions;
const KimiAcpFiles = require('./backend/kimi-acp-files.cjs').createKimiAcpFiles({
  realpathForContainment, kimiAcpSamePath, guardFileToolPath, ensureKimiAcpOperationPermission,
  toolCall: (...args) => toolCall(...args), normalizeTodoItems,
});
const { isKimiAcpPlanFilePath, resolveKimiAcpPlanFilePath } = KimiAcpFiles;
const KimiAcpTerminals = require('./backend/kimi-acp-terminals.cjs').createKimiAcpTerminals({
  classifyKimiAcpReadonlySearch, KIMI_ACP_SEARCH_BLOCKED_ENV_RE, guardWorkspaceExecute,
  ensureKimiAcpOperationPermission, kimiAcpNativeBashWrapperCandidate, ProcessRuntime, killChildTree, makeId,
});
const { handleKimiAcpTerminalRequest, cleanupKimiAcpTerminals, killKimiAcpTerminal } = KimiAcpTerminals;

function createKimiAcpRpc(child, handlers) {
  return createAcpRpc(child, handlers, () => PrivacyGateway.assertCliAllowed());
}

const {
  syncKimiTurnPreferences, kimiSessionStatus, kimiUsageFromStatus, applyKimiStatusToSession, kimiStatusFingerprint,
  syncKimiSessionUsage, runKimiCompact,
} = require('./backend/kimi-native-operations.cjs').createKimiNativeOperations({
  selectedAgentCli, agentCliLauncherUsable, prepareAgentCliSpawn, ProcessRuntime, killChildTree, PrivacyGateway,
  readConfig, loadSession, mutateSession, kimiContextWindow, nowIso, logEvent, process,
  runAgentExternalCompact: (...args) => runAgentExternalCompact(...args),
  upsertCompactMarker: (...args) => upsertCompactMarker(...args),
});

const { runKimiAcpTurnPrepared, prepareKimiAcpSpawn } = require('./backend/kimi-acp-turn.cjs').createKimiAcpTurn({
  paths, dataRoot, runtime: RUNTIME, externalRoot, process,
  files: KimiAcpFiles, terminals: KimiAcpTerminals, interventions: KimiAcpInterventions,
  createKimiAcpRpc, prepareAgentCliSpawn, syncMcpServersToKimi, buildKimiAcpPromptParts, syncKimiSessionUsage,
  processRuntime: { ProcessRuntime, killChildTree, assertSessionExecutionOwner, registerSessionExecutionChild, activeChildren, stopSession },
  sessions: { readConfig, loadSession, saveSession, saveTurnFinalSession, isUntitledSessionTitle },
  permissions: { permissionWaitMs, clearPendingPermissions, clearPendingQuestions, clearPendingPlans, hasPendingPermissionForSession },
  journal: { captureWorkspaceTurnBaseline, reconcileWorkspaceTurnBaseline, journalReadIndex },
  mission: { bumpMissionChangeSeq, finalizeMissionAfterTurn, mergeMissionBeforeSave },
  hooks: { AgentLoopHooks, PrivacyGateway, RUYI_EVENTS, logEvent, nowIso, cwdWarning },
});

async function replaceSessionObject(target, fresh) {
  if (!target || !fresh) return;
  for (const key of Object.keys(target)) if (!Object.prototype.hasOwnProperty.call(fresh, key)) delete target[key];
  Object.assign(target, fresh);
}

// hunt2-engines#7:Agent CLI 回合前自动压缩的滞回与失败退避。修前每个回合都会重判、重试:Kimi 原生压缩坏了时
// 每回合开头都要白等最多 3 分钟(compactKimiNative 的轮询上限),外部摘要模型坏了时每回合都再烧一次摘要调用。
//   ① 成功后:runKimiCompact / runAgentExternalCompact 已把压后实测写进 session.autoCompactWatermark,这里照 10
//      runAutoCompaction 的口径把触发线抬到 max(阈值线, 水位 + max(2K, 2% 窗口)) —— 两路引擎同一种滞回。
//   ② 失败后:只在内存里记「哪条会话、在多少 token 时、何时失败」(不进会话头:它是运行时退避,重启即清零合理);
//      冷却期内且上下文没有再涨过一个重武装余量,就不再尝试。
const AGENT_AUTO_COMPACT_FAIL_COOLDOWN_MS = 10 * 60 * 1000;
const agentAutoCompactFailures = new Map();   // sessionId -> { at, tokens }
function agentAutoCompactTrigger(session, threshold, limit) {
  const base = threshold * limit;
  const rearmMargin = Math.max(2000, Math.round(limit * 0.02));
  const wm = Number(session && session.autoCompactWatermark);
  return { trigger: Number.isFinite(wm) && wm > 0 ? Math.max(base, wm + rearmMargin) : base, rearmMargin };
}
function agentAutoCompactBackingOff(sessionId, used, rearmMargin) {
  const failed = agentAutoCompactFailures.get(String(sessionId || ''));
  if (!failed) return false;
  if (Date.now() - failed.at >= AGENT_AUTO_COMPACT_FAIL_COOLDOWN_MS || used >= failed.tokens + rearmMargin) {
    agentAutoCompactFailures.delete(String(sessionId || ''));
    return false;
  }
  return true;
}
function noteAgentAutoCompactFailure(sessionId, used) {
  agentAutoCompactFailures.set(String(sessionId || ''), { at: Date.now(), tokens: Number(used) || 0 });
  while (agentAutoCompactFailures.size > 500) agentAutoCompactFailures.delete(agentAutoCompactFailures.keys().next().value);
}

// Called before an Agent CLI turn. A CLI with a native status surface (adapter.contextStatus; Kimi) uses its
// authoritative status; Claude can opt into an external model and uses the latest measured CLI usage. The
// default Claude path remains Claude's own auto-compact.
// 架构还债批 4:第三个参数由 CLI 类型名改成该 CLI 的适配器(05 runClaudeTurn 传入;05b 不反向引用 05 的符号)。
async function maybeAutoCompactAgentSession(session, config, cliAdapter, onEvent) {
  const nativeStatus = cliAdapter.contextStatus;
  const nativeCompact = cliAdapter.nativeCompact;
  try {
    const threshold = Number(config.autoCompactThreshold) || 0.8;
    if (config.compactProviderId) {
      let used = lastSessionContextTokens(session);
      const contextMeta = await agentConversationContextMeta({ ...config, agentCliType: cliAdapter.id }, session);
      let limit = contextMeta.contextWindow;
      if (nativeStatus && session.claudeSessionId) {
        const status = await nativeStatus.read(config, session);
        if (status.ok) {
          used = status.contextTokens;
          if (contextMeta.contextWindowSource !== 'manual' && status.contextWindow > 0) limit = status.contextWindow;
          nativeStatus.apply(session, status);
        }
      }
      const armed = limit > 0 ? agentAutoCompactTrigger(session, threshold, limit) : null;
      if (used > 0 && armed && used >= armed.trigger && !agentAutoCompactBackingOff(session.id, used, armed.rearmMargin)) {
        onEvent({ type: 'compact', mode: 'external-summary', phase: 'started', trigger: 'auto', beforeTokens: used, contextWindow: limit });
        const result = await runAgentExternalCompact(session.id, config, 'auto');
        if (!result.ok) {
          noteAgentAutoCompactFailure(session.id, used);
          onEvent({ type: 'compact', mode: 'external-summary', phase: 'failed', error: result.error });
          return false;
        }
        agentAutoCompactFailures.delete(String(session.id));
        const fresh = await loadSession(session.id);
        await replaceSessionObject(session, fresh);
        onEvent({ type: 'compact', mode: 'external-summary', phase: 'completed', trigger: 'auto', beforeTokens: result.beforeTokens, afterTokens: result.afterTokens });
        return true;
      }
      return false;
    }
    if (!nativeStatus || !nativeCompact || !session.claudeSessionId) return false;
    const status = await nativeStatus.read(config, session);
    if (!status.ok) return false;
    nativeStatus.apply(session, status);
    onEvent({ type: 'usage', ...nativeStatus.usage(status) });
    const armed = status.contextWindow > 0 ? agentAutoCompactTrigger(session, threshold, status.contextWindow) : null;
    if (armed && status.contextTokens >= armed.trigger && !agentAutoCompactBackingOff(session.id, status.contextTokens, armed.rearmMargin)) {
      const result = await nativeCompact.run(session.id, config, 'auto', onEvent);
      if (!result.ok) {
        noteAgentAutoCompactFailure(session.id, status.contextTokens);
        onEvent({ type: 'compact', mode: nativeCompact.mode, phase: 'failed', error: result.error });
        return false;
      }
      agentAutoCompactFailures.delete(String(session.id));
      const fresh = await loadSession(session.id);
      await replaceSessionObject(session, fresh);
      return true;
    }
    return false;
  } catch (error) {
    try { onEvent({ type: 'compact', mode: nativeCompact ? nativeCompact.mode : 'external-summary', phase: 'failed', error: (error && error.message) || String(error) }); } catch { /* ignore */ }
    return false;
  }
}
