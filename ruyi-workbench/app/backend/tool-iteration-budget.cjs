'use strict';

const TOOL_ITERATION_BUDGETS = Object.freeze({ standard: 100, long: 200, standardHard: 300, hard: 1000, extension: 50 });

// Long-task detection is deliberately independent from Agent team mode. A single-agent migration, audit,
// investigation, or end-to-end implementation can be long; conversely, the explicit team switch is an
// orchestration preference. Both receive enough starting room, but for different reasons.
function isLongToolTask(message, context = {}) {
  if (context.driverAuto === true || context.hasMission === true) return true;
  const text = String(message || '').trim();
  if (text.length >= 1200) return true;
  const explicitLong = /长任务|复杂任务|持续推进|自主推进|不要停|端到端|全面(?:实现|测试|排查|审计)|完整(?:实现|迁移|重构)|批量(?:处理|迁移|测试)|系统性(?:排查|研究|评测)|\b(?:long[- ]running|complex task|end[- ]to[- ]end|comprehensive|systematic|autonomously continue|do not stop|benchmark|migration|refactor|audit|investigation)\b/i;
  if (explicitLong.test(text)) return true;
  const implementation = /实现|修改|开发|构建|修复|迁移|重构|implement|build|change|fix|migrate|refactor/i.test(text);
  const verification = /测试|验证|回归|打包|部署|发布|重启|提交|推送|test|verify|regression|package|deploy|release|restart|commit|push/i.test(text);
  return implementation && verification && (text.length >= 160 || /然后|并且|同时|and then|as well as/i.test(text));
}

function resolveToolIterationBudget(configured, message, context = {}) {
  const raw = Math.round(Number(configured));
  const base = Number.isFinite(raw) ? Math.max(1, Math.min(200, raw)) : TOOL_ITERATION_BUDGETS.standard;
  const longTask = isLongToolTask(message, context);
  const agentTeam = context.agentTeam === true;
  const elevated = longTask || agentTeam;
  return {
    base,
    initial: elevated ? Math.max(base, TOOL_ITERATION_BUDGETS.long) : base,
    hardLimit: elevated ? TOOL_ITERATION_BUDGETS.hard : TOOL_ITERATION_BUDGETS.standardHard,
    extension: TOOL_ITERATION_BUDGETS.extension,
    mode: agentTeam ? 'agent-team' : (longTask ? 'long' : 'standard'),
    longTask,
    agentTeam,
  };
}

function shouldExtendToolIterationBudget({ currentLimit, hardLimit, iter, lastProgressIter, progressEvents, progressAtLastExtension }) {
  if (!(currentLimit < hardLimit)) return false;
  if ((Number(progressEvents) || 0) - (Number(progressAtLastExtension) || 0) < 3) return false;
  return (Number(iter) || 0) - (Number(lastProgressIter) || 0) <= 8;
}

module.exports = { TOOL_ITERATION_BUDGETS, resolveToolIterationBudget, shouldExtendToolIterationBudget };
