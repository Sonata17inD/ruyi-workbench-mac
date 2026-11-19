'use strict';

const CONTEXT_GOVERNANCE_RULES = require('./context-governance-rules.json');
const { cachedInputTokensFromUsage } = require('./provider-pricing.cjs');
const { renderProviderStablePrompt } = require('./provider-stable-prompt.cjs');
const { redact } = require('./secret-redaction.cjs');
const { summaryPromptWithGuidance } = require('./summary-format.cjs');

function aggregateSummaryCalls(target, calls) {
  let aggIn = 0, aggOut = 0, aggEst = 0;
  for (const r of (Array.isArray(calls) ? calls : [])) {
    if (r && r.usage) {
      aggIn += Number(r.usage.prompt_tokens != null ? r.usage.prompt_tokens : r.usage.input_tokens) || 0;
      aggOut += Number(r.usage.completion_tokens != null ? r.usage.completion_tokens : r.usage.output_tokens) || 0;
    }
    aggEst += Number(r && r.promptTokensEst) || 0;
  }
  if (aggIn > 0 || aggOut > 0) target.usage = { prompt_tokens: aggIn, completion_tokens: aggOut, aggregated: true };
  target.promptTokensEst = aggEst;
  return target;
}

function createSummaryRequest({
  providerWireProtocol, normalizeProviderApiStyle, isContextOverflowError, estimateHistoryTokens,
  PrivacyGateway, DesktopExecutionHooks, logEvent,
}) {
  // 摘要请求策略不是用户配置:它只由版本化规则、协议和模型名决定。未知模型/自定义端点故意不发送
  // reasoning/max-output 字段,以保持 OpenAI-compatible 的最低公约数;已知能力在正常请求中被动验证,
  // 明确的参数拒绝只触发一次移除参数的兼容重试并在进程内记忆。与 provider.reasoningEffort 分离,
  // 因而不会把用户给主回合的推理档位硬套到摘要回路。
  const SUMMARY_CALL_POLICY_RULE = CONTEXT_GOVERNANCE_RULES.summary.callPolicy || {
    unknown: { reasoning: 'omit', outputField: 'omit' },
    defaultTiers: { map: [4096, 6144], refine: [6144, 8192], reduce: [6144, 8192], single: [6144, 8192], repair: [6144, 8192] },
    models: [{ match: 'deepseek-v4', reasoning: { mode: 'effort', supported: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], preferred: 'minimal' }, output: { responses: 'max_output_tokens', chat: 'max_tokens' } }],
  };
  const SUMMARY_POLICY_STAGES = new Set(['map', 'refine', 'reduce', 'single', 'repair']);
  const SUMMARY_EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const SUMMARY_CALL_CAP_CACHE = new Map();
  function summaryCallPolicyKey(provider, model, apiStyle) {
    // baseUrl is part of the capability identity (different gateways can expose different schemas), but the
    // key deliberately contains no api key and is bounded so a malformed custom URL cannot grow the cache.
    const base = String(provider && provider.baseUrl || '').trim().toLowerCase().slice(0, 400);
    return [String(provider && provider.id || '').slice(0, 80), String(model || '').slice(0, 120), normalizeProviderApiStyle(apiStyle), base].join('\u0000');
  }
  function summaryModelPolicy(model) {
    const m = String(model || '').trim().toLowerCase();
    const rows = Array.isArray(SUMMARY_CALL_POLICY_RULE.models) ? SUMMARY_CALL_POLICY_RULE.models : [];
    return rows.find(row => row && String(row.match || '').trim() && m.includes(String(row.match).trim().toLowerCase())) || null;
  }
  function summaryEffortFromRule(rule) {
    const r = rule && rule.reasoning;
    if (!r || r.mode !== 'effort' || !Array.isArray(r.supported)) return { mode: 'omit' };
    const supported = [...new Set(r.supported.map(v => String(v || '').trim().toLowerCase()).filter(v => SUMMARY_EFFORT_ORDER.includes(v)))];
    if (!supported.length) return { mode: 'omit' };
    const preferred = String(r.preferred || '').trim().toLowerCase();
    const value = supported.includes(preferred) ? preferred : SUMMARY_EFFORT_ORDER.find(v => supported.includes(v));
    return value ? { mode: 'effort', value } : { mode: 'omit' };
  }
  function summaryPolicyTiers(stage) {
    const defaults = SUMMARY_CALL_POLICY_RULE.defaultTiers || {};
    const raw = Array.isArray(defaults[stage]) ? defaults[stage] : (Array.isArray(defaults.single) ? defaults.single : [6144, 8192]);
    const tiers = raw.map(Number).filter(v => Number.isFinite(v) && v >= 512).map(v => Math.round(v));
    return tiers.length ? [...new Set(tiers)] : [6144, 8192];
  }
  function resolveSummaryCallPolicy(provider, model, apiStyle, stage) {
    const normalizedStyle = normalizeProviderApiStyle(apiStyle);
    const normalizedStage = SUMMARY_POLICY_STAGES.has(stage) ? stage : 'single';
    const modelRule = summaryModelPolicy(model);
    const key = summaryCallPolicyKey(provider, model, normalizedStyle);
    const cached = SUMMARY_CALL_CAP_CACHE.get(key) || {};
    const reasoning = cached.reasoningUnsupported ? { mode: 'omit' } : summaryEffortFromRule(modelRule);
    const configuredField = modelRule && modelRule.output && modelRule.output[normalizedStyle];
    const outputField = cached.outputUnsupported ? '' : (typeof configuredField === 'string' ? configuredField : '');
    const tiers = summaryPolicyTiers(normalizedStage);
    return {
      key,
      known: !!modelRule,
      apiStyle: normalizedStyle,
      stage: normalizedStage,
      reasoning,
      output: { field: outputField, tiers, tierIndex: 0 },
    };
  }
  function summaryCallPolicyMetadata(policy) {
    return {
      knownModel: !!(policy && policy.known),
      stage: policy && policy.stage || 'single',
      reasoning: policy && policy.reasoning && policy.reasoning.mode === 'effort' ? policy.reasoning.value : 'omit',
      outputField: policy && policy.output && policy.output.field || 'omit',
      outputTokens: policy && policy.output && policy.output.field ? policy.output.tiers[policy.output.tierIndex] : undefined,
    };
  }
  function markSummaryCallPolicyUnsupported(policy, fields) {
    if (!policy || !policy.key || !Array.isArray(fields) || !fields.length) return;
    const hit = SUMMARY_CALL_CAP_CACHE.get(policy.key) || {};
    if (fields.includes('reasoning')) hit.reasoningUnsupported = true;
    if (fields.includes('output')) hit.outputUnsupported = true;
    SUMMARY_CALL_CAP_CACHE.set(policy.key, hit);
  }
  function summaryUnsupportedParameterFields(status, detail, policy) {
    if (!(Number(status) === 400 || Number(status) === 422) || !policy) return [];
    const text = String(detail || '');
    if (!text || isContextOverflowError(text)) return [];
    const fields = [];
    const outputField = policy.output && policy.output.field;
    if (outputField && new RegExp(`\\b${outputField.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i').test(text)) fields.push('output');
    if (policy.reasoning && policy.reasoning.mode !== 'omit' && /reasoning(?:_effort)?|\beffort\b|\bthinking\b/i.test(text)) fields.push('reasoning');
    if (fields.length) return [...new Set(fields)];
    // Some gateways only say "unknown parameter". Remove all controls once, but never on a context error.
    if (/(unsupported|not\s+support(?:ed)?|unknown|invalid).{0,50}(parameter|field|argument)|(?:parameter|field|argument).{0,50}(unsupported|not\s+support(?:ed)?|unknown|invalid)/i.test(text)) {
      if (outputField) fields.push('output');
      if (policy.reasoning && policy.reasoning.mode !== 'omit') fields.push('reasoning');
    }
    return [...new Set(fields)];
  }
  function applySummaryCallPolicy(body, policy) {
    if (!body || typeof body !== 'object' || !policy) return body;
    if (policy.reasoning && policy.reasoning.mode === 'effort' && policy.reasoning.value) {
      providerWireProtocol(policy.apiStyle).applyEffort(body, policy.reasoning.value);
    }
    const out = policy.output || {};
    const value = out.field && Array.isArray(out.tiers) ? out.tiers[out.tierIndex] : 0;
    if (out.field && Number.isFinite(value) && value > 0) body[out.field] = value;
    return body;
  }

  // 105j: summary call policy-aware implementation. It keeps the historical six-argument signature while all
  // callers gain the same bounded reasoning/output policy and one-shot compatibility fallback.
  async function singleSummaryCall(provider, messages, model, econCtx, promptOverride, extraSignal, config) {
    const wire = providerWireProtocol(provider); // 58 号批 1:端点、请求头、请求体、回体解析都问协议登记表
    const summaryPrompt = typeof promptOverride === 'string' && promptOverride ? promptOverride : summaryPromptWithGuidance(config);
    const chatUrl = wire.completionUrl(provider.baseUrl);
    const headers = wire.requestHeaders(provider, { model });
    const sysIdentity = renderProviderStablePrompt({ provider, model, cwd: '', identityOnly: true });
    const stage = econCtx && SUMMARY_POLICY_STAGES.has(econCtx.summaryStage)
      ? econCtx.summaryStage
      : (promptOverride ? 'repair' : ((econCtx && Number(econCtx.chunkIndex) >= 1000) ? 'reduce' : ((econCtx && econCtx.chunkIndex != null) ? 'map' : 'single')));
    const policy = resolveSummaryCallPolicy(provider, model, wire.id, stage);
    const makeBody = () => {
      const body = wire.encodeMessages({ model, messages: [{ role: 'system', content: sysIdentity }, ...messages, { role: 'user', content: summaryPrompt }], stream: false, instructions: sysIdentity, provider });
      applySummaryCallPolicy(body, policy);
      const temp = (provider.temperature !== '' && provider.temperature != null && Number.isFinite(Number(provider.temperature))) ? Number(provider.temperature) : undefined;
      wire.applyTemperature(body, temp);
      return body;
    };
    if (!chatUrl || !model || typeof fetch !== 'function') {
      return { ok: false, error: !chatUrl ? 'provider base URL is not set' : (!model ? 'no model selected for this provider' : 'fetch unavailable'), summaryPolicy: summaryCallPolicyMetadata(policy) };
    }
    let timeoutMs = 180000;
    try {
      const u = new URL(String(provider && provider.baseUrl || ''));
      if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname) || /ollama/i.test(String(provider && (provider.id + ' ' + provider.label) || ''))) timeoutMs = 300000;
    } catch { /* retain remote default */ }
    const attempts = [];
    let compatibilityRetried = false;
    let outputRetried = false;
    const finish = result => {
      const out = { ...result, summaryPolicy: { ...summaryCallPolicyMetadata(policy), retries: Math.max(0, attempts.length - 1) } };
      if (attempts.length > 1) aggregateSummaryCalls(out, attempts);
      return out;
    };
    while (true) {
      const bodyObj = makeBody();
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs) : null;
      const econT0 = Date.now();
      const econDone = result => {
        try {
          if (!econCtx || econCtx.econ !== true) return;
          const u = result && result.usage;
          const uIn = u ? (Number(u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens) || 0) : 0;
          const uOut = u ? (Number(u.completion_tokens != null ? u.completion_tokens : u.output_tokens) || 0) : 0;
          const okRes = !!(result && result.ok);
          const hasUsage = uIn > 0 || uOut > 0;
          logEvent({
            kind: 'econ_summary_call',
            ...(econCtx.sessionId ? { sessionId: econCtx.sessionId } : {}),
            ...(econCtx.turnSeq != null && Number(econCtx.turnSeq) > 0 ? { turnSeq: Number(econCtx.turnSeq) } : {}),
            ...(econCtx.traceId ? { traceId: String(econCtx.traceId) } : {}),
            ...(econCtx.subagentId ? { subagentId: String(econCtx.subagentId) } : {}),
            trigger: String(econCtx.trigger || 'summary'),
            model: String(model || ''), apiStyle: wire.id, ok: okRes,
            usageSource: okRes && hasUsage ? 'provider' : 'missing', inputTokens: uIn, outputTokens: uOut,
            ...(okRes && hasUsage ? { cachedInputTokens: Math.min(uIn, cachedInputTokensFromUsage(u)) } : {}),
            ...(econCtx.chunkIndex ? { mapReduceChunk: Number(econCtx.chunkIndex) } : {}), httpMs: Date.now() - econT0,
          });
        } catch { /* shadow accounting must never break compaction */ }
      };
      const mergedSignal = ctrl
        ? (extraSignal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function' ? AbortSignal.any([ctrl.signal, extraSignal]) : ctrl.signal)
        : (extraSignal || undefined);
      try {
        const requestBody = await PrivacyGateway.beforeModelRequest(bodyObj);
        await DesktopExecutionHooks.beforeModelRequest(econCtx?.sessionId);
        PrivacyGateway.assertPolicyAvailable();
        const res = await fetch(chatUrl, { method: 'POST', headers, body: JSON.stringify(requestBody), signal: mergedSignal });
        if (!res || !res.ok) {
          let d = ''; if (res) { try { d = await res.text(); } catch { /* ignore */ } }
          const detail = `HTTP ${res ? res.status : '?'}${d ? ': ' + redact(d.slice(0, 300)) : ''}`;
          const failed = { ok: false, error: detail, promptTokensEst: estimateHistoryTokens(bodyObj.messages || bodyObj.input) };
          const rejected = summaryUnsupportedParameterFields(res && res.status, detail, policy);
          econDone(failed); attempts.push(failed);
          if (!compatibilityRetried && rejected.length) {
            compatibilityRetried = true;
            markSummaryCallPolicyUnsupported(policy, rejected);
            if (rejected.includes('reasoning')) policy.reasoning = { mode: 'omit' };
            if (rejected.includes('output')) policy.output.field = '';
            continue;
          }
          return finish(failed);
        }
        const payload = await res.json().catch(() => null);
        // 105j:非流式回体按协议解析(04i decodeCompletion)。尤其要保留 status/incomplete_details/usage,不能把
        // reasoning-only 或命中输出上限的响应误报成普通 empty summary。
        const decoded = wire.decodeCompletion(payload);
        const summary = decoded.text.trim();
        const usage = decoded.usage;
        const promptTokensEst = estimateHistoryTokens(bodyObj.messages || bodyObj.input);
        let result;
        if (decoded.failed) {
          const detail = decoded.failedDetail;
          result = { ok: false, error: `provider returned failed summary${detail ? ': ' + redact(detail.slice(0, 300)) : ''}`, usage, promptTokensEst };
        } else if (decoded.incomplete) {
          const reason = decoded.incompleteReason;
          result = { ok: false, error: `provider returned an incomplete summary (${reason})`, incomplete: true, usage, promptTokensEst };
        } else if (!summary) {
          result = { ok: false, error: 'provider returned an empty summary', usage, promptTokensEst };
        } else {
          result = { ok: true, summary, usage, model, promptTokensEst };
        }
        econDone(result); attempts.push(result);
        if (result.incomplete && !outputRetried && policy.output && policy.output.field && policy.output.tierIndex < policy.output.tiers.length - 1) {
          outputRetried = true;
          policy.output.tierIndex += 1;
          continue;
        }
        return finish(result);
      } catch (e) {
        const cancelledBySibling = e && e.name === 'AbortError' && extraSignal && extraSignal.aborted && !(ctrl && ctrl.signal.aborted);
        const failed = { ok: false, error: (e && e.name === 'AbortError') ? (cancelledBySibling ? 'summary request cancelled (sibling chunk failed)' : `summary request timed out (${Math.round(timeoutMs / 1000)}s)`) : ((e && e.message) || 'summary request failed'), ...(cancelledBySibling ? { cancelledBySibling: true } : {}) };
        econDone(failed); attempts.push(failed); return finish(failed);
      } finally { if (timer) clearTimeout(timer); }
    }
  }

  return { singleSummaryCall, resolveSummaryCallPolicy };
}

module.exports = { createSummaryRequest, aggregateSummaryCalls };
