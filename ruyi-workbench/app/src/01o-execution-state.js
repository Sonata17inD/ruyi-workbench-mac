// One execution state per host; lifecycle services own the entries, never replace the maps.
const { createExecutionState, providerTurnQuotaKey } = require('./backend/execution-state.cjs');
const { sessionWriteChains, activeChildren, turnSettlers, pendingPermissions, pendingQuestions, pendingPlans, activeAgentRuns } = createExecutionState();
