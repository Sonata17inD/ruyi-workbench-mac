const { sessionSearchScope, searchSessionsByContent } = require('./backend/session-search.cjs').createSessionSearch({
  paths, nowIso, atomicWriteJson, sessionBodyPaths, sessionBriefOf, listSessions,
});

const { sessionEnvelopeStamp, sessionEnvelopeEtag, sessionEnvelopeLiveParts } =
  require('./backend/session-envelope.cjs').createSessionEnvelope({
    paths, safeSessionId, sessionPath, sessionBodyPaths, pretenderEtag, pretenderHash, StewardHooks,
    execution: { activeChildren, activeAgentRuns, turnSettlers, sessionExecutionSnapshot, sessionExecutionObservation },
    overrides: { sessionPermissionModeOverrides, sessionDesktopToolsOverrides },
  });

const { sessionBackgroundRunRows, agentRunActionCommand } = require('./backend/agent-run-control.cjs').createAgentRunControl({
  activeAgentRuns, safeSessionId, redact, nowIso, STEER_QUEUE_MAX,
  appendAgentRunEvent, saveAgentRun, bumpRunIntervention, launchPersistedAgentRun, nodeDeliveryEligibility,
});

const handleSessionApiRoutes = require('./backend/session-routes.cjs').createSessionRoutes({
  tokenOk, safeSessionId, safeDecodeURIComponent, readConfig, logEvent, PrivacyGateway, STEWARD_SESSION_ID,
  resolveContainmentPath, pretenderNotModified, searchSessionsByContent,
  execution: { sessionExecutionSnapshot, sessionExecutionObservation, EventStreamHooks, sessionBackgroundRunRows, agentRunActionCommand },
  envelope: { sessionEnvelopeStamp, sessionEnvelopeEtag, sessionEnvelopeLiveParts },
  sessions: {
    listSessions, createSession, readSessionHeadResilient, loadSession, updateSessionMeta, sessionMeta,
    SESSION_LOAD_OMIT_PROVIDER, sessionOmittedProviderHistory, sessionMessagesDelta, sessionProviderHistoryLength,
    detectDanglingTurn, sessionDisplayTitle, sessionDesktopToolsOf, bulkDeleteUnpinnedSessions, deleteSession,
  },
});

// ── 第 116 波 116g(27 号文 §3.1 / §8.10):事项级聚合读模型 ─────────────────────
// 一处装配,两处消费(GET /api/missions 的只加字段、13g 的 steward_missions 工具)。纪律与 70 波
// /api/missions 同源:**纯读模型** —— 线程五态取投影 card(与看板逐字节同源),事项级状态只经 06i 的
// `aggregateMissionState` 纯函数,绝不在这里另写一份判据;没有事项文件的 missionId 按需派生
// (`derived:true`,标题取会话标题),不落盘、不回写、不迁移。

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

function emptyMissionCostBucket() {
  return { turns: 0, inTok: 0, outTok: 0, cachedInTok: 0, costsByCurrency: {} };
}
function addMissionCostBucket(bucket, usage) {
  if (!usage || typeof usage !== 'object') return bucket;
  bucket.turns += Number(usage.turns) || 0;
  bucket.inTok += Number(usage.inTok) || 0;
  bucket.outTok += Number(usage.outTok) || 0;
  bucket.cachedInTok += Number(usage.cachedInTok) || 0;
  for (const [currency, amount] of Object.entries(usage.costsByCurrency || {})) {
    if (!Number.isFinite(Number(amount))) continue;
    bucket.costsByCurrency[currency] = Math.round(((bucket.costsByCurrency[currency] || 0) + Number(amount)) * 1e6) / 1e6;
  }
  return bucket;
}

