// ============================================================================
// 第 117 波 T2(32 号文 §5「13h-steward-runner.js 2522 行」):管家回合运行器族的注册表、
// 三条路由与两个「够不着才落在这里」的工具实现。
//
// 落点(transport 层,manifest 中位于 13q-steward-runner-turn.js 之后、14-main.js 之前)。
// T2 拆分:本文件曾 2522 行(比 T1 拆之前的 13g 还长,而 31 号文七轴的回合层改动全要往它
// 里面加)。按「谁被谁引用」拆成六个文件,拼接顺序即依赖方向,零新增前向边:
//   · 13m-steward-runner-base.js —— 六个文件都要用的共享面:落盘面常量、回合层数值口径、
//     自理动作与到访摘要的文本表、可由 actions 执行的写工具白名单、运行时内存态
//     stewardRunnerRuntime、停机/唤醒/中止,以及管家会话单例(引擎解析 + 懒创建);
//   · 13n-steward-arbiter.js —— 116h 线程间仲裁(并发位 / 同 cwd 写锁 / 预算 / 可解释的排队 / 饥饿提升)。
//     它排在提示词之前,因为总览行与递话通道都要读它的等待原因(stewardArbiterWait);
//   · 13o-steward-runner-prompt.js —— 提示词装配(记忆块 / 线程摘要 / 递话预判 / 总览 /
//     两个分叉入口)与 {say,acts,actions,why} 输出契约解析;
//   · 13p-steward-runner-actions.js —— actions 执行与降级、116-2b 确定性自理动作、id 人话化、
//     熔断、收件箱消息装配、输入区预判归一;
//   · 13q-steward-runner-turn.js —— 回合入口 runStewardTurn、收件箱去抖驱动、到访与归档、
//     117l D2 递话通道、117l D7 线程分档落盘、acts 落定;
//   · 13h-steward-runner.js —— 两个「够不着才落在这里」的工具实现(thread_prioritize /
//     thread_stop)、三条路由、运行器状态与 StewardHooks 注册表(排在最后:注册表要引用
//     上面五个文件里的实现,排在后面才是后向边)。
// 本次拆分是【纯搬家】:所有函数体逐字节不变,新写的只有各文件的头部注释。
//
// 下面这段 116f 的横幅逐字节原样保留。它描述的是【整个 13h 族】合起来做的那件事 ——
// 里面的「本文件」如今指的是 13m/13n/13o/13p/13q/13h 这六个文件,不再只是一个文件;
// 开关红线、零入边、steward_reply 投放口径三条铁律一字未改,对整族同样成立。
// ============================================================================
// ============================================================================
// 第 116 波 116f(27 号文 §11.3「116f 回合运行器与到访」):管家回合运行器、输出契约、熔断与到访。
//
// 定位(transport 层,manifest 中位于 13g-steward.js 之后、14-main.js 之前):
//   13g 是「箱子与工具」,本文件是「回合与到访」—— 它把用户消息或收件箱事件组装成一个回合,交给既有
//   回合机器(runSessionTurn)去跑,再把模型的结构化输出解析成 {say, acts, actions, why},按【目标线程】
//   的权限执行 actions 或把它降级成一个提议按钮,最后落决策日志并把结构化结果返回给调用方。
//
// steward_reply 的投放口径(有意与回合流事件分开):它【不是】回合流事件,而是管家通道这一次请求的
//   响应载荷 —— 回合早已收尾、模型也早已说完,它是工作台【事后】按契约解析并执行完 actions 之后
//   拼出来的东西。所以运行器只把它放进返回值与 stewardRunnerRuntime.lastReply(/api/steward/state 可读),
//   由 /api/steward/message 的 SSE 壳作为流的最后一帧写出;回合过程中的既有事件(session/
//   assistant_delta/tool_use/result …)照旧原样透传给调用方的 onEvent。这样经典壳与 Preview 壳的
//   回合事件契约(112b progress-events 的双向登记表)一条都不用动 —— 那两个壳根本不接管家通道。
//
// 依赖纪律(§11.3「不得新增前向边」):
//   · 13h 只引用拼接顺序在它之前的模块符号(00/01/02/04/06b/06i/08/09/10/13e/13g …),全部后向边;
//   · 没有任何模块引用 13h 的符号 —— 09(提示词分叉)、10(预算分叉)、13g(轮询器出口/state/路由转交)
//     一律经 06i 的 StewardHooks 延迟绑定拿实现,故 13h 零入边、不进任何强连通分量;
//   · 反过来 13h 直接调 13g 的内部函数(stewardDir/stewardFail/stewardAppendDecision …)是后向边,合法。
//     13g 想复用本文件的东西则【不可以】—— 那是前向边,故总览行的装配在本文件里另写一份(用的仍是
//     06i/13g 的同一批原语与同一批事实源,不新造第二个事实源)。
//
// 开关(§3.4 红线):`stewardEnabledV1 !== true` 时本文件【零副作用】—— 不建管家会话、不起任何 timer、
// 不写任何文件;三条路由仍在(路由清册不因开关变化),一律返回 409 `steward.disabled`。
//
// 管家会话(§3.1「管家自身是 kind:'steward' 的特殊会话」):
//   固定 id `steward`(06i 的 STEWARD_SESSION_ID)、标题「如意管家」、cwd = 数据根;开关开且首次被唤醒时
//   懒创建。排除面(会话列表 / 113b 内容搜索 / 13e 投影 / 116b 收件箱)一律按会话头【原始】 kind 判定,
//   不经 sessionKind()(它会把 steward 归一成 quick_ask,拿它当身份判据等于把门拆了)。
//
// 本切片只支持 OpenAI 兼容 provider:解析到 Claude / Kimi CLI 引擎时返回稳定信封
// `steward.unsupported_engine`(116-2 候选:CLI 引擎的管家回合要另接 runClaudeTurn 的事件流与工具协议)。
// ============================================================================
const { stewardImplThreadPrioritize, stewardImplThreadStop, stewardAppendUserStop } =
  require('./backend/steward-thread-control.cjs').createStewardThreadControl({
    execution: { requestSessionExecutionStop, stewardArbiterPrioritize, stewardArbiterWait },
    sessions: { safeSessionId, stewardRawKind, stewardReadSessionHead, stewardThreadPermissionMode },
    audit: { readConfig, stewardAppendDecision, stewardBasisOf, stewardFail, stewardSanitizeText, waitReasonFor },
  });
