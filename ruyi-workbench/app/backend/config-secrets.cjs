'use strict';

const { redact, REDACTED_MARKER } = require('./secret-redaction.cjs');

// 107-S2(46 号文 §5 ⑦b L3):URL 查询串里的凭据。`?api_key=…`／`?token=…` 这类把密钥写进地址的端点
// 到处都有(远程 MCP 清单、自建网关),而 GET /api/status 是 open 档 —— 本机任何进程一个 curl 就读到。
// 口径与 providers[].extraHeaders 那一格相同【按名字挑】,不按值猜:URL 的查询名是一小撮公认的凭据名
// (api_key／token／secret／password／auth／key／sig／signature／credential／access_token),把整个查询串
// 都遮了会连 ?model=、?version= 这类识别端点必需的信息一起遮掉,而识别端点正是保留 scheme/host/path
// 的理由。值走同一条 maskKey(••••<末4>),所以「回传的掩码 = 我们刚下发的那一串」可以逐字节比出来。
const SENSITIVE_URL_PARAM_RE = /^(?:x-)?(?:api[-_]?key|key|access[-_]?token|token|secret|password|passwd|auth|authorization|credential|sig|signature|session)$/i;
function isSensitiveUrlParamName(name) { return typeof name === 'string' && SENSITIVE_URL_PARAM_RE.test(name.trim()); }
// 只在【真有要遮的东西】时才重写这个串:没有凭据参数就原样返回,一个字节都不动 —— 否则
// `?a=1&b=2` 会被重新拼装。restoreDisplayUrl 用原始返回值逐字节比对，避免将原样回传误判成端点变更。
function maskUrlQueryCredentials(urlStr) {
  const s = String(urlStr || '');
  const hashAt = s.indexOf('#');
  const head = hashAt >= 0 ? s.slice(0, hashAt) : s;
  const tail = hashAt >= 0 ? s.slice(hashAt) : '';
  const queryAt = head.indexOf('?');
  if (queryAt < 0) return s;
  const prefix = head.slice(0, queryAt + 1);
  let changed = false;
  const pairs = head.slice(queryAt + 1).split('&').map(pair => {
    const eq = pair.indexOf('=');
    if (eq <= 0) return pair;
    const name = pair.slice(0, eq), value = pair.slice(eq + 1);
    if (!value || !isSensitiveUrlParamName(name)) return pair;
    changed = true;
    return name + '=' + maskKey(value);   // 值仍是【原编码形态】的末四位:掩码可逐字节对回去
  });
  return changed ? prefix + pairs.join('&') + tail : s;
}
// 55a: 远程条目 URL 展示脱敏 -- 剥离 userinfo(http://user:pass@host -> http://host),防凭据经
// token 保护的路由返回给前端(浏览器扩展/日志/共享机器可截获)。解析失败则原样返回(不阻断展示)。
// 107-S2:同一条规则再加查询串里的凭据(上面的 maskUrlQueryCredentials),并成为全仓【唯一】的
// 「URL 给人看之前怎么脱敏」判据 —— maskSecrets(providers 的 baseUrl／audioBaseUrl／extraBaseUrls、
// searchBackend.baseUrl、modelsApiBase)、maskExternalMcpServerForDisplay(远程 url)、safeMcpInventory
// (mcp_list)全部调它,不另写第二套。URL 能解析但没有 userinfo 时【不重建】(u.toString() 会给
// `http://host` 补出尾斜杠,那会让「原样回传」看起来像改了端点)。
function safeUrlForDisplay(urlStr) {
  const raw = String(urlStr || '');
  let stripped = raw;
  try { const u = new URL(raw); if (u.username || u.password) { u.username = ''; u.password = ''; stripped = u.toString(); } }
  catch { /* 非法/相对 URL:不重建,只做下面的查询串脱敏(与修前「解析失败原样返回」同一个不阻断口径) */ }
  return maskUrlQueryCredentials(stripped);
}

// F2 (安全·回显): mask provider api keys before a config leaves the process in an API RESPONSE. Returns a
// DEEP-ENOUGH copy so mutating the mask never touches the on-disk config. Every providers[] entry gets its
// apiKey replaced with `••••<last4>` (empty → '') plus an additive `hasKey` boolean, so the UI can show
// "key present" without ever receiving the plaintext. Only GET /api/status and POST /api/config responses
// route through this; the disk config is untouched. Any tokenless local process that curls those routes
// now sees a mask, not the real key.
const KEY_MASK_PREFIX = '••••';
// Mask a single plaintext secret to `••••<last4>` ('' stays ''). Shared by providers[].apiKey and
// searchBackend.apiKey so there is ONE masking rule to reason about.
function maskKey(key) {
  const k = typeof key === 'string' ? key : '';
  return k.length > 0 ? (KEY_MASK_PREFIX + k.slice(-4)) : '';
}
// 自定义请求头(providers[].extraHeaders)可能携带认证令牌(Authorization / X-API-Key / token / cookie …)。
// 与 apiKey 同款掩码:下发给浏览器时把敏感头的值替换为 ••••<末4>,保存时若值未被改动(仍是掩码)则从磁盘配置还原。
// 非敏感头(如 X-Organization)明文往返,方便用户在 UI 里看到并编辑。
const SENSITIVE_HEADER_RE = /(authorization|api[-_]?key|token|secret|cookie|password|passwd|auth)/i;
function isSensitiveHeaderName(name) { return typeof name === 'string' && SENSITIVE_HEADER_RE.test(name); }
function maskExtraHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = isSensitiveHeaderName(k) ? maskKey(typeof v === 'string' ? v : String(v)) : v;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// 107-S2(46 号文 §5 ⑦b 的 M5 与 L3)—— 掩码回传的【启动向量闸】与 URL 里的凭据。
//
// M5:修前 providers 段的还原只按 id 配对。于是同一次保存里把 baseUrl 换成别人的地址、apiKey 仍回传
// 掩码,真 key 就被贴到了新端点上 —— 「看不见密钥也能把它改接到别处」,与 S0b 给 MCP 关上的是同一个
// 口子,而主端点每回合都用,危害更大。这里把 S0b 的模具搬过来:**启动向量没变才还原**。
//
// 一条 provider 的启动向量 = 这份密钥实际会被送到哪几个地址:
//   · baseUrl —— 每回合的对话请求(Authorization: Bearer <apiKey>);
//   · audioBaseUrl —— ASR 转写端点，使用同一份 apiKey；
//   · extraBaseUrls —— v1.0-S6 的 failover 备用端点。09:1268 的 streamWithFailover 逐个试
//     `[baseUrl, ...extraBaseUrls]`,**每一个都带同一个 Authorization**。所以它【算】启动向量:
//     只往列表里加一条,首字节前一次失败就足以把真 key 送去新加的那个地址。
// extraHeaders 里那些被掩码的敏感头(可能就是另一份凭据)跟 apiKey 同一道闸 —— 它们和 apiKey 去的是
// 同一批地址,一道闸管两样,不另立判据。
//
// L3:baseUrl／audioBaseUrl／extraBaseUrls／searchBackend.baseUrl／modelsApiBase／远程 MCP 的 url 都可能
// 把凭据写在地址里(`https://user:pass@host`、`?api_key=…`)。它们此前经 GET /api/status(**open 档**,
// 本机任何进程一个 curl 就读到)明文下发。显示面一律过 safeUrlForDisplay(全仓唯一那条规则),
// 磁盘与真正发出去的请求【永远】用真值。
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

