// Explicit authority service: grants and driver bindings stay private and ephemeral.
const { grantIssueTierInfo, resolveToolPermissionContext, normalizeGrant, consumeGrant, revokeGrant, revokeAllGrants, revokeGrantsForRun, bindDriverRun, listGrantsView, dryRunGrantFiles, installGrant, activeDriverRunOf, endDriverRun } = require('./backend/autonomy-grants.cjs').createAutonomyGrants({
  hashArgs, makeId, isSensitiveDataPath, logEvent,
});
