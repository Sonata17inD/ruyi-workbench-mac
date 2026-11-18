// ===== v1.9 会话存储 v2(head JSON + append-only NDJSON 正文)=====================================
// 背景:旧格式把整个 messages+providerHistory 塞进单个 <id>.json,saveSession 每轮全量序列化+原子重写
// —— 写放大 O(会话总历史)/轮:5MB 会话 = 每轮重写 5MB。v2 拆分为:
//   <id>.json              「头」:全部标量/小字段 + messageCount/providerHistoryCount + storageVersion:2(小,每次重写)
//   <id>.messages.ndjson   展示消息正文,一行一条 JSON,append-only
//   <id>.provider.ndjson   provider 引擎历史正文,同上
// 快路径(saveSession):两个数组只在尾部增长 → 每文件一次 append,O(增量)/轮。
// 慢路径(全量重写正文):任何前缀变化自动触发 —— rewind(slice)/compaction(reseed)/pop/蒸发改写。
// 检测机制【不靠调用方自觉打标记】:进程内状态表记着盘上每一行(行原文;内存预算不够时退成每行 sha1-16),
// save 时把前缀逐条重新序列化、逐行比对;任何对不上(含未来新代码忘了声明的中间改写)都安全降级为全量重写
// —— 失配只可能损失性能,不可能丢数据。(perf:比对用的是行原文,见 sessionBodyState 头注。)
// 崩溃语义:头是提交点(正文先写、头后写)。append 崩溃中途 → 无 \n 终结的撕裂尾行,读取时物理截断;
// append 完成但头写未完成 → 正文比头声明的多出「未提交尾巴」,读取时按头计数截断;慢路径(全量重写)
// 崩溃 → .prevbody 快照(重写前旧正文)恢复与旧头重新配对;正文比头声明的短 / 中间行损坏且无快照可退
// = 真损坏 → v1bak 回退(迁移期)或隔离为 .corrupt(与旧单文件损坏同纪律)。
// 迁移:legacy <id>.json 首次 load 时原样备份 <id>.json.v1bak 再落 v2;v2 下次成功读取后自动删 v1bak。
const SESSION_STORAGE_VERSION = 2;
// 架构还债批 3·B: 会话级内存覆盖表(sessionEngineRouteOverrides/权限档/桌面工具)与其归一、应用函数抽至 02d-session-overrides.js。

function sessionBodyPaths(id) {
  assertSessionIdForPath(id);
  return {
    messages: path.join(paths.sessions, `${id}.messages.ndjson`),
    provider: path.join(paths.sessions, `${id}.provider.ndjson`),
  };
}

// ── 105b: session-notes.md 状态外置(旁车副本)─────────────────────────────────
// L2 摘要成功后,把结构化摘要中的【已确认的决定】/【未完成事项】/【关键文件与上下文】三节确定性
// 切出整写到本文件。默认每次 L2 成功整体重写(摘要本身即最新权威状态);105d 的
// runtimeSessionNotesMergeV1(默认关)开启时改为 read→merge→write 增量合并,合并逻辑在
// 10-context-governance.js 的 mergeSessionNotes,本层只负责原子写与尾部截断兜底。
// 纪律:与 interventions/changes 旁车同层同规 —— 独立 per-session 写链 + 原子写;notes 是易失副本,
// 读失败/缺文件一律 null,绝不阻断回合。105b 真实历史门通过后默认开启；显式关时零文件读写。
const SESSION_NOTES_MAX_CHARS = 64000;
const sessionNotesWriteChains = new Map();
function sessionNotesPath(id) {
  return path.join(paths.sessions, `${String(id)}.session-notes.md`);
}
async function writeSessionNotes(id, markdown) {
  const file = sessionNotesPath(id);
  let body = String(markdown == null ? '' : markdown);
  if (body.length > SESSION_NOTES_MAX_CHARS) {
    body = body.slice(0, SESSION_NOTES_MAX_CHARS) + `\n\n<!-- truncated: exceeded ${SESSION_NOTES_MAX_CHARS} chars -->\n`;
  }
  return runKeyedChain(sessionNotesWriteChains, file, async () => {
    await fsp.mkdir(paths.sessions, { recursive: true }); // 旁车写不依赖 server 启动期建目录
    await atomicWriteJson(file, body);                    // 字符串直写,同 25.1 md 先例
  });
}
async function readSessionNotes(id) {
  try { return await fsp.readFile(sessionNotesPath(id), 'utf8'); }
  catch { return null; } // ENOENT 与其他读错同处理:notes 是旁车副本,缺文件不是错误
}

