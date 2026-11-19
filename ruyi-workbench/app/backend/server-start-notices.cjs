'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

// 118c: 启动体验。两件用户看得见的事,都通过 GET /api/status 的【一个】只读字段 startNotice 上线:
//   ① 上一次启动【失败】过 -- 失败时把人话写进 <data>/last-start-error.json,下一次成功启动读出来、
//      交给前端顶部条,读完立刻删文件(所以它天然是一次性的,不会反复骚扰)。
//   ② 本次启动【改用了别的端口】 -- 原端口被非工作台进程占着,自动往后找到第一个能用的。
// 选 /api/status 而不是新开一条路由:前端 boot 本来就必调 status,零新增路由、零新增鉴权判定点,
// route-inventory 不动;两个字段都是进程内常量派生,不读盘、不做任何探测。
const LAST_START_ERROR_FILE = 'last-start-error.json';
// 端口自动改用的搜索宽度:原端口 +1 .. +9。够覆盖「本机同时开了几个自建服务」的现实场景,
// 又不会在真的全被占满时无限试下去(九个都不行时报错并留下 last-start-error.json)。
const PORT_FALLBACK_SPAN = 9;
// 只认这三类:端口拿不到 / 数据目录写不进 / 其它启动异常。文件里出现别的 kind 一律当作损坏丢弃。
const START_ERROR_KINDS = Object.freeze(['port-unavailable', 'data-dir-unwritable', 'startup-failed']);

function createServerStartNotices({ paths, DesktopExecutionHooks, atomicWriteJson, nowIso, safeJsonParse }) {
  const START_NOTICE = { lastError: null, portFallback: null };

  // 「怎么办」一句话。刻意不给命令行、不给要用户自己去开的路径:能在如意里做的事就指向如意里的入口。
  function startErrorNextText(kind) {
    if (kind === 'port-unavailable') return '先关掉占着这些端口的那个程序(常见是另一个本机服务),再启动一次如意。';
    if (kind === 'data-dir-unwritable') return '磁盘可能满了,或者数据文件夹被安全软件锁住了。腾出一些空间后再启动一次如意。';
    return '再启动一次通常就好。如果一直起不来,在「帮助 → 查看日志」里把最后几行发给支持人员。';
  }

  // 失败落盘。best-effort:数据目录本身写不进时这一步当然也会失败,那就只剩 console 输出 --
  // 这正是「数据目录不可写」这一类的诚实下限,绝不假装记下了。
  async function writeStartError(kind, message) {
    const safeKind = START_ERROR_KINDS.includes(kind) ? kind : 'startup-failed';
    try {
      if (!DesktopExecutionHooks.canWriteStartupError()) return;
      await fsp.mkdir(paths.data, { recursive: true });
      if (!DesktopExecutionHooks.canWriteStartupError()) return;
      await atomicWriteJson(path.join(paths.data, LAST_START_ERROR_FILE), {
        at: nowIso(),
        kind: safeKind,
        message: String(message || '').slice(0, 800),
        next: startErrorNextText(safeKind),
      });
    } catch { /* 记不下就算了:失败信息此刻已经在 console 上 */ }
  }

  // 读出并删除。返回归一化后的记录(或 null)。删除放在读之后、判定之前:即使内容坏了也要清掉,
  // 否则一份损坏的文件会永远赖在数据目录里。
  async function consumeStartError() {
    const file = path.join(paths.data, LAST_START_ERROR_FILE);
    let raw = null;
    try { raw = safeJsonParse(await fsp.readFile(file, 'utf8'), null); } catch { raw = null; }
    try { await fsp.unlink(file); } catch { /* 没有这份文件是最常见的情况 */ }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const kind = String(raw.kind || '');
    if (!START_ERROR_KINDS.includes(kind)) return null;
    return {
      at: String(raw.at || ''),
      kind,
      message: String(raw.message || '').slice(0, 800),
      next: String(raw.next || '').slice(0, 800) || startErrorNextText(kind),
    };
  }

  // One listen attempt on an explicit port. Extracted from listenWithFallback so the 118c fallback scan can
  // reuse it. A failed listen leaves the server unbound, so calling it again on another port is legal.
  function listenOnce(server, port, host) {
    return new Promise((resolve, reject) => {
      const onErr = e => { server.removeListener('listening', onOk); reject(e); };
      const onOk = () => { server.removeListener('error', onErr); resolve(); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, host);
    });
  }

  // 118c: 原端口拿不到时,顺序试 port+1 .. port+PORT_FALLBACK_SPAN,第一个能监听的就用它,并把
  // 「原端口 -> 实际端口」登记进 START_NOTICE 让前端顶部条说清楚(「已改用 8766(原 8765 被占用)」)。
  // 全部不可用才抛错,错误带上 ruyiStartErrorKind 供 startServer 写 last-start-error.json。
  // 返回值是【实际】端口:runtime.json、控制台 URL、--open 一律用它,不存在「文件写 8765 实际在 8766」的分裂。
  async function listenOnNextFreePort(server, port, host, why) {
    for (let step = 1; step <= PORT_FALLBACK_SPAN; step++) {
      const candidate = port + step;
      if (candidate > 65535) break;
      try {
        await listenOnce(server, candidate, host);
        START_NOTICE.portFallback = { requested: port, actual: candidate };
        console.log(`[port] :${port} unavailable (${why}) -- listening on :${candidate} instead.`);
        return candidate;
      } catch (e) {
        if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
      }
    }
    const error = new Error(`${why} 随后自动改用的 ${port + 1}-${port + PORT_FALLBACK_SPAN} 端口也全部不可用。`);
    error.ruyiStartErrorKind = 'port-unavailable';
    throw error;
  }

  // Leave the incumbent process alone and try nearby ports when the requested port is occupied.
  // 118c: 每一条「拿不到原端口」的岔路都不再是死路 -- 统一交给 listenOnNextFreePort 往后找。
  // 自动接管被禁用时同样往后找:那个开关的语义是「不许杀别人的进程」,不是「必须占住这个端口不放」。
  async function listenWithFallback(server, port, host) {
    const attempt = () => listenOnce(server, port, host);
    try { await attempt(); return port; }
    catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      // 62: ownership is decided before recovery by the data-directory IPC gate.
      // A listening process is never made "stale" by a runtime.json record; do not kill it.
      return await listenOnNextFreePort(server, port, host,
        `端口 ${port} 已被占用，没有结束占用它的进程。`);
    }
  }

  return { START_NOTICE, writeStartError, consumeStartError, listenWithFallback };
}

module.exports = { createServerStartNotices, START_ERROR_KINDS };
