'use strict';
const { createRetrievalCorpusCache, rankRetrievalCorpus, reciprocalRankFusion } = require('./retrieval-index.cjs');

function createMemoryRecall({ memoryVectorRecallEnabled, defaultLimit: MEMORY_RELEVANCE_MAX = 8 }) {
const MEMORY_QUERY_STOP = new Set([
  // 英文:冠词/连词/介词/代词/助动词/疑问词/高频副词与口语动词
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'please', 'help', 'look', 'check', 'today',
  'a', 'an', 'or', 'but', 'nor', 'so', 'if', 'then', 'than', 'as', 'at', 'by', 'of', 'on', 'in', 'to', 'up', 'out', 'off', 'over',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'done', 'doing', 'has', 'have', 'had', 'having',
  'it', 'its', 'he', 'she', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours', 'they', 'them', 'their', 'theirs', 'me', 'my', 'mine', 'him', 'her', 'his', 'hers',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must', 'cannot',
  'how', 'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'not', 'no', 'yes', 'any', 'all', 'some', 'each', 'every', 'both', 'more', 'most', 'much', 'many', 'few', 'other', 'another', 'such', 'same',
  'about', 'after', 'before', 'again', 'also', 'just', 'only', 'very', 'too', 'here', 'there', 'now', 'still', 'even', 'ever', 'once', 'because', 'while', 'between', 'through', 'under', 'against', 'without', 'within',
  'get', 'got', 'gets', 'let', 'lets', 'use', 'used', 'using', 'make', 'made', 'want', 'wants', 'need', 'needs', 'try', 'tried', 'see', 'show', 'tell', 'give', 'take', 'put', 'say', 'said', 'know', 'like', 'new', 'one', 'two',
  'thing', 'things', 'something', 'anything', 'really', 'maybe', 'okay', 'thanks', 'thank', 'hello', 'hi',
  // 词首前缀匹配后 "work" 会命中 worktree / workflow / workspace 这类条目(「how does closures work」召回 worktree 清理)—— 泛动词,不当检索词
  'work', 'works', 'working', 'worked',
  // 中文(二元组口径:词项是拿去在 name/description 上做子串匹配的,「什么 / 怎么 / 说明 / 文件 / 代码 / 问题」这类
  // 几乎每句提问和每条描述里都有的词,单靠一个就能把无关条目拉进候选 —— 走查实测「提交代码时的说明文字怎么写」把「订单表字段说明」
  // 召回、还排在真正的提交规范前面。这里只收「对检索几乎零区分度」的虚词/泛指名词/口语动词;领域词(部署/日志/编码/超时…)不收)
  '用户', '帮我', '看下', '看看', '这个', '那个', '今天', '现在', '可以', '直接', '继续', '推进', '一下', '相关',
  '什么', '怎么', '怎样', '如何', '为何', '是否', '能否', '可否', '多少', '几个', '有没', '没有', '是不', '不是', '还是', '或者', '以及', '并且', '而且', '因为', '所以', '但是', '如果', '然后', '就是', '这样', '那样', '这里', '那里',
  '我们', '你们', '他们', '它们', '自己', '已经', '一个', '一些', '有些', '这些', '那些', '这种', '那种', '这段', '那段', '这次', '上次', '下次', '一样', '的话', '之后', '之前', '目前', '当前', '以下', '以上', '下面', '上面', '其他', '其它',
  '说明', '文件', '代码', '问题', '内容', '东西', '方面', '情况', '时候', '事情', '部分', '地方', '方法', '办法', '结果', '需要', '应该', '必须', '可能', '比较', '非常', '特别', '一般', '通常', '还有', '另外', '关于', '对于',
  '请问', '麻烦', '帮忙', '告诉', '查看', '检查', '处理', '进行', '使用', '完成', '开始', '结束', '好的', '谢谢', '感谢', '知道', '了解', '觉得', '感觉', '希望', '想要', '想让', '能不', '会不',
]);
// 中文里几乎不出现在实义词内部的语气/结构助词:含它们的二元组(「时的」「的说」「怎么样」里的「么样」)是跨词边界的碎片,不当词项。
const MEMORY_QUERY_CJK_PARTICLES = /[的吗呢吧啊呀么]/;
// 词项总预算 96,但 ASCII 与 CJK 各自先保底 48 个:修前 ASCII 词全收完才轮到中文二元组、最后整体 slice(0,96),
// 「日志(上百个 ASCII 词)+ 中文提问」的中文词被整段截掉,召回只剩日志里的英文碎片。一边没用满,余额让给另一边(纯中文/纯英文仍是 96)。
const MEMORY_SEARCH_TERMS_MAX = 96;
function memorySearchTerms(text) {
  const src = String(text || '').normalize('NFKC').toLowerCase();
  const ascii = new Set();
  const cjk = new Set();
  for (const m of src.matchAll(/[a-z0-9][a-z0-9_.-]{1,63}/g)) {
    const term = m[0].replace(/^[_.-]+|[_.-]+$/g, '');
    if (term.length >= 2 && !MEMORY_QUERY_STOP.has(term)) ascii.add(term);
    // snake_case / kebab-case id 既保留全词也拆分，确保任务里的模块名能命中记忆 id 的稳定片段。
    for (const part of term.split(/[_.-]+/)) if (part.length >= 2 && !MEMORY_QUERY_STOP.has(part)) ascii.add(part);
  }
  for (const m of src.matchAll(/[\u3400-\u9fff]{2,32}/g)) {
    const run = m[0];
    if (run.length <= 6 && !MEMORY_QUERY_STOP.has(run)) cjk.add(run);
    for (let i = 0; i < run.length - 1; i++) {
      const pair = run.slice(i, i + 2);
      if (!MEMORY_QUERY_STOP.has(pair) && !MEMORY_QUERY_CJK_PARTICLES.test(pair)) cjk.add(pair);
    }
  }
  const half = MEMORY_SEARCH_TERMS_MAX / 2;
  const a = [...ascii];
  const c = [...cjk];
  const takeA = Math.min(a.length, half + Math.max(0, half - c.length));
  const takeC = Math.min(c.length, MEMORY_SEARCH_TERMS_MAX - takeA);
  return [...a.slice(0, takeA), ...c.slice(0, takeC)];
}
// 词项在条目头部文本(id/name/description 拼成、已 NFKC+小写)里算不算命中:
//   · CJK 二元组:子串匹配(中文没有词边界,二元组本来就是子串口径)。
//   · 带 _ . - 的 ASCII 复合词(deploy-canary、server.js):整串子串匹配(够具体,误命中面小)。
//   · 纯字母数字的 ASCII 词:【整词或词首前缀】。修前 ≥3 字符一律子串,"api" ⊂ "rapid"、"log" ⊂ "catalog"、"pre" ⊂ "prefer"
//     这类词中子串让任何英文条目都可能被误命中;词首前缀仍保住「deploy → deployment」「log → logs」这种真实变形。
//   · 2 字符的 ASCII 词(ui / ci / db / go…):只认整词("ai" ⊂ "main"、"id" ⊂ "valid")。
// words 是 hay 的字母数字词表(调用方每条目算一次,省得每个词项重复切)。
function memoryHayWords(hay) { return String(hay || '').split(/[^a-z0-9]+/).filter(Boolean); }
function memoryHaystackHasTerm(hay, term, words) {
  if (term.charCodeAt(0) > 127) return hay.includes(term);
  if (/[_.-]/.test(term)) return hay.includes(term);
  const list = words || memoryHayWords(hay);
  if (term.length < 3) return list.includes(term);
  for (const word of list) if (word.startsWith(term)) return true;
  return false;
}
// 拼写漂移(canry ↔ canary、powrshell ↔ powershell):≥5 字符的 ASCII 词与条目词表里某个词编辑距离 ≤1(≥9 字符放到 ≤2)。
// 这是词法准入的一部分而不是向量的活:余弦分在「拼写漂移的真命中」(0.12 左右)与「无关噪声」(0.12–0.20)之间没有可划的线,
// 靠向量把它拉回来就只能放开无关条目;编辑距离是确定的、可解释的、断网照用。
function memoryEditWithin(a, b, maxDist) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > maxDist) return false;
  let prev = new Array(lb + 1), cur = new Array(lb + 1), prev2 = null, prevRowMin = 0;
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      // 相邻换位(powerhsell)算 1 次
      if (prev2 && i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // 换位会从两行之前回填,所以连续两行都超界才能判死。
    if (rowMin > maxDist && prevRowMin > maxDist) return false;
    prevRowMin = rowMin;
    const reuse = prev2 || new Array(lb + 1);
    prev2 = prev; prev = cur; cur = reuse;
  }
  return prev[lb] <= maxDist;
}
function memoryHaystackFuzzyHasTerm(words, term) {
  if (term.length < 5 || term.charCodeAt(0) > 127 || /[_.-]/.test(term)) return false;
  const maxDist = term.length >= 9 ? 2 : 1;
  for (const word of words) if (word.length >= 4 && memoryEditWithin(term, word, maxDist)) return true;
  return false;
}