const { stewardSanitizeAttachments } = require('./backend/steward-runner-state.cjs');

const { handleStewardApiRoutes, handleStewardRunnerApiRoutes } =
  require('./backend/steward-routes.cjs').createStewardRoutes({
    tokenOk: req => tokenOk(req), readConfig, safeSessionId, nowIso, StewardHooks, PrivacyGateway,
    STEWARD_SESSION_ID, STEWARD_PREROUTE_QUERY_MAX,
    inbox: { startStewardInbox, stopStewardInbox, stewardInboxRead, stewardInboxState: config => stewardInboxState(config) },
    memory: { stewardMemoryPanelList, stewardMemoryPanelExport, stewardMemoryPanelEdit, stewardImplMemoryVeto,
      stewardMemoryPanelRestore, stewardMemoryPanelClear, stewardDecisionsRead },
    runner: { stewardArbiterState, stewardImplThreadPrioritize, stewardResetConversation, stewardVisit, stewardRunAct,
      ensureStewardSession, stewardSanitizeAttachments, runStewardTurn: opts => runStewardTurn(opts) },
    delivery: { stewardDeliveryProjection, stewardDeliveryInspect, loadSession, readFilePreview },
  });

const stewardRunnerState = require('./backend/steward-runner-state.cjs').createStewardRunnerState({
  STEWARD_TURN_DAY_MS, STEWARD_TURN_WINDOW_MS, stewardArbiterState, stewardDayCost, stewardRunnerRuntime, stewardTurnsInWindow,
});

