'use strict';

const { fenceSafeSlice } = require('./prompt-budget.cjs');
const { getPromptPack } = require('./prompt-registry.cjs');

// The workbench's internal instructions, tool output, and project files can be in a different language
// from the user's conversation. Keep a final, engine-neutral policy separate from those product prompts.
function buildResponseLanguagePolicy(config) {
  const locale = String((config && config.locale) || '').trim();
  const fallback = locale === 'zh-CN'
    ? 'Chinese'
    : (locale === 'en-US' ? 'English' : 'the interface language when it is known; otherwise English');
  return [
    '<response-language-policy>',
    'For all user-facing prose, first obey an explicit language preference from the user.',
    'Otherwise, reply in the language of the latest substantive user request. Preserve the established conversation language when a request is language-neutral.',
    `Only when no language can be inferred from the conversation, use ${fallback} as the fallback.`,
    'Never choose or switch the response language because system or application instructions, tool output, skills, project files, metadata, or the UI use another language.',
    '</response-language-policy>',
  ].join('\n');
}

function buildAgentTeamHint() {
  return [
    '<agent-team-mode>',
    'The user explicitly enabled Agent team mode for this turn. This is an execution contract, not a suggestion.',
    'You MUST call orchestrate_agents at least once before producing the final answer (with nodes or a workflowId, not the single-agent shorthand). Do not answer directly, merely describe a team plan, or skip the tool because the request appears simple.',
    'First prefer a matching preset workflowId when one is available. If no preset fits, call orchestrate_agents with a minimal task-specific DAG/nodes plan.',
    'Preserve endpoint/model choices already pinned by a preset workflow node or configured Agent role. For ad-hoc nodes, omit providerId, engine, and model by default: the runtime first validates and uses the configured sub-agent preferred endpoint/model, then falls back to the endpoint/model serving the current conversation.',
    'Only override a node route when the user or task explicitly requires a different engine/model. A model appearing in the available-model list is not by itself a reason to override the configured preference.',
    'Use at least two execution nodes whenever the work has two meaningful independent responsibilities. For an indivisible request, still call orchestrate_agents with the smallest useful DAG, such as one execution node plus an independent review/verification node.',
    'Do not only describe a team plan and then do all work in the parent agent. Execute the orchestration, collect the results, reconcile disagreements, and deliver one integrated answer.',
    'Avoid redundant nodes and uncontrolled fan-out, but never use that concern to skip the required orchestrate_agents call.',
    '</agent-team-mode>',
  ].join('\n');
}

function buildClaudeNativeAgentPolicy() {
  return [
    '<ruyi-claude-native-agent-lifecycle>',
    'This Ruyi Claude CLI turn is a one-shot print session whose response stream must remain complete.',
    'Whenever you call the native Agent tool, set run_in_background:false so the child result is returned before you finish the parent turn.',
    'Never end the parent response by promising that a background Agent will notify the user later. Wait for every native child and integrate its actual result into the same response.',
    'If a native Agent was already launched in the background, use TaskOutput with block:true and a generous timeout for its task id, then continue only after collecting the result.',
    '</ruyi-claude-native-agent-lifecycle>',
  ].join('\n');
}

