'use strict';
const { SESSION_SEARCH_MIN_QUERY } = require('./session-search.cjs');

function createStewardThreadQueries({
  redact, safeSessionId, getPromptPack,
  sessions, projection, runtime, workspaces, policy, tools, limits,
}) {
  const {
    isUntitledSessionTitle, listSessions, loadSession, readInterventions, readMissionContainer,
    SESSION_BRIEF_TITLE_CHARS, sessionBriefOf, sessionDisplayTitle, sessionMeta, sessionMetaIsSteward,
    sessionMissionId, stewardReadSessionHead,
  } = sessions;
  const {
    buildMissionAggregateRows, getPretenderProjectionIndex, missionPendingCounts, overlayMissionCard,
    searchSessionsByContent, sessionSearchScope, sessionSearchIndexEnabled,
    stewardPendingExecutionSummary, stewardExemptPendingSummary,
  } = projection;
  const {
    activeChildren, sessionExecutionSnapshot, sessionPermissionModeOf, StewardHooks,
  } = runtime;
  const {
    stewardKnownWorkspaces, stewardWorkspaceNameOf, stewardCanonWorkspacePath,
  } = workspaces;
  const {
    deriveStewardThreadState, stewardAsksYouForThread, stewardClipSay, stewardForeignProjection,
    stewardPendingOneLine, stewardPermissionLabel, stewardSanitizeBlock, stewardSanitizeText,
    stewardThreadStateFromCard, stewardThreadStateFromHead, waitReasonFor,
  } = policy;
  const {
    stewardClampInt, stewardDisplayKind, stewardEngineOf, stewardFail, stewardLastAssistantText,
    stewardQuickClosed, stewardQuickThread, stewardRawKind, stewardReadBucket, stewardThreadPermissionMode,
    stewardTurnKeyOf,
  } = tools;
  const {
    STEWARD_PENDING_SUMMARY_MAX, STEWARD_READ_CALLS_PER_TURN, STEWARD_READ_CHARS_DEFAULT, STEWARD_READ_CHARS_MAX,
    STEWARD_READ_CHARS_MIN, STEWARD_READ_CLIP_MARK, STEWARD_READ_ROW_OVERHEAD, STEWARD_READ_TAIL_DEFAULT,
    STEWARD_READ_TAIL_MAX, STEWARD_SEARCH_LIMIT_DEFAULT, STEWARD_SEARCH_LIMIT_MAX,
  } = limits;

  // One ephemeral metadata grouping per lookup/overview; no history scan or separate store.
  function threadRelationsIndex(metas) {
    const index = { byId: new Map(), missions: new Map(), workspaces: new Map(), sources: new Map() };
    const add = (map, key, meta) => { if (!key) return; if (!map.has(key)) map.set(key, []); map.get(key).push(meta); };
    for (const meta of (Array.isArray(metas) ? metas : [])) {
      if (!meta || sessionMetaIsSteward(meta)) continue;
      index.byId.set(meta.id, meta);
      add(index.missions, sessionMissionId(meta), meta);
      add(index.workspaces, stewardCanonWorkspacePath(meta.cwd), meta);
      add(index.sources, meta.relatedSessionId, meta);
    }
    return index;
  }
  function threadRelatedThreads(head, metas) {
    const index = metas && metas.byId instanceof Map ? metas : threadRelationsIndex(metas);
    const missionId = sessionMissionId(head);
    const cwd = stewardCanonWorkspacePath(head && head.cwd);
    const candidates = new Map();
    const add = (rows, reason) => { for (const meta of rows || []) {
      if (meta.id === head.id) continue;
      if (!candidates.has(meta.id)) candidates.set(meta.id, { meta, reasons: [] });
      candidates.get(meta.id).reasons.push(reason);
    } };
    const source = index.byId.get(head.relatedSessionId);
    add(source ? [source] : [], 'source');
    add(index.sources.get(head.id), 'derived');
    add(index.missions.get(missionId), 'same_mission');
    add(index.workspaces.get(cwd), 'same_workspace');
    return [...candidates.values()].sort((a, b) => {
      const rank = row => row.reasons.some(reason => reason === 'source' || reason === 'derived') ? 0 : row.reasons.includes('same_mission') ? 1 : 2;
      return rank(a) - rank(b) || String(b.meta.updatedAt || '').localeCompare(String(a.meta.updatedAt || ''));
    }).slice(0, 4).map(({ meta, reasons }) => ({
      sessionId: meta.id, title: stewardSanitizeText(redact(String(meta.title || '')), true), updatedAt: String(meta.updatedAt || ''), reasons,
    }));
  }

  // 2) steward_threads_search —— 113b 的会话内容搜索核心(不走 HTTP)+ 标题词法兜底。
  function stewardRecentUserRequest(o) {
    const request = sessionMeta(o).recentUserRequest;
    return request ? { ...request, text: stewardSanitizeText(redact(request.text), true) } : null;
  }
  function stewardThreadDisplayTitle(head, config) {
    let title = sessionDisplayTitle(head);
    if (head?.titleSource !== 'user' && isUntitledSessionTitle(title)) {
      const request = stewardRecentUserRequest(head);
      title = request?.text ? [...request.text].slice(0, SESSION_BRIEF_TITLE_CHARS).join('')
        : /^en/i.test(String(config?.locale || '')) ? 'Unnamed thread' : '未命名线程';
    }
    return stewardSanitizeText(redact(String(title || '')), true);
  }
  async function stewardImplThreadsSearch(args, ctx, config) {
    const q = String(args.q || '').trim();
    const limit = stewardClampInt(args.limit, 1, STEWARD_SEARCH_LIMIT_MAX, STEWARD_SEARCH_LIMIT_DEFAULT);
    const includeClosed = args.includeClosed === true;   // 116-2e:把已收工的速查线程也算进来
    const scope = sessionSearchScope(sessionSearchIndexEnabled(config));
    if (!q) return { ok: true, query: '', results: [], indexed: 0, scope, reason: 'query_empty' };
    // 第二轮工具走查(F8):13f 的描述一直写「太短(少于 2 字)返回空结果并给 reason」,实现却放行了 1 个字
    // (走词法兜底,于是 q:'x' 满屏命中)。与经典壳 GET /api/sessions/search(13d)同一个下限、同一个 reason 码。
    if (q.length < SESSION_SEARCH_MIN_QUERY) return { ok: true, query: q, results: [], indexed: 0, scope, reason: 'query_too_short' };
    const metas = await listSessions().catch(() => []);
    const byId = new Map(metas.map(meta => [meta.id, meta]));
    const relations = threadRelationsIndex(metas);

    let ranked = [];        // [{ id, score }]
    let indexed = 0;
    let degraded = '';
    if (sessionSearchIndexEnabled(config)) {
      // 内容索引在:直接用 113b 的核心函数(GET /api/sessions/search 背后那一个)。
      const found = await searchSessionsByContent(q, Math.min(STEWARD_SEARCH_LIMIT_MAX, limit + 10)).catch(() => null);
      if (found && Array.isArray(found.results)) {
        indexed = Number(found.indexed) || 0;
        ranked = found.results.map(row => ({ id: row.id, score: Number(row.score) || 0 }));
      } else degraded = 'search_failed';
    } else degraded = 'index_disabled';
    if (!ranked.length) {
      // 退化词法:只看标题与摘要(不读正文),命中即按更新时间排序 —— 索引关着时仍然能找到线程。
      const needle = q.toLowerCase();
      ranked = metas
        .filter(meta => (String(meta.title || '') + ' ' + String(meta.summary || '') + ' ' + String(meta.recentUserRequest && meta.recentUserRequest.text || '')).toLowerCase().includes(needle))
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .map(meta => ({ id: meta.id, score: 0 }));
      if (!degraded) degraded = 'lexical_fallback';
    }

    const index = await getPretenderProjectionIndex().catch(() => null);
    const slices = new Map(((index && index.sessions) || []).map(row => [row.sessionId, row]));
    // 116g:同一事项被多条命中线程共用时只读一次事项文件(结果上限 50,不做无界扫描)。
    const missionTitles = new Map();
    const missionTitleOf = async missionId => {
      if (!missionTitles.has(missionId)) {
        const container = await readMissionContainer(missionId).catch(() => null);
        missionTitles.set(missionId, container ? stewardSanitizeText(container.title) : '');
      }
      return missionTitles.get(missionId);
    };
    const results = [];
    const knownForNames = stewardKnownWorkspaces(config);   // W7:结果行带工作区名字,整次调用只算一次清单
    for (const row of ranked) {
      if (results.length >= limit) break;
      const head = await stewardReadSessionHead(row.id);
      const rawKind = stewardRawKind(head);
      if (rawKind === 'steward') continue;                       // §11.3:管家自己的会话永不出现在结果里
      // 116-2e(§11.1 第 2 项):已收工的速查线程默认不出现 —— 它答完那一句就没用了,留在结果里
      // 只会挤掉真正的任务线程。includeClosed:true 可以要回来(用户问「刚才那条速查说了啥」)。
      if (!includeClosed && stewardQuickClosed(head)) continue;
      const meta = byId.get(row.id) || {};
      const slice = slices.get(row.id) || null;
      const card = slice ? overlayMissionCard(slice) : null;
      // 116-3 P1-5:兜底判据从「非 mission 即 quick_ask」改成「只有管家自己开的速查线程才是 quick_ask」。
      // sessionKind() 里的 'quick_ask' 是第 70 波遗留的「纯问答默认档」,与 116 波的「速查线程」是两个概念;
      // 混用会把用户正在进行的普通对话打上「速查中」标签喂给管家,让它以为那是「答完即扔」的临时线程。
      // 117r-D5 收尾(主会话):D5 把五态的守卫从「是不是速查」换成「调用方有没有事实」之后，这条【没有
      // 卡片】的兜底支就漏了 —— 它一个事实都不喂,原来靠 kind 短路才说得出「速查中」,改完会一路掉进
      // 「无 run、无回合、无里程碑」那条分支变成「交办中」。D1 之后速查线程恒有卡片,所以只在投影还没
      // 赶上的瞬时窗口走到这里,但那也是一句假话。速查那一侧显式说「我没有事实」,与 13d 那条不读会话头
      // 的兜底支同一口径;mission 那一侧不动(它本来就落 dispatching,逐字节不变)。
      const derived = card ? stewardThreadStateFromCard(card)
        : (stewardQuickThread(head)
          ? deriveStewardThreadState({ kind: 'quick_ask', factsUnknown: true })
          : deriveStewardThreadState({ kind: 'mission' }));
      const missionId = (slice && slice.missionId) || (head && sessionMissionId(head)) || row.id;
      const wsName = stewardWorkspaceNameOf(meta.cwd || (head && head.cwd), config, knownForNames);
      const recentUserRequest = stewardRecentUserRequest(head || meta);
      results.push({
        sessionId: row.id,
        relatedThreads: threadRelatedThreads(head || meta, relations),
        missionId,
        // 116g:命中的线程属于哪个【事项】。未归类线程这里是空串(事项标题就是线程标题,不重复说)。
        missionTitle: await missionTitleOf(missionId),
        title: stewardSanitizeText(meta.title || (head && head.title) || ''),
        displayTitle: stewardThreadDisplayTitle(head || meta, config),
        ...(sessionBriefOf(head) || sessionBriefOf(meta) ? { brief: sessionBriefOf(head) || sessionBriefOf(meta) } : {}),   // 116-5b(§11.8.5):title 仍是原话(管家凭它认出用户当时的说法),名字与概括另给一个键,缺席时不出现;经典壳那一面在 13d 的 searchSessionsByContent
        kind: stewardDisplayKind(head),
        state: derived.state,
        stateLabel: derived.label,
        // 诚实:总览与搜索结果里的「最后一句」用会话摘要(= 助手原话经既有收尾裁剪),不做模型改写。
        lastAssistantText: stewardClipSay(meta.summary || (head && head.summary) || ''),
        ...(recentUserRequest ? { recentUserRequest } : {}),
        updatedAt: String(meta.updatedAt || (head && head.updatedAt) || ''),
        score: Number(row.score) || 0,
        // W7:它在哪个工作区里(已知工作区的名字;不在任何一个里给末段名)。只加字段,缺 cwd 时不出现。
        ...(wsName ? { workspace: wsName.name } : {}),
      });
    }
    return stewardForeignProjection({ ok: true, query: q, results, indexed, scope, ...(degraded ? { degraded } : {}) });
  }

  // 3) steward_thread_status —— 五态优先取投影 card,没有则按 mission-state.js 同一判据在服务端派生。
  async function stewardImplThreadStatus(args, ctx, config) {
    const sessionId = safeSessionId(args.sessionId);
    if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
    const head = await stewardReadSessionHead(sessionId);
    if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
    const rawKind = stewardRawKind(head);
    if (rawKind === 'steward') return stewardFail('not_found', 'the steward session is not a thread');

    const index = await getPretenderProjectionIndex().catch(() => null);
    const slice = ((index && index.sessions) || []).find(row => row.sessionId === sessionId) || null;
    const card = slice ? overlayMissionCard(slice) : null;
    const derived = card
      ? stewardThreadStateFromCard(card)
      : stewardThreadStateFromHead(head, {   // 会话头证据键由 06i 适配器统一读(与 13d / 13o / 13r 同一个)
        kind: stewardQuickThread(head) ? 'quick_ask' : 'mission',   // 116-3 P1-5,判据同 threads_search
        pending: await missionPendingCounts(sessionId, [], null).catch(() => null),
        activeTurn: activeChildren.has(sessionId),
        runCount: 0,
      });

    const rawPending = (await readInterventions(sessionId).catch(() => [])).filter(iv => iv && iv.status === 'pending');
    // 127 波 2-quater B1 ③:豁免命中的权限待决多挂一个 exempt(类别 / 底线 / 脱敏摘录),与收件箱行同一个生产者;
    // 没命中的待决一个字段都不多。
    const interventions = rawPending
      .slice(0, STEWARD_PENDING_SUMMARY_MAX)
      .map(iv => {
        const exempt = stewardExemptPendingSummary(iv);
        const execution = stewardPendingExecutionSummary(iv);
        return { id: String(iv.id), type: String(iv.type || ''), toolName: String(iv.toolName || ''), tier: String(iv.tier || ''), summary: stewardPendingOneLine(iv), interventionVersion: Number(iv.interventionVersion) || 0, ...(exempt ? { exempt } : {}), ...(execution ? { execution } : {}) };
      });

    const session = await loadSession(sessionId).catch(() => null);
    const usage = (slice && slice.usage) || null;
    const engine = stewardEngineOf(head);
    const lastRun = card && card.lastRun ? card.lastRun : null;
    // 116g:这条线程属于哪个【事项】,以及那个事项整体是什么状态(由 06i 的 aggregateMissionState 单点
    // 纯函数按全部子线程五态算出;未归类事项 = 只有它自己一条线程,聚合态就等于自己的五态)。
    const missionOfThread = sessionMissionId(head) || sessionId;
    const missionRow = (await buildMissionAggregateRows({ includeArchived: true, config }).catch(() => null) || { rows: [] })
      .rows.find(row => row.missionId === missionOfThread) || null;
    return stewardForeignProjection({
      ok: true,
      sessionId,
      missionId: sessionMissionId(head),
      mission: {
        missionId: missionOfThread,
        title: stewardSanitizeText(missionRow ? missionRow.title : (head.title || '')),
        aggregateState: missionRow ? missionRow.aggregateState : derived.state,
        threadCount: missionRow ? missionRow.threadCount : 1,
        derived: missionRow ? missionRow.derived : true,
        // W7:事项的工作区(名字与出身,同本函数顶层的 workspace 口径)。
        workspace: missionRow && missionRow.workspace ? stewardWorkspaceNameOf(missionRow.workspace.path, config) : null,
      },
      title: stewardSanitizeText(head.title || ''),
      displayTitle: stewardThreadDisplayTitle(head, config),
      // W7:它在哪个工作区里 —— { name, ruyiOwned }(name 是已知工作区清单里的那个名字,可以原样填回
      // steward_thread_new 的 cwd;ruyiOwned = 如意自己开的文件夹)。缺 cwd 时为 null。只加字段。
      relatedThreads: threadRelatedThreads(head, await listSessions()),
      workspace: stewardWorkspaceNameOf(head.cwd, config),
      kind: stewardDisplayKind(head),
      state: derived.state,
      stateLabel: derived.label,
      stateSources: derived.sources,
      activeTurn: activeChildren.has(sessionId),
      execution: sessionExecutionSnapshot(sessionId),
      currentAction: lastRun ? stewardSanitizeText(`班组运行 ${lastRun.id || ''} · ${lastRun.status || ''}`) : (activeChildren.has(sessionId) ? '回合进行中' : ''),
      lastStep: lastRun ? stewardSanitizeText(`${lastRun.nodeCount || 0} 个节点 · eventSeq ${lastRun.eventSeq || 0}`) : '',
      pending: interventions,
      pendingCounts: (card && card.pending) || await missionPendingCounts(sessionId, [], null).catch(() => null),
      // 116h(§3.1 116h 行 / §8.10「排队可解释」):等待原因【单一】,由 06i 的 waitReasonFor 单点判定
      // (等你 > 等锁 > 等预算 > 等并发位)。pending 用五态判据已经算好的那一份,不再数第二遍;
      // 仲裁器一侧是同步只读(开关关时 arbiterWait 恒返回 null,wait 只可能是「等你」或 null)。
      wait: waitReasonFor(
        { pending: (derived.sources && derived.sources.pendingTotal) || 0 },
        typeof StewardHooks.arbiterWait === 'function' ? StewardHooks.arbiterWait(sessionId) : null,
      ),
      // 117l D4(§11.9;用户第四轮走查第 1 条):它在问你。【只加字段】—— wait 与五态一字不改。
      // 判据单点在 06i;本处拿得到完整的最后一条助手消息(session 已装载),所以三态都算得准。
      asksYou: stewardAsksYouForThread({
        pending: rawPending, activeTurn: activeChildren.has(sessionId),
        lastAssistantText: session ? stewardLastAssistantText(session) : (head.summary || ''),
      }),
      // permissionMode 保持既有语义 =【生效】档(既有断言与提示词都读它;断言只加不改)。
      permissionMode: stewardThreadPermissionMode(head, config),
      permissionLabel: stewardPermissionLabel(stewardThreadPermissionMode(head, config)),
      // 116-2a 只加两个字段,把「生效档」与「这条线程自己定的档」显式分开:
      //   effectivePermissionMode —— 与 permissionMode 同值,名字自解释,给 117 的 chip 与管家提示词读;
      //   sessionPermissionMode —— 会话级设置,null = 没定、跟着全局走(chip 的实底/浅底就看它)。
      effectivePermissionMode: stewardThreadPermissionMode(head, config),
      sessionPermissionMode: sessionPermissionModeOf(head),
      engine: engine.engine,
      model: engine.model,
      providerId: engine.providerId || '',
      usage: usage ? { inTok: usage.inTok, outTok: usage.outTok, cachedInTok: usage.cachedInTok, turns: usage.turns, costsByCurrency: usage.costsByCurrency } : null,
      turnSeq: Math.max(0, Number(head.turnSeq) || 0),
      updatedAt: String(head.updatedAt || ''),
      lastAssistantText: stewardClipSay(session ? stewardLastAssistantText(session) : (head.summary || '')),
      recentUserRequest: stewardRecentUserRequest(session || head),
    });
  }

  // 4) steward_thread_read —— §11.2 按需层。配额与预算在写任何东西之前先扣;读到的内容【不写入任何
  //    持久化】(记忆只记用户本人陈述,深读结果不进记忆,也不落决策日志)。
  function stewardToolCallLine(call) {
    const name = stewardSanitizeText((call && call.name) || 'tool');
    let inputHint = '';
    try {
      const raw = JSON.stringify((call && call.input) || {});
      // 107-S1 ⑥(46 号文 §5 ⑦b M4):入参提示【先脱敏再裁】。修前这里是 `JSON.stringify(input)` 原样裁 160 字
      // 交给管家模型并落盘(steward_thread_read 的结果进提示词、也进那一轮的会话文件)——
      // 而同一个文件里 B1 的摘录管线(:1073)早就立了「命令原文先 redact」,两处分叉。
      // redact 住在 04,13k→04 是既有边(:1073 用的就是它),零新增依赖。
      // 顺序照 S0 的教训:redact 在裁剪【之前】—— 先裁 160 字会把密钥切成半截,正则一条都咬不到。
      inputHint = stewardSanitizeText(redact(raw), true).slice(0, 160);
    } catch { inputHint = '{…}'; }
    let resultChars = 0;
    try { resultChars = JSON.stringify((call && call.result) != null ? call.result : '').length; } catch { resultChars = -1; }
    // 第二轮工具走查(F15):修前只有结果长度,失败的 {ok:false,error} 也有几十~几百字符,看不出成败 ——
    // 而「线程为什么卡住」恰恰最需要知道哪一步失败了。成败取结果对象自己的 ok(失败信封都是 {ok:false,…},
    // 或带 error / threw 字段);拿不到结果(Claude 引擎只记调用不记结果)或结果是裸文本时诚实地给 null,不猜。
    const verdict = stewardToolCallVerdict(call);
    const mark = verdict === true ? ' ✓' : verdict === false ? ' ✗失败' : '';
    // 工具输出只给长度(与既有 observation reducer 的缩减视图同一诚实口径:不给全文,给可回读的把手)。
    return `[工具] ${name} ${inputHint} → ${resultChars >= 0 ? resultChars + ' 字符' : '不可序列化'}${mark}${call && call.id ? ' (id=' + stewardSanitizeText(call.id) + ')' : ''}`;
  }
  function stewardToolCallVerdict(call) {
    const result = call && call.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    if (result.ok === false || result.threw || result.error) return false;
    if (result.ok === true) return true;
    return null;
  }
  async function stewardImplThreadRead(args, ctx, config) {
    const sessionId = safeSessionId(args.sessionId);
    if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
    const tail = stewardClampInt(args.tail, 1, STEWARD_READ_TAIL_MAX, STEWARD_READ_TAIL_DEFAULT);
    const maxChars = stewardClampInt(args.maxChars, STEWARD_READ_CHARS_MIN, STEWARD_READ_CHARS_MAX, STEWARD_READ_CHARS_DEFAULT);
    const budgetChars = stewardClampInt(config.stewardReadBudgetChars, 4000, 400000, 48000);
    const stewardSessionId = String((ctx.session && ctx.session.id) || process.env.WCW_SESSION_ID || 'steward');
    const bucket = stewardReadBucket(stewardSessionId, stewardTurnKeyOf(ctx));
    if (bucket.calls >= STEWARD_READ_CALLS_PER_TURN) {
      return stewardFail('quota_exceeded', `thread read quota exhausted for this turn (${STEWARD_READ_CALLS_PER_TURN} deep reads); answer with already-read information`, { quota: { callsRemaining: 0, charsRemaining: Math.max(0, budgetChars - bucket.chars) } });
    }
    if (budgetChars - bucket.chars <= STEWARD_READ_ROW_OVERHEAD + STEWARD_READ_CLIP_MARK.length) {
      return stewardFail('budget_exceeded', `thread read budget exhausted for this turn (${budgetChars} chars); answer with already-read information`, { quota: { callsRemaining: Math.max(0, STEWARD_READ_CALLS_PER_TURN - bucket.calls), charsRemaining: 0 } });
    }
    const head = await stewardReadSessionHead(sessionId);
    if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
    if (stewardRawKind(head) === 'steward') return stewardFail('not_found', 'the steward session is not a thread');
    const session = await loadSession(sessionId).catch(() => null);
    if (!session) return stewardFail('not_found', `thread ${sessionId} not found`);

    // 消耗一次配额:一旦真的开读就计数(不论最终返回多少字符),否则「读了但没算」就是预算漏洞。
    bucket.calls += 1;

    const messages = Array.isArray(session.messages) ? session.messages : [];
    const turnSeqs = [...new Set(messages.map(m => Number(m && m.turnSeq)).filter(Number.isFinite))].sort((a, b) => a - b);
    const eligibleTurns = args.beforeTurnSeq == null ? turnSeqs : turnSeqs.filter(seq => seq < Number(args.beforeTurnSeq));
    const wanted = new Set(eligibleTurns.slice(-tail));
    const rows = [];
    for (const m of messages) {
      if (!m) continue;
      const seq = Number(m.turnSeq);
      // 第二轮工具走查(F9):用户/助手正文也要先 redact 再中和 —— 用户在线程里随口贴的 sk-… / ghp_… 修前原样交给了
      // 管家模型(并进了那一轮的会话文件),而同一个函数对工具入参早就脱敏了。顺序照 stewardToolCallLine 的教训:
      // redact 在【之前】,后面按 maxChars 裁剪时不会把密钥切成半截让正则咬不到。
      // 唤醒通知(meta.origin:'agent_wake')不是用户说的话:以 system 行给管家看,免得它把「后台代理已完成…」当成用户的诉求引用。
      if (m.role === 'user') rows.push({ turnSeq: Number.isFinite(seq) ? seq : null, role: (m.meta && m.meta.origin === 'agent_wake') ? 'system' : 'user', text: stewardSanitizeBlock(stewardForeignProjection(redact(String(m.content || '')))) });
      else if (m.role === 'assistant') {
        rows.push({ turnSeq: Number.isFinite(seq) ? seq : null, role: 'assistant', text: stewardSanitizeBlock(stewardForeignProjection(redact(String(m.content || '')))) });
        for (const call of (Array.isArray(m.toolCalls) ? m.toolCalls : [])) {
          // ok:工具这一步成败(true/false;拿不到结果记录时为 null),给模型排查「线程卡在哪一步」用。
          rows.push({ turnSeq: Number.isFinite(seq) ? seq : null, role: 'tool', ok: stewardToolCallVerdict(call), text: stewardToolCallLine(call) });
        }
      }
    }
    // Cursor addresses the sanitized row and an exclusive character boundary. Appends do not move it.
    // Rewind/edit may change rows: restart the read after editing the history.
    let rowIndex = rows.length - 1, end = null;
    if (args.cursor != null) {
      const match = /^(\d+):(\d+)$/.exec(String(args.cursor));
      if (!match) return stewardFail('invalid_request', 'invalid cursor');
      rowIndex = Number(match[1]); end = Number(match[2]);
      if (!rows[rowIndex] || end > rows[rowIndex].text.length) return stewardFail('invalid_request', 'cursor no longer matches history; restart the read');
    } else {
      while (rowIndex >= 0 && rows[rowIndex].turnSeq != null && !wanted.has(rows[rowIndex].turnSeq)) rowIndex--;
    }
    const pageTurns = new Set();
    const kept = [];
    let room = Math.min(maxChars, budgetChars - bucket.chars), clippedRows = 0;
    while (rowIndex >= 0 && room > STEWARD_READ_ROW_OVERHEAD + STEWARD_READ_CLIP_MARK.length) {
      const row = rows[rowIndex];
      if (!pageTurns.has(row.turnSeq) && pageTurns.size >= tail) break;
      pageTurns.add(row.turnSeq);
      const boundary = end == null ? row.text.length : end;
      const start = Math.max(0, boundary - (room - STEWARD_READ_ROW_OVERHEAD - STEWARD_READ_CLIP_MARK.length));
      const clipped = start > 0;
      const text = (clipped ? STEWARD_READ_CLIP_MARK : '') + row.text.slice(start, boundary);
      kept.unshift({ ...row, text, rowIndex, startChar: start, endChar: boundary });
      room -= text.length + STEWARD_READ_ROW_OVERHEAD;
      if (clipped) { end = start; clippedRows++; break; }
      rowIndex--; end = null;
    }
    const chars = kept.reduce((n, r) => n + r.text.length, 0);
    bucket.chars += chars;
    const hasMore = rowIndex >= 0;
    const nextCursor = hasMore ? `${rowIndex}:${end == null ? rows[rowIndex].text.length : end}` : null;
    return stewardForeignProjection({
      ok: true, sessionId, title: stewardSanitizeText(redact(String(head.title || ''))), tail,
      turnSeqs: [...pageTurns].filter(seq => seq != null).sort((a, b) => a - b),
      truncated: hasMore, clippedRows, chars, hasMore, nextCursor,
      recentUserRequest: stewardRecentUserRequest(session),
      activityGuidance: getPromptPack(config && config.locale).steward.activityGuidance,
      relatedThreads: threadRelatedThreads(head, await listSessions()),
      quota: { callsUsed: bucket.calls, callsMax: STEWARD_READ_CALLS_PER_TURN, charsUsed: bucket.chars, charsMax: budgetChars,
        callsRemaining: Math.max(0, STEWARD_READ_CALLS_PER_TURN - bucket.calls), charsRemaining: Math.max(0, budgetChars - bucket.chars) },
      rows: kept,
    });
  }

  return {
    threadRelationsIndex, threadRelatedThreads, stewardThreadDisplayTitle,
    stewardImplThreadsSearch, stewardImplThreadStatus, stewardImplThreadRead, stewardToolCallLine, stewardToolCallVerdict,
  };
}

module.exports = { createStewardThreadQueries };
