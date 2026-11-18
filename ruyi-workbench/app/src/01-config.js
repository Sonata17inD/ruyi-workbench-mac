const { createConfigSchema, BROWSER_AUTOMATION_MODES } = require('./backend/config-schema.cjs');
const { THREAD_INDEX_RECENT_DEFAULT, THREAD_INDEX_RECENT_MIN, THREAD_INDEX_RECENT_MAX } = require('./backend/config-defaults.cjs');
const ConfigWorkspaces = require('./backend/config-workspaces.cjs').createWorkspaceConfig({ platform: process.platform });
const { normalizeWorkspacePathString } = ConfigWorkspaces;
const {
  defaultConfig, normalizeConfig, CONFIG_MIGRATIONS, configValueEquals, prepareConfigWrite,
} = createConfigSchema({
  CONFIG_SCHEMA, VERSION, SKILL_ID_RE, samePathKey, sanitizeProvider, PrivacyCore, workspaces: ConfigWorkspaces,
  detectClaudePath: () => detectClaudePath(), detectKimiPath: () => detectKimiPath(),
});

// 本进程落进 sessions 目录【本层】的原子写次数(会话头、会话索引、搜索索引……)。13e 投影索引据此区分
// 「目录 mtime 变了是自己写的」还是外部改动(外部改动当次做全量比对,自己写的只比名单)。写前、写后各记一次:
// 临时文件落下与 rename 各改一次目录 mtime,两次之间来的读也得认得出是自己。
let sessionsDirOwnWriteSeq = 0;
function noteSessionsDirOwnWrite(file) {
  if (paths && paths.sessions && path.dirname(String(file || '')) === paths.sessions) sessionsDirOwnWriteSeq += 1;
}

// ============================================================================
// 原子 JSON 写入：唯一临时文件、可选私有权限，失败清理自己创建的临时文件。
// Mac rename 原子发布；权限或路径冲突立即报错，保留旧目标。
async function atomicWriteJson(finalPath, value, opts = {}) {
  // typeof 守卫:本函数体会被 autonomy-durability 单独抽取执行(那里没有这个钩子)。
  const noteOwn = typeof noteSessionsDirOwnWrite === 'function' ? noteSessionsDirOwnWrite : () => {};
  noteOwn(finalPath);
  try {
    const payload = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const tmpPath = finalPath + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    // 对抗轮修(第25波): writeFile 自身失败(ENOSPC 典型——目录项已建、写入失败)同样必须清 tmp,否则
    // 节流重试每 1.5s 造一个新孤儿(唯一名无覆写自愈路径)。不变量③对 write 与 rename 两个失败点都成立。
    if (opts.exclusiveTemp === true) {
      let file, created = false;
      try {
        file = await fsp.open(tmpPath, 'wx', Number.isInteger(opts.mode) ? opts.mode : 0o600);
        created = true;
        try { await file.writeFile(payload, 'utf8'); } finally { await file.close(); file = null; }
      } catch (error) {
        if (file) { try { await file.close(); } catch { /* preserve the failed write */ } }
        // EEXIST is someone else's inode. Never unlink it while recovering our own attempt.
        if (created) { try { await fsp.unlink(tmpPath); } catch { /* best effort; no publication */ } }
        throw error;
      }
    } else {
      try { await fsp.writeFile(tmpPath, payload, Number.isInteger(opts.mode) ? { encoding: 'utf8', mode: opts.mode } : 'utf8'); }
      catch (e) { fsp.unlink(tmpPath).catch(() => {}); throw e; }
    }
    try { await fsp.rename(tmpPath, finalPath); }
    catch (e) {
      try { await fsp.unlink(tmpPath); } catch { /* best-effort tmp cleanup */ }
      throw e;
    }
  } finally { noteOwn(finalPath); }
}

const { readInstallRegistry, writeInstallRegistry, recordInstallLaunch } = require('./backend/install-registry.cjs').createInstallRegistry({
  dataDirectory: paths.data, externalRoot, samePathKey, nowIso, version: VERSION, atomicWriteJson,
});

// 117q-B6(30 号文 P2-10):「读文件末尾 N 字节」原语【统一入口】。此前四处独立手写同一套动作
// (stat 拿 size -> 算尾窗起点 -> open -> 分配 buffer -> read -> finally 关 fd):02-session-store.js 的
// repairMissionChangeTornTail/repairInterventionTornTail 两处【不检查 bytesRead】——直接对整段已分配
// buffer 取最后一字节 / lastIndexOf,若 fd.read 实际读到的字节数少于请求量(stat 与 read 之间文件被
// 截短等罕见竞态),就会对 buffer 里未被写入的那一截(未初始化或陈旧内存)算截断点——而这个截断点
// 会被直接拿去 fsp.truncate()。算错就是真的截错数据。08-agent-runs.js/13g-steward.js 的两处已经在
// 检查 bytesRead,行为不变,只是把手写的 open/alloc/read/close 换成本函数。
// 返回 { buf, bytesRead, size }：size < 0 表示文件不存在(或 stat 失败,与原四处"stat 出错即当无文件"
// 同口径)；buf.length === 请求要读的字节数(= min(maxBytes, size) 且已 clamp 到 >=0),但【只有
// buf[0..bytesRead) 是本次 read 实际写入的有效数据】——调用方必须按 bytesRead 定界(取最后一个有效
// 字节要用 buf[bytesRead-1],扫 \n 要把 lastIndexOf 的搜索起点钉在 bytesRead-1),不能假设 bytesRead
// === buf.length。空文件(size===0)与「尾窗一字节都不用读」的退化情形直接返回 bytesRead:0,不开 fd。
async function readFileTail(file, maxBytes) {
  let size = -1;
  try { size = (await fsp.stat(file)).size; } catch { return { buf: Buffer.alloc(0), bytesRead: 0, size: -1 }; }
  const max = Math.max(0, Math.floor(Number(maxBytes) || 0));
  const start = Math.max(0, size - max);
  const want = size - start;
  if (!want) return { buf: Buffer.alloc(0), bytesRead: 0, size };
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, start);
    return { buf, bytesRead, size };
  } finally { if (fh) await fh.close().catch(() => {}); }
}

