'use strict';
const READ_PAGE_JSON_BUDGET = 52000;
function boundedReadPage(full, offset, maxChars, build) {
  const text = String(full || '');
  const start = Math.min(text.length, Math.max(0, Math.floor(Number(offset) || 0)));
  const safeEnd = end => end > start && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) ? end - 1 : end;
  let end = safeEnd(Math.min(text.length, start + maxChars));
  let result = build(text.slice(start, end), end, start);
  if (JSON.stringify(result).length <= READ_PAGE_JSON_BUDGET) return result;
  let low = start, high = end;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidateEnd = safeEnd(middle);
    const candidate = build(text.slice(start, candidateEnd), candidateEnd, start);
    if (JSON.stringify(candidate).length <= READ_PAGE_JSON_BUDGET) low = middle;
    else high = middle - 1;
  }
  end = safeEnd(low);
  return build(text.slice(start, end), end, start);
}

module.exports = { boundedReadPage, READ_PAGE_JSON_BUDGET };
