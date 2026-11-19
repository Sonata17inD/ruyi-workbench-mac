'use strict';

const WRITE_PATH_ARGS = Object.freeze({ file_write: ['path'], file_edit: ['path'], file_delete: ['path'], file_move: ['from', 'to'], file_copy: ['to'], acceptance_report: ['path'] });

// Ask for permission only after confirming that the tool can write its resolved targets.
function createWriteBoundaryPreflight({ resolveFileToolPath, guardFileToolPath }) {
  async function preflightWriteBoundary(toolName, args, ctx) {
    const keys = Object.prototype.hasOwnProperty.call(WRITE_PATH_ARGS, toolName) ? WRITE_PATH_ARGS[toolName] : null;
    if (!keys || !args || typeof args !== 'object') return null;
    const targets = keys.map(k => args[k]);
    if (toolName === 'file_delete' && Array.isArray(args.paths)) targets.push(...args.paths);
    if ((toolName === 'file_copy' || toolName === 'file_move') && Array.isArray(args.items)) {
      for (const item of args.items) if (item && typeof item === 'object') {
        if (toolName === 'file_move') targets.push(item.from);
        targets.push(item.to);
      }
    }
    for (const target of targets) {
      if (typeof target !== 'string' || !target.trim()) continue;
      let p;
      try { p = await resolveFileToolPath(target, ctx); } catch { continue; }
      const g = await guardFileToolPath(p, ctx, { tool: toolName, write: true });
      if (!g.ok) return { ok: false, error: g.error, code: g.code, path: p };
    }
    return null;
  }
  return preflightWriteBoundary;
}

module.exports = { createWriteBoundaryPreflight };
