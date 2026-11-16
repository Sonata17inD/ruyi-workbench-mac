'use strict';
const path = require('node:path');
const { irreversibleEntryMetadata } = require('./turn-effect-kinds.cjs');
// Session and mission data rules: no disk I/O or execution lifecycle dependencies.
function createSessionModel({ SESSION_SCHEMA, SKILL_ID_RE, MEMORY_FIXED_SELECTION_HARD_MAX, inferSessionEngineRoute, nowIso }) {
function normalizeSession(raw) {
  const session = (raw && typeof raw === 'object') ? raw : {};
  let changed = false;
  if (session.schemaVersion !== SESSION_SCHEMA) { session.schemaVersion = SESSION_SCHEMA; changed = true; }
  // turnSeq is the session-level monotonic turn counter (checkpoint/rewind/summary primary key). Old
  // sessions predate it → backfill 0. A non-finite value is treated as absent.
  if (!Number.isFinite(session.turnSeq)) { session.turnSeq = 0; changed = true; }
  if (!Array.isArray(session.messages)) { session.messages = []; changed = true; }
  if (!Array.isArray(session.providerHistory)) { session.providerHistory = []; changed = true; }
  // Cursor into display `messages` that has already been mirrored into providerHistory. It is optional on
  // legacy sessions; runOpenAiTurn derives a safe migration point before the first new Provider turn.
  if (session.providerHistoryCursor !== undefined &&
      (!Number.isInteger(session.providerHistoryCursor) || session.providerHistoryCursor < 0)) {
    delete session.providerHistoryCursor;
    changed = true;
  }
  if (!Array.isArray(session.attachments)) { session.attachments = []; changed = true; }
  {
    const route = inferSessionEngineRoute(session);
    if (route && JSON.stringify(route) !== JSON.stringify(session.engineRoute)) { session.engineRoute = route; changed = true; }
    else if (!route && session.engineRoute !== undefined) { delete session.engineRoute; changed = true; }
  }
  // 116-2a: 会话级权限档(session.permissionMode)是【可选】字段,这里【刻意不做任何归一】——
  //   ① 缺省不写就是「跟随全局」,回填默认值 = 给全部存量会话做一次破坏性批量重写(与 `kind` 同纪律),
  //      而且从此分不清「这条线程自己定了档」与「跟着全局走」;
  //   ② 也不删非白名单值:管家会话的头上正是一个不在 PERMISSION_MODES 里的独立值 'steward'(116f),
  //      在这里做白名单清洗会把它抹掉。野值本身无害 —— 读侧(sessionPermissionModeOf/
  //      resolvePermissionMode)一律只认白名单,不合法就当没设、回落下一层。
  // v0.8-S3: todo list (TodoWrite). Old sessions predate it → backfill empty array.
  if (!Array.isArray(session.todos)) { session.todos = []; changed = true; }
  // 第26波b: 任务账本(MissionSpec)。默认 null(无任务)。旧会话无此键 → 保持 null。
  if (session.mission !== null && session.mission !== undefined && typeof session.mission !== 'object') { session.mission = null; changed = true; }
  if (session.mission === undefined) { session.mission = null; changed = true; }
  // v1 技能体系: 会话启用的技能数组(上限 8)。P2-2: 元素为 {id, source} 对象 —— source 锁定「启用当时的注册表
  // 来源」(builtin/user/project),据此在解析时校验来源未被调包(防换 cwd 后同 id 项目技能静默顶替内置技能)。
  // 向后兼容: 旧裸字符串 id 视为 {id, source:''}(source 空 = 宽松匹配一次),本次 normalize 即固化为对象结构。
  {
    const cleaned = [];
    const seenIds = new Set();
    for (const raw of (Array.isArray(session.skills) ? session.skills : [])) {
      let id = '', source = '';
      if (typeof raw === 'string') { id = raw.trim(); } // 旧裸字符串 → source 空(宽松,下次启用时才锁定来源)
      else if (raw && typeof raw === 'object') { id = String(raw.id || '').trim(); source = String(raw.source || '').trim(); }
      if (!SKILL_ID_RE.test(id) || seenIds.has(id)) continue;
      seenIds.add(id);
      cleaned.push({ id, source });
      if (cleaned.length >= 8) break;
    }
    if (JSON.stringify(cleaned) !== JSON.stringify(session.skills)) { session.skills = cleaned; changed = true; }
  }
  // 工作台记忆:memoriesExplicit=true 时 session.memories 是固定选择(上限由 memoryFixedSelectionMaxV1 配置,见 01c;
  // 此处是落盘清洗,取钳位上界 MEMORY_FIXED_SELECTION_HARD_MAX,具体按配置的截断在保存路由与注入侧做)；false 时项目+全局均进入
  // 默认相关性检索，session.memoryExclusions 保存当前会话在默认模式下明确排除的条目。
  {
    const cleaned = [];
    const seen = new Set();
    for (const raw of (Array.isArray(session.memories) ? session.memories : [])) {
      const id = String((raw && typeof raw === 'object' && raw.id) || '').trim();
      if (!SKILL_ID_RE.test(id)) continue;
      const scope = (raw && raw.scope === 'global') ? 'global' : 'project';
      const key = scope + ':' + id;
      if (seen.has(key)) continue;
      seen.add(key);
      // P3-3: 保留 project 条目启用时锁定的 projectKey(渐进迁移:旧数据无此字段→保持缺省=宽松匹配,下次经
      // POST /api/session/memories 固化;同 Skills P2-2 的 source 渐进迁移)。仅接受 16-hex 合法值,防脏字段注入。
      const entry = { id, scope };
      if (scope === 'project') { const pk = String((raw && raw.projectKey) || '').trim(); if (/^[a-f0-9]{16}$/.test(pk)) entry.projectKey = pk; }
      cleaned.push(entry);
      if (cleaned.length >= MEMORY_FIXED_SELECTION_HARD_MAX) break;
    }
    if (JSON.stringify(cleaned) !== JSON.stringify(session.memories)) { session.memories = cleaned; changed = true; }
    if (typeof session.memoriesExplicit !== 'boolean') { session.memoriesExplicit = false; changed = true; }
    const excluded = [];
    const excludedSeen = new Set();
    for (const raw of (Array.isArray(session.memoryExclusions) ? session.memoryExclusions : [])) {
      const id = String((raw && typeof raw === 'object' && raw.id) || '').trim();
      if (!SKILL_ID_RE.test(id)) continue;
      const scope = raw && raw.scope === 'global' ? 'global' : 'project';
      const key = scope + ':' + id;
      if (excludedSeen.has(key)) continue;
      excludedSeen.add(key);
      const entry = { id, scope };
      if (scope === 'project') { const pk = String((raw && raw.projectKey) || '').trim(); if (/^[a-f0-9]{16}$/.test(pk)) entry.projectKey = pk; }
      excluded.push(entry);
      if (excluded.length >= 256) break;
    }
    if (JSON.stringify(excluded) !== JSON.stringify(session.memoryExclusions)) { session.memoryExclusions = excluded; changed = true; }
  }
  return { session, changed };
}

// v0.8-S3: sanitize a todo_write items payload (full-replace semantics; the SAME normalizer is used by
// the provider-engine special-case, the /api/todo endpoint, and the generic toolCall path). Rules: array
// capped at 50 entries; text coerced to string and capped at 200 chars; status defaults to 'pending' when
// missing/invalid; id defaults to t1..tN when absent. Non-array input yields an empty list.
const TODO_MAX_ITEMS = 50;
const TODO_MAX_TEXT = 200;
// 状态同义词:模型多半带着 Claude Code TodoWrite 的习惯(status:'completed'、字段名 content),也常写成
// in-progress / DONE。修前这些一律落成 pending、文本落成空串 —— 计划条永远 0/N,「没做完就续」也跟着误判。
// 三个引擎(provider 闭包 / Kimi 桥 / 回环 /api/todo)都经这里,所以在数据层认一次就全覆盖。
function canonicalTodoStatus(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (v === 'done' || v === 'completed' || v === 'complete' || v === 'finished' || v === 'success' || v === 'succeeded') return 'done';
  if (v === 'in_progress' || v === 'inprogress' || v === 'doing' || v === 'active' || v === 'running' || v === 'started') return 'in_progress';
  if (v === 'blocked') return 'blocked';
  return v === 'pending' || v === 'todo' || v === 'not_started' || v === 'open' || v === '' ? 'pending' : '';
}
// todo_write 入参的同义词归一(分发前的 schema 校验之前用,13f 只认 text/三种状态):content/title/activeForm → text,
// 状态同义词 → 规范值,纯字符串条目 → {text}。不认识的状态原样留着,让校验报出允许值。
function normalizeTodoWriteArgs(args) {
  if (!args || typeof args !== 'object' || !Array.isArray(args.items)) return args;
  return { ...args, items: args.items.map(it => {
    if (typeof it === 'string') return { text: it };
    if (!it || typeof it !== 'object') return it;
    const o = { ...it };
    if (o.text == null) { const alt = o.content != null ? o.content : (o.title != null ? o.title : o.activeForm); if (alt != null) o.text = alt; }
    if (o.status != null) { const c = canonicalTodoStatus(o.status); if (c && c !== 'blocked') o.status = c; }
    return o;
  }) };
}
// mission_update 的里程碑状态同理(13f 只认 pending/done/blocked;in-progress 一类在账本里就是 pending)。
function normalizeMissionUpdateArgs(args) {
  if (!args || typeof args !== 'object' || !Array.isArray(args.milestones)) return args;
  return { ...args, milestones: args.milestones.map(m => {
    if (!m || typeof m !== 'object' || m.status == null) return m;
    const c = canonicalTodoStatus(m.status);
    return c ? { ...m, status: c === 'in_progress' ? 'pending' : c } : m;
  }) };
}
// C2 scratchpad_write 的字段同义词(13f 只认 op/key/text,additionalProperties:false):content/note/value → text,
// name/title → key。只在规范字段缺席时补,补完把同义词拿掉(否则校验仍按多余字段拒)。
function normalizeScratchpadWriteArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const o = { ...args };
  for (const [canon, alts] of [['text', ['content', 'note', 'value']], ['key', ['name', 'title']]]) {
    for (const alt of alts) {
      if (!Object.prototype.hasOwnProperty.call(o, alt)) continue;
      if (o[canon] == null) o[canon] = o[alt];
      delete o[alt];
    }
  }
  return o;
}
// 分发前统一入口(12 toolCall 与 09 闭包特例共用)。
function normalizeMetaToolArgs(name, args) {
  if (name === 'todo_write') return normalizeTodoWriteArgs(args);
  if (name === 'mission_update') return normalizeMissionUpdateArgs(args);
  if (name === 'scratchpad_write') return normalizeScratchpadWriteArgs(args);
  return args;
}
function normalizeTodoItems(raw) {
  const arr = Array.isArray(raw) ? raw.slice(0, TODO_MAX_ITEMS) : [];
  return arr.map((it, i) => {
    const o = (it && typeof it === 'object') ? it : (typeof it === 'string' ? { text: it } : {});
    const canon = canonicalTodoStatus(o.status);
    const status = (canon === 'in_progress' || canon === 'done') ? canon : 'pending';
    const textRaw = o.text != null ? o.text : (o.content != null ? o.content : (o.title != null ? o.title : o.activeForm));
    const text = String(textRaw == null ? '' : textRaw).slice(0, TODO_MAX_TEXT);
    const id = (o.id != null && String(o.id).trim()) ? String(o.id).slice(0, 64) : `t${i + 1}`;
    return { id, text, status };
  });
}

