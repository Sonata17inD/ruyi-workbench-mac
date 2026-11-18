'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createAtomicFileStore({ paths, process, fsp = fs }) {
  let sessionsDirOwnWriteSeq = 0;
  function noteSessionsDirOwnWrite(file) {
    if (paths && paths.sessions && path.dirname(String(file || '')) === paths.sessions) sessionsDirOwnWriteSeq += 1;
  }

  // ============================================================================
  // 原子 JSON 写入：唯一临时文件、可选私有权限，失败清理自己创建的临时文件。
  // Mac rename 原子发布；权限或路径冲突立即报错，保留旧目标。
  async function atomicWriteJson(finalPath, value, opts = {}) {
    // typeof 守卫:本函数体会被 autonomy-durability 单独抽取执行(那里没有这个钩子)。
    const noteOwn = typeof noteSessionsDirOwnWrite === 'function' ? noteSessionsDirOwnWrite : () => {};
    noteOwn(finalPath);
    try {
      const payload = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      const tmpPath = finalPath + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
      // 对抗轮修(第25波): writeFile 自身失败(ENOSPC 典型——目录项已建、写入失败)同样必须清 tmp,否则
      // 节流重试每 1.5s 造一个新孤儿(唯一名无覆写自愈路径)。不变量③对 write 与 rename 两个失败点都成立。
      if (opts.exclusiveTemp === true) {
        let file, created = false;
        try {
          file = await fsp.open(tmpPath, 'wx', Number.isInteger(opts.mode) ? opts.mode : 0o600);
          created = true;
          try { await file.writeFile(payload, 'utf8'); } finally { await file.close(); file = null; }
        } catch (error) {
          if (file) { try { await file.close(); } catch { /* preserve the failed write */ } }
          // EEXIST is someone else's inode. Never unlink it while recovering our own attempt.
          if (created) { try { await fsp.unlink(tmpPath); } catch { /* best effort; no publication */ } }
          throw error;
        }
      } else {
        try { await fsp.writeFile(tmpPath, payload, Number.isInteger(opts.mode) ? { encoding: 'utf8', mode: opts.mode } : 'utf8'); }
        catch (e) { fsp.unlink(tmpPath).catch(() => {}); throw e; }
      }
      try { await fsp.rename(tmpPath, finalPath); }
      catch (e) {
        try { await fsp.unlink(tmpPath); } catch { /* best-effort tmp cleanup */ }
        throw e;
      }
    } finally { noteOwn(finalPath); }
  }

  return { atomicWriteJson, noteSessionsDirOwnWrite, getSessionsDirOwnWriteSeq: () => sessionsDirOwnWriteSeq };
}

// 117q-B6(30 号文 P2-10):「读文件末尾 N 字节」原语【统一入口】。此前四处独立手写同一套动作
// (stat 拿 size -> 算尾窗起点 -> open -> 分配 buffer -> read -> finally 关 fd):02-session-store.js 的
// repairMissionChangeTornTail/repairInterventionTornTail 两处【不检查 bytesRead】——直接对整段已分配
// buffer 取最后一字节 / lastIndexOf,若 fd.read 实际读到的字节数少于请求量(stat 与 read 之间文件被
// 截短等罕见竞态),就会对 buffer 里未被写入的那一截(未初始化或陈旧内存)算截断点——而这个截断点
// 会被直接拿去 fs.truncate()。算错就是真的截错数据。08-agent-runs.js/13g-steward.js 的两处已经在
// 检查 bytesRead,行为不变,只是把手写的 open/alloc/read/close 换成本函数。
// 返回 { buf, bytesRead, size }：size < 0 表示文件不存在(或 stat 失败,与原四处"stat 出错即当无文件"
// 同口径)；buf.length === 请求要读的字节数(= min(maxBytes, size) 且已 clamp 到 >=0),但【只有
// buf[0..bytesRead) 是本次 read 实际写入的有效数据】——调用方必须按 bytesRead 定界(取最后一个有效
// 字节要用 buf[bytesRead-1],扫 \n 要把 lastIndexOf 的搜索起点钉在 bytesRead-1),不能假设 bytesRead
// === buf.length。空文件(size===0)与「尾窗一字节都不用读」的退化情形直接返回 bytesRead:0,不开 fd。
async function readFileTail(file, maxBytes) {
  let size = -1;
  try { size = (await fs.stat(file)).size; } catch { return { buf: Buffer.alloc(0), bytesRead: 0, size: -1 }; }
  const max = Math.max(0, Math.floor(Number(maxBytes) || 0));
  const start = Math.max(0, size - max);
  const want = size - start;
  if (!want) return { buf: Buffer.alloc(0), bytesRead: 0, size };
  let fh = null;
  try {
    fh = await fs.open(file, 'r');
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, start);
    return { buf, bytesRead, size };
  } finally { if (fh) await fh.close().catch(() => {}); }
}

module.exports = { createAtomicFileStore, readFileTail };
