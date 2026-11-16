'use strict';
// Coordinates container records with authoritative session heads through explicit ports.
function createMissionMembership({ store, sessions, events, logEvent, safeSessionId }) {
const { safeMissionId, missionClipText, readMissionContainer, listMissionContainers, missionContainerFail, createMissionContainer, patchMissionContainer, missionIndexAdd, missionIndexRemove, archiveMissionContainer, mergeMissionAcceptance, MISSION_CONTAINER_LIMITS } = store;
// 归属变更落一条 Mission Change(收件箱能看见事项级动作)。无 mission 账本的会话由
// sessions.recordChange 自身 no-op —— 这正是 §11.6 登记过的既有语义,这里不另开旁路。
function noteMissionMembership(sessionId, action, detail) {
  return sessions.recordChange(sessionId, {
    type: 'mission_membership',
    detail: Object.assign({ action: String(action || '') }, detail || {}),
  }).catch(() => null);
}

// 与会话头对账后的线程集合:事项文件的 sessionIds 是权威索引,但只有会话头 `missionId` 指回来的
// 才算数(文件损坏/回滚/手工删会话之后自愈的唯一入口)。
async function reconcileMissionThreads(missionId, metas) {
  const id = safeMissionId(missionId);
  if (!id) return [];
  const rows = Array.isArray(metas) ? metas : await sessions.list().catch(() => []);
  return rows.filter(meta => meta && (meta.missionId || meta.id) === id).map(meta => meta.id);
}

async function missionAttachThread(missionId, sessionId) {
  const id = safeMissionId(missionId), sid = safeSessionId(sessionId);
  if (!id || !sid) return missionContainerFail('invalid_request', 'invalid missionId or sessionId');
  const container = await readMissionContainer(id);
  if (!container) return missionContainerFail('not_found', 'mission ' + id + ' not found');
  const head = await sessions.readHead(sid);
  if (!head || !head.id) return missionContainerFail('session_not_found', 'thread ' + sid + ' not found');
  if (head.kind === 'steward') return missionContainerFail('invalid_target', 'the steward session is not a thread and cannot join a mission');
  const previousMissionId = sessions.missionId(head) || sid;
  if (previousMissionId !== id) {
    await sessions.updateMeta(sid, { missionId: id });
    if (previousMissionId !== sid) await missionIndexRemove(previousMissionId, sid);   // 旧事项的反向索引同步摘除
    await noteMissionMembership(sid, 'attach', { missionId: id, previousMissionId });
  }
  await missionIndexAdd(id, sid);                                                       // 幂等
  // 121-K2a(§6.1 第 4 条):线程改了归属。只在真的变过时派 —— 幂等的重复 attach 不是一件「发生的事」。
  if (previousMissionId !== id) events.emit('thread.adopted', { sessionId: sid, missionId: id, title: String((head && head.title) || '') });
  return { ok: true, missionId: id, sessionId: sid, changed: previousMissionId !== id, mission: await readMissionContainer(id) };
}

// 移出 = 回到「未归类」(missionId === sessionId)。目标事项必须存在(404),这样「移出一个不存在的
// 事项」不会被静默当成成功。
async function missionDetachThread(missionId, sessionId) {
  const id = safeMissionId(missionId), sid = safeSessionId(sessionId);
  if (!id || !sid) return missionContainerFail('invalid_request', 'invalid missionId or sessionId');
  const container = await readMissionContainer(id);
  if (!container) return missionContainerFail('not_found', 'mission ' + id + ' not found');
  const head = await sessions.readHead(sid);
  if (!head || !head.id) return missionContainerFail('session_not_found', 'thread ' + sid + ' not found');
  if (head.kind === 'steward') return missionContainerFail('invalid_target', 'the steward session is not a thread');
  const previousMissionId = sessions.missionId(head) || sid;
  const changed = previousMissionId === id;
  if (changed) {
    await sessions.updateMeta(sid, { missionId: sid });
    await noteMissionMembership(sid, 'detach', { missionId: id, previousMissionId });
  }
  await missionIndexRemove(id, sid);                                                    // 幂等
  return { ok: true, missionId: id, sessionId: sid, changed, mission: await readMissionContainer(id) };
}

// 合并:from 的全部线程 attach 到 target、验收项按文本去重并入、from 标 archivedAt。
// 幂等的来源不是标记位,而是三个子操作各自幂等:attach 幂等、验收去重幂等、archive 幂等 ——
// 所以「再合一次」天然零变化,不需要判断「是否已合过」。
async function missionMergeInto(targetMissionId, fromMissionId) {
  const targetId = safeMissionId(targetMissionId), fromId = safeMissionId(fromMissionId);
  if (!targetId || !fromId) return missionContainerFail('invalid_request', 'invalid missionId');
  if (targetId === fromId) return missionContainerFail('invalid_request', 'cannot merge a mission into itself');
  const target = await readMissionContainer(targetId);
  if (!target) return missionContainerFail('not_found', 'mission ' + targetId + ' not found');
  const from = await readMissionContainer(fromId);
  if (!from) return missionContainerFail('not_found', 'mission ' + fromId + ' not found');

  const metas = await sessions.list().catch(() => []);
  const threads = new Set(await reconcileMissionThreads(fromId, metas));
  for (const sid of from.sessionIds) threads.add(sid);
  const moved = [];
  for (const sid of threads) {
    const result = await missionAttachThread(targetId, sid);
    if (result && result.ok) moved.push(sid);
  }
  const merged = await patchMissionContainer(targetId, {
    acceptance: mergeMissionAcceptance((await readMissionContainer(targetId) || target).acceptance, from.acceptance),
  });
  await archiveMissionContainer(fromId);
  logEvent({ kind: 'mission_container_merged', missionId: targetId, fromMissionId: fromId, threads: moved.length });
  return {
    ok: true, missionId: targetId, fromMissionId: fromId, movedSessionIds: moved,
    mission: (merged && merged.ok ? merged.mission : await readMissionContainer(targetId)),
    archived: await readMissionContainer(fromId),
  };
}

// 拆分:把源事项的一部分线程拆到一个新事项。幂等键 = 「同一组 sessionIds 已经完整落在一个同名
// 未归档事项里」—— 重复调用返回那个事项而不是再建一个同名空壳。
async function missionSplitThreads(sourceMissionId, sessionIds, title) {
  const sourceId = safeMissionId(sourceMissionId);
  if (!sourceId) return missionContainerFail('invalid_request', 'invalid missionId');
  const source = await readMissionContainer(sourceId);
  if (!source) return missionContainerFail('not_found', 'mission ' + sourceId + ' not found');
  const wantedTitle = missionClipText(title, MISSION_CONTAINER_LIMITS.titleChars);
  if (!wantedTitle) return missionContainerFail('invalid_request', 'title is required');
  const wanted = [];
  for (const value of (Array.isArray(sessionIds) ? sessionIds : [])) {
    const sid = safeSessionId(value);
    if (sid && !wanted.includes(sid)) wanted.push(sid);
  }
  if (!wanted.length) return missionContainerFail('invalid_request', 'sessionIds must contain at least one thread');

  const metas = await sessions.list().catch(() => []);
  const sameSet = (a, b) => a.length === b.length && a.slice().sort().join(',') === b.slice().sort().join(',');
  for (const candidate of await listMissionContainers()) {
    if (candidate.archivedAt || candidate.title !== wantedTitle || candidate.missionId === sourceId) continue;
    if (sameSet(await reconcileMissionThreads(candidate.missionId, metas), wanted)) {
      return { ok: true, missionId: candidate.missionId, mission: candidate, created: false, movedSessionIds: [] };
    }
  }

  const created = await createMissionContainer({ title: wantedTitle, cwd: source.cwd, budget: source.budget });
  if (!created.ok) return created;
  const moved = [];
  for (const sid of wanted) {
    const result = await missionAttachThread(created.mission.missionId, sid);
    if (result && result.ok) moved.push(sid);
  }
  logEvent({ kind: 'mission_container_split', missionId: created.mission.missionId, fromMissionId: sourceId, threads: moved.length });
  return { ok: true, missionId: created.mission.missionId, mission: await readMissionContainer(created.mission.missionId), created: true, movedSessionIds: moved };
}
return { missionAttachThread, missionDetachThread, missionMergeInto, missionSplitThreads };
}
module.exports = { createMissionMembership };
