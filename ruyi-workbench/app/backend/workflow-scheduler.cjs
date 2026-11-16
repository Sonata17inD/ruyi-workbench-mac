'use strict';
// Pure scheduling decisions; execution and lifecycle remain caller-owned.
function computeSchedulerStep(nodes, opts) {
  const { inFlightIds = [], concurrency = 1, isTerminal, failureContinues, evalCondition, isWaitNode } = opts || {};
  const index = new Map();
  for (const node of nodes) if (!index.has(node.id)) index.set(node.id, node);
  const byId = id => index.get(id);
  const term = n => !!(n && isTerminal(n));
  const isWait = n => (typeof isWaitNode === 'function') ? !!isWaitNode(n) : false; // 第28e波:wait_for 节点谓词
  const inFlight = new Set(inFlightIds);
  const toBlock = [], toSkip = [];
  const blockedIds = new Set(), skippedIds = new Set();
  // ── 阻塞/跳过扫描:仅对【所有依赖已终态】的 queued 节点判定(虚拟标记,不 mutate)。──
  for (const node of nodes) {
    if (node.status !== 'queued') continue;
    const deps = (node.dependsOn || []).map(byId).filter(Boolean);
    if (deps.length !== (node.dependsOn || []).length || !deps.every(term)) continue; // 依赖未全终态 → 本步不动
    // B8: rejected/skipped 前序不算失败;continue 型失败(failureContinues)也不阻塞。
    const tolerateFailedDependencies = node.dependencyPolicy === 'all_settled';
    const blockers = tolerateFailedDependencies ? [] : deps.filter(d => term(d) && d.status !== 'succeeded' && d.status !== 'skipped' && d.status !== 'rejected' && !failureContinues(d));
    if (blockers.length) { toBlock.push({ id: node.id, blockers: blockers.map(b => b.id) }); blockedIds.add(node.id); continue; }
    if (node.condition && evalCondition && !evalCondition(node.condition, nodes, node)) { toSkip.push({ id: node.id }); skippedIds.add(node.id); }
  }
  // ── 就绪:queued 且未被本步 block/skip 且所有依赖终态。数组序保留(与 26a 公平性一致)。──
  const ready = nodes.filter(n => n.status === 'queued' && !blockedIds.has(n.id) && !skippedIds.has(n.id) && (n.dependsOn || []).every(d => term(byId(d))));
  // ── 派发选择:补位到并发上限,跳过已在飞(铁律③)。第28e波:就绪的 wait_for 节点单列 toArm ——【不占并发槽】(timer 模式
  //    可能挂数小时,占槽会毒化并发池),由外壳 arm 为 waiting 态后交 poll 块轮询,绝不进 runNode/子代理(零 token)。──
  const toDispatch = [], toArm = [];
  let slots = concurrency - inFlight.size;
  for (const node of ready) {
    if (isWait(node)) { toArm.push(node.id); continue; }   // wait 节点:单列武装,不消耗 slot
    if (slots <= 0 || inFlight.has(node.id)) continue;      // 派发满位/已在飞 → 跳过(不 break,后续 wait 节点仍要武装)
    toDispatch.push(node.id); slots--;
  }
  const allTerminal = nodes.every(term);
  const anyWaiting = nodes.some(n => n && n.status === 'waiting'); // 第28e波:有等待条件的节点在飞外持续轮转
  // 本轮 block/skip 本身也是调度进展。尤其在线性失败链 a→b→c 中，第一轮只会把 b 标 blocked；必须再跑
  // 一轮才能让 c 看见 b 的终态。旧逻辑会在同一轮把 c 误报成 dependency_cycle。
  const stateTransitions = toBlock.length + toSkip.length;
  const cycleDead = stateTransitions === 0 && toDispatch.length === 0 && toArm.length === 0 && inFlight.size === 0 && !anyWaiting && !allTerminal;
  return { toBlock, toSkip, toDispatch, toArm, allTerminal, cycleDead };
}

// 第98波(P5-A):真实调度波次 -- 静态模拟 computeSchedulerStep 的派发过程,给每个节点标注【首次被派发的波次号】。
// 与前端 crewDepths(纯依赖拓扑层)的区别:纳入并发上限(同层节点多于并发数时拆成多波)与 wait 节点(不占并发槽,同波武装)。
// 静态预估:假设无条件跳过/失败(条件分支的跳过依赖运行时求值结果,无法静态预知),故为"乐观调度波次",供班组图分列。
function computeWaveSeq(nodes, opts) {
  const { concurrency = 1, isWaitNode } = opts || {};
  const list = Array.isArray(nodes) ? nodes.filter(n => n && n.id) : [];
  const index = new Map();
  for (const node of list) if (!index.has(String(node.id))) index.set(String(node.id), node);
  const byId = id => index.get(String(id));
  const isWait = n => (typeof isWaitNode === 'function') ? !!isWaitNode(n) : false;
  const wave = new Map();
  const remaining = new Set(list.map(n => String(n.id)));
  const maxConcurrent = Math.max(1, Math.floor(Number(concurrency) || 1));
  let currentWave = 0;
  let guard = 0;
  while (remaining.size && guard++ < list.length + 4) {
    const ready = [...remaining].filter(id => {
      const n = byId(id);
      const deps = (Array.isArray(n && n.dependsOn) ? n.dependsOn : []).map(String);
      return deps.every(d => wave.has(d));
    });
    if (!ready.length) break; // 依赖环/死锁:剩余节点无法就绪,停止(保留未分配)
    let slots = maxConcurrent;
    for (const id of ready) {
      const n = byId(id);
      if (isWait(n)) { wave.set(id, currentWave); continue; } // wait 节点不占并发槽,同波武装
      if (slots <= 0) continue;                                // 并发满位:留待下一波
      wave.set(id, currentWave); slots--;
    }
    for (const id of ready) if (wave.has(id)) remaining.delete(id);
    currentWave++;
  }
  return wave;
}

module.exports = { computeSchedulerStep, computeWaveSeq };
