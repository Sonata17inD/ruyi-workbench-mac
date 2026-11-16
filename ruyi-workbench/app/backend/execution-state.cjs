'use strict';
// Per-workbench execution registries. Maps retain identity across admission, stop and final persistence.
function createExecutionState() {
  return Object.freeze({
    sessionWriteChains: new Map(),
    activeChildren: new Map(),
    turnSettlers: new Map(),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    pendingPlans: new Map(),
    activeAgentRuns: new Map(),
  });
}
module.exports = { createExecutionState };
