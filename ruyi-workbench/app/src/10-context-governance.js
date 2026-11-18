const CONTEXT_GOVERNANCE_RULES = require('./backend/context-governance-rules.json');
if (CONTEXT_GOVERNANCE_RULES.schema !== 1) throw new Error('unsupported context-governance-rules schema');
const { EVAPORATED_PREFIX, READ_DEDUP_PREFIX, COMPACTION_TOOL_INDEX_HEADER } = require('./backend/provider-history.cjs');
const { providerContextWindow, noteEstimateSample, estimateFactor, noteWindowOvershoot, learnedWindowCap, calibratedEstimate } =
  require('./backend/context-calibration.cjs').createContextCalibration({
    DurableJsonStore, dataDirectory: () => paths.data, logEvent, nowIso, estimateHistoryTokens, resolveContextWindow,
  });
const {
  buildObservationRecallPrompt, historyUnitStarts, evaporateBudgetBoundary, fileReadDedupKey, dedupeRepeatedReads,
  evaporateHistory, measureObservationReductionShadow, reduceObservationContent,
} = require('./backend/observation-reduction.cjs').createObservationReduction({ estimateHistoryTokens });
const { createCompactionRefetchGuard, compactionRefetchRefusal, compactionRefetchWarning } = require('./backend/compaction-refetch.cjs');

// L2 重播种保留的近期原文上限。它是绝对上限而非「保留最近 N 回合」：两回合可能只有几百
// token，也可能夹着几十 K 的工具结果。调用点还会钳到当次压缩预算的一半，避免小窗口被尾部反撑爆。
// 只保留完整 user 回合；若最新一整回合本身放不下，宁可交给结构化摘要，也绝不从 tool_call/tool_result
// 组中间切开，避免把协议历史重播成孤儿。
const COMPACT_RESEED_TAIL_MAX_TOKENS = CONTEXT_GOVERNANCE_RULES.summary.reseedTailMaxTokens;
const { SUMMARY_PROMPT, SUMMARY_PROMPT_EN, summaryPromptWithGuidance,
  summarySectionLocations, validateStructuredSummary } = require('./backend/summary-format.cjs');

const { extractSummaryEntities, checkSummaryEntities, buildSummaryFactTableMessages,
  summaryTaskSourceHistory, extractSummaryTaskEvidence } = require('./backend/summary-evidence.cjs');
const { createProviderSummary, userBlockStarts, buildSummaryRefineMessages, summaryMaxConcurrent, mapSummaryWithLimit } =
  require('./backend/provider-summary.cjs');
const { providerSummaryCall, fitHistoryForSummary, chunkHistoryByBudget,
  summarySingleShotCap, summarySingleShotReserveTokens, resolveSummaryCallPolicy } = createProviderSummary({
  providerWireProtocol, normalizeProviderApiStyle, providerBaseWithV1,
  resolveContextWindow, providerContextWindow, fetchOpenAiModels, isContextOverflowError,
  estimateHistoryTokens, estimateTextTokens, PrivacyGateway, DesktopExecutionHooks, readConfig, logEvent,
});

// v1.4-OSS 用量看板(补): record a compaction summary call as an 'aux' ledger row (kind:'aux', note:'compact').
// Tokens from the response usage (prompt/completion, with input/output aliases); when the endpoint omits usage
// they are ESTIMATED from the sent payload + the returned summary and flagged estimated:true. Both compact call
// sites (manual runProviderCompact + auto maybeAutoCompact level-2) route through here. Fully defensive.
function recordCompactUsage(session, provider, sc, attribution) {
  try {
    if (!session || !provider || !sc || !sc.ok) return;
    // 代理模式 v2:子代理压缩的 aux 行带 subagentId/runId 归属(仍计入会话总费用,但看板可区分主线与代理)。
    const attr = attribution && typeof attribution === 'object' ? attribution : null;
    let inTok = 0, outTok = 0, estimated = false;
    const u = sc.usage;
    const uIn = u ? (Number(u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens) || 0) : 0;
    const uOut = u ? (Number(u.completion_tokens != null ? u.completion_tokens : u.output_tokens) || 0) : 0;
    if (uIn > 0 || uOut > 0) {
      // 45f 对抗轮 P3-4b:分项回退 —— usage 存在但某侧为 0(某些网关)时,该侧用估算补,另一侧保实测。
      inTok = uIn > 0 ? uIn : (Number(sc.promptTokensEst) || 0);
      outTok = uOut > 0 ? uOut : Math.round(estimateContentTokens(sc.summary || ''));
      estimated = (uIn <= 0 || uOut <= 0);
    } else { inTok = Number(sc.promptTokensEst) || 0; outTok = Math.round(estimateContentTokens(sc.summary || '')); estimated = true; }
    const cachedInTok = estimated ? 0 : Math.min(inTok, cachedInputTokensFromUsage(u));
    const ledgerModel = sc.model || provider.model || '';
    const { cost, currency } = computeProviderCost(provider, inTok, outTok, cachedInTok, ledgerModel);
    appendUsageLedger({
      sessionId: session.id, engine: 'openai', provider: provider.id, model: ledgerModel,
      inTok, outTok, cachedInTok, cost, currency, estimated, turnSeq: session.turnSeq, kind: 'aux', note: 'compact',
      ...(attr && attr.subagentId ? { subagentId: String(attr.subagentId) } : {}),
      ...(attr && attr.runId ? { runId: String(attr.runId) } : {}),
    });
  } catch { /* accounting must never break compaction */ }
}

