'use strict';

const crypto = require('node:crypto');

function createMcpClientRuntime({
  McpHttpClient, McpStdioClient, logEvent, readConfig, mcpToolAllowed, resolveExternalMcpServers, discovery,
  masking,
}) {
  const {
    detectDesktopMcp, enabledToolboxComponents, ensureDesktopMcpWarm, invalidateMcpDropInCache,
    scanMcpDropIns,
  } = discovery;
  const { maskKey, safeUrlForDisplay } = masking;

  const mcpClients = new Map();       // serverId -> McpStdioClient
  const mcpClientFailures = new Map(); // serverId -> { at, error }
  const MCP_FAILURE_COOLDOWN_MS = 60000;
  const mcpClientPending = new Map();  // 55a: serverId -> 进行中的 start Promise(并发互斥,防孤儿子进程)
  const mcpStartingClients = new Map(); // 55a: serverId -> 正在握手(尚未入 mcpClients)的客户端,invalidate 时需 kill
  const mcpClientGen = new Map();     // 55a: serverId -> 代数;invalidate 自增以让在途 start 结果作废、不写冷却
  // hunt2-mcp:serverId -> 当前运行时状态(活客户端 / 在途启动 / 失败冷却)所属条目的指纹。上面几张表都只按 id 记账,
  // 修前用户在设置页 / import-folder / import-config 里改好了一个坏连接器(同 id),旧进程、旧冷却(60s 内一律 null)
  // 与在途启动照用不误 —— 「改好了还是连不上」。现在取客户端前先比指纹,变了就按 invalidateMcpRuntime 作废旧的。
  const mcpClientFingerprints = new Map();
  function mcpEntryFingerprint(entry) {
    const e = entry || {};
    return JSON.stringify([e.transport || 'stdio', e.command || '', e.args || [], e.cwd || '', e.env || {}, e.url || '', e.headers || {},
      e.bearerTokenEnvVar || '', e.startupTimeoutMs || 0, e.toolTimeoutMs || 0, e.enabledTools || null, e.disabledTools || null]);
  }
  function reconcileMcpEntryFingerprint(entry) {
    if (!entry || !entry.id) return;
    const fp = mcpEntryFingerprint(entry);
    const prev = mcpClientFingerprints.get(entry.id);
    if (prev !== undefined && prev !== fp) invalidateMcpRuntime(entry.id);
    mcpClientFingerprints.set(entry.id, fp);
  }

  function invalidateMcpRuntime(id) {
    invalidateMcpDropInCache();
    bridgedCatalogCache = { key: '', expiresAt: 0, value: null };
    if (id) {
      const client = mcpClients.get(id);
      if (client) { try { client.kill(); } catch { /* ignore */ } mcpClients.delete(id); }
      // 55a: kill 正在握手(尚未入 mcpClients)的子进程 -- 否则一个 HANG 初始化的进程会活到 8s rpc 超时,
      // 既成孤儿(toggle 应立即停),又会让后续并发 probe 复用其永挂的 pending Promise 而不重新 spawn。
      const starting = mcpStartingClients.get(id);
      if (starting) { try { starting.kill(); } catch { /* ignore */ } mcpStartingClients.delete(id); }
      mcpClientFailures.delete(id);
      // hunt2-mcp:在途 start 的 Promise 也摘掉 —— 否则紧接着的 getMcpClient 会复用这个已被作废(结果注定 null)的
      // Promise,而不是按新配置重新起一个。
      mcpClientPending.delete(id);
      mcpClientFingerprints.delete(id);
      // 自增代数:在途 start(其 Promise 仍可能被并发 probe await)settle 后据此作废结果——
      // 已 killed 的失败不写冷却(否则 toggle-on 后立刻又命中 60s 冷却不重连)。
      mcpClientGen.set(id, (mcpClientGen.get(id) || 0) + 1);
    }
  }

  // 审计 A14:getBridgedClient 返回 null 时的说明 —— 带上上一次启动失败的原因与冷却剩余,而不是一句「not available」。
  function bridgedServerUnavailableMessage(serverId) {
    const base = `bridged MCP server '${serverId}' is not available`;
    const fail = mcpClientFailures.get(serverId);
    if (!fail) return `${base} (it could not be started or has no launch command configured)`;
    const leftSec = Math.max(0, Math.ceil((MCP_FAILURE_COOLDOWN_MS - (Date.now() - fail.at)) / 1000));
    return `${base}: the last start failed: ${String(fail.error || 'unknown error').slice(0, 300)}. ${leftSec > 0 ? `It will be retried automatically in about ${leftSec}s.` : 'It will be retried on the next call.'} Use another tool meanwhile.`;
  }
  // Get (lazily starting) a live client for one server entry, or null if it can't start. Caches failures.
  // 49c:按 entry.transport 选客户端类 —— sse/http 走 McpHttpClient(无进程,远程连接),其余走 stdio。
  async function getMcpClient(entry) {
    reconcileMcpEntryFingerprint(entry);
    const existing = mcpClients.get(entry.id);
    if (existing && !existing.dead) return existing;
    if (existing && existing.dead) mcpClients.delete(entry.id);
    const fail = mcpClientFailures.get(entry.id);
    if (fail && (Date.now() - fail.at) < MCP_FAILURE_COOLDOWN_MS) return null;   // in cooldown
    // 55a: 并发互斥 -- 同一 entry.id 的并发 getMcpClient 复用同一个 start Promise。probeMcpConnector 的
    // start race-timeout(可低至 2s)先于 getMcpClient 的 8s rpc 超时返回,若无互斥,第二次 probe 会 spawn
    // 第二个子进程;两个都成功时第一个子进程成孤儿(child.unref 只防阻止退出不杀进程,持有句柄/端口/锁)。
    if (mcpClientPending.has(entry.id)) return mcpClientPending.get(entry.id);
    const gen = (mcpClientGen.get(entry.id) || 0);
    const p = (async () => {
      const client = (entry.transport === 'sse' || entry.transport === 'http') ? new McpHttpClient(entry) : new McpStdioClient(entry);
      mcpStartingClients.set(entry.id, client);
      try {
        await client.start();
        // 启动期间被 invalidateMcpRuntime 作废(配置变更/toggle):丢弃结果,不登记为活客户端,也不写失败冷却。
        if ((mcpClientGen.get(entry.id) || 0) !== gen) { try { client.kill(); } catch { /* ignore */ } return null; }
        mcpClients.set(entry.id, client);
        mcpClientFailures.delete(entry.id);
        return client;
      } catch (e) {
        // 被 invalidate kill 的在途启动:不写冷却(用户期望 toggle-on 后可立即重连)。
        if ((mcpClientGen.get(entry.id) || 0) !== gen) return null;
        mcpClientFailures.set(entry.id, { at: Date.now(), error: (e && e.message) || String(e) });
        logEvent({ kind: 'mcp_bridge_start_failed', serverId: entry.id, error: (e && e.message) || String(e) });
        return null;
      } finally {
        if (mcpStartingClients.get(entry.id) === client) mcpStartingClients.delete(entry.id);
      }
    })();
    mcpClientPending.set(entry.id, p);
    // 只摘自己那一个:invalidate 之后别人可能已经放进了新的在途 Promise。
    try { return await p; } finally { if (mcpClientPending.get(entry.id) === p) mcpClientPending.delete(entry.id); }
  }

  // Kill every live bridged client (called on process exit / cleanup).
  function killAllMcpClients() {
    for (const [, c] of mcpClients) { try { c.kill(); } catch { /* ignore */ } }
    mcpClients.clear();
    // hunt2-mcp:还在握手的也要杀 —— 修前退出时它们不在 mcpClients 里,子进程成孤儿(unref 过,不拦退出)。
    for (const [, c] of mcpStartingClients) { try { c.kill(); } catch { /* ignore */ } }
    mcpStartingClients.clear();
  }

  // 47b:桥客户端获取的统一入口 —— 活则直给;死/缺则按 config 的服务器条目经 getMcpClient 惰性重 spawn。
  // 此前三处分发点(12-tool-dispatch / 08 / 09)直接 mcpClients.get,47b 超时杀客户端后永远 'not available'
  // 无法自愈;统一走这里后,"超时杀 → 下次调用自动重连"的契约闭环。
  async function getBridgedClient(serverId, config) {
    const live = mcpClients.get(serverId);
    if (live && !live.dead) return live;
    const list = resolveExternalMcpServers(config || await readConfig());
    const entry = (list || []).find(s => s.id === serverId);
    if (!entry || (!entry.command && !entry.url)) return null; // 49c:远程条目无 command,认 url
    return getMcpClient(entry);
  }

  // Stable, reversible-ish server-id sanitizer for the bridged tool-name prefix. Non [A-Za-z0-9_] -> _.

  function sanitizeServerId(id) { return String(id || '').replace(/[^A-Za-z0-9_]/g, '_'); }
  // hunt2-mcp:provider 的函数名只收 ^[a-zA-Z0-9_-]{1,64}$。修前前缀冲突(my-srv 与 my_srv 都成 my_srv)时后到的
  // 服务器工具被静默丢掉;工具名里带 . / 空格或总长超 64 的,整批请求被 provider 400 拒掉。
  // 前缀冲突:先到者(desktop 在最前)保留原前缀,后到者加 id 的短哈希;名字非法字符转 _,超长截断并补哈希保唯一。
  function mcpShortHash(text) { return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 6); }
  function bridgedToolFunctionName(prefix, toolName) {
    const raw = `${prefix}__${String(toolName).replace(/[^A-Za-z0-9_-]/g, '_')}`;
    if (raw.length <= 64) return raw;
    return raw.slice(0, 57) + '_' + mcpShortHash(`${prefix}__${toolName}`);
  }

  // v0.7d line 2: collect bridged tools for THIS turn (once). Returns { tools:[openai fn schema], route }.
  // route maps bridgedName -> { serverId, toolName }. Any server that fails to start/list is skipped;
  // never throws, never blocks the main flow.
  let bridgedCatalogCache = { key: '', expiresAt: 0, value: null };
  // 整体扫描时限:getCapabilities 冷启动(网络探测 + 全量 MCP 扫描)不能无限期阻塞 —— 本机 ~/.claude.json
  // 可能导入 10+ 个 MCP(含挂起桩 stdio-hang),串行 listTools 实测可达 18.9s,远超 /api/capabilities 的
  // HTTP 超时(e2e 8s)。到点返回已收集的部分结果,不因单个慢/挂 MCP 拖死整次探测。
  // 单个 MCP 的握手预算:start() 内部 initialize + tools/list 各 8s 上限,挂起桩(stdio-hang)串行可吃满 16s。
  // 扫描期对每个 entry 用该预算 race,超时即跳过该 MCP —— 扫描不被单桩拖死,慢 MCP 的下次调用再补(有 60s 冷却)。
  const BRIDGED_ENTRY_START_TIMEOUT_MS = Number(process.env.WCW_BRIDGED_ENTRY_START_TIMEOUT_MS) || 3500;   // env 仅为测试缝(unit/bridged-catalog-incomplete)
  // 整体扫描时限:getCapabilities 冷启动(网络探测 + 全量 MCP 扫描)不能无限期阻塞 —— 本机 ~/.claude.json
  // 可能导入 10+ 个 MCP,串行扫描实测可达 18.9s,远超 /api/capabilities 的 HTTP 超时(e2e 8s)。
  // 到点返回已收集的部分结果,不因单个慢/挂 MCP 拖死整次探测。
  const BRIDGED_CATALOG_SCAN_TIMEOUT_MS = 8000;

  async function collectBridgedTools(config, force = false) {
    if (!config || config.bridgeExternalToolsToProvider === false) return { tools: [], route: {} };
    const entries = resolveExternalMcpServers(config);
    const cacheKey = JSON.stringify(entries.map(e => [e.id, mcpEntryFingerprint(e)]));   // 过滤表 / 超时 / 头也算目录变化
    if (!force && bridgedCatalogCache.value && bridgedCatalogCache.key === cacheKey && Date.now() < bridgedCatalogCache.expiresAt) {
      return bridgedCatalogCache.value;
    }
    // 残缺目录不进长缓存(审计 A3)之后,启动期一阵并发请求(状态轮询 / 能力探测 / 首回合)会各自重扫、各自再等一轮
    // 启动竞速:同一 key 的扫描在飞时直接共用它;force 照旧另起。
    if (!force && bridgedCatalogInflight && bridgedCatalogInflight.key === cacheKey) return bridgedCatalogInflight.promise;
    const promise = collectBridgedToolsScan(config, entries, cacheKey);
    if (!force) bridgedCatalogInflight = { key: cacheKey, promise };
    try { return await promise; }
    finally { if (bridgedCatalogInflight && bridgedCatalogInflight.promise === promise) bridgedCatalogInflight = null; }
  }
  let bridgedCatalogInflight = null;   // { key, promise }:同一 key 的目录扫描在飞时共用
  // 残缺目录也短暂缓存 1 s:吸收紧挨着的一串调用,又不耽误慢起来的 MCP 在下一次(>1 s 后)被补进目录。
  const BRIDGED_CATALOG_INCOMPLETE_TTL_MS = 1000;
  async function collectBridgedToolsScan(config, entries, cacheKey) {
    const tools = [];
    const route = {};
    let incomplete = false;   // 有 entry 没在预算内起来 / 起不来:这一次的目录是残缺的
    const scan = (async () => {
      // 并行收集每个 entry 的 client + tools —— N 个 MCP 同时启动,单个慢/挂不再拖慢其它(每 entry 有独立握手预算)。
      const collected = await Promise.all(entries.map(async (entry) => {
        let client = null;
        try {
          // 每 entry 的 getMcpClient(内含 start 握手)跑在独立 race 里:挂起桩最多占自身预算,不影响并行中的其余 MCP。
          client = await Promise.race([
            getMcpClient(entry),
            new Promise(res => setTimeout(() => res('__timeout__'), BRIDGED_ENTRY_START_TIMEOUT_MS)),
          ]);
        } catch { client = null; }
        if (!client || client === '__timeout__') { incomplete = true; return null; }   // 审计 A3:没扫全的目录不缓存
        let list;
        try { list = await client.listTools(); } catch { list = []; }
        return { entry, list: Array.isArray(list) ? list : [] };
      }));
      const prefixOwner = new Map();   // 前缀 -> 占用它的 serverId
      for (const item of collected) {
        if (!item) continue;
        const { entry, list } = item;
        let prefix = sanitizeServerId(entry.id);
        if (prefixOwner.has(prefix) && prefixOwner.get(prefix) !== entry.id) {
          const taken = prefix;
          prefix = `${prefix}_${mcpShortHash(entry.id)}`;
          logEvent({ kind: 'mcp_bridge_prefix_collision', serverId: entry.id, other: prefixOwner.get(taken), prefix });
        }
        prefixOwner.set(prefix, entry.id);
        for (const t of list) {
          if (!t || typeof t.name !== 'string' || !t.name) continue;
          if (!mcpToolAllowed(entry, t.name)) continue;   // 条目 enabledTools / disabledTools
          const bridgedName = bridgedToolFunctionName(prefix, t.name);
          // Never overwrite an already-claimed name (defensive; prefixes make collisions unlikely).
          if (route[bridgedName]) continue;
          route[bridgedName] = { serverId: entry.id, toolName: t.name };
          tools.push({
            type: 'function',
            function: {
              name: bridgedName,
              description: t.description || t.name,
              parameters: (t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema : { type: 'object', properties: {} },
            },
          });
        }
      }
    })();
    // 整体时限兜底:超时后返回当前已收集的部分(可能缺慢 MCP 的工具,但探测本身不再被拖死)。
    let scanDone = false;
    try {
      await Promise.race([scan.then(() => { scanDone = true; }), new Promise(res => setTimeout(res, BRIDGED_CATALOG_SCAN_TIMEOUT_MS))]);
    } catch { /* 并行收集失败不阻断 —— 返回已收集部分 */ }
    if (!scanDone) incomplete = true;
    const value = { tools, route };
    // 审计 A3:桌面组件(ACC)冷启动可能赶不上 3.5 s 的启动竞速。修前把「缺了它」的目录照常缓存 60 s,首几个回合模型看不到任何桌面
    // 工具、tool_search 也搜不到。现在残缺目录【不缓存】:下一次调用重新扫(慢的那个 start 仍在后台跑,getMcpClient 的
    // 待决互斥保证不会重复起进程;真起不来的有 60 s 失败冷却,重扫是廉价的 null)。
    if (incomplete) {
      bridgedCatalogCache = { key: cacheKey, expiresAt: Date.now() + BRIDGED_CATALOG_INCOMPLETE_TTL_MS, value };
      return value;
    }
    bridgedCatalogCache = {
      key: cacheKey,
      expiresAt: Date.now() + Math.max(5000, Number(config.toolCatalogCacheTtlMs) || 60000),
      value,
    };
    return value;
  }

  // ── 第55波 EC-C 55a: MCP 运维闭环 -- 统一读模型 + 健康探针 + 错误归类 + 兼容矩阵 ──────────
  // 目标(roadmap EC-C):让非程序员不编辑 JSON 也能判断「接上了没有、为什么不可用、怎样恢复」。
  // 本批为后端地基(路由在 13b,前端在 55c):
  //  - MCP_COMPAT_MATRIX:在连接前说明 stdio/sse/http 各 transport 的能力与局限(退出条件#4)。
  //  - classifyMcpError:把裸错误归一为 7 类(startup/network/auth/protocol/tool_registration/timeout/
  //    security),而非统一「连接失败」(退出条件#3)。
  //  - probeMcpConnector:对单连接器做一次显式健康探测,复用 getMcpClient(活则直给、死则重 spawn),
  //    绝不抛,返回结构化 status。start 阶段用 probe 超时竞速(避免 8s rpc 超时拖慢用户重测)。
  //  - buildMcpConnectorInventory:合并 desktop/config/drop-in 三源为带 source/transport/commandOrUrl/
  //    enabled/builtIn/capabilities 的统一清单(含 disabled 条目,UI 需展示并允许启用);env 值掩码,
  //    不返回可执行命令串供前端拼写(配置变更走 import/toggle 路由 + token + 审计,退出条件#5)。

  const MCP_COMPAT_MATRIX = {
    stdio: {
      transport: 'stdio',
      capabilities: ['initialize', 'tools/list', 'tools/call', 'notifications/cancelled'],
      limitations: ['无服务端推送 tools/list_changed(工具列表变化需重新 tools/list 探测)'],
      supportsListChanged: false,
    },
    http: {
      transport: 'http (streamable-HTTP 2025-03-26)',
      capabilities: ['initialize', 'tools/list', 'tools/call', 'Mcp-Session-Id 会话', 'tools/list_changed 推送'],
      limitations: ['需可访问 URL;密钥引用连接时才展开(不落盘明文)'],
      supportsListChanged: true,
    },
    sse: {
      transport: 'sse (legacy 2024-11-05)',
      capabilities: ['initialize', 'tools/list', 'tools/call', 'tools/list_changed 推送'],
      limitations: ['legacy transport;新建连接器优先 streamable-HTTP'],
      supportsListChanged: true,
    },
  };

  // 把裸错误归一为 EC-C 退出条件要求的 7 类。顺序敏感:先匹配更具体的类别(auth/startup/network/
  // timeout/security/tool_registration 在 protocol 之前,因为握手失败往往携带更具体的根因词)。
  function classifyMcpError(err, entry) {
    const raw = (err && err.message) ? err.message : String(err == null ? '' : err);
    const msg = raw.toLowerCase();
    const transport = entry && entry.transport;
    // auth:HTTP 401/403(远程 transport 鉴权失败)。锚定 HTTP 上下文(HTTP/状态/status/code + 数字),
    // 避免误匹配端口号(如 ECONNREFUSED 127.0.0.1:401 -> 应归 network,非 auth)。
    if (/(?:HTTP|状态|status|code)\s*(401|403)\b|unauthorized|forbidden/i.test(msg)) return { category: 'auth', message: raw };
    // startup:spawn 失败 / 子进程退出 / ENOENT / not running(stdio 进程层)
    if (/spawn failed|enoent|exited|not running|child error/.test(msg)) return { category: 'startup', message: raw };
    // network:连接层(ECONNREFUSED/ENOTFOUND/ETIMEDOUT/ECONNRESET/bad url/EPIPE/socket hang up)
    if (/econnrefused|enotfound|etimedout|econnreset|eai_again|bad url|epipe|connect econn|socket hang up/.test(msg)) return { category: 'network', message: raw };
    // cancelled:用户 steer 中断/显式取消(优先于 timeout,防误归超时)
    if (/cancelled|canceled|aborted by user steer/.test(msg)) return { category: 'cancelled', message: raw };
    // timeout:rpc/请求/探针超时
    if (/timed out|timeout/.test(msg)) return { category: 'timeout', message: raw };
    // security:SSRF / sanitize 拒绝 / 非 http(s) url
    if (/ssrf|内网|sanitize|invalid entry|non-http|ftp:/.test(msg)) return { category: 'security', message: raw };
    // tool_registration:tools/list 失败或空目录
    if (/tools\/list|no tools|empty tools/.test(msg)) return { category: 'tool_registration', message: raw };
    // protocol:握手失败 / 非 MCP 响应 / JSON-RPC 错误 / initialize 被拒
    if (/handshake failed|non-mcp|bad json|protocol|initialize|mcp error|parse|json-rpc|无匹配 id/.test(msg)) return { category: 'protocol', message: raw };
    return { category: 'unknown', message: raw };
  }

  // 对单连接器做一次显式健康探测(用户「为什么不可用」排查 / 清单 ?probe=1)。
  // 复用 getMcpClient(活则直给,死则按 config 条目重 spawn;受 MCP_FAILURE_COOLDOWN_MS 冷却约束 ->
  // 冷却中返回存储的失败归类)。start 阶段用 probe 超时竞速,避免 stdio 8s rpc 超时拖慢用户重测。
  // 绝不抛;返回 {id, status:'ok'|'degraded'|'failed', category?, message?, toolCount?, latencyMs, ...}。
  async function probeMcpConnector(entry, opts = {}) {
    const startedAt = Date.now();
    const probedAt = new Date().toISOString();
    const timeoutMs = Math.max(2000, Number(opts && opts.timeoutMs) || 10000);
    if (!entry || (!entry.id && !entry.command && !entry.url)) {
      return { id: null, status: 'failed', category: 'startup', message: 'invalid entry', latencyMs: 0, probedAt };
    }
    reconcileMcpEntryFingerprint(entry);   // 配置改过(同 id)-> 旧客户端 / 旧冷却作废,按新条目重测
    let client = mcpClients.get(entry.id);
    // 已经活着的客户端:下面真发一次 tools/list(hunt2-mcp:修前读握手时缓存的目录,卡死的服务器也报 ok)。
    const wasLive = Boolean(client && !client.dead);
    if (!client || client.dead) {
      try {
        client = await Promise.race([
          getMcpClient(entry),
          new Promise((_, reject) => setTimeout(() => reject(new Error('mcp probe timed out (start)')), timeoutMs)),
        ]);
      } catch (e) {
        const cls = classifyMcpError(e, entry);
        return { id: entry.id, status: 'failed', ...cls, latencyMs: Date.now() - startedAt, probedAt };
      }
    }
    if (!client) {
      // getMcpClient 返回 null:冷却中或 start 失败已存。回放存储的失败归类。
      const fail = mcpClientFailures.get(entry.id);
      const err = fail ? new Error(fail.error) : new Error('mcp client not available');
      const cls = classifyMcpError(err, entry);
      return { id: entry.id, status: 'failed', ...cls, latencyMs: Date.now() - startedAt, probedAt };
    }
    try {
      let probeTimer = null;
      const tools = await Promise.race([
        Promise.resolve(wasLive && typeof client.refreshTools === 'function' ? client.refreshTools(timeoutMs) : client.listTools()),
        new Promise((_, reject) => { probeTimer = setTimeout(() => reject(new Error('mcp tools/list timed out')), timeoutMs); }),
      ]).finally(() => clearTimeout(probeTimer));
      const toolCount = Array.isArray(tools) ? tools.length : 0;
      return {
        id: entry.id,
        status: toolCount > 0 ? 'ok' : 'degraded',
        toolCount,
        latencyMs: Date.now() - startedAt,
        serverInfo: client.serverInfo || null,
        transport: entry.transport || 'stdio',
        probedAt,
      };
    } catch (e) {
      const cls = classifyMcpError(e, entry);
      return { id: entry.id, status: 'failed', ...cls, latencyMs: Date.now() - startedAt, probedAt };
    }
  }

  // 合并 desktop/config/drop-in 三源为统一读模型。与 resolveExternalMcpServers 的关键差异:本函数
  // 【包含 disabled 条目】(UI 需展示已停用的连接器并允许启用),并附 source/transport/commandOrUrl/
  // enabled/builtIn/capabilities。probe 时复用 resolveExternalMcpServers 取真实 entry(含完整 env,无漂移)。
  // env 值经 maskKey 掩码(防 token 类泄漏);command/url 不掩(配置面非密钥,UI 需识别连接器)。
  async function buildMcpConnectorInventory(config, opts = {}) {
    // 39 号文:本函数下面两处(resolveExternalMcpServers 与第 1 段的 autodetect)在冷缓存时会同步探针。
    // 它是 async,所以先等那趟异步预热 —— 缓存热时零开销,冷时也不再把事件循环钉住。
    await ensureDesktopMcpWarm(config);
    const doProbe = !!(opts && opts.probe);
    const probeTimeoutMs = Math.max(2000, Number(opts && opts.probeTimeoutMs) || 10000);
    const resolvedById = new Map();
    if (doProbe) {
      for (const e of resolveExternalMcpServers(config)) resolvedById.set(e.id, e);
    }
    const out = [];
    const addItem = (spec) => {
      const transport = (spec.transport === 'sse' || spec.transport === 'http') ? spec.transport : 'stdio';
      const cap = MCP_COMPAT_MATRIX[transport] || MCP_COMPAT_MATRIX.stdio;
      const maskedEnv = {};
      for (const [k, v] of Object.entries(spec.env || {})) maskedEnv[k] = maskKey(String(v));
      out.push({
        id: spec.id,
        label: spec.label || spec.id,
        source: spec.source,
        builtIn: !!spec.builtIn,
        transport,
        commandOrUrl: transport === 'stdio' ? String(spec.command || '') : safeUrlForDisplay(spec.url),
        enabled: spec.enabled !== false,
        capabilities: cap,
        envKeys: Object.keys(spec.env || {}),
        env: maskedEnv,
        argsCount: Array.isArray(spec.args) ? spec.args.length : 0,
        cwd: spec.cwd || '',
        health: null,
      });
    };
    // 1. desktop MCP(ai-computer-control,工作台签名能力 -- 内置)
    const dm = config && config.desktopMcp;
    if (dm) {
      let command = String(dm.command || '').trim();
      let args = Array.isArray(dm.args) ? dm.args.slice() : [];
      let cwd = String(dm.cwd || '').trim() || undefined;
      let env = {};
      if (command) {
        env = { PYTHONUTF8: '1' };
      } else if (dm.enabled !== false && dm.autodetect) {
        // 55a: 仅在启用时 autodetect(detectDesktopMcp 内部 spawnSync 最多 5s,禁用时不应阻塞 GET 清单)。
        const det = detectDesktopMcp();
        if (det) { command = det.command; args = det.args; cwd = det.cwd; env = det.env || {}; }
      }
      if (command) {
        const browser = (config && config.browserAutomation) || {};
        env = { ...env,
          ACC_BROWSER_MODE: String(browser.mode || 'system'),
          ACC_BROWSER_EXECUTABLE: String(browser.executable || ''),
          ACC_BROWSER_CDP_URL: String(browser.cdpUrl || 'http://127.0.0.1:9222'),
        };
        addItem({ id: 'ai-computer-control', label: '桌面控制 (ai-computer-control)', source: 'desktop', builtIn: true, transport: 'stdio', command, args, cwd, env, enabled: dm.enabled !== false });
      }
    }
    // 2. config.externalMcpServers(用户连接器 -- 含 disabled)
    const ext = (config && Array.isArray(config.externalMcpServers)) ? config.externalMcpServers : [];
    for (const s of ext) {
      if (!s || !s.id) continue;
      const transport = (s.transport === 'sse' || s.transport === 'http') ? s.transport : 'stdio';
      if (transport !== 'stdio' && !s.url) continue;     // 远程条目缺 url 不入清单(与 resolveExternalMcpServers 一致)
      if (transport === 'stdio' && !s.command) continue;
      addItem({ id: s.id, label: s.label, source: 'config', builtIn: false, transport, command: s.command, url: s.url, args: s.args || [], cwd: s.cwd || '', env: s.env || {}, enabled: s.enabled !== false });
    }
    // 3. drop-in(repo/<dataRoot>/mcp/*/ 运行时扫描 -- 内置,不写回 config)
    if (!config || config.enableMcpDropIn !== false) {
      for (const d of scanMcpDropIns()) {
        if (out.some(o => o.id === d.id)) continue;       // config 显式条目优先(与 resolveExternalMcpServers 一致)
        const transport = (d.transport === 'sse' || d.transport === 'http') ? d.transport : 'stdio';
        if (transport !== 'stdio' && !d.url) continue;
        addItem({ id: d.id, label: d.label, source: 'drop-in', builtIn: true, transport, command: d.command, url: d.url, args: d.args || [], cwd: d.cwd || '', env: d.env || {}, enabled: true });
      }
    }
    // 4. ruyi-toolbox 登记的 MCP 组件(~/.ruyi-toolbox/components/,运行时合并、不写回 config;与 resolveExternalMcpServers 一致)
    for (const c of enabledToolboxComponents(config)) {
      if (c.kind !== 'mcp') continue;
      const id = 'toolbox-' + c.id;
      if (out.some(o => o.id === id)) continue;
      addItem({ id, label: c.name, source: 'toolbox', builtIn: true, transport: 'stdio', command: c.run.command, args: c.run.args, cwd: c.run.cwd, env: c.run.env, enabled: true });
    }
    if (doProbe) {
      for (const item of out) {
        if (!item.enabled) { item.health = { id: item.id, status: 'disabled', probedAt: new Date().toISOString() }; continue; }
        const realEntry = resolvedById.get(item.id);
        if (!realEntry) { item.health = { id: item.id, status: 'disabled', probedAt: new Date().toISOString() }; continue; }
        item.health = await probeMcpConnector(realEntry, { timeoutMs: probeTimeoutMs });
      }
    }
    return out;
  }

  return { mcpClients, mcpStartingClients, invalidateMcpRuntime, bridgedServerUnavailableMessage, getBridgedClient, killAllMcpClients, collectBridgedTools, sanitizeServerId, MCP_COMPAT_MATRIX, buildMcpConnectorInventory, classifyMcpError, probeMcpConnector };
}

module.exports = { createMcpClientRuntime };
