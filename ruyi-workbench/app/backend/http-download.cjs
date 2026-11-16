'use strict';
const path = require('node:path');
const fsp = require('node:fs/promises');
const { ssrfCheck } = require('./network-policy.cjs');
const { httpGetGuarded } = require('./http-transport.cjs');
const { webFetchFailMessage } = require('./http-request.cjs');
const HTTP_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
function createHttpDownload({ guardFileToolPath, loadSession, isMcpChild,
  fileToolBeforeForCheckpoint, journalSessionCtx, journalRecord, journalCheckpointWarn, markNetworkOnline }) {
// ── http_download 的文件名与错误翻译 ──────────────────────────────────────────────────────────────────────────
// dest 是文件夹(已存在的目录,或以 / \ 结尾)时,文件存进这个文件夹里,名字取 Content-Disposition 的 filename(优先 RFC 5987 的 filename*),
// 没有就取最终 URL 路径的最后一段,再没有叫 download。名字只留「一个文件名」:去掉任何目录部分(path.win32.basename 同时认 \ 与 /)、
// Windows 不允许的字符、保留设备名,并限长 —— 服务器给的名字不可信,不能借它跳出 dest 目录。
function downloadFileNameFrom(contentDisposition, finalUrl) {
  let name = '';
  const cd = String(contentDisposition || '');
  let m = /filename\*\s*=\s*(?:UTF-8|utf-8)?'[^']*'([^;]+)/i.exec(cd);
  if (m) { try { name = decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch { name = m[1].trim(); } }
  if (!name) { m = /filename\s*=\s*"([^"]*)"/i.exec(cd) || /filename\s*=\s*([^;]+)/i.exec(cd); if (m) name = m[1].trim(); }
  if (!name) {
    try { const seg = new URL(String(finalUrl || '')).pathname.split('/').filter(Boolean).pop() || ''; name = decodeURIComponent(seg); } catch { /* 取不到就用兜底名 */ }
  }
  name = path.win32.basename(String(name || '').replace(/\0/g, ''));
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').replace(/^\.+$/, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)) name = '_' + name;
  if (name.length > 150) { const ext = path.extname(name).slice(0, 20); name = name.slice(0, 150 - ext.length) + ext; }
  return name || 'download';
}
// fs 写盘失败的人话(原样的 EISDIR / ENAMETOOLONG 对模型没有可行动的信息)。
function describeFsWriteError(e, target) {
  const code = (e && e.code) || '';
  const msg = {
    EISDIR: '目标路径是一个文件夹,不能当文件写',
    ENAMETOOLONG: '文件名或路径太长(请缩短文件名或目录路径)',
    EACCES: '没有写入权限',
    EPERM: '没有写入权限(文件可能是只读,或被系统保护)',
    ENOENT: '目标路径的某一级不存在或无法创建',
    ENOTDIR: '目标路径中有一段是文件而不是文件夹',
    ENOSPC: '磁盘空间不足',
    EBUSY: '文件正被其它程序占用',
    EROFS: '目标位置是只读的',
  }[code] || ((e && e.message) || '写入失败');
  return { ok: false, code: code || 'write_failed', error: `无法保存到 ${target}:${msg}`, path: target };
}

// v1.1-W2 (T1) — http_download 的落盘目标护栏。thread 进来的 ctx 可能带 session/config（provider 引擎路径）
// 或不带（MCP child 路径）。带 → 走 guardWorkspacePath（realpath + fileAllowedRoots）；不带 → 退化护栏：
// dest 的父目录必须在 dataRoot 或 process.cwd 下（与文件工具「落盘落在工作区」同精神，绝不写系统任意路径）。
// 返回 {ok, absPath?} 或 {ok:false, error}。dest 尚不存在时对其父目录做包含判定。
// 安全审计 #3:修前两条路都比 file_write 松 —— 带 ctx 走的是 guardWorkspacePath(读根集合,不查 autoexec / OS 关键目录,
// ws\.git\hooks\pre-commit 照下不误);不带 ctx(MCP 子进程、tool_invoke_edit、不带 sessionId 的 /api/tools/http_download)
// 只看父目录在不在 dataRoot / process.cwd 下,连敏感名单都没查,实测直接盖掉了 <dataRoot>\config.json。现在两条路都走
// 文件工具的同一个【写】闸 guardFileToolPath(敏感/受保护数据 + autoexec + OS 关键目录三层地板,写根包含判定,宽写档
// 语义一致)。ctx 缺会话时按 file_* 工具在 MCP 子进程里的同一口径补:WCW_SESSION_ID 指向的会话 cwd;MCP 子进程
// 连它也没有时,子进程的 cwd 就是 CLI 给的会话工作目录(沿用修前「当前工作目录可下」的那一半,但它在 serve 进程
// 里是安装目录,所以只在 MCP 子进程认)。配置照旧由 guardFileToolPath 在缺 ctx.config 时从盘读。
async function guardDownloadDest(rawDest, ctx) {
  const dest = String(rawDest || '');
  if (!dest || !path.isAbsolute(dest)) return { ok: false, error: '下载目标必须是绝对路径' };
  const abs = path.resolve(dest);
  let gctx = ctx || null;
  if (!(gctx && gctx.session)) {
    let session = null;
    const sid = (gctx && gctx.sessionId) || process.env.WCW_SESSION_ID || '';
    if (sid) { try { session = await loadSession(String(sid)); } catch { session = null; } }
    if (!session && isMcpChild()) session = { cwd: process.cwd() };
    if (session) gctx = { ...(gctx || {}), session };
  }
  const g = await guardFileToolPath(abs, gctx, { tool: 'http_download', write: true });
  if (!g.ok) return { ok: false, error: g.error || '下载目标不在允许的工作区内', code: g.code };
  return { ok: true, absPath: g.absPath };
}

