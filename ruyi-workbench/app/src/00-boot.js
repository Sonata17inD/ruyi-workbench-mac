'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 如意工作台 server(第43波 构建期拼接模块化)
//
// 本文件(app/src/00-boot.js)是【源码模块】之一:app/server.js 是由 app/build.js
// 把 app/src/*.js 按 src/manifest.json 顺序拼接出的【产物】。改代码请改 src/ 对应
// 模块,然后 `node app/build.js` 重建产物;不要手改 app/server.js(会被下次构建覆盖)。
// 产物字节级可复现(build --check 校验),运行时零依赖单文件,气隙可审。
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');
const readline = require('readline');
const { URL } = require('url');

const APP_NAME = '如意 Ruyi'; // v0.8-S8 品牌落地(原 'Win Claude Workbench';去 Claude 化,开源商标合规)
const VERSION = '3.0.1'; // 如意 Ruyi 3.0.1 修复更新（2026-10-16）
// Unique per running server instance; lets an updater prove the process actually restarted
// after an overlay was applied (a version string alone can't prove a restart happened).
const OVERLAY_ID = crypto.randomBytes(6).toString('hex');
// Runtime execution admission/cancellation hooks; early declaration also serves session rewind.
const SessionExecutionHooks = {};
// Root desktop authority is registered by a late module, outside the existing SCC.
const DesktopExecutionHooks = {};
const DeliveryHooks = {};
const ExternalBotHooks = {};
const DEFAULT_PORT = 8765;
// 127-114b(26 号文 §3/45 号文 §2 ②): ASR 转写入站专用上限 25 MB —— 早于上面的 128 MB 总闸判定
// (同一请求流里先撞哪条闸,决定 26 MB 夹具拿到的是 413 还是放行;反向:把本常量换成 MAX_BODY_BYTES
// 或把判定挪到 readBody 之后,asr-transcribe.e2e.js 的 24.9/26 MB 返回码对照当场红)。
const ASR_MAX_BODY_BYTES = 25 * 1024 * 1024;
// 14(2026-10):出厂权限档翻成「智能自动」。<14 的存量文件里没存过档的,迁移钉回当年的默认 'default'
// (01-config CONFIG_MIGRATIONS to:14)—— 新默认只给全新安装,不悄悄放开老用户。
// 13(128a,48 号文 §2):配置只落「改过的键」——显式键集合 configExplicitKeysV1 ＋ 稀疏落盘,没碰过的设置跟随
// 产品当前默认;迁移按显式键判。本号本身不挂迁移(推断每次读都跑),只标记「这份文件是稀疏格式写的」。
// 12(v2.8 / 107-T1): 126-111b/111d/111e 三个压缩开关翻成默认开,并对 schema<12 的存量配置做一次性
// 迁移(盘上显式写着的 false → true)。11 = v2.8 selectable Agent CLI driver (Claude Code / Kimi Code)。
const CONFIG_SCHEMA = 14;
// v0.8-S0: session file schema. Bumped independently of CONFIG_SCHEMA; normalizeSession backfills.
const SESSION_SCHEMA = 1;

function exePath() {
  return process.argv[1];
}

function appRoot() {
  return path.resolve(__dirname, '..');
}

