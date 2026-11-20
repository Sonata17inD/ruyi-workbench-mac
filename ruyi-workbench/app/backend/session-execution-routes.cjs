'use strict';

const { apiFailure, apiSessionIdInvalid, json, readJsonBody, send } = require('./http-protocol.cjs');

function createSessionExecutionRoutes({
  safeSessionId, readConfig, loadSession, mutateSession, logEvent, activeChildren, requestSessionExecutionStop, StewardHooks,
  compaction: { runProviderCompactTracked, runAgentExternalCompact, configForSessionEngineRoute },
}) {
  async function handleSessionExecutionApiRoutes(req, res, pathname) {
    if (req.method === 'POST' && pathname === '/api/stop') {
      const body = await readJsonBody(req);
      const sid = safeSessionId(body.sessionId);
      if (!sid) return send(res, apiSessionIdInvalid());
      const receipt = requestSessionExecutionStop(sid, body.expectedExecution, 'stopped');
      if (!receipt.ok) return send(res, apiFailure(receipt.error, {}, receipt.error, 409));
      const { stopped, queuedStopped, alreadyRequested } = receipt;
      // 121-K5(34 号文 §4.4 末条;33 号文 §0 记的那条不对称):管家按的停止进决策日志,用户手按的不进 ——
      // 于是「行动流水」上看得见模型停了哪条线程,看不见人停了哪条。这里补上,形状与 13h 的
      // steward_thread_stop 同款(tool:'user_stop'、mayAct:'user'、basis.origin:'ui_stop')。
      // 与 cancelQueuedTurn 同一条迟绑定纪律(13h 拼在本文件之后,直引它的符号是前向边);
      // **只在真停下了什么之后才记**——什么都没停时那不是一次行动,不该在流水上占一行。
      // await 它是为了让 e2e 能在响应回来之后立刻读到那一行(实现自己也是 fire-and-forget,不会抛)。
      if (!alreadyRequested && (stopped || queuedStopped) && sid && typeof StewardHooks.appendUserStop === 'function') {
        try { await StewardHooks.appendUserStop(sid, { stopped, queuedStopped }); } catch { /* 记账失败绝不影响停止本身 */ }
      }
      return send(res, json({ ok: true, stopped, queuedStopped, execution: receipt.execution }));
    }
    if (req.method === 'POST' && pathname === '/api/provider/compact') {
      // §5.2: native-provider context compaction. Same-origin protected (mutating) like /api/stop and
      // /api/chat/answer — deliberately NOT in needsToken (commander's amendment) to stay consistent.
      const body = await readJsonBody(req);
      const sessionId = safeSessionId(String(body.sessionId || ''));
      if (!sessionId) return send(res, apiSessionIdInvalid());
      if (activeChildren.has(sessionId)) return send(res, json({ ok: false, error: '回合进行中，请先停止或等待完成' }, 409));
      // mode:'summary' = 跳过「L1 够了就停」直接做摘要(缺省 'auto':先 L1,不够再摘要,见 runProviderCompact)。
      return send(res, json(await runProviderCompactTracked(sessionId, { mode: body.mode })));
    }
    if (req.method === 'POST' && pathname === '/api/agent/compact') {
      const body = await readJsonBody(req);
      const storedConfig = await readConfig();
      const sessionId = safeSessionId(String(body.sessionId || ''));
      if (!sessionId) return send(res, apiSessionIdInvalid());
      // External summary reseeding mutates the same session a live turn
      // owns. Enforce the UI's no-overlap rule at the API boundary to avoid last-writer-wins data loss.
      if (activeChildren.has(sessionId)) return send(res, json({ ok: false, error: '回合进行中，请先停止或等待完成' }, 409));
      const compactSession = await loadSession(sessionId);
      const config = compactSession ? configForSessionEngineRoute(storedConfig, compactSession) : storedConfig;
      const result = config.compactProviderId
        ? await runAgentExternalCompact(sessionId, config, 'manual')
        : { ok: false, error: 'Claude 默认压缩请使用原生 /compact；或先选择通用压缩模型' };
      return send(res, json(result, result.ok ? 200 : 400));
    }

  }
  return handleSessionExecutionApiRoutes;
}

module.exports = { createSessionExecutionRoutes };
