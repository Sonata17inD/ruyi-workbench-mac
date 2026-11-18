'use strict';
const nodeFs = require('node:fs');
const nodeFsp = require('node:fs/promises');
const path = require('node:path');
const { STEWARD_MERGE_WINDOW_MS } = require('./steward-inbox-events.cjs');

// ── 落盘常量 ────────────────────────────────────────────────────────────────
const STEWARD_DIR_NAME = 'steward';
const STEWARD_INBOX_FILE = 'inbox-v1.ndjson';
const STEWARD_CURSOR_FILE = 'cursor-v1.json';
const STEWARD_CURSOR_SCHEMA = 1;

// ── 收件箱批次常量 ────────────────────────────────────────────────────────────
const STEWARD_TICK_MAX_EVENTS = 200;       // 单轮入箱上限(防某次大补账把箱子灌爆)
const STEWARD_CARRY_MAX_EVENTS = 5000;     // 116-3 P0-3:跨轮结转队列硬顶(超出才真的丢,并落一条日志)

// ── 轮询成本常量 ────────────────────────────────────────────────────────────
const STEWARD_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000; // 「活跃」= 有待决 / 未终态 / 24 小时内有变更
const STEWARD_RUN_EVENT_PAGE = 200;        // 单个 run 单轮最多读多少条事件(下轮继续)
const STEWARD_FIRST_SIGHT_MAX_REVISION = 200; // 首见会话:revision 不超过它才全读,否则只建基线
const STEWARD_FIRST_SIGHT_MAX_EVENT_SEQ = 500; // 首见 run:同上
const STEWARD_FIRST_SIGHT_MAX_TURNS = 50;  // 116-4 首见会话:回合数不超过它才补一条,否则只建基线

// ── 容量常量(游标不得无限增长) ───────────────────────────────────────────────
// 这三个上限管的是【落盘】的游标(cursor-v1.json 的体积与重启后读回的条数),不管进程内存里的游标。
// 修前 stewardSaveCursor 把它们同样用在内存游标上:第 501 个之后的会话每一拍都被裁掉,于是下一拍又算
// 「首见」—— 整份会话头 readFile + JSON.parse、开 .changes.ndjson、readdir agent-runs 全走一遍
// (2000 会话实测每拍约 700ms CPU、38k 次系统调用/分钟)。内存游标另有一档宽得多的上限,只防无界增长。
const STEWARD_CURSOR_MAX_SESSIONS = 500;
const STEWARD_CURSOR_MAX_RUNS = 500;
const STEWARD_CURSOR_MAX_PENDING = 2000;
const STEWARD_CURSOR_MEM_MAX_SESSIONS = 20000;   // 内存游标的会话条目上限(missionChanges / sessionTurns / budgetSeen 共用)
const STEWARD_CURSOR_MEM_MAX_RUNS = 20000;       // 内存游标的 run 条目上限

// ── 读取常量 ────────────────────────────────────────────────────────────────
const STEWARD_INBOX_LIMIT_DEFAULT = 50;
const STEWARD_INBOX_LIMIT_MAX = 200;       // §11.3:limit 夹 [1,200]
const STEWARD_INBOX_FULL_READ_BYTES = 8 * 1024 * 1024; // 超过它只读尾窗(首个半行丢弃)
const STEWARD_INBOX_TAIL_BYTES = 1024 * 1024;
const STEWARD_DEDUPE_TAIL_ROWS = 2000;     // 启动时从 inbox 尾部重建去重集合的行数上限
const STEWARD_SEEN_MAX_KEYS = 20000;       // 去重集合内存硬顶,超了就按同一口径从尾部重建
const STEWARD_INBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STEWARD_INBOX_HISTORY_MAX = 5000;
const STEWARD_INBOX_MAINTENANCE_MS = 60 * 60 * 1000;

