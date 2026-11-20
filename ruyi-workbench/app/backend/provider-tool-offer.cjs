'use strict';
const { adaptiveMetaToolSchemas, MCP_TOOLS, PROVIDER_SESSION_TOOL_SCHEMAS } = require('./native-tool-schemas.cjs');
const { nativeToolTier } = require('./native-tool-tiers.cjs');
const { nativeToolDisabledByPolicy } = require('./tool-access-policy.cjs');
const { TOOL_REQUIRES, toolRequirementsMet } = require('./tool-capability-policy.cjs');
const { observationRecallEnabled } = require('./runtime-policy.cjs');

function createProviderToolOffer({ sessions, policy }) {
  const { loadSession, sessionDesktopToolsOf } = sessions;
  const { TOOL_TIER_RANK, isStewardToolName } = policy;

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

  return { MEMORY_WRITE_TOOL_NAMES, policySessionFor, policyDesktopOverrideFor, toolDisabledResult, nativeToolSchema, nativeToolsAcceptingArgKeys, buildOpenAiTools };
}

module.exports = { createProviderToolOffer };
