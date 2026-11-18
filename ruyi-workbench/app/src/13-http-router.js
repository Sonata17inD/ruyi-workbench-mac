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

const handleMissionLedgerApiRoutes = require('./backend/mission-ledger-routes.cjs').createMissionLedgerRoutes({
  tokenOk, tokenMatches, safeSessionId, loadSession, mutateSession, activeChildren, readConfig, nowIso, logEvent,
  todos: { normalizeTodoItems },
  missions: { missionControlCommand, evaluateMissionCheck, recordMissionCheckResult, MISSION_MAX_TEXT,
    maybeFinalizeMission, bumpMissionChangeSeq, normalizeMission, applyMissionUpdate },
});

const handleAutonomyGrantApiRoutes = require('./backend/autonomy-grant-routes.cjs').createAutonomyGrantRoutes({
  tokenOk, safeSessionId, loadSession, activeChildren, readConfig, logEvent, activeDriverRunOf,
  grants: { listGrantsView, normalizeGrant, dryRunGrantFiles, installGrant, revokeAllGrants, revokeGrant },
});

const handleAgentWorkflowApiRoutes = require('./backend/agent-workflow-routes.cjs').createAgentWorkflowRoutes({
  process, tokenOk, tokenMatches, safeSessionId, loadSession, mutateSession, activeChildren, readConfig, nowIso, makeId,
  engines: { resolveProvider, activeOpenAiProvider, detectClaudePath, existsExecutableAsync },
  workflow: { resolveOrchestrateNodes, runAgentWorkflow, activeAgentRuns, saveAgentRun, AGENT_RUN_TERMINAL },
  delivery: { EventStreamHooks, waitForAgentRunResults, resolveWaitAgentsMs, settleWaitEnvelopes, agentRunResultSlice,
    deliverAgentRunEnvelope, buildAgentRunEnvelope },
});

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
  await handleMissionLedgerApiRoutes(req, res, pathname); if (res.writableEnded) return;
  await handleAutonomyGrantApiRoutes(req, res, pathname); if (res.writableEnded) return;
  await handleAgentWorkflowApiRoutes(req, res, pathname); if (res.writableEnded) return;
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
