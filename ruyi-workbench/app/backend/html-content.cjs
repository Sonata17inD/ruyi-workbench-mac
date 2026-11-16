'use strict';
function decodeEntities(s) {
  return String(s)
    // v1.1-W1a (T3): numeric (&#174;) and hex (&#xAE;) entities — common in scraped search-result HTML.
    // Decode BEFORE the named set so &#38; → & doesn't then get re-read as a named entity opener. Guard the
    // codepoint range (fromCodePoint throws on invalid) — a bad ref is left as-is rather than crashing.
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { const n = parseInt(h, 16); return (n >= 0 && n <= 0x10ffff) ? safeFromCodePoint(n, m) : m; })
    .replace(/&#(\d+);/g, (m, d) => { const n = parseInt(d, 10); return (n >= 0 && n <= 0x10ffff) ? safeFromCodePoint(n, m) : m; })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    // v1.1-W1a 把关补:实弹抽验发现 Bing 摘要含 &ensp; 未解码(「2013年8月27日&ensp;·&ensp;原始青花瓷…」)。
    // 补常见命名空白/标点实体;不认识的命名实体保持原样(不猜)。
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&thinsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”');
}
function safeFromCodePoint(n, fallback) { try { return String.fromCodePoint(n); } catch { return fallback; } }
// ── NE-9:web_fetch 正文抽取(零依赖分词器 + 单趟渲染)──────────────────────────────────────────────
// 修前的做法是「块级标签换行、其余标签一刀切」:导航 / 侧栏 / 页脚原样进正文(还排在文章前面),链接地址整个丢掉,
// <pre> 缩进被折叠,模型读完索引页没有任何可跟进的网址。现在:
//   · nav / aside / select / button / iframe / svg / object / canvas / template 整块丢掉;header / footer 只丢【不在
//     main / article 里】的(文章自己的题头带标题与日期);role=navigation|banner|contentinfo|complementary|search 同样丢。
//     <form> 【不丢】:ASP.NET WebForms(老政企站的主力)用一个 <form> 包住整页,丢了就是空页。
//   · 页里有 <main> 取 <main>,否则有 <article> 取全部 <article>(取出来太短就退回整页,防止把一个小推荐卡当成正文)。
//   · h1-h6 → `# 标题`,li → `- 条目`,表格单元格以 ` | ` 相隔,<pre> 整块原样(围栏 ```),其余空白折叠。
//   · <a href> → 「链接文字 [n]」,网址按序号放进返回的 links 数组(相对地址按 baseUrl 解析,去掉 #锚点 / javascript: /
//     mailto: 等;正文里没有可读链接文字的图片链接不编号)。
// 被丢弃的元素要求「关标签数 ≥ 开标签数」才生效(某个 <nav> 忘了关会吞掉整页后文,宁可不丢)。
const HTML_VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const HTML_DROP_TAGS = new Set(['nav', 'aside', 'select', 'button', 'iframe', 'svg', 'object', 'canvas', 'template']);
const HTML_DROP_ROLES = /^(?:navigation|banner|contentinfo|complementary|search)$/i;
const HTML_BLOCK_TAGS = new Set(['div', 'section', 'article', 'main', 'header', 'footer', 'ul', 'ol', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'blockquote', 'figure', 'figcaption', 'address', 'details', 'summary', 'form', 'fieldset', 'center', 'body']);
const HTML_MAX_LINKS = 300;
function htmlTokenize(html) {
  const out = [];
  const counts = new Map();
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let last = 0, m;
  while ((m = re.exec(html))) {
    if (m.index > last) out.push({ t: html.slice(last, m.index) });
    const tag = m[2].toLowerCase();
    const selfClose = /\/\s*$/.test(m[3]) || HTML_VOID_TAGS.has(tag);
    out.push({ tag, close: m[1] === '/', attrs: m[3], selfClose });
    if (!selfClose) { const c = counts.get(tag) || { o: 0, c: 0 }; if (m[1]) c.c++; else c.o++; counts.set(tag, c); }
    last = re.lastIndex;
  }
  if (last < html.length) out.push({ t: html.slice(last) });
  out.counts = counts;
  return out;
}
function htmlTagAttr(attrs, name) {
  const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i').exec(String(attrs || ''));
  return m ? decodeEntities(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : '';
}
// 链接地址归一:相对地址按 baseUrl 解析;只留 http(s);去 #锚点;不可用 / 过长返回 ''。
function htmlResolveLink(href, baseUrl) {
  const h = String(href || '').trim();
  if (!h || h[0] === '#' || /^(?:javascript|mailto|tel|data|about|sms|file):/i.test(h)) return '';
  try {
    const u = baseUrl ? new URL(h, baseUrl) : new URL(h);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.hash = '';
    const s = u.toString();
    return s.length > 600 ? '' : s;
  } catch { return ''; }
}
// mode: 'all' | 'main' | 'article' —— 只渲染落在该区域里的内容。返回 { text, links:[{n,url}] }。
function htmlRenderTokens(tokens, mode, baseUrl, maxLinks) {
  const counts = tokens.counts || new Map();
  const droppable = tag => { const c = counts.get(tag); return !c || c.c >= c.o; };
  const parts = [], pres = [], links = [], linkIdx = new Map();
  let skipTag = null, skipDepth = 0, mainDepth = 0, articleDepth = 0, preDepth = 0, preBuf = '', anchor = null, cell = 0;
  const inRegion = () => mode === 'all' || (mode === 'main' ? mainDepth > 0 : articleDepth > 0);
  const flushPre = () => {
    let body = preBuf.replace(/\r\n?/g, '\n').replace(/^\n/, '').replace(/\s+$/, '');
    preBuf = '';
    if (!body) return;
    pres.push(body);
    parts.push('\n\n\uE000' + (pres.length - 1) + '\uE001\n\n');
  };
  for (const tk of tokens) {
    if (tk.t !== undefined) {
      if (skipTag || !inRegion()) continue;
      const d = decodeEntities(tk.t);
      if (preDepth > 0) { preBuf += d; continue; }
      const s = d.replace(/[ \t\r\n\f\v\u00a0]+/g, ' ');
      parts.push(s);
      if (anchor) anchor.text += s;
      continue;
    }
    const { tag, close } = tk;
    if (skipTag) {
      if (tag === skipTag && !tk.selfClose) { if (close) { skipDepth -= 1; if (skipDepth === 0) skipTag = null; } else skipDepth += 1; }
      continue;
    }
    const was = inRegion();
    if (!tk.selfClose) {
      const dlt = close ? -1 : 1;
      if (tag === 'main') mainDepth = Math.max(0, mainDepth + dlt);
      else if (tag === 'article') articleDepth = Math.max(0, articleDepth + dlt);
    }
    if (!close && !tk.selfClose && tag !== 'main' && tag !== 'article' && tag !== 'body' && tag !== 'html') {
      const role = htmlTagAttr(tk.attrs, 'role');
      const drop = (HTML_DROP_TAGS.has(tag) && droppable(tag))
        || ((tag === 'header' || tag === 'footer') && mainDepth === 0 && articleDepth === 0 && droppable(tag))
        || (role && HTML_DROP_ROLES.test(role) && droppable(tag));
      if (drop) { skipTag = tag; skipDepth = 1; continue; }
    }
    const now = inRegion();
    if (!was && !now) continue;
    if (tag === 'pre') {
      if (close) { if (preDepth > 0 && --preDepth === 0) flushPre(); } else { if (preDepth === 0) anchor = null; preDepth += 1; }
      continue;
    }
    if (preDepth > 0) { if (tag === 'br') preBuf += '\n'; continue; }
    if (tag === 'br') { parts.push('\n'); continue; }
    if (/^h[1-6]$/.test(tag)) { parts.push(close ? '\n\n' : '\n\n' + '#'.repeat(Number(tag[1])) + ' '); continue; }
    if (tag === 'li') { if (!close) parts.push('\n- '); continue; }
    if (tag === 'p' || tag === 'hr') { parts.push('\n\n'); continue; }
    if (tag === 'tr') { if (!close) { parts.push('\n'); cell = 0; } continue; }
    if (tag === 'td' || tag === 'th') { if (!close && cell++ > 0) parts.push(' | '); continue; }
    if (tag === 'a') {
      if (!close) { const href = htmlTagAttr(tk.attrs, 'href'); anchor = href ? { href, text: '' } : null; continue; }
      if (anchor) {
        const label = anchor.text.trim();
        const url = htmlResolveLink(anchor.href, baseUrl);
        anchor = null;
        if (label && url && !/^\[?\d+\]?$/.test(label)) {
          let n = linkIdx.get(url);
          if (!n && links.length < maxLinks) { n = links.length + 1; links.push({ n, url }); linkIdx.set(url, n); }
          if (n) parts.push(' [' + n + ']');
        }
      }
      continue;
    }
    if (HTML_BLOCK_TAGS.has(tag)) parts.push('\n');
  }
  if (preDepth > 0) flushPre();
  let s = parts.join('')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/^[ \u3000]+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  s = s.replace(/\uE000(\d+)\uE001/g, (m, i) => '```\n' + pres[Number(i)] + '\n```');
  return { text: s, links };
}
function extractMainText(html, opts) {
  const o = opts || {};
  let s = String(html == null ? '' : html);
  // title first (before we strip the head).
  let title = '';
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  if (tm) title = decodeEntities(tm[1].replace(/\s+/g, ' ').trim()).slice(0, 300);
  // <head> 与 script / style / noscript / textarea 整块、注释、DOCTYPE / XML 声明。<head> 的剥离是尽力而为:没有 </head> 的
  // 残页会把头留下,后面分词渲染时 <title> 的文字仍会当正文 —— 与修前一致。
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
       .replace(/<(script|style|noscript|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
       .replace(/<!--[\s\S]*?-->/g, ' ')
       .replace(/<![^>]*>|<\?[^>]*\?>/g, ' ');
  const tokens = htmlTokenize(s);
  const has = name => tokens.some(tk => tk.tag === name && !tk.close);
  const maxLinks = Math.max(0, Math.min(HTML_MAX_LINKS, Number(o.maxLinks) >= 0 ? Number(o.maxLinks) : HTML_MAX_LINKS));
  let r = null;
  if (has('main')) { r = htmlRenderTokens(tokens, 'main', o.baseUrl, maxLinks); if (r.text.length < 100) r = null; }
  if (!r && has('article')) { r = htmlRenderTokens(tokens, 'article', o.baseUrl, maxLinks); if (r.text.length < 200) r = null; }
  if (!r) r = htmlRenderTokens(tokens, 'all', o.baseUrl, maxLinks);
  return { title, text: r.text, links: r.links };
}

function htmlFragmentToText(frag) {
  return decodeEntities(String(frag == null ? '' : frag).replace(/<\/?(?:em|strong|b|i|u|span|a|font|mark|small|sup|sub)\b[^>]*>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 300);
}
// ── 内置免费搜索(builtin:Bing CN 为主、百度补充)的解析与合并 ────────────────────────────────────────────
// 2026-09 排查「搜不准、不全、搜到垃圾」的根因,都在这一段:
//   · 百度:`\bresult\b` 把 `result-op`(百度自家的「大家还在搜 / 视频 / 图片」卡片)也匹配进来,广告块也没滤 —— 垃圾结果;
//     摘要取到第一个闭合标签就停(常常停在第一个高亮关键词 </em>)—— 摘要不全;网址全是 baidu.com/link?url= 跳转链接,
//     真实网址其实就在容器的 mu 属性里;
//   · Bing:块里没有 <h2> 时退回「块里第一个链接」,把相关搜索、底部广告的链接当成结果;ck/a 跳转链接没解码;
//     每块切到下一个 b_algo 为止,最后一块会吞进分页、相关搜索、底部广告;
//   · 合并:只在 Bing 一条都没有时才问百度、不去重、不翻页;英文查询也走国内版;遇到人机验证页只说「没有结果」。
// 现在:按元素配平切块、只认标题链接、解开跳转、滤广告与自家卡片;中文查询两个引擎并发取、交错合并去重,不够再翻页;
// 与查询零重合的结果排到最后;被人机验证拦下时如实说明并给出换后端的建议。
const SEARCH_CJK_RE = /[㐀-鿿豈-﫿]/;
// 去掉 script / style / noscript 与注释:它们的内容会被 htmlFragmentToText 当成正文(摘要里冒出 CSS / JS)。
function stripHtmlNoise(html) {
  return String(html == null ? '' : html).replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
}
function htmlClassTokens(openTag) {
  const m = /\bclass\s*=\s*"([^"]*)"/i.exec(String(openTag || ''));
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}
function htmlAttr(openTag, name) {
  const m = new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"', 'i').exec(String(openTag || ''));
  return m ? decodeEntities(m[1]) : '';
}
// 起始于 at 的那个元素的内层 HTML(按同名标签配平;不配平时取到文档末尾,调用方再按下一块的起点截)。
function htmlElementInner(html, at) {
  const head = /^<([a-zA-Z][\w-]*)\b[^>]*>/.exec(html.slice(at, at + 4000));
  if (!head) return '';
  const tag = head[1].toLowerCase();
  const bodyStart = at + head[0].length;
  const re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
  re.lastIndex = bodyStart;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    if (m[1]) { depth -= 1; if (depth === 0) return html.slice(bodyStart, m.index); }
    else if (!/\/>$/.test(m[0])) depth += 1;
  }
  return html.slice(bodyStart);
}
// 找出所有「开标签的 class 满足 pred」的元素,返回 [{ openTag, inner }];inner 截在下一块起点之前(防不配平时吞掉后文)。
function htmlBlocksByClass(html, tagName, pred) {
  const re = new RegExp('<' + tagName + '\\b[^>]*>', 'gi');
  const hits = [];
  let m;
  while ((m = re.exec(html))) if (pred(htmlClassTokens(m[0]), m[0])) hits.push({ at: m.index, openTag: m[0] });
  return hits.map((h, i) => {
    const inner = htmlElementInner(html, h.at);
    const limit = i + 1 < hits.length ? hits[i + 1].at - (h.at + h.openTag.length) : inner.length;
    return { openTag: h.openTag, inner: inner.slice(0, Math.max(0, limit)) };
  });
}
// Bing 的点击跟踪链接 https://www.bing.com/ck/a?…&u=a1<base64url 原网址>… → 原网址。解不开就原样返回。
function decodeBingRedirect(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)bing\.com$/i.test(u.hostname) || !/^\/ck\/a/i.test(u.pathname)) return url;
    const raw = u.searchParams.get('u') || '';
    if (!raw.startsWith('a1')) return url;
    const decoded = Buffer.from(raw.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^https?:\/\/[^\s]+$/i.test(decoded) ? decoded : url;
  } catch { return url; }
}
function searchSnippetText(fragment) {
  return htmlFragmentToText(String(fragment || '').replace(/<span[^>]*class="[^"]*algoSlug_icon[^"]*"[^>]*>[\s\S]*?<\/span>/gi, ' '))
    .replace(/^(?:网页|Web)\s+/, '');
}
// Parse Bing (cn.bing.com) result HTML → [{title,url,snippet,source:'bing'}]. 只认 <li class="b_algo"> 里 <h2> 的那条链接;
// 广告(b_ad* / b_adSlug)、Bing 自家页面(图片 / 视频 / 相关搜索)不收。markup 变了只会少结果,绝不抛。
function parseBingHtml(html, limit) {
  const out = [];
  const s = stripHtmlNoise(html);
  for (const block of htmlBlocksByClass(s, 'li', cls => cls.includes('b_algo'))) {
    if (out.length >= limit) break;
    const inner = block.inner;
    if (htmlClassTokens(block.openTag).some(c => /^b_ad/.test(c)) || /\bb_adSlug\b|\bb_adurl\b/.test(inner)) continue;
    const h2 = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(inner);
    const a = h2 && /<a\b[^>]*\shref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(h2[1]);
    if (!a) continue;
    const url = decodeBingRedirect(decodeEntities(a[1]).trim());
    const title = htmlFragmentToText(a[2]);
    if (!/^https?:\/\//i.test(url) || !title) continue;
    try { if (/(^|\.)bing\.com$/i.test(new URL(url).hostname)) continue; } catch { continue; }
    const capAt = inner.search(/<div\b[^>]*class="[^"]*\bb_caption\b[^"]*"[^>]*>/i);
    const scope = capAt >= 0 ? inner.slice(capAt) : inner.replace(h2[0], ' ');
    const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(scope);
    let snippet = p ? searchSnippetText(p[1]) : '';
    if (!snippet) snippet = searchSnippetText(inner.replace(h2[0], ' ').replace(/<cite\b[\s\S]*?<\/cite>/gi, ' ').replace(/<div\b[^>]*class="[^"]*\b(?:b_attribution|b_tpcn|tpcn)\b[\s\S]*?<\/div>/gi, ' '));
    out.push({ title, url, snippet, source: 'bing' });
  }
  return out;
}
// Parse 百度 (www.baidu.com/s) result HTML → [{title,url,snippet,source:'baidu'}]. 只认 class 里同时有 result 与 c-container
// 两个【完整】类名的块(result-op 是百度自家的聚合卡片,不收);广告(ec_* / tuiguang / 「广告」标)不收。网址优先取容器的
// mu 属性(真实网址),没有才用标题上的跳转链接。
function parseBaiduHtml(html, limit) {
  const out = [];
  const s = stripHtmlNoise(html);
  for (const block of htmlBlocksByClass(s, 'div', cls => cls.includes('result') && cls.includes('c-container'))) {
    if (out.length >= limit) break;
    const inner = block.inner;
    const cls = htmlClassTokens(block.openTag);
    if (cls.some(c => /^(?:ec_|EC_)|tuiguang/i.test(c)) || /data-tuiguang|>\s*广告\s*</.test(inner)) continue;
    const h3 = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(inner);
    const a = /<a\b[^>]*\shref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(h3 ? h3[1] : inner);
    if (!a) continue;
    const mu = htmlAttr(block.openTag, 'mu');
    const url = /^https?:\/\//i.test(mu) ? mu.trim() : decodeEntities(a[1]).trim();
    const title = htmlFragmentToText(a[2]);
    if (!url || !title || /^(?:相关搜索|大家还在搜|其他人还搜了)/.test(title)) continue;
    const rest = h3 ? inner.replace(h3[0], ' ') : inner;
    const absAt = rest.search(/<(?:span|div)\b[^>]*class="[^"]*(?:content-right|c-abstract|c-span-last)[^"]*"[^>]*>/i);
    let snippet = absAt >= 0 ? htmlFragmentToText(htmlElementInner(rest, absAt)) : '';
    if (!snippet) { const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(rest); snippet = p ? htmlFragmentToText(p[1]) : ''; }
    if (!snippet) snippet = htmlFragmentToText(rest);
    out.push({ title, url, snippet, source: 'baidu' });
  }
  return out;
}
// 被人机验证 / 反爬页拦下(不是「没有结果」):Bing 的 captcha 页、百度安全验证页。
function searchPageBlocked(html) {
  const s = String(html || '');
  return /\bb_captcha\b|\/challengepic|id="b_captcha"|百度安全验证|wappass\.baidu\.com|安全验证[^<]{0,20}<\/title>/i.test(s);
}
// 去重键:协议、www.、末尾斜杠、#锚点、utm_* 跟踪参数都不算区别。
function searchResultKey(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^spm$|^from$/i.test(k)) u.searchParams.delete(k);
    const q = u.searchParams.toString();
    return u.hostname.toLowerCase().replace(/^www\./, '') + u.pathname.replace(/\/+$/, '') + (q ? '?' + q : '');
  } catch { return String(url || '').toLowerCase(); }
}
// 查询词:英文 / 数字词(≥2 字符)+ 中文二元组。用来把与查询零重合的结果排到最后(常见的是被引擎硬塞的无关推荐)。
function searchQueryTerms(query) {
  const q = String(query || '').toLowerCase();
  const words = (q.match(/[a-z0-9][a-z0-9._+#-]*/g) || []).filter(w => w.length >= 2);
  const grams = [];
  for (const run of (q.match(/[㐀-鿿豈-﫿]+/g) || [])) {
    if (run.length === 1) grams.push(run);
    for (let i = 0; i + 1 < run.length; i++) grams.push(run.slice(i, i + 2));
  }
  return [...new Set([...words, ...grams])];
}
function mergeSearchResults(query, lists, maxResults) {
  const terms = searchQueryTerms(query);
  // 同一页面在两个引擎里都出现时:名次按先出现的那处算,内容留排在前面的引擎那条(Bing 的网址是原网址,百度的可能带跟踪参数)。
  const preferred = new Map();
  lists.forEach((list, li) => list.forEach(r => {
    const key = searchResultKey(r.url);
    if (!preferred.has(key) || preferred.get(key).li > li) preferred.set(key, { r, li });
  }));
  const seen = new Set();
  const merged = [];
  const longest = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const r = list[i];
      if (!r) continue;
      const key = searchResultKey(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(preferred.get(key).r);
    }
  }
  const text = r => (r.title + ' ' + r.snippet + ' ' + r.url).toLowerCase();
  const relevant = terms.length ? merged.filter(r => terms.some(t => text(r).includes(t))) : merged;
  const rest = terms.length ? merged.filter(r => !relevant.includes(r)) : [];
  return [...relevant, ...rest].slice(0, maxResults);
}
module.exports = { extractMainText, parseBingHtml, parseBaiduHtml, SEARCH_CJK_RE, searchPageBlocked, mergeSearchResults };
