'use strict';

function createStewardAutonomousActions({
  logEvent, safeSessionId, stewardFail, stewardSanitizeText, stewardDisplayTitleOf, stewardRunnerRuntime,
  actionHooks, sessions, runSnapshots, admission, budget, limits,
}) {
  const { StewardHooks, STEWARD_ACTION_HOOKS, stewardAppendDecision } = actionHooks;
  const {
    activeChildren, detectDanglingTurn, loadSession, readInterventions, sessionTodosSignature,
    stewardAsksYouForThread, stewardLastAssistantText, stewardReadSessionHead, stewardThreadPermissionMode,
  } = sessions;
  const { stewardReadRunSnapshot, stewardRunResumeTier } = runSnapshots;
  const {
    stewardMayAct, stewardPermissionLabel, stewardSeatedByUser, stewardStoppedRefusal, stewardStoppedTarget,
    stewardTargetPermission,
  } = admission;
  const { stewardDayCost, stewardTurnsInWindow } = budget;
  const {
    SESSION_LOAD_OMIT_PROVIDER, STEWARD_CONTINUE_FRESH_MS, STEWARD_CONTINUE_NOPLAN_MAX,
    STEWARD_CONTINUE_PLAN_MAX, STEWARD_CONTINUE_PROMPT, STEWARD_SELF_SERVE_ATTEMPT_MAX,
    STEWARD_SELF_SERVE_PER_TURN_MAX, STEWARD_SELF_SERVE_RETRY_WINDOW_MS, STEWARD_TURN_WINDOW_MS,
  } = limits;

  // ════════════════════════════════════════════════════════════════════════════
  // 116-2b · 自理动作的确定性处置(§3.3「管家可以自己做的事」清单的真实执行)
  //
  // 为什么先于模型、且不经模型:失败重试与重启续跑是【确定性】的处置 —— 该不该做由三样东西唯一
  // 决定(自理清单勾选 / 目标线程权限 / 该目标最近有没有被管家动过),没有一样需要「理解」。让模型
  // 每次都重新推一遍,既慢又不稳定,还会把「能不能做」的判据散到提示词里去。所以:工作台先按规则
  // 把该做的做掉,把【结果】当成收件箱事件的补充信息带进回合层,模型只需要「说」——把发生的事讲给
  // 用户听、必要时补一个按钮。
  //
  // 闸门顺序(任一不过就降级成一条提议,不是失败):
  //   ① 停机 / 熔断      —— 由 runStewardTurn 的 stewardCircuitCheck 在更外层挡掉(停机时根本不到这里);
  //   ② 小时窗           —— 自理动作与管家回合【计入同一个】 stewardMaxTurnsPerHour 窗口;
  //   ③ 无进展熔断       —— 同一目标连续 2 次自理动作后仍在报问题 -> 停自动,只提议;
  //   ③b 被停下来的目标   —— 125-P0:班组快照 status:'stopped' 或会话头上那条账说末回合 aborted ->
  //                          不自动重开,只提议。判据在 06i 一处(13k / 13l 的工具内部各调了一次,
  //                          那是权威点;这里是预闸 —— 拦在配额与计数【之前】,省掉一次小时窗名额);
  //   ④ 自理清单勾选     —— retry / resume(resume 为 null 时跟随既有 autonomyAutoResume);
  //   ⑤ 目标线程权限     —— stewardMayAct(mode,'failed','exec'),续跑按 failed 档口径(§3.3);
  //   ⑥ 续跑另加一道     —— classifyRunResumeTier 必须判 auto_resumable(权限面不可证明就不自动);
  //   ⑦ 13g 工具内部     —— 永久豁免与 stewardMayAct 的【权威】判据在那里,拿到 propose_required
  //                          就照既有路径降级成按钮。本文件不复制那套判据。
  //
  // relay(事项内交接)本切片仍【只提议】(默认 false,§11.1 第 6 项);newThread 只在 relay 或定时
  // 触发时才允许,而本切片没有引入任何定时触发源 —— 故这里【不存在】自动新开线程的路径:自理侧
  // 根本不产生这两种 plan,模型若把它们写进 actions 仍由 stewardSelfServeAllows 那两道闸拦下。
  // ════════════════════════════════════════════════════════════════════════════

  function stewardSelfServeKey(sessionId, runId) {
    return String(sessionId || '') + '|' + String(runId || '');
  }
  function stewardSelfServeEntry(key) {
    let row = stewardRunnerRuntime.selfServe.get(key);
    if (!row) { row = { attempts: 0, lastRetryAt: 0, lastActionAt: 0 }; stewardRunnerRuntime.selfServe.set(key, row); }
    return row;
  }

  // 收件箱事件 -> 处置意图。返回 null = 只进回合层(让模型说,不自动动手)。
  //   failed  : run 类(事件带 runId 与 nodeId)-> retry_node;回合类 -> thread_continue「继续」
  //   stalled : 只有【重启续跑类】(run_interrupted / run_resume_deferred)才自动 resume;
  //             node_idle_aborted / node_no_progress_aborted / run_stalled 是「跑不动」而不是「被打断」,
  //             盲目续跑只会再撞一次同一堵墙 -> 一律只进回合层。
  function stewardSelfServePlan(evt) {
    const e = (evt && typeof evt === 'object') ? evt : {};
    const sessionId = safeSessionId(e.sessionId);
    if (!sessionId) return null;
    const runId = safeSessionId(e.runId);
    const payload = (e.payload && typeof e.payload === 'object') ? e.payload : {};
    if (e.kind === 'failed') {
      if (runId && payload.nodeId) {
        return { intent: 'retry', label: '重试', tool: 'steward_run_action', sessionId, runId,
          args: { sessionId, runId, action: 'retry_node', nodeId: String(payload.nodeId) } };
      }
      // 原话固定为「继续」(不由模型编);origin 标进决策日志的 basis,事后能分清哪一句是自理重试。
      return { intent: 'retry', label: '重试', tool: 'steward_thread_continue', sessionId, runId: '',
        args: { sessionId, message: '继续' }, origin: 'steward-retry' };
    }
    if (e.kind === 'stalled') {
      const type = String(payload.eventType || '');
      if (runId && (type === 'run_interrupted' || type === 'run_resume_deferred')) {
        return { intent: 'resume', label: '续跑', tool: 'steward_run_action', sessionId, runId,
          args: { sessionId, runId, action: 'resume' }, origin: 'steward-resume' };
      }
    }
    // 「回合收了、可任务没做完」:只有【线程回合收工】那一类 done(第四源 session_turn)才进来,
    // 速查线程(quick)与被停下的回合(aborted)不算。它只是个【候选】——到底没做完没有、能不能自己续,
    // 要读线程现场才知道,由 stewardContinueUnfinishedGate 判(不是这个纯函数的事);判出来「其实做完了」
    // 的,闸门回 silent,不留任何痕迹。
    if (e.kind === 'done' && payload.source === 'session_turn' && payload.quick !== true && payload.aborted !== true) {
      return { intent: 'continue', label: '继续', tool: 'steward_thread_continue', sessionId, runId: '',
        args: { sessionId, message: STEWARD_CONTINUE_PROMPT }, origin: 'steward-continue' };
    }
    return null;
  }

  // 续跑的第六道闸:重启后这条班组敢不敢自动跑,由既有 classifyRunResumeTier 说了算(权限面不可
  // 证明 / 有非纯读节点停在半路 -> manual_resume_required)。读不到快照一律按不安全处理。
  // 116-3 P0-4:判定本体搬去 13g 的 stewardRunResumeTier(与 steward_run_action 工具内部共用同一份
  // ——「唯一权威判据」要真的唯一);本文件的自理预闸只是调它,不再另写一份。13h -> 13g 是后向边。

  // 小时窗是否已满:自理动作(含下面的「没做完就续」)与管家回合共用 stewardMaxTurnsPerHour。
  // 满了回 { limit },没满回 null。单点,免得几道闸各写一遍 `>= maxTurns`。
  function stewardHourWindowFull(config, now) {
    const maxTurns = Math.max(0, Math.round(Number(config && config.stewardMaxTurnsPerHour) || 0));
    if (maxTurns > 0 && stewardTurnsInWindow(now, STEWARD_TURN_WINDOW_MS) >= maxTurns) return { limit: maxTurns };
    return null;
  }

  async function stewardSelfServeGate(plan, config) {
    const auto = (config && config.stewardAutoActions && typeof config.stewardAutoActions === 'object') ? config.stewardAutoActions : {};
    const key = stewardSelfServeKey(plan.sessionId, plan.runId);
    const entry = stewardSelfServeEntry(key);
    const now = Date.now();

    // ② 小时窗:自理动作与管家回合共用 stewardMaxTurnsPerHour(§11.3「自理动作计入同一窗口」)。
    const hourFull = stewardHourWindowFull(config, now);
    if (hourFull) return { allowed: false, reason: `本小时管家的动作已经到上限(${hourFull.limit}),这件事只能提议` };
    // ③ 无进展熔断:同一目标连着自理两次还在报问题,说明自动重试解决不了,交回给人。
    if (entry.attempts >= STEWARD_SELF_SERVE_ATTEMPT_MAX) {
      return { allowed: false, reason: `这条线程已经自动处置过 ${entry.attempts} 次仍未好转,不再自动动手,只提议` };
    }
    // ③b 125-P0:目标是被【停】下来的 -> 不自动重开。判据在 06i 一处,本文件只调用;工具内部
    // (13k 递话 / 13l 班组动作)还会各判一次 —— 那两处是权威点,这里只是预闸:排在配额与计数之前,
    // 被停的目标不该白占一个小时窗名额,也不该把 attempts 记成「自理过一次」。
    const stoppedWhich = stewardStoppedTarget(
      await stewardReadSessionHead(plan.sessionId).catch(() => null),
      plan.runId ? await stewardReadRunSnapshot(plan.sessionId, plan.runId) : null,
    );
    if (stoppedWhich) return { allowed: false, reason: stewardStoppedRefusal(stoppedWhich) };
    const mode = await stewardTargetPermission(plan.args, config);
    if (plan.intent === 'retry') {
      if (auto.retry !== true) return { allowed: false, reason: '「失败自动重试」没有勾选,只能提议' };
      // ④' 同一目标本小时只自动重试一次 —— 失败往往连着来,一小时内重复重试就是刷钱。
      if (entry.lastRetryAt && now - entry.lastRetryAt < STEWARD_SELF_SERVE_RETRY_WINDOW_MS) {
        return { allowed: false, reason: '这条线程本小时已经自动重试过一次了,再失败只提议' };
      }
      if (stewardMayAct(mode, 'failed', 'exec') !== 'auto') {
        return { allowed: false, reason: `目标线程权限为「${stewardPermissionLabel(mode)}」,失败重试只能提议` };
      }
      return { allowed: true, mode };
    }
    if (plan.intent === 'resume') {
      const resume = auto.resume === null || auto.resume === undefined ? (config && config.autonomyAutoResume === true) : auto.resume === true;
      if (!resume) return { allowed: false, reason: '「重启后自动续跑」没有开,只能提议' };
      if (stewardMayAct(mode, 'failed', 'exec') !== 'auto') {
        return { allowed: false, reason: `目标线程权限为「${stewardPermissionLabel(mode)}」,自动续跑只能提议` };
      }
      const tier = await stewardRunResumeTier(plan.sessionId, plan.runId, config);
      if (tier !== 'auto_resumable') {
        return { allowed: false, reason: `这条班组重启后被判为「${tier || '未知'}」,自动续跑不安全,只能提议` };
      }
      return { allowed: true, mode };
    }
    return { allowed: false, reason: '这类事件没有确定性处置,交给你判断' };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 「回合收了、任务没做完」→ 管家自己给线程续一轮(stewardAutoActions.continueUnfinished)
  //
  // 用户 2026-10(真机截图):线程「GPT6与Claude旗舰模型对比」计划 0/5、89 次工具调用后回合收了,线程头上亮着
  // 「上次任务未完成 [继续]」,管家那一侧却把它报成「已收工」,还反过来问用户「要我拉出来报一报吗」——
  // 「像这种情况,管家要能自主让线程恢复啊」。五态本身不看这件事(无账本线程:回合跑完且没失败 = done),
  // 所以补的是【自理动作】:收到「线程回合收工」(done · session_turn)时,管家读一眼线程现场,没做完且
  // 该自己续的,就替用户点那一下「继续」。
  //
  // 「没做完」的判据【不另写】,两条都是界面已经在用的:
  //   ① 「上次任务未完成」横幅 = 02 的 detectDanglingTurn(GET /api/sessions/:id 的 resumable.dangling,
  //      前端 renderResumeBanner 读它):providerHistory 的尾巴是 user / tool(回合被工具次数上限、预算保护、
  //      重复调用护栏截断而没有收口);
  //   ② 计划条「已完成 n/m」读的 session.todos:还有 status !== 'done' 的步骤(与 02 摘要的 todosOpen 同口径),
  //      且这份计划是【上一回合动过的】(或本就在管家的续跑链上)—— 搁下的旧计划不算。
  // 「该不该自己续」的闸,顺序即安全(任一不过就 silent 或降级成提议,不是失败):
  //   silent(不留痕):线程其实做完了 / 还在跑 / 在问用户(正式待决或软问句)/ 用户正坐在上面 / 事项驱动器
  //                    (until-done)自己会续 / 上一回合是被停下的;
  //   提议:开关没勾 / 小时窗满 / 当日花费到顶 / 线程是「每步都问」档 / 达到上限(记行动流水)。
  // 上限见 13m 的 STEWARD_CONTINUE_*:有计划 = 每次续跑之后已完成步数必须增加、且最多连续 5 次;
  // 无计划 = 最多 2 次。全局的并发/小时/日费用仲裁由 runSessionTurn 里的 13n 仲裁器照常管着(续跑也是一个回合)。
  // ────────────────────────────────────────────────────────────────────────────
  async function stewardUnfinishedFacts(sessionId) {
    const sid = safeSessionId(sessionId);
    if (!sid) return null;
    const session = await loadSession(sid, 0, 0, SESSION_LOAD_OMIT_PROVIDER).catch(() => null);
    if (!session || !session.id) return null;
    const dangling = detectDanglingTurn(session);   // 横幅同一判据(见上 ①)
    const todos = (Array.isArray(session.todos) ? session.todos : []).filter(t => t && typeof t === 'object');
    const total = todos.length;
    const done = todos.filter(t => t.status === 'done').length;
    const open = total - done;
    const turnSeq = Math.max(0, Number(session.turnSeq) || 0);
    // ② 的计划只认【上一回合动过的】:成败账带着回合开头的计划指纹(10 写),与现值不同 = 这一回合在推进它。
    // 早就搁下的旧计划(用户之后换了话题、回合正常答完)不算「没做完」—— 否则每个新回合收工都会被拉去续那份旧计划。
    const last = session.stewardLastTurn && typeof session.stewardLastTurn === 'object' ? session.stewardLastTurn : null;
    const todosTouched = !!(last && Number(last.seq) === turnSeq && last.todosStartSig
      && last.todosStartSig !== sessionTodosSignature(session.todos));
    const mission = session.mission || null;
    return {
      sessionId: sid,
      head: session,
      turnSeq,
      dangling: dangling.dangling === true ? String(dangling.kind || '') : '',
      todos: { total, done, open },
      todosTouched,
      active: activeChildren.has(sid),
      missionDone: !!(mission && mission.result && mission.result.status === 'complete'),
      driverOwns: !!(mission && mission.autoMode === 'until-done'),
    };
  }
  // 「在问用户」:只在确实没做完时才读待决(读的是磁盘上的一份文件,收工事件每条都来一遍不划算)。
  async function stewardUnfinishedAsks(facts) {
    const sid = facts.sessionId;
    const pending = (await readInterventions(sid).catch(() => [])).filter(iv => iv && iv.status === 'pending');
    const asks = stewardAsksYouForThread({
      pending, activeTurn: activeChildren.has(sid),
      lastAssistantText: stewardLastAssistantText(facts.head),
    });
    return !!asks || pending.length > 0;
  }
  // 行动流水 / 提示里那一句「没做完」的人话:横幅判据与计划进度各说各的,都有就并说。
  function stewardUnfinishedBrief(facts) {
    const bits = [];
    if (facts.planOpen && facts.todos.total > 0) bits.push(`计划已完成 ${facts.todos.done}/${facts.todos.total}`);
    if (facts.dangling) bits.push('回合没有收口(被工具次数上限等截断,界面上亮着「上次任务未完成」)');
    return bits.join(';') || '回合没有收口';
  }

  async function stewardContinueUnfinishedGate(plan, config) {
    const silent = { allowed: false, silent: true };
    const sid = plan.sessionId;
    const rt = stewardRunnerRuntime.continueUnfinished;
    const facts = await stewardUnfinishedFacts(sid);
    if (!facts || facts.active) return silent;
    const now = Date.now();
    // 上限与「计划有没有往前走」。账只认【连续】的自动续跑:中间若有别人(用户)插进来说了话 —— 当前回合号不是
    // 「上次续跑前的回合号 + 1」—— 或者隔了太久,就当这是一次全新的没做完,从 0 数。
    let prev = rt.get(sid) || null;
    if (prev && (facts.turnSeq !== prev.turnSeq + 1 || now - prev.at > STEWARD_CONTINUE_FRESH_MS)) { rt.delete(sid); prev = null; }
    // 计划证据:上一回合动过计划,或者这本就是管家续跑链上的一环(续跑回合由 13k 记账、不带指纹)。
    const planOpen = facts.todos.open > 0 && (facts.todosTouched || !!prev);
    if ((!facts.dangling && !planOpen) || facts.missionDone) { rt.delete(sid); return silent; }   // 做完了:账清零,什么都不说
    facts.planOpen = planOpen;
    // 在问用户 / 有待决:不是「没做完」,是「等你」—— 那条路归 needs_you 与代答那一格,这里不插手。
    if (await stewardUnfinishedAsks(facts)) return silent;
    if (facts.driverOwns) return silent;                     // until-done 驱动器会自己续,不抢
    if (stewardSeatedByUser(sid)) return silent;             // §4.5 用户正坐在这条线程上:他自己看得见横幅
    if (stewardStoppedTarget(facts.head, null)) return silent;   // 上一回合是被停下来的:不撤销别人按下的停
    const brief = stewardUnfinishedBrief(facts);
    const deny = (reason, extra) => ({ allowed: false, reason, facts, brief, ...(extra || {}) });

    const auto = (config && config.stewardAutoActions && typeof config.stewardAutoActions === 'object') ? config.stewardAutoActions : {};
    if (auto.continueUnfinished === false) return deny('「任务没做完时自动续上」没有勾选,只能提议');
    const hourFull = stewardHourWindowFull(config, now);
    if (hourFull) return deny(`本小时管家的动作已经到上限(${hourFull.limit}),这件事只能提议`);
    const maxCost = Number(config && config.stewardMaxCostPerDay);
    if (Number.isFinite(maxCost) && maxCost > 0) {
      const spent = await stewardDayCost(config);
      if (spent >= maxCost) return deny(`今天管家已经花了 ${spent},到了上限 ${maxCost},没做完的任务只能提议`);
    }
    // 会话头已经在手上:直接取它的权限档,不再经 stewardTargetPermission 把整份会话再读一遍。
    const mode = stewardThreadPermissionMode(facts.head, config);
    if (stewardMayAct(mode, 'failed', 'exec') !== 'auto') {
      return deny(`目标线程权限为「${stewardPermissionLabel(mode)}」,没做完的任务只能提议`);
    }
    if (prev) {
      const hasPlan = facts.todos.total > 0;
      const cap = hasPlan ? STEWARD_CONTINUE_PLAN_MAX : STEWARD_CONTINUE_NOPLAN_MAX;
      if (hasPlan && facts.todos.done <= prev.doneAt) {
        return deny(`上次自动续跑之后计划没有往前走(仍是 ${facts.todos.done}/${facts.todos.total}),不再自动续,只提议`, { capped: 'no_progress' });
      }
      if (prev.count >= cap) {
        return deny(`已经连续自动续跑 ${prev.count} 次,仍没做完,不再自动续,只提议`, { capped: 'max' });
      }
    }
    return { allowed: true, facts, brief, mode, count: (prev ? prev.count : 0) + 1 };
  }

  // 一批收件箱事件 -> 自理结果行。每个目标最多处置一次(同一线程同一批里连报三条失败不该重试三遍)。
  // 返回的行与模型 actions 的执行结果【同形】({tool,args,result}),额外带 auto:true 与 label ——
  // 于是「propose_required 自动降级成一条按钮」这条既有路径原样复用,不必另写一套降级。
  async function stewardSelfServeInbox(events, session, config) {
    const executed = [];
    const notes = [];
    const seen = new Set();
    // 「没做完就续」排在重试/诊断之后:同一线程同一批里既有失败又有收工时,失败那条先占这个目标;
    // 且 seen 只在闸门【不 silent】之后才记 —— 被 silent 掉的候选不该挡住同目标的下一条事件。
    const planned = (Array.isArray(events) ? events : [])
      .map(evt => ({ evt, plan: stewardSelfServePlan(evt) }))
      .filter(x => x.plan);
    planned.sort((a, b) => (a.plan.intent === 'continue' ? 1 : 0) - (b.plan.intent === 'continue' ? 1 : 0));
    for (const { evt, plan } of planned) {
      if (executed.length >= STEWARD_SELF_SERVE_PER_TURN_MAX) break;
      const key = stewardSelfServeKey(plan.sessionId, plan.runId);
      if (seen.has(key)) continue;
      const inboxSeq = Number(evt && evt.inboxSeq) || 0;
      // 117l D5:自理 notes 也进模型的回合层,同样要带名字(三处口径一致:事件行、notes、总览行)。
      const planTitle = await stewardDisplayTitleOf(plan.sessionId);
      const planWho = planTitle ? `线程「${planTitle}」(${plan.sessionId})` : `线程 ${plan.sessionId}`;
      const isContinue = plan.intent === 'continue';
      const gate = isContinue ? await stewardContinueUnfinishedGate(plan, config) : await stewardSelfServeGate(plan, config);
      if (gate.silent) continue;   // 「没做完就续」的候选其实不需要处置(做完了/在问你/用户在场…):不进行、不留话
      seen.add(key);
      const row = { tool: plan.tool, args: plan.args, auto: true, label: plan.label, intent: plan.intent, sessionId: plan.sessionId, inboxSeq };
      if (!gate.allowed) {
        row.result = stewardFail('propose_required', gate.reason, { reason: 'self_serve_gate', sessionId: plan.sessionId });
        executed.push(row);
        notes.push(isContinue
          ? `- [${inboxSeq}] ${planWho}:回合收了但任务没做完(${gate.brief}),管家没有自动继续(${gate.reason}),已作为提议留给用户;不要把它说成已收工。`
          : `- [${inboxSeq}] ${planWho}:管家没有自动${plan.label}(${gate.reason}),已作为提议留给用户。`);
        // 达到上限而停:额外落一行行动流水(用户在设置·管家·行动流水里看得见「为什么没再续」)。
        if (gate.capped) {
          stewardAppendDecision({
            tool: 'steward_continue_stopped',
            args: { reason: gate.capped, todosDone: gate.facts.todos.done, todosTotal: gate.facts.todos.total },
            targetSessionId: plan.sessionId,
            permissionMode: stewardThreadPermissionMode(gate.facts.head, config),
            mayAct: 'propose',
            undoRef: null,
            basis: { inboxSeq, auto: true, origin: 'steward-continue', reason: gate.reason.slice(0, 80) },
          });
        }
        continue;
      }
      const hookKey = STEWARD_ACTION_HOOKS[plan.tool];
      row.acted = true;   // 116-3 P2-11:闸门放行、真的发出去了 —— 这条目标要计进「每回合 ≤3 个目标」
      // 计账在【发起前】:动作发出去了就算用过一次配额,哪怕它失败 —— 否则失败会变成免费重试。
      stewardRunnerRuntime.turns.push(Date.now());
      if (isContinue) {
        stewardRunnerRuntime.continueUnfinished.set(plan.sessionId, { count: gate.count, doneAt: gate.facts.todos.done, turnSeq: gate.facts.turnSeq, at: Date.now() });
      } else {
        const entry = stewardSelfServeEntry(key);
        entry.attempts += 1;
        entry.lastActionAt = Date.now();
        if (plan.intent === 'retry') entry.lastRetryAt = Date.now();
      }
      try {
        row.result = await StewardHooks[hookKey]({
          ...plan.args,
          // 决策日志的 basis:哪条收件箱事件触发的、是不是自理、什么来源。13g 的两个实现把它并进
          // basis 落盘(args 本身照旧只记摘要字段,不落这一坨)。
          // 「没做完就续」另带 reason:行动流水里点开就能看到续的理由(计划进度 / 回合没收口)和是第几次。
          stewardBasis: { inboxSeq, auto: true, origin: plan.origin || ('steward-' + plan.intent), ...(isContinue ? { reason: `${gate.brief};第 ${gate.count} 次自动续跑` } : {}) },
          // 116-3 P0-2:确定性自理【只】发生在收件箱回合(runStewardTurn 里 trigger==='inbox' 才调本函数),
          // 故 ctx.trigger 恒为 'inbox';同时置 selfServe:true —— 这一条已经过了上面 stewardSelfServeGate
          // 的七道闸(含按事件类别的 stewardMayAct(mode,'failed','exec')),13g 不该再按 'relay' 档判第二遍。
        }, { session, sessionId: session.id, config, trigger: 'inbox', selfServe: true });
      } catch (error) {
        row.result = stewardFail('steward.failed', String((error && error.message) || error));
      }
      const okDone = !!(row.result && row.result.ok);
      executed.push(row);
      if (isContinue) {
        notes.push(okDone
          ? `- [${inboxSeq}] ${planWho}:回合收了但任务没做完(${gate.brief}),管家已经自动让它继续了一轮(第 ${gate.count} 次);把这件事讲给用户听即可,不要再重复动手,也不要把它说成已收工。`
          : `- [${inboxSeq}] ${planWho}:回合收了但任务没做完(${gate.brief}),管家试了自动继续但没成(${stewardSanitizeText(row.result && (row.result.message || row.result.error))}),已作为提议留给用户。`);
      } else {
        notes.push(okDone
          ? `- [${inboxSeq}] ${planWho}:管家已经自动${plan.label}了(${plan.tool}),把这件事讲给用户听即可,不要再重复动手。`
          : `- [${inboxSeq}] ${planWho}:管家试了自动${plan.label}但没成(${stewardSanitizeText(row.result && (row.result.message || row.result.error))}),已作为提议留给用户。`);
      }
      logEvent({ kind: 'steward_self_serve', intent: plan.intent, tool: plan.tool, sessionId: plan.sessionId, runId: plan.runId, ok: okDone, inboxSeq });
    }
    return { executed, notes };
  }

  return {
    stewardSelfServeInbox,
  };
}

module.exports = { createStewardAutonomousActions };
