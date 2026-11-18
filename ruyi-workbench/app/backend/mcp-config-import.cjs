'use strict';

const fs = require('node:fs');

// 48c: MCP 配置导入器 v1 -- 从 Claude Code .mcp.json / ~/.claude.json / Codex config.toml 导入(03 §4.1)。
// 零依赖:JSON 直解;TOML 用行级状态机迷你 parser(只解 [mcp_servers.X] 段的 command/args/env/cwd,够 Codex 用)。
// ${VAR}/%VAR% 双向插值(从 process.env,未定义保留原样)。远程连接器的请求头保留环境变量引用。
function _expandMcpVar(s) {
  return String(s == null ? '' : s)
    .replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, n) => (process.env[n] != null ? String(process.env[n]) : '${' + n + '}'))
    .replace(/%([A-Z_][A-Z0-9_]*)%/gi, (_, n) => (process.env[n] != null ? String(process.env[n]) : '%' + n + '%'));
}
// hunt2-mcp:Codex config.toml 的迷你 parser 重写。修前逐行正则,真实配置里常见的写法全部静默丢字段:
// 多行数组(args = [ 换行 "-y", 换行 ... ])、[mcp_servers.X.env] 子表、行尾 # 注释、单引号字面串的 env 值、
// 远程条目(url / bearer_token_env_var / http_headers / env_http_headers)。仍是零依赖小状态机,只解我们认的键;
// 既没有 command 也没有 url 的段【不再静默丢】,标 unsupported 交给导入界面如实显示。
// 引号状态机:回调拿到每个【引号外】的字符(引号内的跳过),三个小工具共用。
function _tomlScan(text, onOutside) {
  let q = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (q === '"' && c === '\\') { i++; continue; }
      if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (onOutside(c, i) === false) return;
  }
}
function _tomlStripComment(line) {
  let cut = -1;
  _tomlScan(line, (c, i) => { if (c === '#') { cut = i; return false; } return true; });
  return cut >= 0 ? line.slice(0, cut) : line;
}
function _tomlDepth(text) {
  let depth = 0;
  _tomlScan(text, c => { if (c === '[' || c === '{') depth++; else if (c === ']' || c === '}') depth--; });
  return depth;
}
// 按顶层分隔符切(引号与括号内的不算)。
function _tomlSplitTop(text, sep) {
  const cuts = [];
  let depth = 0;
  _tomlScan(text, (c, i) => {
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === sep && depth === 0) cuts.push(i);
  });
  const out = [];
  let from = 0;
  for (const i of cuts) { out.push(text.slice(from, i)); from = i + 1; }
  out.push(text.slice(from));
  return out;
}
function _tomlKeyPath(k) {
  return _tomlSplitTop(String(k).trim(), '.').map(part => {
    const t = part.trim();
    if (/^".*"$/.test(t)) { try { return JSON.parse(t); } catch { return t.slice(1, -1); } }
    if (/^'.*'$/.test(t)) return t.slice(1, -1);
    return t;
  });
}
function _tomlValue(raw) {
  const v = String(raw).trim();
  if (v.startsWith('"""') || v.startsWith("'''")) return undefined;   // 多行字符串:不解,当没写(该段缺 command 时会被标 unsupported)
  if (/^"[\s\S]*"$/.test(v)) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (/^'[\s\S]*'$/.test(v)) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(v)) return Number(v.replace(/_/g, ''));
  if (v.startsWith('[') && v.endsWith(']')) {
    return _tomlSplitTop(v.slice(1, -1), ',').map(x => x.trim()).filter(Boolean).map(_tomlValue);
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const obj = {};
    for (const pair of _tomlSplitTop(v.slice(1, -1), ',')) {
      const kv = _tomlSplitTop(pair, '=');
      if (kv.length < 2) continue;
      const key = _tomlKeyPath(kv[0]).join('.');
      if (key) obj[key] = _tomlValue(kv.slice(1).join('='));
    }
    return obj;
  }
  return undefined;   // 认不出的值(多行字符串、日期等):当没写
}
function _parseTomlMcpServers(text) {
  const byId = new Map();
  const serverFor = id => {
    if (!byId.has(id)) byId.set(id, { id, label: id, type: 'stdio', command: '', args: [], env: {}, cwd: '' });
    return byId.get(id);
  };
  const strList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : null);
  const setKey = (cur, sub, key, val) => {
    if (val === undefined) return;
    if (sub === 'env') { if (typeof val === 'string' || typeof val === 'number') cur.env[key] = String(val); return; }
    if (sub === 'http_headers') { if (typeof val === 'string') (cur.headers = cur.headers || {})[key] = val; return; }
    // env_http_headers:头名 -> 环境变量名。存成 ${VAR} 引用,连接时才展开(密钥不落盘明文,与 headers 同纪律)。
    if (sub === 'env_http_headers') { if (typeof val === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(val)) (cur.headers = cur.headers || {})[key] = '${' + val + '}'; return; }
    if (sub) return;   // 其它子表(如 tools.*)不认
    if (key === 'command' && typeof val === 'string') cur.command = val;
    else if (key === 'cwd' && typeof val === 'string') cur.cwd = val;
    else if (key === 'url' && typeof val === 'string') cur.url = val;
    else if (key === 'enabled') cur.enabled = val !== false;
    else if (key === 'bearer_token_env_var' && typeof val === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(val.trim())) cur.bearerTokenEnvVar = val.trim();
    else if ((key === 'startup_timeout_sec' || key === 'tool_timeout_sec') && Number.isFinite(val) && val > 0) {
      cur[key === 'startup_timeout_sec' ? 'startupTimeoutMs' : 'toolTimeoutMs'] = Math.min(2147483647, Math.round(val * 1000));
    } else if (key === 'startup_timeout_ms' && Number.isFinite(val) && val > 0) cur.startupTimeoutMs = Math.min(2147483647, Math.round(val));
    else if (key === 'args') { const l = strList(val); if (l) cur.args = l; }
    else if (key === 'enabled_tools') { const l = strList(val); if (l) cur.enabledTools = l; }
    else if (key === 'disabled_tools') { const l = strList(val); if (l) cur.disabledTools = l; }
    else if ((key === 'env' || key === 'http_headers' || key === 'env_http_headers') && val && typeof val === 'object' && !Array.isArray(val)) {
      for (const [k2, v2] of Object.entries(val)) setKey(cur, key, k2, v2);
    }
  };
  let cur = null, sub = '';
  let pending = '';
  for (const physical of String(text).split(/\r?\n/)) {
    let line = _tomlStripComment(physical);
    if (pending) {
      pending += '\n' + line;
      if (_tomlDepth(pending) > 0) continue;
      line = pending; pending = '';
    } else if (!line.trim()) continue;
    const trimmed = line.trim();
    if (/^\[\[/.test(trimmed)) { cur = null; sub = ''; continue; }   // 表数组:不是我们的段
    const sec = /^\[\s*([^=]+?)\s*\]$/.exec(trimmed);
    if (sec) {
      const keyPath = _tomlKeyPath(sec[1]);
      if (keyPath[0] === 'mcp_servers' && keyPath.length >= 2 && keyPath[1]) {
        cur = serverFor(keyPath[1]);
        sub = keyPath.length === 2 ? '' : (keyPath.length === 3 ? keyPath[2] : '#deeper');   // 更深的子表不认
      } else { cur = null; sub = ''; }
      continue;
    }
    const eq = _tomlSplitTop(line, '=');
    if (eq.length < 2) continue;
    const valueText = eq.slice(1).join('=');
    if (_tomlDepth(valueText) > 0) { pending = line; continue; }   // 多行数组 / 内联表:拼到括号配平
    if (!cur) continue;
    const keyPath = _tomlKeyPath(eq[0]);
    const val = _tomlValue(valueText);
    if (keyPath.length === 1) setKey(cur, sub, keyPath[0], val);
    else if (keyPath.length === 2 && !sub) setKey(cur, keyPath[0], keyPath[1], val);   // env.FOO = "x" 点号键
  }
  const out = [];
  for (const srv of byId.values()) {
    if (srv.url) srv.type = 'http';
    if (!srv.command && !srv.url) srv.unsupported = 'config.toml 段缺 command/url(或写法无法解析)';
    out.push(srv);
  }
  return out;
}
const MCP_CONFIG_JSON_MAX_BYTES = 32 * 1024 * 1024;
const MCP_CONFIG_OTHER_MAX_BYTES = 1024 * 1024;
// 解析单个 MCP 配置文件。返回 { servers, error? }。从不抛(缺失/格式错 -> error,供 UI 明示)。
function parseMcpConfigFile(filePath) {
  // hunt2-mcp:~/.claude.json 里 projects 历史动辄几 MB,修前一律 256KB 封顶 → 重度用户的 Claude Code 连接器
  // 永远导不进来。JSON 放宽到 32MB(与该文件的真实规模同档),其它格式 1MB;先 stat 再读,不把超大文件整个读进内存。
  const lower = String(filePath || '').toLowerCase();
  const maxBytes = lower.endsWith('.json') ? MCP_CONFIG_JSON_MAX_BYTES : MCP_CONFIG_OTHER_MAX_BYTES;
  let text;
  try {
    const st = fs.statSync(filePath);
    if (st.isFile() && st.size > maxBytes) return { servers: [], error: `文件过大(>${Math.round(maxBytes / 1048576)}MB,跳过)` };
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) { return { servers: [], error: '读失败: ' + (e.code === 'ENOENT' ? '文件不存在' : e.message) }; }
  if (lower.endsWith('.json')) {
    let j; try { j = JSON.parse(text); } catch (e) { return { servers: [], error: 'JSON 解析失败: ' + e.message }; }
    const ms = (j && j.mcpServers && typeof j.mcpServers === 'object') ? j.mcpServers : null;
    if (!ms) return { servers: [], error: '未找到 mcpServers 字段' };
    const servers = [];
    for (const [id, raw] of Object.entries(ms)) {
      if (!raw || typeof raw !== 'object') continue;
      const importedType = String(raw.type || raw.transport || (raw.url ? 'http' : 'stdio')).toLowerCase();
      const type = importedType === 'streamable-http' ? 'http' : importedType;
      // 48c:解析即插值规范化(${VAR}/%VAR%),apply 拿到的已是终值。
      // 49c:sse/http 不再是 unsupported —— 映射为远程条目;但 headers 值【不展开】(密钥引用 ${VAR}
      //   原样保留进 config,连接时才从 process.env 展开,防明文落盘)。
      const srv = {
        id: String(id), label: String(id), type, command: _expandMcpVar(String(raw.command || '')),
        args: Array.isArray(raw.args) ? raw.args.map(a => _expandMcpVar(String(a))) : [], env: {}, cwd: _expandMcpVar(String(raw.cwd || '')),
        enabled: raw.enabled !== false,
      };
      for (const key of ['startupTimeoutMs', 'toolTimeoutMs']) {
        const value = Number(raw[key]);
        if (Number.isInteger(value) && value >= 1 && value <= 2147483647) srv[key] = value;
      }
      for (const key of ['enabledTools', 'disabledTools']) if (Array.isArray(raw[key])) srv[key] = raw[key].filter(value => typeof value === 'string');
      if (raw.env && typeof raw.env === 'object') for (const [k, v] of Object.entries(raw.env)) srv.env[k] = _expandMcpVar(String(v));
      if (type === 'sse' || type === 'http') {
        srv.url = String(raw.url || '');
        if (raw.headers && typeof raw.headers === 'object') {
          srv.headers = {};
          for (const [k, v] of Object.entries(raw.headers)) if (typeof v === 'string') srv.headers[k] = v;
        }
        if (typeof raw.bearerTokenEnvVar === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.bearerTokenEnvVar.trim())) srv.bearerTokenEnvVar = raw.bearerTokenEnvVar.trim();
        if (!srv.url) srv.unsupported = '远程条目缺 url';
      }
      servers.push(srv);
    }
    return { servers };
  }
  if (lower.endsWith('.toml') || /\[mcp_servers\./.test(text)) {
    return { servers: _parseTomlMcpServers(text).map(s => ({ ...s, command: _expandMcpVar(s.command), args: s.args.map(_expandMcpVar), env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, _expandMcpVar(v)])), cwd: _expandMcpVar(s.cwd) })) };
  }
  return { servers: [], error: '未知格式(需 .json 含 mcpServers,或 .toml 含 [mcp_servers.X])' };
}
// 扫描多个源文件,插值 + 标冲突。返回 { servers, errors }。servers 每条带 source + conflict(撞 config 已有 id)。
async function scanMcpSources(filePaths, config) {
  const servers = [], errors = [];
  const existingIds = new Set((Array.isArray(config && config.externalMcpServers) ? config.externalMcpServers : []).map(s => s && s.id).filter(Boolean));
  for (const fp of filePaths) {
    const r = parseMcpConfigFile(fp);
    for (const s of r.servers) {
      s.source = fp;
      s.conflict = existingIds.has(s.id);
      servers.push(s);
    }
    if (r.error) errors.push({ path: fp, error: r.error });
  }
  return { servers, errors };
}

module.exports = { _expandMcpVar, _tomlKeyPath, _parseTomlMcpServers, parseMcpConfigFile, scanMcpSources };
