'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ssrfCheck, dnsResolvesToPrivate } = require('./network-policy.cjs');
const { decodeHtmlBody, classifyFetchedBody } = require('./http-body.cjs');
const { browserHeaders, httpGetGuarded } = require('./http-transport.cjs');
const { httpRequest, webFetchFailMessage } = require('./http-request.cjs');
const { boundedReadPage } = require('./text-pages.cjs');
const { extractMainText, parseBingHtml, parseBaiduHtml, SEARCH_CJK_RE, searchPageBlocked, mergeSearchResults } = require('./html-content.cjs');
const nowIso = () => new Date().toISOString();
function safeJsonParse(raw) {
  try { return JSON.parse(typeof raw === 'string' && raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); }
  catch { return null; }
}
function createWebTools({ cacheDirectory, atomicWriteJson, network }) {
// Web cache: dataRoot/webcache/<sha256(url)>.json holding {url,title,text,ts}. Written after a successful
// fetch; read as an OFFLINE fallback (no TTL — an old copy is still useful when there is no network — but the
// stored ts is returned so the model can judge freshness). Exported for direct e2e read/write testing.
function webCachePath(url) {
  const h = crypto.createHash('sha256').update(String(url)).digest('hex');
  return path.join(cacheDirectory, `${h}.json`);
}
async function readWebCache(url) {
  try {
    const raw = await fsp.readFile(webCachePath(url), 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && typeof j.text === 'string') return j;
  } catch { /* miss */ }
  return null;
}
async function writeWebCache(entry) {
  try {
    await fsp.mkdir(cacheDirectory, { recursive: true });
    await atomicWriteJson(webCachePath(entry.url), JSON.stringify(entry));   // 25.1 收编
    await evictWebCacheOverCap();
  } catch { /* best-effort cache write; never fail the fetch on a cache error */ }
}
// 缓存条目现在存完整抽取文本(既有下载硬界内,重定向后还有第二份),没有上限会无限长。这里是【硬兜底】:超过 WEB_CACHE_HARD_MAX_ENTRIES
// (WCW_WEBCACHE_HARD_MAX 可覆写,测试缝)条就按 mtime 删最旧的;用户配的 storagePolicy.webcacheMaxEntries(可更小)仍由 storageSweep 管。
const WEB_CACHE_HARD_MAX_ENTRIES = 2000;
async function evictWebCacheOverCap() {
  const max = Math.max(1, Math.floor(Number(process.env.WCW_WEBCACHE_HARD_MAX)) || WEB_CACHE_HARD_MAX_ENTRIES);
  let files = [];
  try { files = (await fsp.readdir(cacheDirectory)).filter(f => f.endsWith('.json')); } catch { return 0; }
  if (files.length <= max) return 0;
  const rows = [];
  for (const f of files) {
    const st = await fsp.stat(path.join(cacheDirectory, f)).catch(() => null);
    if (st) rows.push({ f, mtime: st.mtimeMs });
  }
  rows.sort((a, b) => a.mtime - b.mtime || (a.f < b.f ? -1 : 1));
  let n = 0;
  for (const v of rows.slice(0, Math.max(0, rows.length - max))) { await fsp.unlink(path.join(cacheDirectory, v.f)).catch(() => {}); n += 1; }
  return n;
}

const WEB_FETCH_DEFAULT_CHARS = 20000;
const WEB_FETCH_MAX_CHARS = 60000;            // 与工具结果 ~60K 的上限对齐:再大只会被截头
const WEB_FETCH_PAGE_TTL_MS = 10 * 60 * 1000;
// 只列出本页 text 里真出现了 [n] 标记的链接,总长有预算,避免把整页的链接表都塞进每一页。
function webFetchPageLinks(pageText, links) {
  const out = [];
  let budget = 6000, cut = false;
  for (const l of Array.isArray(links) ? links : []) {
    if (!pageText.includes('[' + l.n + ']')) continue;
    const line = '[' + l.n + '] ' + l.url;
    if (budget - line.length < 0) { cut = true; break; }
    budget -= line.length;
    out.push(line);
  }
  return { links: out, linksTruncated: cut };
}
async function webFetch(args = {}, opts = {}) {
  const url = String(args.url || '').trim();
  const maxChars = Math.min(WEB_FETCH_MAX_CHARS, Math.max(500, Number(args.maxChars) || WEB_FETCH_DEFAULT_CHARS));
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  if (!url) return { ok: false, error: 'url is required' };
  // Fast SSRF reject up-front (also blocks non-http/https + literal internal targets) — a blocked target
  // never even attempts a socket, and NEVER falls back to cache (a blocked url must not leak cached content).
  const pre = ssrfCheck(url);
  if (!pre.allowed) return { ok: false, error: pre.reason, blocked: pre.host };
  const sb = opts.config && opts.config.searchBackend;
  const deepseek = sb && sb.type === 'deepseek';
  if (deepseek) {
    const parsed = new URL(url);
    if (url.length > 8192 || parsed.username || parsed.password) return { ok: false, error: 'DeepSeek Fetch 需要不含用户名密码、长度不超过 8192 的网址', backend: 'deepseek' };
    const dns = await dnsResolvesToPrivate(parsed.hostname);
    if (dns && dns.blocked) return { ok: false, error: '目标地址解析到内网/回环', blocked: dns.host };
  }
  const cacheMatches = entry => entry && (deepseek ? entry.backend === 'deepseek' : entry.backend !== 'deepseek');
  // 一页 = 缓存条目的一个切片;live / cache 共用同一个出口,保证 truncated / nextOffset 的口径一致。
  const pageOf = (entry, extra) => {
    const full = String(entry.text || '');
    const oldPartialCache = entry.truncated === true;
    return boundedReadPage(full, offset, maxChars, (text, end, start) => {
      const more = end < full.length;
      const res = { ok: true, url: entry.url || url, title: entry.title || '', text, offset: start, totalChars: full.length,
        truncated: more || entry.sourceTruncated === true || oldPartialCache, ts: entry.ts || null, ...extra };
      if (more) res.nextOffset = end;
      for (const key of ['contentType', 'charset', 'warning', 'note', 'backend']) if (entry[key]) res[key] = entry[key];
      if (oldPartialCache) {
        res.sourceTruncated = true;
        res.note = '旧缓存只保存了部分正文;totalChars 是已保存量,不是整页总量。';
        res.hint = '可用 nextOffset 读完已保存部分;末页无 nextOffset。需要全文时联网重新抓取,或 http_download 保存后 file_read 分段读;不要重复当前 offset。';
      } else if (entry.sourceTruncated) {
        res.sourceTruncated = true;
        res.hint = '源响应超过下载读取上限,这里只保留已抓到的部分;totalChars 是已抓取文本长度,不是整页总量。需要其余内容时用 http_download 保存完整响应,再 file_read 分段读取;不要重复当前 offset。';
      }
      const pl = webFetchPageLinks(text, entry.links);
      if (pl.links.length) res.links = pl.links;
      if (pl.linksTruncated) res.linksTruncated = true;
      if (offset > 0 && offset >= full.length) res.note = res.note || `offset 超出正文长度(${full.length} 字符)`;
      return res;
    });
  };
  if (offset > 0) {
    const hit = await readWebCache(url);
    const age = hit && hit.ts ? Date.parse(hit.ts) : NaN;
    if (cacheMatches(hit) && hit.truncated !== true && Number.isFinite(age) && Date.parse(nowIso()) - age < WEB_FETCH_PAGE_TTL_MS) return pageOf(hit, { fromCache: true });
  }
  if (deepseek) {
    const got = await deepseekWebRequest(sb, 'fetch', { url }, { timeoutMs: 30000, signal: opts.signal });
    if (got.ok) {
      if (typeof got.data.content !== 'string' || !got.data.content.trim()) return { ok: false, error: 'DeepSeek Fetch 未返回 Markdown 正文', backend: 'deepseek', parseFailed: true };
      const entry = { url, title: String(got.data.title || ''), text: got.data.content, ts: nowIso(), backend: 'deepseek', contentType: 'text/markdown' };
      await writeWebCache(entry);
      network.markOnline();
      return pageOf(entry, { fromCache: false });
    }
    // 授权、余额、拒绝访问和页面删除均照实报告；仅临时网络/服务故障允许读旧缓存。
    if (got.failClass !== 'aborted' && (!got.statusCode || got.statusCode === 408 || got.statusCode === 429 || got.statusCode >= 500) && !got.parseFailed && got.failClass !== 'invalid_request') {
      const cached = await readWebCache(url);
      if (cacheMatches(cached)) return pageOf(cached, { fromCache: true, staleReason: got.error });
    }
    return got;
  }
  const got = await httpGetGuarded(url, { totalTimeoutMs: 30000, signal: (opts && opts.signal) || null });
  if (got.ok && got.body) {
    const kind = classifyFetchedBody(got.contentType, got.body);
    if (kind.kind === 'binary') {
      return { ok: false, error: `该网址返回的是 ${kind.type || '二进制内容'},不是网页文本`, failClass: 'not-text', contentType: kind.type || null,
        hint: '用 http_download 把它保存到工作区,再用对应的文件/文档工具读取(PDF、Office、压缩包等)' };
    }
    const dec = decodeHtmlBody(got.body, got.contentType);
    const finalUrl = got.finalUrl || url;
    let title = '', text, links = [], note = '';
    if (kind.kind === 'html') {
      const ex = extractMainText(dec.text, { baseUrl: finalUrl });
      title = ex.title; text = ex.text; links = ex.links;
      if (text.length < 200 && (dec.text.match(/<script\b/gi) || []).length >= 3) note = '页面正文很少,可能依赖 JavaScript 渲染(本工具不执行脚本);可换个来源或用 web_search';
    } else {
      text = dec.text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    }
    const entry = { url: finalUrl, title, text, links, ts: nowIso(),
      contentType: kind.type || null, charset: dec.charset, ...(dec.warning ? { warning: dec.warning } : {}), ...(note ? { note } : {}),
      ...(got.truncated ? { sourceTruncated: true } : {}) };
    await writeWebCache(entry);
    if (url !== finalUrl) await writeWebCache(Object.assign({}, entry, { url })); // 重定向后按请求网址也能命中(离线回退 / 翻页都按请求网址查)
    // v1.1-W1a (T2): a real successful fetch is fresh proof we are online — nudge the capability cache so a
    // stale/single-target offline reading gets corrected for free.
    network.markOnline();
    // 本次调用直接用完整文本切页(不受缓存上限影响),truncated 含「源体被 2MB 上限截断」。
    return pageOf(entry, { fromCache: false, ...(got.viaProxy ? { viaProxy: true } : {}) });
  }
  // A guard-level block during a redirect hop → surface it as blocked, do NOT serve cache.
  if (got.blocked) return { ok: false, error: got.error, blocked: got.blocked };
  // v1.1-W1a (T1): the fetch failed. Map the structured failClass to 中文人话 — NEVER blindly claim "离线".
  const mapped = webFetchFailMessage(got);
  // 用户中断:不是网络故障,不回落缓存、不做联网探测,如实说「被中断」。
  if (got.failClass === 'aborted') return { ok: false, error: mapped.error, failClass: 'aborted' };
  // Cache fallback still applies (an air-gapped session reuses a prior fetch) —— 但只在【网络故障】时。
  // 对端明确答复「页面不存在 / 已删除」(HTTP 404 / 410)是权威的答复:修前这里也回落缓存,抓过一次的页面被删后,
  // 再抓回 ok:true + fromCache:true,把已下线的页面当成功读出来。这两个状态码不读缓存,照实报错。
  const pageGone = got.failClass === 'http' && (got.statusCode === 404 || got.statusCode === 410);
  const candidate = pageGone ? null : await readWebCache(url);
  const cached = cacheMatches(candidate) ? candidate : null;
  if (cached) return pageOf(cached, { fromCache: true, staleReason: mapped.error });
  // No cache. Decide the hint by a FAST live probe (multi-target, 2s) — only if that also fails do we say 离线.
  // 走了代理时不做这一探:探测走的是本机直连,代理网络里它必然失败,会把「代理没配好」误报成「当前疑似离线」。
  let hint = mapped.hint;
  if (!got.viaProxy) {
    const online = await network.probe(2000);
    if (online === false) hint = '当前疑似离线。' + '联网后重试,或先在线抓取一次以建立缓存';
    else network.markOnline(); // the probe just succeeded → refresh the cap cache
  }
  return { ok: false, error: mapped.error, failClass: got.failClass || 'other', statusCode: got.statusCode, hint };
}

function cancelledSearch(backend) {
  return { ok: false, error: '请求已被用户中断', failClass: 'aborted', backend };
}
async function builtinSearch(query, maxResults, baseUrlOverride, timeoutMs, baiduBaseUrlOverride, opts = {}) {
  if (opts.signal?.aborted) return cancelledSearch('builtin');
  const enc = encodeURIComponent(query);
  const cjk = SEARCH_CJK_RE.test(query);
  const bingRoot = baseUrlOverride || 'https://cn.bing.com';
  const baiduRoot = baiduBaseUrlOverride || (baseUrlOverride ? '' : 'https://www.baidu.com');
  const fetchPage = async (url, parse) => {
    try {
      const r = await httpRequest({ url, headers: browserHeaders(), timeoutMs, maxBodyChars: 1200000 }, { signal: opts.signal });
      if (!r.ok || typeof r.body !== 'string') return { results: [], failed: true, error: String((r && (r.error || (r.statusCode ? 'HTTP ' + r.statusCode : ''))) || 'request failed') };
      return { results: parse(r.body), blocked: searchPageBlocked(r.body) };
    } catch (e) { return { results: [], failed: true, error: String((e && e.message) || e) }; }
  };
  // 纯英文查询走 Bing 国际版结果(ensearch=1),中文查询走国内版。
  const bingUrl = first => `${bingRoot}/search?q=${enc}${cjk ? '' : '&ensearch=1'}${first > 1 ? '&first=' + first : ''}`;
  const bingP = fetchPage(bingUrl(1), h => parseBingHtml(h, 20));
  // 中文查询两个引擎并发取(百度的中文覆盖面补 Bing);英文查询只在 Bing 不够时才问百度。
  const baiduUrl = `${baiduRoot}/s?wd=${enc}&rn=${Math.min(20, Math.max(10, maxResults))}`;
  const baiduEarly = baiduRoot && cjk ? fetchPage(baiduUrl, h => parseBaiduHtml(h, 20)) : null;
  const bing = await bingP;
  if (opts.signal?.aborted) return cancelledSearch('builtin');
  let bingResults = bing.results;
  const enough = list => mergeSearchResults(query, list, maxResults).length >= maxResults;
  if (!enough([bingResults]) && bingResults.length >= 8) {
    const more = await fetchPage(bingUrl(bingResults.length + 1), h => parseBingHtml(h, 20));
    if (opts.signal?.aborted) return cancelledSearch('builtin');
    bingResults = bingResults.concat(more.results);
  }
  let baidu = baiduEarly ? await baiduEarly : { results: [] };
  if (opts.signal?.aborted) return cancelledSearch('builtin');
  if (!baiduEarly && baiduRoot && !enough([bingResults])) baidu = await fetchPage(baiduUrl, h => parseBaiduHtml(h, 20));
  if (opts.signal?.aborted) return cancelledSearch('builtin');
  const results = mergeSearchResults(query, [bingResults, baidu.results], maxResults);
  const engines = [bingResults.length ? 'bing' : '', results.some(r => r.source === 'baidu') ? 'baidu' : ''].filter(Boolean);
  if (results.length) {
    network.markOnline();
    return { ok: true, results, backend: 'builtin', engine: engines.join('+') || 'bing' };
  }
  if (bing.blocked || baidu.blocked) {
    return { ok: true, results: [], backend: 'builtin', blocked: true,
      note: '搜索引擎返回了人机验证页(反爬拦截),这次拿不到结果;稍后再试,或到 设置→搜索后端 换成 tavily / 博查 / searxng 等接口型后端' };
  }
  // 引擎根本没连上(断网/代理/DNS):这是失败,不是「没搜到」。修前一律 ok:true + 空结果,模型以为关键词不好、
  // 换着说法反复重搜。
  const tried = [bing, ...(baiduEarly || baidu.failed || (baidu.results && baidu.results.length) ? [baidu] : [])];
  if (tried.every(x => x && x.failed)) {
    return { ok: false, results: [], backend: 'builtin', failClass: 'network',
      error: '搜索引擎连不上(' + String(bing.error || 'request failed').slice(0, 160) + ')',
      hint: '多半是网络/代理问题,换关键词没有用;检查网络或 设置→网络代理,或到 设置→搜索后端 换一个接口型后端' };
  }
  if (!baiduRoot) return { ok: true, results: [], backend: 'builtin', engine: 'bing', note: 'Bing 未返回结果(已覆写引擎地址,跳过百度兜底)' };
  return { ok: true, results: [], backend: 'builtin', note: '两个引擎都未返回结果' };
}

// web_search tool body. Fans out by searchBackend.type. searxng/custom baseUrl is TRUSTED (admin-configured)
// → NOT SSRF-checked (see note atop this section). Returns {ok, results:[{title,url,snippet}], backend}.
// NE-11:① 200 却不是 JSON(登录页 / WAF 页 / searxng 没开 json 格式)不再静默回 results:[],而是 ok:false 说明原因;
// ② 4xx / 5xx 带针对性的 hint;③ 配置的后端失败时回退一次内置免费搜索,结果里带 fallbackFrom / fallbackReason。
// 回退会把查询词发给公网的 Bing / 百度,所以:searxng / custom(管理员自托管 / 自选的端点,不论内网还是有域名)【永不】回退;
// bing / brave / tavily / bocha 这类 API-key 后端只有 searchBackend.fallbackToBuiltin === true(默认关)才回退;
// 没回退时结果带 fallbackSkipped 说明原因与该开关。
function searchFailFromResponse(backend, r) {
  const st = r.statusCode;
  const out = { ok: false, error: r.error || ('HTTP ' + st), backend };
  if (r.failClass) out.failClass = r.failClass;
  if (st) out.statusCode = st;
  if (r.hint) out.hint = r.hint;
  if (st === 403 && backend === 'searxng') out.hint = 'searxng 需要启用 JSON 输出:settings.yml 里 search.formats 加上 json(并确认没有被 limiter / 反向代理拦截)';
  else if (st === 401 || st === 403) out.hint = '检查 设置→搜索后端 的 API Key 是否正确、是否过期或无权限';
  else if (st === 429) out.hint = '触发限流或额度用完;稍后再试,或换一个搜索后端';
  else if (st >= 500) out.hint = '搜索服务暂时不可用;稍后再试';
  return out;
}
// 解析 JSON 型后端的 200 响应:返回 { body } 或 { fail }。
function searchParseJsonResponse(backend, r) {
  if (r.redirected) {
    return { fail: { ok: false, error: `搜索后端返回了重定向(HTTP ${r.statusCode} → ${(r.headers && r.headers.location) || '?'})`, hint: '把 设置→搜索后端 的地址改成重定向后的最终地址(常见是 http 改 https)', backend } };
  }
  const body = safeJsonParse(r.body, null);
  if (body === null || typeof body !== 'object') {
    return { fail: { ok: false, error: '搜索后端返回的不是 JSON 结果(可能被登录页 / WAF 拦截' + (backend === 'searxng' ? ',或 searxng 没有启用 json 格式' : '') + ')', hint: backend === 'searxng' ? 'searxng 需要启用 JSON 输出:settings.yml 里 search.formats 加上 json' : '检查后端地址是否正确、是否需要登录', backend, parseFailed: true } };
  }
  return { body };
}
function searchBackendNeverFallsBack(sb) { return !!sb && (sb.type === 'searxng' || sb.type === 'custom'); }
// DeepSeek 的独立 JSON API；同一管理员配置同时供 search/fetch 使用。不给重定向转发密钥，
// 不把远端错误正文带回模型；所有调用仍经零依赖 httpRequest 的硬超时、响应上限与取消。
async function deepseekWebRequest(sb, operation, payload, opts = {}) {
  const backend = 'deepseek';
  const apiKey = String(sb.apiKey || '').trim();
  if (!apiKey) return { ok: false, error: 'DeepSeek API Key 未配置', backend, failClass: 'invalid_request', hint: '在 设置→搜索后端 填入 DeepSeek API Key' };
  const root = String(sb.baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  const r = await httpRequest({ url: `${root}/v1/tools/${operation}`, method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey }, body: JSON.stringify(payload),
    timeoutMs: opts.timeoutMs || 12000, maxBodyChars: 2000000 }, { signal: opts.signal });
  if (!r.ok || r.redirected) {
    const fail = r.redirected ? searchParseJsonResponse(backend, r).fail : searchFailFromResponse(backend, r);
    if (r.redirected) { fail.parseFailed = true; fail.statusCode = r.statusCode; }
    if (r.failClass) fail.failClass = r.failClass;
    if (r.statusCode === 402) fail.hint = 'DeepSeek 账号余额不足,充值后再试';
    return fail;
  }
  const parsed = searchParseJsonResponse(backend, r);
  if (parsed.fail) return parsed.fail;
  if (r.truncated || parsed.body.error) return { ok: false, error: 'DeepSeek 返回不完整或错误响应', backend, parseFailed: true };
  return { ok: true, data: parsed.body };
}
async function webSearch(args, config, opts = {}) {
  if (opts.signal?.aborted) return cancelledSearch(config?.searchBackend?.type || 'none');
  const first = await webSearchViaBackend(args, config, opts);
  const sb = (config && config.searchBackend) || { type: 'none' };
  const backend = sb.type || 'none';
  if (opts.signal?.aborted) return cancelledSearch(backend);
  const query = String(args && args.query || '').trim();
  if (first.ok !== false || !query || backend === 'none' || backend === 'builtin' || first.failClass === 'invalid_request' || first.failClass === 'aborted') return first;
  if (searchBackendNeverFallsBack(sb)) return Object.assign({}, first, { fallbackSkipped: `搜索后端 ${backend} 失败;为避免把查询词发给公网搜索引擎,没有回退到内置搜索` });
  if (sb.fallbackToBuiltin !== true) return Object.assign({}, first, { fallbackSkipped: `搜索后端 ${backend} 失败;没有回退到内置免费搜索(会把查询词发给公网的 Bing / 百度)`, hint: ((first && first.hint) ? first.hint + ';' : '') + '如接受回退,在 config.json 的 searchBackend 里设 fallbackToBuiltin:true' });
  const maxResults = Math.min(20, Math.max(1, Number(args && args.maxResults) || 8));
  const timeoutMs = Number(args && args.timeoutMs) || 12000;
  let fb = null;
  // builtinBaseUrl / baiduBaseUrl:只给 e2e 用的引擎根地址替换(直接传进 webSearch 的配置对象里;normalizeConfig 不保留它们)。
  try { fb = await builtinSearch(query, maxResults, String(sb.builtinBaseUrl || '').trim().replace(/\/+$/, ''), timeoutMs, String(sb.baiduBaseUrl || '').trim().replace(/\/+$/, ''), opts); } catch { fb = null; }
  if (opts.signal?.aborted) return cancelledSearch('builtin');
  if (fb && fb.ok && Array.isArray(fb.results) && fb.results.length) {
    return Object.assign({}, fb, { fallbackFrom: backend, fallbackReason: first.error, note: `配置的搜索后端 ${backend} 失败(${first.error}),这次结果来自内置免费搜索` });
  }
  return Object.assign({}, first, { fallbackTried: 'builtin' });
}
async function webSearchViaBackend(args, config, opts = {}) {
  const query = String(args && args.query || '').trim();
  // 缺省 8 条(修前 5 条):内置搜索是抓网页,前几条常被百科 / 问答聚合占住,5 条经常不够把问题答全;结果只是短摘要,多几条不贵。
  const maxResults = Math.min(20, Math.max(1, Number(args && args.maxResults) || 8));
  const sb = (config && config.searchBackend) || { type: 'none' };
  const backend = sb.type || 'none';
  if (!query) return { ok: false, error: 'query is required', backend };
  if (backend === 'none') return { ok: false, error: '未配置搜索后端', hint: '到 设置→搜索后端 选择 内置免费搜索(builtin)/searxng/bing/brave/tavily/bocha/deepseek/custom', backend };
  const baseUrl = String(sb.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(sb.apiKey || '').trim();
  const timeoutMs = Number(args && args.timeoutMs) || 12000;
  try {
    if (backend === 'deepseek') {
      if (Array.from(query).length > 128) return { ok: false, error: 'DeepSeek 搜索词最多 128 个 Unicode 字符,请精简关键词', backend, failClass: 'invalid_request' };
      const got = await deepseekWebRequest(sb, 'search', { query, count: Math.floor(maxResults), need_content: false }, { timeoutMs, signal: opts.signal });
      if (!got.ok) return got;
      if (!Array.isArray(got.data.results)) return { ok: false, error: 'DeepSeek 响应缺少 results 数组', backend, parseFailed: true };
      return { ok: true, backend, results: got.data.results.slice(0, maxResults).filter(x => x && typeof x === 'object').map(x => ({
        title: String(x.title || ''), url: String(x.url || ''), snippet: String(x.snippet || x.summary || '').slice(0, 4000),
        ...(typeof x.summary === 'string' ? { summary: x.summary.slice(0, 4000) } : {}),
        ...(typeof x.date === 'string' ? { date: x.date } : {}),
      })) };
    }
    // v1.1-W1a (T3): 'builtin' — zero-config, no-key HTML search. Primary Bing CN, 兜底 百度. Both scraped
    // with the realistic browser headers (T1) so anti-scrape edges serve real HTML. Fully defensive parsing
    // (a shape change collapses to [] rather than throwing). Results are JSON text only — the front-end renders
    // them via textContent, so no XSS surface. baseUrl override (admin-trusted, 同 searxng 先例) redirects the
    // Bing root for e2e determinism; when set, the 百度 fallback is skipped (the fake server owns both paths).
    // sb.baiduBaseUrl:只给 e2e 用的百度根地址替换(直接传进 webSearch 的配置对象里;normalizeConfig 不保留它)。
    if (backend === 'builtin') return await builtinSearch(query, maxResults, baseUrl, timeoutMs, String(sb.baiduBaseUrl || '').trim().replace(/\/+$/, ''), opts);
    // 各 JSON 后端共用的收尾:请求 → 失败 / 非 JSON 说明 → 取出行 → 映射。extract(body) 返回行数组(缺失则 [])。
    const viaJson = async (reqArgs, extract, map, missingNote) => {
      const r = await httpRequest(Object.assign({ timeoutMs, maxBodyChars: 500000 }, reqArgs), { signal: opts.signal });
      if (!r.ok || r.redirected) {
        if (r.redirected) return searchParseJsonResponse(backend, r).fail;
        return searchFailFromResponse(backend, r);
      }
      const parsed = searchParseJsonResponse(backend, r);
      if (parsed.fail) return parsed.fail;
      const rows = extract(parsed.body);
      const list = Array.isArray(rows) ? rows : [];
      const out = { ok: true, results: list.slice(0, maxResults).map(map), backend };
      if (!Array.isArray(rows) && missingNote) out.note = missingNote;
      return out;
    };
    if (backend === 'searxng') {
      if (!baseUrl) return { ok: false, error: 'searxng baseUrl 未配置', backend };
      return await viaJson({ url: `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json` },
        b => b.results, x => ({ title: String(x.title || ''), url: String(x.url || ''), snippet: String(x.content || x.snippet || '') }),
        '响应是 JSON 但没有 results 字段,可能不是 searxng 的接口');
    }
    if (backend === 'bing') {
      return await viaJson({ url: `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${maxResults}`, headers: { 'Ocp-Apim-Subscription-Key': apiKey } },
        b => b.webPages && b.webPages.value, x => ({ title: String(x.name || ''), url: String(x.url || ''), snippet: String(x.snippet || '') }));
    }
    if (backend === 'brave') {
      return await viaJson({ url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`, headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' } },
        b => b.web && b.web.results, x => ({ title: String(x.title || ''), url: String(x.url || ''), snippet: String(x.description || '') }));
    }
    // v1.0-S6 (A): Tavily (AI 搜索 API). POST /search, JSON {api_key, query, max_results}; parse
    // results[].{title,url,content}. baseUrl override — searchBackend.baseUrl, when non-empty, REPLACES the
    // official host (enterprise proxy + e2e fake server). baseUrl is an ADMIN-configured TRUSTED endpoint
    // (同 searxng 先例) → NOT SSRF-checked. Empty → official https://api.tavily.com. Defensive parse: a
    // missing/невалид results array yields an empty list, never a crash.
    if (backend === 'tavily') {
      const root = baseUrl || 'https://api.tavily.com';
      return await viaJson({ url: `${root}/search`, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }) },
        b => b.results, x => ({ title: String((x && x.title) || ''), url: String((x && x.url) || ''), snippet: String((x && x.content) || '') }));
    }
    // v1.0-S6 (A): 博查 Bocha (中文搜索 API). POST /v1/web-search, Header Authorization: Bearer <key>,
    // JSON {query, count}; parse data.webPages.value[].{name,url,snippet} (按官方公开文档形状). baseUrl
    // override同上 (TRUSTED, not SSRF'd); empty → official https://api.bochaai.com. Fully defensive: any
    // missing hop in data.webPages.value collapses to an empty list, никогда crashes.
    if (backend === 'bocha') {
      const root = baseUrl || 'https://api.bochaai.com';
      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers['authorization'] = 'Bearer ' + apiKey;
      return await viaJson({ url: `${root}/v1/web-search`, method: 'POST', headers, body: JSON.stringify({ query, count: maxResults }) },
        b => b.data && b.data.webPages && b.data.webPages.value, x => ({ title: String((x && x.name) || ''), url: String((x && x.url) || ''), snippet: String((x && x.snippet) || '') }));
    }
    // custom: GET {baseUrl}?q=… ; best-effort parse of common {title,url,snippet} field shapes.
    if (backend === 'custom') {
      if (!baseUrl) return { ok: false, error: 'custom baseUrl 未配置', backend };
      const sep = baseUrl.includes('?') ? '&' : '?';
      const headers = {};
      if (apiKey) headers['authorization'] = 'Bearer ' + apiKey;
      return await viaJson({ url: `${baseUrl}${sep}q=${encodeURIComponent(query)}`, headers },
        b => (Array.isArray(b) ? b : (b && (b.results || b.items || b.data)) || []),
        x => ({
          title: String((x && (x.title || x.name || x.heading)) || ''),
          url: String((x && (x.url || x.link || x.href)) || ''),
          snippet: String((x && (x.snippet || x.content || x.description || x.summary)) || ''),
        }));
    }
    return { ok: false, error: '未知搜索后端: ' + backend, backend };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'search failed', hint: '检查搜索后端地址/密钥与联网状态', backend };
  }
}


return { webFetch, webSearch, webCachePath, readWebCache, writeWebCache };
}
module.exports = { createWebTools };
