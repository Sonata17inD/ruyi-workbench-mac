const applyConfigPatch = require('./backend/config-patch.cjs').createConfigPatch({
  policy: {
    PERMISSION_MODES_REQUIRING_CONFIRM, maskedSecretConflictMessage, maskedSecretConflicts, unmaskSecrets,
  },
  storage: { mutateConfig, paths, logEvent },
  hooks: { StewardHooks, ToolboxHooks },
  cli: {
    invalidateAgentCliPathCaches, rememberLastUsedEngineRoute, sessionEngineRouteFromConfig,
    syncAgentCliMcpManifests, syncAgentRolesToClaude, syncClaudeCliSettings,
  },
  mcp: { invalidateMcpRuntime, syncMcpServersToClaude },
});

ConfigPatchHooks.applyConfigPatch = applyConfigPatch;
