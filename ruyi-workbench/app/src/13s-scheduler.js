const SchedulerRuntime = require('./backend/scheduler-runtime.cjs').createSchedulerRuntime({
  paths, RUYI_EVENTS, readConfig, logEvent, makeId, nowIso,
  domain: { PERMISSION_MODES, STEWARD_SESSION_ID, stewardPermissionRank, missedOccurrence, nextFireAt, normalizeSchedulerTask, occurrenceKey, SCHEDULER_LIMITS, SCHEDULER_OUTCOMES, SCHEDULER_PHASES, SchedulerHooks },
  sessions: { createSession, loadSession, saveSession, updateSessionMeta },
  storage: { atomicWriteJson, repairMissionChangeTornTail },
  execution: { stopSession, StewardHooks, schedulerAskWaitSessions, runSessionTurn },
});
const { schedulerPermissionModeFor, startScheduler, stopScheduler, schedulerRuntimeSnapshot } = SchedulerRuntime;

const { handleSchedulerApiRoutes } = require('./backend/scheduler-routes.cjs').createSchedulerRoutes({
  scheduler: SchedulerRuntime, describeSchedule, normalizeSchedulerTask, SCHEDULER_LIMITS, readConfig, safeDecodeURIComponent, makeId,
});
