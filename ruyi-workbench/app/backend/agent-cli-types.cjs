'use strict';
const AGENT_CLI_DEFAULT_TYPE = 'claude';
const AGENT_CLI_TYPES = Object.freeze({
  claude: Object.freeze({
    id: 'claude', label: 'Claude Code', pathKey: 'claudePath', detectedKey: 'detectedClaudePath', streaming: true, interactive: true, mcp: 'argument',
    usesStreamJsonInput: config => config.engineMode === 'interactive',
    hasNativeQuestionPrompt: () => false,
    installCandidates: () => [],
    detectPath: cliHost => cliHost.detectClaudePath(),
    prepareSpawn: (cliHost, command, argv) => ({ command, args: argv, opts: {} }),
    // Claude 每回合经 --mcp-config 拿如意的 MCP 配置(05 适配器 buildArgs),没有用户配置文件要推。
    syncMcpManifest: async () => {},
  }),
  codex: Object.freeze({
    id: 'codex', label: 'Codex CLI', pathKey: 'codexPath', detectedKey: 'detectedCodexPath', streaming: true, interactive: true, mcp: 'thread',
    usesStreamJsonInput: () => false,
    hasNativeQuestionPrompt: () => true,
    installCandidates: () => [],
    detectPath: host => host.detectCodexPath(),
    prepareSpawn: (_host, command, args) => ({ command, args, opts: {} }),
    syncMcpManifest: async () => {},
  }),
});

// 「这是不是一个登记过的 CLI 类型」—— 只认登记表自己的键(不认 toString / constructor 这类原型链上的名字)。
function isAgentCliType(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AGENT_CLI_TYPES, value);
}
function normalizeAgentCliType(value, fallback = AGENT_CLI_DEFAULT_TYPE) {
  return isAgentCliType(value) ? value : fallback;
}

module.exports = { AGENT_CLI_DEFAULT_TYPE, AGENT_CLI_TYPES, isAgentCliType, normalizeAgentCliType };
