'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
function createMemoryStore({ memoryRoot, atomicWriteJson, parseFrontmatter, firstParaDesc, safeJsonParse, SKILL_ID_RE, makeId, nowIso,
  limits: { MEMORY_TYPES, MEMORY_METADATA_READ_CAP, CORE_MEMORY_SUMMARY_CAP, MEMORY_USAGE_TOUCH_MS, MEMORY_RULE_TOUCH_MS },
}) {
function fmVal(s) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim(); }

function memoryGlobalDir() { return path.join(memoryRoot, 'global'); }
// Project identity preserves Mac path spelling and case; existing keys remain unchanged.
function projectKeyForCwd(cwd) {
  let p = path.resolve(String(cwd || ''));

  return crypto.createHash('sha256').update(p, 'utf8').digest('hex').slice(0, 16);
}
function memoryProjectDir(cwd) { return path.join(memoryRoot, 'project', projectKeyForCwd(cwd)); }
function memoryUsageFile() { return path.join(memoryRoot, '_usage-v1.json'); }
function memoryUsageKey(entry, cwd) {
  return entry.scope === 'global' ? 'global:' + entry.id : 'project:' + projectKeyForCwd(cwd) + ':' + entry.id;
}
function fmBool(value, fallback = false) {
  if (value === true || String(value).toLowerCase() === 'true' || String(value) === '1') return true;
  if (value === false || String(value).toLowerCase() === 'false' || String(value) === '0') return false;
  return fallback;
}
function cleanMemoryDate(value) {
  const s = fmVal(value).slice(0, 32);
  if (!s) return '';
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}
function memoryIsExpired(entry, nowMs = Date.now()) {
  const ms = Date.parse(String(entry && entry.expiresAt || ''));
  return Number.isFinite(ms) && ms <= nowMs;
}
function memoryReviewDue(entry, nowMs = Date.now()) {
  const ms = Date.parse(String(entry && entry.reviewAfter || ''));
  return Number.isFinite(ms) && ms <= nowMs;
}

async function readMemoryUsageState() {
  try {
    const file = memoryUsageFile();
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return { schema: 1, entries: {} };
    const raw = safeJsonParse(await fsp.readFile(file, 'utf8'), null);
    if (!raw || typeof raw !== 'object' || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) return { schema: 1, entries: {} };
    return { schema: 1, entries: raw.entries };
  } catch { return { schema: 1, entries: {} }; }
}

let memoryUsageWriteChain = Promise.resolve();
async function touchMemoryUsage(entries, cwd, reason = 'relevant') {
  const items = (Array.isArray(entries) ? entries : []).filter(e => e && e.id);
  if (!items.length) return;
  const job = memoryUsageWriteChain.then(async () => {
    const state = await readMemoryUsageState();
    const nowMs = Date.now(), now = new Date(nowMs).toISOString();
    let changed = false;
    for (const entry of items) {
      const key = memoryUsageKey(entry, cwd);
      const prev = state.entries[key] && typeof state.entries[key] === 'object' ? state.entries[key] : {};
      const stampField = reason === 'core-rule' ? 'lastImplicitUseAt' : 'lastUsedAt';
      const interval = reason === 'core-rule' ? MEMORY_RULE_TOUCH_MS : MEMORY_USAGE_TOUCH_MS;
      const lastMs = Date.parse(String(prev[stampField] || ''));
      if (Number.isFinite(lastMs) && nowMs - lastMs < interval) continue;
      state.entries[key] = {
        useCount: Math.max(0, Math.floor(Number(prev.useCount) || 0)) + 1,
        lastUsedAt: reason === 'core-rule' ? (prev.lastUsedAt || now) : now,
        lastImplicitUseAt: reason === 'core-rule' ? now : (prev.lastImplicitUseAt || ''),
      };
      changed = true;
    }
    if (!changed) return;
    await fsp.mkdir(memoryRoot, { recursive: true });
    await atomicWriteJson(memoryUsageFile(), { schema: 1, updatedAt: now, entries: state.entries });
  }).catch(() => {});
  memoryUsageWriteChain = job;
  await job;
}
async function mutateMemoryUsageState(mutator) {
  const job = memoryUsageWriteChain.then(async () => {
    const state = await readMemoryUsageState();
    if (mutator(state.entries) === false) return;
    await fsp.mkdir(memoryRoot, { recursive: true });
    await atomicWriteJson(memoryUsageFile(), { schema: 1, updatedAt: nowIso(), entries: state.entries });
  }).catch(() => {});
  memoryUsageWriteChain = job;
  await job;
}

