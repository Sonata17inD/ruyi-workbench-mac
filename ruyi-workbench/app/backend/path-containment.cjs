'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function macPathAnchor(input) {
  let current = path.resolve(input);
  const missing = [];
  for (;;) {
    try { return { path: current, stat: fs.statSync(current, { bigint: true }), missing }; }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      missing.unshift(path.basename(current)); current = parent;
    }
  }
}
function sameFileIdentity(left, right) {
  return left && right && left.ino !== 0n && left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}
function macAnchorIgnoresAsciiCase(anchor) {
  if (!anchor.stat.isDirectory()) return false;
  let current = anchor.path;
  let stat = anchor.stat;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return false;
    let parentStat;
    try { parentStat = fs.statSync(parent, { bigint: true }); } catch { return false; }
    // A mountpoint name is looked up on its parent's volume, not the mounted filesystem.
    if (stat.dev !== parentStat.dev) return false;
    const name = path.basename(current);
    const alternate = name.replace(/[a-zA-Z]/, c => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
    if (alternate !== name) {
      try {
        const original = fs.lstatSync(current, { bigint: true });
        const alternateStat = fs.lstatSync(path.join(parent, alternate), { bigint: true });
        return original.isDirectory() && alternateStat.isDirectory() && sameFileIdentity(original, alternateStat);
      } catch { return false; }
    }
    current = parent; stat = parentStat;
  }
}
// Compare path segments and check actual Mac volume identity for alternate spellings.
function pathWithinRoot(target, root) {
  const rel = path.relative(root, target);
  if (rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) return true;
  if (process.platform !== 'darwin') return false;
  // Only a spelling/OS-alias candidate needs identity I/O. This is a prefilter, never authorization.
  const spelling = p => path.resolve(p).replace(/^\/System\/Volumes\/Data(?=\/)/i, '')
    .replace(/^\/(var|tmp|etc)(?=\/|$)/i, '/private/$1').replace(/[A-Z]/g, c => c.toLowerCase());
  const candidate = path.posix.relative(spelling(root), spelling(target));
  if (candidate === '..' || candidate.startsWith('../') || path.posix.isAbsolute(candidate)) return false;
  const boundary = macPathAnchor(root);
  let cursor = macPathAnchor(target);
  if (!boundary || !cursor) return false;
  const suffix = [...cursor.missing];
  for (;;) {
    if (sameFileIdentity(boundary.stat, cursor.stat)) {
      const fold = macAnchorIgnoresAsciiCase(boundary);
      const key = value => fold ? value.replace(/[A-Z]/g, c => c.toLowerCase()) : value;
      return suffix.length >= boundary.missing.length && boundary.missing.every((part, index) => key(part) === key(suffix[index]));
    }
    const parent = path.dirname(cursor.path);
    if (parent === cursor.path) return false;
    suffix.unshift(path.basename(cursor.path));
    try { cursor = { path: parent, stat: fs.statSync(parent, { bigint: true }) }; } catch { return false; }
  }
}

function pathWithinAnyRoot(target, roots) {
  return roots.some(r => pathWithinRoot(target, r));
}

function normalizeCwd(cwd, fallback) {
  // cwd 多直接取自请求体:非字符串(数字/对象)当没传,否则 path.resolve 抛 TypeError → 500(/api/memory* 等)。
  const pick = v => (typeof v === 'string' && v ? v : '');
  const base = pick(cwd) || pick(fallback) || os.homedir();
  return path.resolve(base);
}

module.exports = { normalizeCwd, macPathAnchor, sameFileIdentity, pathWithinRoot, pathWithinAnyRoot };
