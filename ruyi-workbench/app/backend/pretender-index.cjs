'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pretenderHash } = require('./pretender-http-projection.cjs');
const { createPretenderSessionProjection } = require('./pretender-session-projection.cjs');

function createPretenderIndex({ storage, projection, usage, config }) {
  const {
    agentRunDir, atomicWriteJson, compactInterventionJournal, interventionFilePath,
    interventionJournalWorthCompacting, listAgentRuns, readInterventionsWithMeta, safeJsonParse, safeSessionId,
    sessionPath,
  } = storage;
  const {
    activeChildren, buildMissionCard, nowIso, sessionKind, sessionMissionId, stewardWatchedThread,
    threadOriginOf, threadVisible,
  } = projection;
  const { forEachUsageRow, usageLedgerChangesSince } = usage;
  const {
    THREAD_INDEX_RECENT_DEFAULT, THREAD_INDEX_RECENT_MAX, THREAD_INDEX_RECENT_MIN, paths, readConfig,
    getSessionsDirOwnWriteSeq,
  } = config;

  // ============================================================================
  // 第75c波(Pretender P1):Mission / Intervention 可重建物化索引、revision cursor 与 ETag。
  // 权威源始终是 session head、Intervention journal、run snapshot 与 usage ledger；本文件只维护可删缓存。
  // ============================================================================
  // 116-5b:2 -> 3。事项卡片的形状变了(加了 displayTitle 与 brief,见 mission-card-projection)。
  // 不升号的话,盘上那些 sourceStamp 没变过的会话【不会重建】,它们的卡片会一直缺这两个键 —— 壳层
  // 那句 displayTitle || title 于是一直回落到原话,而摘要明明已经写在会话头上了。索引是纯派生物
  // (durable-state 清册记的就是 fully regenerable),升号的代价只是启动后第一次读时全量重建一次。
  // 117p-S2:3 -> 4。卡片又加了 turnSeq 与 lastTurn(30 号文 §8.3,五态判据的新证据)。这次【必须】
  // 强制整份重建,而不只是形状升级 —— 否则存量那些已经跑完的管家线程的旧卡片永远不会再刷新
  // (它们的会话文件不会再变,sourceStamp 不动),无账本线程的五态就一直卡在「交办中」。
  // 117r-D1:4 -> 5。这次变的不是卡片【形状】而是卡片的【产生条件】(见下方 buildPretenderSessionSlice:
  // 管家关心的线程现在也有卡片)。不升号的话,存量索引里这些会话的行就是 card:null,而它们的会话文件
  // 不会再变(sourceStamp 不动),增量刷新永远不碰它们 —— 用户已经有的那些速查线程会一直不出现在看板上。
  // 与 117p-S2 同一条理由:索引是纯派生物,升号的代价只是启动后第一次读时全量重建一次。
  // 121-K3:5 -> 6。这次卡片的【形状】与【产生条件】一起变了:行上新增 origin/watched 两个持久字段
  // (cardRevision 也把它们算进哈希),产生条件从 watched 一条线换成 threadVisible 四条并集(§4.2)。
  // 不升号的话,存量索引里用户自己在 2.0 开的那些会话仍是 card:null,而它们的会话文件不会再变
  // (sourceStamp 不动),增量刷新永远不碰它们 —— 本刀要修的那个症状会原样留在存量机器上。
  // 性能批 P3:6 -> 7。finalize 里切片的排序从 localeCompare 换成码位序:id 带大写 / 下划线 / 连字符时两种次序不同,
  // 而 missionsRevision 是按行序算的哈希 —— 不升号,盘上旧索引的修订号会与同一份事实新算出来的对不上。代价同前:升级后
  // 首次读全量重建一次。
  // 62: card health summaries are new persistent projection facts; old source stamps must rebuild them.
  const PRETENDER_INDEX_SCHEMA = 8;
  const PRETENDER_INDEX_DIR = '.pretender';
  const PRETENDER_INDEX_FILE = 'projection-index.json';

  const pretenderIndexRuntime = {
    value: null,
    diskStamp: '',
    persisted: false,
    building: null,
    fullDirty: false,
    dirtySessions: new Set(),
    usageDirty: new Set(),
    // 121-K3(34 号文 §13.3 登记的那条竞态):上一次【真的扫过 sessions 目录】时,那个目录的 mtime,
    // 以及那次扫描完成的时刻。两个值一起用才判得出「这次扫描可信不可信」,见下面 PRETENDER_DIR_SETTLE_MS。
    sourcesDirStamp: '',
    sourcesScannedAt: 0,
    // 性能批 P2:
    //   headMtimes —— 每条会话头文件的 mtime(每次给会话算源指纹时顺手记下)。「最近 N 条」窗口从这里排,
    //     不再每次刷新都把 sessions 目录里每个头文件 stat 一遍。
    //   verifyScan / lastVerifyAt / verifyTimer —— 目录变了只比对文件名单(一次 readdir),已有文件被外部原地替换
    //     这一种由后台低频全量校验兜住(PRETENDER_VERIFY_MS 一次,不在请求路径上)。
    //   persistTimer —— 增量刷新后的落盘合并成一次延迟写(冷重建仍立即落盘)。
    headMtimes: new Map(),
    verifyScan: null,             // 后台校验在建索引链之外先扫好的 { sources, dirStamp },建索引时只做比对
    lastVerifyAt: 0,
    verifyTimer: null,
    knownMasks: new Map(),        // 会话 id -> 文件组成(1 = 会话头,2 = Intervention journal),名单比对的基准
    usageSeq: null,               // 已吸收到的用量账变更序号(00-boot usageLedgerChangesSince);null = 基准未知,下一次整份对账
    // ownMarks —— 本进程写口打脏页的累计次数;ownMarksAtScan —— 上一次看目录(名单比对或全量扫描)时的
    //   pretenderOwnWriteSeq()(脏页次数 + 01 的 sessionsDirOwnWriteSeq:会话索引、搜索索引这类不打脏页、但同样落在
    //   sessions 目录里的原子写 —— 审查轮复现过:漏掉它们时每次落盘后的下一次读都多付一遍全量扫描)。
    //   目录指纹变了、而这期间本进程一次都没写过:这次变化只可能来自外部(导入 / 手工编辑 / 夹具原地替换),
    //   当次就做一遍全量比对(121-K3 的「下一次读就看得见」逐字保住);有本进程写入时照旧只比名单。
    ownMarks: 0,
    ownMarksAtScan: 0,
    persistTimer: null,
    writers: 0,
    writeChain: Promise.resolve(),
    sliceBytes: new WeakMap(),
    counters: { fullSourceScans: 0, nameDiffScans: 0, sliceBuilds: 0, persists: 0 },
  };
  // 后台全量校验的最短间隔。程序自己的写口都会打脏页(02/08 的 markPretenderIndexDirty),MCP 子进程写会话一律回环到
  // 主进程 HTTP;需要这道校验的只剩外部导入 / 手工编辑 / 测试夹具「原地替换已有会话文件」—— 30 秒内被看到。
  const PRETENDER_VERIFY_MS = 30000;
  const PRETENDER_PERSIST_DEBOUNCE_MS = 1000;

  // 121-K3:目录 mtime 的「沉降窗口」。
  // 病根不是 K0b 修的那个(空目录时建出空索引并缓存),而是它的一般形式:**投影索引一旦进了进程内存,
  // buildOrLoadPretenderIndex 的 `if (!value)` 就短路掉整段「扫目录 + sameSourceMap 比对」,此后外部
  // 写进 sessions 目录的会话【永远】不被发现** —— 没有人给它们打脏页(markPretenderIndexDirty 只长在
  // 应用自己的写口上)。导入、多进程写入、以及本仓大量「boot 之后才 seed」的夹具都是这个形状;
  // 121-K1 那次全量真红(冷列表 300 条没读满)就是它。
  // 自愈判据用【目录级】指纹:一次 stat(paths.sessions) 就够(NTFS/ext4 都在增删条目时更新父目录 mtime),
  // 不必为每次读都付一遍 300 条会话 × 3 次 syscall 的全量扫描。
  // 但 mtime 有粒度:扫描如果发生在最后一次写的【同一毫秒附近】,这个指纹就还没稳定下来 ——
  // 那正是「一边写一边读」的现场。所以只信任「扫描时刻比目录 mtime 晚至少 1 秒」的那一次指纹;
  // 更年轻的指纹一律重扫。代价有界:一阵写完之后,第一次落在 1 秒之外的扫描就把指纹变成可信的,
  // 此后每次读只多一次 stat。
  const PRETENDER_DIR_SETTLE_MS = 1000;

  async function pretenderSessionsDirStamp() {
    try { return String(Math.trunc((await fsp.stat(paths.sessions)).mtimeMs)); } catch { return '-'; }
  }
  function pretenderSourcesTrusted(dirStamp) {
    if (pretenderIndexRuntime.sourcesDirStamp !== dirStamp) return false;
    const mtime = Number(dirStamp);
    if (!Number.isFinite(mtime)) return false;                       // 目录读不到:永远重扫(扫一次也很便宜)
    return pretenderIndexRuntime.sourcesScannedAt - mtime >= PRETENDER_DIR_SETTLE_MS;
  }
  function pretenderNoteSourcesScan(dirStamp) {
    pretenderIndexRuntime.sourcesDirStamp = dirStamp;
    pretenderIndexRuntime.sourcesScannedAt = Date.now();
    pretenderIndexRuntime.ownMarksAtScan = pretenderOwnWriteSeq();
  }
  function pretenderOwnWriteSeq() { return pretenderIndexRuntime.ownMarks + getSessionsDirOwnWriteSeq(); }

  function pretenderIndexPath() {
    return path.join(paths.sessions, PRETENDER_INDEX_DIR, PRETENDER_INDEX_FILE);
  }

  // Called by authoritative writers in earlier source modules. A dirty mark never blocks the write; the next
  // read refreshes only that session slice. `usage` is separate because refreshing it requires scanning ledgers.
  function markPretenderIndexDirty(sessionId, reason = 'source') {
    const sid = safeSessionId(sessionId);
    pretenderIndexRuntime.ownMarks += 1;
    if (!sid) { pretenderIndexRuntime.fullDirty = true; return; }
    pretenderIndexRuntime.dirtySessions.add(sid);
    if (reason === 'usage') pretenderIndexRuntime.usageDirty.add(sid);
  }

  async function pretenderFileStamp(file) {
    try {
      const st = await fsp.stat(file);
      return `${st.size}:${Math.trunc(st.mtimeMs)}`;
    } catch { return '-'; }
  }

  async function pretenderSessionSourceStamp(sessionId) {
    const sid = safeSessionId(sessionId);
    if (!sid) return '-';
    const head = await fsp.stat(sessionPath(sid)).catch(() => null);
    if (head) pretenderIndexRuntime.headMtimes.set(sid, Math.trunc(head.mtimeMs));
    else pretenderIndexRuntime.headMtimes.delete(sid);
    const parts = [
      'h=' + (head ? `${head.size}:${Math.trunc(head.mtimeMs)}` : '-'),
      'i=' + await pretenderFileStamp(interventionFilePath(sid)),
    ];
    const dir = agentRunDir(sid);
    let files = [];
    try { files = (await fsp.readdir(dir)).filter(f => /^run_[a-f0-9]+\.json$/i.test(f)).sort(); } catch { files = []; }
    for (const file of files) parts.push('r=' + file + ':' + await pretenderFileStamp(path.join(dir, file)));
    return pretenderHash(parts.join('|'));
  }

  // sessions 目录里「有会话头或有 Intervention journal」的会话 id(一次 readdir,不 stat)。
  // 返回 id -> 文件组成(1 = 会话头,2 = Intervention journal)。审查轮:只比 id 的话,已有会话头的会话后来才长出
  // journal(外部登记了一条待决)这一种会漏;比文件组成就能在这一次读里看见。
  async function pretenderListSourceIds() {
    let files = [];
    try { files = await fsp.readdir(paths.sessions); } catch { files = []; }
    const masks = new Map();
    for (const file of files) {
      if (/^sess_[A-Za-z0-9_-]+\.json$/.test(file)) { const id = file.slice(0, -5); masks.set(id, (masks.get(id) || 0) | 1); }
      else if (/^sess_[A-Za-z0-9_-]+\.interventions\.ndjson$/.test(file)) { const id = file.slice(0, -'.interventions.ndjson'.length); masks.set(id, (masks.get(id) || 0) | 2); }
    }
    return masks;
  }

  async function scanPretenderSessionSources() {
    pretenderIndexRuntime.counters.fullSourceScans += 1;
    const masks = await pretenderListSourceIds();
    pretenderIndexRuntime.knownMasks = masks;
    for (const sid of [...pretenderIndexRuntime.headMtimes.keys()]) if (!masks.has(sid)) pretenderIndexRuntime.headMtimes.delete(sid);
    const ids = [...masks.keys()].sort();
    const sources = {};
    let cursor = 0;
    const workers = Array.from({ length: Math.min(16, Math.max(1, ids.length)) }, async () => {
      while (cursor < ids.length) {
        const sid = ids[cursor++];
        sources[sid] = await pretenderSessionSourceStamp(sid);
      }
    });
    await Promise.all(workers);
    return sources;
  }

  // 121-K3(34 号文 §4.1 第三条「最近 N 条」):任务索引窗口里那 N 个 sessionId。
  // 按【会话文件 mtime】排,不按会话头里的 updatedAt —— 后者要把每个头都读出来解析一遍 JSON,
  // 而这一步只是为了决定「要不要给它造卡片」,一次 readdir + 每文件一次 stat 就够
  // (scanPretenderSessionSources 每条会话本来就付着更贵的 2 次 stat + 一次 readdir)。
  // 两者的偏差只在「文件写过但 updatedAt 没动」这种退化情形,而那恰恰也算「最近动过」。
  // N 取自配置(config.threadIndexRecent,清洗块已 clamp 到 [10,200]);读不到配置就用默认 30,
  // 绝不因为配置读失败把索引缩成空(fail-open:这里是可见性窗口,不是权限门)。
  async function pretenderRecentSessionIds() {
    const config = await readConfig().catch(() => null);
    const raw = Number(config && config.threadIndexRecent);
    const limit = Number.isFinite(raw)
      ? Math.min(THREAD_INDEX_RECENT_MAX, Math.max(THREAD_INDEX_RECENT_MIN, Math.round(raw)))
      : THREAD_INDEX_RECENT_DEFAULT;
    // 性能批 P2:mtime 取自 headMtimes(每次算源指纹时记下的),不再每次刷新都把全部会话头 stat 一遍。
    // 这张表在每次全量扫描、名单比对新增、脏页刷新时都会被更新,覆盖的正是 sessions 目录里现存的会话头。
    const rows = [...pretenderIndexRuntime.headMtimes.entries()];
    // 末位按 sessionId 降序兜确定性:同毫秒写入的两条会话不该因为目录枚举顺序漂移而轮流进窗口。
    rows.sort((a, b) => b[1] - a[1] || String(b[0]).localeCompare(String(a[0])));
    return new Set(rows.slice(0, limit).map(row => row[0]));
  }

  async function pretenderUsageSourceStamp() {
    let files = [];
    try { files = (await fsp.readdir(paths.usage)).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { files = []; }
    const parts = [];
    for (const file of files) parts.push(file + ':' + await pretenderFileStamp(path.join(paths.usage, file)));
    return pretenderHash(parts.join('|'));
  }

  const { buildMissionUsageMap, buildPretenderSessionSlice, emptyMissionUsage } = createPretenderSessionProjection({
    store: {
      compactInterventionJournal, interventionJournalWorthCompacting, listAgentRuns, readInterventionsWithMeta,
      safeJsonParse, safeSessionId, sessionPath,
    },
    model: {
      activeChildren, buildMissionCard, nowIso, sessionKind, sessionMissionId, stewardWatchedThread,
      threadOriginOf, threadVisible,
    },
    usage: { forEachUsageRow },
    index: {
      onSliceBuild: () => { pretenderIndexRuntime.counters.sliceBuilds += 1; },
      pretenderSessionSourceStamp,
    },
  });

  function validatePretenderIndex(value) {
    if (!value || value.schemaVersion !== PRETENDER_INDEX_SCHEMA || !Array.isArray(value.sessions)) return false;
    if (!value.sources || typeof value.sources !== 'object' || typeof value.usageStamp !== 'string') return false;
    return value.sessions.every(row => row && typeof row.sessionId === 'string' && typeof row.revision === 'string');
  }

  async function readPretenderIndexDisk() {
    try {
      const value = safeJsonParse(await fsp.readFile(pretenderIndexPath(), 'utf8'), null);
      return validatePretenderIndex(value) ? value : null;
    } catch { return null; }
  }

  function sameSourceMap(a, b) {
    const ak = Object.keys(a || {}).sort(), bk = Object.keys(b || {}).sort();
    return ak.length === bk.length && ak.every((key, i) => key === bk[i] && a[key] === b[key]);
  }

  // 性能批 P2:大小估算按切片缓存(增量刷新之间没变的切片对象原样复用),不再每次 finalize 都把整份索引 stringify 一遍。
  function pretenderSliceBytes(row) {
    let bytes = pretenderIndexRuntime.sliceBytes.get(row);
    if (bytes === undefined) { bytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1; pretenderIndexRuntime.sliceBytes.set(row, bytes); }
    return bytes;
  }
  // 性能批 P3:热路径排序按码位比(localeCompare 走 ICU 排序规则,慢一个数量级;id 与 ISO 时间戳要的就是码位序)。
  function pretenderCompareCodeUnits(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

  function finalizePretenderIndex(sessions, sources, usageStamp, buildReason) {
    sessions.sort((a, b) => pretenderCompareCodeUnits(String(a.sessionId), String(b.sessionId)));
    const missionRows = sessions.filter(row => row.card);
    const missionsRevision = pretenderHash(missionRows.map(row => [row.missionId, row.cardRevision || row.missionRevision]));
    // 只进 ETag、不进分页游标:列表行上的费用来自切片用量,用量变了要换 ETag,但不该让翻到一半的分页 409(审查轮)。
    const missionsUsageRevision = pretenderHash(missionRows.map(row => row.missionRevision || ''));
    const interventionsRevision = pretenderHash(sessions.map(row => [row.sessionId, row.interventionRevision]));
    const revision = pretenderHash([missionsRevision, interventionsRevision]);
    const degradedSessions = sessions.filter(row => row.integrity && row.integrity.degraded).map(row => row.sessionId);
    const value = {
      schemaVersion: PRETENDER_INDEX_SCHEMA,
      revision,
      missionsRevision,
      missionsUsageRevision,
      interventionsRevision,
      builtAt: nowIso(),
      buildReason,
      sources,
      usageStamp,
      sessions,
      degraded: { active: degradedSessions.length > 0, sessions: degradedSessions },
    };
    let sliceBytes = 0;
    for (const row of sessions) sliceBytes += pretenderSliceBytes(row);
    value.estimatedBytes = sliceBytes + Buffer.byteLength(JSON.stringify({ ...value, sessions: [] }), 'utf8');
    return value;
  }

  // 所有写盘串在一条链上(审查轮:冷重建的立即写与延迟写交错时,旧的那份可能最后落地)。
  function writePretenderIndexFile(value) {
    const run = pretenderIndexRuntime.writeChain.then(() => writePretenderIndexFileNow(value));
    pretenderIndexRuntime.writeChain = run.catch(() => false);
    return run;
  }
  async function writePretenderIndexFileNow(value) {
    const file = pretenderIndexPath();
    // writers:改名落盘到记下新 diskStamp 之间,盘上那份与 diskStamp 对不上是我们自己造成的,别当成「用户动了缓存」。
    pretenderIndexRuntime.writers += 1;
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      // 性能批 P2:紧凑 JSON(索引是可删缓存、没人读它;atomicWriteJson 缺省的两格缩进让 7 MB 的索引多出四成字节与序列化时间)
      await atomicWriteJson(file, JSON.stringify(value));
      pretenderIndexRuntime.counters.persists += 1;
      pretenderIndexRuntime.diskStamp = await pretenderFileStamp(file);
      return true;
    } catch {
      // Cache write failure never compromises authority or blocks reads. Keep the current in-memory projection.
      pretenderIndexRuntime.diskStamp = await pretenderFileStamp(file);
      return false;
    } finally { pretenderIndexRuntime.writers -= 1; }
  }
  // 冷重建(索引缺失/损坏/显式重建)立即落盘 —— 「坏索引读一次就原子重建回盘上」是既有承诺。
  async function persistPretenderIndex(value) {
    pretenderIndexRuntime.persisted = await writePretenderIndexFile(value);
  }
  // 增量刷新(脏页、目录变化、用量变化)的落盘合并成一次延迟写,不放在请求路径上。进程退出时没写的那一份丢了也无妨:
  // 索引是纯派生物,下次启动按源指纹只刷变了的那几片。
  function schedulePretenderPersist() {
    if (pretenderIndexRuntime.persistTimer) return;
    pretenderIndexRuntime.persistTimer = setTimeout(() => {
      pretenderIndexRuntime.persistTimer = null;
      void flushPretenderPersist().catch(() => {});
    }, PRETENDER_PERSIST_DEBOUNCE_MS);
    if (pretenderIndexRuntime.persistTimer.unref) pretenderIndexRuntime.persistTimer.unref();
  }
  async function flushPretenderPersist() {
    while (pretenderIndexRuntime.building) await pretenderIndexRuntime.building.catch(() => {});
    const value = pretenderIndexRuntime.value;
    if (!value || pretenderIndexRuntime.persisted) return;
    // 数据目录已经被删了(清数据、测试收尾)就别再把它建回来(审查轮)
    if (!fs.existsSync(paths.sessions)) return;
    const ok = await writePretenderIndexFile(value);
    if (pretenderIndexRuntime.value === value) pretenderIndexRuntime.persisted = ok;
    else schedulePretenderPersist();   // 写的期间又刷新过:下一拍再写最新那一份
  }
  // 后台低频全量校验:到点先在链外扫好,再走一次 getPretenderProjectionIndex 做比对。
  // 全量扫描(逐条 stat)在建索引链之外先做 —— 扫描期间来的请求不必排在它后面(审查轮);建索引时只拿结果做比对。
  async function pretenderRunVerify() {
    pretenderIndexRuntime.lastVerifyAt = Date.now();
    if (!fs.existsSync(paths.sessions)) return null;
    const dirStamp = await pretenderSessionsDirStamp();
    const sources = await scanPretenderSessionSources();
    pretenderIndexRuntime.verifyScan = { sources, dirStamp };
    return getPretenderProjectionIndexShared();   // 自己这次构建不再武装下一轮:没人读时后台校验就停下,不空转
  }
  function pretenderScheduleVerify() {
    if (pretenderIndexRuntime.verifyTimer || pretenderIndexRuntime.verifyScan) return;
    const wait = Math.max(0, pretenderIndexRuntime.lastVerifyAt + PRETENDER_VERIFY_MS - Date.now());
    pretenderIndexRuntime.verifyTimer = setTimeout(() => {
      pretenderIndexRuntime.verifyTimer = null;
      void pretenderRunVerify().catch(() => {});
    }, wait);
    if (pretenderIndexRuntime.verifyTimer.unref) pretenderIndexRuntime.verifyTimer.unref();
  }

  async function rebuildPretenderIndexFull(reason, knownSources) {
    const sources = knownSources || await scanPretenderSessionSources();
    const usageMap = await buildMissionUsageMap();
    const recentIds = await pretenderRecentSessionIds();   // 121-K3:整份算一次,每条会话只做一次 Set 查询
    let ids = Object.keys(sources).sort(), cursor = 0;
    const sessions = [];
    const workers = Array.from({ length: Math.min(12, Math.max(1, ids.length)) }, async () => {
      while (cursor < ids.length) {
        const sid = ids[cursor++];
        const slice = await buildPretenderSessionSlice(sid, sources[sid], usageMap.get(sid), recentIds);
        if (slice) { sources[sid] = slice.sourceStamp; sessions.push(slice); }
      }
    });
    await Promise.all(workers);
    return finalizePretenderIndex(sessions, sources, await pretenderUsageSourceStamp(), reason);
  }

  async function refreshPretenderIndexSlices(base, dirtyIds, usageIds, reason) {
    const sources = { ...(base.sources || {}) };
    const rows = new Map(base.sessions.map(row => [row.sessionId, row]));
    const usageMap = usageIds.size ? await buildMissionUsageMap(usageIds) : null;
    // 先给这几条会话算源指纹(顺手更新 headMtimes),再排「最近 N 条」窗口 —— 121-K3:一条刚被写过的会话恰恰最可能
    // 【刚刚】挤进最近 N 条,拿旧窗口判它等于让新会话晚一整轮才上索引。
    // 性能批 P2:与全量重建同样按 12 路并发池跑(修前逐条串行 —— 启动后外部一次物化几百条会话时,这里一条一条等 IO)。
    // 每条会话只动自己那一格,行序由 finalize 统一排序,并发不改变结果。
    const ids = [...dirtyIds];
    const pool = async work => {
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(12, Math.max(1, ids.length)) }, async () => {
        while (cursor < ids.length) await work(ids[cursor++]);
      }));
    };
    const stamps = new Map();
    await pool(async sid => { stamps.set(sid, await pretenderSessionSourceStamp(sid)); });
    const recentIds = await pretenderRecentSessionIds();
    await pool(async sid => {
      const stamp = stamps.get(sid);
      if (!fs.existsSync(sessionPath(sid)) && !fs.existsSync(interventionFilePath(sid))) { delete sources[sid]; rows.delete(sid); return; }
      sources[sid] = stamp;
      const previous = rows.get(sid);
      const usage = usageIds.has(sid) ? usageMap.get(sid) : (previous && previous.usage);
      const slice = await buildPretenderSessionSlice(sid, stamp, usage, recentIds);
      if (slice) { sources[sid] = slice.sourceStamp; rows.set(sid, slice); } else { delete sources[sid]; rows.delete(sid); }
    });
    const usageStamp = usageIds.size ? await pretenderUsageSourceStamp() : base.usageStamp;
    return finalizePretenderIndex([...rows.values()], sources, usageStamp, reason);
  }

  // 性能批 P2:账本变了(上次落盘之后又跑过回合)只重算每片的用量事实,不再把每条会话从盘上整份重建 ——
  // 修前这是启动时最常见的一种「全量重建」(退出前最后几轮的用量还没随索引落盘)。
  // 与 buildPretenderSessionSlice 里同一套算法:missionRevision = hash({cardRevision, usage}),revision = hash([missionRevision, interventionRevision])。
  // sessionIds(可选):只对这几条会话重算(用量账变更日志说只有它们变了)。一片都没变就原样返回 base。
  async function refreshPretenderUsageFacts(base, reason, sessionIds = null) {
    const usageMap = await buildMissionUsageMap(sessionIds);
    let changed = false;
    const sessions = base.sessions.map(row => {
      if (sessionIds && !sessionIds.has(row.sessionId)) return row;
      const usage = usageMap.get(row.sessionId) || emptyMissionUsage();
      if (JSON.stringify(usage) === JSON.stringify(row.usage)) return row;
      changed = true;
      const missionRevision = pretenderHash({ cardRevision: row.cardRevision, usage });
      return { ...row, usage, missionRevision, revision: pretenderHash([missionRevision, row.interventionRevision]) };
    });
    const usageStamp = await pretenderUsageSourceStamp();
    if (!changed && usageStamp === base.usageStamp) return base;
    return finalizePretenderIndex(sessions, { ...(base.sources || {}) }, usageStamp, reason);
  }

  function pretenderChangedSourceIds(before, after) {
    const ids = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    return new Set([...ids].filter(id => (before || {})[id] !== (after || {})[id]));
  }

  async function buildOrLoadPretenderIndex() {
    const indexFile = pretenderIndexPath();
    const currentDiskStamp = await pretenderFileStamp(indexFile);
    // User deleted/replaced/corrupted the cache while the process was live: discard memory and prove rebuild.
    // 性能批 P2:判据是「盘上那份不再是我们最后一次写 / 读到的那份」(diskStamp),不再要求 persisted —— 增量刷新改成
    // 延迟落盘之后,等写的那一秒里用户删了缓存,照样丢内存、从权威源重建(修前每次刷新都立即落盘,persisted 恒真)。
    if (pretenderIndexRuntime.value && pretenderIndexRuntime.writers === 0 && pretenderIndexRuntime.diskStamp
      && currentDiskStamp !== pretenderIndexRuntime.diskStamp) {
      pretenderIndexRuntime.value = null;
    }

    // ── 121-K3(§13.3):目录级自愈 ───────────────────────────────────────────────────────
    // 下面那句 `if (!value)` 是热路径的命根子(不能每次读都全量扫目录),但它同时也是 §13.3 那条
    // 竞态的病根:索引进了内存之后,外部写进 sessions 目录的会话【永远】不被发现。
    // 这里用一次 stat 把两件事都照顾到:目录指纹没变且已经沉降 -> 什么都不做(热路径逐字不变);
    // 指纹变了、或者变得太新(还在一边写一边读的窗口里)-> 看一眼目录,真有差异才按差异刷【那几片】。
    // 性能批 P2:「看一眼」从「每条会话 2 次 stat + 1 次 readdir」降成【一次 readdir 比对名单】—— 目录 mtime 在
    // 本进程每次原子落盘会话头时都会变,修前每次落盘后的下一次读都付一整遍全量扫描(2000 条会话约 300 ms)。
    // 新出现 / 消失的会话、已有会话新长出(或没了)journal,照旧在这一次读里就刷好(K3 的保证不变,比的是每条会话的
    // 文件组成);只有「外部原地替换 / 改写已有文件」这一种(名单与组成都不变),由后台全量校验兜住 —— 目录变过之后
    // 最多 PRETENDER_VERIFY_MS 看见。本进程自己的写口本来就打脏页,MCP 子进程写会话回环到主进程,都不靠这一步。
    // 例外(全量回归复现过,steward-thread-order ③):目录指纹变了、这期间本进程却一次脏页都没打 —— 变化只可能是外部的,
    // 名单比对看不见原地替换,就当次做一遍全量比对(与修前同价,只落在「纯外部改动」这一种上;本进程落盘后的读仍只比名单)。
    const dirStamp = await pretenderSessionsDirStamp();
    const verifyScan = pretenderIndexRuntime.verifyScan;
    pretenderIndexRuntime.verifyScan = null;
    if (pretenderIndexRuntime.value && verifyScan) {
      const base = pretenderIndexRuntime.value;
      pretenderNoteSourcesScan(verifyScan.dirStamp);
      if (!sameSourceMap(base.sources, verifyScan.sources)) {
        pretenderIndexRuntime.value = await refreshPretenderIndexSlices(base, pretenderChangedSourceIds(base.sources, verifyScan.sources), new Set(), 'sources_verify');
        pretenderIndexRuntime.persisted = false;
      }
    } else if (pretenderIndexRuntime.value && pretenderIndexRuntime.sourcesDirStamp !== dirStamp
      && pretenderOwnWriteSeq() === pretenderIndexRuntime.ownMarksAtScan) {
      const base = pretenderIndexRuntime.value;
      const sources = await scanPretenderSessionSources();
      pretenderNoteSourcesScan(dirStamp);
      pretenderIndexRuntime.lastVerifyAt = Date.now();
      if (!sameSourceMap(base.sources, sources)) {
        pretenderIndexRuntime.value = await refreshPretenderIndexSlices(base, pretenderChangedSourceIds(base.sources, sources), new Set(), 'sources_dir_changed');
        pretenderIndexRuntime.persisted = false;
      }
    } else if (pretenderIndexRuntime.value && !pretenderSourcesTrusted(dirStamp)) {
      const base = pretenderIndexRuntime.value;
      pretenderIndexRuntime.counters.nameDiffScans += 1;
      const masks = await pretenderListSourceIds();
      pretenderNoteSourcesScan(dirStamp);
      const known = pretenderIndexRuntime.knownMasks;
      const changed = new Set();
      for (const [id, mask] of masks) if (known.get(id) !== mask) changed.add(id);
      for (const id of known.keys()) if (!masks.has(id)) changed.add(id);
      // 索引里有、名单基准里没有的(不该发生,防御):也按名单对一遍
      for (const id of Object.keys(base.sources || {})) if (!masks.has(id)) changed.add(id);
      pretenderIndexRuntime.knownMasks = masks;
      if (changed.size) {
        pretenderIndexRuntime.value = await refreshPretenderIndexSlices(base, changed, new Set(), 'sources_dir_changed');
        pretenderIndexRuntime.persisted = false;   // 变过就得重新落盘(下面统一那一处写)
      }
    }

    let value = pretenderIndexRuntime.value;
    let cold = false;
    if (!value) {
      const disk = await readPretenderIndexDisk();
      const sources = await scanPretenderSessionSources();
      pretenderNoteSourcesScan(dirStamp);
      pretenderIndexRuntime.lastVerifyAt = Date.now();
      // 用量基准:先取变更序号、再算源指纹 —— 两者之间追加进来的行会让指纹对不上,走整份对账,不会漏。
      const usageBaseline = await usageLedgerChangesSince(Number.MAX_SAFE_INTEGER);
      pretenderIndexRuntime.usageSeq = usageBaseline.seq;
      const usageStamp = await pretenderUsageSourceStamp();
      if (!disk) {
        // 121-K0b(病根在此):原来的空目录守卫只长在 warmPretenderProjectionIndex 里,只护 boot 那一次
        // 预热。13i 的收件箱 tick 与其他任何调用方一样直接走 getPretenderProjectionIndex -> 这里,不经过
        // warm。当索引文件从未建过(currentDiskStamp === '-',即真·首次)且 sessions 目录此刻确实一份
        // sess_* 都没有(scanPretenderSessionSources 的 sources 为空)时,不能走下面的 rebuildPretenderIndexFull:
        // 那会把一份空索引落盘(persistPretenderIndex)并存进 pretenderIndexRuntime.value——下一次
        // 调用会发现 diskStamp 没变就直接信任这份【已缓存为已建】的空索引,永远不再重新发现
        // (`if (!value)` 短路)。管家默认开着(121-K0)之后,服务起来的第一拍收件箱 tick 就会撞上这个
        // 窗口——外部导入/多进程写入/本仓大量夹具都在 boot 之后才把会话物化到盘上。
        // 修法:直接 return 一份不落盘、不缓存为已建的空索引,下一次调用(不论隔多久)重新 scanPretenderSessionSources
        // 发现磁盘上的真会话。disk 索引已存在时(currentDiskStamp !== '-',对应下面 corrupt_index 分支)不受影响——
        // 那是「索引文件在但读不出来」,与「索引从未建过」是两回事,仍应立即重建并落盘。
        if (currentDiskStamp === '-' && Object.keys(sources).length === 0) {
          return finalizePretenderIndex([], sources, usageStamp, 'empty_sessions_dir');
        }
        value = await rebuildPretenderIndexFull(currentDiskStamp === '-' ? 'missing_index' : 'corrupt_index', sources);
        cold = true;
      } else {
        value = disk;
        if (!sameSourceMap(disk.sources, sources)) value = await refreshPretenderIndexSlices(disk, pretenderChangedSourceIds(disk.sources, sources), new Set(), 'source_changed');
        if (value.usageStamp !== usageStamp) value = await refreshPretenderUsageFacts(value, 'usage_source_changed');
        if (value === disk) {
          pretenderIndexRuntime.diskStamp = currentDiskStamp;
          pretenderIndexRuntime.persisted = true;
        }
      }
    }

    // 用量账变了哪些会话(00-boot 的变更日志,本进程追加与外部写进来的一视同仁):只重算那几片的用量事实。
    // 修前索引一旦进了内存,外部写账【永远】看不见(只在启动读盘那一次比 usageStamp)。冷重建刚从整份账算过,跳过。
    if (value && !cold) {
      const change = await usageLedgerChangesSince(pretenderIndexRuntime.usageSeq);
      if (change.all) value = await refreshPretenderUsageFacts(value, 'usage_source_changed');
      else if (change.sessionIds.size) value = await refreshPretenderUsageFacts(value, 'usage_source_changed', change.sessionIds);
      pretenderIndexRuntime.usageSeq = change.seq;
    }

    const forceFull = pretenderIndexRuntime.fullDirty;
    pretenderIndexRuntime.fullDirty = false;
    const dirtyIds = new Set(pretenderIndexRuntime.dirtySessions);
    const usageIds = new Set(pretenderIndexRuntime.usageDirty);
    pretenderIndexRuntime.dirtySessions.clear();
    pretenderIndexRuntime.usageDirty.clear();
    if (forceFull) {
      pretenderIndexRuntime.usageSeq = (await usageLedgerChangesSince(Number.MAX_SAFE_INTEGER)).seq;   // 基准先取,再整份算
      value = await rebuildPretenderIndexFull('explicit_rebuild');
      cold = true;
    }
    else if (dirtyIds.size) value = await refreshPretenderIndexSlices(value, dirtyIds, usageIds, usageIds.size ? 'usage_dirty' : 'source_dirty');

    if (value !== pretenderIndexRuntime.value || !pretenderIndexRuntime.persisted) {
      if (cold) await persistPretenderIndex(value);
      else { pretenderIndexRuntime.persisted = false; schedulePretenderPersist(); }
    }
    pretenderIndexRuntime.value = value;
    return value;
  }

  // 测试直调(unit/pretender-index-incremental):计数、立即走一次后台校验、立即落盘。不改任何行为。
  const pretenderIndexTestHooks = {
    stats: () => ({ ...pretenderIndexRuntime.counters, persisted: pretenderIndexRuntime.persisted, verifyArmed: Boolean(pretenderIndexRuntime.verifyTimer) }),
    verifyNow: () => pretenderRunVerify(),
    flushPersist: () => flushPretenderPersist(),
  };

  // 审查轮:后台校验由【每一次真实读取】武装(PRETENDER_VERIFY_MS 一轮),不再只在「目录变过」之后武装一次 ——
  // 修前原地改写已有文件(目录 mtime 不动)永远不会被看见,校验跑过一次之后也不再重来。
  // 校验自己触发的那次构建走 getPretenderProjectionIndexShared,不武装:页面关了、没人读,后台就不再扫。
  async function getPretenderProjectionIndex() {
    const index = await getPretenderProjectionIndexShared();
    if (pretenderIndexRuntime.value) pretenderScheduleVerify();
    return index;
  }
  async function getPretenderProjectionIndexShared() {
    if (pretenderIndexRuntime.building) return pretenderIndexRuntime.building;
    const current = buildOrLoadPretenderIndex();
    pretenderIndexRuntime.building = current;
    try { return await current; }
    finally { if (pretenderIndexRuntime.building === current) pretenderIndexRuntime.building = null; }
  }

  // Wave 80: warm an existing projection as soon as the local service is listening. The empty-directory
  // guard here just skips the boot-time warm call entirely when there is nothing to warm yet (cheap early
  // return, no index built, no disk touched) — it does not need to protect every caller against trusting an
  // empty index. 121-K0b moved that protection to the root (buildOrLoadPretenderIndex above): every caller of
  // getPretenderProjectionIndex, not only this boot-time warmer, now gets an unpersisted/uncached empty
  // projection when sessions haven't materialized yet, so this function's own check is now redundant-but-
  // harmless (kept for its boot-time short-circuit, not for correctness).
  async function warmPretenderProjectionIndex() {
    let files = [];
    try { files = await fsp.readdir(paths.sessions); } catch { return null; }
    if (!files.some(file => /^sess_[A-Za-z0-9_-]+(?:\.json|\.interventions\.ndjson)$/.test(file))) return null;
    return getPretenderProjectionIndex();
  }

  function pretenderIndexMeta(index) {
    return {
      projectionRevision: index.revision,
      builtAt: index.builtAt,
      estimatedBytes: index.estimatedBytes,
      persisted: pretenderIndexRuntime.persisted,
      degraded: index.degraded,
    };
  }

  function invalidatePretenderIndex() { pretenderIndexRuntime.fullDirty = true; }

  function getIndexedPretenderSessionIds() {
    const value = pretenderIndexRuntime.value;
    return (value && Array.isArray(value.sessions) ? value.sessions : []).map(row => row.sessionId);
  }

  return { markPretenderIndexDirty, invalidatePretenderIndex, getIndexedPretenderSessionIds, pretenderIndexMeta, getPretenderProjectionIndex, warmPretenderProjectionIndex, pretenderIndexTestHooks, emptyMissionUsage };
}

module.exports = { createPretenderIndex };
