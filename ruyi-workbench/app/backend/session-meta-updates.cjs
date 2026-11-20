'use strict';
const { clearNativeResume, unavailableAgentRoute, inferSessionEngineRoute } = require('./session-engine-route.cjs');
const crypto = require('node:crypto');
const path = require('node:path');

function createSessionMetaUpdates({ metadata, overrides, sessions, lifecycle, safeSessionId, logEvent, RUYI_EVENTS, timers = { setTimeout, clearTimeout } }) {
  const { setSessionTitleOverride, SESSION_BRIEF_TITLE_CHARS, SESSION_BRIEF_GIST_CHARS } = metadata;
  const { normalizeSessionEngineRoute, sessionEngineRouteOverrides, sessionEngineRouteScopeOverrides, rememberLastUsedEngineRoute, normalizeSessionPermissionMode, sessionPermissionModeOverrides, normalizeSessionDesktopTools, sessionDesktopToolsOverrides } = overrides;
  const { withSessionMutateLock, loadSession, saveSession } = sessions;
  const { activeChildren, turnSettlers } = lifecycle;
function sessionTodosSignature(todos) {
  const items = (Array.isArray(todos) ? todos : []).filter(t => t && typeof t === 'object')
    .map(t => [String(t.content || t.title || t.text || ''), String(t.status || '')]);
  return crypto.createHash('sha1').update(JSON.stringify(items)).digest('hex').slice(0, 16);
}

// 116-2a: patch 的应用规则单列一处 —— 立即落盘路径与「延后到回合 settle 之后」的重做路径必须逐字
// 一致(重做时是在一份【重新装载的新副本】上再应用一次同一个 patch)。
function applySessionMetaPatch(session, patch) {
  const id = session.id;
  // 116-5a(27 号文 §11.8.3):走这条通道改标题的只有两个调用面 —— PATCH /api/sessions/:id(用户
  // 在界面上改名)与 steward_thread_rename(管家替用户改名)。两者都是【有意起的名字】,应当压过
  // 116-5 自动生成的 threadBrief.title。会话头上本来分不出「标题是自动派生的原话」还是「人起的名字」
  // (两者都只是 session.title),不记这一笔的话「线程改名后不再被摘要覆盖」这条需求无法实现。
  if (typeof patch.title === 'string') { session.title = patch.title.slice(0, 200); session.titleSource = 'user'; if (patch.titleSource !== 'steward') setSessionTitleOverride(id, { title: session.title, titleSource: 'user' }); }
  if (typeof patch.pinned === 'boolean') session.pinned = patch.pinned;
  if (Object.prototype.hasOwnProperty.call(patch, 'engineRoute')) {
    const route = normalizeSessionEngineRoute(patch.engineRoute);
    if (route) {
      if (unavailableAgentRoute(inferSessionEngineRoute(session)) && !unavailableAgentRoute(route)) clearNativeResume(session);
      session.engineRoute = route;
      // 显式「仅此任务」跨回合保留，不能在下次用户发消息时又写成新任务的“上次用的”。
      if (patch.engineRouteScope === 'thread') session.engineRouteScope = 'thread';
      else delete session.engineRouteScope;
      sessionEngineRouteOverrides.set(id, route);
      sessionEngineRouteScopeOverrides.set(id, session.engineRouteScope || '');
      // 123-N2 写入点①:用户在线程头上亲手换了引擎/模型。这条通道【只有】用户走得到 ——
      // PATCH /api/sessions/:id(线程头 chip)与进程内改会话头的调用方;管家给新线程定档走的
      // 是 13q stewardApplyThreadTier,它直接写 session.engineRoute,根本不经过本函数。
      // 本函数是同步的(它有两条调用路径:立即落盘与活回合 settle 之后重放),不能 await;
      // 记账是旁路,fire-and-forget 且内部整段 try —— 见 rememberLastUsedEngineRoute 头注第三条。
      // 重放那条路会再记一次:同值第二次是 mutateConfig 锁内的一次 abort,无副作用。
      if (session.engineRouteScope !== 'thread') void rememberLastUsedEngineRoute(route);
    }
  }
  // 116-2a(§3.3/§8.6):线程级权限档,形状与 engineRoute 这个既有的会话级先例对齐(同端点、同覆盖表
  // 纪律)。null/''/非法值 = 清除会话级设置回落全局(白名单校验在 API 层已经把非法值挡成 400,这里
  // 是第二道:任何内部调用方写进来的垃圾都只会退化成「跟随全局」,绝不会写出一个野档)。
  if (Object.prototype.hasOwnProperty.call(patch, 'permissionMode')) {
    const mode = normalizeSessionPermissionMode(patch.permissionMode);
    sessionPermissionModeOverrides.set(id, mode);
    if (mode) session.permissionMode = mode; else delete session.permissionMode;
  }
  // 117z-E2 提交①(§11.21.3):会话级桌面工具覆盖。形状与上面 permissionMode 那条逐字对齐(同覆盖表
  // 纪律、同延后落盘防护)。三态:true / false / null(= 清除会话级设置,回落全局 allowDesktopTools)。
  // 【它是状态,不是出身】—— 所以它进白名单,而下面那条 createdBy 不进。
  // 如实记两件事:① 这条通道也接 PATCH /api/sessions/:id,所以【用户】可以经界面/脚本改自己线程的
  // 这一项(与「桌面权限在设置里改」同一语义,§11.21.2);管家【碰不到这条路】——它手里只有 steward_*
  // 工具,没有任何一个能发 HTTP PATCH,放宽那一侧的闸在 13k 的工具实现里。② 与 permissionMode 切
  // 「全自动」不同,这里【没有】confirm:true 那道二次确认门(那道门在 13d 的路由层,不在本函数);
  // 已登记为债。
  if (Object.prototype.hasOwnProperty.call(patch, 'desktopTools')) {
    const desk = normalizeSessionDesktopTools(patch.desktopTools);
    sessionDesktopToolsOverrides.set(id, desk);
    if (desk === null) delete session.desktopTools; else session.desktopTools = desk;
  }
  // 117z-E2 提交①(§11.21.3):`createdBy` 【故意不在这张白名单里】,一个分支都不给它。
  // 它记的是【出身】(这条线程是不是管家开的),不是状态 —— 只在 13k 的两处 createSession 调用点
  // (thread_new / quick_ask)写一次,此后终身不变。放宽桌面权限的目标合法性判据读的正是它:
  // 一旦它能经 PATCH 改,任何调用方都能把自己的普通会话刷成「管家开的」,再去要桌面权限,
  // §11.21.3 的「只能开给管家自己开的线程」就成了一句空话。本函数是白名单语义,不写分支
  // 即拒绝(patch.createdBy 静默丢弃),这条注释是给日后加分支的人看的锚。
  // 116g(§3.1 事项跨会话升格):线程归属。**只认合法 id,且只由 06e 的 missionAttachThread /
  // missionDetachThread 写** —— 它们成对维护「会话头 missionId」与「事项文件 sessionIds」两侧。
  // 走这条 patch 通道(而不是直接 loadSession+saveSession)是为了白拿 116-2a 的活回合竞态防护:
  // 活回合期间延后到回合 settle 之后、在【重新装载的副本】上重放同一个 patch,绝不用陈旧正文
  // 盖掉回合刚写的消息。非法值一律忽略(绝不写出一个野 missionId,那会让线程从投影里凭空消失)。
  if (Object.prototype.hasOwnProperty.call(patch, 'missionId')) {
    const missionId = safeSessionId(patch.missionId);
    if (missionId) session.missionId = missionId;
  }
  // 116-2e(27 号文 §11.1 第 2 项「速查线程自动收工」):速查会话头上的 stewardQuick 标。走这条 patch
  // 通道与 missionId 同理 —— 收工恰好发生在回合刚结束的窗口里,白拿 116-2a 的活回合竞态防护(延后到
  // settle 之后在【重新装载的副本】上重放,绝不用陈旧正文盖掉回合刚写的答案)。
  // 严格归一成固定六个字段:这条通道也接 PATCH /api/sessions/:id 的请求体,不能让任意形状写进会话头。
  // 116-3 P1-6 加第六个 closedTurnSeq:收工那一刻的回合数。之后会话每多一个用户回合 turnSeq 就会
  // 超过它 = 用户在经典 2.0 视窗里把这条速查线程继续用起来了,收工标记应当自动失效(判据单点在 13g 的
  // stewardQuickClosed)。不写进白名单的话它会被这段归一化静默丢掉,重开判据永远拿不到锚点。
  if (patch.stewardQuick && typeof patch.stewardQuick === 'object' && !Array.isArray(patch.stewardQuick)) {
    const q = patch.stewardQuick;
    const closedTurnSeq = Number(q.closedTurnSeq);
    session.stewardQuick = {
      schema: 1,
      askedAt: String(q.askedAt || ''),
      question: String(q.question || '').slice(0, 1000),
      stewardTurnKey: String(q.stewardTurnKey || ''),
      closedAt: q.closedAt ? String(q.closedAt) : null,
      ...(Number.isFinite(closedTurnSeq) && closedTurnSeq >= 0 ? { closedTurnSeq: Math.round(closedTurnSeq) } : {}),
    };
  }
  // 116-4（27 号文 §11.7「第四源 sessionTurns 与唤醒链」）：管家线程的两个标。
  //   · launchedBy:'steward' —— 这条线程的回合是管家发起的（thread_new / quick_ask / 递话）。
  //     收件箱第四源只对【管家关心的会话】入箱，它就是「关心」的机器痕迹之一
  //     （另两个是 stewardQuick 与「线程在别人的事项里」）。只认 'steward' 这一个字面量：
  //     其它值一律当没写，不让 PATCH /api/sessions/:id 的调用方拿它给自己的普通会话
  //     挂上管家的注意力。
  //   · stewardLastTurn —— 管家发起的那一回合 settle 之后的成败（13g stewardLaunchTurn 写）。
  //     会话头上本来【没有】任何回合成败字段（116-4 实测：回合失败后头上只有 summary
  //     里那句人话，那是渲染不是信号），而收件箱只读磁盘 —— 所以第四源要分得出
  //     done / failed，就必须有这一条落盘的账。严格归一成固定五字段，与 stewardQuick 同纪律。
  if (patch.launchedBy === 'steward') session.launchedBy = 'steward';
  // 121-K3(34 号文 §4.4「交接」):「交给管家盯 / 别盯了」那枚开关。**只认两个布尔字面量** ——
  // 其它任何值(字符串 'true'、1、null、对象)一律当没写,不让调用方拿它往会话头上写野值。
  // 它是【状态】不是出身,所以进白名单(与 launchedBy 同一条理由);而它的一对孪生字段
  //   · origin    —— 【故意不在这张白名单里】,一个分支都不给它。它记的是「这条线程是谁开的」,
  //                  只在 createSession 写一次、此后终身不变。一旦能经 PATCH 改,任何调用方都能把
  //                  自己的普通会话刷成「管家开的」,来源图形(环/人形/钟)就成了一句空话 ——
  //                  与本函数上方 createdBy 那条注释是同一个模具,理由也是同一个。
  //   · createdBy —— 见本函数上方 117z-E2 那段注释锚。
  // 判据侧:stewardWatchedThread(06i)把 true/false 都当【显式意愿】,排在原来三条判据之前 ——
  // 写 false 对管家自己开的线程同样生效(= 用户接手,别再盯了)。
  if (patch.stewardWatch === true) session.stewardWatch = true;
  else if (patch.stewardWatch === false) session.stewardWatch = false;
  // 成败账只进不退:turnSeq 单调(rewind 也不回退它),两笔写入乱序落盘时(10 的收尾写与 13k/13s 的写不在一条链上)
  // 旧回合那笔不能盖掉新回合那笔;同号允许覆盖(同一回合的后写者带的是更完整的那份)。
  const prevLastTurnSeq = session.stewardLastTurn && typeof session.stewardLastTurn === 'object' ? Number(session.stewardLastTurn.seq) : NaN;
  if (patch.stewardLastTurn && typeof patch.stewardLastTurn === 'object' && !Array.isArray(patch.stewardLastTurn)
      && !(Number.isFinite(prevLastTurnSeq) && Number(patch.stewardLastTurn.seq) < prevLastTurnSeq)) {
    const t = patch.stewardLastTurn;
    const seq = Number(t.seq);
    session.stewardLastTurn = {
      seq: Number.isFinite(seq) && seq >= 0 ? Math.round(seq) : 0,
      ok: t.ok === true,
      aborted: t.aborted === true,
      errorClass: String(t.errorClass || '').slice(0, 64),
      at: String(t.at || ''),
      todosStartSig: String(t.todosStartSig || '').slice(0, 64),
    };
  }
  // 116-5a(27 号文 §11.8「线程自动摘要」):线程的名字与一句概括。严格归一成固定六字段,与
  // stewardQuick / stewardLastTurn 同纪律 —— 这条通道也接 PATCH /api/sessions/:id,不能让任意形状
  // 写进会话头。title/gist 在这里就夹到上限:显示层不必再截一次,存量数据也不会因为上限调整而变形。
  if (patch.threadBrief && typeof patch.threadBrief === 'object' && !Array.isArray(patch.threadBrief)
      && (patch.threadBriefRewindGen === undefined || (Number(session.rewindGen) || 0) === patch.threadBriefRewindGen)) {
    const b = patch.threadBrief;
    const stage = String(b.stage || '');
    session.threadBrief = {
      schema: 1,
      title: String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, SESSION_BRIEF_TITLE_CHARS),
      gist: String(b.gist || '').replace(/\s+/g, ' ').trim().slice(0, SESSION_BRIEF_GIST_CHARS),
      at: String(b.at || ''),
      model: String(b.model || '').slice(0, 160),
      stage: (stage === 'first_turn' || stage === 'settled') ? stage : 'first_turn',
    };
  }
  // 116-5a:只认白名单里的字面量(同 116-4 的 launchedBy)。别的值一律当没写 —— 调用方拿它
  // 给自己刷一个假的「人起的名字」没有意义,但白名单该有的严格一分不能少。
  // 117s-A D2(§11.13 ⑤a;用户第九轮走查「线程标题概括就是管家发的提示词本身,太长了」):
  // 白名单多一个字面量 'steward' —— `steward_thread_new` 传进来的 title 【不是】人起的名字。
  // §11.8.4 当年的假设是「args.title 是管家有意起的名字,与改名同一性质」,用户真机上两条线程
  // (sess_e97b… 大A / sess_8bb0… 博纳)证明这条假设不成立:模型把用户那句话原样抄进了 title,
  // 而 createSession 见非占位标题就写 titleSource:'user'(见下方 createSession),于是 116-5 的
  // 自动摘要判据(06-provider-engine:「titleSource === 'user' 就跳过」)永远短路,threadBrief 恒为 null。
  // 'steward' 这一档的语义:标题有,但它排在生成的名字【后面】—— 显示优先级于是如实是
  // 人起的 > 生成的 > 管家抄来的那句(它就是 session.title 本身)> 原话,sessionDisplayTitle
  // 一个字都不用改就已经是这条顺序(它只在 'user' 那一档提前返回)。
  if (patch.titleSource === 'user' || patch.titleSource === 'steward') session.titleSource = patch.titleSource;
  // v0.9-S3 (C3): the top-bar working-folder picker + folder-drag switch persist the session's cwd here.
  // Resolve to an absolute path (mirrors normalizeCwd); a blank/non-string value is ignored (never clears
  // an existing cwd). The turn engine reads `cwd || session.cwd`, so this becomes the working dir for the
  // next turn. No existence check — a stale/moved folder simply resolves at run time like any manual entry.
  if (typeof patch.cwd === 'string' && patch.cwd.trim()) {
    const cwd = process.platform === 'darwin' && patch.cwd.startsWith('/') ? patch.cwd : patch.cwd.trim();
    session.cwd = path.resolve(cwd);
  }
  return session;
}

