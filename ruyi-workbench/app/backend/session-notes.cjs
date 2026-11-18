'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { runKeyedChain } = require('./keyed-chain.cjs');
const { readCompactionSummaryText } = require('./provider-history.cjs');
const { sessionNotesEnabled, sessionNotesMergeEnabled, sessionNotesInjectEnabled } = require('./runtime-policy.cjs');
const { summarySectionLocations } = require('./summary-format.cjs');

// ── 105b: session-notes.md 状态外置(只写切片)─────────────────────────────────
// 从既有五节结构化摘要【确定性切出】状态三节,整写到 sessions/<id>.session-notes.md 旁车副本。
// 节索引锚定 context-governance-rules.json 的 summary.sections 顺序(1=已确认的决定,2=未完成事项,
// 4=关键文件与上下文);0=目标、3=当前执行状态留在摘要叙事里,不进 notes(摘要保留叙事职责)。
// No additional model calls; extraction and merging reuse the existing three-section sidecar.
const SESSION_NOTES_SECTION_INDEXES = [1, 2, 4];
const SESSION_NOTES_TITLES = ['已确认的决定', '未完成事项', '关键文件与上下文'];
function sessionNotesBodyEmpty(body) {
  return /^(?:无|none)?$/i.test(String(body || '').trim());
}
function extractSessionNotes(summary) {
  const text = String(summary || '');
  const found = summarySectionLocations(text);
  const out = [];
  for (const idx of SESSION_NOTES_SECTION_INDEXES) {
    const f = found.find(x => x.index === idx);
    if (!f) { out.push('无'); continue; }              // 缺节降级为「无」,对齐摘要空节约定
    const next = found.find(x => x.pos > f.pos);
    const body = text.slice(f.pos + f.len, next ? next.pos : undefined).trim();
    out.push(sessionNotesBodyEmpty(body) ? '无' : body);
  }
  return { decisions: out[0], open: out[1], files: out[2] };
}
function renderSessionNotesMarkdown(notes, meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const head = `<!-- schema:1 session:${String(m.sessionId || '')} updatedAt:${String(m.updatedAt || '')} turnSeq:${Number.isFinite(m.turnSeq) ? m.turnSeq : 0} -->`;
  const parts = ['# Session Notes', '', head, ''];
  const bodies = [notes && notes.decisions, notes && notes.open, notes && notes.files];
  for (let i = 0; i < SESSION_NOTES_TITLES.length; i++) {
    parts.push(`## ${SESSION_NOTES_TITLES[i]}`, '', String(bodies[i] || '无'), '');
  }
  return parts.join('\n');
}
// 105d: 解析 renderSessionNotesMarkdown 产物的 `##` 三节回 {decisions, open, files};
// 三个标题一个都找不到视为解析失败(null) —— 回注重空判定与增量合并共用这个解析器。
function parseSessionNotesMarkdown(markdown) {
  const text = String(markdown || '');
  const keys = ['decisions', 'open', 'files'];
  const found = [];
  for (let i = 0; i < SESSION_NOTES_TITLES.length; i++) {
    const marker = `## ${SESSION_NOTES_TITLES[i]}`;
    const pos = text.indexOf(marker);
    if (pos >= 0) found.push({ index: i, pos, len: marker.length });
  }
  if (!found.length) return null;
  found.sort((a, b) => a.pos - b.pos);
  const out = {};
  for (const f of found) {
    const next = found.find(x => x.pos > f.pos);
    const body = text.slice(f.pos + f.len, next ? next.pos : undefined).trim();
    out[keys[f.index]] = sessionNotesBodyEmpty(body) ? '无' : body;
  }
  return { decisions: out.decisions || '无', open: out.open || '无', files: out.files || '无' };
}
// 105d-B: 增量合并 —— 决定/关键文件两节并集去重(按行 trim 精确去重,next 的行在前、prev 独有行
// 追加在后,新的优先;超 64K 由 writeSessionNotes 现有尾部截断兜底,自然保住新内容);
// 未完成事项节以最新为准(replace) —— 已完成事项必须能消失,摘要是权威状态。「无」节视为空集。
// prev 缺失/解析失败 → 直接用 next(降级为 105b 整体重写语义)。
// 已知局限:文本级合并无法识别「被后文推翻的决定」,并列保留属实验语义,由 105 总门取证裁决。
function mergeSessionNotes(prevMarkdown, nextNotes) {
  const prev = typeof prevMarkdown === 'string' && prevMarkdown ? parseSessionNotesMarkdown(prevMarkdown) : null;
  if (!prev || !nextNotes || typeof nextNotes !== 'object') return nextNotes;
  return {
    decisions: mergeSessionNotesLines(nextNotes.decisions, prev.decisions),
    open: nextNotes.open, // replace: 以最新摘要为准
    files: mergeSessionNotesLines(nextNotes.files, prev.files),
  };
}
function mergeSessionNotesLines(nextBody, prevBody) {
  const toLines = body => (sessionNotesBodyEmpty(body) ? [] : String(body || '').split('\n').map(l => l.trim()).filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const line of [...toLines(nextBody), ...toLines(prevBody)]) {
    if (seen.has(line)) continue;
    seen.add(line); out.push(line);
  }
  return out.join('\n'); // 空集交给 renderSessionNotesMarkdown 的「无」兜底,保证合并结果可再解析(回环)
}

