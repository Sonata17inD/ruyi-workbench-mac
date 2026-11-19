'use strict';

// Mission controls coordinate storage and execution through explicit ports.
function createMissionControl({
  storage: { loadSession, saveSession, mutateSession },
  checkpoints: { journalReadIndex, rewindSession },
  execution: { hasActiveTurn, getActiveTurn, hasActiveRun, getTurnSettler, stopSession, stopMissionAgentRuns, listAgentRuns },
  model: { normalizeMission, normalizeMissionCheck, followupAcceptanceCriterion },
  lifecycle: { buildMissionResult, archiveMissionResult },
  events: { bumpMissionChangeSeq, logEvent },
  authorization: { revokeAllGrants },
  MISSION_DEFAULT_MAX_TURNS, MISSION_MAX_MILESTONES, MISSION_MAX_TEXT,
  nowIso, makeId,
}) {
// ── 第84波:Mission 控制面单一 command core ───────────────────────────────────────────────
// 74 波冻结语义在这里落成唯一状态机：pause/takeover 只停当前回合+驱动，stop 覆盖整单并请求停止
// 同 Mission 的所有活 Run；continue/retry 只再武装，真正的新 provider 回合由 UI 在用户点击后显式发起。
function missionRollbackTarget(session, checkpointEntries) {
  const mission = session && session.mission;
  const explicit = Number(mission && mission.startedTurnSeq);
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
  const missionStartedAt = Date.parse(String(mission && mission.createdAt || ''));
  if (!Number.isFinite(missionStartedAt)) return 0; // 旧数据边界不明时宁可不给整单回退，也不越界撤销前一项工作
  const candidates = [];
  for (const entry of (checkpointEntries || [])) {
    const seq = Number(entry && entry.turnSeq);
    const occurredAt = Date.parse(String(entry && entry.ts || ''));
    if (Number.isSafeInteger(seq) && seq > 0 && Number.isFinite(occurredAt) && occurredAt >= missionStartedAt - 1000) candidates.push(seq);
  }
  for (const message of ((session && session.messages) || [])) {
    const direct = Number(message && message.turnSeq);
    const summary = Number(message && message.turnSummary && message.turnSummary.turnSeq);
    const occurredAt = Date.parse(String(message && (message.createdAt || message.ts) || ''));
    if (!Number.isFinite(occurredAt) || occurredAt < missionStartedAt - 1000) continue;
    if (Number.isSafeInteger(direct) && direct > 0) candidates.push(direct);
    if (Number.isSafeInteger(summary) && summary > 0) candidates.push(summary);
  }
  return candidates.length ? Math.min(...candidates) : 0;
}

function missionBudgetRemaining(mission) {
  if (!mission) return false;
  const budget = mission.budget || {};
  const spent = mission.spent || {};
  if ((Number(spent.autoTurns) || 0) >= Math.max(1, Number(budget.maxAutoTurns) || MISSION_DEFAULT_MAX_TURNS)) return false;
  if ((Number(budget.maxTokens) || 0) > 0 && (Number(spent.tokens) || 0) >= Number(budget.maxTokens)) return false;
  return true;
}

// 117m-A3（审查报回）：控制面的【判据侧】要和【执行侧】看到同一个事实。
// missionControlCommand 已经会惰性补账本，但交办台的按钮是拿 GET /api/missions/:id 里的
// controls.actions 画的 —— 那一面走的是本函数，它七个动作都以 Boolean(mission) 开头，
// 于是「没账本的管家线程」七个按钮全灰、点都点不下去，执行侧的修复根本走不到。
// 这里给 kind==='mission' 且账本为空的会话一份【只读的空账本视图】（不落盘、不改会话），
// 让判据与惰性补出来的账本一致：在跑 -> 可暂停/可接管，不终态 -> 可停止；
// 需要里程碑/结果/检查点的那几个（继续、重试、回滚）自然仍然不可用。
// 非 mission 会话 mission 仍为 null，七个动作照旧全部不可用（普通对话没有任务控制面）。
const MISSION_EMPTY_LEDGER_VIEW = Object.freeze({ autoMode: 'off', milestones: [], result: null, budget: null, spent: null });
function missionControlView(session, opts = {}) {
  const mission = (session && session.mission)
    || (session && String(session.kind || '') === 'mission' ? MISSION_EMPTY_LEDGER_VIEW : null);
  const checkpointEntries = Array.isArray(opts.checkpointEntries) ? opts.checkpointEntries : [];
  const runs = Array.isArray(opts.runs) ? opts.runs : [];
  const activeTurn = Boolean(session && hasActiveTurn(session.id));
  const liveRuns = runs.filter(run => run && (run.live === true || hasActiveRun(run.id)));
  const terminal = Boolean(mission && mission.result);
  const milestones = mission && Array.isArray(mission.milestones) ? mission.milestones : [];
  const unfinished = milestones.some(item => !item || item.status !== 'done');
  const completed = milestones.length > 0 && !unfinished;
  // A completed autonomous Mission keeps its historical autoMode value. Treat
  // it as an armed driver only while the Mission is still unsettled; otherwise
  // an auto-completed task could never accept a user follow-up.
  const driverArmed = Boolean(mission && mission.autoMode === 'until-done' && !terminal && !completed);
  const followupCapacity = unfinished || milestones.length < MISSION_MAX_MILESTONES;
  const budgetRemaining = missionBudgetRemaining(mission);
  const rollbackTargetTurnSeq = missionRollbackTarget(session, checkpointEntries);
  const action = (enabled, scope, reason = '') => ({ enabled: Boolean(enabled), scope, reason: enabled ? '' : reason });
  return {
    activeTurn, liveRuns: liveRuns.length, terminal, unfinished, budgetRemaining,
    rollbackTargetTurnSeq,
    actions: {
      pause: action(Boolean(mission) && !terminal && (activeTurn || mission.autoMode === 'until-done'), 'turn_driver', !mission ? 'mission_missing' : (terminal ? 'terminal' : 'already_paused')),
      continue: action(Boolean(mission) && !terminal && unfinished && !activeTurn && mission.autoMode !== 'until-done' && budgetRemaining,
        'turn_driver', terminal ? 'terminal' : (!unfinished ? 'complete' : (activeTurn ? 'turn_active' : (!budgetRemaining ? 'budget_exhausted' : 'already_running')))),
      stop: action(Boolean(mission) && !terminal, 'mission', terminal ? 'terminal' : 'mission_missing'),
      retry: action(Boolean(mission) && Boolean(mission.result) && mission.result.status === 'stopped' && unfinished && !activeTurn && budgetRemaining,
        'mission', !terminal ? 'not_terminal' : (mission.result && mission.result.status !== 'stopped' ? 'complete' : (activeTurn ? 'turn_active' : (!unfinished ? 'complete' : (!budgetRemaining ? 'budget_exhausted' : 'unavailable'))))),
      // 第95波:再开一回合 —— 任务已收工/已停工/预算内暂停后,用户追加新提示继续推进。
      // 与 retry 的区别:next_turn 不依赖 result.status===stopped,complete 也可用,且携带用户新提示。
      next_turn: action(Boolean(mission) && !activeTurn && liveRuns.length === 0 && !driverArmed && budgetRemaining && followupCapacity,
        'mission', activeTurn ? 'turn_active' : (liveRuns.length ? 'run_active' : (driverArmed ? 'already_running' : (!budgetRemaining ? 'budget_exhausted' : (!followupCapacity ? 'milestone_limit' : 'unavailable'))))),
      takeover: action(Boolean(mission) && !terminal && (activeTurn || mission.autoMode !== 'off'), 'turn_driver', !mission ? 'mission_missing' : (terminal ? 'terminal' : 'already_manual')),
      rollback: action(Boolean(mission) && rollbackTargetTurnSeq > 0 && checkpointEntries.length > 0 && !activeTurn && liveRuns.length === 0,
        'mission', activeTurn ? 'turn_active' : (liveRuns.length ? 'run_active' : (!rollbackTargetTurnSeq ? 'target_unknown' : 'no_checkpoints'))),
    },
  };
}

async function waitMissionTurnSettled(sessionId) {
  const settler = getTurnSettler(sessionId);
  if (!settler || !settler.promise) return true;
  let timer;
  try {
    return await Promise.race([settler.promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 8000); })]);
  } finally { clearTimeout(timer); }
}

