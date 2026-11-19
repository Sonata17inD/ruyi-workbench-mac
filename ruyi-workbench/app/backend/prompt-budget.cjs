'use strict';

// 围栏感知截断: 硬切可能切穿 <skill-index>/<workbench-memory>/<response-language-policy>
// 等围栏,留下悬空开标签 —— 不可信带边界与伪造围栏中和防线的前提是【所有围栏闭合】。切点落在未闭合围栏
// 内时回退到最早悬空开标签之前(宁可整段舍弃,不留半个围栏)。自然文本里的 <div> 之类会被当作悬空围栏而
// 多裁一些 —— 降级方向安全,可接受。
function fenceSafeSlice(text, room) {
  const s = String(text || '');
  if (s.length <= room) return s;
  let cut = s.slice(0, Math.max(0, room));
  for (let guard = 0; guard < 8; guard++) {
    const openIdx = [];
    const re = /<\/?[a-zA-Z][a-zA-Z0-9-]*>/g;
    let m;
    while ((m = re.exec(cut))) {
      const closing = m[0][1] === '/';
      const name = m[0].slice(closing ? 2 : 1, -1).toLowerCase();
      if (closing) { const i = openIdx.findIndex(o => o.name === name); if (i >= 0) openIdx.splice(i, 1); }
      else openIdx.push({ name, at: m.index });
    }
    if (!openIdx.length) return cut.replace(/\s+$/g, '');
    const back = Math.min(...openIdx.map(o => o.at));
    if (back <= 0) return ''; // 整个切点都在某个围栏内 —— 无安全内容可留
    cut = cut.slice(0, back);
  }
  return cut.replace(/\s+$/g, '');
}

// 段内收缩(保围栏): 「头部\n<fence>\n条目行…\n</fence>」结构的段优先在围栏内按行截断并补截断标记,保住
// 闭合围栏与头部;连外壳(头+开/关标签+标记)都放不下才整段返回 ''(由调用方走 fits-or-drop)。供预算紧张
// 时收缩技能索引段,替代裸 slice 留半个围栏。
function shrinkFencedSection(text, room) {
  const s = String(text || '');
  if (s.length <= room) return s;
  const openM = s.match(/<([a-zA-Z][a-zA-Z0-9-]*)>/);
  if (!openM) return fenceSafeSlice(s, room);
  const closeTag = `</${openM[1]}>`;
  if (!s.endsWith(closeTag)) return fenceSafeSlice(s, room); // 非「围栏收尾」结构,回退通用围栏安全截断
  const openEnd = openM.index + openM[0].length;
  const TRUNC = '\n…（索引已截断）';
  const shell = openEnd + closeTag.length + TRUNC.length;
  if (room < shell + 8) return ''; // 连外壳都放不下 → 整体丢弃
  let inner = s.slice(openEnd, s.length - closeTag.length).slice(0, room - shell);
  const lastNl = inner.lastIndexOf('\n');
  if (lastNl > 0) inner = inner.slice(0, lastNl); // 不切断一条条目行
  return s.slice(0, openEnd) + inner + TRUNC + closeTag;
}

// v1 技能体系: 把「用户自定义 append」与「技能索引」合成为一个 --append-system-prompt 串，整体钳到 limit。
// 「技能段先截」: 优先保住用户的 appendSystemPrompt(config 侧已各自钳 8000),剩余空间才给技能索引。
// 技能段收缩走 shrinkFencedSection(栏内截断保闭合),用户段走 fenceSafeSlice —— 绝不裸切留半个围栏。
function clampAppendWithSkills(userAppend, skillSec, limit) {
  const u = String(userAppend || '');
  let s = String(skillSec || '');
  if (!s) return fenceSafeSlice(u, limit);
  if (!u) return shrinkFencedSection(s, limit);
  const SEP = '\n\n';
  const room = limit - u.length - SEP.length;
  if (room <= 0) return fenceSafeSlice(u, limit); // 没空间放技能 → 只保用户 append
  if (s.length > room) s = shrinkFencedSection(s, room);
  if (!s) return fenceSafeSlice(u, limit); // 技能段连外壳都放不下 → 整体舍弃,保用户 append
  return u + SEP + s;
}

// v2 跨会话记忆(P3-2): 记忆段追加。与技能段(clampAppendWithSkills 会中截)不同,记忆段要么整体放入、要么整体
// 丢弃——中途截断会切掉闭合的 </workbench-memory>,留下悬空开围栏,破坏「不可信参考带」边界与伪造围栏中和防线。
// 放不下整段就当没有记忆(与注释/README 的「没空间则整体丢弃」契约一致)。base 自身超限时按 limit 截断(只损已有内容)。
function appendMemorySection(base, memSec, limit) {
  const b = String(base || '');
  const s = String(memSec || '');
  if (!s) return b.slice(0, limit);
  if (!b) return s.length <= limit ? s : ''; // 空 base:整段放得下才放,否则整体丢弃(不中截)
  const SEP = '\n\n';
  if (b.length + SEP.length + s.length > limit) return b.slice(0, limit); // 放不下整段 → 丢弃记忆段,只保留已有内容
  return b + SEP + s;
}

// Preserve the size of untrusted text while disarming a matching fence prefix.
function neutralizeFenceTag(text, tagName) {
  return String(text).replace(new RegExp('<(/?)' + tagName, 'gi'), '[$1' + tagName);
}

module.exports = { neutralizeFenceTag, appendMemorySection, clampAppendWithSkills, fenceSafeSlice, shrinkFencedSection };
