'use strict';

const { normalizeCwd } = require('./path-containment.cjs');
const { coreMemoryMaxItems, coreMemoryCharBudget, memoryFixedSelectionMax, memoryRelevanceMax } = require('./runtime-policy.cjs');
const { filterMemoryForNativeCli } = require('./agent-instruction-imports.cjs');

const MEMORY_EXCLUSION_MAX = 256;

function memorySelectionSignature(session, cwd) {
  return JSON.stringify([normalizeCwd(session?.cwd || cwd), session?.turnSeq, session?.memoriesExplicit === true,
    session?.memories || [], session?.memoryExclusions || []]);
}

function createMemorySelection({ store, prompts, recall, relations, readConfig }) {
  const { loadMemoryRegistry, readMemoryUsageState, memoryUsageKey, projectKeyForCwd, memoryReviewDue, memoryIsExpired, touchMemoryUsage } = store;
  const { memoryCoreLine } = prompts;
  const { memoryRetrievalKey, rankMemoriesForRecallDetailed } = recall;
  const { readConfirmedSupersedeEdges, memoryValidSupersededBy } = relations;

  // 受保护 LRU：只决定哪些 core=true 条目进入本轮基础胶囊，绝不删除或改写原记忆。重要标记提供近似
  // “不可误逐出”的百年 recency 加成；偏好/惯例提供 90 天保护，且实际进入提示词后每天计一次 use；
  // 项目记忆与被频繁使用的条目获得小幅加成。这样规则不会因纯时间轻易掉出，但近期真正被读取的教训仍可流动晋级。
  function memoryCoreScore(entry) {
    const last = Date.parse(String(entry.lastUsedAt || entry.updatedAt || entry.createdAt || ''));
    let score = Number.isFinite(last) ? last : 0;
    if (entry.importance === 'important') score += 36500 * 86400000;
    if (entry.type === 'preference' || entry.type === 'convention') score += 90 * 86400000;
    else if (entry.type === 'lesson') score += 21 * 86400000;
    if (entry.scope === 'project') score += 7 * 86400000;
    score += Math.min(30, Math.log2(1 + Math.max(0, Number(entry.useCount) || 0)) * 4) * 86400000;
    if (entry.reviewDue) score -= 7 * 86400000; // 到期复核不等于失效，只降低一点自动常驻优先级
    return score;
  }

  async function resolveCoreMemoryState(cwd, registry, config = null) {
    const itemLimit = coreMemoryMaxItems(config);
    const charLimit = coreMemoryCharBudget(config);
    const memories = Array.isArray(registry) ? registry : await loadMemoryRegistry(cwd);
    const usage = await readMemoryUsageState();
    const nowMs = Date.now();
    const enriched = memories.map(entry => {
      const used = usage.entries[memoryUsageKey(entry, cwd)] || {};
      return { ...entry, useCount: Math.max(0, Math.floor(Number(used.useCount) || 0)), lastUsedAt: used.lastUsedAt || '',
        reviewDue: memoryReviewDue(entry, nowMs), expired: memoryIsExpired(entry, nowMs) };
    });
    const candidates = enriched.filter(entry => entry.core && !entry.expired).sort((a, b) => memoryCoreScore(b) - memoryCoreScore(a)
      || String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))
      || String(a.id).localeCompare(String(b.id)));
    const active = [], standby = [];
    let charsUsed = 0;
    for (const entry of candidates) {
      const chars = memoryCoreLine(entry).length + (active.length ? 1 : 0);
      if (active.length < itemLimit && charsUsed + chars <= charLimit) {
        active.push(entry); charsUsed += chars;
      } else standby.push(entry);
    }
    const activeKeys = new Set(active.map(e => e.scope + ':' + e.id));
    const standbyKeys = new Set(standby.map(e => e.scope + ':' + e.id));
    const all = enriched.map(entry => ({ ...entry,
      coreStatus: entry.expired && entry.core ? 'expired' : (activeKeys.has(entry.scope + ':' + entry.id) ? 'active' : (standbyKeys.has(entry.scope + ':' + entry.id) ? 'standby' : 'library')),
    }));
    return {
      all,
      active: all.filter(entry => entry.coreStatus === 'active'),
      standby: all.filter(entry => entry.coreStatus === 'standby'),
      expired: all.filter(entry => entry.coreStatus === 'expired'),
      stats: {
        total: all.length, coreRequested: all.filter(entry => entry.core).length, active: active.length, standby: standby.length,
        expired: all.filter(entry => entry.expired).length, reviewDue: all.filter(entry => entry.reviewDue).length,
        charsUsed, charLimit, itemLimit,
      },
    };
  }

  function memoryExclusionSet(session, cwd) {
    const curKey = projectKeyForCwd(cwd);
    const out = new Set();
    for (const raw of (Array.isArray(session && session.memoryExclusions) ? session.memoryExclusions : []).slice(0, MEMORY_EXCLUSION_MAX)) {
      const id = String((raw && raw.id) || '').trim();
      if (!id) continue;
      const scope = raw && raw.scope === 'global' ? 'global' : 'project';
      if (scope === 'project' && raw.projectKey && String(raw.projectKey) !== curKey) continue;
      out.add(scope + ':' + id);
    }
    return out;
  }

  // 会话启用选择:显式设置过(memoriesExplicit)→ 固定使用 session.memories(≤8)；否则项目 + 全局均默认
  // 进入元数据相关性检索，memoryExclusions 仅排除当前会话明确关闭的条目。
  function effectiveMemorySelection(session, registry, cwd) {
    if (session && session.memoriesExplicit === true) {
      return (Array.isArray(session.memories) ? session.memories : [])
        .map(m => {
          const id = String((m && m.id) || '').trim();
          const scope = (m && m.scope === 'global') ? 'global' : 'project';
          const o = { id, scope };
          // P3-3: 透传 project 条目锁定的 projectKey(供 resolveEnabledMemoryEntries 换 cwd 失配校验);global 无此概念。
          if (scope === 'project' && m && m.projectKey) o.projectKey = String(m.projectKey);
          return o;
        })
        .filter(m => m.id);
    }
    const excluded = memoryExclusionSet(session, cwd);
    return (Array.isArray(registry) ? registry : [])
      .filter(e => e && e.id && !excluded.has(e.scope + ':' + e.id))
      .map(e => ({ id: e.id, scope: e.scope === 'global' ? 'global' : 'project' }));
  }

  // Shared eligibility for automatic preflight and active list/read; ranking remains caller-specific.
  function eligibleMemoryEntries(session, registry, cwd, config, onSourceMismatch) {
    const explicit = !!(session && session.memoriesExplicit === true);
    const fixedSelectionMax = memoryFixedSelectionMax(config);
    const sel = effectiveMemorySelection(session, registry, cwd);
    const curKey = projectKeyForCwd(cwd);
    const byKey = new Map(registry.map(e => [e.scope + ':' + e.id, e]));
    const eligible = [];
    const seen = new Set();
    for (const s of sel) {
      const key = s.scope + ':' + s.id;
      if (seen.has(key)) continue;
      // P3-3: project 条目锁定「启用当时的 projectKey」。换了项目目录(当前 cwd 的 projectKey 与之不符)→ 跳过注入并
      // 通知一次(即便当前项目恰有同 id 记忆也不顶替,防调包)。空 projectKey = 旧数据宽松匹配(下次保存固化)。
      if (s.scope === 'project' && s.projectKey && s.projectKey !== curKey) {
        seen.add(key);
        if (typeof onSourceMismatch === 'function') { try { onSourceMismatch(s.id, s.projectKey, curKey); } catch { /* 通知失败不阻断 */ } }
        continue;
      }
      const e = byKey.get(key);
      if (!e) continue; // 幽灵 / scope 不匹配 → 跳过注入
      seen.add(key);
      if (!memoryIsExpired(e)) eligible.push(e);
      if (explicit && eligible.length >= fixedSelectionMax) break;
    }
    return eligible;
  }

  async function resolveMemoryPreflight(session, cwd, query, onSourceMismatch, config = null, options = {}) {
    let registry = [];
    try { registry = await loadMemoryRegistry(cwd); } catch {
      return { entries: [], coreEntries: [], status: { mode: 'unavailable', enabled: true, checked: false, candidateCount: 0, matchCount: 0, projectMatches: 0, globalMatches: 0, excludedCount: 0, coreActiveCount: 0 } };
    }
    // 容量五旋钮都要读配置，所以在函数头就解一次（调用方传了就不重复读盘）。
    const effectiveConfig = config || await readConfig().catch(() => null);
    const explicit = !!(session && session.memoriesExplicit === true);
    const exclusions = explicit ? new Set() : memoryExclusionSet(session, cwd);
    const sel = effectiveMemorySelection(session, registry, cwd);
    if (explicit && !sel.length) {
      return { entries: [], coreEntries: [], status: { mode: 'disabled', enabled: false, checked: false, candidateCount: 0, matchCount: 0, projectMatches: 0, globalMatches: 0, excludedCount: 0, coreActiveCount: 0 } };
    }
    const byKey = new Map(registry.map(e => [e.scope + ':' + e.id, e]));
    const eligible = eligibleMemoryEntries(session, registry, cwd, effectiveConfig, onSourceMismatch);
    const nativeCli = options && options.cliType ? String(options.cliType) : '';
    if (nativeCli) {
      const kept = filterMemoryForNativeCli(eligible, nativeCli);
      eligible.length = 0;
      eligible.push(...kept);
    }
    const coreState = await resolveCoreMemoryState(cwd, eligible, effectiveConfig);
    const coreEntries = coreState.active;
    const coreKeys = new Set(coreEntries.map(e => e.scope + ':' + e.id));
    // hunt2-mcp:相关记忆在【去掉已激活核心之后】的候选里排 Top-N。修前先在含核心的全集里取 Top-N、再滤核心,
    // 核心条目恰好最相关时名额全被它们占掉,related 变成空,而明明还有匹配的非核心记忆。
    const nonCore = eligible.filter(e => !coreKeys.has(e.scope + ':' + e.id));
    let entries, fillKeys = new Set();
    if (explicit) entries = nonCore; // 固定选择不走排序，向量开关对它本来就不适用
    else {
      const recalled = rankMemoriesForRecallDetailed(nonCore, query, memoryRelevanceMax(effectiveConfig), effectiveConfig);
      entries = recalled.entries; fillKeys = recalled.fillKeys;
      // #16 supersedes 的运行时效果:被 confirmed supersedes 指向的条目 —— 取代者已在本轮注入(核心或相关)就不再重复注入旧版本;
      // 取代者没进本轮则旧版本排到末尾(降权)并在索引行上标「[已被 X 取代]」。固定选择(explicit)是用户的明确选择,只标注、不增删。
      if (entries.length) {
        const supersededBy = memoryValidSupersededBy(await readConfirmedSupersedeEdges(cwd).catch(() => []), byKey);
        if (supersededBy.size) {
          const present = new Set([...coreEntries, ...entries].map(memoryRetrievalKey));
          const kept = [], demoted = [];
          for (const e of entries) {
            const by = supersededBy.get(memoryRetrievalKey(e));
            if (!by) { kept.push(e); continue; }
            // 互相取代(环)时不能两条都丢:取代者只有「仍在本轮名单里」才算数,按序判定。
            if ([...by].some(id => present.has(e.scope + ':' + id) && id !== e.id)) present.delete(memoryRetrievalKey(e));
            else demoted.push(e);
          }
          entries = kept.concat(demoted);
        }
      }
    }
    await Promise.all([
      touchMemoryUsage(entries, cwd, 'relevant'),
      touchMemoryUsage(coreEntries.filter(e => e.type === 'preference' || e.type === 'convention'), cwd, 'core-rule'),
    ]).catch(() => {});
    return {
      entries, coreEntries,
      status: {
        mode: explicit ? 'fixed' : 'default', enabled: true, checked: true,
        // matchCount 只数真命中;零命中的 preference/convention 默认规则补位另报(ruleFillCount),
        // 修前补位也算「额外匹配」,一句无关的话也报「匹配 1 条」。
        candidateCount: eligible.length, matchCount: entries.filter(e => !fillKeys.has(memoryRetrievalKey(e))).length,
        ruleFillCount: entries.filter(e => fillKeys.has(memoryRetrievalKey(e))).length,
        projectMatches: entries.filter(e => e.scope === 'project' && !fillKeys.has(memoryRetrievalKey(e))).length,
        globalMatches: entries.filter(e => e.scope === 'global' && !fillKeys.has(memoryRetrievalKey(e))).length,
        excludedCount: exclusions.size,
        coreActiveCount: coreEntries.length,
      },
    };
  }

  return { memoryExclusionSet, eligibleMemoryEntries, resolveCoreMemoryState, resolveMemoryPreflight };
}

module.exports = { MEMORY_EXCLUSION_MAX, createMemorySelection, memorySelectionSignature };