// ── 103c: composable lifecycle for small durable JSON state ──────────────────
// This is deliberately narrower than a database abstraction. NDJSON append logs, session v2 bodies,
// exit-time synchronous snapshots and externally-owned files keep their dedicated protocols. The helper
// below only centralizes the lifecycle that small workbench-owned JSON stores were independently rebuilding:
// schema admission, sanitization, corruption quarantine, bounded collections, serialized atomic writes and
// an explicit process cache/invalidation contract.
// 架构还债批 2 B3:新写的小 JSON 存储一律用它(不再各自手写 read/parse/schema/隔离/原子写那一套)。两个可选项
// 让「坏了就当空」一族的存量存储能逐字节不变地迁进来:
//   quarantine: false —— 坏文件/读不动/错 schema 静默回落默认值,原文件留在原处、不复制成 .corrupt(onCorrupt 仍照常调,corruptPath 为空串);
//   read()           —— readSync 的异步版(fsp.readFile),同一套 prepare/回落/缓存规则,给本来就在 async 路径上的存储用。
const DurableJsonStore = require('./backend/durable-json-store.cjs').createDurableJsonStore({ fs, fsp, path, atomicWriteJson });

const { ACC_MEMORY_IMPORT_SCHEMA, accMemoryImportStore, legacyAccMemoryMigrationComplete } = require('./backend/acc-memory-import-marker.cjs').createAccMemoryImportMarker({
  DurableJsonStore, memoryDirectory: paths.memory,
});

const ToolboxRegistry = require('./backend/toolbox-registry.cjs').createToolboxRegistry({ logEvent, safeJsonParse });
const { enabled: enabledToolboxComponents, directory: toolboxComponentsDir } = ToolboxRegistry;
const { mcpDropInDirs, scanMcpDropIns, invalidateMcpDropInCache, isEquivalentDesktopAccServer, resolveExternalMcpServers } = require('./backend/mcp-sources.cjs').createMcpSources({
  externalRoot, dataRoot, enabledToolboxComponents, detectDesktopMcp, legacyAccMemoryMigrationComplete, logEvent,
});

const { projectAgentRoleFile, readProjectAgentRoles, readClaudeProjectAgentRoles, getAgentRoleLibrary, saveProjectAgentRoles, buildClaudeAgentDefinitions } = require('./backend/agent-role-library.cjs').createAgentRoleLibrary({ atomicWriteJson });


const {
  readConfig, writeConfig, writeConfigAtomic, mutateConfig, configEmitWritten, invalidateConfigRecoveryState,
} = require('./backend/config-store.cjs').createConfigStore({
  paths, ensureDirs, safeJsonParse, atomicWriteJson: (...args) => atomicWriteJson(...args),
  normalizeConfig, prepareConfigWrite, privacyHooks: PrivacyCore.configHooks, logEvent,
  detectClaudePath: () => detectClaudePath(), detectKimiPath: () => detectKimiPath(),
  waitForConfigCliProbes: () => {
    if (bootCliPathProbes && !bootCliPathProbes.beforeListen && bootCliPathProbes.pending.size) return waitForBootCliPathProbes();
  },
  onWritten: status => RUYI_EVENTS.emit('config.written', status),
});

// 架构还债批 2 B2:配置补丁的落盘与副作用 applyConfigPatch 住在 06k-config-patch.js(它要调 02 / 05 / 06i 的
// 同步原语,放在 01 里会造出 01->02、01->06i 两条新前向边)。两个调用方(13 的 POST /api/config、13l 的
// steward_config_set)经这个命名空间调,不直接引用 06k 的符号 —— 否则 06k 会被卷进唯一的大 SCC。
//   applyConfigPatch(rawBody) -> Promise<next>(06k 加载时填入;契约见 06k 里那个函数的头注)
const ConfigPatchHooks = {};

const { createClaudeConfigSync, RUYI_AGENT_FILE_MARKER } = require('./backend/claude-config-sync.cjs');
const { syncClaudeCliSettings, syncAgentRolesToClaude } = createClaudeConfigSync({
  paths, atomicWriteJson, getAgentRoleLibrary, logEvent,
});
const { syncMcpServersToClaude, syncAgentCliMcpManifests, syncMcpServersToKimi } =
  require('./backend/cli-mcp-sync.cjs').createCliMcpSync({
    paths, ensureDirs, generateMcpConfig, resolveExternalMcpServers, existsExecutableAsync,
    desktopMcpPolicyEnv, DesktopShell, getAgentCliHost: () => AGENT_CLI_HOST, atomicWriteJson, logEvent,
  });
