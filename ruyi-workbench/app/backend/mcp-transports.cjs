'use strict';
const http = require('node:http');
const { copyOrdinaryJsonData } = require('./ordinary-json.cjs');
// Transport instances receive host policy and process ownership explicitly.
function createMcpTransports({ safeJsonParse, bridgedEnvKeyStripped, DesktopExecutionHooks, ProcessRuntime, killChildTree, bridgedToolCallTimeoutMs, mcpChildExitResult, _expandMcpVar, RUYI_MCP_SERVER_ID, VERSION }) {
const MCP_STDIO_LINE_MAX_CHARS = 64 * 1024 * 1024;
// tools/list 分页(nextCursor)最多跟这么多页 —— 防对端回同一个游标/无限翻页把握手拖死。
const MCP_TOOLS_LIST_MAX_PAGES = 20;
// 条目上的 startupTimeoutMs(从 Codex startup_timeout_sec / Claude 配置导入)只在握手各 rpc 已有的超时参数上生效。
function mcpStartupRpcMs(client, fallback) {
  const v = Number(client && client.startupTimeoutMs);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}
// 条目上的 enabledTools(非空 = 白名单)/ disabledTools(黑名单)。修前导入并落盘了却没人读,原生桥照样把
// 用户关掉的工具全部交给模型。空白名单视为「未设置」—— 清洗后变空的数组不该把整台服务器的工具静默藏光。
function mcpToolAllowed(entry, name) {
  const n = String(name || '');
  const allow = entry && Array.isArray(entry.enabledTools) ? entry.enabledTools : null;
  if (allow && allow.length && !allow.includes(n)) return false;
  const deny = entry && Array.isArray(entry.disabledTools) ? entry.disabledTools : null;
  if (deny && deny.includes(n)) return false;
  return true;
}
// tools/call 结果归一(两个客户端同一份)。修前:文本是 JSON 数组时被展开成 {"0":…,"1":…};
// 工具自带的 ok:true 会盖掉协议层 isError:true(失败被报成成功)。现在数组放进 items,ok 取两者的「与」。
function normalizeMcpToolResult(res) {
  const isError = !!(res && res.isError);
  const blocks = (res && Array.isArray(res.content)) ? res.content : [];
  // 审计 N6:MCP 标准 content 是多块(text / image / resource / audio…)。修前只取第一个 text 块,其余静默丢弃;
  // 只有图片时把整个 content 数组(含 9 万字符 base64)原样回给模型,再被 60 KB 截断劈成半截 base64 文字。
  // 现在:全部 text 块拼起来(单块时与修前逐字一致);image 块映射成工具图像通道认识的字段
  // (第一张 image_base64 + image_mime,多张的其余放 images:[{mimeType,data}]),base64 永不进 text;
  // 内嵌文本资源当文本收;其余块类型只留一条 {type, note:'omitted'}。
  const texts = [];
  const images = [];
  const omitted = [];
  for (const c of blocks) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text);
    else if (c.type === 'image' && typeof c.data === 'string' && c.data) images.push({ mimeType: String(c.mimeType || c.mime_type || 'image/png'), data: c.data });
    else if (c.type === 'resource' && c.resource && typeof c.resource.text === 'string') texts.push(c.resource.text);
    else {
      const o = { type: String(c.type || 'unknown'), note: 'omitted' };
      for (const k of ['uri', 'name', 'mimeType']) if (typeof c[k] === 'string') o[k] = c[k].slice(0, 300);   // resource_link 等:留下可辨认的指针,不留载荷
      omitted.push(o);
    }
  }
  // 多个 text 块时先看【第一块】是不是 JSON(结构化结果 {ok:false,error,…} 后面常跟一条 warning 之类的附注块):是 → 以它为载荷,
  // 其余块放 extraText;否则才把各块拼起来。修前(拼接后再解析)会让「第一块是失败 JSON + 第二块附注」整体变成 ok:true 的文本。
  let textOut = texts.length > 1 ? texts.join('\n') : (texts[0] || '');
  let extraText = '';
  if (texts.length > 1) {
    const head = safeJsonParse(texts[0], undefined);
    if (head && typeof head === 'object') { textOut = texts[0]; extraText = texts.slice(1).join('\n'); }
  }
  const withExtras = base => {
    if (images.length) {
      if (base.image_base64 === undefined && base.image === undefined) {
        base.image_base64 = images[0].data;
        if (base.image_mime === undefined) base.image_mime = images[0].mimeType;
        if (images.length > 1 && base.images === undefined) base.images = images.slice(1);
      } else if (base.images === undefined) {
        base.images = images;
      }
    }
    if (omitted.length && base.omittedBlocks === undefined) base.omittedBlocks = omitted;
    if (extraText && base.extraText === undefined) base.extraText = extraText;
    return base;
  };
  if (textOut) {
    // Prefer the text content; parse it as JSON when it is JSON (desktop MCP returns {ok,...}).
    const parsed = safeJsonParse(textOut, undefined);
    if (Array.isArray(parsed)) return withExtras({ ok: !isError, items: parsed });
    if (parsed && typeof parsed === 'object') {
      const { ok: toolOk, ...rest } = parsed;
      return withExtras({ ok: !isError && toolOk !== false, ...rest });
    }
    return withExtras({ ok: !isError, text: textOut });
  }
  if (images.length || omitted.length) return withExtras({ ok: !isError });
  return { ok: !isError, content: (res && res.content) || [] };
}
// 跟 nextCursor 翻完 tools/list(MCP 2025-03-26 起工具目录可分页;修前只取第一页,后面的工具凭空消失)。
async function mcpListAllTools(rpc, timeoutMs) {
  const tools = [];
  let cursor = '';
  for (let page = 0; page < MCP_TOOLS_LIST_MAX_PAGES; page++) {
    const listed = await rpc('tools/list', cursor ? { cursor } : {}, timeoutMs);
    if (listed && Array.isArray(listed.tools)) tools.push(...listed.tools);
    const next = (listed && typeof listed.nextCursor === 'string') ? listed.nextCursor : '';
    if (!next || next === cursor) break;
    cursor = next;
  }
  return tools;
}
// 对端发来的【请求】(同时带 id 与 method,如 ping)。修前被当成响应:用它的 id 去结我们自己同号的 pending,
// 于是一次真正的 tools/call 被 undefined「成功」提前结掉。现在按 JSON-RPC 回话:ping 回 {},其余 -32601。
function mcpServerRequestReply(msg) {
  if (msg.method === 'ping') return { jsonrpc: '2.0', id: msg.id, result: {} };
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not supported by client: ' + String(msg.method).slice(0, 80) } };
}

