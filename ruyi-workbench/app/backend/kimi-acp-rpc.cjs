'use strict';

const { safeJsonParse } = require('./ordinary-json.cjs');
const { createNdjsonLineFeeder } = require('./text-codecs.cjs');

function kimiAcpContentText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(kimiAcpContentText).filter(Boolean).join('\n');
  if (typeof value !== 'object') return String(value);
  if (typeof value.text === 'string') return value.text;
  if (value.content !== undefined) return kimiAcpContentText(value.content);
  if (value.rawOutput !== undefined) return kimiAcpContentText(value.rawOutput);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function kimiAcpRpcError(payload, method) {
  const detail = payload && payload.error || payload || {};
  const error = new Error(String(detail.message || `Kimi ACP ${method} failed`));
  error.code = detail.code;
  error.data = detail.data;
  error.method = method;
  return error;
}

// ACP uses one JSON-RPC object per line. This small client deliberately keeps reverse requests on the same
// transport: Kimi can pause session/prompt, ask Ruyi for permission/input, then continue after our response.
function createKimiAcpRpc(child, handlers = {}, assertCliAllowed) {
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const reversePending = new Map();
  const write = payload => {
    if (closed || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) throw new Error('Kimi ACP input channel is closed');
    if (payload.method !== 'session/cancel') assertCliAllowed?.();
    child.stdin.write(JSON.stringify(payload) + '\n', 'utf8');
  };
  // hunt2-engines#3:子进程先死、管道还没被标 destroyed 的那一瞬间写进去,EPIPE 是在 stdin 流上【异步】抛的 'error' ——
  // 没有监听者就成了未捕获异常,整个服务 process.exit(1),所有会话的回合一起断(05/07 的 CLI 子进程早就挂了同款空监听)。
  // 这里吞掉并把通道记成关闭:后续 write 走上面那句同步抛,由各调用点既有的 try/catch 与 close 事件收尾。
  if (child.stdin && typeof child.stdin.on === 'function') child.stdin.on('error', () => { closed = true; });
  const rejectPending = error => {
    for (const [, item] of pending) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
    for (const [, item] of reversePending) item.controller.abort(error);
    reversePending.clear();
  };
  const dispatch = message => {
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && !message.method) {
      const item = pending.get(String(message.id));
      if (!item) return;
      pending.delete(String(message.id));
      clearTimeout(item.timer);
      if (message.error) item.reject(kimiAcpRpcError(message, item.method));
      else item.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) {
      const key = String(message.id);
      const controller = new AbortController();
      reversePending.set(key, { controller, method: message.method });
      Promise.resolve().then(() => handlers.onRequest
        ? handlers.onRequest(message.method, message.params || {}, { requestId: message.id, signal: controller.signal }) : {})
        .then(result => {
          if (controller.signal.aborted) {
            const cancelled = new Error('Kimi ACP reverse request cancelled'); cancelled.code = -32800; throw cancelled;
          }
          write({ jsonrpc: '2.0', id: message.id, result: result === undefined ? {} : result });
        })
        .catch(error => {
          const cancelled = controller.signal.aborted;
          const code = cancelled ? -32800 : (Number.isInteger(error && error.code) ? error.code : -32603);
          const errorMessage = cancelled ? 'Request cancelled' : String(error && error.message || error);
          try { write({ jsonrpc: '2.0', id: message.id, error: { code, message: errorMessage } }); } catch { /* transport gone */ }
        })
        .finally(() => reversePending.delete(key));
      return;
    }
    if (message.method === '$/cancel_request') {
      const requestId = String(message.params && message.params.requestId);
      const item = reversePending.get(requestId);
      if (item) item.controller.abort(new Error('remote cancellation'));
      if (handlers.onCancel) handlers.onCancel(message.params && message.params.requestId, item && item.method);
      return;
    }
    if (message.method && handlers.onNotification) handlers.onNotification(message.method, message.params || {});
  };
  // 117q-B1(30 号文 §4.1):与 05/07 同一缺陷,同一个 createNdjsonLineFeeder 修法——chunk 边界不保证落在
  // 字符边界上,被切开的 CJK 字节不能各自独立解码。
  const consumeAcpLine = line => {
    if (!line.trim()) return;
    if (handlers.onLine) handlers.onLine(line);
    const message = safeJsonParse(line);
    if (message) dispatch(message);
  };
  const stdoutFeeder = createNdjsonLineFeeder(consumeAcpLine);
  child.stdout.on('data', chunk => { stdoutFeeder.push(chunk); });
  // 附带修的漂移(30 号文 §4.1):05/07 都在子进程 close 后 flush 残留半行,这里原来没有——三者协议都是
  // 「一行一个 JSON」,没理由 ACP 单独在半行 JSON 上突然退出时把最后一条消息静默丢掉。flush 放在
  // rejectPending 之前,让最后一行(若恰好是某个 pending 请求的响应)先有机会被 dispatch 结算。
  child.once('error', error => { stdoutFeeder.flush(); closed = true; rejectPending(error); });
  child.once('close', code => {
    stdoutFeeder.flush();
    closed = true;
    rejectPending(new Error(`Kimi ACP process exited${code == null ? '' : ` (${code})`}`));
  });
  return {
    request(method, params, timeoutMs = 30000) {
      const id = String(++nextId);
      return new Promise((resolve, reject) => {
        const timer = timeoutMs > 0 ? setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Kimi ACP ${method} timed out`));
        }, timeoutMs) : null;
        pending.set(id, { resolve, reject, timer, method });
        try { write({ jsonrpc: '2.0', id, method, params }); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
    notify(method, params) {
      try { write({ jsonrpc: '2.0', method, params }); return true; } catch { return false; }
    },
    cancelReverseRequests(reason) {
      for (const [, item] of reversePending) item.controller.abort(reason || new Error('ACP connection closing'));
      reversePending.clear();
    },
    isClosed: () => closed,
  };
}

function kimiAcpRequestError(code, message) {
  const error = new Error(String(message || 'Kimi ACP request failed'));
  error.code = code;
  return error;
}

function kimiAcpAssertSession(params, context) {
  const expected = String(context && context.reg && context.reg.nativeSessionId || '');
  const actual = String(params && params.sessionId || '');
  if (!actual) throw kimiAcpRequestError(-32602, 'sessionId is required');
  if (expected && actual !== expected) throw kimiAcpRequestError(-32602, 'sessionId does not match the active Kimi session');
}

function awaitKimiAcpWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(kimiAcpRequestError(-32800, 'Request cancelled'));
  return new Promise((resolve, reject) => {
    const cancel = () => reject(kimiAcpRequestError(-32800, 'Request cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}

module.exports = { createKimiAcpRpc, kimiAcpContentText, kimiAcpRequestError, kimiAcpAssertSession, awaitKimiAcpWithSignal };
