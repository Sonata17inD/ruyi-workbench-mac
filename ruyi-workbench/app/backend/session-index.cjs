'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
// Owns index batches, in-flight overlays and rebuild epochs; heads remain authoritative.
function createSessionIndex({ paths, safeJsonParse, atomicWriteJson, noteSessionsDirOwnWrite, safeSessionId, ensureDirs, sessionMeta, sessionMetaIsSteward, sortSessionMetas }) {
const SESSION_INDEX_FILE = 'index.json';
function sessionIndexPath() { return path.join(paths.sessions, SESSION_INDEX_FILE); }
async function readSessionIndex() {
  try {
    const raw = await fsp.readFile(sessionIndexPath(), 'utf8');
    const arr = safeJsonParse(raw, null);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}
// 索引的【内存镜像】(perf):flushSessionIndex 每个 200 ms 去抖窗口都要「读 → 解析 → 合并 → 整份写」一遍 index.json
// (3000 条会话 ≈ 1.3 MB,每次 ~25 ms,回合进行中每个窗口都在跑)。我们自己刚写下的那份内容就是合并后的 map,
// 下一窗口再读回来解析一遍纯属重复。这里把「刚写下的 map + 写完后立刻取的文件戳」留在内存里:下一次 flush 先取当前文件戳,
// 与镜像的戳相同 = 磁盘上仍是我们写的那一份,直接在镜像 map 上合并,跳过读与解析;戳不同(外部改写/被 invalidate/被
// listSessions 重建覆盖/flushSessionIndexSync 写过/文件不在)一律作废镜像走原来的读盘路径。戳 = 路径 + size + mtimeNs + ino
// (写入是 tmp + rename,每次换 inode)。只有 flushSessionIndex 那一处产生镜像;所有别的写口都不给 map → 镜像作废。
// 镜像只在 withSessionIndexLock 里读写(与索引写同一把锁),无并发。
let sessionIndexMemo = null;   // { stamp, map }
async function sessionIndexFileStamp() {
  try {
    const st = await fsp.stat(sessionIndexPath(), { bigint: true });
    return `${sessionIndexPath()}|${st.size}|${st.mtimeNs}|${st.ino}`;
  } catch { return null; }
}
// Atomic index write (tmp + rename, same discipline as saveSession). Caller wraps failures.
// 第二参 map(可选)= 这份 entries 对应的合并结果,给了就登记成内存镜像(见 sessionIndexMemo)。
async function writeSessionIndex(entries, map = null) {
  sessionIndexMemo = null;   // 写之前先作废:写到一半失败/被别的写口接着覆盖,镜像都不该再被信
  await fsp.mkdir(paths.sessions, { recursive: true });
  await atomicWriteJson(sessionIndexPath(), entries);   // 25.1 收编
  if (map) {
    const stamp = await sessionIndexFileStamp();
    if (stamp) sessionIndexMemo = { stamp, map };
  }
}
async function invalidateSessionIndex() { sessionIndexMemo = null; await fsp.unlink(sessionIndexPath()).catch(() => {}); }
// Serialize all index mutations (single global chain) so concurrent saveSession calls can't lose updates or
// tear the file. Session FILES are still written concurrently; only the shared index write is serialized.
let sessionIndexChain = Promise.resolve();
async function withSessionIndexLock(work) {
  const previous = sessionIndexChain || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  sessionIndexChain = current;
  try { return await current; }
  finally { if (sessionIndexChain === current) sessionIndexChain = Promise.resolve(); }
}
// COALESCED index maintenance. saveSession/deleteSession call scheduleSessionIndexUpdate synchronously (a cheap
// in-memory Map.set); the actual read-modify-write of index.json is DEBOUNCED and batched. This matters two ways:
//  (1) it keeps the saveSession critical path free of index I/O (turns/workflows call it constantly), and
//  (2) a burst of N saves (e.g. a DAG workflow) collapses into ONE index write instead of N, so the background
//      I/O never floods the event loop and delays incoming request handling.
// Durability: the pending batch is in-memory only. Losing it on crash is harmless — the session FILES are the
// source of truth and listSessions rebuilds the index whenever its id-set drifts from disk.
const SESSION_TOMBSTONE = Symbol('session-deleted');
const SESSION_INDEX_FLUSH_MS = 200;
let pendingSessionIndex = new Map(); // id -> meta entry | SESSION_TOMBSTONE (last write per id wins)
// 107-F9a: the IN-FLIGHT table. flushSessionIndex takes the pending batch before it does the I/O (so saves made
// during the write queue up for the next flush); before F9a that batch was then visible NOWHERE until the rename
// landed — not in pendingSessionIndex any more, not on disk yet — and a listSessions landing in those few ms read
// the old index. User-visible (F8, measured): a second split within ~200 ms of the first built a duplicate empty
// mission (split's idempotency check reads listSessions), and a just-attached thread flashed back to "unfiled" in
// the mission list. Every read therefore overlays disk -> in-flight -> pending (newest last); a flush retires its
// entries only after its write settled (landed, dropped or invalidated), and only the entries that are still ITS
// OWN — a later flush may have taken a newer value for the same id, which must stay visible until it lands too.
// Entry shape: id -> { val, flush } where `flush` is the identity token of the flush that owns it.
let inflightSessionIndex = new Map();
// Bumped every time a flush retires its in-flight entries. listSessions compares it across its disk read: a retire
// in between means the file it read may predate the write whose entries just left the table (see listSessions).
let sessionIndexRetireSeq = 0;
let sessionIndexFlushTimer = null;
// 128f-⑧(Brief §4.2 第 22 条前半「扫盘重建路径有一处既有竞态」):扫盘重建是一条条读会话文件、最后整份写回索引 ——
// 扫到 X 之后 X 又被存了一次,而那次存的索引刷新先落了地(或者索引此刻不在、那次刷新直接把批次丢了),重建写回的
// 就是 X 的旧值;之后 id 集合与磁盘对得上,快路径一直信它,直到 X 再被存一次。修:每一次排进索引的写记一个全局序号
// 与最新值(每个 id 只留最新一条);重建在开扫前记下序号,写回时(同一把索引锁里)把开扫之后的写一条条叠上去。
// 只在有重建在扫的时候记(没人扫就没人要叠),最后一个重建收尾时清空 —— 否则这张表会随会话总数只增不减。
let sessionIndexWriteSeq = 0;
let sessionIndexRebuildsActive = 0;
const sessionIndexLatestWrite = new Map();   // id -> { seq, val }(val 与 pendingSessionIndex 同形:meta 或 SESSION_TOMBSTONE)
// 测试口(unit/session-index-rebuild-race 用):扫盘重建每读完一个会话文件调一次,可以在那一刻插一次保存、确定性地造出竞态。
let sessionIndexRebuildScanHook = null;
function setSessionIndexRebuildScanHookForTest(fn) { sessionIndexRebuildScanHook = typeof fn === 'function' ? fn : null; return sessionIndexLatestWrite.size; }
function scheduleSessionIndexUpdate(id, valueOrTombstone) {
  pendingSessionIndex.set(String(id), valueOrTombstone);
  sessionIndexWriteSeq += 1;
  if (sessionIndexRebuildsActive > 0) sessionIndexLatestWrite.set(String(id), { seq: sessionIndexWriteSeq, val: valueOrTombstone });
  if (sessionIndexFlushTimer) return; // a flush is already pending; this entry rides along with it
  sessionIndexFlushTimer = setTimeout(() => { sessionIndexFlushTimer = null; void flushSessionIndex(); }, SESSION_INDEX_FLUSH_MS);
  if (sessionIndexFlushTimer.unref) sessionIndexFlushTimer.unref(); // a cache flush must never keep the process alive
}
// Apply the whole pending batch in a single locked read-modify-write. Best-effort: if there is no valid index
// we drop the batch (listSessions rebuilds from truth); on any error we invalidate so the next read falls back.
async function flushSessionIndex() {
  if (sessionIndexFlushTimer) { clearTimeout(sessionIndexFlushTimer); sessionIndexFlushTimer = null; }
  if (!pendingSessionIndex.size) return;
  // Take the batch so saves made during the I/O queue up for the NEXT flush — but move it into the in-flight table
  // in the same synchronous step, so there is no instant at which a read can miss it (107-F9a, see the table's note).
  const batch = pendingSessionIndex; pendingSessionIndex = new Map();
  const flush = {};   // identity token: which in-flight entries are this flush's to retire
  for (const [id, val] of batch) inflightSessionIndex.set(id, { val, flush });
  try {
    await withSessionIndexLock(async () => {
      try {
        // 镜像命中(文件戳与我们上次写完时一致)就不读盘不解析,直接在镜像 map 上合并;否则走原来的读盘路径。
        const stamp = await sessionIndexFileStamp();
        let map = null;
        if (stamp && sessionIndexMemo && sessionIndexMemo.stamp === stamp) map = sessionIndexMemo.map;
        else {
          sessionIndexMemo = null;
          const index = await readSessionIndex();
          if (!index) return; // no valid index → don't fabricate a partial one; listSessions will rebuild
          map = new Map(index.map(e => [String(e && e.id), e]));
        }
        sessionIndexMemo = null;   // 下面要就地改 map:改到一半失败它就是脏的,写成功后 writeSessionIndex 再登记回来
        for (const [id, val] of batch) { if (val === SESSION_TOMBSTONE) map.delete(id); else map.set(id, val); }
        await writeSessionIndex([...map.values()], map);
      } catch { await invalidateSessionIndex(); }
    }).catch(() => {});
  } finally {
    // The write has settled: it landed (disk now carries the batch), or there was no index to update / the index
    // was invalidated (both send the next listSessions to the authoritative file scan). Either way the entries are
    // no longer needed for read-your-writes. Retire only the ones still owned by THIS flush.
    for (const id of batch.keys()) {
      const entry = inflightSessionIndex.get(id);
      if (entry && entry.flush === flush) inflightSessionIndex.delete(id);
    }
    sessionIndexRetireSeq++;
  }
}
// Apply the not-yet-durable index changes onto a map built from the disk index, oldest first: in-flight (taken by a
// running flush) and then pending (not taken yet, therefore newer). Last write per id wins, tombstones delete.
function overlayUnflushedSessionIndex(map) {
  for (const [id, entry] of inflightSessionIndex) { if (entry.val === SESSION_TOMBSTONE) map.delete(id); else map.set(id, entry.val); }
  for (const [id, val] of pendingSessionIndex) { if (val === SESSION_TOMBSTONE) map.delete(id); else map.set(id, val); }
  return map;
}
// PF2 fix: SYNCHRONOUS flush for the exit path. process.exit() (the SIGINT/SIGTERM handlers, uncaughtException)
// runs 'exit' listeners synchronously, so the async debounced flushSessionIndex above can never complete there —
// a graceful shutdown would silently drop the last ~200ms of metadata updates. Persist the pending batch with
// fs.*Sync using the SAME tmp+rename atomic discipline. Best-effort: on a missing/corrupt index or any error we
// bail (the boot-time invalidateSessionIndex + fallback file scan rebuild from truth regardless).
// 107-F9a: the IN-FLIGHT batch is persisted too. Exiting while an async flush is mid-write abandons that write (its
// rename never runs), and before F9a that batch was already gone from pendingSessionIndex — so it was silently lost.
// Neither table is cleared here: this is a pure "persist everything not yet durable" step, idempotent against the
// async flush that owns the in-flight entries (if the process somehow keeps running, that flush lands the same values).
function flushSessionIndexSync() {
  try {
    if (!pendingSessionIndex.size && !inflightSessionIndex.size) return;
    let index = null;
    try { const arr = safeJsonParse(fs.readFileSync(sessionIndexPath(), 'utf8'), null); index = Array.isArray(arr) ? arr : null; } catch { index = null; }
    if (!index) return; // no valid index → don't fabricate a partial one; boot rebuild + fallback scan self-heal
    const map = overlayUnflushedSessionIndex(new Map(index.map(e => [e && String(e.id), e]).filter(([id]) => id)));
    // 25.1: 这是全文件唯一豁免 atomicWriteJson 的 JSON 写点 —— exit 监听器里只能同步 I/O(async 版永远跑不完)。
    // tmp 名仍按统一纪律取唯一名(pid+随机),防与并行的 async 写者互踩;失败清 tmp。
    const finalPath = sessionIndexPath();
    const tmpPath = finalPath + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify([...map.values()], null, 2), 'utf8');
      fs.renameSync(tmpPath, finalPath);
      noteSessionsDirOwnWrite(finalPath);   // 13e:这次目录变化是自己写的
    } catch (e) { try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ } throw e; }
  } catch { /* best-effort; boot invalidation rebuilds from truth regardless */ }
}

