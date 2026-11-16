'use strict';
const fsp = require('node:fs/promises');
const { FileTextIo } = require('./file-text-io.cjs');
const { safeJsonParse } = require('./ordinary-json.cjs');
function createDataProfiler({ PrivacyGateway, privacySourceActive, privacySourceMark }) {
function parseCsv(text, delimiter, maxRows) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let quoted = false;   // 当前字段是否出现过引号:`""` 是显式的空值,不是空行
  for (let i = 0; i < text.length && rows.length < maxRows; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true; quoted = true;
    } else if (c === delimiter) {
      row.push(field); field = ''; quoted = false;
    } else if (c === '\n') {
      // 空行(整行只有一个空字段)不是数据行:修前 `a,b\n1,2\n\n3,4\n\n\n` 报 rowCount 5、nullCount 3。
      if (!(row.length === 0 && field === '' && !quoted)) { row.push(field); rows.push(row); }
      row = []; field = ''; quoted = false;
    } else if (c === '\r') {
      // skip (CRLF 的 \r 由随后的 \n 结束行;引号内的 \r 不在此分支)
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function inferColumnType(values) {
  const nonNull = values.filter(v => v !== '' && v !== null && v !== undefined);
  if (!nonNull.length) return 'text';
  let num = 0, bool = 0, dt = 0;
  for (const v of nonNull) {
    const s = String(v).trim();
    if (s === 'true' || s === 'false') bool += 1;
    else if (s !== '' && Number.isFinite(Number(s))) num += 1;
    else if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(s)) dt += 1;
  }
  if (bool === nonNull.length) return 'boolean';
  if (dt === nonNull.length) return 'datetime';
  if (num / nonNull.length >= 0.9) return 'numeric';
  return 'text';
}
function numericStats(values) {
  const nums = values.filter(v => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
  if (!nums.length) return null;
  const min = nums[0], max = nums[nums.length - 1];
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const mid = Math.floor(nums.length / 2);
  const median = nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  const variance = nums.length > 1 ? nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1) : 0;
  const std = Math.sqrt(variance);
  // IQR 离群点: Q1/Q3 分位数,超出 [Q1-1.5*IQR, Q3+1.5*IQR] 计数。
  const q = idx => { const pos = (nums.length - 1) * idx; const lo = Math.floor(pos); const hi = Math.ceil(pos); return nums[lo] + (nums[hi] - nums[lo]) * (pos - lo); };
  const q1 = q(0.25), q3 = q(0.75), iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
  const outlierCount = nums.filter(v => v < lo || v > hi).length;
  // 对抗验证(LOW): 极值列(如 [1e308, -1e308])可使 mean/std 变 Infinity —— JSON 序列化时 Infinity -> null,
  // 显式置 null 避免失真(JSON.stringify(Infinity) 返回 null 会静默丢失语义)。
  const fin = x => Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
  return { min, max, mean: fin(mean), median: fin(median), std: fin(std), outlierCount };
}
// 单元格 → 展示/去重用的文本。缺失(undefined/null)不是字符串 "undefined"/"null";JSON 里的对象/数组用 JSON.stringify
// (截断),不再是 "[object Object]"。返回 null 表示缺失,空串仍是空串(调用方一并当缺失统计)。
const PROFILE_CELL_MAX_CHARS = 80;
const privacyProfileSamples = new WeakMap();
function profileCellValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') {
    let t;
    try { t = JSON.stringify(v); } catch { t = String(v); }
    return t.length > PROFILE_CELL_MAX_CHARS ? t.slice(0, PROFILE_CELL_MAX_CHARS) + '…' : t;
  }
  return v;
}
function columnProfile(name, rawValues, maxSampleValues) {
  const values = rawValues.map(profileCellValue);
  const nonNull = values.filter(v => v !== '' && v !== null);
  const type = inferColumnType(values);
  // 样例值与唯一值只看【有值】的单元格:空串/缺失统计在 nullCount 里,不再冒充一个取值(修前 JSON 缺字段的样例里混着 "undefined")。
  const seen = [];
  const uniq = new Set();
  for (const v of nonNull) {
    const s = String(v);
    uniq.add(s);
    if (seen.length < maxSampleValues && !seen.includes(s)) seen.push(s);
  }
  const prof = {
    name, type, nonNullCount: nonNull.length, nullCount: values.length - nonNull.length,
    uniqueCount: uniq.size, sampleValues: seen,
  };
  if (privacySourceActive()) privacyProfileSamples.set(prof, seen.map(value => {
    const index = values.findIndex(item => item !== null && String(item) === value), original = rawValues[index];
    return typeof original === 'object' && original !== null ? JSON.stringify(original) : value;
  }));
  if (type === 'numeric') { const ns = numericStats(values); if (ns) Object.assign(prof, ns); }
  return prof;
}
// 列数上限:几千列的宽表逐列画像会产出几百 KB 的结果、把上下文冲掉。超出只画前 N 列并如实标 columnsTruncated。
const DATA_PROFILE_MAX_COLUMNS = 200;
function profileColumnCapMeta(total) {
  return total > DATA_PROFILE_MAX_COLUMNS ? { columnsTruncated: true, columnsShown: DATA_PROFILE_MAX_COLUMNS } : {};
}
// JSON 数组元素 → 列。对象元素按键并集成列(缺字段 = 缺失);全是标量/数组(如 `[1,2,3]`)时画成单个 `value` 列,
// 修前这种文件报 colCount 0、columns [] 而没有任何说明。混合时只画对象的键,并说明有多少非对象元素被忽略。
function profileJsonColumns(items, maxSampleValues) {
  const isObj = it => it && typeof it === 'object' && !Array.isArray(it);
  const keys = [];
  const seenKey = new Set();
  let nonObject = 0;
  for (const it of items) {
    if (isObj(it)) { for (const k of Object.keys(it)) if (!seenKey.has(k)) { seenKey.add(k); keys.push(k); } }
    else nonObject += 1;
  }
  if (!keys.length && nonObject) {
    return { colCount: 1, columns: [columnProfile('value', items, maxSampleValues)], note: '顶层数组的元素不是对象(标量/数组),按单个 value 列画像。' };
  }
  const shown = keys.slice(0, DATA_PROFILE_MAX_COLUMNS);
  const columns = shown.map(k => columnProfile(k, items.map(it => (isObj(it) && Object.prototype.hasOwnProperty.call(it, k) ? it[k] : undefined)), maxSampleValues));
  return { colCount: keys.length, columns, ...(nonObject ? { note: `有 ${nonObject} 个非对象元素没有进入列画像。` } : {}) };
}
// F8:data_profile 读盘。修前 readIfExists 把整个文件读进内存再 slice(0,1MB)(292MB 的文件 +564MB RSS 只为看 2000 行;
// 几 GB 的文件直接抛错并被吞成「不存在」),而且 1MB 截断对调用方不可见(5000 行的 CSV 报 1044 行 sampled:false,
// 3MB 的合法 JSON 报「不是合法 JSON」)。现在:
//   · fs.open + 只读窗口(8MB),stat 得 fileBytes;窗口没读完 → truncatedInput:true + bytesRead/fileBytes + estimatedRowCount;
//   · JSON:≤16MB 整读整解析;更大的顶层数组用一个小的流式扫描器只取前 maxRows 个元素,顶层非数组才如实说做不了;
//   · 解码:BOM / UTF-16 / 严格 UTF-8,都不是且运行时支持时按 GB18030(中文 Windows 的 CSV 常是 GBK),不再出 U+FFFD 乱码;
//   · 错误分类(不存在 / 无权限 / 是目录 / 空文件),不再一律「不存在、为空或无法读取」。
const DATA_PROFILE_WINDOW_BYTES = 8 * 1024 * 1024;
const DATA_PROFILE_JSON_FULL_BYTES = 16 * 1024 * 1024;
const DATA_PROFILE_JSON_STREAM_BYTES = 128 * 1024 * 1024;
const { profileGb18030Decoder } = require('./text-codecs.cjs');
// partial:true → buf 是文件的前缀,末尾可能截在多字节字符中间(stream 模式不把它当非法序列)。
function decodeProfileText(buf, partial) {
  const opt = { stream: !!partial };
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(buf, opt), encoding: 'utf-16le' };
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(buf, opt), encoding: 'utf-16be' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf, opt), encoding: 'utf-8' }; } catch { /* 不是 UTF-8 */ }
  const gb = profileGb18030Decoder();
  if (gb) { try { return { text: new TextDecoder('gb18030', { fatal: true }).decode(buf, opt), encoding: 'gb18030' }; } catch { /* 也不是 */ } }
  return { text: new TextDecoder('utf-8').decode(buf, opt), encoding: 'utf-8', lossy: true };
}
// 大 JSON 的顶层数组:边读边扫括号/字符串状态,遇到深度 1 的逗号切出一个元素 JSON.parse,取够 maxItems 就停。
// 只支持 UTF-8(带/不带 BOM)。返回 { items, scannedBytes, arrayEnded } 或 { notArray:true }。
async function profileJsonArrayHead(p, maxItems) {
  const fh = await fsp.open(p, 'r');
  try {
    const dec = new TextDecoder('utf-8');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let pos = 0, started = false, depth = 0, inStr = false, esc = false, cur = '', arrayEnded = false, bad = false;
    const items = [];
    const push = text => {
      const t = text.trim();
      if (!t) return;
      try { items.push(JSON.parse(t)); } catch { bad = true; }
    };
    while (!arrayEnded && !bad && items.length < maxItems && pos < DATA_PROFILE_JSON_STREAM_BYTES) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const str = dec.decode(chunk.subarray(0, bytesRead), { stream: true });
      let segStart = 0;
      for (let i = 0; i < str.length; i += 1) {
        const c = str.charCodeAt(i);
        if (inStr) { if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; continue; }
        if (!started) {
          if (c === 91) { started = true; depth = 1; segStart = i + 1; }
          else if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 0xFEFF) return { notArray: true };
          continue;
        }
        if (c === 34) { inStr = true; continue; }
        if (c === 123 || c === 91) { depth += 1; continue; }
        if (c === 125 || c === 93) {
          depth -= 1;
          if (depth === 0) { push(cur + str.slice(segStart, i)); cur = ''; arrayEnded = true; break; }
          continue;
        }
        if (c === 44 && depth === 1) {
          push(cur + str.slice(segStart, i)); cur = ''; segStart = i + 1;
          if (items.length >= maxItems || bad) break;
        }
      }
      if (started && !arrayEnded && items.length < maxItems && !bad) cur += str.slice(segStart);
    }
    if (!started) return { notArray: true };
    return { items, scannedBytes: pos, arrayEnded, bad };
  } finally { try { await fh.close(); } catch { /* ignore */ } }
}
// 二进制文件识别:xlsx/docx/zip(PK\x03\x04)、pdf、图片、gzip、旧版 Office(OLE)按魔数认;其余看头 8KB 里有没有 NUL
// (带 BOM 的 UTF-16 文本天然含 NUL,不算)。修前这些文件被当文本/CSV 画像,出一堆乱码列,
// 还附一句「本机 Node 不支持 GB18030」的误导性说明。
function profileBinaryKind(buf) {
  const b = buf;
  const starts = (...bytes) => b.length >= bytes.length && bytes.every((x, i) => b[i] === x);
  if (starts(0x50, 0x4B, 0x03, 0x04) || starts(0x50, 0x4B, 0x05, 0x06)) return 'ZIP 容器(.xlsx/.docx/.pptx/.zip 等)';
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'PDF';
  if (starts(0x89, 0x50, 0x4E, 0x47) || starts(0xFF, 0xD8, 0xFF) || starts(0x47, 0x49, 0x46, 0x38)) return '图片';
  if (starts(0x1F, 0x8B)) return 'gzip 压缩包';
  if (starts(0xD0, 0xCF, 0x11, 0xE0)) return '旧版 Office 文件(.xls/.doc)';
  if (starts(0xFF, 0xFE) || starts(0xFE, 0xFF)) return null;   // UTF-16 BOM:文本
  const n = Math.min(b.length, 8192);
  for (let i = 0; i < n; i += 1) if (b[i] === 0) return '含 NUL 字节';
  return null;
}
// delimiter 参数:允许 tab/comma/semicolon/pipe/space 这些名字与 `\t` 转义,其余必须恰好一个字符(多字符分隔符
// 解析器不支持 —— 修前 `::` 被默默接受,整张表塌成 1 列)。返回 { delim } 或 { error }。
const PROFILE_DELIMITER_NAMES = { tab: '\t', '\\t': '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ' };
function normalizeProfileDelimiter(raw) {
  const s = String(raw == null ? '' : raw);
  if (s === '') return { delim: '' };
  const named = PROFILE_DELIMITER_NAMES[s.toLowerCase()];
  const d = named !== undefined ? named : s;
  if (d.length !== 1) return { error: `delimiter 只支持单个字符(或 tab/comma/semicolon/pipe/space 这些名字),收到 ${JSON.stringify(s)}` };
  if (d === '"' || d === '\n' || d === '\r') return { error: 'delimiter 不能是引号或换行符' };
  return { delim: d };
}
// 自动探测分隔符:看开头几行,哪个候选在表头行出现过、且在最多的行里次数与表头一致就是它(欧洲式 `1,5;2,5` 里
// 逗号是小数点,按总次数数会选错)。都不成立时退回按总次数多少。候选 , \t ; |,平局按这个顺序。
function detectProfileDelimiter(raw) {
  const cands = [',', '\t', ';', '|'];
  const lines = raw.slice(0, 4000).split(/\r?\n/).filter(l => l.length).slice(0, 6);
  const cnt = (l, d) => l.split(d).length - 1;
  let best = null;
  for (const d of cands) {
    const head = lines.length ? cnt(lines[0], d) : 0;
    if (!head) continue;
    const score = lines.filter(l => cnt(l, d) === head).length;
    if (!best || score > best.score || (score === best.score && head > best.head)) best = { d, score, head };
  }
  if (best) return best.d;
  const sample = raw.slice(0, 1000);
  let pick = ',', max = 0;
  for (const d of cands) { const c = sample.split(d).length - 1; if (c > max) { max = c; pick = d; } }
  return pick;
}
async function dataProfile(filePath, args = {}) {
  if (!privacySourceActive()) return dataProfileRaw(filePath, args);
  const win = await FileTextIo.readFileWindow(String(filePath || ''), 4 * 1048576);
  if (win.error) return { ok: false, code: win.code, error: win.error, path: filePath };
  if (win.buf.length !== win.fileBytes) throw Object.assign(new Error('Privacy source exceeds the complete read budget.'), { code: 'privacy.source_limit' });
  const raw = decodeProfileText(win.buf, false).text, view = await PrivacyGateway.projectSource(raw);
  const out = await dataProfileRaw(filePath, args, win);
  const samples = [];
  for (const column of out.columns || []) {
    const originals = privacyProfileSamples.get(column) || column.sampleValues;
    for (let i = 0; i < column.sampleValues.length; i += 1) samples.push({ values: column.sampleValues, index: i, original: originals[i] });
  }
  const numbers = [];
  const collectNumbers = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'number' && Number.isFinite(item)) numbers.push({ container: value, key, original: String(item) });
      else if (item && typeof item === 'object') collectNumbers(item);
    }
  };
  collectNumbers(out);
  // A complete object sample may reveal a field classification unavailable in a scalar
  // sample. Learn all full samples before rendering any of their shortened displays.
  const sampleViews = new Map([...samples, ...numbers].map(sample => [sample.original, null]));
  for (const original of sampleViews.keys()) await PrivacyGateway.projectSource(original);
  for (const original of sampleViews.keys()) sampleViews.set(original, await PrivacyGateway.projectSource(original));
  for (const { values, index, original } of samples) {
    const sampleView = sampleViews.get(original);
    values[index] = PrivacyGateway.sliceSource(sampleView, 0, original.length > PROFILE_CELL_MAX_CHARS && /^[\[{]/.test(original) ? PROFILE_CELL_MAX_CHARS : original.length).text;
    PrivacyGateway.markSourceView(values, ['/' + index], sampleView);
  }
  for (const { container, key, original } of numbers) {
    const numberView = sampleViews.get(original);
    // Calculations still use original numbers. A private numeric display (for example
    // min/max of a phone column inferred as numeric) must use an opaque text reference;
    // leaving that number in the model JSON would bypass the protected sample values.
    if (numberView.text !== original) {
      container[key] = numberView.text;
      PrivacyGateway.markSourceView(container, ['/' + key.replace(/~/g, '~0').replace(/\//g, '~1')], numberView);
    }
  }
  if (out.topPrefixes) {
    for (const entry of out.topPrefixes) {
      // The statistics use original prefixes; only the displayed representative is projected.
      const offset = raw.indexOf(entry.prefix);
      if (offset >= 0) entry.prefix = PrivacyGateway.sliceSource(view, offset, offset + entry.prefix.length).text;
      privacySourceMark(entry, ['/prefix'], view);
    }
  }
  return out;
}
async function dataProfileRaw(filePath, args = {}, snapshot = null) {
  const p = String(filePath || '');
  const win = snapshot || await FileTextIo.readFileWindow(p, DATA_PROFILE_WINDOW_BYTES);
  if (win.error) return { ok: false, error: win.error, code: win.code, path: p };
  const binKind = profileBinaryKind(win.buf);
  if (binKind) {
    return { ok: false, error: `这是二进制文件(${binKind}),data_profile 只能画像文本数据(CSV/TSV/JSON/JSONL/日志)`, code: 'binary_file', path: p, fileBytes: win.fileBytes,
      hint: 'xlsx/xls 先在 Excel 里另存为 CSV(UTF-8)再画像;若已连接桌面控制连接器,可用它的 excel_read / read_document 读取内容。' };
  }
  const delimArg = normalizeProfileDelimiter(args.delimiter);
  if (delimArg.error) return { ok: false, error: delimArg.error, code: 'bad_delimiter', path: p };
  const fileBytes = win.fileBytes;
  let truncatedInput = win.buf.length < fileBytes;
  let dec = decodeProfileText(win.buf, truncatedInput);
  let raw = dec.text;
  let bytesRead = win.buf.length;
  const maxRows = Math.max(1, Math.min(50000, Math.round(Number(args.maxRows) || 2000)));
  const maxSampleValues = Math.max(1, Math.min(50, Math.round(Number(args.maxSampleValues) || 5)));
  const ext = (p.match(/\.([^./\\]+)$/) || [])[1] || '';
  let format = 'text';
  const lc = ext.toLowerCase();
  if (lc === 'csv') format = 'csv';
  else if (lc === 'tsv') format = 'tsv';
  else if (lc === 'json') format = 'json';
  else if (lc === 'jsonl' || lc === 'ndjson') format = 'jsonl';
  else {
    const head = raw.trimStart().slice(0, 1);
    if (head === '[' || head === '{') format = 'json';
    else if (delimArg.delim) format = 'csv';
    else if (/[,\t|]/.test(raw.slice(0, 200))) format = 'csv';
  }
  // 窗口只是文件的前缀:最后一行多半是半截的,丢掉,免得多出一个假行。
  const cutPartialLine = () => {
    if (!truncatedInput) return;
    const nl = raw.lastIndexOf('\n');
    if (nl > 0) raw = raw.slice(0, nl);
  };
  // 输入元信息:窗口没读完时说明(truncatedInput/bytesRead/fileBytes/estimatedRowCount),读完了给 totalRowCount(精确)。
  const inputMeta = (totalRows) => {
    const m = { fileBytes };
    if (dec.encoding !== 'utf-8') m.encoding = dec.encoding;
    // 说明要和真实原因一致:Node 带 GB18030 解码器时,「宽松解码」是因为文件两种编码都不合法(多半不是文本),不是「不支持」。
    if (dec.lossy) m.encodingNote = profileGb18030Decoder()
      ? '文件既不是合法的 UTF-8 也不是合法的 GB18030(可能含二进制内容或别的编码),已按 UTF-8 宽松解码,可能有乱码'
      : '文件不是 UTF-8 且本机 Node 不支持 GB18030,已按 UTF-8 宽松解码,可能有乱码';
    if (truncatedInput) {
      m.truncatedInput = true; m.bytesRead = bytesRead;
      if (Number.isFinite(totalRows.estimate)) m.estimatedRowCount = totalRows.estimate;
    } else if (Number.isFinite(totalRows.exact)) m.totalRowCount = totalRows.exact;
    return m;
  };
  // 按窗口内的平均行宽外推整个文件的行数(只是估计,CSV 引号内换行会有偏差)。
  const estimateLines = () => {
    const nl = (raw.match(/\n/g) || []).length;
    return nl > 0 ? Math.round(fileBytes * nl / Math.max(1, bytesRead)) : null;
  };

  if (format === 'json') {
    let parsed = null;
    let items = null;      // 流式取出的数组元素(超大文件)
    let streamedEnded = true;
    if (!truncatedInput) parsed = safeJsonParse(raw, null);
    else if (fileBytes <= DATA_PROFILE_JSON_FULL_BYTES) {
      const full = await FileTextIo.readFileWindow(p, DATA_PROFILE_JSON_FULL_BYTES);
      if (full.error) return { ok: false, error: full.error, code: full.code, path: p };
      dec = decodeProfileText(full.buf, false); raw = dec.text; bytesRead = full.buf.length; truncatedInput = false;
      parsed = safeJsonParse(raw, null);
    } else if (dec.encoding === 'utf-8' && !dec.lossy) {
      const head = await profileJsonArrayHead(p, maxRows);
      if (!head.notArray && !head.bad) { items = head.items; streamedEnded = head.arrayEnded; bytesRead = head.scannedBytes; }
    }
    if (items) {
      const jc = profileJsonColumns(items, maxSampleValues);
      const meta = { fileBytes, bytesRead };
      // 只有数组【没读到结尾】才算采样:bytesRead 是按块对齐的扫描位置,`]` 之后的空白 / 别的文档让它 < fileBytes,
      // 但元素已经全在 items 里(rowCount 即精确总数),不能因此谎报 sampled。
      if (!streamedEnded) meta.truncatedInput = true;
      return { ok: true, path: p, format: 'json', rowCount: items.length, colCount: jc.colCount, sampled: !streamedEnded, ...meta, columns: jc.columns, ...profileColumnCapMeta(jc.colCount),
        note: (jc.note ? jc.note + ' ' : '') + (streamedEnded
          ? `JSON 文件(${Math.round(fileBytes / 1048576)}MB)超过 ${Math.round(DATA_PROFILE_JSON_FULL_BYTES / 1048576)}MB,已流式读完顶层数组(${items.length} 个元素),rowCount 为精确总数。`
          : `JSON 文件(${Math.round(fileBytes / 1048576)}MB)超过 ${Math.round(DATA_PROFILE_JSON_FULL_BYTES / 1048576)}MB,只流式读取了顶层数组的前 ${items.length} 个元素做画像,总元素数未知。`) };
    }
    // 对抗验证(MEDIUM): 首字符 {/[ 的多行 JSONL(无扩展名)会被 sniff 成 json 而整体解析失败 —— 回落逐行解析。
    if (parsed == null) {
      cutPartialLine();
      const lines = raw.split(/\r?\n/).filter(l => l.trim());
      const rows = [];
      for (const l of lines) { if (rows.length >= maxRows) break; const o = safeJsonParse(l, null); if (o != null && typeof o === 'object') rows.push(o); }
      if (rows.length) {
        const jc = profileJsonColumns(rows, maxSampleValues);
        return { ok: true, path: p, format: 'jsonl', rowCount: rows.length, colCount: jc.colCount, sampled: lines.length > maxRows || truncatedInput, ...inputMeta({ exact: lines.length, estimate: estimateLines() }), columns: jc.columns, ...profileColumnCapMeta(jc.colCount), note: jc.note || '采样画像(grep 级启发式)。' };
      }
      if (truncatedInput) return { ok: false, error: `JSON 文件超过 ${Math.round(DATA_PROFILE_JSON_FULL_BYTES / 1048576)}MB 且顶层不是数组(或不是 UTF-8),无法做画像`, code: 'json_too_large', path: p, fileBytes, hint: '用 file_read 看开头几行了解结构,或先拆成 JSONL/数组再画像' };
      return { ok: false, error: 'JSON 解析失败,不是合法 JSON', path: p, fileBytes };
    }
    const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
    const objs = arr.slice(0, maxRows);
    const jc = profileJsonColumns(objs, maxSampleValues);
    return { ok: true, path: p, format: 'json', rowCount: Math.min(arr.length, maxRows), colCount: jc.colCount, sampled: arr.length > maxRows, ...inputMeta({ exact: arr.length }), columns: jc.columns, ...profileColumnCapMeta(jc.colCount), note: (jc.note ? jc.note + ' ' : '') + '采样画像(grep 级启发式): 列类型/离群点是统计启发式,非数据血缘。' };
  }
  if (format === 'jsonl') {
    cutPartialLine();
    const lines = raw.split(/\r?\n/).filter(l => l.trim());
    const rows = [];
    for (const l of lines) { if (rows.length >= maxRows) break; const o = safeJsonParse(l, null); if (o != null && typeof o === 'object') rows.push(o); }
    const jc = profileJsonColumns(rows, maxSampleValues);
    return { ok: true, path: p, format: 'jsonl', rowCount: rows.length, colCount: jc.colCount, sampled: lines.length > maxRows || truncatedInput, ...inputMeta({ exact: lines.length, estimate: estimateLines() }), columns: jc.columns, ...profileColumnCapMeta(jc.colCount), note: jc.note || '采样画像(grep 级启发式)。' };
  }
  if (format === 'csv' || format === 'tsv') {
    cutPartialLine();
    const delim = delimArg.delim || detectProfileDelimiter(raw);
    // 窗口读完了 → 整段解析得到精确总行数(≤8MB,可控);只有前缀 → 解析到 maxRows+1 行即止,总行数靠外推。
    const allRows = parseCsv(raw, delim, truncatedInput ? maxRows + 1 : Infinity);
    let header, dataRows;
    if (allRows.length) { header = allRows[0]; dataRows = allRows.slice(1, maxRows + 1); }
    if (!header || !header.length) return { ok: false, error: 'CSV/TSV 无法解析出表头', path: p };
    const colCount = header.length;
    const columns = [];
    for (let c = 0; c < Math.min(colCount, DATA_PROFILE_MAX_COLUMNS); c += 1) {
      const name = String(header[c] || '').trim() || ('col' + (c + 1));
      const values = dataRows.map(r => (r[c] !== undefined ? r[c] : ''));
      columns.push(columnProfile(name, values, maxSampleValues));
    }
    const est = estimateLines();
    return { ok: true, path: p, format: format === 'tsv' && delim === '\t' ? 'tsv' : 'csv', delimiter: delim, rowCount: dataRows.length, colCount, sampled: allRows.length - 1 > maxRows || truncatedInput, ...inputMeta({ exact: allRows.length - 1, estimate: est == null ? null : Math.max(0, est - 1) }), columns, ...profileColumnCapMeta(colCount), note: '采样画像(grep 级启发式): CSV 简单状态机解析,不保证兼容所有方言(BOM/多字符分隔符/嵌入引号边缘);分隔符支持 , ; tab |(delimiter 参数可指定,多字符不支持);空行不计入。' };
  }
  // text/log: 逐行为一行,无结构化列 → 行数 + 行长度统计 + 常见行首。
  cutPartialLine();
  const lines = raw.split(/\r?\n/).filter(l => l.length);
  const lengths = lines.slice(0, maxRows).map(l => l.length);
  const lineStats = lengths.length ? { min: Math.min(...lengths), max: Math.max(...lengths), avg: Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) } : null;
  const prefixes = {};
  for (const l of lines.slice(0, maxRows)) { const pre = l.slice(0, 12); prefixes[pre] = (prefixes[pre] || 0) + 1; }
  const topPrefixes = Object.entries(prefixes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ prefix: k, count: v }));
  return { ok: true, path: p, format: 'text', rowCount: Math.min(lines.length, maxRows), colCount: 0, sampled: lines.length > maxRows || truncatedInput, ...inputMeta({ exact: lines.length, estimate: estimateLines() }), lineStats, topPrefixes, note: '文本/日志按行画像(无结构化列);行首模式统计可帮助识别日志格式。' };
}


return { dataProfile };
}
module.exports = { createDataProfiler };
