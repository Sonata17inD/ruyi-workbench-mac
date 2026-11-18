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
  COMPACT_RESEED_TAIL_MAX_TOKENS, MANUAL_COMPACTION_SUMMARY_HEADER } = require('./backend/compaction-plan.cjs');
const { CompactionPlan, recentTurnsBoundary, recentFileReads } = createCompactionPlan({
  estimateHistoryTokens, estimateTextTokens, providerContextWindow, providerConversationContextWindow,
});

// 手动压缩「值不值得再压」的门(2026-10 用户报:压完再点一次「压缩」,转半天、结果没变 —— 实测是把 [摘要, 收到] 又交给
// 摘要模型摘一遍,前后一样大,白花一次模型调用):上次压缩之后新增的内容不到「预算 × 比例,夹在 [下限, 上限]」就不调摘要,
// 当场说明。上限是给超长窗口留的:1M 窗口按比例是 4 万,新增两三万 token 每轮都要付钱,不能说「没什么可压」。
// L1 只省下一点点(不到 max(下限, 压缩前 × 比例))也不算「压过了」,同样按这道门决定要不要走 L2。
const MANUAL_COMPACT_MIN_FRESH_TOKENS = 1500;
const MANUAL_COMPACT_MAX_FRESH_TOKENS = 8000;
const MANUAL_COMPACT_MIN_FRESH_RATIO = 0.05;
const MANUAL_COMPACT_MIN_L1_SAVED_TOKENS = 300;
const MANUAL_COMPACT_MIN_L1_SAVED_RATIO = 0.02;

// Agent CLIs cannot import an arbitrary external summary into an existing native transcript. The safe
// universal mapping is a visible reseed boundary: summarize Ruyi's complete display transcript, preserve
// it in Ruyi, then start the next native CLI session with only that summary as recovery context.
async function runAgentExternalCompact(sessionId, configOverride, trigger = 'manual', privacyBound = false) {
  const storedConfig = await readConfig(), config = configOverride || storedConfig;
  // Bind even the disabled policy before loading/formatting a transcript: a later
  // opt-in must refuse the stale request rather than scan already clipped text.
  if (!privacyBound && typeof PrivacyGateway !== 'undefined') return PrivacyGateway.withPolicy(String(sessionId || ''), () => runAgentExternalCompact(sessionId, configOverride, trigger, true));
  let session;
  try { session = await loadSession(String(sessionId || '')); } catch { return { ok: false, error: 'session not found' }; }
  if (!session) return { ok: false, error: 'session not found' };
  const resolved = resolveCompactionProvider(config, null);
  if (!resolved.provider || resolved.isDefault) return { ok: false, error: 'no external compaction model selected' };
  let compactSource = session;
  if (typeof PrivacyGateway !== 'undefined' && PrivacyGateway.active()) {
    // Display transcripts contain execution copies in toolCalls.input. Convert only
    // the leaves the compactor actually sends into canonical protocol data slots,
    // protect complete sources, then perform the original evidence caps/chunking.
    // In particular, each tool input remains a complete JSON document, so a field
    // rule such as /patientCode retains its input-root meaning before wrapping.
    const sourceRows = [], slots = [];
    for (const message of session.messages || []) {
      if (!message || !['user', 'assistant'].includes(message.role)) continue;
      const content = [{ type: 'text', text: String(message.content || '') }], slot = { attachments: [] };
      if (message.role === 'user') for (const item of Array.isArray(message.attachments) ? message.attachments : []) {
        const value = String(item && (item.path || item.name || item.filename) || '');
        if (value) { slot.attachments.push(content.length); content.push({ type: 'text', text: value }); }
      }
      if (message.role === 'assistant' && message.turnSummary && typeof message.turnSummary === 'object') {
        slot.summary = content.length; content.push({ type: 'text', text: JSON.stringify(message.turnSummary) });
      }
      const tool_calls = message.role === 'assistant' && Array.isArray(message.toolCalls) ? message.toolCalls.map((call, index) => ({
        id: 'compact-source-' + index, type: 'function', function: { name: String(call && call.name || ''), arguments: JSON.stringify(call && call.input !== undefined ? call.input : {}) },
      })) : [];
      sourceRows.push({ role: message.role, content, ...(tool_calls.length ? { tool_calls } : {}) }); slots.push(slot);
    }
    const owner = {}; PrivacyGateway.bindHostHistory(owner, sourceRows);
    const protectedRows = await PrivacyGateway.protectHostHistory(owner, sourceRows);
    compactSource = { messages: protectedRows.map((row, index) => {
      const slot = slots[index], parts = Array.isArray(row.content) ? row.content : [{ text: String(row.content || '') }];
      const next = { role: row.role, content: String(parts[0]?.text || '') };
      if (slot.attachments.length && Array.isArray(row.content)) next.attachments = slot.attachments.map(at => ({ path: String(parts[at]?.text || '') }));
      if (slot.summary !== undefined && Array.isArray(row.content)) {
        const text = String(parts[slot.summary]?.text || '');
        try { next.turnSummary = JSON.parse(text); } catch { next.turnSummary = { privacyNotice: text }; }
      }
      if (row.tool_calls) next.toolCalls = row.tool_calls.map(call => ({ name: call.function.name, input: JSON.parse(call.function.arguments) }));
      return next;
    }) };
  }
  const history = compactHistoryFromSession(compactSource);
  if (!history.length) return { ok: false, error: 'no conversation history to compact' };
  // 128b:同 runProviderCompact —— 摘要是按「此刻这段对话」算的,落盘带 expectGen;期间撤回过、或对话又长了,都不写。
  const baseGen = Number(session.rewindGen) || 0;
  const baseMessages = Array.isArray(session.messages) ? session.messages.length : 0;
  const sc = await providerSummaryCall(resolved.provider, history, { model: resolved.model, config, auxCtx: { sessionId: String(sessionId || ''), trigger: 'agent_external_manual' } });
  if (!sc.ok) return { ok: false, error: sc.error };
  recordCompactUsage(session, resolved.provider, sc);
  const beforeTokens = lastSessionContextTokens(session) || estimateHistoryTokens(history);
  const afterTokens = estimateContentTokens(sc.summary);
  const contextMeta = await agentConversationContextMeta(config, session);
  let written;
  try {
    written = await mutateSession(session.id, fresh => {
      if ((Array.isArray(fresh.messages) ? fresh.messages.length : 0) !== baseMessages) return { abort: 'history_changed' };
      fresh.agentRecoverySummary = sc.summary;
      fresh.agentRecoverySource = {
        providerId: resolved.provider.id,
        model: resolved.model,
        trigger,
        createdAt: nowIso(),
      };
      fresh.claudeSessionId = null;
      delete fresh.claudeSessionModel;
      delete fresh.claudeSessionRequestedModel;
      delete fresh.claudeSessionCwd;
      delete fresh.claudeSessionRouteKey;
      fresh.injectedIndexHash = null;
      const marker = upsertCompactMarker(fresh, {
        kind: 'external', label: `${resolved.provider.label || resolved.provider.id} / ${resolved.model} 压缩上下文`, reseeded: true,
        beforeTokens, afterTokens, note: '下一轮将基于摘要重建原生 Agent 会话。',
      });
      if (marker) marker.usage = { usage: {}, contextTokens: afterTokens, ...contextMeta, source: 'external-compact' };
      fresh.autoCompactWatermark = afterTokens; // 与 provider/kimi 路径同款滞回水位
      return undefined;
    }, { writer: 'agent_external_compact', expectGen: baseGen });
  } catch (error) {
    if (error && error.code === 'session.rewound_during_write') return { ok: false, error: error.code };
    throw error;
  }
  if (!written.session) return { ok: false, error: 'session not found' };
  if (!written.ok) return { ok: false, error: 'session.history_changed_during_compact' };
  logEvent({ kind: 'agent_external_compact', sessionId: session.id, trigger, provider: resolved.provider.id, model: resolved.model, summaryChars: sc.summary.length, beforeTokens, afterTokens });
  return { ok: true, mode: 'external-summary', provider: resolved.provider.id, model: resolved.model, summaryChars: sc.summary.length, beforeTokens, afterTokens, sessionReset: true };
}