// 3.0 收口(原 v1.0-S9「建议 v2.0 收口」):数据目录缺省名改为 .ruyi-workbench。解析顺序:
//   RUYI_HOME → WIN_CLAUDE_WORKBENCH_HOME(旧变量名,只读兼容,不再往子进程里写)→ ~/.ruyi-workbench;
//   新目录还不存在、旧目录 ~/.win-claude-workbench 是真目录(迁移没成或还没轮到)时继续用旧目录 —— 数据不会因为改名「消失」。
// 迁移(把旧目录搬成新名、原处留一个指回来的目录联接)只在直接运行 serve 时做一次,见 migrateLegacyDataRoot。
const RUYI_DATA_DIR_NAME = '.ruyi-workbench';
const LEGACY_DATA_DIR_NAME = '.win-claude-workbench';
function defaultDataRoots() {
  const home = os.homedir();
  return { next: path.join(home, RUYI_DATA_DIR_NAME), legacy: path.join(home, LEGACY_DATA_DIR_NAME) };
}
function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}
// dataRoot() / dataRootAliases() 在文件遍历的热路径上逐项被调(03 isSensitiveDataPath);每次都 lstat 两个目录在大树上是秒级开销。
// 结果按「两个环境变量 + 家目录」记住:进程内能改变答案的只有这三样(迁移发生在启动时,迁移后清一次缓存)。
let _dataRootMemo = null;
function dataRootMemoKey() {
  return [process.env.RUYI_HOME || '', process.env.WIN_CLAUDE_WORKBENCH_HOME || '', os.homedir()].join('\0');
}
function resolveDataRootUncached() {
  if (process.env.RUYI_HOME) return path.resolve(process.env.RUYI_HOME);
  if (process.env.WIN_CLAUDE_WORKBENCH_HOME) return path.resolve(process.env.WIN_CLAUDE_WORKBENCH_HOME);
  const { next, legacy } = defaultDataRoots();
  if (lstatOrNull(next)) return next;
  const old = lstatOrNull(legacy);
  if (old && old.isDirectory() && !old.isSymbolicLink()) return legacy;
  // 旧位置是用户自己建的链接 / 联接(数据挪去了别的盘)、新目录还没有:照旧用它。修前这里会落到一个空的新目录,
  // 配置、会话、密钥看起来全没了。迁移不搬链接(见 migrateLegacyDataRoot)。
  if (old && old.isSymbolicLink()) { try { if (fs.statSync(legacy).isDirectory()) return legacy; } catch { /* 断链:当它不存在 */ } }
  return next;
}
function dataRoot() {
  const key = dataRootMemoKey();
  if (_dataRootMemo && _dataRootMemo.key === key && _dataRootMemo.root) return _dataRootMemo.root;
  const root = resolveDataRootUncached();
  _dataRootMemo = { key, root, aliases: null };
  return root;
}
// 数据根的别名:指向同一个目录的其它写法 —— 迁移后旧位置上留的目录联接,或者新位置是指向旧目录的链接。敏感子树判定
// (03 isSensitiveDataPath 与文件遍历的跳过)是按词法前缀比的,只认数据根本身的话,经别名的写法就能读到 config.json /
// runtime.json(token)/ 会话。**与环境变量无关**:Claude / Kimi 的 MCP 子进程总带 RUYI_HOME,修前在那里一律返回空,
// 旧路径上的联接就成了绕过口。判据是 realpath 相等(Windows 上不分大小写),数据根还不存在时不缓存、下次再算。
function dataRootAliases() {
  const root = dataRoot();
  if (_dataRootMemo && _dataRootMemo.root === root && Array.isArray(_dataRootMemo.aliases)) return _dataRootMemo.aliases;
  const norm = p => (String(p));
  let rootReal = '';
  try { rootReal = norm(fs.realpathSync(root)); } catch { return []; }
  const { next, legacy } = defaultDataRoots();
  const out = [];
  for (const candidate of [legacy, next]) {
    if (norm(path.resolve(candidate)) === norm(path.resolve(root))) continue;
    try { if (norm(fs.realpathSync(candidate)) === rootReal) out.push(candidate); } catch { /* 不存在 */ }
  }
  if (_dataRootMemo && _dataRootMemo.root === root) _dataRootMemo.aliases = out;
  return out;
}
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || n === process.pid) return false;
  try { process.kill(n, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); }
}
// 一次性迁移:~/.win-claude-workbench → ~/.ruyi-workbench,原处留目录符号链接
// 指回新目录 —— 用户全局 Claude 配置里登记的 MCP 路径、计划任务、快捷方式里写死的旧路径照样能用。
// 只在:直接运行、缺省命令 serve、没有任何数据根环境变量、新目录不存在、旧目录是真目录、旧目录里没有别的活实例
// (runtime.json 的 pid 还活着就不动)时做。搬不动(被占用、跨卷、权限)就原样继续用旧目录,下次启动再试。
function migrateLegacyDataRoot() {
  if (process.env.RUYI_HOME || process.env.WIN_CLAUDE_WORKBENCH_HOME) return { moved: false, reason: 'env' };
  const { next, legacy } = defaultDataRoots();
  if (lstatOrNull(next)) return { moved: false, reason: 'next-exists' };
  const old = lstatOrNull(legacy);
  if (old && old.isSymbolicLink()) return { moved: false, reason: 'legacy-is-link' }; // 用户自己建的链接:不搬,dataRoot() 照旧用它
  if (!old || !old.isDirectory()) return { moved: false, reason: 'no-legacy' };
  try {
    const rt = JSON.parse(fs.readFileSync(path.join(legacy, 'runtime.json'), 'utf8'));
    if (rt && pidAlive(rt.pid)) return { moved: false, reason: 'legacy-in-use', pid: rt.pid };
  } catch { /* 没有 runtime.json 或读不了:没有活实例的证据,照常迁移 */ }
  try { fs.renameSync(legacy, next); } catch (e) { return { moved: false, reason: 'rename-failed', error: String(e && e.code || e) }; }
  _dataRootMemo = null; // 数据根从旧目录换成了新目录
  let junction = true;
  try { fs.symlinkSync(next, legacy, 'dir'); } catch { junction = false; }
  return { moved: true, from: legacy, to: next, junction };
}
// 缺省命令就是 serve(`Ruyi.exe`、`server.js`、`server.js serve --port N`、`server.js --port N`);mcp / install / doctor /
// mcp-config 这些子命令不迁移(MCP 子进程本来就由父进程经 RUYI_HOME 指到数据根)。
function isDirectServeInvocation() {
  if (require.main !== module) return false;
  return !process.argv.slice(2).some(a => ['mcp', 'install', 'doctor', 'mcp-config'].includes(String(a)));
}

