'use strict';
function createRgExecution({ ProcessRuntime }) {
// A fallback may start only after the supervised rg execution has completed its cleanup.
async function runRgOwned(command, argv, cwd, timeoutMs, maxBuffer, signal,
  owner = { ...ProcessRuntime.currentOwner(), kind: 'file-search' }) {
  const failure = (code, cleanup) => Object.assign(new Error('Search execution could not complete safely'), {
    code, searchExecutionFailure: true, cleanupScope: cleanup?.scope,
    cleanupIncomplete: cleanup?.incomplete === true, cleanupEscapeCoverage: cleanup?.escapeCoverage,
    cleanupUnconfirmed: cleanup?.unconfirmed,
  });
  if (signal?.aborted) throw failure('aborted');
  let capture;
  try {
    capture = await ProcessRuntime.capture(command, argv, { signal, cwd, maxBuffer, encoding: 'utf8' },
      owner);
  } catch { return null; } // No child was started, so JS fallback is safe.
  const { child } = capture;
  let stopping = false, resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  const stop = async code => {
    if (stopping) return;
    stopping = true;
    let cleanup = { scope: 'unknown', incomplete: true };
    try { ProcessRuntime.stopChild(child); cleanup = await ProcessRuntime.waitForCleanup(child, 1500); }
    catch { /* preserve uncertainty */ }
    finally {
      child.stdout.destroy(); child.stderr.destroy();
      resolveStopped({ error: Object.assign(new Error('Search interrupted'), { code }), cleanup });
    }
  };
  const abort = () => { void stop('aborted'); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { void stop('ETIMEDOUT'); }, timeoutMs);
  if (signal?.aborted) abort();
  try {
    let result = await Promise.race([capture.output.then(async output => ({ ...output,
      cleanup: await ProcessRuntime.waitForCleanup(child, 1500) })), stopped]);
    if (stopping) result = await stopped;
    if (result.cleanup?.incomplete) throw failure('process_cleanup_incomplete', result.cleanup);
    if (signal?.aborted) throw failure('aborted', result.cleanup);
    if (result.error?.code === 'ERR_PROCESS_OUTPUT_INCOMPLETE') throw failure('process_output_incomplete', result.cleanup);
    if (result.error && result.error.code !== 1) return null;
    return { stdout: result.stdout, code: result.error ? 1 : 0 };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

return { runRgOwned };
}
module.exports = { createRgExecution };
