'use strict';

function createSessionRecovery({ danglingTurnState, sessionOmittedProviderHistory, pendingPermissions, pendingPlans, pendingQuestions }) {
  // v0.8-S0 A6: detect an interrupted (dangling) turn from providerHistory. Dangling shapes:
  //   - the tail is a role:'user' message with no assistant reply after it (turn never got answered);
  //   - the tail is a role:'tool' message (turn stopped mid tool-loop, see below);
  //   - the tail assistant carries tool_calls but not every tool_call_id has a matching role:'tool' reply
  //     (turn was arrested mid tool-loop). Returns { dangling, kind } — kind: 'user'|'tool_calls'|null.
  function detectDanglingTurn(session) {
    // perf:不读 provider 正文的装载视图(SESSION_LOAD_OMIT_PROVIDER)带着这份正文的判定与条数,形状与下面逐键相同。
    const omitted = sessionOmittedProviderHistory(session);
    const h = omitted ? null : ((session && Array.isArray(session.providerHistory)) ? session.providerHistory : []);
    // turnSeq + historyLength form a stable UI-dismiss fingerprint: reopening the same interrupted turn stays
    // dismissed, while a later interruption automatically gets a fresh banner instead of inheriting the old ×.
    const meta = { turnSeq: Math.max(0, Number(session && session.turnSeq) || 0), historyLength: omitted ? omitted.count : h.length };
    const state = omitted ? omitted.dangling : danglingTurnState(h.length, i => h[i]);
    return { dangling: state.dangling, kind: state.kind, ...meta };
  }
  // detectDanglingTurn 的判定本体:只看 providerHistory 的尾巴,at(i) 取第 i 条(数组下标,或 02 正文记录按行惰性解析)。

  // ── 第71b波:残留 pending 叙事段清理者 ─────────────────────────────────────────────────────────
  // permission/plan/question 叙事段在回合流式期以 status:'pending'(权限另有 'paused' 存档暂停)落盘(上方段构建器)。
  // 进程重启/回合中断后,内存待决注册表(04 pendingPermissions/pendingQuestions/pendingPlans)已清空,决策永远
  // 到不了 —— 段却在每次重进会话时永远显示「待处理」只读 pill(与 Intervention 的 cancelled_restart 同源的残留)。
  // 本清理器在 loadSession 全量装载时惰性修复:段的 id 不在活注册表 → 决策不可能再到达,诚实标终态 'cancelled'
  // + note(前端 pill 词汇已有 cancelled,见 chat-static-renderer narrativeStateLabel)。惰性而非 boot 全扫:
  // messages 正文是大文件,boot 扫全部会话代价不可控;loadSession 时该会话反正要被读,一趟摊销。
  // 覆盖 71b 前存量段(无 Intervention 记录)与 71b 后段(boot 已 cancel_restart 但段未动)——活注册表是唯一判据。
  // 竞态防护(调用方执行):活回合(activeChildren)或 dying turn 收尾窗口(turnSettlers,第69波 rewind 同款)
  // 内绝不调用 —— 此时磁盘 pending 可能是「决策在内存、未落盘」的活段,误标会与回合收尾 save 互相覆盖。
  function healStalePendingSegments(session) {
    if (!session || !Array.isArray(session.messages)) return false;
    let healed = false;
    const note = '应用重启或回合中断,该请求已失效;如需请重新发起。';
    const toolNote = '回合中断时该工具仍在运行,已标记为取消;如需请重试。';
    for (const msg of session.messages) {
      const segs = msg && Array.isArray(msg.segments) ? msg.segments : null;
      if (!segs) continue;
      for (const seg of segs) {
        if (!seg || typeof seg !== 'object') continue;
        if (seg.type === 'permission' && (seg.status === 'pending' || seg.status === 'paused')) {
          if (seg.requestId && pendingPermissions.has(String(seg.requestId))) continue; // 活待决:决策仍会到达
          seg.status = 'cancelled'; seg.note = note; healed = true;
        } else if (seg.type === 'plan' && seg.status === 'pending') {
          if (seg.planId && pendingPlans.has(String(seg.planId))) continue;
          seg.status = 'cancelled'; seg.note = note; healed = true;
        } else if (seg.type === 'question' && seg.status === 'pending') {
          if (seg.questionId && pendingQuestions.has(String(seg.questionId))) continue;
          seg.status = 'cancelled'; seg.note = note; healed = true;
        } else if ((seg.type === 'tool' || seg.type === 'subagent') && seg.status === 'running') {
          // 47b/86: 回合被 Stop/看门狗/异常中止时,正在执行的 tool/subagent 段以 'running' 落盘 (finalizeAll
          // 在新回合会兜底,但此会话是修复前落盘的存量) -> 重进会话时诚实标 'cancelled'。
          seg.status = 'cancelled'; seg.note = toolNote; healed = true;
        } else if (seg.type === 'workflow' && (seg.status === 'running' || seg.status === 'paused')) {
          seg.status = 'cancelled'; seg.note = toolNote; healed = true;
        }
      }
    }
    return healed;
  }

  return { detectDanglingTurn, healStalePendingSegments };
}

module.exports = { createSessionRecovery };
