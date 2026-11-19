'use strict';
const { isPrivateIpv4, ssrfCheck, dnsResolvesToPrivate } = require('./network-policy.cjs');
const { responseBodyStream, destroyBodyDecoders } = require('./http-body.cjs');
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
function browserHeaders(extra) {
  return Object.assign({
    'user-agent': BROWSER_UA,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }, extra || {});
}
// v1.1-W1a (T1): classify a low-level socket/HTTP error into a stable failClass the caller maps to 人话.
// 'dns' | 'connect' | 'reset' | 'tls' | 'timeout' | 'http' (with statusCode) | 'too-big' | 'other'.
function classifyFetchError(err) {
  const code = String((err && (err.code || err.errno)) || '');
  const msg = String((err && err.message) || '').toLowerCase();
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|enotfound|dns/.test(msg)) return 'dns';
  if (/timeout|etimedout|esockettimedout/.test(code.toLowerCase() + ' ' + msg)) return 'timeout';
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED' || /aborted|socket hang up|reset|econnreset|epipe/.test(msg)) return 'reset';
  if (/cert|tls|ssl|handshake|self.signed|unable to verify|dh key|alt name|altnames|epROTO|wrong version/.test(code.toLowerCase() + ' ' + msg)) return 'tls';
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL' || /refused|unreachable/.test(msg)) return 'connect';
  return 'other';
}
// ── NE-10:HTTP(S) 代理(环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY,大小写皆可)──────────────────────
// 政企内网常见「只能经代理出网、域名只有代理才解析得了」。修前所有网络工具都直连 + 本机 DNS 预检,于是报「域名解析失败」
// 「当前疑似离线」,模型据此断定网址不对或机器没网,而真正的解法是配代理。工作台里没有别的代理实现(04h 的服务商通道走
// 全局 fetch,与本组工具无关),所以这里做最小的一份:https 目标走 HTTP CONNECT 隧道再叠 TLS,http 目标走绝对 URI 请求。
// 只认 http:// / https:// 形式的代理(带 user:pass@ 时发 Proxy-Authorization: Basic);socks 等其余协议视为未配置。
// 默认不走代理:localhost / 回环与私网 IPv4 字面量 / *.local / 不含点的单标签主机名(
// 内网服务与工作台自身的 loopback 桥接都在这一类里),再加 NO_PROXY(`*`、域名后缀、host:port、IPv4 CIDR)。
// 【SSRF】走代理时目标域名仍由代理解析,所以「连接地址锁定」(pin)不适用;但「解析到内网地址」的 DNS 预检照跑(nip.io / 重绑定类
// 名字 127.0.0.1.nip.io 只要本机 DNS 答得出来就拦):本机解析【失败】(只有代理才解析得了的内网 / 政企域名)返回 null = 放行,
// 解析到回环 / 私网 / 链路本地 = 拒绝。每一跳的 ssrfCheck(协议、字面量、*.local / *.internal)与重定向逐跳复查同样有效。
function parseProxyUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  let auth = '';
  if (u.username) { try { auth = 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64'); } catch { auth = ''; } }
  return { protocol: u.protocol, hostname, port, auth, display: hostname + ':' + port };
}
function proxyIpv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some(n => n > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}
function proxyNoProxyMatches(host, port, noProxy) {
  for (const raw of String(noProxy || '').split(/[,\s]+/)) {
    let e = raw.trim().toLowerCase();
    if (!e) continue;
    if (e === '*') return true;
    const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(e);
    if (cidr) {
      const a = proxyIpv4ToInt(host), b = proxyIpv4ToInt(cidr[1]), bits = Number(cidr[2]);
      if (a !== null && b !== null && bits <= 32) {
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        if (((a & mask) >>> 0) === ((b & mask) >>> 0)) return true;
      }
      continue;
    }
    let ePort = '';
    const pm = /^(.*):(\d+)$/.exec(e);
    if (pm && !e.includes('::')) { e = pm[1]; ePort = pm[2]; }
    if (ePort && String(port) !== ePort) continue;
    e = e.replace(/^\*?\./, '');
    if (!e) continue;
    if (host === e || host.endsWith('.' + e)) return true;
  }
  return false;
}
// 目标 URL 该走哪个代理:返回 parseProxyUrl 的结果,或 null(直连)。env 可传入以便测试。
function proxyForUrl(target, env) {
  const e = env || process.env;
  let u;
  try { u = target instanceof URL ? target : new URL(String(target)); } catch { return null; }
  const https = u.protocol === 'https:';
  if (!https && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || isPrivateIpv4(host) || /\.local$/.test(host)) return null;
  if (!host.includes('.') && !host.includes(':')) return null;              // 单标签内网主机名
  if (/^f[cd][0-9a-f]{0,2}:|^fe80:/.test(host)) return null;                // IPv6 ULA / link-local
  const pick = (...names) => { for (const n of names) { const v = e[n]; if (v && String(v).trim()) return String(v).trim(); } return ''; };
  const raw = https ? pick('HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy') : pick('HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy');
  if (!raw) return null;
  if (proxyNoProxyMatches(host, u.port || (https ? '443' : '80'), pick('NO_PROXY', 'no_proxy'))) return null;
  return parseProxyUrl(raw);
}
// HTTP CONNECT 隧道:成功 resolve 一个已连到 目标host:port 的 socket;失败 reject 带 proxyFail 标记的 Error。
function proxyConnectTunnel(u, proxy, timeoutMs, onPendingReq) {
  return new Promise((resolve, reject) => {
    const plib = proxy.protocol === 'https:' ? require('https') : require('http');
    const hostPort = u.hostname + ':' + (u.port || (u.protocol === 'https:' ? '443' : '80'));
    const headers = { host: hostPort };
    if (proxy.auth) headers['proxy-authorization'] = proxy.auth;
    const req = plib.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: hostPort, headers, timeout: timeoutMs });
    if (typeof onPendingReq === 'function') { try { onPendingReq(req); } catch { /* ignore */ } } // 让总期限能掐断还没握完手的 CONNECT
    const fail = (msg, cause) => { const err = new Error(msg); err.proxyFail = true; if (cause && cause.code) err.code = cause.code; reject(err); };
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) { req.removeAllListeners('timeout'); socket.setTimeout(0); resolve(socket); return; }
      socket.destroy();
      fail(`代理拒绝了 CONNECT ${hostPort}(HTTP ${res.statusCode}${res.statusCode === 407 ? ',需要代理认证' : ''})`);
    });
    req.on('timeout', () => { req.destroy(); fail(`连接代理 ${proxy.display} 超时`); });
    req.on('error', e => fail(`无法连接代理 ${proxy.display}: ${(e && e.message) || e}`, e));
    req.end();
  });
}
// 统一的「发起请求」:不走代理 = 原样 lib.request(u, opts, cb);走代理 = http 用绝对 URI 请求发给代理,https 先 CONNECT 再叠 TLS。
// 返回 ClientRequest(调用方自己挂 timeout / error 事件并 end);隧道失败时 reject(proxyFail)。
async function openHttpRequest(u, opts, cb, proxy, onPendingReq) {
  const https = u.protocol === 'https:';
  if (!proxy) return (https ? require('https') : require('http')).request(u, opts, cb);
  const o = Object.assign({}, opts);
  delete o.lookup; // 连接对象是代理(或已建好的隧道),目标域名的本机解析结果用不上
  if (!https) {
    o.hostname = proxy.hostname; o.port = proxy.port; o.path = u.href; o.method = opts.method || 'GET';
    o.headers = Object.assign({ host: u.host }, opts.headers || {});
    if (proxy.auth) o.headers['proxy-authorization'] = proxy.auth;
    return (proxy.protocol === 'https:' ? require('https') : require('http')).request(o, cb);
  }
  const socket = await proxyConnectTunnel(u, proxy, opts.timeout || 20000, onPendingReq);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  delete o.agent; // agent 缺省 + createConnection 才会真的用它(agent:false 会新建 Agent 忽略 createConnection)
  // host 必须带上:tls.connect({socket}) 缺省按 'localhost' 校验证书身份,IP 字面量目标(https://<公网 IP>/)会因此永远验不过。
  o.createConnection = () => require('tls').connect({ socket, host, servername: require('net').isIP(host) ? undefined : host });
  return require('https').request(u, o, cb);
}

