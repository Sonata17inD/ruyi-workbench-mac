'use strict';

function createStewardInboxQueue({
  logEvent, stewardRunnerRuntime, pendingPermissions, runStewardTurn,
  presence, limits,
}) {
  const {
    stewardPendingKeyOf, stewardPendingStillOpen, stewardPresenceRows, stewardViewingSessionIds,
  } = presence;
  const {
    STEWARD_BLOCKING_DEBOUNCE_MS, STEWARD_DEBOUNCE_MS, STEWARD_INBOX_EVENTS_PER_TURN,
    STEWARD_QUICK_DEBOUNCE_MS, STEWARD_VIEW_HELD_MAX, STEWARD_VIEW_RECHECK_MS,
  } = limits;

  // ────────────────────────────────────────────────────────────────────────────
  // 收件箱驱动:116b 每轮写完箱子调 onInboxBatch,这里做 5 秒去抖后起一个收件箱回合。
  // ────────────────────────────────────────────────────────────────────────────
  // hunt2-steward ③:收件箱回合失败(端点不通 / 引擎不可用)时这一批事件回到队列【头部】,下一次排空
  // 先处理它们 —— 修前它们在定时器里被 splice 出去之后就再也没人管。重试有界:同一条事件最多再试
  // STEWARD_INBOX_TURN_RETRY_MAX 次,端点长期不通时不会每 5 秒空转一次到天荒地老;超过就放弃并记审计
  // (事件本身仍在收件箱落盘的账里,到访摘要照样看得见它)。次数记在 WeakMap 上,不改事件对象的形状。
  const STEWARD_INBOX_TURN_RETRY_MAX = 3;
  const stewardInboxRetryCounts = new WeakMap();
  function stewardRequeueFailedInboxBatch(events, reason) {
    if (stewardRunnerRuntime.stopped) return;
    const keep = [];
    let dropped = 0;
    for (const evt of (Array.isArray(events) ? events : [])) {
      if (!evt || typeof evt !== 'object') continue;
      const tries = (stewardInboxRetryCounts.get(evt) || 0) + 1;
      if (tries > STEWARD_INBOX_TURN_RETRY_MAX) { dropped += 1; continue; }
      stewardInboxRetryCounts.set(evt, tries);
      keep.push(evt);
    }
    if (keep.length) stewardRunnerRuntime.queue.unshift(...keep);
    logEvent({ kind: 'steward_inbox_requeued', reason: String(reason || ''), requeued: keep.length, dropped });
  }
  // 116-3 P1-10:排空是【自持】的。修前只有「轮询器又写了新的一批」才会排一次定时器,于是一次大批量
  // 积压超过 30 条之后,只要活动很快安静下来,剩下的条目会一直躺在内存队列里没人处理(而且是纯内存态,
  // 进程重启整份丢失);用户来跟管家说话也不会把它清掉。现在:一批处理完队列还有就接着排一个定时器;
  // 用户回合结束时也顺带踢一次(用户说话本来就会解除无进展退避,顺手把积压带走)。
  // 116-4:队列里有没有「有人正等着的那一句答案」。
  function stewardQueueHasQuickAnswer(rows) {
    return (Array.isArray(rows) ? rows : []).some(r => r && r.kind === 'done' && r.payload && r.payload.quick === true);
  }
  // 2026-10:队列里有没有「线程正卡在上面等」的权限/提问待决(13i 投影出来的那一路:payload 带 interventionId)。
  function stewardQueueHasBlockingAsk(rows) {
    return (Array.isArray(rows) ? rows : []).some(r => r && r.payload && r.payload.interventionId
      && (r.payload.interventionType === 'permission' || r.payload.interventionType === 'question'));
  }
  function stewardInboxDebounceMs(rows) {
    if (stewardQueueHasQuickAnswer(rows)) return STEWARD_QUICK_DEBOUNCE_MS;
    if (stewardQueueHasBlockingAsk(rows)) return STEWARD_BLOCKING_DEBOUNCE_MS;
    return STEWARD_DEBOUNCE_MS;
  }
  // 2026-10(用户:「用户在看提问、权限,管家被立刻唤醒也不要插手」):起回合之前,把【用户此刻正看着】的那几条待决
  // (在场信号 viewing,见 13r / 13i)从这一批里拿出来先扣着 —— 不为它起回合,也就不会去插手。收件箱那一行照常在
  // (安静卡、到访摘要都读它),扣的只是「管家处理」这一步。每 STEWARD_VIEW_RECHECK_MS 重判一次:已经结算的作罢;
  // 用户不看了(收起弹窗 / 走开一分钟)就排回队头、照常排空。工具层另有一道同判据的门(13k stewardSeatedByUser)。
  function stewardViewedPendingStillOpen(evt) {
    const payload = (evt && evt.payload && typeof evt.payload === 'object') ? evt.payload : {};
    if (payload.interventionType === 'permission') return pendingPermissions.has(String(payload.interventionId || ''));
    return stewardPendingStillOpen(evt);
  }
  function stewardRecheckViewHeld() {
    const held = Array.isArray(stewardRunnerRuntime.viewHeld) ? stewardRunnerRuntime.viewHeld : [];
    const viewing = stewardViewingSessionIds(stewardPresenceRows());
    const keep = [];
    const release = [];
    for (const evt of held) {
      if (!stewardViewedPendingStillOpen(evt)) continue;
      if (viewing.has(String(evt.sessionId || ''))) keep.push(evt); else release.push(evt);
    }
    stewardRunnerRuntime.viewHeld = keep;
    if (!keep.length && stewardRunnerRuntime.viewHeldTimer) {
      clearInterval(stewardRunnerRuntime.viewHeldTimer);
      stewardRunnerRuntime.viewHeldTimer = null;
    }
    if (release.length && !stewardRunnerRuntime.stopped) {
      stewardRunnerRuntime.queue.unshift(...release);
      stewardScheduleInboxDrain();
    }
  }
  function stewardHoldViewedEvents(batch) {
    const list = Array.isArray(batch) ? batch : [];
    const viewing = stewardViewingSessionIds(stewardPresenceRows());
    if (!viewing.size) return list;
    const run = [];
    for (const evt of list) {
      const key = viewing.has(String((evt && evt.sessionId) || '')) ? stewardPendingKeyOf(evt) : '';
      if (!key) { run.push(evt); continue; }
      if (!stewardRunnerRuntime.viewHeld.some(item => stewardPendingKeyOf(item) === key)) stewardRunnerRuntime.viewHeld.push(evt);
    }
    while (stewardRunnerRuntime.viewHeld.length > STEWARD_VIEW_HELD_MAX) stewardRunnerRuntime.viewHeld.shift();
    if (stewardRunnerRuntime.viewHeld.length && !stewardRunnerRuntime.viewHeldTimer) {
      const timer = setInterval(stewardRecheckViewHeld, STEWARD_VIEW_RECHECK_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
      stewardRunnerRuntime.viewHeldTimer = timer;
    }
    return run;
  }
  function stewardScheduleInboxDrain() {
    if (stewardRunnerRuntime.inflight?.kind === 'reset') return;
    if (stewardRunnerRuntime.stopped) return;
    if (!stewardRunnerRuntime.queue.length) return;
    // 116-4:去抖时长由【队列内容】决定,不由调用方决定 —— 五个调用点一行都不用改,新语义自动覆盖全部。
    const delay = stewardInboxDebounceMs(stewardRunnerRuntime.queue);
    if (stewardRunnerRuntime.debounceTimer) {
      // 已经排着的那个更快或一样快:不动。更慢:重排 —— 否则一条先到的普通通知会把速查答案一起按住 5 秒。
      if (delay >= stewardRunnerRuntime.debounceMs) return;
      clearTimeout(stewardRunnerRuntime.debounceTimer);
      stewardRunnerRuntime.debounceTimer = null;
    }
    stewardRunnerRuntime.debounceMs = delay;
    const timer = setTimeout(() => {
      stewardRunnerRuntime.debounceTimer = null;
      stewardRunnerRuntime.debounceMs = -1;
      if (stewardRunnerRuntime.stopped) return;
      const batch = stewardHoldViewedEvents(stewardRunnerRuntime.queue.splice(0, STEWARD_INBOX_EVENTS_PER_TURN));
      if (!batch.length) { stewardScheduleInboxDrain(); return; }
      void runStewardTurn({ trigger: 'inbox', events: batch }).then(
        // 熔断(停机 / 小时窗触顶 / 日费用触顶 / 无进展退避)时【不】自排下一轮:那一路会把这批事件
        // 原样退回队列,再排就是一个 5 秒一次的空转循环,而解除熔断的条件(用户说话)本来就会在
        // 用户回合收尾时踢一次排空。其余情况(含 steward.busy 与引擎不可用)照常接着排。
        result => { if (!(result && result.circuit)) stewardScheduleInboxDrain(); },
        () => { /* 抛错不自排:等下一批新事件或下一次用户回合 */ },
      );
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    stewardRunnerRuntime.debounceTimer = timer;
  }
  function stewardOnInboxBatch(rows) {
    if (stewardRunnerRuntime.stopped) return;
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (!list.length) return;
    stewardRunnerRuntime.queue.push(...list);
    stewardScheduleInboxDrain();
  }

  return {
    stewardOnInboxBatch, stewardRequeueFailedInboxBatch, stewardScheduleInboxDrain,
  };
}

module.exports = { createStewardInboxQueue };
