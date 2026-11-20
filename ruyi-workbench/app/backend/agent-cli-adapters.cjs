'use strict';

function createAgentCliAdapters({ cli, claude, tools, usage }) {
  const { AGENT_CLI_TYPES, normalizeAgentCliType, prepareAgentCliSpawn } = cli;
  const {
    CLAUDE_PERMISSION_MODE_MAP, RUYI_MCP_CLI_TOOL_PREFIX, buildClaudeAgentDefinitions, claudeCostFields,
    discoverModels, effectiveAnthropicEnv, isClaudeResumeMissingError, offlineModelList, parseClaudeEvent,
  } = claude;
  const { classifyToolPacks, generateSessionMcpConfig, sessionDesktopToolsOf } = tools;
  const { appendUsageLedger } = usage;

  const AGENT_CLI_ADAPTERS = Object.freeze({
    claude: Object.freeze({
      id: 'claude',
      interactive: AGENT_CLI_TYPES.claude.usesStreamJsonInput,
      async buildArgs({ config, session, basePrompt, attachments, interactive }) {
        const args = ['-p', '--output-format', 'stream-json', '--verbose'];
        if (interactive) args.push('--input-format', 'stream-json');
        if (config.includePartialMessages) args.push('--include-partial-messages');
        if (config.betaInterleavedThinking) args.push('--betas', 'interleaved-thinking');
        if (config.includeWorkbenchMcp) {
          const claudeToolPacks = classifyToolPacks(basePrompt, attachments);
          // full 模式直挂的 ACC 按这条线程的 desktopTools 裁剪。
          args.push('--mcp-config', await generateSessionMcpConfig(session.id, config.mcpCommandMode, claudeToolPacks, { desktopOverride: sessionDesktopToolsOf(session) }));
          // In print mode the documented stream-json input accepts text user messages, not arbitrary tool_result
          // envelopes. Route questions through our MCP tool instead of Claude's terminal-only native prompt.
          if (interactive) args.push('--disallowedTools', 'AskUserQuestion');
        }
        // v1.4.3: 'auto' mode uses the CLI's built-in risk classifier, no workbench bridge needed.
        if (config.permissionBridge && config.permissionMode !== 'bypass' && config.permissionMode !== 'auto') {
          // permission-prompt-tool 名派生自 MCP server id,须与之一致(RUYI_MCP_CLI_TOOL_PREFIX)。
          args.push('--permission-prompt-tool', `${RUYI_MCP_CLI_TOOL_PREFIX}permission_prompt`);
        }
        // v1.4.2: use --permission-mode bypassPermissions (the standard CLI flag) instead of the deprecated
        // --dangerously-skip-permissions shortcut. They are functionally equivalent per Anthropic docs, but
        // --permission-mode is the forward-compatible, officially documented way to set the session mode.
        // The syncClaudeCliSettings() call (on config save) also writes permissions.defaultMode to
        // ~/.claude/settings.json so the mode persists even if a CLI version ignores the flag —— 安全走查 S9:bypass 档除外,
        // 它【不】写 bypassPermissions 进用户全局(会波及脱离如意的独立 claude 会话),只靠这里每回合的命令行参数。
        // v1.4.3: use the unified CLAUDE_PERMISSION_MODE_MAP for all modes
        const cliPermMode = CLAUDE_PERMISSION_MODE_MAP[config.permissionMode] || config.permissionMode;
        if (cliPermMode) args.push('--permission-mode', cliPermMode);
        if (config.model) args.push('--model', config.model);
        if (config.claudeThinkingEffort) args.push('--effort', config.claudeThinkingEffort);
        if (config.maxTurns) args.push('--max-turns', String(config.maxTurns));
        return args;
      },
      resumeArgs: nativeSessionId => ['--resume', nativeSessionId],
      extraArgs: config => (Array.isArray(config.extraClaudeArgs) ? config.extraClaudeArgs : []),
      prepareSpawn: (command, args) => prepareAgentCliSpawn('claude', command, args),
      appendSystemPromptFlag: '--append-system-prompt',
      buildAgentDefinitions: (workingDir, config, budget) => buildClaudeAgentDefinitions(workingDir, config, budget),
      // v1.4.4: effectiveAnthropicEnv overlays the config-driven third-party endpoint/model (modelsApiBase/
      // modelsApiKey/claudeAuthMode/model) onto process.env, so a frontend change to any of those actually
      // reaches this child instead of silently deferring to whatever the OS shell happened to export.
      buildEnv(config, common) {
        const env = { ...effectiveAnthropicEnv(config), ...common };
        if (config.thinkingBudget) env.MAX_THINKING_TOKENS = String(config.thinkingBudget);
        return env;
      },
      thinkingEffortLabel: config => config.claudeThinkingEffort || 'default',
      promptViaStdin: true,
      // Only Claude's Agent/Task tools follow the native sub-agent continuation protocol in runClaudeTurn.
      isNativeAgentTool: name => name === 'Agent' || name === 'Task',
      parseEvent: evt => parseClaudeEvent(evt),
      isResumeMissingError: stderrText => isClaudeResumeMissingError(stderrText),
      // Claude 交互模式禁了原生 AskUserQuestion(--disallowedTools),提问走如意的 MCP 工具。
      nativeAskUserQuestion: AGENT_CLI_TYPES.claude.hasNativeQuestionPrompt(),
      modelCatalog: Object.freeze({
        offline: config => offlineModelList(config),
        discover: async config => ({ ok: true, engine: 'claude', agentCliType: 'claude', ...(await discoverModels(config)) }),
      }),
      // Claude 的上下文占用来自流内用量帧;没有可查询的原生状态面,也没有可从外部触发的原生压缩(用户在 CLI 里打 /compact)。
      // v1.4-OSS 用量看板: append this turn to the monthly cost ledger (fire-and-forget; skips zero-token turns).
      // Cost precedence: (1) config.claudePricing if the user set it (tokens×price -> a meaningful estimate for
      // BOTH direct + third-party endpoints); (2) else, for Anthropic-direct only, the CLI's notional USD; (3) else
      // (third-party, unpriced) tokens with cost null + costTrusted false (its CLI total_cost_usd is Anthropic-
      // priced and wrong for that vendor, and it is often a flat monthly plan not billed per token).
      recordTurnUsage({ session, config, usage, billInMax, billOutMax }) {
        if (usage && usage.usage) {
          const rawInTok = Number(usage.usage.input_tokens) || 0, outTok = usage.usage.output_tokens;
          // P2-18(30号文§3 总表): cachedInTok —— 读(cache_read_input_tokens)+ 创建(cache_creation_input_tokens)
          // 两项相加,读法与 runClaudeTurn 的 msg_usage 分支(上下文估算)已在用的读法对齐(CLI 结果帧的这两个字段本就独立,
          // 只读一项会漏记「本回合新写入缓存」的部分)。此前三处 Claude 引擎的 appendUsageLedger 都没传这个字段,用量看板
          // 「缓存输入 tokens」那一栏对 Claude 会话恒为空(06/08/09 走 provider 侧则一直有值)。
          // 【费用计算不受影响】:Claude 引擎走 claudeCostFields → CLI 自带的 costUsd(或 config.claudePricing 整体
          // 定价),不经过 computeProviderCost/computeCostFromPricing 那条按 cachedInTok 打折的定价路径 —— 这里
          // 补写只是让看板口径不再对 Claude 会话空缺,不改变任何一笔已记的费用。
          const cachedInTok = (Number(usage.usage.cache_read_input_tokens) || 0) + (Number(usage.usage.cache_creation_input_tokens) || 0);
          // hunt2-engines#2:账本的口径是 OpenAI 那一套 —— inTok 是【全部】输入、cachedInTok 是它的子集(00 appendUsageLedger
          // 按 min(inTok, cachedInTok) 夹住)。Claude 的 input_tokens 却【不含】缓存那两项(04i normalizeAnthropicUsage 同一事实),
          // 直接记会让重缓存回合(input 3、缓存 5 万)的缓存被夹成 3,看板每回合少记几万 token。这里先归一成账本口径;
          // 费用仍按 CLI 原始 input_tokens 交给 claudeCostFields(config.claudePricing 的既有算法不变)。
          const inTok = rawInTok + cachedInTok;
          // v1.4-OSS 用量看板(补): cost precedence extracted into claudeCostFields (shared with the Claude sub-agent path).
          const { provider: claudeProvider, cost, currency, costTrusted } = claudeCostFields(config, rawInTok, outTok, usage.costUsd);
          appendUsageLedger({
            sessionId: session.id, engine: 'claude', provider: claudeProvider, model: config.model || '',
            inTok, outTok, cachedInTok, cost, currency, costTrusted, estimated: false, turnSeq: session.turnSeq,
          });
        } else if (billInMax > 0 || billOutMax > 0) {
          // v1.4-OSS 用量看板(补): NO result frame (Stop / idle-kill) — the turn still burned real tokens. Record a
          // conservative ESTIMATED row from the per-message billing max (与子代理兜底对称). There is no CLI cost frame
          // here, so pass NaN → claudeCostFields yields cost:null unless config.claudePricing can price the tokens.
          // P2-18: 这条估算兜底路径没有 result 帧,拿不到 cache_read/cache_creation 字段,cachedInTok 缺失按 0
          // (与上面「读+创建两项相加,缺失按 0」同一口径,费用计算同样不受影响 —— 见上面那条注释)。
          const { provider: claudeProvider, cost, currency, costTrusted } = claudeCostFields(config, billInMax, billOutMax, NaN);
          appendUsageLedger({
            sessionId: session.id, engine: 'claude', provider: claudeProvider, model: config.model || '',
            inTok: billInMax, outTok: billOutMax, cachedInTok: 0, cost, currency, costTrusted, estimated: true, turnSeq: session.turnSeq,
          });
        }
      },
    }),

  });
  // 未登记的类型同 selectedAgentCli(01) 口径归到 claude(01f normalizeAgentCliType)。
  function agentCliAdapter(type) { return AGENT_CLI_ADAPTERS[normalizeAgentCliType(type)]; }

  return { AGENT_CLI_ADAPTERS, agentCliAdapter };
}

module.exports = { createAgentCliAdapters };
