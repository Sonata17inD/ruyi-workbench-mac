'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { safeJsonParse } = require('./ordinary-json.cjs');

function createMemoryMigrations({ paths, store, removeMemoryRelationsFor, atomicWriteJson, SKILL_ID_RE,
  logEvent, nowIso, accMemoryImportStore, ACC_MEMORY_IMPORT_SCHEMA, legacyAccMemoryMigrationComplete }) {
  const { readMemoryItem, saveMemory, deleteMemory, memoryGlobalDir, memoryProjectDir,
    memoryUsageKey, readMemoryUsageState, mutateMemoryUsageState, projectKeyForCwd, writeMemoryMeta } = store;

  // 把一条记忆换到另一个作用域(项目 → 全局「提升」/ 全局 → 当前项目「下放」)。
  // mem = 要写进目标作用域的完整内容(含 id、scope=目标作用域);fromScope = 它现在所在的作用域。
  // 顺序:先写目标、写成功才删原件;原件删不掉就把刚写的那份撤回 —— 不会留下两处各一份。
  // 同 id 在目标作用域已存在 → 拒绝(conflict),不覆盖。
  // 能迁的:用量旁账(useCount/lastUsedAt 换键);不能迁的:关系边 —— 关系只许同作用域内建(见 proposeMemoryRelation 的隔离红线),
  // 一端挪走边就成了跨作用域,只能从原作用域的 _relations.json 摘掉,条数放在 moved.relationsDropped 里,调用方要如实告诉用户。
  async function moveMemoryScope(mem, fromScope, cwd) {
    const m = mem && typeof mem === 'object' ? mem : {};
    const id = String(m.id || '');
    const toScope = m.scope === 'global' ? 'global' : 'project';
    const from = fromScope === 'global' ? 'global' : 'project';
    if (!SKILL_ID_RE.test(id)) return { ok: false, error: 'invalid memory id' };
    if (from === toScope) return { ok: false, error: '原作用域与目标作用域相同,无需移动' };
    const src = await readMemoryItem(id, from, cwd);
    if (!src.ok) return { ok: false, error: '要移动的记忆已不存在' };
    const dup = await readMemoryItem(id, toScope, cwd);
    if (dup.ok) {
      return { ok: false, conflict: true, errorCode: 'memory.move_conflict', errorParams: { id, scope: toScope },
        error: `目标作用域(${toScope === 'global' ? '全局' : '当前项目'})里已经有同 id 的记忆(${id}),未移动` };
    }
    const oldKey = memoryUsageKey({ scope: from, id }, cwd), newKey = memoryUsageKey({ scope: toScope, id }, cwd);
    const prevUsage = (await readMemoryUsageState()).entries[oldKey] || null;   // deleteMemory 会清掉旧键,先取走
    const saved = await saveMemory({ ...m, id, scope: toScope }, cwd, { createdAt: src.memory.createdAt });
    if (!saved.ok) return saved;
    const removed = await deleteMemory(id, from, cwd);
    if (!removed.ok) {
      await deleteMemory(id, toScope, cwd).catch(() => {});   // 撤回刚写的那份,保持「只在原处」
      return { ok: false, error: removed.error || '原记忆删除失败,已撤回移动' };
    }
    if (prevUsage) await mutateMemoryUsageState(entries => { if (entries[newKey]) return false; entries[newKey] = prevUsage; });
    let relationsDropped = 0;
    try {
      relationsDropped = await removeMemoryRelationsFor(id, from, cwd);
    } catch { /* 关系文件读写失败不阻断移动;残留的边会在维护建议里作为孤边列出 */ }
    return { ok: true, memory: saved.memory, moved: { from, to: toScope, relationsDropped, usageMoved: !!prevUsage } };
  }

  async function migrateLegacyAccMemory() {
    if (legacyAccMemoryMigrationComplete()) return { ok: true, alreadyDone: true };
    const root = process.env.WCW_DATA_DIR || path.join(os.homedir(), '.ai-computer-control');
    const source = path.resolve(root, 'memory.json');
    let store;
    try {
      const st = await fsp.stat(source);
      if (!st.isFile() || st.size > 8 * 1024 * 1024) throw new Error('invalid legacy ACC memory file or size');
      store = safeJsonParse(await fsp.readFile(source, 'utf8'), null);
      if (!store || typeof store !== 'object' || !store.entries || typeof store.entries !== 'object' || Array.isArray(store.entries)) throw new Error('legacy ACC memory file has an invalid schema');
    } catch (e) {
      if (e.code === 'ENOENT') {
        await accMemoryImportStore.write({ schema: ACC_MEMORY_IMPORT_SCHEMA, status: 'complete', result: 'no-source', imported: 0, skipped: 0, completedAt: nowIso() });
        return { ok: true, imported: 0, skipped: 0, noSource: true };
      }
      logEvent({ kind: 'acc_memory_import_failed', source, error: e.message });
      return { ok: false, error: e.message, source };
    }
    let imported = 0, skipped = 0;
    for (const [key, raw] of Object.entries(store.entries)) {
      const entry = raw && typeof raw === 'object' ? raw : {};
      const content = String(entry.content || '').trim();
      if (!String(key).trim() || !content) { skipped++; continue; }
      const id = 'acc-' + crypto.createHash('sha256').update(String(key), 'utf8').digest('hex').slice(0, 20);
      const dest = path.join(memoryGlobalDir(), id + '.md');
      try { await fsp.access(dest); skipped++; continue; } catch { /* not imported yet */ }
      const tags = String(entry.tags || '').replace(/[\r\n]+/g, ' ').trim();
      const updated = String(entry.updated || '').replace(/[\r\n]+/g, ' ').trim();
      const provenance = ['---', '导入来源: ACC Memory', '原键: ' + String(key).replace(/[\r\n]+/g, ' ').trim()];
      if (tags) provenance.push('原标签: ' + tags);
      if (updated) provenance.push('原更新时间: ' + updated);
      const saved = await saveMemory({
        id, scope: 'global', type: 'reference', name: String(key).trim().slice(0, 120),
        description: ('从旧 ACC Memory 自动导入' + (tags ? '；标签：' + tags : '')).slice(0, 400),
        body: content + '\n\n' + provenance.join('\n'), sourceRunId: 'acc-memory-import-v1',
      }, '');
      if (!saved.ok) return { ok: false, error: saved.error || 'failed to import legacy ACC memory', source, imported, skipped };
      imported++;
    }
    await accMemoryImportStore.write({ schema: ACC_MEMORY_IMPORT_SCHEMA, status: 'complete', result: 'imported', source, imported, skipped, completedAt: nowIso() });
    logEvent({ kind: 'acc_memory_import_complete', source, imported, skipped });
    return { ok: true, source, imported, skipped };
  }

  async function migrateMemory(id, fromKey, targetCwd) {
    const safe = String(id || '');
    if (!SKILL_ID_RE.test(safe)) return { ok: false, error: 'invalid memory id' };
    if (!/^[a-f0-9]{16}$/.test(String(fromKey || ''))) return { ok: false, error: 'invalid source project key' };
    const targetKey = projectKeyForCwd(targetCwd);
    if (targetKey === fromKey) return { ok: false, error: '该记忆已在当前项目组' };
    const srcFile = path.join(paths.memory, 'project', fromKey, safe + '.md');
    let content = '';
    try { content = await fsp.readFile(srcFile, 'utf8'); } catch { return { ok: false, error: 'source memory not found' }; }
    const destDir = memoryProjectDir(targetCwd);
    const dest = path.join(destDir, safe + '.md');
    // P2-4: 目标项目组已存在同名记忆 → 拒绝迁移(不覆盖、不删源),让用户先重命名或删除。探测在建目录前做,避免为
    // 注定失败的迁移建空目录/写 meta。conflict:true 让上层映射 409(与 400 一般失败区分)。
    try { await fsp.access(dest); return { ok: false, conflict: true, error: '目标项目组已存在同名记忆(' + safe + '),请先重命名或删除' }; } catch { /* dest 不存在 → 可迁移 */ }
    try { await fsp.mkdir(destDir, { recursive: true }); } catch { /* 已存在 */ }
    await writeMemoryMeta(destDir, targetCwd);
    await atomicWriteJson(dest, content);   // 第25波 25.1: 收编(同 saveMemory)
    await fsp.unlink(srcFile).catch(() => {});
    await mutateMemoryUsageState(entries => {
      const from = 'project:' + fromKey + ':' + safe, to = 'project:' + targetKey + ':' + safe;
      if (!entries[from]) return false;
      if (!entries[to]) entries[to] = entries[from];
      delete entries[from];
    });
    return { ok: true, id: safe, scope: 'project' };
  }

  return { moveMemoryScope, migrateLegacyAccMemory, migrateMemory };
}

module.exports = { createMemoryMigrations };
