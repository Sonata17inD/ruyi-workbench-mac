'use strict';

const path = require('node:path');

function createMissionAggregate({
  paths, dataRootAliases, nowIso, activeChildren, readConfig, listSessions, listMissionContainers,
  readMissionSessionHead, sessionDisplayTitle, sessionBriefOf, StewardHooks,
  stewardRuyiOwnedPath, stewardThreadStateFromCard, stewardThreadStateFromHead, deriveStewardThreadState,
  stewardSanitizeText, waitReasonFor, stewardThreadStateRank, aggregateMissionState,
  getPretenderProjectionIndex, overlayMissionCard, missionPendingCounts, pretenderHash,
}) {
  // 一处装配,两处消费(GET /api/missions 的只加字段、13g 的 steward_missions 工具)。纪律与 70 波
  // /api/missions 同源:**纯读模型** —— 线程五态取投影 card(与看板逐字节同源),事项级状态只经 06i 的
  // `aggregateMissionState` 纯函数,绝不在这里另写一份判据;没有事项文件的 missionId 按需派生
  // (`derived:true`,标题取会话标题),不落盘、不回写、不迁移。

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

  return { buildMissionAggregateRows, overlayMissionAggregateFields, missionAggregateStats };
}

module.exports = { createMissionAggregate };
