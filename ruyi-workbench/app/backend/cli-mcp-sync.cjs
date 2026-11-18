'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AGENT_CLI_TYPES, normalizeAgentCliType } = require('./agent-cli-types.cjs');
const { RUYI_MCP_SERVER_ID } = require('./product-identity.cjs');
const { runKeyedChain } = require('./keyed-chain.cjs');
const { safeJsonParse, readUserJsonObjectForMerge } = require('./ordinary-json.cjs');

function createCliMcpSync({
  paths, ensureDirs, generateMcpConfig, resolveExternalMcpServers, existsExecutableAsync,
  desktopMcpPolicyEnv, DesktopShell, getAgentCliHost, atomicWriteJson, logEvent,
}) {
  // v1.4.3: Sync external MCP servers to Claude CLI's user-level config so they are available
  // when running `claude` directly. Uses `claude mcp add-json` (idempotent).
  async function syncMcpServersToClaude(config) {
    try {
      if (!config.claudePath || !(await existsExecutableAsync(config.claudePath))) return;   // 128f-⑬:不钉事件循环
      const servers = resolveExternalMcpServers(config);
      // v2.7.1 (boot fix): claude mcp add-json 每次最多 10s,10 个串行可达 100s,await 会拖死 boot。
      // 加总预算(15s):超预算的余量丢弃 -- add-json 幂等,下次 boot 自动补齐。boot 调用点已改 fire-and-forget,
      // API/CLI 路径仍 await 也被预算兜底(最多 15s 而非 100s)。
      const SYNC_BUDGET_MS = 15000;
      // 122-§2.6:从 Claude Code 导进来的条目【不再同步回 Claude Code】。判据取自 config.externalMcpServers
      // 上的 origin(resolveExternalMcpServers 的输出不带这个字段,故按 id 回查),缺省视为 'ruyi'。
      // 桌面内置连接器与 drop-in 没有 origin,照旧同步 —— 它们不是从 Claude Code 来的,不构成「删了又回来」的闭环。
      const fromClaudeCode = new Set((Array.isArray(config.externalMcpServers) ? config.externalMcpServers : [])
        .filter(item => item && item.origin === 'claude-code').map(item => String(item.id)));
      // W2 迁移中心:从 Codex / Kimi 导进来的条目同样不外溢进 Claude Code 的用户级配置 —— 如意自己的 Claude
      // 引擎经 --mcp-config 拿全部 externalMcpServers,不靠 ~/.claude.json;把一个工具的连接器喷进另一个工具,
      // 用户在那边删掉后又会被写回来(与 claude-code 来源同一个闭环)。
      const fromOtherCli = new Set((Array.isArray(config.externalMcpServers) ? config.externalMcpServers : [])
        .filter(item => item && (item.origin === 'codex' || item.origin === 'kimi')).map(item => String(item.id)));
      const skippedIds = [];
      const t0 = Date.now();
      for (const s of servers) {
        if (!s.id || !s.command) continue;
        if (fromClaudeCode.has(String(s.id))) { skippedIds.push(String(s.id)); continue; }
        if (fromOtherCli.has(String(s.id))) { skippedIds.push(String(s.id)); continue; }
        // ruyi-toolbox 登记的 MCP 组件只在如意运行时存在(04:绝不写回 config),也不写进 Claude CLI 的用户级配置 ——
        // 写过去,下次启动就会被下面的自动导入当成「Claude Code 里的连接器」导回来、固化进 externalMcpServers,
        // 于是删掉登记文件／关掉总开关都撤不走它(toolbox-discovery.e2e F3 实测抓到的闭环)。
        if (s._toolbox) continue;
        const remain = SYNC_BUDGET_MS - (Date.now() - t0);
        if (remain <= 0) break;
        // 2026-10 能力总闸:如意的 Claude 引擎起 CLI 时不带 --strict-mcp-config,这里写进 ~/.claude.json 的用户级条目在 Claude
        // 线程里同样会被 CLI 加载(adaptive 模式也一样)—— 直挂 ACC 的条目同样带上被关掉的工具名(全局口径,见 desktopMcpPolicyEnv)。
        const sc = { type: 'stdio', command: s.command, args: s.args || [], env: { ...(s.env || {}), ...desktopMcpPolicyEnv(s.id, config) } };
        if (s.cwd) sc.cwd = s.cwd;
        try { await DesktopShell.runProcess(config.claudePath, ['mcp', 'add-json', s.id, JSON.stringify(sc), '-s', 'user'], { timeoutMs: Math.min(remain, 10000) }); } catch {}
      }
      // 跳过了谁要能查:否则「为什么这个连接器没同步过去」在真机上无从定位。
      if (skippedIds.length) logEvent({ kind: 'mcp_sync_skip_origin', origin: 'claude-code', ids: skippedIds.filter(id => fromClaudeCode.has(id)), otherCli: skippedIds.filter(id => fromOtherCli.has(id)) });
    } catch { /* non-fatal */ }
  }

  // 架构还债批 4:把如意的 MCP 清单推给「从自己的用户配置文件读 MCP」的 CLI —— 登记表(01f)各项的 syncMcpManifest
  // (现在只有 Kimi 真推;Claude 每回合走 --mcp-config 命令行参数,它的钩子是空操作)。修前 06k 与 13 各写一份 `=== 'kimi'`,现在三处都调这一个:
  //   · 13 startServerInner 启动预热:syncAgentCliMcpManifests(config) —— 只推选中的那家;
  //   · 06k applyConfigPatch 改了 externalMcpServers:(next, null, { requireWorkbenchMcp: true }) —— 工作台 MCP 开着才推;
  //   · 06k applyConfigPatch 改了 agentCliType / includeWorkbenchMcp:(next, current) —— 选中的那家推一次;从某一家切走时,
  //     对被切走的那家用 includeWorkbenchMcp:false 再推一次,把如意接管的条目清掉(还原成接管前的样子)。
  // 先推选中的、再清切走的;两步都 await(各家同步函数自己吞错,失败不阻断配置保存)。
  async function syncAgentCliMcpManifests(config, previousConfig = null, { requireWorkbenchMcp = false } = {}) {
    const selected = AGENT_CLI_TYPES[normalizeAgentCliType(config && config.agentCliType)];
    if (!requireWorkbenchMcp || config.includeWorkbenchMcp) await selected.syncMcpManifest(getAgentCliHost(), config);
    if (!previousConfig) return;
    const previous = AGENT_CLI_TYPES[normalizeAgentCliType(previousConfig.agentCliType)];
    if (previous.id !== selected.id) await previous.syncMcpManifest(getAgentCliHost(), { ...config, includeWorkbenchMcp: false });
  }

  // v2.8: Kimi Code reads user MCP declarations from $KIMI_CODE_HOME/mcp.json (default ~/.kimi-code/mcp.json) and currently has no
  // per-invocation --mcp-config flag. Merge Ruyi's declarations into that file without removing unrelated
  // user entries. Turn-specific loopback fields are inherited from the spawned Kimi process environment.
  // hunt2-engines#14:这是一段「读 mcp.json + 读所有权旁账 → 合并 → 写两份文件」的读改写。修前不串行:每个 Kimi 回合起手
  // (05b includeWorkbenchMcp)、启动预热、配置保存都会调它,两路并发时后写的一方基于旧快照把先写的一方盖掉 ——
  // managedIds / previous(接管前的原条目)一旦丢了,关掉工作台 MCP 时就还原不回用户原来的条目。按目标文件串行。
  const kimiMcpSyncChains = new Map();
  function syncMcpServersToKimi(config) {
    const kimiDir = String(process.env.KIMI_CODE_HOME || '').trim() || path.join(os.homedir(), '.kimi-code');
    return runKeyedChain(kimiMcpSyncChains, path.join(kimiDir, 'mcp.json'), () => syncMcpServersToKimiNow(config, kimiDir));
  }
  async function syncMcpServersToKimiNow(config, kimiDir) {
    try {
      await ensureDirs();
      const target = path.join(kimiDir, 'mcp.json');
      const sidecar = path.join(paths.data, 'kimi-mcp-sync.json');
      // 用户自己的 mcp.json:读不动 / 不是合法 JSON 对象就整次同步跳过(不写 mcp.json,也不写所有权旁账 —— 旁账记的是
      // 「写进去了什么」,没写就不能记)。修前当成空对象继续合并再写回,会把用户的其它条目整份覆盖掉。见 readUserJsonObjectForMerge。
      const read = await readUserJsonObjectForMerge(target);
      if (!read.ok) {
        logEvent({ kind: 'kimi_mcp_sync_skipped', file: target, reason: read.reason });
        return;
      }
      const current = read.value;
      if (!current.mcpServers || typeof current.mcpServers !== 'object' || Array.isArray(current.mcpServers)) current.mcpServers = {};
      let ownership = { managedIds: [], previous: {} };
      try { ownership = { ...ownership, ...(safeJsonParse(await fsp.readFile(sidecar, 'utf8'), {}) || {}) }; } catch { /* first sync */ }
      if (!Array.isArray(ownership.managedIds)) ownership.managedIds = [];
      if (!ownership.previous || typeof ownership.previous !== 'object') ownership.previous = {};
      let generatedServers = {};
      if (config.includeWorkbenchMcp !== false) {
        const generatedPath = await generateMcpConfig(config.mcpCommandMode);
        const generated = safeJsonParse(await fsp.readFile(generatedPath, 'utf8'), {}) || {};
        generatedServers = generated.mcpServers || {};
      }
      // W2 迁移中心:Kimi 现在也是自动导入的来源。从 Kimi 导进来的条目本来就在它自己的 mcp.json 里 ——
      // 不写回、不接管所有权(否则用户在 Kimi 里删掉它,下次同步又写回去,与 claude-code 来源同一个闭环)。
      for (const item of (Array.isArray(config.externalMcpServers) ? config.externalMcpServers : [])) {
        if (item && item.origin === 'kimi') delete generatedServers[String(item.id)];
      }
      const resolvedServers = new Map(resolveExternalMcpServers(config).map(server => [String(server.id), server]));
      const nextIds = new Set(Object.keys(generatedServers));
      // Restore entries that existed before Ruyi took ownership when a server is disabled or removed.
      for (const id of ownership.managedIds) {
        if (nextIds.has(id)) continue;
        if (ownership.previous[id] == null) delete current.mcpServers[id];
        else current.mcpServers[id] = ownership.previous[id];
        delete ownership.previous[id];
      }
      for (const [id, server] of Object.entries(generatedServers)) {
        if (!ownership.managedIds.includes(id)) {
          ownership.previous[id] = Object.prototype.hasOwnProperty.call(current.mcpServers, id) ? current.mcpServers[id] : null;
        }
        // Kimi infers transport from `command`/`url`; Claude's legacy `type: stdio` field is unnecessary.
        const kimiServer = { ...server };
        delete kimiServer.type;
        const resolved = resolvedServers.get(id);
        if (resolved) {
          for (const key of ['startupTimeoutMs', 'toolTimeoutMs', 'enabledTools', 'disabledTools']) {
            if (resolved[key] !== undefined) kimiServer[key] = resolved[key];
          }
          if (resolved.bearerTokenEnvVar) kimiServer.bearerTokenEnvVar = resolved.bearerTokenEnvVar;
        }
        // Kimi's MCP transport defaults to 60 s per tool call. Ruyi's own long-running bridge and ACC
        // both intentionally support longer operations, so advertise a matching transport budget.
        if (id === RUYI_MCP_SERVER_ID) {
          kimiServer.startupTimeoutMs = Math.max(Number(kimiServer.startupTimeoutMs) || 0, 60000);
          kimiServer.toolTimeoutMs = Math.max(Number(kimiServer.toolTimeoutMs) || 0, 900000);
        } else if (id === 'ai-computer-control') {
          kimiServer.startupTimeoutMs = Math.max(Number(kimiServer.startupTimeoutMs) || 0, 60000);
          kimiServer.toolTimeoutMs = Math.max(Number(kimiServer.toolTimeoutMs) || 0, 650000);
        }
        current.mcpServers[id] = kimiServer;
      }
      ownership.managedIds = [...nextIds];
      await fsp.mkdir(kimiDir, { recursive: true });
      await atomicWriteJson(target, JSON.stringify(current, null, 2));
      await atomicWriteJson(sidecar, JSON.stringify(ownership, null, 2));
    } catch { /* non-fatal: Kimi still retains its built-in tools */ }
  }

  return { syncMcpServersToClaude, syncAgentCliMcpManifests, syncMcpServersToKimi };
}

module.exports = { createCliMcpSync };
