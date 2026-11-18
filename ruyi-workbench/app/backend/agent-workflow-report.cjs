'use strict';

function createAgentWorkflowReport({
  appendAgentRunEvent, estimateContentTokens, nowIso,
}) {

  function buildUpstreamContext(depNodes, budgetTokens) {
    if (!Array.isArray(depNodes) || !depNodes.length) return '';
    const shareTokens = Math.max(200, Math.floor(Number(budgetTokens) / depNodes.length) || 200);
    const truncTo = (body, cap) => { let lo = 0, hi = body.length; while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (estimateContentTokens(body.slice(0, mid)) <= cap) lo = mid; else hi = mid - 1; } return body.slice(0, lo); };
    // 47a Phase C-A:Claude 节点的延迟插话随上游上下文注入下游 —— 独立小节,不混入 result(防污染 schema/质量门)。
    const steerSection = d => {
      const ss = Array.isArray(d.deferredSteers) ? d.deferredSteers : [];
      if (!ss.length) return '';
      return '\n[用户插话 · 延迟生效]\n' + ss.map(s => '- ' + String(s).replace(/\s+/g, ' ').trim()).join('\n');
    };
    const out = depNodes.map(d => {
      const header = `### ${d.id} (${d.status}${d.degraded ? ' · 降级' : ''})`;
      const full = String(d.result || d.error || '').replace(/\s+/g, ' ').trim();
      if (estimateContentTokens(full) <= shareTokens) return header + '\n' + full + steerSection(d); // rung1 全文(无损)
      // 对抗轮 P2:防御式扁平化 summary(deriveNodeOutputs 已在源头扁平,此处对 spawn_agent 等直传对象再兜一道)。
      const summ = (typeof d.summary === 'string' && d.summary.trim()) ? d.summary.replace(/\s+/g, ' ').trim() : '';
      if (summ && estimateContentTokens(summ) <= shareTokens) return header + `\n${summ}\n[…精简结论,完整产出见节点 ${d.id} 存档…]` + steerSection(d); // rung2 摘要
      const body = (summ && estimateContentTokens(summ) < estimateContentTokens(full)) ? summ : full; // rung3 截断更短者
      return header + '\n' + truncTo(body, shareTokens) + `\n[…按预算截断,完整产出见节点 ${d.id} 存档…]` + steerSection(d);
    });
    // 对抗轮 P3:总量【硬钳制】—— 旧 32000 总截断被本波移除,而 200-token/依赖下限 + 未计入的 header/标注在高扇入时可累计
    // 超预算(小窗口下甚至击穿窗口)。此处对拼接结果按总预算再截一刀,恢复"预算是硬天花板"不变式。
    const joined = out.join('\n\n');
    return estimateContentTokens(joined) <= Number(budgetTokens) ? joined : truncTo(joined, Number(budgetTokens)) + '\n[…上游上下文按总预算截断…]';
  }
  function agentWorkflowStatusText(status) {
    return ({ queued: '排队中', waiting_resource: '等待资源', waiting: '等待条件', blocked: '阻塞', running: '运行中', paused: '已暂停', succeeded: '已完成', skipped: '已跳过', partial: '部分完成', failed: '失败', rejected: '质量门未通过', interrupted: '已中断', cancelled: '已取消', stopped: '已停止' })[status] || status || '未知';
  }
  function summarizeAgentWorkflowRun(run, opts = {}) {
    const nodes = Array.isArray(run && run.nodes) ? run.nodes : [];
    const title = opts.title || 'Agent 工作流';
    const lines = [`${title}${run && run.id ? `（${run.id}）` : ''}已结束：${agentWorkflowStatusText(run && run.status)}。`];
    const succeeded = nodes.filter(n => n.status === 'succeeded' || n.status === 'skipped').length;
    const rejected = nodes.filter(n => n.status === 'rejected').length; // B8: quality-gate "no" verdicts, not run failures
    lines.push(`节点：成功/跳过 ${succeeded}${rejected ? `，质量门未通过 ${rejected}` : ''}，失败/阻塞 ${nodes.length - succeeded - rejected}，共 ${nodes.length}。`);
    for (const node of nodes) {
      const role = node.roleLabel || node.roleId || node.role || '';
      let summary = '';
      if (node.structuredResult && typeof node.structuredResult === 'object') summary = node.structuredResult.summary || node.structuredResult.verdict || JSON.stringify(node.structuredResult).slice(0, 260);
      if (!summary) summary = String(node.result || node.error || '').replace(/\s+/g, ' ').trim().slice(0, 360);
      lines.push(`- ${node.id}${role ? `（${role}）` : ''}: ${agentWorkflowStatusText(node.status)}${summary ? ` — ${summary}` : ''}`);
    }
    return lines.join('\n');
  }

  function recordAgentNodeProgress(run, node, evt) {
    if (!node || !evt || evt.type === 'raw_line') return;
    let text = '';
    let kind = '';
    if (evt.type === 'subagent') {
      if (evt.state === 'start') text = `子 Agent 启动${evt.model ? ` · ${evt.model}` : ''}${evt.toolTier ? ` · ${evt.toolTier}` : ''}`;
      else if (evt.state === 'retry') text = `子 Agent 重试 ${evt.attempt || 0}/${evt.maxAttempts || 0}${evt.reason ? ` · ${evt.reason}` : ''}`;
      else if (evt.state === 'end') text = `子 Agent ${evt.ok ? '完成' : '失败'}${evt.resultChars != null ? ` · ${evt.resultChars} 字` : ''}`;
    } else if (evt.type === 'subagent_progress') { kind = 'gen'; text = evt.note || `生成中 · ${Number(evt.chars) || 0} 字`; }
    else if (evt.type === 'subagent_steered') { text = `${evt.autoWrapUp ? '自动收尾指令' : '插话'} · ${String(evt.text || '').slice(0, 80)}`; }
    else if (evt.type === 'subagent_wrapup_forced') { text = '自动收尾宽限期已耗尽 · 已中止本节点'; }
    else if (evt.type === 'subagent_pool_proposed') { text = `提案任务 · ${String(evt.task || '').replace(/\s+/g, ' ').trim().slice(0, 50)}`; }
    else if (evt.type === 'subagent_mail_out') { text = `发消息 → ${evt.target || ''} · ${String(evt.text || '').replace(/\s+/g, ' ').trim().slice(0, 50)}`; }
    else if (evt.type === 'subagent_mail_in') { text = `收到 ${evt.sender || ''} 消息 · ${String(evt.text || '').replace(/\s+/g, ' ').trim().slice(0, 50)}`; }
    else if (evt.type === 'tool_use') text = `调用工具 ${evt.name || ''}`.trim();
    else if (evt.type === 'tool_result') text = `工具返回 ${evt.isError ? '错误' : '成功'}${evt.id ? ` · ${evt.id}` : ''}`;
    else if (evt.type === 'agent_resource') text = evt.state === 'waiting' ? `等待资源：${(evt.resources || []).join(', ')}` : evt.state === 'acquired' ? `获得资源：${(evt.resources || []).join(', ')}` : evt.state === 'released' ? `释放资源：${(evt.resources || []).join(', ')}` : '';
    // v1.x (B10): keep node.status honest about TOOL-level resource waits. runSubAgentCore acquires a per-tool
    // lease that can block on another node's resource; node-LEVEL waits already flip status via onResourceWait,
    // but the tool level has no node handle, so without this the polling UI shows 运行中 while the node is parked.
    // Heartbeats, mail and streamed text are not proof that a blocked lease resumed.
    // Resume on the actual acquired event, or a tool result after the waiting call ended.
    if (evt.type === 'agent_resource' && evt.state === 'waiting') { node.status = 'waiting_resource'; node.waitingForResources = Array.isArray(evt.resources) ? evt.resources.slice() : []; }
    else if (node.status === 'waiting_resource' && (evt.type === 'tool_result' || evt.type === 'agent_resource' && evt.state === 'acquired')) { node.status = 'running'; node.waitingForResources = []; }
    if (!text) return;
    if (!Array.isArray(node.progressLog)) node.progressLog = [];
    const last = node.progressLog[node.progressLog.length - 1];
    // v1.4.6 (C): coalesce consecutive streamed 'gen' milestones (Claude text growth fires one every +N
    // chars) in place so the feed stays compact; any non-gen entry (e.g. the final 子 Agent 完成 conclusion)
    // appends independently so the persisted log still proves progress landed mid-execution.
    if (kind === 'gen' && last && last.kind === 'gen') { last.text = text; last.at = nowIso(); }
    else node.progressLog.push(kind ? { at: nowIso(), text, kind } : { at: nowIso(), text });
    if (node.progressLog.length > 80) node.progressLog = node.progressLog.slice(-80);
    // 第29波(§29a): 离散里程碑同步落事件日志 —— 增量客户端靠它感知工具级进展,不再为进度轮询全量快照。
    // gen(流式字数增长,每 +N 字一发且在 progressLog 原地合并)刻意不落 —— 高频噪声会撑爆取证文件;
    // 其时效由客户端对活跃 run 的低频快照刷新兜底。事件与 progressLog 同文案,客户端可直接 append 镜像。
    if (kind !== 'gen') appendAgentRunEvent(run, { type: 'node_progress', nodeId: node.id, data: { text: text.slice(0, 200) } });
    // v1.4.6 (A): persistence is now the throttledSaveRun called right after this in nodeEvent, so a long
    // node no longer rewrites the whole run to disk on every single subagent event (a known write cost).
  }

  // Execute a complete dependency graph without asking the parent model to schedule every stage. The graph
  // and node transitions are persisted after each state change so progress remains inspectable after a crash.
  // 团队模式 v2 (A2 防提案环): 从 proposerId 沿 fromPool 链上溯,返回其链深。普通节点=0、物化的 pool 节点=1、
  // 由 pool 节点再提案物化的=2。提案时校验 proposer 链深 < POOL_CHAIN_MAX(即 depth≥2 的节点不得再提案)。

  return { buildUpstreamContext, summarizeAgentWorkflowRun, recordAgentNodeProgress };
}

module.exports = { createAgentWorkflowReport };
