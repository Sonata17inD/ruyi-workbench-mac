'use strict';

function createAgentSteering({ sessions }) {
  const { VisualPipeline, buildAttachmentPrompt, nowIso, saveSession } = sessions;

  // v0.8-S7: drain the steering queue at a SAFE injection point (§4 A3). Called ONLY at the iteration
  // boundary (loop top, before the next API call). A steer is a plain user string queued by /api/steer
  // while this turn is live. For each queued item we:
  //   • push a `[用户插话] <text>` user message into providerHistory — this is legal ONLY at a boundary
  //     where the previous assistant/tool block is COMPLETE AND CONTIGUOUS (an assistant.tool_calls message
  //     followed immediately by all its role:'tool' replies, nothing wedged between). The loop top satisfies
  //     that: it runs after `continue`, which followed the full tool batch + its tool messages. Draining
  //     between tools of one batch would break contiguity (assistant → tool₁ → user → tool₂ = 400 on strict
  //     providers) and buys nothing — a steer is only consumed by the NEXT API call anyway;
  //   • mirror it into session.messages with steered:true (additive marker) so the UI + a reload show it;
  //   • emit a `steered` event (§7.3) so a live UI can render/dedup it;
  //   • saveSession so a crash mid-turn doesn't lose the injected instruction.
  // Returns the number of items injected (0 when the queue was empty).
  function hasInterruptingSteer(reg) {
    // Legacy internal callers can still enqueue strings. API additions use explicit delivery modes.
    return !!(reg && Array.isArray(reg.steerQueue) && reg.steerQueue.some(item => typeof item === 'string' || item.mode === 'interrupt'));
  }

  async function drainSteerQueue(reg, session, onEvent) {
    if (!reg || !Array.isArray(reg.steerQueue) || reg.steerQueue.length === 0) return 0;
    const items = reg.steerQueue.splice(0, reg.steerQueue.length);
    const imageBatchStart = session.providerHistory.length;
    for (const text of items) {
      const t = String((typeof text === 'string' ? text : text.text) || '');
      const attachments = Array.isArray(text && text.attachments) ? text.attachments : [];
      const prompt = '[用户插话] ' + t + buildAttachmentPrompt(attachments);
      const content = reg.vision === true && VisualPipeline.hasImageAttachment(attachments)
        ? await VisualPipeline.buildUserContentParts(prompt, attachments) : prompt;
      session.providerHistory.push({ role: 'user', content });
      session.messages.push({ role: 'user', content: t, ...(attachments.length ? { attachments } : {}), turnSeq: session.turnSeq, steered: true, createdAt: nowIso() });
      try { onEvent({ type: 'steered', text: t, ...(attachments.length ? { attachments } : {}) }); } catch { /* stream gone */ }
    }
    if (reg.vision === true) VisualPipeline.pruneOldImages(session.providerHistory, imageBatchStart);
    await saveSession(session);
    return items.length;
  }

  // v0.9-S6 (子代理): run a self-contained SUB-TURN for an orchestrate_agents node. It is a miniature of runOpenAiTurn's
  // tool loop, deliberately WITHOUT: plan mode, steering, session.messages/providerHistory writes, and (禁嵌套) the
  // agent tools in its own tool set. Key isolation properties:
  //   • independent `subHistory` — the sub-turn NEVER reads or writes the parent's session.providerHistory, so
  //     the parent's pairing铁律 is untouched (the parent sees exactly one orchestrate_agents tool_call ↔ one envelope);
  //   • system prompt = a sub-agent identity variant + the SAME capability layers (reuse buildProviderSystemPrompt),
  //     with the first user message = the delegated task;
  //   • tool set filtered by toolTier (read/edit/exec) AND with the agent tools suppressed (noAgentTools) — a
  //     sub-agent can therefore never launch another sub-agent (double guard: the tools aren't offered here AND
  //     the loop below refuses such a call if the model somehow emits one);
  //   • independent iteration budget maxIters (clamped 1..300); model = model || provider.subagentModel || main model;
  //   • file tools run through the SAME journal ctx {sessionId, turnSeq} as the parent (the sub-turn is part of
  //     the parent turn), so a sub-agent's file_write is journaled under the parent's turnSeq — naturally;
  //   • events: a `subagent` start/end pair is forwarded; the sub-loop's tool_use/tool_result are forwarded too
  //     but TAGGED with `subagentId` so the UI nests them (protocol semantics unchanged — additive field).
  //     assistant_delta is deliberately NOT forwarded (keeps the parent bubble clean; the conclusion returns as
  //     the tool_result to the parent).
  // Returns { ok, result, iters, toolCalls } — result is the sub-turn's final assistant text. Errors/over-budget
  // return { ok:false, error } but NEVER throw into the parent loop.
  // v0.9 F4: `permModeOverride` lets the caller pass a per-turn effective permission mode. When the parent turn
  // is in provider plan mode AND the user has approved the plan THIS turn, the parent passes 'default' so the
  // sub-agents it spawns can actually do the approved work — instead of being hard-blocked by a stale 'plan'
  // mode. It is a TURN-LOCAL override only; global config.permissionMode is never mutated. When absent (or the
  // plan is not yet approved, in which case the parent still passes 'plan'), the gate falls back to
  // config.permissionMode, so an UN-approved plan-mode turn still hard-blocks its sub-agents' edit/exec tools.
  // v1 定向插话（steer 到指定运行中子代理节点）: per-node steer queue cap. Reused BOTH by the workflow node
  // steer action and by /api/steer's per-turn cap so the two steering surfaces stay symmetric.
  const STEER_QUEUE_MAX = 3;
  // 团队模式 v2 (A/B): 任务池与 Agent 邮箱的硬上限。全部防御式——任何越限只拒绝该次调用,绝不 crash 调度循环。
  const MAIL_QUEUE_MAX = 3;      // 每目标邮箱队列 cap(与 steerQueues 分池,用户插话优先)
  const MAIL_TEXT_MAX = 2000;    // 单条消息截断
  const MAIL_PER_SENDER_MAX = 8; // 每发送者每 run 消息上限
  // 团队模式 v2 (P2-2 消息围栏,原则4): 来自其它节点/提案的文本进入提示词前,把行首伪造的 [编排者插话] / [节点 …]
  // 前缀中和为全角括号版本,阻断子代理冒充编排者(用户)或冒充别的节点消息。仅改行首匹配,正文其余内容原样保留;
  // 任何异常都回退原文(围栏失败绝不阻断投递/执行)。调用点:邮箱注入(runSubAgentCore)与提案物化(materializePoolItem)。
  function neutralizeInjectedPrefixes(s) {
    try {
      return String(s == null ? '' : s)
        .replace(/^([ \t]*)\[编排者插话\]/gm, '$1［编排者插话］')
        .replace(/^([ \t]*)\[节点 /gm, '$1［节点 ');
    } catch { return String(s == null ? '' : s); }
  }

  return { hasInterruptingSteer, drainSteerQueue, STEER_QUEUE_MAX, MAIL_QUEUE_MAX, MAIL_TEXT_MAX, MAIL_PER_SENDER_MAX, neutralizeInjectedPrefixes };
}

module.exports = { createAgentSteering };
