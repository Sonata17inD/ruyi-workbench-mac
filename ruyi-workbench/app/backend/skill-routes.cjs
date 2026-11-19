'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { apiFailure, json, readJsonBody, send } = require('./http-protocol.cjs');
const { normalizeCwd, pathWithinAnyRoot } = require('./path-containment.cjs');

function createSkillRoutes({
  paths, SKILL_ID_RE, readConfig, loadSkillRegistry, fileAllowedRoots, logEvent,
  loadSession, mutateSession, activeChildren,
}) {
  // 第 116 波 116-2e:POST /api/session/skills 的核心,零行为抽出为 setSessionSkillsCore。
  // 为什么抽:`steward_skill_toggle`(§3.5「内容管理」行)必须与路由【共用同一段判据】—— 校验 id 在
  // 注册表里存在且 kind==='skill'、去重、截 8、来源锁定(P2-2 防调包)、活动回合同步(P2-3 防被回合
  // 收尾覆盖)。管家另写一份等于第二套语义,迟早两边打架。
  // 返回 { ok:true, skills } 或 { ok:false, error:'session not found' }(路由把它翻成 404;
  // 管家工具把它翻成 not_found 稳定信封)。
  async function setSessionSkillsCore(sessionId, skills) {
    const session = await loadSession(String(sessionId || '')).catch(() => null);
    if (!session) return { ok: false, error: 'session not found' };
    const config = await readConfig();
    const cwd = normalizeCwd(session.cwd, config.defaultWorkspace);
    const registry = await loadSkillRegistry(cwd, config).catch(() => []);
    const byIdReg = new Map(registry.filter(e => e.kind === 'skill').map(e => [e.id, e]));
    const cleaned = [];
    const seen = new Set();
    for (const raw of (Array.isArray(skills) ? skills : [])) {
      const id = String((raw && typeof raw === 'object') ? (raw.id || '') : (raw || '')).trim(); // 兼容前端传 id 或 {id,source}
      const e = byIdReg.get(id);
      if (!e || seen.has(id)) continue; // 只收注册表里存在的技能 id;去重
      seen.add(id);
      cleaned.push({ id, source: e.source || '' }); // P2-2: 从注册表带上 source 落盘 —— 锁定「启用当时的来源」,解析时据此防调包
      if (cleaned.length >= 8) break; // 上限 8
    }
    // 128b:落盘走 mutateSession —— 撤回插在 load 与 save 之间时,在新读的副本上重放这一改动,而不是被闸静默丢掉、
    // 照样回 ok:true(cleaned 只依赖 cwd 与注册表,撤回不改 cwd,重放安全)。
    let written;
    try { written = await mutateSession(session.id, fresh => { fresh.skills = cleaned; }, { writer: 'session_skills' }); }
    catch (error) {
      if (error && error.code === 'session.rewound_during_write') return { ok: false, error: error.code, status: 409 };
      throw error;
    }
    if (!written.session) return { ok: false, error: 'session not found' };
    // P2-3: 若该会话正有活动回合(内存另持一份 session 快照),同步把新启用集写进该活动 session,避免回合收尾整体
    // saveSession 覆盖本次变更(与两个 turn 函数收尾前的磁盘合并互为兜底)。
    { const reg = activeChildren.get(session.id); if (reg && reg.session && reg.session !== written.session) reg.session.skills = cleaned; }
    return { ok: true, skills: cleaned };
  }

  async function handleSkillApiRoutes(req, res, pathname) {
    // v1 技能体系: 统一技能注册表(四源合并)。read-only → same-origin gate 足够(不在 needsToken)。?cwd= 供
    // 解析项目级技能(<cwd>/.ruyi/skills);缺省用 defaultWorkspace。向后兼容: 保留 skills 数组字段名,每项在
    // 原有 name/description/insert 之外新增 kind/source/dir/available/unavailableReason,并给老前端 type=kind。
    if (req.method === 'GET' && pathname === '/api/skills') {
      const config = await readConfig();
      const cwdQ = new URL(req.url, 'http://x').searchParams.get('cwd') || '';
      // P3-2: ?cwd= 决定项目级技能(<cwd>/.ruyi/skills)的解析根 —— 约束它必须落在本应用允许触碰的工作区根内
      // (fileAllowedRoots: defaultWorkspace + recentWorkspaces + dataRoot),否则忽略该参数、静默回退 defaultWorkspace
      // (不报错),防调用方传入任意路径去解析该目录外仓库里的项目技能。
      let cwd = normalizeCwd(config.defaultWorkspace, config.defaultWorkspace);
      if (cwdQ) {
        const resolved = normalizeCwd(cwdQ, config.defaultWorkspace);
        if (pathWithinAnyRoot(path.resolve(resolved), fileAllowedRoots(null, config))) cwd = resolved;
      }
      const registry = await loadSkillRegistry(cwd, config).catch(() => []);
      const skills = registry.map(e => ({
        id: e.id, name: e.name, description: e.description, detail: e.detail || '', kind: e.kind, type: e.kind,
        source: e.source, insert: e.insert, dir: e.dir, requires: e.requires,
        available: e.available, unavailableReason: e.unavailableReason,
        // W8:从外部复制进如意的技能带「复制自」(技能库只读显示)。
        ...(e.copiedFrom ? { copiedFrom: e.copiedFrom, copiedFromPlugin: e.copiedFromPlugin || '' } : {}),
        ...(e.kind === 'command' ? { prompt: e.prompt || '' } : {}),
        // Playbook 条目带上完整 playbook 对象(前端「技能库」的 Playbook 项直接走 openPlaybookModal 流程)。
        ...(e.kind === 'playbook' && e.playbook ? { playbook: e.playbook } : {}),
        // 127-⑧:Playbook 条目的服务状态(四态,技能库行说「未知」靠它);技能/命令条目形状不变。
        ...(e.kind === 'playbook' ? { status: e.status } : {}),
      }));
      return send(res, json({ ok: true, skills }));
    }
    // v1 技能体系: 设置本会话启用的技能。body {sessionId, skills:[ids 或 {id}]}。校验 id 存在于注册表且 kind==='skill'、
    // 去重、截 8,每项落盘为 {id, source}(P2-2 来源锁定),写 session 后回 {ok, skills}。浏览器调用受 uiMutatingRoute
    // token 门(P3-7,与 /api/sessions 同级);非浏览器 loopback(e2e)仍只走 same-origin。
    if (req.method === 'POST' && pathname === '/api/session/skills') {
      const body = await readJsonBody(req);
      const result = await setSessionSkillsCore(String(body && body.sessionId || ''), body && body.skills);
      if (!result.ok && result.status === 409) return send(res, apiFailure(result.error, {}, '这条会话在写入期间被撤回过,这次改动没有落盘,请重试', 409));
      if (!result.ok) return send(res, json({ ok: false, error: result.error }, 404));
      return send(res, json({ ok: true, skills: result.skills }));
    }
    // v2.5: 删除用户技能。DELETE /api/skills {id, confirm}。「不要太简单」的摩擦:confirm 必须等于 id
    // (前端弹确认窗要求输入 id 才解锁确认键)。仅 source==='user' 可删(对应 paths.skills/<id>/ 目录);
    // builtin/project/claude-code 拒绝并给原因(builtin 是内置、project 在用户项目里、claude-code 是 Claude Code
    // 的文件 -- 都不该由 Ruyi 删)。路径双保险:entry.dir 必须解析为 paths.skills/id,防穿越/调包。
    if (req.method === 'DELETE' && pathname === '/api/skills') {
      const body = await readJsonBody(req);
      const id = String((body && body.id) || '').trim();
      const confirm = String((body && body.confirm) || '').trim();
      if (!id || !SKILL_ID_RE.test(id)) return send(res, json({ ok: false, error: '无效的技能 id' }, 400));
      if (confirm !== id) return send(res, json({ ok: false, error: '确认不匹配:请输入该技能的 id 以确认删除' }, 400));
      const config = await readConfig();
      const registry = await loadSkillRegistry('', config).catch(() => []);
      const entry = registry.find(e => e && e.id === id && e.kind === 'skill');
      if (!entry) return send(res, json({ ok: false, error: '未找到该技能: ' + id }, 404));
      if (entry.source !== 'user') return send(res, json({ ok: false, error: `仅可删除用户技能(当前来源: ${entry.source || '未知'})。内置/项目/Claude Code 技能请到对应位置管理。` }, 403));
      const expected = path.resolve(paths.skills, id);
      const actual = path.resolve(entry.dir || '');
      if (actual !== expected) return send(res, json({ ok: false, error: '路径校验失败:技能目录不在用户技能目录下' }, 400));
      try { await fsp.rm(actual, { recursive: true, force: true }); }
      catch (e) { return send(res, json({ ok: false, error: '删除失败: ' + ((e && e.message) || String(e)) })); }
      logEvent({ kind: 'skill_delete', id });
      return send(res, json({ ok: true, id, removed: true }));
    }
  }
  return { handleSkillApiRoutes, setSessionSkillsCore };
}

module.exports = { createSkillRoutes };
