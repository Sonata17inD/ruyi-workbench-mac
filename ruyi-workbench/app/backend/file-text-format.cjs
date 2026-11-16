'use strict';
// v2.6: non-ASCII visibility helpers (mirror ACC read_file/edit_file diagnostics).
// JS has no unicodedata.name; a compact category label is enough to make lookalike chars visible.
function accCpCategory(cp) {
  if (cp >= 0xFF01 && cp <= 0xFF5E) return 'FULLWIDTH';
  if (cp >= 0x2190 && cp <= 0x21FF) return 'ARROW';
  if (cp >= 0x2010 && cp <= 0x2027) return 'DASH/PUNCT';
  if (cp === 0x00A0 || cp === 0x2009 || cp === 0x202F) return 'SPACE';
  if (cp >= 0x0300 && cp <= 0x036F) return 'COMBINING';
  return 'non-ASCII';
}
function accCpName(ch) {
  if (ch == null) return '<EOF>';
  const cp = ch.codePointAt(0);
  const hex = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
  if (cp <= 0x7F) return hex + " '" + ch + "'";
  return hex + " '" + ch + "' (" + accCpCategory(cp) + ')';
}
// F5: 只报「真可疑」的非 ASCII —— 隐形/格式控制、替换符、特殊空白(NBSP 等)、夹在 ASCII 里的全角/弯引号/破折号/箭头、
// 拉丁词里混进的希腊/西里尔形近字母。普通 CJK、带音标拉丁字母、emoji 一律不报(此前每份中文文件都白加约 51% 体积)。
// 全角标点/弯引号/破折号/箭头在中文行文里再正常不过,所以只有「两侧都不挨着 CJK」时才算可疑(如 `x＝1`、`foo（bar）`)。
// 扫描覆盖全部命中,优先级排序也作用在全部命中上(不再只排前 20 个);行号按 baseLine(窗口起点的真实行号)偏移。
function naIsCjkish(cp) {
  return (cp >= 0x2E80 && cp <= 0x9FFF) || (cp >= 0xAC00 && cp <= 0xD7FF) || (cp >= 0xF900 && cp <= 0xFAFF)
    || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFFEF) || (cp >= 0x20000 && cp <= 0x2FFFF);
}
function codePointBefore(text, index) {
  if (index <= 0) return 0;
  const last = text.charCodeAt(index - 1);
  const paired = last >= 0xDC00 && last <= 0xDFFF && index > 1
    && text.charCodeAt(index - 2) >= 0xD800 && text.charCodeAt(index - 2) <= 0xDBFF;
  return text.codePointAt(index - (paired ? 2 : 1));
}
function naClassify(cp, text, i, step) {
  if (cp === 0xFFFD) return { name: 'REPLACEMENT', pri: 0 };
  if (cp >= 0x80 && cp <= 0x9F) return { name: 'CONTROL', pri: 0 };
  if (cp === 0x00A0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200A) || cp === 0x202F || cp === 0x205F) return { name: 'SPACE', pri: 0 };
  if (cp === 0x2028 || cp === 0x2029) return { name: 'LINE_SEPARATOR', pri: 0 };
  if (/\p{Cf}/u.test(String.fromCodePoint(cp))) {
    if (cp === 0x200D) { // emoji ZWJ 序列里的粘合符是正常的
      const p = codePointBefore(text, i), n = text.codePointAt(i + step) || 0;
      if (p >= 0x2190 || n >= 0x2190) return null;
    }
    return { name: 'INVISIBLE', pri: 0 };
  }
  const prev = codePointBefore(text, i);
  const next = i + step < text.length ? text.codePointAt(i + step) : 0;
  const lonely = !naIsCjkish(prev) && !naIsCjkish(next);
  if (cp === 0x3000) return lonely ? { name: 'SPACE', pri: 0 } : null;
  if (cp >= 0xFF01 && cp <= 0xFF5E) return lonely ? { name: 'FULLWIDTH', pri: 0 } : null;
  if ((cp >= 0x2018 && cp <= 0x201F) || (cp >= 0x2010 && cp <= 0x2015) || cp === 0x2212) return lonely ? { name: 'QUOTE/DASH', pri: 1 } : null;
  if (cp >= 0x2190 && cp <= 0x21FF) return lonely ? { name: 'ARROW', pri: 1 } : null;
  if ((cp >= 0x0370 && cp <= 0x04FF) && ((prev >= 0x41 && prev <= 0x7A) || (next >= 0x41 && next <= 0x7A))) return { name: 'LOOKALIKE_SCRIPT', pri: 0 };
  return null;
}
function buildNonAsciiReport(text, opts) {
  const maxSamples = (opts && opts.maxSamples) || 20;
  const baseLine = (opts && opts.baseLine) || 1;
  let total = 0, line = baseLine, lineStart = 0;
  const buckets = [[], []];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') { line += 1; lineStart = i + 1; }
    if (text.charCodeAt(i) < 0x80) continue;
    const cp = text.codePointAt(i);
    const step = cp > 0xFFFF ? 2 : 1;
    const cls = naClassify(cp, text, i, step);
    if (cls) {
      total += 1;
      if (buckets[cls.pri].length < maxSamples) buckets[cls.pri].push({ i, cp, name: cls.name, line, column: i - lineStart + 1 });
    }
    i += step - 1;
  }
  const samples = buckets[0].concat(buckets[1]).slice(0, maxSamples).map(h => {
    return { line: h.line, column: h.column, char: String.fromCodePoint(h.cp),
      codepoint: 'U+' + h.cp.toString(16).toUpperCase().padStart(4, '0'), name: h.name,
      context: text.slice(Math.max(0, h.i - 8), h.i + 9) };
  });
  return { total, samples };
}
function accAnnotateNonAscii(s) {
  return s.replace(/[^\x00-\x7F]/gu, (c) => {
    const cp = c.codePointAt(0);
    return '\u27e8U+' + cp.toString(16).toUpperCase().padStart(4, '0') + '\u27e9';
  });
}

