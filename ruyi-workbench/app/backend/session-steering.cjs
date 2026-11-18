'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { apiFailure, apiSessionIdInvalid, json, readJsonBody, send } = require('./http-protocol.cjs');

function createSessionSteering({
  paths, activeChildren, safeSessionId, nowIso, logEvent, saveSession, buildUserEnvelope, writeToChild,
  VisualPipeline, sanitizeFsSegmentName, hasPendingQuestionForSession, STEER_QUEUE_MAX,
}) {
  // ── 插话核心(116-2b 零行为抽出)────────────────────────────────────────────────────────────
  // 原本整段内联在 POST /api/steer 的路由体里。116-2b 的 steward_thread_note 要走的是【同一条】
  // 插话通道(而不是第二条注入路径),故把入参归一 → 引擎分流 → 注入/入队 → 持久呈现这一整段搬成
  // 可调用函数,一个字未改:判定顺序、措辞、STEER_QUEUE_MAX 计数口径、[用户插话] 前缀中和、
  // hasPendingQuestionForSession 拒绝、logEvent 的 kind/source、返回的 body 形状全部原样。
  //
  // 返回值是一个"怎么应答"的描述,而不是 HTTP 响应:
  //   { kind: 'failure', code, detail, message, status }  → 路由 send(res, apiFailure(...))
  //   { kind: 'json', body }                              → 路由 send(res, json(body))
  // 这样路由的两种应答形态(apiFailure 与裸 json)都保住,调用方(13g)则只看 body.ok。
  // 124 真机 bug（用户 2026-09-15）：插话的每一种拒绝理由都要有【稳定码】。
  //
  // 修前它们全是遗留字符串（{ok:false, error:'当前没有进行中的回合'}）。00-boot 的
  // normalizeApiErrorPayload 对不在 LEGACY_API_ERROR_CODES 表里的字符串一律派兜底码
  // api.request_failed，真话只剩在 message 里；而前端组合根的 apiErrText 是【码优先】的，
  // 于是屏幕上只剩一句「请求失败。」—— 服务端明明说的是「当前 Kimi 回合正在收尾，请作为下一条
  // 消息发送」，那句话把该怎么做都告诉用户了，却被抹掉。
  //
  // 有码之后两件事才立得住：① 前端能按码兜底（回合已经结束 → 当新回合发出去），而不是去匹配
  // 中文句子（38 号文 §7 ④ 已经裁决过不许搞关键词表）；② 文案不再被归一吞掉。
  // 形状用 {code, params, message}：与 apiFailure 的错误对象同形，且因为 error 不再是 string，
  // normalizeApiErrorPayload 原样放行（既有消费者读 error.message，逐字不变）。
  const STEER_REFUSAL = Object.freeze({
    noLiveTurn: { code: 'steer.no_live_turn', message: '当前没有进行中的回合' },
    kimiSettling: { code: 'steer.kimi_settling', message: '当前 Kimi 回合正在收尾，请作为下一条消息发送' },
    queueFull: { code: 'steer.queue_full', message: '插话队列已满' },
    turnLimit: { code: 'steer.queue_full', message: '本回合插话已达上限(3 条)' },
    answerPending: { code: 'steer.answer_pending', message: '请先回答当前提问,再插话(避免插话被误收为答案)' },
    engineUnsupported: { code: 'steer.engine_unsupported', message: '当前引擎不支持插话' },
    injectFailed: { code: 'steer.inject_failed', message: '注入失败:子进程输入通道已关闭' },
  });
  const steerRefusal = which => ({ kind: 'json', body: { ok: false, error: { ...STEER_REFUSAL[which], params: {} } } });
  // 附件只按上传 id/name 重定位,绝不把请求里的 path 当可读文件。与普通消息使用同一上传目录。
  async function steerAttachments(raw) {
    if (raw == null) return [];
    if (!Array.isArray(raw) || raw.length > 12) throw new Error('最多递送 12 个上传附件');
    if (!raw.length) return [];
    const root = await fsp.realpath(paths.uploads);
    // 81-P0 baseline repair: realpath upload containment stays local, avoiding a new bridge-guard cycle.
    const insideUploads = file => {
      const relative = path.relative(root, file);
      return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    const out = [];
    for (const item of raw) {
      const { id, name } = item || {};
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof name !== 'string' || !name || name.length > 200 || sanitizeFsSegmentName(name) !== name || /[. ]$/.test(name)) throw new Error('附件记录无效,请重新上传');
      const file = await fsp.realpath(path.join(root, id, name));
      const stat = await fsp.stat(file);
      if (!insideUploads(file) || !stat.isFile()) throw new Error('附件已不可用,请重新上传');
      const image = /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
      const sendPath = image ? await fsp.realpath(path.join(root, id, 'send.jpg')).catch(() => '') : '';
      out.push({ id, name, path: file, size: stat.size, ...(image ? { kind: 'image' } : {}),
        ...(sendPath && insideUploads(sendPath) ? { sendPath } : {}),
        ...(typeof item.textPreview === 'string' ? { textPreview: item.textPreview.slice(0, 12000) } : {}),
        ...(typeof item.ocrText === 'string' ? { ocrText: item.ocrText.slice(0, 12000) } : {}),
        ...(typeof item.transcript === 'string' ? { transcript: item.transcript.slice(0, 12000) } : {}) });
    }
    return out;
  }
  async function steerSessionCore(input) {
    const o = (input && typeof input === 'object') ? input : {};
    const sessionId = safeSessionId(o.sessionId); // F4
    let text = String(o.text || '').trim().slice(0, 2000).replace(/^(\s*\[用户插话\]\s*)+/, '').trim(); // 与 steer_node 上限对齐 + 前缀中和
    if (!sessionId) return { kind: 'failure', code: 'session.id_invalid', detail: {}, message: 'invalid sessionId', status: 400 };
    let attachments;
    try { attachments = await steerAttachments(o.attachments); }
    catch { return { kind: 'failure', code: 'request.invalid', detail: {}, message: '附件无效或已不可用,请重新上传', status: 400 }; }
    if (!text && !attachments.length) return { kind: 'failure', code: 'request.field_required', detail: { field: 'text' }, message: 'text or attachments is required', status: 400 };
    if (!text) text = ('[附件] ' + attachments.map(a => a.name).join(', ')).slice(0, 2000);
    const mode = o.mode == null ? 'queue' : o.mode;
    if (!['queue', 'interrupt'].includes(mode)) return { kind: 'failure', code: 'request.invalid', detail: {}, message: 'mode must be queue or interrupt', status: 400 };
    const reg = activeChildren.get(sessionId);
    if (!reg) return steerRefusal('noLiveTurn');
    if (reg.kind === 'kimi-acp') {
      // Kimi ACP 0.37.x has no native mid-prompt steering method. Keep the ACP process/session alive and
      // enqueue a follow-up session/prompt immediately after the active prompt settles. This preserves native
      // session continuity and is explicitly reported as queued (and therefore remains retractable).
      if (reg.acceptingSteer === false) return steerRefusal('kimiSettling');
      if (!Array.isArray(reg.steerQueue)) reg.steerQueue = [];
      if (reg.steerQueue.length >= STEER_QUEUE_MAX) return steerRefusal('queueFull');
      reg.steerQueue.push(attachments.length ? { text, attachments } : text);
      logEvent({ kind: 'intervention', source: 'steer', protocol: 'kimi-acp-followup', sessionId });
      return { kind: 'json', body: { ok: true, queued: reg.steerQueue.length, immediate: false, protocol: 'kimi-acp-followup' } };
    }
    if (reg.kind === 'claude') {
      // 47a Phase A:Claude interactive 引擎 —— stdin 即时注入,无迭代边界队列。
      if (!reg.interactive) {
        return {
          kind: 'failure',
          code: 'steer.claude_requires_interactive',
          detail: {},
          message: '当前 Claude 回合使用 legacy/print 模式,无法插话;请在设置 → Claude CLI 中切换为 interactive,下一回合生效',
          status: 409,
        };
      }
      if (hasPendingQuestionForSession(sessionId)) return steerRefusal('answerPending');
      reg.claudeSteerCount = Number(reg.claudeSteerCount) || 0;
      if (reg.claudeSteerCount >= STEER_QUEUE_MAX) return steerRefusal('turnLimit');
      // 81-P0: engine-owned adapter avoids importing bridge helpers into the route dependency cycle.
      if (attachments.length && typeof reg.buildSteerAttachmentPrompt !== 'function') return steerRefusal('injectFailed');
      const envelope = buildUserEnvelope('[用户插话] ' + text + (attachments.length ? reg.buildSteerAttachmentPrompt(attachments) : ''));
      if (VisualPipeline.hasImageAttachment(attachments)) {
        const parts = await VisualPipeline.buildUserContentParts(envelope.message.content[0].text, attachments);
        envelope.message.content = parts.map(part => part.type === 'image_url'
          ? (() => { const match = /^data:([^;]+);base64,(.*)$/.exec(part.image_url.url); return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }; })()
          : part);
      }
      if (activeChildren.get(sessionId) !== reg || reg.state !== 'running') return steerRefusal('noLiveTurn');
      if (hasPendingQuestionForSession(sessionId)) return steerRefusal('answerPending');
      if (reg.claudeSteerCount >= STEER_QUEUE_MAX) return steerRefusal('turnLimit');
      const injected = writeToChild(sessionId, envelope);
      if (!injected) return steerRefusal('injectFailed');
      reg.claudeSteerCount += 1;
      // 持久呈现(与 provider drain 同形):插话入会话正文 + steered 事件,静态重渲染可见、刷新不丢。
      if (reg.session) {
        reg.session.messages.push({ role: 'user', content: text, ...(attachments.length ? { attachments } : {}), turnSeq: reg.session.turnSeq, steered: true, createdAt: nowIso() });
        try { await saveSession(reg.session); } catch { /* best-effort(回合末还会保存) */ }
      }
      try { if (reg.onEvent) reg.onEvent({ type: 'steered', text, ...(attachments.length ? { attachments } : {}) }); } catch { /* stream gone */ }
      logEvent({ kind: 'intervention', source: 'steer', sessionId }); // 29c
      return { kind: 'json', body: { ok: true, injected: true } };
    }
    if (reg.kind !== 'openai') return steerRefusal('engineUnsupported');
    if (!Array.isArray(reg.steerQueue)) reg.steerQueue = [];
    if (reg.steerQueue.length >= STEER_QUEUE_MAX) return steerRefusal('queueFull');
    reg.steerQueue.push({ text, mode, ...(attachments.length ? { attachments } : {}) });
    // Ordinary additions preserve in-flight work. Only an explicit interrupt cancels a runner.
    try { if (mode === 'interrupt' && typeof reg.interruptToolWait === 'function') reg.interruptToolWait(); } catch { /* best-effort */ }
    logEvent({ kind: 'intervention', source: 'steer', sessionId }); // 29c
    return { kind: 'json', body: { ok: true, queued: reg.steerQueue.length, mode } };
  }

  // ── steer 域:/api/steer ────────────────────────────────────────────────────────────────────
  async function handleSteerApiRoute(req, res, pathname) {
    // v0.8-S7: mid-turn STEERING (§4 A3). UI-only, header-token (needsToken whitelist above). 第47波47a 起双引擎:
    // provider 走既有 steerQueue(下一次迭代边界 drain 注入);Claude(interactive)经 stdin user envelope【即时注入】
    // —— 与 AskUser 应答同通道,故有两条分流纪律:①提问挂起(hasPendingQuestionForSession)时拒绝插话(防被误收为
    // 答案);②[用户插话] 前缀只能由服务端加,入参里的同名前缀先剥(伪造前缀中和,与 07 工具结果中和同精神)。
    // Rejects (never crashes) when: no live turn / Claude 为 print 模式(无 stdin 通道)/ 提问挂起 / 队列(计数)满 3。
    if (req.method === 'POST' && pathname === '/api/steer') {
      const body = await readJsonBody(req);
      // 116-2b:判定与副作用全在 steerSessionCore(见上);这里只剩 body 解析与两种应答形态的翻译。
      const outcome = await steerSessionCore({ sessionId: body.sessionId, text: body.text, mode: body.mode, attachments: body.attachments });
      if (outcome.kind === 'failure') return send(res, apiFailure(outcome.code, outcome.detail, outcome.message, outcome.status));
      return send(res, json(outcome.body));
    }
    // v1.9.0: DELETE /api/steer — 撤回(取消)一条已入队的插话。body: { sessionId, text }。
    // 找到 steerQueue 中第一个匹配 text 的条目并移除;返回剩余队列长度。
    if (req.method === 'DELETE' && pathname === '/api/steer') {
      const body = await readJsonBody(req);
      const sessionId = safeSessionId(body.sessionId);
      // Mirror POST normalization: callers can cancel text that POST accepted after stripping a spoofed prefix.
      const text = String(body.text || '').trim().slice(0, 2000).replace(/^(\s*\[用户插话\]\s*)+/, '').trim();
      if (!sessionId) return send(res, apiSessionIdInvalid());
      if (!text) return send(res, apiFailure('request.field_required', { field: 'text' }, 'text is required', 400));
      const reg = activeChildren.get(sessionId);
      if (!reg) return send(res, json({ ok: false, error: '当前没有进行中的回合' }));
      // Claude 引擎走即时注入,不可撤回
      if (reg.kind === 'claude') return send(res, json({ ok: false, error: 'Claude 引擎的插话已即时注入,无法撤回' }));
      if (!Array.isArray(reg.steerQueue) || !reg.steerQueue.length) return send(res, json({ ok: false, error: '队列为空' }));
      const idx = reg.steerQueue.findIndex(item => (typeof item === 'string' ? item : item.text) === text
        && (body.attachmentKey == null || body.attachmentKey === (item.attachments?.length ? JSON.stringify(item.attachments.map(a => [a.id || '', a.name || ''])) : '')));
      if (idx < 0) return send(res, json({ ok: false, error: '未找到该插话内容' }));
      reg.steerQueue.splice(idx, 1);
      return send(res, json({ ok: true, remaining: reg.steerQueue.length }));
    }
    return false;
  }

  return { steerSessionCore, handleSteerApiRoute };
}

module.exports = { createSessionSteering };
