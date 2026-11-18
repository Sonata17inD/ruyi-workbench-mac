// Mission orchestration depends on explicit storage, checks and model contracts.
const { buildMissionPromptSection, runMissionDriver, MISSION_DIGEST_CAP } = require('./backend/mission-driver.cjs').createMissionDriver({
  storage: { saveSession, sessionObjectIsStale },
  checks: { evaluateMissionCheck, recordMissionCheckResult, maybeFinalizeMission },
  model: { missionProgressDigest, MISSION_MAX_TEXT, MISSION_STALL_LIMIT },
  normalizeCwd, neutralizeFenceTag, getPromptPack, nowIso, logEvent,
});

const {
  missionRollbackTarget, missionBudgetRemaining, missionControlView,
  waitMissionTurnSettled, missionControlFailure, missionControlCommand,
} = require('./backend/mission-control.cjs').createMissionControl({
  storage: { loadSession, saveSession, mutateSession },
  checkpoints: { journalReadIndex, rewindSession },
  execution: {
    hasActiveTurn: id => activeChildren.has(id),
    getActiveTurn: id => activeChildren.get(id),
    hasActiveRun: id => activeAgentRuns.has(id),
    getTurnSettler: id => turnSettlers.get(id),
    stopSession, stopMissionAgentRuns, listAgentRuns,
  },
  model: { normalizeMission, normalizeMissionCheck, followupAcceptanceCriterion },
  lifecycle: { buildMissionResult, archiveMissionResult },
  events: { bumpMissionChangeSeq, logEvent },
  authorization: { revokeAllGrants },
  MISSION_DEFAULT_MAX_TURNS, MISSION_MAX_MILESTONES, MISSION_MAX_TEXT, nowIso, makeId,
});
