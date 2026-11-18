// Deletion coordinates live turns with the session store and shared tombstone state.
const { deleteSession, bulkDeleteUnpinnedSessions, removeSessionToolImages } = require('./backend/session-deletion.cjs').createSessionDeletion({
  paths, assertSessionIdForPath, safeSessionId, logEvent, markSessionDeleted,
  files: { sessionPath, sessionBodyPaths, interventionFilePath, missionChangeFilePath,
    removeSessionNotes, sessionScratchpadPath, journalDir, agentRunDir },
  pendingWrites: { sessionWriteChains, sessionScratchpadChains },
  execution: {
    stop: stopSession, activeRuns: () => activeAgentRuns.values(), stopRuns: stopMissionAgentRuns,
    settler: id => turnSettlers.get(id), isActive: id => activeChildren.has(id),
    revokeGrants: revokeAllGrants,
    flushRuns: AgentRunStore.flushSessionAgentRuns,
  },
  membership: { readHead: readMissionSessionHead, ownerOf: sessionMissionId, remove: missionIndexRemove },
  index: { list: listSessions, remove: id => scheduleSessionIndexUpdate(id, SESSION_TOMBSTONE) },
  invalidateSessionState: id => {
    dropSessionBodyState(id); SessionPersistence.invalidateReads(id);
    dropSessionTitleOverride(id); sessionEngineRouteOverrides.delete(id); sessionEngineRouteScopeOverrides.delete(id);
    sessionPermissionModeOverrides.delete(id); sessionDesktopToolsOverrides.delete(id); dropInterventionSessionState(id);
  },
  events: RUYI_EVENTS,
});
