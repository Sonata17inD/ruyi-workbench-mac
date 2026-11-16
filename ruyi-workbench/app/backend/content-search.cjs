'use strict';
const path = require('node:path');
const fsp = require('node:fs/promises');
const { DEFAULT_IGNORE_DIRS, DOTNET_PROJECT_RE, buildIgnoreMatcher, explicitSegmentsOfGlob, globToRegExp, normalizeSearchPattern } = require('./path-patterns.cjs');
const { assertSearchExecution, awaitSearchProbe, closeSearchWorker } = require('./search-workers.cjs');
function createContentSearch({ ProcessRuntime, walkFiles, probe, privacy, sensitiveGlobsForRg }) {
  const { hasRgAsync, probeRg } = probe;
  const { privacyProjectSearch, privacySourceActive, privacySourceMark, sourceViewOf } = privacy;
async function searchFileContent(root, pattern, opts = {}) {
  assertSearchExecution(opts.signal);
  // F2: single normalization point shared by the rg fast path and the JS scanner.
  const norm = normalizeSearchPattern(pattern);
  const effOpts = norm.extraFlags ? { ...opts, extraFlags: norm.extraFlags } : opts;
  let results = null;
  // Fast path: ripgrep, if vendored. Failure/timeout → silent fallback to the JS scanner below.
  if (!privacySourceActive() && await awaitSearchProbe(hasRgAsync(), opts.signal)) {
    try {
      const viaRg = await searchFileContentRg(root, norm.pattern, effOpts);
      if (viaRg) {
        results = viaRg;
        // rg 不报被剪掉的目录;补一次有界探查,让「没搜到」不再静默地可能落在 build/dist/out/target 里。
        const pd = await discoverPrunedDirs(root, effOpts, searchExplicitNames(root, effOpts)).catch(() => []);
        if (pd.length) results.prunedDirs = pd;
      }
    } catch (error) { if (error.searchExecutionFailure) throw error; /* otherwise fall through to JS */ }
  }
  if (!results) results = await searchFileContentJs(root, norm.pattern, effOpts);
  assertSearchExecution(opts.signal);
  // Carry the literal-fallback note on the array (JSON.stringify of an array drops extra props, so the
  // file_search handler lifts it into the response as `patternNote`; other callers safely ignore it).
  if (norm.note) results.patternNote = norm.note;
  // 审计 F:JS 路径的正则撞了时间预算 —— 已找到的照常给,并如实说「可能不全」(同一个 patternNote 出口)。
  if (results.regexTimedOut) {
    results.patternNote = (results.patternNote ? results.patternNote + '; ' : '')
      + 'regex search hit its time budget (pattern too slow, possible catastrophic backtracking); results may be incomplete';
  }
  return results;
}

// Group flat match records by file (stable order of first appearance) when opts.group is set.
function maybeGroup(results, group) {
  if (!group) return results;
  const byFile = new Map();
  for (const r of results) {
    if (!byFile.has(r.path)) byFile.set(r.path, { path: r.path, relativePath: r.relativePath, matches: [] });
    const { path: _p, relativePath: _rp, ...rest } = r;
    const view = sourceViewOf(r);
    if (view) privacySourceMark(rest, ['/text', ...(rest.context || []).map((_, i) => '/context/' + i + '/text')], view);
    byFile.get(r.path).matches.push(rest);
  }
  return Array.from(byFile.values());
}

// 安全修复(审计 F · ReDoS):模型给的正则在 JS 扫描路径上是逐行同步 `re.test` —— `(a+)+$` 对 30 个 a 加一个 b
// 这一行就要回溯 2^30 步,整个服务的事件循环被冻住(实测 81 s,期间 SSE/其它会话全停)。rg 不在(PATH 里没有、
// 随包缺失)或 rg 拒绝了这个模式(Rust regex 不支持回溯引用/环视 → 退到 JS)时都会走到这里。
// 修法:匹配放进 worker_threads(Node 内建,零依赖)里跑,主线程只等消息;超过时间预算(默认 10 s,调用方只能
// 往小调)就 terminate 掉 worker —— 一个卡死的正则能拖住的只是它自己那个线程。已找到的命中照常返回,
// 另挂 regexTimedOut 让调用方把「结果可能不全」说出来。文件读取也在 worker 里(同步读不再占主线程)。
const REGEX_SCAN_MAX_MS = 10000;
const REGEX_SCAN_WORKER_SRC = `
(() => {
  const { parentPort, workerData } = require('worker_threads');
  const fs = require('fs');
  // docs_search 的 autoDecode 与 file_search 的逐文件解码已合成同一个 decodeFile(BOM → 严格 UTF-8 → GB18030 → 宽松 UTF-8),
  // 两条路径都按它解;autoDecode 只留作入参兼容。
  const { files, pattern, flags, ctx, maxResults, wholeFile, wholeFileChars, onlyNonUtf8, privacySources } = workerData;
  let re;
  try { re = new RegExp(pattern, flags); } catch (e) { parentPort.postMessage({ type: 'error', error: String((e && e.message) || e) }); return; }
  // 2026-10 走查(R2):按文件判编码再解码(与 file_read 同一口径:BOM > 严格 UTF-8 > GB18030),不再一律当 UTF-8 ——
  // 修前 GBK 文件里的中文搜不到、ASCII 命中行的中文部分显示成乱码。UTF-16 带 BOM 的文本含 NUL,先认 BOM 再做二进制判定。
  // 既不是合法 UTF-8 也不是合法 GBK 的按 UTF-8 宽松解码(lossy),并上报。
  const decodeFile = (buf) => {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.toString('utf8', 3), enc: 'utf8' };
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) { try { return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), enc: 'utf16le' }; } catch { return null; } }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { try { return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), enc: 'utf16be' }; } catch { return null; } }
    // F7:含 NUL 的文件按二进制跳过(与 rg 口径一致;此前 JS 引擎会在随机二进制里命中)。
    if (buf.subarray(0, 8192).includes(0)) return null;
    try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf), enc: 'utf8' }; } catch { /* 不是 UTF-8 */ }
    try { return { text: new TextDecoder('gb18030', { fatal: true }).decode(buf), enc: 'gb18030' }; } catch { /* 也不是 GBK / 运行时无 GB18030 */ }
    return { text: buf.toString('utf8'), enc: 'utf8', lossy: true };
  };
  let count = 0, privacySourceBytes = 0, privacySourceFiles = 0;
  for (const file of files) {
    if (count >= maxResults) break;
    let raw = '';
    try {
      const dec = decodeFile(fs.readFileSync(file.path));
      if (!dec) continue;
      const nonUtf8 = dec.enc !== 'utf8' || dec.lossy === true;
      if (nonUtf8) parentPort.postMessage({ type: 'enc', path: file.path, relativePath: file.relativePath, enc: dec.lossy ? 'lossy' : dec.enc });
      // onlyNonUtf8:rg 引擎的补扫 —— UTF-8 文件 rg 已经搜过了,这里只重搜 rg 看不懂的(GBK / UTF-16);lossy 的 rg 本来就按 U+FFFD 给过命中,不重复。
      if (onlyNonUtf8 && (!nonUtf8 || dec.lossy)) continue;
      raw = dec.text;
    } catch { continue; }
    if (wholeFile) {
      re.lastIndex = 0;
      if (re.test(raw.slice(0, wholeFileChars))) { parentPort.postMessage({ type: 'match', rec: { path: file.path, relativePath: file.relativePath, line: 1 } }); count += 1; }
      continue;
    }
    const lines = raw.split(/\\r?\\n/); let sourceSent = false;
    for (let i = 0; i < lines.length; i += 1) {
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        if (privacySources && !sourceSent) {
          const bytes = Buffer.byteLength(raw);
          if (bytes > 1048576 || privacySourceBytes + bytes > 8 * 1048576 || privacySourceFiles >= 128) { parentPort.postMessage({ type: 'error', error: 'privacy.source_limit' }); return; }
          privacySourceBytes += bytes; privacySourceFiles += 1;
          parentPort.postMessage({ type: 'source', path: file.path, raw }); sourceSent = true;
        }
        const rec = { path: file.path, relativePath: file.relativePath, line: i + 1, text: lines[i].slice(0, 500) };
        if (ctx > 0) {
          const block = [];
          for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j += 1) {
            block.push({ line: j + 1, text: lines[j].slice(0, 500), match: j === i });
          }
          rec.context = block;
        }
        parentPort.postMessage({ type: 'match', rec });
        count += 1;
        if (count >= maxResults) break;
      }
    }
  }
  parentPort.postMessage({ type: 'done' });
})();
`;
// files: [{path, relativePath}];返回 { results, timedOut, error }。永不 reject。
function regexScanFilesBounded(files, pattern, flags, opts = {}) {
  const budgetMs = Math.max(50, Math.min(REGEX_SCAN_MAX_MS, Number(opts.regexTimeoutMs) || REGEX_SCAN_MAX_MS));
  return new Promise(resolve => {
    const results = [];
    const encs = [];   // 非 UTF-8 文件的编码上报 [{path, relativePath, enc}]
    const sources = new Map();
    let settled = false, worker = null, timer = null;
    const finish = async extra => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      const { cleanupIncomplete } = await closeSearchWorker(worker);
      const aborted = extra.aborted === true || opts.signal?.aborted === true;
      if (aborted || cleanupIncomplete) { results.length = 0; encs.length = 0; sources.clear(); }
      resolve({ results, encs, sources, timedOut: false, error: '', ...extra,
        ...(aborted ? { aborted: true } : {}), ...(cleanupIncomplete ? { cleanupIncomplete: true } : {}) });
    };
    const abort = () => { void finish({ aborted: true }); };
    if (opts.signal?.aborted) { abort(); return; }
    try {
      const { Worker } = require('worker_threads');
      worker = new Worker(REGEX_SCAN_WORKER_SRC, {
        eval: true,
        workerData: {
          files: files.map(f => ({ path: f.path, relativePath: f.relativePath })), pattern: String(pattern), flags: String(flags || ''),
          ctx: Math.max(0, Math.min(5, Number(opts.context || 0) || 0)), maxResults: Math.max(1, Number(opts.maxResults || 200)),
          wholeFile: opts.wholeFile === true, wholeFileChars: Math.max(1, Number(opts.wholeFileChars) || 400000),
          onlyNonUtf8: opts.onlyNonUtf8 === true,
          privacySources: privacySourceActive(),
        },
      });
    } catch (e) { finish({ error: String((e && e.message) || e) }); return; }
    timer = setTimeout(() => finish({ timedOut: true }), budgetMs);
    worker.on('message', m => {
      if (!m || settled) return;
      if (m.type === 'match') results.push(m.rec);
      else if (m.type === 'source') sources.set(m.path, m.raw);
      else if (m.type === 'enc') encs.push({ path: m.path, relativePath: m.relativePath, enc: m.enc });
      else if (m.type === 'done') finish({});
      else if (m.type === 'error') finish({ error: String(m.error || 'regex error') });
    });
    worker.on('error', e => finish({ error: String((e && e.message) || e) }));
    worker.on('exit', () => finish({}));
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();
  });
}

