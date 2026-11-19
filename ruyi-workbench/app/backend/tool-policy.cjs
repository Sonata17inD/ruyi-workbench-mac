'use strict';
const TOOL_INVOKE_TARGET_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
function toolInvokeInnerEnvelope(v) {
  let inner = v;
  if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { return null; } }
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null;
  if (typeof inner.name !== 'string' || !TOOL_INVOKE_TARGET_NAME.test(inner.name.trim())) return null;
  if (!Object.keys(inner).every(k => k === 'name' || k === 'arguments')) return null;
  return inner.arguments === undefined ? { name: inner.name } : { name: inner.name, arguments: inner.arguments };
}
function toolInvokeEnvelopeRepair(args) {
  let out = args;
  let repair = null;
  // 最多剥两层(真机只见过一层)。上限不能再放:Claude CLI 路径上权限桥看到的是【还原前】的原始入参,06i 高风险扫描只摊平
  // 4 层(STEWARD_EXEMPT_INPUT_DEPTH);剥两层时能被执行的形状里,命令串最深在第 4 层,全在扫描范围内。剥不开的照旧被拒。
  for (let depth = 0; depth < 2; depth += 1) {
    if (!out || typeof out !== 'object' || Array.isArray(out)) break;
    const inner = toolInvokeInnerEnvelope(out.arguments);
    if (!inner) break;
    const outerName = typeof out.name === 'string' ? out.name.trim() : '';
    if (outerName.startsWith('tool_invoke_')) { out = inner; repair = repair || 'self_wrap'; continue; }
    const outerOnlyEnvelope = Object.keys(out).every(k => k === 'name' || k === 'arguments');
    if (!outerName && outerOnlyEnvelope && (out.name == null || typeof out.name === 'string')) { out = inner; repair = repair || 'nested_name'; continue; }
    break;
  }
  return { args: out, repair };
}
// tool_invoke_* 入参归一:先还原上面两种写歪的壳;name 去首尾空白(修前带空格的 ' file_read ' 报「tool not found」);arguments 给成
// JSON 字符串(模型常这么写)时解析成对象 —— 解析不出对象的原样保留,交给入参校验给出「arguments 必须是对象」。
function normalizeToolInvokeArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  let out = toolInvokeEnvelopeRepair(args).args;
  if (typeof out.name === 'string' && out.name !== out.name.trim()) out = { ...out, name: out.name.trim() };
  if (typeof out.arguments === 'string') {
    try {
      const v = JSON.parse(out.arguments);
      if (v && typeof v === 'object' && !Array.isArray(v)) out = { ...out, arguments: v };
    } catch { /* 不是 JSON:保持字符串,由入参校验报错 */ }
  }
  return out;
}

function createToolPolicy({ TOOL_TIER_RANK, resolveBridge, bridgedToolTier, nativeToolTier }) {
// 引擎在回合闭包里特判的工具(需要活的 session / onEvent / provider 闭包,不能经 toolCall 的无上下文 handler 跑)。
// 模型常常不直接调,而是 tool_invoke_read/edit/exec {name:'todo_write', arguments:{...}} 走代理 —— 代理分发到 toolCall,
// 命中的是无回合上下文的兜底 handler:todo_write / mission_update 回 ok:true 却没有任何落盘/事件(静默空操作),
// agent_result / wait_agents / request_user_input / orchestrate_agents 报「仅在 provider 回合可用」(人就在 provider 回合里)。
// 所以代理调用这些名字时在入口【解开】,等价于直调、走同一条特判与同一套闸。
// C2 scratchpad_write 同列:它不在 MCP_TOOLS 里,12 的代理目录找不到它(只会回 unknown-tool),解开成直调才走主回合那条路。
const PROXY_UNWRAP_TARGETS = new Set([
  'todo_write', 'mission_update', 'request_user_input', 'list_tools', 'tool_search', 'tool_load',
  'orchestrate_agents', 'spawn_agent', 'wait_agents', 'agent_result', 'scratchpad_write',
]);
const PROXY_UNWRAP_AGENT_TARGETS = new Set(['orchestrate_agents', 'spawn_agent', 'wait_agents', 'agent_result']);
// tc: {id, name, rawArgs}。返回原对象(不需要解开 / 解不开)或 {...tc, name: 目标, rawArgs: 内层参数}。
// offered:可选的「本回合可用工具名」集合 —— 给了就要求代理目标里的代理类工具在其中(功能关闭 / 子回合禁嵌套时它们本就不 offer,
// 不能借代理绕开);不给(计划阶段判定)则一律解开,按直调同样严格地判。
function unwrapProxiedControlCall(tc, offered) {
  if (!tc || typeof tc.name !== 'string' || !tc.name.startsWith('tool_invoke_')) return tc;
  let outer;
  try { outer = JSON.parse(tc.rawArgs || '{}'); } catch { return tc; }
  outer = normalizeToolInvokeArgs(outer);
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) return tc;
  const target = typeof outer.name === 'string' ? outer.name.trim() : '';
  if (!PROXY_UNWRAP_TARGETS.has(target)) return tc;
  if (offered && PROXY_UNWRAP_AGENT_TARGETS.has(target) && !offered.has(target)) return tc;
  const inner = outer.arguments;
  if (inner !== undefined && (inner === null || typeof inner !== 'object' || Array.isArray(inner))) return tc; // 参数坏了:留给原路径给 invalid-arguments
  return { ...tc, name: target, rawArgs: JSON.stringify(inner || {}) };
}

