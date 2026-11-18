'use strict';

const CONTEXT_GOVERNANCE_RULES = require('./context-governance-rules.json');
const { renderProviderStablePrompt } = require('./provider-stable-prompt.cjs');
const { SUMMARY_PROMPT, summaryPromptWithGuidance, validateStructuredSummary } = require('./summary-format.cjs');
const { userBlockStarts } = require('./provider-history.cjs');
const { createSummaryRequest, aggregateSummaryCalls } = require('./summary-request.cjs');
const {
  SUMMARY_ENTITY_RULES, extractSummaryEntities, checkSummaryEntities, summarySourceText,
  buildSummaryFactTableMessages, summaryTaskEvidenceDirective, summaryTaskEvidenceScope,
  summaryTaskSourceRole, summaryTaskSourceHistory, stripSummaryTaskEvidence, extractSummaryTaskEvidence,
  mergeSummaryTaskEvidence, summaryTaskEvidenceMessage,
} = require('./summary-evidence.cjs');
const { summaryEntityCheckEnabled, summarySingleShotEnabled, summaryFactTableEnabled, summaryFactTableCap, summaryRefineEnabled } =
  require('./runtime-policy.cjs');

// 并行 map-reduce 的并发上限解析(105i:36 块无上限并发会把 provider 打进排队/限流)——
// 读 config.summaryMaxConcurrentV1,过 [min,max] 钳位,坏值落回全局默认 8。该上限对所有模型一致，
// 仍由 fail-fast 取消保护在 provider 或单块失败时停止派发；用户未新增配置项。
const SUMMARY_MAX_CONCURRENT_RULE = CONTEXT_GOVERNANCE_RULES.summary.maxConcurrent || { default: 8, min: 1, max: 8 };
function summaryMaxConcurrent(config, provider, model) {
  const rule = SUMMARY_MAX_CONCURRENT_RULE;
  const n = Number(config && config.summaryMaxConcurrentV1);
  const clamp = value => Math.min(Number(rule.max) || 8, Math.max(Number(rule.min) || 1, Math.round(value)));
  if (Number.isFinite(n)) return clamp(n);
  return Number(rule.default) || 8;
}
// 摘要调用的停止信号(回合的 AbortSignal,经 opts.signal 传入);不是信号就当没有。
function summaryStopSignal(opts) {
  const sig = opts && opts.signal;
  return sig && typeof sig.aborted === 'boolean' && typeof sig.addEventListener === 'function' ? sig : undefined;
}
function summaryStoppedResult() {
  return { ok: false, aborted: true, error: 'summary request cancelled (turn stopped)' };
}
// 两路信号任一 abort 即 abort(map-reduce 的 fail-fast 与回合停止);缺一路就用另一路。
function anySummarySignal(a, b) {
  if (!a) return b || undefined;
  if (!b) return a;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const ctrl = new AbortController();
  const fire = () => { try { ctrl.abort(); } catch { /* ignore */ } };
  if (a.aborted || b.aborted) fire();
  else { a.addEventListener('abort', fire, { once: true }); b.addEventListener('abort', fire, { once: true }); }
  return ctrl.signal;
}
// 有界并发执行摘要类调用(仿 09-workflow 21-E2 worker-pool:poolNext 领任务、完成即补位,无批次屏障)。
// fail-fast:任一结果 !ok 即 abort failCtrl —— worker 停止领新任务,在飞请求经 extraSignal 取消;
// 结果按输入下标保序(失败点之后的空位为 undefined,调用方按序找首个真实失败上浮)。
// 分段摘要的失败取哪一条:按块序取第一条【真实】失败。一块失败会 abort 同批的其它块,那些被连带取消的
// (cancelledBySibling)排在前面的话,修前报出去的就是「sibling chunk failed」,真正的原因(400 / 超时)被盖住了。
function pickSummaryFailure(results) {
  const failures = (Array.isArray(results) ? results : []).filter(r => r && !r.ok);
  return failures.find(r => !r.cancelledBySibling) || failures[0] || null;
}
async function mapSummaryWithLimit(items, limit, fn, failCtrl) {
  const results = new Array(items.length);
  let poolNext = 0;
  let failed = false;
  const workers = Math.min(items.length, Math.max(1, limit));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (!failed && poolNext < items.length) {
      const i = poolNext++;
      const r = await fn(i);
      results[i] = r;
      if (!r || !r.ok) { failed = true; try { failCtrl && failCtrl.abort(); } catch { /* ignore */ } }
    }
  }));
  return results;
}

const SUMMARY_REFINE_RULES = CONTEXT_GOVERNANCE_RULES.summary.refine || {};
function buildSummaryRefineMessages(currentSummary, nextChunk, factMessage) {
  return [
    { role: 'user', content: '【当前累计摘要】\n' + String(currentSummary || '') + '\n\n【新增历史块开始】' },
    ...(Array.isArray(nextChunk) ? nextChunk : []),
    { role: 'user', content: '【新增历史块结束】' },
    ...(factMessage ? [factMessage] : []),
  ];
}

