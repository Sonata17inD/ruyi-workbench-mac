'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { MAX_BODY_BYTES } = require('./http-protocol.cjs');
const { pathWithinRoot } = require('./path-containment.cjs');
const { kimiAcpRequestError, kimiAcpAssertSession } = require('./kimi-acp-rpc.cjs');
const { kimiCodeHome, kimiWireSessionDir } = require('./kimi-wire.cjs');

function createKimiAcpFiles({ realpathForContainment, kimiAcpSamePath, guardFileToolPath,
  ensureKimiAcpOperationPermission, toolCall, normalizeTodoItems }) {
  // Kimi's native plan mode stores one markdown file below either the active ACP session's
  // agents/<agent>/plans directory or (for older runtimes) the workspace's plan directory.
  // These files are protocol state, not arbitrary out-of-workspace file access: EnterPlanMode
  // deliberately reads the file before it has been created, and Kimi expects that first read
  // to behave like an empty document. Keep the exception constrained to one direct .md child
  // of those exact directories so normal ACP filesystem requests still use the shared guard.
  function isKimiAcpPlanFilename(rawPath) {
    if (!rawPath || !path.isAbsolute(rawPath)) return false;
    const filename = path.basename(path.resolve(String(rawPath)));
    return Boolean(filename && !filename.startsWith('.') && filename.length <= 200 && /\.md$/i.test(filename)
      && !/[<>:"/\\|?*\u0000-\u001f]/.test(filename));
  }

  function isKimiAcpPlanFilePath(rawPath, context) {
    if (!isKimiAcpPlanFilename(rawPath)) return false;
    const absPath = path.resolve(String(rawPath));

    const nativeSessionId = String(context && context.reg && context.reg.nativeSessionId || '');
    const nativeDirRaw = nativeSessionId ? kimiWireSessionDir(nativeSessionId) : '';
    if (nativeDirRaw && path.isAbsolute(nativeDirRaw)) {
      const nativeDir = path.resolve(nativeDirRaw);
      const kimiHome = path.resolve(kimiCodeHome());
      const agentsRoot = path.join(nativeDir, 'agents');
      const relative = path.relative(agentsRoot, absPath);
      const parts = relative.split(path.sep);
      if (pathWithinRoot(nativeDir, kimiHome) && pathWithinRoot(absPath, agentsRoot)
        && parts.length === 3 && /^[A-Za-z0-9_-]{1,128}$/.test(parts[0])
        && parts[1].toLowerCase() === 'plans') return true;
    }

    // Legacy runtimes do not expose the session tree. Keep this compatibility path tied to the exact
    // current file named by the ACP plan update; an arbitrary cwd/plan/*.md must stay on the normal guard.
    const known = context && context.reg && context.reg.kimiAcpPlanFile;
    if (!known || !kimiAcpSamePath(known, absPath)) return false;
    const cwdRaw = context && context.session && context.session.cwd;
    if (!cwdRaw) return false;
    const legacyPlanDir = path.join(path.resolve(cwdRaw), 'plan');
    const relative = path.relative(legacyPlanDir, absPath);
    return pathWithinRoot(absPath, legacyPlanDir) && relative !== '' && !relative.includes(path.sep);
  }

  // The synchronous shape check above describes lexical paths for offline callers. The actual ACP
  // exception must use canonical paths so OS aliases do not fail before containment is checked:
  // resolve the nearest existing ancestor so a missing plan file can still be created, but a symlink/junction
  // in either the session tree or its parent cannot redirect the write outside KIMI_CODE_HOME/session state.
  async function resolveKimiAcpPlanFilePath(rawPath, context) {
    if (!isKimiAcpPlanFilename(rawPath)) return '';
    const absPath = path.resolve(String(rawPath));
    const realPath = await realpathForContainment(absPath);
    if (!isKimiAcpPlanFilename(realPath)) return '';
    const nativeSessionId = String(context && context.reg && context.reg.nativeSessionId || '');
    const nativeDirRaw = nativeSessionId ? kimiWireSessionDir(nativeSessionId) : '';
    if (nativeDirRaw && path.isAbsolute(nativeDirRaw)) {
      const nativeDir = await realpathForContainment(nativeDirRaw);
      const home = await realpathForContainment(kimiCodeHome());
      // Resolve the root from its lexical session path, then prove both containment edges. In particular,
      // do not treat a realpath'd agents directory as trusted merely because it contains the plan file:
      // agents itself may be a junction to an external tree.
      const agentsRoot = await realpathForContainment(path.join(path.resolve(nativeDirRaw), 'agents'));
      const expectedAgentsRoot = path.join(nativeDir, 'agents');
      const relative = path.relative(agentsRoot, realPath);
      const parts = relative ? relative.split(path.sep) : [];
      if (pathWithinRoot(nativeDir, home) && pathWithinRoot(agentsRoot, nativeDir)
        && kimiAcpSamePath(agentsRoot, expectedAgentsRoot) && pathWithinRoot(realPath, agentsRoot)
        && parts.length === 3 && /^[A-Za-z0-9_-]{1,128}$/.test(parts[0])
        && parts[1].toLowerCase() === 'plans') return realPath;
    }

    // Legacy cwd/plan is only an exception after the ACP plan update identified the exact current file.
    // Unknown legacy .md paths deliberately fall back to the ordinary read/write guard.
    const known = context && context.reg && context.reg.kimiAcpPlanFile;
    if (!known || !kimiAcpSamePath(await realpathForContainment(known), realPath)) return '';
    const cwdRaw = context && context.session && context.session.cwd;
    if (!cwdRaw) return '';
    const cwd = await realpathForContainment(cwdRaw);
    const legacyRoot = await realpathForContainment(path.join(path.resolve(cwdRaw), 'plan'));
    const expectedLegacyRoot = path.join(cwd, 'plan');
    const relative = path.relative(legacyRoot, realPath);
    return pathWithinRoot(legacyRoot, cwd) && kimiAcpSamePath(legacyRoot, expectedLegacyRoot)
      && pathWithinRoot(realPath, legacyRoot) && relative && !relative.includes(path.sep) ? realPath : '';
  }

  function kimiAcpTextLines(text) {
    return String(text || '').match(/[^\n]*\n|[^\n]+$/g) || [];
  }

  async function handleKimiAcpFsRequest(method, params, context) {
    kimiAcpAssertSession(params, context);
    const rawPath = String(params && params.path || '');
    if (!rawPath || !path.isAbsolute(rawPath)) throw kimiAcpRequestError(-32602, 'ACP filesystem path must be absolute');
    const write = method === 'fs/write_text_file';
    const internalPlanPath = await resolveKimiAcpPlanFilePath(rawPath, context);
    const internalPlanFile = Boolean(internalPlanPath);
    const guard = internalPlanFile
      ? { ok: true, absPath: internalPlanPath }
      : await guardFileToolPath(rawPath, { session: context.session, config: context.config }, { tool: write ? 'kimi_acp_write' : 'kimi_acp_read', write });
    if (!guard.ok) throw kimiAcpRequestError(-32000, guard.error);
    if (!write) {
      const stat = await fsp.stat(guard.absPath).catch(() => null);
      if (!stat && internalPlanFile) return { content: '' };
      if (!stat || !stat.isFile()) throw kimiAcpRequestError(-32002, 'Resource not found');
      if (stat.size > 50 * 1024 * 1024) throw kimiAcpRequestError(-32000, 'Text file is larger than the 50 MB ACP read limit');
      const text = await fsp.readFile(guard.absPath, 'utf8');
      if (params.line == null && params.limit == null) return { content: text };
      const line = Math.max(1, Math.trunc(Number(params.line) || 1));
      const limit = params.limit == null ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.trunc(Number(params.limit) || 0));
      return { content: kimiAcpTextLines(text).slice(line - 1, line - 1 + limit).join('') };
    }
    const content = String(params && params.content || '');
    if (Buffer.byteLength(content, 'utf8') > MAX_BODY_BYTES) throw kimiAcpRequestError(-32602, 'ACP file content exceeds the write limit');
    if (internalPlanFile) {
      try {
        await fsp.mkdir(path.dirname(guard.absPath), { recursive: true });
        await fsp.writeFile(guard.absPath, content, 'utf8');
        return {};
      } catch (error) {
        throw kimiAcpRequestError(-32000, error && error.message || 'Plan file write failed');
      }
    }
    await ensureKimiAcpOperationPermission(context, 'write', { path: guard.absPath });
    const result = await toolCall('file_write', { path: guard.absPath, content, createDirs: true }, {
      session: context.session, config: context.config, workingDir: context.session.cwd,
    });
    if (!result || result.ok === false) throw kimiAcpRequestError(-32000, result && result.error || 'File write failed');
    return {};
  }

  function kimiAcpApplyPlan(update, session, onEvent) {
    // Stable ACP `plan` carries entries at the update root; the experimental `plan_update` shape nests
    // them under plan:{type:'items', entries}. Preserve the complete native shape even when Ruyi cannot
    // project a future file/markdown plan into its todo list yet.
    const plan = update && update.sessionUpdate === 'plan_update' && update.plan && typeof update.plan === 'object'
      ? update.plan : update;
    session.kimiAcpPlan = plan && typeof plan === 'object' ? plan : null;
    const planId = kimiAcpPlanIdFromUpdate(update);
    if (planId) session.kimiAcpPlanId = planId;
    const rows = Array.isArray(plan && plan.entries) ? plan.entries
      : (Array.isArray(plan && plan.items) ? plan.items : []);
    if (!rows.length) {
      if ((update && update.sessionUpdate === 'plan') || (plan && plan.type === 'items')) {
        session.todos = [];
        onEvent({ type: 'todo', items: [], source: 'kimi-acp' });
      }
      return;
    }
    const items = normalizeTodoItems(rows.map((row, index) => ({
      id: row && (row.id || row.planEntryId) || `kimi-plan-${index + 1}`,
      text: row && (row.content || row.text || row.title) || '',
      status: /complete|done/i.test(String(row && row.status || '')) ? 'done'
        : /progress|active/i.test(String(row && row.status || '')) ? 'in_progress' : 'pending',
    })));
    session.todos = items;
    onEvent({ type: 'todo', items, source: 'kimi-acp' });
  }

  function kimiAcpPlanFileFromUpdate(update) {
    const plan = update && update.plan && typeof update.plan === 'object' ? update.plan : null;
    if (plan && plan.type === 'file') {
      const uri = String(plan.uri || '').trim();
      if (!uri) return '';
      try {
        const parsed = new URL(uri);
        if (parsed.protocol !== 'file:' || parsed.search || parsed.hash) return '';
        const filePath = fileURLToPath(parsed);
        return path.isAbsolute(filePath) && /\.md$/i.test(path.basename(filePath)) ? path.resolve(filePath) : '';
      } catch {
        return '';
      }
    }
    const candidates = [
      update && update.filePath, update && update.file_path, update && update.planFile, update && update.plan_file,
      update && update.planPath, update && update.plan_path,
      plan && plan.filePath, plan && plan.file_path, plan && plan.planFile, plan && plan.plan_file,
      plan && plan.planPath, plan && plan.plan_path,
    ];
    for (const candidate of candidates) {
      const value = String(candidate || '').trim();
      if (value && path.isAbsolute(value) && /\.md$/i.test(path.basename(value))) return path.resolve(value);
    }
    return '';
  }

  function kimiAcpPlanIdFromUpdate(update) {
    const plan = update && update.plan && typeof update.plan === 'object' ? update.plan : null;
    return String(update && (update.planId || update.plan_id) || plan && (plan.planId || plan.plan_id) || '');
  }

  function kimiAcpPlanMarkdownFromItems(plan) {
    const rows = Array.isArray(plan && plan.entries) ? plan.entries
      : (Array.isArray(plan && plan.items) ? plan.items : []);
    return rows.map((row, index) => {
      const text = String(row && (row.content || row.text || row.title) || '').trim();
      if (!text) return '';
      const status = String(row && row.status || '').toLowerCase();
      const mark = /complete|done/.test(status) ? 'x' : /progress|active/.test(status) ? '~' : ' ';
      return `- [${mark}] ${text}`;
    }).filter(Boolean).join('\n');
  }

  async function kimiAcpReadPlanSnapshotFile(rawPath, context) {
    const internal = await resolveKimiAcpPlanFilePath(rawPath, context);
    const guard = internal
      ? { ok: true, absPath: internal }
      : await guardFileToolPath(rawPath, { session: context.session, config: context.config }, { tool: 'kimi_acp_plan_snapshot', write: false });
    if (!guard || !guard.ok) return { ok: false, reason: String(guard && guard.error || 'plan file is outside the read guard') };
    const stat = await fsp.stat(guard.absPath).catch(() => null);
    if (!stat) return { ok: true, path: guard.absPath, markdown: '' };
    if (!stat.isFile()) return { ok: false, reason: 'plan URI does not resolve to a regular file' };
    if (stat.size > 1024 * 1024) return { ok: false, reason: 'plan snapshot exceeds the 1 MiB read limit' };
    const handle = await fsp.open(guard.absPath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size);
      const read = stat.size ? await handle.read(buffer, 0, stat.size, 0) : { bytesRead: 0 };
      if (read.bytesRead > 1024 * 1024) return { ok: false, reason: 'plan snapshot exceeds the 1 MiB read limit' };
      return { ok: true, path: guard.absPath, markdown: buffer.subarray(0, read.bytesRead).toString('utf8') };
    } finally { await handle.close().catch(() => {}); }
  }

  async function kimiAcpPlanSnapshotFromUpdate(update, context) {
    const plan = update && update.plan && typeof update.plan === 'object' ? update.plan : null;
    const planId = kimiAcpPlanIdFromUpdate(update);
    if (!plan || !planId) return { ok: false, reason: 'plan update has no planId' };
    if (plan.type === 'markdown') {
      const markdown = String(plan.content || '');
      if (Buffer.byteLength(markdown, 'utf8') > 1024 * 1024) return { ok: false, reason: 'markdown plan exceeds the 1 MiB snapshot limit' };
      return { ok: true, planId, markdown, path: '' };
    }
    if (plan.type === 'items') return { ok: true, planId, markdown: kimiAcpPlanMarkdownFromItems(plan), path: '' };
    if (plan.type === 'file') {
      const filePath = kimiAcpPlanFileFromUpdate(update);
      if (!filePath) return { ok: false, reason: 'plan file URI is not a local absolute file path' };
      const result = await kimiAcpReadPlanSnapshotFile(filePath, context);
      return result.ok ? { ...result, planId } : { ok: false, reason: result.reason };
    }
    return { ok: false, reason: 'unsupported Kimi ACP plan type' };
  }

  return {
    isKimiAcpPlanFilePath, resolveKimiAcpPlanFilePath, handleKimiAcpFsRequest,
    kimiAcpApplyPlan, kimiAcpPlanFileFromUpdate, kimiAcpPlanIdFromUpdate, kimiAcpPlanSnapshotFromUpdate,
  };
}

module.exports = { createKimiAcpFiles };
