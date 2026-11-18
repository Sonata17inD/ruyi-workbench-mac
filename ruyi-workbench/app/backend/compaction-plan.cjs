'use strict';

const crypto = require('node:crypto');
const CONTEXT_GOVERNANCE_RULES = require('./context-governance-rules.json');
const { historyUnitStarts, userBlockStarts, EVAPORATED_PREFIX, READ_DEDUP_PREFIX, COMPACTION_TOOL_INDEX_HEADER } =
  require('./provider-history.cjs');
const { summarySectionLocations } = require('./summary-format.cjs');
const { observationRecallEnabled, reseedTailUnitsEnabled, reseedReattachFilesEnabled } = require('./runtime-policy.cjs');

// L2 重播种保留的近期原文上限。它是绝对上限而非「保留最近 N 回合」：两回合可能只有几百
// token，也可能夹着几十 K 的工具结果。调用点还会钳到当次压缩预算的一半，避免小窗口被尾部反撑爆。
// 只保留完整 user 回合；若最新一整回合本身放不下，宁可交给结构化摘要，也绝不从 tool_call/tool_result
// 组中间切开，避免把协议历史重播成孤儿。
const COMPACT_RESEED_TAIL_MAX_TOKENS = CONTEXT_GOVERNANCE_RULES.summary.reseedTailMaxTokens;
// 第104波：所有自动压缩入口共享同一份不可变计划语义。计划只计算预算、完整回合尾部与
// 重播种形状；摘要执行、持久化和事件仍由各 owner 负责，因此不会把副作用重新揉成一团。
// 重播种时钉住的「原始任务」正文。两个坑:
//   · 第二次及以后的 L2:历史首条 user 就是上一次重播种写的「原始任务 + 旧摘要」。整条再钉一遍,旧摘要就一层套一层
//     越积越长(新摘要本来就覆盖了旧摘要)—— 只取出其中原始任务那一段;
//   · 带图片的首问:content 是 parts 数组,String() 出来是「[object Object],[object Object]」—— 拍平成文字、图片记一笔。
const COMPACTION_TASK_PREFIX = '原始任务(保持聚焦):\n';
const COMPACTION_HISTORY_PREFIX = '最初请求(仅作历史来源,是否仍有效以摘要目标为准):\n';
// 手动压缩(runProviderCompact 的 L2)塌成 [摘要, 收到] 时首条 user 的开头。
const MANUAL_COMPACTION_SUMMARY_HEADER = '(以下是此前对话的压缩摘要)\n';

