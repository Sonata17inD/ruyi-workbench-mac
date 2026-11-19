'use strict';

const { recordAuxiliaryUsage } = require('./provider-raw-completion.cjs');
const { SESSION_BRIEF_TITLE_CHARS, SESSION_BRIEF_GIST_CHARS } = require('./session-metadata.cjs');

const THREAD_BRIEF_INPUT_CHARS = 1200;    // 喂给模型的用户原话上限
const THREAD_BRIEF_REPLY_CHARS = 400;     // settled 阶段附带的助手回复上限
// 两次机会各自的尝试预算(实测调整,见 §11.6 116-5a 交付记录):
//   · 首回合那次是【机会性】的 —— 端点正常时一发就中,不该为了一个名字在回合刚起跑时连打三次;
//   · 收工那次才是真正的兜底(此刻有助手回复,概括也更准),退避重试留给它。
// 全流程一条线程最多 4 次调用(常见路径 1 次),而不是「两次机会 × 各 3 次 = 6 次」。
const THREAD_BRIEF_FIRST_TURN_TRIES = 1;
const THREAD_BRIEF_RETRY_BACKOFF_MS = [1000, 4000];  // 收工那次:首发 + 两次退避重试后放弃
const THREAD_BRIEF_PER_MINUTE = 20;       // 每进程每分钟上限,防批量导入会话把端点打爆

// 模型输出 -> {title, gist} | null。围栏、前后杂字、以及【单元素数组】外壳都容忍(取第一个 { 到
// 最后一个 },所以 [{…}] 会被拆开;多元素数组切出来不是合法 JSON,照样失败)。宽容一点是有代价考量的:
// 每失败一次就要多两次模型调用。但解析不出合法对象就是失败(交给重试)—— 绝不拿整段原文当标题,
// 那正是这一波要消灭的东西。
function parseThreadBrief(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj = null;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const title = String(obj.title || '').replace(/\s+/g, ' ').trim();
  const gist = String(obj.gist || '').replace(/\s+/g, ' ').trim();
  return title ? { title, gist } : null;   // 没有名字就不算成功(概括可以空)
}

function buildThreadBriefMessages(message, replyText, locale, excerpts) {
  const zh = !String(locale || '').toLowerCase().startsWith('en');
  const sys = zh
    ? '你给一条对话线程起名字。只输出一个 JSON 对象:{"title":"…","gist":"…"}。title 是这件事的名字,不超过 24 个字,像文件名一样具体(例:「AMD 收盘分析」);gist 是一句人话,不超过 80 个字,说清要做什么。不要解释、不要代码围栏、不要任何多余字符。'
    : 'You name a conversation thread. Output only one JSON object: {"title":"…","gist":"…"}. title names the task in at most 24 characters, concrete like a filename; gist is one plain sentence of at most 80 characters saying what is being done. No explanation, no code fences, no extra characters.';
  const parts = [(zh ? '用户原话:' : "User's own words:") + '\n' + (excerpts ? excerpts.message : String(message || '').slice(0, THREAD_BRIEF_INPUT_CHARS))];
  const reply = String(replyText || '').trim();
  if (reply) parts.push((zh ? '助手回复(节选):' : 'Assistant reply (excerpt):') + '\n' + (excerpts ? excerpts.reply : reply.slice(0, THREAD_BRIEF_REPLY_CHARS)));
  return [{ role: 'system', content: sys }, { role: 'user', content: parts.join('\n\n') }];
}