// Resolve the universal compaction selector. Empty selection follows the active engine/provider; an
// explicit selection clones the configured provider with the chosen model so summary calls, accounting,
// and SUMMARY input budgeting agree on the same endpoint. Conversation trigger limits are separate.
function resolveCompactionProvider(config, fallbackProvider) {
  const providerId = String(config && config.compactProviderId || '').trim();
  const modelId = String(config && config.compactModel || '').trim();
  if (!providerId) {
    if (!fallbackProvider) return { provider: null, model: '', isDefault: true };
    const fallbackModel = String(fallbackProvider.model || (fallbackProvider.models && fallbackProvider.models[0] && fallbackProvider.models[0].id) || '').trim();
    return { provider: fallbackProvider, model: fallbackModel, isDefault: true };
  }
  const found = (config.providers || []).find(p => p && p.id === providerId);
  if (!found) return { provider: null, model: '', isDefault: false, error: 'configured compaction provider is unavailable' };
  const model = modelId || String(found.model || (found.models && found.models[0] && found.models[0].id) || '').trim();
  return { provider: { ...found, model }, model, isDefault: false };
}

function compactHistoryFromSession(session) {
  const out = [];
  for (const message of (session && Array.isArray(session.messages) ? session.messages : [])) {
    if (!message || !['user', 'assistant'].includes(message.role)) continue;
    let content = String(message.content || '').trim();
    if (message.role === 'user' && Array.isArray(message.attachments) && message.attachments.length) {
      const refs = message.attachments.map(item => String(item && (item.path || item.name || item.filename) || '')).filter(Boolean);
      if (refs.length) content += `\n\n[本轮附件]\n${refs.join('\n')}`;
    }
    if (message.role === 'assistant') {
      const evidence = {};
      if (message.turnSummary && typeof message.turnSummary === 'object') evidence.turnSummary = message.turnSummary;
      if (Array.isArray(message.toolCalls) && message.toolCalls.length) evidence.toolCalls = message.toolCalls.map(call => ({ name: call && call.name, input: call && call.input }));
      const encoded = Object.keys(evidence).length ? JSON.stringify(evidence) : '';
      if (encoded) content += `\n\n[Ruyi 本轮操作证据]\n${encoded.slice(0, PrivacyGateway.referenceSafeSliceEnd(encoded, 0, 12000))}`;
    }
    if (!content) continue;
    out.push({ role: message.role, content });
  }
  return out;
}

function lastSessionContextTokens(session) {
  const messages = session && Array.isArray(session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i] && messages[i].usage;
    if (usage && Number.isFinite(Number(usage.contextTokens)) && Number(usage.contextTokens) > 0) return Number(usage.contextTokens);
  }
  return 0;
}

function contextWindowOverrideKey(engine, routeId, model) {
  return JSON.stringify([String(engine || ''), String(routeId || ''), String(model || '').trim()]);
}

function configuredConversationWindow(config, engine, routeId, model) {
  const value = Number(config && config.contextWindowOverrides && config.contextWindowOverrides[contextWindowOverrideKey(engine, routeId, model)]);
  return Number.isFinite(value) && value >= 8000 && value <= 2000000 ? Math.round(value) : 0;
}

function providerConversationContextWindow(config, provider, model) {
  const activeModel = String(model || provider && provider.model || '').trim();
  const manual = configuredConversationWindow(config, 'openai', provider && provider.id, activeModel);
  // Keep learned provider caps authoritative even when a manual conversation limit is configured.
  return providerContextWindow(manual ? { ...provider, contextWindow: manual } : provider, activeModel);
}

// 代理模式 v2(56 号文 §1②):工作流节点的上下文窗口。Claude 引擎节点与主会话同一条链 —— 手填(conversation
// override)→ 名称表 → 1M 兜底(CONTEXT_WINDOW_FALLBACK),不再 200K 兜底;openai 节点走 providerContextWindow
// (手填 → 探测 → 表 → 兜底,含窗口超限学习)。纯函数,供 09 runNode 的上游预算与测试直调。
function agentNodeContextWindow(node, provider, config) {
  const engine = String(node && node.engine || 'openai');
  if (engine === 'claude') {
    const model = String(node && node.model || (config && config.model) || '').trim();
    const manual = configuredConversationWindow(config, 'agent', 'claude', model);
    if (manual > 0) return manual;
    return resolveContextWindow(null, model).value;
  }
  return providerContextWindow(provider, node && node.model);
}

