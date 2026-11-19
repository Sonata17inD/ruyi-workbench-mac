'use strict';
const crypto = require('node:crypto');
const { ROUTE_AUTH } = require('./http-route-policy.cjs');

// Runtime identity is supplied by the listener owner; token rotation is observed at request time.
function createHttpAuthorization(RUNTIME) {
// CSRF/local-RCE defense. Same-origin browser requests carry a matching Origin; cross-site pages
// carry a foreign Origin (reject). Non-browser callers (curl, the MCP child) carry no Origin.
// v1.4.6-S1 (DNS-rebinding defense): the Host header MUST be exactly this local server's loopback
// authority. A DNS-rebinding page reaches us with Host = attacker-domain:port (its own Origin would then
// "self-match" that Host, which is why the old self-consistency check let it through). By pinning Host to
// 127.0.0.1/localhost/[::1] : RUNTIME.port we reject any rebound name outright. Node/CLI callers connect
// straight to 127.0.0.1:port, so their Host header already matches — no legitimate caller is affected.
function hostAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const p = RUNTIME.port;
  return host === `127.0.0.1:${p}` || host === `localhost:${p}` || host === `[::1]:${p}`;
}
// 安全走查 S13:Host 头是客户端自己写的,挡不住「绑了非回环地址 + 远端把 Host 写成 127.0.0.1:PORT」。
// 所以再加一层看【TCP 对端地址】(req.socket.remoteAddress,内核给的,改不了):127.0.0.0/8、::1、::ffff:127.x 才算本机。
// `--host` 绑非回环本来就要显式 `--allow-remote`(见 13 的 resolveBindHost);即使放行,非本机对端也拿不到 token
// (/api/bootstrap 与页面里的 token 注入都拒),其余接口一律要带头 token。没有 socket 的测试替身按本机算;
// 有 socket 却读不出对端地址(连接已断)按非本机算,偏安全。
function isLoopbackAddress(addr) {
  const a = String(addr == null ? '' : addr).trim().toLowerCase();
  if (!a) return false;
  if (a === '::1' || a === '[::1]' || a === 'localhost') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  const v4 = mapped ? mapped[1] : a;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  return Boolean(m) && Number(m[1]) === 127 && [m[2], m[3], m[4]].every(n => Number(n) <= 255);
}
function requestIsLoopback(req) {
  if (!req || !req.socket) return true;
  return isLoopbackAddress(req.socket.remoteAddress);
}
// 绑定地址是不是回环:只认字面的 127.0.0.0/8、::1、localhost。0.0.0.0 / :: / 局域网 IP / 任意主机名都算非回环。
function isLoopbackBindHost(host) {
  const h = String(host == null ? '' : host).trim().toLowerCase();
  if (h === 'localhost') return true;
  return isLoopbackAddress(h.replace(/^\[|\]$/g, ''));
}
function originOk(req) {
  // Host allowlist FIRST — this is the DNS-rebinding gate and applies even when no Origin is present.
  if (!hostAllowed(req)) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // no Origin => not a browser cross-site request
  const host = req.headers.host || `${RUNTIME.host}:${RUNTIME.port}`;
  try { return new URL(origin).host === host; } catch { return false; }
}
// 代码走查 C16:比较 token 用定长时间比较(=== 在第一个不同字符处就返回,理论上可逐字符测时)。
function tokenMatches(candidate) {
  if (!RUNTIME.token || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate, 'utf8'), b = Buffer.from(String(RUNTIME.token), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function tokenOk(req) {
  return tokenMatches(req.headers['x-wcw-token']);
}
// 第33波:声明式 auth 路由表 + deny-by-default(治 S0 教训 opt-in 名单根因 + 第29波 backlog #0 GET 面)。
// authorizeRoute 对 handleApi 每个路由按 ROUTE_AUTH first-match 判定鉴权级别;未匹配 -> 拒(403)。
// 级别:open(低敏读)/origin(同源或 loopback 非浏览器)/token(始终 tokenOk)/
//      token-browser(浏览器须 token,loopback 须同源,与 v1.4.6-S1 纪律一致)/body-token(handler 自查 body token)。
// 14 处 handler 内 tokenOk 自查保留作纵深(表为主、自查兜底误分类);Host 门在 HTTP handler 顶层 hostAllowed(全请求)。
// 110-2a: ROUTE_AUTH 路由鉴权表抽至 01b-route-auth.js。
function authorizeRoute(req, method, pathname) {
  const m = method === 'HEAD' ? 'GET' : method;
  const browser = Boolean(req.headers.origin) || Boolean(req.headers['sec-fetch-site']) || Boolean(req.headers['sec-fetch-mode']);
  // 安全走查 S13:非本机对端(只可能出现在显式 --allow-remote 绑了非回环地址时)——bootstrap 一律拒(不给它 token),
  // 其余 open / origin / token-browser 级路由也一律要头 token(它们对本机放行的前提是「对端在本机」,对远端不成立)。
  const remote = !requestIsLoopback(req);
  for (const r of ROUTE_AUTH) {
    if (r.m !== '*' && r.m !== m) continue;
    const match = r.prefix ? pathname.startsWith(r.p) : pathname === r.p;
    if (!match) continue;
    // Only the two exact callback routes opt into platform verification in their handler. They never
    // authenticate administration, and the HTTP host allowlist remains in force before this gate.
    if (r.auth === 'external-callback') {
      return m === 'POST' && !r.prefix && (pathname === '/api/external-bots/callback/qq' || pathname === '/api/external-bots/callback/feishu')
        ? null : 'route not authorized';
    }
    if (remote && r.auth !== 'body-token') {
      if (pathname === '/api/bootstrap') return 'remote client not allowed';
      return tokenOk(req) ? null : 'missing or invalid workbench token';
    }
    switch (r.auth) {
      case 'open': return null;
      case 'origin': return originOk(req) ? null : 'cross-origin request rejected';
      case 'token': return tokenOk(req) ? null : 'missing or invalid workbench token';
      case 'token-browser':
        if (browser) return tokenOk(req) ? null : 'missing or invalid workbench token';
        return originOk(req) ? null : 'cross-origin request rejected';
      // 3.0 收口走查(第四波):body-token 的 token 在请求体里,handler 要先把体读完(上限 128MB)才验得了 —— 修前这一档对所有请求放行,
      // 任意网页 `fetch(…, {mode:'no-cors', body: 'a'.repeat(1e8)})`(简单请求,无预检)就能让工作台每请求缓冲约 100MB(实测 RSS
      // 106→297MB),并发几发足以压垮进程。合法调用方(MCP 子进程 / Kimi 桥的 node 回环)不带 Origin / Sec-Fetch-*;
      // 浏览器发来的只放同源,跨站在读体之前就拒。
      case 'body-token': {
        const secSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
        return (browser && (!originOk(req) || secSite === 'cross-site' || secSite === 'same-site')) ? 'cross-origin request rejected' : null;
      }
      default: return 'unknown auth level';
    }
  }
  return 'route not authorized';
}
  return { hostAllowed, isLoopbackAddress, requestIsLoopback, isLoopbackBindHost, originOk, tokenMatches, tokenOk, authorizeRoute };
}
module.exports = { createHttpAuthorization };