function createThreadBriefService({
  safeSessionId, loadSession, updateSessionMeta, getSessionTitleOverride, setSessionTitleOverride,
  PrivacyGateway, providerRawCompletion,
  appendUsageLedger, RUYI_EVENTS, nowIso, logEvent,
}) {
  const threadBriefCalls = [];              // 最近一分钟的调用时刻(ms),纯内存
  // 每会话在途/已成的登记表(纯内存,进程重启即清)。**没有它就会重复调模型**:首回合那次的落盘走
  // updateSessionMeta,活回合期间它会被延后到 settle 之后重放;而收工钩子恰恰在那个窗口里判「还没有
  // brief」—— 于是同一条线程被起了两次名字(116-5a 实测:briefHits=2)。磁盘上的判据在这个窗口里
  // 是不可靠的,唯一可靠的是进程内「我已经在给它起名字了」。
  const threadBriefInflight = new Map();    // sessionId -> Promise<brief|null>
  const threadBriefDone = new Map();        // sessionId -> 本进程内算出来的 brief(供收工补写)

  function threadBriefEnabled(config) {
    // 默认【开】,所以判据是 !== false(与 01-config 的归一同方向)。
    return !config || config.stewardThreadBriefV1 !== false;
  }

  // 端点解析(用户 2026-09-07 拍板 §11.8.10 第 2 条):管家端点优先,没配就回落到【这条线程自己的】
  // OpenAI 兼容 provider;两者都不可用(主引擎是 CLI 且没配管家端点)则不生成。
  // 要避开的是 CLI 进程与工具循环,不是「同一个 provider」—— 一次独立的非流式 HTTP 调用不占 CLI。
  function threadBriefProvider(config, threadProvider) {
    const id = String((config && config.stewardProviderId) || '').trim();
    if (id) {
      const found = ((config && config.providers) || []).find(p => p && p.id === id);
      if (!found) return null;   // 配了却找不到:不静默换成别的端点(与 13h stewardResolveRoute 同立场)
      const model = String((config && config.stewardModel) || '').trim();
      return model ? { ...found, model } : found;
    }
    return threadProvider || null;
  }

  function threadBriefRateLimited() {
    const now = Date.now();
    while (threadBriefCalls.length && now - threadBriefCalls[0] > 60000) threadBriefCalls.shift();
    if (threadBriefCalls.length >= THREAD_BRIEF_PER_MINUTE) return true;
    threadBriefCalls.push(now);
    return false;
  }

  // 主入口。**永不抛、永不阻塞回合**:调用方一律 void 调它。返回落盘的 brief 或 null。
  // 外壳只做一件事:同一条会话同时只有一次在途 —— 后到的那次等前一次的结果,前一次成了就不再调模型。
  async function maybeWriteThreadBrief(input) {
    const o = (input && typeof input === 'object') ? input : {};
    const sid0 = safeSessionId(o.sessionId);
    if (!sid0) return null;
    if (threadBriefDone.has(sid0)) return null;
    const inflight = threadBriefInflight.get(sid0);
    if (inflight) {
      const prior = await inflight.catch(() => null);
      if (prior) return null;                 // 前一次已经把名字写上了,这一次不用再调
      if (threadBriefDone.has(sid0)) return null;
    }
    const task = threadBriefOnce(o, sid0);
    threadBriefInflight.set(sid0, task);
    try {
      const brief = await task;
      if (brief) threadBriefDone.set(sid0, brief);
      return brief;
    } finally {
      if (threadBriefInflight.get(sid0) === task) threadBriefInflight.delete(sid0);
    }
  }

  // 116-5a 收工那一刻的唯一入口:先【补写】(不调模型),不行再走收工那次兜底。
  // 为什么必须补写(116-5a 实测抓到的丢写):首回合那次是在回合刚起跑时发的,它的落盘与回合自己的
  // 收尾整份 saveSession 抢同一个文件 —— 回合手里那份内存副本【不含】 brief,谁后写谁赢,而回合
  // 几乎总是后写。updateSessionMeta 的活回合延后防护挡不住这一发(brief 的写可能恰好落在
  // turnSettlers 已清、回合收尾 save 还没落地的那个窗口里)。补写是幂等的,而且不再调模型。
  async function settleThreadBrief(o) {
    const sid = safeSessionId(o && o.sessionId);
    if (!sid) return null;
    const reasserted = await reassertThreadBrief(sid);
    if (reasserted) return reasserted;
    return maybeWriteThreadBrief({ ...(o || {}), stage: 'settled' });
  }

  // 把本进程算出来的 brief 再写一次(仅当盘上确实没有)。永不调模型、永不抛。
  async function reassertThreadBrief(sessionId) {
    try {
      const sid = safeSessionId(sessionId);
      if (!sid) return null;
      const brief = threadBriefDone.get(sid);
      if (!brief) return null;
      const head = await loadSession(sid).catch(() => null);
      const live = getSessionTitleOverride(sid);
      if (!head || head.titleSource === 'user' || (live && live.rewindGen !== undefined && (Number(head.rewindGen) || 0) !== live.rewindGen)) return null;
      if (head && head.threadBrief && String(head.threadBrief.title || '').trim()) return brief;  // 已经在盘上
      await updateSessionMeta(sid, { threadBrief: brief }).catch(() => null);
      return brief;
    } catch { return null; }
  }

  // The current main agent supplies a title only after an explicit change of objective; no extra model call.
  async function updateAutomaticThreadTitle(input) {
    const o = input || {}, sid = safeSessionId(o.sessionId);
    if (!sid) return { ok: false, error: 'session_required' };
    const head = await loadSession(sid);
    if (!head || head.kind === 'steward') return { ok: false, error: 'invalid_thread' };
    if (head.titleSource === 'user') return { ok: true, updated: false, reason: 'user_title' };
    if (typeof o.title !== 'string') return { ok: false, error: 'title_required' };
    const parsed = parseThreadBrief(JSON.stringify({ title: o.title, gist: o.gist ?? '' }));
    if (!parsed) return { ok: false, error: 'title_required' };
    const brief = { schema: 1, title: parsed.title.slice(0, SESSION_BRIEF_TITLE_CHARS), gist: parsed.gist.slice(0, SESSION_BRIEF_GIST_CHARS), at: nowIso(), model: 'agent', stage: 'settled' };
    const rewindGen = Number(head.rewindGen) || 0;
    if (getSessionTitleOverride(sid)?.titleSource === 'user') return { ok: true, updated: false, reason: 'user_title' };
    setSessionTitleOverride(sid, { threadBrief: brief, rewindGen });
    threadBriefDone.set(sid, brief);
    RUYI_EVENTS.emit('thread.state', { sessionId: sid });
    await updateSessionMeta(sid, { threadBrief: brief, threadBriefRewindGen: rewindGen });
    return { ok: true, updated: true, title: brief.title };
  }

  async function threadBriefOnce(o, sid, policyBound = false) {
    try {
      const config = o.config || null;
      if (!threadBriefEnabled(config)) return null;
      if (!policyBound) return await PrivacyGateway.withPolicy(sid, () => threadBriefOnce(o, sid, true));
      const stage = o.stage === 'settled' ? 'settled' : 'first_turn';
      const message = String(o.message || '').trim();
      if (!message) return null;
      // Read the stored kind because sessionKind normalizes Steward sessions to quick_ask.
      const head = await loadSession(sid).catch(() => null);
      if (!head || !head.id) return null;
      if (head.kind === 'steward') return null;
      // 116-5a:这条线程已经有【人给的】名字(建会话时就带了非占位标题,或用户/管家改过名)——
      // 生成的名字本来就排在它后面(§11.8.3 的显示优先级),再花一次调用去起一个永远不显示的名字
      // 是纯浪费。这也是 116-5a 全量回归里那批红的根因:默认开之后,每一条首轮都多打一发,把各
      // e2e 假端点的计数与剧本序列全打乱了 —— 收窄到「真的没名字才起名」之后,那批红自然消失,
      // 而不是靠给二十几个夹具挨个塞一行开关关掉。
      if (head.titleSource === 'user') return null;
      // 已经有名字了就不再写:两次机会(首回合发起 + 收工补写)里先到的那次说了算。
      if (head.threadBrief && typeof head.threadBrief === 'object' && String(head.threadBrief.title || '').trim()) return null;
      const provider = threadBriefProvider(config, o.threadProvider || null);
      if (!provider) return null;                    // 端点不可用:静默不生成
      if (threadBriefRateLimited()) return null;
      let excerpts;
      if (PrivacyGateway.active()) {
        // Identify the full originals before applying title budgets. A raw slice can split a
        // credential/identity into an unrecognizable fragment; a protected slice stays atomic.
        const messageView = await PrivacyGateway.projectSource(message, true);
        const reply = String(o.replyText || '').trim();
        const replyView = reply ? await PrivacyGateway.projectSource(reply, true) : null;
        excerpts = {
          message: PrivacyGateway.sliceSource(messageView, 0, Math.min(message.length, THREAD_BRIEF_INPUT_CHARS)).text,
          reply: replyView ? PrivacyGateway.sliceSource(replyView, 0, Math.min(reply.length, THREAD_BRIEF_REPLY_CHARS)).text : '',
        };
      }
      const messages = buildThreadBriefMessages(message, o.replyText, config && config.locale, excerpts);
      const tries = stage === 'settled' ? THREAD_BRIEF_RETRY_BACKOFF_MS.length + 1 : THREAD_BRIEF_FIRST_TURN_TRIES;
      for (let attempt = 0; attempt < tries; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, THREAD_BRIEF_RETRY_BACKOFF_MS[attempt - 1]));
        const sc = await providerRawCompletion(provider, messages, sid);
        recordAuxiliaryUsage(appendUsageLedger, provider, sc, {
          sessionId: sid, turnSeq: Math.max(0, Number(head.turnSeq) || 0), note: 'thread-brief',
        });
        const parsed = (sc && sc.ok) ? parseThreadBrief(sc.content) : null;
        if (parsed) {
          // 走 updateSessionMeta:首回合那次发起时回合还在跑,这条通道会延后到 settle 之后在
          // 【重新装载的副本】上重放,绝不会用陈旧正文盖掉回合刚写的消息(116-2a 的既有防护)。
          const brief = { schema: 1, title: parsed.title.slice(0, SESSION_BRIEF_TITLE_CHARS), gist: parsed.gist.slice(0, SESSION_BRIEF_GIST_CHARS), at: nowIso(), model: String((sc && sc.model) || provider.model || ''), stage };
          const current = await loadSession(sid).catch(() => null);
          if (!current || current.titleSource === 'user' || (Number(current.rewindGen) || 0) !== (Number(head.rewindGen) || 0)
              || String(current.threadBrief?.at || '') !== String(head.threadBrief?.at || '')) return null;
          const live = getSessionTitleOverride(sid);
          if (live?.titleSource === 'user' || live?.threadBrief) return null;
          setSessionTitleOverride(sid, { threadBrief: brief, rewindGen: Number(head.rewindGen) || 0 });
          RUYI_EVENTS.emit('thread.state', { sessionId: sid });
          await updateSessionMeta(sid, { threadBrief: brief, threadBriefRewindGen: Number(head.rewindGen) || 0 }).catch(() => null);
          return brief;
        }
      }
      // 只有收工那次(真正的兜底)失败才算「放弃」值得记一条;首回合那一发是机会性的,失败很正常。
      if (stage === 'settled') logEvent({ kind: 'thread_brief_failed', sessionId: sid, stage, provider: String(provider.id || '') });
      return null;
    } catch (error) {
      try { logEvent({ kind: 'thread_brief_failed', sessionId: String(o.sessionId || ''), stage: String(o.stage || ''), error: String((error && error.message) || error).slice(0, 200) }); } catch { /* 观测绝不反噬 */ }
      return null;
    }
  }

  return { maybeWriteThreadBrief, settleThreadBrief, updateAutomaticThreadTitle };
}

module.exports = { createThreadBriefService, parseThreadBrief, buildThreadBriefMessages, THREAD_BRIEF_INPUT_CHARS, THREAD_BRIEF_REPLY_CHARS };
