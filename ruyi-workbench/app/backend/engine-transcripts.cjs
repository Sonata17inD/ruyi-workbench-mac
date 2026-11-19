'use strict';
const path = require('node:path'), os = require('node:os');
const { dirStat } = require('./storage-stat.cjs');
function createEngineTranscriptStore({ paths, atomicWriteJson, nowIso, safeJsonParse, sessionIndexFile: SESSION_INDEX_FILE, fsp = require('node:fs/promises') }) {
function claudeProjectsRoot() {
  // e2e 缝:WCW_CLAUDE_PROJECTS_DIR 重定向(stats 与 sweep 共用此根,保证测的就是生产的判定路径)。
  return process.env.WCW_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}
// claude CLI 的项目目录键:把 cwd 的非字母数字字符全部换成 '-'(E:\a\b → E--a-b,与 CLI 实测一致)。
function claudeProjectDirKey(cwd) { return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-'); }
const ENGINE_TRANSCRIPT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/; // claude sessionId 形状(UUID/hex);脏值拒绝入账
const engineTranscriptKnown = new Map(); // sessionId -> { cwd, firstSeen }
let engineTranscriptLedgerLoadPromise = null;
let engineTranscriptLedgerChain = Promise.resolve();
function engineTranscriptLedgerPath() { return path.join(paths.data, 'engine-transcripts.json'); }
function engineTranscriptLedgerLoad() {
  if (engineTranscriptLedgerLoadPromise) return engineTranscriptLedgerLoadPromise;
  engineTranscriptLedgerLoadPromise = (async () => {
  try {
    const raw = safeJsonParse(await fsp.readFile(engineTranscriptLedgerPath(), 'utf8'), null);
    const known = raw && raw.known;
    if (known && typeof known === 'object' && !Array.isArray(known)) {
      for (const [sid, meta] of Object.entries(known)) {
        if (!ENGINE_TRANSCRIPT_ID_RE.test(sid)) continue;
        engineTranscriptKnown.set(sid, { cwd: String((meta && meta.cwd) || ''), firstSeen: String((meta && meta.firstSeen) || '') });
      }
    }
  } catch { /* Unknown or malformed ledger entries never authorize deletion. */ }
  })();
  return engineTranscriptLedgerLoadPromise;
}
async function engineTranscriptLedgerSave() {
  const known = {};
  for (const [sid, meta] of engineTranscriptKnown) known[sid] = { cwd: meta.cwd, firstSeen: meta.firstSeen };
  const thisWrite = engineTranscriptLedgerChain.catch(() => {}).then(() => atomicWriteJson(engineTranscriptLedgerPath(), { version: 1, known }));
  engineTranscriptLedgerChain = thisWrite;
  await thisWrite;
}
// saveSession 钩子:登记本工作台 spawn 的转录 id。仅新 id 落盘(同 id 重复登记零 IO)。
async function recordEngineTranscript(claudeSessionId, cwd) {
  const sid = String(claudeSessionId || '').trim();
  if (!ENGINE_TRANSCRIPT_ID_RE.test(sid)) return;
  await engineTranscriptLedgerLoad();
  if (engineTranscriptKnown.has(sid)) return;
  engineTranscriptKnown.set(sid, { cwd: String(cwd || ''), firstSeen: nowIso() });
  await engineTranscriptLedgerSave().catch(() => {});
}
// Resume compatibility probe used by the Claude turn path. The ledger records the cwd that first
// produced a native session id, which is exactly the Claude project bucket where its transcript lives.
// Unknown ids stay permissive for backward compatibility; the CLI-error retry remains the final guard.
async function engineTranscriptCwd(claudeSessionId) {
  const sid = String(claudeSessionId || '').trim();
  if (!ENGINE_TRANSCRIPT_ID_RE.test(sid)) return '';
  await engineTranscriptLedgerLoad();
  const meta = engineTranscriptKnown.get(sid);
  return String((meta && meta.cwd) || '');
}
// 活引用扫描:所有会话头(v2 头/legacy 全文都有 claudeSessionId 字段;头很小,全扫便宜)。
async function collectLiveClaudeSessionIds() {
  const live = new Set();
  let files = [];
  try { files = await fsp.readdir(paths.sessions); } catch { return live; }
  for (const f of files) {
    if (!f.endsWith('.json') || f === SESSION_INDEX_FILE) continue;
    try {
      const o = safeJsonParse(await fsp.readFile(path.join(paths.sessions, f), 'utf8'), null);
      if (o && typeof o.claudeSessionId === 'string' && ENGINE_TRANSCRIPT_ID_RE.test(o.claudeSessionId)) live.add(o.claudeSessionId);
    } catch { /* 单个坏文件不阻塞扫描 */ }
  }
  return live;
}
async function sweepEngineTranscriptsStore(policy, result) {
  const days = Number(policy.engineTranscriptDays) || 0;
  if (days <= 0) return;
  const cutoffMs = Date.now() - days * 86400000;
  await engineTranscriptLedgerLoad();
  if (!engineTranscriptKnown.size) return;
  const live = await collectLiveClaudeSessionIds();
  const root = claudeProjectsRoot();
  let ledgerDirty = false;
  for (const [sid, meta] of [...engineTranscriptKnown]) {
    if (live.has(sid)) continue; // 活会话引用 → 绝不碰
    const dirKey = claudeProjectDirKey(meta.cwd);
    const file = path.join(root, dirKey, sid + '.jsonl');
    // 防账本脏 cwd 拼出逃逸路径:dirKey 只能含字母数字与 '-',sid 过白名单正则,path.join 结果必在 root 下。
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile()) { engineTranscriptKnown.delete(sid); ledgerDirty = true; continue; } // 转录已不在 → 账本除名
    if (st.mtimeMs > cutoffMs) continue; // 太新 → 保留
    let freed = st.size, unlinked = true;
    await fsp.unlink(file).catch(() => { unlinked = false; });
    if (unlinked) {
      const sideDir = path.join(root, dirKey, sid); // 子代理侧录目录(新版 CLI),存在才连带
      const sideStat = await fsp.stat(sideDir).catch(() => null);
      if (sideStat && sideStat.isDirectory()) {
        const sideBytes = (await dirStat(sideDir)).bytes;
        await fsp.rm(sideDir, { recursive: true, force: true }).catch(() => {});
        freed += sideBytes;
      }
      engineTranscriptKnown.delete(sid); ledgerDirty = true;
      result.freedBytes += freed;
      result.actions.push({ store: 'engineTranscripts', action: 'delete', detail: `${dirKey}/${sid}.jsonl`, bytes: freed });
    }
  }
  if (ledgerDirty) await engineTranscriptLedgerSave().catch(() => {});
}


return { claudeProjectsRoot, claudeProjectDirKey, recordEngineTranscript, engineTranscriptCwd, sweepEngineTranscriptsStore };
}
module.exports = { createEngineTranscriptStore };
