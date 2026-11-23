'use strict';

const { normalizePricing } = require('./provider-pricing.cjs');
const { configSecretValueOrCleared, configUrlOrCleared } = require('./config-secrets.cjs');

// Built-in provider templates the Settings UI can offer as "add from preset".
const PROVIDER_PRESETS = [
  // 用户 2026-09-27:厂商预设(DeepSeek / 通义千问 / 智谱 / 火山方舟)一律不内置 —— 服务商由用户自己填地址与密钥
  // (「自定义」一条),本机的 Ollama / LM Studio 只是本机端口、不绑厂商,保留。已经配好的 providers[] 不受影响。
  // 118e 本地零配置预设。两条都指向本机回环端口,【不需要 API Key】:装好 Ollama / LM Studio 并把服务
  // 跑起来,选中预设点「测试连接」就能探到 /v1/models 并回填模型列表。
  // keyOptional 是【模板级 UI 提示位】(与 CLAUDE_ENDPOINT_PRESETS 的 authKeyHint/defaultModelHint 同类):
  // 只影响前端「这一条要不要逼用户填 Key」,不进 providers[] 条目(sanitizeProvider 不认它),
  // 服务端本来就允许空 apiKey,所以这里没有任何鉴权语义变化。
  // defaultModel/models 刻意留空:本机装了哪些模型只有探测才知道,预填一个不存在的名字反而误导。
  {
    id: 'ollama', label: 'Ollama (本机模型,免 Key)', type: 'openai-compat',
    baseUrl: 'http://127.0.0.1:11434/v1', reasoning: true, vision: true, defaultModel: '', models: [],
    keyOptional: true,
  },
  {
    id: 'lmstudio', label: 'LM Studio (本机模型,免 Key)', type: 'openai-compat',
    baseUrl: 'http://127.0.0.1:1234/v1', reasoning: true, vision: true, defaultModel: '', models: [],
    keyOptional: true,
  },
  {
    id: 'openai-compatible', label: '自定义 (OpenAI 兼容 / 内网自建)', type: 'openai-compat',
    baseUrl: '', reasoning: true, vision: true, defaultModel: '', models: [],
  },
];