// 安全修复(审计 A①):桥接 MCP 服务器(ACC 桌面控制、第三方 stdio MCP)不得继承工作台自己的回环凭据。
// 每会话 MCP 子进程(`server.js mcp`)的环境里有 WCW_TOKEN / WCW_PORT / WCW_HOST / WCW_SESSION_ID(01 generateSessionMcpConfig
// 塞进去的),修前它再 spawn 桥接服务器时整份 process.env 原样传下去 —— ACC 的 get_environment_variable 一问就把
// 令牌交给了模型(令牌 = 可调 /api/permission/decision 等 body-token 路由,自己批自己的权限)。
// 规则见 01 bridgedEnvKeyStripped(与交给 agent CLI 去 spawn 的 --mcp-config 条目同一个判据):继承来的环境里去掉
// 所有 WCW_*(WCW_DATA_DIR 除外)与 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY。服务器条目【自己声明】的 env(ownEnv)
// 原样叠在最后,仍然生效。
function bridgedServerSpawnEnv(baseEnv, ownEnv) {
  const out = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (bridgedEnvKeyStripped(k)) continue;
    out[k] = v;
  }
  return { ...out, ...(ownEnv && typeof ownEnv === 'object' ? ownEnv : {}) };
}

// 走查 W1·F7:桥接超时 / 用户插话中断的 reject 打【标记】(err.mcpTimeout / err.mcpAborted),callTool 只认标记。
// 修前 callTool 用 /timed out/ 匹配 e.message —— MCP 服务端自己回的 JSON-RPC error(「upstream API timed out」「query timed out」)
// 文本里只要带这几个字,就被当成桥接超时:工作台杀掉一个健康的 MCP 进程树、报「桥接进程树已终止」,而服务端的原话被吞掉。
// 现在服务端的错误(没有标记)原样回给模型。
function mcpBridgeError(message, kind) {
  const e = new Error(message);
  if (kind === 'timeout') e.mcpTimeout = true;
  else if (kind === 'abort') e.mcpAborted = true;
  return e;
}

// MCP transport metadata belongs to the host call context, outside model arguments.
// Clone a small JSON object so an awaited send cannot observe later metadata mutation.
function mcpCallToolParams(name, args, options) {
  const params = { name, arguments: args || {} };
  if (options && Object.prototype.hasOwnProperty.call(options, 'meta')) {
    const meta = options.meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('mcp metadata must be an object');
    const encoded = options.executionCheck ? JSON.stringify(copyOrdinaryJsonData(meta)) : JSON.stringify(meta);
    if (Buffer.byteLength(encoded, 'utf8') > 4096) throw new Error('mcp metadata exceeds 4096 bytes');
    const copied = JSON.parse(encoded);
    if (!copied || typeof copied !== 'object' || Array.isArray(copied)) throw new Error('mcp metadata must serialize to an object');
    params._meta = copied;
  }
  return params;
}

class McpStdioClient {
  constructor({ id, command, args, cwd, env, startupTimeoutMs, toolTimeoutMs, enabledTools, disabledTools }) {
    this.id = id;
    this.command = command;
    this.args = Array.isArray(args) ? args : [];
    this.cwd = cwd || undefined;
    this.env = env || {};
    this.startupTimeoutMs = startupTimeoutMs;
    this.toolTimeoutMs = toolTimeoutMs;
    this.enabledTools = enabledTools;
    this.disabledTools = disabledTools;
    this.child = null;
    this.pid = null;
    this.dead = false;
    this.started = false;
    this.tools = [];
    this._bufParts = [];         // 未满一行的 stdout 片段(按块累积,不反复拼接整串)
    this._bufLen = 0;
    this._discarding = false;    // 超长行:丢弃到下一个换行
    this._lineMax = MCP_STDIO_LINE_MAX_CHARS;
    this._nextId = 1;
    this._pending = new Map();   // rpc id -> { resolve, timer }
    this._stderr = '';
  }

