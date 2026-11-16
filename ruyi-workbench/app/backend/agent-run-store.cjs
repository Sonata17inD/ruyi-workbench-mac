'use strict';
const path = require('node:path');
const fsp = require('node:fs/promises');
const zlib = require('node:zlib');
function createAgentRunStore({
  files: { agentRunDir, agentRunFile, atomicWriteJson, readFileTail },
  lifecycle: { sessionAssociatedSaveIsTombstoned, hasLiveRun, getLiveRun },
  signals: { missionSignalThrottleAllow, MISSION_STALL_SIGNAL_WINDOW_MS, emit, logEvent },
  safeSessionId, safeJsonParse, nowIso, runKeyedChain,
}) {
const agentRunWriteChains = new Map();
// ============================================================================
// 第25波 25.3(AUTONOMY-PLAN §4):run 事件日志 —— `<runId>.events.ndjson`(与快照同目录)append-only,
// 单调 seq 持久于 run.eventSeq。快照(run_<id>.json)仍是唯一读取来源;事件日志服务于崩溃取证与
// 后续第29波增量监控。listAgentRuns 的 ^run_[a-f0-9]+\.json$ 过滤天然忽略本文件。追加经 per-run 链
// 串行(防交错行);写失败静默 —— 事件日志是取证辅助,绝不阻断执行(25.2 的"持久化失败不得静默"
// 针对的是【快照】,快照才是恢复依据)。
const agentRunEventChains = new Map(); // runId -> append chain
function agentRunEventsFile(sessionId, runId) { return path.join(agentRunDir(sessionId), `${safeSessionId(runId)}.events.ndjson`); }
// 对抗轮修(第25波): 从磁盘装载 run 后、任何 append 前,把 run.eventSeq 快进到事件文件尾行的 seq ——
// 崩溃窗口里(事件已落行、快照没跟上)重启装载的是旧 eventSeq,不快进就会复用已存在的 seq(严格单调破功,
// 取证排序在最需要它的崩溃场景失效)。只在装载点调用(markInterruptedAgentRuns / launchPersistedAgentRun)。
// 第40波:尾窗化 —— 旧实现整文件 readFile:长跑 run 的 events.ndjson 可达数十 MB,boot 两个恢复扫描
// (markInterrupted/autoResume)与每次 launchPersistedAgentRun 都对每个 run 全读一遍,N 个中断 run = 数百 MB
// 顺序盘 IO(实测分钟级尾延迟)。seq 由本进程单调分配且按 run 串行 append(agentRunEventChains 写链),
// 最大 seq 必在尾部;崩溃撕裂只留不完整尾行,regex 扫片段的行为与旧全读逐字节一致(同一 match 语义)。
// 故:小文件整读;大文件只读尾窗(与 readAgentRunEvents 同阈值);窗内一个 seq 都找不到(极端:单行大于窗,
// seq 前缀在窗外)→ 回落全读保正确。
async function syncRunEventSeq(run) {
  const scanMax = raw => {
    let maxSeq = 0;
    for (const line of raw.split('\n')) {
      const t = line.trim(); if (!t) continue;
      const m = t.match(/"seq":(\d+)/); if (m) { const s = Number(m[1]); if (s > maxSeq) maxSeq = s; }
    }
    return maxSeq;
  };
  const file = agentRunEventsFile(run.sessionId, run.id);
  try {
    const { size } = await fsp.stat(file);
    if (size > AGENT_RUN_EVENTS_TAIL_BYTES) {
      let fh = null;
      try {
        fh = await fsp.open(file, 'r');
        const buf = Buffer.alloc(AGENT_RUN_EVENTS_TAIL_BYTES);
        const { bytesRead } = await fh.read(buf, 0, AGENT_RUN_EVENTS_TAIL_BYTES, size - AGENT_RUN_EVENTS_TAIL_BYTES);
        const maxSeq = scanMax(buf.toString('utf8', 0, bytesRead));
        if (maxSeq > 0) { if (maxSeq > (Number(run.eventSeq) || 0)) run.eventSeq = maxSeq; return; }
      } finally { if (fh) await fh.close().catch(() => {}); }
      // 窗内无 seq(单行大于窗)→ 落下面全读
    }
    const raw = await fsp.readFile(file, 'utf8');
    const maxSeq = scanMax(raw);
    if (maxSeq > (Number(run.eventSeq) || 0)) run.eventSeq = maxSeq;
  } catch { /* 无事件文件 → 无需快进 */ }
}
function appendAgentRunEvent(run, evt) {
  try {
    // 对抗轮修: id 畸形(手编/半写坏的 run JSON)时 safeSessionId→null 会字符串化成 "null.events.ndjson",
    // 多个坏 run 的事件合流互相交错 —— 归属不清的取证不如不记,直接丢弃。(无穿越面,纯归属完整性。)
    if (!safeSessionId(run.id) || !safeSessionId(run.sessionId)) return;
    if (sessionAssociatedSaveIsTombstoned(run.sessionId)) return;
    run.eventSeq = (Number(run.eventSeq) || 0) + 1;
    const rec = JSON.stringify({ seq: run.eventSeq, ts: nowIso(), runId: run.id, ...evt }) + '\n';
    const dir = agentRunDir(run.sessionId);
    const file = agentRunEventsFile(run.sessionId, run.id);
    runKeyedChain(agentRunEventChains, run.id, async () => {
      if (sessionAssociatedSaveIsTombstoned(run.sessionId)) return;
      await fsp.mkdir(dir, { recursive: true });
      await fsp.appendFile(file, rec, 'utf8');
    });
  } catch { /* 取证辅助,不阻断执行 */ }
}
// 等这条 run 已排队的事件都落盘(失败吞掉:事件是取证,不阻断)。终稿落盘前调:读者看到 status=succeeded 时 run_end 必已在
// 事件日志里 —— 修前追加链不等,终稿可能先落(autonomy-resume H2 在 Windows CI 上偶发「事件链缺 run_end」)。
// 有上限(5s):磁盘真卡住(网络盘/杀软持锁)时不能把整条 run 的收尾一起卡死 —— 那时终稿照落,事件晚到而已。
function flushAgentRunEvents(runId, maxWaitMs = 5000) {
  const chain = agentRunEventChains.get(String(runId || ''));
  if (!chain) return Promise.resolve();
  let timer = null;
  return Promise.race([chain.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, maxWaitMs); })]).finally(() => clearTimeout(timer));
}
// 删除关联记录前排空这条线程已经开始的写入。通过既有生命周期钩子延迟绑定,会话层不引用后加载的写链。
async function flushSessionAgentRuns(sessionId, runIds) {
  const ids = new Set(runIds);
  const files = await fsp.readdir(agentRunDir(sessionId)).catch(() => []);
  for (const file of files) {
    const match = /^(run_[a-f0-9]+)(?:\.json|\.events\.ndjson)$/.exec(file);
    if (match) ids.add(match[1]);
  }
  await Promise.all([...ids].flatMap(id => [agentRunWriteChains.get(id), agentRunEventChains.get(id)]).filter(Boolean).map(chain => chain.catch(() => {})));
};

