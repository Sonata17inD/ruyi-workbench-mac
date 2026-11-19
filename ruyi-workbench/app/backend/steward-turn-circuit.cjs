'use strict';

function createStewardTurnCircuit({
  stewardRunnerRuntime, forEachUsageRow, usageDayKey, usageDayKeyMemo, usageRangeLowerMs,
  limits,
}) {
  const { STEWARD_NO_PROGRESS_MAX, STEWARD_TURN_DAY_MS, STEWARD_TURN_WINDOW_MS } = limits;

  // ────────────────────────────────────────────────────────────────────────────
  // 熔断(§11.3):每小时回合数、日费用、无进展、停机。触发时不调模型,只回一条带 circuit 的 steward_reply。
  // ────────────────────────────────────────────────────────────────────────────
  async function stewardDayCost(config) {
    const now = Date.now();
    const today = usageDayKey(now);
    let cost = 0;
    const dayKeyOf = usageDayKeyMemo();
    // 性能批 P1:只算今天,下界取本地今天 0 点(旧月份整份跳过;结果与整读逐条判日相同)。
    await forEachUsageRow(usageRangeLowerMs('today', now), row => {
      if (!row || row.kind !== 'aux' || row.note !== 'steward') return;
      if (dayKeyOf(row.tsMs) !== today) return;
      if (row.costTrusted === false) return;      // 套餐制名义金额不进真实费用(与 13e/13g 同口径)
      const value = Number(row.cost);
      if (Number.isFinite(value)) cost += value;
    });
    return Math.round(cost * 1e6) / 1e6;
  }

  // 滑动窗口:表里只留最近 24 小时的回合时间戳(hour 与 day 两个口径都从这一份数据算,不各记一套)。
  function stewardTurnsInWindow(now, windowMs) {
    stewardRunnerRuntime.turns = stewardRunnerRuntime.turns.filter(ts => ts > now - STEWARD_TURN_DAY_MS);
    const since = now - (Number(windowMs) || STEWARD_TURN_WINDOW_MS);
    return stewardRunnerRuntime.turns.filter(ts => ts > since).length;
  }

  async function stewardCircuitCheck(config, trigger) {
    if (stewardRunnerRuntime.stopped) return { kind: 'stopped', detail: '管家已停机(可在设置或 /api/steward/start 恢复)' };
    // 117m-A1(用户第六轮走查⑦「这个熔断也不对吧」):小时窗是【自主回合】的节流器,不是用户的说话额度。
    // 与下面 no_progress 那一条同一句纪律:用户消息永远优先,任何时候都能把管家叫醒。修前这条判据不看
    // trigger —— 真机日志里 {"kind":"steward_circuit","circuit":"turns_per_hour","trigger":"user"} 出现两次
    // (02:31:33 / 02:33:25),正是用户那两句「还在正常运转吗」被机器回了「本小时已经跑了 12 个管家回合,
    // 先歇一会儿」;而那 12 个额度是被根因 1 的「代批风暴」在 15 分钟内吃光的。两条判据当时自相矛盾。
    // 挡下【收件箱】回合时那句话必须能落地 —— 带上去哪儿调,否则用户只知道被挡了不知道怎么办。
    const maxTurns = Math.max(0, Math.round(Number(config.stewardMaxTurnsPerHour) || 0));
    if (trigger !== 'user' && maxTurns > 0 && stewardTurnsInWindow(Date.now(), STEWARD_TURN_WINDOW_MS) >= maxTurns) {
      return { kind: 'turns_per_hour', detail: `本小时已经跑了 ${maxTurns} 个管家回合,先歇一会儿(你随时可以直接跟我说话,不受这条限制)。要让它自己多跑一些,去设置·管家页把「每小时最多回合数」调高。`, limit: maxTurns };
    }
    const maxCost = Number(config.stewardMaxCostPerDay);
    if (Number.isFinite(maxCost) && maxCost > 0) {
      const spent = await stewardDayCost(config);
      if (spent >= maxCost) return { kind: 'cost_per_day', detail: `今天管家自己已经花了 ${spent},到了上限 ${maxCost}`, limit: maxCost, spent };
    }
    // 无进展只挡【收件箱】回合:用户消息永远优先,任何时候都能把管家叫醒(顺带清零退避)。
    if (trigger === 'inbox' && stewardRunnerRuntime.noProgress >= STEWARD_NO_PROGRESS_MAX) {
      return { kind: 'no_progress', detail: `连续 ${STEWARD_NO_PROGRESS_MAX} 次收件箱回合没有任何动作,退避到下一次你说话`, limit: STEWARD_NO_PROGRESS_MAX };
    }
    return null;
  }

  return {
    stewardCircuitCheck, stewardDayCost, stewardTurnsInWindow,
  };
}

module.exports = { createStewardTurnCircuit };
