'use strict';

const http = require('node:http');
const { json, send, sendError } = require('./http-protocol.cjs');

function createWorkbenchHttpServer({
  APP_NAME, VERSION, OVERLAY_ID, getLaunchMode, recordRequestMetric, hostAllowed, handleApi, serveStatic, logEvent,
}) {
  return http.createServer(async (req, res) => {
    const reqT0 = Date.now(); // 第40波:请求耗时插桩(res finish 时入账,/health 不计 —— 高频探针会淹没真分布)
    res.on('finish', () => { try { const u0 = new URL(req.url, 'http://x'); if (u0.pathname !== '/health') recordRequestMetric(req.method, u0.pathname, Date.now() - reqT0); } catch { /* 观测不阻断 */ } });
    // 防嵌入(点击劫持):任何响应都不许被别的页面放进 iframe。工作台页面从不被框:Mac 桌面壳 WKWebView 是顶层导航,
    // 文件预览里的 HTML 产物是 sandbox + srcdoc(about:srcdoc,不受这两个头约束)。两个头都发:X-Frame-Options 给老内核,
    // frame-ancestors 给现代内核(与 index.html 里 meta 的 CSP 是叠加关系,互不替代 —— meta 里的 frame-ancestors 本来就不生效)。
    // 先 setHeader 再让各路由的 writeHead 合并:路由自己写了同名头则以路由为准。
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    // 安全走查 S6:禁止浏览器按内容嗅探 MIME(把 text/plain 的回包当 HTML/脚本执行)。静态资源的 content-type 由
    // contentTypeFor 给全(html/css/js/json/图片),/api 一律 application/json,SSE 是 text/event-stream,不会被它误伤。
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      // 第33波:顶层 host 门(DNS-rebinding 防御覆盖全 GET 面 + 静态 /,治第29波 backlog #0)。hostAllowed 之前
      // 只在 originOk(mutating 块)内调用,GET 与 serveStatic 跳过 -> index.html 的 token 可被 rebinding 页读走。
      // 此处一律拦非 loopback Host;所有合法调用方(e2e/MCP 子/CLI/浏览器)连 127.0.0.1:PORT,Host 已是 loopback。
      if (!hostAllowed(req)) return send(res, json({ ok: false, error: 'host not allowed' }, 403));
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      // Liveness + restart proof: version alone can't prove a restart, so echo the per-process overlay id.
      if (u.pathname === '/health') {
        return send(res, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'x-workbench-version': VERSION, 'x-overlay-id': OVERLAY_ID },
          body: JSON.stringify({ ok: true, app: APP_NAME, version: VERSION, overlayId: OVERLAY_ID, launchMode: getLaunchMode(), uptimeSec: Math.round(process.uptime()) }) });
      }
      if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u.pathname);
      return send(res, await serveStatic(u.pathname, req));
    } catch (err) {
      // 128f-①(用户首启走查第二句「查看日志诊断似乎显示不出具体原因」):漏到这里的异常修前只回一个 500,日志里
      // 一个字没有 ——「在如意里看日志」看不到它。现在记一条 http_unhandled:方法、路径(不带查询串)、状态、错误名、
      // 消息(截断)、栈前 6 帧。SyntaxError 只留引号前那半句:Node 的 JSON.parse 会把请求体原文引进消息里,
      // 那里面可能有密钥(比如一发写坏了的配置保存)。help-menu.e2e ⑤b 钉。
      try {
        const name = String((err && err.name) || 'Error');
        let message = String((err && err.message) || err || '');
        if (name === 'SyntaxError') message = message.split(/["']/)[0].replace(/[\s,]+$/, '') + ' (content not logged)';
        logEvent({ kind: 'http_unhandled', method: req.method, path: String(req.url || '').split('?')[0].slice(0, 200),
          status: (err && err.statusCode) || 500, name, message: message.slice(0, 500),
          stack: String((err && err.stack) || '').split('\n').slice(1, 7).map(s => s.trim()) });
      } catch { /* 日志是旁路,不许挡住回包 */ }
      return sendError(res, err);
    }
  });
}

module.exports = { createWorkbenchHttpServer };
