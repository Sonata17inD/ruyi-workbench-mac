'use strict';

function createStewardRunnerState({
  STEWARD_TURN_DAY_MS, STEWARD_TURN_WINDOW_MS, stewardArbiterState, stewardDayCost, stewardRunnerRuntime, stewardTurnsInWindow,
}) {
  // GET /api/steward/state 的运行器半边(13g 把它并进收件箱状态里一起下发)。
  async function stewardRunnerState(config) {
    const now = Date.now();
    return {
      visit: { startedAt: stewardRunnerRuntime.visit.startedAt, lastActivityAt: stewardRunnerRuntime.visit.lastActivityAt },
      turns: { hour: stewardTurnsInWindow(now, STEWARD_TURN_WINDOW_MS), day: stewardTurnsInWindow(now, STEWARD_TURN_DAY_MS) },
      cost: { day: await stewardDayCost(config).catch(() => 0) },
      circuit: stewardRunnerRuntime.circuit,
      lastReply: stewardRunnerRuntime.lastReply,
      stopped: stewardRunnerRuntime.stopped,
      inflight: stewardRunnerRuntime.inflight ? stewardRunnerRuntime.inflight.kind : '',
      queued: stewardRunnerRuntime.queue.length,
      noProgress: stewardRunnerRuntime.noProgress,
      // 116h:线程仲裁器的快照并进同一条状态路由 —— 看板顶部的「同时最多 N 条」与每行的等待原因
      // 读的是同一份事实,不必再多请求一次(独立的 GET /api/steward/arbiter 仍在,供只关心仲裁的调用方)。
      arbiter: await stewardArbiterState(config).catch(() => null),
    };
  }
  return stewardRunnerState;
}

// 133e:/api/steward/message 带来的附件记录 —— 与 04 makeAttachmentRecord 同形(id/name/path/size/kind),只收这几个字段、≤12 条。
function stewardSanitizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw.slice(0, 12)) {
    if (!a || typeof a !== 'object') continue;
    const id = String(a.id || '').slice(0, 80), name = String(a.name || '').slice(0, 260);
    if (!id || !name) continue;
    const rec = { id, name, path: String(a.path || '').slice(0, 1200), size: Math.max(0, Number(a.size) || 0) };
    if (a.kind === 'audio') rec.kind = 'audio';
    if (typeof a.textPreview === 'string') rec.textPreview = a.textPreview.slice(0, 4000);
    out.push(rec);
  }
  return out;
}

module.exports = { createStewardRunnerState, stewardSanitizeAttachments };
