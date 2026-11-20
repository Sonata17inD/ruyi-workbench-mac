'use strict';


// Resolve the universal compaction selector. Empty selection follows the active engine/provider; an
// explicit selection clones the configured provider with the chosen model so summary calls, accounting,
// and SUMMARY input budgeting agree on the same endpoint. Conversation trigger limits are separate.
function resolveCompactionProvider(config, fallbackProvider) {
  const providerId = String(config && config.compactProviderId || '').trim();
  const modelId = String(config && config.compactModel || '').trim();
  if (!providerId) {
    if (!fallbackProvider) return { provider: null, model: '', isDefault: true };
    const fallbackModel = String(fallbackProvider.model || (fallbackProvider.models && fallbackProvider.models[0] && fallbackProvider.models[0].id) || '').trim();
    return { provider: fallbackProvider, model: fallbackModel, isDefault: true };
  }
  const found = (config.providers || []).find(p => p && p.id === providerId);
  if (!found) return { provider: null, model: '', isDefault: false, error: 'configured compaction provider is unavailable' };
  const model = modelId || String(found.model || (found.models && found.models[0] && found.models[0].id) || '').trim();
  return { provider: { ...found, model }, model, isDefault: false };
}

function lastSessionContextTokens(session) {
  const messages = session && Array.isArray(session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i] && messages[i].usage;
    if (usage && Number.isFinite(Number(usage.contextTokens)) && Number(usage.contextTokens) > 0) return Number(usage.contextTokens);
  }
  return 0;
}

function contextWindowOverrideKey(engine, routeId, model) {
  return JSON.stringify([String(engine || ''), String(routeId || ''), String(model || '').trim()]);
}

function configuredConversationWindow(config, engine, routeId, model) {
  const value = Number(config && config.contextWindowOverrides && config.contextWindowOverrides[contextWindowOverrideKey(engine, routeId, model)]);
  return Number.isFinite(value) && value >= 8000 && value <= 2000000 ? Math.round(value) : 0;
}


function createCompactionRouting({ resolveContextWindow, providerContextWindow, PrivacyGateway }) {
  function compactHistoryFromSession(session) {
    const out = [];
    for (const message of (session && Array.isArray(session.messages) ? session.messages : [])) {
      if (!message || !['user', 'assistant'].includes(message.role)) continue;
      let content = String(message.content || '').trim();
      if (message.role === 'user' && Array.isArray(message.attachments) && message.attachments.length) {
        const refs = message.attachments.map(item => String(item && (item.path || item.name || item.filename) || '')).filter(Boolean);
        if (refs.length) content += `\n\n[本轮附件]\n${refs.join('\n')}`;
      }
      if (message.role === 'assistant') {
        const evidence = {};
        if (message.turnSummary && typeof message.turnSummary === 'object') evidence.turnSummary = message.turnSummary;
        if (Array.isArray(message.toolCalls) && message.toolCalls.length) evidence.toolCalls = message.toolCalls.map(call => ({ name: call && call.name, input: call && call.input }));
        const encoded = Object.keys(evidence).length ? JSON.stringify(evidence) : '';
        if (encoded) content += `\n\n[Ruyi 本轮操作证据]\n${encoded.slice(0, PrivacyGateway.referenceSafeSliceEnd(encoded, 0, 12000))}`;
      }
      if (!content) continue;
      out.push({ role: message.role, content });
    }
    return out;
  }

  function providerConversationContextWindow(config, provider, model) {
    const activeModel = String(model || provider && provider.model || '').trim();
    const manual = configuredConversationWindow(config, 'openai', provider && provider.id, activeModel);
    // Keep learned provider caps authoritative even when a manual conversation limit is configured.
    return providerContextWindow(manual ? { ...provider, contextWindow: manual } : provider, activeModel);
  }

  // 代理模式 v2(56 号文 §1②):工作流节点的上下文窗口。Claude 引擎节点与主会话同一条链 —— 手填(conversation
  // override)→ 名称表 → 1M 兜底(CONTEXT_WINDOW_FALLBACK),不再 200K 兜底;openai 节点走 providerContextWindow
  // (手填 → 探测 → 表 → 兜底,含窗口超限学习)。纯函数,供 09 runNode 的上游预算与测试直调。
  function agentNodeContextWindow(node, provider, config) {
    const engine = String(node && node.engine || 'openai');
    if (engine === 'claude') {
      const model = String(node && node.model || (config && config.model) || '').trim();
      const manual = configuredConversationWindow(config, 'agent', 'claude', model);
      if (manual > 0) return manual;
      return resolveContextWindow(null, model).value;
    }
    return providerContextWindow(provider, node && node.model);
  }

  async function agentConversationContextMeta(config, session) {
    const agentCliType = String(config && config.agentCliType || 'claude');
    const model = String(config && config.model || session && session.claudeSessionModel || '').trim();
    // An empty configured model is itself a route (the CLI default), not the previous concrete model.
    const manualModel = String(config && config.model || '').trim();
    let contextWindow = configuredConversationWindow(config, 'agent', agentCliType, manualModel);
    let contextWindowSource = contextWindow ? 'manual' : '';
    if (!contextWindow) {
      const messages = session && Array.isArray(session.messages) ? session.messages : [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i], usage = message && message.usage;
        if (!usage || usage.contextWindowSource === 'manual' || usage.source === 'external-compact') continue;
        const tagged = usage.contextEngine === 'agent' && usage.contextAgentCliType === agentCliType;
        const legacy = !usage.contextEngine && message.engine === 'claude' && (message.agentCliType || 'claude') === agentCliType;
        const reportedModel = String(usage.contextModel || usage.model || message.model || '').trim();
        if (!(tagged || legacy) || (model && reportedModel !== model)) continue;
        const measured = Number(usage.contextWindow);
        if (Number.isFinite(measured) && measured > 0) { contextWindow = measured; contextWindowSource = 'usage'; break; }
      }
    }
    if (!(contextWindow > 0)) {
      const resolved = resolveContextWindow(null, model);
      contextWindow = resolved.value;
      contextWindowSource = resolved.source;
    }
    return {
      contextEngine: 'agent', contextAgentCliType: agentCliType, contextModel: model,
      contextWindow, contextWindowSource,
    };
  }

  return { compactHistoryFromSession, providerConversationContextWindow, agentNodeContextWindow, agentConversationContextMeta };
}

module.exports = { createCompactionRouting, resolveCompactionProvider, lastSessionContextTokens, contextWindowOverrideKey, configuredConversationWindow };
