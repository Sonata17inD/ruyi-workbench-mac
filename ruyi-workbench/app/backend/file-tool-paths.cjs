'use strict';
const path = require('node:path');
const os = require('node:os');

// File arguments are paths, not shell expressions. Preserve percent signs and backslashes on Mac.
function expandFileToolPath(raw, home = os.homedir()) {
  const s = String(raw == null ? '' : raw);
  if (s.includes('\0')) {
    const error = new TypeError('File path must not contain null bytes');
    error.code = 'ERR_INVALID_ARG_VALUE'; throw error;
  }
  return (s === '~' || s.startsWith('~/')) && home ? home + s.slice(1) : s;
}
function createFileToolPaths({ loadSession, readConfig, normalizeCwd, getMcpSessionId }) {
async function fileToolWorkspaceDir(ctx) {
  const session = ctx && ctx.session;
  const fromCtx = (ctx && ctx.workingDir) || (session && session.cwd);
  if (fromCtx) return path.resolve(String(fromCtx));
  const sid = getMcpSessionId();
  if (sid) {
    try {
      const s = await loadSession(sid);
      if (s && s.cwd) return path.resolve(String(s.cwd));
    } catch { /* fall through */ }
  }
  const cfg = (ctx && ctx.config) || await readConfig().catch(() => null);
  return normalizeCwd(null, cfg && cfg.defaultWorkspace);
}

async function resolveFileToolRoot(args, ctx) {
  return args && args.root ? resolveFileToolPath(args.root, ctx) : fileToolWorkspaceDir(ctx);
}
async function resolveFileToolPath(raw, ctx) {
  const s = expandFileToolPath(raw);
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(await fileToolWorkspaceDir(ctx), s);
}
  return { fileToolWorkspaceDir, resolveFileToolRoot, resolveFileToolPath };
}
module.exports = { createFileToolPaths, expandFileToolPath };