// 116-2a(116c 登记的既有根因:「updateSessionMeta 读改写与活回合收尾 save 的竞态」)。
// 症状:活回合期间 loadSession 拿到的是【磁盘上那一刻】的副本;回合把新消息写进它自己的内存副本、
// 在收尾时整份落盘。两份副本互相覆盖 —— 元数据改动被回合盖回,或更糟:元数据这份陈旧正文把回合刚
// 写的消息盖没(会话正文缩水 = 头计数与正文行数错位)。
// 策略【延后落盘】,不是拒绝。理由:
//   ① §8.6 要求权限 chip「点开即换、立即生效」,而一个回合可以跑几分钟 —— 在最该收紧权限的那几分钟
//      里让 chip 失效是本末倒置;拒绝(session.busy)把这个竞态从「会丢数据」变成「用不了」,不是修。
//   ② 延后并不牺牲「立即生效」:permissionMode 先进内存覆盖表,loadSession/saveSession 两侧都应用它,
//      对所有读者(含下一个回合的档位解析)立刻是新值;而且活回合自己的下一次 saveSession 就会把它
//      带上磁盘 —— 那份副本拿的是最新正文,不会盖消息。
//   ③ 重做时【重新 loadSession】再应用同一个 patch,任何时刻都不会拿陈旧正文覆盖。
// 保留 steward_thread_rename 自己的 steward.busy 忙锁(116c):那是【自动】改名,对管家来说立刻失败比
// 静默延后更诚实(「不要重试,等它停」写在 schema 里),且其断言已冻结。
const sessionMetaDeferChains = new Map(); // id -> Promise(每会话一条串行链,落盘后自清)
const SESSION_META_DEFER_TIMEOUT_MS = 180000; // 回合真楔死时的兜底:超时后照样按【重新装载】的副本写一次
// 121-K6a(34 号文 §4.4「交接」):委托一句。只在【同一发 PATCH 里 stewardWatch===true】时才有效——
// 不是会话状态,是一次性的交接话,所以【不落会话头】:applySessionMetaPatch 不认它,它只活在这一次
// 请求的 thread.adopted 事件里,管家读完这一条就完了,不会在会话头上留下第二份「委托」字段。
const STEWARD_WATCH_NOTE_MAX = 200;
function stewardWatchNoteFrom(p) {
  if (!p || p.stewardWatch !== true) return '';
  const raw = typeof p.stewardWatchNote === 'string' ? p.stewardWatchNote : '';
  return raw.trim().slice(0, STEWARD_WATCH_NOTE_MAX);
}

