'use strict';
const cp = require('child_process');

// Native snapshot rows contain process identity and birth time.
function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(\d+),(\d+),(\d+)(?:,([^,\r\n]*))?\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: BigInt(m[3]), name: String(m[4] || '').trim().toLowerCase() });
  }
  return rows;
}

// 从 rootPid 往下找自己的子孙(广度优先)。认子的判据:ppid === 父.pid 且 created >= 父.created。
// 返回的顺序是「先父后子」;调用方杀的时候先杀根(停止再生),再按这个顺序杀子孙。
function ownDescendants(table, rootPid) {
  const root = table.find(r => r.pid === rootPid);
  if (!root) return { root: null, descendants: [] };
  const descendants = [];
  const seen = new Set([root.pid]);
  const children = new Map();
  for (const row of table) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i];
    for (const r of children.get(parent.pid) || []) {
      if (seen.has(r.pid)) continue;
      if (r.created < parent.created) continue;   // 父号过期、撞号的陌生进程:比「父亲」还老,不是它生的
      seen.add(r.pid);
      descendants.push(r);
      queue.push(r);
    }
  }
  return { root, descendants };
}

function snapshotProcessTable() {
  const result = runMacProcessHelper(['--snapshot']);
  return !result.error && result.status === 0 && result.stdout.startsWith('RUYI-PROCESS-V1\n')
    ? parseProcessTable(result.stdout) : null;
}

function runMacProcessHelper(args) {
  const helper = require('path').resolve(__dirname, '../../ruyi-workbench/runtime/macos/ruyi-process-helper');
  return cp.spawnSync(helper, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
}

function killOwnTree(child) {
  try {
    if (!child || !child.pid) return { killed: [], skipped: 'no-pid' };
    if (child.exitCode !== null || child.signalCode !== null) return { killed: [], skipped: 'root-exited' };
    const result = runMacProcessHelper(['--terminate-child-tree', String(child.pid)]);
    const lines = String(result.stdout || '').split(/\r?\n/);
    const killed = lines.map(line => /^KILLED (\d+)$/.exec(line)).filter(Boolean).map(match => Number(match[1]));
    const counts = /^EXIT-COUNTS (\d+) (\d+) (\d+)$/m.exec(String(result.stdout || ''));
    const exits = counts ? { terminated: Number(counts[1]), alreadyExited: Number(counts[2]), unconfirmed: Number(counts[3]) } : {};
    const observed = /^OBSERVED-TREE (\d+) (\d+)$/m.exec(String(result.stdout || ''));
    const numbers = counts && observed ? [...counts.slice(1), ...observed.slice(1)].map(Number) : [];
    const validCounts = numbers.length === 5 && numbers.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 32768)
      && numbers[3] >= 1 && exits.terminated + exits.alreadyExited + exits.unconfirmed === numbers[3]
      && numbers[4] === killed.length && new Set(killed).size === killed.length
      && exits.terminated <= numbers[4] && numbers[4] - exits.terminated <= exits.unconfirmed;
    if (result.error || result.status !== 0 || lines[0] !== 'RUYI-PROCESS-V1' || !validCounts || exits.unconfirmed > 0) {
      // Preserve direct-child cleanup when a source checkout has not built its native helper.
      // Report that descendants were not inspected rather than claiming a complete cleanup.
      if (child.kill('SIGKILL')) killed.push(child.pid);
      return { killed, ...(validCounts ? exits : {}), scope: 'direct-child', incomplete: true, skipped: result.error && result.error.code === 'ENOENT'
        ? 'macos-helper-missing(descendants-not-walked)' : 'macos-cleanup-incomplete' };
    }
    return { killed, ...(validCounts ? exits : {}), scope: 'observed-tree', incomplete: false };
  } catch (e) {
    return { killed: [], skipped: 'error:' + (e && e.message ? e.message : String(e)) };
  }
}

module.exports = { killOwnTree, ownDescendants, parseProcessTable, snapshotProcessTable };
