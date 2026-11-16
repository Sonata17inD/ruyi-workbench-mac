'use strict';
const path = require('node:path');
const { ZIP_MAX_ENTRIES, ZIP_MAX_TOTAL, zipReadCentralDir, zipReadEntryDataAsync, zipWriteAsync } = require('./archive-codec.cjs');
const fsp = require('node:fs/promises');
const { FileTextIo } = require('./file-text-io.cjs');
const { UTF8_BOM_BYTES, accAnnotateNonAscii, accCpName, buildNonAsciiReport, defaultTextLineEnding, detectTextLineEnding, hasTextLineBreak, normalizeTextLineEndings, textFileWantsUtf8Bom } = require('./file-text-format.cjs');

function fileMoveSameFileKind(from, to, fromSt, toSt, platform) {
  if (!toSt || !fromSt) return null;
  if (from === to) return 'identical';
  const plat = platform || process.platform;
  if (plat !== 'darwin') return null;   // 其余平台默认大小写敏感:大小写不同就是两个文件(同 ino = 硬链接,别当改名)
  const sameStat = fromSt.dev === toSt.dev && fromSt.ino !== undefined && Number(fromSt.ino) !== 0 && fromSt.ino === toSt.ino;
  return sameStat && String(from).toLowerCase() === String(to).toLowerCase() ? 'case-only' : null;
}

// File and archive execution owns its cache; policy, journals and native services are explicit ports.
function createFileTools({ paths, checkpoints, source, search, archive, runtime, mutations }) {
  const { fileToolWorkspaceDir, resolveFileToolPath, resolveFileToolRoot, guardFileToolPath, pathWithinRoot, isSensitiveDataPath, isSensitiveHardlinkAlias, sensitiveFileIdentities } = paths;
  const { JOURNAL_MAX_BEFORE_BYTES, journalCheckpointWarn, journalDropEntries, journalRecord, journalRecordMany, journalSessionCtx } = checkpoints;
  const { FileVisualIo, MediaInspection, NativeSourceHooks, PrivacyGateway, READ_PAGE_JSON_BUDGET, binaryReadHint, isBinaryReadPath, privacyReadTextWindow, privacySourceActive, privacySourceLine, privacySourceLineOffsets, privacySourceMark, privacySourceViews } = source;
  const { assertSearchExecution, classifyListPattern, explicitAllowDirs, explicitSegmentsOfGlob, explicitSegmentsOfRegex, globToRegExp, normalizeGlobPatternForRoot, prunedDirsHint, searchFileContent, walkDepthHint, walkEnvelopeEntries, walkFiles, walkTruncationHint, levenshtein } = search;
  const { zipCollectEntries } = archive;
  const { execResultCacheEnabled, execResultCacheMaxEntries, externalRoot, logEvent, readConfig, toolCall } = runtime;
  const { fileToolWriteLockKey, withFileToolWriteLock } = mutations;
const FileReadCache = require('./file-read-cache.cjs').createFileReadCache({ execResultCacheEnabled, execResultCacheMaxEntries, logEvent });

// ── 单文件工具(file_read/file_write/file_edit/file_delete/file_move/file_copy/data_profile)的共用助手 ──────────────
// F1:相对路径按【会话工作区】解析(链与 resolveFileToolRoot 同一条:ctx.workingDir > 会话 cwd > MCP 会话 > 默认工作区),
// 不再落到服务进程的 process.cwd()(安装目录/启动目录)。此前 file_read('notes.txt') 会被「工作区外」拒绝并报一个根本不存在的
// 路径;开了「允许工作区外读写」或本机模型时更糟 —— 相对路径的写入静默落进服务的启动目录并回 ok:true。
// 绝对路径原样规范化(与旧行为一致);报错里的 path 一律是【解析后的绝对路径】。

function fileToolNotFound(p, raw) {
  const rel = raw != null && !path.isAbsolute(String(raw));
  return { ok: false, code: 'not_found', error: '文件不存在', path: p,
    hint: '文件不存在;先用 glob 或 file_list 确认路径' + (rel ? `(传入的是相对路径,已按工作区解析为 ${p})` : '') };
}
function assertFileToolActive(ctx) {
  if (ctx && ctx.signal && ctx.signal.aborted) {
    throw Object.assign(new Error('File operation cancelled before commit'), { code: 'ABORT_ERR' });
  }
}
function fileToolCleanupFields(result) {
  if (!result || !result.cleanupIncomplete) return {};
  return { cleanupIncomplete: true, cleanupPath: result.cleanupPath, cleanupError: result.cleanupError,
    cleanupWarning: '临时文件清理失败；请检查 cleanupPath 所指文件并在确认后清理' };
}
// Preserve the operation's outcome while exposing any uncertain target or temporary state.
function fileToolFsFailure(e, p, extra) {
  const env = FileTextIo.fsErrorEnvelope(e, p) || (e && (e.targetMayBeModified || e.cleanupIncomplete)
    ? { ok: false, code: 'write_failed', path: p, errno: e.code, error: String(e.message || e) } : null);
  return env ? { ...env, ...(extra || {}), ...fileToolCleanupFields(e),
    ...(e && e.targetMayBeModified ? { targetMayBeModified: true,
      hint: '文件可能已被部分写入；请检查文件，并使用可用的写入前检查点恢复' } : {}) } : null;
}
// F4:file_read 的体积预算。模型侧(10 truncateToolResult)对序列化后 > TOOL_RESULT_CAP(60000)的 file_read 结果只留
// 头 40000 + 尾 8000,中间静默丢掉而工具自己还回 truncated:false。这里让【内容序列化后】≤ 预算(给信封/non_ascii 留 8K),
// 于是模型看到的就是工具返回的全部,截断时给 nextOffset/nextLine 让它接着读。默认 40000 字符(中文/代码序列化后一般 <50K)。
const FILE_EDIT_MAX_BYTES = 50 * 1024 * 1024;   // file_edit 整文件进内存的体积上限(先 stat 判,不先读)
const FILE_READ_CHAR_DEFAULT = 40000;
const FILE_READ_CHAR_MAX = 50000;
const FILE_READ_LINE_DEFAULT = 2000;
const FILE_READ_JSON_BUDGET = READ_PAGE_JSON_BUDGET;
// 检查点「改前内容」:超过日志上限的不读进内存(只给一个 skippedBytes 标记,journalRecord 会如实记成 skipped)。
async function fileToolBeforeForCheckpoint(p, size) {
  if (size > JOURNAL_MAX_BEFORE_BYTES) return { skippedBytes: size };
  return fsp.readFile(p);
}
// 写失败后撤掉刚记的检查点条目(它描述的是一次没发生的写入,否则之后撤回会去「还原」一个没被改过的文件)。
async function fileToolDropPhantom(jctx, tool, p, jr) {
  const seqs = jr && Number.isFinite(jr.entrySeq) ? [jr.entrySeq] : [];
  if (!seqs.length) return { ok: true, dropped: 0 };
  return journalDropEntries(jctx.sessionId, jctx.turnSeq, tool, [p], seqs).catch(() => ({ ok: false }));
}
// file_edit 编码类拒绝(not_utf8 / not_roundtrip)的指路。以前写「可用 shell_run 按原编码读写」—— 模型会直接 Get-Content /
// Set-Content,而 Windows PowerShell 5.1 对无 BOM 文件按【系统 ANSI 代码页】读写:中文系统恰好是 GBK 勉强能用,非中文代码页
// (en-US 的 1252)的机器上把 GBK 文件读成乱码、写回时再损坏一次。所以给可靠配方:优先 file_read / file_write(自动识别编码,
// 或显式 encoding 参数);确需 PowerShell 时一律显式指定编码的 .NET 静态方法,不依赖任何默认编码。
const FILE_EDIT_ENCODING_TIP = '需要脚本处理时使用 Python 的显式 encoding（如 gb18030、utf-16le），保留 BOM 与换行格式；要求其余字节完全不变时按二进制处理，不能依赖系统默认编码。';
const FILE_EDIT_ENCODING_HINT_UNDECODABLE = '先确认文件编码:file_read 的 encoding 参数可按 utf-16le / utf-16be / gbk / latin1 指定编码来读(省略则自动识别);'
  + '要改内容就用 file_write 带同一 encoding 整体写回,或征得用户同意后整体转存为 UTF-8(file_write 传 encoding:"utf8")。' + FILE_EDIT_ENCODING_TIP;
const FILE_EDIT_ENCODING_HINT_NOT_ROUNDTRIP = '这类文件按文本替换无法保证其余字节不变。先用 file_read(自动识别编码)看内容;'
  + '要改就征得用户同意后整体转存为 UTF-8(file_write 传 encoding:"utf8")。必须保留原编码的,' + FILE_EDIT_ENCODING_TIP;
function fileToolUnencodable(e, p, encoding, what) {
  const hint = `${what}含有 ${encoding} 无法表示的字符 ${JSON.stringify(e.char)};文件未被改动。如确需写入该字符,请显式传 encoding:"utf8" 把文件转存为 UTF-8(先征得用户同意),或换用 ${encoding} 能表示的字符`;
  return { ok: false, code: 'unencodable', error: e.message, path: p, encoding, hint };
}
// F6:file_edit 未命中。按「空白差异 > 整段 oldText 的最接近窗口」给出可操作的诊断。
function buildFileEditMiss(p, raw, oldText, sourceLineEnding, sourceView = null, oldView = null) {
  const fileLines = raw.split(/\r?\n/);
  const oldLines = oldText.split(/\r?\n/);
  const sourceOffsets = sourceView ? privacySourceLineOffsets(raw) : null;
  const needle = oldLines[0] || '';
  const MAX_CLOSEST_SCAN_LINES = 20000;
  // ① 只差空白?(制表符↔空格、行尾空白、NBSP/全角空格、行内空白个数)—— 最常见也最能一句话说清的一类。
  const ws = FileTextIo.findWhitespaceMatch(fileLines, oldLines, 50000);
  // ② 整段 oldText 的最接近窗口(此前只拿第一行做 Levenshtein,首行一致时 distance:0 什么也说明不了)。
  const win = FileTextIo.closestWindow(fileLines, oldLines, MAX_CLOSEST_SCAN_LINES, levenshtein);
  let closest = null;
  if (win) {
    const from = Math.max(0, win.start - 3);
    const realLen = fileLines.length > 1 && fileLines[fileLines.length - 1] === '' ? fileLines.length - 1 : fileLines.length;   // 不把末尾换行之后的空串当成一行
    const to = Math.min(realLen, win.start + Math.min(oldLines.length, 30) + 3);
    let distance = win.anchorDistance;
    if (distance === undefined) {
      const mm = win.mismatch;
      distance = mm && mm.oldTextLine ? levenshtein(oldLines[mm.oldTextLine - 1], fileLines[mm.line - 1] || '') : 0;
    }
    closest = {
      line: win.start + 1,
      distance,
      snippet: fileLines.slice(from, to).map((t, k) => `${from + k + 1}\t${FileTextIo.showWs(sourceView ? privacySourceLine(sourceView, raw, sourceOffsets, from + k + 1, 500) : t.slice(0, 500))}`).join('\n'),
      scannedLines: Math.min(fileLines.length, MAX_CLOSEST_SCAN_LINES),
      ...(oldLines.length > 1 ? { matchedLines: win.matched, oldTextLines: oldLines.length } : {}),
    };
  }
  // v2.6: explicit diagnostics — lookalike traps + first differing character (mirrors ACC edit_file).
  const hints = [];
  const rawHasCrlf = raw.includes('\r\n');
  const oldHasCrlf = oldText.includes('\r\n');
  if (sourceLineEnding === 'mixed') hints.push('文件混用了 CRLF/LF；为避免猜测性替换，未自动转换 oldText。请先统一换行或提供逐字节一致的 oldText');
  else if (oldHasCrlf && !rawHasCrlf) hints.push('oldText 用 CRLF 换行，文件是 LF；请用 LF 版 oldText 或先 file_read 复制原文');
  else if (!oldHasCrlf && rawHasCrlf && !oldText.includes('\r')) hints.push('文件在磁盘上是 CRLF 换行——oldText 用 LF 无法命中,请从 file_read 复制含 \\r\\n 的原文');
  if (oldText.normalize('NFC') !== oldText) hints.push('oldText 含组合字符(NFD 形式),文件可能是预组合 NFC');
  for (const ch of oldText) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xFF01 && cp <= 0xFF5E) { hints.push(sourceView ? 'oldText 含全角字符,文件里可能是半角' : 'oldText 含全角字符 ' + accCpName(ch) + ',文件里可能是半角'); break; }
  }
  const nonAsciiOld = [...oldText].filter(c => c.codePointAt(0) > 0x7F);
  if (nonAsciiOld.length) hints.push(sourceView ? 'oldText 含非 ASCII 字符;请核对原文中的空白和形近字符。' : 'oldText 含非 ASCII 字符: ' + nonAsciiOld.slice(0, 8).map(accCpName).join(', ') + '——文件对应位置可能是 ASCII 形近字符(或反之),逐字节必然不匹配');
  // firstDiff: independent two-phase scan (long tokens, then single alnum chars) with per-line
  // sliding-window alignment. NOT derived from closest.best — whole-line Levenshtein distance
  // favours short unrelated lines over the real lookalike line (e.g. 'return x' beats 'x = a → b'
  // when the arrow char is the only diff). Token filter keeps the sweep cheap (line <= 500 chars).
  let firstDiff = null;
  {
    const ned = needle.slice(0, 500);
    // hunt2 #15:曾误写成 /S+/g(只匹配大写字母 S 的连串),长词元一轮从没跑过,总是掉进单字符那轮。
    const longToks = [...new Set(needle.match(/\S+/g) || [])].filter(t => t.length >= 2);
    const singleToks = [...new Set([...needle].filter(c => /[A-Za-z0-9]/.test(c)))];
    const scanLimit2 = Math.min(fileLines.length, MAX_CLOSEST_SCAN_LINES);
    let bestLine = -1, bestOff = -1, bestScore = -1;
    const scan = (toks) => {
      if (!toks.length) return;
      for (let i = 0; i < scanLimit2; i += 1) {
        const line = fileLines[i].slice(0, 500);
        if (!line.trim() || line.length < 2) continue;
        if (!toks.some(t => line.includes(t))) continue;
        if (line.length > 1000) continue;
        const step = Math.max(1, Math.floor(line.length / 200));
        for (let off = 0; off <= Math.max(0, line.length - ned.length); off += step) {
          const seg = line.slice(off, off + ned.length);
          let same = 0;
          for (let k = 0; k < seg.length && k < ned.length; k += 1) if (seg[k] === ned[k]) same += 1;
          const score = same / Math.max(seg.length, ned.length, 1);
          if (score > bestScore) { bestScore = score; bestOff = off; bestLine = i; }
        }
      }
    };
    scan(longToks);
    if (bestLine < 0) scan(singleToks);
    if (bestLine >= 0 && bestScore >= 0.5) {
      const lineText = fileLines[bestLine].slice(0, 500);
      const span = Math.max(ned.length, lineText.length - bestOff);
      for (let k = 0; k < span; k += 1) {
        const a = lineText[bestOff + k];
        const b = ned[k];
        if (a === undefined || b === undefined || a !== b) {
          const privateChar = (view, offset, length) => view && offset >= 0 && offset < length && PrivacyGateway.sliceSource(view, offset, offset + 1).text.includes('[[RUYI_PVT:');
          firstDiff = { line: bestLine + 1, column: bestOff + k + 1,
            fileChar: privateChar(sourceView, (sourceOffsets?.[bestLine] || 0) + bestOff + k, raw.length) ? '[private character]' : accCpName(a === undefined ? null : a),
            wantChar: privateChar(oldView, k, oldText.length) ? '[private character]' : accCpName(b === undefined ? null : b) };
          break;
        }
      }
    }
  }
  const out = { ok: false, code: 'not_found', error: 'oldText was not found', path: p, closest, sourceLineEnding };
  let hint;
  if (ws) {
    out.code = 'whitespace_mismatch';
    const start = sourceOffsets?.[ws.line - 1];
    out.whitespace = { line: ws.line, lineCount: ws.lineCount, kinds: ws.kinds, actualText: sourceView
      ? PrivacyGateway.sliceSource(sourceView, start, Math.min(raw.length, start + Math.min(ws.actualText.length, 4000))).text : ws.actualText.slice(0, 4000) };
    hint = `第 ${ws.line} 行起的文本与 oldText 只有空白不同:${FileTextIo.describeWsKinds(ws.kinds)}。请把 oldText 改成 whitespace.actualText(文件里的原样文本),或先用 file_read 行模式复制原文再改`;
  } else if (closest) {
    const mm = win && win.mismatch;
    hint = `oldText 在文件里没有逐字节命中;最接近的位置在第 ${closest.line} 行`
      + (mm && !sourceView ? `(第 ${mm.line} 行起不同:文件是 ${JSON.stringify(mm.actual)},oldText 是 ${JSON.stringify(mm.expected)})` : '')
      + '。请用 file_read 重新读取该区域(行模式),逐字复制作为 oldText;snippet 里的 → 表示制表符';
    if (mm) out.mismatch = sourceView ? { ...mm,
      actual: mm.actual === null ? null : FileTextIo.showWs(privacySourceLine(sourceView, raw, sourceOffsets, mm.line, 200)),
      expected: oldView ? privacySourceLine(oldView, oldText, privacySourceLineOffsets(oldText), mm.oldTextLine || 1, 200) : mm.expected } : mm;
  } else hint = 'oldText 在文件里没有逐字节命中;请用 file_read 重新读取该区域,逐字复制作为 oldText';
  if (hints.length) out.hints = hints;
  if (firstDiff) out.firstDiff = firstDiff;
  out.hint = hint;
  if (sourceView) privacySourceMark(out, ['/closest/snippet', '/whitespace/actualText', '/mismatch/actual'].filter(pointer => {
    const parts = pointer.slice(1).split('/'); return typeof out[parts[0]]?.[parts[1]] === 'string';
  }), sourceView);
  if (oldView && typeof out.mismatch?.expected === 'string') PrivacyGateway.markSourceView(out, ['/mismatch/expected'], oldView);
  return out;
}

