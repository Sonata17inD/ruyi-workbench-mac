'use strict';

const { renderProviderStablePrompt } = require('./provider-stable-prompt.cjs');
const { cachedInputTokensFromUsage, computeProviderCost } = require('./provider-pricing.cjs');
const { redact } = require('./secret-redaction.cjs');

// One non-streaming completion for auxiliary features. Transport retains the privacy boundary.
function createProviderRawCompletion({ providerWireProtocol, applyProviderReasoningEffort, providerPostJsonOnce }) {
  async function providerRawCompletion(provider, history, executionSessionId) {
    const wire = providerWireProtocol(provider);
    const chatUrl = wire.completionUrl(provider.baseUrl);
    const model = String(provider.model || (provider.models && provider.models[0] && provider.models[0].id) || '').trim();
    if (!chatUrl || !model || typeof fetch !== 'function') {
      return { ok: false, error: !chatUrl ? 'provider base URL is not set' : (!model ? 'no model selected for this provider' : 'fetch unavailable') };
    }
    const headers = wire.requestHeaders(provider, { model });
    const sysIdentity = renderProviderStablePrompt({ provider, model, cwd: '', identityOnly: true });
    const bodyObj = applyProviderReasoningEffort(
      wire.encodeMessages({ model, messages: [{ role: 'system', content: sysIdentity }, ...history], stream: false, foldSystem: true, provider }), provider, wire.id);
    const temp = (provider.temperature !== '' && provider.temperature != null && Number.isFinite(Number(provider.temperature))) ? Number(provider.temperature) : undefined;
    wire.applyTemperature(bodyObj, temp);
    // 60 s 超时(计时覆盖读回体);不认 SSE 兜底(修前就只认 JSON 回体)。回体不是 JSON → parsed 为 null → 下面按空补全报。
    const r = await providerPostJsonOnce({ url: chatUrl, headers, body: bodyObj, timeoutMs: 60000, executionSessionId });
    if (r.threw) { const e = r.error; return { ok: false, error: (e && e.name === 'AbortError') ? 'draft request timed out (60s)' : ((e && e.message) || 'draft request failed') }; }
    if (!r.res || !r.ok) {
      const d = r.raw;
      return { ok: false, error: `HTTP ${r.res ? r.status : '?'}${d ? ': ' + redact(d.slice(0, 300)) : ''}` };
    }
    const decoded = wire.decodeCompletion(r.parsed);
    const content = decoded.text.trim();
    // 200 回体里装着失败(chat 顶层 {error}、Responses status:'failed'、Anthropic type:'error' / stop_reason:'refusal'):
    // 修前只剩一句「空补全」,真因(额度用尽 / 拒答 / 服务端报错)看不到。与 10 摘要调用的口径一致,带出 failedDetail。
    if (decoded.failed || (!content && decoded.failedDetail)) {
      return { ok: false, error: `provider returned a failed completion${decoded.failedDetail ? ': ' + redact(String(decoded.failedDetail).slice(0, 300)) : ''}` };
    }
    if (!content) return { ok: false, error: 'provider returned an empty completion' };
    // v1.4-OSS 用量看板(补): 透传响应 usage + 实际用的 model,让调用方把这次起草补全记入 aux 台账。
    return { ok: true, content, usage: decoded.usage, model };
  }
  return providerRawCompletion;
}

// Keep auxiliary features off the main turn ledger and charge only reported usage.
function recordAuxiliaryUsage(appendUsageLedger, provider, completion, context) {
  try {
    const usage = completion?.usage;
    if (!usage || !context.sessionId) return;
    const inTok = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
    const outTok = Number(usage.completion_tokens ?? usage.output_tokens) || 0;
    if (!(inTok > 0 || outTok > 0)) return;
    const cachedInTok = cachedInputTokensFromUsage(usage);
    const model = completion.model || provider.model || '';
    const { cost, currency } = computeProviderCost(provider, inTok, outTok, cachedInTok, model);
    appendUsageLedger({
      ...context, engine: 'openai', provider: provider.id, model, inTok, outTok, cachedInTok,
      cost, currency, estimated: false, kind: 'aux',
    });
  } catch { /* Usage recording is best effort. */ }
}

// A judge node may request one repair when the local parser cannot recover its JSON.
function createNodeJsonRepair({ providerRawCompletion, appendUsageLedger }) {
  async function repairNodeJsonViaProvider(provider, session, node, schema, rawOutput, parseError) {
    try {
      const sys = '你是 JSON 修复器，只输出修正后的单个 JSON 对象，无任何其它文字（不要 Markdown、不要标题、不要代码围栏、不要解释）。字符串值内部的双引号必须转义为 \\"，去掉尾逗号，补齐缺失的括号与引号。';
      const schemaHint = schema ? ('\n\n目标 JSON Schema（要点）：\n' + JSON.stringify(schema).slice(0, 1500)) : '';
      // 对抗轮 P2: 裁判类输出是"长分析在前、JSON 收尾"(候选提取从后往前的同一设计前提),截取必须保尾——
      // 原 slice(0,12000) 在超长输出下发给修复模型的是不含真实 JSON 的分析文字,诱导其凭空编造 verdict。
      const rawStr = String(rawOutput || '');
      const rawSlice = rawStr.length <= 12000 ? rawStr : (rawStr.slice(0, 2000) + '\n…(中段省略)…\n' + rawStr.slice(-10000));
      const user = '下面的文本本应是一个 JSON 对象，但解析失败了。请只输出修正后的 JSON 对象。\n\n解析错误：' + String(parseError || '').slice(0, 300) + schemaHint + '\n\n原始输出：\n' + rawSlice;
      const sc = await providerRawCompletion(provider, [{ role: 'system', content: sys }, { role: 'user', content: user }], session?.id);
      recordAuxiliaryUsage(appendUsageLedger, provider, sc, {
        sessionId: session?.id, turnSeq: session?.turnSeq, note: 'json-repair', agentKey: node && node.id,
      });
      if (sc && sc.ok && sc.content) return sc.content;
    } catch { /* repair must never break node execution */ }
    return null;
  }
  return repairNodeJsonViaProvider;
}

module.exports = { createProviderRawCompletion, createNodeJsonRepair, recordAuxiliaryUsage };
