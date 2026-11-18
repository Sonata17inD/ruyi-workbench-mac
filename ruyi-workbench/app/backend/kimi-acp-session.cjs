'use strict';

function kimiAcpMode(permissionMode) {
  if (permissionMode === 'plan') return 'plan';
  if (permissionMode === 'bypass') return 'yolo';
  // Kimi's auto mode is a stronger native policy that suppresses execution questions. Only Ruyi's
  // acceptEdits needs translation to ACP default so AskUser remains interactive and exec stays gated.
  if (permissionMode === 'auto') return 'auto';
  if (permissionMode === 'acceptEdits') return 'default';
  return 'default';
}

function kimiAcpPlanApprovalGrantsCurrentTurn(optionId) {
  const id = String(optionId || '');
  // ExitPlanMode's stable option ids are either the explicit approval or one of Kimi's selectable plan
  // variants. Revise, reject-and-exit and cancel are decisions, never execution authorization.
  return id === 'plan_approve' || /^plan_opt_\d+$/.test(id);
}

function contextResetKimiAcpPlanApproval(reg) {
  if (!reg) return;
  reg.kimiAcpPlanApproved = false;
  reg.kimiAcpPlanApprovalTurn = 0;
}

function kimiAcpObserveNativeMode(reg, modeId) {
  if (!reg) return;
  const next = String(modeId || '');
  const previous = String(reg.kimiAcpNativeMode || '');
  reg.kimiAcpNativeMode = next;
  if (next) reg.kimiAcpLatestModeId = next;
  if (next === 'plan' && previous && previous !== 'plan') {
    contextResetKimiAcpPlanApproval(reg);
    reg.kimiAcpPlanFile = '';
  }
}

function kimiAcpCapabilityState(capabilities, key, aliases = []) {
  const roots = [capabilities, capabilities && capabilities.sessionCapabilities].filter(root => root && typeof root === 'object');
  for (const root of roots) {
    for (const candidate of [key, ...aliases]) {
      if (!Object.prototype.hasOwnProperty.call(root, candidate)) continue;
      return root[candidate] !== false && root[candidate] != null;
    }
  }
  return null;
}

function kimiAcpSessionRestoreMethods(capabilities) {
  const sessionCaps = capabilities && capabilities.sessionCapabilities && typeof capabilities.sessionCapabilities === 'object'
    ? capabilities.sessionCapabilities : {};
  const readFlag = (root, key) => Object.prototype.hasOwnProperty.call(root || {}, key) ? Boolean(root[key]) : null;
  const resume = readFlag(sessionCaps, 'resume');
  const load = readFlag(capabilities, 'loadSession') != null
    ? readFlag(capabilities, 'loadSession') : readFlag(sessionCaps, 'loadSession');
  if (resume === true) return { methods: ['session/resume', ...(load === true ? ['session/load'] : [])], declared: true };
  if (load === true) return { methods: ['session/load'], declared: true };
  if (resume === false || load === false) return { methods: [], declared: true };
  // Older ACPs did not advertise these fields. Keep a narrow compatibility attempt, but make the
  // uncertainty visible and never turn an arbitrary restore failure into a new session.
  return { methods: ['session/resume', 'session/load'], declared: false };
}

function kimiAcpMethodNotFound(error) {
  return Number(error && error.code) === -32601;
}

function kimiAcpUnknownSessionError(error, sessionId) {
  return Number(error && error.code) === -32602
    && String(error && error.message || '').trim() === `Unknown sessionId: ${String(sessionId)}`;
}

async function kimiAcpRestoreSession(rpc, nativeSessionId, lifecycle, capabilities, reg, onEvent, flushUpdates) {
  const plan = kimiAcpSessionRestoreMethods(capabilities || {});
  if (!plan.methods.length) {
    throw new Error('Kimi ACP agent explicitly does not support session resume/load; refusing to create a new session');
  }
  if (!plan.declared) onEvent({ type: 'stderr', text: '[Kimi ACP 能力] initialize 未声明 session resume/load；按旧版兼容顺序尝试，非 method-not-found 错误不会新建会话' });
  let lastError = null;
  for (let index = 0; index < plan.methods.length; index++) {
    const method = plan.methods[index];
    if (index > 0) onEvent({ type: 'stderr', text: `[Kimi ACP 能力] ${plan.methods[index - 1]} 不受支持，按 method-not-found 回退到 ${method}` });
    reg.kimiAcpLoadReplay = method === 'session/load';
    try {
      const response = await rpc.request(method, { sessionId: nativeSessionId, ...lifecycle }, 30000);
      if (flushUpdates) await flushUpdates();
      return { response, method };
    } catch (error) {
      lastError = error;
      if (flushUpdates) await flushUpdates().catch(() => {});
      if (!kimiAcpMethodNotFound(error) || index >= plan.methods.length - 1) throw error;
    } finally {
      reg.kimiAcpLoadReplay = false;
    }
  }
  throw lastError || new Error('Kimi ACP session restore failed');
}

