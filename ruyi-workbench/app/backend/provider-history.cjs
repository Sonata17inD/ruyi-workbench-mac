'use strict';
// Provider history transformations share one boundary across storage and engines.
function createProviderHistory({ logEvent, buildAttachmentPrompt, buildDeliveryRevisionPrompt, lastAssistantEngine }) {
// 配对铁律自愈(strict provider 400 永久卡死会话的修复面):detectDanglingTurn 只【检测】悬挂,而
// runOpenAiTurn 回合开始会无条件 push 新 user 消息 —— 若持久化的 providerHistory 里某个
// assistant.tool_calls 有未应答 id(进程在工具块中途被杀/崩溃,abort 路径的 skip 填充来不及跑),
// 下一回合请求体就是 assistant.tool_calls -> user,DeepSeek/DashScope 直接 400
// (insufficient tool messages following tool_calls),且每次重发同一份孤儿历史 -> 会话永久卡死。
// 本函数全历史单遍扫描:对每个带 tool_calls 的 assistant,统计紧随其后的 role:'tool' 块已应答 id,
// 缺的 id 在【块尾原位插入】合成 tool 回复(保持 assistant.tool_calls -> 连续 N 条 tool 的相邻契约,
// 不删不改任何既有消息 —— 与 abort 时 rem skip 填充同一思路,见 09-workflow.js)。
// 返回补的条数(0 = 历史本就配对完整,调用方无需落盘/发事件)。
function repairProviderHistoryPairing(history) {
  if (!Array.isArray(history) || !history.length) return 0;
  let repaired = 0;
  let rebuilt = null;
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (rebuilt) rebuilt.push(m);
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
    const answered = new Set();
    let j = i + 1;
    while (j < history.length && history[j] && history[j].role === 'tool') {
      if (history[j].tool_call_id != null) answered.add(String(history[j].tool_call_id));
      j++;
    }
    const missing = m.tool_calls.filter(tc => tc && tc.id != null && !answered.has(String(tc.id)));
    if (missing.length && !rebuilt) rebuilt = history.slice(0, i + 1);
    if (rebuilt) for (let k = i + 1; k < j; k++) rebuilt.push(history[k]);
    const fills = missing.map(tc => ({
      role: 'tool', tool_call_id: tc.id,
      content: '[工具结果丢失:上次回合已记录此调用,是否派发、执行及其结果未确认,可能已经产生影响。请勿自动重放此调用;先核实已发生的影响,需要再次执行时请取得明确授权。]',
    }));
    if (rebuilt) for (const fill of fills) rebuilt.push(fill);
    repaired += fills.length;
    i = j - 1;
  }
  // Preserve the caller-owned array and every existing message identity, without
  // repeatedly shifting its tail for each interrupted tool block.
  if (rebuilt) {
    for (let i = 0; i < rebuilt.length; i++) history[i] = rebuilt[i];
    history.length = rebuilt.length;
  }
  return repaired;
}

// ── 工具调用参数铁律(第117波;用户线上事故:Qwen/DashScope HTTP 400 invalid_parameter_error
//    "The \"function.arguments\" parameter of the code model must be in JSON format.")────────────────
// 事故形状与上面的孤儿 tool_calls 是同一个模具,只是毒在【参数】而不是【配对】上:
//   ① 三处回放点(09-workflow.js 的两处 providerHistory.push、08-agent-runs.js 子代理那处)把模型给的
//      rawArgs【逐字节】写成 assistant.tool_calls[].function.arguments,不做任何 JSON 保证;
//   ② 三个 rawArgs 生产者(07-autonomy.js Responses 非流式 / Chat 非流式 / 流式槽收口)只对【假值】
//      兜底 `|| '{}'` —— 空串救得回来,"非空但不合法"救不回来;
//   ③ 流式是纯拼接(07-autonomy.js `slot.args += tc.function.arguments`)。流被截断(客户端断流、
//      供应商截流、触顶 token)时 slot.args 停在半截 JSON 上,非空,直接躲过 ②;
//   ④ 每个执行方却都是 `JSON.parse(tc.rawArgs || '{}') catch → {}` —— 工具【实际按 {} 跑了】,
//      历史却声称那截烂片段。历史与执行各说各话,严校验供应商见到 arguments 不是 JSON 对象即 400;
//   ⑤ 这条毒回合已落盘 → 之后每次请求都重发它 → 会话永久卡死(与孤儿历史一字不差的死法)。
// 判据:arguments 必须能 JSON.parse 成【对象】。数组/标量/空串都不合法 —— 供应商按对象反序列化参数,
// '[1,2]' 能 parse 却填不进 function 的具名参数,同样 400。
function isProviderToolArgsObject(raw) {
  if (typeof raw !== 'string' || raw === '') return false;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return false; }
  return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
}

