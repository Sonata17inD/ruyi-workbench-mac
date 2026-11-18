'use strict';

const { apiFailure, apiSessionIdInvalid, apiSessionNotFound, json, readJsonBody, send } = require('./http-protocol.cjs');
const { normalizeCwd } = require('./path-containment.cjs');

function createMissionLedgerRoutes({
  tokenOk, tokenMatches, safeSessionId, loadSession, mutateSession, activeChildren, readConfig, nowIso, logEvent,
  todos: { normalizeTodoItems },
  missions: { missionControlCommand, evaluateMissionCheck, recordMissionCheckResult, MISSION_MAX_TEXT,
    maybeFinalizeMission, bumpMissionChangeSeq, normalizeMission, applyMissionUpdate },
}) {
  async function handleMissionLedgerApiRoutes(req, res, pathname) {
    if (req.method === 'POST' && pathname === '/api/todo') {
      // v0.8-S3: called by the todo_write tool running in the MCP child (Claude engine) over loopback. The
      // child must NOT write session files itself (races the serve process's saveSession), so it delegates
      // the persist here. Body-token authenticated (same pattern as /api/permission/request). Validates →
      // loadSession → session.todos = items → saveSession → if a live turn owns this session, emit `todo`.
      const body = await readJsonBody(req);
      if (!tokenMatches(body.token)) return send(res, json({ ok: false, error: 'bad token' }, 403));
      const sessionId = safeSessionId(body.sessionId); // F4
      if (!sessionId) return send(res, apiSessionIdInvalid());
      const items = normalizeTodoItems(body.items);
      // 128b:mutateSession —— 撤回插在读与存之间时在新读的副本上重放,不被闸静默丢掉还回 ok。
      let written;
      try { written = await mutateSession(sessionId, fresh => { fresh.todos = items; }, { writer: 'todo' }); }
      catch (error) {
        if (error && error.code === 'session.rewound_during_write') return send(res, apiFailure(error.code, {}, error.message, 409));
        throw error;
      }
      if (!written.session) return send(res, apiSessionNotFound());
      const reg = activeChildren.get(sessionId);
      if (reg && reg.onEvent) { try { reg.onEvent({ type: 'todo', items }); } catch { /* stream gone */ } }
      return send(res, json({ ok: true, count: items.length }));
    }
    // ── 第26波b: 任务账本 API。GET 读(header token);POST 改(header token 或 body token —— 后者供 MCP 子进程
    //    的 mission_update 工具 loopback,同 /api/todo 纪律)。action: start(全量设)/update(合并)/stop/check(跑验收)。──
    if (pathname === '/api/mission') {
      const bodyOrQ = req.method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://x').searchParams) : await readJsonBody(req);
      const bodyTokenOk = tokenMatches(bodyOrQ.token);
      if (!tokenOk(req) && !bodyTokenOk) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const sessionId = safeSessionId(bodyOrQ.sessionId);
      if (!sessionId) return send(res, apiSessionIdInvalid());
      let session = await loadSession(sessionId);
      if (!session) return send(res, apiSessionNotFound());
      if (req.method === 'GET') return send(res, json({ ok: true, mission: session.mission || null }));
      // 128b:check／start／update 都走 mutateSession 落盘;撞上撤回回 409 稳定码,不回成功、不记变更流水。
      const rewoundReply = error => send(res, apiFailure(error.code, {}, error.message, 409));
      if (req.method !== 'POST') return send(res, json({ ok: false, error: 'method not allowed' }, 405));
      const action = String(bodyOrQ.action || 'update');
      const emitMission = () => { const reg = activeChildren.get(sessionId); if (reg && reg.onEvent) { try { reg.onEvent({ type: 'mission', mission: session.mission }); } catch { /* stream gone */ } } };
      if (action === 'stop') {
        const result = await missionControlCommand(sessionId, 'stop');
        return send(res, json(result.body, result.status));
      }
      if (action === 'check') {
        // 跑全部里程碑机器验收;autoMark!==false 时把 pass 的 pending/blocked 里程碑标 done(证据落 detail)。
        const cwd = normalizeCwd(session.cwd, (await readConfig()).defaultWorkspace);
        const baseGen = Number(session.rewindGen) || 0;
        const results = [];
        for (const m of ((session.mission && session.mission.milestones) || [])) {
          const r = await evaluateMissionCheck(m.check, cwd);
          results.push({ id: m.id, checkType: m.check ? m.check.type : 'none', result: r });
        }
        const byId = new Map(results.map(item => [item.id, item.result]));
        let resultBefore = '';
        let written;
        try {
          written = await mutateSession(sessionId, async fresh => {
            for (const m of ((fresh.mission && fresh.mission.milestones) || [])) {
              const r = byId.get(m.id);
              if (!r) continue;
              recordMissionCheckResult(m, r);   // 124-P1:落章(唯一写入口在 02);done 不回退的既有语义不变
              if (r.pass && bodyOrQ.autoMark !== false && m.status !== 'done') { m.status = 'done'; m.evidence = String(r.detail || '机器验收通过').slice(0, MISSION_MAX_TEXT); }
              if (!r.pass && m.status === 'done') { /* 不自动回退 done → 避免抖动;仅 report */ }
            }
            if (fresh.mission) fresh.mission.updatedAt = nowIso();
            resultBefore = String(fresh.mission && fresh.mission.result && fresh.mission.result.status || '');
            await maybeFinalizeMission(fresh, 'check'); // 第72波:全 done 盖 complete 章
          }, { writer: 'mission_check', expectGen: baseGen });
        } catch (error) {
          if (error && error.code === 'session.rewound_during_write') return rewoundReply(error);
          throw error;
        }
        if (!written.session) return send(res, apiSessionNotFound());
        session = written.session;
        if (session.mission) {
          const resultAfter = String(session.mission.result && session.mission.result.status || '');
          const revision = await bumpMissionChangeSeq(sessionId, {
            type: resultAfter && resultAfter !== resultBefore ? 'result' : 'progress',
            cursor: { action: 'check' },
            detail: { checks: results.length, passed: results.filter(item => item.result && item.result.pass).length, status: resultAfter },
          });
          if (revision) session.mission.changeSeq = revision;
        }
        emitMission();
        return send(res, json({ ok: true, mission: session.mission || null, checks: results }));
      }
      // start = 全量新建(normalizeMission,prev=null);update = 按 id 增量合并(applyMissionUpdate,不抹其它里程碑)。
      // autoMode 可作 body 兄弟字段或 mission.autoMode 传入,两条路径都尊重。
      // 对抗轮 P1: trusted = 【header token】(UI/用户)——只有它能定义机器 check;body-token loopback(模型经 MCP 子进程)
      // 视为不可信,不能设 check.cmd。header token 存在即 UI 直连(浏览器 CORS 拿不到该 token)。
      const trusted = tokenOk(req);
      let resultBefore = '';
      let written;
      try {
        written = await mutateSession(sessionId, async fresh => {
          resultBefore = String(fresh.mission && fresh.mission.result && fresh.mission.result.status || '');
          if (action === 'start') {
            const input = { ...(bodyOrQ.mission || bodyOrQ) };
            if (bodyOrQ.autoMode != null && input.autoMode == null) input.autoMode = bodyOrQ.autoMode;
            fresh.mission = normalizeMission(input, null, trusted);
            fresh.mission.startedTurnSeq = Math.max(1, (Number(fresh.turnSeq) || 0) + 1);
            fresh.kind = 'mission'; // 第70波(EC-E):start 是显式任务动作 → Quick Ask 翻转 Mission(非启发式)
            return undefined;
          }
          if (!fresh.mission) return { abort: 'no_mission' };
          fresh.mission = applyMissionUpdate(fresh.mission, bodyOrQ.patch || bodyOrQ, trusted);
          if (bodyOrQ.autoMode != null) fresh.mission.autoMode = ['off', 'until-done', 'supervised'].includes(bodyOrQ.autoMode) ? bodyOrQ.autoMode : fresh.mission.autoMode;
          await maybeFinalizeMission(fresh, 'update'); // 第72波:全 done 盖 complete 章 / 再武装清旧章
          return undefined;
        }, { writer: 'mission_' + (action === 'start' ? 'start' : 'update') });
      } catch (error) {
        if (error && error.code === 'session.rewound_during_write') return rewoundReply(error);
        throw error;
      }
      if (!written.session) return send(res, apiSessionNotFound());
      if (!written.ok && written.value === 'no_mission') return send(res, json({ ok: false, error: '当前会话没有活动任务账本;请先 action:start' }, 400));
      session = written.session;
      if (action === 'start') logEvent({ kind: 'mission_start', sessionId, trusted, autoMode: session.mission.autoMode }); // 29c: 预算超支率的分母
      if (session.mission) {
        const resultAfter = String(session.mission.result && session.mission.result.status || '');
        const revision = await bumpMissionChangeSeq(sessionId, {
          type: action === 'start' ? 'mission_started' : (resultAfter && resultAfter !== resultBefore ? 'result' : 'progress'),
          cursor: { action },
          detail: {
            status: resultAfter,
            autoMode: session.mission.autoMode || 'off',
            milestonesTotal: Array.isArray(session.mission.milestones) ? session.mission.milestones.length : 0,
            milestonesDone: Array.isArray(session.mission.milestones) ? session.mission.milestones.filter(item => item && item.status === 'done').length : 0,
          },
        });
        if (revision) session.mission.changeSeq = revision;
      }
      emitMission();
      // C4 (75a-3): sync the mission change to the active turn's in-memory session, so the provider round-tail
      // saveSession (09:1924) doesn't cover back this route mutation. provider engine updates mission in-process
      // (09:1719) and saves only at round-tail; without sync the turn's stale in-memory mission clobbers the
      // route mutation. 'update' applies the patch (merge via applyMissionUpdate, preserving in-process
      // mission_update changes); start/stop/check replace (full-state action). claude engine re-reads at 05:765
      // instead (its mission_update loops back to disk), so it doesn't need this sync.
      { const reg = activeChildren.get(sessionId); if (reg && reg.session && reg.session !== session) {
        if (action === 'update' && reg.session.mission) {
          reg.session.mission = applyMissionUpdate(reg.session.mission, bodyOrQ.patch || bodyOrQ, trusted);
          if (bodyOrQ.autoMode != null) reg.session.mission.autoMode = ['off', 'until-done', 'supervised'].includes(bodyOrQ.autoMode) ? bodyOrQ.autoMode : reg.session.mission.autoMode;
          // 第97波对抗复审(B2):本路由已把磁盘权威侧落盘(含 maybeFinalizeMission 盖的 complete/stopped 章
          // 与归档的 resultHistory);reg 内存侧只是 applyMissionUpdate 深拷旧值,result/resultHistory 仍是旧的。
          // 若不同步,09/provider 回合收尾 saveSession(reg.session)会用陈旧内存覆盖磁盘,新章与归档整条丢失。
          // 同步磁盘权威的 result 与 resultHistory(归档历史是追加语义,以磁盘为准)。
          reg.session.mission.result = session.mission && session.mission.result || null;
          reg.session.mission.resultHistory = Array.isArray(session.mission && session.mission.resultHistory) ? session.mission.resultHistory.slice(-10) : [];
          if (session.mission && session.mission.result && session.mission.result.status === 'complete' && resultBefore !== 'complete') {
            Object.defineProperty(reg.session, '__missionFinalizeHow', { value: 'update', writable: true, configurable: true, enumerable: false });
          }
        } else {
          reg.session.mission = session.mission;
          if (action === 'start') reg.session.kind = 'mission';
        }
      } }
      return send(res, json({ ok: true, mission: session.mission }));
    }
  }
  return handleMissionLedgerApiRoutes;
}

module.exports = { createMissionLedgerRoutes };
