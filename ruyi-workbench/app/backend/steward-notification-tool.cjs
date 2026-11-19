'use strict';

function createStewardNotificationTool({
  RUYI_EVENTS, safeSessionId, stewardAppendDecision, stewardClampInt, stewardFail, stewardReadSessionHead,
  stewardSanitizeText, stewardSeatedByUser,
  quota, limits,
}) {
  const { stewardNotifiesInWindow, stewardNotifyRecord } = quota;
  const { STEWARD_NOTIFY_KINDS, STEWARD_NOTIFY_TEXT_CHARS } = limits;

  // ════════════════════════════════════════════════════════════════════════════
  // 129f「嘴」(31 号文 §2.4「叫得到你」)—— 管家主动叫人。
  //
  // 修前:管家只会在壳里说话,用户不在就等于白说。安静卡那一路(quiet-card)已经会在
  // needs_you/failed/stalled/budget/reminder 上自动发系统通知,但那是**工作台在叫**,
  // 报的是事件;管家自己想说一句「你交给我盯的那条收工了,结论是 X」,没有任何口子。
  //
  // 三条纪律(原文口径,一条都不放宽):
  //   ① **只在三类事上叫**:等你拿主意 / 出错了 / 收工了。能叫人的理由一多,通知就成噪音,
  //      用户第一件事是把它整个关掉 —— 那时真要紧的那条也叫不到他;
  //   ② **熔断**:滚动一小时最多 stewardNotifyPerHour 次(默认 6),与代批那个窗口各记各的;
  //   ③ **服务端只管「该不该叫」**,「此刻在不在前台、是不是静默时段」由前端那一处判
  //      (quiet-card 里本来就有那两道判据,不在这里写第二份 —— 两份迟早各说各话)。
  // 通知**不改世界**,所以三档都可用;它也不进 act 表(不会回 propose_required:
  // 一枚「按这里来通知我」的按钮是没有意义的)。
  // ════════════════════════════════════════════════════════════════════════════

  // 31) steward_notify
  async function stewardImplNotify(args, ctx, config) {
    const kind = String((args && args.kind) || '');
    if (!STEWARD_NOTIFY_KINDS.includes(kind)) {
      return stewardFail('invalid_request', `kind must be one of ${STEWARD_NOTIFY_KINDS.join('/')}`);
    }
    const text = stewardSanitizeText(String((args && args.text) || '')).trim().slice(0, STEWARD_NOTIFY_TEXT_CHARS);
    if (!text) return stewardFail('invalid_request', 'text is required');
    // 带了线程就核一下它真的存在 —— 通知点进去要能落到那条线程上,指向一个不存在的 id 等于叫了个空。
    const sid = args && args.sessionId ? safeSessionId(args.sessionId) : '';
    if (args && args.sessionId && !sid) return stewardFail('not_found', 'invalid sessionId');
    if (sid) {
      const head = await stewardReadSessionHead(sid);
      if (!head || !head.id) return stewardFail('not_found', `thread ${stewardSanitizeText(sid)} not found`);
      // 用户此刻就坐在那条线程上 = 他在看着,不用叫(与 128f-⑪ 那道门同一个判据函数)。
      if (stewardSeatedByUser(sid)) {
        return stewardFail('seated_by_user', '用户正坐在那条线程上,不用叫他 —— 直接在对话里说就行', { sessionId: sid });
      }
    }
    const cap = stewardClampInt(config && config.stewardNotifyPerHour, 1, 60, 6);
    const now = Date.now();
    if (stewardNotifiesInWindow(now) >= cap) {
      return stewardFail('hourly_cap', `这一小时已经叫过 ${cap} 次了(stewardNotifyPerHour),剩下的话留到对话里说,不要重试`, { cap });
    }
    stewardNotifyRecord(now);
    RUYI_EVENTS.emit('steward.notify', { sessionId: sid, kind, text });
    stewardAppendDecision({
      tool: 'steward_notify', args: { kind, chars: text.length }, targetSessionId: sid,
      permissionMode: '', mayAct: 'auto', undoRef: { kind: 'none' }, basis: {},
    });
    // 如实说「送出去了」而不是「他看到了」:静默时段与前台判定在前端,这里不知道结果。
    return { ok: true, kind, sessionId: sid, delivered: 'queued', note: '已送出;如果你设了静默时段或人就在前台,系统通知可能不会弹。' };
  }

  return {
    stewardImplNotify,
  };
}

module.exports = { createStewardNotificationTool };
