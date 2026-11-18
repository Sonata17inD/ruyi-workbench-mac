'use strict';

const crypto = require('node:crypto');
const CONTEXT_GOVERNANCE_RULES = require('./context-governance-rules.json');
const { EVAPORATED_PREFIX, READ_DEDUP_PREFIX, COMPACTION_TOOL_INDEX_HEADER } = require('./provider-history.cjs');
const { observationRecallEnabled } = require('./runtime-policy.cjs');

// 缩减视图的两种形状(见下面 reduceObservationContent):文本结果是 `[Ruyi observation reduced …]` 头,JSON 结果是带
// `_ruyiObservation:{reduced:true,…}` 的对象(数组结果包成 {items, _ruyiObservation})。
function isReducedObservationView(content) {
  const text = String(content || '');
  return text.startsWith('[Ruyi observation reduced') || text.includes('"_ruyiObservation":{"reduced":true');
}

function createObservationReduction({ estimateHistoryTokens }) {
  const OBSERVATION_REDUCE_MIN = 1200;
  const OBSERVATION_TEXT_HEAD = 900;
  const OBSERVATION_TEXT_TAIL = 500;
  const OBSERVATION_ARRAY_SAMPLE = 8;
  const OBSERVATION_OBJECT_KEYS = 32;
  const OBSERVATION_CRITICAL_KEYS = new Set(['ok', 'error', 'errors', 'message', 'detail', 'status', 'statusCode', 'code', 'exitCode', 'stderr', 'query', 'path', 'url', 'finalUrl', 'count', 'total', 'totalLines', 'matches', 'findings', 'results']);

  function observationToolNames(history) {
    const out = new Map();
    for (const message of Array.isArray(history) ? history : []) {
      if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
      for (const call of message.tool_calls) {
        const id = call && call.id; const name = call && call.function && call.function.name;
        if (id && name) out.set(String(id), String(name));
      }
    }
    return out;
  }

  function protectedObservation(toolName, message) {
    const content = String(message && message.content || '');
    if (message && (message.pinned || message.evidenceRef || message.protected)) return 'explicit';
    if (/"ok"\s*:\s*false|"error"\s*:\s*"[^"\r\n]+|"errors"\s*:\s*\[(?!\s*\])|verification.{0,20}fail|quality.{0,12}gate|验证失败|校验失败/i.test(content)) return 'failure_evidence';
    if (/"op"\s*:\s*"(create|modify|delete|move|copy)"|checkpoint|journal/i.test(content)) return 'change_evidence';
    if (/(^|__)(file_(write|edit|delete|move|copy)|git_commit|http_download|archive_(zip|unzip))$/i.test(String(toolName || ''))) return 'mutating_tool';
    return '';
  }

  function compactObservationValue(value, key, depth) {
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const cap = /stderr|error|message|detail/i.test(String(key || '')) ? 4000 : 1800;
      if (value.length <= cap) return value;
      const head = Math.min(1200, Math.floor(cap * 0.65)); const tail = Math.min(700, cap - head);
      return value.slice(0, head) + `\n[...${value.length - head - tail} chars omitted...]\n` + value.slice(-tail);
    }
    if (depth >= 5) return `[nested value omitted at depth ${depth}]`;
    if (Array.isArray(value)) {
      const sample = value.slice(0, OBSERVATION_ARRAY_SAMPLE).map(v => compactObservationValue(v, key, depth + 1));
      if (value.length > sample.length) sample.push({ _ruyiOmittedItems: value.length - sample.length, _ruyiTotalItems: value.length });
      return sample;
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      const ordered = [...keys.filter(k => OBSERVATION_CRITICAL_KEYS.has(k)), ...keys.filter(k => !OBSERVATION_CRITICAL_KEYS.has(k))];
      const selected = ordered.slice(0, OBSERVATION_OBJECT_KEYS); const out = {};
      for (const childKey of selected) out[childKey] = compactObservationValue(value[childKey], childKey, depth + 1);
      if (keys.length > selected.length) out._ruyiOmittedKeys = keys.length - selected.length;
      return out;
    }
    return String(value);
  }

  function reduceObservationContent(toolName, content, rawRef, opts) {
    const recallEnabled = !!(opts && opts.recallEnabled);
    // 105a: 仅当 observation_recall 工具生效时在缩减视图里提示回读入口;默认关时文案逐字节不变。
    const recallHint = recallEnabled ? ' · recall=observation_recall(rawRef)' : '';
    const recallInstruction = recallEnabled
      ? 'This view is incomplete. If the task depends on exact omitted historical content, call observation_recall with rawRef before answering; do not conclude that a fact is absent from this reduced view.'
      : '';
    const original = String(content == null ? '' : content);
    if (original.length < OBSERVATION_REDUCE_MIN) return { reduced: false, content: original, policy: 'below_minimum', originalChars: original.length, visibleChars: original.length, rawRef };
    const baseName = String(toolName || '').replace(/^.+?__/, '');
    let parsed = null; try { parsed = JSON.parse(original); } catch { /* text result */ }
    let visible, policy;
    if (parsed && typeof parsed === 'object') {
      const reduced = compactObservationValue(parsed, '', 0);
      policy = /shell|powershell|script/i.test(baseName) ? 'shell_structured' : (/search|find|glob|list/i.test(baseName) ? 'search_structured' : (/web|http|fetch|download/i.test(baseName) ? 'network_structured' : 'json_structured'));
      const meta = { reduced: true, policy, originalChars: original.length, rawRef };
      if (recallEnabled) {
        meta.recall = 'observation_recall(rawRef)';
        meta.instruction = recallInstruction;
      }
      if (Array.isArray(reduced)) visible = JSON.stringify({ items: reduced, _ruyiObservation: meta });
      else {
        if (reduced && typeof reduced === 'object') reduced._ruyiObservation = meta;
        visible = JSON.stringify(reduced);
      }
    } else {
      policy = 'text_head_tail';
      visible = `[Ruyi observation reduced · policy=${policy} · originalChars=${original.length} · rawRef=${rawRef}${recallHint}]\n`
        + (recallInstruction ? `[Recovery instruction: ${recallInstruction}]\n` : '')
        + original.slice(0, OBSERVATION_TEXT_HEAD)
        + `\n[...${Math.max(0, original.length - OBSERVATION_TEXT_HEAD - OBSERVATION_TEXT_TAIL)} chars omitted...]\n`
        + original.slice(-OBSERVATION_TEXT_TAIL);
    }
    // Deep/wide JSON can still remain large after structural sampling. Apply a deterministic final envelope;
    // canonical bytes remain in the pre-compaction snapshot referenced by rawRef.
    if (visible.length > 6000) visible = visible.slice(0, 4000) + `\n[...reduced view trimmed from ${visible.length} chars...]\n` + visible.slice(-1500);
    if (visible.length >= original.length) return { reduced: false, content: original, policy: 'no_gain', originalChars: original.length, visibleChars: original.length, rawRef };
    return { reduced: true, content: visible, policy, originalChars: original.length, visibleChars: visible.length, rawRef };
  }

  // 105a model-adoption prompt: rawRef markers can sit tens of thousands of tokens behind the current
  // question. Surface a bounded current-session index next to the newest user message without persisting it
  // or copying any raw observation bytes. Only system-produced reduced tool views are eligible.
  function buildObservationRecallPrompt(history, config) {
    if (!observationRecallEnabled(config) || !Array.isArray(history)) return '';
    const refs = [];
    const seen = new Set();
    const refPattern = /history:\d+:[a-f0-9]{16}:\d+:[a-f0-9]{16}/g;
    for (const message of history) {
      if (!message || typeof message.content !== 'string') continue;
      let content = message.content;
      if (message.role === 'user') {
        // L2 之后缩减视图都被摘要掉了:压缩摘要那条 user 消息末尾的机器索引(buildCompactionToolIndex)里的 rawRef
        // 是唯一还在的回捞锚点。只认索引那几行,用户自己的话里出现的形似字符串不算。
        const at = content.indexOf(COMPACTION_TOOL_INDEX_HEADER);
        if (at < 0) continue;
        content = content.slice(at).split('\n').filter(line => line.startsWith('- ')).join('\n');
      } else if (message.role !== 'tool' || (!content.includes('[Ruyi observation reduced') && !content.includes('"_ruyiObservation"'))) continue;
      for (const match of content.matchAll(refPattern)) {
        const ref = match[0];
        if (!seen.has(ref)) { seen.add(ref); refs.push(ref); }
      }
    }
    if (!refs.length) return '';
    const visible = refs.slice(-8);
    const omitted = refs.length - visible.length;
    return '[Ruyi recovery index — runtime context, not user-authored]\n'
      + 'The reduced historical tool views below are incomplete but recoverable. If the request may depend on an exact omitted historical value or detail, call observation_recall with the relevant rawRef before answering or claiming that it is absent.\n'
      + visible.map(ref => `- rawRef=${ref}`).join('\n')
      + (omitted > 0 ? `\n- ${omitted} older recoverable reference(s) omitted from this bounded index` : '');
  }

  // v0.8-S5 LEVEL 1 · EVAPORATE. Replace the CONTENT TEXT of `role:'tool'` messages that sit BEFORE the last
  // 2 assistant turns with `[已省略:<first 120 chars of the original>]`.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────
  // PAIRING IRON LAW (OpenAI hard-validates this): every assistant.tool_calls[].id MUST have a matching
  // role:'tool' message. So we ONLY rewrite the tool message's `content` string — we NEVER delete a message
  // and NEVER touch assistant.tool_calls. Deleting a tool message (or its assistant) would make the NEXT
  // request 400 (unanswered tool_call_id). Evaporation shrinks payload without breaking the pairing.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────
  // APPEND-ONLY / CACHE ECONOMICS (§7.7): upstream (DeepSeek/DashScope) auto-caches the request PREFIX.
  // Rewriting old tool contents deliberately SMASHES that cached prefix — so evaporation is destructive to
  // the cache and MUST happen at most ONCE per threshold crossing, never speculatively. Between two
  // compactions providerHistory stays strictly append-only (no rewriting old messages) so the prefix cache
  // stays warm. Already-evaporated messages (content starts with EVAPORATED_PREFIX) are skipped so a repeat
  // pass is a no-op (idempotent) and doesn't re-smash an already-cold prefix.
  // Returns the number of tool messages evaporated on this pass (0 = nothing to do).
  // 126-111a: 历史的【单元起点】—— 一个单元 = 一条非 tool 消息 ＋ 紧随其后的全部 tool 回复。
  // 判据写成「role !== 'tool'」而不是枚举 user/assistant:tool 消息按 OpenAI 的配对铁律永远紧跟
  // 在发起它的那条 assistant 之后,所以「不是 tool 的那一条」就是单元头。这样切出来的边界天然
  // 既落在 user 起点上,也落在「assistant(tool_calls)＋其全部 tool 回复」的起点上 —— 永远不会
  // 把一条 assistant 与它的 tool 回复劈开(劈开 = 下一次请求 400)。111b 的 L2 尾部单元边界复用它。
  function historyUnitStarts(history) {
    const idx = [];
    for (let i = 0; i < history.length; i++) if (history[i] && history[i].role !== 'tool') idx.push(i);
    return idx;
  }

  // 126-111a: 按 token 预算算 L1 边界。老边界数的是「倒数第 2 条 assistant」—— 一个与上下文窗口
  // 完全无关的常数:窗口 32K 和 1M 的模型护住的观测一样多,而一条 assistant 回合可能带 1 个工具
  // 结果也可能带 60 个。改成:护住区 = clamp(l1ProtectMinTokens, l1ProtectRatio×budget,
  // l1ProtectMaxTokens),从尾部按单元往回装,装不下就停,边界落在最后一个装得下的单元起点。
  // 两条无条件的保护(都比上限优先):
  //   ① 最后一个单元无条件护住(kept 为 0 时不看上限);
  //   ② **最近一次观测无条件护住** —— 再紧也不能把【模型刚拿到、正要据此决定下一步】的那个工具
  //      结果蒸发掉。①单独是不够的:当最后一个单元是一条纯文本 assistant(回合刚收尾)时,①护住的
  //      是那句话,而它前面那条 tool 照样落进蒸发区 —— 这个洞是 C3c 那条判据**在实现写完之后**
  //      逮到的(注释里声称的不变量,代码当时并没有兑现)。
  // 两条保护合起来,让新边界在任何预算下都不比老边界更冒进(老边界护住最近 2 条 assistant,
  // 必然含最近一次观测);极端情形(最近一次观测本身就撑爆预算)下两者行为一致 —— 都让 L1 释放
  // 不了多少,于是正常升级到 L2 摘要重播种。
  function evaporateBudgetBoundary(history, budget) {
    const rules = CONTEXT_GOVERNANCE_RULES.compactionPlan;
    const protectCap = Math.min(
      rules.l1ProtectMaxTokens,
      Math.max(rules.l1ProtectMinTokens, Math.floor(budget * rules.l1ProtectRatio)),
    );
    const starts = historyUnitStarts(history);
    if (!starts.length) return 0;
    const unitEnd = i => starts[i + 1] || history.length;
    const unitHasTool = i => {
      for (let k = starts[i]; k < unitEnd(i); k++) if (history[k] && history[k].role === 'tool') return true;
      return false;
    };
    let boundary = history.length, kept = 0, keptObservation = false;
    for (let i = starts.length - 1; i >= 0; i--) {
      const unitTokens = estimateHistoryTokens(history.slice(starts[i], unitEnd(i)));
      const hasTool = unitHasTool(i);
      // 上限只对「已经护住了东西、而且已经护住过一次观测」之后的单元生效 —— 见上面 ①②。
      if (kept > 0 && keptObservation && kept + unitTokens > protectCap) break;
      kept += unitTokens;
      keptObservation = keptObservation || hasTool;
      boundary = starts[i];
      // 没有任何观测的历史(纯对话)不该为了②把整段都护住:一圈下来没见过 tool 就按上限收口。
      if (!keptObservation && kept > protectCap) break;
    }
    return boundary;
  }

  // 126-111e: 历史内重复读取去重。
  //
  // 现状:#2a 的 execResultCacheLookup 命中之后**仍然把全文展开写进历史** —— 同一个文件在一条
  // 线程里读三次,历史里就躺着三份一模一样的正文。L1 把 boundary 之前的都缩过了,所以这几份全文
  // 真正还在占位置的地方是**受保护的尾部**;这里去的就是那一段。
  //
  // 去重键 = `路径` ＋ **文件正文的 sha256**,不是「路径＋mtime＋size」那种版本推断:
  //   · 正文逐字节相同 -> 必然是同一份内容的同一个窗口,换成指针零信息损失;
  //   · 读的窗口不同(第 1-100 行 vs 第 100-200 行)-> 正文不同 -> 各留各的;
  //   · 文件改过之后再读 -> 正文不同 -> **两份都留着**,「我的改动生效了吗」这种对照不会被吃掉。
  // 也就是说这把键**零误报**。不拿整条 content 做哈希是因为缓存命中那一发会多带一个
  // `cacheHit:{cachedAt,ageMs}`,ageMs 每次都不一样 —— 拿整条比就永远比不上。
  function fileReadDedupKey(raw) {
    if (typeof raw !== 'string' || raw.charCodeAt(0) !== 123) return ''; // 123 = '{'
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { return ''; }
    if (!parsed || parsed.ok !== true) return '';
    const filePath = typeof parsed.path === 'string' ? parsed.path : '';
    const body = typeof parsed.content === 'string' ? parsed.content : '';
    if (!filePath || !body) return '';
    return filePath + '\u0000' + crypto.createHash('sha256').update(body).digest('hex');
  }
  // 从 from 起(= L1 的边界,也就是受保护的尾部起点)扫一遍:同一把键的**最新一次留全文**,
  // 较早那几次换成指针。指针里带后文那一条的 tool_call_id(模型在历史里看得见它)与 rawRef
  // (有快照前缀时),所以「要原文」这条路一直通着 —— 换掉的是重复,不是信息。
  function dedupeRepeatedReads(history, from, toolNames, rawRefPrefix) {
    const newest = new Map();
    for (let i = Math.max(0, from); i < history.length; i++) {
      const m = history[i];
      if (!m || m.role !== 'tool' || typeof m.content !== 'string') continue;
      if (toolNames && toolNames.get(String(m.tool_call_id || '')) !== 'file_read') continue;
      const key = fileReadDedupKey(m.content);
      if (key) newest.set(key, i);
    }
    let count = 0;
    for (let i = Math.max(0, from); i < history.length; i++) {
      const m = history[i];
      if (!m || m.role !== 'tool' || typeof m.content !== 'string') continue;
      if (m.content.startsWith(READ_DEDUP_PREFIX) || m.content.startsWith(EVAPORATED_PREFIX)) continue; // 幂等
      if (toolNames && toolNames.get(String(m.tool_call_id || '')) !== 'file_read') continue;
      const key = fileReadDedupKey(m.content);
      if (!key || newest.get(key) === i) continue; // 最新那一次留全文
      const laterId = String(history[newest.get(key)].tool_call_id || '');
      const contentHash = crypto.createHash('sha256').update(m.content).digest('hex').slice(0, 16);
      const ref = rawRefPrefix ? `,原件 rawRef=${rawRefPrefix}:${i}:${contentHash}` : '';
      m.content = `${READ_DEDUP_PREFIX}这次读到的内容与后文那次完全相同(tool_call_id=${laterId}),全文见那一条${ref}]`;
      count++;
    }
    return count;
  }

  function evaporateHistory(history, opts) {
    if (!Array.isArray(history) || !history.length) return 0;
    // Find the index of the 2nd-most-recent assistant message. Tool messages at or after it are within the
    // "recent 2 assistant turns" window and are preserved verbatim.
    let assistantsSeen = 0, boundary = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m && m.role === 'assistant') { assistantsSeen++; if (assistantsSeen === 2) { boundary = i; break; } }
    }
    // Callers supply a budget for the token-aware boundary, or omit it for the legacy boundary.
    const boundaryBudget = Number(opts && opts.boundaryBudget);
    if (Number.isFinite(boundaryBudget) && boundaryBudget > 0) boundary = evaporateBudgetBoundary(history, boundaryBudget);
    const useReducer = !!(opts && opts.config && opts.config.runtimeObservationReducerV1 === true && opts.rawRefPrefix);
    // 126-111e:`dedupeReads` 与 `boundaryBudget` 同一个模具 —— 是【已经过开关把门的】布尔,
    // 判定口在 01c 的 historyReadDedupEnabled(),由调用点各调一次;本函数仍然不读任何开关。
    const dedupeReads = !!(opts && opts.dedupeReads === true);
    // toolNames 原本只在 reducer 开着时才算;去重也要用它(只认 file_read),所以两者有一个要就算。
    // 都不要时仍然是 null —— 与改前逐字节同义。
    const toolNames = (useReducer || dedupeReads) ? observationToolNames(history) : null;
    let count = 0;
    for (let i = 0; i < boundary; i++) {
      const m = history[i];
      if (!m || m.role !== 'tool' || typeof m.content !== 'string') continue;
      if (m.content.startsWith(EVAPORATED_PREFIX)) continue; // already evaporated → skip (idempotent, cache-safe)
      // 已经是缩减视图的同样跳过(2026-10):修前每越一次线 L1 都把上次的缩减视图再缩一遍 —— JSON 视图还能再省几百字,于是
      // 换上一个新 rawRef,指向「本次快照里的那份缩减视图」而不是原件(回捞要连跳两次才见原文,8 次/回合的配额白耗),
      // 同时又改写一条旧消息、把服务商的前缀缓存再作废一次。缩减视图里的 rawRef 已经指向原件,留着它就是最好的结果。
      if (useReducer && isReducedObservationView(m.content)) continue;
      const toolName = toolNames ? (toolNames.get(String(m.tool_call_id || '')) || '') : '';
      const protectedReason = useReducer ? protectedObservation(toolName, m) : '';
      if (protectedReason) continue;
      if (useReducer) {
        const contentHash = crypto.createHash('sha256').update(m.content).digest('hex').slice(0, 16);
        const reduced = reduceObservationContent(toolName, m.content, `${opts.rawRefPrefix}:${i}:${contentHash}`, { recallEnabled: opts.config.runtimeObservationRecallV1 === true });
        if (!reduced.reduced) continue;
        m.content = reduced.content; count++;
        if (typeof opts.onReduced === 'function') {
          try { opts.onReduced({ toolName, toolCallId: m.tool_call_id || '', index: i, policy: reduced.policy, originalChars: reduced.originalChars, visibleChars: reduced.visibleChars, rawRef: reduced.rawRef }); } catch { /* observer only */ }
        }
        continue;
      }
      if (m.pinned) continue;  // C1b:显式锚定的关键信息不蒸发(预留接口:当前无消息级设置点——session.pinned 是 UI 固定会话,不在此;生效的锚定是下行写操作自动保留)
      if (/"op"\s*:\s*"(create|modify|delete|move|copy)"/.test(m.content)) continue;  // C1b:写操作关键变更自动保留(回滚/审计依赖,不蒸发)
      m.content = EVAPORATED_PREFIX + m.content.slice(0, 120) + ']';
      count++;
    }
    // 126-111e:上面那一趟只动 boundary 之前(冷区,已经缩过)。重复读取真正还在占位置的地方是
    // 【受保护的尾部】—— 从 boundary 起再扫一遍。返回值把两者加在一起:它的语义是「L1 这一趟
    // 一共缩了几条观测」,调用方拿它判「L1 做没做事」,两种缩法都算数。
    if (dedupeReads) count += dedupeRepeatedReads(history, boundary, toolNames, opts && opts.rawRefPrefix);
    return count;
  }

  // True shadow evaluation for 20-C1. Both policies run on shallow message copies; the live providerHistory
  // and its cache-friendly prefix remain untouched. Only aggregate sizes/counts leave this function: candidate
  // rawRefs and observation bytes are deliberately excluded from telemetry.
  function measureObservationReductionShadow(history) {
    const startedAt = process.hrtime.bigint();
    if (!Array.isArray(history) || !history.length) {
      return { observationCount: 0, baselineReducedCount: 0, candidateReducedCount: 0, originalChars: 0, baselineVisibleChars: 0, candidateVisibleChars: 0, baselineReductionRate: 0, candidateReductionRate: 0, protectedCount: 0, elapsedMs: 0 };
    }
    let assistantsSeen = 0, boundary = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i] && history[i].role === 'assistant') { assistantsSeen++; if (assistantsSeen === 2) { boundary = i; break; } }
    }
    const coldIndexes = [];
    for (let i = 0; i < boundary; i++) {
      const message = history[i];
      if (message && message.role === 'tool' && typeof message.content === 'string' && !message.content.startsWith(EVAPORATED_PREFIX)) coldIndexes.push(i);
    }
    const copy = () => history.map(message => message && message.role === 'tool' ? { ...message } : message);
    const baselineHistory = copy();
    const candidateHistory = copy();
    const baselineReducedCount = evaporateHistory(baselineHistory);
    const candidateReducedCount = evaporateHistory(candidateHistory, {
      config: { runtimeObservationReducerV1: true },
      rawRefPrefix: 'history:0:0000000000000000',
    });
    const toolNames = observationToolNames(history);
    let originalChars = 0, baselineVisibleChars = 0, candidateVisibleChars = 0, protectedCount = 0;
    for (const index of coldIndexes) {
      const original = history[index];
      originalChars += original.content.length;
      baselineVisibleChars += String(baselineHistory[index].content || '').length;
      candidateVisibleChars += String(candidateHistory[index].content || '').length;
      const toolName = toolNames.get(String(original.tool_call_id || '')) || '';
      if (protectedObservation(toolName, original)) protectedCount++;
    }
    const rate = visible => originalChars > 0 ? Number(((originalChars - visible) / originalChars).toFixed(4)) : 0;
    return {
      observationCount: coldIndexes.length,
      baselineReducedCount,
      candidateReducedCount,
      originalChars,
      baselineVisibleChars,
      candidateVisibleChars,
      baselineReductionRate: rate(baselineVisibleChars),
      candidateReductionRate: rate(candidateVisibleChars),
      protectedCount,
      elapsedMs: Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(3)),
    };
  }

  return {
    protectedObservation, reduceObservationContent, buildObservationRecallPrompt,
    historyUnitStarts, evaporateBudgetBoundary, fileReadDedupKey, dedupeRepeatedReads, evaporateHistory,
    measureObservationReductionShadow,
  };
}

module.exports = { createObservationReduction, isReducedObservationView };
