'use strict';

// hunt2-P2:删除墓碑。id → { at, purgeAssociated }。stopSession 只是 abort,被停回合的收尾 saveSession(以及任何
// 手里还攥着旧会话对象的旁路写者)会在 unlink 之后把头与正文整份写回 —— 会话「复活」,列表里又出现、GET 200。
// saveSession 在【写链内】查墓碑:createdAt 不晚于删除时刻的对象 = 删除之前就存在的那条会话的副本,整次写丢弃。
// 用 createdAt 而不是「有墓碑就拒」:固定 id 的会话(管家 STEWARD_SESSION_ID)删掉后会以同一个 id 重建,
// 新对象的 createdAt 晚于删除时刻,照常落盘;createSession 另外显式清墓碑。条目只活在本进程(重启后没有
// 在飞的旧对象),有上限防长驻进程无界增长。
function createSessionTombstones() {
  const SESSION_DELETE_TOMBSTONE_MAX = 5000;
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

  function clearDeletedSession(id) {
    return sessionDeleteTombstones.delete(id);
  }
  return { markSessionDeleted, sessionSaveIsTombstoned, sessionAssociatedSaveIsTombstoned, clearDeletedSession };
}

module.exports = { createSessionTombstones };
