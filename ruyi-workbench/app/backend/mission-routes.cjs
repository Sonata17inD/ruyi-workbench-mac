'use strict';

const { apiFailure, apiSessionIdInvalid, apiSessionNotFound, json, readJsonBody, send } = require('./http-protocol.cjs');

// 02 事项容器的稳定信封 error -> HTTP 状态。事项/线程找不到是 404,容量满是 409(可重试的资源
// 约束,不是请求写错了),其余一律 400。表在这里而不在域侧:域函数不认识 HTTP。
function missionContainerHttpStatus(error) {
  if (error === 'not_found' || error === 'session_not_found') return 404;
  if (error === 'capacity_exceeded') return 409;
  return 400;
}
// 失败信封统一走 P2 的 apiFailure(code/params/message)—— 直接把 { ok:false, error:'字符串' } 送进
// json() 会被 normalizeApiErrorPayload 归一成 code:'api.request_failed',错误码就丢了。
const MISSION_FAILURE_PARAM_KEYS = ['limit', 'count', 'missionId', 'sessionId'];
function missionContainerFailure(result) {
  const params = {};
  for (const key of MISSION_FAILURE_PARAM_KEYS) if (result && result[key] !== undefined) params[key] = result[key];
  return apiFailure('mission.' + String((result && result.error) || 'failed'), params,
    String((result && result.message) || ''), missionContainerHttpStatus(result && result.error));
}

