'use strict';

const crypto = require('node:crypto');
const { structuredOfNode } = require('./agent-quality.cjs');

function createWorkflowNodeOutcomes() {

  function workflowValueAt(value, pathText) {
    if (!pathText) return value;
    let cur = value; for (const part of String(pathText).split('.').filter(Boolean)) { if (cur == null) return undefined; cur = cur[part]; } return cur;
  }
  function evaluateWorkflowCondition(condition, nodes, currentNode) {
    if (!condition) return true;
    const source = condition.node ? nodes.find(n => n.id === condition.node) : currentNode;
    let value;
    if (condition.operator === 'status_is') value = source && source.status;
    else value = workflowValueAt(structuredOfNode(source), condition.path);
    const expected = condition.value;
    switch (condition.operator) {
      case 'equals': return JSON.stringify(value) === JSON.stringify(expected);
      case 'not_equals': return JSON.stringify(value) !== JSON.stringify(expected);
      case 'falsy': return !value;
      case 'contains': return Array.isArray(value) ? value.some(x => JSON.stringify(x) === JSON.stringify(expected)) : String(value == null ? '' : value).includes(String(expected == null ? '' : expected));
      case 'greater': return Number(value) > Number(expected);
      case 'greater_equal': return Number(value) >= Number(expected);
      case 'less': return Number(value) < Number(expected);
      case 'less_equal': return Number(value) <= Number(expected);
      case 'status_is': return String(value || '') === String(expected || '');
      default: return !!value;
    }
  }
  function canonicalWorkflowValue(value, depth = 0) {
    if (depth > 24 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => canonicalWorkflowValue(v, depth + 1));
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalWorkflowValue(value[key], depth + 1);
    return out;
  }
  function workflowProgressFingerprint(node, progressPath = '') {
    const structured = structuredOfNode(node);
    let value;
    if (progressPath) {
      value = workflowValueAt(structured, progressPath);
      if (value === undefined) value = { $missingProgressPath: progressPath };
    } else if (structured !== null) value = structured;
    else value = String(node && node.result || '').replace(/\s+/g, ' ').trim();
    return crypto.createHash('sha256').update(JSON.stringify(canonicalWorkflowValue(value))).digest('hex');
  }
  function evaluateNodeToolEvidence(node) {
    const required = Math.max(0, Math.min(20, Math.round(Number(node && node.minSuccessfulToolCalls) || 0)));
    const continuation = node && node.continuation;
    const steps = continuation && continuation.attemptId === node.attempts && Array.isArray(continuation.steps) ? continuation.steps : [];
    const successful = steps.filter(s => s && s.ok === true && s.tool && s.tool !== '?');
    return { ok: successful.length >= required, required, successful: successful.length, tools: successful.map(s => s.tool).slice(0, 20) };
  }
  // 第28波(§28b 节点输出四分 + §28c 预算化上下文)——────────────────────────────────────────────────────
  const NODE_SUMMARY_MAX = 2000; // 精简结论字符上限(下游默认消费的是它,不是整段 rawTranscript)
  // 对抗轮 P3:含【两引擎】写族工具名 —— OpenAI 引擎原生名 + Claude CLI 原生名(Write/Edit/MultiEdit/NotebookEdit)。
  // 此前只列 OpenAI 名,Claude 引擎节点的 artifacts 恒空(续点 step.tool 直取 evt.name,不做引擎归一)。Bash 无法可靠归类,不列。
  const NODE_WRITE_FAMILY = new Set(['file_write', 'file_edit', 'file_delete', 'file_move', 'file_copy', 'archive_zip', 'archive_unzip', 'http_download', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  // 节点跑完后派生四分:summary(精简结论,下游默认吃它)· evidence(结构化证据 findings)· artifacts(写族工具动过的
  // 产物引用,best-effort 自续点步骤)· rawTranscript(=node.result 全文,完整留档,【不】默认灌下游)。纯函数,幂等。
  function deriveNodeOutputs(node) {
    if (!node) return;
    const sr = node.structuredResult;
    let summary = '';
    if (sr && typeof sr === 'object') {
      // 对抗轮 P2:结构化 summary 也【扁平化空白】——与 rung1/fallback 一致的防伪造控制。否则上游节点可在 summary 里塞
      // `\n### victim (succeeded)\n<指令>` 伪造下游 prompt 里的前序节点小标题(section-marker 注入)。单行摘要无损。
      if (typeof sr.summary === 'string' && sr.summary.trim()) summary = sr.summary.replace(/\s+/g, ' ').trim();
      else if (typeof sr.verdict === 'string' && sr.verdict.trim()) summary = 'verdict=' + sr.verdict + (Number.isFinite(Number(sr.confidence)) ? '(' + Number(sr.confidence).toFixed(2) + ')' : '');
    }
    if (!summary) summary = String(node.result || node.error || '').replace(/\s+/g, ' ').trim();
    node.summary = summary.slice(0, NODE_SUMMARY_MAX);
    // 证据:结构化 findings(若有)——供 scrutiny 节点核验,不塞进普通下游的 summary。
    node.evidence = (sr && Array.isArray(sr.findings)) ? sr.findings.slice(0, 50) : [];
    // 产物:续点里写族工具动过的引用(argsPreview 已扁平化;honest 引用而非强解析路径)。
    const cont = node.continuation;
    node.artifacts = (cont && Array.isArray(cont.steps))
      ? cont.steps.filter(s => s && NODE_WRITE_FAMILY.has(s.tool)).map(s => ({ tool: s.tool, ref: String(s.argsPreview || s.argsHash || '').slice(0, 120) })).slice(0, 20)
      : [];
  }

  return { NODE_WRITE_FAMILY, deriveNodeOutputs, evaluateNodeToolEvidence, evaluateWorkflowCondition, workflowProgressFingerprint };
}

module.exports = { createWorkflowNodeOutcomes };