  // Send one JSON-RPC request and await its result (by id). Rejects on timeout/child death.
  _rpc(method, params, timeoutMs = 8000, options = {}) {
    return new Promise((resolve, reject) => {
      if (method === 'tools/call') {
        const refusal = DesktopExecutionHooks.callRefusal(this, params?.name, params?.arguments, options);
        if (refusal) return reject(Object.assign(new Error(refusal.error), { code: refusal.code }));
      }
      if (this.dead || !this.child || !this.child.stdin || !this.child.stdin.writable) {
        return reject(new Error('mcp client not running'));
      }
      const id = this._nextId++;
      const signal = options && options.signal;
      let abortHandler = null;
      const cleanup = () => {
        clearTimeout(timer);
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      };
      const timer = setTimeout(() => {
        this._pending.delete(id);
        // 47b 桥 cancel 契约:tools/call 超时先按 MCP 标准发 notifications/cancelled(对端若实现协作式取消
        // 可收手);真正的兜底是 callTool catch 里的 kill 进程树(ACC 侧不响应取消也不留僵尸执行)。
        if (method === 'tools/call') { try { this._notify('notifications/cancelled', { requestId: id, reason: 'timeout' }); } catch { /* best-effort */ } }
        cleanup();
        reject(mcpBridgeError(`mcp ${method} timed out`, 'timeout'));
      }, Math.max(1000, timeoutMs));
      abortHandler = () => {
        if (!this._pending.has(id)) return;
        this._pending.delete(id);
        if (method === 'tools/call') { try { this._notify('notifications/cancelled', { requestId: id, reason: 'user_steer' }); } catch { /* best-effort */ } }
        cleanup();
        reject(mcpBridgeError(`mcp ${method} aborted by user steer`, 'abort'));
      };
      this._pending.set(id, { resolve, reject, timer, cleanup });
      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
        if (signal.aborted) { abortHandler(); return; }
      }
      try {
        const packet = { jsonrpc: '2.0', id, method, params: params || {} };
        const safePacket = options.executionCheck ? copyOrdinaryJsonData(packet) : packet;
        const encoded = JSON.stringify(safePacket);
        if (options.executionCheck) options.executionCheck(safePacket);
        this.child.stdin.write(encoded + '\n', 'utf8');
      } catch (e) {
        cleanup(); this._pending.delete(id); reject(e);
      }
    });
  }
  // Fire-and-forget notification (no id, no response expected).
  _notify(method, params) {
    if (this.dead || !this.child || !this.child.stdin || !this.child.stdin.writable) return;
    try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n', 'utf8'); } catch { /* ignore */ }
  }
  _onLine(line) {
    line = line.trim();
    if (!line) return;
    const msg = safeJsonParse(line);
    if (!msg || msg.id == null) return;          // notifications/logs from the server: ignore
    if (msg.method != null) {                     // 对端发起的请求(ping 等),不是给我们的响应
      if (this.dead || !this.child || !this.child.stdin || !this.child.stdin.writable) return;
      try { this.child.stdin.write(JSON.stringify(mcpServerRequestReply(msg)) + '\n', 'utf8'); } catch { /* ignore */ }
      return;
    }
    const p = this._pending.get(msg.id);
    if (!p) return;
    if (p.cleanup) p.cleanup(); else clearTimeout(p.timer);
    this._pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || 'mcp error'));
    else p.resolve(msg.result);
  }
  _failAllPending(err) {
    for (const [, p] of this._pending) { if (p.cleanup) p.cleanup(); else clearTimeout(p.timer); try { p.reject(err); } catch { /* settled */ } }
    this._pending.clear();
  }
  // 按行切 stdout。只在【新到的块】里找换行(修前每块都从整串头上重找,几十 MB 的一行是平方级);
  // 超过 _lineMax 的行整行丢弃到下一个换行,并按行首的 "id" 把那一次调用如实拒掉,不在行中间切。
  _onStdoutChunk(chunk) {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf('\n', start)) >= 0) {
      const piece = chunk.slice(start, nl);
      start = nl + 1;
      if (this._discarding) { this._discarding = false; continue; }
      const line = this._bufParts.length ? this._bufParts.join('') + piece : piece;
      this._bufParts = []; this._bufLen = 0;
      try { this._onLine(line); } catch { /* never let a bad line throw */ }
    }
    const rest = start ? chunk.slice(start) : chunk;
    if (!rest || this._discarding) return;
    this._bufParts.push(rest);
    this._bufLen += rest.length;
    if (this._bufLen > this._lineMax) {
      let head = '';
      for (const part of this._bufParts) { head += part.slice(0, 256 - head.length); if (head.length >= 256) break; }
      this._bufParts = []; this._bufLen = 0;
      this._discarding = true;
      const m = /^\s*\{[^{]*?"id"\s*:\s*(\d+)/.exec(head);   // 只认顶层 id(它前面不能再有别的 {)
      const p = m ? this._pending.get(Number(m[1])) : null;
      if (p) {
        this._pending.delete(Number(m[1]));
        if (p.cleanup) p.cleanup(); else clearTimeout(p.timer);
        p.reject(new Error(`mcp response too large (> ${Math.round(this._lineMax / 1048576)}MB single line)`));
      }
    }
  }

  // Spawn + handshake (initialize -> notifications/initialized -> tools/list). Throws on failure and
  // leaves the client marked dead (caller caches the failure so it won't respawn in a tight loop).
  async start() {
    if (this.started) return;
    this.started = true;
    const spawnEnv = DesktopExecutionHooks.clientEnvironment(this.id, bridgedServerSpawnEnv(process.env, this.env), this);
    this.executionContextRequired = spawnEnv.RUYI_EXECUTION_CONTEXT_REQUIRED === '1';
    let child;
    try {
      child = await ProcessRuntime.spawn(this.command, this.args, {
        cwd: this.cwd,
        env: spawnEnv,
        admit: () => { if (this.dead) throw Object.assign(new Error('MCP startup cancelled'), { code: 'ABORT_ERR' }); },
        stdio: ['pipe', 'pipe', 'pipe'],
      }, { kind: 'mcp', serverId: this.id });
    } catch (e) {
      this.dead = true;
      throw new Error(`spawn failed: ${e && e.message ? e.message : e}`);
    }
    if (this.dead) { killChildTree(child); await ProcessRuntime.waitForCleanup(child, 1500); throw new Error('MCP startup cancelled'); }
    this.child = child;
    this.pid = child.pid;
    // Don't let the live MCP child keep the event loop from exiting on a clean shutdown; we reap it
    // explicitly via killAllMcpClients()/killChildTree on exit.
    try { child.unref(); } catch { /* ignore */ }
    child.on('error', e => { this.dead = true; this._failAllPending(new Error('mcp child error: ' + (e && e.message))); });
    child.on('exit', (code, signal) => {
      this.dead = true;
      // 审计 A14:带上退出码/信号与 stderr 末尾,callTool 据此给模型可行动的说明(修前只有裸的「mcp child exited」)。
      const err = new Error(`mcp child exited (code ${code == null ? 'null' : code}${signal ? `, signal ${signal}` : ''})`);
      err.mcpChildExit = { code: code == null ? null : code, signal: signal || null, stderrTail: String(this._stderrTail || '').slice(-400).trim() };
      this._failAllPending(err);
    });
    // EPIPE on stdin must not crash the process.
    if (child.stdin) child.stdin.on('error', () => { /* ignore broken pipe */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this._onStdoutChunk(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { if (this._stderr.length < 8000) this._stderr += d; this._stderrTail = (String(this._stderrTail || '') + d).slice(-800); });

    try {
      const init = await this._rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: RUYI_MCP_SERVER_ID, version: VERSION }, // MCP 客户端标识名与 server id 一致
      }, mcpStartupRpcMs(this, 8000));
      this.serverInfo = (init && init.serverInfo) || {};
      this._notify('notifications/initialized', {});
      this.tools = await this._listAllTools(mcpStartupRpcMs(this, 8000));
    } catch (e) {
      this.kill();
      this.dead = true;
      throw new Error(`handshake failed: ${e && e.message ? e.message : e}${this._stderr ? ' | stderr: ' + this._stderr.slice(0, 300) : ''}`);
    }
    return this;
  }

  listTools() { return this.tools; }
  _listAllTools(timeoutMs) { return mcpListAllTools((m, p, t) => this._rpc(m, p, t), timeoutMs); }
  // 探针用:真发一次 tools/list(修前 probe 读的是握手时缓存的目录,卡死的服务器照样报「正常」)。
  async refreshTools(timeoutMs) { this.tools = await this._listAllTools(timeoutMs); return this.tools; }

  // Call a tool and normalize the MCP result into a workbench result object. Never throws.
  // 47b:超时走契约化处理 —— notifications/cancelled(_rpc 内已发)+ kill 客户端进程树(无僵尸执行),
  // 下次调用由 mcpClients 惰性重 spawn。错误文本如实告知"已杀进程树"。
  async callTool(name, args, timeoutMs, options = {}) {
    const refusal = DesktopExecutionHooks.callRefusal(this, name, args, options);
    if (refusal) return refusal;
    // 条目 disabledTools/enabledTools 在调用时再挡一道(目录里已经滤掉;这里防裸名容错路由或旧目录缓存绕过)。
    if (!mcpToolAllowed(this, name)) return { ok: false, error: `tool '${name}' is disabled for MCP server '${this.id}' (enabledTools/disabledTools)` };
    // 超时:调用方显式给的优先,其次条目的 toolTimeoutMs,最后按工具名的内置表。
    const limit = Math.max(1000, Number(timeoutMs) || Number(this.toolTimeoutMs) || bridgedToolCallTimeoutMs(name, args));
    try {
      const res = await this._rpc('tools/call', mcpCallToolParams(name, args, options), limit, options);
      return normalizeMcpToolResult(res);
    } catch (e) {
      const m = (e && e.message) ? e.message : String(e);
      if (e && e.mcpChildExit) return mcpChildExitResult(this, name, e.mcpChildExit);   // 审计 A14
      if (e && (e.mcpTimeout || e.mcpAborted)) {
        // _rpc already sent the cooperative cancellation notification. Report the verified
        // cleanup scope from the actual child handle, including dependency/identity failures.
        let cleanup;
        const stoppedChild = this.child;
        try {
          cleanup = this.kill();
          if (cleanup && cleanup.scope === 'owned-group-and-observed') {
            const confirmed = await ProcessRuntime.waitForCleanup(stoppedChild);
            if (confirmed) cleanup = confirmed;
          }
        } catch { cleanup = { scope: 'unknown', incomplete: true }; }
        const description = cleanup ? (cleanup.incomplete ? '桥接子进程清理未确认完成' : '已核验的桥接子进程已终止') : '桥接进程树已终止';
        const fields = cleanup ? { cleanupScope: cleanup.scope, cleanupIncomplete: cleanup.incomplete === true,
          ...(cleanup.escapeCoverage ? { cleanupEscapeCoverage: cleanup.escapeCoverage, cleanupUnconfirmed: cleanup.unconfirmed } : {}) } : {};
        if (e.mcpTimeout) return { ok: false, ...fields,
          error: `tool timed out after ${Math.round(limit / 1000)}s; ${description}${cleanup ? '' : '(防僵尸执行)'},下次调用将自动重连` };
        return { ok: false, ...fields, error: `工具已因用户插话中断；${description}，模型将立即处理新指令`, steerInterrupted: true };
      }
      return { ok: false, error: m };
    }
  }

  kill() {
    this.dead = true;
    this._failAllPending(new Error('mcp client killed'));
    if (this.child) this.lastCleanup = killChildTree(this.child);
    try { if (this.child && this.child.stdin) this.child.stdin.end(); } catch { /* ignore */ }
    this.child = null;
    return this.lastCleanup;
  }
}

