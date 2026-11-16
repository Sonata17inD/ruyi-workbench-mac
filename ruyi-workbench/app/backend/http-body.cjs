'use strict';
// ── NE-8:web_fetch 的字符集与内容类型 ─────────────────────────────────────────────────────────────────────────
// 修前一律 body.toString('utf8'):GBK / GB2312 的页面(老政府站、高校站、论坛仍很常见)满屏 U+FFFD 还报 ok:true;PDF / 图片 /
// Office / zip 被当文本抽,最多 20000 字符的二进制乱码,还写进离线缓存。现在:
//   · 字符集:Content-Type 的 charset → BOM → 前 4KB 里的 <meta charset> / <meta http-equiv content="…charset=…"> /
//     XML 声明的 encoding → 都没有就严格 UTF-8,严格失败再试 gb18030。解码走 TextDecoder,先做运行时能力检查
//     (Node 若是不带完整 ICU 的构建,认不出 gbk 等标签):不认识就退回 UTF-8 并给 warning,不抛。
//   · 类型闸:pdf / 图片 / 音视频 / octet-stream / zip / Office 等二进制不做抽取,返回 ok:false + 提示改用 http_download;
//     没有 Content-Type 或类型陌生时看魔数与 NUL 字节。text/*、json、xml 等文本类原样解码(json / 纯文本不走 HTML 抽取)。
function charsetFromContentType(ct) {
  const m = /charset\s*=\s*["']?([^\s;"']+)/i.exec(String(ct || ''));
  return m ? m[1].toLowerCase() : '';
}
function sniffMetaCharset(buf) {
  const head = buf.subarray(0, 4096).toString('latin1');
  let m = /<meta\b[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9_:.\-]+)/i.exec(head);
  if (!m) m = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9_.\-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : '';
}
function textDecoderFor(label, fatal) {
  try { return new TextDecoder(label, { fatal: !!fatal }); } catch { return null; }
}
// → { text, charset, warning? }。buf 是 Buffer,contentType 是响应头原值(可空)。
function decodeHtmlBody(buf, contentType) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  const cands = [];
  const hdr = charsetFromContentType(contentType);
  if (hdr) cands.push({ label: hdr, from: 'header' });
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) cands.push({ label: 'utf-8', from: 'bom' });
  else if (b[0] === 0xff && b[1] === 0xfe) cands.push({ label: 'utf-16le', from: 'bom' });
  else if (b[0] === 0xfe && b[1] === 0xff) cands.push({ label: 'utf-16be', from: 'bom' });
  const meta = sniffMetaCharset(b);
  if (meta) cands.push({ label: /^utf-?16/.test(meta) ? 'utf-8' : meta, from: 'meta' }); // ASCII 兼容地读到的 meta 不可能真是 UTF-16(WHATWG 同口径)
  let warning = '';
  for (const c of cands) {
    const dec = textDecoderFor(c.label, false);
    if (dec) return { text: dec.decode(b), charset: dec.encoding };
    warning = `页面声明的字符集 ${c.label} 本机不支持,已按 UTF-8 解码,可能有乱码`;
  }
  // 没声明:严格 UTF-8(stream:true 容忍被 2MB 上限截在半个字符上),失败再猜 GB18030。
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b, { stream: true }), charset: 'utf-8', ...(warning ? { warning } : {}) }; } catch { /* fall through */ }
  const gb = textDecoderFor('gb18030', false);
  if (gb) return { text: gb.decode(b), charset: 'gb18030', warning: warning || '页面没有声明字符集且不是合法 UTF-8,已按 GB18030 猜测解码' };
  return { text: b.toString('utf8'), charset: 'utf-8', warning: warning || '页面没有声明字符集且不是合法 UTF-8,已按 UTF-8 解码,可能有乱码' };
}
const FETCH_TEXT_TYPE_RE = /^(?:text\/.+|application\/(?:json|xml|xhtml\+xml|javascript|x-javascript|ecmascript|yaml|x-yaml|x-ndjson|toml|sql|x-sh|rss\+xml|atom\+xml)|.+\+(?:json|xml))$/;
const FETCH_BINARY_TYPE_RE = /^(?:image|audio|video|font)\/|^application\/(?:pdf|octet-stream|zip|gzip|x-gzip|x-zip-compressed|x-tar|x-rar-compressed|vnd\.rar|x-7z-compressed|msword|rtf|x-msdownload|x-msi|java-archive|wasm|vnd\.ms-.+|vnd\.openxmlformats-.+|vnd\.oasis\..+|epub\+zip|x-shockwave-flash)$/;
// → { kind:'html'|'text'|'binary', type }
function classifyFetchedBody(contentType, buf) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'text/html' || type === 'application/xhtml+xml') return { kind: 'html', type };
  if (type && FETCH_BINARY_TYPE_RE.test(type)) return { kind: 'binary', type };
  if (type && FETCH_TEXT_TYPE_RE.test(type)) return { kind: 'text', type };
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  const head = b.subarray(0, 2048);
  const magic = head.subarray(0, 8).toString('latin1');
  const utf16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
  if (/^%PDF-|^PK\x03\x04|^\x89PNG|^GIF8|^\xff\xd8\xff|^\x1f\x8b|^Rar!|^7z\xbc\xaf|^MZ/.test(magic) || (!utf16 && head.includes(0))) return { kind: 'binary', type };
  const sniff = head.toString('latin1');
  if (/^\s*<(?:!doctype|html|head|body|\?xml)|<(?:html|body|div|p|table)\b/i.test(sniff)) return { kind: 'html', type };
  return { kind: 'text', type };
}

