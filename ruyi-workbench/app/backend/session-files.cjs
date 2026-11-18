'use strict';
const path = require('node:path');

function createSessionFiles({ paths }) {
  // F4 (安全·消毒): accept only a well-formed session id. Returns the id unchanged when it matches the
  // canonical shape (letters/digits/_/-, 1..64), else null. Real ids look like `session_<hex>` → pass
  // naturally. Callers treat null as a 400. Blocks path-ish / oversized / control-char ids from ever
  // reaching loadSession / journal / activeChildren lookups.
  // 会话目录里还住着不是会话的 .json:侧栏索引 index.json、内容搜索索引 _search-index-v1.json(13d)。它们的文件名
  // 本身形状合法,修前 GET /api/sessions/_search-index-v1 会把搜索索引当成 v1 会话「懒迁移」(头被改写、旁边长出
  // 两个正文),DELETE /api/sessions/index 直接 unlink 侧栏索引。所以保留名一律不是会话 id:`index`,以及任何以
  // `_` 开头的名字(工作台自己往会话目录里放的旁车文件都用这个前缀,以后新加的也照此起名)。真会话 id 的形状是
  // makeId('sess') 的 `sess_<16 hex>`、管家会话的 `steward`,都不受影响。
  // 同一张表里还有 Windows 的保留设备名:`CON.json` / `NUL.json` 在 Win32 路径语义下指向设备而不是文件
  // (大小写不敏感,所以比对前先转小写 —— `INDEX.json` 在 NTFS 上也就是 index.json)。
  const RESERVED_SESSION_FILE_IDS = new Set([
    'index', 'con', 'prn', 'aux', 'nul',
    ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
  ]);
  function safeSessionId(raw) {
    const s = String(raw == null ? '' : raw);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) return null;
    if (s.startsWith('_') || RESERVED_SESSION_FILE_IDS.has(s.toLowerCase())) return null;
    return s;
  }

  // 会话 id 拼成文件名的咽喉点:不合形的 id 在这里就拒掉(抛错),不靠每个调用方记得先 safeSessionId ——
  // 修前有几条路由(/api/chat/stream、/api/session/skills、/api/session/memories、工具上下文)直接拿请求体里的
  // sessionId 拼路径,`../config` 就读到了 <数据根>/config.json(连同服务商密钥)当会话回显出去。
  function assertSessionIdForPath(id) {
    if (safeSessionId(id) === null) throw new Error('invalid session id');
    return String(id);
  }
  function sessionPath(id) {
    return path.join(paths.sessions, `${assertSessionIdForPath(id)}.json`);
  }

  function sessionBodyPaths(id) {
    assertSessionIdForPath(id);
    return {
      messages: path.join(paths.sessions, `${id}.messages.ndjson`),
      provider: path.join(paths.sessions, `${id}.provider.ndjson`),
    };
  }

  return { safeSessionId, assertSessionIdForPath, sessionPath, sessionBodyPaths };
}

module.exports = { createSessionFiles };
