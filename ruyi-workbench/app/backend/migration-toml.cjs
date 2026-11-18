'use strict';

const { _tomlKeyPath } = require('./mcp-config-import.cjs');

// 一个服务器 mcp_servers.<id> 在 TOML 全文里占的全部 [start, end) 字符区间:[mcp_servers.<id>] 本段,加上它的子表
// ([mcp_servers.<id>.env] / .http_headers / .tools.x …)。区间 = 表头的下一行起,到下一个表头(任何 [ 开头的行)之前。
// 同一服务器的几段在 TOML 里可以不相邻,所以回的是区间数组(找不到回 [])。
// 修前只认精确的 [mcp_servers.<id>]:Codex 常把 env 写成 [mcp_servers.<id>.env] 子表,解析侧(_parseTomlMcpServers)把子表里的
// 老包路径算进了 env.<KEY> 的改写项,这里却搜不到子表 → 那一项改写不了(单独一项时整体 nothing-applied,与别的字段同批时被静默漏掉)。
// 表头的键路径按 TOML 规则拆(带引号的段、点号都处理),与解析侧同一个 _tomlKeyPath。
function migrationTomlSections(text, serverId) {
  const ranges = [];
  let pos = 0, start = -1;
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) {
      if (start >= 0) { ranges.push({ start, end: pos }); start = -1; }
      const m = /^\s*\[(?!\[)\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line.replace(/\r$/, ''));
      if (m) {
        const keyPath = _tomlKeyPath(m[1]);
        if (keyPath[0] === 'mcp_servers' && keyPath[1] === serverId) start = pos + line.length + 1;
      }
    }
    pos += line.length + 1;
  }
  if (start >= 0) ranges.push({ start, end: text.length });
  return ranges;
}
// 在 TOML 服务器区间(本段 + 子表)内把带引号的旧值换成新值(保留原引号样式)。返回 { text, count }。
function migrationTomlReplace(text, serverId, from, to) {
  const ranges = migrationTomlSections(text, serverId);
  if (!ranges.length) return { text, count: 0 };
  let count = 0;
  for (const sec of ranges.slice().reverse()) {   // 从后往前改:前面区间的偏移不受影响
    let body = text.slice(sec.start, sec.end);
    for (const q of ['"', "'"]) {
      const needle = q + from + q;
      while (body.includes(needle)) { body = body.replace(needle, () => q + to + q); count++; }
    }
    text = text.slice(0, sec.start) + body + text.slice(sec.end);
  }
  return { text, count };
}

module.exports = { migrationTomlSections, migrationTomlReplace };
