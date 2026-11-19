'use strict';

function createStewardTurnRunner({
  RUYI_EVENTS, StewardHooks, logEvent, nowIso, safeSessionId, readConfig, stewardRunnerRuntime, stewardFail,
  stewardSanitizeText,
  sessions, admission, actions, replies, prompts, queue, limits,
}) {
  const { ensureStewardSession, loadSession, runSessionTurn, stewardReadSessionHead } = sessions;
  const {
    pendingPermissions, promptDeadlineIsReal, stewardAbortInflight, stewardAuthorizeExternalContext,
    stewardCircuitCheck, stewardMediatesPermissions,
  } = admission;
  const {
    STEWARD_ACTION_HOOKS, STEWARD_TOOL_LABELS, stewardDecideAttempted, stewardDowngradeActions,
    stewardExecuteActions, stewardSelfServeInbox,
  } = actions;
  const {
    stewardHumanizeSay, stewardLastAssistantContent, stewardLastAssistantFinalSegment, stewardStampReply,
    stewardTriggerStamp,
  } = replies;
  const { stewardInboxMessage, stewardNormalizeRouteHint, stewardParseReply } = prompts;
  const { stewardRequeueFailedInboxBatch, stewardScheduleInboxDrain } = queue;
  const {
    STEWARD_ACTS_MAX, STEWARD_INBOX_EVENTS_PER_TURN, STEWARD_SESSION_ID, STEWARD_USER_QUEUE_WAIT_MS,
  } = limits;

  // 单管家并发 1 + 用户抢占(§11.3):
  //   · 用户回合到达时,在途的【收件箱】回合被就地取消(停回合 + 该批事件重排到队列尾),用户永远优先;
  //   · 收件箱回合到达时若有任何在途回合,事件回排队列、本次不跑(去抖定时器会再来一次);
  //   · 用户回合撞用户回合:排队等前一个收尾(不取消 —— 用户自己的两句话都要答)。
  // 128f-⑪:已经报过「留给你」的权限请求 id(每条只报一次;有界,超过 512 条先进先出)。
  const stewardDeferredNotified = new Set();
  // 2026-10(用户拍板「管家常常只说留给你、不表态 —— 加强」):已经追问过一次的权限请求 id(每条最多追问一次;有界同上)。
  const stewardDecideNudged = new Set();
  // hunt2-steward ①:排队等槽位的用户回合(到达先后;只有排头能认领。见 runStewardTurn 的等待循环)。
  const stewardUserWaiters = [];
  async function runStewardTurn(input) {
    const generation = stewardRunnerRuntime.conversationGeneration;
    const opts = (input && typeof input === 'object') ? input : {};
    const trigger = opts.trigger === 'external' ? 'external' : opts.trigger === 'inbox' ? 'inbox' : 'user';
    let externalSource = null;
    if (trigger === 'external') {
      try { externalSource = (await stewardAuthorizeExternalContext({ trigger, externalActor: opts.externalActor })).externalSource; }
      catch { return stewardFail('external_channel.control_revoked', 'external owner authorization was revoked'); }
    }
    const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
    const events = Array.isArray(opts.events) ? opts.events : [];
    const config = await readConfig().catch(() => ({}));
    if (config.stewardEnabledV1 !== true) return stewardFail('steward.disabled', 'the workbench steward is disabled (stewardEnabledV1=false)');

    if (generation !== stewardRunnerRuntime.conversationGeneration || stewardRunnerRuntime.inflight?.kind === 'reset') {
      if (trigger === 'inbox') stewardRunnerRuntime.queue.push(...events);
      return stewardFail('steward.cancelled', '已开始新对话，这句没有送入新上下文');
    }
    const circuit = await stewardCircuitCheck(config, trigger);
    if (generation !== stewardRunnerRuntime.conversationGeneration) {
      if (trigger === 'inbox') stewardRunnerRuntime.queue.push(...events);
      return stewardFail('steward.cancelled', '已开始新对话，这句没有送入新上下文');
    }
    if (circuit) {
      if (trigger === 'inbox' && events.length) stewardRunnerRuntime.queue.push(...events);
      stewardRunnerRuntime.circuit = { ...circuit, at: nowIso() };
      const reply = { trigger, say: circuit.detail, why: '熔断', acts: [], actions: [], parsed: false, circuit };
      stewardRunnerRuntime.lastReply = { ...reply, at: nowIso() };
      logEvent({ kind: 'steward_circuit', circuit: circuit.kind, trigger });
      return { ok: false, circuit, ...reply };
    }

    // 117l D3(§11.9):本次回合的登记项在入口就造好(含一个占位 promise)—— 等待循环退出
    // 之后必须【同步】认领 stewardRunnerRuntime.inflight,中间不能有 await:两个等待者否则会在同一
    // 微任务里一起冲出去,各自开一个回合。占位 promise 在本函数真正返回时才 resolve —— 于是
    // 等在后面的那一句话不仅等到回合跑完,还等到 stewardStampReply 把结构化结果盖完章。
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const entry = { kind: trigger, controller, cancelled: '', events, promise: null, routeHint: await stewardNormalizeRouteHint(opts.routeHint),
      ...(trigger === 'external' ? { externalActor: opts.externalActor, externalSource } : {}) };
    let finishEntry = () => {};
    entry.promise = new Promise(resolve => { finishEntry = () => resolve(); });

    if (generation !== stewardRunnerRuntime.conversationGeneration || stewardRunnerRuntime.inflight?.kind === 'reset') {
      if (trigger === 'inbox') stewardRunnerRuntime.queue.push(...events);
      return stewardFail('steward.cancelled', '已开始新对话，这句没有送入新上下文');
    }
    if (trigger === 'external') {
      try { entry.externalSource = (await stewardAuthorizeExternalContext({ trigger, externalActor: entry.externalActor })).externalSource; }
      catch { return stewardFail('external_channel.control_revoked', 'external owner authorization was revoked'); }
      if (generation !== stewardRunnerRuntime.conversationGeneration) return stewardFail('steward.cancelled', 'conversation changed');
    }
    const inflight = stewardRunnerRuntime.inflight;
    if (trigger === 'inbox' && (inflight || stewardUserWaiters.length)) {
      // 有在途回合,或有用户的话正排着队(槽位刚空、它还没醒过来认领):收件箱批次回排,不插队。
      stewardRunnerRuntime.queue.push(...events);
      return stewardFail('steward.busy', 'a steward turn is already in flight; the inbox batch was re-queued');
    }
    if (inflight || stewardUserWaiters.length) {
      // 无论取消与否都等在途那个收尾:管家会话同一时刻只能有一个回合在写它的正文。
      //
      // 117l D3(§11.9;用户第四轮走查第 6 条):修前这里是【一发】 Promise.race(15s),之后不复查
      // stewardRunnerRuntime.inflight —— 一个跑了 16 秒还在写正文的回合会被这条路径直接放行,于是
      // 第二句用户的话带着另一个回合同时开跑,两个回合抢同一份 session.messages(后写者赢),用户
      // 看到的就是「输出完了还说在忙上一件」和一条被吞掉的回复。
      // 修法:循环等到轮到自己,总上限 5 分钟。真等过才记一条审计。
      //
      // hunt2-steward ①:修前循环条件是「inflight 仍是【进门时看到的】那一个」—— 两句用户的话排在同一个
      // 在途回合后面时,它一收尾,先醒的那句同步认领了槽位,后醒的那句一看「已经不是我等的那个了」也冲了
      // 出去,两个回合同时开跑,后开的把先开的 superseded 掉(一句话被吞)。现在:
      //   · 每一圈都【重读】槽位,只要里面还有别人就接着等;
      //   · 排队的用户回合按到达先后排成一列(stewardUserWaiters),只有排头能认领 —— 用户说的两句话
      //     按他说的顺序答,不看谁的定时器先醒;
      //   · 槽位里若换成了一个收件箱回合(理论上上面的入口已拦住,兜底),照「用户永远优先」抢占它。
      // 退出循环之后到认领之间仍然没有 await。
      stewardUserWaiters.push(entry);
      const waitStartedAt = Date.now();
      let waitedFor = inflight ? inflight.kind : 'user';
      try {
        for (;;) {
          if (generation !== stewardRunnerRuntime.conversationGeneration) return stewardFail('steward.cancelled', '已开始新对话，排队消息已取消');
          if (trigger === 'external') {
            try { entry.externalSource = (await stewardAuthorizeExternalContext({ trigger, externalActor: entry.externalActor })).externalSource; }
            catch { return stewardFail('external_channel.control_revoked', 'external owner authorization was revoked'); }
            if (generation !== stewardRunnerRuntime.conversationGeneration) return stewardFail('steward.cancelled', 'conversation changed');
          }
          const current = stewardRunnerRuntime.inflight;
          // Authorization awaited disk IO. Read the slot and FIFO after it, then claim without another await.
          if (!current && stewardUserWaiters[0] === entry) break;
          const target = current || stewardUserWaiters[0];
          waitedFor = target.kind;
          if (current && current.kind === 'inbox' && !current.cancelled) {
            current.cancelled = 'preempted';
            stewardRunnerRuntime.queue.push(...(current.events || []));   // 事件不丢:重排到下一轮
            stewardAbortInflight(current);
            logEvent({ kind: 'steward_preempt', preempted: 'inbox', requeued: (current.events || []).length });
          }
          if (Date.now() - waitStartedAt >= STEWARD_USER_QUEUE_WAIT_MS) {
            logEvent({ kind: 'steward_user_turn_timeout', waitedMs: Date.now() - waitStartedAt, waitedFor });
            return stewardFail('steward.busy', `上一件还没写完(已经等了 ${Math.round((Date.now() - waitStartedAt) / 1000)} 秒),先看看它是不是卡住了`, { trigger, waitedMs: Date.now() - waitStartedAt });
          }
          await Promise.race([
            (target.promise || Promise.resolve()).catch(() => {}),
            new Promise(resolve => { const t = setTimeout(resolve, 200); if (t && t.unref) t.unref(); }),
          ]);
        }
      } finally {
        // 认领或超时都出列(同步,与下面的认领之间没有 await)。
        const at = stewardUserWaiters.indexOf(entry);
        if (at >= 0) stewardUserWaiters.splice(at, 1);
      }
      const waitedMs = Date.now() - waitStartedAt;
      // 「真等过」才记账:抢占一个收件箱回合通常是毫秒级,那不该在审计里刷屏。
      if (waitedMs > 0) logEvent({ kind: 'steward_user_turn_queued', waitedMs, waitedFor, trigger });
    }

    stewardRunnerRuntime.inflight = entry;   // 同步认领(与上面的 while 判定之间没有 await)
    try {
      return await stewardRunClaimedTurn(trigger, opts, config, entry, controller, onEvent, events);
    } finally {
      if (stewardRunnerRuntime.inflight === entry) stewardRunnerRuntime.inflight = null;
      finishEntry();
    }
  }

  // 123-N1 ①:本回合落盘的那条助手消息的 createdAt(回执带给前端当水位用,见 stewardRunClaimedTurn
  // 里的调用点)。形状照抄同族的 stewardLastAssistantContent —— 同一条消息、同一个找法(从尾往前
  // 找第一条 assistant),只是取的字段不同;读不到会话、没有助手消息、字段缺失都回空串,调用方据此
  // 退到「对齐一发」的老路。代价是每回合多一次会话读:stewardLastAssistantContent 在 13p、本刀不碰
  // 它(硬纪律的独占文件表),合并成一次读是主会话的活,登记为一笔小债。
  async function stewardLastAssistantCreatedAt() {
    const session = await loadSession(STEWARD_SESSION_ID).catch(() => null);
    if (!session) return '';
    const messages = Array.isArray(session.messages) ? session.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'assistant') return String(messages[i].createdAt || '');
    }
    return '';
  }

  // 127 波 2-quater B2(45 号文 §2-quater.1 取证 6 / §2-quater.2「确定性回执」):管家回合里模型【直调】
  // steward_decide 代批了一条永久豁免命令,修前回执(executed)只收自理行与结构化 actions —— 代批了,用户却
  // 不一定知道(要看模型自己在 say 里提不提)。这里把本回合管家助手消息的 toolCalls 扫一遍:成功、且结果上
  // 带 13l 的 exemptDelegation 标记的 steward_decide,每条补一行回执,与结构化 actions 那一行同形
  // ({tool,label,args,result}),前端 appendActionReceipts 照常画成「已办:…」灰字、落盘的章也带着它。
  // 纯函数与装载分开:合并规则(去重)单测可直接喂数组。
  // 去重键 = interventionId:同一条待决只会被成功代批一次(第二次核心层回 already_terminal),
  // 所以「executed 里已经有一行成功的代批」就不再补 —— 结构化 actions 与工具直调撞在同一条上时只留一行。
  function stewardDelegationReceiptLabel(result, title) {
    const labels = (result && result.exemptDelegation && Array.isArray(result.exemptDelegation.labels))
      ? result.exemptDelegation.labels.map(stewardSanitizeText).filter(Boolean) : [];
    const kinds = labels.length ? `「${labels.join('」「')}」` : '';
    const where = title ? ` · 线程「${stewardSanitizeText(title).slice(0, 24)}」` : '';
    return `代批${kinds}${where}`;
  }
  function stewardMergeDelegationReceipts(executedRows, delegationToolCalls, titleOf) {
    const rows = Array.isArray(executedRows) ? executedRows : [];
    const delegatedId = row => {
      const r = row && row.result;
      if (!row || row.tool !== 'steward_decide' || !r || r.ok !== true || !r.exemptDelegation) return '';
      return String((row.args && row.args.interventionId) || '');
    };
    const seen = new Set(rows.map(delegatedId).filter(Boolean));
    const extra = [];
    for (const call of (Array.isArray(delegationToolCalls) ? delegationToolCalls : [])) {
      if (!call || String(call.name || '') !== 'steward_decide') continue;
      const args = (call.input && typeof call.input === 'object' && !Array.isArray(call.input)) ? call.input : {};
      const row = { tool: 'steward_decide', label: '', args, result: call.result };
      const id = delegatedId(row);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const sid = safeSessionId(args.missionId || args.sessionId);
      row.label = stewardDelegationReceiptLabel(call.result, typeof titleOf === 'function' ? titleOf(sid) : '');
      extra.push(row);
    }
    return extra;
  }
  async function stewardDelegationToolCalls(turnSeq, includeActions = false) {
    const want = Math.max(0, Number(turnSeq) || 0);
    if (!want) return [];
    const session = await loadSession(STEWARD_SESSION_ID).catch(() => null);
    const messages = Array.isArray(session && session.messages) ? session.messages : [];
    const out = [];
    for (const m of messages) {
      if (!m || m.role !== 'assistant' || Number(m.turnSeq) !== want || !Array.isArray(m.toolCalls)) continue;
      for (const call of m.toolCalls) {
        if (call && ((includeActions && (STEWARD_ACTION_HOOKS[call.name] || call.name === 'steward_bot_setup')) ||
          (call.name === 'steward_decide' && call.result && call.result.ok === true && call.result.exemptDelegation))) out.push(call);
      }
    }
    return out;
  }

  // 117l D3:认领之后的回合本体。抽出来只为让「同步认领 -> try/finally 释放」这条纪律
  // 一目了然:释放必须盖住【全部】退出路径 —— 含 stewardStampReply 之后那一段。修前它跑在
  // inflight 已经清空之后,第二句用户的话于是能在正文还没盖章时插进来。
  async function stewardRunClaimedTurn(trigger, opts, config, entry, controller, onEvent, events) {
    const ensured = await ensureStewardSession(config);
    if (!ensured.ok) {
      if (trigger === 'inbox') stewardRequeueFailedInboxBatch(events, 'engine_unavailable');
      return stewardFail(ensured.error, ensured.message || 'steward engine is unsupported', { engine: ensured.engine });
    }
    const session = ensured.session;
    // 116-2b:自理动作【先于模型】跑。它是确定性处置(见 stewardSelfServeInbox 的头注),结果作为
    // 收件箱事件的补充信息进回合层 —— 模型只需要说,不必再决定。用户回合不走这里:用户就在跟前,
    // 他这一句话本身就是指令,轮不到管家替他主动做什么(§3.3「没在说话时才叫主动」)。
    const selfServe = trigger === 'inbox' && events.length
      ? await stewardSelfServeInbox(events, session, config)
      : { executed: [], notes: [] };
    const message = trigger === 'inbox' ? await stewardInboxMessage(events, config, selfServe.notes) : String(opts.message == null ? '' : opts.message);
    if (!message.trim()) return stewardFail('invalid_request', 'message is required');
    if (trigger === 'external') {
      try { entry.externalSource = (await stewardAuthorizeExternalContext({ trigger, externalActor: entry.externalActor })).externalSource; }
      catch { return stewardFail('external_channel.control_revoked', 'external owner authorization was revoked'); }
    }

    if (!stewardRunnerRuntime.visit.startedAt) stewardRunnerRuntime.visit.startedAt = nowIso();
    stewardRunnerRuntime.visit.lastActivityAt = nowIso();
    stewardRunnerRuntime.turns.push(Date.now());

    const run = (async () => {
      try {
        return await runSessionTurn({
          sessionId: session.id,
          message,
          // 133e:用户在管家输入框里附的文件(只有 trigger:'user' 才可能有;收件箱回合没有)
          attachments: (trigger === 'user' && Array.isArray(opts.attachments)) ? opts.attachments : [],
          cwd: session.cwd,
          source: 'steward',
          engineRoute: ensured.route,
          // 收件箱回合的这条 user 消息【不是用户本人说的话】:origin 随会话正文落盘,
          // steward_memory_write 的来源校验据此拒绝它(steward-memory-tools 的 stewardSourceUserTexts)。
          messageMeta: trigger === 'inbox' ? { origin: 'inbox', inboxSeqs: events.map(e => Number(e && e.inboxSeq) || 0).slice(0, STEWARD_INBOX_EVENTS_PER_TURN) }
            : trigger === 'external' ? { origin: 'external-owner', externalSource: entry.externalSource } : null,
          requestMeta: { steward: true, trigger, ...(trigger === 'external' ? { external: entry.externalSource } : {}) },
          onEvent,
          signal: controller ? controller.signal : null,
        });
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    })();
    entry.run = run;
    const turn = await run;
    stewardRunnerRuntime.visit.lastActivityAt = nowIso();
    // 127 波 2-quater B2:回合里工具直调的代批(见 stewardMergeDelegationReceipts 头注)在三条出口【之前】取出来 ——
    // 回合被抢占 / 失败时,已经落定的代批照样是真的发生了,回执不能跟着回合一起丢。取不到回合号(回合整个抛出)
    // 就是空表。没有代批时三条出口的信封与修前逐字节相同。
    const turnToolCalls = await stewardDelegationToolCalls(turn && turn.turnSeq, true);
    // 设置直调也须出现在可见回执和历史章里，不能只留在折叠的工具轨迹中。
    const settingReceipts = turnToolCalls.filter(call => call.name === 'steward_config_set' && call.result?.error !== 'propose_required')
      .map(call => ({ tool: call.name, args: call.input?.privacy ? { privacy: true } : call.input || {}, label: STEWARD_TOOL_LABELS[call.name],
        result: call.result?.status === 'pending' && turn?.privacySettings ? { ...turn.privacySettings,
          receipt: { kind: 'settings', object: 'ruyi', changes: [{ key: 'privacyModeV1', value: turn.privacySettings.mode, scope: 'application', effective: 'next_turn' }] } } : call.result }));
    const externalToolFacts = trigger === 'external' ? {
      toolFailures: Math.min(100, turnToolCalls.filter(call => call.result?.ok === false && call.result.error !== 'propose_required').length),
      toolProposals: Math.min(100, turnToolCalls.filter(call => call.result?.ok === false && call.result.error === 'propose_required').length),
    } : {};
    const delegationCalls = turnToolCalls.filter(call => call.name === 'steward_decide' && call.result?.ok === true && call.result.exemptDelegation);
    const delegationTitles = new Map();
    for (const call of delegationCalls) {
      const sid = safeSessionId(call && call.input && (call.input.missionId || call.input.sessionId));
      if (!sid || delegationTitles.has(sid)) continue;
      const delegatedHead = await stewardReadSessionHead(sid).catch(() => null);
      delegationTitles.set(sid, delegatedHead ? String(delegatedHead.title || '') : '');
    }
    const delegationTitleOf = sid => delegationTitles.get(sid) || '';

    if (entry.cancelled) {
      logEvent({ kind: 'steward_turn_cancelled', reason: entry.cancelled, trigger });
      const cancelledReceipts = settingReceipts.concat(stewardMergeDelegationReceipts(selfServe.executed, delegationCalls, delegationTitleOf));
      return stewardFail('steward.cancelled', `steward turn cancelled: ${entry.cancelled}`, { trigger, ...(cancelledReceipts.length ? { actions: cancelledReceipts } : {}) });
    }

    // 回合本身失败(端点不通/被停/装载抛错)时【不能】去读「最后一条助手消息」—— 那是【上一个】回合
    // 的话,拿它当本回合的回答就是把旧答复冒充成新答复。如实回一条稳定信封,say 留给界面说人话。
    // hunt2-steward ③:成败还要看【内层】 result.ok(与 13k stewardRecordLaunchOutcome 同一口径)——
    // 端点回 HTTP 500 时 runSessionTurn 外层照样 ok:true(「这次调用完成了」),修前据此把一个失败回合
    // 当成功解析,say 为空、收件箱那一批事件已经从队列里拿走,就此蒸发。
    const turnInner = (turn && turn.result && typeof turn.result === 'object') ? turn.result : null;
    if (turn && (turn.ok === false || (turnInner && turnInner.ok === false))) {
      const detail = String(turn.error || (turnInner && (turnInner.error || turnInner.errorClass)) || '').slice(0, 300);
      logEvent({ kind: 'steward_turn_failed', trigger, error: detail });
      if (trigger === 'inbox') stewardRequeueFailedInboxBatch(events, 'turn_failed');
      // 自理动作已经真的发生了,回合失败不能把它们吞掉 —— 如实带回去(界面与 /api/steward/state 都能看到)。
      return stewardFail('steward.turn_failed', detail || 'the steward turn did not complete', { trigger, ...externalToolFacts, stopped: !!turn.stopped, actions: selfServe.executed.concat(settingReceipts, stewardMergeDelegationReceipts(selfServe.executed, delegationCalls, delegationTitleOf)) });
    }
    const finalText = await stewardLastAssistantContent();
    // 123-N1 ①(34 号文;用户 2026-09-13 真机走查「同一段对话出现两遍」):回执带上【本回合落盘的
    // 那条助手消息的 createdAt】。前端 finishReply 拿它推 appendSince 的水位 —— 修前水位只在
    // 「进壳画历史」那一处推高,用户自己发的回合直接上屏、从不推水位,于是下一条收件箱回合到达时
    // 壳层按旧水位重拉增量,把屏上已有的回合又画了一遍。
    // 取的是【同一条消息】的字段:stewardStampReply 盖章盖在「最后一条助手消息」上,这里读的也是
    // 它(盖章只写 .steward,不动 createdAt,所以先读后盖、先盖后读拿到的是同一个值)。用户那条消息
    // 的 createdAt 更早,水位推到助手这条即把两条一起盖住。
    const stampedAt = await stewardLastAssistantCreatedAt();
    let parsedReply = stewardParseReply(finalText);
    // 135:整段解析失败时退到【最后一段文字】再解析一次(见 13p stewardLastAssistantFinalSegment 头注)——
    // 工具调用之前那些边做边说的过程话不再和答复一起上屏。没有多段就是同一个结果,不另起一套兜底。
    if (!parsedReply.parsed) {
      const finalSegment = await stewardLastAssistantFinalSegment();
      if (finalSegment.trim()) parsedReply = stewardParseReply(finalSegment);
    }
    // 123-P1 ①(38 号文;用户 2026-09-14 真机取证):契约不完整 —— 模型没给必填的 why(判据与理由见
    // 13o stewardParseReply 那一段头注)。这里做两件事:记一条审计(trigger / 模型给了哪些键 / say
    // 有多长,正文一个字不进日志),以及往下把旗子带进回执与落盘的章 —— 前端据此在这条回复下面画
    // 一句灰字系统回执,明说「这一轮它没有执行任何动作」。
    // **诚实优先,不重试**:在同一回合里用一条纠正提示重跑一次模型这个方案评估过,不做 ——
    // 它必然动到回合语义的四处:① 第二发 runSessionTurn 会往管家会话里【真的】写一条 user 消息
    // (纠正提示)和第二条 assistant 消息,对话流回放时那条纠正提示会当成用户气泡上屏;
    // ② stewardRunnerRuntime.turns 与用量台账要么漏记(一次模型调用逃过每小时熔断与日费用)、
    // 要么多记(用户看到「一句话花了两个回合」);③ 抢占:重试把 inflight 的占用窗口拉长一倍,
    // 用户回合抢占一个收件箱回合的时序随之改变(controller 只有一个,abort 落在哪一发也要重新定义);
    // ④ stewardLastAssistantCreatedAt / turnSeq 取的是「最后一条助手消息」,重试后它指向第二发。
    // 派单稿的原话是「如果会动到回合循环、预算、熔断或抢占的语义,就不做」—— 四条全中,故登记为
    // 后续(要做得先给重试一条【不写会话正文】的旁路通道,那是 09-workflow 的地界)。
    if (parsedReply.contractIncomplete === true) {
      logEvent({
        kind: 'steward_contract_incomplete',
        trigger,
        keys: Array.isArray(parsedReply.contractKeys) ? parsedReply.contractKeys : [],
        sayChars: String(parsedReply.say || '').length,
      });
    }
    // 自理动作排在模型 actions 【前面】:它们先发生,steward_reply.actions 的顺序就该是事情发生的
    // 顺序。两者同形,故 stewardDowngradeActions 一视同仁 —— 自理侧被闸门拦下的行(propose_required)
    // 与模型侧被 13g 拦下的行走同一条降级路径,变成一个按钮。
    // 116-3 P2-11:自理侧【真的动过】的目标带进 actions 侧,两边合起来数同一个 3 —— 不是各数各的。
    const selfServeTargets = selfServe.executed.filter(row => row && row.acted === true).map(row => row.sessionId);
    // 3.0 收口走查(第四波):actions 是【这一回合】的动作,闸门与配额 / 污点按回合序号取键(13j stewardTaintKeyOf → providerTurnQuotaKey)。
    // 修前传的是回合开始前 ensureStewardSession 装载的那份会话对象,turnSeq 还停在上一回合 —— 同一回合里读过网页打下的污点(键 t N)
    // 在这里查成 t(N-1):查不到本回合的,反而可能查到上一回合的。按本回合的序号给一份浅拷贝(只用作 ctx,不落盘)。
    const actionSession = (turn && Number(turn.turnSeq) > 0) ? { ...session, turnSeq: Number(turn.turnSeq) } : session;
    const actionRows = parsedReply.actions.length
      ? await stewardExecuteActions(parsedReply.actions, actionSession, config, trigger, selfServeTargets, entry.externalActor)
      : [];
    // 127 波 2-quater B2:回合里工具直调的代批补进回执(上面已取出)。顺序按事情发生的先后:自理(模型之前)→
    // 回合里的工具调用 → 回合结束后执行的结构化 actions。没有代批时 delegationRows 为空,executed 与修前逐元素相同。
    const delegationRows = stewardMergeDelegationReceipts(selfServe.executed.concat(actionRows), delegationCalls, delegationTitleOf);
    const executed = selfServe.executed.concat(settingReceipts, delegationRows, actionRows);
    // Direct tool calls happen before the final JSON reply too. Their receipts
    // must invalidate duplicate buttons just like the structured actions do.
    const directReceipts = turnToolCalls.map(call => ({ tool: call.name, args: call.input || {}, result: call.result }));
    const acts = stewardDowngradeActions(executed, parsedReply.acts, directReceipts);
    if (trigger === 'user') {
      const prepared = turnToolCalls.find(call => call.name === 'steward_bot_setup' && call.input?.op === 'prepare'
        && call.result?.ok === true && call.result.prepared === true && /^[a-z][a-z0-9_-]{0,63}$/.test(call.result.connectionId));
      if (prepared) {
        if (acts.length >= STEWARD_ACTS_MAX) acts.pop();
        acts.push({ kind: 'external_bot_setup', connectionId: prepared.result.connectionId, label: '继续配置机器人' });
      }
    }
    // 117l D5:say/why 在【这里】过一遍人话化 —— 于是 steward_reply 帧、落盘的 meta、/api/steward/state
    // 的 lastReply 三处拿到的是【同一份】文字(修前 ※ 里满是 sess_/question_)。acts/actions 不动。
    const say = await stewardHumanizeSay(parsedReply.say);
    const why = await stewardHumanizeSay(parsedReply.why);
    const reply = {
      trigger,
      ...externalToolFacts,
      say,
      why,
      acts,
      actions: executed,
      parsed: parsedReply.parsed,
      turnSeq: Number(turn && turn.turnSeq) || 0,
      sessionId: session.id,
      // 123-N1 ①:落盘时刻(ISO 8601 定长 UTC 串,与 GET /api/sessions/steward?since= 同一把尺)。
      // 读不到就不下发这个键 —— 前端缺省时自己走「对齐一发」的退路,老回执逐字节不变。
      ...(stampedAt ? { createdAt: stampedAt } : {}),
      // 123-P1 ①:【缺省不写】。老回合的落盘章里读不到这个键即为 false,前端 `=== true` 判定,
      // 一份历史都不用迁移。
      ...(parsedReply.contractIncomplete === true ? { contractIncomplete: true } : {}),
      circuit: null,
    };
    // 117s-H4:落盘的回执带来源(对象);reply.trigger(内存态 lastReply 与 steward_reply 帧)仍是字符串。
    await stewardStampReply({
      say: reply.say, why: reply.why, acts: reply.acts, actions: reply.actions, parsed: reply.parsed,
      // 123-P1 ①:落盘的章也带这一面 —— 回放那条路(前端 renderHistorySince)只看得到这份章,
      // live 与刷新之后看到的必须是同一句话。同样缺省不写。
      ...(reply.contractIncomplete === true ? { contractIncomplete: true } : {}),
      trigger: await stewardTriggerStamp(trigger, events).catch(() => ({ kind: trigger })),
    });
    // 121-K2a(§6.1 第 3 条):管家刚说完一句并落了盘。**正文不进事件**(§6.1 红线;避免双写)——
    // 前端收到这一帧再去拉一次消息面,拉到的与落盘的是同一份。
    RUYI_EVENTS.emit('steward.say', { turnSeq: reply.turnSeq, trigger: String(trigger || '') });
    // 128f-⑪(Brief §4.2 第 7 条前半;用户拍板 A「立刻通知你,请求挂 600 秒等你处理」):这一回合看过的权限请求,
    // 回合结束时还挂着 = 管家没替你批、留给你了。真模型实测管家常常【不调】steward_decide、只说一句「留在那儿等你过目」
    // (45 号文 §9.6.5 (b)),所以判据是「还挂着」,不是「调了拒」。每条请求只报一次;窗口已经过了的不报。
    if (trigger === 'inbox') {
      const nudges = [];
      for (const evt of events) {
        const payload = (evt && evt.payload && typeof evt.payload === 'object') ? evt.payload : {};
        if (!evt || evt.kind !== 'needs_you' || payload.interventionType !== 'permission') continue;
        const interventionId = String(payload.interventionId || '');
        const pending = interventionId ? pendingPermissions.get(interventionId) : null;
        if (!pending || stewardDeferredNotified.has(interventionId)) continue;
        if (Number(pending.deadlineAt) && Number(pending.deadlineAt) <= Date.now()) continue;
        // 只报管家【经手】的线程(13k stewardMediatesPermissions;2026-10 起含用户自己开、按智能自动在跑的):
        // 不归管家处理的线程,那条请求的通知是收件箱 needs_you 自己那一路;用户此刻就坐在 / 看着那条线程,也不报(请求是当面弹着的)。
        const sid = String(evt.sessionId || '');
        const head = await stewardReadSessionHead(sid).catch(() => null);
        if (!stewardMediatesPermissions(sid, config, head)) continue;
        // 2026-10 追问:这一回合管家对它【一个态都没表】—— 没调 steward_decide(13l 记着,被工具挡回也算表过态),
        // 也没把它做成按钮交给用户 —— 就先不报「留给你」,把它带一个 nudge 标记排回队头,让下一回合专门表态
        // (13p 给这种行加一句点名要求)。每条最多追问一次:追问那一回合还不表态,照旧报「留给你」。
        const proposed = acts.some(act => act && act.tool === 'steward_decide' && act.args && String(act.args.interventionId || '') === interventionId);
        if (!proposed && !stewardDecideAttempted(interventionId) && !stewardDecideNudged.has(interventionId)) {
          stewardDecideNudged.add(interventionId);
          if (stewardDecideNudged.size > 512) stewardDecideNudged.delete(stewardDecideNudged.values().next().value);
          nudges.push({ ...evt, payload: { ...payload, nudge: true } });
          continue;
        }
        stewardDeferredNotified.add(interventionId);
        if (stewardDeferredNotified.size > 512) stewardDeferredNotified.delete(stewardDeferredNotified.values().next().value);
        RUYI_EVENTS.emit('steward.deferred', {
          sessionId: String(evt.sessionId || ''),
          interventionId,
          ask: String(payload.summary || payload.ask || ''),
          // 不限时的请求没有截止时刻:给空串,前端就说「留给你」而不是「还等你 35000 分钟」。
          deadlineAt: promptDeadlineIsReal(pending.deadlineAt) ? new Date(Number(pending.deadlineAt)).toISOString() : '',
        });
      }
      // 追问排回队头:收件箱排空器在本回合结束后自己接着排(权限待决走 1 s 去抖,见 stewardInboxDebounceMs)。
      if (nudges.length && !stewardRunnerRuntime.stopped) {
        stewardRunnerRuntime.queue.unshift(...nudges);
        logEvent({ kind: 'steward_decide_nudge', count: nudges.length });
      }
    }

    // 无进展熔断的计数:只看收件箱回合(用户回合永远清零 —— 用户说话就是进展)。
    if (trigger === 'inbox') {
      if (!acts.length && !executed.length) stewardRunnerRuntime.noProgress += 1;
      else stewardRunnerRuntime.noProgress = 0;
    } else {
      stewardRunnerRuntime.noProgress = 0;
      // 116-3 P1-10:用户回合收尾时顺带把积压的收件箱事件排上 —— 用户说话解除退避,却不带走队列里
      // 那些没人处理的事件,是修前那个「积压永久停滞」的另一半。
      stewardScheduleInboxDrain();
    }
    // 116-2e(§11.1 第 2 项「速查线程自动收工」):速查线程的 done 事件【已经进过这一回合】之后才
    // 收工 —— 顺序不能反。先收工的话总览与搜索里就没这条了,管家转述答案时会发现自己刚读到的那条
    // 线程凭空消失。收工只写会话头上的 stewardQuick.closedAt,不动正文、不进事项、不改执行语义。
    if (trigger === 'inbox' && typeof StewardHooks.quickClose === 'function') {
      for (const evt of events) {
        if (!evt || evt.kind !== 'done') continue;
        if (!(evt.payload && evt.payload.quick === true)) continue;
        try { await StewardHooks.quickClose(evt.sessionId); } catch { /* 旁路:收工失败不影响这一回合 */ }
      }
    }
    stewardRunnerRuntime.lastReply = { ...reply, at: nowIso() };
    return { ok: true, ...reply };
  }

  return {
    runStewardTurn, stewardMergeDelegationReceipts,
  };
}

module.exports = { createStewardTurnRunner };