function kimiAcpLifecycle(capabilities, workingDir, additionalDirectories, onEvent) {
  const extraState = kimiAcpCapabilityState(capabilities || {}, 'additionalDirectories', ['additionalDirs']);
  const lifecycle = { cwd: workingDir, mcpServers: [] };
  if (extraState === false) {
    onEvent({ type: 'stderr', text: '[Kimi ACP 能力] agent 未声明 additionalDirectories；已省略附加目录' });
  } else {
    if (extraState === null) onEvent({ type: 'stderr', text: '[Kimi ACP 能力] agent 未声明 additionalDirectories；按旧版兼容发送并保留诊断' });
    lifecycle.additionalDirectories = [...new Set((additionalDirectories || []).filter(Boolean))];
  }
  return lifecycle;
}

function kimiAcpFindConfigOption(options, id) {
  return (Array.isArray(options) ? options : []).find(option => option && String(option.id || '') === String(id)) || null;
}

function kimiAcpOptionChoices(option) {
  if (!option || typeof option !== 'object') return [];
  for (const key of ['options', 'values', 'allowedValues', 'enum', 'groups']) {
    if (Array.isArray(option[key])) {
      const flattened = [];
      const visit = values => {
        for (const value of values) {
          // ACP select groups carry groupId and options, and some revisions also put the groups under
          // a top-level `groups` array. A group has no selectable value/currentValue; recurse until the
          // actual choices are reached, preserving the advertised values as the only setter allowlist.
          if (value && typeof value === 'object' && Array.isArray(value.options)
            && value.value == null && value.currentValue == null
            && (value.id == null || value.groupId != null)) visit(value.options);
          else flattened.push(value);
        }
      };
      visit(option[key]);
      return flattened;
    }
    if (option[key] && typeof option[key] === 'object') return Object.keys(option[key]).map(value => ({ value }));
  }
  return [];
}

function kimiAcpOptionAdvertises(option, value) {
  const wanted = String(value);
  return kimiAcpOptionChoices(option).some(candidate => {
    const actual = candidate && typeof candidate === 'object'
      ? (candidate.value != null ? candidate.value : candidate.id != null ? candidate.id : candidate.currentValue)
      : candidate;
    return actual != null && String(actual) === wanted;
  });
}

function kimiAcpActualConfigValue(options, id) {
  const option = kimiAcpFindConfigOption(options, id);
  return option && option.currentValue != null ? String(option.currentValue) : '';
}

function kimiAcpRememberConfigActual(session, id, value) {
  if (!session || value == null || value === '') return;
  const configId = String(id || '');
  const actual = String(value);
  if (!configId || !actual) return;
  if (!Array.isArray(session.kimiAcpConfigOptions)) session.kimiAcpConfigOptions = [];
  const option = kimiAcpFindConfigOption(session.kimiAcpConfigOptions, configId);
  if (option) option.currentValue = actual;
  else session.kimiAcpConfigOptions.push({ id: configId, currentValue: actual });
}

function kimiAcpResponseActualConfigValue(response, id) {
  if (!response || typeof response !== 'object') return '';
  const direct = kimiAcpActualConfigValue(response.configOptions, id);
  if (direct) return direct;
  const configId = String(id || '');
  if (configId === 'mode') return String(response.currentModeId || response.current_mode_id || response.modeId || '');
  if (configId === 'model') return String(response.currentModelId || response.current_model_id || response.modelId || '');
  if (configId === 'thinking') return String(response.currentThinkingId || response.current_thinking_id || response.currentValue || '');
  return String(response.currentValue || '');
}

function kimiAcpActivatedActualConfigValue(activated, id) {
  const direct = kimiAcpResponseActualConfigValue(activated, id);
  if (direct) return direct;
  const modes = activated && activated.modes && typeof activated.modes === 'object' ? activated.modes : {};
  if (String(id || '') === 'mode') return String(modes.currentModeId || '');
  return '';
}

