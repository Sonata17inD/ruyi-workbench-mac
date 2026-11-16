'use strict';
// Exercise the scheduler directly with real persistence and host policy ports.
// Faults are scoped to this instance's IO, never injected by rewriting host locals.
const fs = require('node:fs/promises');
const { createSchedulerRuntime } = require('../../ruyi-workbench/app/backend/scheduler-runtime.cjs');
const { loadServerInternals } = require('./server-internals');
function createSchedulerFixture({ appendFile, writeJson } = {}) {
  const groups = {
    domain: ['PERMISSION_MODES', 'STEWARD_SESSION_ID', 'stewardPermissionRank', 'missedOccurrence', 'nextFireAt', 'normalizeSchedulerTask', 'occurrenceKey', 'SCHEDULER_LIMITS', 'SCHEDULER_OUTCOMES', 'SCHEDULER_PHASES', 'SchedulerHooks'],
    sessions: ['createSession', 'loadSession', 'saveSession', 'updateSessionMeta'],
    storage: ['atomicWriteJson', 'repairMissionChangeTornTail'],
    execution: ['stopSession', 'StewardHooks', 'schedulerAskWaitSessions', 'runSessionTurn'],
  };
  const base = ['paths', 'RUYI_EVENTS', 'readConfig', 'logEvent', 'makeId', 'nowIso'];
  const host = loadServerInternals([...base, ...Object.values(groups).flat()]);
  const ports = Object.fromEntries(base.map(key => [key, host[key]]));
  for (const [group, names] of Object.entries(groups)) ports[group] = Object.fromEntries(names.map(key => [key, host[key]]));
  if (writeJson) ports.storage.atomicWriteJson = (...args) => writeJson(host.atomicWriteJson, ...args);
  if (appendFile) ports.io = { ...fs, appendFile: (...args) => appendFile(fs.appendFile, ...args) };
  return { service: createSchedulerRuntime(ports), nextFireAt: host.nextFireAt };
}
module.exports = { createSchedulerFixture };
