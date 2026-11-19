'use strict';

function memoryProposalLooksSensitive(proposal) {
  const text = [proposal && proposal.name, proposal && proposal.description, proposal && proposal.body].filter(Boolean).join('\n');
  // 「关键词 + 冒号/等号 + ≥6 个非空白字符」。JS 的 \b 只认 ASCII 单词字符:修前把 密码|密钥 放进 \b(?:…) 里,CJK 关键词两侧都是
  // 非单词字符,\b 永远不成立 → 中文「数据库密码: xxx」一条都拦不住;冒号也只认半角。现在 ASCII 关键词保留 \b,CJK 关键词不带 \b,
  // 分隔符同时认全角「：」「＝」(中文输入法下几乎都是全角)。
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|authorization)|密码|密钥)\s*[:：=＝]\s*[^\s*]{6,}|\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql):\/\/[^\s:@/]+:[^\s@/]+@/i.test(text);
}

module.exports = { memoryProposalLooksSensitive };