// F7:内容搜索的单文件体积上限(两个引擎同一个默认值)。1MB 太小 —— 日志文件恰恰是最常被搜的,且 rg 是流式的、
// JS worker 一次只读一个文件,20MB 的内存/耗时都可控。超限的文件不再静默:JS 引擎在结果里列 skippedLargeFiles,
// rg 引擎在结果里带 maxFileBytes,让模型知道「更大的文件没搜」并可用 maxFileBytes 调高(上限 200MB)。
const SEARCH_DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const SEARCH_MAX_FILE_BYTES_CEILING = 200 * 1024 * 1024;
function searchMaxFileBytes(opts) {
  const n = Number(opts && opts.maxFileBytes);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), SEARCH_MAX_FILE_BYTES_CEILING) : SEARCH_DEFAULT_MAX_FILE_BYTES;
}
const SEARCH_JS_DEFAULT_MAX_FILES = 5000;
// 深度默认【不限】(两个引擎同一口径):调用方传 maxDepth 才限。JS 的 maxDepth=N = 最多下钻 N 层目录(文件最深 N+1 段),
// rg 的 --max-depth 数路径段,故传给 rg 时 +1。修前 rg 无条件 --max-depth 9(Maven/Gradle/monorepo 的深层源码静默搜不到),
// JS 是 8 —— 两边还各说各话。无限深度由 maxFiles / maxVisited 兜底(dirent 不跟符号链接,不会环)。
function searchMaxDepth(opts) {
  const n = Number(opts && opts.maxDepth);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
// 内容搜索里「调用方点名了谁」:glob 的字面段(`dist/**`、`.github/**`)与 root 的末段 → 这些默认清单里的目录不剪;
// glob 里字面的 '.' 开头段 → 隐藏项放行(glob 本身把搜索范围框死在它之内,不会借此扫全部隐藏目录)。
function explicitAllowDirs(root, segs) {
  let rootName = '';
  try { rootName = path.basename(path.resolve(root || '.')); } catch { rootName = ''; }
  return rootName ? [...segs, rootName] : segs;
}
function searchExplicitNames(root, opts) {
  const segs = explicitSegmentsOfGlob(opts && opts.glob);
  return { allowDirs: explicitAllowDirs(root, segs), allowHidden: segs.filter(x => x.startsWith('.') && x.length > 1) };
}
// 被默认清单剪掉的目录名的提示语(file_search/glob/file_list/project_snapshot 共用):剪了就说,并说怎么放开。
function prunedDirsHint(tool) {
  return `${tool}: skipped dependency/build/cache folders (see prunedDirs); a miss may be inside them - pass includeIgnored:true to include them`;
}
// rg 引擎自己不报剪了谁:对同一棵树做一次有界的、只读目录的探查(深度 ≤ 6、最多读 2000 个目录),列出默认清单会剪的目录。
async function discoverPrunedDirs(root, opts, names) {
  if (opts.includeIgnored === true) return [];
  const ignore = buildIgnoreMatcher({ ignoreDirs: opts.ignoreDirs, allowDirs: names.allowDirs });
  const found = [];
  const base = path.resolve(root || process.cwd());
  const queue = [{ dir: base, rel: '', depth: 0, hiddenOk: false }];
  const allowH = new Set(names.allowHidden.map(x => (x)));
  let reads = 0;
  const maxDepth = Math.min(searchMaxDepth(opts) || 6, 6);
  for (let qi = 0; qi < queue.length && reads < 2000 && found.length < 12; qi += 1) {
    assertSearchExecution(opts.signal);
    const { dir, rel, depth, hiddenOk } = queue[qi];
    reads += 1;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const dotnetDir = ignore.dotnet && entries.some(e => !e.isDirectory() && DOTNET_PROJECT_RE.test(e.name));
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      let ok = hiddenOk;
      if (!hiddenOk && opts.includeHidden !== true && e.name.charCodeAt(0) === 46) {
        if (!allowH.has(e.name)) continue;
        ok = true;
      }
      const r = rel ? rel + '/' + e.name : e.name;
      if (ignore.pruneName(e.name, r, dotnetDir)) { if (found.length < 12 && !found.includes(r)) found.push(r); continue; }
      if (depth < maxDepth) queue.push({ dir: path.join(dir, e.name), rel: r, depth: depth + 1, hiddenOk: ok });
    }
  }
  return found;
}

