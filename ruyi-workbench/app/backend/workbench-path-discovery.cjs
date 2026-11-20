'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createWorkbenchPathDiscovery({ process }) {
  function agentCliHomes() {
    const home = os.homedir();
    return {
      home,
      claude: path.join(home, '.claude'),
      claudeJson: path.join(home, '.claude.json'),
      codex: String(process.env.CODEX_HOME || '').trim() || path.join(home, '.codex'),
      gemini: path.join(home, '.gemini'),
    };
  }

  // 给人看的路径:家目录前缀写成 ~(只影响显示,不参与任何判定)。
  function tildePath(p) {
    const s = String(p || '');
    const home = os.homedir();
    if (!home || !s) return s;
    if (s === home) return '~';
    return s.startsWith(home + path.sep) ? '~' + s.slice(home.length) : s;
  }

  function samePathKey(p) {
    return path.resolve(String(p || ''));
  }

  function ruyiPackageInfo(dir) {
    try {
      let root = path.resolve(String(dir || ''));
      // An external command can reference the Mac host outside the workbench subtree.
      // Keep its logical package root consistent with the installed service registry.
      if (process.platform === 'darwin' && /\.app$/i.test(root)
        && fs.statSync(path.join(root, 'Contents/Info.plist')).isFile()
        && fs.statSync(path.join(root, 'Contents/MacOS/RuyiDesktop')).isFile()) root = path.join(root, 'Contents/Resources/workbench');
      if (!fs.statSync(path.join(root, 'app', 'server.js')).isFile()) return null;
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      if (pkg?.name !== 'ruyi-workbench') return null;
      return { root, version: typeof pkg.version === 'string' ? pkg.version.slice(0, 40) : '' };
    } catch { return null; }
  }

  // 从一个绝对路径沿祖先链往上找【最近】的如意包根。不全盘扫描、不列举任何目录。
  // 最近优先:源码树 ruyi-workbench/ 下的 dist/Ruyi-vX 是另一个包,应认成 dist/Ruyi-vX 而不是外层。
  // cache(可选 Map)按目录键记忆结果,一次扫描里同一棵树只 stat 一遍。
  function findRuyiPackageRootFor(p, cache) {
    const raw = String(p || '');
    if (!raw || !path.isAbsolute(raw)) return null;
    let dir = path.resolve(raw);
    const seen = [];
    while (true) {
      const key = dir;
      if (cache && cache.has(key)) { const hit = cache.get(key); for (const k of seen) cache.set(k, hit); return hit; }
      seen.push(key);
      const info = ruyiPackageInfo(dir);
      if (info) { if (cache) for (const k of seen) cache.set(k, info); return info; }
      const parent = path.dirname(dir);
      if (!parent || parent === dir) break;
      dir = parent;
    }
    if (cache) for (const k of seen) cache.set(k, null);
    return null;
  }
  return { agentCliHomes, tildePath, samePathKey, ruyiPackageInfo, findRuyiPackageRootFor };
}

module.exports = { createWorkbenchPathDiscovery };
