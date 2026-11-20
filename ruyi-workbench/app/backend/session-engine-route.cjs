'use strict';
const { isAgentCliType } = require('./agent-cli-types.cjs');

// Conversation engine/model selection belongs to the session, not to whichever global selector was
// touched most recently. The global config remains the default for NEW sessions; existing sessions keep
// this compact route descriptor and the turn dispatcher overlays it onto a request-local config copy.
function normalizeSessionEngineRoute(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const model = String(raw.model || '').trim().slice(0, 256);
  if (raw.engine === 'openai') {
    const providerId = String(raw.providerId || '').trim().slice(0, 128);
    return providerId ? { engine: 'openai', providerId, model } : null;
  }
  if (raw.engine === 'agent' || raw.engine === 'claude') {
    const agentCliType = typeof raw.agentCliType === 'string' && raw.agentCliType.trim()
      ? raw.agentCliType.trim().slice(0, 128) : 'claude';
    return { engine: 'agent', agentCliType, model };
  }
  return null;
}

function sessionEngineRouteFromConfig(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const providerId = String(cfg.activeProvider || '').trim();
  if (providerId && providerId !== 'claude-cli') {
    const provider = (cfg.providers || []).find(item => item && item.id === providerId);
    return normalizeSessionEngineRoute({ engine: 'openai', providerId, model: provider && provider.model });
  }
  return normalizeSessionEngineRoute({ engine: 'agent', agentCliType: cfg.agentCliType, model: cfg.model });
}

function inferSessionEngineRoute(session) {
  const explicit = normalizeSessionEngineRoute(session && session.engineRoute);
  if (explicit) return explicit;
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    const inferred = message.engine === 'openai' || message.providerId
      ? normalizeSessionEngineRoute({ engine: 'openai', providerId: message.providerId, model: message.model })
      : normalizeSessionEngineRoute({ engine: 'agent', agentCliType: message.agentCliType, model: message.model });
    if (inferred) return inferred;
  }
  return null;
}

function unavailableAgentRoute(route) {
  return route?.engine === 'agent' && !isAgentCliType(route.agentCliType);
}

function clearNativeResume(session) {
  session.claudeSessionId = null;
  delete session.claudeSessionModel;
  delete session.claudeSessionRequestedModel;
  delete session.claudeSessionCwd;
  delete session.claudeSessionRouteKey;
  session.injectedIndexHash = null;
}

function configForSessionEngineRoute(config, session) {
  const route = inferSessionEngineRoute(session);
  if (!route) return config;
  if (route.engine === 'openai') {
    const providers = (config.providers || []).map(provider => provider && provider.id === route.providerId
      ? { ...provider, model: route.model || provider.model || '' }
      : provider);
    return { ...config, activeProvider: route.providerId, providers };
  }
  return {
    ...config,
    activeProvider: '',
    agentCliType: route.agentCliType,
    model: route.model,
  };
}

function createSessionRoutePreferences({ mutateConfig, selectedAgentCli, logEvent }) {
  async function rememberLastUsedEngineRoute(nextRoute, knownConfig) {
    try {
      const clean = normalizeSessionEngineRoute(nextRoute);
      if (!clean) return false;
      const wanted = JSON.stringify(clean);
      if (knownConfig && typeof knownConfig === 'object'
        && JSON.stringify(normalizeSessionEngineRoute(knownConfig.lastUsedEngineRoute)) === wanted) return false;
      let wrote = false;
      await mutateConfig(async current => {
        if (JSON.stringify(normalizeSessionEngineRoute(current.lastUsedEngineRoute)) === wanted) return { abort: 'unchanged' };
        current.lastUsedEngineRoute = clean;
        wrote = true;
      });
      return wrote;
    } catch { return false; }
  }

  // 「上一次用的」现在还能不能用。只有两条判据,都对应【用户换过环境】这一件事:
  //   · openai 路由 —— 那个端点还在不在 config.providers 里。删掉端点后再开新线程必须回落,
  //     否则新线程一开口就撞 10 的「会话绑定的 Provider 不可用」,用户完全不知道发生了什么;
  //   · agent 路由 —— 那个 CLI 还检不检得到。判据【复用】01 的 selectedAgentCli(它同时看用户手填
  //     的路径与探测结果,且带缓存),不另写第二套探测 —— 第二套判据迟早与第一套判出不同答案。
  function lastUsedEngineRouteUsable(route, config) {
    if (!route) return false;
    if (route.engine === 'openai') {
      return ((config && config.providers) || []).some(item => item && item.id === route.providerId);
    }
    if (route.agentCliType !== 'claude') return false;
    const cli = selectedAgentCli({ ...(config || {}), agentCliType: route.agentCliType });
    return Boolean(cli && cli.path);
  }

  // 读:新线程的缺省引擎。优先级固定四层,**第三层是本波新增的那一层**,上下两层一字未动:
  //   ① 显式入参 engineRoute(POST /api/sessions 的请求体带的,或进程内调用方指定的)——
  //      「这一条线程就要这个」压过一切;
  //   ② 从导入进来的消息里推断 —— 导入历史对话时沿用它原来的引擎(既有行为);
  //   ③ newThreadEngine === 'last' 且 lastUsedEngineRoute 【仍可用】→ 用它(本波新增);
  //   ④ 全局设置 —— 老行为,同时也是 ③ 的回落去处。
  // ③ 因「不可用」回落到 ④ 时必须留痕:用户明明设了「跟上次用的」却拿到别的引擎,不记一条
  // 审计事件就无从解释。**「还没有上一次」不算回落**(那是首次使用,不记)。
  function newSessionEngineRoute(config, explicitRoute, initialMessages, sessionId) {
    const explicit = normalizeSessionEngineRoute(explicitRoute);
    if (explicit) return explicit;
    const inferred = inferSessionEngineRoute({ messages: initialMessages });
    if (inferred) return inferred;
    const fromGlobal = sessionEngineRouteFromConfig(config);
    if (!config || config.newThreadEngine !== 'last') return fromGlobal;
    const last = normalizeSessionEngineRoute(config.lastUsedEngineRoute);
    if (!last) return fromGlobal;
    if (unavailableAgentRoute(last)) return last;
    if (lastUsedEngineRouteUsable(last, config)) return last;
    logEvent({
      kind: 'new_thread_engine_fallback',
      sessionId: String(sessionId || ''),
      reason: last.engine === 'openai' ? 'provider_missing' : 'agent_cli_missing',
      last,
      to: fromGlobal,
    });
    return fromGlobal;
  }

  return { rememberLastUsedEngineRoute, newSessionEngineRoute };
}

module.exports = {
  normalizeSessionEngineRoute, sessionEngineRouteFromConfig, inferSessionEngineRoute, configForSessionEngineRoute,
  createSessionRoutePreferences, clearNativeResume, unavailableAgentRoute,
};