// ── C2(61 号文):会话草稿本 sessions/<id>.scratchpad.json ──────────────────────────────────────
// 模型自己「写即生效、不进长期库」的短笔记:按 key 写/覆盖,text 为空即删。只发给模型服务商引擎普通会话的主回合
// (工具 scratchpad_write:schema 在 13f、发放在 07 buildOpenAiTools 的 opts.scratchpadEnabled、handler 在 12);
// 09 每回合把快照贴到末条 user 尾部(非持久,见那里的缓存账)。与 session-notes 分工:notes 由运行时在 L2 压缩后
// 从摘要写出,模型没有写入口;草稿本只有模型写。长期偏好与项目约定仍走 workbench_memory_propose(确认制)。
// 落盘走 DurableJsonStore(01):schema 1、清洗(限额对手改过的文件同样成立)、坏文件当空(quarantine:false ——
// 草稿是易失副本,下一次写自愈,不留 .corrupt)、原子写。cache:false:每会话一个文件,store 按调用现建(构造只是
// 几个闭包),读永远读盘 —— 删会话后不会有进程缓存把旧条目「复活」进下一次注入。同一会话的读-改-写由 runKeyedChain
// 按会话 id 串行(store 自带的写链按实例,不跨实例,这里不依赖它)。
const SESSION_SCRATCHPAD_SCHEMA = 1;
const SESSION_SCRATCHPAD_LIMITS = Object.freeze({ maxEntries: 32, maxKeyChars: 40, maxTextChars: 2000, maxTotalChars: 12000 });
const sessionScratchpadChains = new Map();
function sessionScratchpadPath(id) {
  return path.join(paths.sessions, `${assertSessionIdForPath(id)}.scratchpad.json`);
}
// key:控制字符换空格、折叠空白、trim。不截断 —— 截断会让两个不同的 key 悄悄撞成一个,超长由调用方拒绝。
function normalizeScratchpadKey(raw) {
  return String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// text:统一换行、去掉 \n \t 以外的控制字符、trim(保留多行)。
function normalizeScratchpadText(raw) {
  return String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
}
// 总长只数正文(key 另有单条上限,20 × 40 有界)。
function scratchpadTotalChars(entries) {
  return (Array.isArray(entries) ? entries : []).reduce((n, e) => n + String((e && e.text) || '').length, 0);
}
// 盘上形状 { schema:1, updatedAt, entries:[{ key, text, at }] }。用数组保序:对象键里的 "1"、"42" 这类整数键会被 JS 重排。
// 清洗丢掉手改坏的条目、同 key 留最后一条、超长正文截断、超出条目数 / 总长从最早的条目丢起 —— 于是注入块的大小
// 只取决于限额,一份手改的大文件撑不大它。
function sanitizeSessionScratchpad(value) {
  const L = SESSION_SCRATCHPAD_LIMITS;
  const byKey = new Map();
  for (const raw of Array.isArray(value && value.entries) ? value.entries : []) {
    if (!raw || typeof raw !== 'object') continue;
    const key = normalizeScratchpadKey(raw.key);
    const text = normalizeScratchpadText(raw.text).slice(0, L.maxTextChars);
    if (!key || key.length > L.maxKeyChars || !text) continue;
    byKey.delete(key);
    byKey.set(key, { key, text, at: typeof raw.at === 'string' ? raw.at.slice(0, 40) : '' });
  }
  let entries = [...byKey.values()];
  if (entries.length > L.maxEntries) entries = entries.slice(-L.maxEntries);
  while (entries.length && scratchpadTotalChars(entries) > L.maxTotalChars) entries.shift();
  return { schema: SESSION_SCRATCHPAD_SCHEMA, updatedAt: typeof (value && value.updatedAt) === 'string' ? value.updatedAt.slice(0, 40) : '', entries };
}
function sessionScratchpadStore(id) {
  return DurableJsonStore.create({
    id: 'session-scratchpad',
    file: sessionScratchpadPath(id),   // 不合形的 id 在这里就抛(assertSessionIdForPath)
    schemaVersion: SESSION_SCRATCHPAD_SCHEMA,
    cache: false,
    quarantine: false,
    defaultValue: () => ({ schema: SESSION_SCRATCHPAD_SCHEMA, updatedAt: '', entries: [] }),
    sanitize: sanitizeSessionScratchpad,
    validate: value => value.schema === SESSION_SCRATCHPAD_SCHEMA && Array.isArray(value.entries),
    onCorrupt(error) {
      try { logEvent({ kind: 'session_scratchpad_corrupt', sessionId: String(id), error: String((error && error.message) || error).slice(0, 200) }); } catch { /* 诊断绝不阻断 */ }
    },
  });
}
// 读:缺文件 / 坏文件 / 读不动 / 不合形的 id 一律空表 —— 草稿是旁车副本,绝不阻断回合。
async function readSessionScratchpad(id) {
  try { return (await sessionScratchpadStore(id).read()).entries; }
  catch { return []; }
}
// 读-改-写(按会话串行)。mutate 拿到条目副本,返回 { entries, changed, ...其余字段原样带回 };changed 为假 = 不落盘。
// 会话已删除(墓碑,见 markSessionDeleted)时拒写:垂死回合里迟到的一次写不得在 unlink 之后把旁车写回来。
async function updateSessionScratchpad(session, mutate) {
  const id = String((session && session.id) || '');
  const store = sessionScratchpadStore(id);
  return runKeyedChain(sessionScratchpadChains, id, async () => {
    if (sessionSaveIsTombstoned(session)) return { refused: 'session-deleted' };
    const current = (await store.read()).entries.map(e => ({ ...e }));
    const out = mutate(current) || {};
    if (out.refused || !out.changed) return { entries: current, ...out };
    const saved = await store.write({ schema: SESSION_SCRATCHPAD_SCHEMA, updatedAt: nowIso(), entries: out.entries });
    return { ...out, entries: saved.entries };
  });
}

// ── 第71波 EC-E 切片二:未决事项 Intervention 持久化(append-only NDJSON)──────────────────────────
// permission/question/plan 三类未决事项此前是纯内存 Map(04-permission-runtime:191/194/199),进程重启即消失
// -- 无审计、无终态化,/api/missions 的 missionPendingCounts(13d:59)前三类读空 Map 归零,与前端 stale 卡片
// 不一致。本波把它们旁路持久化为 Intervention 记录:注册时 append 一行(pending),决策/超时/清理时 append 一行
// (终态),读时按 id 后写胜折叠。**不参与 promise resolve 链** -- 超时自动拒绝、权限默认不放宽语义完全不动,
// Intervention 只是审计/读模型/重启终态化的旁路记录(执行权威源仍是内存 Map)。
// 第71b波:task-pool proposed 统一进来(第四类 type:'pool')——提案注册/审批/拒绝/过期全部旁路记账,
// missionPendingCounts 四源统一从本店读;pool 与前三类的重启语义不同(提案随 run 快照存活,paused run
// 恢复后仍可审批),故 markInterruptedInterventions 对 pool 型按 run 状态分流(见下),不一刀切 cancelled_restart。
//
// 崩溃语义:同 messages.ndjson -- append 永远「整行 + 尾随 \n」一次写,撕裂尾行(无 \n 终结)读取时 JSON.parse
// 失败被跳过(append-only,丢一条审计记录不致命:执行语义走内存 Map,读模型少一条不阻断)。后写胜折叠保证
// 同一 ivId 的多条记录(request -> settle -> cancel_restart)取最后一条为权威终态。
// 107-F7b(撤回被陈旧快照盖回):会话的【撤回代数】高水位 —— 与上面 missionChangeSeqHighWater 同一个模具,
// 被护住的是正文而不是账本计数。症状:用户递话后立刻点「撤回」,撤回回 ok:true,消息却还在。取证(红轮
// 日志):撤回那一存无条件写 providerHistoryCursor=0,盘上却是 2 —— 撤回那一存被一个【撤回之前就攥在手里】
// 的会话对象整份盖回了。这类写者不止垂死回合一个(回合 settle 之后才动手的 updateSessionMeta 读改写、
// 收工补写 threadBrief、手动压缩等等都能恰好把 load 落在撤回之前、把 save 落在撤回之后),69 波那道
// 「自动停回合 + 等 settle」的闸只管得住垂死回合自己。
// 机制:会话头上一个单调整数 rewindGen(缺省视为 0);撤回那一存在【入写链的同一拍】把自己那份对象的
// rewindGen 加一,并抬高本表。saveSession 在写链里、真正落盘之前比对:对象的
// rewindGen 低于高水位 = 这是撤回之前的快照 = 整次写丢弃(正文与头都不写),落 session_stale_save_dropped。
// 只在进程内:重启后表为空,所有对象都从盘上新读(loadSession 每次都 JSON.parse 新解析,没有对象缓存),
// 不会误丢。loadSession 另有一道自愈:读到的代数低于高水位 = 这次读恰好落在「代数已抬、撤回那一存还没
// 落盘」的窗口里 → 等写链跑完再读一次,所以撤回【之后】才读的人永远拿到撤回之后的状态。
const sessionRewindGenHighWater = new Map();
// 第79波:changeSeq 不再只有一个计数器。每次事实推进同时写一条 append-only change record，
// 让回来摘要可以严格消费 (lastSeenRevision,currentRevision]，并保留可追溯的原始 source cursor。
// 老任务可能已有 changeSeq、却没有本流水：首条记录的前缀被视为 migration baseline；前端首读
// 从当前 revision 建基线。若已读游标落在 baseline 之前、或流水内部/尾部缺号，则显式 degraded。
const MissionChanges = require('./backend/mission-changes.cjs').createMissionChanges({
  paths, sessionPath, sessionWriteChains, readFileTail, atomicWriteJson, nowIso,
  sessionMissionId: session => sessionMissionId(session),
  invalidateReads: id => SessionPersistence.invalidateReads(id), events: RUYI_EVENTS,
});
const { missionChangeFilePath, boundedChangeText, normalizeMissionChangePayload, repairMissionChangeTornTail, appendMissionChangeRecord, foldMissionChangeJournalText, readMissionChangesWithMeta, bumpMissionChangeSeq, missionSignalThrottleAllow, recordMissionStalledChange, recordMissionBudgetTrippedChange, MISSION_CHANGE_TYPES, MISSION_STALL_SIGNAL_WINDOW_MS } = MissionChanges;
const { interventionFilePath, dropInterventionSessionState, appendIntervention, registerIntervention, settleIntervention, foldInterventionJournalText, readInterventionsWithMeta, readInterventions, interventionJournalWorthCompacting, compactInterventionJournal, markInterruptedInterventions, transitionInterventionState, INTERVENTION_TERMINAL } = require('./backend/intervention-journal.cjs').createInterventionJournal({
  paths, nowIso, atomicWriteJson, events: RUYI_EVENTS, listAgentRuns,
  repairTornTail: repairMissionChangeTornTail, recordChange: bumpMissionChangeSeq, logEvent,
});
// ── perf(会话正文逐行 sha1 的去重):进程内确定性计数器 ───────────────────────────────────────────────────
// perfCounters.sessionBody(unit/session-body-line-cache 读):只数「做了多少活」,不计时,断言不受机器快慢影响。
//   lineHashes           单行 sha1 算了几次。修前:每次装载 = 两个正文的总行数,每次保存 = 两个数组的总条数(外加
//                        严格前缀判定那一遍);现在只在行原文被挤出内存预算、退成 hash 时才算(见 sessionBodyState 头注)。
//   bodyReads            正文文件读了几次(messages / provider 各算一次)。
//   providerBodySkips    增量取的装载有几次证明了 provider 正文没变、没去读它(loadSession 的 omitProviderHistory 视图)。
//   deltaStampFromBytes  增量取的前缀戳有几次是直接对盘上字节算的(不逐条 JSON.stringify)。
//   deltaStampSerialized 同上,逐条序列化算的(修前的算法;字节路径的前提不成立时仍走它)。
const SessionBodies = require('./backend/session-bodies.cjs').createSessionBodies({
  isWriting: id => sessionWriteChains.has(id), logEvent,
});
const { sessionMessagesStamp, sessionMessagesDelta, sessionBodyRecord, setSessionBodyState, dropSessionBodyState, sessionBodyRecordFromRead, sessionBodyDanglingFromLines, readSessionBodyFile, planSessionBodyAppend, serializeSessionBody, sessionBodyText, sessionBodyDigest, sessionBodyCommitValid, sessionBodiesMatchCommit, rebaseStaleSessionBody, sessionBodyPerfStats, SESSION_BODY_READ_TRANSIENT, SESSION_HEAD_READ_RETRIES, danglingTurnState, getSessionBodyState } = SessionBodies;


// ===== PF2: session metadata index (sessions/index.json) =====================================================
// listSessions used to JSON.parse EVERY session file in full just to show 7 sidebar fields, and saveSession
// rewrote each session whole; both costs grow with session count/size. We keep a lightweight index of just
// those 7 fields, incrementally maintained by saveSession/deleteSession. CRITICAL SAFETY INVARIANT: the index
// is ONLY a cache; each per-session JSON file remains the single source of truth. listSessions trusts the
// index only when its id-set EXACTLY matches the session files on disk; on any mismatch/missing/corrupt index
// it falls back to scanning the real files (and rebuilds the index). On any index write failure we DELETE the
// index so the next read rebuilds from truth. Sessions are single-writer (the serve process only; the MCP
// child never writes session files), so a process-global write lock is enough to serialize index mutations.

// 第70波(EC-E):会话类型显式标识 —— 'quick_ask'(纯问答,默认) | 'mission'(任务会话,mission start 时显式翻转,
// 非启发式文本猜测)。旧会话(第70波前落盘)无 kind 字段:有 mission 派生 'mission',否则 'quick_ask'。
// 迁移契约:只读派生,绝不把派生结果回写磁盘(无破坏性批量改写)。
const { sessionRecentUserRequest, sessionKind, sessionMissionId, SESSION_BRIEF_TITLE_CHARS, SESSION_BRIEF_GIST_CHARS, applySessionTitleOverride, sessionDisplayTitle, sessionMeta, sessionBriefOf, sessionMetaIsSteward, sortSessionMetas, isUntitledSessionTitle, getSessionTitleOverride, setSessionTitleOverride, dropSessionTitleOverride } = require('./backend/session-metadata.cjs').createSessionMetadata({
  safeSessionId, sessionPermissionModeOf, resolvePermissionMode,
  isLive: id => activeChildren.has(id) || turnSettlers.has(id) || SessionMetaUpdates.hasPending(id),
  rewindGeneration: id => sessionRewindGenHighWater.get(id) || 0,
});

// Read the index array, or null when missing/corrupt/not-an-array (caller falls back to a full scan).
const { readSessionIndex, invalidateSessionIndex, setSessionIndexRebuildScanHookForTest, scheduleSessionIndexUpdate, flushSessionIndex, overlayUnflushedSessionIndex, flushSessionIndexSync, listSessions, SESSION_INDEX_FILE, SESSION_TOMBSTONE, sessionIndexPath } = require('./backend/session-index.cjs').createSessionIndex({
  paths, safeJsonParse, atomicWriteJson, noteSessionsDirOwnWrite, safeSessionId, ensureDirs, sessionMeta, sessionMetaIsSteward, sortSessionMetas,
});

// 计划条(session.todos)的指纹:管家「没做完就续」只认【这一回合里动过的】计划(13p stewardContinueUnfinishedGate)——
// 回合开头记一笔、收尾写进 stewardLastTurn.todosStartSig,与收尾时的现值不同才算这一回合在推进这份计划。
// 早就搁下、用户已经换了话题的旧计划不该让每个新回合都被当成「没做完」。
const SessionMetaUpdates = require('./backend/session-meta-updates.cjs').createSessionMetaUpdates({
  safeSessionId, logEvent: (...args) => logEvent(...args), RUYI_EVENTS,
  metadata: { setSessionTitleOverride, SESSION_BRIEF_TITLE_CHARS, SESSION_BRIEF_GIST_CHARS },
  overrides: { normalizeSessionEngineRoute, sessionEngineRouteOverrides, sessionEngineRouteScopeOverrides, rememberLastUsedEngineRoute, normalizeSessionPermissionMode, sessionPermissionModeOverrides, normalizeSessionDesktopTools, sessionDesktopToolsOverrides },
  sessions: { withSessionMutateLock: (...args) => withSessionMutateLock(...args), loadSession: (...args) => loadSession(...args), saveSession: (...args) => saveSession(...args) },
  lifecycle: { activeChildren, turnSettlers },
});
const { sessionTodosSignature, updateSessionMeta } = SessionMetaUpdates;

// hunt2-P2:删除墓碑。id → { at, purgeAssociated }。stopSession 只是 abort,被停回合的收尾 saveSession(以及任何
// 手里还攥着旧会话对象的旁路写者)会在 unlink 之后把头与正文整份写回 —— 会话「复活」,列表里又出现、GET 200。
// saveSession 在【写链内】查墓碑:createdAt 不晚于删除时刻的对象 = 删除之前就存在的那条会话的副本,整次写丢弃。
// 用 createdAt 而不是「有墓碑就拒」:固定 id 的会话(管家 STEWARD_SESSION_ID)删掉后会以同一个 id 重建,
// 新对象的 createdAt 晚于删除时刻,照常落盘;createSession 另外显式清墓碑。条目只活在本进程(重启后没有
// 在飞的旧对象),有上限防长驻进程无界增长。
const { deleteSession, bulkDeleteUnpinnedSessions, markSessionDeleted, sessionSaveIsTombstoned, sessionAssociatedSaveIsTombstoned, toolImageSessionTag, removeSessionToolImages, clearDeletedSession } = require('./backend/session-deletion.cjs').createSessionDeletion({
  paths, assertSessionIdForPath, safeSessionId, logEvent,
  files: { sessionPath, sessionBodyPaths, interventionFilePath, missionChangeFilePath,
    sessionNotesPath, sessionScratchpadPath, journalDir: id => journalDir(id), agentRunDir },
  pendingWrites: { sessionWriteChains, sessionScratchpadChains },
  execution: {
    stop: stopSession, activeRuns: () => activeAgentRuns.values(), stopRuns: stopMissionAgentRuns,
    settler: id => turnSettlers.get(id), isActive: id => activeChildren.has(id),
    revokeGrants: (...args) => revokeAllGrants(...args),
    flushRuns: (...args) => EventStreamHooks.flushSessionAgentRuns?.(...args),
  },
  membership: { readHead: readMissionSessionHead, ownerOf: sessionMissionId, remove: (...args) => missionIndexRemove(...args) },
  index: { list: listSessions, remove: id => scheduleSessionIndexUpdate(id, SESSION_TOMBSTONE) },
  invalidateSessionState: id => {
    dropSessionBodyState(id); SessionPersistence.invalidateReads(id);
    dropSessionTitleOverride(id); sessionEngineRouteOverrides.delete(id); sessionEngineRouteScopeOverrides.delete(id);
    sessionPermissionModeOverrides.delete(id); sessionDesktopToolsOverrides.delete(id); dropInterventionSessionState(id);
  },
  events: RUYI_EVENTS,
});

// 架构还债批 3·B: 会话引擎路由的纯函数(normalizeSessionEngineRoute/sessionEngineRouteFromConfig/inferSessionEngineRoute/configForSessionEngineRoute)抽至 02e-session-engine-route.js。

// ── 123-N2「新线程默认上一次用的引擎」(用户 2026-09-13 真机原话:「现在新开线程会默认开 Kimi
// code cli,我希望改成默认上一次用的或者别的方式,不要设定死」)────────────────────────────────
//
// 病根:createSession 的缺省【只有】 sessionEngineRouteFromConfig(config) 这一条路 —— 全局
// activeProvider/agentCliType/model 三项设置。用户在线程头上把引擎切成别的,那个选择只活在
// 那一条线程头上,下一条新线程照旧回到全局那一项(用户机器上 agentCliType 是 kimi),这就是
// 「写死」。修法不是改全局默认值(那只是把写死换了个值),而是给新线程的缺省【加一层可选来源】。
//
// 记(rememberLastUsedEngineRoute)与读(newSessionEngineRoute)分两处,共用 config 上的一个字段。
// ────────────────────────────────────────────────────────────────────────────────────────
// 记:**两个写入点共用这一个函数**,不许各写一遍。
//   ① 用户在线程头上换引擎/模型 → PATCH /api/sessions/:id → applySessionMetaPatch;
//   ② 用户自己发起的回合 → 10 的 runSessionTurn 且 source === 'http'。
// 三条纪律:
//   · 只记【用户自己的意思表示】。管家(source 'steward')与将来的调度器(source 'scheduler')
//     派出去的回合一概不记 —— 判据在调用点那个 if,不在这里(这里拿到的就是「该记的那一条」);
//   · 【与现值不同才落盘】,否则每个回合都要写一次 config.json;权威比对在 mutateConfig 的锁内
//     再做一次(锁外那一次只是拿调用方手上的现成副本做便宜短路,可能已经陈旧);
//   · 【失败静默】。这是旁路记账 —— 写不进去最多是下一条新线程回落全局,绝不能弄坏回合或 PATCH。
async function rememberLastUsedEngineRoute(nextRoute, knownConfig) {
  try {
    const clean = normalizeSessionEngineRoute(nextRoute);
    if (!clean) return false;
    const wanted = JSON.stringify(clean);
    if (knownConfig && typeof knownConfig === 'object'
      && JSON.stringify(normalizeSessionEngineRoute(knownConfig.lastUsedEngineRoute)) === wanted) return false;
    let wrote = false;
    await mutateConfig(async current => {
      if (JSON.stringify(normalizeSessionEngineRoute(current.lastUsedEngineRoute)) === wanted) return { abort: 'unchanged' };
      current.lastUsedEngineRoute = clean;
      wrote = true;
    });
    return wrote;
  } catch { return false; }
}

// 「上一次用的」现在还能不能用。只有两条判据,都对应【用户换过环境】这一件事:
//   · openai 路由 —— 那个端点还在不在 config.providers 里。删掉端点后再开新线程必须回落,
//     否则新线程一开口就撞 10 的「会话绑定的 Provider 不可用」,用户完全不知道发生了什么;
//   · agent 路由 —— 那个 CLI 还检不检得到。判据【复用】01 的 selectedAgentCli(它同时看用户手填
//     的路径与探测结果,且带缓存),不另写第二套探测 —— 第二套判据迟早与第一套判出不同答案。
function lastUsedEngineRouteUsable(route, config) {
  if (!route) return false;
  if (route.engine === 'openai') {
    return ((config && config.providers) || []).some(item => item && item.id === route.providerId);
  }
  const cli = selectedAgentCli({ ...(config || {}), agentCliType: route.agentCliType });
  return Boolean(cli && cli.path);
}

// 读:新线程的缺省引擎。优先级固定四层,**第三层是本波新增的那一层**,上下两层一字未动:
//   ① 显式入参 engineRoute(POST /api/sessions 的请求体带的,或进程内调用方指定的)——
//      「这一条线程就要这个」压过一切;
//   ② 从导入进来的消息里推断 —— 导入历史对话时沿用它原来的引擎(既有行为);
//   ③ newThreadEngine === 'last' 且 lastUsedEngineRoute 【仍可用】→ 用它(本波新增);
//   ④ 全局设置 —— 老行为,同时也是 ③ 的回落去处。
// ③ 因「不可用」回落到 ④ 时必须留痕:用户明明设了「跟上次用的」却拿到别的引擎,不记一条
// 审计事件就无从解释。**「还没有上一次」不算回落**(那是首次使用,不记)。
function newSessionEngineRoute(config, explicitRoute, initialMessages, sessionId) {
  const explicit = normalizeSessionEngineRoute(explicitRoute);
  if (explicit) return explicit;
  const inferred = inferSessionEngineRoute({ messages: initialMessages });
  if (inferred) return inferred;
  const fromGlobal = sessionEngineRouteFromConfig(config);
  if (!config || config.newThreadEngine !== 'last') return fromGlobal;
  const last = normalizeSessionEngineRoute(config.lastUsedEngineRoute);
  if (!last) return fromGlobal;
  if (lastUsedEngineRouteUsable(last, config)) return last;
  logEvent({
    kind: 'new_thread_engine_fallback',
    sessionId: String(sessionId || ''),
    reason: last.engine === 'openai' ? 'provider_missing' : 'agent_cli_missing',
    last,
    to: fromGlobal,
  });
  return fromGlobal;
}

// v0.8-S0: fold an older/partial session onto the current schema. Mirrors normalizeConfig's shape:
// returns { session, changed }. Backfills schemaVersion + turnSeq and guarantees the array fields so
// no downstream code has to defend against missing/typo'd properties.
const { normalizeSession, normalizeMetaToolArgs, normalizeTodoItems, normalizeMissionCheck, recordMissionCheckResult, normalizeMission, applyMissionUpdate, missionProgressDigest, missionContainerAcceptanceStamp, buildMissionAcceptanceProjection, foldTurnSummaries, followupAcceptanceCriterion, MISSION_MAX_MILESTONES, MISSION_MAX_TEXT, MISSION_DEFAULT_MAX_TURNS, MISSION_STALL_LIMIT } = require('./backend/session-model.cjs').createSessionModel({ SESSION_SCHEMA, SKILL_ID_RE, MEMORY_FIXED_SELECTION_HARD_MAX, inferSessionEngineRoute, nowIso });

const MissionControl = require('./backend/mission-control.cjs').createMissionControl({
  storage: {
    loadSession: (...args) => loadSession(...args),
    saveSession: (...args) => saveSession(...args),
    mutateSession: (...args) => mutateSession(...args),
  },
  checkpoints: {
    journalReadIndex: (...args) => journalReadIndex(...args),
    rewindSession: (...args) => rewindSession(...args),
  },
  execution: {
    hasActiveTurn: id => activeChildren.has(id),
    getActiveTurn: id => activeChildren.get(id),
    hasActiveRun: id => activeAgentRuns.has(id),
    getTurnSettler: id => turnSettlers.get(id),
    stopSession: (...args) => stopSession(...args),
    stopMissionAgentRuns: (...args) => stopMissionAgentRuns(...args),
    listAgentRuns: (...args) => listAgentRuns(...args),
  },
  model: {
    foldTurnSummaries: (...args) => foldTurnSummaries(...args),
    applyMissionUpdate: (...args) => applyMissionUpdate(...args),
    normalizeMission: (...args) => normalizeMission(...args),
    normalizeMissionCheck: (...args) => normalizeMissionCheck(...args),
    followupAcceptanceCriterion: (...args) => followupAcceptanceCriterion(...args),
  },
  events: {
    bumpMissionChangeSeq: (...args) => bumpMissionChangeSeq(...args),
    logEvent: (...args) => logEvent(...args),
  },
  authorization: {
    revokeAllGrants: (...args) => revokeAllGrants(...args),
  },
  MISSION_DEFAULT_MAX_TURNS, MISSION_MAX_MILESTONES, MISSION_MAX_TEXT, nowIso, makeId,
  runProcess: (...args) => DesktopShell.runProcess(...args),
});
function buildMissionResult(...args) { return MissionControl.buildMissionResult(...args); }
function archiveMissionResult(...args) { return MissionControl.archiveMissionResult(...args); }
function maybeFinalizeMission(...args) { return MissionControl.maybeFinalizeMission(...args); }
function finalizeMissionAfterTurn(...args) { return MissionControl.finalizeMissionAfterTurn(...args); }
function mergeMissionBeforeSave(...args) { return MissionControl.mergeMissionBeforeSave(...args); }
function missionRollbackTarget(...args) { return MissionControl.missionRollbackTarget(...args); }
function missionBudgetRemaining(...args) { return MissionControl.missionBudgetRemaining(...args); }
function missionControlView(...args) { return MissionControl.missionControlView(...args); }
function waitMissionTurnSettled(...args) { return MissionControl.waitMissionTurnSettled(...args); }
function missionControlFailure(...args) { return MissionControl.missionControlFailure(...args); }
function missionControlCommand(...args) { return MissionControl.missionControlCommand(...args); }
function evaluateMissionCheck(...args) { return MissionControl.evaluateMissionCheck(...args); }

async function stopMissionAgentRuns(sessionId) {
  let count = 0;
  const saves = [];
  for (const live of activeAgentRuns.values()) {
    if (!live || !live.run || live.run.sessionId !== sessionId || live.closing || live.stopRequested) continue;
    count++;
    live.stopRequested = true;
    live.paused = false;
    try { if (live.ctrl) live.ctrl.abort(); } catch { /* best-effort */ }
    const waiters = Array.isArray(live.resumeWaiters) ? live.resumeWaiters.splice(0) : [];
    for (const wake of waiters) { try { wake(); } catch { /* best-effort */ } }
    bumpRunIntervention(live.run, 'mission_stop');
    appendAgentRunEvent(live.run, { type: 'run_stop_requested', data: { reason: 'mission_stop' } });
    saves.push(saveAgentRun(live.run).catch(() => {}));
  }
  await Promise.all(saves);
  return count;
}

// 撤回(rewindSession)用:被丢弃回合里【模型自己起的】、仍在跑的后台 run 一并停掉 —— 起它的那句话对模型已经没发生过,跑完的信封只会让
// 下一回合凭空多出一份通知(并且唤醒会把改写过的线程叫醒)。停法与托盘 / mission 里停一件同一个(stopRequested + abort + 记干预 + 追事件),
// 并打 cancelledByRewind:09 deliverAgentRunEnvelope 据此不再给它投信封。用户在面板里自己起的 run 不动(不是被撤回的那句话起的);
// 起它的回合没被撤回的 run 也不动(照常跑完,信封随用户下一句话送达)。返回停掉的件数。同步,零 await。
function cancelModelRunsOfDiscardedTurns(sessionId, discardedTurnSeqs) {
  const discarded = discardedTurnSeqs instanceof Set ? discardedTurnSeqs : new Set(Array.isArray(discardedTurnSeqs) ? discardedTurnSeqs : []);
  let cancelled = 0;
  for (const live of activeAgentRuns.values()) {
    if (!live || !live.run || live.run.sessionId !== sessionId || live.closing || live.stopRequested) continue;
    if (live.run.launchedByModel !== true || !discarded.has(Number(live.run.turnSeq))) continue;
    try {
      live.run.cancelledByRewind = true;
      live.stopRequested = true;
      live.paused = false;
      try { if (live.ctrl) live.ctrl.abort(); } catch { /* best-effort */ }
      for (const wake of (Array.isArray(live.resumeWaiters) ? live.resumeWaiters.splice(0) : [])) { try { wake(); } catch { /* best-effort */ } }
      bumpRunIntervention(live.run, 'rewind_stop');
      appendAgentRunEvent(live.run, { type: 'run_stop_requested', data: { reason: 'rewind' } });
      saveAgentRun(live.run).catch(() => {});
      cancelled++;
    } catch { /* 停不掉也不挡撤回 */ }
  }
  if (cancelled) logEvent({ kind: 'rewind_cancel_agent_runs', sessionId, cancelled });
  return cancelled;
}

// 110-3b: createTurnSegmentBuilder 回合分段构建器抽至 02c-turn-segments.js。

// v0.8-S3/S4a: derive a turn_summary from the turn's tool records + checkpoint journal. Both engines call
// this with their own toolCalls array (provider: {name,input,result}; claude: {name,input,result} where
// result is the raw MCP text) AND this turn's journal entries (index rows for this turnSeq). DATA SOURCE:
//  - journal entries (S4a) are the authoritative source for file changes: merged into filesChanged by
//    path, their `op` (create/modify/delete) is used (more accurate than the tool record's guess), and
//    they are `revertible:true` (skipped:true entries stay revertible:false — no `before` was stored);
//  - tool records supply files NOT covered by the journal (e.g. CLI-native tools) at revertible:false,
//    and the command count. When a path appears in BOTH, the journal entry wins.
//  Rules:
//  - file_write → op create/modify; file_edit → modify; file_delete → delete; path=input.path
//  - powershell_run/script_run/shell_send (and, for the claude engine, any non-workbench-file tool) → commands+1
//  - artifacts is always [] (field established for C4/v0.9).
const { kindForPath, projectBridgedIrreversible, buildTurnSummary } = require('./backend/turn-summary.cjs');

// v0.8-S0 A6: detect an interrupted (dangling) turn from providerHistory. Dangling shapes:
//   - the tail is a role:'user' message with no assistant reply after it (turn never got answered);
//   - the tail is a role:'tool' message (turn stopped mid tool-loop, see below);
//   - the tail assistant carries tool_calls but not every tool_call_id has a matching role:'tool' reply
//     (turn was arrested mid tool-loop). Returns { dangling, kind } — kind: 'user'|'tool_calls'|null.
function detectDanglingTurn(session) {
  // perf:不读 provider 正文的装载视图(SESSION_LOAD_OMIT_PROVIDER)带着这份正文的判定与条数,形状与下面逐键相同。
  const omitted = sessionOmittedProviderHistory(session);
  const h = omitted ? null : ((session && Array.isArray(session.providerHistory)) ? session.providerHistory : []);
  // turnSeq + historyLength form a stable UI-dismiss fingerprint: reopening the same interrupted turn stays
  // dismissed, while a later interruption automatically gets a fresh banner instead of inheriting the old ×.
  const meta = { turnSeq: Math.max(0, Number(session && session.turnSeq) || 0), historyLength: omitted ? omitted.count : h.length };
  const state = omitted ? omitted.dangling : danglingTurnState(h.length, i => h[i]);
  return { dangling: state.dangling, kind: state.kind, ...meta };
}
// detectDanglingTurn 的判定本体:只看 providerHistory 的尾巴,at(i) 取第 i 条(数组下标,或 02 正文记录按行惰性解析)。

const ProviderHistory = require('./backend/provider-history.cjs').createProviderHistory({
  logEvent,
  buildAttachmentPrompt: (...args) => buildAttachmentPrompt(...args),
  buildDeliveryRevisionPrompt: (...args) => buildDeliveryRevisionPrompt(...args),
  lastAssistantEngine: (...args) => lastAssistantEngine(...args),
});
function repairProviderHistoryPairing(...args) { return ProviderHistory.repairProviderHistoryPairing(...args); }
function isProviderToolArgsObject(...args) { return ProviderHistory.isProviderToolArgsObject(...args); }
function providerHistoryToolCalls(...args) { return ProviderHistory.providerHistoryToolCalls(...args); }
function repairProviderHistoryToolArgs(...args) { return ProviderHistory.repairProviderHistoryToolArgs(...args); }
function appendDisplayMessagesToProviderHistory(...args) { return ProviderHistory.appendDisplayMessagesToProviderHistory(...args); }
function syncProviderHistoryFromDisplay(...args) { return ProviderHistory.syncProviderHistoryFromDisplay(...args); }

// Returns the normalized session, or null when the file is missing/unreadable. A file that exists but
// fails to parse is renamed to <id>.json.corrupt (isolated, not deleted) so a truncated write can't
// keep 500-ing every read; callers treat null as "not found".
// v1.9 存储 v2:头(storageVersion:2)从两个 NDJSON 正文装配 messages/providerHistory;正文缺失/坏 →
// v1bak 回退(迁移备份),无 v1bak 才按损坏隔离。legacy 单文件首次加载后打非枚举 __v1bakPending 标记,
// 由 saveSession 完成「先备份 v1bak、再落 v2」的懒迁移(对调用方完全透明)。
// ── 第71b波:残留 pending 叙事段清理者 ─────────────────────────────────────────────────────────
// permission/plan/question 叙事段在回合流式期以 status:'pending'(权限另有 'paused' 存档暂停)落盘(上方段构建器)。
// 进程重启/回合中断后,内存待决注册表(04 pendingPermissions/pendingQuestions/pendingPlans)已清空,决策永远
// 到不了 —— 段却在每次重进会话时永远显示「待处理」只读 pill(与 Intervention 的 cancelled_restart 同源的残留)。
// 本清理器在 loadSession 全量装载时惰性修复:段的 id 不在活注册表 → 决策不可能再到达,诚实标终态 'cancelled'
// + note(前端 pill 词汇已有 cancelled,见 chat-static-renderer narrativeStateLabel)。惰性而非 boot 全扫:
// messages 正文是大文件,boot 扫全部会话代价不可控;loadSession 时该会话反正要被读,一趟摊销。
// 覆盖 71b 前存量段(无 Intervention 记录)与 71b 后段(boot 已 cancel_restart 但段未动)——活注册表是唯一判据。
// 竞态防护(调用方执行):活回合(activeChildren)或 dying turn 收尾窗口(turnSettlers,第69波 rewind 同款)
// 内绝不调用 —— 此时磁盘 pending 可能是「决策在内存、未落盘」的活段,误标会与回合收尾 save 互相覆盖。
function healStalePendingSegments(session) {
  if (!session || !Array.isArray(session.messages)) return false;
  let healed = false;
  const note = '应用重启或回合中断,该请求已失效;如需请重新发起。';
  const toolNote = '回合中断时该工具仍在运行,已标记为取消;如需请重试。';
  for (const msg of session.messages) {
    const segs = msg && Array.isArray(msg.segments) ? msg.segments : null;
    if (!segs) continue;
    for (const seg of segs) {
      if (!seg || typeof seg !== 'object') continue;
      if (seg.type === 'permission' && (seg.status === 'pending' || seg.status === 'paused')) {
        if (seg.requestId && pendingPermissions.has(String(seg.requestId))) continue; // 活待决:决策仍会到达
        seg.status = 'cancelled'; seg.note = note; healed = true;
      } else if (seg.type === 'plan' && seg.status === 'pending') {
        if (seg.planId && pendingPlans.has(String(seg.planId))) continue;
        seg.status = 'cancelled'; seg.note = note; healed = true;
      } else if (seg.type === 'question' && seg.status === 'pending') {
        if (seg.questionId && pendingQuestions.has(String(seg.questionId))) continue;
        seg.status = 'cancelled'; seg.note = note; healed = true;
      } else if ((seg.type === 'tool' || seg.type === 'subagent') && seg.status === 'running') {
        // 47b/86: 回合被 Stop/看门狗/异常中止时,正在执行的 tool/subagent 段以 'running' 落盘 (finalizeAll
        // 在新回合会兜底,但此会话是修复前落盘的存量) -> 重进会话时诚实标 'cancelled'。
        seg.status = 'cancelled'; seg.note = toolNote; healed = true;
      } else if (seg.type === 'workflow' && (seg.status === 'running' || seg.status === 'paused')) {
        seg.status = 'cancelled'; seg.note = toolNote; healed = true;
      }
    }
  }
  return healed;
}

const SessionPersistence = require('./backend/session-persistence.cjs').createSessionPersistence({
  files: { sessionPath, sessionBodyPaths, ensureDirs, atomicWriteJson: (...args) => atomicWriteJson(...args) },
  model: { normalizeSession, healStalePendingSegments, mergeMissionBeforeSave },
  coordination: { sessionWriteChains, sessionRewindGenHighWater }, missionChanges: MissionChanges,
  bodies: SessionBodies,
  lifecycle: {
    isActive: id => activeChildren.has(id) || turnSettlers.has(id),
    protectedHistoryEnabled: () => DesktopExecutionHooks.enabled(),
    ownsExecution: (id, owner) => typeof SessionExecutionHooks.owns === 'function' && SessionExecutionHooks.owns(id, owner),
    isTombstoned: sessionSaveIsTombstoned,
    mergeBackgroundJobs: session => { if (EventStreamHooks.mergeBackgroundJobs) EventStreamHooks.mergeBackgroundJobs(session); },
  },
  metadata: {
    sessionMeta, sessionRecentUserRequest, scheduleIndexUpdate: scheduleSessionIndexUpdate,
    applyOverrides: session => { applySessionTitleOverride(session); applySessionPermissionModeOverride(session); applySessionDesktopToolsOverride(session); },
    applyRouteOverride: session => {
      const id = session.id, route = sessionEngineRouteOverrides.get(id);
      if (route) session.engineRoute = { ...route };
      if (sessionEngineRouteScopeOverrides.has(id)) {
        if (sessionEngineRouteScopeOverrides.get(id) === 'thread') session.engineRouteScope = 'thread';
        else delete session.engineRouteScope;
      }
    },
  },
  events: RUYI_EVENTS, safeSessionId, safeJsonParse, nowIso, logEvent, storageVersion: SESSION_STORAGE_VERSION,
});
const { sessionOmittedProviderHistory, sessionProviderHistoryLength, SESSION_LOAD_OMIT_PROVIDER, readSessionRouteHead } = SessionPersistence;
// Legacy host adapters disappear with the HTTP/engine composition migration.
async function loadSession(...args) { return SessionPersistence.loadSession(...args); }
async function saveSession(...args) { return SessionPersistence.saveSession(...args); }
async function readSessionHeadResilient(...args) { return SessionPersistence.readSessionHeadResilient(...args); }

// ── 回合收尾那一存(三个引擎共用):带回合代数闸 ──────────────────────────────────────────────────────
// 现象(审计 t4):回合 1 卡在不理会中止的工具里,用户在同一会话发回合 2,回合 2 跑完;回合 1 的工具稍后返回,
// 收尾那一存拿着回合 1 起跑时的旧对象把整份正文写回去 —— 回合 2 的 user/assistant 消息与 providerHistory 全没了。
// 这里用 saveSession 的 throwIfTurnSuperseded:盘上的 turnSeq 比这份对象大就不写。返回 true = 已落盘;
// false = 本回合已被更新的回合顶替,收尾存被丢弃 —— 调用方据此不再派 thread.done / 任务进度(否则把一个
// 过期回合当成「最新一回合结束」广播出去)。一次普通的停止(没有更新的回合)turnSeq 相等,照常落盘。
const { saveTurnFinalSession, withSessionMutateLock, mutateSession } = require('./backend/session-transactions.cjs').createSessionTransactions({
  loadSession, saveSession, logEvent,
});

// 一份内存里的会话对象是不是撤回之前读出来的(驱动器、旁车写入用它判「还该不该接着干」)。
function sessionObjectIsStale(session) {
  if (!session || !session.id) return false;
  return (Number(session.rewindGen) || 0) < (sessionRewindGenHighWater.get(session.id) || 0);
}

// 50-fix(标题卡死):未命名标题判定 —— 后端占位 'New session' 与历史前端本地化占位('新会话'/'New chat')
// 均视为未命名,两引擎回合结束据此自动命名(历史会话下一轮补名)。
const IMPORTED_MESSAGE_ROLE_MAX = 32;
// 安全走查 S10:导入来的消息是外来文本(可能是别人分享的会话文件、含伪造的「用户已授权…」对话),每条打来源标记
// meta.imported:true,让这条线程里的内容始终能被认出是导入的。meta【整个替换】而不是合并:文件自带的 meta
// (比如伪造 origin:'agent_wake' / 'inbox' 去走界面里那几条特殊渲染)一律丢掉。
function sanitizeImportedSessionMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(m => m && typeof m === 'object' && !Array.isArray(m)
    && typeof m.role === 'string' && m.role.trim() && m.role.length <= IMPORTED_MESSAGE_ROLE_MAX
    && (m.content == null || typeof m.content === 'string' || Array.isArray(m.content)))
    .map(m => ({ ...m, meta: { imported: true } }));
}

