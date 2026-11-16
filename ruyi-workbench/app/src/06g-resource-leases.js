// Resource scheduling is an explicit service; lease state is private to this runtime.
const { normalizeAgentResource, normalizeAgentResources, remapAgentResources, agentResourcesConflict, inferToolResources, acquireResourceLease, releaseResourceLease, resourceBlockers, bridgedDesktopLeaseMode } = require('./backend/resource-leases.cjs').createResourceLeases({
  makeId, nowIso, pathWithinRoot, collectBridgedWriteTargets,
});
