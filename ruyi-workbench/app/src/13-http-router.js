const streamChat = require('./backend/http-chat-stream.cjs').createHttpChatStream({
  runSessionTurn, PrivacyGateway, safeSessionId, nowIso,
});

const buildUsageSummary = require('./backend/usage-summary.cjs').createUsageSummary({
  readConfig, forEachUsageRow, usageRangeLowerMs, usageDayKeyMemo,
  async readSessionTitles() {
    // Include pending index writes so a just-renamed session already has its current title.
    const index = await readSessionIndex();
    const entries = new Map((Array.isArray(index) ? index : [])
      .filter(entry => entry && entry.id).map(entry => [String(entry.id), entry]));
    const titles = new Map();
    for (const [id, entry] of overlayUnflushedSessionIndex(entries)) {
      titles.set(String(id), (entry && entry.title) || '');
    }
    return titles;
  },
});

const { handleUsageApiRoutes, handleDiagnosticsApiRoutes } =
  require('./backend/diagnostic-routes.cjs').createDiagnosticRoutes({
    tokenOk, readConfig, buildUsageSummary, buildOpsMetrics, collectAudit,
    collectStorageStats, maybeRecordStorageTrend, buildMetricsPayload,
  });

const handleLocalSupportApiRoutes = require('./backend/local-support-routes.cjs').createLocalSupportRoutes({
  externalRoot, manualsDirectory: path.join(__dirname, '..', 'docs', 'manuals'), paths,
  tokenOk, safeSessionId, readConfig, loadSession, process, DesktopShell, logEvent,
  fileAllowedRoots, remoteUncDenialResolved, ensureDataRootReal, isSensitiveDataPath, isSensitiveHardlinkAlias,
  guardWorkspacePath, buildRevealSpawn,
});

const { handleCheckpointQueryApiRoutes, handleCheckpointApiRoutes } =
  require('./backend/checkpoint-routes.cjs').createCheckpointRoutes({
    tokenOk, safeSessionId, readConfig, loadSession, mutateSession, mutateConfig, nowIso, logEvent,
    execution: { activeChildren, activeAgentRuns, rewindSession },
    journal: { journalReadIndex, journalDir, journalRollback, journalRevertLogRecord,
      workspaceBaselinePathKey, workspaceBaselineIsCodePath, bumpMissionChangeSeq },
    editor: { guardWorkspacePath, resolvePreferredCodeEditor, buildCodeEditorSpawn, materializeCheckpointEditorDiff, launchCodeEditor },
    storage: { normalizeStoragePolicy, storageSweep }, process,
  });

const ServerStartNotices = require('./backend/server-start-notices.cjs').createServerStartNotices({
  paths, DesktopExecutionHooks, atomicWriteJson, nowIso, safeJsonParse,
});

const { handleSkillApiRoutes, setSessionSkillsCore } = require('./backend/skill-routes.cjs').createSkillRoutes({
  paths, SKILL_ID_RE, readConfig, loadSkillRegistry, fileAllowedRoots, logEvent,
  loadSession, mutateSession, activeChildren,
});

const handleMemoryApiRoutes = require('./backend/memory-routes.cjs').createMemoryRoutes({
  tokenOk, safeSessionId, readConfig, fileAllowedRoots, logEvent, MEMORY_EXCLUSION_MAX,
  loadSession, mutateSession, activeChildren,
  store: { loadMemoryRegistry, projectKeyForCwd, resolveCoreMemoryState, listMemoryProjectGroups,
    readMemoryItem, migrateMemory, moveMemoryScope, saveMemory, deleteMemory },
  proposals: { replayPendingMemoryProposal, proposeMemoryFromSession, decideMemoryProposal,
    applyMemoryRelationProposal, draftMemoryFromSession, validateMemoryProposalSave },
  relations: { listMemoryRelations, analyzeMemoryMaintenance, proposeMemoryRelation,
    confirmMemoryRelation, deleteMemoryRelation },
});

const handlePlaybookApiRoutes = require('./backend/playbook-routes.cjs').createPlaybookRoutes({
  safeSessionId, readConfig, listPlaybooksWithAvailability, normalizePlaybook,
  saveUserPlaybook, deleteUserPlaybook, playbookReuseSources, draftPlaybookFromSession,
});

const handleSessionExecutionApiRoutes = require('./backend/session-execution-routes.cjs').createSessionExecutionRoutes({
  safeSessionId, readConfig, loadSession, mutateSession, logEvent, activeChildren, requestSessionExecutionStop, StewardHooks,
  compaction: { runProviderCompactTracked, runAgentExternalCompact, configForSessionEngineRoute, agentCliAdapter },
  kimi: { kimiSessionStatus, kimiStatusFingerprint, applyKimiStatusToSession, kimiUsageFromStatus },
});

const handleStatusApiRoutes = require('./backend/status-routes.cjs').createStatusRoutes({
  paths, RUNTIME, ServerStartNotices, readConfig, maskProviders, requestIsLoopback, computeHealth, getCapabilities, probeRgAsync,
  identity: { APP_NAME, VERSION, CONFIG_SCHEMA, OVERLAY_ID, dataRootAliases, exePath },
  conversation: { safeSessionId, readSessionRouteHead, configForSessionEngineRoute, activeOpenAiProvider,
    agentConversationContextMeta, configuredConversationWindow, resolveContextWindow, learnedWindowCap },
  cli: { agentCliAdapter, detectClaudePath, detectKimiPath, AGENT_CLI_TYPES, selectedAgentCli },
  desktopMcp: { desktopMcpDetectionPending, mcpConfigFilePath, generateMcpConfig, ensureDesktopMcpWarm,
    detectDesktopMcp, resolveExternalMcpServers },
  tools: { MCP_TOOLS, runtimeToolRequirementsMet, nativeToolDisabledByPolicy, observationRecallEnabled, isStewardToolName },
  ToolboxHooks, PROVIDER_PRESETS, CLAUDE_ENDPOINT_PRESETS,
});

const handleWorkspaceApiRoutes = require('./backend/workspace-routes.cjs').createWorkspaceRoutes({
  readConfig, resolveWorkspace, DesktopShell,
});

