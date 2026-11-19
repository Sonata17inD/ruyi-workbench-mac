'use strict';
const { runKeyedChain } = require('./keyed-chain.cjs');
const path = require('node:path');
const fsp = require('node:fs/promises');
// Per-intervention CAS, journal compaction and restart reconciliation own their
// write queues and cached records. Execution remains an explicit action callback.
function createInterventionJournal({ paths, nowIso, atomicWriteJson,
  events: RUYI_EVENTS, listAgentRuns, repairTornTail: repairMissionChangeTornTail,
  recordChange: bumpMissionChangeSeq, logEvent }) {
function interventionFilePath(sessionId) {
  return path.join(paths.sessions, `${sessionId}.interventions.ndjson`);
}
// per-session 写链:串行化同会话的 append,防两条 line 交错(注册在流式期、决策在用户点击,可能并发)。
// 独立于 sessionWriteChains(saveSession 的链),互不影响;链错误吞掉(下一写自愈)。
const interventionWriteChains = new Map();
const interventionAppendCounts = new Map(); // 75c: cheap cadence trigger for bounded journal compaction checks
// 75a (Pretender P1): in-memory cache of the last COMPLETE Intervention record per (sessionId, ivId).
// Populated by registerIntervention; refreshed by settleIntervention. Lets settleIntervention write a
// complete state row (preserving type/requestedAt/toolName/questions from the register row) without a
// disk read. On cache miss (e.g. a pool proposal settled after a process restart where the register
// happened last lifecycle), settle writes what it has and readInterventions' merge-fold still preserves
// the register row's fields from disk. The cache is a VIEW of the journal (journal stays authoritative
// on disk); it is empty on boot and re-populated as interventions register in this lifecycle.
// 缓存条目只活到这条 Intervention 结算(settleIntervention / transitionInterventionState 落终态时摘掉)或会话被删
// (dropInterventionSessionState)—— 修前从不删,每条介入留一份完整记录(含 input)在内存里,长跑进程只增不减。
const interventionRecordCache = new Map();
function ivCacheKey(sid, ivId) { return String(sid) + '\x00' + String(ivId); }
// 会话被删:摘掉它名下的介入缓存与压实节拍计数(deleteSession 调)。
function dropInterventionSessionState(sid) {
  const prefix = String(sid) + '\x00';
  for (const key of interventionRecordCache.keys()) if (key.startsWith(prefix)) interventionRecordCache.delete(key);
  interventionAppendCounts.delete(String(sid));
}
function appendIntervention(sessionId, record) {
  const sid = String(sessionId || '');
  if (!sid) return;
  const line = JSON.stringify(record) + '\n';
  const file = interventionFilePath(sid);
  const prev = interventionWriteChains.get(sid) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    try { await repairMissionChangeTornTail(file); } catch { /* best-effort repair; a failed repair leaves the torn tail for the next append to retry (117q-B6fix) */ }
    for (let attempt = 0; ; attempt++) {   // Windows 瞬时锁有界重试;仍失败就抛给下面的 catch → next 解析为 undefined(= 没落盘)
      try { await fsp.appendFile(file, line, 'utf8'); break; }
      catch (e) { if (attempt >= 3 || !/^(EPERM|EBUSY|EACCES)$/.test(String(e && e.code))) throw e; await new Promise(r => setTimeout(r, 10 + attempt * 20)); }
    }
    RUYI_EVENTS.emit('projection.invalidated', { sessionId: sid, reason: 'source' }); // 75c: authority changed; materialized view is disposable
    return true;
  }).catch(() => {});
  interventionWriteChains.set(sid, next);
  next.then(() => {
    // 128f-⑫:待决的每一次结算(允许/拒绝/回答/批准/驳回/超时/回合收尾取消)都从 appendIntervention 过。修前只有
    // 「产生」那一刻有推送(registerIntervention 的 thread.needs_you),结算那一刻没有 —— 用户在中栏点了「允许」,
    // 左栏那枚「等你」要等回合收尾才消失。写链落定之后派,订阅者现算的待决计数才是结算之后的。放在写入块【外面】:
    // 那一块被 readfiletail-torntail (c2) 原样抠出来单独执行,块里只许有它传进去的那几样。
    if (record && record.status !== 'pending') RUYI_EVENTS.emit('thread.state', { sessionId: sid });
    if (interventionWriteChains.get(sid) === next) interventionWriteChains.delete(sid);
    const count = (interventionAppendCounts.get(sid) || 0) + 1;
    interventionAppendCounts.set(sid, count);
    if (count % 128 === 0) void compactInterventionJournal(sid).catch(() => {});
  });
  return next; // 75a-2: expose write promise so transitionInterventionState can await (authoritative write-before-advance); resolves true only when the row landed
}
// 注册一个 pending Intervention。type: 'permission'|'question'|'plan'|'pool'(71b)。ivId 复用 requestId/questionId/planId/poolId(执行权威源的同一 id)。
function registerIntervention(sessionId, type, ivId, extra) {
  const sid = String(sessionId || ''), id = String(ivId || '');
  const rec = { id, type, sessionId: sid, status: 'pending', requestedAt: nowIso(), decidedAt: '', decidedBy: '', interventionVersion: 0, ...(extra || {}) };
  interventionRecordCache.set(ivCacheKey(sid, id), rec); // 75a: cache complete record for settle's complete-state merge
  // 121-K2a(§6.1 第 2 条 / §6.3 指标 c):待决产生的那一刻。不等落盘 —— 内存态(interventionRecordCache)
  // 才是执行权威源(见 appendIntervention 头注),落盘是 best-effort;推送要的是「此刻有人在等你」。
  // 只带 id / 类型 / 一句问题 / 选项:参数与正文不进事件面(§6.1 红线)。
  RUYI_EVENTS.emit('thread.needs_you', {
    sessionId: sid, interventionId: id, kind: String(type || ''),
    question: String((extra && (extra.questionSummary || extra.planSummary || extra.task || extra.summary || extra.toolName)) || '').slice(0, 200),
    options: Array.isArray(extra && extra.questions)
      ? extra.questions.map(q => String((q && q.question) || '').slice(0, 120)).slice(0, 8)
      : [],
  });
  appendIntervention(sessionId, rec).then(() => bumpMissionChangeSeq(sid, {
    type: 'intervention_pending',
    cursor: { interventionId: id, interventionVersion: rec.interventionVersion },
    detail: { interventionType: type },
  })).catch(() => {});
}
// 结算一个 Intervention(append 一条终态记录,后写胜)。status: allowed/denied/answered/cancelled/approved/rejected/cancelled_restart。
// 重复结算(竞态)会 append 多条,读时后写胜折叠取最后一条 -- 状态仍可区分,不致命。
function settleIntervention(sessionId, ivId, status, extra) {
  const sid = String(sessionId || ''), id = String(ivId || '');
  const cached = interventionRecordCache.get(ivCacheKey(sid, id)); // 75a: complete-state merge (preserve type/requestedAt/toolName/...)
  const prevVer = (cached && Number.isFinite(Number(cached.interventionVersion))) ? Number(cached.interventionVersion) : 0;
  // 这条旧路径(权限/提问/计划的超时、清理、经典端点)仍写【完整状态行】:interventions-persist 的 (f) 钉着「settle 保留 type /
  // requestedAt」,直读日志末行的旧读者也靠它。写放大的治理只落在 transitionInterventionState(CAS 路径的 applying/terminal 增量行)。
  const rec = { ...(cached || {}), id, sessionId: sid, status, decidedAt: nowIso(), decidedBy: '', interventionVersion: prevVer + 1, ...(extra || {}) };
  // 结算都是终态:缓存条目用完即摘(修前从不删,每条介入留一份完整记录在内存里);重复结算的竞态照旧是多追一行、读时后写胜。
  if (INTERVENTION_TERMINAL.has(status)) interventionRecordCache.delete(ivCacheKey(sid, id));
  else interventionRecordCache.set(ivCacheKey(sid, id), rec);
  appendIntervention(sessionId, rec).then(() => bumpMissionChangeSeq(sid, {
    type: 'intervention_resolved',
    cursor: { interventionId: id, interventionVersion: rec.interventionVersion },
    detail: { status, interventionType: rec.type || '' },
  })).catch(() => {});
}
// 75c: journal fold returns facts plus integrity evidence. Invalid non-empty rows must not disappear behind a
// successful index rebuild: callers surface `degraded`, while the valid prefix remains readable.
function foldInterventionJournalText(txt) {
  const byId = new Map();
  const rowCount = new Map(); // 75a: id -> journal row count (authoritative interventionVersion = rows - 1)
  const lines = txt.split('\n');
  let validRows = 0, corruptLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue; // 空行(文件以 \n 结尾的尾元 / 段间空行)
    let rec;
    try { rec = JSON.parse(line); } catch { corruptLines++; continue; }
    if (!rec || !rec.id) { corruptLines++; continue; }
    validRows++;
    const idKey = String(rec.id);
    rowCount.set(idKey, (rowCount.get(idKey) || 0) + 1);
    const prev = byId.get(idKey);
    byId.set(idKey, prev ? { ...prev, ...rec } : rec); // 75a: merge-fold (prior fields preserved, rec wins) -- fixes settle overwriting register
  }
  const out = Array.from(byId.values());
  for (const rec of out) {
    // 75a: authoritative version = rows - 1 (every transition appends one row); robust to cache misses.
    const cnt = rowCount.get(String(rec.id)) || 1;
    rec.interventionVersion = Math.max(cnt - 1, Number(rec.interventionVersion) || 0);
  }
  out.sort((a, b) => String(a.requestedAt || '').localeCompare(String(b.requestedAt || '')));
  return {
    interventions: out,
    rowCount: validRows,
    corruptLines,
    degraded: corruptLines > 0,
    bytes: Buffer.byteLength(txt, 'utf8'),
  };
}

