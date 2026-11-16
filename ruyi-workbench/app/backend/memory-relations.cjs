'use strict';
const { runKeyedChain } = require('./keyed-chain.cjs');
const path = require('node:path');
const fsp = require('node:fs/promises');
function createMemoryRelations({
  storage: { memoryGlobalDir, memoryProjectDir, readMemoryDir, writeMemoryMeta, atomicWriteJson },
  safeJsonParse, SKILL_ID_RE, makeId, nowIso, fmVal, logEvent, memoryIsExpired,
}) {
  const mutations = new Map();
  function locked(scopes, cwd, work) {
    const keys = [...new Set(scopes.map(scope => memoryRelationsFile(scope, cwd)))].sort();
    const enter = i => i === keys.length ? work() : runKeyedChain(mutations, keys[i], () => enter(i + 1));
    return enter(0);
  }
  function proposeMemoryRelation(rel, cwd, opts) {
    return locked([rel?.scope === 'global' ? 'global' : 'project'], cwd, () => proposeMemoryRelationUnlocked(rel, cwd, opts));
  }
  function confirmMemoryRelation(id, cwd) {
    return locked(['project', 'global'], cwd, () => confirmMemoryRelationUnlocked(id, cwd));
  }
  function deleteMemoryRelation(id, cwd) {
    return locked(['project', 'global'], cwd, () => deleteMemoryRelationUnlocked(id, cwd));
  }
  function removeMemoryRelationsFor(id, scope, cwd) {
    return locked([scope], cwd, async () => {
      const all = await readMemoryRelations(scope, cwd);
      const kept = all.filter(r => r.from !== id && r.to !== id);
      if (kept.length !== all.length) await writeMemoryRelations(scope, cwd, kept);
      return all.length - kept.length;
    });
  }
const MEMORY_RELATION_TYPES = new Set(['supports', 'contradicts', 'supersedes', 'derived_from']);
function isMemoryRelationType(type) { return MEMORY_RELATION_TYPES.has(type); }
const MEMORY_RELATION_CAP = 512; // per-scope 边数硬上限(威胁 4:防膨胀)

function memoryRelationsFile(scope, cwd) {
  return scope === 'global'
    ? path.join(memoryGlobalDir(), '_relations.json')
    : path.join(memoryProjectDir(cwd), '_relations.json');
}

// 读一个 scope 的关系数组(空文件/不存在 -> [])。不做过滤,过滤由 listMemoryRelations 按 confirmed 分桶。
async function readMemoryRelations(scope, cwd) {
  const file = memoryRelationsFile(scope, cwd);
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const arr = safeJsonParse(raw, null);
    if (!Array.isArray(arr)) return [];
    return arr.filter(r => r && typeof r === 'object' && SKILL_ID_RE.test(r.id)
      && MEMORY_RELATION_TYPES.has(r.type) && SKILL_ID_RE.test(String(r.from)) && SKILL_ID_RE.test(String(r.to)));
  } catch { return []; }
}

async function writeMemoryRelations(scope, cwd, arr) {
  const dir = scope === 'global' ? memoryGlobalDir() : memoryProjectDir(cwd);
  try { await fsp.mkdir(dir, { recursive: true }); } catch { /* 已存在 */ }
  if (scope === 'project') await writeMemoryMeta(dir, cwd);
  await atomicWriteJson(memoryRelationsFile(scope, cwd), arr);
}

// listMemoryRelations(cwd, scope, opts) -> {ok, relations, pending, confirmed}。opts.includePending=false 时
// relations 仅含 confirmed(默认,供检索/UI);true 时含全部(供提议者复核)。scope 缺省读 project。
async function listMemoryRelations(cwd, scope, opts = {}) {
  const sc = scope === 'global' ? 'global' : 'project';
  const all = await readMemoryRelations(sc, cwd);
  const confirmed = all.filter(r => r.confirmed === true);
  const pending = all.filter(r => r.confirmed !== true);
  const relations = opts.includePending ? all : confirmed;
  return { ok: true, scope: sc, relations, pending, confirmed };
}

