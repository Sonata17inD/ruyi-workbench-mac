'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createWorkbenchPathDiscovery({ process }) {
  // 其它 Agent CLI 的用户级目录。一律在【调用时】按 os.homedir() 与各家的覆盖变量解析(不缓存):测试把
  // USERPROFILE/HOME 指到临时家,这里立刻跟着走 —— 这就是「测试绝不碰真机家目录」的那一道闸。
  //   Claude Code:~/.claude 与 ~/.claude.json;Codex:$CODEX_HOME,缺省 ~/.codex;
  //   Kimi Code:$KIMI_CODE_HOME,缺省 ~/.kimi-code(与 syncMcpServersToKimi 同一口径);Gemini CLI:~/.gemini。
  function agentCliHomes() {
    const home = os.homedir();
    return {
      home,
      claude: path.join(home, '.claude'),
      claudeJson: path.join(home, '.claude.json'),
      codex: String(process.env.CODEX_HOME || '').trim() || path.join(home, '.codex'),
      kimi: String(process.env.KIMI_CODE_HOME || '').trim() || path.join(home, '.kimi-code'),
      gemini: path.join(home, '.gemini'),
    };
  }

  // 给人看的路径:家目录前缀写成 ~(只影响显示,不参与任何判定)。
  function tildePath(p) {
    const s = String(p || '');
    const home = os.homedir();
    if (!home || !s) return s;
    const a = s;
    const h = home;
    if (a === h) return '~';
    if (a.startsWith(h) && (s[home.length] === '\\' || s[home.length] === '/')) return '~' + s.slice(home.length).replace(/\\/g, '/');
    return s;
  }

  // 路径比较键使用绝对路径并去除尾部分隔符。
  function samePathKey(p) {
    let s = path.resolve(String(p || ''));

    return s.length > 3 ? s.replace(/\/+$/, '') : s;
  }

  // 包根包含 app/server.js，并以 package.json 的产品名或旧包的启动文件标记确认。
  // 旧标记用于识别现有安装记录。
  function ruyiPackageInfo(dir) {
    try {
      let root = path.resolve(String(dir || ''));
      // An external command can reference the Mac host outside the workbench subtree.
      // Keep its logical package root consistent with the installed service registry.
      if (process.platform === 'darwin' && /\.app$/i.test(root)
        && fs.statSync(path.join(root, 'Contents/Info.plist')).isFile()
        && fs.statSync(path.join(root, 'Contents/MacOS/RuyiDesktop')).isFile()) root = path.join(root, 'Contents/Resources/workbench');
      if (!fs.statSync(path.join(root, 'app', 'server.js')).isFile()) return null;
      let named = false; let version = '';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        named = Boolean(pkg && pkg.name === 'ruyi-workbench');
        if (pkg && typeof pkg.version === 'string') version = pkg.version.slice(0, 40);
      } catch { /* 没有或坏的 package.json:只能靠启动脚本认 */ }
      if (!named && !fs.existsSync(path.join(root, 'Start-Workbench.cmd'))) return null;
      return { root, version };
    } catch { return null; }
  }

  // 从一个绝对路径沿祖先链往上找【最近】的如意包根(最多 12 层)。不全盘扫描、不列举任何目录。
  // 最近优先:源码树 ruyi-workbench/ 下的 dist/Ruyi-vX 是另一个包,应认成 dist/Ruyi-vX 而不是外层。
  // cache(可选 Map)按目录键记忆结果,一次扫描里同一棵树只 stat 一遍。
  function findRuyiPackageRootFor(p, cache) {
    const raw = String(p || '').trim();
    if (!raw || !path.isAbsolute(raw)) return null;
    let dir = path.resolve(raw);
    const seen = [];
    for (let i = 0; i < 12; i++) {
      const key = samePathKey(dir);
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
