'use strict';

const { json, send } = require('./http-protocol.cjs');
const { usageSummaryPayload } = require('./usage-summary.cjs');

function createDiagnosticRoutes({
  tokenOk, readConfig, buildUsageSummary, buildOpsMetrics, collectAudit,
  collectStorageStats, maybeRecordStorageTrend, buildMetricsPayload,
}) {
  async function handleUsageApiRoutes(req, res, pathname) {
    // v1.4-OSS 用量/成本看板: read-only aggregation over the append-only usage ledgers. Same gate as the other
    // read-only GETs (agent-runs/checkpoints): self-check tokenOk here; NOT in the needsToken mutating whitelist.
    if (req.method === 'GET' && pathname === '/api/usage/summary') {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const rawRange = new URL(req.url, 'http://x').searchParams.get('range') || 'month';
      const range = ['today', 'week', 'month', 'all'].includes(rawRange) ? rawRange : 'month';
      try {
        return send(res, json(await buildUsageSummary(range)));
      } catch {
        return send(res, json(usageSummaryPayload(range)));
      }
    }
    // 第29波(§29c): 运营指标聚合(read-only GET,同 usage/summary 纪律:handler 自查 tokenOk,失败回空聚合)。
    if (req.method === 'GET' && pathname === '/api/ops/metrics') {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const daysQ = new URL(req.url, 'http://x').searchParams.get('days');
      try { return send(res, json(await buildOpsMetrics(daysQ))); }
      catch { return send(res, json({ ok: true, days: 7, interventions: { total: 0, bySource: {} }, missions: { started: 0, budgetExhausted: 0, budgetOverrunRate: 0 } })); }
    }
  }

  async function handleDiagnosticsApiRoutes(req, res, pathname) {
    // v0.9-S8 (§4 B4): 审计中心 — merged read-only timeline of workbench NDJSON logs + desktop MCP audit_tail.
    // GET /api/audit?limit=&source=&type= . This is a GET, so it NEVER runs through the mutating auth block;
    // the token gate MUST be applied HERE in the handler (the S0 lesson — same as /api/checkpoints & preview).
    // Paths & commands live in these records, so it is token-gated at the checkpoints sensitivity level.
    if (req.method === 'GET' && pathname === '/api/audit') {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const q = new URL(req.url, 'http://x').searchParams;
      const limit = q.get('limit'); // collectAudit clamps to 1..500 (default 100)
      const sourceRaw = q.get('source');
      const sourceFilter = (sourceRaw === 'workbench' || sourceRaw === 'desktop') ? sourceRaw : null;
      const typeFilter = (q.get('type') || '').trim() || null;
      const config = await readConfig();
      try {
        return send(res, json(await collectAudit(config, { limit, sourceFilter, typeFilter })));
      } catch (e) {
        return send(res, json({ ok: false, error: String(e && e.message || e) }, 500));
      }
    }
    // v1.9 数据管家: 存储管理(专家界面「存储」页签)。GET 在 handler 内自查 token(同 /api/audit 纵深纪律);
    // 两个 POST 由 ROUTE_AUTH 表的 token 级把门。清理全部 best-effort,慢盘/失败不 500(sweep 内部全静默,
    // 只有 stats 聚合异常才落 500)。
    if (req.method === 'GET' && pathname === '/api/storage/summary') {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const config = await readConfig();
      try {
        const stats = await collectStorageStats(config);
        await maybeRecordStorageTrend(stats); // 第40波:summary 与 metrics 共用趋势追点(≥1h 节流)
        return send(res, json(stats));
      } catch (e) {
        return send(res, json({ ok: false, error: String(e && e.message || e) }, 500));
      }
    }
    // 第40波:性能观测面(只读;请求耗时环形 + 进程/子进程内存 + 存储趋势)。
    if (req.method === 'GET' && pathname === '/api/metrics') {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const config = await readConfig();
      try {
        return send(res, json(await buildMetricsPayload(config)));
      } catch (e) {
        return send(res, json({ ok: false, error: String(e && e.message || e) }, 500));
      }
    }
  }

  return { handleUsageApiRoutes, handleDiagnosticsApiRoutes };
}

module.exports = { createDiagnosticRoutes };