// ── 116-2b:班组运行的停滞/预算信号 → 两个新的 run 事件 type ──────────────────────────────
// 背景(27 号文 §11.6「116b 登记的缺口」):subagent_no_progress / loop_recovery / 节点级工具迭代
// 预算耗尽此前只有 SSE 事件与审计日志,没有落进 <run>.events.ndjson —— 收件箱只读那三条带 seq 的
// 持久日志,所以"班组还在跑但没往前走"这件事管家永远看不见。这里只【追加】两个 type,既有 22 种的
// 形状与顺序一律不动。
//   run_stalled       : 语义死循环纠偏、子代理无进展计数上报等"还在跑但没往前走"
//   run_budget_tripped: 节点的工具迭代预算(含自适应扩容后的硬顶)耗尽
// data 只放 reason / nodeId / count 一类摘要与引用 id,永不带工具输出正文(与收件箱 payload 同纪律)。
//
// 频控与 02 的 stalled 同口径且共用同一张表:同一 run 五分钟内只落一条 —— 一次纠偏刷一条会把
// 事件文件(增量客户端每 ~2s 轮询一次尾部)撑成噪声源。
function recordRunStalledEvent(run, detail) {
  if (!run || !run.id) return;
  if (!missionSignalThrottleAllow('run:' + String(run.id), MISSION_STALL_SIGNAL_WINDOW_MS)) return;
  const d = (detail && typeof detail === 'object') ? detail : {};
  appendAgentRunEvent(run, {
    type: 'run_stalled',
    ...(d.nodeId ? { nodeId: String(d.nodeId) } : {}),
    data: {
      reason: String(d.reason || ''),
      tool: String(d.tool || ''),
      count: Number(d.count) || 0,
    },
  });
}
// 预算触顶不做时间频控:它是节点级终态(一个节点只可能耗尽一次预算),按节点天然去重。
function recordRunBudgetTrippedEvent(run, detail) {
  if (!run || !run.id) return;
  const d = (detail && typeof detail === 'object') ? detail : {};
  appendAgentRunEvent(run, {
    type: 'run_budget_tripped',
    ...(d.nodeId ? { nodeId: String(d.nodeId) } : {}),
    data: {
      reason: String(d.reason || ''),
      limit: Number(d.limit) || 0,
      hardLimit: Number(d.hardLimit) || 0,
      toolCalls: Number(d.toolCalls) || 0,
    },
  });
}
// 第29波(§29a 增量监控):事件日志读取 —— GET /api/agent-runs/:id/events?afterSeq= 的数据面。事件文件
// append-only 且允许尾行半写(appendFile 非 atomic),读取方逐行 safeJsonParse 跳坏行(readWorkbenchAudit
// 同款纪律);先收集 seq>afterSeq 的行再排序分页 —— 与 syncRunEventSeq 的"取 max 非尾行"同一乱序容错
// 立场,cap 截断永远砍最大的 seq 而不是文件尾(半写恢复后行序理论上可乱)。文件缺失 = 无事件(老 run /
// 事件写失败),返回空数组而非报错 —— 事件是增量信号,快照才是权威状态源,读不到就等下一轮全量兜底。
//
// 【长任务实测/对抗轮 #1 优化】事件文件 append-only 无上限;一个跑数小时、数千次工具调用的自主任务其
// events.ndjson 可达数十 MB,而增量客户端对 live run 每 ~2s 轮询一次本函数。若每次都整文件 readFile+全量
// parse,服务端每 poll 成本 = O(全部历史事件),随任务时长无界增长,长单任务下反而劣于被替换的全量端点
// (wire 已省 ≥80%,但盘/CPU 不可见)。因 seq 单调、需要的永远是尾部(seq>afterSeq),故:小文件整读(便宜、
// 恒完整);大文件只读【尾窗】(afterSeq 单调,稳定轮询的客户端只差几条,尾窗几乎总含所需);仅当尾窗回溯
// 不到 afterSeq+1(冷客户端 / afterSeq=0 遇大文件)才回落全读。尾窗按字节切,首行(半行)丢弃 —— 换行是
// 单字节 0x0A 永不落在 UTF-8 多字节序列中,故第一个 \n 后即合法 UTF-8,无编码撕裂。
const AGENT_RUN_EVENTS_PAGE_MAX = 500;
const AGENT_RUN_EVENTS_TAIL_BYTES = 512 * 1024; // 尾窗/整读阈值:≤此值整读(便宜);> 则只读尾窗(~1300-2600 条,远超稳定轮询所需)
function parseEventWindow(raw, floor, droppedHead) {
  // droppedHead:尾窗从文件中部起,首行是半行,丢弃。返回 {matched(seq>floor), minSeq(窗内最小完整 seq)}。
  const lines = raw.split('\n');
  const start = droppedHead ? 1 : 0;
  const matched = []; let minSeq = Infinity;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim(); if (!t) continue;
    const evt = safeJsonParse(t, null);
    if (!evt || !Number.isFinite(Number(evt.seq))) continue;
    const s = Number(evt.seq);
    if (s < minSeq) minSeq = s;
    if (s > floor) matched.push(evt);
  }
  return { matched, minSeq };
}
async function readAgentRunEvents(sessionId, runId, afterSeq, limit) {
  const cap = Math.max(1, Math.min(AGENT_RUN_EVENTS_PAGE_MAX, Number(limit) || AGENT_RUN_EVENTS_PAGE_MAX));
  const floor = Math.max(0, Number(afterSeq) || 0);
  const file = agentRunEventsFile(sessionId, runId);
  const finish = matched => { matched.sort((a, b) => Number(a.seq) - Number(b.seq)); return { events: matched.slice(0, cap), hasMore: matched.length > cap }; };
  const fullRead = async () => { let raw = ''; try { raw = await fsp.readFile(file, 'utf8'); } catch { return { events: [], hasMore: false }; } return finish(parseEventWindow(raw, floor, false).matched); };
  let size = -1;
  try { size = (await fsp.stat(file)).size; } catch {
    // v1.9 数据管家:事件日志可能已被 gzip 归档(<file>.gz,仅真终态 run)。归档文件不再增长,无尾窗
    // 需求,整体 gunzip 后按全读路径解析;读不到 = 无事件(与原"无文件"语义一致)。
    try {
      const raw = zlib.gunzipSync(await fsp.readFile(file + '.gz')).toString('utf8');
      return finish(parseEventWindow(raw, floor, false).matched);
    } catch { return { events: [], hasMore: false }; }
  }
  if (size <= AGENT_RUN_EVENTS_TAIL_BYTES) return fullRead(); // 小文件整读(恒完整,便宜)
  // 大文件:先只读尾窗;窗回溯到 afterSeq+1 即完整,否则回落全读。
  // 117q-B6(30 号文 P2-10):open/alloc/read/close 收编进 01-config.js 的 readFileTail —— 本处早已按
  // bytesRead 定界(无 bug),这里只是把手写的四步换成共用原语,行为不变。
  try {
    const { buf, bytesRead } = await readFileTail(file, AGENT_RUN_EVENTS_TAIL_BYTES);
    const { matched, minSeq } = parseEventWindow(buf.toString('utf8', 0, bytesRead), floor, true);
    // 窗内最小完整 seq ≤ afterSeq+1 ⇒ 所有 seq>afterSeq 的事件都在窗内(afterSeq+1 是待返回的最小 seq)。
    if (minSeq <= floor + 1) return finish(matched);
    // afterSeq 远落后于尾窗(冷客户端 / afterSeq=0 遇大文件)→ 回落全读(罕见,保正确性)。
  } catch { /* 读尾窗失败 → 回落全读 */ }
  return fullRead();
}
// 第29波(§29c 运营指标):run 级干预计数 —— 用户对 run 的每次手动操作(pause/resume/stop/steer/池审批/
// 重试)自增一格,存 run.metrics.interventions(随快照持久,GET 零改动下发)。无人值守质量的核心度量是
// "干预次数/任务",数据源就在这。防御式初始化:老 run 无 metrics 字段;统计辅助,永不阻断执行。
function bumpRunIntervention(run, kind) {
  try {
    if (!run) return;
    if (!run.metrics || typeof run.metrics !== 'object') run.metrics = {};
    if (!run.metrics.interventions || typeof run.metrics.interventions !== 'object') run.metrics.interventions = {};
    const k = String(kind || 'other');
    run.metrics.interventions[k] = (Number(run.metrics.interventions[k]) || 0) + 1;
    // 对抗轮 P3(#12): 也落审计账 —— buildOpsMetrics 只数 logEvent kind:'intervention',run 级干预此前只进 run.metrics
    // 不进日志,使运营面头条「近 N 天人工干预」对以 DAG 为主的用法恒偏低甚至为 0(与各 run 卡真实累计矛盾)。
    // 两处口径统一到审计账:会话级(permission/plan/steer)与 run 级(pause/resume/stop/steer_node/pool/retry)同源可聚合。
    logEvent({ kind: 'intervention', source: k, sessionId: (run && run.sessionId) || '', runId: (run && run.id) || '' });
  } catch { /* 统计辅助,不阻断执行 */ }
}
// 第29波(§29c):子代理失败文本 → 失败类别。仅用于 runNode 的子代理失败漏斗(错误文本在 runSubAgentCore/
// runClaudeSubAgentOnce 内部拼装,节点层拿不到结构化原因);匹配的全是【本文件自产的固定文案】(权限拒
// 'denied by user'/'blocked by permission mode'、超时等),不是在猜自由文本。其余 error 设置点一律显式标注
// node.errorClass,不走这里。
function classifyNodeErrorText(err) {
  const t = String(err || '');
  if (/denied by user|permission prompt timed out|blocked by permission mode|权限/.test(t)) return 'permission_denied';
  if (/超时|timed? ?out|timeout/i.test(t)) return 'timeout';
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|网络|fetch failed/i.test(t)) return 'network';
  return 'subagent_failed';
}
// 第29波(§29c):run 级 token/成本累计 —— 两引擎子代理收尾时经 subagent_usage 事件上抛(与用量台账同源
// 同值),nodeEvent 累进到 run 上随快照持久。前端 wbRunMetrics/runCostLabel 早已防御性读这些字段(注释
// "后端并行落地中"),写入即点亮,零前端改动。重试的 attempt 各自累计(重试真实花了 token,不去重)。
// 成本只聚合 USD(混币种相加无意义;非 USD 行只计 token 不计成本)。
function accumulateRunUsage(run, u) {
  try {
    if (!run || !u) return;
    if (!run.usageTotals || typeof run.usageTotals !== 'object') run.usageTotals = { inTok: 0, outTok: 0 };
    run.usageTotals.inTok = (Number(run.usageTotals.inTok) || 0) + Math.max(0, Number(u.inTok) || 0);
    run.usageTotals.outTok = (Number(run.usageTotals.outTok) || 0) + Math.max(0, Number(u.outTok) || 0);
    run.totalTokens = run.usageTotals.inTok + run.usageTotals.outTok;
    const c = Number(u.cost);
    if (Number.isFinite(c) && c > 0 && String(u.currency || 'USD').toUpperCase() === 'USD') run.costUsd = Math.round(((Number(run.costUsd) || 0) + c) * 1e6) / 1e6;
  } catch { /* 统计辅助,不阻断执行 */ }
}