// 114a(45 号文 §7): PROVIDER_MODEL_CAPS —— models[].caps 的取值白名单。【模型能力标签】:这个模型
// 会什么(asr=可语音识别 / embedding=可向量化)。它与 06-provider-engine 的 getCapabilities()【运行
// 环境能力矩阵】(PLAYBOOK_REQUIRES: network/desktopMcp/vision —— 这台机器有什么)是【两个正交
// 取值域】,仅仅同名 caps。两处白名单【不许互相引用】,asr-config-ui.static.e2e.js 钉死这条隔离。
// 清洗口径:非字符串/空白/白名单外一律静默丢弃,去重,保序;空结果由调用方「可加不加」不落字段。
const PROVIDER_MODEL_CAPS = new Set(['asr', 'embedding', 'asr-stream']);   // 130:asr-stream = 流式识别(有会话的 HTTP,只给麦克风用)
function providerModelCaps(rawCaps) {
  if (!Array.isArray(rawCaps)) return [];
  const out = [];
  for (const v of rawCaps) {
    const s = (typeof v === 'string' ? v : '').trim().toLowerCase().slice(0, 40);
    if (s && PROVIDER_MODEL_CAPS.has(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

// v1.0 收官安全加固(对抗复核 PLAUSIBLE·minor):从 URL 剥掉 basic-auth userinfo(https://user:pass@host)。
// failover 事件的 from/to 与审计会回显端点 base;若管理员把凭据塞进 baseUrl,明文会漏进前端与 NDJSON 审计。
// 用于「显示/日志/粘住键」的 base,不用于真正发起请求的 chatUrl(后者需保留 userinfo 完成认证)。
function stripUrlUserinfo(u) {
  const s = String(u || '');
  try { const url = new URL(s); if (url.username || url.password) { url.username = ''; url.password = ''; return url.toString().replace(/\/+$/, ''); } return s; }
  catch { return s.replace(/\/\/[^/@]*@/, '//'); } // 非法/相对 URL 兜底:正则剥 //user:pass@
}

function resolveProvider(config, id) {
  if (!id || id === 'claude-cli') return null;
  const list = (config && Array.isArray(config.providers)) ? config.providers : [];
  const p = list.find(x => x && x.id === id);
  return p && p.type === 'openai-compat' ? p : null;
}
function activeOpenAiProvider(config) {
  return resolveProvider(config, config && config.activeProvider);
}

function createProviderConfigNormalizer({
  providerReasoningEffort, normalizeProviderApiStyle,
  normalizeAnthropicAuth, normalizeAnthropicThinking, normalizeAnthropicFallbacks,
}) {
  // Fold one raw provider entry onto a safe, fully-populated shape. Returns null if unusable (no id).
  function sanitizeProvider(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').trim().slice(0, 64);
    if (!id) return null;
    const str = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);
    const models = Array.isArray(raw.models)
      ? raw.models.map(m => {
        if (typeof m === 'string') return { id: m.trim(), label: m.trim() };
        if (!m || typeof m !== 'object') return null;
        // 114a: 可选模型能力标签(PROVIDER_MODEL_CAPS 白名单外静默丢弃+去重)。
        // 与 hiddenModels/pricing 同款「可加不加」:空就不落字段,存量 config.json 逐字节零漂移。
        const caps = providerModelCaps(m.caps);
        return { id: String(m.id || '').trim(), label: String(m.label || m.id || '').trim(), ...(caps.length ? { caps } : {}) };
      }).filter(m => m && m.id)
      : [];
    // 2026-09-20（用户真机）：清单上限 100。修前是「前 100 条」—— 百炼一刷新就是满 100 条，设置页「添加语音识别模型」
    // 追加在末尾的那一条（带 caps:['asr']）当场被截掉：选择器永远没有候选，用户看到的就是「保存了又消失」。
    // 超限时先留带能力标记的条目（它们是用户亲手标的，不是发现来的名字），再按原顺序补满；没超限顺序一字不动。
    if (models.length > 100) {
      const marked = models.filter(m => m.caps);
      const rest = models.filter(m => !m.caps).slice(0, Math.max(0, 100 - marked.length));
      const keep = new Set([...marked.slice(0, 100), ...rest]);
      models.splice(0, models.length, ...models.filter(m => keep.has(m)));
    }
    // 模型候选「已移除」名单（provider 级）：线程头模型菜单行尾那枚「×」删一行 = 在这里记下那个 id。
    // GET /api/models 把「saved 清单 ∪ live 发现」合并成候选时一律跳过名单里的项 —— 否则 ↻ 刷新会把
    // 刚删掉的那一行原样还回来，删除就成了只活一次画面的装饰。
    // 与 pricing 同款「可加不加」：空名单不落字段，存量 config.json 逐字节零漂移。
    const hiddenModels = Array.isArray(raw.hiddenModels)
      ? [...new Set(raw.hiddenModels.map(v => String(v || '').trim().slice(0, 120)).filter(Boolean))].slice(0, 100)
      : [];
    // 107-S2 最后一道闸(与 S0b 给 externalMcpServers 加的 mcpSecretValueOrCleared 同一个模具):走到
    // sanitize 还带着掩码前缀的值不是真值 —— 能还原的上面已经还原了,正常写口更会被 maskedSecretConflicts
    // 先整份拒绝。剩下的一律清空,保证【掩码永远到不了 config.json】,不管将来谁新开了写 providers 的口子。
    // normalizeConfig 每次读、写配置都过 sanitizeProvider,所以这一处覆盖全部路径。
    const extraHeaders = {};
    if (raw.extraHeaders && typeof raw.extraHeaders === 'object') {
      for (const [k, v] of Object.entries(raw.extraHeaders)) {
        if (typeof k === 'string' && typeof v === 'string') extraHeaders[k.slice(0, 80)] = configSecretValueOrCleared(v.slice(0, 2048));
      }
    }
    let temperature = '';
    if (raw.temperature !== '' && raw.temperature != null && Number.isFinite(Number(raw.temperature))) {
      temperature = Math.min(2, Math.max(0, Number(raw.temperature)));
    }
    // v0.8-S5: contextWindow (model window size in tokens). Clamp 8000..2000000; '' when unset so the
    // runtime falls back to CONTEXT_WINDOW_FALLBACK (1000000). A garbage value must never disable compaction.
    let contextWindow = '';
    if (raw.contextWindow !== '' && raw.contextWindow != null && Number.isFinite(Number(raw.contextWindow))) {
      contextWindow = Math.round(Math.min(2000000, Math.max(8000, Number(raw.contextWindow))));
    }
    // v1.0-S6 (B1): extraBaseUrls — optional 备用端点 for provider failover. Cleanse to a string array:
    // trim each, drop empties, length-cap 400 (same as baseUrl), dedupe (case-sensitive — a URL's path can
    // be case-significant), drop any entry equal to the (trimmed) main baseUrl (a duplicate of the primary is
    // pointless as a fallback), cap the list to 3. Absent/non-array → [] (行为与现状完全一致). This is an
    // ADDITIVE, optional field: older configs migrate untouched.
    const mainBase = configUrlOrCleared(str(raw.baseUrl, 400).trim());   // 107-S2:仍带掩码的地址不落盘(见 configUrlOrCleared)
    let extraBaseUrls = [];
    if (Array.isArray(raw.extraBaseUrls)) {
      const seen = new Set();
      for (const v of raw.extraBaseUrls) {
        if (typeof v !== 'string') continue;
        const s = configUrlOrCleared(v.trim().slice(0, 400));   // 107-S2
        if (!s) continue;
        if (s === mainBase) continue;      // a fallback identical to the primary buys nothing
        if (seen.has(s)) continue;
        seen.add(s);
        extraBaseUrls.push(s);
        if (extraBaseUrls.length >= 3) break;
      }
    }
    // 114a(45 号文 §7＋§1.6): audioBaseUrl —— 可选 ASR 转写端点(114b 的消费方;未配置=零行为)。
    // 与 baseUrl【同等对待】:trim + 截 400,不解析、不查协议、不查主机 —— 45 号文 §1.6 实证 baseUrl
    // 今天就没有任何 URL 准入校验(内置 ollama/lmstudio 预设本来就是 127.0.0.1 私网),不为这一个字段
    // 凭空发明一道 provider 级 URL 准入(那是独立安全决定,两条出网面要收一起收,已记 107 未完成项)。
    // localCommand 本波【不加】—— 唯一消费方 114d 已后置 128+,持久字段不养闲人(35 号文 §2 退出门)。
    const audioBaseUrl = configUrlOrCleared(str(raw.audioBaseUrl, 400).trim());   // 107-S2
    // 107-A1(46 号文 §5 A1,45 号文 §9.6.3 实测):asrProtocol —— 这家 provider 的转写【协议】。
    //   'transcriptions'(缺省)= 今天的 OpenAI/Whisper 形 multipart POST {base}/audio/transcriptions;
    //   'chat-audio'        = MiMo/百炼官方文档形 POST {base}/chat/completions + input_audio data URI。
    // 45 号文 §9.6.3 用真机真 key 实测:用户已配的四个 ASR 模型走 transcriptions 全 404,按各家文档协议
    // 直调则 200、字准确率 100%。所以这不是偏好开关,是「能不能用」的开关。
    // 空/非法值【不落字段】(照 audioBaseUrl 的模具):存量 config 零漂移,读回空即缺省协议。
    const asrProtocol = raw.asrProtocol === 'chat-audio' ? 'chat-audio' : '';
    // v1.4-OSS 用量看板: optional pricing for provider-engine cost calc. {inputPerM, outputPerM, currency} —
    // per-MILLION-token prices (non-negative) + a short currency code. Kept only when at least one price parses
    // AND a currency is present; otherwise dropped (the ledger then records tokens with cost null). ADDITIVE +
    // optional: a provider without pricing round-trips byte-identical (no spurious config rewrite).
    const pricing = normalizePricing(raw.pricing);
    return {
      id,
      label: str(raw.label, 80).trim() || id,
      type: 'openai-compat',
      baseUrl: mainBase,
      extraBaseUrls, // v1.0-S6 (B): failover 备用端点 (≤3, cleansed)
      ...(audioBaseUrl ? { audioBaseUrl } : {}), // 114a: 可选 ASR 端点(空不落字段,存量 config 零漂移)
      ...(asrProtocol ? { asrProtocol } : {}), // 107-A1: 可选 ASR 协议(空不落字段,同上)
      apiKey: configSecretValueOrCleared(str(raw.apiKey, 400)),   // 107-S2 最后一道闸:掩码永不落盘
      model: str(raw.model, 120).trim(),
      models,
      ...(hiddenModels.length ? { hiddenModels } : {}),
      reasoning: raw.reasoning === undefined || raw.reasoning === true,
      reasoningEffort: providerReasoningEffort(raw),
      // v1.7: apiStyle — protocol preference for this provider: 'chat' (default, OpenAI Chat Completions) or
      // 'responses' (OpenAI Responses API; DeepSeek added it for Codex/agent loops, v4-flash now + v4-pro from
      // 2026-08). Unknown/absent → 'chat' (向后兼容:任何既有配置零行为变化)。UI 设置里可逐 provider 切换,
      // 引擎在 buildBody/openAiStreamOnce 按此分支。其它 openai-compat 服务商(未提供 /responses 端点)保持 chat。
      apiStyle: normalizeProviderApiStyle(raw.apiStyle),
      // v1.8.2: serverWebSearch (boolean, default false) — opt-in for the Responses SERVER-SIDE web_search tool
      // ({type:'web_search'}). Default false keeps the built-in LOCAL web_search function tool as the fallback
      // for every provider / endpoint that doesn't support server-side search (DeepSeek preset sets true).
      serverWebSearch: raw.serverWebSearch === true,
      // 58 号批 2:Anthropic Messages 协议(apiStyle:'anthropic')的三个能力项,空 = 缺省、不落字段(存量 config 零漂移)。
      //   anthropicAuth     'x-api-key' / 'bearer';缺省 = 官方主机只发 x-api-key,其它主机两个都发
      //   anthropicThinking 'adaptive' / 'off';缺省 = 按模型名(Claude 4.6 起的 opus/sonnet/fable/mythos 发自适应思考)
      //   anthropicFallbacks 'off';缺省 = 官方主机上的 Opus 5 / 5.5、Sonnet 5.5、Fable 5.1 带 fallbacks:'default'(拒答改派)
      ...(normalizeAnthropicAuth(raw.anthropicAuth) ? { anthropicAuth: normalizeAnthropicAuth(raw.anthropicAuth) } : {}),
      ...(normalizeAnthropicThinking(raw.anthropicThinking) ? { anthropicThinking: normalizeAnthropicThinking(raw.anthropicThinking) } : {}),
      ...(normalizeAnthropicFallbacks(raw.anthropicFallbacks) ? { anthropicFallbacks: normalizeAnthropicFallbacks(raw.anthropicFallbacks) } : {}),
      // v0.8-S6: vision (boolean, default true) — the gate for the v0.9 vision回路 (image parts to the model).
      // Passed through untouched by sanitizeProvider; surfaced in the capability matrix (provider.vision).
      vision: raw.vision === undefined || raw.vision === true,
      // v0.9-S6 (D4): subagentModel — optional model id runSubAgent uses for spawn_agent sub-turns on THIS
      // provider. Empty ('') = fall back to the main model. Trimmed + length-capped (same shape as `model`).
      subagentModel: str(raw.subagentModel, 120).trim(),
      systemPrompt: str(raw.systemPrompt, 8000),
      temperature,
      contextWindow, // v0.8-S5
      ...(pricing ? { pricing } : {}), // v1.4-OSS: optional cost pricing (omitted when unset -> no config churn)
      extraHeaders,
    };
  }

  return sanitizeProvider;
}

module.exports = { PROVIDER_PRESETS, resolveProvider, activeOpenAiProvider, stripUrlUserinfo, createProviderConfigNormalizer };
