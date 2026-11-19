'use strict';

// One pending deadline, no interval wakeups and no overlapping requests. Consumers
// resync on lifecycle/data events; an unchanged deadline is never postponed.
export function createDeadlinePoll({ shouldRun, delay, tick, clock = Date.now,
  arm = setTimeout, disarm = clearTimeout }) {
  let timer = null, deadline = 0, busy = false, stopped = false;
  function cancel() {
    if (timer !== null) disarm(timer);
    timer = null; deadline = 0;
  }
  function stop() { stopped = true; cancel(); }
  function sync() {
    stopped = false;
    if (!shouldRun()) { cancel(); return; }
    if (busy) return;
    const ms = Number(delay());
    if (!Number.isFinite(ms)) { cancel(); return; }
    const at = clock() + Math.max(1, ms);
    if (timer !== null && Math.abs(deadline - at) < 10) return;
    cancel(); deadline = at;
    timer = arm(async () => {
      timer = null; deadline = 0;
      if (stopped || !shouldRun()) return;
      busy = true;
      try { await tick(); } catch { /* Retry on the next deadline. */ }
      finally { busy = false; if (!stopped) sync(); }
    }, Math.max(1, ms));
  }
  return Object.freeze({ sync, stop, isRunning: () => timer !== null || busy });
}