// ── 上下文压缩的共用内核:主回合与子代理同一份判据与步骤 ─────────────────────────────────────────────────
// 修前子代理那份(第 28 波 maybeCompactSubHistory、第 45 波 45c 的强压重试)是照主回合另写的,此后主回合陆续加的几件
// 没跟过去:滞回水位(45f:估算贴着预算线抖动时每迭代白蒸发、白付一次 L2 摘要)、L1 之前的历史快照与观察缩减视图
// (105a:被蒸发的工具结果带 rawRef,模型能用 observation_recall 取回原件 —— 子代理拿得到这个工具,却从来拿不到 rawRef)、
// observation_reduced / auto_compact 日志与影子测量;强压重试那条路上,子代理蒸发时不带 config(开关全不认)、
// 事件先于结果发出(零成果也报「压缩了」)、窗口学习在重试之前就落账(主回合 45f P1-1 早改成重试成功才落)、
// L1-only 重试之后下一迭代照样白跑一次 L2(主回合 45f P2-5 早跳过了)。
// 现在两边都走下面两个内核,只在「这件事本来就该不同」的地方分叉,由调用方给:
//   预算口径(管家会话另有预算)、L2 重播种计划的 scope(子代理钉住原始 task)、快照写到哪(主回合写本会话;
//   子代理写父会话、且只写带内容哈希的那种文件名,不覆盖父回合同一回合号的安全网快照)、结果怎么装回历史
//   (主回合换数组;子代理原地 splice —— subHistory 是被 buildBody 等闭包引用的 const)、UI 压缩标记与存盘、摘要费用归属。
//
// runAutoCompaction(ctx) —— 迭代边界的两级自动压缩。ctx:
//   history                 要压缩的历史(L1 原地改;L2 不动它,重播种结果经返回值交回,由调用方装回)
//   scope                   'main' | 'subagent'(CompactionPlan 的 scope)
//   provider / model / sys / tools / config
//   budget / window         预算与窗口(调用方算好 —— 管家会话的预算不是普通那份)
//   watermark               上次成功压缩后的估算(滞回水位);缺 / 0 = 没有
//   snapshot()              async,L1 之前写历史快照,返回 rawRefPrefix('' = 不写 / 写失败)
//   onEvent / eventFields   事件出口;eventFields 并进每个 compact / observation_* 事件(子代理带 subagentId)
//   logFields               并进每条 logEvent(sessionId / turnSeq / subagentId)
//   onLevel1({ evaporated, before, after })   L1 做了事之后、写日志之前调一次(主回合在这里写 UI 压缩标记)
//   summaryAuxCtx / promptOverride / planOpts L2 摘要的台账上下文、提示词覆盖(管家)、重播种计划的额外参数
// 返回 { compacted, level: 0|1|2, before, watermark?, reseeded?, sc?, summaryProvider?, before2?, after2? }。
// 调用方负责兜 try/catch(压缩绝不阻断回合)。
// 摘要服务商(id|模型)→ 最近一次摘要失败的时刻。只给「低水位升级」这条可选路径看(见 runAutoCompaction):
// 冷却期内不为腾余量去碰一个刚失败过的摘要服务;超预算必须压的那条路照旧(由滞回水位管节奏)。
const compactionSummaryFailures = new Map();
const COMPACTION_SUMMARY_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
async function runAutoCompaction(ctx) {
  const { history, scope, provider, model, sys, tools, config, budget, window, watermark, snapshot, onEvent, eventFields = {}, logFields = {}, onLevel1, summaryAuxCtx, promptOverride, planOpts = {}, signal, scratchpadHint } = ctx;
  // 重入滞回(45f 观感/空转修复):一次成功压缩后,重新武装水位 = 压后估算 + max(2K, 2% 窗口)。
  // 实测数据里估算值贴着预算线抖动时,曾出现连续 26 次「蒸发 1 条:106K→106K」的每迭代无效循环
  // (每次快照写盘 + 全量存盘 + 追加标记,token 却没降)。水位与预算取大者,窗口放大后不阻碍再压。
  const rearmMargin = Math.max(2000, Math.round(window * 0.02));
  const wm = Number(watermark);
  const armedBudget = Number.isFinite(wm) && wm > 0 ? Math.max(budget, wm + rearmMargin) : budget;
  const sysMsg = { role: 'system', content: String(sys || '') };
  const estimate = () => calibratedEstimate(provider, model, [sysMsg, ...history], tools); // 45d(a):校准后估算判预算(含 tools 口径)
  const before = estimate();
  if (before <= armedBudget) return { compacted: false, level: 0, before }; // under budget / still in hysteresis → nothing to do

  if (config.runtimeOptimizationShadowV1 === true && config.runtimeObservationReducerV1 !== true) {
    try {
      const shadow = measureObservationReductionShadow(history);
      onEvent({ type: 'observation_reduction_shadow', source: 'runtime-shadow', ...eventFields, ...shadow });
      logEvent({ kind: 'observation_reduction_shadow', ...logFields, ...shadow });
    } catch { /* shadow evaluation must never change the compaction path */ }
  }

  // Safety-net snapshot BEFORE any mutation (non-blocking on failure).
  const rawRefPrefix = typeof snapshot === 'function' ? await snapshot() : '';

  let compacted = false;
  let lowWaterEscalation = false, sufficient = 0, l1After = 0;
  // ── Level 1: evaporate ──────────────────────────────────────────────────────────────────────────
  const evaporated = evaporateHistory(history, {
    config, rawRefPrefix,
    boundaryBudget: evaporateBudgetBoundaryEnabled(config) ? budget : 0, // 126-111a:开关是在这儿把的门
    dedupeReads: historyReadDedupEnabled(config), // 126-111e:同上,开关在调用点把门
    onReduced: meta => {
      onEvent({ type: 'observation_reduced', source: 'runtime-v1', ...eventFields, ...meta });
      logEvent({ kind: 'observation_reduced', ...logFields, ...meta });
    },
  });
  if (evaporated > 0) {
    const after1 = estimate();
    onEvent({ type: 'compact', mode: 'evaporate', ...eventFields, beforeTokens: before, afterTokens: after1 });
    if (typeof onLevel1 === 'function') onLevel1({ evaporated, before, after: after1 });
    logEvent({ kind: 'auto_compact', mode: 'evaporate', ...logFields, beforeTokens: before, afterTokens: after1, evaporated });
    compacted = true;
    // L1 够不够用另一条更低的线判(低水位 = 预算 × l1SufficientRatio,默认 60% 窗口),而不是「回到预算以下」就算:
    // L1 只把 80% 压到 78% 时,下一两个工具结果就又越线,再来一次 L1 —— 每次 L1 都改写旧消息、把服务商的前缀缓存
    // 整段作废(这一截按原价重算);修前实测过「蒸发 1 条:106K→106K」这种每次只挪一点的连发(45f 的滞回只把它从
    // 每迭代一次压到每越线一次)。压不到低水位就当场升 L2,一次腾出余量。L1 仍然先做 —— 它免费、不丢细节,
    // 多数会话里工具结果占大头,一次 L1 就能降到线下,用不着付 L2 的摘要调用。
    // 低水位按「可压部分」算:系统提示 + 工具表这块固定开销(实测 8K 上下)压不掉,小窗口下 预算×0.75 可能只比它高一点,
    // L1 永远「不够」、每次越线都被迫 L2(review 实测 16K 窗口 L2 从 12 次涨到 26 次)。所以线 = 开销 + (预算 − 开销)×比例,
    // 与 预算×比例 取大。规则里缺这个键(新产物配旧规则文件)时退回 0.75,不让 NaN 把 L1 判成永远不够。
    const ratioRaw = Number(CONTEXT_GOVERNANCE_RULES.compactionPlan.l1SufficientRatio);
    const ratio = ratioRaw > 0 && ratioRaw <= 1 ? ratioRaw : 0.75;
    const overhead = calibratedEstimate(provider, model, [sysMsg], tools);
    sufficient = Math.max(Math.floor(budget * ratio), Math.floor(overhead + Math.max(0, budget - overhead) * ratio));
    if (after1 <= sufficient) return { compacted, level: 1, before, watermark: after1 }; // level 1 was enough
    lowWaterEscalation = after1 <= budget;
    l1After = after1;
  }

  // ── Level 2: summary reseed (still over budget) ─────────────────────────────────────────────────
  const before2 = estimate();
  const compactTarget = resolveCompactionProvider(config, provider);
  const summaryProvider = compactTarget.provider || provider;
  const summaryKey = String((summaryProvider && (summaryProvider.id || summaryProvider.baseUrl)) || '') + '|' + String(compactTarget.model || (summaryProvider && summaryProvider.model) || '');
  const plan = CompactionPlan.create({ scope, trigger: 'auto', history, provider, model, config, ...planOpts });
  // 「低水位升级」= L1 已经回到预算以内、只为腾余量才升 L2(修前这里就停了)。它是优化,不是必需,所以两道闸任一不过
  // 就退回修前行为(L1 算够):
  //   ① 这个摘要服务商最近失败过 → 不为腾余量去碰它。否则摘要端点坏着时,L1 落在 低水位~预算 之间、失败后水位又低于
  //      预算(滞回挡不住),每个越线的迭代边界都白等一次摘要超时(review 实测 128K 窗口 57 次迭代 57 次失败的 L2)。
  //   ② 重播种压不到低水位以下 → 不升。重播种至少留下 plan.kept 那一截(按单元退化时最后一个单元无条件留下)再加摘要
  //      本身(按单发摘要的输出预留估),大工具结果在尾部时可能比 L1 已经压到的还大(review 实测 104.6K → 106.5K)——
  //      付了摘要的钱、作废了整段前缀缓存,还更满。
  if (lowWaterEscalation) {
    const lastFailedAt = compactionSummaryFailures.get(summaryKey) || 0;
    const reserve = Number(CONTEXT_GOVERNANCE_RULES.summary.singleShotReserve && CONTEXT_GOVERNANCE_RULES.summary.singleShotReserve.expectedOutputTokens) || 6144;
    const projected = calibratedEstimate(provider, model, [sysMsg, ...(Array.isArray(plan.kept) ? plan.kept : [])], tools) + reserve;
    if (Date.now() - lastFailedAt < COMPACTION_SUMMARY_FAILURE_COOLDOWN_MS || projected > sufficient) {
      logEvent({ kind: 'auto_compact', mode: 'low_water_skip', ...logFields, afterTokens: estimate(), projected, reason: Date.now() - lastFailedAt < COMPACTION_SUMMARY_FAILURE_COOLDOWN_MS ? 'summary_cooldown' : 'reseed_not_smaller' });
      return { compacted, level: 1, before, watermark: estimate() };
    }
  }
  // 摘要调用要几十秒到几分钟(回合在迭代边界上等它):先报 started,前端活动条与压缩指示条据此显示「压缩中」;
  // 收尾必有一条 completed(下面带 afterTokens 的那条)或 failed,不会把状态条挂在压缩态。
  // 回合已经停了:L2 一次都不发(L1 若有斩获照常算数,历史只被 L1 原地改过、配对完好)。
  if (signal && signal.aborted) return compacted ? { compacted, level: 1, before, watermark: estimate(), aborted: true } : { compacted, level: 0, before, aborted: true };
  onEvent({ type: 'compact', mode: 'summary', phase: 'started', trigger: 'auto', ...eventFields, beforeTokens: before2, contextWindow: window });
  const sc = await providerSummaryCall(summaryProvider, history, {
    model: compactTarget.model,
    privacyHistoryOwner: ctx.privacyHistoryOwner,
    config,
    auxCtx: summaryAuxCtx,
    ...(promptOverride ? { promptOverride } : {}),
    ...(signal ? { signal } : {}),
  });
  if (sc && sc.aborted) {
    // 停止取消了摘要调用:收掉「压缩中」状态条(failed + aborted),但这不是摘要服务的失败 —— 不进 10 分钟冷却
    // (compactionSummaryFailures),L1 也没斩获时不武装滞回水位(下一回合照常再压)。历史没被重播种,原样有效。
    onEvent({ type: 'compact', mode: 'summary', phase: 'failed', trigger: 'auto', ...eventFields, aborted: true, error: String(sc.error || 'cancelled') });
    logEvent({ kind: 'auto_compact', mode: 'summary', ...logFields, ok: false, aborted: true });
    return compacted ? { compacted, level: 1, before, watermark: estimate(), aborted: true } : { compacted, level: 0, before, aborted: true };
  }
  if (!sc || !sc.ok) {
    // Level-2 failed (network/timeout). Keep the level-1 result and continue — do NOT abort.
    onEvent({ type: 'compact', mode: 'summary', phase: 'failed', trigger: 'auto', ...eventFields, error: String((sc && sc.error) || 'summary failed') });
    logEvent({ kind: 'auto_compact', mode: 'summary', ...logFields, ok: false, error: sc && sc.error });
    // L1 也没斩获时同样落水位(= 这次的估算):修前不落,滞回永不武装,摘要端点坏着的时候每个迭代边界、每个回合都再
    // 白等一次摘要超时(最长几分钟)、再报一次失败。历史再涨过「水位 + 余量」才会重试。
    compactionSummaryFailures.set(summaryKey, Date.now());
    return compacted ? { compacted, level: 1, before, watermark: estimate() } : { compacted, level: 0, before, watermark: before, summaryFailed: true };
  }
  compactionSummaryFailures.delete(summaryKey);
  // 被摘要掉那段里的工具调用索引(见 buildCompactionToolIndex)。管家会话的摘要是另一套口径(promptOverride),不附。
  const indexHistory = ctx.privacyHistoryOwner && typeof PrivacyGateway !== 'undefined' ? PrivacyGateway.projectHostHistory(ctx.privacyHistoryOwner, history) : history;
  const toolIndex = promptOverride ? '' : buildCompactionToolIndex(indexHistory, { upto: plan.boundary > 0 ? plan.boundary : history.length, rawRefPrefix, config, scratchpadHint: scratchpadHint === true });
  const reseeded = CompactionPlan.reseed(plan, sc.summary, { toolIndex });
  if (ctx.privacyHistoryOwner && typeof PrivacyGateway !== 'undefined') PrivacyGateway.restoreHostHistoryProjection(ctx.privacyHistoryOwner, reseeded, true);
  // 126-111b:按单元退化保留时,切口是「非 tool 的那一条」,配对天然不会被劈开。这里仍然过一遍
  // 既有的 repairProviderHistoryPairing 当安全网 —— **它应当一条都修不到**(e2e 就是这么断言的);
  // 真修到了说明边界算错了,而修掉孤儿比让下一次请求 400 强。开关关时不调,老路逐字节不变。
  if (reseedTailUnitsEnabled(config)) { try { repairProviderHistoryPairing(reseeded); } catch { /* 安全网失手不该拖住压缩 */ } }
  const after2 = estimateHistoryTokens([sysMsg, ...reseeded], '', tools);
  // 事后兜底(闸②是事前估算):低水位升级换来的重播种实际没比 L1 小 → 丢掉它,保留 L1 的结果(历史只被 L1 原地改过,
  // 重播种还没装回去)。摘要已付费,但至少不再作废前缀缓存、不把更满的历史交出去。
  if (lowWaterEscalation && after2 >= l1After) {
    onEvent({ type: 'compact', mode: 'summary', phase: 'failed', trigger: 'auto', ...eventFields, error: 'reseed not smaller than level 1' });
    logEvent({ kind: 'auto_compact', mode: 'low_water_skip', ...logFields, afterTokens: l1After, projected: after2, reason: 'reseed_larger' });
    return { compacted, level: 1, before, watermark: l1After };
  }
  onEvent({ type: 'compact', mode: 'summary', phase: 'completed', trigger: 'auto', ...eventFields, beforeTokens: before2, afterTokens: after2 });
  logEvent({ kind: 'auto_compact', mode: 'summary', ...logFields, ok: true, beforeTokens: before2, afterTokens: after2, summaryChars: sc.summary.length });
  return { compacted: true, level: 2, before, before2, after2, watermark: after2, reseeded, sc, summaryProvider };
}