const { autoImportClaudeCodeMcp, agentMcpImportSources, kimiMcpManagedIds, classifyAgentMcpCandidate } =
  require('./backend/cli-mcp-import.cjs').createCliMcpImport({
    paths, agentCliHomes, findRuyiPackageRootFor, mutateConfig, logEvent,
  });

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
      const ok = spawnProbeSync(s.command, s.args, { stdio: 'ignore', timeout: 4000, ...s.opts });
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
      const ok = await spawnProbeAsync(s.command, s.args, s.opts);
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

// Agent CLI 类型登记表 AGENT_CLI_TYPES 与归一 normalizeAgentCliType / isAgentCliType 在 01f-agent-cli-types.js(零出边,
// 02e 也要用)。登记项里要用本模块实现的钩子,经下面这个宿主拿 —— 01f 自己不引用 01 的符号。
const AGENT_CLI_HOST = Object.freeze({
  detectClaudePath: () => detectClaudePath(),
  detectFromInstallCandidates: type => detectAgentCliPath(type),
  resolveKimiNpmEntry: command => resolveKimiNpmEntry(command),
  bundledNodeExe: () => bundledNodeExe(),
  syncMcpServersToKimi: config => syncMcpServersToKimi(config),
});
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
    const ok = spawnProbeSync(s.command, s.args, { stdio: 'ignore', timeout: 4000, ...s.opts });
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
    const result = await spawnProbeAsync(s.command, s.args, s.opts);
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
function detectKimiPath() { return detectAgentCliPath('kimi'); }
function selectedAgentCli(config) {
  const meta = AGENT_CLI_TYPES[normalizeAgentCliType(config && config.agentCliType)];
  const detected = meta.detectPath(AGENT_CLI_HOST);
  return { ...meta, path: String(config && config[meta.pathKey] || detected || ''), detected };
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

function prepareAgentCliSpawn(type, command, args) {
  const argv = Array.isArray(args) ? args : [];
  return AGENT_CLI_TYPES[normalizeAgentCliType(type)].prepareSpawn(AGENT_CLI_HOST, command, argv);
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

// Claude Code normally writes UTF-8, but its Windows launcher can forward a local
// command failure in the active ANSI code page.  Decode GB18030 only after UTF-8
// proves invalid; this keeps normal CLI diagnostics byte-for-byte unchanged while
// making the actionable error readable for Chinese Windows installs.
//
// hunt2-engines#8:按块独立解码会把「块边界切在一个汉字中间」的正常 UTF-8 误判成非法,再按 GB18030 解出一串乱码。
// 子进程的一条流(stderr)请传同一个状态对象 stream(调用方给一个 {} 即可):UTF-8 走 StringDecoder(被切开的尾字节
// 留到下一块再解);只有 UTF-8 真的非法时才整流切到 GB18030(同样是流式解码器)。流结束时传 chunk=null 冲出残字节。
// 不传 stream 时行为与修前逐字节相同(一次性整段解码的调用点)。
function decodeClaudeCliText(chunk, stream) {
  if (stream && typeof stream === 'object') return decodeClaudeCliStream(chunk, stream);
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || '');
  if (!bytes.length) return '';
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const decoded = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
    return decoded || utf8;
  } catch {
    return utf8;
  }
}

function decodeClaudeCliStream(chunk, stream) {
  if (!stream.utf8) stream.utf8 = new StringDecoder('utf8');
  if (chunk === null) {
    const rest = stream.gb ? stream.gb.decode() : stream.utf8.end();
    stream.gb = null;
    return rest;
  }
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || '');
  if (!bytes.length) return '';
  if (stream.gb) {
    try { return stream.gb.decode(bytes, { stream: true }); } catch { stream.gb = null; return bytes.toString('utf8'); }
  }
  const utf8 = stream.utf8.write(bytes);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const gb = new TextDecoder('gb18030', { fatal: true });
    const decoded = gb.decode(bytes, { stream: true });
    stream.gb = gb;
    return decoded || utf8;
  } catch {
    return utf8;
  }
}

// Kimi's official Claude Code setup uses the /coding/ endpoint (including its trailing
// slash) and requires Claude's internal role aliases to resolve to a Kimi model.  Do
// not apply this to generic Anthropic-compatible endpoints: their aliases can have
// vendor-specific meanings.
function isKimiCodingEndpoint(base) {
  try {
    const url = new URL(String(base || '').trim());
    return url.hostname.toLowerCase() === 'api.kimi.com' && url.pathname.replace(/\/+$/, '') === '/coding';
  } catch {
    return false;
  }
}

