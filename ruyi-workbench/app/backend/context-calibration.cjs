'use strict';

const path = require('node:path');

function createContextCalibration({ DurableJsonStore, dataDirectory, logEvent, nowIso, estimateHistoryTokens, resolveContextWindow }) {
  // Effective context window for a provider (手动/探测/表/兜底). Never returns 0. `model` optional (解析激活模型)。
  function providerContextWindow(provider, model) {
    const resolved = resolveContextWindow(provider, model).value;
    // 45d(b):窗口超限学习 —— context-400 实测教训只降不升(42c 探针证明名义值不可信:haiku 名义 200K 实测 >217K)。
    const cap = learnedWindowCap(provider && provider.id, model);
    return cap ? Math.min(resolved, cap) : resolved;
  }

  // ── 第45波 45d:token 估算自校准 + 窗口超限学习 ─────────────────────────────────
  // 两条学习线,存 data/context-calibration.json(小 JSON,内存 Map + 异步写穿):
  //   (a) 估算因子:每次 API 调用用【真实 usage.input_tokens ÷ 发送前估算】采样,EMA(α=0.3)得每
  //       provider+model 的校准因子(clamp [0.5,3],样本 ≥3 才生效防单次异常带偏)→ 压缩触发精度从
  //       「拍脑袋常数」变「越用越准」。只用于预算判定,不改 UI 估算显示(那是对人的口径)。
  //   (b) 窗口超限学习:context 类 400 发生时的估算占用 × 0.9 记为该 provider+model 的窗口上限,
  //       只降不升(保守);providerContextWindow 单咽喉点应用。条目 ≤200(超出按插入序淘汰)。
  const CONTEXT_CALIBRATION_MAX = 200;
  const contextCalibrationStore = DurableJsonStore.create({
    id: 'context-calibration',
    file: () => path.join(dataDirectory(), 'context-calibration.json'),
    schemaVersion: 1,
    defaultValue: () => ({ schema: 1, factors: {}, windowCaps: {} }),
    sanitize(value) {
      const factors = value && value.factors && typeof value.factors === 'object' && !Array.isArray(value.factors) ? value.factors : {};
      const windowCaps = value && value.windowCaps && typeof value.windowCaps === 'object' && !Array.isArray(value.windowCaps) ? value.windowCaps : {};
      for (const [key, sample] of Object.entries(factors)) {
        if (!sample || !Number.isFinite(Number(sample.f)) || !Number.isFinite(Number(sample.n)) || Number(sample.n) < 0) delete factors[key];
        else factors[key] = { f: Math.min(3, Math.max(0.5, Number(sample.f))), n: Math.floor(Number(sample.n)) };
      }
      for (const [key, learned] of Object.entries(windowCaps)) {
        if (!learned || !Number.isFinite(Number(learned.cap)) || Number(learned.cap) <= 0) delete windowCaps[key];
        else windowCaps[key] = { cap: Math.floor(Number(learned.cap)), at: typeof learned.at === 'string' ? learned.at.slice(0, 64) : '' };
      }
      return { schema: 1, factors, windowCaps };
    },
    validate: value => value.schema === 1 && !!value.factors && !!value.windowCaps,
    capacity: [
      { path: 'factors', max: CONTEXT_CALIBRATION_MAX },
      { path: 'windowCaps', max: CONTEXT_CALIBRATION_MAX },
    ],
    onCorrupt(error) {
      try { logEvent({ kind: 'context_calibration_corrupt', error: String(error && error.message || error).slice(0, 200) }); } catch { /* ignore */ }
    },
  });
  function loadContextCalibration() {
    return contextCalibrationStore.readSync();
  }
  const _calibKey = (providerId, model) => String(providerId || '') + '/' + String(model || '');
  function persistContextCalibration() {
    // 单写者假设(45f 对抗轮 P2-2 裁决):note* 调用点全部在 serve 进程内(MCP 子进程走 HTTP loopback,
    // 不是写者);多 serve 实例共享 dataRoot 是窄面,接受互覆,不做跨进程合并。
    return contextCalibrationStore.write(loadContextCalibration()).catch(() => { /* 记账永不阻断 */ });
  }
  function noteEstimateSample(providerId, model, estimated, actual) {
    try {
      estimated = Number(estimated) || 0; actual = Number(actual) || 0;
      if (estimated < 500 || actual <= 0) return; // 小样本噪声大,不采
      const c = loadContextCalibration();
      const k = _calibKey(providerId, model);
      const ratio = Math.min(3, Math.max(0.5, actual / estimated));
      const prev = c.factors[k];
      c.factors[k] = { f: prev ? prev.f * 0.7 + ratio * 0.3 : ratio, n: (prev ? prev.n : 0) + 1 };
      persistContextCalibration();
    } catch { /* ignore */ }
  }
  function estimateFactor(providerId, model) {
    try {
      const f = loadContextCalibration().factors[_calibKey(providerId, model)];
      return (f && f.n >= 3 && Number.isFinite(f.f)) ? f.f : 1;
    } catch { return 1; }
  }
  function noteWindowOvershoot(providerId, model, estimatedAtFailure) {
    try {
      estimatedAtFailure = Math.floor(Number(estimatedAtFailure) || 0);
      if (estimatedAtFailure < 1000) return;
      const c = loadContextCalibration();
      const k = _calibKey(providerId, model);
      const learned = Math.floor(estimatedAtFailure * 0.9);
      const prev = c.windowCaps[k];
      if (prev && prev.cap <= learned) return; // 只降不升
      c.windowCaps[k] = { cap: learned, at: nowIso() };
      persistContextCalibration();
    } catch { /* ignore */ }
  }
  function learnedWindowCap(providerId, model) {
    try {
      const w = loadContextCalibration().windowCaps[_calibKey(providerId, model)];
      return (w && Number(w.cap) > 0) ? Number(w.cap) : 0;
    } catch { return 0; }
  }
  // 校准后的预算估算(45d(a) 唯一应用点):估算 × 因子。签名与 maybeAutoCompact 的估算同款。
  function calibratedEstimate(provider, model, messages, tools) {
    return Math.round(estimateHistoryTokens(messages, '', tools) * estimateFactor(provider && provider.id, model));
  }

  return { providerContextWindow, noteEstimateSample, estimateFactor, noteWindowOvershoot, learnedWindowCap, calibratedEstimate };
}

module.exports = { createContextCalibration };
