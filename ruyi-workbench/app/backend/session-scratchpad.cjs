'use strict';
const path = require('node:path');
const { runKeyedChain } = require('./keyed-chain.cjs');

// ── C2(61 号文):会话草稿本 sessions/<id>.scratchpad.json ──────────────────────────────────────
// 模型自己「写即生效、不进长期库」的短笔记:按 key 写/覆盖,text 为空即删。只发给模型服务商引擎普通会话的主回合
// (工具 scratchpad_write:schema 在 13f、发放在 07 buildOpenAiTools 的 opts.scratchpadEnabled、handler 在 12);
// 09 每回合把快照贴到末条 user 尾部(非持久,见那里的缓存账)。与 session-notes 分工:notes 由运行时在 L2 压缩后
// 从摘要写出,模型没有写入口;草稿本只有模型写。长期偏好与项目约定仍走 workbench_memory_propose(确认制)。
// 落盘走 DurableJsonStore(01):schema 1、清洗(限额对手改过的文件同样成立)、坏文件当空(quarantine:false ——
// 草稿是易失副本,下一次写自愈,不留 .corrupt)、原子写。cache:false:每会话一个文件,store 按调用现建(构造只是
// 几个闭包),读永远读盘 —— 删会话后不会有进程缓存把旧条目「复活」进下一次注入。同一会话的读-改-写由 runKeyedChain
// 按会话 id 串行(store 自带的写链按实例,不跨实例,这里不依赖它)。
const SESSION_SCRATCHPAD_SCHEMA = 1;
const SESSION_SCRATCHPAD_LIMITS = Object.freeze({ maxEntries: 32, maxKeyChars: 40, maxTextChars: 2000, maxTotalChars: 12000 });

// key:控制字符换空格、折叠空白、trim。不截断 —— 截断会让两个不同的 key 悄悄撞成一个,超长由调用方拒绝。
function normalizeScratchpadKey(raw) {
  return String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// text:统一换行、去掉 \n \t 以外的控制字符、trim(保留多行)。
function normalizeScratchpadText(raw) {
  return String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
}
// 总长只数正文。键由条目数和单键长度分别限制。
function scratchpadTotalChars(entries) {
  return (Array.isArray(entries) ? entries : []).reduce((n, e) => n + String((e && e.text) || '').length, 0);
}
// 盘上形状 { schema:1, updatedAt, entries:[{ key, text, at }] }。用数组保序:对象键里的 "1"、"42" 这类整数键会被 JS 重排。
// 清洗丢掉手改坏的条目、同 key 留最后一条、超长正文截断、超出条目数 / 总长从最早的条目丢起 —— 于是注入块的大小
// 只取决于限额,一份手改的大文件撑不大它。
function sanitizeSessionScratchpad(value) {
  const L = SESSION_SCRATCHPAD_LIMITS;
  const byKey = new Map();
  for (const raw of Array.isArray(value && value.entries) ? value.entries : []) {
    if (!raw || typeof raw !== 'object') continue;
    const key = normalizeScratchpadKey(raw.key);
    const text = normalizeScratchpadText(raw.text).slice(0, L.maxTextChars);
    if (!key || key.length > L.maxKeyChars || !text) continue;
    byKey.delete(key);
    byKey.set(key, { key, text, at: typeof raw.at === 'string' ? raw.at.slice(0, 40) : '' });
  }
  let entries = [...byKey.values()];
  if (entries.length > L.maxEntries) entries = entries.slice(-L.maxEntries);
  while (entries.length && scratchpadTotalChars(entries) > L.maxTotalChars) entries.shift();
  return { schema: SESSION_SCRATCHPAD_SCHEMA, updatedAt: typeof (value && value.updatedAt) === 'string' ? value.updatedAt.slice(0, 40) : '', entries };
}

function createSessionScratchpad({ paths, assertSessionIdForPath, DurableJsonStore, logEvent, sessionSaveIsTombstoned, nowIso }) {
  const sessionScratchpadChains = new Map();
  function sessionScratchpadPath(id) {
    return path.join(paths.sessions, `${assertSessionIdForPath(id)}.scratchpad.json`);
  }
  function scratchpadWriteInFlight(id) { return sessionScratchpadChains.get(id); }

  function sessionScratchpadStore(id) {
    return DurableJsonStore.create({
      id: 'session-scratchpad',
      file: sessionScratchpadPath(id),   // 不合形的 id 在这里就抛(assertSessionIdForPath)
      schemaVersion: SESSION_SCRATCHPAD_SCHEMA,
      cache: false,
      quarantine: false,
      defaultValue: () => ({ schema: SESSION_SCRATCHPAD_SCHEMA, updatedAt: '', entries: [] }),
      sanitize: sanitizeSessionScratchpad,
      validate: value => value.schema === SESSION_SCRATCHPAD_SCHEMA && Array.isArray(value.entries),
      onCorrupt(error) {
        try { logEvent({ kind: 'session_scratchpad_corrupt', sessionId: String(id), error: String((error && error.message) || error).slice(0, 200) }); } catch { /* 诊断绝不阻断 */ }
      },
    });
  }
  // 读:缺文件 / 坏文件 / 读不动 / 不合形的 id 一律空表 —— 草稿是旁车副本,绝不阻断回合。
  async function readSessionScratchpad(id) {
    try { return (await sessionScratchpadStore(id).read()).entries; }
    catch { return []; }
  }
  // 读-改-写(按会话串行)。mutate 拿到条目副本,返回 { entries, changed, ...其余字段原样带回 };changed 为假 = 不落盘。
  // 会话已删除(墓碑,见 markSessionDeleted)时拒写:垂死回合里迟到的一次写不得在 unlink 之后把旁车写回来。
  async function updateSessionScratchpad(session, mutate) {
    const id = String((session && session.id) || '');
    const store = sessionScratchpadStore(id);
    return runKeyedChain(sessionScratchpadChains, id, async () => {
      if (sessionSaveIsTombstoned(session)) return { refused: 'session-deleted' };
      const current = (await store.read()).entries.map(e => ({ ...e }));
      const out = mutate(current) || {};
      if (out.refused || !out.changed) return { entries: current, ...out };
      const saved = await store.write({ schema: SESSION_SCRATCHPAD_SCHEMA, updatedAt: nowIso(), entries: out.entries });
      return { ...out, entries: saved.entries };
    });
  }

  return { sessionScratchpadPath, scratchpadWriteInFlight, readSessionScratchpad, updateSessionScratchpad };
}

module.exports = { createSessionScratchpad, SESSION_SCRATCHPAD_LIMITS, normalizeScratchpadKey, normalizeScratchpadText, scratchpadTotalChars };
