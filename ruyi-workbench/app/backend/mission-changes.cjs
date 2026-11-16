'use strict';
const { runKeyedChain } = require('./keyed-chain.cjs');
const path = require('node:path');
const fsp = require('node:fs/promises');
// Owns mission revision high-water, change journal serialization and signal throttles.
// Session head mutations share the persistence queue; a missing journal revision
// remains visible as a gap, never manufactured into a successful record.
function createMissionChanges({ paths, sessionPath, sessionWriteChains, readFileTail,
   atomicWriteJson, nowIso, sessionMissionId, invalidateReads, events: RUYI_EVENTS }) {
const missionChangeSeqHighWater = new Map();
function revisionOf(id) { return missionChangeSeqHighWater.get(id) || 0; }
function seedRevision(id, revision) {
  missionChangeSeqHighWater.set(id, Math.max(revisionOf(id), Number(revision) || 0));
}
const MISSION_CHANGE_TYPES = new Set([
  'mission_started', 'progress', 'failure', 'budget', 'intervention_pending',
  'intervention_resolved', 'result', 'rewind', 'run_deleted',
  // 116-2b(27 号文 §11.6「116b 登记的缺口」):停滞与预算触顶此前只走 SSE 与审计日志,没有任何
  // 带 seq 的持久记录 —— 收件箱(它只读三条 seq 日志)因此永远拿不到这两类信号。这里【只加不改】
  // 两个新 type:'stalled'(语义死循环纠偏/节点无进展等"还在跑但没往前走")与 'budget_tripped'
  // (回合 token 预算保护触顶)。既有九种的形状、顺序、语义一律不动。
  'stalled', 'budget_tripped',
  // 116g(27 号文 §3.1「事项跨会话升格」):线程加入/移出事项、事项合并/拆分。只加不改 —— 既有
  // 十一种的形状、顺序、语义一律不动。它【不】属于收件箱五类(它是归属变更,不是"需要你/失败/收工/
  // 停滞/预算"),故 13g 的 STEWARD_SOURCE_EVENT_MAP 把它登记为 null(显式丢弃,不是漏登)。
  'mission_membership',
]);
const missionChangeWriteChains = new Map();
function missionChangeFilePath(sessionId) {
  return path.join(paths.sessions, `${sessionId}.changes.ndjson`);
}
function boundedChangeText(value, max = 240) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}
function normalizeMissionChangePayload(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const type = MISSION_CHANGE_TYPES.has(input.type) ? input.type : 'progress';
  const cursor = input.cursor && typeof input.cursor === 'object' && !Array.isArray(input.cursor)
    ? Object.fromEntries(Object.entries(input.cursor).slice(0, 12).map(([key, value]) => [boundedChangeText(key, 40), typeof value === 'number' ? value : boundedChangeText(value, 160)]))
    : {};
  const detail = input.detail && typeof input.detail === 'object' && !Array.isArray(input.detail)
    ? Object.fromEntries(Object.entries(input.detail).slice(0, 20).map(([key, value]) => {
      if (typeof value === 'number' || typeof value === 'boolean' || value === null) return [boundedChangeText(key, 40), value];
      if (Array.isArray(value)) return [boundedChangeText(key, 40), value.slice(0, 20).map(item => boundedChangeText(item, 240))];
      return [boundedChangeText(key, 40), boundedChangeText(value, 480)];
    }))
    : {};
  return { type, cursor, detail };
}
// 117q-B6(30 号文 P2-11):此前 repairMissionChangeTornTail(本函数)与 repairInterventionTornTail(旧
// 71a 撕裂尾修复,02:344 一带)是同一算法的两份手写——真身是本函数(已被 13g/13i 两处共用),旧函数
// 只有 appendIntervention 一个调用点,已删,该调用点改调本函数(见下方 appendIntervention)。
// 读取原语收编进 01-config.js 的 readFileTail(30 号文 P2-10)——原实现用 Buffer.allocUnsafe 且不检查
// fd.read 的 bytesRead,直接对整段已分配 buffer 取最后一字节 / lastIndexOf;若实际读到的字节数少于
// 请求的 65536(stat 与 read 之间文件被截短等罕见竞态),就是在对未初始化/陈旧内存算截断点——而这个
// 截断点会被拿去 fsp.truncate()。这里【一律按 bytesRead 定界】(不用 buf.length/请求的窗口大小),
// 这就是修 bug 的那一步;尾窗起点 start 仍按原请求窗口(size - 65536)计算,与原逻辑一致。
async function repairMissionChangeTornTail(file) {
  const TAIL = 65536;
  const { buf, bytesRead, size } = await readFileTail(file, TAIL);
  if (size <= 0 || !bytesRead) return; // 不存在(-1)/空文件(0)/尾窗读到 0 字节(无数据可判)
  if (buf[bytesRead - 1] === 0x0a) return; // 按 bytesRead 定界:只看已实际读到的最后一个字节
  const lastNl = buf.lastIndexOf(0x0a, bytesRead - 1); // 搜索起点同样钉在 bytesRead-1,不扫未读区
  const start = Math.max(0, size - TAIL);
  await fsp.truncate(file, lastNl === -1 ? start : start + lastNl + 1);
}
function appendMissionChangeRecord(sessionId, record) {
  const sid = String(sessionId || '');
  if (!sid) return Promise.resolve();
  const file = missionChangeFilePath(sid);
  return runKeyedChain(missionChangeWriteChains, sid, async () => {
    await repairMissionChangeTornTail(file);
    await fsp.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
    RUYI_EVENTS.emit('projection.invalidated', { sessionId: sid, reason: 'source' });
  });
}
function foldMissionChangeJournalText(txt, currentRevision = 0) {
  const records = [];
  let corruptLines = 0;
  for (const line of String(txt || '').split('\n')) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { corruptLines++; continue; }
    const seq = Number(record && record.seq);
    if (!record || !Number.isSafeInteger(seq) || seq < 1 || !MISSION_CHANGE_TYPES.has(record.type)) { corruptLines++; continue; }
    records.push(record);
  }
  records.sort((a, b) => Number(a.seq) - Number(b.seq));
  const baseRevision = records.length ? Number(records[0].seq) - 1 : Math.max(0, Number(currentRevision) || 0);
  let gap = null;
  for (let i = 1; i < records.length; i++) {
    const expected = Number(records[i - 1].seq) + 1;
    const actual = Number(records[i].seq);
    if (actual !== expected) { gap = { expected, actual }; break; }
  }
  const lastRevision = records.length ? Number(records[records.length - 1].seq) : baseRevision;
  const current = Math.max(0, Number(currentRevision) || 0);
  if (!gap && lastRevision < current) gap = { expected: lastRevision + 1, actual: current + 1, tail: true };
  if (!gap && lastRevision > current) gap = { expected: current + 1, actual: lastRevision, ahead: true };
  return { records, baseRevision, currentRevision: current, lastRevision, corruptLines, gap, degraded: corruptLines > 0 || Boolean(gap) };
}
async function readMissionChangesWithMeta(sessionId, currentRevision = null) {
  const sid = String(sessionId || '');
  let current = currentRevision == null ? NaN : Number(currentRevision);
  if (!Number.isSafeInteger(current) || current < 0) {
    try {
      const head = JSON.parse(await fsp.readFile(sessionPath(sid), 'utf8'));
      current = Math.max(0, Number(head && head.mission && head.mission.changeSeq) || 0);
    } catch { current = 0; }
  }
  let txt = '';
  try { txt = await fsp.readFile(missionChangeFilePath(sid), 'utf8'); } catch { /* missing journal = migration baseline */ }
  return foldMissionChangeJournalText(txt, current);
}
// Persist a head advance and its record in one per-session chain. The head commits first; a crash between
// head and journal creates a detectable tail gap instead of a silently false summary. Existing callers may
// keep fire-and-forget semantics; routes that need the returned revision can await the promise.
function bumpMissionChangeSeq(sessionId, payload = {}) {
  const sid = String(sessionId || '');
  if (!sid) return Promise.resolve(null);
  const next = (missionChangeSeqHighWater.get(sid) || 0) + 1;
  missionChangeSeqHighWater.set(sid, next); // sync: visible to concurrent saveSession before disk write
  const prev = sessionWriteChains.get(sid) || Promise.resolve();
  const w = prev.catch(() => {}).then(async () => {
    let txt; try { txt = await fsp.readFile(sessionPath(sid), 'utf8'); } catch { if (missionChangeSeqHighWater.get(sid) === next) missionChangeSeqHighWater.delete(sid); return null; }
    let head; try { head = JSON.parse(txt); } catch { if (missionChangeSeqHighWater.get(sid) === next) missionChangeSeqHighWater.delete(sid); return null; }
    if (!head || !head.mission || typeof head.mission !== 'object') { if (missionChangeSeqHighWater.get(sid) === next) missionChangeSeqHighWater.delete(sid); return null; }
    const revision = Math.max(next, Number(head.mission.changeSeq) + 1 || 1);
    missionChangeSeqHighWater.set(sid, revision);
    head.mission.changeSeq = revision;
    head.mission.updatedAt = nowIso();
    invalidateReads(sid);   // 头被改写:在此之前读到头的装载不得再回写旧副本
    await atomicWriteJson(sessionPath(sid), JSON.stringify(head, null, 2));
    const normalized = normalizeMissionChangePayload(payload);
    await appendMissionChangeRecord(sid, {
      schemaVersion: 1,
      missionId: sessionMissionId(head) || sid,
      sessionId: sid,
      seq: revision,
      type: normalized.type,
      occurredAt: nowIso(),
      cursor: normalized.cursor,
      detail: normalized.detail,
    });
    return revision;
  }).catch(() => null);
  sessionWriteChains.set(sid, w);
  w.then(() => { if (sessionWriteChains.get(sid) === w) sessionWriteChains.delete(sid); }, () => { if (sessionWriteChains.get(sid) === w) sessionWriteChains.delete(sid); });
  return w;
}