// 107-F7b:元数据补丁撞上撤回时的重放上限。updateSessionMeta 是读改写 —— 它 load 落在撤回之前、save 落在
// 撤回之后时,那份副本带着撤回删掉的消息,代数闸会整份丢掉它(否则就是把撤回盖回去,F7b 那条缺陷本身:
// 13k stewardRecordLaunchOutcome 在回合 settle 那一刻发的正是这一发 —— 负载复现里被闸丢掉的那一存
// 日志为 writer:'session_meta'、keys:[launchedBy, stewardLastTurn])。丢掉的是正文,补丁本身
// (改名、权限档、stewardLastTurn、threadBrief……)是真数据,不能跟着丢:在【新读】的副本上重放一次。
// 有界:连着撞上三次撤回才会放弃,那时把 SESSION_STALE_SAVE 如实抛给调用方(与 save 失败同一条语义)。
const SESSION_META_STALE_REPLAYS = 2;
async function updateSessionMeta(id, patch) {
  return updateSessionMetaAttempt(id, patch, 0);
}
async function updateSessionMetaAttempt(id, patch, replayDepth) {
  const p = (patch && typeof patch === 'object') ? patch : {};
  const watchNote = stewardWatchNoteFrom(p);
  // hunt2-P4:读-改-存进 mutateSession 同一条 per-id 链(与它互斥,见 withSessionMutateLock 头注)。
  // 链内只做这一次 load→patch→save;撤回重放的递归与延后通道都在链【外】,不会自己等自己。
  const step = await withSessionMutateLock(id, async () => {
    const loaded = await loadSession(id);
    if (!loaded) return { session: null };
    applySessionMetaPatch(loaded, p);
    // 活回合(activeChildren)或 dying turn 收尾窗口(turnSettlers,第69波 rewind 同款判据)之外:原路不变。
    if (activeChildren.has(id) || turnSettlers.has(id)) return { session: loaded, deferred: true };
    try { await saveSession(loaded, { throwIfStale: true, writer: 'session_meta' }); }
    catch (error) { return { session: loaded, error }; }
    return { session: loaded };
  });
  const session = step.session;
  if (!session) return null; // missing/corrupt — caller maps to 404
  if (!step.deferred) {
    if (step.error) {
      const error = step.error;
      if (!(error && error.code === 'SESSION_STALE_SAVE') || replayDepth >= SESSION_META_STALE_REPLAYS) throw error;
      // 107-F7b:从头再走一遍(重新 load、重新判活回合),而不是只在原地重试 save —— 撤回之后可能已经
      // 起了新回合,那时补丁该走下面那条延后通道,不能拿新副本去跟活回合抢写。
      logEvent({ kind: 'session_meta_replayed', sessionId: id, keys: Object.keys(p).slice(0, 8), attempt: replayDepth + 1 });
      return updateSessionMetaAttempt(id, patch, replayDepth + 1);
    }
    RUYI_EVENTS.emit('thread.state', { sessionId: id });   // 121-K2a:会话头刚变过,五态由订阅者现算
    // 121-K3(§4.4「工作台 → 管家」):用户刚按下「交给管家盯」。复用 missionAttachThread 已经在派的
    // 同名事件,只多一个 by:'user' 把两条来路分开(那一条是归并到事项,这一条是用户交接)。
    // 121-K6a:附带的一句委托话(有的话)随同一发事件带上,note 只在这一发里,不重复读取。
    if (p.stewardWatch === true) RUYI_EVENTS.emit('thread.adopted', { sessionId: id, missionId: String(session.missionId || ''), title: String(session.title || ''), by: 'user', ...(watchNote ? { note: watchNote } : {}) });
    return session;
  }
  logEvent({ kind: 'session_meta_deferred', sessionId: id, keys: Object.keys(p).slice(0, 8) });
  const previous = sessionMetaDeferChains.get(id) || Promise.resolve();
  const chain = previous.catch(() => {}).then(async () => {
    let forced = false;
    const settler = turnSettlers.get(id);
    if (settler && settler.promise) {
      let timer;
      let settled;
      try {
        settled = await Promise.race([
          settler.promise.then(() => true, () => true),
          new Promise(r => { timer = timers.setTimeout(() => r(false), SESSION_META_DEFER_TIMEOUT_MS); }),
        ]);
      } finally { timers.clearTimeout(timer); }
      if (!settled) { forced = true; logEvent({ kind: 'session_meta_defer_timeout', sessionId: id }); }
    }
    // hunt2-P4:settle 已在上面(链外)等过;读-改-存这一段进 per-id 读改写链,与 mutateSession 互斥。
    const fresh = await withSessionMutateLock(id, async () => {
      let copy = await loadSession(id).catch(() => null);
      if (!copy) return null;                 // 会话在窗口内被删了:什么都不做(删除已清覆盖表)
      applySessionMetaPatch(copy, p);
      // 107-F7b:「重新装载的副本」在 load 与 save 之间同样可能撞上一次撤回(settle 之后正是撤回动手的
      // 时刻),被代数闸丢掉时在更新的副本上重放补丁,有界(SESSION_META_STALE_REPLAYS)。
      // 延后写失败记录审计，不反噬已返回的投影；未落盘不能发布成功交接事件。
      for (let attempt = 0; ; attempt++) {
        try { await saveSession(copy, { throwIfStale: true, writer: 'session_meta_deferred' }); break; }
        catch (error) {
          if (!(error && error.code === 'SESSION_STALE_SAVE') || attempt >= SESSION_META_STALE_REPLAYS) {
            logEvent({ kind: 'session_meta_deferred_failed', sessionId: id, code: String(error && error.code || 'WRITE_FAILED'), forced });
            return null;
          }
          logEvent({ kind: 'session_meta_replayed', sessionId: id, keys: Object.keys(p).slice(0, 8), attempt: attempt + 1, deferred: true });
          copy = await loadSession(id).catch(() => null);
          if (!copy) return null;
          applySessionMetaPatch(copy, p);
        }
      }
      return copy;
    });
    if (!fresh) return;
    RUYI_EVENTS.emit('thread.state', { sessionId: id });   // 121-K2a:延后那条路落盘之后同样要派
    // 121-K3:延后那条路同样要派交接事件(用户完全可能在一个回合跑着的时候按下那枚开关)。
    // 121-K6a:note 算在 patch 到来那一刻(watchNote,外层闭包变量),不是等到这里才重算——委托话是
    // 那一刻说的那句,不该被延后窗口期间任何变化影响。
    if (p.stewardWatch === true) RUYI_EVENTS.emit('thread.adopted', { sessionId: id, missionId: String(fresh.missionId || ''), title: String(fresh.title || ''), by: 'user', ...(watchNote ? { note: watchNote } : {}) });
    // 116-3 data-safety P1-3(登记项转已记录):超时兜底那条路是【明知有残留竞态】仍然写下去 ——
    // 等待窗口过了不等于收尾 save 真的落盘完成,此刻拿到的 fresh 可能还不含最新一轮消息,两边互相
    // 覆盖谁赢看时序。行为不改(拒绝会把「会丢字段」换成「用不了」,§8.6 要求 chip 点开即换),
    // 但必须【留痕】:落一条审计事件,写清楚这次强制写发生在什么状态下,事后能对账。
    if (forced) {
      logEvent({
        kind: 'session_meta_defer_forced', sessionId: id, keys: Object.keys(p).slice(0, 8),
        stillActive: activeChildren.has(id), stillSettling: turnSettlers.has(id),
      });
    }
  });
  // 自清,避免长驻会话把链表越挂越长;只清自己那一条(后来者可能已经顶上)。
  const wrapped = chain.then(() => {}, () => {});
  sessionMetaDeferChains.set(id, wrapped);
  wrapped.then(() => { if (sessionMetaDeferChains.get(id) === wrapped) sessionMetaDeferChains.delete(id); });
  // 返回值是「投影」:磁盘上的会话 + 本次 patch,与落盘后的结果一致(调用方据此回 200)。
  return session;
}

  return { sessionTodosSignature, updateSessionMeta, hasPending: id => sessionMetaDeferChains.has(id) };
}

module.exports = { createSessionMetaUpdates };
