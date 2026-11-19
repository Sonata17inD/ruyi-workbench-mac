'use strict';
const fsp = require('node:fs/promises');

// ── 工具面数值口径 ──────────────────────────────────────────────────────────────────────
const STEWARD_SEARCH_LIMIT_DEFAULT = 10, STEWARD_SEARCH_LIMIT_MAX = 50;
const STEWARD_READ_TAIL_DEFAULT = 6, STEWARD_READ_TAIL_MAX = 20;
const STEWARD_READ_CHARS_DEFAULT = 12000, STEWARD_READ_CHARS_MIN = 1000, STEWARD_READ_CHARS_MAX = 12000;
const STEWARD_READ_CALLS_PER_TURN = 6;      // §11.2:每回合 ≤6 次深读
const STEWARD_READ_ROW_OVERHEAD = 16;       // 每行的行首开销(角色/回合号那一截),算预算时按行计
const STEWARD_READ_CLIP_MARK = '…';         // 117s-H3:被截了头的那一行的行首标记
const STEWARD_AUDIT_LIMIT_DEFAULT = 20, STEWARD_AUDIT_LIMIT_MAX = 100;
const STEWARD_MISSIONS_LIMIT_DEFAULT = 50, STEWARD_MISSIONS_LIMIT_MAX = 200;   // 第二轮走查 F7:steward_missions 的条数帽子
const STEWARD_TITLE_MAX = 80;
const STEWARD_STEER_TEXT_MAX = 2000;
// 116-2b steward_thread_note:管家给【已在跑】的线程补一句上下文。600 字上限比 steer_node 的 2000
// 紧得多 —— 它是"补一句",不是"改任务";前缀由服务端加,与 [用户插话] 的前缀纪律同精神(用户一眼
// 就能分清哪句是自己说的、哪句是管家加的)。
const STEWARD_NOTE_TEXT_MAX = 600;
const STEWARD_NOTE_PREFIX = '（管家补充）';
const STEWARD_PENDING_SUMMARY_MAX = 12;     // thread_status 里最多列几条待决摘要
const STEWARD_RUNS_MAX = 20;                // runs_status 单次最多返回几个 run digest
const STEWARD_MEMORY_NEW_WINDOW_MS = 24 * 60 * 60 * 1000;  // §4 ⑤「新写入 24 小时内带『新』标记」
const STEWARD_PLAYBOOK_DRAFTS_PER_TURN = 1;                // §3.5 内容管理:起草要调模型,每回合一次
const STEWARD_QUICK_ASKS_PER_TURN = 2;                     // §11.1 第 2 项:速查线程每回合最多两条

