'use strict';
const fsp = require('node:fs/promises');
const { pretenderHash } = require('./pretender-http-projection.cjs');

function createPretenderSessionProjection({ store, model, usage, index }) {
  const {
    compactInterventionJournal, interventionJournalWorthCompacting, listAgentRuns, readInterventionsWithMeta,
    safeJsonParse, safeSessionId, sessionPath,
  } = store;
  const {
    activeChildren, buildMissionCard, nowIso, sessionKind, sessionMissionId, stewardWatchedThread,
    threadOriginOf, threadVisible,
  } = model;
  const { forEachUsageRow } = usage;
  const { onSliceBuild, pretenderSessionSourceStamp } = index;

  function emptyMissionUsage() {
    return { inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, subagentTurns: 0, costsByCurrency: {} };
  }

  function addMissionUsageRow(usage, row) {
    usage.inTok += Number(row && row.inTok) || 0;
    usage.outTok += Number(row && row.outTok) || 0;
    usage.cachedInTok += Number(row && row.cachedInTok) || 0;
    usage.turns += 1;
    if (row && row.kind === 'subagent') usage.subagentTurns += 1;
    const cost = Number(row && row.cost);
    const currency = row && typeof row.currency === 'string' ? row.currency : '';
    if (row && row.costTrusted !== false && currency && Number.isFinite(cost)) {
      usage.costsByCurrency[currency] = (usage.costsByCurrency[currency] || 0) + cost;
    }
  }

  function finishMissionUsage(usage) {
    for (const key of Object.keys(usage.costsByCurrency)) usage.costsByCurrency[key] = Math.round(usage.costsByCurrency[key] * 1e6) / 1e6;
    return usage;
  }

  // sessionIds(可选):只聚合这几条会话 —— 每轮对话后的增量刷新只需要被打了 usage 脏页的那几条(性能批 P1)。
  async function buildMissionUsageMap(sessionIds = null) {
    const map = new Map();
    await forEachUsageRow(0, row => {
      const sid = String(row && row.sessionId || '');
      if (!sid) return;
      let usage = map.get(sid);
      if (!usage) map.set(sid, usage = emptyMissionUsage());
      addMissionUsageRow(usage, row);
    }, sessionIds ? { sessionIds } : {});
    for (const usage of map.values()) finishMissionUsage(usage);
    return map;
  }

  async function buildPretenderSessionSlice(sessionId, sourceStamp, usage, recentIds) {
    const sid = safeSessionId(sessionId);
    if (!sid) return null;
    onSliceBuild();
    const head = safeJsonParse(await fsp.readFile(sessionPath(sid), 'utf8').catch(() => ''), null);
    let ivMeta = await readInterventionsWithMeta(sid);
    if ((!head || !head.id) && ivMeta.bytes === 0) return null;
    // External/legacy journals also get bounded maintenance on a rebuild. Never compact degraded authority.
    if (!ivMeta.degraded && interventionJournalWorthCompacting(ivMeta)) {   // 判据与 02 自己的周期压实同一个(修前这里也是 ×3,永不触发)
      await compactInterventionJournal(sid).catch(() => {});
      ivMeta = await readInterventionsWithMeta(sid);
      sourceStamp = await pretenderSessionSourceStamp(sid);
    }
    const kind = head && head.id ? sessionKind(head) : 'orphan';
    const missionId = (head && sessionMissionId(head)) || sid;
    // ── 卡片的产生条件(121-K3,34 号文 §4.2「索引口径」)────────────────────────────────────
    // 117r-D1 把它从「只给 mission 造」放宽到「mission ∪ 管家关心的线程」,理由写在那一版注释里
    // (管家开的速查线程当时在看板上根本不存在)。但那一版仍是【一个判据管两件事】:
    // 「管家要不要动手」同时当成了「它要不要出现在索引里」,于是用户自己在 2.0 里开的普通会话
    // (missionId === sessionId、无 stewardQuick、无 launchedBy)永远不进 /api/missions ——
    // §1.3 数过的那条病根,而它当时被写成「刻意的,理由是噪音」。
    //
    // K3 把一个判据拆成两个(判据本体都在 06i,这里只消费,不新造):
    //   · watched = stewardWatchedThread —— 管家要不要为它动手(收件箱第四源用的还是这一条);
    //   · visible = threadVisible —— 它要不要进索引。四条并集:在途 ∪ 今天有动静 ∪ 最近 N 条 ∪ watched。
    // 噪音不再靠「把整类线程挡在门外」治,靠【窗口】治(§4.2):几百条旧会话既不在途、今天也没动静、
    // 又排不进最近 N 条,自然不进索引;进了索引的旧线程在界面上也只落「更早」组。
    //   · inFlight 是「五态非 done/stopped」的机器事实那一半:此刻有活回合,或挂着未决。
    //     两者都是这里现成的(activeChildren 与刚读出来的 ivMeta),不为它多读一次盘。
    //   · recentIds 由调用方一次算好整份(pretenderRecentSessionIds),每条会话只做一次 Set 查询。
    // 注:orphan(只有 Intervention journal、没有会话头)天然为 false —— 两个判据的第一行都挡住
    // head 为空的情况,不必在这里再写一道。
    const watched = stewardWatchedThread(head, sid, missionId);
    const origin = threadOriginOf(head);
    const inFlight = activeChildren.has(sid)
      || (Array.isArray(ivMeta.interventions) && ivMeta.interventions.some(iv => iv && iv.status === 'pending'));
    const carded = kind === 'mission' || threadVisible(head, {
      now: Date.now(),
      watched,
      inFlight,
      recent: recentIds instanceof Set ? recentIds.has(sid) : false,
    });
    const runs = carded ? await listAgentRuns(sid).catch(() => []) : [];
    const card = carded
      ? await buildMissionCard(head, runs, { interventions: ivMeta.interventions, persistent: true })
      : null;
    const usageFact = usage || emptyMissionUsage();
    const changeSeq = Math.max(0, Number(head && head.mission && head.mission.changeSeq) || 0);
    // 121-K3:origin/watched 进哈希。它们是【持久】字段(跟着切片落盘),不进哈希的话
    // 「用户按下交给管家盯」这种只改 stewardWatch 的写会拿不到新 ETag,左栏画的还是旧标。
    const cardRevision = pretenderHash({ missionId, changeSeq, card, origin, watched });
    const missionRevision = pretenderHash({ cardRevision, usage: usageFact });
    // Health is part of the semantic projection, but physical row/byte counts are not (compaction must keep
    // revision stable). A newly corrupt authority line therefore invalidates ETags even when valid facts match.
    const interventionRevision = pretenderHash({ interventions: ivMeta.interventions, degraded: ivMeta.degraded, corruptLines: ivMeta.corruptLines });
    return {
      sessionId: sid,
      missionId,
      kind,
      // 121-K3(§4.1):来源三值与「管家盯着没有」。两个都是从会话头派生的持久事实,行上直接带着 ——
      // 消费者(左栏、总览、收件箱)零改动即能画来源图形与「交给管家盯」的开关态。
      origin,
      watched,
      changeSeq,
      sourceStamp,
      indexedAt: nowIso(),
      card,
      usage: usageFact,
      interventions: ivMeta.interventions,
      integrity: { degraded: ivMeta.degraded, corruptLines: ivMeta.corruptLines, journalRows: ivMeta.rowCount, journalBytes: ivMeta.bytes },
      cardRevision,
      missionRevision,
      interventionRevision,
      revision: pretenderHash([missionRevision, interventionRevision]),
    };
  }

  return { buildMissionUsageMap, buildPretenderSessionSlice, emptyMissionUsage };
}

module.exports = { createPretenderSessionProjection };