// 召回条数的唯一口径:undefined / null / 非数字 → 默认;0 就是 0(「每轮不补相关条目」是设置页允许的合法值,
// 修前 `Number(limit) || DEFAULT` 把 0 当成假值、实测等于 8)。
function memoryRecallLimit(limit) {
  if (limit == null || limit === '') return MEMORY_RELEVANCE_MAX;
  const n = Number(limit);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : MEMORY_RELEVANCE_MAX;
}

// 113a: 词法层的打分与排序从 rankRelevantMemories 里提出来，融合层要拿完整名次表而不只是 Top-N。
// 准入:name/description/id 上至少有一个词项命中(词项口径见 memoryHaystackHasTerm / memoryHaystackFuzzyHasTerm;hay 不含 type,
// 否则 "on" ⊂ "lesson"、"explain the lesson" 把所有 lesson 都拉进来)。拼写漂移的命中按半权计分。
// preference/convention 零命中也进候选(shared=0,调用方当「默认规则补位」处理,不算匹配)。
function rankRelevantMemoriesScored(registry, query) {
  const queryTerms = memorySearchTerms(query);
  const ranked = [];
  for (const entry of (Array.isArray(registry) ? registry : [])) {
    if (!entry || !entry.id) continue;
    const hay = [entry.id, entry.name, entry.description].filter(Boolean).join(' ').normalize('NFKC').toLowerCase();
    const words = memoryHayWords(hay);
    let shared = 0;
    for (const term of queryTerms) {
      const weight = Math.min(12, Math.max(2, term.length));
      if (memoryHaystackHasTerm(hay, term, words)) shared += weight;
      else if (memoryHaystackFuzzyHasTerm(words, term)) shared += Math.max(1, Math.floor(weight / 2));
    }
    // preference/convention 是默认应遵守的稳定规则，即使用户没复述关键词也参与候选；lesson/reference 必须命中。
    if (!shared && entry.type !== 'convention' && entry.type !== 'preference') continue;
    const score = shared * 10 + (entry.scope === 'project' ? 4 : 0) + ((entry.type === 'convention' || entry.type === 'preference') ? 2 : 0);
    ranked.push({ entry, score, shared });
  }
  ranked.sort((a, b) => b.score - a.score
    || String(b.entry.createdAt || '').localeCompare(String(a.entry.createdAt || ''))
    || String(a.entry.id).localeCompare(String(b.entry.id)));
  return ranked;
}

