'use strict';
const { StringDecoder } = require('string_decoder');
// 117q-B1(30 号文 §4.1):子进程 stdout 的 NDJSON 逐行喂入器。为什么必须走 StringDecoder ——
// chunk 边界不保证落在字符边界上,而 CJK 是 3 字节:对每个 chunk 单独 toString('utf8') 会把
// 被切开的汉字静默变成 U+FFFD,后续续接字节也解码成垃圾。这是一个以中文为主的产品的主干道。
// flush() 负责子进程关闭后把 decoder 里的残字与最后那半行交出去(三者协议都是「一行一个 JSON」)。
// 用户命令可输出 UTF-8 或 GB18030；逐行识别，保留混合编码与分块字符支持。
let _consoleGbDecoder = null;
const _consoleUtf8Strict = new TextDecoder('utf-8', { fatal: true });
function decodeConsoleSegment(buf) {
  if (!buf || !buf.length) return '';
  try { return _consoleUtf8Strict.decode(buf); } catch { /* 不是合法 UTF-8 */ }
  try {
    if (!_consoleGbDecoder) { try { _consoleGbDecoder = new TextDecoder('gb18030'); } catch { _consoleGbDecoder = new TextDecoder('gbk'); } }
    return _consoleGbDecoder.decode(buf);
  } catch { return Buffer.from(buf).toString('utf8'); } // 这个 node 没带 GBK 的 ICU:退回 UTF-8(至少不崩)
}
function decodeConsoleText(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  let out = '', start = 0;
  for (let i = data.indexOf(0x0a); i >= 0; i = data.indexOf(0x0a, start)) {
    out += decodeConsoleSegment(data.subarray(start, i + 1));
    start = i + 1;
  }
  return out + decodeConsoleSegment(data.subarray(start));
}
// 流式版本:整行才解码;没有换行的尾巴先攒着(多字节字符可能被 chunk 切开),由调用方在空闲时 flush()
// (交互式 shell 的提示符、「是否继续? [Y/N]」这类不带换行的输出)或在进程结束时 end()。
// 尾巴上一个没写完的多字节字符有多少字节(0 = 尾巴完整):UTF-8 看最后一个起始字节还差几个续字节;
// 否则按 GBK 看结尾连续高位字节的个数是否为奇数(双字节字符只到了前一半)。空闲 flush 时把它留到下一次。
function consoleIncompleteTail(buf) {
  // A complete UTF-8 suffix must never fall through to GBK's odd-byte heuristic.
  try { _consoleUtf8Strict.decode(buf); return 0; } catch { /* partial UTF-8 or another encoding */ }
  const n = buf.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const b = buf[n - back];
    if (b >= 0x80 && b < 0xc0) continue;            // UTF-8 续字节,继续往前找起始字节
    if (b >= 0xc0) {
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      if (back < need) { try { _consoleUtf8Strict.decode(buf.subarray(0, n - back)); return back; } catch { /* 前面也不是 UTF-8:按 GBK 看 */ } }
    }
    break;
  }
  let high = 0;
  while (high < n && buf[n - 1 - high] >= 0x80) high += 1;
  return high % 2 === 1 ? 1 : 0;
}
function createConsoleLineDecoder() {
  let pending = Buffer.alloc(0);
  const take = () => { const rest = pending; pending = Buffer.alloc(0); return decodeConsoleText(rest); };
  return {
    write(chunk) {
      const data = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      const cut = data.lastIndexOf(0x0a);
      if (cut < 0) { pending = data; return pending.length > 256 * 1024 ? take() : ''; }
      pending = data.subarray(cut + 1);
      return decodeConsoleText(data.subarray(0, cut + 1));
    },
    // 空闲时吐出不带换行的尾巴(提示符之类),但没写完的那个字符留着 —— 写方可能正停在两个字节之间。
    flush() {
      const keep = consoleIncompleteTail(pending);
      if (!keep) return take();
      const head = pending.subarray(0, pending.length - keep);
      pending = pending.subarray(pending.length - keep);
      return decodeConsoleText(head);
    },
    end: take,
    get pendingBytes() { return pending.length; },
  };
}

