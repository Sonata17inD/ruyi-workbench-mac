'use strict';
const { runKeyedChain } = require('./keyed-chain.cjs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
// Checkpoint snapshots, accounting, rollback and notices have one service owner.
function createCheckpointJournal({ paths, assertSessionIdForPath, atomicWriteJson, gitReadOnlyGuard, guardFileToolPath, logEvent, nowIso, pathWithinRoot, realpathForContainment, runGit, safeJsonParse, sessionPath, getRollbackContext, isSessionActive }) {
const JOURNAL_MAX_BEFORE_BYTES = 5 * 1024 * 1024;   // >5MB before-content → skipped:true, content not stored
const JOURNAL_KEEP_TURNS = 20;                       // per-session GC: keep the most recent 20 turnSeqs
const JOURNAL_GLOBAL_MAX_BYTES = (() => {
  const n = Number(process.env.RUYI_JOURNAL_GLOBAL_MAX_BYTES); // env override for e2e; default 200MB
  return Number.isFinite(n) && n > 0 ? n : 200 * 1024 * 1024;
})();  // global cap: purge oldest sessions (dir mtime) over this
// PF1: the global size cap used to run a full dirSize() sweep of EVERY session's checkpoint tree on every
// checkpoint-triggering file write (O(all checkpoint files), awaited before the tool returns) - so a single
// tool call's latency grew with the app's TOTAL checkpoint history (a 50-edit workflow = 50 full sweeps).
// We now keep a process-local APPROXIMATE running total of checkpoint bytes and use it only to decide whether
// the authoritative full sweep is worth running. SAFETY: the cache NEVER authorizes a purge - purges always
// run off a fresh full sweep that also recalibrates the cache. The cache can only SKIP the sweep when
// confidently under budget, so a stale or under-counting cache costs at most one extra sweep, never a missed
// cleanup. Recalibrated on cold start, every JOURNAL_GC_RECALIBRATE_EVERY calls, and when the estimate nears
// the cap. Process-local by design: the serve process and the one-shot MCP child each calibrate via their own
// authoritative sweeps (which see ALL sessions on disk regardless of writer), so correctness needs no sharing.
let journalGlobalBytes = null;            // cached approx total bytes of paths.checkpoints (null = uncalibrated)
let journalGcSinceScan = 0;               // journalGc calls since the last authoritative full sweep
const JOURNAL_GC_RECALIBRATE_EVERY = 64;  // force a real sweep at least this often (bounds cache drift)
const JOURNAL_GC_SCAN_HYSTERESIS = 0.9;   // sweep once the estimate reaches this fraction of the hard cap
// Probe (exported) so the PF1 e2e can assert the sweep does NOT run on every call yet still purges over-cap.
const journalGcProbe = { fullScans: 0, calls: 0 };
// PF1 fix: ALL running-total mutations funnel through journalBytesAdjust so byte accounting lives in one place
// and a full sweep can't silently clobber concurrent writers. A sweep measures disk truth across several awaits
// (readdir/stat/dirSize per session); other sessions' writers may `+=` during that window. Recording those
// deltas here lets the sweep replay them onto its recalibrated total instead of overwriting them (an overwrite
// would re-introduce a small under-count -> a possibly-missed sweep). SAFETY: this cache NEVER authorizes a
// purge (purges run off fresh dirSize), so any drift costs at most an extra sweep, never a missed cleanup.
let journalSweeping = 0;                   // in-flight authoritative sweeps (measurement windows currently open)
let journalDeltaDuringSweep = 0;           // net bytes changed by writers while any sweep is measuring
function journalBytesAdjust(delta) {
  if (!delta) return;
  if (journalGlobalBytes != null) journalGlobalBytes = Math.max(0, journalGlobalBytes + delta);
  if (journalSweeping > 0) journalDeltaDuringSweep += delta; // replayed after the sweep recalibrates from truth
}
// Parallel sub-agents may checkpoint different files in the same parent turn. Serialize each session's
// read-modify-write index transaction so entrySeq stays unique and a later write cannot overwrite an
// earlier agent's index entry. Different sessions retain full concurrency.
const journalWriteChains = new Map(); // sessionId -> Promise

async function withJournalWriteLock(sessionId, work) {
  return runKeyedChain(journalWriteChains, String(sessionId || ''), work);
}

function journalDir(sessionId) { return path.join(paths.checkpoints, assertSessionIdForPath(sessionId)); }
function journalIndexPath(sessionId) { return path.join(journalDir(sessionId), 'index.json'); }

// Read a session's checkpoint index (array of entries). Missing/corrupt → []. Never throws.
async function journalReadIndex(sessionId) {
  try {
    const raw = await fsp.readFile(journalIndexPath(sessionId), 'utf8');
    const arr = safeJsonParse(raw, null);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// hunt2 #18:写者(record / drop / GC)用的严格读。宽松版把【任何】读错误都当成「没有条目」,下一次 record
// 就用 [新条目] 整份盖掉索引 —— Windows 上杀毒/索引器与双进程(serve + MCP 子进程)撞出的一次 EBUSY/EPERM
// 就把这条会话全部检查点抹掉(entrySeq 还从 0 重来,覆写既有 .gz)。这里只有 ENOENT 才算空;别的读错误照抛,
// 由调用方的安全网 catch 转成 journal_write_error(本次不记,既有条目不动)。内容坏了(非 JSON / 非数组)
// 读重试也好不了,原样改名隔离成 index.json.corrupt-<时间戳> 留作取证,再按空索引继续,检查点功能自愈。
async function journalReadIndexForWrite(sessionId) {
  const file = journalIndexPath(sessionId);
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
  const arr = safeJsonParse(raw, null);
  if (Array.isArray(arr)) return arr;
  await fsp.rename(file, `${file}.corrupt-${Date.now()}`);
  logEvent({ kind: 'journal_index_quarantined', sessionId: String(sessionId || '') });
  return [];
}

// Atomic index write. Never throws (caller wraps). 第25波 25.1: 收编进 atomicWriteJson。
// 对抗轮修: retries:0 —— 该文件是【跨进程多写者】(serve 进程 + MCP 子进程各持独立 journalWriteChains,
// 进程间无法串行),rename 重试会让旧载荷在 ~680ms 退避后覆写掉别进程刚落的新条目(丢检查点)。
// 保持旧的 fail-fast 语义:输给并发写者就立刻失败(调用方本就 best-effort 包裹),绝不迟到覆写。
// hunt2 #13:紧凑 JSON(不缩进)—— 索引每记一条就整份重写一次,缩进让体积与序列化时间都翻倍。
async function journalWriteIndex(sessionId, entries) {
  const dir = journalDir(sessionId);
  await fsp.mkdir(dir, { recursive: true });
  await atomicWriteJson(journalIndexPath(sessionId), JSON.stringify(entries), { retries: 0 });
}

// hunt2 #6:本回合下一个 entrySeq = 本回合现有最大值 + 1。修前取「本回合条目数」—— 中间的条目被
// journalDropEntries / 单条回滚删掉之后,条目数会等于某个仍在的 entrySeq,新条目撞号并覆写它的 .gz
// (并行子代理共用父回合的 turnSeq,实测回滚把 p3 还原成了 p4 的内容)。
function journalNextEntrySeq(index, turnSeq) {
  let max = -1;
  for (const e of index) {
    if (e && Number(e.turnSeq) === Number(turnSeq) && Number.isFinite(Number(e.entrySeq))) max = Math.max(max, Number(e.entrySeq));
  }
  return max + 1;
}

// Resolve the current turnSeq for a checkpoint entry.
//  - serve process (provider engine): the caller passes the closure's session.turnSeq (authoritative).
//  - MCP child (Claude engine): read the session file (READ-ONLY, no race) via WCW_SESSION_ID env and take
//    its turnSeq. Missing env / unreadable file → null → the caller skips journaling (tool still runs).
async function journalResolveTurnSeq(sessionId, explicitTurnSeq) {
  if (Number.isFinite(explicitTurnSeq)) return Number(explicitTurnSeq);
  if (!sessionId) return null;
  try {
    const raw = await fsp.readFile(sessionPath(sessionId), 'utf8');
    const parsed = safeJsonParse(raw, null);
    const t = parsed && Number(parsed.turnSeq);
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

// Record a `before` checkpoint for a file mutation, BEFORE the tool executes. Returns nothing meaningful;
// all failures are swallowed so the tool proceeds unimpeded. `beforeContent` is a Buffer|string for
// modify/delete, or null for create (nothing to save). op ∈ 'create'|'modify'|'delete'. entrySeq is the
// per-turn running count (derived from how many entries already exist for this turnSeq).
async function journalRecord(sessionId, turnSeq, tool, filePath, op, beforeContent) {
  return withJournalWriteLock(sessionId, () => journalRecordUnlocked(sessionId, turnSeq, tool, filePath, op, beforeContent));
}

async function journalRecordUnlocked(sessionId, turnSeq, tool, filePath, op, beforeContent) {
  const [result] = await journalRecordManyUnlocked(sessionId, turnSeq, [{ tool, filePath, op, beforeContent }]);
  return result;
}

// hunt2 #13:批量记账 —— 一批条目只读一次索引、写一次索引、跑一次 GC。逐条 journalRecord 每条都整份读改写
// 索引,批量调用方(archive_unzip 最多 2000 条、CLI 回合收尾的 turn_baseline 对账)随条目数平方增长:
// 实测 1000 条 ~5s、2000 条 ~22s,期间 JSON 读写同步占着事件循环。返回与 rows 一一对应的结果数组
// (每项同 journalRecord 的返回值,多一个 entrySeq)。任一步失败 = 整批都没记(索引一次写入,不存在半批)。
async function journalRecordMany(sessionId, turnSeq, rows) {
  return withJournalWriteLock(sessionId, () => journalRecordManyUnlocked(sessionId, turnSeq, rows));
}

async function journalRecordManyUnlocked(sessionId, turnSeq, rows) {
  const list = Array.isArray(rows) ? rows : [];
  // b2-P0: 不再静默 no-op —— 返回 { ok:false, reason } 让调用方(file_delete 等不可逆操作)能中止并披露。
  if (!sessionId || !Number.isFinite(turnSeq)) return list.map(() => ({ ok: false, reason: 'no_session_context' }));
  if (!list.length) return [];
  try {
    const dir = journalDir(sessionId);
    await fsp.mkdir(dir, { recursive: true });
    const index = await journalReadIndexForWrite(sessionId);
    let nextSeq = journalNextEntrySeq(index, turnSeq); // per-turn autoincrement (hunt2 #6: max+1)
    const results = [];
    for (const { tool, filePath, op, beforeContent } of list) {
      const entrySeq = nextSeq++;
      let bytes = 0, skipped = false;
      if (op !== 'create' && beforeContent != null) {
        // Workspace turn baselines may discover a pre-change file whose bytes they could not (oversized) or
        // must not (git read failed) load. Such a caller passes a non-Buffer `{ skippedBytes }` marker: always
        // recorded as the honest non-revertible entry, never as a fabricated snapshot (hunt2 #4: 修前只认
        // >5MB 的标记,小于上限的标记会被 String() 成 "[object Object]" 存进 .gz)。Ordinary tool callers
        // continue to pass Buffer|string exactly as before.
        const marker = !Buffer.isBuffer(beforeContent) && typeof beforeContent === 'object'
          && Number.isFinite(Number(beforeContent.skippedBytes));
        const buf = marker ? null : (Buffer.isBuffer(beforeContent) ? beforeContent : Buffer.from(String(beforeContent), 'utf8'));
        bytes = marker ? Number(beforeContent.skippedBytes) : buf.length;
        if (marker || bytes > JOURNAL_MAX_BEFORE_BYTES) {
          // Too large to snapshot — record the entry as skipped (rollback of this entry will fail loudly).
          skipped = true;
        } else {
          const gz = zlib.gzipSync(buf); // built-in zlib — zero npm
          await fsp.writeFile(path.join(dir, `${turnSeq}-${entrySeq}.gz`), gz);
          journalBytesAdjust(gz.length); // PF1: keep the size-cap cache current
        }
      }
      index.push({ turnSeq: Number(turnSeq), entrySeq, tool: String(tool || ''), path: String(filePath || ''), op, bytes, ...(skipped ? { skipped: true } : {}), ts: nowIso() });
      results.push(skipped ? { ok: true, skipped: true, entrySeq } : { ok: true, entrySeq });
    }
    await journalWriteIndex(sessionId, index);
    // v1.4.1 (audit #8):必须 await —— 此前 detached 触发,GC 的 index.json 读改写会与下一条 journalRecord 竞争,
    // 修剪写回时可覆盖刚追加的条目(lost-write → 该文件变更不可撤销)。await 让 GC 在下一条 record 前完成,
    // 消除并发。GC 内部全 try/catch 静默,不抛。hunt2 #13:把刚写下的索引交给 GC,省掉它再读一遍。
    await journalGc(sessionId, index).catch(() => {});
    return results;
  } catch {
    // Safety-net discipline: a failed journal write must NOT abort the tool. Swallow and continue — the
    // index entry simply isn't written, and the file operation runs as if the journal weren't there.
    return list.map(() => ({ ok: false, reason: 'journal_write_error' }));
  }
}

// Turn-level workspace baseline. Ruyi native file tools checkpoint before every mutation, but Claude CLI's
// own Edit/Write/Bash tools run in a separate process and do not pass through TOOL_DISPATCH. Capture the
// workspace before a turn and reconcile it before turn_summary so those edits receive the same exact
// before/current diff and rollback entry. Git workspaces avoid an O(repository bytes) snapshot: only paths
// already dirty at turn start are copied; clean tracked files are reconstructed from the captured HEAD blob.
// Non-Git folders fall back to a bounded source/text snapshot. This remains a safety net, never a turn gate.
const WORKSPACE_BASELINE_EXTS = new Set([
  'txt', 'log', 'md', 'markdown', 'rst', 'adoc', 'csv', 'tsv', 'json', 'jsonc', 'xml', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'editorconfig', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
  'py', 'pyi', 'rb', 'php', 'java', 'kt', 'kts', 'scala', 'groovy', 'go', 'rs', 'swift', 'dart', 'lua',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'cs', 'fs', 'fsx', 'vb', 'sql', 'graphql', 'gql',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte', 'astro', 'sh', 'bash', 'zsh', 'fish',
  'ps1', 'psm1', 'bat', 'cmd', 'gradle', 'properties', 'tex', 'proto', 'cmake', 'dockerfile',
]);
const WORKSPACE_BASELINE_NAMES = new Set(['dockerfile', 'makefile', 'gnumakefile', 'rakefile', 'gemfile', 'procfile']);
const WORKSPACE_BASELINE_SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target', '.next', '.nuxt',
  '.cache', '.turbo', 'coverage', '__pycache__', '.venv', 'venv', '.idea', '.vs', '.gradle',
]);
const WORKSPACE_BASELINE_MAX_FILES = 8000;
const WORKSPACE_BASELINE_MAX_MEMORY = 40 * 1024 * 1024;
// Turn startup must stay responsive even in very large monorepos. Git index scans and the non-Git tree
// fallback share this wall-clock budget; once it expires, reconciliation is deliberately restricted to
// paths whose "before" state was captured exactly (partial coverage is safer than false attribution).
const WORKSPACE_BASELINE_DEFAULT_BUDGET_MS = 2000;

function workspaceBaselineBudgetMs() {
  const configured = Number(process.env.RUYI_WORKSPACE_BASELINE_BUDGET_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(250, Math.min(15000, Math.floor(configured)))
    : WORKSPACE_BASELINE_DEFAULT_BUDGET_MS;
}

function workspaceBaselineRemainingMs(deadline, cap = 10000) {
  return Math.max(0, Math.min(cap, Math.ceil(Number(deadline) - Date.now())));
}

function workspaceBaselineBudgetOnly(root, budgetMs, startedAt) {
  return { kind: 'budget', root, truncated: true, truncatedReason: 'time_budget', capturedBytes: 0,
    budgetMs, elapsedMs: Math.max(0, Date.now() - startedAt), capturedAt: nowIso() };
}

function workspaceBaselinePathKey(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  return resolved;
}

function workspaceBaselineIsCodePath(filePath) {
  const base = path.basename(String(filePath || '')).toLowerCase();
  if (WORKSPACE_BASELINE_NAMES.has(base)) return true;
  const ext = path.extname(base).replace(/^\./, '');
  return WORKSPACE_BASELINE_EXTS.has(ext);
}

async function workspaceBaselineFileSnapshot(filePath, memoryState) {
  try {
    const st = await fsp.lstat(filePath);
    if (!st.isFile() || st.isSymbolicLink()) return { exists: false };
    const row = { exists: true, size: st.size, mtimeMs: st.mtimeMs };
    if (st.size > JOURNAL_MAX_BEFORE_BYTES || memoryState.bytes + st.size > WORKSPACE_BASELINE_MAX_MEMORY) {
      return { ...row, skippedBytes: st.size };
    }
    const content = await fsp.readFile(filePath);
    memoryState.bytes += content.length;
    return { ...row, content };
  } catch { return { exists: false }; }
}

function workspaceBaselineNulPaths(raw) {
  return String(raw || '').split('\0').filter(Boolean);
}

function workspaceBaselineGitAbs(repoRoot, relativePath, scopeRoot) {
  const abs = path.resolve(repoRoot, String(relativePath || '').replace(/\//g, path.sep));
  return pathWithinRoot(abs, scopeRoot) && workspaceBaselineIsCodePath(abs) ? abs : '';
}

async function workspaceBaselineGitNames(repoRoot, head, deadline = Date.now() + 20000) {
  const paths = [];
  let truncated = false;
  const collect = async args => {
    const remaining = workspaceBaselineRemainingMs(deadline);
    if (!remaining) { truncated = true; return; }
    const result = await runGit(args, repoRoot, remaining);
    if (!result.ok) { truncated = true; return; }
    paths.push(...workspaceBaselineNulPaths(result.stdout));
  };
  // 审计 B:回合开头自动跑的这条 diff 同样会触发仓库自带的 clean 过滤器与子模块递归(比 git_status 还隐蔽:
  // 不需要任何工具调用)—— 与 11 的只读 git 工具共用同一道护栏;护栏读不出配置就当扫描不完整(truncated)。
  const guard = await gitReadOnlyGuard(repoRoot, workspaceBaselineRemainingMs(deadline) || 1000);
  if (!guard.ok) return { paths: [], truncated: true };
  await collect([...guard.flags, '-C', repoRoot, 'diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--name-only', '-z', head, '--']);
  await collect(['-C', repoRoot, 'ls-files', '--others', '--exclude-standard', '-z', '--']);
  if (Date.now() >= deadline) truncated = true;
  return { paths: [...new Set(paths)], truncated };
}

async function captureGitWorkspaceBaseline(scopeRoot, deadline) {
  let remaining = workspaceBaselineRemainingMs(deadline, 5000);
  if (!remaining) return null;
  // Canonicalize the scope root once: CI runners may address the temp workspace via an 8.3 short name
  // (RUNNER~1) or a junction, while Git's rev-parse --show-toplevel always returns the long/real spelling.
  // Comparing those two spellings would silently downgrade the git fast path to a full tree scan.
  scopeRoot = await realpathForContainment(scopeRoot);
  const repoProbe = await runGit(['-C', scopeRoot, 'rev-parse', '--show-toplevel'], scopeRoot, remaining);
  if (!repoProbe.ok) return null;
  const repoRoot = path.resolve(String(repoProbe.stdout || '').trim());
  if (!repoRoot || !pathWithinRoot(scopeRoot, repoRoot)) return null;
  remaining = workspaceBaselineRemainingMs(deadline, 5000);
  if (!remaining) return null;
  const headProbe = await runGit(['-C', repoRoot, 'rev-parse', 'HEAD'], repoRoot, remaining);
  if (!headProbe.ok) return null; // unborn repository -> bounded tree fallback
  const head = String(headProbe.stdout || '').trim();
  if (!/^[a-f0-9]{40,64}$/i.test(head)) return null;
  const dirty = new Map();
  const memoryState = { bytes: 0 };
  const names = await workspaceBaselineGitNames(repoRoot, head, deadline);
  let truncated = names.truncated;
  for (const rel of names.paths) {
    if (Date.now() >= deadline) { truncated = true; break; }
    const abs = workspaceBaselineGitAbs(repoRoot, rel, scopeRoot);
    if (!abs) continue;
    dirty.set(workspaceBaselinePathKey(abs), { path: abs, rel: String(rel).replace(/\\/g, '/'), snapshot: await workspaceBaselineFileSnapshot(abs, memoryState) });
  }
  return { kind: 'git', root: scopeRoot, repoRoot, head, dirty, truncated,
    truncatedReason: truncated ? 'time_budget_or_git_scan' : '', capturedBytes: memoryState.bytes, capturedAt: nowIso() };
}

async function captureTreeWorkspaceBaseline(scopeRoot, deadline = Number.POSITIVE_INFINITY) {
  const files = new Map();
  const memoryState = { bytes: 0 };
  const queue = [scopeRoot];
  let visited = 0, truncated = false, truncatedReason = '';
  while (queue.length && visited < WORKSPACE_BASELINE_MAX_FILES) {
    if (Date.now() >= deadline) { truncated = true; truncatedReason = 'time_budget'; break; }
    const dir = queue.shift();
    const rows = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const row of rows) {
      if (Date.now() >= deadline) { truncated = true; truncatedReason = 'time_budget'; break; }
      if (visited >= WORKSPACE_BASELINE_MAX_FILES) { truncated = true; truncatedReason = 'file_limit'; break; }
      const filePath = path.join(dir, row.name);
      if (row.isSymbolicLink()) continue;
      if (row.isDirectory()) {
        if (!WORKSPACE_BASELINE_SKIP_DIRS.has(row.name.toLowerCase())) queue.push(filePath);
        continue;
      }
      if (!row.isFile() || !workspaceBaselineIsCodePath(filePath)) continue;
      visited += 1;
      files.set(workspaceBaselinePathKey(filePath), { path: filePath, snapshot: await workspaceBaselineFileSnapshot(filePath, memoryState) });
    }
  }
  if (queue.length && !truncated) { truncated = true; truncatedReason = 'file_limit'; }
  return { kind: 'tree', root: scopeRoot, files, truncated, truncatedReason,
    capturedBytes: memoryState.bytes, capturedAt: nowIso() };
}

async function captureWorkspaceTurnBaseline(cwd) {
  const startedAt = Date.now();
  const budgetMs = workspaceBaselineBudgetMs();
  const deadline = startedAt + budgetMs;
  try {
    const root = path.resolve(String(cwd || ''));
    const st = await fsp.stat(root);
    if (!st.isDirectory()) return null;
    if (Date.now() >= deadline) return workspaceBaselineBudgetOnly(root, budgetMs, startedAt);
    const gitBaseline = await captureGitWorkspaceBaseline(root, deadline);
    if (gitBaseline) return { ...gitBaseline, budgetMs, elapsedMs: Math.max(0, Date.now() - startedAt) };
    if (Date.now() >= deadline) return workspaceBaselineBudgetOnly(root, budgetMs, startedAt);
    // A session accidentally rooted at the drive or user-home level must not scan thousands of unrelated
    // personal files. Git repositories are handled above; the bounded tree fallback is for actual projects.
    const home = path.resolve(os.homedir());
    if (root === path.parse(root).root || workspaceBaselinePathKey(root) === workspaceBaselinePathKey(home)) return null;
    const treeBaseline = await captureTreeWorkspaceBaseline(root, deadline);
    return { ...treeBaseline, budgetMs, elapsedMs: Math.max(0, Date.now() - startedAt) };
  } catch { return null; }
}

async function workspaceBaselineGitBefore(baseline, absPath, after) {
  const key = workspaceBaselinePathKey(absPath);
  if (baseline.dirty.has(key)) return baseline.dirty.get(key).snapshot;
  const rel = path.relative(baseline.repoRoot, absPath).replace(/\\/g, '/');
  if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) return { exists: false };
  // hunt2 #4:修前 `git show HEAD:rel` 按 utf8 解码再 Buffer.from 回去(GBK 文件的每个汉字都成了 U+FFFD,回滚把
  // 乱码写回盘),且任何 git 失败(10s 超时、blob 超 24MB 输出上限)都被当成「回合前不存在」→ 记成 create,
  // 回滚时直接删掉用户改过的文件。现在:ls-tree 分清「HEAD 里没有」(真·新建)与「git 读失败」;失败给
  // 「存在但内容未知」的标记,journalRecord 记为 skipped(回滚时如实报失败,绝不删文件);blob 按原字节取。
  const unknown = { exists: true, skippedBytes: JOURNAL_MAX_BEFORE_BYTES + 1, unknownBefore: true };
  const listed = await runGit(['-C', baseline.repoRoot, '--literal-pathspecs', 'ls-tree', '-l', '-z', baseline.head, '--', rel], baseline.repoRoot, 10000);
  if (!listed.ok) return unknown;
  const row = String(listed.stdout || '').split('\0').find(Boolean);
  if (!row) return { exists: false }; // HEAD 里确实没有这个路径 → 回合内新建
  const m = /^(\d+) (\S+) ([0-9a-f]+)\s+(-|\d+)\t/i.exec(row);
  if (!m) return unknown;
  // 符号链接 / 子模块:快照器(lstat)一律视为「不存在」,两边同口径才不会凭空记出一条 delete。
  if (m[2] !== 'blob' || m[1] === '120000') return { exists: false };
  const blobSize = Number(m[4]);
  if (Number.isFinite(blobSize) && blobSize > JOURNAL_MAX_BEFORE_BYTES) return { exists: true, size: blobSize, skippedBytes: blobSize };
  // cat-file blob 取原字节、不跑任何过滤器。刻意不用 `cat-file --filters`:它会执行仓库 .git/config 里配置的
  // filter.*.smudge/process 外部程序 —— 与 GIT_SAFE_FLAGS 头注里 fsmonitor / diff.external 同一类「看一眼陌生仓库
  // 即执行它指定的程序」。换行转换改由 workspaceBaselineGitCheckoutCrlf 只按 git 内建的 eol 规则复现。
  const blob = await runGit(['-C', baseline.repoRoot, 'cat-file', 'blob', m[3]], baseline.repoRoot, 10000, { encoding: 'buffer' });
  if (!blob.ok || !Buffer.isBuffer(blob.stdout)) return unknown;
  let content = blob.stdout;
  const crlf = await workspaceBaselineGitCheckoutCrlf(baseline, rel, content);
  if (crlf === null) return unknown;
  // autocrlf=true 下 LF 的工作区文件同样算「干净」(自己写的 LF 文件提交后从没被 git 重新检出过)。回合后的文件
  // 仍是纯 LF(一个 CR 都没有)时,按它原本就是 LF 处理 —— 编辑工具保留原换行,这比 git 的检出规则更贴近回合前。
  const afterIsPureLf = after && Buffer.isBuffer(after.content) && after.content.includes(0x0a) && !after.content.includes(0x0d);
  if (crlf && !afterIsPureLf) content = workspaceBaselineLfToCrlf(content);
  return content.length > JOURNAL_MAX_BEFORE_BYTES
    ? { exists: true, size: content.length, skippedBytes: content.length }
    : { exists: true, size: content.length, content };
}

// hunt2 #4(续):HEAD 里存的是 LF,Git for Windows 默认 core.autocrlf=true,干净的工作区文件是 CRLF。直接把 blob
// 写回会把用户的 CRLF 文件整份改成 LF。这里只复现 git 检出时【内建】的换行转换(text/eol 属性、core.autocrlf、
// core.eol),不执行任何外部过滤器:返回 true = 检出时会转成 CRLF;false = 原样;null = git 查询失败(内容未知)。
async function workspaceBaselineGitCheckoutCrlf(baseline, rel, blob) {
  if (baseline.eolConfig === undefined) {
    const get = async key => {
      const r = await runGit(['-C', baseline.repoRoot, 'config', '--get', key], baseline.repoRoot, 5000);
      return r.ok ? String(r.stdout || '').trim().toLowerCase() : '';
    };
    baseline.eolConfig = { autocrlf: await get('core.autocrlf'), eol: await get('core.eol') };
  }
  const { autocrlf, eol: coreEol } = baseline.eolConfig;
  const attrs = await runGit(['-C', baseline.repoRoot, 'check-attr', '-z', 'text', 'eol', '--', rel], baseline.repoRoot, 5000);
  if (!attrs.ok) return null;
  const parts = String(attrs.stdout || '').split('\0');
  const attr = {};
  for (let i = 0; i + 2 < parts.length; i += 3) attr[parts[i + 1]] = parts[i + 2];
  const text = attr.text || 'unspecified';
  const eol = attr.eol || 'unspecified';
  if (text === 'unset') return false;                                  // -text:二进制,永不转换
  const explicitText = text === 'set' || eol === 'crlf' || eol === 'lf';
  const autoText = !explicitText && (text === 'auto' || autocrlf === 'true' || autocrlf === 'input');
  if (!explicitText && !autoText) return false;                        // 未声明为文本、也没开 autocrlf:原样
  // auto 判定:含 NUL 视为二进制;blob 里已有 CR 的不转换(git 的「安全」规则,避免 \r\r\n)。
  if (autoText && (blob.includes(0) || blob.includes(0x0d))) return false;
  if (eol === 'crlf') return true;
  if (eol === 'lf') return false;
  if (autocrlf === 'true') return true;
  if (autocrlf === 'input') return false;
  return coreEol === 'crlf';
}

function workspaceBaselineLfToCrlf(buf) {
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) { out.push(buf.subarray(start, i), Buffer.from([0x0d])); start = i; }
  }
  out.push(buf.subarray(start));
  return Buffer.concat(out);
}

function workspaceBaselineSnapshotsEqual(before, after) {
  if (!!(before && before.exists) !== !!(after && after.exists)) return false;
  if (!before || !before.exists) return true;
  if (Buffer.isBuffer(before.content) && Buffer.isBuffer(after.content)) return before.content.equals(after.content);
  return Number(before.size) === Number(after.size) && Number(before.mtimeMs) === Number(after.mtimeMs);
}

async function reconcileWorkspaceTurnBaseline(baseline, sessionId, turnSeq) {
  if (!baseline || !sessionId || !Number.isFinite(Number(turnSeq))) return { recorded: 0, skipped: true };
  try {
    if (baseline.kind === 'budget') {
      logEvent({ kind: 'turn_workspace_reconcile', sessionId, turnSeq: Number(turnSeq), baseline: baseline.kind,
        recorded: 0, truncated: true, truncatedReason: baseline.truncatedReason, budgetMs: baseline.budgetMs,
        elapsedMs: baseline.elapsedMs, capturedBytes: 0 });
      return { recorded: 0, skipped: false, truncated: true, truncatedReason: baseline.truncatedReason };
    }
    const existing = (await journalReadIndex(sessionId))
      .filter(e => e && Number(e.turnSeq) === Number(turnSeq) && e.path)
      .map(e => workspaceBaselinePathKey(e.path));
    const existingPaths = new Set(existing);
    const candidates = new Map();
    let reconcileTruncated = !!baseline.truncated;
    let truncatedReason = baseline.truncatedReason || '';
    if (baseline.kind === 'git') {
      for (const row of baseline.dirty.values()) candidates.set(workspaceBaselinePathKey(row.path), row.path);
      // A partial start scan cannot prove that an unseen path was clean before the turn. Only expand the
      // candidate set when coverage was complete; otherwise keep the exact dirty snapshots already captured.
      if (!baseline.truncated) {
        const names = await workspaceBaselineGitNames(baseline.repoRoot, baseline.head);
        if (names.truncated) { reconcileTruncated = true; truncatedReason = 'git_reconcile_scan'; }
        for (const rel of names.paths) {
          const abs = workspaceBaselineGitAbs(baseline.repoRoot, rel, baseline.root);
          if (abs) candidates.set(workspaceBaselinePathKey(abs), abs);
        }
      }
    } else {
      for (const row of baseline.files.values()) candidates.set(workspaceBaselinePathKey(row.path), row.path);
      const afterTree = await captureTreeWorkspaceBaseline(baseline.root);
      baseline.afterTree = afterTree;
      if (afterTree.truncated) { reconcileTruncated = true; truncatedReason = afterTree.truncatedReason || 'tree_reconcile_scan'; }
      // As above, paths absent from a truncated start baseline have an unknown "before" state. Do not label
      // them as creates. Captured paths remain safe to compare and retain useful partial coverage.
      if (!baseline.truncated) {
        for (const row of afterTree.files.values()) candidates.set(workspaceBaselinePathKey(row.path), row.path);
      }
    }
    let recorded = 0;
    // hunt2 #13:攒批记账(见 journalRecordMany 头注)。按条数/字节分批,免得一个大回合把所有 before 同时攥在内存里。
    let pending = [], pendingBytes = 0;
    const flush = async () => {
      if (!pending.length) return;
      const batch = pending;
      pending = []; pendingBytes = 0;
      const results = await journalRecordMany(sessionId, Number(turnSeq), batch);
      batch.forEach((row, i) => { if (results[i] && results[i].ok) { recorded += 1; existingPaths.add(row.key); } });
    };
    for (const [key, filePath] of candidates) {
      if (existingPaths.has(key) || !workspaceBaselineIsCodePath(filePath)) continue;
      const after = baseline.kind === 'tree' && baseline.afterTree.files.has(key)
        ? baseline.afterTree.files.get(key).snapshot
        : await workspaceBaselineFileSnapshot(filePath, { bytes: 0 });
      const before = baseline.kind === 'git'
        ? await workspaceBaselineGitBefore(baseline, filePath, after)
        : (baseline.files.get(key) || { snapshot: { exists: false } }).snapshot;
      if (workspaceBaselineSnapshotsEqual(before, after)) continue;
      const op = before.exists ? (after.exists ? 'modify' : 'delete') : 'create';
      const beforeContent = op === 'create' ? null
        : (Buffer.isBuffer(before.content) ? before.content : { skippedBytes: Number(before.skippedBytes || before.size || (JOURNAL_MAX_BEFORE_BYTES + 1)) });
      pending.push({ key, tool: 'turn_baseline', filePath, op, beforeContent });
      pendingBytes += Buffer.isBuffer(beforeContent) ? beforeContent.length : 0;
      if (pending.length >= 200 || pendingBytes >= 16 * 1024 * 1024) await flush();
    }
    await flush();
    if (recorded || reconcileTruncated) {
      logEvent({ kind: 'turn_workspace_reconcile', sessionId, turnSeq: Number(turnSeq), baseline: baseline.kind,
        recorded, truncated: reconcileTruncated, truncatedReason, budgetMs: Number(baseline.budgetMs) || undefined,
        elapsedMs: Number(baseline.elapsedMs) || undefined, capturedBytes: Number(baseline.capturedBytes) || 0 });
    }
    return { recorded, skipped: false, truncated: reconcileTruncated, truncatedReason };
  } catch { return { recorded: 0, skipped: true }; }
}

// b3-P2: Drop the journal entries recorded for (turnSeq, tool, path∈paths) — used to roll back
// PHANTOM checkpoints when a multi-step operation (file_move/file_copy) fails AFTER recording
// before-snapshots but BEFORE the actual mutation lands. Without this, a failed move would leave
// rollback entries describing an operation that never happened (a phantom journal), and a later
// rollback would act on files that were never touched. All failures are silent (rollback of the
// phantom is best-effort; the caller already reported the real operation failure to the model).
// entrySeqs(可选):只删这几个 entrySeq 的条目 —— 调用方知道自己刚记了哪几条时传入,同一回合早先涉及同一
// 路径、同一工具的条目(例如本回合先把 X 移到 A、再把 A 移走)不受牵连。空数组 = 一条也不删。
async function journalDropEntries(sessionId, turnSeq, tool, paths, entrySeqs) {
  return withJournalWriteLock(sessionId, () => journalDropEntriesUnlocked(sessionId, turnSeq, tool, paths, entrySeqs));
}

async function journalDropEntriesUnlocked(sessionId, turnSeq, tool, paths, entrySeqs) {
  try {
    if (!sessionId || !Number.isFinite(turnSeq)) return { ok: false, reason: 'no_session_context' };
    const dir = journalDir(sessionId);
    const index = await journalReadIndexForWrite(sessionId);
    if (!index.length) return { ok: true, dropped: 0 };
    const seqSet = Array.isArray(entrySeqs) ? new Set(entrySeqs.map(Number)) : null;
    const pathSet = new Set((paths || []).map(p => String(p)));
    const kept = [];
    let dropped = 0;
    for (const e of index) {
      const hit = e && Number(e.turnSeq) === Number(turnSeq)
        && e.tool === String(tool || '') && pathSet.has(String(e.path || ''))
        && (!seqSet || seqSet.has(Number(e.entrySeq)));
      if (hit) {
        dropped += 1;
        if (!e.skipped && e.op !== 'create') {
          const gzp = path.join(dir, `${e.turnSeq}-${e.entrySeq}.gz`);
          const st = await fsp.stat(gzp).catch(() => null);
          await fsp.unlink(gzp).catch(() => {});
          if (st) journalBytesAdjust(-st.size);
        }
        continue;
      }
      kept.push(e);
    }
    if (dropped) await journalWriteIndex(sessionId, kept);
    return { ok: true, dropped };
  } catch {
    return { ok: false, reason: 'journal_drop_error' };
  }
}

// GC. (1) Per-session: keep only the most recent JOURNAL_KEEP_TURNS turnSeqs; drop older entries + their
// .gz files. (2) Global: if the whole checkpoints/ tree exceeds JOURNAL_GLOBAL_MAX_BYTES, remove entire
// oldest sessions (by dir mtime) until under budget. All failures are silent.
// knownIndex:调用方(持会话写锁)刚写下的索引,传入即不再重读(hunt2 #13)。
async function journalGc(sessionId, knownIndex) {
  let freedBytes = 0; // PF1: bytes reclaimed by the per-session prune below, to decrement the size-cap cache
  try {
    const dir = journalDir(sessionId);
    const index = Array.isArray(knownIndex) ? knownIndex : await journalReadIndexForWrite(sessionId);
    if (index.length) {
      const turns = [...new Set(index.map(e => Number(e.turnSeq)))].sort((a, b) => a - b);
      if (turns.length > JOURNAL_KEEP_TURNS) {
        const keep = new Set(turns.slice(turns.length - JOURNAL_KEEP_TURNS));
        const kept = [];
        for (const e of index) {
          if (keep.has(Number(e.turnSeq))) { kept.push(e); continue; }
          if (!e.skipped && e.op !== 'create') {
            const gzp = path.join(dir, `${e.turnSeq}-${e.entrySeq}.gz`);
            const st = await fsp.stat(gzp).catch(() => null); // real on-disk size (best-effort) for the cache decrement
            await fsp.unlink(gzp).catch(() => {});
            if (st) freedBytes += st.size;
          }
        }
        await journalWriteIndex(sessionId, kept);
      }
    }
  } catch { /* silent */ }
  try {
    journalGcProbe.calls++;
    // PF1: keep the running estimate current with what the per-session prune just reclaimed (never below 0).
    if (freedBytes) journalBytesAdjust(-freedBytes);
    journalGcSinceScan++;
    // Decide whether the authoritative full sweep is worth running. Sweep when: uncalibrated (cold start),
    // periodic recalibration is due (drift correction), or the estimate is near/over the cap. Otherwise the
    // common case (well under budget) SKIPS the O(all-checkpoint-files) sweep entirely - the whole point of PF1.
    const needSweep = journalGlobalBytes == null
      || journalGcSinceScan >= JOURNAL_GC_RECALIBRATE_EVERY
      || journalGlobalBytes >= JOURNAL_GLOBAL_MAX_BYTES * JOURNAL_GC_SCAN_HYSTERESIS;
    if (!needSweep) return; // fast path: confidently under budget, no sweep
    // 上一轮因为【受保护会话自己就超限】而没能清到线下:在冷却期内别每次写都再全量扫一遍(那是 O(全部检查点文件),且清不动)。
    if (Date.now() < journalSweepBackoffUntil) return;
    // 性能批 C3:只是「定期重新校准」(冷启动、每 64 次)而估算明显低于上限时,全量扫描(逐个 stat 所有检查点文件,
    // 6 万个文件要 4 秒多)挪到后台、单飞 —— 修前这一次扫描就压在某一次文件编辑的工具调用上。估算已经接近 / 超过上限
    // (真要删东西)时照旧同步等它做完。例外是冷启动后的第一次(估算还没有):那一轮也在后台跑,首次编辑返回时超额的
    // 旧检查点可能还在,几秒内由这一轮清掉 —— 上限在启动后头一轮扫描结束前是「尽快」而不是「硬」(审查轮如实记下)。
    // 每会话自己的修剪(上面)仍然同步,不碰 v1.4.1 那条竞争。
    const overBudget = journalGlobalBytes != null && journalGlobalBytes >= JOURNAL_GLOBAL_MAX_BYTES * JOURNAL_GC_SCAN_HYSTERESIS;
    // 触发这次清扫的会话就是此刻正在写快照 / 检查点的那一条 —— 清扫不许把它自己的目录当「最旧」清掉(见 journalGlobalSweep)。
    if (overBudget) await journalGlobalSweepOnce(sessionId);
    else void journalGlobalSweepOnce(sessionId);
  } catch { /* silent */ }
}

let journalSweepInFlight = null;
// 清扫期间「别动」的会话(触发它的写者,含单飞期间并进来的后到写者)。清扫在每次 rm 之前现查这张表;清扫结束即清空,
// 所以它只管【这一轮】,不会让陈旧条目长期免疫(上限仍然有效,见 e2e checkpoint-gc-cache ②/④)。
const journalSweepProtect = new Set();
let journalSweepBackoffUntil = 0;          // 受保护会话自己超限、清不到线下时的冷却截止时刻(见 journalGlobalSweep 末尾)
const JOURNAL_SWEEP_BACKOFF_MS = 30 * 1000;
function journalGlobalSweepOnce(protectSessionId) {
  if (protectSessionId) journalSweepProtect.add(String(protectSessionId));
  if (!journalSweepInFlight) {
    journalSweepInFlight = journalGlobalSweep().catch(() => {}).finally(() => { journalSweepInFlight = null; journalSweepProtect.clear(); });
  }
  return journalSweepInFlight;
}
// 受保护会话在整仓仍超上限时,最多再清掉它自己最旧的历史快照(history-*.json.gz),但永远保留最近这么几份:
// 刚写下、模型视图里 rawRef 正指着的快照不能被「瘦身」清掉。检查点原件(<回合>-<序号>.gz,回滚用)一份都不动。
const JOURNAL_KEEP_HISTORY_SNAPSHOTS = 4;
async function journalTrimProtectedSnapshots(dir, bytesToFree) {
  let freed = 0;
  const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const rows = [];
  for (const ent of ents) {
    if (!ent.isFile() || !/^history-\d+(?:-[a-f0-9]{16})?\.json\.gz$/.test(ent.name)) continue;
    const st = await fsp.stat(path.join(dir, ent.name)).catch(() => null);
    if (st) rows.push({ name: ent.name, size: st.size, mtime: st.mtimeMs });
  }
  rows.sort((a, b) => a.mtime - b.mtime); // 最旧在前
  const removable = rows.slice(0, Math.max(0, rows.length - JOURNAL_KEEP_HISTORY_SNAPSHOTS));
  for (const r of removable) {
    if (freed >= bytesToFree) break;
    await fsp.unlink(path.join(dir, r.name)).then(() => { freed += r.size; }).catch(() => {});
  }
  return freed;
}
async function journalGlobalSweep() {
  journalGcProbe.fullScans++;
  journalGcSinceScan = 0;
  journalSweeping++;
  const deltaMark = journalDeltaDuringSweep; // writer deltas already counted BEFORE this window opened
  try {
    // Authoritative sweep: sum every session dir, purge whole sessions oldest-first when over budget, and
    // RECALIBRATE the cache from measured truth. This is the ONLY writer that resets journalGlobalBytes, so a
    // purge decision is always made against real bytes, never the estimate.
    const root = paths.checkpoints;
    const names = await fsp.readdir(root).catch(() => []);
    const dirs = [];
    let total = 0;
    for (const name of names) {
      const p = path.join(root, name);
      const st = await fsp.stat(p).catch(() => null);
      if (!st || !st.isDirectory()) continue;
      const size = await dirSize(p);
      total += size;
      dirs.push({ p, size, mtime: st.mtimeMs });
    }
    if (total > JOURNAL_GLOBAL_MAX_BYTES) {
      dirs.sort((a, b) => a.mtime - b.mtime); // oldest first
      // 修前这里谁最旧清谁,连【正在写快照的那一条会话】自己也在内:一条会话自己的检查点树超过上限(1M 窗口模型每次压缩都写一份
      // 带内容哈希的整史快照,几十份就是上百 MB),清扫把它整个目录删光 —— 刚返回给上下文压缩的 rawRef 立刻 ENOENT,
      // observation_recall 回 `observation recall failed: ENOENT`,连它的文件回滚点也一并消失。现在:触发清扫的写者与有活回合的会话
      // 不整目录清;其余照旧最旧优先。仍超限时只削受保护会话自己最旧的历史快照(见 journalTrimProtectedSnapshots)。
      const isProtected = d => { const name = path.basename(d.p); return journalSweepProtect.has(name) || isSessionActive(name); };
      for (const d of dirs) {
        if (total <= JOURNAL_GLOBAL_MAX_BYTES) break;
        if (isProtected(d)) continue;
        await fsp.rm(d.p, { recursive: true, force: true }).catch(() => {});
        total -= d.size;
      }
      let trimmedBytes = 0;
      if (total > JOURNAL_GLOBAL_MAX_BYTES) {
        for (const d of dirs) {
          if (total <= JOURNAL_GLOBAL_MAX_BYTES) break;
          if (!isProtected(d)) continue;
          const freed = await journalTrimProtectedSnapshots(d.p, total - JOURNAL_GLOBAL_MAX_BYTES);
          total -= freed; trimmedBytes += freed;
        }
      }
      // 受保护会话自己仍超限:宁可暂时超上限(下一次它不再是写者时照常按最旧优先清),也不删正在用的回滚点与最近快照。
      // 这一轮一点都削不动(只剩保留份额内的快照 / 回滚点)才进冷却,否则每次写都白扫一遍全仓。
      if (total > JOURNAL_GLOBAL_MAX_BYTES) {
        if (trimmedBytes === 0) journalSweepBackoffUntil = Date.now() + JOURNAL_SWEEP_BACKOFF_MS;
        logEvent({ kind: 'journal_cap_exceeded_protected', totalBytes: total, capBytes: JOURNAL_GLOBAL_MAX_BYTES });
      } else journalSweepBackoffUntil = 0;
    }
    // Recalibrate from measured truth, then replay the writer bytes that landed DURING this window so a
    // concurrent journalRecord's increment isn't clobbered (PF1: without this the cache could drift LOW ->
    // a missed sweep). Double-counting a byte already on disk when measured only inflates the estimate,
    // which is the SAFE direction (an extra sweep that recalibrates, never a skipped cleanup).
    const windowDelta = journalDeltaDuringSweep - deltaMark;
    journalGlobalBytes = Math.max(0, total + windowDelta);
  } finally {
    journalSweeping--;
    if (journalSweeping === 0) journalDeltaDuringSweep = 0; // reset once no sweep is measuring
  }
}

// Sum the byte size of a directory tree (best-effort; errors count as 0).
async function dirSize(dir) {
  let total = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) total += await dirSize(p);
    else { const st = await fsp.stat(p).catch(() => null); if (st) total += st.size; }
  }
  return total;
}

// Roll back checkpoint entries for a turn. entrySeq given = single entry; omitted = the whole turn
// (all entries for that turnSeq, in REVERSE order). Inverse ops: delete→write `before` back;
// modify→write `before` back; create→unlink the current file. skipped:true entries fail (no stored
// content) and are listed in `failed` without aborting the rest. Reverted entries are REMOVED from the
// index (idempotent: rolling back the same turn again → {ok:false,error:'no entries'}). The rollback
// action itself is NEVER journaled (anti-recursion). Returns {ok, reverted:[{path,op,turnSeq,entrySeq,tool,ts}], failed:[{path,reason}]}.
async function journalRollback(sessionId, turnSeq, entrySeq) {
  const dir = journalDir(sessionId);
  const index = await journalReadIndex(sessionId);
  const tSeq = Number(turnSeq);
  let targets = index.filter(e => e && Number(e.turnSeq) === tSeq);
  if (entrySeq !== undefined && entrySeq !== null && entrySeq !== '') {
    const eSeq = Number(entrySeq);
    targets = targets.filter(e => Number(e.entrySeq) === eSeq);
  }
  if (!targets.length) return { ok: false, error: 'no entries' };
  // Reverse order so multiple mutations to the same file unwind to the earliest recorded `before`.
  targets = targets.slice().sort((a, b) => b.entrySeq - a.entrySeq);
  // 安全审计 #8:index.json 是盘上的数据,不是可信输入 —— 条目里的 path 会被原样写回(或删掉)。修前不验:谁能改
  // index.json(检查点目录曾是文件工具可写的数据根子树)就能借「回滚」把任意内容落到任意位置。现在每条都按【写】
  // 重过一遍与文件工具同一个闸(三层硬地板 + 受保护数据 + 包含判定;包含判定用读根集合,见 guardFileToolPath
  // 的 rootSet:'read' 注),权限档按会话当前的有效档位(宽写档下工作区外的合法条目照样能回滚)。不过闸的条目
  // 不动盘、记进 failed(原因 path-denied),其余照常回滚;它们留在索引里。序号不是整数的条目同样拒(.gz 文件名由它拼)。
  const guardCtx = await getRollbackContext(sessionId);
  const reverted = [], failed = [], revertedKeys = new Set();
  for (const e of targets) {
    const key = `${e.turnSeq}-${e.entrySeq}`;
    try {
      if (!Number.isSafeInteger(Number(e.turnSeq)) || !Number.isSafeInteger(Number(e.entrySeq))) {
        failed.push({ path: typeof e.path === 'string' ? e.path : '', reason: 'path-denied: malformed checkpoint entry' });
        continue;
      }
      if (typeof e.path !== 'string' || !e.path || !path.isAbsolute(e.path)) {
        failed.push({ path: typeof e.path === 'string' ? e.path : '', reason: 'path-denied: checkpoint path is not absolute' });
        continue;
      }
      const g = await guardFileToolPath(e.path, guardCtx, { tool: 'checkpoint_rollback', write: true, rootSet: 'read' });
      if (!g || !g.ok) {
        logEvent({ kind: 'checkpoint_rollback_denied', sessionId: String(sessionId || ''), turnSeq: Number(e.turnSeq), entrySeq: Number(e.entrySeq), code: (g && g.code) || '' });
        failed.push({ path: e.path, reason: `path-denied: ${(g && g.error) || 'blocked by the file write guard'}` });
        continue;
      }
      if (e.skipped) { failed.push({ path: e.path, reason: 'before content was not stored (too large)' }); continue; }
      if (e.op === 'create') {
        await fsp.unlink(e.path).catch(() => {}); // idempotent: gone already is fine
      } else {
        // modify | delete → restore the gzipped before content
        const gz = await fsp.readFile(path.join(dir, `${e.turnSeq}-${e.entrySeq}.gz`));
        const before = zlib.gunzipSync(gz);
        await fsp.mkdir(path.dirname(e.path), { recursive: true });
        // Atomic restore (tmp + rename, same discipline as saveSession): the trust layer's own rollback
        // must be lossless — a crash (power loss / kill) mid-writeFile would TRUNCATE the user's file,
        // which is exactly the harm checkpoints exist to prevent. rename is atomic within a volume, so a
        // crash leaves either the pre-rollback file or the fully-restored one, never a torn write.
        const tmpRestore = e.path + '.tmp';
        await fsp.writeFile(tmpRestore, before);
        await fsp.rename(tmpRestore, e.path);
        await fsp.unlink(path.join(dir, `${e.turnSeq}-${e.entrySeq}.gz`)).catch(() => {});
      }
      // C4:turnSeq / entrySeq / tool / ts 是加字段(既有读者只看 path / op)—— 路由据此给 reverts.json 记「哪一回合的哪次修改被撤了」。
      reverted.push({ path: e.path, op: e.op, turnSeq: Number(e.turnSeq), entrySeq: Number(e.entrySeq), tool: typeof e.tool === 'string' ? e.tool : '', ts: typeof e.ts === 'string' ? e.ts : '' });
      revertedKeys.add(key);
    } catch (err) {
      failed.push({ path: e.path, reason: (err && err.message) ? err.message : String(err) });
    }
  }
  // Remove the successfully-reverted entries from the index (idempotency). Failed ones stay so a retry
  // is possible. The rollback is NOT journaled — no new checkpoint entries are created here.
  const remaining = index.filter(e => !revertedKeys.has(`${e.turnSeq}-${e.entrySeq}`));
  await journalWriteIndex(sessionId, remaining).catch(() => {});
  return { ok: reverted.length > 0, reverted, failed };
}

// ── C4(61 号文):检查点对模型可见 —— 「用户在界面撤销了什么」的记录 ──────────────────────────────────────
// journalRollback 撤销成功的条目会从 index.json 里【删掉】:之后既没有地方回答「这一条已被用户撤销」,模型也无从知道用户
// 撤过 —— 下一轮它可能基于已被撤回的内容接着干。这里在检查点目录里另起一个旁车 <checkpoints>/<sid>/reverts.json,记两件事:
//   ① checkpoint_list(12)给撤销过的修改标 reverted:true;
//   ② 「待告知」:announced:false 的记录由 09 在下一个 provider 回合的 user 消息落历史时读走、写成一行告知,会话落盘后 ack。
// 为什么是旁车文件而不是会话头字段:会话头是【整份重写】的 —— 回合手里那份内存副本(以及任何 load→await→save 的旁路写者)
// 收尾时会把头写回「没有该字段」的样子。02d 的覆盖表(权限档/桌面工具/引擎路由)就是为这种陈旧副本写的,但那是给「必须对活回合
// 立即生效」的开关用的;本数据只在没有活回合时写(rollback 路由对活回合回 409,rewind 先停回合再等 settle),下一回合起跑时读,
// 不需要对活回合生效。独立文件从根上与会话头的任何一次保存(含撤回代数闸 SESSION_STALE_SAVE 丢掉的那些)都不相交,也就没有
// 「被回合的陈旧副本吞掉」这一类问题,不必再造一张覆盖表。随会话删除(deleteSession 清整个检查点目录)与全局体积清扫一起走。
// 记录按 (turnSeq, tool, op) 分组而不是一个文件一条:一次解压几千个文件的撤销也只是一条记录,告知一行说得完。
// 读失败/文件坏 = 当空(没有告知、没有已撤销标记,模型下一次读文件就会看到真实状态),不隔离、不抛。
const JOURNAL_REVERT_LOG_MAX = 100;     // 每会话最多留这么多条记录(超出先丢已告知的、再丢最旧的)
const JOURNAL_REVERT_PATHS_MAX = 5;     // 每条记录最多记几个样例路径(files 是真实个数)
const journalRevertChains = new Map();  // sessionId -> Promise(同会话的读改写串行)
function journalRevertLogPath(sessionId) { return path.join(journalDir(sessionId), 'reverts.json'); }
function journalRevertRecordOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const seq = Number(raw.seq), turnSeq = Number(raw.turnSeq);
  if (!Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(turnSeq) || turnSeq < 0) return null;
  const paths = (Array.isArray(raw.paths) ? raw.paths : []).filter(p => typeof p === 'string' && p).slice(0, JOURNAL_REVERT_PATHS_MAX).map(p => p.slice(0, 400));
  const files = Number.isSafeInteger(Number(raw.files)) && Number(raw.files) > 0 ? Number(raw.files) : Math.max(1, paths.length);
  return {
    seq, turnSeq,
    entrySeq: Number.isSafeInteger(Number(raw.entrySeq)) ? Number(raw.entrySeq) : -1,
    tool: typeof raw.tool === 'string' ? raw.tool.slice(0, 64) : '',
    op: raw.op === 'create' || raw.op === 'delete' ? raw.op : 'modify',
    files, paths,
    at: typeof raw.at === 'string' ? raw.at.slice(0, 40) : '',
    revertedAt: typeof raw.revertedAt === 'string' ? raw.revertedAt.slice(0, 40) : '',
    announced: raw.announced === true,
  };
}
// 从不抛;文件不存在 / 读不动 / 不是预期形状 → []。
async function journalRevertLogRead(sessionId) {
  try {
    const parsed = safeJsonParse(await fsp.readFile(journalRevertLogPath(sessionId), 'utf8'), null);
    const rows = parsed && typeof parsed === 'object' && Array.isArray(parsed.items) ? parsed.items : [];
    return rows.map(journalRevertRecordOf).filter(Boolean);
  } catch { return []; }
}
async function journalRevertLogWrite(sessionId, items) {
  await fsp.mkdir(journalDir(sessionId), { recursive: true });
  await atomicWriteJson(journalRevertLogPath(sessionId), JSON.stringify({ schema: 1, items }), { retries: 3 });
}
// 路由在 journalRollback 成功后调:reverted = journalRollback 回的 [{path, op, turnSeq, entrySeq, tool, ts}]。
// 同一次撤销里 (turnSeq, tool, op) 相同的并成一条;已有【还没告知】的同键记录就并进去(用户先撤 a 再撤 b,两次都发生在
// 模型下一回合之前,告知一行说完)。已告知的不并(那次告知已经发出去了,这次是新的事实)。
async function journalRevertLogRecord(sessionId, reverted) {
  const rows = (Array.isArray(reverted) ? reverted : []).filter(r => r && typeof r.path === 'string' && r.path && Number.isSafeInteger(Number(r.turnSeq)));
  if (!rows.length) return;
  return runKeyedChain(journalRevertChains, String(sessionId || ''), async () => {
    const items = await journalRevertLogRead(sessionId);
    const now = nowIso();
    let nextSeq = items.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
    const groups = new Map();
    for (const r of rows.slice().sort((a, b) => (Number(a.entrySeq) || 0) - (Number(b.entrySeq) || 0))) {   // 主路径 = 本组 entrySeq 最小的那条
      const op = r.op === 'create' || r.op === 'delete' ? r.op : 'modify';
      const key = `${Number(r.turnSeq)}|${r.tool || ''}|${op}`;
      let g = groups.get(key);
      if (!g) { g = { turnSeq: Number(r.turnSeq), entrySeq: Number.isSafeInteger(Number(r.entrySeq)) ? Number(r.entrySeq) : -1, tool: String(r.tool || ''), op, paths: [], at: '' }; groups.set(key, g); }
      if (!g.paths.includes(r.path)) g.paths.push(r.path);
      if (typeof r.ts === 'string' && r.ts > g.at) g.at = r.ts;
    }
    for (const g of groups.values()) {
      const open = items.find(r => !r.announced && r.turnSeq === g.turnSeq && r.tool === g.tool.slice(0, 64) && r.op === g.op);
      if (open) {
        open.files += g.paths.length;
        for (const p of g.paths) if (open.paths.length < JOURNAL_REVERT_PATHS_MAX && !open.paths.includes(p)) open.paths.push(p.slice(0, 400));
        if (g.entrySeq >= 0 && (open.entrySeq < 0 || g.entrySeq < open.entrySeq)) open.entrySeq = g.entrySeq;
        if (g.at > open.at) open.at = g.at;
        open.revertedAt = now;
        continue;
      }
      const rec = journalRevertRecordOf({ seq: nextSeq++, turnSeq: g.turnSeq, entrySeq: g.entrySeq, tool: g.tool, op: g.op, files: g.paths.length, paths: g.paths, at: g.at, revertedAt: now, announced: false });
      if (rec) items.push(rec);
    }
    while (items.length > JOURNAL_REVERT_LOG_MAX) {
      const i = items.findIndex(r => r.announced);
      items.splice(i >= 0 ? i : 0, 1);   // 先丢最旧的已告知项,没有才丢最旧的待告知项
    }
    await journalRevertLogWrite(sessionId, items);
  });
}
// 09 在 provider 回合起跑时读:还没告知的记录(回合升序)。读不到 = []。
async function journalRevertNoticesPeek(sessionId) {
  try { return (await journalRevertLogRead(sessionId)).filter(r => !r.announced).sort((a, b) => a.turnSeq - b.turnSeq || a.seq - b.seq); }
  catch { return []; }
}
// 09 在带着告知的那条 user 消息【已落盘】之后调:只把 peek 到的那几条标成已告知(按 seq),期间新记的不动。
// 先 peek、落盘后才 ack 的顺序是有意的:中途失败只会让告知多发一次(无害),不会让模型永远收不到。
async function journalRevertNoticesAck(sessionId, seqs) {
  const wanted = new Set((Array.isArray(seqs) ? seqs : []).map(Number));
  if (!wanted.size) return;
  return runKeyedChain(journalRevertChains, String(sessionId || ''), async () => {
    const items = await journalRevertLogRead(sessionId);
    let touched = false;
    for (const r of items) if (wanted.has(r.seq) && !r.announced) { r.announced = true; touched = true; }
    if (touched) await journalRevertLogWrite(sessionId, items);
  });
}
// rewindSession 截断成功后调:回合号 >= fromTurnSeq 的记录都属于已被丢弃的回合,留着只会给模型一句指向「不存在的回合」的告知。
async function journalRevertLogPrune(sessionId, fromTurnSeq) {
  const from = Number(fromTurnSeq);
  if (!Number.isFinite(from)) return;
  return runKeyedChain(journalRevertChains, String(sessionId || ''), async () => {
    const items = await journalRevertLogRead(sessionId);
    const kept = items.filter(r => r.turnSeq < from);
    if (kept.length !== items.length) await journalRevertLogWrite(sessionId, kept);
  });
}

return { journalRevertLogRead, JOURNAL_KEEP_TURNS, JOURNAL_MAX_BEFORE_BYTES, journalGcProbe, journalBytesAdjust, withJournalWriteLock, journalDir, journalReadIndex, journalResolveTurnSeq, journalRecord, journalRecordMany, workspaceBaselinePathKey, workspaceBaselineIsCodePath, captureWorkspaceTurnBaseline, reconcileWorkspaceTurnBaseline, journalDropEntries, journalGc, journalRollback, journalRevertLogRecord, journalRevertNoticesPeek, journalRevertNoticesAck, journalRevertLogPrune };
}
module.exports = { createCheckpointJournal };