const { handleModelsApiRoute, handleProviderTestApiRoute } = require('./backend/provider-routes.cjs').createProviderRoutes({
  readConfig, safeSessionId, readSessionRouteHead, configForSessionEngineRoute, agentCliAdapter,
  catalog: { activeOpenAiProvider, fetchOpenAiModels, cachedContextLength, contextWindowFromTable },
  credentials: { maskedSecretConflicts, maskedSecretConflictMessage, unmaskProviders, redact, providerScrubSecrets },
  probe: { sanitizeProvider, normalizeProviderApiStyle, probeProviderCompletion },
});

const handleConfigurationApiRoutes = require('./backend/configuration-routes.cjs').createConfigurationRoutes({
  readConfig, mutateConfig, maskProviders, ConfigPatchHooks, ToolboxHooks, projectCwdDirectoryFailure, resolveExternalMcpServers,
  roles: { getAgentRoleLibrary, readProjectAgentRoles, readClaudeProjectAgentRoles, buildClaudeAgentDefinitions,
    saveProjectAgentRoles, projectAgentRoleFile },
  workflows: { getAgentWorkflows, normalizeAgentWorkflow, agentWorkflowSaveProblem, saveAgentWorkflow, deleteAgentWorkflow },
});

// 代理模式 v2:MCP 子进程(Claude/Kimi)的 wait_agents / agent_result 回环。鉴权同 launch(body.token = 进程 token,
// 01b 登记为 body-token),handler 内另接受 UI 头 token(管理面/测试直调)。终态信封在此登记已读 —— 这次返回就是
// 投递,后续回合不再重复注入;活回合在跑就登记在它的内存会话上(回合结束落盘),否则读-改-存一次。
async function agentWorkflowLoopbackRoute(req, res, kind) {
  const body = await readJsonBody(req);
  if (!(tokenMatches(body.token) || tokenOk(req))) return send(res, json({ ok: false, error: 'bad token' }, 403));
  const sessionId = safeSessionId(body.sessionId);
  if (!sessionId) return send(res, apiSessionIdInvalid());
  const liveReg = activeChildren.get(sessionId);
  const markSession = async runIds => {
    if (!EventStreamHooks.markAgentEnvelopeDelivered || !runIds.length) return;
    if (liveReg && liveReg.session) { for (const id of runIds) EventStreamHooks.markAgentEnvelopeDelivered(liveReg.session, id); return; }
    // 没有活回合:读-改-写走 mutateSession(撤回闸/写链纪律,见 02 头注),不直接 saveSession。
    await mutateSession(sessionId, fresh => { for (const id of runIds) EventStreamHooks.markAgentEnvelopeDelivered(fresh, id); }, { writer: 'agent_envelope_delivered' }).catch(() => {});
  };
  if (kind === 'wait') {
    const out = await waitForAgentRunResults(sessionId, body.runIds, resolveWaitAgentsMs(body.timeoutMs), null, () => { if (liveReg) liveReg.lastEventAt = Date.now(); });   // 等待窗内 Claude/Kimi 父回合的看门狗不算空闲(MCP 子进程里的 wait_agents 期间 CLI 没有任何输出)
    // 与 provider 回合同一套结算(settleWaitEnvelopes):通知先到 → 短回执;wait 先到 → 登记已读。
    if (liveReg && liveReg.session) settleWaitEnvelopes(liveReg.session, out);
    else {
      const snapshot = await loadSession(sessionId);
      if (snapshot) {
        settleWaitEnvelopes(snapshot, out);
        const marked = Array.isArray(snapshot.backgroundJobSeen) ? snapshot.backgroundJobSeen : [];
        await mutateSession(sessionId, fresh => { fresh.backgroundJobSeen = [...new Set([...(Array.isArray(fresh.backgroundJobSeen) ? fresh.backgroundJobSeen : []), ...marked])].slice(-100); }, { writer: 'agent_envelope_delivered' }).catch(() => {});
      }
    }
    return send(res, json(out));
  }
  const out = await agentRunResultSlice({ sessionId, runId: body.runId, nodeId: body.nodeId, maxChars: body.maxChars, offset: body.offset });
  if (out && out.ok && out.live !== true && AGENT_RUN_TERMINAL.has(String(out.runStatus))) await markSession([out.runId]);
  return send(res, json(out));
}
async function handleApi(req, res, pathname) {
  // --- auth gate ---
  // The MCP child authenticates /api/permission/request with its own body token (checked there).
  // Every other state-changing route must be same-origin (blocks browser CSRF). The tool-exec and
  // config routes additionally require the injected UI token (blocks other local processes).
  // 第33波:声明式 auth 路由表 deny-by-default(替换原 needsToken/uiMutatingRoute/uiReadRoute 三条 OR 链)。
  // authorizeRoute 按 ROUTE_AUTH 表 first-match 判定 open/origin/token/token-browser/body-token;未匹配 -> 拒(403)。
  // 14 处 handler 内 tokenOk 自查保留作纵深;Host 门在 HTTP handler 顶层 hostAllowed(全请求含 GET 与 serveStatic)。
  const authErr = authorizeRoute(req, req.method, pathname);
  if (authErr) {
    const code = authErr === 'missing or invalid workbench token' ? 'auth.token_invalid'
      : authErr === 'cross-origin request rejected' ? 'auth.origin_rejected'
        : authErr === 'remote client not allowed' ? 'auth.remote_denied' : 'auth.denied';
    return send(res, apiFailure(code, {}, authErr, 403));
  }

  if (typeof PrivacyCore !== 'undefined' && typeof PrivacyCore.configHooks.handleApiRoutes === 'function' && await PrivacyCore.configHooks.handleApiRoutes(req, res, pathname)) return;
  if (typeof ExternalBotHooks.handleApiRoutes === 'function') {
    const handled = await ExternalBotHooks.handleApiRoutes(req, res, pathname);
    if (handled || res.writableEnded || res.destroyed) return;
  }

  await handleStatusApiRoutes(req, res, pathname); if (res.writableEnded) return;
  await handlePlaybookApiRoutes(req, res, pathname); if (res.writableEnded) return;
  await handleWorkspaceApiRoutes(req, res, pathname); if (res.writableEnded) return;
  await handleModelsApiRoute(req, res, pathname); if (res.writableEnded) return;
  await handleConfigurationApiRoutes(req, res, pathname); if (res.writableEnded) return;
  await handleProviderTestApiRoute(req, res, pathname); if (res.writableEnded) return;
  // EC-D Wave 65: session CRUD routes live in 13d-core-domain-routes.js.
  await handleSessionApiRoutes(req, res, pathname); if (res.writableEnded) return;
  // 第70波(EC-E):/api/missions 聚合只读投影,同在 13d。
  await handleMissionsApiRoutes(req, res, pathname); if (res.writableEnded) return;
  await handleSkillApiRoutes(req, res, pathname); if (res.writableEnded) return;
  await handleMemoryApiRoutes(req, res, pathname); if (res.writableEnded) return;
  await handleSessionExecutionApiRoutes(req, res, pathname); if (res.writableEnded) return;
  // EC-D Wave 65: question, permission, and plan routes live in 13d-core-domain-routes.js.
  await handleInterventionApiRoutes(req, res, pathname); if (res.writableEnded) return;
  if (req.method === 'POST' && pathname === '/api/todo') {
    // v0.8-S3: called by the todo_write tool running in the MCP child (Claude engine) over loopback. The
    // child must NOT write session files itself (races the serve process's saveSession), so it delegates
    // the persist here. Body-token authenticated (same pattern as /api/permission/request). Validates →
    // loadSession → session.todos = items → saveSession → if a live turn owns this session, emit `todo`.
    const body = await readJsonBody(req);
    if (!tokenMatches(body.token)) return send(res, json({ ok: false, error: 'bad token' }, 403));
    const sessionId = safeSessionId(body.sessionId); // F4
    if (!sessionId) return send(res, apiSessionIdInvalid());
    const items = normalizeTodoItems(body.items);
    // 128b:mutateSession —— 撤回插在读与存之间时在新读的副本上重放,不被闸静默丢掉还回 ok。
    let written;
    try { written = await mutateSession(sessionId, fresh => { fresh.todos = items; }, { writer: 'todo' }); }
    catch (error) {
      if (error && error.code === 'session.rewound_during_write') return send(res, apiFailure(error.code, {}, error.message, 409));
      throw error;
    }
    if (!written.session) return send(res, apiSessionNotFound());
    const reg = activeChildren.get(sessionId);
    if (reg && reg.onEvent) { try { reg.onEvent({ type: 'todo', items }); } catch { /* stream gone */ } }
    return send(res, json({ ok: true, count: items.length }));
  }
  // ── 第26波b: 任务账本 API。GET 读(header token);POST 改(header token 或 body token —— 后者供 MCP 子进程
  //    的 mission_update 工具 loopback,同 /api/todo 纪律)。action: start(全量设)/update(合并)/stop/check(跑验收)。──
  if (pathname === '/api/mission') {
    const bodyOrQ = req.method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://x').searchParams) : await readJsonBody(req);
    const bodyTokenOk = tokenMatches(bodyOrQ.token);
    if (!tokenOk(req) && !bodyTokenOk) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const sessionId = safeSessionId(bodyOrQ.sessionId);
    if (!sessionId) return send(res, apiSessionIdInvalid());
    let session = await loadSession(sessionId);
    if (!session) return send(res, apiSessionNotFound());
    if (req.method === 'GET') return send(res, json({ ok: true, mission: session.mission || null }));
    // 128b:check／start／update 都走 mutateSession 落盘;撞上撤回回 409 稳定码,不回成功、不记变更流水。
    const rewoundReply = error => send(res, apiFailure(error.code, {}, error.message, 409));
    if (req.method !== 'POST') return send(res, json({ ok: false, error: 'method not allowed' }, 405));
    const action = String(bodyOrQ.action || 'update');
    const emitMission = () => { const reg = activeChildren.get(sessionId); if (reg && reg.onEvent) { try { reg.onEvent({ type: 'mission', mission: session.mission }); } catch { /* stream gone */ } } };
    if (action === 'stop') {
      const result = await missionControlCommand(sessionId, 'stop');
      return send(res, json(result.body, result.status));
    }
    if (action === 'check') {
      // 跑全部里程碑机器验收;autoMark!==false 时把 pass 的 pending/blocked 里程碑标 done(证据落 detail)。
      const cwd = normalizeCwd(session.cwd, (await readConfig()).defaultWorkspace);
      const baseGen = Number(session.rewindGen) || 0;
      const results = [];
      for (const m of ((session.mission && session.mission.milestones) || [])) {
        const r = await evaluateMissionCheck(m.check, cwd);
        results.push({ id: m.id, checkType: m.check ? m.check.type : 'none', result: r });
      }
      const byId = new Map(results.map(item => [item.id, item.result]));
      let resultBefore = '';
      let written;
      try {
        written = await mutateSession(sessionId, async fresh => {
          for (const m of ((fresh.mission && fresh.mission.milestones) || [])) {
            const r = byId.get(m.id);
            if (!r) continue;
            recordMissionCheckResult(m, r);   // 124-P1:落章(唯一写入口在 02);done 不回退的既有语义不变
            if (r.pass && bodyOrQ.autoMark !== false && m.status !== 'done') { m.status = 'done'; m.evidence = String(r.detail || '机器验收通过').slice(0, MISSION_MAX_TEXT); }
            if (!r.pass && m.status === 'done') { /* 不自动回退 done → 避免抖动;仅 report */ }
          }
          if (fresh.mission) fresh.mission.updatedAt = nowIso();
          resultBefore = String(fresh.mission && fresh.mission.result && fresh.mission.result.status || '');
          await maybeFinalizeMission(fresh, 'check'); // 第72波:全 done 盖 complete 章
        }, { writer: 'mission_check', expectGen: baseGen });
      } catch (error) {
        if (error && error.code === 'session.rewound_during_write') return rewoundReply(error);
        throw error;
      }
      if (!written.session) return send(res, apiSessionNotFound());
      session = written.session;
      if (session.mission) {
        const resultAfter = String(session.mission.result && session.mission.result.status || '');
        const revision = await bumpMissionChangeSeq(sessionId, {
          type: resultAfter && resultAfter !== resultBefore ? 'result' : 'progress',
          cursor: { action: 'check' },
          detail: { checks: results.length, passed: results.filter(item => item.result && item.result.pass).length, status: resultAfter },
        });
        if (revision) session.mission.changeSeq = revision;
      }
      emitMission();
      return send(res, json({ ok: true, mission: session.mission || null, checks: results }));
    }
    // start = 全量新建(normalizeMission,prev=null);update = 按 id 增量合并(applyMissionUpdate,不抹其它里程碑)。
    // autoMode 可作 body 兄弟字段或 mission.autoMode 传入,两条路径都尊重。
    // 对抗轮 P1: trusted = 【header token】(UI/用户)——只有它能定义机器 check;body-token loopback(模型经 MCP 子进程)
    // 视为不可信,不能设 check.cmd。header token 存在即 UI 直连(浏览器 CORS 拿不到该 token)。
    const trusted = tokenOk(req);
    let resultBefore = '';
    let written;
    try {
      written = await mutateSession(sessionId, async fresh => {
        resultBefore = String(fresh.mission && fresh.mission.result && fresh.mission.result.status || '');
        if (action === 'start') {
          const input = { ...(bodyOrQ.mission || bodyOrQ) };
          if (bodyOrQ.autoMode != null && input.autoMode == null) input.autoMode = bodyOrQ.autoMode;
          fresh.mission = normalizeMission(input, null, trusted);
          fresh.mission.startedTurnSeq = Math.max(1, (Number(fresh.turnSeq) || 0) + 1);
          fresh.kind = 'mission'; // 第70波(EC-E):start 是显式任务动作 → Quick Ask 翻转 Mission(非启发式)
          return undefined;
        }
        if (!fresh.mission) return { abort: 'no_mission' };
        fresh.mission = applyMissionUpdate(fresh.mission, bodyOrQ.patch || bodyOrQ, trusted);
        if (bodyOrQ.autoMode != null) fresh.mission.autoMode = ['off', 'until-done', 'supervised'].includes(bodyOrQ.autoMode) ? bodyOrQ.autoMode : fresh.mission.autoMode;
        await maybeFinalizeMission(fresh, 'update'); // 第72波:全 done 盖 complete 章 / 再武装清旧章
        return undefined;
      }, { writer: 'mission_' + (action === 'start' ? 'start' : 'update') });
    } catch (error) {
      if (error && error.code === 'session.rewound_during_write') return rewoundReply(error);
      throw error;
    }
    if (!written.session) return send(res, apiSessionNotFound());
    if (!written.ok && written.value === 'no_mission') return send(res, json({ ok: false, error: '当前会话没有活动任务账本;请先 action:start' }, 400));
    session = written.session;
    if (action === 'start') logEvent({ kind: 'mission_start', sessionId, trusted, autoMode: session.mission.autoMode }); // 29c: 预算超支率的分母
    if (session.mission) {
      const resultAfter = String(session.mission.result && session.mission.result.status || '');
      const revision = await bumpMissionChangeSeq(sessionId, {
        type: action === 'start' ? 'mission_started' : (resultAfter && resultAfter !== resultBefore ? 'result' : 'progress'),
        cursor: { action },
        detail: {
          status: resultAfter,
          autoMode: session.mission.autoMode || 'off',
          milestonesTotal: Array.isArray(session.mission.milestones) ? session.mission.milestones.length : 0,
          milestonesDone: Array.isArray(session.mission.milestones) ? session.mission.milestones.filter(item => item && item.status === 'done').length : 0,
        },
      });
      if (revision) session.mission.changeSeq = revision;
    }
    emitMission();
    // C4 (75a-3): sync the mission change to the active turn's in-memory session, so the provider round-tail
    // saveSession (09:1924) doesn't cover back this route mutation. provider engine updates mission in-process
    // (09:1719) and saves only at round-tail; without sync the turn's stale in-memory mission clobbers the
    // route mutation. 'update' applies the patch (merge via applyMissionUpdate, preserving in-process
    // mission_update changes); start/stop/check replace (full-state action). claude engine re-reads at 05:765
    // instead (its mission_update loops back to disk), so it doesn't need this sync.
    { const reg = activeChildren.get(sessionId); if (reg && reg.session && reg.session !== session) {
      if (action === 'update' && reg.session.mission) {
        reg.session.mission = applyMissionUpdate(reg.session.mission, bodyOrQ.patch || bodyOrQ, trusted);
        if (bodyOrQ.autoMode != null) reg.session.mission.autoMode = ['off', 'until-done', 'supervised'].includes(bodyOrQ.autoMode) ? bodyOrQ.autoMode : reg.session.mission.autoMode;
        // 第97波对抗复审(B2):本路由已把磁盘权威侧落盘(含 maybeFinalizeMission 盖的 complete/stopped 章
        // 与归档的 resultHistory);reg 内存侧只是 applyMissionUpdate 深拷旧值,result/resultHistory 仍是旧的。
        // 若不同步,09/provider 回合收尾 saveSession(reg.session)会用陈旧内存覆盖磁盘,新章与归档整条丢失。
        // 同步磁盘权威的 result 与 resultHistory(归档历史是追加语义,以磁盘为准)。
        reg.session.mission.result = session.mission && session.mission.result || null;
        reg.session.mission.resultHistory = Array.isArray(session.mission && session.mission.resultHistory) ? session.mission.resultHistory.slice(-10) : [];
        if (session.mission && session.mission.result && session.mission.result.status === 'complete' && resultBefore !== 'complete') {
          Object.defineProperty(reg.session, '__missionFinalizeHow', { value: 'update', writable: true, configurable: true, enumerable: false });
        }
      } else {
        reg.session.mission = session.mission;
        if (action === 'start') reg.session.kind = 'mission';
      }
    } }
    return send(res, json({ ok: true, mission: session.mission }));
  }
  // ── 第27波:自主性授权书 API。全部 header-token 白名单路由(需 needsToken 命中 + 此处再自查 tokenOk,【绝不】带
  //    body-token 兜底 —— R-P2-2 签发主权律:被注入的模型经 MCP 子进程 loopback 拿的是 body-token,永无签发/撤销能力)。──
  if (pathname === '/api/autonomy/grants') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    const sessionId = safeSessionId(q.sessionId);
    if (!sessionId) return send(res, apiSessionIdInvalid());
    return send(res, json({ ok: true, grants: listGrantsView(sessionId), activeRun: activeDriverRunOf(sessionId) }));
  }
  if (req.method === 'POST' && pathname === '/api/autonomy/grant') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body.sessionId);
    if (!sessionId) return send(res, apiSessionIdInvalid());
    const session = await loadSession(sessionId);
    if (!session) return send(res, apiSessionNotFound());
    const config = await readConfig();
    const norm = normalizeGrant(body, session, config, Date.now());
    if (!norm.ok) return send(res, json({ ok: false, error: norm.error }, 400));
    const g = norm.grant;
    // dry-run:签发瞬间 glob 一次,展示将命中的工作区内文件(所见即所授闭环)。边界内、有限步、best-effort。
    let dryRun = { count: 0, sample: [], truncated: false };
    if (g.tier === 'read' || g.tier === 'edit') {
      try { dryRun = await dryRunGrantFiles(g, 40); } catch { /* best-effort */ }
    }
    // preview 模式:只 normalize + dry-run,【不】入 Map、不发审计/SSE —— 供 UI「预览命中」无副作用。
    if (body.preview === true) {
      return send(res, json({ ok: true, preview: true, grant: { tool: g.tool, tier: g.tier, scope: g.scope, pathGlob: g.pathGlob, cmdAllow: g.cmdAllow, netAllowed: g.netAllowed, maxUses: g.maxUses }, dropped: norm.dropped, dryRun }));
    }
    installGrant(sessionId, g);
    logEvent({ kind: 'autonomy_grant_issued', grantId: g.grantId, sessionId, tool: g.tool, tier: g.tier, scope: g.scope, pathGlob: g.pathGlob, cmdAllow: g.cmdAllow, netAllowed: g.netAllowed, maxUses: g.maxUses, ttlMs: g.ttlMs });
    const reg = activeChildren.get(sessionId);
    if (reg && reg.onEvent) { try { reg.onEvent({ type: 'autonomy_grant', grants: listGrantsView(sessionId) }); } catch { /* stream gone */ } }
    return send(res, json({ ok: true, grant: listGrantsView(sessionId).find(x => x.grantId === g.grantId) || null, dropped: norm.dropped, dryRun }));
  }
  if (req.method === 'POST' && pathname === '/api/autonomy/revoke') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body.sessionId);
    if (!sessionId) return send(res, apiSessionIdInvalid());
    let n = 0;
    if (body.all === true) n = revokeAllGrants(sessionId, 'ui-revoke-all');
    else if (body.grantId) n = revokeGrant(sessionId, String(body.grantId)) ? 1 : 0;
    else return send(res, json({ ok: false, error: '需提供 grantId 或 all:true' }, 400));
    const reg = activeChildren.get(sessionId);
    if (reg && reg.onEvent) { try { reg.onEvent({ type: 'autonomy_grant', grants: listGrantsView(sessionId) }); } catch { /* stream gone */ } }
    return send(res, json({ ok: true, revoked: n, grants: listGrantsView(sessionId) }));
  }
  if (req.method === 'POST' && pathname === '/api/agent-workflow/launch') {
    // Claude CLI's one-shot MCP child proxies the persistent DAG into the serve process. v1.4.4: the DAG
    // is genuinely dual-engine now — each node picks 'openai' (HTTP against a configured Provider) or
    // 'claude' (a native one-shot `claude` CLI spawn, runClaudeSubAgentOnce) via runAgentWorkflow's
    // per-node engine resolution, so a Claude-CLI-only setup no longer needs a Provider configured at all.
    const body = await readJsonBody(req);
    if (!tokenMatches(body.token)) return send(res, json({ ok: false, error: 'bad token' }, 403));
    const sessionId = safeSessionId(body.sessionId);
    if (!sessionId) return send(res, apiSessionIdInvalid());
    const session = await loadSession(sessionId);
    if (!session) return send(res, apiSessionNotFound());
    const config = await readConfig();
    const reg = activeChildren.get(sessionId);
    const provider = resolveProvider(config, body.providerId)
      || activeOpenAiProvider(config)
      || (config.providers || []).find(p => p && p.baseUrl && (p.model || (p.models && p.models.length)));
    // A direct UI/MCP launch has no active parent registry. In a Claude-only installation, defaulting such
    // a launch to OpenAI manufactured an unusable route with provider=null and failed before the fake/real
    // Claude child could start. Choose from actual availability when no live parent turn exists.
    // 2026-10:只有活着的 Claude / provider 父回合才决定默认引擎。Kimi Code 父回合(reg.kind 'kimi-acp')修前被一律当成
    // 'openai',没配 provider 时路由成 provider=null,节点一启动就抛 Cannot read properties of null —— 节点引擎只有
    // openai / claude 两种,Kimi 父回合与「没有父回合」一样按实际可用的引擎挑。
    const parentEngine = reg && reg.kind === 'claude' ? 'claude'
      : (reg && reg.kind === 'openai' ? 'openai' : (provider ? 'openai' : 'claude'));
    const parentModel = parentEngine === 'claude'
      ? String(config.model || '')
      : String(provider && (provider.model || (provider.models && provider.models[0] && (provider.models[0].id || provider.models[0]))) || '');
    const claudeCli = config.claudePath || detectClaudePath();
    const claudeCliUsable = Boolean(process.env.WCW_FAKE_CLAUDE) || Boolean(claudeCli && await existsExecutableAsync(claudeCli)); // test seam, see runClaudeTurn; 128f-⑬ 异步
    // Only reject up front when NEITHER engine could possibly run anything; a specific node explicitly
    // requesting an unavailable engine still fails gracefully per-node inside runAgentWorkflow.
    if (!provider && !claudeCliUsable) {
      // 61-C6:说清 Claude CLI 找的是哪(修前探测对不存在的 claude.cmd 也判可用,走不到这里;现在走得到,就要说得清)。
      const where = claudeCli ? `找过 ${claudeCli},不可用` : '没有配置 claudePath,PATH 里也找不到 claude';
      return send(res, json({ ok: false, error: `Agent DAG 需要至少配置一个 OpenAI 兼容 Provider，或安装并配置 Claude CLI(${where})（Kimi Code 不能作为工作流节点的引擎）` }, 400));
    }
    // 2026-10:工作流按【这条线程】的生效权限档跑 —— 修前直接取全局 config.permissionMode,线程在自己的权限 chip 上收紧过也照
    // 全局放。有活着的父回合就用它起回合时解析出的档(请求级 > 会话级 > 全局,05/09 登记在 reg.permissionMode),否则按
    // 会话级 > 全局解析(与续跑、恢复分级 agentRunPermissionMode 同一个解析器)。
    // provider 回合登记了 effectivePermissionMode()(回合中途在线程 chip 上收紧会被它看到),优先用它;其次是起回合时的快照。
    const liveMode = reg && typeof reg.effectivePermissionMode === 'function' ? (() => { try { return reg.effectivePermissionMode(); } catch { return ''; } })() : (reg && reg.permissionMode);
    const launchPermissionMode = PERMISSION_MODES.includes(liveMode) ? liveMode : resolvePermissionMode({ session, config });
    // 代理模式 v2:事件只在【发起时的那个回合】仍是活回合时进它的流(回合结束后 run 继续跑,但不往关掉的 SSE
    // 写、也不串进后来的回合);run 自己的事件日志与 GET /api/agent-runs 始终是权威实时面。
    const onEvent = reg && reg.onEvent ? (evt => { const live = activeChildren.get(sessionId); if (live === reg && live.onEvent) live.onEvent(evt); }) : () => {};
    const resolved = await resolveOrchestrateNodes(body, normalizeCwd(session.cwd, config.defaultWorkspace));
    if (resolved.error) return send(res, json({ ok: false, error: resolved.error, startedCount: 0 }));
    const wantEnvelope = body.envelope === true;
    // v1.4.4: a persisted DAG's node-count ceiling is agentWorkflowMaxNodes, NOT subagentMaxPerTurn (that's
    // an ad hoc, single-CHAT-TURN spawn_agent/orchestrate_agents fan-out budget — a 4-node default there
    // used to reject any real pipeline with 5+ nodes outright here, even though resuming the same run used
    // a hardcoded 32).
    const contextText = String(body.context || '').trim();
    // 代理模式 v2:完成 → 交付信封进后台任务账本(隐藏的数据面回执 + toast + 下一回合开头注入一次),不再往对话里
    // 追加整份「Agent 工作流已结束」助手消息(那条会被 syncProviderHistoryFromDisplay 抄进模型上下文)。
    const completion = run => deliverAgentRunEnvelope(session.id, run);
    const background = body.async === true || body.background === true;
    // 只有 Claude/Kimi 的 MCP 子进程回环(envelope:true)替模型发起的 background:true 才算「模型起的」:跑完才会唤醒主会话。
    // 面板 / HTTP 的 async:true 是用户点的,信封照常进账本、随下一回合送达,但不替模型起回合。
    const launchedByModel = body.envelope === true && body.background === true;
    if (background) {
      const runId = makeId('run');
      // 与 launchPersistedAgentRun 同款:等到登记进 activeAgentRuns(或登记前就退出)再回。修前发起即回 accepted ——
      // 校验失败(重复节点 id、缺角色、依赖坏)以 { ok:false } 返回却没人看,调用方拿到 runId 却永远等不到这次运行;
      // 受理后立刻 pause / stop / 插话也会被 409「工作流当前未运行」拒掉。
      let markRegistered = null;
      const registered = new Promise(resolve => { markRegistered = resolve; });
      const finished = runAgentWorkflow({ parentSession: session, provider, config, nodes: resolved.nodes, onEvent, permModeOverride: launchPermissionMode, maxNodes: Math.max(0, Number(config.agentWorkflowMaxNodes) || 0), contextText, runIdOverride: runId, onComplete: completion, poolPolicy: body.poolPolicy, parentEngine, parentModel, background: true, launchedByModel, onRegistered: () => markRegistered() }).catch(async e => {
        activeAgentRuns.delete(runId); // 对抗轮 P2: 启动期抛出时兜底清注册(与 launchPersistedAgentRun 的 catch 对齐)
        const run = { schemaVersion: 4, id: runId, sessionId: session.id, turnSeq: session.turnSeq, providerId: provider && provider.id || '', status: 'failed', background: true, launchedByModel, createdAt: nowIso(), updatedAt: nowIso(), completedAt: nowIso(), error: String(e && e.message || e), nodes: [] };
        await saveAgentRun(run).catch(() => {});
        await completion(run).catch(() => {});
        return { ok: false, error: run.error, reported: true };
      });
      const first = await Promise.race([registered.then(() => null), finished]);
      if (first && first.ok === false && !first.reported) return send(res, json({ ok: false, error: first.error || '工作流未能启动', startedCount: 0 }));
      return send(res, json({ ok: true, accepted: true, background: true, status: 'running', runId, nodes: resolved.nodes.map(n => n && n.id).filter(Boolean), note: '代理已在后台运行;完成后交付信封会自动送达一次(也可 wait_agents 收件);全文用 agent_result 取。' }));
    }
    // 同步:MCP 回环(envelope:true)拿信封,并登记已读(它就是投递本身);UI/管理面(不带 envelope)照旧拿整份结果,
    // 且当没有活回合时把信封投进账本,让模型下一回合知道这件事。
    let completedRun = null;
    const result = await runAgentWorkflow({ parentSession: session, provider, config, nodes: resolved.nodes, onEvent, permModeOverride: launchPermissionMode, maxNodes: Math.max(0, Number(config.agentWorkflowMaxNodes) || 0), contextText, onComplete: async run => { completedRun = run; }, poolPolicy: body.poolPolicy, parentEngine, parentModel });
    if (wantEnvelope) {
      if (!completedRun) return send(res, json({ ok: false, error: (result && result.error) || '代理启动失败', runId: result && result.runId || '', startedCount: 0 }));
      if (EventStreamHooks.markAgentEnvelopeDelivered) {
        const liveReg = activeChildren.get(sessionId);
        if (liveReg && liveReg.session) EventStreamHooks.markAgentEnvelopeDelivered(liveReg.session, completedRun.id);
        else await mutateSession(sessionId, fresh => { EventStreamHooks.markAgentEnvelopeDelivered(fresh, completedRun.id); }, { writer: 'agent_envelope_delivered' }).catch(() => {}); // 读-改-写走 mutateSession
      }
      return send(res, json(buildAgentRunEnvelope(completedRun)));
    }
    if (completedRun && !activeChildren.has(session.id)) await completion(completedRun).catch(() => {});
    return send(res, json(result));
  }
  // 代理模式 v2:MCP 子进程(Claude/Kimi)的 wait_agents / agent_result 回环(实现见 agentWorkflowLoopbackRoute)。
  if (req.method === 'POST' && pathname === '/api/agent-workflow/wait') return agentWorkflowLoopbackRoute(req, res, 'wait');
  if (req.method === 'POST' && pathname === '/api/agent-workflow/result') return agentWorkflowLoopbackRoute(req, res, 'result');
  await handleUsageApiRoutes(req, res, pathname); if (res.writableEnded) return;
  // EC-D Wave 65: Agent Run query, event, and control routes live in 13d-core-domain-routes.js.
  await handleAgentRunApiRoutes(req, res, pathname); if (res.writableEnded) return;
  await handleCheckpointQueryApiRoutes(req, res, pathname); if (res.writableEnded) return;
  await handleLocalSupportApiRoutes(req, res, pathname); if (res.writableEnded) return;
  // 49f(A1): MCP 域路由抽至 13b-api-domain-routes.js(import-folder/import-config scan|apply)。
  await handleMcpApiRoutes(req, res, pathname); if (res.writableEnded) return; // send 无返回值,以响应已结束为命中信号
  await handleDiagnosticsApiRoutes(req, res, pathname); if (res.writableEnded) return;
  await handleCheckpointApiRoutes(req, res, pathname); if (res.writableEnded) return;
  // 49f(A1): steer 域路由抽至 13b-api-domain-routes.js。
  await handleSteerApiRoute(req, res, pathname); if (res.writableEnded) return;
  // 127-114b: audio 域路由(/api/audio/transcribe)同住 13b-api-domain-routes.js —— 13→13b 既有边,零新边。
  await handleAudioApiRoutes(req, res, pathname); if (res.writableEnded) return;
  // 管家域在依赖装配完毕后注册路由。
  if (typeof StewardHooks.handleApiRoutes === 'function') { await StewardHooks.handleApiRoutes(req, res, pathname); if (res.writableEnded) return; }
  // 第121波 K2a(34 号文 §6.1): GET /api/events/stream 住 13r-event-stream.js(拼接顺序在本文件【之后】)。
  // 同 StewardHooks 纪律 —— 直接写函数名会是新前向边,故经 00-boot 的延迟绑定命名空间挂接。
  // 命中信号是 headersSent 而不是 writableEnded:SSE 连接【故意不 end】,一直开着流事件,
  // writableEnded 永远是 false,只看它会让这条请求继续往下走、最后撞上 404 那行的二次 writeHead。
  if (typeof EventStreamHooks.handleApiRoutes === 'function') { await EventStreamHooks.handleApiRoutes(req, res, pathname); if (res.headersSent || res.writableEnded) return; }
  // 第123波 M1(37 号文 §3.3): 定时任务六条域路由住 13s-scheduler.js(拼接顺序在本文件【之后】)。
  // 接法沿 13b/13c/13d —— 直调函数名,构成一条【前向边】13 → 13s,已登记进
  // src/module-dependency-policy.json 的 allowedForwardEdges 并附来路。为什么不走 Hooks 迟绑定:
  // 那三条域路由的先例就是直调,路由清册的扫描器也按 `await handleXxxApiRoutes(` 这个形状认委派行;
  // 再造一个 Hooks 只会让清册多一个看不见的入口(13g/13r 走 Hooks 是因为它们【必须】,不是偏好)。
  await handleSchedulerApiRoutes(req, res, pathname); if (res.writableEnded) return;
  await handleAttachmentApiRoutes(req, res, pathname); if (res.writableEnded) return;
  if (req.method === 'POST' && pathname === '/api/chat/stream') {
    // 116-3 A2:管家会话不接受普通聊天入口发起的回合(判据与抛点在 10 的 runSessionTurn 顶部;
    // 那里抛得比 onStart 早,响应头还没发出,所以这里能给一条正经的 403 稳定信封)。
    try {
      return await streamChat(req, res);
    } catch (error) {
      if (error && error.code === 'STEWARD_SESSION_FORBIDDEN') {
        return send(res, apiFailure('steward.forbidden', {}, String(error.message || 'forbidden'), 403));
      }
      // 117s-G:活回合是【别处】起的 —— 回「忙」,不杀。判据与抛点同在 10 的 runSessionTurn 顶部,
      // 抛得比 onStart 早,所以这里响应头还没发出,能给一条正经的 409 稳定信封。
      if (error && error.code === 'SESSION_TURN_BUSY_ELSEWHERE') {
        return send(res, apiFailure('session.turn_busy_elsewhere', { turnSource: String(error.turnSource || '') },
          String(error.message || 'the session is running a turn started elsewhere'), 409));
      }
      throw error;
    }
  }
  if (req.method === 'POST' && pathname.startsWith('/api/tools/')) {
    const body = await readJsonBody(req);
    const name = pathname.split('/').pop();
    // v0.8-S4a: a direct tool call may carry `sessionId` (and optionally `turnSeq`) so file mutations
    // checkpoint under that session. With sessionId only, turnSeq is read from the session file; an explicit
    // turnSeq pins the entry to a specific turn (used by e2e to exercise cross-turn rollback). Absent →
    // journalSessionCtx resolves to no context and journaling silently no-ops. Extra keys are ignored by the file tools.
    const ctx = body && body.sessionId ? { sessionId: String(body.sessionId), ...(Number.isFinite(Number(body.turnSeq)) && body.turnSeq !== '' && body.turnSeq != null ? { turnSeq: Number(body.turnSeq) } : {}) } : null;
    // v1.1-W2 (T1): thread session+config into ctx so http_download can guard its dest against the session's
    // write roots (guardDownloadDest → guardFileToolPath, 安全审计 #3). Best-effort; a load failure just falls
    // back to the config read from disk inside guardFileToolPath, never blocking the other tools.
    if (ctx) {
      if (body.memoryLiveRead === true && ['workbench_memory_list', 'workbench_memory_read'].includes(name)) ctx.memoryLiveRead = true;
      try {
        ctx.config = await readConfig();
        const s = await loadSession(ctx.sessionId).catch(() => null);
        if (s) ctx.session = s;
      } catch { /* degrade gracefully */ }
    }
    // 未知工具名是 404,不是服务端故障(修前 toolCall 抛「Unknown tool」→ 500 + http_unhandled;
    // 原型链上的名字如 constructor 更会在 entry.handler 上抛 TypeError)。
    if (!Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name)) {
      return send(res, apiFailure('tool.unknown', { name }, `Unknown tool: ${name}`, 404));
    }
    let result;
    try { result = await toolCall(name, body, ctx); }
    catch (error) {
      // 工具自己抛的普通 Error(「pattern is required」「url must start with http://」、ENOENT 之类)是这次调用
      // 的参数/对象有问题 → 400 tool.failed。编程错误(TypeError/ReferenceError…)与自带状态码的照旧交给顶层:
      // 500 + http_unhandled 日志,真 bug 不被 400 掩掉。
      const programming = error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError || error instanceof RangeError;
      if (!error || programming || error.statusCode) throw error;
      return send(res, apiFailure('tool.failed', { name }, String(error.message || error), 400));
    }
    // 审计 N5:toolCall 的入参校验以结果对象回(invalid-arguments),HTTP 面仍按修前口径 —— 参数错是 400 tool.failed,不是 200。
    if (result && result.ok === false && result.code === 'invalid-arguments') return send(res, apiFailure('tool.failed', { name, ...(typeof result.argsGuide === 'string' ? { argsGuide: result.argsGuide } : {}) }, String(result.error || 'invalid arguments'), 400));   // 代叫参数错递的骨架别在 HTTP 面丢掉
    return send(res, json({ ok: true, result }));
  }
  return send(res, apiFailure('api.route_not_found', {}, 'Not found', 404));
}

