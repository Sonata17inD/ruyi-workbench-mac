'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const headlessBrowserArgs = Object.freeze([
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--use-mock-keychain', '--password-store=basic',
]);

function findBrowserExecutable() {
  const explicit = process.env.RUYI_E2E_BROWSER;
  const binary = 'Google Chrome.app/Contents/MacOS/Google Chrome';
  const candidates = explicit ? [explicit] : [
    path.join('/Applications', binary),
    path.join(os.homedir(), 'Applications', binary),
  ];
  return candidates.find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
    catch { return false; }
  }) || '';
}

module.exports = { findBrowserExecutable, headlessBrowserArgs };
