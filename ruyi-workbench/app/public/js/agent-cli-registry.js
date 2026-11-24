'use strict';

export const AGENT_CLI_DEFAULT_ID = 'claude';

export const AGENT_CLI_REGISTRY = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    avatarLetter: 'C',
    eventTag: 'claude',
    pathKey: 'claudePath',
    detectedKey: 'detectedClaudePath',
    thinkingEfforts: Object.freeze(['', 'low', 'medium', 'high', 'xhigh', 'max']),
    compactDefaultLabelKey: 'ctx.compact.defaultClaude',
    claudeUserCommands: true, agentTeam: true, modelsEndpoint: '',
  }),
  codex: Object.freeze({
    id: 'codex', label: 'Codex CLI', avatarLetter: 'X', eventTag: 'codex',
    pathKey: 'codexPath', detectedKey: 'detectedCodexPath',
    thinkingEfforts: Object.freeze(['', 'low', 'medium', 'high', 'xhigh']),
    compactDefaultLabelKey: 'ctx.compact.defaultCodex', claudeUserCommands: false, agentTeam: false,
    modelsEndpoint: '/api/codex/models',
  }),
});

export const cliModelKey = id => id === 'codex' ? 'codexModel' : 'model';
export const cliEffortKey = id => id === 'codex' ? 'codexThinkingEffort' : 'claudeThinkingEffort';

// 表的键，按登记顺序（设置页主模型下拉、管家引擎菜单的列出顺序就是它）。
export const AGENT_CLI_IDS = Object.freeze(Object.keys(AGENT_CLI_REGISTRY));

// 共用控件展示的强度档位按驱动登记顺序取并集。
export const AGENT_CLI_THINKING_EFFORT_VALUES = Object.freeze([...new Set(AGENT_CLI_IDS.flatMap(id => AGENT_CLI_REGISTRY[id].thinkingEfforts))]);

export function isAgentCliId(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AGENT_CLI_REGISTRY, value);
}
// 不认识的值（缺省、旧数据、非字符串）一律归到缺省 CLI —— 与服务端 selectedAgentCli 同一判据。
export function normalizeAgentCliType(value) {
  return isAgentCliId(value) ? value : AGENT_CLI_DEFAULT_ID;
}
// 那一行（不认识的值 → 缺省 CLI 那一行）。
export function agentCliMeta(value) {
  return AGENT_CLI_REGISTRY[normalizeAgentCliType(value)];
}
// 认识就给那一行，不认识给 null（需要区分「没登记」的调用点用，例如头像徽标的 'Agent CLI' 兜底名）。
export function knownAgentCliMeta(value) {
  return isAgentCliId(value) ? AGENT_CLI_REGISTRY[value] : null;
}

// Historical routes retain an explicit driver id until the user changes engines.
export function storedAgentCliType(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : AGENT_CLI_DEFAULT_ID;
}