// 第25波 25.2(AUTONOMY-PLAN §1 缺口5):快照持久化失败【不得静默】。saveAgentRun 的调用方有多处
// .catch(()=>{})(节流 flush / 资源等待回调等)——磁盘满/杀软长期锁文件时,UI 显示运行中但恢复用的
// 是陈旧状态。这里在写链内计数连续失败:≥3 次标 run.persistenceDegraded(经 GET /api/agent-runs 的
// live 叠加下发 —— 磁盘坏了也能到达 UI);≥8 次对活跃 run 置 paused(停止烧预算,等人处理)。
// 任一次成功即清零并撤旗标(下一次成功写把撤销也落盘)。
const AGENT_RUN_PERSIST_DEGRADED_AFTER = 3;
const AGENT_RUN_PERSIST_PAUSE_AFTER = 8;
const agentRunSaveFailures = new Map(); // runId -> consecutive snapshot-save failures

// Small read-model facts, independent of workflow status. Never carry node text or blocker bodies.
function agentRunHealth(run, live = false) {
  const nodes = Array.isArray(run && run.nodes) ? run.nodes : [];
  const idle = nodes.find(node => node && node.idleAborted === true);
  const blocked = live ? nodes.filter(node => node && node.status === 'waiting_resource' && Array.isArray(node.resourceBlockers) && node.resourceBlockers.length) : [];
  return {
    persistenceDegraded: !!(run && run.persistenceDegraded === true),
    idleAborted: !!(run && run.idleAborted === true) || !!idle,
    idleNodeId: String(idle && idle.id || ''),
    resourceBlockedCount: blocked.length,
    resourceBlockedNodeId: String(blocked[0] && blocked[0].id || ''),
  };
}
const agentRunLastHealth = new Map();
function agentRunHealthChanged(run) {
  const health = agentRunHealth(run, hasLiveRun(run.id));
  const signature = JSON.stringify(health);
  const previous = agentRunLastHealth.get(run.id);
  if (previous === signature) return false;
  if (agentRunLastHealth.size >= 1024 && !agentRunLastHealth.has(run.id)) agentRunLastHealth.clear();
  agentRunLastHealth.set(run.id, signature);
  return previous !== undefined || health.persistenceDegraded || health.idleAborted || health.resourceBlockedCount > 0;
}

