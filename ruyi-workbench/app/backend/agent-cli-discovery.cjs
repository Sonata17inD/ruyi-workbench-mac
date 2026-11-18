'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AGENT_CLI_TYPES, isAgentCliType } = require('./agent-cli-types.cjs');

function createAgentCliDiscovery({ probes, bundledNodeExe, process = globalThis.process }) {
  function claudeInstallCandidates() {
    const home = os.homedir();
    return [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  }

  // v1.0-S7 (perf): detectClaudePath spawnSync-probes for `claude` (up to several launches, each with a 4s
  // timeout). It was called from defaultConfig(), which normalizeConfig() spreads on EVERY readConfig() — so
  // the (blocking) probe ran repeatedly, twice per startup (readConfig + generateMcpConfig) and on every
  // config read thereafter. The RESULT is stable within a process run, so memoize it. This collapses the
  // startup cost to a single probe and makes all later readConfig() calls probe-free. A short TTL lets a
  // long-lived server re-detect a claude installed after boot without ever re-probing on the hot path.
  // would otherwise cost up to ~4s PER readConfig; memoization bounds it to once per TTL window.)
  //
  // 128f-⑬(mission-index-scale (e)/(f) 取证时 CPU 剖面挖出来的;用户 2026-09-19「删除线程没有及时的界面反馈」那一刻
  // 真机上也撞见了它 —— DELETE 与同时在飞的四发请求一起卡了 1.9 s):上面那句「once per TTL window」就是毛病所在。
  // 过期之后的第一次 readConfig 仍然【同步】探一整轮(claude 与 kimi 两支,每个候选一次 node 冷启动,最多 4 s),
  // 这期间事件循环被整个占住 —— 于是【大约每分钟一次】,赶上的那个请求以及同时在飞的所有请求、推送、计时器一起等。
  // 修法:只有进程里还没有任何结果时同步探(启动那一次;设置里改了 CLI 路径之后那一次 —— 两处都要当场的答案);
  // 过期之后先答旧值,后台异步重探(spawnProbeAsync,判据与同步那支逐字相同),探完换上。后台重探每一支同时只有一发,
  // 探的途中又被「作废」(invalidate)了的那一发,结果不许回写(_cliProbeGeneration)。
  // 测试口 WCW_TEST_CLI_PROBE_TTL_MS 把记忆期缩短(cli-probe-stall.e2e);产品里恒为 60 s。
  let _claudePathProbe = null; // { at:number, value:string }
  const CLAUDEPATH_CACHE_MS = (() => {
    const raw = Number(process.env.WCW_TEST_CLI_PROBE_TTL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 60000;
  })();
  let _cliProbeGeneration = 0;   // 每次作废 +1;后台重探回来时代数变了就丢掉结果
  const _cliProbeRefreshing = new Set();   // 正在后台重探的键(同一个键同时只有一发)
  function refreshInBackground(key, probe) {
    if (_cliProbeRefreshing.has(key)) return false;
    _cliProbeRefreshing.add(key);
    Promise.resolve().then(probe).catch(() => {}).finally(() => { _cliProbeRefreshing.delete(key); });
    return true;
  }
  function claudeProbeCandidates() {
    // 先 PATH 上的裸名(快、常见),再常见安装位置(必须真的存在才探)。
    const names = ['claude'];
    const onPath = [process.env.CLAUDE_CLI_PATH, ...names].filter(Boolean).map(command => ({ command, mustExist: false }));
    return [...onPath, ...claudeInstallCandidates().map(command => ({ command, mustExist: true }))];
  }
  function detectClaudePathUncached() {
    for (const { command, mustExist } of claudeProbeCandidates()) {
      try {
        if (mustExist && !fs.existsSync(command)) continue;
        const s = { command, args: ['--version'], opts: {} };
        const ok = probes.spawnProbeSync(s.command, s.args, { stdio: 'ignore', timeout: 4000, ...s.opts });
        const found = !ok.error && ok.status !== null;
        if (found) return command;
      } catch (error) {
        if (error.cleanupIncomplete) throw error;
        // keep scanning
      }
    }
    return '';
  }
  async function detectClaudePathUncachedAsync() {
    for (const { command, mustExist } of claudeProbeCandidates()) {
      try {
        if (mustExist && !fs.existsSync(command)) continue;
        const s = { command, args: ['--version'], opts: {} };
        const ok = await probes.spawnProbeAsync(s.command, s.args, s.opts);
        if (ok.cleanupIncomplete) throw Object.assign(ok.error, { cleanupIncomplete: true });
        // 判据与同步版逐字相同(61-C6:批处理启动器要求退出码 0)。
        if (!ok.error && ok.status !== null) return command;
      } catch (error) {
        if (error.cleanupIncomplete) throw error;
        // keep scanning
      }
    }
    return '';
  }
  function detectClaudePath() {
    if (_claudePathProbe) {
      if ((Date.now() - _claudePathProbe.at) >= CLAUDEPATH_CACHE_MS) {
        refreshInBackground('claude', async () => {
          const generation = _cliProbeGeneration;
          const value = await detectClaudePathUncachedAsync();
          if (generation === _cliProbeGeneration) _claudePathProbe = { at: Date.now(), value };
        });
      }
      return _claudePathProbe.value;
    }
    const value = detectClaudePathUncached();
    _claudePathProbe = { at: Date.now(), value };
    return value;
  }
  // v1.0-S7: let a settings save / explicit "re-detect CLI" action force a fresh probe (e.g. the user just
  // installed the CLI). Exported for the doctor/status path — a no-op if never called.
  function invalidateClaudePathCache() { _claudePathProbe = null; _cliProbeGeneration += 1; }

  let _agentCliPathProbe = new Map(); // type -> { at, value }

  let bootCliPathProbes = null; // Only initialized by a real serve startup, never by config reads.
  function queueBootCliPathProbe(probe) {
    const state = bootCliPathProbes;
    const job = Promise.resolve().then(probe).catch(() => {}).finally(() => state.pending.delete(job));
    state.pending.add(job);
  }
  function beginBootCliPathProbes() {
    if (bootCliPathProbes) return;
    bootCliPathProbes = { beforeListen: true, pending: new Set() };
    const generation = _cliProbeGeneration;
    if (!_claudePathProbe) {
      _claudePathProbe = { at: Date.now(), value: '' };
      queueBootCliPathProbe(async () => {
        const value = await detectClaudePathUncachedAsync();
        if (generation === _cliProbeGeneration) _claudePathProbe = { at: Date.now(), value };
      });
    }
    if (!_agentCliPathProbe.has('kimi')) {
      const provisional = { at: Date.now(), value: '' };
      _agentCliPathProbe.set('kimi', provisional);
      queueBootCliPathProbe(async () => {
        const value = await detectAgentCliPathUncachedAsync('kimi');
        if (generation === _cliProbeGeneration) _agentCliPathProbe.set('kimi', { at: Date.now(), value });
        else if (_agentCliPathProbe.get('kimi') === provisional) _agentCliPathProbe.delete('kimi');
      });
    }
  }
  function finishBootCliPathProbes() {
    if (bootCliPathProbes) bootCliPathProbes.beforeListen = false;
  }
  async function waitForBootCliPathProbes() {
    // Launcher verification discovered during a boot read can add another job while
    // the first checks are in flight. Wait for the whole set, not just one snapshot.
    while (bootCliPathProbes?.pending.size) await Promise.all([...bootCliPathProbes.pending]);
  }

  function agentCliProbeSpawn(command) {
    const isScript = /\.cjs$/i.test(command);
    const kimiEntry = isScript ? '' : resolveKimiNpmEntry(command);
    const nodeExe = kimiEntry ? bundledNodeExe() : '';
    return isScript ? { command: process.execPath, args: [command, '--version'], opts: {} }
      : (kimiEntry && nodeExe ? { command: nodeExe, args: [kimiEntry, '--version'], opts: {} } : { command, args: ['--version'], opts: {} });
  }
  function probeAgentCliLauncher(command) {
    if (!command) return false;
    try {
      const s = agentCliProbeSpawn(command);
      const ok = probes.spawnProbeSync(s.command, s.args, { stdio: 'ignore', timeout: 4000, ...s.opts });
      return !ok.error && ok.status === 0;
    } catch (error) { if (error.cleanupIncomplete) throw error; return false; }
  }
  // 探测结果三态('ok' | 'missing' | 'slow')。spawnProbeAsync 带 timeout 选项:到点 Node 杀掉子进程,close 事件给
  // status=null 且【没有 error】—— 与「启动器根本起不来」(spawn 的 'error':ENOENT/EACCES…)、「--version 退出码非 0」
  // (装坏了/不是 CLI)都区分得开。慢(CLI 冷启动、杀软扫描、网络盘)不等于不存在,回合入口不能因此报「未检测到 CLI」。
  function agentCliProbeVerdict(result) {
    if (result && result.error) return result.error.code === 'ETIMEDOUT' ? 'slow' : 'missing';
    if (result && result.status === 0) return 'ok';
    if (result && result.status === null) return 'slow';
    return 'missing';
  }
  async function probeAgentCliLauncherVerdictAsync(command) {
    if (!command) return 'missing';
    try {
      const s = agentCliProbeSpawn(command);
      const result = await probes.spawnProbeAsync(s.command, s.args, s.opts);
      if (result.cleanupIncomplete) throw Object.assign(result.error, { cleanupIncomplete: true });
      return agentCliProbeVerdict(result);
    } catch (error) { if (error.cleanupIncomplete) throw error; return 'missing'; }
  }
  async function probeAgentCliLauncherAsync(command) {   // 128f-⑬:后台重探用,判据与上面同步版逐字相同(只有 'ok' 为真)
    return (await probeAgentCliLauncherVerdictAsync(command)) === 'ok';
  }
  function agentCliInstallCandidates(type) {
    if (!isAgentCliType(type)) return [];
    return AGENT_CLI_TYPES[type].installCandidates({ env: process.env, home: os.homedir(), join: (...parts) => path.join(...parts), platform: process.platform });
  }
  function agentCliProbeable(candidate) {
    // Explicit/absolute candidates must exist; bare commands are resolved by the launcher/PATH.
    return !((path.isAbsolute(candidate) || /[\\/]/.test(candidate)) && !fs.existsSync(candidate));
  }
  async function detectAgentCliPathUncachedAsync(type) {
    for (const candidate of agentCliInstallCandidates(type)) {
      if (!agentCliProbeable(candidate)) continue;
      if (await probeAgentCliLauncherAsync(candidate)) return candidate;
    }
    return '';
  }
  function detectAgentCliPath(type) {
    const cached = _agentCliPathProbe.get(type);
    if (cached) {
      // 128f-⑬:过期先答旧值、后台重探(同 detectClaudePath 头注)。
      if (Date.now() - cached.at >= CLAUDEPATH_CACHE_MS) {
        refreshInBackground('agent:' + type, async () => {
          const generation = _cliProbeGeneration;
          const fresh = await detectAgentCliPathUncachedAsync(type);
          if (generation === _cliProbeGeneration) _agentCliPathProbe.set(type, { at: Date.now(), value: fresh });
        });
      }
      return cached.value;
    }
    let value = '';
    for (const candidate of agentCliInstallCandidates(type)) {
      if (!agentCliProbeable(candidate)) continue;
      if (probeAgentCliLauncher(candidate)) { value = candidate; break; }
    }
    _agentCliPathProbe.set(type, { at: Date.now(), value });
    return value;
  }

  function resolveKimiNpmEntry(command) {
    const raw = String(command || '').trim();
    if (!/(?:^|\/)kimi$/.test(raw)) return '';
    const candidates = path.isAbsolute(raw) || raw.includes('/') ? [path.resolve(raw)]
      : String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, raw));
    for (const launcher of candidates) {
      try {
        const entry = fs.realpathSync(launcher);
        if (entry.endsWith('/@moonshot-ai/kimi-code/dist/main.mjs')) return entry;
        if (fs.existsSync(launcher)) return '';
      } catch { /* Try the next PATH entry. */ }
    }
    return '';
  }

  // 128f-⑬:健康检查那一项「选中的 CLI 起不起得来」。修前 computeHealth 每一次都【同步】跑一遍「<cli> --version」、不记忆 ——
  // 而 /api/status 每换一次线程就调一次(session-experience openSession),于是换线程这个动作每次都把整个服务钉住一次
  // CLI 冷启动。改成异步、按启动器记 60 s(与路径探测同一个记忆期、同一个作废口)。
  const _agentCliLauncherOk = new Map();   // command -> { at, value }
  async function probeAgentCliLauncherRemembered(command) {
    const generation = _cliProbeGeneration;
    const value = await probeAgentCliLauncherAsync(command);
    if (generation === _cliProbeGeneration) {
      if (_agentCliLauncherOk.size > 32) _agentCliLauncherOk.clear();
      _agentCliLauncherOk.set(command, { at: Date.now(), value });
    }
    return value;
  }
  async function agentCliLauncherOk(command) {
    if (!command) return false;
    const hit = _agentCliLauncherOk.get(command);
    if (hit) {
      // 过期同样先答上一次的结果、后台重探(与路径探测同一条纪律):/api/status 自己也不该每分钟慢一次 CLI 冷启动。
      if (Date.now() - hit.at >= CLAUDEPATH_CACHE_MS) refreshInBackground('launcher-ok:' + command, () => probeAgentCliLauncherRemembered(command));
      return hit.value;
    }
    return probeAgentCliLauncherRemembered(command);
  }
  // 回合入口(05 runClaudeTurn / 05b ensureKimiServer)问「选中的 CLI 启动器能不能用」。修前直接 spawnSync「<cli> --version」
  // (最长 4 s):每个回合都把整个事件循环钉住一次,超时还被当成「未检测到 CLI」把用户的输入挡在门外。现在:
  //   · 异步探(不钉事件循环);
  //   · 只有判定「缺失」(起不来 / 退出码非 0)才拒绝回合,超时算「在,只是慢」放行 —— 真起不来,后面的 spawn 自己会报;
  //   · 「在」(含慢)的结果按 60 s 记忆(与路径探测同一个记忆期与作废口);【缺失不记】,用户刚装好 CLI 要立刻就能用。
  const _agentCliLauncherPresent = new Map();   // command -> 记下「在」的时刻
  async function agentCliLauncherUsable(command) {
    if (!command) return false;
    const at = _agentCliLauncherPresent.get(command);
    if (at !== undefined && Date.now() - at < CLAUDEPATH_CACHE_MS) return true;
    const generation = _cliProbeGeneration;
    const verdict = await probeAgentCliLauncherVerdictAsync(command);
    if (verdict === 'missing') { _agentCliLauncherPresent.delete(command); return false; }
    if (generation === _cliProbeGeneration) {
      if (_agentCliLauncherPresent.size > 32) _agentCliLauncherPresent.clear();
      _agentCliLauncherPresent.set(command, Date.now());
    }
    return true;
  }
  function invalidateAgentCliPathCaches() { invalidateClaudePathCache(); _agentCliPathProbe = new Map(); _agentCliLauncherOk.clear(); _agentCliLauncherPresent.clear(); }

  function waitForConfigCliProbes() {
    if (bootCliPathProbes && !bootCliPathProbes.beforeListen && bootCliPathProbes.pending.size) return waitForBootCliPathProbes();
  }

  return {
    detectClaudePath, detectClaudePathUncached, detectClaudePathUncachedAsync, claudeProbeCandidates,
    detectAgentCliPath, detectAgentCliPathUncachedAsync, agentCliInstallCandidates, resolveKimiNpmEntry,
    probeAgentCliLauncher, probeAgentCliLauncherVerdictAsync, agentCliProbeVerdict,
    agentCliLauncherOk, agentCliLauncherUsable, invalidateClaudePathCache, invalidateAgentCliPathCaches,
    beginBootCliPathProbes, finishBootCliPathProbes, queueBootCliPathProbe, waitForBootCliPathProbes, waitForConfigCliProbes,
  };
}

module.exports = { createAgentCliDiscovery };