// 「已知坏头」:盘上有 <id>.json,但它读出来不是合法会话(JSON 截断/写坏、不是对象、里面的 id 与文件名对不上)。
// 这种文件永远进不了重建的索引,而快路径比的是「索引 id 集 == 磁盘 id 集」—— 修前一个坏头就让每次 listSessions
// 都判漂移、全量扫盘重建(2000 条会话 ≈ 240–380 ms,侧栏每次刷新都付一遍),而且永不自愈。
// 现在全量扫描时把【确定性判坏】的 id 连同当时的文件戳记在这里,快路径比对时把它们从磁盘 id 集里扣掉。
// 只记确定性的坏(语法错 / 形状错 / id 不符);读文件本身失败(EBUSY/EPERM/被杀毒锁)不记 —— 那是这一次没读到,
// 文件可能是好的,记了会让一条好会话从侧栏消失。文件戳变了(用户把备份拷回去、别的进程重写)就作废、重新扫一遍。
// 只在内存里(进程重启后第一次全量扫描会把它记回来);条目只会因「文件没了 / 索引收下了它 / 文件戳变了」而摘掉。
const sessionIndexKnownBadHeads = new Map();   // id -> 文件戳(size|mtimeMs|ctimeMs)
function sessionHeadStampOf(st) { return `${st.size}|${st.mtimeMs}|${st.ctimeMs}`; }
// 判一份会话头文本:好的返回 meta 源对象,坏的(确定性)返回 null。与全量扫描、记坏头共用同一判据。
function parseSessionHeadForIndex(raw, id) {
  let item;
  try { item = JSON.parse(raw); } catch { return null; }
  // A valid JSON cache or a damaged/misnamed head is not a session. Keep its file untouched,
  // but never publish an entry whose id cannot be opened at this filename.
  if (!item || !safeSessionId(item.id) || item.id !== id) return null;
  return item;
}
// 全量扫描读到一个坏头:先取文件戳、再读一遍重新判(取戳在读之前 → 戳只会比内容老,之后文件再变戳就对不上,保守地重扫)。
async function noteSessionIndexBadHead(id) {
  try {
    const file = path.join(paths.sessions, id + '.json');
    const st = await fsp.stat(file);
    const raw = await fsp.readFile(file, 'utf8');
    if (parseSessionHeadForIndex(raw, id)) return;   // 取戳与重读之间被换成了好文件:不记
    sessionIndexKnownBadHeads.set(id, sessionHeadStampOf(st));
  } catch { /* 读不到(瞬时锁/刚被删):不记,下一次扫描再判 */ }
}
// 快路径用:返回「应当与索引 id 集对得上」的磁盘 id 集 = 磁盘 id 集扣掉仍然有效的已知坏头。
async function sessionDiskIdsExpectedInIndex(diskIds, indexIds) {
  if (!sessionIndexKnownBadHeads.size) return diskIds;
  const out = new Set(diskIds);
  for (const [id, stamp] of [...sessionIndexKnownBadHeads]) {
    // 文件没了 / 索引已经收下它(被重新存成了好会话):不再是「坏头」。
    if (!diskIds.has(id) || indexIds.has(id)) { sessionIndexKnownBadHeads.delete(id); continue; }
    let same = false;
    try { same = sessionHeadStampOf(await fsp.stat(path.join(paths.sessions, id + '.json'))) === stamp; } catch { same = false; }
    if (same) out.delete(id);
    else sessionIndexKnownBadHeads.delete(id);   // 文件变了:不再信旧结论,留在比对里 → 判漂移 → 重新扫一遍
  }
  return out;
}

