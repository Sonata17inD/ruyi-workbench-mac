'use strict';
const path = require('node:path');
const fsp = require('node:fs/promises');
const { ZIP_MAX_SINGLE_FILE, ZIP_MAX_TOTAL, ZIP_MAX_ENTRIES, zipTopLevelNames } = require('./archive-codec.cjs');

function createArchiveCollector({ ensureDataRootReal, isSensitiveDataPath, isSensitiveHardlinkAlias, buildIgnoreMatcher, DOTNET_PROJECT_RE }) {
// 收集要打包的路径（文件或文件夹）→ 一个 {name, data} 平面列表。name 是 ZIP 内的相对路径（'/' 分隔）。
// baseName = 该顶层路径在包内的根名（文件夹用其 basename，文件用 basename）。递归遍历文件夹；符号链接跳过。
// 累计大小 > ZIP_MAX_TOTAL 或单文件 > ZIP_MAX_SINGLE_FILE → 抛人话错误（调用方转 {ok:false}）。
// F9:子目录按共用忽略清单剪枝(node_modules/.git/__pycache__/venv/dist/build/… —— 「打包这个项目」不该把它们装进去);
// 用户【显式】传入的顶层路径不剪;opts.ignoreDirs 追加、opts.includeIgnored 全部放开(仍剪 .git/.svn/.hg 之外的都进包)。
// 被剪掉的计入 entries.skippedExcluded / entries.excludedDirs,由调用方说出来。
async function zipCollectEntries(rootPaths, opts = {}) {
  const assertActive = () => {
    if (opts.signal?.aborted) throw Object.assign(new Error('Archive collection cancelled'), { code: 'ABORT_ERR' });
  };
  assertActive();
  const entries = []; // {name, data:Buffer, isDir}
  let total = 0;
  // hunt2 #3:敏感控制面逐项过滤。archive_zip 只对顶层输入过护栏,打包一个【祖先目录】(典型:工作区 = 家目录,
  // 数据根 ~/.ruyi-workbench 就在里面)会把 config.json(明文密钥)/runtime.json(token)/会话一并装进包,解压后
  // file_read 即得明文 —— 实测端到端打通。与 walkFiles 同一条规矩(审计 P1):敏感子树不返回、不下钻。
  await ensureDataRootReal();
  entries.skippedSensitive = 0;
  entries.skippedExcluded = 0;
  entries.excludedDirs = [];
  const ignore = buildIgnoreMatcher({ includeIgnored: opts.includeIgnored === true, ignoreDirs: opts.ignoreDirs });
  // 2026-10 走查(R2):① skipPaths(dest 自己)不入包 —— 修前 dest 落在被打包的目录里,第二次打包就把上一次的 zip 也装进去(越滚越大);
  // ② 符号链接仍不入包,但计数上报(skippedLinks),不再静默;③ 同名顶层输入的包内名字去重(见 zipTopLevelNames)。
  const foldP = x => (String(x));
  const skipSet = new Set((Array.isArray(opts.skipPaths) ? opts.skipPaths : []).map(x => foldP(path.resolve(String(x)))));
  entries.skippedLinks = 0;
  entries.skippedDest = false;
  entries.dedupedInputs = [];
  entries.renamedInputs = [];
  const addFile = async (absPath, zipName, relFromTop) => {
    assertActive();
    if (skipSet.has(foldP(path.resolve(absPath)))) { entries.skippedDest = true; return; }
    if (isSensitiveDataPath(absPath)) { entries.skippedSensitive += 1; return; }
    const st = await fsp.lstat(absPath);
    if (st.isSymbolicLink()) { entries.skippedLinks += 1; return; } // 安全：符号链接不入包（避免打进包外内容）
    if (st.isFile() && st.nlink > 1 && await isSensitiveHardlinkAlias(absPath)) { entries.skippedSensitive += 1; return; } // 安全走查 S7:config.json / runtime.json 的硬链接别名不入包
    if (st.isDirectory()) {
      entries.push({ name: zipName.replace(/\/?$/, '/'), data: Buffer.alloc(0), isDir: true });
      const kids = await fsp.readdir(absPath, { withFileTypes: true });
      const dotnetDir = ignore.dotnet && kids.some(k => !k.isDirectory() && DOTNET_PROJECT_RE.test(k.name));
      kids.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const kid of kids) {
        const kidRel = relFromTop ? relFromTop + '/' + kid.name : kid.name;
        if (kid.isDirectory() && ignore.pruneName(kid.name, kidRel, dotnetDir)) {
          entries.skippedExcluded += 1;
          if (entries.excludedDirs.length < 12 && !entries.excludedDirs.includes(kidRel)) entries.excludedDirs.push(kidRel);
          continue;
        }
        await addFile(path.join(absPath, kid.name), zipName + '/' + kid.name, kidRel);
      }
      return;
    }
    if (!st.isFile()) return;
    if (st.size > ZIP_MAX_SINGLE_FILE) throw new Error(`单个文件超过上限（${Math.round(ZIP_MAX_SINGLE_FILE / 1024 / 1024)}MB）：${path.win32.basename(absPath)}`);
    total += st.size;
    if (total > ZIP_MAX_TOTAL) throw new Error(`打包总大小超过上限（${Math.round(ZIP_MAX_TOTAL / 1024 / 1024)}MB）`);
    if (entries.length >= ZIP_MAX_ENTRIES) throw new Error(`条目数超过 zip 格式上限（${ZIP_MAX_ENTRIES}）;请缩小打包范围,或用 exclude 追加要跳过的目录名`);
    const data = await fsp.readFile(absPath, { signal: opts.signal });
    assertActive();
    entries.push({ name: zipName, data, isDir: false });
  };
  // 顶层输入去重 + 包内名字(同名的保留相对结构)。
  const uniq = [];
  const seenTop = new Set();
  for (const raw of rootPaths) {
    const abs = path.resolve(String(raw));
    if (seenTop.has(foldP(abs))) { entries.dedupedInputs.push(abs); continue; }
    seenTop.add(foldP(abs));
    uniq.push(abs);
  }
  const topNames = zipTopLevelNames(uniq);
  for (let i = 0; i < uniq.length; i += 1) {
    const abs = uniq[i];
    const st = await fsp.lstat(abs).catch(() => null);
    if (!st) throw new Error(`路径不存在：${abs}`);
    if (topNames[i] !== path.win32.basename(abs)) entries.renamedInputs.push({ path: abs, zipName: topNames[i] });
    await addFile(abs, topNames[i], '');
  }
  // 兜底:仍有重名条目(例如 ['d1', 'd1/n.txt'] 被改名后撞上 d1 里的 n.txt)—— 一个包里两个同名条目解压时后者静默覆盖前者,宁可拒绝。
  const seenNames = new Map();
  for (const e of entries) {
    const k = foldP(e.name);
    if (seenNames.has(k)) throw new Error(`包内出现重名条目「${e.name}」:打包的路径之间有重叠或同名;请分开打包,或去掉重复的路径`);
    seenNames.set(k, true);
  }
  assertActive();
  return entries;
}
  return { zipCollectEntries };
}
module.exports = { createArchiveCollector };
