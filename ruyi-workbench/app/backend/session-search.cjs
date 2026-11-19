'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { runKeyedChain } = require('./keyed-chain.cjs');
const { redact } = require('./secret-redaction.cjs');
const { createRetrievalCorpusCache, rankRetrievalCorpus, retrievalTerms } = require('./retrieval-index.cjs');

const SESSION_SEARCH_MIN_QUERY = 2;

// 不进索引的行:系统行(压缩标记、修复说明、后台任务回执)、带 backgroundJobId 的回执、以及以「完成通知 /
// system-reminder」开头的注入文本 —— 它们不是用户说过或看过的话,进了索引只会让搜索命中一堆不相干的会话。
function sessionSearchRowIsNoise(row) {
  if (!row || typeof row !== 'object') return true;
  if (row.role !== 'user' && row.role !== 'assistant') return true;
  if (row.backgroundJobId || row.source === 'compact' || row.hidden === true) return true;
  if (row.meta && row.meta.origin === 'agent_wake') return true;   // 后台代理唤醒通知:系统文字,不是这条会话「干过什么」的信号
  const text = typeof row.content === 'string' ? row.content.trimStart() : '';
  return /^(?:\[(?:代理完成通知|后台任务完成通知|后台任务|工具结果)|<system-reminder>)/.test(text);
}

function createSessionSearch({ paths, nowIso, atomicWriteJson, sessionBodyPaths, sessionBriefOf, listSessions }) {
  // ── 113b: 会话内容搜索 ────────────────────────────────────────────────────────────────────────
  // 摸底口径:侧栏搜索此前是纯前端子串过滤,只看 title/summary/cwd 三个字段(session-experience.js),
  // 会话正文一个字都不查;`sessions/index.json` 也只是元数据缓存。用户「我上周让它改过那个文件」这类
  // 回忆式查找完全做不到,而这恰恰是本地工作台最该会的事 —— 历史全在本机。
  //
  // 为什么这里要落盘索引,而记忆召回那边不落:记忆的检索单元就是注册表已经读进来的头部字段,重算是
  // 微秒级;会话的检索单元要从可能几 MB 的 NDJSON 正文里抽,不缓存就是每次搜索把整个历史读一遍。
  //
  // 索引单元(v2)= 标题 + 摘要 + 【每一条】用户消息(各取开头一段)+ 助手回复(从新到旧各取开头一段),每会话 ≤ 8K 字符。
  // v1 只收首条 user 与末尾 6 条,长对话中间问过的事永远搜不到(「搜不全」);还把后台任务回执、压缩标记这类
  // 系统行也收了进来(「搜到垃圾」)。失效键 = updatedAt + messageCount(两者都在 listSessions 的元数据里,判断失效零额外 IO)。
  // 正文读取:≤ 2MB 整个读,更大的只读头尾各 1MB —— 一条几十 MB 的会话不会因为被搜索而把内存顶起来。
  // 索引文件名沿用 _search-index-v1.json(换了名旧文件就成了孤儿),版本号升到 2:旧索引读进来就是版本不符 → 全量重建。
  const SESSION_SEARCH_INDEX_FILE = '_search-index-v1.json';
  const SESSION_SEARCH_INDEX_VERSION = 2;
  const SESSION_SEARCH_UNIT_CAP = 8192;      // 每会话进索引的字符上限
  const SESSION_SEARCH_USER_CHARS = 400;     // 每条用户消息取多少
  const SESSION_SEARCH_ASSISTANT_CHARS = 240;// 每条助手回复取多少
  const SESSION_SEARCH_HEAD_BYTES = 1024 * 1024;
  const SESSION_SEARCH_TAIL_BYTES = 1024 * 1024;
  const SESSION_SEARCH_SNIPPET_RADIUS = 60;
  const SESSION_SEARCH_MAX_LIMIT = 50;

  function sessionSearchIndexPath() { return path.join(paths.sessions, SESSION_SEARCH_INDEX_FILE); }

  // 只读文件的头尾两段,中间跳过;两段都按【整行】交出去:
  //   · 文件 ≤ 头 + 尾:两段本来就盖满全文,整个读(头注「≤ 2MB 整个读」)。修前这种文件也切成两段,头段尾巴的半行 JSON 解析失败、
  //     尾段又无条件丢掉第一行 —— 恰好跨在 1MB 接缝上的那条消息两边都不要,搜它说过的话搜不到(而且与头注说的「整个读」不符);
  //   · 更大:头段停在半行里就继续往后读到行尾,尾段起点落在行中间就往前读到行首 —— 跨边界的那条消息补成完整一行。
  //     补读各有上限(NDJSON_EDGE_EXTEND_MAX):超过上限的单行(几 MB 的工具输出)才放弃,把那半行丢掉,不让它进解析。
  const NDJSON_EDGE_EXTEND_CHUNK = 64 * 1024;
  const NDJSON_EDGE_EXTEND_MAX = 2 * 1024 * 1024;
  async function readNdjsonEdges(file, headBytes, tailBytes) {
    let fh = null;
    try {
      const st = await fsp.stat(file);
      if (!st.isFile() || st.size === 0) return { head: '', tail: '' };
      fh = await fsp.open(file, 'r');
      const size = st.size;
      const readAt = async (pos, len) => {
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, pos);
        return bytesRead === len ? buf : buf.subarray(0, bytesRead);
      };
      if (size <= headBytes + tailBytes) return { head: (await readAt(0, size)).toString('utf8'), tail: '' };
      // 头段:读满 headBytes,停在半行里就往后补到行尾。
      let headBuf = await readAt(0, headBytes);
      if (headBuf.length && headBuf[headBuf.length - 1] !== 0x0a) {
        const extra = [];
        let pos = headBytes, found = false;
        while (pos < size && pos - headBytes < NDJSON_EDGE_EXTEND_MAX) {
          const chunk = await readAt(pos, Math.min(NDJSON_EDGE_EXTEND_CHUNK, size - pos));
          if (!chunk.length) break;
          const nl = chunk.indexOf(0x0a);
          if (nl >= 0) { extra.push(chunk.subarray(0, nl + 1)); found = true; break; }
          extra.push(chunk); pos += chunk.length;
        }
        if (found) headBuf = Buffer.concat([headBuf, ...extra]);
        else { const cut = headBuf.lastIndexOf(0x0a); headBuf = cut >= 0 ? headBuf.subarray(0, cut + 1) : Buffer.alloc(0); }   // 超限的巨型单行:丢掉这半行
      }
      // 尾段:起点前一个字节不是换行 = 起点在行中间,往前补到行首。
      const tailStart = size - tailBytes;
      let tailBuf = await readAt(tailStart, tailBytes);
      const before = await readAt(tailStart - 1, 1);
      if (before.length && before[0] !== 0x0a) {
        const front = [];
        let pos = tailStart, found = false;
        while (pos > 0 && tailStart - pos < NDJSON_EDGE_EXTEND_MAX) {
          const from = Math.max(0, pos - NDJSON_EDGE_EXTEND_CHUNK);
          const chunk = await readAt(from, pos - from);
          const nl = chunk.lastIndexOf(0x0a);
          if (nl >= 0) { front.unshift(chunk.subarray(nl + 1)); found = true; break; }
          front.unshift(chunk); pos = from;
          if (pos === 0) { found = true; break; }   // 一直退到文件开头:第一行本来就从 0 开始
        }
        if (found) tailBuf = Buffer.concat([...front, tailBuf]);
        else { const cut = tailBuf.indexOf(0x0a); tailBuf = cut >= 0 ? tailBuf.subarray(cut + 1) : Buffer.alloc(0); }   // 超限:丢掉起点那半行
      }
      return { head: headBuf.toString('utf8'), tail: tailBuf.toString('utf8') };
    } catch {
      return { head: '', tail: '' };
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  function parseNdjsonRows(text) {
    const lines = String(text || '').split('\n');
    const rows = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { rows.push(JSON.parse(trimmed)); } catch { /* 半条/坏行跳过,与会话读取侧同口径 */ }
    }
    return rows;
  }

  function sessionMessageText(row) {
    if (!row || typeof row !== 'object') return '';
    const content = typeof row.content === 'string' ? row.content : '';
    if (content) return content;
    // segments 型 assistant 消息:只取文本段与工具名,不展开工具结果(那是噪声,而且可能很大)。
    const segments = Array.isArray(row.segments) ? row.segments : [];
    const parts = [];
    for (const segment of segments) {
      if (!segment) continue;
      if (typeof segment.text === 'string' && segment.text) parts.push(segment.text);
      else if (segment.type === 'tool' && segment.name) parts.push(String(segment.name));
    }
    return parts.join(' ');
  }

  async function buildSessionSearchUnit(meta) {
    const body = sessionBodyPaths(meta.id);
    const { head, tail } = await readNdjsonEdges(body.messages, SESSION_SEARCH_HEAD_BYTES, SESSION_SEARCH_TAIL_BYTES);
    const rows = [...parseNdjsonRows(head), ...parseNdjsonRows(tail)].filter(row => !sessionSearchRowIsNoise(row));   // 两段都是整行(见 readNdjsonEdges)
    // 116-5b:线程的名字与那句概括也进检索单元。它们是模型对「这条线程到底要干什么」的概括,
    // 常常用了用户原话里没打出来的词(原话「帮我分析一下AMD」/ 概括「拉 AMD 最新行情与新闻」)——
    // 顺带提召回,而不只是显示。缺席时这两段是空串,被下面的 filter(Boolean) 丢掉。
    const briefUnit = sessionBriefOf(meta);
    const parts = [meta.title || '', (briefUnit && briefUnit.title) || '', (briefUnit && briefUnit.gist) || '', meta.summary || '', meta.cwd || ''];
    let used = parts.reduce((n, part) => n + String(part).length + 1, 0);
    const seen = new Set();
    const push = (value, cap) => {
      const trimmed = String(value || '').replace(/\s+/g, ' ').trim().slice(0, cap);
      // 同一句话(重发、重试)只收一次,既不白白抬高 tf,摘录也不会像复制错了。
      if (!trimmed || seen.has(trimmed) || used >= SESSION_SEARCH_UNIT_CAP) return;
      seen.add(trimmed);
      parts.push(trimmed);
      used += trimmed.length + 1;
    };
    // 用户说过的每一句都是最强的「这条会话干过什么」信号,先收;剩下的额度给助手回复,从新到旧。
    for (const row of rows) if (row.role === 'user') push(sessionMessageText(row), SESSION_SEARCH_USER_CHARS);
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].role === 'assistant') push(sessionMessageText(rows[i]), SESSION_SEARCH_ASSISTANT_CHARS);
    return parts.filter(Boolean).join('\n').replace(/\s+/g, ' ').slice(0, SESSION_SEARCH_UNIT_CAP);
  }

  // 进程内缓存:侧栏搜索是边打字边搜(200ms 去抖),修前每敲一个字就把整份索引(会话多时十几 MB)读盘再解析一遍。
  // 按文件的 mtime + size 认新旧;本进程自己写索引时直接更新缓存。
  let sessionSearchIndexCache = null;
  async function readSessionSearchIndex() {
    try {
      const file = sessionSearchIndexPath();
      const st = await fsp.stat(file);
      const stamp = `${st.mtimeMs}|${st.size}`;
      if (sessionSearchIndexCache && sessionSearchIndexCache.stamp === stamp) return sessionSearchIndexCache.data;
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!raw || raw.version !== SESSION_SEARCH_INDEX_VERSION || !raw.entries || typeof raw.entries !== 'object') return null;
      sessionSearchIndexCache = { stamp, data: raw };
      return raw;
    } catch {
      return null; // 缺失/损坏 = 全量重建。索引是纯派生物,没有需要抢救的权威数据。
    }
  }

  // 增量刷新:只为「新会话」或「updatedAt/messageCount 变了的会话」重抽单元;删掉的会话顺带清出去。
  // 单飞:侧栏是边打字边搜,冷索引(首次/大批会话变化后)那一遍要把每个会话的正文头尾读一次、再整份写盘。修前每个并发请求
  // 各自读到同一份旧索引、各自把全部单元重抽一遍、各自整份写回(N 个请求 = N 倍读盘 + N 次互相覆盖的写)。
  // 现在按一条链串行(runKeyedChain):后到的请求等前一个建完,再拿它刚写好的索引做增量 —— 条目全都新鲜,不重抽、不重写。
  // 不是「后到的直接共用先到的结果」:各请求带的 metas 可能不同(中途新建的会话),共用会漏掉它们。
  const sessionSearchRefreshChains = new Map();
  function refreshSessionSearchIndex(metas) {
    return runKeyedChain(sessionSearchRefreshChains, 'index', () => refreshSessionSearchIndexNow(metas));
  }
  async function refreshSessionSearchIndexNow(metas) {
    const existing = (await readSessionSearchIndex()) || { version: SESSION_SEARCH_INDEX_VERSION, entries: {} };
    const entries = {};
    let changed = false;
    for (const meta of metas) {
      const prior = existing.entries[meta.id];
      const stamp = `${meta.updatedAt || ''}|${Number(meta.messageCount) || 0}`;
      if (prior && prior.stamp === stamp && typeof prior.unit === 'string') { entries[meta.id] = prior; continue; }
      entries[meta.id] = { stamp, unit: await buildSessionSearchUnit(meta) };
      changed = true;
    }
    if (!changed && Object.keys(existing.entries).length === Object.keys(entries).length) return entries;
    const payload = { version: SESSION_SEARCH_INDEX_VERSION, builtAt: nowIso(), entries };
    // 写失败不影响本次搜索结果(内存里的 entries 已经算好了),下次再试。
    // 性能批 C1:紧凑 JSON(3000 条会话时带缩进写出来有 34 MB,每次会话有变都整份重写一遍)
    const wrote = await atomicWriteJson(sessionSearchIndexPath(), JSON.stringify(payload)).then(() => true, () => false);
    if (wrote) {
      try { const st = await fsp.stat(sessionSearchIndexPath()); sessionSearchIndexCache = { stamp: `${st.mtimeMs}|${st.size}`, data: payload }; } catch { sessionSearchIndexCache = null; }
    }
    return entries;
  }

  // 摘录:取【命中查询词最多】的那一段(修前取第一个命中处 —— 常常是某个常见字碰巧出现的地方,看不出为什么命中)。
  // 出服务端前过 redact() —— 与 /api/audit 同一条脱敏路径,会话正文里粘过的 key/token 不会因为「搜了一下」就漏到响应里。
  function sessionSearchSnippet(unit, terms) {
    const source = String(unit || '');
    const lower = source.toLowerCase();
    const span = SESSION_SEARCH_SNIPPET_RADIUS * 3;
    const candidates = [];
    for (const term of terms) {
      let from = 0;
      for (let n = 0; n < 20; n++) {
        const found = lower.indexOf(term, from);
        if (found < 0) break;
        candidates.push(found);
        from = found + term.length;
      }
    }
    let at = -1, best = -1;
    for (const pos of candidates) {
      const start = Math.max(0, pos - SESSION_SEARCH_SNIPPET_RADIUS);
      const window = lower.slice(start, start + span);
      const distinct = terms.filter(term => window.includes(term)).length;
      if (distinct > best || (distinct === best && pos < at)) { best = distinct; at = pos; }
    }
    const start = at < 0 ? 0 : Math.max(0, at - SESSION_SEARCH_SNIPPET_RADIUS);
    const end = Math.min(source.length, start + span);
    const slice = source.slice(start, end);
    return redact((start > 0 ? '…' : '') + slice + (end < source.length ? '…' : ''));
  }

  // 排序(修前:词法命中与字符 n-gram 向量两路做 RRF 融合,只要沾一个字就进结果 —— 「搜到垃圾」的主因):
  //   ① 词法命中为主。一个会话要算命中,得覆盖至少一半的查询词,或者原样包含整句查询;
  //      分数 = 各词权重之和,命中在标题 / 概括里翻倍,整句原样出现、查询词全中另有加分;
  //   ② 向量(同义、拼写漂移)只补【强】命中:有词法结果时,只收分数不低于最高分六成且 ≥ 0.2 的;
  //      一条词法命中都没有时(打错字)才放宽到最高分一半且 ≥ 0.15(实测打错字的真命中在 0.3–0.5,只沾一个词的在 0.08 上下)。
  // 性能批 C1:会话搜索每敲一个字就查一次。语料(分词、df、向量)与每篇的「小写 + 空白折叠」都按条目缓存 ——
  // 条目在会话没变时是同一个对象(refreshSessionSearchIndex 原样复用),结果与逐次现算逐位相同。
  let sessionSearchCorpusCache = null;
  const sessionSearchHayMemo = new WeakMap();   // 条目对象 -> { unit, hay }
  function sessionSearchHayOf(entry) {
    const hit = sessionSearchHayMemo.get(entry);
    if (hit && hit.unit === entry.unit) return hit.hay;
    // 查询词(retrievalTerms 产出的)不含空白,所以在折叠过空白的文本里 includes 与在原文里结果相同;
    // 整句 phrase 本来就是在折叠后的文本里比。一份就够两用。
    const hay = String(entry.unit).toLowerCase().replace(/\s+/g, ' ');
    sessionSearchHayMemo.set(entry, { unit: entry.unit, hay });
    return hay;
  }
  function sessionSearchScope(indexEnabled = true) {
    return { fullText: false, mode: indexEnabled ? 'bounded_index' : 'metadata_only',
      maxCharsPerSession: SESSION_SEARCH_UNIT_CAP, userCharsPerMessage: SESSION_SEARCH_USER_CHARS,
      assistantCharsPerMessage: SESSION_SEARCH_ASSISTANT_CHARS, headBytes: SESSION_SEARCH_HEAD_BYTES, tailBytes: SESSION_SEARCH_TAIL_BYTES,
      note: '只搜索标题、摘要及有限正文索引,长会话可能遗漏;未命中不能证明从未做过。可换关键词或读取选定线程核对。' };
  }
  async function searchSessionsByContent(query, limit) {
    const q = String(query || '').trim();
    if (q.length < SESSION_SEARCH_MIN_QUERY) return { ok: true, query: q, results: [], indexed: 0, scope: sessionSearchScope(), reason: 'query_too_short' };
    const metas = await listSessions();
    const entries = await refreshSessionSearchIndex(metas);
    const byId = new Map(metas.map(meta => [meta.id, meta]));

    const documents = metas
      .filter(meta => entries[meta.id])
      .map(meta => ({ id: meta.id, text: entries[meta.id].unit }));
    if (!documents.length) return { ok: true, query: q, results: [], indexed: 0, scope: sessionSearchScope() };

    const terms = [...new Set(retrievalTerms(q).filter(term => !term.startsWith('#')))];
    const phrase = q.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
    const needed = Math.max(1, Math.ceil(terms.length / 2));
    const scores = new Map();
    // 性能批 C1:首次(或会话大批变化后)要给几千篇现算小写 + 折叠,先分片预热、每 100 篇让一次事件循环
    for (let i = 0; i < documents.length; i++) {
      sessionSearchHayOf(entries[documents[i].id]);
      if (i % 100 === 99) await new Promise(resolve => setImmediate(resolve));
    }
    for (const doc of documents) {
      const hay = sessionSearchHayOf(entries[doc.id]);
      const meta = byId.get(doc.id) || {};
      const brief = sessionBriefOf(meta);
      const titleHay = [meta.title, brief && brief.title, brief && brief.gist].filter(Boolean).join(' ').toLowerCase();
      let score = 0, matched = 0;
      for (const term of terms) {
        if (!hay.includes(term)) continue;
        matched += 1;
        const weight = Math.min(12, Math.max(2, term.length));
        score += titleHay.includes(term) ? weight * 2 : weight;
      }
      const exact = phrase.length >= 2 && hay.includes(phrase);
      if (!exact && matched < needed) continue;
      if (exact) score += 30;
      if (terms.length && matched === terms.length) score += 10;
      scores.set(doc.id, score);
    }
    const lexical = [...scores.entries()].map(([id, score]) => ({ id, score }));

    if (!sessionSearchCorpusCache) sessionSearchCorpusCache = createRetrievalCorpusCache();
    const corpus = await sessionSearchCorpusCache.build(documents);
    const vector = rankRetrievalCorpus(corpus, q);
    const top = vector.length ? vector[0].score : 0;
    const floor = lexical.length ? Math.max(0.2, top * 0.6) : Math.max(0.15, top * 0.5);
    const extra = vector.filter(row => !scores.has(row.id) && row.score >= floor);

    const updatedOf = id => String((byId.get(id) || {}).updatedAt || '');
    lexical.sort((a, b) => b.score - a.score || updatedOf(b.id).localeCompare(updatedOf(a.id)) || String(a.id).localeCompare(String(b.id)));
    const ranked = [
      ...lexical.map(row => ({ id: row.id, score: row.score / 100, meta: byId.get(row.id) })),
      ...extra.map(row => ({ id: row.id, score: row.score / 100, meta: byId.get(row.id) })),
    ].filter(row => row.meta);

    const cap = Math.min(SESSION_SEARCH_MAX_LIMIT, Math.max(1, Number(limit) || 20));
    return {
      ok: true,
      query: q,
      indexed: documents.length,
      scope: sessionSearchScope(),
      results: ranked.slice(0, cap).map(row => ({
        id: row.id,
        title: row.meta.title || '',
        // 116-5b(§11.8.5):线程的名字与一句概括。**缺席时这两个键不出现** —— 存量会话的
        // /api/sessions/search 载荷逐字节不变。title 仍是原话(它是权威,也是 hover 全文与回退)。
        // 加在这里而不是让调用方自己去 /api/sessions 里 join:这条响应从此自足,
        // 只拿到搜索结果的消费者(经典壳搜索、将来的任何面)不必再取一次会话列表。
        ...(sessionBriefOf(row.meta) ? { briefTitle: sessionBriefOf(row.meta).title, briefGist: sessionBriefOf(row.meta).gist } : {}),
        cwd: row.meta.cwd || '',
        updatedAt: row.meta.updatedAt || '',
        pinned: Boolean(row.meta.pinned),
        messageCount: Number(row.meta.messageCount) || 0,
        score: Number(row.score.toFixed(6)),
        snippet: sessionSearchSnippet(entries[row.id].unit, terms),
      })),
    };
  }

  return { sessionSearchScope, searchSessionsByContent };
}

module.exports = { createSessionSearch, SESSION_SEARCH_MIN_QUERY, sessionSearchRowIsNoise };