// 组目录内写 meta.json(明文 path+label+createdAt),面板反查不依赖 recentWorkspaces(LRU 会逐出)。原子写。
async function writeMemoryMeta(dir, cwd) {
  try {
    const metaPath = path.join(dir, 'meta.json');
    const abs = path.resolve(String(cwd || ''));
    let createdAt = nowIso();
    try { const prev = safeJsonParse(await fsp.readFile(metaPath, 'utf8'), null); if (prev && prev.createdAt) createdAt = prev.createdAt; } catch { /* 无旧 meta */ }
    const meta = { path: abs, label: path.basename(abs) || abs, createdAt };
    await atomicWriteJson(metaPath, meta);   // 25.1 收编
  } catch { /* meta 失败不阻断写入 */ }
}

// 读一个 memory 目录下所有 <id>.md → Map<id, entry>。id 须过 SKILL_ID_RE(防穿越);frontmatter 复用
// parseFrontmatter(键已小写:createdAt→createdat 等)。description 回退首个正文段(firstParaDesc)。
// 113a: 注册表头部缓存。每一轮对话都要 loadMemoryRegistry 一次,原实现对每个 .md 做一次 open+read 16KB
// +frontmatter 解析,记忆库涨到几百条后这是回合起步阶段最贵的一段纯 IO。失效键沿用 106 #2a 那套
// 文件身份、变更时间、mtime 与大小；readdir 每轮照做(新增/删除必须立刻可见)，
// 省掉的只是「内容没变的文件重新读一遍」。结果集与未加缓存时逐字节相同。
const MEMORY_HEAD_CACHE = new Map(); // file -> { key, entry }
const MEMORY_HEAD_CACHE_MAX = 2000;

async function readMemoryDir(dir, scope) {
  const out = new Map();
  let files = [];
  try { files = await fsp.readdir(dir); } catch { return out; } // 目录不存在 → 空(零开销短路)
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.md')) continue;
    const id = f.slice(0, -3);
    if (!SKILL_ID_RE.test(id)) continue;
    const file = path.join(dir, f);
    let raw = '';
    // 260KB 是与写侧一致的文件准入上限，避免“保存后从列表消失”；注册表检索本身只读前 16KB，
    // 足够覆盖工作台生成的受限 frontmatter + 首段说明，完整正文留到命中后按需读取。
    let cacheKey = '';
    try {
      const st = await fsp.stat(file);
      if (!st.isFile() || st.size > 260 * 1024) continue;
      cacheKey = `${st.dev}:${st.ino}:${st.ctimeMs}:${st.mtimeMs}:${st.size}`;
      const cached = MEMORY_HEAD_CACHE.get(file);
      if (cached && cached.key === cacheKey && cached.entry.scope === scope) { out.set(id, cached.entry); continue; }
      const fh = await fsp.open(file, 'r');
      try {
        const buf = Buffer.allocUnsafe(Math.min(st.size, MEMORY_METADATA_READ_CAP));
        const read = await fh.read(buf, 0, buf.length, 0);
        raw = buf.subarray(0, read.bytesRead).toString('utf8');
      } finally { await fh.close().catch(() => {}); }
    } catch { continue; }
    const fm = parseFrontmatter(raw);
    const type = MEMORY_TYPES.has(fm.type) ? fm.type : 'reference';
    const core = fmBool(fm.core, false); // 旧记忆不静默升格；由用户/新建表单明确加入核心
    const entry = {
      id, scope,
      name: (fm.name || id).slice(0, 120),
      description: (fm.description || firstParaDesc(raw)).slice(0, 400),
      type, file, memoryVersion: cacheKey,
      createdAt: fm.createdat || '',
      updatedAt: fm.updatedat || fm.createdat || '',
      core,
      coreSummary: (fm.coresummary || fm.description || firstParaDesc(raw)).slice(0, CORE_MEMORY_SUMMARY_CAP),
      importance: fm.importance === 'important' ? 'important' : 'normal',
      reviewAfter: cleanMemoryDate(fm.reviewafter),
      expiresAt: cleanMemoryDate(fm.expiresat),
      sourceSessionId: fm.sourcesessionid || '',
      sourceRunId: fm.sourcerunid || '',
    };
    out.set(id, entry);
    if (cacheKey) {
      // 简单 FIFO 上限:记忆库不会大到需要 LRU,但无界 Map 在长跑进程里迟早是个泄漏。
      if (MEMORY_HEAD_CACHE.size >= MEMORY_HEAD_CACHE_MAX) {
        const oldest = MEMORY_HEAD_CACHE.keys().next();
        if (!oldest.done) MEMORY_HEAD_CACHE.delete(oldest.value);
      }
      MEMORY_HEAD_CACHE.set(file, { key: cacheKey, entry });
    }
  }
  return out;
}

