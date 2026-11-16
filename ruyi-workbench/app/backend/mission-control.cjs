'use strict';
const path = require('node:path');
const fsp = require('node:fs/promises');

// Mission controls coordinate storage and execution through explicit ports.
function createMissionControl({
  storage: { loadSession, saveSession, mutateSession },
  checkpoints: { journalReadIndex, rewindSession },
  execution: { hasActiveTurn, getActiveTurn, hasActiveRun, getTurnSettler, stopSession, stopMissionAgentRuns, listAgentRuns },
  model: { foldTurnSummaries, applyMissionUpdate, normalizeMission, normalizeMissionCheck, followupAcceptanceCriterion },
  events: { bumpMissionChangeSeq, logEvent },
  authorization: { revokeAllGrants },
  MISSION_DEFAULT_MAX_TURNS, MISSION_MAX_MILESTONES, MISSION_MAX_TEXT,
  nowIso, makeId, runProcess,
}) {
async function buildMissionResult(session, opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const m = session.mission;
  const ms = (m && Array.isArray(m.milestones)) ? m.milestones : [];
  const fold = foldTurnSummaries(session);
  const cpEntries = await journalReadIndex(session.id).catch(() => []);
  const cpTurnSeqs = [...new Set(cpEntries.map(e => e && e.turnSeq).filter(Number.isFinite))].sort((a, b) => a - b);
  const byOp = {};
  for (const f of fold.filesChanged) byOp[f.op || 'unknown'] = (byOp[f.op || 'unknown'] || 0) + 1;
  // 交付成果正文:取本会话最后一条 assistant content(盖章时该消息已在 session.messages 内存)。
  // 随 result 持久化 + 下发,收工卡不再依赖 SSE 流到达时序;刷新读磁盘 result 已落盘,不截断当前输出。
  let deliverableText = '';
  const msgs = Array.isArray(session.messages) ? session.messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const msg = msgs[i];
    if (msg && msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim()) {
      deliverableText = msg.content.slice(0, 16000);
      break;
    }
  }
  return {
    status: o.status === 'stopped' ? 'stopped' : 'complete',
    how: String(o.how || '').slice(0, 32),
    finishedAt: nowIso(),
    deliverableText,
    acceptance: {
      total: ms.length,
      done: ms.filter(x => x && x.status === 'done').length,
      blocked: ms.filter(x => x && x.status === 'blocked').length,
      pending: ms.filter(x => !x || x.status === 'pending').length,
    },
    unfinished: ms.filter(x => !x || x.status !== 'done').map(x => ({ id: x && x.id, desc: String((x && x.desc) || '').slice(0, 200), status: (x && x.status) || 'pending' })),
    todosOpen: ((session.todos) || []).filter(t => t && t.status !== 'done').length,
    artifacts: fold.artifacts.slice(0, 50),
    usage: {
      autoTurns: Math.max(0, Number(m && m.spent && m.spent.autoTurns) || 0),
      tokens: Math.max(0, Number(m && m.spent && m.spent.tokens) || 0),
    },
    changes: {
      filesChanged: fold.filesChanged.length, byOp,
      irreversibleFiles: fold.filesChanged.filter(f => f.revertible !== true).length,
      commands: fold.commands,
    },
    checkpoints: { entries: cpEntries.length, turnSeqs: cpTurnSeqs.slice(0, 50), rollbackAvailable: cpEntries.length > 0 },
    audit: { commands: fold.commands, irreversible: fold.irreversible.total, checkpoints: cpEntries.length, openTodos: ((session.todos) || []).filter(t => t && t.status !== 'done').length },
    irreversible: { total: fold.irreversible.total, byKind: fold.irreversible.byKind, items: fold.irreversible.items.slice(-30), legacyCommands: fold.irreversible.legacyCommands, ...(fold.irreversible.incomplete ? { incomplete: true } : {}) },
  };
}
// 终态盖章/再武装清理。在【任何 mission 突变点】调用(/api/mission check/update、09 回合内 mission_update):
// 全部里程碑 done 且尚无 complete 章 → 盖章;否则有旧章 → 清理(再武装 = 结果不再是终态,章会撒谎)。
// 返回是否改变了 mission(调用方负责 saveSession)。stop 不走这里 —— 它直接盖 stopped 章(13-http-router)。
function archiveMissionResult(mission) {
  if (!mission || !mission.result) return;
  const history = Array.isArray(mission.resultHistory) ? mission.resultHistory.slice() : [];
  const archived = { ...mission.result };
  // 第97波:历史轮次保留完整 deliverableText,支持收工卡「在新窗口打开全文」;条数由 last 10 有界防膨胀。
  history.push(archived);
  if (history.length > 10) history.splice(0, history.length - 10);
  mission.resultHistory = history;
}