// file_move / file_copy 的「源与目标是不是同一个文件」判定(纯函数,便于单测;不碰盘):
//   'identical' = 解析后路径逐字相同;
//   'case-only' = 只有大小写不同、且 stat 显示是同一个文件(同 dev + 非零 ino)—— 大小写不敏感文件系统(NTFS / macOS 默认)上的改名;
//   null        = 不是同一个文件(含 Linux 上 data.csv 与 DATA.csv 本来就是两个文件、以及硬链接)。
// platform 可注入。Windows 实测未做(云端只有 Linux),判据只用 Node 的 stat 字段与路径字符串。
// Preflight the complete explicit batch before any mutation. Each file then uses the existing
// guarded, locked, journaled primitive. A batch is deliberately not advertised as a transaction.
async function fileToolBatch(operation, args, ctx) {
  const deleting = operation === 'file_delete';
  const inputs = deleting ? (args.paths || [args.path]).map(p => ({ from: p })) : (args.items || [{ from: args.from, to: args.to }]);
  const files = [], directories = [], roots = [], results = [];
  let changedDirectories = 0, entries = 0;
  const fail = (code, error) => { throw Object.assign(new Error(error), { code }); };
  const inside = (a, b) => { const rel = path.relative(a, b); return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
  const check = async (p, write) => { const g = await guardFileToolPath(p, ctx, { tool: operation, write }); if (!g.ok) fail(g.code, g.error); return g.absPath || p; };
  const workspaceRaw = await fileToolWorkspaceDir(ctx);
  const workspace = await fsp.realpath(workspaceRaw).catch(() => workspaceRaw);
  async function visit(from, to, depth) {
    if (++entries > 1000 || depth > 32) fail('batch_limit', 'Batch exceeds 1000 entries or depth 32; split it into smaller batches.');
    const realFrom = await check(from, operation !== 'file_copy');
    if (to) await check(to, true);
    const st = await fsp.lstat(from);
    if (st.isSymbolicLink()) fail('symlink_refused', 'Directory/batch operations do not follow symlinks: ' + from);
    const dest = to ? await fsp.lstat(to).catch(e => { if (e.code !== 'ENOENT') throw e; return null; }) : null;
    if (dest?.isSymbolicLink()) fail('symlink_refused', 'Destination is a symlink: ' + to);
    if (st.isDirectory()) {
      if (!args.recursive) fail('recursive_required', 'Directory operations require recursive:true.');
      if (operation !== 'file_copy' && (inside(realFrom, workspace) || realFrom === path.parse(realFrom).root)) fail('protected_root', 'Refusing to delete/move the workspace root or its ancestors.');
      if (dest && !dest.isDirectory()) fail('target_type_mismatch', 'Destination is not a directory: ' + to);
      directories.push({ from, to });
      for (const entry of await fsp.readdir(from)) await visit(path.join(from, entry), to && path.join(to, entry), depth + 1);
    } else {
      if (!st.isFile()) fail('unsupported_file', 'Only regular files/directories are supported.');
      if (dest && (dest.isDirectory() || !args.overwrite)) fail('target_exists', 'Destination exists; use overwrite:true for files: ' + to);
      files.push({ from, to });
    }
  }
  try {
    if (!inputs.length || inputs.length > 100) fail('invalid_batch', 'Provide 1..100 paths/items.');
    for (const input of inputs) {
      if (!input || !input.from || (!deleting && !input.to)) fail('invalid_batch', 'Every item requires a source and, for copy/move, a destination.');
      const from = await resolveFileToolPath(input.from, ctx), to = deleting ? null : await resolveFileToolPath(input.to, ctx);
      const realFrom = await check(from, operation !== 'file_copy'), realTo = to && await check(to, true);
      const endpoints = [realFrom, realTo].filter(Boolean);
      if (realTo && (inside(realFrom, realTo) || inside(realTo, realFrom))) fail('overlapping_paths', 'Source and destination must not overlap.');
      if (roots.some(p => endpoints.some(q => inside(p, q) || inside(q, p)))) fail('overlapping_paths', 'Batch roots must not overlap.');
      roots.push(...endpoints);
      await visit(from, to, 0);
    }
    for (const dir of directories) if (dir.to) {
      await check(dir.to, true);
      if (!(await fsp.lstat(dir.to).catch(() => null))) { await fsp.mkdir(dir.to, { recursive: true }); changedDirectories++; }
    }
    for (const file of files) {
      // Recheck type immediately before the guarded primitive; reject links introduced since preflight.
      if ((await fsp.lstat(file.from)).isSymbolicLink() || (file.to && (await fsp.lstat(file.to).catch(() => null))?.isSymbolicLink())) fail('symlink_refused', 'A batch path changed into a symlink.');
      const result = await FILE_TOOL_HANDLERS[operation].handler(deleting ? { path: file.from } : { from: file.from, to: file.to, overwrite: args.overwrite }, ctx);
      results.push(result);
      if (!result.ok) return { ok: false, code: 'batch_failed', partial: results.some(r => r.ok) || changedDirectories > 0, results, error: result.error };
    }
    if (operation !== 'file_copy') for (const dir of directories.slice().reverse()) {
      await check(dir.from, true);
      if ((await fsp.lstat(dir.from)).isSymbolicLink()) fail('symlink_refused', 'A source directory changed into a symlink.');
      await fsp.rmdir(dir.from); changedDirectories++;
    }
    return { ok: true, operation, files: results.length, directories: directories.length, results,
      checkpointWarn: results.some(r => !!r.checkpointWarn), checkpointScope: 'File contents only, subject to per-file snapshot limits. Empty directories and directory metadata are not restored.' };
  } catch (error) { return { ok: false, code: error.code || 'batch_failed', error: error.message, partial: results.some(r => r.ok) || changedDirectories > 0, results }; }
}

NativeSourceHooks.readTextWindow = (filePath, st, req) => FileTextIo.readTextWindow(filePath, st, req);
function fileToolPrivacySourceOptions(ctx, tool) {
  if (!privacySourceActive()) return {};
  return { privacyGuard: async target => {
    const gate = await guardFileToolPath(target, ctx, { tool, write: false });
    if (!gate.ok) throw Object.assign(new Error('Privacy source access was refused.'), { code: 'privacy.source_access_denied' });
  } };
}
const FILE_TOOL_HANDLERS = {
  acceptance_report: { paths: 'both', guardNote: '', handler: async (args, ctx) => {
    if (!args.path || !args.title || !Array.isArray(args.checks) || !args.checks.length || args.checks.length > 50) return { ok: false, code: 'invalid_report', error: 'Provide path, title and 1..50 checks.' };
    const checks = [];
    for (const [index, check] of args.checks.entries()) {
      if (!check || !check.label || !['pass', 'fail', 'blocked', 'not_run'].includes(check.status)) return { ok: false, code: 'invalid_report', error: 'Each check needs label and status: pass/fail/blocked/not_run.' };
      const evidence = [];
      if (check.evidence != null && (!Array.isArray(check.evidence) || check.evidence.length > 8)) return { ok: false, code: 'invalid_report', error: 'At most 8 evidence files per check.' };
      for (const item of check.evidence || []) {
        if (typeof item !== 'string' || !item) return { ok: false, code: 'invalid_report', error: 'Evidence must be local file paths.' };
        const p = await resolveFileToolPath(item, ctx);
        const g = await guardFileToolPath(p, ctx, { tool: 'acceptance_report', write: false });
        if (!g.ok) return { ok: false, code: g.code, error: g.error };
        const st = await fsp.stat(p).catch(() => null);
        if (!st?.isFile()) return { ok: false, code: 'evidence_missing', error: 'Evidence file missing: ' + p };
        evidence.push({ path: p, bytes: st.size, modifiedAt: st.mtime.toISOString() });
      }
      checks.push({ id: index + 1, label: String(check.label).slice(0, 240), status: check.status, conclusion: String(check.conclusion || '').slice(0, 2000), evidence });
    }
    const counts = Object.fromEntries(['pass', 'fail', 'blocked', 'not_run'].map(s => [s, checks.filter(c => c.status === s).length]));
    const report = { type: 'ruyi.acceptance-report', version: 1, title: String(args.title).slice(0, 240), createdAt: new Date().toISOString(),
      overall: counts.fail ? 'fail' : counts.blocked || counts.not_run ? 'pending' : 'pass', counts, checks,
      provenance: 'Statuses/conclusions are supplied by the caller, not independently verified. Evidence paths and file metadata were checked at report creation; files may later change.' };
    const output = await toolCall('file_write', { path: args.path, content: JSON.stringify(report, null, 2) + '\n' }, ctx);
    return output.ok ? { ...output, report } : output;
  } },
  media_probe: { paths: null, guardNote: 'Read-only executable/version discovery; no installation or browser launch', handler: async (args, ctx) => MediaInspection.dependencies(args.refresh === true, ctx && ctx.signal) },
  audio_inspect: { paths: 'read', guardNote: '', handler: async (args, ctx) => {
    const p = await resolveFileToolPath(args.path, ctx);
    const guard = await guardFileToolPath(p, ctx, { tool: 'audio_inspect', write: false });
    if (!guard.ok) return { ok: false, code: guard.code, error: guard.error };
    const st = await fsp.stat(guard.path || p).catch(() => null);
    if (!st || !st.isFile()) return { ok: false, code: 'not_found', error: 'Audio source must be an existing local file.' };
    return MediaInspection.inspectAudio(guard.absPath || p, args, ctx && ctx.signal);
  } },
  code_check: { paths: 'read', guardNote: '', handler: async (args, ctx) => {
    const p = await resolveFileToolPath(args.path, ctx);
    const guard = await guardFileToolPath(p, ctx, { tool: 'code_check', write: false });
    if (!guard.ok) return { ok: false, code: guard.code, error: guard.error };
    let content = args.content;
    if (content == null) {
      const source = await toolCall('file_read', { path: p, limit: 50000 }, ctx);
      if (!source.ok) return source;
      if (source.truncated || typeof source.content !== 'string') return { ok: false, code: 'source_too_large', error: 'Supply the complete candidate content (maximum 1 MB) for a syntax check.' };
      content = source.content;
    }
    if (Buffer.byteLength(String(content), 'utf8') > 1048576) return { ok: false, code: 'source_too_large', error: 'Syntax check input is limited to 1 MB.' };
    return { path: p, ...await MediaInspection.checkSyntax(p, String(content), ctx && ctx.signal) };
  } },
  file_read: { paths: "read", guardNote: '', handler: async (args, ctx) => {
      const privacyTextRead = typeof PrivacyGateway !== 'undefined' && !!PrivacyGateway.active();
      const p = await resolveFileToolPath(args.path, ctx);
      { const g = await guardFileToolPath(p, ctx, { tool: 'file_read', write: false }); if (!g.ok) return { ok: false, error: g.error, code: g.code, path: p }; }
      // Native pixels/documents use the same provider image channel as MCP screenshots.
      // Always guard the source before probing bytes or starting a read-only parser.
      let visualKind;
      try {
        visualKind = await FileVisualIo.kind(p);
        // Text-only extraction still paginates/transforms document source and may start
        // an external parser. It is unsupported by the privacy boundary, even without pixels.
        if (privacyTextRead && visualKind) return { ok: false, code: 'privacy.media_not_supported' };
        if (args.as === 'image' && !visualKind) return { ok: false, code: 'not_image', error: 'This file is not an image or supported visual document.', path: p };
        if (args.as === 'image') args = { ...args, includeImages: true };
        if (args.as === 'text' && visualKind === 'image') return { ok: false, code: 'not_text', error: 'Image bytes cannot be read as text; use as:image.', path: p };
        if (args.as === 'text') args = { ...args, includeImages: false };
        if (visualKind) {
          const result = visualKind === 'image' ? await FileVisualIo.image(p, args) : null;
          if (result) return result;
          return await FileVisualIo.document(p, args, path.join(externalRoot(), 'resources', 'native-file-read.py'), ctx && ctx.signal);
        }
      } catch (e) {
        if (e && e.code === 'ENOENT') return fileToolNotFound(p, args.path);
        const f = fileToolFsFailure(e, p); if (f) return f;
        return { ok: false, code: e.code || 'file_read_failed', error: e.message, path: p,
          ...(e.code === 'file_too_large' ? { hint: 'Image input is limited to 4MB per image. Resize/compress a copy, then file_read the smaller image; no desktop tool is required.' } : {}) };
      }
      if (isBinaryReadPath(p)) {
        return { ok: false, code: 'binary', error: 'binary or image file', path: p, hint: binaryReadHint(p) };
      }
      // 106 #2a: 权限守卫之后、读盘之前的缓存查找 —— 命中即返回(带 cacheHit 标记),未命中
      // 走原路径并在成功结果上存储。cctx 为 null(开关关/非白名单/无会话)时零额外开销。
      // Linked images have independent versions/permissions; never serve a parent-only cache hit.
      // Off-mode entries may contain truncated text or diagnostic source copies. Never reuse
      // or store those view objects inside a privacy scope, even for a complete character read.
      const cctx = privacyTextRead || args.includeImages === true ? null : FileReadCache.context('file_read', args, ctx, p);
      if (cctx) {
        const hit = await FileReadCache.lookup(cctx);
        if (hit) return hit;
      }
      // F3:encoding 可显式指定(utf8 / utf-16le / utf-16be / gbk / latin1);缺省按内容判 BOM -> 严格 UTF-8 -> GB18030,
      // 结果里如实报 encoding。此前一律按 utf8 解,GBK/UTF-16 文件变成乱码还回 ok:true。
      const encReq = FileTextIo.normalizeEncodingName(args.encoding);
      if (encReq.bad) return { ok: false, code: 'bad_encoding', error: `unsupported encoding: ${String(args.encoding)}`, path: p, hint: `可用: ${FileTextIo.ACCEPTED_ENCODINGS_TEXT};不指定则自动判别(BOM / UTF-8 / GBK)` };
      // v0.8-S7 error guidance: a missing file is the most common failure — return a structured hint
      // instead of letting the raw ENOENT bubble up as a bare error string (the model can't self-correct
      // from "ENOENT" alone). 目录等其它已知 errno 也走结构化信封(F11)。
      let st;
      try { st = await fsp.stat(p); }
      catch (e) {
        if (e && e.code === 'ENOENT') return fileToolNotFound(p, args.path);
        const f = fileToolFsFailure(e, p); if (f) return f;
        throw e;
      }
      if (st.isDirectory()) return fileToolFsFailure({ code: 'EISDIR', message: 'EISDIR' }, p);
      const annotateFlag = args.annotate_non_ascii === true || args.annotate_non_ascii === 'true';
      const finalContent = (c) => annotateFlag ? accAnnotateNonAscii(c) : c;
      // v0.8-S1: line mode — triggered by lineOffset (1-based) or lineLimit. Returns cat -n style content
      // (right-aligned line number + tab + text) plus the effective lineOffset/lineLimit. Out-of-range → empty
      // content (NOT an error). Takes priority over the char slice when both parameter groups are given.
      // F4:两种模式都有字符预算(内容序列化后 ≤ FILE_READ_JSON_BUDGET),截断时给 nextOffset / nextLine 与 hint,
      // 并且只从 fd 读到「够返回窗口」为止(<=8MB 的文件读到尾以给出精确总数,更大的只读窗口)。
      const hasLineParams = args.lineOffset !== undefined || args.lineLimit !== undefined;
      const lineOffset = Math.max(1, Math.floor(Number(args.lineOffset != null ? args.lineOffset : 1)) || 1);
      // 2026-10 走查(R2):limit / lineLimit ≤ 0(或非数字)按「没传」处理,至少读 1 —— 修前 limit:0 返回空内容 + truncated:true +
      // nextOffset 与当前 offset 相同,模型照 nextOffset 继续读就是死循环。
      const lineLimitNum = Math.floor(Number(args.lineLimit));
      const lineLimit = args.lineLimit != null && lineLimitNum >= 1 ? lineLimitNum : FILE_READ_LINE_DEFAULT;
      const start = Math.max(0, Math.floor(Number(args.offset != null ? args.offset : 0)) || 0);
      const limitNum = Math.floor(Number(args.limit));
      // 至少 2:limit:1 落在增补平面字符(emoji / 生僻汉字,占 2 个 UTF-16 单元)上时窗口收尾会把代理对劈开、被收回成空串,
      // 同样得到「内容为空 + nextOffset 不变」的死循环。
      let limit = args.limit != null && limitNum >= 1 ? Math.max(2, limitNum) : FILE_READ_CHAR_DEFAULT;
      const limitClamped = limit > FILE_READ_CHAR_MAX;
      if (limitClamped) limit = FILE_READ_CHAR_MAX;
      let w;
      try {
        w = await privacyReadTextWindow(p, st, {
          encoding: encReq.enc, mode: hasLineParams ? 'lines' : 'chars', offset: start, limit, lineOffset, lineLimit,
          jsonBudget: FILE_READ_JSON_BUDGET, xform: annotateFlag ? accAnnotateNonAscii : null,
          // 2026-10 走查(R2):前 8KB 含 NUL 的(无 BOM)一律当二进制拒绝,不再只管无扩展名文件 —— 修前 .dat/.log/改了后缀的
          // 容器文件回 ok:true + 乱码。带 UTF-16 BOM 的文本不受影响(readTextWindow 里 BOM 优先);无 BOM 的 UTF-16 传 encoding 即可。
          refuseNul: true,
        });
      } catch (e) {
        if (e && e.code === 'ENOENT') return fileToolNotFound(p, args.path);
        const f = fileToolFsFailure(e, p); if (f) return f;
        throw e;
      }
      if (!w.ok) return { ok: false, code: w.code, error: w.error, path: p, hint: w.hint };
      const linked = privacyTextRead ? {} : await FileVisualIo.linkedImages(p, w.content || (w.lines || []).map(l => l.text).join('\n'), args,
        target => guardFileToolPath(target, ctx, { tool: 'file_read', write: false }));
      const encFields = { ...linked, encoding: w.encoding, ...(w.bom ? { bom: true } : {}), ...(w.encodingDetected ? { encodingDetected: true } : {}),
        ...(w.encodingWarning ? { encodingWarning: w.encodingWarning } : {}) };
      if (hasLineParams) {
        const width = String(w.lines.length ? w.lines[w.lines.length - 1].no : 0).length;
        const rawLines = w.lines.map(l => l.text);
        const content = w.lines.map(l => String(l.no).padStart(width, ' ') + '\t' + l.text).join('\n');
        const na = privacyTextRead ? null : buildNonAsciiReport(rawLines.join('\n'), { baseLine: w.lines.length ? w.lines[0].no : 1 });
        const result = { ok: true, path: p, mode: 'lines', content: finalContent(content), size: w.size,
          ...(w.totalLines != null ? { totalLines: w.totalLines } : {}), lineOffset, lineLimit, returnedLines: w.lines.length, truncated: w.truncated,
          ...(w.truncated ? { nextLine: w.nextLine } : {}),
          ...(w.lineTruncated ? { lineTruncated: w.lineTruncated } : {}),
          ...(w.truncated ? { hint: w.lineTruncated
            ? `第 ${w.lineTruncated.line} 行超长(${w.lineTruncated.lineChars} 字符),只返回了开头;要读它的其余部分请用字符模式 offset=${w.lineTruncated.nextOffset};继续后面的行请用 lineOffset=${w.nextLine}`
            : `还有更多内容;继续读请用 lineOffset=${w.nextLine}` } : {}),
          ...encFields, sourceLineEnding: w.eol, contentLineEnding: 'lf', ...(na && na.total ? { non_ascii: na } : {}) };
        privacySourceMark(result, ['/content'], privacySourceViews.get(w));
        if (cctx) await FileReadCache.store(cctx, result);
        return result;
      }
      // Diagnostic contexts/characters are raw derived copies with no JSON Pointer identity.
      // Let the unified gateway scan the single complete source before it reaches the model.
      const na = privacyTextRead ? null : buildNonAsciiReport(w.content, { baseLine: w.lineBase });
      const result = { ok: true, path: p, content: finalContent(w.content), offset: privacyTextRead ? w.start : start, size: w.size, ...(w.totalChars != null ? { totalChars: w.totalChars } : {}),
        truncated: w.truncated, ...(w.truncated ? { nextOffset: w.nextOffset } : {}),
        ...(w.truncated && w.totalChars != null ? { remainingChars: w.totalChars - w.nextOffset } : {}),
        ...(w.truncated ? { hint: `还有更多内容;继续读请用 offset=${w.nextOffset}(或用 lineOffset/lineLimit 行模式按行读)` } : {}),
        ...(limitClamped ? { limitClamped: true, limitMax: FILE_READ_CHAR_MAX } : {}),
        ...encFields, sourceLineEnding: w.eol, contentLineEnding: detectTextLineEnding(w.content), ...(na && na.total ? { non_ascii: na } : {}) };
      privacySourceMark(result, ['/content'], privacySourceViews.get(w));
      if (cctx) await FileReadCache.store(cctx, result);
      return result;
  } },
  file_write: { paths: "write", guardNote: '', handler: async (args, ctx) => {
      const p = await resolveFileToolPath(args.path, ctx);
      { const g = await guardFileToolPath(p, ctx, { tool: 'file_write', write: true }); if (!g.ok) return { ok: false, error: g.error, code: g.code, path: p }; }
      // hunt2 #9:content 缺省曾按 '' 处理 —— 模型漏传参数就把整个文件截成 0 字节还回 ok:true(schema 的 required
      // 没有任何地方校验)。清空文件请显式传空串。
      if (args.content == null) return { ok: false, error: 'content is required', path: p, hint: '要清空文件请显式传 content:""' };
      // F3:encoding 显式指定 utf8 / utf-16le / utf-16be / gbk(UTF-16 带 BOM);缺省保持已存在文件的原编码(BOM 嗅探 / GBK),新文件 UTF-8。
      // latin1 / ascii / base64 / hex 等 Buffer 编码维持历史行为(不做换行规范化)。
      const encReq = FileTextIo.normalizeEncodingName(args.encoding);
      let legacyEncoding = null;   // 非文本族的 Buffer 编码
      if (encReq.bad || encReq.enc === 'latin1') {
        if (args.encoding && Buffer.isEncoding(String(args.encoding))) legacyEncoding = String(args.encoding);
        else return { ok: false, code: 'bad_encoding', error: `unsupported encoding: ${String(args.encoding)}`, path: p, hint: `可用: ${FileTextIo.ACCEPTED_ENCODINGS_TEXT}` };
      }
      return withFileToolWriteLock([p], ctx && ctx.signal, async () => {
        // v0.8-S4a: checkpoint BEFORE writing. op = create when the file doesn't yet exist (no before to
        // store), else modify (snapshot the existing bytes). Reading the old content can't block the write.
        // F15/F10:先 stat,不为了「比一比」把 300MB 旧文件整个读进来;超过检查点上限的只读头部 64KB 用来判编码/BOM/换行。
        const st = await fsp.stat(p).catch(() => null);
        if (st && st.isDirectory()) return fileToolFsFailure({ code: 'EISDIR', message: 'EISDIR' }, p);
        const exists = !!st;
        let before = null, head = null;
        if (exists) {
          try {
            if (st.size <= JOURNAL_MAX_BEFORE_BYTES) { before = await fsp.readFile(p); head = before; }
            else { before = { skippedBytes: st.size }; head = await FileTextIo.readHead(p, 65536); }
          } catch (e) {
            if (e && e.code === 'ENOENT') { before = null; head = null; }
            else { const f = fileToolFsFailure(e, p); if (f) return f; throw e; }
          }
        }
        const existed = exists && before !== null;
        // 目标编码:显式 > 已存在文件的原编码 > utf8。
        let existingEnc = 'utf8';
        if (existed && head && head.length) {
          const sn = FileTextIo.sniffEncoding(head, head.length === st.size);
          if (!sn.lossy) existingEnc = sn.encoding;
        }
        let targetEnc = existingEnc, wantBom = false;
        if (legacyEncoding) targetEnc = 'utf8';
        else if (encReq.enc && encReq.enc !== 'auto') targetEnc = encReq.enc;
        if (!legacyEncoding) wantBom = targetEnc === 'utf16le' || targetEnc === 'utf16be';
        const canNormalizeLineEnding = !legacyEncoding;
        const isUtf8Target = targetEnc === 'utf8' && !legacyEncoding;
        const headText = existed && head ? FileTextIo.decodeBuffer(head, existingEnc).text : '';
        const sourceLineEnding = existed && canNormalizeLineEnding ? detectTextLineEnding(headText) : 'none';
        // 2026-10 走查(R2):换行风格的决定顺序 = 显式 lineEnding(lf/crlf 强制;preserve 原样写入 content 里的换行)>
        // 已存在文件的原风格(统一 LF/CRLF 才跟,混合/无换行不猜)> 新文件:content 本身统一 CRLF 就保留(修前一律被压成 LF,
        // 要写 Windows 换行的 .txt/.csv/.reg 做不到),否则按扩展名默认(.cmd/.bat/.ps1 = CRLF,其余 LF)。
        const leReq = String(args.lineEnding == null ? '' : args.lineEnding).trim().toLowerCase();
        let targetLineEnding = null;
        if (canNormalizeLineEnding) {
          if (leReq === 'lf' || leReq === 'crlf') targetLineEnding = leReq;
          else if (leReq === 'preserve') targetLineEnding = null;
          else if (sourceLineEnding === 'lf' || sourceLineEnding === 'crlf') targetLineEnding = sourceLineEnding;
          else if (!existed) targetLineEnding = detectTextLineEnding(String(args.content)) === 'crlf' ? 'crlf' : defaultTextLineEnding(p);
        }
        let content = targetLineEnding ? normalizeTextLineEndings(String(args.content), targetLineEnding) : String(args.content);
        if (args.validateSyntax === true) {
          if (legacyEncoding) return { ok: false, code: 'unsupported_syntax', error: 'Syntax validation requires text content, not a binary encoding.', written: false };
          const validation = await MediaInspection.checkSyntax(p, content, ctx && ctx.signal);
          if (!validation.ok) return { ...validation, path: p, written: false };
        }
        // hunt2 #10:保住 UTF-8 BOM。模型给的 content 从不带 BOM,整份覆写曾把原文件的 BOM 剥掉(file_edit 保得住);
        // 新建的 .ps1 也补上 BOM —— 否则 Windows PowerShell 5.1 按 ANSI 读,中文字面量变乱码。
        if (isUtf8Target && !content.startsWith('\ufeff')
          && (existed ? !!(head && head.subarray(0, 3).equals(UTF8_BOM_BYTES)) : textFileWantsUtf8Bom(p))) content = '\ufeff' + content;
        const writtenLineEnding = canNormalizeLineEnding ? detectTextLineEnding(content) : 'binary';
        // 第25波 25.5(AUTONOMY-PLAN):幂等写 —— 目标已存在且落盘字节将完全相同 → 跳过(不记检查点、不重写)。
        // 断点续跑重放同内容写不再产生新检查点条目/mtime 扰动;「touch」语义不受支持是有意的。
        // 按将实际落盘的字节比较(尊重编码),而非字符串比较,避免编码歧义。
        let payload;
        if (legacyEncoding) {
          // 2026-10 走查(R2):latin1 / binary / ascii 是单字节编码 —— 含超出范围的字符(中文)时 Buffer.from 静默取低字节
          // ("你好abc" 落成 607d616263,回读是乱码)。与 GBK 路径同口径:写不进去就拒绝并说明,文件不动。
          // base64 / hex 等是「content 本身就是编码文本」的另一种语义,不在此列。
          const le = String(legacyEncoding).toLowerCase();
          if (le === 'latin1' || le === 'binary' || le === 'ascii') {
            const badRe = le === 'ascii' ? /[^\x00-\x7f]/u : /[^\x00-\xff]/u;
            const bad = badRe.exec(content);
            if (bad) return fileToolUnencodable({ message: `character ${JSON.stringify(bad[0])} (U+${bad[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) at index ${bad.index} cannot be encoded as ${le}`, char: bad[0] }, p, le, 'content ');
          }
          payload = Buffer.from(content, legacyEncoding);
        } else {
          try { payload = FileTextIo.encodeText(content, targetEnc, wantBom); }
          catch (e) {
            if (e && e.code === 'UNENCODABLE') return fileToolUnencodable(e, p, targetEnc, 'content ');
            if (e && e.code === 'NO_GB18030') return { ok: false, code: 'encoding_unavailable', error: e.message, path: p, hint: '当前 Node 运行时不带 GB18030 编码支持;请改用 encoding:"utf8"' };
            throw e;
          }
        }
        if (existed) {
          let same = false;
          if (Buffer.isBuffer(before)) same = before.equals(payload);
          else if (st.size === payload.length) { const full = await fsp.readFile(p).catch(() => null); same = !!full && full.equals(payload); }
          if (same) {
            return { ok: true, path: p, op: 'skip', unchanged: true, bytes: payload.length, sourceLineEnding, writtenLineEnding,
              note: '目标内容已与要写入的内容一致,幂等跳过(未产生新检查点)' };
          }
        }
        const jctx = await journalSessionCtx(ctx);
        const jr = await journalRecord(jctx.sessionId, jctx.turnSeq, 'file_write', p, existed ? 'modify' : 'create', existed ? before : null);
        // F11:原子写(同目录临时文件 + rename,瞬时锁退避重试);写失败撤掉刚记的检查点,并把 EBUSY/ENOSPC 等变成带 hint 的信封。
        let writeResult;
        try {
          assertFileToolActive(ctx);
          if (args.createDirs !== false) await fsp.mkdir(path.dirname(p), { recursive: true });
          writeResult = await FileTextIo.writeFileAtomic(p, payload, { signal: ctx && ctx.signal });
        } catch (e) {
          const dropped = e.targetMayBeModified ? null : await fileToolDropPhantom(jctx, 'file_write', p, jr);
          const f = fileToolFsFailure(e, p, { checkpointRolledBack: !!(dropped && dropped.ok),
            ...(e.targetMayBeModified ? { checkpointRetained: !!(jr && jr.ok && Number.isFinite(jr.entrySeq)), checkpointWarn: journalCheckpointWarn(jr) } : {}) });
          if (f) return f;
          throw e;
        }
        // b2-P1: 检查点失败/超限时警告式披露(写操作可重放,不中止,但模型应向用户说明不可一键撤销)。
        const ret = { ...fileToolCleanupFields(writeResult), ok: true, path: p, op: existed ? 'modify' : 'create', bytes: payload.length, sourceLineEnding, writtenLineEnding,
          ...(legacyEncoding ? {} : { encoding: targetEnc }) };
        const warn = journalCheckpointWarn(jr);
        if (warn) ret.checkpointWarn = warn;
        return ret;
      });
  } },
  file_edit: { paths: "write", guardNote: '', handler: async (args, ctx) => {
      const p = await resolveFileToolPath(args.path, ctx);
      { const g = await guardFileToolPath(p, ctx, { tool: 'file_edit', write: true }); if (!g.ok) return { ok: false, error: g.error, code: g.code, path: p }; }
      const oldText = String(args.oldText || '');
      // 空 oldText 修前是抛异常(其余失败都是 {ok:false} 信封);schema 另有 minLength:1 先在公共闸里拦一道。
      if (!oldText) return { ok: false, code: 'invalid-arguments', error: 'oldText is required and must be non-empty', path: p, hint: '要在文件里插入内容:把相邻的一段原文作为 oldText,newText 写成「原文 + 新内容」;要新建/整体重写文件用 file_write' };
      // hunt2 #9:newText 缺省曾按 '' 处理 = 模型漏传参数就静默删掉 oldText。删除文本请显式传空串。
      if (args.newText == null) return { ok: false, error: 'newText is required', path: p, hint: '要删除 oldText 请显式传 newText:""' };
      const newText = String(args.newText);
      return withFileToolWriteLock([p], ctx && ctx.signal, async () => {
        // v0.8-S7 error guidance: distinguish "file doesn't exist" (structured hint) from other read errors.
        // 走查 W1·F8:先 stat 再读 —— 修前整份 readFile 完才判 >50MB(先吃了内存;>2GiB 时 readFile 直接抛裸 ERR_FS_FILE_TOO_LARGE)。
        let stBefore = null;
        try { stBefore = await fsp.stat(p); }
        catch (e) {
          if (e && e.code === 'ENOENT') return fileToolNotFound(p, args.path);
          const f = fileToolFsFailure(e, p); if (f) return f;
          throw e;
        }
        let rawBytes;
        if (!(stBefore.isFile() && stBefore.size > FILE_EDIT_MAX_BYTES)) {
          try { rawBytes = await fsp.readFile(p); }
          catch (e) {
            if (e && e.code === 'ENOENT') return fileToolNotFound(p, args.path);
            const f = fileToolFsFailure(e, p); if (f) return f;
            throw e;
          }
        }
        // b2-P1: 超大文件编辑需整文件进内存 + 双份快照 —— 拒绝并提示改用人话行定位/分段处理
        if (!rawBytes || rawBytes.length > FILE_EDIT_MAX_BYTES) {
          return { ok: false, error: '文件超过 50MB,编辑需整文件进内存,请改用 file_read(行模式 / offset)定位 + shell_run 或 script_run 分段处理', path: p, hint: '大文件建议先用 file_read 的 lineOffset/lineLimit 定位,再用脚本按行分段改写(file_write 会整份覆盖)' };
        }
        // hunt2 #2:只编辑「能无损往返」的文本。修前按 utf8 宽松解码 —— GBK/ANSI 源文件里每个汉字都变成 U+FFFD,替换一处
        // ASCII 就把全文件的中文写成乱码并回 ok:true。F3:现在按 BOM / 严格 UTF-8 / GB18030 判编码,【原编码写回】
        // (UTF-16 保 BOM、GBK 逐字节等价,UTF-8 的 BOM 留在文本里原样写回);编码后必须与读到的原字节逐字节一致
        // (往返校验),否则拒绝 —— 宁可不改也不把文件悄悄转成别的编码。既非合法 UTF-8 也非 GBK 的仍拒绝。
        const dm = FileTextIo.decodeBuffer(rawBytes, 'auto');
        if (dm.lossy) {
          return { ok: false, code: 'not_utf8', path: p,
            error: '文件既不是有效的 UTF-8 / GBK / UTF-16 文本(可能是其它本地编码或二进制);file_edit 只编辑能无损往返的文本,为免写坏文件已拒绝',
            hint: FILE_EDIT_ENCODING_HINT_UNDECODABLE };
        }
        const raw = dm.text;
        const fileEnc = dm.encoding;
        const fileBom = fileEnc !== 'utf8' && dm.bom;
        if (fileEnc !== 'utf8') {
          let rt = null;
          try { rt = FileTextIo.encodeText(raw, fileEnc, fileBom); } catch { rt = null; }
          if (!rt || !rt.equals(rawBytes)) {
            return { ok: false, code: 'not_roundtrip', path: p, encoding: fileEnc,
              error: `文件是 ${fileEnc} 编码,但无法保证按原编码逐字节写回,为免损坏已拒绝`,
              hint: FILE_EDIT_ENCODING_HINT_NOT_ROUNDTRIP };
          }
        }
        const sourceLineEnding = detectTextLineEnding(raw);
        let matchText = oldText;
        let count = raw.split(matchText).length - 1;
        let normalizedOldText = false;
        // hunt2 #8:统一 CRLF 的文件里,oldText 中的裸 \n 只可能命中某个 \r\n 的后半(典型:以 "\n" 开头的锚点),
        // 字面命中会把 \r 留在前面,而 newText 又被规范成 CRLF → 写出 "\r\r\n"。这种文件先把 oldText 规范成 CRLF
        // 再数,规范后的结果即为准(不再退回字面命中)。
        if (sourceLineEnding === 'crlf' && /(^|[^\r])\n/.test(oldText)) {
          matchText = normalizeTextLineEndings(oldText, 'crlf');
          count = raw.split(matchText).length - 1;
          normalizedOldText = true;
        }
        // A line-mode file_read returns LF-separated display text. For an otherwise uniform CRLF file, accept
        // that anchor after converting it back to the file's native style. Mixed files intentionally get no
        // fallback: guessing there could replace across an already-corrupt boundary.
        if (count === 0 && (sourceLineEnding === 'lf' || sourceLineEnding === 'crlf') && hasTextLineBreak(oldText)) {
          const normalized = normalizeTextLineEndings(oldText, sourceLineEnding);
          if (normalized !== oldText) {
            const normalizedCount = raw.split(normalized).length - 1;
            if (normalizedCount > 0) { matchText = normalized; count = normalizedCount; normalizedOldText = true; }
          }
        }
        if (count === 0) {
          if (privacySourceActive()) {
            const view = await PrivacyGateway.projectSource(raw), oldView = await PrivacyGateway.projectSource(oldText);
            return buildFileEditMiss(p, raw, oldText, sourceLineEnding, view, oldView);
          }
          return buildFileEditMiss(p, raw, oldText, sourceLineEnding);
        }
        // F6:多处命中不再抛异常(其余失败都是 {ok:false} 信封),并列出每处的行号,模型可加上下文消歧。
        if (count > 1 && !args.replaceAll) {
          const matches = FileTextIo.locateMatches(raw, matchText, 8);
          const lines = matches.map(m => m.line).join(', ') + (count > matches.length ? ', …' : '');
          return { ok: false, code: 'ambiguous', error: `oldText appears ${count} times; set replaceAll=true`, path: p, count, matches,
            hint: `oldText 在第 ${lines} 行出现(共 ${count} 处);要全部替换请设 replaceAll=true,只改其中一处请在 oldText 里多带上前后几行让它唯一` };
        }
        const writeText = (sourceLineEnding === 'lf' || sourceLineEnding === 'crlf')
          ? normalizeTextLineEndings(newText, sourceLineEnding) : newText;
        const updated = raw.split(matchText).join(writeText); // v2.6 fix: split/join literal replace (NOT raw.replace) - JS String.replace treats the string newText as a REPLACEMENT pattern and expands $& / $1 / $' / $$ into match content, corrupting files
        if (args.validateSyntax === true) {
          const validation = await MediaInspection.checkSyntax(p, updated, ctx && ctx.signal);
          if (!validation.ok) return { ...validation, path: p, written: false };
        }
        // 2026-10 走查(R2):替换后与原文逐字符相同(oldText == newText,或换行规范化后等价)—— 不写盘、不记检查点
        // (修前照样原子重写 + 记一条空检查点,mtime 被扰动、撤回列表里多一条什么也没改的条目)。与 file_write 的幂等跳过同口径。
        if (updated === raw) {
          return { ok: true, path: p, op: 'skip', unchanged: true, replacements: 0, sourceLineEnding, writtenLineEnding: sourceLineEnding, normalizedOldText,
            note: '替换后与原文一致(oldText 与 newText 相同),未改动文件(未产生新检查点)' };
        }
        let payload;
        try { payload = FileTextIo.encodeText(updated, fileEnc, fileBom); }
        catch (e) {
          if (e && e.code === 'UNENCODABLE') return fileToolUnencodable(e, p, fileEnc, 'newText ');
          throw e;
        }
        // v0.8-S4a: checkpoint the original bytes (op modify) BEFORE overwriting. `raw` is the pre-edit
        // content already read above; only reached once we know the edit will apply (not the not-found path).
        // hunt2 #2:检查点存读到的原字节(Buffer),不存解码后的串 —— 撤销必须逐字节还原。
        const jctx = await journalSessionCtx(ctx);
        const jr = await journalRecord(jctx.sessionId, jctx.turnSeq, 'file_edit', p, 'modify', rawBytes);
        let writeResult;
        try { writeResult = await FileTextIo.writeFileAtomic(p, payload, { signal: ctx && ctx.signal }); }
        catch (e) {
          // F11:写失败 -> 撤掉刚记的检查点(否则留一条描述「没发生的改动」的条目),并把锁/磁盘满等变成带 hint 的信封。
          const dropped = e.targetMayBeModified ? null : await fileToolDropPhantom(jctx, 'file_edit', p, jr);
          const f = fileToolFsFailure(e, p, { checkpointRolledBack: !!(dropped && dropped.ok),
            ...(e.targetMayBeModified ? { checkpointRetained: !!(jr && jr.ok && Number.isFinite(jr.entrySeq)), checkpointWarn: journalCheckpointWarn(jr) } : {}) });
          if (f) return f;
          throw e;
        }
        const ret = { ...fileToolCleanupFields(writeResult), ok: true, path: p, op: 'modify', replacements: args.replaceAll ? count : 1,
          sourceLineEnding, writtenLineEnding: detectTextLineEnding(updated), normalizedOldText, ...(fileEnc !== 'utf8' ? { encoding: fileEnc } : {}) };
        const warn = journalCheckpointWarn(jr);
        if (warn) ret.checkpointWarn = warn;
        return ret;
      });
  } },
  file_delete: { paths: "write", guardNote: '', handler: async (args, ctx) => {
      if (args.recursive || args.paths) return fileToolBatch('file_delete', args, ctx);
      // v0.8-S4a (moved in from S1 — a not-undoable delete could not ship before the journal existed).
      // Checkpoint the file's bytes (op delete) BEFORE unlinking so a rollback can resurrect it. Refuse
      // directories (only files are journaled/deletable here).
      const p = await resolveFileToolPath(args.path, ctx);
      { const g = await guardFileToolPath(p, ctx, { tool: 'file_delete', write: true }); if (!g.ok) return { ok: false, error: g.error, code: g.code, path: p }; }
      return withFileToolWriteLock([p], ctx && ctx.signal, async () => {
        const st = await fsp.stat(p).catch(() => null);
        // v0.8-S7 error guidance: same ENOENT hint as file_read/file_edit so the model confirms the path first.
        if (!st) return fileToolNotFound(p, args.path);
        if (st.isDirectory()) return { ok: false, code: 'is_directory', error: 'is a directory', path: p, hint: '仅支持删除文件' };
        // F10:先 stat 再决定读不读 —— 超过检查点上限的文件不必(也不该)整个读进内存只为发现它存不下。
        let before;
        try { before = await fileToolBeforeForCheckpoint(p, st.size); }
        catch (e) {
          if (e && e.code === 'ENOENT') return fileToolNotFound(p, args.path);
          const f = fileToolFsFailure(e, p); if (f) return f;
          throw e;
        }
        const jctx = await journalSessionCtx(ctx);
        // b2-P0: 检查点记录失败(无 session 上下文/写盘失败)时,删除不可回滚 → 中止。
        // 「没有会话上下文/写盘失败」是安全网本身坏了,宁可拒绝也不零记录删除。
        const jr = await journalRecord(jctx.sessionId, jctx.turnSeq, 'file_delete', p, 'delete', before);
        if (!jr || jr.ok === false) {
          return { ok: false, error: `无法写入回滚检查点(${jr ? jr.reason : 'unknown'}),已中止删除以保证可回滚。请检查会话上下文或先手动备份。`, path: p, checkpointWarn: true,
            hint: '想保留一份再删:先 file_copy 到备份位置,再重试 file_delete;或让用户手动处理' };
        }
        // F10:>5MB 的文件与 file_write / file_move 同一口径 —— 照常执行,如实披露「没做检查点、不可一键撤销」。
        // (此前唯独删除硬性拒绝,导致清理大日志/大产物在原生工具里根本做不到;安全性由权限档位与用户审批把守,
        //  与同样会不可逆丢掉旧内容的 file_write 覆盖一致。)
        const checkpointWarn = journalCheckpointWarn(jr);
        try { assertFileToolActive(ctx); await fsp.unlink(p); }
        catch (e) {
          const dropped = await fileToolDropPhantom(jctx, 'file_delete', p, jr);
          const f = fileToolFsFailure(e, p, { checkpointRolledBack: !!(dropped && dropped.ok) });
          if (f) return f;
          throw e;
        }
        return { ok: true, path: p, op: 'delete', ...(checkpointWarn ? { checkpointWarn, hint: `文件 ${Math.round(st.size / 1024 / 1024 * 10) / 10}MB,超过检查点快照上限(${Math.round(JOURNAL_MAX_BEFORE_BYTES / 1024 / 1024)}MB),本次删除没有检查点、无法一键撤销;如需恢复只能从用户自己的备份找回` } : {}) };
      });
  } },
  file_move: { paths: "both", guardNote: '', handler: async (args, ctx) => {
      if (args.recursive || args.items) return fileToolBatch('file_move', args, ctx);
    // v1.1-W2 (T1) file_move(from, to, overwrite=false): 移动/重命名。检查点两条各自逆操作（见下注释）。
    // 逆操作语义表（把关人可据此审）：
    //   ① from 存 op:delete（before=from 原内容）→ 回滚 = 把内容写回 from。
    //   ② to 已存在则存 op:modify（before=to 原内容）→ 回滚 = 把内容写回 to；
    //      to 不存在则存 op:create（before=null）→ 回滚 = 删除 to。
    //   两条按 entrySeq 逆序回滚（先撤 to 再撤 from）→ 净效果 = 文件回到 from、to 恢复原状/消失。
      if (!args.from || !args.to) return { ok: false, error: 'from 与 to 都不能为空' };
      const from = await resolveFileToolPath(args.from, ctx);
      const to = await resolveFileToolPath(args.to, ctx);
      // v1.4.6-S3: a move both reads+deletes `from` and writes `to` — guard both as writes (out-of-bounds → deny).
      // 2026-10 走查(R2):围栏在【任何 stat 之前】—— 修前先 stat(from) 再过围栏,工作区外路径「存在 → 越界拒绝 / 不存在 → not_found」
      // 的差别把区外文件系统的存在性泄给了模型(对 /etc/xxx、别的用户目录逐个探测)。
      { const gf = await guardFileToolPath(from, ctx, { tool: 'file_move', write: true }); if (!gf.ok) return { ok: false, error: gf.error, code: gf.code, path: from }; }
      { const gt = await guardFileToolPath(to, ctx, { tool: 'file_move', write: true }); if (!gt.ok) return { ok: false, error: gt.error, code: gt.code, path: to }; }
      return withFileToolWriteLock([from, to], ctx && ctx.signal, async () => {
        const fromSt = await fsp.stat(from).catch(() => null);
        if (!fromSt) return { ...fileToolNotFound(from, args.from), error: '源文件不存在', hint: '先用 glob 或 file_list 确认路径' };
        if (fromSt.isDirectory()) return { ok: false, error: '暂不支持移动文件夹', hint: '仅支持移动单个文件' };
        const toSt = await fsp.stat(to).catch(() => null);
        // 目标是目录:rename / 记检查点读目录都会炸(修前是裸 EISDIR 异常)—— 明说,并提示把文件名写进 to。
        if (toSt && toSt.isDirectory()) return { ok: false, code: 'target_is_directory', error: '目标是一个已存在的目录', path: to, hint: 'to 要写成「目录/新文件名」(含文件名),file_move 不会自动把文件放进目录里' };
        // 源与目标是同一个文件:路径逐字相同 → 什么也不用做(修前 overwrite:true 会记两条空检查点;没带 overwrite 还谎报「目标已存在」)。
        // 仅大小写不同(NTFS / macOS 默认大小写不敏感:data.csv → DATA.csv)→ 是合法的改名,不是「目标已存在」(见 fileMoveSameFileKind)。
        const sameKind = fileMoveSameFileKind(from, to, fromSt, toSt);
        if (sameKind === 'identical') return { ok: true, from, to, op: 'move', overwritten: false, unchanged: true, note: '源与目标是同一个路径,未做任何改动' };
        const caseOnly = sameKind === 'case-only';
        const toExists = !!toSt && !caseOnly;
        if (toExists && !args.overwrite) return { ok: false, error: '目标已存在', path: to, hint: '若要覆盖请设置 overwrite=true' };
        // F10:超过检查点上限的只给 skippedBytes 标记,不把 300MB 读进内存只为记一条「存不下」。
        const fromBefore = await fileToolBeforeForCheckpoint(from, fromSt.size);
        const toBefore = toExists ? await fileToolBeforeForCheckpoint(to, toSt.size) : null;
        const jctx = await journalSessionCtx(ctx);
        // ① from 侧：op:delete（回滚=写回 from）。
        const jrFrom = await journalRecord(jctx.sessionId, jctx.turnSeq, 'file_move', from, 'delete', fromBefore);
        // hunt2 #1:from 侧快照没存下内容(>5MB 被标 skipped,或写盘失败)时,这对条目回滚起来是【丢数据】的:
        // 逆序先撤 to(create → 删掉 to,也就是删掉唯一一份内容),再撤 from 时又报 before 没存 —— 实测 A、B 两头都没了。
        // 目标原本不存在:丢掉这对条目,照常移动并如实披露「不可一键撤销」(移动不毁任何内容,文件就在 to)。
        // 目标已存在(覆盖):覆盖掉的旧 to 与移动过去的大文件二者必丢其一,与 file_delete 同口径 —— 拒绝。
        // 只删本次记下的那几条(按 entrySeq),同一回合早先涉及同一路径的条目不受牵连。
        const recordedSeqs = [];
        const dropRecorded = () => journalDropEntries(jctx.sessionId, jctx.turnSeq, 'file_move', [from, to], recordedSeqs).catch(() => ({ ok: false }));
        if (jrFrom && Number.isFinite(jrFrom.entrySeq)) recordedSeqs.push(jrFrom.entrySeq);
        const fromSnapshotMissing = !jrFrom || jrFrom.ok === false || !!jrFrom.skipped;
        let checkpointWarn = '';
        if (fromSnapshotMissing) {
          await dropRecorded();
          recordedSeqs.length = 0;
          if (jrFrom && jrFrom.skipped && toExists) {
            return { ok: false, error: '源文件超过检查点快照上限,覆盖式移动不可回滚,已中止。请先手动备份目标文件,或换一个不存在的目标路径。', from, to, checkpointWarn: true };
          }
          checkpointWarn = journalCheckpointWarn(jrFrom || { ok: false, reason: 'unknown' });
        } else {
          // ② to 侧：已存在=modify（回滚=写回原 to）；不存在=create（回滚=删 to）。
          const jrTo = await journalRecord(jctx.sessionId, jctx.turnSeq, 'file_move', to, toExists ? 'modify' : 'create', toExists ? toBefore : null);
          if (jrTo && Number.isFinite(jrTo.entrySeq)) recordedSeqs.push(jrTo.entrySeq);
          checkpointWarn = journalCheckpointWarn(jrTo);
        }
        try {
          assertFileToolActive(ctx);
          await fsp.mkdir(path.dirname(to), { recursive: true });
          assertFileToolActive(ctx);
          if (caseOnly) {
            // 大小写不敏感文件系统上的纯改大小写:经一个临时名中转两步改(直接 rename 在个别驱动 / 同步盘上不会真的改大小写)。
            const tmp = path.join(path.dirname(from), `.${path.basename(from)}.${process.pid}.${Date.now().toString(36)}.rn`);
            await fsp.rename(from, tmp);
            try { await fsp.rename(tmp, to); }
            catch (e2) {
              try { await fsp.rename(tmp, from); }
              catch (restoreError) {
                e2.targetMayBeModified = true;
                e2.recoveryPath = tmp;
                e2.restoreError = String(restoreError.message || restoreError);
              }
              throw e2;
            }
          } else await fsp.rename(from, to);
        } catch (e) {
          if (e && e.code === 'EXDEV' && !e.targetMayBeModified) {
            // 跨盘（EXDEV）退化：copy + delete。fs.rename 不能跨卷。
            // Retain checkpoints once fallback copying starts, including partial-copy and unlink failures.
            let copyStarted = false;
            try {
              assertFileToolActive(ctx);
              copyStarted = true;
              await fsp.copyFile(from, to);
              await fsp.unlink(from);
            } catch (e2) {
              // Once copy begins, either path may need its original checkpoint for recovery.
              if (copyStarted) e2.targetMayBeModified = true;
              const dropped = copyStarted ? null : await dropRecorded();
              const failure = fileToolFsFailure(e2, to);
              return { ...(failure || {}), ok: false, error: `跨盘移动失败: ${(e2 && e2.message) || String(e2)}。`, from, to,
                partial: copyStarted, checkpointRolledBack: !!(dropped && dropped.ok),
                ...(copyStarted ? { checkpointRetained: recordedSeqs.length > 0, checkpointWarn } : {}) };
            }
          } else {
            // Drop only uncommitted records; failed restoration still needs both recovery snapshots.
            const dropped = e.targetMayBeModified ? null : await dropRecorded();
            const f = fileToolFsFailure(e, from);
            return { ...(f || {}), ok: false, error: `移动失败: ${(e && e.message) || String(e)}。`, from, to, checkpointRolledBack: !!(dropped && dropped.ok),
              ...(e.targetMayBeModified ? { partial: true, recoveryPath: e.recoveryPath, restoreError: e.restoreError,
                checkpointRetained: recordedSeqs.length > 0, checkpointWarn } : { phantomJournal: !(dropped && dropped.ok) }) };
          }
        }
        return { ok: true, from, to, op: 'move', overwritten: toExists, ...(checkpointWarn ? { checkpointWarn } : {}) };
      });
  } },
  file_copy: { paths: "both", guardNote: '', handler: async (args, ctx) => {
      if (args.recursive || args.items) return fileToolBatch('file_copy', args, ctx);
    // v1.1-W2 (T1) file_copy(from, to, overwrite=false)。逆操作：仅 to 一条。
    //   to 已存在 → op:modify（回滚=写回原 to）；不存在 → op:create（回滚=删 to）。from 不动，无需检查点。
      if (!args.from || !args.to) return { ok: false, error: 'from 与 to 都不能为空' };
      const from = await resolveFileToolPath(args.from, ctx);
      const to = await resolveFileToolPath(args.to, ctx);
      // v1.4.6-S3: copy READS `from` (exfil vector if out of bounds) and WRITES `to` — guard each accordingly.
      // 2026-10 走查(R2):围栏先于 stat(同 file_move:不让区外路径的存在性经「拒绝 / not_found」的差别泄给模型)。
      { const gf = await guardFileToolPath(from, ctx, { tool: 'file_copy', write: false }); if (!gf.ok) return { ok: false, error: gf.error, code: gf.code, path: from }; }
      { const gt = await guardFileToolPath(to, ctx, { tool: 'file_copy', write: true }); if (!gt.ok) return { ok: false, error: gt.error, code: gt.code, path: to }; }
      return withFileToolWriteLock([from, to], ctx && ctx.signal, async () => {
        const fromSt = await fsp.stat(from).catch(() => null);
        if (!fromSt) return { ...fileToolNotFound(from, args.from), error: '源文件不存在', hint: '先用 glob 或 file_list 确认路径' };
        if (fromSt.isDirectory()) return { ok: false, error: '暂不支持复制文件夹', hint: '仅支持复制单个文件' };
        const toSt = await fsp.stat(to).catch(() => null);
        if (toSt && toSt.isDirectory()) return { ok: false, code: 'target_is_directory', error: '目标是一个已存在的目录', path: to, hint: 'to 要写成「目录/新文件名」(含文件名),file_copy 不会自动把文件放进目录里' };
        // 复制到自己身上:copyFile 会报错 / 在个别平台截断成空文件 —— 同一个文件就什么也不做。
        if (fileMoveSameFileKind(from, to, fromSt, toSt) !== null) return { ok: true, from, to, op: 'copy', overwritten: false, unchanged: true, note: '源与目标是同一个文件,未做任何改动' };
        const toExists = !!toSt;
        if (toExists && !args.overwrite) return { ok: false, error: '目标已存在', path: to, hint: '若要覆盖请设置 overwrite=true' };
        const toBefore = toExists ? await fileToolBeforeForCheckpoint(to, toSt.size) : null;
        const jctx = await journalSessionCtx(ctx);
        const jr = await journalRecord(jctx.sessionId, jctx.turnSeq, 'file_copy', to, toExists ? 'modify' : 'create', toExists ? toBefore : null);
        let copyStarted = false;
        try {
          assertFileToolActive(ctx);
          await fsp.mkdir(path.dirname(to), { recursive: true });
          assertFileToolActive(ctx);
          copyStarted = true;
          await fsp.copyFile(from, to);
        } catch (e) {
          if (copyStarted) e.targetMayBeModified = true;
          const dropped = copyStarted ? null : await fileToolDropPhantom(jctx, 'file_copy', to, jr);
          const failure = fileToolFsFailure(e, to);
          return { ...(failure || {}), ok: false, error: `复制失败: ${(e && e.message) || String(e)}。`, from, to,
            checkpointRolledBack: !!(dropped && dropped.ok),
            ...(copyStarted ? { partial: true, checkpointRetained: !!(jr && jr.ok && Number.isFinite(jr.entrySeq)),
              checkpointWarn: journalCheckpointWarn(jr) } : { phantomJournal: !(dropped && dropped.ok) }) };
        }
        const checkpointWarn = journalCheckpointWarn(jr);
        return { ok: true, from, to, op: 'copy', overwritten: toExists, ...(checkpointWarn ? { checkpointWarn } : {}) };
      });
  } },
  file_list: { paths: "read", guardNote: '', handler: async (args, ctx) => {
      assertSearchExecution(ctx && ctx.signal);
      const root = await resolveFileToolRoot(args, ctx);
      const g = await guardFileToolPath(root, ctx, { tool: 'file_list', write: false });
      if (!g.ok) return { ok: false, error: g.error, code: g.code, root };
      const rootBad = await toolRootProblem(root);
      if (rootBad) return rootBad;
      const walkRoot = guardedWalkRoot(root, g);
      // F13:pattern 是正则;写成 glob(`*.js`)的按 glob 处理并说明,真正非法的给 bad_pattern + hint(修前是原始 SyntaxError)。
      const cls = classifyListPattern(args.pattern, root);
      if (cls.kind === 'invalid') return { ok: false, error: cls.error, code: 'bad_pattern', hint: cls.hint, root };
      const recursive = args.recursive !== false;
      const walked = await walkFiles(walkRoot, { signal: ctx && ctx.signal,
        recursive, maxFiles: args.maxFiles, maxDepth: args.maxDepth, ignoreCase: args.ignoreCase,
        pattern: cls.kind === 'regex' ? String(args.pattern) : '', accept: cls.kind === 'glob' ? cls.accept : null,
        // 递归列举:广度优先(先把浅层列全);非递归 = 目录浏览,只藏 node_modules/.git/.venv(build/dist 也要能点开看)。
        bfs: true, browse: !recursive, ignoreDirs: args.ignoreDirs, includeIgnored: args.includeIgnored === true,
        // 调用方在 pattern(正则或 glob)/ root 里显式点名的目录不剪(`^dist/`、root=…/build)。
        allowDirs: explicitAllowDirs(root, cls.kind === 'regex' ? explicitSegmentsOfRegex(args.pattern) : cls.kind === 'glob' ? explicitSegmentsOfGlob(args.pattern) : []),
      });
      respellWalkPaths(walked, walkRoot, root);   // 第三波(复核 #6):回给模型的绝对路径保持调用方的写法(映射盘 / 别名不换成 UNC / 真身)
      // F12:信封只带相对路径(root 已在顶层);absolute:true 才补绝对 path。
      const resp = { ok: true, root, files: walkEnvelopeEntries(walked, args.absolute === true) };
      if (walked.truncated) { resp.truncated = true; resp.hint = walkTruncationHint(walked, 'file_list'); }
      if (walked.prunedDirs && recursive) { resp.prunedDirs = walked.prunedDirs; resp.prunedHint = prunedDirsHint('file_list'); }
      if (walked.depthLimited && recursive) { resp.depthLimited = true; resp.depthCutDirs = walked.depthCutDirs; resp.depthHint = walkDepthHint(walked, 'file_list'); }
      if (cls.kind === 'glob') resp.patternNote = cls.note;
      // 审计 F 后续:pattern 撞了时间预算(可能是灾难性回溯)—— 已匹配到的照给,如实说「可能不全」(口径同 file_search)。
      if (walked.patternTimedOut) resp.patternNote = 'pattern matching hit its time budget (pattern too slow, possible catastrophic backtracking); listing may be incomplete';
      return resp;
  } },
  file_search: { paths: "read", guardNote: '', handler: async (args, ctx) => {
      const root = await resolveFileToolRoot(args, ctx);
      const g = await guardFileToolPath(root, ctx, { tool: 'file_search', write: false });
      if (!g.ok) return { ok: false, error: g.error, code: g.code, root };
      const rootBad = await toolRootProblem(root);
      if (rootBad) return rootBad;
      const walkRoot = guardedWalkRoot(root, g);
      // maxResults ≤0 / 非数字按没传(200)—— 修前 0 或负数让两个引擎都立刻停在 0 条并报 truncated。
      const maxResultsReq = Number(args.maxResults);
      const maxResults = args.maxResults != null && maxResultsReq >= 1 ? Math.floor(maxResultsReq) : 200;
      let matches;
      try {
        matches = await searchFileContent(walkRoot, String(args.pattern || ''), { ...args, maxResults, signal: ctx && ctx.signal, ...fileToolPrivacySourceOptions(ctx, 'file_search') });
      } catch (error) {
        if (!error.searchExecutionFailure) throw error;
        return { ok: false, root, code: error.code, error: error.message, cleanupScope: error.cleanupScope,
          cleanupIncomplete: error.cleanupIncomplete, cleanupEscapeCoverage: error.cleanupEscapeCoverage,
          cleanupUnconfirmed: error.cleanupUnconfirmed };
      }
      // 审计 P1(对抗轮补漏): JS 扫描路径已在 walkFiles 跳过敏感子树;rg 路径不经 walkFiles,这里补一道结果层过滤
      // (对 flat 与 group:true 两种形态,项内都带 .path)。ensureDataRootReal 已由上游 guardFileToolPath(root) 预热。
      const regexTimedOut = !!(matches && matches.regexTimedOut);   // 审计 F:JS 正则撞了时间预算
      // 数组上挂的元数据(JSON.stringify 会丢),filter 之前先取出来。
      const meta = matches || {};
      if (Array.isArray(matches)) {
        // 安全走查 S7:rg 路径不经 walkFiles,结果层再按 dev+ino 挡一道硬链接别名(只对命中的那几个文件 stat,不是对遍历的每个文件)。
        const ids = await sensitiveFileIdentities();
        const kept = [];
        for (const m of matches) {
          if (isSensitiveDataPath(m && m.path)) continue;
          if (ids.size && m && m.path && await isSensitiveHardlinkAlias(m.path, ids)) continue;
          kept.push(m);
        }
        matches = kept;
        respellWalkPaths(matches, walkRoot, root);   // 第三波(复核 #6):敏感名单与硬链接判据已按 realpath 判完,回给模型的 path 换回调用方的写法
      }
      const resp = { ok: true, root, matches };
      if (meta.engine) resp.engine = meta.engine;
      // 只有【上限之后确实还有命中】才报截断(修前命中数恰好等于 maxResults 也报 truncated:true,模型白白再搜一轮)。
      if (meta.moreMatches || regexTimedOut) resp.truncated = true;
      // F2:JS 引擎的遍历撞了 maxFiles / 耗时上限 —— 之前这个信号被丢掉,「没搜到」与「没搜完」无法区分。
      if (meta.walkTruncated) {
        resp.truncated = true;
        resp.scannedFiles = meta.scannedFiles;
        resp.hint = 'file_search: only the first ' + meta.scannedFiles + ' files were scanned (file limit reached); narrow root, pass a glob, or raise maxFiles';
      }
      // F7:超过 maxFileBytes 的文件没有被搜 —— 列出来(JS 引擎)/ 说明上限(rg 引擎),别静默。
      if (meta.skippedLargeFiles) {
        resp.skippedLargeFiles = meta.skippedLargeFiles.slice(0, 20);
        resp.skippedLargeCount = meta.skippedLargeFiles.length;
        resp.skippedLargeHint = 'files larger than maxFileBytes (' + meta.maxFileBytes + ' bytes) were not searched; raise maxFileBytes (max 200MB) to include them';
      } else if (meta.engine === 'rg') resp.maxFileBytes = meta.maxFileBytes;
      // 2026-10 走查(R2):非 UTF-8 文件如实上报。nonUtf8Files = 已按 GBK / UTF-16 解码后搜过的文件(命中文本是解码后的,
      // 中文可搜);skippedNonUtf8 = 既不是合法 UTF-8 也不是合法 GBK 的文件(只能按 U+FFFD 宽松解码,命中可能不全)。
      if (meta.nonUtf8Files) { resp.nonUtf8Files = meta.nonUtf8Files; resp.nonUtf8Count = meta.nonUtf8Count; resp.nonUtf8Hint = 'these files are not UTF-8 (GBK / UTF-16); they were decoded accordingly before matching - file_read decodes them the same way'; }
      if (meta.skippedNonUtf8) { resp.skippedNonUtf8 = meta.skippedNonUtf8; resp.skippedNonUtf8Count = meta.skippedNonUtf8Count; resp.skippedNonUtf8Hint = 'these files are neither valid UTF-8 nor GBK; they were matched as lossy UTF-8 so hits may be missing or garbled - try file_read with an explicit encoding'; }
      // F2: literal-fallback marker (invalid regex was searched as escaped literal text) — additive field.
      if (meta.patternNote) resp.patternNote = meta.patternNote;
      // 被默认清单剪掉的目录(build/dist/out/target/coverage …):两个引擎都报,并说怎么放开(修前 handler 把它丢了)。
      if (Array.isArray(meta.prunedDirs) && meta.prunedDirs.length) { resp.prunedDirs = meta.prunedDirs; resp.prunedHint = prunedDirsHint('file_search'); }
      // rg 引擎在 git 仓库里遵守 .gitignore(既有设计),被忽略的文件不搜、返回里却没有任何信号:零命中时如实说一句,
      // 免得模型把「被忽略了」读成「确实没有」(2026-10 工具走查)。
      if (meta.engine === 'rg' && args.includeIgnored !== true && Array.isArray(matches) && matches.length === 0 && await nearestGitignore(root)) {
        resp.ignoreNote = 'searched with .gitignore respected (git-ignored files were not searched); pass includeIgnored:true to include them';
      }
      return resp;
  } },
  glob: { paths: "read", guardNote: '', handler: async (args, ctx) => {
      assertSearchExecution(ctx && ctx.signal);
      // v0.8-S1: glob file matcher. Self-written `**`/`*`/`?` → RegExp; reuses walkFiles for traversal
      // (its default ignoreDirs: node_modules/.git/.venv). Returns files sorted by mtime DESC, capped
      // at maxResults (default 500) with a `truncated` flag.
      const root = await resolveFileToolRoot(args, ctx);
      const g = await guardFileToolPath(root, ctx, { tool: 'glob', write: false });
      if (!g.ok) return { ok: false, error: g.error, code: g.code, root };
      const rootBad = await toolRootProblem(root);
      if (rootBad) return rootBad;
      const walkRoot = guardedWalkRoot(root, g);   // 安全走查 S7:遍历用 realpath 根
      const rawPattern = String(args.pattern || '');
      if (!rawPattern) return { ok: false, code: 'invalid-arguments', error: 'pattern is required and must be non-empty', root, hint: '例如 "**/*.js" 或 "src/**/test_*.py"' };
      // 前导 ./ 与「落在 root 内的绝对路径 pattern」改写成相对 root 的写法;root 之外的绝对 pattern 配不到任何东西 —— 明说,别静默回空表。
      let gp = normalizeGlobPatternForRoot(rawPattern, root);
      if (gp.outside && walkRoot !== root) { const gpReal = normalizeGlobPatternForRoot(rawPattern, walkRoot); if (!gpReal.outside) gp = gpReal; }   // 绝对 pattern 按 realpath 根写的也认
      if (gp.outside) return { ok: true, root, files: [], truncated: false, patternNote: gp.note };
      const pattern = gp.pattern;
      if (!pattern) return { ok: false, code: 'invalid-arguments', error: 'pattern is empty after removing "./"', root, hint: '例如 "**/*.js" 或 "src/**/test_*.py"' };
      const maxResults = Number(args.maxResults) >= 1 ? Math.floor(Number(args.maxResults)) : 500;
      const globRe = globToRegExp(pattern);
      // F2:glob 在遍历时过滤(accept),maxFiles 只数【命中】的文件 —— 修前先按遍历顺序取前 max(4×maxResults,4000)
      // 个条目(含目录、无关文件)再事后匹配,前面塞满 __pycache__/.github 时 `**/*.md` 一个都找不到。
      const scanCap = Math.max(maxResults * 4, 4000);
      const all = await walkFiles(walkRoot, { signal: ctx && ctx.signal,
        recursive: true, maxFiles: scanCap, maxDepth: args.maxDepth != null ? Number(args.maxDepth) : 12,
        emitDirs: false, accept: rel => globRe.test(rel), ignoreDirs: args.ignoreDirs, includeIgnored: args.includeIgnored === true,
        allowDirs: explicitAllowDirs(walkRoot, explicitSegmentsOfGlob(pattern)),   // `dist/**/*.js` 点名了 dist → 不剪
      });
      respellWalkPaths(all, walkRoot, root);   // 第三波(复核 #6)
      const matched = all.filter(f => f.type === 'file').map(f => ({ path: f.path, relativePath: f.relativePath, mtime: f.mtimeMs || 0 }));
      matched.sort((a, b) => b.mtime - a.mtime);
      const truncated = matched.length > maxResults || all.truncated === true;
      // F12:相对路径 + 整数毫秒 mtime(修前是 1790785004440.1304 这种浮点);absolute:true 补绝对 path。
      const resp = { ok: true, root, files: matched.slice(0, maxResults).map(m => (args.absolute === true ? { relativePath: m.relativePath, path: m.path, mtime: m.mtime } : { relativePath: m.relativePath, mtime: m.mtime })), truncated };
      if (all.truncated) resp.hint = walkTruncationHint(all, 'glob') + ' (newest-first ordering only covers the files visited)';
      else if (matched.length > maxResults) resp.hint = 'glob: ' + matched.length + ' files matched, showing the newest ' + maxResults + '; raise maxResults or narrow the pattern/root';
      if (all.prunedDirs) { resp.prunedDirs = all.prunedDirs; resp.prunedHint = prunedDirsHint('glob'); }
      if (all.depthLimited) { resp.depthLimited = true; resp.depthCutDirs = all.depthCutDirs; resp.depthHint = walkDepthHint(all, 'glob'); }
      if (gp.note) resp.patternNote = gp.note;
      return resp;
  } },
  project_snapshot: { paths: "read", guardNote: '', handler: async (args, ctx) => {
      assertSearchExecution(ctx && ctx.signal);
      const root = await resolveFileToolRoot(args, ctx);
      // 第41波(41a 表驱动首擒):file_list/file_search/glob 都有读闸,唯独本工具没有 —— 远端模型可越界列目录。
      // 注册表声明让这条不对称现形,补上同族读闸(本地模型越界读仍放行,与 file_list 完全同闸,行为只收不松)。
      const g = await guardFileToolPath(root, ctx, { tool: 'project_snapshot', write: false });
      if (!g.ok) return { ok: false, error: g.error, code: g.code, root };
      const rootBad = await toolRootProblem(root);
      if (rootBad) return rootBad;
      const walkRoot = guardedWalkRoot(root, g);   // 安全走查 S7:遍历用 realpath 根
      // F2/F12:广度优先 + 共用忽略清单 —— 顶层条目永远先于任何子目录内容列出(修前 DFS 先到先得,
      // 本仓库上 300 个名额全被 .claude/worktrees 吃掉);信封只带相对路径。
      const walked = await walkFiles(walkRoot, { signal: ctx && ctx.signal, recursive: true, maxFiles: Number(args.maxFiles) >= 1 ? args.maxFiles : 300, maxDepth: args.maxDepth != null ? Number(args.maxDepth) : 4, bfs: true, ignoreDirs: args.ignoreDirs, includeIgnored: args.includeIgnored === true, allowDirs: explicitAllowDirs(walkRoot, []) });
      respellWalkPaths(walked, walkRoot, root);   // 第三波(复核 #6)
      const resp = { ok: true, root, files: walkEnvelopeEntries(walked, args.absolute === true) };
      if (walked.truncated) { resp.truncated = true; resp.hint = walkTruncationHint(walked, 'project_snapshot') + ' (entries are listed breadth-first: every top-level entry comes before deeper ones)'; }
      if (walked.prunedDirs) { resp.prunedDirs = walked.prunedDirs; resp.prunedHint = prunedDirsHint('project_snapshot'); }
      if (walked.depthLimited) { resp.depthLimited = true; resp.depthCutDirs = walked.depthCutDirs; resp.depthHint = walkDepthHint(walked, 'project_snapshot'); }
      return resp;
  } },
};

const ARCHIVE_TOOL_HANDLERS = {
  archive_zip: { paths: "both", guardNote: '', handler: async (args, ctx) => {
      assertFileToolActive(ctx);
    // v1.1-W2 (T1) archive_zip(paths[], dest): 打包工作区内文件/文件夹为 .zip（deflate，零 npm）。
    //   dest 已存在 → 存 before（op:modify，回滚=写回原 dest）；否则 op:create（回滚=删 dest）。
    //   单文件 100MB / 总量 500MB 上限（zipCollectEntries 内卡，超限人话拒绝）。
      const rawInputs = Array.isArray(args.paths) ? args.paths.filter(p => typeof p === 'string' && p.trim()) : [];
      const inputs = [];
      for (const raw of rawInputs) inputs.push(await resolveFileToolPath(raw, ctx));   // F1:相对路径按工作区解析
      const dest = await resolveFileToolPath(args.dest, ctx);
      if (!inputs.length) return { ok: false, error: 'paths 不能为空', hint: '给出要打包的文件或文件夹路径数组' };
      if (!args.dest) return { ok: false, error: 'dest 不能为空' };
      // 第27波对抗轮 P2(Gap B):打包【源】与【目标】都过工作区护栏 —— 此前 archive_zip/zipCollectEntries 对 paths[] 无任何
      // 边界检查(与 file_copy 的 from 侧护栏不对称),模型可 archive_zip({paths:['~/.ssh/id_rsa', dataRoot/config.json,
      // dataRoot/runtime.json], dest:工作区/a.zip})把敏感控制面/越界文件静默打包 → 解压 → file_read 出明文密钥+token。
      // 源按【读】判(敏感 denylist 恒拒 + 远端模型越界读拒);dest 按【写】判(越界写恒拒)。与 guardFileToolPath 同 sink。
      for (const raw of inputs) {
        const gp = await guardFileToolPath(path.resolve(String(raw)), ctx, { tool: 'archive_zip', write: false });
        if (!gp.ok) return { ok: false, error: gp.error, code: gp.code, path: raw };
      }
      { const gd = await guardFileToolPath(dest, ctx, { tool: 'archive_zip', write: true }); if (!gd.ok) return { ok: false, error: gd.error, code: gd.code, path: dest }; }
      // 2026-10 走查(R2):dest 是已存在的目录 —— 修前读它当「旧 zip」做检查点,抛裸 EISDIR。
      const destSt0 = await fsp.stat(dest).catch(() => null);
      if (destSt0 && destSt0.isDirectory()) return { ok: false, code: 'target_is_directory', error: 'dest 是一个已存在的目录,不是 .zip 文件', path: dest, hint: 'dest 要写成「目录/名字.zip」(含文件名)' };
      let entries;
      // F9:子目录默认按共用忽略清单剪枝(node_modules/.git/__pycache__/venv/dist/build …);exclude 追加目录名,
      // includeIgnored:true 全部放开。被剪掉的在结果里如实报告(skippedExcluded / excludedDirs)。
      // skipPaths:[dest] —— 输出文件自己不入包(dest 落在被打包的目录里时,第二次打包不再把上一次的 zip 装进去)。
      try { entries = await zipCollectEntries(inputs, { ignoreDirs: Array.isArray(args.exclude) ? args.exclude.filter(x => typeof x === 'string') : [], includeIgnored: args.includeIgnored === true, skipPaths: [dest], signal: ctx && ctx.signal }); }
      catch (e) { return { ok: false, ...(e.code === 'ABORT_ERR' ? { code: e.code } : {}), error: (e && e.message) || String(e) }; }
      if (!entries.length) return { ok: false, error: '没有可打包的文件（源为空、全是符号链接,或只有 dest 自己）', ...(entries.skippedLinks ? { skippedLinks: entries.skippedLinks } : {}) };
      assertFileToolActive(ctx);
      const zipBuf = await zipWriteAsync(entries, { signal: ctx && ctx.signal });   // F9:压缩走线程池 + 让出事件循环,不再同步卡住服务
      // 走查 W1·F8:已存在的旧 zip 先 stat、按检查点上限决定读不读(超限只记 skippedBytes 标记),不再不看大小整份读进内存。
      const destSt = await fsp.stat(dest).catch(() => null);
      const destExists = !!destSt;
      let destBefore = null;
      if (destSt) {
        try { destBefore = await fileToolBeforeForCheckpoint(dest, destSt.size); }
        catch (e) {
          if (e && e.code === 'ENOENT') destBefore = null;
          else { const f = fileToolFsFailure(e, dest); if (f) return f; throw e; }
        }
      }
      assertFileToolActive(ctx);
      const jctx = await journalSessionCtx(ctx);
      const jr = await journalRecord(jctx.sessionId, jctx.turnSeq, 'archive_zip', dest, destExists ? 'modify' : 'create', destExists ? destBefore : null);
      // 2026-10 走查(R2):原子写(同目录临时文件 + rename),与 file_write / file_edit 同一条路 —— 修前 writeFile 直写,
      // 中途失败(磁盘满 / 被占用)会留下半个 zip 并把旧包写坏;失败时撤掉刚记的检查点,把错误变成带 hint 的信封。
      let writeResult;
      try {
        assertFileToolActive(ctx);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        writeResult = await FileTextIo.writeFileAtomic(dest, zipBuf, { signal: ctx && ctx.signal });
      } catch (e) {
        const dropped = e.targetMayBeModified ? null : await fileToolDropPhantom(jctx, 'archive_zip', dest, jr);
        const f = fileToolFsFailure(e, dest, { checkpointRolledBack: !!(dropped && dropped.ok),
            ...(e.targetMayBeModified ? { checkpointRetained: !!(jr && jr.ok && Number.isFinite(jr.entrySeq)), checkpointWarn: journalCheckpointWarn(jr) } : {}) });
        if (f) return f;
        throw e;
      }
      const fileCount = entries.filter(e => !e.isDir).length;
      const checkpointWarn = journalCheckpointWarn(jr); // hunt2 #17
      return { ...fileToolCleanupFields(writeResult), ok: true, dest, op: destExists ? 'modify' : 'create', entries: entries.length, files: fileCount, bytes: zipBuf.length,
        // 被悄悄丢掉的东西如实报:符号链接(不入包,免得打进包外内容)、dest 自己、重复的输入、因同名而改了包内名字的输入。
        ...(entries.skippedLinks ? { skippedLinks: entries.skippedLinks, linksHint: 'symbolic links are never packed (they could point outside the packed folder)' } : {}),
        ...(entries.skippedDest ? { skippedDest: true, destHint: 'dest lies inside a packed folder; the output file itself was left out of the archive' } : {}),
        ...(entries.dedupedInputs.length ? { dedupedInputs: entries.dedupedInputs } : {}),
        ...(entries.renamedInputs.length ? { renamedInputs: entries.renamedInputs, renamedHint: 'inputs sharing a file name were stored under their parent folder names so they do not overwrite each other when extracted' } : {}),
        ...(entries.skippedSensitive ? { skippedSensitive: entries.skippedSensitive } : {}),
        ...(entries.skippedExcluded ? { skippedExcluded: entries.skippedExcluded, excludedDirs: entries.excludedDirs, excludedHint: 'directories such as node_modules/.git/__pycache__/dist were left out; pass includeIgnored:true to include them' } : {}),
        ...(checkpointWarn ? { checkpointWarn } : {}) };
  } },
  archive_unzip: { paths: "both", guardNote: '', handler: async (args, ctx) => {
      assertFileToolActive(ctx);
    // v1.1-W2 (T1) archive_unzip(src, destDir, overwrite=false): 解 .zip 到 destDir（stored/deflate）。
    //   【Zip Slip 防御·安全命门】每个条目 resolve 后必须仍在 destDir 内，任一 '..' 越界 → 整包拒绝（不解压任何文件）。
    //   符号链接条目跳过。条目数 ≤65534（zip 格式上限,65535 是 zip64 哨兵）、声明/解压累计 ≤500MB 且逐条核对大小与 CRC32（zip 炸弹，超限中止）；list:true 只列不解。
    //   覆盖到已存在文件时逐个 before 快照（op:modify，回滚=写回）；新建文件 op:create（回滚=删）。
      // F9:list:true 只列条目(名字/大小/编码)不解压 —— 中央目录本来就要解析,列出来几乎零成本;此时不需要 destDir。
      const listOnly = args.list === true;
      if (!args.src || (!listOnly && !args.destDir)) return { ok: false, error: listOnly ? 'src 不能为空' : 'src 与 destDir 都不能为空' };
      const src = await resolveFileToolPath(args.src, ctx);          // F1:相对路径按工作区解析
      const destDir = listOnly && !args.destDir ? '' : await resolveFileToolPath(args.destDir, ctx);
      // 第27波对抗轮 P2(Gap B):src 读、destDir 写都过工作区护栏(此前缺失)。src 敏感/越界 → 拒;destDir 越界 → 拒。
      // Zip Slip 逐条防御(下方)仍在,二者叠加:destDir 受限 + 每个解出的条目再验落在 destDir 内。
      { const gs = await guardFileToolPath(src, ctx, { tool: 'archive_unzip', write: false }); if (!gs.ok) return { ok: false, error: gs.error, code: gs.code, path: src }; }
      if (!listOnly) { const gdd = await guardFileToolPath(destDir, ctx, { tool: 'archive_unzip', write: true }); if (!gdd.ok) return { ok: false, error: gdd.error, code: gdd.code, path: destDir }; }
      const srcSt = await fsp.stat(src).catch(() => null);
      if (!srcSt) return { ok: false, error: '压缩包不存在', path: src, hint: '先用 file_list 确认路径' };
      // 2026-10 走查(R2):src 是目录 → is_directory 信封(修前是 readFile 的 EISDIR 原话);destDir 是已存在的文件 → not_a_directory。
      if (srcSt.isDirectory()) return fileToolFsFailure({ code: 'EISDIR', message: 'EISDIR' }, src);
      if (!listOnly) {
        const ddSt = await fsp.stat(destDir).catch(() => null);
        if (ddSt && !ddSt.isDirectory()) return { ok: false, code: 'not_a_directory', error: 'destDir 是一个已存在的文件,不是目录', path: destDir, hint: '换一个目录路径作为 destDir' };
      }
      if (srcSt.size > ZIP_MAX_TOTAL) return { ok: false, error: `压缩包超过大小上限（${Math.round(ZIP_MAX_TOTAL / 1024 / 1024)}MB）` };
      let buf, records;
      try { buf = await fsp.readFile(src); records = zipReadCentralDir(buf); }
      catch (e) { return { ok: false, ...(fileToolFsFailure(e, src) || {}), error: (e && e.message) || String(e) }; }
      assertFileToolActive(ctx);
      if (records.length > ZIP_MAX_ENTRIES) return { ok: false, error: `压缩包条目数超过上限（${ZIP_MAX_ENTRIES}）`, hint: '疑似 zip 炸弹，已拒绝' };
      // F9:炸弹防御看【体积】:解压前先把中央目录声明的总大小与最大单条核对(不用先展开)。修前只有 2000 条目上限,
      // archive_zip 自己打出的 2506 条目包都被拒;真正的炸弹(少数条目、体积巨大)靠这里与逐条 maxOutputLength 拦。
      let declaredTotal = 0;
      for (const rec of records) declaredTotal += rec.uncompSize;
      if (declaredTotal > ZIP_MAX_TOTAL) return { ok: false, error: `压缩包声明的解压总大小（${Math.round(declaredTotal / 1024 / 1024)}MB）超过上限（${Math.round(ZIP_MAX_TOTAL / 1024 / 1024)}MB）`, hint: '疑似 zip 炸弹，已拒绝' };
      if (listOnly) {
        const MAX_LIST = 500;
        const shown = records.slice(0, MAX_LIST).map(r => ({ name: r.name, size: r.uncompSize, compressedSize: r.compSize, ...(r.isDir ? { type: 'directory' } : {}), ...(r.isSymlink ? { symlink: true } : {}) }));
        const encs = [...new Set(records.map(r => r.nameEncoding))];
        return { ok: true, src, list: true, entryCount: records.length, totalBytes: declaredTotal, nameEncoding: encs.length === 1 ? encs[0] : encs.join('+'),
          entries: shown, ...(records.length > MAX_LIST ? { truncated: true, hint: `only the first ${MAX_LIST} of ${records.length} entries are shown` } : {}) };
      }
      // ---- 第一遍：安全校验（Zip Slip + 符号链接）。任一越界 → 整包拒绝，不落任何盘 ----
      const destReal = path.resolve(destDir);
      const plan = []; // {rec, absPath}
      for (const rec of records) {
        if (rec.isSymlink) continue; // 符号链接条目跳过（不解，安全）
        // 归一化条目名（'/' → 平台分隔），resolve 到 destDir 下，再验证仍在 destDir 内。
        const cleanName = String(rec.name).replace(/\\/g, '/').replace(/^\/+/, '');
        const target = path.resolve(destReal, cleanName);
        if (!pathWithinRoot(target, destReal)) {
          return { ok: false, error: '压缩包含越界路径（Zip Slip），已整包拒绝', entry: rec.name, hint: '该压缩包可能是恶意构造的，未解压任何文件' };
        }
        plan.push({ rec, absPath: target });
      }
      // 2026-10 走查(R2):包内路径自相矛盾(`f` 是文件、`f/g.txt` 又要求 f 是目录)→ 落任何盘之前就整包拒绝。
      // 修前写到冲突那条才抛 EEXIST,前面已写的文件留在盘上、而且没有任何报告。
      {
        const fk = x => (String(x));
        const destKey = fk(destReal);
        const fileEntries = new Map();
        const dirKeys = new Set();
        for (const { rec, absPath } of plan) {
          if (rec.isDir || rec.name.endsWith('/')) dirKeys.add(fk(absPath)); else fileEntries.set(fk(absPath), rec.name);
          let d = path.dirname(absPath);
          while (fk(d) !== destKey && fk(d).startsWith(destKey) && d !== path.dirname(d)) { dirKeys.add(fk(d)); d = path.dirname(d); }
        }
        for (const [k, name] of fileEntries) {
          if (dirKeys.has(k)) return { ok: false, code: 'entry_conflict', error: `压缩包内的条目路径互相冲突:「${name}」既被当作文件、又被当作其它条目的上级目录`, entry: name, filesExtracted: 0, hint: '这个包本身有问题(同一路径既是文件又是目录),未解压任何文件' };
        }
      }
      // 安全审计 #4:词法落在 destDir 内还不够 —— destDir 是家目录 / 工作区时,包里的 data/config.json、
      // ws/.git/hooks/pre-commit、.claude/settings.json 同样「在 destDir 内」,修前照写不误(实测覆写了配置、种下了
      // git hook)。每个条目(含目录条目)在【落任何盘之前】逐个过文件工具的同一个写闸(敏感/受保护数据、autoexec、
      // OS 关键目录、写根包含、悬空链接);任一被拒 → 整包拒绝,一个文件都不写。配置只读一次,别让 2000 个条目各读一遍盘。
      {
        let entryCtx = ctx;
        if (!(ctx && ctx.config)) { let cfg = {}; try { cfg = await readConfig(); } catch { cfg = {}; } entryCtx = { ...(ctx || {}), config: cfg }; }
        for (const { rec, absPath } of plan) {
          const ge = await guardFileToolPath(absPath, entryCtx, { tool: 'archive_unzip', write: true });
          if (!ge.ok) {
            return { ok: false, error: `压缩包内的条目落点被拒绝,已整包拒绝(未解压任何文件):${ge.error}`, code: ge.code, entry: rec.name, path: absPath, filesExtracted: 0 };
          }
        }
      }
      // ---- 第二遍：逐条解压 + 检查点。累计字节卡 500MB（zip 炸弹二次防御，inflate 后累加）----
      assertFileToolActive(ctx);
      const jctx = await journalSessionCtx(ctx);
      const written = [];
      let extractedBytes = 0;
      let checkpointWarn = '';
      // hunt2 #13:检查点攒批记(journalRecordMany,一批只读写一次索引),修前每个文件整份读改写一次索引,
      // 2000 个条目实测 ~22s。纪律不变:一批的检查点先落,再写这一批的文件;失败返回前先把已备好的一批落完,
      // 「已写 N 个」的计数与盘上一致。按条数/字节分批,内存不随整包增长。
      let pending = [], pendingBytes = 0;
      // 2026-10 走查(R2):落盘失败(包里 `f` 文件与 `f/g.txt` 互相冲突 → EEXIST / ENOTDIR、占用、磁盘满…)不再抛出裸异常 ——
      // 修前写了一半的文件无人报告。记在 writeErr 里:这一批里没写成的条目撤掉它们的检查点(描述的是没发生的写入),
      // 之后的 flush 变成空操作,调用方统一经 failWithWritten 回 {ok:false, partial:true, filesExtracted:N}。
      let writeErr = null;
      const flush = async () => {
        if (ctx?.signal?.aborted && !writeErr) {
          writeErr = { e: Object.assign(new Error('Archive extraction cancelled'), { code: 'ABORT_ERR' }), absPath: pending[0]?.absPath || destDir };
        }
        if (writeErr) { pending = []; pendingBytes = 0; return; }
        if (!pending.length) return;
        const batch = pending;
        pending = []; pendingBytes = 0;
        const results = await journalRecordMany(jctx.sessionId, jctx.turnSeq, batch.map(b => ({
          tool: 'archive_unzip', filePath: b.absPath, op: b.exists ? 'modify' : 'create', beforeContent: b.exists ? b.before : null })));
        for (const r of results) if (!checkpointWarn) checkpointWarn = journalCheckpointWarn(r); // hunt2 #17
        for (let bi = 0; bi < batch.length; bi += 1) {
          const b = batch[bi];
          try {
            assertFileToolActive(ctx);
            await fsp.mkdir(path.dirname(b.absPath), { recursive: true });
            assertFileToolActive(ctx);
            await fsp.writeFile(b.absPath, b.data);
          } catch (e) {
            writeErr = { e, absPath: b.absPath, name: b.name };
            const rest = batch.slice(bi);
            const seqs = rest.map((_, k) => results[bi + k] && results[bi + k].entrySeq).filter(Number.isFinite);
            if (seqs.length) await journalDropEntries(jctx.sessionId, jctx.turnSeq, 'archive_unzip', rest.map(x => x.absPath), seqs).catch(() => ({ ok: false }));
            return;
          }
          written.push(b.absPath);
        }
      };
      const failWithWritten = async (msg, extra) => {
        await flush();
        // b2-P1: 部分解压失败必须带 written 计数 —— 模型/用户需要知道已落盘多少文件才能准确回滚/清理
        const o = { ok: false, error: msg, filesExtracted: written.length, bytesExtracted: extractedBytes, ...(extra || {}) };
        if (writeErr) {
          // 落盘失败优先于调用方想说的话:带上哪个条目、什么原因(并给 code/hint)。
          const f = fileToolFsFailure(writeErr.e, writeErr.absPath);
          Object.assign(o, { ...(writeErr.e?.code === 'ABORT_ERR' ? { code: 'ABORT_ERR' } : {}), error: `解压写入失败: ${(writeErr.e && writeErr.e.message) || String(writeErr.e)}`, path: writeErr.absPath, ...(writeErr.name ? { entry: writeErr.name } : {}), ...(f ? { code: f.code, hint: f.hint } : {}) });
        }
        if (written.length) o.partial = true;
        if (checkpointWarn) o.checkpointWarn = checkpointWarn;
        return o;
      };
      for (const { rec, absPath } of plan) {
        if (ctx?.signal?.aborted) return failWithWritten('Archive extraction cancelled');
        if (rec.isDir || rec.name.endsWith('/')) {
          try { await fsp.mkdir(absPath, { recursive: true }); }
          catch (e) { await flush(); writeErr = writeErr || { e, absPath, name: rec.name }; return failWithWritten('目录条目创建失败'); }
          continue;
        }
        if (writeErr) return failWithWritten('解压写入失败');
        let data;
        try { data = await zipReadEntryDataAsync(buf, rec); }   // F9:异步解压 + CRC32/大小核对
        catch (e) { return failWithWritten((e && e.message) || String(e), { entry: rec.name }); }
        extractedBytes += data.length;
        if (extractedBytes > ZIP_MAX_TOTAL) return failWithWritten(`解压总大小超过上限（${Math.round(ZIP_MAX_TOTAL / 1024 / 1024)}MB）`, { hint: '疑似 zip 炸弹，已中止' });
        // 同一批里前面的条目还没落盘:同名条目(包里重复的路径)先把前一批落完再判存在,免得 exists 判错。
        if (pending.some(b => fileToolWriteLockKey(b.absPath) === fileToolWriteLockKey(absPath))) { await flush(); if (writeErr) return failWithWritten('解压写入失败'); }
        const exSt = await fsp.stat(absPath).catch(() => null);
        const exists = !!exSt;
        if (exists && !args.overwrite) return failWithWritten('目标文件已存在', { path: absPath, hint: '若要覆盖请设置 overwrite=true' });
        // 目标位置是个目录(包里的文件名与已有目录同名):读它当「旧内容」做检查点会抛 EISDIR —— 明说冲突。
        if (exSt && exSt.isDirectory()) return failWithWritten('目标位置已存在同名目录,无法写成文件', { path: absPath, entry: rec.name, code: 'target_is_directory', hint: '包内的这个文件名与磁盘上的目录冲突;换一个 destDir,或先移走该目录' });
        // 走查 W1·F8:同 file_delete / file_write —— 已存在的目标按检查点上限先 stat 再决定读不读(超限记 skippedBytes 标记)。
        let before = null;
        if (exSt) {
          try { before = await fileToolBeforeForCheckpoint(absPath, exSt.size); }
          catch (e) { if (!(e && e.code === 'ENOENT')) { const f = fileToolFsFailure(e, absPath); return failWithWritten('读取已存在的目标文件失败', { path: absPath, ...(f ? { code: f.code, hint: f.hint } : {}) }); } }
        }
        pending.push({ absPath, exists, before, data, name: rec.name });
        pendingBytes += data.length + (before && Buffer.isBuffer(before) ? before.length : 0);
        if (pending.length >= 200 || pendingBytes >= 32 * 1024 * 1024) { await flush(); if (writeErr) return failWithWritten('解压写入失败'); }
      }
      await flush();
      if (writeErr) return failWithWritten('解压写入失败');
      return { ok: true, src, destDir, files: written.length, bytes: extractedBytes,
        ...(records.some(r => r.nameEncoding === 'gb18030') ? { namesDecodedAs: 'gb18030' } : {}), ...(checkpointWarn ? { checkpointWarn } : {}) };
  } },
};

// root 或它往上几级有没有 .gitignore(只为 file_search 零命中时的那一句提示,不求精确)。
async function nearestGitignore(root) {
  let dir = path.resolve(String(root || ''));
  for (let i = 0; i < 8; i += 1) {
    if (await fsp.stat(path.join(dir, '.gitignore')).then(st => st.isFile(), () => false)) return true;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}
// 遍历/扫描类工具的 root 必须是一个已存在的目录:修前 root 写错(不存在、或是一个文件)时 file_list/glob/
// file_search/project_snapshot/各类扫描一律回 ok:true + 空结果,模型把「路径写错了」读成「这里什么都没有」。
// 安全走查 S7:遍历类工具(file_list / file_search / glob / project_snapshot / 各审计与符号检索)拿 guardFileToolPath 返回的【realpath】当遍历根。
// 修前守门只校验了 root 参数的 realpath,遍历却按【词法】根走:工作区里一个指向数据根的符号链接 / 联接 linkdir 当 root 时,守门看到的
// realpath 恰好等于允许根 dataRoot 本身(放行),而 walkFiles 的敏感子树剔除、rg 的 !glob、结果层过滤全是按 linkdir\config.json 这种词法路径比的,
// 认不出它就是数据根里的 config.json —— 明文密钥与 token 被搜出来。换成 realpath 之后三处过滤看到的都是真实数据根路径。
// 信封里回显的 root 仍是调用方给的写法(只换遍历用的那一份);守门没给 absPath(不该发生)时退回原 root。
function guardedWalkRoot(root, g) {
  return (g && typeof g.absPath === 'string' && g.absPath) ? g.absPath : root;
}
// 第三波(复核 #6):遍历用的是 realpath 根,但回给模型的路径必须保持【调用方的写法】—— 映射盘 `Z:\proj` 的 realpath 是 `\\fileserver\dept\proj`,
// 若把后者原样交给模型,它再拿去 file_read / file_edit 就会撞上 UNC 外联闸(那是用户自己配的工作区);符号链接 / 联接工作区同理(别名换成了真身)。
// 遍历结果里凡是以 walkRoot 开头(且下一个字符是分隔符或到此为止)的字符串,把这段前缀换回 root;walkRoot 与 root 相同时什么都不做。
// 就地改写并返回同一个对象(数组上挂的 engine / truncated 之类元数据不丢)。敏感名单 / 硬链接判据必须在改写【之前】按 realpath 判。
function respellWalkPaths(value, walkRoot, root) {
  const from = String(walkRoot == null ? '' : walkRoot).replace(/[\\/]+$/, '');
  const to = String(root == null ? '' : root).replace(/[\\/]+$/, '');
  if (!from || from === to || !value || typeof value !== 'object') return value;
  const fix = str => (str === from || ((str[from.length] === '\\' || str[from.length] === '/') && str.startsWith(from))) ? to + str.slice(from.length) : str;
  let budget = 200000;
  const visit = (node, depth) => {
    if (depth > 8) return;
    const keys = Array.isArray(node) ? node.keys() : Object.keys(node);
    for (const k of keys) {
      if (--budget < 0) return;
      const v = node[k];
      if (typeof v === 'string') node[k] = fix(v);
      else if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  visit(value, 0);
  return value;
}
async function toolRootProblem(root) {
  let st = null;
  try { st = await fsp.stat(root); } catch { st = null; }
  if (!st) return { ok: false, code: 'not_found', error: `目录不存在: ${root}`, hint: '确认 root 拼写(相对路径接在当前工作目录下),或省略 root 使用当前工作目录。', root };
  if (!st.isDirectory()) return { ok: false, code: 'not_a_directory', error: `root 是一个文件,不是目录: ${root}`, hint: '读单个文件用 file_read;要在它所在的目录里找,把 root 设成那个目录(可配 glob 只看这个文件)。', root };
  return null;
}

  return { FILE_TOOL_HANDLERS, ARCHIVE_TOOL_HANDLERS, fileToolBeforeForCheckpoint, fileToolPrivacySourceOptions, fileToolFsFailure, guardedWalkRoot, respellWalkPaths, toolRootProblem };
}
module.exports = { createFileTools, fileMoveSameFileKind };