// ============================================================================
// 第26波b(AUTONOMY-PLAN §26b):任务账本(MissionSpec)—— 长任务的「目标—验收—预算」权威状态,存 session.mission
// (随会话走,免疫压缩:账本不在 messages 里),驱动 until-done 续跑。规范器同款三路复用(工具/API/驱动器)。
//  · milestones[].check:机器可判定优先(command 跑进程判退出码/输出、file_exists 判文件在)、'none' 由模型自报;
//  · budget.maxAutoTurns:无人值守自动续跑硬上限;spent 累计;autoMode:off|until-done|supervised;
//  · stall:digest K 轮不变即停滞;replans:重规划次数(硬限)。
const MISSION_MAX_MILESTONES = 16;
const MISSION_MAX_TEXT = 400;
const MISSION_MAX_CONSTRAINTS = 12;
const MISSION_DEFAULT_MAX_TURNS = 12;
const MISSION_REPLAN_LIMIT = 2;
const MISSION_STALL_LIMIT = 3;
// 对抗轮 P1(第26波b): check.cmd 是【驱动器每轮无提示 shell 执行】的输入 —— 绝不能被【模型】设置,否则
// 提示注入 = 绕过整个权限系统的任意命令执行。`trusted` 门:仅用户(经 UI header token 的 /api/mission)可定义
// command 检查;不可信来源(模型 mission_update 工具 / body-token loopback)的 command 检查一律降级为 'none'。
// file_exists(纯 fsp.access 只读)风险低,但路径可越工作区探测,故也仅 trusted 可设 —— 不可信一律 'none'。
function normalizeMissionCheck(raw, trusted) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  let type = (o.type === 'command' || o.type === 'file_exists') ? o.type : 'none';
  if (!trusted && type !== 'none') type = 'none'; // 不可信来源禁设任何机器检查(只能自报 status/evidence)
  const check = { type };
  if (type === 'command') { check.cmd = String(o.cmd == null ? '' : o.cmd).slice(0, 500); if (o.expect != null) check.expect = String(o.expect).slice(0, 200); }
  else if (type === 'file_exists') check.path = String(o.path == null ? '' : o.path).slice(0, 500);
  return check;
}
// ── 124-P1(40 号文 §2 ①):机器验收的【落章】与验收四态的【唯一】判据 ────────────────────
// 派单稿 §4 的裁决是「一个字段都不加,四态现算」,推导是:② 里 check.type!=='none' 且跑过 ⇒ 机器检查。
// 取证之后这条推导在【机器】那一档不成立,所以本刀只在这一处证伪它:机器检查的【定义权】确实只属于
// 可信来源(normalizeMissionCheck 的 trusted 门,本刀一个字不动),但里程碑的 status 模型改得动 ——
// applyMissionUpdate 只挡 done→pending(P3),不挡 pending→done。于是「用户定义了 check 的里程碑」
// 被模型一句 mission_update{status:'done'} 标完成时,按 check.type 推出来的标签会说「机器检查」,
// 而机器一次都没跑过 —— 那正是 41 号方案 §9 J08 要挡的谎(「产物生成但测试失败/文件随后缺失」
// 却声称验收通过)。「跑过没有、结果是什么」今天全仓没有任何地方落盘:driver 与 action:'check'
// 都只把 pass 的结果写进 evidence(自由文本,模型同样写得动),HTTP 回执里那份 results 不落盘。
// 故补一枚【只有机器写得了】的章:
//   · 写入口只有 recordMissionCheckResult 一个函数,调用点只有两处跑检查的地方(06e 驱动器每轮、
//     /api/mission action:'check');
//   · 任何输入侧都进不来 —— normalizeMission 只从 prev 深拷里按 id 捞,applyMissionUpdate 不认
//     uo.lastCheck,start 全量新建一律清空(新账本没有旧章);
//   · 于是「机器检查」这块牌子只可能由真跑过的机器挂上,模型与 loopback 都伪造不了。
function normalizeMissionLastCheck(raw) {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
  if (!o) return null;
  const at = String(o.at == null ? '' : o.at).slice(0, 40);
  if (!at) return null;   // 没有时间 = 不是章(J08:宁可说「没跑过」,不许说一个说不出时间的「通过」)
  return { at, pass: o.pass === true, detail: String(o.detail == null ? '' : o.detail).slice(0, 200) };
}
// 机器验收结果的【唯一】写入口(静态锁 acceptance-provenance.e2e.js 按「全仓只有这里写 lastCheck」钉)。
// 不 pass 的结果同样落章:J08 要的是「显示实际验证状态」,一次失败的检查比没有检查更该被说出来。
function recordMissionCheckResult(milestone, result) {
  if (!milestone || typeof milestone !== 'object' || !result || typeof result !== 'object') return false;
  milestone.lastCheck = normalizeMissionLastCheck({ at: nowIso(), pass: result.pass === true, detail: result.detail });
  return true;
}
// trusted 默认 true:内部深拷(applyMissionUpdate 的 normalizeMission({}, prev))必须原样保留 prev 里【已在可信
// 来源校验过】的检查;仅当里程碑来自【新输入 o.milestones】时才按调用方 trusted 门控(见 fromRaw 判定)。
function normalizeMission(raw, prev, trusted = true) {
  if (raw === null) return null; // 显式清空
  const o = (raw && typeof raw === 'object') ? raw : {};
  const p = (prev && typeof prev === 'object') ? prev : {};
  const goal = String(o.goal != null ? o.goal : (p.goal || '')).slice(0, 2000);
  const fromRaw = Array.isArray(o.milestones);
  const rawMs = fromRaw ? o.milestones : (Array.isArray(p.milestones) ? p.milestones : []);
  // 124-P1:机器验收的章只从【prev】按 id 捞 —— 深拷那条路 mo 本身就是 prev 的里程碑(原样带走),
  // 新输入那条路(start / 全量替换)一律查 prev,查不到就是没有章。输入里带 lastCheck 的一律无视:
  // 这个字段不是输入面的东西(见 recordMissionCheckResult 的头注)。
  const prevMilestoneById = new Map((Array.isArray(p.milestones) ? p.milestones : [])
    .map(item => [String((item && item.id) || ''), item]));
  const seen = new Set();
  const milestones = rawMs.slice(0, MISSION_MAX_MILESTONES).map((m, i) => {
    const mo = (m && typeof m === 'object') ? m : {};
    let id = (mo.id != null && String(mo.id).trim()) ? String(mo.id).trim().slice(0, 64) : `m${i + 1}`;
    while (seen.has(id)) id = id + '_'; seen.add(id);
    const status = (mo.status === 'done' || mo.status === 'blocked') ? mo.status : 'pending';
    const rawDesc = String(mo.desc == null ? '' : mo.desc).slice(0, MISSION_MAX_TEXT);
    const desc = (id === 'delivery' && rawDesc.trim() === goal.trim())
      ? followupAcceptanceCriterion(rawDesc, false)
      : (/^followup_/.test(id) ? followupAcceptanceCriterion(rawDesc, true) : rawDesc);
    // 新输入的 check 按 trusted 门控;prev 深拷的 check 视为已可信(原样保留)。
    const lastCheck = normalizeMissionLastCheck(fromRaw ? ((prevMilestoneById.get(id) || {}).lastCheck) : mo.lastCheck);
    return { id, desc, status, check: normalizeMissionCheck(mo.check, fromRaw ? trusted : true), evidence: mo.evidence ? String(mo.evidence).slice(0, MISSION_MAX_TEXT) : '', ...(lastCheck ? { lastCheck } : {}) };
  });
  const budgetIn = (o.budget && typeof o.budget === 'object') ? o.budget : (p.budget || {});
  const maxAutoTurns = Math.max(1, Math.min(50, Math.round(Number(budgetIn.maxAutoTurns) || MISSION_DEFAULT_MAX_TURNS)));
  const spentIn = (p.spent && typeof p.spent === 'object') ? p.spent : {};
  const autoMode = ['off', 'until-done', 'supervised'].includes(o.autoMode) ? o.autoMode : (['off', 'until-done', 'supervised'].includes(p.autoMode) ? p.autoMode : 'off');
  return {
    goal,
    milestones,
    constraints: (Array.isArray(o.constraints) ? o.constraints : (Array.isArray(p.constraints) ? p.constraints : [])).slice(0, MISSION_MAX_CONSTRAINTS).map(c => String(c || '').slice(0, MISSION_MAX_TEXT)).filter(Boolean),
    budget: { maxAutoTurns, maxTokens: Number.isFinite(Number(budgetIn.maxTokens)) ? Math.max(0, Math.round(Number(budgetIn.maxTokens))) : 0 },
    spent: { autoTurns: Math.max(0, Number(spentIn.autoTurns) || 0), tokens: Math.max(0, Number(spentIn.tokens) || 0) },
    autoMode,
    stall: { lastDigest: String((p.stall && p.stall.lastDigest) || ''), sameCount: Math.max(0, Number(p.stall && p.stall.sameCount) || 0) },
    replans: Math.max(0, Number(p.replans) || 0),
    // 对抗轮 P2(#6): 保留 budgetExhaustedAt —— 它是"本任务预算已耗尽并记过账"的持久标记,update 再武装(prev 深拷)
    // 必须保住它,否则再耗尽会二次落 mission_budget_exhausted 使超支率 >100%;全新 start(prev=null → p={})自然清空,
    // 新任务的耗尽正常重记。budget 无法经 update 抬高(applyMissionUpdate 不碰 budget),故不需"抬预算才清"的额外逻辑。
    budgetExhaustedAt: String(p.budgetExhaustedAt || ''),
    // 第84波:Mission 的第一回合游标。整单回退必须回到「任务开始前」而不是猜整个会话的第 1 回合；
    // 老会话没有该字段时只在 missionRollbackTarget 中基于真实消息/检查点保守推导，绝不盲回到 1。
    startedTurnSeq: Math.max(0, Number(p.startedTurnSeq) || Number(o.startedTurnSeq) || 0),
    // 75a-2b (S3): Mission-level persistent monotone change sequence. turn/run/Intervention/预算/result/
    // rewind/删除 all advance it (75a-2b wires Intervention transitions; broader wiring lands with each
    // subsystem). Deep-copy preserved (same as budgetExhaustedAt); legacy sessions derive start value 0.
    changeSeq: Math.max(0, Number(p.changeSeq) || 0),
    // 第72波:任务结果快照(终态时由 maybeFinalizeMission 盖章;再武装由它清理)。深拷必须携带,
    // 否则每次 applyMissionUpdate(normalizeMission({}, prev))都把已盖章的结果静默抹掉。
    result: (p.result && typeof p.result === 'object') ? p.result : null,
    // 历史轮次验收报告归档:next_turn/retry/rollback/再武装/盖新章前把旧 result 推入,有界 last 10。
    // 深拷同样必须携带,否则 applyMissionUpdate 会把历史轮次静默抹掉(同 result 的再武装坑)。
    resultHistory: Array.isArray(p.resultHistory) ? p.resultHistory.slice(-10) : [],
    createdAt: p.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}
// 第26波b: 增量更新账本(mission_update 工具 / API update)—— 按 id 【合并】里程碑,不整表替换。
// 已存在的 id → 更新 status/evidence/desc(只更新提供的字段);新 id → 追加(受 16 上限);goal 提供才改。
// 关键:与 normalizeMission(full-replace,用于 start)语义相反 —— 模型只报"m2 done"时不能抹掉 m1/m3。
// trusted:是否可信来源(用户经 UI header token)。不可信(模型 mission_update / body-token loopback)时:
//  ① 不得设置/修改任何机器 check(P1 关键——防模型注入 check.cmd 让驱动器无提示 shell 执行);
//  ② 不得把已 done 的里程碑回退为 pending(P3——防模型靠 done→pending 抖动无限拖住 until-done 循环)。
function applyMissionUpdate(prev, patch, trusted = false) {
  if (!prev) return prev;
  const p = (patch && typeof patch === 'object') ? patch : {};
  const next = normalizeMission({}, prev); // 深拷现有(经规范化;prev 的 check 视为已可信,原样保留)
  if (p.goal != null) next.goal = String(p.goal).slice(0, 2000);
  const ups = Array.isArray(p.milestones) ? p.milestones : [];
  const byId = new Map(next.milestones.map(m => [m.id, m]));
  for (const u of ups) {
    const uo = (u && typeof u === 'object') ? u : {};
    const id = String(uo.id || '').trim().slice(0, 64);
    if (!id) continue;
    const existing = byId.get(id);
    if (existing) {
      const uoStatus = canonicalTodoStatus(uo.status);   // completed / in-progress 等同义词(见 canonicalTodoStatus)
      if (uoStatus === 'done' || uoStatus === 'blocked' || uoStatus === 'pending') {
        // 对抗轮 P3: 不可信来源不得把 done 回退为 pending/blocked(防抖动拖住循环);pending↔blocked、→done 允许。
        if (!(existing.status === 'done' && uoStatus !== 'done' && !trusted)) existing.status = uoStatus;
      }
      if (uo.desc != null) existing.desc = String(uo.desc).slice(0, MISSION_MAX_TEXT);
      if (uo.evidence != null) existing.evidence = String(uo.evidence).slice(0, MISSION_MAX_TEXT);
      // 对抗轮 P1: check 仅 trusted(用户 UI)可改;不可信(模型/loopback)的 uo.check 一律忽略 —— 保留原检查。
      if (uo.check && trusted) existing.check = normalizeMissionCheck(uo.check, true);
    } else if (next.milestones.length < MISSION_MAX_MILESTONES) {
      // 新里程碑的 check 同样按 trusted 门控:模型新增里程碑不能自带机器检查(降级 'none')。
      const nm = { id, desc: String(uo.desc || '').slice(0, MISSION_MAX_TEXT), status: (canonicalTodoStatus(uo.status) === 'done' || canonicalTodoStatus(uo.status) === 'blocked') ? canonicalTodoStatus(uo.status) : 'pending', check: normalizeMissionCheck(uo.check, trusted), evidence: uo.evidence ? String(uo.evidence).slice(0, MISSION_MAX_TEXT) : '' };
      next.milestones.push(nm); byId.set(id, nm);
    }
  }
  next.updatedAt = nowIso();
  return next;
}
// 账本进度指纹(停滞检测用)。对抗轮 P3: 除 status 外并入 evidence 长度桶 —— 一个粗粒度大里程碑上模型持续
// 工作、经 mission_update 更新 evidence 但尚未翻 status,也算「有进展」不误判停滞;真正原地打转(账本零变化)
// 才连续 K 轮同指纹触发降级。桶而非全文,避免 evidence 微小抖动被当进展(仍需实质增长才换桶)。
function missionProgressDigest(mission) {
  if (!mission || !Array.isArray(mission.milestones)) return '';
  return mission.milestones.map(m => m.id + ':' + m.status + ':' + Math.floor(String(m.evidence || '').length / 20)).join(' ');
}

// ── 124-P1:验收只读投影(三套数据面接起来,零改写) ────────────────────────────────────────
// 今天「验收」有三套数据面各写各的(40 号文 §1):① 事项容器验收项(唯一写入口是 13d 那条 UI token
// 的 PATCH —— 勾上 = 人工复核)、② 会话账本里程碑(模型自报 status / 机器落章)、③ 结果快照。
// 本函数【只读】前两套,把「这条是谁判的」算出来给界面,一处判据,谁都不回写谁:
//   · 'machine' 自报完成之外的唯一一档:有可信机器检查【且】有通过的章(recordMissionCheckResult);
//   · 'self'    模型/用户在账本上标的 done —— 带 checkState 说清「有检查但没跑过/没通过」(J08);
//   · 'human'   事项容器里用户亲手勾的那一条;
//   · 'open'    还没完成。
// 「这条线程有没有账本」用的是【与 06i ledgerless 同一条判据】(会话头有没有 mission 容器),
// 不是 milestones.length —— 后者会把「立了单还没定里程碑」的 2.0 任务单误判成无账本线程。
function missionAcceptanceItemView(milestone, humanCheckedTexts) {
  const m = (milestone && typeof milestone === 'object') ? milestone : {};
  const status = (m.status === 'done' || m.status === 'blocked') ? m.status : 'pending';
  const checkType = (m.check && m.check.type) || 'none';
  const stamp = normalizeMissionLastCheck(m.lastCheck);
  const machine = status === 'done' && checkType !== 'none' && !!stamp && stamp.pass === true;
  // 「人工复核」这一档是【接】出来的,不是猜的:事项容器里有一条【逐字同文】且用户已勾的验收项 ——
  // 那条勾只可能出自 13d 那条 UI header token 的 PATCH(全仓唯一写入口),所以它是真人看过的证据。
  // 文本逐字相等才算,不做模糊匹配:宁可这条牌子少出现一次,不许把两条不同的验收当成一条。
  const humanChecked = status === 'done' && !!(humanCheckedTexts && humanCheckedTexts.has(String(m.desc || '').trim()));
  return {
    id: m.id, desc: m.desc, status, checkType, evidence: m.evidence || '',
    // 强弱序 machine > human > self:三者都可能同时为真,牌子只印最硬的那一份证据。
    provenance: status === 'done' ? (machine ? 'machine' : (humanChecked ? 'human' : 'self')) : 'open',
    // 机器检查这一格的实情:没有检查 / 有检查但一次没跑过 / 最近一次通过 / 最近一次没通过。
    checkState: checkType === 'none' ? 'none' : (!stamp ? 'never' : (stamp.pass ? 'pass' : 'fail')),
    checkedAt: stamp ? stamp.at : '',
    checkDetail: stamp ? stamp.detail : '',
  };
}
// 事项容器里【与验收有关的那部分】的指纹。给详情 ETag 用:容器是另一份文件,它变了不会动会话
// 投影的 revision —— 不把它写进 ETag,勾完验收项再带 If-None-Match 来读就会拿到 304 + 陈旧验收
// (与 /api/missions 列表当年那条教训同一个模具,见 buildMissionAggregateRows 的 stamp 注释)。
function missionContainerAcceptanceStamp(container) {
  if (!container || typeof container !== 'object') return '-';
  const rows = Array.isArray(container.acceptance) ? container.acceptance : [];
  return String(container.updatedAt || '') + ':' + rows.length + ':'
    + rows.map(row => String((row && row.id) || '') + ((row && row.done) ? '1' : '0')).join(',').slice(0, 400);
}
function buildMissionAcceptanceProjection(mission, container) {
  const ledger = !!(mission && typeof mission === 'object');
  const ms = (ledger && Array.isArray(mission.milestones)) ? mission.milestones : [];
  const rows = (container && Array.isArray(container.acceptance)) ? container.acceptance : [];
  const humanCheckedTexts = new Set(rows
    .filter(row => row && row.done === true)
    .map(row => String((row && row.text) || '').trim())
    .filter(Boolean));
  const items = ms.map(milestone => missionAcceptanceItemView(milestone, humanCheckedTexts));
  // 同一句话在两套面上各写一遍是常态(事项验收项与账本里程碑本来就可能同文案),界面不印两遍:
  // 判据是去掉首尾空白后的文本逐字相等 —— 不做模糊匹配(宁可多印一条,不许悄悄合并两条不同的验收)。
  const ledgerTexts = new Set(items.map(item => String(item.desc || '').trim()).filter(Boolean));
  const containerItems = rows.map(row => {
    const text = String((row && row.text) || '');
    return {
      id: String((row && row.id) || ''), text, done: !!(row && row.done === true),
      doneAt: String((row && row.doneAt) || ''), provenance: 'human',
      duplicate: !!text.trim() && ledgerTexts.has(text.trim()),
    };
  });
  const extra = containerItems.filter(row => !row.duplicate);
  const byProvenance = { machine: 0, self: 0, human: 0, open: 0 };
  for (const item of items) byProvenance[item.provenance] += 1;
  for (const row of extra) byProvenance[row.done ? 'human' : 'open'] += 1;
  const done = items.filter(item => item.status === 'done').length;
  // 界面上画的是哪几条,a/b 就数哪几条(merged):
  //   · 线程有自己的账本 → 数账本(事项级验收项是【整个事项】的,挂到每条线程上会一份账印好几遍);
  //   · 线程没有账本 → 退到事项级那一套 —— 这正是 40 号文 §1 结论 3 那种「普通线程问不出答案」的处境:
  //     此前它只能说「暂无」,现在至少说得出「这个事项定了 N 条,你勾过 M 条」。
  return {
    // 既有五个键的形状与口径一个字不动(消费者:抽屉验收块、mission-state.js fromSnapshot、既有 e2e)。
    total: ms.length,
    done,
    blocked: items.filter(item => item.status === 'blocked').length,
    pending: items.filter(item => item.status === 'pending').length,
    items,
    // 124-P1 新增的只读投影:
    ledger,
    container: container ? { total: containerItems.length, done: containerItems.filter(row => row.done).length, items: containerItems } : null,
    merged: ledger
      ? { total: items.length, done }
      : { total: containerItems.length, done: containerItems.filter(row => row.done).length },
    byProvenance,
  };
}

// ── 第72波(EC-E 切片三):任务结果模型 ─────────────────────────────────────────────────────
// 跨回合 turnSummary 折叠(单一实现,13d /api/missions 详情与本波 buildMissionResult 共用):
// filesChanged 按 path 后写胜(最新 op/revertible 为当前态),artifacts 按 path 先去重(首次产出记回合),
// irreversible 逐条拼接(回合序),legacyCommands = 第72波前旧回合(无 irreversible 字段)的 commands 计数 ——
// 旧回合的不可逆操作只有计数没有明细,诚实单列,不混进新账假装有据。
function foldTurnSummaries(session) {
  const filesChanged = new Map(), artifacts = new Map();
  const irreversible = [];
  let commands = 0, legacyCommands = 0;
  let irreversibleIncomplete = false;
  for (const msg of ((session && session.messages) || [])) {
    const ts = msg && msg.turnSummary;
    if (!ts) continue;
    irreversibleIncomplete ||= ts.irreversibleIncomplete === true;
    for (const f of (ts.filesChanged || [])) {
      if (f && f.path) filesChanged.set(f.path, { path: f.path, op: f.op || '', revertible: f.revertible === true, turnSeq: ts.turnSeq, entrySeq: f.entrySeq });
    }
    for (const a of (ts.artifacts || [])) {
      if (a && a.path && !artifacts.has(a.path)) artifacts.set(a.path, { path: a.path, kind: a.kind || '', turnSeq: ts.turnSeq });
    }
    commands += (ts.commands || []).length || Number(ts.commands) || 0;
    if (Array.isArray(ts.irreversible)) {
      if (irreversible.length + ts.irreversible.length > 200) irreversibleIncomplete = true;
      for (const iv of ts.irreversible) {
        if (iv && iv.name && irreversible.length < 200) irreversible.push({ turnSeq: ts.turnSeq, kind: iv.kind || 'exec', name: String(iv.name), detail: String(iv.detail || ''), ok: iv.effectStatus === 'unknown' ? false : iv.ok !== false, ...irreversibleEntryMetadata(iv) });
      }
    } else {
      legacyCommands += (ts.commands || []).length || Number(ts.commands) || 0;
    }
  }
  const byKind = {};
  for (const iv of irreversible) byKind[iv.kind] = (byKind[iv.kind] || 0) + 1;
  return {
    filesChanged: [...filesChanged.values()], artifacts: [...artifacts.values()], commands,
    irreversible: { total: irreversible.length, byKind, items: irreversible, legacyCommands, ...(irreversibleIncomplete ? { incomplete: true } : {}) },
  };
}
// 任务结果快照(EC-E 立项:验收状态 + 成果引用 + 未完成项 + 变更摘要 + 真实回滚能力 + 不可逆显式标注)。
// 终态盖章时现算并持久化进 mission.result —— 盖章时刻的数字是历史证据,不随后续回合漂移。
function followupAcceptanceCriterion(prompt, followup = true) {
  const source = String(prompt || '');
  const chinese = /[\u3400-\u9fff]/.test(source);
  if (/(?:分析|研究|调研|趋势|走势|比较|对比|报告|数据|市场|股票|美股|A股|research|analy[sz]e|trend|compare|market|stock)/i.test(source)) {
    return chinese
      ? (followup ? '追加结论覆盖新问题点名的对象与范围，并附有可核验的数据、事实或来源' : '结论直接回答目标问题、覆盖点名范围，并附有可核验的数据、事实或来源')
      : (followup ? 'The follow-up conclusions cover the newly named subjects and scope with verifiable data, facts, or sources' : 'The conclusions directly answer the goal, cover its named scope, and include verifiable data, facts, or sources');
  }
  if (/(?:实现|开发|修复|重构|代码|接口|页面|组件|测试|bug|fix|implement|refactor|code|api|ui|test)/i.test(source)) {
    return chinese
      ? (followup ? '追加改动符合新要求，并通过相关检查或测试且未引入无关行为变化' : '请求的改动按约定范围落地，通过相关检查或测试且未引入无关行为变化')
      : (followup ? 'The follow-up change meets the new requirements, passes relevant checks, and introduces no unrelated behavior changes' : 'The requested change is implemented within scope, passes relevant checks, and introduces no unrelated behavior changes');
  }
  return chinese
    ? (followup ? '追加结果完整回应新要求，并提供可核验的交付、事实或检查结果' : '最终结果完整回应任务目标，并提供可核验的交付、事实或检查结果')
    : (followup ? 'The follow-up result fully addresses the new request with a verifiable deliverable, fact, or check result' : 'The final result fully addresses the task goal with a verifiable deliverable, fact, or check result');
}


return { normalizeSession, normalizeMetaToolArgs, normalizeTodoItems, normalizeMissionCheck, recordMissionCheckResult, normalizeMission, applyMissionUpdate, missionProgressDigest, missionContainerAcceptanceStamp, buildMissionAcceptanceProjection, foldTurnSummaries, followupAcceptanceCriterion, MISSION_MAX_MILESTONES, MISSION_MAX_TEXT, MISSION_DEFAULT_MAX_TURNS, MISSION_STALL_LIMIT };
}
module.exports = { createSessionModel };
