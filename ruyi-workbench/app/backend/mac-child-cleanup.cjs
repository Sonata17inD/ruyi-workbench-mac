'use strict';

const cp = require('node:child_process');

function createMacChildCleanup({ ProcessRuntime, helperPath, process = globalThis.process }) {
  function killPosixChildTree(pid, ownedChild) {
    if (process.platform === 'darwin') {
      if (!(ownedChild instanceof cp.ChildProcess) || ownedChild.pid !== Number(pid)) {
        return { killed: [], scope: 'unknown', incomplete: true, skipped: 'process-handle-required' };
      }
      const helper = helperPath();
      const result = cp.spawnSync(helper, ['--terminate-child-tree', String(pid)], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      });
      const output = String(result.stdout || '');
      const killed = output.split(/\r?\n/).map(line => /^KILLED (\d+)$/.exec(line))
        .filter(Boolean).map(match => Number(match[1]));
      const counts = /^EXIT-COUNTS (\d+) (\d+) (\d+)$/m.exec(output);
      const exits = counts ? { terminated: Number(counts[1]), alreadyExited: Number(counts[2]), unconfirmed: Number(counts[3]) } : {};
      const observed = /^OBSERVED-TREE (\d+) (\d+)$/m.exec(output);
      const numbers = counts && observed ? [...counts.slice(1), ...observed.slice(1)].map(Number) : [];
      const validCounts = numbers.length === 5 && numbers.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 32768)
        && numbers[3] >= 1 && exits.terminated + exits.alreadyExited + exits.unconfirmed === numbers[3]
        && numbers[4] === killed.length && new Set(killed).size === killed.length
        && exits.terminated <= numbers[4] && numbers[4] - exits.terminated <= exits.unconfirmed;
      const incomplete = !!result.error || result.status !== 0 || !output.startsWith('RUYI-PROCESS-V1\n') || !validCounts || exits.unconfirmed > 0;
      if (incomplete && ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null) {
        try { if (ownedChild.kill('SIGKILL') && !killed.includes(pid)) killed.push(pid); } catch { /* report incomplete */ }
        return { killed, ...(validCounts ? exits : {}), scope: 'direct-child', incomplete: true };
      }
      return { killed, ...(validCounts ? exits : {}), scope: 'observed-tree', incomplete };
    }
    return { killed: [], scope: 'unknown', incomplete: true, skipped: 'platform-unsupported' };
  }
  function killChildTree(pid) {
    const ownedChild = pid instanceof cp.ChildProcess ? pid : null;
    const supervised = ownedChild && ProcessRuntime.stopChild(ownedChild);
    if (supervised) return supervised;
    if (ownedChild && (ownedChild.exitCode !== null || ownedChild.signalCode !== null)) {
      return { killed: [], scope: 'observed-tree', incomplete: true, skipped: 'root-exited' };
    }
    if (ownedChild) pid = ownedChild.pid;
    if (!pid) return;
    return killPosixChildTree(pid, ownedChild);
  }

  return Object.freeze({ killChildTree, killPosixChildTree });
}

module.exports = { createMacChildCleanup };
