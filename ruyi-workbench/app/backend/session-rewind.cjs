'use strict';
// Owns rewind admission through execution settlement, rollback and durable commit.
function createSessionRewind({ execution, state, storage, checkpoints, effects, events, logEvent, timers = globalThis }) {
const { activeChildren, turnSettlers } = state;
const { setTimeout, clearTimeout } = timers;
const sessionRewindAdmissions = new Set();
const sessionLegacyRewinds = new Map();
const admissionBlocked = sessionId => sessionRewindAdmissions.has(sessionId);

async function rewindSession(sessionId, targetTurnSeq, rollbackFiles, options = {}) {
  if (sessionRewindAdmissions.has(sessionId)) return { ok: false, error: 'rewind_in_progress' };
  if (options.guardExecution !== true) {
    sessionLegacyRewinds.set(sessionId, (sessionLegacyRewinds.get(sessionId) || 0) + 1);
    try { return await rewindSessionContents(sessionId, targetTurnSeq, rollbackFiles); }
    finally {
      const remaining = sessionLegacyRewinds.get(sessionId) - 1;
      if (remaining) sessionLegacyRewinds.set(sessionId, remaining); else sessionLegacyRewinds.delete(sessionId);
    }
  }
  if (sessionLegacyRewinds.has(sessionId)) return { ok: false, error: 'rewind_in_progress' };
  sessionRewindAdmissions.add(sessionId);
  try {
    // Missing is not an observation of idle. Old hand-off buttons cannot acquire a new target.
    if (options.expectedExecution === undefined) return { ok: false, error: 'execution_identity_required' };
    if (typeof execution.checkRewind !== 'function' || typeof execution.stop !== 'function') return { ok: false, error: 'execution_identity_unavailable' };
    const checked = execution.checkRewind(sessionId, options.expectedExecution);
    if (!checked || checked.ok !== true) return checked || { ok: false, error: 'execution_identity_unavailable' };
    if (options.expectedExecution === null) {
      const expected = options.expectedIdleState;
      const observation = expected && expected.executionObservation;
      if (!expected || !Number.isSafeInteger(expected.turnSeq) || expected.turnSeq < 0
          || !Number.isSafeInteger(expected.rewindGen) || expected.rewindGen < 0
          || !observation || typeof observation.serverInstanceId !== 'string' || !observation.serverInstanceId
          || !(observation.lastDriverRunId === null || (typeof observation.lastDriverRunId === 'string' && observation.lastDriverRunId))
          || !Number.isSafeInteger(observation.evictionGeneration) || observation.evictionGeneration < 0) {
        return { ok: false, error: 'execution_identity_required' };
      }
      if (typeof execution.observation !== 'function') return { ok: false, error: 'execution_identity_unavailable' };
      // A null -> B admitted -> null transition is not the same idle observation, even if B never
      // wrote a turn. The eviction generation also prevents a lost tombstone looking like virgin idle.
      const current = execution.observation(sessionId);
      if (!current || current.serverInstanceId !== observation.serverInstanceId
          || current.lastDriverRunId !== observation.lastDriverRunId || current.evictionGeneration !== observation.evictionGeneration) {
        return { ok: false, error: 'execution_changed' };
      }
      const idleSession = await storage.loadSession(sessionId);
      if (!idleSession || (Number(idleSession.turnSeq) || 0) !== expected.turnSeq
          || (Number(idleSession.rewindGen) || 0) !== expected.rewindGen) return { ok: false, error: 'execution_changed' };
    }
    if (checked.execution !== null) {
      const stopped = execution.stop(sessionId, options.expectedExecution, 'rewind');
      if (!stopped || stopped.ok !== true) return stopped || { ok: false, error: 'execution_identity_unavailable' };
    }
    if (activeChildren.has(sessionId)) return { ok: false, error: 'execution_changed' };
    return await rewindSessionContents(sessionId, targetTurnSeq, rollbackFiles, { guarded: true });
  } finally {
    sessionRewindAdmissions.delete(sessionId);
  }
}

async function rewindSessionContents(sessionId, targetTurnSeq, rollbackFiles, options = {}) {
  // 117d 波实测竞态(既有缺陷,本波暴露):回合收尾的【原子头文件换名】窗口里磁盘读会短暂看不到头
  // 文件(storage.loadSession 的 ENOENT 分支回 null),而撤回的调用序是「先 /api/stop 再 rewind」—— stop 已经
  // 把 activeChildren 删了,dying turn 的收尾 save 才刚开始写。于是首读回 null,rewind 直接吐
  // 「session not found」,而这条线程明明在。修法:【不在首读就下 not found 的结论】—— 先照常走
  // 停回合与等 settle(收尾 save 完成后 settler 才 resolve),再以 settle 后那次重读为准。
  // 真正不存在的会话在这条路径上没有活回合也没有 settler,两处 await 都是 no-op,仍然如实回 404。
  // 活回合注册表持有同一权威 session,顺带兜住「stop 还没跑」的那一瞬(与 1628 行
  // missionControlCommand 同一处置)。复现:117c 递话后立刻点撤回,约五成命中。
  const registered = activeChildren.get(sessionId);
  // Legacy callers retain their API, but an automatic stop still targets the execution observed
  // before the first asynchronous read, rather than whichever execution happens to be current later.
  const observedExecution = typeof execution.snapshot === 'function' ? execution.snapshot(sessionId) : undefined;
  let session = await storage.loadSession(sessionId) || (registered && registered.session) || null;
  // 第69波:回合进行中不再拒绝,改为【自动停回合 + 等 settle 再截断】(supersede 语义,与 09-workflow
  // 新回合 stopSession('superseded') 对齐)。原拒绝路径(activeChildren.has → '回合进行中,请先停止')
  // 对非 UI 持有的回合是死锁:页面重载/后台调度回合下前端无停止按钮,用户永远「回不去」。
  // 丢失写竞态:stopSession 立即删 activeChildren,但被停回合的收尾(推 aborted assistant + storage.saveSession)
  // 在其后落盘;若 rewind 在此窗口截断落盘,会被 dying turn 的收尾 save 整份盖回(消息「回来了」)。
  // turnSettlers 在 driver finally(收尾 save 之后)resolve —— 等它即保证截断写在最后。超时兜底:
  // 回合真楔死(.abort 不生效)时按原状截断,残留风险记日志(此时该回合本就在写坏状态)。
  // 107-F7b:上面那句「等它即保证截断写在最后」只对【垂死回合自己】成立,真正兜底的现在是撤回代数闸
  // (sessionRewindGenHighWater 头注;本函数末尾那一存传 rewindBump)。实测挡不住的那条交错(冻结树
  // steward-conversation.e2e G4,负载下 4/20):管家递话后立刻撤回 —— 前端先 /api/stop,它把 activeChildren
  // 删了,所以这里 activeChildren.has 为假(日志里没有 rewind_autostop);settler 在,照常等到了(也没有
  // rewind_settle_timeout)。闸的两个前提都成立,消息却还是回来了:盖回撤回的那一存【不是回合的】。回合
  // settle 的同一刻还有别的写者起跑(13k stewardRecordLaunchOutcome → updateSessionMeta 是读改写;首回合
  // 还有 settleThreadBrief 的补写),它们在 settle 之后才 load,load 落在撤回那一存之前、save 落在之后 ——
  // 等 settle 管不到回合之外的人。代数闸不看是谁写:撤回之前读出来的副本,谁拿着都写不回去。
  if (!options.guarded && (activeChildren.has(sessionId) || observedExecution)) {
    const stopped = typeof execution.stop === 'function'
      ? execution.stop(sessionId, observedExecution, 'rewind') : null;
    if (!stopped || stopped.ok !== true) return stopped || { ok: false, error: 'execution_identity_unavailable' };
    if (activeChildren.has(sessionId)) return { ok: false, error: 'execution_changed' };
    logEvent({ kind: 'rewind_autostop', sessionId, targetTurnSeq: Number(targetTurnSeq) || null });
  }
  const settler = turnSettlers.get(sessionId);
  if (settler && settler.promise) {
    let settleTimer;
    const settled = await Promise.race([settler.promise.then(() => true), new Promise(r => { settleTimer = setTimeout(() => r(false), 8000); })]).finally(() => clearTimeout(settleTimer));
    if (!settled) {
      logEvent({ kind: 'rewind_settle_timeout', sessionId });
      if (options.guarded) return { ok: false, error: 'rewind_settle_timeout' };
    }
  }
  const live = await storage.loadSession(sessionId); // settle 后重读: dying turn 的收尾(含 aborted assistant)已落盘
  if (live) session = live;
  // not found 的结论挪到这里下(见函数开头注):首读撞上换名窗口不算「不存在」。
  if (!session) return { ok: false, error: 'session not found' };
  const target = Number(targetTurnSeq);
  if (!Number.isFinite(target)) return { ok: false, error: 'targetTurnSeq is required' };
  const messages = Array.isArray(session.messages) ? session.messages : [];
  // Locate the first user message belonging to targetTurnSeq. Primary: the additive `turnSeq` field
  // (S4b stamps every new user message). Fallback for pre-S4b messages without the field: the first user
  // message whose FOLLOWING assistant carries turnSummary.turnSeq === target (assistant messages have
  // carried turnSummary.turnSeq since S3), else an ordinal guess (the `target`-th user message, 1-based).
  let cutIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && m.role === 'user' && Number(m.turnSeq) === target) { cutIndex = i; break; }
  }
  if (cutIndex === -1) {
    // Fallback A: user message immediately preceding the assistant whose turnSummary.turnSeq === target.
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m && m.role === 'assistant' && m.turnSummary && Number(m.turnSummary.turnSeq) === target) {
        for (let j = i - 1; j >= 0; j--) { if (messages[j] && messages[j].role === 'user') { cutIndex = j; break; } }
        break;
      }
    }
  }
  if (cutIndex === -1) {
    // Fallback B: ordinal — the `target`-th user message (1-based). Only reached for legacy sessions.
    let n = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i] && messages[i].role === 'user') { n++; if (n === target) { cutIndex = i; break; } }
    }
  }
  if (cutIndex === -1) return { ok: false, error: 'target turn not found in this session' };

  const lastUserText = String((messages[cutIndex] && messages[cutIndex].content) || '');
  // Which turnSeqs are being discarded? Everything from the cut point onward. Prefer the stamped/summary
  // turnSeqs actually present in the tail; fall back to the numeric range target..current.
  const discarded = new Set();
  for (let i = cutIndex; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'user' && Number.isFinite(Number(m.turnSeq))) discarded.add(Number(m.turnSeq));
    if (m.role === 'assistant' && m.turnSummary && Number.isFinite(Number(m.turnSummary.turnSeq))) discarded.add(Number(m.turnSummary.turnSeq));
  }
  const curSeq = Number(session.turnSeq) || target;
  for (let s = target; s <= curSeq; s++) discarded.add(s);

  // Optional file rollback of the discarded turns, newest→oldest (so multiple writes to a file unwind to
  // the earliest recorded `before` across turns). Aggregate into filesReverted / filesFailed.
  // 116-3 data-safety P1-4:`turnsWithoutCheckpoint` —— 哪些被丢弃的回合【压根没有 checkpoint 记录】。
  // 修前「0 条 revert」这一个形状同时代表两件完全不同的事:「这一步没碰过文件,不用回滚」与
  // 「这一步改过文件,但改动没进 journal(引擎用自己的原生编辑能力绕过了 file_* 桥),回滚不了」。
  // 用户看到「文件已回滚」会以为磁盘复原了,实际改动原封不动留着。这里把第二种如实说出来,
  // 让上层能在提示旁边补一句「以下回合的文件改动未被追踪,可能没有被撤销」。只加字段,不改行为。
  const filesReverted = [], filesFailed = [], turnsWithoutCheckpoint = [];
  if (rollbackFiles) {
    const seqs = [...discarded].sort((a, b) => b - a); // newest first
    for (const s of seqs) {
      try {
        const r = await checkpoints.rollback(sessionId, s); // whole-turn rollback
        if (r && Array.isArray(r.reverted)) for (const x of r.reverted) filesReverted.push(x);
        if (r && Array.isArray(r.failed)) for (const x of r.failed) filesFailed.push(x);
        if (r && r.ok === false && r.error === 'no entries') turnsWithoutCheckpoint.push(s);
      } catch (e) { filesFailed.push({ path: '', reason: (e && e.message) ? e.message : String(e) }); }
    }
    turnsWithoutCheckpoint.sort((a, b) => a - b);
  }

  const removedTurns = messages.length - cutIndex; // message count removed (user + all following)
  // hunt2 #12:被截掉的后台任务回执从账本里删掉,否则下面这一存的 mergeBackgroundJobs 会把它们原样追加回来。
  const removedJobIds = messages.slice(cutIndex).map(m => m && m.backgroundJobId).filter(Boolean);
  if (removedJobIds.length && effects.forgetBackgroundJobs) effects.forgetBackgroundJobs(sessionId, removedJobIds);
  session.messages = messages.slice(0, cutIndex);
  // providerHistory cleared — lazy-reseed rebuilds it on the next turn (see block comment above).
  session.providerHistory = [];
  session.providerHistoryCursor = 0;
  // turnSeq NOT rewound (monotonic journal key); todos KEPT (rewind ≠ abandon task list).
  delete session.codexThread;
  session.claudeSessionId = null; // stale --resume context must not splice removed history back in
  // Refresh the derived summary/title tail off the surviving messages (best-effort).
  const lastAssistant = [...session.messages].reverse().find(m => m && m.role === 'assistant');
  session.summary = lastAssistant ? String(lastAssistant.content || '').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  // 107-F7b:这一存抬撤回代数(见函数开头那段注与 sessionRewindGenHighWater 头注)。之后任何拿着撤回【之前】
  // 那份对象来写的人都会被 storage.saveSession 的代数闸丢掉。它自己被丢只有两种可能,都是两次撤回交错:① 在它入链
  // 之后、执行之前又来了一次更新的撤回;② 它截断用的这份副本本身读在另一次已经抬了代数的撤回之前(照它截
  // 会把那次撤回删掉的消息带回来)。两种都如实回「被顶掉」,不说 ok:true(前端那道诚实门据此不说已撤回)。
  try {
    await storage.saveSession(session, { rewindBump: true, throwIfStale: true, writer: 'rewind' });
  } catch (error) {
    if (error && error.code === 'SESSION_STALE_SAVE') {
      logEvent({ kind: 'rewind_superseded', sessionId, targetTurnSeq: target });
      return { ok: false, error: 'rewind_superseded' };
    }
    throw error;
  }
  // 撤回已落盘:停掉被撤回回合里模型起的仍在跑的后台 run,并让后台代理唤醒(10 onSessionRewound)记「叫停过」—— 别把改写过的线程自动叫醒,
  // 信封留在账本里随用户下一句话送达。旁路,失败不影响撤回本身。
  try { effects.cancelModelRunsOfDiscardedTurns(sessionId, discarded); } catch { /* 旁路 */ }
  if (effects.onSessionRewound) { try { effects.onSessionRewound({ sessionId, discardedTurnSeqs: discarded }); } catch { /* 旁路 */ } }
  // C4:rewind【不】给模型记「用户撤销了文件」的待告知(rollbackFiles 撤的恰恰是被丢弃回合的改动)。理由:截断之后 providerHistory
  // 清空、下一回合从幸存的展示消息重新播种,被丢弃的回合对模型而言根本没发生过;它们碰过的文件又被恢复到了修改前 —— 模型看到的
  // 对话与磁盘是自洽的,再告知「第 N 回合的修改已被撤销」反而是在讲一个它看不到的回合。反过来,截断前已经在待告知里的记录
  // (用户先在界面撤了第 4 回合的文件、没发消息就回退到第 3 回合)指向的回合同样被丢了,一并清掉,不留一句悬空的告知。
  // 截断被代数闸顶掉(上面已 return rewind_superseded)时不走到这里。
  await checkpoints.prune(sessionId, target).catch(() => {});
  await storage.bumpMissionChangeSeq(sessionId, {
    type: 'rewind',
    cursor: { targetTurnSeq: target },
    detail: {
      removedTurns, rollbackFiles: Boolean(rollbackFiles),
      filesReverted: filesReverted.length, filesFailed: filesFailed.length,
      turnsWithoutCheckpoint: turnsWithoutCheckpoint.length,   // 116-3 P1-4
    },
  });
  // 128f-⑫:回退改的是对话本身(「它刚说」换成更早那一句),五态与等你数往往不变,13r 的「只在看得见的变了才推」
  // 那一路判不出来 —— 这里显式派一发,焦点栏与中栏据此重读。
  events.emit('thread.state', { sessionId });
  return { ok: true, removedTurns, lastUserText, filesReverted, filesFailed, turnsWithoutCheckpoint };
}

return { rewindSession, admissionBlocked };
}
module.exports = { createSessionRewind };
