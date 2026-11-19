'use strict';
const fsp = require('node:fs/promises');

function createFileReadCache({ execResultCacheEnabled, execResultCacheMaxEntries, logEvent }) {
// ── 106 #2a: 受限执行结果缓存(22 号文 §6.1)─────────────────────────────────
// 首批白名单仅 file_read(资源版本可 stat 验证的本地只读)。身份 = 工具 + 规范化参数 + 解析后
// 绝对路径;版本 = dev+ino+ctimeMs+mtimeMs+size（覆盖原子替换和保留修改时间的写入）。读取前后双 stat 夹逼防
// 读写竞态;命中时重新 stat 比对版本,不一致即失效重读 —— 外部写入/删除/重建/重命名由此覆盖,
// 不依赖如意写工具监听。权限守卫(guardFileToolPath)在缓存查找之前执行,命中即重新验权。
// 不缓存错误/中断/竞态结果;命中结果带 cacheHit 诚实标记,不冒称重新执行。开关关 = 零额外
// stat、零事件、结果与现状逐字节一致。
const EXEC_CACHE_WHITELIST = new Set(['file_read']);
const EXEC_CACHE_MAX_SESSIONS = 20;
const EXEC_CACHE_ENTRY_MAX_BYTES = 512 * 1024;
const execResultCacheBySession = new Map(); // sessionId -> Map(cacheKey -> { version, result, cachedAt, bytes })

// key 用 handler 实际消费的原始参数值(宁多分段也不少分段:行为相同而 key 不同只是多一次 miss,
// 行为不同而 key 相同会出错)。annotate 按 handler 的布尔口径归一;encoding 按缺省归一。
function execCacheKeyFileRead(p, args) {
  return 'file_read\0' + p + '\0' + JSON.stringify({
    // 不传 encoding = 自动识别(GBK/UTF-16 照解),与显式 encoding:'utf8'(强制按 UTF-8)是两回事:修前两者共用
    // 一个键,先强制读出的乱码会被后来的自动识别读当成缓存命中原样交回,反之亦然。
    e: args.encoding ? String(args.encoding).toLowerCase() : 'auto',
    o: args.offset === undefined ? null : args.offset,
    l: args.limit === undefined ? null : args.limit,
    lo: args.lineOffset === undefined ? null : args.lineOffset,
    ll: args.lineLimit === undefined ? null : args.lineLimit,
    a: args.annotate_non_ascii === true || args.annotate_non_ascii === 'true',
  });
}
function execCacheVersionOf(st) { return st ? { dev: st.dev, ino: st.ino, ctimeMs: st.ctimeMs, mtimeMs: st.mtimeMs, size: st.size } : null; }
function execCacheSameVersion(a, b) { return !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs && a.size === b.size; }
function execCacheSessionMap(sessionId, create) {
  let m = execResultCacheBySession.get(sessionId);
  if (!m) {
    if (!create) return null;
    m = new Map();
    execResultCacheBySession.set(sessionId, m);
    while (execResultCacheBySession.size > EXEC_CACHE_MAX_SESSIONS) {
      execResultCacheBySession.delete(execResultCacheBySession.keys().next().value);
    }
  } else { // LRU 触碰
    execResultCacheBySession.delete(sessionId);
    execResultCacheBySession.set(sessionId, m);
  }
  return m;
}
// 开关/白名单/会话三重门;返回 null = 走原始路径(零开销)。
function execCacheContext(name, args, ctx, resolvedPath) {
  if (!EXEC_CACHE_WHITELIST.has(name)) return null;
  const config = ctx && ctx.config;
  if (!execResultCacheEnabled(config)) return null;
  const sessionId = ctx && ctx.sessionId;
  if (!sessionId) return null;
  return {
    tool: name, sessionId, path: resolvedPath,
    key: name === 'file_read' ? execCacheKeyFileRead(resolvedPath, args) : null,
    maxEntries: execResultCacheMaxEntries(config),
    statBefore: null,
    signal: ctx && ctx.signal,
  };
}
// 查找:重新 stat 验版本。返回命中结果(带 cacheHit 标记)或 null;冷/失效/消失都落事件,
// miss 时顺手把 stat 结果留在 ctx.statBefore 供 store 夹逼复用。
async function execCacheLookup(c) {
  const t0 = Date.now();
  let st = null;
  try { st = await fsp.stat(c.path); } catch { st = null; }
  const version = execCacheVersionOf(st);
  const sess = execCacheSessionMap(c.sessionId, false);
  const entry = sess && sess.get(c.key);
  if (!entry) {
    c.statBefore = version;
    logEvent({ kind: 'exec_result_cache', outcome: 'miss', reason: 'cold', tool: c.tool, sessionId: c.sessionId, lookupMs: Date.now() - t0 });
    return null;
  }
  if (!execCacheSameVersion(version, entry.version)) {
    sess.delete(c.key);
    c.statBefore = version;
    logEvent({ kind: 'exec_result_cache', outcome: 'miss', reason: st ? 'stale' : 'gone', tool: c.tool, sessionId: c.sessionId, lookupMs: Date.now() - t0 });
    return null;
  }
  sess.delete(c.key); sess.set(c.key, entry); // LRU 触碰
  logEvent({ kind: 'exec_result_cache', outcome: 'hit', tool: c.tool, sessionId: c.sessionId, bytes: entry.bytes, ageMs: Date.now() - entry.cachedAt, lookupMs: Date.now() - t0 });
  // 61-B4:裸的 {cachedAt, ageMs} 模型看不懂;note 说清这是「同会话读过、文件没变」而不是旧快照(命中前已重 stat 比 mtime+size)。
  return { ...entry.result, cacheHit: { cachedAt: entry.cachedAt, ageMs: Date.now() - entry.cachedAt, note: 'served from the read cache of this session: the file is unchanged since that read (file identity, change time, modification time and size re-checked), so the content is current' } };
}
// 存储:只收 ok:true;读后 stat 与读前 stat 不一致 = 读取窗口内有外部写入,弃存(竞态不缓存);
// 读前 stat 缺失(查找时文件不存在)而读后有 = 文件在窗口内新建,以读后版本存(内容即是该版本)。
async function execCacheStore(c, result) {
  if (!result || result.ok !== true) return;
  if (c.signal && c.signal.aborted) return; // 中断结果不缓存(22 §6.1)
  let st = null;
  try { st = await fsp.stat(c.path); } catch { st = null; }
  const statAfter = execCacheVersionOf(st);
  if (c.statBefore && !execCacheSameVersion(c.statBefore, statAfter)) {
    logEvent({ kind: 'exec_result_cache', outcome: 'skip', reason: 'race', tool: c.tool, sessionId: c.sessionId });
    return;
  }
  if (!statAfter) {
    logEvent({ kind: 'exec_result_cache', outcome: 'skip', reason: 'gone', tool: c.tool, sessionId: c.sessionId });
    return;
  }
  const bytes = Buffer.byteLength(typeof result.content === 'string' ? result.content : JSON.stringify(result));
  if (bytes > EXEC_CACHE_ENTRY_MAX_BYTES) {
    logEvent({ kind: 'exec_result_cache', outcome: 'skip', reason: 'oversize', tool: c.tool, sessionId: c.sessionId, bytes });
    return;
  }
  const sess = execCacheSessionMap(c.sessionId, true);
  while (sess.size >= c.maxEntries && sess.size > 0) sess.delete(sess.keys().next().value);
  sess.set(c.key, { version: statAfter, result, cachedAt: Date.now(), bytes });
  logEvent({ kind: 'exec_result_cache', outcome: 'store', tool: c.tool, sessionId: c.sessionId, bytes });
}

  return { context: execCacheContext, lookup: execCacheLookup, store: execCacheStore };
}
module.exports = { createFileReadCache };