// 测试用确定性计数(不靠墙钟):workspaceComputed = 真正跑了一次「工作区归属判定」的次数(同 cwd 一次装配内只算一次)。
const missionAggregateStats = { workspaceComputed: 0 };
async function buildMissionAggregateRows(options = {}) {
  const includeArchived = options.includeArchived === true;
  // W7(用户 2026-09-24「管家需要把工作区和任务联系起来」):事项与线程的读模型把【工作区】带出去 ——
  // 只加字段。事项的工作区 = 事项容器记着的那个(13k 在事项第一次有了工作区时记下),没有就取组里
  // 最近动过的那条线程的目录。ruyiOwned 的判据单点在 06i 的 stewardRuyiOwnedPath(数据根里的、或如意
  // 为任务开的而用户没收编的),要配置里那张表 —— 调用方有现成的就传 options.config,省一次读盘。
  const wsConfig = (options.config && typeof options.config === 'object') ? options.config : await readConfig().catch(() => null);
  // 性能:2000 条线程只有寥寥几个不同的 cwd,而 stewardRuyiOwnedPath(逐字符归一 + 数据根前缀比较)与
  // dataRootAliases()(取数据根、比对别名)此前在【每条线程 + 每个事项组】各算一遍,一次 GET /api/missions
  // 约 4000 次,占去 37% CPU。本次装配内 wsConfig / paths.data / 别名都是定值,所以别名提到函数头只取一次,
  // 并按 cwd 记下 { name, ruyiOwned }(纯函数,同 cwd 同答案);每次仍返回【新对象】,调用方改它不会串行。
  const dataRootPath = paths.data;
  const dataRootAliasList = dataRootAliases();
  const workspaceMemo = new Map();   // 修剪后的 cwd -> { name, ruyiOwned }
  const workspaceOf = cwd => {
    const p = String(cwd || '').trim();
    if (!p) return null;
    let known = workspaceMemo.get(p);
    if (!known) {
      known = { name: path.basename(p.replace(/[\\/]+$/, '')) || p, ruyiOwned: stewardRuyiOwnedPath(p, wsConfig, dataRootPath, dataRootAliasList) };
      workspaceMemo.set(p, known);
      missionAggregateStats.workspaceComputed += 1;
    }
    return { path: p, name: known.name, ruyiOwned: known.ruyiOwned };
  };
  const overlayAt = nowIso();   // 一次装配只取一次「叠加时刻」:每行各取一次是 2000 次 Date + toISOString,而它们本就是同一个请求
  const index = await getPretenderProjectionIndex().catch(() => null);
  const slices = new Map(((index && index.sessions) || []).map(row => [row.sessionId, row]));
  const metas = await listSessions().catch(() => []);          // 管家会话已在 listSessions 里滤掉
  const containers = await listMissionContainers().catch(() => []);
  const containerById = new Map(containers.map(row => [row.missionId, row]));
  const byMissionId = new Map();

  const ensure = (missionId, container) => {
    let group = byMissionId.get(missionId);
    if (!group) byMissionId.set(missionId, group = { missionId, container: null, threads: [], cost: emptyMissionCostBucket() });
    if (container && !group.container) group.container = container;
    return group;
  };
  for (const container of containers) {
    if (container.archivedAt && !includeArchived) continue;
    ensure(container.missionId, container);
  }
  for (const meta of metas) {
    const missionId = meta.missionId || meta.id;
    const container = containerById.get(missionId) || null;
    if (container && container.archivedAt && !includeArchived) continue;
    const group = ensure(missionId, container);
    const slice = slices.get(meta.id) || null;
    const card = slice ? overlayMissionCard(slice, overlayAt) : null;
    // 五态的三条取值路径,与 13g steward_thread_status 逐字一致(同一条线程在看板与管家里必须同色):
    //   ① 有投影卡片 -> fromCard(与 /api/missions 的卡片同源);
    //   ② 没卡片但是 mission 会话(投影还没赶上这条新会话)-> 按会话头现算,入参与 thread_status 相同
    //      —— 少喂 turnSeq 会把一条跑过回合的线程说成「交办中」,和 thread_status 的「已停工」打架;
    //   ③ 其余会话(= 用户自己在经典 2.0 里聊的普通会话)-> 【刻意不读会话头】以省 I/O,
    //      所以这一支手上一条事实都没有,明说 factsUnknown:true 让判据短路成「事实未知」。
    //      117r-D5 之前这里靠的是 kind === 'quick_ask' 那条守卫,出参完全一样(仍是 quick_ask、
    //      聚合仍落 stopped),变的只是【为什么】短路 —— 从「它是速查」变成「我不知道它在干什么」。
    //      对应地:①支里的速查线程(D1 之后它有卡片、有事实)不再被这条守卫劫走,走完整五态。
    let derived;
    // 124 还债①（40 号文 §8.5 ①）：这条线程有没有【自己的验收账本】（`session.mission`）。
    // 判据与 13g `thread_status` / 13h 总览同一条：卡片侧 `card.status === 'none'` ⇔ 头上没有
    // mission 容器（§6-ter 的 `ledgerless` 写的就是这两句的两种写法），不许拿
    // `milestonesTotal === 0` 之类的近似顶替。
    // 第三支（普通会话）刻意不读会话头以省 I/O —— 而 mission 账本只可能挂在 mission 会话上，
    // 所以那一支恒为 false：这不是猜，是定义。
    let threadLedger = false;
    if (card) { derived = stewardThreadStateFromCard(card); threadLedger = String(card.status || '') !== 'none'; }
    else if (meta.kind === 'mission') {
      const head = await readMissionSessionHead(meta.id);
      threadLedger = !!(head && head.mission);
      // 会话头这一支与 13k thread_status / 13o 总览 / 13r 事件流同一个适配器(06i stewardThreadStateFromHead)。
      derived = stewardThreadStateFromHead(head, {
        kind: 'mission',
        pending: await missionPendingCounts(meta.id, [], null).catch(() => null),
        activeTurn: activeChildren.has(meta.id),
        runCount: 0,
      });
    } else derived = deriveStewardThreadState({ kind: 'quick_ask', factsUnknown: true });
    // 124 还债①：组级两个事实在这一处累计（前端不再自己推）——
    //   · anyLedger：组里任一条线程带账本；
    //   · anyMission：这一组里有真正的【事项线程】（未归类事项没有容器，只能靠它认出来）。
    group.anyLedger = group.anyLedger === true || threadLedger;
    group.anyMission = group.anyMission === true || meta.kind === 'mission';
    group.threads.push({
      sessionId: meta.id,
      title: stewardSanitizeText(meta.title || ''),
      // 116-5b:同 buildMissionCard —— title 仍是原话,显示名另给一个键(steward_missions 的线程清单、
      // 抽屉页签、看板行都读它)。meta 是索引条目形态(brief/titleSource),sessionDisplayTitle 两形态都认。
      displayTitle: stewardSanitizeText(sessionDisplayTitle(meta)),
      ...(sessionBriefOf(meta) ? { brief: sessionBriefOf(meta) } : {}),
      kind: meta.kind || 'quick_ask',
      state: derived.state,
      stateLabel: derived.label,
      permissionMode: meta.permissionMode || null,
      lastAssistantText: stewardSanitizeText(meta.summary || '').slice(0, 120),
      updatedAt: String(meta.updatedAt || ''),
      cwd: String(meta.cwd || ''),   // W7:这条线程开在哪个目录(事项的 workspace 从这里派生)
      workspace: workspaceOf(meta.cwd),
      // 116h(§8.10「排队可解释」):等待原因由 06i 的 waitReasonFor 单点判定,与 steward_thread_status /
      // 总览行 / steward_missions 同一函数同一形状。pending 用上面五态判据已经算好的那一份(少喂一次
      // 就会出现 116g 那种「看板与 thread_status 各说各话」);仲裁器一侧同步只读,开关关时恒为 null。
      wait: waitReasonFor(
        { pending: (derived.sources && derived.sources.pendingTotal) || 0 },
        typeof StewardHooks.arbiterWait === 'function' ? StewardHooks.arbiterWait(meta.id) : null,
      ),
    });
    addMissionCostBucket(group.cost, slice && slice.usage);
  }

  const rows = [];
  const rowBySessionId = new Map();
  for (const group of byMissionId.values()) {
    const container = group.container;
    const acceptanceItems = container ? container.acceptance : [];
    // 117s-A D1(§11.13 ③):组内线程改成「状态秩优先、其次 updatedAt 降序」。秩由 06i 的
    // stewardThreadStateRank 单点给(needs_you > running > dispatching > done/stopped),
    // 状态本身仍是上面那三条取值路径算出来的那一个 —— 这里【不】重新判定任何状态。
    // 末位补 sessionId 是为了确定性:两条线程秩与 updatedAt 都相同时,行序不该随 listSessions
    // 的目录枚举顺序漂移(夹具与 ETag 都指望同样的输入给同样的行序)。
    group.threads.sort((a, b) => stewardThreadStateRank(a.state) - stewardThreadStateRank(b.state)
      || String(b.updatedAt).localeCompare(String(a.updatedAt))
      || String(a.sessionId).localeCompare(String(b.sessionId)));
    const row = {
      missionId: group.missionId,
      // 未归类事项没有事项文件,标题只能从它唯一那条线程的会话标题派生(§3.1「不改写历史」)。
      // 116-5b:派生用的是那条线程的【显示名】而不是原话 —— 这个字段本来就是一个派生出来的显示串
      // (真事项走 container.title),不是权威数据;线程的原话仍在 threads[].title 里原样躺着。
      title: container ? container.title : ((group.threads[0] && (group.threads[0].displayTitle || group.threads[0].title)) || group.missionId),
      goal: container ? container.goal : '',
      derived: !container,
      archivedAt: (container && container.archivedAt) || '',
      cwd: container ? container.cwd : '',
      // W7:事项的工作区(见本函数头注)。cwd 仍是容器那一格的原值,语义一个字不改。
      workspace: workspaceOf((container && container.cwd)
        || ((group.threads.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] || {}).cwd)),
      aggregateState: aggregateMissionState(group.threads.map(thread => thread.state)),
      threadCount: group.threads.length,
      threads: group.threads,
      acceptance: {
        done: acceptanceItems.filter(item => item.done).length,
        total: acceptanceItems.length,
        items: acceptanceItems,
        // ── 124 还债①（40 号文 §8.5 ①）：让【看板】也答得出「未记录验收」───────────────
        // 修前这一块只有 done/total/items 三个数，都来自事项容器。容器里的 done 按定义只可能是
        // 用户勾的，所以那条 a/b 单一来源、不会说谎 —— 但它**答不出「这一件压根没人记过验收」**：
        // `total === 0` 既可能是「记过、是空的」，也可能是「从来没记过」，看板只能两者都当没话说。
        // 详情路由（/api/missions/:id）走的是 02 的 buildMissionAcceptanceProjection，那边有
        // `ledger`；列表这一侧没有，于是抽屉说得出「未记录验收」而看板说不出。这两个键就是把
        // 同一套事实补到列表行上 —— **判据仍然只有前端 thread-facts.acceptanceRecorded 一处**，
        // 这里只负责把它需要的事实如实投影出来。
        //   · ledger  —— 组里【任一条】线程带自己的验收账本（`session.mission`）。组级口径：
        //     事项是按组显示的，组里只要有一条记过，这一件就不算「没人记过」。
        //   · tracked —— 这一组是不是【一件活】：有事项容器，或组里有 mission 线程（未归类事项
        //     没有容器文件，只能靠后者认出来）。
        //     为什么要它：左栏自 121-K3 放宽索引口径后大半是用户手工开的普通会话，它们的聚合态
        //     恒落 stopped、也从来没有验收记录 —— 不带这个门，「收工却没记过」会把整栏刷成等重
        //     灰字（§2.3「只在有话可说时出现」，正是 P1 当初刻意不碰看板的那条理由）。
        //     普通聊天会话本来就没有验收这回事，对它说「未记录验收」是噪声，不是诚实。
        ledger: group.anyLedger === true,
        tracked: Boolean(container) || group.anyMission === true,
      },
      budget: container ? container.budget : {},
      cost: group.cost,
      createdAt: container ? container.createdAt : ((group.threads[group.threads.length - 1] && group.threads[group.threads.length - 1].updatedAt) || ''),
      updatedAt: container ? container.updatedAt : ((group.threads[0] && group.threads[0].updatedAt) || ''),
    };
    rows.push(row);
    for (const thread of group.threads) rowBySessionId.set(thread.sessionId, row);
  }
  // 117s-A D1(§11.13 ③):组同规则 —— 状态秩优先、其次 updatedAt 降序。组的秩取【它自己的聚合态】
  // 的秩,而聚合态只经 06i 的 aggregateMissionState(上面已经算过一次,直接读 row.aggregateState);
  // 「组的秩 = 组内最高秩」这句话由 aggregateMissionState 的规则本身保证,不在这里另算一遍最大值
  // (any needs_you -> needs_you;非全 done 时 any running -> running;再 any dispatching;否则
  //  done/stopped 同落末档 —— 逐档与 stewardThreadStateRank 的秩一一对应)。
  rows.sort((a, b) => stewardThreadStateRank(a.aggregateState) - stewardThreadStateRank(b.aggregateState)
    || String(b.updatedAt).localeCompare(String(a.updatedAt))
    || String(a.missionId).localeCompare(String(b.missionId)));
  // 事项文件不在 75c 物化索引的 sourceStamp 覆盖面内(它们不是会话文件),所以 ETag 必须自己带上
  // 它们的指纹 —— 否则 PATCH 完验收项、再带 If-None-Match 来读会拿到 304 + 陈旧的 acceptance。
  // 117h 第 0 步:行上新增的 missionTitle / goal / acceptanceItems 都由容器字段直出,所以指纹要把
  // 它们一并纳入 —— 光靠 updatedAt 依赖「每次改都会动 updatedAt」这条隐含约定,写进指纹才是自证的。
  // 117s-A D1:行序自此由【状态秩】决定,而状态可以在 updatedAt 与容器字段都不动的情况下变
  //   (最典型的一条:活回合结束 -> activeTurn 由真变假 -> running 落 done,会话头那一刻并没有再写一次)。
  // 指纹不带秩的话,带 If-None-Match 来的下一拍会拿到 304 + 一份【旧顺序】的行 —— 与上面那条
  // acceptance 的教训同一个模具,所以把秩写进指纹,而不是依赖「状态变了 updatedAt 一定也变」。
  const stamp = pretenderHash([
    containers.map(row => [row.missionId, row.updatedAt, row.archivedAt || '', row.title || '', row.goal || '']),
    rows.map(row => [
      row.missionId, stewardThreadStateRank(row.aggregateState),
      row.threads.map(thread => [thread.sessionId, stewardThreadStateRank(thread.state)]),
      // W7:工作区也进指纹 —— ruyiOwned 随配置里那张表变,而会话头与容器都没动。
      row.workspace ? [row.workspace.path, row.workspace.ruyiOwned] : null,
    ]),
  ]);
  return { rows, rowBySessionId, stamp };
}

