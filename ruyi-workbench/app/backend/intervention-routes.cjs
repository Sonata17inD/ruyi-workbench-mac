'use strict';

const { apiFailure, apiSessionIdInvalid, json, readJsonBody, send, text } = require('./http-protocol.cjs');
const { resolvePermissionMode } = require('./agent-role-policy.cjs');
const { DESKTOP_MCP_SERVER_ID, toolDisabledByPolicy } = require('./tool-access-policy.cjs');
const { cliBridgeToolTier } = require('./cli-tool-tiers.cjs');
const { normalizeQuestionAnswer } = require('./user-question-protocol.cjs');

function createInterventionRoutes({
  tokenOk, tokenMatches, safeSessionId, safeDecodeURIComponent, makeId, logEvent, readConfig, RUYI_MCP_CLI_TOOL_PREFIX,
  execution: { pendingPermissions, pendingQuestions, pendingPlans, activeAgentRuns, activeChildren, driverAutoSessions },
  permissions: {
    interventionCommandFailure, extendUserQuestion, requestUserQuestion, permissionWaitMs, runAutomaticInterventionDecision,
    bridgedReadPathGate, consumeGrant, toolDisabledResult, nativeToolGate, toolIsRevertible, sessionDesktopToolsOf,
  },
  sessions: {
    compactInterventionJournal, readSessionHeadResilient, readMissionContainer, registerIntervention,
    loadSession, saveSession, settleIntervention, transitionInterventionState, decideIntervention,
  },
  projection: {
    invalidatePretenderIndex, pretenderIndexMeta, getPretenderProjectionIndex, paginatePretenderProjection,
    pretenderEtag, pretenderLiveOverlayRevision, pretenderNotModified, pretenderHash,
  },
}) {
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
        invalidatePretenderIndex();
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
      const bridgeMode = String((reg && reg.permissionMode) || resolvePermissionMode({ session: reg && reg.session, config }) || '');
      const bridgeGate = nativeToolGate(bridgeMode, bridgeTier, String(body.toolName || ''), body.input || {});
      // auto 档的低风险动作在原生引擎里已经不弹窗了,CLI 桥必须同口径 —— 否则同一个「全自动」在两个引擎
      // 下行为不一致。只对 auto 档短路(其余档位一行不变:read/bypass 的既有落点仍走下面那条路)。
      if (reg.kind === 'codex' && bridgeGate === 'block') return send(res, json({ behavior:'deny', message:'Blocked by permission mode' }));
      if ((bridgeMode === 'auto' || reg.kind === 'codex') && bridgeGate === 'allow') {
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

  return handleInterventionApiRoutes;
}

module.exports = { createInterventionRoutes };
