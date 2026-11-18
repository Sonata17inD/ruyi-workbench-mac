'use strict';

const os = require('node:os');
const path = require('node:path');

// 第 121 波 K3(34 号文 §4.1/§4.2):任务索引「最近 N 条」窗口的缺省与钳位区间。三个数只有这一份,
// defaultConfig() 与下面的清洗块都读它们(stewardPollMs 那种「默认表与清洗块各写一遍字面量」的
// 写法是本仓的旧账,新键不再复制)。判据本体在 06i 的 threadVisible —— 它只收一个算好的布尔,
// N 在 13e 建索引时用(01 拼在 06i/13e 之前,数字放这里不制造任何前向边)。
const THREAD_INDEX_RECENT_DEFAULT = 30;
const THREAD_INDEX_RECENT_MIN = 10;
const THREAD_INDEX_RECENT_MAX = 200;

function createConfigDefaults({ CONFIG_SCHEMA, VERSION, detectClaudePath, detectKimiPath }) {
  function defaultConfig() {
    return {
      configSchema: CONFIG_SCHEMA,
      // 128a(48 号文 §2):用户(或产品代用户)真正改过的键。盘上只落这些键 ＋ 簿记键 ＋ 本版不认识的键,
      // 没碰过的设置跟随产品当前默认 —— 否则装过一次的机器上每个默认值都会被冻在盘上(见 normalizeConfig 头注)。
      configExplicitKeysV1: [],
      privacyModeV1: 'off',
      privacyTechnicalV1: false,
      privacyRulesV1: [],
      privacyPolicyRecoveryRequiredV1: false,
      credentialEncryptionV1: false, // Opt-in platform-protected storage. Existing encrypted references retain their explicit enabled state.
      version: VERSION,
      agentCliType: 'claude',       // claude | kimi — native Agent CLI driver
      // 123-N2(用户 2026-09-13 真机:「新开线程会默认开 Kimi code cli,我希望改成默认上一次用的」):
      // 新线程的缺省引擎【不再写死跟全局】。'last' = 跟「上一次用的」(见 lastUsedEngineRoute),
      // 'global' = 老行为(跟 activeProvider / agentCliType / model 那三项全局设置)。默认 'last'。
      newThreadEngine: 'last',      // last | global
      // 「上一次用的引擎路由」。**只记用户自己的选择与用户自己发起的回合**(线程头切引擎 = 02 的
      // applySessionMetaPatch;工作台发起的回合 = 10 的 runSessionTurn source==='http'),管家/调度器
      // 派出去的回合一概不记 —— 那不是用户的意思表示。形状与会话头上的 engineRoute 逐字一致
      // ({engine:'openai',providerId,model} | {engine:'agent',agentCliType,model});没有记录时是 null。
      lastUsedEngineRoute: null,
      claudePath: detectClaudePath(),
      kimiPath: detectKimiPath(),
      defaultWorkspace: os.homedir(),
      // 2026-10 拍板:出厂档是「智能自动」。只管没有存过档的新配置 —— 老用户 config.json 里已有的档原样保留;
      // 「切到」智能自动 / 全自动仍要二次确认(01e PERMISSION_MODES_REQUIRING_CONFIRM),那道门防的是被悄悄放开,
      // 出厂值不是谁替用户切的。存了一个不认识的档时下面仍回落最保守的 'default',不回落到这里。
      permissionMode: 'auto',
      includeWorkbenchMcp: true,
      autoResumeClaudeSessions: true,
      model: '',
      // Universal compaction model. Empty provider/model means "follow the current engine": Claude and
      // Kimi use their native compactor, while an OpenAI-compatible provider uses its active model.
      compactProviderId: '',
      compactModel: '',
      // Conversation limits are route/model scoped; never use the selected summarizer's window here.
      contextWindowOverrides: {},
      maxTurns: '',
      extraClaudeArgs: [],
      allowCommandTools: true,
      allowDesktopTools: true,
      // --- v0.3 additions ---
      theme: 'system',   // 体验走查 #17:新装跟随系统(修前强制深色;存过 dark/light 的老用户不受影响)
      // UI language preference. `auto` is resolved to the browser language on first successful UI boot,
      // then persisted as a concrete supported locale so later launches do not unexpectedly change language.
      locale: 'auto',
      includePartialMessages: true, // real-time token streaming via --include-partial-messages
      thinkingBudget: '',           // sets MAX_THINKING_TOKENS when non-empty
      claudeThinkingEffort: '',     // '' inherits the CLI config; otherwise passed via --effort
      betaInterleavedThinking: false, // adds --betas interleaved-thinking (probe first; may be rejected by older CLI)
      mcpCommandMode: 'auto',       // Historical values are accepted; self MCP always uses Node.
      killOnDisconnect: false,      // 体验走查 #4:刷新／关窗／断网不再结束回合(待决的权限与提问留在服务端,页面回来接着等;停止走「停止」键)
      killPortOnStart: true,        // on startup, if the port is held by a STALE workbench, free it and retry
      // --- v0.4 additions (interactive engine + permission bridge) ---
      engineMode: 'interactive',    // legacy (stdin closed, safe) | interactive (stdin kept open: AskUserQuestion + permission bridge)
      permissionBridge: true,       // route tool-permission prompts to the UI via --permission-prompt-tool (needs a non-bypass permission mode)
      // 2026-09-24 用户拍板:提问/权限默认【不限时】(0)—— 一直挂着等人处理,弹窗过一会儿自己收进右下角小窗。
      // >0 为毫秒上限,到时权限按拒绝、提问按取消(老语义);定时任务派的无人值守回合另有自己的等待表(07)。
      permissionTimeoutMs: 0,       // 0 = no limit; >0 = ms before a permission prompt auto-denies
      questionTimeoutMs: 0,         // 0 = no limit; >0 = ms a request_user_input question waits (UI heartbeat extends it while open)
      // 第27f波:权限超时→存档暂停(opt-in,默认 false=保持"超时即拒杀"的安全默认,零行为变化)。开启后:无人值守(driverAuto)
      // 回合里权限弹窗超时【不再立即拒杀】,而是打检查点 + 通知 + 延长到 autonomyPauseTtlMs 的有界窗口等人决定;窗口内无决定
      // 则回落 deny(fail-closed,防通知未达时无声僵尸挂起)。改的是【超时默认路径】,故 security-sensitive、默认关。
      autonomyPauseOnTimeout: false,
      autonomyPauseTtlMs: 2700000,  // 暂停等待上界(默认 45min;clamp [5min, 6h])——超时后 fail-closed deny
      // 第29波(§29 监控与运营):增量监控总开关(默认开——纯传输优化,快照仍是唯一权威状态源;关闭则前端
      // 回到 2s 全量轮询)。autonomyAutoResume 是 boot 自动恢复(opt-in,默认 false=重启只诚实标死、零行为
      // 变化;开启后仅 auto_resumable 的 run 自动续跑,含 exec/已确认写副作用的 run 停在暂停态等人,见
      // classifyRunResumeTier)。
      monitorIncremental: true,
      autonomyAutoResume: false,
      // 第30波(编排按难度选模型):后端按 toolTier 自动为【未指定 model 的节点】兜底挑档位(read→快/edit→均衡/
      // exec→强)。默认关=零行为变化(未指定即继承)。AI 编排者【显式】设的 model 始终优先且不受此开关影响 ——
      // 本开关只管"AI 没设时后端要不要替它按 tier 挑一个"。
      agentAutoModelTiering: false,
      // v1.9 数据管家: 保留策略(专家界面「存储」页签可配)。默认保守:logs 按文件名日期保 30 天;
      // 真终态 run 的事件日志 14 天后 gzip(仍可读,体积 ÷~10);webcache 默认【不】自动清 —— v0.9-S9
      // 的设计承诺是"离线无价,旧副本仍有用",条目上限留作用户 opt-in(0=不限)。
      storagePolicy: { logsKeepDays: 30, agentRunEventsCompressDays: 14, webcacheMaxEntries: 0, engineTranscriptDays: 30 },
      turnIdleTimeoutMs: 600000,    // watchdog: kill a turn idle (no events) longer than this
      // --- v0.4.4: model list discovery ---
      knownModels: [],              // models actually selected/used — remembered so they stay in the list
      extraModels: [],              // manual entries, each "id" or "id|Label"
      discoverModelsFromProxy: true,// best-effort GET {base}/v1/models to list live models (falls back offline)
      modelsApiBase: '',            // base URL override (else ANTHROPIC_BASE_URL / ANTHROPIC_BASE env) — also
                                     // drives the ACTUAL Claude CLI child's ANTHROPIC_BASE_URL (buildClaudeCliEnv)
      modelsApiKey: '',             // auth override (else ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY env) — ditto
      claudeAuthMode: 'auto',       // 'auto' | 'bearer' (ANTHROPIC_AUTH_TOKEN, 第三方 Coding Plan 常用) | 'x-api-key'
                                     // (ANTHROPIC_API_KEY, Anthropic official) — see buildClaudeCliEnv
      // --- v0.5: multi-provider engine (native OpenAI-compatible: DeepSeek / DashScope / local vLLM/Ollama) ---
      activeProvider: '',           // '' | 'claude-cli' -> Anthropic via the claude CLI (default). Else a providers[].id -> native engine.
      providers: [],                // [{ id,label,type:'openai-compat',baseUrl,apiKey,model,models,reasoning,systemPrompt,temperature,extraHeaders }]
      // 114a(45 号文 §7): 语音识别(ASR)端点选择 —— provider id + 模型 id。两值皆非空才算「已配置」
      // (26 号文冻结边界:未配置=麦克风不可见)。纯增量 + normalizeConfig 消毒形状,CONFIG_SCHEMA 故意
      // 不 bump(45 号文 §6.1 对 26 号文的显式改判:无旧值要改写,读回空串即「未配置」)。
      asrProviderId: '',
      asrModel: '',
      // 130(51 号文):实时识别(流式小模型,边说边出字)。与上面那对同口径:两个都非空才算「已配置」;
      // 上面那对从此兼任「第二遍校正」—— 两遍都可选,各自独立。
      asrStreamProviderId: '',
      asrStreamModel: '',
      // 131b(52 号文 §5;用户 2026-09-21 拍板「加进设置里可以配置,重新设计选项方式」):句尾改错的方式与「大模型改字」用哪个端点。
      //   asrFixMode:'auto'(有整段识别就重听、再有大模型就合成 —— 评测里两者合成最好)| 'audio'(只重听)| 'llm'(只让大模型改字)| 'off'
      //   asrFixProviderId:'' = 跟随对话主端点(activeProvider;只认 OpenAI 兼容端点,claude-cli 不算);asrFixModel:'' = 该端点的缺省模型。
      asrFixMode: 'auto',
      asrFixProviderId: '',
      asrFixModel: '',
      openaiMaxToolIterations: 100, // v1.6.3: standard base budget 1..200; long turns start at 200 and may extend to hard cap 300 while progressing
      // --- v0.7d: external / desktop MCP integration ---
      // Convenience entry for the user's own ai-computer-control desktop MCP (Windows control). When
      // enabled + command empty + autodetect, detectDesktopMcp() locates it; blank command => absent => graceful.
      desktopMcp: { enabled: true, command: '', args: [], cwd: '', autodetect: true },
      // Browser target shared with ai-computer-control. `system` opens the user's configured browser and
      // continues via screenshot/UIA/OCR; Playwright-owned Chrome for Testing is an explicit `bundled` choice.
      browserAutomation: { mode: 'system', executable: '', cdpUrl: 'http://127.0.0.1:9222' },
      // Extra user-defined stdio MCP servers: [{ id,label,command,args:[],cwd,env:{},enabled }]. Capped at 10.
      externalMcpServers: [],
      // 启动时自动把本机 Claude Code(~/.claude.json 的 mcpServers)中 Ruyi 还没有的 stdio/远程条目映射进
      // externalMcpServers。默认开;关掉则完全不扫。dismissedMcpIds 记录用户已从 Ruyi 删除的 id,自动导入跳过
      // 它们(避免「删了又自动回来」的循环);用户经 import-config/apply 显式再导入会从 dismissed 移除。
      // W2 迁移中心:键名保留(存量兼容),语义扩为「启动时从本机 Agent CLI 自动导入 MCP」——
      // Claude Code(~/.claude.json)、Codex(~/.codex/config.toml)、Kimi Code(~/.kimi-code/mcp.json)三源同一开关。
      autoImportClaudeCodeMcp: true,
      dismissedMcpIds: [],
      // W2 迁移中心:启动时把本机其它 Agent CLI 的全局指令文件(~/.claude/CLAUDE.md、~/.codex/AGENTS.md、
      // ~/.kimi-code/AGENTS.md、~/.gemini/GEMINI.md)同步成工作台全局核心记忆(06d syncAgentInstructionImports)。
      // 关掉 = 启动时不再扫;迁移中心里的手动「导入」照常可用。
      importAgentInstructions: true,
      // W2 迁移中心:首启提示卡「看过了」的记账 —— 用户看过的候选键(来源:条目)。出现不在这里的新候选才再提示。
      migrationSeenKeys: [],
      // Master switch for line 2: also expose external/desktop MCP tools to the NATIVE provider tool loop
      // (bridged via an in-process MCP stdio client). Off => providers see only the workbench's own tools.
      bridgeExternalToolsToProvider: true,
      // Adaptive tool loading keeps only task-relevant schemas in the model context. `full` is the
      // compatibility escape hatch; `auto` pre-routes common packs and exposes compact discovery tools.
      toolLoadingMode: 'auto',       // auto | full
      toolCatalogCacheTtlMs: 60000,  // bridged catalog reuse; clamp 5s..10min
      // 20-T1/20-C1/20-F1 runtime-optimization slices. The master shadow flag is on by default: it evaluates
      // candidates and emits redacted comparison metrics, but never changes a tool result, history content,
      // retry, permission, or memory decision. Tool retrieval remains opt-in; the reducer/recall pair passed
      // real-history adoption gates and defaults on, with explicit false preserving the legacy behavior.
      runtimeOptimizationShadowV1: true,
      runtimeToolRetrievalV1: false,
      runtimeObservationReducerV1: true,
      // 126-111a(25 号文 §1.2): L1 蒸发的边界从「倒数第 2 条 assistant」改为【token 预算】。
      // 默认关;显式 false / 缺省 = 逐字节等价今天的 assistantsSeen===2 边界。
      runtimeEvaporateBudgetBoundaryV1: false,
      // 126-111e(25 号文 §1.2): 历史内重复读取去重 —— 同一份文件内容在受保护的尾部里躺着好几份
      // 全文时,较早那几份换成指针(指向后文那一条,并带 rawRef 可回查原件),最新一次留全文。
      // 107-T1(46 号文 §5)起【默认开】:真模型配对 A/B 里 L1 单趟释放 token +70.0%/+40.8%,
      // B 类非劣 12/12。**缺省不再等价旧行为** —— 只有【显式 false】才回到零改写;而且 schema<12
      // 的存量配置会被 normalizeConfig 里那段一次性迁移把显式 false 翻成 true(2.8.0 之后再关的不动)。
      runtimeHistoryReadDedupV1: true,
      // 126-111d(25 号文 §1.2): 摘要 prompt 双语。开关开且 locale 是 en-US 时用英文那份
      // (判据与 06b 的 getPromptPack 同一条,不另立第二套语言口径)。
      // 107-T1(46 号文 §5)起【默认开】:关臂 6/6 给英文界面发中文摘要,开臂 6/6 英文。
      // **缺省不再等价旧行为** —— 只有【显式 false】才逐字节仍是中文;schema<12 的存量配置里
      // 显式的 false 会被 normalizeConfig 那段一次性迁移翻成 true。locale=auto/zh-CN 逐字节不变。
      runtimeSummaryPromptI18nV1: true,
      // 126-111b(25 号文 §1.2): L2 尾部按【单元】保留 —— 最新一整个 user 回合放不下时,不再一条不留,
      // 而是按「assistant(tool_calls)＋其全部 tool 回复」这样的完整单元从尾部装;保留段以 assistant
      // 打头时插一条桥接 user 消息。
      // 107-T1(46 号文 §5)起【默认开】:空尾重播种 11 次 → 0 次(门 −80%,实测 −100%);
      // 代价是 L2 次数 1.83 → 3.50、摘要费用 +60%,已写进 2.8.0 发行说明。
      // **缺省不再等价旧行为** —— 只有【显式 false】才回到「装不下就 kept=[]」;schema<12 的存量
      // 配置里显式的 false 会被 normalizeConfig 那段一次性迁移翻成 true。
      runtimeReseedTailUnitsV1: true,
      // 126-111c(25 号文 §1.2): 重播种后把【最近读过的文件】有界地重附回去。默认关;
      // 显式 false / 缺省 = reseed 结果逐字节不变(零注入)。
      runtimeReseedReattachFilesV1: false,
      // 105a: observation_recall 工具外壳 —— 让模型按缩减视图内嵌的 rawRef 回读原始工具结果。
      // 仅在 runtimeObservationReducerV1 同时开启时生效(rawRef 只由 reducer 产生);真实历史门后默认开启。
      runtimeObservationRecallV1: true,
      // 105b: session-notes.md 状态外置 —— L2 摘要成功后把【已确认的决定】/【未完成事项】/
      // 【关键文件与上下文】三节确定性切出,整写到 sessions/<id>.session-notes.md 旁车副本。
      // 摘要保留叙事职责;回注上下文由 105d 的 runtimeSessionNotesInjectV1 单独把门(它自 105d 起默认开)。
      // 105b 真实历史门通过后默认开启，仍可显式关闭。
      runtimeSessionNotesV1: true,
      // 105d-A: session notes 回注 —— 开关开时每回合读一次旁车 notes,有界、非持久地贴到最后一条
      // user 消息(去重守门:历史首条 user 已含压缩摘要时跳过)。真实历史+端到端采用门通过后默认开启;
      // 显式 false = 零注入、零文件读取,完整回退到 105b 只写不回注。
      runtimeSessionNotesInjectV1: true,
      // 105d-B: session notes 增量合并 —— 开关开时 L2 成功后 read→merge→write(决定/关键文件并集
      // 去重、未完成事项以最新摘要为准),而非每次整体重写。真实历史+端到端采用门通过后默认开启;
      // 显式 false = 105b 整体重写语义逐字节不变。
      runtimeSessionNotesMergeV1: true,
      // 105c: 摘要实体确定性抽检 —— L2 摘要产出后对路径/版本/带量级数字/日期/代号做确定性抽检,
      // 缺失时给出缺失清单并【恰好一次】定向修补(不无界重试)。真实历史+DeepSeek 门通过后默认开启;
      // 显式 false 可回退到零检查、零修补、零事件的旧行为。
      runtimeSummaryEntityCheckV1: true,
      // 105e: 估算因子分桶 —— 开关开时 estimateTextTokens 先按 JSON/代码/散文分类再套桶因子
      // (json ÷2.8、code ÷3.2、text 维持 ÷3.6;CJK 各桶恒 ÷1.5),因子与阈值由
      // context-governance-rules.json 的 estimation 块持有。A/B 回放 + 夹具修复后默认开启;
      // 显式 false 回退两桶(行为逐字节不变)。EMA 校准回路(noteEstimateSample)不变。
      runtimeEstimateBucketsV1: true,
      // 105f: 摘要单发优先 —— 开关开时摘要输入预算由「窗口 × 50%」改为「窗口 − reserve」(reserve =
      // system＋摘要 prompt＋预期输出＋校准误差上界,分量在 rules 的 summary.singleShotReserve),估算 ≤
      // 单发上限(summarySingleShotMaxTokensV1)时先单发,仅当返回可识别的上下文超窗 400 才自动降级到
      // 现有 map-reduce。历史派生的 20–28K 配对模拟与 400 降级门通过后默认开启;
      // 显式 false = 45a/22-S0 现状逐字节不变。
      runtimeSummarySingleShotV1: true,
      // 105f: 单发估算上限 —— UI 三档 16K/32K/64K(默认 32K,22-S0 实测 60K 输入 p50≈45–51s,远程摘要
      // 超时 180s,64K 档贴近超时线);可按 provider/模型/引擎覆盖(summarySingleShotMaxOverridesV1),
      // sanitize 钳位 [8192, 131072]。不提供无限档,不自动改远程超时。仅 runtimeSummarySingleShotV1 开时生效。
      summarySingleShotMaxTokensV1: 32768,
      summarySingleShotMaxOverridesV1: {},
      // 105g(4.3 首项): map-reduce 全局事实表 —— 开关开且真实分块(chunks>1)时,从完整历史确定性
      // 抽取全局实体表(复用 105c 抽取器,零新增 LLM 调用),作为一条 user 消息注入每个分段摘要与
      // 各轮汇总调用,缓解跨块约束丢失。真实 history-24 配对 A/B 门通过(实体保留 18.8%→75.0%,
      // 调用数零增加)后默认开启;显式 false = 分段与汇总请求体逐字节回退现状。
      runtimeSummaryFactTableV1: true,
      // 事实表条数甜点位实验参数。超长 history-24 真实门显示 64 条在可接受成本/延迟内
      // 仍有净收益;运行时钳位 [4,64],仅在 fact-table 开启时生效。
      summaryFactTableMaxSamplesV1: 64,
      // 105h(4.3 第二项): <=4 块顺序 refine —— 用首块摘要作为累计状态,后续块逐次修订;
      // 任一步请求或五节结构校验失败,整条从原始历史回退现有 map-reduce。105 总门无净收益,默认关;
      // 显式 false = 105g 现状请求序列与请求体逐字节不变。
      runtimeSummaryRefineV1: false,
      // 106 #13a: 预算保护基础层 —— 开关开且 budgetGuardTurnTokensV1 >0 时,对每个原生回合的累计
      // token(provider 实报 usage 逐调用累加)把门:预警(达 budgetGuardWarnRatioV1 一次性提示)、
      // 预留(发起下一次模型调用前把该调用估算输入计入在途额度,花不下就不再发起)、停止新增调用
      // (触顶即结束回合,历史/进度完整保留;until-done 任务降为 supervised 等指示,不自动降模型、
      // 不激进摘要)。106 波逐项取证纪律:默认关;显式 false / 缺省 / 预算 0 = 零判定零事件。
      runtimeBudgetGuardV1: false,
      budgetGuardTurnTokensV1: 0,
      budgetGuardWarnRatioV1: 0.8,
      // 106 #13a-t: 长命令时间预算 —— 仅作用于 INTERRUPTIBLE_NATIVE_TOOLS(shell_run/script_run,
      // 已有 steer 中断与进程树回收路径,不造第二套控制器)。shadow 开关只统计「本应触发」的脱敏
      // 事件(零行为变化,上线前校准阈值用);主动开关 = 软警告(tool_progress 有界告警)+ 硬终态
      // (沿既有取消路径杀树、写合法配对 tool_result、回合继续)。两开关独立、默认关。
      runtimeToolTimeBudgetShadowV1: false,
      runtimeToolTimeBudgetV1: false,
      // 13a-t: 软警告/硬终态毫秒 —— 0 = 该级不启用;非零时 warn 钳位 [1000,3600000]、hard 钳位
      // [5000,7200000]。不动 MCP 第三方工具的既有超时契约(范围红线)。
      toolTimeBudgetWarnMsV1: 0,
      toolTimeBudgetHardMsV1: 0,
      // 13a-t 字节轴【只计数,不改写】:interruptible 工具的 stdout+stderr 超过本阈值时落一条脱敏
      // 计数事件,供校准未来的截断预算;20-C1 三个 High 阻断解除前不做任何结果引用改写。0 = 不计数。
      toolByteBudgetShadowBytesV1: 0,
      // 106 #1 G1: 易变层尾部布局(21-E4 §7.1)—— 开时 turnVolatile 从「前插历史首条 user」改为
      // 「追加当前最新 user 尾部」(与 recall/notes 注入同位)。前插布局下易变内容跨回合变化会让
      // 前缀缓存从 messages[1] 起全断(探针证实逐字节敏感、纪律差 ~9× 费用);尾部布局跨回合只
      // 追加不重写。默认关,E4 §7.3 shadow 计量 + 质量非劣验收后才谈 flip;显式 false/缺省 =
      // 请求体与现状逐字节一致。
      runtimeVolatileTailLayoutV1: false,
      // 106 #1 G2: tools schema 冻结+只追加(21-E4 §7.2)—— DeepSeek v4-pro Responses 真实 A/B
      // cached-input 提升约 23.9pp、质量 4/4，故默认开；显式 false 仍回退现状。会话首个回合冻结 schema 顺序,之后
      // tool_load/pack 重分类引入的新工具只追加尾部,既有条目不因分类变化重排或移除(探针 S5:
      // tools 计入缓存前缀,中间插入全前缀命中归零、尾部追加保留 ~77%)。catalog 缺失(MCP 离线/
      // 撤权)时保留名义位置、记 cache break 原因。显式 false = catalog 序过滤现状。
      runtimeAppendOnlyToolSchemasV1: true,
      // 106 #2a: 受限执行结果缓存(22 号文 §6.1)—— 白名单(首批仅 file_read)只读结果的按会话缓存:
      // 身份 = 工具+规范化参数+解析后绝对路径;资源版本 = mtimeMs+size(读取前后双 stat 夹逼,
      // 命中时重新 stat 比对,不一致即 miss+失效;外部写入/删除/重建/重命名由此覆盖)。权限守卫
      // 在缓存查找之前先跑,命中仍重新验权。命中结果带 cacheHit 诚实标记(不冒称重新执行);
      // 错误/中断/读写竞态结果不缓存。4×2MB 文件、12 次真实重复读取的 DeepSeek v4-flash
      // A/B 中命中 8 次、工具阶段耗时约 311ms→112ms、12/12 正确，故默认开；显式 false
      // 仍回退现状。
      runtimeExecResultCacheV1: true,
      // #2a: 每会话缓存条数上限(LRU 淘汰),钳位 [0,2000];0 = 不缓存(开关双门的第二道)。
      execResultCacheMaxEntriesV1: 200,
      runtimeFailureTelemetryV1: false,
      // 113a: 记忆召回的离线向量层（特征哈希 + TF-IDF + 余弦）与词法层的 RRF 融合。
      // 合成门实测 Recall@3 90% -> 95%（+5pp），未达 25 号预设的 +10pp 自动翻默认条件；
      // 2026-09-04 用户明确拍板默认打开（证据是正收益且无回归，门槛是自动翻牌线、不是否决线）。
      // 显式 false = 回到纯词法排序（词法层本身随走查 #8 收紧过，不再与开关引入前逐字节相同）。
      // 走查 记忆 B #7 之后的口径:向量层只当【重排器】—— 候选准入归词法层(含 ≤1 编辑距离的拼写容错),向量独有的候选要余弦 ≥ 0.25
      // 且 ≥ 0.6×向量第一名才进。修前向量一路无精度下限(余弦噪声 0.12–0.20 与真命中 0.10–0.29 重叠),16 条混合库上 12 句无关问句有 10 句
      // 被塞进无关条目,默认开的证据(Recall@3 +5pp)只量了召回没量误报。+5pp 里唯一的那一条(拼写漂移 canry→canary)现在由词法层的编辑距离拿下,
      // 所以 memory-recall-quality 里融合与词法同为 19/20;向量层在这批夹具上不再多拿召回,它的价值是并列时重排与偶发的高分补漏。
      // 是否继续默认开交给用户裁决(这里只给诚实的数字;关掉也不会丢掉任何召回)。
      runtimeMemoryVectorRecallV1: true,
      // 以下四条是记忆容量的真正治理旋钮（2026-09-04 用户：「记忆数量上限才 24…拓展到尽可能大」）。
      // 原本全是模块常量，现在可配且默认大幅抬高。成本实话：核心胶囊走【易变层】，不进前缀缓存，
      // 每一回合都按实际字数付输入 token——但它只装用户【主动标为 core】的条目，没标就不花钱，
      // 所以把天花板抬高本身是安全的，真正的闸门是字符预算。
      coreMemoryMaxItemsV1: 200,      // 核心胶囊席位数（旧常量 24）;钳位 [0, 2000]
      coreMemoryCharBudgetV1: 16000,  // 核心胶囊字符预算（旧常量 4200）;钳位 [0, 200000]
      memoryRelevanceMaxV1: 8,        // 默认检索每轮注入条数（旧常量 3）;钳位 [0, 64]
      memoryFixedSelectionMaxV1: 64,  // 会话固定选择上限（旧常量 12）;钳位 [1, 1024]
      memoryIndexCharCapV1: 6000,     // 相关记忆索引整段字符上限（旧常量 2600）;钳位 [500, 100000]
      // 113b: 会话内容搜索索引。侧栏搜索此前只能模 title/summary/cwd 三个字段的子串，
      // 搜不到正文——“我上周让它改过那个文件”这类回忆式查找完全无法完成。
      // 默认开：新能力，旧子串过滤作为回退保留；显式 false 即整条路径关闭（回到今天）。
      sessionSearchIndexV1: true,
      // 21-E0/E1: 三层调用账本(modelCallId → assistantBatchId → toolCallId)与工具经济性 shadow。
      // 只追加脱敏观测事件(model_call_started/completed、assistant_tool_batch、tool_call_completed、
      // tool_phase_completed),不改 prompt/调度/history。默认开但带采样与每回合事件上限;false 则零事件。
      toolEconomicsShadowV1: true,
      // 21-E2: 有界只读批次调度器 —— >8 纯 read 批用 worker pool 限流并发,混合批提取只读并行岛。
      // 主动开关默认 false;并发 clamp 1..8(决策点 B: 并发 = min(8, max(4, batchWidth)),≤8 保留现状全量)。
      boundedReadSchedulerV1: false,
      boundedReadConcurrencyV1: 4,
      // 21-E5: 元工具链收敛 —— tool_search 紧凑调用提示(requiredArgs/callHint/state)、todo_write 内容
      // 去重(unchanged 语义)、discoverySeq 链路关联。默认 false(行为零变化);false 时只有 E0 账本照常,
      // 不加 hint 字段、todo 重复写入照常。discoverySeq 观测字段跟随 toolEconomicsShadowV1。
      metaToolHintsV1: false,
      // 21-E3: 已执行动作的参数历史双视图 —— 完整参数只用于执行与审计(session.actionAudit),后续请求的
      // model view 投影为紧凑 action envelope(_ruyiActionRef/target/payload/status),大参数不再重复携带。
      // 默认 false(行为零变化);投影只对 status=completed 且 sha256 可校验的动作生效,失败/中断/待审批
      // 不瘦身;原始 arguments 保留在 providerHistory 原消息与 audit 中,可还原、零证据损失。
      actionArgumentModelViewV1: false,
      // v1.1-W2 (T2): auto-scan drop-in MCP connectors from <repo>/mcp/*/ruyi-mcp.json and
      // <dataRoot>/mcp/*/ruyi-mcp.json and runtime-merge them (never written to config; delete the folder to
      // uninstall). Default on. Off => only config.externalMcpServers + desktopMcp are used.
      enableMcpDropIn: true,
      // ruyi-toolbox 组件自动发现(用户 2026-09-21:「开箱即用」)。登记文件住 ~/.ruyi-toolbox/components/(04 scanToolboxComponents)。
      //   autoDiscover —— 总开关,缺省开;关掉 = 一个登记的组件都不拉起、不接入。
      //   disabled     —— 逐个停用的组件 id(停用是如意一侧的事,不删登记文件;卸载才删)。
      //   seen         —— 已经接入过的组件 id。只用来保证「自动选成语音识别端点」对每个组件【只发生一次】:
      //                   用户后来手动关掉或换走,下次启动绝不再替他选回来。
      // 这三项都【不含命令】:命令只来自磁盘上的登记文件,API 改得了的只有「接不接」。
      toolbox: { autoDiscover: true, disabled: [], seen: [] },
      // v0.8-S0: per-tool permission-tier overrides for BRIDGED (external/desktop MCP) tools, keyed by the
      // UNPREFIXED tool name. Merges over BRIDGED_TOOL_TIERS defaults. Values: 'read' | 'edit' | 'exec'.
      bridgedToolTiers: {},
      // v0.8-S2: max concurrent persistent shell sessions (shell_start). Clamped 1..8 in normalizeConfig.
      // Sessions live ONLY in the serve process (provider engine); the MCP child path returns a guiding error.
      shellSessionMax: 3,
      // v0.8-S4b B3: persistent fine-grained allow rules for NATIVE tools, {toolName:'allow'}. Consulted by
      // the provider tool loop BEFORE prompting (a gate:'ask' that matches → allow). normalizeConfig cleanses
      // this HARD: only tools whose native tier is 'read' or 'edit' survive — exec/desktop tools can NEVER be
      // persistently allowed (only session-scoped, held in the front-end). A bad entry is dropped silently.
      toolAllowRules: {},
      // v0.8-S5: auto-compaction trigger — when est(history) > autoCompactThreshold × provider.contextWindow
      // at an iteration boundary, the two-level compactor runs (evaporate → summary). Clamped 0.5..0.95.
      autoCompactThreshold: 0.8,
      // v0.8-S6: network-probe target for the capability matrix (§7.2). '' = probe the active provider's
      // baseUrl (HEAD, 3s, cached 60s). A non-empty value overrides it (useful when no provider is set, or
      // for an air-gapped intranet health endpoint). normalizeConfig trims + length-caps it.
      capabilityProbeUrl: '',
      // v0.8-S6: TEST HOOK — enable the (otherwise inert) testOnly TOOL_REQUIRES entry so the capabilities
      // e2e can exercise the requires→filter→「当前不可用」 pipeline. Default false → zero production effect.
      enableToolRequiresProbe: false,
      // v0.9-S1 (C1): UI density mode. 'pro' = full three-pane developer surface; 'simple' = the 人人可用
      // surface (debug/mcp tabs + composer advanced buttons hidden via CSS, humanized tool cards, +1px font).
      // Front-end drives it via document.documentElement[data-ui-mode]; normalizeConfig cleanses to the enum.
      uiMode: 'simple',
      // v0.9-S1 (C1): reply verbosity style, injected as a prompt style layer (buildProviderSystemPrompt).
      // 'detailed' = current behavior (no injection); 'concise' = ask the model for short, direct answers.
      outputStyle: 'detailed',
      // Skills that are available in every chat without requiring a per-session toggle. Entries keep the
      // source lock used by session.skills so a project skill cannot silently replace a resident built-in.
      // Empty by default: the UI highlights suitable built-ins, while the user decides what deserves the
      // small always-on prompt cost for their own work.
      residentSkills: [],
      // v0.9-S3 (C3): most-recently-used working folders (absolute paths, ≤10 LRU). Front-inserted on a
      // successful workspace switch (top-bar picker / folder-drag resolve). Also seeds the /api/workspace/
      // resolve candidate roots so a folder the user has worked in before is found even if it lives off the
      // drive-root/home fingerprint set. normalizeConfig cleanses to a de-duped string array truncated to 10.
      recentWorkspaces: [],
      // 118a: welcome-wizard completion record. null = never finished and never skipped (the wizard may
      // still be offered). Shape once written: { completedAt: ISO|null, version: <int>, skipped: bool }.
      // Purely additive: normalizeConfig sanitizes the shape and CONFIG_SCHEMA is deliberately NOT bumped,
      // so an older config simply reads back null and the wizard stays available.
      onboarding: null,
      // v2.7 (workspace permissions): trusted workspaces with per-workspace read/write/execute flags.
      // Priority = array order (index 0 = primary/current default). Each entry { path, read, write, execute },
      // all defaulting to true. Seeded from defaultWorkspace + recentWorkspaces on first load so existing
      // users keep full access. defaultWorkspace stays in sync with workspaces[0].path (backward compat).
      workspaces: [],
      // v2.7: escape hatch for the file-tool workspace boundary. true = the native file tools may read AND
      // write outside any configured workspace (still audit-logged; sensitive control-plane paths stay denied).
      allowOutsideWorkspace: false,
      // Sub-agent orchestration limits. maxConcurrent controls one parallel stage; maxPerTurn controls all
      // stages combined (an ad hoc spawn_agent/orchestrate_agents fan-out WITHIN one chat turn — NOT the
      // same budget as a persisted Agent 工作流 DAG's node count, see agentWorkflowMaxNodes below).
      // 0 total disables spawn_agent entirely. v1.4.4: defaults raised to the top of each clamp range
      // (subagentMaxConcurrent 1..8, subagentMaxPerTurn 0..32) — most real workflows were hitting these.
      subagentMaxConcurrent: 8,
      subagentMaxPerTurn: 32,
      // 后台代理(orchestrate_agents{background:true})跑完时主回合已经结束 → 工作台自己起一个回合把交付信封送给模型
      // (10 scheduleAgentWake)。false = 旧行为:信封等用户下一句话时才随回合开头送达。
      agentAutoWake: true,
      // 52x: 子 agent 优先端点+模型。spawn_agent/orchestrate 的 openai 节点默认用此 provider+model(可跨 provider);
      //   模型仍可经 spawn_agent.model 参数选同端点下别的模型(如 Pro 版),或 omit 继承默认。未配置 -> fallback 主 provider + provider.subagentModel。
      subagentPreferredProvider: '',
      subagentPreferredModel: '',
      // 第 116 波 116a(27 号文 §11.3):管家总开关。第 121 波 K0(34 号文 §8.4 拍板③)默认关→开:管家视角成为默认入口。
      stewardEnabledV1: true,
      // 第 116 波 116a(27 号文 §11.3):管家专用端点/模型,空值="跟随主端点"(照抄 subagentPreferredProvider/Model)。
      stewardProviderId: '',
      stewardModel: '',
      // 第 116 波 116-5a(27 号文 §11.8「线程自动摘要」):每开一条新线程自动生成一个 ≤24 字的名字与
      // 一句 ≤80 字的概括,写进会话头 threadBrief。**默认开,且【不】随 stewardEnabledV1**(用户
      // 2026-09-07 拍板,§11.8.10 第 1 条):消费面一半在经典壳(侧栏会话列表、113b 会话搜索),
      // 管家关着也该有名字。关掉 = 零调用、零字段、零记账。
      stewardThreadBriefV1: true,
      // 第 127 波 2-quater B2(45 号文 §2-quater.2 B2 / §2-quater.3 拍板 2):管家代批。「智能自动」档里线程因为命令
      // 正文命中永久豁免而停下来问时,管家在十道闸(06i stewardExemptDelegationVerdict)全过、并写下理由的前提下
      // 替用户放行。**默认开**(用户拍板),设置页可关;管家自己改不了(06i 的 forbidden 档,不是 confirm)。
      stewardExemptDelegationV1: true,
      // 第 117 波 117l(27 号文 §11.9 D7;用户 2026-09-07 走查第 7 条「设置的管家页里可以默认配置新开线程
      // 的端点和模型:一个针对复杂任务的强模型、一个简单任务的快速模型」):管家新开线程时按 tier 选端点。
      // 两档都留空 = 全部跟随全局主端点(= 116a 起的既有行为,存量用户零变化)。判定单点在 06i 的
      // stewardThreadEngineRoute;**这两个键不进 steward_config_set 白名单**(模型不能自己换模型)。
      stewardThreadModels: { strong: { providerId: '', model: '' }, fast: { providerId: '', model: '' } },
      // 第 117 波 117w-W1 提交②(27 号文 §11.19.2/§11.19.5 推荐 A):Ruyi 默认工作区【根】。
      // 管家开线程时若省略 cwd,工作台在这个根下派生一条属于那个线程自己的子工作区(<root>/<slug(标题)>)
      // 并把它登记进 workspaces[]。放 ~/Ruyi 而不是 <dataRoot>/workspace 的理由(§11.19.5):这些目录里
      // 放的是【用户的工作产物】(报告、抓下来的数据),不是 Ruyi 的运行数据 —— 用户要在资源管理器里
      // 一眼找得到。它是主目录的【子目录】,不是主目录本身,所以 03 的 cwdWarning 对它静默。
      // 围栏类键:按 06i 的 fail-closed 语义自动落 forbidden(管家改不了它,用户在设置里能改)。
      stewardWorkspaceRoot: path.join(os.homedir(), 'Ruyi'),
      // W7(用户 2026-09-24「如意自己开的工作区,默认不显示在常用工作区中,不要让用户自己感知到」):
      // 如意为任务自己开的文件夹登记在这张表里,【不再】追加进 workspaces[](那张表就是界面上的「常用工作区」,
      // 设置页与顶栏选择器都读它)。形状 [{ path, at, adopted? }]:adopted:true = 用户后来亲手把它加进了常用,
      // 从此它归用户(以用户为准,见清洗块的「收编」一支)。管家的工作区清单与 cwd 校验把两张表合起来看。
      stewardManagedWorkspaces: [],
      // 第 116 波 116a(27 号文 §11.3):管家收件箱轮询间隔(ms),clamp [5000,120000]。
      stewardPollMs: 60000,
      // 第 121 波 K3(34 号文 §4.1/§4.2「噪音用窗口解决,不用能力解决」):任务索引的「最近 N 条」窗口。
      // 一条既不在途、今天也没动静、管家也不盯的旧线程,只有排在最近 N 条里才进索引 —— 几百条存量
      // 普通会话因此不会把左栏淹掉,但它们仍在搜索里找得到。clamp [10,200],判据单点在 06i 的
      // threadVisible(三个数也定在那里:THREAD_INDEX_RECENT_DEFAULT/MIN/MAX)。
      threadIndexRecent: THREAD_INDEX_RECENT_DEFAULT,
      // 第 116 波 116a(27 号文 §11.3):管家每小时最多替用户执行的回合数,clamp [1,120]。
      // 117m-A1:12 → 30。12 是 116a 拍脑袋的保守值,真机上被「代批风暴」15 分钟吃光(见 13h
      // stewardCircuitCheck 的注释)。**不迁移存量配置** —— normalizeConfig 早已把 12 显式写进老用户的
      // config.json,静默抬高别人的花钱上限不合适;只改默认,老用户在设置·管家页自己调。
      stewardMaxTurnsPerHour: 30,
      // 第 116 波 116a(27 号文 §11.3):管家自身每日花费上限(USD),clamp [0,1000]。
      stewardMaxCostPerDay: 5,
      // 第 116 波 116a(27 号文 §11.3):管家「可以自己做的事」自理清单;resume:null=跟随 autonomyAutoResume。
      // 136(用户 2026-09-23「管家不够省心」):relay 默认 false → true —— 把用户的话递给对的线程是管家的
      // 本职,默认只提议等于每句话都多问一遍。answer(代答)仍默认关:那是唯一【替用户说话】的一格(129g)。
      // 不迁移存量:config.json 里已显式落 relay:false 的老用户原样保留(与 117m-A1 同一条纪律)。
      // continueUnfinished(用户 2026-10「像这种情况,管家要能自主让线程恢复啊」):回合正常收了、但任务没做完
      // (「上次任务未完成」横幅同一判据 / 计划还有没勾完的步骤)时,管家自己给线程续一轮;默认开,有上限(13m)。
      stewardAutoActions: { retry: true, resume: null, relay: true, newThread: true, answer: false, continueUnfinished: true },
      // 第 116 波 116a(27 号文 §11.3):一次到访内管家上下文预算(token),clamp [16000,2000000]。
      stewardContextBudgetTokens: 200000,
      // 136(同上「上下文太紧」):预算的几成触发 L2 压缩,clamp [0.3,0.95],非法回默认 0.6。
      // 大窗口模型(百万级)下 0.6 偏保守,可调高;代价是管家每回合更贵、压缩更少触发。
      // 管家自己改不了它:confirm 档(会花钱),只能递按钮等用户按;tokens 键则撞密钥正则仍 forbidden。
      stewardContextBudgetRatio: 0.6,
      // 第 116 波 116a(27 号文 §11.3):管家按需深读单次到访合计字符预算,clamp [4000,400000]。
      stewardReadBudgetChars: 48000,
      // 129f(31 号文 §2.4):管家一小时最多主动叫你几次。6 次是原文定的数 —— 一小时六次已经是
      // 「有事就说」的上限,再多就是噪音。静默时段与总开关复用既有的通知设置,不在这里另开一套。
      stewardNotifyPerHour: 6,
      // 第 116 波 116a(27 号文 §11.3):判定「一次到访」结束的静默分钟数,clamp [5,1440]。
      stewardVisitIdleMinutes: 60,
      // 第 116 波 116a(27 号文 §11.3):管家会话历史保留策略,visit|24h|forever。
      // 136(用户 2026-09-23「不记事」):默认 visit → 24h —— 「到访即忘」(60 分钟静默就整段归档清空)是
      // 「管家不像个熟人」观感的最大来源;跨到访的长期连续性仍走管家记忆库,24h 只是把【今天】留住。
      // 不迁移存量(同上一条纪律);normalizeConfig 的兜底值同步是 '24h',两处必须同一个值。
      stewardConversationRetention: '24h',
      // 136(同上「言行不够拟人」):管家人设。两键皆空 = 用 stable 层的默认自称「如意」与默认口吻。
      // 名字 ≤20 字、口吻偏好 ≤200 字(01-config 归一截断);进提示词的【易变层】(13o 的 personaBlock),
      // 不进 stable —— 用户级变量,进了稳定层就破前缀缓存纪律。free 档:改错了一眼看得见、一键清空。
      stewardPersonaName: '',
      stewardPersonaStyle: '',
      // 第 123 波 M2(37 号文 §3.5):安静卡「稍后」推迟多少分钟,clamp [1,1440]。
      // 它建的是一条【真的】 once reminder(而不是把卡藏起来),所以这个数就是「多久之后再提醒我」;
      // 上限 24 小时:再长就不该由一枚「稍后」来表达了,那是一条新的定时任务。
      quietCardSnoozeMinutes: 30,
      // 第 116 波 116h(27 号文 §3.1 116h 行 / §8.10「并发上限就地可调」;用户 2026-09-03 拍板默认 5):
      // 线程间仲裁的三个全局闸。**只在 stewardEnabledV1 开时生效**(关时 runSessionTurn 根本不问仲裁器),
      // 121 波 K0 之前总开关默认关,所以对存量用户(配置里已显式落 false)仍是纯形状扩张;新装默认开即生效。
      //   stewardMaxParallelThreads —— 同时最多几条线程在跑回合,clamp [1,32];
      //   stewardGlobalMaxTurnsPerHour —— 全部线程合计每小时可开始的回合数,clamp [1,2000];
      //   stewardGlobalMaxCostPerDay —— 全部线程合计当日花费上限(USD),clamp [0,10000],0 = 不限。
      // 与 stewardMaxTurnsPerHour / stewardMaxCostPerDay 的区别:那两个只管【管家自己】的回合与开销
      // (熔断,见 13h stewardCircuitCheck),这两个管【全部线程】(排队,不拒绝)。
      stewardMaxParallelThreads: 5,
      stewardGlobalMaxTurnsPerHour: 120,
      stewardGlobalMaxCostPerDay: 50,
      // 第 123 波 M1(37 号文 §3.2/§3.4;设计权威 29 号文 §4「开关」):定时任务调度器总开关。
      // 默认【开】,但**没有任何任务时零开销**:13s 的 startScheduler 在零任务时不起 interval,
      // 关掉(显式 false)时更是一个字节都不写 —— 不建 <data>/scheduler/ 目录、不读盘、六条路由一律 409。
      schedulerEnabledV1: true,
      // 第 123 波 M1 §3.2「无人值守的 ask」:定时任务派出去的回合遇到要人批准的动作时等多久(分钟),
      // clamp [1,240]。它【只】换掉决定窗口的长度,不改判定 —— 到时仍然是拒(29 号文 §10 红线二:
      // 无人值守遇 ask 绝不自动放行),本次记 needs_you,用户回来「立即运行」重跑。
      schedulerAskWaitMinutes: 30,
      // v1.4.4: max nodes a persisted Agent 工作流 DAG may have (both a fresh /api/agent-workflow/launch and
      // a resumed run). Previously the fresh-launch path wrongly reused subagentMaxPerTurn (a per-CHAT-TURN
      // ad hoc fan-out budget) as the DAG's node-count ceiling — a 4-node default rejected any real pipeline
      // with 5+ nodes outright, while resuming the SAME run used a hardcoded 32. 第23波起 Clamp 1..64、默认 48
      // (64 is also the hard systemic cap in runAgentWorkflow's own `.slice(0, 64)` and the orchestrate_agents
      // schema's maxItems — 第36波(v1.7) 三方对齐, 此前注释与 schema 仍写 32 是漂移)。
      agentWorkflowMaxNodes: 48,
      // Long-running model nodes receive one bounded "wrap up now" instruction after this duration. Separate
      // workflow heartbeats keep the parent turn informed while the node works. 0 disables automatic wrap-up.
      // 出厂 30 分钟(修前 8 分钟:到点催收尾、再 2 分钟墙钟一到就杀,单个子代理实际只有 10 分钟)。催收尾之后节点只在
      // 「宽限期内没有任何进展」或「总时长达到硬上限(= 本值的 2 倍)」时才被中止 —— 见 09 workflowControlTimer 的头注。
      agentNodeWrapUpMs: 1800000,
      // 团队模式 v2 (A2): 共享任务池审批策略。manual=UI 运行卡逐条批准(默认);auto-capped=自动批准直到 poolAutoCap
      // 用尽后转 manual;off=不注册 propose_task 工具。物化仍受 agentWorkflowMaxNodes(上限 64)复检(见 materializePoolItem)。
      agentTaskPoolPolicy: 'manual',
      agentTaskPoolAutoCap: 3,
      // Global role overrides/custom roles. Built-ins are merged at read time; project roles live in
      // <workspace>/.ruyi/agents.json so the same definition works with Claude CLI and OpenAI providers.
      agentRoleOverrides: [],
      // v0.9-S9 (D6): web-search backend for the web_search tool. baseUrl = the searxng/custom endpoint (an
      // admin-configured, TRUSTED endpoint — its outbound request is exempt from the SSRF check; only
      // web_fetch's model-supplied url is untrusted). apiKey goes through the SAME mask/unmask体系 as
      // providers[].apiKey (never emitted plaintext).
      // v1.1-W1a (T3): default is now 'builtin' — a ZERO-config, no-key HTML search (Bing CN → 百度 fallback)
      // so a fresh install can search out of the box without anyone applying for an API key. Users who want a
      // proper API (searxng/bing/tavily/…) still pick it in 设置. NOTE: per the T3 migration policy, a stored
      // 'none' is folded to 'builtin' on load (it was only ever the *historical* default, never an active
      // choice) — so search is ON out of the box for both fresh and upgraded installs.
      searchBackend: { type: 'builtin', baseUrl: '', apiKey: '' },
      // --- v1.4.3 additions (CLI capability alignment) ---
      appendSystemPrompt: '',       // non-empty -> --append-system-prompt flag to Claude CLI
      additionalDirectories: [],    // extra dirs passed via multiple --add-dir flags
      // v1.4-OSS 用量看板: optional soft monthly budget. null (default) = no budget. Shape {monthly:Number>0,
      // currency:'USD'|'CNY'|...}. Data-only: /api/usage/summary returns spentThisMonth so the front-end can
      // show a soft warning; the back-end never blocks a turn on it.
      usageBudget: null,
      // v1.4-OSS 用量看板: optional Claude-side pricing {inputPerM, outputPerM, currency}. When set it drives the
      // Claude ledger cost (tokens×price) for BOTH Anthropic-direct AND third-party endpoints (Ark 等) — the CLI's
      // total_cost_usd is Anthropic-priced and only a notional fallback. null (default) = fall back to that USD
      // estimate for Anthropic-direct, and tokens-only (plan-based) for a third-party endpoint.
      claudePricing: null,
    };
  }
  return defaultConfig;
}

module.exports = { createConfigDefaults, THREAD_INDEX_RECENT_DEFAULT, THREAD_INDEX_RECENT_MIN, THREAD_INDEX_RECENT_MAX };
