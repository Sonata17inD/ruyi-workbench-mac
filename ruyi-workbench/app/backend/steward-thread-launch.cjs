'use strict';

function createStewardThreadLauncher({
  ExternalBotHooks, logEvent, nowIso, safeSessionId, updateSessionMeta, runSessionTurn,
}) {
  // 后台回合:fire-and-forget(不 await)。管家回合不能被线程回合的时长绑住 —— 它要立刻回一句
  // 「已经交给线程 X 去做了」。异常只写 logEvent,绝不冒泡到工具返回值(那会让模型以为没交出去)。
  // 116-4(27 号文 §11.7「第四源 sessionTurns」):回合 settle 之后把【身份与成败】落到会话头上。
  // 为什么必须落盘:收件箱只读磁盘上的账,而会话头本来没有任何回合成败字段(实测:回合失败后头上只有
  // summary 里那句人话,那是渲染不是信号),runSessionTurn 的返回值只活在这一个进程的这一个闭包里。
  // 不落盘 = 第四源永远只能报「跑完了」,报不出「挂了」。
  //   · launchedBy 在这里补写,是为了覆盖 thread_continue(递话给用户自己的会话,它没经过 createSession)；
  //     quick_ask / thread_new 已经在建会话时就地写过了,这里重复写是幂等的。
  //   · 成败取【内层】result.result.ok —— 外层 ok 只表示「这次调用完成了」,一条 HTTP 500 的回合外层
  //     仍然是 ok:true(116-4 实测),拿外层判会把每一条失败回合都说成收工。
  //   · 走 updateSessionMeta 而不是 loadSession+saveSession:settle 那一刻会话可能还在收尾窗口里,
  //     这条通道会延后到 settle 之后在【重新装载的副本】上重放,不会用陈旧正文盖掉回合刚写的消息。
  //   · 旁路纪律:写失败只是少一条账(第四源退化成报 done),绝不反噬回合本身。
  function stewardRecordLaunchOutcome(sessionId, result) {
    const sid = safeSessionId(sessionId);
    if (!sid) return Promise.resolve(null);
    const inner = (result && typeof result === 'object' && result.result && typeof result.result === 'object') ? result.result : null;
    const aborted = !!(inner ? inner.aborted : (result && result.stopped));
    const ok = inner ? inner.ok === true : !!(result && result.ok);
    return updateSessionMeta(sid, {
      launchedBy: 'steward',
      stewardLastTurn: {
        seq: Math.max(0, Number(result && result.turnSeq) || 0),
        ok,
        aborted,
        errorClass: String((inner && inner.errorClass) || ''),
        at: nowIso(),
      },
    }).catch(() => null);
  }

  // 管家刚发起、但 runSessionTurn 还没走到登记 turnSettlers 的那几个 await 窗口里,线程既不在 activeChildren
  // 也不在 turnSettlers:修前前后脚两次 steward_thread_continue 都判成 turn 通道,第二个回合在 09 里把第一个
  // superseded 掉,第一句话连回合一起没了,两次却都回 ok:true。这里【同步】记一笔,13q 的通道判定据此判成
  // queued(settling)。回合整个结束(不论成败)才摘掉;回合真跑起来之后 activeChildren 会先于它命中(steer)。
  const stewardLaunchingTurns = new Set();
  function stewardLaunchTurn(input, tool) {
    const launchSid = String(input.sessionId || '');
    if (launchSid) stewardLaunchingTurns.add(launchSid);
    let registered;
    const registration = new Promise(resolve => { registered = resolve; });
    // 第二轮工具走查(F17):给管家发起的那条【用户消息】盖上出身标 meta.origin:'steward'(随会话正文落盘,与收件箱回合的
    // origin:'inbox' 同一个机制)。修前 thread_new 的委托书、thread_continue 的递话、quick_ask 的问题落在线程里都是一条
    // 没有任何标记的 role:'user' 消息,于是 steward_memory_write 的来源校验(13l stewardSourceIsUserMessage)分不出
    // 「用户本人说的」和「管家自己转发过去的」—— 管家能把自己写的委托书引成「用户说过」记进记忆。
    // 只覆盖 Provider 引擎的线程(09 runOpenAiTurn 才接 messageMeta;CLI 引擎的回合不接,与收件箱标同一个边界)。
    // input 里调用方自己给的 messageMeta 优先(目前没有)。
    const promise = runSessionTurn({ messageMeta: { origin: 'steward', tool: String(tool || '') }, ...input, onEvent: event => {
      // Capture the identity and anchor emitted by THIS driver, never a later current-session lookup.
      if (event && event.type === 'session' && event.session && event.session.id === launchSid) {
        const execution = event.execution;
        registered(execution && typeof execution === 'object' ? {
          execution: { ...execution }, rewindTargetTurnSeq: (Number(event.session.turnSeq) || 0) + 1,
        } : null);
      }
    } });
    promise.registration = registration;
    promise.finally(() => { registered(null); if (launchSid) stewardLaunchingTurns.delete(launchSid); }).catch(() => {});
    promise.then(result => {
      logEvent({ kind: 'steward_turn_done', tool, sessionId: String(input.sessionId || ''), ok: !!(result && result.ok), stopped: !!(result && result.stopped) });
      void stewardRecordLaunchOutcome(input.sessionId, result);
    }).catch(error => {
      logEvent({ kind: 'steward_turn_error', tool, sessionId: String(input.sessionId || ''), message: String((error && error.message) || error).slice(0, 400) });
      // 回合整个抛出来(不是回合内部失败):同样要留一条落盘的账,否则第四源看见 turnSeq 没动
      // 就什么都不报,管家永远不知道自己派出去的这一趟连回合都没起来。
      void stewardRecordLaunchOutcome(input.sessionId, { result: { ok: false, aborted: false, errorClass: 'launch_error' } });
    });
    return promise;
  }

  // ── 116-3 P0-2(对抗审查:线程族三工具在三条路径上都没有接入权限门)────────────────────────
  // 触发面判定。`ctx.trigger` 由回合运行器的三个执行点显式给:
  //   · 模型在结构化回复里声明的 actions —— 透传本回合的 'user' | 'inbox';
  //   · 确定性自理(七道闸那条路)—— 恒 'inbox',并另带 ctx.selfServe = true;
  //   · 用户在界面上亲手按下按钮的 act 执行路径 —— 恒 'user'。
  // 这里用的是 trigger 而【不是】 userPressed:后者的读者按 06i 契约与静态锁只有三处(config_set /
  // skill_toggle 的「须确认」判定,加 117z-E2 给 thread_permission 的桌面【放宽】那一处),
  // 「按钮 ≠ 扩权」—— 线程族的在不在场判定不该去挤那个字段。
  // 其余调用面(工具循环里模型直接调、进程内直调)没有 trigger —— 保持既有直递语义。
  // 核心层的失败可能是裸串,也可能是 apiFailure 的 {code,message,params}:修前一律 String() 掉,模型看到的拒绝理由
  // 是「[object Object]」。
  function stewardErrorDetail(error) {
    if (error && typeof error === 'object') return String(error.message || error.code || '');
    return String(error == null ? '' : error);
  }
  function stewardTriggerOf(ctx) {
    const raw = String((ctx && ctx.trigger) || '');
    return raw === 'inbox' || raw === 'user' || raw === 'external' ? raw : '';
  }
  function stewardUserDirected(ctx) {
    return stewardTriggerOf(ctx) === 'user' || (typeof ExternalBotHooks.isAuthorizedContext === 'function' && ExternalBotHooks.isAuthorizedContext(ctx) === true);
  }
  // 这一次调用是不是「模型自己在无人值守回合里决定要动别的线程」。
  // 三者都不是它:① 用户就在跟前(trigger==='user',含亲手按按钮那条路);② 13h 的【确定性自理】(七道闸,
  // ctx.selfServe === true —— 它按事件类别走的是 §3.3 真值表的 'failed' 档,不是 'relay' 档,已经在
  // stewardSelfServeGate 里逐条判过了,这里再按 relay 判一次会把「失败自动重试」也一起挡掉);
  // ③ 没有 trigger 的调用面(进程内直调/工具循环)—— 保持既有直递语义。
  // ctx 由 13h 构造,模型碰不到它;args 里同名字段一概不作数(与 userPressed 同一条纪律)。
  function stewardUnattendedByModel(ctx) {
    if (!ctx || ctx.selfServe === true) return false;
    return stewardTriggerOf(ctx) === 'inbox';
  }
  // 无人值守(inbox)触发时线程族的自理清单闸:relay 没勾选就只提议。
  function stewardRelayAutoAllowed(config) {
    const auto = (config && config.stewardAutoActions && typeof config.stewardAutoActions === 'object') ? config.stewardAutoActions : {};
    return auto.relay === true;
  }

  function stewardLaunchPending(sessionId) {
    return stewardLaunchingTurns.has(sessionId);
  }

  return {
    stewardLaunchTurn, stewardLaunchPending, stewardErrorDetail, stewardUserDirected,
    stewardUnattendedByModel, stewardRelayAutoAllowed,
  };
}

module.exports = { createStewardThreadLauncher };
