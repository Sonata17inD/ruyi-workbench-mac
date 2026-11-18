'use strict';

const { URL } = require('node:url');

// Third-party Anthropic-兼容端点 presets for the CLAUDE CLI engine itself (not a Provider — these fill
// modelsApiBase/modelsApiKey/claudeAuthMode/model, which buildClaudeCliEnv turns into the ACTUAL
// ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN(or API_KEY)/ANTHROPIC_MODEL env for the spawned `claude` child).
// One-click "应用预设" in Settings → Claude CLI fills these instead of requiring manual setx per
// docs/manuals/ADMIN-GUIDE_CN.md §2.1.1. `authKeyHint`/`defaultModelHint` are UI-only placeholders (never
// a real secret) — apiKey always stays whatever the user types.
const CLAUDE_ENDPOINT_PRESETS = [
  // 用户 2026-09-27:火山方舟 Ark Coding Plan 预设已删(厂商预设一律不内置),只留「自定义」。
  {
    id: 'anthropic-compatible', label: '自定义（其它 Anthropic 兼容 / 内网自建端点）',
    baseUrl: '', authMode: 'auto', authKeyHint: '', defaultModel: '', defaultModelHint: '', models: [],
  },
];

// Resolve the ledger source + cost-trust for a Claude CLI turn. modelsApiBase EMPTY = Anthropic direct ->
// source 'claude-cli', CLI total_cost_usd usable as a NOTIONAL USD estimate. NON-EMPTY = a third-party
// Anthropic-compatible endpoint (e.g. a vendor Coding Plan) whose CLI-reported cost is computed with
// ANTHROPIC pricing and is therefore WRONG for that vendor (and often a flat monthly plan) -> record tokens
// only, cost null, costTrusted false, and tag the source by its known preset id (else host) so grouping stays
// honest (Claude 官方 vs 第三方端点).
function claudeLedgerSource(config) {
  let base = (config && typeof config.modelsApiBase === 'string') ? config.modelsApiBase.trim() : '';
  // v1.4-OSS 用量看板(补): 当 config.modelsApiBase 为空时,CLI 子进程仍会继承 OS 环境里的 ANTHROPIC_BASE_URL /
  // ANTHROPIC_BASE(effectiveAnthropicEnv 只在 modelsApiBase 非空时覆盖它们,否则原样穿透)。纯用环境变量把
  // Claude CLI 路由到第三方端点时,CLI 报的 total_cost_usd 仍按 Anthropic 计价、对该厂商不可信 —— 据此把
  // costTrusted 判为 false,与显式 modelsApiBase 的第三方路径一致。
  if (!base) base = String(process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE || '').trim();
  if (!base) return { provider: 'claude-cli', costTrusted: true };
  let tag = '';
  try {
    for (const p of CLAUDE_ENDPOINT_PRESETS) { if (p && p.baseUrl && base.startsWith(p.baseUrl)) { tag = p.id; break; } }
    if (!tag) tag = 'claude-endpoint:' + new URL(base).host;
  } catch { tag = 'claude-endpoint:unknown'; }
  return { provider: tag, costTrusted: false };
}

// v1.4-OSS 用量看板(补): shared Claude-turn billing-field resolver. Extracted from the main-turn ledger append
// so BOTH the main chat turn AND a Claude sub-agent node bill identically. Cost precedence (诚实计费):
//  (1) config.claudePricing set -> tokens×price, a meaningful estimate for direct + third-party endpoints,
//      costTrusted:true; (2) else, Anthropic-direct only (claudeLedgerSource costTrusted), the CLI's reported
//      total_cost_usd as a NOTIONAL USD figure; (3) else (third-party, unpriced) cost null + costTrusted false
//      (its CLI cost is Anthropic-priced and wrong for that vendor, often a flat monthly plan not billed per token).
function claudeCostFields(config, inTok, outTok, costUsd) {
  const { provider, costTrusted: directTrust } = claudeLedgerSource(config);
  let cost = null, currency = null, costTrusted = directTrust;
  const priced = computeCostFromPricing(config && config.claudePricing, inTok, outTok);
  if (priced.currency) { cost = priced.cost; currency = priced.currency; costTrusted = true; }
  else if (directTrust) { const c = Number(costUsd); if (Number.isFinite(c)) { cost = c; currency = 'USD'; } }
  return { provider, cost, currency, costTrusted };
}

