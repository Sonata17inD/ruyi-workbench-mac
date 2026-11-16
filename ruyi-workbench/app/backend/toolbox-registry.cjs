'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createToolboxRegistry({ logEvent, safeJsonParse }) {
  // ── ruyi-toolbox 组件登记(用户 2026-09-21:「toolbox 下的都自动识别接入 —— 是 MCP 就自动配上,服务就自动拉起并配置好」)──
  // 两个仓库之间【唯一】的对接面是 ruyi-toolbox 仓的 docs/00-component-registry.md:组件装好后在
  // ~/.ruyi-toolbox/components/<id>.json 放一份登记,本函数只读那个目录,绝不读任何组件的代码目录。
  // 与上面 drop-in 的关系:drop-in 的清单住在【如意自己的】目录里(仓里/dataRoot),这一条住在用户主目录下的
  // toolbox 目录里,而且多一种 kind:'service'(常驻本机的小 HTTP 服务,由 04f 拉起并接成能力端点)。
  // 威胁模型(26 号文 §4「localCommand 只能来自配置文件,不接受 API 写入」的延续):命令【只来自磁盘上的登记文件】,
  // 如意没有任何 HTTP 途径写它;登记目录与 config.json 同一信任域(能写这里的人本来就能改 externalMcpServers 里的命令)。
  // 校验从严、坏文件一律当「没装」并审计一条,绝不抛、绝不打断启动:绝对路径且存在、不经 shell、不展开变量、不拼接参数。
  // 同步 I/O + 2s 缓存(与 drop-in 同理:resolveExternalMcpServers 在请求期频繁调)。上限 20 个组件、单文件 32 KB。
  const TOOLBOX_CACHE_MS = 2000;
  const TOOLBOX_COMPONENT_MAX = 20;
  const TOOLBOX_PROVIDES_TYPES = new Set(['asr', 'asr-stream']);   // 现在认识的能力;不认识的 type 跳过(向前兼容:组件可以先登记、如意后支持)。asr-stream:130(51 号文)
  let _toolboxCache = { at: 0, list: null };
  const _toolboxSkipLogged = new Set();
  function toolboxComponentsDir() {
    const override = String(process.env.RUYI_TOOLBOX_HOME || '').trim();
    return path.join(override || path.join(os.homedir(), '.ruyi-toolbox'), 'components');
  }
  function sanitizeToolboxComponent(raw, fileId) {
    if (!raw || typeof raw !== 'object' || raw.schema !== 1) return { error: 'schema' };
    const id = String(raw.id || '');
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id) || id !== fileId) return { error: 'id' };
    const kind = raw.kind === 'service' || raw.kind === 'mcp' ? raw.kind : '';
    if (!kind) return { error: 'kind' };
    const run = raw.run && typeof raw.run === 'object' ? raw.run : null;
    const command = run && typeof run.command === 'string' ? run.command.trim() : '';
    const cwd = run && typeof run.cwd === 'string' ? run.cwd.trim() : '';
    if (!command || command.length > 1000 || !path.isAbsolute(command)) return { error: 'run.command' };
    if (!cwd || cwd.length > 1000 || !path.isAbsolute(cwd)) return { error: 'run.cwd' };
    try { if (!fs.statSync(command).isFile()) return { error: 'run.command' }; } catch { return { error: 'run.command-missing' }; }
    try { if (!fs.statSync(cwd).isDirectory()) return { error: 'run.cwd' }; } catch { return { error: 'run.cwd-missing' }; }
    const rawArgs = Array.isArray(run.args) ? run.args : [];
    if (rawArgs.length > 32 || rawArgs.some(a => typeof a !== 'string' || a.length > 1000)) return { error: 'run.args' };
    const env = {};
    const rawEnv = run.env && typeof run.env === 'object' && !Array.isArray(run.env) ? run.env : {};
    if (Object.keys(rawEnv).length > 32) return { error: 'run.env' };
    for (const [k, v] of Object.entries(rawEnv)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,119}$/.test(k) || typeof v !== 'string' || v.length > 2048) return { error: 'run.env' };
      env[k] = v;
    }
    const out = {
      id, kind,
      name: (typeof raw.name === 'string' ? raw.name : '').trim().slice(0, 80) || id,
      version: (typeof raw.version === 'string' ? raw.version : '').trim().slice(0, 40),
      run: { command, args: rawArgs.slice(), cwd, env },
    };
    if (kind === 'mcp') {
      const transport = raw.mcp && typeof raw.mcp === 'object' ? String(raw.mcp.transport || 'stdio') : 'stdio';
      if (transport !== 'stdio') return { error: 'mcp.transport' };
      return { component: out };
    }
    const svc = raw.service && typeof raw.service === 'object' ? raw.service : null;
    const port = svc ? Number(svc.port) : NaN;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return { error: 'service.port' };
    const portEnv = svc && typeof svc.portEnv === 'string' ? svc.portEnv : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,119}$/.test(portEnv)) return { error: 'service.portEnv' };
    const health = svc && typeof svc.health === 'string' ? svc.health : '';
    if (!/^\/[A-Za-z0-9._~\/-]{0,199}$/.test(health)) return { error: 'service.health' };
    const componentTag = svc && typeof svc.component === 'string' ? svc.component.trim() : '';
    if (!componentTag || componentTag.length > 80) return { error: 'service.component' };
    const provides = [];
    for (const p of (Array.isArray(raw.provides) ? raw.provides.slice(0, 8) : [])) {
      if (!p || typeof p !== 'object' || !TOOLBOX_PROVIDES_TYPES.has(p.type)) continue;
      const basePath = typeof p.basePath === 'string' && /^\/[A-Za-z0-9._~\/-]{0,99}$/.test(p.basePath) ? p.basePath : '';
      const model = typeof p.model === 'string' ? p.model.trim().slice(0, 120) : '';
      if (!model) continue;
      // 133(约定 §2.2 可选字段):同一端点上可选的多份模型 [{id,label}];缺省那份必须在清单里,不在就补到最前。
      const models = [];
      const seen = new Set();
      for (const m of (Array.isArray(p.models) ? p.models.slice(0, 8) : [])) {
        const id = m && typeof m === 'object' && typeof m.id === 'string' ? m.id.trim().slice(0, 120) : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push({ id, label: (typeof m.label === 'string' ? m.label.trim().slice(0, 80) : '') || id });
      }
      if (models.length && !seen.has(model)) models.unshift({ id: model, label: model });
      provides.push({ type: p.type, basePath, model, protocol: p.protocol === 'chat-audio' ? 'chat-audio' : 'transcriptions', ...(models.length ? { models } : {}) });
    }
    // 133:可选的「立刻卸载」路径 —— 用户把语音识别切走时如意 POST 它,组件就地释放显存。形状同 health。
    const unload = svc && typeof svc.unload === 'string' && /^\/[A-Za-z0-9._~\/-]{0,199}$/.test(svc.unload) ? svc.unload : '';
    out.service = { port, portEnv, health, component: componentTag, ...(unload ? { unload } : {}) };
    out.provides = provides;
    return { component: out };
  }
  function scanToolboxComponents() {
    const now = Date.now();
    if (_toolboxCache.list && (now - _toolboxCache.at) < TOOLBOX_CACHE_MS) return _toolboxCache.list;
    const out = [];
    const dir = toolboxComponentsDir();
    let files = [];
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { files = []; }   // 目录不存在 = 没装 toolbox,常态
    for (const ent of files) {
      if (out.length >= TOOLBOX_COMPONENT_MAX) break;
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      const file = path.join(dir, ent.name);
      let raw = null;
      try {
        const st = fs.statSync(file);
        if (st.size > 32 * 1024) throw new Error('too large');
        raw = safeJsonParse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''), null);
      } catch { raw = null; }
      const verdict = sanitizeToolboxComponent(raw, ent.name.slice(0, -5));
      if (!verdict.component) {
        // 扫描是 2s 缓存、请求期频繁调:同一份坏文件只审计一次,不每两秒刷一行日志。
        const key = ent.name + ':' + (verdict.error || 'unreadable');
        if (!_toolboxSkipLogged.has(key)) { _toolboxSkipLogged.add(key); logEvent({ kind: 'toolbox_component_skip', file: ent.name, reason: verdict.error || 'unreadable' }); }
        continue;
      }
      out.push(verdict.component);
    }
    _toolboxCache = { at: now, list: out };
    return out;
  }
  function invalidateToolboxCache() { _toolboxCache = { at: 0, list: null }; }
  // 这台配置下哪些登记的组件是【启用】的:总开关关掉 = 一个都不接;逐个停用记在 toolbox.disabled。
  function enabledToolboxComponents(config) {
    const tb = (config && config.toolbox) || {};
    if (tb.autoDiscover === false) return [];
    const disabled = new Set(Array.isArray(tb.disabled) ? tb.disabled : []);
    return scanToolboxComponents().filter(c => !disabled.has(c.id));
  }
  return { directory: toolboxComponentsDir, scan: scanToolboxComponents, enabled: enabledToolboxComponents, invalidate: invalidateToolboxCache };
}

module.exports = { createToolboxRegistry };
