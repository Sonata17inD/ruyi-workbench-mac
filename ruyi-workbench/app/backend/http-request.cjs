'use strict';
const { charsetFromContentType, decodeHtmlBody, classifyFetchedBody, responseBodyStream, destroyBodyDecoders } = require('./http-body.cjs');
const { classifyFetchError, proxyForUrl, openHttpRequest } = require('./http-transport.cjs');
function webFetchFailMessage(got) {
  const fc = (got && got.failClass) || 'other';
  const code = got && got.statusCode;
  switch (fc) {
    case 'dns': return { error: '域名解析失败(网址可能不存在)', hint: '检查网址拼写是否正确;若本机需要经代理上网,请设置 HTTPS_PROXY / HTTP_PROXY 环境变量后重启工作台' };
    case 'connect': return { error: '无法连接到该网站', hint: '确认网址可访问,或稍后重试;若本机需要经代理上网,请设置 HTTPS_PROXY / HTTP_PROXY 环境变量后重启工作台' };
    // NE-10:代理这一段出的错(连不上代理 / 代理拒绝 CONNECT / 需要认证);got.error 已带上代理地址与状态码。
    case 'proxy': return { error: (got && got.error) || '通过代理访问失败', hint: '检查 HTTPS_PROXY / HTTP_PROXY / NO_PROXY 环境变量与代理本身是否可用(工作台读取这几个环境变量,改后需重启)' };
    case 'reset': return { error: '对方服务器中断了连接(可能有反爬限制)', hint: '可尝试用 web_search 搜索该内容替代' };
    case 'tls': return { error: 'HTTPS 证书/握手失败', hint: '该站点的安全证书异常,谨慎访问' };
    case 'timeout': return { error: '抓取超时', hint: '网站响应过慢,稍后重试或换个来源' };
    case 'aborted': return { error: '请求已被用户中断', hint: '' };
    case 'http': {
      if (code === 403 || code === 401) return { error: `网站拒绝了请求(HTTP ${code},可能反爬)`, hint: '可尝试用 web_search 搜索该内容替代' };
      if (code === 429) return { error: `请求过于频繁被限流(HTTP ${code})`, hint: '稍后再试' };
      if (code === 503 || code === 502 || code === 504) return { error: `网站暂时不可用(HTTP ${code})`, hint: '稍后重试' };
      if (code === 404 || code === 410) return { error: `页面不存在(HTTP ${code})`, hint: '检查网址是否正确' };
      return { error: `网站返回了错误(HTTP ${code || '?'})`, hint: '换个来源或稍后重试' };
    }
    default: return { error: (got && got.error) || '抓取失败', hint: '稍后重试或换个来源' };
  }
}

