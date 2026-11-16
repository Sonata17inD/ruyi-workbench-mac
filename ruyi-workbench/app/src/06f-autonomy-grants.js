// Explicit authority service: grants and driver bindings stay private and ephemeral.
const { grantIssueTierInfo, resolveToolPermissionContext, normalizeGrant, consumeGrant, revokeGrant, revokeAllGrants, revokeGrantsForRun, bindDriverRun, listGrantsView, dryRunGrantFiles, installGrant, activeDriverRunOf, endDriverRun } = require('./backend/autonomy-grants.cjs').createAutonomyGrants({
  hashArgs, makeId, AUTOEXEC_DENYLIST, isSensitiveDataPath, normalizeCwd, pathWithinRoot, logEvent, nativeToolTier,
  nativeTierFor: tool => Object.hasOwn(NATIVE_TOOL_TIER, tool) ? NATIVE_TOOL_TIER[tool] : null,
});
