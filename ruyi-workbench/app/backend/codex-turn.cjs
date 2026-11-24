'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { redact } = require('./secret-redaction.cjs');
const { appServerArgs, codexConnection, providerId } = require('./codex-app-server.cjs');

function codexInput(message, attachments, attachmentPrompt) {
  const text = message + attachmentPrompt(attachments);
  return [
    { type: 'text', text },
    ...attachments
      .filter((a) => /^image\/(png|jpeg|webp|gif)$/.test(a.mime || a.mimeType || a.type))
      .map((a) => ({ type: 'localImage', path: a.path })),
  ];
}

function createCodexTurn(host) {
  return async function runCodexTurn({
    session,
    message,
    attachments = [],
    cwd,
    config,
    onEvent,
    messageMeta,
    driverAuto,
    agentTeam,
    executionOwner,
  }) {
    const { account, activeChildren, privacy, desktop } = host;
    const checkOwner = () => host.assertSessionExecutionOwner(session.id, executionOwner);
    const checkPrivacy = async () => {
      privacy.assertSupported(config, 'cli');
      privacy.assertSupported(await host.readConfig(), 'cli');
    };
    await checkPrivacy();
    checkOwner();
    if (desktop.enabled()) throw new Error('当前执行回执测试模式不支持 CLI 会话。');
    if (agentTeam || driverAuto) throw new Error('Codex CLI 当前支持普通线程，请使用单 Agent 模式。');
    const workingDir = host.normalizeCwd(cwd || session.cwd, config.defaultWorkspace);
    const seq = (session.turnSeq || 0) + 1;
    const traceId = host.makeTraceId(session.id, seq);
    const segments = host.createTurnSegmentBuilder();
    const reg = {
      kind: 'codex',
      state: 'running',
      session,
      traceId,
      startedAt: Date.now(),
      permissionMode: config.permissionMode,
      liveTail: { text: '', tool: '', updatedAt: '' },
      liveSegments: segments,
    };
    reg.onEvent = (event) => {
      reg.lastEventAt = Date.now();
      const evt = { ...event, traceId };
      host.appendLiveTail(reg, evt);
      segments.consume(evt);
      onEvent(evt);
    };
    host.installActiveChildEventFanout(reg);
    const emit = (evt) => reg.onEvent(evt);
    const prior = session.messages.slice();
    session.turnSeq = seq;
    desktop.admit(session, executionOwner);
    session.messages.push({
      role: 'user',
      content: message,
      attachments,
      turnSeq: seq,
      traceId,
      createdAt: host.nowIso(),
      ...(messageMeta && { meta: messageMeta }),
    });
    await host.saveSession(session, { executionOwner });
    let child,
      rpc,
      turnId,
      threadId,
      usage,
      baseline,
      error = '',
      model = config.model || '',
      status = 'failed';
    let finish, interruptTimer, messageUsage;
    let diagnostic = '',
      thinking = '';
    const compact = message.trim() === '/compact';
    const completion = new Promise((resolve) => {
      finish = resolve;
    });
    const texts = new Map(),
      calls = new Map();
    const timeout = () => host.permissionWaitMs(session.id, config, session);
    function notify(method, p) {
      if (!p || !threadId || p.threadId !== threadId || (turnId && p.turnId && p.turnId !== turnId)) return;
      if (method === 'turn/started') turnId = p.turn.id;
      if (method === 'turn/completed' && (!turnId || p.turn.id === turnId)) finish(p.turn);
      if (method === 'thread/tokenUsage/updated') usage = p.tokenUsage;
      if (method === 'item/reasoning/summaryTextDelta') {
        thinking += p.delta;
        emit({ type: 'thinking_delta', text: p.delta });
      }
      if (method === 'item/agentMessage/delta') {
        texts.set(p.itemId, (texts.get(p.itemId) || '') + p.delta);
        emit({ type: 'assistant_delta', text: p.delta });
      }
      const i = p.item;
      if (!i) return;
      if (i.type === 'agentMessage' && method === 'item/completed') {
        const received = texts.get(i.id) || '';
        if (i.text.startsWith(received) && i.text.length > received.length)
          emit({ type: 'assistant_delta', text: i.text.slice(received.length) });
        texts.set(i.id, i.text);
        if (i.phase === 'commentary' && i.text) emit({ type: 'commentary_end' });
        return;
      }
      const native = { commandExecution: 'Bash', fileChange: 'Edit', webSearch: 'WebSearch' };
      const name = i.type === 'mcpToolCall' ? i.tool : native[i.type];
      if (!name) return;
      if (method === 'item/started') {
        const input = i.arguments || (i.command ? { command: i.command } : { changes: i.changes, query: i.query });
        calls.set(i.id, { id: i.id, name, input });
        emit({ type: 'tool_use', id: i.id, name, input });
      }
      if (method === 'item/completed') {
        const result = i.error || i.result || i.aggregatedOutput || i.status;
        const content = typeof result === 'string' ? result : JSON.stringify(result);
        if (calls.has(i.id)) calls.get(i.id).result = content;
        emit({
          type: 'tool_result',
          id: i.id,
          content,
          isError: i.status === 'failed' || Boolean(i.error || i.result?.isError),
        });
      }
    }
    async function handleRequest(method, p) {
      if (p.threadId !== threadId || (turnId && p.turnId && p.turnId !== turnId))
        throw new Error('Inactive Codex turn');
      checkOwner();
      if (method === 'item/tool/requestUserInput') {
        const answer = await host.requestUserQuestion(
          session.id,
          p.itemId,
          p.questions.map((q) => ({ ...q, allowOther: q.isOther })),
          emit,
          config.questionTimeoutMs,
        );
        return {
          answers: Object.fromEntries((answer.answers || []).map((a) => [a.questionId, { answers: a.answer }])),
        };
      }
      if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
      if (method === 'mcpServer/elicitation/request') return { action: 'decline' };
      const edit = method === 'item/fileChange/requestApproval';
      if (!edit && method !== 'item/commandExecution/requestApproval')
        throw new Error('Unsupported Codex request: ' + method);
      const name = edit ? 'Edit' : 'Bash';
      if (config.permissionMode === 'plan' || (!edit && !config.allowCommandTools)) return { decision: 'decline' };
      const input = edit
        ? { path: p.grantRoot, reason: p.reason }
        : { command: p.command, cwd: p.cwd, reason: p.reason };
      const decision = await host.requestNativePermission(
        session.id,
        name,
        input,
        emit,
        timeout(),
        edit ? 'edit' : 'exec',
      );
      if (decision.behavior === 'allow' && !baseline) baseline = await host.captureWorkspaceTurnBaseline(workingDir);
      return { decision: decision.behavior === 'allow' ? 'accept' : 'decline' };
    }
    try {
      const command = host.selectedAgentCli(config).path;
      if (!command) throw new Error('未找到 Codex CLI，请在设置中指定 codex 可执行文件。');
      const accountRevision = account.revision;
      const auth = await account.access();
      if (!model) model = (account.cachedModels()[0] || (await account.models(auth))[0])?.id;
      if (!model) throw new Error('此 ChatGPT 账号没有可用的套餐模型。');
      const home = path.join(
        host.dataDirectory,
        'codex',
        crypto.createHash('sha256').update(auth.id).digest('hex').slice(0, 24),
      );
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      const perThreadConfig = {
        'features.shell_tool': Boolean(config.allowCommandTools) && config.permissionMode === 'bypass',
      };
      let bridgeToken;
      if (config.includeWorkbenchMcp) {
        const file = await host.generateSessionMcpConfig(
          session.id,
          config.mcpCommandMode,
          host.classifyToolPacks(message, attachments),
          { desktopOverride: host.sessionDesktopToolsOf(session) },
        );
        const self = JSON.parse(await fs.readFile(file, 'utf8')).mcpServers[host.mcpId];
        const { WCW_TOKEN, ...env } = self.env;
        perThreadConfig.mcp_servers = {
          [host.mcpId]: {
            command: self.command,
            args: self.args,
            required: true,
            // The Ruyi MCP process requests approval for the resolved tool and arguments before execution.
            default_tools_approval_mode: 'approve',
            disabled_tools: ['permission_prompt', 'orchestrate_agents', 'spawn_agent'],
            env: { ...env, RUYI_CODEX_MCP: '1' },
            env_vars: ['WCW_TOKEN'],
          },
        };
        bridgeToken = WCW_TOKEN;
      }
      const bound = session.codexThread;
      const resume = bound && bound.account === auth.id && bound.cwd === workingDir && bound.seq === seq - 1;
      const instructions = await host.instructions(session, config, workingDir, message);
      const params = {
        cwd: workingDir,
        model,
        modelProvider: providerId,
        config: perThreadConfig,
        sandbox: config.permissionMode === 'bypass' && config.allowCommandTools ? 'danger-full-access' : 'read-only',
        approvalPolicy: config.permissionMode === 'plan' ? 'never' : 'on-request',
        developerInstructions: instructions,
      };
      if (config.permissionMode === 'bypass') baseline = await host.captureWorkspaceTurnBaseline(workingDir);
      await checkPrivacy();
      checkOwner();
      const env = {
        PATH: [path.dirname(process.execPath), path.dirname(command), process.env.PATH].join(path.delimiter),
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        CODEX_HOME: home,
        RUYI_CHATGPT_ACCESS_TOKEN: auth.token,
        WCW_TOKEN: bridgeToken,
      };
      child = await host.processRuntime.spawn(
        command,
        appServerArgs(),
        { cwd: workingDir, env, stdio: ['pipe', 'pipe', 'pipe'], admit: checkOwner },
        { kind: 'cli', agentCliType: 'codex', sessionId: session.id, traceId, turnSeq: seq },
      );
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        diagnostic = (diagnostic + chunk).slice(-4000);
      });
      rpc = codexConnection(child, { notify, handleRequest });
      reg.child = child;
      reg.pid = child.pid;
      reg.abort = () => {
        if (!turnId) {
          finish({ status: 'interrupted' });
          child.stdin.end();
          return;
        }
        interruptTimer = setTimeout(() => finish({ status: 'interrupted' }), 1500).unref();
        rpc.request('turn/interrupt', { threadId, turnId }).catch(() => finish({ status: 'interrupted' }));
      };
      host.registerSessionExecutionChild(session.id, reg, executionOwner);
      if (accountRevision !== account.revision) throw new Error('ChatGPT account changed');
      emit({
        type: 'meta',
        agentCliType: 'codex',
        agentCliLabel: 'Codex CLI',
        agentDriver: 'codex-native',
        model,
        cwd: workingDir,
        permissionMode: config.permissionMode,
      });
      emit({ type: 'process', state: 'running' });
      await rpc.request('initialize', { clientInfo: { name: 'Ruyi', title: 'Ruyi', version: host.version } });
      rpc.send({ method: 'initialized' });
      checkOwner();
      let thread;
      if (resume) {
        try {
          thread = await rpc.request('thread/resume', { ...params, threadId: bound.id });
        } catch (failure) {
          if (!/thread not found|no rollout found|thread .* does not exist/i.test(failure.message)) throw failure;
        }
      }
      if (compact && !thread) throw new Error('请在当前账号的 Codex 线程中完成一轮对话后再压缩。');
      if (!thread) thread = await rpc.request('thread/start', params);
      threadId = thread.thread.id;
      model = thread.model || model;
      session.codexThread = { id: threadId, account: auth.id, cwd: workingDir, seq, model };
      await host.saveSession(session, { executionOwner });
      await checkPrivacy();
      checkOwner();
      const history =
        threadId !== bound?.id && (!bound || bound.account === auth.id)
          ? session.agentRecoverySummary || host.buildRecoveryHistory(prior)
          : '';
      const text = [history, message].filter(Boolean).join('\n\n');
      if (compact) {
        await rpc.request('thread/compact/start', { threadId });
      } else {
        const started = await rpc.request('turn/start', {
          threadId,
          input: codexInput(text, attachments, host.buildAttachmentPrompt),
          ...(config.codexThinkingEffort && { effort: config.codexThinkingEffort }),
        });
        turnId = started.turn.id;
        reg.steer = (text, files) =>
          rpc.request('turn/steer', {
            threadId,
            expectedTurnId: turnId,
            input: codexInput(text, files, host.buildAttachmentPrompt),
          });
      }
      const turn = await Promise.race([
        completion,
        rpc.disconnected.then((e) => {
          throw e;
        }),
      ]);
      status = turn.status;
      error = redact(turn.error?.message || '');
      if (status === 'completed' && history && session.agentRecoverySummary) {
        delete session.agentRecoverySummary;
        delete session.agentRecoverySource;
      }
    } catch (e) {
      error = redact(
        e.message === 'Codex app-server disconnected' && diagnostic.trim()
          ? e.message + ': ' + diagnostic.trim()
          : e.message,
      ).slice(0, 2000);
      if (executionOwner?.cancelRequested || reg.exited) status = 'interrupted';
    } finally {
      clearTimeout(interruptTimer);
      if (activeChildren.get(session.id) === reg) {
        host.clearPendingPermissions(session.id, 'Codex turn ended');
        host.clearPendingQuestions(session.id, 'Codex turn ended');
        activeChildren.delete(session.id);
      }
      if (child) {
        child.stdin.end();
        host.killChildTree(child);
      }
    }
    if (usage) {
      const u = usage.total;
      const old = session.codexUsage;
      const previous = old?.thread === threadId ? old : {};
      const delta = (k) => Math.max(0, (u[k] || 0) - (previous[k] || 0));
      const cached = delta('cachedInputTokens'),
        input = Math.max(0, delta('inputTokens') - cached),
        output = delta('outputTokens');
      messageUsage = {
        usage: { input_tokens: input, cache_read_input_tokens: cached, output_tokens: output },
        contextEngine: 'agent',
        contextAgentCliType: 'codex',
        contextModel: model,
        contextTokens: usage.last?.totalTokens,
        contextWindow: usage.modelContextWindow || undefined,
        contextWindowSource: usage.modelContextWindow ? 'usage' : undefined,
      };
      emit({ type: 'usage', ...messageUsage });
      await host.appendUsageLedger({
        sessionId: session.id,
        turnSeq: seq,
        kind: 'turn',
        engine: 'codex',
        provider: 'chatgpt-plan',
        model,
        inTok: input + cached,
        cachedInTok: cached,
        outTok: output,
        cost: null,
        costTrusted: false,
      });
      session.codexUsage = { thread: threadId, ...u };
    }
    if (baseline) await host.reconcileWorkspaceTurnBaseline(baseline, session.id, seq);
    const tools = Array.from(calls.values());
    const journal = (await host.journalReadIndex(session.id)).filter((e) => Number(e.turnSeq) === seq);
    const turnSummary = host.buildTurnSummary(seq, tools, 'codex', journal);
    const content = [...texts.values()].join('\n\n');
    const aborted = status === 'interrupted',
      ok = status === 'completed';
    segments.finalizeAll(aborted ? 'Stopped' : 'Turn ended');
    session.messages.push({
      role: 'assistant',
      content: content || error || (compact && ok ? '上下文已压缩。' : ''),
      usage: messageUsage,
      thinking: thinking || undefined,
      ...(error && { error }),
      segments: segments.snapshot(),
      turnSeq: seq,
      traceId,
      source: aborted ? 'aborted' : 'codex-cli',
      engine: 'claude',
      agentCliType: 'codex',
      agentCliLabel: 'Codex CLI',
      model,
      createdAt: host.nowIso(),
      toolCalls: tools,
      turnSummary,
      exitCode: ok ? 0 : 1,
    });
    if (host.isUntitledSessionTitle(session.title)) session.title = message.trim().slice(0, 60);
    session.summary = content.trim().slice(0, 160) || session.summary;
    await host.reconcileTurnMetadata(session, { includeTodos: true });
    const saved = await host.saveTurnFinalSession(session, 'codex-turn-final', { executionOwner });
    emit({ type: 'turn_summary', ...turnSummary });
    emit({ type: 'process', state: aborted ? 'stopped' : 'idle' });
    emit({ type: 'result', ok: ok && saved, aborted, superseded: !saved, error: error || undefined });
  };
}
module.exports = { createCodexTurn };