async function readInterventionsWithMeta(sessionId) {
  const sid = String(sessionId || '');
  // 读自己的写:registerIntervention / settleIntervention 是「发出去不等」地排进这条会话的写链的。待决事件
  // (permission_request / ask_user)在排队那一刻就推给了前端,用户(或 e2e)紧接着作答时,决定核心
  // (13d decideIntervention)从这里读账 —— 修前不等写链,注册那一行还没落盘就判 not_found,作答 404、
  // 回合干等到超时(Windows CI kimi-agent-cli「permission_request 之后 30 s 无事件」的根因:
  // 决定 POST 回的是 404 unknown or expired request)。写链只做 append,不回头读账,这里等它不会自锁。
  const pending = interventionWriteChains.get(sid);
  if (pending) { try { await pending; } catch { /* append 失败已在写链里吞掉:照读盘上现有的 */ } }
  let txt;
  for (let attempt = 0; ; attempt++) {
    try { txt = await fsp.readFile(interventionFilePath(sid), 'utf8'); break; }
    catch (e) {
      // 每 128 次 append 一次的压实是「写临时文件 + rename」;Windows 上 rename 那一瞬读会撞 EPERM/EBUSY。
      // 修前任何读错都当成「这条会话没有待决」—— 同样判 not_found。瞬时锁有界重试,其余(ENOENT 等)照旧当空。
      if (attempt < 3 && /^(EPERM|EBUSY|EACCES)$/.test(String(e && e.code))) { await new Promise(r => setTimeout(r, 10 + attempt * 20)); continue; }
      return { interventions: [], rowCount: 0, corruptLines: 0, degraded: false, bytes: 0 };
    }
  }
  return foldInterventionJournalText(txt);
}

