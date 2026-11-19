'use strict';

const { CLAUDE_ENDPOINT_PRESETS } = require('./provider-pricing.cjs');

function emptyUsageTotals() {
  return { inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, subagentTurns: 0, auxCalls: 0,
    estimatedTurns: 0, planBasedTurns: 0, costsByCurrency: {} };
}

function usageSummaryPayload(range, totals = emptyUsageTotals(), {
  byEngine = [], byProvider = [], byModel = [], bySession = [], byDay = [], budget = null,
} = {}) {
  return { ok: true, range, totals, byEngine, byProvider, byModel, bySession, byDay, budget };
}

function createUsageSummary({ readConfig, readSessionTitles, forEachUsageRow, usageRangeLowerMs, usageDayKeyMemo }) {
  // Aggregate the ledger for a range into the /api/usage/summary shape. costsByCurrency holds ONLY trusted,
  // non-plan-based costs; planBasedTurns counts turns whose cost is plan-based/notional (surfaced separately).
  // Dimensions: engine / provider / session / day / model (117x-M1 added byModel; see its comment in the loop).
  return async function buildUsageSummary(range) {
    const config = await readConfig().catch(() => ({}));
    const now = Date.now();
    // provider/source id -> display label (native providers + Claude direct + known Claude endpoints).
    const labels = new Map([['claude-cli', 'Claude CLI (Anthropic)']]);
    for (const p of (Array.isArray(config.providers) ? config.providers : [])) if (p && p.id) labels.set(String(p.id), String(p.label || p.id));
    for (const p of CLAUDE_ENDPOINT_PRESETS) if (p && p.id) labels.set(String(p.id), String(p.label || p.id));
    const titles = await readSessionTitles().catch(() => new Map());

    const addCost = (bucket, cur, cost) => { bucket[cur] = (bucket[cur] || 0) + cost; };
    const totals = emptyUsageTotals();
    const byEngine = new Map(), byProvider = new Map(), bySession = new Map(), byDay = new Map(), byModel = new Map();
    const dayKeyOf = usageDayKeyMemo();
    const modelKeys = new Map();   // eng -> pid -> mid -> JSON 键(每个三元组只 stringify 一次)
    const modelKeyOf = (eng, pid, mid) => {
      let byPid = modelKeys.get(eng); if (!byPid) modelKeys.set(eng, byPid = new Map());
      let byMid = byPid.get(pid); if (!byMid) byPid.set(pid, byMid = new Map());
      let key = byMid.get(mid); if (key === undefined) byMid.set(mid, key = JSON.stringify([eng, pid, mid]));
      return key;
    };

    await forEachUsageRow(usageRangeLowerMs(range, now), r => {
      const inTok = Number(r.inTok) || 0, outTok = Number(r.outTok) || 0, cachedInTok = Math.min(inTok, Number(r.cachedInTok) || 0);
      const cost = Number(r.cost), cur = (typeof r.currency === 'string' && r.currency) ? r.currency : null;
      const trusted = r.costTrusted !== false;
      const hasCost = trusted && cur && Number.isFinite(cost);
      totals.inTok += inTok; totals.outTok += outTok; totals.cachedInTok += cachedInTok; totals.turns += 1;
      if (r.kind === 'subagent') totals.subagentTurns += 1; // v1.4-OSS 用量看板(补): DAG/子代理回合独立计数
      if (r.kind === 'aux') totals.auxCalls += 1; // v1.4-OSS 用量看板(补): 辅助调用(压缩/起草等)独立计数
      if (r.estimated === true) totals.estimatedTurns += 1;
      if (!trusted) totals.planBasedTurns += 1;
      if (hasCost) addCost(totals.costsByCurrency, cur, cost);
      const eng = r.engine === 'claude' ? 'claude' : 'openai';
      let em = byEngine.get(eng); if (!em) byEngine.set(eng, em = { engine: eng, inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, planBasedTurns: 0, costsByCurrency: {} });
      em.inTok += inTok; em.outTok += outTok; em.cachedInTok += cachedInTok; em.turns += 1; if (!trusted) em.planBasedTurns += 1; if (hasCost) addCost(em.costsByCurrency, cur, cost);
      const pid = String(r.provider || '');
      let pm = byProvider.get(pid); if (!pm) byProvider.set(pid, pm = { provider: pid, label: labels.get(pid) || pid, inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, planBasedTurns: 0, costsByCurrency: {} });
      pm.inTok += inTok; pm.outTok += outTok; pm.cachedInTok += cachedInTok; pm.turns += 1; if (!trusted) pm.planBasedTurns += 1; if (hasCost) addCost(pm.costsByCurrency, cur, cost);
      const sid = String(r.sessionId || '');
      let sm = bySession.get(sid); if (!sm) bySession.set(sid, sm = { sessionId: sid, title: titles.get(sid) || '', inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, planBasedTurns: 0, costsByCurrency: {} });
      sm.inTok += inTok; sm.outTok += outTok; sm.cachedInTok += cachedInTok; sm.turns += 1; if (!trusted) sm.planBasedTurns += 1; if (hasCost) addCost(sm.costsByCurrency, cur, cost);
      const tsMs = r.tsMs;
      const dk = dayKeyOf(tsMs);
      let dm = byDay.get(dk); if (!dm) byDay.set(dk, dm = { date: dk, inTok: 0, outTok: 0, cachedInTok: 0, costsByCurrency: {} });
      dm.inTok += inTok; dm.outTok += outTok; dm.cachedInTok += cachedInTok; if (hasCost) addCost(dm.costsByCurrency, cur, cost);
      // 117x-M1: byModel. Keyed by the (engine, provider, model) TRIPLE, not by model id alone: the same id can be
      // served by two providers, and collapsing them would force us to invent one provider/engine for the entry.
      // Rows whose `model` is empty are SKIPPED entirely (NOT bucketed into a "未记录模型" group): byModel exists to
      // drive the model selector's 常用置顶/副行, and an entry with no id can neither be selected nor pinned — 设计页
      // §11.17.7 ④ spells it out: 「把 model 字段删掉 -> 该条不进 byModel 而不是记成空串」. Consequence (and the
      // invariant its lock pins): sum(byModel.turns) === sum(byEngine.turns) - (rows carrying an empty model).
      // Everything else reuses the exact same 口径 as the four dimensions above (addCost/roundB/finishGroup), so a
      // model entry's planBased flag and costsByCurrency mean precisely what a provider entry's do.
      const mid = String(r.model || '');
      if (mid) {
        const mk = modelKeyOf(eng, pid, mid); // JSON-array key: unambiguous whatever characters an id carries
        let mm = byModel.get(mk);
        if (!mm) byModel.set(mk, mm = { model: mid, provider: pid, label: labels.get(pid) || pid, engine: eng, inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, planBasedTurns: 0, costsByCurrency: {}, lastAt: '', lastMs: 0, lastTsRaw: undefined });
        mm.inTok += inTok; mm.outTok += outTok; mm.cachedInTok += cachedInTok; mm.turns += 1; if (!trusted) mm.planBasedTurns += 1; if (hasCost) addCost(mm.costsByCurrency, cur, cost);
        // lastAt = the ts of this group's MOST RECENT ledger row, kept as that row's own ISO string so it reads
        // exactly like the `ts` on the line it came from (设计页 §11.17.2「常用」按最近一次使用时间排序). A row whose
        // ts does not parse is ignored FOR lastAt ONLY — it still counts in this entry's tokens/turns — so lastAt can
        // never become 'Invalid Date'/NaN; a group with no parseable ts at all keeps the empty string. (readUsageRows
        // already drops unparseable-ts rows before we get here, so this is defence in depth, not a live path.)
        // 性能批 P1:只记最大时刻与那一行的原串(没有原串 = 规范写法),收尾再成串 —— 与逐行 String(r.ts) 结果相同。
        if (Number.isFinite(tsMs) && tsMs > mm.lastMs) { mm.lastMs = tsMs; mm.lastTsRaw = r.tsRaw; }
      }
    });
    // Round every currency bucket to 6 dp to shed binary-float noise (0.30000000000000004 -> 0.3), and derive a
    // per-entry planBased flag: true ONLY when the entry has plan-based turns AND no trusted cost to show (so a
    // mixed entry that still has a real cost keeps showing it, and the front-end can honestly badge 计划内计费).
    const round6 = n => Math.round((Number(n) || 0) * 1e6) / 1e6;
    const roundB = b => { for (const k of Object.keys(b)) b[k] = round6(b[k]); return b; };
    const finishGroup = m => { roundB(m.costsByCurrency); m.planBased = m.planBasedTurns > 0 && Object.keys(m.costsByCurrency).length === 0; };
    roundB(totals.costsByCurrency);
    for (const m of byEngine.values()) finishGroup(m);
    for (const m of byProvider.values()) finishGroup(m);
    for (const m of bySession.values()) finishGroup(m);
    for (const m of byModel.values()) finishGroup(m); // same 口径 as the three groups above, deliberately not a second one
    for (const m of byDay.values()) roundB(m.costsByCurrency);

    // Budget: CURRENT local month's TRUSTED spend in the budget currency (independent of `range`).
    let budget = null;
    const ub = config.usageBudget;
    if (ub && typeof ub === 'object' && Number(ub.monthly) > 0 && typeof ub.currency === 'string' && ub.currency) {
      let spent = 0;
      await forEachUsageRow(usageRangeLowerMs('month', now), r => { const c = Number(r.cost); if (r.costTrusted !== false && r.currency === ub.currency && Number.isFinite(c)) spent += c; });
      budget = { monthly: Number(ub.monthly), currency: ub.currency, spentThisMonth: round6(spent) };
    }
    return usageSummaryPayload(range, totals, {
      byEngine: [...byEngine.values()],
      byProvider: [...byProvider.values()],
      // 117x-M1: most-recently-used first (lastAt desc), then busier first, then model id — a total order, so the
      // payload never silently depends on Map insertion order. NOT sliced, unlike bySession: the selector shows a
      // 「上次用 · 共 M 回合」副行 for EVERY model it lists, and a slice would both starve that副行 and break the
      // sum(byModel.turns) === sum(byEngine.turns) - empty-model-rows invariant. lastMs is scratch, stripped here.
      byModel: [...byModel.values()]
        .sort((a, b) => (b.lastMs - a.lastMs) || (b.turns - a.turns) || (a.model < b.model ? -1 : (a.model > b.model ? 1 : 0)))
        .map(({ lastMs, lastTsRaw, ...rest }) => ({ ...rest, lastAt: lastMs > 0 ? String(lastTsRaw !== undefined ? lastTsRaw : new Date(lastMs).toISOString()) : rest.lastAt })),
      bySession: [...bySession.values()].sort((a, b) => (b.inTok + b.outTok) - (a.inTok + a.outTok)).slice(0, 20),
      byDay: [...byDay.values()].sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)),
      budget,
    });
  };
}

module.exports = { createUsageSummary, usageSummaryPayload };