function externalRoot() {
  return appRoot();
}

// A Full offline release ships one verified CPython beside ACC. ACC already starts that interpreter
// by absolute path, but ordinary task commands (`python ...`) inherit the server PATH. Without this
// bridge a clean intranet machine either reports Python missing or falls through to an unrelated
// system Python that cannot import openpyxl/winsdk. Expose the bundled interpreter process-wide so
// native provider tools, Claude CLI children, PowerShell tasks, and direct Ruyi.exe launches agree.
function exposeBundledPythonRuntime() {
  if (process.platform !== 'darwin') return '';
  const pythonDir = path.join(externalRoot(), 'mcp', 'ai-computer-control', 'runtime', 'python', 'bin');
  const pythonExe = path.join(pythonDir, 'python3');
  try { if (!fs.existsSync(pythonExe)) return ''; } catch { return ''; }
  const currentPath = String(process.env.PATH || process.env.Path || '');
  const pathDirs = currentPath.split(path.delimiter).filter(Boolean);
  const normalized = dir => path.resolve(dir);
  if (!pathDirs.some(dir => normalized(dir) === normalized(pythonDir))) {
    process.env.PATH = [pythonDir, ...pathDirs].join(path.delimiter);
  }
  process.env.PYTHON = pythonExe;
  process.env.PYTHONUTF8 = '1';
  // Keep the signed release runtime immutable when user scripts import source-only packages.
  process.env.PYTHONDONTWRITEBYTECODE = '1';
  if (process.platform === 'darwin') process.env.PYTHONNOUSERSITE = '1';
  process.env.RUYI_BUNDLED_PYTHON = pythonExe;
  return pythonExe;
}

// Finder/GUI launches have a minimal PATH. Add fixed runtime locations before vendor/probe snapshots.
Object.assign(process.env, platformRuntimeEnvironment(process.env));
const BUNDLED_PYTHON_RUNTIME = exposeBundledPythonRuntime();

