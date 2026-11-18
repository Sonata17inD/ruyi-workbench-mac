// Kimi Code integration. Turns use the official ACP JSON-RPC/NDJSON protocol; the local Server API remains
// operation-scoped for native compaction, and the documented wire transcript supplements ACP's usage update
// with exact compaction/failure state. A separate ACP process is kept for the whole Ruyi turn so reverse RPC
// (permissions/questions) and queued follow-up steering share one live native Kimi session.
const kimiBridgeState = { child: null, port: 0, token: '', starting: null, admission: null, signalHooked: false };
const { classifyKimiAcpReadonlySearch, KIMI_ACP_SEARCH_BLOCKED_ENV_RE } =
  require('./backend/kimi-search-policy.cjs').createKimiSearchPolicy({
    dataRoot, appRoot, pathWithinRoot, fileAllowedRoots, realpathForContainment, isSensitiveDataPath, guardFileToolPath,
  });
const buildKimiAcpPromptParts = require('./backend/kimi-prompt-parts.cjs').createKimiPromptParts({
  guardFileToolPath, realpathForContainment,
});


const { createKimiAcpRpc: createAcpRpc, kimiAcpContentText, kimiAcpRequestError } = require('./backend/kimi-acp-rpc.cjs');
const {
  contextResetKimiAcpPlanApproval, kimiAcpObserveNativeMode,
  kimiAcpCapabilityState, kimiAcpSessionRestoreMethods, kimiAcpUnknownSessionError, kimiAcpRestoreSession,
  kimiAcpLifecycle, kimiAcpFindConfigOption, kimiAcpRememberConfigActual, kimiAcpActivatedActualConfigValue,
  kimiAcpNoteConfigActual, kimiAcpFreshActualForOperation, kimiAcpStoreConfigOptions, kimiAcpSyncActualConfig,
  kimiAcpModeOptionFromActivated, applyKimiAcpTurnConfig,
} = require('./backend/kimi-acp-session.cjs');

const {
  kimiCodeHome, readKimiWireRuntime, parseKimiWireCompaction, parseKimiWireAgentEvents,
  watchKimiWire, kimiAcpWireCheckpoint, kimiAcpWireOutcome,
} = require('./backend/kimi-wire.cjs');
const { createKimiAcpInterventions, kimiAcpSamePath } = require('./backend/kimi-acp-interventions.cjs');
const {
  cancelKimiAcpIntervention, kimiAcpExplicitToolInput, kimiAcpInferConcreteToolInput, kimiAcpPermissionToolCall,
  handleKimiAcpPermissionRequest, consumeKimiAcpApproval, kimiAcpSuccessfulEnterPlanMode,
  kimiAcpNativeShellQuote, kimiAcpNativeBashWrapperTexts, kimiAcpNativeBashWrapperCandidate,
  ensureKimiAcpOperationPermission, handleKimiAcpElicitation,
} = createKimiAcpInterventions({
  dataRoot, fileAllowedRoots, workspaceWriteRoots, guardFileToolPath, realpathForContainment,
  makeId, requestNativePermission: (...args) => requestNativePermission(...args), requestUserQuestion,
  permissionWaitMs, runAutomaticInterventionDecision, buildOpenSpawn, spawnDetachedChecked, process,
});
const {
  isKimiAcpPlanFilePath, resolveKimiAcpPlanFilePath, handleKimiAcpFsRequest,
  kimiAcpApplyPlan, kimiAcpPlanFileFromUpdate, kimiAcpPlanIdFromUpdate, kimiAcpPlanSnapshotFromUpdate,
} = require('./backend/kimi-acp-files.cjs').createKimiAcpFiles({
  realpathForContainment, kimiAcpSamePath, guardFileToolPath, ensureKimiAcpOperationPermission,
  toolCall: (...args) => toolCall(...args), normalizeTodoItems,
});
const {
  handleKimiAcpTerminalRequest, cleanupKimiAcpTerminals, killKimiAcpTerminal,
  kimiAcpTerminalRef, kimiAcpTerminalDisplayResult,
} = require('./backend/kimi-acp-terminals.cjs').createKimiAcpTerminals({
  classifyKimiAcpReadonlySearch, KIMI_ACP_SEARCH_BLOCKED_ENV_RE, guardWorkspaceExecute,
  ensureKimiAcpOperationPermission, kimiAcpNativeBashWrapperCandidate, ProcessRuntime, killChildTree, makeId,
});

function createKimiAcpRpc(child, handlers) {
  return createAcpRpc(child, handlers, () => PrivacyGateway.assertCliAllowed());
}

