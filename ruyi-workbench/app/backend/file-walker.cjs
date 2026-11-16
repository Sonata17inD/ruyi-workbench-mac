'use strict';
const path = require('node:path');
const fsp = require('node:fs/promises');
const { buildIgnoreMatcher, DOTNET_PROJECT_RE } = require('./path-patterns.cjs');
const { WALK_PATTERN_MAX_CHARS, WALK_PATTERN_BUDGET_MS, WALK_PATTERN_BATCH, regexBacktrackBounded, createBoundedPathMatcher, assertSearchExecution } = require('./search-workers.cjs');
function createFileWalker({ ensureDataRootReal, isSensitiveDataPath, isSensitiveHardlinkAlias, pathWithinRoot, realpathForContainment, sensitiveFileIdentities }) {
async function walkFiles(root, opts = {}) {
  assertSearchExecution(opts.signal);
  const base = path.resolve(root || process.cwd());
  // ≤0 / 非数字按「没传」取默认 500(修前 maxFiles:0 或 -1 被抬成 1:返回一条 + truncated,模型以为目录里只有一个文件);
  // Infinity 仍放行(内部调用方用)。
  const maxFilesReq = Number(opts.maxFiles);
  const maxFiles = opts.maxFiles != null && !Number.isNaN(maxFilesReq) && maxFilesReq >= 1 ? maxFilesReq : 500;
  const recursive = opts.recursive !== false;
  const maxDepth = Number(opts.maxDepth != null ? opts.maxDepth : 8);
  const emitDirs = opts.emitDirs !== false;
  const accept = typeof opts.accept === 'function' ? opts.accept : null;
  const maxVisited = Math.max(1, Number(opts.maxVisited) || 300000);
  const patternSrc = opts.pattern ? String(opts.pattern) : '';
  const patternFlags = opts.ignoreCase === false ? '' : 'i';
  if (patternSrc.length > WALK_PATTERN_MAX_CHARS) throw new Error(`pattern too long (max ${WALK_PATTERN_MAX_CHARS} characters)`);
  const pattern = patternSrc ? new RegExp(patternSrc, patternFlags) : null;   // 语法错照旧在这里抛
  // 回溯可能失控的模式交给 worker(见上方 WALK_PATTERN_* 头注);deferred 按遍历顺序攒待匹配项。
  let matcher = null;
  let deferred = [];
  let patternTimedOut = false;
  const ignore = buildIgnoreMatcher(opts);
  const foldName = n => (String(n));
  const skipHidden = opts.skipHidden === true;
  const allowHidden = new Set((Array.isArray(opts.allowHidden) ? opts.allowHidden : []).map(foldName));
  const toSlash = r => (path.sep === '/' ? r : r.split(path.sep).join('/'));
  const pruned = new Set();
  const out = [];
  // 审计 P1(对抗轮补漏): 遍历类工具(file_list/glob,以及经 searchFileContentJs 的 file_search)会递归进 dataRoot,
  // 而 guardFileToolPath 只校验 root 参数、不校验被遍历文件 —— 当某允许根是 dataRoot 的祖先(默认: home 工作区 ⊇
  // home/.ruyi-workbench)时,config.json/sessions/token 配置的内容仍被搜出返回。这里在遍历处逐项跳过敏感子树
  // (既不入结果也不下钻)。ensureDataRootReal 已在上游 guardFileToolPath(root) 预热,此处 sync 判定即可。
  await ensureDataRootReal();
  // 安全走查 S7:config.json / runtime.json 的硬链接别名(同 inode 不同名)按 dev+ino 挡在 emit 处 —— 那里本来就要 stat 文件,
  // nlink>1 的才多一次 bigint stat 比对;遍历到却不入结果的文件不付这个成本。ids 每次遍历现取一次(两个 stat)。
  const sensitiveIds = await sensitiveFileIdentities();
  // 指向遍历根之外的符号链接/联接不返回:guardFileToolPath 只判了 root,修前 ws/link.md -> /outside/secret.md 被当成
  // 普通文件列出来,docs_search / codebase_symbol_search / code_review_scan 接着就把区外文件的内容读出来了
  // (file_read 读同一个链接是 not-allowed)。只对链接条目多做一次 realpath,普通文件不受影响。
  const baseReal = await realpathForContainment(base);
  let skippedLinks = 0;
  const depthExamples = [];   // 到 maxDepth 不再下钻、且里面非空的目录(最多 5 个例子)
  let depthProbes = 0;
  let hitCap = false;  // 审计 P2 对抗修正:用 hitCap 标志而非 out.length>=maxFiles 事后判断,避免"正好 maxFiles 个文件"误判 truncated
  let reason = '';
  let stopped = false;
  let visited = 0;
  const emit = async (full, rel, isDir) => {
    assertSearchExecution(opts.signal);
    // 目录不需要 stat(size 恒记 0;信封里目录不带 size);文件要 size,glob 还要 mtime。
    const stat = isDir ? null : await fsp.stat(full).catch(() => null);
    assertSearchExecution(opts.signal);
    if (stat && sensitiveIds.size && stat.nlink > 1 && await isSensitiveHardlinkAlias(full, sensitiveIds)) return;
    const rec = { path: full, relativePath: rel, type: isDir ? 'directory' : 'file', size: stat?.size || 0 };
    if (stat) rec.mtimeMs = Math.round(stat.mtimeMs);
    out.push(rec);
  };
  const capped = why => { hitCap = true; if (!reason) reason = why; };
  async function flushDeferred() {
    if (!deferred.length || patternTimedOut) { deferred = []; return; }
    const batch = deferred;
    deferred = [];
    const r = await matcher.match(batch.map(c => toSlash(c.rel)));
    assertSearchExecution(opts.signal, r);
    if (r.timedOut || r.error) patternTimedOut = true;
    let last = -1;
    for (const i of r.hits) {
      if (out.length >= maxFiles) { capped('maxFiles'); break; }
      await emit(batch[i].full, batch[i].rel, batch[i].isDir);
      last = i;
    }
    // 与主线程路径同口径:凑满 maxFiles 之后还见到了别的条目 → 可能不全。
    if (out.length >= maxFiles && last >= 0 && last < batch.length - 1) capped('maxFiles');
  }
  // 待读目录队列:bfs 先进先出;dfs 后进先出(子目录倒序压栈 → 仍按名字顺序下钻)。
  const pending = [{ dir: base, relDir: '', depth: 0, hiddenOk: false }];
  let qi = 0;
  const nextDir = () => (opts.bfs === true ? pending[qi++] : pending.pop());
  const hasDir = () => (opts.bfs === true ? qi < pending.length : pending.length > 0);
  try {
    assertSearchExecution(opts.signal);
    matcher = pattern && !regexBacktrackBounded(patternSrc) ? createBoundedPathMatcher(patternSrc, patternFlags, WALK_PATTERN_BUDGET_MS, opts.signal) : null;
    while (hasDir() && !stopped && !patternTimedOut) {
      assertSearchExecution(opts.signal);
      const { dir, relDir, depth, hiddenOk } = nextDir();
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      // 排序:各平台 readdir 顺序不同(Linux 不定序、NTFS 字典序),截断时「取到哪些」必须可复现。
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const dotnetDir = ignore.dotnet && entries.some(e => !e.isDirectory() && DOTNET_PROJECT_RE.test(e.name));
      const subdirs = [];
      for (const entry of entries) {
        assertSearchExecution(opts.signal);
        if (patternTimedOut) break;
        if (++visited > maxVisited) { capped('maxVisited'); stopped = true; break; }
        let isDir = entry.isDirectory();
        let linkedDir = false;   // 指向目录的符号链接/联接(仅 browse 模式下被认成目录,见下),不能下钻
        const rel = relDir ? relDir + path.sep + entry.name : entry.name;
        let entryHiddenOk = hiddenOk;
        if (skipHidden && !hiddenOk && entry.name.charCodeAt(0) === 46) {
          if (!allowHidden.has(foldName(entry.name))) continue;
          entryHiddenOk = true;
        }
        if (isDir) {
          const relSlash = toSlash(rel);
          if (ignore.pruneName(entry.name, relSlash, dotnetDir)) { if (pruned.size < 12) pruned.add(relSlash); continue; }
        }
        const full = path.join(dir, entry.name);
        if (isSensitiveDataPath(full)) continue; // 敏感控制面文件/目录:不返回、不下钻
        if (entry.isSymbolicLink()) {
          if (!pathWithinRoot(await realpathForContainment(full), baseReal)) { skippedLinks += 1; continue; }
          // browse(file_list 非递归 = 目录浏览)下,指向目录的符号链接/联接(Windows 的 My Documents 之类)Dirent 报的是链接而不是目录,
          // 修前被标成 file,前端点开报「is a directory」。已过上面的包含校验后 stat 一下:是目录就标 directory(也要过一遍剪枝名单)。
          // 只改标记不下钻:递归遍历(browse 为假)不跟随符号链接 —— 防环,链接目标要列就以它为 root 单独列。
          if (opts.browse === true && !isDir) {
            const target = await fsp.stat(full).catch(() => null);
            if (target && target.isDirectory()) {
              isDir = true;
              linkedDir = true;
              const relSlash = toSlash(rel);
              if (ignore.pruneName(entry.name, relSlash, dotnetDir)) { if (pruned.size < 12) pruned.add(relSlash); continue; }
            }
          }
        }
        if ((emitDirs || !isDir) && (!accept || accept(rel, isDir))) {
          if (matcher) {
            deferred.push({ full, rel, isDir });
            if (deferred.length >= WALK_PATTERN_BATCH) await flushDeferred();
            if (out.length >= maxFiles) { stopped = true; if (hasDir() || entry !== entries[entries.length - 1] || deferred.length) hitCap = true; if (hitCap && !reason) reason = 'maxFiles'; break; }
          } else if (!pattern || pattern.test(toSlash(rel))) {
            if (out.length >= maxFiles) { capped('maxFiles'); stopped = true; break; }   // 已满之后又见到一个【命中】才算截断
            await emit(full, rel, isDir);
          }
        }
        if (recursive && isDir && !linkedDir && depth < maxDepth) subdirs.push({ dir: full, relDir: rel, depth: depth + 1, hiddenOk: entryHiddenOk });
        else if (recursive && isDir && !linkedDir) {
          // 2026-10 走查(R2):到了 maxDepth 的目录不再下钻 —— 修前这一刀完全静默,glob/file_list 在 12/8 层之下「什么都没有」,
          // 与「确实没有」无法区分。只在目录【非空】时才算被截(空目录没东西可漏),探查有上限(200 次 readdir),够给几个例子就停。
          if (depthExamples.length < 5 && depthProbes < 200) {
            depthProbes += 1;
            const kids = await fsp.readdir(full).catch(() => []);
            if (kids.length) depthExamples.push(toSlash(rel));
          } else if (depthProbes >= 200 && !depthExamples.length) depthExamples.push('…');
        }
      }
      if (opts.bfs === true) pending.push(...subdirs);
      else for (let k = subdirs.length - 1; k >= 0; k -= 1) pending.push(subdirs[k]);
    }
    if (matcher) await flushDeferred();
  } finally {
    if (matcher) assertSearchExecution(opts.signal, await matcher.close());
  }
  assertSearchExecution(opts.signal);
  if (patternTimedOut) { hitCap = true; if (!reason) reason = 'patternTimeout'; }
  if (hitCap) out.truncated = true;  // 审计 P1:早停需告知调用方(file_list/glob/project_snapshot 消费);hitCap 防个数恰等时的误判
  if (reason) out.truncatedReason = reason;
  if (patternTimedOut) out.patternTimedOut = true;   // 审计 F 后续:模式撞了时间预算(file_list 据此给 patternNote)
  out.visited = visited;
  if (pruned.size) out.prunedDirs = [...pruned];
  if (skippedLinks) out.skippedLinks = skippedLinks;
  if (depthExamples.length) { out.depthLimited = true; out.depthCutDirs = depthExamples; out.maxDepthUsed = maxDepth; }
  return out;
}
// 深度截断的提示语(file_list / glob / project_snapshot 共用):截了就说,并说怎么放开。
function walkDepthHint(files, tool) {
  const eg = (files.depthCutDirs || []).slice(0, 3).join(', ');
  return `${tool}: directories at depth ${files.maxDepthUsed} were not entered (e.g. ${eg}); results below that depth are missing - pass a larger maxDepth to include them`;
}

// F12:file_list / glob / project_snapshot 的信封。每条只带相对路径(root 在顶层只出现一次,模型自己拼);
// 修前每条同时带绝对 path 与 relativePath,默认 500 条约 100KB,自己就超过 60K 的模型侧上限被拦腰截断。
// 目录不带 size(恒为 0 的噪声)。absolute:true 才补回绝对 path(前端文件树用)。
function walkEnvelopeEntries(files, absolute, extra) {
  return files.map(f => {
    const e = { relativePath: f.relativePath };
    if (absolute) e.path = f.path;
    e.type = f.type;
    if (f.type !== 'directory') e.size = f.size;
    if (extra) Object.assign(e, extra(f));
    return e;
  });
}
// 截断必须说出来 + 说怎么办(F2):调用方把 truncated:true 与这句 hint 一起放进结果。
function walkTruncationHint(files, tool) {
  const why = files && files.truncatedReason;
  if (why === 'maxVisited') return `${tool}: directory tree too large (stopped after ${files.visited} entries); pass a narrower root, or a more specific pattern`;
  if (why === 'patternTimeout') return `${tool}: pattern matching hit its time budget; simplify the pattern or narrow root`;
  return `${tool}: result capped at maxFiles; narrow root/pattern, lower maxDepth, or raise maxFiles`;
}
// F13:file_list.pattern 是正则(对相对路径、默认不区分大小写)。模型常把它当 glob 写(`*.js`、`**/*.ts`)—— 修前直接抛
// 「Nothing to repeat」的原始 SyntaxError。这里:含 `*` 又不含任何正则专属字符 → 按 glob 处理(无 '/' 的按文件名任意层级匹配,
// 与 glob 工具的 `**/` 前缀写法一致);既不像 glob 又编译不过 → 给 bad_pattern + 人话 hint。

return { walkFiles, walkDepthHint, walkEnvelopeEntries, walkTruncationHint };
}
module.exports = { createFileWalker };