async function agentConversationContextMeta(config, session) {
  const agentCliType = String(config && config.agentCliType || 'claude');
  const model = String(config && config.model || session && session.claudeSessionModel || '').trim();
  // An empty configured model is itself a route (the CLI default), not the previous concrete model.
  const manualModel = String(config && config.model || '').trim();
  let contextWindow = configuredConversationWindow(config, 'agent', agentCliType, manualModel);
  let contextWindowSource = contextWindow ? 'manual' : '';
  // Query a native model-discovery probe when the selected CLI has one.
  const probeWindow = AGENT_CLI_CONTEXT_WINDOW_PROBES[normalizeAgentCliType(agentCliType)];
  if (!contextWindow && probeWindow) {
    try { contextWindow = await probeWindow(config, model); } catch { /* fall through to name table */ }
    if (contextWindow > 0) contextWindowSource = 'probe';
  }
  if (!contextWindow) {
    const messages = session && Array.isArray(session.messages) ? session.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i], usage = message && message.usage;
      if (!usage || usage.contextWindowSource === 'manual' || usage.source === 'external-compact') continue;
      const tagged = usage.contextEngine === 'agent' && usage.contextAgentCliType === agentCliType;
      const legacy = !usage.contextEngine && message.engine === 'claude' && (message.agentCliType || 'claude') === agentCliType;
      const reportedModel = String(usage.contextModel || usage.model || message.model || '').trim();
      if (!(tagged || legacy) || (model && reportedModel !== model)) continue;
      const measured = Number(usage.contextWindow);
      if (Number.isFinite(measured) && measured > 0) { contextWindow = measured; contextWindowSource = 'usage'; break; }
    }
  }
  if (!(contextWindow > 0)) {
    const resolved = resolveContextWindow(null, model);
    contextWindow = resolved.value;
    contextWindowSource = resolved.source;
  }
  return {
    contextEngine: 'agent', contextAgentCliType: agentCliType, contextModel: model,
    contextWindow, contextWindowSource,
  };
}

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

// ── 压缩标记合并(v2.6.2 观感修复)──────────────────────────────────────────────────────
// 此前自动压缩每次触发都 push 一条独立的 🗜 系统行。长 provider 回合的 agent 循环在每个迭代边界都会过一次
// maybeAutoCompact,而 assistant 大消息要回合结束才落盘 —— 实测单会话曾堆出连续 26 条标记,另一会话 337 行里
// 251 行是压缩行,全部视觉上挂在「最后一条用户消息」与最终回复之间。改为同一压缩集原位合并:
//   · 尾部压缩标记之后还没有新的 user/assistant 行 → 视为同一压缩集,更新那一行(passes/累计蒸发/最新前后
//     token),不再追加新行;对话一旦继续,旧标记自然闭环,下次压缩才开新行;
//   · 落盘安全:行内容变化令 planSessionBodyAppend 的前缀逐行比对失配,saveSession 自动走全量重写慢路径 ——
//     蒸发改写 providerHistory 本就走该路径,合并不引入额外成本。
// 零收益门槛:「蒸发 1 条:106K→106K」这类噪声 pass 只留审计账(logEvent 照旧),不再凭空造出行来。
const COMPACT_MARKER_MIN_SAVED_TOKENS = 1200;

// 尾部未闭环的压缩标记:从 messages 末尾向前找,遇 user/assistant 对话行即闭环(返回 null);
// 其它 system 噪声行(stderr 等)不打断同一压缩集的连续性。kind 隔离:auto 与手动压缩不互相并入。
function openCompactMarker(session, kind) {
  const msgs = Array.isArray(session && session.messages) ? session.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user' || m.role === 'assistant') return null;
    // 旧格式标记(无 compactMeta)不可并入 —— 文案必须能由 meta 全量重建,数字才保得住诚实。
    if (m.source === 'compact' && (m.compactKind || 'auto') === kind && m.compactMeta
      && Number.isFinite(m.compactMeta.passes)) return m;
  }
  return null;
}

// 追加(或并入)一条压缩标记并返回该消息行(调用方可在返回值上继续挂 usage 等附加字段)。
// 文案永远由 compactMeta 全量派生重建,历史标记(无 meta 的旧格式行)只会被当作闭环处理,不会被误改。
//   o = { kind, label, evaporated?, reseeded?, saved?, beforeTokens?, afterTokens,
//         approx?(默认true→'约'), accuracy?(默认'估算', 显式传空串则省略括注), note?(最新一次覆盖) }
// beforeTokens 仅在【新建】行时生效(压缩集起点的估算值);并入已有行时保留首见起点,不回改。
// saved 省略时由 beforeTokens-afterTokens 推导(kimi 等实测路径只带前后实测值的调用形态)。
function upsertCompactMarker(session, o) {
  const afterTokens = Math.max(0, Math.round(Number(o.afterTokens) || 0));
  const savedExplicit = o.saved == null ? NaN : Math.max(0, Number(o.saved) || 0);
  const saved = o.reseeded ? Infinity
    : (Number.isFinite(savedExplicit) ? savedExplicit
      : Math.max(0, (Math.round(Number(o.beforeTokens) || 0)) - afterTokens));
  let marker = openCompactMarker(session, o.kind);
  if (!marker && !o.reseeded && saved < COMPACT_MARKER_MIN_SAVED_TOKENS) return null; // 零收益不造新行
  if (!marker) {
    marker = { role: 'system', content: '', createdAt: nowIso(), source: 'compact', compactKind: o.kind };
    session.messages.push(marker);
    marker.compactMeta = {
      passes: 0, evaporated: 0, reseeded: false,
      beforeTokens: Math.max(0, Math.round(Number(o.beforeTokens) || afterTokens)),
    };
  }
  const meta = marker.compactMeta;
  meta.passes += 1;
  meta.evaporated += Math.max(0, Number(o.evaporated) || 0);
  meta.reseeded = Boolean(meta.reseeded || o.reseeded);
  meta.afterTokens = afterTokens;
  const times = meta.passes > 1 ? ` ×${meta.passes}` : '';
  const ops = [];
  if (meta.evaporated > 0) ops.push(`蒸发旧工具结果 ${meta.evaporated} 条`);
  if (meta.reseeded) ops.push('摘要重播种');
  const accuracy = o.accuracy === undefined ? '估算' : o.accuracy;
  const head = `🗜 ${o.label}${times}`;
  const tail = `${fmtTokensServer(meta.beforeTokens)}→${o.approx === false ? '' : '约 '}${fmtTokensServer(afterTokens)}${accuracy ? `（${accuracy}）` : ''}`;
  marker.content = ops.length ? `${head}（${ops.join('＋')}）：${tail}` : `${head}：${tail}`;
  if (o.note) marker.content += `；${o.note}`;
  return marker;
}

