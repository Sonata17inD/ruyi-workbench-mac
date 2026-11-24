// Compose shared session admission and background wake above the execution engines.
const SessionTurnRuntime = require('./backend/session-turn-runtime.cjs').createSessionTurnRuntime({
  readConfig, safeSessionId, makeId, nowIso, logEvent,
  sessions: { createSession, loadSession, rememberLastUsedEngineRoute, sessionMessagesDelta, sessionMessagesStamp, sessionMissionId, sessionTodosSignature, updateSessionMeta },
  routing: { configForSessionEngineRoute, inferSessionEngineRoute, normalizeSessionEngineRoute, sessionEngineRouteFromConfig, sessionEngineRouteScopeOverrides },
  execution: { activeChildren, turnSettlers, turnOutcomePending, driverAutoSessions, assertSessionExecutionOwner, recordSessionExecutionOwner, requestSessionExecutionStop, sessionExecutionSnapshot, stopSession, SessionExecutionHooks, DesktopExecutionHooks },
  engines: { runOpenAiTurn, runClaudeTurn, runCodexTurn, runProviderCompact, maybeWriteThreadBrief, settleThreadBrief },
  mission: { runMissionDriver, bindDriverRun, endDriverRun, revokeGrantsForRun },
  steward: { STEWARD_SESSION_ID, StewardHooks, stewardTaintToolCall, stewardWatchedThread },
  EventStreamHooks, PrivacyCore, PrivacyGateway,
});
const { runSessionTurn, runProviderCompactTracked, scheduleAgentWakesAtBoot } = SessionTurnRuntime;
