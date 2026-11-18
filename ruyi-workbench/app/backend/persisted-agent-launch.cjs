'use strict';

const fsp = require('node:fs/promises');
const { activeOpenAiProvider, resolveProvider } = require('./provider-config.cjs');
const { resolvePermissionMode } = require('./agent-role-policy.cjs');

function createPersistedAgentLaunch({
  activeAgentRuns, activeChildren, agentRunFile, safeJsonParse, nowIso, readConfig,
  loadSession, mutateSession, runs, EventStreamHooks, runAgentWorkflow, deliverAgentRunEnvelope,
}) {
  const { bumpRunIntervention, saveAgentRun, syncRunEventSeq } = runs;

  // 撤掉某个 run 的「信封已送达」登记(盘上的会话头 + 活回合手里的那份)。只给人工 resume / retry_node 用。
  async function unmarkAgentEnvelopeDelivered(sessionId, runId) {
    const id = EventStreamHooks.agentEnvelopeJobId ? EventStreamHooks.agentEnvelopeJobId(runId) : 'agent:' + String(runId || '');
    const drop = s => { if (s && Array.isArray(s.backgroundJobSeen)) s.backgroundJobSeen = s.backgroundJobSeen.filter(x => x !== id); };
    await mutateSession(sessionId, drop, { writer: 'agent_envelope_rearm' }).catch(() => {});
    const reg = activeChildren.get(sessionId);
    if (reg && reg.session) drop(reg.session);
  }
  async function launchPersistedAgentRun({ sessionId, runId, retryNodeId, retryCascade, interventionKind, configOverride }) {
    if (activeAgentRuns.has(runId)) return { ok: false, error: '该工作流已在运行' };
    let run;
    try { run = safeJsonParse(await fsp.readFile(agentRunFile(sessionId, runId), 'utf8'), null); } catch { run = null; }
    if (!run) return { ok: false, error: 'agent run not found' };
    await syncRunEventSeq(run);   // 对抗轮修: 磁盘装载点快进 eventSeq(见 syncRunEventSeq 注释)
    if (interventionKind) bumpRunIntervention(run, interventionKind); // 29c: 冷 resume/retry_node 是人工干预(boot 自动续跑不传,不计)
    // 第40波: boot 自动续跑扫到 N 个 run 时,逐个 readConfig 是 N 次盘 IO;调用方(boot sweep)已持有刚读的
    // config,直接传入。人工 HTTP resume 不传 —— 用户可能刚改完 permissionMode,必须读新鲜值。
    const config = configOverride || await readConfig();
    const provider = resolveProvider(config, run.providerId) || activeOpenAiProvider(config);
    // Only the nodes that actually need an OpenAI Provider require one to be configured to resume —
    // an all-Claude-engine run resumes fine with none (see the dual-engine note on the launch handler).
    const needsProvider = (Array.isArray(run.nodes) ? run.nodes : []).some(n => (n.engine || 'openai') === 'openai');
    if (needsProvider && !provider) return { ok: false, error: '当前没有可用的 Provider，无法恢复工作流（该运行含 OpenAI 引擎节点）' };
    const parentSession = await loadSession(sessionId).catch(() => null);
    if (!parentSession) return { ok: false, error: 'session not found' };
    const onEvent = () => {}; // management UI polls persisted state; no chat stream is required
    // 回「已受理」之前先等到这次运行登记进 activeAgentRuns(或者它在登记前就退出了)。修前是发起就回:runAgentWorkflow
    // 在登记之前还有几处 await(读角色库、落盘),受理之后紧跟着的 pause / stop / 插话会看到「工作流当前未运行」被 409 拒掉
    // —— 用户点「重试」再立刻点「暂停」就会撞上;高负载下 subagent.e2e 的 (a4) 稳定复现(master 同样)。
    let markRegistered = null;
    const registered = new Promise(resolve => { markRegistered = resolve; });
    // 后台 run 续跑 / 重试后照样要送达一份交付信封(修前续跑不传 onComplete,重启打断后自动续跑、用户重试的后台 run 跑完
    // 模型永远收不到完成通知)。人工干预的那次先把「已送达」登记撤掉:上一轮失败的信封可能已经被读过,新结果要再送一次。
    const background = run.background === true;
    if (background && interventionKind) await unmarkAgentEnvelopeDelivered(sessionId, runId);
    const finished = runAgentWorkflow({
      parentSession, provider, config, onEvent, existingRun: run, retryNodeId, retryCascade,
      ...(background ? { onComplete: r => deliverAgentRunEnvelope(sessionId, r) } : {}),
      // maxNodes is unused on the existingRun path (only the fresh-run branch checks it against rawNodes.length)
      // but pass the same config-driven ceiling for consistency rather than a stray hardcoded 32.
      // 2026-10:续跑也按线程的生效档(会话级 > 全局),与首跑、恢复分级(agentRunPermissionMode)同一个解析。
      permModeOverride: resolvePermissionMode({ session: parentSession, config }), maxNodes: Math.max(0, Number(config.agentWorkflowMaxNodes) || 0),
      onRegistered: () => markRegistered(),
    }).catch(async e => {
      run.status = 'failed'; run.error = String(e && e.message || e); run.completedAt = nowIso();
      await saveAgentRun(run).catch(() => {}); activeAgentRuns.delete(runId);
      return { ok: false, error: run.error };
    });
    // finished 先到 = 登记之前就退出了(未知 nodeId、运行记录没有节点、已在运行、启动时抛错)—— 那是没受理,照实回错;
    // 修前一律回 accepted,用户点了「重试」什么都没发生也看不到原因。
    const first = await Promise.race([registered.then(() => null), finished]);
    if (first && first.ok === false) return { ok: false, error: first.error || '工作流未能启动', runId };
    return { ok: true, accepted: true, runId };
  }

  return launchPersistedAgentRun;
}

module.exports = { createPersistedAgentLaunch };