// 读一个会话的全部 Intervention,按 id 后写胜折叠。返回 Intervention[](按 requestedAt 稳定排序)。
async function readInterventions(sessionId) {
  return (await readInterventionsWithMeta(sessionId)).interventions;
}

// 压实判据(compactInterventionJournal 与 13e 索引重建共用):日志 ≥ 64 KB、行数 > 256,且行数超过存活条数的 1.5 倍。
// 修前是「行数 > 存活条数 × 3」—— 每条介入走完 register → applying → terminal 恰好 3 行,等号不过,永远压不动
// (2000 条已决介入的日志只增不减)。1.5 倍 = 冗余行超过存活行的一半,压完后日志要再长出一截才会再压,摊还 O(1)。
// meta 要有 bytes / rowCount / interventions(foldInterventionJournalText 与 readInterventionsWithMeta 的返回都满足)。
function interventionJournalWorthCompacting(meta) {
  const rowsAfter = Array.isArray(meta && meta.interventions) ? meta.interventions.length : 0;
  return Number(meta && meta.bytes) >= 65536 && Number(meta && meta.rowCount) > Math.max(256, rowsAfter * 1.5);
}
// 75c: NDJSON compaction is an atomic, reconstructible cache-neutral rewrite. One complete latest-state row per
// intervention preserves terminal responses and explicit interventionVersion; corrupt authority is NEVER
// compacted (that would hide damage behind a clean-looking file). Interrupted rewrites leave the old journal.
async function compactInterventionJournal(sessionId, opts = {}) {
  const sid = String(sessionId || '');
  if (!sid) return { ok: false, skipped: 'invalid_session' };
  const file = interventionFilePath(sid);
  return runKeyedChain(interventionWriteChains, sid, async () => {
    let txt = '';
    try { txt = await fsp.readFile(file, 'utf8'); } catch { return { ok: true, compacted: false, rowsBefore: 0, rowsAfter: 0, bytesBefore: 0, bytesAfter: 0 }; }
    const folded = foldInterventionJournalText(txt);
    if (folded.degraded) return { ok: false, compacted: false, degraded: true, corruptLines: folded.corruptLines };
    const rowsAfter = folded.interventions.length;
    const worthwhile = interventionJournalWorthCompacting(folded);
    if (!opts.force && !worthwhile) return { ok: true, compacted: false, rowsBefore: folded.rowCount, rowsAfter, bytesBefore: folded.bytes, bytesAfter: folded.bytes };
    const payload = folded.interventions.map(rec => JSON.stringify(rec)).join('\n') + (rowsAfter ? '\n' : '');
    await atomicWriteJson(file, payload);
    RUYI_EVENTS.emit('projection.invalidated', { sessionId: sid, reason: 'source' });
    return {
      ok: true, compacted: true,
      rowsBefore: folded.rowCount, rowsAfter,
      bytesBefore: folded.bytes, bytesAfter: Buffer.byteLength(payload, 'utf8'),
    };
  });
}
// boot 终态化:进程重启后,内存 Map 清空,但磁盘上可能留有 pending Intervention(上次生命周期注册后未结算 --
// 进程被杀时超时 timer/clearPending 来不及跑)。与 markInterruptedAgentRuns(08:357)对称:重启 = 上次生命周期
// 结束,pending 的 Intervention **不重挂**(原回合的 promise 已无处 resolve,重挂需先 autoResume 续跑回合 +
// re-wire intervention promise,复杂且危险),而是诚实标 cancelled_restart + decidedAt。下次读模型读到的是终态,
// 不永挂。用户若想重新决策,开新回合即可(新回合注册新 Intervention)。
async function markInterruptedInterventions() {
  let files = [];
  try { files = await fsp.readdir(paths.sessions); } catch { return; }
  const stamp = nowIso();
  for (const f of files) {
    if (!f.endsWith('.interventions.ndjson')) continue;
    const sessionId = f.slice(0, -'.interventions.ndjson'.length);
    if (!/^sess_[A-Za-z0-9_-]+$/.test(sessionId)) continue; // 跳过非法名(防穿越/脏文件)
    const ivs = await readInterventions(sessionId).catch(() => []);
    const pending = ivs.filter(iv => iv && iv.status === 'pending');
    const applying = ivs.filter(iv => iv && iv.status === 'applying'); // 75a-2: crash mid-transition (SCHEMA §7)
    if (!pending.length && !applying.length) continue;
    // 71b: pool 型 pending 不一刀切 —— 池提案随 run 快照存活,paused run 恢复后仍可审批(13d pool_approve),
    // 标 cancelled_restart 会与 run 快照里的 proposed 直接矛盾(读模型说已取消、实际仍可决策 = 撒谎)。
    // interrupted/终态 run 的提案由 markInterruptedAgentRuns(boot 先于本函数,13:961)顺手 settle 'expired';
    // 这里只需兜「run 非 paused 但 settle 丢失」(崩溃窗口)与「run 已不存在」的孤儿。paused → 保留 pending(诚实)。
    let poolRuns = null;
    for (const iv of pending) {
      if (iv.type === 'pool') {
        if (!poolRuns) poolRuns = await listAgentRuns(sessionId).catch(() => []);
        const run = poolRuns.find(r => r && r.id === iv.runId);
        if (run && run.status === 'paused') continue; // 恢复后可决策,保留 pending
      }
      appendIntervention(sessionId, { ...iv, id: iv.id, sessionId, type: iv.type || '', status: 'cancelled_restart', decidedAt: stamp, decidedBy: 'restart', interventionVersion: (Number(iv.interventionVersion) || 0) + 1 }); // 75a: complete row (preserve type/requestedAt/toolName) + version bump
    }
    // 75a-2 (SCHEMA §7 崩溃语义): applying = crash during a transition (写 applying 后/resolve 前|后/terminal 前).
    // 重启遇到 applying 不自动重放高风险动作 -- 对照执行审计后进入诚实终态 indeterminate(动作副作用是否发生未知)。
    for (const iv of applying) {
      appendIntervention(sessionId, { ...iv, id: iv.id, sessionId, type: iv.type || '', status: 'indeterminate', decidedAt: stamp, decidedBy: 'restart', interventionVersion: (Number(iv.interventionVersion) || 0) + 1 });
    }
  }
}

