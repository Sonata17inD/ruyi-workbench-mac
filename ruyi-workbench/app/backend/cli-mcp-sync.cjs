'use strict';
const { desktopMcpPolicyEnv } = require('./mcp-child-env.cjs');

function createCliMcpSync({ resolveExternalMcpServers, existsExecutableAsync, DesktopShell, logEvent }) {
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
      const fromOtherCli = new Set((Array.isArray(config.externalMcpServers) ? config.externalMcpServers : [])
        .filter(item => item && item.origin && !['ruyi', 'claude-code'].includes(item.origin)).map(item => String(item.id)));
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

  return { syncMcpServersToClaude };
}

module.exports = { createCliMcpSync };
