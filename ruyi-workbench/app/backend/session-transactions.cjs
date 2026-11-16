'use strict';
const { runKeyedChain } = require('./keyed-chain.cjs');
const { AsyncLocalStorage } = require('node:async_hooks');
// Serializes read/modify/write separately from the lower-level durable write chain.
function createSessionTransactions({ loadSession, saveSession, logEvent }) {
const mutationScope = new AsyncLocalStorage();
async function saveTurnFinalSession(session, writer, options = {}) {
  try {
    await saveSession(session, { ...options, throwIfTurnSuperseded: true, writer: String(writer || 'turn-final') });
    return true;
  } catch (e) {
    if (e && e.code === 'SESSION_TURN_SUPERSEDED') return false;
    throw e;
  }
}

// ── 128b(48 号文 §2-b):会话「读-改-写」的唯一原语 ────────────────────────────────────────────────────
// 被撤回闸丢掉的 saveSession 返回值与成功时一模一样,普查出技能／记忆／todo／任务开始更新核验／任务控制／三个引擎的
// 手动压缩／管家拜访归档／工作流摘要追加／管家回复盖章都是「load → 改一点 → save」,撤回插在中间时它们的改动被
// 整份丢掉、接口照样回成功(Brief §4.2 第 15 条)。与 117n-M2 的 mutateConfig 同一个形状:
//   · mutator(session, { attempt }) 在新读的副本上改(可返回 { abort: X } 不落盘、{ value: X } 随行数据);
//   · 保存带 throwIfStale —— 撞上撤回就重新读、重新应用(mutator 必须能重放:它描述的是「要做什么改动」,
//     不是「改完的样子」),有界;连着撞满仍不行抛 session.rewound_during_write,调用方回可读的错误而不是成功;
//   · opts.expectGen:「先花几秒算、再落盘」的慢活(压缩、任务核验)在算之前记下 rewindGen,这里新读到的代数
//     变了(期间撤回过)就不写 —— 基于撤回之前的历史算出来的东西绝不写回去,也不重算(那是调用方的事)。
// 活回合那一侧的丢失更新(回合收尾存拿着旧对象盖掉这里的改动)不归这里管:路由／权限档／桌面工具靠覆盖表、
// 任务账本靠收尾存的 mergeMissionFromDisk、元数据补丁靠 updateSessionMeta 的延后通道,各有既有守卫。
const SESSION_MUTATE_STALE_REPLAYS = 2;
function sessionRewoundError(id, writer) {
  return Object.assign(new Error('这条会话在写入期间被撤回过,这次改动没有落盘,请重试'), {
    code: 'session.rewound_during_write', statusCode: 409, sessionId: id, writer,
  });
}
// hunt2-P4:同一会话的「load → 改 → save」整段按 id 串行。修前两路并发的 mutateSession(todo 与技能、
// 记忆与 backgroundJobSeen……)各自读到同一份旧头、各改各的字段、后存者整份盖掉先存者 —— 撤回闸管不到这种
// 同代数的丢失更新(实测 20/20 丢一边)。saveSession 自己的 per-id 写链只串「写」,串不了「读-改-写」。
// 不会死锁的理由(改这里之前先读):
//   · 链内只做 loadSession / mutator / saveSession。loadSession 只会【等】写链(sessionWriteChains)、
//     saveSession 只会【排进】写链,写链里跑的只有落盘,从不回头等这条链 —— 两条链之间只有单向等待;
//   · 活回合的收尾存直接走 saveSession,不进这条链,所以回合永远不必等这里;这条链也从不等回合 settle
//     (updateSessionMeta 的延后通道在【进链之前】等 settle);
//   · 约定:mutator 里不得再对【同一个 id】调 mutateSession / updateSessionMeta(会自己等自己)。
//     现有调用方的 mutator 都是纯内存改动加至多一次只读 I/O(unit/session-mutate.test.js 的 [M6] 钉并发)。
const sessionMutateChains = new Map();
function withSessionMutateLock(id, work) {
  const key = String(id == null ? '' : id);
  const parent = mutationScope.getStore();
  for (let scope = parent; scope; scope = scope.parent) {
    if (scope.active && scope.key === key) return Promise.reject(Object.assign(new Error('Nested mutation of the same session is not allowed'), { code: 'SESSION_MUTATION_REENTRANT' }));
  }
  return runKeyedChain(sessionMutateChains, key, () => {
    const scope = { key, parent, active: true };
    return mutationScope.run(scope, async () => {
      try { return await work(); } finally { scope.active = false; }
    });
  });
}
async function mutateSession(id, mutator, opts = {}) {
  return withSessionMutateLock(id, async () => {
    const writer = String((opts && opts.writer) || 'mutate_session');
    const expectGen = opts && opts.expectGen != null ? Number(opts.expectGen) || 0 : null;
    for (let attempt = 0; ; attempt++) {
      const session = await loadSession(id);
      if (!session) return { ok: false, missing: true, session: null, value: undefined };
      if (expectGen !== null && (Number(session.rewindGen) || 0) !== expectGen) {
        logEvent({ kind: 'session_mutate_rewound', sessionId: id, writer, expectGen, gen: Number(session.rewindGen) || 0 });
        throw sessionRewoundError(id, writer);
      }
      const decision = await mutator(session, { attempt });
      const d = (decision && typeof decision === 'object') ? decision : {};
      if (Object.prototype.hasOwnProperty.call(d, 'abort')) return { ok: false, session, value: d.abort };
      try {
        await saveSession(session, { ...((opts && opts.saveOpts) || {}), throwIfStale: true, writer });
        return { ok: true, session, value: d.value, attempts: attempt + 1 };
      } catch (error) {
        if (!(error && error.code === 'SESSION_STALE_SAVE')) throw error;
        if (expectGen !== null || attempt >= SESSION_MUTATE_STALE_REPLAYS) {
          logEvent({ kind: 'session_mutate_rewound', sessionId: id, writer, attempt: attempt + 1, expectGen });
          throw sessionRewoundError(id, writer);
        }
        logEvent({ kind: 'session_mutate_replayed', sessionId: id, writer, attempt: attempt + 1 });
      }
    }
  });
}
return { saveTurnFinalSession, withSessionMutateLock, mutateSession };
}
module.exports = { createSessionTransactions };