// Low-level http(s) GET with a redirect chain, re-running ssrfCheck on EVERY hop (≤maxRedirects). Returns
// { ok, status, finalUrl, body(Buffer, ≤maxBytes), truncated } on success, else { ok:false, error, failClass,
//  statusCode?, blocked? }. v1.1-W1a: a 'reset' failure (对端掐线 / aborted) is retried ONCE automatically
// before surfacing — anti-scrape edges often reset the first probe but serve the second. Never throws.
// signal(可选 AbortSignal)= 用户中断:中断即返回 failClass:'aborted' 并掐断连接。
// timeoutMs 是【空闲】超时(下载大文件靠它);totalTimeoutMs(可选)是整条重定向链的硬期限 —— 修前对端每 400ms 滴一个字节,
// timeoutMs:1000 的请求能挂 4.8 秒(NE-11)。走代理(NE-10)时 DNS 预检照跑、只是不锁定连接地址,见上文。
function httpGetGuarded(rawUrl, { maxRedirects = 3, timeoutMs = 10000, totalTimeoutMs = 0, maxBytes = 2 * 1024 * 1024, userAgent = BROWSER_UA, rejectOverMaxBytes = false, signal = null, _retriedReset = false } = {}) {
  return new Promise(resolveOuter => {
    let hops = 0, settled = false, usedProxy = false, curReq = null, overall = null, onAbort = null;
    const startedAt = performance.now();
    const resolve = v => {
      if (settled) return; settled = true;
      if (overall) clearTimeout(overall);
      if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ } }
      if (usedProxy && v && typeof v === 'object') v.viaProxy = true;
      resolveOuter(v);
    };
    if (totalTimeoutMs > 0) {
      overall = setTimeout(() => {
        resolve({ ok: false, error: `timeout after ${totalTimeoutMs}ms (total)`, failClass: 'timeout' });
        try { if (curReq) curReq.destroy(); } catch { /* ignore */ }
      }, Math.min(totalTimeoutMs, 2147483647));
    }
    // 用户中断(Stop / 插话)必须能取消正在进行的下载:修前 signal 根本没传进来,Stop 之后连接还挂着直到抓完。
    if (signal) {
      onAbort = () => {
        resolve({ ok: false, error: '请求已被用户中断', failClass: 'aborted' });
        try { if (curReq) curReq.destroy(); } catch { /* ignore */ }
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const visit = async current => {
      if (settled) return;
      const chk = ssrfCheck(current);
      if (!chk.allowed) { resolve({ ok: false, error: chk.reason, failClass: 'blocked', blocked: chk.host }); return; }
      let u;
      try { u = new URL(current); } catch { resolve({ ok: false, error: 'URL 无法解析', failClass: 'other' }); return; }
      // NE-10:配了代理就由代理解析目标域名 —— 本机 DNS 预检既拿不到答案(代理网络里本机往往解析不了)还会误报「域名解析失败」。
      const proxy = proxyForUrl(u);
      if (proxy) usedProxy = true;
      // v0.9 F2 / v1.4.1 audit #2: DNS resolve-then-check —— 拒绝解析到内网的名字(rebinding 守护),并把已验证的
      // 公网地址【锁定】给本次连接(pinned lookup),使 http/https 不再独立二次解析(消除 TOCTOU 重绑定窗口)。
      // 走代理时同样本机预检(只为拦「解析到内网」);本机解析不了 → null → 放行,交给代理解析。走代理不 pin(连接对象是代理)。
      const dnsRes = await dnsResolvesToPrivate(u.hostname);
      if (settled) return;
      if (dnsRes && dnsRes.blocked) { resolve({ ok: false, error: '解析到内网地址', failClass: 'blocked', blocked: dnsRes.blocked }); return; }
      const reqOpts = { method: 'GET', timeout: timeoutMs, headers: browserHeaders({ 'user-agent': userAgent }) };
      const pin = !proxy && dnsRes && dnsRes.pin;
      if (pin && pin.length) {
        // 锁定到已验证公网地址(literal IP / 解析失败 → dnsRes 为 null → 不 pin,literal 已被 ssrfCheck 判过)。
        reqOpts.lookup = (h, opts, cb) => { if (opts && opts.all) cb(null, pin); else cb(null, pin[0].address, pin[0].family); };
      }
      let req = null;
      const onRes = res => {
        const status = res.statusCode || 0;
        // Redirect handling — re-check every hop.
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain
          if (hops >= maxRedirects) { resolve({ ok: false, error: `重定向次数超过上限(${maxRedirects})`, failClass: 'other' }); return; }
          hops++;
          let next;
          try { next = new URL(res.headers.location, u).toString(); } catch { resolve({ ok: false, error: '重定向地址无法解析', failClass: 'other' }); return; }
          visit(next);
          return;
        }
        // A non-2xx terminal status is an 'http' failClass carrying the code (403/503/… → 反爬/拒绝归因).
        if (status < 200 || status >= 300) {
          res.resume(); // drain — we don't need the error page body
          resolve({ ok: false, error: `HTTP ${status}`, failClass: 'http', statusCode: status, finalUrl: u.toString() });
          return;
        }
        // v1.1-W2 (T1): opt-in Content-Length pre-reject (http_download). When rejectOverMaxBytes is set and the
        // server advertises a length over maxBytes, refuse UP FRONT (no wasted download). webFetch never sets it
        // (its maxBytes is a soft truncation for main-text extraction) → unchanged.
        if (rejectOverMaxBytes) {
          const cl = Number(res.headers['content-length']);
          if (Number.isFinite(cl) && cl > maxBytes) {
            res.resume();
            resolve({ ok: false, error: `文件超过大小上限（Content-Length ${cl} > ${maxBytes}）`, failClass: 'too-big', contentLength: cl });
            return;
          }
        }
        const body = responseBodyStream(res);
        if (body.unsupported) {
          res.resume();
          resolve({ ok: false, error: `服务器返回了本工具不支持的内容编码(Content-Encoding: ${body.unsupported})`, failClass: 'other' });
          return;
        }
        const chunks = [];
        let total = 0, truncated = false;
        const done = () => ({ ok: true, status, finalUrl: u.toString(), body: Buffer.concat(chunks), truncated, contentType: res.headers['content-type'] || null,
          contentDisposition: res.headers['content-disposition'] || null, ...(body.encoding ? { decodedFrom: body.encoding } : {}) });
        // 解码链上的错误(损坏的压缩流)要接住,否则是 uncaughtException。
        for (const d of body.decoders) d.on('error', e => { resolve({ ok: false, error: `响应体解压失败(Content-Encoding: ${body.encoding}):${(e && e.message) || e}`, failClass: 'other' }); try { res.destroy(); } catch { /* ignore */ } });
        body.stream.on('data', d => {
          if (truncated) return;
          total += d.length;
          if (total > maxBytes) {
            chunks.push(d.slice(0, Math.max(0, d.length - (total - maxBytes))));
            truncated = true;
            // 先把截到上限的正文交出去,再掐连接:修前先 destroy,res 先发 'error' 后发 'end',整次抓取被报成
            // 「对方服务器中断了连接(可能有反爬限制)」—— 任何超过上限(web_fetch 默认 2MB)的页面都抓不下来。
            // maxBytes 数的是【解码后】的字节(压缩炸弹在这里被掐断)。
            resolve(done());
            destroyBodyDecoders(body);
            try { req.destroy(); } catch { /* ignore */ }
            return;
          }
          chunks.push(d);
        });
        body.stream.on('end', () => resolve(done()));
        res.on('error', e => resolve({ ok: false, error: (e && e.message) || 'response error', failClass: classifyFetchError(e) }));
      };
      const onErr = async e => {
        if (settled) return;
        let failClass = e && e.proxyFail ? 'proxy' : classifyFetchError(e);
        // http 目标经代理时 dns / connect 类错误只可能出在「连代理」这一段。
        if (proxy && (failClass === 'dns' || failClass === 'connect')) {
          resolve({ ok: false, error: `无法连接代理 ${proxy.display}: ${(e && e.message) || 'request error'}`, failClass: 'proxy' });
          return;
        }
        // v1.1-W1a (T1): a 'reset'/aborted failure is often a transient anti-scrape blip → retry once.
        if (failClass === 'reset' && !_retriedReset) {
          // 重试只用剩余的总期限,不重新计满(否则总时长可到 2 倍)。
          let remaining = totalTimeoutMs;
          if (totalTimeoutMs > 0) { remaining = totalTimeoutMs - (performance.now() - startedAt); if (remaining <= 0) { resolve({ ok: false, error: `timeout after ${totalTimeoutMs}ms (total)`, failClass: 'timeout' }); return; } }
          const retry = await httpGetGuarded(rawUrl, { maxRedirects, timeoutMs, totalTimeoutMs: remaining, maxBytes, userAgent, signal, rejectOverMaxBytes, _retriedReset: true });
          resolve(retry); return;
        }
        resolve({ ok: false, error: (e && e.message) || 'request error', failClass });
      };
      try { req = await openHttpRequest(u, reqOpts, onRes, proxy, r => { curReq = r; }); } catch (e) { await onErr(e); return; }
      curReq = req;
      if (settled) { try { req.destroy(); } catch { /* ignore */ } return; }
      req.on('timeout', () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
      req.on('error', onErr);
      req.end();
    };
    visit(String(rawUrl));
  });
}


module.exports = { BROWSER_UA, browserHeaders, classifyFetchError, parseProxyUrl, proxyNoProxyMatches, proxyForUrl, openHttpRequest, httpGetGuarded };