// 代理壳还原(02f toolInvokeEnvelopeRepair)放在【入批处】做、直接改写 rawArgs:权限闸、hook、循环签名、并行只读岛、
// providerHistory(下一发里模型看到的是自己这次调用的正统写法,照着抄就不再错)、回合账,看到的都是同一份参数 ——
// 与 providerHistoryToolCalls 的「历史说的就是实际跑的那份参数」同一条不变量。不需要还原 / 参数坏了的原样返回(同一引用)。
// tc: {id, name, rawArgs};还原过的多带 proxyRepair('self_wrap' | 'nested_name'),只给埋点用。
function canonicalToolInvokeCall(tc) {
  if (!tc || typeof tc.name !== 'string' || !tc.name.startsWith('tool_invoke_')) return tc;
  let parsed;
  try { parsed = JSON.parse(tc.rawArgs || '{}'); } catch { return tc; }
  const { args, repair } = toolInvokeEnvelopeRepair(parsed);
  if (!repair) return tc;
  return { ...tc, rawArgs: JSON.stringify(args), proxyRepair: repair };
}

// 61-B2:代理档低报(tool_invoke_read 去叫 exec 档的 shell_run)时,在入批处改写成目标档的代理 —— 只升不降。
// 改写发生在权限闸之前,等价于模型一次就选对:闸照常按改写后的代理档(= 目标真实档)判,不多放一个调用;
// 12 invokeAdaptiveMcpTool 的 tier-mismatch 检查留作纵深防御。只在模型服务商回合做:MCP / CLI 路径里审批已在 CLI 侧按
// 低档代理名发生,子进程里升档就是提权,那边只回错误与正确代理名。桥接目标按【本次入参】定档(与 12 的重校同口径)。
// 历史里记的是改写后的调用(与壳还原同一条「历史即实际执行」的不变量),模型照着抄就不再选错。
const RETIER_SKIP_TARGETS = new Set(['list_tools', 'tool_search', 'tool_load', 'permission_prompt']);
function retierToolInvokeCall(tc, catalog, bridgedRoute, config) {
  if (!tc || typeof tc.name !== 'string' || !tc.name.startsWith('tool_invoke_')) return tc;
  const proxyTier = tc.name.slice('tool_invoke_'.length);
  if (!Object.prototype.hasOwnProperty.call(TOOL_TIER_RANK, proxyTier)) return tc;
  let parsed;
  try { parsed = JSON.parse(tc.rawArgs || '{}'); } catch { return tc; }
  const target = parsed && typeof parsed.name === 'string' ? parsed.name.trim() : '';
  if (!target || RETIER_SKIP_TARGETS.has(target) || target.startsWith('tool_invoke_')) return tc;
  const item = (catalog || []).find(x => x && x.name === target);
  if (!item) return tc;   // 目录里没有:原样交给 12,回 unknown-tool + didYouMean
  const bridge = resolveBridge(bridgedRoute || {}, target);
  const targetArgs = (parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)) ? parsed.arguments : {};
  const targetTier = bridge ? bridgedToolTier(bridge.toolName, config, targetArgs) : item.tier;
  if (!Object.prototype.hasOwnProperty.call(TOOL_TIER_RANK, targetTier) || TOOL_TIER_RANK[targetTier] <= TOOL_TIER_RANK[proxyTier]) return tc;
  return { ...tc, name: 'tool_invoke_' + targetTier, proxyRepair: tc.proxyRepair ? tc.proxyRepair + '+retier' : 'retier' };
}

