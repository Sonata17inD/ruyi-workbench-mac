'use strict';
const path = require('node:path');
const fsp = require('node:fs/promises');
const { pathWithinRoot } = require('./path-containment.cjs');
const SENSITIVE_NAMES = Object.freeze(['config.json', 'runtime.json', 'sessions', 'memory', 'usage', 'logs', 'generated', 'agent-runs',
    'steward', 'missions', 'scheduler', 'migrations', 'engine-transcripts.json', 'credential-vault-v1.json', 'credential-import-v1.json', 'privacy-scopes', 'external-bot-credentials.json', 'external-bots', 'desktop']);
const BACKUP_FILES = Object.freeze(['config.json', 'credential-vault-v1.json', 'credential-import-v1.json', 'external-bot-credentials.json']);
function isBackupName(name, includeOriginal = true) {
  const value = String(name).toLowerCase();
  return BACKUP_FILES.some(file => (includeOriginal && value === file) || value.startsWith(file + '.'));
}
function createSensitivePaths({ dataRoot, dataRootAliases }) {
let dataRootReal = null;
async function ensureDataRootReal() {
  if (!dataRootReal) {
    const root = dataRoot();
    dataRootReal = await fsp.realpath(root).catch(() => root);
  }
  return dataRootReal;
}
function sensitiveDataRoots() {
  return [...new Set([dataRoot(), ...(dataRootReal ? [dataRootReal] : []), ...dataRootAliases()])];
}
function isSensitiveDataPath(p) {
  if (!p) return false;
  // Mac ownership is outside the data root so long paths and data migration cannot split its lock.
  // Reserve the full namespace (including /tmp's canonical alias) before workspace/bypass exceptions.
  if (/^\/(?:System\/Volumes\/Data\/)?(?:private\/)?tmp\/ruyi-serve-v1-\d+(?:\/|$)/i.test(String(p))) return true;
  // 3.0 收口走查(第四波):先按 Windows 语义把每段的 NTFS 流后缀(`config.json::$DATA` 就是 config.json 的默认数据流,
  // `sessions::$INDEX_ALLOCATION\x` 就是 sessions\x)与尾随点 / 空格(`config.json.` → config.json)去掉再比。修前带后缀的串
  // 词法上判成「不在 config.json 里」、文件名正则也不中 → 敏感闸被绕过(第三波只给 autoexec 闸加了同样的剥离)。盘符段(`C:`)保留;
  // Windows 文件名除盘符外不可能有冒号,POSIX 上带冒号的怪名字只会被保守地并到前缀上,只会多拦不会漏。
  p = String(p).split(/([\\/])/).map(seg => (/^[a-z]:$/i.test(seg) || seg === '/' || seg === '\\') ? seg : seg.replace(/:.*$/, '').replace(/([^. ])[. ]+$/, '$1')).join('');
  // 敏感子路径(相对 dataRoot):明文密钥 config.json、token runtime.json、会话/记忆/计费/审计/工作流状态/带 token 的
  // 生成配置。不含 uploads/checkpoints/webcache/skills/playbooks/agent-worktrees —— 那些是用户产物/内容,合法可读。
  // 安全走查 S7:再补 steward/(管家收件箱 / 记忆 / 决策:用户的私人上下文)、missions/(事项容器)、scheduler/(定时任务载荷)、
  // migrations/(迁移日志:含从别的 CLI 搬过来的配置片段)、engine-transcripts.json(各引擎回合转写索引)。逐个读过码:全是数据根下
  // 工作台自己拥有的内部数据,没有任何文件工具的合法读取场景 —— 界面与管家工具走各自的 API,不经 guardFileToolPath。
  // 【有意不进】checkpoints/:检查点的 before 快照内容本来就是模型自己改过的文件(用户让模型「看一下改之前长什么样」是合法读),
  // 且只在写侧受保护(WRITE_PROTECTED_DATA_DIRS);unit/write-guard-autoload.test.js 钉着「检查点内容仍可 file_read」。
  const names = SENSITIVE_NAMES;
  // 3.0:迁移后旧目录名是指回数据根的联接(00-boot dataRootAliases),经它的词法路径同样要命中。
  const bases = sensitiveDataRoots();
  for (const b of bases) for (const n of names) if (pathWithinRoot(p, path.join(b, n))) return true;
  // 2026-09-06：config.json 的备份族（config.json.prev / config.json.bak-<日期> / config.json.bak-providers-<ts>）
  // 与正本一样含明文密钥；audit-w23 P1#2 探针实测 file_search 能把 .prev 里的 apiKey 搜出来。
  // 凡是直接落在 dataRoot 下、文件名以 config.json 开头的，一律视为敏感。
  try {
    const base = path.basename(p);
    if (isBackupName(base)) {
      const dir = path.resolve(path.dirname(p));
      for (const b of bases) if (dir.toLowerCase() === path.resolve(b).toLowerCase()) return true;
    }
  } catch { /* 非法路径按不敏感处理，由其它围栏兜底 */ }
  return false;
}
// 安全走查 S7(硬链接):isSensitiveDataPath 是按路径(词法 / realpath)比的,工作区里 `ln config.json hard.json` 造出的硬链接
// 是同一个 inode 的另一个名字,路径上与数据根毫无关系 —— file_read / file_search / archive_zip 都会把里面的明文密钥读出来。
// 所以对两份最要命的文件(config.json 明文 provider 密钥、runtime.json WCW token)再按 dev+ino 比一道:
//   · 只有 nlink > 1 的文件才可能是它们的别名,所以调用方先看 nlink(遍历热路径上不为此给每个文件多 stat 一次);
//   · ino 拿不到(0n / 缺失,个别网络盘 / 非 NTFS 文件系统)时不挡 —— 宁可漏一个极罕见的别名,也不误伤正常文件;
//   · Use bigint device/inode identities without Number precision loss.
const SENSITIVE_HARDLINK_FILES = Object.freeze([...BACKUP_FILES, 'runtime.json', 'privacy-scopes', 'external-bots/state-v1.json']);
async function sensitiveFileIdentities() {
  const ids = new Set();
  let root = '';
  try { root = dataRoot(); } catch { return ids; }
  // 第三波(复核 #10):config.json 的备份族(.prev / .bak-* / .bak-providers-* / .corrupt)同样含真 key,硬链接别名一并比;名字族与 isSensitiveDataPath 同一条(/^config\.json(\.|$)/)。
  let names = SENSITIVE_HARDLINK_FILES;
  try { names = [...new Set([...SENSITIVE_HARDLINK_FILES, ...(await fsp.readdir(root)).filter(n => isBackupName(n, false))])]; } catch { /* 读不了目录:只比已知正本 */ }
  try { names = [...new Set([...names, ...(await fsp.readdir(path.join(root, 'external-bots'))).filter(n => /^state-v1\.json\./i.test(n)).map(n => path.join('external-bots', n))])]; } catch { /* No inbox ledger has been created yet. */ }
  try { names = [...new Set([...names, ...(await fsp.readdir(path.join(root, 'privacy-scopes'))).filter(n => /^[a-f0-9]{64}\.json(?:\.|$)/.test(n)).map(n => path.join('privacy-scopes', n))])]; } catch { /* No privacy map has been created yet. */ }
  for (const name of names) {
    try {
      const st = await fsp.stat(path.join(root, name), { bigint: true });
      if (st.isFile() && st.ino) ids.add(String(st.dev) + ':' + String(st.ino));
    } catch { /* 文件不存在:没有可比对的 */ }
  }
  return ids;
}
// st 是 bigint stat。ids 缺省时现取。
async function isSensitiveHardlinkStat(st, ids) {
  try {
    if (!st || !st.isFile() || !(st.nlink > 1n) || !st.ino) return false;
    const set = ids || await sensitiveFileIdentities();
    return set.has(String(st.dev) + ':' + String(st.ino));
  } catch { return false; }
}
async function isSensitiveHardlinkAlias(filePath, ids) {
  try { return await isSensitiveHardlinkStat(await fsp.stat(filePath, { bigint: true }), ids); }
  catch { return false; }
}
function sensitiveGlobsForRg(base) {
  const globs = [];
  if (path.sep === '/') {
    for (const directory of ['/private/tmp', '/tmp', '/System/Volumes/Data/private/tmp', '/System/Volumes/Data/tmp']) {
      const relative = path.relative(base, directory);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        globs.push('!/' + (relative ? relative + '/' : '') + 'ruyi-serve-v1-[0-9]*/');
      }
    }
  }
  try {
    // Search exclusion and direct access share SENSITIVE_NAMES and the same root aliases.
    // 遍历根已换成 guardFileToolPath 给的 realpath,词法数据根与它不一定同一拼法(联接 / 短名 / 大小写),只认词法会让 !glob 落空。
    const roots = sensitiveDataRoots();
    for (const r of roots) {
      for (const n of SENSITIVE_NAMES) {
        const rel = path.relative(base, path.join(r, n));
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) globs.push('!/' + rel.split(path.sep).join('/'));
      }
      const relRoot = path.relative(base, r);
      if (!relRoot.startsWith('..') && !path.isAbsolute(relRoot)) {
        const prefix = '!/' + (relRoot ? relRoot.split(path.sep).join('/') + '/' : '');
        for (const name of BACKUP_FILES) globs.push(prefix + name + '*');
      }
    }
  } catch { /* 取不到数据根 → 只剩结果层过滤 */ }
  return globs;
}

return { ensureDataRootReal, sensitiveDataRoots, isSensitiveDataPath, sensitiveFileIdentities, isSensitiveHardlinkStat, isSensitiveHardlinkAlias, sensitiveGlobsForRg };
}
module.exports = { createSensitivePaths };
