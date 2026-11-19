'use strict';

function createStewardThreadOverview({ sessions, projection }) {
  const {
    STEWARD_SESSION_ID, activeChildren, applySessionPermissionModeOverride, getPretenderProjectionIndex,
    listSessions, overlayMissionCard, readMissionContainer, safeSessionId, sessionMeta, sessionMissionId,
  } = sessions;
  const {
    STEWARD_DIGEST_LIMITS, StewardHooks, buildStewardDigestLine, redact, stewardArbiterWait,
    stewardForeignProjection, stewardQuickThread, stewardRawKind, stewardReadSessionHead, stewardSanitizeText,
    stewardSeatedByUser, stewardThreadDisplayTitle, stewardThreadPermissionMode, stewardThreadStateFromCard,
    stewardThreadStateFromHead, waitReasonFor,
  } = projection;

  // hunt2-steward ⑩(性能):总览每次都要为投影里的【每一条】会话读一次会话头(每个管家回合 / 每次到访 /
  // 每次预判缓存未命中),会话一多(实测 ~0.9ms/条,2000 条 1.8s)就全压在「管家开口前」那段等待上。
  // 按投影切片自带的 sourceStamp(会话头 + 待决 + run 文件的 size:mtime 指纹,13e pretenderSessionSourceStamp)
  // 记一份会话头:指纹没变就用上次读到的那份,变了才重读。saveSession / 待决写入都会给投影打脏页,
  // 下一次取投影时这片的指纹随之刷新,所以缓存与投影同一个新鲜度。会话级权限档的内存覆盖表每次都在
  // 【副本】上重新盖一遍(与 stewardReadSessionHead 同一纪律:活回合里刚切的档还没落盘也要读到)。
  // 只在本进程内存;不在投影里的会话随每一轮清掉,大小以投影为界。
  const _stewardDigestHeadCache = new Map();   // sid -> { stamp, head }
  async function stewardDigestHead(sid, stamp) {
    const key = (typeof stamp === 'string' && stamp && stamp !== '-') ? stamp : '';
    const hit = key ? _stewardDigestHeadCache.get(sid) : null;
    if (hit && hit.stamp === key) return applySessionPermissionModeOverride({ ...hit.head });
    const head = await stewardReadSessionHead(sid);
    if (key && head && head.id) _stewardDigestHeadCache.set(sid, { stamp: key, head });
    else _stewardDigestHeadCache.delete(sid);
    return head ? applySessionPermissionModeOverride({ ...head }) : head;
  }

  // 线程总览行的数据装配。事实源与 116c 的 steward_thread_status 完全相同(13e 投影 + 会话头 +
  // 06i 的五态判据),只是按「一行一条」的口径取字段 —— 13g 不能复用本函数(那会是前向边),
  // 故这里是同一批原语的第二个调用方,不是第二个事实源。
  //   · lastSay 取会话头的 summary:那就是上一回合助手最终文本的前 160 字(09 收尾处写的),
  //     不经模型改写,符合 §11.2「诚实:最后一句取原话」;
  //   · 只列「未收工」或「24 小时内收工」的线程,管家会话自己永远不列。
  async function stewardThreadDigestRows(config) {
    const index = await getPretenderProjectionIndex().catch(() => null);
    // 116g:事项标题只在【真有事项文件】时填。「未归类」事项(missionId === sessionId、无事项文件)的
    // 标题就是线程标题,填了等于把同一句话在总览行里重复一次(见下方 missionTitle 处的原注释)。
    // 按需读、按 missionId 记忆:总览一次最多读【出现过的事项】那么多个文件,不扫整个 missions 目录
    // (事项数上限 2000,全扫会让每次到访多出上千次文件读)。
    const missionTitles = new Map();
    const missionTitleOf = async missionId => {
      if (!missionTitles.has(missionId)) {
        const container = await readMissionContainer(missionId).catch(() => null);
        missionTitles.set(missionId, container ? container.title : '');
      }
      return missionTitles.get(missionId);
    };
    const rows = [];
    const relations = StewardHooks.relationsIndex(await listSessions());
    const now = Date.now();
    const slices = index && Array.isArray(index.sessions) ? index.sessions : [];
    const liveIds = new Set(slices.map(slice => slice && slice.sessionId));
    for (const sid of [..._stewardDigestHeadCache.keys()]) if (!liveIds.has(sid)) _stewardDigestHeadCache.delete(sid);
    for (const slice of slices) {
      const sid = slice && safeSessionId(slice.sessionId);
      if (!sid || sid === STEWARD_SESSION_ID) continue;
      const head = await stewardDigestHead(sid, slice.sourceStamp);   // hunt2-steward ⑩:按投影指纹复用会话头
      if (!head || !head.id) continue;
      const rawKind = stewardRawKind(head);
      if (rawKind === 'steward') continue;   // 排除面:按会话头【原始】 kind 判,不经 sessionKind()
      // 116-2e(§11.1 第 2 项):已收工的速查线程不占总览的注意力预算(判据单点在 13g 的
      // stewardQuickClosed,与 steward_threads_search 逐字同源;经 StewardHooks 调,同一条延迟绑定纪律)。
      if (typeof StewardHooks.quickClosed === 'function' && StewardHooks.quickClosed(head)) continue;
      const card = slice.card ? overlayMissionCard(slice) : null;
      const derived = card
        ? stewardThreadStateFromCard(card)
        : stewardThreadStateFromHead(head, {   // 会话头证据键与 13d / 13k / 13r 同一个适配器(06i)
          // 116-3 P1-5:只有【管家自己用 steward_quick_ask 开的】速查线程才是 quick_ask。
          // 判据与 13g 的 threads_search / thread_status 同一个函数(13h -> 13g 是后向边),
          // 不再用「非 mission 即 quick_ask」那个把普通对话也一并打上标签的兜底。
          kind: stewardQuickThread(head) ? 'quick_ask' : 'mission',
          activeTurn: activeChildren.has(sid),
        });
      const updatedMs = Date.parse(String(head.updatedAt || ''));
      const settled = derived.state === 'done' || derived.state === 'stopped';
      const recent = Number.isFinite(updatedMs) && (now - updatedMs) <= 24 * 60 * 60 * 1000;
      if (settled && !recent) continue;      // 收工超过 24 小时的线程不占总览预算
      const lastRun = card && card.lastRun ? card.lastRun : null;
      const pendingCount = card && card.pending
        ? (Number(card.pending.permissions) || 0) + (Number(card.pending.questions) || 0) + (Number(card.pending.plans) || 0) + (Number(card.pending.pool) || 0)
        : 0;
      const usage = slice.usage || null;
      const costs = usage && usage.costsByCurrency ? Object.values(usage.costsByCurrency) : [];
      // 116h(§8.10「排队可解释」):总览行的等待原因也走 06i 的 waitReasonFor 单点 —— 管家在提示词里
      // 读到的那句话,与 steward_thread_status / 看板 / steward_missions 逐字相同。
      const wait = waitReasonFor({ pending: pendingCount }, stewardArbiterWait(sid));
      // 121-K3(§4.5):这条线程此刻有没有人坐着。判据单点在 13k 的 stewardSeatedByUser(工具门读的
      // 是同一份在场快照),这里只是把同一个事实带进提示词 —— 硬拦在工具层,软告知在总览行:
      // 光有硬拦,模型会反复去试然后反复被拒,一个回合的预算就烧在互相打架上。
      const seatedBy = stewardSeatedByUser(sid) ? 'user' : null;
      rows.push({
        sessionId: sid,
        relatedHead: head,
        seatedBy,
        // 116-pre(§8.12/§11.3):递话预判的 index 行要 missionId——3.0 里等于 sessionId(见下方注释),
        // 加在这里而不是 digest 里,因为 buildStewardDigestLine 的 lead 段只吃 id/missionTitle/title 三键,
        // 多一个 missionId 键对总览行的拼装零影响(新增只加不改)。
        missionId: sessionMissionId(head) || sid,
        // 116-5b(§11.8.5):这条线程的【显示名】(人起的 > 生成的 > 原话,判据单点在 02 的
        // sessionDisplayTitle)。与 missionId 同一条理由放在行的顶层而不是 digest 里:
        // buildStewardDigestLine 的 lead 段只吃 id/missionTitle/title 三键,多一个顶层键对总览行的
        // 拼装零影响。**digest.title 仍是原话** —— 管家读到的是用户当时怎么说的,那比一个名字信息更全;
        // 需要显示名的是壳层(「现在这一件」、递送候选),它们读这个字段。
        displayTitle: stewardThreadDisplayTitle(head, config),
        updatedAt: String(head.updatedAt || ''),
        state: derived.state,
        wait,   // 116h:结构化形状(与另外三个展示面同形),给 117 壳层与旁路消费者读
        digest: {
          id: sid,
          seatedBy,   // 121-K3:buildStewardDigestLine 读它,拼出「你正坐在这条线程里」那一段
          // 事项标题:116g 起,归入了【真事项】(有事项文件)的线程在总览行里带上事项自己的标题,
          // 「未归类」线程仍恒为空 —— 那种情况下事项标题就是线程标题,写两遍等于把同一句话在总览里
          // 重复一次(buildStewardDigestLine 对空段整段跳过)。
          missionTitle: (await missionTitleOf(sessionMissionId(head) || sid)) || '',
          title: head.title || '',
          state: derived.state,
          action: activeChildren.has(sid) ? '回合进行中' : (lastRun ? `班组 ${lastRun.status || ''}` : ''),
          lastSay: head.summary || '',
          recentUserRequest: sessionMeta(head).recentUserRequest || null,
          // 116h:人话取 waitReasonFor 的 label(pendingCount > 0 时逐字仍是「等你(N 条待决)」,
          // 与 116f 的原措辞一致;新增的是等锁/等预算/等并发位三种)。
          waitReason: wait ? wait.label : '',
          permissionMode: stewardThreadPermissionMode(head, config),
          cost: costs.length ? costs.reduce((a, b) => a + (Number(b) || 0), 0) : null,
        },
      });
    }
    // 排序:等你 > 进行中 > 其余,同档按最近更新在前(总览被裁时先保住最该看的那几条)。
    const rank = state => (state === 'needs_you' ? 0 : state === 'running' ? 1 : state === 'dispatching' ? 2 : 3);
    rows.sort((a, b) => rank(a.state) - rank(b.state) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    rows.forEach((row, i) => {
      if (i < STEWARD_DIGEST_LIMITS.maxThreads) row.relatedThreads = StewardHooks.relatedThreads(row.relatedHead, relations);
      delete row.relatedHead;
    });
    return rows;
  }

  // ────────────────────────────────────────────────────────────────────────────

  function stewardOverviewBlock(rows, pack) {
    // 尾句(「更多细节用 steward_thread_read,读取有预算」)在空总览时也要在:管家随时可能被问到
    // 一条刚建起来的线程,它必须知道深读这条路存在,而不是因为「上一秒没有线程」就以为没有工具可用。
    if (!rows.length) return [pack.steward.overviewHeader, pack.steward.overviewEmpty, pack.steward.overviewMore].join('\n');
    const lines = [];
    let used = 0;
    let folded = 0;
    for (const row of rows) {
      if (lines.length >= STEWARD_DIGEST_LIMITS.maxThreads) { folded += 1; continue; }
      // 117l D5:总览行的名字用【显示名】。修前这里是原话 title —— 用户机器上十几条还没起名的线程
      // 于是被管家一律叫成「New session」。**digest.title 本身不动**:preroute 的词法打分吃的就是它
      // (见 stewardPrerouteIndexRows 处的原注释),把索引里的原话换掉等于把用户当时打的词抹了。
      const base = buildStewardDigestLine(stewardForeignProjection({ ...row.digest, title: row.displayTitle || row.digest.title }));
      const request = row.digest && row.digest.recentUserRequest;
      const activity = request ? ' · ' + pack.steward.activityRequest + stewardSanitizeText(redact(request.text), true).slice(0, 80) : '';
      // Related IDs are executable read targets: admit whole entries or omit them, never slice one.
      const clueBudget = Math.floor(STEWARD_DIGEST_LIMITS.lineChars / 2);
      const relatedEntries = [];
      for (const item of (row.relatedThreads || []).slice(0, 2)) {
        const entry = `${item.sessionId}(${stewardSanitizeText((item.reasons || [])[0] || '', true)})`;
        const candidate = ` · related: ${[...relatedEntries, entry].join(',')}`;
        if (activity.length + candidate.length <= clueBudget) relatedEntries.push(entry);
      }
      const clue = activity + (relatedEntries.length ? ` · related: ${relatedEntries.join(',')}` : '');
      const line = base.slice(0, STEWARD_DIGEST_LIMITS.lineChars - clue.length) + clue;
      if (used + line.length + 1 > STEWARD_DIGEST_LIMITS.totalChars) { folded += 1; continue; }
      lines.push(line);
      used += line.length + 1;
    }
    const out = [pack.steward.overviewHeader, pack.steward.activityGuidance, ...lines];
    if (folded > 0) out.push(pack.steward.overviewFolded({ threads: folded }));
    out.push(pack.steward.overviewMore);
    return out.join('\n');
  }

  // 117w-W1 提交③(27 号文 §11.19.2):工作区候选表的【只读投影】。W7 起升级成【已知工作区】清单。
  //
  // 为什么它必须存在:workspaces 在 06i 的 forbidden 清册里,管家从来读不到有哪些工作区,于是它从不
  // 传 cwd,一切落到默认工作区 —— 而出厂 defaultWorkspace 就是主目录。用户看到的「同一个文件夹被
  // 占着」是这么来的。
  // W7(用户 2026-09-24「管家需要把工作区和任务联系起来,有时候很多任务应该在特定工作区开的,管家会
  // 新开工作区」):光有末段名不够 —— ① 校验只收绝对路径,模型照表填名字一律被拒;② 名字说不出「这个
  // 文件夹是干什么的」,模型没法把「帮我再跑一遍那个测试」对到某个仓库上。所以每行现在带:名字(cwd
  // 能原样填回去的那个值,13k stewardKnownWorkspaces 造、stewardMatchKnownWorkspace 收)、标记(默认 /
  // 只读 / 我开的 / 用户写的备注)、最近在那儿做过的几件事(线程显示名 + 所属事项)。
  //
  // 为什么它只能是投影:看得见 ≠ 改得了。三个键(workspaces / stewardWorkspaceRoot / defaultWorkspace)
  // 仍然全是 forbidden,steward_config_set 一个都改不了。两道闸不合成一道。
  //
  // 硬纪律(与 06b 那几行的头注同一份,谁改都要一起守):
  //   ① 只投影【名字 + 标记 + 线程名】。全路径不进(围栏信息),更不许出现 allowOutsideWorkspace /
  //      additionalDirectories 这类围栏字段 —— 管家看得见围栏开关就等于知道往哪推。
  //   ② 数据源只有 config.workspaces 与如意自己那张表(stewardManagedWorkspaces)。recentWorkspaces
  //      【不进】:打开过 ≠ 授权过。线程只用来【注解】已知工作区,落在已知工作区之外的线程不生出新行。
  //   ③ 预算:行数上限读 STEWARD_WORKSPACE_TABLE_MAX(与 13k 拒绝文案同一个数),另有 06i 的
  //      STEWARD_KNOWN_WORKSPACE_LIMITS(每行几条线程、线程名多长、一行多长、整块多长)。超出折叠成一句
  //      「另有 N 个未列出」,不截断 —— 截断会让模型以为清单就那么长。
  //   ④「只读」标来自 write === false(§11.19.7 裁决)。判据写死 `=== false`:缺字段的老配置默认可写。
  //
  // 排序:默认工作区永远第一行;其余按「最近在那儿干过活」的先后;从没干过活的排最后(用户的按表里的
  // 优先级,我开的按新到旧)。我开的文件夹若已经不在磁盘上、也没有线程,整行不出(那只是一条陈旧登记)。

  return { stewardThreadDigestRows, stewardOverviewBlock };
}

module.exports = { createStewardThreadOverview };