// loadMemoryRegistry(cwd) → [{id, scope, name, description, type, file(绝对路径), createdAt, ...}]。global +
// 当前 cwd 的 projectKey 组;按 createdAt 倒序(C4,无自动过期)。
async function loadMemoryRegistry(cwd) {
  const out = [];
  for (const [, e] of await readMemoryDir(memoryGlobalDir(), 'global')) out.push(e);
  if (cwd) for (const [, e] of await readMemoryDir(memoryProjectDir(cwd), 'project')) out.push(e);
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(a.name).localeCompare(String(b.name)));
  return out;
}

// 扫描 project/ 下各组(除当前组)的 meta.json + 记忆条目,供面板「迁移到当前项目」列出旧项目组(C1)。
async function listMemoryProjectGroups(excludeKey) {
  const base = path.join(memoryRoot, 'project');
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(base, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === excludeKey) continue;
    const entries = [...(await readMemoryDir(path.join(base, d.name), 'project')).values()];
    if (!entries.length) continue;
    let meta = null; try { meta = safeJsonParse(await fsp.readFile(path.join(base, d.name, 'meta.json'), 'utf8'), null); } catch { meta = null; }
    out.push({ projectKey: d.name, path: (meta && meta.path) || '', label: (meta && meta.label) || d.name, count: entries.length, items: entries.map(e => ({ id: e.id, name: e.name })) });
  }
  return out;
}

// 读单条记忆全文(含正文,供编辑弹窗回填)。
async function readMemoryItem(id, scope, cwd) {
  const safe = String(id || '');
  if (!SKILL_ID_RE.test(safe)) return { ok: false, error: 'invalid memory id' };
  const dir = scope === 'global' ? memoryGlobalDir() : memoryProjectDir(cwd);
  const file = path.join(dir, safe + '.md');
  let raw = '';
  try { raw = await fsp.readFile(file, 'utf8'); } catch { return { ok: false, error: 'memory not found' }; }
  const fm = parseFrontmatter(raw);
  const body = raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '');
  const type = MEMORY_TYPES.has(fm.type) ? fm.type : 'reference';
  return { ok: true, memory: { id: safe, scope, name: fm.name || safe, description: fm.description || '', type, body,
    createdAt: fm.createdat || '', updatedAt: fm.updatedat || fm.createdat || '',
    core: fmBool(fm.core, false),
    coreSummary: (fm.coresummary || fm.description || '').slice(0, CORE_MEMORY_SUMMARY_CAP),
    importance: fm.importance === 'important' ? 'important' : 'normal',
    reviewAfter: cleanMemoryDate(fm.reviewafter), expiresAt: cleanMemoryDate(fm.expiresat),
    // 来源字段也回传:元数据快捷操作(核心/重要)与修订落盘都是「读原条目 → saveMemory」,不带它们 frontmatter 里的来源会被抹掉。
    sourceSessionId: fm.sourcesessionid || '', sourceRunId: fm.sourcerunid || '', file } };
}

