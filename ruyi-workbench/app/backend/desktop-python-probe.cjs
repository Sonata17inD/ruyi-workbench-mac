'use strict';

const DESKTOP_PYTHON_PROBE_TIMEOUT_MS = 5000;
const DESKTOP_PYTHON_IMPORT_PROBE = [
  'from importlib.util import find_spec',
  'from mcp.server.fastmcp import FastMCP',
  'import ai_computer_control.server',
  "# Detect the optional Mac payload without importing its heavy dependencies.",
  "modules = ('playwright', 'pptx', 'matplotlib', 'cv2', 'numpy', 'reportlab')",
  'full = all(find_spec(name) is not None for name in modules)',
  "print('__RUYI_ACC_FULL__' if full else '__RUYI_ACC_CORE__')",
].join('\n');

function probeArgs(candidate) {
  return [...(candidate.args || []), '-X', 'utf8', '-c', DESKTOP_PYTHON_IMPORT_PROBE];
}

function probeOptions(cwd, desktopEnv) {
  return {
    cwd: cwd || undefined,
    env: { ...process.env, ...desktopEnv },
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
  };
}

function classifyProbeOutput(stdout) {
  const marker = String(stdout || '').trim().split(/\r?\n/).at(-1);
  if (marker === '__RUYI_ACC_FULL__') return 'full';
  if (marker === '__RUYI_ACC_CORE__') return 'core';
  return '';
}

function createDesktopPythonProbe(ProcessRuntime) {
  function probeDesktopPython(candidate, cwd, desktopEnv) {
    const result = ProcessRuntime.probeSync(candidate.command, probeArgs(candidate), {
      ...probeOptions(cwd, desktopEnv), timeout: DESKTOP_PYTHON_PROBE_TIMEOUT_MS,
    });
    if (result.cleanupIncomplete) {
      throw Object.assign(result.error, { cleanupIncomplete: true, cleanupScope: result.cleanupScope,
        cleanupEscapeCoverage: result.cleanupEscapeCoverage, cleanupUnconfirmed: result.cleanupUnconfirmed });
    }
    if (result.error || result.status !== 0) return '';
    return classifyProbeOutput(result.stdout);
  }

  async function probeDesktopPythonAsync(candidate, cwd, desktopEnv) {
    let capture;
    try {
      capture = await ProcessRuntime.capture(candidate.command, probeArgs(candidate), probeOptions(cwd, desktopEnv),
        { ...ProcessRuntime.currentOwner(), kind: 'desktop-python-probe' });
    } catch { return ''; }
    const { child } = capture;
    let timer, timedOut = false;
    const deadline = new Promise(resolve => {
      timer = setTimeout(async () => {
        timedOut = true;
        let cleanup = { scope: 'unknown', incomplete: true };
        try { ProcessRuntime.stopChild(child); cleanup = await ProcessRuntime.waitForCleanup(child, 1500); }
        catch { /* preserve uncertainty */ }
        finally {
          child.stdout.destroy(); child.stderr.destroy();
          resolve({ cleanup });
        }
      }, DESKTOP_PYTHON_PROBE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([capture.output.then(async output => ({ ...output,
        cleanup: await ProcessRuntime.waitForCleanup(child, 1500) })), deadline]);
      if (!result.cleanup || result.cleanup.incomplete || result.error?.code === 'ERR_PROCESS_OUTPUT_INCOMPLETE') {
        const cleanupIncomplete = !result.cleanup || result.cleanup.incomplete === true;
        throw Object.assign(new Error('Python probe cleanup or output has not been confirmed'), {
          code: cleanupIncomplete ? 'process_cleanup_incomplete' : 'process_output_incomplete',
          cleanupIncomplete, cleanupScope: result.cleanup?.scope,
          cleanupEscapeCoverage: result.cleanup?.escapeCoverage, cleanupUnconfirmed: result.cleanup?.unconfirmed,
        });
      }
      if (timedOut || result.error) return '';
      return classifyProbeOutput(result.stdout);
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({ probeDesktopPython, probeDesktopPythonAsync });
}

module.exports = { createDesktopPythonProbe, DESKTOP_PYTHON_IMPORT_PROBE };
