'use strict';

const { URL } = require('node:url');
const { providerScrubSecrets } = require('./provider-http.cjs');

function createProviderProbes({ providerWireProtocol, PrivacyGateway, extractContextLength, cacheContextLength }) {
  // Best-effort model list from a provider's GET …/models. Never throws. 端点与请求头按协议问 04i 的登记表(与补全请求同一份)。
  async function fetchOpenAiModels(provider, timeoutMs = 4000) {
    const wire = providerWireProtocol(provider);
    const modelsUrl = wire.modelsUrl(provider && provider.baseUrl);
    if (!modelsUrl || typeof fetch !== 'function') return { ok: false, error: modelsUrl ? 'fetch unavailable' : 'no base URL', models: [] };
    const headers = wire.requestHeaders(provider);
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs) : null;
    try {
      const res = await fetch(modelsUrl, { headers, signal: ctrl ? ctrl.signal : undefined });
      if (!res || !res.ok) return { ok: false, error: 'HTTP ' + (res ? res.status : '?'), models: [] };
      // 200 却不是 JSON(/models 被 SPA 兜底页 / 反代的登录页 / 空体顶掉):这不是「连接失败」,是「这个端点没有模型清单」。
      // 带 notAList 交给「测试连接」当缺清单处理(改用补全试探);超时中止(AbortError)照旧往外抛给下面的 catch。
      let body;
      try { body = await res.json(); }
      catch (parseError) {
        if (parseError && parseError.name === 'AbortError') throw parseError;
        return { ok: false, error: 'HTTP ' + res.status + ': the response is not a model list (not JSON)', notAList: true, models: [] };
      }
      const data = Array.isArray(body && body.data) ? body.data : (Array.isArray(body) ? body : []);
      // v1.0.2-S2: 同时保留上游条目里的 context_length 类字段(取第一个正数), 存为 contextLength,
      // 并按 provider+model 写入探测缓存(TTL 10 分钟), 供 providerContextWindow 解析激活模型时查用。
      const models = data
        .map(m => {
          if (typeof m === 'string') return { id: m, label: m };
          const id = String(m.id || m.model || '').trim();
          const out = { id, label: id };
          const ctx = extractContextLength(m);
          if (ctx) out.contextLength = ctx;
          return out;
        })
        .filter(m => m.id);
      // Ollama's OpenAI-compatible /v1/models omits context length, while its native /api/show reports
      // `<architecture>.context_length`. Probe the same configured origin (no new host) so local compactors
      // budget against their real window instead of the generic 64K fallback.
      let ollamaOrigin = '';
      try {
        const configured = new URL(String(provider && provider.baseUrl || ''));
        if (/ollama/i.test(String(provider && (provider.id + ' ' + provider.label) || '')) || configured.port === '11434') ollamaOrigin = configured.origin;
      } catch { /* non-URL base was already rejected above */ }
      if (ollamaOrigin) {
        await Promise.all(models.filter(m => !m.contextLength).slice(0, 32).map(async m => {
          try {
            const shown = await fetch(ollamaOrigin + '/api/show', {
              method: 'POST', headers, body: JSON.stringify({ model: m.id }), signal: ctrl ? ctrl.signal : undefined,
            });
            if (!shown || !shown.ok) return;
            const detail = await shown.json();
            const info = detail && detail.model_info;
            if (!info || typeof info !== 'object') return;
            const pair = Object.entries(info).find(([name, value]) => /(?:^|\.)context_length$/i.test(name) && Number(value) > 0);
            if (pair) m.contextLength = Math.round(Number(pair[1]));
          } catch { /* OpenAI-compatible but not native Ollama, or native probe unavailable */ }
        }));
      }
      const providerId = provider && provider.id;
      for (const m of models) if (m.contextLength) cacheContextLength(providerId, m.id, m.contextLength);
      return { ok: true, models };
    } catch (e) {
      return { ok: false, error: (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || 'fetch failed'), models: [] };
    } finally { if (timer) clearTimeout(timer); }
  }
  // 「测试连接」的第二条路:端点不提供模型清单(多数 Anthropic 兼容网关的 /anthropic/v1/models 是 404,一些 OpenAI 兼容
  // 内网网关也没有 /models)时,用填好的模型发一次最小的非流式补全来确认地址、密钥与模型都对。用短补全的编码(400 token、
  // 尽量关思考),失败时回 'HTTP <status>: <正文开头>' 供调用方分类。Never throws.
  async function probeProviderCompletion(provider, model, timeoutMs = 15000) {
    const wire = providerWireProtocol(provider);
    const url = wire.completionUrl(provider && provider.baseUrl);
    if (!url || typeof fetch !== 'function') return { ok: false, error: url ? 'fetch unavailable' : 'no base URL' };
    const body = wire.encodeQuick({ model, messages: [{ role: 'user', content: 'ping' }], plain: true, provider });
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs) : null;
    try {
      const requestBody = typeof PrivacyGateway !== 'undefined' ? await PrivacyGateway.beforeModelRequest(body) : body;
      if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertPolicyAvailable();
      const res = await fetch(url, { method: 'POST', headers: wire.requestHeaders(provider, { model }), body: JSON.stringify(requestBody), signal: ctrl ? ctrl.signal : undefined });
      const raw = await res.text().catch(() => '');
      // 报文原样回给界面之前,先把本次请求带出去的凭据按字面抹掉再截断(先截会把横跨 300 字边界的 key 切成认不出的半截)。
      if (!res.ok) return { ok: false, status: res.status, error: 'HTTP ' + res.status + (raw ? ': ' + providerScrubSecrets(raw, provider).replace(/\s+/g, ' ').slice(0, 300) : '') };
      let payload = null; try { payload = JSON.parse(raw); } catch { payload = null; }
      const decoded = payload ? wire.decodeCompletion(payload, { requestModel: model }) : null;
      if (decoded && decoded.failed) return { ok: false, error: String(decoded.failureText || 'provider error').slice(0, 300) };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || 'fetch failed') };
    } finally { if (timer) clearTimeout(timer); }
  }

  return { fetchOpenAiModels, probeProviderCompletion };
}

module.exports = { createProviderProbes };
