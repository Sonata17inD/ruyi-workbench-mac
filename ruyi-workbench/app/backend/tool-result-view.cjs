'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { countCjkCodeUnits, tokensFromTextCounts } = require('./token-estimation.cjs');
const { toolImageSessionTag } = require('./image-content.cjs');

// Keep small state fields and resumable read pages intact while bounding tool output.
const TOOL_RESULT_CAP = 60000;   // flat cap for non-file-read tools
const FILE_READ_HEAD = 40000;    // head window for file_read-class results
const FILE_READ_TAIL = 8000;     // tail window for file_read-class results
const TOOL_RESULT_MIN_CAP = 24000;      // token 口径收紧后的字符下限(纯中文 ≈ 16.7K token)
const TOOL_RESULT_FIELD_FLOOR = 2000;   // 一个被收缩的字符串字段至少留这么多(stderr 也不会被挤成零)
const TOOL_RESULT_MARKER_RESERVE = 90;  // 每个省略标记的字符余量
const TOOL_RESULT_DISPLAY_CAP = 120000; // N3:落盘/发 SSE 的展示副本上限(大于模型视图,小于旧的 2MB+)
// A2: base64 图片字段专用处理 —— 60KB 平切会把 base64 从【中间】切断,返回给模型的是无法解码的坏图。
// 识别 JSON 里的图片 base64 字段(字段名含 image/base64/screenshot/thumbnail/b64,值 ≥8000 个 base64 字符,
// 或带 data:image/ 前缀),把超长 base64 值【整体】替换为短占位 —— 要么完整图,要么明确「图被裁」,
// 绝不产生半截坏图。替换后仍超限才回退平切(此时 base64 已缩为占位,平切不再切到图)。
// 字段名白名单覆盖 ACC 截图族(image / image_base64)与常见 MCP 图片约定,值长度门槛防误伤非图大字段。
const IMG_B64_TRIM_RE = /("(?:[A-Za-z0-9_]*?(?:image|base64|screenshot|thumbnail|b64)[A-Za-z0-9_]*?)"\s*:\s*")((?:data:[a-z0-9+.-]+\/[a-z0-9+.-]+;base64,)?[A-Za-z0-9+/=]{8000,})/g;
const TOOL_EXEC_CLASS_RE = /^(?:shell_run|powershell_run|script_run|shell_start|shell_send|shell_poll|git_[a-z_]+)$/;
const TOOL_OUTPUT_KEY_RE = /^(?:stdout|stderr|output|log|logs)$/;

// 预算(字符)按估算 token 折算:同一批字符里 CJK 占比越高,能放的字符越少。只在串够长时才扫一遍(O(n),无分配)。
function toolResultCharCap(s, cap = TOOL_RESULT_CAP) {
  if (typeof s !== 'string' || s.length <= TOOL_RESULT_MIN_CAP) return cap;
  const cjk = countCjkCodeUnits(s);
  if (!cjk) return cap;
  const ratio = cjk / s.length;
  const budgetTokens = tokensFromTextCounts(cap, 0, null);
  const tokensPerChar = tokensFromTextCounts(1 - ratio, ratio, null);
  return Math.max(TOOL_RESULT_MIN_CAP, Math.min(cap, Math.floor(budgetTokens / tokensPerChar)));
}

// 恢复提示按工具给,不再一刀切写「offset/limit」(多数工具没有这两个参数)。
function toolResultRecoveryHint(name) {
  const base = String(name || '').replace(/^.+?__/, '');
  if (base === 'file_read') return '省略的是文件中间段:用 file_read 的 offset(字符,可接 nextOffset)/limit 或 lineOffset/lineLimit 分段重读需要的区间';
  if (TOOL_EXEC_CLASS_RE.test(base)) return '输出中间段已省略(保留开头与结尾):请缩小命令输出(过滤/分页/只取末尾几行),或把输出重定向到文件后用 file_read 的 lineOffset/lineLimit 分段读取,不要原样重跑';
  if (base === 'web_fetch' || base === 'steward_web_fetch') return '用返回的 nextOffset 作为 offset 续读;源响应未收全时,用 http_download 保存后再 file_read 分段读';
  if (base === 'http_request') return '原响应省略部分未保留,不能把重试当续读。GET网页可用 web_fetch 分页,或 http_download 保存后 file_read;非幂等请求不要为补读自动重发';
  return '结果被截断:请用更精确的参数缩小范围重新获取(不要原样重试),需要全文时先把它写到文件再分段读取';
}

// 一个字符串字段的头+尾收缩。headRatio 决定头尾分配(日志尾部更值钱,文件头部更值钱);尽量落在行边界,不劈代理对。
function shrinkToolText(text, allowance, headRatio) {
  const len = text.length;
  const room = Math.max(200, Math.floor(allowance));
  if (len <= room) return text;
  let headEnd = Math.floor(room * headRatio);
  let tailStart = len - (room - headEnd);
  const nlHead = text.lastIndexOf('\n', headEnd - 1);
  if (nlHead >= 0 && headEnd - nlHead <= headEnd * 0.1) headEnd = nlHead + 1;
  const nlTail = text.indexOf('\n', tailStart);
  if (nlTail >= 0 && nlTail - tailStart <= (len - tailStart) * 0.1) tailStart = nlTail + 1;
  if (headEnd > 0) { const c = text.charCodeAt(headEnd - 1); if (c >= 0xD800 && c <= 0xDBFF) headEnd -= 1; }
  if (tailStart < len) { const c = text.charCodeAt(tailStart); if (c >= 0xDC00 && c <= 0xDFFF) tailStart += 1; }
  if (tailStart <= headEnd) return text;
  const omitted = tailStart - headEnd;
  return text.slice(0, headEnd) + `\n[…已截断 ${omitted} 字符 / ${omitted} chars omitted…]\n` + text.slice(tailStart);
}

function toolResultHeadRatio(baseName, key) {
  if (baseName === 'file_read' && key === 'content') return FILE_READ_HEAD / (FILE_READ_HEAD + FILE_READ_TAIL);
  if (TOOL_EXEC_CLASS_RE.test(baseName) || TOOL_OUTPUT_KEY_RE.test(String(key))) return 0.3;
  return 0.5;
}

function toolResultPathText(path) {
  let out = '';
  for (const k of path) out += typeof k === 'number' ? `[${k}]` : (out ? '.' : '') + k;
  return out;
}

function collectToolResultLeaves(node, path, depth, bigs, arrays) {
  if (depth > 6 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    if (node.length > 8) arrays.push(path);
    const n = Math.min(node.length, 500);
    for (let i = 0; i < n; i++) {
      const v = node[i];
      if (typeof v === 'string') { if (v.length > TOOL_RESULT_FIELD_FLOOR) bigs.push({ path: path.concat(i), len: v.length, esc: JSON.stringify(v).length - 2, key: path[path.length - 1] }); }
      else if (v && typeof v === 'object') collectToolResultLeaves(v, path.concat(i), depth + 1, bigs, arrays);
    }
    return;
  }
  for (const k of Object.keys(node)) {
    if (k === '__proto__') continue;
    const v = node[k];
    if (typeof v === 'string') { if (v.length > TOOL_RESULT_FIELD_FLOOR) bigs.push({ path: path.concat(k), len: v.length, esc: JSON.stringify(v).length - 2, key: k }); }
    else if (v && typeof v === 'object') collectToolResultLeaves(v, path.concat(k), depth + 1, bigs, arrays);
  }
}

// 写时复制:沿 path 把祖先链各克隆一次(cloneOf 记 原→克隆 与 克隆→自身,共享祖先只克隆一份),返回叶子的父节点克隆。
function cowToolResultParent(root, path, cloneOf) {
  const cow = n => {
    let c = cloneOf.get(n);
    if (!c) { c = Array.isArray(n) ? n.slice() : { ...n }; cloneOf.set(n, c); cloneOf.set(c, c); }
    return c;
  };
  let cur = cow(root);
  for (let i = 0; i < path.length - 1; i++) { const child = cow(cur[path[i]]); cur[path[i]] = child; cur = child; }
  return cur;
}

function shrinkToolResultArray(arr, budget) {
  let used = 2, keep = 0;
  for (; keep < arr.length; keep++) {
    let n; try { n = JSON.stringify(arr[keep]).length + 1; } catch { n = 64; }
    if (used + n > budget && keep >= 1) break;
    used += n;
  }
  if (keep >= arr.length) return { value: arr, omitted: 0 };
  const omitted = arr.length - keep;
  return { value: arr.slice(0, keep).concat([`[…已截断 ${omitted} 项 / ${omitted} items omitted…]`]), omitted };
}

// 对象级收缩。value 可以是活对象(不会被改动:写时复制);已在 cap 内 → 原对象原样返回(同一引用)。
// 先按「最大字段先收」的水位法给每个大字符串分配额度(小的整段留),再(仍超限时)砍最大的数组,最后加 _truncated 注记。
function shrinkToolResultValue(name, value, cap) {
  if (!value || typeof value !== 'object') return value;
  let total;
  try { total = JSON.stringify(value).length; } catch { return value; }
  if (total <= cap) return value;
  const baseName = String(name || '').replace(/^.+?__/, '');
  const target = Math.max(TOOL_RESULT_FIELD_FLOOR, cap - 700);   // 留给 _truncated 注记
  const bigs = [], arrays = [];
  collectToolResultLeaves(value, [], 0, bigs, arrays);
  let out = value;
  const notes = { fields: [], arrays: [] };
  if (bigs.length) {
    // 额度按【序列化后】的字符数算(esc:换行/引号转义会让 JSON 里的串比原串长),allow 再折回原串字符数。
    const bigSum = bigs.reduce((a, b) => a + b.esc, 0);
    const overhead = Math.max(0, total - bigSum);
    let scale = 1;
    for (let attempt = 0; attempt < 4; attempt++) {
      const cloneOf = new Map();
      const fields = [];
      const order = bigs.slice().sort((a, b) => a.esc - b.esc);
      let available = Math.max(bigs.length * TOOL_RESULT_FIELD_FLOOR, Math.floor((target - overhead) * scale) - bigs.length * TOOL_RESULT_MARKER_RESERVE);
      const allow = new Map();
      order.forEach((b, i) => {
        const share = Math.floor(available / (order.length - i));
        const escKept = b.esc <= share ? b.esc : Math.max(TOOL_RESULT_FIELD_FLOOR, share);
        let a = escKept >= b.esc ? b.len : Math.max(TOOL_RESULT_FIELD_FLOOR, Math.floor(escKept * b.len / Math.max(1, b.esc)));
        if (baseName === 'file_read' && b.key === 'content') a = Math.min(a, FILE_READ_HEAD + FILE_READ_TAIL);
        allow.set(b, a);
        available -= Math.min(escKept, b.esc);
      });
      let root = value;
      for (const b of bigs) {
        const a = allow.get(b);
        if (b.len <= a) continue;
        const parent = cowToolResultParent(value, b.path, cloneOf);
        root = cloneOf.get(value);
        const k = b.path[b.path.length - 1];
        const cut = shrinkToolText(parent[k], a, toolResultHeadRatio(baseName, b.key));
        fields.push({ path: toolResultPathText(b.path), chars: b.len, kept: cut.length });
        parent[k] = cut;
      }
      out = root; notes.fields = fields;
      let now; try { now = JSON.stringify(out).length; } catch { break; }
      if (now <= target) break;
      // 序列化会把换行/引号转义成两个字符 —— 按实测超出的比例把额度收紧再来一次(一般 1~2 轮收敛)。
      scale = Math.max(0.05, Math.min(scale * 0.9, scale * ((target - overhead) / Math.max(1, now - overhead)) * 0.98));
    }
  }
  let now; try { now = JSON.stringify(out).length; } catch { now = 0; }
  if (now > target && arrays.length) {
    const sized = [];
    for (const p of arrays) {
      let node = out; for (const k of p) node = node && node[k];
      if (Array.isArray(node)) { let n = 0; try { n = JSON.stringify(node).length; } catch { n = 0; } sized.push({ path: p, node, size: n }); }
    }
    sized.sort((a, b) => b.size - a.size);
    const cloneOf = new Map();
    for (const item of sized) {
      if (now <= target) break;
      const budget = Math.max(TOOL_RESULT_FIELD_FLOOR, item.size - (now - target));
      const r = shrinkToolResultArray(item.node, budget);
      if (!r.omitted) continue;
      if (!item.path.length) { out = r.value; notes.arrays.push({ path: '', items: item.node.length, kept: r.value.length - 1 }); }
      else {
        const parent = cowToolResultParent(out, item.path, cloneOf);
        out = cloneOf.get(out) || out;
        parent[item.path[item.path.length - 1]] = r.value;
        notes.arrays.push({ path: toolResultPathText(item.path), items: item.node.length, kept: r.value.length - 1 });
      }
      try { now = JSON.stringify(out).length; } catch { break; }
    }
  }
  if ((notes.fields.length || notes.arrays.length) && out && typeof out === 'object' && !Array.isArray(out)) {
    const prev = out._truncated && typeof out._truncated === 'object' ? out._truncated : null;
    out = { ...out, _truncated: {
      fields: (prev && Array.isArray(prev.fields) ? prev.fields : []).concat(notes.fields).slice(0, 8),
      arrays: (prev && Array.isArray(prev.arrays) ? prev.arrays : []).concat(notes.arrays).slice(0, 8),
      hint: toolResultRecoveryHint(name),
    } };
  }
  return out;
}

// 展示副本(N3):落盘的 messages / SSE 的 tool_result 用的有界副本。不含 IO —— 图片落附件由 boundToolResultForDisplay 先做。
function shrinkToolResultForDisplay(name, value) {
  if (typeof value === 'string') return value.length > TOOL_RESULT_DISPLAY_CAP ? shrinkToolText(value, TOOL_RESULT_DISPLAY_CAP - TOOL_RESULT_MARKER_RESERVE, 0.5) : value;
  if (!value || typeof value !== 'object') return value;
  // 便宜的上界估算:字符串长度之和(不含转义/引号),不到 cap 的一半肯定不用截,避免给每个小结果多序列化一遍。
  let approx = 0;
  const walk = (n, depth) => {
    if (approx > TOOL_RESULT_DISPLAY_CAP || depth > 8) return;
    if (typeof n === 'string') { approx += n.length + 8; return; }
    if (!n || typeof n !== 'object') { approx += 8; return; }
    if (Array.isArray(n)) { approx += 2 + n.length; for (let i = 0; i < n.length && approx <= TOOL_RESULT_DISPLAY_CAP; i++) walk(n[i], depth + 1); return; }
    for (const k of Object.keys(n)) { approx += k.length + 4; walk(n[k], depth + 1); if (approx > TOOL_RESULT_DISPLAY_CAP) return; }
  };
  walk(value, 0);
  if (approx <= TOOL_RESULT_DISPLAY_CAP * 0.5) return value;
  return shrinkToolResultValue(name, value, TOOL_RESULT_DISPLAY_CAP);
}

// 序列化串 → 结构感知收缩后的串;解析不了(非 JSON 对象/数组)返回 null,由调用方回退旧的整串截头。
function shrinkSerializedToolResult(name, s, cap) {
  const c0 = s.charCodeAt(0);
  if (c0 !== 0x7B && c0 !== 0x5B) return null;   // { [
  let parsed;
  try { parsed = JSON.parse(s); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const shrunk = shrinkToolResultValue(name, parsed, cap);
  let out;
  try { out = JSON.stringify(shrunk); } catch { return null; }
  return out.length <= cap ? out : null;   // 收缩后仍超限(海量小键):让调用方走平切兜底
}
const PAGED_READING_TOOL_NAMES = new Set(['file_read', 'web_fetch', 'observation_recall', 'steward_web_fetch', 'steward_file_read', 'steward_thread_artifact_read', 'tool_invoke_read']);

function isContinuableReadResult(serialized) {
  try {
    const result = JSON.parse(serialized);
    return result && result.ok === true && Number.isFinite(result.offset)
      && (Number.isFinite(result.totalChars) || Number.isFinite(result.nextOffset));
  } catch { return false; }
}

function truncateToolResult(name, jsonStr) {
  let s = String(jsonStr == null ? '' : jsonStr);
  const paged = PAGED_READING_TOOL_NAMES.has(name) && isContinuableReadResult(s);
  // MCP serializes with indentation; compact the envelope before applying the page budget.
  if (paged) s = JSON.stringify(JSON.parse(s));
  // file_read 自己按 40K 字符分页并给 nextOffset:CJK 收紧会把一个默认页(40K 汉字)从中间挖掉,而模型会直接从 nextOffset 续读、
  // 永远补不上那个洞 —— 所以 file_read 用不收紧的平口径上限(40K 页 + JSON 壳远小于 60K)。
  const cap = name === 'file_read' || paged ? TOOL_RESULT_CAP : toolResultCharCap(s);
  if (s.length <= cap) return s;
  // A2: 先试图片字段压缩(整体替换,不切中间)。
  const trimmed = s.replace(IMG_B64_TRIM_RE, (match, pre, b64) => {
    const n = b64.length;
    return `${pre}[base64 image: ${n} chars trimmed to keep tool-result within the ${TOOL_RESULT_CAP}-char budget; image is intact upstream — re-fetch with a smaller max_width / region if the visual is needed]`;
  });
  if (trimmed.length <= cap) return trimmed;
  // N2: 结构感知收缩(JSON 对象/数组):小字段与状态键保留,大字符串头+尾+计数,提示按工具给。
  const structured = shrinkSerializedToolResult(name, trimmed, cap);
  if (structured !== null) return structured;
  // 非 JSON(或收缩后仍超限)才回退整串截断。file_read 保持头 40K + 尾 8K。
  if (name === 'file_read') {
    const head = s.slice(0, FILE_READ_HEAD);
    const tail = s.slice(s.length - FILE_READ_TAIL);
    return head + `\n[...中间已截断，共 ${s.length} 字符...]\n` + tail;
  }
  // 回退平切:用 trimmed 而非原始 s —— 图片字段已缩为占位,平切不再切到任何 base64 中间(只切文本)。
  return trimmed.slice(0, cap) + `\n[...已截断，共 ${s.length} 字符，仅保留前 ${cap} 字符；${toolResultRecoveryHint(name)}...]\n`;
}

// N3:展示副本 + 图片落附件。返回的对象用于 SSE tool_result 事件与 session.messages[].toolCalls[].result。
// ① 大图 base64 字段(image / image_base64 / screenshot.image …)写进 uploads/<toolimg_…>/ 走既有附件回显通路
//    (/api/upload/content),结果里留占位 + imageAttachments[{id,name,mime,size,field}];UI 用它画 <img>,不再有整墙 base64 文本。
//    写盘失败不影响回合:只留占位。id 取内容 sha1,同一张图不重复写。
// ② 其余走 shrinkToolResultForDisplay(TOOL_RESULT_DISPLAY_CAP)。小结果原对象原样返回(同一引用,零拷贝)。
// 标量状态键(ok/path/output_path/success/op…)保持原样 —— buildTurnSummary/管家读取/UI 都只看它们。
const TOOL_IMAGE_KEY_RE = /image|base64|screenshot|thumbnail|b64/i;
const TOOL_IMAGE_B64_MIN = 8000;
const TOOL_IMAGE_B64_BODY_RE = /^(?:data:([a-z0-9+.-]+\/[a-z0-9+.-]+);base64,)?([A-Za-z0-9+/=\r\n]+)$/;
function toolImageMime(b64, declared) {
  if (declared) return declared;
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('R0lGO')) return 'image/gif';
  if (b64.startsWith('UklGR')) return 'image/webp';
  if (b64.startsWith('Qk')) return 'image/bmp';
  return 'image/png';
}
function findToolImageFields(value) {
  const found = [];
  const walk = (n, path, depth) => {
    if (depth > 3 || !n || typeof n !== 'object' || Array.isArray(n)) return;
    // Native file_read and document readers use images:[{mimeType,data}], also understood by
    // VisualPipeline. Preserve those actual bytes as attachments instead of truncating base64 text.
    if (Array.isArray(n.images)) for (let index = 0; index < n.images.length; index++) {
      const item = n.images[index];
      if (!item || typeof item.data !== 'string' || item.data.length < TOOL_IMAGE_B64_MIN || item.data.length > 4000000
          || typeof item.mimeType !== 'string' || !/^image\//.test(item.mimeType)) continue;
      const match = TOOL_IMAGE_B64_BODY_RE.exec(item.data);
      if (match && (match[1] === undefined || /^image\//.test(match[1])))
        found.push({ path: path.concat('images', index, 'data'), mime: match[1] || item.mimeType, b64: match[2] });
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (typeof v === 'string') {
        if (v.length >= TOOL_IMAGE_B64_MIN && TOOL_IMAGE_KEY_RE.test(k)) {
          const m = TOOL_IMAGE_B64_BODY_RE.exec(v.length > 4000000 ? '' : v);
          if (m && (m[1] === undefined || /^image\//.test(m[1]))) found.push({ path: path.concat(k), mime: m[1] || '', b64: m[2] });
        }
      } else if (v && typeof v === 'object') walk(v, path.concat(k), depth + 1);
    }
  };
  walk(value, [], 0);
  return found;
}
function createToolResultDisplay({ paths }) {
  async function boundToolResultForDisplay(name, resultObj, opts = null) {
    try {
      if (!resultObj || typeof resultObj !== 'object' || Array.isArray(resultObj)) return shrinkToolResultForDisplay(name, resultObj);
      let out = resultObj;
      const images = findToolImageFields(resultObj);
      if (images.length) {
        const cloneOf = new Map();
        const attachments = [];
        for (const img of images) {
          const buf = Buffer.from(img.b64, 'base64');
          const mime = toolImageMime(img.b64, img.mime);
          const ext = mime === 'image/jpeg' ? 'jpg' : mime.slice(6).replace(/[^a-z0-9]/g, '') || 'png';
          // 有归属会话时目录名带会话标签(toolimg_<tag>_<hash>):删会话时按前缀整批清(02 removeSessionToolImages)。
          const sidTag = opts && opts.sessionId ? toolImageSessionTag(opts.sessionId) : '';
          const id = 'toolimg_' + (sidTag ? sidTag + '_' : '') + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 24);
          const fname = `${String(name || 'tool').replace(/^.+?__/, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'tool'}.${ext}`;
          let stored = false;
          try {
            await fsp.mkdir(path.join(paths.uploads, id), { recursive: true });
            const target = path.join(paths.uploads, id, fname);
            // 先写临时文件再 rename:崩在半路只会留下 .tmp,不会留下「id = 内容哈希 → 永远被当成完整」的截断图。
            await fsp.access(target).catch(async () => {
              const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
              try { await fsp.writeFile(tmp, buf); await fsp.rename(tmp, target); }
              catch (e) { fsp.unlink(tmp).catch(() => {}); throw e; }
            });
            stored = true;
          } catch { stored = false; }
          const parent = cowToolResultParent(resultObj, img.path, cloneOf);
          parent[img.path[img.path.length - 1]] = `[image omitted from stored result: ${img.b64.length} base64 chars${stored ? ', saved as attachment ' + id + '/' + fname : ''}]`;
          if (stored) attachments.push({ field: toolResultPathText(img.path), id, name: fname, mime, size: buf.length });
        }
        out = { ...cloneOf.get(resultObj), ...(attachments.length ? { imageAttachments: attachments } : {}) };
      }
      return shrinkToolResultForDisplay(name, out);
    } catch {
      return resultObj;   // 展示副本永远不能拖垮回合:出任何错都退回原结果
    }
  }
  return boundToolResultForDisplay;
}

module.exports = { truncateToolResult, createToolResultDisplay, shrinkToolResultForDisplay, shrinkToolText, TOOL_RESULT_DISPLAY_CAP };
