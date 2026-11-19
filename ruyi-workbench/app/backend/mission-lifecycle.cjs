'use strict';
const path = require('node:path');
const fsp = require('node:fs/promises');

// Results and persisted mission state are independent of interactive commands.
function createMissionLifecycle({ journalReadIndex, foldTurnSummaries, applyMissionUpdate, nowIso, runProcess }) {
  async function buildMissionResult(session, opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const m = session.mission;
    const ms = (m && Array.isArray(m.milestones)) ? m.milestones : [];
    const fold = foldTurnSummaries(session);
    const cpEntries = await journalReadIndex(session.id).catch(() => []);
    const cpTurnSeqs = [...new Set(cpEntries.map(e => e && e.turnSeq).filter(Number.isFinite))].sort((a, b) => a - b);
    const byOp = {};
    for (const f of fold.filesChanged) byOp[f.op || 'unknown'] = (byOp[f.op || 'unknown'] || 0) + 1;
    // 交付成果正文:取本会话最后一条 assistant content(盖章时该消息已在 session.messages 内存)。
    // 随 result 持久化 + 下发,收工卡不再依赖 SSE 流到达时序;刷新读磁盘 result 已落盘,不截断当前输出。
    let deliverableText = '';
    const msgs = Array.isArray(session.messages) ? session.messages : [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const msg = msgs[i];
      if (msg && msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim()) {
        deliverableText = msg.content.slice(0, 16000);
        break;
      }
    }
    return {
      status: o.status === 'stopped' ? 'stopped' : 'complete',
      how: String(o.how || '').slice(0, 32),
      finishedAt: nowIso(),
      deliverableText,
      acceptance: {
        total: ms.length,
        done: ms.filter(x => x && x.status === 'done').length,
        blocked: ms.filter(x => x && x.status === 'blocked').length,
        pending: ms.filter(x => !x || x.status === 'pending').length,
      },
      unfinished: ms.filter(x => !x || x.status !== 'done').map(x => ({ id: x && x.id, desc: String((x && x.desc) || '').slice(0, 200), status: (x && x.status) || 'pending' })),
      todosOpen: ((session.todos) || []).filter(t => t && t.status !== 'done').length,
      artifacts: fold.artifacts.slice(0, 50),
      usage: {
        autoTurns: Math.max(0, Number(m && m.spent && m.spent.autoTurns) || 0),
        tokens: Math.max(0, Number(m && m.spent && m.spent.tokens) || 0),
      },
      changes: {
        filesChanged: fold.filesChanged.length, byOp,
        irreversibleFiles: fold.filesChanged.filter(f => f.revertible !== true).length,
        commands: fold.commands,
      },
      checkpoints: { entries: cpEntries.length, turnSeqs: cpTurnSeqs.slice(0, 50), rollbackAvailable: cpEntries.length > 0 },
      audit: { commands: fold.commands, irreversible: fold.irreversible.total, checkpoints: cpEntries.length, openTodos: ((session.todos) || []).filter(t => t && t.status !== 'done').length },
      irreversible: { total: fold.irreversible.total, byKind: fold.irreversible.byKind, items: fold.irreversible.items.slice(-30), legacyCommands: fold.irreversible.legacyCommands, ...(fold.irreversible.incomplete ? { incomplete: true } : {}) },
    };
  }
  // 终态盖章/再武装清理。在【任何 mission 突变点】调用(/api/mission check/update、09 回合内 mission_update):
  // 全部里程碑 done 且尚无 complete 章 → 盖章;否则有旧章 → 清理(再武装 = 结果不再是终态,章会撒谎)。
  // 返回是否改变了 mission(调用方负责 saveSession)。stop 不走这里 —— 它直接盖 stopped 章(13-http-router)。
  function archiveMissionResult(mission) {
    if (!mission || !mission.result) return;
    const history = Array.isArray(mission.resultHistory) ? mission.resultHistory.slice() : [];
    const archived = { ...mission.result };
    // 第97波:历史轮次保留完整 deliverableText,支持收工卡「在新窗口打开全文」;条数由 last 10 有界防膨胀。
    history.push(archived);
    if (history.length > 10) history.splice(0, history.length - 10);
    mission.resultHistory = history;
  }

  async function maybeFinalizeMission(session, how) {
    const m = session && session.mission;
    if (!m || !Array.isArray(m.milestones)) return false;
    const allDone = m.milestones.length > 0 && m.milestones.every(x => x && x.status === 'done');
    if (allDone) {
      if (m.result && m.result.status === 'complete') return false; // 已盖章,不重复
      archiveMissionResult(m); // 旧 stopped 章归档,再盖 complete
      m.result = await buildMissionResult(session, { status: 'complete', how });
      m.updatedAt = nowIso();
      return true;
    }
    if (m.result) { archiveMissionResult(m); m.result = null; m.updatedAt = nowIso(); return true; } // 再武装:归档旧章再清
    return false;
  }

  // A model can mark the last acceptance item done before it emits the final assistant text. In that case the
  // route has already produced a complete result from the previous assistant message. Rebuild that provisional
  // result once the current turn has appended its assistant message; do not archive it as a real prior round.
  async function finalizeMissionAfterTurn(session, how) {
    const mission = session && session.mission;
    if (mission && mission.result && mission.result.status === 'complete') {
      mission.result = await buildMissionResult(session, { status: 'complete', how: how || mission.result.how || 'update' });
      mission.updatedAt = nowIso();
      return true;
    }
    return maybeFinalizeMission(session, how);
  }

  // ── 122-§2.4:回合收尾的【落盘前合并】(mission) ───────────────────────────────────────────
  // 现象:管家开线程后立刻派第一回合,再 POST /api/mission {action:'start'};回合收尾一存,里程碑账本没了。
  // 病根:/api/mission 落盘后只在 getActiveTurn(sessionId) 命中时才把 mission 同步进活回合内存(C4)。
  // 而 09-workflow 从「路由 loadSession 出会话」到「activeChildren.set(reg)」之间隔着 providerHistory 同步、
  // 配对/参数自愈、turnSeq 落盘、onTurnStart 钩子与 captureWorkspaceTurnBaseline —— 这一整段里到达的 start
  // 已经落了盘,却谁也同步不进回合内存;回合收尾 saveSession(内存 session)把整份 mission 覆盖回「没有」。
  // 修法(与 P2-3「skills/memories 的 pre-save disk-merge」同一形状,三个引擎共用本函数):落盘前重读磁盘,
  //   ① 磁盘有账本而内存没有  → 以磁盘为准(顺带把 start 翻过的 kind:'mission' 接回来);
  //   ② 同一本账本(createdAt 相同)且磁盘 changeSeq 更高 → 以磁盘为底,把本回合内存里的增量
  //      (goal / 里程碑 status·desc·evidence)用 applyMissionUpdate 语义重放上去 —— provider 引擎的
  //      mission_update 是 in-process 改内存的(09),不重放就把本回合的进度丢了;
  //   ③ 其余情况(内存不比磁盘旧,或磁盘换了另一本账本而内存那本已被 start 顶替)保持现状/以磁盘为准。
  // 返回是否改过 session.mission(仅供调用方判断,收尾流程不依赖)。
  function mergeMissionBeforeSave(session, onDisk) {
    if (!session) return false;
    const disk = onDisk && onDisk.mission && typeof onDisk.mission === 'object' ? onDisk.mission : null;
    const mem = session.mission && typeof session.mission === 'object' ? session.mission : null;
    if (!disk) return false;                       // 磁盘没有账本 -> 内存说了算(与合并前逐字节等价)
    if (!mem) {                                    // ① 回合中途才被 start:整份接过来
      session.mission = disk;
      if (onDisk.kind === 'mission') session.kind = 'mission';
      return true;
    }
    const diskSeq = Number(disk.changeSeq) || 0;
    const memSeq = Number(mem.changeSeq) || 0;
    if (diskSeq <= memSeq) return false;           // ③ 内存不比磁盘旧
    if (String(disk.createdAt || '') !== String(mem.createdAt || '')) {
      // ③ 磁盘上已经是【另一本】账本(回合中途 start 全量新建):内存那本是被顶替的旧账,不许重放回去。
      session.mission = disk;
      if (onDisk.kind === 'mission') session.kind = 'mission';
      return true;
    }
    // ② 同一本账本:以磁盘为底重放内存增量。补丁里【只带】id/status/desc/evidence,绝不带 check ——
    // 机器验收的定义权只属于磁盘那一份(用户经 header token 设的)。trusted=false 是刻意的:它顺带挡住
    // 「磁盘刚把 m1 判 done(action:'check' / 用户 UI),内存里那份还是 pending」被重放成回退」。
    session.mission = applyMissionUpdate(disk, {
      goal: mem.goal,
      milestones: (Array.isArray(mem.milestones) ? mem.milestones : []).map(item => ({
        id: item && item.id, status: item && item.status, desc: item && item.desc, evidence: item && item.evidence,
      })),
    }, false);
    if (onDisk.kind === 'mission') session.kind = 'mission';
    return true;
  }

  async function evaluateMissionCheck(check, cwd) {
    if (!check || check.type === 'none') return null;
    try {
      if (check.type === 'file_exists') {
        const p = path.resolve(cwd || '.', String(check.path || ''));
        // 对抗轮 P3: 限定在工作区内 —— file_exists 路径可为绝对/../ 穿越,即便只读(fsp.access)也是任意路径存在性
        // 探测(信息泄露)。仅当解析后落在 cwd 内才判定,越界一律「不适用」(不泄露)。
        const base = path.resolve(cwd || '.');
        if (p !== base && !p.startsWith(base + path.sep)) return { pass: false, detail: '路径超出工作区,已跳过验收' };
        try { await fsp.access(p); return { pass: true, detail: '文件存在: ' + check.path }; }
        catch { return { pass: false, detail: '文件不存在: ' + check.path }; }
      }
      if (check.type === 'command') {
        if (!String(check.cmd || '').trim()) return { pass: false, detail: '空命令' };
        // shell:true 让整条命令串按用户书写执行(判定性只读用途;超时 60s;工作区 cwd)。
        const r = await runProcess(String(check.cmd), [], { timeoutMs: 60000, cwd: cwd || process.cwd(), shell: true }).catch(e => ({ code: -1, stdout: '', stderr: String(e && e.message || e) }));
        const out = String((r.stdout || '') + (r.stderr || ''));
        const codeOk = Number(r.code) === 0;
        const expectOk = check.expect ? out.includes(String(check.expect)) : true;
        return { pass: codeOk && expectOk, detail: `退出码=${r.code}${check.expect ? (expectOk ? ' · 命中期望' : ' · 未命中期望「' + check.expect + '」') : ''}` };
      }
    } catch (e) { return { pass: false, detail: '验收异常: ' + String(e && e.message || e).slice(0, 200) }; }
    return null;
  }

  return { buildMissionResult, archiveMissionResult, maybeFinalizeMission, finalizeMissionAfterTurn, mergeMissionBeforeSave, evaluateMissionCheck };
}

module.exports = { createMissionLifecycle };
