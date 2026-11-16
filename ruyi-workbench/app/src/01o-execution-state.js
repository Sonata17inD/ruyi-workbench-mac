// One execution state per host; lifecycle services own the entries, never replace the maps.
const { sessionWriteChains, activeChildren, turnSettlers, pendingPermissions, pendingQuestions, pendingPlans, activeAgentRuns } = require('./backend/execution-state.cjs').createExecutionState();
