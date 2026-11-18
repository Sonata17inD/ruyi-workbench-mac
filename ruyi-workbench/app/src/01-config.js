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
  externalRoot, dataRoot, enabledToolboxComponents, detectDesktopMcp: () => detectDesktopMcp(), legacyAccMemoryMigrationComplete, logEvent,
});

const { projectAgentRoleFile, readProjectAgentRoles, readClaudeProjectAgentRoles, getAgentRoleLibrary, saveProjectAgentRoles, buildClaudeAgentDefinitions } = require('./backend/agent-role-library.cjs').createAgentRoleLibrary({ atomicWriteJson });


const {
  readConfig, writeConfig, writeConfigAtomic, mutateConfig, configEmitWritten, invalidateConfigRecoveryState,
} = require('./backend/config-store.cjs').createConfigStore({
  paths, ensureDirs, safeJsonParse, atomicWriteJson: (...args) => atomicWriteJson(...args),
  normalizeConfig, prepareConfigWrite, privacyHooks: PrivacyCore.configHooks, logEvent,
  detectClaudePath: () => detectClaudePath(), detectKimiPath: () => detectKimiPath(),
  waitForConfigCliProbes: () => AgentCliDiscovery.waitForConfigCliProbes(),
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
// Loopback coordinates for per-session permission callbacks; only startMcp marks a child.
const RUNTIME = { port: DEFAULT_PORT, host: '127.0.0.1', token: '', isMcpChild: false };
const { externalServerJs, bundledNodeExe, commandForSelfMcp, mcpConfigFilePath, generateMcpConfig,
  generateSessionMcpConfig, generateAgentNodeMcpConfig } = require('./backend/mcp-manifests.cjs').createMcpManifests({
  paths, runtime: RUNTIME, hostFile: __filename, externalRoot, ensureDirs, readConfig, resolveExternalMcpServers,
  ensureDesktopMcpWarm: config => ensureDesktopMcpWarm(config), atomicWriteJson, process,
});
const { syncMcpServersToClaude, syncAgentCliMcpManifests, syncMcpServersToKimi } =
  require('./backend/cli-mcp-sync.cjs').createCliMcpSync({
    paths, ensureDirs, generateMcpConfig, resolveExternalMcpServers, existsExecutableAsync,
    DesktopShell, getAgentCliHost: () => AGENT_CLI_HOST, atomicWriteJson, logEvent,
  });
const { autoImportClaudeCodeMcp, agentMcpImportSources, kimiMcpManagedIds, classifyAgentMcpCandidate } =
  require('./backend/cli-mcp-import.cjs').createCliMcpImport({
    paths, agentCliHomes, findRuyiPackageRootFor, mutateConfig, logEvent,
  });

const cliDiscoveryProbes = { spawnProbeSync, spawnProbeAsync };
const AgentCliDiscovery = require('./backend/agent-cli-discovery.cjs').createAgentCliDiscovery({
  probes: cliDiscoveryProbes, bundledNodeExe, process,
});
const {
  detectClaudePathUncached, detectClaudePathUncachedAsync, claudeProbeCandidates,
  detectAgentCliPathUncachedAsync, agentCliInstallCandidates, resolveKimiNpmEntry,
  probeAgentCliLauncher, probeAgentCliLauncherVerdictAsync, agentCliProbeVerdict,
  agentCliLauncherOk, agentCliLauncherUsable, invalidateClaudePathCache, invalidateAgentCliPathCaches,
  beginBootCliPathProbes, finishBootCliPathProbes, waitForBootCliPathProbes,
} = AgentCliDiscovery;
function detectClaudePath() { return AgentCliDiscovery.detectClaudePath(); }
function detectAgentCliPath(type) { return AgentCliDiscovery.detectAgentCliPath(type); }

const AGENT_CLI_HOST = Object.freeze({
  detectClaudePath: () => detectClaudePath(),
  detectFromInstallCandidates: type => detectAgentCliPath(type),
  resolveKimiNpmEntry: command => resolveKimiNpmEntry(command),
  bundledNodeExe: () => bundledNodeExe(),
  syncMcpServersToKimi: config => syncMcpServersToKimi(config),
});
function detectKimiPath() { return detectAgentCliPath('kimi'); }
function selectedAgentCli(config) {
  const meta = AGENT_CLI_TYPES[normalizeAgentCliType(config && config.agentCliType)];
  const detected = meta.detectPath(AGENT_CLI_HOST);
  return { ...meta, path: String(config && config[meta.pathKey] || detected || ''), detected };
}
function prepareAgentCliSpawn(type, command, args) {
  const argv = Array.isArray(args) ? args : [];
  return AGENT_CLI_TYPES[normalizeAgentCliType(type)].prepareSpawn(AGENT_CLI_HOST, command, argv);
}

const { decodeClaudeCliText } = require('./backend/text-codecs.cjs');
const { buildClaudeCliEnv, effectiveAnthropicEnv } = require('./backend/claude-cli-env.cjs');

const { getProxyModelsCache, setProxyModelsCache, offlineModelList, modelCapabilityTier, buildModelHint, tierModelForNode, resolveNodeModel, fetchProxyModels, discoverModels } = require('./backend/model-selection.cjs').createModelSelection({
  dataDirectory: paths.data, atomicWriteJson, effectiveAnthropicEnv,
});

const {
  pickPython, pickPythonAsync, probeDesktopPython, probeDesktopPythonAsync, desktopPythonCandidates,
} = require('./backend/desktop-python-selection.cjs').createDesktopPythonSelection({ ProcessRuntime, process });
const DesktopMcpDiscovery = require('./backend/desktop-mcp-discovery.cjs').createDesktopMcpDiscovery({
  appDirectory: __dirname, externalRoot, pickPython, pickPythonAsync, process,
});
const { detectDesktopMcp, detectDesktopMcpAsync, desktopMcpFromInstalledRoot, ensureDesktopMcpWarm } = DesktopMcpDiscovery;
function desktopMcpDetectionPending(config) { return DesktopMcpDiscovery.desktopMcpDetectionPending(config); }

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
