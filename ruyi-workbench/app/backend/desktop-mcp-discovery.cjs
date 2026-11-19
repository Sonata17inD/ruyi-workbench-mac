'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createDesktopMcpDiscovery({ appDirectory, externalRoot, pickPython, pickPythonAsync, process = globalThis.process }) {
  // True when a directory looks like the ai-computer-control repo (has the src package).
  function isDesktopMcpRepo(dir) {
    try { return !!dir && fs.existsSync(path.join(dir, 'src', 'ai_computer_control', 'server.py')); }
    catch { return false; }
  }
  // 环境与产出形状同样是同步/异步共用的单一 owner(见 normalizeDesktopPythonCandidate 头注)。
  function desktopMcpRepoEnv(repoRoot) {
    const desktopEnv = { PYTHONPATH: path.join(repoRoot, 'src'), PYTHONUTF8: '1' };
    // Offline releases keep Playwright's browser payload beside the embedded Python runtime. Without
    // this variable Playwright falls back to the user's cache and reports Chromium missing even though
    // the package contains it.
    const bundledBrowsers = path.join(repoRoot, 'playwright_browsers');
    try { if (fs.existsSync(bundledBrowsers)) desktopEnv.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers; }
    catch { /* optional payload; browser tools will degrade gracefully */ }
    return desktopEnv;
  }
  function desktopMcpEntryFor(selected, cwd, desktopEnv) {
    if (!selected) return null;
    return {
      command: selected.command,
      args: [...selected.args, '-X', 'utf8', '-m', 'ai_computer_control.server'],
      cwd,
      env: desktopEnv,
      via: 'python-module',
      pythonSource: selected.source,
      pythonCapability: selected.capability || 'core',
    };
  }
  function desktopMcpFromRepo(repoRoot, options) {
    const desktopEnv = desktopMcpRepoEnv(repoRoot);
    return desktopMcpEntryFor(pickPython(repoRoot, desktopEnv, options), repoRoot, desktopEnv);
  }
  async function desktopMcpFromRepoAsync(repoRoot) {
    const desktopEnv = desktopMcpRepoEnv(repoRoot);
    return desktopMcpEntryFor(await pickPythonAsync(repoRoot, desktopEnv), repoRoot, desktopEnv);
  }

  // An installed Mac runtime contains its own Python and dependencies rather than a src checkout.
  function desktopMcpInstalledEnv(root) {
    const desktopEnv = { PYTHONUTF8: '1' };
    if (process.platform === 'darwin') {
      desktopEnv.PYTHONPATH = '';
      desktopEnv.PYTHONNOUSERSITE = '1';
      desktopEnv.PYTHONDONTWRITEBYTECODE = '1';
      desktopEnv.RUYI_MACOS_AUTOMATION_HELPER = path.join(externalRoot(), 'runtime', 'macos', 'ruyi-automation-helper');
      desktopEnv.ACC_BROWSER_MODE = 'bundled';
    }
    const bundledBrowsers = path.join(root, 'playwright_browsers');
    try { if (fs.existsSync(bundledBrowsers)) desktopEnv.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers; }
    catch { /* optional payload; browser tools will degrade gracefully */ }
    return desktopEnv;
  }
  function desktopMcpInstalledPickOptions(root, options) {
    const installedCandidates = [{ command: path.join(root, 'runtime', 'python', 'bin', 'python3'), args: [], source: 'installed-runtime', requireExisting: true }];
    return {
      candidates: Array.isArray(options.candidates) ? options.candidates : installedCandidates,
      probe: typeof options.probe === 'function' ? options.probe : undefined,
      noCache: options.noCache === true,
      cacheOnly: options.cacheOnly,
      onCacheMiss: options.onCacheMiss,
    };
  }
  function desktopMcpFromInstalledRoot(installRoot, options = {}) {
    const root = String(installRoot || '').trim();
    if (!root) return null;
    const desktopEnv = desktopMcpInstalledEnv(root);
    return desktopMcpEntryFor(pickPython(root, desktopEnv, desktopMcpInstalledPickOptions(root, options)), root, desktopEnv);
  }
  async function desktopMcpFromInstalledRootAsync(installRoot, options = {}) {
    const root = String(installRoot || '').trim();
    if (!root) return null;
    const desktopEnv = desktopMcpInstalledEnv(root);
    return desktopMcpEntryFor(await pickPythonAsync(root, desktopEnv, desktopMcpInstalledPickOptions(root, options)), root, desktopEnv);
  }
  // 39 号文:(a)(b)(c) 三段【看哪些根目录、按什么顺序看】—— 纯枚举,只碰 fs.existsSync,一发探针都不放。
  // 同步 detectDesktopMcp 与异步孪生 detectDesktopMcpAsync 走同一份,免得两条路在「先看谁」上分家:
  // 预热那趟暖热的必须正好是同步那趟会问的那几把缓存键,否则预热白做。
  function desktopMcpRootPlan() {
    const steps = [];
    try {
      const env = process.env;
      const home = os.homedir();
      // (a) explicit env override.
      const envHome = env.AI_COMPUTER_CONTROL_HOME && String(env.AI_COMPUTER_CONTROL_HOME).trim();
      if (envHome) {
        const root = path.resolve(envHome);
        if (isDesktopMcpRepo(root)) steps.push({ kind: 'repo', root });
        steps.push({ kind: 'installed', root });
      }
      // (b) common repo locations. Bundled monorepo copies come first (release layout ships the MCP
      // at <repo>/mcp/ai-computer-control with the Mac Python runtime beside it and the app at
      // <repo>/ruyi-workbench/app, or flattened with app/ at the package root), so the portable runtime
      // beats both a stale user checkout and any machine-local Python on a clean distribution target.
      const repoCandidates = [
        path.join(externalRoot(), 'mcp', 'ai-computer-control'),
        path.join(appDirectory, '..', '..', 'mcp', 'ai-computer-control'),
        path.join(appDirectory, '..', 'mcp', 'ai-computer-control'),
        home && path.join(home, 'Documents', 'Claude Code', 'ai-computer-control'),
        home && path.join(home, 'Documents', 'ai-computer-control'),
        home && path.join(home, 'ai-computer-control'),
      ].filter(Boolean);
      for (const dir of repoCandidates) {
        if (process.platform === 'darwin' && fs.existsSync(path.join(dir, 'runtime', 'python', 'bin', 'python3'))) {
          steps.push({ kind: 'installed', root: path.resolve(dir) });
        }
        if (!isDesktopMcpRepo(dir)) continue;
        steps.push({ kind: 'repo', root: path.resolve(dir) });
      }
    } catch { /* never throw */ }
    return steps;
  }

  // (d) 最后一段:PATH 与常见安装目录里的控制台脚本(不需要 checkout)。纯 fs,同步/异步共用。
  function desktopMcpConsoleScript() {
    try {
      const env = process.env;
      const home = os.homedir();
      // (d) a console script on PATH or common install dirs (no repo checkout needed).
      const scriptDirs = [
        home && path.join(home, '.local', 'bin'),
      ].filter(Boolean);
      // Also honor PATH entries.
      const pathDirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
      const scriptNames = ['ai-computer-control'];
      for (const dir of [...scriptDirs, ...pathDirs]) {
        for (const n of scriptNames) {
          const full = path.join(dir, n);
          try { if (fs.existsSync(full)) return { command: full, args: [], cwd: undefined, env: { PYTHONUTF8: '1' }, via: 'console-script' }; }
          catch { /* keep scanning */ }
        }
      }
    } catch { /* never throw */ }
    return null;
  }

  // 同步签名【保留】(39 号文 §2 的拍板):它的调用方是 resolveExternalMcpServers 一族,那一族散在 8 个模块
  // 12 处、连静态件都同步调,全改 async 是一次跨模块大手术,而要治的病(探针占住事件循环)靠「预热走异步、
  // 同步这支只吃缓存」就治得掉。冷缓存时它仍会同步探一轮 —— 那是兜底路径,不是正常路径。
  function detectDesktopMcp() { return scanDesktopMcp(); }

  function scanDesktopMcp(options) {
    try {
      for (const step of desktopMcpRootPlan()) {
        const detected = step.kind === 'repo' ? desktopMcpFromRepo(step.root, options) : desktopMcpFromInstalledRoot(step.root, options);
        if (detected) return detected;
      }
      return desktopMcpConsoleScript();
    } catch { /* never throw */ }
    return null;
  }
  // 异步孪生:同一份根目录计划、同一套挑人规则,只是每发探针都让出事件循环。它写进的两张缓存
  // 正是同步那支要读的,所以预热跑完之后,同步调用者一发 spawnSync 都不用付。
  async function detectDesktopMcpAsync() {
    try {
      for (const step of desktopMcpRootPlan()) {
        const detected = step.kind === 'repo' ? await desktopMcpFromRepoAsync(step.root) : await desktopMcpFromInstalledRootAsync(step.root);
        if (detected) return detected;
      }
      return desktopMcpConsoleScript();
    } catch { /* never throw */ }
    return null;
  }
  // 只有「会走 autodetect」的配置才值得预热:显式 command 覆盖、或整块停用时,两条读路
  // (resolveExternalMcpServers 与 buildMcpConnectorInventory)本来就一发探针都不放 ——
  // 预热更不该放(04 的 55a 注释:「禁用时不应阻塞 GET 清单」)。两条读路的门一严一松
  // (一处 `dm.enabled`、一处 `dm.enabled !== false`),这里取松的那个,才不会漏热。
  function desktopMcpAutodetectWanted(config) {
    const dm = config && config.desktopMcp;
    if (!dm || dm.enabled === false) return false;
    if (String(dm.command || '').trim()) return false;
    return !!dm.autodetect;
  }
  // 唯一一处「主动去探」的入口。并发调用共用同一趟(启动预热与首个 /api/status 常常撞在一起)。
  // 缓存还热时它连 spawn 都不会发生,所以可以随手 await,不必自己判「该不该预热了」。
  // 拿不到 config 时一律不预热:退回旧的同步兜底,绝不因为「没人告诉我」就多探一轮。
  let desktopMcpWarmInFlight = null;
  function ensureDesktopMcpWarm(config) {
    if (!desktopMcpAutodetectWanted(config)) return Promise.resolve(null);
    if (desktopMcpWarmInFlight) return desktopMcpWarmInFlight;
    desktopMcpWarmInFlight = detectDesktopMcpAsync()
      .catch(() => null)
      .then(detected => { desktopMcpWarmInFlight = null; return detected; });
    return desktopMcpWarmInFlight;
  }
  // Follow the same discovery plan in cache-only mode. A miss starts one background warm-up.
  function desktopMcpDetectionPending(config) {
    if (!desktopMcpAutodetectWanted(config)) return false;
    let pending = false;
    scanDesktopMcp({ cacheOnly: true, onCacheMiss: () => { pending = true; } });
    if (pending) void ensureDesktopMcpWarm(config);
    return pending;
  }

  return { detectDesktopMcp, detectDesktopMcpAsync, desktopMcpFromInstalledRoot, desktopMcpDetectionPending, ensureDesktopMcpWarm };
}

module.exports = { createDesktopMcpDiscovery };
