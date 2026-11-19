'use strict';

const { nativeToolTier } = require('./native-tool-tiers.cjs');
const { EVAPORATED_PREFIX, READ_DEDUP_PREFIX } = require('./provider-history.cjs');
const { isReducedObservationView } = require('./observation-reduction.cjs');

// ── 压缩后重取守卫(回合内)───────────────────────────────────────────────────────────────────────────
// L1 无条件护住最近一次观测、L2 按单元退化时无条件留下最后一个单元,所以「刚拿到的结果还没看就被压掉 → 重取」
// 这种直接循环不会发生。会发生的是工作集装不下预算时的【抖动】:模型同时要参考 A、B 两份大结果,读 B 把 A 挤出去,
// 回头重读 A 又把 B 挤出去…… 两条既有守卫都抓不到它 —— 同签名连击只认【连续】相同调用(A、B 交替每次都换签名),
// 结果指纹只比【相邻】两次结果(交替的两份内容本就不同);主回合迭代又不设上限。
// 这里按签名(工具名 + 原始参数串,与 09 同签名连击同口径)数:本回合里执行过、而此刻历史中已经没有它的任何一份
// 完整结果(被 L1 缩减/蒸发、或被 L2 重播种整段换掉)时再调一次 = 一次「压缩后重取」。同一签名第 WARN_AT 次提醒模型
// 先记要点或缩小范围,第 REFUSE_AT 次起不执行、回一条说明(配对照常)。被拒后原样重试仍算重取、仍被拒,
// 再连击就交给同签名连击守卫收尾 —— 所以任何签名的抖动都有界。换参数(缩小范围)是新签名,照常执行。
// 「同参数 = 同内容」只对内容型读取成立(review:按全体工具算时,边改边测里第 4 次 `npm test` 会被当成重取拒掉;
// 改完文件再读一遍核对、git_status、截图也一样)。所以:① 只数 COMPACTION_REFETCH_TOOLS 里这些内容型读取;
// ② 本回合一旦有非 read 档的调用(改文件、跑命令、外部 MCP 工具……)就整张表清零 —— 世界可能变了,再读是新信息。
// 纯粹的 A、B 来回重读中间没有任何写动作,照样抓得到。
const COMPACTION_REFETCH_LIMITS = Object.freeze({ WARN_AT: 2, REFUSE_AT: 3 });
const COMPACTION_REFETCH_TOOLS = new Set([
  'file_read', 'file_list', 'file_search', 'glob', 'docs_search', 'codebase_symbol_search', 'project_snapshot',
  'dependency_inventory', 'git_log', 'web_fetch', 'web_search', 'skill_read', 'playbook_read', 'workbench_memory_read', 'observation_recall',
  'steward_file_read', 'steward_web_fetch', 'steward_web_search', 'steward_thread_read', 'steward_thread_artifact_read',
]);
const COMPACTION_REFETCH_REFUSED = 'compaction_refetch_refused';
// 这条工具消息还是不是完整结果:蒸发占位、缩减视图(文本头尾版 / 结构化版)、本守卫自己的拒绝都不算。
// 结构化缩减视图的判据带着未转义的引号 —— 工具结果里若只是【正文】含这几个字(比如读到本文件),
// 它在 JSON 串里是 \" 转义过的,不会误判。
function toolResultIsFull(content) {
  if (typeof content !== 'string') return false;
  if (content.startsWith(EVAPORATED_PREFIX) || content.startsWith(READ_DEDUP_PREFIX) || isReducedObservationView(content)) return false;
  if (content.includes(`"error":"${COMPACTION_REFETCH_REFUSED}"`)) return false;
  return true;
}
// 历史里是否还有「name + rawArgs」这次调用的一份完整结果。按单元就近配对(服务商跨迭代复用 call_1 这类 id)。
function historyHasFullToolResult(history, name, rawArgs) {
  const want = String(rawArgs == null ? '' : rawArgs);
  let ids = null;
  for (const m of Array.isArray(history) ? history : []) {
    if (!m) continue;
    if (m.role === 'assistant') {
      ids = null;
      for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const fn = call && call.function;
        if (fn && fn.name === name && String(fn.arguments == null ? '' : fn.arguments) === want) (ids || (ids = new Set())).add(String(call.id));
      }
    } else if (m.role === 'tool') {
      if (ids && ids.has(String(m.tool_call_id)) && toolResultIsFull(m.content)) return true;
    } else {
      ids = null;
    }
  }
  return false;
}
// 每个回合(主回合 / 子回合)建一个;check 在执行前对每个调用都调(清零要看到非 read 档的调用),
// 返回 { count, action: '' | 'warn' | 'refuse' }。
function createCompactionRefetchGuard() {
  const seen = new Set();
  const counts = new Map();
  return function check(history, name, rawArgs) {
    const bare = String(name || '');
    if (nativeToolTier(bare) !== 'read') { seen.clear(); counts.clear(); return { count: 0, action: '' }; } // 桥接工具不在表里 → exec → 清零
    if (!COMPACTION_REFETCH_TOOLS.has(bare)) return { count: 0, action: '' };
    const sig = bare + ' ' + String(rawArgs == null ? '' : rawArgs);
    if (!seen.has(sig)) { seen.add(sig); return { count: 0, action: '' }; }
    if (historyHasFullToolResult(history, name, rawArgs)) return { count: counts.get(sig) || 0, action: '' };
    const count = (counts.get(sig) || 0) + 1;
    counts.set(sig, count);
    const action = count >= COMPACTION_REFETCH_LIMITS.REFUSE_AT ? 'refuse' : (count >= COMPACTION_REFETCH_LIMITS.WARN_AT ? 'warn' : '');
    return { count, action };
  };
}
function compactionRefetchRefusal(count) {
  return {
    ok: false,
    error: COMPACTION_REFETCH_REFUSED,
    message: `这份结果本回合已有 ${count} 次在被上下文压缩省略后又被重新获取 —— 上下文装不下你同时要用的全部原文,整份重取只会被再次压掉、原地打转,所以这次没有执行。`
      + '请换做法:① 先把已经看到的关键事实、数字、结论写进回复或 todo,再往下做;② 用更窄的参数只取需要的部分(offset/limit、行号范围、更精确的查询);'
      + '③ 分步处理,一次只依赖一份大结果。',
  };
}
function compactionRefetchWarning(count) {
  return `这份结果本回合已第 ${count} 次在被上下文压缩省略后重新获取。若还要同时参考多份大结果,请先把要点记下来或缩小读取范围;再整份重取将被拒绝。`;
}
module.exports = {
  COMPACTION_REFETCH_LIMITS, toolResultIsFull, historyHasFullToolResult,
  createCompactionRefetchGuard, compactionRefetchRefusal, compactionRefetchWarning,
};
