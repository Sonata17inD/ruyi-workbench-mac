const { auditBridgedWriteCoverage, OFFICE_WRITER_LIB_RE, bridgedOfficeScriptGate } = require('./backend/bridged-tool-guards.cjs');

const { cwdWarning, resolveWorkspace } = require('./backend/workspace-discovery.cjs').createWorkspaceDiscovery({
  paths: { samePathKey },
});

const {
  fileAllowedRoots, workspaceWriteRoots, resolveContainmentPath, realpathForContainment, guardWorkspacePath,
  providerIsLocal, remoteUncDenialResolved, UNC_DENIED_ERROR, guardFileToolPath,
} = require('./backend/workspace-file-policy.cjs').createWorkspaceFilePolicy({
  locations: {
    agentCliHomes, dataRoot, ensureDataRootReal, externalRoot: () => externalRoot(), mcpDropInDirs,
    toolboxComponentsDir,
  },
  policy: {
    AUTOEXEC_DENYLIST, isSensitiveDataPath, isSensitiveHardlinkAlias, isSensitiveHardlinkStat,
    sensitiveDataRoots,
  },
  paths: { samePathKey },
  config: { activeOpenAiProvider, logEvent, readConfig },
});

const { bridgedReadPathGate, resolveExecCwd, guardWorkspaceExecute } = require('./backend/workspace-tool-policy.cjs').createWorkspaceToolPolicy({
  policy: { guardFileToolPath, realpathForContainment },
  config: { logEvent, readConfig },
});

const {
  REVEAL_OPEN_SAFE_EXTS, buildRevealSpawn, buildOpenSpawn, resolvePreferredCodeEditor, buildCodeEditorSpawn,
  launchCodeEditor, isBrowserDocumentTarget, buildBrowserOpenSpawn,
} = require('./backend/desktop-file-handoff.cjs').createDesktopFileHandoff({
  desktop: { spawnDetachedChecked },
});
