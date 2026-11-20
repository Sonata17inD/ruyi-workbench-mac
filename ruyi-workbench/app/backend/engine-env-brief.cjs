'use strict';

const crypto = require('node:crypto');
const { AGENT_CLI_DEFAULT_TYPE, AGENT_CLI_TYPES, isAgentCliType } = require('./agent-cli-types.cjs');
const { PERMISSION_MODES } = require('./agent-role-policy.cjs');
const { RUYI_MCP_CLI_TOOL_PREFIX } = require('./product-identity.cjs');
const { getPromptPack, PROMPT_EN } = require('./prompt-registry.cjs');

// CLI engines use the same capability facts and memoize rendered text by those facts.
function createEngineEnvBrief({ appName, buildRuntimeIdentityFacts, probeRgAsync }) {
  const ENGINE_BRIEF_OPEN = '<ruyi-environment>';
  const ENGINE_BRIEF_CLOSE = '</ruyi-environment>';
  const memo = new Map();
  function engineBriefFacts({ engine, config, session, rg } = {}) {
    const cfg = config || {};
    const kind = isAgentCliType(engine) ? engine : ((engine === 'provider' || engine === 'openai') ? 'provider' : AGENT_CLI_DEFAULT_TYPE);
    const runtime = buildRuntimeIdentityFacts();
    const deskOverride = session && typeof session.desktopTools === 'boolean' ? session.desktopTools : null;
    const allowDesk = deskOverride == null ? cfg.allowDesktopTools !== false : deskOverride;
    const rgShell = rg && (rg.shell === 'bundled' || rg.shell === 'system') ? rg.shell : '';
    return {
      engine: kind,
      locale: getPromptPack(cfg.locale) === PROMPT_EN ? 'en-US' : 'zh-CN',
      version: runtime.version,
      launchMode: runtime.launchMode,
      mcp: kind !== 'provider' && cfg.includeWorkbenchMcp !== false,
      interactive: kind !== 'provider' && AGENT_CLI_TYPES[kind].usesStreamJsonInput(cfg),
      orchestrate: Number(cfg.subagentMaxPerTurn) > 0,
      desktop: !!(cfg.desktopMcp && cfg.desktopMcp.enabled) && allowDesk,
      rgShell,
      permissionMode: PERMISSION_MODES.includes(cfg.permissionMode) ? cfg.permissionMode : 'default',
      stewardOpened: !!(session && (session.createdBy === 'steward' || session.origin === 'steward')),
    };
  }
  function renderCliEnvBrief(f) {
    const askNative = AGENT_CLI_TYPES[f.engine].hasNativeQuestionPrompt();
    const pack = getPromptPack(f.locale);
    const b = pack.engineBrief;
    const lines = [ENGINE_BRIEF_OPEN];
    lines.push(b.cliIdentity({ appName, version: f.version, launchMode: f.launchMode, engineName: b.engineName[f.engine] }));
    lines.push(b.nativeTools[f.engine]);
    lines.push(pack.toolProtocol.intro);
    if (f.mcp) {
      lines.push(b.mcpIntro({ prefix: RUYI_MCP_CLI_TOOL_PREFIX }));
      lines.push(b.mcpMemory);
      lines.push(askNative ? b.askNative : b.mcpAsk + (f.interactive ? b.mcpAskNoNative : ''));
      lines.push(b.mcpToolSearch);
      if (f.orchestrate) lines.push(b.mcpOrchestrate);
      lines.push(b.mcpSelfStatus);
    } else if (askNative) {
      lines.push(b.askNative);
    }
    lines.push(f.desktop ? b.desktopOn : b.desktopOff);
    lines.push(b.rgShell[f.rgShell || 'none']);
    lines.push([b.renderMarkdown, b.renderDiagram].join(f.locale === 'en-US' ? ' ' : ''));
    lines.push(b.workspace);
    lines.push(b.permission(b.permissionModes[f.permissionMode] || b.permissionModes.default) + b.permissionRefusal);
    lines.push(b.steward);
    if (f.stewardOpened) lines.push(b.stewardOpened);
    lines.push(ENGINE_BRIEF_CLOSE);
    return lines.join('\n');
  }
  function providerEnvLines(f, offeredNames) {
    const b = getPromptPack(f.locale).engineBrief;
    const lines = [b.permission(b.permissionModes[f.permissionMode] || b.permissionModes.default)];
    if (offeredNames && offeredNames.has('request_user_input')) lines.push(b.askProvider);
    if (f.stewardOpened) lines.push(b.stewardOpened);
    return lines;
  }
  function buildEngineEnvBrief(opts = {}) {
    const facts = engineBriefFacts(opts);
    const fingerprint = crypto.createHash('sha1').update(JSON.stringify(facts), 'utf8').digest('hex').slice(0, 12);
    if (facts.engine === 'provider') {
      return { text: '', lines: providerEnvLines(facts, opts.offeredNames), fingerprint, facts };
    }
    let text = memo.get(fingerprint);
    if (text === undefined) {
      text = renderCliEnvBrief(facts);
      if (memo.size > 64) memo.clear();
      memo.set(fingerprint, text);
    }
    return { text, lines: [], fingerprint, facts };
  }
  // Resolve ripgrep through the shared executable probe.
  async function resolveEngineEnvBrief(opts = {}) {
    const rg = opts.rg !== undefined ? opts.rg : await probeRgAsync().catch(() => null);
    return buildEngineEnvBrief({ ...opts, rg });
  }

  return { buildEngineEnvBrief, resolveEngineEnvBrief };
}

// 61-A3:给模型看的本地时间(provider 引擎每条 user 消息落历史时带一行,文案在 06b turnTime)。分钟粒度;
// weekday 0 = 周日;offset 形如 UTC+08:00(日志 ts 是 UTC,模型要换算时靠它)。
function localTurnTimeParts(ms) {
  const d = new Date(ms);
  const p2 = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return {
    stamp: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`,
    weekday: d.getDay(),
    offset: `UTC${off >= 0 ? '+' : '-'}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`,
  };
}

function createRuntimeIdentityFacts({ RUNTIME, DEFAULT_PORT, APP_NAME, VERSION, OVERLAY_ID, externalRoot, dataRoot }) {
  function buildRuntimeIdentityFacts() {
    const host = (typeof RUNTIME !== 'undefined' && RUNTIME && RUNTIME.host) || '127.0.0.1';
    const port = (typeof RUNTIME !== 'undefined' && RUNTIME && RUNTIME.port) || DEFAULT_PORT;
    return {
      appName: APP_NAME,
      version: VERSION,
      launchMode: 'node',
      installDir: externalRoot(),
      dataDir: dataRoot(),
      address: 'http://' + host + ':' + port,
      instanceId: OVERLAY_ID,
    };
  }
  return buildRuntimeIdentityFacts;
}

module.exports = { localTurnTimeParts, createRuntimeIdentityFacts, createEngineEnvBrief };
