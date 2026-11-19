// Composition only: process supervision owns its state in an explicit module.
const processHelperPath = () => path.join(externalRoot(), 'runtime', 'macos', 'ruyi-process-helper');
const ProcessRuntimeHooks = { helperPath: processHelperPath };
const ProcessRuntime = require('./backend/process-runtime.cjs').createProcessRuntime({
  hooks: ProcessRuntimeHooks,
  desktopCapabilities: () => MacDesktopAutomation.capabilitySnapshot(),
  process,
});

const { killChildTree, killPosixChildTree } = require('./backend/mac-child-cleanup.cjs').createMacChildCleanup({
  ProcessRuntime, helperPath: processHelperPath, process,
});
ProcessRuntimeHooks.stopUnsupervised = killChildTree;

const DesktopShell = require('./backend/desktop-shell.cjs').createDesktopShell({
  ProcessRuntime, killChildTree, spawnDetachedChecked,
});

const GitRuntime = require('./backend/git-runtime.cjs').createGitRuntime({ ProcessRuntime, killChildTree });
const { runGit, gitReadOnlyGuard } = GitRuntime;

const RgProbe = require('./backend/rg-probe.cjs').createRgProbe({
  ProcessRuntime, vendorBinDir: ruyiVendorBinDir, pathBeforeVendor: RUYI_PATH_BEFORE_VENDOR,
});
let { probeRgAsync, probeRgInfoSync, peekRgProbe, probeRg, hasRg, hasRgAsync, rgProbeCandidates } = RgProbe;

const { spawnProbeSync, spawnProbeAsync, existsExecutable, existsExecutableAsync, probeGitCli, probeGitCliAsync } = require('./backend/executable-probes.cjs').createExecutableProbes({ ProcessRuntime });
