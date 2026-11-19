'use strict';

const fsp = require('node:fs/promises');
const { json, apiFailure, readJsonBody, send } = require('./http-protocol.cjs');
const { safeJsonParse } = require('./ordinary-json.cjs');

function createAgentRunRoutes({
  tokenOk, safeSessionId, activeAgentRuns, agentRunActionCommand, decideIntervention, agentRunFile,
  AgentRunStore, applyAgentWorktree, cleanupAgentWorktree, bumpMissionChangeSeq, RUYI_EVENTS, EventStreamHooks,
}) {
  const { listAgentRuns, listAgentRunDigests, agentRunDigestRow, readAgentRunEvents, agentRunEventsFile } = AgentRunStore;

  async function handleAgentRunApiRoutes(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/agent-runs') {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const listUrl = new URL(req.url, 'http://x');
      const sessionId = safeSessionId(listUrl.searchParams.get('sessionId'));
      if (!sessionId) return send(res, json({ ok: false, error: 'sessionId required' }, 400));
      // digest 视图只要标量:走按 mtime+size 缓存的 listAgentRunDigests(08),未变的 run 文件零读盘;完整视图照旧读全量。
      const digestView = listUrl.searchParams.get('view') === 'digest';
      const readRuns = () => (digestView ? listAgentRunDigests(sessionId) : listAgentRuns(sessionId));
      const liveBefore = [...activeAgentRuns.keys()]; let runs = await readRuns(); if (liveBefore.some(id => !activeAgentRuns.has(id))) runs = await readRuns();   // 读盘期间有 run 收尾（终稿落盘后才撤活对象）：先前读到的是收尾前快照、却已不算 live（提案仍 proposed）→ 重读一次拿终稿
      // A live run's in-memory state is newer than its throttled crash-recovery snapshot. Return a detached
      // copy of that state for the full polling view, otherwise short nodes can finish before their intermediate
      // progressLog snapshot is ever observable and the UI falsely looks frozen.
      // digest(每 2s 轮询)只从这里读标量、不外发也不改对象:浅展开即与深拷贝读到的值逐字段相同,
      // 省掉每个 live run 整份节点/结果/progressLog 的 JSON 往返。完整视图照旧深拷贝(对象要外发)。
      for (let i = 0; i < runs.length; i += 1) {
        const live = activeAgentRuns.get(runs[i].id);
        if (!live || !live.run) continue;
        runs[i] = { ...(digestView ? live.run : JSON.parse(JSON.stringify(live.run))), live: true, paused: !!live.paused };
      }
      // 第29波(§29a): digest 轻量视图 —— 增量客户端每 tick 只拉这份 run 级标量做变更探测(eventSeq/status/
      // updatedAt),不再每 2s 重传全部节点(单节点 result≤24KB + roleSnapshot 8KB prompt,历史终态 run 每 tick
      // 白传)。live run 的 eventSeq/status/updatedAt 以【内存】为准(快照节流 1.5s,磁盘恒旧);快照仍是唯一
      // 权威状态源,digest 只是"该不该去拉"的信号。
      if (digestView) {
        // runs 此刻是磁盘摘要(live 且有内存对象的已被上面换成 live.run 的浅展开);逐行装配见 08 agentRunDigestRow。
        const digest = runs.map(r => agentRunDigestRow(r, activeAgentRuns.get(r.id)));
        return send(res, json({ ok: true, view: 'digest', runs: digest }));
      }
      return send(res, json({ ok: true, runs }));
    }
    // 第29波(§29a): 增量事件消费 —— 客户端记住 lastSeq,断线/重开后 afterSeq=lastSeq 重发即天然补播;
    // seq 严格单调(25.3)保证补播无重无漏。必须排在文件底部 GET /api/agent-runs/:id 通配前缀分支之前,
    // 否则被吞。跨会话防护与快照端点同源:事件文件按 sessionId 分目录,错 session 只会 404→空数组。
    if (req.method === 'GET' && pathname.startsWith('/api/agent-runs/') && pathname.endsWith('/events')) {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const evUrl = new URL(req.url, 'http://x');
      const sessionId = safeSessionId(evUrl.searchParams.get('sessionId'));
      const evParts = pathname.split('/').filter(Boolean); // ['api','agent-runs',runId,'events']
      const runId = evParts.length === 4 ? safeSessionId(evParts[2]) : null;
      if (!sessionId || !runId) return send(res, json({ ok: false, error: 'sessionId/runId required' }, 400));
      const afterSeq = Number(evUrl.searchParams.get('afterSeq')) || 0;
      const { events, hasMore } = await readAgentRunEvents(sessionId, runId, afterSeq, Number(evUrl.searchParams.get('limit')) || 0);
      return send(res, json({ ok: true, runId, afterSeq, events, hasMore }));
    }
    if (req.method === 'POST' && pathname.startsWith('/api/agent-runs/')) {
      const parts = pathname.split('/').filter(Boolean);
      const runId = safeSessionId(parts[2]);
      const body = await readJsonBody(req);
      const sessionId = safeSessionId(body.sessionId);
      const action = String(body.action || '');
      if (!sessionId || !runId) return send(res, json({ ok: false, error: 'sessionId/runId required' }, 400));
      const live = activeAgentRuns.get(runId);
      // runId 是全局命名空间（不像持久化文件那样按 sessionId 分目录），live runtime 挂在内存 Map 里也不天然按
      // sessionId 隔离——不加这层校验，一个知道/猜到 runId 的会话就能 pause/resume/stop/steer 另一个会话正在跑的
      // 工作流。对齐 apply_isolation 从文件读到 run 后做的 run.sessionId !== sessionId 校验语义，统一在这里拦截，
      // 对 pause/resume/stop/steer_node 全部生效；resume 的冷启动分支（live 为空）走 launchPersistedAgentRun，
      // 本来就按 sessionId 找持久化文件，不受影响。
      if (live && live.run && live.run.sessionId && live.run.sessionId !== sessionId) return send(res, json({ ok: false, error: 'agent run not found' }, 404));
      // Five run controls share the same command as Steward. Other actions are handled below.
      {
        const cmd = await agentRunActionCommand({ sessionId, runId, action, nodeId: body.nodeId, text: body.text, cascade: body.cascade === true });
        if (cmd) return send(res, json(cmd.body, cmd.status));
      }
      if (action === 'apply_isolation') {
        if (live) return send(res, json({ ok: false, error: '请先等待当前运行结束' }, 409));
        const nodeId = String(body.nodeId || '').trim();
        const run = safeJsonParse(await fsp.readFile(agentRunFile(sessionId, runId), 'utf8').catch(() => ''), null);
        if (!run || run.sessionId !== sessionId) return send(res, json({ ok: false, error: 'agent run not found' }, 404));
        const applied = await applyAgentWorktree(run, nodeId).catch(e => ({ ok: false, error: String(e && (e.gitStderr || e.message) || e), ...(e && e.cleanupIncomplete ? { cleanupIncomplete: true } : {}), ...(e && e.applicationUnconfirmed ? { applicationUnconfirmed: true, applied: e.applied === true, commit: e.commit } : {}) }));
        return send(res, json(applied, applied.ok ? 200 : 409));
      }
      // 75b compatibility adapter: pool approval/rejection shares decideIntervention with the Mission contract.
      if (action === 'pool_approve' || action === 'pool_reject') {
        const poolId = String(body.poolId || '').trim();
        if (!poolId) return send(res, json({ ok: false, error: 'poolId required' }, 400));
        const result = await decideIntervention({
          missionId: sessionId,
          interventionId: poolId,
          requestRunId: runId,
          payload: { action: action === 'pool_approve' ? 'approve' : 'reject' },
          source: 'legacy_pool',
          contractRequest: false,
        });
        if (result.status !== 200) {
          const reason = String(result.body && result.body.reason || '');
          if (!live || live.closing) return send(res, json({ ok: false, error: '运行已结束;可在新运行中执行该任务' }, 409));
          if (reason === 'not_found') return send(res, json({ ok: false, error: '提案不存在' }, 404));
          const item = (Array.isArray(live.run.taskPool) ? live.run.taskPool : []).find(p => p && String(p.id) === poolId);
          if (item && item.status !== 'proposed') return send(res, json({ ok: false, error: `该提案已处理(${item.status})` }, 409));
          const message = result.body && result.body.error && result.body.error.message;
          return send(res, json({ ok: false, error: message || '运行已结束或提案已处理' }, result.status === 404 ? 404 : 409));
        }
        return send(res, json({
          ok: true,
          status: action === 'pool_approve' ? 'materialized' : 'rejected',
          poolId,
          ...(result.body.nodeId ? { nodeId: result.body.nodeId } : {}),
        }));
      }
      return send(res, json({ ok: false, error: 'unknown action' }, 400));
    }
    if (req.method === 'DELETE' && pathname.startsWith('/api/agent-runs/')) {
      const runId = safeSessionId(pathname.slice('/api/agent-runs/'.length));
      const sessionId = safeSessionId(new URL(req.url, 'http://x').searchParams.get('sessionId'));
      if (!sessionId || !runId) return send(res, json({ ok: false, error: 'sessionId/runId required' }, 400));
      if (activeAgentRuns.has(runId)) return send(res, json({ ok: false, error: '运行中的工作流不能删除' }, 409));
      try {
        const file = agentRunFile(sessionId, runId);
        const run = safeJsonParse(await fsp.readFile(file, 'utf8'), null);
        for (const node of (run && run.nodes || [])) if (node.isolation) await cleanupAgentWorktree(node.isolation);
        await fsp.unlink(file);
        AgentRunStore.invalidateDigest(file);   // digest 摘要缓存(08):文件没了条目一并撤
        // 对抗轮修(第25波): 删除快照必须连带删姊妹事件日志 —— 用户删「运行记录」的心智模型是数据消失,
        // 取证 ndjson(含时间线/错误切片)不该在删除后无限期残留。
        await fsp.unlink(agentRunEventsFile(sessionId, runId)).catch(() => {});
        await fsp.unlink(agentRunEventsFile(sessionId, runId) + '.gz').catch(() => {}); // v1.9 数据管家: 归档压缩变体一并删
      } catch { return send(res, json({ ok: false, error: 'agent run not found' }, 404)); }
      await bumpMissionChangeSeq(sessionId, {
        type: 'run_deleted', cursor: { runId }, detail: { runId },
      });
      RUYI_EVENTS.emit('thread.state', { sessionId });   // 128f-⑫:行上的「最后一次班组」换了一条(或没了)
      return send(res, json({ ok: true }));
    }
    if (req.method === 'GET' && pathname.startsWith('/api/agent-runs/')) {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const sessionId = safeSessionId(new URL(req.url, 'http://x').searchParams.get('sessionId'));
      const runId = safeSessionId(pathname.slice('/api/agent-runs/'.length));
      if (!sessionId || !runId) return send(res, apiFailure('agent_run.id_required', {}, 'sessionId/runId required', 400));
      // 第29波(§29a): live run 以【内存】对象下发 —— 增量客户端在 settle 类事件后靠本端点刷新单 run 状态,
      // 磁盘快照节流 1.5s 恒旧,读盘会让客户端 lastSeq 与状态错位(拿旧状态配新 seq)。JSON.stringify 同步
      // 执行,事件循环内原子,无撕裂读。归属校验与 POST action 的 live 分支同源(sessionId 不符 = 404)。
      const liveOne = activeAgentRuns.get(runId);
      if (liveOne && liveOne.run) {
        if (liveOne.run.sessionId !== sessionId) return send(res, json({ ok: false, error: 'agent run not found' }, 404));
        return send(res, json({ ok: true, run: { ...liveOne.run, live: true, paused: !!liveOne.paused } }));
      }
      try {
        const run = safeJsonParse(await fsp.readFile(agentRunFile(sessionId, runId), 'utf8'), null);
        if (!run) throw new Error('invalid run');
        if (EventStreamHooks.projectAgentMessageReceipts) EventStreamHooks.projectAgentMessageReceipts(run);
        return send(res, json({ ok: true, run }));
      } catch { return send(res, json({ ok: false, error: 'agent run not found' }, 404)); }
    }
    return false;
  }

  return handleAgentRunApiRoutes;
}

module.exports = { createAgentRunRoutes };
