'use strict';
// Agent result delivery is independent of model execution and HTTP transport.
function createAgentResults({
  records: { readAgentRunRecord, buildAgentRunEnvelope },
  delivery: { pendingAgentMessages, isAgentEnvelopeDelivered, markAgentEnvelopeDelivered, notifyAgentRunEnvelope },
  subscribe, safeSessionId, logEvent,
}) {
// 代理模式 v2:后台 run 的收件。`orchestrate_agents{background:true}` 立即回执,run 由持久化工作流运行时继续跑,
// 结果可在本回合或之后任一回合收取,不依赖内存 promise。读取优先活对象(磁盘快照在节点运行期间有意节流),
// 并把每个 id 限定在本会话的 run 目录。返回的是【交付信封】(buildAgentRunEnvelope),不是整份 run。
const AGENT_RUN_TERMINAL = new Set(['succeeded', 'failed', 'partial', 'stopped', 'interrupted', 'cancelled']);
// wait_agents 的等待窗:默认 2 分钟、上限 5 分钟(修前 30 秒 / 60 秒:一个跑十分钟的后台代理要被轮询二十次,每次都是一整个模型调用)。
// 到点只是「这一次不等了」—— run 本身不受影响(见下面 timedOut 的说明)。等待期间不算父回合空闲(见 waitForAgentRunResults 的 onWaiting)。
// env 缝(只读、缺省即生产):WCW_WAIT_AGENTS_DEFAULT_MS / WCW_WAIT_AGENTS_MAX_MS。
const WAIT_AGENTS_DEFAULT_MS = 120000;
const WAIT_AGENTS_MAX_MS = 300000;
function waitAgentsMaxMs() { return Math.max(1, Number(process.env.WCW_WAIT_AGENTS_MAX_MS) || WAIT_AGENTS_MAX_MS); }
// 调用方传的 timeoutMs(缺省 / null = 用默认窗)→ 实际等待毫秒;非数字按 0(不等),超上限按上限。
function resolveWaitAgentsMs(timeoutMs) {
  const raw = timeoutMs == null ? Math.max(1, Number(process.env.WCW_WAIT_AGENTS_DEFAULT_MS) || WAIT_AGENTS_DEFAULT_MS) : timeoutMs;
  return Math.min(waitAgentsMaxMs(), Math.max(0, Number(raw) || 0));
}
async function waitForAgentRunResults(sessionId, rawRunIds, timeoutMs, signal, onWaiting) {
  const runIds = [...new Set((Array.isArray(rawRunIds) ? rawRunIds : [])
    .map(id => safeSessionId(String(id || ''))).filter(Boolean))].slice(0, 16);
  const waitMs = Math.min(waitAgentsMaxMs(), Math.max(0, Number(timeoutMs) || 0));
  if (!runIds.length) return { ok: false, error: '没有可等待的后台代理 runId', settled: true, timedOut: false, waitMs, runs: [] };
  const deadline = Date.now() + waitMs;
  const readOne = runId => readAgentRunRecord(sessionId, runId);
  let rows = [];
  let messageReady = false;
  // Subscribe before the first read: events arriving during an asynchronous read
  // advance the revision, so the waiter never sleeps past an already delivered event.
  let revision = 0;
  let wake = null;
  const unsubscribe = subscribe((name, payload) => {
    if (!payload || payload.sessionId !== sessionId) return;
    if (name !== 'thread.state' && name !== 'background.completed') return;
    revision++;
    if (wake) wake();
  });
  try {
    for (;;) {
      const observed = revision;
      rows = await Promise.all(runIds.map(readOne));
      const settled = rows.every(row => !row || !row.live);
      messageReady = !!pendingAgentMessages(sessionId);
      if (settled || messageReady || Date.now() >= deadline || (signal && signal.aborted)) break;
      if (typeof onWaiting === 'function') { try { onWaiting(); } catch { /* observer only */ } }
      if (revision !== observed) continue;
      await new Promise(resolve => {
        let done = false;
        let timer;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', finish);
          wake = null;
          resolve();
        };
        wake = finish;
        // Deadline/heartbeat fallback also covers run changes without an event.
        timer = setTimeout(finish, Math.min(1000, Math.max(1, deadline - Date.now())));
        if (timer && timer.unref) timer.unref();
        if (signal) {
          signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        }
        if (revision !== observed) finish();
      });
    }
  } finally {
    unsubscribe();
    if (wake) wake();
  }
  const runs = runIds.map((runId, index) => {
    const row = rows[index];
    if (!row) return { ok: false, kind: 'agent_envelope', runId, status: 'not_found', nodes: [], live: false };
    const env = buildAgentRunEnvelope(row.run);
    env.live = row.live === true;
    if (row.live && !AGENT_RUN_TERMINAL.has(env.status)) env.status = 'running';
    return env;
  });
  // settled 口径不变(有 not_found 就不算「全部结果到手」,信封里照样标 status:'not_found');
  // timedOut 只看【活的】 run —— not_found 不是等超时了,是压根没有这个 run。
  const settled = runs.every(run => run.status !== 'not_found' && run.live !== true);
  // 请求的 runId 全都不存在:修前回 ok:true settled:false timedOut:false,读起来像「还在跑」,模型会接着等。
  // 全不存在 → 顶层 ok:false + error 点名是哪些(settled 口径照旧:not_found 不算结果到手,单测钉着);
  // 部分不存在 → 保持 ok:true,另列 notFound。
  const notFound = runs.filter(run => run.status === 'not_found').map(run => run.runId);
  if (notFound.length && notFound.length === runs.length) {
    return { ok: false, error: `没有找到这些后台代理 run:${notFound.join(', ')}(runId 打错,或不属于当前会话);它们不是「仍在运行」。runId 以 orchestrate_agents{background:true} 的返回为准,或省略 runIds 收取本会话的后台代理。`, settled, timedOut: false, waitMs, notFound, runs };
  }
  const cancelled = !!(signal && signal.aborted);
  const timedOut = !cancelled && !messageReady && runs.some(run => run.live === true);
  // 到点还有 run 在跑:说清这是【这一次等待窗】到了(不是代理超时、也没中止任何东西),以及怎么办。
  const timeoutNote = timedOut ? `等待窗(${Math.round(waitMs / 1000)} 秒)已到,仍有代理在后台运行,没有被中止。可以先做别的工作,完成通知会自动送达;或再调 wait_agents(timeoutMs 最大 ${Math.round(waitAgentsMaxMs() / 1000)} 秒)继续等。` : '';
  return { ok: true, settled, timedOut, waitMs, ...(cancelled ? { cancelled: true } : {}), ...(messageReady ? { messageReady: true, note: '收到代理参考消息，已结束本次等待；运行状态未改变，消息将在下次模型调用前投递。' } : timeoutNote ? { note: timeoutNote } : {}), ...(notFound.length ? { notFound } : {}), runs };
}
function settleWaitEnvelopes(session, out) {
  if (!session || !out || !Array.isArray(out.runs)) return out;
  out.runs = out.runs.map(env => {
    if (!env || !env.runId || env.live === true || !AGENT_RUN_TERMINAL.has(String(env.status))) return env;
    if (isAgentEnvelopeDelivered && isAgentEnvelopeDelivered(session, env.runId)) {
      return {
        ok: env.ok, kind: 'agent_envelope_receipt', runId: env.runId, status: env.status, delivered: 'already',
        ...(env.messageReceipts ? { messageReceipts: env.messageReceipts } : {}),
        nodes: (Array.isArray(env.nodes) ? env.nodes : []).map(n => ({ nodeId: n.nodeId, status: n.status })),
        note: '该 run 的交付信封本会话已送达过(上方的代理完成通知,或此前的 wait_agents / agent_result),此处不重复;需全文用 agent_result({runId, nodeId?})。',
      };
    }
    if (markAgentEnvelopeDelivered) markAgentEnvelopeDelivered(session, env.runId);
    return env;
  });
  return out;
}
// 后台 run 收尾 → 一份信封进后台任务账本(下一迭代边界 / 下一回合开头注入一次;toast + 后台任务条随 background.completed 刷新)。
async function deliverAgentRunEnvelope(sessionId, run) {
  // 起它的那个回合已被用户撤回(10 onSessionRewound 停掉并打了标):对话里已经没有这件事了,信封只会让下一回合凭空多出一份「已停止」通知。
  if (run && run.cancelledByRewind === true) return;
  try {
    const envelope = buildAgentRunEnvelope(run);
    if (notifyAgentRunEnvelope) notifyAgentRunEnvelope(sessionId, run, envelope);
  } catch (e) { logEvent({ kind: 'agent_envelope_deliver_error', sessionId, runId: run && run.id, error: String(e && e.message || e) }); }
}
return { waitAgentsMaxMs, resolveWaitAgentsMs, waitForAgentRunResults, settleWaitEnvelopes, deliverAgentRunEnvelope, AGENT_RUN_TERMINAL, WAIT_AGENTS_DEFAULT_MS, WAIT_AGENTS_MAX_MS };
}
module.exports = { createAgentResults };
