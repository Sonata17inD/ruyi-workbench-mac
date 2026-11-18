'use strict';

const crypto = require('node:crypto');
const { normalizeQuestionAnswer } = require('./user-question-protocol.cjs');

function canonicalDecisionValue(value, depth = 0) {
  if (depth > 24 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => canonicalDecisionValue(v, depth + 1));
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalDecisionValue(value[key], depth + 1);
  return out;
}

function interventionDecisionFingerprint(missionId, interventionId, payload) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalDecisionValue({ missionId, interventionId, payload })), 'utf8')
    .digest('hex');
}

function interventionCommandFailure(reason, status, params = {}, message = '') {
  return {
    status,
    body: {
      ok: false,
      reason,
      error: {
        code: `intervention.${reason}`,
        params: params && typeof params === 'object' && !Array.isArray(params) ? params : {},
        ...(message ? { message } : {}),
      },
    },
  };
}

function normalizeContractQuestionDecision(payload, questions) {
  const rows = payload && payload.answer && Array.isArray(payload.answer.answers)
    ? payload.answer.answers
    : null;
  const known = Array.isArray(questions) ? questions : [];
  if (!rows || rows.length !== known.length || rows.length < 1 || rows.length > 3) {
    return { ok: false, message: 'answer.answers must contain exactly one answer for each question' };
  }
  const byId = new Map(known.map(q => [String(q && q.id || ''), q]));
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') return { ok: false, message: 'each answer must be an object' };
    if (Object.keys(row).some(key => !['questionId', 'selectedOptionIds', 'otherText'].includes(key))) {
      return { ok: false, message: 'answer contains fields outside the typed question contract' };
    }
    const questionId = String(row.questionId || '');
    const question = byId.get(questionId);
    if (!question || seen.has(questionId)) return { ok: false, message: 'questionId is unknown or duplicated' };
    seen.add(questionId);
    if (!Array.isArray(row.selectedOptionIds)) return { ok: false, message: 'selectedOptionIds must be an array' };
    if (row.selectedOptionIds.some(id => typeof id !== 'string')) return { ok: false, message: 'selectedOptionIds must contain strings' };
    if (row.otherText !== undefined && typeof row.otherText !== 'string') return { ok: false, message: 'otherText must be a string' };
    const selected = row.selectedOptionIds.map(x => String(x || '')).filter(Boolean);
    if (selected.length !== new Set(selected).size || selected.length > 12) return { ok: false, message: 'selectedOptionIds contains duplicates or too many values' };
    const optionIds = new Set((Array.isArray(question.options) ? question.options : []).map(o => String(o && o.id || '')));
    if (selected.some(id => !optionIds.has(id))) return { ok: false, message: 'selectedOptionIds contains an option outside this question' };
    const otherText = String(row.otherText || '').trim();
    const mode = String(question.answerMode || (question.multiSelect ? 'multiple' : 'single'));
    if (mode === 'single' && selected.length > 1) return { ok: false, message: 'single-choice question accepts at most one option' };
    if (mode === 'text' && selected.length) return { ok: false, message: 'text question does not accept selectedOptionIds' };
    if (otherText && mode !== 'text' && question.allowOther !== true) return { ok: false, message: 'otherText is not allowed for this question' };
    if (!selected.length && !otherText) return { ok: false, message: 'each question requires an answer' };
  }
  return { ok: true, answer: normalizeQuestionAnswer({ answers: rows }, known) };
}

function mapInterventionTransitionFailure(result) {
  const reason = String(result && result.reason || 'decision_failed');
  if (reason === 'not_found') return interventionCommandFailure(reason, 404, {}, 'mission or intervention not found');
  if (reason === 'expired') return interventionCommandFailure(reason, 410, { status: result.status || '' }, 'intervention has expired');
  if (reason === 'version_conflict') {
    return interventionCommandFailure(reason, 409, {
      expectedVersion: result.expectedVersion,
      actualVersion: result.actualVersion,
    }, 'intervention version does not match');
  }
  if (reason === 'idempotency_conflict') {
    return interventionCommandFailure(reason, 409, {}, 'idempotencyKey was already used for a different request');
  }
  if (reason === 'already_terminal') {
    return interventionCommandFailure(reason, 409, {
      status: result.status || '',
      interventionVersion: Number(result.interventionVersion) || 0,
    }, 'intervention is already terminal');
  }
  if (reason === 'not_pending') {
    return interventionCommandFailure(reason, 409, { status: result.status || '' }, 'intervention is already being applied');
  }
  if (reason === 'persist_failed') return interventionCommandFailure(reason, 503, {}, 'could not record the decision on disk; nothing was applied, try again');
  if (reason === 'terminal_persist_failed') return interventionCommandFailure(reason, 503, {
    status: result.status || 'applying', interventionVersion: Number(result.interventionVersion) || 0, outcomeUnknown: true,
  }, 'the action ran, but its final state could not be recorded; inspect the execution result before taking further action');
  return interventionCommandFailure(reason, 409, {
    ...(result && result.runId ? { runId: result.runId } : {}),
  }, String(result && result.message || 'intervention cannot be delivered'));
}

