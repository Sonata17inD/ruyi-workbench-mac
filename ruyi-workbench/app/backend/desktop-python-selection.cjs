'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDesktopPythonProbe, DESKTOP_PYTHON_IMPORT_PROBE } = require('./desktop-python-probe.cjs');

function createDesktopPythonSelection({ ProcessRuntime, process = globalThis.process }) {
  // Verify the offline ACC interpreter and its imports before offering desktop tools.
  const DESKTOP_PYTHON_OK_CACHE_MS = 5 * 60 * 1000;
  const DESKTOP_PYTHON_MISS_CACHE_MS = 15000;
  const { probeDesktopPython, probeDesktopPythonAsync } = createDesktopPythonProbe(ProcessRuntime);
  const desktopPythonCache = new Map(); // repo/root -> { at, value:{command,args,source}|null }
  // 121 换机器实测(34 号文 §13.8/§13.10):上面这张表只活在【本进程】。这台机器 python / python3 / py -3
  // 三个候选每个要 ~1.7 s 才答得出来(系统 Python 起得慢),而本函数为了优先选 Full 会把候选【全部】探完
  // (前两个 miss、第三个 core),于是每个新进程首启都同步阻塞 ~5 s 在 listen 之前;e2e 每件各起一个服务
  // 就每件各付 5 s,8 路并发下更慢,66 件在启动预算内起不来。这里把整轮的结果(选中了谁,或整轮没有)
  // 跨进程记到 os.tmpdir() 的一个小 JSON,TTL 与进程内那张表同一对数字(肯定 5 分钟、否定 10 分钟——
  // 否定放长一点是因为「没装」比「刚装好」常见得多,进程内 15 s 的 miss TTL 到期后会再来读一次磁盘,
  // 磁盘条目过期才真探)。肯定结果只在命令是绝对路径且仍存在时才信(被卸载了就当没缓存)。
  // 键里带 PATH / PYTHON 环境、根目录、PYTHONPATH、候选清单与探针脚本原文——任何一样变了都是新键。
  // 读写都是 best-effort,坏文件/并发写丢条目的后果只是多探一次。
  // 测试口(options.probe / options.noCache)一律绕过,与进程内那张表同一条规则。
  const DESKTOP_PYTHON_DISK_MISS_CACHE_MS = 10 * 60 * 1000;
  const DESKTOP_PYTHON_DISK_CACHE_FILE = 'ruyi-desktop-python-probe.v1.json';
  function desktopPythonDiskCachePath() {
    return path.join(os.tmpdir(), DESKTOP_PYTHON_DISK_CACHE_FILE);
  }
  function desktopPythonDiskCacheId(root, desktopEnv, candidates) {
    const digest = crypto.createHash('sha1');
    digest.update(JSON.stringify([
      String(root || ''),
      String((desktopEnv && desktopEnv.PYTHONPATH) || ''),
      String(process.env.PATH || ''),
      String(process.env.PYTHON || ''),
      DESKTOP_PYTHON_IMPORT_PROBE,
      (Array.isArray(candidates) ? candidates : []).map(candidate => [
        String((candidate && candidate.command) || ''),
        Array.isArray(candidate && candidate.args) ? candidate.args.map(String) : [],
      ]),
    ]));
    return digest.digest('hex');
  }
  function desktopPythonDiskEntryFresh(entry, nowMs) {
    if (!entry || typeof entry !== 'object') return false;
    const at = Number(entry.at);
    if (!Number.isFinite(at)) return false;
    const ttl = entry.value ? DESKTOP_PYTHON_OK_CACHE_MS : DESKTOP_PYTHON_DISK_MISS_CACHE_MS;
    return (nowMs - at) < ttl;
  }
  function readDesktopPythonDiskEntries() {
    try {
      const parsed = JSON.parse(fs.readFileSync(desktopPythonDiskCachePath(), 'utf8'));
      return parsed && parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    } catch { return {}; }
  }
  // 返回 { value } 表示命中(value 可以是 null=整轮没有),返回 null 表示没有可信的缓存。
  function readDesktopPythonDiskEntry(cacheId) {
    if (!cacheId) return null;
    const entry = readDesktopPythonDiskEntries()[cacheId];
    if (!desktopPythonDiskEntryFresh(entry, Date.now())) return null;
    const value = entry.value && typeof entry.value === 'object' ? entry.value : null;
    if (value) {
      const command = String(value.command || '');
      if (!command) return null;
      try { if (path.isAbsolute(command) && !fs.existsSync(command)) return null; } catch { return null; }
      return { value: { command, args: Array.isArray(value.args) ? value.args.map(String) : [], source: String(value.source || 'unknown'), capability: value.capability === 'full' ? 'full' : 'core' } };
    }
    return { value: null };
  }
  function writeDesktopPythonDiskEntry(cacheId, value) {
    if (!cacheId) return false;
    try {
      const file = desktopPythonDiskCachePath();
      const entries = readDesktopPythonDiskEntries();
      const nowMs = Date.now();
      for (const id of Object.keys(entries)) {
        if (!desktopPythonDiskEntryFresh(entries[id], nowMs)) delete entries[id];
      }
      entries[cacheId] = { at: nowMs, value: value ? { command: value.command, args: value.args, source: value.source, capability: value.capability } : null };
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
      fs.renameSync(tmp, file);
      return true;
    } catch { return false; }
  }

  function desktopPythonCandidates(root) {
    const candidates = [];
    if (root) {
      for (const [parts, source] of [
        [['runtime', 'python', 'bin', 'python3'], 'bundled-runtime'],
        [['.venv', 'bin', 'python3'], 'repo-venv'],
        [['venv', 'bin', 'python3'], 'installed-venv'],
      ]) candidates.push({ command: path.resolve(root, ...parts), args: [], source, requireExisting: true });
    }
    const envPython = String(process.env.PYTHON || '').trim();
    if (envPython) candidates.push({ command: envPython, args: [], source: 'PYTHON', requireExisting: path.isAbsolute(envPython) });
    for (const command of ['python3', 'python']) candidates.push({ command, args: [], source: 'system-path', requireExisting: false });
    const seen = new Set();
    return candidates.filter(candidate => {
      if (seen.has(candidate.command)) return false;
      seen.add(candidate.command); return true;
    });
  }

  // 下面三件是同步/异步两条选路【共用】的判断,单独抽出来是为了不让两条路在语义上悄悄分家
  // (33 号文的老主题:第二份实现迟早与第一份不一样)。
  // ① 候选归一 + 「要求存在」那道门;返回 null 表示这个候选直接跳过。
  function normalizeDesktopPythonCandidate(raw) {
    const candidate = raw && typeof raw === 'object' ? raw : { command: String(raw || ''), args: [], source: 'unknown', requireExisting: true };
    if (!candidate.command) return null;
    if (candidate.requireExisting !== false) {
      try { if (!fs.existsSync(candidate.command)) return null; } catch { return null; }
    }
    return candidate;
  }
  // ② 「优先 Full、core 兜底、拿到 Full 就收工」这条挑人规则的唯一实现。offer 返回 true = 可以收工。
  function desktopPythonPicker() {
    let selected = null;
    let coreFallback = null;
    return {
      offer(candidate, probed) {
        const capability = probed === 'core' ? 'core' : (probed ? 'full' : '');
        if (!capability) return false;
        const match = { command: candidate.command, args: Array.isArray(candidate.args) ? candidate.args : [], source: candidate.source || 'unknown', capability };
        if (capability === 'full') { selected = match; return true; }
        if (!coreFallback) coreFallback = match;
        return false;
      },
      result() { return selected || coreFallback; },
    };
  }
  // ③ 两张缓存的读(命中就不必探)与写。跨进程那张见 DESKTOP_PYTHON_DISK_MISS_CACHE_MS 头注:上一轮
  // (本进程或别的进程)探过同一把键且还在 TTL 内,就照那一轮的答案;命中也写进进程内表,15 s/5 min
  // 内连磁盘都不用读。测试口(options.probe / options.noCache)一律绕过两张表。
  function desktopPythonSelectionPlan(repoRoot, desktopEnv, options = {}) {
    const root = String(repoRoot || '');
    const bypassCache = options.noCache === true || typeof options.probe === 'function';
    const cacheKey = root + '\n' + String((desktopEnv && desktopEnv.PYTHONPATH) || '');
    const cached = !bypassCache && desktopPythonCache.get(cacheKey);
    const now = Date.now();
    const ttl = cached && cached.value ? DESKTOP_PYTHON_OK_CACHE_MS : DESKTOP_PYTHON_MISS_CACHE_MS;
    if (cached && (now - cached.at) < ttl) return { hit: true, value: cached.value };

    const candidates = Array.isArray(options.candidates) ? options.candidates : desktopPythonCandidates(root);
    const diskCacheId = bypassCache ? '' : desktopPythonDiskCacheId(root, desktopEnv, candidates);
    const diskHit = diskCacheId ? readDesktopPythonDiskEntry(diskCacheId) : null;
    if (diskHit) {
      desktopPythonCache.set(cacheKey, { at: now, value: diskHit.value });
      return { hit: true, value: diskHit.value };
    }
    return { hit: false, value: null, root, candidates, cacheKey, diskCacheId, bypassCache, at: now };
  }
  function desktopPythonSelectionStore(selectionPlan, selected) {
    if (selectionPlan.bypassCache) return selected;
    desktopPythonCache.set(selectionPlan.cacheKey, { at: selectionPlan.at, value: selected });
    writeDesktopPythonDiskEntry(selectionPlan.diskCacheId, selected);
    return selected;
  }

  // Returns the first Full candidate; if none exists, returns the first candidate that can at least import
  // the FastMCP server. `options.probe` is a deterministic test seam and may return true/false or full/core.
  function pickPython(repoRoot, desktopEnv, options = {}) {
    const selectionPlan = desktopPythonSelectionPlan(repoRoot, desktopEnv, options);
    if (selectionPlan.hit) return selectionPlan.value;
    if (options.cacheOnly) { options.onCacheMiss?.(); return null; }
    const probe = typeof options.probe === 'function' ? options.probe : probeDesktopPython;
    const picker = desktopPythonPicker();
    for (const raw of selectionPlan.candidates) {
      const candidate = normalizeDesktopPythonCandidate(raw);
      if (!candidate) continue;
      if (picker.offer(candidate, probe(candidate, selectionPlan.root, desktopEnv))) break;
    }
    return desktopPythonSelectionStore(selectionPlan, picker.result());
  }
  // 与 pickPython 逐行同形的异步版:同一张计划、同一个 picker、同一处写缓存,只有「怎么问那发 python」
  // 不同。写进的缓存就是同步那支读的那两张,所以预热一趟之后同步调用者一发探针都不用付。
  async function pickPythonAsync(repoRoot, desktopEnv, options = {}) {
    const selectionPlan = desktopPythonSelectionPlan(repoRoot, desktopEnv, options);
    if (selectionPlan.hit) return selectionPlan.value;
    // TEST HOOK(128f-③):env WCW_TEST_DESKTOP_PROBE_DELAY_MS 只在【真要探】(缓存未命中)时先等一段 —— 「探测在飞」的窗口
    // 因此确定性地存在,而缓存热时照旧零开销(与真机同形:热缓存的预热是瞬时的)。desktop-probe-status／-follow 两件用它;
    // 件里另把 TMP 指到新目录绕开跨进程磁盘缓存。不设即零开销。
    const testDelay = Number(process.env.WCW_TEST_DESKTOP_PROBE_DELAY_MS) || 0;
    if (testDelay > 0) await new Promise(resolve => setTimeout(resolve, Math.min(testDelay, 60000)));
    const probe = typeof options.probe === 'function' ? options.probe : probeDesktopPythonAsync;
    const picker = desktopPythonPicker();
    for (const raw of selectionPlan.candidates) {
      const candidate = normalizeDesktopPythonCandidate(raw);
      if (!candidate) continue;
      if (picker.offer(candidate, await probe(candidate, selectionPlan.root, desktopEnv))) break;
    }
    return desktopPythonSelectionStore(selectionPlan, picker.result());
  }

  return { pickPython, pickPythonAsync, probeDesktopPython, probeDesktopPythonAsync, desktopPythonCandidates };
}

module.exports = { createDesktopPythonSelection };
