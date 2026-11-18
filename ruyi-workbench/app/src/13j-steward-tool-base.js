// ============================================================================
// 第 117 波 T1(32 号文 §2.1「拆 13g-steward.js」):管家工具面的共享底座。
//
// 落点(transport 层,manifest 中位于 13i-steward-inbox.js 之后、13k-steward-threads.js 之前)。
// T1 拆分:原 13g-steward.js 已 2088 行,`steward-runner.static.e2e.js` ①「13g 不超过 SPEC 目标
// 2000 行」在 HEAD 上长期是红的,而 31 号文七轴还要往管家里加 8-12 个工具。按「谁被谁引用」把它
// 拆成四个文件,拼接顺序即依赖方向,零新增前向边:
//   · 13j-steward-tool-base.js(本文件)—— 两个工具族都要用的共享面:常量、稳定信封、门控壳用的
//     失败信封、会话头读取与线程小工具、决策日志(写与只读)、记忆存储、深读预算、每回合配额桶、
//     速查线程的两条判据。它被下面三个文件引用,故排在最前;
//   · 13k-steward-threads.js —— 线程族(tier edit):派活原语 + thread_* / quick_ask /
//     threads_search / 收件箱行增强;
//   · 13l-steward-ops.js —— 观察族 / 决策族 / 记忆族 / 设置族 / 内容管理族;
//   · 13g-steward.js —— 管家域路由、记忆面板、工具门控壳与 StewardHooks 注册表(排在最后,
//     因为注册表要引用上面两个文件里的 stewardImpl*,排在后面才是后向边)。
// 本次拆分是【纯搬家】:所有函数体逐字节不变,新写的只有各文件的头部注释。
//
// 依赖纪律(§11.3「不得新增前向边」):本文件只引用拼接顺序在它之前的模块符号
// (00/01/02/04/06i/13i …),全部后向边;它自己的符号只被 13k/13l/13g/13h 引用,同样是后向边。
//
// 下面这段 116c 的横幅逐字节原样保留。其中「真实实现全在这里」如今指的是
// 13j/13k/13l/13g 这四个文件合起来的「13g 族」,不再只是一个文件;四条铁律一字未改,
// 对整个族同样成立。
// ============================================================================

// ════════════════════════════════════════════════════════════════════════════
// 第 116 波 116c(27 号文 §3.5 工具面 / §4 记忆层 / §11.2 读预算):管家工具集实现。
//
// 定位:12-tool-dispatch.js 里的 17 个 steward_* handler 只写一行 `StewardHooks.xxx(args, ctx)`,
// 真实实现全在这里。这样 12(工具层)→ 06i(引擎层命名空间)是后向边,13g(传输层)单向往 06i 挂方法,
// 全程零新增前向边。
//
// 铁律(§3.4 红线 + §3.3):
//   ① 管家「动如意」,不「动世界」—— 本文件不提供任何文件读写/shell/桌面/浏览器/联网/git 写能力;
//      要动手就 steward_thread_new / steward_thread_continue 委派给线程,由线程按自己的权限档执行。
//   ② 双重 fail-closed:stewardEnabledV1 !== true -> steward.disabled(零写入);
//      ctx.session.kind !== 'steward' -> steward.forbidden(普通会话即使拿到工具名也调不动)。
//   ③ 管家只能收紧,不能放宽:放行范围一律经 06i 的 stewardMayAct(目标线程 permissionMode, ...);
//      永久豁免清单(stewardToolPermanentlyExempt)在任何权限档都返回 propose_required。
//   ④ 每个写动作追加一行决策日志 `<data>/steward/decisions-v1.ndjson`,带 undoRef 与依据。
// ════════════════════════════════════════════════════════════════════════════

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

