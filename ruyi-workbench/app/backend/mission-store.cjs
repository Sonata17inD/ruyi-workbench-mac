'use strict';
const path = require('node:path');
const fsp = require('node:fs/promises');
function createMissionStore({ paths, safeSessionId, makeId, nowIso, logEvent, runKeyedChain, atomicWriteJson }) {
const MISSIONS_DIR_NAME = 'missions';
const MISSION_CONTAINER_SCHEMA = 1;
// 容量:事项文件数硬上限。超出后拒绝【新建】(合并/拆分里的新建同样受限),既有事项照常读写。
// 2000 个事项 ≈ 每天新建一个连续跑五年半,真到了这个量级该做的是归档而不是继续堆文件。
const MISSION_CONTAINER_MAX_FILES = 2000;
const MISSION_CONTAINER_LIMITS = Object.freeze({
  titleChars: 120, goalChars: 2000, acceptanceItems: 50, acceptanceItemChars: 300,
  sessionIds: 500, currencyChars: 12,
});

function missionsDir() { return path.join(paths.data, MISSIONS_DIR_NAME); }
function missionContainerPath(missionId) { return path.join(missionsDir(), missionId + '.json'); }
// 事项 id 与会话 id 同一字符集(safeSessionId 是全仓唯一那道消毒),新建时取 `mission_<hex>` 前缀 ——
// 与 `sess_` 分开,好在日志里一眼认出;13e 的投影扫描只认 `sess_*.json`,故事项文件天然不进投影。
function safeMissionId(raw) { return safeSessionId(raw); }

function missionClipText(value, max) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

// 验收项 id 稳定:调用方给了就沿用(PATCH 按 id 定位),没给才生成。
function normalizeMissionAcceptance(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of rows) {
    if (out.length >= MISSION_CONTAINER_LIMITS.acceptanceItems) break;
    const source = (item && typeof item === 'object') ? item : { text: item };
    const acceptanceText = missionClipText(source.text, MISSION_CONTAINER_LIMITS.acceptanceItemChars);
    if (!acceptanceText) continue;
    let id = missionClipText(source.id, 64).replace(/[^A-Za-z0-9_-]/g, '');
    if (!id || seen.has(id)) id = makeId('acc');
    seen.add(id);
    const done = source.done === true;
    const row = { id, text: acceptanceText, done };
    if (done) row.doneAt = source.doneAt ? String(source.doneAt).slice(0, 40) : nowIso();
    out.push(row);
  }
  return out;
}

function normalizeMissionBudget(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const budget = {};
  const maxCost = Number(src.maxCost);
  if (Number.isFinite(maxCost) && maxCost >= 0) budget.maxCost = Math.round(maxCost * 1e6) / 1e6;
  const currency = missionClipText(src.currency, MISSION_CONTAINER_LIMITS.currencyChars).toUpperCase();
  if (currency) budget.currency = currency;
  return budget;
}

function normalizeMissionContainer(raw, fallbackId) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const missionId = safeMissionId(src.missionId) || safeMissionId(fallbackId);
  if (!missionId) return null;
  const sessionIds = [];
  for (const value of (Array.isArray(src.sessionIds) ? src.sessionIds : [])) {
    if (sessionIds.length >= MISSION_CONTAINER_LIMITS.sessionIds) break;
    const sid = safeSessionId(value);
    if (sid && !sessionIds.includes(sid)) sessionIds.push(sid);
  }
  const record = {
    schema: MISSION_CONTAINER_SCHEMA,
    missionId,
    title: missionClipText(src.title, MISSION_CONTAINER_LIMITS.titleChars),
    goal: String(src.goal == null ? '' : src.goal).slice(0, MISSION_CONTAINER_LIMITS.goalChars),
    acceptance: normalizeMissionAcceptance(src.acceptance),
    budget: normalizeMissionBudget(src.budget),
    cwd: String(src.cwd == null ? '' : src.cwd).slice(0, 400),
    createdAt: String(src.createdAt || nowIso()).slice(0, 40),
    updatedAt: String(src.updatedAt || nowIso()).slice(0, 40),
    sessionIds,
  };
  if (src.archivedAt) record.archivedAt = String(src.archivedAt).slice(0, 40);
  return record;
}

