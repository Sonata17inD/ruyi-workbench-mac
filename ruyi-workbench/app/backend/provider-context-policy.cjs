'use strict';

const CONTEXT_GOVERNANCE_RULES = require('./context-governance-rules.json');
const CONTEXT_WINDOW_FALLBACK = 1000000;

function createProviderContextPolicy() {
  // 模型名对照表顺序敏感(更具体的版本/快照须在家族兜底之前命中)，顺序由数据文件锁定。
  // exact 条目同时接受供应商常见的 `vendor/model` 前缀，但不会误把 ASR/TTS 等同名变体当作文本模型。
  const MODEL_CONTEXT_TABLE = CONTEXT_GOVERNANCE_RULES.modelWindows.map(row => [row.match, row.tokens, row.exact === true]);
  // 从上游 /v1/models 条目提取窗口大小:取 context_length/max_context_length/context_window/max_model_len
  // 任一为正数的第一个。none → undefined(探测无结果, 不污染缓存正数判定)。
  const CTX_LENGTH_KEYS = CONTEXT_GOVERNANCE_RULES.contextLengthKeys.slice();
  function extractContextLength(rawModelEntry) {
    if (!rawModelEntry || typeof rawModelEntry !== 'object') return undefined;
    for (const k of CTX_LENGTH_KEYS) {
      const v = Number(rawModelEntry[k]);
      if (Number.isFinite(v) && v > 0) return Math.round(v);
    }
    return undefined;
  }
  // 探测缓存:键 `${providerId}\u0000${modelId}` → { at, contextLength }. TTL 10 分钟。进程内, 无落盘。
  const CTX_PROBE_CACHE = new Map();
  const CTX_PROBE_TTL_MS = 10 * 60 * 1000;
  function ctxProbeKey(providerId, modelId) { return String(providerId || '') + '\0' + String(modelId || ''); }
  function cacheContextLength(providerId, modelId, contextLength) {
    if (!(Number.isFinite(contextLength) && contextLength > 0)) return;
    CTX_PROBE_CACHE.set(ctxProbeKey(providerId, modelId), { at: Date.now(), contextLength: Math.round(contextLength) });
  }
  function cachedContextLength(providerId, modelId) {
    const hit = CTX_PROBE_CACHE.get(ctxProbeKey(providerId, modelId));
    if (!hit) return undefined;
    if ((Date.now() - hit.at) > CTX_PROBE_TTL_MS) { CTX_PROBE_CACHE.delete(ctxProbeKey(providerId, modelId)); return undefined; }
    return hit.contextLength;
  }
  // 名称表命中(子串/受限精确匹配, 小写)。无命中 → undefined。
  function contextWindowFromTable(model) {
    const m = String(model || '').toLowerCase();
    if (!m) return undefined;
    for (const [needle, size, exact] of MODEL_CONTEXT_TABLE) {
      const n = String(needle || '').toLowerCase();
      if (exact ? (m === n || m.endsWith('/' + n)) : m.includes(n)) return size;
    }
    return undefined;
  }
  // 完整解析:返回 { value, source }, source ∈ 'manual'|'probe'|'table'|'fallback'。`model` 缺省时退回
  // provider 的激活模型(provider.model 或 models[0])。手动优先, 再探测缓存, 再名称表, 最后兜底。
  function resolveContextWindow(provider, model) {
    const cw = provider && Number(provider.contextWindow);
    if (Number.isFinite(cw) && cw > 0) return { value: Math.round(cw), source: 'manual' };
    const activeModel = String(model || (provider && provider.model) || (provider && provider.models && provider.models[0] && provider.models[0].id) || '').trim();
    const probed = provider ? cachedContextLength(provider.id, activeModel) : undefined;
    if (Number.isFinite(probed) && probed > 0) return { value: probed, source: 'probe' };
    const tabled = contextWindowFromTable(activeModel);
    if (Number.isFinite(tabled) && tabled > 0) return { value: tabled, source: 'table' };
    return { value: CONTEXT_WINDOW_FALLBACK, source: 'fallback' };
  }
  // context 类 400 判定(45b):HTTP 400/413/422 + 上下文/长度【共现】语义。宁可漏判(不压)不误判(乱压历史)。
  // 45f 对抗轮 P1-1 收紧:裸 `context` / `max_tokens` / 裸 `too long` 全删 —— 它们会命中
  // "function calling is not supported in this context" / 参数校验类 400,把非超窗错误吸进破坏性压缩。
  const CONTEXT_OVERFLOW_STATUSES = new Set(CONTEXT_GOVERNANCE_RULES.overflow.statuses.map(Number));
  const CONTEXT_OVERFLOW_PATTERNS = new RegExp(CONTEXT_GOVERNANCE_RULES.overflow.pattern, CONTEXT_GOVERNANCE_RULES.overflow.flags);
  // 单凭状态码就算超窗的那几个(413 Payload Too Large:网关/反代常只回一个裸状态、不带正文)。只认错误串【开头】的
  // 「HTTP 413」—— 正文里碰巧出现的 413(「413 tokens」)不算。
  const CONTEXT_OVERFLOW_STATUS_ONLY = new Set((CONTEXT_GOVERNANCE_RULES.overflow.statusOnly || []).map(Number));
  function isContextOverflowError(httpError, options = {}) {
    const s = String(httpError || '');
    const lead = /^\s*HTTP\s+(\d{3})\b/.exec(s);
    if (lead && CONTEXT_OVERFLOW_STATUS_ONLY.has(Number(lead[1]))) return true;
    const hasStatus = [...CONTEXT_OVERFLOW_STATUSES].some(status => new RegExp(`\\b${status}\\b`).test(s));
    if (!hasStatus) return false;
    if (CONTEXT_OVERFLOW_PATTERNS.test(s)) return true;
    if (options.legacySubagentFallback === true && /\b400\b/.test(s)) {
      const legacy = new RegExp(CONTEXT_GOVERNANCE_RULES.overflow.legacySubagentPattern, 'i');
      return legacy.test(s) || s.length > CONTEXT_GOVERNANCE_RULES.overflow.legacySubagentLongErrorChars;
    }
    return false;
  }

  return Object.freeze({
    CONTEXT_WINDOW_FALLBACK, CONTEXT_OVERFLOW_PATTERNS,
    extractContextLength, cacheContextLength, cachedContextLength,
    contextWindowFromTable, resolveContextWindow, isContextOverflowError,
  });
}

module.exports = { createProviderContextPolicy };
