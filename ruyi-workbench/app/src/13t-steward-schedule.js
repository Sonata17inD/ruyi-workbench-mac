const { stewardImplScheduleCreate, stewardImplScheduleList, stewardImplSchedulePause, stewardImplScheduleResume, stewardImplScheduleRunNow, stewardImplScheduleDelete, schedulerOnReminderDue, schedulerOnSchedulerNotice, schedulerCommitmentsSince, schedulerPrepareThread } = require('./backend/scheduler-steward.cjs').createSchedulerSteward({
  scheduler: SchedulerRuntime, makeId, nowIso, readConfig, safeSessionId,
  domain: { STEWARD_SESSION_ID, describeSchedule, nextFireAt, normalizeSchedulerTask, SCHEDULER_LIMITS },
  inbox: { stewardAppendInboxRows, stewardClipSummary, stewardInboxRowDedupeKeys, stewardIsoAt, stewardLoadState, stewardRuntime, stewardAppendDecision },
  workspaces: { stewardCanonWorkspacePath, stewardDeriveThreadCwd, stewardValidateCwd, stewardEnsureOpenAiRoute },
  policy: { stewardSanitizeText, stewardFail, stewardRawKind, stewardReadSessionHead, stewardUnattendedByModel, StewardHooks },
});

// ── 延迟绑定注册(先例:13g / 13h 各自往 StewardHooks 上填自己那一份)────────────────────────
// 六个工具沿 13g 的 stewardToolHandler 门控壳(开关 -> 身份 -> 实现 -> 异常兜底);12-tool-dispatch
// 的 handler 仍然只写一行 `StewardHooks.<键>(args, ctx)`,与既有 27 个逐字同型。
Object.assign(StewardHooks, {
  scheduleCreate: stewardToolHandler('steward_schedule_create', stewardImplScheduleCreate),
  scheduleList: stewardToolHandler('steward_schedule_list', stewardImplScheduleList),
  schedulePause: stewardToolHandler('steward_schedule_pause', stewardImplSchedulePause),
  scheduleResume: stewardToolHandler('steward_schedule_resume', stewardImplScheduleResume),
  scheduleRunNow: stewardToolHandler('steward_schedule_run_now', stewardImplScheduleRunNow),
  scheduleDelete: stewardToolHandler('steward_schedule_delete', stewardImplScheduleDelete),
});
// 06j 的两个旁路口(M1 只调用、不实现)在这里落地;第三个键是 13q 的承诺三项读口;
// 第四个键是 127 波 2-ter 的开线程前置(档位 + 任务自己的工作文件夹),消费者是 13s 的触发分支。
Object.assign(SchedulerHooks, {
  onReminderDue: schedulerOnReminderDue,
  onSchedulerNotice: schedulerOnSchedulerNotice,
  commitmentsSince: schedulerCommitmentsSince,
  prepareThread: schedulerPrepareThread,
});
