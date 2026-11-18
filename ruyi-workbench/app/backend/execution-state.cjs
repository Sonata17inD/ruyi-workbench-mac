'use strict';
// Per-workbench execution registries. Maps retain identity across admission, stop and final persistence.
function createExecutionState() {
  return Object.freeze({
    sessionWriteChains: new Map(),
    activeChildren: new Map(),
    turnSettlers: new Map(),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    pendingPlans: new Map(),
    activeAgentRuns: new Map(),
  });
}

// 每回合配额的回合键(observation_recall 与管家深读预算共用):优先 turnSeq(09 在回合开始时定好,回合内稳定,
// 压缩不动它)。修前用「providerHistory 里 user 消息条数」—— L2 重播种把历史换成「摘要 user + 尾部」,条数一变
// 配额桶就换了一个,回合内的配额随每次压缩清零,恰好让「recall → 压掉 → 再 recall」绕过配额。
function providerTurnQuotaKey(session) {
  const seq = Number(session && session.turnSeq);
  if (Number.isFinite(seq) && seq > 0) return 't' + seq;
  const history = Array.isArray(session && session.providerHistory) ? session.providerHistory : [];
  return 'u' + history.reduce((n, m) => n + (m && m.role === 'user' ? 1 : 0), 0);
}

module.exports = { createExecutionState, providerTurnQuotaKey };