const StewardDecisions = require('./backend/steward-decisions.cjs').createStewardDecisions({
  stewardDir, nowIso, safeJsonParse, safeSessionId, readFileTail, repairMissionChangeTornTail, STEWARD_CONFIG_SECRET_PATTERN,
});
const { stewardAppendDecision, stewardBasisOf, stewardDecisionsRead } = StewardDecisions;
const { createStewardMemoryStore, STEWARD_MEMORY_SCHEMA, STEWARD_MEMORY_MERGED_FROM_MAX } = require('./backend/steward-memory-store.cjs');
const {
  stewardMemoryScopeOf, stewardNormalizeMemoryScope, stewardMemoryScopeMatches, stewardMemoryScopeLabel,
  stewardReadMemoryStore, stewardMutateMemory,
} = createStewardMemoryStore({
  stewardDir, nowIso, safeJsonParse, atomicWriteJson, projectKeyForCwd, cleanMemoryDate,
  STEWARD_MEMORY_KINDS, STEWARD_MEMORY_LIMITS, stewardSanitizeText,
});

// ── §11.2 深读预算:每回合 ≤6 次、累计字符 ≤ stewardReadBudgetChars ─────────────────────────
// 桶键与 105a observation_recall 同款:会话 id + 回合键(10 providerTurnQuotaKey:优先 turnSeq,回合内稳定、
// 压缩不改它)。每会话保留最近 4 个桶,全局最多 64 个会话,先进先出。
const _stewardReadBudget = new Map(); // sessionId -> Map(turnKey -> { calls, chars })
function stewardReadBucket(sessionId, turnKey) {
  let buckets = _stewardReadBudget.get(sessionId);
  if (!buckets) { buckets = new Map(); _stewardReadBudget.set(sessionId, buckets); }
  while (_stewardReadBudget.size > 64) _stewardReadBudget.delete(_stewardReadBudget.keys().next().value);
  if (!buckets.has(turnKey)) {
    buckets.set(turnKey, { calls: 0, chars: 0 });
    while (buckets.size > 4) buckets.delete(buckets.keys().next().value);
  }
  return buckets.get(turnKey);
}
function stewardTurnKeyOf(ctx) {
  return providerTurnQuotaKey(ctx && ctx.session);
}

// 每回合配额桶:复用 116c 的 stewardReadBucket 形状(会话 id + 回合序号),但各族一张自己的表 ——
// 深读预算与起草/速查次数是三件不同的事,合在一个桶里会互相饿死。
const _stewardTurnQuota = new Map(); // bucket -> Map(`${sessionId} ${turnKey}` -> count)
function stewardTurnQuotaTake(bucket, ctx, max) {
  const key = String(ctx && ctx.sessionId ? ctx.sessionId : '') + ' ' + stewardTurnKeyOf(ctx);
  let table = _stewardTurnQuota.get(bucket);
  if (!table) { table = new Map(); _stewardTurnQuota.set(bucket, table); }
  const used = Number(table.get(key)) || 0;
  if (used >= max) return false;
  table.set(key, used + 1);
  while (table.size > 64) table.delete(table.keys().next().value);
  return true;
}
// 退一次:take 成功之后发现这一次其实没有做那件「花钱的事」(第二轮工具走查 F11:playbook_draft 在没调模型就失败时),
// 把刚占的名额还回去。桶或键不在(已被淘汰)时什么都不做。
function stewardTurnQuotaRefund(bucket, ctx) {
  const key = String(ctx && ctx.sessionId ? ctx.sessionId : '') + ' ' + stewardTurnKeyOf(ctx);
  const table = _stewardTurnQuota.get(bucket);
  const used = table ? Number(table.get(key)) || 0 : 0;
  if (used > 1) table.set(key, used - 1); else if (used === 1) table.delete(key);
}