// File tools deliberately preserve a text file's established EOL style. Git filters do not run for direct
// Node writes, so without this boundary an LF tool payload can turn a CRLF worktree file into mixed EOL.
function detectTextLineEnding(text) {
  const value = String(text || '');
  let lf = 0, crlf = 0, loneCr = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '\r') {
      if (value[i + 1] === '\n') { crlf += 1; i += 1; }
      else loneCr += 1;
    } else if (value[i] === '\n') lf += 1;
  }
  if (!lf && !crlf && !loneCr) return 'none';
  if (lf && !crlf && !loneCr) return 'lf';
  if (crlf && !lf && !loneCr) return 'crlf';
  return 'mixed';
}
function normalizeTextLineEndings(text, lineEnding) {
  const value = String(text || '');
  if (lineEnding === 'lf') return value.replace(/\r\n|\r/g, '\n');
  if (lineEnding === 'crlf') return value.replace(/\r\n|\r|\n/g, '\r\n');
  return value;
}
function hasTextLineBreak(text) { return /[\r\n]/.test(String(text || '')); }
function isUtf8Encoding(encoding) { return !encoding || /^utf-?8$/i.test(String(encoding)); }
function defaultTextLineEnding(filePath) { return /\.(?:cmd|bat|ps1)$/i.test(String(filePath || '')) ? 'crlf' : 'lf'; }
// Windows PowerShell 5.1 把无 BOM 的 .ps1 按 ANSI(中文系统 = GBK)读,脚本里的中文字面量就成了乱码;
// 工具箱约定与 04 runPowerShell 头注同一条:PowerShell 脚本一律 UTF-8 with BOM。
function textFileWantsUtf8Bom(filePath) { return /\.(?:ps1|psm1|psd1)$/i.test(String(filePath || '')); }
const UTF8_BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

module.exports = { accCpName, buildNonAsciiReport, accAnnotateNonAscii, detectTextLineEnding, normalizeTextLineEndings, hasTextLineBreak, isUtf8Encoding, defaultTextLineEnding, textFileWantsUtf8Bom, UTF8_BOM_BYTES };
