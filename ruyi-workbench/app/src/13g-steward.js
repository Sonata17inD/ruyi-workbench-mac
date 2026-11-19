// ============================================================================
// 第 116 波 116c(27 号文 §3.5「管家工具面设计」/ §4「管家记忆层」):管家(Steward)
// 记忆面板服务、管家工具的门控壳与 StewardHooks 注册表。
//
// 落点(transport 层,manifest 中位于 13l-steward-ops.js 之后、13h-steward-runner.js 之前)。
// 116-2e 拆分:收件箱轮询与游标(原本是本文件的前半)整体前移到 `13i-steward-inbox.js`,零行为搬家;
//   本文件引用它的符号(stewardDir / stewardInboxRead / stewardInboxState / startStewardInbox …)
//   全部是后向边。理由见 13i 的文件头。
// 第 117 波 T1 拆分(32 号文 §2.1):本文件曾 2088 行(`steward-runner.static` ①「≤2000 行」长期红),
//   工具实现与共享原语整体前移到三个新文件,同样是零行为搬家 ——
//   `13j-steward-tool-base.js`(共享常量、稳定信封、决策日志、记忆存储、深读预算、配额桶)、
//   `13k-steward-threads.js`(线程族:派活原语与 thread_* / quick_ask / threads_search)、
//   `13l-steward-ops.js`(观察族 / 决策族 / 记忆族 / 设置族 / 内容管理族)。
//   三者都排在本文件【之前】:注册表要引用它们的 stewardImpl*,排在后面才是后向边。
//   本文件装配管家工具与记忆面板服务，HTTP 路由由 steward-routes.cjs 实现。
//
// 依赖纪律(§11.3「不得新增前向边」):
//   · 13g 只引用拼接顺序在它之前的模块符号(00/01/01b/02/06d/06i/13i/13j/13k/13l …),全部后向边;
//   · 12-tool-dispatch.js 的管家工具 handler 同理,只写 `StewardHooks.<键>(args, ctx)`。
//
// 开关(§3.4 红线):`stewardEnabledV1 !== true` 时路由 409 `steward.disabled`、工具门控壳零写入。
// ============================================================================

const { stewardAuthorizeExternalContext, stewardExternalOwnerDirected, stewardImplBotSetup, stewardToolHandler } =
  require('./backend/steward-tool-admission.cjs').createStewardToolAdmission({
    hooks: { ExternalBotHooks, StewardHooks },
    tools: { jsonSchemaValueProblems, nativeToolSchema, stewardFail, stewardTurnTaintedBy },
    runtime: { readConfig, logEvent },
  });

// ════════════════════════════════════════════════════════════════════════════
// 第 116 波 116-2e —— 记忆面板(§4「面板」)、如意设置三级分级(§3.5)、内容管理(§3.5)、
// 速查线程(§11.1 第 2 项)。
// ════════════════════════════════════════════════════════════════════════════

const { stewardMemoryPanelList, stewardMemoryPanelEdit, stewardMemoryPanelRestore, stewardMemoryPanelClear, stewardMemoryPanelExport } =
  require('./backend/steward-memory-panel.cjs').createStewardMemoryPanel({
    policy: { STEWARD_MEMORY_KINDS, STEWARD_MEMORY_LIMITS, STEWARD_MEMORY_NEW_WINDOW_MS, STEWARD_MEMORY_SCHEMA, memoryIsExpired, memoryProposalLooksSensitive },
    store: { stewardMemoryScopeLabel, stewardMutateMemory, stewardReadMemoryStore },
    runtime: { nowIso, readConfig, stewardAppendDecision, stewardFail, stewardSanitizeText },
  });