// List sessions for the sidebar (7 meta fields each). FAST PATH: a valid index whose id-set matches the
// session files on disk exactly. FALLBACK: scan every real session file (source of truth) and rebuild the index.
async function listSessions() {
  await ensureDirs();
  const all = await fsp.readdir(paths.sessions).catch(() => []);
  // Search metadata lives beside session heads. It is not a session and must not enter either
  // the disk id-set or the rebuilt sidebar index (otherwise boot tries to open an undefined id).
  // 判据与 loadSession / 全量扫描同一个 safeSessionId(01):它拒绝 index、`_` 前缀这些保留名,也拒绝不合形的
  // 文件名 —— 修前这里只点名排除两个文件,别的保留名/怪名进了 diskIds、却永远进不了重建的索引,列表每次都判漂移全量扫。
  const files = all.filter(f => f.endsWith('.json') && safeSessionId(f.slice(0, -5)) !== null);
  const diskIds = new Set(files.map(f => f.slice(0, -5))); // strip '.json'
  // PF2 fix + 107-F9a: overlay everything not yet durable onto the disk index BEFORE trusting it. The index write
  // is debounced ~200ms, so without the overlay a read would serve a stale title / messageCount / pin / missionId
  // (or miss a brand-new session, or still show a just-deleted one). Two tables, because a batch lives in two
  // places before it is on disk: PENDING (queued, debounce not fired yet) and IN-FLIGHT (taken by a flush whose
  // write has not landed). PF2 overlaid only the first, so for the few ms of every flush's write the batch was in
  // neither and reads went stale — the ~200 ms-after-a-save window F8 measured. Overlaying both, and doing it in the
  // same synchronous step as the check below, is what makes a live read never staler than the most recent
  // saveSession/deleteSession that completed before it began.
  // The check: a flush retires its in-flight entries right after its write settles. If that happened while our
  // readFile was in progress we cannot tell whether we got the file from before or after that write, and the
  // entries that would have covered the difference are gone — so read again (a few times; racing flushes that
  // long means the index is being rewritten continuously, and the authoritative file scan below is the answer).
  let map = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const retireSeq = sessionIndexRetireSeq;
    const index = await readSessionIndex();
    if (retireSeq !== sessionIndexRetireSeq) continue;
    if (index) map = overlayUnflushedSessionIndex(new Map(index.map(e => [e && String(e.id), e]).filter(([id]) => id)));
    break;
  }
  if (map) {
    const indexIds = new Set(map.keys());
    const expectedIds = await sessionDiskIdsExpectedInIndex(diskIds, indexIds);   // 扣掉已知坏头,否则它让快路径永远对不上
    if (indexIds.size === expectedIds.size && [...expectedIds].every(id => indexIds.has(id))) {
      // 116f: 管家会话【只】在返回值里被滤掉,索引本身仍然收录它 —— 否则上面这个「索引 id 集 == 磁盘
      // id 集」的漂移判据永远不成立,每次 listSessions 都会退化成全量扫盘重建。
      return sortSessionMetas([...map.values()].map(sessionMeta).filter(meta => !sessionMetaIsSteward(meta))); // trust cache+in-flight+pending: id-set matches disk exactly
    }
  }
  // Index missing / corrupt / drifted from disk → authoritative scan of the real files, then rebuild the index.
  const scanSeq = sessionIndexWriteSeq;   // 128f-⑧:开扫之后排进来的写,写回时要叠上去(见 sessionIndexWriteSeq 头注)
  sessionIndexRebuildsActive += 1;
  const sessions = [];
  let rebuilt = sessions;
  const badSeen = new Set();   // 这一趟确定性判坏的 id(扫完用它换掉已知坏头表里对应的条目)
  try {
    for (const file of files) {
      const fileId = file.slice(0, -5);
      let raw;
      try { raw = await fsp.readFile(path.join(paths.sessions, file), 'utf8'); }
      catch { continue; }   // 读不到(瞬时锁/刚被删):跳过,不记坏头(见 sessionIndexKnownBadHeads 头注)
      const item = parseSessionHeadForIndex(raw, fileId);
      let meta = null;
      if (item) { try { meta = sessionMeta(item); } catch { meta = null; } }
      if (!meta) { badSeen.add(fileId); await noteSessionIndexBadHead(fileId); continue; }   // Ignore corrupt session files (记下,别让它拖死快路径)
      sessions.push(meta);
      if (sessionIndexRebuildScanHook) { try { await sessionIndexRebuildScanHook(String(item.id || '')); } catch { /* 测试钩子的异常不影响重建 */ } }
    }
    // 这一趟判好的、或盘上已没有的 id 不该留在已知坏头表里(坏头被修好 / 被删)。
    for (const id of [...sessionIndexKnownBadHeads.keys()]) if (!badSeen.has(id)) sessionIndexKnownBadHeads.delete(id);
    await withSessionIndexLock(() => {
      const byId = new Map(sessions.map(meta => [String(meta && meta.id), meta]));
      for (const [id, write] of sessionIndexLatestWrite) {
        if (!write || write.seq <= scanSeq) continue;
        if (write.val === SESSION_TOMBSTONE) byId.delete(id); else byId.set(id, write.val);
      }
      rebuilt = [...byId.values()];
      return writeSessionIndex(rebuilt);
    }).catch(() => {}); // best-effort rebuild
  } finally {
    sessionIndexRebuildsActive -= 1;
    if (sessionIndexRebuildsActive === 0) sessionIndexLatestWrite.clear();
  }
  return sortSessionMetas(rebuilt.map(sessionMeta).filter(meta => !sessionMetaIsSteward(meta))); // 116f: 同上,只滤返回值
}

return { readSessionIndex, invalidateSessionIndex, setSessionIndexRebuildScanHookForTest, scheduleSessionIndexUpdate, flushSessionIndex, overlayUnflushedSessionIndex, flushSessionIndexSync, listSessions, SESSION_INDEX_FILE, SESSION_TOMBSTONE, sessionIndexPath };
}
module.exports = { createSessionIndex };
