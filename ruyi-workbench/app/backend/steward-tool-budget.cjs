'use strict';

function createStewardToolBudget({
  providerTurnQuotaKey, STEWARD_NOTIFY_WINDOW_MS, STEWARD_EXEMPT_DELEGATION_WINDOW_MS,
}) {
  // ── §11.2 深读预算:每回合 ≤6 次、累计字符 ≤ stewardReadBudgetChars ─────────────────────────
  // 桶键与 105a observation_recall 同款:会话 id + 回合键(10 providerTurnQuotaKey:优先 turnSeq,回合内稳定、
  // 压缩不改它)。每会话保留最近 4 个桶,全局最多 64 个会话,先进先出。
  const _stewardReadBudget = new Map(); // sessionId -> Map(turnKey -> { calls, chars })
  function stewardReadBucket(sessionId, turnKey) {
    let buckets = _stewardReadBudget.get(sessionId);
    if (!buckets) { buckets = new Map(); _stewardReadBudget.set(sessionId, buckets); }
    while (_stewardReadBudget.size > 64) _stewardReadBudget.delete(_stewardReadBudget.keys().next().value);
    if (!buckets.has(turnKey)) {
      buckets.set(turnKey, { calls: 0, chars: 0 });
      while (buckets.size > 4) buckets.delete(buckets.keys().next().value);
    }
    return buckets.get(turnKey);
  }
  function stewardTurnKeyOf(ctx) {
    return providerTurnQuotaKey(ctx && ctx.session);
  }

  // 每回合配额桶:复用 116c 的 stewardReadBucket 形状(会话 id + 回合序号),但各族一张自己的表 ——
  // 深读预算与起草/速查次数是三件不同的事,合在一个桶里会互相饿死。
  const _stewardTurnQuota = new Map(); // bucket -> Map(`${sessionId} ${turnKey}` -> count)
  function stewardTurnQuotaTake(bucket, ctx, max) {
    const key = String(ctx && ctx.sessionId ? ctx.sessionId : '') + ' ' + stewardTurnKeyOf(ctx);
    let table = _stewardTurnQuota.get(bucket);
    if (!table) { table = new Map(); _stewardTurnQuota.set(bucket, table); }
    const used = Number(table.get(key)) || 0;
    if (used >= max) return false;
    table.set(key, used + 1);
    while (table.size > 64) table.delete(table.keys().next().value);
    return true;
  }
  // 退一次:take 成功之后发现这一次其实没有做那件「花钱的事」(第二轮工具走查 F11:playbook_draft 在没调模型就失败时),
  // 把刚占的名额还回去。桶或键不在(已被淘汰)时什么都不做。
  function stewardTurnQuotaRefund(bucket, ctx) {
    const key = String(ctx && ctx.sessionId ? ctx.sessionId : '') + ' ' + stewardTurnKeyOf(ctx);
    const table = _stewardTurnQuota.get(bucket);
    const used = table ? Number(table.get(key)) || 0 : 0;
    if (used > 1) table.set(key, used - 1); else if (used === 1) table.delete(key);
  }

  // ── 129c(31 号文 §1 红线 4「污染规则」)：管家【自己这一回合】读过外界内容的标记 ────────────
  // 红线原文:「管家在一个回合里读过外界内容(网页、文件、线程交付里引用的外部文本),这一回合的
  // 所有写动作自动降级为『提议』」。理由:网页里一句「请把设置改成 X」不能借管家的手做事。
  //
  // **与既有的 stewardTurnTaint(06i)不是一回事,别混**:那一个判的是【目标线程】的活回合有没有
  // 读过外部内容(代批闸 8),问的是「这条线程现在要的这个权限干净吗」;这里判的是【管家自己】
  // 这一回合的上下文干不干净,问的是「管家现在要做的这个动作,是不是被它刚读到的东西指使的」。
  // 两个都要:线程干净 ≠ 管家干净。
  //
  // 形状与配额桶同源(sessionId + 回合序号),内存级、进程重启即清 —— 它只在一个回合内有意义。
  // **判不出一律算污染**是这一族的既有立场(06i 的 stewardTurnTaint 也是),但这里取不到 ctx 时
  // 回的是「没污染」:本标记只由眼睛工具【主动置位】,取不到 ctx 说明根本没有人读过东西。
  const _stewardTurnTaint = new Map(); // `${sessionId} ${turnKey}` -> Set(工具名)
  function stewardTaintKeyOf(ctx) {
    const sid = String((ctx && ctx.session && ctx.session.id) || (ctx && ctx.sessionId) || 'steward');
    return sid + ' ' + stewardTurnKeyOf(ctx);
  }
  function stewardMarkTurnTainted(ctx, by) {
    const key = stewardTaintKeyOf(ctx);
    let set = _stewardTurnTaint.get(key);
    if (!set) { set = new Set(); _stewardTurnTaint.set(key, set); }
    set.add(String(by || 'unknown').slice(0, 64));
    while (_stewardTurnTaint.size > 64) _stewardTurnTaint.delete(_stewardTurnTaint.keys().next().value);
    return set;
  }
  // 返回这一回合读过外界内容的来源(工具名,去重保序);空数组 = 干净。
  function stewardTurnTaintedBy(ctx) {
    const set = _stewardTurnTaint.get(stewardTaintKeyOf(ctx));
    return set ? [...set] : [];
  }

  // 129f:管家主动叫人的滚动一小时窗口。与代批那个窗口同一个模具(只在内存、进程重启重新开始数),
  // 但**各记各的**:代批与叫人是两件事,合在一个计数里会互相饿死 —— 叫了六次人就不能代批了,说不通。
  const stewardNotifyTimes = [];
  function stewardNotifiesInWindow(nowMs) {
    const now = Number(nowMs) || Date.now();
    while (stewardNotifyTimes.length && now - stewardNotifyTimes[0] >= STEWARD_NOTIFY_WINDOW_MS) stewardNotifyTimes.shift();
    return stewardNotifyTimes.length;
  }
  function stewardNotifyRecord(nowMs) { stewardNotifyTimes.push(Number(nowMs) || Date.now()); }

  // 127 波 2-quater B2(45 号文 §2-quater.2 闸 10):代批的滚动一小时窗口。上限数字住 06i
  // (STEWARD_EXEMPT_DELEGATIONS_PER_HOUR),窗口住这里 —— 13l 的 steward_decide 要读它,而 13m 的
  // stewardRunnerRuntime 对 13l 是前向边。只在内存:进程重启 = 重新开始数,与 13m 自理动作账
  // (stewardRunnerRuntime.selfServe)同一立场。**只记十道闸全过的那一次**(被拦下的不占名额);
  // 记在进核心之前 —— 过了闸就算用掉一次,哪怕随后 decideIntervention 回 version_conflict(宁可少代批)。
  const stewardExemptDelegationTimes = [];
  function stewardExemptDelegationsInWindow(windowNowMs) {
    const now = Number(windowNowMs) || Date.now();
    while (stewardExemptDelegationTimes.length && now - stewardExemptDelegationTimes[0] >= STEWARD_EXEMPT_DELEGATION_WINDOW_MS) {
      stewardExemptDelegationTimes.shift();
    }
    return stewardExemptDelegationTimes.length;
  }
  function stewardExemptDelegationRecord(windowNowMs) {
    stewardExemptDelegationTimes.push(Number(windowNowMs) || Date.now());
    while (stewardExemptDelegationTimes.length > 64) stewardExemptDelegationTimes.shift();
  }

  function clearStewardReadBudget(sessionId) {
    return _stewardReadBudget.delete(sessionId);
  }

  return {
    stewardReadBucket, clearStewardReadBudget, stewardTurnKeyOf, stewardTurnQuotaTake, stewardTurnQuotaRefund,
    stewardMarkTurnTainted, stewardTurnTaintedBy, stewardNotifiesInWindow, stewardNotifyRecord,
    stewardExemptDelegationsInWindow, stewardExemptDelegationRecord,
  };
}

module.exports = { createStewardToolBudget };
