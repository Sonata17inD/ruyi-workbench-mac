'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

function createCheckpointEditorDiff({ journalDir }) {
  const EXTERNAL_DIFF_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  async function cleanupExternalDiffCache(sessionId) {
    const root = path.join(journalDir(sessionId), 'external-diff');
    const rows = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    const cutoff = Date.now() - EXTERNAL_DIFF_CACHE_TTL_MS;
    for (const row of rows) {
      if (!row.isDirectory()) continue;
      const target = path.join(root, row.name);
      const st = await fsp.stat(target).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function materializeCheckpointEditorDiff(sessionId, entry, currentPath) {
    if (!entry || entry.skipped) return { ok: false, error: '改动前快照过大或缺失，无法交给本机程序比较' };
    const turnSeq = Number(entry.turnSeq), entrySeq = Number(entry.entrySeq);
    if (!Number.isInteger(turnSeq) || !Number.isInteger(entrySeq)) return { ok: false, error: '检查点引用无效' };
    const fileName = path.basename(String(entry.path || '')) || 'changed-file.txt';
    const root = path.join(journalDir(sessionId), 'external-diff');
    const dir = path.join(root, `${turnSeq}-${entrySeq}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
    const beforeDir = path.join(dir, 'before'), afterDir = path.join(dir, 'after');
    await fsp.mkdir(beforeDir, { recursive: true });
    await fsp.mkdir(afterDir, { recursive: true });
    const beforePath = path.join(beforeDir, fileName);
    const afterTempPath = path.join(afterDir, fileName);
    let before = Buffer.alloc(0);
    if (entry.op !== 'create') {
      try {
        const gz = await fsp.readFile(path.join(journalDir(sessionId), `${turnSeq}-${entrySeq}.gz`));
        before = zlib.gunzipSync(gz);
      } catch { return { ok: false, error: '无法读取改动前快照' }; }
    }
    await fsp.writeFile(beforePath, before);
    await fsp.chmod(beforePath, 0o444).catch(() => {});
    let afterPath = String(currentPath || '');
    if (entry.op === 'delete') {
      await fsp.writeFile(afterTempPath, Buffer.alloc(0));
      await fsp.chmod(afterTempPath, 0o444).catch(() => {});
      afterPath = afterTempPath;
    }
    cleanupExternalDiffCache(sessionId).catch(() => {});
    return { ok: true, beforePath, afterPath, cacheDir: dir };
  }

  return materializeCheckpointEditorDiff;
}

module.exports = { createCheckpointEditorDiff };
