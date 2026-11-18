'use strict';

function createAgentCliAdapters({ cli, claude, kimi, tools, usage }) {
  const { AGENT_CLI_TYPES, normalizeAgentCliType, prepareAgentCliSpawn } = cli;
  const {
    CLAUDE_PERMISSION_MODE_MAP, RUYI_MCP_CLI_TOOL_PREFIX, buildClaudeAgentDefinitions, claudeCostFields,
    discoverModels, effectiveAnthropicEnv, isClaudeResumeMissingError, offlineModelList, parseClaudeEvent,
  } = claude;
  const {
    applyKimiStatusToSession, discoverKimiModels, kimiContextWindow, kimiModelList, kimiSessionStatus,
    kimiUsageFromStatus, parseKimiStreamJsonEvent, runKimiAcpTurnPrepared, runKimiCompact,
    syncKimiSessionUsage, syncKimiTurnPreferences, syncMcpServersToKimi, watchKimiWire,
  } = kimi;
  const { classifyToolPacks, generateSessionMcpConfig, sessionDesktopToolsOf } = tools;
  const { appendUsageLedger } = usage;

  // ============================================================================
  // 架构还债批 3 A:Agent CLI 适配器。runClaudeTurn 是 Claude Code 与 Kimi Code 两个命令行引擎共用的唯一回合骨架;
  // 凡是「这一家 CLI 怎么做」的决定(命令行参数、续接旗标、子进程环境、事件解析、回合后用量、原生子代理……)
  // 都问这里的适配器,骨架本身不再写 `agentCliType === 'claude' | 'kimi'`。加第三个 CLI = 在这张表里加一项
  // (再在 01f AGENT_CLI_TYPES 登记标签/路径键/装机候选/起进程),骨架不用动。两个适配器的方法集必须逐项相同
  // (unit/agent-cli-adapters.test.js 钉着方法集与各方法的金样输出)。
  // 架构还债批 4:05 之后的模块(05b 回合前自动压缩、10 上下文窗口、13 模型清单与手动压缩)按 CLI 类型
  // 的决定也收成这里的能力成员(下面「回合外能力」一段),各处经 agentCliAdapter(type) 取,不再与 'kimi' 字面量比较。
  //
  // 接口(ctx 形状见各方法;可选钩子取 null 表示「这一家没有这一步」,骨架据此跳过而不是空跑一次 await):
  //   id                              与 AGENT_CLI_TYPES 的键相同
  //   interactive(config)             是否走 stream-json 持续输入(stdin 保持打开,可插话/答题)
  //   slashCommandVerbatim            斜杠命令是否必须原样作为首个输入块(不拼恢复历史/索引/记忆)
  //   buildArgs(ctx)            async 回合主参数(续接/--add-dir/额外参数之外的全部;可能落盘 MCP 配置)
  //   resumeArgs(nativeSessionId)     续接原生会话的参数
  //   extraArgs(config)               用户配置的额外 CLI 参数(排在尾部参数最后)
  //   appendSystemPromptFlag          追加系统提示的命令行旗标;'' = 改走 stdin 的 <ruyi-agent-cli-instructions> 段
  //   runPreparedTurn(context)        null | 自有传输层接管本回合(Kimi = ACP,见 05b);fake 缝下不接管
  //   buildAgentDefinitions(cwd, config, budget)  async 原生子代理角色定义 { definitions, roles, omitted }
  //   buildEnv(config, common)        子进程环境(common = 骨架共有的那几项,插在 CLI 自己的覆盖项之前)
  //   beforeSpawn(config, onEvent)    null | async 起进程前把配置同步给 CLI 自己的设置文件
  //   thinkingEffortLabel(config)     meta 事件里的思考强度显示值
  //   watchSideChannel(session, onEvent)  回合期间旁路观察(返回停止函数;Kimi = wire 日志里的压缩/子代理事件)
  //   promptViaStdin                  非交互模式下提示词是否从 stdin 一次写入
  //   isNativeAgentTool(name)         该工具调用是否走原生子代理续跑协议
  //   parseEvent(evt)                 一行 stdout JSON → 内部事件表(init/text/thinking/tool_use/…)
  //   isResumeMissingError(stderr)    非零退出且 stderr 表明续接目标丢失 → 去掉续接自动重试一次
  //   syncPostTurnUsage(session, config, onEvent)  null | async 回合后向 CLI 取权威用量(替换流内用量)
  //   recordTurnUsage(ctx)            回合用量记账(月度用量看板)
  // 回合外能力(05 之后的模块经 agentCliAdapter(type) 取):
  //   nativeAskUserQuestion           原生提问工具经协议落到如意的提问卡(环境说明据此不再教它走 MCP 提问)
  //   modelCatalog.offline(config)    设置页模型下拉的即时离线清单(/api/status)
  //   modelCatalog.discover(config) async  /api/models 的整份应答(向 CLI 或端点现取)
  //   contextStatus                   null | CLI 自己报上下文占用:probeWindow(config, model) async 窗口探测(10)、
  //                                   read(config, session) async 读原生会话状态、apply(session, status) 落到会话并返回用量行、
  //                                   usage(status) 状态 → 用量行(05b 回合前自动压缩)
  //   nativeCompact                   null | CLI 原生压缩:mode(压缩事件的 mode 名)、run(sessionId, config, trigger, onEvent) async
  //                                   (05b 回合前自动压缩、13 /api/agent/compact 手动压缩;null = 只能走外部摘要重播)
  // ============================================================================
  const AGENT_CLI_ADAPTERS = Object.freeze({
    claude: Object.freeze({
      id: 'claude',
      interactive: AGENT_CLI_TYPES.claude.usesStreamJsonInput,
      slashCommandVerbatim: false,
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
      runPreparedTurn: null,
      buildAgentDefinitions: (workingDir, config, budget) => buildClaudeAgentDefinitions(workingDir, config, budget),
      // v1.4.4: effectiveAnthropicEnv overlays the config-driven third-party endpoint/model (modelsApiBase/
      // modelsApiKey/claudeAuthMode/model) onto process.env, so a frontend change to any of those actually
      // reaches this child instead of silently deferring to whatever the OS shell happened to export.
      buildEnv(config, common) {
        const env = { ...effectiveAnthropicEnv(config), ...common };
        if (config.thinkingBudget) env.MAX_THINKING_TOKENS = String(config.thinkingBudget);
        return env;
      },
      beforeSpawn: null,
      thinkingEffortLabel: config => config.claudeThinkingEffort || 'default',
      watchSideChannel: () => () => {},
      promptViaStdin: true,
      // Only Claude's Agent/Task tools follow the native sub-agent continuation protocol in runClaudeTurn.
      isNativeAgentTool: name => name === 'Agent' || name === 'Task',
      parseEvent: evt => parseClaudeEvent(evt),
      isResumeMissingError: stderrText => isClaudeResumeMissingError(stderrText),
      syncPostTurnUsage: null,
      // Claude 交互模式禁了原生 AskUserQuestion(--disallowedTools),提问走如意的 MCP 工具。
      nativeAskUserQuestion: AGENT_CLI_TYPES.claude.hasNativeQuestionPrompt(),
      modelCatalog: Object.freeze({
        offline: config => offlineModelList(config),
        discover: async config => ({ ok: true, engine: 'claude', agentCliType: 'claude', ...(await discoverModels(config)) }),
      }),
      // Claude 的上下文占用来自流内用量帧;没有可查询的原生状态面,也没有可从外部触发的原生压缩(用户在 CLI 里打 /compact)。
      contextStatus: null,
      nativeCompact: null,
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
    kimi: Object.freeze({
      id: 'kimi',
      interactive: AGENT_CLI_TYPES.kimi.usesStreamJsonInput,
      // Kimi ACP native slash commands must be the first content block exactly as entered.
      slashCommandVerbatim: true,
      // Kimi runs through its ACP stdio server (see 05b) rather than the legacy one-shot
      // `kimi -p --output-format stream-json` surface, so it contributes no lead arguments here.
      buildArgs: async () => [],
      resumeArgs: nativeSessionId => ['--session', nativeSessionId],
      extraArgs: () => [],
      prepareSpawn: (command, args) => prepareAgentCliSpawn('kimi', command, args),
      // ACP carries the prompt over stdin as JSON-RPC.
      appendSystemPromptFlag: '',
      runPreparedTurn: context => runKimiAcpTurnPrepared(context),
      buildAgentDefinitions: async () => ({ definitions: {}, roles: [], omitted: [] }),
      buildEnv: (config, common) => ({ ...process.env, ...common }),
      async beforeSpawn(config, onEvent) {
        if (config.includeWorkbenchMcp) await syncMcpServersToKimi(config);
        await syncKimiTurnPreferences(config).catch(error => onEvent({ type: 'stderr', text: `[Kimi 设置同步] ${(error && error.message) || error}` }));
      },
      thinkingEffortLabel: () => 'cli-managed',
      watchSideChannel: (session, onEvent) => (session.claudeSessionId
        ? watchKimiWire(session.claudeSessionId, onEvent, session.kimiContextStatus && session.kimiContextStatus.contextWindow)
        : () => {}),
      promptViaStdin: false,
      // Kimi may expose a same-named tool, but its stream-json tool lifecycle is already self-contained.
      isNativeAgentTool: () => false,
      parseEvent: evt => parseKimiStreamJsonEvent(evt),
      isResumeMissingError: () => false,
      // Kimi's stream-json result has no usage frame. Pull the session's exact post-turn occupancy and persist
      // it on the assistant row so reopening Ruyi cannot fall back to a stale Claude reading.
      syncPostTurnUsage: (session, config, onEvent) => (session.claudeSessionId ? syncKimiSessionUsage(session, config, onEvent) : Promise.resolve(null)),
      recordTurnUsage: () => {},
      // Kimi 的原生提问经 ACP 落到如意的提问卡。
      nativeAskUserQuestion: AGENT_CLI_TYPES.kimi.hasNativeQuestionPrompt(),
      // Kimi's `--model` values are aliases from `kimi provider list --json`; the offline form never lists Claude knownModels.
      modelCatalog: Object.freeze({
        offline: config => kimiModelList(config),
        async discover(config) {
          const discovered = await discoverKimiModels(config);
          return { ...discovered, engine: 'claude', agentCliType: 'kimi', proxyCount: discovered.discoveredCount || 0 };
        },
      }),
      // Kimi exposes authoritative context usage and native compaction through its local Server API (05b).
      contextStatus: Object.freeze({
        probeWindow: kimiContextWindow,
        read: (config, session) => kimiSessionStatus(config, session.claudeSessionId, session.claudeSessionModel),
        apply: (session, status) => applyKimiStatusToSession(session, status),
        usage: status => kimiUsageFromStatus(status),
      }),
      nativeCompact: Object.freeze({
        mode: 'kimi-native',
        run: (sessionId, config, trigger, onEvent) => runKimiCompact(sessionId, config, trigger, onEvent),
      }),
    }),
  });
  // 未登记的类型同 selectedAgentCli(01) 口径归到 claude(01f normalizeAgentCliType)。
  function agentCliAdapter(type) { return AGENT_CLI_ADAPTERS[normalizeAgentCliType(type)]; }

  return { AGENT_CLI_ADAPTERS, agentCliAdapter };
}

module.exports = { createAgentCliAdapters };