// /api/missions 的行是【线程行】(每个 mission 会话一张卡,70 波起如此,前端静态锁按它冻结)。
// 116g 只在每行【追加】它所属事项的聚合事实,既有字段与顺序一个不动。
function overlayMissionAggregateFields(card, row) {
  if (!card) return card;
  // row 缺失 = 这张卡片的会话在 listSessions 的元数据里没有对应行(索引与投影之间的瞬时偏斜)。
  // 退化成「只有它自己一条线程的未归类事项」,聚合态仍然只经 aggregateMissionState —— 绝不在这里
  // 按 card.status 另编一套判据(那就是第二个状态机)。
  // 116h(§8.10「排队可解释」):看板每一行都要能说出「它在等什么」。这一行就是那条线程自己的行,
  // 所以取聚合行里【它自己】那条线程的 wait(与 steward_missions / steward_thread_status 同源同形);
  // row 缺失的退化分支里现算一次,仍然只经 06i 的 waitReasonFor(不另编第二套判据)。
  const threadWait = row ? ((row.threads || []).find(thread => thread.sessionId === card.sessionId) || {}).wait || null : null;
  if (!row) {
    const derived = stewardThreadStateFromCard(card);
    return Object.assign(card, {
      aggregateState: aggregateMissionState([derived.state]),
      threadCount: 1,
      // 124 还债①：退化支（没有聚合行）也得如实说 —— 没有容器就没有容器验收项，
      // 账本与「是不是一件活」仍然只读卡片上那两条既有事实，不另编。
      acceptance: { done: 0, total: 0, ledger: String(card.status || '') !== 'none', tracked: String(card.kind || '') === 'mission' },
      budget: {}, cost: emptyMissionCostBucket(), derived: true,
      // 117h 第 0 步:没有聚合行 = 没有容器,事项标题就是这条线程自己的标题,目标与验收项如实为空。
      missionTitle: String(card.displayTitle || card.title || ''), goal: '', acceptanceItems: [],
      missionWorkspace: null,   // W7:没有聚合行就没有事项级工作区;这条线程自己的目录仍在 card.cwd
      wait: waitReasonFor(
        { pending: (derived.sources && derived.sources.pendingTotal) || 0 },
        typeof StewardHooks.arbiterWait === 'function' ? StewardHooks.arbiterWait(card.sessionId) : null,
      ),
    });
  }
  return Object.assign(card, {
    aggregateState: row.aggregateState,
    threadCount: row.threadCount,
    // 124 还债①：ledger / tracked 跟着 done/total 一起上行 —— 看板按组取【领头那一行】的
    // acceptance（groupRows 里 `acceptance: row.acceptance`），而这两个是组级事实，同组每一行都一样。
    acceptance: { done: row.acceptance.done, total: row.acceptance.total, ledger: row.acceptance.ledger === true, tracked: row.acceptance.tracked === true },
    budget: row.budget,
    cost: row.cost,
    derived: row.derived,
    // ── 117h 第 0 步(27 号文 §5 117h 行 / 117d 拍板①):看板要按【事项】分组显示,而事项容器的
    // 标题 / 目标 / 验收项此前只有 steward_missions 工具面拿得到 —— 117d 抽屉只能按确定性顺序
    // 回落到线程标题。这里【只加三个字段】,不加新路由、不动既有字段与顺序:
    //   · missionTitle:有容器就是容器标题;没有容器(derived 行,`未归类事项`)就是本行自己的标题;
    //   · goal        :容器目标,无容器为空串(不猜、不拿线程摘要冒充);
    //   · acceptanceItems:容器验收项整表(既有 acceptance 只有 done/total 两个数,画不出条目)。
    // 116-5b:derived 行的事项标题 = 这条线程自己的【显示名】(见 buildMissionAggregateRows 同款注释)。
    missionTitle: row.derived ? String(card.displayTitle || card.title || '') : String(row.title || ''),
    goal: String(row.goal || ''),
    acceptanceItems: Array.isArray(row.acceptance.items) ? row.acceptance.items : [],
    wait: threadWait,
    // W7:这条线程所属事项的工作区({path,name,ruyiOwned} 或 null)。只加字段;给 W4 的管家界面读。
    missionWorkspace: row.workspace || null,
  });
}

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