const httpDownloadTool = { paths: "write", guardNote: '', handler: async (args, ctx) => {
    // v1.1-W2 (T1) http_download(url, dest, maxBytes=100MB,上限即 100MB): 下载文件到工作区。复用 web_fetch 的 SSRF 全套护栏
    //   （httpGetGuarded：逐跳 ssrfCheck + dnsResolvesToPrivate）。dest 过工作区路径护栏（guardDownloadDest）。
    //   dest 已存在 → before 快照（op:modify，回滚=写回）；新建 op:create（回滚=删）。Content-Length 与实收都卡 maxBytes。
      const url = String(args.url || '').trim();
      if (!url) return { ok: false, error: 'url 不能为空' };
      if (!args.dest) return { ok: false, error: 'dest 不能为空' };
      const maxBytesAsked = Number(args.maxBytes) || 100 * 1024 * 1024;
      const maxBytes = Math.min(HTTP_DOWNLOAD_MAX_BYTES, Math.max(1, maxBytesAsked));
      // 走查 W1·F9:maxBytes 被 HTTP_DOWNLOAD_MAX_BYTES(100MB)夹住 —— 只能调小、不能放宽。修前超限提示说「增大 maxBytes」,模型照做(甚至传 10GB)
      // 仍被同一个 100MB 拒绝,反复失败。现在按「是否已到硬上限」给不同的话,到顶了就指向别的办法。
      const mbOf = n => Math.round(n / 1024 / 1024);
      const tooBig = () => ({
        error: `文件超过大小上限（${mbOf(maxBytes)}MB）` + (maxBytesAsked > HTTP_DOWNLOAD_MAX_BYTES ? `（传入的 maxBytes 超过单文件硬上限,已按 ${mbOf(HTTP_DOWNLOAD_MAX_BYTES)}MB 处理）` : ''),
        maxBytesCap: HTTP_DOWNLOAD_MAX_BYTES,
        hint: maxBytes < HTTP_DOWNLOAD_MAX_BYTES
          ? `可把 maxBytes 调大重试(最多 ${mbOf(HTTP_DOWNLOAD_MAX_BYTES)}MB)`
          : `已是单文件硬上限 ${mbOf(HTTP_DOWNLOAD_MAX_BYTES)}MB,再调大 maxBytes 也不会放宽;更大的文件请改用 shell_run（curl --output）下载,或让用户手动下载`,
      });
      // ① SSRF 前置拒绝（与 webFetch 同：内网/回环/非 http(s) 一律不发包）。
      const pre = ssrfCheck(url);
      if (!pre.allowed) return { ok: false, error: pre.reason, blocked: pre.host };
      // ② 落盘目标护栏（工作区内）。
      const rawDest = String(args.dest);
      const guard = await guardDownloadDest(rawDest, ctx);
      if (!guard.ok) return { ok: false, error: guard.error, ...(guard.code ? { code: guard.code } : {}) };
      let dest = guard.absPath;
      // dest 是文件夹:已存在的目录,或以 / \ 结尾(path.resolve 会吞掉结尾分隔符,所以看原始串)—— 文件存进去,名字取响应头 / URL。
      // 修前:已存在的目录直接抛裸 EISDIR;`x/newdir/` 悄悄写成一个叫 newdir 的文件。
      const destStat = await fsp.stat(dest).catch(() => null);
      const intoDir = /[\\/]$/.test(rawDest) || !!(destStat && destStat.isDirectory());
      if (intoDir && destStat && !destStat.isDirectory()) {
        return { ok: false, code: 'ENOTDIR', error: `dest 以 / 结尾表示文件夹,但 ${dest} 是一个已存在的文件`, hint: '去掉结尾的分隔符,或换一个文件夹路径' };
      }
      // ③ 下载（httpGetGuarded 逐跳 SSRF + DNS 重绑定防御 + Content-Length 预拒 + maxBytes 实收截断）。
      // timeoutMs:空闲超时(多久没收到数据就放弃)。修前只有这一道 —— 对端每秒滴一个字节能把下载拖到天荒地老(timeoutMs:1500 实测跑了 9 秒以上);
      // 现在显式给了 timeoutMs 就同时是整个下载的总期限,没给则空闲 30s、总期限 30 分钟(大文件慢网也够用)。ctx.signal = 用户 Stop,取消下载。
      const idleMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 30000;
      const totalMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 30 * 60 * 1000;
      const got = await httpGetGuarded(url, { maxBytes, timeoutMs: idleMs, totalTimeoutMs: totalMs, rejectOverMaxBytes: true, signal: (ctx && ctx.signal) || null });
      if (got.blocked) return { ok: false, error: got.error, blocked: got.blocked };
      if (got.failClass === 'too-big') return { ok: false, ...tooBig(), contentLength: got.contentLength };
      if (!got.ok || !got.body) {
        const mapped = webFetchFailMessage(got);
        return { ok: false, error: mapped.error, failClass: got.failClass || 'other', statusCode: got.statusCode, ...(mapped.hint ? { hint: mapped.hint } : {}) };
      }
      // 实收字节卡上限：httpGetGuarded 在 maxBytes 处截断并置 truncated → 视为超限拒绝（不落半截文件）。
      if (got.truncated) return { ok: false, ...tooBig() };
      let pathForJournal = path.resolve(rawDest);
      if (intoDir) {
        dest = path.join(dest, downloadFileNameFrom(got.contentDisposition, got.finalUrl || url));
        pathForJournal = dest;
        // 拼出的完整路径再过一遍写闸(名字已清洗成单个文件名,这里是兜底)。
        const g2 = await guardDownloadDest(dest, ctx);
        if (!g2.ok) return { ok: false, error: g2.error, ...(g2.code ? { code: g2.code } : {}) };
        dest = g2.absPath;
      }
      // ④ 检查点 + 落盘。fs 的失败(EISDIR / ENAMETOOLONG / EACCES …)翻成 {ok:false, code, error},不再把裸异常甩出去。
      let exists = false, before = null, jr = null;
      try {
        const st2 = await fsp.stat(dest).catch(() => null);
        if (st2 && st2.isDirectory()) return { ok: false, code: 'EISDIR', error: `${dest} 是一个文件夹,不能当文件写`, hint: '给 dest 一个文件名,或以 / 结尾表示存进该文件夹' };
        exists = !!st2;
        before = exists ? await fileToolBeforeForCheckpoint(dest, st2.size) : null;   // 走查 W1·F8:先 stat,超检查点上限的旧文件不整份读进内存
        const jctx = await journalSessionCtx(ctx);
        jr = await journalRecord(jctx.sessionId, jctx.turnSeq, 'http_download', pathForJournal, exists ? 'modify' : 'create', exists ? before : null);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, got.body);
      } catch (e) {
        return describeFsWriteError(e, dest);
      }
      markNetworkOnline(); // 成功下载 = 在线证据，顺手刷新能力缓存
      const ret = { ok: true, path: dest, bytes: got.body.length, contentType: (got.contentType || null), op: exists ? 'modify' : 'create' };
      if (got.decodedFrom) ret.decodedFrom = got.decodedFrom;   // 服务器回了压缩体,落盘的是解压后的内容
      // b2-P2: 200 但返回 HTML(常见于「错误页伪装成 200」/登录页/验证页)且目标非 .html/.htm 时提示 —— 防止模型误把网页当二进制文件
      const ct = String(got.contentType || '');
      const destExt = path.extname(dest).toLowerCase();
      if (/text\/html/i.test(ct) && !['.html', '.htm'].includes(destExt)) {
        ret.note = `服务器返回 text/html 且目标扩展名不是 .html —— 可能下载到了错误页/登录页/验证页,请核对内容。`;
      }
      const warn = journalCheckpointWarn(jr); // hunt2 #17
      if (warn) ret.checkpointWarn = warn;
      return ret;
  } };
return { httpDownloadTool, guardDownloadDest };
}
module.exports = { createHttpDownload };
