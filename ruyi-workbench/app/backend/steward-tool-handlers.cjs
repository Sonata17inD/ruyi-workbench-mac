'use strict';

function createStewardToolHandlers({
  StewardHooks,
}) {

  // ── 116c(27 号文 §3.5/§11.3):管家工具族的 handler 登记 ────────────────────────────────────────
  // 纪律(交办单硬约束):这 17 个 handler 在本文件里【只调 StewardHooks.*】,真实实现全部住在
  // 13g-steward.js(transport 层,加载时 Object.assign(StewardHooks, {...}) 填充)。12 → 06i 是后向边;
  // 12 【不得】直接引用 13g 的任何符号(那会是前向边)。开关关 / 非管家会话的 fail-closed 二次校验
  // 在 13g 的 stewardToolHandler 统一做,本文件不重复判断(单一判定点)。
  // paths 全部为 null:管家工具面不接受也不解析任何文件路径 —— 它「动如意」,不「动世界」。
  const STEWARD_GUARD_NOTE = '116c: 管家工具只操作如意自身账面(线程/待决/班组/用量/审计/管家记忆),不接受也不触碰任何文件路径;实现在 13g,开关(stewardEnabledV1)与会话身份(kind==="steward")双重 fail-closed';
  const STEWARD_TOOL_HANDLERS = {
    threads_search: { paths: null, guardNote: '只读已有会话索引与摘要;排除管家会话', handler: async (args, ctx) => StewardHooks.threadHistorySearch(args, ctx) },
    thread_read: { paths: null, guardNote: '只读已有会话;脱敏、分页及回合预算;排除管家会话', handler: async (args, ctx) => StewardHooks.threadHistoryRead(args, ctx) },
    steward_self_status: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.selfStatus(args, ctx) },
    steward_threads_search: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.threadsSearch(args, ctx) },
    steward_thread_status: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.threadStatus(args, ctx) },
    steward_thread_read: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.threadRead(args, ctx) },
    steward_missions: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.missions(args, ctx) },
    // 129b:三张只读清单。paths: null 与同族一致(它们不碰文件系统路径参数)。
    steward_skills: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.skills(args, ctx) },
    steward_providers: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.providers(args, ctx) },
    steward_playbooks: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.playbooks(args, ctx) },
    steward_notify: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.notify(args, ctx) },
    // 129d:眼睛四件。paths: null —— 路径围栏在实现里按【工作区表】判(管家不在任何项目里,
    // 线程那套 cwd 围栏对它没有意义);敏感路径与二进制仍走 file_read 自己那道既有守卫。
    steward_web_search: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.webSearchTool(args, ctx) },
    steward_web_fetch: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.webFetchTool(args, ctx) },
    steward_file_read: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.fileReadTool(args, ctx) },
    steward_thread_artifact_read: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.artifactRead(args, ctx) },
    steward_runs_status: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.runsStatus(args, ctx) },
    steward_inbox_read: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.inboxReadTool(args, ctx) },
    steward_usage: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.usage(args, ctx) },
    steward_health: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.health(args, ctx) },
    steward_audit_tail: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.auditTail(args, ctx) },
    steward_thread_new: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.threadNew(args, ctx) },
    steward_thread_continue: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.threadContinue(args, ctx) },
    steward_thread_rename: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.threadRename(args, ctx) },
    steward_thread_workspace: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.threadWorkspace(args, ctx) },
    steward_thread_permission: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.threadPermission(args, ctx) },
    steward_thread_note: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.threadNote(args, ctx) },
    steward_thread_prioritize: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.threadPrioritize(args, ctx) },
    steward_decide: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.decide(args, ctx) },
    steward_run_action: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.runAction(args, ctx) },
    steward_thread_stop: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.threadStop(args, ctx) },  // 117m-A4
    steward_memory_write: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.memoryWrite(args, ctx) },
    steward_memory_veto: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.memoryVeto(args, ctx) },
    steward_memory_search: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.memorySearch(args, ctx) },
    // 116-2e:设置族两个 + 内容管理三个。与上面 21 个同一纪律 —— 只写一行 StewardHooks.<键>(args, ctx),
    // handler 体里零 require、零 13g 内部符号(steward-tools.static ② 的机器判据)。
    steward_config_get: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.configGet(args, ctx) },
    steward_bot_setup: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.botSetup(args, ctx) },
    steward_config_set: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.configSet(args, ctx) },
    steward_playbook_draft: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.playbookDraft(args, ctx) },
    steward_skill_toggle: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.skillToggle(args, ctx) },
    steward_quick_ask: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.quickAsk(args, ctx) },
    // 123-M2(37 号文 §3.5):定时任务六件。与上面 27 个同一纪律 —— 只写一行 StewardHooks.<键>(args, ctx),
    // handler 体里零 require、零内部符号。实现在 13t-steward-schedule.js(它排在 13s 之后,才够得着
    // 调度器的原语;门控壳仍是 13g 的 stewardToolHandler)。
    steward_schedule_create: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.scheduleCreate(args, ctx) },
    steward_schedule_list: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.scheduleList(args, ctx) },
    steward_schedule_pause: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.schedulePause(args, ctx) },
    steward_schedule_resume: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.scheduleResume(args, ctx) },
    steward_schedule_run_now: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.scheduleRunNow(args, ctx) },
    steward_schedule_delete: { paths: null, guardNote: STEWARD_GUARD_NOTE, handler: async (args, ctx) => StewardHooks.scheduleDelete(args, ctx) },
  };

  return { STEWARD_TOOL_HANDLERS };
}

module.exports = { createStewardToolHandlers };
