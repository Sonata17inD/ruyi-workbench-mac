'use strict';
const crypto = require('node:crypto');
const SESSION_HEAD_READ_RETRIES = 4;
// Owns NDJSON decoding, prefix proofs and bounded per-process body cache.
function createSessionBodies({ isWriting, logEvent, fsp = require('node:fs/promises') }) {
function danglingTurnState(length, at) {
  if (!length) return { dangling: false, kind: null };
  const last = at(length - 1);
  if (last && last.role === 'user') return { dangling: true, kind: 'user' };
  // A tail of role:'tool' is the persisted shape of Stop-mid-loop (the MOST common interruption): the
  // abort lands after the tool results were pushed but before the next model call (the `if (aborted)
  // break` right after the per-tool-result push in runOpenAiTurn), and the closing assistant text is
  // only pushed on normal completion. Every tool_call_id is answered, yet the turn never concluded.
  if (last && last.role === 'tool') return { dangling: true, kind: 'tool_calls' };
  // Walk back to the most recent assistant message that requested tools; verify each id was answered.
  for (let i = length - 1; i >= 0; i--) {
    const m = at(i);
    if (!m || m.role !== 'assistant') continue;
    if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) break; // plain assistant → complete
    const answered = new Set();
    for (let j = i + 1; j < length; j++) {
      const r = at(j);
      if (r && r.role === 'tool' && r.tool_call_id != null) answered.add(String(r.tool_call_id));
    }
    const unanswered = m.tool_calls.some(tc => tc && !answered.has(String(tc.id)));
    return unanswered ? { dangling: true, kind: 'tool_calls' } : { dangling: false, kind: null };
  }
  return { dangling: false, kind: null };
}

const sessionBodyPerfStats = { lineHashes: 0, bodyReads: 0, providerBodySkips: 0, deltaStampFromBytes: 0, deltaStampSerialized: 0, stateEvictions: 0, stateRecoveries: 0 };
// 当前条目数(只读;见 sessionBodyState 头注的条目上限)。getter:随 perfCounters.sessionBody 一起被展开取值。
Object.defineProperty(sessionBodyPerfStats, 'stateEntries', { enumerable: true, get: () => sessionBodyState.size });
function sessionLineHash(line) {
  sessionBodyPerfStats.lineHashes++;
  return crypto.createHash('sha1').update(line).digest('hex').slice(0, 16);
}

