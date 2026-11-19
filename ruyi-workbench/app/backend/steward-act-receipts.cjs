'use strict';

const crypto = require('node:crypto');

function createStewardActReceipts({
  OVERLAY_ID, STEWARD_ACTION_HOOKS, StewardHooks, ensureStewardSession, logEvent, safeSessionId, stewardFail,
  stewardSanitizeText,

}) {


  // ────────────────────────────────────────────────────────────────────────────
  // acts 落定:用户点了一个按钮。tool 走 13g 的同一实现(同一门控、同一决策日志),
  // dismiss 只记一行日志,open_thread 只回 sessionId(切换由 UI 完成)。
  // ────────────────────────────────────────────────────────────────────────────
  // 62 号第三轮 P1（失败与迟到响应保护）：递话超时后重发前要先核对上一次的回执。前端为「这一次递话」
  // 生成一个 attemptId，同一个 attemptId 只执行一次；`check` 是只读回执查询，永远不会再次执行。
  // 账本只在内存、有界、十分钟过期：进程重启后旧 attemptId 不再等于「已执行」——界面本来就只说「未确认」。
  const STEWARD_ACT_ATTEMPT_LIMITS = Object.freeze({ entries: 256, ttlMs: 10 * 60 * 1000 });
  const stewardActAttempts = new Map();   // attemptId -> { at, result }
  const stewardActInflight = new Map();   // attemptId -> { signature, promise }：并发同 id 共用一次执行
  let stewardActReceiptFloor = 0; // Missing receipts older than any eviction cannot prove non-execution.
  function stewardActAttemptId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : '';
  }
  function stewardActAttemptPrune(now) {
    const forget = id => { stewardActReceiptFloor = Math.max(stewardActReceiptFloor, stewardActAttempts.get(id).at); stewardActAttempts.delete(id); };
    for (const [id, row] of stewardActAttempts) if (now - row.at > STEWARD_ACT_ATTEMPT_LIMITS.ttlMs) forget(id);
    while (stewardActAttempts.size > STEWARD_ACT_ATTEMPT_LIMITS.entries) forget(stewardActAttempts.keys().next().value);
  }
  async function stewardRunAct(act, config, attempt) {
    const attemptId = stewardActAttemptId(attempt && attempt.attemptId);
    const check = Boolean(attempt && attempt.check === true);
    // 回执查询必须带合法 attemptId：否则它会被当成一次真实执行（那正是「核对」绝不能做的事）。
    if (check && !attemptId) return stewardFail('invalid_request', 'checkAttempt needs a valid attemptId');
    const now = Date.now();
    const window = attempt && attempt.window;
    if (window && !attemptId) return stewardFail('invalid_request', 'attemptWindow needs a valid attemptId');
    const sameInstance = window && window.serverInstanceId === OVERLAY_ID;
    const validWindow = sameInstance && Number.isFinite(window.issuedAt) && Number.isFinite(window.expiresAt) && window.issuedAt <= now && window.expiresAt === window.issuedAt + STEWARD_ACT_ATTEMPT_LIMITS.ttlMs && now < window.expiresAt;
    const signature = attemptId && !check ? crypto.createHash('sha256').update(JSON.stringify(act ?? null)).digest('hex') : '';
    if (attemptId) {
      stewardActAttemptPrune(now);
      const prior = stewardActAttempts.get(attemptId);
      // 只读回执：告诉前端「这一次到底执行过没有」，绝不触发第二次执行。
      if (check) {
        const inflight = stewardActInflight.has(attemptId);
        const known = !window || sameInstance;
        const state = known && prior ? 'applied' : known && inflight ? 'inflight' : validWindow && window.issuedAt > stewardActReceiptFloor ? 'not_applied' : 'unknown';
        return { ok: true, kind: 'attempt_check', applied: state === 'applied' ? true : state === 'not_applied' || !window ? false : null, state,
          serverInstanceId: OVERLAY_ID, window: { serverInstanceId: OVERLAY_ID, issuedAt: now, expiresAt: now + STEWARD_ACT_ATTEMPT_LIMITS.ttlMs }, ...(state === 'applied' ? { executedAt: new Date(prior.at).toISOString() } : {}) };
      }
      if (window && !sameInstance) return stewardFail('attempt_unknown', '服务已重启，请先核对目标任务；这次递送不会自动重发');
      if (prior) {
        if (prior.signature !== signature) return stewardFail('invalid_request', '这次递送的目标或内容已变化,请作为新的一次发送');
        return { ...prior.result, replayed: true, executedAt: new Date(prior.at).toISOString() };
      }
      // 先查后写之间隔着真实 I/O：同一 attemptId 的并发请求必须共用同一次执行，不能各自跑一遍。
      const inflight = stewardActInflight.get(attemptId);
      if (inflight) {
        if (inflight.signature !== signature) return stewardFail('invalid_request', '这次递送的目标或内容已变化,请作为新的一次发送');
        return { ...await inflight.promise, replayed: true };
      }
      if (window && (!validWindow || window.issuedAt <= stewardActReceiptFloor)) return stewardFail('attempt_unknown', '回执窗口已失效，请先核对目标任务；不能证明这次尚未执行');
    }
    const run = stewardRunActOnce(act, config);
    if (!attemptId) return run;
    // 执行前先占用 attemptId，并发的那一份 await 同一条链；只有真的执行成功才落账，失败不占 id。
    const shared = run.then(result => {
      if (result && result.ok === true && result.executed !== false) {
        stewardActAttempts.set(attemptId, { at: Date.now(), result, signature });
        stewardActAttemptPrune(Date.now());
      }
      return result;
    }).finally(() => {
      if (stewardActInflight.get(attemptId)?.promise === shared) stewardActInflight.delete(attemptId);
    });
    stewardActInflight.set(attemptId, { signature, promise: shared });
    return shared;
  }
  async function stewardRunActOnce(act, config) {
    const raw = (act && typeof act === 'object') ? act : {};
    const kind = String(raw.kind || (raw.tool ? 'tool' : ''));
    if (kind === 'dismiss') {
      logEvent({ kind: 'steward_act_dismissed', label: String(raw.label || '').slice(0, 40) });
      return { ok: true, kind: 'dismiss' };
    }
    if (kind === 'open_thread') {
      const sid = safeSessionId(raw.sessionId);
      if (!sid) return stewardFail('invalid_request', 'open_thread act needs a valid sessionId');
      return { ok: true, kind: 'open_thread', sessionId: sid };
    }
    if (kind !== 'tool') return stewardFail('invalid_request', `unknown act kind: ${stewardSanitizeText(kind)}`);
    const tool = String(raw.tool || '');
    const hookKey = STEWARD_ACTION_HOOKS[tool];
    if (!hookKey) return stewardFail('not_allowed', `${stewardSanitizeText(tool)} 不能作为 act 执行`);
    const ensured = await ensureStewardSession(config);
    if (!ensured.ok) return stewardFail(ensured.error, ensured.message || 'steward engine is unsupported');
    const args = (raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)) ? raw.args : {};
    // 用户【亲自】按下的按钮:自理清单不适用(那是「管家该不该主动做」的清单),但目标线程权限与
    // 永久豁免清单照旧由 13g 内部裁决 —— 管家不会因为用户点了一下就获得放宽权限的能力。
    // 116-2e:`userPressed` 的【唯一】来源就是这一行 —— 用户在界面上亲手按下了这个按钮。
    // 只有 steward_config_set 与 steward_skill_toggle 的「须确认」判定读它;stewardMayAct、
    // 永久豁免清单与线程权限判定一概不读(06i 契约注释与 steward-tools.static ⑦ 机械看住)。
    // 116-3 P0-2:trigger:'user' —— 用户就站在这个按钮前面,线程族的「无人值守」闸门不适用。
    // 它与 userPressed 是两件不同的事:trigger 说的是「用户在不在场」,userPressed 说的是
    // 「这一次配置改动是不是用户亲手按的」,后者的读者只有 config_set / skill_toggle 两处(06i 契约)。
    const result = await StewardHooks[hookKey](args, { session: ensured.session, sessionId: ensured.session.id, config, trigger: 'user', userPressed: true });
    // 按钮【被执行了】就是 ok:true —— 工具自己的稳定信封(propose_required / not_found / version_conflict …)
    // 原样放在 result 里交给界面去说人话。只有 act 本身不合法(未知 kind、非管家工具、开关关)才是 4xx:
    // 把「工具说不行」翻译成 HTTP 错误会让前端分不清「按钮坏了」和「这件事不该这么做」。
    return { ok: true, kind: 'tool', tool, executed: !!(result && result.ok !== false), result };
  }

  return {
    stewardRunAct,
  };
}

module.exports = { createStewardActReceipts };