// Third-party Anthropic-compatible endpoint (e.g. a vendor Coding Plan) config → env overrides.
// Only returns keys the user actually configured in modelsApiBase/modelsApiKey/model — an unconfigured
// field leaves whatever the OS/shell env already has untouched, so an install with no third-party setup
// behaves exactly as before. Config wins over a stale inherited env var so a hot model/endpoint switch in
// the UI can't be silently shadowed by an old `setx`-set value (previously these fields only fed the
// model-LIST discovery probe, never the actually-spawned CLI child — this is the fix for that gap).
// authMode picks which auth header the CLI sees: 'bearer' -> ANTHROPIC_AUTH_TOKEN only (required by Ark
// Coding Plan), 'x-api-key' -> ANTHROPIC_API_KEY only (Anthropic official protocol), 'auto' sets both (a
// safe hedge for an unspecified vendor, matching this function's pre-existing dual-header behavior). When
// a key is configured, the OTHER header is force-cleared — per this project's own admin guide, having both
// present at once makes the CLI pick the wrong auth scheme.
function buildClaudeCliEnv(config) {
  const env = {};
  // Preserve a trailing slash: Kimi's documented Claude Code endpoint is /coding/.
  const base = String((config && config.modelsApiBase) || '').trim();
  const kimiCoding = isKimiCodingEndpoint(base);
  if (base) {
    env.ANTHROPIC_BASE_URL = base;
    // A custom endpoint is moot if the CLI is routed to Bedrock/Vertex instead — both ignore
    // ANTHROPIC_BASE_URL entirely. Clear them so a configured third-party endpoint always wins.
    env.CLAUDE_CODE_USE_BEDROCK = '';
    env.CLAUDE_CODE_USE_VERTEX = '';
  }
  const key = String((config && config.modelsApiKey) || '').trim();
  if (key) {
    const configuredMode = ['bearer', 'x-api-key'].includes(config && config.claudeAuthMode) ? config.claudeAuthMode : 'auto';
    // Kimi documents ANTHROPIC_API_KEY; sending a second auth scheme can make a
    // newer Claude CLI pick a credential path the proxy does not expect.
    const mode = kimiCoding && configuredMode === 'auto' ? 'x-api-key' : configuredMode;
    if (mode === 'bearer') { env.ANTHROPIC_AUTH_TOKEN = key; env.ANTHROPIC_API_KEY = ''; }
    else if (mode === 'x-api-key') { env.ANTHROPIC_API_KEY = key; env.ANTHROPIC_AUTH_TOKEN = ''; }
    else { env.ANTHROPIC_AUTH_TOKEN = key; env.ANTHROPIC_API_KEY = key; }
  }
  const model = String((config && config.model) || '').trim();
  if (model) {
    env.ANTHROPIC_MODEL = model;
    if (kimiCoding) {
      // A native Agent may ask Claude Code for a fast/default family even when the
      // primary model is overridden.  Route every family to the user's selected
      // entitled Kimi model instead of falling back to an unavailable Claude id.
      env.ANTHROPIC_DEFAULT_FABLE_MODEL = model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      env.ANTHROPIC_SMALL_FAST_MODEL = model;
      env.CLAUDE_CODE_SUBAGENT_MODEL = model;
    }
  }
  return env;
}
// The full env a Claude CLI child (or the model-discovery probe) should see: the process's own env,
// overlaid with the config-driven overrides above. Single source of truth so runClaudeTurn (the real
// spawn) and fetchProxyModels (the model-list probe) can never drift apart on which endpoint is "live".
function effectiveAnthropicEnv(config) {
  return { ...process.env, ...buildClaudeCliEnv(config) };
}

const { getProxyModelsCache, setProxyModelsCache, offlineModelList, modelCapabilityTier, buildModelHint, tierModelForNode, resolveNodeModel, fetchProxyModels, discoverModels } = require('./backend/model-selection.cjs').createModelSelection({
  dataDirectory: paths.data, atomicWriteJson, effectiveAnthropicEnv,
});

function externalServerJs() {
  const p = path.join(externalRoot(), 'app', 'server.js');
  return fs.existsSync(p) ? p : '';
}

function bundledNodeExe() {
  const bundled = path.join(externalRoot(), 'runtime', 'node', 'bin', 'node');
  return fs.existsSync(bundled) ? bundled : process.execPath;
}

function commandForSelfMcp() {
  return { command: bundledNodeExe(), args: [externalServerJs() || path.resolve(__filename), 'mcp'], via: 'node' };
}

