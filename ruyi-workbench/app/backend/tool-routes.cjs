'use strict';

const { apiFailure, json, readJsonBody, send } = require('./http-protocol.cjs');

function createToolRoutes({ TOOL_HANDLERS, loadSession, readConfig, toolCall }) {
  async function handleToolApiRoutes(req, res, pathname) {
    if (req.method === 'POST' && pathname.startsWith('/api/tools/')) {
      const body = await readJsonBody(req);
      const name = pathname.split('/').pop();
      // v0.8-S4a: a direct tool call may carry `sessionId` (and optionally `turnSeq`) so file mutations
      // checkpoint under that session. With sessionId only, turnSeq is read from the session file; an explicit
      // turnSeq pins the entry to a specific turn (used by e2e to exercise cross-turn rollback). Absent →
      // journalSessionCtx resolves to no context and journaling silently no-ops. Extra keys are ignored by the file tools.
      const ctx = body && body.sessionId ? { sessionId: String(body.sessionId), ...(Number.isFinite(Number(body.turnSeq)) && body.turnSeq !== '' && body.turnSeq != null ? { turnSeq: Number(body.turnSeq) } : {}) } : null;
      // v1.1-W2 (T1): thread session+config into ctx so http_download can guard its dest against the session's
      // write roots (guardDownloadDest → guardFileToolPath, 安全审计 #3). Best-effort; a load failure just falls
      // back to the config read from disk inside guardFileToolPath, never blocking the other tools.
      if (ctx) {
        if (body.memoryLiveRead === true && ['workbench_memory_list', 'workbench_memory_read'].includes(name)) ctx.memoryLiveRead = true;
        try {
          ctx.config = await readConfig();
          const s = await loadSession(ctx.sessionId).catch(() => null);
          if (s) ctx.session = s;
        } catch { /* degrade gracefully */ }
      }
      // 未知工具名是 404,不是服务端故障(修前 toolCall 抛「Unknown tool」→ 500 + http_unhandled;
      // 原型链上的名字如 constructor 更会在 entry.handler 上抛 TypeError)。
      if (!Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name)) {
        return send(res, apiFailure('tool.unknown', { name }, `Unknown tool: ${name}`, 404));
      }
      let result;
      try { result = await toolCall(name, body, ctx); }
      catch (error) {
        // 工具自己抛的普通 Error(「pattern is required」「url must start with http://」、ENOENT 之类)是这次调用
        // 的参数/对象有问题 → 400 tool.failed。编程错误(TypeError/ReferenceError…)与自带状态码的照旧交给顶层:
        // 500 + http_unhandled 日志,真 bug 不被 400 掩掉。
        const programming = error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError || error instanceof RangeError;
        if (!error || programming || error.statusCode) throw error;
        return send(res, apiFailure('tool.failed', { name }, String(error.message || error), 400));
      }
      // 审计 N5:toolCall 的入参校验以结果对象回(invalid-arguments),HTTP 面仍按修前口径 —— 参数错是 400 tool.failed,不是 200。
      if (result && result.ok === false && result.code === 'invalid-arguments') return send(res, apiFailure('tool.failed', { name, ...(typeof result.argsGuide === 'string' ? { argsGuide: result.argsGuide } : {}) }, String(result.error || 'invalid arguments'), 400));   // 代叫参数错递的骨架别在 HTTP 面丢掉
      return send(res, json({ ok: true, result }));
    }
  }
  return handleToolApiRoutes;
}

module.exports = { createToolRoutes };