function isStrictUtf8(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true }); return true; } catch { return false; }
}
// http_request 工具体(也是 web_search 各 API 后端与 builtin 抓取、以及 loopback 桥接的共用底层)。
// NE-11:① 字符串 / Buffer 请求体发 Content-Length(修前 req.write 不带长度 → chunked POST,部分 WAF / IIS / 老 Java 网关回
// 411 / 400);对象体按 JSON 序列化(修前变成 "[object Object]"),没给 content-type 就补 application/json;② timeoutMs 是
// 【整个请求的硬期限】,同时保留空闲超时(修前只有空闲超时,对端每 400ms 滴一字节 timeoutMs:1000 能挂 4.8 秒);③ 4xx / 5xx
// 带 error:'HTTP 404'(仍保留 statusCode / body,ok:false),连接类失败带 failClass 与 hint,坏 URL 返回 {ok:false,error}
// 而不是抛异常;④ NE-10:按 HTTPS_PROXY / HTTP_PROXY / NO_PROXY 走代理(loopback 与私网地址默认不走,见 proxyForUrl)。
async function httpRequest(args = {}, opts = {}) {
  const target = String(args.url || '');
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'url must start with http:// or https://', failClass: 'other' };
  let u;
  try { u = new URL(target); } catch { return { ok: false, error: 'URL 无法解析', failClass: 'other' }; }
  const method = String(args.method || 'GET').toUpperCase();
  const headers = Object.assign({}, (args.headers && typeof args.headers === 'object') ? args.headers : {});
  const hasHeader = n => Object.keys(headers).some(k => k.toLowerCase() === n);
  let body = null;
  if (args.body !== undefined && args.body !== null) {
    if (typeof args.body === 'string' || Buffer.isBuffer(args.body)) body = args.body;
    else if (typeof args.body === 'object') { body = JSON.stringify(args.body); if (!hasHeader('content-type')) headers['content-type'] = 'application/json'; }
    else body = String(args.body);
  }
  if (body !== null && body.length > 0 && !hasHeader('content-length') && !hasHeader('transfer-encoding')) headers['content-length'] = String(Buffer.byteLength(body));
  // timeoutMs 非法(负数 / NaN / 非数字)回落默认 20s:修前负数原样交给 Node,报「The value of "timeout" is out of range」
  // 还被归成 failClass:'timeout',模型会以为是对端慢。0 = 沿用既有语义(取默认)。
  const timeoutMs = (n => (Number.isFinite(n) && n > 0 ? n : 20000))(Number(args.timeoutMs));
  // 3.0 收口走查(第四波):maxBodyChars 钳到 (0, 5,000,000]、非法回落默认。修前 1e308 让下面的字节硬顶变成无穷大(实测 60MB 全进内存、
  // RSS +321MB),NaN 则硬顶失效、一直缓冲到超时。内部调用方最大传 1,200,000,不受影响。
  const maxChars = (n => (Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 5000000) : 200000))(Number(args.maxBodyChars != null ? args.maxBodyChars : 200000));
  const signal = (opts && opts.signal) || null;
  // v1.4.1 (audit #11):此前把整个响应体缓冲进内存再截断 —— 恶意/失控端点可无上限撑爆内存。加【字节硬顶】,
  // 超顶即返回已收的截断体并 destroy 连接停止下载。done 守护防双 resolve / 防 destroy 后的 error 事件误触。
  const hardCap = Math.max(1, maxChars) * 4 + 65536; // utf8 每字符 ≤4 字节 + 余量
  const proxy = proxyForUrl(u);
  return new Promise(resolve => {
    let done = false, req = null, deadline = null;
    const cleanups = [];
    const finish = v => { if (done) return; done = true; if (deadline) clearTimeout(deadline); for (const c of cleanups) c(); if (proxy && v && typeof v === 'object') v.viaProxy = true; resolve(v); };
    const fail = (message, failClass) => {
      const out = { ok: false, error: message, failClass };
      const hint = failClass === 'other' ? '' : webFetchFailMessage({ failClass }).hint;
      if (hint) out.hint = hint;
      finish(out);
    };
    const result = (res, bodyBuf, truncated, decodedFrom) => {
      const st = res.statusCode;
      const ctype = res.headers['content-type'] || '';
      // 二进制响应(图片 / PDF / zip / 声明成 octet-stream 且确实不是文本的)不当文本返回:修前一律 utf8 解码,二进制被糊成 U+FFFD 满屏、
      // 还报 ok:true 且无任何标记。不内联正文,标 binary:true 并说怎么拿(http_download 存盘)。声明成二进制但内容其实是合法 UTF-8 文本的
      // (有的 API 把 JSON 标成 octet-stream)照常当文本。
      const kind = classifyFetchedBody(ctype, bodyBuf);
      const isBinary = kind.kind === 'binary' && (bodyBuf.subarray(0, 8192).includes(0) || !isStrictUtf8(bodyBuf));
      const out = { ok: st >= 200 && st < 400, redirected: st >= 300 && st < 400, statusCode: st, headers: res.headers };
      if (decodedFrom) out.decodedFrom = decodedFrom;
      if (st >= 300 && st < 400 && res.headers.location) {
        // 本工具不跟随重定向(留给调用方看清每一跳,内网 API 常靠它);把目标地址直接给出来,免得去翻 headers。
        try { out.location = new URL(res.headers.location, u).toString(); } catch { out.location = String(res.headers.location); }
      }
      if (isBinary) {
        Object.assign(out, { binary: true, body: '', bytes: bodyBuf.length, truncated: truncated || false,
          note: `响应是二进制内容(${kind.type || '未声明类型'}),没有按文本返回;要保存请用 http_download` });
      } else {
        // 按响应声明的字符集解码(Content-Type charset → BOM → <meta> → 严格 UTF-8 → GB18030),与 web_fetch 同一个解码器:
        // 修前一律 utf8,GBK 的接口 / 老站点返回 U+FFFD 乱码。
        // 没声明字符集的 JSON / 纯文本接口默认就是 UTF-8,不去嗅 <meta>(JSON 字符串里恰好带 <meta charset=…> 会被误判);
        // 只有声明了字符集、是 HTML / XML、或不是合法 UTF-8 时才走完整的识别链。
        const declared = charsetFromContentType(ctype);
        const htmlish = /html|xml/.test(kind.type || '');
        const dec = (declared || htmlish || !isStrictUtf8(bodyBuf)) ? decodeHtmlBody(bodyBuf, ctype) : { text: bodyBuf.toString('utf8').replace(/^\uFEFF/, ''), charset: 'utf-8' };
        const text = dec.text;
        out.body = text.slice(0, maxChars);
        // 按 maxBodyChars 切掉的也算截断:修前只有字节硬上限才置 truncated,30 万字的响应切成 20 万字还报 truncated:false。
        out.truncated = truncated || text.length > maxChars;
        if (text.length > maxChars) out.totalChars = text.length;
        if (out.truncated) out.hint = method === 'GET'
          ? '原响应省略部分未保留;网页请用 web_fetch 的 nextOffset 分页,或 http_download 保存后 file_read 分段读。'
          : '原响应省略部分未保留,重试不是续读;非幂等请求不要为补读自动重发。';
        if (dec.charset && dec.charset !== 'utf-8') out.charset = dec.charset;
        if (dec.warning) out.warning = dec.warning;
      }
      if (st >= 400) { out.error = `HTTP ${st}`; out.failClass = 'http'; }
      return out;
    };
    if (timeoutMs > 0) {
      deadline = setTimeout(() => {
        fail(`timeout after ${timeoutMs}ms (total)`, 'timeout');
        try { if (req) req.destroy(); } catch { /* ignore */ }
      }, Math.min(timeoutMs, 2147483647));
    }
    // 用户中断(Stop / 插话):取消请求并如实说「被中断」。
    if (signal) {
      const onAbort = () => { fail('请求已被用户中断', 'aborted'); try { if (req) req.destroy(); } catch { /* ignore */ } };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => { try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ } });
    }
    const onRes = res => {
      // Content-Encoding(gzip / deflate / br / zstd)先解开再数字节:hardCap 管的是解压后的大小,压缩炸弹在这里被掐断。
      const body = responseBodyStream(res);
      if (body.unsupported) { res.resume(); fail(`服务器返回了本工具不支持的内容编码(Content-Encoding: ${body.unsupported})`, 'other'); try { req.destroy(); } catch { /* ignore */ } return; }
      const chunks = []; let total = 0;
      for (const d of body.decoders) d.on('error', e => { fail(`响应体解压失败(Content-Encoding: ${body.encoding}):${(e && e.message) || e}`, 'other'); try { res.destroy(); } catch { /* ignore */ } });
      body.stream.on('data', d => {
        if (done) return;
        chunks.push(d); total += d.length;
        if (total >= hardCap) {
          finish(result(res, Buffer.concat(chunks), true, body.encoding));
          destroyBodyDecoders(body);
          try { req.destroy(); } catch { /* ignore */ }
        }
      });
      body.stream.on('end', () => finish(result(res, Buffer.concat(chunks), false, body.encoding)));
      res.on('error', e => fail((e && e.message) || 'response error', classifyFetchError(e)));
    };
    const onErr = e => {
      if (done) return;
      let failClass = e && e.proxyFail ? 'proxy' : classifyFetchError(e);
      if (proxy && (failClass === 'dns' || failClass === 'connect')) { fail(`无法连接代理 ${proxy.display}: ${(e && e.message) || 'request error'}`, 'proxy'); return; }
      fail((e && e.message) || 'request error', failClass);
    };
    openHttpRequest(u, { method, headers, timeout: timeoutMs }, onRes, proxy, pending => { req = pending; }).then(r => {
      req = r;
      if (done) { try { req.destroy(); } catch { /* ignore */ } return; }
      req.on('timeout', () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
      req.on('error', onErr);
      if (body !== null && body.length > 0) req.end(body); else req.end();
    }, onErr);
  });
}


module.exports = { httpRequest, webFetchFailMessage };
