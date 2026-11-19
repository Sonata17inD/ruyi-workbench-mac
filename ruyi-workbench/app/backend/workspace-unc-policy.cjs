'use strict';
const os = require('node:os');

// 安全走查 W1(UNC 外联):`\\攻击者\share\x`(或 `//攻击者/share/x`)在 Windows 上被 realpath / readFile / writeFile 一碰就会去连那台主机的
// SMB —— 既是绕过 web_fetch SSRF 闸的无提示外传通道(宽写档下 file_write 直接写出去),也会把本机用户的 NTLM 哈希递给对方。
// 所以文件工具的读写闸对【非本机】UNC 路径一律拒绝,而且必须在任何 I/O(realpath 本身就会连网)【之前】判;唯一的例外是这条路径
// 本身落在用户配置的某个工作区根之内(用户自己把网络共享配成了工作区 / 工作文件夹),纯词法判。读、写、本地模型、allowOutsideWorkspace、
// 宽写档都一视同仁 —— 这道闸排在所有逃生舱之前。
//   · 本机主机名(localhost / 127.0.0.1 / ::1 / 本机名)不算外联:`\\localhost\C$\…` 由 normalizeGuardPath 映回盘符后照旧过各道地板;
//   · `\\?\C:\…`、`\\.\C:\…`(设备命名空间的本地盘)不是 UNC,不在此列;`\\?\UNC\主机\共享` 是。
// 正斜杠起头的 `//主机/共享` 只在 Windows 上当 UNC 认(POSIX 上 `//usr/lib` 就是 /usr/lib)。
function uncHostAndPath(p, forwardSlash) {
  const s = String(p == null ? '' : p);
  const fwd = !!forwardSlash;
  const isSep = ch => ch === '\\' || (fwd && ch === '/');
  if (s.length < 3 || !isSep(s[0]) || !isSep(s[1])) return null;
  let rest = s.slice(2);
  // 第三波(复核 #5):`\\.\UNC\主机\共享` 与 `\\?\UNC\…` 是同一个东西(`UNC` 是 \GLOBAL?? 下指向 \Device\Mup 的符号链接,`\\.\` 与 `\\?\` 都映射到它),
  // 再加 `\\?\Global\UNC\…`。其余设备命名空间写法(GLOBALROOT\Device\Mup\… 等)这里不当 UNC 解析,由 deviceNamespaceIsLocalVolume 一律按远端拒。
  const ext = /^[?.][\\/]+(?:Global[\\/]+)?UNC[\\/]+(.*)$/i.exec(rest);
  if (ext) rest = ext[1];
  else if (/^[?.](?:[\\/]|$)/.test(rest) || isSep(rest[0])) return null;   // \\?\C:\ 与 \\.\device;三个及以上的分隔符不是 UNC
  const segs = [];
  for (const seg of rest.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (segs.length > 2) segs.pop(); continue; }   // 不爬出 主机\共享 两段
    segs.push(seg.replace(/[. ]+$/, ''));
  }
  if (!segs.length || !segs[0]) return null;
  const host = segs[0].toLowerCase().replace(/^\[|\]$/g, '');
  // 第三波(复核 #6):`\\wsl$\发行版` 与 `\\wsl.localhost\发行版` 是同一个 WSL 共享的两种拼法(Windows 11 的 realpath 可能把前者还原成后者)。
  // host 原样保留(本机主机名判据不受影响),只在【比较用的 norm】里把两种拼法并成一个,工作区例外按 norm 比。
  const normSegs = host === 'wsl$' ? ['wsl.localhost', ...segs.slice(1)] : segs;
  return { host, norm: ('\\\\' + normSegs.join('\\')).toLowerCase() };
}
function uncIsLocalHost(host) {
  const h = String(host || '').toLowerCase();
  let me = '';
  try { me = (os.hostname ? os.hostname() : '').toLowerCase(); } catch { me = ''; }
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || (me !== '' && h === me);
}
// 第三波(复核 #5):设备命名空间前缀(`\\?\` / `\\.\` / NT 写法 `\??\`)后面接的东西,只有「盘符 `X:`」与「`Volume{GUID}`」(可带 `Global\`)是本地卷;
// 其余一律按远端(`\\?\GLOBALROOT\Device\Mup\…`、`\\.\pipe\…`、UNC 别名以外的未知写法)—— 文件工具没有任何理由去碰这些。
// 返回 null(不是设备命名空间写法)/ true(本地卷)/ false(其余)。UNC 别名写法由 uncHostAndPath 先认出主机,不走这里。
function deviceNamespaceIsLocalVolume(p, forwardSlash) {
  const s = String(p == null ? '' : p);
  const fwd = !!forwardSlash;
  const isSep = ch => ch === '\\' || (fwd && ch === '/');
  let rest = null;
  if (s.length >= 4 && isSep(s[0]) && isSep(s[1]) && (s[2] === '?' || s[2] === '.') && isSep(s[3])) rest = s.slice(4);
  else if (s.length >= 4 && s[0] === '\\' && s[1] === '?' && s[2] === '?' && s[3] === '\\') rest = s.slice(4);
  if (rest === null) return null;
  return /^(?:Global[\\/]+)?(?:[A-Za-z]:(?:[\\/]|$)|Volume\{[0-9a-fA-F-]+\}(?:[\\/]|$))/i.test(rest);
}
// 返回 '' = 不拦;否则是拒绝原因。candidates:要判的几种拼法(原串 / resolve 后 / realpath 后),任一是越界 UNC 即拒。
// extraRoots:调用方已经 realpath 过的 UNC 工作区根(见 remoteUncDenialResolved)—— 例外同时认「字面拼法」与「realpath 拼法」。
function remoteUncDenial(candidates, session, config, forwardSlash, extraRoots) {
  const hits = [];
  for (const c of candidates) {
    const u = uncHostAndPath(c, forwardSlash);
    if (u && !uncIsLocalHost(u.host)) hits.push(u);
    else if (!u && deviceNamespaceIsLocalVolume(c, forwardSlash) === false) hits.push({ host: '(device-namespace)', norm: '\\\\?\\' + String(c).toLowerCase() });
  }
  if (!hits.length) return '';
  const roots = [];
  const push = r => { const u = typeof r === 'string' ? uncHostAndPath(r.trim(), forwardSlash) : null; if (u && !uncIsLocalHost(u.host)) roots.push(u.norm); };
  if (session && typeof session.cwd === 'string') push(session.cwd);
  if (config && typeof config.defaultWorkspace === 'string') push(config.defaultWorkspace);
  for (const w of (config && Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [])) push(w);
  for (const w of (config && Array.isArray(config.workspaces) ? config.workspaces : [])) { if (w && typeof w === 'object') push(w.path); }
  for (const r of (Array.isArray(extraRoots) ? extraRoots : [])) push(r);
  for (const u of hits) {
    if (!roots.some(r => u.norm === r || u.norm.startsWith(r + '\\'))) return u.host;
  }
  return '';
}

