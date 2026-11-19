'use strict';

const CONTEXT_GOVERNANCE_RULES = require('./context-governance-rules.json');
const { PROMPT_EN, getPromptPack } = require('./prompt-registry.cjs');
const { summaryPromptI18nEnabled } = require('./runtime-policy.cjs');

const SUMMARY_PROMPT = CONTEXT_GOVERNANCE_RULES.summary.prompt;
// 126-111d:英文那份。**读的那一半早就双语了** —— summary.sections 里的 `## Goal`／`## Decisions`
// …与 stateLabels 里的 Done／In progress／Blocked／Next step 都是登记过的别名;缺的只有写的这一头。
const SUMMARY_PROMPT_EN = CONTEXT_GOVERNANCE_RULES.summary.promptEn || SUMMARY_PROMPT;
function summaryPromptIsEnglish(config) {
  return summaryPromptI18nEnabled(config) && getPromptPack(config.locale) === PROMPT_EN;
}

function summaryPromptWithGuidance(config) {
  if (summaryPromptIsEnglish(config)) return SUMMARY_PROMPT_EN;
  const guidance = String(CONTEXT_GOVERNANCE_RULES.summary.callPolicy?.promptGuidance || '').trim();
  if (!guidance || SUMMARY_PROMPT.includes(guidance)) return SUMMARY_PROMPT;
  return SUMMARY_PROMPT + '\n' + guidance;
}

// The validator and notes extraction share the same heading aliases and Markdown tolerance.
function summarySectionLocations(summary) {
  const text = String(summary || '');
  const sections = CONTEXT_GOVERNANCE_RULES.summary.sections;
  const normHead = value => String(value || '').toLowerCase()
    .replace(/^[\s#*>\-]+/, '').replace(/[【】[\]]/g, '').replace(/[:：]\s*$/, '').trim();
  const lines = [];
  let offset = 0;
  for (const line of text.split('\n')) { lines.push({ text: line, offset }); offset += line.length + 1; }
  const found = [];
  for (let index = 0; index < sections.length; index++) {
    let location = null;
    for (const alias of sections[index]) {
      const heading = normHead(alias);
      for (const line of lines) {
        if (!heading || !normHead(line.text).startsWith(heading) || (location && line.offset > location.pos)) continue;
        const at = line.text.toLowerCase().indexOf(heading);
        if (at < 0) continue;
        const end = at + heading.length;
        // Section names quoted inside a previous section are not headings. Match at line start
        // (after Markdown decoration), retaining inline bodies such as 【目标】task or Goal: task.
        if (end < line.text.length && !/^[\s*:：】\]\-—]/.test(line.text.slice(end))) continue;
        const suffix = /^[\s*:：】\]\-—]*/.exec(line.text.slice(end))[0].length;
        location = { index, pos: line.offset, len: end + suffix };
      }
    }
    if (location) found.push(location);
  }
  return found.sort((a, b) => a.pos - b.pos);
}

function validateStructuredSummary(summary) {
  if (!summary || typeof summary !== 'string') return false;
  // 每节接受 中文标题 或 常见英文变体(英文模型可能按英文输出;SUMMARY_PROMPT 为中文硬编码,
  // 故英文变体用独立标题词,避免与正文内容误匹配)。
  // 126-111d 标题容错:模型常把 `## Goal` 写成 `**Goal**`／`# Goal:`／`- Goal —`,含义一样但
  // `includes(别名)` 认不出来。归一之后按【行首】匹配:去掉行首的 #／*／>／-／空白与
  // 【】[],去掉行尾的冒号,大小写不敏感。
  //
  // **这一半故意不挂开关**:它只会让本来就正确的摘要更容易通过,不会让错的通过 —— 判据锚在
  // 行首,正文里顺嘴提一句 "goal" 不算数(下面 D 组有一条专门反着验这件事)。挂开关反而会让
  // 「开关关时英文模型的合法摘要被判不合格」这个老毛病留着。
  const locations = summarySectionLocations(summary);
  const found = locations.length;
  // 当前执行状态是交接摘要的关键部分，不能再用“任意三节”放行；否则模型
  // 漏掉状态节时，下一轮会失去“已完成/进行中/阻塞/下一步”的恢复依据。
  const stateLabels = CONTEXT_GOVERNANCE_RULES.summary.stateLabels;
  const statePresent = locations.some(location => location.index === CONTEXT_GOVERNANCE_RULES.summary.statusSectionIndex);
  const stateComplete = statePresent && stateLabels.every(labels => labels.some(label => summary.includes(label)));
  return found >= CONTEXT_GOVERNANCE_RULES.summary.minimumSections && stateComplete;  // 结构化摘要必须含五节中的至少四节,且状态节四项齐全
}

module.exports = { SUMMARY_PROMPT, SUMMARY_PROMPT_EN, summaryPromptIsEnglish, summaryPromptWithGuidance, summarySectionLocations, validateStructuredSummary };
