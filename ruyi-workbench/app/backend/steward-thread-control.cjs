'use strict';

function createStewardThreadControl({ execution, sessions, audit }) {
  const { requestSessionExecutionStop, stewardArbiterPrioritize, stewardArbiterWait } = execution;
  const { safeSessionId, stewardRawKind, stewardReadSessionHead, stewardThreadPermissionMode } = sessions;
  const { readConfig, stewardAppendDecision, stewardBasisOf, stewardFail, stewardSanitizeText, waitReasonFor } = audit;

  // ── steward_thread_prioritize(116h,§8.10「每行可提升优先级＝插队占下一个并发位」)──────────────
  // 落在 13h 而不是 13g:实现要直接调本文件的仲裁器原语,而 13g 在拼接顺序上更早(引用本文件 = 前向边);
  // 13g 也已顶到 SPEC §2 的 2000 行目标,再往里塞就要为它另起一次拆分。门控壳仍用 13g 的
  // stewardToolHandler(13h -> 13g 是后向边),开关/身份两道 fail-closed 与其余 20 个工具逐字一致。
  //
  // 语义刻意做窄:只把【还在排队】的那一条提到队首,下一个释放出来的并发位归它。不预留、不抢占 ——
  // 已经在跑的回合不会因为别人插队被打断(那会把一条线程做到一半的活扔掉,代价远大于早跑几秒的收益)。
  // 目标不在队列里(在跑 / 已收工 / 根本没开回合)不是错误:返回 prioritized:false + reason,
  // 让模型如实告诉用户「它没在排队,不用插」,而不是重试或编一个成功。
  async function stewardImplThreadPrioritize(args, ctx, config) {
    const sessionId = safeSessionId(args.sessionId);
    if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
    const head = await stewardReadSessionHead(sessionId);
    if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
    if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session is not a thread');
    const result = stewardArbiterPrioritize(sessionId);
    if (!result || result.ok !== true) {
      return stewardFail(String((result && result.error) || 'steward.failed'), String((result && result.message) || 'prioritize failed'), { sessionId });
    }
    if (result.prioritized !== true) {
      return { ok: true, sessionId, prioritized: false, reason: String(result.reason || 'not_queued'), wait: null };
    }
    stewardAppendDecision({
      tool: 'steward_thread_prioritize',
      args: { sessionId },
      targetSessionId: sessionId,
      permissionMode: stewardThreadPermissionMode(head, config),
      mayAct: 'auto',
      undoRef: { kind: 'prioritize', sessionId },
      basis: {},
    });
    return { ok: true, sessionId, prioritized: true, wait: waitReasonFor({ pending: 0 }, stewardArbiterWait(sessionId)) };
  }

  // ── steward_thread_stop(117m-A4,27 号文 §11.10 用户第六轮走查第 ③ 条「暂停这个线程,会显示 invalid」)──
  // 根因:管家手里【只有】班组级的 steward_run_action(13g 的 stewardImplRunAction 头一行就要 sessionId
  // 与 runId)。普通线程回合根本没有班组,模型想「暂停这条线程」只能拿它凑 -> 必然 invalid_request ->
  // 前端 errGeneric 把机器码原样贴出来,就是用户看到的那个「invalid」。抽屉底部那枚「停止」按钮走的是
  // POST /api/stop,管家一直没有对应的原语。这里补的就是那条路,不是第二条停机路径:
  //   ① stopSession(既有停止原语:拿 activeChildren 里的 abort 句柄直接掐,并清掉该会话的三张待决表);
  //   ② stewardCancelQueuedTurn(116h 仲裁器:stopSession 只认活回合,【还在排队】的回合它看不见);
  //   ③ revokeAllGrants(第 27 波:显式停止 = 夺回控制,该会话的授权书连 scope:'session' 一并撤)。
  // 三件都是既有核心,本函数一行停机逻辑都不自己写。
  //
  // 落在 13h 而不是 13g:与 stewardImplThreadPrioritize 同一条理由 —— 它要直接调本文件的仲裁器原语,
  // 而 13g 已经顶到 SPEC §2 的 2000 行目标。门控壳仍用 13g 的 stewardToolHandler(13h -> 13g 是后向边),
  // 开关/身份两道 fail-closed 与其余工具逐字一致。
  //
  // 权限:停止是【收紧类】—— 与 STEWARD_RUN_TIGHTENING 同款,任何权限档都 mayAct='auto'(连「每步都问」
  // 的线程也允许管家替你按停,因为它只会让事情【少】发生)。只放开了收紧:同一条线程的 thread_continue /
  // decide / run_action{resume} 仍各自过自己的权限门,一条都没松。
  //
  // 没在跑时不许回 invalid:那不是「请求非法」,是「不用停」。信封 not_running + 一句人话,模型照直说给
  // 用户听就行(schema 的 description 里写明了拿到它不要重试)。也不许有副作用 —— 所以先看 activeChildren
  // 再决定要不要调 stopSession:stopSession 即使拿不到条目也会清一遍三张待决表,那是【停一个真在跑的
  // 回合】的收尾语义,不该发生在一个 not_running 的信封上;revokeAllGrants 同理,只在真停下了什么之后才撤。
  const STEWARD_STOP_REASON_MAX = 200;
  async function stewardImplThreadStop(args, ctx, config) {
    const sessionId = safeSessionId(args.sessionId);
    if (!sessionId) return stewardFail('invalid_request', 'sessionId is required');
    const head = await stewardReadSessionHead(sessionId);
    if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
    if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session cannot stop its own turn');
    const reason = stewardSanitizeText(args.reason).trim().slice(0, STEWARD_STOP_REASON_MAX);

    const receipt = requestSessionExecutionStop(sessionId, args.expectedExecution, 'steward-stop');
    if (!receipt.ok) return stewardFail(receipt.error, receipt.error + ': read thread_status before stopping', { sessionId });
    const { stopped, queuedStopped, alreadyRequested } = receipt;
    if (!stopped && !queuedStopped) return stewardFail('not_running', '这条线程现在没有在跑,不用停', { sessionId });

    // 停下的回合【不能】原样续上(它的半截输出已经落进会话正文;要撤销那一整回合是 rewind,另一件事)。
    // undoRef 诚实标 none,并把用户真正该走的那条路写进 note。
    const undoRef = { kind: 'none', note: '停下的回合不能原样续上;要继续用「接着办」' };
    if (!alreadyRequested) stewardAppendDecision({
      tool: 'steward_thread_stop',
      args: { stopped, queuedStopped, ...(reason ? { reason } : {}) },
      targetSessionId: sessionId,
      permissionMode: stewardThreadPermissionMode(head, config),
      mayAct: 'auto',
      undoRef,
      basis: stewardBasisOf(args, {}),
    });
    return { ok: true, sessionId, stopped, queuedStopped, undoRef };
  }

  // ── 用户手按的停止也进决策日志(121-K5;33 号文 §0 末段记的那条不对称,34 号文 §4.4 末条)────────
  // 事实:全仓只有一个停止原语(04 的 stopSession),两条路都落到它 —— 管家按的走上面那个
  // steward_thread_stop(写一行决策日志),用户按的走 POST /api/stop(什么都不写)。于是「行动流水」
  // 上看得见模型停了哪条线程,看不见人停了哪条;116-3 P1-13 当初以「全部行动经命令核心与审计」为由
  // 把「提升优先级」改走工具实现时,「停止」没照做。这里还的就是这一笔。
  //
  // 为什么住 13h:13-http-router.js 拼在 13h 【之前】,直接调 13j 的 stewardAppendDecision 是前向边
  // (32 号文 §4 纪律 1 的例 3 同一个模具)。所以走 StewardHooks 迟绑定 —— 与它旁边那个
  // cancelQueuedTurn 逐字同一个挂法:路由那一侧只认 typeof StewardHooks.x === 'function'。
  //
  // 行形状对齐上面那一条(tool/args/targetSessionId/permissionMode/mayAct/undoRef/basis):
  //   · tool = 'user_stop' —— 它不是一个管家工具,所以不叫 steward_*;读流水的人一眼分得出是谁按的;
  //   · mayAct = 'user' —— 真值表里没有这一档,因为【压根没有过权限判定】:人手按的停止不需要管家
  //     有没有资格,记的是「这一下是人做的」;
  //   · basis.origin = 'ui_stop' —— 与 revokeAllGrants(sid,'ui-stop') 同源的那句话,来路一眼可查;
  //   · undoRef 与 steward_thread_stop 那一条逐字相同(停下的回合不能原样续上,这一点与谁按的无关)。
  // 开关关时【不写】:决策日志住 stewardDir(),27 号文 §3.4 的红线是「开关关时零持久化写入」。
  // 记账失败绝不影响停止本身(stewardAppendDecision 自己就是 fire-and-forget)。
  async function stewardAppendUserStop(sessionId, facts) {
    const sid = safeSessionId(sessionId);
    if (!sid) return false;
    const config = await readConfig().catch(() => null);
    if (!config || config.stewardEnabledV1 !== true) return false;
    const head = await stewardReadSessionHead(sid).catch(() => null);
    if (!head || !head.id) return false;
    if (stewardRawKind(head) === 'steward') return false;   // 管家自己那条会话不进线程流水
    const f = (facts && typeof facts === 'object') ? facts : {};
    stewardAppendDecision({
      tool: 'user_stop',
      args: { stopped: f.stopped === true, queuedStopped: f.queuedStopped === true },
      targetSessionId: sid,
      permissionMode: stewardThreadPermissionMode(head, config),
      mayAct: 'user',
      undoRef: { kind: 'none', note: '停下的回合不能原样续上;要继续用「接着办」' },
      basis: { origin: 'ui_stop' },
    });
    return true;
  }

  return { stewardImplThreadPrioritize, stewardImplThreadStop, stewardAppendUserStop };
}

module.exports = { createStewardThreadControl };
