'use strict';
// The runner passes the original home separately so fixtures can detect accidental writes to it.
const fs = require('fs');
const os = require('os');
const path = require('path');

const GUARD_FILE = path.join(__dirname, 'fixture-home-guard.js');

function normalizeHome(homePath) {
  return typeof homePath === 'string' && homePath ? path.resolve(homePath) : '';
}

const DECLARED_REAL_HOME = normalizeHome(process.env.RUYI_REAL_HOME);
const REAL_HOME = DECLARED_REAL_HOME || normalizeHome(os.homedir());
const REAL_HOME_SOURCE = DECLARED_REAL_HOME ? 'RUYI_REAL_HOME(run-all 注入)' : 'os.homedir()(未注入,直跑)';

function isRealHome(homePath) {
  const n = normalizeHome(homePath);
  return !!n && n === REAL_HOME;
}

// 「非真机家」= 有个家目录,且它不是真机家。
function isFakeHome(homePath) {
  const n = normalizeHome(homePath);
  return !!n && n !== REAL_HOME;
}

let cachedFixtureHome = '';
function fixtureHomeDir() {
  if (!cachedFixtureHome) cachedFixtureHome = fixtureHomeDirPerTest();
  return cachedFixtureHome;
}

function fixtureHomeDirPerTest() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-e2e-home-'));
}

function fixtureChildEnv({ perTest = false, baseEnv = process.env } = {}) {
  const home = perTest ? fixtureHomeDirPerTest() : fixtureHomeDir();
  const env = { ...baseEnv, HOME: home, RUYI_REAL_HOME: REAL_HOME };
  return perTest ? { env, home } : env;
}

module.exports = {
  GUARD_FILE,
  REAL_HOME,
  REAL_HOME_SOURCE,
  normalizeHome,
  isRealHome,
  isFakeHome,
  fixtureHomeDir,
  fixtureHomeDirPerTest,
  fixtureChildEnv,
};
