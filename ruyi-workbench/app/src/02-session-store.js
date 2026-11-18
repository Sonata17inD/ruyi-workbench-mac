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

const { createSessionNotes, extractSessionNotes, renderSessionNotesMarkdown, parseSessionNotesMarkdown,
  mergeSessionNotes, buildSessionNotesInjectPrompt } = require('./backend/session-notes.cjs');
const { sessionNotesPath, readSessionNotes, writeSessionNotes, removeSessionNotes, maybeWriteSessionNotes } =
  createSessionNotes({ paths, assertSessionIdForPath, atomicWriteJson, sessionObjectIsStale, sessionSaveIsTombstoned, logEvent });

const {
  createSessionScratchpad, SESSION_SCRATCHPAD_LIMITS, normalizeScratchpadKey, normalizeScratchpadText, scratchpadTotalChars,
} = require('./backend/session-scratchpad.cjs');
const { sessionScratchpadPath, scratchpadWriteInFlight, readSessionScratchpad, updateSessionScratchpad } = createSessionScratchpad({
  paths, assertSessionIdForPath, DurableJsonStore, logEvent, sessionSaveIsTombstoned, nowIso,
});

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
function agentRunDir(sessionId) { return path.join(paths.agentRuns, safeSessionId(sessionId)); }
function agentRunFile(sessionId, runId) { return path.join(agentRunDir(sessionId), `${safeSessionId(runId)}.json`); }

const AgentRunStore = require('./backend/agent-run-store.cjs').createAgentRunStore({
  files: { agentRunDir, agentRunFile, atomicWriteJson, readFileTail },
  lifecycle: { sessionAssociatedSaveIsTombstoned, hasLiveRun: id => activeAgentRuns.has(id), getLiveRun: id => activeAgentRuns.get(id) },
  signals: { missionSignalThrottleAllow, MISSION_STALL_SIGNAL_WINDOW_MS, emit: (...args) => RUYI_EVENTS.emit(...args), logEvent },
  safeSessionId, safeJsonParse, nowIso,
});
const {
  agentRunEventsFile, syncRunEventSeq, appendAgentRunEvent, flushAgentRunEvents,
  recordRunStalledEvent, recordRunBudgetTrippedEvent, parseEventWindow, readAgentRunEvents,
  bumpRunIntervention, classifyNodeErrorText, accumulateRunUsage, agentRunHealth, agentRunHealthChanged,
  saveAgentRun, listAgentRuns, agentRunDigestShadow, listAgentRunDigests, agentRunDigestRow,
} = AgentRunStore;

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
const { rememberLastUsedEngineRoute, newSessionEngineRoute } = createSessionRoutePreferences({ mutateConfig, selectedAgentCli, logEvent });

const SessionMetaUpdates = require('./backend/session-meta-updates.cjs').createSessionMetaUpdates({
  safeSessionId, logEvent: (...args) => logEvent(...args), RUYI_EVENTS,
  metadata: { setSessionTitleOverride, SESSION_BRIEF_TITLE_CHARS, SESSION_BRIEF_GIST_CHARS },
  overrides: { normalizeSessionEngineRoute, sessionEngineRouteOverrides, sessionEngineRouteScopeOverrides, rememberLastUsedEngineRoute, normalizeSessionPermissionMode, sessionPermissionModeOverrides, normalizeSessionDesktopTools, sessionDesktopToolsOverrides },
  sessions: { withSessionMutateLock: (...args) => withSessionMutateLock(...args), loadSession: (...args) => loadSession(...args), saveSession: (...args) => saveSession(...args) },
  lifecycle: { activeChildren, turnSettlers },
});
const { sessionTodosSignature, updateSessionMeta } = SessionMetaUpdates;

