'use strict';

function createMissionCardProjection({
  readInterventions, computeWaveSeq, nodeDeliveryEligibility, activeAgentRuns, agentRunHealth,
  sessionMissionId, sessionKind, sessionDisplayTitle, sessionBriefOf, activeChildren,
  sessionExecutionSnapshot, stewardThreadTurnQueued,
}) {
  // ============================================================================
  // 第70波(EC-E Mission Ready 首切片):/api/missions 聚合只读投影。
  // 纪律:①纯读模型 —— 不复制第二套执行状态机,快照全部从既有权威源(mission 账本 / run 快照 /
  // checkpoint journal / usage 月度账本 / 内存 pending 注册表)现算;②旧会话适配只读派生(sessionKind),
  // 绝不回写磁盘;③列表只读会话头文件(<id>.json 含 mission,不触 messages/provider 正文),详情才全量加载。
  // ============================================================================

  // 卡片/快照共用的状态派生:complete(全部里程碑 done) > active(until-done 驱动中) > paused(supervised =
  // 预算耗尽/停滞/用户接管后的待命态) > idle(off 且未完成)。mission 缺失时不应出现在任务列表('none')。
  function missionCardStatus(m) {
    if (!m) return 'none';
    const ms = Array.isArray(m.milestones) ? m.milestones : [];
    if (ms.length > 0 && ms.every(x => x && x.status === 'done')) return 'complete';
    if (m.autoMode === 'until-done') return 'active';
    if (m.autoMode === 'supervised') return 'paused';
    return 'idle';
  }

  // 未决事项统一读形(第71b:四源统一 —— permission/question/plan/pool 全部从 session.interventions NDJSON 现算)。
  // 前三者此前是纯内存 Map(04-permission-runtime:191/194/199),重启即归零;71 波旁路持久化为 Intervention(02
  // append-only NDJSON),重启终态化(markInterruptedInterventions)后 pending 标 cancelled_restart -> 计数归零。
  // 71b 池提案统一进来:paused run 的提案恢复后仍可审批,boot 对账补登记 + markInterruptedInterventions 按 run
  // 状态分流保留 pending(见 02/08);run 快照扫描仅作并集兜底(append 落盘延迟 + 对账前存量),按 id 去重不双计。
  async function missionPendingCounts(sessionId, runs, interventions) {
    const ivs = Array.isArray(interventions) ? interventions : await readInterventions(sessionId).catch(() => []);
    let permissions = 0, questions = 0, plans = 0, pool = 0;
    const poolPendingIds = new Set();
    for (const iv of ivs) {
      if (!iv || iv.status !== 'pending') continue;
      if (iv.type === 'permission') permissions++;
      else if (iv.type === 'question') questions++;
      else if (iv.type === 'plan') plans++;
      else if (iv.type === 'pool') { pool++; poolPendingIds.add(String(iv.id)); }
    }
    for (const r of (runs || [])) for (const item of ((r && r.taskPool) || [])) {
      if (item && item.status === 'proposed' && !poolPendingIds.has(String(item.id))) { pool++; poolPendingIds.add(String(item.id)); }
    }
    return { permissions, questions, plans, pool };
  }

  function clipMissionRunText(value, max = 360) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function lastMissionRunProgress(node) {
    const rows = Array.isArray(node && node.progressLog) ? node.progressLog : [];
    for (let index = rows.length - 1; index >= 0; index--) if (rows[index]) return rows[index];
    return null;
  }

  // 第82波班组图只消费这份精简节点投影。节点结果、角色快照、工具证据等大字段仍留在 Agent Run
  // 权威文件；Mission 详情只带画图和递话资格所需事实，避免复制运行状态机或把 24KB result 带进任务单。
  function missionRunGraph(src, live) {
    const nodes = Array.isArray(src && src.nodes) ? src.nodes : [];
    // 第98波(P5-A):真实调度波次 -- 按并发上限+wait 模拟派发,下发给前端班组图分列(替代纯拓扑层)。
    const waveSeq = computeWaveSeq(nodes, {
      concurrency: Number(src && src.concurrency) || 1,
      isWaitNode: n => !!(n && n.wait),
    });
    return {
      nodes: nodes.map(node => {
        // Read backwards instead of cloning/filtering a potentially long progress history on every Preview poll.
        const progress = lastMissionRunProgress(node);
        const eligibility = live
          ? nodeDeliveryEligibility(src, String(node && node.id || ''), { allowClaude: true })
          : { ok: false, reason: 'not_live' };
        return {
          id: String(node && node.id || ''),
          status: String(node && node.status || ''),
          roleId: String(node && (node.roleId || node.role) || ''),
          roleLabel: clipMissionRunText(node && node.roleLabel, 80),
          task: clipMissionRunText(node && node.task, 520),
          dependsOn: Array.isArray(node && node.dependsOn) ? node.dependsOn.map(value => String(value || '')).filter(Boolean).slice(0, 16) : [],
          engine: String(node && node.engine || ''), model: clipMissionRunText(node && node.model, 100),
          progress: clipMissionRunText(progress && progress.text, 220),
          startedAt: String(node && node.startedAt || ''), completedAt: String(node && node.completedAt || ''),
          fromPool: node && node.fromPool === true, proposedBy: String(node && node.proposedBy || ''),
          deterministic: Boolean(node && node.gate && ['vote', 'dedupe', 'coverage', 'propagate'].includes(node.gate.mode)),
          steerable: eligibility.ok === true, steerReason: String(eligibility.reason || ''),
          ...(waveSeq.has(String(node && node.id || '')) ? { wave: waveSeq.get(String(node && node.id || '')) } : {}),
        };
      }),
      proposals: (Array.isArray(src && src.taskPool) ? src.taskPool : [])
        .filter(item => item && item.status === 'proposed')
        .map(item => ({
          id: String(item.id || ''), status: 'proposed', proposedBy: String(item.proposedBy || ''),
          task: clipMissionRunText(item.task, 520), reason: clipMissionRunText(item.reason, 220),
          roleId: String(item.roleId || ''),
          dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(value => String(value || '')).filter(Boolean).slice(0, 16) : [],
        })),
    };
  }

  // run 摘要投影(对齐 /api/agent-runs?view=digest 的标量集 + 用量字段;live run 以内存为准)。
  // includeGraph 仅供单 Mission 详情使用；300 Mission 列表和 75c 索引继续保持标量热路。
  function missionRunDigest(r, includeLive = true, includeGraph = false) {
    const live = includeLive ? activeAgentRuns.get(r.id) : null;
    const mem = live && live.run ? live.run : null;
    const src = mem || r;
    const digest = {
      id: src.id, status: src.status, eventSeq: Number(src.eventSeq) || 0,
      createdAt: src.createdAt || '', updatedAt: src.updatedAt || '', completedAt: src.completedAt || '',
      nodeCount: Array.isArray(src.nodes) ? src.nodes.length : 0,
      poolPending: ((src.taskPool) || []).filter(p => p && p.status === 'proposed').length,
      live: !!live, paused: !!(live && live.paused), resumeTier: src.resumeTier || '',
      health: agentRunHealth(src, !!live),
      totalTokens: Number(src.totalTokens) || 0, costUsd: Number(src.costUsd) || 0,
    };
    if (includeGraph) Object.assign(digest, missionRunGraph(src, live));
    return digest;
  }

  // 列表卡片:从会话头文件投影(头含 mission,见 saveSession 头/正文拆分)。
  async function buildMissionCard(head, runs, opts = {}) {
    // 116-4 第 0 步（复现出来的根因）：kind 是 'mission' 但头上【没有】mission 容器的会话是
    // 真实形状 —— steward_thread_new 建线程时显式写 kind='mission'，mission 容器要等
    // /api/mission start 才有。修前这里 m.goal 直接读 null，而 buildPretenderSessionSlice 没有
    // try，rebuildPretenderIndexFull 的 Promise.all 整份 reject：GET /api/missions、/api/missions/<id>、
    // GET /api/interventions 全部 500，收件箱每轮 tick 抛 "Cannot read properties of null (reading 'goal')"
    // 三个源一起停摆 —— 这正是「线程跑完管家没被唤醒」的第一层根因。
    // missionCardStatus(null) 早就返回 'none'（故它仍收 m 而不是 mm，否则 {} 会变成 'idle'）——
    // 本函数其余部分本来就是按「可能没有 mission」写的，只有下面那一段漏了守卫。
    const m = head.mission;
    const mm = (m && typeof m === 'object') ? m : {};
    const ms = Array.isArray(mm.milestones) ? mm.milestones : [];
    return {
      // 117r-D1:kind 从写死的 'mission' 改成【如实】取 sessionKind(head)。修前唯一的调用面是
      // 13e「kind === 'mission' 才造卡片」,所以这个字面量恒等于真值;现在管家关心的速查线程也有卡片了,
      // 再写死就是撒谎。mission 会话(含 steward_thread_new 那种 kind='mission' 但没有 mission 容器的)
      // 走 sessionKind 仍然返回 'mission',既有行为逐字不变。
      // 117r-D5:这个字段的【消费者换了一批】。修前它是五态第一条分支的守卫入参(kind === 'quick_ask'
      // 就短路),所以谎报会让速查线程顶着「交办中/已收工」;修后五态不再读 kind(守卫改看
      // factsUnknown),它转而是「这条线程是什么」的唯一出处 —— 看板行上那枚速查徽标
      // (public/js/steward-board.js 读 row.kind)就靠它。谎报的后果从「状态说错」变成「身份说错」,
      // 如实取 sessionKind 这件事因此比修前更要紧,不是更松。
      sessionId: head.id, missionId: sessionMissionId(head), title: head.title || '', cwd: head.cwd || '', kind: sessionKind(head),
      ...(head.pinned === true ? { pinned: true } : {}),
      // 121-K3(34 号文 §4.2):`kind` 与「这是不是一条速查线程」**从这一刀起不再是同一件事**。
      // 修前 13e 只给 mission 与【管家关心的】线程造卡片,于是「有卡片 + kind==='quick_ask'」恰好等价于
      // 「管家用 steward_quick_ask 开的速查线程」—— 117r-D5 那段注释就是建立在这个巧合上的。
      // K3 把索引口径放宽成 threadVisible 之后,用户自己在 2.0 里聊的普通会话也有卡片了,而 sessionKind
      // 对它们同样返回 'quick_ask'(第 70 波的「纯问答默认档」,那是【档位】不是【身份】)—— 巧合破了。
      // 所以身份单独给一格,判据与 13j 的 stewardQuickThread 逐字同源(头上有没有 stewardQuick 容器):
      // 速查线程是管家为了回答一个问题临时开的,普通会话不是,两者在同一个 kind 里区分不开。
      quick: !!(head.stewardQuick && typeof head.stewardQuick === 'object'),
      // 116-5b(§11.8.5):这条线程该显示什么名字,由 02 的 sessionDisplayTitle 一处判定(人起的 >
      // 生成的 > 原话),前端只读结果不再算一遍 —— 与本行已有的 stateLabel / missionTitle / wait.label
      // 同一条纪律(读模型里本来就有一批服务端算好的显示串)。title 保持原话不动。
      // brief 单独带出是为了那句 gist(名字之外还要一句人话概括,抽屉与搜索结果要用);缺席时不出现。
      displayTitle: sessionDisplayTitle(head),
      // 117l D4(§11.9):最后一句助手原话的头部(= head.summary,09 收尾处写的前 160 字,不经模型改写)。
      // 看板行的「它在问你」要判「末句是不是问号」,而 13e 的活叠加层只拿得到卡片 —— 没这一个字段就只能
      // 每行再读一次会话头。只是会话头已有字段的投影,不新增任何持久化来源。
      // **注意截断**:summary 只有 160 字,长回复的末句问号会被截掉 —— 漏报是安全的(不会把不是问句
      // 的说成问句),完整判定在 steward_thread_status(那里会话正文已装载)。
      lastSay: String(head.summary || ''),
      ...(sessionBriefOf(head) ? { brief: sessionBriefOf(head) } : {}),
      createdAt: head.createdAt || '', updatedAt: head.updatedAt || '',
      status: missionCardStatus(m),
      // 117p-S2(30 号文 §8.3):五态判据需要的两个卡片字段 —— 都只是会话头已有字段的投影,不新增
      // 持久化来源(与 lastSay / displayTitle 同一条纪律)。缺了它们,两份五态抄写件只能把 turnSeq
      // 硬编码成 0,于是「跑过回合但头上没有 mission 账本」的管家线程永远落不进 done/stopped。
      turnSeq: Math.max(0, Number(head.turnSeq) || 0),
      lastTurn: head.stewardLastTurn && typeof head.stewardLastTurn === 'object'
        ? { seq: Math.max(0, Number(head.stewardLastTurn.seq) || 0), ok: head.stewardLastTurn.ok !== false, aborted: head.stewardLastTurn.aborted === true }
        : null,
      activeTurn: opts.persistent ? false : activeChildren.has(head.id), // 75c:live overlay 不写进可重建持久索引
      ...(opts.persistent ? {} : { execution: sessionExecutionSnapshot(head.id) }),
      ...(opts.persistent ? {} : { queued: stewardThreadTurnQueued(head.id) }), // hunt3:排队中的回合,同上只活在叠加层
      mission: {
        goal: mm.goal || '', createdAt: mm.createdAt || '', updatedAt: mm.updatedAt || '',
        autoMode: mm.autoMode || 'off',
        milestonesTotal: ms.length,
        done: ms.filter(x => x && x.status === 'done').length,
        blocked: ms.filter(x => x && x.status === 'blocked').length,
        pending: ms.filter(x => !x || x.status === 'pending').length,
        budget: mm.budget || { maxAutoTurns: 0, maxTokens: 0 },
        spent: mm.spent || { autoTurns: 0, tokens: 0 },
        budgetExhausted: Boolean(mm.budgetExhaustedAt), budgetExhaustedAt: String(mm.budgetExhaustedAt || ''),   // 后者给管家收件箱当去重键:任务重启后再次用尽是新的一件事
        // 第72波:结果章存根(列表卡片只带状态+时间,明细走详情快照 result)
        result: (mm.result && typeof mm.result === 'object') ? { status: mm.result.status || '', finishedAt: mm.result.finishedAt || '' } : null,
      },
      pending: await missionPendingCounts(head.id, runs, opts.interventions),
      runCount: (runs || []).length,
      lastRun: runs && runs.length ? missionRunDigest(runs[runs.length - 1], !opts.persistent) : null,
      // Latest persisted run plus every live run: a healthy newer run cannot hide an older live fault.
      healthRuns: missionHealthRuns(head.id, runs, !opts.persistent),
    };
  }

  function missionHealthRuns(sessionId, runs, includeLive = true) {
    const latest = (Array.isArray(runs) ? runs : []).filter(run => run && run.id)
      .slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id).localeCompare(String(a.id)))[0];
    const byId = new Map();
    if (latest) byId.set(latest.id, missionRunDigest(latest, includeLive));
    if (includeLive) for (const runtime of activeAgentRuns.values()) {
      const run = runtime && runtime.run;
      if (run && run.sessionId === sessionId) byId.set(run.id, missionRunDigest(run, true));
    }
    return [...byId.values()];
  }

  return Object.freeze({ buildMissionCard, missionCardStatus, missionPendingCounts, missionRunDigest, missionHealthRuns });
}

module.exports = { createMissionCardProjection };