// 随包 ripgrep(app/vendor-bin/rg.exe)对模型开的每一个子进程都可见 —— 与上面随包 Python 同一个模具:
// 进程级 PATH 前置一次,Claude/Kimi CLI、原生 shell_start/shell_run/script_run、Kimi ACP 终端、
// 子代理与 MCP stdio 子进程全部继承,不必在十几个 spawn 点各拼一遍 env。修前只有 file_search 快路径
// 认得它,模型在终端里敲 rg 是 command not found。
// 更糟的是修前 probeRg 找的是 appRoot()/vendor-bin —— appRoot() 是 server.js 的【上一级】(产品根),
// 而 rg.exe 随仓/随包/随 overlay 都在 app/vendor-bin(与 staticBase() 的 app/public 同一个 app 目录),
// 于是随包那份从来没被认出来过,体检上的「有 ripgrep」全靠用户自己 PATH 上碰巧有的 rg。
// 只认这一个锚定目录 <外部根>/app/vendor-bin(源码运行时外部根就是 appRoot());它必须是真目录、
// 不是符号链接/目录联接(同 05c 对 vendor-bin 的信任锚定口径)—— 工作区可控的路径绝不进 PATH。
// 不碰 USE_BUILTIN_RIPGREP:Claude Code 默认用它自带的 rg,这里只是让 Bash 里的裸 rg 找得到。
// RUYI_PATH_BEFORE_VENDOR 留住前置之前的 PATH,probeRg 靠它区分「系统装的 rg」与「随包的 rg」。
function ruyiVendorBinDir() {
  const dir = path.join(externalRoot(), 'app', 'vendor-bin');
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() ? dir : '';
  } catch { return ''; }
}
function samePathEntry(a, b) {
  const norm = p => { const r = path.resolve(String(p || '').trim().replace(/^"|"$/g, '')); return r; };
  try { return norm(a) === norm(b); } catch { return false; }
}
const RUYI_PATH_BEFORE_VENDOR = String(process.env.PATH || process.env.Path || '');
function exposeVendorBinOnPath() {
  const dir = ruyiVendorBinDir();
  if (!dir) return '';
  const rest = RUYI_PATH_BEFORE_VENDOR.split(path.delimiter).filter(entry => entry && !samePathEntry(entry, dir));
  process.env.PATH = [dir, ...rest].join(path.delimiter);
  return dir;
}
const RUYI_VENDOR_BIN_ON_PATH = exposeVendorBinOnPath();

const paths = {
  data: dataRoot(),
  config: path.join(dataRoot(), 'config.json'),
  sessions: path.join(dataRoot(), 'sessions'),
  uploads: path.join(dataRoot(), 'uploads'),
  logs: path.join(dataRoot(), 'logs'),
  generated: path.join(dataRoot(), 'generated'),
  checkpoints: path.join(dataRoot(), 'checkpoints'), // v0.8-S4a: file-checkpoint journal (per-session)
  playbooks: path.join(dataRoot(), 'playbooks'), // v0.9-S2: user-authored playbooks (built-ins ship in resources/)
  skills: path.join(dataRoot(), 'skills'), // v1 技能体系: 用户级技能 skills/<id>/SKILL.md(内置技能仍在 resources/,项目技能在 <cwd>/.ruyi/skills)
  webcache: path.join(dataRoot(), 'webcache'), // v0.9-S9: web_fetch main-text cache (<sha256(url)>.json), offline-reusable
  agentRuns: path.join(dataRoot(), 'agent-runs'), // persistent DAG workflow state, grouped by session
  agentWorkflows: path.join(dataRoot(), 'agent-workflows'), // personal reusable DAG templates
  agentWorktrees: path.join(dataRoot(), 'agent-worktrees'), // optional isolated write-agent worktrees (outside the repo)
  usage: path.join(dataRoot(), 'usage'),
  memory: path.join(dataRoot(), 'memory'), // v2 跨会话记忆(团队模式 v2 Phase3): global/ 与 project/<projectKey>/ // v1.4-OSS 用量看板: append-only monthly cost ledgers usage/YYYY-MM.jsonl
};

// v1 技能体系: 技能/目录名的安全字符集(供落盘 skills/<id>/、防路径穿越)。复用同 playbook id 的形状。
const SKILL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const { MAX_BODY_BYTES, normalizeApiErrorPayload, json, apiFailure, apiSessionIdInvalid, apiSessionNotFound, text, readBody, readJsonBody, send, contentTypeFor } = require('./backend/http-protocol.cjs');

const { runKeyedChain } = require('./backend/keyed-chain.cjs');
const { markSessionDeleted, sessionSaveIsTombstoned, sessionAssociatedSaveIsTombstoned, clearDeletedSession } = require('./backend/session-tombstones.cjs').createSessionTombstones();
const { truncateToolResult, createToolResultDisplay } = require('./backend/tool-result-view.cjs');
const boundToolResultForDisplay = createToolResultDisplay({ paths });
const { buildAttachmentPrompt, buildDeliveryRevisionPrompt } = require('./backend/attachment-prompt.cjs');
const { lastAssistantEngine, historyStartsWithCompactionSummary, compactionSummaryPairEnd, appendPromptToLastUserMessage } =
  require('./backend/provider-history.cjs');
