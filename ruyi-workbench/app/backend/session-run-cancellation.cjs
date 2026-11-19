'use strict';

function createSessionRunCancellation({ activeAgentRuns, bumpRunIntervention, appendAgentRunEvent, saveAgentRun, logEvent }) {
  async function stopMissionAgentRuns(sessionId) {
    let count = 0;
    const saves = [];
    for (const live of activeAgentRuns.values()) {
      if (!live || !live.run || live.run.sessionId !== sessionId || live.closing || live.stopRequested) continue;
      count++;
      live.stopRequested = true;
      live.paused = false;
      try { if (live.ctrl) live.ctrl.abort(); } catch { /* best-effort */ }
      const waiters = Array.isArray(live.resumeWaiters) ? live.resumeWaiters.splice(0) : [];
      for (const wake of waiters) { try { wake(); } catch { /* best-effort */ } }
      bumpRunIntervention(live.run, 'mission_stop');
      appendAgentRunEvent(live.run, { type: 'run_stop_requested', data: { reason: 'mission_stop' } });
      saves.push(saveAgentRun(live.run).catch(() => {}));
    }
    await Promise.all(saves);
    return count;
  }

  // 撤回(rewindSession)用:被丢弃回合里【模型自己起的】、仍在跑的后台 run 一并停掉 —— 起它的那句话对模型已经没发生过,跑完的信封只会让
  // 下一回合凭空多出一份通知(并且唤醒会把改写过的线程叫醒)。停法与托盘 / mission 里停一件同一个(stopRequested + abort + 记干预 + 追事件),
  // 并打 cancelledByRewind:09 deliverAgentRunEnvelope 据此不再给它投信封。用户在面板里自己起的 run 不动(不是被撤回的那句话起的);
  // 起它的回合没被撤回的 run 也不动(照常跑完,信封随用户下一句话送达)。返回停掉的件数。同步,零 await。
  function cancelModelRunsOfDiscardedTurns(sessionId, discardedTurnSeqs) {
    const discarded = discardedTurnSeqs instanceof Set ? discardedTurnSeqs : new Set(Array.isArray(discardedTurnSeqs) ? discardedTurnSeqs : []);
    let cancelled = 0;
    for (const live of activeAgentRuns.values()) {
      if (!live || !live.run || live.run.sessionId !== sessionId || live.closing || live.stopRequested) continue;
      if (live.run.launchedByModel !== true || !discarded.has(Number(live.run.turnSeq))) continue;
      try {
        live.run.cancelledByRewind = true;
        live.stopRequested = true;
        live.paused = false;
        try { if (live.ctrl) live.ctrl.abort(); } catch { /* best-effort */ }
        for (const wake of (Array.isArray(live.resumeWaiters) ? live.resumeWaiters.splice(0) : [])) { try { wake(); } catch { /* best-effort */ } }
        bumpRunIntervention(live.run, 'rewind_stop');
        appendAgentRunEvent(live.run, { type: 'run_stop_requested', data: { reason: 'rewind' } });
        saveAgentRun(live.run).catch(() => {});
        cancelled++;
      } catch { /* 停不掉也不挡撤回 */ }
    }
    if (cancelled) logEvent({ kind: 'rewind_cancel_agent_runs', sessionId, cancelled });
    return cancelled;
  }

  return { stopMissionAgentRuns, cancelModelRunsOfDiscardedTurns };
}

module.exports = { createSessionRunCancellation };
