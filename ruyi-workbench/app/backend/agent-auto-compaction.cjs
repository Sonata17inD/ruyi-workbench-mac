'use strict';
const { lastSessionContextTokens } = require('./compaction-routing.cjs');

function createAgentAutoCompaction({ loadSession, agentConversationContextMeta, runAgentExternalCompact }) {
  async function replaceSessionObject(target, fresh) {
    if (!target || !fresh) return;
    for (const key of Object.keys(target)) if (!Object.prototype.hasOwnProperty.call(fresh, key)) delete target[key];
    Object.assign(target, fresh);
  }

  const AGENT_AUTO_COMPACT_FAIL_COOLDOWN_MS = 10 * 60 * 1000;
  const agentAutoCompactFailures = new Map();   // sessionId -> { at, tokens }
  function agentAutoCompactTrigger(session, threshold, limit) {
    const base = threshold * limit;
    const rearmMargin = Math.max(2000, Math.round(limit * 0.02));
    const wm = Number(session && session.autoCompactWatermark);
    return { trigger: Number.isFinite(wm) && wm > 0 ? Math.max(base, wm + rearmMargin) : base, rearmMargin };
  }
  function agentAutoCompactBackingOff(sessionId, used, rearmMargin) {
    const failed = agentAutoCompactFailures.get(String(sessionId || ''));
    if (!failed) return false;
    if (Date.now() - failed.at >= AGENT_AUTO_COMPACT_FAIL_COOLDOWN_MS || used >= failed.tokens + rearmMargin) {
      agentAutoCompactFailures.delete(String(sessionId || ''));
      return false;
    }
    return true;
  }
  function noteAgentAutoCompactFailure(sessionId, used) {
    agentAutoCompactFailures.set(String(sessionId || ''), { at: Date.now(), tokens: Number(used) || 0 });
    while (agentAutoCompactFailures.size > 500) agentAutoCompactFailures.delete(agentAutoCompactFailures.keys().next().value);
  }

  async function maybeAutoCompactAgentSession(session, config, cliAdapter, onEvent) {
    if (!config.compactProviderId) return false;
    try {
      const threshold = Number(config.autoCompactThreshold) || 0.8;
      const used = lastSessionContextTokens(session);
      const contextMeta = await agentConversationContextMeta({ ...config, agentCliType: cliAdapter.id }, session);
      const limit = contextMeta.contextWindow;
      const armed = limit > 0 ? agentAutoCompactTrigger(session, threshold, limit) : null;
      if (used > 0 && armed && used >= armed.trigger && !agentAutoCompactBackingOff(session.id, used, armed.rearmMargin)) {
        onEvent({ type: 'compact', mode: 'external-summary', phase: 'started', trigger: 'auto', beforeTokens: used, contextWindow: limit });
        const result = await runAgentExternalCompact(session.id, config, 'auto');
        if (!result.ok) {
          noteAgentAutoCompactFailure(session.id, used);
          onEvent({ type: 'compact', mode: 'external-summary', phase: 'failed', error: result.error });
          return false;
        }
        agentAutoCompactFailures.delete(String(session.id));
        const fresh = await loadSession(session.id);
        await replaceSessionObject(session, fresh);
        onEvent({ type: 'compact', mode: 'external-summary', phase: 'completed', trigger: 'auto', beforeTokens: result.beforeTokens, afterTokens: result.afterTokens });
        return true;
      }
      return false;
    } catch (error) {
      try { onEvent({ type: 'compact', mode: 'external-summary', phase: 'failed', error: (error && error.message) || String(error) }); } catch { /* ignore */ }
      return false;
    }
  }

  return maybeAutoCompactAgentSession;
}

module.exports = { createAgentAutoCompaction };