// All entry points share one owner for validation, delivery and the persistent CAS.
function createInterventionDecisions({
  safeSessionId, makeId, readSessionHeadResilient, sessionMissionId, readInterventions,
  transitionInterventionState, pendingPermissions, pendingQuestions, pendingPlans, logEvent,
}) {
  async function decideInterventionCommand(command = {}, createAgentAction) {
    const rawMissionId = String(command.missionId || '');
    const missionId = safeSessionId(rawMissionId);
    const interventionId = String(command.interventionId || '');
    const source = String(command.source || 'contract').slice(0, 64);
    const contractRequest = command.contractRequest !== false;
    const payload = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
      ? command.payload
      : {};
    if (!missionId || missionId !== rawMissionId || !/^[A-Za-z0-9_-]{1,160}$/.test(interventionId)) {
      return interventionCommandFailure('invalid_request', 400, {}, 'invalid missionId or interventionId');
    }
    // 117j 收尾：这一发读【必须】走带瞬时重试的那一个。它是用户动作的判定入口 —— 读空一次就等于
    // 把「允许／回答」当场判成 404「会话不存在」，而真相只是回合正好在写头（见 02 的头注）。
    const head = await readSessionHeadResilient(missionId);
    // 117e 第 0 步(116g 引入的真 bug):这道门在 116g 之前是恒等式 —— 会话没挂进显式事项容器时
    // sessionMissionId(head) 就回落成 head.id,而 head 正是按 `sessionPath(missionId)` 读出来的。
    // 116g 的 missionAttachThread 把 session.missionId 改写成【容器 id】之后,同一条会话再按自己的
    // id 来答待决就恒判 not_found —— /api/chat/answer、/api/permission/decision、/api/plan/decision
    // 三条兼容适配器与 steward_decide 传的都是 sessionId,于是「凡是进了多线程事项的线程,问题/权限/
    // 计划都答不进去」(经典壳同样受影响)。
    // 修法:把「missionId 等于该会话自身 id」显式认作合法别名(容器 id 仍照旧受理,只是那个 id 上
    // 没有会话文件,读不出 head 就仍然 404)。**不放宽**「跨会话答别人的待决」:待决本体在下面按
    // `readInterventions(missionId)` 从这条会话自己的旁路账里取,并再核一次 `current.sessionId ===
    // missionId`;拿会话 A 的 id 去答会话 B 的待决,那两道判定照旧拦下。
    const headSelfId = String((head && head.id) || '');
    if (!head || (sessionMissionId(head) !== missionId && headSelfId !== missionId)) {
      return interventionCommandFailure('not_found', 404, {}, 'mission or intervention not found');
    }

    if (contractRequest) {
      if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 0) {
        return interventionCommandFailure('invalid_request', 400, { field: 'expectedVersion' }, 'expectedVersion must be a non-negative integer');
      }
      const key = String(command.idempotencyKey || '');
      if (!key || key.length > 128) {
        return interventionCommandFailure('invalid_request', 400, { field: 'idempotencyKey' }, 'idempotencyKey must contain 1-128 characters');
      }
    }

    const current = (await readInterventions(missionId).catch(() => []))
      .find(iv => iv && String(iv.id) === interventionId);
    if (!current || String(current.sessionId || missionId) !== missionId) {
      return interventionCommandFailure('not_found', 404, {}, 'mission or intervention not found');
    }

    const type = String(current.type || '');
    const action = String(payload.action || '');
    if (contractRequest) {
      const commonFields = new Set(['expectedVersion', 'idempotencyKey', 'action']);
      const typeFields = type === 'permission' ? ['updatedInput', 'scope']
        : type === 'question' ? ['answer']
          : type === 'plan' ? ['feedback']
            : [];
      const allowed = new Set([...commonFields, ...typeFields]);
      const unknown = Object.keys(payload).filter(key => !allowed.has(key));
      if (unknown.length) return interventionCommandFailure('payload_invalid', 400, { fields: unknown }, 'request contains fields outside the type/action contract');
    }
    let toStatus = '';
    let normalizedAnswer = null;
    if (type === 'permission') {
      if (action !== 'allow' && action !== 'deny') return interventionCommandFailure('action_invalid', 400, { type }, 'permission action must be allow or deny');
      if (action === 'allow' && payload.updatedInput !== undefined && (!payload.updatedInput || typeof payload.updatedInput !== 'object' || Array.isArray(payload.updatedInput))) {
        return interventionCommandFailure('payload_invalid', 400, { field: 'updatedInput' }, 'updatedInput must be an object');
      }
      if (payload.scope !== undefined && payload.scope !== 'session') {
        return interventionCommandFailure('payload_invalid', 400, { field: 'scope' }, 'scope must be session when provided');
      }
      toStatus = action === 'allow' ? 'allowed' : 'denied';
    } else if (type === 'question') {
      if (action !== 'answer') return interventionCommandFailure('action_invalid', 400, { type }, 'question action must be answer');
      if (contractRequest) {
        const normalized = normalizeContractQuestionDecision(payload, current.questions);
        if (!normalized.ok) return interventionCommandFailure('payload_invalid', 400, { type }, normalized.message);
        normalizedAnswer = normalized.answer;
      } else {
        normalizedAnswer = payload.normalizedAnswer;
        if (!normalizedAnswer || typeof normalizedAnswer !== 'object') return interventionCommandFailure('payload_invalid', 400, { type }, 'question answer is required');
      }
      toStatus = normalizedAnswer.ok === false ? 'cancelled' : 'answered';
    } else if (type === 'plan') {
      if (action !== 'approve' && action !== 'reject') return interventionCommandFailure('action_invalid', 400, { type }, 'plan action must be approve or reject');
      if (contractRequest && payload.feedback !== undefined && typeof payload.feedback !== 'string') {
        return interventionCommandFailure('payload_invalid', 400, { field: 'feedback' }, 'feedback must be a string');
      }
      toStatus = action === 'approve' ? 'approved' : 'rejected';
    } else if (type === 'pool') {
      if (action !== 'approve' && action !== 'reject') return interventionCommandFailure('action_invalid', 400, { type }, 'pool action must be approve or reject');
      toStatus = action === 'approve' ? 'approved' : 'rejected';
    } else if (type === 'replan') {
      if (action !== 'approve' && action !== 'reject') return interventionCommandFailure('action_invalid', 400, { type }, 'replan action must be approve or reject');
      toStatus = action === 'approve' ? 'approved' : 'rejected';
    } else {
      return interventionCommandFailure('type_unsupported', 409, { type }, 'intervention type is not supported by this release');
    }

    const idempotencyKey = String(command.idempotencyKey || makeId('legacy')).slice(0, 128);
    const decisionPayload = type === 'question'
      ? { action, answer: normalizedAnswer }
      : type === 'permission'
        ? { action, ...(action === 'allow' && payload.updatedInput !== undefined ? { updatedInput: payload.updatedInput } : {}), ...(action === 'allow' && payload.scope === 'session' ? { scope: 'session' } : {}) }
        : type === 'plan'
          ? { action, ...(payload.feedback !== undefined ? { feedback: String(payload.feedback) } : {}) }
          : { action };
    const decisionFingerprint = interventionDecisionFingerprint(missionId, interventionId, decisionPayload);
    let runtimeEntry = null;
    const agentAction = type === 'pool' || type === 'replan'
      ? createAgentAction?.({ type, action, missionId, interventionId, command })
      : null;

    const preflight = async authoritative => {
      if (!authoritative || String(authoritative.type || '') !== type) return { ok: false, reason: 'not_found' };
      if (type === 'permission') {
        runtimeEntry = pendingPermissions.get(interventionId);
        if (!runtimeEntry || runtimeEntry.sessionId !== missionId) return { ok: false, reason: 'delivery_unavailable', message: 'permission consumer is not live' };
        return { ok: true };
      }
      if (type === 'question') {
        runtimeEntry = pendingQuestions.get(interventionId);
        if (!runtimeEntry || runtimeEntry.sessionId !== missionId) return { ok: false, reason: 'delivery_unavailable', message: 'question consumer is not live' };
        return { ok: true };
      }
      if (type === 'plan') {
        runtimeEntry = pendingPlans.get(interventionId);
        if (!runtimeEntry || runtimeEntry.sessionId !== missionId) return { ok: false, reason: 'delivery_unavailable', message: 'plan consumer is not live' };
        return { ok: true };
      }
      if (!agentAction) return { ok: false, reason: 'delivery_unavailable' };
      return agentAction.preflight(authoritative);
    };

    const execute = () => {
      if (type === 'permission') {
        runtimeEntry.commandApplying = true;
        clearTimeout(runtimeEntry.timer);
        const decision = action === 'allow'
          ? { behavior: 'allow', updatedInput: payload.updatedInput, ...(payload.scope === 'session' ? { scope: 'session' } : {}) }
          : { behavior: 'deny', message: String(payload.message || 'denied by user') };
        runtimeEntry.resolve(decision, { skipInterventionSettle: true });
        return { ok: true, delivered: true };
      }
      if (type === 'question') {
        runtimeEntry.commandApplying = true;
        clearTimeout(runtimeEntry.timer);
        const delivered = runtimeEntry.deliver(normalizedAnswer, { skipInterventionSettle: true, preserveRegistry: true });
        return { ok: delivered !== false, delivered: delivered !== false, reason: delivered === false ? 'delivery_failed' : '' };
      }
      if (type === 'plan') {
        runtimeEntry.commandApplying = true;
        clearTimeout(runtimeEntry.timer);
        runtimeEntry.resolve({
          decision: action,
          note: payload.feedback != null ? String(payload.feedback).slice(0, 2000) : '',
        }, { skipInterventionSettle: true });
        return { ok: true, delivered: true };
      }
      return agentAction.execute();
    };

    let transition;
    try {
      transition = await transitionInterventionState(
        missionId,
        interventionId,
        contractRequest ? command.expectedVersion : undefined,
        toStatus,
        {
          source,
          decidedBy: String(command.decidedBy || 'user'),
          idempotencyKey,
          decisionFingerprint,
          preflight,
          action: execute,
          resolveStatus: result => result && result.ok === false ? 'indeterminate' : toStatus,
          extra: result => ({
            action,
            ...(type === 'question' ? { answer: normalizedAnswer } : {}),
            ...(type === 'plan' && payload.feedback != null ? { feedback: String(payload.feedback).slice(0, 2000) } : {}),
            ...(result && result.nodeId ? { nodeId: result.nodeId } : {}),
          }),
          buildResponse: (result, meta) => result && result.ok === false
            ? interventionCommandFailure(result.reason || 'delivery_failed', 409, { type }, result.message || 'decision could not be delivered').body
            : {
                ok: true,
                missionId,
                interventionId,
                type,
                action,
                status: meta.status,
                interventionVersion: meta.interventionVersion,
                ...(result && result.delivered !== undefined ? { delivered: result.delivered } : {}),
                ...(result && result.nodeId ? { nodeId: result.nodeId } : {}),
              },
          audit: command.audit === false ? undefined : (_result, terminal) => {
            const auditSource = source === 'legacy_question' ? 'question_answer'
              : source === 'legacy_permission' ? 'permission_decision'
                : source === 'legacy_plan' ? 'plan_decision'
                  : source === 'legacy_pool' ? `pool_${action}`
                    // 116c(27 号文 §11.3):管家代答的决定在审计流里必须一眼可辨,不能混进通用标签 ——
                    // 「谁按的这个批准」是事后解释与撤销的第一现场。
                    : source === 'steward' ? 'steward_decision'
                      : 'intervention_decision';
            logEvent({ kind: 'intervention', source: auditSource, sessionId: missionId, interventionId, type, action, interventionVersion: terminal.interventionVersion });
          },
          afterTerminal: () => {
            if (!runtimeEntry) return;
            runtimeEntry.commandApplying = false;
            if (type === 'permission' && pendingPermissions.get(interventionId) === runtimeEntry) pendingPermissions.delete(interventionId);
            else if (type === 'question' && pendingQuestions.get(interventionId) === runtimeEntry) pendingQuestions.delete(interventionId);
            else if (type === 'plan' && pendingPlans.get(interventionId) === runtimeEntry) pendingPlans.delete(interventionId);
          },
        },
      );
    } catch (error) {
      const message = String(error && error.message || error);
      return interventionCommandFailure('execution_failed', 500, {}, message);
    }
    if (!transition || !transition.ok) return mapInterventionTransitionFailure(transition);
    const response = transition.response && typeof transition.response === 'object'
      ? transition.response
      : {
          ok: true,
          missionId,
          interventionId,
          type,
          action,
          status: transition.status,
          interventionVersion: transition.interventionVersion,
        };
    return { status: response.ok === false ? 409 : 200, body: response };
  }

  return decideInterventionCommand;
}

module.exports = { createInterventionDecisions, interventionCommandFailure, mapInterventionTransitionFailure };
