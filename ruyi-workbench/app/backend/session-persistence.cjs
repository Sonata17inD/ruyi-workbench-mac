'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
// Owns the head/body commit protocol and its read/write epoch. Execution admission,
// metadata projection and events are explicit ports; no agent or HTTP imports.
function createSessionPersistence({
  files: { sessionPath, sessionBodyPaths, ensureDirs, atomicWriteJson },
  model: { normalizeSession, healStalePendingSegments, mergeMissionBeforeSave },
  coordination: { sessionWriteChains, sessionRewindGenHighWater }, missionChanges,
  bodies, lifecycle, metadata, events, safeSessionId, safeJsonParse, nowIso, logEvent,
  storageVersion: SESSION_STORAGE_VERSION,
}) {
const sessionDiskWriteSeq = new Map();
function bumpSessionDiskWriteSeq(id) { sessionDiskWriteSeq.set(id, (sessionDiskWriteSeq.get(id) || 0) + 1); }
function sessionDiskWriteSeqOf(id) { return sessionDiskWriteSeq.get(id) || 0; }
async function recoverSessionBodyState(id, bp) {
  const head = await readSessionHeadResilient(id);
  if (!head || typeof head !== 'object' || head.storageVersion !== SESSION_STORAGE_VERSION) return null;
  const msg = await bodies.readSessionBodyFile(bp.messages);
  const prov = await bodies.readSessionBodyFile(bp.provider);
  const whole = (body, count) => body && !body.corrupt && !body.unreadable && body.tornAt == null
    && Number.isInteger(count) && body.entries.length === count;
  if (!whole(msg, head.messageCount) || !whole(prov, head.providerHistoryCount)) return null;
  if (!bodies.sessionBodiesMatchCommit(head, msg, prov)) return null;
  const state = {
    msg: bodies.sessionBodyRecordFromRead(msg, null),
    prov: bodies.sessionBodyRecordFromRead(prov, null, { dangling: bodies.danglingTurnState(prov.entries.length, i => prov.entries[i]) }),
    bodiesOk: true,
  };
  bodies.setSessionBodyState(id, state);
  bodies.sessionBodyPerfStats.stateRecoveries++;
  return state;
}
const SESSION_HEAD_TRANSIENT = new Set(['ENOENT', 'EPERM', 'EBUSY', 'EACCES']);
async function readSessionHeadResilient(id) {
  for (let attempt = 0; ; attempt++) {
    try {
      return safeJsonParse(await fsp.readFile(sessionPath(id), 'utf8'), null);
    } catch (error) {
      const code = String((error && error.code) || '');
      if (!SESSION_HEAD_TRANSIENT.has(code) || attempt >= bodies.SESSION_HEAD_READ_RETRIES) return null;
      await new Promise(resolve => setTimeout(resolve, 5 + attempt * 10));
    }
  }
}
// 「这条会话走哪条引擎路由」的只读取法:GET /api/status?sessionId= 与 GET /api/models?sessionId= 用。
// 两条路由都是 auth:'open'(跨站页面也能让浏览器发出来),修前它们调 loadSession —— 装载会补默认字段回写、
// 懒迁移 v1、截断撕裂尾行,开放读口就这样成了能改盘的写口(配合保留名,还能把搜索索引「迁移」成假会话)。
// 这里只读会话头,零副作用;inferSessionEngineRoute 要的 engineRoute 就在头上(v1 单文件头连 messages 一起带着)。
async function readSessionRouteHead(id) {
  if (safeSessionId(id) === null) return null;
  const head = await readSessionHeadResilient(id);
  return head && typeof head === 'object' && !Array.isArray(head) ? head : null;
}
// 正文截断同款有界重试(文件系统短暂拒绝访问的 EPERM/EBUSY)。仍失败就如实返回 false:
// 调用方据此不交出 bodiesOk:true —— 否则下次快路径会接在没截掉的残留后面 append,把新行焊进
// 半行(整条会话随后被判损坏隔离),或让旧的未提交尾巴留在真消息前面、下次截断反而截掉真消息。
async function truncateSessionBody(file, len) {
  for (let attempt = 0; ; attempt++) {
    try { await fsp.truncate(file, len); return true; }
    catch (error) {
      const code = String((error && error.code) || '');
      if (code === 'ENOENT' || !SESSION_HEAD_TRANSIENT.has(code) || attempt >= bodies.SESSION_HEAD_READ_RETRIES) return false;
      await new Promise(resolve => setTimeout(resolve, 5 + attempt * 10));
    }
  }
}

// 117j 收尾（实证定位的一条真 bug，会【删数据】）：本函数下面两个动作都是破坏性的 ——
// 「未提交尾巴」物理截断正文、以及把头与正文一起隔离成 .corrupt。它们的判据是「头声明的行数 vs
// 正文实际行数」，而这两样是**先后两次**读进来的：先读头，再读两个正文。一次并发的 saveSession
// 完全可以落在这两次读之间，于是我们拿【旧头】去量【新正文】：
//   · 正文比旧头多 → 被当成「崩溃留下的未提交尾巴」物理截断，**真数据被删**；
//   · 反过来（旧正文 + 新头）→ 被当成「已提交数据丢失」，整条会话隔离成 .corrupt，**会话消失**。
// 实证（steward-drawer.e2e 的 E4b 约 1/3 概率红）：打点抓到 messages.ndjson 被截成 0 字节、而头仍
// 声明 1 条、随后整条会话被隔离；用户那一侧的表现是「答待决答不进去（会话不存在）」。真机上同样成立：
// 谁恰好在回合写盘的那一瞬触发一次 loadSession（打开会话、改元数据、投影重建都会），谁就中招。
// 修法：动手之前把头**再读一遍**。头变了 = 刚才那一眼已经旧了，重跑一次 load（有界一次），
// 不做任何破坏动作；头没变才说明两次读之间没有写者，判据才成立。
// ── perf(增量取):不读 provider 正文的装载视图 loadSession(id, 0, 0, SESSION_LOAD_OMIT_PROVIDER) ──────────────
// GET /api/sessions/:id?fromIndex=N&prefixStamp=S 只回 messages[N..] 与信封,从不回 providerHistory;修前它照样整份装载
// (两个正文都读、都解析,heavy 会话 provider 正文 8 MB)。这个视图只在【能证明结果与完整装载的 messages 逐字节相同】时
// 跳过 provider 正文,否则(包括任何一个前提拿不准)原样交给完整装载 —— 调用方拿到的就是一份完整会话。前提:
//   ① 本进程对这条会话的 provider 正文有记录、上次写/读成功(bodiesOk),且此刻没有写者在链上;
//   ② 盘上 provider 正文的文件戳(size|mtimeNs|ino)与记录相同,头声明的条数 = 记录的条数
//      (提交点语义:正文完整、没有未提交尾巴、没有撕裂尾行 —— 这正是完整装载在这一半上会确认的事);
//   ③ messages 正文读得出、没有坏行、没有撕裂尾行、条数与头声明相同(完整装载会动手截断/隔离/回退的情形一律让位);
//   ④ 读的这一段里本进程没有人落过盘(sessionDiskWriteSeq 不变);
//   ⑤ 装载后半段(normalize 补字段、残留 pending 叙事段的惰性清理)不需要回写 —— 要回写就让位给完整装载去写,
//      绝不拿一份没有 providerHistory 的对象去 saveSession(saveSession 见到本视图的对象直接拒绝)。
// 其余步骤(撤回代数自愈、内存覆盖表、changeSeq 水位、后台任务账本合并)与完整装载是同一段代码。
// 返回的对象上 providerHistory 是占位的 [](键序与完整装载相同),另挂一个不可枚举的 __providerHistoryOmitted =
// { count, dangling, body }:resumable 由 detectDanglingTurn 从 dangling/count 给出;body 是 messages 正文的字节视图
// (只在每一行都已证明是 canonical 时给出),sessionMessagesDelta 用它按字节算前缀戳。
// 唯一的信任点是 ② 的文件戳(与条件 GET 的 ETag 同一类判据):同 size、同 mtime、同 inode 的外部改写看不出来。
const SESSION_LOAD_OMIT_PROVIDER = 'omitProviderHistory';
function sessionOmittedProviderHistory(session) {
  return (session && session.__providerHistoryOmitted) || null;
}
function sessionProviderHistoryLength(session) {
  const omitted = sessionOmittedProviderHistory(session);
  if (omitted) return omitted.count;
  return session && Array.isArray(session.providerHistory) ? session.providerHistory.length : 0;
}
async function readSessionBodiesOmittingProvider(id, parsed, bp, writeSeqAtRead) {
  // Protected transcripts must verify the committed body hashes, including same-count rewrites.
  if (Object.hasOwn(parsed, 'providerHistoryRevision') || Object.hasOwn(parsed, 'providerHistoryCommit')) return null;
  const state = bodies.getSessionBodyState(id);
  const provRec = state && state.bodiesOk ? state.prov : null;
  if (!provRec || !provRec.stamp || !provRec.dangling || sessionWriteChains.has(id)) return null;
  if (!Number.isInteger(parsed.providerHistoryCount) || parsed.providerHistoryCount !== provRec.count) return null;
  if (await bodies.sessionBodyFileStamp(bp.provider) !== provRec.stamp) return null;
  const msg = await bodies.readSessionBodyFile(bp.messages);
  if (!msg || msg.corrupt || msg.unreadable || msg.tornAt != null) return null;
  if (Number.isInteger(parsed.messageCount) && msg.entries.length !== parsed.messageCount) return null;
  if (sessionDiskWriteSeqOf(id) !== writeSeqAtRead || sessionWriteChains.has(id)) return null;
  const cur = bodies.getSessionBodyState(id);
  if (!cur || cur.prov !== provRec || !cur.bodiesOk) return null;
  // 与完整装载同样把读到的 messages 正文交给状态表(同一拍、同一个「没有写者」判据)。
  const msgRec = bodies.sessionBodyRecordFromRead(msg, cur.msg);
  bodies.setSessionBodyState(id, { msg: msgRec, prov: provRec, bodiesOk: true });
  const body = msgRec.canonical ? { buf: msg.buf, lineEndBytes: msg.lineEndBytes, count: msg.lines.length } : null;
  return { messages: msg.entries, omitted: { count: provRec.count, dangling: provRec.dangling, body } };
}
async function loadSession(id, reloadDepth = 0, staleRetry = 0, view = null) {
  if (safeSessionId(id) === null) return null; // 不合形的 id 就是「没有这个会话」(sessionPath 会拒绝拼路径)
  const writeSeqAtRead = sessionDiskWriteSeqOf(id);
  let raw;
  // hunt2-P3:头读撞上瞬时锁(EBUSY/EPERM/EACCES)先有界重试,别把「一时读不到」答成「会话不存在」。
  for (let attempt = 0; ; attempt++) {
    try { raw = await fsp.readFile(sessionPath(id), 'utf8'); break; }
    catch (error) {
      const code = String((error && error.code) || '');
      if (code === 'ENOENT' || !bodies.SESSION_BODY_READ_TRANSIENT.has(code) || attempt >= bodies.SESSION_HEAD_READ_RETRIES) return null;
      await new Promise(resolve => setTimeout(resolve, 5 + attempt * 10));
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await fsp.rename(sessionPath(id), sessionPath(id) + '.corrupt').catch(() => {});
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null; // Never normalize a non-object head into a fresh empty session.
  if ((Object.hasOwn(parsed, 'providerHistoryRevision') || Object.hasOwn(parsed, 'providerHistoryCommit'))
      && parsed.storageVersion !== SESSION_STORAGE_VERSION) return null;
  let legacy = true;
  const omitView = view === SESSION_LOAD_OMIT_PROVIDER;
  const lite = omitView && parsed && parsed.storageVersion === SESSION_STORAGE_VERSION
    ? await readSessionBodiesOmittingProvider(id, parsed, sessionBodyPaths(id), writeSeqAtRead) : null;
  if (omitView && !lite) return loadSession(id, reloadDepth, staleRetry);   // 前提拿不准 → 完整装载(见视图头注)
  if (lite) {
    bodies.sessionBodyPerfStats.providerBodySkips++;
    parsed.messages = lite.messages;
    parsed.providerHistory = [];   // 占位:与完整装载同一个键位,normalize 不会因「缺数组」判 changed
    delete parsed.storageVersion;
    delete parsed.messageCount;
    delete parsed.providerHistoryCount;
    legacy = false;
  } else if (parsed && parsed.storageVersion === SESSION_STORAGE_VERSION) {
    const bp = sessionBodyPaths(id);
    let msg = await bodies.readSessionBodyFile(bp.messages);
    let prov = await bodies.readSessionBodyFile(bp.provider);
    // hunt2-P3:正文【在但读不出来】(重试过仍被锁/句柄耗尽)不是「正文丢了」—— 下面的判据会把它当缺失,
    // 走 v1bak 回退或整条隔离成 .corrupt。这一趟诚实地不给结果,盘上什么都不动,下次读自然恢复。
    const unreadable = b => !!(b && b.unreadable);
    if (unreadable(msg) || unreadable(prov)) {
      logEvent({ kind: 'session_body_unreadable', sessionId: id, code: String((unreadable(msg) ? msg : prov).code || '') });
      return null;
    }
    // 头是提交点:正文行数【少于】头声明 = 已提交数据丢失,与 corrupt 同级;【多于】头声明 = 崩溃于
    // 「append 完成、头写未完成」之间,多余行是未提交尾巴,物理截断(见下),不算损坏。
    const shortOf = (body, count) => Number.isInteger(count) && body && !body.corrupt && body.entries.length < count;
    const bodyBad = () => !msg || !prov || msg.corrupt || prov.corrupt
      || shortOf(msg, parsed.messageCount) || shortOf(prov, parsed.providerHistoryCount)
      || !bodies.sessionBodiesMatchCommit(parsed, msg, prov);
    const countsDiffer = () => (Number.isInteger(parsed.messageCount) && msg && !msg.corrupt && msg.entries.length !== parsed.messageCount)
      || (Number.isInteger(parsed.providerHistoryCount) && prov && !prov.corrupt && prov.entries.length !== parsed.providerHistoryCount);
    // 117j：只要接下来可能动手（截断或隔离），先确认「头还是刚才读的那一份」。用 updatedAt ＋ 两个
    // 计数当指纹：saveSession 每次落头都会推 updatedAt（nowIso），所以它变了就一定有写者插进来过。
    // （例外是装载回写 keepUpdatedAt：它们不推 updatedAt、不改两个计数，只补头上的默认字段。本进程内的任何写者
    //  —— 包括它们 —— 都由下面的 sessionDiskWriteSeqOf 判出来，那才是权威信号；updatedAt 与计数只是兜底。）
    // 读不到头（正被原子替换的那一瞬）同样按「别动手」处理 —— 破坏性动作绝不建立在一次可疑的读上。
    const torn = () => (msg && msg.tornAt != null) || (prov && prov.tornAt != null);
    if (bodyBad() || countsDiffer() || torn()) {   // 只有要动手(截断/隔离)时才需要确认没有写者
      // 先问最硬的那个信号：**本进程此刻正在给这条会话写盘吗**。saveSession 的 per-id 写链就是
      // 权威答案 —— 链在跑，说明「正文已落、头还没落」这个中间态是【预期内】的，不是崩溃残留。
      // 等它跑完再重读一次，头与正文自然对齐，一个字都不用删。
      // （只重读头是不够的：写链里正文先落、头后落，此刻重读拿到的仍是那份旧头，判据照样成立。
      //  实证——打点抓到 TRUNCATE from=1 to=0 紧跟着 QUARANTINE headMsg=1 body=0，会话就此消失。）
      const inFlight = sessionWriteChains.get(id);
      if (inFlight) {
        await inFlight.catch(() => {});
        if (reloadDepth >= 1) return null;
        return loadSession(id, reloadDepth + 1);
      }
      const again = await readSessionHeadResilient(id);
      const moved = !again
        || sessionDiskWriteSeqOf(id) !== writeSeqAtRead
        || String(again.updatedAt || '') !== String(parsed.updatedAt || '')
        || again.messageCount !== parsed.messageCount
        || again.providerHistoryCount !== parsed.providerHistoryCount;
      const commitMoved = JSON.stringify(again?.providerHistoryCommit) !== JSON.stringify(parsed.providerHistoryCommit)
        || again?.providerHistoryRevision !== parsed.providerHistoryRevision;
      if (moved || commitMoved) {
        if (reloadDepth >= 1) return null;   // 有界：连着两次都在写，这一趟就诚实地不给结果
        return loadSession(id, reloadDepth + 1);
      }
    }
    // .prevbody 快照(saveSession 慢路径重写前的旧正文)在场 + 正文坏/计数与头不符 = 上次慢路径中断
    // (崩溃于「正文重写、头未提交」之间)→ 恢复快照,与磁盘上的旧头重新配对。
    // 注意区分:头计数==正文行数时 prevbody 是「头已提交、清理未完成」的陈旧快照 → 不恢复,随下方清理删掉。
    const pm = bp.messages + '.prevbody', pp = bp.provider + '.prevbody';
    const hasPrev = await fsp.stat(pm).then(() => true).catch(() => false)
      && await fsp.stat(pp).then(() => true).catch(() => false);
    if (hasPrev && (bodyBad() || countsDiffer())) {
      if (Object.hasOwn(parsed, 'providerHistoryRevision') || Object.hasOwn(parsed, 'providerHistoryCommit')) {
        const [previousMessages, previousProvider] = await Promise.all([bodies.readSessionBodyFile(pm), bodies.readSessionBodyFile(pp)]);
        if (!bodies.sessionBodiesMatchCommit(parsed, previousMessages, previousProvider)) return null;
      }
      bodies.dropSessionBodyState(id);
      if (Object.hasOwn(parsed, 'providerHistoryRevision') || Object.hasOwn(parsed, 'providerHistoryCommit')) {
        // Keep both verified snapshots until both copies are restored. A partial
        // restore or process death must leave the complete recoverable pair.
        try { await fsp.copyFile(pm, bp.messages); await fsp.copyFile(pp, bp.provider); }
        catch { return null; }
      } else {
        await fsp.rename(pm, bp.messages).catch(() => {});
        await fsp.rename(pp, bp.provider).catch(() => {});
      }
      msg = await bodies.readSessionBodyFile(bp.messages);
      prov = await bodies.readSessionBodyFile(bp.provider);
      if (unreadable(msg) || unreadable(prov)) return null;   // hunt2-P3:同上,读不出来就不动手
    }
    if (bodyBad()) {
      // 磁盘正文已不可信 → 先作废进程内镜像,否则 save 的快路径会拿旧 hash 往坏正文上 append。
      bodies.dropSessionBodyState(id);
      // 正文缺失/损坏 → 迁移备份回退(v1 原文重走迁移,等价于回到迁移前一刻)。
      const bak = Object.hasOwn(parsed, 'providerHistoryRevision') || Object.hasOwn(parsed, 'providerHistoryCommit') ? null : await loadSessionV1Backup(id);
      if (bak) return bak;
      // 无备份可退:坏正文隔离(不删,留取证),头按损坏处理。
      for (const p of [bp.messages, bp.provider]) await fsp.rename(p, p + '.corrupt').catch(() => {});
      await fsp.rename(sessionPath(id), sessionPath(id) + '.corrupt').catch(() => {});
      return null;
    }
    // 撕裂尾行截断(从 bodies.readSessionBodyFile 挪到这里):到这一步已确认没有写者,半行是崩溃残留而非正在 append。
    let truncatedOk = true;   // 任何一刀没落地 → 盘上正文与内存不符,只许走全量重写(见 truncateSessionBody)
    for (const body of [msg, prov]) body.cut = false;   // 这一趟动过刀的正文,读时取的文件戳作废(见 sessionBodyState 头注)
    for (const [body, file] of [[msg, bp.messages], [prov, bp.provider]]) {
      if (body.tornAt != null) { body.cut = true; if (!await truncateSessionBody(file, body.tornAt)) truncatedOk = false; }
    }
    // 未提交尾巴截断:不物理截断的话,磁盘上多出的行会在下次快路径 append 后「复活」进会话。
    for (const [body, count, file] of [[msg, parsed.messageCount, bp.messages], [prov, parsed.providerHistoryCount, bp.provider]]) {
      if (Number.isInteger(count) && body.entries.length > count) {
        const cut = count > 0 ? body.lineEndBytes[count - 1] : 0;
        body.cut = true;
        if (!await truncateSessionBody(file, cut)) truncatedOk = false;
        body.entries.length = count; body.lines.length = count;
      }
    }
    parsed.messages = msg.entries;
    parsed.providerHistory = prov.entries;
    // 读完到这里期间有人落过盘 → 这份行记录已旧,交出去会让下一次快路径按旧前缀 append(重复行/丢行)。
    // 写者自己会把准确的状态放进来,这里什么都不放。
    if (!truncatedOk) bodies.setSessionBodyState(id, { msg: null, prov: null, bodiesOk: false });
    else if (sessionDiskWriteSeqOf(id) === writeSeqAtRead) {
      const prev = bodies.getSessionBodyState(id);
      // dangling 在这里同步算(交出去的 prov.entries 之后归调用方,可能被就地改)。
      bodies.setSessionBodyState(id, {
        msg: bodies.sessionBodyRecordFromRead(msg, prev && prev.msg, { stampOk: !msg.cut }),
        prov: bodies.sessionBodyRecordFromRead(prov, prev && prev.prov, { stampOk: !prov.cut, dangling: bodies.danglingTurnState(prov.entries.length, i => prov.entries[i]) }),
        bodiesOk: true,
      });
    }
    // v2 完整可读 → 迁移残留的 v1bak 与慢路径残留 prevbody 快照一并清掉(备份使命已完成;也防无界堆积)。
    await fsp.unlink(sessionPath(id) + '.v1bak').catch(() => {});
    await fsp.unlink(bp.messages + '.prevbody').catch(() => {});
    await fsp.unlink(bp.provider + '.prevbody').catch(() => {});
    delete parsed.storageVersion; // 运行时对象不携带存储标记(保持与 v1 同形),saveSession 落盘时重新加
    delete parsed.messageCount;        // 计数同理:落盘字段,运行时以真数组为准,带出只会是过期副本
    delete parsed.providerHistoryCount;
    legacy = false;
  }
  const { session, changed } = normalizeSession(parsed);
  if (session.id == null) session.id = id;
  // 107-F7b:读到的撤回代数低于进程内高水位 = 这次读恰好落在「撤回已抬水位、它那一存还没落盘」的窗口里
  // (saveSession 抬水位与入链是同一拍,所以此刻撤回那一存一定已经在写链里)。拿着这份旧副本出去的人,
  // 它之后的每一次 save 都会被代数闸丢掉 —— 对撤回【之后】才来读的人,这就是凭空丢数据。所以不交出去:
  // 等写链跑完再读一次。有界两次(staleRetry);reloadDepth 原样传递、不归零,与上面那道守卫的递归合起来
  // 仍然有界。两次之后仍低(只剩「头上压根没有这个字段、又不是经撤回写出来的」那类对象,例如 v1bak 回退)
  // 就照原样返回,由代数闸兜底。
  if ((Number(session.rewindGen) || 0) < (sessionRewindGenHighWater.get(id) || 0) && staleRetry < 2) {
    const inFlight = sessionWriteChains.get(id);
    if (inFlight) await inFlight.catch(() => {});
    return loadSession(id, reloadDepth, staleRetry + 1, view);
  }
  // 116-2a: 内存权威副本盖到装载结果上 —— 用户刚切、但因活回合而延后落盘的那一档,对读者必须立刻生效。
  // 覆盖表没有本会话条目(= 绝大多数情况,含全部存量会话)时这一行是零操作,不置 changed、不触发回写。
  metadata.applyOverrides(session);   // 117z-E2 提交①:桌面覆盖同款(见它的头注)
  // 71b: 惰性清理残留 pending 叙事段(见 healStalePendingSegments 头注)。竞态防护:活回合(activeChildren)
  // 或 dying turn 收尾窗口(turnSettlers,第69波 rewind 同款判据)内跳过 —— 此时磁盘 pending 可能是活段,
  // 且本会话的收尾 save 会整份重写正文,清理既多余又有互相覆盖风险;下次数 truly idle 的装载再清。
  let healed = false;
  if (!lifecycle.isActive(session.id)) {
    try { healed = healStalePendingSegments(session); } catch { healed = false; }
  }
  // 不读 provider 正文的视图(见 SESSION_LOAD_OMIT_PROVIDER 头注 ⑤):要回写就让位给完整装载,由它补齐、由它落盘。
  if (lite && (changed || healed)) return loadSession(id, reloadDepth, staleRetry);
  if (legacy) {
    // 懒迁移:标记后无条件 save —— 老会话首次被真正使用时一次性转 v2,之后读写全走新格式。
    Object.defineProperty(session, '__v1bakPending', { value: true, enumerable: false, configurable: true, writable: true });
    await saveSession(session, { writer: 'load_migrate', ifUnwrittenSince: writeSeqAtRead, keepUpdatedAt: true }).catch(() => {});
  } else if (changed || healed) await saveSession(session, { writer: 'load_normalize', ifUnwrittenSince: writeSeqAtRead, keepUpdatedAt: true }).catch(() => {});
  // 75a-2b (S3): seed the in-memory changeSeq high-water from the loaded mission, so bumpMissionChangeSeq
  // increments from the correct base and saveSession's max-preserve works. Reset on crash; re-seeded here.
  if (session.mission && typeof session.mission === 'object') {
    const sid = String(session.id);
    // A load may interleave with an Intervention append already queued in this lifecycle. Seeding must
    // never lower that in-memory high-water mark to the (briefly older) head-file value.
    missionChanges.seedRevision(sid, session.mission.changeSeq);
  }
  // 账本合并只往 messages 末尾追加(11 的实现:按 backgroundJobId 去重后 push),从不改已有条目 ——
  // 增量取的字节戳(sessionMessagesDelta 的 body)依赖这一点:盘上那 count 条之后的才逐条序列化。
  lifecycle.mergeBackgroundJobs(session);
  if (lite) Object.defineProperty(session, '__providerHistoryOmitted', { value: lite.omitted, enumerable: false, configurable: true });
  return session;
}

// 迁移备份回退:<id>.json.v1bak 是 legacy 单文件原样拷贝(写入侧 COPYFILE_EXCL 保证它永不被覆盖)。
// 读出后走正常 legacy 路径(重打迁移标记,save 时 v1bak 已存在 → EXCL 失败被吞,内容不变 —— 幂等)。
// 防线:v1bak 里若是 v2 头(带 storageVersion 且没有 messages 数组),说明备份已被污染/根本不是备份,
// 宁可回退失败走损坏隔离,也绝不拿一个空正文重建会话(那等于丢历史)。
async function loadSessionV1Backup(id) {
  let raw;
  try { raw = await fsp.readFile(sessionPath(id) + '.v1bak', 'utf8'); }
  catch { return null; }
  const parsed = safeJsonParse(raw, null);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
  if (parsed.storageVersion === SESSION_STORAGE_VERSION) return null;
  const { session } = normalizeSession(parsed);
  if (session.id == null) session.id = id;
  Object.defineProperty(session, '__v1bakPending', { value: true, enumerable: false, configurable: true, writable: true });
  await saveSession(session, { writer: 'load_v1bak_restore', keepUpdatedAt: true }).catch(() => {});
  return session;
}

// Atomic write: serialize to <id>.json.tmp then rename over the target. rename is atomic within a
// volume, so a crash mid-write leaves the previous good file intact instead of a truncated one.
// v1.9 存储 v2(save 侧):头(小)仍 tmp+rename 原子重写;两个正文数组优先 append-only 快路径
// (前缀逐行 hash 比对,见文件头部「会话存储 v2」块注释),任何前缀变化/状态缺失/上次失败 → 全量重写正文。
// 122-§2.4:opts.mergeMissionFromDisk —— 落盘前在【写链内】重读磁盘头,把路由刚写的 mission 合并进来
// (见 mergeMissionBeforeSave)。为什么必须在链内:回合起跑那一存与 POST /api/mission 的那一存是同一条
// 写链上的两个排队者,「链外先 loadSession 再 saveSession」中间还有若干 await,路由的写可以恰好排到两者
// 之间 —— 实测 0 ms 时点 5 轮里就有 1 轮这样丢账本。链内重读则:排在我前面的写一定已落盘(读得到),
// 排在我后面的写一定后落盘(它自己就是权威),两个方向都不丢。只有回合引擎的起跑存传这个旗子。
// 107-F7b:撤回代数闸(见 sessionRewindGenHighWater 头注)。三个旗子:
//   · opts.rewindBump —— 只有 rewindSession 传:在【入写链的同一拍】(下面 ensureDirs 之后那一整段同步代码)
//     把本对象的 rewindGen 加一并抬高水位;前提是本对象自己不低于水位(低于 = 它本身就是另一次撤回之前的
//     旧副本,不抬,按陈旧丢)。与入链同一拍是有意的:任何人一旦看见抬高了的水位,撤回那一存就一定已经
//     排在写链里,loadSession 的自愈「等写链跑完再读」才有东西可等。
//     这一存自己落盘失败 → 链内把水位退回原值(否则盘上仍是旧代数,之后新读的每一份都会被当成陈旧而被丢)。
//   · opts.throwIfStale —— 这次写被闸丢掉时抛 code:'SESSION_STALE_SAVE'(默认静默丢、记日志、照常返回)。
//     要知道「我的改动没落上」的调用方传它:updateSessionMeta 据此在新读的副本上重放补丁;rewindSession
//     据此如实回「被更新的撤回顶掉」,不说 ok:true。
//   · opts.writer —— 只进丢弃日志,事后对账「是谁拿着旧副本来写」。
//   · opts.shrinkBody —— 有意把消息截成原来的前缀(管家归档)。不传时,消息是盘上正文严格前缀的写被当成旧副本、先补齐尾巴再写。
// 撤回那一存抬代数(同步;只由 saveSession 在入链那一拍调)。返回 { gen, prevHighWater } 供落盘失败时退水位;
// 返回 null = 没资格抬:撤回自己手里那份也得是「最新一代」—— 它若是在另一次撤回【之前】读出来的(两次撤回
// 交错:这一次先读、另一次先落盘),它算出来的截断建在旧正文上,落下去会把另一次撤回删掉的消息带回来。
// 这时不抬,saveSession 的闸按陈旧把它丢掉,rewindSession 如实回 rewind_superseded。
function claimRewindGeneration(session) {
  const id = session.id;
  const prevHighWater = sessionRewindGenHighWater.get(id) || 0;
  const objectGen = Number(session.rewindGen) || 0;
  if (objectGen < prevHighWater) return null;
  const gen = objectGen + 1;
  session.rewindGen = gen;
  sessionRewindGenHighWater.set(id, gen);
  return { gen, prevHighWater };
}
async function saveSession(session, opts) {
  // 不读 provider 正文的装载视图(SESSION_LOAD_OMIT_PROVIDER)给出的对象 providerHistory 是占位的 [] —— 落盘就是把真历史清空。
  if (sessionOmittedProviderHistory(session)) throw new Error('refusing to save a session loaded without its provider history');
  await ensureDirs();
  lifecycle.mergeBackgroundJobs(session);
  // opts.keepUpdatedAt —— 只有装载回写(补默认字段 load_normalize / 惰性清理残留段 / 懒迁移 load_migrate /
  // v1bak 回退)传:它们不是这条会话的新活动,不许推 updatedAt。修前「打开看一眼」就把会话顶到列表最上面
  // (列表、任务行、搜索命中都按 updatedAt 排)。头上没有可用的旧值才照常取现在。真编辑一律不传,照旧推。
  const keepUpdatedAt = opts && opts.keepUpdatedAt === true && typeof session.updatedAt === 'string'
    && Number.isFinite(Date.parse(session.updatedAt));
  if (!keepUpdatedAt) session.updatedAt = nowIso();
  const id = session.id;
  // 107-F7b:从这里到 sessionWriteChains.set 是一段同步代码,抬水位与入链因此是原子的。
  const rewindBump = opts && opts.rewindBump === true ? claimRewindGeneration(session) : null;
  const saveGen = Number(session.rewindGen) || 0;   // 入链这一拍的代数
  // A model switch may be saved while an old turn still owns an earlier in-memory session object. Preserve
  // the newer UI route across that turn's later save instead of silently reverting the next-turn choice.
  metadata.applyRouteOverride(session);
  // 116-2a: 权限档同款陈旧-save 守卫 —— 活回合手里那份副本没有用户刚切的档,它的收尾 save 会把会话头
  // 写回「没有该字段」的样子。在这里重新盖一次,谁后写都不会丢(见 sessionPermissionModeOverrides 头注)。
  metadata.applyOverrides(session);   // 117z-E2 提交①:桌面覆盖同款(见它的头注)
  const finalPath = sessionPath(id);
  let messages = Array.isArray(session.messages) ? session.messages : [];
  let providerHistory = Array.isArray(session.providerHistory) ? session.providerHistory : [];
  let protectedHead = null, providerRevision = null, protectedCommit = null;
  // 头 = 运行时对象剥掉两个大数组 + 存储标记 + 计数(计数供 listSessions 兜底扫描/sessionMeta 不读正文)。
  const buildHeadPayload = () => {
    if (protectedHead) return JSON.stringify({ ...protectedHead,
      messageCount: messages.length, providerHistoryCount: providerHistory.length,
      providerHistoryRevision: providerRevision, providerHistoryCommit: protectedCommit }, null, 2);
    const head = { ...session };
    const recentUserRequest = metadata.sessionRecentUserRequest(session);
    if (recentUserRequest) head.recentUserRequest = recentUserRequest;
    else delete head.recentUserRequest;
    delete head.messages;
    delete head.providerHistory;
    head.storageVersion = SESSION_STORAGE_VERSION;
    head.messageCount = messages.length;
    head.providerHistoryCount = providerHistory.length;
    // 75a-2b (S3): preserve disk-side mission.changeSeq bumps (intervention transitions write the head
    // directly via bumpMissionChangeSeq). Take max with the in-memory high-water so this save's in-memory
    // session object doesn't clobber an intervention's bump. No auto-bump here (bumps are explicit).
    if (head.mission && typeof head.mission === 'object') {
      const hw = missionChanges.revisionOf(id);
      const cur = Number(head.mission.changeSeq) || 0;
      if (hw > cur) head.mission.changeSeq = hw;
    }
    return JSON.stringify(head, null, 2);
  };
  // Serialize the payload and snapshot the 7 index fields in the SAME synchronous tick, so the background index
  // write reflects EXACTLY what we persist here (no drift if `session` is mutated during the awaits below).
  // 122-§2.4:mergeMissionFromDisk 命中时,链内合并后按合并结果【重算】这两份快照,两者仍然同一拍取样。
  let payload = buildHeadPayload();
  let metaSnapshot = metadata.sessionMeta(session);
  // 第25波 25.1: 写体收编进 atomicWriteJson(唯一 tmp 名防并发互踩 + rename 瞬时锁重试 + 失败清 tmp)。
  // 对抗轮修: 同会话并发写者(回合保存 + 节流 flush + updateSessionMeta)此前不串行 —— 加了 rename 重试后,
  // 旧载荷可在 ~680ms 退避后覆写掉新载荷(stale-overwrites-fresh 窗口从 writeFile 粒度拉宽到 680ms)。
  // 按 saveAgentRun 同款 per-id 写链串行化:链内按提交顺序落盘,窗口归零;链错误吞掉(下一写自愈)。
  // v2:整个「正文 append/重写 + 头写」都在链内 —— 进程内状态表与磁盘正文的一致性靠同一条链保证。
  const prevWrite = sessionWriteChains.get(id) || Promise.resolve();
  let preserveRewindOnFailure = false;
  const writeSessionToDisk = async () => {
    // A revision belongs to one body/head snapshot. In protected sessions take all of
    // them together INSIDE the write chain, after earlier same-object saves committed.
    // Stale copies must reload and reapply their explicit edit; never merge old heads.
    let diskHead = null, diskHeadText = null, headExists = false;
    try { diskHeadText = await fsp.readFile(finalPath, 'utf8'); diskHead = JSON.parse(diskHeadText); headExists = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (headExists && (!diskHead || typeof diskHead !== 'object' || Array.isArray(diskHead))) {
      throw Object.assign(new Error('session head is not an object'), { code: 'SESSION_HEAD_UNREADABLE' });
    }
    const stamped = Object.hasOwn(session, 'providerHistoryRevision') || Object.hasOwn(session, 'providerHistoryCommit');
    const diskStamped = headExists && (Object.hasOwn(diskHead, 'providerHistoryRevision') || Object.hasOwn(diskHead, 'providerHistoryCommit'));
    const protectedBody = lifecycle.protectedHistoryEnabled() || stamped || diskStamped;
    if (protectedBody) {
      const validRevision = value => Number.isSafeInteger(value) && value >= 0;
      const incomingRevision = stamped ? session.providerHistoryRevision : 0;
      const currentRevision = diskStamped ? diskHead.providerHistoryRevision : 0;
      if (stamped && !headExists || !validRevision(incomingRevision) || !validRevision(currentRevision)
          || incomingRevision !== currentRevision || stamped !== diskStamped
          || diskStamped && diskHead.storageVersion !== SESSION_STORAGE_VERSION
          || stamped && (!bodies.sessionBodyCommitValid(session) || !bodies.sessionBodyCommitValid(diskHead)
            || JSON.stringify(session.providerHistoryCommit) !== JSON.stringify(diskHead.providerHistoryCommit))
          || (Number(session.rewindGen) || 0) !== saveGen
          || diskHead && ((Number(diskHead.turnSeq) || 0) > (Number(session.turnSeq) || 0)
            || (Number(diskHead.rewindGen) || 0) > saveGen)) {
        throw Object.assign(new Error('session provider history changed; reload before applying this edit'), { code: 'SESSION_PROVIDER_HISTORY_CONFLICT' });
      }
      providerRevision = currentRevision;
      // Validate the committed body on both append and rewrite paths. A cached
      // append plan cannot bless a corrupted on-disk head/body as a new commit.
      if (headExists && diskHead.storageVersion === SESSION_STORAGE_VERSION) {
        const [committedMessages, committedProvider] = await Promise.all([
          bodies.readSessionBodyFile(sessionBodyPaths(id).messages), bodies.readSessionBodyFile(sessionBodyPaths(id).provider)]);
        if (!committedMessages || !committedProvider || committedMessages.corrupt || committedProvider.corrupt
            || committedMessages.unreadable || committedProvider.unreadable
            || committedMessages.entries.length < diskHead.messageCount
            || committedProvider.entries.length < diskHead.providerHistoryCount
            || !bodies.sessionBodiesMatchCommit(diskHead, committedMessages, committedProvider)) {
          throw Object.assign(new Error('committed session body must be recovered before saving'), { code: 'SESSION_BODY_UNVERIFIED' });
        }
        // An unchanged stamped head plus its verified byte prefixes identifies an
        // uncommitted append tail. Recover it inside this write chain before planning
        // the next save, including a stopped turn's final pairing after an IO error.
        for (const [body, count, file] of [[committedMessages, diskHead.messageCount, sessionBodyPaths(id).messages],
          [committedProvider, diskHead.providerHistoryCount, sessionBodyPaths(id).provider]]) {
          if (body.entries.length !== count || body.tornAt != null) {
            if (!diskStamped || !await truncateSessionBody(file, count ? body.lineEndBytes[count - 1] : 0)) {
              throw Object.assign(new Error('uncommitted session tail could not be recovered'), { code: 'SESSION_BODY_UNVERIFIED' });
            }
            bodies.dropSessionBodyState(id);
          }
        }
      }
    }
    // 122-§2.4:链内落盘前合并 mission(见本函数头注与 mergeMissionBeforeSave)。只读【头文件】就够 ——
    // mission/kind 都在头上;读不到/解析不了(首存、损坏)一律当「磁盘没有账本」,与不传旗子逐字节等价。
    if (opts && opts.mergeMissionFromDisk) {
      let onDiskHead = null;
      try { onDiskHead = JSON.parse(await fsp.readFile(finalPath, 'utf8')); } catch { onDiskHead = null; }
      if (onDiskHead && typeof onDiskHead === 'object' && mergeMissionBeforeSave(session, onDiskHead)) {
        payload = buildHeadPayload();
        metaSnapshot = metadata.sessionMeta(session);
      }
    }
    if (protectedBody) {
      // Re-read the LIVE object's arrays, revision and head in one synchronous section;
      // then sever every array/entry reference before doing further asynchronous IO.
      if ((Object.hasOwn(session, 'providerHistoryRevision') || Object.hasOwn(session, 'providerHistoryCommit')) !== stamped
          || (stamped ? session.providerHistoryRevision : 0) !== providerRevision
          || stamped && (!bodies.sessionBodyCommitValid(session)
            || JSON.stringify(session.providerHistoryCommit) !== JSON.stringify(diskHead.providerHistoryCommit))
          || (Number(session.rewindGen) || 0) !== saveGen) {
        throw Object.assign(new Error('session changed while preparing its protected snapshot'), { code: 'SESSION_PROVIDER_HISTORY_CONFLICT' });
      }
      messages = Array.isArray(session.messages) ? session.messages : [];
      providerHistory = Array.isArray(session.providerHistory) ? session.providerHistory : [];
      const msgSnapshot = bodies.serializeSessionBody(messages), provSnapshot = bodies.serializeSessionBody(providerHistory);
      if (!msgSnapshot || !provSnapshot) throw new Error('session body not serializable');
      messages = msgSnapshot.map(line => JSON.parse(line));
      providerHistory = provSnapshot.map(line => JSON.parse(line));
      protectedHead = JSON.parse(buildHeadPayload());
      payload = buildHeadPayload(); metaSnapshot = metadata.sessionMeta(JSON.parse(payload));
    }
    const bp = sessionBodyPaths(id);
    // 懒迁移:legacy 单文件先原样备份 v1bak。必须 COPYFILE_EXCL(已存在则失败被吞)—— v1bak 回退
    // 恢复路径也会走到这里,若允许覆盖会把「 pristine legacy 备份」冲成 v2 头,备份使命直接报废。
    if (session.__v1bakPending === true) {
      await fsp.copyFile(finalPath, finalPath + '.v1bak', fs.constants.COPYFILE_EXCL).catch(() => {});
      session.__v1bakPending = false;
    }
    // 记录缺失(条目上限淘汰过 / 重启后没装载就存)→ 先按盘上已提交的内容重建,旧副本补齐与快路径照常可用。
    const state = bodies.getSessionBodyState(id) || await recoverSessionBodyState(id, bp);
    // 旧副本补齐：调用方手里的消息是盘上正文的【严格前缀】（更短、逐行相同）= 它装载之后别的写者又追加过，
    // 它自己并没有删消息（有意删的只有撤回 rewindBump 与管家归档 opts.shrinkBody）。以前这里走慢路径，用旧数组
    // 整份重写 —— 别人刚追加的消息全丢。现在先把盘上多出来的尾巴补进它的数组再写：两边的改动都留下。
    if (!protectedBody && state && state.bodiesOk && !rewindBump && !(opts && opts.shrinkBody) && await bodies.rebaseStaleSessionBody(id, bp, state, messages, providerHistory)) {
      payload = buildHeadPayload();
      metaSnapshot = metadata.sessionMeta(protectedBody ? JSON.parse(payload) : session);
    }
    const msgPlan = state && state.bodiesOk ? bodies.planSessionBodyAppend(messages, state.msg) : null;
    const provPlan = state && state.bodiesOk ? bodies.planSessionBodyAppend(providerHistory, state.prov) : null;
    if (protectedBody) {
      if (!headExists || !msgPlan || msgPlan.appendLines.length || !provPlan || provPlan.appendLines.length) {
        if (providerRevision === Number.MAX_SAFE_INTEGER) throw Object.assign(new Error('provider history revision capacity exhausted'), { code: 'SESSION_PROVIDER_HISTORY_CAPACITY' });
        providerRevision += 1;
      }
      protectedCommit = { schema: 1, revision: providerRevision,
        messagesSha256: bodies.sessionBodyDigest(bodies.serializeSessionBody(messages)), providerSha256: bodies.sessionBodyDigest(bodies.serializeSessionBody(providerHistory)) };
      payload = buildHeadPayload();
      metaSnapshot = metadata.sessionMeta(JSON.parse(payload));
    }
    let nextMsgLines, nextProvLines, protectedRewrite = false;
    if (msgPlan && provPlan) {
      // 快路径:只 append 增量行(0 增量 = 不动正文文件,仅更新头)。
      if (msgPlan.appendLines.length) await fsp.appendFile(bp.messages, msgPlan.appendLines.join('\n') + '\n', 'utf8');
      if (provPlan.appendLines.length) await fsp.appendFile(bp.provider, provPlan.appendLines.join('\n') + '\n', 'utf8');
      nextMsgLines = msgPlan.allLines;
      nextProvLines = provPlan.allLines;
    } else {
      // 慢路径:全量重写两个正文。【崩溃窗口设防】重写前把旧正文快照为 .prevbody(EXCL:已有快照不覆盖
      // —— 在场快照必属「上一个未干净完成的慢路径」,其配对的头更老,覆盖会把一致态快照冲成未提交内容)。
      // 收缩型重写(rewind/compaction 后行数变少)若崩溃于「正文已重写、头未提交」之间,旧头计数 > 新正文
      // 行数,读取侧本会把会话判 corrupt;有 .prevbody 即可回滚到崩溃前的一致态(loadSession 恢复,见下)。
      const msgSer = bodies.serializeSessionBody(messages);
      const provSer = bodies.serializeSessionBody(providerHistory);
      if (!msgSer || !provSer) throw new Error('session body not serializable');
      if (protectedBody && headExists) {
        const [currentMessages, currentProvider] = await Promise.all([bodies.readSessionBodyFile(bp.messages), bodies.readSessionBodyFile(bp.provider)]);
        if (diskHead.storageVersion === SESSION_STORAGE_VERSION && (!currentMessages || !currentProvider
            || currentMessages.corrupt || currentProvider.corrupt || currentMessages.unreadable || currentProvider.unreadable
            || currentMessages.entries.length !== diskHead.messageCount || currentProvider.entries.length !== diskHead.providerHistoryCount)) {
          throw Object.assign(new Error('session bodies must be recovered before rewriting'), { code: 'SESSION_BODY_UNVERIFIED' });
        }
        if (Object.hasOwn(diskHead, 'providerHistoryCommit') && !bodies.sessionBodiesMatchCommit(diskHead, currentMessages, currentProvider)) {
          throw Object.assign(new Error('committed session body must be recovered before rewriting'), { code: 'SESSION_BODY_UNVERIFIED' });
        }
        // A verified current body makes any previous snapshot stale. Never use an older
        // EXCL snapshot as rollback for this new rewrite if prior cleanup had failed.
        await fsp.unlink(bp.messages + '.prevbody').catch(error => { if (error.code !== 'ENOENT') throw error; });
        await fsp.unlink(bp.provider + '.prevbody').catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      if (protectedBody && headExists && diskHead.storageVersion === SESSION_STORAGE_VERSION) {
        await fsp.copyFile(bp.messages, bp.messages + '.prevbody', fs.constants.COPYFILE_EXCL);
        await fsp.copyFile(bp.provider, bp.provider + '.prevbody', fs.constants.COPYFILE_EXCL);
      } else {
        await fsp.copyFile(bp.messages, bp.messages + '.prevbody', fs.constants.COPYFILE_EXCL).catch(() => {});
        await fsp.copyFile(bp.provider, bp.provider + '.prevbody', fs.constants.COPYFILE_EXCL).catch(() => {});
      }
      protectedRewrite = protectedBody;
      try {
        await atomicWriteJson(bp.messages, bodies.sessionBodyText(msgSer));
        await atomicWriteJson(bp.provider, bodies.sessionBodyText(provSer));
      } catch (werr) {
        // 进程内写失败(非崩溃)→ 立即回滚快照,磁盘回到重写前的一致态;bodiesOk=false 由外层标。
        if (protectedBody) {
          await fsp.copyFile(bp.messages + '.prevbody', bp.messages).catch(() => {});
          await fsp.copyFile(bp.provider + '.prevbody', bp.provider).catch(() => {});
        } else {
          await fsp.rename(bp.messages + '.prevbody', bp.messages).catch(() => {});
          await fsp.rename(bp.provider + '.prevbody', bp.provider).catch(() => {});
        }
        throw werr;
      }
      nextMsgLines = msgSer;
      nextProvLines = provSer;
    }
    // 头最后写:头指向的正文状态必须先于头落盘(头=「正文有效」的声明)。
    // Once publication is attempted, only a confirmed unchanged old head permits
    // rolling the rewind watermark back. Lost acknowledgements may have committed.
    if (protectedBody) preserveRewindOnFailure = true;
    try { await atomicWriteJson(finalPath, payload); }
    catch (error) {
      let published = null;
      if (protectedBody) { try { published = await fsp.readFile(finalPath, 'utf8'); } catch { /* unknown commit: preserve both bodies and snapshots */ } }
      if (protectedBody && published === payload) {
        session.providerHistoryRevision = providerRevision; session.providerHistoryCommit = protectedCommit;
      } else if (protectedBody && published === diskHeadText) {
        preserveRewindOnFailure = false;
        if (protectedRewrite) {
          await fsp.copyFile(bp.messages + '.prevbody', bp.messages).catch(() => {});
          await fsp.copyFile(bp.provider + '.prevbody', bp.provider).catch(() => {});
        }
      }
      throw error;
    }
    // The head is the commit point. Cleanup/stat failures must not roll back this fact.
    if (protectedBody) {
      session.providerHistoryRevision = providerRevision;
      session.providerHistoryCommit = protectedCommit;
    }
    // 头已提交 → prevbody 快照使命完成(崩溃于清理前也无妨:下次读取按「头计数==正文行数」判其为陈旧快照,
    // 顺带清除,见 loadSession)。
    await fsp.unlink(bp.messages + '.prevbody').catch(() => {});
    await fsp.unlink(bp.provider + '.prevbody').catch(() => {});
    // 刚写下的行就是盘上的行(canonical);文件戳在写完之后取(链内,没有别的写者)。
    const [msgStamp, provStamp] = await Promise.all([bodies.sessionBodyFileStamp(bp.messages), bodies.sessionBodyFileStamp(bp.provider)]);
    bodies.setSessionBodyState(id, {
      msg: bodies.sessionBodyRecord(nextMsgLines, { stamp: msgStamp, canonical: true }),
      prov: bodies.sessionBodyRecord(nextProvLines, { stamp: provStamp, canonical: true, dangling: bodies.sessionBodyDanglingFromLines(nextProvLines) }),
      bodiesOk: true,
    });
  };
  const thisWrite = prevWrite.catch(() => {}).then(async () => {
    // Compare the caller's captured owner inside the write chain: two admitted drivers can have
    // prepared the same turnSeq. Cancellation alone does not reject the current driver's stopped
    // final save; only replacement/removal of that owner makes this snapshot obsolete.
    if (opts && opts.executionOwner !== undefined && (!lifecycle.ownsExecution(id, opts.executionOwner))) {
      logEvent({ kind: 'session_superseded_execution_save_dropped', sessionId: id,
        turnSeq: Number(session.turnSeq) || 0, writer: String(opts.writer || '') });
      return { dropped: true, supersededTurn: true, executionSuperseded: true };
    }
    // hunt2-P2:删除墓碑闸。同撤回代数闸,必须在【链内】看:删除可能发生在这次 save 入链之后、执行之前
    // (被停回合的收尾存正是这么排的)。删除之前就存在的会话对象一律不许再落盘(见 sessionDeleteTombstones 头注)。
    if (lifecycle.isTombstoned(session)) {
      logEvent({ kind: 'session_deleted_save_dropped', sessionId: id, writer: String((opts && opts.writer) || ''), messageCount: messages.length });
      return { dropped: true, deleted: true };
    }
    // 107-F7b:撤回代数闸。必须在【链内】比:高水位可能在这次写入链之后、执行之前才被抬高(撤回那一存
    // 排在我后面入链、却抬水位在我执行之前)。对象代数低于高水位 = 撤回之前的快照,整次写丢弃 ——
    // 正文与头都不写、不动 sessionBodyState(它仍如实描述盘上的正文),下面的索引/投影刷新也一并跳过。
    const highWater = sessionRewindGenHighWater.get(id) || 0;
    if (saveGen < highWater) {
      logEvent({
        kind: 'session_stale_save_dropped', sessionId: id, staleGen: saveGen, highWater,
        messageCount: messages.length, writer: String((opts && opts.writer) || ''),
      });
      return { dropped: true, staleGen: saveGen, highWater };
    }
    // 回合代数闸(opts.dropIfTurnSuperseded / throwIfTurnSuperseded,只有回合自己的存盘带):盘上的 turnSeq 已经
    // 比这份对象的大 = 这个回合被一个更新的回合顶替过(旧回合卡在不理会中止的工具里,新回合先跑完)。旧回合手里
    // 那份对象的正文不含新回合的消息,照写就把新回合整段盖掉(messages 与 providerHistory 都回到旧样子)。
    // 与撤回代数闸同理必须在【链内】比:新回合起跑那一存可能排在我入链之后、执行之前。只读头文件(turnSeq 在头上);
    // 读不到/解析不了(首存、损坏)一律放行,与不带旗子逐字节等价。
    if (opts && (opts.dropIfTurnSuperseded || opts.throwIfTurnSuperseded)) {
      let diskTurnSeq = 0;
      try { diskTurnSeq = Number(JSON.parse(await fsp.readFile(finalPath, 'utf8')).turnSeq) || 0; } catch { diskTurnSeq = 0; }
      if (diskTurnSeq > (Number(session.turnSeq) || 0)) {
        logEvent({
          kind: 'session_superseded_turn_save_dropped', sessionId: id, turnSeq: Number(session.turnSeq) || 0, diskTurnSeq,
          messageCount: messages.length, writer: String((opts && opts.writer) || ''),
        });
        return { dropped: true, supersededTurn: true, diskTurnSeq };
      }
    }
    // 装载回写(补默认字段/懒迁移)只在「装载那一眼之后没人写过」时才落:否则它拿的是旧副本,会把刚落盘的
    // 消息整份盖回去。比较在链内做 —— 进程内所有写者都串在这条链上,这里看到的计数就是权威答案。
    if (opts && Number.isInteger(opts.ifUnwrittenSince) && sessionDiskWriteSeqOf(id) !== opts.ifUnwrittenSince) {
      logEvent({ kind: 'session_superseded_save_dropped', sessionId: id, writer: String(opts.writer || ''), messageCount: messages.length });
      return { dropped: true, superseded: true };
    }
    bumpSessionDiskWriteSeq(id);
    try { await writeSessionToDisk(); }
    catch (werr) {
      // 撤回那一存自己没落上:盘上仍是旧代数,把水位退回去(只退自己抬的那一格;期间又有更新的撤回
      // 抬过就不动)。在链内退、先于这条链 reject —— 等这条链的 loadSession 自愈醒来时水位已经对了。
      if (rewindBump && !preserveRewindOnFailure && sessionRewindGenHighWater.get(id) === rewindBump.gen) {
        if (rewindBump.prevHighWater > 0) sessionRewindGenHighWater.set(id, rewindBump.prevHighWater);
        else sessionRewindGenHighWater.delete(id);
      }
      throw werr;
    } finally { bumpSessionDiskWriteSeq(id); }   // 落盘前后各一次:读在写的任何一段都能察觉
    return null;
  });
  sessionWriteChains.set(id, thisWrite);
  let dropped = null;
  try { dropped = await thisWrite; }
  catch (e) {
    // 正文/头任何一步失败:标 bodiesOk=false(下次 save 全量重写自愈),再把错误抛给调用方(与旧语义一致:
    // save 失败对调用方可见,回合层自会 .catch)。
    bodies.setSessionBodyState(id, { msg: null, prov: null, bodiesOk: false });
    throw e;
  }
  finally { if (sessionWriteChains.get(id) === thisWrite) sessionWriteChains.delete(id); }
  if (dropped) {
    // Execution barriers must distinguish a committed snapshot from a legacy best-effort return.
    // Other callers retain their existing handling of intentionally discarded stale/deleted saves.
    if (opts && opts.requirePersisted === true) {
      throw Object.assign(new Error('session save was not committed; execution must not continue'), {
        code: 'SESSION_SAVE_NOT_COMMITTED',
        reason: dropped.deleted ? 'deleted' : dropped.executionSuperseded ? 'execution_superseded'
          : dropped.supersededTurn ? 'turn_superseded' : 'stale',
      });
    }
    // 107-F7b:被闸丢掉的写。默认静默(日志已落):垂死回合的收尾存、它的中途存都走这里,它们本来就该丢。
    // hunt2-P2:墓碑丢掉的写同样静默 —— 会话已经没了,不是「撤回之前的旧副本」,不抛 SESSION_STALE_SAVE。
    if (dropped.supersededTurn) {
      if (opts && opts.throwIfTurnSuperseded) {
        throw Object.assign(new Error('stale turn save dropped: a newer turn already ran on this session'), {
          code: 'SESSION_TURN_SUPERSEDED', turnSeq: Number(session.turnSeq) || 0, diskTurnSeq: dropped.diskTurnSeq,
        });
      }
      return session;
    }
    if (opts && opts.throwIfStale && !dropped.deleted) {
      throw Object.assign(new Error('stale session save dropped: this copy was loaded before a rewind'), {
        code: 'SESSION_STALE_SAVE', staleGen: dropped.staleGen, highWater: dropped.highWater,
      });
    }
    return session;
  }
  // PF2: queue the sidebar metadata index update (cheap sync Map.set; the write is debounced + coalesced). The
  // index is only a cache and listSessions falls back to a full file scan whenever its id-set drifts from disk.
  metadata.scheduleIndexUpdate(id, metaSnapshot);
  events.emit('projection.invalidated', { sessionId: id, reason: 'source' }); // 75c: session head/body facts changed; rebuild this Mission slice lazily
  // 128f-⑫:会话头每落一次盘就「碰」一下推送层;那边只在这一行看得见的东西变了才真推(13r thread.touched 头注)。
  // 停自动推进、回退、管家接手、预算熔断……这些写口不必各自再记得派一发。
  events.emit('thread.touched', { sessionId: id });
  // v1.9 P-B: 引擎转录白名单账本(仅记录本工作台 spawn 过的 claudeSessionId;GC 只清「账本内 + 无活会话
  // 引用 + 超保留期」三者同时成立的转录,绝不碰用户自己 Claude Code 的转录)。fire-and-forget,账本写失败
  // 不影响会话保存(大不了 GC 永远不碰这条转录 —— 保守方向)。
  if (typeof session.claudeSessionId === 'string' && session.claudeSessionId) {
    events.emit('session.transcript.observed', { claudeSessionId: session.claudeSessionId, cwd: session.cwd });
  }
  return session;
}

return { invalidateReads: bumpSessionDiskWriteSeq, loadSession, saveSession, readSessionHeadResilient, readSessionRouteHead, sessionOmittedProviderHistory, sessionProviderHistoryLength, SESSION_LOAD_OMIT_PROVIDER };
}
module.exports = { createSessionPersistence };
