'use strict';
const { BRIDGED_WRITE_PATH_ARGS } = require('./bridged-write-targets.cjs');
const { unprefixedBridgedName } = require('./turn-effect-kinds.cjs');

function createNativeApprovalWaiters({ pending, interventions, timers = globalThis }) {
  const { pendingPermissions, pendingPlans } = pending;
  const { setTimeout, clearTimeout } = timers;
  const {
    makeId, promptWaitMs, registerIntervention, runAutomaticInterventionDecision, settleIntervention,
  } = interventions;

  // v0.8-S4b B3: which tools produce a change that the checkpoint journal can undo? Exactly the journaled
  // file mutations (file_write/file_edit/file_delete → create/modify/delete `before` snapshots). Everything
  // else (exec, desktop, network) leaves no journal entry → not auto-revertible. The permission popup shows
  // this at the DECISION moment (「✓ 此操作可一键撤销」/「⚠ 此操作无法自动撤销」) — an after-the-fact undo
  // card can't reassure a user who was scared off before allowing. Kept as a small set so the UI needn't
  // duplicate the tier table; the event carries the boolean directly.
  // v1.1-W2 (T1): move/copy/zip/unzip/download 全部走 journalRecord 存 before 快照 → 可撤销，进 REVERTIBLE。
  // 名字级承诺(与内建文件工具同保真度):实际快照仍可能因越界/超限被跳过,届时该条在「本轮变更」卡上回落为不可撤销。
  const REVERTIBLE_TOOLS = new Set(['file_write', 'file_edit', 'file_delete', 'file_move', 'file_copy', 'archive_zip', 'archive_unzip', 'http_download']);
  function toolIsRevertible(toolName) {
    const n = String(toolName || '');
    if (REVERTIBLE_TOOLS.has(n)) return true;
    // v1.0.2-W1.5 把关补:bridged 写族(ACC write_docx/write_excel/write_pdf/write_file/delete_file)现已由
    // journalBridgedWrite 在分发前存 before 快照 → 权限弹窗的可撤销徽章与「本轮变更」卡(journal 驱动)对齐。
    // 与内建工具同保真度:名字级承诺(实际快照仍可能因越界/超限被跳过,届时该条在变更卡上回落为不可撤销)。
    return Object.prototype.hasOwnProperty.call(BRIDGED_WRITE_PATH_ARGS, unprefixedBridgedName(n));
  }
  // ── 第 123 波 M1 §3.2「无人值守的 ask」(37 号文;29 号文 §10 红线二)────────────────────────────
  // 定时任务派出去的回合没人守着,120 s 的决定窗口对它毫无意义 —— 用户可能几小时后才回来。
  // 于是调度器(13s)在派单前后【成对】写/清这张表,把这一条会话的「等多久」换成
  // config.schedulerAskWaitMinutes(默认 30 分钟,钳 [1,240];测试旗 WCW_SCHEDULER_ASK_WAIT_MS 压到毫秒)。
  //
  // **只改「等多久」,不改「等到了怎么判」**(子集律):到时仍然走下面那条既有的
  // runAutomaticInterventionDecision(action:'deny') —— 无人值守遇 ask 永远是拒,绝不自动放行。
  // 这张表也【不】参与 nativeToolGate 的任何判定:它够不着 gate,只够得着 setTimeout 的那个数。
  // 表是进程内的,重启即空;调度器在 finally 里删,所以一条被换过窗口的会话不会把这个值带到
  // 用户后来手动发起的回合上。
  const schedulerAskWaitSessions = new Map();   // sessionId -> ms(只由 13s 写)
  function schedulerAskWaitOverrideMs(schedAskSessionId) {
    const ms = Number(schedulerAskWaitSessions.get(String(schedAskSessionId || '')));
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }
  // Ask the UI to approve a native tool call — reuses the pendingPermissions + /api/permission/decision bridge.
  // v0.8-S4b: the permission_request event now also carries `tier` (read|edit|exec) and `revertible` (bool)
  // so the popup can render a risk badge + a plain-language revertibility line without re-deriving them.
  // 第27f波:pause = { enabled, ttlMs, onPause(requestId) } —— 无人值守回合的权限超时【存档暂停】。基础超时到点后不立即拒杀,
  // 而是打检查点(onPause)+ 发 permission_paused 事件 + 把决定窗口延长到 ttlMs;窗口内仍可经 /api/permission/decision 决定,
  // 到 ttlMs 无人应答则回落 deny(fail-closed)。entry.timer 在 Map 里被重赋为 TTL 定时器,故 clearPendingPermissions/decision 照常清对。
  function requestNativePermission(sessionId, toolName, input, onEvent, timeoutMs, tier, pause) {
    return new Promise(resolve => {
      const requestId = makeId('perm');
      onEvent({ type: 'permission_request', requestId, toolName, input, tier: tier || 'exec', revertible: toolIsRevertible(toolName) });
      registerIntervention(sessionId, 'permission', requestId, {
        toolName: String(toolName || ''), tier: tier || 'exec', revertible: toolIsRevertible(toolName),
        // Wave 81: persist the concrete scope shown by the classic prompt so a cross-session
        // decision never degrades into a context-free approval.
        input: input && typeof input === 'object' && !Array.isArray(input) ? input : {},
      });
      let settled = false;
      const settle = (decision, opts = {}) => {
        if (settled) return;
        settled = true;
        // 75b command-core callers persist the CAS terminal row themselves. Automatic timeout/teardown
        // callers omit this flag and keep the legacy self-settling behavior.
        if (opts.skipInterventionSettle !== true) {
          settleIntervention(sessionId, requestId, decision && decision.behavior === 'allow' ? 'allowed' : 'denied', { decidedBy: decision && decision.behavior === 'allow' ? 'user' : 'auto', note: decision && decision.message ? String(decision.message).slice(0, 500) : '' });
        }
        try { onEvent({ type: 'permission_decision', requestId, behavior: decision && decision.behavior === 'allow' ? 'allow' : 'deny', message: decision && decision.message }); } catch { /* stream gone */ }
        resolve(decision);
      };
      // 128f-⑪:调用方传进来的 timeoutMs 已经是 permissionWaitMs 的结果(09／05b);定时那一格在这里再认一次是双保险。
      const baseMs = schedulerAskWaitOverrideMs(sessionId) || promptWaitMs(timeoutMs);   // 0 = 不限时(04 promptWaitMs)
      // deadlineAt:13q 的 steward.deferred 要告诉用户「还等你多久」(存档暂停那一支延长后另算,见下)。
      const entry = { resolve: settle, sessionId, timer: null, deadlineAt: Date.now() + baseMs };
      if (pause && pause.enabled) {
        entry.timer = setTimeout(() => {
          try { if (pause.onPause) pause.onPause(requestId); } catch { /* 检查点失败不阻断 */ }
          try { onEvent({ type: 'permission_paused', requestId, toolName, tier: tier || 'exec', ttlMs: pause.ttlMs }); } catch { /* stream gone */ }
          entry.deadlineAt = Date.now() + Math.max(60000, Number(pause.ttlMs) || 2700000);   // 128f-⑪:存档暂停把窗口延长了
          entry.timer = setTimeout(() => {
            const message = '权限已存档暂停但在时限内无人决定,已回落拒绝';
            runAutomaticInterventionDecision({
              missionId: sessionId, interventionId: requestId, source: 'timeout_permission', decidedBy: 'timeout',
              idempotencyKey: `timeout:${requestId}`, payload: { action: 'deny', message },
            }, () => {
              if (pendingPermissions.get(requestId) !== entry || entry.commandApplying) return;
              pendingPermissions.delete(requestId);
              settle({ behavior: 'deny', message, pausedTimeout: true });
            });
          }, Math.max(60000, Number(pause.ttlMs) || 2700000));
        }, baseMs);
      } else {
        entry.timer = setTimeout(() => {
          const message = 'permission prompt timed out';
          runAutomaticInterventionDecision({
            missionId: sessionId, interventionId: requestId, source: 'timeout_permission', decidedBy: 'timeout',
            idempotencyKey: `timeout:${requestId}`, payload: { action: 'deny', message },
          }, () => {
            if (pendingPermissions.get(requestId) !== entry || entry.commandApplying) return;
            pendingPermissions.delete(requestId);
            settle({ behavior: 'deny', message });
          });
        }, baseMs);
      }
      pendingPermissions.set(requestId, entry);
    });
  }

  // v0.9-S5: does a first assistant message look like a PLAN? Tolerant: strip leading whitespace, then accept
  // `PLAN:` (any case) or the Chinese 「计划:」/「计划：」. Returns true so the caller enters the plan pause; a
  // non-matching first answer falls back to the legacy hard-block plan behavior (backward compatible).
  function looksLikePlan(text) {
    const t = String(text || '').replace(/^\s+/, '');
    return /^plan\s*[:：]/i.test(t) || /^计划\s*[:：]/.test(t);
  }
  // v0.9-S5: emit a `plan` event and PAUSE the turn until the UI decides (or the timeout auto-rejects). Mirrors
  // requestNativePermission but on the plan channel. Resolves { decision:'approve'|'reject', note? }. The
  // timeout is REJECT (per spec: 超时=permissionTimeoutMs → 视为 reject). clearPendingPlans (abort/stop/turn-end)
  // also settles the promise as reject so the awaiting loop can never hang.
  function requestPlanApproval(sessionId, markdown, onEvent, timeoutMs) {
    return new Promise(resolve => {
      const planId = makeId('plan');
      onEvent({ type: 'plan', planId, markdown: String(markdown || '') });
      registerIntervention(sessionId, 'plan', planId, { planSummary: String(markdown || '').slice(0, 500) });
      let settled = false;
      const settle = (decision, opts = {}) => {
        if (settled) return;
        settled = true;
        if (opts.skipInterventionSettle !== true) {
          settleIntervention(sessionId, planId, decision && decision.decision === 'approve' ? 'approved' : 'rejected', { decidedBy: decision && decision.decision === 'approve' ? 'user' : 'auto', note: decision && decision.note ? String(decision.note).slice(0, 500) : '' });
        }
        try { onEvent({ type: 'plan_decision', planId, decision: decision && decision.decision === 'approve' ? 'approve' : 'reject', note: decision && decision.note }); } catch { /* stream gone */ }
        resolve(decision);
      };
      const timer = setTimeout(() => {
        const note = 'plan approval timed out';
        const entry = pendingPlans.get(planId);
        runAutomaticInterventionDecision({
          missionId: sessionId, interventionId: planId, source: 'timeout_plan', decidedBy: 'timeout',
          idempotencyKey: `timeout:${planId}`, payload: { action: 'reject', feedback: note },
        }, () => {
          if (pendingPlans.get(planId) !== entry || (entry && entry.commandApplying)) return;
          pendingPlans.delete(planId);
          settle({ decision: 'reject', note });
        });
        // 123-M1:计划审批与权限请求同一条口径 —— 无人值守回合等 schedulerAskWaitMinutes,到时仍是【拒】。
      }, schedulerAskWaitOverrideMs(sessionId) || promptWaitMs(timeoutMs));   // 0 = 不限时(04 promptWaitMs)
      pendingPlans.set(planId, { resolve: settle, sessionId, timer, markdown: String(markdown || '') });
    });
  }

  return { toolIsRevertible, schedulerAskWaitSessions, schedulerAskWaitOverrideMs, requestNativePermission, looksLikePlan, requestPlanApproval };
}

module.exports = { createNativeApprovalWaiters };