// ── 响应体的 Content-Encoding 解码(web_fetch / http_download / http_request 共用)──────────────────────────────────
// 我们不发 Accept-Encoding,但有的服务器 / CDN 仍然回 gzip / br:修前 web_fetch 把压缩字节当文本解码成乱码,http_download
// 把压缩字节原样存盘(.txt 打开是 1f 8b 开头的二进制)。现在按响应头逐层解开(gzip / deflate / br / zstd,多层按相反顺序)。
// 大小上限看的是【解压后】的字节(调用方在解码后的流上数字节、超限即掐断)—— 一个几 KB 的压缩炸弹解开几个 GB,不能只卡压缩前的长度。
// 截断的压缩流(对端中途断开)用 Z_SYNC_FLUSH 容忍:拿到多少解多少,而不是整体报错。
// deflate 在野外既有 zlib 封装(RFC 1950)也有裸 deflate(RFC 1951),按首两字节的 zlib 头判别。
function createDeflateAutoStream() {
  const { Transform } = require('stream');
  const z = require('zlib');
  let inner = null, prefix = null;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      if (!inner) {
        if (prefix) { chunk = Buffer.concat([prefix, chunk]); prefix = null; }
        // A transport chunk is not a protocol header. Wait for both bytes
        // before choosing RFC 1950 versus raw RFC 1951.
        if (chunk.length < 2) { prefix = chunk; cb(); return; }
        const wrapped = (chunk[0] & 0x0f) === 8 && (chunk[0] >> 4) <= 7 &&
          (((chunk[0] << 8) | chunk[1]) % 31 === 0);
        inner = wrapped ? z.createInflate({ finishFlush: z.constants.Z_SYNC_FLUSH }) : z.createInflateRaw({ finishFlush: z.constants.Z_SYNC_FLUSH });
        inner.on('data', d => { t.push(d); });
        inner.on('error', e => t.destroy(e));
      }
      inner.write(chunk, cb);
    },
    flush(cb) {
      if (!inner) {
        if (prefix && prefix.length) cb(new Error('Incomplete deflate header'));
        else cb();
        return;
      }
      // Transform completion must wait for all decoded output, not just end().
      inner.once('end', cb);
      inner.end();
    },
    destroy(err, cb) { if (inner) inner.destroy(); cb(err); },
  });
  return t;
}
// → { stream, encoding, decoders } 或 { unsupported: '<编码名>' }。encoding 为 null = 没有内容编码,stream 就是 res 本身。
function responseBodyStream(res) {
  const names = String((res.headers && res.headers['content-encoding']) || '').toLowerCase().split(',').map(x => x.trim()).filter(x => x && x !== 'identity');
  if (!names.length) return { stream: res, encoding: null, decoders: [] };
  const z = require('zlib');
  const decoders = [];
  for (const enc of names.slice().reverse()) {
    let d = null;
    if (enc === 'gzip' || enc === 'x-gzip') d = z.createGunzip({ finishFlush: z.constants.Z_SYNC_FLUSH });
    else if (enc === 'deflate') d = createDeflateAutoStream();
    else if (enc === 'br') d = z.createBrotliDecompress();
    else if (enc === 'zstd' && typeof z.createZstdDecompress === 'function') d = z.createZstdDecompress();
    else { for (const x of decoders) { try { x.destroy(); } catch { /* ignore */ } } return { unsupported: enc }; }
    decoders.push(d);
  }
  let stream = res;
  for (const d of decoders) stream = stream.pipe(d);
  return { stream, encoding: names.join(', '), decoders };
}
// 取消一个已建好的解码链(掐连接 / 超限 / 中断时调用,免得解码器挂着)。
function destroyBodyDecoders(body) {
  for (const d of ((body && body.decoders) || [])) { try { d.destroy(); } catch { /* ignore */ } }
}


module.exports = { charsetFromContentType, decodeHtmlBody, classifyFetchedBody, responseBodyStream, destroyBodyDecoders };