function compactionTaskText(message) {
  const content = message && message.content;
  let text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      return /image/i.test(String(part.type || '')) ? '[图片]' : '';
    }).filter(Boolean).join('\n')
    : String(content == null ? '' : content);
  if (text.startsWith(COMPACTION_TASK_PREFIX) || text.startsWith(COMPACTION_HISTORY_PREFIX)) {
    const prefix = text.startsWith(COMPACTION_TASK_PREFIX) ? COMPACTION_TASK_PREFIX : COMPACTION_HISTORY_PREFIX;
    const body = text.slice(prefix.length);
    const cut = body.indexOf('\n\n【压缩摘要');
    text = cut >= 0 ? body.slice(0, cut) : body;
  } else if (text.startsWith(MANUAL_COMPACTION_SUMMARY_HEADER)) {
    // 手动 L2 之后没有单独的原始任务:取旧摘要的【目标】一节代替。修前整条(旧摘要 + 旧工具索引)被当成任务原文钉一遍,
    // 下一次自动 L2 的重播种里索引出现两份(多约 4K 字)。没有【目标】节就取索引之前的正文、截到 1200 字。
    const body = text.slice(MANUAL_COMPACTION_SUMMARY_HEADER.length);
    const sections = summarySectionLocations(body);
    const goal = sections.find(section => section.index === 0);
    const end = goal && sections.find(section => section.pos > goal.pos);
    text = goal ? body.slice(goal.pos, end ? end.pos : body.length).trim() : body.split('\n\n' + COMPACTION_TOOL_INDEX_HEADER)[0].slice(0, 1200);
  }
  return text;
}
// ── 压缩摘要后附的「已执行工具调用」机器索引 ──────────────────────────────────────────────────────────────
// 2026-10(用户转来的本机 agent 评估):L2 摘要是五节自然语言,写不写工具清单由摘要模型定;被摘要掉的那段历史里「调过什么、
// 得到过什么」在模型可见面上就没有任何记录了,而快照里的原件也因为没有 rawRef 够不着(105a 的恢复索引只认历史里还在的缩减
// 视图,L2 之后为空)。网页、接口、一次性命令、子代理交付这类结果事后重跑复现不了 —— 「既没写进摘要、又够不着」正是那个洞。
// 这里在摘要后面确定性地附一张有界索引:被摘要掉那段里的每次工具调用(名字 + 关键参数 + 结果大小/失败),能回捞的带 rawRef
// (observation_recall 取回当时的原文)。不调模型、不改摘要内容;名额不够时先让出「可重跑的」(读本地文件之类),一次性的留到最后。
// 上一次压缩留下的索引行原样并进来(更早的在前),反复压缩也不丢锚点。
// rawRef 只在观察回捞开着、且快照是带内容哈希的那种(reducer 开时才写)时给:
//   · 内容里已经带 rawRef(本轮或更早的 L1 缩减视图、111e 去重指针)→ 沿用它,它指向当时的原件;
//   · 否则内容自快照以来没动过(reducer 开时 L1 要么缩成带 rawRef 的视图、要么原样不动)→ 按本次快照算 rawRef。
const COMPACTION_TOOL_INDEX_MAX_ENTRIES = 30;
const COMPACTION_TOOL_INDEX_MAX_CHARS = 4000;
const COMPACTION_TOOL_INDEX_SKIP = new Set(['todo_write', 'scratchpad_write', 'tool_search', 'tool_load', 'list_tools', 'observation_recall', 'checkpoint_list']);
// 事后重跑复现不了的那一类:联网、命令/脚本、子代理、桌面/浏览器操作;桥接的外部 MCP 工具(名字带 __)一律算。
const COMPACTION_TOOL_INDEX_ONESHOT = /__|^(web_fetch|web_search|http_request|http_download|powershell_run|script_run|shell_start|shell_poll|shell_send|orchestrate_agents|agent_result|wait_agents)$|^(desktop|browser)_/;
const COMPACTION_RAWREF_PATTERN = /history:\d+:[a-f0-9]{16}:\d+:[a-f0-9]{16}/;
// keepTail:路径类参数掐中间、留尾巴 —— 文件名在尾部,Windows 的临时目录/工作区前缀一长,从尾部截就只剩盘符和用户目录。
function compactionIndexText(value, max, keepTail = false) {
  const flat = String(value == null ? '' : value).replace(/\s+/g, ' ').replace(/</g, '＜').replace(/>/g, '＞').trim();
  if (flat.length <= max) return flat;
  if (!keepTail) return flat.slice(0, max) + '…';
  const head = Math.min(12, Math.floor(max / 4));
  return flat.slice(0, head) + '…' + flat.slice(flat.length - (max - head - 1));
}
const COMPACTION_PATH_ARG_KEYS = new Set(['path', 'paths', 'dest', 'from', 'to', 'cwd', 'file', 'filePath', 'dir']);
function compactionToolArgsDigest(rawArgs) {
  let args = null;
  try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs; } catch { args = null; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return compactionIndexText(rawArgs, 80);
  const preferred = ['path', 'url', 'query', 'command', 'task', 'name', 'pattern', 'paths', 'runId', 'nodeId', 'workflowId', 'dest', 'from', 'to', 'code'];
  const keys = [...preferred.filter(k => Object.prototype.hasOwnProperty.call(args, k)), ...Object.keys(args).filter(k => !preferred.includes(k))];
  const parts = [];
  for (const key of keys) {
    const v = args[key];
    if (v == null || v === '' || typeof v === 'boolean') continue;
    const text = Array.isArray(v) ? v.slice(0, 3).map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(',') : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    parts.push(key + '=' + compactionIndexText(text, 60, COMPACTION_PATH_ARG_KEYS.has(key)));
    if (parts.length >= 2) break;
  }
  return parts.join(' ');
}
// history:要摘要的那段所在的历史(L1 之后、重播种之前);upto:被摘要掉的部分是 history[0..upto)。
// 返回 '' = 没有可列的调用。opts.scratchpadHint:主会话(有草稿本)时多一句「要原样留着的写进草稿本」。
function buildCompactionToolIndex(history, opts = {}) {
  const list = Array.isArray(history) ? history : [];
  const upto = Math.max(0, Math.min(list.length, Number.isFinite(Number(opts.upto)) ? Number(opts.upto) : list.length));
  const config = opts.config || {};
  const refPrefix = String(opts.rawRefPrefix || '');
  const canRecall = observationRecallEnabled(config) && /^history:\d+:[a-f0-9]{16}$/.test(refPrefix);
  // 结果按「assistant 之后紧跟的那串 tool 消息」就近配对:有的服务商每次迭代都从 call_1 起编,全局按 id 取第一条会把后面的
  // 调用都配到第一次的结果上(算出同一个 rawRef 再被下面的去重丢掉)—— 而被丢的恰是要保护的一次性调用。
  // 紧跟的那串里找不到(中间夹了插话之类)再往后找,到下一次复用同一 id 的 assistant 为止。
  const resultIndexFor = (assistantAt, id) => {
    let j = assistantAt + 1;
    for (; j < upto && list[j] && list[j].role === 'tool'; j++) if (String(list[j].tool_call_id || '') === id) return j;
    for (; j < upto; j++) {
      const m = list[j];
      if (!m) continue;
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some(c => String((c && c.id) || '') === id)) return null;
      if (m.role === 'tool' && String(m.tool_call_id || '') === id) return j;
    }
    return null;
  };
  // 上一次压缩留下的索引行(在摘要那条 user 消息里),更早的在前。
  const entries = [];
  const seenRefs = new Set();
  for (let i = 0; i < upto; i++) {
    const m = list[i];
    if (!m || m.role !== 'user' || typeof m.content !== 'string' || !m.content.includes(COMPACTION_TOOL_INDEX_HEADER)) continue;
    const lines = m.content.slice(m.content.indexOf(COMPACTION_TOOL_INDEX_HEADER) + COMPACTION_TOOL_INDEX_HEADER.length).split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!line.startsWith('- ')) break;
      const ref = (line.match(COMPACTION_RAWREF_PATTERN) || [])[0] || '';
      if (ref && seenRefs.has(ref)) continue;
      if (ref) seenRefs.add(ref);
      entries.push({ line, oneShot: true, ref });
    }
  }
  for (let i = 0; i < upto; i++) {
    const m = list[i];
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const call of m.tool_calls) {
      const name = String((call && call.function && call.function.name) || '');
      if (!name || COMPACTION_TOOL_INDEX_SKIP.has(name)) continue;
      const callId = String((call && call.id) || '');
      const at = callId ? resultIndexFor(i, callId) : null;
      const result = at == null ? null : list[at];
      const content = result && typeof result.content === 'string' ? result.content : '';
      const reducedChars = (content.match(/originalChars["=:\s]*(\d+)/) || [])[1];   // 缩减视图(文本头或 _ruyiObservation 对象)记着原件大小
      const size = reducedChars ? Number(reducedChars) : content.length;
      const failed = /"ok"\s*:\s*false/.test(content.slice(0, 400));
      let ref = '';
      if (canRecall && content) {
        ref = (content.match(COMPACTION_RAWREF_PATTERN) || [])[0] || '';
        if (!ref && !content.startsWith(EVAPORATED_PREFIX)) ref = `${refPrefix}:${at}:${crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)}`;
      }
      if (ref && seenRefs.has(ref)) continue;
      if (ref) seenRefs.add(ref);
      const digest = compactionToolArgsDigest(call && call.function && call.function.arguments);
      const outcome = result == null ? '无结果' : (failed ? '失败' : `${size} 字`);
      const line = `- ${compactionIndexText(name, 60)}${digest ? ' ' + digest : ''} → ${outcome}${ref ? ' · rawRef=' + ref : ''}`;
      entries.push({ line, oneShot: COMPACTION_TOOL_INDEX_ONESHOT.test(name), ref });
    }
  }
  if (!entries.length) return '';
  // 名额:条数与字数都有上限。超了先丢最早的「可重跑」条目,没有了再丢最早的。
  const total = () => entries.reduce((n, e) => n + e.line.length + 1, 0);
  while (entries.length > COMPACTION_TOOL_INDEX_MAX_ENTRIES || (entries.length > 1 && total() > COMPACTION_TOOL_INDEX_MAX_CHARS)) {
    const drop = entries.findIndex(e => !e.oneShot);
    entries.splice(drop >= 0 ? drop : 0, 1);
  }
  const anyRef = entries.some(e => e.ref);
  const footer = [
    anyRef
      ? '需要某条的确切原文时,调用 observation_recall({rawRef}) 取回当时的原始输出(只读);没有 rawRef 的已不可回捞,要用确切内容就重新读取 / 重新调用(网页、接口、命令的结果可能已经变了)。'
      : '这些调用的原文已不可回捞;要用确切内容就重新读取 / 重新调用(网页、接口、命令的结果可能已经变了)。',
    opts.scratchpadHint ? '之后还要原样用到的数字、链接、ID、rawRef,可以用 scratchpad_write 记下 —— 草稿本跨压缩保留。' : '',
  ].filter(Boolean).join('\n');
  return COMPACTION_TOOL_INDEX_HEADER + '\n' + entries.map(e => e.line).join('\n') + '\n' + footer;
}

function createCompactionPlan({ estimateHistoryTokens, estimateTextTokens, providerContextWindow, providerConversationContextWindow }) {
  // L2 SUMMARY RESEED boundary. Keep as many complete recent user turns as fit `maxTailTokens`; all older
  // history is represented by the structured summary. A kept slice always starts at role:'user', so it cannot
  // orphan an assistant tool_call or its tool result. If the newest whole user turn alone exceeds the cap,
  // return history.length: it remains in the summary instead of violating the fixed-tail budget.
  function recentTurnsBoundary(history, maxTailTokens, byUnits) {
    if (!Array.isArray(history)) return 0;
    const cap = Math.max(0, Math.floor(Number(maxTailTokens == null ? COMPACT_RESEED_TAIL_MAX_TOKENS : maxTailTokens) || 0));
    if (!cap) return history.length;
    const starts = userBlockStarts(history);
    let boundary = history.length, keptTokens = 0;
    for (let i = starts.length - 1; i >= 0; i--) {
      const begin = starts[i], end = starts[i + 1] || history.length;
      const turnTokens = estimateHistoryTokens(history.slice(begin, end));
      if (keptTokens + turnTokens > cap) break;
      keptTokens += turnTokens;
      boundary = begin;
    }
    // 126-111b:**最新一整个 user 回合放不下时,今天一条都不留**(boundary 停在 history.length ->
    // kept = [])。一个 user 回合里带几十个工具往来是常态,于是「摘要 + 一句收到」之后模型手里
    // 什么都没有 —— 它刚做过的事全靠摘要转述。
    //
    // 开关开时退化为**按单元**从尾部装:单元起点＝非 tool 的那一条(historyUnitStarts,与 111a 同一个
    // 原语),所以切口天然落在「assistant(tool_calls) ＋ 其全部 tool 回复」的头上,**永远不劈开配对**。
    // 只在「一个 user 回合都装不下」这一种情况下才退化 —— 装得下时逐字节走上面那条老路。
    // `byUnits` 是【已经过开关把门的】布尔(判定口在 01c 的 reseedTailUnitsEnabled),本函数不读开关:
    // 与 111a 的 boundaryBudget 同一个模具,也是为了让静态件能把它原样切出来跑。
    if (byUnits === true && boundary === history.length && history.length) {
      const unitStarts = historyUnitStarts(history);
      let unitKept = 0;
      for (let i = unitStarts.length - 1; i >= 0; i--) {
        const begin = unitStarts[i], end = unitStarts[i + 1] || history.length;
        const unitTokens = estimateHistoryTokens(history.slice(begin, end));
        if (unitKept > 0 && unitKept + unitTokens > cap) break;
        unitKept += unitTokens;
        boundary = begin;
      }
    }
    return boundary;
  }

  // 126-111c: 重播种后重附最近读过的文件。
  //
  // 现状:L2 把整段历史换成「摘要 user ＋ 一句收到 ＋ 尾部」。摘要里也许写着「改了 a.js 的第 40 行」,
  // 但**文件长什么样已经不在上下文里了** —— 模型下一步要么凭记忆改、要么把同一个文件再读一遍。
  //
  // 做法:重播种那一刻【完整历史还在手里】,尾部那些 file_read 的全文就在里面 —— 直接从它取。
  // **零磁盘读取**(派单稿原写的是从 105a 快照 rehydrateObservation 取 —— 那等于把手里已经有的东西
  // 再从盘上读一遍;而且压缩是热路径,能不碰盘就不碰)。取不到全文的(已被蒸发成占位/缩减视图)
  // 直接跳过 —— 它本来就已经不在模型眼前了,重附它不是「接着用」,是凭空塞回来。
  //
  // 有界:按 path 去重取最新一次,每个文件只带头部若干行,整块过 reattach 预算与文件数上限;
  // 三个数全在 rules.compactionPlan 里(值域唯一)。
  function recentFileReads(history, budgetTokens) {
    const rules = CONTEXT_GOVERNANCE_RULES.compactionPlan;
    const cap = Math.max(0, Math.min(rules.reattachMaxTokens, Math.floor(Number(budgetTokens) * rules.reattachRatio)));
    if (!Array.isArray(history) || !history.length || !cap) return [];
    const byPath = new Map();   // path -> { path, head }(后写覆盖前写 = 取最新一次)
    for (const m of history) {
      if (!m || m.role !== 'tool' || typeof m.content !== 'string') continue;
      if (m.content.startsWith(EVAPORATED_PREFIX) || m.content.startsWith(READ_DEDUP_PREFIX)) continue;
      let parsed = null;
      try { parsed = JSON.parse(m.content); } catch { continue; }
      if (!parsed || parsed.ok !== true) continue;
      const filePath = typeof parsed.path === 'string' ? parsed.path : '';
      const body = typeof parsed.content === 'string' ? parsed.content : '';
      if (!filePath || !body) continue;
      // 先 delete 再 set:`Map.set` 对**已存在**的键不会把它挪到末尾 —— 不删的话「同一个文件又读了
      // 一遍」在插入序里仍停在老位置,于是下面 reverse 出来的「最近优先」是假的(判据 B3 当场逮到)。
      byPath.delete(filePath);
      byPath.set(filePath, { path: filePath, head: body.split(/\r?\n/).slice(0, rules.reattachHeadLines).join('\n') });
    }
    // 最近读的排前面(Map 保插入序,后写的在后 —— 反过来即最近优先)。
    const ordered = [...byPath.values()].reverse().slice(0, rules.reattachMaxFiles);
    const picked = [];
    let used = 0;
    for (const file of ordered) {
      const cost = estimateTextTokens(file.path + '\n' + file.head);
      if (picked.length && used + cost > cap) break;   // 至少带一个,否则预算一紧整块消失
      used += cost;
      picked.push(file);
    }
    return picked;
  }

  const defaults = CONTEXT_GOVERNANCE_RULES.compactionPlan;
  function create(options = {}) {
    const history = Array.isArray(options.history) ? options.history : [];
    const provider = options.provider || null;
    const model = String(options.model || provider && provider.model || '');
    const threshold = Number(options.config && options.config.autoCompactThreshold) || defaults.defaultThreshold;
    const window = options.conversationWindow
      ? providerConversationContextWindow(options.config || {}, provider, model)
      : providerContextWindow(provider, model);
    // 116f: budgetOverride 是可选的预算覆盖(唯一使用者:管家会话的 §11.2 预算)。不传时
    // budget === threshold * window,与本切片之前逐字节一致 —— 尾预算/边界/reseed 全部随之不变。
    const overrideBudget = Number(options.budgetOverride);
    const budget = Number.isFinite(overrideBudget) && overrideBudget > 0 ? overrideBudget : threshold * window;
    const tailBudget = Math.max(defaults.minimumTailTokens, Math.min(
      COMPACT_RESEED_TAIL_MAX_TOKENS,
      Math.floor(budget * defaults.tailBudgetRatio)
    ));
    // 126-111b:开关在这儿把门(与 111a 的 boundaryBudget 同一个模具)。
    const boundary = recentTurnsBoundary(history, tailBudget, reseedTailUnitsEnabled(options.config));
    const task = history.find(message => message && message.role === 'user') || history[0] || null;
    return Object.freeze({
      schema: 1,
      scope: options.scope === 'subagent' ? 'subagent' : 'main',
      trigger: String(options.trigger || 'auto'),
      threshold,
      window,
      budget,
      tailBudget,
      boundary,
      task,
      kept: boundary <= 0 ? [] : history.slice(boundary),
      // 126-111c:开关在这儿把门(与 111a/111b 同一个模具)。关时恒为空数组 -> reseed 零注入。
      recentFiles: reseedReattachFilesEnabled(options.config) ? recentFileReads(history, budget) : [],
    });
  }
  // extras.toolIndex:buildCompactionToolIndex 的结果('' / 缺省 = 不附,重播种逐字节同修前)。
  function reseed(plan, summary, extras) {
    const forced = plan && plan.trigger === 'forced_400';
    const subagent = plan && plan.scope === 'subagent';
    const heading = forced ? '【压缩摘要｜因上下文超限重播种】' : '【压缩摘要】';
    const acknowledgement = subagent
      ? '已了解原任务与以上摘要,继续推进。'
      : (forced ? '收到,已基于摘要继续。' : '收到，已基于摘要继续。');
    const kept = (plan && plan.kept) || [];
    // 126-111b:按单元退化保留时,kept 可能以 assistant 打头(「assistant(tool_calls) ＋ 其 tool 回复」
    // 就是一个完整单元)。直接拼上去会出现 [assistant(收到), assistant(tool_calls)] 两条连续 assistant,
    // 破部分 provider 的交替契约 —— 所以插一条桥接 user 消息把话头接回来。
    const bridged = kept.length && kept[0] && kept[0].role === 'assistant'
      ? [{ role: 'user', content: '以下为摘要之后保留的最近工具往来,接续执行。' }, ...kept]
      : kept;
    // 126-111c:最近读过的文件有界重附。**并进摘要那一条 user,不单列一条** —— 单列会造成
    // 两条连续 user(它后面跟着的要么是桥接 user、要么是 kept 的首条 user),破部分 provider 的
    // 交替契约;本函数上方那条注释早就为「钉住原始 task」踩过同一个坑,做法逐字相同。
    // 开关关时 recentFiles 恒为空数组 -> 这一段整个不出现,reseed 逐字节不变。
    const files = (plan && plan.recentFiles) || [];
    const fileBlock = files.length
      ? '\n\n【最近读过的文件(节选,供接续参考;需要全文请重新读)】\n'
        + files.map(f => '--- ' + f.path + ' ---\n' + f.head).join('\n\n')
      : '';
    const indexBlock = extras && extras.toolIndex ? '\n\n' + String(extras.toolIndex) : '';
    return [
      { role: 'user', content: (subagent ? COMPACTION_TASK_PREFIX : COMPACTION_HISTORY_PREFIX) + compactionTaskText(plan && plan.task) + '\n\n' + heading + '\n' + String(summary || '') + (subagent ? '' : '\n\n接续依据:摘要中的【目标】/Goal是当前仍有效目标;结合其后保留的最近用户输入推进。补充或进度追问不取消未完目标、仍适用约束与流程;已取代、取消或完成的目标仅是历史,不得恢复。') + fileBlock + indexBlock },
      { role: 'assistant', content: acknowledgement },
      ...bridged,
    ];
  }
  function snapshot(plan) {
    return {
      schema: plan.schema, scope: plan.scope, trigger: plan.trigger,
      threshold: plan.threshold, window: plan.window, budget: plan.budget,
      tailBudget: plan.tailBudget, boundary: plan.boundary, keptCount: plan.kept.length,
    };
  }
  return { CompactionPlan: Object.freeze({ create, reseed, snapshot }), recentTurnsBoundary, recentFileReads };
}

module.exports = {
  createCompactionPlan, compactionTaskText, buildCompactionToolIndex, compactionToolArgsDigest,
  COMPACT_RESEED_TAIL_MAX_TOKENS, MANUAL_COMPACTION_SUMMARY_HEADER,
};