// 保存一条记忆(原子写 tmp+rename)。id 缺省合成;scope=global|project;正文 + frontmatter。返回 {ok, memory}。
// opts.createdAt:换作用域(moveMemoryScope)时沿用原条目的创建时间 —— 只对「目标位置还没有文件」的新写生效,覆盖已有文件仍以盘上的为准。
async function saveMemory(mem, cwd, opts = {}) {
  const m = (mem && typeof mem === 'object') ? mem : {};
  let id = String(m.id || '').trim();
  if (!id) id = makeId('mem'); // 117q-B2(P2-15):统一走 00-boot 的 makeId,不再手写 randomBytes
  if (!SKILL_ID_RE.test(id)) return { ok: false, error: '无效的记忆 id(仅限字母/数字/_-,长度 1..64)' };
  const scope = m.scope === 'global' ? 'global' : 'project';
  const name = fmVal(m.name).slice(0, 120);
  const description = fmVal(m.description).slice(0, 400);
  const type = MEMORY_TYPES.has(m.type) ? m.type : 'reference';
  const bodyText = String(m.body || '').trim();
  if (!name || !bodyText) return { ok: false, error: '记忆的名称与正文不能为空' };
  // P3-1: 正文上限 256KB(与 readMemoryDir 的读上限对齐)—— 超限直接拒绝,杜绝「保存成功却因超读上限从列表消失」的幽灵。
  if (bodyText.length > 256 * 1024) return { ok: false, error: '记忆正文超过 256KB 上限' };
  const dir = scope === 'global' ? memoryGlobalDir() : memoryProjectDir(cwd);
  try { await fsp.mkdir(dir, { recursive: true }); } catch { /* 已存在 */ }
  if (scope === 'project') await writeMemoryMeta(dir, cwd);
  const dest = path.join(dir, id + '.md');
  let createdAt = nowIso();
  let prevFm = {};
  let hadPrev = false;
  try { const prev = await fsp.readFile(dest, 'utf8'); prevFm = parseFrontmatter(prev); hadPrev = true; if (prevFm.createdat) createdAt = prevFm.createdat; } catch { /* 新建 */ }
  if (!hadPrev && opts && opts.createdAt) createdAt = cleanMemoryDate(opts.createdAt) || createdAt;
  const updatedAt = nowIso();
  const has = key => Object.prototype.hasOwnProperty.call(m, key);
  const core = has('core') ? fmBool(m.core) : fmBool(prevFm.core, false);
  const importance = (has('importance') ? m.importance : prevFm.importance) === 'important' ? 'important' : 'normal';
  let coreSummary = fmVal(has('coreSummary') ? m.coreSummary : (prevFm.coresummary || description)).slice(0, CORE_MEMORY_SUMMARY_CAP);
  // 核心胶囊每轮注入的是 coreSummary 而不是 description。修前改了 description,coreSummary 还停在旧文字(旧摘要一直在注入)。
  // 现在:旧摘要从没单独写过(为空,或与旧 description 相同 = 只是跟随值),而 description 变了,摘要就跟着新 description;
  // 调用方这次带来的摘要若只是把旧值原样送回(编辑弹窗预填的就是旧摘要)也算「没动」。用户真改过的摘要(与旧 description 不同)一字不碰。
  if (hadPrev) {
    const prevDescription = fmVal(prevFm.description);
    const prevSummary = fmVal(prevFm.coresummary);
    const followsDescription = !prevSummary || prevSummary === prevDescription;
    const untouched = !has('coreSummary') || !coreSummary || coreSummary === prevSummary || coreSummary === prevDescription;
    if (followsDescription && untouched && description !== prevDescription) coreSummary = description.slice(0, CORE_MEMORY_SUMMARY_CAP);
  }
  const reviewAfter = cleanMemoryDate(has('reviewAfter') ? m.reviewAfter : prevFm.reviewafter);
  const expiresAt = cleanMemoryDate(has('expiresAt') ? m.expiresAt : prevFm.expiresat);
  const fmLines = ['---', 'name: ' + name, 'description: ' + description, 'type: ' + type, 'createdAt: ' + createdAt,
    'updatedAt: ' + updatedAt, 'core: ' + String(core), 'importance: ' + importance, 'coreSummary: ' + coreSummary];
  if (reviewAfter) fmLines.push('reviewAfter: ' + reviewAfter);
  if (expiresAt) fmLines.push('expiresAt: ' + expiresAt);
  if (m.sourceSessionId) fmLines.push('sourceSessionId: ' + fmVal(String(m.sourceSessionId)).slice(0, 120));
  if (m.sourceRunId) fmLines.push('sourceRunId: ' + fmVal(String(m.sourceRunId)).slice(0, 120));
  fmLines.push('---', '', bodyText, '');
  const content = fmLines.join('\n');
  // 对抗轮 P2: 上限须与 readMemoryDir 的读上限(st.size,UTF-8 字节)同量纲——上面的 bodyText.length 是 UTF-16 字符数,
  // 中文正文每字落盘 3 字节,9 万字中文会"保存成功却超读上限从列表消失"。按最终落盘内容字节数复核(含 frontmatter)。
  if (Buffer.byteLength(content, 'utf8') > 260 * 1024) return { ok: false, error: '记忆正文超过 256KB 上限(按 UTF-8 字节计,中文约 8 万字)' };   // 260KB=正文上限+frontmatter 余量,与读侧一致
  // 第25波 25.1: 收编 atomicWriteJson(载荷是 markdown 字符串,直接透传;获得 rename 重试 + 失败清 tmp)。
  await atomicWriteJson(dest, content);
  return { ok: true, memory: { id, scope, name, description, type, file: dest, createdAt, updatedAt, core, coreSummary, importance, reviewAfter, expiresAt } };
}