const agentInterventionAction = require('./backend/agent-intervention-actions.cjs').createAgentInterventionActions({
  activeAgentRuns, agentRunFile, nowIso, readConfig, loadSession: (...args) => loadSession(...args),
  normalizeCwd, getAgentRoleLibrary, materializePoolItem, applyReplanPatch, bumpRunIntervention,
  appendAgentRunEvent, saveAgentRun,
});
function decideIntervention(command) {
  return decideInterventionCommand(command, agentInterventionAction);
}

// 性能批 P3:GET /api/interventions 的待决引用表,按索引对象缓存(索引任何刷新都换新对象,缓存随之作废)。
// 次序与修前逐条相同:按 requestedAt 的 localeCompare 稳定排序(每个索引版本只排一次)。
const pendingInterventionRefsMemo = new WeakMap();
function pendingInterventionRefs(index, onlySession) {
  let byFilter = pendingInterventionRefsMemo.get(index);
  if (!byFilter) pendingInterventionRefsMemo.set(index, byFilter = new Map());
  const hit = byFilter.get(onlySession);
  if (hit) return hit;
  const refs = [];
  const counts = { permission: 0, question: 0, plan: 0, pool: 0, replan: 0, total: 0 };
  for (const slice of index.sessions) {
    if (onlySession && slice.sessionId !== onlySession) continue;
    for (const iv of slice.interventions || []) {
      if (!iv || iv.status !== 'pending') continue;
      refs.push({ slice, iv, requestedAt: String(iv.requestedAt || '') });
      counts.total++;
      if (iv.type === 'permission') counts.permission++;
      else if (iv.type === 'question') counts.question++;
      else if (iv.type === 'plan') counts.plan++;
      else if (iv.type === 'pool') counts.pool++;
      else if (iv.type === 'replan') counts.replan++;
    }
  }
  refs.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  const entry = { refs, counts };
  byFilter.set(onlySession, entry);
  return entry;
}
// 一条待决的对外形状(字段与次序与修前逐字相同);实时字段每次现算。
function pendingInterventionItem(slice, iv) {
  const sessionId = slice.sessionId;
  return {
    id: iv.id, type: iv.type || '', sessionId, missionId: slice.missionId || sessionId,
    requestedAt: iv.requestedAt || '', interventionVersion: Math.max(0, Number(iv.interventionVersion) || 0),
    toolName: iv.toolName || '', tier: iv.tier || '', revertible: iv.revertible === true,
    runId: iv.runId || '', proposedBy: iv.proposedBy || '', task: iv.task || '',
    input: iv.type === 'permission' && iv.input && typeof iv.input === 'object' && !Array.isArray(iv.input) ? iv.input : undefined,
    questionSummary: iv.type === 'question' ? String(iv.questionSummary || '') : '',
    questions: iv.type === 'question' && Array.isArray(iv.questions) ? iv.questions : [],
    context: iv.type === 'question' ? String(iv.context || '').slice(0, 6000) : '',
    planSummary: iv.type === 'plan' ? String(iv.planSummary || '') : '',
    replanSummary: iv.type === 'replan' ? String(iv.summary || '') : '',
    replanTriggerType: iv.type === 'replan' ? String(iv.triggerType || '') : '',
    replanNodeId: iv.type === 'replan' ? String(iv.nodeId || '') : '',
    deliverable: iv.type === 'permission' ? pendingPermissions.has(String(iv.id))
      : iv.type === 'question' ? pendingQuestions.has(String(iv.id))
        : iv.type === 'plan' ? pendingPlans.has(String(iv.id))
          : iv.type === 'pool' ? activeAgentRuns.has(String(iv.runId || ''))
            : activeChildren.has(sessionId),
    live: activeChildren.has(sessionId), // 决策可送达性提示:活回合在,决策才能立刻被消费
    // 135(工作台「等你处理」队列的倒计时):内存登记簿里的截止时刻(ms)。权限的超时即自动拒绝、
    // 存档暂停会把它延长,提问靠心跳续期 —— 都只有这张登记簿知道真值,前端不自己猜。取不到为 0。
    deadlineAt: Math.max(0, Number((iv.type === 'permission' ? pendingPermissions.get(String(iv.id))
      : iv.type === 'question' ? pendingQuestions.get(String(iv.id)) : null)?.deadlineAt) || 0),
  };
}

