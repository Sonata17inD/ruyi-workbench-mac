'use strict';

const fsp = require('node:fs/promises');
const { safeJsonParse } = require('./ordinary-json.cjs');

function createAgentInterventionActions({
  activeAgentRuns, agentRunFile, nowIso, readConfig, loadSession, normalizeCwd, getAgentRoleLibrary,
  materializePoolItem, applyReplanPatch, bumpRunIntervention, appendAgentRunEvent, saveAgentRun,
}) {
  return function agentInterventionAction({ type, action, missionId, interventionId, command }) {
    let poolContext = null;
    let replanContext = null;

    async function preflight(authoritative) {
      if (type === 'replan') {
        const runId = String(authoritative.runId || '');
        if (command.requestRunId && String(command.requestRunId) !== runId) return { ok: false, reason: 'not_found' };
        // R5: patch 审批不要求 run live —— 节点终态后 run 通常已收尾离开 activeAgentRuns。
        // 优先用 live 内存态(最新),否则读 persisted run JSON(已收尾仍可审批)。
        const live = activeAgentRuns.get(runId);
        let runObj = null;
        if (live && live.run && !live.closing) {
          if (live.run.sessionId !== missionId) return { ok: false, reason: 'not_found' };
          runObj = live.run;
        } else {
          try { runObj = safeJsonParse(await fsp.readFile(agentRunFile(missionId, runId), 'utf8'), null); } catch {}
          if (!runObj || runObj.sessionId !== missionId) return { ok: false, reason: 'run_not_found', runId, message: 'run is not found' };
        }
        const patch = (Array.isArray(runObj.replanPatches) ? runObj.replanPatches : []).find(p => p && String(p.id) === interventionId);
        if (!patch || patch.status !== 'pending') return { ok: false, reason: 'replan_patch_unavailable', runId, message: 'replan patch is no longer pending' };
        replanContext = { runId, runObj, patch };
        return { ok: true };
      }

      const runId = String(authoritative.runId || '');
      if (command.requestRunId && String(command.requestRunId) !== runId) return { ok: false, reason: 'not_found' };
      const live = activeAgentRuns.get(runId);
      if (!live || !live.run || live.closing) {
        let persisted = null;
        try { persisted = safeJsonParse(await fsp.readFile(agentRunFile(missionId, runId), 'utf8'), null); } catch {}
        const reason = persisted && persisted.status === 'paused' ? 'run_paused' : 'run_not_live';
        return { ok: false, reason, runId, message: reason === 'run_paused' ? 'run is paused; resume it before deciding' : 'run is not live' };
      }
      if (live.run.sessionId !== missionId) return { ok: false, reason: 'not_found' };
      if (live.stopRequested || (live.ctrl && live.ctrl.signal && live.ctrl.signal.aborted)) {
        return { ok: false, reason: 'run_stopping', runId, message: 'run is stopping' };
      }
      const item = (Array.isArray(live.run.taskPool) ? live.run.taskPool : []).find(p => p && String(p.id) === interventionId);
      if (!item || item.status !== 'proposed') return { ok: false, reason: 'pool_item_unavailable', runId, message: 'pool item is no longer proposed' };
      let config = null, cwd = '', roleLibrary = new Map();
      if (action === 'approve') {
        try {
          config = await readConfig();
          const session = await loadSession(missionId);
          cwd = normalizeCwd(session && session.cwd, config.defaultWorkspace);
          roleLibrary = new Map((await getAgentRoleLibrary(cwd, config)).map(role => [role.id, role]));
        } catch { /* preserve the existing empty-role-library fallback */ }
        const dryRun = { ...live.run, nodes: Array.isArray(live.run.nodes) ? [...live.run.nodes] : [] };
        const dry = materializePoolItem(dryRun, { ...item }, { roleLibrary, cwd, config, dryRun: true });
        if (!dry.ok) return { ok: false, reason: dry.reason || 'pool_materialize_rejected', runId, message: dry.error || 'pool item cannot be materialized' };
      }
      poolContext = { runId, live, item, config, cwd, roleLibrary };
      return { ok: true };
    }

    async function execute() {
      if (type === 'replan') {
        const { runObj, patch } = replanContext;
        if (patch.status !== 'pending') return { ok: false, reason: 'run_state_changed' };
        if (action === 'reject') {
          patch.status = 'rejected'; patch.decidedAt = nowIso();
          bumpRunIntervention(runObj, 'replan_reject');
          appendAgentRunEvent(runObj, { type: 'run_replan', data: { action: 'rejected', patchId: interventionId, by: String(command.decidedBy || 'user') } });
          await saveAgentRun(runObj);
          return { ok: true, patchId: interventionId };
        }
        if (!Array.isArray(patch.changes) || patch.changes.length === 0) return { ok: false, reason: 'replan_changes_pending', message: '重规划提案尚未补充 changes，暂不能应用；请先由 review 角色填充变更项，或拒绝该提案' };
        const ap = applyReplanPatch(runObj, interventionId);
        if (!ap.ok) return { ok: false, reason: 'replan_apply_failed', message: ap.error || '' };
        patch.decidedAt = nowIso();
        bumpRunIntervention(runObj, 'replan_approve');
        appendAgentRunEvent(runObj, { type: 'run_replan', data: { action: 'applied', patchId: interventionId, by: String(command.decidedBy || 'user'), applied: ap.applied } });
        await saveAgentRun(runObj);
        return { ok: true, patchId: interventionId, applied: ap.applied };
      }
      const { runId, live, item, config, cwd, roleLibrary } = poolContext;
      if (activeAgentRuns.get(runId) !== live || live.closing || live.stopRequested || (live.ctrl && live.ctrl.signal && live.ctrl.signal.aborted) || item.status !== 'proposed') {
        return { ok: false, reason: 'run_state_changed' };
      }
      if (action === 'reject') {
        item.status = 'rejected'; item.decidedBy = String(command.decidedBy || 'user'); item.decidedAt = nowIso();
        bumpRunIntervention(live.run, 'pool_reject');
        appendAgentRunEvent(live.run, { type: 'run_pool', data: { action: 'rejected', poolId: interventionId, by: String(command.decidedBy || 'user') } });
        await saveAgentRun(live.run);
        return { ok: true, poolId: interventionId };
      }
      const mat = materializePoolItem(live.run, item, { roleLibrary, cwd, config });
      if (!mat.ok) return { ok: false, reason: mat.reason || 'pool_materialize_failed', message: mat.error || '' };
      item.status = 'materialized'; item.decidedBy = String(command.decidedBy || 'user'); item.decidedAt = nowIso(); item.resultNodeId = mat.node.id;
      bumpRunIntervention(live.run, 'pool_approve');
      appendAgentRunEvent(live.run, { type: 'run_pool', data: { action: 'materialized', poolId: interventionId, by: String(command.decidedBy || 'user'), nodeId: mat.node.id } });
      live.poolGraceArmed = true;
      live.wakeScheduler?.();
      if (live.inPoolGrace && Array.isArray(live.resumeWaiters)) {
        const waiters = live.resumeWaiters.splice(0);
        for (const wake of waiters) wake();
      }
      await saveAgentRun(live.run);
      return { ok: true, poolId: interventionId, nodeId: mat.node.id };
    }

    return { preflight, execute };
  };
}

module.exports = { createAgentInterventionActions };
