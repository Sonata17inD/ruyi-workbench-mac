'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { safeJsonParse } = require('./ordinary-json.cjs');
const { redact } = require('./secret-redaction.cjs');

function createAuditTimeline({ paths, collectBridgedTools, resolveExternalMcpServers, sanitizeServerId, getMcpClient }) {
  // ============================================================================
  // v0.9-S8 — 审计中心 (§0.9-S8 / §4 B4). Read-only aggregation of two audit sources into ONE timeline:
  //   (1) workbench: the structured NDJSON logs logEvent() writes to dataRoot/logs/workbench-<day>.ndjson;
  //   (2) desktop:   the ai-computer-control MCP's `audit_tail` tool (only when that bridge is live).
  // Both are normalized to { ts, source, type, summary, detail } and merged ts-descending. `detail` is passed
  // through redact() so secrets in a logged/audited record NEVER surface in the audit response. GET /api/audit
  // is token-gated (paths & commands are sensitive — same class as /api/checkpoints).
  // ============================================================================

  // Human-friendly Chinese phrasing for the workbench log `kind` values (turn_start → 开始回合, …). Unknown
  // kinds fall through to the raw kind (never blank — the timeline must always show something legible).
  const AUDIT_SUMMARY_MAP = {
    turn_start: '开始回合',
    turn_end: '结束回合',
    turn_kill: '中止回合',
    server_start: '服务启动',
    mcp_bridge_start_failed: 'MCP 桥接启动失败',
    provider_compact: '上下文摘要压缩',
    auto_compact: '自动压缩上下文',
    autonomy_grant_issued: '签发授权书',
    autonomy_grant_consume: '消耗授权',
    autonomy_grant_revoked: '撤销授权',
    autonomy_grant_expired: '授权过期',
  };
  // Fields worth surfacing per kind in the timeline row's one-line summary suffix (kept short; full record
  // goes to `detail`). Purely cosmetic — absent fields are skipped.
  function auditSummaryFor(rec) {
    const kind = rec && rec.kind;
    const base = AUDIT_SUMMARY_MAP[kind] || String(kind || 'event');
    const bits = [];
    if (kind === 'turn_start') {
      if (rec.engine) bits.push(rec.engine === 'openai' ? 'provider' : rec.engine);
      if (rec.model) bits.push(String(rec.model));
    } else if (kind === 'turn_end') {
      bits.push(rec.ok ? '成功' : '未成功');
      if (rec.aborted) bits.push('已中止');
    } else if (kind === 'server_start') {
      if (rec.version) bits.push('v' + rec.version);
    } else if (kind === 'mcp_bridge_start_failed') {
      if (rec.serverId) bits.push(String(rec.serverId));
    } else if (kind === 'autonomy_grant_issued') {
      if (rec.tool) bits.push(String(rec.tool)); if (rec.tier) bits.push(String(rec.tier));
    } else if (kind === 'autonomy_grant_consume') {
      if (rec.tool) bits.push(String(rec.tool)); if (rec.remaining != null) bits.push('剩 ' + rec.remaining + ' 次');
    } else if (kind === 'autonomy_grant_revoked') {
      if (rec.count != null) bits.push(rec.count + ' 张'); else if (rec.tool) bits.push(String(rec.tool));
    }
    return bits.length ? `${base}（${bits.join(' · ')}）` : base;
  }

  // Read the most recent workbench NDJSON log file (by filename, which sorts chronologically since the day
  // stamp is ISO), tail up to `limit` lines, JSON-parse each (bad lines skipped), and normalize. Never throws.
  // 第二轮工具走查(F6)给管家的 steward_audit_tail 加了两个可选口子(HTTP /api/audit 不传 = 行为逐字不变):
  //   · opts.kinds / opts.excludeKinds —— 按 rec.kind 在【取尾之前】过滤。修前只能在取尾之后过滤(collectAudit 的
  //     typeFilter),于是「最近 20 条里恰好有几条 intervention」才拿得到,而最近 20 条几乎全是遥测;
  //   · opts.maxFiles —— 最近一个日志文件不够 limit 条时往前再读几天(默认 1 = 旧行为;跨零点后第一条事件之前
  //     最新文件几乎是空的,管家问「刚才发生了什么」就只剩那几行)。
  async function readWorkbenchAudit(limit, opts) {
    const out = [];
    const kinds = opts && opts.kinds instanceof Set && opts.kinds.size ? opts.kinds : null;
    const excludeKinds = opts && opts.excludeKinds instanceof Set && opts.excludeKinds.size ? opts.excludeKinds : null;
    const maxFiles = Math.max(1, Math.min(7, Number(opts && opts.maxFiles) || 1));
    let files;
    try { files = await fsp.readdir(paths.logs); } catch { return out; }
    const logs = files.filter(f => /^workbench-.*\.ndjson$/.test(f)).sort();
    if (!logs.length) return out;
    // Most recent file only (spec: 取最近文件, 尾部 limit 条). Read, split, tail.
    // 多文件时按【从新到旧】逐个读,凑够 limit 条为止;最终 out 仍按文件内行序(旧 → 新)排列,
    // 与单文件时同一个次序(collectAudit 随后统一排序)。
    const picked = [];
    for (let fi = logs.length - 1; fi >= 0 && fi >= logs.length - maxFiles && picked.length < limit; fi -= 1) {
      let raw;
      try { raw = await fsp.readFile(path.join(paths.logs, logs[fi]), 'utf8'); } catch { continue; }
      const lines = raw.split('\n').filter(l => l.trim());
      const recs = [];
      // 没有 kind 过滤时先取尾再解析(与修前同一个代价:大日志不必整份 JSON.parse)。
      for (const line of (kinds || excludeKinds) ? lines : lines.slice(-(limit - picked.length))) {
        const rec = safeJsonParse(line, null);
        if (!rec || typeof rec !== 'object') continue;   // corrupt line → skip
        const kind = String(rec.kind || 'event');
        if (kinds && !kinds.has(kind)) continue;
        if (excludeKinds && excludeKinds.has(kind)) continue;
        recs.push(rec);
      }
      picked.unshift(...recs.slice(-(limit - picked.length)));
    }
    for (const rec of picked) {
      const detailStr = redact(JSON.stringify(rec));   // 脱敏: secrets never reach the audit response
      out.push({
        ts: rec.ts || '',
        source: 'workbench',
        type: String(rec.kind || 'event'),
        summary: auditSummaryFor(rec),
        detail: safeJsonParse(detailStr, { redacted: true }), // parse the redacted string back to an object
      });
    }
    return out;
  }

  // 第29波(§29c 运营指标):跨日聚合 —— 读最近 N 天 workbench-*.ndjson,只数 29c 落账的三类 kind
  // (intervention / mission_start / mission_budget_exhausted),逐行 safeJsonParse 坏行免疫(readWorkbenchAudit
  // 同款纪律)。日切文件体积可控,无需流式;天数 clamp [1,30] 防大目录慢扫。失败回空聚合,绝不 500。
  async function buildOpsMetrics(days) {
    const nDays = Math.max(1, Math.min(30, Number(days) || 7));
    const out = { ok: true, days: nDays, interventions: { total: 0, bySource: {} }, missions: { started: 0, budgetExhausted: 0, budgetOverrunRate: 0 } };
    let files; try { files = await fsp.readdir(paths.logs); } catch { return out; }
    const cutoff = new Date(Date.now() - nDays * 86400000).toISOString().slice(0, 10);
    const logs = files.filter(f => /^workbench-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f) && f.slice(10, 20) >= cutoff).sort();
    for (const f of logs) {
      let raw; try { raw = await fsp.readFile(path.join(paths.logs, f), 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        const t = line.trim(); if (!t) continue;
        const rec = safeJsonParse(t, null);
        if (!rec || typeof rec !== 'object') continue;
        if (rec.kind === 'intervention') { out.interventions.total += 1; const s = String(rec.source || 'other'); out.interventions.bySource[s] = (out.interventions.bySource[s] || 0) + 1; }
        else if (rec.kind === 'mission_start') out.missions.started += 1;
        else if (rec.kind === 'mission_budget_exhausted') out.missions.budgetExhausted += 1;
      }
    }
    out.missions.budgetOverrunRate = out.missions.started > 0 ? Math.round((out.missions.budgetExhausted / out.missions.started) * 1000) / 1000 : 0;
    return out;
  }

  // 桌面 audit_tail 结果 → 时间线行。ACC 的形状是 {ok,count,records:[{ts,tool,ok,args:'<json 字符串>'}|{raw}],log_dir}
  // (tools/audit.py;审计 A2:修前只认 entries/items/audit/裸数组,`records` 不在其中 → 桌面源标 available 却一行都没有)。
  // 仍兼容 {entries}/{items}/{audit}/裸数组。ACC 的 args 是脱敏后的 JSON 字符串,能解析就摊成对象,detail 不再是双重编码。
  function desktopAuditEntriesFromResult(res) {
    const rows = Array.isArray(res) ? res
      : (res && Array.isArray(res.entries) ? res.entries
        : (res && Array.isArray(res.records) ? res.records
          : (res && Array.isArray(res.items) ? res.items
            : (res && Array.isArray(res.audit) ? res.audit : []))));
    const entries = [];
    for (const r0 of rows) {
      if (!r0 || typeof r0 !== 'object') continue;
      const r = { ...r0 };
      if (typeof r.args === 'string') { const a = safeJsonParse(r.args, undefined); if (a && typeof a === 'object') r.args = a; }
      const failed = r.ok === false;
      const name = String(r.action || r.type || r.tool || r.name || (r.raw !== undefined ? 'raw' : 'action'));
      const detailStr = redact(JSON.stringify(r));
      entries.push({
        ts: r.ts || r.time || r.timestamp || '',
        source: 'desktop',
        type: name,
        summary: r.summary ? String(r.summary) : (failed ? `${name}（失败）` : String(r.action || r.type || r.tool || r.name || '桌面操作')),
        detail: safeJsonParse(detailStr, { redacted: true }),
      });
    }
    return entries;
  }

  // Pull the desktop MCP's audit tail via the live ai-computer-control bridge, if present. Returns
  // { entries, available }: available=false means the bridge isn't live or the call failed (degraded — the
  // caller marks sources.desktop='unavailable' and simply omits desktop rows; never an error).
  async function readDesktopAudit(config, limit) {
    const result = { entries: [], available: false };
    try {
      const bridged = await collectBridgedTools(config);
      const accEntry = resolveExternalMcpServers(config).find(s => s.id === 'ai-computer-control');
      if (!accEntry) return result;                              // no desktop bridge configured
      const prefix = sanitizeServerId(accEntry.id);
      if (!bridged.route[`${prefix}__audit_tail`]) return result; // bridge live but no audit_tail tool → skip
      const client = getMcpClient(accEntry.id);
      if (!client || client.dead) return result;
      let res;
      try { res = await client.callTool('audit_tail', { n: limit }); } catch { return result; }
      if (!res || res.ok === false) return result;
      result.entries = desktopAuditEntriesFromResult(res);
      result.available = true;
      return result;
    } catch { return result; }
  }

  // Aggregate both sources → merged, filtered, ts-descending, limit-capped timeline. `sourceFilter` (one of
  // 'workbench'|'desktop') restricts to a single source; `typeFilter` matches entry.type exactly.
  async function collectAudit(config, { limit, sourceFilter, typeFilter, kinds, excludeKinds, maxFiles }) {
    const cap = Math.max(1, Math.min(500, Number(limit) || 100)); // clamp 1..500 (default 100)
    const sources = { workbench: false, desktop: false };
    let entries = [];
    const wantWorkbench = !sourceFilter || sourceFilter === 'workbench';
    const wantDesktop = !sourceFilter || sourceFilter === 'desktop';

    if (wantWorkbench) {
      const wb = await readWorkbenchAudit(cap, { kinds, excludeKinds, maxFiles });
      entries = entries.concat(wb);
      sources.workbench = true; // the workbench log source is always available (empty is still "available")
    }
    if (wantDesktop) {
      const dk = await readDesktopAudit(config, cap);
      entries = entries.concat(dk.entries);
      sources.desktop = dk.available ? true : 'unavailable';
    } else {
      sources.desktop = false; // not requested → report as not-included (source=workbench filter)
    }

    if (typeFilter) entries = entries.filter(e => e.type === typeFilter);
    // Sort ts-descending (new→old). Empty ts sorts last (localeCompare treats '' as smallest → reverse it).
    // 同一毫秒的事件(一个回合的 turn_start / turn_end 常常同 ts)靠【稳定排序 + 先把行序倒过来】保持「后写的在前」:
    // 各源给的都是文件行序(旧 → 新),不倒就是同 ts 里旧的排在前面,limit:1 取到的不是最新那条(第二轮走查 F6)。
    entries.reverse();
    entries.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    const truncated = entries.length > cap;
    if (truncated) entries = entries.slice(0, cap);
    return { ok: true, entries, sources, truncated };
  }

  return { collectAudit, buildOpsMetrics, desktopAuditEntriesFromResult };
}

module.exports = { createAuditTimeline };