function missionControlFailure(reason, status = 409, message = '') {
  return { status, body: { ok: false, reason, error: message || reason } };
}

async function missionControlCommand(sessionId, rawAction, rawPrompt = '') {
  const action = String(rawAction || '').trim();
  const prompt = String(rawPrompt || '').trim();
  if (!['pause', 'continue', 'stop', 'retry', 'takeover', 'rollback', 'next_turn'].includes(action)) {
    return missionControlFailure('action_invalid', 400, 'unknown mission control action');
  }
  if (action === 'next_turn' && !prompt) {
    return missionControlFailure('prompt_required', 400, 'next_turn requires a prompt');
  }
  // 回合收尾的原子头文件换名窗口里，磁盘读可能短暂看不到头；活回合注册表持有同一权威 session，
  // 控制动作必须仍可送达，不能让用户在最需要 Pause 时撞瞬态 404。
  const registered = getActiveTurn(sessionId);
  let session = await loadSession(sessionId) || (registered && registered.session) || null;
  if (!session) return missionControlFailure('not_found', 404, 'session not found');
  // 117m-A3（用户第六轮走查④ 的同一个模具，第二处）：管家开的线程是 kind:'mission' 而
  // mission:null（steward_thread_new 只竖了 kind，从来不建账本）。修前这里一律 404 'mission not found'，
  // 于是交办台上的「暂停/停止/接管」对【每一条管家开的线程】都失败，而用户看到的只是一句 404。
  // 账本改成【惰性建】：真要用到它时就地补一份最小账本（goal 取会话标题、里程碑为空），然后走原路 ——
  // 不为一个 null 再写一套「没有账本时怎么办」的平行控制逻辑（下面整段都直接解引用 mission）。
  // 只对 kind==='mission' 的会话补：普通对话不会因为被调了一次控制面就升格成事项。
  // 补账本写成一个局部函数：下面 pause/stop/takeover 那一支会先 stopSession 再【从磁盘重读】会话，
  // 内存里刚补的账本会跟着没。117m-A6（审查报回 P0-2）：修前只在入口补一次，重读后
  // `mission.autoMode = ...` 就对 null 赋值抛 TypeError —— 而那正是本波要修的最典型场景
  //（暂停一条【正在跑】的、还没账本的管家线程）：回合已经被真停掉，接口却报 500。
  const ensureMissionLedger = target => {
    if (!target || target.mission) return true;
    if (String(target.kind || '') !== 'mission') return false;
    target.mission = normalizeMission({ goal: String(target.title || '').slice(0, 2000) }, null);
    return true;
  };
  if (!session.mission) {
    if (!ensureMissionLedger(session)) return missionControlFailure('mission_missing', 404, 'mission not found');
    logEvent({ kind: 'mission_ledger_seeded', sessionId, action, source: 'mission_control' });
  }

  let cpEntries = await journalReadIndex(sessionId).catch(() => []);
  let runs = await listAgentRuns(sessionId).catch(() => []);
  let controls = missionControlView(session, { checkpointEntries: cpEntries, runs });
  const capability = controls.actions[action];
  if (!capability || !capability.enabled) return missionControlFailure(capability && capability.reason || 'unavailable');

  const mustStopTurn = ['pause', 'stop', 'takeover'].includes(action) && hasActiveTurn(sessionId);
  if (mustStopTurn) {
    // 先改活回合持有的同一 Mission 引用，再中止 fetch/子进程。否则 dying turn 的当前轮 settler
    // resolve 后，until-done driver 可能在控制路由落盘前抢先开启下一轮，Pause 响应仍显示 activeTurn。
    const liveTurn = getActiveTurn(sessionId);
    if (liveTurn && liveTurn.session && liveTurn.session.mission) {
      liveTurn.session.mission.autoMode = action === 'pause' ? 'supervised' : 'off';
      liveTurn.session.mission.updatedAt = nowIso();
    }
    stopSession(sessionId, `mission_${action}`);
    const settled = await waitMissionTurnSettled(sessionId);
    if (!settled) logEvent({ kind: 'mission_control_settle_timeout', sessionId, action });
    session = await loadSession(sessionId) || session;
    // 重读回来的那份又是磁盘上的 mission:null，在这里再补一次（下面整段直接解引用 mission）。
    ensureMissionLedger(session);
  }

  let requiresTurn = false;
  let rollback = null;
  let stoppedRuns = 0;
  const mission = session.mission;
  if (action === 'pause') {
    mission.autoMode = 'supervised';
  } else if (action === 'continue') {
    mission.autoMode = 'until-done';
    mission.stall = { lastDigest: '', sameCount: 0 };
    requiresTurn = true;
  } else if (action === 'takeover') {
    mission.autoMode = 'off';
    try { revokeAllGrants(sessionId, 'mission-takeover'); } catch { /* best-effort */ }
  } else if (action === 'stop') {
    stoppedRuns = await stopMissionAgentRuns(sessionId);
    try { revokeAllGrants(sessionId, 'mission-stop'); } catch { /* best-effort */ }
    mission.autoMode = 'off';
    archiveMissionResult(mission); // 旧 complete 章归档,再盖 stopped
    mission.result = await buildMissionResult(session, { status: 'stopped', how: 'stop' });
  } else if (action === 'retry') {
    for (const item of mission.milestones || []) {
      if (item && item.status === 'blocked') { item.status = 'pending'; item.evidence = ''; }
    }
    archiveMissionResult(mission); // 旧 stopped 章归档
    mission.result = null;
    mission.autoMode = 'until-done';
    mission.stall = { lastDigest: '', sameCount: 0 };
    requiresTurn = true;
  } else if (action === 'next_turn') {
    // 第95波:再开一回合 —— 完成/停工/暂停后,用户追加新提示继续推进。
    // 用户消息和 turnSeq 仍只由随后唯一的 /api/chat/stream 写入；控制面若也预写会产生重复提示与跳号。
    // 已收工任务的旧里程碑全为 done，必须为追加目标建立新的 pending 验收项，否则下一次回合收尾会
    // 被 maybeFinalizeMission 立即重新盖 complete 章。停工/暂停任务已有未完项，只需用新提示继续推进。
    const milestones = Array.isArray(mission.milestones) ? mission.milestones : [];
    const allDone = milestones.length > 0 && milestones.every(item => item && item.status === 'done');
    if (allDone) {
      if (milestones.length >= MISSION_MAX_MILESTONES) {
        return missionControlFailure('milestone_limit', 409, 'mission milestone limit reached');
      }
      mission.milestones.push({
        id: makeId('accept_followup'), desc: followupAcceptanceCriterion(prompt).slice(0, MISSION_MAX_TEXT), status: 'pending',
        check: normalizeMissionCheck(null, true), evidence: '',
      });
    }
    archiveMissionResult(mission); // 旧 complete 章归档,新轮再盖
    mission.result = null;
    mission.autoMode = 'until-done';
    mission.stall = { lastDigest: '', sameCount: 0 };
    requiresTurn = true;
  } else if (action === 'rollback') {
    const targetTurnSeq = controls.rollbackTargetTurnSeq;
    rollback = await rewindSession(sessionId, targetTurnSeq, true);
    if (!rollback || !rollback.ok) return missionControlFailure('rollback_failed', 409, rollback && rollback.error || 'mission rollback failed');
    session = await loadSession(sessionId) || session;
    for (const item of session.mission.milestones || []) {
      if (!item) continue;
      item.status = 'pending';
      item.evidence = '';
    }
    archiveMissionResult(session.mission); // 归档回退前的终态章(rewindSession 不触碰 mission.result)
    session.mission.result = null;
    session.mission.autoMode = 'off';
    session.mission.stall = { lastDigest: '', sameCount: 0 };
  }
  session.mission.updatedAt = nowIso();
  // 128b(48 号文 §2-b):这一存修前是裸 saveSession —— 撤回落在 load 与 save 之间(中间还有停子代理、盖章这些慢活)时,
  // 账本改动被闸静默丢掉、下面照样记变更流水、回 ok:true。副作用(停回合、停子代理、撤授权、回退)都已经发生、
  // 不能重做;要落盘的只是「账本现在该是什么样」—— 撤回不动账本,所以把这份账本整份重放到新读的副本上。
  try { await saveSession(session, { throwIfStale: true, writer: 'mission_control' }); }
  catch (error) {
    if (!(error && error.code === 'SESSION_STALE_SAVE')) throw error;
    const intended = session.mission;
    let written;
    try { written = await mutateSession(sessionId, fresh => { fresh.mission = intended; }, { writer: 'mission_control_replay' }); }
    catch (replayError) {
      if (replayError && replayError.code === 'session.rewound_during_write') return missionControlFailure('rewound_during_write', 409, replayError.message);
      throw replayError;
    }
    if (!written.session) return missionControlFailure('not_found', 404, 'session not found');
    session = written.session;
  }
  const revision = await bumpMissionChangeSeq(sessionId, {
    type: action === 'stop' ? 'result' : 'progress',
    cursor: { action, ...(rollback ? { targetTurnSeq: controls.rollbackTargetTurnSeq } : {}) },
    detail: { status: session.mission.result && session.mission.result.status || '', autoMode: session.mission.autoMode, stoppedRuns, rollback: Boolean(rollback) },
  });
  if (revision) session.mission.changeSeq = revision;
  const reg = getActiveTurn(sessionId);
  if (reg && reg.session && reg.session !== session) reg.session.mission = session.mission;
  if (reg && reg.onEvent) { try { reg.onEvent({ type: 'mission', mission: session.mission }); } catch { /* stream gone */ } }

  cpEntries = await journalReadIndex(sessionId).catch(() => []);
  runs = await listAgentRuns(sessionId).catch(() => []);
  controls = missionControlView(session, { checkpointEntries: cpEntries, runs });
  return { status: 200, body: { ok: true, action, mission: session.mission, controls, requiresTurn, stoppedRuns, ...(rollback ? { rollback } : {}) } };
}
// 执行一条里程碑的机器验收(command 判退出码+可选输出包含;file_exists 判在)。'none' 返回 null(交模型自报)。
// 只读判定,不改文件;command 走工作区 cwd,复用 runProcess 基建;绝不用于副作用。

return { missionRollbackTarget, missionBudgetRemaining, missionControlView, waitMissionTurnSettled, missionControlFailure, missionControlCommand };
}
module.exports = { createMissionControl };