// 一条 provider 的启动向量 = 这份密钥【实际会被送到】的地址集合(去重、去空、排序):
//   · baseUrl —— 每回合的对话请求;
//   · audioBaseUrl || baseUrl —— ASR 转写(
//     所以留空不是「少一个地址」而是【回落到 baseUrl】,那本来就在集合里);
//   · extraBaseUrls —— streamWithFailover 逐个试的备用端点,每一个都带同一个 Authorization。
function providerLaunchUrls(provider) {
  const one = v => String(v == null ? '' : v).trim();
  const p = (provider && typeof provider === 'object') ? provider : {};
  const base = one(p.baseUrl);
  const urls = [base, one(p.audioBaseUrl) || base, ...(Array.isArray(p.extraBaseUrls) ? p.extraBaseUrls : []).map(one)];
  return [...new Set(urls.filter(Boolean))].sort();
}
function providerLaunchVectorKey(provider) { return JSON.stringify(providerLaunchUrls(provider)); }
// 闸的判据是【没有新增地址】(子集),不是「逐字节相等」。
// 危险的从来只有一种形状:密钥被送到一个它【原本去不到】的地址。把地址删掉、或者把 audioBaseUrl
// 清空让它回落到 baseUrl,都是【收窄】—— 剩下的每一个地址原本就在收这份密钥,收窄不可能泄漏。
// 按「逐字节相等」判会把这类合法操作也拒掉(asr-transcribe 的 F1 就是这个形状:先设一个
// audioBaseUrl、再把整份 providers 还原回去,还原那一下会被误拒)。
function providerVectorNotWidened(next, prev) {
  const before = new Set(providerLaunchUrls(prev));
  return providerLaunchUrls(next).every(url => before.has(url));
}

