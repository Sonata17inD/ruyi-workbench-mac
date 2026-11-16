Object.assign(ToolboxHooks, require('./backend/toolbox-services.cjs').createToolboxServices({
  ProcessRuntime, killChildTree, readConfig, mutateConfig, enabledToolboxComponents, invalidateToolboxCache, scanToolboxComponents, logEvent, redact, safeJsonParse,
}));