function createStewardToolContext({
  safeSessionId, safeJsonParse, sessionPath, applySessionPermissionModeOverride, resolvePermissionMode, foldTurnSummaries, stewardSanitizeText,
}) {
  // ── 稳定信封 ────────────────────────────────────────────────────────────────────────────
  // 形状与 105a observation_recall 同源:{ ok:false, error:<稳定码>, message:<人话> }。error 是模型要
  // 分支的机器码,message 只给人看;调用方(模型)对 propose_required / quota_exceeded / steward.busy
  // 一律不重试 —— schema description 里写明了。
  function stewardFail(code, message, extra) {
    return { ok: false, error: String(code), message: String(message || code), ...(extra && typeof extra === 'object' ? extra : {}) };
  }

  // ── 小工具 ──────────────────────────────────────────────────────────────────────────────
  function stewardClampInt(value, min, max, dflt) {
    const n = Number(value);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, Math.round(n)));
  }
  // 会话头的原始 kind(未经 sessionKind 归一)。管家会话过滤与目标合法性判定都靠它。
  async function stewardReadSessionHead(sessionId) {
    const sid = safeSessionId(sessionId);
    if (!sid) return null;
    try {
      const head = safeJsonParse(await fsp.readFile(sessionPath(sid), 'utf8'), null);
      // 116-2a: 这条读路径绕过 loadSession(只要头,不装正文),所以要自己盖一次会话级权限档的内存
      // 覆盖表 —— 否则用户刚在活回合期间切了档、还没落盘,管家读到的就是旧档(见 02 的覆盖表头注)。
      return head && typeof head === 'object' ? applySessionPermissionModeOverride(head) : head;
    } catch { return null; }
  }
  function stewardRawKind(head) {
    const k = head && head.kind;
    return (typeof k === 'string' && k) ? k : (head && head.mission ? 'mission' : 'quick_ask');
  }
  // 线程的【生效】权限档 = resolvePermissionMode 的会话级 > 全局两层(§3.3「新线程用全局默认权限」)。
  // 116-2a:改为直调 01-config 的解析器,与回合执行侧(runSessionTurn)用的是同一个函数、同一张白名单 ——
  // 管家判「我能不能替它答」与线程实际按哪档执行,从此不可能各算各的。请求级那一层是回合内临时值,
  // 不在会话头上,管家看不到也不该看到(它只对那一单当前执行链有效)。
  function stewardThreadPermissionMode(head, config) {
    return resolvePermissionMode({ session: head, config });
  }
  function stewardLastAssistantText(session) {
    const messages = Array.isArray(session && session.messages) ? session.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'assistant' && String(m.content || '').trim()) return String(m.content);
    }
    return String((session && session.summary) || '');
  }
  // 117s-H1:这一回合的交付正文 = turnSeq 对得上的【最后一条】助手话(09-workflow.js:3079 落盘时每条
  // 助手消息都带 turnSeq);不知道回合号、或那一回合没有非空正文时退到整份会话的最后一条非空助手话
  // (与 stewardLastAssistantText 同一口径,但【不】退到 session.summary —— 摘要不是交付)。
  function stewardTurnAssistantText(session, turnSeq) {
    const messages = Array.isArray(session && session.messages) ? session.messages : [];
    const want = Math.max(0, Number(turnSeq) || 0);
    let matched = '', last = '';
    for (const m of messages) {
      if (!m || m.role !== 'assistant') continue;
      const text = String(m.content == null ? '' : m.content);
      if (!text.trim()) continue;
      last = text;
      if (want > 0 && Number(m.turnSeq) === want) matched = text;
    }
    return matched || last;
  }

  // 117s-H1:这一回合写过的文件。事实源是【既有的】改动账 —— 02-session-store.js:1513 foldTurnSummaries,
  // 也就是 13d:986 给 /api/missions 详情(「看改动」面板)算 filesChanged 的那一份,不新造任何跟踪器。
  // fold 按 path 后写胜去重,故同一路径被后面的回合又改过时它归属那个更新的回合 —— 本函数只在
  // 【刚跑完的那一回合】上调用,是 fold 里最新的那一层,不受这条影响。
  const STEWARD_DELIVERABLE_FILES_MAX = 20;
  function stewardTurnFiles(session, turnSeq) {
    const want = Math.max(0, Number(turnSeq) || 0);
    if (!want) return [];
    let folded = null;
    try { folded = foldTurnSummaries(session); } catch { return []; }
    const files = [];
    for (const f of ((folded && folded.filesChanged) || [])) {
      if (!f || !f.path || Number(f.turnSeq) !== want) continue;
      const p = stewardSanitizeText(f.path);
      if (p && !files.includes(p)) files.push(p);
      if (files.length >= STEWARD_DELIVERABLE_FILES_MAX) break;
    }
    return files;
  }

  function stewardEngineOf(head) {
    const route = (head && head.engineRoute && typeof head.engineRoute === 'object') ? head.engineRoute : null;
    if (!route) return { engine: '', model: '' };
    return {
      engine: route.engine === 'openai' ? 'openai' : (route.agentCliType || 'claude'),
      model: String(route.model || ''),
      providerId: String(route.providerId || ''),
    };
  }

  // 已收工的速查会话:总览与线程搜索默认把它排除(includeClosed 可要回来)。判据单点在这里,
  // 13g 的 threads_search 与 13h 的 stewardThreadDigestRows 都调它。
  //
  // 116-3 P1-6:closedAt 【不是】终态。用户完全可能在经典 2.0 视窗里把这条速查线程继续聊下去
  // (§11.1 第 2 项只说「答完即收工」,没说「从此不许再用」);修前 closedAt 一旦写入就永久生效,
  // 管家的总览与线程搜索从此把它当成历史,彻底跟丢用户的后续对话。判据用 turnSeq 而不是 updatedAt:
  // updateSessionMeta 自己就会推 updatedAt,拿它比会在收工的下一刻把线程又「重开」一次。
  function stewardQuickClosed(head) {
    const quick = head && head.stewardQuick;
    if (!quick || typeof quick !== 'object' || !quick.closedAt) return false;
    const closedTurnSeq = Number(quick.closedTurnSeq);
    if (!Number.isFinite(closedTurnSeq)) return true;   // 116-3 之前落盘的旧速查线程:没有这个字段,维持原语义
    return Math.max(0, Number(head && head.turnSeq) || 0) <= closedTurnSeq;
  }

  // 116-3 P1-5:「这条线程是不是管家自己开的速查线程」的唯一判据。
  // 【不能】拿 sessionKind() / head.kind === 'quick_ask' 当判据 —— 那是第 70 波遗留的「纯问答默认档」,
  // 用户自己发起的普通对话绝大多数都落在它上面;真正的速查线程由 steward_quick_ask 创建,
  // 头上带 stewardQuick 这个字段,那才是 116 波「速查线程」这个概念的机器痕迹。
  function stewardQuickThread(head) {
    const quick = head && head.stewardQuick;
    return !!(quick && typeof quick === 'object');
  }
  // 第二轮工具走查(F10):给管家看的 `kind` 字段。修前直接吐 stewardRawKind —— 会话头上没写 kind 的普通对话
  // 兜底成 sessionKind 的「纯问答默认档」quick_ask,于是用户进行中的普通对话在 thread_status / threads_search 里
  // 全被标成「速查线程」,而同一个返回里 stateSources.kind 却是 mission(五态判据早在 116-3 P1-5 改成了
  // stewardQuickThread)。这里与五态判据同口径:只有头上带 stewardQuick 的才是 quick_ask,其余一律 mission;
  // 管家自己的会话照旧 steward(调用方都已经把它挡在外面,留着只是不撒谎)。
  function stewardDisplayKind(head) {
    if (stewardRawKind(head) === 'steward') return 'steward';
    return stewardQuickThread(head) ? 'quick_ask' : 'mission';
  }

  return {
    stewardFail, stewardClampInt, stewardReadSessionHead, stewardRawKind, stewardThreadPermissionMode,
    stewardLastAssistantText, stewardTurnAssistantText, stewardTurnFiles, stewardEngineOf,
    stewardQuickClosed, stewardQuickThread, stewardDisplayKind,
  };
}

