'use strict';

const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { safeJsonParse } = require('./ordinary-json.cjs');

function createRuntimeMetrics({ dataDirectory, activeChildren, mcpClients, collectStorageStats, atomicWriteJson, nowIso }) {
  // Request timings are bounded in memory. RSS samples cover the workbench and its known
  // children. The persisted storage trend is shared by the summary and metrics endpoints.
  const REQ_METRICS = {
    total: 0,
    buckets: [0, 0, 0, 0, 0, 0], // <10 / <50 / <200 / <1000 / <5000 / ≥5000 ms
    recent: [],                  // 环形:最近 300 条 { m, p, ms }(p 已归一化,不含 id/查询串)
  };
  const REQ_METRICS_RECENT_MAX = 300;
  function metricsBucketIndex(ms) { return ms < 10 ? 0 : ms < 50 ? 1 : ms < 200 ? 2 : ms < 1000 ? 3 : ms < 5000 ? 4 : 5; }
  // 归一化:/api/sessions/sess_ab12cd/events → /api/sessions/:id/events —— 观测面不落会话 id(数量级保护 +
  // 轻微隐私),只看得到端点形状。段内带数字/下划线长尾的视为 id。
  function normalizeMetricsPath(pathname) {
    const segs = String(pathname || '').split('/').filter(Boolean);
    return '/' + segs.map(s => (/^(sess_|run_|[0-9a-f]{8,})/i.test(s) ? ':id' : s)).join('/');
  }
  function recordRequestMetric(method, pathname, ms) {
    REQ_METRICS.total++;
    REQ_METRICS.buckets[metricsBucketIndex(ms)]++;
    REQ_METRICS.recent.push({ m: method, p: normalizeMetricsPath(pathname), ms: Math.round(ms) });
    if (REQ_METRICS.recent.length > REQ_METRICS_RECENT_MAX) REQ_METRICS.recent.splice(0, REQ_METRICS.recent.length - REQ_METRICS_RECENT_MAX);
  }
  // 存储趋势:storage-trend.json,点 = { ts, totalBytes, stores:{key:bytes}, engineBytes }。读失败 = 空史(不硬失败)。
  const STORAGE_TREND_MAX = 240;
  const STORAGE_TREND_MIN_GAP_MS = 3600 * 1000;
  function storageTrendPath() { return path.join(dataDirectory, 'storage-trend.json'); }
  async function readStorageTrend() {
    try { const v = safeJsonParse(await fsp.readFile(storageTrendPath(), 'utf8'), []); return Array.isArray(v) ? v : []; }
    catch { return []; }
  }
  async function maybeRecordStorageTrend(stats) {
    try {
      const trend = await readStorageTrend();
      const last = trend[trend.length - 1];
      if (last && Date.now() - Date.parse(last.ts) < STORAGE_TREND_MIN_GAP_MS) return;
      const stores = {};
      for (const [k, s] of Object.entries(stats.stores || {})) stores[k] = s.bytes;
      trend.push({ ts: nowIso(), totalBytes: stats.totalBytes, stores, engineBytes: stats.engineTranscripts ? stats.engineTranscripts.bytes : 0 });
      while (trend.length > STORAGE_TREND_MAX) trend.shift();
      await atomicWriteJson(storageTrendPath(), trend);
    } catch { /* 趋势是观测辅助,失败不影响主流程 */ }
  }
  // 在册子进程快照:引擎回合(activeChildren)+ 桥接 MCP(mcpClients)。按已知 PID 一次读取 RSS。
  function collectChildProcessInfo() {
    const out = [];
    for (const [sessionId, ent] of activeChildren) {
      if (ent && ent.pid) out.push({ kind: 'engine-turn', pid: ent.pid, ref: sessionId, startedAt: ent.startedAt || null });
    }
    for (const [serverId, client] of mcpClients) {
      const pid = client && client.child && client.child.pid;
      if (pid) out.push({ kind: 'mcp-bridge', pid, ref: serverId, startedAt: null });
    }
    return out;
  }
  async function sampleProcessRss(pids) {
    const ids = [...new Set(pids.map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0))];
    if (!ids.length) return {};
    try {
      const output = await new Promise((resolve, reject) => {
        execFile('/bin/ps', ['-o', 'pid=,rss=', '-p', ids.join(',')], { encoding: 'utf8', timeout: 5000 },
          (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      const rss = {}, allowed = new Set(ids);
      for (const line of String(output).split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (match && allowed.has(Number(match[1]))) rss[match[1]] = Number(match[2]) * 1024;
      }
      return rss;
    } catch { return {}; }
  }
  async function buildMetricsPayload(config) {
    const storage = await collectStorageStats(config);
    await maybeRecordStorageTrend(storage);
    const children = collectChildProcessInfo();
    const rss = await sampleProcessRss([process.pid, ...children.map(c => c.pid)]);
    const mem = process.memoryUsage();
    // 近 300 条里最慢的 8 条(观测尾部延迟,直方图看不出具体端点)
    const slowest = [...REQ_METRICS.recent].sort((a, b) => b.ms - a.ms).slice(0, 8);
    return {
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      pid: process.pid, node: process.version,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, external: mem.external, rssOs: rss[String(process.pid)] || null },
      requests: {
        total: REQ_METRICS.total,
        buckets: REQ_METRICS.buckets.slice(),
        bucketEdgesMs: [10, 50, 200, 1000, 5000],
        slowest,
      },
      children: children.map(c => ({ ...c, rss: rss[String(c.pid)] || null })),
      storageTrend: await readStorageTrend(),
    };
  }

  return { recordRequestMetric, normalizeMetricsPath, readStorageTrend, maybeRecordStorageTrend, buildMetricsPayload };
}

module.exports = { createRuntimeMetrics };
