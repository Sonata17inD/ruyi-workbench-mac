'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { text, contentTypeFor } = require('./http-protocol.cjs');

function createStaticAssets({ externalRoot, publicDirectory, pathWithinRoot, requestIsLoopback, runtime: RUNTIME }) {
  function staticBase() {
    const ext = path.join(externalRoot(), 'app', 'public');
    if (fs.existsSync(ext)) return ext;
    return publicDirectory;
  }

  async function serveStatic(urlPath, req) {
    const base = staticBase();
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const full = path.normalize(path.join(base, rel));
    // 第36波(v1.7): 改用 pathWithinRoot 的段比较 —— 此前 startsWith 前缀判定与 pathWithinRoot 注释里批评的
    // classic prefix bug 同款(public-evil/ 这类同级兄弟目录可越界)。
    if (!pathWithinRoot(full, path.normalize(base))) return text('Forbidden', 403);
    try {
      // Inject the per-server token into the HTML shell so the UI can authenticate its /api calls.
      if (full.toLowerCase().endsWith('index.html')) {
        // 47c(S1):浏览器导航不再随 HTML 明文下发 token(token 只在内存 + sessionStorage,view-source/
        // 缓存/抓包 HTML 均不可得)—— 改 bootstrap 握手(app.js 启动时 POST /api/bootstrap 换取)。
        // 非浏览器调用方(curl/node e2e/MCP child:无 Sec-Fetch、无 Origin、非 Mozilla UA)保持 meta
        // 注入兼容。浏览器导航信号任一命中即判浏览器:Sec-Fetch-Dest / Origin / Mozilla UA。
        const h = (req && req.headers) || {};
        const browserNav = Boolean(h['sec-fetch-dest']) || Boolean(h.origin) || /mozilla/i.test(String(h['user-agent'] || ''));
        // 安全走查 S13:非本机对端(--allow-remote 绑了非回环地址)任何情况下都不下发 token,哪怕它没带浏览器信号。
        const remotePeer = !requestIsLoopback(req);
        const html = (await fsp.readFile(full, 'utf8')).replace('__WCW_TOKEN__', browserNav ? '' : (remotePeer ? '' : (RUNTIME.token || '')));
        return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: html };
      }
      const body = await fsp.readFile(full);
      // v1.0.2 返修二:静态资产此前【零缓存头】—— 浏览器可能沿用缓存的旧 app.js/styles.css,用户换了新包
      // 却仍跑旧前端,一切修复"看起来都没修"(真机反馈坐实的怀疑路径)。产品模型是 overlay 增量更新,
      // 静态资产必须即时生效:与 index.html 一致,一律 no-store(本地回环,重取零网络成本)。
      return { status: 200, headers: { 'content-type': contentTypeFor(full), 'cache-control': 'no-store' }, body };
    } catch {
      return text('Not found', 404);
    }
  }
  return { staticBase, serveStatic };
}

module.exports = { createStaticAssets };