// 损坏隔离:整份 rename 成 `<id>.json.corrupt`(不是 copy —— 留在原地会让下一次读再隔离一次,而且
// 会一直把这个事项报成「存在但读不出」)。隔离之后该 missionId 立刻退化成「未归类派生视图」,反向
// 索引从会话头 `missionId` 重建,不需要任何修复流程。
async function readMissionContainer(missionId) {
  const id = safeMissionId(missionId);
  if (!id) return null;
  const file = missionContainerPath(id);
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); } catch { return null; }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const schemaOk = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && (parsed.schema === undefined || parsed.schema === MISSION_CONTAINER_SCHEMA);
  const normalized = schemaOk ? normalizeMissionContainer(parsed, id) : null;
  if (!normalized || !normalized.title) {
    await fsp.rename(file, file + '.corrupt').catch(() => {});
    logEvent({ kind: 'mission_container_quarantined', missionId: id });
    return null;
  }
  return normalized;
}

// 每事项一条写链(先例:02 的 sessionWriteChains)。读-改-写全部在链内做,防两个路由并发把 sessionIds 写丢。
const missionContainerChains = new Map();
function withMissionContainerLock(missionId, work) {
  return runKeyedChain(missionContainerChains, String(missionId || ''), work);
}

async function writeMissionContainer(record) {
  const normalized = normalizeMissionContainer(record, record && record.missionId);
  if (!normalized) throw new Error('invalid mission container');
  normalized.updatedAt = nowIso();
  await fsp.mkdir(missionsDir(), { recursive: true });
  await atomicWriteJson(missionContainerPath(normalized.missionId), JSON.stringify(normalized, null, 2));
  return normalized;
}

async function listMissionContainerIds() {
  const files = await fsp.readdir(missionsDir()).catch(() => []);
  return files.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(id => safeMissionId(id));
}

