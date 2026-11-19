'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { sanitizeExternalMcpServer } = require('./config-secrets.cjs');
const { scanMcpSources } = require('./mcp-config-import.cjs');
const { isRuyiMcpServerId } = require('./product-identity.cjs');
const { safeJsonParse } = require('./ordinary-json.cjs');

function createCliMcpImport({ paths, agentCliHomes, findRuyiPackageRootFor, mutateConfig, logEvent }) {
  // 启动时自动映射本机 Claude Code 的 MCP(读 ~/.claude.json 的 mcpServers)进 Ruyi 的 externalMcpServers。
  // 与 syncMcpServersToClaude(把 Ruyi 的同步到 Claude)互为逆方向:这里是把 Claude 原生注册的拉回 Ruyi。
  // 安全约束:① 只加 missing(已存在 id 跳过,不覆盖用户在 Ruyi 里的显式配置);② dismissedMcpIds 里的 id 跳过
  // (用户已从 Ruyi 删除,不自动回来);③ unsupported 条目跳过;④ 尊重 ≤10 上限;⑤ 全程 try/catch,失败仅审计不阻断 boot。
  // 幂等:第二次启动时已导入的 id 都成 conflict -> 跳过,零写入。
  async function autoImportClaudeCodeMcp(config) {
    try {
      if (!config || config.autoImportClaudeCodeMcp === false) return { added: 0, config };
      // W2 迁移中心:来源从「只认 ~/.claude.json」扩到 Claude Code / Codex / Kimi Code 三家(agentMcpImportSources,
      // 顺序即优先级:同 id 先到先得)。逐条判定与迁移中心的「可导入/已导入/已忽略」同一个函数
      // (classifyAgentMcpCandidate):保留 id、toolbox- 前缀、dismissed、如意自己的入口、Kimi 里如意自己
      // 同步过去的条目,一律不导。
      const sources = agentMcpImportSources();
      const managedKimi = await kimiMcpManagedIds();
      // 117n-M2:扫描 + 合并 + 落盘整段进 mutateConfig 的临界区(此前是裸 readConfig 之外的
      // read-modify-write:boot 期这一写与并发的 /api/config 保存互相吞字段)。conflict/dismissed
      // 的判据一律用锁内刚读到的 current,不用调用方传进来的可能已陈旧的 config。
      const r = await mutateConfig(async (current) => {
        const list = Array.isArray(current.externalMcpServers) ? current.externalMcpServers.slice() : [];
        const view = { externalMcpServers: list, dismissedMcpIds: Array.isArray(current.dismissedMcpIds) ? current.dismissedMcpIds : [] };
        const added = [];
        const bySource = [];
        for (const src of sources) {
          const { servers, errors } = await scanMcpSources([src.file], view);
          // scanMcpSources 把"文件不存在/无 mcpServers 字段"也作为 error 返回 -- 这两者是预期情况
          // (用户没装该工具或没配 MCP),静默合理。但"文件过大(>256KB)/JSON 解析失败"是真问题,
          // 静默吞掉会让自动导入不工作且零诊断(重度用户的 ~/.claude.json projects 字段可超 256KB)。
          // 故:非预期 error 走审计,让用户/开发者能定位"为什么没自动导入"。
          if (Array.isArray(errors)) {
            for (const e of errors) {
              const msg = String((e && e.error) || '');
              if (!msg || msg.includes('文件不存在') || msg.includes('未找到 mcpServers') || msg.includes('未知格式')) continue; // 预期,跳过
              try { logEvent({ kind: 'mcp_auto_import_scan_error', origin: src.origin, path: String((e && e.path) || src.file), error: msg }); } catch { /* logging must never re-throw */ }
            }
          }
          const ids = [];
          for (const raw of servers) {
            if (classifyAgentMcpCandidate(raw, src.origin, view, managedKimi).status !== 'importable') continue;
            if (list.length >= 10) break; // 上限:list 已含 existing+added(归一化也 cap 10,这里先停避免白加后被丢)
            // 122-§2.6:打来源标记。这一条是「从 Claude Code(或 Codex / Kimi)导进来的」,反向同步据此跳过它 ——
            // 否则用户在那边删掉一个连接器,下次启动 Ruyi 又把它写回去(§13.17 真机 ~/.claude.json 被夹具污染三次,
            // 病根就是这条闭环)。import-folder / import-config 是用户主动导,不打标。
            const srv = sanitizeExternalMcpServer({ ...raw, origin: src.origin });
            if (!srv) continue;
            list.push(srv); added.push(srv.id); ids.push(srv.id);
          }
          if (ids.length) bySource.push({ origin: src.origin, source: src.file, ids });
        }
        if (!added.length) return { abort: null }; // 零新增 -> 不落盘(与修前 return 前不写盘等价)
        current.externalMcpServers = list;
        return { value: { added, bySource } };
      });
      if (!r.ok) return { added: 0, config: r.config };
      const next = r.config; const { added, bySource } = r.value;
      // 122-§2.5:这里原本 `await generateMcpConfig(next.mcpCommandMode)` —— 它内部 resolveExternalMcpServers
      // → detectDesktopMcp → pickPython 会在【listen 之前】付一整轮探针(冷缓存本机实测 ~2 s),而本函数是 boot
      // 唯一被 await 的调用点。已挪到 13-http-router 的 listen 之后那个 setImmediate 段里统一重生成;
      // 其余调用方(/api/status、/api/mcp、起 claude 前)本来就各自现调 generateMcpConfig,不依赖这一发。
      for (const row of bySource) logEvent({ kind: 'mcp_auto_import', origin: row.origin, source: row.source, added: row.ids.length, ids: row.ids });
      return { added: added.length, ids: added, bySource, config: next };
    } catch (e) {
      try { logEvent({ kind: 'mcp_auto_import_error', error: (e && e.message) || String(e) }); } catch { /* logging must never re-throw */ }
      return { added: 0, error: (e && e.message) || String(e), config };
    }
  }

  // W2 迁移中心:MCP 自动导入的三个来源(顺序即优先级)。路径一律经 agentCliHomes() 现算,测试隔离家即生效。
  function agentMcpImportSources() {
    const homes = agentCliHomes();
    return [
      { origin: 'claude-code', label: 'Claude Code', file: homes.claudeJson },
      { origin: 'codex', label: 'Codex', file: path.join(homes.codex, 'config.toml') },
      { origin: 'kimi', label: 'Kimi Code', file: path.join(homes.kimi, 'mcp.json') },
    ];
  }
  // Kimi 的 mcp.json 里有一部分是如意自己 syncMcpServersToKimi 写过去的(所有权记在 <data>/kimi-mcp-sync.json)。
  // 那些不是「Kimi 的连接器」,导回来就是如意连如意的回环 —— 一律排除。
  async function kimiMcpManagedIds() {
    try {
      const sc = safeJsonParse(await fsp.readFile(path.join(paths.data, 'kimi-mcp-sync.json'), 'utf8'), null);
      return new Set(sc && Array.isArray(sc.managedIds) ? sc.managedIds.map(String) : []);
    } catch { return new Set(); }
  }
  // 识别其他 CLI 中登记的如意 MCP 入口，包括历史配置留下的旧启动器路径。
  function looksLikeRuyiSelfMcp(raw) {
    const parts = [raw && raw.command, ...((raw && Array.isArray(raw.args)) ? raw.args : [])].map(x => String(x || '').trim());
    for (const p of parts) {
      if (/(^|[\\/])ruyi(-workbench)?\.exe$/i.test(p)) return true;
      if (/[\\/]app[\\/]server\.js$/i.test(p) && path.isAbsolute(p) && findRuyiPackageRootFor(p)) return true;
    }
    return false;
  }
  // 一条外部候选的判定(自动导入与迁移中心的逐项状态共用一个判据,两边不会说两套话)。
  //   status: 'importable' 可导入 | 'imported' 如意里已有同 id | 'dismissed' 用户删过 | 'skipped' 不该导(reason 说为什么)
  // view = { externalMcpServers, dismissedMcpIds };managedKimi = kimiMcpManagedIds() 的结果(只对 kimi 来源有意义)。
  function classifyAgentMcpCandidate(raw, origin, view, managedKimi) {
    const id = String((raw && raw.id) || '');
    if (!raw || !id) return { status: 'skipped', reason: 'invalid' };
    // Ruyi 保留 id:绝不能作为外部服务器导入(否则与内部桥/桌面内置连接器同 id 冲突)。
    //   ruyi(3.0 前叫 win-claude-workbench)= 工作台自有权限桥(generateMcpConfig 永远单独注入,不在 externalMcpServers);
    //   ai-computer-control   = 桌面控制内置连接器(detectDesktopMcp 单独探测,mcpConnectorMutateError 视为 builtin)。
    if (isRuyiMcpServerId(id) || id === 'ai-computer-control') return { status: 'skipped', reason: 'reserved' };
    if (id.startsWith('toolbox-')) return { status: 'skipped', reason: 'toolbox' }; // toolbox- 前缀归自动发现所有:老版本同步过去的残留不导回来
    if (origin === 'kimi' && managedKimi && managedKimi.has(id)) return { status: 'skipped', reason: 'ruyi-managed' };
    const list = view && Array.isArray(view.externalMcpServers) ? view.externalMcpServers : [];
    if (list.some(s => s && s.id === id)) return { status: 'imported', reason: '' }; // 已在 config -> 不覆盖
    if (raw.unsupported) return { status: 'skipped', reason: 'unsupported' }; // 远程缺 url 等无效条目
    if (looksLikeRuyiSelfMcp(raw)) return { status: 'skipped', reason: 'ruyi-self' };
    const dismissed = view && Array.isArray(view.dismissedMcpIds) ? view.dismissedMcpIds : [];
    if (dismissed.includes(id)) return { status: 'dismissed', reason: '' }; // 用户已删 -> 不自动回来
    return { status: 'importable', reason: '' };
  }


  // ============================================================================

  return { autoImportClaudeCodeMcp, agentMcpImportSources, kimiMcpManagedIds, classifyAgentMcpCandidate };
}

module.exports = { createCliMcpImport };
