'use strict';

const { normalizeCwd } = require('./path-containment.cjs');
const { memorySelectionSignature } = require('./memory-selection.cjs');

function createMemoryTools({ store, selection, recall, relations, activeChildren, loadSession, readConfig, safeSessionId, SKILL_ID_RE }) {
  const { loadMemoryRegistry, memoryIsExpired, readMemoryItem, touchMemoryUsage } = store;
  const { eligibleMemoryEntries, resolveCoreMemoryState } = selection;
  const { memoryRetrievalKey, rankRelevantMemoriesScored } = recall;
  const { memoryValidSupersededBy, readConfirmedSupersedeEdges } = relations;

  async function resolveWorkbenchMemoryToolContext(ctx) {
    const sid = safeSessionId((ctx && ctx.sessionId) || process.env.WCW_SESSION_ID || '');
    let session = ctx && ctx.session;
    if (!session && sid) session = await loadSession(sid).catch(() => null);
    const config = (ctx && ctx.config) || await readConfig();
    const cwd = normalizeCwd((ctx && ctx.workingDir) || (session && session.cwd), config.defaultWorkspace);
    return { sid, session, config, cwd };
  }

  async function listWorkbenchMemories(args, ctx) {
    const context = await resolveWorkbenchMemoryReadContext(ctx);
    if (!context.valid()) return { ok: false, error: 'memory context changed or unavailable' };
    const { cwd, config, session } = context;
    const scope = args && args.scope === 'global' ? 'global' : (args && args.scope === 'project' ? 'project' : 'all');
    const query = String(args && args.query || '').trim();
    const limitNum = Math.floor(Number(args && args.limit));   // ≤ 0 / 非数字回默认 20(修前 0 → 20、-5 → 1)
    const limit = limitNum > 0 ? Math.min(50, limitNum) : 20;
    const all = await loadMemoryRegistry(cwd);
    const edges = await readConfirmedSupersedeEdges(cwd);
    const libraryVersion = memoryToolLibraryVersion(all, edges);
    const eligible = eligibleMemoryEntries(session, all, cwd, config);
    const coreState = await resolveCoreMemoryState(cwd, eligible, config);
    const superseded = memoryValidSupersededBy(edges, new Map(all.map(e => [memoryRetrievalKey(e), e])));
    let registry = coreState.all;
    if (scope !== 'all') registry = registry.filter(m => m.scope === scope);
    // 带 query 时 preference/convention 无词命中也会入榜(默认应遵守的稳定规则,列出来是对的),但它们【没有被这次检索
    // 选中】—— 只给真命中的条目记一次使用(useCount/lastUsedAt 喂记忆的新鲜度与淘汰判断,不该被不相干的查询刷高)。
    let matched = null;
    if (query) {
      const ranked = rankRelevantMemoriesScored(registry, query).slice(0, limit);
      registry = ranked.map(x => x.entry);
      matched = ranked.filter(x => x.shared > 0).map(x => x.entry);
    } else registry = registry.slice(0, limit);
    if (!await context.current() || !await memoryToolLibraryCurrent(cwd, libraryVersion)) return { ok: false, error: 'memory context changed or unavailable' };
    if (matched && matched.length) await touchMemoryUsage(matched, cwd, 'relevant');
    if (!await context.current() || !await memoryToolLibraryCurrent(cwd, libraryVersion) || !await context.current()
      || registry.some(e => memoryIsExpired(e))) return { ok: false, error: 'memory context changed or unavailable' };
    return { ok: true, query, scope, count: registry.length, core: coreState.stats,
      memories: registry.map(m => ({ id: m.id, scope: m.scope, name: m.name, description: m.description, type: m.type,
        createdAt: m.createdAt, updatedAt: m.updatedAt, core: m.core, coreStatus: m.coreStatus, importance: m.importance,
        reviewAfter: m.reviewAfter, expiresAt: m.expiresAt, lastUsedAt: m.lastUsedAt, useCount: m.useCount,
        ...memoryToolSupersededStatus(m, superseded, eligible) })) };
  }

  async function readWorkbenchMemory(args, ctx) {
    const context = await resolveWorkbenchMemoryReadContext(ctx);
    if (!context.valid()) return { ok: false, error: 'memory context changed or unavailable' };
    const { cwd, session, config } = context;
    const id = String(args && args.id || '').trim();
    if (!SKILL_ID_RE.test(id)) return { ok: false, error: 'invalid memory id' };
    const all = await loadMemoryRegistry(cwd), eligible = eligibleMemoryEntries(session, all, cwd, config);
    const edges = await readConfirmedSupersedeEdges(cwd);
    const libraryVersion = memoryToolLibraryVersion(all, edges);
    const candidates = eligible.filter(e => e.id === id && (!['global', 'project'].includes(args?.scope) || e.scope === args.scope));
    if (candidates.length > 1) return { ok: false, error: 'memory id exists in both scopes; specify scope' };
    if (!candidates.length || !context.valid()) return { ok: false, error: 'memory not available in this session' };
    const selected = candidates[0], item = await readMemoryItem(id, selected.scope, cwd);
    const superseded = memoryValidSupersededBy(edges, new Map(all.map(e => [memoryRetrievalKey(e), e])));
    if (!await context.current() || !await memoryToolLibraryCurrent(cwd, libraryVersion) || !context.valid()
      || item.ok && (memoryIsExpired(item.memory) || item.memory.updatedAt !== selected.updatedAt)) return { ok: false, error: 'memory context changed or unavailable' };
    if (item.ok) {
      Object.assign(item.memory, memoryToolSupersededStatus(item.memory, superseded, eligible));
      await touchMemoryUsage([item.memory], cwd, 'read');
    }
    if (!await memoryToolLibraryCurrent(cwd, libraryVersion) || !await context.current() || item.ok && memoryIsExpired(item.memory)) return { ok: false, error: 'memory context changed or unavailable' };
    return item;
  }

  function memoryToolLibraryVersion(registry, edges = []) {
    return JSON.stringify([registry.map(e => [memoryRetrievalKey(e), e.memoryVersion || '', memoryIsExpired(e)]), edges]);
  }

  async function memoryToolLibraryCurrent(cwd, version) {
    const registry = await loadMemoryRegistry(cwd), edges = await readConfirmedSupersedeEdges(cwd);
    return memoryToolLibraryVersion(registry, edges) === version;
  }

  async function resolveWorkbenchMemoryReadContext(ctx) {
    const rawSid = String(ctx?.sessionId || process.env.WCW_SESSION_ID || '');
    const initialSession = activeChildren.get(rawSid)?.session || ctx?.session;
    const initialSignature = initialSession ? memorySelectionSignature(initialSession, ctx?.workingDir) : null;
    const initialReg = rawSid ? activeChildren.get(rawSid) : null;
    const context = await resolveWorkbenchMemoryToolContext(initialSession ? { ...ctx, session: initialSession } : ctx);
    const { sid, session, cwd } = context;
    const signature = initialSignature || memorySelectionSignature(session, cwd);
    context.valid = () => (!rawSid || sid === rawSid && !!session) && !ctx?.signal?.aborted
      && (!session || normalizeCwd(session.cwd, context.config.defaultWorkspace) === cwd)
      && (ctx?.memoryLiveRead !== true || !!initialReg)
      && (ctx?.turnSeq == null || Number(ctx.turnSeq) === Number(session?.turnSeq))
      && memorySelectionSignature(session, cwd) === signature
      && (!initialReg || activeChildren.get(sid) === initialReg && !initialReg.exited && initialReg.state === 'running')
      && (!sid || !activeChildren.has(sid) || activeChildren.get(sid) === initialReg);
    context.current = async () => {
      if (!context.valid()) return false;
      if (sid && !initialReg) {
        const fresh = await loadSession(sid).catch(() => null);
        if (!fresh || memorySelectionSignature(fresh, cwd) !== signature) return false;
      }
      return context.valid();
    };
    return context;
  }

  // Reveal a replacement identity only when it is itself in the selected set. Never expand a fixed selection.
  function memoryToolSupersededStatus(entry, marks, eligible) {
    const by = marks.get(memoryRetrievalKey(entry));
    if (!by?.size) return {};
    const allowed = new Set(eligible.map(memoryRetrievalKey));
    return { superseded: true, supersededBy: [...by].filter(id => allowed.has(entry.scope + ':' + id)),
      applicability: 'Historical reference; a confirmed replacement exists. Verify current requirements before using.' };
  }

  return { resolveWorkbenchMemoryToolContext, listWorkbenchMemories, readWorkbenchMemory };
}

module.exports = { createMemoryTools };