// 写侧不变量(唯一收口):rawArgs 变成 providerHistory 的 function.arguments 时过一次判据,不合法一律
// 记 '{}' —— 与执行方 catch → {} 【完全一致】,历史从此说的就是实际跑的那份参数。
// 为什么钉在这里、而不是钉在 rawArgs 三个生产者上:rawArgs 本身还有三个【非请求体】读者,改生产者会
// 连坐它们 —— 09-workflow.js:1911 的连击指纹 sha1(name+'\0'+rawArgs)(两截不同的截断片段会塌成同一
// 指纹 → 误判"同签名连击"而 abort)、09-workflow.js:1749 的 econArgsBytes(tc.rawArgs) 经济口径(真实
// 字节数会变成 2)、07-autonomy.js:1042 的动作视图投影(它【故意】对 malformed 拒绝投影)。
// 不变量说的是"发到供应商的 arguments",落点就该在 arguments 生成处,别处的 rawArgs 一个字节不动。
// 日志只带工具名与字节数,绝不带片段本身(截断片段可能含密钥/路径,与本仓库其它脱敏处同规矩)。
function providerHistoryToolCalls(toolCalls, logCtx) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map(tc => {
    if (isProviderToolArgsObject(tc.rawArgs)) return { id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.rawArgs } };
    logEvent({
      kind: 'provider_tool_args_coerced', ...(logCtx && typeof logCtx === 'object' ? logCtx : {}),
      tool: String(tc.name || ''), bytes: Buffer.byteLength(String(tc.rawArgs == null ? '' : tc.rawArgs), 'utf8'),
    });
    return { id: tc.id, type: 'function', function: { name: tc.name, arguments: '{}' } };
  });
}

// 参数铁律自愈(repairProviderHistoryPairing 的同位兄弟):写侧不变量只管【今后】写进去的,用户手上
// 那条【已经卡死】的会话还得就地修 —— 否则每次请求照样重发同一份毒历史、照样 400。全历史单遍扫描:
// 任何 assistant.tool_calls[].function.arguments 过不了对象判据的,原地改写成 '{}'(与当时实际执行用的
// {} 一致);不删不改任何其它字段、不动任何其它消息。返回改写条数(0 = 历史本就干净,调用方无需落盘/
// 发系统消息)—— 故对合法历史是【逐字节】no-op。
function repairProviderHistoryToolArgs(history, sessionId) {
  if (!Array.isArray(history) || !history.length) return 0;
  let repaired = 0;
  for (const m of history) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
    for (const tc of m.tool_calls) {
      if (!tc || !tc.function || typeof tc.function !== 'object') continue;
      if (isProviderToolArgsObject(tc.function.arguments)) continue;
      const raw = tc.function.arguments;
      logEvent({
        kind: 'provider_tool_args_repair', ...(sessionId ? { sessionId: String(sessionId) } : {}),
        tool: String(tc.function.name || ''), bytes: Buffer.byteLength(String(raw == null ? '' : raw), 'utf8'),
      });
      tc.function.arguments = '{}';
      repaired++;
    }
  }
  return repaired;
}

// Mirror display messages that were created outside the Provider engine (Claude turns and workflow
// summaries) into its stateless API history exactly once. Provider-native tool traces stay intact; the cursor
// only accounts for the shared display stream and therefore survives tool calls and context compaction.
function appendDisplayMessagesToProviderHistory(session, start) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const from = Math.max(0, Math.min(Number(start) || 0, messages.length));
  for (let i = from; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
    if (m.role === 'user') {
      // Historical images are represented by their attachment prompt only. Re-embedding pixels from every
      // earlier turn would make an engine switch unexpectedly huge and bypass the live image cap.
      session.providerHistory.push({ role: 'user', content: m.content + buildAttachmentPrompt(m.attachments) + buildDeliveryRevisionPrompt(m.meta), ...(m.meta ? { meta: m.meta } : {}) });
    } else if (m.role === 'assistant') {
      session.providerHistory.push({ role: 'assistant', content: m.content });
    }
  }
  session.providerHistoryCursor = messages.length;
}

function syncProviderHistoryFromDisplay(session) {
  if (!Array.isArray(session.providerHistory)) session.providerHistory = [];
  const messages = Array.isArray(session.messages) ? session.messages : [];
  if (session.providerHistory.length === 0) {
    appendDisplayMessagesToProviderHistory(session, 0);
    return;
  }

  let cursor = session.providerHistoryCursor;
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > messages.length) {
    // Legacy migration: an existing Provider history already contains all Provider turns. Only a trailing
    // Claude gap can be missing. Start just after the latest Provider assistant; otherwise mark the current
    // display tail consumed without duplicating an established history.
    cursor = messages.length;
    if (lastAssistantEngine(messages) === 'claude') {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'assistant' && (m.engine === 'openai' || String(m.source || '').startsWith('provider:'))) {
          cursor = i + 1;
          break;
        }
      }
    }
  }
  appendDisplayMessagesToProviderHistory(session, cursor);
}

return { repairProviderHistoryPairing, isProviderToolArgsObject, providerHistoryToolCalls, repairProviderHistoryToolArgs, appendDisplayMessagesToProviderHistory, syncProviderHistoryFromDisplay };
}
module.exports = { createProviderHistory };