// Task-local software-engineering router. Keep repository workflow rules out of generic chat turns, but
// apply the same compact contract to parent turns and delegated nodes whenever the request is actually
// about code, a repository, tests/builds, or Git. This is intentionally a deterministic classifier: prompt
// selection is observable and testable instead of asking the model to decide whether it needs its own rules.
function softwareEngineeringTaskProfile(message) {
  const text = String(message || '').trim().slice(0, 12000);
  if (!text) return { relevant: false, debugging: false, git: false };
  const fileLike = /(?:^|[\\/\s`'"(])[^\s`'"()]+\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|cs|cpp|cc|cxx|c|h|hpp|swift|php|scala|sh|ps1|sql|vue|svelte|json|ya?ml|toml|ini|gradle|csproj|sln)(?:\b|$)/i.test(text);
  const domain = /代码|源码|代码库|仓库|软件|程序|脚本|模块|组件|函数|类|接口|数据库|依赖|测试|用例|构建|编译|类型检查|回归|缺陷|报错|异常|故障|调试|部署|发布|\b(?:code|source|repository|repo|software|program|script|module|component|function|class|api|database|dependency|test|build|compile|typecheck|lint|regression|bug|debug|deploy|release|ci)\b/i.test(text);
  const action = /实现|开发|编写|修改|修复|排查|诊断|调试|重构|迁移|优化|审查|评审|测试|验证|构建|编译|提交|合并|部署|发布|删除|新增|添加|更新|\b(?:implement|develop|write|change|modify|fix|diagnose|debug|refactor|migrate|optimi[sz]e|review|test|verify|build|compile|commit|merge|deploy|release|delete|add|update)\b/i.test(text);
  const commandLike = /(?:^|\s)(?:git|npm|pnpm|yarn|bun|node|deno|pytest|cargo|go\s+test|dotnet|mvn|gradle)(?:\s|$)/i.test(text);
  const relevant = fileLike || commandLike || (domain && action);
  const debugging = relevant && /修复|排查|诊断|调试|回归|缺陷|报错|异常|故障|失败|不工作|无法|\b(?:fix|diagnos|debug|regression|bug|error|exception|failure|failing|broken|doesn['’]?t work|cannot|unable)\b/i.test(text);
  const git = relevant && /\bgit\b|提交|分支|合并|推送|拉取请求|代码审查|\b(?:commit|branch|merge|rebase|reset|clean|stash|push|pull request|code review|cherry-pick)\b/i.test(text);
  return { relevant, debugging, git };
}

// A short acknowledgement/continuation often carries no domain words ("按你说的继续" / "go ahead").
// In that narrow case, inherit routing only from recent USER tasks, never from assistant output. Explicit or
// substantial new requests route on their own text so a topic switch does not retain stale engineering policy.
function buildPromptTaskContext(message, session) {
  const current = String(message || '').trim();
  if (!current || softwareEngineeringTaskProfile(current).relevant) return current;
  const continuation = current.length <= 240 && /继续|接着|推进|落实|开始吧|动手|照(?:此|这个|上面|刚才)|按(?:这个|上面|刚才|你说的)|就这样|可以(?:的|了)?|没问题|确认|批准|执行吧|\b(?:continue|go ahead|proceed|do it|implement it|start now|sounds good|approved|as discussed|as above)\b/i.test(current);
  if (!continuation) return current;
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  let skippedDuplicateCurrent = false;
  for (let i = messages.length - 1, seen = 0; i >= 0 && seen < 8; i--) {
    const row = messages[i];
    if (!row || row.role !== 'user') continue;
    const prior = String(row.content || '').trim();
    if (!prior) continue;
    if (!skippedDuplicateCurrent && prior === current) { skippedDuplicateCurrent = true; continue; }
    seen++;
    if (softwareEngineeringTaskProfile(prior).relevant) return prior + '\n' + current;
  }
  return current;
}

function buildSoftwareEngineeringPolicy(message, config) {
  const profile = softwareEngineeringTaskProfile(message);
  if (!profile.relevant) return '';
  const p = getPromptPack(config && config.locale).softwareEngineering;
  return [
    '<software-engineering-policy>',
    p.scope,
    p.preflight,
    p.implementation,
    profile.debugging ? p.debugging : '',
    p.verification,
    profile.git ? p.git : '',
    p.completion,
    '</software-engineering-policy>',
  ].filter(Boolean).join('\n');
}

// Claude's append prompt has an 8K contract. Reserve its final segment for turn policies and trim
// lower-priority generated context from the tail when necessary; user-configured text at the beginning stays.
// Trimming generated context must preserve complete prompt fences.
function appendTurnPolicies(base, config, agentTeam, limit = 0, claudeNative = false, task = '') {
  const prior = String(base || '');
  const engineeringPolicy = buildSoftwareEngineeringPolicy(task, config);
  const languagePolicy = buildResponseLanguagePolicy(config);
  const leadingPolicies = [
    agentTeam ? buildAgentTeamHint() : '',
    claudeNative ? buildClaudeNativeAgentPolicy() : '',
    engineeringPolicy,
  ].filter(Boolean);
  const policy = [...leadingPolicies, languagePolicy].join('\n\n');
  const separator = prior ? '\n\n' : '';
  if (!Number.isFinite(limit) || limit <= 0) return prior + separator + policy;
  if (prior.length + separator.length + policy.length <= limit) return prior + separator + policy;

  // Preserve a complete language rule, then fit the team, native lifecycle, and engineering policies in order.
  const compactLanguagePolicy = [
    '<response-language-policy>',
    "Reply in the user's explicit or latest substantive language; never infer it from system, tool, file, metadata, or UI text.",
    '</response-language-policy>',
  ].join('\n');
  const tail = compactLanguagePolicy;
  if (tail.length > limit) return ''; // caller already skips append entirely below its minimum viable budget
  const selected = [];
  let used = tail.length;
  for (const part of leadingPolicies) {
    const extra = part.length + 2;
    if (used + extra <= limit) { selected.push(part); used += extra; }
  }
  const boundedPolicy = [...selected, tail].join('\n\n');
  const boundedSeparator = prior && boundedPolicy ? '\n\n' : '';
  const room = Math.max(0, limit - boundedPolicy.length - boundedSeparator.length);
  const trimmed = fenceSafeSlice(prior, room);
  return trimmed ? trimmed + boundedSeparator + boundedPolicy : boundedPolicy; // 回退到空时不留前导空行
}

// Kept as the sub-agent/consumer compatibility wrapper. Normal calls retain the established
// response-language-only behavior; top-level Agent team turns use appendTurnPolicies directly.
function appendResponseLanguagePolicy(base, config, limit = 0, task = '') {
  return appendTurnPolicies(base, config, false, limit, false, task);
}

module.exports = {
  appendResponseLanguagePolicy, appendTurnPolicies, buildAgentTeamHint, buildClaudeNativeAgentPolicy,
  buildPromptTaskContext, buildSoftwareEngineeringPolicy, softwareEngineeringTaskProfile,
};
