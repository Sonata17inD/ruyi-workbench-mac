'use strict';

const { apiFailure, apiSessionNotFound, json, readJsonBody, send } = require('./http-protocol.cjs');
const { createHttpNdjsonResponse } = require('./http-ndjson-response.cjs');

function createStewardRoutes({
  tokenOk, readConfig, safeSessionId, nowIso, StewardHooks, PrivacyGateway,
  STEWARD_SESSION_ID, STEWARD_PREROUTE_QUERY_MAX, inbox, memory, runner, delivery,
}) {
  const { startStewardInbox, stopStewardInbox, stewardInboxRead, stewardInboxState } = inbox;
  const { stewardMemoryPanelList, stewardMemoryPanelExport, stewardMemoryPanelEdit, stewardImplMemoryVeto,
    stewardMemoryPanelRestore, stewardMemoryPanelClear, stewardDecisionsRead } = memory;
  const { stewardArbiterState, stewardImplThreadPrioritize, stewardResetConversation, stewardVisit, stewardRunAct,
    ensureStewardSession, stewardSanitizeAttachments, runStewardTurn } = runner;
  const { stewardDeliveryProjection, stewardDeliveryInspect, loadSession, readFilePreview } = delivery;

  async function stewardPanelGate(req) {
    if (!tokenOk(req)) return apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403);
    const config = await readConfig();
    if (config.stewardEnabledV1 !== true) return apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409);
    return null;
  }
  // 域层稳定信封 -> 路由层 apiFailure(不转的话会被 normalizeApiErrorPayload 归一成 api.request_failed)。
  function stewardPanelFailure(result) {
    const code = String((result && result.error) || 'invalid_request');
    const status = code === 'version_conflict' ? 409 : (code === 'not_found' ? 404 : 400);
    return apiFailure(code, {}, String((result && result.message) || code), status);
  }

  async function handleStewardApiRoutes(req, res, pathname) {
    if (req.method === 'POST' && pathname === '/api/steward/start') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const config = await readConfig();
      if (config.stewardEnabledV1 !== true) {
        return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
      }
      const started = await startStewardInbox(config);
      return send(res, json({ ok: true, running: Boolean(started && started.running) }));
    }

    if (req.method === 'POST' && pathname === '/api/steward/stop') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      stopStewardInbox();
      return send(res, json({ ok: true, running: false }));
    }

    if (req.method === 'GET' && pathname === '/api/steward/state') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const config = await readConfig();
      // 116f: 收件箱状态之上并进回合运行器状态(visit/turns/cost/circuit/lastReply)。运行器故障时
      // 这条只读路由仍然返回收件箱那一半 —— 状态面不该因为旁路组件出错而整条不可用。
      let runner = {};
      if (typeof StewardHooks.runnerState === 'function') {
        try { runner = (await StewardHooks.runnerState(config)) || {}; } catch { runner = {}; }
      }
      if (runner.lastReply && typeof runner.lastReply === 'object') {
        let reply = runner.lastReply;
        for (const key of ['say', 'why']) if (typeof reply[key] === 'string') {
          const text = await PrivacyGateway.displayText(STEWARD_SESSION_ID, reply[key]);
          if (text !== reply[key]) reply = { ...reply, [key]: text };
        }
        if (reply !== runner.lastReply) runner = { ...runner, lastReply: reply };
      }
      return send(res, json({ ok: true, ...await stewardInboxState(config), ...runner }));
    }

    if (req.method === 'GET' && pathname === '/api/steward/inbox') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const query = new URL(req.url, 'http://x').searchParams;
      const result = await stewardInboxRead({ since: query.get('since'), limit: query.get('limit') });
      return send(res, json({ ok: true, ...result }));
    }

    // 递话预判只读取投影。计时覆盖 preroute 本身，沿用既有的测量口径。
    if (req.method === 'GET' && pathname === '/api/steward/preroute') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const config = await readConfig();
      if (config.stewardEnabledV1 !== true) {
        return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
      }
      const query = new URL(req.url, 'http://x').searchParams;
      const q = String(query.get('q') || '').slice(0, STEWARD_PREROUTE_QUERY_MAX);
      const focus = String(query.get('focus') || '').slice(0, 80);   // 128h-J03:可缺;合法性由钩子那一侧(13o)的 safeSessionId 判,不合法当没给
      const startedAt = Date.now();
      const result = typeof StewardHooks.preroute === 'function'
        ? await StewardHooks.preroute(q, config, { focus })
        : { kind: 'new', hits: [] }; // 理论上不可能(13h 恒填充);兜底而不是抛异常
      const tookMs = Date.now() - startedAt;
      return send(res, json({ ok: true, kind: result.kind, hits: result.hits, tookMs }));
    }

    // ── 116-2e 记忆面板(27 号文 §4「面板」:按 kind 分组、可编辑、可否决、可清空、导出 JSON)──────
    // 六条 exact 路由,与其余 /api/steward/* 同一鉴权等级(token 级,ROUTE_AUTH 逐条登记)。刻意【不写】
    // `pathname.startsWith('/api/steward/memory')` 的前缀守卫 —— 那会在路由清册里多出一个裸前缀判定点
    // (116b 的原注释已经写明这条纪律);共用的「token + 开关」两道闸抽成 stewardPanelGate 一行调用。
    // 稳定信封必须在【路由层】转成 apiFailure —— 域层的 {ok:false,error} 送进 json() 会被
    // normalizeApiErrorPayload 归一成 api.request_failed(116g 交付记录里的硬教训)。
    if (req.method === 'GET' && pathname === '/api/steward/memory') {
      const gate = await stewardPanelGate(req); if (gate) return send(res, gate);
      const result = await stewardMemoryPanelList(new URL(req.url, 'http://x').searchParams.get('kind') || '');
      return send(res, result.ok === false ? stewardPanelFailure(result) : json(result));
    }

    if (req.method === 'GET' && pathname === '/api/steward/memory/export') {
      const gate = await stewardPanelGate(req); if (gate) return send(res, gate);
      return send(res, json(await stewardMemoryPanelExport()));
    }

    if (req.method === 'POST' && pathname === '/api/steward/memory/edit') {
      const gate = await stewardPanelGate(req); if (gate) return send(res, gate);
      const result = await stewardMemoryPanelEdit(await readJsonBody(req).catch(() => ({})));
      return send(res, result.ok === false ? stewardPanelFailure(result) : json(result));
    }

    if (req.method === 'POST' && pathname === '/api/steward/memory/veto') {
      const gate = await stewardPanelGate(req); if (gate) return send(res, gate);
      const body = await readJsonBody(req).catch(() => ({}));
      const result = await stewardImplMemoryVeto({ id: (body && body.id) || '' });
      return send(res, result.ok === false ? stewardPanelFailure(result) : json(result));
    }

    if (req.method === 'POST' && pathname === '/api/steward/memory/restore') {
      const gate = await stewardPanelGate(req); if (gate) return send(res, gate);
      const body = await readJsonBody(req).catch(() => ({}));
      const result = await stewardMemoryPanelRestore((body && body.id) || '');
      return send(res, result.ok === false ? stewardPanelFailure(result) : json(result));
    }

    if (req.method === 'POST' && pathname === '/api/steward/memory/clear') {
      const gate = await stewardPanelGate(req); if (gate) return send(res, gate);
      const body = await readJsonBody(req).catch(() => ({}));
      const result = await stewardMemoryPanelClear((body && body.confirm) || '');
      return send(res, result.ok === false ? stewardPanelFailure(result) : json(result));
    }

    // ── 117e 第 0 步:行动流水的只读面(§8.6 末条)────────────────────────────────────────
    // 与记忆面板同族(exact 路由、token 级、共用 stewardPanelGate 的两道闸)。纯只读:不建目录、
    // 不写盘、不启轮询。每行的 args 与 basis 过一遍 116-2e 的密钥判据再出门。
    if (req.method === 'GET' && pathname === '/api/steward/decisions') {
      const gate = await stewardPanelGate(req); if (gate) return send(res, gate);
      const query = new URL(req.url, 'http://x').searchParams;
      return send(res, json(await stewardDecisionsRead({
        limit: query.get('limit'), sessionId: query.get('sessionId'), since: query.get('since'),
      })));
    }

    await handleStewardRunnerApiRoutes(req, res, pathname);
  }

  async function handleStewardRunnerApiRoutes(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/steward/delivery') {
      await handleStewardDeliveryApiRoutes(req, res);
      if (res.writableEnded) return;
    }
    // 116h(27 号文 §3.1 116h 行 / §8.10 多线程看板):线程间仲裁的只读状态与插队。
    // 状态是纯内存读模型(running/queue/hour/day),不写盘;prioritize 只动队列顺序,不打断在跑的回合。
    if (req.method === 'GET' && pathname === '/api/steward/arbiter') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const config = await readConfig();
      if (config.stewardEnabledV1 !== true) {
        return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
      }
      return send(res, json({ ok: true, ...await stewardArbiterState(config) }));
    }

    if (req.method === 'POST' && pathname === '/api/steward/arbiter/prioritize') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const config = await readConfig();
      if (config.stewardEnabledV1 !== true) {
        return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
      }
      const body = await readJsonBody(req).catch(() => ({}));
      // 116-3 P1-13:改调 steward_thread_prioritize 的实现,不再直接碰仲裁器裸原语。
      // 修前这条路由(= 看板每行的「提升优先级」按钮)绕开了工具路径的两样东西:目标存在性/非管家会话
      // 校验,以及 decisions-v1.ndjson 的审计落盘 —— 于是【每一次经看板做的插队在行动流水里都没有记录】,
      // 与 §3.4 红线「全部行动经命令核心与审计」相悖;编造的 sessionId 也只是静默 not_queued。
      // 非法 sessionId 的稳定码仍由路由层给(invalid_session):它是「请求本身不合法」,不是「目标没找到」。
      if (!safeSessionId(body && body.sessionId)) {
        return send(res, apiFailure('invalid_session', {}, 'invalid sessionId', 400));
      }
      const result = await stewardImplThreadPrioritize({ sessionId: body.sessionId }, { config }, config);
      // 116g 硬教训:域层的 {ok:false,error} 直接送进 json() 会被 normalizeApiErrorPayload 归一成
      // api.request_failed,稳定信封必须在【路由层】转成 apiFailure。
      if (result && result.ok === false) return send(res, apiFailure(result.error, {}, result.message || result.error, 400));
      return send(res, json(result));
    }

    if (req.method === 'POST' && pathname === '/api/steward/reset') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const result = await stewardResetConversation();
      if (!result.ok) return send(res, apiFailure(result.error, {}, result.message || result.error, 409));
      return send(res, json(result));
    }

    if (req.method === 'POST' && pathname === '/api/steward/visit') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const config = await readConfig();
      if (config.stewardEnabledV1 !== true) {
        return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
      }
      const body = await readJsonBody(req).catch(() => ({}));
      const result = await stewardVisit({ force: body && body.force === true });
      if (result && result.ok === false) return send(res, apiFailure(result.error, {}, result.message || result.error, 409));
      return send(res, json(result));
    }

    if (req.method === 'POST' && pathname === '/api/steward/act') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const config = await readConfig();
      if (config.stewardEnabledV1 !== true) {
        return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
      }
      const body = await readJsonBody(req).catch(() => ({}));
      // 62 号第三轮 P1：同一次递话重试带同一个 attemptId；checkAttempt 只读回执，不触发执行。
      const result = await stewardRunAct(body && body.act, config, { attemptId: body && body.attemptId, check: Boolean(body && body.checkAttempt === true), window: body && body.attemptWindow });
      if (result && result.ok === false) return send(res, apiFailure(result.error, {}, result.message || result.error, 400));
      return send(res, json(result));
    }

    // 117l D2(§11.9):递话通道的 HTTP 面。抽屉「直接对这条线程说」与问答卡的自由回答都走它,
    // 不再自己在 /api/steer 与 /api/chat/stream 之间猜 —— “猜错了就把一个等回答的回合杀掉”正是用户第四轮
    // 走查第 1/6 条的根因。实现就是工具面那一个(同一条门控、同一本决策日志、同一个 undoRef),
    // trigger:'user' —— 用户就坐在抽屉前面敲这句话,无人值守的那两道闸不适用(与 /api/steward/act 同理)。
    // 不置 userPressed:那个字段只给 config_set / skill_toggle 的「须确认」判定用(06i 契约)。
    if (req.method === 'POST' && pathname === '/api/steward/relay') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const config = await readConfig();
      if (config.stewardEnabledV1 !== true) {
        return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
      }
      const body = await readJsonBody(req).catch(() => ({}));
      if (!safeSessionId(body && body.sessionId)) {
        return send(res, apiFailure('invalid_session', {}, 'invalid sessionId', 400));
      }
      const ensured = await ensureStewardSession(config);
      if (!ensured.ok) return send(res, apiFailure(ensured.error, {}, ensured.message || 'steward engine is unsupported', 409));
      const result = await StewardHooks.threadContinue(
        { sessionId: body.sessionId, message: body.message },
        { session: ensured.session, sessionId: ensured.session.id, config, trigger: 'user' },
      );
      // 116g 硬教训(同 /api/steward/arbiter/prioritize):域层的 {ok:false,error} 直接送进 json() 会被
      // normalizeApiErrorPayload 归一成 api.request_failed,稳定信封必须在【路由层】转成 apiFailure。
      if (result && result.ok === false) {
        const code = String(result.error || 'relay_failed');
        const status = (code === 'not_found' || code === 'invalid_request' || code === 'invalid_target') ? 400 : 409;
        return send(res, apiFailure(code, {
          ...(result.channel ? { channel: result.channel } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
          // 117l-A1-fix (1):queued 的等待原因也带上(与工具面同一份结构化 wait)—— 抽屉据此能显示
          // 「它在等锁 / 等预算 / 等并发位」,而不必去解析上面那句人话。别的通道没有这个键。
          ...(result.wait ? { wait: result.wait } : {}),
        }, result.message || code, status));
      }
      return send(res, json(result));
    }

    if (req.method === 'POST' && pathname === '/api/steward/message') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const config = await readConfig();
      if (config.stewardEnabledV1 !== true) {
        return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
      }
      const body = await readJsonBody(req).catch(() => ({}));
      const message = String((body && body.message) || '');
      if (!message.trim()) return send(res, apiFailure('invalid_request', {}, 'message is required', 400));
      // 133e:随这句话来的附件(/api/upload 的记录)。只收记录形状里那几个字段、≤12 条;交给回合的方式与 /api/chat/stream 同一条
      // (runSessionTurn 的 attachments —— 上传目录内的文件由那边按 id 核对,这里不信 path 字段能指到哪里)。
      const attachments = stewardSanitizeAttachments(body && body.attachments);
      const { start, writeEvent, flushDeltas } = createHttpNdjsonResponse(req, res, nowIso);
      const display = PrivacyGateway.createDisplayStream(STEWARD_SESSION_ID, writeEvent);
      let displayPending = Promise.resolve();
      const writeDisplayEvent = evt => {
        // write() snapshots the host event synchronously and already serializes display I/O.
        displayPending = display.write(evt);
        displayPending.catch(() => {});
      };
      start();
      try {
        // 117l D1:routeHint 随请求进来,但它只是【提示】—— 服务端只信 sessionId(见 stewardNormalizeRouteHint)。
        const result = await runStewardTurn({ trigger: 'user', message, routeHint: body && body.routeHint, attachments, onEvent: writeDisplayEvent });
        // 流的最后一帧 = 这次请求的响应载荷(见文件头「steward_reply 的投放口径」)。失败态也发这一帧:
        // 响应头早已发出,不能再改回 4xx 信封,故把稳定信封的 error/message 放进同一帧里,前端一处分支即可。
        const reply = (result && typeof result === 'object') ? result : {};
        writeDisplayEvent({
          type: 'steward_reply',
          trigger: 'user',
          say: String(reply.say || ''),
          why: String(reply.why || ''),
          acts: Array.isArray(reply.acts) ? reply.acts : [],
          actions: Array.isArray(reply.actions) ? reply.actions : [],
          parsed: reply.parsed === true,
          // 123-P1 ①(38 号文):这一帧是【白名单】,不是整份 reply 的展开 —— 13q 往回执里加的字段
          // 不写进这里就到不了前端。契约不完整那句灰字回执在 live 那条路(finishReply)靠的就是它。
          // 缺省不写,与落盘章同一口径。
          ...(reply.contractIncomplete === true ? { contractIncomplete: true } : {}),
          // 123-P1 收尾（38 号文 §4；P1 登记项①，主会话补）：`createdAt` 也漏在白名单外面。
          // 123-N1 ① 给 13q 的回执加了它（落盘那条助手消息的 createdAt），前端 finishReply 拿它
          // 推 `lastRenderedAt` 水位；可这一帧没带，前端读到的恒空，**主路径从未生效**，一直靠
          // `alignWatermark()` 那条兜底活着（每回合多发一次 `?since=`）。AB 段测得绿是因为它 stub
          // 了 fetch、直接喂带 createdAt 的回执，够不着这一帧。缺省不写，与上面两个同口径。
          ...(reply.createdAt ? { createdAt: String(reply.createdAt) } : {}),
          circuit: reply.circuit || null,
          ...(reply.ok === false && reply.error ? { error: reply.error, message: reply.message || '' } : {}),
        });
      } finally {
        try {
          try { await displayPending; }
          finally { await display.flush(); flushDeltas(); }
        } finally {
          display.close();
          try { res.end(); } catch { /* client gone */ }
        }
      }
      return;
    }
  }

  async function handleStewardDeliveryApiRoutes(req, res) {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    res.setHeader('cache-control', 'no-store');
    const q = new URL(req.url, 'http://x').searchParams;
    const sid = safeSessionId(q.get('sessionId')), seq = Number(q.get('turnSeq'));
    if (!sid || !Number.isSafeInteger(seq) || seq <= 0) return send(res, apiFailure('delivery.invalid_source', {}, '需要明确任务与回合', 400));
    const config = await readConfig();
    const delivery = await stewardDeliveryProjection(sid, seq, config);
    if (!delivery.ok) return send(res, apiFailure(delivery.error, {}, delivery.message, 404));
    if (!q.has('file')) return send(res, json(delivery));
    const index = Number(q.get('file'));
    const file = Number.isSafeInteger(index) && index >= 0 ? delivery.files[index] : null;
    if (!file || !file.fingerprint || q.get('fingerprint') !== file.fingerprint || q.get('sourceStamp') !== delivery.sourceStamp) return send(res, apiFailure('delivery.file_changed', {}, '文件或来源已变化,请重新检查交付卡', 409));
    // 使用既有预览器；路径仅取本回合真实记录,客户端不能指定另一个同名文件。
    const session = await loadSession(sid, { omitProviderHistory: true });
    if (!session) return send(res, apiSessionNotFound());
    const snapshot = await stewardDeliveryInspect(file, session, config, { bytes: 0 }, true);
    if (!snapshot.bytes || snapshot.fingerprint !== q.get('fingerprint')) return send(res, apiFailure('delivery.file_changed', {}, '文件已变化,请刷新文件状态', 409));
    return send(res, json(await readFilePreview(file.path, snapshot.bytes)));
  }

  return { handleStewardApiRoutes, handleStewardRunnerApiRoutes };
}

module.exports = { createStewardRoutes };