async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && address.port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function kimiHttp(port, token, method, pathname, body) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  const payload = raw ? safeJsonParse(raw) : null;
  if (!response.ok) {
    const detail = payload && (payload.msg || payload.message || payload.detail);
    throw new Error(`Kimi Server HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  if (payload && Number(payload.code) !== 0) throw new Error(payload.msg || payload.message || `Kimi Server code ${payload.code}`);
  return payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
}

async function ensureKimiServer(config) {
  if (kimiBridgeState.port && kimiBridgeState.token) {
    try {
      await kimiHttp(kimiBridgeState.port, kimiBridgeState.token, 'GET', '/api/v1/sessions');
      return kimiBridgeState;
    } catch { /* restart below */ }
  }
  if (kimiBridgeState.starting) return kimiBridgeState.starting;
  const admission = new AbortController();
  kimiBridgeState.admission = admission;
  kimiBridgeState.starting = (async () => {
    const tokenFile = path.join(kimiCodeHome(), 'server.token');
    let token = '';
    try { token = String(await fsp.readFile(tokenFile, 'utf8')).trim(); } catch { /* login/server may create it */ }
    const driver = selectedAgentCli({ ...config, agentCliType: 'kimi' });
    if (!driver.path || !(await agentCliLauncherUsable(driver.path))) throw new Error('未检测到 Kimi Code CLI');   // 异步 + 记忆,超时不算缺失(见 01 agentCliLauncherUsable)
    const port = await freeLoopbackPort();
    const launch = prepareAgentCliSpawn('kimi', driver.path, ['web', '--port', String(port), '--no-open', '--log-level', 'warn']);
    const child = await ProcessRuntime.spawn(launch.command, launch.args, {
      cwd: normalizeCwd(config.defaultWorkspace, os.homedir()), env: process.env,
      stdio: ['ignore', 'ignore', 'ignore'], ...launch.opts, signal: admission.signal,
    }, { kind: 'kimi-server' });
    child.on('error', () => {});
    kimiBridgeState.child = child;
    kimiBridgeState.port = port;
    if (!kimiBridgeState.signalHooked) {
      kimiBridgeState.signalHooked = true;
      // startServer owns the actual process.exit signal handlers. This listener only closes the direct
      // Node child first; spawning taskkill from process 'exit' is unsafe in libuv's closing phase.
      const closeOnSignal = () => { try { if (kimiBridgeState.child) killChildTree(kimiBridgeState.child); } catch { /* ignore */ } };
      process.once('SIGINT', closeOnSignal);
      process.once('SIGTERM', closeOnSignal);
    }
    let lastError = null;
    for (let i = 0; i < 80; i++) {
      if (!token) { try { token = String(await fsp.readFile(tokenFile, 'utf8')).trim(); } catch { /* retry */ } }
      if (token) {
        try {
          await kimiHttp(port, token, 'GET', '/api/v1/sessions');
          kimiBridgeState.token = token;
          return kimiBridgeState;
        } catch (error) { lastError = error; }
      }
      if (child.exitCode != null) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    try { if (child.pid) killChildTree(child); } catch { /* ignore */ }
    kimiBridgeState.child = null; kimiBridgeState.port = 0; kimiBridgeState.token = '';
    throw lastError || new Error('Kimi Server 启动超时；请先运行 kimi login');
  })();
  try { return await kimiBridgeState.starting; } finally { kimiBridgeState.starting = null; }
}

async function stopKimiServer() {
  kimiBridgeState.admission?.abort();
  const child = kimiBridgeState.child;
  kimiBridgeState.child = null; kimiBridgeState.port = 0; kimiBridgeState.token = '';
  if (!child || child.exitCode != null) return;
  await new Promise(resolve => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => {
      try { if (child.pid) killChildTree(child); } catch { /* ignore */ }
      done();
    }, 2000);
    child.once('close', done);
    try { killChildTree(child); } catch { done(); }
  });
}

async function kimiApi(config, method, pathname, body) {
  const bridge = await ensureKimiServer(config);
  if (method === 'POST' && pathname.endsWith(':compact') && typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertSupported(await readConfig(), 'cli');
  return kimiHttp(bridge.port, bridge.token, method, pathname, body);
}

async function syncKimiTurnPreferences(config) {
  const effort = String(config && config.claudeThinkingEffort || '');
  if (!['low', 'high', 'max'].includes(effort)) return false;
  try {
    await kimiApi(config, 'POST', '/api/v1/config', { thinking: { enabled: true, effort } });
    return true;
  } finally { await stopKimiServer(); }
}

function normalizeKimiStatus(data) {
  const contextTokens = Number(data && data.context_tokens) || 0;
  const contextWindow = Number(data && data.max_context_tokens) || 0;
  return {
    busy: Boolean(data && data.busy),
    model: String(data && data.model || ''),
    thinkingLevel: String(data && data.thinking_level || ''),
    permission: String(data && data.permission || ''),
    planMode: Boolean(data && data.plan_mode),
    contextTokens,
    contextWindow,
    contextUsage: Number(data && data.context_usage) || (contextWindow > 0 ? contextTokens / contextWindow : 0),
  };
}

async function kimiSessionStatus(config, nativeSessionId, modelHint) {
  if (!nativeSessionId) return { ok: false, error: 'Kimi 原生会话尚未建立' };
  const wire = await readKimiWireRuntime(nativeSessionId);
  if (wire) {
    const model = String(modelHint || config && config.model || '');
    const contextWindow = await kimiContextWindow(config, model);
    return {
      ok: true, busy: wire.busy, model, thinkingLevel: String(config && config.claudeThinkingEffort || ''),
      permission: String(config && config.permissionMode || ''), planMode: config && config.permissionMode === 'plan',
      contextTokens: wire.tokens, contextWindow, contextUsage: contextWindow > 0 ? wire.tokens / contextWindow : 0,
      source: 'kimi-wire',
    };
  }
  try {
    const data = await kimiApi(config, 'GET', `/api/v1/sessions/${encodeURIComponent(nativeSessionId)}/status`);
    return { ok: true, ...normalizeKimiStatus(data) };
  } catch (error) { return { ok: false, error: (error && error.message) || '读取 Kimi 状态失败' }; }
  finally { await stopKimiServer(); }
}

function kimiUsageFromStatus(status) {
  return {
    usage: {},
    contextTokens: Number(status && status.contextTokens) || 0,
    contextWindow: Number(status && status.contextWindow) || 0,
    model: String(status && status.model || ''),
    contextEngine: 'agent',
    contextAgentCliType: 'kimi',
    contextModel: String(status && status.model || ''),
    source: 'kimi-native',
  };
}

function applyKimiStatusToSession(session, status) {
  if (!session || !status || !status.ok) return null;
  const usage = kimiUsageFromStatus(status);
  session.kimiContextStatus = { ...status, updatedAt: nowIso() };
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'assistant') { messages[i].usage = usage; break; }
  }
  return usage;
}

// 会话上「Kimi 上下文状态」的指纹(kimiContextStatus 去掉每次都变的 updatedAt + 最后一条 assistant 的 usage):
// /api/kimi/status 只在指纹变了才落盘(见 13-http-router)。
function kimiStatusFingerprint(session) {
  const st = session && session.kimiContextStatus;
  const { updatedAt: _ts, ...rest } = (st && typeof st === 'object') ? st : {};
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  let usage = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'assistant') { usage = messages[i].usage || null; break; }
  }
  return JSON.stringify([st ? rest : null, usage]);
}

async function syncKimiSessionUsage(session, config, onEvent) {
  const status = await kimiSessionStatus(config, session && session.claudeSessionId, session && session.claudeSessionModel);
  if (!status.ok) return null;
  const usage = applyKimiStatusToSession(session, status);
  if (usage && onEvent) onEvent({ type: 'usage', ...usage });
  return usage;
}

async function compactKimiNative(config, nativeSessionId, instruction, onEvent) {
  if (typeof PrivacyGateway !== 'undefined') { PrivacyGateway.assertSupported(config, 'cli'); PrivacyGateway.assertSupported(await readConfig(), 'cli'); }
  const before = await kimiSessionStatus(config, nativeSessionId);
  if (!before.ok) return before;
  const beforeWire = await readKimiWireRuntime(nativeSessionId);
  if (onEvent) onEvent({ type: 'compact', mode: 'kimi-native', phase: 'started', trigger: 'manual', beforeTokens: before.contextTokens, contextWindow: before.contextWindow });
  try {
    // A long-lived Kimi Web process caches the session snapshot it loaded. Always start this operation
    // from a fresh process so compaction includes turns appended by Ruyi's separate CLI child.
    await stopKimiServer();
    if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertSupported(await readConfig(), 'cli');
    await kimiApi(config, 'POST', `/api/v1/sessions/${encodeURIComponent(nativeSessionId)}:compact`, instruction ? { instruction } : {});
  } catch (error) {
    const message = (error && error.message) || 'Kimi 压缩请求失败';
    if (onEvent) onEvent({ type: 'compact', mode: 'kimi-native', phase: 'failed', error: message });
    await stopKimiServer();
    return { ok: false, error: message };
  }
  let after = before;
  let sawBusy = false;
  let operationDone = false;
  for (let i = 0; i < 360; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    after = await kimiSessionStatus(config, nativeSessionId);
    if (!after.ok) continue;
    if (after.busy) sawBusy = true;
    const wireNow = await readKimiWireRuntime(nativeSessionId);
    const completedAfterStart = Boolean(wireNow && beforeWire && wireNow.compactionCompletes > beforeWire.compactionCompletes);
    const tokensChanged = after.contextTokens > 0 && after.contextTokens !== before.contextTokens;
    if (!after.busy && (sawBusy || completedAfterStart || tokensChanged)) { operationDone = true; break; }
    if (onEvent && i > 0 && i % 10 === 0) onEvent({ type: 'compact', mode: 'kimi-native', phase: 'running', elapsedMs: (i + 1) * 500, beforeTokens: before.contextTokens });
  }
  if (!operationDone || !after.ok || after.busy) { await stopKimiServer(); return { ok: false, error: 'Kimi 压缩等待超时' }; }
  if (onEvent) onEvent({ type: 'compact', mode: 'kimi-native', phase: 'completed', beforeTokens: before.contextTokens, afterTokens: after.contextTokens, contextWindow: after.contextWindow });
  await stopKimiServer();
  return { ok: true, mode: 'kimi-native', beforeTokens: before.contextTokens, afterTokens: after.contextTokens, contextWindow: after.contextWindow, status: after };
}

async function runKimiCompact(sessionId, configOverride, trigger = 'manual', onEvent) {
  const config = configOverride || await readConfig();
  let session;
  try { session = await loadSession(String(sessionId || '')); } catch { return { ok: false, error: 'session not found' }; }
  if (!session) return { ok: false, error: 'session not found' };
  if (config.compactProviderId) return runAgentExternalCompact(session.id, config, trigger);
  if (!session.claudeSessionId) return { ok: false, error: 'Kimi 原生会话尚未建立，暂无可压缩上下文' };
  const nativeId = session.claudeSessionId;
  const result = await compactKimiNative(config, nativeId, '', onEvent);
  if (!result.ok) return result;
  // 128b:压缩发生在 Kimi 那边的原生会话里(不管本地撤没撤回,它都已经发生了),这里落的只是本地的记录 ——
  // 走 mutateSession 重放到新读的副本上,不被闸静默丢掉;新副本若已不再指向同一个原生会话(期间被重置),这条记录就不适用。
  let written;
  try {
    written = await mutateSession(session.id, fresh => {
      if (fresh.claudeSessionId !== nativeId) return { abort: 'native_session_changed' };
      applyKimiStatusToSession(fresh, result.status);
      upsertCompactMarker(fresh, {
        kind: 'kimi', label: `Kimi ${trigger === 'auto' ? '自动' : '手动'}压缩`, approx: false, accuracy: '原生会话实测',
        beforeTokens: result.beforeTokens, afterTokens: result.afterTokens,
      });
      fresh.autoCompactWatermark = result.afterTokens; // 压后实测值作为滞回水位(provider 引擎同款口径)
      return undefined;
    }, { writer: 'kimi_compact' });
  } catch (error) {
    if (error && error.code === 'session.rewound_during_write') return { ok: false, error: error.code };
    throw error;
  }
  if (!written.session) return { ok: false, error: 'session not found' };
  logEvent({ kind: 'kimi_compact', trigger, sessionId: session.id, nativeSessionId: session.claudeSessionId, beforeTokens: result.beforeTokens, afterTokens: result.afterTokens });
  return result;
}

async function replaceSessionObject(target, fresh) {
  if (!target || !fresh) return;
  for (const key of Object.keys(target)) if (!Object.prototype.hasOwnProperty.call(fresh, key)) delete target[key];
  Object.assign(target, fresh);
}

// hunt2-engines#7:Agent CLI 回合前自动压缩的滞回与失败退避。修前每个回合都会重判、重试:Kimi 原生压缩坏了时
// 每回合开头都要白等最多 3 分钟(compactKimiNative 的轮询上限),外部摘要模型坏了时每回合都再烧一次摘要调用。
//   ① 成功后:runKimiCompact / runAgentExternalCompact 已把压后实测写进 session.autoCompactWatermark,这里照 10
//      runAutoCompaction 的口径把触发线抬到 max(阈值线, 水位 + max(2K, 2% 窗口)) —— 两路引擎同一种滞回。
//   ② 失败后:只在内存里记「哪条会话、在多少 token 时、何时失败」(不进会话头:它是运行时退避,重启即清零合理);
//      冷却期内且上下文没有再涨过一个重武装余量,就不再尝试。
const AGENT_AUTO_COMPACT_FAIL_COOLDOWN_MS = 10 * 60 * 1000;
const agentAutoCompactFailures = new Map();   // sessionId -> { at, tokens }
function agentAutoCompactTrigger(session, threshold, limit) {
  const base = threshold * limit;
  const rearmMargin = Math.max(2000, Math.round(limit * 0.02));
  const wm = Number(session && session.autoCompactWatermark);
  return { trigger: Number.isFinite(wm) && wm > 0 ? Math.max(base, wm + rearmMargin) : base, rearmMargin };
}
function agentAutoCompactBackingOff(sessionId, used, rearmMargin) {
  const failed = agentAutoCompactFailures.get(String(sessionId || ''));
  if (!failed) return false;
  if (Date.now() - failed.at >= AGENT_AUTO_COMPACT_FAIL_COOLDOWN_MS || used >= failed.tokens + rearmMargin) {
    agentAutoCompactFailures.delete(String(sessionId || ''));
    return false;
  }
  return true;
}
function noteAgentAutoCompactFailure(sessionId, used) {
  agentAutoCompactFailures.set(String(sessionId || ''), { at: Date.now(), tokens: Number(used) || 0 });
  while (agentAutoCompactFailures.size > 500) agentAutoCompactFailures.delete(agentAutoCompactFailures.keys().next().value);
}

// Called before an Agent CLI turn. A CLI with a native status surface (adapter.contextStatus; Kimi) uses its
// authoritative status; Claude can opt into an external model and uses the latest measured CLI usage. The
// default Claude path remains Claude's own auto-compact.
// 架构还债批 4:第三个参数由 CLI 类型名改成该 CLI 的适配器(05 runClaudeTurn 传入;05b 不反向引用 05 的符号)。
async function maybeAutoCompactAgentSession(session, config, cliAdapter, onEvent) {
  const nativeStatus = cliAdapter.contextStatus;
  const nativeCompact = cliAdapter.nativeCompact;
  try {
    const threshold = Number(config.autoCompactThreshold) || 0.8;
    if (config.compactProviderId) {
      let used = lastSessionContextTokens(session);
      const contextMeta = await agentConversationContextMeta({ ...config, agentCliType: cliAdapter.id }, session);
      let limit = contextMeta.contextWindow;
      if (nativeStatus && session.claudeSessionId) {
        const status = await nativeStatus.read(config, session);
        if (status.ok) {
          used = status.contextTokens;
          if (contextMeta.contextWindowSource !== 'manual' && status.contextWindow > 0) limit = status.contextWindow;
          nativeStatus.apply(session, status);
        }
      }
      const armed = limit > 0 ? agentAutoCompactTrigger(session, threshold, limit) : null;
      if (used > 0 && armed && used >= armed.trigger && !agentAutoCompactBackingOff(session.id, used, armed.rearmMargin)) {
        onEvent({ type: 'compact', mode: 'external-summary', phase: 'started', trigger: 'auto', beforeTokens: used, contextWindow: limit });
        const result = await runAgentExternalCompact(session.id, config, 'auto');
        if (!result.ok) {
          noteAgentAutoCompactFailure(session.id, used);
          onEvent({ type: 'compact', mode: 'external-summary', phase: 'failed', error: result.error });
          return false;
        }
        agentAutoCompactFailures.delete(String(session.id));
        const fresh = await loadSession(session.id);
        await replaceSessionObject(session, fresh);
        onEvent({ type: 'compact', mode: 'external-summary', phase: 'completed', trigger: 'auto', beforeTokens: result.beforeTokens, afterTokens: result.afterTokens });
        return true;
      }
      return false;
    }
    if (!nativeStatus || !nativeCompact || !session.claudeSessionId) return false;
    const status = await nativeStatus.read(config, session);
    if (!status.ok) return false;
    nativeStatus.apply(session, status);
    onEvent({ type: 'usage', ...nativeStatus.usage(status) });
    const armed = status.contextWindow > 0 ? agentAutoCompactTrigger(session, threshold, status.contextWindow) : null;
    if (armed && status.contextTokens >= armed.trigger && !agentAutoCompactBackingOff(session.id, status.contextTokens, armed.rearmMargin)) {
      const result = await nativeCompact.run(session.id, config, 'auto', onEvent);
      if (!result.ok) {
        noteAgentAutoCompactFailure(session.id, status.contextTokens);
        onEvent({ type: 'compact', mode: nativeCompact.mode, phase: 'failed', error: result.error });
        return false;
      }
      agentAutoCompactFailures.delete(String(session.id));
      const fresh = await loadSession(session.id);
      await replaceSessionObject(session, fresh);
      return true;
    }
    return false;
  } catch (error) {
    try { onEvent({ type: 'compact', mode: nativeCompact ? nativeCompact.mode : 'external-summary', phase: 'failed', error: (error && error.message) || String(error) }); } catch { /* ignore */ }
    return false;
  }
}

async function closeKimiAcpProcess(child, rpc, nativeSessionId, capabilities, onEvent) {
  const closeState = kimiAcpCapabilityState(capabilities || {}, 'close', ['sessionClose', 'closeSession']);
  if (rpc && nativeSessionId && !rpc.isClosed() && closeState === true) {
    await rpc.request('session/close', { sessionId: nativeSessionId }, 3000).catch(error => {
      onEvent({ type: 'stderr', text: `[Kimi ACP close] ${redact(String(error && error.message || error))}` });
    });
  } else if (rpc && nativeSessionId && closeState === null) {
    onEvent({ type: 'stderr', text: '[Kimi ACP 能力] agent 未声明 close；结束当前 ACP 回合但不发送 session/close' });
  }
  try { if (child.stdin && !child.stdin.destroyed) child.stdin.end(); } catch { /* ignore */ }
  if (child.exitCode == null && child.signalCode == null) {
    await new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); child.removeListener('close', finish); resolve(); } };
      const timer = setTimeout(finish, 350);
      child.once('close', finish);
    });
    if (child.exitCode == null && child.signalCode == null) { try { killChildTree(child); } catch { /* ignore */ } }
  }
  if (ProcessRuntime.result(child)?.scope === 'owned-group-and-observed') return ProcessRuntime.waitForCleanup(child);
  return null;
}

function friendlyKimiAcpError(error) {
  const raw = String(error && error.message || error || 'Kimi ACP 回合失败');
  const detailCode = String(error && error.data && (error.data.code || error.data.errorCode) || '');
  if (/auth(?:entication)?[._ -]?(?:required|error)|login[._ -]?required|token[._ -]?(?:missing|unauthorized)|not authenticated|unauthorized|provisioning_required|model_not_resolved/i.test(`${detailCode}\n${raw}`)) {
    return `Kimi Code 尚未登录或登录已失效。请先在终端运行 kimi login，再重试。\n原始错误：${raw}`;
  }
  return raw;
}

function prepareKimiAcpSpawn(command) {
  const base = prepareAgentCliSpawn('kimi', command, ['acp']);
  const entry = String(base.args && base.args[0] || '');
  const register = path.join(externalRoot(), 'resources', 'kimi-acp-compat-register.mjs');
  // Only direct npm-package launches can use Node's ESM loader. Native Kimi executables retain their
  // upstream behavior rather than guessing at a binary patch, and the loader itself still verifies the
  // exact source helper before changing anything.
  if (!path.isAbsolute(entry) || !/[\\/]@moonshot-ai[\\/]kimi-code[\\/]dist[\\/]main\.mjs$/i.test(entry)) {
    return {
      ...base, kimiAcpCompat: false, kimiAcpCompatStatus: 'unsupported-install',
      kimiAcpCompatDiagnostic: '未挂载 ACP 兼容层：仅支持标准 npm @moonshot-ai/kimi-code 直连 main.mjs；当前安装方式保持原生行为',
    };
  }
  if (!fs.existsSync(register)) {
    return {
      ...base, kimiAcpCompat: false, kimiAcpCompatStatus: 'resource-missing',
      kimiAcpCompatDiagnostic: '未挂载 ACP 兼容层：resources/kimi-acp-compat-register.mjs 不存在',
    };
  }
  return {
    ...base, args: ['--import', pathToFileURL(register).href, ...base.args], kimiAcpCompat: true,
    kimiAcpCompatStatus: 'loader-attached',
    kimiAcpCompatDiagnostic: '已挂载精确源码匹配的 ACP 兼容层；实际 patch 命中情况由子进程 stderr 报告',
  };
}

async function runKimiAcpTurnPrepared(context) {
  const {
    session, message, onEvent, config, executionOwner, cliDriver, agentCliLabel, claude, workingDir, fullPrompt,
    additionalDirectories, turnStartedAt, turnSegments, activeTraceId, currentClaudeModel,
    currentResumeRouteKey, historyRecoveryInjected, indexInjection, indexPayloadHash, memoryPreflight,
    resumeResetReason, promptTaskContext, agentRecoverySummary, attachments, kimiNativeSlashCommand,
  } = context;
  assertSessionExecutionOwner(session.id, executionOwner);
  let workspaceTurnBaseline = context.workspaceTurnBaseline;
  const env = {
    ...process.env,
    RUYI_HOME: paths.data,
    WCW_PERMISSION_TIMEOUT_MS: String(permissionWaitMs(session.id, config, session)),   // 128f-⑪:与服务端那一侧同一个数,子进程不先放弃
    WCW_SESSION_ID: session.id,
    WCW_PORT: String(RUNTIME.port),
    WCW_HOST: RUNTIME.host,
    WCW_TOKEN: RUNTIME.token,
  };
  if (config.includeWorkbenchMcp) await syncMcpServersToKimi(config);
  const spawn = prepareKimiAcpSpawn(claude);
  if (spawn.kimiAcpCompat) env.RUYI_KIMI_ACP_COMPAT = '1';
  const cwdWarn = cwdWarning(workingDir);
  const state = {
    assistantText: '', thinkingText: '', usage: null, model: String(session.claudeSessionModel || ''),
    usageTick: 0, turnUsage: null, planTouched: false, toolCalls: [], toolMap: new Map(), availableCommands: [], error: null, stopReason: '',
  };
  let rawSeq = 0;
  const stderrCapture = createCappedDiagnosticText();   // hunt2-engines#17:同 05,stderr 头尾截断后才落盘
  const stderrDecodeStream = {};   // hunt2-engines#8:同 05,一条 stderr 一个解码状态
  let nativeSessionId = '';
  let stopKimiWireWatch = () => {};
  let watchdog = null;
  let child = null;
  let rpc = null;
  let reg = null;
  let updateQueue = Promise.resolve();
  let promptDelivered = false;   // session/prompt 已得到 Kimi 的应答(见 catch 里清「已注入索引」hash 的判据)
  const markActivity = () => { if (reg) reg.lastEventAt = Date.now(); };
  const emitUpdate = async params => {
    markActivity();
    const update = params && params.update || {};
    const type = String(update.sessionUpdate || '');
    if (reg && reg.kimiAcpLoadReplay && !['config_option_update', 'current_mode_update', 'session_info_update'].includes(type)) return;
    if (type === 'agent_message_chunk') {
      const text = kimiAcpContentText(update.content);
      if (text) { state.assistantText += text; if (reg) reg.questionContext = state.assistantText; onEvent({ type: 'assistant_delta', text }); }
    } else if (type === 'agent_thought_chunk') {
      const text = kimiAcpContentText(update.content);
      if (text) { state.thinkingText += text; onEvent({ type: 'thinking_delta', text }); }
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      const id = String(update.toolCallId || '');
      if (!id) return;
      const explicitNativeName = update.title || update.name || '';
      const displayName = explicitNativeName || update.description || '';
      const nativeInput = kimiAcpExplicitToolInput(update);
      let record = state.toolMap.get(id);
      if (!record) {
        record = {
          id, name: String(displayName || 'KimiTool'), nativeName: String(explicitNativeName || ''),
          kind: String(update.kind || ''),
          input: nativeInput,
          content: update.content,
        };
        state.toolMap.set(id, record); state.toolCalls.push(record);
        onEvent({ type: 'tool_use', id, name: record.name, input: record.input });
      } else {
        const previousName = record.name;
        const previousInput = record.input;
        const previousKind = record.kind;
        if (displayName) record.name = String(displayName);
        if (nativeInput && Object.keys(nativeInput).length) record.input = nativeInput;
        if (record.content == null && update.content !== undefined) record.content = update.content;
        if (update.kind) record.kind = String(update.kind);
        if (record.name !== previousName || record.input !== previousInput || record.kind !== previousKind) {
          onEvent({ type: 'tool_use_update', id, name: record.name, input: record.input, kind: record.kind || undefined });
        }
      }
      const status = String(update.status || '');
      if ((status === 'completed' || status === 'failed') && !record.__settled) {
        record.__settled = true;
        if (kimiAcpSuccessfulEnterPlanMode(record, update)) contextResetKimiAcpPlanApproval(reg);
        const terminalId = kimiAcpTerminalRef(update.rawOutput) || kimiAcpTerminalRef(update.content);
        const terminalResult = terminalId ? kimiAcpTerminalDisplayResult(reg, terminalId) : null;
        record.result = terminalResult != null
          ? terminalResult
          : (update.rawOutput !== undefined ? update.rawOutput : kimiAcpContentText(update.content));
        onEvent({ type: 'tool_result', id, content: record.result, isError: status === 'failed' });
      }
    } else if (type === 'usage_update') {
      const used = Number(update.used) || 0;
      const size = Number(update.size) || 0;
      state.usage = {
        usage: {}, contextTokens: used, contextWindow: size, model: state.model,
        contextEngine: 'agent', contextAgentCliType: 'kimi', contextModel: state.model, source: 'kimi-acp',
      };
      state.usageTick += 1;
      session.kimiContextStatus = {
        ok: true, busy: false, model: state.model, contextTokens: used, contextWindow: size,
        contextUsage: size > 0 ? used / size : 0, source: 'kimi-acp', updatedAt: nowIso(),
      };
      onEvent({ type: 'usage', ...state.usage });
    } else if (type === 'config_option_update') {
      const opts = Array.isArray(update.configOptions) ? update.configOptions : [];
      kimiAcpStoreConfigOptions(session, { configOptions: opts });
      for (const option of opts) {
        if (option && option.id != null && option.currentValue != null) kimiAcpNoteConfigActual(reg, option.id, option.currentValue);
      }
      kimiAcpSyncActualConfig(state, session, reg, opts);
    } else if (type === 'current_mode_update') {
      const modeId = String(update.currentModeId || '');
      if (modeId && reg) {
        reg.kimiAcpLatestModeId = modeId;
        reg.kimiAcpModeUpdateSeq = Number(reg.kimiAcpModeUpdateSeq || 0) + 1;
      }
      kimiAcpNoteConfigActual(reg, 'mode', modeId);
      kimiAcpRememberConfigActual(session, 'mode', modeId);
      session.kimiAcpMode = modeId;
      kimiAcpObserveNativeMode(reg, modeId);
    } else if (type === 'current_thinking_update') {
      const thinkingId = String(update.currentThinkingId || update.currentValue || '');
      if (thinkingId && reg) {
        reg.kimiAcpLatestThinkingId = thinkingId;
        reg.kimiAcpThinkingUpdateSeq = Number(reg.kimiAcpThinkingUpdateSeq || 0) + 1;
      }
      kimiAcpNoteConfigActual(reg, 'thinking', thinkingId);
      kimiAcpRememberConfigActual(session, 'thinking', thinkingId);
      session.kimiAcpThinking = thinkingId;
    } else if (type === 'current_model_update') {
      const modelId = String(update.currentModelId || update.currentValue || '');
      kimiAcpNoteConfigActual(reg, 'model', modelId);
      kimiAcpRememberConfigActual(session, 'model', modelId);
      state.model = modelId;
      session.claudeSessionModel = modelId;
    } else if (type === 'available_commands_update') {
      state.availableCommands = Array.isArray(update.availableCommands) ? update.availableCommands
        : (Array.isArray(update.commands) ? update.commands : []);
      session.kimiAcpCommands = state.availableCommands;
    } else if (type === 'session_info_update') {
      session.kimiNativeTitle = update.title == null ? '' : String(update.title);
    } else if (type === 'plan' || type === 'plan_update') {
      state.planTouched = true;
      const planId = kimiAcpPlanIdFromUpdate(update);
      let planFile = '';
      if (reg) {
        planFile = kimiAcpPlanFileFromUpdate(update);
        if (planFile) {
          reg.kimiAcpPlanFile = planFile;
          if (planId) reg.kimiAcpPlanPaths.set(planId, planFile);
        }
      }
      kimiAcpApplyPlan(update, session, onEvent);
      const snapshot = await kimiAcpPlanSnapshotFromUpdate(update, { session, config, reg });
      if (!snapshot.ok) {
        onEvent({ type: 'stderr', text: `[Kimi ACP 计划快照] ${redact(snapshot.reason || '未能读取计划')}` });
      } else {
        onEvent({ type: 'kimi_plan_snapshot', planId: snapshot.planId, markdown: snapshot.markdown, path: snapshot.path || planFile || '', status: 'active', source: 'kimi-acp' });
      }
    } else if (type === 'plan_removed') {
      state.planTouched = true;
      const planId = kimiAcpPlanIdFromUpdate(update);
      const planFile = reg && planId ? reg.kimiAcpPlanPaths.get(planId) || '' : reg && reg.kimiAcpPlanFile || '';
      if (reg) {
        if (!planId || planId === session.kimiAcpPlanId) reg.kimiAcpPlanFile = '';
        if (planId) reg.kimiAcpPlanPaths.delete(planId);
      }
      if (!planId || !session.kimiAcpPlanId || session.kimiAcpPlanId === planId) {
        session.kimiAcpPlan = null;
        session.kimiAcpPlanId = '';
        session.todos = [];
        onEvent({ type: 'todo', items: [], source: 'kimi-acp' });
      }
      const removedSnapshot = { type: 'kimi_plan_snapshot', planId, status: 'removed', source: 'kimi-acp' };
      if (planFile) removedSnapshot.path = planFile;
      onEvent(removedSnapshot);
    }
  };

  try {
    await fsp.mkdir(workingDir, { recursive: true }).catch(() => {});
    if (!workspaceTurnBaseline && softwareEngineeringTaskProfile(promptTaskContext).relevant) {
      workspaceTurnBaseline = await captureWorkspaceTurnBaseline(workingDir).catch(() => null);
    }
    if (spawn.kimiAcpCompatDiagnostic && spawn.kimiAcpCompatStatus !== 'loader-attached') {
      onEvent({ type: 'stderr', text: `[Kimi ACP 兼容层] ${spawn.kimiAcpCompatDiagnostic}` });
    }
    onEvent({
      type: 'meta', command: claude, args: ['acp'], cwd: workingDir, model: config.model || '(default)',
      thinkingEffort: config.claudeThinkingEffort || 'default', permissionMode: config.permissionMode,
      historyRecoveryInjected, indexInjected: Boolean(indexInjection), indexHash: indexPayloadHash || undefined,
      memoryCheck: memoryPreflight.status, resumeResetReason: resumeResetReason || undefined,
      resumeRecoveryAttempt: false, agentRoles: [], agentRolesOmitted: [], agentDriver: 'kimi-acp', kimiAcpCompat: Boolean(spawn.kimiAcpCompat),
      kimiAcpCompatStatus: spawn.kimiAcpCompatStatus || 'not-attached', kimiAcpCompatDiagnostic: spawn.kimiAcpCompatDiagnostic || undefined,
      agentCliType: 'kimi', agentCliLabel, experimental: Boolean(cliDriver.experimental), cwdWarning: cwdWarn || undefined,
    });
    logEvent({ kind: 'turn_start', traceId: activeTraceId, sessionId: session.id, turnSeq: session.turnSeq, engine: 'claude', agentDriver: 'kimi-acp', model: config.model || 'default', promptLen: fullPrompt.length });
    await AgentLoopHooks.dispatchAgentLoopHooks('beforeModelCall', {
      traceId: activeTraceId, sessionId: session.id, turnSeq: session.turnSeq, engine: 'claude',
      model: currentClaudeModel || 'default', iteration: 0, resumeRecoveryAttempt: false,
    });
    // hunt2-engines#1:与 05 runClaudeTurn 同一处复查 —— 05 开头那次 supersede 检查到这里隔着多个 await
    // (MCP 同步、基线捕获、hooks),同会话并发的两个回合会各起一个 ACP 子进程。从这行到 activeChildren.set
    // 全是同步代码,在这里判一次就不会有两个子进程同时在册。
    if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertSupported(await readConfig(), 'cli');
    assertSessionExecutionOwner(session.id, executionOwner);
    if (activeChildren.has(session.id)) stopSession(session.id, 'superseded');
    child = await ProcessRuntime.spawn(spawn.command, spawn.args, { cwd: workingDir, env, stdio: ['pipe', 'pipe', 'pipe'], ...spawn.opts, admit: () => assertSessionExecutionOwner(session.id, executionOwner) },
      { kind: 'cli', agentCliType: 'kimi', sessionId: session.id, traceId: activeTraceId, turnSeq: session.turnSeq });
    reg = {
      child, pid: child.pid, exited: false, pausePending: false, state: 'running', startedAt: Date.now(),
      lastEventAt: Date.now(), interactive: true, onEvent: null, session, kind: 'kimi-acp', traceId: activeTraceId,
      questionContext: '', steerQueue: [], acceptingSteer: true, abort: null,
      nativeSessionId: '', kimiAcpApprovals: [], kimiAcpTerminals: new Map(), kimiAcpTerminalResults: new Map(), kimiAcpElicitations: new Map(),
      kimiAcpPlanFile: '', kimiAcpPlanPaths: new Map(), kimiAcpPlanApproved: false, kimiAcpPlanApprovalTurn: 0,
      kimiAcpNativeMode: '', kimiAcpLatestModeId: '', kimiAcpModeUpdateSeq: 0, kimiAcpLatestThinkingId: '', kimiAcpThinkingUpdateSeq: 0,
      kimiAcpConfigActualSeq: Object.create(null), kimiAcpLatestConfigActual: Object.create(null),
      kimiAcpLoadReplay: false,
      kimiAcpWire: { subagents: new Map(), childTools: new Map() },
    };
    reg.onEvent = event => { reg.lastEventAt = Date.now(); onEvent(event); };
    registerSessionExecutionChild(session.id, reg, executionOwner);
    // 121-K3(34 号文 §13.4 登记项①):Kimi ACP 这一路在 K2a 漏了起跑/收尾两帧。形状照 05/09 逐字
    // 一样(同一个事件名、同一个载荷键),位置也一样 —— 紧跟 activeChildren.set,此刻这条线程对
    // 任何读 activeChildren 的判据来说都已经是「在跑」了,派晚一行就会出现「订阅者算出来还是停着」。
    RUYI_EVENTS.emit('thread.state', { sessionId: session.id });
    // §6.3 指标 a
    onEvent({ type: 'process', state: 'running', pid: child.pid, interactive: true, protocol: 'acp' });
    child.stderr.on('data', chunk => {
      const text = decodeClaudeCliText(chunk, stderrDecodeStream);
      stderrCapture.append(text);
      markActivity();
      if (text.trim()) onEvent({ type: 'stderr', text: redact(text) });
    });
    const reverseContext = {
      session, config, workingDir, additionalDirectories,
      dataRoot: typeof dataRoot === 'function' ? dataRoot() : (typeof paths !== 'undefined' ? paths.data : ''),
      onEvent: reg.onEvent, reg, state,
    };
    // hunt2-engines#13:ACP 的 $/cancel_request 只撤【一条】反向请求。修前 onCancel 按会话把全部待决权限/提问/计划
    // 一起清掉 —— Kimi 并行两个工具、只撤其中一个时,另一个还在等用户的卡片也被判成拒绝。这里按 ACP 请求 id
    // 记下它在如意这一侧开出的待决(permission_request / ask_user / plan 事件里的 id),撤销时只结算这几条。
    const reverseInterventions = new Map();   // ACP 反向请求 id -> Map(如意待决 id -> 类型)
    const reverseRequestContext = requestMeta => {
      const key = String(requestMeta && requestMeta.requestId);
      const tracked = new Map();
      reverseInterventions.set(key, tracked);
      return {
        key,
        context: {
          ...reverseContext,
          onEvent: event => {
            let opened = null;
            if (event && event.type === 'permission_request' && event.requestId) opened = [String(event.requestId), 'permission'];
            else if (event && event.type === 'ask_user' && event.id) opened = [String(event.id), 'question'];
            else if (event && event.type === 'plan' && event.planId) opened = [String(event.planId), 'plan'];
            if (opened) tracked.set(opened[0], opened[1]);
            reverseContext.onEvent(event);
            // 撤销先于卡片到达(处理器还在等 updateQueue 时就收到 $/cancel_request):卡片一开出来就按撤销结算。
            if (opened && requestMeta && requestMeta.signal && requestMeta.signal.aborted && reg.state === 'running') {
              cancelKimiAcpIntervention(session.id, opened[0], opened[1], 'Kimi cancelled the request');
            }
          },
        },
      };
    };
    rpc = createKimiAcpRpc(child, {
      onLine: line => { markActivity(); onEvent({ type: 'raw_line', line, seq: rawSeq++ }); },
      onNotification: (method, params) => {
        if (method === 'session/update') {
          updateQueue = updateQueue.then(() => emitUpdate(params)).catch(error => {
            onEvent({ type: 'stderr', text: `[Kimi ACP update] ${redact(String(error && error.message || error))}` });
          });
        }
        else if (method === 'elicitation/complete') {
          const id = String(params && params.elicitationId || '');
          if (id) reg.kimiAcpElicitations.delete(id);
          markActivity();
        }
      },
      onRequest: async (method, params, requestMeta) => {
        markActivity();
        // ACP may put tool_call on the wire immediately before request_permission. The notification
        // reducer is serialized so permission handling must wait for that same queue, otherwise the
        // exact toolCallId merge can observe an empty kind/rawInput. No reducer issues a reverse RPC, so
        // awaiting this queue cannot form a cycle.
        await updateQueue.catch(() => {});
        if (method === 'session/request_permission') {
          const permissionTool = params && params.toolCall && typeof params.toolCall === 'object' ? params.toolCall : {};
          const permissionTitle = String(permissionTool.title || '').trim().toLowerCase();
          if ((permissionTitle === 'write' || permissionTitle === 'edit')
            && (permissionTool.kind == null || permissionTool.rawInput == null)) {
            // ACP may place the pending tool_call notification immediately after this reverse RPC in the
            // same stdout batch. Let the parser finish that batch before taking the exact-ID snapshot.
            await new Promise(resolve => setImmediate(resolve));
            await updateQueue.catch(() => {});
          }
        }
        const scoped = reverseRequestContext(requestMeta);
        try {
          if (method === 'session/request_permission') return await handleKimiAcpPermissionRequest(params, scoped.context);
          if (method === 'fs/read_text_file' || method === 'fs/write_text_file') return await handleKimiAcpFsRequest(method, params, scoped.context);
          if (method.startsWith('terminal/')) return await handleKimiAcpTerminalRequest(method, params, scoped.context, requestMeta);
          if (method === 'elicitation/create') return await handleKimiAcpElicitation(params, scoped.context, requestMeta);
          throw kimiAcpRequestError(-32601, `Unsupported Kimi ACP reverse request: ${method}`);
        } finally {
          reverseInterventions.delete(scoped.key);
        }
      },
      onCancel: (requestId, method) => {
        markActivity();
        const tracked = reverseInterventions.get(String(requestId));
        if (!tracked) return;
        const note = method === 'elicitation/create' ? 'Kimi cancelled the elicitation'
          : method === 'session/request_permission' ? 'Kimi cancelled the permission request' : 'Kimi cancelled the operation';
        for (const [interventionId, kind] of tracked) cancelKimiAcpIntervention(session.id, interventionId, kind, note);
        tracked.clear();
      },
    });
    reg.abort = () => {
      reg.exited = true;
      clearPendingPermissions(session.id, 'Ruyi turn cancelled');
      clearPendingQuestions(session.id, 'Ruyi turn cancelled');
      clearPendingPlans(session.id, 'Ruyi turn cancelled');
      rpc.cancelReverseRequests(new Error('Ruyi turn cancelled'));
      reg.kimiAcpCleanupPromise = cleanupKimiAcpTerminals(reg);
      if (nativeSessionId) rpc.notify('session/cancel', { sessionId: nativeSessionId });
      setTimeout(() => { if (child && child.exitCode == null) killChildTree(child); }, 1200);
    };
    const idleLimitMs = Math.max(1000, Number(process.env.WCW_TURN_IDLE_MS) || config.turnIdleTimeoutMs);
    watchdog = setInterval(() => {
      if (reg.exited || reg.pausePending || Date.now() - reg.lastEventAt <= idleLimitMs) return;
      if (hasPendingPermissionForSession(session.id)) return;   // 128f-⑪:权限挂着豁免(见 04 的 hasPendingPermissionForSession)
      reg.state = 'watchdog-timeout';
      // hunt2-engines#12:与 05 的 Claude 看门狗同一句可见提示 —— 修前这里静默中止,用户只看到回合「被停止」却不知道是谁停的。
      onEvent({ type: 'stderr', text: `[watchdog] turn idle >${Math.round(idleLimitMs / 1000)}s — terminating` });
      reg.abort();
    }, Math.min(5000, Math.max(500, Math.floor(idleLimitMs / 4))));

    const initialized = await rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'Ruyi Workbench', version: '2.6' },
      clientCapabilities: {
        auth: { terminal: false }, fs: { readTextFile: true, writeTextFile: true }, terminal: true,
        // ACP renamed this field across schema revisions. Advertising both is harmless and
        // keeps current Kimi plus older compatible agents on the native plan-update path.
        plan: {}, planCapabilities: {}, elicitation: { form: {}, url: {} },
      },
    }, 15000);
    session.kimiAcpAgentInfo = initialized && initialized.agentInfo || null;
    session.kimiAcpCapabilities = initialized && initialized.agentCapabilities || null;
    const lifecycle = kimiAcpLifecycle(session.kimiAcpCapabilities, workingDir, additionalDirectories, onEvent);
    let activated;
    if (config.autoResumeClaudeSessions && session.claudeSessionId) {
      nativeSessionId = String(session.claudeSessionId);
      try {
        const restored = await kimiAcpRestoreSession(
          rpc, nativeSessionId, lifecycle, session.kimiAcpCapabilities, reg, onEvent,
          () => updateQueue,
        );
        activated = restored.response;
      } catch (error) {
        if (!kimiAcpUnknownSessionError(error, nativeSessionId)) throw error;
        session.claudeSessionId = null;
        session.injectedIndexHash = null;
        onEvent({ type: 'resume_recovery', reason: 'kimi-session-not-found', automatic: true });
        activated = await rpc.request('session/new', lifecycle, 30000);
        nativeSessionId = String(activated && activated.sessionId || '');
      }
    } else {
      activated = await rpc.request('session/new', lifecycle, 30000);
      nativeSessionId = String(activated && activated.sessionId || '');
    }
    if (!nativeSessionId) throw new Error('Kimi ACP did not return a sessionId');
    reg.nativeSessionId = nativeSessionId;
    session.claudeSessionId = nativeSessionId;
    // 续接闸(05)比的是这里记下的【请求】模型,而不是下面 kimiAcpSyncActualConfig 会写进 claudeSessionModel 的 Kimi 实际模型:
    // config.model 为空(默认模型)时两者永远不等,每回合都会被误判「模型变了」而重置原生会话。
    session.claudeSessionRequestedModel = String(currentClaudeModel || '');
    session.claudeSessionCwd = workingDir;
    session.claudeSessionRouteKey = currentResumeRouteKey;
    session.kimiAcpConfigOptions = activated && Array.isArray(activated.configOptions) ? activated.configOptions : [];
    if (!kimiAcpFindConfigOption(session.kimiAcpConfigOptions, 'mode')) {
      const modesOption = kimiAcpModeOptionFromActivated(activated);
      if (modesOption) session.kimiAcpConfigOptions.push(modesOption);
    }
    kimiAcpSyncActualConfig(state, session, reg, session.kimiAcpConfigOptions);
    await updateQueue.catch(() => {});
    // These values come only from the current activation response/notifications, never from a prior
    // session object. They are sufficient to prove a no-op mode when an older ACP has no setter/options.
    const activatedActuals = {
      mode: kimiAcpActivatedActualConfigValue(activated, 'mode'),
      model: kimiAcpActivatedActualConfigValue(activated, 'model'),
      thinking: kimiAcpActivatedActualConfigValue(activated, 'thinking'),
    };
    await saveSession(session, { executionOwner });
    await applyKimiAcpTurnConfig({
      rpc, nativeSessionId, session, reg, state, config, activatedActuals, onEvent, redact, flushUpdates: () => updateQueue,
    });
    stopKimiWireWatch = watchKimiWire(nativeSessionId, reg.onEvent, session.kimiContextStatus && session.kimiContextStatus.contextWindow, reg.kimiAcpWire);

    const prompts = [{ text: fullPrompt, attachments: Array.isArray(attachments) ? attachments : [], nativeSlash: kimiNativeSlashCommand === true }];
    while (prompts.length && reg.state === 'running') {
      const promptItem = prompts.shift();
      const prompt = typeof promptItem === 'string' ? promptItem : String(promptItem && promptItem.text || '');
      const checkpoint = kimiAcpWireCheckpoint(nativeSessionId);
      const usageTickBefore = state.usageTick;
      const promptParts = await buildKimiAcpPromptParts(prompt, promptItem && promptItem.attachments || [], session.kimiAcpCapabilities, {
        session, config, workingDir, onEvent: reg.onEvent, kimiNativeSlashCommand: Boolean(promptItem && promptItem.nativeSlash),
      });
      if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertSupported(await readConfig(), 'cli');
      const response = await rpc.request('session/prompt', {
        sessionId: nativeSessionId,
        prompt: Array.isArray(promptParts) && promptParts.length ? promptParts : [{ type: 'text', text: prompt }],
      }, 0);
      promptDelivered = true;
      // Notifications can arrive just before/after the prompt result. Preserve their wire order and make
      // the final plan/config snapshot visible before this prompt is considered complete.
      await updateQueue;
      if (response && response.usage && typeof response.usage === 'object') state.turnUsage = response.usage;
      state.stopReason = String(response && response.stopReason || 'end_turn');
      // Kimi sends the prompt response as soon as turn.ended settles, then computes usage asynchronously.
      // Give that authoritative update a short event-driven grace before closing the native session.
      for (let attempt = 0; attempt < 10 && state.usageTick === usageTickBefore && reg.state === 'running'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 75));
      }
      const wireOutcome = await kimiAcpWireOutcome(nativeSessionId, checkpoint);
      if (wireOutcome && (wireOutcome.reason === 'failed' || wireOutcome.reason === 'blocked')) {
        throw new Error(wireOutcome.error || `Kimi turn ${wireOutcome.reason}`);
      }
      if (state.stopReason === 'cancelled') { if (reg.state === 'running') reg.state = 'cancelled'; break; }
      if (state.stopReason === 'refusal') throw new Error('Kimi 拒绝了本次请求');
      if (reg.steerQueue.length) {
        const steers = reg.steerQueue.splice(0, reg.steerQueue.length);
        for (const item of steers) {
          const text = typeof item === 'string' ? item : item.text;
          const attachments = Array.isArray(item && item.attachments) ? item.attachments : [];
          session.messages.push({ role: 'user', content: text, ...(attachments.length ? { attachments } : {}), turnSeq: session.turnSeq, steered: true, createdAt: nowIso() });
          onEvent({ type: 'steered', text, ...(attachments.length ? { attachments } : {}), queued: false, protocol: 'kimi-acp-followup' });
          prompts.push({
            text: `[用户插话] ${text}\n\n请在同一会话中结合刚才已完成的工作继续处理这条补充指令。`,
            attachments, nativeSlash: false,
          });
        }
        await saveSession(session, { executionOwner });
      } else reg.acceptingSteer = false;
    }
  } catch (error) {
    state.error = error;
    // 第35波 P2 的索引去重(05 injectedIndexHash)对 Kimi 同样成立:05 在拼 prompt 时就先把 hash 置上了。session/prompt 还没有得到
    // 应答就失败(进程没起来 / initialize、session/new、session/resume 失败 / 设置项中止 / 管道断了 / 看门狗或 Stop 在应答前杀掉进程),
    // Kimi 的原生会话里多半根本没有本回合注入的技能/记忆/编排索引 —— 不清 hash,下回合会因「内容没变」而不再补发,模型从此看不到索引。
    // 与 05 的 Claude 路径同一处理(那边:进程没启动 → 清 hash)。宁可多补发一次(重复无害)也不丢。
    // 例外:Kimi 对 session/prompt 回了 JSON-RPC 错误(额度/鉴权等)= prompt 已送达并进了它的转录,不清。
    const promptReachedAgent = Boolean(error && error.method === 'session/prompt' && error.code !== undefined);
    if (!promptDelivered && !promptReachedAgent) session.injectedIndexHash = null;
  } finally {
    // hunt2-engines#6:循环以 break / throw / 看门狗中止离开时,acceptingSteer 原先还是 true —— 下面的收尾要等好几个
    // await(队列、终端清理、关进程最多 350ms),这期间 /api/steer 仍回 queued:1,然后插话随回合结束被静默丢掉。
    // 一进收尾就关门,晚到的插话拿到 kimiSettling 拒绝(请作为下一条消息发送);已经排进队列却没被消费的,明说没送达。
    if (reg) {
      reg.acceptingSteer = false;
      const undelivered = Array.isArray(reg.steerQueue) ? reg.steerQueue.splice(0, reg.steerQueue.length) : [];
      if (undelivered.length) onEvent({ type: 'stderr', text: `[插话未送达] Kimi 回合已结束,${undelivered.length} 条插话没有送进本回合,请作为下一条消息重新发送。` });
    }
    await updateQueue.catch(() => {});
    if (watchdog) clearInterval(watchdog);
    stopKimiWireWatch();
    if (reg && activeChildren.get(session.id) === reg) {
      clearPendingPermissions(session.id, 'turn ended');
      clearPendingQuestions(session.id, 'turn ended');
      clearPendingPlans(session.id, 'turn ended');
    }
    if (rpc) rpc.cancelReverseRequests(new Error('Kimi ACP turn ended'));
    try {
      if (reg && reg.kimiAcpCleanupPromise) await reg.kimiAcpCleanupPromise;
      if (reg) await cleanupKimiAcpTerminals(reg);
    } finally {
      try {
        if (child) {
          const cleanup = await closeKimiAcpProcess(child, rpc, nativeSessionId, session.kimiAcpCapabilities, onEvent);
          if (reg && cleanup) reg.cleanup = cleanup;
        }
      } finally {
        if (activeChildren.get(session.id) === reg) activeChildren.delete(session.id);
      }
    }
  }

  const cleanupIncomplete = Boolean(reg && (reg.kimiAcpCleanupIncomplete || reg.cleanup?.incomplete));
  if (cleanupIncomplete && !state.error) state.error = new Error('Kimi 子进程清理尚未确认完成');
  if (state.error && state.error.code === 'STEWARD_TURN_CANCELLED') throw state.error;
  const wasStopped = Boolean(reg && reg.state !== 'running');
  // ACP 0.37+ emits authoritative used/size after every turn. Only fall back to wire/Server API when an
  // older adapter omitted that update; otherwise starting a separate Web bridge adds latency and can read a
  // stale pre-close snapshot.
  if (nativeSessionId && !state.usage) {
    const measured = await syncKimiSessionUsage(session, config, onEvent).catch(() => null);
    if (measured) state.usage = measured;
  }
  if (state.turnUsage) {
    if (state.usage) state.usage.usage = state.turnUsage;
    else state.usage = {
      usage: state.turnUsage, model: state.model,
      contextEngine: 'agent', contextAgentCliType: 'kimi', contextModel: state.model, source: 'kimi-acp',
    };
  }
  // hunt2-engines#12:用户 Stop(或看门狗)中止后,ACP 子进程被杀,挂着的 session/prompt 以「Kimi ACP process exited」
  // 拒绝 —— 那是中止的【结果】,不是失败原因。修前它被写成「ACP 调用失败」进了正文;被停的回合只按「已停止」收尾。
  const errorText = state.error && !wasStopped ? friendlyKimiAcpError(state.error) : '';
  const finalText = state.assistantText.trim() || (errorText ? `${agentCliLabel} ACP 调用失败：\n${errorText}` : '');
  await reconcileWorkspaceTurnBaseline(workspaceTurnBaseline, session.id, session.turnSeq).catch(() => {});
  const turnJournal = (await journalReadIndex(session.id)).filter(entry => entry && Number(entry.turnSeq) === Number(session.turnSeq));
  const cleanToolCalls = state.toolCalls.map(({ __settled, ...toolCall }) => toolCall);
  const turnSummary = buildTurnSummary(session.turnSeq, cleanToolCalls, 'claude', turnJournal);
  const turnOk = !state.error && !wasStopped;
  if (agentRecoverySummary && turnOk && kimiNativeSlashCommand !== true) { delete session.agentRecoverySummary; delete session.agentRecoverySource; }
  turnSegments.finalizeAll(wasStopped ? '回合被停止,进行中的工具已中断' : '回合结束,进行中的工具未完成');
  session.messages.push({
    role: 'assistant', content: finalText, turnSeq: session.turnSeq, thinking: state.thinkingText.trim() || undefined,
    toolCalls: cleanToolCalls.length ? cleanToolCalls : undefined, segments: turnSegments.snapshot(), turnSummary,
    usage: state.usage || undefined, traceId: activeTraceId, createdAt: nowIso(),
    source: wasStopped ? 'aborted' : 'kimi-acp', engine: 'claude', agentCliType: 'kimi', agentCliLabel,
    model: state.model || config.model || '', exitCode: turnOk ? 0 : 1,
  });
  stderrCapture.append(decodeClaudeCliText(null, stderrDecodeStream));
  const stderrText = stderrCapture.toString();
  if (stderrText.trim()) session.messages.push({ role: 'system', content: redact(stderrText.trim()), createdAt: nowIso(), source: 'stderr' });
  if (isUntitledSessionTitle(session.title)) session.title = message.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Session';
  session.summary = finalText.replace(/\s+/g, ' ').trim().slice(0, 160) || session.summary || '';
  try {
    const onDisk = await loadSession(session.id);
    if (!state.planTouched && onDisk && Array.isArray(onDisk.todos)) session.todos = onDisk.todos;
    if (onDisk && Array.isArray(onDisk.skills)) session.skills = onDisk.skills;
    if (onDisk && Array.isArray(onDisk.memories)) session.memories = onDisk.memories;
    if (onDisk && typeof onDisk.memoriesExplicit === 'boolean') session.memoriesExplicit = onDisk.memoriesExplicit;
    if (onDisk && Array.isArray(onDisk.memoryExclusions)) session.memoryExclusions = onDisk.memoryExclusions;
    // 122-§2.4:mission 走三引擎共用的落盘前合并(原地那句「磁盘有就整份换」是它的①③两支)。
    mergeMissionBeforeSave(session, onDisk);
  } catch { /* keep in-memory */ }
  if (session.__missionFinalizeHow) {
    const how = session.__missionFinalizeHow; delete session.__missionFinalizeHow;
    try { if (await finalizeMissionAfterTurn(session, how)) onEvent({ type: 'mission', mission: session.mission }); } catch { /* ignore */ }
  }
  // 回合代数闸(与 09 同一个 02 saveTurnFinalSession):被更新的回合顶替过的收尾存丢弃,不派 thread.done / 任务进度。
  const turnSuperseded = !(await saveTurnFinalSession(session, 'kimi-turn-final', { executionOwner }));
  // 121-K3(§13.4 登记项①的另一半):收尾帧。与 05/09 同位置(紧跟本回合最后一次 saveSession ——
  // summary 这一刻已经是本回合的话)、同载荷。收尾形状与那两路不同(Kimi 这一路没有 result 早退,
  // 整段 finally 之后才走到这里),但【派帧的时机语义】一致:回合真的结束了才派。
  if (!turnSuperseded) RUYI_EVENTS.emit('thread.done', { sessionId: session.id, summary: String(session.summary || '').slice(0, 160) });   // §6.3 指标 b
  if (session.mission && !turnSuperseded) await bumpMissionChangeSeq(session.id, {
    type: turnOk || wasStopped ? 'progress' : 'failure', cursor: { turnSeq: session.turnSeq, engine: 'claude' },
    detail: { ok: turnOk, aborted: wasStopped, errorClass: turnOk || wasStopped ? '' : 'kimi_acp_error', filesChanged: turnSummary.filesChanged.length, artifacts: turnSummary.artifacts.length, commands: Number(turnSummary.commands) || 0 },
  });
  if (!turnOk && !wasStopped) await AgentLoopHooks.dispatchAgentLoopHooks('onError', {
    traceId: activeTraceId, sessionId: session.id, turnSeq: session.turnSeq, engine: 'claude',
    model: state.model || currentClaudeModel || 'default', exitCode: 1, errorClass: 'kimi_acp_error', error: redact(errorText).slice(0, 1000),
  });
  await AgentLoopHooks.dispatchAgentLoopHooks('onTurnEnd', {
    traceId: activeTraceId, sessionId: session.id, turnSeq: session.turnSeq, engine: 'claude',
    model: state.model || currentClaudeModel || 'default', ok: turnOk, aborted: wasStopped, exitCode: turnOk ? 0 : 1,
    durationMs: Date.now() - turnStartedAt, replyLength: finalText.length, toolCalls: cleanToolCalls.length,
    usage: state.usage && state.usage.usage ? { ...state.usage.usage } : undefined,
  });
  logEvent({ kind: 'turn_end', traceId: activeTraceId, sessionId: session.id, turnSeq: session.turnSeq, engine: 'claude', agentDriver: 'kimi-acp', ok: turnOk, exitCode: turnOk ? 0 : 1, replyLen: finalText.length, tools: cleanToolCalls.length, aborted: wasStopped, durationMs: Date.now() - turnStartedAt });
  onEvent({ type: 'turn_summary', ...turnSummary });
  onEvent({ type: 'process', state: wasStopped ? 'stopped' : 'idle' });
  onEvent({ type: 'result', ok: turnOk, exitCode: turnOk ? 0 : 1, aborted: wasStopped,
    ...(reg?.cleanup || reg?.kimiAcpCleanupIncomplete ? { cleanupIncomplete, cleanupScope: reg?.cleanup?.scope, cleanupEscapeCoverage: reg?.cleanup?.escapeCoverage } : {}), error: !turnOk && !wasStopped ? redact(errorText).slice(0, 2000) : undefined });
}