// runForcedOverflowCompaction(ctx) —— 服务端判定超窗(context 类 400)后的强压:快照 → L1 蒸发 → L2 摘要重播种,
// 由调用方重试同一次调用(每回合 / 每子回合只一次)。与自动压缩不同:没有预算判定(服务端已经说超了)、蒸发不按预算算
// 边界(evaporateHistory 头注:forced-400 属 111b 的范围,不给 boundaryBudget)、摘要直接用会话自己的服务商。ctx:
//   history / scope / provider / model / config / snapshot / onEvent / eventFields / logFields / summaryAuxCtx(同上)
//   beforeTokens / error    写进 forced_400 日志
// 返回 { level: 0|1|2, evaporated, reseeded?, sc? }:2 = 摘要重播种成功(调用方装回历史、记账、重试,重试成功才落窗口学习);
// 1 = 只有 L1 蒸发有斩获(调用方重试最后一次,并跳过下一迭代的自动压缩 —— 几秒前 L2 刚失败过);0 = 零成果(不许虚报压缩)。
async function runForcedOverflowCompaction(ctx) {
  const { history, scope, provider, model, config, snapshot, onEvent, eventFields = {}, logFields = {}, summaryAuxCtx, beforeTokens, error, signal, scratchpadHint } = ctx;
  logEvent({ kind: 'auto_compact', mode: 'forced_400', ...logFields, beforeTokens, error: String(error || '').slice(0, 200) });
  if (config.runtimeOptimizationShadowV1 === true && config.runtimeObservationReducerV1 !== true) {
    try {
      const shadow = measureObservationReductionShadow(history);
      onEvent({ type: 'observation_reduction_shadow', source: 'runtime-shadow', mode: 'forced_400', ...eventFields, ...shadow });
      logEvent({ kind: 'observation_reduction_shadow', mode: 'forced_400', ...logFields, ...shadow });
    } catch { /* shadow evaluation must never block forced compaction */ }
  }
  // 强压同样要等一次摘要调用:先报 started;level 1/2 由调用方重试前发 completed(带 afterTokens),零成果在这里发 failed。
  onEvent({ type: 'compact', mode: 'forced_400', phase: 'started', trigger: 'forced_400', ...eventFields, beforeTokens });
  const rawRefPrefix = typeof snapshot === 'function' ? await snapshot() : '';
  const evaporated = evaporateHistory(history, {
    config, rawRefPrefix,
    onReduced: meta => {
      onEvent({ type: 'observation_reduced', source: 'runtime-v1', ...eventFields, ...meta });
      logEvent({ kind: 'observation_reduced', ...logFields, ...meta });
    },
  });
  const sc = (signal && signal.aborted) ? { ok: false, aborted: true, error: 'summary request cancelled (turn stopped)' }
    : await providerSummaryCall(provider, history, { config, privacyHistoryOwner: ctx.privacyHistoryOwner, auxCtx: summaryAuxCtx, ...(signal ? { signal } : {}) });
  if (sc && sc.aborted) {
    // 停止取消了强压的摘要:收掉状态条;返回 aborted,调用方不重试(回合已停)。L1 的原地蒸发保留(配对完好)。
    onEvent({ type: 'compact', mode: 'forced_400', phase: 'failed', trigger: 'forced_400', ...eventFields, aborted: true, error: String(sc.error || 'cancelled') });
    return { level: evaporated > 0 ? 1 : 0, evaporated, aborted: true };
  }
  if (sc && sc.ok) {
    const plan = CompactionPlan.create({ scope, trigger: 'forced_400', history, provider, model, config, ...(scope === 'main' ? { conversationWindow: true } : {}) });
    const indexHistory = ctx.privacyHistoryOwner && typeof PrivacyGateway !== 'undefined' ? PrivacyGateway.projectHostHistory(ctx.privacyHistoryOwner, history) : history;
    const toolIndex = buildCompactionToolIndex(indexHistory, { upto: plan.boundary > 0 ? plan.boundary : history.length, rawRefPrefix, config, scratchpadHint: scratchpadHint === true });
    const reseeded = CompactionPlan.reseed(plan, sc.summary, { toolIndex });
    if (ctx.privacyHistoryOwner && typeof PrivacyGateway !== 'undefined') PrivacyGateway.restoreHostHistoryProjection(ctx.privacyHistoryOwner, reseeded, true);
    return { level: 2, evaporated, reseeded, sc };
  }
  if (evaporated <= 0) onEvent({ type: 'compact', mode: 'forced_400', phase: 'failed', trigger: 'forced_400', ...eventFields, error: String((sc && sc.error) || 'nothing to compact') });
  return { level: evaporated > 0 ? 1 : 0, evaporated };
}