// ── 116-2b:停滞/预算信号的【写入端频控】────────────────────────────────────────────────────
// 为什么频控放在写入端而不是读取端(收件箱):loop_recovery 每纠偏一次就是一条信号,一个卡住的
// 回合几分钟内能刷十几条 —— 让它们全都落进 append-only 账本,等于用噪声把账本本身撑坏,读取端
// 再怎么去重也救不回已经写进去的字节。故:同一 run/会话的 stalled 五分钟内只落一条;
// budget_tripped 每回合最多一条(触顶后回合就 break 了,同一 turnSeq 不该有第二条)。
//
// 表只在内存(进程重启 = 窗口重开)。这是刻意的:重启后第一条信号值得记 —— 崩溃续跑本身就是
// 用户该知道的事,宁可多一条也不要把"重启后仍然卡住"这条静音掉。
const MISSION_STALL_SIGNAL_WINDOW_MS = 5 * 60 * 1000;
const missionSignalThrottleAt = new Map();     // key -> 上次落账时间(ms)
const missionBudgetTripTurns = new Map();      // sessionId -> 已落过 budget_tripped 的 turnSeq
// 窗口内已经落过就返回 false(并保留旧时间戳);允许就记下本次时间并返回 true。表超过 500 条时
// 顺带清一遍过期项(信号稀疏,清理成本可忽略;不设 timer 以免开关关时也有后台活动)。
function missionSignalThrottleAllow(key, windowMs) {
  const k = String(key || '');
  if (!k) return false;
  const now = Date.now();
  const window = Number(windowMs) || MISSION_STALL_SIGNAL_WINDOW_MS;
  const last = missionSignalThrottleAt.get(k);
  if (Number.isFinite(last) && now - last < window) return false;
  if (missionSignalThrottleAt.size > 500) {
    for (const [key2, at] of missionSignalThrottleAt) if (now - at >= window) missionSignalThrottleAt.delete(key2);
  }
  missionSignalThrottleAt.set(k, now);
  return true;
}
// 普通回合的停滞信号 → change type 'stalled'。detail 只带摘要与计数(reason/tool/count),永不带
// 工具输出正文 —— 与 'failure' 的 detail 纪律同口径。无 mission 的会话由 bumpMissionChangeSeq
// 自己 no-op(它读会话头,没有 head.mission 就直接返回 null),这里不重复判断。
function recordMissionStalledChange(sessionId, detail) {
  const sid = String(sessionId || '');
  if (!sid) return Promise.resolve(null);
  if (!missionSignalThrottleAllow('mission:' + sid, MISSION_STALL_SIGNAL_WINDOW_MS)) return Promise.resolve(null);
  const d = (detail && typeof detail === 'object') ? detail : {};
  return bumpMissionChangeSeq(sid, {
    type: 'stalled',
    cursor: { turnSeq: Number(d.turnSeq) || 0, engine: String(d.engine || '') },
    detail: {
      reason: String(d.reason || ''),
      tool: String(d.tool || ''),
      count: Number(d.count) || 0,
      remaining: Number(d.remaining) || 0,
    },
  });
}
// 回合 token 预算保护触顶 → change type 'budget_tripped'(注意与既有 'budget' 区别:后者是每回合
// 用量入账的心跳,116b 已判定为心跳丢弃;真正的"触顶"从本波起有自己的 type)。
function recordMissionBudgetTrippedChange(sessionId, detail) {
  const sid = String(sessionId || '');
  if (!sid) return Promise.resolve(null);
  const d = (detail && typeof detail === 'object') ? detail : {};
  const turnSeq = Number(d.turnSeq) || 0;
  if (missionBudgetTripTurns.get(sid) === turnSeq) return Promise.resolve(null); // 每回合最多一条
  missionBudgetTripTurns.set(sid, turnSeq);
  if (missionBudgetTripTurns.size > 500) {
    for (const [key2] of missionBudgetTripTurns) { missionBudgetTripTurns.delete(key2); if (missionBudgetTripTurns.size <= 400) break; }
  }
  return bumpMissionChangeSeq(sid, {
    type: 'budget_tripped',
    cursor: { turnSeq, engine: String(d.engine || '') },
    detail: {
      axis: String(d.axis || ''),
      spent: Number(d.spent) || 0,
      budget: Number(d.budget) || 0,
      reserveEstimate: Number(d.reserveEstimate) || 0,
    },
  });
}
return { missionChangeFilePath, boundedChangeText, normalizeMissionChangePayload, repairMissionChangeTornTail, appendMissionChangeRecord, foldMissionChangeJournalText, readMissionChangesWithMeta, bumpMissionChangeSeq, missionSignalThrottleAllow, recordMissionStalledChange, recordMissionBudgetTrippedChange, MISSION_CHANGE_TYPES, MISSION_STALL_SIGNAL_WINDOW_MS, revisionOf, seedRevision };
}
module.exports = { createMissionChanges };
