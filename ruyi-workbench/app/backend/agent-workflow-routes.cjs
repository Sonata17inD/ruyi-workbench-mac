'use strict';

const { apiSessionIdInvalid, apiSessionNotFound, json, readJsonBody, send } = require('./http-protocol.cjs');
const { normalizeCwd } = require('./path-containment.cjs');
const { inferSessionEngineRoute, sessionEngineRouteFromConfig } = require('./session-engine-route.cjs');
const { PERMISSION_MODES, resolvePermissionMode } = require('./agent-role-policy.cjs');

function createAgentWorkflowRoutes({
  process, tokenOk, tokenMatches, safeSessionId, loadSession, mutateSession, activeChildren, readConfig, nowIso, makeId,
  engines: { resolveProvider, activeOpenAiProvider, detectClaudePath, existsExecutableAsync },
  workflow: { resolveOrchestrateNodes, runAgentWorkflow, activeAgentRuns, saveAgentRun, AGENT_RUN_TERMINAL },
  delivery: { EventStreamHooks, waitForAgentRunResults, resolveWaitAgentsMs, settleWaitEnvelopes, agentRunResultSlice,
    deliverAgentRunEnvelope, buildAgentRunEnvelope },
}) {
  // 代理模式 v2:MCP 子进程(Claude)的 wait_agents / agent_result 回环。鉴权同 launch(body.token = 进程 token,
  // 01b 登记为 body-token),handler 内另接受 UI 头 token(管理面/测试直调)。终态信封在此登记已读 —— 这次返回就是
  // 投递,后续回合不再重复注入;活回合在跑就登记在它的内存会话上(回合结束落盘),否则读-改-存一次。
  async function agentWorkflowLoopbackRoute(req, res, kind) {
    const body = await readJsonBody(req);
    if (!(tokenMatches(body.token) || tokenOk(req))) return send(res, json({ ok: false, error: 'bad token' }, 403));
    const sessionId = safeSessionId(body.sessionId);
    if (!sessionId) return send(res, apiSessionIdInvalid());
    const liveReg = activeChildren.get(sessionId);
    const markSession = async runIds => {
      if (!EventStreamHooks.markAgentEnvelopeDelivered || !runIds.length) return;
      if (liveReg && liveReg.session) { for (const id of runIds) EventStreamHooks.markAgentEnvelopeDelivered(liveReg.session, id); return; }
      // 没有活回合:读-改-写走 mutateSession(撤回闸/写链纪律,见 02 头注),不直接 saveSession。
      await mutateSession(sessionId, fresh => { for (const id of runIds) EventStreamHooks.markAgentEnvelopeDelivered(fresh, id); }, { writer: 'agent_envelope_delivered' }).catch(() => {});
    };
    if (kind === 'wait') {
      const out = await waitForAgentRunResults(sessionId, body.runIds, resolveWaitAgentsMs(body.timeoutMs), null, () => { if (liveReg) liveReg.lastEventAt = Date.now(); });   // 等待窗内 Claude 父回合的看门狗不算空闲(MCP 子进程里的 wait_agents 期间 CLI 没有任何输出)
      // 与 provider 回合同一套结算(settleWaitEnvelopes):通知先到 → 短回执;wait 先到 → 登记已读。
      if (liveReg && liveReg.session) settleWaitEnvelopes(liveReg.session, out);
      else {
        const snapshot = await loadSession(sessionId);
        if (snapshot) {
          settleWaitEnvelopes(snapshot, out);
          const marked = Array.isArray(snapshot.backgroundJobSeen) ? snapshot.backgroundJobSeen : [];
          await mutateSession(sessionId, fresh => { fresh.backgroundJobSeen = [...new Set([...(Array.isArray(fresh.backgroundJobSeen) ? fresh.backgroundJobSeen : []), ...marked])].slice(-100); }, { writer: 'agent_envelope_delivered' }).catch(() => {});
        }
      }
      return send(res, json(out));
    }
    const out = await agentRunResultSlice({ sessionId, runId: body.runId, nodeId: body.nodeId, maxChars: body.maxChars, offset: body.offset });
    if (out && out.ok && out.live !== true && AGENT_RUN_TERMINAL.has(String(out.runStatus))) await markSession([out.runId]);
    return send(res, json(out));
  }

  async function handleAgentWorkflowApiRoutes(req, res, pathname) {
    if (req.method === 'POST' && pathname === '/api/agent-workflow/launch') {
      // Claude CLI's one-shot MCP child proxies the persistent DAG into the serve process. v1.4.4: the DAG
      // is genuinely dual-engine now — each node picks 'openai' (HTTP against a configured Provider) or
      // 'claude' (a native one-shot `claude` CLI spawn, runClaudeSubAgentOnce) via runAgentWorkflow's
      // per-node engine resolution, so a Claude-CLI-only setup no longer needs a Provider configured at all.
      const body = await readJsonBody(req);
      if (!tokenMatches(body.token)) return send(res, json({ ok: false, error: 'bad token' }, 403));
      const sessionId = safeSessionId(body.sessionId);
      if (!sessionId) return send(res, apiSessionIdInvalid());
      const session = await loadSession(sessionId);
      if (!session) return send(res, apiSessionNotFound());
      const config = await readConfig();
      const reg = activeChildren.get(sessionId);
      const route = inferSessionEngineRoute(session) || sessionEngineRouteFromConfig(config);
      if (reg?.kind === 'codex' || (!reg && route?.agentCliType === 'codex')) {
        return send(res, json({ ok: false, error: 'Codex CLI 当前支持普通线程，暂不支持多 Agent 工作流。' }, 400));
      }
      const provider = resolveProvider(config, body.providerId)
        || activeOpenAiProvider(config)
        || (config.providers || []).find(p => p && p.baseUrl && (p.model || (p.models && p.models.length)));
      const parentEngine = reg && reg.kind === 'claude' ? 'claude'
        : (reg && reg.kind === 'openai' ? 'openai' : (provider ? 'openai' : 'claude'));
      const parentModel = parentEngine === 'claude'
        ? String(config.model || '')
        : String(provider && (provider.model || (provider.models && provider.models[0] && (provider.models[0].id || provider.models[0]))) || '');
      const claudeCli = config.claudePath || detectClaudePath();
      const claudeCliUsable = Boolean(process.env.WCW_FAKE_CLAUDE) || Boolean(claudeCli && await existsExecutableAsync(claudeCli)); // test seam, see runClaudeTurn; 128f-⑬ 异步
      // Only reject up front when NEITHER engine could possibly run anything; a specific node explicitly
      // requesting an unavailable engine still fails gracefully per-node inside runAgentWorkflow.
      if (!provider && !claudeCliUsable) {
        // 61-C6:说清 Claude CLI 找的是哪(修前探测对不存在的 claude.cmd 也判可用,走不到这里;现在走得到,就要说得清)。
        const where = claudeCli ? `找过 ${claudeCli},不可用` : '没有配置 claudePath,PATH 里也找不到 claude';
        return send(res, json({ ok: false, error: `Agent DAG 需要至少配置一个 OpenAI 兼容 Provider，或安装并配置 Claude CLI(${where})` }, 400));
      }
      // 2026-10:工作流按【这条线程】的生效权限档跑 —— 修前直接取全局 config.permissionMode,线程在自己的权限 chip 上收紧过也照
      // 全局放。有活着的父回合就用它起回合时解析出的档(请求级 > 会话级 > 全局,05/09 登记在 reg.permissionMode),否则按
      // 会话级 > 全局解析(与续跑、恢复分级 agentRunPermissionMode 同一个解析器)。
      // provider 回合登记了 effectivePermissionMode()(回合中途在线程 chip 上收紧会被它看到),优先用它;其次是起回合时的快照。
      const liveMode = reg && typeof reg.effectivePermissionMode === 'function' ? (() => { try { return reg.effectivePermissionMode(); } catch { return ''; } })() : (reg && reg.permissionMode);
      const launchPermissionMode = PERMISSION_MODES.includes(liveMode) ? liveMode : resolvePermissionMode({ session, config });
      // 代理模式 v2:事件只在【发起时的那个回合】仍是活回合时进它的流(回合结束后 run 继续跑,但不往关掉的 SSE
      // 写、也不串进后来的回合);run 自己的事件日志与 GET /api/agent-runs 始终是权威实时面。
      const onEvent = reg && reg.onEvent ? (evt => { const live = activeChildren.get(sessionId); if (live === reg && live.onEvent) live.onEvent(evt); }) : () => {};
      const resolved = await resolveOrchestrateNodes(body, normalizeCwd(session.cwd, config.defaultWorkspace));
      if (resolved.error) return send(res, json({ ok: false, error: resolved.error, startedCount: 0 }));
      const wantEnvelope = body.envelope === true;
      // v1.4.4: a persisted DAG's node-count ceiling is agentWorkflowMaxNodes, NOT subagentMaxPerTurn (that's
      // an ad hoc, single-CHAT-TURN spawn_agent/orchestrate_agents fan-out budget — a 4-node default there
      // used to reject any real pipeline with 5+ nodes outright here, even though resuming the same run used
      // a hardcoded 32).
      const contextText = String(body.context || '').trim();
      // 代理模式 v2:完成 → 交付信封进后台任务账本(隐藏的数据面回执 + toast + 下一回合开头注入一次),不再往对话里
      // 追加整份「Agent 工作流已结束」助手消息(那条会被 syncProviderHistoryFromDisplay 抄进模型上下文)。
      const completion = run => deliverAgentRunEnvelope(session.id, run);
      const background = body.async === true || body.background === true;
      // 只有 Claude 的 MCP 子进程回环(envelope:true)替模型发起的 background:true 才算「模型起的」:跑完才会唤醒主会话。
      // 面板 / HTTP 的 async:true 是用户点的,信封照常进账本、随下一回合送达,但不替模型起回合。
      const launchedByModel = body.envelope === true && body.background === true;
      if (background) {
        const runId = makeId('run');
        // 与 launchPersistedAgentRun 同款:等到登记进 activeAgentRuns(或登记前就退出)再回。修前发起即回 accepted ——
        // 校验失败(重复节点 id、缺角色、依赖坏)以 { ok:false } 返回却没人看,调用方拿到 runId 却永远等不到这次运行;
        // 受理后立刻 pause / stop / 插话也会被 409「工作流当前未运行」拒掉。
        let markRegistered = null;
        const registered = new Promise(resolve => { markRegistered = resolve; });
        const finished = runAgentWorkflow({ parentSession: session, provider, config, nodes: resolved.nodes, onEvent, permModeOverride: launchPermissionMode, maxNodes: Math.max(0, Number(config.agentWorkflowMaxNodes) || 0), contextText, runIdOverride: runId, onComplete: completion, poolPolicy: body.poolPolicy, parentEngine, parentModel, background: true, launchedByModel, onRegistered: () => markRegistered() }).catch(async e => {
          activeAgentRuns.delete(runId); // 对抗轮 P2: 启动期抛出时兜底清注册(与 launchPersistedAgentRun 的 catch 对齐)
          const run = { schemaVersion: 4, id: runId, sessionId: session.id, turnSeq: session.turnSeq, providerId: provider && provider.id || '', status: 'failed', background: true, launchedByModel, createdAt: nowIso(), updatedAt: nowIso(), completedAt: nowIso(), error: String(e && e.message || e), nodes: [] };
          await saveAgentRun(run).catch(() => {});
          await completion(run).catch(() => {});
          return { ok: false, error: run.error, reported: true };
        });
        const first = await Promise.race([registered.then(() => null), finished]);
        if (first && first.ok === false && !first.reported) return send(res, json({ ok: false, error: first.error || '工作流未能启动', startedCount: 0 }));
        return send(res, json({ ok: true, accepted: true, background: true, status: 'running', runId, nodes: resolved.nodes.map(n => n && n.id).filter(Boolean), note: '代理已在后台运行;完成后交付信封会自动送达一次(也可 wait_agents 收件);全文用 agent_result 取。' }));
      }
      // 同步:MCP 回环(envelope:true)拿信封,并登记已读(它就是投递本身);UI/管理面(不带 envelope)照旧拿整份结果,
      // 且当没有活回合时把信封投进账本,让模型下一回合知道这件事。
      let completedRun = null;
      const result = await runAgentWorkflow({ parentSession: session, provider, config, nodes: resolved.nodes, onEvent, permModeOverride: launchPermissionMode, maxNodes: Math.max(0, Number(config.agentWorkflowMaxNodes) || 0), contextText, onComplete: async run => { completedRun = run; }, poolPolicy: body.poolPolicy, parentEngine, parentModel });
      if (wantEnvelope) {
        if (!completedRun) return send(res, json({ ok: false, error: (result && result.error) || '代理启动失败', runId: result && result.runId || '', startedCount: 0 }));
        if (EventStreamHooks.markAgentEnvelopeDelivered) {
          const liveReg = activeChildren.get(sessionId);
          if (liveReg && liveReg.session) EventStreamHooks.markAgentEnvelopeDelivered(liveReg.session, completedRun.id);
          else await mutateSession(sessionId, fresh => { EventStreamHooks.markAgentEnvelopeDelivered(fresh, completedRun.id); }, { writer: 'agent_envelope_delivered' }).catch(() => {}); // 读-改-写走 mutateSession
        }
        return send(res, json(buildAgentRunEnvelope(completedRun)));
      }
      if (completedRun && !activeChildren.has(session.id)) await completion(completedRun).catch(() => {});
      return send(res, json(result));
    }
    // 代理模式 v2:MCP 子进程(Claude)的 wait_agents / agent_result 回环(实现见 agentWorkflowLoopbackRoute)。
    if (req.method === 'POST' && pathname === '/api/agent-workflow/wait') return agentWorkflowLoopbackRoute(req, res, 'wait');
    if (req.method === 'POST' && pathname === '/api/agent-workflow/result') return agentWorkflowLoopbackRoute(req, res, 'result');
  }
  return handleAgentWorkflowApiRoutes;
}

module.exports = { createAgentWorkflowRoutes };