// 子代理回合的两级自动压缩(第 28 波 §28a;现与主回合共用 runAutoCompaction)。返回是否压缩过;never throw(压缩绝不阻断子回合)。
// 【关键实现坑】subHistory 是 runSubAgentCore 里的 const,被 buildBody/markUsage/finalizer 闭包引用 —— L2 重播种必须【原地
// splice】替换内容,绝不能重新赋值(否则闭包仍指旧数组,压缩对已发请求体静默失效)。evaporate 本就原地改 content,天然安全。
// 【子代理专属】主回合无固定目标,子代理有单一 task(subHistory[0])—— L2 重播种【钉住 task[0]】(CompactionPlan 的
// subagent scope 把它并进摘要 user 消息),防摘要吞掉原始目标后跑偏。
// state:runSubAgentCore 持有的 { watermark } —— 滞回水位跨迭代留在子回合里(子代理没有会话头可存)。
// signal:子回合的中止信号(runSubAgentCoreBody 的 ctrl.signal)。与主回合 maybeAutoCompact 同一条线:Stop 当场取消在飞的
// L2 摘要调用,runAutoCompaction 走 aborted 那一支 —— 不进 10 分钟摘要失败冷却(compactionSummaryFailures)、不武装滞回
// 水位、不重播种(历史只可能被 L1 原地蒸发过,配对完好)。修前子代理这一处没接信号,停止要干等摘要调用返回。
async function maybeCompactSubHistory(opts) {
  const { subHistory, sys, provider, subModel, config, onEvent, subagentId, parentSession, tools, runId, state, signal } = opts || {};
  try {
    if (!Array.isArray(subHistory) || subHistory.length < 3 || !provider) return false;
    const budgetPlan = CompactionPlan.create({ scope: 'subagent', trigger: 'auto', history: subHistory, provider, model: subModel, config });
    const parentId = parentSession && parentSession.id ? String(parentSession.id) : '';
    const r = await runAutoCompaction({
      history: subHistory, privacyHistoryOwner: opts.privacyHistoryOwner, scope: 'subagent', provider, model: subModel, sys, tools, config,
      budget: budgetPlan.budget, window: budgetPlan.window, watermark: state && state.watermark,
      // 快照写进父会话的 checkpoints,但只写带内容哈希的文件名(观察缩减开着时才用得上 rawRef):不带哈希的
      // history-<回合>.json.gz 是父回合同一回合号的安全网快照,子代理不许覆盖它。
      snapshot: () => (parentId && config.runtimeObservationReducerV1 === true
        ? writeHistorySnapshot(parentId, parentSession.turnSeq, subHistory, true).catch(() => '')
        : ''),
      onEvent: typeof onEvent === 'function' ? e => { try { onEvent(e); } catch { /* stream gone */ } } : () => {},
      eventFields: { subagentId },
      logFields: { ...(parentId ? { sessionId: parentId } : {}), ...(parentSession && parentSession.turnSeq != null ? { turnSeq: Number(parentSession.turnSeq) } : {}), ...(subagentId ? { subagentId: String(subagentId) } : {}) },
      summaryAuxCtx: { ...(parentId ? { sessionId: parentId } : {}), ...(subagentId ? { subagentId: String(subagentId) } : {}), trigger: 'subturn_auto_L2' },
      ...(signal ? { signal } : {}),
    });
    if (r.level === 2) {
      subHistory.splice(0, subHistory.length, ...r.reseeded);           // 原地 splice(const 绑定,闭包安全)——绝不重新赋值
      try { if (parentSession) recordCompactUsage(parentSession, r.summaryProvider, r.sc, { subagentId, runId }); } catch { /* 记账失败不阻断 */ }
    }
    if ((r.compacted || r.summaryFailed) && state && Number.isFinite(Number(r.watermark))) state.watermark = r.watermark;
    return r.compacted;
  } catch { return false; }
}