// ── perf(前端长会话):展示消息的【前缀戳】与增量取(GET /api/sessions/:id?fromIndex=N&prefixStamp=S)──────────────
// 经典壳在自己起的回合收尾时要把会话换成落盘后的那一份。修前是整份重取(2000 条消息 7.8–19 MB,主线程 1.1–1.7 s),
// 而前 N 条它手上早就有了。增量取只回 messages[N..];前提是服务端能证明「客户端手上那 N 条 === 服务端此刻的前 N 条」。
// 戳 = 'm1.<N>.<sha1(JSON(m0) + '\n' + … + JSON(m[N-1]) + '\n')>' —— 对【实际下发的内容】逐条取哈希,而不是对盘上的行、
// 消息 id 或某个修订号。理由:历史被改写的路径很多且分散(撤回/回溯的截断、压缩、慢路径整份重写、蒸发改写中间行的
// content、loadSession 里的 normalize 补字段与残留 pending 叙事段的惰性清理、后台任务账本合并、编辑),其中几条是
// 装载时才发生、而且未必落盘的;对下发内容取哈希就不必逐条认领它们 —— 前 N 条有任何一个字节不同,戳就对不上,
// 调用方落回全量,与修前逐字节一致。JSON 往返是稳定的(stringify(parse(stringify(x))) === stringify(x)),所以
// 客户端从一次下发里解析出来的那份,与服务端下次装载再算出来的那份,内容相同就一定同戳。
// 代价:O(前缀字节数) 的 stringify + sha1(15 MB 约 60 ms),只在带了参数的请求与经典壳回合起点那一发上付。
const SESSION_MESSAGES_STAMP_VERSION = 'm1';
function sessionMessageStampLine(message) {
  const line = JSON.stringify(message);
  return line === undefined ? 'null' : line; // 与数组元素的序列化同口径(undefined/函数在数组里写成 null)
}
// 整份 messages 的戳;不可序列化 → null(调用方不发戳,下次自然走全量)。
function sessionMessagesStamp(messages) {
  const list = Array.isArray(messages) ? messages : [];
  try {
    const hash = crypto.createHash('sha1');
    for (const message of list) hash.update(sessionMessageStampLine(message) + '\n');
    return `${SESSION_MESSAGES_STAMP_VERSION}.${list.length}.${hash.digest('hex')}`;
  } catch { return null; }
}
// 增量取的判定。fromRaw / stampRaw 是查询串原样;任何一处不成立(不是非负整数、N 超出现有条数、戳的版本或条数
// 对不上、前 N 条的哈希对不上、有条目不可序列化)都返回 null = 调用方回全量。成立时返回尾巴与新整份的戳
// (同一趟哈希接着算下去,不再多走一遍)。
// perf:第四参 body(可选)只由 loadSession 的 omitProviderHistory 视图给出(sessionOmittedProviderHistory(s).body):
// 盘上 messages 正文的原始字节 buf + 行尾偏移 lineEndBytes + 行数 count,并且装载时已经证明了两件事 ——
// ① messages[0..count) 就是这 count 行逐行 JSON.parse 的结果、装载没有改过它们(normalize/惰性清理一旦要改,
// 那个视图整个让位给完整装载);② 每一行都是 JSON.stringify 的原样输出(canonical,见 sessionBodyState 头注)。
// 于是「JSON(m[i]) + '\n'」逐字节就是盘上第 i 行加换行,前缀戳直接对字节取 sha1,不再逐条 stringify + 转 utf8
// (2000 条 / 15 MB:≈ 45 ms → ≈ 9 ms)。count 之后的条目(装载时合并进来的后台任务回执)照旧逐条序列化。
// 两条路算出的是同一个 sha1 输入,结果逐字节相同(unit/session-body-line-cache 在形状表上逐格比对)。
function sessionMessagesDelta(messages, fromRaw, stampRaw, body = null) {
  const list = Array.isArray(messages) ? messages : [];
  const text = String(fromRaw == null ? '' : fromRaw);
  if (!/^\d{1,9}$/.test(text)) return null;
  const from = Number(text);
  const claimed = String(stampRaw == null ? '' : stampRaw);
  if (from > list.length || !claimed.startsWith(`${SESSION_MESSAGES_STAMP_VERSION}.${from}.`)) return null;
  const disk = body && Buffer.isBuffer(body.buf) && Array.isArray(body.lineEndBytes)
    && Number.isInteger(body.count) && body.count <= list.length && body.lineEndBytes.length >= body.count ? body : null;
  if (disk) sessionBodyPerfStats.deltaStampFromBytes++; else sessionBodyPerfStats.deltaStampSerialized++;
  try {
    const hash = crypto.createHash('sha1');
    const byteEnd = k => (k > 0 ? disk.lineEndBytes[k - 1] : 0);
    const feed = (a, b) => {   // 把 list[a..b) 喂进哈希:盘上那一段按字节,其后逐条序列化
      if (disk && a < disk.count) {
        const upto = Math.min(b, disk.count);
        hash.update(disk.buf.subarray(byteEnd(a), byteEnd(upto)));
        a = upto;
      }
      for (let i = a; i < b; i++) hash.update(sessionMessageStampLine(list[i]) + '\n');
    };
    feed(0, from);
    if (`${SESSION_MESSAGES_STAMP_VERSION}.${from}.${hash.copy().digest('hex')}` !== claimed) return null;
    feed(from, list.length);
    return { from, count: list.length, tail: list.slice(from), stamp: `${SESSION_MESSAGES_STAMP_VERSION}.${list.length}.${hash.digest('hex')}` };
  } catch { return null; }
}
// 进程内「已落盘正文」状态:id → { msg: 记录, prov: 记录, bodiesOk }。
// 用途只有三处:① saveSession 判「内存数组的前缀 === 盘上的行」→ 快路径只 append 增量,否则全量重写;
// ② saveSession 判「调用方手里是盘上正文的严格前缀(旧副本)」→ 先补齐尾巴(rebaseStaleSessionBody);
// ③ 增量取不读 provider 正文(loadSession 的 omitProviderHistory 视图)。
// 记录 = { count, lines, hashes, chars, stamp, canonical, dangling }:
//   · lines     盘上每一行的原文。前缀比对是 JSON.stringify(entry) === lines[i](字符串比较,15 MB ≈ 2 ms),
//               修前是对每行算 sha1-16 再比(≈ 20 ms,外加装载时对整个文件再算一遍)。行原文是白来的:save 刚序列化
//               出来、load 刚解码出来、本来就要丢给 GC 的那一份留下来而已。
//   · hashes    行原文占内存(≈ 正文字符数),所以全进程有预算 SESSION_BODY_LINE_CACHE_CHARS,按最近写/读淘汰;
//               被淘汰或单条会话就超预算的记录退成每行 sha1-16(与修前同一个口径:sha1(行的 utf8)),比对照旧逐行 hash。
//               两种形态只经 sessionBodyLineMatches 比对,调用方不分辨。
//   · stamp     正文文件的 size|mtimeNs|ino(bigint stat):save 写完取;load 在读的前后各取一次,相等且与读到的字节数
//               相符才记,读完又截断过就记 null。只有两处信它:退成 hashes 时同一个戳的上一份 hashes 直接沿用(不重算);
//               增量取凭 provider 正文的戳没变就不去读它(与条件 GET 的 ETag 用同一类戳:size + mtime + inode)。
//   · canonical 每一行都是 JSON.stringify 的原样输出:save 写下的行天然是;load 读到的行只有与上一份 canonical 记录的
//               行原文逐行相等(字符串比较,不信戳)才继承。增量取按字节算前缀戳要它(见 sessionMessagesDelta)。
//   · dangling  只在 provider 记录上:detectDanglingTurn 对这份正文的判定 { dangling, kind },增量取不读正文也能回 resumable。
// 这张表只可能让事情变慢、不可能让数据变错:比对失配 → 全量重写;记录缺失 / bodiesOk=false → 全量重写;
// 增量取的任何一个前提不成立 → 落回完整装载。
// bodiesOk=false 表示上次正文写失败(可能半成品)→ 下次 save 强制全量重写自愈。进程重启后由 loadSession 重建。
// 条目数也有上限 SESSION_BODY_STATE_MAX_ENTRIES:行原文有字符预算,可退成的 hashes(每行一个 16 字符串)修前却
// 没有任何上限 —— 进程活多久,摸过的每一条会话就在这里挂多久。超出时按最近写/读序整条淘汰最旧的(Map 插入序,
// setSessionBodyState 每次都把本条挪到末尾)。淘汰只丢「快」:下次 save 先在写链里按盘上的头与正文把记录重建
// 回来(recoverSessionBodyState,②的旧副本补齐因此不失效),重建不了就全量重写;增量取落回完整装载。
const SESSION_BODY_LINE_CACHE_CHARS = 32 * 1024 * 1024;
const SESSION_BODY_STATE_MAX_ENTRIES = 128;
const sessionBodyState = new Map();
const sessionBodyLineCache = new Map();   // id → 该会话记录里行原文的字符数(Map 插入序 = 最近写/读序,最旧的先被淘汰)
let sessionBodyLineCacheChars = 0;
function sessionBodyStamp(st) { return st ? `${st.size}|${st.mtimeNs}|${st.ino}` : null; }
async function sessionBodyFileStamp(file) {
  try { return sessionBodyStamp(await fsp.stat(file, { bigint: true })); } catch { return null; }
}
function sessionBodyRecord(lines, { stamp = null, canonical = false, dangling = null } = {}) {
  let chars = 0;
  for (const line of lines) chars += line.length;
  return { count: lines.length, lines, hashes: null, chars, stamp, canonical, dangling };
}
// 盘上第 i 行是不是 line。记录两种形态(行原文 / 行 hash)在这里统一。
function sessionBodyLineMatches(record, i, line) {
  if (typeof line !== 'string') return false;
  return record.lines ? record.lines[i] === line : record.hashes[i] === sessionLineHash(line);
}
// 行原文 → 每行 sha1-16(就地改,同步完成,读者任何时刻看到的都是完整的一种形态)。
// prev 是同一会话的上一份记录:同一个文件戳、同样行数 = 同一份正文,直接沿用它的 hashes,不重算。
function demoteSessionBodyRecord(record, prev) {
  if (!record || !record.lines) return;
  record.hashes = (prev && prev.hashes && record.stamp && prev.stamp === record.stamp && prev.count === record.count)
    ? prev.hashes
    : record.lines.map(sessionLineHash);
  record.lines = null;
}
function releaseSessionBodyLineCache(id) {
  const held = sessionBodyLineCache.get(id);
  if (held == null) return;
  sessionBodyLineCacheChars -= held;
  sessionBodyLineCache.delete(id);
}
function setSessionBodyState(id, state) {
  const prev = sessionBodyState.get(id);
  releaseSessionBodyLineCache(id);
  sessionBodyState.delete(id);   // 先删再放:本条挪到插入序末尾(= 最近用过),淘汰从最旧的那头开始
  sessionBodyState.set(id, state);
  evictSessionBodyStateOverflow(id);
  const held = [state.msg, state.prov].reduce((n, rec) => n + (rec && rec.lines ? rec.chars : 0), 0);
  if (held > SESSION_BODY_LINE_CACHE_CHARS) {   // 单条会话就超预算:不占缓存,直接退成 hash(与修前同样的活)
    demoteSessionBodyRecord(state.msg, prev && prev.msg);
    demoteSessionBodyRecord(state.prov, prev && prev.prov);
    return;
  }
  if (held > 0) { sessionBodyLineCache.set(id, held); sessionBodyLineCacheChars += held; }
  for (const [otherId] of sessionBodyLineCache) {
    if (sessionBodyLineCacheChars <= SESSION_BODY_LINE_CACHE_CHARS) break;
    if (otherId === id) continue;
    const other = sessionBodyState.get(otherId);
    if (other) { demoteSessionBodyRecord(other.msg, null); demoteSessionBodyRecord(other.prov, null); }
    releaseSessionBodyLineCache(otherId);
  }
}
function dropSessionBodyState(id) {
  releaseSessionBodyLineCache(id);
  sessionBodyState.delete(id);
}
// 条目数超上限 → 从最旧的开始整条丢。正在写盘的会话(写链在跑)跳过:写者收尾会把准确的记录放回来,
// 丢了它也只是让那一次 save 多做一遍重建。keep 是刚放进来的那一条。
function evictSessionBodyStateOverflow(keep) {
  if (sessionBodyState.size <= SESSION_BODY_STATE_MAX_ENTRIES) return;
  for (const otherId of sessionBodyState.keys()) {
    if (sessionBodyState.size <= SESSION_BODY_STATE_MAX_ENTRIES) break;
    if (otherId === keep || isWriting(otherId)) continue;
    dropSessionBodyState(otherId);
    sessionBodyPerfStats.stateEvictions++;
  }
}
// 写链内、记录缺失时(被上面淘汰过;或进程重启后没装载就直接存)按盘上的真内容重建记录 —— 与 loadSession 读完交出的
// 那一份同形。前提:头是 v2、两个正文都读得出且行数与头声明的计数【完全相等】(多出的是未提交尾巴,要 loadSession
// 截断;少了是坏)。任何一条不成立就不给,调用方照旧全量重写。只在写链里调:此刻没有别的写者,盘上就是已提交的状态。
// 装载读到的正文 → 记录。与上一份 canonical 记录逐行相等(字符串比较)就继承 canonical,并沿用那一份的行对象(新解码的丢给 GC)。
function sessionBodyRecordFromRead(body, prev, { stampOk = true, dangling = null } = {}) {
  let lines = body.lines, canonical = false;
  if (prev && prev.lines && prev.canonical && prev.count === lines.length) {
    let same = true;
    for (let i = 0; i < lines.length; i++) if (lines[i] !== prev.lines[i]) { same = false; break; }
    if (same) { lines = prev.lines; canonical = true; }
  }
  return sessionBodyRecord(lines, { stamp: stampOk ? body.stamp : null, canonical, dangling });
}
// provider 正文行 → detectDanglingTurn 的判定。只从尾巴往回解析用得着的那几行;解析不了就不给(增量取随之落回完整装载)。
function sessionBodyDanglingFromLines(lines) {
  const parsed = new Map();
  try {
    return danglingTurnState(lines.length, i => {
      if (!parsed.has(i)) parsed.set(i, JSON.parse(lines[i]));
      return parsed.get(i);
    });
  } catch { return null; }
}
// 进程内「这条会话被写过几次盘」:saveSession 落盘前后各 +1。loadSession 开读时记下它,读完后仍相等才说明
// 这一眼期间没有写者 —— 只有那时才许把读到的正文状态交给 sessionBodyState、把补齐默认字段后的副本回写、
// 截断撕裂尾行。否则拿旧快照去做这三件事,都会把并发 save 刚写进去的消息盖掉/截掉(Windows CI 上
// session-head-read 那条「并发 save 后只剩 1 条」就是这么丢的)。
// 读一个 NDJSON 正文文件。返回 { entries, lines, lineEndBytes, tornAt, stamp, buf } | null(文件缺失) | { corrupt:true }(中间行坏)。
// 崩溃语义:写入侧永远「整行 + 尾随 \n」一次 append,所以【无 \n 终结的尾行 = 撕裂】(append 崩溃中途,
// 其所属的头写未完成,等于那次 save 没发生)—— 发现即【物理截断】到最后一个好行边界,而不是只在内存里
// 容忍:否则磁盘上留着半行,下次快路径 append 会接在撕裂字节之后,把新的真消息焊进坏行 → 中间坏行 →
// 整个会话被判 corrupt 隔离(真丢数据)。中间空行/坏行一律 corrupt(不应发生,发生即数据事故)。
// hunt2-P3:只有 ENOENT 才是「文件缺失」(null)。EBUSY/EPERM/EACCES(Windows 杀软/索引器短暂持锁)、
// EMFILE/ENFILE(句柄一时耗尽)这类读失败先有界重试;仍失败回 { unreadable:true } —— 修前一律 null,
// loadSession 把它当「正文丢了」,整条会话连头带正文改名 .corrupt(一次瞬时锁 = 会话从列表里消失)。
// perf:按字节读、在字节上找 '\n'、逐行解码再 JSON.parse。修前是整份解码成一个大字符串再 split:正文里只要有一个
// 中文字符,整份(连同 split 出来的每一行)就都是双字节串,解码、解析都慢一截;行尾字节偏移还要每行再 Buffer.byteLength
// 一遍。现在偏移直接就是字节下标(对非法 utf8 字节也精确 —— 修前按解码后的 U+FFFD 计 3 字节,截断点会偏)。
// 不再在这里算每行 hash:要比对的人拿 lines(行原文)比,见 sessionBodyState 头注。
// 分行判据与修前逐字节相同:'\n' 不会出现在任何 utf8 多字节序列里,按字节切与按字符切切在同一处。
const SESSION_BODY_READ_TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES', 'EMFILE', 'ENFILE', 'EAGAIN']);
async function readSessionBodyFile(p) {
  let buf, before = null;
  for (let attempt = 0; ; attempt++) {
    try {
      before = await fsp.stat(p, { bigint: true }).catch(() => null);
      buf = await fsp.readFile(p);
      break;
    } catch (error) {
      const code = String((error && error.code) || '');
      if (code === 'ENOENT') return null;
      if (!SESSION_BODY_READ_TRANSIENT.has(code) || attempt >= SESSION_HEAD_READ_RETRIES) return { unreadable: true, code: code || 'EREAD' };
      await new Promise(resolve => setTimeout(resolve, 5 + attempt * 10));
    }
  }
  sessionBodyPerfStats.bodyReads++;
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf), 'utf8');
  const after = await fsp.stat(p, { bigint: true }).catch(() => null);
  const stampBefore = sessionBodyStamp(before);
  const stamp = stampBefore && stampBefore === sessionBodyStamp(after) && after.size === BigInt(buf.length) ? stampBefore : null;
  const entries = [], lines = [], lineEndBytes = [];
  let start = 0; // 已确认好行的字节数(含每行结尾 \n),撕裂截断点
  for (;;) {
    const nl = buf.indexOf(10, start);
    if (nl < 0) break;   // 其后若还有字节 = 无 \n 终结的尾行(撕裂)
    if (nl === start) return { corrupt: true }; // 中间空行 = 坏
    const line = buf.toString('utf8', start, nl);
    try { entries.push(JSON.parse(line)); }
    catch { return { corrupt: true }; } // 中间坏行 = 坏
    lines.push(line);
    start = nl + 1;
    lineEndBytes.push(start);
  }
  // 撕裂尾行【只报告、不就地截断】:读的这一瞬可能正有 saveSession 在 append(Windows 上并发读能看到写了一半
  // 的行),在这里截断等于删掉正在落盘的那一行。截断交给 loadSession 在确认「没有写者」之后做。
  return { entries, lines, lineEndBytes, tornAt: start < buf.length ? start : null, stamp, buf };
}
// 快路径判定:entries 的前 record.count 条逐条序列化后与盘上的行全等 → 返回 { appendLines, allLines };
// 否则(前缀变/缩短/无记录/有条目不可序列化)返回 null → 调用方全量重写。注意:必须逐条重新序列化比对,不能只比
// 长度+尾行 —— 蒸发(evaporateHistory)会在保持长度不变的情况下原地改写中间行的 content;也不能凭对象身份跳过,
// 活回合、惰性清理都是就地改对象(见文件头「检测机制不靠调用方自觉打标记」)。省掉的只是「再对每行算一遍 sha1」。
function planSessionBodyAppend(entries, record) {
  if (!record || record.count > entries.length) return null;
  const allLines = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    let line;
    try { line = JSON.stringify(entries[i]); } catch { return null; } // 不可序列化 → 全量重写兜底
    if (typeof line !== 'string') return null;                        // undefined/函数:同上(全量重写那里会拒绝落盘)
    if (i < record.count && !sessionBodyLineMatches(record, i, line)) return null; // 前缀变 → 全量重写
    // 前缀行与记录里那一份逐字相同:沿用记录里的旧串,刚序列化出来的这份当场可回收(review:否则每次 save 都把
    // 整份正文的新串留进下一份记录,长会话一次 12 MB 升进老生代,Mark-Compact 次数 4 → 1)。
    allLines[i] = i < record.count && record.lines ? record.lines[i] : line;
  }
  return { appendLines: allLines.slice(record.count), allLines };
}
// 全量重写用的整体序列化(行数组)。返回 null = 有条目不可序列化(调用方拒绝这次写并标 bodiesOk=false ——
// 宁可下次再试,绝不写出半个正文文件)。
function serializeSessionBody(entries) {
  const lines = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    let line;
    try { line = JSON.stringify(entries[i]); } catch { return null; }
    if (typeof line !== 'string') return null;
    lines[i] = line;
  }
  return lines;
}
function sessionBodyText(lines) { return lines.length ? lines.join('\n') + '\n' : ''; }
function sessionBodyDigest(lines) {
  const hash = crypto.createHash('sha256');
  for (const line of lines) hash.update(line, 'utf8').update('\n');
  return hash.digest('hex');
}
function sessionBodyCommitValid(head) {
  const commit = head.providerHistoryCommit;
  return Number.isSafeInteger(head.providerHistoryRevision) && head.providerHistoryRevision >= 0
    && commit?.schema === 1 && commit.revision === head.providerHistoryRevision
    && /^[a-f0-9]{64}$/.test(commit.messagesSha256 || '') && /^[a-f0-9]{64}$/.test(commit.providerSha256 || '');
}
function sessionBodiesMatchCommit(head, msg, prov) {
  if (!Object.hasOwn(head, 'providerHistoryRevision') && !Object.hasOwn(head, 'providerHistoryCommit')) return true;
  if (!sessionBodyCommitValid(head)) return false;
  const commit = head.providerHistoryCommit;
  const matches = (body, count, digest) => {
    if (!body || body.corrupt || body.unreadable || !Number.isSafeInteger(count) || count < 0 || body.entries.length < count) return false;
    const end = count ? body.lineEndBytes[count - 1] : 0;
    return crypto.createHash('sha256').update(body.buf.subarray(0, end)).digest('hex') === digest;
  };
  return matches(msg, head.messageCount, commit.messagesSha256) && matches(prov, head.providerHistoryCount, commit.providerSha256);
}
// entries 是否为 record 所记盘上正文的【严格】前缀(更短且逐行相同)。
function isStrictSessionBodyPrefix(entries, record) {
  if (!record || entries.length >= record.count) return false;
  for (let i = 0; i < entries.length; i++) {
    let line;
    try { line = JSON.stringify(entries[i]); } catch { return false; }
    if (!sessionBodyLineMatches(record, i, line)) return false;
  }
  return true;
}
// saveSession 写链内调用（见调用点注释）。只在消息是严格前缀时动手；providerHistory 只在它也是严格前缀
// 时一并补齐 —— 它会被合法地缩短（被停止的回合弹掉悬空的 user 行、压缩），消息更短才是
// 「这是一份旧副本」的证据。就地往调用方的数组里补，返回 true 表示补过（头计数要重算）。
// 盘上正文是现读的、逐行拿原文与记录比(不信文件戳):行数相同且最后一行相同才补。
async function rebaseStaleSessionBody(id, bp, state, messages, providerHistory) {
  const msgRec = state.msg, provRec = state.prov;
  if (!isStrictSessionBodyPrefix(messages, msgRec)) return false;
  const disk = await readSessionBodyFile(bp.messages);
  if (!disk || disk.corrupt || disk.unreadable || disk.lines.length !== msgRec.count
    || !sessionBodyLineMatches(msgRec, msgRec.count - 1, disk.lines[msgRec.count - 1])) return false;
  const addedMessages = disk.entries.length - messages.length;
  messages.push(...disk.entries.slice(messages.length));
  let addedProvider = 0;
  if (isStrictSessionBodyPrefix(providerHistory, provRec)) {
    const prov = await readSessionBodyFile(bp.provider);
    if (prov && !prov.corrupt && !prov.unreadable && prov.lines.length === provRec.count) {
      addedProvider = prov.entries.length - providerHistory.length;
      providerHistory.push(...prov.entries.slice(providerHistory.length));
    }
  }
  logEvent({ kind: 'session_stale_copy_rebased', sessionId: id, addedMessages, addedProvider });
  return true;
}

function getSessionBodyState(id) { return sessionBodyState.get(id); }
return { sessionMessagesStamp, sessionMessagesDelta, sessionBodyFileStamp, sessionBodyRecord, setSessionBodyState, dropSessionBodyState, sessionBodyRecordFromRead, sessionBodyDanglingFromLines, readSessionBodyFile, planSessionBodyAppend, serializeSessionBody, sessionBodyText, sessionBodyDigest, sessionBodyCommitValid, sessionBodiesMatchCommit, rebaseStaleSessionBody, sessionBodyPerfStats, SESSION_BODY_READ_TRANSIENT, SESSION_HEAD_READ_RETRIES, danglingTurnState, getSessionBodyState };
}
module.exports = { createSessionBodies };