// L2 SUMMARY RESEED boundary. Keep as many complete recent user turns as fit `maxTailTokens`; all older
// history is represented by the structured summary. A kept slice always starts at role:'user', so it cannot
// orphan an assistant tool_call or its tool result. If the newest whole user turn alone exceeds the cap,
// return history.length: it remains in the summary instead of violating the fixed-tail budget.
function recentTurnsBoundary(history, maxTailTokens, byUnits) {
  if (!Array.isArray(history)) return 0;
  const cap = Math.max(0, Math.floor(Number(maxTailTokens == null ? COMPACT_RESEED_TAIL_MAX_TOKENS : maxTailTokens) || 0));
  if (!cap) return history.length;
  const starts = userBlockStarts(history);
  let boundary = history.length, keptTokens = 0;
  for (let i = starts.length - 1; i >= 0; i--) {
    const begin = starts[i], end = starts[i + 1] || history.length;
    const turnTokens = estimateHistoryTokens(history.slice(begin, end));
    if (keptTokens + turnTokens > cap) break;
    keptTokens += turnTokens;
    boundary = begin;
  }
  // 126-111b:**最新一整个 user 回合放不下时,今天一条都不留**(boundary 停在 history.length ->
  // kept = [])。一个 user 回合里带几十个工具往来是常态,于是「摘要 + 一句收到」之后模型手里
  // 什么都没有 —— 它刚做过的事全靠摘要转述。
  //
  // 开关开时退化为**按单元**从尾部装:单元起点＝非 tool 的那一条(historyUnitStarts,与 111a 同一个
  // 原语),所以切口天然落在「assistant(tool_calls) ＋ 其全部 tool 回复」的头上,**永远不劈开配对**。
  // 只在「一个 user 回合都装不下」这一种情况下才退化 —— 装得下时逐字节走上面那条老路。
  // `byUnits` 是【已经过开关把门的】布尔(判定口在 01c 的 reseedTailUnitsEnabled),本函数不读开关:
  // 与 111a 的 boundaryBudget 同一个模具,也是为了让静态件能把它原样切出来跑。
  if (byUnits === true && boundary === history.length && history.length) {
    const unitStarts = historyUnitStarts(history);
    let unitKept = 0;
    for (let i = unitStarts.length - 1; i >= 0; i--) {
      const begin = unitStarts[i], end = unitStarts[i + 1] || history.length;
      const unitTokens = estimateHistoryTokens(history.slice(begin, end));
      if (unitKept > 0 && unitKept + unitTokens > cap) break;
      unitKept += unitTokens;
      boundary = begin;
    }
  }
  return boundary;
}

