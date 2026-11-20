'use strict';
const fs = require('fs'), path = require('path');

// A release probe must not inherit paths that redirect it to a real installation or another server.
function releaseEnvironment(home, data, inherited = process.env) {
  const local = path.join(home, 'Library', 'Application Support');
  const temp = path.join(home, 'tmp');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  const env = { ...inherited };
  for (const key of ['WCW_PORT', 'WCW_TOKEN', 'RUYI_TEST_SERVER_JS', 'RUYI_BUNDLED_PYTHON', 'PYTHONHOME', 'PYTHONPATH', 'NODE_OPTIONS']) delete env[key];
  return { ...env, HOME: home, TMPDIR: temp,
    RUYI_HOME: data, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    WCW_TEST_LOCAL_PROVIDER_ANCHOR: '1', ACC_INSTALL_DIR: path.join(local, 'ai-computer-control'),
    WCW_DATA_DIR: path.join(local, 'acc-data'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    RUYI_TOOLBOX_HOME: path.join(home, '.ruyi-toolbox'), WCW_CLAUDE_PROJECTS_DIR: path.join(home, '.claude', 'projects') };
}

module.exports = { releaseEnvironment };
