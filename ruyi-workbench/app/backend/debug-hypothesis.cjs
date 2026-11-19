'use strict';
function debugHypStats(ledger) {
  const hyps = Array.isArray(ledger && ledger.hypotheses) ? ledger.hypotheses : [];
  const stats = { total: hyps.length, pending: 0, refuted: 0, supported: 0, confirmed: 0 };
  for (const h of hyps) if (stats[h.status] !== undefined) stats[h.status] += 1;
  return stats;
}
// 机器警示(非 LLM 判断):重复实验(同 supports/refutes 结论 >=2 次)+ 矛盾证据(supports 与 refutes 并存)。
// inconclusive 不算重复(重试后仍无结论是正常调试,不是 loop)。
function debugHypWarnings(ledger) {
  const hyps = Array.isArray(ledger && ledger.hypotheses) ? ledger.hypotheses : [];
  const dup = [];
  const contra = [];
  for (const h of hyps) {
    const counts = { supports: 0, refutes: 0, inconclusive: 0 };
    for (const t of (h.tests || [])) if (counts[t.result] !== undefined) counts[t.result] += 1;
    // 被修剪掉的旧实验(见 debugHypTrimTests)仍计入,否则 50 条以上的实验会让重复/矛盾告警失真。
    if (h.trimmedCounts) for (const k of Object.keys(counts)) counts[k] += Number(h.trimmedCounts[k]) || 0;
    if (counts.supports >= 2) dup.push(h.id + '(supports x' + counts.supports + ')');
    if (counts.refutes >= 2) dup.push(h.id + '(refutes x' + counts.refutes + ')');
    if (counts.supports >= 1 && counts.refutes >= 1) contra.push(h.id);
  }
  const out = {};
  if (dup.length) out.duplicateWarning = '重复实验: ' + dup.join(', ') + '——同一结论已验证多次,请换策略';
  if (contra.length) out.contradictionWarning = '矛盾证据: ' + contra.join(', ') + '——同一假设既有支持又有证伪,请复核实验或拆分假设';
  return out;
}
// 单个假设的实验记录上限:台账由模型每轮原样传回,必须有界。修前超过 50 条时【最新】的悄悄被切掉(slice(0,50)),
// 且之后的计数、重复/矛盾告警都按被切后的算 —— 现在保留最早 10 条 + 最近 40 条,中间的折进 trimmedCounts / trimmedTests,
// testCount 始终是真实总数,并在结果里明说发生过修剪。
const DEBUG_HYP_MAX_TESTS = 50;
const DEBUG_HYP_KEEP_HEAD = 10;
function debugHypTrimTests(h) {
  if (h.tests.length <= DEBUG_HYP_MAX_TESTS) return;
  const drop = h.tests.splice(DEBUG_HYP_KEEP_HEAD, h.tests.length - DEBUG_HYP_MAX_TESTS);
  const tc = h.trimmedCounts || { supports: 0, refutes: 0, inconclusive: 0 };
  for (const t of drop) if (tc[t.result] !== undefined) tc[t.result] += 1;
  h.trimmedCounts = tc;
  h.trimmedTests = (h.trimmedTests || 0) + drop.length;
}
function debugHypothesis(args = {}) {
  const action = String(args.action || '');
  if (!['init', 'test', 'conclude', 'reopen', 'status'].includes(action)) {
    return { ok: false, error: 'action 非法: ' + action + '(仅 init|test|conclude|reopen|status)' };
  }
  const normHyp = (h, i, idOverride) => {
    const hh = h && typeof h === 'object' ? h : {};
    const id = idOverride || String(hh.id || ('H' + (i + 1))).trim().slice(0, 64);
    const description = String(hh.description || '').trim().slice(0, 500);
    if (!description) return null;
    return {
      id, description,
      mechanism: String(hh.mechanism || '').trim().slice(0, 500),
      expectedEvidence: String(hh.expectedEvidence || '').trim().slice(0, 500),
      verification: String(hh.verification || '').trim().slice(0, 500),
      status: 'pending', tests: [],
    };
  };
  if (action === 'init') {
    const allHyps = Array.isArray(args.hypotheses) ? args.hypotheses : [];
    const hyps = allHyps.slice(0, 50);
    const dropped = allHyps.length - hyps.length;
    // id 必须唯一(test/conclude 按 id 找第一个,重复的那个永远够不着)。显式给的 id 先占位(先到先得),
    // 缺 id 的按 H<序号> 往后找没被占的;显式 id 重复的第二个起改名。修前 [{id:'H2',…},{description:…}] 会出两个 H2。
    const used = new Set();
    const entries = hyps.map(h => {
      const hh = h && typeof h === 'object' ? h : {};
      return { h: hh, explicit: String(hh.id || '').trim().slice(0, 64), valid: String(hh.description || '').trim() !== '', id: '' };
    });
    for (const e of entries) if (e.valid && e.explicit && !used.has(e.explicit)) { used.add(e.explicit); e.id = e.explicit; }
    const renamed = [];
    entries.forEach((e, i) => {
      if (!e.valid || e.id) return;
      let n = i + 1;
      while (used.has('H' + n)) n += 1;
      e.id = 'H' + n;
      used.add(e.id);
      if (e.explicit) renamed.push({ from: e.explicit, to: e.id });
    });
    const hypotheses = entries.filter(e => e.valid).map(e => normHyp(e.h, 0, e.id));
    if (!hypotheses.length) return { ok: false, error: 'init 需要至少一个假设(hypotheses 数组,每项至少含 description)' };
    const ledger = { hypotheses, concluded: null };
    const warnings = [];
    if (dropped > 0) warnings.push(`hypotheses 超过 50 个,只登记了前 50 个,丢掉了 ${dropped} 个;请合并同类假设`);
    if (renamed.length) warnings.push('重复的假设 id 已改名: ' + renamed.map(r => r.from + ' -> ' + r.to).join(', '));
    const noDesc = hyps.length - hypotheses.length;
    if (noDesc > 0) warnings.push(`有 ${noDesc} 项缺少 description,已忽略`);
    return { ok: true, ledger, stats: debugHypStats(ledger), ...(renamed.length ? { renamed } : {}), ...(warnings.length ? { warning: warnings.join(';') } : {}) };
  }
  const ledger = args.ledger && typeof args.ledger === 'object' ? args.ledger : null;
  if (!ledger || !Array.isArray(ledger.hypotheses)) {
    return { ok: false, error: '缺少台账(ledger);请先用 action=init 创建,并在后续每轮把上一轮返回的 ledger 原样传回' };
  }
  // 重入 ledger 归一化 + 上限(对抗加固):浅拷贝(不原地改入参)+ hypotheses<=50 + 每条 tests<=50 + 非法 status 回落 pending。
  const ledger2 = {
    hypotheses: ledger.hypotheses.slice(0, 50).map(h => ({
      id: String(h && h.id || '').trim().slice(0, 64),
      description: String(h && h.description || '').trim().slice(0, 500),
      // NE-14:重入时保留 init 写下的 mechanism / expectedEvidence / verification(修前每次 test 之后这三项就没了)。
      mechanism: String(h && h.mechanism || '').trim().slice(0, 500),
      expectedEvidence: String(h && h.expectedEvidence || '').trim().slice(0, 500),
      verification: String(h && h.verification || '').trim().slice(0, 500),
      status: ['pending', 'supported', 'refuted', 'confirmed'].includes(h && h.status) ? h.status : 'pending',
      tests: Array.isArray(h && h.tests) ? h.tests.map(t => ({ result: ['supports', 'refutes', 'inconclusive'].includes(t && t.result) ? t.result : 'inconclusive', evidence: String(t && t.evidence || '').trim().slice(0, 2000) })) : [],
      // 上一轮修剪留下的账(见 debugHypTrimTests),原样带回。
      ...(Number(h && h.trimmedTests) > 0 ? { trimmedTests: Math.floor(Number(h.trimmedTests)), trimmedCounts: { supports: Number(h.trimmedCounts && h.trimmedCounts.supports) || 0, refutes: Number(h.trimmedCounts && h.trimmedCounts.refutes) || 0, inconclusive: Number(h.trimmedCounts && h.trimmedCounts.inconclusive) || 0 } } : {}),
    })).filter(h => h.id && h.description),
    concluded: ledger.concluded || null,
  };
  for (const h of ledger2.hypotheses) { debugHypTrimTests(h); h.testCount = h.tests.length + (h.trimmedTests || 0); }
  const trimNote = () => {
    const t = ledger2.hypotheses.filter(h => h.trimmedTests > 0);
    return t.length ? { testsTrimmedWarning: '实验记录过多已修剪(保留最早 10 条 + 最近 40 条,中间的只保留计数): ' + t.map(h => `${h.id} 共 ${h.testCount} 条,已修剪 ${h.trimmedTests} 条`).join(', ') } : {};
  };
  if (action === 'status') {
    return { ok: true, ledger: ledger2, stats: debugHypStats(ledger2), ...debugHypWarnings(ledger2), ...trimNote() };
  }
  // reopen:conclude 之前不可逆 —— 结论下错了没有出路。解锁后被锁定的假设回到 supported(它曾有支持证据),可以继续 test / 改判。
  if (action === 'reopen') {
    if (!ledger2.concluded) return { ok: false, error: '当前没有已锁定的根因,无需 reopen' };
    const wanted = String(args.hypothesisId || '').trim();
    if (wanted && wanted !== ledger2.concluded) return { ok: false, error: '已锁定的根因是 ' + ledger2.concluded + ',不是 ' + wanted };
    const was = ledger2.concluded;
    const locked = ledger2.hypotheses.find(h => h.id === was);
    if (locked && locked.status === 'confirmed') locked.status = 'supported';
    ledger2.concluded = null;
    return { ok: true, ledger: ledger2, reopened: was, stats: debugHypStats(ledger2), ...debugHypWarnings(ledger2), ...trimNote() };
  }
  const hid = String(args.hypothesisId || '').trim();
  if (!hid) return { ok: false, error: 'hypothesisId 不能为空' };
  const hyp = ledger2.hypotheses.find(h => h.id === hid);
  if (!hyp) return { ok: false, error: '假设不存在: ' + hid + '(ledger 里的 id: ' + ledger2.hypotheses.map(h => h.id).join(', ') + ')' };
  if (action === 'test') {
    const result = ['supports', 'refutes', 'inconclusive'].includes(args.result) ? args.result : null;
    if (!result) return { ok: false, error: 'result 非法: ' + String(args.result) + '(仅 supports|refutes|inconclusive)' };
    if (hyp.status === 'confirmed') return { ok: false, error: '假设 ' + hid + ' 已锁定为根因(confirmed),不能再实验;结论要改请先 action=reopen' };
    // 根因已锁定后,再给【别的】假设记「支持」证据会让台账自相矛盾(两个假设都像根因);排除其余假设(refutes/inconclusive)仍允许 —— 那正是 earlyStopWarning 要求的收尾动作。
    if (ledger2.concluded && result === 'supports') {
      return { ok: false, error: '根因已锁定为 ' + ledger2.concluded + ',不能再为 ' + hid + ' 记录支持证据;如要改判请先 action=reopen 解除锁定' };
    }
    if (result === 'supports' && hyp.status === 'refuted') {
      return { ok: false, error: '假设 ' + hid + ' 已被证伪(refuted),支持证据不能使其复活;如结论变化请拆分为新假设' };
    }
    hyp.tests.push({ result, evidence: String(args.evidence || '').trim().slice(0, 2000) });
    debugHypTrimTests(hyp);
    hyp.testCount = hyp.tests.length + (hyp.trimmedTests || 0);
    if (result === 'refutes') hyp.status = 'refuted';
    else if (result === 'supports') hyp.status = 'supported';
    // inconclusive 保持原状态(pending/supported 不变)
    return { ok: true, ledger: ledger2, hypothesis: { id: hyp.id, status: hyp.status, testCount: hyp.testCount }, stats: debugHypStats(ledger2), ...debugHypWarnings(ledger2), ...trimNote() };
  }
  if (action === 'conclude') {
    if (ledger2.concluded) return { ok: false, error: '已锁定根因 ' + ledger2.concluded + ',不能重复 conclude;要改判请先 action=reopen' };
    if (hyp.status !== 'supported') {
      return { ok: false, error: '假设 ' + hid + ' 状态为 ' + hyp.status + ',不能 conclude(仅 supported 且未被证伪的假设可锁定为根因)' };
    }
    const hasSupport = (hyp.tests || []).some(t => t.result === 'supports');
    if (!hasSupport) return { ok: false, error: '假设 ' + hid + ' 无支持证据,不能 conclude' };
    hyp.status = 'confirmed';
    ledger2.concluded = hid;
    // 未排除 = 既未证伪也未确认的假设(pending + supported 竞争项)。
    const unexcluded = ledger2.hypotheses.filter(h => h.status !== 'refuted' && h.status !== 'confirmed');
    const resp = { ok: true, ledger: ledger2, rootCause: hid, stats: debugHypStats(ledger2) };
    if (unexcluded.length) {
      resp.earlyStopWarning = '仍有 ' + unexcluded.length + ' 个假设未排除: ' + unexcluded.map(h => h.id).join(', ');
      resp.pendingHypotheses = unexcluded.map(h => h.id);
    }
    return resp;
  }
  return { ok: false, error: 'unreachable action' };
}

// ============================================================================
// v2.6 (M5 候选 D 波 #3): data_profile — 数据画像摘要(行数/分布/缺失/异常值机器统计,替代 LLM 目测)。
// 对症 07 §1「方法论只写在 prompt 里」:数据画像的结构性统计(规模/类型/缺失率/唯一值/离群点)交给
// 确定性算法,LLM 只做语义判断。纯 JS、零依赖;CSV 用简单状态机解析(处理引号内分隔符/换行/"" 转义),
// 不承诺兼容所有方言(诚实标注 note)。采样 maxRows 行(默认 2000),大文件不整读。

module.exports = { debugHypothesis };
