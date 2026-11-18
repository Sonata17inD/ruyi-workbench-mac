'use strict';

function createAgentToolHandlers({
  RUNTIME, httpRequest, safeJsonParse,
}) {

  // 代理模式 v2:四个代理工具在 provider 回合内由 runOpenAiTurn 特判(需要活闭包);这里只处理【无回合上下文】的
  // 两种来路 —— Claude/Kimi 的一次性 MCP 子进程(回环 serve 进程的 /api/agent-workflow/*)与直接的 /api/tools 调用(拒绝)。
  function agentToolLoopback(route, payload) {
    const port = process.env.WCW_PORT, host = process.env.WCW_HOST || '127.0.0.1';
    const token = process.env.WCW_TOKEN, sessionId = process.env.WCW_SESSION_ID || '';
    if (!port || !token || !sessionId) return Promise.resolve({ ok: false, error: '代理工具需要工作台会话上下文' });
    // A DAG can legitimately outlive the old fixed 15-minute loopback timeout (especially with several
    // sequential nodes). The workflow runtime now has its own idle watchdog, per-node wrap-up deadline
    // and parent heartbeats, so this transport timeout is only a last-resort day-long ceiling.
    return httpRequest({ url: `http://${host}:${port}${route}`, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, sessionId, ...payload }), timeoutMs: 86400000, maxBodyChars: 200000 })
      .then(resp => safeJsonParse(resp.body, { ok: false, error: 'invalid agent workflow response' }))
      .catch(e => ({ ok: false, error: `Agent loopback error: ${(e && e.message) || String(e)}` }));
  }
  const AGENT_TOOL_HANDLERS = {
    spawn_agent: { paths: null, guardNote: "已并入 orchestrate_agents:MCP 子进程翻译成单节点回环,其余来路清晰拒绝", handler: async (args, ctx) => {
        // 旧模型仍可能凭记忆调 spawn_agent:MCP 子进程里翻译成单节点 orchestrate(附提示);直接 /api/tools 调用给清晰指引。
        if (RUNTIME.isMcpChild) {
          const a = args && typeof args === 'object' ? args : {};
          const translated = { task: a.task, background: a.background === true };
          for (const k of ['role', 'agentKey', 'toolTier', 'maxIters', 'model', 'resources']) if (a[k] != null) translated[k] = a[k];
          const r = await AGENT_TOOL_HANDLERS.orchestrate_agents.handler(translated, ctx);
          if (r && typeof r === 'object') r.note = 'spawn_agent 已并入 orchestrate_agents(本次已按单节点代理执行)。下次请直接调用 orchestrate_agents({task, role?, background?})。' + (r.note ? ' ' + r.note : '');
          return r;
        }
        return { ok: false, error: 'spawn_agent 已并入 orchestrate_agents;请改用 orchestrate_agents({task, role?, toolTier?, background?})(仅在 provider 对话回合或 Claude/Kimi 工作台会话中可用)', replacedBy: 'orchestrate_agents' };
    } },
    orchestrate_agents: { paths: null, guardNote: "MCP 子进程 loopback /api/agent-workflow/launch(envelope:true;background→async);无会话上下文拒绝", handler: async (args, ctx) => {
        if (RUNTIME.isMcpChild) {
          const a = args && typeof args === 'object' ? args : {};
          // v1.4.4: forward workflowId/context too — the model choosing a saved template BY REFERENCE only works if
          // this loopback passes those fields through. 代理模式 v2:顶层单代理简写与 background 一并透传;serve 侧
          // 返回的是交付信封(envelope:true),不是整份 run。
          return agentToolLoopback('/api/agent-workflow/launch', {
            nodes: a.nodes, workflowId: a.workflowId, context: a.context, providerId: a.providerId,
            task: a.task, role: a.role, agentKey: a.agentKey, toolTier: a.toolTier, maxIters: a.maxIters, model: a.model, resources: a.resources,
            background: a.background === true, envelope: true,
          });
        }
        return { ok: false, error: 'orchestrate_agents 需要在 OpenAI 对话回合或 Claude CLI 工作台会话中调用' };
    } },
    wait_agents: { paths: null, guardNote: "MCP 子进程 loopback /api/agent-workflow/wait;无回合上下文拒绝(provider 回合特判在 runOpenAiTurn)", handler: async (args, ctx) => {
        if (RUNTIME.isMcpChild) {
          const a = args && typeof args === 'object' ? args : {};
          return agentToolLoopback('/api/agent-workflow/wait', { runIds: a.runIds, timeoutMs: a.timeoutMs });
        }
        return { ok: false, error: 'wait_agents 仅在 provider 对话回合或 Claude/Kimi 工作台会话中可用(收集后台代理信封)' };
    } },
    agent_result: { paths: null, guardNote: "MCP 子进程 loopback /api/agent-workflow/result;无回合上下文拒绝(provider 回合特判在 runOpenAiTurn)", handler: async (args, ctx) => {
        if (RUNTIME.isMcpChild) {
          const a = args && typeof args === 'object' ? args : {};
          return agentToolLoopback('/api/agent-workflow/result', { runId: a.runId, nodeId: a.nodeId, maxChars: a.maxChars, offset: a.offset });
        }
        return { ok: false, error: 'agent_result 仅在 provider 对话回合或 Claude/Kimi 工作台会话中可用(按需读取代理产出全文)' };
    } },
  };

  // 61 号文 C1 的三个只读清单 / 读取工具的上限(都是「有界」要求):清单行数、Playbook 步骤正文、单个填参值。

  return { AGENT_TOOL_HANDLERS };
}

module.exports = { createAgentToolHandlers };