// 「掩码 URL -> 真 URL」的对照表,按【整串显示形】索引而不是按 id。
// 为什么不按 id:URL 自己的凭据只会回到它自己那个地址上去 —— 还原一个 URL 的凭据【不可能】把它送到
// 另一个端点(URL 就是端点)。这与 apiKey 相反(那是一份可以被贴到任意地址上的独立凭据),所以这张表
// 全局通用,新建条目、改了 id 的条目原样回传也能对回去,不会像密钥那样制造「跟着改到新端点」的口子。
// 两个不同真值遮成同一串时记 null(歧义不猜)——这时回传的那一串按「用户自己填的地址」原样落盘,
// 结果是那条 URL 上的凭据被丢掉,方向保守(绝不会把 A 的凭据安到 B 的地址上)。
function collectDisplayUrlRestores(current) {
  const map = new Map();
  const add = value => {
    if (typeof value !== 'string' || !value) return;
    const shown = safeUrlForDisplay(value);
    if (shown === value) return;                                   // 没遮过就没有「掩码形」可对
    if (!map.has(shown)) map.set(shown, value);
    else if (map.get(shown) !== value) map.set(shown, null);        // 歧义
  };
  const cfg = (current && typeof current === 'object') ? current : {};
  for (const p of (Array.isArray(cfg.providers) ? cfg.providers : [])) {
    if (!p || typeof p !== 'object') continue;
    add(p.baseUrl); add(p.audioBaseUrl);
    for (const extra of (Array.isArray(p.extraBaseUrls) ? p.extraBaseUrls : [])) add(extra);
  }
  if (cfg.searchBackend && typeof cfg.searchBackend === 'object') add(cfg.searchBackend.baseUrl);
  add(cfg.modelsApiBase);
  for (const m of (Array.isArray(cfg.externalMcpServers) ? cfg.externalMcpServers : [])) { if (m && typeof m === 'object') add(m.url); }
  return map;
}
function restoreDisplayUrl(value, restores) {
  if (typeof value !== 'string' || !value || !restores) return value;
  const hit = restores.get(value);
  return typeof hit === 'string' ? hit : value;
}
// 一条 provider 里的全部 URL 字段先各自对回真值,再去比启动向量 —— 否则「用户什么都没动」会因为
// 我们自己遮过的那一串而被判成「换了端点」,每一次保存都被拒。
function restoreProviderDisplayUrls(provider, restores) {
  if (!provider || typeof provider !== 'object') return provider;
  const out = { ...provider };
  if (typeof out.baseUrl === 'string') out.baseUrl = restoreDisplayUrl(out.baseUrl, restores);
  if (typeof out.audioBaseUrl === 'string') out.audioBaseUrl = restoreDisplayUrl(out.audioBaseUrl, restores);
  if (Array.isArray(out.extraBaseUrls)) out.extraBaseUrls = out.extraBaseUrls.map(v => restoreDisplayUrl(v, restores));
  return out;
}
// 还留着掩码前缀的 URL = 调用方把我们遮过的那一串【改了一部分】再交回来(`?api_key=••••cdef` 里的
// 主机改了),既对不回真值也绝不能就这么落盘。它与「密钥的启动向量变了」一起走同一条拒绝路径。
function urlStillMasked(value) { return typeof value === 'string' && value.includes(KEY_MASK_PREFIX); }
function providerMaskedUrlFields(provider) {
  const p = (provider && typeof provider === 'object') ? provider : {};
  const hit = [];
  if (urlStillMasked(p.baseUrl)) hit.push('baseUrl');
  if (urlStillMasked(p.audioBaseUrl)) hit.push('audioBaseUrl');
  if ((Array.isArray(p.extraBaseUrls) ? p.extraBaseUrls : []).some(urlStillMasked)) hit.push('extraBaseUrls');
  return hit;
}
function providerMaskedSecretFields(provider) {
  const p = (provider && typeof provider === 'object') ? provider : {};
  const hit = [];
  if (typeof p.apiKey === 'string' && p.apiKey.startsWith(KEY_MASK_PREFIX)) hit.push('apiKey');
  if (p.extraHeaders && typeof p.extraHeaders === 'object') {
    for (const [hk, hv] of Object.entries(p.extraHeaders)) {
      if (isSensitiveHeaderName(hk) && typeof hv === 'string' && hv.startsWith(KEY_MASK_PREFIX)) { hit.push('extraHeaders.' + hk); }
    }
  }
  return hit;
}
// 落盘前的【唯一】判据:这份来件里有没有「我们还不清楚该怎么处理的掩码」。返回空数组 = 可以写。
// 调用它的三个写口(POST /api/config、POST /api/provider/test、管家 steward_config_set 经 applyConfigPatch)
// 在非空时【整份拒绝、零写入】,并把受影响的条目告诉用户 —— 见下面「为什么是拒绝不是清空」。
//
// 为什么 providers 这一族选【拒绝】而 S0b 给 MCP 选的是【清空】:
//   · 清空的代价落在用户身上且没有回执 —— 「我只是把地址改了一下,怎么下一回合就 401 了」。改地址不
//     重填密钥是设置页最正常不过的一次操作(密钥框里躺着的就是掩码),不该以静默丢密钥收场。
//   · 拒绝是原子的:mutateConfig 的 mutator 抛出 = 一个字节都没写,用户同一次保存里改的别的东西也还在
//     草稿里,补上密钥再存一次即可,什么都没丢。
//   · MCP 那一族保持 S0b 的清空口径不动:那边的回传方多是模型／管家(mcp_configure、steward_config_set),
//     硬拒只会让模型盲目重试;而且那是已经发布并被 repo-hygiene (f②)／config-mutate-mcp-parity T12e
//     钉死的契约,本刀不动它。**唯一例外是远程条目的 url**:它对不回去时既不能留掩码(会落盘)也不能清空
//     (清空 = 整条连接器静默消失),只能拒绝。
function maskedSecretConflicts(incoming, current) {
  const out = [];
  if (!incoming || typeof incoming !== 'object') return out;
  const cfg = (current && typeof current === 'object') ? current : {};
  const restores = collectDisplayUrlRestores(cfg);
  if (Array.isArray(incoming.providers)) {
    const byId = new Map((Array.isArray(cfg.providers) ? cfg.providers : []).map(p => [String((p && p.id) || ''), p]));
    for (const raw of incoming.providers) {
      if (!raw || typeof raw !== 'object') continue;
      const p = restoreProviderDisplayUrls(raw, restores);
      const id = String(p.id || '');
      const label = String(p.label || id || '');
      const maskedUrls = providerMaskedUrlFields(p);
      if (maskedUrls.length) { out.push({ scope: 'provider', id, label, fields: maskedUrls, reason: 'masked_url' }); continue; }
      const maskedSecrets = providerMaskedSecretFields(p);
      if (!maskedSecrets.length) continue;
      const prev = byId.get(id);
      if (!prev) { out.push({ scope: 'provider', id, label, fields: maskedSecrets, reason: 'no_match' }); continue; }
      if (!providerVectorNotWidened(p, prev)) {
        out.push({ scope: 'provider', id, label, fields: maskedSecrets, reason: 'endpoint_changed' });
      }
    }
  }
  if (incoming.searchBackend && typeof incoming.searchBackend === 'object') {
    const sb = incoming.searchBackend;
    const baseUrl = restoreDisplayUrl(typeof sb.baseUrl === 'string' ? sb.baseUrl : '', restores);
    const prev = (cfg.searchBackend && typeof cfg.searchBackend === 'object') ? cfg.searchBackend : null;
    if (urlStillMasked(baseUrl)) out.push({ scope: 'searchBackend', id: 'searchBackend', label: 'searchBackend', fields: ['baseUrl'], reason: 'masked_url' });
    else if (typeof sb.apiKey === 'string' && sb.apiKey.startsWith(KEY_MASK_PREFIX)) {
      const prevBase = String((prev && prev.baseUrl) || '').trim();
      const prevType = String((prev && prev.type) || '');
      if (!prev) out.push({ scope: 'searchBackend', id: 'searchBackend', label: 'searchBackend', fields: ['apiKey'], reason: 'no_match' });
      else if (baseUrl.trim() !== prevBase || String(sb.type || '') !== prevType) {
        out.push({ scope: 'searchBackend', id: 'searchBackend', label: 'searchBackend', fields: ['apiKey'], reason: 'endpoint_changed' });
      }
    }
  }
  if (typeof incoming.modelsApiBase === 'string' && urlStillMasked(restoreDisplayUrl(incoming.modelsApiBase, restores))) {
    out.push({ scope: 'claudeEndpoint', id: 'modelsApiBase', label: 'modelsApiBase', fields: ['modelsApiBase'], reason: 'masked_url' });
  } else if (typeof incoming.modelsApiKey === 'string' && incoming.modelsApiKey.startsWith(KEY_MASK_PREFIX)) {
    // modelsApiKey 是 Claude CLI 子进程的 ANTHROPIC_AUTH_TOKEN,它的启动向量就是 modelsApiBase。
    // patch 里没带 modelsApiBase = 那个字段这次不改(合并语义),向量自然没变。
    const nextBase = Object.prototype.hasOwnProperty.call(incoming, 'modelsApiBase')
      ? String(restoreDisplayUrl(String(incoming.modelsApiBase == null ? '' : incoming.modelsApiBase), restores)).trim()
      : String(cfg.modelsApiBase || '').trim();
    if (nextBase !== String(cfg.modelsApiBase || '').trim()) {
      out.push({ scope: 'claudeEndpoint', id: 'modelsApiKey', label: 'modelsApiKey', fields: ['modelsApiKey'], reason: 'endpoint_changed' });
    }
  }
  for (const raw of (Array.isArray(incoming.externalMcpServers) ? incoming.externalMcpServers : [])) {
    if (!raw || typeof raw !== 'object') continue;
    const url = restoreDisplayUrl(typeof raw.url === 'string' ? raw.url : '', restores);
    if (urlStillMasked(url)) out.push({ scope: 'mcp', id: String(raw.id || ''), label: String(raw.label || raw.id || ''), fields: ['url'], reason: 'masked_url' });
  }
  return out;
}
// 拒绝时给用户看的那一句(中文,与 /api/provider/test 那几句人话同口径)。只报条目名与字段名,绝不带值。
function maskedSecretConflictMessage(conflicts) {
  const names = (Array.isArray(conflicts) ? conflicts : []).map(c => (c && (c.label || c.id)) || '?');
  return `这次保存没有写入:${names.join('、')} 的地址变了(或是新条目),而密钥框里回传的还是遮起来的那一串 ——`
    + '为防止把真密钥贴到新端点上,如意不会把旧密钥跟过去。请重新填一次密钥(或把密钥框清空后再保存),然后重试。';
}
// 107-S0b(46 号文 §5 S0 记录「发现但没修」第 1 条):外部 MCP 连接器的密钥面。
// externalMcpServers[].env(stdio)与远程条目的 headers 里装的常是 GitHub PAT、Authorization、服务密钥;修前
// maskSecrets 不碰这一键,GET /api/status、POST /api/config 回包、steward_config_get 原样下发。
// 口径:env／headers 的【每一个值】都走同一条 maskKey,不按键名挑 —— 键名是用户随手起的(GITHUB_PERSONAL_ACCESS_TOKEN、
// X_KEY、DB_URL……),名字白名单一定漏;按值猜「像不像密钥」同样猜不准(providers 的 extraHeaders 按名字挑,是因为
// 那一格绝大多数是 X-Organization 这类非密钥头,MCP 的 env 恰好反过来)。键名照常可见,看得出配了哪几个变量。
// args 可能带 `--token xyz`、`postgres://user:pass@host` 这类值:只做【显示】脱敏,用共享的 redact 表(审计、会话搜索、
// 管家命令摘录共用的那一张);旗标与值分在两个元素里时把前一个元素接上一起过表。command／url／cwd／id／label／enabled 原样。
function mcpArgsForDisplay(argList) {
  if (!Array.isArray(argList)) return argList;
  return argList.map((arg, i) => {
    if (typeof arg !== 'string') return arg;
    const own = redact(arg);
    const prevArg = i > 0 ? argList[i - 1] : null;
    if (typeof prevArg !== 'string') return own;
    const head = redact(prevArg) + ' ';
    const pair = redact(prevArg + ' ' + arg);
    if (pair === head + own) return own;
    if (!pair.startsWith(head)) return REDACTED_MARKER;   // 表里的某条跨过了两个元素的边界,切不回去 —— 整个元素按脱敏处理
    const tail = pair.slice(head.length);
    return tail === arg ? own : tail;
  });
}
function maskMcpSecretValues(valueMap) {
  const out = {};
  for (const [name, value] of Object.entries(valueMap)) out[name] = maskKey(value == null ? '' : String(value));
  return out;
}
function maskExternalMcpServerForDisplay(mcpEntry) {
  if (!mcpEntry || typeof mcpEntry !== 'object') return mcpEntry;
  const out = { ...mcpEntry };
  if (mcpEntry.env && typeof mcpEntry.env === 'object') out.env = maskMcpSecretValues(mcpEntry.env);
  if (mcpEntry.headers && typeof mcpEntry.headers === 'object') out.headers = maskMcpSecretValues(mcpEntry.headers);
  if (Array.isArray(mcpEntry.args)) out.args = mcpArgsForDisplay(mcpEntry.args);
  // 107-S2(L3;S0b「发现但没修」第 2 条):远程条目的 url 也能带凭据(`https://u:p@host`、`?api_key=…`)。
  // 走统一的 URL 显示规则;没有凭据的地址【一个字节都不变】,所以原样回传仍是「用户没动它」。
  if (typeof mcpEntry.url === 'string' && mcpEntry.url) out.url = safeUrlForDisplay(mcpEntry.url);
  return out;
}
// 保存路径的逆操作。来件里的值仍以掩码前缀开头(env／headers)或仍带脱敏标记(args)= 调用方没动它 → 取磁盘上
// 【同 id】那一条同一个键的真值;新填的明文直通;来件里没有的键自然就删掉了。
// 比 providers 那一套多一道闸:**启动向量没变才还原** —— stdio 比 command 与 cwd(args 先逐个还原再整串比),
// 远程比 url。不然一份回传的掩码就是「看不见密钥也能把它改接到另一个程序／端点上」的把手(管家提议一份改了
// command 的 patch、用户随手一按;模型经 mcp_configure upsert 同一个 id)。
// 没有匹配(新 id、改了 id、改了启动向量)一律按清空处理,与 providers「无匹配 → 空」同口径。
function mcpEntryIsRemote(mcpEntry) {
  const kind = String((mcpEntry && (mcpEntry.type || mcpEntry.transport)) || 'stdio').toLowerCase();
  return kind === 'sse' || kind === 'http' || kind === 'streamable-http';
}
function mcpEntryTrimmed(mcpEntry, field, cap) {
  return (mcpEntry && typeof mcpEntry[field] === 'string' ? mcpEntry[field] : '').trim().slice(0, cap);
}
function mcpEntryArgStrings(argList) {
  return Array.isArray(argList) ? argList.filter(arg => typeof arg === 'string').slice(0, 50) : [];
}
function restoreMcpSecretValues(valueMap, prevValueMap) {
  if (!valueMap || typeof valueMap !== 'object' || Array.isArray(valueMap)) return valueMap;
  const prevMap = (prevValueMap && typeof prevValueMap === 'object') ? prevValueMap : {};
  const out = {};
  for (const [name, value] of Object.entries(valueMap)) {
    if (typeof value === 'string' && value.startsWith(KEY_MASK_PREFIX)) {
      const prevValue = Object.prototype.hasOwnProperty.call(prevMap, name) ? prevMap[name] : undefined;
      out[name] = (typeof prevValue === 'string' || typeof prevValue === 'number') ? String(prevValue) : '';
    } else out[name] = value;
  }
  return out;
}
function restoreMcpArgs(argList, prevArgList) {
  if (!Array.isArray(argList)) return argList;
  const prevRaw = Array.isArray(prevArgList) ? prevArgList : [];
  const prevShown = mcpArgsForDisplay(prevRaw);
  const redactedAt = prevRaw.map((arg, j) => typeof arg === 'string' && prevShown[j] !== arg);
  return argList.map((arg, i) => {
    if (typeof arg !== 'string' || !arg.includes(REDACTED_MARKER)) return arg;
    if (i < prevRaw.length && (prevRaw[i] === arg || (redactedAt[i] && prevShown[i] === arg))) return prevRaw[i];   // 原位没动
    // 挪了位置:显示形唯一对得上才还原;对不上或有歧义(两个都显示成同一串)→ 清空,不猜
    const hits = prevShown.map((shown, j) => (redactedAt[j] && shown === arg ? j : -1)).filter(j => j >= 0);
    return hits.length === 1 ? prevRaw[hits[0]] : '';
  });
}
function restoreExternalMcpServerSecrets(mcpEntry, prevEntry, urlRestores) {
  if (!mcpEntry || typeof mcpEntry !== 'object') return mcpEntry;
  // 107-S2:先把显示形的 url 对回真值,再去比启动向量 —— 否则我们自己遮掉的 `?api_key=…` 会让
  // 「原样回传」看起来像换了端点,一次保存就把 headers 清空。
  if (typeof mcpEntry.url === 'string' && urlRestores) mcpEntry = { ...mcpEntry, url: restoreDisplayUrl(mcpEntry.url, urlRestores) };
  const remote = mcpEntryIsRemote(mcpEntry);
  const sameTarget = !!prevEntry && typeof prevEntry === 'object' && mcpEntryIsRemote(prevEntry) === remote
    && (remote
      ? mcpEntryTrimmed(mcpEntry, 'url', 2000) === mcpEntryTrimmed(prevEntry, 'url', 2000)
      : (mcpEntryTrimmed(mcpEntry, 'command', 1000) === mcpEntryTrimmed(prevEntry, 'command', 1000)
        && mcpEntryTrimmed(mcpEntry, 'cwd', 1000) === mcpEntryTrimmed(prevEntry, 'cwd', 1000)));
  const out = { ...mcpEntry };
  if (Array.isArray(mcpEntry.args)) out.args = restoreMcpArgs(mcpEntry.args, sameTarget ? prevEntry.args : null);
  const sameArgs = sameTarget && JSON.stringify(mcpEntryArgStrings(out.args)) === JSON.stringify(mcpEntryArgStrings(prevEntry.args));
  const valuesFrom = sameArgs ? prevEntry : null;
  if (mcpEntry.env && typeof mcpEntry.env === 'object') out.env = restoreMcpSecretValues(mcpEntry.env, valuesFrom && valuesFrom.env);
  if (mcpEntry.headers && typeof mcpEntry.headers === 'object') out.headers = restoreMcpSecretValues(mcpEntry.headers, valuesFrom && valuesFrom.headers);
  return out;
}
function mcpEntryIdKey(mcpEntry) {
  return String((mcpEntry && mcpEntry.id) || '').trim().slice(0, 64);   // 与 sanitizeExternalMcpServer 的 id 归一同口径
}
function restoreExternalMcpServersSecrets(incomingList, currentList, urlRestores) {
  if (!Array.isArray(incomingList)) return incomingList;
  const byId = new Map();
  for (const prevEntry of (Array.isArray(currentList) ? currentList : [])) {
    if (prevEntry && typeof prevEntry === 'object') byId.set(mcpEntryIdKey(prevEntry), prevEntry);
  }
  const restores = urlRestores || collectDisplayUrlRestores({ externalMcpServers: currentList });
  return incomingList.map(mcpEntry => ((mcpEntry && typeof mcpEntry === 'object')
    ? restoreExternalMcpServerSecrets(mcpEntry, byId.get(mcpEntryIdKey(mcpEntry)) || null, restores)
    : mcpEntry));
}
// 最后一道闸(sanitizeExternalMcpServer 每次读、写配置都过):仍是掩码的 env／headers 值、仍带脱敏标记的 arg
// 都不是真值 —— 能还原的上面已经还原了,走到这里还剩下的一律清空。写 externalMcpServers 的每一个口子
// (POST /api/config、steward_config_set、mcp_configure、import-folder、import-config/apply、Claude Code 自动导入)
// 与 drop-in 运行时合并都经 sanitize,所以掩码到不了磁盘、.mcp.json、Claude／Kimi 同步产物和 MCP 子进程的 env。
function mcpSecretValueOrCleared(value) {
  return value.startsWith(KEY_MASK_PREFIX) ? '' : value;
}
// 107-S2:同一道闸的 providers／searchBackend／modelsApi* 版本(sanitizeProvider 与 normalizeConfig 里各自的
// 消毒点调它)。密钥类【整串以掩码前缀开头】才是掩码;URL 类的掩码藏在串中间(`?api_key=••••cdef`),所以
// 用 includes。清空是保守方向:宁可端点变成空、让用户在设置页看见「没填」,也不把 `••••` 写进 config.json
// 再当成真凭据发出去(S0b 反向 ㈡b 见过掩码一路流进子进程 env 的现场)。
function configSecretValueOrCleared(value) {
  return (typeof value === 'string' && value.startsWith(KEY_MASK_PREFIX)) ? '' : value;
}
function configUrlOrCleared(value) {
  return (typeof value === 'string' && value.includes(KEY_MASK_PREFIX)) ? '' : value;
}
// v0.9-S9: single mask helper covering ALL config secrets that leave the process in an API response:
// every providers[].apiKey AND searchBackend.apiKey. Returns a shallow-enough copy so mutating the mask
// never touches the on-disk config. providers[] additionally gets a `hasKey` boolean (UI "key present"
// indicator). searchBackend gets `hasKey` too for symmetry.
function maskSecrets(config) {
  if (!config || typeof config !== 'object') return config;
  const out = { ...config };
  delete out.privacyRulesV1;
  if (Array.isArray(config.providers)) {
    out.providers = config.providers.map(p => {
      if (!p || typeof p !== 'object') return p;
      const key = typeof p.apiKey === 'string' ? p.apiKey : '';
      return {
        ...p, apiKey: maskKey(key), hasKey: key.length > 0,
        // 107-S2(L3):三个 URL 字段都用 safeUrlForDisplay。没有凭据的地址逐字节不变(绝大多数配置),
        // 所以这三行对既有安装是零行为变化;带 `u:p@` 或 `?api_key=` 的才会看到脱敏形。
        ...(typeof p.baseUrl === 'string' && p.baseUrl ? { baseUrl: safeUrlForDisplay(p.baseUrl) } : {}),
        ...(typeof p.audioBaseUrl === 'string' && p.audioBaseUrl ? { audioBaseUrl: safeUrlForDisplay(p.audioBaseUrl) } : {}),
        ...(Array.isArray(p.extraBaseUrls) ? { extraBaseUrls: p.extraBaseUrls.map(v => (typeof v === 'string' ? safeUrlForDisplay(v) : v)) } : {}),
        ...(p.extraHeaders ? { extraHeaders: maskExtraHeaders(p.extraHeaders) } : {}),
      };
    });
  }
  if (config.searchBackend && typeof config.searchBackend === 'object') {
    const key = typeof config.searchBackend.apiKey === 'string' ? config.searchBackend.apiKey : '';
    out.searchBackend = {
      ...config.searchBackend, apiKey: maskKey(key), hasKey: key.length > 0,
      ...(typeof config.searchBackend.baseUrl === 'string' && config.searchBackend.baseUrl ? { baseUrl: safeUrlForDisplay(config.searchBackend.baseUrl) } : {}),   // 107-S2(L3)
    };
  }
  // 107-S0(46 号文 §1.5 ②):modelsApiKey 是 Claude CLI 引擎的认证覆盖值(buildClaudeCliEnv 把它交给子进程当
  // ANTHROPIC_AUTH_TOKEN／ANTHROPIC_API_KEY),真机上非空。修前本函数只盖上面两处,GET /api/status 与
  // POST /api/config 的回包把它明文下发。同一条 maskKey 规则;不加 has… 布尔 —— 设置页那个输入框与
  // providers[].apiKey 同一模具(掩码原样播种、原样回传,保存路径的 unmaskSecrets 还原),用不上它。
  if (typeof config.modelsApiKey === 'string') out.modelsApiKey = maskKey(config.modelsApiKey);
  if (typeof config.modelsApiBase === 'string' && config.modelsApiBase) out.modelsApiBase = safeUrlForDisplay(config.modelsApiBase);   // 107-S2(L3):Claude CLI 第三方端点地址同族
  // 107-S0b:外部 MCP 连接器 —— env／headers 的值全遮、args 显示脱敏(口径见上面 maskExternalMcpServerForDisplay)。
  // 107-S2:再加远程条目的 url。
  if (Array.isArray(config.externalMcpServers)) out.externalMcpServers = config.externalMcpServers.map(maskExternalMcpServerForDisplay);
  return out;
}
// F2: reverse of the mask on the SAVE path. The UI echoes the masked apiKey (`••••abcd`) straight back on
// POST /api/config; restore the real key from the same-id provider (or the on-disk searchBackend) before
// persisting (no match → treat as cleared, i.e. empty). A genuinely new plaintext key (not starting with
// the mask prefix) passes through untouched. Covers providers[].apiKey AND searchBackend.apiKey.
// 107-S2:整个还原过程先把【显示形的 URL】对回真值(restores),再按「同 id ＋ 启动向量没变」决定要不要
// 还原密钥。向量变了(或压根没有同 id 那一条)一律按清空处理 —— 与 S0b 的 MCP 段同口径。
// 注意分工:这里的清空是【兜底】,正常路径上 applyConfigPatch／provider/test 先用 maskedSecretConflicts
// 整份拒绝,用户不会走到「密钥被悄悄清掉」这一步;兜底留着是为了将来某个新写口忘了调那道闸时,最坏
// 结果仍然只是「密钥没了」,而不是「密钥跟着去了新端点」。
function unmaskSecrets(incoming, current) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  const out = { ...incoming };
  const currentProviders = current && Array.isArray(current.providers) ? current.providers : [];
  const urlRestores = collectDisplayUrlRestores(current);
  if (Array.isArray(incoming.providers)) {
    const byId = new Map(currentProviders.map(p => [String(p && p.id || ''), p]));
    out.providers = incoming.providers.map(p0 => {
      if (!p0 || typeof p0 !== 'object') return p0;
      const p = restoreProviderDisplayUrls(p0, urlRestores);
      const prev = byId.get(String(p.id || ''));
      // 启动向量闸(M5):同 id、且这次保存【没有把密钥送去任何新地址】(收窄可以,见
      // providerVectorNotWidened),回传的掩码才算「用户没动这个框」;否则它就是一把
      // 「看不见密钥也能把它贴到新端点上」的钥匙。
      const sameVector = !!prev && providerVectorNotWidened(p, prev);
      const from = sameVector ? prev : null;
      let r = p;
      const key = typeof p.apiKey === 'string' ? p.apiKey : '';
      if (key.startsWith(KEY_MASK_PREFIX)) {
        r = { ...r, apiKey: (from && typeof from.apiKey === 'string') ? from.apiKey : '' };
      }
      // 还原仍为掩码的敏感自定义头(用户没改它,原样回显 -> 取磁盘上的真实值);非掩码值(用户新填/改的)直通。
      // 它们与 apiKey 去的是同一批地址,所以共用上面那道向量闸。
      if (r.extraHeaders && typeof r.extraHeaders === 'object') {
        const prevHeaders = (from && from.extraHeaders && typeof from.extraHeaders === 'object') ? from.extraHeaders : {};
        const restored = {};
        let changed = false;
        for (const [hk, hv] of Object.entries(r.extraHeaders)) {
          if (isSensitiveHeaderName(hk) && typeof hv === 'string' && hv.startsWith(KEY_MASK_PREFIX)) {
            restored[hk] = Object.prototype.hasOwnProperty.call(prevHeaders, hk) ? prevHeaders[hk] : '';
            changed = true;
          } else restored[hk] = hv;
        }
        if (changed) r = { ...r, extraHeaders: restored };
      }
      return r;
    });
  }
  if (incoming.searchBackend && typeof incoming.searchBackend === 'object') {
    const sb = { ...incoming.searchBackend };
    if (typeof sb.baseUrl === 'string') sb.baseUrl = restoreDisplayUrl(sb.baseUrl, urlRestores);
    const key = typeof sb.apiKey === 'string' ? sb.apiKey : '';
    const prev = current && current.searchBackend && typeof current.searchBackend === 'object' ? current.searchBackend : null;
    // 107-S2:searchBackend 的启动向量 = type + baseUrl(web_search 把这个 key 发去的就是那一个地址)。
    const sameVector = !!prev && String(sb.type || '') === String(prev.type || '')
      && String(sb.baseUrl || '').trim() === String(prev.baseUrl || '').trim();
    if (key.startsWith(KEY_MASK_PREFIX)) sb.apiKey = (sameVector && typeof prev.apiKey === 'string') ? prev.apiKey : '';
    out.searchBackend = sb;
  }
  // 107-S0:modelsApiKey 同口径 —— 仍是掩码(用户没动那个框)就取磁盘上的真值;新填的明文、清成空串都直通。
  // 107-S2:它的启动向量是 modelsApiBase(buildClaudeCliEnv 把它当 ANTHROPIC_AUTH_TOKEN 交给子进程,
  // 送去的正是那个 base)。patch 里没带 modelsApiBase = 这次不改它,向量没变。
  if (typeof incoming.modelsApiBase === 'string') out.modelsApiBase = restoreDisplayUrl(incoming.modelsApiBase, urlRestores);
  if (typeof incoming.modelsApiKey === 'string' && incoming.modelsApiKey.startsWith(KEY_MASK_PREFIX)) {
    const prevBase = String((current && current.modelsApiBase) || '').trim();
    const nextBase = Object.prototype.hasOwnProperty.call(incoming, 'modelsApiBase') ? String(out.modelsApiBase || '').trim() : prevBase;
    out.modelsApiKey = (nextBase === prevBase && current && typeof current.modelsApiKey === 'string') ? current.modelsApiKey : '';
  }
  // 107-S0b:externalMcpServers 按 id＋键名还原,且只在启动向量没变时还原(见 restoreExternalMcpServerSecrets)。
  if (Array.isArray(incoming.externalMcpServers)) {
    out.externalMcpServers = restoreExternalMcpServersSecrets(incoming.externalMcpServers, current && current.externalMcpServers, urlRestores);
  }
  return out;
}
// Back-compat thin wrappers (v0.8-S8 repo-hygiene e2e + existing callers reference these names). maskProviders
// now masks searchBackend too (the response-mask path wants ALL secrets covered); unmaskProviders keeps the
// providers-array signature for the /api/provider/test path that passes just the array.
function maskProviders(config) { return maskSecrets(config); }
// 107-S2:与 unmaskSecrets 的 providers 段【同一道启动向量闸】。这条路是 POST /api/provider/test 走的 ——
// 它会拿还原后的 key 真的发一次请求出去,所以「改了 baseUrl ＋ 回传掩码」在这里的后果是把真 key
// 主动送到新地址上,比落盘那条更直接。路由层另有 maskedSecretConflicts 先整份拒绝、根本不发请求。
function unmaskProviders(incoming, currentProviders) {
  if (!Array.isArray(incoming)) return incoming;
  const list = Array.isArray(currentProviders) ? currentProviders : [];
  const byId = new Map(list.map(p => [String(p && p.id || ''), p]));
  const urlRestores = collectDisplayUrlRestores({ providers: list });
  return incoming.map(p0 => {
    if (!p0 || typeof p0 !== 'object') return p0;
    const p = restoreProviderDisplayUrls(p0, urlRestores);
    const prevEntry = byId.get(String(p.id || ''));
    const prev = (prevEntry && providerVectorNotWidened(p, prevEntry)) ? prevEntry : null;
    let r = p;
    const key = typeof p.apiKey === 'string' ? p.apiKey : '';
    if (key.startsWith(KEY_MASK_PREFIX)) {
      r = { ...r, apiKey: (prev && typeof prev.apiKey === 'string') ? prev.apiKey : '' };
    }
    if (r.extraHeaders && typeof r.extraHeaders === 'object') {
      const prevHeaders = (prev && prev.extraHeaders && typeof prev.extraHeaders === 'object') ? prev.extraHeaders : {};
      const restored = {}; let changed = false;
      for (const [hk, hv] of Object.entries(r.extraHeaders)) {
        if (isSensitiveHeaderName(hk) && typeof hv === 'string' && hv.startsWith(KEY_MASK_PREFIX)) {
          restored[hk] = Object.prototype.hasOwnProperty.call(prevHeaders, hk) ? prevHeaders[hk] : '';
          changed = true;
        } else restored[hk] = hv;
      }
      if (changed) r = { ...r, extraHeaders: restored };
    }
    return r;
  });
}