const agentRunLastSavedStatus = new Map();   // 128f-⑫:runId -> 上一次落盘时的 status(见 saveAgentRun 里那一段)
async function saveAgentRun(run) {
  if (sessionAssociatedSaveIsTombstoned(run.sessionId)) return;
  // Snapshot at submission time, not when an earlier queued write eventually completes. Without this,
  // a fast node can mutate from running to succeeded before the leading progress save serializes, so the
  // polling UI never observes its intermediate progress even though saveAgentRun was called in time.
  const wasDegraded = run.persistenceDegraded === true;
  if (wasDegraded) run.persistenceDegraded = false;
  run.updatedAt = nowIso();
  const snapshot = JSON.stringify(run, null, 2);
  await runKeyedChain(agentRunWriteChains, run.id, async () => {
    if (sessionAssociatedSaveIsTombstoned(run.sessionId)) return;
    const dir = agentRunDir(run.sessionId);
    await fsp.mkdir(dir, { recursive: true });
    // 25.1: 写体收编 atomicWriteJson —— 旧手写版的 rename 重试参数(8 次,15→155ms;UI 每 ~2s 轮询读者持
    // 句柄致 EPERM/EBUSY,毫秒级即释)就是它的出处;tmp 名从 pid-only 升级为 pid+随机。
    // 对抗轮修: 旗标【先清后写】—— 磁盘恰在终稿写恢复时,旧序(写成功后才清)会把 persistenceDegraded:true
    // 永久钉进最后一份快照(run 已结束,再无下一次写),UI 对一个完好收尾的 run 永远亮红横幅。
    // 先乐观清、写失败在 catch 里按计数恢复,则任何一次成功写落盘的都是干净旗标。
    try {
      const runFile = agentRunFile(run.sessionId, run.id);
      await atomicWriteJson(runFile, snapshot);
      agentRunDigestWriteSeq += 1;
      agentRunDigestCache.delete(runFile); // digest 摘要缓存:进程内写成功即作废该文件条目(见 listAgentRunDigests 头注)
      emit('projection.invalidated', { sessionId: run.sessionId, reason: 'source' }); // 75c: persisted run digest participates in Mission projection
      // 128f-⑫:班组的状态真的换了(跑着/暂停/等池/收尾……)才派一发 —— 左栏行上的「暂停／继续」、焦点栏的班组段读的
      // 都是落盘这一份摘要,而它不经过会话头(13r「会话头落盘即碰一下」那一路盖不到)。节点每一步也会存一次,
      // 那些不换状态的存一帧都不派。暂停是「先回 pausing、跑循环下一拍才真停」,所以派在这里而不是控制路由上。
      const savedStatus = String(run.status || '');
      if (agentRunHealthChanged(run) || agentRunLastSavedStatus.get(run.id) !== savedStatus) {
        if (agentRunLastSavedStatus.size >= 1024 && !agentRunLastSavedStatus.has(run.id)) agentRunLastSavedStatus.clear();
        agentRunLastSavedStatus.set(run.id, savedStatus);
        try { emit('thread.state', { sessionId: run.sessionId }); } catch { /* Observers cannot turn a saved snapshot into a save failure. */ }
      }
      if (agentRunSaveFailures.get(run.id)) agentRunSaveFailures.delete(run.id);
      if (wasDegraded) appendAgentRunEvent(run, { type: 'persistence_recovered' });
    } catch (e) {
      const n = (agentRunSaveFailures.get(run.id) || 0) + 1;
      agentRunSaveFailures.set(run.id, n);
      if (wasDegraded || n >= AGENT_RUN_PERSIST_DEGRADED_AFTER) {
        if (!wasDegraded) appendAgentRunEvent(run, { type: 'persistence_degraded', data: { consecutiveFailures: n, error: String((e && e.message) || e).slice(0, 300) } });
        run.persistenceDegraded = true; // 内存态旗标;GET /api/agent-runs 从 activeAgentRuns 叠加下发
      }
      if (n >= AGENT_RUN_PERSIST_PAUSE_AFTER) {
        const live = getLiveRun(run.id);
        if (live && !live.paused && !live.stopRequested) {
          live.paused = true; live.run.pauseRequestedAt = nowIso();   // 对抗轮修: 与 API pause 同字段(live.run,非 runtime)
          appendAgentRunEvent(run, { type: 'run_paused', data: { reason: 'persistence_degraded', consecutiveFailures: n } });
        }
      }
      // A failed snapshot cannot update the index, but its live failure must still wake global readers.
      if (agentRunHealthChanged(run)) { try { emit('thread.state', { sessionId: run.sessionId }); } catch { /* Keep the original persistence error. */ } }
      throw e;
    }
  });
}
async function listAgentRuns(sessionId) {
  const dir = agentRunDir(sessionId);
  let files = []; try { files = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const file of files.filter(f => /^run_[a-f0-9]+\.json$/i.test(f))) {
    try {
      const run = safeJsonParse(await fsp.readFile(path.join(dir, file), 'utf8'), null);
      if (run) out.push(run);
    } catch { /* skip corrupt/incomplete records */ }
  }
  return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
// ── digest 轮询的磁盘摘要缓存(性能) ─────────────────────────────────────────────────────────────
// GET /api/agent-runs?view=digest 每 ~2s 被前端轮询,而 listAgentRuns 会把该会话【每个 run 快照】整份读盘 +
// JSON.parse 只为取十几个标量(单个终态 run 的 nodes/result/progressLog 动辄 1MB,30 个 run 一次 400-800ms CPU)。
// 这里按【文件】缓存「digest 用得到的标量」:键 = 绝对路径,失效判据 = mtimeMs + size + ino(三者任一变就重读)。
//   · 先 stat 后 read:stat 与 read 之间若被 atomicWriteJson 的 rename 换了新文件,缓存里存的是【新内容 + 旧戳】,
//     下一拍 stat 到新戳与缓存不符就重读 —— 顶多多读一次,绝不会把旧内容钉在新戳下(反过来先 read 后 stat 才会)。
//   · saveAgentRun 在进程内写成功后立刻 delete 该文件的条目:同毫秒同大小的连写(mtime 粒度粗的文件系统)也不会读到旧摘要。
//   · 只缓存标量(见 agentRunDigestShadow),不留整份 run 对象;条目数封顶,满了整表清空(下一拍自然重建)。
//   · 完整视图/其它 listAgentRuns 调用方不走这里,仍读全量,行为不变。
// agentRunDigestStats 是给测试数「读了几个 run 文件」的确定性计数(不靠墙钟)。
const AGENT_RUN_DIGEST_CACHE_MAX = 4096;
const agentRunDigestCache = new Map(); // 绝对文件路径 -> { mtimeMs, ctimeMs, size, ino, shadow|null }
// 进程内每写 / 删一个 run 文件 +1。列举时 stat 之前记下,填缓存之前比一眼:期间有写就不填(审查轮:ino 恒 0、mtime 粒度粗的
// 文件系统上,「stat → 写者 rename + delete 条目 → 列举把旧内容 set 进去」会把旧摘要钉在新戳下,直到下一次写)。
let agentRunDigestWriteSeq = 0;
const agentRunDigestStats = { reads: 0, hits: 0 };
// 磁盘快照里 digest 视图会读到的全部字段(与 13d handleAgentRunApiRoutes 的 digest 逐字段同口径);
// 取值表达式与旧的「(mem || r).xxx」写法一字不差,所以磁盘态的 digest 行与修前逐字节相同。
function agentRunDigestShadow(run) {
  return Object.freeze({
    id: run.id, status: run.status, eventSeq: Number(run.eventSeq) || 0,
    updatedAt: run.updatedAt || '', createdAt: run.createdAt || '', completedAt: run.completedAt || '',
    nodeCount: Array.isArray(run.nodes) ? run.nodes.length : 0,
    poolPending: Array.isArray(run.taskPool) ? run.taskPool.filter(p => p && p.status === 'proposed').length : 0,
    persistenceDegraded: run.persistenceDegraded === true,
    resumeTier: run.resumeTier || '', pendingReview: !!run.pendingReview,
    anyRunning: Array.isArray(run.nodes) && run.nodes.some(n => n && (n.status === 'running' || n.status === 'waiting_resource')),
  });
}
// 与 listAgentRuns 同枚举、同过滤、同排序(createdAt 降序,同值保持 readdir 序),只是返回摘要而非整份 run。
async function listAgentRunDigests(sessionId) {
  const dir = agentRunDir(sessionId);
  let files = []; try { files = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const file of files.filter(f => /^run_[a-f0-9]+\.json$/i.test(f))) {
    const full = path.join(dir, file);
    try {
      const writeSeq = agentRunDigestWriteSeq;
      const st = await fsp.stat(full);
      const hit = agentRunDigestCache.get(full);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.ctimeMs === st.ctimeMs && hit.size === st.size && hit.ino === st.ino) {
        agentRunDigestStats.hits += 1;
        if (hit.shadow) out.push(hit.shadow);
        continue;
      }
      agentRunDigestStats.reads += 1;
      const run = safeJsonParse(await fsp.readFile(full, 'utf8'), null);
      const shadow = run ? agentRunDigestShadow(run) : null;   // 坏/空快照也记一笔(同戳不再重读),与 listAgentRuns 一样跳过
      if (agentRunDigestCache.size >= AGENT_RUN_DIGEST_CACHE_MAX && !agentRunDigestCache.has(full)) agentRunDigestCache.clear();
      if (writeSeq === agentRunDigestWriteSeq) agentRunDigestCache.set(full, { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino, shadow });
      if (shadow) out.push(shadow);
    } catch { agentRunDigestCache.delete(full); /* skip corrupt/incomplete records */ }
  }
  return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
// digest 一行:live 且有内存对象的 run 以【内存】为准(快照节流 1.5s,磁盘恒旧),否则用磁盘摘要。
// r 是 listAgentRunDigests 的摘要,或路由把 live.run 浅展开叠上 live/paused 之后的对象;键序即下发序。
function agentRunDigestRow(r, live) {
  const mem = live && live.run ? live.run : null;
  if (!mem) {
    return {
      id: r.id, status: r.status, eventSeq: r.eventSeq, updatedAt: r.updatedAt, createdAt: r.createdAt, completedAt: r.completedAt,
      nodeCount: r.nodeCount, poolPending: r.poolPending,
      live: !!live, paused: !!(live && live.paused), persistenceDegraded: r.persistenceDegraded,
      resumeTier: r.resumeTier, pendingReview: r.pendingReview, anyRunning: r.anyRunning,
    };
  }
  return {
    id: r.id, status: mem.status, eventSeq: Number(mem.eventSeq) || 0,
    updatedAt: mem.updatedAt || '', createdAt: r.createdAt || '', completedAt: mem.completedAt || '',
    nodeCount: Array.isArray(mem.nodes) ? mem.nodes.length : 0,
    poolPending: (mem.taskPool || []).filter(p => p && p.status === 'proposed').length,
    live: true, paused: !!live.paused, persistenceDegraded: !!mem.persistenceDegraded || r.persistenceDegraded === true,
    resumeTier: mem.resumeTier || '', pendingReview: !!mem.pendingReview,
    anyRunning: Array.isArray(mem.nodes) && mem.nodes.some(n => n && (n.status === 'running' || n.status === 'waiting_resource')),
  };
}

function endRun(runId) { agentRunSaveFailures.delete(runId); }
function invalidateDigest(file) { agentRunDigestWriteSeq += 1; agentRunDigestCache.delete(file); }
return { stats: agentRunDigestStats, agentRunEventsFile, syncRunEventSeq, appendAgentRunEvent, flushAgentRunEvents, flushSessionAgentRuns, recordRunStalledEvent, recordRunBudgetTrippedEvent, parseEventWindow, readAgentRunEvents, bumpRunIntervention, classifyNodeErrorText, accumulateRunUsage, agentRunHealth, agentRunHealthChanged, saveAgentRun, listAgentRuns, agentRunDigestShadow, listAgentRunDigests, agentRunDigestRow, endRun, invalidateDigest };
}
module.exports = { createAgentRunStore };
