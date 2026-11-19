'use strict';

const path = require('node:path');
const { apiFailure, json, readJsonBody, send } = require('./http-protocol.cjs');
const { normalizeCwd } = require('./path-containment.cjs');
const { BUILTIN_AGENT_ROLES, normalizeAgentRole, annotateAgentRoleEffective } = require('./agent-role-policy.cjs');
const { RUYI_MCP_SERVER_ID } = require('./product-identity.cjs');

function createConfigurationRoutes({
  readConfig, mutateConfig, maskProviders, ConfigPatchHooks, ToolboxHooks, projectCwdDirectoryFailure, resolveExternalMcpServers,
  roles: { getAgentRoleLibrary, readProjectAgentRoles, readClaudeProjectAgentRoles, buildClaudeAgentDefinitions,
    saveProjectAgentRoles, projectAgentRoleFile },
  workflows: { getAgentWorkflows, normalizeAgentWorkflow, agentWorkflowSaveProblem, saveAgentWorkflow, deleteAgentWorkflow },
}) {
  async function handleConfigurationApiRoutes(req, res, pathname) {
    if (req.method === 'POST' && pathname === '/api/config') {
      const body = await readJsonBody(req);
      let next = null;
      try {
        next = await ConfigPatchHooks.applyConfigPatch(body); // 06k 填入(见 01 的 ConfigPatchHooks 头注)
      } catch (error) {
        // 116-3 B1:切全局默认权限到「全自动」缺 confirm:true -> 409,错误码与 13d 的线程级 PATCH 同一个。
        if (error && error.code === 'permission.confirm_required') {
          return send(res, apiFailure('permission.confirm_required', { permissionMode: String(error.permissionMode || '') },
            String(error.message || ''), 409));
        }
        // 107-S2:掩码回传 + 启动向量变了 -> 409 整份拒绝(零写入)。params 里只带条目名与字段名,绝不带值;
        // 前端按【码】分支(不按中文),见 provider-settings.js 的 saveConfigPartial。
        if (error && error.code === 'config.masked_secret_vector_changed') {
          return send(res, apiFailure('config.masked_secret_vector_changed',
            { conflicts: Array.isArray(error.conflicts) ? error.conflicts : [] }, String(error.message || ''), 409));
        }
        throw error;
      }
      // 设置页停用／启用了某个 toolbox 组件(或动了总开关)→ 对账一次:该停的停、该起的起、自动生成的服务商条目跟上。
      // 只在这次补丁确实带了 toolbox 键时才做 —— 平常的保存不该顺手去探一圈端口。不 await:保存的回包不等进程起来。
      if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'toolbox') && typeof ToolboxHooks.reconcile === 'function') void ToolboxHooks.reconcile().catch(() => {});
      return send(res, json({ ok: true, config: maskProviders(next) })); // F2: masked response
    }
    if (req.method === 'GET' && pathname === '/api/agent-roles') {
      const config = await readConfig();
      const u = new URL(req.url, 'http://x');
      const cwd = normalizeCwd(u.searchParams.get('cwd') || config.defaultWorkspace, config.defaultWorkspace);
      const roles = await getAgentRoleLibrary(cwd, config);
      const builtinRoles = BUILTIN_AGENT_ROLES.map(r => normalizeAgentRole(r, { source: 'builtin', builtin: true }));
      const globalRoles = (config.agentRoleOverrides || []).map(r => normalizeAgentRole(r, { source: 'global' })).filter(Boolean);
      const projectRoles = await readProjectAgentRoles(cwd);
      const nativeClaudeRoles = await readClaudeProjectAgentRoles(cwd);
      const claudeDefs = await buildClaudeAgentDefinitions(cwd, config);
      const mcpServers = [{ id: RUYI_MCP_SERVER_ID, label: 'Ruyi Workbench' }, ...resolveExternalMcpServers(config).map(s => ({ id: s.id, label: s.label || s.id }))];
      // 安全走查 S3:项目来源的角色带上【有效档位】标注(effectivePermissionMode / effectiveToolTier / roleClamped),按全局默认档夹;
      // 角色自己声明的 permissionMode / toolTier 原样不动(设置页编辑器按它存回)。真正起跑时按那条线程的实际档再夹一次。
      const parentModeForRoles = config.permissionMode;
      const projectRolesView = projectRoles.map(r => annotateAgentRoleEffective(r, parentModeForRoles));
      const nativeClaudeRolesView = nativeClaudeRoles.map(r => annotateAgentRoleEffective(r, parentModeForRoles));
      return send(res, json({ ok: true, cwd, roles, builtinRoles, globalRoles, projectRoles: projectRolesView, nativeClaudeRoles: nativeClaudeRolesView, mcpServers, drivers: { openai: { mode: 'workbench-native' }, claude: { mode: 'claude-native', flag: '--agents', synced: Object.keys(claudeDefs.definitions), omitted: claudeDefs.omitted } } }));
    }
    if (req.method === 'POST' && pathname === '/api/agent-roles') {
      const body = await readJsonBody(req);
      const scope = body && body.scope === 'project' ? 'project' : 'global';
      const roles = (Array.isArray(body && body.roles) ? body.roles : []).map(r => normalizeAgentRole(r, { source: scope })).filter(Boolean).slice(0, 32);
      if (scope === 'project') {
        const cwdRaw = String(body && body.cwd || '');
        if (!cwdRaw || !path.isAbsolute(cwdRaw)) return send(res, json({ ok: false, error: 'project scope requires an absolute cwd' }, 400));
        const cwdBad = await projectCwdDirectoryFailure(cwdRaw);   // 不存在/是文件:400 人话,不再 500 + ENOTDIR 原文
        if (cwdBad) return send(res, cwdBad);
        const saved = await saveProjectAgentRoles(path.resolve(cwdRaw), roles);
        return send(res, json({ ok: true, scope, roles: saved, file: projectAgentRoleFile(cwdRaw) }));
      }
      // 117n-M2:走 mutateConfig 的临界区(此前裸 readConfig -> 改字段 -> writeConfig:与并发的
      // /api/config 保存互吞 —— 存角色的那一下能把刚存的 Provider 整份回滚成读时的旧值)。
      const saved = await mutateConfig(async (config) => { config.agentRoleOverrides = roles; });
      return send(res, json({ ok: true, scope, roles: saved.config.agentRoleOverrides }));
    }
    if (req.method === 'GET' && pathname === '/api/agent-workflows') {
      const config = await readConfig(); const u = new URL(req.url, 'http://x');
      const cwd = normalizeCwd(u.searchParams.get('cwd') || config.defaultWorkspace, config.defaultWorkspace);
      return send(res, json({ ok: true, cwd, workflows: await getAgentWorkflows(cwd) }));
    }
    if (req.method === 'POST' && pathname === '/api/agent-workflows') {
      const body = await readJsonBody(req); const scope = body && body.scope === 'project' ? 'project' : 'personal';
      const config = await readConfig(); const cwd = normalizeCwd(body && body.cwd || config.defaultWorkspace, config.defaultWorkspace);
      if (scope === 'project') { const cwdBad = await projectCwdDirectoryFailure(cwd); if (cwdBad) return send(res, cwdBad); }   // 同 /api/agent-roles(先于工作流本体校验:目录都不对就没必要往下)
      const draft = normalizeAgentWorkflow(body && body.workflow, { source: scope });
      const problem = draft ? agentWorkflowSaveProblem(draft, new Set((await getAgentRoleLibrary(cwd, config)).map(r => r.id))) : null;
      if (problem) return send(res, apiFailure(problem.code, problem.params, `无效工作流：${problem.message}`, 400));
      const workflow = await saveAgentWorkflow(scope, cwd, body && body.workflow);
      if (!workflow) return send(res, json({ ok: false, error: '无效工作流：需要唯一 id 和标题；节点 id 不重复、任务非空，依赖只能指向其它已有节点' }, 400));
      return send(res, json({ ok: true, scope, workflow }));
    }
    if (pathname.startsWith('/api/agent-workflows/') && (req.method === 'DELETE' || (req.method === 'POST' && req.headers['x-http-method'] === 'DELETE'))) {
      const id = String(pathname.slice('/api/agent-workflows/'.length)).toLowerCase(); const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const config = await readConfig(); const scope = body && body.scope === 'project' ? 'project' : 'personal'; const cwd = normalizeCwd(body && body.cwd || config.defaultWorkspace, config.defaultWorkspace);
      if (scope === 'project') { const cwdBad = await projectCwdDirectoryFailure(cwd); if (cwdBad) return send(res, cwdBad); }
      return send(res, json({ ok: await deleteAgentWorkflow(scope, cwd, id), id, scope }));
    }
  }

  return handleConfigurationApiRoutes;
}

module.exports = { createConfigurationRoutes };
