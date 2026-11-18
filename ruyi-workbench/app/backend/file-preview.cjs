'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { kindForPath } = require('./turn-summary.cjs');
const { decodeTextFileBytes } = require('./text-codecs.cjs');

const PREVIEW_TEXT_EXTS = new Set(['md', 'markdown', 'csv', 'txt', 'html', 'htm', 'json', 'js', 'ts', 'jsx', 'tsx', 'py', 'css', 'xml', 'yaml', 'yml', 'ini', 'log', 'sh', 'ps1', 'bat', 'cmd', 'toml', 'c', 'h', 'cpp', 'java', 'go', 'rs', 'rb', 'php', 'sql', 'tex']);
const PREVIEW_TEXT_MAX = 1 * 1024 * 1024;   // 1MB text cap (spec)
const PREVIEW_IMAGE_MAX = 5 * 1024 * 1024;  // 5MB image cap (spec)
const PREVIEW_IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };
// Read a preview payload for an already-validated absolute path. Returns a plain object matching the
// endpoint contract: {ok, kind:'text'|'image'|'image-toobig'|'html'|'binary', ...}. Never throws for a
// well-formed missing file — returns {ok:false,error}. Kind selection is suffix-driven (kindForPath +
// PREVIEW_TEXT_EXTS): html gets its own kind (front-end sandboxes it); img → dataURI (≤5MB, else too-big);
// text-family → decoded text content (≤1MB, truncated flag; 走查 W1·F4: BOM / UTF-8 / GBK 按内容判,见 00-boot decodeTextFileBytes); everything else → binary (front-end offers「打开」).
async function readFilePreview(absPath, snapshot = null) {
  let st;
  try { st = snapshot ? { size: snapshot.length, isDirectory: () => false } : await fsp.stat(absPath); } catch { return { ok: false, error: 'file not found' }; }
  if (st.isDirectory()) return { ok: false, error: 'is a directory', hint: '只支持预览文件' };
  const ext = String(path.extname(absPath).replace(/^\./, '')).toLowerCase();
  const kind = kindForPath(absPath);
  // Image family → base64 data URI (bounded).
  if (kind === 'img') {
    if (st.size > PREVIEW_IMAGE_MAX) return { ok: true, kind: 'image-toobig', size: st.size, canOpen: true };
    const buf = snapshot || await fsp.readFile(absPath);
    const mime = PREVIEW_IMG_MIME[ext] || 'application/octet-stream';
    return { ok: true, kind: 'image', dataUri: `data:${mime};base64,${buf.toString('base64')}`, size: st.size };
  }
  // HTML → return raw source; the front-end renders it inside a fully-locked sandbox iframe (never here).
  if (ext === 'html' || ext === 'htm') {
    if (st.size > PREVIEW_TEXT_MAX) {
      if (snapshot) return { ok: true, kind: 'html', content: decodeTextFileBytes(snapshot.subarray(0, PREVIEW_TEXT_MAX), false), truncated: true, size: st.size };
      const fd = await fsp.open(absPath, 'r');
      try { const b = Buffer.alloc(PREVIEW_TEXT_MAX); const { bytesRead } = await fd.read(b, 0, PREVIEW_TEXT_MAX, 0); return { ok: true, kind: 'html', content: decodeTextFileBytes(b.subarray(0, bytesRead), false), truncated: true, size: st.size }; }
      finally { await fd.close(); }
    }
    return { ok: true, kind: 'html', content: decodeTextFileBytes(snapshot || await fsp.readFile(absPath), true), truncated: false, size: st.size };
  }
  // Text family (md/csv/txt/json/js/py/…) → utf8 content, ≤1MB (truncated flag when larger).
  if (PREVIEW_TEXT_EXTS.has(ext)) {
    if (st.size > PREVIEW_TEXT_MAX) {
      if (snapshot) return { ok: true, kind: 'text', content: decodeTextFileBytes(snapshot.subarray(0, PREVIEW_TEXT_MAX), false), truncated: true, size: st.size };
      const fd = await fsp.open(absPath, 'r');
      try { const b = Buffer.alloc(PREVIEW_TEXT_MAX); const { bytesRead } = await fd.read(b, 0, PREVIEW_TEXT_MAX, 0); return { ok: true, kind: 'text', content: decodeTextFileBytes(b.subarray(0, bytesRead), false), truncated: true, size: st.size }; }
      finally { await fd.close(); }
    }
    return { ok: true, kind: 'text', content: decodeTextFileBytes(snapshot || await fsp.readFile(absPath), true), truncated: false, size: st.size };
  }
  // xlsx/docx/pdf/other → binary; the front-end offers「用系统程序打开」(office_open). Station-side
  // preview of office formats is DEFERRED to v1.0 (zero-npm constraint: no xlsx/docx/pdf parsing lib).
  return { ok: true, kind: 'binary', canOpen: true, size: st.size, ext };
}

module.exports = { PREVIEW_TEXT_EXTS, readFilePreview };
