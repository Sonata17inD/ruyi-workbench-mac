'use strict';
const fs = require('node:fs');
const path = require('node:path');

function configureWorkbenchRuntimeEnvironment({ externalRoot, process, platformRuntimeEnvironment }) {
  // Full ships a verified CPython beside ACC. Expose it on the service PATH so
  // CLI, shell and other child processes can find the same Python and Office libraries.
  function exposeBundledPythonRuntime() {
    if (process.platform !== 'darwin') return '';
    const pythonDir = path.join(externalRoot(), 'mcp', 'ai-computer-control', 'runtime', 'python', 'bin');
    const pythonExe = path.join(pythonDir, 'python3');
    try { if (!fs.existsSync(pythonExe)) return ''; } catch { return ''; }
    const currentPath = String(process.env.PATH || process.env.Path || '');
    const pathDirs = currentPath.split(path.delimiter).filter(Boolean);
    const normalized = dir => path.resolve(dir);
    if (!pathDirs.some(dir => normalized(dir) === normalized(pythonDir))) {
      process.env.PATH = [pythonDir, ...pathDirs].join(path.delimiter);
    }
    process.env.PYTHON = pythonExe;
    process.env.PYTHONUTF8 = '1';
    // Keep the signed release runtime immutable when user scripts import source-only packages.
    process.env.PYTHONDONTWRITEBYTECODE = '1';
    if (process.platform === 'darwin') process.env.PYTHONNOUSERSITE = '1';
    process.env.RUYI_BUNDLED_PYTHON = pythonExe;
    return pythonExe;
  }

  // Finder/GUI launches have a minimal PATH. Add fixed runtime locations before vendor/probe snapshots.
  Object.assign(process.env, platformRuntimeEnvironment(process.env));
  const BUNDLED_PYTHON_RUNTIME = exposeBundledPythonRuntime();

  // 只将发行包内实际的 app/vendor-bin 目录放在 PATH 前。保留原 PATH 供
  // 能力探测区分系统 ripgrep 与随包版本。Claude Code 仍按自己的配置选用 ripgrep。
  function ruyiVendorBinDir() {
    const dir = path.join(externalRoot(), 'app', 'vendor-bin');
    try {
      const st = fs.lstatSync(dir);
      return st.isDirectory() && !st.isSymbolicLink() ? dir : '';
    } catch { return ''; }
  }
  function samePathEntry(a, b) {
    const norm = p => { const r = path.resolve(String(p || '').trim().replace(/^"|"$/g, '')); return r; };
    try { return norm(a) === norm(b); } catch { return false; }
  }
  const RUYI_PATH_BEFORE_VENDOR = String(process.env.PATH || process.env.Path || '');
  function exposeVendorBinOnPath() {
    const dir = ruyiVendorBinDir();
    if (!dir) return '';
    const rest = RUYI_PATH_BEFORE_VENDOR.split(path.delimiter).filter(entry => entry && !samePathEntry(entry, dir));
    process.env.PATH = [dir, ...rest].join(path.delimiter);
    return dir;
  }
  const RUYI_VENDOR_BIN_ON_PATH = exposeVendorBinOnPath();
  return { BUNDLED_PYTHON_RUNTIME, ruyiVendorBinDir, RUYI_PATH_BEFORE_VENDOR, RUYI_VENDOR_BIN_ON_PATH };
}

module.exports = { configureWorkbenchRuntimeEnvironment };
