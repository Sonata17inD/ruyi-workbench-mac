'use strict';

const { renderProviderStablePrompt } = require('./provider-stable-prompt.cjs');
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

module.exports = { createProviderRawCompletion };
