'use strict';

const { normalizeUserQuestions, normalizeQuestionContext } = require('./user-question-protocol.cjs');

function createSessionInterventionRuntime({
  activeChildren, decideInterventionCommand, killChildTree, logEvent, makeId, promptWaitMs,
  registerIntervention, settleIntervention, pending,
}) {
  const { pendingPermissions, pendingPlans, pendingQuestions } = pending;

  // 75b: automatic timeout/teardown decisions participate in the same per-Intervention CAS as user
  // decisions. The fallback is only for storage/core failure and must re-check the registry entry so a
  // concurrently applying user command can never be overwritten by a legacy settle.
  function runAutomaticInterventionDecision(command, fallback) {
    Promise.resolve()
      .then(() => decideInterventionCommand({ ...command, contractRequest: false, audit: false }))
      .then(result => { if (!result || result.status !== 200) fallback(); })
      .catch(() => fallback());
  }

  function clearPendingPermissions(sessionId, message) {
    for (const [rid, p] of pendingPermissions) {
      if (p.sessionId === sessionId) {
        if (p.commandApplying) continue; // 75b: command core owns resolve -> terminal -> registry cleanup ordering
        clearTimeout(p.timer);
        const note = String(message || 'session ended').slice(0, 500);
        runAutomaticInterventionDecision({
          missionId: sessionId, interventionId: rid, source: 'clear_permission', decidedBy: 'clear',
          idempotencyKey: `clear:${rid}`, payload: { action: 'deny', message: note },
        }, () => {
          if (pendingPermissions.get(rid) !== p || p.commandApplying) return;
          pendingPermissions.delete(rid);
          try { p.resolve({ behavior: 'deny', message: note }); } catch { /* already settled */ }
          settleIntervention(sessionId, rid, 'denied', { decidedBy: 'clear', note });
        });
      }
    }
  }

  function registerUserQuestion(sessionId, questionId, questions, onEvent, timeoutMs, deliver, context = '') {
    // Provider call ids are often reused as "call_1" across sessions, so never use them as registry keys.
    const sourceId = String(questionId || '');
    const id = makeId('question');
    const normalized = normalizeUserQuestions(questions);
    if (!normalized.length) return null;
    const questionContext = normalizeQuestionContext(context);
    const entry = { sessionId, questions: normalized, timer: null, deliver: null };
    entry.deliver = (answer, opts = {}) => {
      if (pendingQuestions.get(id) !== entry) return false;
      let accepted = false;
      try { accepted = deliver(answer) !== false; } catch { accepted = false; }
      if (!accepted) return false;
      clearTimeout(entry.timer);
      // 75b: decideIntervention owns the authoritative CAS row. It asks delivery to keep the registry entry
      // until terminal persistence and to skip the legacy side-ledger settle; timeout/teardown callers retain
      // the original self-contained behavior.
      if (opts.preserveRegistry !== true) pendingQuestions.delete(id);
      if (opts.skipInterventionSettle !== true) {
        settleIntervention(sessionId, id, answer && answer.ok !== false ? 'answered' : 'cancelled', { decidedBy: answer && answer.ok !== false ? 'user' : 'auto', note: answer && answer.content ? String(answer.content).slice(0, 500) : '' });
      }
      try {
        const summary = answer && answer.ok !== false
          ? String(answer.content || '').replace(/\s+/g, ' ').trim().slice(0, 500)
          : '';
        onEvent({ type: 'question_answer', questionId: id, ok: answer && answer.ok !== false, summary });
      } catch { /* a closed stream must not prevent the waiter from settling */ }
      return true;
    };
    entry.timer = null;
    // The timeout is re-armable: while the question modal stays open, UI heartbeats
    // (/api/question/heartbeat → extendUserQuestion) reset the deadline so composing a long
    // answer can never be cut off mid-way. The timer firing is the only backstop when the UI is gone.
    entry.armTimeout = () => {
      clearTimeout(entry.timer);
      entry.deadlineAt = Date.now() + entry.timeoutMs;
      entry.timer = setTimeout(() => {
        if (pendingQuestions.get(id) !== entry) return;
        const timeoutAnswer = { ok: false, answers: [], content: '(question timed out)' };
        runAutomaticInterventionDecision({
          missionId: sessionId, interventionId: id, source: 'timeout_question', decidedBy: 'timeout',
          idempotencyKey: `timeout:${id}`, payload: { action: 'answer', normalizedAnswer: timeoutAnswer },
        }, () => {
          if (pendingQuestions.get(id) === entry && !entry.commandApplying) entry.deliver(timeoutAnswer);
        });
      }, entry.timeoutMs);
    };
    entry.timeoutMs = promptWaitMs(timeoutMs);   // 0/缺省 = 不限时(见 promptWaitMs)
    entry.armTimeout();
    pendingQuestions.set(id, entry);
    onEvent({ type: 'ask_user', id, questionId: id, toolUseId: sourceId || undefined, questions: normalized, context: questionContext || undefined, deadlineAt: entry.deadlineAt, timeoutMs: entry.timeoutMs });
    registerIntervention(sessionId, 'question', id, {
      questionSummary: normalized.map(q => String(q.question || '').slice(0, 200)).join(' | '),
      questions: normalized,
      context: questionContext,
    });
    return id;
  }

  function requestUserQuestion(sessionId, questionId, questions, onEvent, timeoutMs, context = '') {
    return new Promise(resolve => {
      const id = registerUserQuestion(sessionId, questionId, questions, onEvent, timeoutMs, answer => { resolve(answer); return true; }, context);
      if (!id) resolve({ ok: false, answers: [], content: '', error: 'no valid questions' });
    });
  }

  // Heartbeat extension: the open question modal calls this periodically so a user composing a long
  // answer never hits the deadline. Returns the fresh deadline/timeout for the UI countdown, or null
  // when the question is gone (answered/timed out/cancelled) — the caller then stops its heartbeat.
  function extendUserQuestion(sessionId, questionId) {
    const entry = pendingQuestions.get(String(questionId || ''));
    if (!entry || entry.sessionId !== sessionId || entry.commandApplying) return null;
    try { entry.armTimeout(); } catch { return null; }
    return { deadlineAt: entry.deadlineAt, timeoutMs: entry.timeoutMs };
  }

  function clearPendingQuestions(sessionId, message) {
    for (const [qid, q] of pendingQuestions) {
      if (q.sessionId !== sessionId) continue;
      if (q.commandApplying) continue; // 75b: do not race the authoritative command-core terminal commit
      clearTimeout(q.timer);
      const cancelled = { ok: false, answers: [], content: message || 'session ended' };
      runAutomaticInterventionDecision({
        missionId: sessionId, interventionId: qid, source: 'clear_question', decidedBy: 'clear',
        idempotencyKey: `clear:${qid}`, payload: { action: 'answer', normalizedAnswer: cancelled },
      }, () => {
        if (pendingQuestions.get(qid) !== q || q.commandApplying) return;
        try { q.deliver(cancelled); } catch { /* already settled */ }
        pendingQuestions.delete(qid);
      });
    }
  }

  // 47a(Steer Phase A 分流纪律):会话当前是否有等待回答的 AskUser 提问。Claude 引擎的提问答案与插话同走
  // stdin user envelope —— 提问挂起期间注入插话,CLI 可能把插话误收为答案(串扰)。/api/steer 据此拒绝。
  function hasPendingQuestionForSession(sessionId) {
    for (const [, q] of pendingQuestions) if (q.sessionId === sessionId) return true;
    return false;
  }
  // 128f-⑪:权限请求挂着时同样豁免回合的 idle 看门狗(三处:09 provider、05 Claude CLI、05b Kimi)。修前权限窗口 120 s
  // 恒短于看门狗(默认 600 s),豁不豁免无所谓;定时线程的 30 分钟窗口早就被看门狗在 10 分钟处截断过(回合被当成「空闲」
  // 杀掉,而不是按拒绝收尾让模型接着说),管家盯着的线程 600 s 窗口则与看门狗同长、谁先到算谁。权限自己的计时器到点
  // 一定按拒绝落定,所以豁免不会让回合永远挂着。
  function hasPendingPermissionForSession(sessionId) {
    const sid = String(sessionId || '');
    for (const [, p] of pendingPermissions) if (p && p.sessionId === sid) return true;
    return false;
  }

  // v0.9-S5: clear any pending PLAN approvals for a session (abort/stop/turn-end), resolving each as a REJECT
  // so the paused runOpenAiTurn unblocks and finishes cleanly (never left hanging). Mirrors
  // clearPendingPermissions — called from stopSession (abort/stop) and at turn end.
  function clearPendingPlans(sessionId, message) {
    for (const [pid, p] of pendingPlans) {
      if (p.sessionId === sessionId) {
        if (p.commandApplying) continue; // 75b: command core clears after terminal persistence
        clearTimeout(p.timer);
        const note = message || 'session ended';
        runAutomaticInterventionDecision({
          missionId: sessionId, interventionId: pid, source: 'clear_plan', decidedBy: 'clear',
          idempotencyKey: `clear:${pid}`, payload: { action: 'reject', feedback: note },
        }, () => {
          if (pendingPlans.get(pid) !== p || p.commandApplying) return;
          pendingPlans.delete(pid);
          try { p.resolve({ decision: 'reject', note }); } catch { /* already settled */ }
        });
      }
    }
  }

  function stopSession(sessionId, reason = 'stopped') {
    const entry = activeChildren.get(sessionId);
    clearPendingPermissions(sessionId, `turn ${reason}`);
    clearPendingQuestions(sessionId, `turn ${reason}`);
    clearPendingPlans(sessionId, `turn ${reason}`); // v0.9-S5: unblock a paused plan-mode turn on abort/stop (reject semantics)
    if (!entry) return false;
    entry.state = reason;
    // Prefer the live ChildProcess handle; only fall back to taskkill by pid while the child is alive,
    // so we never force-kill a recycled PID.
    if (typeof entry.abort === 'function') {
      // Native (openai) engine: no child process — abort the in-flight fetch instead of taskkill.
      entry.exited = true;
      try { entry.abort(); } catch { /* ignore */ }
    } else if (!entry.exited && entry.child && entry.child.exitCode === null) {
      entry.exited = true;
      entry.cleanup = killChildTree(entry.child);
      if (entry.cleanup && entry.cleanup.incomplete && typeof entry.onEvent === 'function') {
        try { entry.onEvent({ type: 'stderr', text: '[子进程清理尚未确认完成]\n' }); } catch { /* observer closed */ }
      }
    }
    activeChildren.delete(sessionId);
    logEvent({ kind: 'turn_kill', sessionId, reason, ...(entry.cleanup ? { cleanupScope: entry.cleanup.scope, cleanupIncomplete: entry.cleanup.incomplete === true } : {}) });
    return true;
  }

  return { clearPendingPermissions, runAutomaticInterventionDecision, clearPendingPlans, clearPendingQuestions, extendUserQuestion, hasPendingPermissionForSession, hasPendingQuestionForSession, registerUserQuestion, requestUserQuestion, stopSession };
}

module.exports = { createSessionInterventionRuntime };
