'use strict';

function createStewardThreadDelivery({
  logEvent, nowIso, redact, safeSessionId, activeChildren, loadSession, readInterventions, updateSessionMeta,
  contracts, threads,
}) {
  const {
    STEWARD_DELIVERABLE_CHARS, STEWARD_EXEMPT_INPUT_CHARS, STEWARD_QUICK_ANSWER_CHARS, STEWARD_QUICK_KIND,
    stewardExemptExcerpt, stewardExemptHits, stewardExemptInputText, stewardExemptScanInput, stewardSanitizeBlock,
    stewardSanitizeText, stewardTurnTaint, stewardWatchedThread,
  } = contracts;
  const {
    stewardLastAssistantText, stewardQuickClosed, stewardRawKind, stewardReadSessionHead, stewardTurnAssistantText,
    stewardTurnFiles,
  } = threads;

  // ── 收件箱增强(13i 每轮落盘前调,经 StewardHooks 延迟绑定)──────────────────────────────────
  // 117s-H1(27 号文 §11.13.3,用户第三轮回话「线程的交付管家能不能看全」):给【每一条】管家关心的
  // 线程的 `done` 行补上这一回合真正的交付 —— `payload.deliverable = {text,chars,truncated,turnSeq,files}`。
  // 修前只有速查线程补一个 `answer`,而那个字段 13h 里【零渲染点】(grep 可自证):交付正文从来没有
  // 进过收件箱回合,管家只拿到一行「线程第 N 回合跑完了」,正文全靠它自己再花一次 thread_read 配额去读。
  // 判据用 06i 的 stewardWatchedThread —— 与 13i 决定「这条线程要不要入箱」的是同一条线,不另立第二套
  // (用户自己在经典壳里聊的普通会话本来就不入箱,这里也就不会为它们装载会话)。
  //
  // 为什么在这里而不是在 13i:13i 只认三条 seq 日志,不读会话正文;而交付正文与本回合的文件账都要装载
  // 会话。放在 13g 并经命名空间回调,13i 就不需要认识 13g 的任何符号(前向边红线)。
  // 旁路纪律:抛错绝不反噬轮询器 —— 13i 那边整段包在 try 里,补不上就是少几个字段。
  // 127 波 2-quater B1 ③(45 号文 §2-quater.1 取证 1):管家今天根本看不到命令原文 —— 13i 归一化 needs_you 时
  // 「永不带 iv.input」(那条单测锁不动)。可豁免命中的权限待决偏偏是管家要讲给用户听的那一类:用户真机上它只能
  // 说「命令原文我这边看不到」。所以只给【豁免命中的权限待决】补一份经过三道处理的摘录,其余待决零新增字段:
  //   ① 按 06i stewardExemptScanInput 的 tier 口径决定看不看 input(read/edit 档只看工具名 —— 摘录为空串);
  //   ② stewardExemptHits 判全部命中:没有命中就返回 null(调用方据此一个字段都不挂);
  //   ③ 摘录 = 04 redact(REDACT_PATTERNS 单一来源)→ 06i stewardExemptExcerpt(尖括号中和 + 以命中处为中心截 300 字)。
  // 返回 { categories(类别键,去重保序;纯工具名命中时为空数组), floor(任一命中是底线), commandExcerpt }。
  // 收件箱行(stewardEnrichInboxRows)与 steward_thread_status.pending[] 读的是这同一个函数。
  function stewardPendingExecutionSummary(iv) {
    if (!iv || iv.type !== 'permission' || iv.status !== 'pending') return null;
    const input = stewardExemptScanInput(iv.tier, iv.input);
    if (input == null) return null; // 文件写入正文不作为命令摘录泄露。
    const text = stewardSanitizeBlock(redact(typeof input === 'string' ? input : JSON.stringify(input)));
    if (!text) return null;
    return { commandExcerpt: text.slice(0, 1200), chars: text.length, truncated: text.length > 1200 };
  }
  function stewardExemptPendingSummary(iv) {
    const v = (iv && typeof iv === 'object') ? iv : null;
    if (!v || String(v.type || '') !== 'permission' || String(v.status || '') !== 'pending') return null;
    const scanInput = stewardExemptScanInput(v.tier, v.input);
    const verdict = stewardExemptHits(String(v.toolName || ''), scanInput);
    if (!verdict.hits.length) return null;
    const categories = [...new Set(verdict.hits.map(hit => hit.category).filter(Boolean))];
    const commandExcerpt = scanInput == null
      ? ''
      : stewardExemptExcerpt(redact(stewardExemptInputText(scanInput).slice(0, STEWARD_EXEMPT_INPUT_CHARS)), verdict.hits);
    return { categories, floor: verdict.hits.some(hit => hit.floor === true), commandExcerpt };
  }

  // 127 波 2-quater B2(45 号文 §2-quater.2 闸 2 / 闸 8):代批要的两件【活回合】事实,从活回合登记表上现读。
  // 为什么住 13k 而不是 13l:activeChildren 与 logEvent 都在 04,13k→04 是既有边、13l→04 不是(13l 今天一个 04
  // 符号都不引用)—— 与 B1 把 stewardExemptPendingSummary 放在这里是同一个理由,零新增依赖边。
  //   mode  —— 活回合此刻的实效档位:09 在 runOpenAiTurn 里挂到登记表上的 effectivePermissionMode(与闸门
  //            gateWithLiveMode 读同一个函数)。没有活回合 / 登记表上没有这个函数(Claude CLI、Kimi)/ 调用抛错
  //            → 空串,闸 2 据此拦下(判不出档位就不代批)。**不读会话头** —— 那正是要堵的错位。
  //   taint —— 06i stewardTurnTaint 在活回合段表上判(a),再叠会话级粘性污染位(b)。判不出一律算污染(c):
  //            没有活回合 'no_live_turn';登记表没有 liveSegments(Kimi 的就没有)'no_live_segments'。
  //            粘性位优先读活回合里那一份会话对象(10 的 emit 写的就是它,比盘上新),盘上的会话头兜底。
  //            10 只在读外部内容的那条工具调用【结果回来】时置位 —— 这条待决自己(还没执行、没有结果)不会把自己算进去。
  // 审计 E:非代批的待决判 mayAct 也要看【活回合此刻的实效档】—— 定时任务(请求级 autonomy.permissionMode)与
  // 交办卡的请求级收紧只活在回合里,不在会话头上。只读档位,不碰污染判定(那是代批十道闸的事)。
  // 09 的登记表挂 effectivePermissionMode();Claude CLI 的登记表只有 spawn 时的解析档 permissionMode(05);
  // 都没有(Kimi、无活回合、调用抛错)→ 空串,由调用方决定怎么兜底。
  function stewardLiveTurnPermissionMode(liveSessionId) {
    const liveReg = activeChildren.get(String(liveSessionId || '')) || null;
    if (!liveReg) return '';
    try {
      if (typeof liveReg.effectivePermissionMode === 'function') return String(liveReg.effectivePermissionMode() || '');
    } catch { return ''; }
    return typeof liveReg.permissionMode === 'string' ? liveReg.permissionMode : '';
  }
  function stewardExemptLiveTurn(liveSessionId, liveInterventionId, liveHead) {
    const liveReg = activeChildren.get(String(liveSessionId || '')) || null;
    if (!liveReg) return { live: false, mode: '', taint: { tainted: true, taintBy: 'no_live_turn' } };
    let mode = '';
    try { mode = typeof liveReg.effectivePermissionMode === 'function' ? String(liveReg.effectivePermissionMode() || '') : ''; } catch { mode = ''; }
    const sticky = (liveReg.session && liveReg.session.stewardTaint) || (liveHead && liveHead.stewardTaint) || null;
    let taint = { tainted: true, taintBy: 'no_live_segments' };
    if (liveReg.liveSegments && typeof liveReg.liveSegments.snapshot === 'function') {
      try { taint = stewardTurnTaint(liveReg.liveSegments.snapshot(), liveInterventionId, sticky); } catch { taint = { tainted: true, taintBy: 'no_live_segments' }; }
    }
    return { live: true, mode, taint };
  }
  // 代批落定之后的审计行。**只放元数据**:类别、判据来源、有没有写理由、窗口里第几次 —— 命令摘录与 riskNote
  // 正文都不进日志(日志会被 /api/audit 与导出面读走;摘录与理由只进决策账本与回执)。
  function stewardExemptDelegatedLog(delegatedMeta) {
    const m = (delegatedMeta && typeof delegatedMeta === 'object') ? delegatedMeta : {};
    try {
      logEvent({
        kind: 'steward_exempt_delegated',
        sessionId: String(m.sessionId || ''),
        interventionId: String(m.interventionId || ''),
        toolName: String(m.toolName || '').slice(0, 120),
        categories: Array.isArray(m.categories) ? m.categories.slice(0, 5) : [],
        exemptBy: String(m.exemptBy || ''),
        riskNoteChars: Math.max(0, Number(m.riskNoteChars) || 0),
        windowCount: Math.max(0, Number(m.windowCount) || 0),
      });
    } catch { /* 审计旁路:写不进去不反噬已经落定的决定 */ }
  }

  async function stewardEnrichInboxRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const heads = new Map();
    const pendingBySession = new Map();
    for (const row of list) {
      // 127 波 2-quater B1 ③:豁免命中的权限待决行补 exempt。只读待决旁路账(同一批同一线程只读一次),
      // 不装载会话;待决已经不是 pending(刚被答掉)就不挂 —— 摘录只描述「此刻还在等的那一条」。
      if (row && row.kind === 'needs_you' && row.payload && row.payload.interventionType === 'permission' && row.payload.interventionId) {
        const pendingSid = safeSessionId(row.sessionId);
        if (!pendingSid) continue;
        if (!pendingBySession.has(pendingSid)) pendingBySession.set(pendingSid, await readInterventions(pendingSid).catch(() => []));
        const iv = (pendingBySession.get(pendingSid) || []).find(item => item && String(item.id) === String(row.payload.interventionId));
        const exempt = stewardExemptPendingSummary(iv);
        if (exempt) row.payload = { ...row.payload, exempt };
        continue;
      }
      if (!row || row.kind !== 'done') continue;
      const sid = safeSessionId(row.sessionId);
      if (!sid) continue;
      if (!heads.has(sid)) heads.set(sid, await stewardReadSessionHead(sid).catch(() => null));
      const head = heads.get(sid);
      if (!head) continue;
      if (!stewardWatchedThread(head, sid, row.missionId)) continue;
      const quick = stewardRawKind(head) === STEWARD_QUICK_KIND && !!head.stewardQuick;
      const session = await loadSession(sid).catch(() => null);
      if (!session) continue;
      const payload = (row.payload && typeof row.payload === 'object') ? row.payload : {};
      // 回合号取事件自己的(第四源 stewardNormalizeSessionTurn 落的 payload.turnSeq);取不到就退到
      // 会话头上的当前回合号,再取不到才让下面的挑选退到「最后一条助手话」。
      const turnSeq = Math.max(0, Number(payload.turnSeq) || 0) || Math.max(0, Number(head.turnSeq) || 0);
      const deliverySession = turnSeq > 0 ? { messages: (session.messages || []).filter(message => Number(message.turnSeq) === turnSeq) } : session;
      const full = stewardSanitizeBlock(stewardTurnAssistantText(deliverySession, turnSeq));
      const patch = {};
      if (full.trim()) {
        patch.deliverable = {
          text: full.slice(0, STEWARD_DELIVERABLE_CHARS),
          chars: full.length,
          truncated: full.length > STEWARD_DELIVERABLE_CHARS,
          turnSeq,
          files: stewardTurnFiles(session, turnSeq),
        };
      }
      // 速查线程的 `answer` 留着(老消费者与 116-2e 的收工判据都认它),但它现在与交付【同一份原文】,
      // 只是仍按 ≤1200 的老口径中和成单行 —— 两个字段从此不会各说各的。
      if (quick) {
        patch.quick = true;
        patch.answer = stewardSanitizeText(full || (turnSeq > 0 ? '' : stewardLastAssistantText(session))).slice(0, STEWARD_QUICK_ANSWER_CHARS);
      }
      if (Object.keys(patch).length) row.payload = { ...payload, ...patch };
    }
    return list;
  }

  // 收工:回合结束后由 13h 调 —— 把 stewardQuick.closedAt 落在会话头上。收工后这条线程从管家的总览
  // 与 steward_threads_search 里消失(经典壳照常看得见,它只是数据)。幂等:已收工的再调是无操作。
  async function stewardQuickClose(sessionId) {
    const sid = safeSessionId(sessionId);
    if (!sid) return { ok: false, error: 'invalid_request' };
    const head = await stewardReadSessionHead(sid);
    if (!head || stewardRawKind(head) !== STEWARD_QUICK_KIND || !head.stewardQuick) return { ok: false, error: 'not_found' };
    // 116-3 P1-6:判「还算不算收工」走 stewardQuickClosed(它会把「收工后用户又聊了」算成重开),
    // 而不是只看 closedAt 是不是真值 —— 否则一条被用户重新用起来的速查线程再次收工时会被当成幂等
    // 直接返回,closedTurnSeq 永远停在第一次收工那一刻,它就再也关不上了。
    if (stewardQuickClosed(head)) return { ok: true, sessionId: sid, closedAt: head.stewardQuick.closedAt, changed: false };
    const closedAt = nowIso();
    // 收工时记下【当时的回合数】。之后会话每多一个用户回合,turnSeq 就会超过它 = 用户在继续用这条线程。
    const closedTurnSeq = Math.max(0, Number(head.turnSeq) || 0);
    await updateSessionMeta(sid, { stewardQuick: { ...head.stewardQuick, closedAt, closedTurnSeq } });
    return { ok: true, sessionId: sid, closedAt, closedTurnSeq, changed: true };
  }

  return {
    stewardPendingExecutionSummary, stewardExemptPendingSummary, stewardLiveTurnPermissionMode,
    stewardExemptLiveTurn, stewardExemptDelegatedLog, stewardEnrichInboxRows, stewardQuickClose,
  };
}

module.exports = { createStewardThreadDelivery };
