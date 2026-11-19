'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { TURN_SUMMARY_FILE_TOOLS, TURN_SUMMARY_COMMAND_TOOLS, ARTIFACT_OUTPUT_PATH_KEYS, unprefixedBridgedName, isBridgedWriteTool, TURN_SUMMARY_KNOWN_TOOLS, IRREVERSIBLE_BRIDGED_KIND, unwrapToolInvokeCall, IRREVERSIBLE_LEDGER_MAX, irreversibleToolKind, irreversibleDetail, irreversibleEntryMetadata } = require('./turn-effect-kinds.cjs');

// v0.9-S4 (C4): classify an artifact by file-name suffix. img/md/csv/txt/html/xlsx/docx/pdf → distinct
// kinds (drive the gallery's per-kind preview branch); everything else → 'other'. Extension-only (no I/O).
const ARTIFACT_IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg']);
function kindForPath(p) {
  const ext = String(path.extname(String(p || '')).replace(/^\./, '')).toLowerCase();
  if (ARTIFACT_IMG_EXTS.has(ext)) return 'img';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'csv') return 'csv';
  if (ext === 'txt') return 'txt';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'docx') return 'docx';
  if (ext === 'pdf') return 'pdf';
  return 'other';
}
// Best-effort: coerce a tool result into a plain object. Handles (a) an object already; (b) a JSON string;
// (c) an MCP content array [{type:'text',text:'{...}'}] (the shape the Claude CLI reports for workbench
// tools) — parse the concatenated text as JSON. Returns null when nothing parses.
function asResultObject(result) {
  if (result == null) return null;
  if (Array.isArray(result)) {
    const text = result.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
    try { return JSON.parse(text); } catch { return null; }
  }
  if (typeof result === 'object') return result;
  if (typeof result === 'string') { try { return JSON.parse(result); } catch { return null; } }
  return null;
}
// A small result-derived ledger survives display shrinking. These are tool-reported effects,
// not a durable native dispatch receipt, nor proof that the target application accepted input.
// Never infer a macro's completed children from requested arguments (saved recordings may rewrite them).
const IRREVERSIBLE_COMPOUND_TOOLS = new Set(['macro_run', 'batch_actions']);
const IRREVERSIBLE_RESULT_TEXT_MAX = 2 * 1024 * 1024;
function irreversibleResultObject(result) {
  if (typeof result === 'string' && (result.length > IRREVERSIBLE_RESULT_TEXT_MAX || Buffer.byteLength(result, 'utf8') > IRREVERSIBLE_RESULT_TEXT_MAX)) return null;
  if (Array.isArray(result)) {
    if (result.length > 200) return null;
    let text = '', bytes = 0;
    for (const part of result.slice(0, 200)) {
      if (typeof part?.text !== 'string') continue;
      if (part.text.length > IRREVERSIBLE_RESULT_TEXT_MAX) return null;
      bytes += Buffer.byteLength(part.text, 'utf8');
      if (bytes > IRREVERSIBLE_RESULT_TEXT_MAX) return null;
      text += part.text;
    }
    try { return JSON.parse(text); } catch { return null; }
  }
  return asResultObject(result);
}
function irreversibleReportedState(bare, r, depth = 0) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'unknown';
  // Positive prefix evidence survives enclosing cancellation/failure. Contradictory receipts
  // remain unknown. action_sent:false on its own is not proof that no prefix ran.
  if (r.action_sent === true || r.acted === true) return r.outcome === 'not_dispatched' ? 'unknown' : 'reported';
  if (r.outcome === 'unknown' || r.outcome === 'unconfirmed' || r.outcome === 'rolled_back') return 'unknown';
  if (r.outcome === 'not_dispatched') return 'none';
  if (bare === 'act_and_verify' && r.action_result && depth < 2) return irreversibleReportedState('input_sequence', r.action_result, depth + 1);
  if (bare === 'input_sequence' || bare === 'act_and_verify') return 'unknown';
  if (bare === 'ocr_click' || bare === 'vision_click' || bare === 'ocr_find_text') {
    if (r.clicked === true || (r.clicked && typeof r.clicked === 'object' && !Array.isArray(r.clicked))) return 'reported';
    if (r.click_error) return 'unknown';
    if (bare === 'ocr_find_text' && r.ok === true && r.clicked === undefined) return 'none';
    if (r.clicked === false || r.clicked === null || r.found === false || r.not_found === true) return 'none';
    return 'unknown';
  }
  if (r.acted === false && (r.ok === true || r.success === true)) return 'none';
  return r.ok === true || r.success === true ? 'reported' : 'unknown';
}
function projectBridgedIrreversible(tc0, invocationAttempted) {
  const tc = unwrapToolInvokeCall(tc0);
  const name = typeof tc?.name === 'string' ? tc.name : '';
  const bare = unprefixedBridgedName(name);
  const compound = IRREVERSIBLE_COMPOUND_TOOLS.has(bare);
  // Bare CLI/native names must not acquire bridge semantics by collision.
  if (bare === name || (!compound && !Object.hasOwn(IRREVERSIBLE_BRIDGED_KIND, bare))) return null;
  const projection = { schemaVersion: 1, items: [], incomplete: false };
  // This flag comes from the actual local call boundary, never from model arguments.
  if (invocationAttempted === false) return projection;
  const r = irreversibleResultObject(tc.result);
  const callId = typeof tc.id === 'string' && tc.id.length <= 120 ? tc.id : '';
  const callIdHash = typeof tc.id === 'string' && tc.id.length > 120 ? crypto.createHash('sha256').update(tc.id).digest('hex') : '';
  const note = (tool, result, step, kind, reason) => {
    const state = reason ? 'unknown' : irreversibleReportedState(unprefixedBridgedName(tool), result);
    if (state === 'none') return;
    if (projection.items.length >= IRREVERSIBLE_LEDGER_MAX) { projection.incomplete = true; return; }
    projection.items.push({ kind, name: tool.slice(0, 200), detail: '',
      ok: !!result && result.ok !== false && result.success !== false && !result.error && state === 'reported',
      effectStatus: state, ...(callId ? { callId } : {}), ...(callIdHash ? { callIdHash } : {}), ...(step === undefined ? {} : { parentTool: name.slice(0, 200), step }),
      ...(reason ? { reason } : {}), ...(typeof result?.outcome === 'string' ? { outcome: result.outcome.slice(0, 120) } : {}) });
  };
  if (!compound) { note(name, r, undefined, IRREVERSIBLE_BRIDGED_KIND[bare]); return projection; }
  if (r?.step_invocation_schema === 1 && r.invocation_attempted === false && !Array.isArray(r.results)) return projection;
  if (!Array.isArray(r?.results)) {
    if (r?.outcome !== 'not_dispatched') note(name, r, undefined, 'unknown', 'compound_result_unavailable');
    return projection;
  }
  const seen = new Set();
  for (const [index, child] of r.results.slice(0, 200).entries()) {
    // Malformed rows cannot certify either execution or a no-effect result.
    if (!child || !Number.isInteger(child.step) || child.step < 0 || child.step >= 200 || seen.has(child.step) || typeof child.tool !== 'string') {
      projection.incomplete = true; continue;
    }
    seen.add(child.step);
    if (child.step !== index) projection.incomplete = true;
    if (r.step_invocation_schema === 1 && child.invocation_attempted === false) {
      if (Object.hasOwn(child, 'result')) { projection.incomplete = true; note(name, null, child.step, 'unknown', 'conflicting_invocation_result'); }
      continue;
    }
    // Nested compounds are prohibited by ACC. Unexpected nested results stay unknown.
    if (IRREVERSIBLE_COMPOUND_TOOLS.has(child.tool)) {
      note(name, null, child.step, 'unknown', 'unexpected_nested_compound'); continue;
    }
    if (!Object.hasOwn(IRREVERSIBLE_BRIDGED_KIND, child.tool)) continue;
    const prefix = name.slice(0, name.lastIndexOf('__') + 2);
    const result = irreversibleResultObject(child.result);
    note(prefix + child.tool, result, child.step, IRREVERSIBLE_BRIDGED_KIND[child.tool], result ? '' : 'step_result_unavailable');
  }
  // A complete returned prefix may end early on an error. Missing requested suffixes are not
  // presumed to have run. Only malformed/omitted returned rows make this projection incomplete.
  if (r.outcome === 'unknown' || r.outcome === 'unconfirmed' || r.outcome === 'rolled_back') note(name, r, undefined, 'unknown', 'compound_outcome_unknown');
  if (r.outcome === 'not_dispatched' && projection.items.length) projection.incomplete = true;
  if (r.results.length > 200 || (Number.isInteger(r.completed) && Number.isInteger(r.failed)
      && r.completed + r.failed !== r.results.length)) projection.incomplete = true;
  if (projection.incomplete && projection.items.length < IRREVERSIBLE_LEDGER_MAX) note(name, null, undefined, 'unknown', 'compound_results_incomplete');
  return projection;
}

