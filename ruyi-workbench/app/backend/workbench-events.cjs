'use strict';

function createWorkbenchEvents() {
  // ────────────────────────────────────────────────────────────────────────────
  // 第 121 波 K2a(34 号文 §6.1;27 号文 `:20` 预告的那一步):进程内事件总线。
  //
  // 为什么住在 00-boot:它的订阅者(13r-event-stream.js)排在最后,而生产者散落在 02/04/05/09/13i/13q
  // —— 总线必须比【所有】生产者都早,生产者才只需要一条后向引用。00-boot 是全仓第一个模块,且每一个
  // 生产者所在模块对它的依赖边【本来就存在】(见 docs/architecture/module-dependency-graph.json),
  // 所以这一步一条新边都不加,forwardEdges 不动。
  //
  // 三条纪律:
  //   ① 零订阅者时 emit 是 no-op,且【永不抛】—— 观察面绝不反噬写路径(同 logEvent 的口径);
  //   ② 订阅者自己抛的异常就地吞掉并继续派给下一个,一个坏订阅者不许拖垮生产者;
  //   ③ 总线【不落盘、不持久化、不跨进程】。它只是「谁写了什么」到「谁想知道」之间的一条线,
  //      重启即空;任何需要重启后还在的事实都必须另有落盘的权威源(会话头/NDJSON)。
  const RUYI_EVENT_SUBSCRIBERS = new Set();
  const RUYI_EVENTS = {
    // 返回退订函数(约定同 DOM/Node 的 off 语义:重复退订无副作用)。
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      RUYI_EVENT_SUBSCRIBERS.add(fn);
      return () => { RUYI_EVENT_SUBSCRIBERS.delete(fn); };
    },
    emit(name, payload) {
      if (!RUYI_EVENT_SUBSCRIBERS.size) return;           // 纪律①:零订阅者 = 零开销
      for (const fn of RUYI_EVENT_SUBSCRIBERS) {
        try { fn(String(name || ''), payload); } catch { /* 纪律②:订阅者的错不许回流到写路径 */ }
      }
    },
    subscriberCount() { return RUYI_EVENT_SUBSCRIBERS.size; },
  };
  return RUYI_EVENTS;
}

module.exports = { createWorkbenchEvents };
