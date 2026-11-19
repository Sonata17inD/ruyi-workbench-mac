'use strict';
const fsp = require('node:fs/promises');

function createClaudeSubagent({ runtime, cli, turn }) {
  const {
    DesktopExecutionHooks, PrivacyGateway, ProcessRuntime, createNdjsonLineFeeder, existsExecutableAsync,
    killChildTree, logEvent, readConfig, safeJsonParse, withTransientRetry,
  } = runtime;
  const {
    CONTEXT_OVERFLOW_PATTERNS, buildUserEnvelope, clampAgentRoleToParent, claudePermissionMode,
    decodeClaudeCliText, detectClaudePath, effectiveAnthropicEnv, generateAgentNodeMcpConfig, parseClaudeEvent,
  } = cli;
  const { appendResponseLanguagePolicy, appendUsageLedger, claudeCostFields } = turn;

  // Tool-tier → Claude native tool allowlist for a DAG node with no explicit role (or a role that leaves
  // claudeTools empty), mirroring the OpenAI subagent's tierFilter hard cap (buildOpenAiTools): 'read' can
  // never mutate, 'edit' adds file writes, 'exec' is intentionally unrestricted — the same shape as the
  // built-in 'worker'/'verifier' roles, which leave claudeTools empty for their exec tier.
  // 第22波(开放子代理工具面): read/edit 补 WebSearch/WebFetch——联网只读不落盘,与 OpenAI 侧 NATIVE_TOOL_TIER 把
  // web_search/web_fetch 定为 read 级的既有裁定对齐(此前 Claude 引擎的研究/审查类 read 节点连检索都不行,两引擎
  // 能力面不对称)。落盘/执行面(Write/Edit/Bash/MCP)分级不变。
  const CLAUDE_SUBAGENT_TIER_TOOLS = { read: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], edit: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Write', 'Edit'], exec: [] };
  // Permission modes passed straight to the CLI: 'bypass' skips all asking, 'auto' is the CLI's own built-in
  // risk classifier (v1.4.3, documented above at runClaudeTurn's usePermissionBridge computation), and 'plan'
  // never executes a mutating tool in the first place. 'default'/'acceptEdits' would block on a prompt nobody
  // can answer in a one-shot print-mode node, so they go through claudeSubagentPermission below.
  const CLAUDE_SUBAGENT_PASSTHROUGH_MODES = new Set(['bypass', 'auto', 'plan']);
  // 2026-10 拍板「两引擎都按权限档拒绝」:修前 default/acceptEdits 在 edit/exec 档被抬成 bypass —— 用户选了「每步都问」,
  // 工作流里的 Claude 节点却全自动跑,而 OpenAI 路径同档是拒绝(runSubAgentCore 里 nativeToolGate !== 'allow' → 拒绝结果)。
  // 现在与 nativeToolGate 同一条判据:default / dontAsk 只放 read 级,acceptEdits 再放 edit 级,exec 级(Bash/MCP)一律拒。
  // CLI 侧用 dontAsk 落实 —— 不在 --allowed-tools 里的工具直接拒、不弹窗,子进程不会卡在没人按的那一步。
  // capped=true 表示白名单就是授权本身(参数阶梯不能丢它,exec 档也不挂桥接 MCP:挂上去也全被拒)。
  // 节点档位的硬上限(deny):--allowed-tools 在 auto / bypass 下不是硬边界(实测 auto 档 read 节点照样能 Write / PowerShell),
  // 而 OpenAI 路径的 tierFilter 不管什么档都按节点档位封顶。所以 read / edit 档另给 --disallowed-tools,把改文件、跑命令、
  // 起子代理、对外发布 / 定时这类内建工具从模型手里拿掉(实测 auto 与 bypassPermissions 下都生效)。用拒绝清单而不是
  // --tools 允许清单,是为了兼容还不认 --tools 的旧版 CLI;exec 档不封。
  const CLAUDE_SUBAGENT_EXEC_TOOLS = ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash', 'Task', 'Agent', 'Workflow', 'TaskStop',
    'SendMessage', 'PushNotification', 'RemoteTrigger', 'CronCreate', 'CronDelete', 'ScheduleWakeup', 'Artifact', 'ArtifactData',
    'ArtifactComments', 'DesignSync', 'EnterWorktree', 'ExitWorktree'];
  const CLAUDE_SUBAGENT_EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
  const CLAUDE_SUBAGENT_TIER_DENY = {
    read: [...CLAUDE_SUBAGENT_EDIT_TOOLS, ...CLAUDE_SUBAGENT_EXEC_TOOLS],
    edit: CLAUDE_SUBAGENT_EXEC_TOOLS,
    exec: [],
  };
  const CLAUDE_SUBAGENT_TIER_RANK = { read: 0, edit: 1, exec: 2 };
  function claudeSubagentPermission(requestedMode, tier, roleTools) {
    const declared = (Array.isArray(roleTools) && roleTools.length) ? roleTools : CLAUDE_SUBAGENT_TIER_TOOLS[tier];
    const deny = CLAUDE_SUBAGENT_TIER_DENY[tier] || [];
    if (CLAUDE_SUBAGENT_PASSTHROUGH_MODES.has(requestedMode)) return { mode: requestedMode, tools: declared, deny, capped: false };
    // 白名单上限取「档位许可」与「节点档位」里更窄的那个:acceptEdits + read 节点也不许 Write。
    const modeTier = requestedMode === 'acceptEdits' ? 'edit' : 'read';
    const ceiling = CLAUDE_SUBAGENT_TIER_TOOLS[CLAUDE_SUBAGENT_TIER_RANK[tier] < CLAUDE_SUBAGENT_TIER_RANK[modeTier] ? tier : modeTier];
    const base = declared.length ? declared : ceiling; // exec 档的空清单 = 不限 → 收到该档的上限
    return { mode: 'dontAsk', tools: base.filter(t => ceiling.includes(t)), deny, capped: true };
  }

  // One-shot, session-free Claude CLI turn for a single DAG node: spawns `claude -p` with the node/role's
  // own model + tool restriction, feeds stdout through the same parseClaudeEvent normalizer runClaudeTurn
  // uses, and resolves once the CLI's own internal tool loop finishes. Unlike runClaudeTurn this owns no
  // session state (no activeChildren/claudeSessionId/resume) — a DAG node is a bounded, addressable call, so
  // runAgentWorkflow can gate/retry/loop on its return value exactly like it already does for the OpenAI
  // HTTP path (runSubAgentCore), giving the DAG a real second (Claude-native) execution engine instead of
  // always requiring an OpenAI-compatible Provider.
  // v1.4.5: classify a Claude-engine sub-agent failure so runClaudeSubAgentOnce's bounded retry loop can
  // decide whether to try again. The Claude CLI is a black box that does its OWN internal retry for
  // 429/overload/network, but it still SURFACES a failure to us when its retry budget is exhausted or the
  // process itself blips (startup/connect crash, OOM kill). Previously that single non-zero exit killed the
  // node - and with the default failurePolicy 'block', the whole workflow (the "分发出去的子agent经常性失败"
  // symptom). This classifier mirrors the OpenAI sub-agent path's transient set (transportError / 429 /
  // 502/503/504 via failoverStatus, expressed here as CLI stderr text) plus the CLI-specific "died before
  // producing anything" startup-crash case. Definitive errors (auth / model-not-found / context overflow /
  // a clean error result the CLI emitted on exit 0) are NOT retried - retrying them only burns time.
  function classifyClaudeSubagentFailure({ killed, exitCode, stderrText, assistantText, toolCallCount, gotResult, resultOk, resultText }) {
    if (killed) return { retry: false, reason: 'aborted' };
    // 防重放: the CLI already emitted assistant text or executed tools before failing. Re-running would
    // replay those side effects (file writes etc.), so never retry - matches runSubAgentCore's "mid-stream
    // errors are NOT retried" rule.
    if ((assistantText && String(assistantText).trim()) || toolCallCount > 0) return { retry: false, reason: 'progress_made' };
    // 第45波 45c:context overflow 从 definitive 拆出 —— 允许一次【缩载新鲜重试】。检查顺序保证安全:
    // progress_made 已先判(有 tool 调用/文本即不可重试),走到这里 = 零进展 → 无重放面。
    // 45f 对抗轮 P1-2:判定必须【先于】clean_error_result(CLI 执行期 API 错误常以 result 帧
    // subtype:error_during_execution 收尾,落不到 stderr),且扫描 stderr+result 合并文本;
    // 正则用 CONTEXT_OVERFLOW_PATTERNS(含真实 Anthropic 形态 "prompt is too long: N tokens > M maximum",
    // 作者假想形态 prompt_too_long 曾让整条分支成为死代码)。
    const combined = String(stderrText || '') + '\n' + String(resultText || '');
    if (CONTEXT_OVERFLOW_PATTERNS.test(combined) || /prompt_too_long/i.test(combined)) {
      return { retry: true, reason: 'over_window' };
    }
    // The CLI ran to a clean `result` event but reported is_error / subtype:error (e.g. an in-CLI tool
    // execution error). That is deterministic, not transient - retrying won't change it.
    if (gotResult && resultOk === false) return { retry: false, reason: 'clean_error_result' };
    const s = String(stderrText || '');
    // Definitive non-transient signatures (auth / model / bad request / cmd.exe 命令行超长——
    // 参数决定的确定性失败,重试同样的 args 只会原样再败;cmd8191 防线的预算哨兵应已拦截,此为兜底)。
    if (/invalid_api_key|authentication_error|auth.*fail|unauthor|\b401\b|permission_denied|\b403\b|model_not_found|not_found_error|\b404\b|invalid_request_error|命令行太长|command line is too long/i.test(s)) {
      return { retry: false, reason: 'definitive' };
    }
    // Transient signatures: rate limit / overload / 5xx / network / connect / TLS - the same set the OpenAI
    // path retries (transportError + 429 + 502/503/504), expressed as CLI stderr text.
    if (/rate_limit|rate.?limit|\b429\b|too many requests|overloaded|overloaded_error|\b5\d{2}\b|api_error|internal server|bad gateway|service unavailable|gateway timeout|fetch failed|failed to fetch|etimedout|econnreset|econnrefused|enotfound|eaddr|socket hang up|network error|connection (?:error|reset|refused|timeout)|und_err_|certificate|self-signed|tls error|getaddrinfo|timed out/i.test(s)) {
      return { retry: true, reason: 'transient' };
    }
    // Non-zero exit with no result event and no assistant text: the CLI died before doing any work (a
    // startup/connect blip its own retry budget couldn't ride out, or a process crash). Cautiously retry -
    // cheap, and a fresh process often succeeds; bounded by MAX_ATTEMPTS so a hard outage still fails fast.
    if (exitCode !== 0 && !gotResult) return { retry: true, reason: 'no_output_crash' };
    return { retry: false, reason: 'unknown' };
  }
  // v1.4.6 (C): a read/analysis Claude node emits almost no tool_use events, so its whole execution window
  // looked frozen to the polling UI. Every N chars of streamed assistant text we fire a lightweight
  // subagent_progress milestone (recordAgentNodeProgress folds it into node.progressLog as "生成中 · N 字").
  const CLAUDE_PROGRESS_CHAR_STEP = 400;
  async function runClaudeSubAgentOnce({ config, parentSession, task, displayTask, agentKey, dependsOn, toolTier, maxIters, model, onEvent, subagentId, ctrl, permModeOverride, roleDefinition, cwd, getSteer, steerReminder }) {
    if (DesktopExecutionHooks.enabled()) throw Object.assign(new Error('当前执行回执测试模式暂不支持 CLI 子代理，需要经过根服务转发的执行身份。'), { code: 'execution_cli_unavailable' });
    if (typeof PrivacyGateway !== 'undefined') { PrivacyGateway.assertSupported(config, 'cli'); PrivacyGateway.assertSupported(await readConfig(), 'cli'); }
    const started = Date.now();
    const claude = config.claudePath || detectClaudePath();
    const fakeClaude = process.env.WCW_FAKE_CLAUDE || ''; // off-by-default test seam — see runClaudeTurn
    if (!fakeClaude && (!claude || !(await existsExecutableAsync(claude)))) {   // 128f-⑬:子代理入口不钉事件循环
      // 61-C6:修前只回一句「未找到」,模型(和用户)不知道找的是哪、该怎么办 —— 真机上 claude.cmd 没装,模型只能猜。
      // 走到这里的是指定了 engine:'claude' 的节点,或会话里没有可用的模型服务商;provider 节点走 HTTP,不需要 Claude CLI。
      // 修法写进 error 本身:节点结果往上只带 error(编排信封、工作流节点卡都读它),另起的 hint 字段到不了模型。
      const where = claude ? `找过 ${claude}` : '没有配置 claudePath,PATH 里也找不到 claude';
      return { ok: false, error: `Claude CLI 未找到(${where}),无法以 Claude 引擎运行该节点。可以去掉该节点的 engine:'claude'(或不指定引擎)让它经模型服务商运行;或请用户在设置里填 Claude Code 的路径(claudePath)/安装 Claude Code 后重试`,
        iters: 0, toolCalls: 0 };
    }
    const role = roleDefinition || null;
    const tier0 = (toolTier === 'edit' || toolTier === 'exec') ? toolTier : 'read';
    const subModel = String(model || (role && role.models && role.models.claude !== 'inherit' && role.models.claude) || '').trim();

    // 安全走查 S3:项目来源的角色(.ruyi/agents.json 等)把有效权限档 / 工具级夹到不高于父回合档位;builtin / global 来源逐字不变。
    const roleGuard = clampAgentRoleToParent(role, tier0, permModeOverride === 'plan' ? 'plan' : (permModeOverride || config.permissionMode || 'default'));
    const tier = roleGuard.toolTier;
    if (roleGuard.clamped) { try { logEvent({ kind: 'agent_role_clamped', engine: 'claude', roleId: role && role.id || '', source: role && role.source || '', clamped: roleGuard.clamped }); } catch { /* 遥测不阻断 */ } }
    const roleMode = roleGuard.permissionMode;
    // 线程 / 工作流下发的只做计划档压过角色自带的档(与 OpenAI 路径 08 runSubAgentCoreBody 同一条优先级)。
    const requestedMode = permModeOverride === 'plan' ? 'plan' : (roleMode || permModeOverride || config.permissionMode || 'default');
    const grant = claudeSubagentPermission(requestedMode, tier, role && role.claudeTools);
    const effMode = grant.mode;

    // Keep the print-mode process input channel open. Claude's documented stream-json input accepts additional
    // user envelopes while a turn is running, which lets the workflow orchestrator steer a long Claude node
    // directly instead of storing a note that only downstream nodes could see after it was already too late.
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    const pm = claudePermissionMode(effMode); if (pm) args.push('--permission-mode', pm);
    if (subModel && subModel !== 'inherit') args.push('--model', subModel);
    if (config.claudeThinkingEffort) args.push('--effort', config.claudeThinkingEffort);
    if (grant.tools.length) args.push('--allowed-tools', grant.tools.join(','));
    if (grant.deny.length) args.push('--disallowed-tools', grant.deny.join(',')); // 节点档位硬上限,下面的命令行阶梯永不丢它
    const turnBudget = Number(maxIters) || (role && role.budgets && role.budgets.claude) || 0;
    if (turnBudget > 0) args.push('--max-turns', String(Math.min(300, Math.round(turnBudget))));
    // DAG subagents do not inherit the main turn's append prompt, so give them the same final language rule.
    // 2026-10:角色提示词(role.prompt)也走这里 —— 修前 Claude 节点只带语言政策,Reviewer 不改文件、Verifier 不改产品代码、
    // Critic 默认怀疑这些靠提示词立的规矩在 Claude 引擎下全丢(OpenAI 路径 runSubAgentCoreBody 一直把它放进系统提示)。
    // 下面的命令行阶梯若丢掉 --append-system-prompt,角色提示改放进首条用户消息(stdin,不受命令行长度限制),不会丢。
    const roleBrief = role && role.prompt ? `角色：${role.label || role.id}\n${role.prompt}` : '';
    let roleBriefInTask = false;
    args.push('--append-system-prompt', appendResponseLanguagePolicy(roleBrief ? roleBrief + '\n\n' : '', config, 0, task));
    if (cwd) args.push('--add-dir', cwd);
    // 第28波(§28a):Claude 引擎【不适用】服务端子代理压缩(maybeCompactSubHistory)—— claude CLI 自管上下文窗口与压缩,
    // 服务端一次性 spawn 后只累积 assistantText/resultText 求聚合结果,不持有可压缩的 history 数组。与上文桥接分级不对称同源
    // (两引擎有意不对称)。故此函数【不】引入 subHistory/maybeCompactSubHistory —— 有意为之,非遗漏(e2e 源锁断言之)。
    // Bridged (external/desktop MCP) servers attach ONLY at 'exec' tier on the Claude path — 有意与 OpenAI 路径
    // 的分级开放**不对称**(第22波安全裁定): CLI 的 --allowed-tools 在 bypass 许可模式下不是硬限制(bypass 跳过一切
    // 许可),挂上 mcp-config 即意味着子进程可调用该服务器的任意工具(含桌面全控),无法像 runSubAgentCore 那样按
    // bridgedToolTier 逐工具硬过滤。在 CLI 提供逐工具硬白名单语义前,read/edit 维持不挂桥接面。An explicit
    // role.mcpServers narrows an exec-tier node to just those servers; empty/absent means everything the
    // workbench has configured (generateAgentNodeMcpConfig mirrors generateSessionMcpConfig, keyed by subagentId).
    const roleMcpServers = (role && role.mcpServers) || [];
    const mcpConfigPath = (tier === 'exec' && !grant.capped) ? await generateAgentNodeMcpConfig(subagentId, config.mcpCommandMode, roleMcpServers) : '';
    if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);

    const spawn = fakeClaude ? { command: process.execPath, args: [fakeClaude, ...args], opts: {} } : { command: claude, args, opts: {} };
    const env = effectiveAnthropicEnv(config);
    if (fakeClaude) env.WCW_FAKE_INTERACTIVE = '1';

    onEvent({ type: 'subagent', id: subagentId, state: 'start', task: String(displayTask != null ? displayTask : task || ''), toolTier: tier, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', permissionMode: roleGuard.permissionMode || 'inherit', ...(roleGuard.clamped ? { roleClamped: roleGuard.clamped } : {}), mcpServers: roleMcpServers, engine: 'claude' });

    const workingDir = cwd || process.cwd();
    await fsp.mkdir(workingDir, { recursive: true }).catch(() => {});
    // Claude CLI 节点的空闲上限跟用户设置走(turnIdleTimeoutMs,出厂 10 分钟,可调到 60 分钟)。修前这里还封了一道 10 分钟的顶
    // (Math.min(…, 600000)),于是把「一个回合多久没动静算卡住」调大对 Claude 节点完全无效。env 缝 WCW_TURN_IDLE_MS 与 05 的主回合同名同义。
    const idleLimitMs = Math.max(1000, Number(process.env.WCW_TURN_IDLE_MS) || Number(config.turnIdleTimeoutMs) || 600000);

    // v1.4.5: transient-error resilience parity with runSubAgentCore (OpenAI path) + streamWithFailover
    // (parent turn). The CLI is retried inline a bounded number of times when a failure is classified
    // transient by classifyClaudeSubagentFailure AND made no progress (防重放). One shared abort handler
    // kills whichever child is current; the watchdog is per-attempt.
    let killed = false;
    let currentChild = null;
    const onAbort = () => { killed = true; if (currentChild) { killChildTree(currentChild); try { currentChild.stdin.end(); } catch { /* ignore */ } } };
    if (ctrl && ctrl.signal) { if (ctrl.signal.aborted) killed = true; else ctrl.signal.addEventListener('abort', onAbort, { once: true }); }

    // 45c:over_window 重试时的可变任务(缩载);初值 = 原任务。
    let taskForAttempt = task, overWindowShrunk = false;
    // One CLI spawn attempt -> collected exit/output state. Does NOT decide retry; the loop below does.
    const runOnce = async () => {
      if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertSupported(await readConfig(), 'cli');
      const child = await ProcessRuntime.spawn(spawn.command, spawn.args, { cwd: workingDir, env, stdio: ['pipe', 'pipe', 'pipe'], ...spawn.opts, signal: ctrl?.signal },
        { kind: 'cli-subagent', sessionId: parentSession.id, subagentId, agentKey });
      currentChild = child;
      return new Promise(resolve => {
      let lastEventAt = Date.now();
      // Idle watchdog - a wedged CLI must not hang the whole DAG run forever (per-attempt).
      const watchdog = setInterval(() => { if (!killed && Date.now() - lastEventAt > idleLimitMs) onAbort(); }, 5000);
      child.stdin.on('error', () => {}); // ignore EPIPE if the child exits first
      let stdinClosed = false;
      const closeStdin = () => {
        if (stdinClosed) return;
        stdinClosed = true;
        try { child.stdin.end(); } catch { /* already closed */ }
      };
      const drainSteers = () => {
        if (stdinClosed || killed || typeof getSteer !== 'function') return 0;
        let steers = [];
        try { steers = getSteer() || []; } catch { steers = []; }
        let delivered = 0;
        for (const raw of steers) {
          const text = String(raw || '').trim();
          if (!text) continue;
          try { if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertCliAllowed(); } catch { return delivered; }
          try {
            child.stdin.write(JSON.stringify(buildUserEnvelope('[编排者插话] ' + text + (steerReminder || ''))) + '\n', 'utf8');
            delivered += 1;
            lastEventAt = Date.now();
            onEvent({ type: 'subagent_steered', subagentId, text });
          } catch { /* the process may have completed between the queue drain and write */ }
        }
        return delivered;
      };
      try { child.stdin.write(JSON.stringify(buildUserEnvelope((roleBriefInTask ? roleBrief + '\n\n' : '') + String(taskForAttempt || ''))) + '\n', 'utf8'); } catch { /* ignore */ }
      // Polling is intentionally local to this child attempt. It supports both a user steering a live node and
      // the scheduler's automatic wrap-up instruction; queued messages are consumed in order and acknowledged
      // through the same subagent_steered event as Provider nodes.
      const steerTimer = setInterval(drainSteers, 250);
      if (steerTimer && steerTimer.unref) steerTimer.unref();
      let stderrText = '';
      child.stderr.on('data', chunk => { stderrText += decodeClaudeCliText(chunk); lastEventAt = Date.now(); });

      let assistantText = '';
      let progressChars = 0; // v1.4.6 (C): high-water mark of chars already reported via subagent_progress (resets per attempt)
      let toolCallCount = 0;
      let resultOk = true, resultText = '', gotResult = false;
      // v1.4-OSS 用量看板(补): per-attempt token accounting. The result frame's usage is the turn's CUMULATIVE
      // total — preferred when a field is populated. Absent it (an attempt that died before the result frame),
      // fall back to this attempt's msg_usage. The real CLI splits one multi-content-block assistant message into
      // several msg_usage events REPEATING the same usage, so summing虚计 2-3x; we take Math.max instead (帧内
      // 重复被 max 天然去重). Across API calls this max is a deliberate CONSERVATIVE lower bound (取最大一次调用) —
      // mirrors the main turn's maxCtxInput semantics.
      let resultUsage = null, resultCostUsd = NaN;
      let msgBillInMax = 0, msgBillOutMax = 0;
      // No --include-partial-messages here (a DAG node's aggregated result is all runAgentWorkflow consumes),
      // so parseClaudeEvent only ever emits whole (non-partial) text - no delta/whole dedup needed.
      const consumeLine = line => {
        if (!line.trim()) return;
        lastEventAt = Date.now();
        const evt = safeJsonParse(line);
        if (!evt) return;
        for (const ev of parseClaudeEvent(evt)) {
          if (ev.kind === 'text') {
            assistantText += ev.text;
            // v1.4.6 (C): emit a progress milestone each time streamed text crosses another
            // CLAUDE_PROGRESS_CHAR_STEP boundary so a long, tool-less generation shows live activity.
            if (assistantText.length - progressChars >= CLAUDE_PROGRESS_CHAR_STEP) {
              progressChars = assistantText.length;
              onEvent({ type: 'subagent_progress', subagentId, chars: assistantText.length, note: `生成中 · ${assistantText.length} 字`, noteCode: 'generating' });   // 第三波 M4:note 是写日志的中文,noteCode 让前端按界面语言出字
            }
          }
          else if (ev.kind === 'tool_use') { toolCallCount += 1; onEvent({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input, subagentId }); }
          else if (ev.kind === 'tool_result') onEvent({ type: 'tool_result', id: ev.id, content: ev.content, isError: ev.isError, subagentId });
          else if (ev.kind === 'result') {
            gotResult = true; resultOk = ev.ok !== false; if (ev.result) resultText = ev.result;
            if (ev.usage && typeof ev.usage === 'object') resultUsage = ev.usage;
            const c = Number(ev.costUsd); if (Number.isFinite(c)) resultCostUsd = c;
            // Drain a steer that raced the result frame before signalling EOF. Any already-written envelope
            // remains ahead of EOF and Claude processes it as the final turn; with no steer this closes normally.
            drainSteers();
            closeStdin();
          }
          else if (ev.kind === 'msg_usage' && ev.usage && typeof ev.usage === 'object') { msgBillInMax = Math.max(msgBillInMax, Number(ev.usage.input_tokens) || 0); const mo = Number(ev.usage.output_tokens) || 0; msgBillOutMax = Math.max(msgBillOutMax, mo > 0 ? mo : 0); }
        }
      };
      // 117q-B1(30 号文 §4.1):与 05-claude-engine.js 逐字节相同的旧缺陷——走 createNdjsonLineFeeder 而非逐块
      // toString,chunk 边界不保证落在字符边界上,被切开的 CJK 字节不能各自独立解码。
      const stdoutFeeder = createNdjsonLineFeeder(consumeLine);
      child.stdout.on('data', chunk => { stdoutFeeder.push(chunk); });
      let settled = false;
      const finish = exitCode => { if (settled) return; settled = true; clearInterval(watchdog); clearInterval(steerTimer); closeStdin(); stdoutFeeder.flush(); currentChild = null; resolve({ exitCode, stderrText, assistantText, toolCallCount, resultOk, resultText, gotResult, resultUsage, resultCostUsd, msgBillInMax, msgBillOutMax }); };
      child.on('error', () => finish(-1));
      child.on('close', code => finish(code == null ? -1 : code));
    });

    };
    const MAX_ATTEMPTS = 3;
    let lastFinalText = '', lastErr = '', lastToolCalls = 0;
    // v1.4-OSS 用量看板(补): accumulate token/cost across ALL attempts (a failed attempt still burned real tokens).
    // Written ONCE at every exit path via the finally below. Accounting is fully defensive — it can never change
    // the sub-agent's return value or throw (appendUsageLedger is itself fire-and-forget and skips zero-token rows).
    // ledgerCostUsd starts NaN, not 0: "no CLI cost frame ever seen" must reach claudeCostFields as non-finite
    // so it yields cost:null (unknown), never a false trusted-$0 row (mirrors the main turn's Number(undefined)).
    // ledgerEstimated flips true whenever an attempt fell back to the msg_usage max (保守下限, not the exact
    // cumulative result usage) so the row is honestly badged 估算.
    // P2-18(30号文§3 总表): ledgerCachedIn —— 同一批次三处「Claude 引擎从不写 cachedInTok」缺口之一,累加口径
    // 与 05-claude-engine.js 的主回合读法对齐(cache_read_input_tokens + cache_creation_input_tokens);只在
    // 「信任 result 帧」分支累加(与 ledgerIn/ledgerOut 同一 FIELD-LEVEL source select,msg_usage 兜底帧没有
    // cache 字段)。费用计算不受影响(claudeCostFields 走 CLI costUsd,不经 cachedInTok 定价路径)。
    // hunt2-engines#2:ledgerIn 记账本口径(输入 + 缓存读 + 缓存创建,与 05 主回合 recordTurnUsage 同一归一),
    // ledgerRawIn 留 CLI 原始 input_tokens 只给 claudeCostFields 定价(费用算法不变)。
    let ledgerIn = 0, ledgerRawIn = 0, ledgerOut = 0, ledgerCachedIn = 0, ledgerCostUsd = NaN, ledgerEstimated = false;
    try {
      // 架构还债批 2·A:重试骨架走 04h 的 withTransientRetry(与 08 的 OpenAI 子回合同一份)。本处口径原样:总共至多
      // MAX_ATTEMPTS 次(= MAX_ATTEMPTS-1 次重试);每次尝试前查 killed;失败先记账与 last*,再由 classifyClaudeSubagentFailure
      // 裁决;重试前发 retry 事件,再睡 min(2000, 300·attempt)(可被中止截断)。attempt = 本次之前已用掉的重试数 + 1。
      let okText = null, okToolCalls = 0, retryReason = '';
      await withTransientRetry({
        maxRetries: MAX_ATTEMPTS - 1,
        isAborted: () => killed,
        signal: ctrl && ctrl.signal,
        // Bounded backoff an abort can cut short (the same abortableDelay as runSubAgentCore's transient-retry sleep).
        backoffMs: attempt => Math.min(2000, 300 * attempt),
        attempt: async () => {
          const res = await runOnce();
          try {
            // FIELD-LEVEL source select (保守语义): trust the result frame's usage only when a field is actually
            // populated (>0). A result frame carrying an empty usage:{} must NOT record a bogus 0 — fall back to
            // this attempt's msg_usage max (帧内已去重) and flag the row estimated. Zero on both sides = nothing
            // billable this attempt.
            const ru = res.resultUsage;
            const ruIn = ru ? (Number(ru.input_tokens) || 0) : 0, ruOut = ru ? (Number(ru.output_tokens) || 0) : 0;
            const ruCachedIn = ru ? (Number(ru.cache_read_input_tokens) || 0) + (Number(ru.cache_creation_input_tokens) || 0) : 0;
            if (ruIn > 0 || ruOut > 0) { ledgerIn += ruIn + ruCachedIn; ledgerRawIn += ruIn; ledgerOut += ruOut; ledgerCachedIn += ruCachedIn; }
            else if ((Number(res.msgBillInMax) || 0) > 0 || (Number(res.msgBillOutMax) || 0) > 0) {
              ledgerIn += Number(res.msgBillInMax) || 0; ledgerRawIn += Number(res.msgBillInMax) || 0; ledgerOut += Number(res.msgBillOutMax) || 0; ledgerEstimated = true;
            }
            if (Number.isFinite(res.resultCostUsd)) ledgerCostUsd = (Number.isFinite(ledgerCostUsd) ? ledgerCostUsd : 0) + res.resultCostUsd;
          } catch { /* never let accounting break the attempt */ }
          return res;
        },
        classify: (res, { retries }) => {
          const attempt = retries + 1;
          const finalText = (res.resultText || res.assistantText).trim();
          const ok = !killed && res.exitCode === 0 && res.resultOk && !!finalText;
          if (ok) { okText = finalText; okToolCalls = res.toolCallCount; return 'done'; }
          lastFinalText = finalText; lastToolCalls = res.toolCallCount;
          lastErr = killed ? '节点已中止或空闲超时' : (String(res.stderrText || '').trim().slice(0, 2000) || finalText || `claude 退出码 ${res.exitCode}`);
          const cls = classifyClaudeSubagentFailure({ killed, exitCode: res.exitCode, stderrText: res.stderrText, assistantText: res.assistantText, toolCallCount: res.toolCallCount, gotResult: res.gotResult, resultOk: res.resultOk, resultText: res.resultText });
          if (killed || !cls.retry || attempt >= MAX_ATTEMPTS) return 'stop';
          // 45c:over_window → 缩载后新鲜重试(一次性 spawn 无 resume,超窗 = 任务载荷本身过大;cap 60K 字符)。
          // 45f P3-7:任务本就不超 60K 时缩无可缩(超窗根因是系统提示/schema),重试必败 —— 不再白烧一次 spawn。
          if (cls.reason === 'over_window') {
            const raw = String(task || '');
            if (overWindowShrunk || raw.length <= 60000) return 'stop';
            overWindowShrunk = true;
            taskForAttempt = raw.slice(0, 60000) + `\n\n…(原任务 ${raw.length} 字符,上次因上下文超限失败已截断;请聚焦完成可达部分)`;
          }
          retryReason = cls.reason;
          return 'retry';
        },
        onRetry: (res, attempt) => {
          onEvent({ type: 'subagent', id: subagentId, state: 'retry', attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, reason: retryReason, error: String(res.stderrText || '').trim().slice(0, 500) || `claude 退出码 ${res.exitCode}` });
        },
      });
      if (okText !== null) {
        onEvent({ type: 'subagent', id: subagentId, state: 'end', ok: true, resultChars: okText.length, task: String(displayTask != null ? displayTask : task || ''), tookMs: Date.now() - started, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', engine: 'claude' });
        return { ok: true, result: okText, iters: 1, toolCalls: okToolCalls };
      }
      if (!killed && lastFinalText.trim().length >= 80 && lastToolCalls > 0) {
        onEvent({ type: 'subagent', id: subagentId, state: 'end', ok: true, degraded: true, resultChars: lastFinalText.length, task: String(displayTask != null ? displayTask : task || ''), tookMs: Date.now() - started, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', engine: 'claude' });
        return { ok: true, degraded: true, warning: lastErr || 'Claude CLI exited after producing usable output', result: lastFinalText, iters: 1, toolCalls: lastToolCalls };
      }
      onEvent({ type: 'subagent', id: subagentId, state: 'end', ok: false, resultChars: lastFinalText.length, task: String(displayTask != null ? displayTask : task || ''), tookMs: Date.now() - started, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', engine: 'claude' });
      return { ok: false, error: lastErr || '子代理未产出结论', result: lastFinalText, iters: 1, toolCalls: lastToolCalls };
    } finally {
      // v1.4-OSS 用量看板(补): ONE ledger row for the whole node (accumulated across attempts). Billing fields via
      // claudeCostFields (与主回合同源). No parentSession → nothing to anchor a row to; skip. Zero-token rows are
      // dropped inside appendUsageLedger, so the 'CLI 未找到' early-return above (never reaches here anyway) needs
      // no special case, and a purely-aborted node with no usage records nothing.
      try {
        if (parentSession) {
          const { provider: claudeProvider, cost, currency, costTrusted } = claudeCostFields(config, ledgerRawIn, ledgerOut, ledgerCostUsd);
          appendUsageLedger({
            sessionId: parentSession.id, engine: 'claude', provider: claudeProvider,
            // A workflow node can pass model:'inherit' straight through (subModel === 'inherit'); the model that
            // actually ran is then config.model — record that, never the literal 'inherit'.
            model: (subModel && subModel !== 'inherit') ? subModel : (config.model || ''), inTok: ledgerIn, outTok: ledgerOut,
            cachedInTok: ledgerCachedIn, cost, currency, costTrusted, estimated: ledgerEstimated, turnSeq: parentSession.turnSeq,
            kind: 'subagent', agentKey, subagentId,
          });
          // 29c: 用量随事件上抛 —— DAG 节点的 nodeEvent 借此把 token/成本累进 run.usageTotals(前端画布迷你条
          // 与运行卡 chip 早已防御性读这些字段,"后端并行落地中"说的就是这里)。与 ledger 同源同值。
          onEvent({ type: 'subagent_usage', id: subagentId, agentKey, inTok: ledgerIn, outTok: ledgerOut, cost, currency, estimated: ledgerEstimated });
        }
      } catch { /* accounting must never break the sub-agent */ }
    }
  }

  return { classifyClaudeSubagentFailure, runClaudeSubAgentOnce };
}

module.exports = { createClaudeSubagent };