const { readFilePreview } = require('./backend/file-preview.cjs');
const { normalizeStoragePolicy } = require('./backend/storage-policy.cjs');
const { NATIVE_COMMAND_TOOL_NAMES, NATIVE_DESKTOP_TOOL_NAMES, DESKTOP_MCP_SERVER_ID, ACC_POLICY_TOOL_FAMILIES, nativeToolDisabledByPolicy, bridgedToolDisabledByPolicy, toolDisabledByPolicy, accPolicyHiddenToolNames, TOOL_PACK_DESCRIPTIONS } = require('./backend/tool-access-policy.cjs');
const { _expandMcpVar, _tomlKeyPath, _parseTomlMcpServers, parseMcpConfigFile, scanMcpSources } = require('./backend/mcp-config-import.cjs');
const { ssrfCheck } = require('./backend/network-policy.cjs');
const { httpGetGuarded } = require('./backend/http-transport.cjs');
const { normalizeCwd, macPathAnchor, sameFileIdentity, pathWithinRoot, pathWithinAnyRoot } = require('./backend/path-containment.cjs');
const { BRIDGED_WRITE_PATH_ARGS, collectBridgedWriteTargets, collectBridgedWriteTarget, bridgedWriteRelativePathArg } = require('./backend/bridged-write-targets.cjs');
const { TOOL_REQUIRES, runtimeToolRequirementsMet, toolRequirementsMet } = require('./backend/tool-capability-policy.cjs');
const { redact } = require('./backend/secret-redaction.cjs');
const {
  KEY_MASK_PREFIX, maskKey, safeUrlForDisplay,
  configSecretValueOrCleared, configUrlOrCleared,
  maskSecrets, unmaskSecrets, maskProviders, unmaskProviders,
  maskedSecretConflicts, maskedSecretConflictMessage, providerLaunchVectorKey,
  collectDisplayUrlRestores, maskExternalMcpServerForDisplay,
  mcpArgsForDisplay, restoreExternalMcpServerSecrets, sanitizeExternalMcpServer,
} = require('./backend/config-secrets.cjs');
const {
  CONTEXT_WINDOW_FALLBACK, CONTEXT_OVERFLOW_PATTERNS,
  extractContextLength, cacheContextLength, cachedContextLength,
  contextWindowFromTable, resolveContextWindow, isContextOverflowError,
} = require('./backend/provider-context-policy.cjs').createProviderContextPolicy();
const {
  fmtTokensServer, setEstimateBucketsV1,
  classifyTextForEstimate, estimateContentTokens, estimateHistoryTokens, estimateTextTokens,
  estimateToolSchemaTokens,
} = require('./backend/token-estimation.cjs').createTokenEstimation();

const { adaptiveMetaToolSchemas, MCP_TOOLS, PROVIDER_SESSION_TOOL_SCHEMAS } = require('./backend/native-tool-schemas.cjs');

// 分离式外部启动(打开文件/网址/编辑器/资源管理器)的共用入口。病根:cp.spawn 找不到程序、没权限、被策略拦
// (ENOENT / EACCES / EPERM)时【不】同步抛出,而是稍后在 ChildProcess 上发 'error' 事件;裸写
// spawn(...).unref() 没有监听者,这个事件就成了 uncaughtException,startServerInner 的兜底会 process.exit(1)
// —— 一次「打开」失败(注册表里残留的默认浏览器路径、卸掉的编辑器、被 AppLocker 拦的 explorer.exe)带走整个
// 工作台:在飞回合、MCP 子进程、待决权限全丢,而工具先前已经回了「opened」。
// 这里先挂 'error' 监听再 unref,并以 promise 交回启动结果:'spawn' 事件 → { ok:true },'error' → { ok:false, error }。
// 同步抛出(参数非法)照旧同步抛给调用方,与原来 try { spawn().unref() } catch 的语义一致;成功路径的参数、
// detached/stdio 全由调用方原样传入,行为不变。不关心结果的调用方可以不 await(错误已被吸收)。
function spawnDetachedChecked(command, args, options) {
  const child = cp.spawn(command, args || [], options);
  // LaunchServices owns the destination application's lifetime. Wait only for the
  // Mac launcher to confirm its handoff, and bound that launcher's own lifetime.
  if (process.platform === 'darwin' && command === '/usr/bin/open') {
    const completed = new Promise(resolve => {
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(result);
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* report the unconfirmed handoff */ }
        finish({ ok: false, code: 'open_timeout', error: 'macOS opener timed out', pid: child.pid });
      }, 5000);
      child.on('error', error => finish({ ok: false, error: error.message, code: error.code || null }));
      child.once('exit', (code, signal) => finish(code === 0 && !signal
        ? { ok: true, pid: child.pid }
        : { ok: false, code: 'open_failed', error: `macOS opener exited with ${signal || code}`, exitCode: code, signal, pid: child.pid }));
    });
    child.unref();
    return completed;
  }
  const started = new Promise(resolve => {
    child.on('error', error => resolve({ ok: false, error: (error && error.message) || String(error), code: (error && error.code) || null }));
    child.once('spawn', () => resolve({ ok: true, pid: child.pid }));
  });
  child.unref();
  return started;
}