function kimiAcpNoteConfigActual(reg, id, value) {
  if (!reg || value == null || value === '') return;
  const configId = String(id || '');
  if (!configId) return;
  if (!reg.kimiAcpConfigActualSeq || typeof reg.kimiAcpConfigActualSeq !== 'object') reg.kimiAcpConfigActualSeq = Object.create(null);
  if (!reg.kimiAcpLatestConfigActual || typeof reg.kimiAcpLatestConfigActual !== 'object') reg.kimiAcpLatestConfigActual = Object.create(null);
  reg.kimiAcpConfigActualSeq[configId] = Number(reg.kimiAcpConfigActualSeq[configId] || 0) + 1;
  reg.kimiAcpLatestConfigActual[configId] = String(value);
}

function kimiAcpFreshActualForOperation(reg, id, baselineSeq, activationActuals) {
  const configId = String(id || '');
  const currentSeq = Number(reg && reg.kimiAcpConfigActualSeq && reg.kimiAcpConfigActualSeq[configId] || 0);
  const baseline = Number(baselineSeq) || 0;
  if (currentSeq > baseline && reg && reg.kimiAcpLatestConfigActual) {
    const notified = String(reg.kimiAcpLatestConfigActual[configId] || '');
    if (notified) return notified;
  }
  return String(activationActuals && activationActuals[configId] || '');
}

function kimiAcpStoreConfigOptions(session, response) {
  if (response && Array.isArray(response.configOptions)) {
    const incoming = response.configOptions;
    const previous = Array.isArray(session.kimiAcpConfigOptions) ? session.kimiAcpConfigOptions : [];
    const byId = new Map(previous.map(option => [String(option && option.id || ''), option]));
    for (const option of incoming) {
      const id = String(option && option.id || '');
      if (id) byId.set(id, { ...(byId.get(id) || {}), ...option });
    }
    session.kimiAcpConfigOptions = [...byId.values()];
  }
  return Array.isArray(session.kimiAcpConfigOptions) ? session.kimiAcpConfigOptions : [];
}

function kimiAcpSyncActualConfig(state, session, reg, options) {
  for (const option of Array.isArray(options) ? options : []) {
    if (!option || option.currentValue == null) continue;
    const id = String(option.id || '');
    const actual = String(option.currentValue);
    if (id === 'model') {
      kimiAcpRememberConfigActual(session, id, actual);
      state.model = actual;
      session.claudeSessionModel = actual;
    } else if (id === 'mode') {
      kimiAcpRememberConfigActual(session, id, actual);
      session.kimiAcpMode = actual;
      kimiAcpObserveNativeMode(reg, actual);
    } else if (id === 'thinking') {
      kimiAcpRememberConfigActual(session, id, actual);
      session.kimiAcpThinking = actual;
    }
  }
}

function kimiAcpModeOptionFromActivated(activated) {
  const modes = activated && activated.modes && typeof activated.modes === 'object' ? activated.modes : null;
  const available = modes && Array.isArray(modes.availableModes) ? modes.availableModes : [];
  const values = available.map(item => item && typeof item === 'object'
    ? (item.value != null ? item.value : item.id != null ? item.id : item.modeId)
    : item).filter(value => value != null && String(value));
  const current = modes && modes.currentModeId != null ? String(modes.currentModeId) : '';
  if (current && !values.some(value => String(value) === current)) values.push(current);
  if (!values.length) return null;
  return { id: 'mode', currentValue: current, options: values.map(value => ({ value: String(value) })) };
}