function createProviderSummary({
  providerWireProtocol, normalizeProviderApiStyle, providerBaseWithV1,
  resolveContextWindow, providerContextWindow, fetchOpenAiModels, isContextOverflowError,
  estimateHistoryTokens, estimateTextTokens, PrivacyGateway, DesktopExecutionHooks, readConfig, logEvent,
}) {
  const { singleSummaryCall, resolveSummaryCallPolicy } = createSummaryRequest({
    providerWireProtocol, normalizeProviderApiStyle, isContextOverflowError, estimateHistoryTokens,
    PrivacyGateway, DesktopExecutionHooks, logEvent,
  });

  const SUMMARY_INPUT_BUDGET_RATIO = CONTEXT_GOVERNANCE_RULES.summary.inputBudgetRatio;
  // 22-S0 热点基线实测(2026-08-27):单发摘要输入到 60K token 时,glm-5.3-flash 的正常耗时已在
  // 40–51s,旧 60s 远程超时等于踩悬崖 —— 真实 dogfood 一天 30 次 L2 里 26 次超时作废。
  // ① 远程超时提到 180s(localhost/Ollama 维持 300s);② 本可单发但预估超过此阈值的输入强制走
  // map-reduce 分块,让每次真实 HTTP 尝试天然远离超时线。
  const SUMMARY_SINGLE_SHOT_MAX_EST = CONTEXT_GOVERNANCE_RULES.summary.singleShotMaxEstimate;
  // 105f: 单发优先的预算余量 —— reserve = system＋摘要 prompt＋预期输出＋校准误差上界。摘要 prompt 分量
  // 运行时估算(跟随 SUMMARY_PROMPT 实际文本,不抄死数字);其余分量在 rules 的 summary.singleShotReserve。
  const SUMMARY_SINGLE_SHOT_RESERVE = CONTEXT_GOVERNANCE_RULES.summary.singleShotReserve || {};
  const SUMMARY_SINGLE_SHOT_CAP_RULE = CONTEXT_GOVERNANCE_RULES.summary.singleShotCap || { default: 32768, min: 8192, max: 131072 };
  function summarySingleShotReserveTokens(config) {
    return (Number(SUMMARY_SINGLE_SHOT_RESERVE.systemTokens) || 0)
      + estimateTextTokens(summaryPromptWithGuidance(config))
      + (Number(SUMMARY_SINGLE_SHOT_RESERVE.expectedOutputTokens) || 0)
      + (Number(SUMMARY_SINGLE_SHOT_RESERVE.calibrationMarginTokens) || 0);
  }
  // 105f: 单发估算上限解析 —— 「provider/model」精确覆盖 > provider 覆盖 > 引擎(apiStyle)覆盖 > 全局设置;
  // 每个来源都过同一钳位 [min, max](坏值落回 default)。不提供无限档;与远程超时无关(不自动改超时)。
  function summarySingleShotCap(config, provider, model) {
    const rule = SUMMARY_SINGLE_SHOT_CAP_RULE;
    const clampCap = v => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(Number(rule.max) || 131072, Math.max(Number(rule.min) || 8192, Math.round(n))) : (Number(rule.default) || 32768);
    };
    const ov = (config && config.summarySingleShotMaxOverridesV1 && typeof config.summarySingleShotMaxOverridesV1 === 'object' && !Array.isArray(config.summarySingleShotMaxOverridesV1)) ? config.summarySingleShotMaxOverridesV1 : {};
    const pid = String((provider && provider.id) || '');
    const mid = String(model || (provider && provider.model) || '');
    const style = providerWireProtocol(provider).id;
    for (const key of [pid && mid ? pid + '/' + mid : '', pid, 'style:' + style]) {
      if (key && ov[key] != null) return clampCap(ov[key]);
    }
    return clampCap(config && config.summarySingleShotMaxTokensV1);
  }

  // 预算适配(45a):返回【新数组】,绝不 mutate 调用方 history(manual compact 失败时「原样保留」契约)。
  function fitHistoryForSummary(history, budgetTokens) {
    if (!Array.isArray(history) || !history.length) return { messages: [], droppedMiddle: 0 };
    if (estimateHistoryTokens(history) <= budgetTokens) return { messages: history.slice(), droppedMiddle: 0 };
    const starts = userBlockStarts(history);
    if (starts.length <= 3) return { messages: history.slice(), droppedMiddle: 0, needsMapReduce: true };
    const headEnd = starts[1];                 // 头 = 第 2 个 user 块之前(含原始目标)
    const tailStart = starts[starts.length - 2]; // 尾 = 最近 2 个 user 块(逐字)
    const middleCount = tailStart - headEnd;
    const marker = { role: 'user', content: `(摘要输入预算截断:此处省略中间 ${middleCount} 条消息)` };
    const fitted = [...history.slice(0, headEnd), marker, ...history.slice(tailStart)];
    // Never silently discard the middle of a conversation. A small-window summarizer must see every user
    // block through map-reduce; the head/marker/tail projection remains useful to diagnostics and callers
    // that only need a preview, but the summary kernel treats any omitted middle as map-reduce-required.
    if (estimateHistoryTokens(fitted) <= budgetTokens) return { messages: fitted, droppedMiddle: middleCount, needsMapReduce: true };
    return { messages: history.slice(), droppedMiddle: 0, needsMapReduce: true }; // 头尾本身已超 → map-reduce
  }

  // map-reduce 分组(45a):正常回合按 user 块聚合。一个 user 回合可能包含上百条 assistant/tool
  // 消息（长 Agent 工具循环），整块可远超预算；这种块不能只截每条消息后继续整块发送，也不能在
  // tool_call/tool_result 中间硬切。把超大块无损序列化成带角色标签的纯文本 transcript，再按实测
  // token 估算切成独立 user 片段：既不触发 Provider 的工具配对校验，也不会丢掉块的中后段。
  function chunkHistoryByBudget(history, budgetTokens, sourceIndexes) {
    const starts = userBlockStarts(history);
    const blocks = [];
    for (let i = 0; i < starts.length; i++) blocks.push(history.slice(starts[i], starts[i + 1] || history.length));
    const transcriptText = block => block.map(message => {
      const role = message && message.role === 'user' ? '用户' : (message && message.role === 'assistant' ? '助手' : `工具${message && message.name ? ` ${message.name}` : ''}`);
      const content = typeof (message && message.content) === 'string' ? message.content : JSON.stringify(message && message.content || '');
      const calls = Array.isArray(message && message.tool_calls) && message.tool_calls.length ? `\n[工具调用] ${JSON.stringify(message.tool_calls)}` : '';
      return `【${role}】\n${content}${calls}`;
    }).join('\n\n');
    const splitTranscript = block => {
      const parts = block.map(message => transcriptText([message]));
      const text = parts.join('\n\n');
      let position = 0;
      const spans = parts.map((part, index) => { const span = { start: position, end: position + part.length + 2, source: sourceIndexes && sourceIndexes.get(block[index]), role: summaryTaskSourceRole(block[index]) }; position = span.end; return span; });
      const pieces = [];
      let offset = 0;
      while (offset < text.length) {
        const current = sourceIndexes && spans.find(span => span.start <= offset && offset < span.end);
        // Only the message containing the fragment start needs a repeated marker. Later messages
        // already have inline markers, so a huge tool loop cannot create a huge header on every page.
        const sourceHeader = current ? `\n[source at fragment start: ${current.source}; role=${current.role}]` : '';
        // Binary-search the largest lossless slice that fits. Transcript content ranges from CJK prose
        // (~1.5 chars/token) to JSON/tool output (~3.6 chars/token), so a fixed character ratio either
        // overflows CJK or creates twice as many slow local-model calls for ASCII-heavy histories.
        let low = offset + 1, high = text.length, end = low, row = null;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const candidate = { role: 'user', content: `【超长回合分片】${sourceHeader}\n${text.slice(offset, mid)}` };
          if (estimateHistoryTokens([candidate]) <= budgetTokens) { end = mid; row = candidate; low = mid + 1; }
          else high = mid - 1;
        }
        // The kernel checks actual payload budgets before dispatch. If even one character cannot fit,
        // return one oversized node for that check instead of making an unbounded one-character loop.
        if (!row) { end = text.length; row = { role: 'user', content: `【超长回合分片】${sourceHeader}\n${text.slice(offset)}` }; }
        const atomicEnd = PrivacyGateway.referenceSafeSliceEnd(text, offset, end);
        if (atomicEnd !== end) { end = atomicEnd; row = { role: 'user', content: `【超长回合分片】${sourceHeader}\n${text.slice(offset, end)}` }; }
        const piece = [row];
        if (sourceIndexes) piece.summarySources = spans.filter(span => span.start < end && span.end > offset).map(span => span.source);
        pieces.push(piece);
        offset = end;
      }
      return pieces;
    };
    const chunks = [];
    let cur = [], curTokens = 0;
    for (const b of blocks) {
      const t = estimateHistoryTokens(b);
      if (t > budgetTokens) {
        if (cur.length) { chunks.push(cur); cur = []; curTokens = 0; }
        chunks.push(...splitTranscript(b));
        continue;
      }
      if (cur.length && curTokens + t > budgetTokens) { chunks.push(cur); cur = []; curTokens = 0; }
      cur.push(...b); curTokens += t;
    }
    if (cur.length) chunks.push(cur);
    if (sourceIndexes) for (const chunk of chunks) if (!chunk.summarySources) chunk.summarySources = chunk.map(message => sourceIndexes.get(message)).filter(Boolean);
    return chunks;
  }

  // econSummaryCall 记账的开关缓存(22-§4.2 第0步):摘要/压缩调用也要落 econ_summary_call,否则报表
  // callsPerTask 系统性漏掉它们。现行摘要路径(下方 map-reduce 内核)在每次真实 HTTP 尝试时记账。
  let ECON_AUX_FLAG_CACHE = { at: 0, on: false };
  async function economicsShadowEnabledCached() { // 60s 内缓存,避免压缩路径上反复读盘
    if (Date.now() - ECON_AUX_FLAG_CACHE.at < 60000) return ECON_AUX_FLAG_CACHE.on;
    try {
      const cfg = await readConfig();
      ECON_AUX_FLAG_CACHE = { at: Date.now(), on: cfg && cfg.toolEconomicsShadowV1 === true };
    } catch { /* keep previous cached value */ }
    return ECON_AUX_FLAG_CACHE.on;
  }

  // 摘要成功出口的统一后置检查:返回要采用的 sc(原稿或修补稿)。任何内部异常都必须原样返回原稿。
  async function applySummaryEntityCheck(provider, history, sc, model, opts) {
    try {
      const aux = (opts && opts.auxCtx) || {};
      const teleBase = {
        ...(aux.sessionId ? { sessionId: String(aux.sessionId) } : {}),
        ...(aux.turnSeq != null ? { turnSeq: Number(aux.turnSeq) } : {}),
        ...(aux.subagentId ? { subagentId: String(aux.subagentId) } : {}),
        trigger: String(aux.trigger || 'summary'),
      };
      const entities = extractSummaryEntities(summarySourceText(history));
      const minSamples = Number.isFinite(SUMMARY_ENTITY_RULES.minSamples) ? SUMMARY_ENTITY_RULES.minSamples : 4;
      const tele = o => { try { logEvent({ kind: 'summary_entity_check', ...teleBase, sampled: entities.length, ...o }); } catch { /* 遥测绝不阻断 */ } };
      if (entities.length < minSamples) { tele({ outcome: 'skipped_few_samples' }); return sc; }
      const missing = checkSummaryEntities(sc.summary, entities);
      if (!missing.length) { tele({ outcome: 'pass' }); return sc; }
      // 恰好一次定向修补:输入 = 当前摘要 + 缺失清单,prompt 用规则里的 repairPrompt;不重发全量历史。
      const repairMessages = [{ role: 'user', content: '【当前摘要】\n' + sc.summary + '\n\n【遗漏的必须保留事实】\n' + missing.map(v => '- ' + v).join('\n') }];
      const taskEvidence = summaryTaskEvidenceMessage(sc.taskEvidence);
      if (taskEvidence) repairMessages.push(taskEvidence);
      const repairBase = String(SUMMARY_ENTITY_RULES.repairPrompt || '');
      const repairPrompt = taskEvidence ? summaryTaskEvidenceScope(opts && opts.config) + '\n' + repairBase : repairBase;
      const inputBudget = sc.mapReduce && sc.mapReduce.taskEvidence && sc.mapReduce.taskEvidence.inputBudgetTokens;
      if (inputBudget && estimateHistoryTokens([{ role: 'system', content: renderProviderStablePrompt({ provider, model, cwd: '', identityOnly: true }) }, ...repairMessages, { role: 'user', content: repairPrompt }]) > inputBudget) { tele({ outcome: 'repair_skipped_budget', missingCount: missing.length }); return sc; }
      const ectx = {
        econ: await economicsShadowEnabledCached(),
        ...teleBase,
        trigger: teleBase.trigger + '_entity_repair',
        summaryStage: 'repair',
      };
      const rc = await singleSummaryCall(provider, repairMessages, model, ectx, repairPrompt, summaryStopSignal(opts));
      if (!rc || !rc.ok) { tele({ outcome: 'repair_failed', missingCount: missing.length, missingSample: missing.slice(0, 8) }); return sc; }
      if (!validateStructuredSummary(rc.summary)) { tele({ outcome: 'repair_rejected', missingCount: missing.length, missingSample: missing.slice(0, 8) }); return sc; }
      // 采用修补稿:usage 聚合进 sc(修补成本计入本次压缩台账),即便仍有缺失也不再二次重试。
      const stillMissing = checkSummaryEntities(rc.summary, entities);
      if (rc.usage) {
        const prev = sc.usage || {};
        sc.usage = {
          prompt_tokens: (Number(prev.prompt_tokens != null ? prev.prompt_tokens : prev.input_tokens) || 0) + (Number(rc.usage.prompt_tokens != null ? rc.usage.prompt_tokens : rc.usage.input_tokens) || 0),
          completion_tokens: (Number(prev.completion_tokens != null ? prev.completion_tokens : prev.output_tokens) || 0) + (Number(rc.usage.completion_tokens != null ? rc.usage.completion_tokens : rc.usage.output_tokens) || 0),
          aggregated: true,
        };
      }
      sc.promptTokensEst = (Number(sc.promptTokensEst) || 0) + (Number(rc.promptTokensEst) || 0);
      sc.summary = stripSummaryTaskEvidence(rc.summary);
      sc.entityCheck = { sampled: entities.length, missing: missing.length, stillMissing: stillMissing.length, repaired: true };
      tele({ outcome: 'repaired', missingCount: missing.length, stillMissingCount: stillMissing.length, missingSample: missing.slice(0, 8) });
      return sc;
    } catch { return sc; }
  }

  async function providerSummaryCallCore(provider, history, opts) {
    // 回合的停止信号(opts.signal):一路传到每一次摘要请求(singleSummaryCall 的 extraSignal),Stop 当场取消在飞的
    // 摘要调用,而不是让回合在迭代边界上干等几十秒到几分钟。已经停了就一次都不发。
    const stopSignal = summaryStopSignal(opts);
    if (stopSignal && stopSignal.aborted) return summaryStoppedResult();
    const base = providerBaseWithV1(provider.baseUrl);
    const model = String((opts && opts.model) || provider.model || (provider.models && provider.models[0] && provider.models[0].id) || '').trim();
    if (!base || !model || typeof fetch !== 'function') {
      return { ok: false, error: !base ? 'provider base URL is not set' : (!model ? 'no model selected for this provider' : 'fetch unavailable') };
    }
    // 45f 对抗轮 P3-6:无 user 消息的 history 不做摘要 —— 空摘要会把整段历史静默抹成一段「无内容」。
    if (!userBlockStarts(history).length) return { ok: false, error: 'no user turns to summarize' };
    // The selected compactor may be a non-active Provider, so normal /api/models refresh never probed it.
    // Probe on demand before budgeting; Ollama is enriched through native /api/show by fetchOpenAiModels.
    if (resolveContextWindow(provider, model).source === 'fallback') await fetchOpenAiModels(provider, 8000).catch(() => null);
    // 45a:摘要输入预算 = 窗口 × 50%(余量留给输出+系统层;窗口缺省 64K 时预算 32K)。
    // 105f:开关开时预算 = 窗口 − reserve(分量见 summarySingleShotReserveTokens),余量不再一刀切半价。
    const singleOn = summarySingleShotEnabled(opts && opts.config);
    const summaryWindow = providerContextWindow(provider, model);
    const budget = Math.max(4000, singleOn
      ? summaryWindow - summarySingleShotReserveTokens(opts && opts.config)
      : Math.floor(summaryWindow * SUMMARY_INPUT_BUDGET_RATIO));
    const fitted = fitHistoryForSummary(history, budget);
    // 22-S0 摘要归属上下文:econ 标志读一次,身份字段由调用方经 opts.auxCtx 提供(缺失→不落 sessionId/turnSeq)。
    const ectxBase = {
      econ: await economicsShadowEnabledCached(),
      ...(opts && opts.auxCtx ? {
        ...(opts.auxCtx.sessionId ? { sessionId: String(opts.auxCtx.sessionId) } : {}),
        ...(opts.auxCtx.turnSeq != null ? { turnSeq: Number(opts.auxCtx.turnSeq) } : {}),
        ...(opts.auxCtx.traceId ? { traceId: String(opts.auxCtx.traceId) } : {}),
        ...(opts.auxCtx.subagentId ? { subagentId: String(opts.auxCtx.subagentId) } : {}),
        trigger: String(opts.auxCtx.trigger || 'summary'),
      } : { trigger: 'summary' }),
    };
    // 116f: opts.promptOverride —— 调用方指定的摘要 prompt(唯一使用者:管家会话的 steward.visitNotes)。
    // singleSummaryCall 早有这个形参(105c 的定向修补在用),这里只是把它开到内核入参上。
    // 覆盖时【跳过】validateStructuredSummary:那道校验钉的是 SUMMARY_PROMPT 的中文三节标题,
    // 换了 prompt 再拿它判就是必然误判。不传时下面两处与本切片之前逐字节一致。
    const promptOverride = (opts && typeof opts.promptOverride === 'string' && opts.promptOverride) ? opts.promptOverride : '';
    const singleEstimate = estimateHistoryTokens(Array.isArray(fitted.messages) ? fitted.messages : []);
    // 105f:开关开时上限走可配置档位(默认 32K≈旧常量),关时保持 22-S0 常量 32000 逐字节不变。
    const singleCap = singleOn ? summarySingleShotCap(opts && opts.config, provider, model) : SUMMARY_SINGLE_SHOT_MAX_EST;
    const forceChunks = !fitted.needsMapReduce && singleEstimate > singleCap; // 肥单发 → 分块,让每次真实尝试远离超时悬崖
    let degradedFromSingle = false;
    if (!fitted.needsMapReduce && !forceChunks) {
      const sc = await singleSummaryCall(provider, fitted.messages, model, ectxBase, promptOverride || undefined, stopSignal, opts && opts.config);
      if (sc.ok && fitted.droppedMiddle) sc.droppedMiddle = fitted.droppedMiddle;
      if (sc.ok && !promptOverride && !validateStructuredSummary(sc.summary)) return { ok: false, error: 'structured summary validation failed (missing sections); 降级保留原文' };
      // 105f:仅【可识别的上下文超窗 400】(isContextOverflowError 共现语义,宁可漏判不误判)自动降级
      // map-reduce;其余失败(超时/5xx/非超窗 400/校验失败)原样上浮,调用方保留 L1 降级。失败调用
      // 已由 singleSummaryCall 的 econ 账目计入成本(105 总门「额外失败调用计入成本」)。
      if (sc.ok || !singleOn || !isContextOverflowError(sc.error)) return sc;
      degradedFromSingle = true;
    }
    // map-reduce:分组 → 逐组摘要 → 总摘要。任一组失败即整体失败(错误原样上浮,调用方保留 L1 降级)。
    let chunks = chunkHistoryByBudget(history, (forceChunks || degradedFromSingle)
      ? Math.min(budget, Math.max(4000, Math.floor(singleCap * 0.75))) // 22-S0:肥单发分块时压低每组目标;105f 400 降级同目标(单发已证明该量级越窗)
      : budget);
    if (chunks.length <= 1) {
      const sc = await singleSummaryCall(provider, chunks[0] || [], model, ectxBase, promptOverride || undefined, stopSignal, opts && opts.config);
      if (sc.ok && !promptOverride && !validateStructuredSummary(sc.summary)) return { ok: false, error: 'structured summary validation failed (missing sections); 降级保留原文' };
      return sc;
    }
    // 105g: 开关开且真实分块时构建全局事实表注入消息(确定性抽取,零新增 LLM 调用);
    // 开关关时两条消息皆 null,分段/汇总请求体与现状逐字节一致。
    const factTable = summaryFactTableEnabled(opts && opts.config)
      ? buildSummaryFactTableMessages(history, summaryFactTableCap(opts && opts.config))
      : null;
    const factChunkMsg = factTable && factTable.chunk;
    const factReduceMsg = factTable && factTable.reduce;
    // Custom summaries (the steward's visit notes) keep their own format and do not acquire task markers.
    const taskSources = promptOverride ? null : summaryTaskSourceHistory(history);
    const mapPrompt = taskSources ? summaryTaskEvidenceScope(opts && opts.config) + '\n' + summaryPromptWithGuidance(opts && opts.config) + '\n' + summaryTaskEvidenceDirective(opts && opts.config, 'map') : (promptOverride || summaryPromptWithGuidance(opts && opts.config));
    const reducePrompt = taskSources ? summaryTaskEvidenceScope(opts && opts.config) + '\n' + summaryPromptWithGuidance(opts && opts.config) + '\n' + summaryTaskEvidenceDirective(opts && opts.config, 'reduce') : mapPrompt;
    const systemTokens = estimateHistoryTokens([{ role: 'system', content: renderProviderStablePrompt({ provider, model, cwd: '', identityOnly: true }) }]);
    const stageRoom = (prompt, fact) => budget - systemTokens - estimateHistoryTokens([{ role: 'user', content: prompt }, ...(fact ? [fact] : [])]);
    const mapRoom = stageRoom(mapPrompt, factChunkMsg);
    const reduceRoom = stageRoom(reducePrompt, factReduceMsg);
    if (mapRoom <= 0 || reduceRoom <= 0) return { ok: false, error: 'summary instructions exceed input budget; preserving original history' };
    chunks = chunkHistoryByBudget(taskSources ? taskSources.messages : history,
      Math.min(mapRoom, (forceChunks || degradedFromSingle) ? Math.max(1, Math.floor(singleCap * 0.75)) : mapRoom), taskSources && taskSources.indexes);
    if (chunks.some(chunk => estimateHistoryTokens(chunk) > mapRoom)) return { ok: false, error: 'summary source fragment exceeds input budget; preserving original history' };
    let evidenceRejected = 0;
    const adoptMapEvidence = (result, chunk) => {
      if (!result.ok || !taskSources) return result;
      const extracted = extractSummaryTaskEvidence(result.summary, taskSources.sources, chunk);
      evidenceRejected += extracted.rejected;
      result.summary = extracted.summary;
      result.taskEvidence = extracted.evidence;
      return result;
    };
    // 105h: 2–4 块可选顺序 refine。首块先产出累计摘要,后续块逐次修订;每一步都必须通过
    // 五节结构校验。任一步失败不采用半成品,而是从原始 history 完整重跑下方现有 map-reduce。
    // 开关关时本分支零调用、零消息构造,105g 请求序列与请求体逐字节不变。
    const refineMaxChunks = Number.isFinite(Number(SUMMARY_REFINE_RULES.maxChunks)) ? Number(SUMMARY_REFINE_RULES.maxChunks) : 4;
    const refineOn = !promptOverride && summaryRefineEnabled(opts && opts.config) && chunks.length >= 2 && chunks.length <= refineMaxChunks;
    const refineCalls = [];
    let refineFailure = '';
    if (refineOn) {
      let current = adoptMapEvidence(await singleSummaryCall(provider, factChunkMsg ? [...chunks[0], factChunkMsg] : chunks[0], model, { ...ectxBase, chunkIndex: 1, summaryStage: 'refine' }, mapPrompt, stopSignal, opts && opts.config), chunks[0]);
      refineCalls.push(current);
      if (!current.ok) refineFailure = 'request';
      else if (!validateStructuredSummary(current.summary)) refineFailure = 'validation';
      for (let ci = 1; !refineFailure && ci < chunks.length; ci++) {
        const retainedEvidence = current.taskEvidence || [];
        const evidenceMessage = summaryTaskEvidenceMessage(retainedEvidence);
        const refineMessages = buildSummaryRefineMessages(current.summary, chunks[ci], factReduceMsg);
        if (evidenceMessage) refineMessages.push(evidenceMessage);
        const refinePrompt = summaryTaskEvidenceScope(opts && opts.config) + '\n' + String(SUMMARY_REFINE_RULES.prompt || SUMMARY_PROMPT) + '\n' + summaryTaskEvidenceDirective(opts && opts.config, 'refine');
        if (systemTokens + estimateHistoryTokens([...refineMessages, { role: 'user', content: refinePrompt }]) > budget) { refineFailure = 'budget'; break; }
        current = await singleSummaryCall(
          provider,
          refineMessages,
          model,
          { ...ectxBase, chunkIndex: ci + 1, summaryStage: 'refine' },
          refinePrompt,
          stopSignal,
          opts && opts.config,
        );
        adoptMapEvidence(current, chunks[ci]);
        current.taskEvidence = mergeSummaryTaskEvidence(retainedEvidence, current.taskEvidence || []);
        refineCalls.push(current);
        if (!current.ok) refineFailure = 'request';
        else if (!validateStructuredSummary(current.summary)) refineFailure = 'validation';
      }
      if (refineFailure && stopSignal && stopSignal.aborted) return summaryStoppedResult();
      if (!refineFailure) {
        aggregateSummaryCalls(current, refineCalls);
        current.mapReduce = {
          chunks: chunks.length,
          rounds: Math.max(1, chunks.length - 1),
          refine: { steps: chunks.length, calls: refineCalls.length },
          taskEvidence: { entries: (current.taskEvidence || []).length, rejected: evidenceRejected, inputBudgetTokens: budget },
          ...(degradedFromSingle ? { degradedFromSingle: true } : {}),
          ...(factTable && factTable.entities ? { factTable: { entities: factTable.entities } } : {}),
        };
        return current;
      }
    }
    // 分段数量多时，直接拼接 partials 会再次越过摘要输入预算。逐轮把摘要按同一
    // user-block 预算分组，直到可以安全地单发总摘要；最多 12 轮，防止异常模型输出
    // 不收敛时无限调用。每轮仍复用同一个结构化 SUMMARY_PROMPT。
    const calls = [];
    // 105i: 整个 map-reduce 共用一个 fail-fast 信号 —— 任一块/组失败即取消其余在飞与未派发的请求。
    const failCtrl = typeof AbortController === 'function' ? new AbortController() : null;
    const summaryConcurrency = summaryMaxConcurrent(opts && opts.config, provider, model);
    const rememberCall = async (messages, context, signal, prompt) => {
      const r = await singleSummaryCall(provider, messages, model, context, prompt, anySummarySignal(signal, stopSignal), opts && opts.config);
      calls.push(r);
      return r;
    };
    // 各 chunk 输入互不依赖(事实表消息相同、互不看对方结果),有界并发发出;按块序取首个失败上浮,
    // 保持原串行的失败语义(差异:失败时在飞请求被取消并记账,不再发出未派发的块)。
    const initialCalls = await mapSummaryWithLimit(chunks, summaryConcurrency, (ci) =>
      rememberCall(factChunkMsg ? [...chunks[ci], factChunkMsg] : chunks[ci], { ...ectxBase, chunkIndex: ci + 1, summaryStage: 'map' }, failCtrl && failCtrl.signal, mapPrompt)
        .then(result => { adoptMapEvidence(result, chunks[ci]); result.fromChunk = ci + 1; result.toChunk = ci + 1; return result; }), failCtrl);
    const firstChunkFail = pickSummaryFailure(initialCalls); // 跳过未派发空位,按块序取真实失败
    if (firstChunkFail) return firstChunkFail;
    let partialResults = initialCalls;
    let final = null;
    let reductionLevels = 0;
    for (let round = 0; round < 12 && partialResults.length > 1; round++) {
      reductionLevels++;
      const rows = partialResults.map((r, i) => ({
        role: 'user',
        content: `【分段摘要 ${r.fromChunk || i + 1}-${r.toChunk || i + 1}/${chunks.length}】\n${taskSources ? stripSummaryTaskEvidence(r.summary) : r.summary}`
          + (r.taskEvidence && r.taskEvidence.length ? '\n\n' + summaryTaskEvidenceMessage(r.taskEvidence).content : ''),
      }));
      // Splitting an oversized evidence-bearing node would orphan its source references. Refuse rather
      // than silently discard early unfinished work; ordinary pasted documents are NOT carried here.
      if (rows.some(row => estimateHistoryTokens([row]) > reduceRoom)) return { ok: false, error: 'task evidence or partial summary exceeds reduction input budget; preserving original history' };
      const byRow = new Map(rows.map((row, index) => [row, partialResults[index]]));
      const groups = chunkHistoryByBudget(rows, reduceRoom);
      // 同一轮内各归并组互不依赖,有界并发;轮次之间仍串行(下一轮输入依赖本轮输出)。
      const next = await mapSummaryWithLimit(groups, summaryConcurrency, async gi => {
        const nodes = groups[gi].map(row => byRow.get(row));
        const result = await rememberCall([...groups[gi], ...(factReduceMsg ? [factReduceMsg] : [])],
          { ...ectxBase, chunkIndex: 1000 + (round * 100) + gi + 1, summaryStage: 'reduce' }, failCtrl && failCtrl.signal, reducePrompt);
        result.taskEvidence = mergeSummaryTaskEvidence(...nodes.map(node => node.taskEvidence || []));
        result.fromChunk = nodes[0].fromChunk; result.toChunk = nodes.at(-1).toChunk;
        if (taskSources) result.summary = stripSummaryTaskEvidence(result.summary);
        return result;
      }, failCtrl);
      const firstGroupFail = pickSummaryFailure(next);
      if (firstGroupFail) return firstGroupFail;
      partialResults = next;
      if (groups.length === 1) { final = next[0]; break; }
    }
    if (!final && partialResults.length === 1) final = partialResults[0];
    if (!final) return { ok: false, error: 'map-reduce consolidation did not converge; 降级保留原文' };
    if (!final.ok) return final;
    if (!promptOverride && !validateStructuredSummary(final.summary)) return { ok: false, error: 'structured summary validation failed (missing sections); 降级保留原文' };
    // 所有 refine 尝试(若有)与 reduce 轮都纳入一次压缩的 aux 用量，避免降级后把额外尝试成本藏掉。
    aggregateSummaryCalls(final, [...refineCalls, ...calls]);
    final.mapReduce = {
      chunks: chunks.length,
      rounds: Math.max(1, calls.length - chunks.length),
      concurrency: summaryConcurrency,
      reductionLevels,
      taskEvidence: { entries: (final.taskEvidence || []).length, rejected: evidenceRejected, inputBudgetTokens: budget },
      ...(degradedFromSingle ? { degradedFromSingle: true } : {}),
      ...(refineFailure ? { degradedFromRefine: true, refineCalls: refineCalls.length, refineFailure } : {}),
      ...(factTable && factTable.entities ? { factTable: { entities: factTable.entities } } : {}),
    };
    return final;
  }

  // 105c: 实体抽检 wrapper —— providerSummaryCallCore 的唯一出口增强点。开关关/摘要不成功/抽检内部异常
  // 都原样透传;只有 sc.ok 且显式开启时才做抽样检查与一次定向修补(见 applySummaryEntityCheck)。
  async function providerSummaryCall(provider, history, opts) {
    if (opts?.privacyHistoryOwner) history = await PrivacyGateway.protectHostHistory(opts.privacyHistoryOwner, history);
    const sc = await providerSummaryCallCore(provider, history, opts);
    // 失败发生在回合被停之后 = 是停止取消了它(fetch 的 AbortError 会被 singleSummaryCall 记成超时/兄弟块失败):统一标
    // aborted,调用方据此不把它算成「摘要服务坏了」(不进冷却、不武装滞回水位)。
    if ((!sc || !sc.ok) && summaryStopSignal(opts) && summaryStopSignal(opts).aborted) return { ...(sc || {}), ...summaryStoppedResult() };
    if (!sc || !sc.ok) return sc;
    if (!(opts && opts.promptOverride)) sc.summary = stripSummaryTaskEvidence(sc.summary);
    if (!summaryEntityCheckEnabled(opts && opts.config)) { delete sc.taskEvidence; return sc; }
    const model = String(sc.model || (opts && opts.model) || (provider && provider.model) || '').trim();
    const checked = await applySummaryEntityCheck(provider, history, sc, model, opts);
    if (!(opts && opts.promptOverride)) checked.summary = stripSummaryTaskEvidence(checked.summary);
    delete checked.taskEvidence;
    return checked;
  }

  return {
    providerSummaryCall, fitHistoryForSummary, chunkHistoryByBudget,
    summarySingleShotCap, summarySingleShotReserveTokens, resolveSummaryCallPolicy,
  };
}

module.exports = { createProviderSummary, pickSummaryFailure, buildSummaryRefineMessages, summaryMaxConcurrent, mapSummaryWithLimit };
