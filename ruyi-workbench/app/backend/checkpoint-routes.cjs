'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { PREVIEW_TEXT_EXTS } = require('./file-preview.cjs');
const { apiFailure, apiSessionIdInvalid, apiSessionNotFound, json, readJsonBody, send } = require('./http-protocol.cjs');

function createCheckpointRoutes({
  tokenOk, safeSessionId, readConfig, loadSession, mutateSession, mutateConfig, nowIso, logEvent,
  execution, journal, editor, storage, process = globalThis.process,
}) {
  const { activeChildren, activeAgentRuns, rewindSession } = execution;
  const { journalReadIndex, journalDir, journalRollback, journalRevertLogRecord,
    workspaceBaselinePathKey, workspaceBaselineIsCodePath, bumpMissionChangeSeq } = journal;
  const { guardWorkspacePath, resolvePreferredCodeEditor, buildCodeEditorSpawn, materializeCheckpointEditorDiff, launchCodeEditor } = editor;
  const { normalizeStoragePolicy, storageSweep } = storage;

  async function handleCheckpointQueryApiRoutes(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/checkpoints') {
      // F2 (安全·泄露面): this GET exposes the file-change history. It is a GET, so it never runs through the
      // mutating auth block above — the token gate MUST be applied here in the handler. The UI's api() always
      // sends the token, so it is unaffected; only tokenless local processes are refused.
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const sessionId = safeSessionId(new URL(req.url, 'http://x').searchParams.get('sessionId')); // F4
      if (!sessionId) return send(res, apiSessionIdInvalid());
      const entries = await journalReadIndex(sessionId);
      // v1.4.1: 附上每条目当前磁盘大小(改动后状态),前端可显示「原 X → 现 Y」的大小变化 + 判定是否值得看 diff。
      const enriched = await Promise.all(entries.map(async e => {
        let currentBytes = null;
        if (e && e.path) { try { const st = await fsp.stat(e.path); currentBytes = st.isFile() ? st.size : null; } catch { currentBytes = null; } }
        return { ...e, currentBytes };
      }));
      const totalBytes = entries.reduce((s, e) => s + (Number(e.bytes) || 0), 0);
      return send(res, json({ ok: true, entries: enriched, totalBytes }));
    }
    // User-clicked handoff to the configured Mac editor for code files. POST body:
    // {sessionId,turnSeq,entrySeq?,action:'diff'|'open'}. Omit entrySeq to open every distinct code-file diff
    // in the turn (bounded to 12). Unlike office_open this never hands source files to an arbitrary association:
    // resolvePreferredCodeEditor accepts only known editors or IDEs.
    if (req.method === 'POST' && pathname === '/api/checkpoints/open-external') {
      if (process.platform !== 'darwin') return send(res, apiFailure('editor.platform_unsupported', {}, '仅支持 macOS', 400));
      const body = await readJsonBody(req);
      const sessionId = safeSessionId(body && body.sessionId);
      const turnSeq = Number(body && body.turnSeq);
      const hasEntrySeq = body && body.entrySeq !== undefined && body.entrySeq !== null && body.entrySeq !== '';
      const entrySeq = hasEntrySeq ? Number(body.entrySeq) : null;
      const action = body && body.action === 'open' ? 'open' : 'diff';
      if (!sessionId) return send(res, apiSessionIdInvalid());
      if (!Number.isInteger(turnSeq) || turnSeq < 0 || (hasEntrySeq && (!Number.isInteger(entrySeq) || entrySeq < 0))) {
        return send(res, apiFailure('checkpoint.reference_invalid', {}, 'invalid turnSeq or entrySeq', 400));
      }
      if (action === 'open' && !hasEntrySeq) return send(res, apiFailure('checkpoint.reference_invalid', {}, 'entrySeq is required for open', 400));
      const session = await loadSession(sessionId);
      if (!session) return send(res, apiSessionNotFound());
      const config = await readConfig();
      const turnEntries = (await journalReadIndex(sessionId))
        .filter(e => e && Number(e.turnSeq) === turnSeq)
        .sort((a, b) => Number(a.entrySeq) - Number(b.entrySeq));
      let targets = hasEntrySeq ? turnEntries.filter(e => Number(e.entrySeq) === entrySeq) : turnEntries;
      if (!targets.length) return send(res, apiFailure('checkpoint.not_found', {}, 'entry not found', 404));
      if (!hasEntrySeq) {
        const earliestByPath = new Map();
        for (const entry of targets) {
          const key = workspaceBaselinePathKey(entry.path);
          if (!earliestByPath.has(key)) earliestByPath.set(key, entry);
        }
        targets = [...earliestByPath.values()].slice(0, 12);
      }
      const opened = [], failed = [];
      for (const entry of targets) {
        const sourcePath = String(entry.path || '');
        if (!workspaceBaselineIsCodePath(sourcePath)) { failed.push({ entrySeq: entry.entrySeq, reason: '不是支持的代码/文本文件' }); continue; }
        const guard = await guardWorkspacePath(sourcePath, session, config);
        if (!guard.ok) { failed.push({ entrySeq: entry.entrySeq, reason: guard.error }); continue; }
        let exists = false;
        try { exists = (await fsp.stat(guard.absPath)).isFile(); } catch { exists = false; }
        if (entry.op !== 'delete' && !exists) { failed.push({ entrySeq: entry.entrySeq, reason: '当前文件不存在' }); continue; }
        const editor = resolvePreferredCodeEditor(sourcePath);
        if (!editor) { failed.push({ entrySeq: entry.entrySeq, reason: '未检测到安全的本机代码编辑器；请先为任一代码文件选择默认编辑器' }); continue; }
        let spawnSpec;
        if (action === 'open') {
          if (entry.op === 'delete') { failed.push({ entrySeq: entry.entrySeq, reason: '文件已删除，请使用 Diff 查看删除前内容' }); continue; }
          spawnSpec = buildCodeEditorSpawn(editor, 'open', '', guard.absPath);
        } else {
          const materialized = await materializeCheckpointEditorDiff(sessionId, entry, exists ? guard.absPath : '');
          if (!materialized.ok) { failed.push({ entrySeq: entry.entrySeq, reason: materialized.error }); continue; }
          spawnSpec = buildCodeEditorSpawn(editor, 'diff', materialized.beforePath, materialized.afterPath);
          // Generic safe editors have no command-line diff contract. Keep the browser's internal diff as the
          // comparison view and open the meaningful side in the native editor (before for a deletion).
          if (spawnSpec.diffUnsupported) spawnSpec.args = [...(spawnSpec.fileOpenPrefix || []), entry.op === 'delete' ? materialized.beforePath : materialized.afterPath];
        }
        if (!spawnSpec.ok || !await launchCodeEditor(spawnSpec)) {
          failed.push({ entrySeq: entry.entrySeq, reason: spawnSpec.error || '无法启动本机编辑器' });
          continue;
        }
        opened.push({ entrySeq: Number(entry.entrySeq), editor: spawnSpec.editor, mode: spawnSpec.mode,
          source: spawnSpec.source, diffSupported: !spawnSpec.diffUnsupported });
      }
      if (!opened.length) {
        const reason = failed[0] && failed[0].reason || '没有可打开的代码改动';
        return send(res, apiFailure('editor.open_failed', { failed: failed.length }, reason, 409));
      }
      logEvent({ kind: 'checkpoint_external_open', sessionId, turnSeq, action, opened: opened.length,
        failed: failed.length, editor: opened[0].editor, mode: opened[0].mode });
      return send(res, json({ ok: true, action, opened, failed, limited: !hasEntrySeq && turnEntries.length > targets.length }));
    }
    // v1.4.1: 单条变更的「改动前↔现在」对比。GET /api/checkpoints/diff?sessionId=&turnSeq=&entrySeq=
    // before = 本地 .gz 快照(create 无);after = 当前磁盘文件(delete 无)。文本文件返回内容(前端渲染 diff),
    // 二进制/过大只返回字节数。token-gated(GET 不走上面的变更类鉴权块,此处显式校验)。path 取自我方 journal
    // 索引(非用户输入,零穿越面);内容为工作台自身写过的文件,不新增暴露面(是 /api/file/preview 的严格子集)。
    if (req.method === 'GET' && pathname === '/api/checkpoints/diff') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const q = new URL(req.url, 'http://x').searchParams;
      const sessionId = safeSessionId(q.get('sessionId'));
      if (!sessionId) return send(res, apiSessionIdInvalid());
      const turnSeq = Number(q.get('turnSeq')), entrySeq = Number(q.get('entrySeq'));
      if (!Number.isInteger(turnSeq) || !Number.isInteger(entrySeq) || turnSeq < 0 || entrySeq < 0) {
        return send(res, apiFailure('checkpoint.reference_invalid', {}, 'invalid turnSeq or entrySeq', 400));
      }
      const idx = await journalReadIndex(sessionId);
      const entry = idx.find(e => e && Number(e.turnSeq) === turnSeq && Number(e.entrySeq) === entrySeq);
      if (!entry) return send(res, apiFailure('checkpoint.not_found', {}, 'entry not found', 404));
      const p = String(entry.path || '');
      const ext = String(path.extname(p).replace(/^\./, '')).toLowerCase();
      const DIFF_TEXT_MAX = 256 * 1024; // 单侧文本上限;超限只给大小
      const textish = PREVIEW_TEXT_EXTS.has(ext) || ext === '' || ext === 'log';
      let beforeBuf = null, afterBuf = null;
      if (entry.op !== 'create' && !entry.skipped) {
        try { beforeBuf = zlib.gunzipSync(await fsp.readFile(path.join(journalDir(sessionId), `${turnSeq}-${entrySeq}.gz`))); } catch { beforeBuf = null; }
      }
      if (entry.op !== 'delete') { try { afterBuf = await fsp.readFile(p); } catch { afterBuf = null; } }
      const looksBinary = b => !!b && b.slice(0, 8192).includes(0);
      const tooBig = b => !!b && b.length > DIFF_TEXT_MAX;
      const out = { ok: true, op: entry.op, path: p, skipped: !!entry.skipped,
        beforeBytes: beforeBuf ? beforeBuf.length : (entry.op === 'create' ? 0 : (Number(entry.bytes) || null)),
        afterBytes: afterBuf ? afterBuf.length : (entry.op === 'delete' ? 0 : (Number(entry.currentBytes) || null)) };
      if (textish && !looksBinary(beforeBuf) && !looksBinary(afterBuf) && !tooBig(beforeBuf) && !tooBig(afterBuf)) {
        out.isText = true;
        out.before = beforeBuf ? beforeBuf.toString('utf8') : '';
        out.after = afterBuf ? afterBuf.toString('utf8') : '';
      } else {
        out.isText = false; out.binary = true;
      }
      return send(res, json(out));
    }
  }

  // 撤销状态落到那一轮的 turnSummary 上（按轮号＋解析后的绝对路径对上）：刷新／重开之后「本轮变更」卡与产物 chip
  // 照实画「已撤销」，不再给一枚点了也撤不动的「撤销」、也不再给一个已经被删掉的新建文件的「打开」。
  // 旁路写入：失败不影响撤销本身（文件已经回滚、索引已经移除），最坏是卡片仍可点、点了回「没有可撤销的改动」。
  async function markTurnSummaryReverted(sessionId, turnSeq, reverted) {
    const list = (Array.isArray(reverted) ? reverted : []).filter(r => r && r.path);
    const revertedPaths = new Set(list.map(r => path.resolve(String(r.path))));
    const removedPaths = new Set(list.filter(r => r.op === 'create').map(r => path.resolve(String(r.path))));   // 撤掉的是「新建」→ 文件已删，产物 chip 不再给「打开」
    if (!revertedPaths.size || !Number.isFinite(turnSeq)) return;
    const at = nowIso();
    await mutateSession(sessionId, fresh => {
      let touched = false;
      for (const m of (Array.isArray(fresh.messages) ? fresh.messages : [])) {
        const ts = m && m.role === 'assistant' && m.turnSummary;
        if (!ts || Number(ts.turnSeq) !== turnSeq) continue;
        for (const f of (Array.isArray(ts.filesChanged) ? ts.filesChanged : [])) {
          if (f && f.path && !f.reverted && revertedPaths.has(path.resolve(String(f.path)))) { f.reverted = true; f.revertedAt = at; touched = true; }
        }
        for (const a of (Array.isArray(ts.artifacts) ? ts.artifacts : [])) {
          if (a && a.path && !a.reverted && removedPaths.has(path.resolve(String(a.path)))) { a.reverted = true; touched = true; }
        }
      }
      return touched ? {} : { abort: true };
    }, { writer: 'checkpoint_rollback_mark' });
  }

  // ── checkpoint·storage 域:/api/storage/policy|clean、/api/checkpoints/rollback、/api/session/rewind ──
  async function handleCheckpointApiRoutes(req, res, pathname) {
    if (req.method === 'POST' && pathname === '/api/storage/policy') {
      const body = await readJsonBody(req);
      const src = (body && typeof body === 'object')
        ? (body.storagePolicy && typeof body.storagePolicy === 'object' ? body.storagePolicy : body)
        : {};
      // 117n-M2:走 mutateConfig 的临界区(此前裸 readConfig -> 改字段 -> writeConfig,与并发的
      // /api/config 保存互相吞:一次并发就能让刚存的存储策略或刚存的 Provider 其中一份凭空消失)。
      const saved = (await mutateConfig(async (config) => {
        config.storagePolicy = { ...(config.storagePolicy || {}), ...src };
      })).config;
      return send(res, json({ ok: true, policy: normalizeStoragePolicy(saved.storagePolicy) }));
    }
    if (req.method === 'POST' && pathname === '/api/storage/clean') {
      const body = await readJsonBody(req);
      const VALID = new Set(['logs', 'agent-runs', 'webcache', 'engine-transcripts']);
      let targets = null; // null = 全部
      if (body && body.target && body.target !== 'all') {
        const t = String(body.target);
        if (!VALID.has(t)) return send(res, json({ ok: false, error: 'unknown target' }, 400));
        targets = new Set([t]);
      }
      const config = await readConfig();
      return send(res, json(await storageSweep(config.storagePolicy, targets)));
    }
    // v0.8-S4a: checkpoint rollback (mutating; header-token — see needsToken whitelist above). entrySeq given
    // = single-entry rollback; omitted = whole turn (all entries for turnSeq, reverse order). Idempotent:
    // reverted entries are removed from the index, so re-rolling the same turn → {ok:false,error:'no entries'}.
    if (req.method === 'POST' && pathname === '/api/checkpoints/rollback') {
      const body = await readJsonBody(req);
      const sessionId = safeSessionId(body.sessionId); // F4: consume only well-formed ids
      if (!sessionId) return send(res, apiSessionIdInvalid());
      if (body.turnSeq === undefined || body.turnSeq === null) return send(res, json({ ok: false, error: 'turnSeq is required' }, 400));
      // F1: refuse rollback while a turn is live for this session — same guard/wording as /api/session/rewind.
      // The three index.json writers (journalRecord / journalGc / journalRollback) all do an unlocked
      // read-modify-write; letting rollback through during an active turn races those writers and can drop
      // an update (lost-write on the shared index). rewindSession has this guard internally; the direct
      // rollback route did not, so add it here BEFORE calling journalRollback.
      if (activeChildren.has(sessionId)) return send(res, json({ ok: false, error: '回合进行中,请先停止' }, 409));
      if ([...activeAgentRuns.values()].some(live => live && live.run && live.run.sessionId === sessionId && !live.closing)) {
        return send(res, json({ ok: false, error: '班组 Run 进行中,请先停止' }, 409));
      }
      const rollback = await journalRollback(sessionId, body.turnSeq, body.entrySeq);
      if (rollback && rollback.ok) {
        await bumpMissionChangeSeq(sessionId, {
          type: 'rewind',
          cursor: { turnSeq: Number(body.turnSeq), ...(body.entrySeq == null ? {} : { entrySeq: Number(body.entrySeq) }) },
          detail: {
            rollbackScope: body.entrySeq == null ? 'turn' : 'entry',
            filesReverted: Array.isArray(rollback.reverted) ? rollback.reverted.length : 0,
            filesFailed: Array.isArray(rollback.failed) ? rollback.failed.length : 0,
          },
        });
        await markTurnSummaryReverted(sessionId, Number(body.turnSeq), rollback.reverted).catch(() => {});
        // C4:记下「用户撤销了哪回合的什么」—— checkpoint_list 据此标 reverted,下一个 provider 回合起跑时 09 把它写成一行告知
        // 追加到那条 user 消息(见 02 journalRevertLogRecord 头注)。旁路写,失败只是模型少收到一句告知。
        await journalRevertLogRecord(sessionId, rollback.reverted).catch(() => {});
      }
      return send(res, json(rollback));
    }
    // v0.8-S4b: conversation REWIND (mutating; header-token — see needsToken whitelist above). Truncates the
    // session to just before `targetTurnSeq`, clears providerHistory (lazy-reseed rebuilds it), optionally
    // rolls back the discarded turns' files. Returns {ok, removedTurns, lastUserText, filesReverted, filesFailed}.
    if (req.method === 'POST' && pathname === '/api/session/rewind') {
      const body = await readJsonBody(req);
      const sessionId = safeSessionId(body.sessionId); // F4
      if (!sessionId) return send(res, apiSessionIdInvalid());
      if (body.targetTurnSeq === undefined || body.targetTurnSeq === null) return send(res, apiFailure('request.field_required', { field: 'targetTurnSeq' }, 'targetTurnSeq is required', 400));
      const guarded = body.guardExecution === true || Object.prototype.hasOwnProperty.call(body, 'expectedExecution') || Object.prototype.hasOwnProperty.call(body, 'expectedIdleState');
      const result = await rewindSession(sessionId, body.targetTurnSeq, !!body.rollbackFiles,
        guarded ? { guardExecution: true, expectedExecution: body.expectedExecution, expectedIdleState: body.expectedIdleState } : {});
      if (guarded && result && result.ok === false && ['execution_identity_required', 'execution_identity_unavailable',
        'execution_changed', 'rewind_in_progress', 'rewind_settle_timeout'].includes(result.error)) {
        return send(res, apiFailure(result.error, {}, result.error, 409));
      }
      return send(res, json(result));
    }
    return false;
  }

  return { handleCheckpointQueryApiRoutes, handleCheckpointApiRoutes };
}

module.exports = { createCheckpointRoutes };