function createStewardInbox({
  paths, readConfig, safeSessionId, safeJsonParse, nowIso, logEvent,
  io, sources, execution, rules, inboxEvents, RUYI_EVENTS, EventStreamHooks, StewardHooks,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
}) {
  const { fs = nodeFs, fsp = nodeFsp, atomicWriteJson, repairMissionChangeTornTail } = io;
  const { getPretenderProjectionIndex, sessionPath, listAgentRuns, readAgentRunEvents, readMissionChangesWithMeta } = sources;
  const { activeAgentRuns, activeChildren, turnSettlers, turnOutcomePending } = execution;
  const { STEWARD_EVENT_KINDS, STEWARD_SESSION_ID, stewardWatchedThread } = rules;
  const {
    stewardEventDedupeKey, stewardInboxRowDedupeKeys, stewardMergeInboxEvents,
    stewardNormalizeBudgetExhausted, stewardNormalizeMissionChange, stewardNormalizePendingIntervention,
    stewardNormalizeRunEvent, stewardNormalizeSessionTurn, stewardNormalizeThreadAdopted,
  } = inboxEvents;
  const { setTimeout, clearTimeout, setInterval, clearInterval } = timers;

  // ────────────────────────────────────────────────────────────────────────────
  // 落盘层。写原语与 session-changes NDJSON 同款:先 repairMissionChangeTornTail(尾部半行截干净),
  // 再 fsp.appendFile 整行;全部经一条 per-process 串行链(不交错)。游标走 atomicWriteJson。
  // ────────────────────────────────────────────────────────────────────────────
  function stewardDir() { return path.join(paths.data, STEWARD_DIR_NAME); }
  function stewardInboxPath() { return path.join(stewardDir(), STEWARD_INBOX_FILE); }
  function stewardCursorPath() { return path.join(stewardDir(), STEWARD_CURSOR_FILE); }

  const stewardRuntime = {
    timer: null,
    running: false,
    ticking: false,
    wakePending: false,
    generation: 0,        // stopStewardInbox 自增;在途 tick 发现代际变了就尽快退出
    loaded: false,
    cold: true,           // 本次装载时没有可用游标 = 冷启动(只建基线,不把历史灌进箱子)
    inboxSeq: 0,
    pollMs: 60000,
    lastTickAt: '',
    lastInboxAt: '',      // 116-4:最后一次【真的写进箱子】的时刻(lastTickAt 只说明轮询活着)
    lastMaintenanceAt: 0,
    sourcesSeen: { sessionTurns: 0 }, // 116-4:第四源本进程入箱条数,给 /api/steward/state 的诚实字段
    lastError: '',
    seen: new Set(),      // 去重集合(启动时从 inbox 尾部重建,上限 STEWARD_DEDUPE_TAIL_ROWS 行)
    // 116-3 P1-9:budget 类事件此前【没有】持久化去重游标,唯一保护是内存 seen 集合,而它无论启动重建
    // 还是运行时收缩都只回看 inbox 尾部 2000 行 —— 繁忙一天之后那条记录滑出窗口,而 card 上的
    // budgetExhausted 是持久标记,下一轮就会把同一件事重复写进箱子。budgetSeen 与 pendingIds 同款落盘。
    // 116-4:第四源 sessionTurns 的游标 —— sid -> { turnSeq, stamp }。stamp 是投影免费给的
    // 会话文件指纹(size:mtime 的哈希);它没变就连会话头都不用读,这是第四源不把轮询成本推高的关键。
    cursor: { missionChanges: {}, agentRuns: {}, pendingIds: new Set(), budgetSeen: new Set(), sessionTurns: {} },
    // 上一次【成功落盘】的游标内容指纹(不含 updatedAt)。stewardSaveCursor 每拍先算一遍当前指纹,
    // 与它相同就不写盘 —— 15 秒一拍的空转轮询不该每拍 temp+rename 重写一份 65KB 的游标。
    // 空串 = 本进程还没成功写过(装载/重置后的第一拍必写:冷启动基线、损坏游标的重建都靠这一拍)。
    cursorSig: '',
    // 116-3 P0-3:本轮因单轮上限没能写进箱子的【原始】事件。游标在 stewardCollectEvents 里已经越过
    // 它们(三条源日志的游标是「这一轮看到的最新版本号」,不管后面写没写进箱),所以不留在这里就是
    // 永久静默丢失 —— 而超出上限的恰恰是最新的那批 needs_you / failed。留到下一轮开头再入箱。
    carry: [],
    // 121-K3(§4.4「交接」):等着进下一拍的交接事件。来源是总线(02 落盘 stewardWatch:true 之后派的
    // thread.adopted{by:'user'}),不是任何一本磁盘日志 —— 所以它不走「游标 + 增量读」那一套,而是
    // 在这里排队,由下一拍 stewardCollectEvents 开头一次性取走。硬顶见 STEWARD_ADOPTED_QUEUE_MAX:
    // 管家关着时没人来取,队列不能无限长(溢出丢【最早】的 —— 最近那次交接才是用户还记得的那次)。
    adopted: [],
    adoptedRecent: new Map(),   // 135:重复交接去重窗口(sid+委托 -> 时刻),只在内存
    wakeTimers: [],             // 2026-10:待决一产生就提前补拍的定时器(见 stewardScheduleWake)
  };
  const STEWARD_ADOPTED_QUEUE_MAX = 50;
  const STEWARD_ADOPTED_DEDUPE_MS = 10 * 60 * 1000;   // 135:同一线程同一句委托在 10 分钟内重复交接只算一次
  let stewardAppendChain = Promise.resolve();
  let stewardStateLoad = null;

  // 121-K3:订阅总线。装在模块加载期,进程生命周期内不卸(同 13r 的纪律)。它【只排队,不落盘】——
  // 收件箱的写面只有 stewardTickOnce 一处,旁路事件不许绕过去重、合并、在场门三道工序。
  RUYI_EVENTS.subscribe((name, payload) => {
    if (name !== 'thread.adopted') return;
    const data = (payload && typeof payload === 'object') ? payload : {};
    if (String(data.by || '') !== 'user') return;   // missionAttachThread 派的那一路是【归并到事项】,不是交接
    stewardQueueThreadAdopted(data);
  });
  // Lifecycle events wake the single inbox writer. A second pass covers events emitted
  // before journal persistence. Coalesce without postponing existing deadlines: a busy
  // event stream must never starve the first pass. Token/delta events do not wake it.
  const STEWARD_WAKE_DELAYS_MS = Object.freeze([400, 2500]);
  const STEWARD_WAKE_EVENTS = new Set([
    'thread.needs_you', 'thread.state', 'thread.done', 'thread.removed',
    'thread.created', 'background.completed',
  ]);
  RUYI_EVENTS.subscribe((name, payload) => {
    if (!STEWARD_WAKE_EVENTS.has(name)) return;
    const sid = safeSessionId(payload && payload.sessionId);
    if (!sid || sid === STEWARD_SESSION_ID) return;
    stewardScheduleWake();
  });
  function stewardConsistencyMs(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(120000, Math.max(60000, Math.round(n))) : 60000;
  }
  function stewardClearWake() {
    for (const timer of (Array.isArray(stewardRuntime.wakeTimers) ? stewardRuntime.wakeTimers : [])) clearTimeout(timer);
    stewardRuntime.wakeTimers = [];
  }
  function stewardScheduleWake() {
    if (!stewardRuntime.running) return;   // 管家关着 / 停机:没人取,不补拍
    if (stewardRuntime.ticking) stewardRuntime.wakePending = true;
    if (stewardRuntime.wakeTimers.length) return;
    const generation = stewardRuntime.generation;
    for (const delay of STEWARD_WAKE_DELAYS_MS) {
      const timer = setTimeout(() => {
        stewardRuntime.wakeTimers = stewardRuntime.wakeTimers.filter(item => item !== timer);
        if (!stewardRuntime.running || stewardRuntime.generation !== generation) return;
        void stewardRunTick();
      }, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
      stewardRuntime.wakeTimers.push(timer);
    }
  }
  function stewardQueueThreadAdopted(data) {
    const sid = safeSessionId(data && data.sessionId);
    if (!sid || sid === STEWARD_SESSION_ID) return;
    const note = String((data && data.note) || '').slice(0, 200);
    // 135(真机取证:收件箱 93/94 两条一模一样的 adopted 各叫醒一回合,管家第二回只能说「同上一条,
    // 不用重复处理」):同一条线程、同一句委托在窗口内再来一次就是重复投递,不再叫醒管家。
    // 委托换了一句话照常入箱 —— 那是用户补了新交代。只在内存里记,重置随运行时一起清。
    if (!(stewardRuntime.adoptedRecent instanceof Map)) stewardRuntime.adoptedRecent = new Map();
    const now = Date.now();
    for (const [key, at] of stewardRuntime.adoptedRecent) {
      if (now - at > STEWARD_ADOPTED_DEDUPE_MS) stewardRuntime.adoptedRecent.delete(key);
    }
    const dedupeKey = sid + '\n' + note;
    if (stewardRuntime.adoptedRecent.has(dedupeKey)) return;
    stewardRuntime.adoptedRecent.set(dedupeKey, now);
    stewardRuntime.adopted.push({
      sessionId: sid,
      missionId: String((data && data.missionId) || sid),
      title: String((data && data.title) || ''),
      // 121-K6a(§4.4「委托一句」):用户交接时顺手带的一句话(02 已经 trim+≤200 字)。这里只再夹一次
      // 防御性上限,不再改内容——它要原样出现在管家下一回合看到的人话里。
      note,
      at: String((data && data.at) || nowIso()),
    });
    while (stewardRuntime.adopted.length > STEWARD_ADOPTED_QUEUE_MAX) stewardRuntime.adopted.shift();
    stewardScheduleWake();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 在场门(121-K3,34 号文 §4.3「在场信号与打扰纪律」)。
  //
  // 事实源是 13r 的在场快照(每条 SSE 连接自报的 lens 与 sessionId),经 00-boot 的延迟绑定命名空间
  // 取 —— 13i 拼在 13r 之前,直引 13r 的符号是前向边。读不到(钩子未填充 / 事件流关着 / 抛错)一律
  // 当「没人在壳里」= 今天的行为:这道门管的是【打扰纪律】,不是权限,fail-open 才对。
  //
  // 四种情形(§4.3 逐条):
  //   ① 用户在工作台、且正坐在这条线程上 -> 事件【不入箱】(索引与徽标照常更新,他自己看得见);
  //   ② 用户在工作台、但坐在别的线程     -> needs_you/failed/stalled/budget 照进箱并打 quiet:true
  //                                        (前端安静卡读它);done 不进(§4.3 明说「done 只更新左栏」);
  //   ③ 用户在管家视角                   -> 今天的行为,一个字不改;
  //   ④ 没有任何连接                     -> 累积,今天的行为。
  // ②里 stalled/budget 两类设计稿没点名:它们与 needs_you/failed 同属「有事要你知道」,按同一档处理
  // (进箱 + quiet),而不是像 done 那样丢掉 —— 丢掉它们等于用户回到管家视角时永远补不上这两类。
  // ③ 排在 ② 之前:两个视角同时连着时,管家视角开着就说明收件箱那一面正被人看着,它才是该收东西的那面。
  // adopted 不过门:它是用户【刚刚亲手按下】的交接,他要的就是管家应一声,不存在打扰问题。
  //
  // 2026-10(用户:「如果用户在看提问、权限,管家被立刻唤醒也不要插手」):viewing(13r 头注)【不】在这道门里处理 ——
  // 入箱的是事实与通知(安静卡、到访摘要都读它),用户正看着一道提问不该让那张安静卡消失。「管家不插手」落在两处:
  // 13q 的回合排空器把被看着的待决扣在回合队列外(不为它起回合),13k stewardSeatedByUser 让代批 / 代答工具拒绝。
  // 下面两个小工具给 13q 用(它们读的是本文件同一份在场快照)。
  // ────────────────────────────────────────────────────────────────────────────
  function stewardViewingSessionIds(presence) {
    const out = new Set();
    for (const row of (Array.isArray(presence) ? presence : [])) {
      for (const sid of (row && Array.isArray(row.viewing) ? row.viewing : [])) if (sid) out.add(String(sid));
    }
    return out;
  }
  function stewardPendingKeyOf(evt) {
    const iv = evt && evt.payload && evt.payload.interventionId;
    return iv ? String(evt.sessionId || '') + '\u0000' + String(iv) : '';
  }
  // 这条待决此刻还挂着吗(读本文件游标上那份全局待决集合;13q 放行被扣住的事件前问它)。
  function stewardPendingStillOpen(evt) {
    const key = stewardPendingKeyOf(evt);
    return Boolean(key) && stewardRuntime.cursor.pendingIds.has(key);
  }
  function stewardPresenceRows() {
    try {
      const rows = typeof EventStreamHooks.presenceSnapshot === 'function' ? EventStreamHooks.presenceSnapshot() : [];
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }
  function stewardApplyPresenceGate(events) {
    const list = Array.isArray(events) ? events : [];
    const presence = stewardPresenceRows();
    if (!presence.length) return list;                       // ④
    const seated = new Set();
    let classicPresent = false, stewardPresent = false;
    for (const row of presence) {
      const lens = String((row && row.lens) || '');
      if (lens === 'steward') { stewardPresent = true; continue; }
      if (lens !== 'classic') continue;
      classicPresent = true;
      const sid = String((row && row.sessionId) || '');
      if (sid) seated.add(sid);
    }
    if (stewardPresent || !classicPresent) {                 // ③ 与「只有别的 lens 连着」
      return list.filter(evt => !seated.has(String((evt && evt.sessionId) || '')) || String((evt && evt.kind) || '') === 'adopted');
    }
    const out = [];
    for (const evt of list) {
      const sid = String((evt && evt.sessionId) || '');
      const kind = String((evt && evt.kind) || '');
      if (kind === 'adopted') { out.push(evt); continue; }
      if (seated.has(sid)) continue;                         // ①
      if (kind === 'done') continue;                         // ②:收工只更新左栏
      out.push({ ...evt, payload: { ...((evt && evt.payload && typeof evt.payload === 'object') ? evt.payload : {}), quiet: true } });
    }
    return out;
  }

  function stewardResetRuntimeState() {
    stewardRuntime.loaded = false;
    stewardRuntime.cold = true;
    stewardRuntime.inboxSeq = 0;
    stewardRuntime.lastTickAt = '';
    stewardRuntime.lastInboxAt = '';
    stewardRuntime.lastMaintenanceAt = 0;
    stewardRuntime.lastError = '';
    stewardRuntime.seen = new Set();
    stewardRuntime.cursor = { missionChanges: {}, agentRuns: {}, pendingIds: new Set(), budgetSeen: new Set(), sessionTurns: {} };
    stewardRuntime.cursorSig = '';   // 重置 = 磁盘上那份不再可信,下一拍必须重写
    stewardRuntime.carry = [];
    stewardRuntime.adopted = [];   // 121-K3:交接队列随运行时一起重置(它不落盘,重置即清)
    stewardRuntime.adoptedRecent = new Map();   // 135:重复交接的去重窗口,同上
  }

  // inbox 尾窗读取:小文件整读;大文件只读尾窗并丢弃首个半行(换行是单字节 0x0A,永不落在 UTF-8
  // 多字节序列中 —— 与 readAgentRunEvents 的尾窗纪律同源)。文件不存在 = 空(绝不 mkdir)。
  async function stewardReadInboxText() {
    const file = stewardInboxPath();
    let size = -1;
    try { size = (await fsp.stat(file)).size; } catch { return { text: '', droppedHead: false }; }
    if (size <= STEWARD_INBOX_FULL_READ_BYTES) {
      try { return { text: await fsp.readFile(file, 'utf8'), droppedHead: false }; } catch { return { text: '', droppedHead: false }; }
    }
    let fh = null;
    try {
      fh = await fsp.open(file, 'r');
      const buf = Buffer.alloc(STEWARD_INBOX_TAIL_BYTES);
      const { bytesRead } = await fh.read(buf, 0, STEWARD_INBOX_TAIL_BYTES, size - STEWARD_INBOX_TAIL_BYTES);
      return { text: buf.toString('utf8', 0, bytesRead), droppedHead: true };
    } catch { return { text: '', droppedHead: false }; }
    finally { if (fh) await fh.close().catch(() => {}); }
  }

  // 解析 inbox 文本为行对象。坏行/尾部半行一律跳过(append-only 日志的既有纪律)。
  function stewardParseInboxText(text, droppedHead) {
    const lines = String(text || '').split('\n');
    const rows = [];
    for (let i = droppedHead ? 1 : 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const row = safeJsonParse(line, null);
      if (!row || typeof row !== 'object') continue;
      if (!Number.isSafeInteger(Number(row.inboxSeq)) || !STEWARD_EVENT_KINDS.includes(row.kind)) continue;
      rows.push(row);
    }
    return rows;
  }

  async function stewardReadInboxRows() {
    const { text, droppedHead } = await stewardReadInboxText();
    return stewardParseInboxText(text, droppedHead);
  }

  function stewardInboxPendingState(row, pending) {
    if (!pending) return 'unknown';
    const ids = new Set([row.payload?.interventionId, row.seq, ...(Array.isArray(row.payload?.mergedSeqs) ? row.payload.mergedSeqs : [])]
      .filter(id => typeof id === 'string' && id));
    for (const id of ids) if (pending.has(String(row.sessionId || '') + '\u0000' + id)) return 'pending';
    // 合并行只记录前 20 个源 id;id 不全时不能推断这一整组已经处理完。
    return !ids.size || Number(row.count) > ids.size ? 'unknown' : 'not_pending';
  }

  // 只整理通知副本,不动会话/待决/审计源。与 append 共用写链,读失败绝不能把原文件覆盖成空。
  // 当前待决不受年龄/历史条数限制;最后一行保留作序号水位,重启和增量读取都不会倒退。
  function stewardMaintainInbox(now = Date.now()) {
    if (now - stewardRuntime.lastMaintenanceAt < STEWARD_INBOX_MAINTENANCE_MS) return Promise.resolve();
    const pending = new Set(stewardRuntime.cursor.pendingIds);
    const next = stewardAppendChain.catch(() => {}).then(async () => {
      stewardRuntime.lastMaintenanceAt = now; // 故障也节流,坏文件/瞬时锁不能让每拍变成全量扫描。
      const file = stewardInboxPath();
      try { await fsp.stat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      const input = fs.createReadStream(file, { encoding: 'utf8' });
      const lines = require('node:readline').createInterface({ input, crlfDelay: Infinity });
      const history = [], active = [];
      let latest = null, count = 0;
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          const row = safeJsonParse(line, null);
          // 未知/损坏格式交给原有读取与修复纪律;整理器不擅自丢弃无法理解的数据。
          if (!row || !Number.isSafeInteger(Number(row.inboxSeq)) || !STEWARD_EVENT_KINDS.includes(row.kind)) throw new Error('steward.inbox_maintenance_invalid_row');
          count += 1;
          if (!latest || Number(row.inboxSeq) > Number(latest.inboxSeq)) latest = row;
          if (row.kind === 'needs_you' && stewardInboxPendingState(row, pending) !== 'not_pending') active.push(row);
          else if (!Number.isFinite(Date.parse(row.at)) || Date.parse(row.at) >= now - STEWARD_INBOX_RETENTION_MS) {
            history.push(row);
            if (history.length > STEWARD_INBOX_HISTORY_MAX) history.shift();
          }
        }
      } finally { lines.close(); input.destroy(); }
      const kept = active.concat(history);
      if (latest && !kept.includes(latest)) kept.push(latest);
      kept.sort((a, b) => Number(a.inboxSeq) - Number(b.inboxSeq));
      if (kept.length < count) await atomicWriteJson(file, kept.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
      stewardRuntime.lastMaintenanceAt = now;
    });
    stewardAppendChain = next.catch(() => {});
    return next;
  }

  // 游标读取。读坏/缺失 → 冷启动(inboxSeq 从 inbox 尾行恢复,去重集合从 inbox 尾部 N 行重建,
  // 三源只建基线不补历史)。这条正是「cursor 读坏 → 从零开始但不重复已在 inbox 里的键」。
  function stewardLoadState() {
    if (stewardRuntime.loaded) return Promise.resolve();
    if (!stewardStateLoad) {
      stewardStateLoad = stewardReadStateFromDisk().finally(() => { stewardStateLoad = null; });
    }
    return stewardStateLoad;
  }

  async function stewardReadStateFromDisk() {
    stewardResetRuntimeState();
    const rows = await stewardReadInboxRows();
    const tail = rows.slice(-STEWARD_DEDUPE_TAIL_ROWS);
    for (const row of tail) for (const key of stewardInboxRowDedupeKeys(row)) stewardRuntime.seen.add(key);
    for (const row of rows) stewardRuntime.inboxSeq = Math.max(stewardRuntime.inboxSeq, Number(row.inboxSeq) || 0);

    // 116-3 P1-8:把「游标文件不存在」与「游标文件坏了」分开。前者是真冷启动(第一次跑,没有历史要补);
    // 后者按注释一直宣称的口径是「从零开始,重复由 seen 兜底」,而修前的实现是 cold 保持 true ->
    // stewardCollectEvents 把每个会话的基线【直接设成当前版本号】,于是从损坏那一刻回溯到最后一次成功
    // 保存之间的全部 mission-change / agent-run 增量被静默跳过,连一条错误日志都没有。
    let raw = null;
    let corrupt = false;
    try {
      raw = safeJsonParse(await fsp.readFile(stewardCursorPath(), 'utf8'), null);
      if (!raw) corrupt = true;                                   // 文件在,但不是合法 JSON
    } catch (error) {
      raw = null;
      if (!error || error.code !== 'ENOENT') corrupt = true;       // 文件在但读不动(权限/IO):同样按损坏处理
    }
    if (raw && typeof raw === 'object' && Number(raw.schema) !== STEWARD_CURSOR_SCHEMA) corrupt = true;
    if (raw && typeof raw === 'object' && Number(raw.schema) === STEWARD_CURSOR_SCHEMA) {
      const sources = (raw.sources && typeof raw.sources === 'object') ? raw.sources : {};
      const mc = (sources.missionChanges && typeof sources.missionChanges === 'object' && !Array.isArray(sources.missionChanges)) ? sources.missionChanges : {};
      const ar = (sources.agentRuns && typeof sources.agentRuns === 'object' && !Array.isArray(sources.agentRuns)) ? sources.agentRuns : {};
      for (const [sid, revision] of Object.entries(mc).slice(0, STEWARD_CURSOR_MAX_SESSIONS)) {
        const n = Number(revision);
        if (safeSessionId(sid) && Number.isSafeInteger(n) && n >= 0) stewardRuntime.cursor.missionChanges[sid] = n;
      }
      for (const [runId, seq] of Object.entries(ar).slice(0, STEWARD_CURSOR_MAX_RUNS)) {
        const n = Number(seq);
        if (safeSessionId(runId) && Number.isSafeInteger(n) && n >= 0) stewardRuntime.cursor.agentRuns[runId] = n;
      }
      const pending = Array.isArray(sources.pendingIds) ? sources.pendingIds : [];
      for (const key of pending.slice(0, STEWARD_CURSOR_MAX_PENDING)) if (typeof key === 'string' && key) stewardRuntime.cursor.pendingIds.add(key);
      // 116-3 P1-9:budget 类事件的持久去重集合(键 = sessionId)。缺这一段的老游标读出来是空集,
      // 于是重启后每个仍标着 budgetExhausted 的事项会再入箱一次 —— 那不算错(重启补一次是可接受的),
      // 真正被修掉的是「长跑进程里滑出 2000 行尾窗之后反复重复」。
      const budgetSeen = Array.isArray(sources.budgetSeen) ? sources.budgetSeen : [];
      for (const sid of budgetSeen.slice(0, STEWARD_CURSOR_MAX_SESSIONS)) if (typeof sid === 'string' && sid) stewardRuntime.cursor.budgetSeen.add(sid);
      // 116-4:第四源游标。老游标没有这一段 -> 读出来是空对象 = 每条会话都算「首见」,由首见纪律
      // (只有关心的 + 最近动过的 + 回合数不多的才补一条)兜住,不会把历史整份倒灌进箱子。
      const st = (sources.sessionTurns && typeof sources.sessionTurns === 'object' && !Array.isArray(sources.sessionTurns)) ? sources.sessionTurns : {};
      for (const [sid, value] of Object.entries(st).slice(0, STEWARD_CURSOR_MAX_SESSIONS)) {
        if (!safeSessionId(sid) || !value || typeof value !== 'object') continue;
        const turnSeq = Number(value.turnSeq);
        if (!Number.isSafeInteger(turnSeq) || turnSeq < 0) continue;
        stewardRuntime.cursor.sessionTurns[sid] = { turnSeq, stamp: String(value.stamp || '') };
      }
      const savedSeq = Number(raw.inboxSeq);
      if (Number.isSafeInteger(savedSeq) && savedSeq > stewardRuntime.inboxSeq) stewardRuntime.inboxSeq = savedSeq;
      stewardRuntime.cold = false;
    }
    if (corrupt) {
      // 「从零开始」= 三源首见时基线设 0、把历史增量真的读进来(上限仍是 STEWARD_FIRST_SIGHT_MAX_*),
      // 重复交给 seen 集合兜底(它已经从 inbox 尾部 2000 行重建过了)。并且【留下痕迹】:
      // 修前这条路径连 lastError 都不置,用户与后来的人根本不知道游标丢过。
      stewardRuntime.cold = false;
      stewardRuntime.lastError = 'cursor-v1.json 损坏或不可读,本次按「从零开始」重建(重复由去重集合兜底)';
      try { logEvent({ kind: 'steward_cursor_corrupt', detail: stewardRuntime.lastError }); } catch { /* 观测绝不反噬 */ }
    }
    stewardRuntime.loaded = true;
  }

  // append:与 session-changes 同款原语(repairMissionChangeTornTail + appendFile),per-process 串行。
  function stewardAppendInboxRows(drafts) {
    if (!drafts.length) return Promise.resolve([]);
    const next = stewardAppendChain.catch(() => {}).then(async () => {
      await stewardLoadState();
      const file = stewardInboxPath();
      // 轮询与定时提醒按实际落盘顺序分配序号。失败的批次不推进已发布水位。
      const previousSeq = stewardRuntime.inboxSeq;
      const rows = drafts.map(({ inboxSeq: _inboxSeq, ...row }, index) => ({ inboxSeq: previousSeq + index + 1, ...row }));
      const payload = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
      await fsp.mkdir(stewardDir(), { recursive: true });
      await repairMissionChangeTornTail(file); // 尾部半行先截干净,再整行 append(防焊接)
      // Windows 上杀软/备份软件短暂持锁的 EBUSY/EPERM/EACCES:与 02 appendIntervention 同款有界重试。
      // 仍失败就抛给 stewardTickOnce —— 那里把这一批原始事件放回结转队列,下一拍重来(见那里的注释)。
      for (let attempt = 0; ; attempt++) {
        try { await fsp.appendFile(file, payload, 'utf8'); break; }
        catch (e) { if (attempt >= 3 || !/^(EPERM|EBUSY|EACCES)$/.test(String(e && e.code))) throw e; await new Promise(r => setTimeout(r, 10 + attempt * 20)); }
      }
      stewardRuntime.inboxSeq = rows.at(-1).inboxSeq;
      stewardRuntime.lastInboxAt = nowIso();
      for (const row of rows) for (const key of stewardInboxRowDedupeKeys(row)) stewardRuntime.seen.add(key);
      // 121-K2a(§6.1 第 3 条):箱子真的多了这些行之后才派。正文不进事件面 —— 只有「哪条线程、哪一类」;
      // 想看内容仍走 GET /api/steward/inbox(§6.1 红线:事件流不承载正文)。
      // 121-K6a(34 号文 §4.3 安静卡):补 quiet(在场门②情形打的旗)与卡上要印的一句话(ask)——
      // needs_you 是问句,failed/stalled/budget 是「一句事实」,两者在归一化函数里都已经写进
      // payload.ask/payload.summary(与 thread.done 的 summary 同一档:构造好的短句,不是正文,
      // §6.1 红线挡的是工具输出原文)。这里只挑一个已有字段透传,不新算一遍。
      for (const row of rows) {
        const payload = (row && row.payload && typeof row.payload === 'object') ? row.payload : {};
        const frame = { sessionId: String((row && row.sessionId) || ''), kind: String((row && row.kind) || '') };
        // 123-M2:两个【标识】字段。安静卡「稍后」要把 sourceRef 指回它是从哪一行来的
        // (37 号文 §3.5 的 `sourceRef:{inboxSeq, sessionId, kind}`),而 reminder 那一类可以完全不
        // 属于任何线程 —— 没有 taskId 就没有第二个身份可用,两条提醒会在前端合并成一张。
        // 两个都是 id/序号,不是正文(§6.1 红线挡的是工具输出原文)。
        if (Number(row && row.inboxSeq) > 0) frame.inboxSeq = Number(row.inboxSeq);
        if (payload.taskId) frame.taskId = String(payload.taskId);
        if (payload.quiet === true) frame.quiet = true;
        const ask = payload.ask || payload.summary || '';
        if (ask) frame.ask = String(ask).slice(0, 200);
        // interventionId 是 POST /api/chat/answer 顶层 questionId 要的那个键(pendingQuestions 的注册键,
        // 与子问题自己的 answerQuestionId 不是同一个 id)——安静卡「候选答案按钮」两个 id 都要,缺一不可。
        if (payload.interventionId) frame.interventionId = String(payload.interventionId);
        if (payload.answerQuestionId) frame.answerQuestionId = String(payload.answerQuestionId);
        if (Array.isArray(payload.options) && payload.options.length) frame.options = payload.options;
        RUYI_EVENTS.emit('inbox.appended', frame);
      }
      // 按装载时的尾窗重建去重集合。与写入串行，避免重建覆盖期间追加的新键。
      if (stewardRuntime.seen.size > STEWARD_SEEN_MAX_KEYS) {
        const recent = (await stewardReadInboxRows()).slice(-STEWARD_DEDUPE_TAIL_ROWS);
        stewardRuntime.seen = new Set(recent.flatMap(stewardInboxRowDedupeKeys));
      }
      return rows;
    });
    stewardAppendChain = next.catch(() => {});
    return next;
  }

  // 按 order 的顺序从 source 里挑出「有游标条目」的键,一趟同时产出两份:
  //   kept      —— 进程内存里留的(至多 memMax 条);
  //   persisted —— 写进 cursor-v1.json 的(至多 persistMax 条,恒为 kept 的前缀,所以「活跃的先留」的优先级不变)。
  // 计数用局部计数器,【不要】在循环里对累积对象再取 Object.keys(obj).length —— 那是 O(n^2),
  // 把上限调到 2 万之后 2000 会话一次 save 就阻塞事件循环 460ms(实测)。
  function stewardTrimCursorMap(order, source, memMax, persistMax) {
    const kept = {};
    const persisted = {};
    let keptCount = 0;
    let persistedCount = 0;
    for (const key of order) {
      if (keptCount >= memMax) break;
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      if (Object.prototype.hasOwnProperty.call(kept, key)) continue;   // order 里重复的键只算一次
      kept[key] = source[key];
      keptCount += 1;
      if (persistedCount < persistMax) { persisted[key] = source[key]; persistedCount += 1; }
    }
    return { kept, persisted };
  }

  // 游标收紧 + 落盘。两档容量:内存游标保留本轮还见得到的全部会话/run(硬顶见 STEWARD_CURSOR_MEM_MAX_*,
  // 会话被删了自然被清掉),落盘只取其中排在最前(活跃优先)的 STEWARD_CURSOR_MAX_* 条 —— 重启后读回的
  // 语义与修前一致(超出落盘上限的会话重启后仍算首见),但运行期不再每拍把它们重新当首见。
  // 落盘只在内容真的变了时才写(指纹见 stewardRuntime.cursorSig),并且写紧凑 JSON(没人读缩进)。
  async function stewardSaveCursor(activeSessionIds, activeRunIds) {
    const mc = stewardTrimCursorMap(activeSessionIds, stewardRuntime.cursor.missionChanges, STEWARD_CURSOR_MEM_MAX_SESSIONS, STEWARD_CURSOR_MAX_SESSIONS);
    const ar = stewardTrimCursorMap(activeRunIds, stewardRuntime.cursor.agentRuns, STEWARD_CURSOR_MEM_MAX_RUNS, STEWARD_CURSOR_MAX_RUNS);
    stewardRuntime.cursor.missionChanges = mc.kept;
    stewardRuntime.cursor.agentRuns = ar.kept;
    const pendingIds = [...stewardRuntime.cursor.pendingIds].slice(0, STEWARD_CURSOR_MAX_PENDING);
    // 落盘容量不能裁掉内存中的当前待决,否则超出 2000 的部分每拍重复入箱,整理时还会被误认已处理。
    // 116-3 P1-9:budgetSeen 与另外两源同款做容量控制 —— 只留【本轮还见得到的会话】(会话没了就没有
    // 再去重的对象),再夹一次硬顶。它不像 pendingIds 那样每轮整份重算(预算触顶是一次性持久标记,
    // 不会「自然消失」),所以裁剪必须显式做,否则长跑进程里它只增不减。
    const activeSet = new Set(activeSessionIds);
    const budgetKept = [];
    for (const key of stewardRuntime.cursor.budgetSeen) {
      if (budgetKept.length >= STEWARD_CURSOR_MEM_MAX_SESSIONS) break;
      if (activeSet.has(String(key).split('\u0000')[0])) budgetKept.push(key);   // 键 = 会话 id(+ \u0000 + 用尽时刻)
    }
    stewardRuntime.cursor.budgetSeen = new Set(budgetKept);
    const budgetSeen = budgetKept.slice(0, STEWARD_CURSOR_MAX_SESSIONS);
    // 116-4:第四源游标同款裁剪 —— 只留本轮还见得到的会话(会话被删了就没有再去重的对象),再夹硬顶。
    const st = stewardTrimCursorMap(activeSessionIds, stewardRuntime.cursor.sessionTurns, STEWARD_CURSOR_MEM_MAX_SESSIONS, STEWARD_CURSOR_MAX_SESSIONS);
    stewardRuntime.cursor.sessionTurns = st.kept;
    const missionChanges = mc.persisted;
    const agentRuns = ar.persisted;
    const sessionTurns = st.persisted;
    const sig = stewardRuntime.inboxSeq + '|' + JSON.stringify({ missionChanges, agentRuns, pendingIds, budgetSeen, sessionTurns });
    if (sig === stewardRuntime.cursorSig) return { written: false };
    await fsp.mkdir(stewardDir(), { recursive: true });
    await atomicWriteJson(stewardCursorPath(), JSON.stringify({
      schema: STEWARD_CURSOR_SCHEMA,
      inboxSeq: stewardRuntime.inboxSeq,
      updatedAt: nowIso(),
      sources: { missionChanges, agentRuns, pendingIds, budgetSeen, sessionTurns },
    }));
    stewardRuntime.cursorSig = sig;   // 写成功才记:写失败下一拍照旧重试
    return { written: true };
  }

  // ── 116-4 第四源 sessionTurns(27 号文 §11.7)─────────────────────────────────
  // 为什么需要它:前三源全都挂在【事项】上 —— 02 的 bumpMissionChangeSeq 读会话头,`!head.mission`
  // 就直接返回 null,而管家自己开的线程(steward_quick_ask / steward_thread_new)恰恰【没有】 mission
  // 容器。于是它们跑完之后三条源日志一个字都不写,收件箱永远是空的,管家也就永远不会被唤醒。
  // 116-4 复现:开一条速查 + 一条委托线程,两条都真跑完,inbox 0 行、cursor 里两条会话 changeSeq 全 0
  // —— 与用户机器上的证据逐条对上。
  //
  // 事实来源是会话头本身:turnSeq 前进 + 当前无活回合 = 这条线程的一个回合结束了。成败读 13g 在回合
  // settle 之后落的 stewardLastTurn(会话头上本来没有任何回合成败字段,实测过)。
  // 成本:先拿投影免费给的 sourceStamp(会话文件的 size:mtime 指纹)比一次,没变就连头都不读。
  async function stewardReadTurnHead(sessionId) {
    try { return safeJsonParse(await fsp.readFile(sessionPath(sessionId), 'utf8'), null); } catch { return null; }
  }

  // 「管家关心这条会话吗」的唯一判据(§11.7)【定义已搬到 06i-steward-core.js】——
  // 117r-D1 起第二个消费者是 13e 的卡片产生条件(看板正文的唯一数据源 GET /api/missions),
  // 而 13e 拼在 13i 之前,引用 13i 会是前向边。这里【不】留第二份实现,也不留同名薄封装:
  // 本文件下面那处 stewardCollectSessionTurn 直接调 06i 的那一份(后向边,已在依赖图里)。

  // 2026-09-24(用户:「线程没跑完交付就一直把进度同步给我」):回合收了、但这条线程还有后台活儿在跑
  // (后台命令 / 活着的子代理与班组 run)时,这一回合不算交付。按「回合还在跑」同一纪律不入箱、不推基线,
  // 等后台活儿全部落地后的那一轮再报【一次】—— 否则管家先报一遍「回合跑完了」(那一回合以工具调用收尾,
  // 没有收口的话,交付卡只能画「没取到原文」),后台跑完再被「班组收工」叫醒报第二遍。
  // 读的是进程内真值(11 的后台 shell 表经 EventStreamHooks 延迟绑定、07 的 activeAgentRuns),不读盘。
  const STEWARD_RUN_TERMINAL = new Set(['succeeded', 'failed', 'partial', 'stopped', 'cancelled', 'skipped']);
  function stewardThreadBackgroundBusy(sid) {
    try {
      const shells = EventStreamHooks.backgroundShells;
      if (shells && typeof shells.rows === 'function' && shells.rows(sid).length) return true;
    } catch { /* 读不到按没有:这道门管的是打扰纪律,fail-open 回到修前行为 */ }
    for (const [, live] of activeAgentRuns) {
      const run = live && live.run;
      if (run && run.sessionId === sid && !STEWARD_RUN_TERMINAL.has(String(run.status || ''))) return true;
    }
    return false;
  }
  // 本轮因「后台活儿没完」按住回合报告的【被看管】线程。它们的班组 done 由那条迟到的回合报告一并交代,
  // 不再单独叫醒管家(failed / 预算触顶照报 —— 那是「有事要你知道」)。每轮 stewardCollectEvents 开头清空。
  const stewardHeldTurnSessions = new Set();

  // 返回本轮该为这条会话入箱的事件(至多一条)或 null;顺带维护它自己的游标。
  async function stewardCollectSessionTurn(sid, missionId, row, now) {
    const stamp = String((row && row.sourceStamp) || '');
    const known = stewardRuntime.cursor.sessionTurns[sid];
    if (known && known.stamp && stamp && known.stamp === stamp) return null;   // 文件一个字节没动:零磁盘读
    const head = await stewardReadTurnHead(sid);
    if (!head || !head.id) return null;
    const turnSeq = Math.max(0, Number(head.turnSeq) || 0);
    // 3.0 收口走查(第四波):再加 turnSettlers(10 runSessionTurn 从起手到收尾整段登记)。activeChildren 挡不住两个窗口 ——
    // 起手:turnSeq 已 +1 落盘、引擎还没登记进 activeChildren(中间隔着 captureWorkspaceTurnBaseline,大工作区好几秒);
    // 收尾:activeChildren 已删、turnOutcomePending 还没加(中间是 reconcile / 存会话 / onTurnEnd 几次 await)。
    // 修前已见过的线程落在这两个窗口里会被报一条「跑完了」并把基线推到 N,真正的结果(尤其是失败)再也报不出来。
    // 首见那一支早有 inFlight 判据兜同一个窗口;这里对所有线程统一用 turnSettlers。
    if (activeChildren.has(sid) || turnOutcomePending.has(sid) || turnSettlers.has(sid)) {
      // (turnOutcomePending:回合已收、成败账正在写 —— 同样等下一拍,见 04 的头注)
      // 回合还在跑:不入箱,而且【不】记指纹 —— 记了下一轮就会跳过这个头,等它跑完再也没人看它一眼。
      // 117p(用户第七轮走查:「2.0 回合已经跑完了,管家没有收到体现也没收工」):首见就撞上活回合时,
      // 基线必须是【这一回合之前】那个号。turnSeq 在回合【开始】那一刻就 +1 落盘(05:88 / 09:1292,
      // 都紧跟 saveSession),所以此刻头上的号就是【正在跑】的那一回合 —— 记成基线 = 把它算作已报过,
      // 等它真的跑完 turnSeq 没再前进,唯一那条 done 被永久吞掉。真机证据(2026-09-08):
      // sess_e97b29759a586485 头上 turnSeq:1 + stewardLastTurn{seq:1,ok:true},游标记着 {turnSeq:1},
      // inbox 里这条会话零行 —— 管家开的线程第一回合几乎必然命中(轮询 15 秒,那条线程跑了 11 分钟)。
      stewardRuntime.cursor.sessionTurns[sid] = { turnSeq: known ? known.turnSeq : Math.max(0, turnSeq - 1), stamp: '' };
      return null;
    }
    const watched = stewardWatchedThread(head, sid, missionId);
    if (turnSeq > 0 && stewardThreadBackgroundBusy(sid)) {
      // 同上一支:基线停在已报过的那一回合(首见退到上一回合;冷启动只建基线,不把老回合倒灌进箱),
      // stamp 置空保证下一轮一定重读这个头。后台活儿跑完的那一轮 turnSeq > 基线,照常报一次。
      const heldBaseline = known ? known.turnSeq : (stewardRuntime.cold ? turnSeq : Math.max(0, turnSeq - 1));
      stewardRuntime.cursor.sessionTurns[sid] = { turnSeq: heldBaseline, stamp: '' };
      if (watched && turnSeq > heldBaseline) stewardHeldTurnSessions.add(sid);
      return null;
    }
    if (known == null) {
      // 首见。【不能】一律按「基线 = 当前 turnSeq」:速查线程从建到跑完只要几秒,而轮询 15 秒一轮 ——
      // 第一次看见它时回合早就结束了,按当前 turnSeq 建基线等于把唯一那条 done 永久吞掉(这正是本波
      // 要修的那个洞的另一半)。故:关心的 + 最近动过的 + 回合数不多的线程,首见就补这一条;
      // 冷启动(本次装载没有可用游标)与存量老线程仍然只建基线,不把历史倒灌进箱子。
      const updatedMs = Date.parse(String(head.updatedAt || ''));
      const fresh = Number.isFinite(updatedMs) && (now - updatedMs) <= STEWARD_ACTIVE_WINDOW_MS;
      const backfill = watched && fresh && !stewardRuntime.cold && turnSeq > 0 && turnSeq <= STEWARD_FIRST_SIGHT_MAX_TURNS;
      // 117p ②(同一条真机证据的另一半):上面 activeChildren.has(sid) 那道判据挡不住「回合已起手、
      // 还没登记进 activeChildren」的窗口 —— 09-workflow.js 把 turnSeq 落盘(1292)与
      // activeChildren.set(1381)之间隔着 captureWorkspaceTurnBaseline(大工作区要好几秒)。首见正好
      // 落在这个窗口里时,backfill 会当场报一条「这回合跑完了」(其实还在跑),并把基线推到当前
      // turnSeq —— 真跑完时反而再也报不出来。判据用确定性落盘证据,不猜时间/心跳:管家发起的线程由
      // 13g 的 stewardRecordLaunchOutcome 在 settle 之后写 stewardLastTurn,last.seq >= turnSeq 才算
      // 这一回合真的结束了。只在 known == null 这一次用它:之后 known != null,普通的
      // turnSeq > baseline 就够了 —— 否则用户在 2.0 视窗里自己接着聊的那些回合(它们不写
      // stewardLastTurn)会被永久判成「还没结束」,那是把一个洞换成另一个洞。
      const last = (head.stewardLastTurn && typeof head.stewardLastTurn === 'object') ? head.stewardLastTurn : null;
      const inFlight = String(head.launchedBy || '') === 'steward'
        && !(Math.max(0, Number(last && last.seq) || 0) >= turnSeq);
      if (backfill && inFlight) {
        // 回合已起手、还没登记进 activeChildren 的窗口:这一轮什么都不报,基线退到上一回合,
        // 等 13g 的成败账落盘之后的某一轮再报 —— stamp 置空,保证下一轮一定会重读这个头。
        stewardRuntime.cursor.sessionTurns[sid] = { turnSeq: Math.max(0, turnSeq - 1), stamp: '' };
        return null;
      }
      stewardRuntime.cursor.sessionTurns[sid] = { turnSeq: backfill ? 0 : turnSeq, stamp: backfill ? '' : stamp };
      if (!backfill) return null;
    }
    const baseline = Math.max(0, Number(stewardRuntime.cursor.sessionTurns[sid].turnSeq) || 0);
    stewardRuntime.cursor.sessionTurns[sid] = { turnSeq, stamp };
    if (!watched || turnSeq <= baseline) return null;
    const evt = stewardNormalizeSessionTurn(sid, missionId, head, turnSeq);
    if (evt) stewardRuntime.sourcesSeen.sessionTurns += 1;
    return evt;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 轮询一轮。
  //
  // 成本纪律(§11.3「不得每次全量扫所有会话」):先取投影索引(进程内可重建缓存,脏页增量刷新),
  // 只对【活跃】会话与 run 做增量磁盘读:
  //   · Mission Ledger:只有 row.changeSeq > 已记游标才读(投影里的 changeSeq 就是免费的「有没有新变化」);
  //   · agent run 事件:只读活跃会话里【未终态 或 24 小时内更新过】的 run;
  //   · 待决:直接来自投影内存数组,零磁盘读。
  // ────────────────────────────────────────────────────────────────────────────
  async function stewardCollectEvents() {
    const index = await getPretenderProjectionIndex();
    const now = Date.now();
    const events = [];
    const activeSessionIds = [];   // 活跃会话优先(游标硬顶到了先丢不活跃的,见 stewardSaveCursor)
    const idleSessionIds = [];
    const activeRunIds = [];
    const nextPending = new Set();
    stewardHeldTurnSessions.clear();

    // ── ⑤ 用户交接(121-K3,§4.4)。取走这一拍之前排进来的全部交接事件 —— 它不读盘、不走游标,
    //    排在最前是因为它发生得最早(用户按下开关的那一刻),排序器随后会按 at 再排一遍。
    const adoptedQueue = stewardRuntime.adopted;
    stewardRuntime.adopted = [];
    for (const record of adoptedQueue) {
      const evt = stewardNormalizeThreadAdopted(record);
      if (evt) events.push(evt);
    }

    for (const row of (index && Array.isArray(index.sessions) ? index.sessions : [])) {
      const sid = row && safeSessionId(row.sessionId);
      if (!sid) continue;
      // 116f 排除面之一:管家会话自己【绝不】进收件箱(否则管家的每个回合都会变成下一个回合的输入,
      // 一条自激励循环)。这里按固定 id 判(06i 的 STEWARD_SESSION_ID)而不是按会话头原始 kind:投影行
      // 里的 kind 是 sessionKind() 归一后的值(会把 steward 说成 quick_ask),拿到原始 kind 要为每行多读
      // 一次会话头 —— 每 15 秒一轮的轮询器不该为一个恒等判断付这个代价。双保险:13e 的扫描器只认
      // /^sess_/ 前缀的会话文件,取名 'steward' 的管家会话本来就到不了这个循环。
      if (sid === STEWARD_SESSION_ID) continue;
      const missionId = String(row.missionId || sid);
      const card = row.card || null;
      const updatedMs = Date.parse(String((card && card.updatedAt) || ''));
      const recent = Number.isFinite(updatedMs) && (now - updatedMs) <= STEWARD_ACTIVE_WINDOW_MS;

      // ── 待决(全局,不受活跃集限制:待决就是「需要你」,不能因为线程安静就漏报) ──
      let hasPending = false;
      for (const iv of (Array.isArray(row.interventions) ? row.interventions : [])) {
        if (!iv || iv.status !== 'pending') continue;
        hasPending = true;
        const id = String(iv.id || '');
        if (!id) continue;
        const pendingKey = sid + '\u0000' + id;
        nextPending.add(pendingKey);
        if (stewardRuntime.cursor.pendingIds.has(pendingKey)) continue;
        const evt = stewardNormalizePendingIntervention(sid, missionId, iv);
        if (evt) events.push(evt);
      }

      // ── 预算触顶(一次性持久标记) ──
      // 116-3 P1-9:去重键进游标(与 pendingIds 同款持久化),不再只靠内存 seen 集合的 2000 行尾窗。
      // 代码走查 C7:键是「会话 + 这一次用尽的时刻」。修前只按会话 id 去重,任务重启后再次用尽永远不再提醒。
      // 旧游标里的裸会话 id 认作「当前这一次已经提醒过」,换成新键(升级时不重复提醒)。
      const budgetEvt = stewardNormalizeBudgetExhausted(sid, missionId, card);
      // 卡片还没带上用尽时刻(升级前落盘的索引切片)时,旧键原样留着、照样当「已提醒」,等带上了再换。
      const exhaustedAt = String((card && card.mission && card.mission.budgetExhaustedAt) || '');
      const budgetKey = sid + '\u0000' + exhaustedAt;
      const budgetSeen = stewardRuntime.cursor.budgetSeen;
      if (budgetEvt && budgetSeen.has(sid)) { if (exhaustedAt) { budgetSeen.delete(sid); budgetSeen.add(budgetKey); } }
      else if (budgetEvt && !budgetSeen.has(budgetKey)) {
        budgetSeen.add(budgetKey);
        events.push(budgetEvt);
      }

      // ── ④ 会话回合(116-4 第四源) ──
      // 位置纪律:必须在下面那条「不活跃且账本没新版本就 continue」【之前】。速查线程没有 mission 卡片,
      // card.updatedAt 是空的 -> recent 恒 false -> active 恒 false;第二轮开始它就会被那条 continue
      // 直接跳过,放在后面等于第四源只在会话首见那一轮生效。
      const turnEvt = await stewardCollectSessionTurn(sid, missionId, row, now);
      if (turnEvt) events.push(turnEvt);

      const active = hasPending || recent;
      const knownRevision = Object.prototype.hasOwnProperty.call(stewardRuntime.cursor.missionChanges, sid)
        ? Number(stewardRuntime.cursor.missionChanges[sid]) : null;
      const revision = Math.max(0, Number(row.changeSeq) || 0);
      if (!active && knownRevision != null && revision <= knownRevision) { idleSessionIds.push(sid); continue; }
      (active ? activeSessionIds : idleSessionIds).push(sid);

      // ── ① Mission Change Ledger 增量 ──
      if (knownRevision == null) {
        // 首见:冷启动(或存量老会话)只建基线,不把历史灌进箱子;真正的新会话(revision 很小)照常全读。
        const baseline = (stewardRuntime.cold || revision > STEWARD_FIRST_SIGHT_MAX_REVISION) ? revision : 0;
        stewardRuntime.cursor.missionChanges[sid] = baseline;
        if (baseline < revision) {
          const meta = await readMissionChangesWithMeta(sid, revision).catch(() => null);
          for (const record of (meta && Array.isArray(meta.records) ? meta.records : [])) {
            if (Number(record.seq) <= baseline) continue;
            const evt = stewardNormalizeMissionChange({ ...record, sessionId: sid, missionId });
            if (evt) events.push(evt);
          }
          stewardRuntime.cursor.missionChanges[sid] = Math.max(baseline, revision);
        }
      } else if (revision > knownRevision) {
        const meta = await readMissionChangesWithMeta(sid, revision).catch(() => null);
        for (const record of (meta && Array.isArray(meta.records) ? meta.records : [])) {
          if (Number(record.seq) <= knownRevision) continue;
          const evt = stewardNormalizeMissionChange({ ...record, sessionId: sid, missionId });
          if (evt) events.push(evt);
        }
        stewardRuntime.cursor.missionChanges[sid] = Math.max(knownRevision, revision);
      }

      // ── ② agent run 事件增量(只看活跃会话里的活跃 run) ──
      if (!active) continue;
      const runs = await listAgentRuns(sid).catch(() => []);
      for (const run of runs) {
        const runId = run && safeSessionId(run.id);
        if (!runId) continue;
        const terminal = ['succeeded', 'failed', 'partial', 'stopped'].includes(String(run.status || ''));
        const runUpdatedMs = Date.parse(String(run.completedAt || run.updatedAt || run.createdAt || ''));
        const runRecent = Number.isFinite(runUpdatedMs) && (now - runUpdatedMs) <= STEWARD_ACTIVE_WINDOW_MS;
        if (terminal && !runRecent) continue;
        activeRunIds.push(runId);
        const eventSeq = Math.max(0, Number(run.eventSeq) || 0);
        const knownSeq = Object.prototype.hasOwnProperty.call(stewardRuntime.cursor.agentRuns, runId)
          ? Number(stewardRuntime.cursor.agentRuns[runId]) : null;
        let afterSeq;
        // 首见的 run:只有「本进程已经热过 + 这个 run 最近才动过 + 事件不多」三条同时成立才从 0 全读;
        // 否则只建基线(冷启动/老 run 复活都不把历史倒灌进箱,也就不依赖去重集合去兜底)。
        if (knownSeq == null) afterSeq = (stewardRuntime.cold || !runRecent || eventSeq > STEWARD_FIRST_SIGHT_MAX_EVENT_SEQ) ? eventSeq : 0;
        else afterSeq = knownSeq;
        stewardRuntime.cursor.agentRuns[runId] = afterSeq;
        const page = await readAgentRunEvents(sid, runId, afterSeq, STEWARD_RUN_EVENT_PAGE).catch(() => ({ events: [] }));
        let maxSeq = afterSeq;
        for (const evt of (page && Array.isArray(page.events) ? page.events : [])) {
          maxSeq = Math.max(maxSeq, Number(evt.seq) || 0);
          const normalized = stewardNormalizeRunEvent(sid, missionId, runId, evt);
          // 班组收工与本线程的回合报告是同一件事:回合报告这一轮就在箱里(turnEvt)或正被按住等后台落地时,
          // done 不再单独叫醒管家(游标照推,事件视为已消费)。failed/budget 不受影响。
          if (normalized && normalized.kind === 'done' && (turnEvt || stewardHeldTurnSessions.has(sid))) continue;
          if (normalized) events.push(normalized);
        }
        stewardRuntime.cursor.agentRuns[runId] = maxSeq;
      }
    }

    stewardRuntime.cursor.pendingIds = nextPending;
    return { events, activeSessionIds: [...activeSessionIds, ...idleSessionIds], activeRunIds };
  }

  async function stewardTickOnce() {
    const generation = stewardRuntime.generation;
    await stewardLoadState();
    const { events, activeSessionIds, activeRunIds } = await stewardCollectEvents();
    if (generation !== stewardRuntime.generation) return { written: 0, aborted: true };
    // 116-3 P0-3:上一轮结转下来的事件排在最前(它们更早发生,游标也早已越过它们)。
    const carried = stewardRuntime.carry;
    stewardRuntime.carry = [];
    // 121-K3(§4.3):在场门只作用于【本轮新收的】事件。结转下来的那批上一轮已经过过门了,
    // 再过一次会拿【此刻】的在场状态去重判一件几分钟前发生的事,那是两个时刻的事实相互污染。
    const gated = stewardApplyPresenceGate(events);
    const fresh = carried.concat(gated)
      .filter(evt => !stewardRuntime.seen.has(stewardEventDedupeKey(evt)))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    // 截断改在【合并之前】、对原始事件做,超出的部分原样结转到下一轮 —— 旧写法是「合并后 slice(0,200)」,
    // 被切掉的那些事件的游标已经前移,下一轮再也读不到它们(P0-3 的根因)。
    const head = fresh.slice(0, STEWARD_TICK_MAX_EVENTS);
    const rest = fresh.slice(STEWARD_TICK_MAX_EVENTS);
    if (rest.length) {
      const kept = rest.slice(0, STEWARD_CARRY_MAX_EVENTS);
      stewardRuntime.carry = kept;
      logEvent({ kind: 'steward_inbox_deferred', deferred: kept.length, dropped: rest.length - kept.length });
    }
    const drafts = stewardMergeInboxEvents(head, STEWARD_MERGE_WINDOW_MS);
    // 116-2e(§11.1 第 2 项「速查线程」):落盘【前】给速查会话的 done 行补 quick:true 与 answer
    // (最后一句助手原话)。实现住 13g(它要装载会话正文),经 06i 的延迟绑定命名空间调 —— 直接写
    // 13g 的函数名会是前向边。旁路纪律:钩子未填充或抛错都不影响这一轮已经归一好的行。
    if (drafts.length && typeof StewardHooks.enrichInboxRows === 'function') {
      try { await StewardHooks.enrichInboxRows(drafts); } catch { /* 增强失败只是少两个字段,不反噬轮询器 */ }
    }
    // 落盘失败(有界重试之后仍是 EBUSY/EIO/ENOSPC …)不许丢事件:四源游标、待决集合、budgetSeen、交接队列
    // 在 stewardCollectEvents 里都已经越过了这一批 —— 修前异常直接冒出去,这些事件从此永远读不回来
    // (一条「需要你」的权限请求就此从收件箱里消失)。这里不去逐个回滚游标(交接队列与 budgetSeen 是内存态,
    // 回滚不全),而是把这一批【原始】事件整批放回结转队列的最前面 —— 与 P0-3 的单轮上限结转同一条通路:
    // 下一拍它们排在最前、照样过去重、不再过在场门。游标这一拍不落盘，重启从旧游标重读并去重。
    let rows;
    try { rows = await stewardAppendInboxRows(drafts); }
    catch (error) {
      stewardRuntime.carry = head.concat(stewardRuntime.carry).slice(0, STEWARD_CARRY_MAX_EVENTS);
      try { logEvent({ kind: 'steward_inbox_append_failed', code: String((error && error.code) || ''), requeued: head.length }); } catch { /* 观测绝不反噬 */ }
      throw error;
    }
    // 冷启动只建基线,基线本身也必须落盘 —— 否则下次仍是冷启动,永远补不上历史增量。
    await stewardSaveCursor(activeSessionIds, activeRunIds);
    // 独立于入箱成功与否:整理失败不能把已落盘的一批重新投递,也不能阻止唤醒管家。
    try { await stewardMaintainInbox(); }
    catch (error) { try { logEvent({ kind: 'steward_inbox_maintenance_failed', code: String(error.code || error.message || '').slice(0, 100) }); } catch { /* 旁路 */ } }
    stewardRuntime.cold = false;
    stewardRuntime.lastTickAt = nowIso();
    // 116f: 本轮真的写进箱子的行交给回合运行器(13h 去抖 5 秒后起一个收件箱回合)。经 06i 的延迟绑定
    // 命名空间调(13g → 06i 是后向边;直接写 13h 的函数名会是前向边)。它是【旁路】:钩子未填充、
    // 抛错或运行器熔断,都不影响这一轮已经落盘的收件箱与游标。
    if (rows.length && typeof StewardHooks.onInboxBatch === 'function') {
      try { StewardHooks.onInboxBatch(rows); } catch { /* 运行器故障绝不反噬轮询器 */ }
    }
    return { written: rows.length, aborted: false };
  }

  async function stewardRunTick() {
    if (stewardRuntime.ticking) { stewardRuntime.wakePending = true; return { skipped: true }; }
    stewardRuntime.ticking = true;
    try {
      const result = await stewardTickOnce();
      stewardRuntime.lastError = '';
      return result;
    } catch (error) {
      stewardRuntime.lastError = String((error && error.message) || error || '').slice(0, 300);
      try { logEvent({ kind: 'steward_tick_error', error: stewardRuntime.lastError }); } catch { /* 观测绝不反噬 */ }
      return { error: stewardRuntime.lastError };
    } finally {
      stewardRuntime.ticking = false;
      if (stewardRuntime.wakePending || stewardRuntime.carry.length) {
        stewardRuntime.wakePending = false;
        stewardScheduleWake();
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 生命周期。开关关时 startStewardInbox 立即返回且【不做任何事】(不建目录、不起 interval)。
  // ────────────────────────────────────────────────────────────────────────────
  async function startStewardInbox(config) {
    const cfg = (config && typeof config === 'object') ? config : {};
    if (cfg.stewardEnabledV1 !== true) return { ok: false, running: false, enabled: false };
    const pollMs = stewardConsistencyMs(cfg.stewardPollMs);
    stewardRuntime.pollMs = pollMs;
    // 116f: start 同时解除回合队列的停机(stop 把轮询与回合一起停,start 把两者一起放开)。
    if (typeof StewardHooks.resumeRunner === 'function') { try { StewardHooks.resumeRunner(); } catch { /* 旁路 */ } }
    if (stewardRuntime.running) { await stewardRunTick(); return { ok: true, running: true, enabled: true }; } // 幂等:重复 start 只补一轮
    stewardRuntime.running = true;
    stewardRuntime.generation += 1;
    // hunt2-steward ⑥:认的是【本次起跑的代际】,不是 running 这一个布尔 —— start → stop → start 交错时,
    // 第二次 start 已经把 running 重新置 true 并挂上了自己的 interval,第一次 start 醒来只看 running
    // 会再挂一个、把第二个的句柄覆盖掉,之后 stop 只清得掉一个,另一个轮询器永远停不下来。
    const generation = stewardRuntime.generation;
    await stewardRunTick();
    if (!stewardRuntime.running) return { ok: true, running: false, enabled: true }; // 起跑途中被 stop
    if (stewardRuntime.generation !== generation) return { ok: true, running: true, enabled: true }; // 起跑途中被 stop 又 start:后来者挂 interval
    if (stewardRuntime.timer) clearInterval(stewardRuntime.timer);   // 兜底:任何时候最多一个轮询器
    stewardRuntime.timer = setInterval(() => { void stewardRunTick(); }, pollMs);
    if (stewardRuntime.timer && typeof stewardRuntime.timer.unref === 'function') stewardRuntime.timer.unref();
    return { ok: true, running: true, enabled: true };
  }

  function stopStewardInbox() {
    // 116f(§8.6「一键停机常驻且永远可点」):停机停的是【轮询 + 在途管家回合 + 回合队列】三样。
    // 放在最前:即使下面清 timer 抛错,回合队列也已经停了。线程自己的回合不受影响(那由线程的权限门管)。
    if (typeof StewardHooks.stopRunner === 'function') { try { StewardHooks.stopRunner(); } catch { /* 旁路 */ } }
    if (stewardRuntime.timer) { clearInterval(stewardRuntime.timer); stewardRuntime.timer = null; }
    stewardClearWake();
    stewardRuntime.wakePending = false;
    stewardRuntime.running = false;
    stewardRuntime.generation += 1; // 在途 tick 看到代际变化即放弃写入
    return { ok: true, running: false };
  }

  // ── 只读数据面(116c 的 steward_inbox_read 与 117 壳层复用同一实现) ──────────────
  async function stewardInboxRead(opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const since = Math.max(0, Math.round(Number(o.since) || 0));
    const rawLimit = Number(o.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(STEWARD_INBOX_LIMIT_MAX, Math.max(1, Math.round(rawLimit)))
      : STEWARD_INBOX_LIMIT_DEFAULT;
    const rows = await stewardReadInboxRows();
    const matched = rows.filter(row => Number(row.inboxSeq) > since).sort((a, b) => Number(a.inboxSeq) - Number(b.inboxSeq));
    const items = o.order === 'desc' ? matched.slice(-limit).reverse() : matched.slice(0, limit);
    return {
      items,
      since,
      limit,
      hasMore: matched.length > limit,
      inboxSeq: rows.reduce((max, row) => Math.max(max, Number(row.inboxSeq) || 0), 0),
    };
  }

  // 收件箱的「按类计数 + 最大 inboxSeq」备忘。/api/steward/state 由前端 30 秒(SSE 断时 5–15 秒)轮询,
  // 每个管家回合的状态块也会取一次;修前每次都把整份 inbox-v1.ndjson(全读上限 8MB)重读重解析,
  // 只为数这两样(7MB / 1.7 万行实测每次 80–130ms)。
  // 备忘的键是文件自己的 stat 指纹(路径 + size + mtimeMs + ino):追加、截断、被外部改写都会让指纹变,
  // 变了就照旧整份重算 —— 所以输出与修前逐位一致,而不是靠「每处写入都记得同步计数」的约定。
  // 先 stat 后读:读到的内容只可能【不早于】键所代表的那一刻,竞态下最坏是下次多重算一回,不会读到陈旧值。
  let stewardInboxCountsMemo = null;   // { key, byKind, inboxSeq }
  async function stewardInboxCounts() {
    const file = stewardInboxPath();
    let key = '', size = 0;
    try {
      const st = await fsp.stat(file);
      size = st.size;
      key = [file, st.size, st.mtimeMs, st.ino].join('|');
    } catch { /* 文件不存在:下面按空箱子算,不进备忘 */ }
    if (key && stewardInboxCountsMemo && stewardInboxCountsMemo.key === key) return stewardInboxCountsMemo;
    const rows = await stewardReadInboxRows();
    const byKind = {};
    for (const kind of STEWARD_EVENT_KINDS) byKind[kind] = 0;
    let inboxSeq = 0;
    for (const row of rows) {
      inboxSeq = Math.max(inboxSeq, Number(row.inboxSeq) || 0);
      if (Object.prototype.hasOwnProperty.call(byKind, row.kind)) byKind[row.kind] += 1;
    }
    const counts = { key, byKind, inboxSeq };
    // 文件非空却一行都没读出来:多半是这一次读撞上瞬时锁(stewardReadInboxText 吞掉错误回空串;Windows 杀软 / 索引器
    // 常见),别把「空箱子」记进备忘 —— 否则文件不再变就一直报零(审查轮复现过)。下一次照旧重读。
    stewardInboxCountsMemo = key && (size === 0 || rows.length > 0) ? counts : null;
    return counts;
  }

  async function stewardInboxState(config) {
    const cfg = (config && typeof config === 'object') ? config : await readConfig().catch(() => ({}));
    const counted = await stewardInboxCounts();
    const byKind = { ...counted.byKind };   // 拷一份:备忘对象不外泄,调用方随便改也污染不了下一次
    const inboxSeq = counted.inboxSeq;
    return {
      enabled: cfg.stewardEnabledV1 === true,
      running: stewardRuntime.running,
      inboxSeq: Math.max(inboxSeq, stewardRuntime.inboxSeq),
      pollMs: stewardConsistencyMs(cfg.stewardPollMs),
      lastTickAt: stewardRuntime.lastTickAt,
      // 116-4(§11.7 第 3 项「唤醒链诚实」):前端要能分清三件事 —— 轮询活着(lastTickAt 在动)、
      // 箱子真的收到过东西(lastInboxAt)、第四源真的在工作(sourcesSeen.sessionTurns)。
      // 修前只有 lastTickAt,一个「每 15 秒空转一次」的收件箱和一个真在干活的收件箱长得一模一样。
      lastInboxAt: stewardRuntime.lastInboxAt,
      sourcesSeen: { sessionTurns: Number(stewardRuntime.sourcesSeen.sessionTurns) || 0 },
      lastError: stewardRuntime.lastError,
      counts: { byKind },
      retention: { historyDays: 30, historyMax: STEWARD_INBOX_HISTORY_MAX, preservesPending: true,
        maintenanceIntervalMs: STEWARD_INBOX_MAINTENANCE_MS, lastMaintenanceAt: stewardRuntime.lastMaintenanceAt ? new Date(stewardRuntime.lastMaintenanceAt).toISOString() : '' },
    };
  }

  return {
    stewardDir, stewardInboxRead, stewardInboxState, stewardAppendInboxRows, stewardInboxPendingState,
    stewardPendingStillOpen, stewardViewingSessionIds, stewardPresenceRows, startStewardInbox, stopStewardInbox,
    stewardMaintainInbox,
  };
}

module.exports = { createStewardInbox };
