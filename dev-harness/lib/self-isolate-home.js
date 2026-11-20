'use strict';
// Set HOME before a direct fixture loads code that may read or sync user CLI settings.
const os = require('os');
const { REAL_HOME, isRealHome, fixtureHomeDir } = require('./fixture-home');

function selfIsolateHome() {
  const current = os.homedir();
  if (!isRealHome(current)) return { isolated: false, home: current };
  const home = fixtureHomeDir();
  process.env.HOME = home;
  if (!process.env.RUYI_REAL_HOME) process.env.RUYI_REAL_HOME = REAL_HOME;
  return { isolated: true, home };
}

module.exports = { selfIsolateHome, result: selfIsolateHome() };