// v0.8-S0: fold an older/partial session onto the current schema. Mirrors normalizeConfig's shape:
// returns { session, changed }. Backfills schemaVersion + turnSeq and guarantees the array fields so
// no downstream code has to defend against missing/typo'd properties.
const { normalizeSession, normalizeMetaToolArgs, normalizeTodoItems, normalizeMissionCheck, recordMissionCheckResult, normalizeMission, applyMissionUpdate, missionProgressDigest, missionContainerAcceptanceStamp, buildMissionAcceptanceProjection, foldTurnSummaries, followupAcceptanceCriterion, MISSION_MAX_MILESTONES, MISSION_MAX_TEXT, MISSION_DEFAULT_MAX_TURNS, MISSION_STALL_LIMIT } = require('./backend/session-model.cjs').createSessionModel({ SESSION_SCHEMA, SKILL_ID_RE, MEMORY_FIXED_SELECTION_HARD_MAX, inferSessionEngineRoute, nowIso });

const {
  buildMissionResult, archiveMissionResult, maybeFinalizeMission,
  finalizeMissionAfterTurn, mergeMissionBeforeSave, evaluateMissionCheck,
} = require('./backend/mission-lifecycle.cjs').createMissionLifecycle({
  journalReadIndex: (...args) => journalReadIndex(...args), foldTurnSummaries, applyMissionUpdate, nowIso,
  runProcess: DesktopShell.runProcess,
});

const { stopMissionAgentRuns, cancelModelRunsOfDiscardedTurns } =
  require('./backend/session-run-cancellation.cjs').createSessionRunCancellation({
    activeAgentRuns, bumpRunIntervention, appendAgentRunEvent, saveAgentRun, logEvent,
  });

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

const ProviderHistory = require('./backend/provider-history.cjs').createProviderHistory({ logEvent });
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
const { detectDanglingTurn, healStalePendingSegments } =
  require('./backend/session-recovery.cjs').createSessionRecovery({
    danglingTurnState, sessionOmittedProviderHistory: session => sessionOmittedProviderHistory(session),
    pendingPermissions, pendingPlans, pendingQuestions,
  });

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
const createSession = require('./backend/session-creation.cjs').createSessionService({
  SESSION_SCHEMA, makeId, clearDeletedSession, readConfig, nowIso, newSessionEngineRoute,
  isUntitledSessionTitle, normalizeSession, saveSession, RUYI_EVENTS,
});

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
  paths, assertSessionIdForPath, atomicWriteJson, gitReadOnlyGuard, logEvent, nowIso, pathWithinRoot, runGit,
  safeJsonParse, sessionPath, getRollbackContext: checkpointRollbackContext, isSessionActive: id => activeChildren.has(id),
  guardFileToolPath: (...args) => guardFileToolPath(...args),
  realpathForContainment: (...args) => realpathForContainment(...args),
});

const { fileToolWorkspaceDir, resolveFileToolRoot, resolveFileToolPath } = require('./backend/file-tool-paths.cjs').createFileToolPaths({
  loadSession, readConfig, normalizeCwd, getMcpSessionId: () => process.env.WCW_SESSION_ID || '',
});
const preflightWriteBoundary = require('./backend/file-write-preflight.cjs').createWriteBoundaryPreflight({
  resolveFileToolPath, guardFileToolPath: (...args) => guardFileToolPath(...args),
});

let journalBridgedWrite = require('./backend/bridged-write-journal.cjs').createBridgedWriteJournal({
  journalSessionCtx, guardWorkspacePath: (...args) => guardWorkspacePath(...args), journalRecord,
});
const { writeHistorySnapshot, rehydrateObservation } = require('./backend/history-snapshot-store.cjs').createHistorySnapshotStore({
  journalDir, journalBytesAdjust, withJournalWriteLock, journalGc,
});
const materializeCheckpointEditorDiff = require('./backend/checkpoint-editor-diff.cjs').createCheckpointEditorDiff({ journalDir });

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
  paths,
  onAppend(rec) {
    RUYI_EVENTS.emit('projection.invalidated', { sessionId: rec.sessionId, reason: 'usage' });
    if (rec.kind === 'turn') bumpMissionChangeSeq(rec.sessionId, {
      type: 'budget',
      cursor: { turnSeq: rec.turnSeq, engine: rec.engine },
      detail: { inTok: rec.inTok, outTok: rec.outTok, cachedInTok: rec.cachedInTok, cost: rec.cost, currency: rec.currency || '', estimated: rec.estimated },
    });
  },
});
