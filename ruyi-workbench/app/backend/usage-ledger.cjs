'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { safeJsonParse } = require('./ordinary-json.cjs');

function createUsageLedger({ paths, onAppend }) {
  // ===== v1.4-OSS 用量/成本账本 (append-only monthly ledger) ================================================
  // Each finished turn (both engines) appends ONE JSON line to usage/YYYY-MM.jsonl (month = the row's UTC ts).
  // Design: APPEND-ONLY, never read-modify-write, so concurrent 多会话 turns cannot corrupt a shared index the
  // way a read-modify-write index could. Empty / zero-token turns are skipped. A ledger write failure is
  // fire-and-forget (a non-critical persistence, like the rest) and must NEVER break the turn. Corrupt lines are
  // skipped at read time (safeJsonParse per line). COST SEMANTICS: every recorded `cost` is a NOTIONAL/estimate
  // figure, never an assertion of real billing (a Claude subscription or a third-party Coding Plan may not bill
  // per token at all). `costTrusted:false` marks rows whose currency amount is plan-based / not a meaningful
  // spend (see the Claude third-party endpoint path); aggregation keeps those OUT of the real costsByCurrency.
  let usageLedgerChain = Promise.resolve();
  // 128f-⑥:还没轮到的那几行(见 appendUsageLedger)。退出路径上的同步补写只动 state==='queued' 的。
  const usageLedgerPending = [];
  // 退出监听器里只能同步 I/O(async 版永远跑不完 —— 与 02 的 flushSessionIndexSync 同一个理由)。返回补写了几行。
  function flushUsageLedgerSync() {
    let written = 0;
    for (const item of usageLedgerPending) {
      if (!item || item.state !== 'queued') continue;
      try { fs.mkdirSync(path.dirname(item.file), { recursive: true }); fs.appendFileSync(item.file, item.line, 'utf8'); item.state = 'done'; written += 1; }
      catch { /* best effort:退出路径上不许抛 */ }
    }
    return written;
  }

  function appendUsageLedger(entry) {
    try {
      const inTok = Math.max(0, Math.round(Number(entry.inTok) || 0));
      const outTok = Math.max(0, Math.round(Number(entry.outTok) || 0));
      const cachedInTok = Math.min(inTok, Math.max(0, Math.round(Number(entry.cachedInTok) || 0)));
      // NB: Number(null) === 0, so guard null/undefined explicitly — a tokens-only turn must stay cost:null.
      const costNum = (entry.cost == null) ? NaN : Number(entry.cost);
      // v1.4-OSS 用量看板(补): skip a truly empty row — zero tokens AND no trusted positive cost. A row that reports
      // a real cost but no per-token usage (e.g. a Claude-plan aux call billed a flat amount) is KEPT so its spend
      // is not silently lost. costNum is computed above so this guard can see it.
      if (inTok <= 0 && outTok <= 0 && !(Number.isFinite(costNum) && costNum > 0)) return;
      const ts = (typeof entry.ts === 'string' && entry.ts) ? entry.ts : new Date().toISOString();
      const rec = {
        ts,
        sessionId: String(entry.sessionId || ''),
        engine: ['claude', 'codex'].includes(entry.engine) ? entry.engine : 'openai',
        provider: String(entry.provider || ''),
        model: String(entry.model || ''),
        inTok, outTok, cachedInTok,
        cost: Number.isFinite(costNum) ? costNum : null,
        currency: (typeof entry.currency === 'string' && entry.currency) ? entry.currency : null,
        costTrusted: entry.costTrusted !== false, // false = plan-based / notional (kept out of real cost totals)
        estimated: entry.estimated === true,
        turnSeq: Number(entry.turnSeq) || 0,
        // v1.4-OSS 用量看板(补): kind is three-valued — 'turn' (top-level chat turn), 'subagent' (an Agent 工作流 /
        // orchestrate_agents DAG node), or 'aux' (a non-turn helper call: 压缩摘要 / playbook 起草 等). Old rows without a
        // kind read as 'turn' (向后兼容). agentKey/subagentId are stamped only for sub-agent rows so the dashboard
        // can attribute a DAG node's spend; both truncated to a sane length.
        kind: entry.kind === 'subagent' ? 'subagent' : (entry.kind === 'aux' ? 'aux' : 'turn'),
      };
      if (entry.agentKey != null && String(entry.agentKey)) rec.agentKey = String(entry.agentKey).slice(0, 120);
      if (entry.subagentId != null && String(entry.subagentId)) rec.subagentId = String(entry.subagentId).slice(0, 120);
      if (entry.runId != null && String(entry.runId)) rec.runId = String(entry.runId).slice(0, 120); // 代理模式 v2:代理 run 归属(subagent/aux 行)
      // v1.4-OSS 用量看板(补): optional note tags an aux row's sub-kind (e.g. 'compact' / 'playbook-draft'), ≤40 chars.
      if (entry.note != null && String(entry.note)) rec.note = String(entry.note).slice(0, 40);
      const line = JSON.stringify(rec) + '\n';
      const file = path.join(paths.usage, ts.slice(0, 7) + '.jsonl');
      // 128f-⑥:排队的这一行先登记进 usageLedgerPending(状态 queued)—— 退出路径(SIGINT／SIGTERM／未捕获异常都走
      // process.exit)上链还没轮到它,flushUsageLedgerSync 用同步 I/O 把 queued 的补写掉;正在写的那一行(writing)
      // 不补:它落没落盘不知道,补了可能记两遍(费用翻倍比少一行更糟)。
      const pending = { file, line, state: 'queued' };
      usageLedgerPending.push(pending);
      // One global append chain so multi-session concurrent writes never interleave a half-line.
      usageLedgerChain = usageLedgerChain.then(async () => {
        try {
          if (pending.state === 'queued') {
            pending.state = 'writing';
            await fsp.mkdir(path.dirname(file), { recursive: true });
            await fsp.appendFile(file, line, 'utf8');
            pending.state = 'done';
          }
        } finally {
          const at = usageLedgerPending.indexOf(pending);
          if (at >= 0) usageLedgerPending.splice(at, 1);
        }
        onAppend(rec);
      }).catch(() => {}); // fire-and-forget: a ledger failure must never wedge the chain or the turn
    } catch { /* never let accounting break a turn */ }
  }

  // Local-calendar day key (YYYY-MM-DD) for byDay bucketing (matches the today/month local range boundaries).
  function usageDayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  // 性能批 P1:账大体按时间追加,相邻行多半同一天。记住上一次算出的那一天的 [本地 0 点, 次日 0 点),落在里面就复用日键 ——
  // 日键只由 ms 决定,区间内处处相同,所以结果与逐行 usageDayKey 相同(NaN 永远不落在区间里,照旧逐次现算)。
  // 边界按日历字段现造(new Date(年, 月, 日) / 日 + 1):午夜跳 DST 的时区(开罗、哈瓦那、贝鲁特、圣地亚哥……)那一天
  // 的 0 点不存在,setHours(0) 会落到 01:00,若再从它 setDate(+1) 推次日边界就错成次日 01:00,次日 0–1 点的行被记到前一天。
  function usageDayKeyMemo() {
    let lo = NaN, hi = NaN, key = '';
    return ms => {
      if (ms >= lo && ms < hi) return key;
      key = usageDayKey(ms);
      const d = new Date(ms);
      lo = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      hi = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      return key;
    };
  }
  // Lower-bound instant (ms) for a range. today/month use the LOCAL calendar; week = last 7x24h; all = 0.
  function usageRangeLowerMs(range, now) {
    const d = new Date(now);
    if (range === 'today') { d.setHours(0, 0, 0, 0); return d.getTime(); }
    if (range === 'week') return now - 7 * 24 * 60 * 60 * 1000;
    if (range === 'all') return 0;
    d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); // 'month' (default)
  }
  // Read every ledger row with ts >= lowerMs. Reads only month files that can contain such rows (file month key
  // >= the lower bound's UTC month; monotonic, so no qualifying row is missed). Corrupt lines are skipped, and a
  // missing usage dir (old install) yields [] rather than throwing.
  async function readUsageRows(lowerMs) {
    const rows = [];
    let files = [];
    try { files = (await fsp.readdir(paths.usage)).sort(); } catch { return rows; }   // 性能批 P1:按月份名排序 —— 修前是 readdir 次序(Linux 上是散列序),浮点累加次序随平台漂
    const lowerKey = lowerMs > 0 ? new Date(lowerMs).toISOString().slice(0, 7) : '';
    for (const f of files) {
      if (!/^\d{4}-\d{2}\.jsonl$/.test(f)) continue;
      if (lowerKey && f.slice(0, 7) < lowerKey) continue; // whole month precedes the lower bound
      let raw = '';
      try { raw = await fsp.readFile(path.join(paths.usage, f), 'utf8'); } catch { continue; }
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const rec = safeJsonParse(line, null);
        if (!rec || typeof rec !== 'object') continue; // corrupt line skipped
        const t = Date.parse(rec.ts);
        if (!Number.isFinite(t) || (lowerMs > 0 && t < lowerMs)) continue;
        rows.push(rec);
      }
    }
    return rows;
  }

  // ── 性能批 P1:用量账缓存 ────────────────────────────────────────────────────────────────────────
  // 修前每个读者(看板、预算、任务卡用量、管家熔断/仲裁/用量工具)每次都 readUsageRows:把所有月份整份读出、逐行
  // JSON.parse。每跑一轮对话 13e 就打一次 usage 脏页,下一次看板读因此整读一遍账 —— 2000 会话 / 30 万行(70 MB)时
  // 单这一步 1.5 s,而且大半是同步解析,SSE 流跟着顿。
  // 这里把解析结果按月份文件常驻成列(定长数组 + 值字典),文件只长不改时只解析新增的尾巴:
  //   · 判据:stat 的 size/mtime 没变 → 原样复用;同一个文件(ino 没变)、【变长了】、且上次已解析部分末尾那 ≤256 字节
  //     (约一整行,含毫秒级 ts)原样还在 → 只读新增部分;其余一切(截短、同尺寸改写、换文件、核对不上)这一个月整份重读。
  //     只提交到最后一个换行,没写完的那半行每次按原逻辑现解析、不入列。程序自己对账只追加(appendUsageLedger /
  //     flushUsageLedgerSync);外部编辑里只有「在中间改、同时又变长、末尾 256 字节恰好没动」这一种查不出,要等进程重启
  //     (缓存只在内存里)。
  //   · 对外只有 forEachUsageRow(lowerMs, fn):次序(readdir 次序的月份文件 → 文件内行序)、过滤(月份键 + ts 下界 +
  //     坏行/坏 ts 跳过)与 readUsageRows 逐条相同,调用方原来的累加代码一字不改,浮点累加次序因此也不变。
  //   · fn 拿到的是【复用的】视图对象:只许在回调里读,不许留引用。数值列存的是 Number(原值)(六个消费方本来就先
  //     Number() 再用),字符串类字段原值入字典(连类型一起保真:typeof 判断照旧),costTrusted 只在原值 === false
  //     时为 false,estimated 只在原值 === true 时为 true —— 与消费方的判据一一对应。多出一个 tsMs(= Date.parse(ts))。
  //   · RUYI_USAGE_CACHE=0 退回修前的整读路径(逃生口,也是 unit/usage-ledger-cache 差分测试的对照组)。
  const USAGE_CACHE_CHECK_BYTES = 256;
  const USAGE_CACHE_YIELD_LINES = 4000;
  const USAGE_CACHE_YIELD_ROWS = 25000;   // 遍历时每这么多行让一次(约 10 ms 一片)   // 整月首次解析时每这么多行让一次事件循环(70 MB 的账不再一口气占住主线程)
  const USAGE_CACHE_ROW_BYTES = 8 * 5 + 1 + 4 * 7;   // 五个 Float64 列 + 标志位 + 七个字典号
  const usageLedgerCache = {
    months: new Map(),            // 月份文件名 -> { size, mtimeMs, committed, check, cols, tail }
    dict: [], dictIndex: new Map(), dictObjectIndex: new Map(),
    chain: Promise.resolve(),
    stats: { refreshes: 0, fullParses: 0, incrementalParses: 0, bytesParsed: 0 },
    // 变更日志:每次刷新里哪些会话的行变了(整月重读 / 删月份记为 all)。13e 按它只刷那几条会话的用量 ——
    // 本进程追加的与外部写进来的一视同仁,不再靠源指纹猜(审查轮:外部写账与本进程追加同时发生时会被漏掉)。
    changeSeq: 0,
    changeLog: [],                // { seq, all, ids: Set<string> },最多 USAGE_CHANGE_LOG_MAX 条
    changeFloor: 0,               // 早于这个序号的日志已丢弃,问得更早的一律答 all
  };
  const USAGE_CHANGE_LOG_MAX = 512;
  function usageNoteChange(all, ids) {
    if (!all && (!ids || !ids.size)) return;
    usageLedgerCache.changeSeq += 1;
    usageLedgerCache.changeLog.push({ seq: usageLedgerCache.changeSeq, all: Boolean(all), ids: ids || new Set() });
    while (usageLedgerCache.changeLog.length > USAGE_CHANGE_LOG_MAX) usageLedgerCache.changeFloor = usageLedgerCache.changeLog.shift().seq;
  }
  function usageColsSessionIds(cols, from, into) {
    if (!cols) return into;
    for (let i = from; i < cols.n; i++) into.add(String(usageLedgerCache.dict[cols.sessionId[i]]));
    return into;
  }
  function usageLedgerCacheDisabled() { return process.env.RUYI_USAGE_CACHE === '0'; }
  // 对象 / 数组值(只可能来自外部写坏的行)按内容去重:原样交给消费方的是同内容的第一份实例 —— typeof、String()
  // 的结果都不变,而按引用去重会让每一行都在字典里新占一格、永不回收。
  function usageDictId(value) {
    if (value !== null && typeof value === 'object') {
      let key = '';
      try { key = JSON.stringify(value); } catch { key = '?'; }
      let id = usageLedgerCache.dictObjectIndex.get(key);
      if (id === undefined) { id = usageLedgerCache.dict.length; usageLedgerCache.dict.push(value); usageLedgerCache.dictObjectIndex.set(key, id); }
      return id;
    }
    let id = usageLedgerCache.dictIndex.get(value);
    if (id === undefined) { id = usageLedgerCache.dict.length; usageLedgerCache.dict.push(value); usageLedgerCache.dictIndex.set(value, id); }
    return id;
  }
  const USAGE_DICT_COLUMNS = ['sessionId', 'engine', 'provider', 'model', 'currency', 'kind', 'note'];
  function usageColumns(capacity) {
    const cap = Math.max(4, capacity | 0);
    const cols = { n: 0, cap, tsMs: new Float64Array(cap), inTok: new Float64Array(cap), outTok: new Float64Array(cap), cachedInTok: new Float64Array(cap), cost: new Float64Array(cap), flags: new Uint8Array(cap), tsRaw: new Map() };
    for (const key of USAGE_DICT_COLUMNS) cols[key] = new Uint32Array(cap);
    return cols;
  }
  function usageColumnsGrow(cols) {
    // 小列倍增;大列(整月解析完收紧过的)每次只多留 1/8 —— 一个月几万行,追加一行就翻倍太浪费
    const cap = cols.cap < 4096 ? cols.cap * 2 : cols.cap + (cols.cap >> 3);
    for (const key of ['tsMs', 'inTok', 'outTok', 'cachedInTok', 'cost', 'flags', ...USAGE_DICT_COLUMNS]) {
      const next = new cols[key].constructor(cap); next.set(cols[key]); cols[key] = next;
    }
    cols.cap = cap;
  }
  // ts 原串是不是 toISOString 的规范写法(是的话不必另存,用 tsMs 就能原样还原)。逐行 new Date().toISOString() 太贵,
  // 按形状判:24 位、各分隔符在位、全是数字、小时不是 24(V8 把 24 点进位到次日);日期部分合不合法(2 月 30 日之类
  // V8 也会进位)按「上一行的那一天」缓存,同一天只真算一次。判不准的情形一律当非规范、另存原串 —— 只多占点内存,不会错。
  const usageTsDateMemo = { date: '', ok: false };
  function usageTsIsCanonical(ts) {
    if (typeof ts !== 'string' || ts.length !== 24) return false;
    if (ts.charCodeAt(4) !== 45 || ts.charCodeAt(7) !== 45 || ts.charCodeAt(10) !== 84 || ts.charCodeAt(13) !== 58
      || ts.charCodeAt(16) !== 58 || ts.charCodeAt(19) !== 46 || ts.charCodeAt(23) !== 90) return false;
    for (const k of [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22]) { const c = ts.charCodeAt(k); if (c < 48 || c > 57) return false; }
    if (ts.charCodeAt(11) === 50 && ts.charCodeAt(12) === 52) return false;   // 24 点
    if (!ts.startsWith(usageTsDateMemo.date) || usageTsDateMemo.date === '') {
      const date = ts.slice(0, 10);
      const probe = date + 'T00:00:00.000Z';
      const t = Date.parse(probe);
      usageTsDateMemo.date = date;
      usageTsDateMemo.ok = Number.isFinite(t) && new Date(t).toISOString() === probe;
    }
    return usageTsDateMemo.ok;
  }
  // 字典号:相邻行的会话/引擎/模型多半相同,每列记住上一个值,命中就不查 Map。
  function usageColumnsDictMemo() {
    return { sessionId: [NaN, 0], engine: [NaN, 0], provider: [NaN, 0], model: [NaN, 0], currency: [NaN, 0], kind: [NaN, 0], note: [NaN, 0] };
  }
  function usageDictIdMemo(memo, value) {
    if (memo[0] === value) return memo[1];   // NaN 初值永不相等;JSON 里也出不来 NaN
    const id = usageDictId(value);
    memo[0] = value; memo[1] = id;
    return id;
  }
  // 一行 → 列。与 readUsageRows 的逐行判据相同:空白行、解析不出对象、ts 解析不出有限数的行都跳过。
  function usageColumnsPushLine(cols, line) {
    if (!line.trim()) return false;
    const rec = safeJsonParse(line, null);
    if (!rec || typeof rec !== 'object') return false;
    const t = Date.parse(rec.ts);
    if (!Number.isFinite(t)) return false;
    if (cols.n === cols.cap) usageColumnsGrow(cols);
    const i = cols.n++;
    cols.tsMs[i] = t;
    // ts 原串只在它不是 toISOString 的规范写法时才另存(byModel.lastAt 要原样回显那一行的 ts)
    if (!usageTsIsCanonical(rec.ts)) cols.tsRaw.set(i, rec.ts);
    cols.inTok[i] = Number(rec.inTok); cols.outTok[i] = Number(rec.outTok); cols.cachedInTok[i] = Number(rec.cachedInTok); cols.cost[i] = Number(rec.cost);
    cols.flags[i] = (rec.costTrusted === false ? 1 : 0) | (rec.estimated === true ? 2 : 0);
    const memo = cols.dictMemo || (cols.dictMemo = usageColumnsDictMemo());
    cols.sessionId[i] = usageDictIdMemo(memo.sessionId, rec.sessionId);
    cols.engine[i] = usageDictIdMemo(memo.engine, rec.engine);
    cols.provider[i] = usageDictIdMemo(memo.provider, rec.provider);
    cols.model[i] = usageDictIdMemo(memo.model, rec.model);
    cols.currency[i] = usageDictIdMemo(memo.currency, rec.currency);
    cols.kind[i] = usageDictIdMemo(memo.kind, rec.kind);
    cols.note[i] = usageDictIdMemo(memo.note, rec.note);
    return true;
  }
  // 解析一段文本进 cols。yieldBetween 时每 USAGE_CACHE_YIELD_LINES 行让一次事件循环(只用于还没发布出去的新列)。
  async function usageColumnsParseText(cols, text, yieldBetween) {
    const lines = text.split('\n');
    for (let k = 0; k < lines.length; k++) {
      let line = lines[k];
      if (line.endsWith('\r')) line = line.slice(0, -1);
      usageColumnsPushLine(cols, line);
      if (yieldBetween && k % USAGE_CACHE_YIELD_LINES === USAGE_CACHE_YIELD_LINES - 1) await new Promise(resolve => setImmediate(resolve));
    }
  }
  // 整月解析完把列收紧到实际行数(首次解析按字节估的容量会多出两成)。之后追加仍按倍增长。
  function usageColumnsShrink(cols) {
    const cap = Math.max(4, cols.n);
    if (cap >= cols.cap) return cols;
    for (const key of ['tsMs', 'inTok', 'outTok', 'cachedInTok', 'cost', 'flags', ...USAGE_DICT_COLUMNS]) cols[key] = cols[key].slice(0, cap);
    cols.cap = cap;
    return cols;
  }
  function usageColumnsAppend(dst, src) {
    for (let j = 0; j < src.n; j++) {
      if (dst.n === dst.cap) usageColumnsGrow(dst);
      const i = dst.n++;
      for (const key of ['tsMs', 'inTok', 'outTok', 'cachedInTok', 'cost', 'flags', ...USAGE_DICT_COLUMNS]) dst[key][i] = src[key][j];
      if (src.tsRaw.has(j)) dst.tsRaw.set(i, src.tsRaw.get(j));
    }
  }
  // buf 的 [0, lastNL] 是完整行、之后是没写完的尾巴(不入列,每次随条目现解析一份)。
  // 0x0A 不会出现在 UTF-8 多字节序列内部,在它上面切不会劈开字符,逐段解码与整份解码结果相同。
  function usageSplitComplete(buf) {
    const lastNl = buf.lastIndexOf(0x0a);
    const complete = lastNl >= 0 ? buf.subarray(0, lastNl + 1) : buf.subarray(0, 0);
    return { complete, rest: buf.subarray(complete.length) };
  }
  function usageNextCheck(previous, complete) {
    const take = complete.subarray(Math.max(0, complete.length - USAGE_CACHE_CHECK_BYTES));   // 只拷末尾,不把整块拼一遍
    const source = take.length >= USAGE_CACHE_CHECK_BYTES ? take : Buffer.concat([previous, take]);
    return Buffer.from(source.subarray(Math.max(0, source.length - USAGE_CACHE_CHECK_BYTES)));
  }
  async function usageParseTail(rest) {
    if (!rest.length) return null;
    const tail = usageColumns(4);
    await usageColumnsParseText(tail, rest.toString('utf8'), false);
    return tail;
  }
  async function usageMonthFullParse(file, st) {
    const buf = await fsp.readFile(file);
    const { complete, rest } = usageSplitComplete(buf);
    const cols = usageColumns(Math.ceil(complete.length / 200) + 16);
    // 新列还没发布(不在 months 里),分片让出期间别的读者看到的仍是旧条目。
    if (complete.length) await usageColumnsParseText(cols, complete.toString('utf8'), true);
    usageColumnsShrink(cols);
    usageLedgerCache.stats.fullParses += 1;
    usageLedgerCache.stats.bytesParsed += buf.length;
    return { size: buf.length, mtimeMs: st.mtimeMs, ino: st.ino, committed: complete.length, check: usageNextCheck(Buffer.alloc(0), complete), cols, tail: await usageParseTail(rest) };
  }
  // 读 [committed - check.length, size):先核对旧末尾那几个字节还在原位,再吞新增部分。核不上就返回 null(调用方整月重读)。
  // 新增行先解析进临时列;并进共享列与换上新条目由调用方在同一个同步段里做 —— 别的读者看不到「行已入列、旧尾巴
  // 还挂着」那种半截状态(那会把同一行数两遍)。
  async function usageMonthIncremental(file, entry, st) {
    const start = entry.committed - entry.check.length;
    const length = st.size - start;
    const fh = await fsp.open(file, 'r');
    let buf;
    try {
      buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, start);
      if (bytesRead !== length) return null;
    } finally { await fh.close(); }
    if (!buf.subarray(0, entry.check.length).equals(entry.check)) return null;
    const { complete, rest } = usageSplitComplete(buf.subarray(entry.check.length));
    const fresh = usageColumns(16);
    if (complete.length) await usageColumnsParseText(fresh, complete.toString('utf8'), false);
    const tail = await usageParseTail(rest);
    const parsedBytes = buf.length - entry.check.length;
    // 返回提交函数:由调用方在【同一个同步段】里并列 + 换条目。
    return () => {
      usageColumnsAppend(entry.cols, fresh);
      usageLedgerCache.stats.incrementalParses += 1;
      usageLedgerCache.stats.bytesParsed += parsedBytes;
      return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, committed: entry.committed + complete.length, check: usageNextCheck(entry.check, complete), cols: entry.cols, tail };
    };
  }
  async function refreshUsageLedgerCacheNow() {
    usageLedgerCache.stats.refreshes += 1;
    let files = [];
    try { files = await fsp.readdir(paths.usage); } catch {
      if (usageLedgerCache.months.size) usageNoteChange(true);
      usageLedgerCache.months.clear();
      return [];
    }
    const order = files.filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();   // 与 readUsageRows 同一次序
    const present = new Set(order);
    for (const name of [...usageLedgerCache.months.keys()]) if (!present.has(name)) { usageLedgerCache.months.delete(name); usageNoteChange(true); }
    for (const name of order) {
      const file = path.join(paths.usage, name);
      try {
        const st = await fsp.stat(file);
        const entry = usageLedgerCache.months.get(name);
        if (entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs) continue;
        // 同尺寸只换了 mtime = 原地改写(追加一定变长)→ 整月重读
        const commit = entry && st.ino === entry.ino && st.size > entry.size && st.size >= entry.committed ? await usageMonthIncremental(file, entry, st).catch(() => null) : null;
        if (commit) {
          const before = entry.cols.n;
          const next = commit();
          usageLedgerCache.months.set(name, next);
          const ids = usageColsSessionIds(entry.tail, 0, usageColsSessionIds(next.cols, before, new Set()));
          usageNoteChange(false, usageColsSessionIds(next.tail, 0, ids));
        } else {
          const next = await usageMonthFullParse(file, st);
          usageLedgerCache.months.set(name, next);
          // 新出现的月份只牵涉它自己那些行的会话;已有月份被整份重读(截短、改写)就当全部都可能变了
          if (entry) usageNoteChange(true);
          else usageNoteChange(false, usageColsSessionIds(next.tail, 0, usageColsSessionIds(next.cols, 0, new Set())));
        }
      } catch {   // 读不了的月份与修前一样当它不存在
        if (usageLedgerCache.months.delete(name)) usageNoteChange(true);
      }
    }
    return order;
  }
  // 刷新串行:每个调用拿到的都是【它发起之后】才开始的那一次刷新 —— 刚写进账的行对下一个读者一定可见。
  function refreshUsageLedgerCache() {
    const run = usageLedgerCache.chain.then(refreshUsageLedgerCacheNow, refreshUsageLedgerCacheNow);
    usageLedgerCache.chain = run.catch(() => []);
    return run;
  }
  // opts.sessionIds(可选,Set<string>):只遍历这些会话的行 —— 次序与全量遍历里筛出来的一样,聚合结果逐位相同;
  // 列里先比字典号,不命中的行连视图都不填(每轮对话后只刷那几条会话的用量时,30 万行的账只花几毫秒)。
  async function forEachUsageRow(lowerMs, fn, opts = {}) {
    const onlySessions = opts && opts.sessionIds instanceof Set ? opts.sessionIds : null;
    if (usageLedgerCacheDisabled()) {
      for (const rec of await readUsageRows(lowerMs)) {
        if (onlySessions && !onlySessions.has(rec.sessionId)) continue;
        rec.tsMs = Date.parse(rec.ts); rec.tsRaw = rec.ts; fn(rec);
      }
      return;
    }
    // 读账失败与修前 readUsageRows 同口径:当空账(不抛)。回调里抛的错照旧往外冒。
    let order = [];
    try { order = await refreshUsageLedgerCache(); } catch { return; }
    const lowerKey = lowerMs > 0 ? new Date(lowerMs).toISOString().slice(0, 7) : '';
    const dict = usageLedgerCache.dict;
    let wantIds = null;
    if (onlySessions) {
      wantIds = new Set();
      for (const sid of onlySessions) { const id = usageLedgerCache.dictIndex.get(sid); if (id !== undefined) wantIds.add(id); }
      if (!wantIds.size) return;
    }
    // 性能批 P4:先同步拍一份快照(每个月的列对象、当时的行数、当时的尾巴),再按快照遍历、每 USAGE_CACHE_YIELD_ROWS 行
    // 让一次事件循环 —— 30 万行的看板不再一口气占住主线程 170 ms。遍历期间新追加的行不在快照里(调用那一刻的一致视图):
    // 追加只会往列尾写、整月重读换的是新列对象,快照里 [0, n) 的内容始终不变,不会重、不会漏。
    const plan = [];
    for (const name of order) {
      if (lowerKey && name.slice(0, 7) < lowerKey) continue;
      const entry = usageLedgerCache.months.get(name);
      if (!entry) continue;
      plan.push([entry.cols, entry.cols.n]);
      if (entry.tail) plan.push([entry.tail, entry.tail.n]);
    }
    const view = new UsageRowView();
    // 让出按「交给回调的行」计;被筛掉的行只比一个字典号,按大 16 倍的间隔另计(只刷几条会话时别白等十几拍)。
    let visited = 0, skipped = 0;
    for (const [c, n] of plan) {
      for (let i = 0; i < n; i++) {
        if (visited >= USAGE_CACHE_YIELD_ROWS || skipped >= USAGE_CACHE_YIELD_ROWS * 16) { visited = 0; skipped = 0; await new Promise(resolve => setImmediate(resolve)); }
        if (wantIds && !wantIds.has(c.sessionId[i])) { skipped++; continue; }
        const t = c.tsMs[i];
        if (lowerMs > 0 && t < lowerMs) { skipped++; continue; }
        visited++;
        const flags = c.flags[i];
        view.tsMs = t; view.tsRaw = c.tsRaw.size ? c.tsRaw.get(i) : undefined;
        view.inTok = c.inTok[i]; view.outTok = c.outTok[i]; view.cachedInTok = c.cachedInTok[i]; view.cost = c.cost[i];
        view.costTrusted = (flags & 1) === 0; view.estimated = (flags & 2) !== 0;
        view.sessionId = dict[c.sessionId[i]]; view.engine = dict[c.engine[i]]; view.provider = dict[c.provider[i]]; view.model = dict[c.model[i]];
        view.currency = dict[c.currency[i]]; view.kind = dict[c.kind[i]]; view.note = dict[c.note[i]];
        fn(view);
      }
    }
  }
  // 视图:字段在构造时一次定形(defineProperty 之后再挂字段会让 V8 把对象降成字典模式,每行十几次读写全变慢);
  // ts 走原型上的 getter,按需拼规范串。tsRaw:只有原值不是 toISOString 规范写法时才有值(回退路径下恒为原值)——
  // 需要原样回显 ts 的地方(看板 byModel.lastAt)用 tsRaw ?? 规范串,免得每行都拼一次串。
  class UsageRowView {
    constructor() {
      this.tsMs = 0; this.tsRaw = undefined;
      this.inTok = 0; this.outTok = 0; this.cachedInTok = 0; this.cost = 0;
      this.costTrusted = true; this.estimated = false;
      this.sessionId = undefined; this.engine = undefined; this.provider = undefined; this.model = undefined;
      this.currency = undefined; this.kind = undefined; this.note = undefined;
    }
    get ts() { return this.tsRaw !== undefined ? this.tsRaw : new Date(this.tsMs).toISOString(); }
  }
  // 自 seq 之后账本变过哪些会话(先刷新一次缓存)。seq 为 null / 早于日志下限 → all。返回的 seq 是刷新之后的当前序号。
  async function usageLedgerChangesSince(seq) {
    if (usageLedgerCacheDisabled()) return { seq: 0, all: true, sessionIds: new Set() };
    try { await refreshUsageLedgerCache(); } catch { /* 刷新失败:按当前已知的回答 */ }
    const current = usageLedgerCache.changeSeq;
    if (seq == null || !Number.isFinite(seq) || seq < usageLedgerCache.changeFloor) return { seq: current, all: true, sessionIds: new Set() };
    const sessionIds = new Set();
    let all = false;
    for (const entry of usageLedgerCache.changeLog) {
      if (entry.seq <= seq) continue;
      if (entry.all) { all = true; break; }
      for (const id of entry.ids) sessionIds.add(id);
    }
    return { seq: current, all, sessionIds };
  }
  function usageLedgerCacheStats() {
    let rows = 0, residentBytes = 0;
    for (const entry of usageLedgerCache.months.values()) { rows += entry.cols.n; residentBytes += entry.cols.cap * USAGE_CACHE_ROW_BYTES; }
    return { ...usageLedgerCache.stats, months: usageLedgerCache.months.size, rows, residentBytes, dictSize: usageLedgerCache.dict.length };
  }

  return Object.freeze({
    appendUsageLedger, flushUsageLedgerSync, forEachUsageRow, readUsageRows, usageLedgerCacheStats,
    usageLedgerChangesSince, usageDayKey, usageDayKeyMemo, usageRangeLowerMs,
  });
}

module.exports = { createUsageLedger };
