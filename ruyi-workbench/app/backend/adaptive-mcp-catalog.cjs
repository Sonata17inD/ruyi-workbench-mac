'use strict';

function createAdaptiveMcpCatalog({
  MCP_TOOLS, ProcessRuntime, observationRecallEnabled, runtimeToolRequirementsMet, nativeToolDisabledByPolicy,
  isStewardToolName, collectBridgedTools, dropPolicyDisabledBridgedTools, buildToolCatalog,
}) {
  // v0.8-S4a: `ctx` optionally carries checkpoint-journal context {sessionId, turnSeq}. The provider loop
  // passes its live session.id/turnSeq; the MCP child passes nothing (journalSessionCtx resolves both from
  // the injected WCW_SESSION_ID env + the session file). File-mutating tools (file_write/file_edit/
  // file_delete) record a `before` checkpoint immediately before executing.
  // 116c: opts.stewardSession === true 时才把 steward_* 放进目录(四个 offer 面之一);缺省 fail-closed
  // 隐藏 —— list_tools/tool_search/tool_invoke_* 三条控制面都走本目录,普通会话既检索不到也代理不到管家工具。
  async function adaptiveCatalogForMcp(config, opts) {
    const runtime = await ProcessRuntime.capabilitySnapshot();
    const recallEnabled = observationRecallEnabled(config);
    const stewardSession = !!(opts && opts.stewardSession === true);
    const desktopOverride = (opts && opts.desktopOverride != null) ? opts.desktopOverride : null;
    const native = MCP_TOOLS
      .filter(t => t && t.name && !t.name.startsWith('tool_invoke_') && t.name !== 'tool_load' && t.name !== 'permission_prompt') // permission_prompt 是 CLI 权限桥的内部入口,不能代理调用,别进 list_tools / tool_search
      .filter(t => runtimeToolRequirementsMet(t.name, runtime).met)
      .filter(t => !nativeToolDisabledByPolicy(t.name, config, desktopOverride))
      .filter(t => t.name !== 'observation_recall' || recallEnabled) // 105a: 目录同样按双开关隐藏
      .filter(t => !isStewardToolName(t.name) || stewardSession) // 116c: 管家工具只进管家会话的目录
      .map(t => ({ type: 'function', function: { name: t.name, description: t.description || t.name, parameters: t.inputSchema || { type: 'object', properties: {} } } }));
    let bridged = { tools: [], route: {} };
    try { bridged = await collectBridgedTools(config); } catch { /* native-only catalog is still useful */ }
    // 2026-10 能力总闸补桥接面:被 allowCommandTools / allowDesktopTools(+ opts.desktopOverride,调用方按会话取)关掉的内置
    // 桌面 MCP 工具不进 list_tools / tool_search / 代理的目录。route 原样交回:12 invokeAdaptiveMcpTool 先按它认出被关的目标、回 tool-disabled。
    const offeredBridged = dropPolicyDisabledBridgedTools(bridged.tools, bridged.route, config, desktopOverride);
    return { bridged, runtime, catalog: buildToolCatalog(native.concat(offeredBridged), bridged.route, config) };
  }

  return adaptiveCatalogForMcp;
}

module.exports = { createAdaptiveMcpCatalog };
