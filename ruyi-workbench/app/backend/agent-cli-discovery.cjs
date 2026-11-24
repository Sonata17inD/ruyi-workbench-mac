'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createAgentCliDiscovery({ probes, process = globalThis.process }) {
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
  let codexProbe;
  function detectCodexPath() {
    if (codexProbe && Date.now() - codexProbe.at < CLAUDEPATH_CACHE_MS) return codexProbe.value;
    const dirs = [...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')];
    const candidates = [process.env.CODEX_CLI_PATH, ...new Set(dirs.filter(path.isAbsolute).map(dir => path.join(dir, 'codex'))),
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'];
    const value = candidates.find(binary => {
      if (!binary) return false;
      try { fs.accessSync(binary, fs.constants.X_OK); return fs.statSync(binary).isFile(); } catch { return false; }
    }) || '';
    codexProbe = { at: Date.now(), value };
    return value;
  }
  function claudeProbeCandidates() {
    const home = os.homedir();
    const installs = [path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'),
      '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
    return [...new Set([process.env.CLAUDE_CLI_PATH, 'claude', ...installs.filter(file => fs.existsSync(file))].filter(Boolean))];
  }
  function detectClaudePathUncached() {
    for (const command of claudeProbeCandidates()) {
      try {
        const result = probes.spawnProbeSync(command, ['--version'], { stdio: 'ignore', timeout: 4000 });
        if (!result.error && result.status !== null) return command;
      } catch (error) {
        if (error.cleanupIncomplete) throw error;
        // keep scanning
      }
    }
    return '';
  }
  async function detectClaudePathUncachedAsync() {
    for (const command of claudeProbeCandidates()) {
      try {
        const result = await probes.spawnProbeAsync(command, ['--version'], {});
        if (result.cleanupIncomplete) throw Object.assign(result.error, { cleanupIncomplete: true });
        if (!result.error && result.status !== null) return command;
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
        const generation = _cliProbeGeneration;
        refreshInBackground('claude', () => refreshClaudePath(generation));
      }
      return _claudePathProbe.value;
    }
    const value = detectClaudePathUncached();
    _claudePathProbe = { at: Date.now(), value };
    return value;
  }
  function invalidateClaudePathCache() { _claudePathProbe = null; _cliProbeGeneration += 1; }

  async function refreshClaudePath(generation) {
    const value = await detectClaudePathUncachedAsync();
    if (generation === _cliProbeGeneration) _claudePathProbe = { at: Date.now(), value };
  }

  let bootProbe;
  let bootStarted = false;
  let beforeListen = true;
  function beginBootCliPathProbes() {
    if (bootStarted) return;
    bootStarted = true;
    if (!_claudePathProbe) {
      _claudePathProbe = { at: Date.now(), value: '' };
      bootProbe = refreshClaudePath(_cliProbeGeneration).catch(() => {}).finally(() => { bootProbe = undefined; });
    }
  }
  function finishBootCliPathProbes() { beforeListen = false; }
  async function waitForBootCliPathProbes() { await bootProbe; }

  function agentCliProbeSpawn(command) {
    const isScript = /\.cjs$/i.test(command);
    return isScript ? { command: process.execPath, args: [command, '--version'] }
      : { command, args: ['--version'] };
  }
  function probeAgentCliLauncher(command) {
    if (!command) return false;
    try {
      const s = agentCliProbeSpawn(command);
      const ok = probes.spawnProbeSync(s.command, s.args, { stdio: 'ignore', timeout: 4000 });
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
      const result = await probes.spawnProbeAsync(s.command, s.args, {});
      if (result.cleanupIncomplete) throw Object.assign(result.error, { cleanupIncomplete: true });
      return agentCliProbeVerdict(result);
    } catch (error) { if (error.cleanupIncomplete) throw error; return 'missing'; }
  }
  async function probeAgentCliLauncherAsync(command) {   // 128f-⑬:后台重探用,判据与上面同步版逐字相同(只有 'ok' 为真)
    return (await probeAgentCliLauncherVerdictAsync(command)) === 'ok';
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
  function invalidateAgentCliPathCaches() { codexProbe = null; invalidateClaudePathCache(); _agentCliLauncherOk.clear(); _agentCliLauncherPresent.clear(); }

  function waitForConfigCliProbes() {
    if (!beforeListen) return bootProbe;
  }

  return {
    detectCodexPath, detectClaudePath, detectClaudePathUncached, detectClaudePathUncachedAsync, claudeProbeCandidates,
    probeAgentCliLauncher, probeAgentCliLauncherVerdictAsync, agentCliProbeVerdict,
    agentCliLauncherOk, agentCliLauncherUsable, invalidateClaudePathCache, invalidateAgentCliPathCaches,
    beginBootCliPathProbes, finishBootCliPathProbes, waitForBootCliPathProbes, waitForConfigCliProbes,
  };
}

function createAgentCliSelection({ AGENT_CLI_TYPES, normalizeAgentCliType, AGENT_CLI_HOST }) {
  function selectedAgentCli(config) {
    const id = typeof config?.agentCliType === 'string' && config.agentCliType.trim() || 'claude';
    if (!Object.hasOwn(AGENT_CLI_TYPES, id)) return { id, label: id, path: '', detected: '' };
    const meta = AGENT_CLI_TYPES[id];
    const detected = meta.detectPath(AGENT_CLI_HOST);
    return { ...meta, path: String(config && config[meta.pathKey] || detected || ''), detected };
  }
  function prepareAgentCliSpawn(type, command, args) {
    const argv = Array.isArray(args) ? args : [];
    if (type && !Object.hasOwn(AGENT_CLI_TYPES, type)) throw new Error('Unavailable CLI: ' + type);
    return AGENT_CLI_TYPES[normalizeAgentCliType(type)].prepareSpawn(AGENT_CLI_HOST, command, argv);
  }
  return { selectedAgentCli, prepareAgentCliSpawn };
}

module.exports = { createAgentCliSelection, createAgentCliDiscovery };