// Detailed 版:除了 entries 还回「哪些是默认规则补位(零命中的 preference/convention)」——
// check 行的「额外匹配 N 条」只数真命中,补位另报(修前补位也算进 matches,零命中的提问也报「匹配 1 条」)。
function rankRelevantMemoriesDetailed(registry, query, limit = MEMORY_RELEVANCE_MAX) {
  const cap = memoryRecallLimit(limit);
  const fillKeys = new Set();
  if (!cap) return { entries: [], fillKeys };
  const rows = rankRelevantMemoriesScored(registry, query).slice(0, cap);
  for (const row of rows) if (!(row.shared > 0)) fillKeys.add(memoryRetrievalKey(row.entry));
  return { entries: rows.map(x => x.entry), fillKeys };
}
function rankRelevantMemories(registry, query, limit = MEMORY_RELEVANCE_MAX) {
  return rankRelevantMemoriesDetailed(registry, query, limit).entries;
}

// ── 113a: 词法 × 向量的 RRF 融合召回（默认关）───────────────────────────────
// 词法层的两个真实缺口：同义改写（“提交信息” vs “commit 文案”）与拼写/分词差
// （“powershel” vs “powershell”）—— includes 子串判定对这两类直接落空。向量层用共现 gram 补上。
// 不用分数加权而用 RRF：词法分（命中长度×10）与余弦（0..1）不同量纲，归一化怎么调都是拍脑袋。
// 不读正文：向量化的是注册表已有的头部字段（id/name/description/coreSummary/type），
// 与词法层同一片 haystack，每轮成本仍与文件大小无关。
// 不落盘索引：语料是百到千级，重算向量是微秒级，而读+解一个几百 KB 的 JSON 索引反而更贵；
// 多一个持久化面就多一套损坏/过期处理。会话搜索那边正文提取真花钱，索引落盘在那边做。
function memoryRetrievalText(entry) {
  return [entry.id, entry.name, entry.description, entry.coreSummary, entry.type].filter(Boolean).join(' ');
}
function memoryRetrievalKey(entry) {
  return `${entry.scope}:${entry.id}`;
}

