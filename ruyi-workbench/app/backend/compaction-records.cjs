'use strict';

const { cachedInputTokensFromUsage, computeProviderCost } = require('./provider-pricing.cjs');

const COMPACT_MARKER_MIN_SAVED_TOKENS = 1200;

function createCompactionRecords({ estimateContentTokens, fmtTokensServer, appendUsageLedger, nowIso }) {
  // v1.4-OSS 用量看板(补): record a compaction summary call as an 'aux' ledger row (kind:'aux', note:'compact').
  // Tokens from the response usage (prompt/completion, with input/output aliases); when the endpoint omits usage
  // they are ESTIMATED from the sent payload + the returned summary and flagged estimated:true. Both compact call
  // sites (manual runProviderCompact + auto maybeAutoCompact level-2) route through here. Fully defensive.
  function recordCompactUsage(session, provider, sc, attribution) {
    try {
      if (!session || !provider || !sc || !sc.ok) return;
      // 代理模式 v2:子代理压缩的 aux 行带 subagentId/runId 归属(仍计入会话总费用,但看板可区分主线与代理)。
      const attr = attribution && typeof attribution === 'object' ? attribution : null;
      let inTok = 0, outTok = 0, estimated = false;
      const u = sc.usage;
      const uIn = u ? (Number(u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens) || 0) : 0;
      const uOut = u ? (Number(u.completion_tokens != null ? u.completion_tokens : u.output_tokens) || 0) : 0;
      if (uIn > 0 || uOut > 0) {
        // 45f 对抗轮 P3-4b:分项回退 —— usage 存在但某侧为 0(某些网关)时,该侧用估算补,另一侧保实测。
        inTok = uIn > 0 ? uIn : (Number(sc.promptTokensEst) || 0);
        outTok = uOut > 0 ? uOut : Math.round(estimateContentTokens(sc.summary || ''));
        estimated = (uIn <= 0 || uOut <= 0);
      } else { inTok = Number(sc.promptTokensEst) || 0; outTok = Math.round(estimateContentTokens(sc.summary || '')); estimated = true; }
      const cachedInTok = estimated ? 0 : Math.min(inTok, cachedInputTokensFromUsage(u));
      const ledgerModel = sc.model || provider.model || '';
      const { cost, currency } = computeProviderCost(provider, inTok, outTok, cachedInTok, ledgerModel);
      appendUsageLedger({
        sessionId: session.id, engine: 'openai', provider: provider.id, model: ledgerModel,
        inTok, outTok, cachedInTok, cost, currency, estimated, turnSeq: session.turnSeq, kind: 'aux', note: 'compact',
        ...(attr && attr.subagentId ? { subagentId: String(attr.subagentId) } : {}),
        ...(attr && attr.runId ? { runId: String(attr.runId) } : {}),
      });
    } catch { /* accounting must never break compaction */ }
  }

  // 尾部未闭环的压缩标记:从 messages 末尾向前找,遇 user/assistant 对话行即闭环(返回 null);
  // 其它 system 噪声行(stderr 等)不打断同一压缩集的连续性。kind 隔离:auto 与手动压缩不互相并入。
  function openCompactMarker(session, kind) {
    const msgs = Array.isArray(session && session.messages) ? session.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'user' || m.role === 'assistant') return null;
      // 旧格式标记(无 compactMeta)不可并入 —— 文案必须能由 meta 全量重建,数字才保得住诚实。
      if (m.source === 'compact' && (m.compactKind || 'auto') === kind && m.compactMeta
        && Number.isFinite(m.compactMeta.passes)) return m;
    }
    return null;
  }

  // 追加(或并入)一条压缩标记并返回该消息行(调用方可在返回值上继续挂 usage 等附加字段)。
  // 文案永远由 compactMeta 全量派生重建,历史标记(无 meta 的旧格式行)只会被当作闭环处理,不会被误改。
  //   o = { kind, label, evaporated?, reseeded?, saved?, beforeTokens?, afterTokens,
  //         approx?(默认true→'约'), accuracy?(默认'估算', 显式传空串则省略括注), note?(最新一次覆盖) }
  // beforeTokens 仅在【新建】行时生效(压缩集起点的估算值);并入已有行时保留首见起点,不回改。
  // saved 省略时由 beforeTokens-afterTokens 推导(kimi 等实测路径只带前后实测值的调用形态)。
  function upsertCompactMarker(session, o) {
    const afterTokens = Math.max(0, Math.round(Number(o.afterTokens) || 0));
    const savedExplicit = o.saved == null ? NaN : Math.max(0, Number(o.saved) || 0);
    const saved = o.reseeded ? Infinity
      : (Number.isFinite(savedExplicit) ? savedExplicit
        : Math.max(0, (Math.round(Number(o.beforeTokens) || 0)) - afterTokens));
    let marker = openCompactMarker(session, o.kind);
    if (!marker && !o.reseeded && saved < COMPACT_MARKER_MIN_SAVED_TOKENS) return null; // 零收益不造新行
    if (!marker) {
      marker = { role: 'system', content: '', createdAt: nowIso(), source: 'compact', compactKind: o.kind };
      session.messages.push(marker);
      marker.compactMeta = {
        passes: 0, evaporated: 0, reseeded: false,
        beforeTokens: Math.max(0, Math.round(Number(o.beforeTokens) || afterTokens)),
      };
    }
    const meta = marker.compactMeta;
    meta.passes += 1;
    meta.evaporated += Math.max(0, Number(o.evaporated) || 0);
    meta.reseeded = Boolean(meta.reseeded || o.reseeded);
    meta.afterTokens = afterTokens;
    const times = meta.passes > 1 ? ` ×${meta.passes}` : '';
    const ops = [];
    if (meta.evaporated > 0) ops.push(`蒸发旧工具结果 ${meta.evaporated} 条`);
    if (meta.reseeded) ops.push('摘要重播种');
    const accuracy = o.accuracy === undefined ? '估算' : o.accuracy;
    const head = `🗜 ${o.label}${times}`;
    const tail = `${fmtTokensServer(meta.beforeTokens)}→${o.approx === false ? '' : '约 '}${fmtTokensServer(afterTokens)}${accuracy ? `（${accuracy}）` : ''}`;
    marker.content = ops.length ? `${head}（${ops.join('＋')}）：${tail}` : `${head}：${tail}`;
    if (o.note) marker.content += `；${o.note}`;
    return marker;
  }

  return { recordCompactUsage, openCompactMarker, upsertCompactMarker };
}

module.exports = { createCompactionRecords, COMPACT_MARKER_MIN_SAVED_TOKENS };
