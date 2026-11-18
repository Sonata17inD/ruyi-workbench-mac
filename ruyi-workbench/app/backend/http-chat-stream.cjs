'use strict';

const { apiSessionIdInvalid, readJsonBody, send } = require('./http-protocol.cjs');

function createHttpChatStream({ runSessionTurn, PrivacyGateway, safeSessionId, nowIso }) {
  // HTTP 壳:只做「解析 body / 起流 / 构造 sink / 调核心 / 收尾 res.end」。回合语义全在 runSessionTurn 里。
  async function streamChat(req, res) {
    const body = await readJsonBody(req);
    // 带了 sessionId 却不是合法 id(`foo.bar`、数字、对象…)= 客户端以为在续一条会话:回 400,不再静默新建一条
    // (前端只发服务端给过的 sess_* / steward)。没带(或空串)才是「开新会话」;合法但不存在的 id 仍按原语义
    // 新建(会话文件损坏被隔离后的兜底,见 runSessionTurn)。
    if (body.sessionId != null && body.sessionId !== '' && !(typeof body.sessionId === 'string' && safeSessionId(body.sessionId))) {
      return send(res, apiSessionIdInvalid());
    }
    // D1:assistant_delta/thinking_delta 高频小事件合批(50ms 窗口),减前端重渲染 60-80%;边界事件立即 flush 保顺序
    let deltaBuffer = []; let flushTimer = null;
    const flushDeltas = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!deltaBuffer.length) return;
      const merged = [];
      for (const d of deltaBuffer) {
        const last = merged[merged.length - 1];
        if (last && last.type === d.type) last.text = (last.text || '') + (d.text || '');
        else merged.push({ ...d });
      }
      deltaBuffer = [];
      // 流已收尾(res.end 之后)的迟到事件直接丢:write-after-end 的 ERR_STREAM_WRITE_AFTER_END 是【异步】
      // 'error' 事件,try/catch 接不住,没有监听者就是 uncaughtException → 整个服务退出。
      if (res.writableEnded || res.destroyed) return;
      for (const evt of merged) {
        try { res.write(`${JSON.stringify({ ...evt, ts: nowIso() })}\n`); } catch { /* client gone */ }
      }
    };
    const writeEvent = evt => {
      if (evt && (evt.type === 'assistant_delta' || evt.type === 'thinking_delta')) {
        deltaBuffer.push(evt);
        if (!flushTimer) flushTimer = setTimeout(flushDeltas, 50);
        return;
      }
      flushDeltas();  // D1:边界事件先 flush 积压 delta,保顺序
      if (res.writableEnded || res.destroyed) return;   // 迟到事件(见 flushDeltas)
      try { res.write(`${JSON.stringify({ ...evt, ts: nowIso() })}\n`); } catch { /* client gone */ }
    };
    // This is a user-facing HTTP copy only. The engine's events, stored messages and
    // provider history keep their opaque references. Bind new sessions from the host's
    // session frame, never from a model/subagent-supplied scope identifier.
    let display = null, displayScope = '', displayPending = Promise.resolve();
    const writeDisplayEvent = evt => {
      if (!display && evt?.type === 'session' && safeSessionId(evt.session?.id)) {
        displayScope = evt.session.id;
        display = PrivacyGateway.createDisplayStream(displayScope, writeEvent);
      }
      if (!display) { writeEvent(evt); return; }
      // write() snapshots the host event synchronously and already serializes display I/O.
      displayPending = display.write(evt);
      // Event producers are synchronous; retain failures for the awaited HTTP finalizer.
      displayPending.catch(() => {});
    };
    // 客户端断线 → abort:核心把它翻译回原来的 killOnDisconnect → stopSession 语义。
    const disconnectController = new AbortController();
    let shellFinished = false;
    const handleDisconnect = () => { try { disconnectController.abort(); } catch { /* ignore */ } };
    // onStart 的位置 = 原 streamChat 里 writeHead 的位置(会话已装载、第一个事件未发)。started 记住流是否
    // 已起:核心在 onStart 之前抛错(readConfig/loadSession/createSession 级故障)时响应头还没发,错误要照原样
    // 抛回路由由 sendError 写标准信封,这里不能抢先 res.end() 把它变成一个空的 200。
    let started = false;
    const onStart = () => {
      started = true;
      // Lowest-latency streaming on loopback: no Nagle batching, flush headers immediately.
      try { req.socket.setNoDelay(true); } catch { /* ignore */ }
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      try { res.flushHeaders(); } catch { /* ignore */ }
      // 流上的异步写错误(EPIPE / write-after-end)兜底吸收:断线已由下面的 close/aborted 翻译成 abort。
      res.on('error', () => {});
      req.on('aborted', handleDisconnect);
      res.on('close', () => { if (!shellFinished && !res.writableEnded) handleDisconnect(); });
    };
    try {
      await runSessionTurn({
        sessionId: body.sessionId,
        title: body.title,
        message: body.message,
        attachments: body.attachments || [],
        cwd: body.cwd,
        agentTeam: body.agentTeam,
        permissionMode: body.permissionMode,
        // A canonical prefix stamp cannot validate a previously restored display
        // prefix after mapping expiry/import/revocation. Use a full UI snapshot.
        knownMessages: body.knownMessages && await PrivacyGateway.displayCacheKey(body.sessionId) ? null : body.knownMessages,
        source: 'http',
        onEvent: writeDisplayEvent,
        onFlush: flushDeltas,
        onStart,
        signal: disconnectController.signal,
      });
    } finally {
      try {
        try { await displayPending; }
        finally {
          if (display) await display.flush();
          flushDeltas();
        }
      } finally {
        if (display) display.close();
        shellFinished = true;
        if (started) res.end();
      }
    }
  }
  return streamChat;
}

module.exports = { createHttpChatStream };