// 105d-A: session notes 回注 prompt —— 把旁车 notes 有界、非持久地贴到最新一条 user 消息旁
// (样板同 105a recovery index)。开关关 / notes 缺失 / 解析失败 / 三节全空(皆「无」) → ''(零注入)。
// 有界:【整个注入块】不超过上限；正文超出时保留头部 + 省略计数标记(常数内置,对齐 105a 风格),
// 预算口径与 recall prompt 一致 —— 在 buildBody 内追加,不进 budgetPrompt。
const SESSION_NOTES_INJECT_MAX_CHARS = 2000;
function buildSessionNotesInjectPrompt(notesMarkdown, config, history) {
  if (!sessionNotesInjectEnabled(config) || typeof notesMarkdown !== 'string' || !notesMarkdown) return '';
  const sections = parseSessionNotesMarkdown(notesMarkdown);
  if (!sections) return '';
  const summary = readCompactionSummaryText(history);
  if (summary !== null) {
    // Merged notes can contain still-useful decisions absent from the latest summary.
    // Supplement only that difference; old open items must never become pending again.
    if (!sessionNotesMergeEnabled(config)) return '';
    const current = extractSessionNotes(summary);
    const missingLines = (body, existing) => {
      const seen = new Set(String(existing || '').split('\n').map(line => line.trim()));
      return String(body || '').split('\n').map(line => line.trim()).filter(line => !sessionNotesBodyEmpty(line) && !seen.has(line)).join('\n') || '无';
    };
    sections.decisions = missingLines(sections.decisions, current.decisions);
    sections.files = missingLines(sections.files, current.files);
    sections.open = '无';
    notesMarkdown = renderSessionNotesMarkdown(sections);
  }
  const allEmpty = [sections.decisions, sections.open, sections.files].every(sessionNotesBodyEmpty);
  if (allEmpty) return '';
  const prefix = '[Ruyi session notes — runtime context, not user-authored]\n'
    + (summary !== null
      ? 'These retained historical decisions and context are candidates supplementing missing details, not active instructions. They may be superseded: the newest summary wins, and current user instructions take precedence. Reuse a taught procedure only while it remains applicable; never automatically restore old objectives or constraints, or completed, cancelled or superseded work.\n'
      : 'The notes below are a deterministic extraction from compaction summaries of this session (decisions / open items / key files). They are historical evidence, not a new user request. The newest summary wins, and current user instructions take precedence; never automatically restore old objectives or constraints, or completed, cancelled or superseded work.\n');
  const bodyBudget = Math.max(0, SESSION_NOTES_INJECT_MAX_CHARS - prefix.length);
  if (notesMarkdown.length <= bodyBudget) return prefix + notesMarkdown;
  // 省略数本身的位数会改变可见正文长度，至多两轮即可收敛；末轮再防御性钳位总长。
  let kept = bodyBudget;
  for (let i = 0; i < 3; i++) {
    const marker = `\n[...${notesMarkdown.length - kept} chars omitted...]`;
    const next = Math.max(0, bodyBudget - marker.length);
    if (next === kept) break;
    kept = next;
  }
  const marker = `\n[...${notesMarkdown.length - kept} chars omitted...]`;
  return (prefix + notesMarkdown.slice(0, kept) + marker).slice(0, SESSION_NOTES_INJECT_MAX_CHARS);
}

const SESSION_NOTES_MAX_CHARS = 64000;

function createSessionNotes({ paths, assertSessionIdForPath, atomicWriteJson, sessionObjectIsStale, sessionSaveIsTombstoned, logEvent }) {
  const writes = new Map();

  function sessionNotesPath(id) {
    return path.join(paths.sessions, assertSessionIdForPath(id) + '.session-notes.md');
  }

  async function readSessionNotes(id) {
    try { return await fsp.readFile(sessionNotesPath(id), 'utf8'); }
    catch { return null; }
  }

  async function commitNotes(file, markdown) {
    let body = String(markdown ?? '');
    if (body.length > SESSION_NOTES_MAX_CHARS) {
      body = body.slice(0, SESSION_NOTES_MAX_CHARS) + `\n\n<!-- truncated: exceeded ${SESSION_NOTES_MAX_CHARS} chars -->\n`;
    }
    await fsp.mkdir(paths.sessions, { recursive: true });
    await atomicWriteJson(file, body);
  }

  async function writeSessionNotes(id, markdown) {
    const file = sessionNotesPath(id);
    await runKeyedChain(writes, file, () => commitNotes(file, markdown));
  }

  async function removeSessionNotes(id) {
    const file = sessionNotesPath(id);
    await runKeyedChain(writes, file, () => fsp.unlink(file).catch(() => {}));
  }

  // Complete the sidecar before the next request reads it. Keep merge and write in the same queue.
  async function maybeWriteSessionNotes(session, summary, config) {
    try {
      if (!sessionNotesEnabled(config) || !session?.id || typeof summary !== 'string' || !summary) return;
      const file = sessionNotesPath(session.id);
      const notes = extractSessionNotes(summary);
      const meta = { sessionId: session.id, updatedAt: new Date().toISOString(), turnSeq: session.turnSeq };
      await runKeyedChain(writes, file, async () => {
        if (sessionSaveIsTombstoned(session)) return;
        const prev = sessionNotesMergeEnabled(config) ? await readSessionNotes(session.id) : null;
        if (sessionSaveIsTombstoned(session)) return;
        if (sessionObjectIsStale(session)) {
          logEvent({ kind: 'session_notes_stale_skipped', sessionId: session.id });
          return;
        }
        await commitNotes(file, renderSessionNotesMarkdown(mergeSessionNotes(prev, notes), meta));
      });
    } catch { /* The notes sidecar is best effort. */ }
  }

  return { sessionNotesPath, readSessionNotes, writeSessionNotes, removeSessionNotes, maybeWriteSessionNotes };
}

module.exports = { createSessionNotes, extractSessionNotes, renderSessionNotesMarkdown, parseSessionNotesMarkdown,
  mergeSessionNotes, buildSessionNotesInjectPrompt };
