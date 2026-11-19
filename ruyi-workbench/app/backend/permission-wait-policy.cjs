'use strict';

function createPermissionWaitPolicy() {

  const PermissionWaitHooks = {};
  // 2026-09-24「不限时」:配置 0(新默认)= 一直等。落到定时器上用一个【有限】的大数 —— setTimeout 超过
  // 2^31-1 ms 会当场触发(等于立刻拒),而 CLI 子进程那一侧(12)还要在它上面 +10 s 当 HTTP 预算,所以留足余量。
  // 界面按 PROMPT_DEADLINE_HORIZON_MS 判「这是不是一个真截止时刻」:超过一周的一律不显示倒计时。
  const PROMPT_WAIT_UNLIMITED_MS = 2147000000;   // ≈24.8 天,< 2^31-1 - 10 s
  const PROMPT_DEADLINE_HORIZON_MS = 7 * 24 * 3600 * 1000;
  function promptWaitMs(value, floorMs = 5000) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.min(PROMPT_WAIT_UNLIMITED_MS, Math.max(floorMs, n)) : PROMPT_WAIT_UNLIMITED_MS;
  }
  function promptDeadlineIsReal(deadlineAt, nowMs = Date.now()) {
    const at = Number(deadlineAt);
    return Number.isFinite(at) && at > 0 && at - nowMs <= PROMPT_DEADLINE_HORIZON_MS;
  }
  function permissionWaitMs(sessionId, config, sessionHead) {
    const base = promptWaitMs(config && config.permissionTimeoutMs);
    const sid = String(sessionId || '');
    try {
      const scheduled = typeof PermissionWaitHooks.scheduler === 'function' ? Number(PermissionWaitHooks.scheduler(sid)) : 0;
      if (Number.isFinite(scheduled) && scheduled > 0) return scheduled;
    } catch { /* 迟绑定缺席或抛错:当没有这一格 */ }
    try {
      const mediated = typeof PermissionWaitHooks.steward === 'function' ? Number(PermissionWaitHooks.steward(sid, config, sessionHead)) : 0;
      if (Number.isFinite(mediated) && mediated > 0) return Math.max(base, mediated);
    } catch { /* 同上 */ }
    return base;
  }
  // Questions are a real turn boundary, not a fire-and-forget notification. Both the Provider tool loop and
  // the Claude MCP bridge wait on this registry; /api/chat/answer settles exactly one matching entry.
  // v0.9-S5: pending PLAN approvals awaiting a UI decision (真流程 plan mode). Mirrors pendingPermissions:
  // planId -> { resolve, sessionId, timer }. runOpenAiTurn (plan mode, provider engine) emits a `plan` event
  // after the model's first PLAN: message and PAUSES the turn awaiting /api/plan/decision. resolve() settles
  // with { decision:'approve'|'reject', note? }; the timeout auto-rejects (same permissionTimeoutMs budget).
  // 第27f波:当前处于【无人值守(driverAuto)回合】的会话集 —— provider 路径直接用闭包 driverAuto,但 CLI 桥(Claude 子进程
  // loopback 的 /api/permission/request)拿不到 driverAuto,故用此集判定。runClaudeTurn 的 driverAuto 回合进出维护。纯内存。

  return { PermissionWaitHooks, permissionWaitMs, promptDeadlineIsReal, promptWaitMs };
}

module.exports = { createPermissionWaitPolicy };
