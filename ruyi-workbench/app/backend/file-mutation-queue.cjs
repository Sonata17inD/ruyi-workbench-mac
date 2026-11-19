'use strict';

// One Mac mutation lane protects path aliases, hard links and atomic inode replacement.
// A transaction already running owns its checkpoint/commit boundary until it settles.
function createFileMutationQueue() {
  const waiting = new Set();
  let active = false;
  const cancelled = () => ({ ok: false, code: 'aborted', error: 'File operation cancelled before acquiring its write lock' });
  function pump() {
    if (active || !waiting.size) return;
    const item = waiting.values().next().value;
    waiting.delete(item);
    item.detach();
    active = true;
    Promise.resolve().then(() => item.signal?.aborted ? cancelled() : item.work()).then(item.resolve, item.reject).finally(() => {
      active = false;
      pump();
    });
  }
  function run(signal, work) {
    if (signal?.aborted) return Promise.resolve(cancelled());
    return new Promise((resolve, reject) => {
      const item = { signal, work, resolve, reject, detach: () => signal?.removeEventListener('abort', abort) };
      const abort = () => {
        if (!waiting.delete(item)) return;
        item.detach();
        resolve(cancelled());
      };
      waiting.add(item);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      pump();
    });
  }
  return Object.freeze({ run, get pendingCount() { return waiting.size; }, get busy() { return active; } });
}
module.exports = { createFileMutationQueue };