// ===================================================================================================
// 49c — zero-dependency remote MCP client (03 §4.2). Two transports:
//   * 'http'  — streamable HTTP (2025-03-26): POST JSON-RPC to one endpoint; the response is either
//               application/json or text/event-stream (we parse both). Mcp-Session-Id is captured at
//               initialize and echoed on every later request.
//   * 'sse'   — legacy SSE transport (2024-11-05): GET opens an event stream whose first `endpoint`
//               event yields the POST uri; responses arrive back on the stream as `message` events.
// headers 值里的 ${VAR}/%VAR% 在【连接时】从 process.env 展开(配置里只存引用,密钥不落盘明文)。
// tools/list_changed:sse 流上收到该通知即惰性重列工具(下次 listTools 前刷新)。
// ===================================================================================================
class McpHttpClient {
  constructor({ id, transport, url, headers, bearerTokenEnvVar, startupTimeoutMs, toolTimeoutMs, enabledTools, disabledTools }) {
    this.id = id;
    this.transport = transport === 'sse' ? 'sse' : 'http';
    this.url = String(url || '');
    // 连接时展开密钥引用;未定义的变量保留原样(与 48c 导入器同语义)。
    this.headers = {};
    for (const [k, v] of Object.entries(headers || {})) this.headers[k] = _expandMcpVar(String(v));
    // bearerTokenEnvVar(Codex bearer_token_env_var / 导入的同名字段):连接时从 process.env 取令牌补
    // Authorization。修前存了不用,需要鉴权的远程连接器永远 401。显式写了 Authorization 头的以头为准。
    const tokenVar = typeof bearerTokenEnvVar === 'string' ? bearerTokenEnvVar.trim() : '';
    const token = tokenVar ? String(process.env[tokenVar] || '').trim() : '';
    if (token && !Object.keys(this.headers).some(k => k.toLowerCase() === 'authorization')) this.headers.Authorization = 'Bearer ' + token;
    this.startupTimeoutMs = startupTimeoutMs;
    this.toolTimeoutMs = toolTimeoutMs;
    this.enabledTools = enabledTools;
    this.disabledTools = disabledTools;
    this.dead = false;
    this.started = false;
    this.tools = [];
    this._nextId = 1;
    this._pending = new Map();     // rpc id -> { resolve, reject, timer }
    this._sessionId = null;
    this._sseReq = null;           // legacy-sse GET stream (http.ClientRequest)
    this._ssePostUrl = null;       // legacy-sse endpoint uri
    this._sseBuf = '';
    this._toolsStale = false;      // tools/list_changed 通知标记
  }