// 走查 W1·F4:【文本文件】字节 → 文本(附件 textPreview、/api/file/preview 用)。修前一律按 UTF-8 解:GBK 的 .txt/.csv(中文 Windows
// 上最常见的「另存为」结果)、带 BOM 的 UTF-16LE(PowerShell Out-File 的默认输出)满屏 U+FFFD,而且附件预览还会原样进
// 喂给模型的 <attached_files>。判据与 11b FileTextIo.sniffEncoding / decodeBuffer(…, 'auto') 同口径:BOM(UTF-8 / UTF-16LE / UTF-16BE)优先 →
// 严格 UTF-8 → 严格 GB18030 → 都不是就宽松 UTF-8(坏字节显示 U+FFFD)。UTF-8 BOM 留在文本里(同修前与 file_read),UTF-16 的 BOM 剥掉。
// 本函数住在 00-boot 而不直接用 FileTextIo:11b 是工具层,03/04(基础层)引用它会新增一条反向层级的依赖边(module-dependency-graph
// 静态锁拒绝);改判据要两边同改,unit/text-file-decode.test.js 在一张字节样本网格上逐格比对两者的输出。
// complete=false:buf 只是文件的前缀(被截断在 N 字节处),尾部切在多字节字符中间不算非法、也不留半个字符的 U+FFFD;
// 修前截断预览是 toString('utf8'),切开的尾字符会多一个 U+FFFD。
function decodeTextFileBytes(buf, complete = true) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  const stream = complete === false;
  const td = (label, fatal) => new TextDecoder(label, { fatal, ignoreBOM: true });
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return td('utf-8', false).decode(b, { stream });
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return td('utf-16le', false).decode(b.subarray(2), { stream });
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return td('utf-16be', false).decode(b.subarray(2), { stream });
  try { return td('utf-8', true).decode(b, { stream }); } catch { /* 不是合法 UTF-8 */ }
  try { return td('gb18030', true).decode(b, { stream }); } catch { /* 也不是 GBK,或这个 Node 没带 GB18030 的 ICU */ }
  return td('utf-8', false).decode(b, { stream });
}

function createNdjsonLineFeeder(onLine) {
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  return {
    push(chunk) {
      // hunt2-engines#4:只在【新到的这段】里找换行。修前每块都把整段残行拼上再 split 一遍 —— 一条 20MB 的单行
      // (大 tool_result / base64 图片)按 64KB 分块喂进来是 O(n²),实测 8 秒、50MB 近一分钟阻塞事件循环。
      // 新段里没有换行就只追加(V8 字符串拼接是摊还 O(1)),有换行时整段 split 一次,残行随即清空 —— 整体线性。
      const text = decoder.write(chunk);
      if (!text) return;
      if (text.indexOf('\n') < 0) { remainder += text; return; }
      const lines = (remainder + text).split(/\r?\n/);
      remainder = lines.pop() || '';
      for (const line of lines) onLine(line);
    },
    flush() {
      remainder += decoder.end();
      if (remainder.trim()) onLine(remainder);
      remainder = '';
    },
  };
}

// hunt2-engines#17:CLI 子进程的诊断文本(stderr、stdout 里的非 JSON 行)原来无上限累积,回合结束整段落进会话文件 ——
// 一个刷屏的 CLI 能把一条会话撑到上百 MB,之后每次读写会话都要搬它。这里只留头尾各一半(默认共 64K 字符):
// 启动错误多在头部、致命错误多在尾部,中间用一行说明省略了多少。累加是摊还 O(1)(尾巴超过两倍半额才裁一次)。
const CLI_DIAGNOSTIC_TEXT_CAP = 64 * 1024;
function createCappedDiagnosticText(cap = CLI_DIAGNOSTIC_TEXT_CAP) {
  const half = Math.max(1, Math.floor(cap / 2));
  let head = '';
  let tail = '';
  let dropped = 0;
  return {
    append(text) {
      let rest = String(text || '');
      if (!rest) return;
      if (head.length < half) {
        const take = rest.slice(0, half - head.length);
        head += take;
        rest = rest.slice(take.length);
        if (!rest) return;
      }
      tail += rest;
      if (tail.length > half * 2) { dropped += tail.length - half; tail = tail.slice(-half); }
    },
    toString() {
      const omitted = dropped + Math.max(0, tail.length - half);
      return omitted ? `${head}\n…[已省略 ${omitted} 字符]…\n${tail.slice(-half)}` : head + tail;
    },
  };
}

let _profileGb18030 = null;
function profileGb18030Decoder() {
  if (_profileGb18030 === null) {
    try { _profileGb18030 = typeof TextDecoder === 'function' ? new TextDecoder('gb18030', { fatal: true }) : false; }
    catch { _profileGb18030 = false; }   // 精简 ICU 的 Node 不带 gb18030 → 退回有损 UTF-8
  }
  return _profileGb18030 || null;
}

module.exports = { profileGb18030Decoder, decodeConsoleText, createConsoleLineDecoder, decodeTextFileBytes, createNdjsonLineFeeder, createCappedDiagnosticText };