async function applyKimiAcpTurnConfig({ rpc, nativeSessionId, session, reg, state, config, activatedActuals, onEvent, redact, flushUpdates }) {
  const applyOption = async (configId, value) => {
    if (value == null || value === '') return;
    const strictMode = configId === 'mode';
    const option = kimiAcpFindConfigOption(session.kimiAcpConfigOptions, configId);
    if (!option || !kimiAcpOptionAdvertises(option, value)) {
      const message = `[Kimi ACP 设置 ${configId}] agent 未广告 requested value；未发送配置`;
      onEvent({ type: 'stderr', text: message });
      // An empty/unknown advertisement cannot prove that the native mode is safe. In particular, do not
      // inherit an old default that might be auto/yolo: mode changes fail closed unless the requested value
      // is explicitly advertised (including the synthesized activated.modes-only option).
      const confirmedActual = kimiAcpFreshActualForOperation(reg, configId, 0, activatedActuals);
      if (strictMode && confirmedActual === String(value)) {
        onEvent({ type: 'stderr', text: `[Kimi ACP 设置 mode] 当前 activation 已明确 actual=${confirmedActual}，未发送 setter` });
        kimiAcpSyncActualConfig(state, session, reg, [{ id: configId, currentValue: confirmedActual }]);
        return;
      }
      if (strictMode) throw new Error(message);
      return;
    }
    let response;
    const configNotificationSeq = Number(reg && reg.kimiAcpConfigActualSeq && reg.kimiAcpConfigActualSeq[configId] || 0);
    try {
      response = await rpc.request('session/set_config_option', { sessionId: nativeSessionId, configId, value }, 15000);
    } catch (error) {
      if (!kimiAcpMethodNotFound(error)) {
        const message = `[Kimi ACP 设置 ${configId}] ${redact(String(error && error.message || error))}`;
        onEvent({ type: 'stderr', text: message });
        if (strictMode) throw new Error(message);
        return;
      }
      const fallbackMethod = configId === 'mode' ? 'session/set_mode' : configId === 'model' ? 'session/set_model' : '';
      if (!fallbackMethod) {
        const message = `[Kimi ACP 设置 ${configId}] set_config_option 不受支持，未执行未声明的 fallback`;
        onEvent({ type: 'stderr', text: message });
        if (strictMode) throw new Error(message);
        return;
      }
      onEvent({ type: 'stderr', text: `[Kimi ACP 设置 ${configId}] set_config_option 不受支持，按 method-not-found 回退 ${fallbackMethod}` });
      try {
        response = await rpc.request(fallbackMethod, {
          sessionId: nativeSessionId,
          ...(configId === 'mode' ? { modeId: String(value) } : { modelId: String(value) }),
        }, 15000);
      } catch (fallbackError) {
        await flushUpdates().catch(() => {});
        const current = configId === 'mode'
          ? kimiAcpFreshActualForOperation(reg, configId, configNotificationSeq, activatedActuals)
          : '';
        if (configId === 'mode' && kimiAcpMethodNotFound(fallbackError) && current === String(value)) {
          onEvent({ type: 'stderr', text: `[Kimi ACP 设置 mode] setter 不受支持，但 modes.currentModeId 已确认 requested；沿用 actual` });
          kimiAcpSyncActualConfig(state, session, reg, [{ id: configId, currentValue: current }]);
          return;
        }
        throw fallbackError;
      }
    }
    // A traditional set_mode/set_model often resolves with {} and publishes the actual value in a
    // current_*_update notification. Flush that serialized reducer before deciding whether the setter
    // succeeded; otherwise the previous config option value can win and falsely abort a valid change.
    await flushUpdates().catch(() => {});
    kimiAcpStoreConfigOptions(session, response);
    const responseActual = kimiAcpResponseActualConfigValue(response, configId);
    const notificationActual = kimiAcpFreshActualForOperation(reg, configId, configNotificationSeq, {});
    // Never fall back to `options` here: it may be the pre-setter currentValue preserved by a merged
    // descriptor. Only the setter response or a notification from this operation is fresh evidence.
    const actual = responseActual || notificationActual;
    if (actual) kimiAcpSyncActualConfig(state, session, reg, [{ id: configId, currentValue: actual }]);
    if (!actual || actual !== String(value)) {
      const message = `[Kimi ACP 设置 ${configId}] agent actual value 未确认或与 requested 不同，已中止本回合配置`;
      onEvent({ type: 'stderr', text: message });
      if (strictMode) throw new Error(message);
      return;
    }
  };
  await applyOption('mode', kimiAcpMode(config.permissionMode));
  await applyOption('model', config.model);
  await applyOption('thinking', ['low', 'medium', 'high', 'max'].includes(config.claudeThinkingEffort) ? config.claudeThinkingEffort : '');
  if (!state.model) state.model = kimiAcpActualConfigValue(session.kimiAcpConfigOptions, 'model') || String(session.claudeSessionModel || '');
  if (state.model) session.claudeSessionModel = state.model;
}

module.exports = {
  kimiAcpPlanApprovalGrantsCurrentTurn, contextResetKimiAcpPlanApproval, kimiAcpObserveNativeMode,
  kimiAcpCapabilityState, kimiAcpSessionRestoreMethods, kimiAcpUnknownSessionError, kimiAcpRestoreSession,
  kimiAcpLifecycle, kimiAcpFindConfigOption, kimiAcpRememberConfigActual, kimiAcpActivatedActualConfigValue,
  kimiAcpNoteConfigActual, kimiAcpFreshActualForOperation, kimiAcpStoreConfigOptions, kimiAcpSyncActualConfig,
  kimiAcpModeOptionFromActivated, applyKimiAcpTurnConfig,
};