function createMissionRoutes({
  tokenOk, safeSessionId, safeDecodeURIComponent, nowIso, activeChildren, activeAgentRuns,
  STEWARD_SESSION_ID, stewardThreadStateRank, stewardThreadStateFromCard, stewardThreadTurnQueued,
  buildMissionAggregateRows, overlayMissionAggregateFields, missionControlCommand, missionControlView,
  membership: { createMissionContainer, patchMissionContainer, missionAttachThread, missionDetachThread, missionMergeInto, missionSplitThreads },
  sessions: {
    loadSession, sessionMissionId, readMissionChangesWithMeta, readMissionContainer, missionContainerAcceptanceStamp,
    listAgentRuns, buildMissionAcceptanceProjection, foldTurnSummaries, journalReadIndex, sessionKind,
  },
  projection: {
    getPretenderProjectionIndex, overlayMissionCard, paginatePretenderProjection, pretenderEtag, pretenderLiveOverlayRevision,
    pretenderNotModified, pretenderIndexMeta, emptyMissionUsage, missionPendingCounts, missionCardStatus, missionRunDigest,
  },
}) {
  async function handleMissionsApiRoutes(req, res, pathname) {
    // 75c:列表走可删物化索引。冷读验证/重建权威源，热读只叠加 live overlay；cursor 携带 revision，
    // 跨页期间事实变化返回 409 snapshot_changed，绝不静默漏项/重复。
    if (req.method === 'GET' && pathname === '/api/missions') {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const index = await getPretenderProjectionIndex();
      // 116g:只加字段 —— 行仍然是【线程行】(每个 mission 会话一张卡),既有字段与顺序逐字节不变,
      // 追加的是这条线程所属【事项】的聚合事实(aggregateState/threadCount/acceptance/cost/budget/derived)。
      const aggregate = await buildMissionAggregateRows();
      const overlayAt = nowIso();   // 与聚合装配同理:整张列表共用一个叠加时刻,不再逐行取一次
      const missions = index.sessions.filter(row => row.card && String(row.sessionId || '') !== STEWARD_SESSION_ID)   // 走查 U3:管家自己的会话不是任务,不进左栏
        .map(row => overlayMissionAggregateFields(overlayMissionCard(row, overlayAt), aggregate.rowBySessionId.get(row.sessionId)));
      // 117s-A D1(§11.13 ③):看板正文读的就是这一份行序(steward-board.js 的 groupRows() 按
      // missionId 首次出现的先后定组序、组内按行序)—— 设计页只点了 buildMissionAggregateRows 里的
      // 那两处排序,但那一份是给 steward_missions 工具面消费的;**看板真正吃的是这一行**,所以三处
      // 一起改,否则「在跑的排最前」在工具面成立、在用户眼前的看板上不成立。
      // 排序键四段,一段都不能省:
      //   ① 组的秩(aggregateState;overlayMissionAggregateFields 两个分支都已挂上它);
      //   ② 组的 updatedAt 降序 —— 取【同组各行 updatedAt 的最大值】,与修前「组序由它最新的那条线程
      //      决定」逐字同义(修前没有显式组序,组序就是第一条落在组里的行的位置);
      //   ③ 组内线程的秩(从叠加过 live 层的卡片现算,与看板自己 MissionState.fromCard(row) 同源);
      //   ④ 线程 updatedAt 降序,末位 sessionId 兜确定性。
      // 一二段在前保证【组仍然是连续的】—— 少了它,一条 needs_you 的线程会把它所在的组劈成两半。
      const groupRank = new Map();     // missionId -> 组秩(取组内最小秩,即最高优先级)
      const groupUpdated = new Map();  // missionId -> 组内最大 updatedAt
      const threadRank = new Map();    // sessionId -> 线程秩
      for (const row of missions) {
        const mid = String(row.missionId || row.sessionId || '');
        const rank = stewardThreadStateRank(stewardThreadStateFromCard(row).state);
        threadRank.set(String(row.sessionId || ''), rank);
        const own = stewardThreadStateRank(row.aggregateState);
        groupRank.set(mid, Math.min(groupRank.has(mid) ? groupRank.get(mid) : own, own));
        const at = String(row.updatedAt || '');
        if (!groupUpdated.has(mid) || at > groupUpdated.get(mid)) groupUpdated.set(mid, at);
      }
      const gid = row => String(row.missionId || row.sessionId || '');
      missions.sort((a, b) => (groupRank.get(gid(a)) - groupRank.get(gid(b)))
        || String(groupUpdated.get(gid(b))).localeCompare(String(groupUpdated.get(gid(a))))
        || String(gid(a)).localeCompare(String(gid(b)))
        || (threadRank.get(String(a.sessionId)) - threadRank.get(String(b.sessionId)))
        || String(b.updatedAt).localeCompare(String(a.updatedAt))
        || String(a.sessionId).localeCompare(String(b.sessionId)));
      // ?sessionIds=a,b,c:只要这几条的卡片(侧栏搜索命中了、但不在它已经取到的那一页里的会话 —— 左栏只取最新
      // 200 条,修前更早的会话搜得到也显示不出来)。只认合形的 id,最多 60 条;不分页、不参与 304。
      const wanted = String(new URL(req.url, 'http://x').searchParams.get('sessionIds') || '').split(',').map(id => safeSessionId(id.trim())).filter(Boolean).slice(0, 60);
      if (wanted.length) {
        const set = new Set(wanted);
        return send(res, json({ ok: true, missions: missions.filter(row => set.has(String(row.sessionId || ''))), projectionRevision: index.missionsRevision }));
      }
      const paged = paginatePretenderProjection(req, 'missions', index.missionsRevision, missions);
      if (paged.response) return send(res, paged.response);
      // 用量修订号挂在【最后】一段:前面三段(修订号 - 在场覆盖 - 行指纹)的段位有测试按位读(steward-thread-order ⑪)。
      const etag = pretenderEtag('missions', index.missionsRevision + '-' + pretenderLiveOverlayRevision() + '-' + aggregate.stamp + '-' + (index.missionsUsageRevision || ''), paged.page);
      if (pretenderNotModified(req, etag)) return send(res, { status: 304, headers: { etag }, body: '' });
      return send(res, json({
        ok: true,
        missions: paged.items,
        page: paged.page,
        nextCursor: paged.page.nextCursor,
        projectionRevision: index.missionsRevision,
        index: pretenderIndexMeta(index),
      }, 200, { etag }));
    }
    // ── 第 116 波 116g(27 号文 §3.1):事项容器的写面。五条路由,全部 token 门(01b 的
    // `POST /api/missions` 与 `PATCH /api/missions/` 两条新登记 + 既有 `POST /api/missions/` 前缀条)。
    // 幂等一律靠子操作本身幂等(attach/detach/去重/归档),不靠"是否做过"的标记位 —— 标记位会在
    // 崩溃窗口里说谎,幂等的子操作不会。
    if (req.method === 'POST' && pathname === '/api/missions') {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const body = await readJsonBody(req);
      const result = await createMissionContainer(body || {});
      return send(res, result.ok ? json(result, 201) : missionContainerFailure(result));
    }
    // 事项级字段(title/goal/acceptance/budget)的【唯一】写入口。会话头里的 head.mission 不受影响。
    if ((req.method === 'PATCH' || (req.method === 'POST' && req.headers['x-http-method'] === 'PATCH')) && pathname.match(/^\/api\/missions\/([^/]+)$/)) {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const missionId = safeSessionId(pathname.split('/')[3]);
      if (!missionId) return send(res, missionContainerFailure({ error: 'invalid_request', message: 'invalid missionId' }));
      const body = await readJsonBody(req);
      const result = await patchMissionContainer(missionId, body || {});
      return send(res, result.ok ? json(result) : missionContainerFailure(result));
    }
    // 线程加入 / 移出。attach 把会话头 missionId 改为目标事项(经 updateSessionMeta,享受 116-2a 的
    // 活回合竞态防护)并写反向索引;detach 恢复 missionId === sessionId(未归类)。
    if (req.method === 'POST' && pathname.match(/^\/api\/missions\/([^/]+)\/threads$/)) {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const missionId = safeSessionId(pathname.split('/')[3]);
      if (!missionId) return send(res, missionContainerFailure({ error: 'invalid_request', message: 'invalid missionId' }));
      const body = await readJsonBody(req);
      const action = String((body && body.action) || '');
      if (action !== 'attach' && action !== 'detach') {
        return send(res, missionContainerFailure({ error: 'invalid_request', message: "action must be 'attach' or 'detach'" }));
      }
      const result = action === 'attach'
        ? await missionAttachThread(missionId, body && body.sessionId)
        : await missionDetachThread(missionId, body && body.sessionId);
      return send(res, result.ok ? json(result) : missionContainerFailure(result));
    }
    // 合并:from 的全部线程搬到目标、验收项按文本去重并入、from 标 archivedAt。再合一次零变化。
    if (req.method === 'POST' && pathname.match(/^\/api\/missions\/([^/]+)\/merge$/)) {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const missionId = safeSessionId(pathname.split('/')[3]);
      if (!missionId) return send(res, missionContainerFailure({ error: 'invalid_request', message: 'invalid missionId' }));
      const body = await readJsonBody(req);
      const result = await missionMergeInto(missionId, body && body.from);
      return send(res, result.ok ? json(result) : missionContainerFailure(result));
    }
    // 拆分:把指定线程拆到一个新事项。幂等键 = 同一组 sessionIds 已完整落在同名未归档事项里。
    if (req.method === 'POST' && pathname.match(/^\/api\/missions\/([^/]+)\/split$/)) {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const missionId = safeSessionId(pathname.split('/')[3]);
      if (!missionId) return send(res, missionContainerFailure({ error: 'invalid_request', message: 'invalid missionId' }));
      const body = await readJsonBody(req);
      const result = await missionSplitThreads(missionId, body && body.sessionIds, body && body.title);
      return send(res, result.ok ? json(result) : missionContainerFailure(result));
    }
    // 第79波:确定性回来摘要数据面。只返回严格位于 (after,currentRevision] 的原始变更记录；
    // migration prefix、损坏行、内部/尾部缺号都以 degraded+gap 明示，客户端不得推进 lastSeen。
    if (req.method === 'GET' && /^\/api\/missions\/[^/]+\/changes$/.test(pathname)) {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const sessionId = safeSessionId(pathname.split('/')[3]);
      if (!sessionId) return send(res, apiSessionIdInvalid());
      const query = new URL(req.url, 'http://x').searchParams;
      const after = Number(query.get('after'));
      if (!Number.isSafeInteger(after) || after < 0) return send(res, json({ ok: false, error: 'after must be a non-negative integer' }, 400));
      const session = await loadSession(sessionId);
      if (!session) return send(res, apiSessionNotFound());
      // 117m-A3(用户第六轮走查④「交办台点开,显示报错」):线程 kind:'mission' 而 mission:null 是【合法状态】
      // —— 管家刚开的线程还没有任何变更账本。修前这里 404 'mission not found',而交办台详情是一个
      // Promise.all(详情 + 两次 changes),一挂就把整块面板换成错误卡(用户截图里那张)。把「还没有变更」
      // 说成「找不到事项」是判据错位:找不到的是账本,不是事项,而空账本本来就该回一份空清单。
      // 只放宽这一种情形(会话在、账本空);会话不存在仍旧 404。
      if (!session.mission) {
        return send(res, json({
          ok: true, missionId: sessionMissionId(session), sessionId,
          fromRevision: after, currentRevision: 0, baseRevision: 0,
          changes: [], degraded: false, gap: null,
          integrity: { corruptLines: 0, lastRevision: 0 },
        }));
      }
      const currentRevision = Math.max(0, Number(session.mission.changeSeq) || 0);
      const folded = await readMissionChangesWithMeta(sessionId, currentRevision);
      let gap = folded.gap;
      if (!gap && after < folded.baseRevision) gap = { expected: after + 1, actual: folded.baseRevision + 1, prefix: true };
      if (!gap && after > currentRevision) gap = { expected: currentRevision, actual: after, ahead: true };
      const degraded = folded.degraded || Boolean(gap);
      return send(res, json({
        ok: true,
        missionId: sessionMissionId(session),
        sessionId,
        fromRevision: after,
        currentRevision,
        baseRevision: folded.baseRevision,
        changes: folded.records.filter(record => Number(record.seq) > after && Number(record.seq) <= currentRevision),
        degraded,
        gap: gap || null,
        integrity: { corruptLines: folded.corruptLines, lastRevision: folded.lastRevision },
      }));
    }
    // 第84波:Mission 控制面。动作作用域由 missionControlCommand 单一核心冻结；本路由只做
    // missionId/sessionId 解析与 HTTP 适配，经典 /api/mission stop 也复用同一核心。
    if (req.method === 'POST' && /^\/api\/missions\/[^/]+\/control$/.test(pathname)) {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const sessionId = safeSessionId(pathname.split('/')[3]);
      if (!sessionId) return send(res, apiSessionIdInvalid());
      const body = await readJsonBody(req);
      const result = await missionControlCommand(sessionId, body && body.action, body && body.prompt);
      return send(res, json(result.body, result.status));
    }
    // 详情:单会话稳定任务快照(EC-E:mission + Agent Run + 产物 + 变更 + 检查点 + 用量 + 游标)。
    // 只认 /api/missions/<一段>(与 13d 单条会话路由同一个口径):修前是 startsWith + path.basename,
    // /api/missions/随便/什么/<id> 与 /api/missions/<id>/ 都被当成 <id>,以后加 GET 子路由会被这里先吞掉。
    const missionDetail = req.method === 'GET' ? pathname.match(/^\/api\/missions\/([^/]+)$/) : null;
    if (missionDetail) {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const sessionId = safeSessionId(safeDecodeURIComponent(missionDetail[1]) || '');
      if (!sessionId) return send(res, apiSessionIdInvalid());
      const index = await getPretenderProjectionIndex();
      const indexed = index.sessions.find(row => row.sessionId === sessionId) || null;
      // 124-P1:详情自此带着【事项容器】那一套验收项(「人工复核」那一档),容器是另一份文件,
      // 它变了不会动会话投影的 revision —— 指纹不带上它,勾完验收项的下一拍就是 304 + 陈旧验收。
      // 容器是小 JSON,304 这条路上多读它一次,换的是不说谎(指纹判据单点住在 02)。
      // 未归类线程(missionId === sessionId)天然没有事项文件 —— 事项 id 一律 `mission_<hex>`(02 的
      // safeMissionId 头注),与 `sess_` 分家,所以那一档连读都不用读(抽屉是轮询的,省的是每一拍一次
      // ENOENT)。归类过的才去读那份小 JSON。
      const containerId = (indexed && indexed.missionId && indexed.missionId !== sessionId) ? indexed.missionId : '';
      const container = containerId ? await readMissionContainer(containerId).catch(() => null) : null;
      const etag = indexed ? pretenderEtag('mission', indexed.revision + '-' + pretenderLiveOverlayRevision(sessionId) + '-' + missionContainerAcceptanceStamp(container)) : '';
      if (etag && pretenderNotModified(req, etag)) return send(res, { status: 304, headers: { etag }, body: '' });
      const session = await loadSession(sessionId);
      if (!session) return send(res, apiSessionNotFound());
      const runs = await listAgentRuns(sessionId).catch(() => []);

      // 验收投影(124-P1):里程碑计数与 items 形状一个字不动,另带「这条是谁判的」四态、机器检查的
      // 实情(没跑过 / 最近一次没通过 —— J08)、事项容器那一套(人工复核)与「有没有账本」。判据单点
      // 住在 02 的 buildMissionAcceptanceProjection,本路由只负责把两份数据喂进去。
      // indexed 缺失(会话还没进投影索引)时上面那次容器读不到,这里按会话头里的 missionId 补一次。
      const headMissionId = sessionMissionId(session);
      const acceptanceContainer = container
        || (headMissionId && headMissionId !== sessionId ? await readMissionContainer(headMissionId).catch(() => null) : null);
      const acceptance = buildMissionAcceptanceProjection(session.mission, acceptanceContainer);

      // 变更/产物聚合:跨回合 turnSummary 折叠(02 foldTurnSummaries 单一实现,与 buildMissionResult 共用) ——
      // filesChanged 按 path 后写胜(最新 op/revertible 为当前态),artifacts 按 path 先去重(首次产出记回合)。
      // revertible=false 即不可逆显式标注(journal skipped 或天生不在账内)。
      // 第72波顺手修:旧内联折叠 `commands += (ts.commands || []).length` 把数字当数组,commands>0 即 NaN
      // (JSON 序列化为 null)——统一走 fold 后该 bug 消失;irreversible 正向账随行,旧回合(无该字段)的
      // commands 诚实单列 legacyCommands,不混进新账假装有据。
      const fold = foldTurnSummaries(session);
      const filesChangedList = fold.filesChanged, artifactsList = fold.artifacts, commands = fold.commands;

      // 检查点引用(真实回滚能力的入口:POST /api/checkpoints/rollback {sessionId, turnSeq, entrySeq?})。
      const cpEntries = await journalReadIndex(sessionId).catch(() => []);
      const cpTurnSeqs = [...new Set(cpEntries.map(e => e && e.turnSeq).filter(Number.isFinite))].sort((a, b) => a - b);
      const checkpoints = {
        entries: cpEntries.length,
        turnSeqs: cpTurnSeqs,
        totalBytes: cpEntries.reduce((s, e) => s + (Number(e && e.bytes) || 0), 0),
        rollbackAvailable: cpEntries.length > 0,
      };
      // 第84波台账时间轴:直接投影 checkpoint journal，不从摘要猜「可回退」。被跳过的大文件与不在
      // journal 中的变更诚实列入不可回退区；最多下发最近 200 条，长任务的详情响应保持有界。
      const checkpointKeys = new Set(cpEntries.map(entry => `${Number(entry && entry.turnSeq)}:${Number(entry && entry.entrySeq)}:${String(entry && entry.path || '')}`));
      // skipped:true 已在 checkpoint row 自身标成不可回退；这里只补「摘要里有、journal 里没有」的变更，
      // 避免同一大文件既算 skipped row 又算 nonRevertibleFile 而把不可退计数翻倍。
      const nonRevertibleFiles = filesChangedList.filter(file => file
        && !checkpointKeys.has(`${Number(file.turnSeq)}:${Number(file.entrySeq)}:${String(file.path || '')}`));
      const ledgerEntries = cpEntries.slice(-200).map(entry => ({
        turnSeq: Number(entry && entry.turnSeq) || 0,
        entrySeq: Number(entry && entry.entrySeq) || 0,
        path: String(entry && entry.path || ''),
        op: String(entry && entry.op || ''),
        tool: String(entry && entry.tool || ''),
        bytes: Math.max(0, Number(entry && entry.bytes) || 0),
        ts: String(entry && entry.ts || ''),
        revertible: !(entry && entry.skipped),
        reason: entry && entry.skipped ? 'content_too_large' : '',
      }));
      const reversibleEntries = ledgerEntries.filter(entry => entry.revertible).length;
      const recoveryBlockers = ledgerEntries.filter(entry => !entry.revertible).length + nonRevertibleFiles.length
        + fold.irreversible.total + fold.irreversible.legacyCommands;
      const controls = missionControlView(session, { checkpointEntries: cpEntries, runs });
      const ledger = {
        entries: ledgerEntries,
        truncated: cpEntries.length > ledgerEntries.length,
        totalEntries: cpEntries.length,
        nonRevertibleFiles: nonRevertibleFiles.slice(-80),
        irreversible: { items: fold.irreversible.items.slice(-80), legacyCommands: fold.irreversible.legacyCommands, ...(fold.irreversible.incomplete ? { incomplete: true } : {}) },
        rollbackTargetTurnSeq: controls.rollbackTargetTurnSeq,
        recoverability: reversibleEntries === 0 ? 'none' : (recoveryBlockers > 0 ? 'partial' : 'full'),
        reversibleEntries,
        nonRevertibleEntries: recoveryBlockers,
      };

      // 用量切片:append-only 月度账本按 sessionId 过滤(权威存储,session 对象上无聚合字段)。
      const usage = indexed && indexed.usage ? indexed.usage : emptyMissionUsage();

      // 游标:增量消费的位置令牌 —— 会话 turnSeq(单调不回绕)+ 各 run 事件流 eventSeq(严格单调,afterSeq 补播)。
      const cursor = {
        turnSeq: Number(session.turnSeq) || 0,
        runs: Object.fromEntries(runs.map(r => [r.id, Number(r && r.eventSeq) || 0])),
        projectionRevision: indexed ? indexed.revision : '',
        snapshotAt: nowIso(),
      };
      const pendingCounts = await missionPendingCounts(sessionId, runs, indexed && indexed.interventions);

      return send(res, json({
        ok: true,
        snapshot: {
          sessionId, missionId: sessionMissionId(session), kind: sessionKind(session), title: session.title || '', summary: session.summary || '',
          cwd: session.cwd || '', createdAt: session.createdAt || '', updatedAt: session.updatedAt || '',
          status: missionCardStatus(session.mission),
          activeTurn: activeChildren.has(sessionId), // 第56波:活回合标志(五态派生的「进行中」权威信号之一,与 run.live 同型内存叠加)
          queued: stewardThreadTurnQueued(sessionId), // hunt3:回合在仲裁器里排队(前端 fromSnapshot 读它,同 activeTurn 一档)
          mission: session.mission || null,
          acceptance,
          // 班组图只需最近 6 轮；更旧历史仍保留标量 digest，可在经典工作台查看完整节点。
          runs: runs.map((run, index) => missionRunDigest(run, true, index < 6)),
          changes: { filesChanged: filesChangedList, artifacts: artifactsList, commands },
          // 第72波:不可逆操作正向账(活任务也随快照下发;终态任务以 mission.result 盖章版为准)
          irreversible: { total: fold.irreversible.total, byKind: fold.irreversible.byKind, items: fold.irreversible.items.slice(-30), legacyCommands: fold.irreversible.legacyCommands, ...(fold.irreversible.incomplete ? { incomplete: true } : {}) },
          // 第72波:任务结果快照(终态盖章;active/paused 为 null,看 acceptance/changes/irreversible 实时投影)
          result: (session.mission && session.mission.result) || null,
          // 历史轮次验收报告(next_turn/retry/rollback/再武装前归档的旧 result,有界 last 10)
          resultHistory: Array.isArray(session.mission && session.mission.resultHistory) ? session.mission.resultHistory : [],
          checkpoints,
          controls,
          ledger,
          usage,
          pending: pendingCounts,
          cursor,
          projectionRevision: indexed ? indexed.revision : '',
          freshness: {
            persistentRevision: indexed ? indexed.revision : '',
            indexedAt: indexed ? indexed.indexedAt : '',
            liveOverlay: activeChildren.has(sessionId) || runs.some(r => activeAgentRuns.has(r.id)),
            overlayAt: nowIso(),
          },
        },
        index: pretenderIndexMeta(index),
      }, 200, etag ? { etag } : {}));
    }
    return false;
  }

  return handleMissionsApiRoutes;
}

module.exports = { createMissionRoutes };