// 126-111c: 重播种后重附最近读过的文件。
//
// 现状:L2 把整段历史换成「摘要 user ＋ 一句收到 ＋ 尾部」。摘要里也许写着「改了 a.js 的第 40 行」,
// 但**文件长什么样已经不在上下文里了** —— 模型下一步要么凭记忆改、要么把同一个文件再读一遍。
//
// 做法:重播种那一刻【完整历史还在手里】,尾部那些 file_read 的全文就在里面 —— 直接从它取。
// **零磁盘读取**(派单稿原写的是从 105a 快照 rehydrateObservation 取 —— 那等于把手里已经有的东西
// 再从盘上读一遍;而且压缩是热路径,能不碰盘就不碰)。取不到全文的(已被蒸发成占位/缩减视图)
// 直接跳过 —— 它本来就已经不在模型眼前了,重附它不是「接着用」,是凭空塞回来。
//
// 有界:按 path 去重取最新一次,每个文件只带头部若干行,整块过 reattach 预算与文件数上限;
// 三个数全在 rules.compactionPlan 里(值域唯一)。
function recentFileReads(history, budgetTokens) {
  const rules = CONTEXT_GOVERNANCE_RULES.compactionPlan;
  const cap = Math.max(0, Math.min(rules.reattachMaxTokens, Math.floor(Number(budgetTokens) * rules.reattachRatio)));
  if (!Array.isArray(history) || !history.length || !cap) return [];
  const byPath = new Map();   // path -> { path, head }(后写覆盖前写 = 取最新一次)
  for (const m of history) {
    if (!m || m.role !== 'tool' || typeof m.content !== 'string') continue;
    if (m.content.startsWith(EVAPORATED_PREFIX) || m.content.startsWith(READ_DEDUP_PREFIX)) continue;
    let parsed = null;
    try { parsed = JSON.parse(m.content); } catch { continue; }
    if (!parsed || parsed.ok !== true) continue;
    const filePath = typeof parsed.path === 'string' ? parsed.path : '';
    const body = typeof parsed.content === 'string' ? parsed.content : '';
    if (!filePath || !body) continue;
    // 先 delete 再 set:`Map.set` 对**已存在**的键不会把它挪到末尾 —— 不删的话「同一个文件又读了
    // 一遍」在插入序里仍停在老位置,于是下面 reverse 出来的「最近优先」是假的(判据 B3 当场逮到)。
    byPath.delete(filePath);
    byPath.set(filePath, { path: filePath, head: body.split(/\r?\n/).slice(0, rules.reattachHeadLines).join('\n') });
  }
  // 最近读的排前面(Map 保插入序,后写的在后 —— 反过来即最近优先)。
  const ordered = [...byPath.values()].reverse().slice(0, rules.reattachMaxFiles);
  const picked = [];
  let used = 0;
  for (const file of ordered) {
    const cost = estimateTextTokens(file.path + '\n' + file.head);
    if (picked.length && used + cost > cap) break;   // 至少带一个,否则预算一紧整块消失
    used += cost;
    picked.push(file);
  }
  return picked;
}

