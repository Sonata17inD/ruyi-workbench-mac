'use strict';

function createStewardContentTools({
  draftPlaybookFromSession, playbookReuseSources, setSessionSkillsCore, safeSessionId, stewardAppendDecision,
  stewardBasisOf, stewardFail,
  threads, quota, limits,
}) {
  const { stewardRawKind, stewardReadSessionHead, stewardThreadPermissionMode } = threads;
  const { stewardTurnQuotaRefund, stewardTurnQuotaTake } = quota;
  const { STEWARD_PLAYBOOK_DRAFTS_PER_TURN, STEWARD_SESSION_ID } = limits;

  // ════════════════════════════════════════════════════════════════════════════
  // 内容管理族 —— §3.5「内容管理」行。playbook 只起草不保存;技能启停须确认;速查线程自己收工。
  // ════════════════════════════════════════════════════════════════════════════

  // 22) steward_playbook_draft —— 只返回草稿,【不保存】。保存走既有 UI(POST /api/playbooks,117 接)。
  //     每回合 1 次:draftPlaybookFromSession 自己要调一次模型,管家一个回合里连起五个草稿是纯烧钱。
  async function stewardImplPlaybookDraft(args, ctx, config) {
    const sessionId = safeSessionId(args.sessionId);
    if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
    // 同 skill_toggle:身份判定排在装载之前(见那边的原注释)。
    if (sessionId === STEWARD_SESSION_ID) return stewardFail('steward.forbidden', 'the steward session cannot be turned into a playbook');
    const head = await stewardReadSessionHead(sessionId);
    if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
    if (stewardRawKind(head) === 'steward') return stewardFail('steward.forbidden', 'the steward session cannot be turned into a playbook');
    if (args.mode === 'sources') return playbookReuseSources(sessionId);
    if (!stewardTurnQuotaTake('playbook_draft', ctx, STEWARD_PLAYBOOK_DRAFTS_PER_TURN)) {
      return stewardFail('quota_exceeded', `at most ${STEWARD_PLAYBOOK_DRAFTS_PER_TURN} playbook draft per steward turn; do not retry - tell the user what you have`);
    }
    const draft = await draftPlaybookFromSession(sessionId, { selection: args.selection });
    // 第二轮工具走查(F11):名额是为「起草要调一次模型」设的;修前先扣名额再试,于是「本会话没有可参考的用户消息」
    // 这类【根本没调模型】的失败也把本回合唯一的名额烧掉,同一回合里换一条对的线程再起草就被 quota_exceeded 挡死。
    // 06 在三个调模型之前的早退里带 noModelCall:true —— 那种失败把名额还回去;真调过模型(哪怕没解析出合法 JSON)照旧算一次。
    if (draft && draft.ok === false && draft.noModelCall === true) stewardTurnQuotaRefund('playbook_draft', ctx);
    if (!draft || draft.ok === false) {
      return stewardFail('draft_failed', String((draft && draft.error) || 'the engine could not draft a playbook from this thread'));
    }
    return { ok: true, sessionId, draft: draft.playbook || draft.draft || null, saveVia: 'POST /api/playbooks' };
  }

  // 23) steward_skill_toggle —— 与 POST /api/session/skills 共用 setSessionSkillsCore(同一段校验/去重/
  //     截 8/来源锁定/活动回合同步)。须确认:改了技能就等于改了那条线程下一回合的工具面与提示词。
  async function stewardImplSkillToggle(args, ctx, config) {
    const sessionId = safeSessionId(args.sessionId);
    if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
    // 管家不能对自己用:管家提示词包本来就不含技能索引(§3.5「管家动如意、线程动世界」)。这一条排在
    // 会话装载【之前】—— 目标是管家自己时,答案是「这件事不该做」,不该因为管家会话恰好还没建出来
    // 就退化成「找不到」(两个信封说的是完全不同的两件事)。
    if (sessionId === STEWARD_SESSION_ID) {
      return stewardFail('steward.forbidden', 'the steward session has no skills to toggle');
    }
    const head = await stewardReadSessionHead(sessionId);
    if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
    if (stewardRawKind(head) === 'steward') {
      return stewardFail('steward.forbidden', 'the steward session has no skills to toggle');
    }
    if (!Array.isArray(args.skills)) return stewardFail('invalid_request', 'skills must be an array of skill ids');
    if (ctx.userPressed !== true) {
      return stewardFail('propose_required', 'changing the enabled skills of a thread needs the user to press the button',
        { reason: 'confirm_required', sessionId, skills: args.skills.map(x => String((x && x.id) || x || '')).slice(0, 8) });
    }
    const result = await setSessionSkillsCore(sessionId, args.skills);
    if (!result.ok && result.status === 409) return stewardFail('version_conflict', '这条线程在写入期间被撤回过,技能没有改成,请重试');   // 128b
    if (!result.ok) return stewardFail('not_found', String(result.error || 'session not found'));
    stewardAppendDecision({
      tool: 'steward_skill_toggle',
      args: { skills: result.skills.map(s => s.id) },
      targetSessionId: sessionId,
      permissionMode: stewardThreadPermissionMode(head, config),
      mayAct: 'user',
      undoRef: { kind: 'skills', sessionId, before: Array.isArray(head.skills) ? head.skills.map(s => (s && s.id) || '') : [] },
      basis: stewardBasisOf(args),
    });
    return { ok: true, sessionId, skills: result.skills };
  }

  return {
    stewardImplPlaybookDraft, stewardImplSkillToggle,
  };
}

module.exports = { createStewardContentTools };