async function maybeFinalizeMission(session, how) {
  const m = session && session.mission;
  if (!m || !Array.isArray(m.milestones)) return false;
  const allDone = m.milestones.length > 0 && m.milestones.every(x => x && x.status === 'done');
  if (allDone) {
    if (m.result && m.result.status === 'complete') return false; // 已盖章,不重复
    archiveMissionResult(m); // 旧 stopped 章归档,再盖 complete
    m.result = await buildMissionResult(session, { status: 'complete', how });
    m.updatedAt = nowIso();
    return true;
  }
  if (m.result) { archiveMissionResult(m); m.result = null; m.updatedAt = nowIso(); return true; } // 再武装:归档旧章再清
  return false;
}

// A model can mark the last acceptance item done before it emits the final assistant text. In that case the
// route has already produced a complete result from the previous assistant message. Rebuild that provisional
// result once the current turn has appended its assistant message; do not archive it as a real prior round.
async function finalizeMissionAfterTurn(session, how) {
  const mission = session && session.mission;
  if (mission && mission.result && mission.result.status === 'complete') {
    mission.result = await buildMissionResult(session, { status: 'complete', how: how || mission.result.how || 'update' });
    mission.updatedAt = nowIso();
    return true;
  }
  return maybeFinalizeMission(session, how);
}

