'use strict';
const { PROMPT_PACK_VERSION } = require('./prompt-registry.cjs');
// Title overlays are private, generation-bound metadata for live sessions.
function createSessionMetadata({ safeSessionId, sessionPermissionModeOf, resolvePermissionMode, isLive, rewindGeneration }) {
function isUntitledSessionTitle(title) {
  const v = String(title || '').trim();
  return !v || v === 'New session' || v === '新会话' || v === 'New chat';
}

function sessionKind(o) {
  const k = o && o.kind;
  if (k === 'mission' || k === 'quick_ask') return k;
  return (o && o.mission) ? 'mission' : 'quick_ask';
}

// 75a (Pretender P1, D1 plan B): Mission stable identity primary key `missionId`.
// In 3.0 missionId === sessionId (written explicitly for new sessions at createSession).
// Legacy (pre-75a) session heads lack this key -> read-only derive at projection/response time,
// NEVER writeback to disk (same discipline as `kind`: do NOT set it in normalizeSession, or the
// next saveSession would persist it = destructive batch rewrite). 3.1's 1:N multi-session is the
// first place missionId may diverge from sessionId; 3.0 only guarantees existing identity needs
// no remapping (S5). Consumers (sessionMeta / buildMissionCard / interventions list) call this.
function sessionMissionId(o) {
  const m = o && o.missionId;
  if (typeof m === 'string' && m) return m;
  const id = o && o.id;
  return (typeof id === 'string' && id) ? id : '';
}

// ── 116-5a(27 号文 §11.8「线程自动摘要」)────────────────────────────────────────────────
// 名字与概括的字数上限。在【落盘时】就夹死(见 applySessionMetaPatch),不是显示时才截:
// 上限一旦调整,存量数据仍是按当时上限存的,显示层再截一次只会掩盖这件事。
const SESSION_BRIEF_TITLE_CHARS = 24;
const SESSION_BRIEF_GIST_CHARS = 80;
// 117l-A1-fix (2)(27 号文 §11.9;用户真机天天看见):占位标题不是名字,它是「还没有名字」。
// 未命名线程在第一回合结束、摘要(threadBrief)生成之前,raw 逐字就是后端占位符 'New session'
// (createSession 写的),于是收件箱事件行写成「线程「New session」(sess_x)」、routeHint 块与
// humanize 出来的 say/why 也全是「New session」—— 用户真机上管家说「十几条 New session 还在交办中」。
// 补一档兜底:占位标题 + 【手上真有正文】时,用首条用户消息的前 24 个字顶上(与 SESSION_BRIEF_TITLE_CHARS
// 同一个上限,摘要落盘后自然被生成的名字接管)。
// 纪律三条:
//   · 用户手改的标题(titleSource === 'user')在函数第一行就返回了,永远不受这一档影响;
//   · 只在入参【自己带着正文】时才走(完整会话对象:GET /api/sessions/:id 的 loadSession 结果)。
//     只有会话头 / 索引条目的调用面拿不到正文,那就仍旧保留占位 —— 这个函数在总览里每条线程都要跑
//     一遍,为了一个名字去多读一次正文文件是不能接受的代价;
//   · 优先级顺序一个字不动:人起的 > 生成的 > 原话,摘录只是【占位符这一种原话】的兜底。
function sessionFirstUserExcerpt(o) {
  const rows = (o && Array.isArray(o.messages)) ? o.messages : null;
  if (!rows) return '';
  for (const m of rows) {
    if (!m || m.role !== 'user' || typeof m.content !== 'string') continue;
    const text = m.content.replace(/\s+/g, ' ').trim();   // 标题是一行:换行折成空格
    if (!text) continue;
    const chars = [...text];   // 按字符切,不按 UTF-16 码元(别把一个 emoji 劈成两半)
    return chars.length > SESSION_BRIEF_TITLE_CHARS ? chars.slice(0, SESSION_BRIEF_TITLE_CHARS).join('') + '…' : text;
  }
  return '';
}
// 「这条线程该显示什么名字」的【唯一】判据。优先级:人起的名字 > 自动生成的名字 > 原话
// (原话是占位符且手上有正文时,退一档用首条用户消息的摘录,见上面 sessionFirstUserExcerpt 的头注)。
// 服务端一处装配、多处消费(sessionMeta / 113b 会话搜索 / 13g 线程搜索 / 117 的抽屉看板递送候选),
// 判据绝不许在前端各算一遍 —— 那正是 112 波摸底里「服务端发 54 种、前端认 34 种」那类分叉的起点。
// 入参两形态都要认:会话头(有 threadBrief)与索引条目(sessionMeta 带出的 brief)。
// 117s-A D2(§11.13 ⑤a):titleSource 多了一个字面量 'steward'(管家开线程时抄进来的那句话)。
// 本函数【一行没改】—— 它本来就只在 'user' 那一档提前返回,'steward' 自然落在第二档之后,
// 于是优先级如实是:人起的 > 生成的名字 > 管家给的那句(它就是 raw 本身)> 原话。
// Titles share the live-turn metadata override path; transcript persistence still waits for settle.
const sessionTitleOverrides = new Map();
function applySessionTitleOverride(session) {
  const live = session && sessionTitleOverrides.get(session.id);
  if (!live) return session;
  if (live.titleSource === 'user') { session.title = live.title; session.titleSource = 'user'; }
  else {
    const gen = Math.max(Number(session.rewindGen) || 0, rewindGeneration(session.id));
    if (gen !== live.rewindGen) sessionTitleOverrides.delete(session.id);
    else if (session.titleSource !== 'user') session.threadBrief = live.threadBrief;
  }
  return session;
}

function sessionDisplayTitle(o) {
  const raw = String((o && o.title) || '');
  if (!o || o.titleSource === 'user') return raw;
  const brief = (o.threadBrief && typeof o.threadBrief === 'object') ? o.threadBrief : ((o.brief && typeof o.brief === 'object') ? o.brief : null);
  const generated = String((brief && brief.title) || '').trim();
  if (generated || !isUntitledSessionTitle(raw)) return generated || raw;
  return sessionFirstUserExcerpt(o) || raw;
}

// The 7 sidebar fields. Accepts a full session (has .messages) OR an index entry (has .messageCount), so the
// same shaper builds index entries and normalizes them on read.
// 116-2a: 可选第二参 config —— 给了(且是对象)就额外带出派生的 effectivePermissionMode。索引条目
// 【不】传(listSessions 建索引时保持精简;它那条 `.map(sessionMeta)` 还会把数组下标当第二参喂进来,
// 故这里必须严格判 typeof === 'object',否则下标 1、2… 会被当成 config 而算出一个假的生效档)。
function sessionRecentUserRequest(o) {
  // Derive from surviving display messages, never from compaction's synthetic user messages.
  const messages = o && Array.isArray(o.messages) ? o.messages : null;
  const recent = messages ? messages.findLast(message => message && message.role === 'user' && !(message.meta && message.meta.origin === 'agent_wake')) : (o && o.recentUserRequest);
  if (!recent) return null;
  const content = recent.content == null ? recent.text : recent.content;
  const text = (Array.isArray(content) ? content.map(part => typeof part === 'string' ? part : part && part.text || '').join('\n') : String(content || '')).replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!text) return null;
  return { text, ...(Number(recent.turnSeq) > 0 ? { turnSeq: Number(recent.turnSeq) } : {}), ...(recent.at || recent.createdAt ? { at: String(recent.at || recent.createdAt) } : {}) };
}
function sessionMeta(o, config) {
  // Idle index entries are authoritative; pending/in-flight index batches already overlay their writes.
  if (isLive(o.id)) o = applySessionTitleOverride({ ...o });
  const cfg = (config && typeof config === 'object') ? config : null;
  const recentUserRequest = sessionRecentUserRequest(o);
  return {
    id: o.id,
    missionId: sessionMissionId(o), // 75a: stable Mission identity (== sessionId in 3.0; read-only derive for legacy)
    title: o.title,
    ...(safeSessionId(o.relatedSessionId) ? { relatedSessionId: safeSessionId(o.relatedSessionId) } : {}),
    summary: o.summary || '',
    ...(recentUserRequest ? { recentUserRequest } : {}),
    cwd: o.cwd,
    pinned: Boolean(o.pinned),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    messageCount: Number.isFinite(o.messageCount) ? o.messageCount : (o.messages?.length || 0),
    promptPack: PROMPT_PACK_VERSION, // 51c-b(04 Phase B):提示词包版本,为 A/B 实验与问题回溯奠基
    kind: sessionKind(o), // 第70波:Quick Ask / Mission 显式标识(旧索引条目只读派生,见 sessionKind)
    // 116f: 会话头的【原始】 kind 只在它是管家会话时随条目带出。sessionKind() 只归一为 mission/quick_ask,
    // 索引条目一旦生成就再也认不出管家会话 —— 而 listSessions 的快路径读的正是索引,没有这个字段就没法
    // 把管家排除在会话列表(以及走同一份 metas 的 113b 内容搜索)之外。普通会话【零新增字段】,
    // /api/sessions 的载荷逐字节不变。两个入参形态都要认:会话头(o.kind)与【已归一过的索引条目】
    // (o.rawKind)—— 快路径会把索引条目再喂一次 sessionMeta,只认 o.kind 的话这个字段在那一趟就丢了。
    ...(o && (o.kind === 'steward' || o.rawKind === 'steward') ? { rawKind: 'steward' } : {}),
    // 116-2a(§3.3/§8.6「每条线程一个权限 chip」):会话级权限档。缺省是 **null**,不是全局值 ——
    // chip 要能分清「这条线程自己定了档」(显示实底)与「跟着全局默认走」(显示浅底),填全局值就分不清了。
    // 存量会话读到没有该字段 → null,零迁移。
    permissionMode: sessionPermissionModeOf(o),
    // 116-5a(§11.8.5):线程的名字与一句概括。**缺席时这两个键根本不出现** —— 存量会话的
    // /api/sessions 载荷逐字节不变。两个入参形态都要认:会话头(threadBrief)与已归一过的索引条目
    // (brief) —— 快路径会把索引条目再喂一次 sessionMeta,只认前者的话这个字段在那一趟就丢了
    // (与上面 rawKind 那条同一个坑)。
    ...(sessionBriefOf(o) ? { brief: sessionBriefOf(o) } : {}),
    // 117s-A D2:'steward' 也如实带出(索引条目要能说出「这个标题是谁给的」)。
    // 显示不靠它 —— sessionDisplayTitle 只在 'user' 那一档提前返回,'steward' 走的是与缺席
    // 逐字相同的那条路(brief.title > 原话);带出它是为了不让索引条目比会话头少说一句实话。
    ...(o && (o.titleSource === 'user' || o.titleSource === 'steward') ? { titleSource: o.titleSource } : {}),
    // 派生的【生效】档(会话级 > 全局)。只在调用方给了 config 时输出:索引条目保持精简,而 API 层
    // 拿得到 config,给 UI 与管家一个不用自己再解析一遍的现成值。
    ...(cfg ? { effectivePermissionMode: resolvePermissionMode({ session: o, config: cfg }) } : {}),
  };
}
// 116f: 管家会话不是「一个会话」,它是工作台本身的那张脸 —— 会话列表、内容搜索、投影、收件箱四个面
// 都必须看不见它。判定读【原始】 kind,不经 sessionKind()(那会把它说成 quick_ask)。
// 116-5a:从两种入参形态里取出摘要(会话头的 threadBrief / 索引条目的 brief),形状归一成
// {title, gist} —— 索引条目只带显示要用的两个字段,at/model/stage 留在会话头上供事后对账。
function sessionBriefOf(o) {
  const b = o && ((o.threadBrief && typeof o.threadBrief === 'object') ? o.threadBrief : ((o.brief && typeof o.brief === 'object') ? o.brief : null));
  if (!b) return null;
  const title = String(b.title || '').trim();
  const gist = String(b.gist || '').trim();
  return (title || gist) ? { title, gist } : null;
}
function sessionMetaIsSteward(meta) {
  return !!(meta && (meta.rawKind === 'steward' || meta.kind === 'steward'));
}
function sortSessionMetas(arr) {
  return arr.slice().sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
function getSessionTitleOverride(id) { return sessionTitleOverrides.get(id); }
function setSessionTitleOverride(id, value) { sessionTitleOverrides.set(id, value); }
function dropSessionTitleOverride(id) { sessionTitleOverrides.delete(id); }
return { sessionRecentUserRequest, sessionKind, sessionMissionId, SESSION_BRIEF_TITLE_CHARS, SESSION_BRIEF_GIST_CHARS, applySessionTitleOverride, sessionDisplayTitle, sessionMeta, sessionBriefOf, sessionMetaIsSteward, sortSessionMetas, isUntitledSessionTitle, getSessionTitleOverride, setSessionTitleOverride, dropSessionTitleOverride };
}
module.exports = { createSessionMetadata };
