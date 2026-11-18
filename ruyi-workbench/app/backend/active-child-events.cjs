'use strict';

function createActiveChildEvents({
  nowIso,
}) {

  const LIVE_TAIL_CHARS = 600;
  const LIVE_FULL_CHARS = 12000;
  const LIVE_TOOLS_MAX = 20;
  function appendLiveTail(reg, evt) {
    if (!reg || !evt) return;
    // 代理模式 v2:子代理自己的工具事件(带 subagentId)不进父回合的实时工具列表与迭代计数 —— 它们只属于代理卡/代理面板。
    if (evt.subagentId) return;
    const tail = reg.liveTail && typeof reg.liveTail === 'object' ? reg.liveTail : (reg.liveTail = { text: '', tool: '', updatedAt: '' });
    // 05/09 建的仍是 117l 那个三字段裸对象(本波不碰那两个文件),缺的字段在这里就地补齐 —— 累加器是
    // 唯一的写口,补在这里就不会有「某条路径的 reg 少个键」的形状分叉。
    if (typeof tail.full !== 'string') tail.full = '';
    if (typeof tail.truncated !== 'boolean') tail.truncated = false;
    if (!Array.isArray(tail.tools)) tail.tools = [];
    if (typeof tail.startedAt !== 'string') tail.startedAt = '';
    if (!Number.isFinite(tail.iterations)) tail.iterations = 0;
    const type = String(evt.type || '');
    const at = nowIso();
    if (type === 'assistant_delta') {
      const chunk = String(evt.text || '');
      if (!chunk) return;
      tail.text = (tail.text + chunk).slice(-LIVE_TAIL_CHARS);
      const merged = tail.full + chunk;
      if (merged.length > LIVE_FULL_CHARS) { tail.full = merged.slice(merged.length - LIVE_FULL_CHARS); tail.truncated = true; }
      else tail.full = merged;
    } else if (type === 'tool_use') {
      const name = String(evt.name || evt.tool || '').slice(0, 80);
      tail.tool = name;
      // 轮次:provider 路径有 batchId(09 的包装给同一批并行工具打同一个),换批才 +1;Claude 路径没有
      // batchId,退化成「上一个事件不是 tool_use 就算新的一轮」。两条路都不把一批并行工具数成 N 轮。
      const batch = String(evt.batchId || '');
      const sameBatch = batch ? batch === tail.batchMark : tail.lastKind === 'tool_use';
      if (!sameBatch) tail.iterations += 1;
      tail.batchMark = batch;
      tail.tools.push({ id: String(evt.id || ''), name, startedAt: at, endedAt: '', status: 'running' });
      while (tail.tools.length > LIVE_TOOLS_MAX) tail.tools.shift();
    } else if (type === 'tool_result') {
      tail.tool = '';
      const id = String(evt.id || '');
      for (let i = tail.tools.length - 1; i >= 0; i -= 1) {
        const row = tail.tools[i];
        if (!row || row.status !== 'running') continue;
        if (id && row.id && row.id !== id) continue;
        row.endedAt = at;
        row.status = evt.isError ? 'error' : 'done';
        break;
      }
    } else return;
    tail.lastKind = type;
    if (!tail.startedAt) tail.startedAt = Number.isFinite(reg.startedAt) ? new Date(reg.startedAt).toISOString() : at;
    tail.updatedAt = at;
    notifyActiveChildTaps(reg, evt);   // 121-K2a:尾巴刚变过 —— 见下面那段头注
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 第 121 波 K2a(34 号文 §6.1 第 1 条):活回合事件的【旁路订阅者】。
  //
  // 34 号文摸底把 `reg.onEvent` 写成「唯一的扇出点」。实测不是:05:9-10 与 09:1238-1239 两处头注
  // 说得很清楚 —— `reg.onEvent` 只看得见【桥接/MCP 那一路】的事件,引擎自己流出来的
  // assistant_delta / tool_use / tool_result 走的是两个引擎各自的【本地 onEvent 包装】。
  // 那个包装里两条路唯一的交汇点就是上面的 appendLiveTail(117l D4 为了「同一份口径」才抽出来的)。
  // 所以旁路订阅装在【两处】,一份订阅者名单:
  //   ① appendLiveTail 末尾 —— 尾巴真的变过之后才通知(thread.live 要的正是这份尾巴);
  //   ② installActiveChildEventFanout 包装的 reg.onEvent —— 桥接/MCP 那一路的事件。
  // 两条路对同一个事件可能各通知一次(桥接事件会先进 reg.onEvent 再落到本地包装),订阅者按会话
  // 节流,重复不产生第二条帧;宁可多通知一次,也不要因为「猜哪条路会到」而漏。
  //
  // 三条纪律:
  //   ① 引擎自己那个订阅者(05:491 / 09:1389 装的 reg.onEvent)行为【逐字不变】且【第一个收到】——
  //      旁路一律排在它后面,且不参与它的异常传播(它抛,旁路就不跑,原路径的语义一个字不变);
  //   ② 旁路订阅者抛错就地吞掉 —— 观察面绝不反噬回合;
  //   ③ 旁路只读 reg,不许改它的任何字段。
  const ACTIVE_CHILD_EVENT_TAPS = new Set();
  function subscribeActiveChildEvents(fn) {
    if (typeof fn !== 'function') return () => {};
    ACTIVE_CHILD_EVENT_TAPS.add(fn);
    return () => { ACTIVE_CHILD_EVENT_TAPS.delete(fn); };
  }
  function notifyActiveChildTaps(reg, evt) {
    if (!ACTIVE_CHILD_EVENT_TAPS.size) return;   // 零订阅者 = 零开销(同 RUYI_EVENTS.emit)
    for (const tap of ACTIVE_CHILD_EVENT_TAPS) {
      try { tap(reg, evt); } catch { /* 纪律②:旁路的错不许回流到回合 */ }
    }
  }
  // 把一份【已经装好引擎订阅者】的 reg 改成多订阅者:原来那个函数原样保留并永远第一个收到,
  // 旁路名单排在它后面。两个引擎各在 `reg.onEvent = ...` 之后调一次。
  function installActiveChildEventFanout(reg) {
    if (!reg || typeof reg.onEvent !== 'function' || reg.__eventFanout) return reg;
    const engineSubscriber = reg.onEvent;   // 纪律①:它是第一个,也是唯一一个能影响回合的
    reg.__eventFanout = true;
    reg.onEvent = evt => {
      engineSubscriber(evt);                // 原行为逐字不变(含它自己的异常传播)
      notifyActiveChildTaps(reg, evt);
    };
    return reg;
  }
  // 回合 settle 登记表(第69波 rewind 竞态修复):sessionId -> { promise, resolve }。driver(chat/stream)
  // 在回合开始登记、driver finally(收尾 saveSession 已落盘后)resolve 并删除。stopSession 会立即删
  // activeChildren,但被停回合的收尾(推 aborted assistant + saveSession)发生在此之后 —— rewindSession
  // 若只看 activeChildren 就会在这个窗口截断落盘,然后被 dying turn 的收尾 save 整份盖回(丢失写:
  // 「回溯了但消息又回来」)。rewindSession 先等本表 settle 再截断,顺序由此确定。
  // A logical driver owns all of its queued/child turns. Never infer ownership from the current child.
  // Bounded evidence for completed-then-undo. A newer admitted driver replaces the old identity.

  return { appendLiveTail, installActiveChildEventFanout, subscribeActiveChildEvents };
}

module.exports = { createActiveChildEvents };
