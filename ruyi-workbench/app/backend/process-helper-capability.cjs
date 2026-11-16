'use strict';
const childProcessModule = require('node:child_process');
const filesystemModule = require('node:fs');

function createProcessHelperCapability({ hooks: ProcessRuntimeHooks, process = globalThis.process }) {
  let helperProbe = null;
  let helperProbeInflight = null;

  function helperProbeRequest(metadata) {
    const state = { supported: process.platform === 'darwin', installed: false, authorization: 'not_required',
      ready: false, reasonCode: 'platform.unsupported', code: 'process_helper_unavailable', escapeCoverage: 'observed-only' };
    if (!state.supported) return { state: Object.freeze(state) };
    const helper = metadata ? metadata.helper : ProcessRuntimeHooks.helperPath();
    let stamp;
    try {
      if (metadata?.error) throw metadata.error;
      const stat = metadata ? metadata.stat : filesystemModule.statSync(helper, { bigint: true });
      state.installed = stat.isFile();
      if (!state.installed) throw new Error('Helper is not a regular file');
      if (!metadata) filesystemModule.accessSync(helper, filesystemModule.constants.X_OK);
      stamp = [helper, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join('|');
    } catch (error) {
      helperProbe = null;
      state.reasonCode = error.code === 'ENOENT' ? 'platform.dependency_missing' : 'platform.dependency_unavailable';
      state.code = error.code === 'ENOENT' ? 'process_helper_missing' : 'process_helper_unavailable';
      return { state: Object.freeze(state) };
    }
    if (helperProbe && helperProbe.stamp === stamp) {
      return { helper, stamp, state: helperProbe.state, cached: true };
    }
    return { helper, stamp, state };
  }

  async function helperProbeRequestAsync() {
    const helper = ProcessRuntimeHooks.helperPath();
    try {
      const stat = await filesystemModule.promises.stat(helper, { bigint: true });
      await filesystemModule.promises.access(helper, filesystemModule.constants.X_OK);
      return helperProbeRequest({ helper, stat });
    } catch (error) { return helperProbeRequest({ helper, error }); }
  }

  function publishHelperProbe(request, probe, checkedRequest) {
    const { state, stamp } = request;
    let report = null;
    try { report = JSON.parse(probe.stdout); } catch { /* Invalid reports remain unavailable. */ }
    const valid = !probe.error && probe.status === 0 && report && report.protocolVersion === 3
      && report.guardian === true && report.supervise === true && report.privateFd === true && report.identityCleanup === true
      && report.escapeCoverage === 'observed-only';
    const unchanged = (checkedRequest || helperProbeRequest()).stamp === stamp;
    state.ready = !!valid && unchanged;
    state.reasonCode = valid ? null : probe.error ? 'platform.dependency_unavailable' : 'platform.dependency_incompatible';
    state.code = valid ? null : probe.error ? 'process_helper_unavailable' : 'process_helper_incompatible';
    state.protocolVersion = valid ? 3 : null;
    state.deadline = !!valid && report.deadline === true;
    if (!unchanged) { state.reasonCode = 'platform.dependency_changed'; state.code = 'process_helper_unavailable'; }
    const frozen = Object.freeze(state);
    helperProbe = state.ready ? { stamp, state: frozen } : null;
    return frozen;
  }

  function helperCapability() {
    const request = helperProbeRequest();
    if (!request.stamp || request.cached) return request.state;
    // Explicit synchronous CLI/bootstrap probes only; managed admission is asynchronous.
    const probe = childProcessModule.spawnSync(request.helper, ['--capabilities'], {
      encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return publishHelperProbe(request, probe);
  }

  async function helperCapabilityAsync() {
    const request = await helperProbeRequestAsync();
    if (!request.stamp || request.cached) return Promise.resolve(request.state);
    if (helperProbeInflight && helperProbeInflight.stamp === request.stamp) return helperProbeInflight.promise;
    const pending = { stamp: request.stamp };
    pending.promise = new Promise((resolve, reject) => {
      childProcessModule.execFile(request.helper, ['--capabilities'], {
        encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 4096,
      }, async (error, stdout) => {
        let checked;
        try { checked = await helperProbeRequestAsync(); } catch (failure) { reject(failure); return; }
        const exited = error && typeof error.code === 'number';
        resolve(publishHelperProbe(request, { error: exited ? null : error, stdout, status: exited ? error.code : error ? null : 0 }, checked));
      });
    }).finally(() => { if (helperProbeInflight === pending) helperProbeInflight = null; });
    helperProbeInflight = pending;
    return pending.promise;
  }

  function invalidate() { helperProbe = null; }
  return { sync: helperCapability, async: helperCapabilityAsync, invalidate };
}

module.exports = { createProcessHelperCapability };
