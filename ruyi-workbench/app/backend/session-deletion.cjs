'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const fsp = require('node:fs/promises');
// Owns deletion tombstones and teardown ordering. No agent, transport or model imports.
function createSessionDeletion({
  paths, assertSessionIdForPath, safeSessionId, logEvent,
  files: { sessionPath, sessionBodyPaths, interventionFilePath, missionChangeFilePath,
    sessionNotesPath, sessionScratchpadPath, journalDir, agentRunDir },
  pendingWrites: { sessionWriteChains, sessionScratchpadChains },
  execution, membership, index, invalidateSessionState, events,
}) {
const SESSION_DELETE_TOMBSTONE_MAX = 5000;
const SESSION_DELETE_SETTLE_TIMEOUT_MS = 8000;   // 与 rewindSession 等垂死回合 settle 的窗口同值
const sessionDeleteTombstones = new Map();
function markSessionDeleted(id, purgeAssociated = false) {
  const previous = sessionDeleteTombstones.get(id);
  sessionDeleteTombstones.delete(id);
  sessionDeleteTombstones.set(id, { at: Date.now(), purgeAssociated: Boolean(purgeAssociated || (previous && previous.purgeAssociated)) });
  while (sessionDeleteTombstones.size > SESSION_DELETE_TOMBSTONE_MAX) sessionDeleteTombstones.delete(sessionDeleteTombstones.keys().next().value);
}
function sessionSaveIsTombstoned(session) {
  const deleted = sessionDeleteTombstones.get(session && session.id);
  if (!deleted) return false;
  const createdMs = Date.parse(String((session && session.createdAt) || ''));
  return !Number.isFinite(createdMs) || createdMs <= deleted.at;
}
function sessionAssociatedSaveIsTombstoned(id) {
  const deleted = sessionDeleteTombstones.get(id);
  return !!(deleted && deleted.purgeAssociated);
}
// Delete the persisted chat itself. `purgeAssociated` is deliberately opt-in: a normal single-chat
// delete keeps its previous, conservative behavior, while the batch-cleanup flow can also reclaim
// the per-chat recovery and workflow records that otherwise have their own GC lifecycle.
// 工具截图附件(10 boundToolResultForDisplay)落在 uploads/toolimg_<tag>_<hash>/,tag 由会话 id 派生;删会话时按前缀整批清,
// 否则长时间的桌面操控会话会在 uploads/ 里留下成百上千个永不回收的文件。
function toolImageSessionTag(sessionId) { return crypto.createHash('sha1').update(String(sessionId)).digest('hex').slice(0, 10); }
async function removeSessionToolImages(sessionId) {
  const prefix = `toolimg_${toolImageSessionTag(sessionId)}_`;
  let names = [];
  try { names = await fsp.readdir(paths.uploads); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    await fsp.rm(path.join(paths.uploads, name), { recursive: true, force: true }).then(() => { n += 1; }).catch(() => {});
  }
  return n;
}
async function deleteSession(id, { purgeAssociated = false } = {}) {
  // 不合形/保留名(index、`_` 前缀 …,见 01 safeSessionId)先拒:修前 DELETE /api/sessions/index 一路走到 unlink index.json。
  assertSessionIdForPath(id);
  // hunt2-P2:先立墓碑(同步,先于 stopSession 触发的任何收尾),再等垂死回合 settle 与已在跑的那一截写链
  // 落完,最后才 unlink —— 否则 unlink 与正在进行的 append/头写交错,删完还会剩下半份文件。
  markSessionDeleted(id, purgeAssociated);
  execution.stop(id, 'deleted');
  // 后台班组不在 activeChildren 里。删除线程同样要停它们,否则它们仍会派发后续节点。
  // 停止只请求 abort,不是等待收尾;清关联数据时还要等已在飞的快照/事件写完,迟到写由同一墓碑拒掉。
  const deletedRunIds = new Set([...execution.activeRuns()].filter(live => live && live.run && live.run.sessionId === id).map(live => live.run.id));
  await execution.stopRuns(id);
  {
    const settler = execution.settler(id);
    if (settler && settler.promise) {
      let settleTimer;
      const settled = await Promise.race([
        settler.promise.then(() => true, () => true),
        new Promise(r => { settleTimer = setTimeout(() => r(false), SESSION_DELETE_SETTLE_TIMEOUT_MS); settleTimer.unref?.(); }),
      ]).finally(() => clearTimeout(settleTimer));
      if (!settled) logEvent({ kind: 'session_delete_settle_timeout', sessionId: id });
    }
    const inFlight = sessionWriteChains.get(id);
    if (inFlight) await inFlight.catch(() => {});
    // C2:草稿本那一截写链同样先落完再 unlink(墓碑已立,之后排进来的写会被 updateSessionScratchpad 拒掉)。
    const scratchpadInFlight = sessionScratchpadChains.get(id);
    if (scratchpadInFlight) await scratchpadInFlight.catch(() => {});
  }
  try { execution.revokeGrants(id, 'session-deleted'); } catch { /* best-effort */ } // 第27波:会话销毁 → 授权书全清
  // 116g:删线程 = 从它所在事项的反向索引里摘掉。**必须在删会话头之前读**(头没了就不知道它属于谁)。
  // 漏掉这一步不会让读模型说错话(读侧一律与会话头对账,死 id 天然不进任何视图),但会让事项文件里
  // 留一条永远对不上的 id —— 索引是权威,权威里不该有垃圾。尽力而为,任何失败都不阻断删除。
  try {
    const head = await membership.readHead(id);
    const owner = head && membership.ownerOf(head);
    if (owner && owner !== id) await membership.remove(owner, id);
  } catch { /* best-effort: 读侧对账兜底 */ }
  await fsp.unlink(sessionPath(id)).catch(() => {}); // idempotent
  // v1.9 存储 v2:正文/迁移备份/损坏隔离副本一并清(用户删会话 = 删除其全部数据载体)。
  const bp = sessionBodyPaths(id);
  const proposalSessionId = safeSessionId(id);
  await Promise.all([
    fsp.unlink(bp.messages).catch(() => {}),
    fsp.unlink(bp.provider).catch(() => {}),
    fsp.unlink(sessionPath(id) + '.v1bak').catch(() => {}),
    fsp.unlink(sessionPath(id) + '.corrupt').catch(() => {}),
    fsp.unlink(bp.messages + '.corrupt').catch(() => {}),
    fsp.unlink(bp.provider + '.corrupt').catch(() => {}),
    fsp.unlink(bp.messages + '.prevbody').catch(() => {}),
    fsp.unlink(bp.provider + '.prevbody').catch(() => {}),
    fsp.unlink(interventionFilePath(id)).catch(() => {}),
    fsp.unlink(missionChangeFilePath(id)).catch(() => {}),
    // hunt2-P9:会话笔记旁车与每会话 MCP 配置(内含 loopback token 与外部 MCP 的 env)同属这条会话的数据载体。
    fsp.unlink(sessionNotesPath(id)).catch(() => {}),
    fsp.unlink(sessionScratchpadPath(id)).catch(() => {}),   // C2:会话草稿本旁车
    proposalSessionId ? fsp.unlink(path.join(paths.generated, `workbench.mcp.${proposalSessionId}.json`)).catch(() => {}) : Promise.resolve(),
    proposalSessionId ? fsp.unlink(path.join(paths.memory, 'proposals', proposalSessionId + '.json')).catch(() => {}) : Promise.resolve(),
    // hunt2 #19:后台任务账本(11 backgroundJobFile,同一 safeSessionId 闸)—— 含命令输出/代理信封,随会话一起删。
    proposalSessionId ? fsp.unlink(path.join(paths.sessions, 'background-jobs', proposalSessionId + '.json')).catch(() => {}) : Promise.resolve(),
  ]);
  await removeSessionToolImages(id);
  invalidateSessionState(id);
  if (purgeAssociated) {
    await execution.flushRuns(id, deletedRunIds);
    await Promise.all([
      fsp.rm(journalDir(id), { recursive: true, force: true }).catch(() => {}),
      fsp.rm(agentRunDir(id), { recursive: true, force: true }).catch(() => {}),
    ]);
  }
  index.remove(id); // PF2: queue removal from the metadata index (debounced; see saveSession)
  events.emit('projection.invalidated', { sessionId: id, reason: 'source' }); // 75c: remove from disposable Mission/Intervention projection index
  // 128f-⑫(用户 2026-09-19「删除线程没有及时的界面反馈」):删完告诉所有在看的人「这一条没了」。
  // 修前一帧都不派,管家视角的左栏要等 15 s 那一拍轮询或用户点别处(13r 的 thread.removed 头注)。
  events.emit('thread.removed', { sessionId: id });
  return { ok: true, id, purgedAssociated: Boolean(purgeAssociated) };
}

// Safety-first bulk history cleanup. It can only delete UNPINNED chats, preserves the explicitly
// supplied current chat, and refuses to tear down a currently-running chat. This keeps the UI action
// useful for clearing history without turning a single misclick into a "delete everything" operation.
async function bulkDeleteUnpinnedSessions({ preserveSessionId, purgeAssociated = false } = {}) {
  const preserveId = safeSessionId(preserveSessionId);
  const sessions = await index.list();
  const deleted = [];
  const skipped = { pinned: 0, preserved: 0, active: 0 };
  for (const meta of sessions) {
    if (!meta || !meta.id) continue;
    if (meta.pinned) { skipped.pinned++; continue; }
    if (preserveId && meta.id === preserveId) { skipped.preserved++; continue; }
    if (execution.isActive(meta.id)) { skipped.active++; continue; }
    await deleteSession(meta.id, { purgeAssociated });
    deleted.push(meta.id);
  }
  return { ok: true, deleted, deletedCount: deleted.length, skipped, purgedAssociated: Boolean(purgeAssociated) };
}

return { deleteSession, bulkDeleteUnpinnedSessions, markSessionDeleted, sessionSaveIsTombstoned, sessionAssociatedSaveIsTombstoned, toolImageSessionTag, removeSessionToolImages, clearDeletedSession: id => sessionDeleteTombstones.delete(id) };
}
module.exports = { createSessionDeletion };
