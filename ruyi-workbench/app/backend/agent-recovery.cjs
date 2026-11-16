'use strict';
const fsp = require('node:fs/promises');

function createAgentRecovery({
  agentRunsRoot, isWriteTool, safeSessionId, nowIso,
  sessions: { readSessionHeadResilient, applySessionPermissionModeOverride, resolvePermissionMode },
  runs: { listAgentRuns, syncRunEventSeq, appendAgentRunEvent, saveAgentRun },
  execution: { hasLiveRun, launchPersistedAgentRun },
  interventions: { settleIntervention, readInterventions, registerIntervention },
  readConfig, notifyInterruptedRun,
}) {
// ============================================================================
// 第29波(§29b 自动恢复分级):节点续跑危险度。纯函数,只看持久化字段,不碰运行时。红线(AUTONOMY-PLAN §6):
// 崩溃恢复绝不盲目重放不可逆副作用 —— 判定原则:
//   safe   = 重跑不会重放不可逆副作用:wait 等待节点(零副作用,不进 runNode)/ 确定性质量门(vote|dedupe,
//            无模型无工具)/ read 层(工具面无写)/ OpenAI edit 层【且】无已执行写证据(将来的写有 journal 回滚 +
//            file_write 幂等跳过兜底);
//   manual = exec 层一律(命令副作用不可审计不可回滚,worktree 圈不住 shell,continuation 也证不了没执行过)
//            / OpenAI edit 层已有确认写证据(artifacts 非空或 continuation 写族 ok 步)/ Claude 引擎任何可写或可 exec
//            节点(见对抗轮 P1/P2)。
// 对抗轮 P1(#17,与第27波 field-shadow 同类根因): 危险度必须按【真正决定执行能力的字段】判,不是 node.toolTier。
// Claude 引擎节点的实际工具面是 role.claudeTools(runClaudeSubAgentOnce:非空则完全无视 toolTier;为空才落 tier 默认,
// 而 exec tier 默认=[] 即【不限制】=含 Bash)。于是 toolTier:'edit' 但 claudeTools 携 Bash 的节点会以 bypass 跑 shell,
// 旧实现却因 tier==='edit' 判 safe —— exec 能力藏进被判 safe 的节点,自动续跑重放不可逆 shell 副作用,击穿红线。
// 对抗轮 P2(#18): 且 Claude 的 Write/Edit 由 CLI 直接落盘,工作台【无 journal 回滚、无 file_write 幂等跳过】——
// "edit 重放安全"的依据只对 OpenAI 进程内 toolCall 成立。故 Claude 引擎【任何可写或可 exec 节点一律 manual】,
// 只有纯读 Claude 节点(及 wait/gate)才 safe。OpenAI 侧 toolTier 由 nativeToolGate 运行时硬enforce(越级拒),
// 故其 edit-证据逻辑仍有效。工具名内联为字面量(保纯函数自洽 + field-shadow 教训:显式,不 OR-merge)。
const CLAUDE_EXEC_TOOLS = new Set(['Bash', 'BashOutput', 'KillBash']);
const CLAUDE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
function classifyNodeResumeRisk(node) {
  if (!node || typeof node !== 'object') return { safe: true, reason: '' };
  if (node.wait) return { safe: true, reason: 'wait' };
  const gateMode = node.gate && node.gate.mode;
  if (gateMode && ['vote', 'dedupe', 'coverage', 'propagate'].includes(gateMode)) return { safe: true, reason: 'gate' };
  const tier = node.toolTier === 'exec' ? 'exec' : (node.toolTier === 'edit' ? 'edit' : 'read');
  if (tier === 'exec') return { safe: false, reason: 'exec_tier' };
  // Claude 引擎:按真实 allowedTools 判(role.claudeTools 优先,空则 tier 默认;exec tier 默认=[] 即不限制)。
  if ((node.engine || 'openai') === 'claude') {
    const role = node.roleSnapshot || null;
    const declared = role && Array.isArray(role.claudeTools) && role.claudeTools.length ? role.claudeTools : null;
    // 声明为空 + exec/edit tier 会落到含 Bash(exec 无限制)或 Write/Edit(edit 默认)的 tier 默认集 —— 一律按可写/可exec 处理。
    if (!declared) { if (tier !== 'read') return { safe: false, reason: 'claude_tier_writes' }; return { safe: true, reason: 'read' }; }
    if (declared.some(t => CLAUDE_EXEC_TOOLS.has(t))) return { safe: false, reason: 'claude_exec_tool' };
    if (declared.some(t => CLAUDE_WRITE_TOOLS.has(t))) return { safe: false, reason: 'claude_write_no_journal' };
    return { safe: true, reason: 'claude_read' };
  }
  // OpenAI 引擎:tier 运行时硬enforce,edit 有 journal+幂等兜底 —— 保留证据逻辑。
  if (tier === 'edit') {
    const steps = (node.continuation && Array.isArray(node.continuation.steps)) ? node.continuation.steps : [];
    const pend = (node.continuation && node.continuation.pending && typeof node.continuation.pending === 'object') ? Object.values(node.continuation.pending) : [];
    // 对抗轮 P2(#18): 也扫 continuation.pending —— 崩溃瞬间在途的写(tool_use 已发、tool_result 未回,未晋升 steps)
    // 停在 pending,只扫 steps 会把"正在写"的 edit 节点误判 safe。pending 步无 ok 字段(尚未落定),命中写族即算已写。
    const wrote = (Array.isArray(node.artifacts) && node.artifacts.length > 0)
      || steps.some(s => s && s.ok !== false && isWriteTool(s.tool))
      || pend.some(s => s && isWriteTool(s.tool));
    if (wrote) return { safe: false, reason: 'edit_confirmed_writes' };
  }
  return { safe: true, reason: tier };
}
// run 级聚合:按 full-resume 的 reset 语义(非 succeeded 全重排,镜像 runAgentWorkflow existingRun 分支)逐节点
// 分级;任一危险节点 → 整 run manual(调度器不支持按节点 hold,部分续跑会径直跑进危险节点)。权限面变化
// (permissionModeAtLaunch ≠ 恢复时 config.permissionMode)→ manual:恢复用的是【恢复时】的模式
// (launchPersistedAgentRun 传 permModeOverride),不同 = 权限面静默变更,无人值守下不自动放行(方案原文:
// "涉外部副作用或权限变化只恢复到暂停态")。老 run 无该字段则跳过此信号(分级要可用,不因缺字段一刀切)。
// 2026-10:工作流跑在【它所在线程】的生效权限档(会话级 > 全局,resolvePermissionMode),不是全局档 —— 修前 HTTP 启动
// 与续跑都直接取 config.permissionMode,线程在自己的权限 chip 上收紧过也照全局放。恢复分级用同一个值比对,否则「线程档
// 放宽了、全局档没变」会被判成权限面没变而自动续跑。
async function agentRunPermissionMode(sessionId, config) {
  const head = safeSessionId(sessionId) ? await readSessionHeadResilient(sessionId).catch(() => null) : null;
  // 头读路径绕过 loadSession,要自己盖一层会话级权限档的内存覆盖(活回合中途切档、还没落盘时以它为准;同 13j stewardReadSessionHead)。
  return resolvePermissionMode({ session: head && typeof head === 'object' ? applySessionPermissionModeOverride(head) : head, config });
}
function classifyRunResumeTier(run, currentPermissionMode) {
  const reasons = [];
  if (run && run.kind === 'steward_delegation') reasons.push({ nodeId: '', reason: 'delegation_result_unknown' });
  for (const n of (Array.isArray(run && run.nodes) ? run.nodes : [])) {
    if (n.status === 'succeeded') continue;
    const risk = classifyNodeResumeRisk(n);
    if (!risk.safe) reasons.push({ nodeId: n.id, reason: risk.reason });
  }
  const modeAtLaunch = String(run && run.permissionModeAtLaunch || '');
  if (modeAtLaunch) {
    if (currentPermissionMode && String(currentPermissionMode) !== modeAtLaunch) reasons.push({ nodeId: '', reason: 'permission_mode_changed' });
  } else {
    // 对抗轮 P2(#19): 缺 permissionModeAtLaunch(wave29 前落盘的旧 interrupted run)无法证明"恢复权限面 ≤ 首跑权限面"
    // —— 权限拓宽护栏对它整段失效。fail-safe:含非纯读节点时按 manual(证不了没升权就别自动跑)。纯读/wait/gate-only
    // run 无副作用面,缺字段也可自动。不一刀切全 manual(否则老 run 全卡),只在有真实副作用面时保守。
    const hasSideEffectFace = (Array.isArray(run && run.nodes) ? run.nodes : []).some(n => n && n.status !== 'succeeded' && (n.toolTier === 'edit' || n.toolTier === 'exec'));
    if (hasSideEffectFace) reasons.push({ nodeId: '', reason: 'permission_mode_unknown' });
  }
  return { tier: reasons.length ? 'manual_resume_required' : 'auto_resumable', reasons: reasons.slice(0, 16) };
}
// boot 自动恢复(opt-in,config.autonomyAutoResume,默认 false)。跑在 markInterruptedAgentRuns【之后】:
// 安全(auto_resumable)的 interrupted run 自动续跑;危险 run 置 paused + run_resume_deferred 事件(UI 可见
// "等人",且下次 boot 被 markInterruptedAgentRuns 的 paused 跳过分支放过,不反复处理)。崩溃环保护:每次自动
// 续跑 +1 autoResumeCount 并【先落盘再启动】,护栏写不进盘就不启动(fail-closed —— run 本身可能就是崩溃根因,
// 无限重启环比不恢复更糟);≥AUTO_RESUME_MAX 次后降 manual。人工 resume 不受此限。
const AUTO_RESUME_MAX = 2;
// 第40波:小并发池 —— boot 恢复扫描专用。工作项(run 级)相互独立(写链/事件链按 run.id 串行,live 复检
// 在决策点即时做),并发只压盘 IO 等待,不改语义。上限 4:盘 IO 并发收益饱和点,再大只增抖动。
async function autoResumeInterruptedRuns() {
  let config; try { config = await readConfig(); } catch { return; }
  if (config.autonomyAutoResume !== true) return;
  let sessionDirs = []; try { sessionDirs = await fsp.readdir(agentRunsRoot, { withFileTypes: true }); } catch { return; }
  // 第40波:先并发收集全部 (sessionId, interruptedRun) 工作项,再池化处理 —— 旧顺序 for 的每 run 成本
  // (事件文件读 + 快照写)叠加成分钟级尾延迟。launchPersistedAgentRun 是 void 派发(不等 run 完成),
  // 并发不会串起引擎进程尖峰(顺序循环的启动本来也就是背靠背)。
  const workItems = [];
  await mapPool(sessionDirs.filter(d => d.isDirectory() && safeSessionId(d.name)), 4, async dirent => {
    const runs = await listAgentRuns(dirent.name).catch(() => []);
    for (const run of runs) if (run && run.status === 'interrupted') workItems.push({ sessionId: dirent.name, run });
  });
  await mapPool(workItems, 4, async ({ sessionId, run }) => {
      // 对抗轮 P2(#2): boot 自动恢复与 HTTP 服务并发 —— 用户在 UI 重连后手动 resume 同一 run,已注册 live 并开始
      // append 事件;此处若继续用手里这份【陈旧对象】append(seq 与 live 对象重号,破坏严格单调硬承诺 + 客户端按
      // seq 去重静默吞一条)、saveAgentRun(把 interrupted 时代节点状态覆盖 live 最新快照,崩溃后二次重放)就出错。
      // listAgentRuns 到本次处理之间有 syncRunEventSeq 等 await 窗口,故【每个 run append/save 前】即时复检 live 注册:
      // 已 live = 用户/上一轮已接管,跳过(launchPersistedAgentRun 的 9345 has 守卫只拦启动,拦不住这些前置写)。
      if (hasLiveRun(run.id)) return;
      const cls = classifyRunResumeTier(run, await agentRunPermissionMode(sessionId, config));
      const attempts = Number(run.autoResumeCount) || 0;
      await syncRunEventSeq(run); // 装载点纪律:append 前快进(见 syncRunEventSeq 注释)
      if (hasLiveRun(run.id)) return; // syncRunEventSeq 的 await 后再复检一次(窗口内可能刚被手动 resume 接管)
      if (cls.tier === 'auto_resumable' && attempts < AUTO_RESUME_MAX) {
        run.autoResumeCount = attempts + 1;
        run.resumeTier = 'auto_resumable'; run.resumeTierReasons = [];
        appendAgentRunEvent(run, { type: 'run_auto_resume', data: { attempt: run.autoResumeCount } });
        let guardPersisted = true;
        try { await saveAgentRun(run); } catch { guardPersisted = false; }
        if (!guardPersisted) return; // fail-closed: 崩溃环护栏没落盘,不自动续跑
        await launchPersistedAgentRun({ sessionId, runId: run.id, configOverride: config }).catch(() => {});
      } else {
        run.resumeTier = 'manual_resume_required';
        run.resumeTierReasons = (cls.tier === 'auto_resumable') ? [{ nodeId: '', reason: 'auto_resume_loop' }] : cls.reasons;
        run.status = 'paused'; run.pauseRequestedAt = nowIso();
        appendAgentRunEvent(run, { type: 'run_resume_deferred', data: { tier: run.resumeTier, reasons: run.resumeTierReasons } });
        await saveAgentRun(run).catch(() => {});
      }
  });
}
async function markInterruptedAgentRuns() {
  let bootConfig = null; try { bootConfig = await readConfig(); } catch { /* 分级戳降级为跳过,标死不受影响 */ }
  let sessionDirs = []; try { sessionDirs = await fsp.readdir(agentRunsRoot, { withFileTypes: true }); } catch { return; }
  // 第40波:与 autoResumeInterruptedRuns 同款并发化 —— 先并发收集 (sessionId, run) 工作项再池化处理。
  const workItems = [];
  await mapPool(sessionDirs.filter(d => d.isDirectory() && safeSessionId(d.name)), 4, async dirent => {
    const runs = await listAgentRuns(dirent.name).catch(() => []);
    for (const run of runs) if (run) workItems.push(run);
  });
  // 71b: paused run 的 proposed 池提案在 71b 前没有 Intervention 记录 —— 收集后统一对账补登记(见 mapPool 后)。
  const legacyPoolProposed = []; // { sessionId, runId, item }
  await mapPool(workItems, 4, async run => {
      // 团队模式 v2: waiting_pool(收尾宽限窗)也是活跃 live 态,进程重启后同样是"未清理的孤儿",一并标中断。
      // 对抗轮 P3: paused run 不标中断(resume 仍可续跑),但内存邮箱同样已随进程消失——未投递消息补标 dropped,
      // 否则 UI 邮箱时间线里这些消息永远显示"待投递"(与 P3-1 诚实标记原则对齐)。
      if (run.status === 'paused') {
        let dirty = false;
        for (const m of (Array.isArray(run.messages) ? run.messages : [])) if (m && !m.deliveredAt && !m.dropped) { m.dropped = true; dirty = true; }
        // 71b: proposed 提案在 paused run 里恢复后仍可审批 —— 收集起来,稍后对账补登记 Intervention(幂等)。
        for (const p of (Array.isArray(run.taskPool) ? run.taskPool : [])) if (p && p.status === 'proposed') legacyPoolProposed.push({ sessionId: run.sessionId, runId: run.id, item: p });
        // 29b 顺手修(测绘发现): boot 期间快照写失败(磁盘满/杀软锁)此前会把整个 startServer 炸掉 ——
        // 诚实标记是 best-effort,boot 必须活着;持久化降级横幅由 saveAgentRun 内部计数兜底。下同。
        if (dirty) await saveAgentRun(run).catch(() => {});
        return;
      }
      if (run.status !== 'running' && run.status !== 'waiting_pool') return;
      run.status = 'interrupted'; run.interruptedAt = nowIso(); run.poolGraceUntil = 0;
      for (const p of (Array.isArray(run.taskPool) ? run.taskPool : [])) if (p && p.status === 'proposed') { p.status = 'expired'; p.decidedBy = 'auto'; p.decidedAt = nowIso(); settleIntervention(run.sessionId, p.id, 'expired', { decidedBy: 'auto', note: 'run interrupted at boot' }); }
      // 团队模式 v2 (P3-1): 与池提案 expire 对称——进程重启中断的 run,把从未投递(deliveredAt:null)且未标记的消息补标
      // dropped(内存邮箱队列已随进程消失,这些消息不可能再投递,诚实标记)。
      for (const m of (Array.isArray(run.messages) ? run.messages : [])) if (m && !m.deliveredAt && !m.dropped) m.dropped = true;
      for (const node of (run.nodes || [])) {
        if (node.status === 'running') {
          node.status = 'interrupted'; node.error = '应用在节点运行期间退出'; node.errorClass = 'interrupted'; node.completedAt = nowIso();
          // 25.4: 记下被中断的 attempt —— 恢复重跑时,仅当 continuation 属于这个 attempt 才注入【断点续跑】
          // (区别于 retry/loop 的常规重排,那些不该带"上次已完成勿重复"语义)。
          if (Number(node.attempts) > 0) node.interruptedAttempt = Number(node.attempts);
        }
        else if (node.status === 'queued' || node.status === 'waiting_resource') { node.status = 'blocked'; node.error = '工作流已中断，尚未执行'; node.errorClass = 'blocked'; node.waitingForResources = []; }
      }
      // 29b: 中断时就盖恢复分级戳(UI 有 tier 徽章可看;autoResumeInterruptedRuns 决策时【重算】,戳只做展示,
      // 不做信任来源 —— 分级函数才是单一事实源)。config 读不到则跳过,标死不受影响。
      if (bootConfig) { const cls = classifyRunResumeTier(run, await agentRunPermissionMode(run.sessionId, bootConfig)); run.resumeTier = cls.tier; run.resumeTierReasons = cls.reasons; }
      await syncRunEventSeq(run);   // 对抗轮修: 崩溃窗口(事件已落、快照没跟上)装载旧 eventSeq → 先快进再 append
      appendAgentRunEvent(run, { type: 'run_interrupted', data: { nodes: (run.nodes || []).filter(n => n.status === 'interrupted').map(n => n.id) } });
      await saveAgentRun(run).catch(() => {}); // 29b 顺手修: boot 防炸(同上)
      // 模型以 background:true 起的 run 被重启打断、又不会自动续跑:补一份 interrupted 信封进后台任务账本 —— 修前模型对用户说过
      // 「代理在后台跑」,之后再没有任何人告诉它这些代理已经没了。信封在用户下一句话时随回合开头送达(interrupted 不唤醒,见 10)。
      if (run.background === true && !(bootConfig && bootConfig.autonomyAutoResume === true)) {
        try { notifyInterruptedRun(run); } catch { /* 旁路,boot 防炸 */ }
      }
  });
  // 71b: 存量对账 —— 71b 前落盘的 paused run 可能有 proposed 池提案但无 Intervention 记录(当时池未接入旁路)。
  // boot 补登记(append-only,幂等:已有记录的 id 跳过),否则 missionPendingCounts 统一从 Intervention 读池未决后
  // 会漏掉这些存量提案。登记后由 markInterruptedInterventions 的 pool 分流保留 pending(run paused,恢复后可审批)。
  const backfillBySession = new Map();
  for (const e of legacyPoolProposed) {
    if (!backfillBySession.has(e.sessionId)) backfillBySession.set(e.sessionId, []);
    backfillBySession.get(e.sessionId).push(e);
  }
  for (const [sid, entries] of backfillBySession) {
    const ivs = await readInterventions(sid).catch(() => []);
    const known = new Set(ivs.map(iv => String(iv && iv.id || '')));
    for (const e of entries) {
      const pid = String(e.item && e.item.id || '');
      if (!pid || known.has(pid)) continue;
      registerIntervention(sid, 'pool', pid, { runId: String(e.runId || ''), proposedBy: String(e.item.proposedBy || ''), task: String(e.item.task || '').slice(0, 500), backfilled: true });
    }
  }
}

  return { classifyNodeResumeRisk, classifyRunResumeTier, agentRunPermissionMode, autoResumeInterruptedRuns, markInterruptedAgentRuns };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
module.exports = { createAgentRecovery, mapPool };