// 类型/作用域加分在融合后以 RRF 同量纲叠加。取值按“大约抬两个名次”标定：
// 首位相邻两名的 RRF 差约为 1/61-1/62 ≈ 0.00026，所以 0.0006/0.0004 分别约当于两名与一名半。
// 目的是保住今天“project 优于 global、convention/preference 优于其它”的语义，而不是让它压过相关性。
const MEMORY_FUSION_SCOPE_BONUS = 0.0006;
const MEMORY_FUSION_TYPE_BONUS = 0.0004;

// 性能批 C1:记忆召回的语料缓存(每条用户消息都会召回一次;记忆库不变时不再逐条重新分词)。
let memoryRecallCorpusCache = null;
function memoryRecallCorpus(documents) {
  if (!memoryRecallCorpusCache) memoryRecallCorpusCache = createRetrievalCorpusCache();
  return memoryRecallCorpusCache(documents);
}

// 向量层只当【重排器】,不当准入:候选集 = 词法命中(含编辑距离 ≤1 的拼写漂移)∪「向量独有但高分」的条目。
// 为什么:稀疏哈希向量在完全不相干的文本间也有 0.12–0.20 的余弦噪声,而真命中可以低到 0.10 —— 走查实测 16 条混合库上 12 个无关问句有 10 个
// 被向量层召回无关条目(「今天天气怎么样」→ git push 教训、「帮我翻译这段英文」→ 内部 wiki/镜像源),且没有任何阈值能同时留住低分真命中、
// 挡住噪声。所以真命中的准入交给词法(含拼写容错),向量只在两件事上出力:① 给词法命中项重排;② 偶尔补上词法完全没沾边、但相似度又确实高的条目。
// 向量独有候选的门槛:余弦 ≥ 0.25 且 ≥ 0.6 × 本次向量第一名。实测(2026-10,30 句无关问句):16 条混合库上噪声第一名余弦 p90 0.18 / 最大 0.20,
// 50 条夹具库上 p90 0.19 / 最大 0.22 —— 0.25 在噪声上限之上留了约 0.03 的余量(memory-recall-quality.e2e 的 D8 / unit/memory-recall-precision 的 [P]/[V] 钉着结果)。
const MEMORY_VECTOR_ONLY_MIN_SCORE = 0.25;
const MEMORY_VECTOR_ONLY_REL_SCORE = 0.6;

