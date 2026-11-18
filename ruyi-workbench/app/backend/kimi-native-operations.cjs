'use strict';

const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { safeJsonParse } = require('./ordinary-json.cjs');
const { normalizeCwd } = require('./path-containment.cjs');
const { kimiCodeHome, readKimiWireRuntime } = require('./kimi-wire.cjs');

function createKimiNativeOperations({
  selectedAgentCli, agentCliLauncherUsable, prepareAgentCliSpawn, ProcessRuntime, killChildTree, PrivacyGateway,
  readConfig, loadSession, mutateSession, runAgentExternalCompact, upsertCompactMarker, kimiContextWindow,
  nowIso, logEvent, process = globalThis.process,
}) {
  const kimiBridgeState = { child: null, port: 0, token: '', starting: null, admission: null, signalHooked: false };

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
        // The server owns shutdown. Stop the supervised Kimi subprocess while signal handling can still run.
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

  return {
    syncKimiTurnPreferences, kimiSessionStatus, kimiUsageFromStatus, applyKimiStatusToSession, kimiStatusFingerprint,
    syncKimiSessionUsage, runKimiCompact,
  };
}

module.exports = { createKimiNativeOperations };