// 第104波：所有自动压缩入口共享同一份不可变计划语义。计划只计算预算、完整回合尾部与
// 重播种形状；摘要执行、持久化和事件仍由各 owner 负责，因此不会把副作用重新揉成一团。
// 重播种时钉住的「原始任务」正文。两个坑:
//   · 第二次及以后的 L2:历史首条 user 就是上一次重播种写的「原始任务 + 旧摘要」。整条再钉一遍,旧摘要就一层套一层
//     越积越长(新摘要本来就覆盖了旧摘要)—— 只取出其中原始任务那一段;
//   · 带图片的首问:content 是 parts 数组,String() 出来是「[object Object],[object Object]」—— 拍平成文字、图片记一笔。
const COMPACTION_TASK_PREFIX = '原始任务(保持聚焦):\n';
const COMPACTION_HISTORY_PREFIX = '最初请求(仅作历史来源,是否仍有效以摘要目标为准):\n';
// 手动压缩(runProviderCompact 的 L2)塌成 [摘要, 收到] 时首条 user 的开头。
const MANUAL_COMPACTION_SUMMARY_HEADER = '(以下是此前对话的压缩摘要)\n';
// 手动压缩「值不值得再压」的门(2026-10 用户报:压完再点一次「压缩」,转半天、结果没变 —— 实测是把 [摘要, 收到] 又交给
// 摘要模型摘一遍,前后一样大,白花一次模型调用):上次压缩之后新增的内容不到「预算 × 比例,夹在 [下限, 上限]」就不调摘要,
// 当场说明。上限是给超长窗口留的:1M 窗口按比例是 4 万,新增两三万 token 每轮都要付钱,不能说「没什么可压」。
// L1 只省下一点点(不到 max(下限, 压缩前 × 比例))也不算「压过了」,同样按这道门决定要不要走 L2。
const MANUAL_COMPACT_MIN_FRESH_TOKENS = 1500;
const MANUAL_COMPACT_MAX_FRESH_TOKENS = 8000;
const MANUAL_COMPACT_MIN_FRESH_RATIO = 0.05;
const MANUAL_COMPACT_MIN_L1_SAVED_TOKENS = 300;
const MANUAL_COMPACT_MIN_L1_SAVED_RATIO = 0.02;
function compactionTaskText(message) {
  const content = message && message.content;
  let text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      return /image/i.test(String(part.type || '')) ? '[图片]' : '';
    }).filter(Boolean).join('\n')
    : String(content == null ? '' : content);
  if (text.startsWith(COMPACTION_TASK_PREFIX) || text.startsWith(COMPACTION_HISTORY_PREFIX)) {
    const prefix = text.startsWith(COMPACTION_TASK_PREFIX) ? COMPACTION_TASK_PREFIX : COMPACTION_HISTORY_PREFIX;
    const body = text.slice(prefix.length);
    const cut = body.indexOf('\n\n【压缩摘要');
    text = cut >= 0 ? body.slice(0, cut) : body;
  } else if (text.startsWith(MANUAL_COMPACTION_SUMMARY_HEADER)) {
    // 手动 L2 之后没有单独的原始任务:取旧摘要的【目标】一节代替。修前整条(旧摘要 + 旧工具索引)被当成任务原文钉一遍,
    // 下一次自动 L2 的重播种里索引出现两份(多约 4K 字)。没有【目标】节就取索引之前的正文、截到 1200 字。
    const body = text.slice(MANUAL_COMPACTION_SUMMARY_HEADER.length);
    const sections = summarySectionLocations(body);
    const goal = sections.find(section => section.index === 0);
    const end = goal && sections.find(section => section.pos > goal.pos);
    text = goal ? body.slice(goal.pos, end ? end.pos : body.length).trim() : body.split('\n\n' + COMPACTION_TOOL_INDEX_HEADER)[0].slice(0, 1200);
  }
  return text;
}
// ── 压缩摘要后附的「已执行工具调用」机器索引 ──────────────────────────────────────────────────────────────
// 2026-10(用户转来的本机 agent 评估):L2 摘要是五节自然语言,写不写工具清单由摘要模型定;被摘要掉的那段历史里「调过什么、
// 得到过什么」在模型可见面上就没有任何记录了,而快照里的原件也因为没有 rawRef 够不着(105a 的恢复索引只认历史里还在的缩减
// 视图,L2 之后为空)。网页、接口、一次性命令、子代理交付这类结果事后重跑复现不了 —— 「既没写进摘要、又够不着」正是那个洞。
// 这里在摘要后面确定性地附一张有界索引:被摘要掉那段里的每次工具调用(名字 + 关键参数 + 结果大小/失败),能回捞的带 rawRef
// (observation_recall 取回当时的原文)。不调模型、不改摘要内容;名额不够时先让出「可重跑的」(读本地文件之类),一次性的留到最后。
// 上一次压缩留下的索引行原样并进来(更早的在前),反复压缩也不丢锚点。
// rawRef 只在观察回捞开着、且快照是带内容哈希的那种(reducer 开时才写)时给:
//   · 内容里已经带 rawRef(本轮或更早的 L1 缩减视图、111e 去重指针)→ 沿用它,它指向当时的原件;
//   · 否则内容自快照以来没动过(reducer 开时 L1 要么缩成带 rawRef 的视图、要么原样不动)→ 按本次快照算 rawRef。
const COMPACTION_TOOL_INDEX_MAX_ENTRIES = 30;
const COMPACTION_TOOL_INDEX_MAX_CHARS = 4000;
const COMPACTION_TOOL_INDEX_SKIP = new Set(['todo_write', 'scratchpad_write', 'tool_search', 'tool_load', 'list_tools', 'observation_recall', 'checkpoint_list']);
// 事后重跑复现不了的那一类:联网、命令/脚本、子代理、桌面/浏览器操作;桥接的外部 MCP 工具(名字带 __)一律算。
const COMPACTION_TOOL_INDEX_ONESHOT = /__|^(web_fetch|web_search|http_request|http_download|powershell_run|script_run|shell_start|shell_poll|shell_send|orchestrate_agents|agent_result|wait_agents)$|^(desktop|browser)_/;
const COMPACTION_RAWREF_PATTERN = /history:\d+:[a-f0-9]{16}:\d+:[a-f0-9]{16}/;
// keepTail:路径类参数掐中间、留尾巴 —— 文件名在尾部,Windows 的临时目录/工作区前缀一长,从尾部截就只剩盘符和用户目录。
function compactionIndexText(value, max, keepTail = false) {
  const flat = String(value == null ? '' : value).replace(/\s+/g, ' ').replace(/</g, '＜').replace(/>/g, '＞').trim();
  if (flat.length <= max) return flat;
  if (!keepTail) return flat.slice(0, max) + '…';
  const head = Math.min(12, Math.floor(max / 4));
  return flat.slice(0, head) + '…' + flat.slice(flat.length - (max - head - 1));
}
const COMPACTION_PATH_ARG_KEYS = new Set(['path', 'paths', 'dest', 'from', 'to', 'cwd', 'file', 'filePath', 'dir']);
function compactionToolArgsDigest(rawArgs) {
  let args = null;
  try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs; } catch { args = null; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return compactionIndexText(rawArgs, 80);
  const preferred = ['path', 'url', 'query', 'command', 'task', 'name', 'pattern', 'paths', 'runId', 'nodeId', 'workflowId', 'dest', 'from', 'to', 'code'];
  const keys = [...preferred.filter(k => Object.prototype.hasOwnProperty.call(args, k)), ...Object.keys(args).filter(k => !preferred.includes(k))];
  const parts = [];
  for (const key of keys) {
    const v = args[key];
    if (v == null || v === '' || typeof v === 'boolean') continue;
    const text = Array.isArray(v) ? v.slice(0, 3).map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(',') : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    parts.push(key + '=' + compactionIndexText(text, 60, COMPACTION_PATH_ARG_KEYS.has(key)));
    if (parts.length >= 2) break;
  }
  return parts.join(' ');
}
// history:要摘要的那段所在的历史(L1 之后、重播种之前);upto:被摘要掉的部分是 history[0..upto)。
// 返回 '' = 没有可列的调用。opts.scratchpadHint:主会话(有草稿本)时多一句「要原样留着的写进草稿本」。
function buildCompactionToolIndex(history, opts = {}) {
  const list = Array.isArray(history) ? history : [];
  const upto = Math.max(0, Math.min(list.length, Number.isFinite(Number(opts.upto)) ? Number(opts.upto) : list.length));
  const config = opts.config || {};
  const refPrefix = String(opts.rawRefPrefix || '');
  const canRecall = observationRecallEnabled(config) && /^history:\d+:[a-f0-9]{16}$/.test(refPrefix);
  // 结果按「assistant 之后紧跟的那串 tool 消息」就近配对:有的服务商每次迭代都从 call_1 起编,全局按 id 取第一条会把后面的
  // 调用都配到第一次的结果上(算出同一个 rawRef 再被下面的去重丢掉)—— 而被丢的恰是要保护的一次性调用。
  // 紧跟的那串里找不到(中间夹了插话之类)再往后找,到下一次复用同一 id 的 assistant 为止。
  const resultIndexFor = (assistantAt, id) => {
    let j = assistantAt + 1;
    for (; j < upto && list[j] && list[j].role === 'tool'; j++) if (String(list[j].tool_call_id || '') === id) return j;
    for (; j < upto; j++) {
      const m = list[j];
      if (!m) continue;
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some(c => String((c && c.id) || '') === id)) return null;
      if (m.role === 'tool' && String(m.tool_call_id || '') === id) return j;
    }
    return null;
  };
  // 上一次压缩留下的索引行(在摘要那条 user 消息里),更早的在前。
  const entries = [];
  const seenRefs = new Set();
  for (let i = 0; i < upto; i++) {
    const m = list[i];
    if (!m || m.role !== 'user' || typeof m.content !== 'string' || !m.content.includes(COMPACTION_TOOL_INDEX_HEADER)) continue;
    const lines = m.content.slice(m.content.indexOf(COMPACTION_TOOL_INDEX_HEADER) + COMPACTION_TOOL_INDEX_HEADER.length).split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!line.startsWith('- ')) break;
      const ref = (line.match(COMPACTION_RAWREF_PATTERN) || [])[0] || '';
      if (ref && seenRefs.has(ref)) continue;
      if (ref) seenRefs.add(ref);
      entries.push({ line, oneShot: true, ref });
    }
  }
  for (let i = 0; i < upto; i++) {
    const m = list[i];
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const call of m.tool_calls) {
      const name = String((call && call.function && call.function.name) || '');
      if (!name || COMPACTION_TOOL_INDEX_SKIP.has(name)) continue;
      const callId = String((call && call.id) || '');
      const at = callId ? resultIndexFor(i, callId) : null;
      const result = at == null ? null : list[at];
      const content = result && typeof result.content === 'string' ? result.content : '';
      const reducedChars = (content.match(/originalChars["=:\s]*(\d+)/) || [])[1];   // 缩减视图(文本头或 _ruyiObservation 对象)记着原件大小
      const size = reducedChars ? Number(reducedChars) : content.length;
      const failed = /"ok"\s*:\s*false/.test(content.slice(0, 400));
      let ref = '';
      if (canRecall && content) {
        ref = (content.match(COMPACTION_RAWREF_PATTERN) || [])[0] || '';
        if (!ref && !content.startsWith(EVAPORATED_PREFIX)) ref = `${refPrefix}:${at}:${crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)}`;
      }
      if (ref && seenRefs.has(ref)) continue;
      if (ref) seenRefs.add(ref);
      const digest = compactionToolArgsDigest(call && call.function && call.function.arguments);
      const outcome = result == null ? '无结果' : (failed ? '失败' : `${size} 字`);
      const line = `- ${compactionIndexText(name, 60)}${digest ? ' ' + digest : ''} → ${outcome}${ref ? ' · rawRef=' + ref : ''}`;
      entries.push({ line, oneShot: COMPACTION_TOOL_INDEX_ONESHOT.test(name), ref });
    }
  }
  if (!entries.length) return '';
  // 名额:条数与字数都有上限。超了先丢最早的「可重跑」条目,没有了再丢最早的。
  const total = () => entries.reduce((n, e) => n + e.line.length + 1, 0);
  while (entries.length > COMPACTION_TOOL_INDEX_MAX_ENTRIES || (entries.length > 1 && total() > COMPACTION_TOOL_INDEX_MAX_CHARS)) {
    const drop = entries.findIndex(e => !e.oneShot);
    entries.splice(drop >= 0 ? drop : 0, 1);
  }
  const anyRef = entries.some(e => e.ref);
  const footer = [
    anyRef
      ? '需要某条的确切原文时,调用 observation_recall({rawRef}) 取回当时的原始输出(只读);没有 rawRef 的已不可回捞,要用确切内容就重新读取 / 重新调用(网页、接口、命令的结果可能已经变了)。'
      : '这些调用的原文已不可回捞;要用确切内容就重新读取 / 重新调用(网页、接口、命令的结果可能已经变了)。',
    opts.scratchpadHint ? '之后还要原样用到的数字、链接、ID、rawRef,可以用 scratchpad_write 记下 —— 草稿本跨压缩保留。' : '',
  ].filter(Boolean).join('\n');
  return COMPACTION_TOOL_INDEX_HEADER + '\n' + entries.map(e => e.line).join('\n') + '\n' + footer;
}

const CompactionPlan = (() => {
  const defaults = CONTEXT_GOVERNANCE_RULES.compactionPlan;
  function create(options = {}) {
    const history = Array.isArray(options.history) ? options.history : [];
    const provider = options.provider || null;
    const model = String(options.model || provider && provider.model || '');
    const threshold = Number(options.config && options.config.autoCompactThreshold) || defaults.defaultThreshold;
    const window = options.conversationWindow
      ? providerConversationContextWindow(options.config || {}, provider, model)
      : providerContextWindow(provider, model);
    // 116f: budgetOverride 是可选的预算覆盖(唯一使用者:管家会话的 §11.2 预算)。不传时
    // budget === threshold * window,与本切片之前逐字节一致 —— 尾预算/边界/reseed 全部随之不变。
    const overrideBudget = Number(options.budgetOverride);
    const budget = Number.isFinite(overrideBudget) && overrideBudget > 0 ? overrideBudget : threshold * window;
    const tailBudget = Math.max(defaults.minimumTailTokens, Math.min(
      COMPACT_RESEED_TAIL_MAX_TOKENS,
      Math.floor(budget * defaults.tailBudgetRatio)
    ));
    // 126-111b:开关在这儿把门(与 111a 的 boundaryBudget 同一个模具)。
    const boundary = recentTurnsBoundary(history, tailBudget, reseedTailUnitsEnabled(options.config));
    const task = history.find(message => message && message.role === 'user') || history[0] || null;
    return Object.freeze({
      schema: 1,
      scope: options.scope === 'subagent' ? 'subagent' : 'main',
      trigger: String(options.trigger || 'auto'),
      threshold,
      window,
      budget,
      tailBudget,
      boundary,
      task,
      kept: boundary <= 0 ? [] : history.slice(boundary),
      // 126-111c:开关在这儿把门(与 111a/111b 同一个模具)。关时恒为空数组 -> reseed 零注入。
      recentFiles: reseedReattachFilesEnabled(options.config) ? recentFileReads(history, budget) : [],
    });
  }
  // extras.toolIndex:buildCompactionToolIndex 的结果('' / 缺省 = 不附,重播种逐字节同修前)。
  function reseed(plan, summary, extras) {
    const forced = plan && plan.trigger === 'forced_400';
    const subagent = plan && plan.scope === 'subagent';
    const heading = forced ? '【压缩摘要｜因上下文超限重播种】' : '【压缩摘要】';
    const acknowledgement = subagent
      ? '已了解原任务与以上摘要,继续推进。'
      : (forced ? '收到,已基于摘要继续。' : '收到，已基于摘要继续。');
    const kept = (plan && plan.kept) || [];
    // 126-111b:按单元退化保留时,kept 可能以 assistant 打头(「assistant(tool_calls) ＋ 其 tool 回复」
    // 就是一个完整单元)。直接拼上去会出现 [assistant(收到), assistant(tool_calls)] 两条连续 assistant,
    // 破部分 provider 的交替契约 —— 所以插一条桥接 user 消息把话头接回来。
    // **文案写在这儿而不是 06b 提示词注册表**(25 号文 §1.2 原本写的是 registry):10 引用 06b 是
    // **循环边**(依赖图 --check 报过,111d 那一刀已经撞过一次)。本函数里另外三处文案本来也都是
    // 内联的,所以这是跟着文件自己的写法走,不是图省事。
    const bridged = kept.length && kept[0] && kept[0].role === 'assistant'
      ? [{ role: 'user', content: '以下为摘要之后保留的最近工具往来,接续执行。' }, ...kept]
      : kept;
    // 126-111c:最近读过的文件有界重附。**并进摘要那一条 user,不单列一条** —— 单列会造成
    // 两条连续 user(它后面跟着的要么是桥接 user、要么是 kept 的首条 user),破部分 provider 的
    // 交替契约;本函数上方那条注释早就为「钉住原始 task」踩过同一个坑,做法逐字相同。
    // 开关关时 recentFiles 恒为空数组 -> 这一段整个不出现,reseed 逐字节不变。
    const files = (plan && plan.recentFiles) || [];
    const fileBlock = files.length
      ? '\n\n【最近读过的文件(节选,供接续参考;需要全文请重新读)】\n'
        + files.map(f => '--- ' + f.path + ' ---\n' + f.head).join('\n\n')
      : '';
    const indexBlock = extras && extras.toolIndex ? '\n\n' + String(extras.toolIndex) : '';
    return [
      { role: 'user', content: (subagent ? COMPACTION_TASK_PREFIX : COMPACTION_HISTORY_PREFIX) + compactionTaskText(plan && plan.task) + '\n\n' + heading + '\n' + String(summary || '') + (subagent ? '' : '\n\n接续依据:摘要中的【目标】/Goal是当前仍有效目标;结合其后保留的最近用户输入推进。补充或进度追问不取消未完目标、仍适用约束与流程;已取代、取消或完成的目标仅是历史,不得恢复。') + fileBlock + indexBlock },
      { role: 'assistant', content: acknowledgement },
      ...bridged,
    ];
  }
  function snapshot(plan) {
    return {
      schema: plan.schema, scope: plan.scope, trigger: plan.trigger,
      threshold: plan.threshold, window: plan.window, budget: plan.budget,
      tailBudget: plan.tailBudget, boundary: plan.boundary, keptCount: plan.kept.length,
    };
  }
  return Object.freeze({ create, reseed, snapshot });
})();

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