// 75a-2 (Pretender P1, SCHEMA §7 S1/S2): 原子 CAS 原语 -- Intervention 权威状态转换的单一核心。
// pending -> applying -> terminal,以 interventionVersion 做 CAS(expectedVersion 不匹配 = 版本冲突)。
// 落盘顺序(74 波冻结):先落 applying -> 执行 action -> 落 terminal + 审计 -> 返回。每步同步落盘后再推进
// (authoritative write-before-advance,消灭「内存已删/账上 pending」漂移窗)。重启遇到 applying 不自动重放,
// 由 markInterruptedInterventions 标 indeterminate(诚实终态)。75b 的 decideIntervention() 与统一契约端点
// POST /api/missions/:missionId/interventions/:id/decision 将调用本原语;经典四端点适配也走同一核心(S2)。
//
// crashAt(失败注入,SCHEMA §7 六窗口):'before_applying'|'after_applying'|'before_resolve'|'after_resolve'|
// 'before_terminal'|'after_terminal' -- 命中即抛 __cas_crash(模拟崩溃,磁盘停在对应状态,供 boot 恢复验证)。
// per-ivId 串行锁(interventionTransitionLocks)保证同一 Intervention 并发决策只发生一次状态转换(C3/S2)。
const interventionTransitionLocks = new Map();
const INTERVENTION_TERMINAL = new Set(['allowed', 'denied', 'answered', 'cancelled', 'approved', 'rejected', 'cancelled_restart', 'indeterminate', 'expired']); // 'expired' = 08/09 pool-expiry 终态(75b 契约路径遇它按 already_terminal)
async function transitionInterventionState(sessionId, ivId, expectedVersion, toStatus, opts = {}) {
  const sid = String(sessionId || ''), id = String(ivId || '');
  if (!sid || !id) return { ok: false, reason: 'bad_args' };
  // per-ivId 串行:同一 ivId 的并发转换排队,第二个读到第一个的终态 -> already_terminal(version_conflict 不会误判)
  const key = ivCacheKey(sid, id);
  return runKeyedChain(interventionTransitionLocks, key, () => runTransition());

  async function runTransition() {
    const crashAt = String(opts.crashAt || '');
    // 1. 读权威当前态(journal 磁盘 + readInterventions 的 rows-1 version,对缓存未命中稳健)
    const ivs = await readInterventions(sid);
    const cur = ivs.find(x => String(x.id) === id);
    if (!cur) return { ok: false, reason: 'not_found', interventionVersion: 0 };
    const curStatus = String(cur.status || '');
    const curVer = Number(cur.interventionVersion) || 0;
    if (INTERVENTION_TERMINAL.has(curStatus)) {
      // 75b (S1): the retry key identifies the same request, not the business object. A byte-equivalent
      // retry returns the response persisted on the terminal row; reusing the key for a different payload
      // is a conflict. A different key still observes the authoritative terminal state and must not execute.
      const retryKey = String(opts.idempotencyKey || '');
      const storedKey = String(cur.idempotencyKey || '');
      if (retryKey && storedKey && retryKey === storedKey) {
        const requestedFingerprint = String(opts.decisionFingerprint || '');
        const storedFingerprint = String(cur.decisionFingerprint || '');
        if (requestedFingerprint && storedFingerprint && requestedFingerprint !== storedFingerprint) {
          return { ok: false, reason: 'idempotency_conflict', status: curStatus, interventionVersion: curVer };
        }
        if (cur.decisionResponse && typeof cur.decisionResponse === 'object') {
          return { ok: true, replayed: true, status: curStatus, interventionVersion: curVer, response: cur.decisionResponse };
        }
      }
      const expired = curStatus === 'expired' || String(cur.decidedBy || '') === 'timeout';
      return {
        ok: false,
        reason: expired ? 'expired' : 'already_terminal',
        status: curStatus,
        decidedBy: String(cur.decidedBy || ''),
        interventionVersion: curVer,
      };
    }
    // pending 之外的非终态(理论上只有 applying,但 applying 在锁内不应并发 -- 防御性拒绝)
    if (curStatus !== 'pending') {
      return { ok: false, reason: 'not_pending', status: curStatus, interventionVersion: curVer };
    }
    // 2. CAS:expectedVersion 必须等于当前 interventionVersion(未传 expectedVersion = 不检查,仅 75b 契约路径传)
    if (Number.isFinite(Number(expectedVersion)) && Number(expectedVersion) !== curVer) {
      return { ok: false, reason: 'version_conflict', expectedVersion: Number(expectedVersion), actualVersion: curVer };
    }
    // 75b: delivery checks run while holding the same per-Intervention lock as the CAS. This prevents
    // "preflight said live, another legacy path consumed it, then we wrote applying" split-brain.
    if (typeof opts.preflight === 'function') {
      const preflight = await opts.preflight(cur);
      if (preflight && preflight.ok === false) {
        return { ...preflight, ok: false, interventionVersion: curVer };
      }
    }
    // 3. 落 applying(pending -> applying)。authoritative:await 落盘后再推进。
    if (crashAt === 'before_applying') throw new Error('__cas_crash:before_applying');
    // 落盘只写增量行(迁移改了的字段),不再整份重抄 cur —— 修前 register/applying/terminal 三行各带一份完整 input,
    // 写放大 3 倍。读侧 foldInterventionJournalText 是后写覆盖的合并折叠,input / questions / planSummary 这类大字段由 register 行带着;
    // 行首只多带几枚【短标量身份】(type / requestedAt / toolName / tier):直读日志末行的读者(interventions-persist (f)
    // 「settle 保留 type / requestedAt」)与人眼排查都认「每行自己说得清是谁」,而它们加起来不过几十字节。
    const identity = {
      ...(cur.type ? { type: cur.type } : {}),
      ...(cur.requestedAt ? { requestedAt: cur.requestedAt } : {}),
      ...(cur.toolName ? { toolName: cur.toolName } : {}),
      ...(cur.tier ? { tier: cur.tier } : {}),
    };
    const applyingRow = {
      id,
      sessionId: sid,
      ...identity,
      status: 'applying',
      decidedAt: '',
      decidedBy: '',
      interventionVersion: curVer + 1,
      source: String(opts.source || 'contract'),
      ...(opts.idempotencyKey ? { idempotencyKey: String(opts.idempotencyKey) } : {}),
      ...(opts.decisionFingerprint ? { decisionFingerprint: String(opts.decisionFingerprint) } : {}),
    };
    const applyingRec = { ...cur, ...applyingRow };   // 完整视图只在内存里用(缓存、audit/afterTerminal 回调)
    // 「执行中」没落盘就不执行:否则重启时账上仍是 pending,会把已经执行过的动作报成「因重启取消」。
    // 缓存不动(仍是 pending),用户可以再点一次。
    if (await appendIntervention(sid, applyingRow) !== true) {
      logEvent({ kind: 'intervention_persist_failed', sessionId: sid, interventionId: id, phase: 'applying' });
      return { ok: false, reason: 'persist_failed', status: curStatus, interventionVersion: curVer };
    }
    interventionRecordCache.set(ivCacheKey(sid, id), applyingRec);
    if (crashAt === 'after_applying') throw new Error('__cas_crash:after_applying');
    // 4. 执行 action(75b 契约路径在此 resolve promise / 跑工具;75a-2 测试可空)
    if (crashAt === 'before_resolve') throw new Error('__cas_crash:before_resolve');
    let result;
    if (typeof opts.action === 'function') {
      const actionResult = opts.action();
      // Keep synchronous waiter resolution and terminal persistence in the same event-loop turn. Native
      // permission/question/plan continuations must not run teardown between resolve() and the terminal row.
      result = actionResult && typeof actionResult.then === 'function' ? await actionResult : actionResult;
    }
    if (crashAt === 'after_resolve') throw new Error('__cas_crash:after_resolve');
    // 5. 落 terminal(applying -> terminal)。authoritative:await。
    if (crashAt === 'before_terminal') throw new Error('__cas_crash:before_terminal');
    const resolvedStatus = typeof opts.resolveStatus === 'function'
      ? String(opts.resolveStatus(result, toStatus) || toStatus)
      : toStatus;
    const dynamicExtra = typeof opts.extra === 'function' ? await opts.extra(result) : (opts.extra || {});
    const response = typeof opts.buildResponse === 'function'
      ? opts.buildResponse(result, { status: resolvedStatus, interventionVersion: curVer + 2 })
      : undefined;
    // 终态行同样只写增量。重放身份(idempotencyKey / decisionFingerprint)在终态行上再带一份:它们很小,而直读日志末行的读者
    // (steward-exempt-no-swap 读 allowed 行上的指纹)认的就是终态行本身;其余字段(type / toolName / input …)由 register 行带着。
    const termRow = {
      id,
      sessionId: sid,
      ...identity,
      status: resolvedStatus,
      decidedAt: nowIso(),
      decidedBy: String(opts.decidedBy || 'user'),
      interventionVersion: curVer + 2,
      source: String(opts.source || 'contract'),
      ...(opts.idempotencyKey ? { idempotencyKey: String(opts.idempotencyKey) } : {}),
      ...(opts.decisionFingerprint ? { decisionFingerprint: String(opts.decisionFingerprint) } : {}),
      ...(dynamicExtra || {}),
      ...(response && typeof response === 'object' ? { decisionResponse: response } : {}),
    };
    const termRec = { ...applyingRec, ...termRow };   // 完整视图给 audit / afterTerminal / 事件载荷用
    // 动作已经执行,终态没落盘也收不回:记一笔;盘上停在 applying,重启时如实标 indeterminate(见头注)。
    if (await appendIntervention(sid, termRow) !== true) {
      logEvent({ kind: 'intervention_persist_failed', sessionId: sid, interventionId: id, phase: 'terminal' });
      // The action already ran. Keep the authoritative applying state, refuse replay,
      // and do not publish a terminal audit or clean up as if persistence succeeded.
      return { ok: false, reason: 'terminal_persist_failed', status: 'applying', interventionVersion: curVer + 1 };
    }
    interventionRecordCache.delete(ivCacheKey(sid, id));   // 终态:缓存条目不再有用(见 interventionRecordCache 头注)
    bumpMissionChangeSeq(sid, {
      type: 'intervention_resolved',
      cursor: { interventionId: id, interventionVersion: termRec.interventionVersion },
      detail: { status: resolvedStatus, interventionType: termRec.type || '' },
    });
    // Audit belongs to the terminal commit: never claim a decision before its authoritative row exists.
    if (typeof opts.audit === 'function') await opts.audit(result, termRec);
    // Registry cleanup is intentionally after terminal persistence. Delivery may already have resolved a
    // waiter, but a competing path cannot observe a missing runtime entry while the journal still says pending.
    if (typeof opts.afterTerminal === 'function') {
      try { await opts.afterTerminal(result, termRec); } catch { /* terminal state is authoritative; cleanup retries on lifecycle teardown */ }
    }
    if (crashAt === 'after_terminal') throw new Error('__cas_crash:after_terminal');
    return { ok: true, status: resolvedStatus, interventionVersion: curVer + 2, result, response };
  }
}
return { interventionFilePath, dropInterventionSessionState, appendIntervention, registerIntervention, settleIntervention, foldInterventionJournalText, readInterventionsWithMeta, readInterventions, interventionJournalWorthCompacting, compactInterventionJournal, markInterruptedInterventions, transitionInterventionState, INTERVENTION_TERMINAL };
}
module.exports = { createInterventionJournal };