// proposeMemoryRelation(rel, cwd) -> 创建 confirmed:false 边(模型可调)。校验:type 合法、from!=to、
// from/to 同 scope 内已存在、未超 per-scope 上限、无重复(from+to+type 已存在的 confirmed 不再重复提议)。
async function proposeMemoryRelationUnlocked(rel, cwd, opts = {}) {
  const r = (rel && typeof rel === 'object') ? rel : {};
  const type = String(r.type || '');
  if (!MEMORY_RELATION_TYPES.has(type)) return { ok: false, error: '无效的关系类型(仅 supports/contradicts/supersedes/derived_from)' };
  const from = String(r.from || '').trim();
  const to = String(r.to || '').trim();
  if (!SKILL_ID_RE.test(from) || !SKILL_ID_RE.test(to)) return { ok: false, error: 'from/to 须为合法记忆 id(字母/数字/_-,1..64)' };
  if (from === to) return { ok: false, error: 'from 与 to 不能相同' };
  const scope = r.scope === 'global' ? 'global' : 'project';
  // 隔离红线(威胁 1):from/to 必须都在该 scope 内已存在,杜绝跨 scope/幽灵 id 建边。
  const dir = scope === 'global' ? memoryGlobalDir() : memoryProjectDir(cwd);
  const reg = await readMemoryDir(dir, scope);
  if (!reg.has(from) || !reg.has(to)) return { ok: false, error: 'from 或 to 在目标 scope 内不存在(拒绝跨 scope 建边)' };
  const all = await readMemoryRelations(scope, cwd);
  if (all.length >= MEMORY_RELATION_CAP) return { ok: false, error: '该 scope 关系边已达上限 ' + MEMORY_RELATION_CAP + '(清理 pending 后重试)' };
  const dup = all.find(x => x.from === from && x.to === to && x.type === type);
  if (dup) return { ok: false, error: dup.confirmed ? '同形关系已确认,无需重复' : '同形关系已处于 pending', relation: dup };
  const id = makeId('rel'); // 117q-B2(P2-15):统一走 makeId
  const evidenceRefRaw = SKILL_ID_RE.test(String(r.evidenceRef || '')) ? String(r.evidenceRef).slice(0, 256) : '';
  // R4-S2: 自动提议路径传 opts.evidenceCatalog(= run.evidence)时,校验 evidenceRef 是否为该 run 真实 eventId。
  // API 手动提议无 catalog -> evidenceRefVerified=false(仅存档,见设计稿 §9)。
  const evidenceRefVerified = evidenceRefRaw && Array.isArray(opts && opts.evidenceCatalog)
    ? opts.evidenceCatalog.some(e => e && e.eventId === evidenceRefRaw)
    : false;
  const entry = {
    id, type, from, to, scope,
    evidenceRef: evidenceRefRaw,
    evidenceRefVerified,
    confirmed: false,
    createdAt: nowIso(),
    sourceRunId: fmVal(String(r.sourceRunId || '')).slice(0, 120),
    note: fmVal(String(r.note || '')).slice(0, 200),
  };
  all.push(entry);
  await writeMemoryRelations(scope, cwd, all);
  // 审计去向:logEvent(日志 NDJSON),【不是】 appendUsageLedger。用量台账是【费用】账本,它第一件事就是
  // 丢掉「零 token 且零费用」的行(00-boot 的空行守卫)—— 建边/确认/删边根本不调模型,写进去必被丢掉,
  // 从来没留下过任何一条(本刀修的就是这个:以为记了,其实一条没记)。logEvent 落 logs/workbench-<日>.ndjson,
  // 且 {ts, ...record} 整份摊开,所以这些字段原样保留。字段全是 id/枚举/计数 —— from/to 经 SKILL_ID_RE
  // 校验过是记忆 id 不是正文,合乎 logEvent「只记元数据,不记原文」的纪律。
  try { logEvent({ kind: 'memory_relation_propose', id, type, from, to, scope }); } catch { /* 审计失败不阻断 */ }
  return { ok: true, relation: entry };
}

// confirmMemoryRelation(id, cwd) -> confirmed:false->true(仅用户调)。只置标志,不改 from/to/type/scope(威胁 7)。
// 跨 scope 查找:project 找不到再查 global(用户确认时不必区分 scope,但改写仍落回原 scope 文件)。
async function confirmMemoryRelationUnlocked(id, cwd) {
  if (!SKILL_ID_RE.test(String(id || ''))) return { ok: false, error: '无效的关系 id' };
  for (const scope of ['project', 'global']) {
    const all = await readMemoryRelations(scope, cwd);
    const idx = all.findIndex(x => x.id === id);
    if (idx < 0) continue;
    if (all[idx].confirmed === true) return { ok: false, error: '该关系已确认', relation: all[idx] };
    all[idx].confirmed = true; // 仅此一字段;其余忽略(防偷换)
    await writeMemoryRelations(scope, cwd, all);
    try { logEvent({ kind: 'memory_relation_confirm', id, scope }); } catch { /* 审计失败不阻断 */ }
    return { ok: true, relation: all[idx] };
  }
  return { ok: false, error: '关系不存在' };
}

// deleteMemoryRelation(id, cwd) -> 删边(仅用户调)。跨 scope 查找同 confirm。
async function deleteMemoryRelationUnlocked(id, cwd) {
  if (!SKILL_ID_RE.test(String(id || ''))) return { ok: false, error: '无效的关系 id' };
  for (const scope of ['project', 'global']) {
    const all = await readMemoryRelations(scope, cwd);
    const idx = all.findIndex(x => x.id === id);
    if (idx < 0) continue;
    const removed = all.splice(idx, 1)[0];
    await writeMemoryRelations(scope, cwd, all);
    try { logEvent({ kind: 'memory_relation_delete', id, scope, type: removed.type }); } catch { /* 审计失败不阻断 */ }
    return { ok: true, relation: removed };
  }
  return { ok: false, error: '关系不存在' };
}

