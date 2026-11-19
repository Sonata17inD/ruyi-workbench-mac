'use strict';

function createStewardThreadRelay({
  logEvent, safeSessionId, stewardErrorDetail, stewardFail, stewardSanitizeText,
  sessions, active, pending, wait,
}) {
  const {
    normalizeSessionEngineRoute, steerSessionCore, stewardOpenAiFallback, stewardThreadEngineRoute,
  } = sessions;
  const { activeChildren, stewardLaunchPending, turnSettlers } = active;
  const { decideIntervention, normalizeQuestionAnswer, pendingPermissions, pendingQuestions } = pending;
  const { stewardArbiterWait, waitReasonFor } = wait;

  // 117l D7(§11.9;用户走查第 7 条「一个针对复杂任务的强模型、一个简单任务的快速模型」):
  // 把 06i 判出来的那一档落到刚建好的会话头上。判定在 06i(纯函数),这里只做两件够得着的事 ——
  // 用 02 的归一器把它构造成 engineRoute,以及在「配了但端点已经被删」时记一条审计。
  //   · 那一档没配 → 不写 session.engineRoute = createSession 的既有缺省(跟随全局),存量零变化;
  //   · 端点已删 → 同样回落全局,但必须留下审计:否则用户会看到「我明明配了强模型」而无从解释
  //     (不报错、不拒绝开线程是故意的 —— 模型配错不该把事儿卡死)。
  function stewardApplyThreadTier(session, tier, config) {
    const decided = stewardThreadEngineRoute(tier, config);
    let route = decided.found
      ? normalizeSessionEngineRoute({ engine: 'openai', providerId: decided.providerId, model: decided.model })
      : null;
    if (route) session.engineRoute = route;
    else {
      if (decided.fallback) logEvent({ kind: 'steward_thread_model_fallback', tier: decided.tier, providerId: decided.providerId, sessionId: session.id });
      // 133d:那一档没配 → 不留给全局缺省(可能是 Agent CLI),按 06i 的顺序挑一个 OpenAI 兼容端点。
      route = stewardEnsureOpenAiRoute(session, config, decided.tier);
    }
    return {
      tier: decided.tier,
      engine: route ? { providerId: route.providerId, model: route.model } : { providerId: '', model: '' },
    };
  }
  // 133d(用户 2026-09-21 拍板:管家开的线程只走 OpenAI 兼容端点,两个 CLI 只留给工作台里人用):会话头上已经是
  // OpenAI 路由就一字不动;否则按 06i stewardOpenAiFallback 的顺序挑一个写上并记审计;一个端点都没有 → 留全局缺省、记审计。
  // 三个开线程的口(13k 线程/快问经 applyThreadTier、13t 定时任务直接调)都经这里,不许各自再判一遍。
  function stewardEnsureOpenAiRoute(session, config, tier) {
    const current = normalizeSessionEngineRoute(session && session.engineRoute);
    if (current && current.engine === 'openai') return current;
    const fb = stewardOpenAiFallback(config);
    const route = fb ? normalizeSessionEngineRoute({ engine: 'openai', providerId: fb.providerId, model: fb.model }) : null;
    if (route) {
      session.engineRoute = route;
      logEvent({ kind: 'steward_thread_engine_openai_only', sessionId: session.id, tier: String(tier || ''), source: fb.source, providerId: route.providerId, model: route.model });
      return route;
    }
    logEvent({ kind: 'steward_thread_no_openai_provider', sessionId: session.id, tier: String(tier || ''), globalRoute: current ? current.engine : '' });
    return null;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 第 117 波 117l D2(27 号文 §11.9;用户第四轮走查第 1、6 条):递话按【目标状态】选通道。
  //
  // 修前只有一道判据:`activeChildren.has(sessionId)` → `steward.busy`,否则起一个新回合。两头都错:
  //   · 线程正挂在 request_user_input 上等用户回答时,它在 activeChildren 里 —— 于是用户那句
  //     「走 A」被当成「线程忙」原地退回,界面还说成「我正忙着上一件」(管家忙),而真相是线程在等他;
  //   · 一旦那条判据没命中(回合刚收尾/竞态),`stewardLaunchTurn` → `runSessionTurn` 的
  //     `if (activeChildren.has) stopSession('superseded')`(09:1343,2.0 主输入框的既有语义)会把
  //     那个等回答的回合就地杀掉,`request_user_input` 变成 status:'failed',用户还没答的问题凭空消失。
  //
  // 单点判定 + 单点执行:13g 的 steward_thread_continue 与 POST /api/steward/relay 都走这里,
  // 抽屉「直接对这条线程说」不必再自己在 /api/steer 与 /api/chat/stream 之间猜。判定顺序固定:
  //   answer(在等回答)> permission(在等批准)> queued(在仲裁器队列里排着)> steer(在跑)> turn(空闲)。
  // 每一条都复用【既有】核心,不新造第二条通路:answer 走 decideIntervention(与 /api/chat/answer
  // 同一条),steer 走 steerSessionCore(与 /api/steer 同一条),turn 走 stewardLaunchTurn。
  // ════════════════════════════════════════════════════════════════════════════
  // 117l-A1-fix (1):第五种目标状态 'queued'(在仲裁器队列里等着开跑)。它排在 steer 之前 ——
  // 见 stewardRelayChannelFor 里那段头注。
  const STEWARD_RELAY_CHANNELS = Object.freeze(['answer', 'permission', 'queued', 'steer', 'turn']);
  // hunt2-steward ②:递话撞上「回合起步 / 收尾」窗口时最多等多久再重判(见 stewardRelayDeliver)。
  const STEWARD_RELAY_SETTLE_WAIT_MS = 5000;

  // 判定单点。只读内存注册表(04 的三张待决表)与活回合表,零写入、零文件读 —— 判定必须便宜,
  // 它在每一次递话前都要跑一遍。用【内存】表而不是待决旁路账:旁路账里可能留着一条回合已经死掉的
  // 陈旧 pending(那种待决没人能再答),拿它挡住递话等于把线程锁死;内存表里有 = 此刻真的有人在等。
  function stewardRelayChannelFor(sessionId) {
    const sid = safeSessionId(sessionId);
    if (!sid) return { channel: 'turn' };
    for (const [qid, entry] of pendingQuestions) {
      if (!entry || entry.sessionId !== sid || entry.commandApplying) continue;
      return { channel: 'answer', questionId: String(qid), questions: Array.isArray(entry.questions) ? entry.questions : [] };
    }
    for (const [rid, entry] of pendingPermissions) {
      if (!entry || entry.sessionId !== sid || entry.commandApplying) continue;
      return { channel: 'permission', pendingId: String(rid), pendingType: 'permission' };
    }
    // 117l-A1-fix (1)(§11.9;主会话在真夹具上复核 A1 时撞出来的边界,是真丢数据):线程【已经排在
    // 仲裁器队列里、还没开跑】也是一种目标状态,而且它落在下面两道判据的缝里 —— 它不在 activeChildren
    // 里(09 的 activeChildren.set 在回合本体里,回合本体要等 10 拿到并发位之后才开始跑),也没有任何
    // 待决(有待决的回合根本不入队,见 stewardArbiterHasPending)。修前因此判成 turn -> stewardLaunchTurn
    // 又排一个回合;锁一放两个回合前后脚被放行,后一个在 09 的
    // `if (activeChildren.has) stopSession('superseded')` 里把前一个就地杀掉 —— 排队中那句话连同它的
    // 回合一起没了(实测 turn_start x2 / turn_kill superseded / 正文只剩第二句)。这正是 §11.9 D2 要
    // 杜绝的那种 supersede,只是换了个入口,所以判据加在这里、与另外四条同一处。
    // 判据用 13h 既有的同步只读单点 stewardArbiterWait:非 null 就是「此刻真的排在队里」。
    // 入队到 drain 首次判定之间有一个极短的窗口(条目已在队列、但马上会被放行),那一刻的递话也会被
    // 判成 queued —— 保守方向:让用户再说一遍,远好过丢掉一整个回合。
    const queuedWait = stewardArbiterWait(sid);
    if (queuedWait) return { channel: 'queued', wait: waitReasonFor({ pending: 0 }, queuedWait) };
    if (activeChildren.has(sid)) return { channel: 'steer' };
    // hunt2-steward ②:回合已经进了 10 runSessionTurn(turnSettlers 已登记)、但引擎还没把它登记进
    // activeChildren —— 起步那几个 await 的窗口,或 until-done 驱动器两回合之间的空档。此刻判成 turn 会
    // 让新回合在 09 里把它 superseded 掉;插话也还插不进去(没有活子回合接它)。与上面仲裁器排队同一个
    // 保守方向:判成 queued。settling:true 标出这是「回合正在起步/收尾」而不是真的在仲裁器里排队 ——
    // 这两个窗口都很短,执行单点(stewardRelayDeliver)会先等一小会儿再重判一次,不急着退回给用户。
    // (回合收尾那一段同样落在这里:09 先把回合移出 activeChildren,再做收尾的几次存盘。)
    if (turnSettlers.has(sid)) return { channel: 'queued', wait: null, settling: true };
    // 管家自己刚发起的回合还在起步(线程启动服务的同步登记,同步登记):同上,判成 settling,不再开第二个回合。
    if (stewardLaunchPending(sid)) return { channel: 'queued', wait: null, settling: true };
    return { channel: 'turn' };
  }

  // 执行单点。返回值就是工具/路由的稳定信封({ok:true,channel,…} 或 stewardFail(...))。
  // launch 由调用方传进来(13g 的 stewardLaunchTurn 带着它自己的决策日志锚点与 requestMeta),
  // 本函数不替它决定「新回合该带什么」—— 那是 13g 的既有语义,一个字都不动。
  async function stewardRelayDeliver(input) {
    const o = (input && typeof input === 'object') ? input : {};
    const sid = safeSessionId(o.sessionId);
    const message = String(o.message == null ? '' : o.message);
    const title = String(o.title || '');
    if (!sid) return stewardFail('not_found', 'invalid sessionId');
    if (!message.trim()) return stewardFail('invalid_request', 'message is required');
    let decided = stewardRelayChannelFor(sid);
    // hunt2-steward ②:「起步 / 收尾」窗口(见 stewardRelayChannelFor)只是一瞬:等那个回合收尾(或引擎
    // 把它登记进 activeChildren)再重判,至多 STEWARD_RELAY_SETTLE_WAIT_MS —— 收尾完了走 turn,起步完了走 steer。
    // 等不到才照 queued 退回。仲裁器排队(settling 不在)不等:那可能是几分钟。
    const settleDeadline = Date.now() + STEWARD_RELAY_SETTLE_WAIT_MS;
    while (decided.channel === 'queued' && decided.settling === true && Date.now() < settleDeadline) {
      const settler = turnSettlers.get(sid);
      await Promise.race([
        settler && settler.promise ? settler.promise.catch(() => {}) : Promise.resolve(),
        new Promise(resolve => { const t = setTimeout(resolve, 100); if (t && t.unref) t.unref(); }),
      ]);
      decided = stewardRelayChannelFor(sid);
    }

    if (Array.isArray(o.attachments) && o.attachments.length && decided.channel !== 'turn') {
      return stewardFail('attachment_channel_unsupported', '这条任务正在执行、排队或等你处理待决,附件还没递进去;请等它空闲后重试,或在线程里处理当前事项', { channel: decided.channel, sessionId: sid });
    }
    if (o.revision && decided.channel !== 'turn') return stewardFail('delivery_busy', '修订需要任务空闲,请处理当前运行或待决后重试', { sessionId: sid });
    if (decided.channel === 'answer') {
      // 129g(31 号文 §2.5):这一支是管家唯一一个【替用户说话】的出口 —— 递话时那句话是用户的原话,
      // 代答时那句话是管家自己编的,而线程分不出来(两者走同一条 decideIntervention,落到线程眼里
      // 都是「用户答了」)。所以闸咬在【通道】上,不咬在工具上:不论从 steward_thread_continue 还是
      // 从 POST /api/steward/relay 进来,只要落到这一支就要过同一道门。
      // 判据与执行不分家:门在这里、在通道已经定下来【之后】、在 decideIntervention 之前,于是
      // 「先探一次通道、再去投递」中间那个状态翻转的窗口(线程刚好这一刻才挂出提问)也盖得住。
      // guard 由调用方注入(13k 拿得到 config / 目标线程头 / 管家记忆库,13h 拿不到);没注入 = 既有行为。
      if (typeof o.answerGuard === 'function') {
        const refused = await o.answerGuard(decided);
        if (refused) return refused;
      }
      // 用户这句话【就是】那道提问的答案。走与 /api/chat/answer 逐字相同的核心(13d 的 decideIntervention
      // 命令核心 + 04 的 normalizeQuestionAnswer),于是 CAS 行、审计、回合唤醒三样一个不少。
      const normalizedAnswer = normalizeQuestionAnswer({ content: message, answers: [] }, decided.questions);
      const result = await decideIntervention({
        missionId: sid,
        interventionId: decided.questionId,
        payload: { action: 'answer', normalizedAnswer },
        source: 'steward_relay',
        contractRequest: false,
      });
      if (!result || result.status !== 200) {
        return stewardFail('relay_failed', '这句话没能递成那道提问的答案(它可能刚刚超时或被别处答掉了)', {
          channel: 'answer', sessionId: sid, questionId: decided.questionId,
        });
      }
      logEvent({ kind: 'steward_relay', channel: 'answer', sessionId: sid, questionId: decided.questionId, source: String(o.source || 'steward_thread_continue') });
      return { ok: true, channel: 'answer', sessionId: sid, questionId: decided.questionId, undoRef: { kind: 'answer', sessionId: sid, questionId: decided.questionId } };
    }

    if (decided.channel === 'permission') {
      // 不代答。放行一个动作与回答一句话是两件事:前者要用户看着命令原文点头(§3.3 永久豁免的同一条精神)。
      return stewardFail('propose_required', '它在等你批准一个动作,先去批了再递话', {
        reason: 'pending_permission', channel: 'permission', sessionId: sid, pendingId: decided.pendingId,
      });
    }

    if (decided.channel === 'queued') {
      // 117l-A1-fix (1):不启动回合。也【不】把这句话挂到排队项上 —— 那要改仲裁器的队列形状
      // (entry 现在只有 sessionId/cwdKey/等待原因,没有「待递的话」这个概念),超出本轮;
      // 而在两者之间,诚实地退回来让用户再说一遍是唯一不丢数据的选择。
      // 人话里带上等待原因(与 steward_thread_status / 看板 / GET /api/missions 逐字同源的那个 label),
      // 用户才知道自己在等什么、什么时候该再说一次。
      const label = String((decided.wait && decided.wait.label) || '还没轮到它开跑');
      return stewardFail('steward.queued', `线程「${stewardSanitizeText(title) || sid}」还在排队(${label}),这句先没递进去;等它开跑后再说一次`, {
        channel: 'queued', sessionId: sid, wait: decided.wait || null,
      });
    }

    if (decided.channel === 'steer') {
      const outcome = await steerSessionCore({ sessionId: sid, text: message });
      const body = (outcome && outcome.kind === 'json') ? outcome.body : null;
      if (body && body.ok === true) {
        logEvent({ kind: 'steward_relay', channel: 'steer', sessionId: sid, source: String(o.source || 'steward_thread_continue') });
        return { ok: true, channel: 'steer', sessionId: sid, queued: Number(body.queued) || 0, injected: body.injected === true };
      }
      // 插不进去(Claude legacy/print、队列满、引擎不支持)。这时候才是「忙」—— 而且要说清是【线程】忙。
      const why = stewardErrorDetail((body && body.error) || (outcome && outcome.message)) || '这一步不能插话';
      return stewardFail('steward.busy', `线程「${title || sid}」正忙且这一步不能插话:${stewardSanitizeText(why)}`, {
        channel: 'steer', sessionId: sid, reason: 'steer_ineligible',
      });
    }

    const launch = typeof o.launch === 'function' ? o.launch : null;
    if (!launch) return stewardFail('invalid_request', 'relay turn channel needs a launcher');
    const launched = await launch();
    if (launched && launched.ok === false) return launched;
    logEvent({ kind: 'steward_relay', channel: 'turn', sessionId: sid, source: String(o.source || 'steward_thread_continue') });
    return { ok: true, channel: 'turn', sessionId: sid, ...(launched && typeof launched === 'object' ? launched : {}) };
  }

  return {
    stewardApplyThreadTier, stewardEnsureOpenAiRoute, stewardRelayChannelFor, stewardRelayDeliver,
  };
}

module.exports = { createStewardThreadRelay };
