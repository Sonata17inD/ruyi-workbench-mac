'use strict';

const CONTEXT_GOVERNANCE_RULES = require('./context-governance-rules.json');
const { buildCompactionToolIndex } = require('./compaction-plan.cjs');
const { resolveCompactionProvider } = require('./compaction-routing.cjs');
const { evaporateBudgetBoundaryEnabled, historyReadDedupEnabled, reseedTailUnitsEnabled } = require('./runtime-policy.cjs');

const COMPACTION_SUMMARY_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

function l1SufficientTokens(budget, overhead) {
  const raw = Number(CONTEXT_GOVERNANCE_RULES.compactionPlan.l1SufficientRatio);
  const ratio = raw > 0 && raw <= 1 ? raw : 0.75;
  return Math.max(Math.floor(budget * ratio), Math.floor(overhead + Math.max(0, budget - overhead) * ratio));
}

// Run compaction over the supplied history. The caller owns session and usage commits.
function createCompactionKernel({
  CompactionPlan, estimateHistoryTokens, calibratedEstimate, evaporateHistory, measureObservationReductionShadow,
  providerSummaryCall, repairProviderHistoryPairing, PrivacyGateway, logEvent, summaryFailures = new Map(),
}) {
  // 摘要服务商(id|模型)→ 最近一次摘要失败的时刻。只给「低水位升级」这条可选路径看(见 runAutoCompaction):
  // 冷却期内不为腾余量去碰一个刚失败过的摘要服务;超预算必须压的那条路照旧(由滞回水位管节奏)。
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
      const overhead = calibratedEstimate(provider, model, [sysMsg], tools);
      sufficient = l1SufficientTokens(budget, overhead);
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
      const lastFailedAt = summaryFailures.get(summaryKey) || 0;
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
      summaryFailures.set(summaryKey, Date.now());
      return compacted ? { compacted, level: 1, before, watermark: estimate() } : { compacted, level: 0, before, watermark: before, summaryFailed: true };
    }
    summaryFailures.delete(summaryKey);
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

  return { runAutoCompaction, runForcedOverflowCompaction };
}

module.exports = { createCompactionKernel, l1SufficientTokens };