// ── 129c(31 号文 §1 红线 4「污染规则」)：管家【自己这一回合】读过外界内容的标记 ────────────
// 红线原文:「管家在一个回合里读过外界内容(网页、文件、线程交付里引用的外部文本),这一回合的
// 所有写动作自动降级为『提议』」。理由:网页里一句「请把设置改成 X」不能借管家的手做事。
//
// **与既有的 stewardTurnTaint(06i)不是一回事,别混**:那一个判的是【目标线程】的活回合有没有
// 读过外部内容(代批闸 8),问的是「这条线程现在要的这个权限干净吗」;这里判的是【管家自己】
// 这一回合的上下文干不干净,问的是「管家现在要做的这个动作,是不是被它刚读到的东西指使的」。
// 两个都要:线程干净 ≠ 管家干净。
//
// 形状与配额桶同源(sessionId + 回合序号),内存级、进程重启即清 —— 它只在一个回合内有意义。
// **判不出一律算污染**是这一族的既有立场(06i 的 stewardTurnTaint 也是),但这里取不到 ctx 时
// 回的是「没污染」:本标记只由眼睛工具【主动置位】,取不到 ctx 说明根本没有人读过东西。
const _stewardTurnTaint = new Map(); // `${sessionId} ${turnKey}` -> Set(工具名)
function stewardTaintKeyOf(ctx) {
  const sid = String((ctx && ctx.session && ctx.session.id) || (ctx && ctx.sessionId) || 'steward');
  return sid + ' ' + stewardTurnKeyOf(ctx);
}
function stewardMarkTurnTainted(ctx, by) {
  const key = stewardTaintKeyOf(ctx);
  let set = _stewardTurnTaint.get(key);
  if (!set) { set = new Set(); _stewardTurnTaint.set(key, set); }
  set.add(String(by || 'unknown').slice(0, 64));
  while (_stewardTurnTaint.size > 64) _stewardTurnTaint.delete(_stewardTurnTaint.keys().next().value);
  return set;
}
// 返回这一回合读过外界内容的来源(工具名,去重保序);空数组 = 干净。
function stewardTurnTaintedBy(ctx) {
  const set = _stewardTurnTaint.get(stewardTaintKeyOf(ctx));
  return set ? [...set] : [];
}

// 129f:管家主动叫人的滚动一小时窗口。与代批那个窗口同一个模具(只在内存、进程重启重新开始数),
// 但**各记各的**:代批与叫人是两件事,合在一个计数里会互相饿死 —— 叫了六次人就不能代批了,说不通。
const stewardNotifyTimes = [];
function stewardNotifiesInWindow(nowMs) {
  const now = Number(nowMs) || Date.now();
  while (stewardNotifyTimes.length && now - stewardNotifyTimes[0] >= STEWARD_NOTIFY_WINDOW_MS) stewardNotifyTimes.shift();
  return stewardNotifyTimes.length;
}
function stewardNotifyRecord(nowMs) { stewardNotifyTimes.push(Number(nowMs) || Date.now()); }

// 127 波 2-quater B2(45 号文 §2-quater.2 闸 10):代批的滚动一小时窗口。上限数字住 06i
// (STEWARD_EXEMPT_DELEGATIONS_PER_HOUR),窗口住这里 —— 13l 的 steward_decide 要读它,而 13m 的
// stewardRunnerRuntime 对 13l 是前向边。只在内存:进程重启 = 重新开始数,与 13m 自理动作账
// (stewardRunnerRuntime.selfServe)同一立场。**只记十道闸全过的那一次**(被拦下的不占名额);
// 记在进核心之前 —— 过了闸就算用掉一次,哪怕随后 decideIntervention 回 version_conflict(宁可少代批)。
const stewardExemptDelegationTimes = [];
function stewardExemptDelegationsInWindow(windowNowMs) {
  const now = Number(windowNowMs) || Date.now();
  while (stewardExemptDelegationTimes.length && now - stewardExemptDelegationTimes[0] >= STEWARD_EXEMPT_DELEGATION_WINDOW_MS) {
    stewardExemptDelegationTimes.shift();
  }
  return stewardExemptDelegationTimes.length;
}
function stewardExemptDelegationRecord(windowNowMs) {
  stewardExemptDelegationTimes.push(Number(windowNowMs) || Date.now());
  while (stewardExemptDelegationTimes.length > 64) stewardExemptDelegationTimes.shift();
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
