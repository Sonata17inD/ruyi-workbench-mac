const DesktopShell = require('./backend/desktop-shell.cjs').createDesktopShell({
  ProcessRuntime, killChildTree, spawnDetachedChecked, platformOpenSpawn, platformShellEnvironment,
});
