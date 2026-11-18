'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { safeJsonParse } = require('./ordinary-json.cjs');
const {
  BUILTIN_AGENT_ROLES, annotateAgentRoleEffective, clampAgentRoleToParent,
  claudePermissionMode, mergeAgentRole, normalizeAgentRole,
} = require('./agent-role-policy.cjs');

function createAgentRoleLibrary({ atomicWriteJson }) {
  function projectAgentRoleFile(cwd) { return path.join(path.resolve(cwd), '.ruyi', 'agents.json'); }
  async function readProjectAgentRoles(cwd) {
    const file = projectAgentRoleFile(cwd);
    try {
      const st = await fsp.stat(file); if (!st.isFile() || st.size > 512 * 1024) return [];
      const parsed = safeJsonParse(await fsp.readFile(file, 'utf8'), null);
      const rawRoles = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.roles) ? parsed.roles : []);
      return rawRoles.map(r => normalizeAgentRole(r, { source: 'project' })).filter(Boolean).slice(0, 32);
    } catch { return []; }
  }
  function parseSimpleYamlValue(value) {
    const s = String(value || '').trim();
    if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).split(',').map(v => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
    if (/^\d+$/.test(s)) return Number(s);
    return s.replace(/^['"]|['"]$/g, '');
  }
  async function readClaudeProjectAgentRoles(cwd) {
    const dir = path.join(path.resolve(cwd), '.claude', 'agents');
    let files = []; try { files = await fsp.readdir(dir); } catch { return []; }
    const out = [];
    for (const file of files.filter(f => /\.md$/i.test(f)).slice(0, 32)) {
      try {
        const raw = await fsp.readFile(path.join(dir, file), 'utf8'); if (raw.length > 128 * 1024) continue;
        const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/m.exec(raw); if (!m) continue;
        const fm = {};
        for (const line of m[1].split(/\r?\n/)) { const hit = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line); if (hit) fm[hit[1]] = parseSimpleYamlValue(hit[2]); }
        const role = normalizeAgentRole({
          id: fm.name || path.basename(file, '.md'), label: fm.name || path.basename(file, '.md'), description: fm.description || '', prompt: m[2].trim(),
          claudeModel: fm.model || 'inherit', claudeTools: Array.isArray(fm.tools) ? fm.tools : (typeof fm.tools === 'string' ? fm.tools.split(',').map(s => s.trim()) : []),
          permissionMode: fm.permissionMode === 'bypassPermissions' ? 'bypass' : fm.permissionMode, maxTurns: fm.maxTurns, mcpServers: Array.isArray(fm.mcpServers) ? fm.mcpServers : [], isolation: fm.isolation,
        }, { source: 'claude-project' });
        if (role) { role.nativeClaude = true; role.file = path.join(dir, file); out.push(role); }
      } catch { /* malformed native agent stays Claude's concern */ }
    }
    return out;
  }
  // 安全走查 S3:opts.parentMode = 调用方认的父回合档位(缺省取 config.permissionMode —— 回合内的 config 已解析成这条线程的档)。
  // 项目来源的角色(.ruyi/agents.json / .claude/agents)在返回时带上【有效档位】标注(effectivePermissionMode / effectiveToolTier / roleClamped),
  // 角色自己声明的 permissionMode / toolTier 原样保留(设置页编辑器原样存回);真正的夹紧在子代理起跑处(08 / 07)按那一刻的父档再算一次。
  async function getAgentRoleLibrary(cwd, config, opts) {
    const merged = new Map();
    for (const raw of BUILTIN_AGENT_ROLES) { const role = normalizeAgentRole(raw, { source: 'builtin', builtin: true }); merged.set(role.id, role); }
    for (const role of (Array.isArray(config.agentRoleOverrides) ? config.agentRoleOverrides : [])) {
      const current = merged.get(role.id); merged.set(role.id, current ? mergeAgentRole(current, role, 'global') : normalizeAgentRole(role, { source: 'global' }));
    }
    for (const role of await readProjectAgentRoles(cwd)) {
      const current = merged.get(role.id); merged.set(role.id, current ? mergeAgentRole(current, role, 'project') : role);
    }
    const claudeNative = await readClaudeProjectAgentRoles(cwd);
    for (const role of claudeNative) if (!merged.has(role.id)) merged.set(role.id, role);
    const parentMode = (opts && opts.parentMode) || (config && config.permissionMode) || 'default';
    return [...merged.values()].filter(Boolean).map(role => annotateAgentRoleEffective(role, parentMode));
  }
  async function saveProjectAgentRoles(cwd, roles) {
    const file = projectAgentRoleFile(cwd), dir = path.dirname(file);
    await fsp.mkdir(dir, { recursive: true });
    const payload = { schemaVersion: 1, roles: roles.map(r => normalizeAgentRole(r, { source: 'project' })).filter(Boolean).slice(0, 32) };
    await atomicWriteJson(file, payload);   // 25.1 收编
    return payload.roles;
  }
  async function buildClaudeAgentDefinitions(cwd, config, jsonBudget = 6000) {
    const roles = (await getAgentRoleLibrary(cwd, config)).filter(r => !r.nativeClaude);
    const definitions = {};
    for (const role of roles) {
      const d = { description: role.description || role.label, prompt: role.prompt || role.description || role.label };
      if (role.claudeTools && role.claudeTools.length) d.tools = role.claudeTools;
      if (role.models && role.models.claude && role.models.claude !== 'inherit') d.model = role.models.claude;
      // 安全走查 S3:项目来源的角色把权限档夹到不高于这一回合的线程档位再交给 CLI(CLI 的 --agents 子代理按这个档起跑,不夹就能靠项目角色放宽)。
      const pm = claudePermissionMode(clampAgentRoleToParent(role, role.toolTier, config && config.permissionMode).permissionMode || role.permissionMode); if (pm) d.permissionMode = pm;
      if (role.mcpServers && role.mcpServers.length) d.mcpServers = role.mcpServers;
      if (role.budgets && role.budgets.claude) d.maxTurns = role.budgets.claude;
      if (role.isolation === 'worktree') d.isolation = 'worktree';
      if (role.color) d.color = role.color;
      definitions[role.id] = d;
    }
    // Keep the generated definitions within the existing prompt budget in library order.
    const budget = Math.max(0, Math.min(6000, Math.floor(Number(jsonBudget) || 0)));
    const selected = {}, omitted = [];
    for (const [id, def] of Object.entries(definitions)) {
      const candidate = { ...selected, [id]: def };
      if (JSON.stringify(candidate).length <= budget) selected[id] = def; else omitted.push(id);
    }
    return { definitions: selected, omitted, roles };
  }

  return { projectAgentRoleFile, readProjectAgentRoles, readClaudeProjectAgentRoles, getAgentRoleLibrary, saveProjectAgentRoles, buildClaudeAgentDefinitions };
}

module.exports = { createAgentRoleLibrary };
