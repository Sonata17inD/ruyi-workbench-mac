'use strict';

const { URL } = require('node:url');
const fsp = require('node:fs/promises');
const path = require('node:path');

function createNetworkToolHandlers({
  UNC_DENIED_ERROR, readConfig, httpDownloadTool, httpRequest, webFetch, webSearch, launch, policy,
}) {
  const { buildBrowserOpenSpawn, isBrowserDocumentTarget, spawnDetachedChecked } = launch;
  const { httpRequestTargetsWorkbench, openToolUncDenied } = policy;

  const NETWORK_TOOL_HANDLERS = {
    web_search: { paths: null, guardNote: "纯网络读;searchBackend 为管理端可信端点(SSRF 豁免录在案 v0.9-S9)", handler: async (args, ctx) => {
      // v0.9-S9 (D6): web_search reads searchBackend from config (baseUrl is the admin's TRUSTED endpoint →
      // exempt from SSRF; see the web section header). web_fetch's url is UNTRUSTED → SSRF-guarded inside.
        const cfg = await readConfig().catch(() => ({ searchBackend: { type: 'none' } }));
        return webSearch(args, cfg, { signal: ctx && ctx.signal });
    } },
    web_fetch: { paths: null, guardNote: "纯网络读,SSRF 全套护栏内置(ssrfCheck/dnsResolvesToPrivate 逐跳)", handler: async (args, ctx) => {
        const config = await readConfig().catch(() => ({}));
        return webFetch(args, { signal: ctx && ctx.signal, config });   // 用户 Stop / 插话要能取消进行中的抓取
    } },
    http_request: { paths: null, guardNote: "纯网络调用,不触文件路径", handler: async (args, ctx) => {
        // 3.0 收口走查(第四波):不许经这个工具调如意【自己】的本机接口 —— 那里有 /api/permission/decision、/api/tools/*、会话与记忆读接口,
        // 模型经它就能自己批自己的权限、绕开文件闸读别的线程(token-browser 对无 Origin 的回环请求免 token)。与 04 剥掉桥接 MCP 的
        // WCW_TOKEN 是同一条线。工作台内部的回环调用(agentToolLoopback 等)直接用 httpRequest,不经这个工具,不受影响。
        if (httpRequestTargetsWorkbench(args && args.url)) {
          return { ok: false, error: '不能用 http_request 调用如意自己的本机接口', failClass: 'blocked', hint: '要查看或操作如意自身的状态,请用对应的如意工具(例如 workbench_self_status),或请用户在界面上操作' };
        }
        return httpRequest(args, { signal: ctx && ctx.signal });
    } },
    http_download: httpDownloadTool,
    browser_open: { paths: null, guardNote: "spawn 默认浏览器(buildBrowserOpenSpawn 无 shell);exec tier 门,不触文件路径", handler: async (args, ctx) => {
        const target = String(args.url || '').trim();
        if (!target) return { ok: false, error: 'url is required', hint: '传一个 http(s) 网址或本地 .html 文件路径' };
        // 以 `-` 开头的值会被浏览器当成命令行开关(--renderer-cmd-prefix=… 这类),不是网址。
        if (target.startsWith('-')) return { ok: false, error: 'url 不能以 - 开头', target };
        if (await openToolUncDenied(target, ctx)) return { ok: false, code: 'not-allowed', error: UNC_DENIED_ERROR, target };
        let openTarget = target;
        let localUrl = null;
        if (process.platform === 'darwin' && !/^https?:/i.test(target)) {
          try {
            localUrl = /^file:/i.test(target) ? new URL(target) : null;
            const localPath = localUrl ? require('url').fileURLToPath(localUrl) : path.resolve(target);
            openTarget = await fsp.realpath(localPath);
          } catch (error) { return { ok: false, code: error.code || 'invalid_args', error: '无法解析要打开的本地浏览器路径', target }; }
        }
        // 网址 / 本地 HTML 之外只放行【文件夹】(资源管理器打开)。修前 calc.exe、.bat 之类的路径会落到系统关联打开 = 执行。
        if (!isBrowserDocumentTarget(openTarget)) {
          const st = await fsp.stat(path.resolve(openTarget)).catch(() => null);
          if (!(st && st.isDirectory())) {
            return { ok: false, error: 'browser_open 只打开网址(http/https/file)、本地 .html 文件或文件夹', target, hint: '打开文档用 office_open;运行程序用命令工具' };
          }
        }
        // Shell-free and non-destructive: URLs/local HTML open in an explicit new browser tab where the
        // default-browser executable is available; folders keep the safe Explorer handoff behavior.
        let handoffTarget = openTarget;
        if (localUrl && isBrowserDocumentTarget(openTarget)) {
          const canonicalUrl = require('url').pathToFileURL(openTarget);
          canonicalUrl.search = localUrl.search; canonicalUrl.hash = localUrl.hash;
          handoffTarget = canonicalUrl.href;
        }
        const s = buildBrowserOpenSpawn(handoffTarget);
        // 默认浏览器路径可能是注册表里的残留(已卸载):失败走普通工具失败,不再成为 uncaughtException。
        const started = await spawnDetachedChecked(s.command, s.args, { detached: true, stdio: 'ignore' });
        if (!started.ok) return { ok: false, error: `无法启动浏览器 ${s.command}:${started.error}`, target, browserMode: s.mode };
        if (s.mode === 'file-selection') return { ok: true, opened: false, revealed: target, browserMode: s.mode, preservedWorkbench: true };
        return { ok: true, opened: target, browserMode: s.mode, preservedWorkbench: s.preservesWorkbench };
    } },
  };

  return { NETWORK_TOOL_HANDLERS };
}

module.exports = { createNetworkToolHandlers };
