'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { safeJsonParse } = require('./ordinary-json.cjs');
const { normalizeStoragePolicy } = require('./storage-policy.cjs');
const { dirStat } = require('./storage-stat.cjs');

function createStorageSteward({ paths, safeSessionId, nowIso, logEvent, claudeProjectsRoot, sweepEngineTranscriptsStore }) {
  // ============================================================================
  // v1.9 数据管家(Storage Steward)—— 统一保留策略 + 各仓占用统计(专家界面「存储」页签)。
  // 纪律与 journal GC 同源:safety-net,不是闸门 —— 任何清理失败静默(best-effort),绝不阻塞主流程;
  // 清理决策永远基于真实磁盘状态,无缓存猜测。默认策略保守:
  //   logs                 按【文件名日期】保 N 天(确定性,不依赖可被备份工具改写的 mtime)。
  //   agent-runs 事件日志  真终态 run 超 N 天 gzip 归档(仍可读,体积 ÷~10)。只压 STORAGE_ARCHIVE_TERMINAL:
  //                        interrupted 可续跑(恢复时 syncRunEventSeq 要读原文)、paused 等人、running 活着,一律不碰。
  //   webcache             默认【不】自动清 —— v0.9-S9 的设计承诺"离线无价,旧副本仍有用",自动 TTL 会违背它;
  //                        条目上限(LRU 按 mtime)留作用户 opt-in(0=不限)。
  //   引擎转录(P-B)       白名单账本制:只清「本工作台 spawn + 无活会话引用 + 超保留期」三者同时成立的
  //                        ~/.claude/projects 转录(见 sweepEngineTranscriptsStore 块注释的红线)。
  // ============================================================================
  const STORAGE_STEWARD = { sweeping: false, lastAt: null, lastResult: null };
  const STORAGE_ARCHIVE_TERMINAL = new Set(['completed', 'failed', 'stopped', 'cancelled']);

  // 递归占用统计(字节 + 文件数)。cap 防爆(异常巨大的树截断并标记,不拖死请求);任何节点读不到即跳过,
  // 整体永不抛 —— 统计是展示辅助,不是审计依据。
  async function collectStorageStats(config) {
    const defs = [
      ['logs', paths.logs], ['sessions', paths.sessions], ['checkpoints', paths.checkpoints],
      ['agentRuns', paths.agentRuns], ['webcache', paths.webcache], ['uploads', paths.uploads],
      ['usage', paths.usage], ['memory', paths.memory], ['playbooks', paths.playbooks],
      ['skills', paths.skills], ['generated', paths.generated], ['agentWorkflows', paths.agentWorkflows],
      ['agentWorktrees', paths.agentWorktrees],
    ];
    const stores = {}; let totalBytes = 0;
    for (const [key, dir] of defs) { const s = await dirStat(dir); stores[key] = s; totalBytes += s.bytes; }
    // 引擎转录(claude CLI 的 ~/.claude/projects):只读统计;GC 走 sweepEngineTranscriptsStore(白名单账本,
    // 见下)。根目录与 sweep 共用 claudeProjectsRoot()(e2e 可用 WCW_CLAUDE_PROJECTS_DIR 重定向)。
    let engineTranscripts = null;
    try {
      const d = claudeProjectsRoot();
      const s = await dirStat(d);
      if (s.files > 0) engineTranscripts = { path: d, ...s };
    } catch { /* no engine transcripts */ }
    return {
      ok: true,
      dataRoot: paths.data,
      stores,
      totalBytes,
      engineTranscripts,
      policy: normalizeStoragePolicy(config && config.storagePolicy),
      sweep: { running: STORAGE_STEWARD.sweeping, lastAt: STORAGE_STEWARD.lastAt, lastResult: STORAGE_STEWARD.lastResult },
    };
  }

  // logs 保留:workbench-YYYY-MM-DD.ndjson 按文件名日期与 cutoff 字典序比较(零填充日期可序)。
  async function sweepLogsStore(policy, result) {
    const keep = policy.logsKeepDays;
    const cutoff = new Date(Date.now() - keep * 86400000).toISOString().slice(0, 10);
    let files = [];
    try { files = await fsp.readdir(paths.logs); } catch { return; }
    for (const f of files) {
      const m = /^workbench-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(f);
      if (!m || m[1] >= cutoff) continue;
      const p = path.join(paths.logs, f);
      const st = await fsp.stat(p).catch(() => null);
      await fsp.unlink(p).catch(() => {});
      if (st) { result.freedBytes += st.size; result.actions.push({ store: 'logs', action: 'delete', detail: f, bytes: st.size }); }
    }
  }

  // 终态 run 事件日志 gzip 归档:<runId>.events.ndjson → .events.ndjson.gz(tmp+rename 原子替换后再删原文;
  // 崩溃在 rename 与 unlink 之间 → 下次 sweep 见 .gz 已存在,补删原文即可,幂等)。
  async function sweepAgentRunEventsStore(policy, result) {
    const days = policy.agentRunEventsCompressDays;
    if (days <= 0) return;
    const cutoffMs = Date.now() - days * 86400000;
    let sessionDirs = [];
    try { sessionDirs = await fsp.readdir(paths.agentRuns, { withFileTypes: true }); } catch { return; }
    for (const dirent of sessionDirs) {
      if (!dirent.isDirectory() || !safeSessionId(dirent.name)) continue;
      const dir = path.join(paths.agentRuns, dirent.name);
      let files = [];
      try { files = await fsp.readdir(dir); } catch { continue; }
      for (const f of files) {
        const m = /^(run_[A-Za-z0-9_-]+)\.json$/.exec(f);
        if (!m) continue;
        const runId = m[1];
        let run = null;
        try { run = safeJsonParse(await fsp.readFile(path.join(dir, f), 'utf8'), null); } catch { continue; }
        if (!run || !STORAGE_ARCHIVE_TERMINAL.has(String(run.status || ''))) continue;
        let basis = Date.parse(run.updatedAt || run.completedAt || '');
        if (!Number.isFinite(basis)) { const st = await fsp.stat(path.join(dir, f)).catch(() => null); basis = st ? st.mtimeMs : NaN; }
        if (!Number.isFinite(basis) || basis > cutoffMs) continue;
        const eventsFile = path.join(dir, `${runId}.events.ndjson`);
        const gzFile = eventsFile + '.gz';
        const gzTmp = gzFile + '.tmp'; // 单一 tmp 名(tmp+rename 原子替换;崩溃留 .tmp 孤儿由 catch 清理)
        const st = await fsp.stat(eventsFile).catch(() => null);
        if (!st || st.size === 0) continue;
        try {
          if (!fs.existsSync(gzFile)) {
            const gz = zlib.gzipSync(await fsp.readFile(eventsFile));
            await fsp.writeFile(gzTmp, gz);
            await fsp.rename(gzTmp, gzFile);
          }
          await fsp.unlink(eventsFile);
          const gzSize = (await fsp.stat(gzFile).catch(() => null) || {}).size || 0;
          result.freedBytes += Math.max(0, st.size - gzSize);
          result.actions.push({ store: 'agentRuns', action: 'gzip', detail: `${dirent.name}/${runId}.events.ndjson`, bytes: Math.max(0, st.size - gzSize) });
        } catch { await fsp.unlink(gzTmp).catch(() => {}); /* best-effort: 下次 sweep 重试 */ }
      }
    }
  }

  // webcache LRU:超上限按 mtime 删最旧(默认 0=不限,尊重"离线无价"设计,仅用户 opt-in 生效)。
  async function sweepWebcacheStore(policy, result) {
    const max = policy.webcacheMaxEntries;
    if (max <= 0) return;
    let files = [];
    try { files = (await fsp.readdir(paths.webcache)).filter(f => f.endsWith('.json')); } catch { return; }
    if (files.length <= max) return;
    const withMtime = [];
    for (const f of files) {
      const st = await fsp.stat(path.join(paths.webcache, f)).catch(() => null);
      if (st) withMtime.push({ f, mtime: st.mtimeMs, size: st.size });
    }
    withMtime.sort((a, b) => a.mtime - b.mtime);
    for (const victim of withMtime.slice(0, Math.max(0, withMtime.length - max))) {
      await fsp.unlink(path.join(paths.webcache, victim.f)).catch(() => {});
      result.freedBytes += victim.size;
      result.actions.push({ store: 'webcache', action: 'delete', detail: victim.f, bytes: victim.size });
    }
  }

  // 统一 sweep 入口:boot 自动(全目标) + POST /api/storage/clean(可单目标)。进程内串行(并发第二
  // 次调用直接拒绝);结果留痕 STORAGE_STEWARD 并落审计账。targets=null 表示全部。
  async function storageSweep(policy, targets = null) {
    if (STORAGE_STEWARD.sweeping) return { ok: false, error: 'sweep already running' };
    STORAGE_STEWARD.sweeping = true;
    const result = { ok: true, freedBytes: 0, actions: [] };
    try {
      const p = normalizeStoragePolicy(policy);
      const want = k => !targets || targets.has(k);
      if (want('logs')) await sweepLogsStore(p, result);
      if (want('agent-runs')) await sweepAgentRunEventsStore(p, result);
      if (want('webcache')) await sweepWebcacheStore(p, result);
      if (want('engine-transcripts')) await sweepEngineTranscriptsStore(p, result);
      STORAGE_STEWARD.lastAt = nowIso();
      STORAGE_STEWARD.lastResult = { freedBytes: result.freedBytes, actions: result.actions.length };
      if (result.actions.length) logEvent({ kind: 'storage_sweep', freedBytes: result.freedBytes, actions: result.actions.slice(0, 20) });
    } finally { STORAGE_STEWARD.sweeping = false; }
    return result;
  }

  return { collectStorageStats, storageSweep };
}

module.exports = { createStorageSteward };
