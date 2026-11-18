'use strict';

const { json, readJsonBody, send } = require('./http-protocol.cjs');

function createProviderRoutes({
  readConfig, safeSessionId, readSessionRouteHead, configForSessionEngineRoute, agentCliAdapter,
  catalog: { activeOpenAiProvider, fetchOpenAiModels, cachedContextLength, contextWindowFromTable },
  credentials: { maskedSecretConflicts, maskedSecretConflictMessage, unmaskProviders, redact, providerScrubSecrets },
  probe: { sanitizeProvider, normalizeProviderApiStyle, probeProviderCompletion },
}) {
  async function handleModelsApiRoute(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/models') {
      // Live-enriched model list. For an active native provider: its models ∪ live GET /models.
      // Otherwise the Claude path: proxy ∪ offline. Read-only, best-effort; never throws.
      // 124（用户 2026-09-14 走查①「刷新模型列表失效了，无论 kimi code 还是 Provider」）：这份列表要按
      // 【正在看的这条会话】的引擎路由派生，与上面 GET /api/status 同一个判据（configForSessionEngineRoute：
      // 会话级 engineRoute 优先，agent 路由会把 activeProvider 清空）。修前这里只读全局 config —— 线程头把
      // 这条线程切到 Kimi Code 或另一个 provider 之后，全局 activeProvider 仍是老那一个，于是刷新的是
      // 【全局那条路由】的模型：前端把它们折回 providers[全局] / status.models，而 chip 菜单读的是
      // 【这条会话这条路由】的那一份（steward-chips.js 的 modelOptions）—— 按下 ↻、toast 也说
      // 「模型已刷新（代理 N 个）」，屏幕上的列表一个字没变。真机实测（本机 8765）：
      //   GET /api/status?sessionId=<kimi 路由的会话> → models = kimi 那两条
      //   GET /api/models（无会话）                  → engine=openai provider=deepseek 的 4 条
      // 两个端点各说一套，正是这条不对齐。
      const config = await readConfig();
      let modelsConfig = config;
      try {
        const requestedSessionId = safeSessionId(new URL(req.url, 'http://127.0.0.1').searchParams.get('sessionId') || '');
        if (requestedSessionId) {
          const modelsHead = await readSessionRouteHead(requestedSessionId);   // 同 /api/status:只读头,零副作用
          if (modelsHead) modelsConfig = configForSessionEngineRoute(config, modelsHead);
        }
      } catch { /* 无效或读不到的 sessionId：与 status 同样退回全局新任务默认值 */ }
      const provider = activeOpenAiProvider(modelsConfig);
      if (provider) {
        const live = await fetchOpenAiModels(provider).catch(() => ({ models: [] }));
        const seen = new Map();
        // v1.0.2-S2: 每个模型对象带 contextLength(有则带)。探测(live)条目自带; 无探测时回退探测缓存;
        // 再无探测则使用版本化名称表，让离线 Provider 模型列表也能显示当前默认值；
        // 已有条目在 live 补到 contextLength 时就地补齐(only-add, 不改既有字段语义)。
        // 用户在模型菜单里删过的那一行（providers[].hiddenModels）在这【一个】合并点挡掉：saved 清单与
        // live 发现两条来源都过同一个 add，所以 ↻ 刷新不会把刚删掉的模型还回来。
        const hidden = new Set((Array.isArray(provider.hiddenModels) ? provider.hiddenModels : [])
          .map(v => String(v || '').trim()).filter(Boolean));
        // 2026-09-20（用户实报「保存了语音模型后，再点保存会消失」的真根因）：修前这里只留 id／label／contextLength，
        // models[].caps（['asr'] 这类能力标记）在合并时被丢掉；前端又把这份清单折回 state.config.providers[].models
        // （provider-settings.js 的刷新折回），于是内存里的配置从此没有语音标记 —— 选择器回落「无候选」，
        // 而下一次整份保存（草稿由这份内存配置播种）把盘上的标记也一起抹掉。配置里那一条带的 caps 原样带出去。
        const add = (id, label, contextLength, caps) => {
          const k = String(id || ''); if (!k || hidden.has(k)) return;
          const cl = (Number.isFinite(contextLength) && contextLength > 0) ? Math.round(contextLength)
            : (cachedContextLength(provider.id, k) || contextWindowFromTable(k));
          if (!seen.has(k)) { const o = { id: k, label: label || k }; if (cl) o.contextLength = cl; if (Array.isArray(caps) && caps.length) o.caps = caps.slice(); seen.set(k, o); }
          else if (cl && !seen.get(k).contextLength) seen.get(k).contextLength = cl;
        };
        for (const m of (provider.models || [])) add(m.id, m.label, m.contextLength, m.caps);
        for (const m of (live.models || [])) add(m.id, m.label, m.contextLength);
        return send(res, json({ ok: true, engine: 'openai', provider: provider.id, models: [...seen.values()], proxyCount: (live.models || []).length }));
      }
      // Agent CLI 路由:整份应答由该 CLI 的适配器给(05 modelCatalog.discover;Kimi 问 CLI 自己,Claude 走 Anthropic 口径)。
      return send(res, json(await agentCliAdapter(modelsConfig.agentCliType).modelCatalog.discover(modelsConfig)));
    }
  }

  async function handleProviderTestApiRoute(req, res, pathname) {
    if (req.method === 'POST' && pathname === '/api/provider/test') {
      // Test a provider's base URL + key by listing its models. Body: { provider } (saved or draft) or a bare provider.
      const body = await readJsonBody(req);
      let rawProvider = (body && body.provider) || body;
      // F2 (安全): the UI may send back a masked apiKey (`••••…`) from GET /api/status — restore the real
      // key from the same-id provider in config before firing the test, else the test would use the mask.
      if (rawProvider && typeof rawProvider === 'object') {
        const cfg = await readConfig();
        // 107-S2(M5):这条路会拿还原后的 key 真的往 baseUrl 发一次请求 —— 「改了地址 + 回传掩码」在这里
        // 不是「写错一份配置」而是【当场把真密钥送出去】。所以先过同一道闸,命中就【不发请求】直接回错,
        // 错误形状沿用本路由既有的 {ok:false,error,errorClass} (前端 errorMessageOf/ERROR_CLASSES 已认它),
        // 另带一个稳定 code 供按码分支。
        const conflicts = maskedSecretConflicts({ providers: [rawProvider] }, cfg);
        if (conflicts.length) {
          return send(res, json({
            ok: false, code: 'config.masked_secret_vector_changed', errorClass: 'provider_misconfigured',
            error: maskedSecretConflictMessage(conflicts), models: [],
          }));
        }
        rawProvider = unmaskProviders([rawProvider], cfg.providers)[0];
      }
      const sp = sanitizeProvider(rawProvider);
      if (!sp) return send(res, json({ ok: false, error: 'invalid provider (need at least an id + baseUrl)' }));
      // 先列模型清单(顺带回填下拉);端点不提供清单(404 / 405 / 501,或回了空表)时,用填好的模型发一次最小补全确认能通 ——
      // 多数 Anthropic 兼容网关(如 https://api.deepseek.com/anthropic)没有 /v1/models,修前这一步直接判「端点地址可能不对」。
      let probe = await fetchOpenAiModels(sp, 6000);
      const modelsMissing = (!probe.ok && (probe.notAList === true || /\bHTTP (?:404|405|501)\b/.test(String(probe.error || '')))) || (probe.ok && !(probe.models || []).length);
      const apiStyle = normalizeProviderApiStyle(sp.apiStyle);
      if (modelsMissing) {
        const model = String(sp.model || (sp.models && sp.models[0] && sp.models[0].id) || '').trim();
        if (!model) {
          return send(res, json({ ok: false, code: 'provider.test_needs_model', errorClass: 'provider_misconfigured', apiStyle, models: [],
            error: '这个端点不提供模型清单:请先填写模型名再测试' }));
        }
        const reach = await probeProviderCompletion(sp, model, 15000);
        if (reach.ok) return send(res, json({ ok: true, models: [], probe: 'completion', model, modelsUnavailable: true, apiStyle }));
        probe = { ok: false, error: reach.error, models: [], probe: 'completion', model };
      }
      // 审计 P2: 测试连接把裸 'HTTP 401' 直接回吐给用户 —— 首跑最高频故障(密钥错/无权限)却无人话、无下一步。常见状态映射成
      // 稳定 code(前端按 code 取本地化文案,并按协议给 Base URL 的写法提示)+ errorClass;error 仍是中文兜底句,detail 是原始报文。
      if (!probe.ok && probe.error) {
        const e = String(probe.error);
        // 先按字面抹掉本次请求带出去的 key / 自定义头的值(服务商常把它们回显在报文里,模式表认不全),再过模式表。
        const detail = redact(providerScrubSecrets(e, sp)).slice(0, 300);
        if (/\bHTTP 40[13]\b|unauthorized|authentication/i.test(e)) Object.assign(probe, { code: 'provider.test_unauthorized', errorClass: 'provider_misconfigured', error: '密钥无效或无权限(' + detail + '):请检查 API Key 是否正确、是否有额度/权限' });
        // 补全试探的 404 若正文点名了模型(Anthropic 官方 / OpenAI / vLLM 对未知模型都回 404)是「模型名」的问题,不是地址;
        // 裸 404(地址 / 路径错)正文里没有独立的 model 一词。model 后面接 _ 的(model_not_found)照算,models / remodel 不算。
        else if (probe.probe === 'completion' && /\bHTTP 404\b/.test(e) && /(?<![a-z])model(?![a-z])/i.test(e)) Object.assign(probe, { code: 'provider.test_model_rejected', errorClass: 'provider_misconfigured', error: '模型名可能不对(' + detail + ')' });
        else if (/\bHTTP 404\b/i.test(e)) Object.assign(probe, { code: 'provider.test_not_found', errorClass: 'provider_misconfigured', error: '端点地址可能不对(' + detail + '):检查 Base URL' });
        else if (probe.probe === 'completion' && /\bHTTP 4\d\d\b/.test(e) && /model/i.test(e)) Object.assign(probe, { code: 'provider.test_model_rejected', errorClass: 'provider_misconfigured', error: '模型名可能不对(' + detail + ')' });
        else if (/timeout|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(e)) Object.assign(probe, { code: 'provider.test_unreachable', errorClass: 'network_down', error: '连不上端点(' + detail + '):检查网络与 Base URL,内网端点确认可达' });
        else Object.assign(probe, { code: 'provider.test_failed', error: detail });
        probe.detail = detail;
        probe.apiStyle = apiStyle;
      }
      return send(res, json(probe));
    }
  }

  return { handleModelsApiRoute, handleProviderTestApiRoute };
}

module.exports = { createProviderRoutes };
