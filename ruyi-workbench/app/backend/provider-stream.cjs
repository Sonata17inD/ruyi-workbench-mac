'use strict';

const { safeJsonParse } = require('./ordinary-json.cjs');
const { redact } = require('./secret-redaction.cjs');
const { providerRetryAfterMs, providerThrownErrorText } = require('./provider-http.cjs');

// v1.0-S6 (B): provider endpoint FAILOVER (备用端点故障转移). Strict boundary — we switch endpoints ONLY on a
// PRE-FIRST-BYTE failure, because a mid-stream re-issue would REPLAY already-emitted content (duplication).
//   • connect-class transport failure (the socket never delivered a usable response): ECONNREFUSED /
//     ETIMEDOUT / ENOTFOUND / EHOSTUNREACH / EAI_AGAIN / ECONNRESET / TLS handshake failure / a generic
//     "fetch failed" the runtime raised before any body byte;
//   • HTTP 502 / 503 / 504 observed at the RESPONSE-HEADER stage (upstream gateway unavailable).
// NOT a failover trigger (换端点无益 or would mask a real error): 400/401/403/404/422/429 (auth/request/
// rate-limit — see the caller), and ANY failure once the SSE body has begun streaming (handled by the
// caller's existing error path, never here).
const FAILOVER_HTTP_STATUSES = new Set([502, 503, 504]);
// Connect-class Node error codes worth failing over on (a fresh endpoint may succeed).
const FAILOVER_CONNECT_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN', 'ECONNRESET']);
// Classify a caught fetch throw (pre-first-byte). Returns a short reason token when it is failover-eligible
// connect-class, else null. Inspects the error's `code` (Node/undici surfaces the syscall code on `.cause`
// too), plus TLS/"fetch failed" message fragments the runtime uses when no `code` is attached.
function failoverConnectReason(err) {
  if (!err) return null;
  const code = String((err && err.code) || (err && err.cause && err.cause.code) || '').toUpperCase();
  if (code && FAILOVER_CONNECT_CODES.has(code)) return 'connect';
  const msg = String((err && err.message) || '');
  if (/certificate|tls|ssl|self[- ]signed|handshake|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(msg)) return 'tls';
  // undici raises a bare "fetch failed" (with the real cause nested) for connect refusals/DNS — treat as connect.
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|network|socket hang up/i.test(msg)) return 'connect';
  return null;
}
function createProviderStream({ providerWireProtocolForBody, PrivacyGateway, DesktopExecutionHooks, isContextOverflowError }) {
  // One streaming chat/completions call. Emits assistant_delta / thinking_delta / raw_line live; returns
  // { text, reasoning, toolCalls:[{id,name,rawArgs}], finishReason, httpError, toolsRejected }.
  // v1.0-S6 (B): pre-first-byte failures are surfaced structurally so the caller can decide failover:
  //   • a caught fetch throw BEFORE any body byte → { transportError, transportReason:<'connect'|'tls'>, ... }
  //     (only when failover-eligible; a non-eligible throw — e.g. an AbortError — is re-thrown to the caller);
  //   • a non-ok response whose status is 502/503/504 → the returned httpError object also carries
  //     { failoverStatus:<502|503|504> } so the caller can advance. A throw that happens AFTER streaming has
  //     started still propagates normally (caller's error path; no failover — 防重放).
  // 协议(58 号批 1):请求体的形状与流式事件语法都住在 04i 的协议登记表 —— 这里只管传输:发请求、首字节前的传输失败与
  // failover 判定、400 归因(工具被拒 / 超窗 / stream_options)、SSE 分帧(空行分事件、多行 data: 拼接、[DONE])、raw_line;
  // 每一帧交给 protocol.createStreamDecoder 的解码器,非流式回体交给 protocol.decodeCompletion。调用方(09/08)显式传
  // protocol;没传(老调用点、单测)时按请求体形状认(Responses 用 input 项,chat 用 messages)。
  async function openAiStreamOnce({ chatUrl, headers, body, ctrl, onEvent, markUsage, rawSeqRef, touch, protocol }) {
    const wire = protocol || providerWireProtocolForBody(body);
    const doFetch = async b => {
      const requestBody = typeof PrivacyGateway !== 'undefined' ? await PrivacyGateway.beforeModelRequest(b) : b;
      await DesktopExecutionHooks.beforeModelRequest();
      if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertPolicyAvailable();
      return fetch(chatUrl, { method: 'POST', headers, body: JSON.stringify(requestBody), signal: ctrl ? ctrl.signal : undefined });
    };
    let res;
    try {
      res = await doFetch(body);
    } catch (e) {
      // Pre-first-byte throw. An abort (user Stop / watchdog) is NOT a failover case — re-throw so the caller's
      // AbortError handling runs. A connect/TLS-class failure is surfaced structurally for the failover decision;
      // anything else is re-thrown to preserve the existing error path & attribution.
      if (e && e.name === 'AbortError') throw e;
      const reason = failoverConnectReason(e);
      if (reason) return { transportError: (e && e.message) ? e.message : String(e), transportReason: reason, text: '', reasoning: '', toolCalls: [] };
      throw e;
    }
    touch();
    // v0.9-S0 400 attribution (§0.9-S0): tighten the order in which we classify a 400.
    // The old code sniffed stream_options FIRST. But a provider that rejects a tools-bearing request
    // often phrases it as "tools are not supported here" / "function calling is not supported" — the
    // "not support" fragment matched the stream_options regex, so we stripped stream_options and RETRIED
    // WITH TOOLS, hitting the same 400 forever (v0.8-S6 收官遗留误判案例; caught while wiring FAKE_REJECT_TOOLS).
    // Fix: when the request CARRIES tools AND the error text has tool/function semantics, attribute it to
    // tools-rejected FIRST (caller retries once without tools). Only if it is NOT a tools/function 400 do we
    // fall back to the stream_options sniff. For requests WITHOUT tools the behavior is unchanged — the
    // requestHasTools guard means the tools-first branch never fires, so the stream_options path is preserved.
    const requestHasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (res && res.status === 400) {
      let t = ''; try { t = await res.text(); } catch { /* ignore */ }
      const toolsSemantics = /tool|function/i.test(t);
      // 例外:报文带【确凿】的超窗信号(OpenAI 的 code context_length_exceeded / "maximum context length")时超窗优先。
      // OpenAI 的超窗报文会写 "…11000 in the functions. Please reduce the length of the messages or functions",
      // 按下面的 tools-first 顺序会被当成「工具被拒」:整回合去掉工具重打、永远不压缩。tools 拒绝报文不会带这两个短语。
      const definiteOverflow = /context_length_exceeded|maximum context length/i.test(t) && isContextOverflowError('HTTP 400: ' + t);
      if (definiteOverflow) {
        return { httpError: `HTTP 400${t ? ': ' + redact(t.slice(0, 500)) : ''}`, contextOverflow: true, text: '', reasoning: '', toolCalls: [] };
      }
      // tools-rejected 仍最先(45f 对抗轮 P1-1 恢复既有存活路径):真实超窗报文一般不含 tool/function 字样,
      // 而 tools 拒绝报文可能带 "in this context" —— 顺序反了会把非超窗错误吸进破坏性压缩。
      if (requestHasTools && toolsSemantics) {
        // tools-rejected takes priority over the stream_options retry (§0.9-S0).
        return { httpError: `HTTP 400${t ? ': ' + redact(t.slice(0, 500)) : ''}`, toolsRejected: true, text: '', reasoning: '', toolCalls: [] };
      }
      // 第45波:context-overflow 先于 stream_options 误判 —— "invalid_request_error" 是 OpenAI 系 400
      // 的标准 type(真实 DeepSeek 超限报文正是它),而 stream_options 嗅探的正则含裸 /invalid/,会把上下文
      // 超限误吸进「剥 stream_options 静默重试」(剥了也照样超窗,纯浪费一次调用还掩盖 45b 的强压入口)。
      // (45f P1-1:判定器已收紧为「上下文×长度共现」,裸 invalid/context 字样不再命中。)
      if (isContextOverflowError('HTTP 400: ' + t)) {
        return { httpError: `HTTP 400${t ? ': ' + redact(t.slice(0, 500)) : ''}`, contextOverflow: true, text: '', reasoning: '', toolCalls: [] };
      }
      // 58 号批 2:协议内的兼容重打(Anthropic:思考块签名校验失败 → 去掉思考块;网关不认 thinking / output_config 等 → 去掉点名字段)。
      // chat / responses 恒返回 null,走下面原有的 stream_options 分支,行为不变。
      const retryBody = wire.retryOn400(body, t, { url: chatUrl });   // url:从 400 学到的 max_tokens 上限记在「这个端点 + 这个模型」名下
      if (retryBody) {
        res = await doFetch(retryBody);
      } else if (body.stream_options && /stream_options|include_usage|unsupported|unknown|not\s*support/i.test(t)) {
        // 不再认裸 invalid:OpenAI 系所有 400 的 type 都是 invalid_request_error,认它等于把每个注定失败的 400
        // 都剥 stream_options 白打第二遍。真拒收 stream_options 的端点会点名它(或说 unsupported / unknown)。
        // Some servers reject stream_options — retry once without it before failing.
        const b2 = Object.assign({}, body); delete b2.stream_options; res = await doFetch(b2);
      } else {
        return { httpError: `HTTP 400${t ? ': ' + redact(t.slice(0, 500)) : ''}`, toolsRejected: toolsSemantics, text: '', reasoning: '', toolCalls: [] };
      }
    }
    if (!res || !res.ok) {
      let d = ''; if (res) { try { d = await res.text(); } catch { /* ignore */ } }
      // v1.0-S6 (B): tag a gateway-unavailable status (502/503/504) so the caller can fail over to a backup
      // endpoint. This is still a pre-first-byte failure (we только read the error body, not an SSE stream).
      // Auth/request/rate-limit statuses (401/403/400/404/422/429) carry NO failoverStatus → caller won't switch.
      const failoverStatus = (res && FAILOVER_HTTP_STATUSES.has(res.status)) ? res.status : undefined;
      // 「工具被拒」只在 400 / 422(请求体校验类)时才有意义:修前对【所有】非 ok 状态都按 /tool|function/ 打标,
      // 一发 500 的正文里带 "function dispatcher" 就让 09 整回合去掉工具重打、回合还报 ok:true。
      const toolsRejectedStatus = Boolean(res && (res.status === 400 || res.status === 422));
      // Retry-After(429 / 503 常带;秒或 HTTP 日期,封顶 30 s):带出给调用方的退避取 max(自己的退避, 它)。没有 / 认不出不带这个键。
      const retryAfterMs = res && res.headers && typeof res.headers.get === 'function' ? providerRetryAfterMs(name => res.headers.get(name), Date.now()) : 0;
      return { httpError: `HTTP ${res ? res.status : '?'}${d ? ': ' + redact(d.slice(0, 500)) : ''}`, toolsRejected: toolsRejectedStatus && /tool|function/i.test(d), failoverStatus, ...(retryAfterMs > 0 ? { retryAfterMs } : {}), text: '', reasoning: '', toolCalls: [] };
    }
    // Non-streaming fallback: single JSON body. The protocol decoder normalizes it to the same
    // { text, reasoning, toolCalls } shape so every caller is protocol-agnostic.
    // 无视 stream:true、直接回一整份 application/json 的网关也走这里:按 SSE 分帧读它一行 data: 都找不到,
    // 修前返回空回答(工具调用、正文全丢)。content-type 声明了 event-stream 的仍按流读。
    const contentType = String((res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '');
    const jsonBody = /\bjson\b/i.test(contentType) && !/event-stream/i.test(contentType);
    if (!res.body || typeof res.body.getReader !== 'function' || jsonBody) {
      const j = await res.json().catch(() => null);
      const d = wire.decodeCompletion(j, { requestModel: body.model });
      // 回体本身装着失败(200 + 顶层 error、Responses status:'failed'、Anthropic type:'error' / refusal):与流式分支一致地报 httpError。
      // 修前这里把 failed / failedDetail 全丢了,落成「空回复」,真因(额度用尽 / 拒答 / 服务端报错)用户看不到。用量照记(失败那一发也花了钱)。
      if (d.usage) markUsage(d.usage);
      if (d.failureText) {
        return { text: d.text, reasoning: d.reasoning, finishReason: 'error', toolCalls: [], httpError: redact(String(d.failureText).slice(0, 500)), providerResponseId: d.responseId };
      }
      // E6: surface reasoning before content, matching the streaming order (a non-streaming endpoint's reasoning
      // chain used to be invisible in the UI).
      if (d.reasoning) onEvent({ type: 'thinking_delta', text: d.reasoning });
      if (d.text) onEvent({ type: 'assistant_delta', text: d.text });
      return { text: d.text, reasoning: d.reasoning, toolCalls: d.toolCalls, finishReason: d.finishReason, providerResponseId: d.responseId, ...(d.providerBlocks ? { providerBlocks: d.providerBlocks } : {}) };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '', done = false;
    const wireDecoder = wire.createStreamDecoder({ onEvent, markUsage, requestModel: body.model });
    // Process ONE decoded SSE event object (already JSON-parsed): raw_line first, then the protocol's event grammar.
    // Returns true when this event terminates the stream (responses' completed/incomplete/failed; chat keeps
    // relying on the `[DONE]` sentinel inside handleEventBlock).
    const processEvt = (evt, rawStr) => {
      onEvent({ type: 'raw_line', line: rawStr, seq: rawSeqRef.n++ });
      return wireDecoder.feed(evt);
    };
    // E5: standard SSE framing. Events are separated by a BLANK line; within one event, multiple `data:` field
    // lines concatenate (joined by '\n') into a single payload before parsing (per the WHATWG SSE spec). The
    // old parser split on every '\n' and JSON.parsed each `data:` line alone, so an endpoint that spread one
    // JSON object across several `data:` lines (some intranet proxies / self-hosted gateways do) lost the whole
    // frame. To stay backward compatible with the overwhelmingly common one-JSON-per-line shape, when a
    // multi-line event's combined payload does not parse we fall back to parsing each data line on its own.
    const handleEventBlock = block => {
      const dataLines = [];
      for (let rawLine of block.split('\n')) {
        rawLine = rawLine.replace(/\r$/, '');
        if (!rawLine || rawLine.startsWith(':')) continue;   // blank line or comment
        if (!rawLine.startsWith('data:')) continue;          // ignore event:/id:/retry: fields
        dataLines.push(rawLine.slice(5).replace(/^ /, ''));  // strip 'data:' + one optional leading space (SSE)
      }
      if (!dataLines.length) return false;
      const joined = dataLines.join('\n').trim();
      if (joined === '') return false;
      if (joined === '[DONE]') return true;
      const combined = safeJsonParse(joined);
      if (combined) return processEvt(combined, joined); // true = terminal event (responses completed/incomplete/failed)
      // Combined payload did not parse -> treat each data line as its own complete JSON (classic shape).
      for (const dl of dataLines) {
        const d = dl.trim();
        if (!d) continue;
        if (d === '[DONE]') return true;
        const evt = safeJsonParse(d);
        if (evt && processEvt(evt, d)) return true;
      }
      return false;
    };
    while (!done) {
      let r;
      try { r = await reader.read(); }
      catch (e) {
        // 流中途断线:undici 抛的是 TypeError('terminated'),真因(other side closed / UND_ERR_SOCKET / ECONNRESET)只挂在 e.cause。
        // 把它并进 message(原错误对象照旧上抛,name / cause / 栈都在):回合的 errorMsg 与 errorClass 才看得出这是掉线。
        // 中止(用户 Stop / 看门狗)原样上抛,09 靠 e.name === 'AbortError' 认它。
        if (e && e.name !== 'AbortError' && e.cause) { try { e.message = providerThrownErrorText(e); } catch { /* 只读 message:保持原样 */ } }
        throw e;
      }
      if (r.done) break;
      touch();
      buf += decoder.decode(r.value, { stream: true });
      let m;
      // Consume every COMPLETE event (terminated by a blank line); leave any trailing partial in buf.
      while ((m = /\r?\n\r?\n/.exec(buf)) !== null) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        if (handleEventBlock(block)) { done = true; break; }
      }
    }
    // Flush a trailing event that arrived without a terminating blank line (some servers omit the final one).
    if (!done && buf.trim()) done = handleEventBlock(buf);
    const out = wireDecoder.finish();
    // 截断的流:连接干净地关了,却既没有终止信号([DONE] / responses 的 completed·incomplete·failed / anthropic 的
    // message_stop)也没有 finish_reason —— 上游中途断了。修前半截回答被当作完整的成功回复落盘;现在走 httpError
    // (不带状态码,调用方不会重打,防重放)。有 finish_reason 的(个别网关省掉 [DONE])照旧算完整。
    if (!done && !out.httpError && !out.finishReason) {
      out.httpError = 'stream ended unexpectedly (connection closed before a finish_reason or end-of-stream marker)';
    }
    return out;
  }

  return openAiStreamOnce;
}

module.exports = { createProviderStream };