function rankMemoriesFusedDetailed(registry, query, limit = MEMORY_RELEVANCE_MAX) {
  const cap = memoryRecallLimit(limit);
  const fillKeys = new Set();
  const entries = (Array.isArray(registry) ? registry : []).filter(entry => entry && entry.id);
  if (!entries.length || !cap) return { entries: [], fillKeys };
  const byKey = new Map(entries.map(entry => [memoryRetrievalKey(entry), entry]));

  // 词法名次表里只放真正命中的条目。convention/preference 即使零命中也会进候选
  // （今天的语义，保留），但它们不能占着词法第一名进 RRF —— 实测过：满库的零命中规则
  // 会把向量层排第二的真命中挤出 Top-3（典型例：“canry deployment” → deploy-canary）。
  // 所以分两层：命中层参与融合排名，零命中的规则类只在没填满时补位。
  const lexicalScored = rankRelevantMemoriesScored(entries, query);
  const lexicalRanking = lexicalScored.filter(row => row.shared > 0).map(row => memoryRetrievalKey(row.entry));
  const lexicalFallback = lexicalScored.filter(row => !(row.shared > 0)).map(row => memoryRetrievalKey(row.entry));
  // 性能批 C1:语料走缓存(文档没变不重新分词;结果与 buildRetrievalCorpus 逐位相同)
  const corpus = memoryRecallCorpus(entries.map(entry => ({ id: memoryRetrievalKey(entry), text: memoryRetrievalText(entry) })));
  const vectorRows = rankRetrievalCorpus(corpus, query);
  const vectorTop = vectorRows.length ? vectorRows[0].score : 0;
  const lexicalSet = new Set(lexicalRanking);
  const vectorRanking = vectorRows
    .filter(row => lexicalSet.has(row.id) || (row.score >= MEMORY_VECTOR_ONLY_MIN_SCORE && row.score >= MEMORY_VECTOR_ONLY_REL_SCORE * vectorTop))
    .map(row => row.id);

  const takeFallback = out => {
    const taken = new Set(out.map(memoryRetrievalKey));
    for (const key of lexicalFallback) {
      if (out.length >= cap) break;
      if (taken.has(key)) continue;
      const entry = byKey.get(key);
      if (entry) { out.push(entry); taken.add(key); fillKeys.add(key); }
    }
    return out;
  };
  // 两层都没命中（空 query / 全不相干）就只剩零命中的规则类补位，不自己造候选。
  if (!lexicalRanking.length && !vectorRanking.length) return { entries: takeFallback([]), fillKeys };
  // 向量那一路只多 0.1% 权重:只在两路名次对称(词法并列、各领先一名)的【恰好平局】上让向量裁决,代替按 createdAt 抛硬币;差一个名次的差距(≈0.4%)翻不过来。
  const fused = reciprocalRankFusion([lexicalRanking, vectorRanking], { weights: [1, 1.001] });

  const ranked = [];
  for (const [key, base] of fused) {
    const entry = byKey.get(key);
    if (!entry) continue;
    const bonus = (entry.scope === 'project' ? MEMORY_FUSION_SCOPE_BONUS : 0)
      + ((entry.type === 'convention' || entry.type === 'preference') ? MEMORY_FUSION_TYPE_BONUS : 0);
    ranked.push({ entry, score: base + bonus });
  }
  // 同分时的三级比较子与词法层一致，避免两条路径在平局上给出不同顺序。
  ranked.sort((a, b) => b.score - a.score
    || String(b.entry.createdAt || '').localeCompare(String(a.entry.createdAt || ''))
    || String(a.entry.id).localeCompare(String(b.entry.id)));
  const out = ranked.slice(0, cap).map(x => x.entry);
  // 补位：零命中的 convention/preference 按词法层原序填到上限为止。
  return { entries: takeFallback(out), fillKeys };
}
function rankMemoriesFused(registry, query, limit = MEMORY_RELEVANCE_MAX) {
  return rankMemoriesFusedDetailed(registry, query, limit).entries;
}

// 召回的唯一入口：开关关时与今天逐字节相同（直接转 rankRelevantMemories）。
function rankMemoriesForRecallDetailed(registry, query, limit, config) {
  if (!memoryVectorRecallEnabled(config)) return rankRelevantMemoriesDetailed(registry, query, limit);
  return rankMemoriesFusedDetailed(registry, query, limit);
}
function rankMemoriesForRecall(registry, query, limit, config) {
  return rankMemoriesForRecallDetailed(registry, query, limit, config).entries;
}

  return { rankRelevantMemoriesScored, memorySearchTerms, memoryRetrievalKey, rankRelevantMemories, rankRelevantMemoriesDetailed, rankMemoriesFused, rankMemoriesFusedDetailed, rankMemoriesForRecall, rankMemoriesForRecallDetailed };
}
module.exports = { createMemoryRecall };
