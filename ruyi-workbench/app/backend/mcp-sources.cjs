'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeJsonParse } = require('./ordinary-json.cjs');
const { sanitizeExternalMcpServer } = require('./config-secrets.cjs');
const { DESKTOP_MCP_SERVER_ID } = require('./tool-access-policy.cjs');

function createMcpSources({ externalRoot, dataRoot, enabledToolboxComponents, detectDesktopMcp, legacyAccMemoryMigrationComplete, logEvent }) {
  // ============================================================================
  // v1.1-W2 (T2) — MCP drop-in 自动扫描。
  // ============================================================================
  // 扫描两个位置的 `*/ruyi-mcp.json` 清单并「运行时合并」进 externalMcpServers 视图(见 resolveExternalMcpServers):
  //   ① <repo>/mcp/*/ruyi-mcp.json      —— 随发行包分发的即插即用连接器(externalRoot()/mcp)。
  //   ② <dataRoot>/mcp/*/ruyi-mcp.json  —— 用户自装(dataRoot()/mcp)。
  // 与 /api/mcp/import-folder(v1.0.2-S5)的关系【互补,非重复】:
  //   • import-folder 走「持久化」路径 —— 把清单写进 config.externalMcpServers(删条目=卸载,重启保留)。
  //   • drop-in 走「运行时合并」路径 —— 绝不写回 config;存在性由文件夹本身表达,删文件夹即卸载。
  //   两者互不覆盖:id 冲突时 config 里的显式条目(含 import-folder 写入的)优先,drop-in 跳过并审计一条 warn。
  // cwd 缺省 = 清单所在文件夹(与 import-folder 同语义)。drop-in 数量上限 10。
  // 同步 I/O(readdirSync/readFileSync):调用点是请求期且频繁,故加 2s 缓存;扫描量小(≤两目录各 ≤10 子文件夹)。
  const MCP_DROPIN_MAX = 10;
  let _dropInCache = { at: 0, list: null };
  const MCP_DROPIN_CACHE_MS = 2000;
  function mcpDropInDirs() {
    return [
      { root: path.join(externalRoot(), 'mcp'), source: 'repo' },
      { root: path.join(dataRoot(), 'mcp'), source: 'dataRoot' },
    ];
  }
  // 扫描并返回清洗后的 drop-in 条目数组 [{id,label,command,args,cwd,env,enabled,_dropInSource}]。纯读盘,不改 config。
  // 坏清单(缺失/超限/解析失败/清洗后无效)静默跳过(审计一条 warn),绝不抛。总数封顶 MCP_DROPIN_MAX。
  function scanMcpDropIns() {
    const now = Date.now();
    if (_dropInCache.list && (now - _dropInCache.at) < MCP_DROPIN_CACHE_MS) return _dropInCache.list;
    const out = [];
    const seen = new Set();
    for (const { root, source } of mcpDropInDirs()) {
      let subdirs;
      try { subdirs = fs.readdirSync(root, { withFileTypes: true }); }
      catch { continue; } // mcp/ 目录不存在 → 正常,跳过
      for (const ent of subdirs) {
        if (out.length >= MCP_DROPIN_MAX) break;
        const folder = path.join(root, ent.name);
        // 链进来的连接器目录(符号链接 / junction)也认:Dirent 对链接不报目录,stat 跟随一次(hunt2-mcp,同 readSkillDir)。
        if (!ent.isDirectory()) {
          if (!ent.isSymbolicLink()) continue;
          try { if (!fs.statSync(folder).isDirectory()) continue; } catch { continue; }
        }
        const manifestPath = path.join(folder, 'ruyi-mcp.json');
        let raw = null;
        try {
          const st = fs.statSync(manifestPath);
          if (!st.isFile() || st.size > 32 * 1024) throw new Error('too large / not a file');
          raw = safeJsonParse(fs.readFileSync(manifestPath, 'utf8'), null);
        } catch { continue; } // 无清单 → 该文件夹不是 drop-in,跳过(不审计,常态)
        if (!raw || typeof raw !== 'object') { logEvent({ kind: 'mcp_dropin_skip', reason: 'bad-manifest', folder, source }); continue; }
        // cwd 缺省 = 清单所在文件夹(与 import-folder 同)。
        const withCwd = { ...raw, cwd: (typeof raw.cwd === 'string' && raw.cwd.trim()) ? raw.cwd : folder };
        const cleaned = sanitizeExternalMcpServer(withCwd);
        if (!cleaned) { logEvent({ kind: 'mcp_dropin_skip', reason: 'invalid', folder, source }); continue; }
        if (cleaned.enabled === false) continue; // 清单显式禁用 → 跳过
        if (seen.has(cleaned.id)) { logEvent({ kind: 'mcp_dropin_skip', reason: 'dup-dropin-id', id: cleaned.id, folder, source }); continue; }
        seen.add(cleaned.id);
        out.push({ ...cleaned, _dropInSource: source, _dropInFolder: folder });
      }
      if (out.length >= MCP_DROPIN_MAX) break;
    }
    _dropInCache = { at: now, list: out };
    return out;
  }
  // 测试可用:强制下次扫描重读盘(e2e 造完清单后调用)。
  function invalidateMcpDropInCache() { _dropInCache = { at: 0, list: null }; }

  // Merge the desktop MCP (detected/explicit) + user externalMcpServers (enabled) into one list of
  // {id,label,command,args,cwd,env}. desktopMcp always uses id DESKTOP_MCP_SERVER_ID.
  // v1.1-W2 (T2): also merges drop-in connectors scanned from <repo>/mcp/*/ and <dataRoot>/mcp/*/ (runtime
  // merge, never written back to config). config/desktop entries win on id collision; drop-in is skipped+warned.
  function mcpRuntimeCommon(entry) {
    const out = {};
    for (const key of ['startupTimeoutMs', 'toolTimeoutMs']) {
      if (Number.isInteger(entry && entry[key]) && entry[key] >= 1 && entry[key] <= 2147483647) out[key] = entry[key];
    }
    for (const key of ['enabledTools', 'disabledTools']) {
      if (Array.isArray(entry && entry[key])) out[key] = entry[key].slice();
    }
    return out;
  }

  function isEquivalentDesktopAccServer(entry) {
    if (!entry || entry.transport || !entry.command) return false;
    const args = Array.isArray(entry.args) ? entry.args.map(value => String(value).trim().toLowerCase()) : [];
    if (args.includes('ai_computer_control.server')) return true;
    const executable = path.basename(String(entry.command)).toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
    return executable === DESKTOP_MCP_SERVER_ID || executable === 'ai_computer_control';
  }

  function resolveExternalMcpServers(config) {
    const out = [];
    const dm = config && config.desktopMcp;
    if (dm && dm.enabled) {
      let command = String(dm.command || '').trim();
      let args = Array.isArray(dm.args) ? dm.args.slice() : [];
      let cwd = String(dm.cwd || '').trim() || undefined;
      let env = {};
      let pythonSource = '';
      if (command) {
        // Explicit override — trust the user's command/args/cwd; default UTF-8 for a python launch.
        env = { PYTHONUTF8: '1' };
      } else if (dm.autodetect) {
        const det = detectDesktopMcp();
        if (det) { command = det.command; args = det.args; cwd = det.cwd; env = det.env || {}; pythonSource = det.pythonSource || ''; }
      }
      if (command) {
        const browser = (config && config.browserAutomation) || {};
        env = { ...env,
          ACC_BROWSER_MODE: String(browser.mode || 'system'),
          ACC_BROWSER_EXECUTABLE: String(browser.executable || ''),
          ACC_BROWSER_CDP_URL: String(browser.cdpUrl || 'http://127.0.0.1:9222'),
        };
        // 工作台记忆迁移成功（或确认标准位置没有旧库）后，ACC 不再注册同名 memory 工具；若旧库
        // 损坏/迁移失败则标记不存在，工具继续可见，避免数据尚未接管就把唯一入口藏掉。
        if (legacyAccMemoryMigrationComplete()) env.ACC_HIDE_MEMORY = '1';
        out.push({ id: DESKTOP_MCP_SERVER_ID, label: '桌面控制 (ai-computer-control)', command, args, cwd, env,
        pythonSource });
      }
    }
    const ext = (config && Array.isArray(config.externalMcpServers)) ? config.externalMcpServers : [];
    for (const s of ext) {
      if (!s || s.enabled === false) continue;
      if (out.some(o => o.id === s.id)) continue;   // desktop entry wins on id collision
      if (out.some(o => o.id === DESKTOP_MCP_SERVER_ID) && isEquivalentDesktopAccServer(s)) {
        logEvent({ kind: 'mcp_external_skip', reason: 'duplicate-desktop-acc', id: s.id });
        continue;
      }
      // 49c:远程条目(sse/http)按 transport+url 直通(headers 引用不展开,连接时才展开)。
      if (s.transport === 'sse' || s.transport === 'http') {
        if (!s.url) continue;
        out.push({
          id: s.id, label: s.label || s.id, transport: s.transport, url: s.url, headers: s.headers || {},
          ...(s.bearerTokenEnvVar ? { bearerTokenEnvVar: s.bearerTokenEnvVar } : {}), ...mcpRuntimeCommon(s),
        });
        continue;
      }
      if (!s.command) continue;
      out.push({
        id: s.id, label: s.label || s.id, command: s.command, args: s.args || [], cwd: s.cwd || undefined,
        env: s.env || {}, ...mcpRuntimeCommon(s),
      });
    }
    // v1.1-W2 (T2): merge drop-in connectors LAST → any id already claimed by a desktop/config entry wins;
    // the drop-in is skipped and a warn is audited (config 显式条目优先，与 import-folder 持久化路径互补)。
    // enableMcpDropIn 缺省开;显式 false 可关(normalizeConfig 清洗后的布尔)。
    if (!config || config.enableMcpDropIn !== false) {
      for (const d of scanMcpDropIns()) {
        if (out.some(o => o.id === d.id)) { logEvent({ kind: 'mcp_dropin_skip', reason: 'id-conflict-config-wins', id: d.id, folder: d._dropInFolder, source: d._dropInSource }); continue; }
        if (d.transport === 'sse' || d.transport === 'http') {
          if (!d.url) continue;
          out.push({
            id: d.id, label: d.label || d.id, transport: d.transport, url: d.url, headers: d.headers || {},
            ...(d.bearerTokenEnvVar ? { bearerTokenEnvVar: d.bearerTokenEnvVar } : {}), ...mcpRuntimeCommon(d),
          });
          continue;
        }
        if (out.some(o => o.id === DESKTOP_MCP_SERVER_ID) && isEquivalentDesktopAccServer(d)) {
          logEvent({ kind: 'mcp_dropin_skip', reason: 'duplicate-desktop-acc', id: d.id, folder: d._dropInFolder, source: d._dropInSource });
          continue;
        }
        out.push({
          id: d.id, label: d.label || d.id, command: d.command, args: d.args || [], cwd: d.cwd || undefined,
          env: d.env || {}, ...mcpRuntimeCommon(d),
        });
      }
    }
    // ruyi-toolbox 登记的 MCP 组件排在最后:内部 id 一律 `toolbox-<id>`(前缀保留给自动发现),显式配置／drop-in 撞 id 时让路。
    // 生命周期、工具清单、权限分级全走现有 MCP 机制 —— 这里只是又一个条目来源,与 drop-in 一样【绝不写回 config】。
    for (const c of enabledToolboxComponents(config)) {
      if (c.kind !== 'mcp') continue;
      const id = 'toolbox-' + c.id;
      if (out.some(o => o.id === id)) { logEvent({ kind: 'toolbox_component_skip', file: c.id + '.json', reason: 'mcp-id-conflict' }); continue; }
      const cleaned = sanitizeExternalMcpServer({ id, label: c.name, command: c.run.command, args: c.run.args, cwd: c.run.cwd, env: c.run.env });
      if (!cleaned) continue;
      out.push({ id: cleaned.id, label: cleaned.label, command: cleaned.command, args: cleaned.args, cwd: cleaned.cwd || undefined, env: cleaned.env, _toolbox: c.id });
    }
    return out;
  }

  return { mcpDropInDirs, scanMcpDropIns, invalidateMcpDropInCache, isEquivalentDesktopAccServer, resolveExternalMcpServers };
}

module.exports = { createMcpSources };
