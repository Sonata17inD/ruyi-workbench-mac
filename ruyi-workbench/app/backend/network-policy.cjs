'use strict';
function isPrivateIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some(n => n > 255)) return false; // not a valid dotted-quad → not our concern here
  const [a, b] = o;
  if (a === 127) return true;                         // 127.0.0.0/8 loopback
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 link-local + cloud metadata (…169.254)
  if (a === 100 && b >= 64 && b <= 127) return true;  // v1.4.1 (audit #12): 100.64.0.0/10 CGNAT/共享地址段
  if (a === 0) return true;                           // 0.0.0.0/8 (this host)
  return false;
}
// v0.9 F1: pull an embedded IPv4 out of an IPv4-mapped / IPv4-compatible IPv6 literal so isPrivateIpv4 can
// judge it. Handles: dotted-quad mapped (::ffff:127.0.0.1), hex mapped (::ffff:7f00:1), the bare-hex form
// without the ffff marker (::a9fe:a9fe — an IPv4-compatible-ish literal a scanner might use), and the
// deprecated IPv4-compatible dotted form (::127.0.0.1). Returns a dotted-quad string, or null when there is
// no embedded IPv4 to extract. Exported for direct e2e testing.
function embeddedIpv4FromV6(bareIn) {
  const bare = String(bareIn || '').toLowerCase();
  // 1) dotted-quad embedded: ::ffff:127.0.0.1  OR  deprecated ::127.0.0.1
  let m = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare);
  if (m) return m[1];
  // 2) hex embedded (last two hextets): ::ffff:7f00:1  OR  bare ::a9fe:a9fe
  m = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (m) {
    const h1 = parseInt(m[1], 16), h2 = parseInt(m[2], 16);
    if (Number.isFinite(h1) && Number.isFinite(h2)) {
      return `${(h1 >> 8) & 255}.${h1 & 255}.${(h2 >> 8) & 255}.${h2 & 255}`;
    }
  }
  return null;
}
// Return { allowed, reason?, host } for a candidate URL. Called on the initial url AND on every redirect hop.
function ssrfCheck(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return { allowed: false, reason: 'URL 无法解析', host: '' }; }
  const proto = u.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') return { allowed: false, reason: '仅允许 http/https 协议', host: u.hostname };
  // 末尾的点是合法 FQDN 写法(`localhost.`、`x.internal.`),不剥掉的话下面的名字黑名单一条都配不上,只剩 DNS 那道闸
  // —— 而经代理解析时 DNS 闸是跳过的。
  let host = String(u.hostname || '').toLowerCase().replace(/\.+$/, '');
  // Strip an IPv6 bracket form ([::1]) that URL leaves in hostname.
  const bare = host.replace(/^\[|\]$/g, '');
  // TEST HOOK (v1.1-W2): env WCW_TEST_ALLOW_LOOPBACK=1 permits 127.0.0.1 (loopback only) so the http_download
  // e2e can exercise the full guarded-fetch happy path against a local fake server. Mirrors the narrow
  // WCW_TEST_NO_NET_ANCHORS hook. DEFAULT OFF → zero production effect; only 127.0.0.1 is exempted (all other
  // private/link-local/metadata ranges + *.internal/*.local stay blocked even with the flag on).
  const testLoopback = process.env.WCW_TEST_ALLOW_LOOPBACK === '1' && /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
  if (testLoopback) return { allowed: true, host: bare };
  // Loopback / link-local / metadata by literal host.
  if (bare === 'localhost' || bare === '::1' || bare === '::' || bare === '0.0.0.0') return { allowed: false, reason: '目标地址不允许(内网/回环)', host: bare };
  // IPv6 unique-local (fc00::/7 → fc/fd prefix) + link-local (fe80::) — literal判定.
  if (/^f[cd][0-9a-f]{0,2}:/.test(bare) || /^fe80:/.test(bare)) return { allowed: false, reason: '目标地址不允许(内网/回环)', host: bare };
  // v0.9 F1: NAT64 well-known prefix (64:ff9b::/96) can smuggle an embedded IPv4 → refuse the whole prefix.
  if (/^64:ff9b:/.test(bare)) return { allowed: false, reason: '目标地址不允许(内网/回环)', host: bare };
  // v0.9 F1: IPv4-mapped/compatible IPv6 literals ([::ffff:127.0.0.1], hex [::ffff:7f00:1], etc.) — extract the
  // embedded v4 and run it through the private-range check BEFORE the plain isPrivateIpv4(bare) (which only
  // sees dotted-quads). A mapped literal whose embedded v4 is PUBLIC (e.g. ::ffff:8.8.8.8) falls through and is
  // allowed (a legitimate public mapping). A ::ffff:-prefixed literal we cannot resolve to a v4 is refused as
  // suspicious rather than allowed.
  const embV4 = embeddedIpv4FromV6(bare);
  if (embV4) { if (isPrivateIpv4(embV4)) return { allowed: false, reason: '目标地址不允许(内网/回环)', host: bare }; }
  else if (/^::ffff:/.test(bare)) return { allowed: false, reason: '目标地址不允许(内网/回环)', host: bare };
  // IPv4 literal private/loopback ranges.
  if (isPrivateIpv4(bare)) return { allowed: false, reason: '目标地址不允许(内网/回环)', host: bare };
  // Service-discovery suffixes that only ever名 internal hosts.
  if (/\.(local|internal)$/.test(bare)) return { allowed: false, reason: '目标地址不允许(内网/回环)', host: bare };
  return { allowed: true, host: bare };
}

async function dnsResolvesToPrivate(hostname) {
  const bare = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  // Literal IPs are already judged by ssrfCheck — skip a pointless lookup.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare) || bare.includes(':')) return null;
  let addrs;
  try { addrs = await require('dns').promises.lookup(bare, { all: true }); }
  catch { return null; } // ENOTFOUND / no network → let the real fetch fail
  for (const a of (addrs || [])) {
    const addr = String(a.address || '').toLowerCase();
    if (a.family === 4) { if (isPrivateIpv4(addr)) return { blocked: addr, host: bare }; continue; }
    // family 6: loopback / ULA / link-local, plus any embedded-v4 that is private.
    if (addr === '::1' || addr === '::') return { blocked: addr, host: bare };
    if (/^f[cd][0-9a-f]{0,2}:/.test(addr) || /^fe80:/.test(addr)) return { blocked: addr, host: bare };
    const v4 = embeddedIpv4FromV6(addr);
    if (v4 && isPrivateIpv4(v4)) return { blocked: addr, host: bare };
  }
  // v1.4.1 (audit #2):全部解析地址均为公网 → 回传这批地址,供 httpGetGuarded【锁定】连接到它们(避免 DNS
  // 重绑定 TOCTOU:http/https 各自独立二次 getaddrinfo,第二次可换成内网/元数据 IP)。
  return (addrs && addrs.length) ? { pin: addrs } : null;
}

module.exports = { isPrivateIpv4, embeddedIpv4FromV6, ssrfCheck, dnsResolvesToPrivate };