// §5.2 (v0.7b) / v0.8-S5: server-side manual context compaction for a native (OpenAI-compatible) provider
// session (上下文条「立即压缩」/ provider 会话的 /compact)。Guarded by same-origin (mutating) upstream; NOT in needsToken.
// 2026-10(用户报「手动触发似乎直接触发 L2」+ 本机 agent 的回捞评估):修前一步到 L2 —— 整份历史交给摘要模型、塌成
// [摘要, 收到],不写快照,被摘要掉的工具原文从此够不着(rawRef 一个都没有),L1 能免费省下的那部分也白付一次摘要调用。
// 现在与自动压缩同一套顺序:
//   0. 先写历史快照(观察缩减开着时带内容哈希,rawRef 才能校验)—— 后路,不改任何默认行为;
//   1. L1 蒸发 / 缩减旧工具结果(免费、不丢细节:原件经 rawRef 可用 observation_recall 取回)。mode 不是 'summary' 且
//      L1 已经把估算压到低水位以下(预算 × compactionPlan.l1SufficientRatio,与自动压缩同一个比例)→ 到此为止,不调摘要;
//   2. 不够、L1 无事可做、或调用方明确要 mode:'summary' → L2 摘要。仍塌成 [摘要, 收到](手动压缩的既有语义,不留尾巴),
//      摘要后附被摘要掉那段的工具调用索引(buildCompactionToolIndex,能回捞的带 rawRef)。
//   但历史已经以压缩摘要开头、L1 没省下多少、且摘要之后新增的内容不到门槛(MANUAL_COMPACT_MIN_FRESH_*)时不调摘要
//   → level:0,会话不动,界面说「刚压缩过,暂时没有值得再压的」(修前:摘要完再点,把摘要又摘一遍,转半天、前后一样大)。
// 全程在历史的副本上做;任何失败都不动会话。返回 { ok, level: 0|1|2, ... };never throws。
// 手动压缩没有「这一回合」的系统提示与工具表(回合里它们随 runOpenAiTurn 现算),但判「L1 够不够」要和自动压缩同一条线 —— 那条线是按
// 【系统提示 + 工具表 + 历史】整体估的。这里按会话落盘的冻结工具名(session.toolSchemaNames,没有就是内置工具全集)+ 稳定系统提示重建一份近似:
// 少算的只有易变层(项目记忆 / 技能索引)与桥接 MCP 工具,偏小的方向;重建失败回落空(= 退回只看历史,不比修前更糟)。
function manualCompactPromptShape(session, provider, model, config) {
  try {
    const cwd = String((session && session.cwd) || (config && config.defaultWorkspace) || '');   // 只进系统提示文字,不必规整(省一条 10→03 的回环边)
    const own = buildOpenAiTools(config, null, { skillsEnabled: false, desktopOverride: sessionDesktopToolsOf(session), ...(session && session.kind === 'steward' ? { stewardSession: true } : { scratchpadEnabled: true }) });
    const frozen = session && Array.isArray(session.toolSchemaNames) && session.toolSchemaNames.length ? new Set(session.toolSchemaNames) : null;
    const tools = frozen ? own.filter(t => t && t.function && frozen.has(t.function.name)) : own;
    return { sys: String(buildStableSystemPrompt(provider, model, cwd, tools, false, config) || ''), tools };
  } catch { return { sys: '', tools: [] }; }
}
async function runProviderCompact(sessionId, opts = {}) {
  const storedConfig = await readConfig();
  if (typeof PrivacyGateway !== 'undefined' && PrivacyGateway.enabled(storedConfig) && !PrivacyGateway.active()) return PrivacyGateway.run(String(sessionId), storedConfig, () => runProviderCompact(sessionId, opts));
  let session;
  try { session = await loadSession(String(sessionId || '')); }
  catch { return { ok: false, error: 'session not found' }; }
  if (!session) return { ok: false, error: 'session not found' };
  const config = configForSessionEngineRoute(storedConfig, session);
  const provider = activeOpenAiProvider(config);
  if (!provider) return { ok: false, error: 'active engine is not an OpenAI-compatible provider' };
  const compactTarget = resolveCompactionProvider(config, provider);
  const summaryProvider = compactTarget.provider || provider;
  const history = Array.isArray(session.providerHistory) ? session.providerHistory : [];
  if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.bindHostHistory(session, history);
  if (typeof PrivacyGateway !== 'undefined' && !PrivacyGateway.enabled(storedConfig) && session.privacyHistoryV1 === true) {
    const restored = await PrivacyGateway.restoreHistory(session.id, { providerHistory: history }, true);
    PrivacyGateway.bindRestoredHostHistory(session, history, restored.providerHistory);
  }
  if (!history.length) return { ok: false, error: 'no provider history to compact' };
  const mode = opts && opts.mode === 'summary' ? 'summary' : 'auto';
  // 128b:摘要要调数秒的模型。算之前记下撤回代数,落盘带 expectGen —— 期间撤回过就不写(撤回之前的历史算出来的
  // 摘要绝不写回撤回之后的会话);期间有回合追加过历史(长度变了)也不写,否则那几条会被这份摘要整段盖掉。
  const baseGen = Number(session.rewindGen) || 0;
  const baseLength = history.length;
  // L1 原地改消息的 content:在浅拷贝的副本上做,落盘时整份换上(失败 / 放弃时会话一个字节不动)。
  const hostHistory = typeof PrivacyGateway !== 'undefined' ? PrivacyGateway.projectHostHistory(session, history) : history;
  const work = hostHistory.map(m => (m && typeof m === 'object' ? { ...m } : m));
  const rawRefPrefix = sessionObjectIsStale(session) ? ''
    : await writeHistorySnapshot(session.id, session.turnSeq, history, config.runtimeObservationReducerV1 === true).catch(() => '');
  const model = String(provider.model || '');
  const budgetPlan = CompactionPlan.create({ scope: 'main', trigger: 'manual', history: work, provider, model, config, conversationWindow: true });
  const beforeTokens = estimateHistoryTokens(work);
  const evaporated = evaporateHistory(work, {
    config, rawRefPrefix,
    boundaryBudget: evaporateBudgetBoundaryEnabled(config) ? budgetPlan.budget : 0,
    dedupeReads: historyReadDedupEnabled(config),
  });
  const afterL1 = estimateHistoryTokens(work);   // 回给界面 / 标记的数字仍是历史本身(与修前同口径)
  // 「L1 够了」的线与自动压缩(runAutoCompaction)逐字同一条公式:线 = max(预算×比例, 开销 + (预算−开销)×比例),被比的是
  // 【系统提示 + 工具表 + 历史】的校准估算(开销 = 系统提示 + 工具表)。修前只拿历史对 预算×比例:窗口小 / 工具表大时历史还远没到线,
  // 加上固定开销早已超预算,手动压缩却报「够了」、下一次发送自动压缩立刻又上 L2。
  const ratioRaw = Number(CONTEXT_GOVERNANCE_RULES.compactionPlan.l1SufficientRatio);
  const ratio = ratioRaw > 0 && ratioRaw <= 1 ? ratioRaw : 0.75;
  const promptShape = manualCompactPromptShape(session, provider, model, config);
  const sysMsg = { role: 'system', content: promptShape.sys };
  const l1Total = calibratedEstimate(provider, model, [sysMsg, ...work], promptShape.tools);
  const overhead = calibratedEstimate(provider, model, [sysMsg], promptShape.tools);
  const sufficient = Math.max(Math.floor(budgetPlan.budget * ratio), Math.floor(overhead + Math.max(0, budgetPlan.budget - overhead) * ratio));
  // L1 的前提是「免费、不丢细节」:被折叠的原件要能经 observation_recall 取回。快照没写成 / 回捞没开(reducer 或 recall 关着)时 L1 是有损的
  // 蒸发,不能当「已压缩、原文可回捞」收尾(界面的 L1 提示就是这么说的)—— 退到 L2 摘要。
  const recoverable = Boolean(rawRefPrefix) && observationRecallEnabled(config);
  const contextUsage = afterTokens => ({
    usage: {}, contextTokens: afterTokens, contextWindow: providerConversationContextWindow(config, provider, provider.model),
    contextEngine: 'openai', contextProviderId: provider.id, contextModel: model, source: 'provider-compact',
  });
  const persist = async (apply) => {
    let written;
    try {
      written = await mutateSession(session.id, fresh => {
        if (!Array.isArray(fresh.providerHistory) || fresh.providerHistory.length !== baseLength) return { abort: 'history_changed' };
        apply(fresh);
        return undefined;
      }, { writer: 'provider_compact', expectGen: baseGen });
    } catch (error) {
      if (error && error.code === 'session.rewound_during_write') return { ok: false, error: error.code };
      throw error;
    }
    if (!written.session) return { ok: false, error: 'session not found' };
    if (!written.ok) {
      logEvent({ kind: 'provider_compact', sessionId: session.id, ok: false, error: 'history_changed', baseLength });
      return { ok: false, error: 'session.history_changed_during_compact' };
    }
    return { ok: true, session: written.session };
  };

  // L1 真省下了东西才算「做了事」;只折了一两条小输出(省下的不到门槛)按没做处理,下面再决定要不要摘要。
  const l1Saved = beforeTokens - afterL1;
  const l1Meaningful = evaporated > 0 && l1Saved >= Math.max(MANUAL_COMPACT_MIN_L1_SAVED_TOKENS, Math.floor(beforeTokens * MANUAL_COMPACT_MIN_L1_SAVED_RATIO));
  if (mode !== 'summary' && l1Meaningful && recoverable && l1Total <= sufficient) {
    const saved = await persist(fresh => {
      fresh.providerHistory = work;
      const marker = upsertCompactMarker(fresh, { kind: 'provider-manual', label: '已压缩上下文', evaporated, saved: beforeTokens - afterL1, beforeTokens, afterTokens: afterL1 });
      if (marker) marker.usage = contextUsage(afterL1);
      fresh.autoCompactWatermark = afterL1; // 手动压缩后同样进入滞回期
    });
    if (!saved.ok) return saved;
    logEvent({ kind: 'provider_compact', sessionId: session.id, level: 1, evaporated, beforeTokens, afterTokens: afterL1 });
    return { ok: true, level: 1, evaporated, beforeTokens, afterTokens: afterL1, recoverable };
  }

  // 走 L2 之前先看值不值得:上次压缩(摘要那一对)之后新增的内容太少 —— 刚摘要完又点一次、或摘要后只聊了几句 —— 再摘要一遍
  // 只会把摘要又摘一遍,前后差不多大,还要白等一次模型调用。不调摘要、会话一个字节不动,回 level:0 让界面说清楚。
  // 调用方明确要 mode:'summary' 时照旧摘要(接口留着「强制重摘要」这条路)。
  const sinceSummary = compactionSummaryPairEnd(history);
  const freshTokens = estimateHistoryTokens(work.slice(sinceSummary));
  const minFresh = Math.min(MANUAL_COMPACT_MAX_FRESH_TOKENS, Math.max(MANUAL_COMPACT_MIN_FRESH_TOKENS, Math.floor(budgetPlan.budget * MANUAL_COMPACT_MIN_FRESH_RATIO)));
  // 只管「已经摘要过」的历史:从没压缩过的会话,手动压缩照旧可以把它摘成 [摘要, 收到](L1 之后紧接着再点一次就是这条 ——
  // 那一次是真压缩,不是空转)。
  if (mode !== 'summary' && sinceSummary > 0 && !l1Meaningful && freshTokens < minFresh) {
    logEvent({ kind: 'provider_compact', sessionId: session.id, level: 0, reason: 'nothing_since_summary', freshTokens, minFresh, beforeTokens });
    return { ok: true, level: 0, nothingToCompact: true, freshTokens, beforeTokens, afterTokens: beforeTokens, evaporated: 0 };
  }

  if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.bindHostHistory(session, work);
  const sc = await providerSummaryCall(summaryProvider, work, { model: compactTarget.model, config, privacyHistoryOwner: session });
  if (!sc.ok) {
    logEvent({ kind: 'provider_compact', sessionId: session.id, ok: false, provider: summaryProvider.id, model: compactTarget.model, error: sc.error });
    return { ok: false, error: sc.error };
  }
  const summary = sc.summary;
  recordCompactUsage(session, summaryProvider, sc); // v1.4-OSS 用量看板(补): 手动压缩调用入 aux 台账(钱已经花了,照记)
  const indexHistory = typeof PrivacyGateway !== 'undefined' ? PrivacyGateway.projectHostHistory(session, work) : work;
  const toolIndex = buildCompactionToolIndex(indexHistory, { upto: work.length, rawRefPrefix, config, scratchpadHint: session.kind !== 'steward' });

  let afterTokens = 0;
  const saved = await persist(fresh => {
    fresh.providerHistory = [
      { role: 'user', content: MANUAL_COMPACTION_SUMMARY_HEADER + summary + (toolIndex ? '\n\n' + toolIndex : '') },
      { role: 'assistant', content: '收到，已基于摘要继续。' },
    ];
    afterTokens = estimateHistoryTokens(fresh.providerHistory);
    const marker = upsertCompactMarker(fresh, { kind: 'provider-manual', label: '已压缩上下文', evaporated, reseeded: true, beforeTokens, afterTokens });
    if (marker) marker.usage = contextUsage(afterTokens);
    fresh.autoCompactWatermark = afterTokens; // 手动压缩后同样进入滞回期
    fresh.providerHistoryCursor = fresh.messages.length;
  });
  if (!saved.ok) return saved;
  await maybeWriteSessionNotes(saved.session, summary, config); // Notes are ready before a following turn starts.
  logEvent({ kind: 'provider_compact', sessionId: session.id, level: 2, provider: summaryProvider.id, model: compactTarget.model, summaryChars: summary.length, evaporated, toolIndexChars: toolIndex.length, beforeTokens, afterTokens });
  return { ok: true, level: 2, provider: summaryProvider.id, model: compactTarget.model, summaryChars: summary.length, evaporated, beforeTokens, afterTokens };
}