// 延迟绑定(与 13g 同一手法):06i 声明空命名空间,本文件在加载时填充 116f 的实现键。
// 消费者 09(提示词分叉)、10(预算分叉与摘要 prompt)、13g(轮询器出口/state/路由转交)全程只看
// StewardHooks.*,从不直接引用 13h —— 13h 因此零入边,不进任何强连通分量。
Object.assign(StewardHooks, {
  buildSystemPrompt: buildStewardSystemPrompt,
  contextBudget: stewardContextBudget,
  visitNotesPrompt: stewardVisitNotesPrompt,
  onInboxBatch: stewardOnInboxBatch,
  runnerState: stewardRunnerState,
  handleApiRoutes: handleStewardApiRoutes,
  stopRunner: stewardStopRunner,
  resumeRunner: stewardResumeRunner,
  // 116-pre(§11.3):117 壳层与其它旁路消费者经这个键调,不必知道 13h 的存在。
  preroute: stewardPreroute,
  // 116h(§3.1/§8.10)线程间仲裁。消费者:10 的回合入口(acquireTurnSlot)、13 的 /api/stop
  // (cancelQueuedTurn)、13d 的事项聚合行与 13g 的 thread_status(arbiterWait)、13 的 POST /api/config
  // (arbiterRefresh)。一律经 06i,零前向边。
  // stewardArbiterPrioritize 与 stewardArbiterState 【不】进命名空间:它们的消费者全在本文件内
  // (两条 /api/steward/arbiter* 路由、steward_thread_prioritize 实现、并进 state 的 stewardRunnerState),
  // 挂上去就是没人用的钩子(= 死代码)。
  acquireTurnSlot: stewardAcquireTurnSlot,
  arbiterWait: stewardArbiterWait,
  cancelQueuedTurn: stewardCancelQueuedTurn,
  // 121-K5:用户在界面上手按的停止也记一行决策日志(33 号文 §0 的不对称)。挂法与上一行同款,
  // 消费者只有 13 的 POST /api/stop —— 它拼在 13h 之前,经 06i 的命名空间调,零新增前向边。
  appendUserStop: stewardAppendUserStop,
  arbiterRefresh: stewardArbiterRefresh,
  // 116h 的第 21 个管家工具:实现住本文件(要直接调仲裁器原语),门控壳仍是 13g 的 stewardToolHandler。
  threadPrioritize: stewardToolHandler('steward_thread_prioritize', stewardImplThreadPrioritize),
  // 117m-A4 的第 27 个管家工具:线程级停止。住本文件的理由与 threadPrioritize 同款(要直接调仲裁器
  // 原语,且 13g 已顶到 2000 行闸);门控壳仍是 13g 的 stewardToolHandler。
  threadStop: stewardToolHandler('steward_thread_stop', stewardImplThreadStop),
  // 117l D2(§11.9):递话通道的判定与执行。实现住本文件的理由与 threadPrioritize 同款 ——
  // 它要同时够到 04 的三张待决内存表、13b 的 steerSessionCore、13d 的 decideIntervention 与
  // 09 的 activeChildren,而 13g 在 13b/13d 之后、13h 之前,由 13h 来当这个汇合点边最少。
  // 消费者:13g 的 steward_thread_continue(经 StewardHooks,零前向边)与本文件的 /api/steward/relay。
  // 117s-G(27 号文 §11.13.1 ②):stewardRelayChannelFor 现在【也】上命名空间 —— 它有了第一个
  // 13h 之外的消费者:13d 的 GET /api/sessions/:id 要把「这条线程此刻该走哪条通道」下发给经典壳
  // (前端此前只认 activeTurns = 本页自己起的流,别处起的回合一律判成空闲,一发消息就把它顶掉)。
  // 判定仍然只有这一份:13d 不重编第二条阶梯,只把结果投影成 relay:{channel,wait}。挂法与 arbiterWait
  // 同款(13d -> 06i 是后向边,零新增前向边)。上一版那条「消费者全在 13h 内部,挂上去就是死代码」的
  // 理由随第一个外部消费者出现而失效 —— 纪律没变,变的是事实。
  relayChannel: stewardRelayChannelFor,
  relayDeliver: stewardRelayDeliver,
  // 129g:此刻【正在跑的那个管家回合】是谁触发的('user' | 'inbox' | '')。
  // 为什么要有这一口:管家工具有两条调用面 —— ① 模型在回合的工具循环里直接调(09-workflow 造的
  // ctx 是 {sessionId,turnSeq,session,config,workingDir,signal},**没有 trigger**);② 13p 的自理层
  // 与 /api/steward/act 显式带 trigger。于是 stewardTriggerOf(ctx) 在【第一条面上恒为空串】,
  // 而 stewardUnattendedByModel 恒为 false —— 无人值守回合里模型直接调 steward_thread_continue,
  // 自理清单闸与目标线程权限闸**一道都不过**,拿到的是「用户就在跟前」的直递待遇。
  // (既有 e2e 全部手工往 ctx 里塞 trigger,所以这个缺口一直没被照到。)
  // 补法放在 13g 的 stewardToolHandler 一处(42 个工具的唯一咽喉),它经本口取真值;
  // inflight 在回合本体开跑【前】同步认领、收尾时清空,所以工具循环期间它就是当前回合的那一个。
  currentTurnTrigger: () => (stewardRunnerRuntime.inflight ? String(stewardRunnerRuntime.inflight.kind || '') : ''),
  currentTurnContext: () => {
    const entry = stewardRunnerRuntime.inflight;
    return entry ? { trigger: String(entry.kind || ''), ...(entry.kind === 'external' ? { externalActor: entry.externalActor } : {}) } : null;
  },
  // 117l D7:同理住 13h —— 它要 02 的 normalizeSessionEngineRoute 与 04 的 logEvent,06i 够不着那两个。
  applyThreadTier: stewardApplyThreadTier,
});

SessionExecutionHooks.cancelQueuedTurn = stewardCancelQueuedTurn;
SessionExecutionHooks.revokeGrants = sessionId => revokeAllGrants(sessionId, 'explicit-stop');
