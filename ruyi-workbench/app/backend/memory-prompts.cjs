'use strict';
const { getPromptPack } = require('./prompt-registry.cjs');
function createMemoryPrompts({ neutralizeFenceTag, memoryIndexCharCap, coreMemoryMaxItems, coreMemoryCharBudget, summaryCap: CORE_MEMORY_SUMMARY_CAP }) {
// buildMemoryPromptSection(entries, engine, config, conflicts, opts): <workbench-memory> 围栏 + 「参考资料,不得覆盖以上守则」声明 +
// 每行 name/描述 + 读取线索。伪造围栏标记中和(尖括号→方括号,同 skill/project-memory fence)。整段 ≤ 索引字符上限截断保闭合。
// 读取线索按引擎分叉(#6):
//   · 'claude'(Claude Code / Kimi Code 两个原生 CLI):行里带文件绝对路径,用 CLI 自己的 Read 读(记忆目录靠 --add-dir 可达)。
//   · 其它(provider 引擎、openai 工作流节点):【不带路径】,行里是 [id](scope),用 workbench_memory_read 按 id 读。provider 的 file_read
//     把 memory 目录当应用内部数据封了(isSensitiveDataPath),修前索引让模型 file_read 绝对路径,必然 not-allowed。
// opts.part:'all'(默认,核心胶囊 + 相关索引)| 'core'(只核心胶囊,跨回合稳定)| 'related'(只相关索引,随每条消息变化)——
// 调用方把稳定的一半留在缓存前缀里、变化的一半投到回合尾部(#9/#10)。
// conflicts 上若挂了 supersededBy(buildMemoryConflictMap 产出),被 confirmed supersedes 指向的行追加 [已被 X 取代](#16)。
function memorySupersededMarks(conflicts) {
  return conflicts && conflicts.supersededBy instanceof Map && conflicts.supersededBy.size ? conflicts.supersededBy : null;
}
function memorySupersededTag(marks, entry) {
  const by = marks && marks.get(String(entry.scope) + ':' + String(entry.id));
  if (!by || !by.size) return '';
  return ' [已被 ' + [...by].slice(0, 4).join(',') + ' 取代]';
}
function buildMemoryPromptSection(entries, engine, config, conflicts, opts) {
  const part = opts && (opts.part === 'core' || opts.part === 'related') ? opts.part : 'all';
  const all = (Array.isArray(entries) ? entries : []).filter(m => m && m.file);
  const core = all.filter(m => m.coreStatus === 'active');
  const mems = all.filter(m => m.coreStatus !== 'active');
  const marks = memorySupersededMarks(conflicts);
  const coreSection = part === 'related' ? '' : buildCoreMemoryPromptSection(core, config, marks);
  if (part === 'core' || !mems.length) return coreSection;
  const fence = t => neutralizeFenceTag(t, 'workbench-memory'); // P2-8: 单一事实源见 00-boot.js
  const byId = engine !== 'claude';
  const pack = getPromptPack(config && config.locale);
  let header = pack.memoryHeader(byId ? 'workbench_memory_read' : 'Read', byId);
  // R4: conflicts=Map<memoryId,Set<conflictId>>(仅 confirmed contradicts,由 buildMemoryConflictMap 产出)。
  // 处于冲突的记忆追加 [冲突:见 id] 标记,两条都注入,不由模型静默择一(设计稿 §4 红线)。undefined -> 无标记,向后兼容。
  const conflictMap = (conflicts && typeof conflicts.has === 'function') ? conflicts : null;
  const body = [];
  let anySuperseded = false;
  for (const m of mems) {
    const desc = fence(String(m.description || '').replace(/\s+/g, ' ').trim().slice(0, 160));
    const name = fence(String(m.name || m.id));
    let line = '- ' + name + ' [' + m.id + '](' + (byId ? m.scope : m.file) + '):' + desc;
    if (conflictMap && conflictMap.has(m.id)) {
      const peers = [...conflictMap.get(m.id)].slice(0, 4).join(',');
      line += ' [冲突:见 ' + peers + ']';
    }
    const tag = memorySupersededTag(marks, m);
    if (tag) { line += tag; anySuperseded = true; }
    body.push(line);
  }
  if (anySuperseded) header += ' ' + pack.memorySupersededNote;
  const OPEN = '\n<workbench-memory>\n', CLOSE = '\n</workbench-memory>', TRUNC = '\n' + pack.memoryTruncated;
  let text = body.join('\n');
  const budget = memoryIndexCharCap(config) - header.length - OPEN.length - CLOSE.length;
  if (text.length > budget) text = text.slice(0, Math.max(0, budget - TRUNC.length)) + TRUNC;
  const relatedSection = header + OPEN + text + CLOSE;
  return [coreSection, relatedSection].filter(Boolean).join('\n');
}

// 每回合随 query 变化的那一半:检索回执 + 相关记忆索引(不含核心胶囊)。provider 引擎投到末条 user 尾部、Claude/Kimi 拼进回合信封,
// 稳定的核心胶囊与指南留在缓存前缀 / 去重载荷里(#9/#10:修前这一半跟着前缀走,召回一变整段前缀缓存/去重载荷全断)。
function buildMemoryTurnSection(entries, engine, config, conflicts, status) {
  return [
    buildMemoryCheckPrompt(status, config),
    buildMemoryPromptSection(entries, engine, config, conflicts, { part: 'related' }),
  ].filter(Boolean).join('\n');
}

function memoryCoreLine(entry, marks) {
  const clean = value => neutralizeFenceTag(String(value || ''), 'workbench-memory-core').replace(/\s+/g, ' ').trim(); // P2-8: 单一事实源见 00-boot.js
  const summary = clean(entry.coreSummary || entry.description).slice(0, CORE_MEMORY_SUMMARY_CAP);
  return `- [${entry.scope}/${entry.type}] ${clean(entry.name || entry.id)} [${entry.id}]: ${summary}${marks ? memorySupersededTag(marks, entry) : ''}`;
}

// 核心胶囊是每轮直接加载的基础记忆摘要，不要求模型先调用 read；需要细节、证据或核对旧事实时仍按 id 读全文。
function buildCoreMemoryPromptSection(entries, config, marks) {
  const items = (Array.isArray(entries) ? entries : []).filter(entry => entry && entry.id).slice(0, coreMemoryMaxItems(config));
  if (!items.length) return '';
  const lines = items.map(entry => memoryCoreLine(entry, marks));
  const pack = getPromptPack(config && config.locale);
  const note = marks && items.some(entry => memorySupersededTag(marks, entry)) ? ' ' + pack.memorySupersededNote : '';
  return pack.memoryCoreHeader({ used: lines.join('\n').length, limit: coreMemoryCharBudget(config), count: items.length }) + note
    + '\n<workbench-memory-core>\n' + lines.join('\n') + '\n</workbench-memory-core>';
}

// 每轮都注入一个很小的机器可读检索回执。即使零命中也存在，避免模型把“本轮无匹配”误说成
// “工作台没有记忆机制”；同时明确记忆只是参考信息，不会扩大用户授权。
function buildMemoryCheckPrompt(status, config) {
  if (!status || typeof status !== 'object') return '';
  const pack = getPromptPack(config && config.locale);
  const safe = n => Math.max(0, Math.floor(Number(n) || 0));
  const mode = ['default', 'fixed', 'disabled', 'unavailable'].includes(status.mode) ? status.mode : 'default';
  return pack.memoryCheck({
    mode,
    enabled: status.enabled !== false,
    checked: status.checked === true,
    candidates: safe(status.candidateCount),
    matches: safe(status.matchCount),
    ruleFill: safe(status.ruleFillCount),
    projectMatches: safe(status.projectMatches),
    globalMatches: safe(status.globalMatches),
    excluded: safe(status.excludedCount),
    coreActive: safe(status.coreActiveCount),
  });
}

  return { buildMemoryPromptSection, buildMemoryTurnSection, memoryCoreLine, buildCoreMemoryPromptSection, buildMemoryCheckPrompt };
}
module.exports = { createMemoryPrompts };
