'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { json, readJsonBody, send } = require('./http-protocol.cjs');
const { safeJsonParse } = require('./ordinary-json.cjs');
const { maskExternalMcpServerForDisplay, sanitizeExternalMcpServer } = require('./config-secrets.cjs');
const { scanMcpSources } = require('./mcp-config-import.cjs');

function createMcpRoutes({
  paths, logEvent, readConfig, mutateConfig, generateMcpConfig, resolveExternalMcpServers, handleMigrationApiRoutes,
  invalidateMcpRuntime, buildMcpConnectorInventory, MCP_COMPAT_MATRIX, probeMcpConnector, mutateMcpConnector,
}) {
  // ── MCP 域:/api/mcp/import-folder、/api/mcp/import-config/scan|apply ─────────────────────────
  async function handleMcpApiRoutes(req, res, pathname) {
    if (await handleMigrationApiRoutes(req, res, pathname)) return true;
    // v1.0.2-S5: 从文件夹导入外部 MCP。POST /api/mcp/import-folder {path}(用户经 /api/pick-folder 选好的绝对
    // 路径)。读该文件夹下 ruyi-mcp.json 清单(≤32KB), 经 sanitizeExternalMcpServer 清洗, 尊重 externalMcpServers
    // ≤10 上限, id 已存在则更新该条(否则追加), 持久化 config(writeConfig 原子写)并再生成 generateMcpConfig。
    // token 白名单已加; 审计 action 'mcp_import'; 响应附 server(env 值掩码防泄漏)。
    if (req.method === 'POST' && pathname === '/api/mcp/import-folder') {
      const body = await readJsonBody(req);
      const folder = body && typeof body.path === 'string' ? body.path.trim() : '';
      if (!folder || !path.isAbsolute(folder)) return send(res, json({ ok: false, error: '请提供文件夹的绝对路径' }, 400));
      const MANIFEST_TEMPLATE = { id: 'my-mcp', label: '我的 MCP 服务', command: './server', args: [], env: {}, cwd: '', enabled: true };
      // 读清单(≤32KB)。缺失/超限/解析失败 → 统一「缺少有效清单」+ template(前端可据此提示用户如何写)。
      const manifestPath = path.join(folder, 'ruyi-mcp.json');
      let raw = null;
      try {
        const st = await fsp.stat(manifestPath);
        if (!st.isFile() || st.size > 32 * 1024) throw new Error('manifest too large or not a file');
        raw = safeJsonParse(await fsp.readFile(manifestPath, 'utf8'), null);
      } catch { raw = null; }
      if (!raw || typeof raw !== 'object') {
        return send(res, json({ ok: false, error: '该文件夹缺少有效的 ruyi-mcp.json 清单', template: MANIFEST_TEMPLATE }));
      }
      // cwd 缺省 = 该文件夹本身(相对 command 如 ./server 由 cwd 保证; args 里的相对路径不改写)。
      const withCwd = { ...raw, cwd: (typeof raw.cwd === 'string' && raw.cwd.trim()) ? raw.cwd : folder };
      const cleaned = sanitizeExternalMcpServer(withCwd);
      if (!cleaned) return send(res, json({ ok: false, error: '清单无效:至少需要 id 与 command 两个字段', template: MANIFEST_TEMPLATE }));
      // 117n-M2:读-改-写整段进 mutateConfig 的临界区(此前裸 readConfig -> writeConfig,与并发的
      // 设置保存/启停互相吞字段)。上限判定也搬进锁内 —— 用锁外快照判 10 条上限本身就是竞态。
      const imp = await mutateConfig(async (config) => {
        const list = Array.isArray(config.externalMcpServers) ? config.externalMcpServers.slice() : [];
        const existingIdx = list.findIndex(s => s && s.id === cleaned.id);
        let updated = false;
        if (existingIdx >= 0) { list[existingIdx] = cleaned; updated = true; }
        else {
          if (list.length >= 10) return { abort: 'limit' };
          list.push(cleaned);
        }
        config.externalMcpServers = list;
        // 显式再导入覆盖撤销:把该 id 从 dismissedMcpIds 移除(与 import-config/apply 同语义)。
        config.dismissedMcpIds = (Array.isArray(config.dismissedMcpIds) ? config.dismissedMcpIds : []).filter(x => x !== cleaned.id);
        return { value: updated };
      });
      if (!imp.ok) return send(res, json({ ok: false, error: '外部 MCP 数量已达上限(最多 10 个),请先移除一个再导入' }));
      const next = imp.config; const updated = imp.value;
      // hunt2-mcp:同 id 覆盖导入 = 用户修好了这条连接器;旧进程 / 在途启动 / 失败冷却按 id 记账,不作废就还是旧的。
      invalidateMcpRuntime(cleaned.id);
      await generateMcpConfig(next.mcpCommandMode).catch(() => {}); // 再生成 .mcp.json(缺失时不阻断导入)
      logEvent({ kind: 'mcp_import', id: cleaned.id, updated, source: folder });
      // 响应附清洗后的条目, env 值掩码(参考 apiKey 掩码模式, 防泄漏 token 类环境变量)。
      // 107-S0b:改用与 GET /api/status 同一个 MCP 掩码 —— 修前只遮 env,远程清单的 headers 与 args 里的 `--token xyz` 原样回显。
      const serverEcho = maskExternalMcpServerForDisplay(cleaned);
      return send(res, json({ ok: true, ...(updated ? { updated: true } : { added: true }), server: serverEcho }));
    }
    // 48c: MCP 配置导入器 v1 -- 从 Claude Code / Codex 配置导入(03 §4.1)。两步:scan(发现+冲突检测) -> apply(勾选写回)。
    //   POST /api/mcp/import-config/scan { paths?: [...] }  -- paths 缺省自动发现 ~/.claude.json + ~/.codex/config.toml
    //   POST /api/mcp/import-config/apply { servers: [{id,label,command,args,env,cwd}] }  -- 只导 stdio(unsupported 跳过),id 撞名更新,≤10 上限
    if (req.method === 'POST' && pathname === '/api/mcp/import-config/scan') {
      const body = await readJsonBody(req);
      const config = await readConfig();
      let paths = Array.isArray(body && body.paths) ? body.paths.map(p => String(p || '').trim()).filter(Boolean) : null;
      if (!paths || !paths.length) {
        // 自动发现:用户级 ~/.claude.json(Claude Code 全局)+ ~/.codex/config.toml(Codex 全局)。项目级 .mcp.json 由用户显式传 path。
        paths = [path.join(os.homedir(), '.claude.json'), path.join(os.homedir(), '.codex', 'config.toml')];
      }
      const { servers, errors } = await scanMcpSources(paths, config);
      logEvent({ kind: 'mcp_import_scan', sources: paths.length, found: servers.length, errors: errors.length });
      return send(res, json({ ok: true, servers, errors, scanned: paths }));
    }
    if (req.method === 'POST' && pathname === '/api/mcp/import-config/apply') {
      const body = await readJsonBody(req);
      const incoming = Array.isArray(body && body.servers) ? body.servers : [];
      // 117n-M2:同 import-folder,合并 + 上限 + dismissed 记账整段进 mutateConfig 的临界区。
      const imp = await mutateConfig(async (config) => {
        const list = Array.isArray(config.externalMcpServers) ? config.externalMcpServers.slice() : [];
        const added = [], updated = [], skipped = [];
        for (const raw of incoming) {
          // 49c:sse/http 已落地(McpHttpClient)—— 远程条目与 stdio 同走 sanitize(缺 url 判无效);
          // 解析期 unsupported 标记(如远程缺 url)仍跳过。
          if (raw && raw.unsupported) { skipped.push({ id: String(raw && raw.id || ''), reason: String(raw.unsupported) }); continue; }
          const srv = sanitizeExternalMcpServer(raw); // 复用 import-folder 同款清洗(stdio:需 id+command;远程:需 id+http(s) url)
          if (!srv) { skipped.push({ id: String(raw && raw.id || ''), reason: '无效条目(缺 id/command/url)' }); continue; }
          const idx = list.findIndex(s => s && s.id === srv.id);
          if (idx >= 0) { list[idx] = srv; updated.push(srv.id); }
          else {
            if (list.length >= 10) { skipped.push({ id: srv.id, reason: '外部 MCP 数量已达上限(10)' }); continue; }
            list.push(srv); added.push(srv.id);
          }
        }
        if (!added.length && !updated.length) return { abort: { skipped } };
        config.externalMcpServers = list;
        // 显式再导入覆盖撤销:把本次导入的 id 从 dismissedMcpIds 移除(用户改变主意,要它回来了)。
        const reImported = new Set([...added, ...updated]);
        config.dismissedMcpIds = (Array.isArray(config.dismissedMcpIds) ? config.dismissedMcpIds : []).filter(x => !reImported.has(x));
        return { value: { added, updated, skipped } };
      });
      if (!imp.ok) return send(res, json({ ok: false, error: '没有可导入的条目', skipped: imp.value.skipped }));
      const next = imp.config; const { added, updated, skipped } = imp.value;
      for (const id of [...added, ...updated]) invalidateMcpRuntime(id);   // 同 import-folder:作废旧运行时状态
      await generateMcpConfig(next.mcpCommandMode).catch(() => {});
      logEvent({ kind: 'mcp_import', ids: [...added, ...updated], added: added.length, updated: updated.length, source: 'import-config' });
      return send(res, json({ ok: true, added, updated, skipped }));
    }
    // ── 第55波 EC-C 55a: MCP 运维闭环 -- 统一连接器读模型 + 健康探针 ──
    // GET /api/mcp/connectors?probe=1  -> 统一清单(desktop/config/drop-in 三源 + source/transport/
    //   commandOrUrl/enabled/builtIn/capabilities;probe=1 时对 enabled 条目跑一次 probeMcpConnector 附
    //   health)。env 值掩码;不返回可执行命令串供前端拼写(配置变更走 import/toggle 路由 + token + 审计)。
    //   兼容矩阵随附(连接前说明各 transport 能力与局限,退出条件#4)。
    if (req.method === 'GET' && pathname === '/api/mcp/connectors') {
      const config = await readConfig();
      let probe = false;
      try { probe = new URL(req.url, 'http://127.0.0.1').searchParams.get('probe') === '1'; } catch { /* ignore */ }
      const connectors = await buildMcpConnectorInventory(config, { probe });
      logEvent({ kind: 'mcp_connectors_list', count: connectors.length, probe });
      return send(res, json({ ok: true, connectors, compat: MCP_COMPAT_MATRIX }));
    }
    // POST /api/mcp/connectors/health { id, timeoutMs? } -> 单连接器显式重测(用户「为什么不可用」排查)。
    //   id 必须在 resolveExternalMcpServers 的启用清单内;disabled/未配置 -> 404 人话。返回 {ok, health}。
    if (req.method === 'POST' && pathname === '/api/mcp/connectors/health') {
      const body = await readJsonBody(req);
      const id = String((body && body.id) || '').trim();
      if (!id) return send(res, json({ ok: false, error: 'id is required' }, 400));
      const config = await readConfig();
      const entry = resolveExternalMcpServers(config).find(e => e.id === id);
      if (!entry) return send(res, json({ ok: false, error: '连接器不在当前启用清单内(可能已禁用或未配置): ' + id }, 404));
      const health = await probeMcpConnector(entry, { timeoutMs: Math.max(2000, Number(body.timeoutMs) || 10000) });
      logEvent({ kind: 'mcp_connector_probe', id, status: health.status, category: health.category || null });
      return send(res, json({ ok: true, health }));
    }
    // ── 第55波 EC-C 55b: 启停/删除持久化 -- 仅 config 源(externalMcpServers)可操作 ──
    //   desktop(内置 ai-computer-control)与 drop-in(运行时目录合并)拒绝并给原因 -- 内置连接器与
    //   用户连接器必须有清楚边界(EC-C 退出条件)。启停/删除只动该 id:writeConfig 原子落盘(重启后
    //   状态与配置一致) + invalidateMcpRuntime(id) 杀活客户端/清失败冷却(停用后不再重连,启用后
    //   可立即重测) + 审计;无关连接器的客户端与配置不受影响。
    //   mcpConnectorMutateError(id, config):可 mutate 返回 null;否则 {status, error} 人话原因。
    //   117n-M2:守卫与整套副作用已下沉到 04 的 mutateMcpConnector(工具面 mcp_configure 与这两条路由
    //   共用同一个内核;04 -> 13b 是前向边,所以是函数下沉到 04,不是路由上提)。下面只剩 HTTP 形状。
    // POST /api/mcp/connectors/toggle {id, enabled:boolean} -> 启停用户连接器。
    if (req.method === 'POST' && pathname === '/api/mcp/connectors/toggle') {
      const body = await readJsonBody(req);
      const id = String((body && body.id) || '').trim();
      if (!id) return send(res, json({ ok: false, error: 'id is required' }, 400));
      if (typeof (body && body.enabled) !== 'boolean') return send(res, json({ ok: false, error: 'enabled 必须是布尔值(true=启用 / false=停用)' }, 400));
      const enabled = body.enabled;
      // 117n-M2:源守卫 / 改 list / 落盘 / invalidateMcpRuntime / 重生成 .mcp.json / drop-in 遮蔽警告 /
      // 审计,全部下沉进 mutateMcpConnector(04),与工具面 mcp_configure 共用同一条路径。这里只剩 HTTP 形状。
      const r = await mutateMcpConnector({ op: 'set-enabled', id, enabled });
      if (!r.ok) return send(res, json({ ok: false, error: r.error }, r.status));
      return send(res, json({ ok: true, id, enabled, ...(r.warning ? { warning: r.warning } : {}) }));
    }
    // DELETE /api/mcp/connectors {id} -> 删除用户连接器(持久化;删后即卸载,重启不复活)。
    if (req.method === 'DELETE' && pathname === '/api/mcp/connectors') {
      const body = await readJsonBody(req);
      const id = String((body && body.id) || '').trim();
      if (!id) return send(res, json({ ok: false, error: 'id is required' }, 400));
      // 117n-M2:同 toggle,整段下沉进 mutateMcpConnector(04)—— 含 dismissedMcpIds 记账与 drop-in
      // 遮蔽告知(55b 对抗审查那条:删除遮蔽同 id drop-in 的 config 条目后 drop-in 版本会静默接管)。
      const r = await mutateMcpConnector({ op: 'remove', id });
      if (!r.ok) return send(res, json({ ok: false, error: r.error }, r.status));
      return send(res, json({ ok: true, id, removed: true, ...(r.warning ? { warning: r.warning } : {}) }));
    }
    return false;
  }

  return handleMcpApiRoutes;
}

module.exports = { createMcpRoutes };