// Validate optional per-million-token pricing. Provider pricing may add cachedInputPerM and exact model
// overrides; legacy {inputPerM,outputPerM,currency} remains byte-stable after normalization.
function normalizePricing(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const parseRate = value => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const inP = parseRate(raw.inputPerM), outP = parseRate(raw.outputPerM), cachedP = parseRate(raw.cachedInputPerM);
  const cur = (typeof raw.currency === 'string') ? raw.currency.trim().slice(0, 8) : '';
  const modelRows = [];
  const seen = new Set();
  for (const row of (Array.isArray(raw.models) ? raw.models : []).slice(0, 100)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const model = typeof row.model === 'string' ? row.model.trim().slice(0, 240) : '';
    if (!model || seen.has(model)) continue;
    const modelIn = parseRate(row.inputPerM), modelOut = parseRate(row.outputPerM), modelCached = parseRate(row.cachedInputPerM);
    if (modelIn == null && modelOut == null && modelCached == null) continue;
    seen.add(model);
    modelRows.push({
      model,
      ...(modelIn == null ? {} : { inputPerM: modelIn }),
      ...(modelOut == null ? {} : { outputPerM: modelOut }),
      ...(modelCached == null ? {} : { cachedInputPerM: modelCached }),
    });
  }
  if (!cur || (inP == null && outP == null && cachedP == null && !modelRows.length)) return null;
  return {
    inputPerM: inP == null ? 0 : inP,
    outputPerM: outP == null ? 0 : outP,
    currency: cur,
    ...(cachedP == null ? {} : { cachedInputPerM: cachedP }),
    ...(modelRows.length ? { models: modelRows } : {}),
  };
}
function cachedInputTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  // DeepSeek 原生口径是顶层 prompt_cache_hit_tokens(与 prompt_cache_miss_tokens 成对,prompt_tokens 含两者)。
  // 它不带 prompt_tokens_details,修前缓存命中恒按 0 记 —— 用量账与回合成本把命中的输入全按未命中价算。
  const raw = details.cached_tokens != null ? details.cached_tokens
    : details.cache_read_input_tokens != null ? details.cache_read_input_tokens
      : usage.cache_read_input_tokens != null ? usage.cache_read_input_tokens
        : usage.cached_tokens != null ? usage.cached_tokens : usage.prompt_cache_hit_tokens;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
// Cached input is part of input tokens for OpenAI-compatible usage frames. Charge the non-cached remainder at
// inputPerM and cached tokens at cachedInputPerM; when the cache price is unset, conservatively use inputPerM.
function computeCostFromPricing(pricing, inTok, outTok, cachedInTok = 0) {
  const p = normalizePricing(pricing);
  if (!p) return { cost: null, currency: null };
  const input = Math.max(0, Number(inTok) || 0);
  const cached = Math.min(input, Math.max(0, Number(cachedInTok) || 0));
  const cachedRate = Number.isFinite(Number(p.cachedInputPerM)) ? Number(p.cachedInputPerM) : p.inputPerM;
  const cost = (input - cached) / 1e6 * p.inputPerM + cached / 1e6 * cachedRate + (Number(outTok) || 0) / 1e6 * p.outputPerM;
  return { cost: Number.isFinite(cost) ? cost : null, currency: p.currency };
}
// Exact model override wins within one provider; missing cached price continues to fall back to that row's input rate.
function computeProviderCost(provider, inTok, outTok, cachedInTok = 0, model = '') {
  const pricing = normalizePricing(provider && provider.pricing);
  if (!pricing) return { cost: null, currency: null };
  const modelId = String(model || provider && provider.model || '').trim();
  const override = Array.isArray(pricing.models) ? pricing.models.find(row => row.model === modelId) : null;
  const resolved = override ? {
    inputPerM: override.inputPerM == null ? pricing.inputPerM : override.inputPerM,
    outputPerM: override.outputPerM == null ? pricing.outputPerM : override.outputPerM,
    cachedInputPerM: override.cachedInputPerM == null ? (pricing.cachedInputPerM == null ? pricing.inputPerM : pricing.cachedInputPerM) : override.cachedInputPerM,
    currency: pricing.currency,
  } : pricing;
  return computeCostFromPricing(resolved, inTok, outTok, cachedInTok);
}

module.exports = { CLAUDE_ENDPOINT_PRESETS, claudeCostFields, normalizePricing, cachedInputTokensFromUsage, computeProviderCost };
