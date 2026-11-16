'use strict';
const fsp = require('node:fs/promises');
const { FileTextIo } = require('./file-text-io.cjs');
function createPrivacySources({ PrivacyGateway }) {
// Host-only provenance follows the actual object, never text supplied by a tool.
const privacySourceViews = new WeakMap();
function privacySourceActive() { return !!PrivacyGateway.active(); }
function privacySourceMark(value, paths, view) {
  if (view) { PrivacyGateway.markSourceView(value, paths, view); privacySourceViews.set(value, view); }
  return value;
}
function privacySourceLineOffsets(raw) {
  const offsets = [0]; for (let i = 0; i < raw.length; i += 1) if (raw[i] === '\n') offsets.push(i + 1);
  return offsets;
}
function privacySourceLine(view, raw, offsets, line, limit, trim = false) {
  const start = offsets[Math.max(0, line - 1)] ?? raw.length;
  let end = offsets[line] === undefined ? raw.length : offsets[line] - 1;
  if (raw[end - 1] === '\r') end -= 1;
  let from = start;
  if (trim) { const text = raw.slice(start, end); from += text.length - text.trimStart().length; end = from + text.trim().length; }
  return PrivacyGateway.sliceSource(view, from, Math.min(end, from + limit)).text;
}
function privacySourceFragment(view, raw, fragment) {
  if (!view || !fragment) return fragment;
  let from = 0, found = false, budget = 32 * 1048576;
  while (from < raw.length) {
    budget -= raw.length - from;
    if (budget < 0) throw Object.assign(new Error('Privacy source fragment exceeds its comparison budget.'), { code: 'privacy.source_limit' });
    const at = raw.indexOf(fragment, from); if (at < 0) break;
    found = true; const projected = PrivacyGateway.sliceSource(view, at, at + fragment.length).text;
    if (projected !== fragment) return projected;
    from = at + 1;
  }
  return found ? fragment : '[source fragment unavailable]';
}
async function privacyReadTextWindow(filePath, st, req) {
  if (!privacySourceActive()) return FileTextIo.readTextWindow(filePath, st, req);
  if (st.size > 4 * 1048576) throw Object.assign(new Error('Privacy source exceeds the complete read budget.'), { code: 'privacy.source_limit' });
  const full = await FileTextIo.readTextWindow(filePath, st, { ...req, mode: 'chars', offset: 0, limit: 4 * 1048576 + 1, jsonBudget: 32 * 1048576, xform: null });
  if (!full.ok) return full;
  if (full.truncated) throw Object.assign(new Error('Privacy source snapshot is incomplete.'), { code: 'privacy.source_limit' });
  const raw = full.content, view = await PrivacyGateway.projectSource(raw), offsets = privacySourceLineOffsets(raw);
  const budget = Math.max(1000, Number(req.jsonBudget) || 50000), xform = req.xform || (text => text);
  const fit = (start, end) => {
    let piece = PrivacyGateway.sliceSource(view, start, end);
    while (JSON.stringify(xform(piece.text)).length > budget && end > start + 1) {
      end = start + Math.max(1, Math.floor((end - start) * 0.75)); piece = PrivacyGateway.sliceSource(view, start, end);
    }
    return piece;
  };
  if (req.mode !== 'lines') {
    const start = Math.min(raw.length, Math.max(0, req.offset || 0)), piece = fit(start, Math.min(raw.length, start + req.limit));
    return privacySourceMark({ ...full, content: piece.text, start: piece.start, truncated: piece.end < raw.length,
      nextOffset: piece.end, totalChars: raw.length, lineBase: raw.slice(0, piece.start).split('\n').length }, ['/content'], view);
  }
  const lines = [], lineOffset = req.lineOffset, totalLines = raw.length ? offsets.length - (raw.endsWith('\n') ? 1 : 0) : 0;
  let cost = 0, nextLine = 0, lineTruncated = null;
  for (let no = lineOffset; no <= totalLines; no += 1) {
    if (lines.length >= req.lineLimit) { nextLine = no; break; }
    const start = offsets[no - 1]; let end = offsets[no] === undefined ? raw.length : offsets[no] - 1;
    if (raw[end - 1] === '\r') end -= 1;
    let piece = PrivacyGateway.sliceSource(view, start, end);
    if (cost + JSON.stringify(xform(no + '\t' + piece.text)).length > budget) {
      if (lines.length) { nextLine = no; break; }
      piece = fit(start, end);
      if (piece.end < end) lineTruncated = { line: no, keptChars: piece.end - start, lineChars: end - start, nextOffset: piece.end };
      nextLine = no + 1;
    }
    lines.push({ no, text: piece.text }); cost += JSON.stringify(xform(no + '\t' + piece.text)).length;
    if (nextLine) break;
  }
  const result = { ...full, mode: 'lines', lines, lineOffset, lineLimit: req.lineLimit, totalLines, truncated: !!nextLine,
    ...(nextLine ? { nextLine } : {}), ...(lineTruncated ? { lineTruncated } : {}) };
  delete result.content;
  return privacySourceMark(result, lines.map((_, i) => '/lines/' + i + '/text'), view);
}
async function privacyProjectSearch(scan, opts) {
  if (!privacySourceActive()) return scan;
  if (scan.error) throw Object.assign(new Error('Privacy source scan did not complete.'), { code: 'privacy.source_scan_failed' });
  const views = new Map();
  for (const rec of scan.results) {
    let source = views.get(rec.path);
    if (!source) {
      const raw = scan.sources.get(rec.path);
      if (typeof raw !== 'string') throw Object.assign(new Error('Privacy source snapshot is unavailable.'), { code: 'privacy.source_snapshot_missing' });
      if (typeof opts.privacyGuard === 'function') await opts.privacyGuard(rec.path);
      source = { raw, view: await PrivacyGateway.projectSource(raw), offsets: privacySourceLineOffsets(raw) }; views.set(rec.path, source);
    }
    const { raw, view, offsets } = source, paths = [];
    if (typeof rec.text === 'string') { rec.text = privacySourceLine(view, raw, offsets, rec.line, 500); paths.push('/text'); }
    for (let i = 0; i < (rec.context || []).length; i += 1) {
      rec.context[i].text = privacySourceLine(view, raw, offsets, rec.context[i].line, 500); paths.push('/context/' + i + '/text');
    }
    privacySourceMark(rec, paths, view);
  }
  return scan;
}
async function readIfExists(file, limit = 200000) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    if (privacySourceActive() && raw.length > limit) throw Object.assign(new Error('Privacy source exceeds the complete read budget.'), { code: 'privacy.source_limit' });
    return raw.slice(0, limit);
  } catch (error) {
    if (String(error.code || '').startsWith('privacy.')) throw error;
    return '';
  }
}


const sourceViewOf = value => privacySourceViews.get(value);
return { privacySourceActive, privacySourceMark, privacySourceLineOffsets, privacySourceLine, privacySourceFragment, privacyReadTextWindow, privacyProjectSearch, readIfExists, sourceViewOf };
}
module.exports = { createPrivacySources };
