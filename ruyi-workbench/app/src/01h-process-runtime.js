// Composition only: process supervision owns its state in an explicit module.
const ProcessRuntimeHooks = {};
const ProcessRuntime = require('./backend/process-runtime.cjs').createProcessRuntime({
  hooks: ProcessRuntimeHooks,
  desktopCapabilities: () => MacDesktopAutomation.capabilitySnapshot(),
  process,
});