// v0.8-S5 AUTO-COMPACTION driver (§7.7). Called at each provider-turn iteration boundary, BEFORE the next
// API call. If est([system, ...providerHistory]) exceeds threshold × contextWindow, run the two levels:
//   0. snapshot providerHistory → history-<turnSeq>.json.gz (safety net, non-blocking)
//   1. EVAPORATE old tool results → re-estimate → if still over →
//   2. SUMMARY RESEED (shared kernel): [summary-user, ack-assistant] + the last 2 full turns verbatim.
//      Level-2 failure (network/timeout) keeps the level-1 result and does NOT abort the turn.
// For each level that fires: emit a `compact` event {mode, beforeTokens, afterTokens} and upsert ONE merged
// 🗜 system row into session.messages (upsertCompactMarker; repeated levels merge into the same open row). Mutates
// session.providerHistory / session.messages in place; the caller persists via its normal saveSession.
// Returns true if any compaction happened (caller may save immediately). Never throws.
async function maybeAutoCompact(session, provider, sys, config, onEvent, model, tools, signal) {
  try {
    const history = session.providerHistory;
    if (!Array.isArray(history) || !history.length) return false;
    const budgetPlan = CompactionPlan.create({ scope: 'main', trigger: 'auto', history, provider, model, config, conversationWindow: true });
    const window = budgetPlan.window;
    // 116f(27 号文 §11.2 预算):管家会话的预算 = min(stewardContextBudgetTokens, 该模型 conversationWindow)
    // 的 60%,与普通会话的 autoCompactThreshold×窗口 是两套口径。经 06i 的 StewardHooks 延迟绑定拿
    // (10 → 06i 是后向边);钩子未填充/返回非正数时回落普通预算,压缩行为与本切片之前逐字节一致。
    let stewardBudget = 0;
    if (session && session.kind === 'steward' && typeof StewardHooks.contextBudget === 'function') {
      try { stewardBudget = Number(StewardHooks.contextBudget(session, config, window)) || 0; } catch { stewardBudget = 0; }
    }
    const budget = stewardBudget > 0 ? stewardBudget : budgetPlan.budget;
    const r = await runAutoCompaction({
      history, privacyHistoryOwner: session, scope: 'main', provider, model, sys, tools, config, budget, window, watermark: session.autoCompactWatermark,
      // 128b:撤回之前读出来的那份(垂死回合)不写快照 —— 快照按回合号落名,撤回之后的会话迟早会再走到同一个回合号。
      snapshot: () => (sessionObjectIsStale(session) ? '' : writeHistorySnapshot(session.id, session.turnSeq, history, config.runtimeObservationReducerV1 === true)),
      onEvent, logFields: { sessionId: session.id, turnSeq: session.turnSeq },
      onLevel1: ({ evaporated, before, after }) => upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', evaporated, saved: before - after, beforeTokens: before, afterTokens: after }),
      summaryAuxCtx: { sessionId: session.id, turnSeq: session.turnSeq, trigger: 'auto_L2' },
      // 116f(§11.2):管家会话的 L2 摘要 prompt 换成 06b 的 steward.visitNotes(只留「已做的决定 /
      // 递出去的话 / 未完成事项」三节)。普通会话不传,摘要内核逐字节走原路径。
      promptOverride: stewardBudget > 0 && typeof StewardHooks.visitNotesPrompt === 'function' ? String(StewardHooks.visitNotesPrompt(config) || '') : '',
      // 116f: 重播种计划与判预算用同一个预算口径(管家的尾预算不能按普通会话那份大预算算,否则压完仍旧超管家自己的线)。
      planOpts: { conversationWindow: true, ...(stewardBudget > 0 ? { budgetOverride: stewardBudget } : {}) },
      // 回合的停止信号:Stop 当场取消在飞的 L2 摘要调用(见 runAutoCompaction)。
      ...(signal ? { signal } : {}),
      // 草稿本只发给普通会话的主回合(C2):摘要后的工具索引多一句「要原样留着的写进草稿本」。
      scratchpadHint: !(session && session.kind === 'steward'),
    });
    if (r.level === 2) {
      recordCompactUsage(session, r.summaryProvider, r.sc); // v1.4-OSS 用量看板(补): 自动压缩(L2 摘要)调用入 aux 台账
      await maybeWriteSessionNotes(session, r.sc.summary, config);
      session.providerHistory = r.reseeded;
      upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', reseeded: true, beforeTokens: r.before2, afterTokens: r.after2 });
    }
    if (r.compacted) { session.autoCompactWatermark = r.watermark; await saveSession(session, { dropIfTurnSuperseded: true, writer: 'auto-compact' }).catch(() => {}); }
    else if (r.summaryFailed && Number.isFinite(Number(r.watermark))) session.autoCompactWatermark = r.watermark; // 随回合收尾的正常存盘落下
    return r.compacted;
  } catch (e) {
    // Compaction is best-effort; a failure must never break the turn.
    try { logEvent({ kind: 'auto_compact', sessionId: session && session.id, ok: false, error: (e && e.message) || String(e) }); } catch { /* ignore */ }
    return false;
  }
}