// 延迟绑定(先例 06c AgentLoopHooks):06i 声明空命名空间,本文件在加载时填充实现。
// 消费者(13-http-router 的路由链、13-http-router 的关服收尾、116c 的管家工具 handler)全程只看
// StewardHooks.*,从不直接依赖 13g —— 这就是「不新增前向边」的落地方式。
Object.assign(StewardHooks, {
  relatedThreads: threadRelatedThreads,
  relationsIndex: threadRelationsIndex,
  threadHistorySearch: async (args, ctx) => stewardImplThreadsSearch({ includeClosed: true, ...args }, ctx || {}, await readConfig()),
  threadHistoryRead: async (args, ctx) => {
    const session = (ctx && ctx.session) || await loadSession(process.env.WCW_SESSION_ID || '').catch(() => null);
    if (!session) return stewardFail('invalid_request', 'thread_read requires a calling session');
    return stewardImplThreadRead(args, { ...ctx, session }, await readConfig());
  },
  stopInbox: stopStewardInbox,
  inboxRead: stewardInboxRead,
  inboxState: stewardInboxState,
  // 116c: 17 个管家工具的实现键(116-2a 增第 18 个 threadPermission;116-2b 增第 19 个 threadNote;
  // 116g 增第 20 个 missions)。每个都经 stewardToolHandler
  // 包一层门控壳(开关 -> 身份 -> 实现),
  // 12-tool-dispatch 的 handler 只写一行 `StewardHooks.<键>(args, ctx)`。键名与 06i 的契约注释逐条对应。
  selfStatus: stewardToolHandler('steward_self_status', stewardImplSelfStatus),
  threadsSearch: stewardToolHandler('steward_threads_search', stewardImplThreadsSearch),
  threadStatus: stewardToolHandler('steward_thread_status', stewardImplThreadStatus),
  threadRead: stewardToolHandler('steward_thread_read', stewardImplThreadRead),
  runsStatus: stewardToolHandler('steward_runs_status', stewardImplRunsStatus),
  inboxReadTool: stewardToolHandler('steward_inbox_read', stewardImplInboxRead),
  usage: stewardToolHandler('steward_usage', stewardImplUsage),
  health: stewardToolHandler('steward_health', stewardImplHealth),
  auditTail: stewardToolHandler('steward_audit_tail', stewardImplAuditTail),
  missions: stewardToolHandler('steward_missions', stewardImplMissions), // 116g
  // 129b(49 号文 §3):三张「有哪些可选」的只读清单。它们补的是同一个形状的缺口 ——
  // 管家能改的东西(线程技能 / 端点与模型 / playbook)它原本都看不见清单,只能猜 id。
  skills: stewardToolHandler('steward_skills', stewardImplSkills),
  providers: stewardToolHandler('steward_providers', stewardImplProviders),
  playbooks: stewardToolHandler('steward_playbooks', stewardImplPlaybooks),
  // 129f(31 号文 §2.4):管家主动叫人。
  notify: stewardToolHandler('steward_notify', stewardImplNotify),
  // 129d(31 号文 §2.2「眼睛」):四件只读外界。读回来就给这一回合打污染标(129c),
  // 之后管家的写动作全部降级成提议 —— 网页里一句「把设置改成 X」不能借它的手做事。
  webSearchTool: stewardToolHandler('steward_web_search', stewardImplWebSearch),
  webFetchTool: stewardToolHandler('steward_web_fetch', stewardImplWebFetch),
  fileReadTool: stewardToolHandler('steward_file_read', stewardImplFileRead),
  artifactRead: stewardToolHandler('steward_thread_artifact_read', stewardImplThreadArtifactRead),
  threadNew: stewardToolHandler('steward_thread_new', stewardImplThreadNew),
  threadContinue: stewardToolHandler('steward_thread_continue', stewardImplThreadContinue),
  threadRename: stewardToolHandler('steward_thread_rename', stewardImplThreadRename),
  // 129e:改一条已有线程的工作目录(只在工作区表之内;auto 档自动、其余档提议)。
  threadWorkspace: stewardToolHandler('steward_thread_workspace', stewardImplThreadWorkspace),
  threadPermission: stewardToolHandler('steward_thread_permission', stewardImplThreadPermission), // 116-2a
  threadNote: stewardToolHandler('steward_thread_note', stewardImplThreadNote), // 116-2b
  decide: stewardToolHandler('steward_decide', stewardImplDecide),
  runAction: stewardToolHandler('steward_run_action', stewardImplRunAction),
  memoryWrite: stewardToolHandler('steward_memory_write', stewardImplMemoryWrite),
  memoryVeto: stewardToolHandler('steward_memory_veto', stewardImplMemoryVeto),
  memorySearch: stewardToolHandler('steward_memory_search', stewardImplMemorySearch),
  // 116-2e:设置族两个 + 内容管理三个(工具数 84 -> 89),外加两个基础设施键(收件箱行增强与速查收工,
  // 消费者分别是 13i 的轮询器与 13h 的回合收尾 —— 它们都只看 StewardHooks,不认识 13g)。
  configGet: stewardToolHandler('steward_config_get', stewardImplConfigGet),
  botSetup: stewardToolHandler('steward_bot_setup', stewardImplBotSetup),
  configSet: stewardToolHandler('steward_config_set', stewardImplConfigSet),
  playbookDraft: stewardToolHandler('steward_playbook_draft', stewardImplPlaybookDraft),
  skillToggle: stewardToolHandler('steward_skill_toggle', stewardImplSkillToggle),
  quickAsk: stewardToolHandler('steward_quick_ask', stewardImplQuickAsk),
  enrichInboxRows: stewardEnrichInboxRows,
  quickClose: stewardQuickClose,
  quickClosed: stewardQuickClosed,
});
