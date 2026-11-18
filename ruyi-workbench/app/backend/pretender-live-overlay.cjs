'use strict';
const { pretenderHash } = require('./pretender-http-projection.cjs');

function createPretenderLiveOverlay({ state, cards }) {
  const {
    EventStreamHooks, activeAgentRuns, activeChildren, agentRunHealth, getIndexedPretenderSessionIds,
    sessionExecutionSnapshot, stewardThreadTurnQueued,
  } = state;
  const { missionRunDigest, nowIso, stewardAsksYouForThread } = cards;

  // ETag includes volatile overlay state, while pagination cursors deliberately carry only the persistent
  // projection revision. A run/turn heartbeat therefore refreshes conditional reads without invalidating pages.
  function pretenderLiveOverlayRevision(sessionId = '') {
    const sid = String(sessionId || '');
    const rows = [];
    const sessionIds = sid ? [sid] : getIndexedPretenderSessionIds();
    for (const id of sessionIds) rows.push(['execution', id, sessionExecutionSnapshot(id), stewardThreadTurnQueued(id)]);
    // 121-K3:活回合这一行带上 liveTail 摘要的三个值。修前它只有 ['turn', id] —— 一个回合从起跑到
    // 收工整段时间里 ETag 一动不动,而卡片上的「正在调什么」每几百毫秒就变一次,兜底轮询于是永远
    // 拿 304、永远画着第一帧。overlayMissionCard 往卡片里放了什么,这里就得跟着算什么。
    for (const [id, reg] of activeChildren) {
      if (sid && id !== sid) continue;
      const tail = (reg && reg.liveTail && typeof reg.liveTail === 'object') ? reg.liveTail : null;
      rows.push(['turn', id, tail ? String(tail.tool || '') : '', tail ? String(tail.updatedAt || '') : '',
        tail ? Math.max(0, Number(tail.iterations) || 0) : 0]);
    }
    // 同理:在场(§4.3 的 seatedBy)也进卡片,也就必须进这份 revision —— 用户从 X 换坐到 Y,
    // 两行卡片的 seatedBy 都变了,ETag 不动的话左栏要等到下一次会话头写盘才更新。
    try {
      const presence = typeof EventStreamHooks.presenceSnapshot === 'function' ? EventStreamHooks.presenceSnapshot() : [];
      for (const row of (Array.isArray(presence) ? presence : [])) {
        const seated = String((row && row.sessionId) || '');
        if (!seated || (row && row.lens) !== 'classic') continue;
        if (sid && seated !== sid) continue;
        rows.push(['seat', seated]);
      }
    } catch { /* 在场读不到就当没人坐着 —— 与 overlayMissionCard 同一条 fail-open */ }
    for (const runtime of activeAgentRuns.values()) {
      const run = runtime && runtime.run;
      if (!run || (sid && run.sessionId !== sid)) continue;
      rows.push(['run', run.sessionId, run.id, run.status, Number(run.eventSeq) || 0, run.updatedAt || '', Boolean(runtime.paused), agentRunHealth(run, true)]);
    }
    rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return pretenderHash(rows);
  }

  // overlayAt:批量调用方(GET /api/missions、聚合装配)传入同一个「叠加时刻」,省掉逐行 nowIso();不传则各取各的(其余调用方不变)。
  function overlayMissionCard(slice, overlayAt) {
    const card = slice && slice.card;
    if (!card) return null;
    const liveRuns = [];
    for (const runtime of activeAgentRuns.values()) if (runtime && runtime.run && runtime.run.sessionId === slice.sessionId) liveRuns.push(runtime.run);
    liveRuns.sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
    const latestLive = liveRuns.length ? liveRuns[liveRuns.length - 1] : null;
    const activeTurn = activeChildren.has(slice.sessionId);
    // hunt3:回合排在 13n 仲裁器里(还没进 activeChildren)—— 五态 queued 证据键,与 activeTurn 同一条「只活在叠加层」纪律。
    const queued = stewardThreadTurnQueued(slice.sessionId);
    // 117l D4(§11.9):「它在问你」只活在叠加层 —— 待决的死活与活回合都是此刻的事实,写进持久卡片
    // 就会在下一次重建前一直说谎(与 activeTurn / lastRun 同一条纪律)。判据单点同样是 06i 的 stewardAsksYou。
    // 117m-A2:判据单点从 stewardAsksYou 换成 stewardAsksYouForThread —— 后者认【四类待决】
    // (question > permission > plan > pool),而这里修前只挑 question,于是挂着 permission 的线程
    // 在看板行永远拿不到 asksYou(用户第六轮走查⑥:标着「需要你」的行上一枚 pill 都没有)。
    // 抽取待决行的那一段一并搬进 06i:两个调用面(13g 与本处)现在喂的是同一个入参形状。
    const pending = (Array.isArray(slice.interventions) ? slice.interventions : [])
      .filter(iv => iv && iv.status === 'pending');
    const asksYou = stewardAsksYouForThread({
      pending,
      activeTurn,
      lastAssistantText: String(card.lastSay || ''),
    });
    // 121-K3(§4.2「行加 liveTail 摘要」/ §5「左栏在跑组每行的第二行」):正在调什么工具、第几次、
    // 什么时候有的输出。**摘要不带正文** —— `text`/`full` 一个字都不进来(§6.1 的红线:观察面不承载
    // 工具输出正文;要正文的面走 GET /api/sessions/:id 的 liveTail,那里有自己的预算与门)。
    // 没有活回合就是 null,不编一个空壳出来让消费者分不清「没在跑」与「在跑但还没输出」。
    const liveReg = activeTurn ? activeChildren.get(slice.sessionId) : null;
    const liveTailReg = (liveReg && liveReg.liveTail && typeof liveReg.liveTail === 'object') ? liveReg.liveTail : null;
    const liveTail = liveTailReg ? {
      tool: String(liveTailReg.tool || ''),
      updatedAt: String(liveTailReg.updatedAt || ''),
      iterations: Math.max(0, Number(liveTailReg.iterations) || 0),
    } : null;
    // 121-K3(§4.3/§4.5):用户此刻是不是就坐在这条线程前面。事实源是 13r 的在场快照(SSE 连接自报的
    // lens/sessionId),经 00-boot 的延迟绑定命名空间取 —— 13e 拼在 13r 之前,直引 13r 的符号是前向边。
    // 钩子没填充(13r 还没加载 / 事件流关着)或抛错,一律当「没人坐着」:在场信号缺席时管家照旧行事,
    // 这是 fail-open,因为它管的是【打扰纪律】不是权限。
    let seatedBy = null;
    try {
      const presence = typeof EventStreamHooks.presenceSnapshot === 'function' ? EventStreamHooks.presenceSnapshot() : [];
      if (Array.isArray(presence) && presence.some(row => row && row.lens === 'classic' && String(row.sessionId || '') === slice.sessionId)) {
        seatedBy = 'user';
      }
    } catch { seatedBy = null; }
    return {
      ...card,
      // 121-K3:两个持久字段随卡片一起下发(切片上有,卡片上没有 —— 消费者读的是卡片)。
      origin: String(slice.origin || 'user'),
      watched: slice.watched === true,
      liveTail,
      seatedBy,
      activeTurn,
      execution: sessionExecutionSnapshot(slice.sessionId),
      queued,
      asksYou,
      runCount: Math.max(Number(card.runCount) || 0, liveRuns.length),
      lastRun: latestLive ? missionRunDigest(latestLive, true) : card.lastRun,
      healthRuns: [...new Map([
        ...(Array.isArray(card.healthRuns) ? card.healthRuns : []).map(run => [run.id, run]),
        ...liveRuns.map(run => [run.id, missionRunDigest(run, true)]),
      ]).values()],
      freshness: {
        persistentRevision: slice.cardRevision || slice.missionRevision,
        indexedAt: slice.indexedAt,
        liveOverlay: activeTurn || queued || liveRuns.length > 0,
        overlayAt: overlayAt || nowIso(),
      },
    };
  }

  return { pretenderLiveOverlayRevision, overlayMissionCard };
}

module.exports = { createPretenderLiveOverlay };