async function searchFileContentJs(root, pattern, opts = {}) {
  // 不含 '/' 的 glob(`*.js`)按文件名在任意层级匹配(与 rg 的 -g 同一语义;修前 JS 引擎只配根下的文件)。
  const globRe = opts.glob ? globToRegExp(/[\\/]/.test(String(opts.glob)) ? String(opts.glob) : '**/' + String(opts.glob)) : null;
  // glob 在遍历时就过滤(accept),配额只数「真会被扫描的文件」;修前先按遍历顺序截 2000 条再滤,
  // 前 2000 条是 .github / __pycache__ 时后面的源码一个都搜不到,而且 truncated 被丢掉。
  const names = searchExplicitNames(root, opts);
  const files = await walkFiles(root, {
    signal: opts.signal,
    recursive: true,
    maxFiles: opts.maxFiles || SEARCH_JS_DEFAULT_MAX_FILES,
    maxDepth: searchMaxDepth(opts) || Infinity,
    emitDirs: false,
    ignoreDirs: opts.ignoreDirs,
    includeIgnored: opts.includeIgnored === true,
    allowDirs: names.allowDirs,
    // 隐藏文件/目录(.ssh/.aws/.env …)默认不搜,includeHidden:true 才搜;glob 字面点名的隐藏段(.github/**)例外。
    skipHidden: opts.includeHidden !== true,
    allowHidden: names.allowHidden,
    accept: globRe ? (rel => globRe.test(rel)) : null,
  });
  // F2: extraFlags carries m/s harvested from a stripped inline-flag prefix (normalizeSearchPattern).
  const flags = (opts.ignoreCase === false ? 'g' : 'gi') + (opts.extraFlags || '');
  const maxFileBytes = searchMaxFileBytes(opts);
  const scanFiles = [];
  const skippedLarge = [];
  for (const f of files) {
    if (f.type !== 'file') continue;
    if (f.size > maxFileBytes) skippedLarge.push(f.relativePath); else scanFiles.push(f);
  }
  // 多要一条用来判「是否还有更多」:恰好 maxResults 条命中时不该报 truncated(修前 `>= maxResults` 一律报截断)。
  const wantMax = Math.max(1, Number(opts.maxResults || 200));
  const scan = await regexScanFilesBounded(scanFiles, pattern, flags, { ...opts, maxResults: wantMax + 1 });
  assertSearchExecution(opts.signal, scan);
  await privacyProjectSearch(scan, opts);
  assertSearchExecution(opts.signal, scan);
  const moreMatches = scan.results.length > wantMax;
  if (moreMatches) scan.results.length = wantMax;
  const grouped = maybeGroup(scan.results, opts.group);
  if (moreMatches) grouped.moreMatches = true;
  applyNonUtf8Report(grouped, scan.encs);
  if (scan.timedOut) grouped.regexTimedOut = true;
  grouped.engine = 'js';
  grouped.scannedFiles = scanFiles.length;
  grouped.maxFileBytes = maxFileBytes;
  if (files.truncated) { grouped.walkTruncated = true; grouped.walkTruncatedReason = files.truncatedReason || 'maxFiles'; }
  if (skippedLarge.length) grouped.skippedLargeFiles = skippedLarge;
  if (files.prunedDirs) grouped.prunedDirs = files.prunedDirs;
  return grouped;
}