// 路径段解码:decodeURIComponent 遇到坏的百分号编码(如 `%zz`)会抛 URIError,落到顶层就是 500 + http_unhandled。
// 路由拿到 null 按「这个 id 不存在/不合法」回 4xx(先例:/api/missions/:id/interventions/:iv/decision)。
function safeDecodeURIComponent(segment) {
  try { return decodeURIComponent(String(segment == null ? '' : segment)); } catch { return null; }
}

// 开头的 UTF-8 BOM(U+FEFF)先剥掉再解析:Windows 记事本/PowerShell 5.1 另存的 JSON 常带 BOM,JSON.parse 对它抛 SyntaxError,
// 修前 config.json、各类用户手改的清单被当成「损坏」(config 还会因此回滚到 .prev 覆盖用户的编辑)。只处理字符串入参。
// Expected SDK-decoded JSON value fingerprint shared with ACC execution_arguments.py.
// Integer JSON.stringify tokens retain every decimal digit; decimal/exponent tokens use binary64.
// The caller must pass its immutable JSON snapshot, not a mutable pre-serialization object.
// This binds decoded values, not original wire spelling, and never authorizes an action.
function executionArgumentsDigest(value) {
  const digest = crypto.createHash('sha256');
  const ancestors = new Set();
  let nodes = 0, bytes = 0;
  const put = data => {
    bytes += typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
    if (bytes > 64 * 1024 * 1024) throw new Error('execution argument fingerprint exceeds capacity');
    digest.update(data);
  };
  const utf8 = value => {
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('execution arguments contain invalid Unicode');
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('execution arguments contain invalid Unicode');
    }
    return Buffer.from(value, 'utf8');
  };
  const visit = (item, depth) => {
    nodes += 1;
    if (nodes > 1000000 || depth > 128) throw new Error('execution argument fingerprint exceeds capacity');
    if (item === null) { put('n;'); return; }
    if (typeof item === 'boolean') { put(item ? 't;' : 'f;'); return; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('execution arguments require finite numbers');
      const token = JSON.stringify(item);
      if (/^-?\d+$/.test(token)) { put('i' + token + ';'); return; }
      const number = Buffer.allocUnsafe(8); number.writeDoubleBE(item === 0 ? 0 : item);
      put('d'); put(number); put(';'); return;
    }
    if (typeof item === 'string') { const text = utf8(item); put('s' + text.length + ':'); put(text); put(';'); return; }
    if (!item || typeof item !== 'object' || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null))
      throw new Error('execution arguments require JSON values');
    if (ancestors.has(item)) throw new Error('execution arguments cannot be cyclic');
    ancestors.add(item);
    if (Array.isArray(item)) {
      put('a' + item.length + ':');
      for (let index = 0; index < item.length; index += 1) visit(item[index], depth + 1);
    } else {
      const keys = Object.keys(item).map(key => ({ key, bytes: utf8(key) })).sort((a, b) => Buffer.compare(a.bytes, b.bytes));
      put('o' + keys.length + ':');
      for (const { key } of keys) { visit(key, depth + 1); visit(item[key], depth + 1); }
    }
    ancestors.delete(item); put(';');
  };
  put(Buffer.from('ruyi-sdk-json-v1\0', 'utf8'));
  visit(value, 0);
  return digest.digest('hex');
}

// Copy only ordinary JSON data properties; no getters, toJSON or inherited serialization hooks.
// Null prototypes make a prepared value stable across asynchronous serialization boundaries.
const { copyOrdinaryJsonData, safeJsonParse } = require('./backend/ordinary-json.cjs');

const { decodeConsoleText, createConsoleLineDecoder, decodeTextFileBytes, createNdjsonLineFeeder, createCappedDiagnosticText } = require('./backend/text-codecs.cjs');

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

const { neutralizeFenceTag } = require('./backend/prompt-budget.cjs');

