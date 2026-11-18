'use strict';

function createStewardConversationReplies({
  STEWARD_SESSION_ID, safeSessionId, stewardSanitizeText, sessionDisplayTitle, stewardHumanizeIds,
  sessions,
}) {
  const { loadSession, mutateSession, stewardReadSessionHead } = sessions;

  // ── 117l D5(§11.9;用户第四轮走查第 4 条「管家回复的 ※ 没有正确标明标题」)────────────────────
  // 界面上永远不出现内部 id(公共纪律第 7 条)。修前管家落盘的 why 原文长这样:
  //   「收件箱事件 [1] needs_you:线程 sess_a50604717960006a 有待决 question_77ef30898760f07a,…」
  // 模型是照抄的 —— 收件箱事件行本来就是 `线程 ${sid}` 喂给它的。两头一起改:
  //   ① 喂进去的那一头(下面 stewardEventLine / 自理 notes / 总览行)改成「线程『显示名』(id)」;
  //   ② 吐出来的那一头(say / why)过一遍确定性替换,把漏网的 id 换成显示名、把纯机器把手删掉。
  // **只作用于给人看的两段文字**:acts[].sessionId、actions[].args、决策日志一律不动 —— 那些 id 是
  // 前端点按钮用的,人话化会把它们变成点不开的字符串。
  async function stewardDisplayTitleOf(sessionId) {
    const head = await stewardReadSessionHead(sessionId).catch(() => null);
    return head && head.id ? String(sessionDisplayTitle(head) || '') : '';
  }
  // say/why 的人话化。先把文本里出现过的会话 id 逐个查成显示名(最多 8 个,一次到访里模型不会提更多),
  // 再交给 06i 的纯函数做替换与标点收尾。查不到名字的 id 原样保留 —— 宁可露一个 id,也不能张冠李戴。
  async function stewardHumanizeSay(text) {
    const raw = String(text == null ? '' : text);
    const ids = [...new Set(raw.match(/\bsess_[0-9a-f]{16}\b/g) || [])].slice(0, 8);
    const titles = new Map();
    for (const id of ids) {
      const title = await stewardDisplayTitleOf(id);
      if (title) titles.set(id, title);
    }
    return stewardHumanizeIds(raw, id => titles.get(id) || '');
  }

  // 117s-H4(27 号文 §11.13.3;117s-C 的派单稿在这里被证伪):落盘的回执里 `trigger` 修前只有
  // `'user'|'inbox'` 两个字面量,来源线程的 id / 标题 / 回合号一个都不在里面 —— 前端要给收件箱那条
  // 回复加「来自线程」小头,只能拿正则去抠中文事件行(`线程「X」(sess_…)`)。回执才是第一手证据,
  // 所以这里把它加厚成一个对象:{ kind, sessionId?, title?, turnSeq?, sessionIds? }。
  //   · 领头行取这一批里第一条 done / needs_you(它们才是「有东西可看」的那两类);都没有就退到第一条;
  //   · 一批里涉及几条线程时 sessionIds 全给,小头指的是领头那一条。
  // 【只改落盘的那一份】:运行器内存态 stewardRunnerRuntime.lastReply.trigger 仍是字符串 ——
  // 壳层的状态轮询(public/js/steward-shell.js:277 `lastReply.trigger === 'inbox'`)靠它决定要不要
  // 把新回复追进对话流,改了它就是一个静默的功能回归。两处是两个消费者,不必也不该同形。
  async function stewardTriggerStamp(trigger, events) {
    if (trigger === 'external') return { kind: 'external' };
    if (trigger !== 'inbox') return { kind: 'user' };
    const rows = (Array.isArray(events) ? events : []).filter(r => r && safeSessionId(r.sessionId));
    const sessionIds = [...new Set(rows.map(r => safeSessionId(r.sessionId)))];
    const lead = rows.find(r => r.kind === 'done' || r.kind === 'needs_you') || rows[0] || null;
    const stamp = { kind: 'inbox', sessionIds };
    if (!lead) return stamp;
    stamp.sessionId = safeSessionId(lead.sessionId);
    stamp.title = await stewardDisplayTitleOf(stamp.sessionId).catch(() => '') || '';
    stamp.turnSeq = Math.max(0, Number(lead.payload && lead.payload.turnSeq) || 0);
    return stamp;
  }

  // 把结构化结果落到管家会话最新一条助手消息的 meta 上(§11.3:「结构化结果落在 …助手消息的 meta」)。
  // 只在回合已经收尾后做(单管家并发 1 保证此刻没有在途回合),避免 116c 记过的读改写竞态。
  async function stewardStampReply(reply) {
    // 128b:走 mutateSession(撤回插在读与存之间时在新读的副本上重放盖章,不被闸静默丢掉);失败照旧吞掉(旁路)。
    try {
      const written = await mutateSession(STEWARD_SESSION_ID, fresh => {
        const messages = Array.isArray(fresh.messages) ? fresh.messages : [];
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i] && messages[i].role === 'assistant') {
            messages[i].steward = reply;
            return { value: String(messages[i].content || '') };
          }
        }
        return { abort: '' };
      }, { writer: 'steward_stamp_reply' });
      return written.session ? String(written.value || '') : '';
    } catch { return ''; }
  }

  async function stewardLastAssistantContent() {
    const session = await loadSession(STEWARD_SESSION_ID).catch(() => null);
    if (!session) return '';
    const messages = Array.isArray(session.messages) ? session.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'assistant') return String(messages[i].content || '');
    }
    return '';
  }
  // 135(用户 2026-09-23「管家的交互怪怪的」;真机 steward.messages.ndjson 取证):带工具调用的回合里,
  // content 是【每一轮迭代的文字拼起来的】—— 模型在调工具之前先说一段「【开线程】…」、工具回来后又说一段,
  // 契约解析失败时兜底把两段一起端给用户,于是同一件事上屏两遍。只在解析失败时用它:取最后一段非空文字,
  // 那才是这一回合的答复,前面几段是边做边说的过程话。没有分段(老消息、单轮回合)返回空串,调用方照旧。
  async function stewardLastAssistantFinalSegment() {
    const session = await loadSession(STEWARD_SESSION_ID).catch(() => null);
    const messages = Array.isArray(session && session.messages) ? session.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.role !== 'assistant') continue;
      const texts = (Array.isArray(m.segments) ? m.segments : [])
        .filter(s => s && s.type === 'text' && String(s.text || '').trim());
      return texts.length > 1 ? String(texts[texts.length - 1].text) : '';
    }
    return '';
  }

  // 117l D1(§11.9;用户第四轮走查第 2 条):输入区预判的服务端归一。
  // **只信 sessionId**:标题一律自己按显示名重查,原因串按既有的中和口径清洗并截断,前端给的标题
  // 一个字都不进提示词 —— 否则「输入框里打什么,提示词里就出现什么」,那是一条现成的注入入口。
  // 最多 3 条(§11.9 派单稿),查不到会话的行整条丢掉(id 编的就当没给)。
  const STEWARD_ROUTE_HINT_MAX = 3;
  const STEWARD_ROUTE_HINT_REASON_CHARS = 80;
  async function stewardNormalizeRouteHint(raw) {
    const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
    if (!src) return null;
    const hits = Array.isArray(src.hits) ? src.hits.slice(0, STEWARD_ROUTE_HINT_MAX) : [];
    const rows = [];
    const seen = new Set();
    for (const hit of hits) {
      const sid = safeSessionId(hit && hit.sessionId);
      if (!sid || seen.has(sid) || sid === STEWARD_SESSION_ID) continue;
      const title = await stewardDisplayTitleOf(sid);
      if (!title) continue;                       // 会话不存在 = 这一条当没给
      seen.add(sid);
      rows.push({ sessionId: sid, title, reason: stewardSanitizeText(hit && hit.reason).slice(0, STEWARD_ROUTE_HINT_REASON_CHARS) });
    }
    if (!rows.length) return null;
    const picked = safeSessionId(src.picked);
    return { kind: String(src.kind || '').slice(0, 24), rows, picked: seen.has(picked) ? picked : '' };
  }

  return {
    stewardHumanizeSay, stewardLastAssistantContent, stewardLastAssistantFinalSegment,
    stewardNormalizeRouteHint, stewardStampReply, stewardTriggerStamp, stewardDisplayTitleOf,
  };
}

module.exports = { createStewardConversationReplies };
