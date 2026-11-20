'use strict';
const { clearNativeResume, unavailableAgentRoute } = require('./session-engine-route.cjs');

const { permissionModeFrom, resolvePermissionMode } = require('./agent-role-policy.cjs');
const { activeOpenAiProvider } = require('./provider-config.cjs');

function createSessionTurnRuntime({
  readConfig, safeSessionId, makeId, nowIso, logEvent,
  sessions: { createSession, loadSession, rememberLastUsedEngineRoute, sessionMessagesDelta, sessionMessagesStamp, sessionMissionId, sessionTodosSignature, updateSessionMeta },
  routing: { configForSessionEngineRoute, inferSessionEngineRoute, normalizeSessionEngineRoute, sessionEngineRouteFromConfig, sessionEngineRouteScopeOverrides },
  execution: { activeChildren, turnSettlers, turnOutcomePending, driverAutoSessions, assertSessionExecutionOwner, recordSessionExecutionOwner, requestSessionExecutionStop, sessionExecutionSnapshot, stopSession, SessionExecutionHooks, DesktopExecutionHooks },
  engines: { runOpenAiTurn, runClaudeTurn, runProviderCompact, maybeWriteThreadBrief, settleThreadBrief },
  mission: { runMissionDriver, bindDriverRun, endDriverRun, revokeGrantsForRun },
  steward: { STEWARD_SESSION_ID, StewardHooks, stewardTaintToolCall, stewardWatchedThread },
  EventStreamHooks, PrivacyCore, PrivacyGateway,
}) {
  // 正在手动压缩的会话:后台代理唤醒在这期间不起回合(见 runAgentWake),压缩收尾时补排一次。
  // POST /api/provider/compact 走这层登记;压缩本体(及其落盘纪律)仍是 runProviderCompact。
  const providerCompactInFlight = new Set();

  async function runProviderCompactTracked(sessionId, opts = {}) {
    const sid = safeSessionId(String(sessionId || ''));
    if (!sid) return runProviderCompact(sessionId, opts);
    providerCompactInFlight.add(sid);
    try { return await runProviderCompact(sid, opts); }
    finally {
      providerCompactInFlight.delete(sid);
      scheduleAgentWake(sid, 'after_compact');
    }
  }

  function lastAssistantTextOf(session) {
    const list = (session && Array.isArray(session.messages)) ? session.messages : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m && m.role === 'assistant' && String(m.content || '').trim()) return String(m.content);
    }
    return '';
  }

  async function runSessionTurn(input) {
    // 沿用 body 这个名字:搬家前它是 HTTP 请求体,搬家后是「回合入参」,字段名与含义一一对应。保留名字
    // 让搬过来的每一行逐字节不变(agent-team-mode.e2e.js:187 的源码静态锁正锁着 `body.agentTeam` 字面量)。
    const body = input || {};
    const onEvent = typeof body.onEvent === 'function' ? body.onEvent : () => {};
    const onFlush = typeof body.onFlush === 'function' ? body.onFlush : () => {};
    const source = String(body.source || 'http') || 'http';
    const storedConfig = await readConfig();
    // 第78波：交办确认卡可为【这一单当前执行链】收紧/调整安全档，但绝不回写全局配置。
    // 值域复用唯一 PERMISSION_MODES；非法/缺失值静默回落持久配置。该局部副本同时传给首回合、
    // until-done 续跑、Provider 与 Claude，避免 UI 显示一档而后端实际按另一档执行。
    // A missing/corrupt session id must not crash the turn: fall back to a fresh session (loadSession
    // already isolated the corrupt file as .corrupt).
    const loadedSession = body.sessionId ? await loadSession(body.sessionId) : null;
    if (source === 'steward' && body.sessionId && !loadedSession) throw Object.assign(new Error('目标线程已不存在,没有另开任务'), { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    if (loadedSession && typeof body.expectedCwd === 'string' && String(loadedSession.cwd || '') !== body.expectedCwd) throw Object.assign(new Error('目标线程的工作区已变化,请重新选择目标'), { code: 'SESSION_WORKSPACE_CHANGED', statusCode: 409 });
    if (loadedSession && Number.isSafeInteger(body.expectedTurnSeq) && Number(loadedSession.turnSeq) !== body.expectedTurnSeq) throw Object.assign(new Error('目标任务已进入其它回合,请刷新交付卡后重试'), { code: 'DELIVERY_CHANGED', statusCode: 409 });
    if (loadedSession && body.expectedDelivery) {
      const sourceCheck = await StewardHooks.validateDeliveryReference(loadedSession.id, body.expectedDelivery, storedConfig);
      if (!sourceCheck.ok) throw Object.assign(new Error(sourceCheck.message || '修订来源已变化'), { code: 'DELIVERY_CHANGED', statusCode: 409 });
    }
    // 系统自己起的唤醒回合绝不顺手新建会话:HTTP 的「合法 id 但装载不到 → 新建」是给用户的兜底(损坏会话被隔离后继续聊),
    // 对唤醒不成立 —— 线程在 runAgentWake 校验之后被删(或装载瞬时失败)时,新建只会冒出一条只有唤醒通知的孤儿会话。
    if (!loadedSession && source === AGENT_WAKE_SOURCE) throw Object.assign(new Error('session not found'), { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    const session = loadedSession || await createSession({ title: body.title, cwd: body.cwd });
    if (typeof PrivacyGateway !== 'undefined' && PrivacyGateway.enabled(storedConfig) && !PrivacyGateway.active()) return PrivacyGateway.run(session.id, storedConfig, () => runSessionTurn({ ...body, sessionId: session.id }));
    // 回合开头的计划条指纹:收尾时随成败账一起落(stewardLastTurn.todosStartSig),管家据此分辨「这一回合推进过的计划」
    // 与「早就搁下的旧计划」(见 02 sessionTodosSignature)。
    const todosStartSig = sessionTodosSignature(session.todos);
    // 116-3 A2(会话/权限口径子审查):管家会话【只能】由管家运行器发起回合。任何别的调用面
    // (直连 POST /api/chat/stream 打 sessionId=steward 是最直接的一条)都会拿到 core/shell/steward
    // 三个工具包整份offer,并且完全绕开 13h 的编排、熔断、预算、抢占与决策日志 —— 那等于用普通会话
    // 的身份跑一个管家回合。判据读【原始】 session.kind(sessionKind() 会把它归一成 quick_ask),
    // 与 09/10 既有的两处管家分叉同口径;放行条件是 source === 'steward'(13h 的 runStewardTurn 与
    // 13g 的 stewardLaunchTurn 都用这个来源)。抛而不是返回信封:HTTP 壳的响应头此刻还没发出去,
    // 抛回路由层才能给一条 4xx 稳定信封(返回值会让流壳既不写头也不 end,请求直接挂死)。
    if (session && session.kind === 'steward' && source !== 'steward') {
      throw Object.assign(new Error('the steward session only accepts turns started by the steward runner'), {
        code: 'STEWARD_SESSION_FORBIDDEN', statusCode: 403,
      });
    }
    // 117s-G(27 号文 §11.13.1 ②):【别处】起的回合不许被一句新话顶掉。
    // 09:1347 与 05:139 那两行 `if (activeChildren.has) stopSession('superseded')` 是 2.0 主输入框的
    // 既有语义 ——「同一个人在同一扇窗里又发了一句,用后面这句」。它对别处起的回合不成立:管家经
    // stewardLaunchTurn 派出去的回合(source 'steward')没有任何客户端挂在它的流上,用户在「2.0 视窗」里
    // 打一句话就把它连同几分钟的工作一起杀了,只留下一条 turn_kill reason:'superseded' 和一条孤零零的
    // user 消息。这里按【发起面】分开:同一个 source 再发 = 那条既有语义,原样放行;不同 source = 忙,
    // 回 409 稳定信封,一个字节都不动那个正在跑的回合。
    // 判据用【既有】的 turnSettlers 条目:runSessionTurn 在每个回合开头就把 {source, requestMeta} 记在
    // 那里(第69波 rewind 靠的就是它),活回合期间一直在,所以不必给活回合登记表新加字段。
    // 位置:必须在 onStart 之【前】—— 响应头此刻还没发出去,抛出去路由层才能回一条正经的 409
    // (与上面那条 STEWARD_SESSION_FORBIDDEN 逐字同一条纪律)。也必须在这里而不是 09/05 各钉一遍:
    // 那两行在 runSessionTurn 的下游,而且那时用户消息已经落盘、响应头已经发出,回不了 4xx;
    // runSessionTurn 是两个引擎唯一的汇合点,守一处等于守两处。
    // hunt2-steward ②:「忙」读 turnSettlers 本身,不再先要求 activeChildren 里有它。activeChildren 要等引擎
    // 里好几个 await 之后(09 登记子进程/中止器那一步)才写上,而 turnSettlers 在本函数同步段就登记了 ——
    // 修前一个刚开跑的回合在这段窗口里对别处来的一句话【不算忙】,管家递话于是起一个新回合,在 09 里把
    // 刚开跑的用户回合 superseded 掉(用户那句话丢了)。turnSettlers 条目覆盖整个 runSessionTurn(含
    // until-done 驱动器两回合之间的空档),正是「这条线程此刻有一个回合归别人」的完整区间。
    // 检查与下面 turnSettlers.set 之间没有 await,两个并发调用不会都判成空闲。
    // 同源也算忙的发起面(EXCLUSIVE_TURN_SOURCES,定义在本文件 AGENT_WAKE_SOURCE 旁):'http' 同一扇窗里再发一句 = 顶替(上面
    // 那条既有语义),'steward' 同理保持原样;而定时调度器('scheduler')与后台代理唤醒('agent_wake')是【系统自己】起的回合,
    // 不是某个人在同一扇窗口里改口。两条定时任务同刻指向同一条既有线程时,修前后一个把前一个当「同源」顶掉
    // (09/05 的 supersede):前一个的消息丢了,它的记账却还是 succeeded。现在后来者拿 409,13s 按 target_busy 记 skipped
    // (不计连败),唤醒侧(runAgentWake)则把账退回去等那一回合收尾时补唤醒。
    const busySettler = turnSettlers.get(session.id) || null;
    const busySource = busySettler ? String(busySettler.source || '') : '';
    if (busySettler && busySource && (busySource !== source || EXCLUSIVE_TURN_SOURCES.has(source) || body.expectedDelivery)) {
      throw Object.assign(new Error('这条线程正在跑一个由「' + busySource + '」发起的回合;要接着说就插话(POST /api/steer),新回合不会顶掉它'), {
        code: 'SESSION_TURN_BUSY_ELSEWHERE', statusCode: 409, turnSource: busySource,
      });
    }
    // 116-2a(§3.3):档位解析挪到会话装载【之后】,因为多了中间一层「会话级」。优先级固定
    // 请求级 > 会话级 > 全局,解析器是 01-config 的纯函数 resolvePermissionMode(三层各自只认
    // PERMISSION_MODES 白名单,非法/缺失静默回落下一层)。没有设过会话级档的会话(含全部存量会话)
    // 解析结果 === storedConfig.permissionMode,下面那行的恒等判定让 permissionConfig 仍是 storedConfig
    // 【同一个对象】—— 行为与搬家前逐字节一致。
    const resolvedPermissionMode = resolvePermissionMode({ request: body.permissionMode, session, config: storedConfig });
    // 117m-A6（审查报回 P0-1）：这一单到底带没带【请求级】档位。117m-A1 让闸门读会话级的【此刻】值，
    // 于是一个与本回合无关的会话级 PATCH 能静默顶掉本回合专门要的收紧（请求级 plan 被中途改成
    // auto 后变成 allow）—— 而优先级契约写得很清楚：请求级 > 会话级 > 全局。带了请求级档的回合
    // 就是【这一单自己的意思表示】，中途任何会话级改动都不得接管它。
    // 只在真带了请求级档时才停用「同一个对象」那个恒等优化（否则行为与修前逐字节一致）。
    const requestPermissionMode = permissionModeFrom(body.permissionMode);
    const permissionConfig = (resolvedPermissionMode === storedConfig.permissionMode && !requestPermissionMode)
      ? storedConfig
      : { ...storedConfig, permissionMode: resolvedPermissionMode, ...(requestPermissionMode ? { permissionModeFromRequest: true } : {}) };
    const routeOverride = body.engineRoute ? normalizeSessionEngineRoute(body.engineRoute) : null;
    const previousRoute = inferSessionEngineRoute(session) || sessionEngineRouteFromConfig(permissionConfig);
    const switchingRetiredEngine = unavailableAgentRoute(previousRoute);
    if (unavailableAgentRoute(routeOverride || previousRoute) || (switchingRetiredEngine && source !== 'http')) {
      throw Object.assign(new Error('原会话引擎已不可用，请先选择新的引擎。'), { code: 'SESSION_ENGINE_UNAVAILABLE', statusCode: 409 });
    }
    if (switchingRetiredEngine && routeOverride) {
      clearNativeResume(session);
      session.engineRoute = routeOverride;
    }
    const routeSource = routeOverride ? { ...session, engineRoute: routeOverride } : session;
    const config = configForSessionEngineRoute(permissionConfig, routeSource);
    // 123-N2 写入点②(实现在 02 的 rememberLastUsedEngineRoute,那里有完整头注):用户【自己】发起
    // 的这一回合实际跑在哪个引擎上,就是他「上一次用的」。记的是【解析后的实际路由】而不是请求体里
    // 的那一份 —— routeOverride 可能为空、会话头上可能钉着别的,只有 inferSessionEngineRoute 这一次
    // 解析的结果才是这一回合真正跑的那条(与下面 pinnedRoute 同一个判据、同一份 routeSource)。
    // **判据是 source === 'http'**:管家(13k stewardLaunchTurn 的 'steward')与将来的调度器
    // ('scheduler')派出去的回合不是用户的意思表示,记进去会让「上次用的」被后台活动悄悄改写 ——
    // 用户开新线程时拿到一个自己从没选过的引擎,那比写死更糟。缺省值就是 'http'(见上面 source 那行)。
    // 位置在两道 4xx 闸门(STEWARD_SESSION_FORBIDDEN / SESSION_TURN_BUSY_ELSEWHERE)之后:被挡回去的
    // 那一发没有跑成任何回合,不该留下「上次用的」。旁路记账,不 await、失败静默。
    const engineRouteScope = sessionEngineRouteScopeOverrides.has(session.id) ? sessionEngineRouteScopeOverrides.get(session.id) : session.engineRouteScope;
    if (source === 'http' && engineRouteScope !== 'thread') {
      void rememberLastUsedEngineRoute(inferSessionEngineRoute(routeSource) || sessionEngineRouteFromConfig(config), storedConfig);
    }
    // 127 波 2-quater B2(45 号文 §2-quater.2 闸 6(b)「会话级粘性污染位」)清除点:用户【亲发】的下一条消息。
    // 污染位堵的是「上一回合读网页埋话、这一回合执行」——读进来的内容会一直留在这条线程的历史里,所以不能只看
    // 本回合;而用户自己开口说下一句,是唯一能说明「接下来要做什么由人重新定过」的事件。判据同上面那一块:
    // source === 'http'(管家派的 'steward'、调度器的 'scheduler' 都不是用户的意思表示,不清)。
    // 位置:两道 4xx 闸门之后(被挡回去的那一发没有跑成任何回合),引擎分派之前 —— 清的是内存里这一份会话,
    // 随回合起手那一次 saveSession 落盘(09 runOpenAiTurn 推入用户消息之后、第一次调模型之前),所以这一回合里任何一条权限待决
    // 出现时,盘上与活回合里读到的都已经是清过的。插话(/api/steer)不清:它进的是正在跑的那一回合。
    if (source === 'http' && session.stewardTaint) delete session.stewardTaint;
    // 后台代理唤醒的连续计数(见 scheduleAgentWake):不是唤醒自己起的回合(用户亲发、管家派、定时任务)都清零 —— 上限防的是
    // 「起后台代理 → 被唤醒 → 再起」这一个闭环,修前只认 'http',纯管家 / 定时驱动的线程唤醒满 6 次后进程内再也不唤醒。
    // 同一个起手点也清「用户叫停过」表:用户重新说话了(或系统起了别的回合),此后后台代理收尾才可以再唤醒这条线程。
    if (source !== AGENT_WAKE_SOURCE) { agentWakeChain.delete(session.id); agentWakeSuppressed.delete(session.id); }
    const attachments = body.attachments || [];

    let finished = false;
    // Kill only when the streaming RESPONSE is actually disconnected. IncomingMessage's `close`
    // also fires after a normally-consumed request body on modern Node, so using req.close here can
    // terminate a healthy background turn when the UI opens another session.
    let disconnectHandled = false;
    // 本次调用登记的 turnSettlers 条目(下面 settleEntry 建好后回填)。stopSession 按【会话】停的是活回合登记表里
    // 此刻那一个 —— 本回合已被同会话更新的回合顶替(同来源再发一句)之后,旧流断线(被顶替的回合还在收尾)
    // 会把【新】回合杀掉。条目已经换成别人的 = 这条会话此刻的回合不归本次调用,断线不停它。
    let ownSettleEntry = null;
    const handleDisconnect = () => {
      if (finished || disconnectHandled) return;
      disconnectHandled = true;
      readConfig().then(cfg => {
        if (!cfg.killOnDisconnect) return;
        if (ownSettleEntry && turnSettlers.get(session.id) !== ownSettleEntry) {
          logEvent({ kind: 'disconnect_stop_skipped', sessionId: session.id, reason: 'superseded' });
          return;
        }
        if (ownSettleEntry) requestSessionExecutionStop(session.id, sessionExecutionSnapshot(session.id), 'disconnected');
        else stopSession(session.id, 'disconnected');
      }).catch(() => {});
    };
    if (typeof body.onStart === 'function') body.onStart({ session, config });
    const signal = body.signal || null;
    if (signal) {
      if (signal.aborted) handleDisconnect();
      else { try { signal.addEventListener('abort', handleDisconnect, { once: true }); } catch { /* 无 EventTarget 的 signal:忽略 */ } }
    }

    // 第26波b: 捕获每回合的 token 用量(账本预算计量)+ 停止信号。usage 事件透传不变,仅旁路记录。
    let lastTurnTokens = 0;
    let turnStopped = false;   // 对抗轮 P2: 回合被停止(/api/stop → stopSession → abort → 'process' state:'stopped')
    // 116c-0: 进程内调用方拿不到 SSE 流,只能靠返回值。下面三个都是只读取样(累加 usage 帧、记住最后一个
    // result 事件),不参与任何判定,也不改变事件流。
    const usageTotals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, frames: 0 };
    let lastResult = null;
    // 127 波 2-quater B2 返工:本回合里「调了读外部内容的工具、结果还没回来」的那几条(键 = subagentId + 工具调用 id,
    // 值 = 算污染的那个工具名)。只活在这一次 runSessionTurn 里;结果回来就删,见 emit 里粘性污染位的写入点。
    const stewardTaintInFlight = new Map();
    const emit = evt => {
      if (evt && evt.type === 'usage' && evt.usage) {
        const u = evt.usage;
        // 对抗轮 P3: 计入缓存 token —— Claude 引擎 cache_read/cache_creation 常占大头,漏计则 maxTokens 预算欠执行。
        lastTurnTokens = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
        usageTotals.input_tokens += Number(u.input_tokens) || 0;
        usageTotals.output_tokens += Number(u.output_tokens) || 0;
        usageTotals.cache_read_input_tokens += Number(u.cache_read_input_tokens) || 0;
        usageTotals.cache_creation_input_tokens += Number(u.cache_creation_input_tokens) || 0;
        usageTotals.frames += 1;
      }
      if (evt && evt.type === 'process' && evt.state === 'stopped') turnStopped = true;
      if (evt && evt.type === 'result') lastResult = evt;
      // 127 波 2-quater B2(45 号文 §2-quater.2 闸 6(b))写入点:这条线程读过外部内容 → 会话头落一个粘性污染位
      // stewardTaint:{by, at, turnSeq}(空不落字段:没读过外部内容的会话一个字节不多)。挂在这里而不是 09 的
      // 工具循环里:runSessionTurn 是三个引擎的唯一汇合点,Claude CLI 的 WebFetch、桥接的 mcp__x__y、子代理与
      // 班组的起始事件都从这一个 emit 过 —— 一条线程换过引擎,上一回合读的网页照样记得住。
      // 判据是 06i stewardTaintToolCall(与管家那一侧读回合段表的 stewardTaintToolName 同一张名单,多认一层
      // tool_invoke_* 代理的 input.name —— 段表上没有 input,代理调用只能在这里判准)。
      // Record the call identity before permission checks. Mark the session only when its result arrives.
      // Child calls use a separate namespace because their tool IDs can match a parent call.
      let taintedBy = '';
      if (evt && evt.type === 'tool_use' && evt.id) {
        const inFlightKey = String(evt.subagentId || '') + '\u0000' + String(evt.id);
        const inFlightName = stewardTaintToolCall(evt.name, evt.input);
        // 改名改参之后不算了,也不撤掉先前那一次的记号(保守:它先前被判成会读外部内容)。
        if (inFlightName) stewardTaintInFlight.set(inFlightKey, inFlightName);
      } else if (evt && evt.type === 'tool_result' && evt.id) {
        const inFlightKey = String(evt.subagentId || '') + '\u0000' + String(evt.id);
        taintedBy = stewardTaintInFlight.get(inFlightKey) || '';
        stewardTaintInFlight.delete(inFlightKey);
      }
      if (evt && session && !session.stewardTaint
          && (taintedBy
            || (evt.type === 'subagent' && evt.state === 'start')
            || evt.type === 'agent_workflow')) {
        session.stewardTaint = {
          by: taintedBy ? taintedBy.slice(0, 80) : (evt.type === 'subagent' ? 'subagent' : 'workflow'),
          at: nowIso(),
          turnSeq: Math.max(0, Number(session.turnSeq) || 0),
        };
      }
      onEvent(evt);
    };
    // 第27波:本次回合 = 一个「run」。登记活动 runId,scope:'run' 授权绑定它(含首回合内经 UI 签发的 bindNextRun 补绑)。
    if (typeof SessionExecutionHooks.admissionBlocked === 'function' && SessionExecutionHooks.admissionBlocked(session.id)) {
      throw Object.assign(new Error('Session rewind is in progress'), { code: 'SESSION_EXECUTION_LOCKED', status: 409 });
    }
    const previousOwner = turnSettlers.get(session.id);
    if (previousOwner && typeof previousOwner.cancel === 'function') previousOwner.cancel('superseded');
    const driverRunId = makeId('drun');
    bindDriverRun(session.id, driverRunId);
    const executionAbort = new AbortController();
    // 第69波:登记 settle 信号 —— rewind 截断前等它( dying turn 的收尾 saveSession 落盘先于 driver finally,
    // 由此保证 rewind 的截断写在最后,不被收尾 save 整份盖回)。
    let settleResolve = null;
    const settleEntry = {
      promise: new Promise(r => { settleResolve = r; }), startedAt: Date.now(), source, requestMeta: body.requestMeta || null,
      driverRunId, phase: 'starting', cancelRequested: false,
      cancel(reason = 'stopped') {
        if (executionAbort.signal.aborted) return;
        this.cancelRequested = true; this.phase = 'stopping'; turnStopped = true;
        executionAbort.abort();
        const child = activeChildren.get(session.id);
        if (child && child.executionOwner === this) stopSession(session.id, reason);
      },
    };
    recordSessionExecutionOwner(session.id, settleEntry);
    ownSettleEntry = settleEntry;
    let turnError = '';
    let privacySettingsResult = null;
    // 116h(27 号文 §3.1 116h 行):线程间仲裁的凭据。开关关 / 管家会话时下面那个分支根本不进,
    // 这个变量恒为 null,收尾的 release 是一次 if 判空 —— runSessionTurn 的既有路径逐字节不变。
    let stewardSlot = null;
    // 116-5a:finally 里要用,但 provider 与「这是不是首回合」都是在 try 内部才算出来的。
    let briefSettleCandidate = false;
    let briefSettleProvider = null;
    try {
      await DesktopExecutionHooks.guard(session.id);
      assertSessionExecutionOwner(session.id, settleEntry);
      // Keep the admission check→owner registration synchronous. Legacy-history I/O happens only
      // after this turn owns the session, under the existing cancellation and finally cleanup.
      if (typeof PrivacyGateway !== 'undefined') {
        if (PrivacyGateway.enabled(storedConfig)) session.privacyHistoryV1 = true;
        else if (session.privacyHistoryV1 !== false) {
          const history = { messages: session.messages, providerHistory: session.providerHistory };
          let restoredHistory, projectionOnly = false;
          try { restoredHistory = await PrivacyGateway.restoreHistory(session.id, history); }
          catch (error) {
            if (!['privacy.reference_unknown', 'privacy.reference_expired', 'privacy.reference_revoked', 'privacy.reference_malformed'].includes(error.code)) throw error;
            restoredHistory = await PrivacyGateway.restoreHistory(session.id, history, true);
            PrivacyGateway.bindRestoredHostHistory(session, history.providerHistory || [], restoredHistory.providerHistory || []);
            projectionOnly = true;
          }
          if (executionAbort.signal.aborted || turnSettlers.get(session.id) !== settleEntry) throw Object.assign(new Error('回合在历史恢复时被取消'), { code: 'STEWARD_TURN_CANCELLED' });
          if (restoredHistory !== history && !projectionOnly) {
            session.messages = restoredHistory.messages;
            session.providerHistory = restoredHistory.providerHistory;
          }
          session.privacyHistoryV1 = projectionOnly;
          // The admitted engine's existing session commit persists this copy with the new turn.
        }
      }
      // perf(前端长会话):经典壳(只有 source 'http' 这条流有它在读)把这一份会话当作回合收尾时增量取的底子 ——
      // messagesStamp 是 02 sessionMessagesStamp 对【这一刻】messages 的前缀戳,与下面这次同步序列化是同一拍
      // (emit → onEvent → streamChat 的 writeEvent 当场 JSON.stringify,中间没有 await),所以戳与客户端收到的内容一致。
      // 别的来源(管家/调度)的流没人拿它做增量,不付这笔 O(历史) 的哈希。
      // perf(round 4 S3):页面手上已有前 N 条(发送时带 knownMessages:{count,stamp},即它上次从服务端拿到的那份的戳)
      // 就只下发尾巴 —— 与 13d 增量 GET 同一套判据与信封:session 上没有 providerHistory、messages 只是 messages[N..],
      // 事件上多 messagesFrom / messageCount / messagesStamp。戳对不上(撤回、压缩、另一个标签页改过……)照旧整份。
      const knownMessages = source === 'http' && body.knownMessages && typeof body.knownMessages === 'object' ? body.knownMessages : null;
      const knownDelta = knownMessages ? sessionMessagesDelta(session.messages, knownMessages.count, knownMessages.stamp) : null;
      if (knownDelta) {
        const { providerHistory: _providerHistory, ...sessionHead } = session;
        emit({ type: 'session', execution: sessionExecutionSnapshot(session.id), session: { ...sessionHead, messages: knownDelta.tail }, messagesFrom: knownDelta.from, messageCount: knownDelta.count, messagesStamp: knownDelta.stamp });
      } else {
        emit(source === 'http' ? { type: 'session', session, execution: sessionExecutionSnapshot(session.id), messagesStamp: sessionMessagesStamp(session.messages) } : { type: 'session', session, execution: sessionExecutionSnapshot(session.id) });
      }
      // 116h:回合级并发位与同工作文件夹写互斥。位置在 session 事件【之后】(调用方先拿到 sessionId,
      // 排队期间的 agent_resource 事件才有归属)、引擎分派【之前】(等的是「能不能开始跑」)。
      // 判据读【原始】 session.kind:管家会话自己不是线程,不受并发上限约束(与 09/10 既有分叉同口径)。
      if (config.stewardEnabledV1 === true && session.kind !== 'steward' && typeof StewardHooks.acquireTurnSlot === 'function') {
        stewardSlot = await StewardHooks.acquireTurnSlot({
          sessionId: session.id, title: session.title, cwd: body.cwd || session.cwd, config, signal: executionAbort.signal, executionOwner: settleEntry, onEvent: emit,
        });
        // 排队中被 /api/stop 或断线取消:这不是错误,是「没跑成」。抛一个带 code 的哨兵,由下面的 catch
        // 翻成一条 process/stopped(而不是 error 事件)—— 返回值里 stopped:true、ok:true,与被停的回合同形。
        if (stewardSlot && stewardSlot.granted === false) {
          throw Object.assign(new Error('回合在排队时被取消'), { code: 'STEWARD_TURN_CANCELLED' });
        }
      }
      assertSessionExecutionOwner(session.id, settleEntry);
      const provider = activeOpenAiProvider(config);
      const pinnedRoute = inferSessionEngineRoute(routeSource);
      if (pinnedRoute?.engine === 'openai' && !provider) {
        throw new Error(`会话绑定的 Provider 不可用：${pinnedRoute.providerId}`);
      }
      // 单回合执行器(首回合=用户消息带附件;账本续跑回合=driverAuto、无附件)。两引擎同签名。
      const runTurn = async (msg, driverAuto) => {
        assertSessionExecutionOwner(session.id, settleEntry);
        await DesktopExecutionHooks.guard(session.id);
        assertSessionExecutionOwner(session.id, settleEntry);
        lastTurnTokens = 0;
        const atts = driverAuto ? [] : attachments;
        // 第27f波:标记本会话处于无人值守回合(供 CLI 桥的权限超时→存档暂停判定;provider 路径用闭包 driverAuto)。serial 回合,进出平衡。
        if (driverAuto) driverAutoSessions.add(session.id);
        try {
          const turnAgentTeam = !driverAuto && body.agentTeam === true && Number(config.subagentMaxPerTurn) > 0;
          // 116f: messageMeta 透传给引擎(管家收件箱回合的 {origin:'inbox'}、管家递话 {origin:'steward'}、后台代理唤醒
          // {origin:'agent_wake'})。driverAuto 续跑回合不带它(那条消息是驱动器发的,不是任何外部来源)。管家【会话】解析到
          // CLI 引擎时在 13h 就返回 unsupported_engine;CLI 引擎的普通线程(管家递话、唤醒)照样把出身标落在用户消息上。
          const turnMessageMeta = driverAuto ? null : (body.messageMeta || null);
          await DesktopExecutionHooks.run(session, async () => {
          if (provider) await runOpenAiTurn({ session, message: String(msg || ''), attachments: atts, cwd: body.cwd, onEvent: emit, provider, config, driverAuto, agentTeam: turnAgentTeam, messageMeta: turnMessageMeta, executionOwner: settleEntry, delegationPlan: !driverAuto && body.source === 'steward' ? body.delegationPlan : null });
          else await runClaudeTurn({ session, message: String(msg || ''), attachments: atts, cwd: body.cwd, onEvent: emit, config, driverAuto, agentTeam: turnAgentTeam, messageMeta: turnMessageMeta, executionOwner: settleEntry });
          });
        } finally { if (driverAuto) driverAutoSessions.delete(session.id); }
      };
      // 116-5a(27 号文 §11.8「线程自动摘要」)第一次机会:首回合【发起时】就把名字要回来,不等回合。
      // 位置纪律:必须在这里而不是三个引擎里各钉一遍 —— 三引擎共用本函数,引擎分叉在上面那个 runTurn
      // 里(自动命名 isUntitledSessionTitle 就是在 05/05b/09 各写了一遍,那是要避开的前例)。
      // 时机:brief 描述的是【任务】不是答案,用户原话此刻就在手上,不必等消息落盘;摘要 1–2 秒回来,
      // 真回合可能要一分钟,两者并行跑。落盘走 updateSessionMeta,它会自己避开活回合的写竞态。
      // fire-and-forget + 内部整段 try:摘要的任何环节都不得影响这一回合。
      const briefFirstTurn = (Number(session.turnSeq) || 0) === 0 && !session.threadBrief;
      if (briefFirstTurn) {
        void maybeWriteThreadBrief({ sessionId: session.id, message: String(body.message || ''), stage: 'first_turn', config, threadProvider: provider });
      }
      briefSettleCandidate = briefFirstTurn;
      briefSettleProvider = provider;
      await runTurn(String(body.message || ''), false);
      // until-done 驱动器:仅当会话有活动账本才进(非账本会话零行为变化,与旧单回合完全等价)。
      // 对抗轮 P2: isAlive 同时看 turnStopped —— /api/stop(服务端 stopSession,不关 socket)也要能刹住驱动器,
      // 不能只靠客户端断连(否则脚本/代理调 /api/stop 后驱动器仍relaunch 到预算耗尽)。
      if (session.mission && session.mission.autoMode === 'until-done') {
        await runMissionDriver({ session, config, provider, emit, runTurn, executionOwner: settleEntry, getLastTokens: () => lastTurnTokens, isAlive: () => !disconnectHandled && !finished && !turnStopped && !settleEntry.cancelRequested, ownsSession: () => turnSettlers.get(session.id) === settleEntry });
      }
    } catch (err) {
      // 116h:排队中被取消 -> 与「被 /api/stop 停掉」同一条语义(process/stopped),不是错误信封。
      if (err && err.code === 'STEWARD_TURN_CANCELLED') emit({ type: 'process', state: 'stopped' });
      else {
        turnError = err.message || String(err);
        emit({ type: 'error', error: turnError });
      }
    } finally {
      onFlush();  // D1:回合收尾 flush 残留 delta,防最后一批丢(HTTP 壳的合批缓冲;进程内调用方通常是空实现)
      finished = true;
      // 116h:并发位无条件释放(settle / abort / 异常三条路都经这里),释放即唤醒队列。release 幂等。
      if (stewardSlot && typeof stewardSlot.release === 'function') { try { stewardSlot.release(); } catch { /* best-effort */ } }
      // 第27波:run 结束 → scope:'run' 授权蒸发(遍历删 runId 匹配项),登记表清理。scope:'session' 授权跨回合保留,直到
      // TTL/次数耗尽或显式撤销/切模式。
      try { revokeGrantsForRun(session.id, driverRunId); } catch { /* best-effort */ }
      endDriverRun(session.id, driverRunId);
      if (settleResolve) { try { settleResolve(); } catch { /* best-effort */ } }
      // 回合成败账(会话头 stewardLastTurn):【每条】线程的回合,不管是谁发起的都要落这一笔。修前只有管家/调度器
      // 发起的回合会写(13k stewardRecordLaunchOutcome / 13s),用户自己在界面上发起的回合没有 —— 收件箱第四源读不到
      // 成败账就按「账缺席 = done」报,于是 ok:false 的 network_down 回合被管家说成「已收工」、「失败自动重试」也
      // 永远等不到 failed 事件;五态两张表读的 lastTurnFailed 同样读不到。判据取回合自己发出的 result 事件(ok/aborted/
      // errorClass,三引擎同形),与 13k 同口径。管家/调度器发起的回合照旧由它们自己写;被新回合顶掉的不写(新回合会写)。
      // 第二轮工具走查(F5):这里原先还要求 stewardWatchedThread(只给「被盯」的线程落账),于是没标 stewardWatch 的
      // 普通线程失败了也没有账,steward_thread_status / threads_search / missions 一律读成「已收工 done」,而它最后
      // 一句其实是错误信息。账本只是事实记录,【不】等于「管家要为它动手」—— 后者仍由收件箱第四源自己的
      // stewardWatchedThread 判据把关(13i stewardCollectSessionTurn 末尾 `!watched` 直接 return null),所以对
      // 未被盯的线程多写这一笔账不会多出任何收件箱事件。
      const outcomeId = session.id;
      let outcomePatch = null;
      try {
        if (outcomeId !== STEWARD_SESSION_ID && source !== 'steward' && source !== 'scheduler'
            && !(lastResult && lastResult.superseded)) {
          if (lastResult) outcomePatch = { seq: Number(session.turnSeq) || 0, ok: lastResult.ok === true, aborted: lastResult.aborted === true, errorClass: String(lastResult.errorClass || ''), at: nowIso(), todosStartSig };
          else if (turnError) outcomePatch = { seq: Number(session.turnSeq) || 0, ok: false, aborted: false, errorClass: '', at: nowIso(), todosStartSig };
          // 没被盯的线程只记【没成】的回合:成功回合的账缺席本来就读成 done(stewardCoveringLastTurn 只认 seq 覆盖到当前回合的那笔,
          // 旧的失败账不会被误读),而每个成功回合都多一次收尾后的会话头写盘,会让前端刚拿到的 ETag 立刻过期
          // (Windows CI session-get-etag 实测 304 变 200)。被盯的线程照旧每回合都记(todosStartSig 要用)。
          if (outcomePatch && outcomePatch.ok === true && !stewardWatchedThread(session, outcomeId, sessionMissionId(session) || outcomeId)) outcomePatch = null;
        }
      } catch { outcomePatch = null; }
      if (outcomePatch) turnOutcomePending.add(outcomeId);
      DesktopExecutionHooks.release(session.id, settleEntry);
      const turnStillOwned = turnSettlers.get(session.id) === settleEntry;   // 收尾时线程还归本回合(没有更新的回合接手)
      if (turnStillOwned) turnSettlers.delete(session.id); // 只删自己的条目;supersede 的新回合条目不动
      if (session.kind === 'steward' && typeof PrivacyCore.configHooks.settleStewardPrivacy === 'function') {
        privacySettingsResult = await PrivacyCore.configHooks.settleStewardPrivacy(session.id, Number(session.turnSeq),
          turnStillOwned && !turnError && !turnStopped && !settleEntry.cancelRequested && lastResult?.ok === true && !lastResult.aborted && !lastResult.superseded);
      }
      // 后台代理唤醒(见 scheduleAgentWake):收尾时账本里还有没送达的后台代理信封(落在本回合最后一次模型调用之后)→ 补唤醒。
      // 用户停止 / 被新回合顶掉 / 断线时按设置杀掉回合(lastResult.aborted)的那次收尾不补:用户刚叫停,信封留到下一回合开头送达。
      // 只是关了页面 / 刷新(killOnDisconnect 缺省关,回合在服务端照常跑完)要补 —— 用户离开正是这个功能要管的情形。
      // 用户叫停的那次收尾不但不补,还要记下「叫停过」:后台代理与回合 abort 脱钩,几秒后跑完时信封落账那一路(onAgentEnvelopePersisted)
      // 同样不该把线程叫醒。被新回合顶掉(superseded)的不记 —— 新回合起手时刚清过表,这一记会反过来拦住新回合的收尾。
      if (session.kind !== 'steward') {
        const superseded = !!(lastResult && lastResult.superseded);
        const cancelled = turnStopped || !!(lastResult && lastResult.aborted);
        // 「Stop 后立刻重发」:新回合起手时(已清表)本回合还在收尾 —— 线程已经归新回合,这里再记一笔会拦住用户刚说完那句话的回合。
        if (cancelled && !superseded) { if (turnStillOwned) agentWakeSuppressed.add(session.id); }
        else if (!cancelled && !superseded && typeof EventStreamHooks.pendingAgentWakeJobs === 'function') {
          try { if (EventStreamHooks.pendingAgentWakeJobs(session).length) scheduleAgentWake(session.id, 'turn_end'); } catch { /* 旁路,不反噬收尾 */ }
        }
      }
      if (outcomePatch) {
        // 不 await:成败账是旁路,回合的收尾(brief 补写、返回值)不该排在一次会话头写盘后面;读侧在
        // turnOutcomePending 挂着期间按「账在路上」处理(04),落盘或失败后摘掉。
        Promise.resolve()
          .then(() => updateSessionMeta(outcomeId, { stewardLastTurn: outcomePatch }))
          .catch(() => { /* 旁路:少一笔账只是退回「账缺席」,不反噬回合 */ })
          .finally(() => { turnOutcomePending.delete(outcomeId); });
      }
      // 116-5a(§11.8.4)收工这一刻做两件事,都在 06 的 settleThreadBrief 里:
      //   ① **补写** —— 首回合那次算出来的 brief 可能刚被回合自己的收尾 saveSession 盖掉(它手里那份
      //      内存副本不含 brief,谁后写谁赢)。补写不调模型,幂等。116-5a 实测抓到的就是这条丢写。
      //   ② 补写没东西可写(首回合那次压根没成:端点不通、模型吐了非 JSON、限流)才走【第二次机会】:
      //      此刻有助手回复,概括更准。**只有这两次机会**,之后这条线程永远不再试。
      if (briefSettleCandidate) {
        void settleThreadBrief({
          sessionId: session.id,
          message: String(body.message || ''),
          replyText: lastAssistantTextOf(session),
          config,
          threadProvider: briefSettleProvider,
        });
      }
    }
    return {
      ok: !turnError,
      sessionId: session.id,
      turnSeq: Number(session.turnSeq) || 0,
      result: lastResult,
      usage: { ...usageTotals, lastTurnTokens },
      stopped: turnStopped,
      disconnected: disconnectHandled,
      source,
      error: turnError || undefined,
      ...(privacySettingsResult ? { privacySettings: privacySettingsResult } : {}),
    };
  }

  // ── 后台代理完成 → 唤醒主会话 ────────────────────────────────────────────────────────────────────
  // 用户 2026-10-05 报:模型用 orchestrate_agents{background:true} 起了子代理、自己的回合先结束了,子代理跑完之后主会话
  // 一动不动 —— 信封只在「下一迭代边界 / 下一回合开头」注入,而下一回合要等用户再说一句。现在:信封落账(11
  // persistBackgroundJob)时线程空闲,就由工作台自己起一个回合(source 'agent_wake',走 runSessionTurn,与管家派回合
  // 同一条路:界面照旧经 thread.live 看到它在跑,用户此刻打字会变成插话);线程正忙则由那一回合的迭代边界收件,它收尾
  // 时还有漏收的(信封落在最后一次模型调用之后)再补唤醒。
  // 边界:
  //   · 只认【模型自己】以 background:true 起的 run(run.launchedByModel → 账本行 wakeParent:true,11 notifyAgentRunEnvelope 写)。
  //     面板 / HTTP 的 async 启动同样 background:true,但是用户点的、没有模型在等 —— 信封照常进账本随下一回合送达,不替模型起回合;
  //   · 被叫停的 run(stopped / cancelled)不唤醒 —— 信封照旧在下一回合开头送达;
  //   · 用户叫停之后不唤醒(agentWakeSuppressed):回合被用户停止 / 断线被杀 / 被新回合顶掉的那一次收尾不补唤醒;而且后台代理与回合 abort
  //     脱钩(ctrl:null),叫停之后它们照样会跑完 —— 所以信封落账时也要看这张「叫停过」表,否则线程会在用户 Stop 之后自己又开工。
  //     撤回(rewind)同理:线程已被改写,别替一段被撤回的对话把模型叫醒。表在下一个【不是唤醒起的】回合起手清掉(用户重新说话了);
  //     被拦下的信封一份都不丢 —— 仍在账本里,随用户下一句话的回合开头送达(与关掉 agentAutoWake 时同一条路);
  //   · 每份信封只唤醒一次(进程内记账,按 job id + 完成时刻:续跑 / 重试的同一个 run 再交一份信封会再唤醒);
  //     连续唤醒最多 AGENT_WAKE_CHAIN_MAX 次,防模型「起后台代理 → 被唤醒 → 再起」无限循环,任何不是唤醒起的回合都清零;
  //   · 进程重启:信封落了账、唤醒还没起成就重启的,启动时补排(scheduleAgentWakesAtBoot);重启打断的后台 run 由 08 补一份
  //     interrupted 信封,但不唤醒(重启不是代理「做完了」,留到用户下一句话时送达);
  //   · 手动压缩进行中不唤醒(摘要要算几秒,期间起回合会让那份摘要作废),压缩结束再排一次;
  //   · 管家会话不唤醒(它有自己的运行器);会话已删不唤醒;
  //   · 唤醒回合不是用户的意思表示:source 不是 'http',所以不改「上次用的引擎」、不清 stewardTaint(见 runSessionTurn)。
  const AGENT_WAKE_SOURCE = 'agent_wake';
  // 系统自己起的回合:同一条线程上已经有一个同源回合在跑时,后来者不顶替、而是被挡回去(见 runSessionTurn 的忙判定)。
  const EXCLUSIVE_TURN_SOURCES = new Set(['scheduler', AGENT_WAKE_SOURCE]);
  const AGENT_WAKE_DEBOUNCE_MS = 1500;   // 同一批并行代理前后脚收尾时合成一次唤醒
  const AGENT_WAKE_CHAIN_MAX = 6;
  const agentWakeTimers = new Map();     // sessionId -> 防抖定时器
  const agentWakeAttempted = new Map();  // sessionId -> Set(账本 job id):已经为它唤醒过的信封
  const agentWakeChain = new Map();      // sessionId -> 自上一条用户消息以来的连续唤醒次数
  const agentWakeSuppressed = new Set(); // sessionId:用户叫停 / 撤回过,在下一个非唤醒回合起手之前不再自动唤醒
  // 被叫停的 run(stopped = 有人按了停止,cancelled 同义)不唤醒:用户刚表示过不要了。
  // 进程重启打断的(interrupted)也不唤醒:不是代理做完了,信封留到用户下一句话时送达。
  function agentWakeSkipsStatus(status) { return status === 'stopped' || status === 'cancelled' || status === 'canceled' || status === 'interrupted'; }
  // 记账键带完成时刻:同一个 run 续跑 / 重试后再交一份信封(09 launchPersistedAgentRun 先撤掉「已送达」),job id 不变,
  // 只按 id 记的话第二份永远判成「唤醒过了」。
  function agentWakeJobKey(job) { return String(job && job.id || '') + '@' + String(job && job.completedAt || ''); }
  function scheduleAgentWake(sessionId, reason) {
    const sid = safeSessionId(sessionId);
    if (!sid || sid === STEWARD_SESSION_ID) return false;
    if (agentWakeTimers.has(sid)) return true;
    const timer = setTimeout(() => {
      agentWakeTimers.delete(sid);
      runAgentWake(sid, reason).catch(error => logEvent({ kind: 'agent_wake_error', sessionId: sid, error: String((error && error.message) || error).slice(0, 400) }));
    }, AGENT_WAKE_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    agentWakeTimers.set(sid, timer);
    return true;
  }
  function agentWakeMessage(jobs) {
    const lines = jobs.slice(0, 8).map(job => `- 「${String(job.name || job.runId || '').replace(/\s+/g, ' ').slice(0, 80)}」(run ${job.runId},${job.status})`);
    if (jobs.length > 8) lines.push(`- 另有 ${jobs.length - 8} 个`);
    // 只有账本行确是模型自己起的(wakeParent)才说「你先前用 orchestrate_agents 启动的」;别的(防御:判据在 pendingAgentWakeJobs 已滤过)不替模型认账。
    const byModel = jobs.every(job => job && job.wakeParent === true);
    return [
      byModel
        ? `[后台代理已完成 · 自动唤醒] 你先前用 orchestrate_agents{background:true} 启动的 ${jobs.length} 个后台代理已结束:`
        : `[后台代理已完成 · 自动唤醒] ${jobs.length} 个后台代理 / 工作流运行已结束:`,
      ...lines,
      '它们的交付信封随本条送达。请据此继续原来的任务;如果已经没有要做的,就向用户简要汇报结果。这是工作台的系统通知,不是用户的新指令。',
    ].join('\n');
  }
  async function runAgentWake(sessionId, reason) {
    // 线程正忙:那一回合的迭代边界会收件,收尾时 runSessionTurn 的 finally 再排一次。
    if (turnSettlers.has(sessionId) || activeChildren.has(sessionId)) return { ok: false, skipped: 'busy' };
    // 手动压缩算摘要期间不起回合(回合会追加历史,那份摘要落盘时被长度守卫作废);runProviderCompact 收尾时再排一次。
    if (providerCompactInFlight.has(sessionId)) return { ok: false, skipped: 'compacting' };
    // 用户刚叫停 / 撤回过:不替他把线程叫醒。信封留在账本里,他下一句话的回合开头照常送达(见上面头注)。
    if (agentWakeSuppressed.has(sessionId)) return { ok: false, skipped: 'user_stopped' };
    if (typeof EventStreamHooks.pendingAgentWakeJobs !== 'function') return { ok: false, skipped: 'unsupported' };
    // 设置里关掉了(agentAutoWake:false):信封照旧等用户下一句话时随回合开头送达。
    const wakeConfig = await readConfig().catch(() => null);
    if (wakeConfig && wakeConfig.agentAutoWake === false) return { ok: false, skipped: 'disabled' };
    const session = await loadSession(sessionId).catch(() => null);
    if (!session || session.kind === 'steward') return { ok: false, skipped: 'no_session' };
    const attempted = agentWakeAttempted.get(sessionId) || new Set();
    const pending = EventStreamHooks.pendingAgentWakeJobs(session)
      .filter(job => !attempted.has(agentWakeJobKey(job)) && !agentWakeSkipsStatus(String(job.status || '')));
    if (!pending.length) return { ok: false, skipped: 'nothing_pending' };
    const chain = agentWakeChain.get(sessionId) || 0;
    if (chain >= AGENT_WAKE_CHAIN_MAX) {
      logEvent({ kind: 'agent_wake_capped', sessionId, chain, runIds: pending.map(job => String(job.runId || '')) });
      return { ok: false, skipped: 'chain_capped' };
    }
    // 装载会话期间用户可能刚发了一句 / 按了停止:再判一次。下面到 runSessionTurn 登记 turnSettlers 之间 runSessionTurn 自己还有 await
    // (装载配置与会话),那一段由它的忙判定(409,见 catch)与「系统来源装载不到会话就不新建」兜住。
    if (turnSettlers.has(sessionId) || activeChildren.has(sessionId)) return { ok: false, skipped: 'busy' };
    if (agentWakeSuppressed.has(sessionId)) return { ok: false, skipped: 'user_stopped' };
    for (const job of pending) attempted.add(agentWakeJobKey(job));
    agentWakeAttempted.set(sessionId, attempted);
    agentWakeChain.set(sessionId, chain + 1);
    const runIds = pending.map(job => String(job.runId || '')).filter(Boolean);
    logEvent({ kind: 'agent_wake', sessionId, reason: String(reason || ''), chain: chain + 1, runIds });
    const turn = runSessionTurn({
      sessionId, message: agentWakeMessage(pending), source: AGENT_WAKE_SOURCE,
      messageMeta: { origin: AGENT_WAKE_SOURCE, runIds },
      requestMeta: { tool: AGENT_WAKE_SOURCE, runIds },
      onEvent: () => {},
    });
    turn.catch(error => {
      // 线程在 runAgentWake 校验之后被删:没有东西可唤醒,安静跳过(runSessionTurn 对系统来源不新建会话)。
      if (error && error.code === 'SESSION_NOT_FOUND') { logEvent({ kind: 'agent_wake_skipped', sessionId, reason: 'session_gone' }); return; }
      // 起回合那一刻撞上别处起的回合(409):那一回合会收件,退回记账,让它收尾时还能补唤醒。
      if (error && error.code === 'SESSION_TURN_BUSY_ELSEWHERE') {
        for (const job of pending) attempted.delete(agentWakeJobKey(job));
        // 只退回【我们自己】加的那一格:撞上的若是用户回合,它起手时已经把计数清零(agentWakeChain.delete),这里再写回旧值
        // 等于吃掉用户刚做的清零(「连续唤醒上限」在用户说过话之后提前触顶)。计数不再是 chain+1 = 已被别人动过,不碰。
        if (agentWakeChain.get(sessionId) === chain + 1) agentWakeChain.set(sessionId, chain);
      }
      logEvent({ kind: 'agent_wake_error', sessionId, code: String((error && error.code) || ''), error: String((error && error.message) || error).slice(0, 400) });
    });
    return { ok: true, runIds, turn };
  }
  EventStreamHooks.onAgentEnvelopePersisted = job => {
    if (!job || agentWakeSkipsStatus(String(job.status || ''))) return;
    scheduleAgentWake(job.sessionId, 'envelope');
  };
  // 撤回(02 rewindSession,存盘成功之后调):线程已被改写到更早的一句话 —— 记「叫停过」:此后到用户下一句话之前不自动唤醒。
  // 仍在跑的后台代理(与回合 abort 脱钩)跑完不该把一段被撤回的对话叫醒;它们的信封留在账本里,下一回合开头照常送达(与 Stop 同一条路)。
  // (被撤回回合里【模型自己起的】仍在跑的后台 run 由 02 cancelModelRunsOfDiscardedTurns 就地停掉 —— 停 run 的零件都在 02 / 08,不让 10 多一条回环边。)
  EventStreamHooks.onSessionRewound = ({ sessionId } = {}) => {
    const sid = safeSessionId(sessionId);
    if (!sid) return false;
    agentWakeSuppressed.add(sid);
    return true;
  };
  // 启动时补排:信封已落账、唤醒还没起成(防抖窗口内重启、崩溃)的会话。只看最近 AGENT_WAKE_BOOT_WINDOW_MS 内完成的 ——
  // 更早的要么早已唤醒过(唤醒回合开头就登记已读),要么当时开关关着 / 唤醒到了上限,重启不该把几天前的线程一起叫醒。
  // 是否已读、开关、上限仍由 runAgentWake 按会话判。
  // 异步 + 按 mtime 预筛(11 recentBackgroundAgentJobSessions):账本文件最大可到 MB 级,修前启动期同步全量读完才 listen。
  // 调用方(13 startServerInner)不 await —— 启动不等它;函数自己兜住一切异常,绝不产生未处理的拒绝。
  const AGENT_WAKE_BOOT_WINDOW_MS = 6 * 3600 * 1000;
  async function scheduleAgentWakesAtBoot() {
    if (typeof EventStreamHooks.recentBackgroundAgentJobSessions !== 'function') return 0;
    try {
      const sessionIds = await EventStreamHooks.recentBackgroundAgentJobSessions(Date.now() - AGENT_WAKE_BOOT_WINDOW_MS);
      let scheduled = 0;
      for (const sid of Array.isArray(sessionIds) ? sessionIds : []) if (scheduleAgentWake(sid, 'boot')) scheduled++;
      if (scheduled) logEvent({ kind: 'agent_wake_boot', sessions: scheduled });
      return scheduled;
    } catch { return 0; }
  }

  return {
    runSessionTurn, runProviderCompactTracked, scheduleAgentWakesAtBoot,
    agentWakeJobKey, agentWakeSkipsStatus, agentWakeMessage, agentWakeChain, agentWakeTimers, runAgentWake,
  };
}

module.exports = { createSessionTurnRuntime };