function buildTurnSummary(turnSeq, toolCalls, engine, journalEntries) {
  const byPath = new Map(); // path → {path, op, revertible} — journal entries take precedence over records
  let commands = 0;
  let irreversibleIncomplete = false;
  const irreversible = []; // 第72波:不可逆操作正向账(收录判据见 IRREVERSIBLE_*_KIND 头注)
  const noteIrreversible = (name, input, result) => {
    const kind = irreversibleToolKind(name);
    if (!kind) return;
    if (irreversible.length >= IRREVERSIBLE_LEDGER_MAX) { irreversibleIncomplete = true; return; }
    const r = asResultObject(result);
    irreversible.push({ kind, name: String(name || ''), detail: irreversibleDetail(input), ok: !(r && r.ok === false) });
  };
  for (const tc0 of (Array.isArray(toolCalls) ? toolCalls : [])) {
    const tc = unwrapToolInvokeCall(tc0); // 审计 N1:tool_invoke_* 按真正被调用的工具名进账
    if (!tc || !tc.name) continue;
    const name = String(tc.name);
    const input = (tc.input && typeof tc.input === 'object') ? tc.input : {};
    const projected = tc0.irreversibleProjection?.schemaVersion === 1 && Array.isArray(tc0.irreversibleProjection.items)
      ? tc0.irreversibleProjection : projectBridgedIrreversible(tc0);
    if (projected) {
      irreversibleIncomplete ||= projected.incomplete === true;
      for (const item of projected.items.slice(0, IRREVERSIBLE_LEDGER_MAX)) {
        if (irreversible.length >= IRREVERSIBLE_LEDGER_MAX) { irreversibleIncomplete = true; break; }
        irreversible.push({ kind: String(item.kind || 'unknown').slice(0, 32), name: String(item.name || name).slice(0, 200),
          detail: String(item.detail || '').slice(0, 120), ok: item.ok === true, ...irreversibleEntryMetadata(item) });
      }
    } else noteIrreversible(name, input, tc.result);
    if (TURN_SUMMARY_FILE_TOOLS.has(name)) {
      const r = asResultObject(tc.result);
      // Path: prefer the tool input; fall back to the parsed result (claude workbench tools echo .path).
      const p = input.path ? String(input.path) : (r && r.path ? String(r.path) : '');
      if (!p) continue;
      // Skip failed file ops (e.g. file_edit oldText-not-found) — nothing changed, nothing to revert.
      if (r && r.ok === false) continue;
      let op = 'unknown';
      if (name === 'file_edit') op = 'modify';
      else if (name === 'file_delete') op = 'delete';
      else if (name === 'file_write') {
        // 25.5: 幂等跳过(op:'skip')= 未发生任何改动,不进变更清单(与失败 continue 同款语义)。
        if (r && r.op === 'skip') continue;
        // file_write now echoes op (create/modify) from the journal-aware toolCall; fall back to 'unknown'.
        op = (r && r.op === 'create') ? 'create' : (r && r.op === 'modify') ? 'modify' : 'unknown';
      }
      byPath.set(path.resolve(p), { path: p, op, revertible: false });
    } else if (TURN_SUMMARY_COMMAND_TOOLS.has(name)) {
      commands += 1;
    } else if (engine === 'claude' && !TURN_SUMMARY_KNOWN_TOOLS.has(name)) {
      // Claude CLI native tools (Edit/Write/Bash/etc.) never pass through toolCall — count as a command.
      commands += 1;
    }
  }
  // v0.8-S4a: overlay the journal entries — they carry the accurate op and mark revertible:true (unless
  // the before content was too large to store → skipped → stays false). Keyed on resolved absolute path.
  // v0.8-S4b: also carry `entrySeq` so the UI「本轮变更」card can target a SINGLE file for rollback
  // (POST /api/checkpoints/rollback {turnSeq, entrySeq}). When a path was written more than once in the
  // turn the last journal entry wins here — its entrySeq is the newest `before`, i.e. rolling back that
  // one entry restores the state just prior to the last write (single-file undo semantics).
  for (const je of (Array.isArray(journalEntries) ? journalEntries : [])) {
    if (!je || !je.path) continue;
    byPath.set(path.resolve(String(je.path)), { path: String(je.path), op: je.op || 'unknown', revertible: !je.skipped, entrySeq: Number(je.entrySeq) });
  }
  const filesChanged = [...byPath.values()];
  // v0.9-S4 (C4): artifacts — files this turn PRODUCED, for the右栏「产物」gallery. Two sources, merged
  // by resolved path (last write wins, so kind stays consistent):
  //  (1) journal entries with op:'create' (a genuinely new file) → {path, kind};
  //  (2) any tool result carrying an output_path-style key (bridged doc/screenshot/office tools echo one).
  // Note: modify/delete journal entries are NOT artifacts (nothing new was produced); the file still shows
  // up under filesChanged. Kind is suffix-derived (kindForPath). De-dup keyed on the resolved absolute path.
  const artByPath = new Map();
  const addArtifact = raw => {
    const p = String(raw || '').trim();
    if (!p) return;
    artByPath.set(path.resolve(p), { path: p, kind: kindForPath(p) });
  };
  // v1.0.2-S4 产物判定放宽(产品决策):除 op:'create' 外, op:'modify' 且 kindForPath 命中已知类型
  // (img/md/csv/html/xlsx/docx/pdf) 的也算产物(改一个 xlsx 也是产物)。addArtifact 已按 resolved path
  // 去重, 故 create/modify 同 path 只留一条。'txt' 与 'other' 的 modify 不入(避免把随手改的日志/临时文
  // 本当产物, 与用户「右侧产物页签」的心智一致)。
  const ARTIFACT_MODIFY_KINDS = new Set(['img', 'md', 'csv', 'html', 'xlsx', 'docx', 'pdf']);
  for (const je of (Array.isArray(journalEntries) ? journalEntries : [])) {
    if (!je || !je.path) continue;
    if (je.op === 'create') addArtifact(je.path);
    else if (je.op === 'modify' && ARTIFACT_MODIFY_KINDS.has(kindForPath(je.path))) addArtifact(je.path);
  }
  for (const tc0 of (Array.isArray(toolCalls) ? toolCalls : [])) {
    const tc = unwrapToolInvokeCall(tc0);
    if (!tc) continue;
    const r = asResultObject(tc.result);
    if (!r || r.ok === false) continue; // failed calls produced nothing
    for (const k of ARTIFACT_OUTPUT_PATH_KEYS) {
      if (typeof r[k] === 'string' && r[k].trim()) addArtifact(r[k]);
    }
    // v1.5-W1.5: ACC 兼容层 —— 对写族 bridged 工具额外收割裸 `path`。三条同时满足才收:①工具名是写族;
    // ②结果 success===true(ACC 契约:写成功回 success:true;失败回 {error}, 无 success);③有非空字符串
    // path。与上面 addArtifact 的 resolved-path 去重合并,故新版 ACC(同时回 output_path 与 path)不会重复
    // 登记。仅对 bridged 写族生效,读类工具(read_document 也回 path)因名字不匹配而不会误收。
    if (tc.name && isBridgedWriteTool(tc.name) && r.success === true
        && typeof r.path === 'string' && r.path.trim()) {
      addArtifact(r.path);
    }
  }
  const artifacts = [...artByPath.values()];
  return { turnSeq: Number(turnSeq) || 0, filesChanged, commands, artifacts, irreversible, ...(irreversibleIncomplete ? { irreversibleIncomplete: true } : {}) };
}

module.exports = { kindForPath, asResultObject, projectBridgedIrreversible, buildTurnSummary };