async function deleteMemory(id, scope, cwd) {
  const safe = String(id || '');
  if (!SKILL_ID_RE.test(safe)) return { ok: false, error: 'invalid memory id' };
  const dir = scope === 'global' ? memoryGlobalDir() : memoryProjectDir(cwd);
  const file = path.join(dir, safe + '.md');
  try { await fsp.access(file); } catch { return { ok: false, error: 'memory not found' }; }
  // 修前 .catch(() => {}) 把 unlink 失败吞掉、照样回 ok:true —— Windows 上文件被占用(EBUSY)/只读(EPERM)/无权限(EACCES)时,
  // 前端提示「已删除」,列表一刷新条目又回来了,用量旁账却已被清掉。现在:只有 ENOENT(access 之后被别处删掉了,目标已达成)当成功;
  // 其余失败如实回 ok:false(不动用量状态,记忆还在),前端 deleteMemoryRow 已按 !ok / 非 2xx 弹「删除失败」。
  try { await fsp.unlink(file); }
  catch (error) {
    if (!(error && error.code === 'ENOENT')) {
      const code = (error && error.code) || 'UNKNOWN';
      return { ok: false, unlinkFailed: true, error: `记忆文件删除失败(${code}):文件可能正被其它程序占用或没有删除权限,请关闭占用它的程序后重试` };
    }
  }
  await mutateMemoryUsageState(entries => { const key = scope === 'global' ? 'global:' + safe : 'project:' + projectKeyForCwd(cwd) + ':' + safe; if (!entries[key]) return false; delete entries[key]; });
  return { ok: true, deleted: safe, scope };
}

  return { fmVal, memoryGlobalDir, projectKeyForCwd, memoryProjectDir, memoryUsageFile, memoryUsageKey, fmBool, cleanMemoryDate, memoryIsExpired, memoryReviewDue, readMemoryUsageState, touchMemoryUsage, mutateMemoryUsageState, writeMemoryMeta, readMemoryDir, loadMemoryRegistry, listMemoryProjectGroups, readMemoryItem, saveMemory, deleteMemory };
}
module.exports = { createMemoryStore };