  _failAllPending(err) {
    for (const [, p] of this._pending) { if (p.cleanup) p.cleanup(); else clearTimeout(p.timer); try { p.reject(err); } catch { /* settled */ } }
    this._pending.clear();
  }

  _baseHeaders(extra) {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(this._sessionId ? { 'Mcp-Session-Id': this._sessionId } : {}),
      ...this.headers,
      ...(extra || {}),
    };
  }

  // One HTTP request. Returns { status, headers, body } (body = Buffer, capped at 8MB). Never throws.
  _request(method, urlStr, payload, timeoutMs, extraHeaders, options = {}) {
    return new Promise(resolve => {
      let u; try { u = new URL(urlStr); } catch { return resolve({ error: 'bad url: ' + urlStr }); }
      const lib = u.protocol === 'https:' ? require('https') : http;
      const bodyBuf = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : null;
      const signal = options && options.signal;
      let settled = false;
      let abortHandler = null;
      let why = '';   // 'timeout' / 'abort':这次失败是我们自己的超时 / 用户中断(不是对端的错误),随 error 一起交出去
      const finish = value => {
        if (settled) return;
        settled = true;
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        resolve(why && value && value.error ? { ...value, why } : value);
      };
      const req = lib.request(u, {
        method,
        headers: { ...this._baseHeaders(extraHeaders), ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}) },
        timeout: Math.max(1000, timeoutMs || 10000),
      }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', c => {
          size += c.length;
          if (size <= 8 * 1024 * 1024) chunks.push(c); // cap runaway bodies
        });
        res.on('end', () => finish({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', e => finish({ error: (e && e.message) || String(e) }));
      });
      req.on('timeout', () => { why = 'timeout'; req.destroy(new Error('request timed out')); });
      req.on('error', e => finish({ error: (e && e.message) || String(e) }));
      abortHandler = () => { why = 'abort'; req.destroy(new Error('request aborted by user steer')); };
      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
        if (signal.aborted) abortHandler();
      }
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  // Parse a text/event-stream body, returning the JSON-RPC messages it carries (data: lines, possibly
  // multi-line per event — the e5-multiline-sse lesson: join data lines with \n before JSON.parse).
  static _parseSseMessages(text) {
    const out = [];
    let dataLines = [];
    const flush = () => {
      if (!dataLines.length) return;
      const raw = dataLines.join('\n');
      dataLines = [];
      const msg = safeJsonParse(raw, null);
      if (msg && typeof msg === 'object') out.push(msg);
    };
    for (const line of String(text).split(/\r?\n/)) {
      if (line === '') { flush(); continue; }
      if (line.startsWith(':')) continue;                 // comment/heartbeat
      const m = line.match(/^data:\s?(.*)$/);
      if (m) dataLines.push(m[1]);
    }
    flush();
    return out;
  }

  // streamable-HTTP round trip: POST one JSON-RPC message, resolve with the matching-id result.
  async _rpcHttp(method, params, timeoutMs, options = {}) {
    if (this.dead) throw new Error('mcp client not running');
    const id = this._nextId++;
    const resp = await this._request('POST', this.url, { jsonrpc: '2.0', id, method, params: params || {} }, timeoutMs, null, options);
    if (resp.error) {
      // 49c 对抗验证修(第50波):_rpcHttp 超时也发 notifications/cancelled(与 _rpcSse/stdio _rpc 一致--
      //   对端若实现协作式取消可收手,不留无主处理)。连接可能已断,_notify 静默失败 best-effort。
      if (method === 'tools/call' && resp.why) { try { this._notify('notifications/cancelled', { requestId: id, reason: resp.why === 'abort' ? 'user_steer' : 'timeout' }); } catch { /* best-effort */ } }
      throw mcpBridgeError('mcp http: ' + resp.error, resp.why);
    }
    const sid = resp.headers && (resp.headers['mcp-session-id'] || resp.headers['Mcp-Session-Id']);
    if (sid && !this._sessionId) this._sessionId = String(sid);
    const ctype = String((resp.headers && resp.headers['content-type']) || '');
    let msgs = [];
    if (ctype.includes('text/event-stream')) msgs = McpHttpClient._parseSseMessages(resp.body.toString('utf8'));
    else { const j = safeJsonParse(resp.body.toString('utf8'), null); if (j) msgs = [j]; }
    // 带 method 的是对端发来的请求(同 id 撞号也不是给我们的响应)。
    const mine = msgs.find(m => m && m.id === id && m.method == null);
    if (!mine && this._sessionId && (resp.status === 404 || resp.status === 400 || resp.status === 401) && method !== 'initialize') {
      // 服务端会话失效(对端重启 / 会话过期:规范要求回 404,客户端须不带旧 Mcp-Session-Id 重新 initialize)。
      // 修前客户端既不重握手也不标 dead,之后每一次调用都 404,直到进程重启。现在就地重握手后重发一次
      // (对端没认这个会话,原请求不会被执行过);重握手或重发仍失败 -> 标 dead,下次 getMcpClient 整个重建。
      if (!options._sessionRetried) {
        this._sessionId = null;
        try { await this._initialize(timeoutMs); }
        catch (e) { this.kill(); throw new Error('mcp http: 会话已失效(HTTP ' + resp.status + '),重新握手失败: ' + ((e && e.message) || e)); }
        return this._rpcHttp(method, params, timeoutMs, { ...options, _sessionRetried: true });
      }
      this.kill();
      throw new Error('mcp http: 会话已失效(HTTP ' + resp.status + '),连接已重置,下次调用将重新握手');
    }
    if (!mine) throw new Error('mcp http: 响应中无匹配 id(状态 ' + resp.status + ')');
    if (mine.error) throw new Error(mine.error.message || 'mcp error');
    return mine.result;
  }

  // legacy-SSE round trip: POST to the endpoint uri (202 ack), the result arrives on the GET stream.
  _rpcSse(method, params, timeoutMs, options = {}) {
    return new Promise((resolve, reject) => {
      if (this.dead || !this._ssePostUrl) return reject(new Error('mcp sse: 事件流未就绪'));
      const id = this._nextId++;
      const signal = options && options.signal;
      let abortHandler = null;
      const cleanup = () => {
        clearTimeout(timer);
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      };
      const timer = setTimeout(() => {
        this._pending.delete(id);
        if (method === 'tools/call') { try { this._notify('notifications/cancelled', { requestId: id, reason: 'timeout' }); } catch { /* best-effort */ } }
        cleanup();
        reject(mcpBridgeError(`mcp ${method} timed out`, 'timeout'));
      }, Math.max(1000, timeoutMs));
      abortHandler = () => {
        if (!this._pending.has(id)) return;
        this._pending.delete(id);
        if (method === 'tools/call') { try { this._notify('notifications/cancelled', { requestId: id, reason: 'user_steer' }); } catch { /* best-effort */ } }
        cleanup();
        reject(mcpBridgeError(`mcp ${method} aborted by user steer`, 'abort'));
      };
      this._pending.set(id, { resolve, reject, timer, cleanup });
      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
        if (signal.aborted) { abortHandler(); return; }
      }
      this._request('POST', this._ssePostUrl, { jsonrpc: '2.0', id, method, params: params || {} }, timeoutMs, null, options)
        .then(resp => {
          if (resp.error || (resp.status && resp.status >= 400)) {
            cleanup(); this._pending.delete(id);
            reject(mcpBridgeError('mcp sse post: ' + (resp.error || ('HTTP ' + resp.status)), resp.why));
          }
        });
    });
  }

  _rpc(method, params, timeoutMs = 8000, options = {}) {
    return this.transport === 'sse' ? this._rpcSse(method, params, timeoutMs, options) : this._rpcHttp(method, params, timeoutMs, options);
  }

  _notify(method, params) {
    if (this.dead) return;
    const url = this.transport === 'sse' ? this._ssePostUrl : this.url;
    if (!url) return;
    this._request('POST', url, { jsonrpc: '2.0', method, params: params || {} }, 5000).catch(() => {});
  }

  // legacy-SSE: open the GET event stream, wait for the `endpoint` event, then keep reading `message`
  // events into the pending map. tools/list_changed notifications mark the catalog stale.
  async _openSseStream() {
    let u; try { u = new URL(this.url); } catch { throw new Error('bad url: ' + this.url); }
    const lib = u.protocol === 'https:' ? require('https') : http;
    await new Promise((resolve, reject) => {
      // hunt2-mcp:openTimer 修前声明在响应回调里,而 req.on('error') 在回调外引用它 —— 连接被拒(连接器
      // 地址写错/对端没起)时 error 先于任何响应到达,ReferenceError 冒成 uncaughtException,整个工作台进程退出。
      // 现在提到外层、从发请求起就计时:连不上、连上不给 endpoint、TCP 挂住,都在这一个时限内拒掉并断开请求。
      let opened = false;
      let req = null;
      const openTimer = setTimeout(() => {
        if (opened) return;
        reject(new Error('mcp sse: 等 endpoint 事件超时'));
        try { if (req) req.destroy(); } catch { /* ignore */ }
      }, mcpStartupRpcMs(this, 8000));
      req = lib.request(u, { method: 'GET', headers: { ...this.headers, 'Accept': 'text/event-stream' } }, res => {
        if (res.statusCode >= 400) { clearTimeout(openTimer); reject(new Error('mcp sse: HTTP ' + res.statusCode)); res.resume(); return; }
        res.setEncoding('utf8');
        // 干净的事件累积器:event:/data: 逐行累积,空行派发(多行 data 以 \n 连接 —— e5-multiline-sse 教训)。
        let evtName = 'message', evtData = [];
        const dispatch = () => {
          if (!evtData.length) { evtName = 'message'; return; }
          const raw = evtData.join('\n');
          const name = evtName;
          evtName = 'message'; evtData = [];
          if (name === 'endpoint' && !opened) {
            opened = true; clearTimeout(openTimer);
            this._ssePostUrl = new URL(raw.trim(), this.url).toString();
            resolve();
            return;
          }
          const msgObj = safeJsonParse(raw, null);
          if (!msgObj) return;
          if (msgObj.id != null && msgObj.method != null) {
            // 对端发来的请求(ping 等):回话走 endpoint POST,绝不拿它的 id 去结我们的 pending。
            if (!this.dead && this._ssePostUrl) this._request('POST', this._ssePostUrl, mcpServerRequestReply(msgObj), 5000).catch(() => {});
            return;
          }
          if (msgObj.id != null) {
            const p = this._pending.get(msgObj.id);
            if (p) {
              if (p.cleanup) p.cleanup(); else clearTimeout(p.timer); this._pending.delete(msgObj.id);
              if (msgObj.error) p.reject(new Error(msgObj.error.message || 'mcp error'));
              else p.resolve(msgObj.result);
            }
          } else if (msgObj.method === 'notifications/tools/list_changed') {
            this._toolsStale = true; // 03 §4.2:响应 tools/list_changed —— 下次 listTools 前重列
          }
        };
        res.on('data', chunk => {
          this._sseBuf += chunk;
          let nl;
          while ((nl = this._sseBuf.indexOf('\n')) >= 0) {
            const line = this._sseBuf.slice(0, nl).replace(/\r$/, '');
            this._sseBuf = this._sseBuf.slice(nl + 1);
            if (line === '') { dispatch(); continue; }
            if (line.startsWith(':')) continue; // heartbeat/comment
            const em = line.match(/^event:\s?(.*)$/); if (em) { evtName = em[1].trim() || 'message'; continue; }
            const dm = line.match(/^data:\s?(.*)$/); if (dm) { evtData.push(dm[1]); continue; }
          }
        });
        res.on('end', () => { this.dead = true; this._failAllPending(new Error('mcp sse: 事件流断开')); });
        res.on('error', e => { this.dead = true; this._failAllPending(new Error('mcp sse: ' + (e && e.message))); });
      });
      req.on('error', e => {
        clearTimeout(openTimer);
        reject(new Error('mcp sse connect: ' + (e && e.message)));   // 已 open 时是空操作
        // 已建立的流中途断(ECONNRESET 等):与 res 'error' 同一收尾,挂着的调用立刻失败,下次调用重建。
        if (opened) { this.dead = true; this._failAllPending(new Error('mcp sse: ' + (e && e.message))); }
      });
      this._sseReq = req; // Own the connection while waiting for headers too.
      req.end();
    });
  }

  async start() {
    if (this.started) return;
    this.started = true;
    try {
      if (this.transport === 'sse') await this._openSseStream();
      await this._initialize(mcpStartupRpcMs(this, 10000));
      this.tools = await this._listAllTools(mcpStartupRpcMs(this, 10000));
    } catch (e) {
      this.kill();
      this.dead = true;
      throw new Error(`remote mcp handshake failed: ${e && e.message ? e.message : e}`);
    }
    return this;
  }

  // initialize + notifications/initialized。start 与「会话失效就地重握手」共用。
  async _initialize(timeoutMs) {
    const init = await this._rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: RUYI_MCP_SERVER_ID, version: VERSION },
    }, timeoutMs);
    this.serverInfo = (init && init.serverInfo) || {};
    this._notify('notifications/initialized', {});
    return init;
  }
  _listAllTools(timeoutMs) { return mcpListAllTools((m, p, t) => this._rpc(m, p, t), timeoutMs); }
  // 探针用:真发一次 tools/list,不读缓存(同 McpStdioClient.refreshTools)。
  async refreshTools(timeoutMs) { this.tools = await this._listAllTools(timeoutMs); this._toolsStale = false; return this.tools; }

  // 03 §4.2 tools/list_changed:sse 通知把目录标陈旧,此处惰性重列(不主动推,桥是拉模型)。
  async listTools() {
    if (this._toolsStale && !this.dead) {
      try {
        this.tools = await this._listAllTools(8000);
      } catch { /* 保留旧目录,下次再试 */ }
      this._toolsStale = false;
    }
    return this.tools;
  }

  // Same result normalization as McpStdioClient.callTool — never throws.
  async callTool(name, args, timeoutMs, options = {}) {
    const refusal = DesktopExecutionHooks.callRefusal(this, name, args, options);
    if (refusal) return refusal;
    if (!mcpToolAllowed(this, name)) return { ok: false, error: `tool '${name}' is disabled for MCP server '${this.id}' (enabledTools/disabledTools)` };
    const limit = Math.max(1000, Number(timeoutMs) || Number(this.toolTimeoutMs) || bridgedToolCallTimeoutMs(name, args));
    try {
      const res = await this._rpc('tools/call', mcpCallToolParams(name, args, options), limit, options);
      return normalizeMcpToolResult(res);
    } catch (e) {
      const m = (e && e.message) ? e.message : String(e);
      if (e && e.mcpAborted) {
        try { this.kill(); } catch { /* already dead */ }
        return { ok: false, error: '工具已因用户插话中断；远程 MCP 连接已重置，模型将立即处理新指令', steerInterrupted: true };
      }
      if (e && e.mcpTimeout) {
        // 远程无进程树可杀 —— 断连接 + 下次调用惰性重建(sse 流 / session 重新握手)。
        try { this.kill(); } catch { /* already dead */ }
        return { ok: false, error: `tool timed out after ${Math.round(limit / 1000)}s; 远程连接已重置,下次调用将自动重连` };
      }
      return { ok: false, error: m };
    }
  }

  kill() {
    this.dead = true;
    this._failAllPending(new Error('mcp client killed'));
    try { if (this._sseReq) this._sseReq.destroy(new Error('mcp client killed')); } catch { /* ignore */ }
    this._sseReq = null;
  }
}

return { McpStdioClient, McpHttpClient, mcpToolAllowed, normalizeMcpToolResult, bridgedServerSpawnEnv, mcpCallToolParams };
}
module.exports = { createMcpTransports };