function createRemoteUncDenial({ realpathForContainment }) {
  // 第三波(复核 #6):工作区根可能是「映射盘 Z:\」「\\wsl$\…」「DFS 名字空间」—— 它们的 realpath(GetFinalPathNameByHandle)是另一种拼法
  // (\\fileserver\dept\…、\\wsl.localhost\…、\\目标服务器\…)。纯词法的例外只认字面,于是工具回给模型的 realpath 拼法路径再喂回来就被当成「别人的共享」。
  // 所以【只在字面判据要拒的时候】才把配置里的工作区根逐个 realpath(用户自己配的根;每个最多等 3 秒,连不上就当没有),
  // 把其中仍是非本机 UNC 的拼法并进例外再判一次。热路径(绝大多数调用字面判据就放行)零额外 I/O。
  async function realUncWorkspaceRoots(session, config) {
    const raw = [];
    if (session && typeof session.cwd === 'string') raw.push(session.cwd);
    if (config && typeof config.defaultWorkspace === 'string') raw.push(config.defaultWorkspace);
    for (const w of (config && Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [])) raw.push(w);
    for (const w of (config && Array.isArray(config.workspaces) ? config.workspaces : [])) { if (w && typeof w === 'object') raw.push(w.path); }
    const out = [];
    for (const r of [...new Set(raw.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))].slice(0, 32)) {
      let real = '';
      try { real = await Promise.race([realpathForContainment(r), new Promise(resolve => setTimeout(() => resolve(''), 3000).unref())]); } catch { real = ''; }
      const u = real ? uncHostAndPath(real) : null;
      if (u && !uncIsLocalHost(u.host)) out.push(real);
    }
    return out;
  }
  async function remoteUncDenialResolved(candidates, session, config) {
    const first = remoteUncDenial(candidates, session, config);
    if (!first) return '';
    let extra = [];
    try { extra = await realUncWorkspaceRoots(session, config); } catch { extra = []; }
    return extra.length ? remoteUncDenial(candidates, session, config, undefined, extra) : first;
  }

  return remoteUncDenialResolved;
}

module.exports = { createRemoteUncDenial, remoteUncDenial, uncHostAndPath, uncIsLocalHost };