// Verify the offline ACC interpreter and its imports before offering desktop tools.
const DESKTOP_PYTHON_OK_CACHE_MS = 5 * 60 * 1000;
const DESKTOP_PYTHON_MISS_CACHE_MS = 15000;
const { createDesktopPythonProbe, DESKTOP_PYTHON_IMPORT_PROBE } = require('./backend/desktop-python-probe.cjs');
const { probeDesktopPython, probeDesktopPythonAsync } = createDesktopPythonProbe(ProcessRuntime);
const desktopPythonCache = new Map(); // repo/root -> { at, value:{command,args,source}|null }
// 128f-③:pickPython 的「只读缓存」模式(深度计数,可嵌套)与「这一轮遇到过未命中」位 —— 见 desktopMcpDetectionPending。
let desktopMcpCacheOnlyDepth = 0;
let desktopMcpCacheMissed = false;
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
  // 128f-③:「只读缓存」模式(desktopMcpDetectionPending)下缓存未命中只记一笔、不探 —— 调用方据此知道「探测还在飞」。
  if (desktopMcpCacheOnlyDepth > 0) { desktopMcpCacheMissed = true; return null; }
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
function desktopMcpFromRepo(repoRoot) {
  const desktopEnv = desktopMcpRepoEnv(repoRoot);
  return desktopMcpEntryFor(pickPython(repoRoot, desktopEnv), repoRoot, desktopEnv);
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
      path.join(__dirname, '..', '..', 'mcp', 'ai-computer-control'),
      path.join(__dirname, '..', 'mcp', 'ai-computer-control'),
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
function detectDesktopMcp() {
  try {
    for (const step of desktopMcpRootPlan()) {
      const detected = step.kind === 'repo' ? desktopMcpFromRepo(step.root) : desktopMcpFromInstalledRoot(step.root);
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
// 128f-③(48 号文 §2-c):「桌面组件的 Python 探测此刻还在飞吗」—— 不另写一套判据,就用同一个 detectDesktopMcp()
// 在【只读缓存】模式下跑一遍:pickPython 遇到缓存未命中只记一笔、不探(见它开头那两行)。记到了 = 在飞(缓存冷),
// 顺手踢一脚预热(幂等,与启动那一趟共用同一个 Promise)。/api/status 据此不等、也不走同步探针 ——
// 修前它三处 await 预热,Full 包里那一趟是内嵌 Python 导入 FastMCP,整个界面跟着等 3–9 s(隔 5 分钟以上的每次启动都要付)。
function desktopMcpDetectionPending(config) {
  if (!desktopMcpAutodetectWanted(config)) return false;
  desktopMcpCacheOnlyDepth += 1;
  desktopMcpCacheMissed = false;
  try { detectDesktopMcp(); }
  finally { desktopMcpCacheOnlyDepth -= 1; }
  const pending = desktopMcpCacheMissed;
  desktopMcpCacheMissed = false;
  if (pending) void ensureDesktopMcpWarm(config);
  return pending;
}

// Runtime coordinates for loopback callbacks (permission bridge). Set in startServer().
// v0.8-S2: isMcpChild is set true only in startMcp() — the one-shot MCP subprocess the Claude CLI spawns.
// Shell-session tools guard on it: their state lives in the serve process, so the child cannot serve them.
const RUNTIME = { port: DEFAULT_PORT, host: '127.0.0.1', token: '', isMcpChild: false };

// 安全修复(审计 A①)的判据:桥接 MCP 服务器(ACC 桌面控制、第三方 stdio MCP)不得从启动它的进程继承工作台凭据。
// 去掉所有 WCW_*(工作台内部键:回环令牌 / 端口 / 会话号等;唯一例外 WCW_DATA_DIR —— ACC paths.py 认的数据目录覆盖,
// 由用户/测试设置,不是凭据),以及工作台按配置注入 CLI 环境的模型凭据 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY
// (buildClaudeCliEnv;桌面/文档类 MCP 用不到)。两处共用这一个判据:
//   · 工作台自己 spawn 桥接服务器(04 bridgedServerSpawnEnv:直接从继承环境里删);
//   · 交给 agent CLI 去 spawn(下面 bridgedCliServerEnv:写进 --mcp-config / Kimi mcp.json 的条目 env 块)。
const BRIDGED_ENV_KEEP = new Set(['WCW_DATA_DIR']);
const BRIDGED_ENV_DROP = new Set(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);
function bridgedEnvKeyStripped(key) {
  const up = String(key).toUpperCase();
  if (BRIDGED_ENV_KEEP.has(up)) return false;
  return up.startsWith('WCW_') || BRIDGED_ENV_DROP.has(up);
}
// 后续补漏(审计 A① 的 CLI 直挂面):toolLoadingMode:'full' 的会话与 exec 档 Claude DAG 节点把桥接服务器直接写进
// --mcp-config,由 Claude CLI 自己 spawn —— 子进程环境 = CLI 的环境叠条目 env。CLI 的环境里有工作台注入的模型密钥
// (buildClaudeCliEnv),Kimi 进程的环境里还有回合级 WCW_TOKEN 等(05b 靠继承把它们交给如意的 MCP 子进程),
// 修前 ACC 的 get_environment_variable 一问就拿到。配置文件只能【加/盖】变量、不能删,所以把这些键在条目 env 块里
// 盖成空串:固定一组已知凭据键,再加本进程环境里此刻存在的其它 WCW_*(被别的如意回合拉起时继承来的)。
// 条目自己声明的 env 叠在最后,照常生效(与 04 同口径)。
const BRIDGED_CLI_ENV_BLANK_KEYS = Object.freeze(['WCW_TOKEN', 'WCW_PORT', 'WCW_HOST', 'WCW_SESSION_ID', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);
function bridgedCliServerEnv(ownEnv, baseEnv = process.env) {
  const blanks = {};
  for (const k of BRIDGED_CLI_ENV_BLANK_KEYS) blanks[k] = '';
  for (const k of Object.keys(baseEnv || {}).sort()) if (bridgedEnvKeyStripped(k)) blanks[k] = '';
  return { ...blanks, ...(ownEnv && typeof ownEnv === 'object' ? ownEnv : {}) };
}

// 2026-10 能力总闸的 CLI 直挂面:交给 agent CLI 自己 spawn、自己调的 ACC 不经工作台的分发点(09/08/12),唯一能插手的是它的
// 启动环境 —— 把 07 toolDisabledByPolicy 判下来被关掉的 ACC 工具名(accPolicyHiddenToolNames,与分发面同一张表)经
// ACC_HIDE_TOOLS 交给 ACC,它在注册表里摘掉:tools/list 里没有,batch_actions / macro_run 也转调不到。只给内置桌面 MCP
// 条目;一个都没关时不加这个键(生成的配置与修前逐字节相同)。旧版 ACC 不认这个变量 —— 那时只剩 13d 权限桥那道纵深。
function desktopMcpPolicyEnv(entryId, config, desktopOverride = null) {
  if (entryId !== DESKTOP_MCP_SERVER_ID || !config) return {};
  const hidden = accPolicyHiddenToolNames(config, desktopOverride);
  return hidden.length ? { ACC_HIDE_TOOLS: hidden.join(',') } : {};
}

// v0.7d: mutate an mcpServers map in place, adding the desktop MCP (id 'ai-computer-control') and every
// enabled user externalMcpServers entry. Back-compat: when nothing is detected/configured, the map is
// left exactly as it was, so the generated config equals the pre-0.7d output.
// stdio 条目一律带 env 块(bridgedCliServerEnv:置空工作台凭据 + 条目自己的 env);远程(sse/http)条目没有子进程。
// opts.desktopOverride:会话级 desktopTools(null = 跟随全局;只有按会话生成的配置才传,见 generateSessionMcpConfig)。
function addExternalMcpServersToMap(mcpServers, config, opts) {
  if (!config) return;
  const desktopOverride = (opts && opts.desktopOverride != null) ? opts.desktopOverride : null;
  try {
    for (const entry of resolveExternalMcpServers(config)) {
      if (mcpServers[entry.id]) continue;    // never clobber Ruyi's own server (id 'ruyi') or an earlier entry
      let server;
      if (entry.transport === 'sse' || entry.transport === 'http') {
        server = { type: entry.transport, url: entry.url };
        if (entry.headers && Object.keys(entry.headers).length) server.headers = entry.headers;
        if (entry.bearerTokenEnvVar) server.bearerTokenEnvVar = entry.bearerTokenEnvVar;
      } else {
        server = { type: 'stdio', command: entry.command, args: entry.args || [] };
        if (entry.cwd) server.cwd = entry.cwd;
        server.env = { ...bridgedCliServerEnv(entry.env), ...desktopMcpPolicyEnv(entry.id, config, desktopOverride) };
      }
      mcpServers[entry.id] = server;
    }
  } catch { /* detection must never break config generation */ }
}

// 生成的 MCP 配置文件路径(唯一一处拼它)。128f-③:探测在飞时 /api/status 只回这条路径、不重新生成。
function mcpConfigFilePath() { return path.join(paths.generated, 'workbench.mcp.json'); }
async function generateMcpConfig(mode) {
  await ensureDirs();
  const cfg = await readConfig().catch(() => null);
  // 39 号文:本函数下面 addExternalMcpServersToMap → resolveExternalMcpServers → detectDesktopMcp 是
  // 【同步】的,冷缓存时会把整个进程钉住一轮探针。它自己是 async,所以先等那趟异步预热——
  // 实测就是这一处:只在 /api/status 的 desktopMcp 那一段等预热不够,mcpConfigPath 排在它【前面】,
  // 同一个响应里先被这一处堵住(boot-listen-budget 的「探针在飞时 /health 秒答」因此偶红)。
  // 排在 readConfig 之后,是因为「该不该预热」要看 config(停用/显式覆盖时一发都不放)。
  await ensureDesktopMcpWarm(cfg);
  if (!mode) mode = cfg?.mcpCommandMode || 'auto';
  const self = commandForSelfMcp(mode);
  const configPath = mcpConfigFilePath();
  const mcp = {
    mcpServers: {
      // 3.0 收口:server id 由 'win-claude-workbench' 改为 'ruyi'(RUYI_MCP_SERVER_ID;存量登记的清理见 00-boot 注释)。
      [RUYI_MCP_SERVER_ID]: {
        type: 'stdio',
        command: self.command,
        args: self.args,
        env: {
          // MCP 子进程的数据根 = 父进程已解析的 dataRoot(3.0 起只写 RUYI_HOME;旧变量名 WIN_CLAUDE_WORKBENCH_HOME 只读兼容)。
          RUYI_HOME: paths.data,
        },
      },
    },
  };
  addExternalMcpServersToMap(mcp.mcpServers, cfg);
  await atomicWriteJson(configPath, mcp);
  return configPath;
}

// hunt2-P9:每会话 / 每子代理节点的 MCP 配置(workbench.mcp.<id>.json)里有 loopback token 与外部 MCP 的 env,
// 修前从不删除 —— 删会话只删会话本身,子代理节点那一份更是跑完就没人管,generated/ 里无界堆积带密钥的文件。
// 删会话时 02 deleteSession 顺手删对应那份;这里再按年龄兜底:每次起引擎都会重写自己那份(mtime 刷新),
// 超过 SESSION_MCP_CONFIG_MAX_AGE_MS 没被重写的就是没人再用的。每进程只扫一次,失败静默(旁路清理)。
const SESSION_MCP_CONFIG_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
let sessionMcpConfigSweepDone = false;
async function sweepStaleSessionMcpConfigs(nowMs = Date.now()) {
  let removed = 0;
  let names = [];
  try { names = await fsp.readdir(paths.generated); } catch { return removed; }
  for (const name of names) {
    // 只认 workbench.mcp.<id>.json;共享的 workbench.mcp.json 不在此列。
    if (!/^workbench\.mcp\.[A-Za-z0-9_-]{1,64}\.json$/.test(name)) continue;
    const file = path.join(paths.generated, name);
    try {
      const st = await fsp.stat(file);
      if (st.isFile() && nowMs - st.mtimeMs > SESSION_MCP_CONFIG_MAX_AGE_MS) { await fsp.unlink(file); removed += 1; }
    } catch { /* 并发删除 / 一时被锁:下个进程再扫 */ }
  }
  return removed;
}

// 走查 W1·F10:script_run 把脚本明文落在 <generated>/scripts/,正常路径执行完立刻删(12 script_run 的 finally);进程被强杀 / 杀毒占着删不掉时
// 会留下孤儿 —— 里面可能有模型嵌进去的密钥。这里按龄兜底:启动时扫一次(13 起服务处调),超过 SCRIPT_FILE_MAX_AGE_MS 没动过的删。
// 脚本最长跑 30 分钟(timeoutMs 上限 1800000),一天的余量足够不碰在跑的。只删 scripts/ 下的普通文件,失败静默(旁路清理)。
// screenshot-*.png 不在此列:聊天里的工具图片卡片经 /api/file/preview 按路径回读它们,清掉会让历史对话里的截图变成裂图。
const SCRIPT_FILE_MAX_AGE_MS = 24 * 3600 * 1000;
async function sweepStaleScriptFiles(nowMs = Date.now()) {
  const dir = path.join(paths.generated, 'scripts');
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = await fsp.lstat(file);
      if (st.isFile() && nowMs - st.mtimeMs > SCRIPT_FILE_MAX_AGE_MS) { await fsp.unlink(file); removed += 1; }
    } catch { /* 并发删除 / 一时被锁:下个进程再扫 */ }
  }
  return removed;
}

// Per-session MCP config that injects the session id + loopback port/token into the MCP child's env,
// so the permission-bridge tool (running in that child) can call back and be routed to the right UI stream.
// opts.desktopOverride:这条线程的会话级 desktopTools(05 Claude 引擎按会话头传;子代理节点不传 = 跟随全局),只影响直挂 ACC
// 条目的 ACC_HIDE_TOOLS(见 desktopMcpPolicyEnv)。
async function generateSessionMcpConfig(sessionId, mode, toolPacks, opts) {
  await ensureDirs();
  if (!sessionMcpConfigSweepDone) { sessionMcpConfigSweepDone = true; void sweepStaleSessionMcpConfigs().catch(() => {}); }
  const cfg = await readConfig().catch(() => null);
  if (!mode) mode = cfg?.mcpCommandMode || 'auto';
  const self = commandForSelfMcp(mode);
  const configPath = path.join(paths.generated, `workbench.mcp.${sessionId}.json`);
  const mcp = {
    mcpServers: {
      // 同 generateMcpConfig:server id 是 RUYI_MCP_SERVER_ID。
      [RUYI_MCP_SERVER_ID]: {
        type: 'stdio',
        command: self.command,
        args: self.args,
        env: {
          RUYI_HOME: paths.data,
          WCW_SESSION_ID: sessionId,
          WCW_PORT: String(RUNTIME.port),
          WCW_HOST: RUNTIME.host,
          WCW_TOKEN: RUNTIME.token,
          WCW_TOOL_LOADING_MODE: cfg?.toolLoadingMode || 'auto',
          WCW_TOOL_PACKS: Array.isArray(toolPacks) ? toolPacks.join(',') : '',
        },
      },
    },
  };
  // In adaptive mode external schemas stay behind the typed invoke proxies, so a simple Claude turn
  // does not ingest an entire desktop/Office catalog. Full mode retains the historical direct servers.
  if (!cfg || cfg.toolLoadingMode === 'full') addExternalMcpServersToMap(mcp.mcpServers, cfg, { desktopOverride: opts && opts.desktopOverride });
  await atomicWriteJson(configPath, mcp);
  return configPath;
}

// One-shot analog of generateSessionMcpConfig for a DAG node's Claude-engine spawn (runClaudeSubAgentOnce)
// — same content, keyed by subagentId instead of a session id. When allowedServerIds is a non-empty array
// (role.mcpServers) the config is narrowed to just those server ids, mirroring the OpenAI subagent path's
// own rule (runSubAgentCore): an explicit mcpServers list restricts which bridged servers a node can reach;
// leaving it unset/empty means "everything the workbench has configured" for exec-tier nodes.
async function generateAgentNodeMcpConfig(subagentId, mode, allowedServerIds) {
  const configPath = await generateSessionMcpConfig(subagentId, mode, Object.keys(TOOL_PACK_DESCRIPTIONS));
  try {
    const raw = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    const own = raw.mcpServers && raw.mcpServers[RUYI_MCP_SERVER_ID];
    if (own) own.env = { ...(own.env || {}), WCW_DISABLE_USER_INPUT: '1' };
    // This helper is used only for exec-tier Claude nodes. Preserve their explicit direct-MCP contract;
    // the main interactive Claude path uses adaptive proxies instead.
    addExternalMcpServersToMap(raw.mcpServers, await readConfig().catch(() => null));
    if (Array.isArray(allowedServerIds) && allowedServerIds.length) {
      const allowed = new Set(allowedServerIds.map(canonicalRuyiMcpServerId)); // 3.0:未经清洗的角色(.md 前言)里的旧 id 也认
      raw.mcpServers = Object.fromEntries(Object.entries(raw.mcpServers || {}).filter(([id]) => allowed.has(id)));
    }
    await atomicWriteJson(configPath, raw);
  } catch { /* best-effort — fall through with the unfiltered config rather than fail the node */ }
  return configPath;
}

// --- Interactive stream-json envelopes (defensive; exact shapes are underdocumented). ---
function buildUserEnvelope(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text || '') }] } };
}
function writeToChild(sessionId, obj) {
  const reg = activeChildren.get(sessionId);
  if (!reg || !reg.child || !reg.child.stdin.writable) return false;
  try {
    if (typeof PrivacyCore !== 'undefined') PrivacyCore.configHooks.assertCliAllowed?.();
    reg.child.stdin.write(JSON.stringify(obj) + '\n', 'utf8'); return true;
  } catch { return false; }
}
// Tools the workbench OWNS the interactive answer for (never intercept tools the CLI runs itself).
function isAskUserTool(name) {
  return typeof name === 'string' && name.replace(/[^a-z]/gi, '').toLowerCase().includes('askuserquestion');
}