// ── 122-§2.4:回合收尾的【落盘前合并】(mission) ───────────────────────────────────────────
// 现象:管家开线程后立刻派第一回合,再 POST /api/mission {action:'start'};回合收尾一存,里程碑账本没了。
// 病根:/api/mission 落盘后只在 getActiveTurn(sessionId) 命中时才把 mission 同步进活回合内存(C4)。
// 而 09-workflow 从「路由 loadSession 出会话」到「activeChildren.set(reg)」之间隔着 providerHistory 同步、
// 配对/参数自愈、turnSeq 落盘、onTurnStart 钩子与 captureWorkspaceTurnBaseline —— 这一整段里到达的 start
// 已经落了盘,却谁也同步不进回合内存;回合收尾 saveSession(内存 session)把整份 mission 覆盖回「没有」。
// 修法(与 P2-3「skills/memories 的 pre-save disk-merge」同一形状,三个引擎共用本函数):落盘前重读磁盘,
//   ① 磁盘有账本而内存没有  → 以磁盘为准(顺带把 start 翻过的 kind:'mission' 接回来);
//   ② 同一本账本(createdAt 相同)且磁盘 changeSeq 更高 → 以磁盘为底,把本回合内存里的增量
//      (goal / 里程碑 status·desc·evidence)用 applyMissionUpdate 语义重放上去 —— provider 引擎的
//      mission_update 是 in-process 改内存的(09),不重放就把本回合的进度丢了;
//   ③ 其余情况(内存不比磁盘旧,或磁盘换了另一本账本而内存那本已被 start 顶替)保持现状/以磁盘为准。
// 返回是否改过 session.mission(仅供调用方判断,收尾流程不依赖)。
function mergeMissionBeforeSave(session, onDisk) {
  if (!session) return false;
  const disk = onDisk && onDisk.mission && typeof onDisk.mission === 'object' ? onDisk.mission : null;
  const mem = session.mission && typeof session.mission === 'object' ? session.mission : null;
  if (!disk) return false;                       // 磁盘没有账本 -> 内存说了算(与合并前逐字节等价)
  if (!mem) {                                    // ① 回合中途才被 start:整份接过来
    session.mission = disk;
    if (onDisk.kind === 'mission') session.kind = 'mission';
    return true;
  }
  const diskSeq = Number(disk.changeSeq) || 0;
  const memSeq = Number(mem.changeSeq) || 0;
  if (diskSeq <= memSeq) return false;           // ③ 内存不比磁盘旧
  if (String(disk.createdAt || '') !== String(mem.createdAt || '')) {
    // ③ 磁盘上已经是【另一本】账本(回合中途 start 全量新建):内存那本是被顶替的旧账,不许重放回去。
    session.mission = disk;
    if (onDisk.kind === 'mission') session.kind = 'mission';
    return true;
  }
  // ② 同一本账本:以磁盘为底重放内存增量。补丁里【只带】id/status/desc/evidence,绝不带 check ——
  // 机器验收的定义权只属于磁盘那一份(用户经 header token 设的)。trusted=false 是刻意的:它顺带挡住
  // 「磁盘刚把 m1 判 done(action:'check' / 用户 UI),内存里那份还是 pending」被重放成回退」。
  session.mission = applyMissionUpdate(disk, {
    goal: mem.goal,
    milestones: (Array.isArray(mem.milestones) ? mem.milestones : []).map(item => ({
      id: item && item.id, status: item && item.status, desc: item && item.desc, evidence: item && item.evidence,
    })),
  }, false);
  if (onDisk.kind === 'mission') session.kind = 'mission';
  return true;
}

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
async function evaluateMissionCheck(check, cwd) {
  if (!check || check.type === 'none') return null;
  try {
    if (check.type === 'file_exists') {
      const p = path.resolve(cwd || '.', String(check.path || ''));
      // 对抗轮 P3: 限定在工作区内 —— file_exists 路径可为绝对/../ 穿越,即便只读(fsp.access)也是任意路径存在性
      // 探测(信息泄露)。仅当解析后落在 cwd 内才判定,越界一律「不适用」(不泄露)。
      const base = path.resolve(cwd || '.');
      if (p !== base && !p.startsWith(base + path.sep)) return { pass: false, detail: '路径超出工作区,已跳过验收' };
      try { await fsp.access(p); return { pass: true, detail: '文件存在: ' + check.path }; }
      catch { return { pass: false, detail: '文件不存在: ' + check.path }; }
    }
    if (check.type === 'command') {
      if (!String(check.cmd || '').trim()) return { pass: false, detail: '空命令' };
      // shell:true 让整条命令串按用户书写执行(判定性只读用途;超时 60s;工作区 cwd)。
      const r = await runProcess(String(check.cmd), [], { timeoutMs: 60000, cwd: cwd || process.cwd(), shell: true }).catch(e => ({ code: -1, stdout: '', stderr: String(e && e.message || e) }));
      const out = String((r.stdout || '') + (r.stderr || ''));
      const codeOk = Number(r.code) === 0;
      const expectOk = check.expect ? out.includes(String(check.expect)) : true;
      return { pass: codeOk && expectOk, detail: `退出码=${r.code}${check.expect ? (expectOk ? ' · 命中期望' : ' · 未命中期望「' + check.expect + '」') : ''}` };
    }
  } catch (e) { return { pass: false, detail: '验收异常: ' + String(e && e.message || e).slice(0, 200) }; }
  return null;
}

return { buildMissionResult, archiveMissionResult, maybeFinalizeMission, finalizeMissionAfterTurn, mergeMissionBeforeSave, missionRollbackTarget, missionBudgetRemaining, missionControlView, waitMissionTurnSettled, missionControlFailure, missionControlCommand, evaluateMissionCheck };
}
module.exports = { createMissionControl };
