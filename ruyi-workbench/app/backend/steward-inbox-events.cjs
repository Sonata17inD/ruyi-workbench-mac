'use strict';

// ── 归一化/合并常量 ──────────────────────────────────────────────────────────
// §11.3:同 sessionId 同 kind(同 runId)窗口内合并为一条。117m-A1:5s → 30s。5 秒窗口在真机上几乎
// 不合并任何东西 —— 同一条线程的失败/停滞信号往往隔十几秒才来第二条,于是管家一条一条汇报、一条起
// 一个回合(用户第六轮走查②「管家还是会一条条汇报,没有必要还费 Token」)。纯批处理收益:分组键
// (sessionId\0kind\0runId)与「同类 N 条」文案一字未动,只是把攒批的窗口拉长。
const STEWARD_MERGE_WINDOW_MS = 30000;
const STEWARD_SUMMARY_CHARS = 200;         // payload 摘要硬顶(与 STEWARD_DIGEST_LIMITS.lastSayChars 同数)
const STEWARD_MERGED_SEQS_MAX = 20;        // 合并行里回填的源 seq 上限(供重启重建去重集合)

function createStewardInboxEvents({ STEWARD_EVENT_KINDS, stewardSanitizeText, stewardCoveringLastTurn }) {
  // ────────────────────────────────────────────────────────────────────────────
  // 源事件 → 五类白名单的【唯一】映射表。
  //
  // 纪律(dev-harness/steward-events.static.e2e.js 机械对账):三个源在源码里写入端出现过的【每一个】
  // type 字面量都必须在本表里登记 —— 登记为 null 也算登记。加了新事件却不登记 = 门红。
  // 值的取值:五类之一('needs_you'|'failed'|'done'|'stalled'|'budget')、null(明确丢弃)、
  // 或 '@<resolver>'(同一 type 的语义由 payload 决定,见下方三个 stewardResolve* 纯函数)。
  // ────────────────────────────────────────────────────────────────────────────
  const STEWARD_SOURCE_EVENT_MAP = Object.freeze({
    // ① Mission Change Ledger(02-session-store.js 的 MISSION_CHANGE_TYPES,9 种)
    missionChange: Object.freeze({
      mission_started: null,        // 新建任务账本,不是五类中任一(管家从总览就知道有这条线程)
      progress: null,               // 每回合一条的常规推进 = 心跳,按 §11.3「心跳丢弃」
      failure: 'failed',            // 回合失败(errorClass 在 detail 里)
      budget: null,                 // ← 用量入账(00-boot appendUsageLedger 的每回合 turn 行),是心跳不是触顶;
                                    //   真正的「预算触顶」由投影的 card.mission.budgetExhausted 承载(见 projection)
      intervention_pending: null,   // ← needs_you 统一由投影产出(去重键=interventionId),此处再产一次会双份
      intervention_resolved: null,  // 待决已解决 = 不再需要你,不入箱(投影侧 pendingIds 会自然移除)
      result: '@missionResult',     // 结果章:complete → done;stopped 带错误 → failed;stopped 无错误 → done
      rewind: null,                 // 回退检查点是用户自己的动作
      run_deleted: null,            // 删运行记录是用户自己的动作
      // 116-2b 新增(补 116b 登记的缺口):普通回合的两类信号,由 02 的写入端落账(带频控)。
      stalled: 'stalled',           // 主回合死循环纠偏等"还在跑但没往前走"(同会话 5 分钟一条)
      budget_tripped: 'budget',     // 回合 token 预算保护触顶(每回合最多一条;与心跳 'budget' 分开)
      // 116g:线程加入/移出事项、事项合并/拆分。它是【归属变更】,不是五类信号中的任何一个 ——
      // 用户自己(或管家替他)刚做完这个动作,不需要再被"通知"一次。登记为 null = 显式丢弃。
      mission_membership: null,
    }),
    // ② agent run 事件日志(全 src 扫 appendAgentRunEvent 的 type 字面量,22 种)
    agentRun: Object.freeze({
      run_created: null,            // 班组起跑
      run_end: '@runEnd',           // succeeded/stopped → done;failed/partial → failed
      run_paused: null,             // reason: 'user'(用户自己按的)/'persistence_degraded'(与下面的
                                    //   persistence_degraded 同一事实,只登记一次,避免双份)
      run_resumed: null,
      run_resume_requested: null,
      run_resume_deferred: 'stalled',   // 重启后按 resumeTier 不敢自动续 → 停在半路等你
      run_auto_resume: null,
      run_interrupted: 'stalled',       // 进程重启把 run 打断,停在半路
      run_stop_requested: null,
      run_pool: null,               // 任务池提案 → needs_you 由投影的 pool Intervention 统一产出
      run_replan: null,             // 重规划提案 → replan 不在四类待决白名单(§3.1),本波不入箱
      node_start: null,
      node_progress: null,          // 节点里程碑,高频进度
      node_wait: null,
      node_settled: '@nodeSettled', // status failed/rejected → failed;其余(succeeded/skipped/…)丢弃
      node_requeued: null,          // 与 node_settled 同一行三元表达式的另一支
      node_wrapup_requested: null,
      node_wrapup_forced: null,
      node_idle_aborted: 'stalled',      // 节点空闲超时被中止 = 停滞
      node_no_progress_aborted: 'stalled', // 语义死循环被中止 = 停滞
      persistence_degraded: 'failed',    // 快照连续写失败 = 硬故障
      persistence_recovered: null,
      // 116-2b 新增(补 116b 登记的缺口):班组内的两类信号,由 09 的节点事件壳落账(频控在 08 写入端)。
      run_stalled: 'stalled',            // subagent_no_progress / loop_recovery(同 run 5 分钟一条)
      run_budget_tripped: 'budget',      // 节点工具迭代预算耗尽(按节点天然去重)
    }),
    // ③ 待决投影里的 Intervention 类型(全 src 扫 registerIntervention 的 type 字面量,5 种)
    intervention: Object.freeze({
      permission: 'needs_you',
      question: 'needs_you',
      plan: 'needs_you',
      pool: 'needs_you',
      replan: null,                 // §3.1 四类待决只有 permission/question/plan/pool;replan 归 116-2
    }),
    // ④ 投影派生(没有对应的源事件 type,由 mission card 的持久标记推出)
    projection: Object.freeze({
      budget_exhausted: 'budget',   // m.budgetExhaustedAt 是一次性持久标记 → 每个事项只入箱一次
    }),
    // ④' 第四源 sessionTurns(116-4,27 号文 §11.7)。它没有「源码写入端的 type 字面量」可对账
    //    —— 事实来自会话头本身(turnSeq 前进 + 无活回合 = 这条线程的一个回合结束了),故与 projection
    //    一样【不】参与 116b 静态锁的三条双向等集判定,只在这里登记一条,让「新信号必须有人登记」这条
    //    纪律不被沉默绕过。语义由 payload(会话头上的 stewardLastTurn)决定,见 @sessionTurn 解析器。
    sessionTurn: Object.freeze({
      turn_settled: '@sessionTurn',
    }),
    // ④'' 第五源 threadAdopted(121-K3,34 号文 §4.4「交接」)。与上面两组同处境:没有「源码写入端的
    //    type 字面量」可对账 —— 事实来自用户在界面上按下的那枚「交给管家盯」(PATCH /api/sessions/:id
    //    写 stewardWatch:true,02 落盘后派一条 RUYI_EVENTS 的 thread.adopted{by:'user'})。本文件订阅
    //    那条总线事件、排进下一拍(见 stewardQueueThreadAdopted),故【不】参与 116b 静态锁的三条双向
    //    等集判定,只在这里登记一条,让「新信号必须有人登记一次」这条纪律不被沉默绕过。
    //    为什么不是 needs_you:用户把活交给管家【不是】一件等着用户拿主意的事,恰恰相反。
    //    为什么不复用 done:它也不是收工。第六类 adopted 是它自己,见 06i 的 STEWARD_EVENT_KINDS。
    threadAdopted: Object.freeze({
      thread_adopted: 'adopted',
    }),
    // ⑤ 只走 SSE、【故意】不落任何持久日志的进度信号(116-2b 登记)。收件箱只读三条带 seq 的持久
    //    日志,故这里的东西不可能入箱 —— 登记为 null 是为了让"新信号必须有人登记一次"这条纪律不被
    //    沉默绕过:下一个人加进度事件时,至少要来这张表里写一行"它是进度,不是信号"。
    //    这一组【不参与】116b 静态锁的三条双向等集判定(它扫的是三个持久写入端,这里没有写入端)。
    sseOnly: Object.freeze({
      adaptive_tool_budget: null,   // 子代理工具迭代预算自适应扩容 = 进度(还在往前走),不是触顶
    }),
  });

  // 只在这四个源事件里出现、但语义由 payload 决定的三个纯函数解析器(表里以 '@name' 指向)。
  function stewardResolveMissionResultKind(detail) {
    const d = (detail && typeof detail === 'object') ? detail : {};
    const status = String(d.status || '');
    if (status === 'complete') return 'done';
    if (status === 'stopped') {
      // 「结果章 stopped 且带错误」→ failed;用户主动收工(无错误)→ done(终态,报一次)。
      if (d.errorClass || d.error || Number(d.failed) > 0) return 'failed';
      return 'done';
    }
    return null;
  }
  function stewardResolveRunEndKind(data) {
    const status = String((data && data.status) || '');
    if (status === 'succeeded' || status === 'stopped') return 'done';
    if (status === 'failed' || status === 'partial') return 'failed';
    return null;
  }
  function stewardResolveNodeSettledKind(data) {
    const status = String((data && data.status) || '');
    return (status === 'failed' || status === 'rejected') ? 'failed' : null;
  }
  // 116-4:会话头上的 stewardLastTurn(13g 在回合 settle 之后落的账)-> done | failed。
  // 账缺席一律 done:「跑完了」这件事本身是真的(turnSeq 真的前进了),成败让管家自己去读线程 ——
  // 绝不拿会话头 summary 里那句人话去猜(实测那是渲染,不是信号)。
  // 用户主动停(aborted)按 done:与 @runEnd 的 'stopped' -> done 同口径,自己按的停不是故障。
  function stewardResolveSessionTurnKind(last) {
    if (!last || typeof last !== 'object') return 'done';
    return (last.ok === false && last.aborted !== true) ? 'failed' : 'done';
  }
  const STEWARD_KIND_RESOLVERS = Object.freeze({
    '@sessionTurn': stewardResolveSessionTurnKind,
    '@missionResult': stewardResolveMissionResultKind,
    '@runEnd': stewardResolveRunEndKind,
    '@nodeSettled': stewardResolveNodeSettledKind,
  });

  // 表查询:返回五类之一或 null。未登记的 type 一律 null(丢弃)并由静态门在下一次改动时报红。
  function stewardKindFor(source, type, payload) {
    const table = STEWARD_SOURCE_EVENT_MAP[source];
    if (!table || !Object.prototype.hasOwnProperty.call(table, String(type))) return null;
    const value = table[String(type)];
    if (value == null) return null;
    if (typeof value === 'string' && value.startsWith('@')) {
      const resolver = STEWARD_KIND_RESOLVERS[value];
      return resolver ? resolver(payload) : null;
    }
    return STEWARD_EVENT_KINDS.includes(value) ? value : null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 纯函数区(不碰磁盘、不读配置):归一化 / 去重键 / 合并。单测 unit/steward-inbox-core.test.js 直测。
  // 入参一律是普通对象,不依赖任何源模块的运行时状态。
  // ────────────────────────────────────────────────────────────────────────────
  function stewardClipSummary(value) {
    const text = stewardSanitizeText(value).trim();
    return text.length > STEWARD_SUMMARY_CHARS ? text.slice(0, STEWARD_SUMMARY_CHARS) + '…' : text;
  }

  function stewardIsoAt(value) {
    const text = String(value == null ? '' : value);
    return Number.isFinite(Date.parse(text)) ? text : new Date(0).toISOString();
  }

  // 去重键 = sessionId + kind + runId + seq(§11.3「去重键 sessionId+kind+seq」;needs_you 的 seq
  // 位就是 interventionId,budget 的 seq 位是 'exhausted@<用尽时刻>' —— 二者都是各自源的稳定游标)。
  function stewardEventDedupeKey(evt) {
    const e = (evt && typeof evt === 'object') ? evt : {};
    return [String(e.sessionId || ''), String(e.kind || ''), String(e.runId || ''), String(e.seq)].join('\u0000');
  }

  // 125-P1(42 号文 §1 ②):下面三处 failed 摘要不再把 errorClass 拼进括号。机器词仍然原样落在
  // payload.errorClass 上(去重、取证、前端都要它),但【给模型看的那一行】由 13p 的
  // stewardEventLine 统一补上人话与下一步(取话口是 06i 的 stewardFailureExplain,查的是 06
  // 那张既有 ERROR_CLASSES)。修前模型拿到的是 `会话第 3 回合失败(idle_timeout)` 这串原始
  // 机器词,「这是什么意思、该怎么办」只能它自己编 —— 而工作台自己就有写好的答案。
  // ① Mission Change Ledger 的一条 change record → 归一化事件 | null
  function stewardNormalizeMissionChange(record) {
    const r = (record && typeof record === 'object') ? record : {};
    const seq = Number(r.seq);
    if (!Number.isSafeInteger(seq) || seq < 1) return null;
    const detail = (r.detail && typeof r.detail === 'object') ? r.detail : {};
    const cursor = (r.cursor && typeof r.cursor === 'object') ? r.cursor : {};
    const kind = stewardKindFor('missionChange', r.type, detail);
    if (!kind) return null;
    const payload = { source: 'mission_change', changeType: String(r.type || '') };
    if (detail.errorClass) payload.errorClass = stewardClipSummary(detail.errorClass);
    if (detail.status) payload.resultStatus = stewardClipSummary(detail.status);
    if (cursor.turnSeq != null) payload.turnSeq = Number(cursor.turnSeq) || 0;
    if (cursor.engine) payload.engine = stewardClipSummary(cursor.engine);
    // 116-2b:两个新 type 的摘要只取 detail 里的计数与原因(reason/tool/count/spent/budget),
    // 与 failure 同纪律 —— 永不带工具输出正文。
    if (detail.reason) payload.reason = stewardClipSummary(detail.reason);
    if (detail.tool) payload.tool = stewardClipSummary(detail.tool);
    if (detail.count != null) payload.count = Number(detail.count) || 0;
    if (detail.spent != null) payload.spent = Number(detail.spent) || 0;
    if (detail.budget != null) payload.budget = Number(detail.budget) || 0;
    payload.summary = stewardClipSummary(
      r.type === 'stalled'
        ? `会话停住了(${payload.reason || '无进展'}${payload.tool ? ' · ' + payload.tool : ''}${payload.count ? ' · 第 ' + payload.count + ' 次' : ''})`
        : r.type === 'budget_tripped'
          ? `回合 token 预算触顶(已用 ${payload.spent}/${payload.budget})`
          : kind === 'failed'
            ? `回合失败`
            : `任务结果章:${payload.resultStatus || ''}`);
    return {
      kind,
      sessionId: String(r.sessionId || ''),
      missionId: String(r.missionId || r.sessionId || ''),
      runId: '',
      seq,
      at: stewardIsoAt(r.occurredAt),
      payload,
    };
  }

  // ② agent run 事件 → 归一化事件 | null
  function stewardNormalizeRunEvent(sessionId, missionId, runId, evt) {
    const e = (evt && typeof evt === 'object') ? evt : {};
    const seq = Number(e.seq);
    if (!Number.isSafeInteger(seq) || seq < 1) return null;
    const data = (e.data && typeof e.data === 'object') ? e.data : {};
    const kind = stewardKindFor('agentRun', e.type, data);
    if (!kind) return null;
    const payload = { source: 'agent_run', eventType: String(e.type || '') };
    if (e.nodeId) payload.nodeId = stewardClipSummary(e.nodeId);
    if (data.status) payload.runStatus = stewardClipSummary(data.status);
    if (data.errorClass) payload.errorClass = stewardClipSummary(data.errorClass);
    if (data.reason) payload.reason = stewardClipSummary(data.reason);
    // 刻意不带 data.text / data.nodes 等正文:payload 只放摘要与引用 id,永不带工具输出全文。
    // 116-2b:run_stalled / run_budget_tripped 的 data 带 reason/tool/count/limit,补进 payload 摘要。
    if (data.tool) payload.tool = stewardClipSummary(data.tool);
    if (data.count != null) payload.count = Number(data.count) || 0;
    if (data.limit != null) payload.limit = Number(data.limit) || 0;
    payload.summary = stewardClipSummary(
      kind === 'done' ? `班组 ${runId} 收工(${payload.runStatus || ''})`
        : kind === 'failed' ? `班组 ${runId} ${payload.nodeId ? '节点 ' + payload.nodeId + ' ' : ''}失败`
          : kind === 'budget' ? `班组 ${runId} ${payload.nodeId ? '节点 ' + payload.nodeId + ' ' : ''}用完了工具迭代预算(${payload.limit} 轮)`
            : `班组 ${runId} ${payload.nodeId ? '节点 ' + payload.nodeId + ' ' : ''}停滞(${payload.eventType}${payload.reason ? ' · ' + payload.reason : ''}${payload.tool ? ' · ' + payload.tool : ''})`);
    return {
      kind,
      sessionId: String(sessionId || ''),
      missionId: String(missionId || sessionId || ''),
      runId: String(runId || ''),
      seq,
      at: stewardIsoAt(e.ts),
      payload,
    };
  }

  // ③ 投影里一条 pending Intervention → 归一化 needs_you 事件 | null
  function stewardNormalizePendingIntervention(sessionId, missionId, iv) {
    const v = (iv && typeof iv === 'object') ? iv : {};
    if (String(v.status || '') !== 'pending') return null;
    const id = String(v.id || '');
    if (!id) return null;
    const type = String(v.type || '');
    const kind = stewardKindFor('intervention', type, v);
    if (!kind) return null;
    const payload = { source: 'projection', interventionId: id, interventionType: type };
    if (v.toolName) payload.toolName = stewardClipSummary(v.toolName);
    if (v.tier) payload.tier = stewardClipSummary(v.tier);
    if (v.runId) payload.runId = stewardClipSummary(v.runId);
    // 一句话摘要:只取各类待决自己的摘要字段(问题原文/计划摘要/池任务),永不带 iv.input(可能含文件正文)。
    const summary = type === 'permission' ? `请求执行工具 ${payload.toolName || '(未知)'}${payload.tier ? ' · ' + payload.tier : ''}`
      : type === 'question' ? String(v.questionSummary || '在问你一个问题')
        : type === 'plan' ? String(v.planSummary || '提交了一份计划等你批')
          : String(v.task || '提了一个新任务等你批');
    payload.summary = stewardClipSummary(summary);
    // 121-K6a(§4.3 安静卡「needs_you 印问句前 22 字」):四类待决都给一句「问句」——前端只管截前 22 字,
    // 这里不重复截,给的是与 summary 同源的完整一句(权限/问题/计划/新任务四支择一)。
    payload.ask = payload.summary;
    // 只在【单问、有选项】这一种最常见形状下再加「候选答案按钮」要的两个 id 与选项表 —— 多问(≤3)
    // 或纯文本题不带,安静卡那时只画「去看」。answerQuestionId 是子问题自己的 id(与外层 interventionId
    // 不同,POST /api/chat/answer 的 answers[].questionId 要它)。
    if (type === 'question' && Array.isArray(v.questions) && v.questions.length === 1) {
      const q0 = v.questions[0] && typeof v.questions[0] === 'object' ? v.questions[0] : null;
      const opts = q0 && Array.isArray(q0.options) ? q0.options : [];
      if (q0 && opts.length) {
        payload.ask = stewardClipSummary(String(q0.question || v.questionSummary || ''));
        payload.answerQuestionId = String(q0.id || '');
        payload.options = opts.slice(0, 6).map(o => ({
          id: String((o && o.id) || ''),
          label: stewardClipSummary(String((o && o.label) || '')),
        })).filter(o => o.id && o.label);
      }
    }
    return {
      kind,
      sessionId: String(sessionId || ''),
      missionId: String(missionId || sessionId || ''),
      runId: String(v.runId || ''),
      seq: id, // needs_you 的去重游标就是 interventionId(同一待决只入箱一次)
      at: stewardIsoAt(v.requestedAt),
      payload,
    };
  }

  // ④ 投影派生:mission card 的预算耗尽标记 → budget 事件 | null(每个事项一次性)
  // ⑤ 用户交接(121-K3,§4.4)-> 归一化事件 | null。来源是总线事件 thread.adopted{by:'user'},
  // 不是磁盘日志 —— 所以它没有 seq 可用,拿【交接时刻】当去重位:同一条线程反复交出去/收回来
  // 是合法的(用户改主意),两次交接必须是两行,而同一次交接重放多少遍都只有一行。
  function stewardNormalizeThreadAdopted(record) {
    const r = (record && typeof record === 'object') ? record : {};
    const sessionId = String(r.sessionId || '');
    if (!sessionId) return null;
    const kind = stewardKindFor('threadAdopted', 'thread_adopted', r);
    if (!kind) return null;
    const at = stewardIsoAt(r.at);
    const title = stewardSanitizeText(r.title || '').slice(0, 120);
    const note = stewardSanitizeText(r.note || '').slice(0, 200);
    // 121-K6a:委托一句缝进人话里——管家下一回合读收件箱摘要时,「盯着」与「盯什么」在同一句里,
    // 不必再去查第二个字段。没带就是老行为(一字不变)。
    const summary = title
      ? `用户把线程「${title}」交给你盯${note ? `,说:「${note}」` : ''}`
      : `用户把一条线程交给你盯${note ? `,说:「${note}」` : ''}`;
    return {
      kind,
      sessionId,
      missionId: String(r.missionId || sessionId),
      runId: '',
      seq: at,
      at,
      payload: {
        source: 'threadAdopted',
        by: 'user',
        title,
        ...(note ? { note } : {}),
        summary: stewardClipSummary(summary),
      },
    };
  }

  function stewardNormalizeBudgetExhausted(sessionId, missionId, card) {
    const c = (card && typeof card === 'object') ? card : null;
    const mission = c && c.mission && typeof c.mission === 'object' ? c.mission : null;
    if (!mission || mission.budgetExhausted !== true) return null;
    const kind = stewardKindFor('projection', 'budget_exhausted', mission);
    if (!kind) return null;
    const budget = (mission.budget && typeof mission.budget === 'object') ? mission.budget : {};
    const spent = (mission.spent && typeof mission.spent === 'object') ? mission.spent : {};
    return {
      kind,
      sessionId: String(sessionId || ''),
      missionId: String(missionId || sessionId || ''),
      runId: '',
      seq: mission.budgetExhaustedAt ? 'exhausted@' + String(mission.budgetExhaustedAt) : 'exhausted',   // 带用尽时刻:任务重启后再次用尽是新的一行
      at: stewardIsoAt(mission.updatedAt || c.updatedAt),
      payload: {
        source: 'projection',
        autoTurns: Number(spent.autoTurns) || 0,
        maxAutoTurns: Number(budget.maxAutoTurns) || 0,
        tokens: Number(spent.tokens) || 0,
        maxTokens: Number(budget.maxTokens) || 0,
        summary: stewardClipSummary(`事项预算已用尽(自动回合 ${Number(spent.autoTurns) || 0}/${Number(budget.maxAutoTurns) || 0})`),
      },
    };
  }

  // ⑤ 116-4 第四源:一条会话的「某个回合结束了」-> done | failed 事件 | null。
  // seq 位就是该会话的 turnSeq(它自己的单调游标),故去重键 = sid|kind|''|turnSeq —— 同一回合只报一次。
  // 【成对改】下面这两句摘要会被前端【逐字】解析(public/js/steward-conversation.js 的
  // STEWARD_INBOX_TURN_RE 靠它抠出回合号去挑那一回合的原文):动这里的措辞必须同刀改那条正则,
  // 只改一边是静默解析失败(前端拿不到回合号只会悄悄退到「最后一条助手话」,不报错)。
  function stewardNormalizeSessionTurn(sessionId, missionId, head, turnSeq) {
    const seq = Math.max(0, Number(turnSeq) || 0);
    if (seq < 1) return null;
    const h = (head && typeof head === 'object') ? head : {};
    // hunt2-steward ④:成败账只在盖得住【这一回合】时才算数(06i stewardCoveringLastTurn)。账是上一个
    // 管家回合留下的(这一回合是用户在 2.0 里自己聊的,不写账)→ 当作账缺席,按 done 报。
    const last = stewardCoveringLastTurn(h.stewardLastTurn, seq);
    const kind = stewardKindFor('sessionTurn', 'turn_settled', last);
    if (!kind) return null;
    const quick = !!(h.stewardQuick && typeof h.stewardQuick === 'object');
    const payload = { source: 'session_turn', turnSeq: seq };
    if (h.launchedBy) payload.launchedBy = stewardClipSummary(h.launchedBy);
    if (quick) payload.quick = true;                       // 13g 的 enrichInboxRows 会给它补 answer
    if (last && last.errorClass) payload.errorClass = stewardClipSummary(last.errorClass);
    if (last && last.aborted === true) payload.aborted = true;
    payload.summary = stewardClipSummary(kind === 'failed'
      ? `会话第 ${seq} 回合失败`
      : `会话第 ${seq} 回合跑完了${payload.aborted ? '(被停止)' : ''}`);
    return {
      kind,
      sessionId: String(sessionId || ''),
      missionId: String(missionId || sessionId || ''),
      runId: '',
      seq,
      at: stewardIsoAt((last && last.at) || h.updatedAt),
      payload,
    };
  }

  // 合并(纯函数):同 sessionId + 同 kind + 同 runId、且距该组【首条】不超过 windowMs 的事件并成一条。
  // 组内:count 累加、at 取最早、seq 取最新;所有被并掉的源 seq 回填进 payload.mergedSeqs
  // (上限 STEWARD_MERGED_SEQS_MAX),供重启时从 inbox 尾部重建完整去重集合。
  //
  // 116-3 P1-7(对抗审查):修前的分组键【不含 runId】,并且命中分组后 `group.payload = {...evt.payload}`
  // 把先到的那条整份覆盖掉 —— 同一会话 5 秒内两个不同 run 的 failed(run_1/nodeX/timeout 与
  // run_2/nodeY/oom)合并后只剩后者,run_1 的 nodeId/errorClass/summary 全部消失,管家永远看不到
  // 「节点 X 因超时失败」。5 秒窗口的本意是「心跳/重复事件收敛」,不是「后到的吞掉先到的不同事件」。
  // 两处修法:① 分组键补上 runId(与去重键同粒度);② payload 以【首条】为准,只把 nodeId /
  // errorClass 累加成 nodeIds / errorClasses 列表(同 run 内多个节点先后失败仍能看全)。
  // 键 -> 列表键。显式写死而不是 key + 's':errorClass 本身以 s 结尾,拼出来会是 errorClasss。
  const STEWARD_MERGE_ACCUMULATE_KEYS = Object.freeze({ nodeId: 'nodeIds', errorClass: 'errorClasses' });
  function stewardMergeAccumulate(base, incoming) {
    const prev = (base && typeof base === 'object') ? base : {};
    const from = (incoming && typeof incoming === 'object') ? incoming : {};
    // 其余字段仍取【最新】(既有口径,116b 的单测把它钉着);只有下面这两个键改成累加列表 ——
    // 它们是「到底是哪一步、因为什么挂的」这条信息的载体,被后到的事件盖掉就等于真的丢了信息。
    const merged = { ...from };
    for (const [key, listKey] of Object.entries(STEWARD_MERGE_ACCUMULATE_KEYS)) {
      const list = Array.isArray(prev[listKey])
        ? prev[listKey].slice()
        : (prev[key] != null && prev[key] !== '' ? [prev[key]] : []);
      const value = from[key];
      if (value != null && value !== '' && !list.includes(value)) list.push(value);
      if (list.length) merged[listKey] = list.slice(0, STEWARD_MERGED_SEQS_MAX);
    }
    return merged;
  }
  function stewardMergeInboxEvents(events, windowMs) {
    const window = Number.isFinite(Number(windowMs)) ? Number(windowMs) : STEWARD_MERGE_WINDOW_MS;
    const rows = (Array.isArray(events) ? events : []).filter(e => e && typeof e === 'object' && STEWARD_EVENT_KINDS.includes(e.kind));
    rows.sort((a, b) => String(a.at).localeCompare(String(b.at))
      || String(a.sessionId).localeCompare(String(b.sessionId))
      || String(a.kind).localeCompare(String(b.kind))
      || String(a.seq).localeCompare(String(b.seq)));
    const open = new Map(); // sessionId\0kind\0runId -> group(116-3 P1-7:分组键补上 runId)
    const out = [];
    for (const evt of rows) {
      const groupKey = String(evt.sessionId || '') + '\u0000' + String(evt.kind || '') + '\u0000' + String(evt.runId || '');
      const at = Date.parse(evt.at);
      const atMs = Number.isFinite(at) ? at : 0;
      const group = open.get(groupKey);
      if (group && atMs - group.__firstMs <= window) {
        group.count += 1;
        group.seq = evt.seq;
        group.payload = stewardMergeAccumulate(group.payload, evt.payload);   // 116-3 P1-7:累加,不整份覆盖
        if (group.__seqs.length < STEWARD_MERGED_SEQS_MAX) group.__seqs.push(evt.seq);
        continue;
      }
      const created = {
        kind: evt.kind,
        sessionId: String(evt.sessionId || ''),
        missionId: String(evt.missionId || evt.sessionId || ''),
        runId: String(evt.runId || ''),
        seq: evt.seq,
        at: evt.at,
        payload: { ...evt.payload },
        count: 1,
        __firstMs: atMs,
        __seqs: [evt.seq],
      };
      open.set(groupKey, created);
      out.push(created);
    }
    return out.map(group => {
      const row = { kind: group.kind, sessionId: group.sessionId, missionId: group.missionId, runId: group.runId, seq: group.seq, at: group.at, payload: group.payload, count: group.count };
      if (group.count > 1) row.payload = { ...row.payload, mergedSeqs: group.__seqs.slice(0, STEWARD_MERGED_SEQS_MAX) };
      return row;
    });
  }

  // 从一条已落盘的 inbox 行还原它覆盖的【全部】去重键(含被合并掉的源 seq)。
  function stewardInboxRowDedupeKeys(row) {
    if (!row || typeof row !== 'object') return [];
    const base = { sessionId: row.sessionId, kind: row.kind, runId: row.runId };
    const seqs = [row.seq];
    const merged = row.payload && Array.isArray(row.payload.mergedSeqs) ? row.payload.mergedSeqs : [];
    for (const seq of merged.slice(0, STEWARD_MERGED_SEQS_MAX)) if (!seqs.includes(seq)) seqs.push(seq);
    return seqs.map(seq => stewardEventDedupeKey({ ...base, seq }));
  }

  return {
    STEWARD_SOURCE_EVENT_MAP, stewardClipSummary, stewardIsoAt, stewardEventDedupeKey,
    stewardNormalizeMissionChange, stewardNormalizeRunEvent, stewardNormalizePendingIntervention,
    stewardNormalizeThreadAdopted, stewardNormalizeBudgetExhausted, stewardNormalizeSessionTurn,
    stewardMergeInboxEvents, stewardInboxRowDedupeKeys,
  };
}

module.exports = { createStewardInboxEvents, STEWARD_MERGE_WINDOW_MS };