// P2-9(30号文§3 总表 + §8.9②): 工具分级排序表 —— 现有 07-autonomy.js/08-agent-runs.js(×3)/
// 09b-replan-ledger.js(×2)六处独立声明字面量 `{read:0,edit:1,exec:2}`,判据一致(数值越大权限越宽)全靠
// 人工复制维持。这是【权限升级判据】—— 08/09b 拿它判"子代理这次调用的工具是否超出授权层级"、"replan
// 补丁是否试图把节点 tier 抬高",分叉的后果是越权。117q-B5 曾把它落在 07-autonomy.js,但 09b 此前从未
// 消费 07 的任何符号,那次收编因此新增了一条循环边 09b-replan-ledger.js->07-autonomy.js,被迫登记进
// module-dependency-policy.json 的白名单(117q-B7 已撤回该条目 —— 移完后 09b 不再引用 07 的任何符号,
// 那条边真的不存在了)。落回本文件(00-boot.js)则 07/08/09b 三个消费者全部已经依赖 00-boot,新增边数
// 为零——它本就只是一张纯查表常量,没有任何 autonomy 语义。冻结防意外改写。
const TOOL_TIER_RANK = Object.freeze({ read: 0, edit: 1, exec: 2 });

// P2-16(30号文§3 总表): argsHash 指纹算法两份字面相同 —— 06f-autonomy-grants.js::consumeGrant(用量事件,
// 收对象 args)与 09b-replan-ledger.js::recordNodeContinuation(节点续点 pending 步骤,收预先算好的
// argsStr 字符串)各自手写一遍 sha1+hex 截 12 位。收拢两处 best-effort 语义:入参已经是字符串就直接用,
// 否则 JSON.stringify(args || {});任何异常兜底返回空串(与两处原有 try/catch 兜底行为一致,不让指纹计算
// 炸调用方主流程)。纯函数,只吃入参、无 IO。
function hashArgs(args) {
  try {
    const str = typeof args === 'string' ? args : JSON.stringify(args || {});
    return crypto.createHash('sha1').update(str).digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

const { AUTOEXEC_DENYLIST } = require('./backend/autoexec-paths.cjs');
const { NATIVE_TOOL_TIER, nativeToolTier } = require('./backend/native-tool-tiers.cjs');
const { cliBridgeToolTier } = require('./backend/cli-tool-tiers.cjs');
const {
  ensureDataRootReal, sensitiveDataRoots, isSensitiveDataPath, sensitiveFileIdentities,
  isSensitiveHardlinkStat, isSensitiveHardlinkAlias, sensitiveGlobsForRg,
} = require('./backend/sensitive-paths.cjs').createSensitivePaths({ dataRoot, dataRootAliases });
const logEvent = require('./backend/audit-log.cjs').createAuditLog({ paths, nowIso });

async function ensureDirs() {
  await Promise.all([
    fsp.mkdir(paths.data, { recursive: true }),
    fsp.mkdir(paths.sessions, { recursive: true }),
    fsp.mkdir(paths.uploads, { recursive: true }),
    fsp.mkdir(paths.logs, { recursive: true }),
    fsp.mkdir(paths.generated, { recursive: true }),
    fsp.mkdir(paths.checkpoints, { recursive: true }),
    fsp.mkdir(paths.playbooks, { recursive: true }), // v0.9-S2
    fsp.mkdir(paths.skills, { recursive: true }), // v1 技能体系: 用户级技能目录
    fsp.mkdir(paths.webcache, { recursive: true }), // v0.9-S9
    fsp.mkdir(paths.agentRuns, { recursive: true }),
    fsp.mkdir(paths.agentWorkflows, { recursive: true }),
    fsp.mkdir(paths.agentWorktrees, { recursive: true }),
    fsp.mkdir(paths.usage, { recursive: true }), // v1.4-OSS 用量看板: append-only monthly ledgers
    fsp.mkdir(paths.memory, { recursive: true }), // v2 跨会话记忆: 记忆库根(global/ 与 project/<projectKey>/ 按需建)
  ]);
}

const { CLAUDE_ENDPOINT_PRESETS, claudeCostFields, normalizePricing, cachedInputTokensFromUsage, computeProviderCost } = require('./backend/provider-pricing.cjs');

// 61-A3:给模型看的本地时间(provider 引擎每条 user 消息落历史时带一行,文案在 06b turnTime)。分钟粒度;
// weekday 0 = 周日;offset 形如 UTC+08:00(日志 ts 是 UTC,模型要换算时靠它)。
function localTurnTimeParts(ms) {
  const d = new Date(ms);
  const p2 = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return {
    stamp: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`,
    weekday: d.getDay(),
    offset: `UTC${off >= 0 ? '+' : '-'}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`,
  };
}
// ────────────────────────────────────────────────────────────────────────────
// 第 121 波 K2a(34 号文 §6.1;27 号文 `:20` 预告的那一步):进程内事件总线。
//
// 为什么住在 00-boot:它的订阅者(13r-event-stream.js)排在最后,而生产者散落在 02/04/05/09/13i/13q
// —— 总线必须比【所有】生产者都早,生产者才只需要一条后向引用。00-boot 是全仓第一个模块,且每一个
// 生产者所在模块对它的依赖边【本来就存在】(见 docs/architecture/module-dependency-graph.json),
// 所以这一步一条新边都不加,forwardEdges 不动。
//
// 三条纪律:
//   ① 零订阅者时 emit 是 no-op,且【永不抛】—— 观察面绝不反噬写路径(同 logEvent 的口径);
//   ② 订阅者自己抛的异常就地吞掉并继续派给下一个,一个坏订阅者不许拖垮生产者;
//   ③ 总线【不落盘、不持久化、不跨进程】。它只是「谁写了什么」到「谁想知道」之间的一条线,
//      重启即空;任何需要重启后还在的事实都必须另有落盘的权威源(会话头/NDJSON)。
const RUYI_EVENT_SUBSCRIBERS = new Set();
const RUYI_EVENTS = {
  // 返回退订函数(约定同 DOM/Node 的 off 语义:重复退订无副作用)。
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    RUYI_EVENT_SUBSCRIBERS.add(fn);
    return () => { RUYI_EVENT_SUBSCRIBERS.delete(fn); };
  },
  emit(name, payload) {
    if (!RUYI_EVENT_SUBSCRIBERS.size) return;           // 纪律①:零订阅者 = 零开销
    for (const fn of RUYI_EVENT_SUBSCRIBERS) {
      try { fn(String(name || ''), payload); } catch { /* 纪律②:订阅者的错不许回流到写路径 */ }
    }
  },
  subscriberCount() { return RUYI_EVENT_SUBSCRIBERS.size; },
};
// 事件流模块(13r-event-stream.js)的延迟绑定命名空间 —— 先例是 06i 的 StewardHooks 与 06c 的
// AgentLoopHooks。13-http-router.js 排在 13r 【之前】,直接写 handleEventStreamRoutes 会是一条
// 新前向边;它只写 `EventStreamHooks.handleApiRoutes`(13 → 00-boot 是既有后向边),13r 加载时
// Object.assign 填充实现。未填充(理论上不可能)时那一行是无操作。
const EventStreamHooks = {};

// 子代理的记忆核心胶囊(走查 #15)的延迟绑定口。08-agent-runs 要在子代理系统提示里放用户的核心偏好,但直接引 06d 的
// resolveMemoryPreflight / buildMemoryConflictMap 会给 08 添一条【环内】新边(06d 已在那个强连通分量里,依赖图的环债上限不许涨)。
// 所以 08 只读 `SubAgentMemoryHooks.coreSnapshot`(08 → 00-boot 是既有后向边),由 09-workflow 加载时 Object.assign 填实现
// (09 本来就依赖 06d)。未填充时调用方当「没有胶囊」处理,子任务照跑。契约:coreSnapshot({ parentSession, workingDir, task, config })
// → Promise<{ entries: 已激活核心条目[], conflicts: Map|null }>,绝不抛(调用方也 try 包着)。
const SubAgentMemoryHooks = {};

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

// 路径比较键:resolve + 去尾分隔符;Windows 下大小写不敏感。
function samePathKey(p) {
  let s = path.resolve(String(p || ''));

  return s.length > 3 ? s.replace(/\/+$/, '') : s;
}

// 如意包根标记:<root>/app/server.js 是文件,且 <root>/package.json 的 name 是 ruyi-workbench 或
// <root>/Start-Workbench.cmd 在。两条都要:只有 app/server.js 的目录可能是别的 Node 项目。
// 返回 { root, version } 或 null。只读、从不抛。
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
