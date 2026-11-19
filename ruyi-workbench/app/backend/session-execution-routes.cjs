'use strict';

const { apiFailure, apiSessionIdInvalid, apiSessionNotFound, json, readJsonBody, send } = require('./http-protocol.cjs');

function createSessionExecutionRoutes({
  safeSessionId, readConfig, loadSession, mutateSession, logEvent, activeChildren, requestSessionExecutionStop, StewardHooks,
  compaction: { runProviderCompactTracked, runAgentExternalCompact, configForSessionEngineRoute, agentCliAdapter },
  kimi: { kimiSessionStatus, kimiStatusFingerprint, applyKimiStatusToSession, kimiUsageFromStatus },
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
      // Native Kimi compaction and external summary reseeding both mutate the same session a live turn
      // owns. Enforce the UI's no-overlap rule at the API boundary to avoid last-writer-wins data loss.
      if (activeChildren.has(sessionId)) return send(res, json({ ok: false, error: '回合进行中，请先停止或等待完成' }, 409));
      const compactSession = await loadSession(sessionId);
      const config = compactSession ? configForSessionEngineRoute(storedConfig, compactSession) : storedConfig;
      // 没选通用压缩模型时,只有带原生压缩的 CLI(适配器 nativeCompact;Kimi)能从这里压;Claude 请用户在 CLI 里打 /compact。
      const nativeCompact = agentCliAdapter(config.agentCliType).nativeCompact;
      const result = config.compactProviderId
        ? await runAgentExternalCompact(sessionId, config, 'manual')
        : (nativeCompact
          ? await nativeCompact.run(sessionId, config, 'manual')
          : { ok: false, error: 'Claude 默认压缩请使用原生 /compact；或先选择通用压缩模型' });
      return send(res, json(result, result.ok ? 200 : 400));
    }
    if (req.method === 'GET' && pathname === '/api/kimi/status') {
      const config = await readConfig();
      if (config.agentCliType !== 'kimi') return send(res, json({ ok: false, error: '当前不是 Kimi Code 接入' }, 400));
      const u = new URL(req.url, 'http://x');
      const sessionId = safeSessionId(String(u.searchParams.get('sessionId') || ''));
      if (!sessionId) return send(res, apiSessionIdInvalid());
      const session = await loadSession(sessionId).catch(() => null);
      if (!session) return send(res, apiSessionNotFound());
      const status = await kimiSessionStatus(config, session.claudeSessionId, session.claudeSessionModel);
      if (!status.ok) return send(res, json(status, 400));
      // 「打开看一眼」只是读状态,不是这条会话的新活动:走 mutateSession(与活回合/其它改写者按 id 串行,撞撤回会重放)、
      // keepUpdatedAt(不把会话顶到列表最上面),而且状态值与已存的一致就不写(前端每次切会话都会调这里)。
      // 修前:无条件裸 saveSession 刷新 updatedAt、可能与活回合并发整份覆盖、失败被吞。
      let usage = null;
      try {
        await mutateSession(sessionId, fresh => {
          const before = kimiStatusFingerprint(fresh);
          usage = applyKimiStatusToSession(fresh, status);
          if (kimiStatusFingerprint(fresh) === before) return { abort: 'unchanged' };
        }, { writer: 'kimi_status', saveOpts: { keepUpdatedAt: true } });
      } catch (error) {
        // 状态本身已读到,落盘只是缓存:失败不挡响应,但留一条日志而不是吞掉。
        logEvent({ kind: 'kimi_status_persist_failed', sessionId, error: String((error && error.message) || error).slice(0, 200) });
      }
      if (!usage) usage = kimiUsageFromStatus(status);   // 会话期间被删/撤回等没跑到 apply:回读到的状态照样给前端
      return send(res, json({ ...status, usage }));
    }
  }
  return handleSessionExecutionApiRoutes;
}

module.exports = { createSessionExecutionRoutes };