// v0.7d: sanitize one user-defined external MCP server entry. stdio: id + command required (a server
// with no command is useless and could smuggle a non-string into cp.spawn). env values coerced to strings.
// 49c:远程条目(type/transport: sse|http|streamable-http)id + http(s) url 必备;headers 值保留 ${VAR}
//   引用【不展开】—— 连接时由 McpHttpClient 从 process.env 展开,密钥永不明文落盘(03 §4.2 纪律)。
function sanitizeExternalMcpCommon(raw) {
  const out = { enabled: raw.enabled !== false };
  for (const key of ['startupTimeoutMs', 'toolTimeoutMs']) {
    const value = Number(raw[key]);
    if (Number.isInteger(value) && value >= 1 && value <= 2147483647) out[key] = value;
  }
  for (const key of ['enabledTools', 'disabledTools']) {
    if (Array.isArray(raw[key])) out[key] = raw[key].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().slice(0, 160)).slice(0, 256);
  }
  // 122-§2.6:来源标记。只放行 'claude-code' 与 'ruyi' 两个值,其它一律丢弃(normalizeConfig 每次读配置
  // 都会过这里,所以外部写进来的任意字符串活不过一次读写)。【缺省不补字段】—— 存量条目没有它,读侧一律
  // 视为 'ruyi'(照旧同步回 Claude Code),行为与修前逐字节一致。谁在读:syncMcpServersToClaude 跳过
  // 'claude-code'(那是从 Claude Code 导进来的,不能再同步回去把用户删掉的条目复活)。
  const origin = String(raw.origin || '').trim();
  if (origin === 'claude-code' || origin === 'ruyi') out.origin = origin;
  // W2 迁移中心:自动导入扩到 Codex / Kimi Code 两家,来源标记同一用途(反向同步据此不外溢、不回写)。
  else if (origin === 'codex' || origin === 'kimi') out.origin = origin;
  return out;
}

