'use strict';

function createAgentRunControl({
  activeAgentRuns, safeSessionId, redact, nowIso, STEER_QUEUE_MAX,
  appendAgentRunEvent, saveAgentRun, bumpRunIntervention, launchPersistedAgentRun, nodeDeliveryEligibility,
}) {
  // 135c:线程内后台任务条里的「子代理 / 班组」两类。只看【活着的】run(activeAgentRuns,进程内真值):
  // 跑完的 run 按拍板「跑完即消失」不出现,结果照旧走 background.completed 的 toast 与对话里的回执。
  // sessionId 传 null = 全部线程(左栏计数用)。tail 取在跑节点最近一条 progressLog,过 redact 裁 160。
  const BACKGROUND_RUN_DONE = new Set(['succeeded', 'failed', 'skipped', 'cancelled', 'stopped', 'partial']);
  function sessionBackgroundRunRows(sessionId) {
    const sid = sessionId ? safeSessionId(sessionId) : '';
    const rows = [];
    for (const [runId, live] of activeAgentRuns) {
      const run = live && live.run;
      if (!run || !run.sessionId) continue;
      if (sid && run.sessionId !== sid) continue;
      const nodes = Array.isArray(run.nodes) ? run.nodes : [];
      let tail = '', tailAt = '';
      for (const node of nodes) {
        if (!node || node.status !== 'running' || !Array.isArray(node.progressLog) || !node.progressLog.length) continue;
        const last = node.progressLog[node.progressLog.length - 1];
        if (last && String(last.at || '') >= tailAt) { tailAt = String(last.at || ''); tail = String(last.text || ''); }
      }
      const first = nodes[0] || {};
      rows.push({
        id: 'run:' + runId,
        kind: (run.kind === 'spawn_agent' || nodes.length === 1) ? 'agent' : 'run', // 代理模式 v2:单节点 run 读作「代理」,多节点读作「班组」
        runId,
        sessionId: run.sessionId,
        name: String(run.title || first.task || first.id || runId).replace(/\s+/g, ' ').slice(0, 120),
        startedAt: run.createdAt || '',
        status: live.stopRequested ? 'stopping' : live.paused ? 'paused' : String(run.status || 'running'),
        progress: { done: nodes.filter(n => n && BACKGROUND_RUN_DONE.has(n.status)).length, total: nodes.length },
        tail: tail ? redact(tail.replace(/\s+/g, ' ')).slice(0, 160) : '',
      });
    }
    return rows;
  }

  // Shared by the Agent Run endpoint, session task controls, and Steward. Each caller passes the session owner.
  async function agentRunActionCommand(input) {
    const o = (input && typeof input === 'object') ? input : {};
    const sessionId = safeSessionId(o.sessionId);
    const runId = safeSessionId(o.runId);
    const action = String(o.action || '');
    if (!sessionId || !runId) return { status: 400, body: { ok: false, error: 'sessionId/runId required' } };
    const live = activeAgentRuns.get(runId);
    if (live && live.run && live.run.sessionId && live.run.sessionId !== sessionId) return { status: 404, body: { ok: false, error: 'agent run not found' } };
    if (action === 'pause') {
      if (!live) return { status: 409, body: { ok: false, error: '工作流当前未运行' } };
      // 对抗轮 P3(#8): 计数按【状态迁移】幂等 —— 对已暂停 run 重复 POST(UI 按钮态滞后期双击/双面板)端点行为
      // 无害但计数器会被 UI 时延系统性抬高。只在真正 running→paused 时计一次干预(与本文件 pool_approve 先查
      // status!=='proposed' 的"无效重复不计干预"模式一致)。
      const wasPaused = live.paused === true;
      live.paused = true; live.run.pauseRequestedAt = nowIso();
      if (!wasPaused) bumpRunIntervention(live.run, 'pause'); // 29c(状态迁移才计)
      appendAgentRunEvent(live.run, { type: 'run_paused', data: { reason: 'user' } }); // 25.3
      await saveAgentRun(live.run);
      return { status: 200, body: { ok: true, state: 'pausing' } };
    }
    if (action === 'resume') {
      if (live) {
        // Reset the idle clock ATOMICALLY with clearing paused: the watchdog reads live.lastActivityAt, so by the
        // time it observes paused=false the clock is already fresh -> no false idle-abort right after a long pause.
        const wasPaused = live.paused === true; // 对抗轮 P3(#8): 仅 paused→running 计一次(对运行中 run resume 是 no-op,不计)
        live.paused = false; live.lastActivityAt = Date.now(); const waiters = live.resumeWaiters.splice(0); for (const wake of waiters) wake();
        if (wasPaused) bumpRunIntervention(live.run, 'resume'); // 29c
        appendAgentRunEvent(live.run, { type: 'run_resume_requested', data: { mode: 'warm' } }); // 25.3
        saveAgentRun(live.run).catch(() => {}); // 对抗轮修: 追写快照,让 eventSeq 尽快落盘(缩小崩溃重号窗口)
        return { status: 200, body: { ok: true, state: 'running' } };
      }
      return { status: 200, body: await launchPersistedAgentRun({ sessionId, runId, interventionKind: 'resume' }) };
    }
    if (action === 'stop') {
      if (!live) return { status: 409, body: { ok: false, error: '工作流当前未运行' } };
      const wasStopping = live.stopRequested === true; // 对抗轮 P3(#8): 重复 stop 不重复计
      live.stopRequested = true; live.paused = false; try { if (live.ctrl) live.ctrl.abort(); } catch {}
      const waiters = live.resumeWaiters.splice(0); for (const wake of waiters) wake();
      if (!wasStopping) bumpRunIntervention(live.run, 'stop'); // 29c
      appendAgentRunEvent(live.run, { type: 'run_stop_requested' }); // 25.3
      saveAgentRun(live.run).catch(() => {}); // 对抗轮修: 同 resume —— 追写快照缩小 eventSeq 崩溃重号窗口
      return { status: 200, body: { ok: true, state: 'stopping' } };
    }
    if (action === 'retry_node') {
      if (live) return { status: 409, body: { ok: false, error: '请先等待或停止当前运行' } };
      const nodeId = String(o.nodeId || '').trim();
      return { status: 200, body: await launchPersistedAgentRun({ sessionId, runId, retryNodeId: nodeId, retryCascade: o.cascade === true, interventionKind: 'retry_node' }) };
    }
    // Directional node steering. Provider nodes consume at their next iteration boundary; Claude nodes consume
    // through the live stream-json stdin channel. Queued nodes keep the message until their model starts.
    if (action === 'steer_node') {
      if (!live) return { status: 409, body: { ok: false, error: '工作流当前未运行，无法插话' } };
      // 停止收尾窗口：stop 已经请求（或 ctrl 已中止）之后，节点即将被标记 cancelled，不会再有下一次迭代边界来
      // 消费插话队列；此时接受插话只会让用户误以为它会生效，直接拒绝更诚实。
      if (live.stopRequested || (live.ctrl && live.ctrl.signal && live.ctrl.signal.aborted)) return { status: 409, body: { ok: false, error: '工作流正在停止，无法插话' } };
      const nodeId = String(o.nodeId || '').trim();
      if (!nodeId) return { status: 400, body: { ok: false, error: 'nodeId required' } };
      // 团队模式 v2 (B1): 投递资格判定与 send_to_agent 共用同一小函数(不复制两份),reason 各自映射为本处既有措辞。
      const elig = nodeDeliveryEligibility(live.run, nodeId, { allowClaude: true });
      if (elig.reason === 'not_found') return { status: 404, body: { ok: false, error: '节点不存在' } };
      if (elig.reason === 'deterministic_gate') return { status: 409, body: { ok: false, error: '确定性质量门节点不经过模型，无法插话' } };
      if (elig.reason === 'terminal') return { status: 409, body: { ok: false, error: '节点已结束，无法插话' } };
      if (!elig.ok) return { status: 409, body: { ok: false, error: { code: 'agent_run.mailbox_closed', params: { reason: elig.reason }, message: '节点正在收尾，无法插话' } } };
      const text = String(o.text || '').trim().slice(0, 2000);
      if (!text) return { status: 400, body: { ok: false, error: '插话内容不能为空' } };
      if (!live.steerQueues) live.steerQueues = new Map();
      let q = live.steerQueues.get(nodeId);
      if (!q) { q = []; live.steerQueues.set(nodeId, q); }
      if (q.length >= STEER_QUEUE_MAX) return { status: 409, body: { ok: false, error: '该节点插话队列已满' } };
      q.push(text);
      bumpRunIntervention(live.run, 'steer_node'); // 29c(队列在内存,计数随下一次快照落盘即可,不额外写盘)
      return { status: 200, body: { ok: true, queued: q.length, live: elig.node.status === 'running' } };
    }
    return null; // 本函数不认识的动作(apply_isolation / pool_* / 未知)——由路由沿用原分支
  }

  return { sessionBackgroundRunRows, agentRunActionCommand };
}

module.exports = { createAgentRunControl };
