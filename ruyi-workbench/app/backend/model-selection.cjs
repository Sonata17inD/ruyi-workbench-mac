'use strict';
const fs = require('node:fs');
const path = require('node:path');

function createModelSelection({ paths, atomicWriteJson, effectiveAnthropicEnv }) {
  // 第44波(模型列表 API 化,44e 修订):显示预设只剩「默认(CLI 配置)」——版本化型号(如 claude-opus-4-8)与 CLI
  // 内建别名(opus/sonnet/haiku)都【不进列表】;真实清单 = 代理 /v1/models 发现缓存(getProxyModelsCache)
  // + 用户自定义(extraModels/knownModels)。别名集合仍保留作引擎归属判定(CLAUDE_ALIAS_IDS,见下)。
  const MODEL_PRESETS = [
    { id: '', label: '默认 (CLI 配置)' },
  ];

  // 第44波: 代理模型列表 sidecar 缓存(<dataRoot>/proxy-models-cache.json)。发现成功即落盘,供离线启动时的列表
  // 兜底 + buildModelHint 的 Claude 组。【不】写进 config.json:GET /api/models 是读路径,把缓存合并进 config 再
  // writeConfig 会让陈旧全量快照与用户的 POST /api/config 竞态互踩(25.1 对抗轮教训);sidecar 独占写点、零竞态。
  const PROXY_MODELS_CACHE_PATH = () => path.join(paths.data, 'proxy-models-cache.json');
  let proxyModelsCacheMemo = null; // null=未读盘;读后为 {at, models:[{id,label}]}(可为空数组)
  function getProxyModelsCache() {
    if (proxyModelsCacheMemo === null) {
      proxyModelsCacheMemo = { at: '', models: [] };
      try {
        const j = JSON.parse(fs.readFileSync(PROXY_MODELS_CACHE_PATH(), 'utf8'));
        if (j && Array.isArray(j.models)) {
          proxyModelsCacheMemo = {
            at: String(j.at || ''),
            models: j.models.filter(m => m && m.id).map(m => ({ id: String(m.id), label: String(m.label || m.id) })).slice(0, 50),
          };
        }
      } catch { /* 无缓存文件/坏 JSON → 空缓存 */ }
    }
    return proxyModelsCacheMemo;
  }
  // 发现成功时调用:归一化 + 去重 + cap 50;内容没变则不写盘(避免每次 /api/models 都动文件)。尽力而为,不抛。
  function setProxyModelsCache(models) {
    const seen = new Map();
    for (const m of (Array.isArray(models) ? models : [])) {
      const id = String((m && m.id) || '').trim();
      if (id && !seen.has(id)) seen.set(id, { id, label: String((m && m.label) || id) });
      if (seen.size >= 50) break;
    }
    const next = { at: new Date().toISOString(), models: [...seen.values()] };
    const prev = getProxyModelsCache();
    if (JSON.stringify(prev.models) === JSON.stringify(next.models)) return;
    proxyModelsCacheMemo = next;
    atomicWriteJson(PROXY_MODELS_CACHE_PATH(), next).catch(() => { /* 失败只影响下次离线兜底 */ });
  }

  // Offline list = 默认+别名预设 ∪ 代理发现缓存 ∪ manual (extraModels: "id" or "id|Label") ∪ remembered (knownModels)
  // ∪ the current custom model. Deduped by id; the empty '默认' entry stays first. No network.
  function offlineModelList(config) {
    const seen = new Map();
    const add = (id, label) => { const k = String(id ?? ''); if (!seen.has(k)) seen.set(k, { id: k, label: label || (k || '默认 (CLI 配置)') }); };
    for (const m of MODEL_PRESETS) add(m.id, m.label);
    for (const m of getProxyModelsCache().models) add(m.id, m.label); // 第44波: API 发现的版本化型号由此进列表
    for (const raw of (config.extraModels || [])) { const [id, label] = String(raw).split('|'); if (id && id.trim()) add(id.trim(), (label || '').trim() || undefined); }
    for (const id of (config.knownModels || [])) if (id) add(id);
    if (config.model && !seen.has(String(config.model))) add(config.model, config.model + ' (自定义)');
    return [...seen.values()];
  }

  // ============================================================================
  // 第30波(编排按难度选模型):让 AI 编排者(orchestrate_agents/spawn_agent/propose_task)按任务难易【自主】为
  // 不同节点选模型。机制其实已在(node.model 优先级链贯通两引擎),补齐:①能力档位提示 buildModelHint(让 AI 知道
  // 每个模型强弱,按引擎分组防选错)②'inherit' 归一为空(修 OpenAI 把字面量当模型发失败)③toolTier 兜底(opt-in)。
  // 对抗轮教训(改这块务必记牢):
  //  - 【不】在通用写入点对 node.model 做白名单丢弃 —— 人工在编辑器/模板里填的 live 发现但未进 knownModels 的真实
  //    模型会被误杀(回归);显式 model 一律尊重原样,幻觉靠【引擎分组的 hint 强引导】规避,填错则节点可见失败(errorClass)。
  //  - buildModelHint / tier 兜底必须【引擎感知】:offlineModelList 混着 Claude 预设别名(opus/sonnet/haiku)与 provider
  //    模型,给 openai 节点选 Claude 别名必失败。故 hint 按引擎分组、tier 池排除预设别名。
  //  - 'inherit' 两引擎都用【空】表达"用默认":Claude runner 7109 剥 inherit,OpenAI runner 7639 不剥会把字面量当模型。
  // 从模型 id/label 启发式推断能力档位。用户 extraModels 的 "id|Label" 标签(可含 强/均衡/快)一并参与。纯串匹配,无网络。
  function modelCapabilityTier(id, label) {
    const s = (String(id || '') + ' ' + String(label || '')).toLowerCase();
    // 对抗轮 P3:'plus' 移出 strong(qwen-plus/glm-4-plus 是中档,误判会把难节点分给弱模型);pro/max/opus 等保留。
    if (/(opus|ultra|large|huge)|[-_ ]max\b|[-_ ]max$|\bmax[-_ ]|[-_ ]pro\b|405b|235b|72b|70b|32b|旗舰|高级|reasoner|thinking/.test(s)) return 'strong';
    if (/flash|mini|lite|small|turbo|nano|air|tiny|fast|haiku|8b|7b|4b|3b|1\.5b|轻量|极速/.test(s)) return 'fast';
    if (/[·\s【\[]强[·\s】\]]|^强|强$/.test(s)) return 'strong'; // 标签里的裸"强"(避免误吞 model id 里的偶发字)
    if (/[·\s【\[]快[·\s】\]]|^快|快$/.test(s)) return 'fast';
    return 'balanced';
  }
  const MODEL_TIER_LABEL = { strong: '强', balanced: '均衡', fast: '快' };
  const MODEL_TIER_USE = { strong: '复杂推理/综合/裁判/难题', balanced: '一般实现与分析', fast: '简单/大批量/检索类节点' };
  const CLAUDE_ALIAS_IDS = new Set(['opus', 'sonnet', 'haiku']); // Claude CLI 内建别名(44e:仅引擎归属判定用 —— 用户 knownModels/extraModels 里的别名串仍归 Claude 侧、防混入 openai 组;不再进显示列表)
  // 供编排者(AI)选型的可选模型清单 + 能力档位 + 按难度选型指引。【引擎分组】:OpenAI 节点用 provider 模型 + 用户
  // 自定义(非预设);Claude 节点用代理发现缓存 ∪ 用户持有的别名(第44波,替代原硬编码版本型号;44e 别名出列表)。防 AI 给
  // openai 节点选 Claude 别名(必失败)。label 扁平化防注入。
  function buildModelHint(config, provider) {
    const all = offlineModelList(config).filter(m => m.id);
    if (!all.length) return '';
    // OpenAI 组【优先用当前激活 provider 声明的模型】—— 只有它们对该 provider 真实可用;knownModels/config.model 可能
    // 是【别的 provider】的模型(如 deepseek 激活时 knownModels 里的 qwen 属 dashscope),混进来会诱导 AI 选了必失败。
    // 直接从 provider.models 构建(它们未必在 offlineModelList 里),label 命中 offlineModelList 则取其 label。
    const provList = []; const seenP = new Set();
    const addP = id => { id = String(id || '').trim(); if (id && !seenP.has(id) && !CLAUDE_ALIAS_IDS.has(id)) { seenP.add(id); const f = all.find(m => m.id === id); provList.push(f || { id, label: id }); } };
    if (provider) { if (Array.isArray(provider.models)) for (const x of provider.models) addP((x && x.id) || x); if (provider.model) addP(provider.model); }
    // provider 声明了模型 → 只列这些;什么都没声明(自建单模型)→ 退回非预设自定义(尽力)。
    // 第44波: Claude 组 = 别名 ∪ 代理发现缓存(API 真实清单);openai 兜底池同步排除两者(防跨引擎诱导选错必失败)。
    const claudeCacheIds = new Set(getProxyModelsCache().models.map(m => m.id));
    const openaiModels = provList.length ? provList : all.filter(m => !CLAUDE_ALIAS_IDS.has(m.id) && !claudeCacheIds.has(m.id));
    const claudeModels = all.filter(m => CLAUDE_ALIAS_IDS.has(m.id) || claudeCacheIds.has(m.id)); // 别名(用户持有的) + 代理缓存(Claude)
    const fmt = m => { const t = modelCapabilityTier(m.id, m.label); const lb = m.label && m.label !== m.id ? '（' + String(m.label).replace(/\s+/g, ' ').trim() + '）' : ''; return `- ${m.id}【${MODEL_TIER_LABEL[t]}·${MODEL_TIER_USE[t]}】${lb}`; };
    const parts = [];
    if (openaiModels.length) parts.push('OpenAI 引擎节点(engine:openai)可选:\n' + openaiModels.map(fmt).join('\n'));
    if (claudeModels.length) parts.push('Claude 引擎节点(engine:claude)可选:\n' + claudeModels.map(fmt).join('\n'));
    if (!parts.length) return '';
    return '\n\n可选模型（node.model 按任务难易自主选;须与节点 engine 匹配;省略 model=用默认模型）:\n'
      + parts.join('\n')
      + '\n按难度选型:简单/大批量节点用【快】省成本提速;核心推理/综合/质量门/难题用【强】保质量;其余用【均衡】。填与引擎不符或不存在的模型会让该节点失败,不确定就省略 model。';
  }
  // 按 toolTier 挑一个档位合适的模型(后端兜底,opt-in agentAutoModelTiering):read→快、exec→强、edit→均衡;
  // 目标档缺则顺位降级,全无则空(继承)。【引擎感知】:claude→空(继承 CLI 默认,不替它挑贵模型);openai 从 provider
  // 模型 ∪ 用户自定义模型(knownModels/config.model/extraModels)里挑,【排除 Claude 预设别名】(对 openai 无意义)。
  // 对抗轮 P3:池扩到 knownModels/config.model,修 provider.models=[] (常见自建配置)时 tier 兜底静默失效。
  function tierModelForNode(toolTier, engine, config, provider) {
    if (engine === 'claude') return '';
    // 优先【当前激活 provider 声明的模型】(对该 provider 真实可用);只有 provider 什么都没声明时才退回用户全局
    // 自定义模型(knownModels/config.model,尽力兜底,可能跨 provider —— 但总比 provider.models=[] 时静默失效强)。
    const provIds = [];
    if (provider && Array.isArray(provider.models)) for (const x of provider.models) { const id = String((x && x.id) || x); if (id) provIds.push(id); }
    if (provider && provider.model) provIds.push(String(provider.model));
    let ids;
    if (provIds.length) ids = provIds;
    else { ids = []; for (const raw of (config.extraModels || [])) { const id = String(raw).split('|')[0].trim(); if (id) ids.push(id); } for (const id of (config.knownModels || [])) if (id) ids.push(String(id)); if (config.model) ids.push(String(config.model)); }
    const claudeCacheIds = new Set(getProxyModelsCache().models.map(m => m.id)); // 第44波: 缓存的 Claude 端模型同样排除
    const pool = [...new Set(ids)].filter(id => !CLAUDE_ALIAS_IDS.has(id) && !claudeCacheIds.has(id)); // 排除 Claude 别名+代理缓存
    if (!pool.length) return '';
    const want = toolTier === 'exec' ? 'strong' : (toolTier === 'edit' ? 'balanced' : 'fast');
    const order = want === 'strong' ? ['strong', 'balanced', 'fast'] : want === 'fast' ? ['fast', 'balanced', 'strong'] : ['balanced', 'fast', 'strong'];
    for (const t of order) { const hit = pool.find(id => modelCapabilityTier(id, '') === t); if (hit) return hit; }
    return '';
  }
  // 节点最终 model 解析:显式(原样尊重,'inherit'→空)> 角色按引擎默认 > 按 tier 兜底(opt-in,引擎感知)> 继承(空)。
  // 对抗轮:【不】做白名单丢弃 —— 显式 model 无论人工/AI 一律尊重(避免误杀 live 发现/未记住的真实模型,消除回归);
  // 'inherit' 归一为空(两引擎都用空表达"用默认";OpenAI runner 不剥 inherit 字面量会当真模型发失败)。
  function resolveNodeModel(rawModel, roleModel, toolTier, engine, config, provider) {
    let m = String(rawModel || '').trim().slice(0, 160);
    if (m === 'inherit') m = '';                      // 归一:两引擎"用默认"都用空
    if (m) return m;                                  // 显式非空 → 原样尊重(不白名单丢弃)
    const rm = String(roleModel || '').trim();
    if (rm && rm !== 'inherit') return rm;            // 角色默认(用户配置)
    // 52x: 全局子 agent 优先模型(openai 引擎,跨 provider)--用户显式选择,优先于自动 tier
    if (engine === 'openai' && config && config.subagentPreferredModel) { const pm = String(config.subagentPreferredModel).trim().slice(0, 160); if (pm) return pm; }
    if (config && config.agentAutoModelTiering) { const t = tierModelForNode(toolTier, engine, config, provider); if (t) return t; }
    return '';                                        // 继承 / provider 兜底链
  }

  // Best-effort live model list from the intranet proxy's /v1/models. NEVER throws (returns [] on any
  // problem: no base URL, offline, timeout, non-2xx, bad JSON). Auth/URL come from config or env.
  async function fetchProxyModels(config, timeoutMs = 2500) {
    // v1.4.4: reuse the exact same env resolution the real Claude CLI child gets (effectiveAnthropicEnv),
    // so the discovered list can never point at a different endpoint than what actually answers the chat.
    const effEnv = effectiveAnthropicEnv(config);
    const base = String(effEnv.ANTHROPIC_BASE_URL || effEnv.ANTHROPIC_BASE || '').trim().replace(/\/+$/, '');
    if (!base || typeof fetch !== 'function' || typeof AbortController !== 'function') return [];
    const headers = { 'anthropic-version': '2023-06-01' };
    if (effEnv.ANTHROPIC_AUTH_TOKEN) headers['authorization'] = 'Bearer ' + effEnv.ANTHROPIC_AUTH_TOKEN;
    if (effEnv.ANTHROPIC_API_KEY) headers['x-api-key'] = effEnv.ANTHROPIC_API_KEY;
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs);
    try {
      const res = await fetch(base + '/v1/models?limit=1000', { headers, signal: ctrl.signal });
      if (!res || !res.ok) return [];
      const body = await res.json();
      const data = Array.isArray(body && body.data) ? body.data
        : Array.isArray(body && body.models) ? body.models
        : Array.isArray(body) ? body : [];
      return data
        .map(m => (typeof m === 'string' ? { id: m, label: m } : { id: String(m.id || m.model || m.name || ''), label: String(m.display_name || m.id || m.model || '') }))
        .filter(m => m.id);
    } catch { return []; }
    finally { clearTimeout(timer); }
  }

  // Full list surfaced to the UI = proxy (live) ∪ offline, deduped, '默认' first.
  // 第44波: 发现成功即更新 sidecar 缓存(setProxyModelsCache 内部做变更比对,没变不写盘)。
  async function discoverModels(config) {
    const proxy = (config && config.discoverModelsFromProxy !== false) ? await fetchProxyModels(config).catch(() => []) : [];
    if (proxy.length) setProxyModelsCache(proxy);
    const seen = new Map();
    const add = (id, label) => { const k = String(id ?? ''); if (!seen.has(k)) seen.set(k, { id: k, label: label || k }); };
    add('', '默认 (CLI 配置)');
    for (const m of proxy) add(m.id, m.label);
    for (const m of offlineModelList(config)) if (m.id !== '') add(m.id, m.label);
    return { models: [...seen.values()], proxyCount: proxy.length };
  }
  return { getProxyModelsCache, setProxyModelsCache, offlineModelList, modelCapabilityTier, buildModelHint, tierModelForNode, resolveNodeModel, fetchProxyModels, discoverModels };
}

module.exports = { createModelSelection };