// Plan mode may investigate before proposing a plan, but it must stay observational. The normal permission
// tier is the source of truth for file/web/bridge reads; planning metadata and agent coordination are excluded
// even though some are classified as read-tier for the regular autonomous loop. Unknown tools fail closed via
// nativeToolTier(...)=exec. Pure and exported so regressions can be tested without starting a provider turn.
// C2 scratchpad_write 有意【不】在此列:它只写模型自己的会话草稿(不进界面步骤条、不进任务账本、不动用户文件),计划阶段边查边记
// 正是它的用处;列进来的话 [file_read, scratchpad_write] 这种批会被整批拒掉。
const PLAN_DISCOVERY_BLOCKED_TOOLS = new Set([
  'permission_prompt', 'todo_write', 'mission_update',
  'propose_task', 'send_to_agent', 'orchestrate_agents', 'wait_agents',
]);
function planDiscoveryToolBatchAllowed(toolCalls, bridgedRoute, config) {
  const calls = Array.isArray(toolCalls) ? toolCalls.filter(Boolean) : [];
  if (!calls.length) return false;
  return calls.every(tc0 => {
    if (tc0.serverSide) return true; // Provider-executed search/open calls are observational.
    // tool_invoke_* 代理的目标是这轮会被引擎特判的工具时,按【目标】判(下方 unwrapProxiedControlCall 会把它当直调执行):
    // 否则 tool_invoke_read{name:'todo_write'} 凭代理名的 read 档溜过计划阶段的拦截。
    let tc = unwrapProxiedControlCall(tc0);
    // Planning runs before tier correction. Never trust a proxy's advertised
    // tier: resolve the actual target and its arguments before classifying it.
    if (String(tc.name || '').startsWith('tool_invoke_')) {
      let outer;
      try { outer = normalizeToolInvokeArgs(JSON.parse(tc.rawArgs || '{}')); } catch { return false; }
      if (!outer || typeof outer.name !== 'string' || !outer.name.trim() || outer.name.startsWith('tool_invoke_')) return false;
      const args = outer.arguments;
      if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) return false;
      tc = { ...tc, name: outer.name.trim(), rawArgs: JSON.stringify(args || {}) };
    }
    const name = String(tc.name || '').trim();
    if (!name || PLAN_DISCOVERY_BLOCKED_TOOLS.has(name)) return false;
    const bridge = resolveBridge(bridgedRoute || {}, name);
    return (bridge ? bridgedToolTier(bridge.toolName, config, tc.rawArgs || tc.input || {}) : nativeToolTier(name)) === 'read';
  });
}

// N9: 并行只读「岛」规划(纯函数,可独立测试)。修前「整批全是安全只读」才并发,批里混进一个 todo_write / tool_search
// (模型几乎总这么发)或一次编辑,整批就退回串行 —— [web_search ×3, todo_write] 耗时是 4 倍。
// 现在:岛 = 批里【排在第一个有副作用/阻塞调用之前】的安全只读调用,它们并发预执行;之后的调用照旧按原顺序串行,
// 结果仍按原顺序消费(预执行结果按 id 存表,串行循环取用 —— 配对/历史/hook/事件顺序不变)。
// 为什么只取「第一个阻塞调用之前」:串行语义里排在编辑之后的读要看见编辑的结果([file_read A, file_edit A, file_read A]
// 的第二次读必须读到改后内容),把它提前并发执行就读到旧内容 —— 所以阻塞调用一出现岛就关门,其后的读不入岛。
// 中性调用(不影响后面的读、也不被读影响:todo_write / tool_search / list_tools / tool_load,以及参数坏了、串行路径会直接拒绝
// 的调用)不关门。岛不足 2 个时返回 []:单个只读没有并发收益,保持原串行路径(hook/事件时序逐字节不变)。
// isSafeRead(tc):原生、read 档、非控制面/非桥接、参数有效;isRefused(tc):串行路径会按参数错误直接拒绝它。
// C2 scratchpad_write 也是中性的(只动会话草稿,与文件读互不影响);它本身不预执行(PARALLEL_UNSAFE),同批多次写按原顺序串行。
const PARALLEL_READ_NEUTRAL = new Set(['todo_write', 'tool_search', 'list_tools', 'tool_load', 'scratchpad_write']);
function planParallelReadIsland(calls, isSafeRead, isRefused) {
  const island = [];
  for (const tc of (Array.isArray(calls) ? calls : [])) {
    if (isSafeRead(tc)) { island.push(tc); continue; }
    if (tc && tc.name && (PARALLEL_READ_NEUTRAL.has(tc.name) || isRefused(tc))) continue;   // 中性:不关门
    break;                                                                                   // 阻塞:岛到此为止
  }
  return island.length >= 2 ? island : [];
}

return { unwrapProxiedControlCall, canonicalToolInvokeCall, retierToolInvokeCall, planDiscoveryToolBatchAllowed, planParallelReadIsland };
}
module.exports = { createToolPolicy, toolInvokeInnerEnvelope, toolInvokeEnvelopeRepair, normalizeToolInvokeArgs };
