'use strict';

const { getPromptPack } = require('./prompt-registry.cjs');
const { renderProviderStablePrompt } = require('./provider-stable-prompt.cjs');
const { TOOL_REQUIRES, toolRequirementsMet } = require('./tool-capability-policy.cjs');
const { toolPackForName } = require('./tool-catalog.cjs');
const { buildBrowserAutomationHint, buildToolCustomizationHint, buildSkillsPromptSection, buildPlaybookIndexSection } = require('./prompt-context.cjs');

function createProviderPrompt({
  buildRuntimeIdentityFacts, buildEngineEnvBrief,
  buildMemoryCheckPrompt, buildMemoryPromptSection, buildMissionPromptSection,
}) {
  function buildStableSystemPrompt(provider, model, cwd, tools, identityOnly, config) {
    return renderProviderStablePrompt({
      provider, model, cwd, tools, identityOnly, config,
      runtimeIdentity: identityOnly ? null : buildRuntimeIdentityFacts(),
    });
  }
  // 易变层:能力/桌面规程/搜索/风格/项目/技能/记忆/账本(每回合可能变化,自破 prefix cache)。
  // C1b 时移 user 侧;C1a 仍由 buildProviderSystemPrompt 包装进 system(行为零漂移)。
  // 108b: 末尾新增可选参数 playbookEntries(不动任何既有位置参数,旧调用点与快照夹具原样可用)。
  // 只有主回合调用方传它;子代理(08-agent-runs)不与用户对话,不传 -> 天然无 playbook 索引。
  // 145-W3: 末尾再加可选参数 envContext = { session }(不动任何既有位置参数)。传了会话头才认得出「管家代开」;
  // 不传时引擎说明的其余几句照常(权限档/提问弹窗)。
  // #9: 末尾再加可选参数 options。options.memoryTurnTail===true 时本层只含【稳定的核心胶囊】,不含随每条消息变化的检索回执与相关记忆索引 ——
  // 调用方(09 runOpenAiTurn)用 buildMemoryTurnSection 另造那一半,投到末条 user 尾部;这一层前插首条 user,必须跨回合逐字节稳定才吃得到前缀缓存。
  function buildVolatileParts(_provider, tools, caps, config, projectMemory, skillEntries, memoryEntries, mission, memoryConflicts, memoryCheck, playbookEntries, envContext, options) {
    const pack = getPromptPack(config && config.locale);
    const lines = [];
    // [能力层]
    const netStr = caps && caps.network
      ? (caps.network.online === true ? '在线' : (caps.network.online === false ? '离线' : '联网状态未知'))
      : '联网状态未知';
    const deskN = (caps && caps.desktopMcp && Number(caps.desktopMcp.toolCount)) || 0;
    const gitStr = (caps && caps.binaries && caps.binaries.git) ? '有 git' : '无 git';
    // 145-W3:rg 那一格按能力矩阵的 rgShell 说清「终端里能不能直接敲 rg」(随包 vendor-bin 已前置进 PATH)。
    const rgText = pack.engineBrief.rgCapability;
    const rgStr = (caps && caps.binaries && caps.binaries.rg) ? (caps.binaries.rgShell ? rgText.shell : rgText.fast) : rgText.none;
    lines.push(pack.capability.line({ netStr, deskN, gitStr, rgStr }));
    const toolRequiresEnabled = !!(config && config.enableToolRequiresProbe);
    const offeredNames = new Set((tools || []).map(t => t && t.function && t.function.name).filter(Boolean));
    if (offeredNames.has('orchestrate_agents') || offeredNames.has('shell_start')) {
      lines.push(pack.toolProtocol.asyncWork);
    }
    if (offeredNames.has('orchestrate_agents')) {
      const concurrent = Math.max(1, Number(config && config.subagentMaxConcurrent) || 2);
      const total = Math.max(0, Number(config && config.subagentMaxPerTurn) || 0);
      lines.push(pack.capability.subagentConcurrency({ concurrent, total }));
      lines.push(pack.capability.subagentOrchestrate);
      lines.push(pack.capability.subagentResources);
      // 52x: 子 agent 优先端点+模型(设了 subagentPreferredProvider 且 id 有效才提示)
      const spProv = config && config.subagentPreferredProvider;
      if (spProv) {
        const spProvObj = (config.providers || []).find(p => p.id === spProv);
        if (spProvObj) lines.push(pack.capability.subagentPreferred({ provider: spProvObj.label || spProv, model: (config.subagentPreferredModel || '').trim() }));
      }
    }
    if (offeredNames.has('mcp_list') || offeredNames.has('mcp_configure')) lines.push(buildToolCustomizationHint(config));
    // 108c: 提示模型有 workbench_self_status 可查自身版本/位置/端口/设置,别凭记忆回答。
    if (offeredNames.has('workbench_self_status')) lines.push(pack.capability.selfStatus);
    const unavailable = [];
    for (const [name, spec] of Object.entries(TOOL_REQUIRES)) {
      if (spec.testOnly && !toolRequiresEnabled) continue;
      if (offeredNames.has(name)) continue;
      const chk = toolRequirementsMet(name, caps, toolRequiresEnabled, config);
      if (!chk.met) unavailable.push(`${name}（${chk.reason || '当前不可用'}）`);
    }
    if (unavailable.length) lines.push(pack.capability.unavailable({ list: unavailable.join('、') }));
    // [操控规程层]
    const deskToolsOffered = [...offeredNames].some(n => {
      const p2 = toolPackForName(n, {});
      return p2 === 'desktop' || p2 === 'office';
    });
    const deskPresent = !!(caps && caps.desktopMcp && caps.desktopMcp.present && deskToolsOffered);
    if (deskPresent) {
      lines.push(buildBrowserAutomationHint(config));
      lines.push(pack.desktop.sharedMac);
      lines.push(pack.desktop.office);
    }
    // [检索指引]
    const searchBackendOn = !!(config && config.searchBackend && config.searchBackend.type && config.searchBackend.type !== 'none');
    const hasWebSearch = offeredNames.has('web_search')
      || (searchBackendOn && toolRequirementsMet('web_search', caps, false, config).met);
    const onlineNow = !!(caps && caps.network && caps.network.online === true);
    if (hasWebSearch && onlineNow) {
      lines.push(pack.webSearch);
    }
    // [风格层]
    if (config && config.outputStyle === 'concise') {
      lines.push(pack.styleConcise);
    }
    lines.push(...buildEngineEnvBrief({
      engine: 'provider', config, session: envContext && envContext.session, offeredNames,
      rg: { shell: caps && caps.binaries ? caps.binaries.rgShell : '' },
    }).lines);
    // [项目层]
    if (projectMemory && projectMemory.text) {
      const note = projectMemory.truncated ? `（超过 16KB，已截断）` : '';
      lines.push(pack.projectMemory({ note, text: projectMemory.text }));
    }
    // [技能层]
    if (Array.isArray(skillEntries) && skillEntries.length) {
      const skillSec = buildSkillsPromptSection(skillEntries, 'openai', config);
      if (skillSec) lines.push(skillSec);
    }
    // [Playbook 索引层] - 108b · 紧跟技能层之后、记忆层之前
    if (Array.isArray(playbookEntries) && playbookEntries.length) {
      const pbSec = buildPlaybookIndexSection(playbookEntries, config);
      if (pbSec) lines.push(pbSec);
    }
    // [记忆层]
    const memoryTurnTail = !!(options && options.memoryTurnTail === true);
    if (memoryCheck && !memoryTurnTail) {
      const checkSec = buildMemoryCheckPrompt(memoryCheck, config);
      if (checkSec) lines.push(checkSec);
    }
    if (Array.isArray(memoryEntries) && memoryEntries.length) {
      const memSec = buildMemoryPromptSection(memoryEntries, 'openai', config, memoryConflicts, memoryTurnTail ? { part: 'core' } : undefined);
      if (memSec) lines.push(memSec);
    }
    // [工作台记忆核心能力] — 内置工具是唯一入口；写入永远经过候选卡片与用户确认。
    if (Array.isArray(tools) && tools.some(t => t && t.function && t.function.name === 'workbench_memory_propose')) {
      lines.push(pack.memoryCoreGuide({
        list: 'workbench_memory_list', read: 'workbench_memory_read', propose: 'workbench_memory_propose',
        relationPropose: 'workbench_memory_relation_propose', revise: 'workbench_memory_revise', relationRevoke: 'workbench_memory_relation_revoke',
        lazyMaintenance: !(config && config.toolLoadingMode === 'full'), // N8: 三个维护工具在 memory 包,按需装载
      }));
    }
    // [ACC 序列思维工具引导] — 当 sequential_thinking 在工具列表中时，注入使用指引
    if (Array.isArray(tools) && tools.some(t => t && t.function && t.function.name === 'sequential_thinking')) {
      lines.push('[序列思维工具指引]');
      lines.push('你有 sequential_thinking 工具用于外化多步推理链。以下场景应主动使用：');
      lines.push('- 复杂多步规划（>3 步）、方案对比权衡、调试根因分析');
      lines.push('- 最简用法: sequential_thinking(thought="...", thought_number=1, total_thoughts=3, next_thought_needed=true)');
      lines.push('- 简单一步能答的问题不要用（徒增往返）；这不是执行工具，只记录思考过程');
    }
    // [任务账本层]
    if (mission) {
      const misSec = buildMissionPromptSection(mission, 'openai', config);
      if (misSec) lines.push(misSec);
    }
    return lines.join('\n');
  }
  // 向后兼容包装(行为零漂移):identityOnly 时只 stable,否则 stable+volatile。
  function buildProviderSystemPrompt(provider, model, cwd, tools, caps, config, projectMemory, identityOnly, skillEntries, memoryEntries, mission, memoryConflicts, memoryCheck, playbookEntries, envContext) {
    const stable = buildStableSystemPrompt(provider, model, cwd, tools, identityOnly, config);
    if (identityOnly) return stable;
    const volatile = buildVolatileParts(provider, tools, caps, config, projectMemory, skillEntries, memoryEntries, mission, memoryConflicts, memoryCheck, playbookEntries, envContext);
    return volatile ? stable + '\n' + volatile : stable;
  }

  return { buildStableSystemPrompt, buildVolatileParts, buildProviderSystemPrompt };
}

module.exports = { createProviderPrompt };