// buildMemoryConflictMap(cwd) -> Map<memoryId, Set<conflictId>>。仅 confirmed contradicts;pending 不计入(威胁 6)。
// 两端记忆都进入 map(双向),供 buildMemoryPromptSection 标记。global 与 project 分别读后合并。
//
// #16:同一张 map 上再挂一个不可枚举的 supersededBy(Map<'scope:id', Set<取代者 id>>),只含 confirmed supersedes、且取代者仍存在且未过期的边。
// 挂在这张 map 上而不是另开返回值,是因为 05 / 06 / 09 三个调用点都已经把它一路传进 buildMemoryPromptSection,不必逐个改签名;
// 手写的普通 Map(夹具/旧测试)没有这个属性,读的一侧按「无标记」处理。
async function buildMemoryConflictMap(cwd) {
  const map = new Map();
  const add = (a, b) => { if (!map.has(a)) map.set(a, new Set()); map.get(a).add(b); };
  const supersedeEdges = [];
  for (const scope of ['project', 'global']) {
    const all = await readMemoryRelations(scope, cwd);
    for (const r of all) {
      if (r.confirmed !== true) continue;
      if (r.type === 'contradicts') { add(r.from, r.to); add(r.to, r.from); }
      else if (r.type === 'supersedes' && r.from !== r.to) supersedeEdges.push({ scope, from: r.from, to: r.to });
    }
  }
  let supersededBy = new Map();
  if (supersedeEdges.length) {
    // 取代者必须真的还在(删了的记忆不能让旧版本「被一条不存在的记忆取代」):只在确有 supersedes 边时才读目录头。
    const byKey = new Map();
    for (const scope of new Set(supersedeEdges.map(e => e.scope))) {
      const dir = scope === 'global' ? memoryGlobalDir() : memoryProjectDir(cwd);
      for (const [id, entry] of await readMemoryDir(dir, scope).catch(() => new Map())) byKey.set(scope + ':' + id, { ...entry, scope, id });
    }
    supersededBy = memoryValidSupersededBy(supersedeEdges, byKey);
  }
  Object.defineProperty(map, 'supersededBy', { value: supersededBy, enumerable: false });
  return map;
}

// 只取 confirmed 的 supersedes 边(pending 不计,同冲突图的纪律)。关系按 scope 隔离,所以 key 带 scope。
async function readConfirmedSupersedeEdges(cwd) {
  const out = [];
  for (const scope of ['project', 'global']) {
    for (const r of await readMemoryRelations(scope, cwd)) {
      if (r.confirmed === true && r.type === 'supersedes' && r.from !== r.to) out.push({ scope, from: r.from, to: r.to });
    }
  }
  return out;
}
// 边 → Map<'scope:被取代者', Set<取代者 id>>;byKey 是 'scope:id' → 注册表条目。取代者不存在 / 已过期 / 被取代者不存在的边丢弃。
function memoryValidSupersededBy(edges, byKey) {
  const out = new Map();
  for (const edge of (Array.isArray(edges) ? edges : [])) {
    const from = byKey.get(edge.scope + ':' + edge.from);
    const to = byKey.get(edge.scope + ':' + edge.to);
    if (!from || !to || memoryIsExpired(from)) continue;
    const key = edge.scope + ':' + edge.to;
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(edge.from);
  }
  return out;
}

// extractMemoryRelationProposals(structuredResult, run) -> 纯函数:从 gate 节点结构化输出提取记忆关系提议。
// 只做提取+基础过滤(type 合法、from/to 合法 id、from!=to);不落盘、不校验记忆是否存在(由 proposeMemoryRelation 负责)。
// 返回 [{type, from, to, evidenceRef, note, sourceRunId, scope}](scope 默认 project;sourceRunId 取 run.id)。
// 09-workflow 节点收尾时调用,逐项 proposeMemoryRelation(confirmed:false),用户后续确认。
function extractMemoryRelationProposals(structuredResult, run) {
  const sr = (structuredResult && typeof structuredResult === 'object') ? structuredResult : null;
  const raw = Array.isArray(sr && sr.memoryRelations) ? sr.memoryRelations : [];
  const runId = (run && typeof run.id === 'string') ? run.id : '';
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '');
    if (!MEMORY_RELATION_TYPES.has(type)) continue;
    const from = String(item.from || '').trim();
    const to = String(item.to || '').trim();
    if (!SKILL_ID_RE.test(from) || !SKILL_ID_RE.test(to) || from === to) continue;
    const evidenceRef = SKILL_ID_RE.test(String(item.evidenceRef || '')) ? String(item.evidenceRef).slice(0, 256) : '';
    out.push({
      type, from, to, evidenceRef,
      note: fmVal(String(item.note || '')).slice(0, 200),
      sourceRunId: runId,
      scope: 'project',
    });
  }
  return out.slice(0, 20); // schema maxItems=20 兜底
}

  return { isMemoryRelationType, memoryRelationsFile, readMemoryRelations, listMemoryRelations, proposeMemoryRelation, confirmMemoryRelation, deleteMemoryRelation, buildMemoryConflictMap, readConfirmedSupersedeEdges, memoryValidSupersededBy, extractMemoryRelationProposals, removeMemoryRelationsFor };
}
module.exports = { createMemoryRelations };