const { staticBase, serveStatic } = require('./backend/static-assets.cjs').createStaticAssets({
  externalRoot, publicDirectory: path.join(__dirname, 'public'), pathWithinRoot, requestIsLoopback, runtime: RUNTIME,
});

const HttpAuthorization = require('./backend/http-authorization.cjs').createHttpAuthorization(RUNTIME);
function hostAllowed(...args) { return HttpAuthorization.hostAllowed(...args); }
function isLoopbackAddress(...args) { return HttpAuthorization.isLoopbackAddress(...args); }
function requestIsLoopback(...args) { return HttpAuthorization.requestIsLoopback(...args); }
function isLoopbackBindHost(...args) { return HttpAuthorization.isLoopbackBindHost(...args); }
function originOk(...args) { return HttpAuthorization.originOk(...args); }
function tokenMatches(...args) { return HttpAuthorization.tokenMatches(...args); }
function tokenOk(...args) { return HttpAuthorization.tokenOk(...args); }
function authorizeRoute(...args) { return HttpAuthorization.authorizeRoute(...args); }

// F4 (安全·消毒): accept only a well-formed session id. Returns the id unchanged when it matches the
// canonical shape (letters/digits/_/-, 1..64), else null. Real ids look like `session_<hex>` → pass
// naturally. Callers treat null as a 400. Blocks path-ish / oversized / control-char ids from ever
// reaching loadSession / journal / activeChildren lookups.
// 会话目录里还住着不是会话的 .json:侧栏索引 index.json、内容搜索索引 _search-index-v1.json(13d)。它们的文件名
// 本身形状合法,修前 GET /api/sessions/_search-index-v1 会把搜索索引当成 v1 会话「懒迁移」(头被改写、旁边长出
// 两个正文),DELETE /api/sessions/index 直接 unlink 侧栏索引。所以保留名一律不是会话 id:`index`,以及任何以
// `_` 开头的名字(工作台自己往会话目录里放的旁车文件都用这个前缀,以后新加的也照此起名)。真会话 id 的形状是
// makeId('sess') 的 `sess_<16 hex>`、管家会话的 `steward`,都不受影响。
// 同一张表里还有 Windows 的保留设备名:`CON.json` / `NUL.json` 在 Win32 路径语义下指向设备而不是文件
// (大小写不敏感,所以比对前先转小写 —— `INDEX.json` 在 NTFS 上也就是 index.json)。
const RESERVED_SESSION_FILE_IDS = new Set([
  'index', 'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);
function safeSessionId(raw) {
  const s = String(raw == null ? '' : raw);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) return null;
  if (s.startsWith('_') || RESERVED_SESSION_FILE_IDS.has(s.toLowerCase())) return null;
  return s;
}

// 会话 id 拼成文件名的咽喉点:不合形的 id 在这里就拒掉(抛错),不靠每个调用方记得先 safeSessionId ——
// 修前有几条路由(/api/chat/stream、/api/session/skills、/api/session/memories、工具上下文)直接拿请求体里的
// sessionId 拼路径,`../config` 就读到了 <数据根>/config.json(连同服务商密钥)当会话回显出去。
function assertSessionIdForPath(id) {
  if (safeSessionId(id) === null) throw new Error('invalid session id');
  return String(id);
}
function sessionPath(id) {
  return path.join(paths.sessions, `${assertSessionIdForPath(id)}.json`);
}
// 第25波对抗轮: per-session 写链(见 saveSession)—— 与 agentRunWriteChains 同范式。
