'use strict';

const path = require('node:path');
const { apiFailure, apiSessionIdInvalid, apiSessionNotFound, json, readJsonBody, send } = require('./http-protocol.cjs');
const { normalizeCwd, pathWithinAnyRoot } = require('./path-containment.cjs');
const { coreMemoryMaxItems, coreMemoryCharBudget, memoryRelevanceMax, memoryFixedSelectionMax } = require('./runtime-policy.cjs');

// 域函数失败回执带 errorCode 时,路由走 apiFailure(稳定码 + 参数,前端按码本地化);没带的照旧 json(r, status)(逐字节不变)。
function memoryFailureResponse(r, status) {
  return r && r.errorCode ? apiFailure(r.errorCode, r.errorParams || {}, r.error || '', status) : json(r, status);
}

function createMemoryRoutes({
  tokenOk, safeSessionId, readConfig, fileAllowedRoots, logEvent, MEMORY_EXCLUSION_MAX,
  loadSession, mutateSession, activeChildren,
  store: { loadMemoryRegistry, projectKeyForCwd, resolveCoreMemoryState, listMemoryProjectGroups,
    readMemoryItem, migrateMemory, moveMemoryScope, saveMemory, deleteMemory },
  proposals: { replayPendingMemoryProposal, proposeMemoryFromSession, decideMemoryProposal,
    applyMemoryRelationProposal, draftMemoryFromSession, validateMemoryProposalSave },
  relations: { listMemoryRelations, analyzeMemoryMaintenance, proposeMemoryRelation,
    confirmMemoryRelation, deleteMemoryRelation },
}) {
  async function handleMemoryApiRoutes(req, res, pathname) {
    // ── v2 跨会话记忆(团队模式 v2 Phase 3, 设计稿 C) ─────────────────────────────────────────────
    // POST /api/session/memories:memories=固定选择；useDefault=true 恢复项目+全局默认检索，并可携带会话排除项。
    if (req.method === 'POST' && pathname === '/api/session/memories') {
      const body = await readJsonBody(req);
      const session = await loadSession(String(body && body.sessionId || '')).catch(() => null);
      if (!session) return send(res, apiSessionNotFound());
      const config = await readConfig();
      const cwd = normalizeCwd(session.cwd, config.defaultWorkspace);
      const registry = await loadMemoryRegistry(cwd).catch(() => []);
      const byKey = new Map(registry.map(e => [e.scope + ':' + e.id, e]));
      const projKey = projectKeyForCwd(cwd); // P3-3: 权威 projectKey(取自 session.cwd),给 project 条目落盘锁定来源
      // 128b:三个字段一起走 mutateSession 落盘(撤回插在中间时在新读的副本上重放,不被闸静默丢掉还回 ok)。
      const writeMemoryFields = async fields => {
        try {
          const written = await mutateSession(session.id, fresh => { Object.assign(fresh, fields); }, { writer: 'session_memories' });
          if (!written.session) { send(res, apiSessionNotFound()); return true; }
        } catch (error) {
          if (error && error.code === 'session.rewound_during_write') { send(res, apiFailure(error.code, {}, error.message, 409)); return true; }
          throw error;
        }
        { const reg = activeChildren.get(session.id); if (reg && reg.session) Object.assign(reg.session, fields); }
        return false;   // 没有替调用方回过话:调用方接着回成功
      };
      if (body && body.useDefault === true) {
        const excluded = [];
        const excludedSeen = new Set();
        for (const raw of (Array.isArray(body.memoryExclusions) ? body.memoryExclusions : [])) {
          const id = String((raw && raw.id) || '').trim();
          const scope = raw && raw.scope === 'global' ? 'global' : 'project';
          const key = scope + ':' + id;
          if (!byKey.has(key) || excludedSeen.has(key)) continue;
          excludedSeen.add(key);
          excluded.push(scope === 'project' ? { id, scope, projectKey: projKey } : { id, scope });
          if (excluded.length >= MEMORY_EXCLUSION_MAX) break;
        }
        if (await writeMemoryFields({ memories: [], memoriesExplicit: false, memoryExclusions: excluded })) return;
        return send(res, json({ ok: true, memories: [], memoriesExplicit: false, memoryExclusions: excluded }));
      }
      const cleaned = [];
      const seen = new Set();
      for (const raw of (Array.isArray(body && body.memories) ? body.memories : [])) {
        const id = String((raw && raw.id) || '').trim();
        const scope = (raw && raw.scope === 'global') ? 'global' : 'project';
        const key = scope + ':' + id;
        if (!byKey.has(key) || seen.has(key)) continue; // 只收注册表里存在的(存在性校验)
        seen.add(key);
        // P3-3: project 条目落盘 projectKey(锁定「启用当时的项目组」);global 无此概念。前端如传 projectKey 一律以服务端权威值覆盖。
        cleaned.push(scope === 'project' ? { id, scope, projectKey: projKey } : { id, scope });
        if (cleaned.length >= memoryFixedSelectionMax(config)) break;
      }
      // memoriesExplicit:true = 用户显式设置过 → 关闭默认自动启用
      if (await writeMemoryFields({ memories: cleaned, memoriesExplicit: true, memoryExclusions: [] })) return;
      return send(res, json({ ok: true, memories: cleaned, memoriesExplicit: true, memoryExclusions: [] }));
    }
    // GET /api/memory?cwd= —— 列表(global + 当前项目组 + 其它组供迁移)。返回记忆条目含绝对文件路径 → 属只读内容型
    // GET,须 tokenOk 自校验(v1.4.6-S1 DNS-rebinding 加固既定模式,同 /api/file/preview;GET 不过 mutating 鉴权块)。
    // ?cwd= 约束到 fileAllowedRoots,越界静默回退 defaultWorkspace(同 GET /api/skills 的 P3-2)。
    if (req.method === 'GET' && pathname === '/api/memory') {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const config = await readConfig();
      const cwdQ = new URL(req.url, 'http://x').searchParams.get('cwd') || '';
      let cwd = normalizeCwd(config.defaultWorkspace, config.defaultWorkspace);
      if (cwdQ) { const resolved = normalizeCwd(cwdQ, config.defaultWorkspace); if (pathWithinAnyRoot(path.resolve(resolved), fileAllowedRoots(null, config))) cwd = resolved; }
      const registry = await loadMemoryRegistry(cwd).catch(() => []);
      const coreState = await resolveCoreMemoryState(cwd, registry, config).catch(() => ({ all: registry, active: [], standby: [], expired: [], stats: { total: registry.length, coreRequested: 0, active: 0, standby: 0, expired: 0, reviewDue: 0, charsUsed: 0, charLimit: coreMemoryCharBudget(config), itemLimit: coreMemoryMaxItems(config) } }));
      const projectKey = projectKeyForCwd(cwd);
      const otherProjects = await listMemoryProjectGroups(projectKey).catch(() => []);
      // limits:前端文案/上限读这里,不再各写一份死数(设置页可调:每回合相关记忆条数、会话固定选择上限)。
      const limits = { relevanceMax: memoryRelevanceMax(config), fixedSelectionMax: memoryFixedSelectionMax(config), coreItemMax: coreMemoryMaxItems(config), coreCharBudget: coreMemoryCharBudget(config) };
      return send(res, json({ ok: true, memories: coreState.all, core: coreState.stats, limits, projectKey, cwd, otherProjects }));
    }
    // GET /api/memory/item?id=&scope=&cwd= —— 读单条记忆全文(编辑回填)。返回文件正文 → 只读内容型 GET,须 tokenOk
    // 自校验(同 /api/memory 与 /api/file/preview 的 DNS-rebinding 加固模式)。
    if (req.method === 'GET' && pathname === '/api/memory/item') {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const config = await readConfig();
      const sp = new URL(req.url, 'http://x').searchParams;
      const scope = sp.get('scope') === 'global' ? 'global' : 'project';
      const cwdQ = sp.get('cwd') || '';
      let cwd = normalizeCwd(config.defaultWorkspace, config.defaultWorkspace);
      if (cwdQ) { const resolved = normalizeCwd(cwdQ, config.defaultWorkspace); if (pathWithinAnyRoot(path.resolve(resolved), fileAllowedRoots(null, config))) cwd = resolved; }
      const item = await readMemoryItem(String(sp.get('id') || ''), scope, cwd);
      return send(res, json(item, item.ok ? 200 : 404));
    }
    // POST /api/memory/proposal {sessionId} —— 高门槛自动候选：确定性预筛后才让同一 provider 模型裁决；
    // 只返回候选，不写记忆。模型否决、冷却、重复、敏感或不可用都静默返回 proposal:null。
    if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/proposal') {
      const body = await readJsonBody(req);
      const sessionId = safeSessionId(body && body.sessionId);
      if (!sessionId) return send(res, apiSessionIdInvalid());
      // replay:true = 只读回放(线程打开/页面刷新后把仍待确认的候选卡画回来),不跑自动审稿、不写状态。
      if (body && body.replay === true) return send(res, json(await replayPendingMemoryProposal(sessionId)));
      return send(res, json(await proposeMemoryFromSession(sessionId)));
    }
    // POST /api/memory/proposal/decision —— 只有用户在卡片上保存/忽略时落候选状态；仍不替用户写记忆。
    if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/proposal/decision') {
      const body = await readJsonBody(req);
      const sessionId = safeSessionId(body && body.sessionId);
      if (!sessionId) return send(res, apiSessionIdInvalid());
      const r = await decideMemoryProposal(sessionId, String(body && body.proposalId || ''), String(body && body.decision || ''));
      return send(res, json(r, r.ok ? 200 : 404));
    }
    // POST /api/memory/proposal/apply —— 用户在维护卡片上确认后,按候选 kind 落盘(memory_revise 覆盖 /
    // relation_propose 写 confirmed 边 / relation_revoke 删边 / C3 memory_batch 按 accept[] 只存用户勾上的那几条)。
    // 模型只 propose,此路由只由 UI 调用(用户批准)。
    if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/proposal/apply') {
      const body = await readJsonBody(req);
      const sessionId = safeSessionId(body && body.sessionId);
      if (!sessionId) return send(res, apiSessionIdInvalid());
      const config = await readConfig();
      const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
      if (!pathWithinAnyRoot(path.resolve(cwd), fileAllowedRoots(null, config))) return send(res, json({ ok: false, error: 'cwd 不在允许的工作区内' }, 400));
      const r = await applyMemoryRelationProposal(sessionId, String(body && body.proposalId || ''), cwd, { accept: body && body.accept, overrides: body && body.overrides });
      // 批量卡里有条目写盘失败(r.failed)是服务端故障,不是「候选不存在」:回 500,卡片留着让用户重试。
      // 带 errorCode 的失败(修订建议已过期等)走 apiFailure 稳定码,前端按码本地化。
      return send(res, memoryFailureResponse(r, r.ok ? 200 : (r.conflict ? 409 : (Array.isArray(r.failed) ? 500 : 404))));
    }
    // POST /api/memory/draft {sessionId} —— provider 起草(镜像 playbook/draft)。必须在通配 /api/memory/<id> 之前。
    if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/draft') {   // 对抗轮 P3: 放行删除约定穿透
      const body = await readJsonBody(req);
      const sessionId = safeSessionId(body && body.sessionId);
      if (!sessionId) return send(res, apiSessionIdInvalid());
      return send(res, json(await draftMemoryFromSession(sessionId)));
    }
    // POST /api/memory/migrate {id, fromKey, cwd} —— 迁移一条项目记忆到当前 cwd 的项目组。
    if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/migrate') {   // 对抗轮 P3: 放行删除约定穿透
      const body = await readJsonBody(req);
      const config = await readConfig();
      const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
      if (!pathWithinAnyRoot(path.resolve(cwd), fileAllowedRoots(null, config))) return send(res, json({ ok: false, error: 'cwd 不在允许的工作区内' }, 400));
      const r = await migrateMemory(String(body && body.id || ''), String(body && body.fromKey || ''), cwd);
      // P2-4: 同名冲突返回 409(Conflict),与一般失败 400 区分,供前端汇总「N 条冲突跳过」。
      return send(res, json(r, r.ok ? 200 : (r.conflict ? 409 : 400)));
    }
    // POST /api/memory/metadata —— 工具箱里的核心/重要性快捷操作。先读原条目再完整保存，正文不丢失；
    // LRU 只据这些元数据调整核心席位，不会在此路由删除或替换任何记忆。
    if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/metadata') {
      const body = await readJsonBody(req);
      const config = await readConfig();
      const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
      const scope = body && body.scope === 'global' ? 'global' : 'project';
      if (scope === 'project' && !pathWithinAnyRoot(path.resolve(cwd), fileAllowedRoots(null, config))) return send(res, json({ ok: false, error: 'cwd 不在允许的工作区内' }, 400));
      const item = await readMemoryItem(String(body && body.id || ''), scope, cwd);
      if (!item.ok) return send(res, json(item, 404));
      const patch = body && body.patch && typeof body.patch === 'object' ? body.patch : {};
      const memory = { ...item.memory };
      if (Object.prototype.hasOwnProperty.call(patch, 'core')) memory.core = patch.core === true;
      if (Object.prototype.hasOwnProperty.call(patch, 'importance')) memory.importance = patch.importance === 'important' ? 'important' : 'normal';
      if (Object.prototype.hasOwnProperty.call(patch, 'reviewAfter')) memory.reviewAfter = patch.reviewAfter;
      if (Object.prototype.hasOwnProperty.call(patch, 'expiresAt')) memory.expiresAt = patch.expiresAt;
      const r = await saveMemory(memory, cwd);
      return send(res, json(r, r.ok ? 200 : 400));
    }
    // POST /api/memory {memory:{id?,scope,name,description,type,body}, cwd} —— 保存(id 缺省合成,原子写)。
    if (req.method === 'POST' && pathname === '/api/memory') {
      const body = await readJsonBody(req);
      const config = await readConfig();
      const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
      const memIn = (body && body.memory) || {};
      // 围栏:saveMemory 把【任何】非 global 的 scope(含缺省、拼错)都当 project 落进 cwd 的项目组,所以这里也一律按「非 global」校验
      // (修前只拦 === 'project',缺省 scope 能绕过去,在围栏外的 cwd 下建出项目目录)。换作用域时旧作用域是 project 也要校验。
      const moveFrom = body && (body.moveFromScope === 'global' || body.moveFromScope === 'project') ? body.moveFromScope : '';
      if ((memIn.scope !== 'global' || moveFrom === 'project') && !pathWithinAnyRoot(path.resolve(cwd), fileAllowedRoots(null, config))) return send(res, json({ ok: false, error: 'cwd 不在允许的工作区内' }, 400));
      const proposalSourceSessionId = body && body.proposalId ? String(body.sourceSessionId || '') : '';
      const proposalId = body && body.proposalId ? String(body.proposalId || '') : '';
      if (proposalId) {
        const sourceCheck = await validateMemoryProposalSave(proposalSourceSessionId, proposalId, cwd);
        if (!sourceCheck.ok) return send(res, json(sourceCheck, sourceCheck.conflict ? 409 : 404));
      }
      // moveFromScope:编辑弹窗里改了作用域 = 换作用域(另存到新作用域 + 删旧的,服务端一步做完、失败回滚),见 moveMemoryScope。
      const toScope = memIn.scope === 'global' ? 'global' : 'project';
      const r = moveFrom && moveFrom !== toScope && memIn.id ? await moveMemoryScope({ ...memIn, scope: toScope }, moveFrom, cwd) : await saveMemory(memIn, cwd);
      // The memory write and proposal acknowledgement belong to the same server-side
      // operation from the UI's perspective. Settle here so a dropped browser response
      // does not normally leave a successfully saved candidate pending.
      if (r.ok && proposalId) await decideMemoryProposal(proposalSourceSessionId, proposalId, 'saved').catch(() => {});
      return send(res, memoryFailureResponse(r, r.ok ? 200 : (r.conflict ? 409 : 400)));
    }
    // R4 Local Memory Graph(设计稿 15-r4-memory-graph.md)。relations 路由须在通配 /api/memory/<id>(下文 DELETE)之前,
    // 否则 path.basename('/api/memory/relations/rel-x')='rel-x' 会误删记忆。模型只 propose;confirm/delete 仅用户。
    // GET /api/memory/relations?cwd=&scope=&includePending= -- 列边(默认仅 confirmed;includePending=true 含 pending)。
    if (req.method === 'GET' && pathname === '/api/memory/relations') {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const config = await readConfig();
      const sp = new URL(req.url, 'http://x').searchParams;
      const scope = sp.get('scope') === 'global' ? 'global' : 'project';
      const cwdQ = sp.get('cwd') || '';
      let cwd = normalizeCwd(config.defaultWorkspace, config.defaultWorkspace);
      if (cwdQ) { const resolved = normalizeCwd(cwdQ, config.defaultWorkspace); if (pathWithinAnyRoot(path.resolve(resolved), fileAllowedRoots(null, config))) cwd = resolved; }
      const r = await listMemoryRelations(cwd, scope, { includePending: sp.get('includePending') === 'true' });
      return send(res, json(r));
    }
    // R4-S3 GET /api/memory/maintenance?cwd=&scope=&staleDays= -- 确定性聚类 + 过期复核建议。
    // 只读且永不自动删/禁用；内容含项目记忆 id，ROUTE_AUTH + handler 双 token 门。
    if (req.method === 'GET' && pathname === '/api/memory/maintenance') {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const config = await readConfig();
      const sp = new URL(req.url, 'http://x').searchParams;
      const scope = sp.get('scope') === 'global' ? 'global' : 'project';
      const cwdQ = sp.get('cwd') || '';
      let cwd = normalizeCwd(config.defaultWorkspace, config.defaultWorkspace);
      if (cwdQ) { const resolved = normalizeCwd(cwdQ, config.defaultWorkspace); if (pathWithinAnyRoot(path.resolve(resolved), fileAllowedRoots(null, config))) cwd = resolved; }
      const r = await analyzeMemoryMaintenance(cwd, scope, { staleDays: sp.get('staleDays') });
      try { logEvent({ kind: 'memory_maintenance_scan', scope, clusters: r.stats.clusters, suggestions: r.stats.expirySuggestions }); } catch { /* 审计失败不阻断只读分析 */ }
      return send(res, json(r));
    }
    // POST /api/memory/relations/propose {type,from,to,scope?,evidenceRef?,sourceRunId?,note?,cwd} -- 提议(confirmed:false)。
    if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/relations/propose') {
      const body = await readJsonBody(req);
      const config = await readConfig();
      const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
      if (body && body.scope === 'project' && !pathWithinAnyRoot(path.resolve(cwd), fileAllowedRoots(null, config))) return send(res, json({ ok: false, error: 'cwd 不在允许的工作区内' }, 400));
      const r = await proposeMemoryRelation(body || {}, cwd);
      return send(res, json(r, r.ok ? 200 : 400));
    }
    // POST /api/memory/relations/confirm {id,cwd} -- 确认(confirmed:true,仅用户)。
    if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/relations/confirm') {
      const body = await readJsonBody(req);
      const config = await readConfig();
      const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
      const r = await confirmMemoryRelation(String(body && body.id || ''), cwd);
      return send(res, json(r, r.ok ? 200 : 404));
    }
    // DELETE /api/memory/relations/<id> {cwd} -- 删边(仅用户)。须在通配 /api/memory/<id> 之前匹配。
    if (pathname.startsWith('/api/memory/relations/') && (req.method === 'DELETE' || (req.method === 'POST' && req.headers['x-http-method'] === 'DELETE'))) {
      const id = path.basename(pathname); // guards traversal(relations/ 前缀已匹配,id 须过 SKILL_ID_RE)
      const body = await readJsonBody(req);
      const config = await readConfig();
      const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
      const r = await deleteMemoryRelation(id, cwd);
      return send(res, json(r, r.ok ? 200 : 404));
    }
    // DELETE 经 POST /api/memory/<id> + x-http-method:DELETE {scope, cwd}(sessions/playbooks 同款约定)。
    if (pathname.startsWith('/api/memory/') && (req.method === 'DELETE' || (req.method === 'POST' && req.headers['x-http-method'] === 'DELETE'))) {
      const id = path.basename(pathname); // guards traversal
      const body = await readJsonBody(req);
      const config = await readConfig();
      const scope = body && body.scope === 'global' ? 'global' : 'project';
      const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
      if (scope === 'project' && !pathWithinAnyRoot(path.resolve(cwd), fileAllowedRoots(null, config))) return send(res, json({ ok: false, error: 'cwd 不在允许的工作区内' }, 400));   // 对抗轮 P3: 与保存分支同款 root 校验
      const r = await deleteMemory(id, scope, cwd);
      return send(res, json(r, r.ok ? 200 : (r.unlinkFailed ? 500 : 404)));   // 文件还在、删不掉(占用/权限)是 500,不是「找不到」
    }
  }
  return handleMemoryApiRoutes;
}

module.exports = { createMemoryRoutes };