function sanitizeExternalMcpServer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().slice(0, 64);
  if (!id) return null;
  const label = (typeof raw.label === 'string' ? raw.label : '').trim().slice(0, 80) || id;
  const typeRaw = String(raw.type || raw.transport || 'stdio').toLowerCase();
  if (typeRaw === 'sse' || typeRaw === 'http' || typeRaw === 'streamable-http') {
    const url = (typeof raw.url === 'string' ? raw.url : '').trim().slice(0, 2000);
    if (!/^https?:\/\//i.test(url)) return null;
    // 107-S2:还带着掩码的远程地址(`?api_key=••••cdef`)既不能落盘也没法「清空」——url 是远程条目的必备
    // 字段,清空等于整条连接器静默消失。所以这里【整条丢弃】,而正常写口(POST /api/config、
    // steward_config_set、mcp_configure)都先经 maskedSecretConflicts 整份拒绝,根本走不到这一行。
    if (url.includes(KEY_MASK_PREFIX)) return null;
    const headers = {};
    if (raw.headers && typeof raw.headers === 'object') {
      for (const [k, v] of Object.entries(raw.headers)) {
        if (typeof k === 'string' && typeof v === 'string') headers[k.slice(0, 120)] = mcpSecretValueOrCleared(v.slice(0, 2048));   // 107-S0b 最后一道闸
      }
    }
    const bearerTokenEnvVar = typeof raw.bearerTokenEnvVar === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.bearerTokenEnvVar.trim())
      ? raw.bearerTokenEnvVar.trim() : '';
    return {
      id, label, transport: typeRaw === 'sse' ? 'sse' : 'http', url, headers,
      ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}), ...sanitizeExternalMcpCommon(raw),
    };
  }
  const command = (typeof raw.command === 'string' ? raw.command : '').trim().slice(0, 1000);
  if (!command) return null;
  // 107-S0b 最后一道闸:仍带脱敏标记的 arg 与仍是掩码的 env 值清空(见 mcpSecretValueOrCleared 头注)。
  const args = Array.isArray(raw.args) ? raw.args.filter(a => typeof a === 'string').slice(0, 50).map(a => (a.includes(REDACTED_MARKER) ? '' : a)) : [];
  const env = {};
  if (raw.env && typeof raw.env === 'object') {
    for (const [k, v] of Object.entries(raw.env)) {
      if (typeof k === 'string' && (typeof v === 'string' || typeof v === 'number')) env[k.slice(0, 120)] = mcpSecretValueOrCleared(String(v).slice(0, 2048));
    }
  }
  return {
    id,
    label,
    command,
    args,
    cwd: (typeof raw.cwd === 'string' ? raw.cwd : '').trim().slice(0, 1000),
    env,
    ...sanitizeExternalMcpCommon(raw),
  };
}

module.exports = {
  KEY_MASK_PREFIX, maskKey, safeUrlForDisplay,
  configSecretValueOrCleared, configUrlOrCleared,
  maskSecrets, unmaskSecrets, maskProviders, unmaskProviders,
  maskedSecretConflicts, maskedSecretConflictMessage, providerLaunchVectorKey,
  collectDisplayUrlRestores, maskExternalMcpServerForDisplay,
  mcpArgsForDisplay, restoreExternalMcpServerSecrets, sanitizeExternalMcpServer,
};
