Object.assign(ToolboxHooks, require('./backend/toolbox-services.cjs').createToolboxServices({
  ProcessRuntime, killChildTree, readConfig, mutateConfig, registry: ToolboxRegistry, logEvent, redact, safeJsonParse,
}));