module.exports = {
  createStewardToolContext,
  STEWARD_SEARCH_LIMIT_DEFAULT, STEWARD_SEARCH_LIMIT_MAX, STEWARD_READ_TAIL_DEFAULT,
  STEWARD_READ_TAIL_MAX, STEWARD_READ_CHARS_DEFAULT, STEWARD_READ_CHARS_MIN,
  STEWARD_READ_CHARS_MAX, STEWARD_READ_CALLS_PER_TURN, STEWARD_READ_ROW_OVERHEAD,
  STEWARD_READ_CLIP_MARK, STEWARD_AUDIT_LIMIT_DEFAULT, STEWARD_AUDIT_LIMIT_MAX,
  STEWARD_MISSIONS_LIMIT_DEFAULT, STEWARD_MISSIONS_LIMIT_MAX, STEWARD_TITLE_MAX,
  STEWARD_STEER_TEXT_MAX, STEWARD_NOTE_TEXT_MAX, STEWARD_NOTE_PREFIX,
  STEWARD_PENDING_SUMMARY_MAX, STEWARD_RUNS_MAX, STEWARD_MEMORY_NEW_WINDOW_MS,
  STEWARD_PLAYBOOK_DRAFTS_PER_TURN, STEWARD_QUICK_ASKS_PER_TURN,
};