async function listMissionContainers() {
  const ids = await listMissionContainerIds();
  const out = [];
  for (const id of ids) {
    const record = await readMissionContainer(id);
    if (record) out.push(record);
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

// 稳定信封:所有事项写操作统一返回 { ok:true, mission } 或 { ok:false, error, message }。
function missionContainerFail(error, message, extra) {
  const envelope = { ok: false, error: error, message: String(message || error) };
  return extra ? Object.assign(envelope, extra) : envelope;
}

async function createMissionContainer(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const existing = await listMissionContainerIds();
  if (existing.length >= MISSION_CONTAINER_MAX_FILES) {
    return missionContainerFail('capacity_exceeded',
      'mission store is full (' + existing.length + '/' + MISSION_CONTAINER_MAX_FILES + '); archive or merge existing missions before creating another',
      { limit: MISSION_CONTAINER_MAX_FILES, count: existing.length });
  }
  const title = missionClipText(src.title, MISSION_CONTAINER_LIMITS.titleChars);
  if (!title) return missionContainerFail('invalid_request', 'title is required');
  const mission = await writeMissionContainer({
    missionId: makeId('mission'),
    title,
    goal: src.goal,
    acceptance: src.acceptance,
    budget: src.budget,
    cwd: src.cwd,
    createdAt: nowIso(),
    sessionIds: Array.isArray(src.sessionIds) ? src.sessionIds : [],
  });
  logEvent({ kind: 'mission_container_created', missionId: mission.missionId, title: mission.title });
  return { ok: true, mission };
}

// PATCH 只认四个事项级字段。acceptance 的 id 稳定:传回来的项带 id 就按 id 更新(勾选 done 就是这么
// 用的),不带 id 的是新项;传 acceptance 即整表替换(客户端拿到的就是整表,回传整表最不歧义)。
async function patchMissionContainer(missionId, patch) {
  const id = safeMissionId(missionId);
  if (!id) return missionContainerFail('invalid_request', 'invalid missionId');
  const p = (patch && typeof patch === 'object') ? patch : {};
  return withMissionContainerLock(id, async () => {
    const current = await readMissionContainer(id);
    if (!current) return missionContainerFail('not_found', 'mission ' + id + ' not found');
    const next = Object.assign({}, current);
    if (Object.prototype.hasOwnProperty.call(p, 'title')) {
      const title = missionClipText(p.title, MISSION_CONTAINER_LIMITS.titleChars);
      if (!title) return missionContainerFail('invalid_request', 'title must not be empty');
      next.title = title;
    }
    if (Object.prototype.hasOwnProperty.call(p, 'goal')) next.goal = p.goal;
    if (Object.prototype.hasOwnProperty.call(p, 'budget')) next.budget = p.budget;
    if (Object.prototype.hasOwnProperty.call(p, 'acceptance')) {
      const byId = new Map(current.acceptance.map(row => [row.id, row]));
      next.acceptance = normalizeMissionAcceptance(p.acceptance).map(row => {
        // doneAt 只在【由未完成变完成】的那一刻盖章;已完成项保留原时间戳(勾选时间是事实,不是刷新时间)。
        const prev = byId.get(row.id);
        if (row.done && prev && prev.done && prev.doneAt) return Object.assign({}, row, { doneAt: prev.doneAt });
        return row;
      });
    }
    return { ok: true, mission: await writeMissionContainer(next) };
  });
}

// 反向索引维护:只动事项文件的 sessionIds。会话头那侧由调用方经 updateSessionMeta 写(享受 116-2a 的
// 活回合竞态防护);没有事项文件时是 no-op —— 「未归类」按定义就没有索引可维护。两个方向都幂等。
async function missionIndexAdd(missionId, sessionId) {
  const id = safeMissionId(missionId), sid = safeSessionId(sessionId);
  if (!id || !sid) return null;
  return withMissionContainerLock(id, async () => {
    const current = await readMissionContainer(id);
    if (!current) return null;
    if (current.sessionIds.includes(sid)) return current;
    if (current.sessionIds.length >= MISSION_CONTAINER_LIMITS.sessionIds) return current;
    return writeMissionContainer(Object.assign({}, current, { sessionIds: current.sessionIds.concat([sid]) }));
  });
}
async function missionIndexRemove(missionId, sessionId) {
  const id = safeMissionId(missionId), sid = safeSessionId(sessionId);
  if (!id || !sid) return null;
  return withMissionContainerLock(id, async () => {
    const current = await readMissionContainer(id);
    if (!current) return null;
    if (!current.sessionIds.includes(sid)) return current;
    return writeMissionContainer(Object.assign({}, current, { sessionIds: current.sessionIds.filter(x => x !== sid) }));
  });
}

async function archiveMissionContainer(missionId) {
  const id = safeMissionId(missionId);
  if (!id) return null;
  return withMissionContainerLock(id, async () => {
    const current = await readMissionContainer(id);
    if (!current) return null;
    if (current.archivedAt) return current;                               // 幂等
    return writeMissionContainer(Object.assign({}, current, { archivedAt: nowIso() }));
  });
}

// 合并验收项:按【文本】去重(id 是各自文件里的局部主键,跨文件没有可比性;用户看到的是文本)。
function mergeMissionAcceptance(targetRows, sourceRows) {
  const seen = new Set((targetRows || []).map(row => row.text));
  const merged = (targetRows || []).slice();
  for (const row of (sourceRows || [])) {
    if (merged.length >= MISSION_CONTAINER_LIMITS.acceptanceItems) break;
    if (seen.has(row.text)) continue;
    seen.add(row.text);
    merged.push(row);
  }
  return merged;
}


// ── 116g:线程归属操作(加入 / 移出 / 合并 / 拆分)──────────────────────────────
// 会话头那侧一律经 `updateSessionMeta`(享受 116-2a 的活回合竞态防护:活回合期间延后到回合 settle
// 之后在【重新装载的副本】上重放,绝不用陈旧正文盖掉回合刚写的消息);事项文件那侧走 missionIndex*。
// 两侧都幂等,所以「重放一次」永远等于「没重放」。

// 只读会话【头】(不碰 NDJSON 正文):归属操作只需要 id/kind/missionId 三个字段,
// 没必要为此把整条会话的消息装进内存。
return { safeMissionId, missionClipText, readMissionContainer, withMissionContainerLock, writeMissionContainer, listMissionContainers, missionContainerFail, createMissionContainer, patchMissionContainer, missionIndexAdd, missionIndexRemove, archiveMissionContainer, mergeMissionAcceptance, MISSION_CONTAINER_MAX_FILES, MISSION_CONTAINER_LIMITS };
}
module.exports = { createMissionStore };