async function createSession({ title, cwd, origin, engineRoute }) {
  const id = makeId('sess');
  clearDeletedSession(id);   // hunt2-P2:新建的会话绝不继承同名旧会话的删除墓碑
  const config = await readConfig();
  // 导入会话(POST /api/sessions 的 messages,来自用户选的 JSON 文件)同样不可信:修前 [null] 让建会话 500
  // (而且半截落了盘),数字/字符串元素原样进正文。只收【普通对象 + 非空字符串 role + content 缺省或为字符串/数组】
  // 的条目,其余丢掉 —— 这就是展示消息的形状(assistant 的 content 可以是 '',正文在 segments 里)。
  const initialMessages = sanitizeImportedSessionMessages(arguments[0]?.messages);
  // title / cwd 来自 POST /api/sessions 与 /api/chat/stream 的请求体,类型不可信:修前 {"cwd":5} 原样落盘,
  // 这条会话此后每一回合都死在 path.resolve(5);对象/数组标题会原样回给列表(前端 .trim() 的雷)。
  // 非字符串或空白一律当没传;标题上限与 applySessionMetaPatch 改名同为 200。
  const safeTitle = typeof title === 'string' && title.trim() ? title.slice(0, 200) : undefined;
  const safeCwd = typeof cwd === 'string' && cwd.trim() ? cwd : undefined;
  const session = {
    id,
    schemaVersion: SESSION_SCHEMA,
    turnSeq: 0,
    title: safeTitle || 'New session',
    summary: '',
    pinned: false,
    cwd: safeCwd || config.defaultWorkspace || os.homedir(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    claudeSessionId: null,
    messages: initialMessages,
    providerHistory: [],
    providerHistoryCursor: 0,
    privacyHistoryV1: false, // Fresh disabled sessions bypass legacy-reference migration entirely.
    attachments: [],
    // 123-N2:四层优先级搬进 newSessionEngineRoute(见那里的头注)。修前这一行是
    // `inferSessionEngineRoute({messages}) || sessionEngineRouteFromConfig(config)` —— 即今天的
    // ②||④,新增的是最前面的 ①(显式入参)与中间的 ③(上一次用的)。
    engineRoute: newSessionEngineRoute(config, engineRoute, initialMessages, id),
    mission: null, // 第26波b: 任务账本(见 normalizeMission)
    missionId: id, // 75a (D1 plan B): stable Mission identity, written for new sessions (== sessionId in 3.0)
    kind: 'quick_ask', // 第70波(EC-E):显式 Quick Ask 标识;mission start 时翻转 'mission'(见 13-http-router /api/mission)
    // 第 121 波 K3(34 号文 §4.1「来源三值」):这条线程是谁开的。**只在这里写一次,此后终身不变**,
    // 且【不在】 applySessionMetaPatch 的白名单里(理由与 createdBy 同一条,见那里的注释锚)。
    // 三值 'steward' | 'user' | 'schedule':管家族两条建线程的路径(13k thread_new / quick_ask)显式传
    // 'steward';119 波的定时任务落地后由它自己传 'schedule';其余一律 'user'。非法值当没传。
    // 存量会话头没有这个字段:读侧由 06i 的 threadOriginOf 现场派生,**不回写**(索引是纯派生物,
    // 为了补一个字段去改几百个会话文件不值得,而且那会把 sourceStamp 全体打脏)。
    origin: (origin === 'steward' || origin === 'schedule') ? origin : 'user',
    // 116-5a(§11.8.3):建会话时就带了一个【不是占位符】的标题 = 这条线程已经有名字了,不必再花一次
    // 模型调用去起名。判据复用既有的 isUntitledSessionTitle(中英占位集,双引擎自动命名共用同一个),
    // 所以经典壳送来的「新会话」/「New chat」仍然算没名字。与「用户手改标题」写的是同一个字段:
    // 显示优先级只有一条 —— 人给的名字 > 生成的名字 > 原话。
    ...(isUntitledSessionTitle(safeTitle) ? {} : { titleSource: 'user' }),
  };
  // 落盘前就补齐 normalizeSession 的默认字段(todos / skills / memories / memoriesExplicit / memoryExclusions ……)。
  // 修前新会话头缺这几个键,第一次 loadSession 判 changed → load_normalize 回写 —— 光是「点开看一眼」就把
  // updatedAt 推到现在,这条会话跳到列表最上面(rail-session-search 浏览器件在 Windows CI 上偶发红的根因)。
  normalizeSession(session);
  await saveSession(session);
  // 121-K2a(§6.1 第 4 条):新线程。missionId 在 3.0 里建会话时 == sessionId(见上面那一行),
  // 真正归到别的任务是后来 missionAttachThread 的事(它自己派 thread.adopted)。
  RUYI_EVENTS.emit('thread.created', { sessionId: id, missionId: String(session.missionId || ''), title: String(session.title || '') });
  return session;
}

// ============================================================================
// v0.8-S4a — Checkpoint journal (信任层核心). Layout under dataRoot/checkpoints/<sessionId>/:
//   index.json                 [{turnSeq, entrySeq, tool, path, op:'create'|'modify'|'delete', bytes, skipped?, ts}]
//   <turnSeq>-<entrySeq>.gz    zlib.gzipSync(before content) — op:'create' has NO .gz (before never existed)
//   history-<turnSeq>.json.gz  (S5 providerHistory snapshot — only the directory convention is reserved here)
//
// DUAL-PROCESS INVARIANT: the journal is FILESYSTEM-LEVEL shared state. Both engines write the SAME
// dataRoot/checkpoints dir — the provider engine's toolCall() runs in the serve process; the Claude
// engine's workbench tools run in the one-shot MCP child. This is race-free by construction: within one
// session, only ONE engine runs a turn at any instant, so there is never concurrent writing to a given
// session's checkpoints dir. The MCP child must NOT write session files (S3 invariant) but CAN write the
// checkpoints dir (independent of session files → no contention with the serve process's saveSession).
//
// SAFETY-NET, NOT A GATE: any journal failure is swallowed (try/catch) and MUST NOT block tool execution.
// A journal write that throws simply skips its index entry; the tool runs regardless. The trade-off is
// deliberate — a checkpoint is a safety net, and a broken safety net must never stop the user's work.
// ============================================================================
async function checkpointRollbackContext(sessionId) {
  let guardSession = null, guardConfig = null;
  try { guardSession = await loadSession(sessionId); } catch { guardSession = null; }
  try { guardConfig = await readConfig(); } catch { guardConfig = {}; }
  return {
    session: guardSession, config: guardConfig,
    effectivePermissionMode: resolvePermissionMode({ session: guardSession, config: guardConfig }),
  };
}
const { journalRevertLogRead, JOURNAL_KEEP_TURNS, JOURNAL_MAX_BEFORE_BYTES, journalGcProbe, journalBytesAdjust, withJournalWriteLock, journalDir, journalReadIndex, journalResolveTurnSeq, journalRecord, journalRecordMany, workspaceBaselinePathKey, workspaceBaselineIsCodePath, captureWorkspaceTurnBaseline, reconcileWorkspaceTurnBaseline, journalDropEntries, journalGc, journalRollback, journalRevertLogRecord, journalRevertNoticesPeek, journalRevertNoticesAck, journalRevertLogPrune } = require('./backend/checkpoint-journal.cjs').createCheckpointJournal({
  paths, assertSessionIdForPath, atomicWriteJson, gitReadOnlyGuard: (...args) => gitReadOnlyGuard(...args), guardFileToolPath, logEvent, nowIso, pathWithinRoot, realpathForContainment, runGit: (...args) => runGit(...args), safeJsonParse, sessionPath, getRollbackContext: checkpointRollbackContext, isSessionActive: id => activeChildren.has(id),
});

// v0.8-S4b B2 — conversation REWIND (Claude Code-style "back up to just before this message"). Truncates
// the session to the state right BEFORE `targetTurnSeq` began: removes that turn's user message and
// everything after it, returns the removed user text so the front-end can refill the composer (话还在输入
// 框里可改可重发), and OPTIONALLY rolls back the files of every discarded turn.
//
// Key决策 (locked in this slice):
//  - providerHistory is CLEARED to [] — NOT surgically truncated. The provider engine's lazy-reseed
//    (runOpenAiTurn, seeds from session.messages when providerHistory is empty) rebuilds the user/assistant
//    text context on the very next turn. Simple and ALWAYS correct (including after a compaction, where a
//    surgical truncation of the summarized history would be meaningless). The trade-off is losing the tool
//    trace from prior turns; the reseed carries text only. Documented here.
//  - session.turnSeq is NOT rewound — monotonicity is the journal's primary key; a new turn after a rewind
//    keeps incrementing (never reuses a discarded seq).
//  - session.todos is KEPT — rewinding the CONVERSATION is not abandoning the TASK LIST.
//  - claudeSessionId is nulled — the CLI's --resume context no longer matches the truncated history, so a
//    stale resume would splice removed context back in.
// Returns {ok, removedTurns, lastUserText, filesReverted:[], filesFailed:[]} (or {ok:false,error} when a
// turn is live or the target can't be located; 107-F7b: error 'rewind_superseded' when a newer rewind of the
// same session landed first and this one's truncation was dropped by the rewind-generation gate).
// A guarded rewind owns admission until stopping, settlement, file rollback and persistence all finish.
// This is process-local coordination, never a durable session field or a reusable authorization.
const SessionRewind = require('./backend/session-rewind.cjs').createSessionRewind({
  execution: SessionExecutionHooks, state: { activeChildren, turnSettlers },
  storage: { loadSession, saveSession, bumpMissionChangeSeq },
  checkpoints: { rollback: journalRollback, prune: journalRevertLogPrune },
  effects: {
    cancelModelRunsOfDiscardedTurns,
    forgetBackgroundJobs: (...args) => EventStreamHooks.forgetBackgroundJobs?.(...args),
    onSessionRewound: (...args) => EventStreamHooks.onSessionRewound?.(...args),
  },
  events: RUYI_EVENTS, logEvent,
});
const { rewindSession } = SessionRewind;
SessionExecutionHooks.admissionBlocked = SessionRewind.admissionBlocked;

// Resolve the journal {sessionId, turnSeq} for a file-mutating toolCall. Priority:
//  - ctx (provider loop passes its live session.id + session.turnSeq) → authoritative;
//  - else the MCP child reads WCW_SESSION_ID env + the session file's turnSeq (read-only, no race).
// Returns {sessionId, turnSeq} where either may be falsy/null → journalRecord then no-ops gracefully.
async function journalSessionCtx(ctx) {
  if (ctx && ctx.sessionId && Number.isFinite(ctx.turnSeq)) return { sessionId: ctx.sessionId, turnSeq: Number(ctx.turnSeq) };
  const sessionId = (ctx && ctx.sessionId) || process.env.WCW_SESSION_ID || '';
  const turnSeq = await journalResolveTurnSeq(sessionId, ctx && ctx.turnSeq);
  return { sessionId, turnSeq };
}

// ============================================================================
// 第 116 波 116g(27 号文 §3.1「事项跨会话升格」):事项(Mission)容器。
//
// 为什么要有这一层:`sessionMeta.missionId` 从 75a 起就在会话头里了,但它一直只是「= sessionId」的
// 稳定主键 —— 一个事项永远只有一条线程。116g 把 mission 升格成【跨会话容器】:一个事项可以有多条
// 线程(会话),线程可以加入/移出事项,事项可以合并与拆分。
//
// 三条边界(改这段前先读):
//   ① **事项级字段的唯一归属在事项文件**。`goal` / `acceptance` / `budget` 只存在 `<data>/missions/
//      <missionId>.json` 里。会话头里那个 `head.mission`(第26波b 的【会话内任务账本】:目标、里程碑、
//      until-done 预算、停滞标记、结果章)**一个字节都不动**,它仍然是「这条线程自己的里程碑」,
//      不再是事项级权威。两者同名不同物,不要互相回写。
//   ② **零迁移**。没有事项文件的 missionId 一律视为「未归类」,按需从会话头【只读派生】一个不落盘的
//      视图(`derived:true`,标题取会话标题)。存量会话不批量重写、不补建文件。
//   ③ **反向索引的权威是事项文件的 `sessionIds`**,但读侧一律与会话头 `missionId` 对账 —— 文件丢了
//      或损坏了,索引就从会话头重建,不需要任何修复流程。
//
// 落点为什么在 02 而不是 06e(事项域):这一节是【持久化面】—— 文件读写、原子写、损坏隔离、写链、
// 反向索引与会话头两侧同写。02 已经是会话头、正文、变更流水、待决流水的唯一持有者,事项容器与它们
// 共用 atomicWriteJson / safeSessionId / updateSessionMeta / bumpMissionChangeSeq 这几件同样的东西;
// 放在 06e 会让引擎层凭空多出一条到 01-config 的边(见 module-dependency-policy.json 的债务上限)。
// 06e 仍然是【会话内任务账本】的域(buildMissionPromptSection / runMissionDriver),两者同名不同物。
//
// 聚合状态的唯一定义在 06i 的 `aggregateMissionState` —— 它与五态判据 `deriveStewardThreadState` /
// `stewardThreadStateFromCard`(mission-state.js 的服务端抄写件)同住一屋,入参是子线程五态数组。
// 13d / 13g / 13h 一律调它,禁止另写一份判据。
// ============================================================================

const MissionStore = require('./backend/mission-store.cjs').createMissionStore({ paths, safeSessionId, makeId, nowIso, logEvent, atomicWriteJson });
const { safeMissionId, readMissionContainer, withMissionContainerLock, writeMissionContainer, listMissionContainers, createMissionContainer, patchMissionContainer, missionIndexAdd, missionIndexRemove, MISSION_CONTAINER_MAX_FILES } = MissionStore;

async function readMissionSessionHead(sessionId) {
  const sid = safeSessionId(sessionId);
  if (!sid) return null;
  try { return applySessionTitleOverride(safeJsonParse(await fsp.readFile(sessionPath(sid), 'utf8'), null)); } catch { return null; }
}

const { missionAttachThread, missionDetachThread, missionMergeInto, missionSplitThreads } = require('./backend/mission-membership.cjs').createMissionMembership({
  store: MissionStore,
  sessions: { readHead: readMissionSessionHead, updateMeta: updateSessionMeta, list: listSessions, recordChange: bumpMissionChangeSeq, missionId: sessionMissionId },
  events: RUYI_EVENTS, logEvent, safeSessionId,
});

// Usage storage reports committed rows through this workbench composition boundary.
const {
  appendUsageLedger, flushUsageLedgerSync, forEachUsageRow, readUsageRows, usageLedgerCacheStats,
  usageLedgerChangesSince, usageDayKey, usageDayKeyMemo, usageRangeLowerMs,
} = require('./backend/usage-ledger.cjs').createUsageLedger({
  directory: paths.usage,
  onAppend(rec) {
    RUYI_EVENTS.emit('projection.invalidated', { sessionId: rec.sessionId, reason: 'usage' });
    if (rec.kind === 'turn') bumpMissionChangeSeq(rec.sessionId, {
      type: 'budget',
      cursor: { turnSeq: rec.turnSeq, engine: rec.engine },
      detail: { inTok: rec.inTok, outTok: rec.outTok, cachedInTok: rec.cachedInTok, cost: rec.cost, currency: rec.currency || '', estimated: rec.estimated },
    });
  },
});
