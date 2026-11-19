const {
  BUILTIN_AGENT_WORKFLOWS, agentWorkflowSaveProblem, buildOrchestrateHint, createAgentWorkflowCatalog,
  normalizeAgentWorkflow, normalizeWaitSpec, normalizeWorkflowLoop,
} = require('./backend/agent-workflow-catalog.cjs');
const { getAgentWorkflows, saveAgentWorkflow, deleteAgentWorkflow } = createAgentWorkflowCatalog({
  paths, atomicWriteJson,
});