// rg 的 glob 是 gitignore 语法:不含 '/' 的名字在任意层级匹配目录,含 '/' 的按相对 cwd 锚定。
function ignoreGlobsForRg(opts, allowDirs) {
  const m = buildIgnoreMatcher({ includeIgnored: opts.includeIgnored === true, ignoreDirs: opts.ignoreDirs, allowDirs });
  const globs = [];
  for (const n of m.names) globs.push('!' + n + '/');
  for (const p of m.paths) globs.push('!**/' + p + '/');
  return globs;
}
// rg 带 --hidden 后会进数据根;JS 路径在 walkFiles 里剪掉敏感子树,rg 只能靠 glob 排除(结果层过滤在后面兜底,
// 但不排除的话敏感文件的命中会先占满 maxResults 再被滤掉 → 假阴性)。
// 把非 UTF-8 文件的编码上报挂到结果数组上(file_search 的信封据此给 nonUtf8Files / skippedNonUtf8)。
// encs: [{path, relativePath, enc}];enc = 'gb18030' / 'utf16le' / 'utf16be'(已按该编码解码搜过)或 'lossy'(既非 UTF-8 也非 GBK,只能按 U+FFFD 宽松解码)。
function applyNonUtf8Report(target, encs) {
  const list = Array.isArray(encs) ? encs : [];
  const decoded = list.filter(e => e.enc !== 'lossy');
  const lossy = list.filter(e => e.enc === 'lossy');
  if (decoded.length) { target.nonUtf8Files = decoded.slice(0, 20).map(e => ({ relativePath: e.relativePath, encoding: e.enc })); target.nonUtf8Count = decoded.length; }
  if (lossy.length) { target.skippedNonUtf8 = lossy.slice(0, 20).map(e => e.relativePath); target.skippedNonUtf8Count = lossy.length; }
}
// 模式里有没有可能命中非 ASCII 字符:有 → GBK 文件里的中文只能靠补扫才搜得到(rg 把它们当字节串,UTF-8 的中文模式永远配不上)。
function patternMayMatchNonAscii(pattern) {
  const p = String(pattern == null ? '' : pattern);
  return /[^\x00-\x7f]/.test(p) || /\\(?:x\{|u|[pP]\{|[wWSD])/.test(p);
}
// A fallback may start only after the supervised rg execution has completed its cleanup.
async function runRgOwned(command, argv, cwd, timeoutMs, maxBuffer, signal,
  owner = { ...ProcessRuntime.currentOwner(), kind: 'file-search' }) {
  const failure = (code, cleanup) => Object.assign(new Error('Search execution could not complete safely'), {
    code, searchExecutionFailure: true, cleanupScope: cleanup?.scope,
    cleanupIncomplete: cleanup?.incomplete === true, cleanupEscapeCoverage: cleanup?.escapeCoverage,
    cleanupUnconfirmed: cleanup?.unconfirmed,
  });
  if (signal?.aborted) throw failure('aborted');
  let capture;
  try {
    capture = await ProcessRuntime.capture(command, argv, { signal, cwd, maxBuffer, encoding: 'utf8' },
      owner);
  } catch { return null; } // No child was started, so JS fallback is safe.
  const { child } = capture;
  let stopping = false, resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  const stop = async code => {
    if (stopping) return;
    stopping = true;
    let cleanup = { scope: 'unknown', incomplete: true };
    try { ProcessRuntime.stopChild(child); cleanup = await ProcessRuntime.waitForCleanup(child, 1500); }
    catch { /* preserve uncertainty */ }
    finally {
      child.stdout.destroy(); child.stderr.destroy();
      resolveStopped({ error: Object.assign(new Error('Search interrupted'), { code }), cleanup });
    }
  };
  const abort = () => { void stop('aborted'); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { void stop('ETIMEDOUT'); }, timeoutMs);
  if (signal?.aborted) abort();
  try {
    let result = await Promise.race([capture.output.then(async output => ({ ...output,
      cleanup: await ProcessRuntime.waitForCleanup(child, 1500) })), stopped]);
    if (stopping) result = await stopped;
    if (result.cleanup?.incomplete) throw failure('process_cleanup_incomplete', result.cleanup);
    if (signal?.aborted) throw failure('aborted', result.cleanup);
    if (result.error?.code === 'ERR_PROCESS_OUTPUT_INCOMPLETE') throw failure('process_output_incomplete', result.cleanup);
    if (result.error && result.error.code !== 1) return null;
    return { stdout: result.stdout, code: result.error ? 1 : 0 };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

// rg -l:列出含 0x80 以上字节的文件(UTF-8 中文文件与 GBK 文件都在内;纯 ASCII 文件不在)。参数用与主搜索相同的 filt。
function rgListHighByteFiles(rg, base, filt, timeoutMs, signal) {
  return runRgOwned(rg, ['--no-messages', '-l', '--crlf', ...filt, '--', '(?-u)[\\x80-\\xFF]', base], base, timeoutMs, 8_000_000, signal)
    .then(result => result ? result.stdout.split(/\r?\n/).filter(Boolean) : null);
}
const RG_REPAIR_MAX_FILES = 3000;
async function rgRepairNonUtf8(c) {
  const { rg, base, filt, pattern, opts, results, suspectPaths, maxResults } = c;
  const files = new Map();
  for (const f of suspectPaths) files.set(f, path.relative(base, f) || '.');
  if (patternMayMatchNonAscii(pattern)) {
    const listed = await rgListHighByteFiles(rg, base, filt, 8000, opts.signal);
    for (const line of listed || []) { const full = path.resolve(base, line); if (!files.has(full)) files.set(full, path.relative(base, full) || '.'); }
  }
  if (!files.size) return null;
  const list = [...files.entries()].slice(0, RG_REPAIR_MAX_FILES).map(([p, r]) => ({ path: p, relativePath: r }));
  const flags = (opts.ignoreCase === false ? 'g' : 'gi') + (opts.extraFlags || '');
  const scan = await regexScanFilesBounded(list, pattern, flags, { ...opts, maxResults: maxResults + 1, onlyNonUtf8: true, regexTimeoutMs: 6000 });
  assertSearchExecution(opts.signal, scan);
  if (scan.error) return null;
  const decoded = new Set(scan.encs.filter(e => e.enc !== 'lossy').map(e => e.path));
  if (!decoded.size && !scan.encs.length) return null;
  const merged = results.filter(r => !decoded.has(r.path)).concat(scan.results);
  const more = merged.length > maxResults;
  if (more) merged.length = maxResults;
  return { results: merged, moreMatches: more, encs: scan.encs };
}

// rg --json emits NDJSON: one JSON object per line. We care about type:'match' events. The matched
// line text lives at data.lines.text, OR (for non-UTF8 content) at data.lines.bytes as base64 — both
// branches handled. Context lines arrive as type:'context' events between matches (rg -C N). We map
// everything back to the identical JS-path record shape (absolute path + relativePath + line + text
// [+ context]). Bounded by a 10s timeout; on non-zero-with-no-output / spawn error we return null so
// the caller falls back to the JS scanner.
async function searchFileContentRg(root, pattern, opts = {}) {
  const rg = probeRg();
  const base = path.resolve(root || process.cwd());
  const ctx = Math.max(0, Math.min(5, Number(opts.context || 0) || 0));
  const maxResults = Number(opts.maxResults || 200);
  // 与 JS 引擎同一口径:跳二进制、默认不搜隐藏(.ssh/.aws/.env …,includeHidden:true 才搜;glob 字面点名的隐藏段例外)、
  // 目录忽略靠共用清单。rg 额外遵守 .gitignore(仅在 git 仓库内生效,rg 的默认行为),includeIgnored:true 或调用方
  // 显式点名了默认清单里的目录(dist/**)时才 --no-ignore —— 否则 gitignore 会把点名的 dist 又吞掉。
  const names = searchExplicitNames(base, opts);
  // --crlf:CRLF 文件里 `$` 也锚在 \r 之前(修前 `hello$` / `^b$` 在 Windows 换行的文件里一条都配不上,
  // 而空结果被当成「确实没有」)。
  // filt = 决定「搜哪些文件」的那部分参数(隐藏/忽略/glob/体积/深度);非 UTF-8 文件的补扫(rgRepairNonUtf8)用同一份,保证范围一致。
  const args = ['--json', '--no-messages', '--crlf'];
  const filt = [];
  if (opts.includeHidden === true || names.allowHidden.length) filt.push('--hidden');
  const defaultNames = new Set(DEFAULT_IGNORE_DIRS.filter(x => !x.includes('/')).map(x => (x)));
  const namedIgnored = names.allowDirs.some(x => defaultNames.has(String(x)));
  if (opts.includeIgnored === true || namedIgnored) filt.push('--no-ignore');
  if (opts.ignoreCase !== false) args.push('-i');
  if (ctx > 0) { args.push('-C', String(ctx)); }
  // Mac path exclusions and caller globs both retain case-sensitive matching.
  const exclFlag = '-g';
  if (opts.glob) { filt.push('-g', String(opts.glob)); }
  for (const g of ignoreGlobsForRg(opts, names.allowDirs)) filt.push(exclFlag, g);
  for (const g of sensitiveGlobsForRg(base)) filt.push(exclFlag, g);
  filt.push('--max-filesize', String(searchMaxFileBytes(opts)));
  // 深度:调用方没传就不限(见 searchMaxDepth);传了按路径段 +1 与 JS 对齐。
  const depthCap = searchMaxDepth(opts);
  if (depthCap) filt.push('--max-depth', String(depthCap + 1));
  args.push(...filt, '--', String(pattern), base);
  let stdout = '';
    const parseOutput = async code => {
      // rg exit 1 = no matches (valid: empty result). exit 2 = error → fall back.
      if (code === 2 && !stdout) return null;
      const results = [];
      const suspectPaths = new Set();   // 命中行不是合法 UTF-8(rg 给的是 bytes 而非 text)的文件 —— 多半是 GBK
      let sweepEncs = null;
      // rg -C N emits `context` events BOTH before and after each `match` (interleaved per file). We
      // buffer leading context in pendingCtx; a context event within `ctx` lines AFTER the last match is
      // appended to that match's block (trailing context). Blocks are then sorted by line to match the
      // contiguous JS-path window shape. Known shape difference: when two matches sit close together,
      // context lines in the overlapping window are attributed to the PREVIOUS match (rg emits each
      // shared line once), whereas the JS path gives every match its full ±ctx window — an acceptable
      // display-level difference.
      let pendingCtx = [];
      let moreMatches = false;   // 上限之后还见到了命中 → 才算「还有更多」
      let lastMatch = null; // most recent match record (for trailing-context attachment)
      const rel = full => path.relative(base, full) || '.';
      const decode = data => {
        if (!data || !data.lines) return '';
        if (typeof data.lines.text === 'string') return data.lines.text.replace(/\r?\n$/, '');
        if (data.lines.bytes) { try { return Buffer.from(data.lines.bytes, 'base64').toString('utf8').replace(/\r?\n$/, ''); } catch { return ''; } }
        return '';
      };
      const lineIsBytes = data => !!(data && data.lines && typeof data.lines.text !== 'string' && data.lines.bytes);
      const finalizeBlock = rec => { if (rec && rec.context) rec.context.sort((a, b) => a.line - b.line); };
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (!ev || !ev.type) continue;
        if (ev.type === 'begin') { finalizeBlock(lastMatch); pendingCtx = []; lastMatch = null; continue; }
        if (ev.type === 'end') { finalizeBlock(lastMatch); lastMatch = null; continue; }
        if (ev.type === 'context' && ctx > 0) {
          const d = ev.data || {};
          const lineNo = Number(d.line_number || 0);
          const entry = { line: lineNo, text: decode(d).slice(0, 500), match: false };
          // Trailing context for the last match (same file, within ctx lines after it) → attach there.
          if (lastMatch && lastMatch.context && lineNo > lastMatch.line && lineNo <= lastMatch.line + ctx) {
            lastMatch.context.push(entry);
          } else {
            pendingCtx.push(entry);
          }
          continue;
        }
        if (ev.type === 'match') {
          if (results.length >= maxResults) { moreMatches = true; break; }
          finalizeBlock(lastMatch);
          const d = ev.data || {};
          const full = d.path && d.path.text ? path.resolve(base, d.path.text) : base;
          const lineNo = Number(d.line_number || 0);
          const text = decode(d).slice(0, 500);
          if (lineIsBytes(d)) suspectPaths.add(full);
          const rec = { path: full, relativePath: rel(full), line: lineNo, text };
          if (ctx > 0) {
            rec.context = [...pendingCtx.map(c => ({ ...c })), { line: lineNo, text, match: true }];
            pendingCtx = [];
          }
          results.push(rec);
          lastMatch = rec;
        }
      }
      finalizeBlock(lastMatch);
      // 2026-10 走查(R2):非 UTF-8(GBK / UTF-16 无 BOM 以外的本地编码)文件 rg 看不懂 —— 中文搜不到、ASCII 命中行里的中文显示成乱码。
      // 补扫:这类文件交给 JS 引擎的解码路径(与 file_read 同一口径)重搜,用它的命中替换 rg 对这些文件给的(乱码)命中,
      // 并把「哪些文件按什么编码解的」报给调用方(nonUtf8Files);既非 UTF-8 也非 GBK 的列进 skippedNonUtf8。补扫失败不影响 rg 原结果。
      let finalResults = results;
      try {
        const rep = await rgRepairNonUtf8({ rg, base, filt, pattern, opts, results, suspectPaths, maxResults });
        if (rep) { finalResults = rep.results; if (rep.moreMatches) moreMatches = true; sweepEncs = rep.encs; }
      } catch (error) { if (error.searchExecutionFailure) throw error; /* other repair failures keep rg results */ }
      const grouped = maybeGroup(finalResults, opts.group);
      grouped.engine = 'rg';
      if (moreMatches) grouped.moreMatches = true;
      if (sweepEncs) applyNonUtf8Report(grouped, sweepEncs);
      grouped.maxFileBytes = searchMaxFileBytes(opts);
      return grouped;
    };
  const result = await runRgOwned(rg, args, base, Number(opts.rgTimeoutMs || 10000), 32_000_000, opts.signal);
  if (!result) return null;
  stdout = result.stdout;
  return parseOutput(result.code);
}


return { searchFileContent, regexScanFilesBounded, searchMaxFileBytes, explicitAllowDirs, prunedDirsHint, runRgOwned, searchFileContentJs, searchFileContentRg };
}
module.exports = { createContentSearch };