async function handleInterventionApiRoutes(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/_test/pretender-maintenance') {
    if (process.env.RUYI_TEST_HOOKS !== '1') return send(res, json({ ok: false, error: 'not found' }, 404));
    const body = await readJsonBody(req);
    if (body.action === 'compact') {
      const sessionId = safeSessionId(body.sessionId);
      if (!sessionId) return send(res, apiSessionIdInvalid());
      return send(res, json(await compactInterventionJournal(sessionId, { force: true })));
    }
    if (body.action === 'rebuild') {
      pretenderIndexRuntime.fullDirty = true;
      return send(res, json({ ok: true, index: pretenderIndexMeta(await getPretenderProjectionIndex()) }));
    }
    return send(res, json({ ok: false, error: 'invalid maintenance action' }, 400));
  }
  const contractMatch = pathname.match(/^\/api\/missions\/([^/]+)\/interventions\/([^/]+)\/decision$/);
  if (req.method === 'POST' && contractMatch) {
    let missionId = '', interventionId = '';
    try {
      missionId = decodeURIComponent(contractMatch[1]);
      interventionId = decodeURIComponent(contractMatch[2]);
    } catch {
      return send(res, json(interventionCommandFailure('invalid_request', 400, {}, 'malformed route encoding').body, 400));
    }
    const body = await readJsonBody(req);
    const result = await decideIntervention({
      missionId,
      interventionId,
      expectedVersion: body.expectedVersion,
      idempotencyKey: body.idempotencyKey,
      payload: body,
      source: 'contract',
      contractRequest: true,
    });
    return send(res, json(result.body, result.status));
  }
  // 第56波(Pretender 立项门 / EC-E 363):全局「需要你」最小聚合入口 —— 跨会话 pending Intervention 收件箱。
  // 只读派生:扫 *.interventions.ndjson 折叠取 pending(注册/决策/超时/清理/重启终态化全在旁路账里);
  // pool 型由 71b 注册 + boot 对账覆盖,append 落盘延迟窗为最终一致(与 13d missionPendingCounts 同立场)。
  // 按 requestedAt 升序(FIFO 收件箱:最先等你的在最前)。
  if (req.method === 'GET' && pathname === '/api/interventions') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const index = await getPretenderProjectionIndex();
    // hunt2-steward ⑨:可选 ?sessionId= 只看一条线程的待决(counts 同口径只数它)。抽屉修前拉全局前 100 条
    // 再在前端按会话筛 —— 全局待决超过 100 条时,排在后面的那条线程的待决永远落在页外,抽屉说它「没在等你」。
    // 不带这个参数的调用逐字节不变。ETag 带上筛选键:同一个修订号下两种视图的响应体不同。
    const onlySessionRaw = new URL(req.url, 'http://127.0.0.1').searchParams.get('sessionId');
    const onlySession = onlySessionRaw ? (safeSessionId(onlySessionRaw) || '~invalid') : '';
    const stewardView = new URL(req.url, 'http://127.0.0.1').searchParams.get('view') === 'steward';
    // 性能批 P3:待决列表按索引版本只收集、排序一次(引用 + 计数缓存在 index 对象上);分页与 ETag 在造条目之前 ——
    // 304 不再付整张表的代价,200 也只为这一页造条目。条目里的实时字段(可送达、活回合、倒计时)照旧每次现算。
    const { refs, counts } = pendingInterventionRefs(index, onlySession);
    const paged = paginatePretenderProjection(req, 'interventions', index.interventionsRevision, refs);
    if (paged.response) return send(res, paged.response);
    const etag = pretenderEtag('interventions', index.interventionsRevision + '-' + pretenderLiveOverlayRevision() + (onlySession ? '-s:' + onlySession : '') + (stewardView ? '-steward' : ''), paged.page);
    if (pretenderNotModified(req, etag)) return send(res, { status: 304, headers: { etag }, body: '' });
    paged.items = paged.items.map(ref => pendingInterventionItem(ref.slice, ref.iv));
    // 135(「等你处理」队列真机走查):弹窗要写清「来自哪条线程」,而前端左栏列表可能还没刷到刚开的线程。
    // 只读【本页】有待决的那几条会话的头(每个 ~1 KB,并行),取不到就留空,前端退回「未命名线程」。
    // 3.0 预览收口:此前在分页与 304 之前串行读【全部】待决会话的头,299 条会话时每请求 300–450 ms
    // (mission-index-scale 收件箱热 P95 闸 250 ms 红);标题从不进 ETag,挪到分页之后响应不变。
    const pageSids = [...new Set(paged.items.map(p => p.sessionId))];
    const heads = await Promise.all(pageSids.map(sid => readSessionHeadResilient(sid).catch(() => null)));
    const titleOf = new Map(pageSids.map((sid, i) => [sid, String((heads[i] && heads[i].title) || '').slice(0, 120)]));
    for (const p of paged.items) p.title = titleOf.get(p.sessionId) || '';
    if (stewardView) {
      const ids = [...new Set(paged.items.map(p => p.missionId).filter(id => !pageSids.includes(id)))];
      const containers = await Promise.all(ids.map(id => readMissionContainer(id).catch(() => null)));
      const titles = new Map(ids.map((id, i) => [id, String(containers[i]?.title || '')]));
      for (const p of paged.items) {
        p.missionTitle = titles.get(p.missionId) || p.title;
        const run = activeAgentRuns.get(p.runId)?.run;
        const detail = p.type === 'permission' ? p.input
          : p.type === 'plan' ? pendingPlans.get(String(p.id))?.markdown
            : p.type === 'pool' ? run?.taskPool?.find(item => item.id === p.id)
              : p.type === 'replan' ? run?.replanPatches?.find(item => item.id === p.id) : null;
        const text = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail, null, 2) : '';
        p.detailsText = text.slice(0, 32000);
        p.detailsComplete = !!detail && text.length <= 32000;
      }
    }
    return send(res, json({
      ok: true,
      pending: paged.items,
      counts,
      page: paged.page,
      nextCursor: paged.page.nextCursor,
      projectionRevision: index.interventionsRevision,
      index: pretenderIndexMeta(index),
    }, 200, { etag }));
  }
  // 第71波:会话的持久化 Intervention 只读派生(注册/决策/超时/清理/重启终态化的旁路记录,02 NDJSON)。
  // 只认 /api/interventions/<一段>(同上:不再用 path.basename 给多段路径当别名)。
  const interventionsOf = req.method === 'GET' ? pathname.match(/^\/api\/interventions\/([^/]+)$/) : null;
  if (interventionsOf) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const sessionId = safeSessionId(safeDecodeURIComponent(interventionsOf[1]) || '');
    if (!sessionId) return send(res, apiSessionIdInvalid());
    const index = await getPretenderProjectionIndex();
    const slice = index.sessions.find(row => row.sessionId === sessionId) || null;
    const interventions = slice ? slice.interventions : [];
    const counts = { permission: 0, question: 0, plan: 0, pool: 0, replan: 0, pending: 0, resolved: 0 };
    for (const iv of interventions) {
      if (!iv) continue;
      if (iv.status === 'pending') {
        counts.pending++;
        if (iv.type === 'permission') counts.permission++;
        else if (iv.type === 'question') counts.question++;
        else if (iv.type === 'plan') counts.plan++;
        else if (iv.type === 'pool') counts.pool++;
        else if (iv.type === 'replan') counts.replan++;
      } else counts.resolved++;
    }
    const revision = slice ? slice.interventionRevision : pretenderHash([]);
    const paged = paginatePretenderProjection(req, 'session-interventions:' + sessionId, revision, interventions);
    if (paged.response) return send(res, paged.response);
    const etag = pretenderEtag('session-interventions', revision, paged.page);
    if (pretenderNotModified(req, etag)) return send(res, { status: 304, headers: { etag }, body: '' });
    return send(res, json({
      ok: true,
      sessionId,
      missionId: slice ? slice.missionId : sessionId,
      interventions: paged.items,
      counts,
      page: paged.page,
      nextCursor: paged.page.nextCursor,
      projectionRevision: revision,
      integrity: slice ? slice.integrity : { degraded: false, corruptLines: 0, journalRows: 0, journalBytes: 0 },
    }, 200, { etag }));
  }
  if (req.method === 'POST' && pathname === '/api/chat/answer') {
    // 75b compatibility adapter: normalize the classic answer[] shape, then hand the actual decision to
    // the same command core used by the Mission contract.
    const body = await readJsonBody(req);
    const sessionId = String(body.sessionId || '');
    const questionId = String(body.questionId || body.toolUseId || '');
    const entry = pendingQuestions.get(questionId);
    if (!entry || entry.sessionId !== sessionId) {
      return send(res, apiFailure('question.not_pending', {}, 'question is no longer pending', 409));
    }
    const result = await decideIntervention({
      missionId: sessionId,
      interventionId: questionId,
      payload: { action: 'answer', normalizedAnswer: normalizeQuestionAnswer(body, entry.questions) },
      source: 'legacy_question',
      contractRequest: false,
    });
    if (result.status !== 200) return send(res, apiFailure('question.delivery_failed', {}, 'answer could not be delivered; the question is still pending', 409));
    return send(res, json({ ok: true, delivered: true, questionId }));
  }
  if (req.method === 'POST' && pathname === '/api/question/heartbeat') {
    // Keep-alive from the open question modal: re-arms the pending question's timeout so a user typing a
    // long answer is never cut off at a fixed deadline. No heartbeat (modal closed / app gone) means the
    // original timeout fires as the backstop. Returns the fresh deadline for the UI countdown.
    const body = await readJsonBody(req);
    const sessionId = String(body.sessionId || '');
    const extension = extendUserQuestion(sessionId, String(body.questionId || ''));
    if (!extension) return send(res, apiFailure('question.not_pending', {}, 'question is no longer pending', 409));
    return send(res, json({ ok: true, deadlineAt: extension.deadlineAt, timeoutMs: extension.timeoutMs }));
  }
  if (req.method === 'POST' && pathname === '/api/question/request') {
    // Called by request_user_input in the per-session Claude MCP child. Hold the tool call until the UI
    // answers, then return a normal MCP tool result. Provider turns use the same registry in-process.
    const body = await readJsonBody(req);
    if (!tokenMatches(body.token)) return send(res, apiFailure('auth.token_invalid', {}, 'bad token', 403));
    const sessionId = safeSessionId(body.sessionId);
    if (!sessionId) return send(res, apiSessionIdInvalid());
    const reg = activeChildren.get(sessionId);
    if (!reg || !reg.onEvent) return send(res, apiFailure('question.no_active_turn', {}, 'no active UI stream to prompt', 409));
    const config = await readConfig();
    const answer = await requestUserQuestion(sessionId, makeId('question'), body.questions, reg.onEvent, config.questionTimeoutMs, reg.questionContext || '');
    return send(res, json(answer && answer.ok
      ? { ok: true, answers: answer.answers, content: answer.content }
      : { ok: false, error: (answer && (answer.error || answer.content)) || 'question cancelled' }));
  }
  if (req.method === 'POST' && pathname === '/api/permission/request') {
    // Called by the permission-bridge MCP tool (loopback). Holds until the UI decides or times out.
    const body = await readJsonBody(req);
    if (!tokenMatches(body.token)) return send(res, json({ ok: false, error: 'bad token' }, 403));
    const config = await readConfig();
    const sessionId = String(body.sessionId || '');
    const reg = activeChildren.get(sessionId);
    const requestId = makeId('perm');
    if (!reg || !reg.onEvent) {
      // No live UI stream to ask — fail closed.
      return send(res, json({ behavior: 'deny', message: 'no active UI to prompt', requestId }));
    }
    // 审计 A② 后续(CLI 直挂面):toolLoadingMode:'full' 时桥接服务器(ACC 等)直接写进 --mcp-config,由 CLI 自己调,
    // 不经工作台的三个分发点 —— 唯一还能插手的地方就是这里:CLI 为 mcp__<server>__<tool> 来问权限时,按与分发点
    // 同一个 bridgedReadPathGate 判读路径,越界 / 内部数据 / 相对路径直接拒(不弹窗、不走授权书、不走 auto 短路)。
    // 覆盖不到的:CLI 不来问的时候 —— bypass / auto 档(不带 --permission-prompt-tool)与 exec 档 DAG 节点(bypass 起)。
    // 如意自己的 MCP 工具(mcp__ruyi__*)在它自己的 toolCall 里已有文件闸,这里不重复判。
    {
      const cliToolName = String(body.toolName || '');
      if (cliToolName.startsWith('mcp__') && !cliToolName.startsWith(RUYI_MCP_CLI_TOOL_PREFIX)) {
        // 2026-10 能力总闸(纵深):CLI 直挂的内置桌面 MCP(mcp__ai-computer-control__<tool>)来问权限时,按与 09/08/12 同一个
        // toolDisabledByPolicy 判,被 allowCommandTools / allowDesktopTools(+ 这条线程的 desktopTools)关掉的直接拒,不弹窗。
        // 主防线在源头:01 把同一张表算成 ACC_HIDE_TOOLS 交给 ACC,它根本不注册这些工具;这里兜的是旧版 ACC(不认该变量)。
        // 同样覆盖不到 CLI 不来问的档(bypass / auto、exec 档 DAG 节点)—— 那几档只靠源头裁剪。
        const accPrefix = `mcp__${DESKTOP_MCP_SERVER_ID}__`;
        if (cliToolName.startsWith(accPrefix)) {
          const policyOff = toolDisabledByPolicy(cliToolName, config, sessionDesktopToolsOf(reg.session),
            { serverId: DESKTOP_MCP_SERVER_ID, toolName: cliToolName.slice(accPrefix.length) });
          if (policyOff) {
            logEvent({ kind: 'permission_bridge_policy_deny', sessionId, tool: cliToolName, reason: policyOff });
            return send(res, json({ behavior: 'deny', message: toolDisabledResult(cliToolName, policyOff).error, requestId }));
          }
        }
        const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {};
        const readRefusal = await bridgedReadPathGate(cliToolName, input, { sessionId, session: reg.session, config });
        if (readRefusal) {
          logEvent({ kind: 'permission_bridge_path_deny', sessionId, tool: cliToolName, code: readRefusal.code || '' });
          return send(res, json({ behavior: 'deny', message: readRefusal.error || 'path not allowed', requestId }));
        }
      }
    }
    // v0.8-S4b: mirror the native path — carry tier + revertible so the popup renders the badge + the
    // revertibility line for CLI-bridge permission prompts too. The CLI reports its own tool names (Edit/
    // Write/Bash/…); toolIsRevertible only matches the workbench file_* set, so a native CLI Edit shows
    // 「无法自动撤销」(correct: CLI-native edits don't pass through toolCall → aren't journaled).
    // 第27波:CLI 桥授权书消耗点。命中直接 allow —— 连 permission_request 事件都不发(免弹窗静默放行)。工具名按 CLI
    // 弹窗实际显示的 Claude 名(Bash/Edit/Write)匹配,与签发卡片同名口径。范围外回落到下方正常弹窗。session 仅需 .id。
    const bridgeTier = cliBridgeToolTier(String(body.toolName || ''));
    // 117m-A3(配 A1 的 D1):高风险判据要吃到工具名与入参,否则 CLI 桥这一侧的 auto 档还是老口径。
    // 审计 C:按【这一回合】的实效档判,不按全局档。runClaudeTurn 登记活回合时记下了 spawn CLI 用的解析档
    // (请求级 > 会话级 > 全局,10 runSessionTurn 解析);修前读 config.permissionMode —— 全局 auto 时,一条被
    // 收紧到 default/plan 的线程(或交办卡/定时任务的请求级收紧)经 CLI 桥发来的 edit/exec 请求被静默放行。
    // 登记表上没有这个值(Kimi 等其它引擎)就按会话头 + 全局解析,仍比「只看全局」更紧或相等。
    const bridgeMode = String((reg && reg.permissionMode) || resolvePermissionMode({ session: reg && reg.session, config }) || '');
    const bridgeGate = nativeToolGate(bridgeMode, bridgeTier, String(body.toolName || ''), body.input || {});
    // auto 档的低风险动作在原生引擎里已经不弹窗了,CLI 桥必须同口径 —— 否则同一个「全自动」在两个引擎
    // 下行为不一致。只对 auto 档短路(其余档位一行不变:read/bypass 的既有落点仍走下面那条路)。
    if (bridgeMode === 'auto' && bridgeGate === 'allow') {
      return send(res, json({ behavior: 'allow', updatedInput: body.input || {} }));
    }
    // 对抗轮 P3(天花板对称):与 native 主 gate 对齐 —— 仅当工作台自身权限模式对该档判定为 'ask' 时才允许授权书降级。
    // 工作台若处于 plan 模式(该档判 'block'),即便 CLI 发来请求也不放行(子集律:授权书永不把 block 提升为 allow),
    // 回落到下方正常弹窗由人定夺。default→'ask' 授权书生效;bypass→'allow' 本就免弹窗,无需授权书。
    if (bridgeGate === 'ask') {
      const grantHit = consumeGrant({ id: sessionId }, String(body.toolName || ''), body.input || {}, 'cli', null);
      // 第42b波(live 冒烟擒获):CLI ≥2.1 的 zod union 要求 allow 变体【必须】带 updatedInput record,
      // 裸 {behavior:'allow'} 会被 CLI 判 invalid_union 拒掉 → 回显原始输入。
      if (grantHit) return send(res, json({ behavior: 'allow', updatedInput: body.input || {} }));
    }
    reg.onEvent({ type: 'permission_request', requestId, toolName: body.toolName, input: body.input, tier: bridgeTier, revertible: toolIsRevertible(body.toolName) });
    registerIntervention(sessionId, 'permission', requestId, {
      toolName: String(body.toolName || ''), tier: bridgeTier, revertible: toolIsRevertible(body.toolName),
      input: body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {},
    });
    // 第27f波:CLI 桥超时→存档暂停(与 provider 路径对称)。仅【opt-in + 本会话处于无人值守 driverAuto 回合】才启用;
    // 否则维持"超时即拒杀"安全默认。两段定时:基础超时→检查点(logEvent+saveSession)+ permission_paused 事件 + 延长到 TTL;
    // TTL 内无决定则回落 deny(fail-closed)。entry.timer 重赋为 TTL 定时器,/api/permission/decision 与 clearPendingPermissions 照常清对。
    const cliPause = config.autonomyPauseOnTimeout && driverAutoSessions.has(sessionId);
    const decision = await new Promise(resolve => {
      // 128f-⑪:「等多久」问 04 的 permissionWaitMs(修前这一支只认 config,定时线程上的 CLI 引擎也是 120 s)。
      const baseMs = permissionWaitMs(sessionId, config, reg && reg.session);
      const entry = { resolve, sessionId, timer: null, deadlineAt: Date.now() + baseMs };
      if (cliPause) {
        entry.timer = setTimeout(() => {
          if (reg) reg.pausePending = true; // 第27f波:存档暂停期间豁免子进程 idle 看门狗(否则 TTL 内先杀子,窗口被截断)
          try { logEvent({ kind: 'permission_paused', sessionId, tool: String(body.toolName || ''), tier: bridgeTier, requestId, engine: 'claude' }); } catch { /* ignore */ }
          loadSession(sessionId).then(s => s && saveSession(s)).catch(() => {}); // 检查点:会话已在磁盘,重写一遍固化
          try { reg.onEvent({ type: 'permission_paused', requestId, toolName: body.toolName, tier: bridgeTier, ttlMs: config.autonomyPauseTtlMs }); } catch { /* stream gone */ }
          entry.deadlineAt = Date.now() + Math.max(60000, Number(config.autonomyPauseTtlMs) || 2700000);   // 128f-⑪:存档暂停把窗口延长了
          entry.timer = setTimeout(() => {
            const message = '权限已存档暂停但在时限内无人决定,已回落拒绝';
            runAutomaticInterventionDecision({
              missionId: sessionId, interventionId: requestId, source: 'timeout_permission', decidedBy: 'timeout',
              idempotencyKey: `timeout:${requestId}`, payload: { action: 'deny', message },
            }, () => {
              if (pendingPermissions.get(requestId) !== entry || entry.commandApplying) return;
              pendingPermissions.delete(requestId);
              resolve({ behavior: 'deny', message, pausedTimeout: true });
              settleIntervention(sessionId, requestId, 'denied', { decidedBy: 'timeout', note: 'paused ttl timeout' });
            });
          }, Math.max(60000, Number(config.autonomyPauseTtlMs) || 2700000));
        }, baseMs);
      } else {
        entry.timer = setTimeout(() => {
          const message = 'permission prompt timed out';
          runAutomaticInterventionDecision({
            missionId: sessionId, interventionId: requestId, source: 'timeout_permission', decidedBy: 'timeout',
            idempotencyKey: `timeout:${requestId}`, payload: { action: 'deny', message },
          }, () => {
            if (pendingPermissions.get(requestId) !== entry || entry.commandApplying) return;
            pendingPermissions.delete(requestId);
            resolve({ behavior: 'deny', message });
            settleIntervention(sessionId, requestId, 'denied', { decidedBy: 'timeout', note: message });
          });
        }, baseMs);
      }
      pendingPermissions.set(requestId, entry);
    });
    try { reg.onEvent({ type: 'permission_decision', requestId, behavior: decision && decision.behavior === 'allow' ? 'allow' : 'deny', message: decision && decision.message }); } catch { /* stream gone */ }
    if (reg) { reg.pausePending = false; reg.lastEventAt = Date.now(); } // 解除暂停豁免 + 重置看门狗时钟(暂停不算子进程空闲)
    if (res.writableEnded || res.destroyed) return; // request already gone (e.g. child died)
    // 第42b波(live 冒烟擒获):CLI ≥2.1 的 --permission-prompt-tool 响应是 zod union —— allow 变体必须
    // 带 updatedInput record;UI 纯「允许」(未改输入)时 decision.updatedInput 为 undefined,JSON 序列化
    // 掉键后被 CLI 拒(invalid_union: expected record, received undefined)→ 回合必败。回填原始输入。
    if (decision && decision.behavior === 'allow' && (typeof decision.updatedInput !== 'object' || decision.updatedInput === null || Array.isArray(decision.updatedInput))) {
      decision.updatedInput = body.input || {};
    }
    return send(res, json(decision));
  }
  if (req.method === 'POST' && pathname === '/api/permission/decision') {
    // 75b compatibility adapter. The entry lookup only recovers the mission partition; execution is core-owned.
    const body = await readJsonBody(req);
    const requestId = String(body.requestId || '');
    const entry = pendingPermissions.get(requestId);
    if (!entry) return send(res, json({ ok: false, error: 'unknown or expired request' }, 404));
    const behavior = body.behavior === 'allow' ? 'allow' : 'deny';
    const result = await decideIntervention({
      missionId: entry.sessionId,
      interventionId: requestId,
      payload: behavior === 'allow'
        ? { action: 'allow', updatedInput: body.updatedInput, ...(body.scope === 'session' ? { scope: 'session' } : {}) }
        : { action: 'deny', message: body.message || 'denied by user' },
      source: 'legacy_permission',
      contractRequest: false,
    });
    if (result.status === 503) return send(res, json({ ok: false, error: 'could not record the decision on disk; nothing was applied, try again' }, 503));
    if (result.status !== 200) return send(res, json({ ok: false, error: 'unknown or expired request' }, 404));
    return send(res, json({ ok: true }));
  }
  if (req.method === 'POST' && pathname === '/api/plan/decision') {
    // 75b compatibility adapter for the classic plan-mode pause.
    const body = await readJsonBody(req);
    const planId = String(body.planId || '');
    const sessionId = String(body.sessionId || '');
    const entry = pendingPlans.get(planId);
    if (!entry || entry.sessionId !== sessionId) return send(res, json({ ok: false, error: 'no pending plan' }));
    const decision = body.decision === 'approve' ? 'approve' : 'reject';
    const result = await decideIntervention({
      missionId: sessionId,
      interventionId: planId,
      payload: { action: decision, feedback: body.note != null ? String(body.note) : '' },
      source: 'legacy_plan',
      contractRequest: false,
    });
    if (result.status !== 200) return send(res, json({ ok: false, error: 'no pending plan' }));
    return send(res, json({ ok: true }));
  }
  // 75a-2: test-only CAS primitive probe (failure-injection matrix, SCHEMA §7 六窗口). Env-gated
  // (RUYI_TEST_HOOKS=1) + token; production returns 404. Not a user-facing route -- 75b 的统一契约端点
  // POST /api/missions/:missionId/interventions/:id/decision 才是对外入口。
  if (req.method === 'POST' && pathname === '/api/_test/intervention-cas') {
    if (process.env.RUYI_TEST_HOOKS !== '1') return send(res, json({ ok: false, error: 'not found' }, 404));
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const body = await readJsonBody(req);
    let result;
    try {
      // 116c: source 可由请求指定(默认仍是 'test',既有用例逐字节不变)——让 CAS 矩阵能直接验证
      // source:'steward' 的成功/版本冲突/越权三条路径在命令核心里走的是同一套判定与同一条落盘格式。
      result = await transitionInterventionState(body.sessionId, body.ivId, body.expectedVersion, body.toStatus || 'allowed', {
        crashAt: body.crashAt, decidedBy: body.decidedBy, source: String(body.source || 'test').slice(0, 64),
        action: body.actionMs ? () => new Promise(r => setTimeout(r, Number(body.actionMs) || 0)) : undefined,
      });
    } catch (e) {
      const m = String((e && e.message) || '');
      if (m.startsWith('__cas_crash:')) return send(res, json({ ok: false, reason: 'crash', at: m.slice('__cas_crash:'.length) }));
      throw e;
    }
    return send(res, json(result));
  }
  return false;
}

const handleAgentRunApiRoutes = require('./backend/agent-run-routes.cjs').createAgentRunRoutes({
  tokenOk, safeSessionId, activeAgentRuns, agentRunActionCommand, decideIntervention, agentRunFile,
  AgentRunStore, applyAgentWorktree, cleanupAgentWorktree, bumpMissionChangeSeq, RUYI_EVENTS, EventStreamHooks,
});