async function startMcp() {
  await ensureDirs();
  // Stateful shell sessions belong to the serving process, not this MCP child.
  RUNTIME.isMcpChild = true;
  return require('./backend/mcp-server.cjs').createMcpServer({
    input: process.stdin, output: process.stdout, env: process.env, version: VERSION, configPath: paths.config,
    readConfig, PrivacyGateway, ProcessRuntime, observationRecallEnabled, policyDesktopOverrideFor, runtimeToolRequirementsMet, nativeToolDisabledByPolicy, isStewardToolName, toolPackForName, toolCall, VisualPipeline, truncateToolResult, maskProviders, samePathKey, killAllMcpClients, safeJsonParse, MCP_TOOLS
  }).start();
}

async function installIntegration() {
  await ensureDirs();
  const config = await readConfig();
  const mcpPath = await generateMcpConfig();
  console.log(`${APP_NAME} integration`);
  console.log(`Data root: ${paths.data}`);
  console.log(`MCP config: ${mcpPath}`);
  console.log(`Claude CLI: ${config.claudePath || '(not configured)'}`);
  if (config.claudePath && existsExecutable(config.claudePath)) {
    // 3.0:先移除旧 id 的登记(win-claude-workbench;没有就报错,忽略),再按新 id 'ruyi' 登记 —— 否则 Claude Code 里
    // 同一个工作台 MCP 会以两个名字各起一个子进程。
    // 逐个作用域删:老版本 node install 登记在 local、安装脚本登记在 user;不带 -s 时同一个 id 在多个作用域里都有会直接报错。
    for (const legacyId of LEGACY_RUYI_MCP_SERVER_IDS) {
      for (const scope of ['local', 'user', 'project']) {
        try { await DesktopShell.runProcess(config.claudePath, ['mcp', 'remove', legacyId, '-s', scope], { cwd: os.homedir(), timeoutMs: 15000 }); } catch { /* 这个作用域里没登记过 */ }
      }
    }
    const result = await DesktopShell.runProcess(config.claudePath, ['mcp', 'add-json', RUYI_MCP_SERVER_ID, JSON.stringify(JSON.parse(await fsp.readFile(mcpPath, 'utf8')).mcpServers[RUYI_MCP_SERVER_ID])], {
      cwd: os.homedir(),
      timeoutMs: 30000,
    });
    console.log(result.stdout || result.stderr || JSON.stringify(result, null, 2));
  }
  // v1.4.3: full sync — settings.json + agent roles + MCP servers
  await syncClaudeCliSettings(config);
  await syncAgentRolesToClaude(config.defaultWorkspace || os.homedir(), config);
  await syncMcpServersToClaude(config);
  console.log('Claude CLI synced: settings+agents+mcp (permissionMode=' + config.permissionMode + ')');
}

const { doctor, parseArgs, doctorHealthSeverity, doctorHumanLines } = require('./backend/cli-diagnostics.cjs').createCliDiagnostics({
  externalRoot, publicDirectory: path.join(__dirname, 'public'), ensureDirs, readConfig, generateMcpConfig,
  APP_NAME, VERSION, exePath, paths, detectClaudePath, existsExecutable, computeHealth,
});
