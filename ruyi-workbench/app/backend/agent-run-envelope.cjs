'use strict';

const fsp = require('node:fs/promises');

function createAgentRunEnvelope({
  EventStreamHooks, activeAgentRuns, agentRunCapabilities, agentRunFile, safeJsonParse, safeSessionId,
}) {

  const AGENT_ENVELOPE_NODE_SUMMARY_MAX = 1500;   // 单节点 summary 上限(字符)
  const AGENT_ENVELOPE_TOTAL_SUMMARY_MAX = 9000;  // 全部节点 summary 之和上限;超出按节点均摊收缩(下限 200)
  const AGENT_ENVELOPE_STRUCTURED_MAX = 2000;     // 单节点 structuredResult JSON 上限
  const AGENT_ENVELOPE_STRUCTURED_TOTAL_MAX = 4000; // 全部节点 structuredResult 之和上限;超出按节点均摊收缩(下限 300)
  const AGENT_ENVELOPE_ERROR_MAX = 400;
  const AGENT_RESULT_DEFAULT_CHARS = 12000;
  const AGENT_RESULT_MAX_CHARS = 40000;
  // 按句截断:优先在 max 之前最后一个句末标点/换行处切;找不到(或切点太靠前,<60%)才硬切,并加省略号。
  function cutAtSentence(text, max) {
    const t = String(text == null ? '' : text);
    const cap = Math.max(20, Number(max) || 0);
    if (t.length <= cap) return t;
    const head = t.slice(0, cap);
    let cut = -1;
    for (let i = head.length - 1; i >= 0; i--) {
      const c = head.charCodeAt(i);
      // 。！？；\n . ! ? ;
      if (c === 0x3002 || c === 0xff01 || c === 0xff1f || c === 0xff1b || c === 10 || c === 46 || c === 33 || c === 63 || c === 59) { cut = i + 1; break; }
    }
    if (cut < Math.floor(cap * 0.6)) cut = cap;
    return head.slice(0, cut).trimEnd() + '…';
  }
  function agentEnvelopeArtifacts(node) {
    const out = [];
    const seen = new Set();
    const push = v => { const x = String(v || '').trim().slice(0, 240); if (x && !seen.has(x)) { seen.add(x); out.push(x); } };
    if (Array.isArray(node && node.artifacts)) for (const a of node.artifacts) push(a && (a.ref || a.path || a));
    if (node && node.isolation && node.isolation.path) push(node.isolation.path);
    return out.slice(0, 20);
  }
  // Delivered means injected into local context, not provider acceptance or agent action.
  function agentMessageReceipt(message) {
    const status = message.dropped ? 'undeliverable' : message.deliveredAt ? 'delivered' : 'queued';
    return { messageId: message.id, sender: message.sender, target: message.target, status,
      delivered: status === 'delivered', createdAt: message.createdAt,
      ...(message.deliveredAt ? { deliveredAt: message.deliveredAt } : {}),
      ...(message.dropped ? { reason: message.dropReason || 'target_unavailable', ...(message.droppedAt ? { droppedAt: message.droppedAt } : {}) } : {}) };
  }
  function ownAgentMessageReceipt(run, sender, messageId) {
    if (EventStreamHooks.projectAgentMessageReceipts) EventStreamHooks.projectAgentMessageReceipts(run);
    const message = (run.messages || []).find(m => m.id === String(messageId || '') && m.sender === sender);
    return message ? { ok: true, ...agentMessageReceipt(message) } : { ok: false, status: 'not_found', reason: 'receipt_unavailable' };
  }
  function buildAgentRunEnvelope(run, opts = {}) {
    const nodes = Array.isArray(run && run.nodes) ? run.nodes : [];
    const perNodeCap = Math.max(200, Math.min(AGENT_ENVELOPE_NODE_SUMMARY_MAX, nodes.length ? Math.floor(AGENT_ENVELOPE_TOTAL_SUMMARY_MAX / nodes.length) : AGENT_ENVELOPE_NODE_SUMMARY_MAX));
    const perNodeStructuredCap = Math.max(300, Math.min(AGENT_ENVELOPE_STRUCTURED_MAX, nodes.length ? Math.floor(AGENT_ENVELOPE_STRUCTURED_TOTAL_MAX / nodes.length) : AGENT_ENVELOPE_STRUCTURED_MAX));
    let toolCalls = 0;
    const startedAt = Date.parse(String(run && run.createdAt || '')) || 0;
    const endedAt = Date.parse(String(run && run.completedAt || '')) || (run && run.status === 'running' ? Date.now() : startedAt);
    const rows = nodes.map(node => {
      toolCalls += Math.max(0, Number(node && node.toolCalls) || 0);
      // summary 取 deriveNodeOutputs 的精简结论(结构化 summary 优先),fullChars 如实报 node.result 的长度(存档全文,agent_result 取)。
      const full = String(node.result || node.error || '');
      const body = String(node.summary || full).replace(/\s+/g, ' ').trim();
      const row = {
        nodeId: node.id, agentKey: node.agentKey || node.id, role: node.roleId || node.role || '', engine: node.engine || 'openai',
        status: node.status, summary: cutAtSentence(body, perNodeCap), artifacts: agentEnvelopeArtifacts(node),
      };
      if (node.degraded) row.degraded = true;
      if (node.status === 'skipped' && node.skipReason) row.skipReason = String(node.skipReason).slice(0, 200);
      if (node.error) row.error = String(node.error).slice(0, AGENT_ENVELOPE_ERROR_MAX);
      if (node.gateVerdict || (node.gateResult && node.gateResult.verdict)) row.gateNote = 'verdict=' + String(node.gateVerdict || node.gateResult.verdict) + (Number.isFinite(Number(node.confidence)) ? ' (' + Number(node.confidence).toFixed(2) + ')' : '');
      if (node.structuredResult && typeof node.structuredResult === 'object') {
        let sj = ''; try { sj = JSON.stringify(node.structuredResult); } catch { sj = ''; }
        if (sj) row.structuredResult = sj.length <= perNodeStructuredCap ? node.structuredResult : { truncated: true, preview: sj.slice(0, perNodeStructuredCap) };
      }
      if (full.length > row.summary.length) row.fullChars = full.length;
      return row;
    });
    const usage = {
      toolCalls,
      tokens: { input: Number(run && run.usageTotals && run.usageTotals.inTok) || 0, output: Number(run && run.usageTotals && run.usageTotals.outTok) || 0 },
      durationMs: Math.max(0, endedAt - startedAt),
    };
    if (Number(run && run.costUsd) > 0) usage.costUsd = Number(run.costUsd);
    const status = String(run && run.status || 'unknown');
    const capabilities = agentRunCapabilities(run);
    delete capabilities.nodes; // Per-node live tools belong to action:list, not the bounded delivery envelope.
    const env = {
      ok: status === 'succeeded', kind: 'agent_envelope', runId: String(run && run.id || ''), status,
      nodes: rows, usage, capabilities,
      ...(run.followup ? { followup: run.followup } : {}),
      more: '完整产出用 agent_result({runId' + (nodes.length > 1 ? ', nodeId' : '') + '}) 取',
    };
    const receipts = (run && run.messages || []).filter(m => m.dropped || !m.deliveredAt).slice(-24).map(agentMessageReceipt);
    if (receipts.length) env.messageReceipts = receipts;
    if (run && run.background) env.background = true;
    if (run && run.error) env.error = String(run.error).slice(0, AGENT_ENVELOPE_ERROR_MAX);
    if (opts.note) env.note = String(opts.note);
    return env;
  }
  // 读一个 run(优先进程内活对象,再磁盘),限定在本会话目录 —— 与 waitForAgentRunResults 同一条归属纪律。
  async function readAgentRunRecord(sessionId, runId) {
    const rid = safeSessionId(String(runId || ''));
    if (!rid) return null;
    const live = activeAgentRuns.get(rid);
    if (live && live.run) {
      if (live.run.sessionId !== sessionId) return null;
      if (EventStreamHooks.projectAgentMessageReceipts) EventStreamHooks.projectAgentMessageReceipts(live.run);
      return { run: live.run, live: true };
    }
    try {
      const run = safeJsonParse(await fsp.readFile(agentRunFile(sessionId, rid), 'utf8'), null);
      if (run && run.sessionId === sessionId && EventStreamHooks.projectAgentMessageReceipts) EventStreamHooks.projectAgentMessageReceipts(run);
      return run && run.sessionId === sessionId ? { run, live: false } : null;
    } catch { return null; }
  }
  // agent_result:有界切片。offset/maxChars 分页;单节点 run 可省 nodeId。
  async function agentRunResultSlice({ sessionId, runId, nodeId, maxChars, offset }) {
    const rec = await readAgentRunRecord(sessionId, runId);
    if (!rec) return { ok: false, error: 'agent run not found: ' + String(runId || '') };
    const run = rec.run;
    const nodes = Array.isArray(run.nodes) ? run.nodes : [];
    const wanted = String(nodeId || '').trim();
    const node = wanted ? nodes.find(n => n && (n.id === wanted || n.agentKey === wanted)) : (nodes.length === 1 ? nodes[0] : null);
    if (!node) return { ok: false, error: wanted ? ('node not found: ' + wanted) : ('run 有 ' + nodes.length + ' 个节点,请指定 nodeId'), runId: run.id, status: run.status, nodes: nodes.map(n => n && n.id).filter(Boolean) };
    const full = String(node.result || node.error || '');
    const cap = Math.max(500, Math.min(AGENT_RESULT_MAX_CHARS, Number(maxChars) || AGENT_RESULT_DEFAULT_CHARS));
    const start = Math.max(0, Math.min(full.length, Math.round(Number(offset) || 0)));
    const text = full.slice(start, start + cap);
    const out = {
      ok: true, runId: run.id, nodeId: node.id, runStatus: run.status, status: node.status, live: rec.live,
      text, offset: start, returnedChars: text.length, totalChars: full.length, truncated: start + text.length < full.length,
    };
    if (out.truncated) out.nextOffset = start + text.length;
    if (node.structuredResult && typeof node.structuredResult === 'object') out.structuredResult = node.structuredResult;
    if (node.error) out.error = String(node.error).slice(0, 4000);
    return out;
  }

  return { agentEnvelopeArtifacts, agentRunResultSlice, buildAgentRunEnvelope, cutAtSentence, ownAgentMessageReceipt, readAgentRunRecord };
}

module.exports = { createAgentRunEnvelope };
