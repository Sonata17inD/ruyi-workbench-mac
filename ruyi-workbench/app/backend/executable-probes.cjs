'use strict';

function createExecutableProbes({ ProcessRuntime }) {
  function spawnProbeSync(command, args, options = {}) {
    const result = ProcessRuntime.probeSync(command, args, options);
    if (result.cleanupIncomplete) throw Object.assign(result.error, { cleanupIncomplete: true, cleanupScope: result.cleanupScope,
      cleanupEscapeCoverage: result.cleanupEscapeCoverage, cleanupUnconfirmed: result.cleanupUnconfirmed });
    return result;
  }
  function spawnProbeAsync(command, args, options = {}, timeout = 4000) {
    return ProcessRuntime.probe(command, args, options, timeout);
  }
  function existsExecutable(command) {
    if (!command) return false;
    const result = spawnProbeSync(command, ['--version'], { stdio: 'ignore', timeout: 6000 });
    return !result.error && result.status !== null;
  }
  async function existsExecutableAsync(command) {
    if (!command) return false;
    const result = await spawnProbeAsync(command, ['--version'], {}, 6000);
    return !result.error;
  }

  // v1.0-S4: `gitCli` capability — is `git` installed & runnable? Probes `git --version` (execFile, 3s), result
  // cached ~60s (its own cache, so getCapabilities' 60s matrix cache and this stay in step without coupling).
  // Feeds the capability matrix's `gitCli` boolean → TOOL_REQUIRES filters the four git tools when git is absent.
  let _gitCliProbe = null; // { at, value }
  const GITCLI_CACHE_MS = 60000;
  async function probeGitCliAsync() {   // 128f-⑬:能力矩阵过期重算时用(同一张 60 s 记忆表,判据逐字相同)
    const now = Date.now();
    if (_gitCliProbe && (now - _gitCliProbe.at) < GITCLI_CACHE_MS) return _gitCliProbe.value;
    const result = await spawnProbeAsync('git', ['--version'], {}, 3000);
    const value = !result.error && result.status === 0;
    _gitCliProbe = { at: Date.now(), value };
    return value;
  }
  function probeGitCli() {
    const now = Date.now();
    if (_gitCliProbe && (now - _gitCliProbe.at) < GITCLI_CACHE_MS) return _gitCliProbe.value;
    let value = false;
    try {
      const result = spawnProbeSync('git', ['--version'], { stdio: 'ignore', timeout: 3000 });
      value = !result.error && result.status === 0;
    } catch (error) { if (error.cleanupIncomplete) throw error; value = false; }
    _gitCliProbe = { at: now, value };
    return value;
  }

  return { spawnProbeSync, spawnProbeAsync, existsExecutable, existsExecutableAsync, probeGitCli, probeGitCliAsync };
}

module.exports = { createExecutableProbes };
