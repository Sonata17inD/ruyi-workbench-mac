'use strict';
// Structured DAG output and quality gates. This intentionally implements the portable, commonly
// used JSON Schema subset in-process (type/properties/required/items/enum/const/numeric/string/array
// bounds and additionalProperties). Keeping it dependency-free preserves the offline package.
const EVIDENCE_REFS_MAX_ITEMS = 32;
const QUALITY_GATE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['verdict', 'confidence', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          message: { type: 'string' },
          target: { type: 'string' },
          // Optional for old workflows; requireEvidence is enforced after output by verifyNodeClaims.
          evidenceRefs: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 256 },
            maxItems: EVIDENCE_REFS_MAX_ITEMS,
            uniqueItems: true,
          },
        },
      },
    },
    // M3(09-m3-coverage-gate.md): verify 节点「输入覆盖率」职责。可选字段——该 schema 被所有
    // gate 节点共享,做成 required 会破坏不输出 coverage 的存量 verify 节点。未处理项判定由
    // 后端(09-workflow.js)看机器数据 unhandled[] 做,不依赖模型自报。
    coverage: {
      type: 'object',
      required: ['total', 'handled', 'unhandled'],
      properties: {
        total: { type: 'integer', minimum: 0 },
        handled: { type: 'integer', minimum: 0 },
        unhandled: { type: 'array', items: { type: 'string' } },
      },
    },
    // R4-S2(15-r4-memory-graph.md §9): gate 节点可在结构化输出里提议记忆关系(写入时 confirmed:false,
    // 用户确认)。可选字段--不输出 memoryRelations 的存量 gate 节点不受影响。模型只提议,不写确认。
    memoryRelations: {
      type: 'array',
      maxItems: 20,
      description: '可选:提议本会话工作台记忆索引中已存在记忆之间的关系(supports/contradicts/supersedes/derived_from)。from/to 须为索引中出现的记忆 id;evidenceRef 引用本节点可见 Evidence Catalog 的 eventId。仅提议,用户确认后生效。',
      items: {
        type: 'object',
        required: ['type', 'from', 'to'],
        properties: {
          type: { type: 'string', enum: ['supports', 'contradicts', 'supersedes', 'derived_from'] },
          from: { type: 'string', minLength: 1, maxLength: 64 },
          to: { type: 'string', minLength: 1, maxLength: 64 },
          evidenceRef: { type: 'string', minLength: 1, maxLength: 256 },
          note: { type: 'string', maxLength: 200 },
        },
      },
    },
  },
});
function sanitizeAgentOutputSchema(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try { const s = JSON.stringify(raw); return s.length <= 20000 ? JSON.parse(s) : null; } catch { return null; }
}
// v1.6.1 (对抗轮 P1 重设计): 从模型输出里枚举"最可能是那段 JSON"的候选切片,统一按"在原文中结束得越晚越优先"
// 排序(裁判把最终结论放最后;围栏内的过期草稿不得压过其后的修订)。候选源:① 代码围栏块;② 首个 {/[ 到末个 }/]
// 的外层切片;③ 平衡括号扫描(行首首个+末3个,外加全文末3个 {/[ 以支持行内 JSON)。③ 有两道 P1 护栏:包含过滤
// (被更外层候选完全包含的是子对象,提为整体会翻转裁决,如把 findings[0] 的 pass 当整体 verdict)与截断护栏(最外
// 层行首起点未配平 = 输出被截断,内层子块全部放弃,交上层判失败/provider 修复层处理——它能看到全文)。调用方逐候选
// 先原文 JSON.parse、失败再 repairJson 后 parse,首个成功即返回(见 parseStructuredAgentOutput)。
function structuredJsonCandidates(s) {
  const cands = []; const seen = new Set();                                // {text,end}: end=候选在原文中的结束偏移(排序用)
  const push = (v, end) => { const t = String(v || '').trim(); if (t && !seen.has(t)) { seen.add(t); cands.push({ text: t, end }); } };
  const re = /```(?:json)?\s*([\s\S]*?)```/gi; let m;                      // ① 围栏块(字符串值内含 ``` 时会被截碎,仅作候选之一)
  while ((m = re.exec(s)) !== null) { const b = (m[1] || '').trim(); if (b) push(b, m.index + m[0].length); }
  const opens = [s.indexOf('{'), s.indexOf('[')].filter(i => i >= 0);      // ② 外层 {…} / […] 切片
  const start = opens.length ? Math.min(...opens) : -1;
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (start >= 0 && end > start) push(s.slice(start, end + 1), end + 1);
  const lineStarts = [];                                                   // ③ 平衡扫描起点:行首(首个+末3) ∪ 全文末3个 {/[
  { let idx = 0; for (const line of s.split('\n')) { const trimmed = line.replace(/^\s+/, ''); if (trimmed[0] === '{' || trimmed[0] === '[') lineStarts.push(idx + (line.length - trimmed.length)); idx += line.length + 1; } }
  const tailOpens = []; for (let i = s.length - 1; i >= 0 && tailOpens.length < 3; i--) { if (s[i] === '{' || s[i] === '[') tailOpens.push(i); }
  const scanStarts = [...new Set([lineStarts[0], ...lineStarts.slice(-3), ...tailOpens])].filter(p => p != null).sort((a, b) => a - b);
  const spans = []; for (const p of scanStarts) { const t = balancedJsonSpan(s, p); if (t) spans.push({ p, t }); }
  const truncatedOuter = lineStarts.length > 0 && !spans.some(a => a.p === lineStarts[0]);   // 最外层行首未配平 → 输出被截断
  for (const a of spans) {
    if (truncatedOuter && a.p > lineStarts[0]) continue;                   // 截断护栏(P1):内层子块绝不提为整体结果
    const contained = spans.some(b => b !== a && b.p <= a.p && b.p + b.t.length >= a.p + a.t.length && b.t.length > a.t.length);
    if (!contained) push(a.t, a.p + a.t.length);                           // 包含过滤(P1):子对象不作候选
  }
  cands.sort((x, y) => y.end - x.end);                                     // 末位优先(P2:最终修订 > 围栏内过期草稿)
  return cands.map(c => c.text);
}
// String-aware 平衡括号扫描：从 start 处的 {/[ 向后配平，返回平衡切片；未配平(截断)时返回 null——对抗轮 P1:
// 原先返回尾串毫无用处(repairJson 不会补括号),且掩盖了"输出被截断"这一信号,上游需要它来触发截断护栏。
function balancedJsonSpan(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}
// v1.5 (Judge JSON 修复 · 核心): 零依赖状态机，把 LLM 常见的"几乎合法"JSON 修回可解析。仅在 JSON.parse 原文失败后
// 调用(见 parseStructuredAgentOutput：合法 JSON 永远先命中原文 parse 分支，绝不进本函数，故对合法输入零误伤)。
// 四类修复：(a) 智能引号仅在结构位置(分隔符)转为 " ——字符串内容里的弯引号原样保留(对抗轮 P2:原全局替换会静默
// 改写 summary/引文内容,导致 dedupeKey 漂移);单弯引号 ‘ ’ 不再处理(' 本就不是 JSON 分隔符,替换只可能改内容)；(b) } ] 前的尾逗号剔除(仅结构位置的
// 逗号，字符串内的逗号不动)；(c) 未转义的字符串内双引号 → \"（前瞻：字符串内的一个 " 之后跳过空白若不是 , : } ]
// 或输入结束，则它是内容而非收尾，转义并保持在字符串内——精确修复 未到"fail"级别 这类故障）；(d) 字符串内的裸
// 控制符(换行/回车/制表) → 转义。幂等(修复后的合法 JSON 再进本函数原样返回)；防御(任何异常返回原串)。
function repairJson(input) {
  const original = String(input == null ? '' : input);
  try {
    const s = original;   // 对抗轮 P2: 不做全局弯引号替换;智能引号在下方状态机内按结构位置处理
    const ws = c => c === ' ' || c === '\t' || c === '\n' || c === '\r';
    const out = [];
    let inStr = false, esc = false, smartOpen = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) { out.push(c); esc = false; continue; }
        if (c === '\\') { out.push(c); esc = true; continue; }
        if (c === '"' || (smartOpen && (c === '“' || c === '”'))) {
          let j = i + 1; while (j < s.length && ws(s[j])) j++;
          const next = j < s.length ? s[j] : '';
          if (next === '' || next === ',' || next === ':' || next === '}' || next === ']') { out.push('"'); inStr = false; smartOpen = false; }
          else if (c === '"') { out.push('\\', '"'); } // 内容引号：转义并保持 inStr
          else { out.push(c); }                        // 内容位置的弯引号：原样保留(不改写字符串内容)
          continue;
        }
        if (c === '\n') { out.push('\\', 'n'); continue; }
        if (c === '\r') { out.push('\\', 'r'); continue; }
        if (c === '\t') { out.push('\\', 't'); continue; }
        out.push(c); continue;
      }
      if (c === '"' || c === '“' || c === '”') { out.push('"'); inStr = true; smartOpen = c !== '"'; continue; }
      if (c === ',') {
        let j = i + 1; while (j < s.length && ws(s[j])) j++;
        const next = j < s.length ? s[j] : '';
        if (next === '}' || next === ']') continue; // 剔除尾逗号
        out.push(c); continue;
      }
      out.push(c);
    }
    return out.join('');
  } catch { return original; }
}
// v1.5 (Judge JSON 修复 · 核心): 多候选 + 两级(原文/修复)解析。合法 JSON 永远命中"原文 parse"分支，绝不进
// repairJson，故对合法输入零误伤。签名/返回形状保持不变({ ok, value } | { ok:false, error })。
function parseStructuredAgentOutput(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return { ok: false, error: '输出不是有效 JSON' };
  // Exact JSON may legitimately be a primitive when the caller supplied a primitive outputSchema
  // (for example {type:'integer'} for a counting probe). The older candidate scanner deliberately
  // accepts only object/array slices from mixed prose, but that also rejected a perfectly clean `127`.
  // Accept the whole payload first; embedded candidates below stay object/array-only so prose cannot
  // accidentally promote a stray number/string to the node's structured result.
  try { return { ok: true, value: JSON.parse(s) }; } catch { /* try bounded object/array recovery below */ }
  const accept = v => v !== null && typeof v === 'object';
  for (const cand of structuredJsonCandidates(s)) {
    try { const v = JSON.parse(cand); if (accept(v)) return { ok: true, value: v }; } catch { /* try repair below */ }
    try { const r = repairJson(cand); if (r && r !== cand) { const v = JSON.parse(r); if (accept(v)) return { ok: true, value: v }; } } catch { /* next candidate */ }
  }
  return { ok: false, error: '输出不是有效 JSON' };
}
function validateAgentJsonSchema(value, schema, path0 = '$') {
  const errors = [];
  const walk = (v, s, p, depth) => {
    if (!s || typeof s !== 'object' || depth > 24) return;
    if (Array.isArray(s.enum) && !s.enum.some(x => JSON.stringify(x) === JSON.stringify(v))) errors.push(`${p} 不在 enum 中`);
    if (Object.prototype.hasOwnProperty.call(s, 'const') && JSON.stringify(v) !== JSON.stringify(s.const)) errors.push(`${p} 不等于 const`);
    const type = Array.isArray(s.type) ? s.type : (s.type ? [s.type] : []);
    const matches = t => t === 'null' ? v === null : t === 'array' ? Array.isArray(v) : t === 'object' ? !!v && typeof v === 'object' && !Array.isArray(v) : t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === t;
    if (type.length && !type.some(matches)) { errors.push(`${p} 类型应为 ${type.join('|')}`); return; }
    if (typeof v === 'string') {
      if (Number.isFinite(s.minLength) && v.length < s.minLength) errors.push(`${p} 长度小于 ${s.minLength}`);
      if (Number.isFinite(s.maxLength) && v.length > s.maxLength) errors.push(`${p} 长度大于 ${s.maxLength}`);
      if (s.pattern) { try { if (!(new RegExp(s.pattern)).test(v)) errors.push(`${p} 不匹配 pattern`); } catch { errors.push(`${p} schema.pattern 无效`); } }
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (Number.isFinite(s.minimum) && v < s.minimum) errors.push(`${p} 小于 minimum`);
      if (Number.isFinite(s.maximum) && v > s.maximum) errors.push(`${p} 大于 maximum`);
    }
    if (Array.isArray(v)) {
      if (Number.isFinite(s.minItems) && v.length < s.minItems) errors.push(`${p} 项数小于 ${s.minItems}`);
      if (Number.isFinite(s.maxItems) && v.length > s.maxItems) errors.push(`${p} 项数大于 ${s.maxItems}`);
      if (s.uniqueItems === true) {
        const seen = new Set();
        for (const item of v) {
          let key;
          try { key = JSON.stringify(item); } catch { errors.push(`${p} 包含不可序列化项`); continue; }
          if (seen.has(key)) { errors.push(`${p} 存在重复项`); break; }
          seen.add(key);
        }
      }
      if (s.items) v.forEach((item, i) => walk(item, s.items, `${p}[${i}]`, depth + 1));
    } else if (v && typeof v === 'object') {
      const props = s.properties && typeof s.properties === 'object' ? s.properties : {};
      for (const k of (Array.isArray(s.required) ? s.required : [])) if (!Object.prototype.hasOwnProperty.call(v, k)) errors.push(`${p}.${k} 缺失`);
      for (const [k, item] of Object.entries(v)) {
        if (Object.prototype.hasOwnProperty.call(props, k)) walk(item, props[k], `${p}.${k}`, depth + 1);
        else if (s.additionalProperties === false) errors.push(`${p}.${k} 不允许`);
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(item, s.additionalProperties, `${p}.${k}`, depth + 1);
      }
    }
  };
  walk(value, schema, path0, 0); return { ok: errors.length === 0, errors: errors.slice(0, 50) };
}
function normalizeAgentGate(raw, roleId) {
  // 对抗轮 P2: 显式 false = 用户在编辑器选了"无质量门",必须持久化为 false(而非 null)——否则下次 normalize(加载/
  // launch 再清洗)时 reviewer/verifier 的 autoMode 又会强制回填 review/verify 门,"无"选项形同虚设。服务端所有
  // node.gate 消费点均为 truthy 判断,false 与无门等价;null/缺省仍走角色自动门(内置模板依赖此默认)。
  if (raw === false) return false;
  const autoMode = roleId === 'reviewer' ? 'review' : (roleId === 'verifier' ? 'verify' : '');
  if (!raw && !autoMode) return null;
  const obj = raw === true || !raw ? {} : (typeof raw === 'object' ? raw : { mode: raw });
  const allowed = ['review', 'verify', 'vote', 'cross_review', 'dedupe', 'coverage', 'propagate'];
  const mode = allowed.includes(obj.mode) ? obj.mode : (autoMode || 'review');
  // R1/M3/M2: preserve machine-gate configuration while clamping all numeric thresholds.
  const clamp01 = (value, fallback) => { const n = Number(value); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback; };
  const inputSet = Array.isArray(obj.inputSet) ? [...new Set(obj.inputSet.map(x => String(x == null ? '' : x).trim()).filter(Boolean))].slice(0, 10000) : [];
  return {
    mode,
    threshold: clamp01(obj.threshold != null ? obj.threshold : 0.5, 0.5),
    minApprovals: Math.max(1, Math.min(32, Math.round(Number(obj.minApprovals) || 1))),
    minConfidence: clamp01(obj.minConfidence != null ? obj.minConfidence : 0.5, 0.5),
    abstainThreshold: clamp01(obj.abstainThreshold != null ? obj.abstainThreshold : 0, 0),
    requireEvidence: obj.requireEvidence === true,
    allowPartialCoverage: obj.allowPartialCoverage === true,
    allowPartial: obj.allowPartial === true,
    inputSet,
    propagateKey: String(obj.propagateKey || '').trim().slice(0, 200),
  };
}
function verdictPasses(value, gate) {
  const verdict = String(value && value.verdict || '').toLowerCase();
  const confidence = Math.min(1, Math.max(0, Number(value && value.confidence) || 0));
  return { pass: ['pass', 'passed', 'approve', 'approved', 'accept', 'accepted', 'verified', 'yes'].includes(verdict) && confidence >= gate.minConfidence, verdict, confidence };
}
function structuredOfNode(node) {
  if (node && node.structuredResult !== undefined && node.structuredResult !== null) return node.structuredResult;
  const parsed = parseStructuredAgentOutput(node && node.result); return parsed.ok ? parsed.value : null;
}
function aggregateAgentVote(dependencies, gate) {
  const positive = new Set(['pass', 'passed', 'approve', 'approved', 'accept', 'accepted', 'verified', 'yes']);
  const negative = new Set(['fail', 'failed', 'reject', 'rejected', 'no']);
  const abstain = new Set(['uncertain', 'abstain', 'unknown']);
  const abstainThreshold = Math.min(1, Math.max(0, Number(gate && gate.abstainThreshold) || 0));
  const votes = dependencies.map(n => {
    const v = structuredOfNode(n);
    const verdict = String(v && v.verdict || '').toLowerCase();
    const rawConfidence = v && v.confidence;
    const confidence = Number(rawConfidence);
    const verdictValid = positive.has(verdict) || negative.has(verdict) || abstain.has(verdict);
    const confidenceValid = typeof rawConfidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
    const valid = verdictValid && confidenceValid;
    const demoted = valid && negative.has(verdict) && confidence < abstainThreshold;
    const abstained = valid && (abstain.has(verdict) || demoted);
    return { id: n.id, verdict: verdict || 'missing', confidence: confidenceValid ? confidence : null, approve: valid && positive.has(verdict), reject: valid && negative.has(verdict) && !demoted, abstained, valid, reason: !verdictValid ? 'missing_or_invalid_verdict' : (!confidenceValid ? 'missing_or_invalid_confidence' : (demoted ? 'low_confidence_demoted' : '')) };
  });
  const approvals = votes.filter(v => v.approve).length; const rejections = votes.filter(v => v.reject).length;
  const invalidVotes = votes.filter(v => !v.valid).map(v => ({ id: v.id, reason: v.reason }));
  const validVotes = votes.filter(v => v.valid);
  const decided = approvals + rejections; const score = decided ? approvals / decided : 0; const confidence = validVotes.length ? validVotes.reduce((a, v) => a + v.confidence, 0) / validVotes.length : 0;
  const contractValid = invalidVotes.length === 0 && dependencies.length >= gate.minApprovals;
  const pass = contractValid && approvals >= gate.minApprovals && score >= gate.threshold && confidence >= gate.minConfidence;
  const summary = !contractValid
    ? `投票输入契约无效: ${invalidVotes.length ? invalidVotes.map(v => v.id).join(', ') + ' 缺少有效 verdict/confidence' : `仅 ${dependencies.length} 个投票节点，少于 minApprovals=${gate.minApprovals}`}`
    : `${approvals}/${votes.length} 票赞成，得分 ${score.toFixed(2)}`;
  return { verdict: contractValid ? (pass ? 'pass' : 'fail') : 'invalid', confidence, summary, score, approvals, rejections, abstentions: votes.filter(v => v.abstained).length, contractValid, invalidVotes, votes };
}
function findingHandledItems(data) {
  const out = [];
  if (Array.isArray(data && data.handledItems)) out.push(...data.handledItems);
  for (const field of ['findings', 'claims']) {
    for (const item of (Array.isArray(data && data[field]) ? data[field] : [])) {
      if (Array.isArray(item && item.evidenceRefs)) out.push(...item.evidenceRefs);
      if (Array.isArray(item && item.handledItems)) out.push(...item.handledItems);
    }
  }
  return out.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
}
function aggregateCoverage(dependencies, gate) {
  const inputSet = [...new Set((Array.isArray(gate && gate.inputSet) ? gate.inputSet : []).map(x => String(x == null ? '' : x).trim()).filter(Boolean))];
  const handledSet = new Set();
  for (const dep of dependencies) for (const item of findingHandledItems(structuredOfNode(dep))) handledSet.add(item);
  const handledItems = inputSet.filter(item => handledSet.has(item));
  const unhandled = inputSet.filter(item => !handledSet.has(item));
  const total = inputSet.length; const handled = handledItems.length; const coverageRatio = total ? handled / total : 1;
  return { verdict: unhandled.length ? 'fail' : 'pass', confidence: 1, summary: unhandled.length ? `仍有 ${unhandled.length} 项未覆盖` : `已覆盖全部 ${total} 项`, total, handled, handledItems, unhandled, coverageRatio };
}
function propagateAssignments(dependencies, gate) {
  const propagateKey = String(gate && gate.propagateKey || '').trim();
  const assignments = Object.create(null); const itemKeys = new Map(); const keyValues = new Map(); const edges = new Map();
  for (const dep of dependencies) {
    const data = structuredOfNode(dep);
    if (!data || typeof data !== 'object') continue;
    const source = data.assignments && typeof data.assignments === 'object' && !Array.isArray(data.assignments) ? data.assignments : {};
    for (const [item, value] of Object.entries(source)) if (value !== undefined && value !== null && value !== '') assignments[item] = value;
    const records = Array.isArray(data.items) ? data.items : [];
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const id = String(record.id != null ? record.id : (record.item != null ? record.item : '')).trim();
      if (!id) continue;
      const key = propagateKey ? record[propagateKey] : undefined;
      if (key !== undefined && key !== null && key !== '') itemKeys.set(id, String(key));
      const value = record.assignment !== undefined ? record.assignment : record.value;
      if (value !== undefined && value !== null && value !== '') assignments[id] = value;
    }
    const rawEdges = Array.isArray(data.propagationEdges) ? data.propagationEdges : (Array.isArray(data.edges) ? data.edges : []);
    for (const edge of rawEdges) {
      const from = String(edge && (edge.from != null ? edge.from : edge.source) || '').trim();
      const to = String(edge && (edge.to != null ? edge.to : edge.target) || '').trim();
      if (!from || !to) continue;
      if (!edges.has(from)) edges.set(from, new Set()); edges.get(from).add(to);
    }
  }
  for (const [item, key] of itemKeys) if (Object.prototype.hasOwnProperty.call(assignments, item) && !keyValues.has(key)) keyValues.set(key, assignments[item]);
  for (const [item, key] of itemKeys) if (!Object.prototype.hasOwnProperty.call(assignments, item) && keyValues.has(key)) assignments[item] = keyValues.get(key);
  const visiting = new Set(); const visited = new Set(); let cycle = false;
  const visit = id => { if (visiting.has(id)) { cycle = true; return; } if (visited.has(id)) return; visiting.add(id); for (const to of (edges.get(id) || [])) visit(to); visiting.delete(id); visited.add(id); };
  for (const id of edges.keys()) visit(id);
  if (!cycle) {
    let changed = true;
    while (changed) { changed = false; for (const [from, targets] of edges) if (Object.prototype.hasOwnProperty.call(assignments, from)) for (const to of targets) if (!Object.prototype.hasOwnProperty.call(assignments, to)) { assignments[to] = assignments[from]; changed = true; } }
  }
  const expected = new Set([...itemKeys.keys(), ...edges.keys(), ...[...edges.values()].flatMap(x => [...x])]);
  const unpropagated = [...expected].filter(item => !Object.prototype.hasOwnProperty.call(assignments, item));
  return { verdict: cycle ? 'invalid' : (unpropagated.length ? 'fail' : 'pass'), confidence: 1, summary: cycle ? '传播依赖边存在环' : (unpropagated.length ? `仍有 ${unpropagated.length} 项未传播` : `已传播 ${Object.keys(assignments).length} 项`), assignments: { ...assignments }, unpropagated, propagateKey, cycle };
}
function dedupeAgentFindings(dependencies) {
  const map = new Map();
  for (const dep of dependencies) {
    const data = structuredOfNode(dep); const items = Array.isArray(data) ? data : (Array.isArray(data && data.findings) ? data.findings : (Array.isArray(data && data.items) ? data.items : []));
    for (const raw of items) {
      const item = raw && typeof raw === 'object' ? raw : { text: String(raw || '') };
      const key = String(item.dedupeKey || [item.file || '', item.line || '', item.title || item.message || item.text || JSON.stringify(item)].join('|')).toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key) continue; const old = map.get(key); if (!old || Number(item.confidence || 0) > Number(old.confidence || 0)) map.set(key, { ...item, sources: [...new Set([...(old && old.sources || []), dep.id])] }); else old.sources = [...new Set([...(old.sources || []), dep.id])];
    }
  }
  const findings = [...map.values()]; const confidence = findings.length ? findings.reduce((a, x) => a + Math.min(1, Math.max(0, Number(x.confidence) || 0)), 0) / findings.length : 1;
  return { verdict: 'pass', confidence, summary: `去重后 ${findings.length} 项`, findings };
}

module.exports = { sanitizeAgentOutputSchema, structuredJsonCandidates, balancedJsonSpan, repairJson, parseStructuredAgentOutput, validateAgentJsonSchema, normalizeAgentGate, verdictPasses, structuredOfNode, aggregateAgentVote, findingHandledItems, aggregateCoverage, propagateAssignments, dedupeAgentFindings, EVIDENCE_REFS_MAX_ITEMS, QUALITY_GATE_OUTPUT_SCHEMA };
