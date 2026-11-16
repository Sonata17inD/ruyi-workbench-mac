'use strict';
function stripLeadingBom(raw) { return String(raw || '').replace(/^\uFEFF/, ''); }
// YAML 块标量(description: > / | / >- / |-,后跟缩进的续行)。修前值取到的就是字面的「>」。
// 只认这两种块标量与单行 key: value,够 SKILL.md / 记忆 / 命令文件用;不引入 YAML 解析器。
function foldFrontmatterBlock(style, lines) {
  const body = lines.slice();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const widths = body.filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length);
  const indent = widths.length ? Math.min(...widths) : 0;
  const rows = body.map(l => l.slice(indent).replace(/\s+$/, ''));
  if (style === '|') return rows.join('\n').trim();
  let out = '';
  for (const r of rows) {
    if (!r) { out += '\n'; continue; }
    out += (out && !out.endsWith('\n') ? ' ' : '') + r;
  }
  return out.trim();
}
function parseFrontmatter(raw) {
  const fm = {};
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(stripLeadingBom(raw));
  if (m) {
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const mm = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
      if (!mm) continue;
      const block = /^([>|])[+-]?[1-9]?\s*$/.exec(mm[2]);
      if (block) {
        const cont = [];
        while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) cont.push(lines[++i]);
        fm[mm[1].toLowerCase()] = foldFrontmatterBlock(block[1], cont);
        continue;
      }
      // 只剥【成对】的外层引号:修前两端各剥一次,`description: 当用户说 "继续"` 读回 `当用户说 "继续`(尾引号是正文的一部分)。
      fm[mm[1].toLowerCase()] = mm[2].trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    }
  }
  return fm;
}

// First real paragraph of a doc (skipping frontmatter + the # title) — used as a description when the
// toolkit files have no YAML frontmatter.
function firstParaDesc(raw) {
  const body = stripLeadingBom(raw).replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '');
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('---')) continue;
    return t.replace(/^[*_>\-]+\s*/, '').slice(0, 180);
  }
  return '';
}
function docMeta(raw) {
  const fm = parseFrontmatter(raw);
  return { name: fm.name || '', description: fm.description || firstParaDesc(raw) };
}

// Remove machine-facing frontmatter while keeping the useful workflow body for the skill detail view and
// provider-compatible command templates. The result is still treated as authored/untrusted content.
function docBody(raw, max = 12000) {
  return stripLeadingBom(raw).replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '').trim().slice(0, max);
}
function commandPrompt(raw) {
  return docBody(raw, 8000).replace(/^#\s+[^\r\n]+\r?\n+/, '').trim();
}

module.exports = { parseFrontmatter, firstParaDesc, docMeta, docBody, commandPrompt };
