// 117w-W1 提交②(27 号文 §11.19.2):Windows 文件系统非法字符的【唯一一份】替换表 —— 尖括号、
// 冒号、双引号、两种斜杠、竖线、问号、星号、控制字符,一律换成下划线;中文与其它可见字符原样保留。
// 修前它是 makeAttachmentRecord 里的一条内联正则,提交② 的派生子工作区(13k stewardWorkspaceSlug)
// 要用同一张表 —— 抄第二份迟早分叉(一边补了新字符另一边没补,于是「附件名安全、目录名不安全」)。
// 抽成函数是为了让两处【共用同一个正则字面量】,不是为了复用一行代码。
function sanitizeFsSegmentName(fsSegmentRaw) {
  return String(fsSegmentRaw == null ? '' : fsSegmentRaw).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

async function makeAttachmentRecord(input) {
  await ensureDirs();
  const id = makeId('file');
  // 代码走查 C8:名字按 Windows 形取文件名(认 \ 与 /);非字符串、空、「.」「..」、全是点和空格(Windows 会吃掉
  // 结尾的点与空格)一律回落 upload.bin。修前「..」会写到目录本身上:EISDIR 500、报错带出数据目录绝对路径。
  const rawName = typeof input.name === 'string' ? input.name : '';
  let safeName = sanitizeFsSegmentName(path.win32.basename(rawName)).replace(/[. ]+$/, '').slice(0, 200);
  if (!safeName || /^[. ]*$/.test(safeName)) safeName = 'upload.bin';
  const targetDir = path.join(paths.uploads, id);
  await fsp.mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, safeName);
  const base64 = String(input.data || '').includes(',')
    ? String(input.data).split(',').pop()
    : String(input.data || '');
  const buffer = Buffer.from(base64, 'base64');
  try { await fsp.writeFile(target, buffer); }
  catch (error) { await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {}); throw error; }   // 不留空的 uploads/<id>/

  let textPreview = '';
  // v1.9:svg 是文本(矢量图源码)进 textPreview;像素图(png/jpg/…)不进,打 kind:'image' 走图片预处理。
  const textLike = /\.(txt|md|json|js|ts|tsx|jsx|py|ps1|bat|cmd|csv|xml|svg|html|css|yaml|yml|ini|log)$/i.test(safeName);
  if (textLike && buffer.length <= 256 * 1024) {
    textPreview = decodeTextFileBytes(buffer, true).slice(0, 12000);   // 走查 W1·F4:GBK / UTF-16(带 BOM)按内容判编码,不再一律当 UTF-8
  }
  // 127-114c②(26 号文 §3):音频附件打 kind:'audio'(扩展名白名单)——上传路由凭它触发尽力转写;
  // 非音频不落此字段(与 hiddenModels/caps「空不落字段」同模具,存量记录形状零漂移)。
  const audioLike = /\.(wav|mp3|m4a|webm|ogg|flac)$/i.test(safeName);
  // v1.9:图片附件打 kind:'image'(与 audio 同模具,空不落字段)——上传路由凭它触发图片预处理
  // (OCR 文本兜底 / 超限压缩派生件,见 13b maybeOcrImageAttachment / maybeCompressImageAttachment)。
  const imageLike = /\.(png|jpe?g|gif|webp|bmp)$/i.test(safeName);
  return {
    id,
    name: safeName,
    path: target,
    size: buffer.length,
    createdAt: nowIso(),
    textPreview,
    ...(audioLike ? { kind: 'audio' } : {}),
    ...(imageLike ? { kind: 'image' } : {}),
  };
}

// --- Active claude child registry keyed by session id, for stop/restart/interrupt + disconnect kill. ---
// 第 117 波 117l D4(27 号文 §11.9;用户第四轮走查第 3 条「『它刚说』更新不够及时」):活回合尾巴的累加器。
// 两个引擎(09 的 provider 回合与 05 的 Claude 回合)在各自的 reg.onEvent 包装里调它 —— 同一份口径、
// 同一份预算,不各写一套。三条纪律:
//   ① 只在内存(reg 上),不落盘、不进任何投影 —— 回合一结束 reg 从 activeChildren 里去掉,尾巴随之消失;
//   ② 只留最后 600 字(抖动的是“它正在说什么”,不是全文;全文在回合收尾时才落盘);
//   ③ 工具名只在【工具在跑】期间在:tool_use 记上,tool_result 清掉。
// 发不出事件的回合(引擎不流 delta)就是空尾巴 —— 不编,不拿上一回合的话冒充(§11.2 「诚实」)。
//
// 117m-A5(用户第六轮走查①「现在点开线程的看全文,还是啥也看不到」):把这个累加器从「尾巴」扩成
// 「本回合正文」。根因是助手消息在【回合收尾】才落盘,而管家起的回合没有任何客户端挂在它的流上 ——
// 用户真机上跑了 15 分钟、53 次工具调用,messages.ndjson 只有那条 user 消息一行。经典壳只渲染已落盘的
// messages,于是「看全文」是一片空白。修法不是提前落盘(那会把半截正文写进数据面),而是把内存里这份
// 活文本扩到够看,经既有的 GET /api/sessions/:id 信封下发。四条新纪律,与上面三条并列:
//   ④ text 的语义与 600 字上限【一个字不动】—— 抽屉的「它正在说」在用它,117l 的断言钉着它;
//   ⑤ 新增 full = 本回合从头累加的助手正文,硬顶 12000 字。超顶从【头部】丢弃并置 truncated:true:
//      用户要看的是「它现在在说什么」,砍掉的应该是最早那段,不是刚说的;
//   ⑥ 新增 tools = 最近 ≤20 条工具名 + 起止 + 状态。**只存名字与状态,不存参数、不存结果** ——
//      参数与结果里可能有密钥/路径/整份文件内容,这条信封是给「看一眼它在干嘛」用的,不是审计面;
//   ⑦ 新增 startedAt(回合起点)与 iterations(工具轮次:一批并行工具算一轮)。
// 全部仍然只在内存,回合一结束 reg 从 activeChildren 里去掉,这份东西随之整份消失。
const LIVE_TAIL_CHARS = 600;
const LIVE_FULL_CHARS = 12000;
const LIVE_TOOLS_MAX = 20;
function appendLiveTail(reg, evt) {
  if (!reg || !evt) return;
  // 代理模式 v2:子代理自己的工具事件(带 subagentId)不进父回合的实时工具列表与迭代计数 —— 它们只属于代理卡/代理面板。
  if (evt.subagentId) return;
  const tail = reg.liveTail && typeof reg.liveTail === 'object' ? reg.liveTail : (reg.liveTail = { text: '', tool: '', updatedAt: '' });
  // 05/09 建的仍是 117l 那个三字段裸对象(本波不碰那两个文件),缺的字段在这里就地补齐 —— 累加器是
  // 唯一的写口,补在这里就不会有「某条路径的 reg 少个键」的形状分叉。
  if (typeof tail.full !== 'string') tail.full = '';
  if (typeof tail.truncated !== 'boolean') tail.truncated = false;
  if (!Array.isArray(tail.tools)) tail.tools = [];
  if (typeof tail.startedAt !== 'string') tail.startedAt = '';
  if (!Number.isFinite(tail.iterations)) tail.iterations = 0;
  const type = String(evt.type || '');
  const at = nowIso();
  if (type === 'assistant_delta') {
    const chunk = String(evt.text || '');
    if (!chunk) return;
    tail.text = (tail.text + chunk).slice(-LIVE_TAIL_CHARS);
    const merged = tail.full + chunk;
    if (merged.length > LIVE_FULL_CHARS) { tail.full = merged.slice(merged.length - LIVE_FULL_CHARS); tail.truncated = true; }
    else tail.full = merged;
  } else if (type === 'tool_use') {
    const name = String(evt.name || evt.tool || '').slice(0, 80);
    tail.tool = name;
    // 轮次:provider 路径有 batchId(09 的包装给同一批并行工具打同一个),换批才 +1;Claude 路径没有
    // batchId,退化成「上一个事件不是 tool_use 就算新的一轮」。两条路都不把一批并行工具数成 N 轮。
    const batch = String(evt.batchId || '');
    const sameBatch = batch ? batch === tail.batchMark : tail.lastKind === 'tool_use';
    if (!sameBatch) tail.iterations += 1;
    tail.batchMark = batch;
    tail.tools.push({ id: String(evt.id || ''), name, startedAt: at, endedAt: '', status: 'running' });
    while (tail.tools.length > LIVE_TOOLS_MAX) tail.tools.shift();
  } else if (type === 'tool_result') {
    tail.tool = '';
    const id = String(evt.id || '');
    for (let i = tail.tools.length - 1; i >= 0; i -= 1) {
      const row = tail.tools[i];
      if (!row || row.status !== 'running') continue;
      if (id && row.id && row.id !== id) continue;
      row.endedAt = at;
      row.status = evt.isError ? 'error' : 'done';
      break;
    }
  } else return;
  tail.lastKind = type;
  if (!tail.startedAt) tail.startedAt = Number.isFinite(reg.startedAt) ? new Date(reg.startedAt).toISOString() : at;
  tail.updatedAt = at;
  notifyActiveChildTaps(reg, evt);   // 121-K2a:尾巴刚变过 —— 见下面那段头注
}

// ────────────────────────────────────────────────────────────────────────────
// 第 121 波 K2a(34 号文 §6.1 第 1 条):活回合事件的【旁路订阅者】。
//
// 34 号文摸底把 `reg.onEvent` 写成「唯一的扇出点」。实测不是:05:9-10 与 09:1238-1239 两处头注
// 说得很清楚 —— `reg.onEvent` 只看得见【桥接/MCP 那一路】的事件,引擎自己流出来的
// assistant_delta / tool_use / tool_result 走的是两个引擎各自的【本地 onEvent 包装】。
// 那个包装里两条路唯一的交汇点就是上面的 appendLiveTail(117l D4 为了「同一份口径」才抽出来的)。
// 所以旁路订阅装在【两处】,一份订阅者名单:
//   ① appendLiveTail 末尾 —— 尾巴真的变过之后才通知(thread.live 要的正是这份尾巴);
//   ② installActiveChildEventFanout 包装的 reg.onEvent —— 桥接/MCP 那一路的事件。
// 两条路对同一个事件可能各通知一次(桥接事件会先进 reg.onEvent 再落到本地包装),订阅者按会话
// 节流,重复不产生第二条帧;宁可多通知一次,也不要因为「猜哪条路会到」而漏。
//
// 三条纪律:
//   ① 引擎自己那个订阅者(05:491 / 09:1389 装的 reg.onEvent)行为【逐字不变】且【第一个收到】——
//      旁路一律排在它后面,且不参与它的异常传播(它抛,旁路就不跑,原路径的语义一个字不变);
//   ② 旁路订阅者抛错就地吞掉 —— 观察面绝不反噬回合;
//   ③ 旁路只读 reg,不许改它的任何字段。
const ACTIVE_CHILD_EVENT_TAPS = new Set();
function subscribeActiveChildEvents(fn) {
  if (typeof fn !== 'function') return () => {};
  ACTIVE_CHILD_EVENT_TAPS.add(fn);
  return () => { ACTIVE_CHILD_EVENT_TAPS.delete(fn); };
}
function notifyActiveChildTaps(reg, evt) {
  if (!ACTIVE_CHILD_EVENT_TAPS.size) return;   // 零订阅者 = 零开销(同 RUYI_EVENTS.emit)
  for (const tap of ACTIVE_CHILD_EVENT_TAPS) {
    try { tap(reg, evt); } catch { /* 纪律②:旁路的错不许回流到回合 */ }
  }
}
// 把一份【已经装好引擎订阅者】的 reg 改成多订阅者:原来那个函数原样保留并永远第一个收到,
// 旁路名单排在它后面。两个引擎各在 `reg.onEvent = ...` 之后调一次。
function installActiveChildEventFanout(reg) {
  if (!reg || typeof reg.onEvent !== 'function' || reg.__eventFanout) return reg;
  const engineSubscriber = reg.onEvent;   // 纪律①:它是第一个,也是唯一一个能影响回合的
  reg.__eventFanout = true;
  reg.onEvent = evt => {
    engineSubscriber(evt);                // 原行为逐字不变(含它自己的异常传播)
    notifyActiveChildTaps(reg, evt);
  };
  return reg;
}
// 回合 settle 登记表(第69波 rewind 竞态修复):sessionId -> { promise, resolve }。driver(chat/stream)
// 在回合开始登记、driver finally(收尾 saveSession 已落盘后)resolve 并删除。stopSession 会立即删
// activeChildren,但被停回合的收尾(推 aborted assistant + saveSession)发生在此之后 —— rewindSession
// 若只看 activeChildren 就会在这个窗口截断落盘,然后被 dying turn 的收尾 save 整份盖回(丢失写:
// 「回溯了但消息又回来」)。rewindSession 先等本表 settle 再截断,顺序由此确定。
// A logical driver owns all of its queued/child turns. Never infer ownership from the current child.
// Bounded evidence for completed-then-undo. A newer admitted driver replaces the old identity.
const { recordSessionExecutionOwner, sessionExecutionObservation, sessionExecutionSnapshot, sessionExecutionCheck, sessionExecutionCheckRewind, assertSessionExecutionOwner, registerSessionExecutionChild, requestSessionExecutionStop } = require('./backend/session-executions.cjs').createSessionExecutions({
  activeChildren, turnSettlers, serverInstanceId: OVERLAY_ID, hooks: SessionExecutionHooks, stopChild: stopSession,
});
SessionExecutionHooks.owns = (sessionId, owner) => Boolean(owner && turnSettlers.get(sessionId) === owner);
SessionExecutionHooks.observation = sessionExecutionObservation;
SessionExecutionHooks.snapshot = sessionExecutionSnapshot;
SessionExecutionHooks.checkRewind = sessionExecutionCheckRewind;
SessionExecutionHooks.check = sessionExecutionCheck;
SessionExecutionHooks.stop = requestSessionExecutionStop;
// 「回合成败账」正在落盘的会话(10 runSessionTurn 收尾)。turnSettlers 在回合 saveSession 之后就删了,而成败账
// (会话头 stewardLastTurn)是紧跟着再写的 —— 这中间的几毫秒里收件箱第四源读到头会看见「回合跑完、没有成败账」
// 并按「账缺席 = done」报,于是一个失败回合被报成收工(2026-10 真机:network_down 失败回合被管家说成「已收工」)。
// 收件箱收集(13i)把本表与活回合同等对待:在表里就等下一拍。只活在内存。
const turnOutcomePending = new Set();
// --- Pending tool-permission prompts awaiting a UI decision (v3 bridge). ---

// 128f-⑪(Brief §4.2 第 7 条前半;用户 2026-09-19 拍板 A「立刻通知你,请求挂 600 秒等你处理」):
// 一条权限请求【等多久】的唯一判据。修前四处各算各的 —— provider 回合(09)与 Kimi 桥(05b)经 07 的
// requestNativePermission 认定时任务那张表,Claude CLI 桥(13d)与两种 CLI 子进程的超时环境变量(05/05b)
// 只认 config.permissionTimeoutMs(定时线程上的 CLI 引擎于是 120 s 就被子进程那一侧放弃,服务端却还在等 30 分钟)。
// 现在四处都问这一个函数;两格【迟绑定】(本文件拼在 07 与 13x 之前,直引它们的符号是前向边):
//   · scheduler —— 07 的 schedulerAskWaitOverrideMs(定时任务派出去的回合,默认 30 分钟);
//   · steward   —— 13k:管家开着、这条线程由管家盯着、用户此刻没坐在它前面 → 600 s。管家要么代批
//                  (真模型实测 37 s),要么说「留给你」并立刻通知(13q 的 steward.deferred);留给用户的
//                  那一件要真的等得到人,120 s 就过期的话「留给你」是一句空话(45 号文 §9.6.5 (b):120.015 s 超时拒)。
// **只改「等多久」,不改「等到了怎么判」**:到时照旧是拒(fail-closed),与定时任务那张表同一条子集律。
const PermissionWaitHooks = {};
// 2026-09-24「不限时」:配置 0(新默认)= 一直等。落到定时器上用一个【有限】的大数 —— setTimeout 超过
// 2^31-1 ms 会当场触发(等于立刻拒),而 CLI 子进程那一侧(12)还要在它上面 +10 s 当 HTTP 预算,所以留足余量。
// 界面按 PROMPT_DEADLINE_HORIZON_MS 判「这是不是一个真截止时刻」:超过一周的一律不显示倒计时。
const PROMPT_WAIT_UNLIMITED_MS = 2147000000;   // ≈24.8 天,< 2^31-1 - 10 s
const PROMPT_DEADLINE_HORIZON_MS = 7 * 24 * 3600 * 1000;
function promptWaitMs(value, floorMs = 5000) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(PROMPT_WAIT_UNLIMITED_MS, Math.max(floorMs, n)) : PROMPT_WAIT_UNLIMITED_MS;
}
function promptDeadlineIsReal(deadlineAt, nowMs = Date.now()) {
  const at = Number(deadlineAt);
  return Number.isFinite(at) && at > 0 && at - nowMs <= PROMPT_DEADLINE_HORIZON_MS;
}
function permissionWaitMs(sessionId, config, sessionHead) {
  const base = promptWaitMs(config && config.permissionTimeoutMs);
  const sid = String(sessionId || '');
  try {
    const scheduled = typeof PermissionWaitHooks.scheduler === 'function' ? Number(PermissionWaitHooks.scheduler(sid)) : 0;
    if (Number.isFinite(scheduled) && scheduled > 0) return scheduled;
  } catch { /* 迟绑定缺席或抛错:当没有这一格 */ }
  try {
    const mediated = typeof PermissionWaitHooks.steward === 'function' ? Number(PermissionWaitHooks.steward(sid, config, sessionHead)) : 0;
    if (Number.isFinite(mediated) && mediated > 0) return Math.max(base, mediated);
  } catch { /* 同上 */ }
  return base;
}
// Questions are a real turn boundary, not a fire-and-forget notification. Both the Provider tool loop and
// the Claude MCP bridge wait on this registry; /api/chat/answer settles exactly one matching entry.
// v0.9-S5: pending PLAN approvals awaiting a UI decision (真流程 plan mode). Mirrors pendingPermissions:
// planId -> { resolve, sessionId, timer }. runOpenAiTurn (plan mode, provider engine) emits a `plan` event
// after the model's first PLAN: message and PAUSES the turn awaiting /api/plan/decision. resolve() settles
// with { decision:'approve'|'reject', note? }; the timeout auto-rejects (same permissionTimeoutMs budget).
// 第27f波:当前处于【无人值守(driverAuto)回合】的会话集 —— provider 路径直接用闭包 driverAuto,但 CLI 桥(Claude 子进程
// loopback 的 /api/permission/request)拿不到 driverAuto,故用此集判定。runClaudeTurn 的 driverAuto 回合进出维护。纯内存。
const driverAutoSessions = new Set();

const { kimiModelList, discoverKimiModels } = require('./backend/kimi-model-discovery.cjs').createKimiModelDiscovery({
  ProcessRuntime, selectedAgentCli, prepareAgentCliSpawn, killChildTree, redact, safeJsonParse,
});

// 47b/长工具保活:按工具声明式超时表(裸名小写)。未知工具默认 15min 有界上限;
// 已知工具仍按其自身参数上限收紧 ——
// ACC run_command timeout cap 600s / launch_application wait_timeout cap 600s,桥给 650s(含网络缓冲),
// 消灭"桥先 120s 死、ACC 侧 600s 任务变僵尸"的契约错位(03 方案 Phase A 核心项)。
// WCW_BRIDGED_TIMEOUT_OVERRIDE='name:ms,name:ms' 是测试缝(e2e 把秒级超时打进 fake 工具)。
const BRIDGED_TOOL_TIMEOUTS = {
  run_command: 650000,
  launch_application: 650000,
  macro_run: 300000,
  // ACC `wait` caps at 300s and time.sleep()s it; the old 120s bridge would kill a legitimate
  // wait(300) at 120s and tear down the whole ACC process tree for doing exactly what was asked.
  wait: 310000,
};
// Unknown third-party tools may legitimately render/export/index for several minutes without emitting MCP
// progress. Give them a bounded long-task ceiling; the provider stream now emits token-free liveness events,
// and Stop/steer can cancel the active request immediately, so this no longer creates an unresponsive wait.
const BRIDGED_TOOL_TIMEOUT_DEFAULT_MS = 900000;
function bridgedToolTimeoutMs(name) {
  const bare = String(name || '').toLowerCase();
  const ov = String(process.env.WCW_BRIDGED_TIMEOUT_OVERRIDE || '');
  for (const pair of ov.split(',')) {
    const [k, v] = pair.split(':').map(s => String(s || '').trim());
    if (k && k.toLowerCase() === bare && Number(v) > 0) return Number(v);
  }
  return BRIDGED_TOOL_TIMEOUTS[bare] || BRIDGED_TOOL_TIMEOUT_DEFAULT_MS;
}

// Match the bridge deadline to the concrete ACC run_command request instead of showing a default 60-second
// command as "running" for the old blanket 650-second ceiling. Keep a small protocol/serialization grace;
// explicit WCW_BRIDGED_TIMEOUT_OVERRIDE values remain the harder outer cap used by tests/operators.
function bridgedToolCallTimeoutMs(name, args) {
  const bare = String(name || '').toLowerCase();
  const configured = bridgedToolTimeoutMs(name);
  if (bare !== 'run_command') return configured;
  const requestedSeconds = Number(args && args.timeout);
  const commandSeconds = Number.isFinite(requestedSeconds)
    ? Math.max(1, Math.min(600, requestedSeconds))
    : 60;
  return Math.max(1000, Math.min(configured, commandSeconds * 1000 + 10000));
}

const AgentLoopHooks = require('./backend/agent-loop-hooks.cjs').createAgentLoopHooks({
  makeId, logEvent: (...args) => logEvent(...args), redact,
});

const { createInterventionDecisions, interventionCommandFailure } = require('./backend/intervention-decisions.cjs');
const decideInterventionCommand = createInterventionDecisions({
  safeSessionId, makeId, readSessionHeadResilient, sessionMissionId, readInterventions,
  transitionInterventionState, pendingPermissions, pendingQuestions, pendingPlans,
  logEvent: (...args) => logEvent(...args),
});

// 75b: automatic timeout/teardown decisions participate in the same per-Intervention CAS as user
// decisions. The fallback is only for storage/core failure and must re-check the registry entry so a
// concurrently applying user command can never be overwritten by a legacy settle.
function runAutomaticInterventionDecision(command, fallback) {
  Promise.resolve()
    .then(() => decideInterventionCommand({ ...command, contractRequest: false, audit: false }))
    .then(result => { if (!result || result.status !== 200) fallback(); })
    .catch(() => fallback());
}

function clearPendingPermissions(sessionId, message) {
  for (const [rid, p] of pendingPermissions) {
    if (p.sessionId === sessionId) {
      if (p.commandApplying) continue; // 75b: command core owns resolve -> terminal -> registry cleanup ordering
      clearTimeout(p.timer);
      const note = String(message || 'session ended').slice(0, 500);
      runAutomaticInterventionDecision({
        missionId: sessionId, interventionId: rid, source: 'clear_permission', decidedBy: 'clear',
        idempotencyKey: `clear:${rid}`, payload: { action: 'deny', message: note },
      }, () => {
        if (pendingPermissions.get(rid) !== p || p.commandApplying) return;
        pendingPermissions.delete(rid);
        try { p.resolve({ behavior: 'deny', message: note }); } catch { /* already settled */ }
        settleIntervention(sessionId, rid, 'denied', { decidedBy: 'clear', note });
      });
    }
  }
}

const { normalizeUserQuestions, normalizeQuestionAnswer, formatQuestionGuidance, normalizeQuestionContext } = require('./backend/user-question-protocol.cjs');

function registerUserQuestion(sessionId, questionId, questions, onEvent, timeoutMs, deliver, context = '') {
  // Provider call ids are often reused as "call_1" across sessions, so never use them as registry keys.
  const sourceId = String(questionId || '');
  const id = makeId('question');
  const normalized = normalizeUserQuestions(questions);
  if (!normalized.length) return null;
  const questionContext = normalizeQuestionContext(context);
  const entry = { sessionId, questions: normalized, timer: null, deliver: null };
  entry.deliver = (answer, opts = {}) => {
    if (pendingQuestions.get(id) !== entry) return false;
    let accepted = false;
    try { accepted = deliver(answer) !== false; } catch { accepted = false; }
    if (!accepted) return false;
    clearTimeout(entry.timer);
    // 75b: decideIntervention owns the authoritative CAS row. It asks delivery to keep the registry entry
    // until terminal persistence and to skip the legacy side-ledger settle; timeout/teardown callers retain
    // the original self-contained behavior.
    if (opts.preserveRegistry !== true) pendingQuestions.delete(id);
    if (opts.skipInterventionSettle !== true) {
      settleIntervention(sessionId, id, answer && answer.ok !== false ? 'answered' : 'cancelled', { decidedBy: answer && answer.ok !== false ? 'user' : 'auto', note: answer && answer.content ? String(answer.content).slice(0, 500) : '' });
    }
    try {
      const summary = answer && answer.ok !== false
        ? String(answer.content || '').replace(/\s+/g, ' ').trim().slice(0, 500)
        : '';
      onEvent({ type: 'question_answer', questionId: id, ok: answer && answer.ok !== false, summary });
    } catch { /* a closed stream must not prevent the waiter from settling */ }
    return true;
  };
  entry.timer = null;
  // The timeout is re-armable: while the question modal stays open, UI heartbeats
  // (/api/question/heartbeat → extendUserQuestion) reset the deadline so composing a long
  // answer can never be cut off mid-way. The timer firing is the only backstop when the UI is gone.
  entry.armTimeout = () => {
    clearTimeout(entry.timer);
    entry.deadlineAt = Date.now() + entry.timeoutMs;
    entry.timer = setTimeout(() => {
      if (pendingQuestions.get(id) !== entry) return;
      const timeoutAnswer = { ok: false, answers: [], content: '(question timed out)' };
      runAutomaticInterventionDecision({
        missionId: sessionId, interventionId: id, source: 'timeout_question', decidedBy: 'timeout',
        idempotencyKey: `timeout:${id}`, payload: { action: 'answer', normalizedAnswer: timeoutAnswer },
      }, () => {
        if (pendingQuestions.get(id) === entry && !entry.commandApplying) entry.deliver(timeoutAnswer);
      });
    }, entry.timeoutMs);
  };
  entry.timeoutMs = promptWaitMs(timeoutMs);   // 0/缺省 = 不限时(见 promptWaitMs)
  entry.armTimeout();
  pendingQuestions.set(id, entry);
  onEvent({ type: 'ask_user', id, questionId: id, toolUseId: sourceId || undefined, questions: normalized, context: questionContext || undefined, deadlineAt: entry.deadlineAt, timeoutMs: entry.timeoutMs });
  registerIntervention(sessionId, 'question', id, {
    questionSummary: normalized.map(q => String(q.question || '').slice(0, 200)).join(' | '),
    questions: normalized,
    context: questionContext,
  });
  return id;
}

function requestUserQuestion(sessionId, questionId, questions, onEvent, timeoutMs, context = '') {
  return new Promise(resolve => {
    const id = registerUserQuestion(sessionId, questionId, questions, onEvent, timeoutMs, answer => { resolve(answer); return true; }, context);
    if (!id) resolve({ ok: false, answers: [], content: '', error: 'no valid questions' });
  });
}

// Heartbeat extension: the open question modal calls this periodically so a user composing a long
// answer never hits the deadline. Returns the fresh deadline/timeout for the UI countdown, or null
// when the question is gone (answered/timed out/cancelled) — the caller then stops its heartbeat.
function extendUserQuestion(sessionId, questionId) {
  const entry = pendingQuestions.get(String(questionId || ''));
  if (!entry || entry.sessionId !== sessionId || entry.commandApplying) return null;
  try { entry.armTimeout(); } catch { return null; }
  return { deadlineAt: entry.deadlineAt, timeoutMs: entry.timeoutMs };
}

function clearPendingQuestions(sessionId, message) {
  for (const [qid, q] of pendingQuestions) {
    if (q.sessionId !== sessionId) continue;
    if (q.commandApplying) continue; // 75b: do not race the authoritative command-core terminal commit
    clearTimeout(q.timer);
    const cancelled = { ok: false, answers: [], content: message || 'session ended' };
    runAutomaticInterventionDecision({
      missionId: sessionId, interventionId: qid, source: 'clear_question', decidedBy: 'clear',
      idempotencyKey: `clear:${qid}`, payload: { action: 'answer', normalizedAnswer: cancelled },
    }, () => {
      if (pendingQuestions.get(qid) !== q || q.commandApplying) return;
      try { q.deliver(cancelled); } catch { /* already settled */ }
      pendingQuestions.delete(qid);
    });
  }
}

// 47a(Steer Phase A 分流纪律):会话当前是否有等待回答的 AskUser 提问。Claude 引擎的提问答案与插话同走
// stdin user envelope —— 提问挂起期间注入插话,CLI 可能把插话误收为答案(串扰)。/api/steer 据此拒绝。
function hasPendingQuestionForSession(sessionId) {
  for (const [, q] of pendingQuestions) if (q.sessionId === sessionId) return true;
  return false;
}
// 128f-⑪:权限请求挂着时同样豁免回合的 idle 看门狗(三处:09 provider、05 Claude CLI、05b Kimi)。修前权限窗口 120 s
// 恒短于看门狗(默认 600 s),豁不豁免无所谓;定时线程的 30 分钟窗口早就被看门狗在 10 分钟处截断过(回合被当成「空闲」
// 杀掉,而不是按拒绝收尾让模型接着说),管家盯着的线程 600 s 窗口则与看门狗同长、谁先到算谁。权限自己的计时器到点
// 一定按拒绝落定,所以豁免不会让回合永远挂着。
function hasPendingPermissionForSession(sessionId) {
  const sid = String(sessionId || '');
  for (const [, p] of pendingPermissions) if (p && p.sessionId === sid) return true;
  return false;
}

// v0.9-S5: clear any pending PLAN approvals for a session (abort/stop/turn-end), resolving each as a REJECT
// so the paused runOpenAiTurn unblocks and finishes cleanly (never left hanging). Mirrors
// clearPendingPermissions — called from stopSession (abort/stop) and at turn end.
function clearPendingPlans(sessionId, message) {
  for (const [pid, p] of pendingPlans) {
    if (p.sessionId === sessionId) {
      if (p.commandApplying) continue; // 75b: command core clears after terminal persistence
      clearTimeout(p.timer);
      const note = message || 'session ended';
      runAutomaticInterventionDecision({
        missionId: sessionId, interventionId: pid, source: 'clear_plan', decidedBy: 'clear',
        idempotencyKey: `clear:${pid}`, payload: { action: 'reject', feedback: note },
      }, () => {
        if (pendingPlans.get(pid) !== p || p.commandApplying) return;
        pendingPlans.delete(pid);
        try { p.resolve({ decision: 'reject', note }); } catch { /* already settled */ }
      });
    }
  }
}

// ===================================================================================================
// v0.7d — zero-dependency MCP stdio client. Bridges an external stdio MCP server (e.g. the user's
// ai-computer-control desktop MCP) into the workbench so the NATIVE provider tool loop can call it.
// Protocol: JSON-RPC 2.0 over newline-delimited stdout (MCP 2024-11-05). All errors are internalized;
// a crashing/hung child can never take down the web server.
// ===================================================================================================

// ── hunt2-mcp:stdio / 远程两个客户端共用的小件(修前各抄一份,行为已经分叉过)──
// 单行上限:MCP 一条响应就是一行 JSON,读大文件/截图类工具一行几 MB 是常态。修前 4MB 处直接「截掉前半行」,
// 结果那一行永远拼不回完整 JSON、调用干等到超时再被杀进程。现在上限放宽,真超了就丢弃到下一个换行并
// 如实拒掉那一次调用(按行首的 id 找得到时),绝不在行中间切。
const { McpStdioClient, McpHttpClient, mcpToolAllowed, normalizeMcpToolResult, bridgedServerSpawnEnv, mcpCallToolParams } = require('./backend/mcp-transports.cjs').createMcpTransports({
  safeJsonParse, bridgedEnvKeyStripped, DesktopExecutionHooks, ProcessRuntime, killChildTree, bridgedToolCallTimeoutMs, mcpChildExitResult, _expandMcpVar, RUYI_MCP_SERVER_ID, VERSION,
});

// A real, safe tools/call roundtrip must preserve both reserved metadata and SDK numeric types.
// The schema-shape flag alone is insufficient. Never cache this across an MCP child replacement.
async function probeDesktopExecutionReceipts(client, options = {}) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const probeValues = { integer: 1000000000000000100, exponent: 1e21, decimal: 0.0000001,
    subnormal: Number.MIN_VALUE, zero: 0, unicode: '你好🚀' };
  const expected = executionArgumentsDigest(probeValues);
  const result = await client.callTool('execution_receipt', { invocation_id: '0'.repeat(32), probe_values: probeValues },
    8000, { ...options, meta: { 'org.ruyi.workbench/execution-probe-v1': { schema: 1, nonce } } });
  const probe = result?.metadata_probe;
  if (result?.ok !== true || result.execution_receipt_version !== 1 || result.semantic_validation?.semantic_version !== 1 || !probe || probe.schema !== 1 || probe.nonce !== nonce
      || probe.context_required !== true || probe.args_semantic_codec !== 'ruyi-sdk-json-v1' || probe.received_semantic_sha256 !== expected
      || !/^[a-f0-9]{32}$/.test(probe.acc_worker_id || '') || !Number.isSafeInteger(probe.acc_pid) || probe.acc_pid <= 0) {
    return { ok: false, code: 'execution_receipts_unavailable', outcome: 'not_dispatched', action_sent: false };
  }
  return { ok: true, receiptVersion: 1, argumentsCodec: probe.args_semantic_codec,
    accWorkerId: probe.acc_worker_id, accPid: probe.acc_pid, contextRequired: true };
}

// Live bridged-client registry (shared across turns). Lazy start; a failed start is cached as a
// negative entry (with a timestamp) so we don't respawn a broken server on every single turn.
const mcpClients = new Map();       // serverId -> McpStdioClient
const mcpClientFailures = new Map(); // serverId -> { at, error }
const MCP_FAILURE_COOLDOWN_MS = 60000;
const mcpClientPending = new Map();  // 55a: serverId -> 进行中的 start Promise(并发互斥,防孤儿子进程)
const mcpStartingClients = new Map(); // 55a: serverId -> 正在握手(尚未入 mcpClients)的客户端,invalidate 时需 kill
const mcpClientGen = new Map();     // 55a: serverId -> 代数;invalidate 自增以让在途 start 结果作废、不写冷却
// hunt2-mcp:serverId -> 当前运行时状态(活客户端 / 在途启动 / 失败冷却)所属条目的指纹。上面几张表都只按 id 记账,
// 修前用户在设置页 / import-folder / import-config 里改好了一个坏连接器(同 id),旧进程、旧冷却(60s 内一律 null)
// 与在途启动照用不误 —— 「改好了还是连不上」。现在取客户端前先比指纹,变了就按 invalidateMcpRuntime 作废旧的。
const mcpClientFingerprints = new Map();
function mcpEntryFingerprint(entry) {
  const e = entry || {};
  return JSON.stringify([e.transport || 'stdio', e.command || '', e.args || [], e.cwd || '', e.env || {}, e.url || '', e.headers || {},
    e.bearerTokenEnvVar || '', e.startupTimeoutMs || 0, e.toolTimeoutMs || 0, e.enabledTools || null, e.disabledTools || null]);
}
function reconcileMcpEntryFingerprint(entry) {
  if (!entry || !entry.id) return;
  const fp = mcpEntryFingerprint(entry);
  const prev = mcpClientFingerprints.get(entry.id);
  if (prev !== undefined && prev !== fp) invalidateMcpRuntime(entry.id);
  mcpClientFingerprints.set(entry.id, fp);
}

const ToolboxHooks = {};

function safeMcpInventory(config) {
  return resolveExternalMcpServers(config).map(entry => ({
    id: entry.id, label: entry.label || entry.id, command: entry.command, args: mcpArgsForDisplay(entry.args || []),   // 107-S0b:args 显示脱敏(`--token xyz` 一类)
    cwd: entry.cwd || '', envKeys: Object.keys(entry.env || {}),
    // 49c:远程条目无 command,回显 transport+url(headers 键名可见,值永不回显)。
    // 107-S2:url 过 safeUrlForDisplay —— `https://u:p@host` 与 `?api_key=…` 此前经 mcp_list 明文回给模型。
    ...(entry.transport ? { transport: entry.transport, url: safeUrlForDisplay(entry.url || ''), headerKeys: Object.keys(entry.headers || {}) } : {}),
    builtin: entry.id === 'ai-computer-control',
  }));
}

function invalidateMcpRuntime(id) {
  invalidateMcpDropInCache();
  bridgedCatalogCache = { key: '', expiresAt: 0, value: null };
  if (id) {
    const client = mcpClients.get(id);
    if (client) { try { client.kill(); } catch { /* ignore */ } mcpClients.delete(id); }
    // 55a: kill 正在握手(尚未入 mcpClients)的子进程 -- 否则一个 HANG 初始化的进程会活到 8s rpc 超时,
    // 既成孤儿(toggle 应立即停),又会让后续并发 probe 复用其永挂的 pending Promise 而不重新 spawn。
    const starting = mcpStartingClients.get(id);
    if (starting) { try { starting.kill(); } catch { /* ignore */ } mcpStartingClients.delete(id); }
    mcpClientFailures.delete(id);
    // hunt2-mcp:在途 start 的 Promise 也摘掉 —— 否则紧接着的 getMcpClient 会复用这个已被作废(结果注定 null)的
    // Promise,而不是按新配置重新起一个。
    mcpClientPending.delete(id);
    mcpClientFingerprints.delete(id);
    // 自增代数:在途 start(其 Promise 仍可能被并发 probe await)settle 后据此作废结果——
    // 已 killed 的失败不写冷却(否则 toggle-on 后立刻又命中 60s 冷却不重连)。
    mcpClientGen.set(id, (mcpClientGen.get(id) || 0) + 1);
  }
}

// 55b: toggle/delete 的源守卫。config 源(externalMcpServers 里有该 id)-> null(可操作);
// 内置 desktop / drop-in -> 409 + 人话原因;都没找到 -> 404。toggle 与 delete 共用,防两路判定分歧。
// 117n-M2:从 13b 下沉到 04 —— 工具面的 mcp_configure 也必须走这条护栏,而它住 04,04 -> 13b 是前向边。
// opts.allowMissing:upsert 语义下「本来就没有」是合法的新建,不算错;内置与 drop-in 仍然挡。
function mcpConnectorMutateError(id, config, opts) {
  if (id === 'ai-computer-control') return { status: 409, error: '内置桌面连接器(ai-computer-control)不可在此启停/删除;请在「设置」中调整桌面控制开关。' };
  // 如意自己的 MCP server id(ruyi 与旧名 win-claude-workbench)是保留名:新建 / 改写成这个 id 的外部连接器,
  // 生成 MCP 配置时会被静默丢掉,连接器列表里还会出现两个同名项。导入路径早就挡了,这里补上手动新建 / mcp_configure。
  // 已经存在的同名旧条目仍然允许停用 / 删除(allowMissing 只在 upsert 时给)。
  if (opts && opts.allowMissing && isRuyiMcpServerId(id)) return { status: 409, error: `「${id}」是如意自己的 MCP 服务名,不能用作外部连接器的 id;请换一个 id。` };
  const list = (config && Array.isArray(config.externalMcpServers)) ? config.externalMcpServers : [];
  if (list.some(s => s && s.id === id)) return null;
  const drop = scanMcpDropIns().find(d => d && d.id === id);
  if (drop) return { status: 409, error: `连接器「${id}」是 drop-in 目录运行时合并的(${drop._dropInFolder}),不可在此启停/删除/改写;请移除对应目录后再试。` };
  if (opts && opts.allowMissing) return null;
  return { status: 404, error: '未找到连接器: ' + id };
}

// 停用/删除遮蔽了同 id drop-in 的 config 条目时的如实告知(resolveExternalMcpServers:config 优先,
// 条目消失/停用后 drop-in 落入清单)。两个动作两句话,别处不要再抄一份。
const MCP_DROPIN_SHADOW_WARNING = {
  remove: '注意:存在同 id 的 drop-in 连接器,删除该 config 条目后 drop-in 版本将生效;如需彻底移除,请同时删除对应 drop-in 目录。',
  disable: '注意:存在同 id 的 drop-in 连接器,停用该 config 条目后 drop-in 版本将生效;如需彻底停用,请移除对应 drop-in 目录。',
};

// ── 117n-M2:MCP 连接器变更的唯一内核 ────────────────────────────────────────────────────────
// 修前同一件事有两处独立实现。HTTP 面(13b 的 POST /api/mcp/connectors/toggle 与
// DELETE /api/mcp/connectors)做了八件事:源守卫 -> 改 list -> 落盘 -> invalidateMcpRuntime ->
// 重生成 .mcp.json -> 删除时记 dismissedMcpIds -> drop-in 遮蔽警告 -> 审计。
// 工具面(mcp_configure -> configureMcpFromTool)只做了其中三件,于是漏了三项副作用:
//   · remove 不记 dismissedMcpIds -> 模型删掉的连接器下次启动被 autoImportClaudeCodeMcp 悄悄加回来;
//   · 不调 generateMcpConfig -> .mcp.json 落后于 config.json,CLI 侧看到的是旧清单;
//   · 没有源守卫(只硬编码挡了 ai-computer-control)-> drop-in 来源的连接器在工具面能改、
//     HTTP 面却拒绝(同一件事两套判据),且零审计。
// 现在两边都调这里,判据与副作用只有一份。op:'set-enabled' | 'remove' | 'upsert'
// (upsert 是工具面专有的写入操作,但走同一条护栏与同一个 generateMcpConfig 收尾)。
// 不收 config 入参:护栏与改 list 必须发生在 mutateConfig 的锁内、基于锁内刚读到的那一份,
// 拿调用方的快照判定等于把丢失更新换个地方留着。
// 返回 { ok:false, status, error } 或 { ok:true, op, id, config, server, removed, warning? }。
async function mutateMcpConnector({ op, id, enabled, server }) {
  const wantId = String(id || '').trim();
  if (!wantId) return { ok: false, status: 400, error: 'id is required' };
  const on = enabled !== false;
  const r = await mutateConfig(async (config) => {
    const guard = mcpConnectorMutateError(wantId, config, { allowMissing: op === 'upsert' });
    if (guard) return { abort: { ok: false, status: guard.status, error: guard.error } };
    const list = Array.isArray(config.externalMcpServers) ? config.externalMcpServers.slice() : [];
    const dismissed = Array.isArray(config.dismissedMcpIds) ? config.dismissedMcpIds.slice() : [];
    const idx = list.findIndex(s => s && s.id === wantId);
    if (op === 'set-enabled') {
      list[idx] = { ...list[idx], enabled: on };
    } else if (op === 'remove') {
      list.splice(idx, 1);
      // 记入 dismissedMcpIds:启动时 autoImportClaudeCodeMcp 会跳过它,避免「删了又自动回来」。
      // (normalizeConfig 去重;用户经 import-folder/import-config/upsert 显式再导入会从 dismissed 移除。)
      if (!dismissed.includes(wantId)) dismissed.push(wantId);
    } else if (op === 'upsert') {
      // 107-S0b:模型可能把读到的掩码(env／headers 的 ••••、args 的脱敏标记)原样回传 —— 与 POST /api/config 同一条
      // 还原规则:同 id 且启动向量(command／cwd／args,远程为 url)没变才取磁盘真值,否则 sanitize 那道闸清空。
      // 107-S2:远程 url 的显示脱敏(`?api_key=••••cdef`)也在这里对回真值 —— 模型从 mcp_list／
      // steward_config_get 读到的就是脱敏形,原样 upsert 回来是常态。对不回去的(改了一半的掩码)
      // 活不过 sanitize -> 下面那句 400,不会把掩码写进 config.json,也不会把连接器静默改接到别处。
      const clean = sanitizeExternalMcpServer(restoreExternalMcpServerSecrets({ ...(server || {}), id: wantId }, idx >= 0 ? list[idx] : null, collectDisplayUrlRestores(config)));
      if (!clean) return { abort: { ok: false, status: 400, error: 'MCP 配置无效：upsert 至少需要 id 与 command，args 必须是字符串数组。' } };
      // 122-§2.6:用户/工具显式 upsert = 接管这条连接器 —— 清掉来源标记,它从此算 Ruyi 自己的、照常同步回
      // Claude Code。显式删掉(不是让 sanitize 缺省丢弃):调用方可能把读出来的整条 server 原样回传。
      delete clean.origin;
      if (idx >= 0) list[idx] = clean; else list.push(clean);
      // 显式(再)导入覆盖撤销 —— 与 import-folder / import-config/apply 同语义。
      for (let i = dismissed.length - 1; i >= 0; i--) if (dismissed[i] === wantId) dismissed.splice(i, 1);
    } else {
      return { abort: { ok: false, status: 400, error: 'operation 必须是 upsert、remove 或 set-enabled' } };
    }
    config.externalMcpServers = list;
    config.dismissedMcpIds = dismissed;
    return {};
  });
  if (!r.ok) return r.value;
  const next = r.config;
  invalidateMcpRuntime(wantId); // 杀活客户端 / 清失败冷却:停用后不再重连,启用后可立即重测
  await generateMcpConfig(next.mcpCommandMode).catch(() => {}); // 与 import 路径一致:启用集变化后再生成 .mcp.json
  const shadowKind = op === 'remove' ? 'remove' : (op === 'set-enabled' && !on ? 'disable' : '');
  const warning = (shadowKind && scanMcpDropIns().some(d => d && d.id === wantId)) ? MCP_DROPIN_SHADOW_WARNING[shadowKind] : null;
  if (op === 'remove') logEvent({ kind: 'mcp_connector_delete', id: wantId });
  else if (op === 'set-enabled') logEvent({ kind: 'mcp_connector_toggle', id: wantId, enabled: on });
  else logEvent({ kind: 'mcp_connector_upsert', id: wantId });
  return { ok: true, op, id: wantId, config: next, removed: op === 'remove',
    server: (next.externalMcpServers || []).find(s => s && s.id === wantId) || null,
    ...(warning ? { warning } : {}) };
}

// 工具面入口(mcp_configure)。117n-M2 起只剩「工具形状 + set-browser」,连接器三操作全部转
// mutateMcpConnector。第二个参数 currentConfig 保留在签名里只为兼容既有调用点(12-tool-dispatch),
// 【有意不再使用】:落盘前的读必须发生在 mutateConfig 的锁内,回合起点的快照到这里已可能陈旧。
// 把 args 字符串按 shell 口径切开(空白分隔,单/双引号成组,不处理反斜杠转义 —— Windows 路径里全是反斜杠)。
function splitMcpArgsString(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]));
  return out;
}
// 外部 MCP 连接器 id 的合法形(与 upsert 落盘文件名/CLI 键名兼容;含空格/斜杠/.. 的 id 会让 .mcp.json 键与路径判断出岔子)。
const MCP_CONNECTOR_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// set-browser 的入参校验与合并 —— 修前对非法输入一律静默改写成默认值还回 ok:true(mode:'bogus' 存成 system、
// 缺 browser 对象把自定义的 executable/cdpUrl 重置、cdpUrl:'not a url' 原样落盘、custom 没有 executable 也存)。
// 现在:只改显式给出的字段(其余沿用磁盘上的现值);任何一项不合法就整次拒绝并点名允许值。返回 { error } 或 { browser }。
function validateBrowserTargetPatch(raw, current) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) {
    return { error: `set-browser 需要 browser 对象:{mode: ${BROWSER_AUTOMATION_MODES.join('|')}, executable?, cdpUrl?}` };
  }
  const next = { ...(current || {}) };
  if (raw.mode !== undefined) {
    const mode = String(raw.mode).trim().toLowerCase();
    if (!BROWSER_AUTOMATION_MODES.includes(mode)) return { error: `browser.mode 无效:${JSON.stringify(raw.mode)};允许值 ${BROWSER_AUTOMATION_MODES.join(' / ')}` };
    next.mode = mode;
  }
  if (raw.executable !== undefined) {
    if (typeof raw.executable !== 'string') return { error: 'browser.executable 必须是字符串(浏览器可执行文件路径)' };
    next.executable = raw.executable.trim();
  }
  if (raw.cdpUrl !== undefined) {
    const url = typeof raw.cdpUrl === 'string' ? raw.cdpUrl.trim() : '';
    let ok = false;
    try { ok = /^(https?|wss?):$/.test(new URL(url).protocol); } catch { ok = false; }
    if (!ok) return { error: `browser.cdpUrl 不是合法地址:${JSON.stringify(raw.cdpUrl)};需要 http(s):// 或 ws(s):// 开头,如 http://127.0.0.1:9222` };
    next.cdpUrl = url;
  }
  if (next.mode === 'custom' && !String(next.executable || '').trim()) return { error: "browser.mode 为 custom 时必须同时给出 executable(浏览器可执行文件的完整路径)" };
  return { browser: { mode: next.mode, executable: next.executable, cdpUrl: next.cdpUrl } };
}

// 工具面入口(mcp_configure)。117n-M2 起只剩「工具形状 + set-browser」,连接器三操作全部转
// mutateMcpConnector。第二个参数 currentConfig 保留在签名里只为兼容既有调用点(12-tool-dispatch),
// 【有意不再使用】:落盘前的读必须发生在 mutateConfig 的锁内,回合起点的快照到这里已可能陈旧。
async function configureMcpFromTool(args, currentConfig) {
  void currentConfig; // 见上:有意不用
  const operation = String(args && args.operation || '').trim();
  if (operation === 'set-browser') {
    // 校验与合并都在 mutateConfig 的锁内、基于锁内刚读到的那份现值(同连接器写入的纪律)。
    const r = await mutateConfig(async (config) => {
      const checked = validateBrowserTargetPatch(args && args.browser, config.browserAutomation);
      if (checked.error) return { abort: { ok: false, operation, error: checked.error } };
      config.browserAutomation = checked.browser;
      return {};
    });
    if (!r.ok) return r.value;
    invalidateMcpRuntime('ai-computer-control');
    return { ok: true, operation, browserAutomation: r.config.browserAutomation,
      note: '浏览器目标已保存；当前桌面 MCP 连接已刷新，下一次工具发现会按新策略启动。' };
  }
  const id = String(args && (args.id || (args.server && args.server.id)) || '').trim();
  if (!id || id === 'ai-computer-control') return { ok: false, error: '外部 MCP 需要合法 id；内置 ai-computer-control 只能用 set-browser 调整浏览器目标。' };
  if (operation !== 'upsert' && operation !== 'remove' && operation !== 'set-enabled') {
    return { ok: false, error: 'operation 必须是 upsert、remove、set-enabled 或 set-browser' };
  }
  let server = (args && args.server) || null;
  if (operation === 'upsert') {
    // 新建/改写的入口形状校验(remove / set-enabled 不卡:历史导入的 id 可能带别的字符,照样要能停用/删除)。
    if (!MCP_CONNECTOR_ID_RE.test(id)) return { ok: false, operation, id, error: 'MCP id 只能含字母、数字、下划线、点和连字符(1-64 个字符),不能含空格或斜杠。' };
    if (server !== null && (typeof server !== 'object' || Array.isArray(server))) return { ok: false, operation, id, error: 'server 必须是对象:{command, args[], cwd, env{}, enabled},远程连接器用 {transport, url}' };
    if (server && server.args !== undefined) {
      // args 给成一个字符串(模型常这么写)修前被静默存成 [];按 shell 口径切开,数组里混进非字符串则拒绝。
      if (typeof server.args === 'string') server = { ...server, args: splitMcpArgsString(server.args) };
      else if (!Array.isArray(server.args) || server.args.some(a => typeof a !== 'string')) return { ok: false, operation, id, error: 'server.args 必须是字符串数组(或一个按空格切分的字符串)。' };
    }
  }
  const r = await mutateMcpConnector({ op: operation, id, enabled: args && args.enabled, server });
  if (!r.ok) return { ok: false, operation, id, error: r.error };
  const saved = r.server;
  return { ok: true, operation, id, removed: r.removed, ...(r.warning ? { warning: r.warning } : {}),
    server: saved ? { id: saved.id, label: saved.label, command: saved.command, args: mcpArgsForDisplay(saved.args), cwd: saved.cwd, enabled: saved.enabled, envKeys: Object.keys(saved.env || {}) } : null,   // 107-S0b:args 显示脱敏
    note: '配置已原子保存并刷新工具目录；若工具仍不可用，请读取 MCP 列表与启动诊断。' };
}

// 审计 A14:桥接子进程在一次调用中途退出(崩溃 / 被外部杀 / OOM)。返回给模型的错误说明是哪个工具、哪个组件、退出码、
// 是否会自动重启以及重试口径 —— 修前只有「mcp child exited」,模型无从判断是自己的参数错还是环境坏了。
function mcpChildExitResult(client, toolName, info) {
  const id = client && client.id ? String(client.id) : 'mcp';
  const isDesktop = id === 'ai-computer-control';
  const who = isDesktop ? `desktop control component (${id})` : `MCP server '${id}'`;
  const how = `code ${info && info.code != null ? info.code : 'null'}${info && info.signal ? `, signal ${info.signal}` : ''}`;
  const tail = info && info.stderrTail ? ` Last stderr: ${info.stderrTail.replace(/\s+/g, ' ').slice(-300)}` : '';
  return {
    ok: false, code: 'mcp-child-exited', retryable: true, serverId: id, tool: String(toolName || ''),
    error: `tool '${toolName}' was interrupted: the ${who} process exited unexpectedly (${how}). It restarts automatically on the next call: retry the call once; any state it held in memory (open browser pages, recording, thinking chain) is lost, and if the same call kills it again, stop retrying and report the failure.${tail}`,
  };
}
// 审计 A14:getBridgedClient 返回 null 时的说明 —— 带上上一次启动失败的原因与冷却剩余,而不是一句「not available」。
function bridgedServerUnavailableMessage(serverId) {
  const base = `bridged MCP server '${serverId}' is not available`;
  const fail = mcpClientFailures.get(serverId);
  if (!fail) return `${base} (it could not be started or has no launch command configured)`;
  const leftSec = Math.max(0, Math.ceil((MCP_FAILURE_COOLDOWN_MS - (Date.now() - fail.at)) / 1000));
  return `${base}: the last start failed: ${String(fail.error || 'unknown error').slice(0, 300)}. ${leftSec > 0 ? `It will be retried automatically in about ${leftSec}s.` : 'It will be retried on the next call.'} Use another tool meanwhile.`;
}
// Get (lazily starting) a live client for one server entry, or null if it can't start. Caches failures.
// 49c:按 entry.transport 选客户端类 —— sse/http 走 McpHttpClient(无进程,远程连接),其余走 stdio。
async function getMcpClient(entry) {
  reconcileMcpEntryFingerprint(entry);
  const existing = mcpClients.get(entry.id);
  if (existing && !existing.dead) return existing;
  if (existing && existing.dead) mcpClients.delete(entry.id);
  const fail = mcpClientFailures.get(entry.id);
  if (fail && (Date.now() - fail.at) < MCP_FAILURE_COOLDOWN_MS) return null;   // in cooldown
  // 55a: 并发互斥 -- 同一 entry.id 的并发 getMcpClient 复用同一个 start Promise。probeMcpConnector 的
  // start race-timeout(可低至 2s)先于 getMcpClient 的 8s rpc 超时返回,若无互斥,第二次 probe 会 spawn
  // 第二个子进程;两个都成功时第一个子进程成孤儿(child.unref 只防阻止退出不杀进程,持有句柄/端口/锁)。
  if (mcpClientPending.has(entry.id)) return mcpClientPending.get(entry.id);
  const gen = (mcpClientGen.get(entry.id) || 0);
  const p = (async () => {
    const client = (entry.transport === 'sse' || entry.transport === 'http') ? new McpHttpClient(entry) : new McpStdioClient(entry);
    mcpStartingClients.set(entry.id, client);
    try {
      await client.start();
      // 启动期间被 invalidateMcpRuntime 作废(配置变更/toggle):丢弃结果,不登记为活客户端,也不写失败冷却。
      if ((mcpClientGen.get(entry.id) || 0) !== gen) { try { client.kill(); } catch { /* ignore */ } return null; }
      mcpClients.set(entry.id, client);
      mcpClientFailures.delete(entry.id);
      return client;
    } catch (e) {
      // 被 invalidate kill 的在途启动:不写冷却(用户期望 toggle-on 后可立即重连)。
      if ((mcpClientGen.get(entry.id) || 0) !== gen) return null;
      mcpClientFailures.set(entry.id, { at: Date.now(), error: (e && e.message) || String(e) });
      logEvent({ kind: 'mcp_bridge_start_failed', serverId: entry.id, error: (e && e.message) || String(e) });
      return null;
    } finally {
      if (mcpStartingClients.get(entry.id) === client) mcpStartingClients.delete(entry.id);
    }
  })();
  mcpClientPending.set(entry.id, p);
  // 只摘自己那一个:invalidate 之后别人可能已经放进了新的在途 Promise。
  try { return await p; } finally { if (mcpClientPending.get(entry.id) === p) mcpClientPending.delete(entry.id); }
}

// Kill every live bridged client (called on process exit / cleanup).
function killAllMcpClients() {
  for (const [, c] of mcpClients) { try { c.kill(); } catch { /* ignore */ } }
  mcpClients.clear();
  // hunt2-mcp:还在握手的也要杀 —— 修前退出时它们不在 mcpClients 里,子进程成孤儿(unref 过,不拦退出)。
  for (const [, c] of mcpStartingClients) { try { c.kill(); } catch { /* ignore */ } }
  mcpStartingClients.clear();
}

// 47b:桥客户端获取的统一入口 —— 活则直给;死/缺则按 config 的服务器条目经 getMcpClient 惰性重 spawn。
// 此前三处分发点(12-tool-dispatch / 08 / 09)直接 mcpClients.get,47b 超时杀客户端后永远 'not available'
// 无法自愈;统一走这里后,"超时杀 → 下次调用自动重连"的契约闭环。
async function getBridgedClient(serverId, config) {
  const live = mcpClients.get(serverId);
  if (live && !live.dead) return live;
  const list = resolveExternalMcpServers(config || await readConfig());
  const entry = (list || []).find(s => s.id === serverId);
  if (!entry || (!entry.command && !entry.url)) return null; // 49c:远程条目无 command,认 url
  return getMcpClient(entry);
}

// Stable, reversible-ish server-id sanitizer for the bridged tool-name prefix. Non [A-Za-z0-9_] -> _.
function sanitizeServerId(id) { return String(id || '').replace(/[^A-Za-z0-9_]/g, '_'); }
// hunt2-mcp:provider 的函数名只收 ^[a-zA-Z0-9_-]{1,64}$。修前前缀冲突(my-srv 与 my_srv 都成 my_srv)时后到的
// 服务器工具被静默丢掉;工具名里带 . / 空格或总长超 64 的,整批请求被 provider 400 拒掉。
// 前缀冲突:先到者(desktop 在最前)保留原前缀,后到者加 id 的短哈希;名字非法字符转 _,超长截断并补哈希保唯一。
function mcpShortHash(text) { return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 6); }
function bridgedToolFunctionName(prefix, toolName) {
  const raw = `${prefix}__${String(toolName).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  if (raw.length <= 64) return raw;
  return raw.slice(0, 57) + '_' + mcpShortHash(`${prefix}__${toolName}`);
}

// v0.7d line 2: collect bridged tools for THIS turn (once). Returns { tools:[openai fn schema], route }.
// route maps bridgedName -> { serverId, toolName }. Any server that fails to start/list is skipped;
// never throws, never blocks the main flow.
let bridgedCatalogCache = { key: '', expiresAt: 0, value: null };
// 整体扫描时限:getCapabilities 冷启动(网络探测 + 全量 MCP 扫描)不能无限期阻塞 —— 本机 ~/.claude.json
// 可能导入 10+ 个 MCP(含挂起桩 stdio-hang),串行 listTools 实测可达 18.9s,远超 /api/capabilities 的
// HTTP 超时(e2e 8s)。到点返回已收集的部分结果,不因单个慢/挂 MCP 拖死整次探测。
// 单个 MCP 的握手预算:start() 内部 initialize + tools/list 各 8s 上限,挂起桩(stdio-hang)串行可吃满 16s。
// 扫描期对每个 entry 用该预算 race,超时即跳过该 MCP —— 扫描不被单桩拖死,慢 MCP 的下次调用再补(有 60s 冷却)。
const BRIDGED_ENTRY_START_TIMEOUT_MS = Number(process.env.WCW_BRIDGED_ENTRY_START_TIMEOUT_MS) || 3500;   // env 仅为测试缝(unit/bridged-catalog-incomplete)
// 整体扫描时限:getCapabilities 冷启动(网络探测 + 全量 MCP 扫描)不能无限期阻塞 —— 本机 ~/.claude.json
// 可能导入 10+ 个 MCP,串行扫描实测可达 18.9s,远超 /api/capabilities 的 HTTP 超时(e2e 8s)。
// 到点返回已收集的部分结果,不因单个慢/挂 MCP 拖死整次探测。
const BRIDGED_CATALOG_SCAN_TIMEOUT_MS = 8000;

async function collectBridgedTools(config, force = false) {
  if (!config || config.bridgeExternalToolsToProvider === false) return { tools: [], route: {} };
  const entries = resolveExternalMcpServers(config);
  const cacheKey = JSON.stringify(entries.map(e => [e.id, mcpEntryFingerprint(e)]));   // 过滤表 / 超时 / 头也算目录变化
  if (!force && bridgedCatalogCache.value && bridgedCatalogCache.key === cacheKey && Date.now() < bridgedCatalogCache.expiresAt) {
    return bridgedCatalogCache.value;
  }
  // 残缺目录不进长缓存(审计 A3)之后,启动期一阵并发请求(状态轮询 / 能力探测 / 首回合)会各自重扫、各自再等一轮
  // 启动竞速:同一 key 的扫描在飞时直接共用它;force 照旧另起。
  if (!force && bridgedCatalogInflight && bridgedCatalogInflight.key === cacheKey) return bridgedCatalogInflight.promise;
  const promise = collectBridgedToolsScan(config, entries, cacheKey);
  if (!force) bridgedCatalogInflight = { key: cacheKey, promise };
  try { return await promise; }
  finally { if (bridgedCatalogInflight && bridgedCatalogInflight.promise === promise) bridgedCatalogInflight = null; }
}
let bridgedCatalogInflight = null;   // { key, promise }:同一 key 的目录扫描在飞时共用
// 残缺目录也短暂缓存 1 s:吸收紧挨着的一串调用,又不耽误慢起来的 MCP 在下一次(>1 s 后)被补进目录。
const BRIDGED_CATALOG_INCOMPLETE_TTL_MS = 1000;
async function collectBridgedToolsScan(config, entries, cacheKey) {
  const tools = [];
  const route = {};
  let incomplete = false;   // 有 entry 没在预算内起来 / 起不来:这一次的目录是残缺的
  const scan = (async () => {
    // 并行收集每个 entry 的 client + tools —— N 个 MCP 同时启动,单个慢/挂不再拖慢其它(每 entry 有独立握手预算)。
    const collected = await Promise.all(entries.map(async (entry) => {
      let client = null;
      try {
        // 每 entry 的 getMcpClient(内含 start 握手)跑在独立 race 里:挂起桩最多占自身预算,不影响并行中的其余 MCP。
        client = await Promise.race([
          getMcpClient(entry),
          new Promise(res => setTimeout(() => res('__timeout__'), BRIDGED_ENTRY_START_TIMEOUT_MS)),
        ]);
      } catch { client = null; }
      if (!client || client === '__timeout__') { incomplete = true; return null; }   // 审计 A3:没扫全的目录不缓存
      let list;
      try { list = await client.listTools(); } catch { list = []; }
      return { entry, list: Array.isArray(list) ? list : [] };
    }));
    const prefixOwner = new Map();   // 前缀 -> 占用它的 serverId
    for (const item of collected) {
      if (!item) continue;
      const { entry, list } = item;
      let prefix = sanitizeServerId(entry.id);
      if (prefixOwner.has(prefix) && prefixOwner.get(prefix) !== entry.id) {
        const taken = prefix;
        prefix = `${prefix}_${mcpShortHash(entry.id)}`;
        logEvent({ kind: 'mcp_bridge_prefix_collision', serverId: entry.id, other: prefixOwner.get(taken), prefix });
      }
      prefixOwner.set(prefix, entry.id);
      for (const t of list) {
        if (!t || typeof t.name !== 'string' || !t.name) continue;
        if (!mcpToolAllowed(entry, t.name)) continue;   // 条目 enabledTools / disabledTools
        const bridgedName = bridgedToolFunctionName(prefix, t.name);
        // Never overwrite an already-claimed name (defensive; prefixes make collisions unlikely).
        if (route[bridgedName]) continue;
        route[bridgedName] = { serverId: entry.id, toolName: t.name };
        tools.push({
          type: 'function',
          function: {
            name: bridgedName,
            description: t.description || t.name,
            parameters: (t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema : { type: 'object', properties: {} },
          },
        });
      }
    }
  })();
  // 整体时限兜底:超时后返回当前已收集的部分(可能缺慢 MCP 的工具,但探测本身不再被拖死)。
  let scanDone = false;
  try {
    await Promise.race([scan.then(() => { scanDone = true; }), new Promise(res => setTimeout(res, BRIDGED_CATALOG_SCAN_TIMEOUT_MS))]);
  } catch { /* 并行收集失败不阻断 —— 返回已收集部分 */ }
  if (!scanDone) incomplete = true;
  const value = { tools, route };
  // 审计 A3:桌面组件(ACC)冷启动可能赶不上 3.5 s 的启动竞速。修前把「缺了它」的目录照常缓存 60 s,首几个回合模型看不到任何桌面
  // 工具、tool_search 也搜不到。现在残缺目录【不缓存】:下一次调用重新扫(慢的那个 start 仍在后台跑,getMcpClient 的
  // 待决互斥保证不会重复起进程;真起不来的有 60 s 失败冷却,重扫是廉价的 null)。
  if (incomplete) {
    bridgedCatalogCache = { key: cacheKey, expiresAt: Date.now() + BRIDGED_CATALOG_INCOMPLETE_TTL_MS, value };
    return value;
  }
  bridgedCatalogCache = {
    key: cacheKey,
    expiresAt: Date.now() + Math.max(5000, Number(config.toolCatalogCacheTtlMs) || 60000),
    value,
  };
  return value;
}

// ── 第55波 EC-C 55a: MCP 运维闭环 -- 统一读模型 + 健康探针 + 错误归类 + 兼容矩阵 ──────────
// 目标(roadmap EC-C):让非程序员不编辑 JSON 也能判断「接上了没有、为什么不可用、怎样恢复」。
// 本批为后端地基(路由在 13b,前端在 55c):
//  - MCP_COMPAT_MATRIX:在连接前说明 stdio/sse/http 各 transport 的能力与局限(退出条件#4)。
//  - classifyMcpError:把裸错误归一为 7 类(startup/network/auth/protocol/tool_registration/timeout/
//    security),而非统一「连接失败」(退出条件#3)。
//  - probeMcpConnector:对单连接器做一次显式健康探测,复用 getMcpClient(活则直给、死则重 spawn),
//    绝不抛,返回结构化 status。start 阶段用 probe 超时竞速(避免 8s rpc 超时拖慢用户重测)。
//  - buildMcpConnectorInventory:合并 desktop/config/drop-in 三源为带 source/transport/commandOrUrl/
//    enabled/builtIn/capabilities 的统一清单(含 disabled 条目,UI 需展示并允许启用);env 值掩码,
//    不返回可执行命令串供前端拼写(配置变更走 import/toggle 路由 + token + 审计,退出条件#5)。
const MCP_COMPAT_MATRIX = {
  stdio: {
    transport: 'stdio',
    capabilities: ['initialize', 'tools/list', 'tools/call', 'notifications/cancelled'],
    limitations: ['无服务端推送 tools/list_changed(工具列表变化需重新 tools/list 探测)'],
    supportsListChanged: false,
  },
  http: {
    transport: 'http (streamable-HTTP 2025-03-26)',
    capabilities: ['initialize', 'tools/list', 'tools/call', 'Mcp-Session-Id 会话', 'tools/list_changed 推送'],
    limitations: ['需可访问 URL;密钥引用连接时才展开(不落盘明文)'],
    supportsListChanged: true,
  },
  sse: {
    transport: 'sse (legacy 2024-11-05)',
    capabilities: ['initialize', 'tools/list', 'tools/call', 'tools/list_changed 推送'],
    limitations: ['legacy transport;新建连接器优先 streamable-HTTP'],
    supportsListChanged: true,
  },
};

// 把裸错误归一为 EC-C 退出条件要求的 7 类。顺序敏感:先匹配更具体的类别(auth/startup/network/
// timeout/security/tool_registration 在 protocol 之前,因为握手失败往往携带更具体的根因词)。
function classifyMcpError(err, entry) {
  const raw = (err && err.message) ? err.message : String(err == null ? '' : err);
  const msg = raw.toLowerCase();
  const transport = entry && entry.transport;
  // auth:HTTP 401/403(远程 transport 鉴权失败)。锚定 HTTP 上下文(HTTP/状态/status/code + 数字),
  // 避免误匹配端口号(如 ECONNREFUSED 127.0.0.1:401 -> 应归 network,非 auth)。
  if (/(?:HTTP|状态|status|code)\s*(401|403)\b|unauthorized|forbidden/i.test(msg)) return { category: 'auth', message: raw };
  // startup:spawn 失败 / 子进程退出 / ENOENT / not running(stdio 进程层)
  if (/spawn failed|enoent|exited|not running|child error/.test(msg)) return { category: 'startup', message: raw };
  // network:连接层(ECONNREFUSED/ENOTFOUND/ETIMEDOUT/ECONNRESET/bad url/EPIPE/socket hang up)
  if (/econnrefused|enotfound|etimedout|econnreset|eai_again|bad url|epipe|connect econn|socket hang up/.test(msg)) return { category: 'network', message: raw };
  // cancelled:用户 steer 中断/显式取消(优先于 timeout,防误归超时)
  if (/cancelled|canceled|aborted by user steer/.test(msg)) return { category: 'cancelled', message: raw };
  // timeout:rpc/请求/探针超时
  if (/timed out|timeout/.test(msg)) return { category: 'timeout', message: raw };
  // security:SSRF / sanitize 拒绝 / 非 http(s) url
  if (/ssrf|内网|sanitize|invalid entry|non-http|ftp:/.test(msg)) return { category: 'security', message: raw };
  // tool_registration:tools/list 失败或空目录
  if (/tools\/list|no tools|empty tools/.test(msg)) return { category: 'tool_registration', message: raw };
  // protocol:握手失败 / 非 MCP 响应 / JSON-RPC 错误 / initialize 被拒
  if (/handshake failed|non-mcp|bad json|protocol|initialize|mcp error|parse|json-rpc|无匹配 id/.test(msg)) return { category: 'protocol', message: raw };
  return { category: 'unknown', message: raw };
}

// 对单连接器做一次显式健康探测(用户「为什么不可用」排查 / 清单 ?probe=1)。
// 复用 getMcpClient(活则直给,死则按 config 条目重 spawn;受 MCP_FAILURE_COOLDOWN_MS 冷却约束 ->
// 冷却中返回存储的失败归类)。start 阶段用 probe 超时竞速,避免 stdio 8s rpc 超时拖慢用户重测。
// 绝不抛;返回 {id, status:'ok'|'degraded'|'failed', category?, message?, toolCount?, latencyMs, ...}。
async function probeMcpConnector(entry, opts = {}) {
  const startedAt = Date.now();
  const probedAt = new Date().toISOString();
  const timeoutMs = Math.max(2000, Number(opts && opts.timeoutMs) || 10000);
  if (!entry || (!entry.id && !entry.command && !entry.url)) {
    return { id: null, status: 'failed', category: 'startup', message: 'invalid entry', latencyMs: 0, probedAt };
  }
  reconcileMcpEntryFingerprint(entry);   // 配置改过(同 id)-> 旧客户端 / 旧冷却作废,按新条目重测
  let client = mcpClients.get(entry.id);
  // 已经活着的客户端:下面真发一次 tools/list(hunt2-mcp:修前读握手时缓存的目录,卡死的服务器也报 ok)。
  const wasLive = Boolean(client && !client.dead);
  if (!client || client.dead) {
    try {
      client = await Promise.race([
        getMcpClient(entry),
        new Promise((_, reject) => setTimeout(() => reject(new Error('mcp probe timed out (start)')), timeoutMs)),
      ]);
    } catch (e) {
      const cls = classifyMcpError(e, entry);
      return { id: entry.id, status: 'failed', ...cls, latencyMs: Date.now() - startedAt, probedAt };
    }
  }
  if (!client) {
    // getMcpClient 返回 null:冷却中或 start 失败已存。回放存储的失败归类。
    const fail = mcpClientFailures.get(entry.id);
    const err = fail ? new Error(fail.error) : new Error('mcp client not available');
    const cls = classifyMcpError(err, entry);
    return { id: entry.id, status: 'failed', ...cls, latencyMs: Date.now() - startedAt, probedAt };
  }
  try {
    let probeTimer = null;
    const tools = await Promise.race([
      Promise.resolve(wasLive && typeof client.refreshTools === 'function' ? client.refreshTools(timeoutMs) : client.listTools()),
      new Promise((_, reject) => { probeTimer = setTimeout(() => reject(new Error('mcp tools/list timed out')), timeoutMs); }),
    ]).finally(() => clearTimeout(probeTimer));
    const toolCount = Array.isArray(tools) ? tools.length : 0;
    return {
      id: entry.id,
      status: toolCount > 0 ? 'ok' : 'degraded',
      toolCount,
      latencyMs: Date.now() - startedAt,
      serverInfo: client.serverInfo || null,
      transport: entry.transport || 'stdio',
      probedAt,
    };
  } catch (e) {
    const cls = classifyMcpError(e, entry);
    return { id: entry.id, status: 'failed', ...cls, latencyMs: Date.now() - startedAt, probedAt };
  }
}

// 合并 desktop/config/drop-in 三源为统一读模型。与 resolveExternalMcpServers 的关键差异:本函数
// 【包含 disabled 条目】(UI 需展示已停用的连接器并允许启用),并附 source/transport/commandOrUrl/
// enabled/builtIn/capabilities。probe 时复用 resolveExternalMcpServers 取真实 entry(含完整 env,无漂移)。
// env 值经 maskKey 掩码(防 token 类泄漏);command/url 不掩(配置面非密钥,UI 需识别连接器)。
async function buildMcpConnectorInventory(config, opts = {}) {
  // 39 号文:本函数下面两处(resolveExternalMcpServers 与第 1 段的 autodetect)在冷缓存时会同步探针。
  // 它是 async,所以先等那趟异步预热 —— 缓存热时零开销,冷时也不再把事件循环钉住。
  await ensureDesktopMcpWarm(config);
  const doProbe = !!(opts && opts.probe);
  const probeTimeoutMs = Math.max(2000, Number(opts && opts.probeTimeoutMs) || 10000);
  const resolvedById = new Map();
  if (doProbe) {
    for (const e of resolveExternalMcpServers(config)) resolvedById.set(e.id, e);
  }
  const out = [];
  const addItem = (spec) => {
    const transport = (spec.transport === 'sse' || spec.transport === 'http') ? spec.transport : 'stdio';
    const cap = MCP_COMPAT_MATRIX[transport] || MCP_COMPAT_MATRIX.stdio;
    const maskedEnv = {};
    for (const [k, v] of Object.entries(spec.env || {})) maskedEnv[k] = maskKey(String(v));
    out.push({
      id: spec.id,
      label: spec.label || spec.id,
      source: spec.source,
      builtIn: !!spec.builtIn,
      transport,
      commandOrUrl: transport === 'stdio' ? String(spec.command || '') : safeUrlForDisplay(spec.url),
      enabled: spec.enabled !== false,
      capabilities: cap,
      envKeys: Object.keys(spec.env || {}),
      env: maskedEnv,
      argsCount: Array.isArray(spec.args) ? spec.args.length : 0,
      cwd: spec.cwd || '',
      health: null,
    });
  };
  // 1. desktop MCP(ai-computer-control,工作台签名能力 -- 内置)
  const dm = config && config.desktopMcp;
  if (dm) {
    let command = String(dm.command || '').trim();
    let args = Array.isArray(dm.args) ? dm.args.slice() : [];
    let cwd = String(dm.cwd || '').trim() || undefined;
    let env = {};
    if (command) {
      env = { PYTHONUTF8: '1' };
    } else if (dm.enabled !== false && dm.autodetect) {
      // 55a: 仅在启用时 autodetect(detectDesktopMcp 内部 spawnSync 最多 5s,禁用时不应阻塞 GET 清单)。
      const det = detectDesktopMcp();
      if (det) { command = det.command; args = det.args; cwd = det.cwd; env = det.env || {}; }
    }
    if (command) {
      const browser = (config && config.browserAutomation) || {};
      env = { ...env,
        ACC_BROWSER_MODE: String(browser.mode || 'system'),
        ACC_BROWSER_EXECUTABLE: String(browser.executable || ''),
        ACC_BROWSER_CDP_URL: String(browser.cdpUrl || 'http://127.0.0.1:9222'),
      };
      addItem({ id: 'ai-computer-control', label: '桌面控制 (ai-computer-control)', source: 'desktop', builtIn: true, transport: 'stdio', command, args, cwd, env, enabled: dm.enabled !== false });
    }
  }
  // 2. config.externalMcpServers(用户连接器 -- 含 disabled)
  const ext = (config && Array.isArray(config.externalMcpServers)) ? config.externalMcpServers : [];
  for (const s of ext) {
    if (!s || !s.id) continue;
    const transport = (s.transport === 'sse' || s.transport === 'http') ? s.transport : 'stdio';
    if (transport !== 'stdio' && !s.url) continue;     // 远程条目缺 url 不入清单(与 resolveExternalMcpServers 一致)
    if (transport === 'stdio' && !s.command) continue;
    addItem({ id: s.id, label: s.label, source: 'config', builtIn: false, transport, command: s.command, url: s.url, args: s.args || [], cwd: s.cwd || '', env: s.env || {}, enabled: s.enabled !== false });
  }
  // 3. drop-in(repo/<dataRoot>/mcp/*/ 运行时扫描 -- 内置,不写回 config)
  if (!config || config.enableMcpDropIn !== false) {
    for (const d of scanMcpDropIns()) {
      if (out.some(o => o.id === d.id)) continue;       // config 显式条目优先(与 resolveExternalMcpServers 一致)
      const transport = (d.transport === 'sse' || d.transport === 'http') ? d.transport : 'stdio';
      if (transport !== 'stdio' && !d.url) continue;
      addItem({ id: d.id, label: d.label, source: 'drop-in', builtIn: true, transport, command: d.command, url: d.url, args: d.args || [], cwd: d.cwd || '', env: d.env || {}, enabled: true });
    }
  }
  // 4. ruyi-toolbox 登记的 MCP 组件(~/.ruyi-toolbox/components/,运行时合并、不写回 config;与 resolveExternalMcpServers 一致)
  for (const c of enabledToolboxComponents(config)) {
    if (c.kind !== 'mcp') continue;
    const id = 'toolbox-' + c.id;
    if (out.some(o => o.id === id)) continue;
    addItem({ id, label: c.name, source: 'toolbox', builtIn: true, transport: 'stdio', command: c.run.command, args: c.run.args, cwd: c.run.cwd, env: c.run.env, enabled: true });
  }
  if (doProbe) {
    for (const item of out) {
      if (!item.enabled) { item.health = { id: item.id, status: 'disabled', probedAt: new Date().toISOString() }; continue; }
      const realEntry = resolvedById.get(item.id);
      if (!realEntry) { item.health = { id: item.id, status: 'disabled', probedAt: new Date().toISOString() }; continue; }
      item.health = await probeMcpConnector(realEntry, { timeoutMs: probeTimeoutMs });
    }
  }
  return out;
}

// v1.4.1: 桥接工具带 `<serverId>__` 前缀(如 ai_computer_control__excel_read)。部分 provider 模型(实测 qwen)
// 会【丢掉前缀】直接调裸名 `excel_read` → 命不中 bridgedRoute → 落到内建兜底报「Unknown tool: excel_read」。
// 宽容解析:①精确前缀名优先;②内建工具名绝不被桥接遮蔽(返回 null 走内建路径);③裸名在所有桥接工具里
// 【唯一】命中某 toolName 时路由过去(≥2 个同名歧义则不猜、返回 null)。纯加法:精确前缀路径行为不变。
let _nativeToolNameSet = null;
function isNativeToolName(name) {
  if (!_nativeToolNameSet) { try { _nativeToolNameSet = new Set(MCP_TOOLS.map(t => t && t.name)); } catch { _nativeToolNameSet = new Set(); } }
  return _nativeToolNameSet.has(name);
}
function resolveBridge(bridgedRoute, name) {
  if (!name || !bridgedRoute) return null;
  const valid = value => value && typeof value === 'object' && Object.hasOwn(value, 'serverId') && typeof value.serverId === 'string' && value.serverId.length > 0 && Object.hasOwn(value, 'toolName') && typeof value.toolName === 'string' && value.toolName.length > 0;
  if (Object.hasOwn(bridgedRoute, name) && valid(bridgedRoute[name])) return bridgedRoute[name]; // ① 精确前缀名
  if (isNativeToolName(name)) return null;                 // ② 内建优先,不被桥接遮蔽
  let hit = null, count = 0;                               // ③ 裸名唯一命中桥接工具 → 容错路由
  for (const k of Object.keys(bridgedRoute)) {
    const r = bridgedRoute[k];
    if (valid(r) && r.toolName === name) { hit = r; if (++count > 1) return null; }
  }
  return count === 1 ? hit : null;
}

function stopSession(sessionId, reason = 'stopped') {
  const entry = activeChildren.get(sessionId);
  clearPendingPermissions(sessionId, `turn ${reason}`);
  clearPendingQuestions(sessionId, `turn ${reason}`);
  clearPendingPlans(sessionId, `turn ${reason}`); // v0.9-S5: unblock a paused plan-mode turn on abort/stop (reject semantics)
  if (!entry) return false;
  entry.state = reason;
  // Prefer the live ChildProcess handle; only fall back to taskkill by pid while the child is alive,
  // so we never force-kill a recycled PID.
  if (typeof entry.abort === 'function') {
    // Native (openai) engine: no child process — abort the in-flight fetch instead of taskkill.
    entry.exited = true;
    try { entry.abort(); } catch { /* ignore */ }
  } else if (!entry.exited && entry.child && entry.child.exitCode === null) {
    entry.exited = true;
    entry.cleanup = killChildTree(entry.child);
    if (entry.cleanup && entry.cleanup.incomplete && typeof entry.onEvent === 'function') {
      try { entry.onEvent({ type: 'stderr', text: '[子进程清理尚未确认完成]\n' }); } catch { /* observer closed */ }
    }
  }
  activeChildren.delete(sessionId);
  logEvent({ kind: 'turn_kill', sessionId, reason, ...(entry.cleanup ? { cleanupScope: entry.cleanup.scope, cleanupIncomplete: entry.cleanup.incomplete === true } : {}) });
  return true;
}

// --- F3: defensive, side-effect-free event parser. Maps one raw stream-json event to a list of
// normalized events {kind, ...}. Unknown shapes fall through to {kind:'unknown', raw}. Every stream
// feature (text, thinking, tool cards, usage) plugs into this single seam. ---
function deltaOf(streamEvent) {
  // Tolerate both {event:{delta}} and {event:{event:{delta}}} nestings seen across CLI versions.
  if (!streamEvent || typeof streamEvent !== 'object') return null;
  if (streamEvent.delta) return streamEvent;
  if (streamEvent.event) return deltaOf(streamEvent.event);
  return null;
}

const CLAUDE_TASK_NOTIFICATION_MAX_CHARS = 100000;
function decodeClaudeTaskXmlText(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'").replace(/&amp;/gi, '&');
}
function claudeTaskNotificationTag(text, tag, maxChars = CLAUDE_TASK_NOTIFICATION_MAX_CHARS) {
  const match = String(text || '').match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i'));
  if (!match) return '';
  return decodeClaudeTaskXmlText(match[1]).slice(0, Math.max(0, maxChars));
}
// Claude Code emits background-Agent completion as a string-valued user message rather than a
// tool_result block. Keep this parser deliberately narrow: only the documented task-notification
// envelope is accepted, tags are bounded, and the raw XML is never surfaced as an assistant reply.
function parseClaudeTaskNotification(content) {
  const text = typeof content === 'string' ? content : '';
  if (!/<task-notification(?:\s|>)/i.test(text)) return null;
  const status = claudeTaskNotificationTag(text, 'status', 80).trim().toLowerCase();
  const result = claudeTaskNotificationTag(text, 'result');
  const summary = claudeTaskNotificationTag(text, 'summary', 4000);
  const failed = /^(?:failed|error|cancelled|canceled|stopped|interrupted)$/.test(status);
  return {
    kind: 'subagent_notification',
    taskId: claudeTaskNotificationTag(text, 'task-id', 256).trim(),
    toolUseId: claudeTaskNotificationTag(text, 'tool-use-id', 256).trim(),
    outputFile: claudeTaskNotificationTag(text, 'output-file', 4096).trim(),
    status: status || (failed ? 'failed' : 'completed'),
    summary,
    note: claudeTaskNotificationTag(text, 'note', 4000),
    result: (result || summary).slice(0, CLAUDE_TASK_NOTIFICATION_MAX_CHARS),
    resultChars: (result || summary).length,
    resultTruncated: (result || summary).length > CLAUDE_TASK_NOTIFICATION_MAX_CHARS,
    failed,
  };
}
function parseClaudeEvent(evt) {
  const out = [];
  if (!evt || typeof evt !== 'object') return [{ kind: 'unknown', raw: evt }];
  const sid = evt.session_id || evt.sessionId;

  if (evt.type === 'system') {
    if (sid) out.push({ kind: 'init', sessionId: sid, subtype: evt.subtype });
    return out.length ? out : [{ kind: 'unknown', raw: evt }];
  }

  if (evt.type === 'stream_event' || evt.type === 'content_block_delta' || evt.event) {
    // Per-API-CALL usage (message_start carries the input breakdown; message_delta the output).
    // This is NOT the cumulative turn total, so it reflects true context-window occupancy.
    const inner = evt.event || evt;
    const mu = (inner && inner.message && inner.message.usage) || (inner && inner.usage);
    if (mu && typeof mu === 'object' && ('input_tokens' in mu || 'output_tokens' in mu || 'cache_read_input_tokens' in mu || 'cache_creation_input_tokens' in mu)) {
      out.push({ kind: 'msg_usage', usage: mu });
    }
    const holder = deltaOf(evt.event || evt);
    const delta = holder && holder.delta;
    if (delta) {
      const dt = delta.type || '';
      if (dt === 'text_delta' && typeof delta.text === 'string') {
        out.push({ kind: 'text', text: delta.text, partial: true, index: holder.index });
      } else if (/thinking|reasoning/i.test(dt) || typeof delta.thinking === 'string' || typeof delta.reasoning === 'string') {
        // Tolerate old (thinking_delta) + new adaptive/reasoning shapes and varying text fields.
        const t = [delta.thinking, delta.reasoning, delta.text].find(v => typeof v === 'string') || '';
        if (t) out.push({ kind: 'thinking', text: t, partial: true, index: holder.index });
      }
      // signature_delta and other unknown deltas are intentionally ignored
    }
    if (out.length) return out;
    // fall through to structural handling below if it wasn't a recognized delta
  }

  if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
    if (evt.message.usage) out.push({ kind: 'msg_usage', usage: evt.message.usage }); // complete per-call usage
    for (const block of evt.message.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        out.push({ kind: 'text', text: block.text, partial: false });
      } else if (block.type === 'redacted_thinking') {
        out.push({ kind: 'thinking', text: '[redacted thinking]', partial: false, redacted: true });
      } else if (/thinking|reasoning/i.test(block.type || '') || typeof block.thinking === 'string' || typeof block.reasoning === 'string') {
        // Robust across thinking(enabled)/thinking(adaptive)/reasoning block variants + text field names.
        const t = [block.thinking, block.reasoning, block.text, (typeof block.content === 'string' ? block.content : null)].find(v => typeof v === 'string') || '';
        out.push({ kind: 'thinking', text: t, partial: false });
      } else if (block.type === 'tool_use') {
        out.push({ kind: 'tool_use', id: block.id, name: block.name, input: block.input });
      }
    }
    return out.length ? out : [{ kind: 'unknown', raw: evt }];
  }

  if (evt.type === 'user' && evt.message) {
    if (typeof evt.message.content === 'string') {
      const notification = parseClaudeTaskNotification(evt.message.content);
      if (notification) return [notification];
    } else if (Array.isArray(evt.message.content)) {
      for (const block of evt.message.content) {
        if (block && block.type === 'tool_result') {
          out.push({ kind: 'tool_result', id: block.tool_use_id, content: block.content, isError: Boolean(block.is_error) });
        }
      }
    }
    return out.length ? out : [{ kind: 'unknown', raw: evt }];
  }

  if (evt.type === 'result') {
    return [{
      kind: 'result',
      sessionId: sid,
      ok: evt.subtype === 'success' || (!evt.is_error && evt.subtype !== 'error'),
      subtype: evt.subtype,
      result: typeof evt.result === 'string' ? evt.result : undefined,
      usage: evt.usage,
      costUsd: evt.total_cost_usd ?? evt.cost_usd,
      durationMs: evt.duration_ms,
      numTurns: evt.num_turns,
    }];
  }

  return [{ kind: 'unknown', raw: evt }];
}

// v2.8: normalize Kimi Code's OpenAI-shaped stream-json rows into the internal event vocabulary.
// 架构还债批 3 A:这是 Kimi 那一份 CLI 适配器(05 AGENT_CLI_ADAPTERS.kimi.parseEvent)的解析器本体。
function parseKimiStreamJsonEvent(evt) {
  if (!evt || typeof evt !== 'object') return [{ kind: 'unknown', raw: evt }];
  if (evt.role === 'meta') {
    if (evt.type === 'session.resume_hint' && (evt.session_id || evt.sessionId)) {
      return [{ kind: 'init', sessionId: evt.session_id || evt.sessionId, subtype: evt.type }];
    }
    if (evt.type === 'turn.step.retrying') {
      return [{ kind: 'diagnostic', text: `Kimi 正在重试(${evt.next_attempt || '?'} / ${evt.max_attempts || '?'})：${evt.error_message || evt.error_name || ''}` }];
    }
    return [];
  }
  if (evt.role === 'assistant') {
    const out = [];
    if (typeof evt.content === 'string' && evt.content) out.push({ kind: 'text', text: evt.content, partial: false });
    for (const call of (Array.isArray(evt.tool_calls) ? evt.tool_calls : [])) {
      const fn = call && call.function || {};
      let input = fn.arguments;
      if (typeof input === 'string') input = safeJsonParse(input, input);
      out.push({ kind: 'tool_use', id: call.id, name: fn.name || '', input });
    }
    return out;
  }
  if (evt.role === 'tool') return [{ kind: 'tool_result', id: evt.tool_call_id, content: evt.content, isError: false }];
  return [{ kind: 'unknown', raw: evt }];
}
// 按驱动名分派的兼容出口(e2e 直测它):主回合不再经过这里,而是直接问 05 的 CLI 适配器(adapter.parseEvent)。
function parseAgentCliEvent(evt, driver = 'claude') {
  if (driver === 'claude') return parseClaudeEvent(evt);
  if (driver === 'kimi') return parseKimiStreamJsonEvent(evt);
  return [{ kind: 'unknown', raw: evt }];
}

// Claude CLI's native Agent/Task tool returns the child agent's final answer as the parent
// tool_result.  Unlike workbench-managed sub-turns, the CLI does not expose that child's
// intermediate events, so this result is the only inspectable evidence of what it did.  Keep a
// bounded, display-safe copy for the UI instead of reducing it to a character count.
const NATIVE_CLAUDE_AGENT_RESULT_MAX_CHARS = 100000;
function nativeClaudeAgentResultInfo(content, isError) {
  const textOf = value => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
    if (typeof value === 'object') {
      // Anthropic accepts both a plain string and content-block arrays for tool_result.
      if (typeof value.text === 'string') return value.text;
      if (typeof value.content === 'string') return value.content;
      if (Array.isArray(value.content)) return textOf(value.content);
      try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    }
    return String(value);
  };
  const fullText = textOf(content);
  let structured = null;
  if (content && !Array.isArray(content) && typeof content === 'object') structured = content;
  if (!structured && typeof content === 'string' && /^\s*\{[\s\S]*\}\s*$/.test(content)) {
    try { structured = JSON.parse(content); } catch { /* ordinary text result */ }
  }
  const notification = parseClaudeTaskNotification(fullText);
  const structuredStatus = String(structured && structured.status || notification && notification.status || '').trim().toLowerCase();
  const agentId = String(
    structured && (structured.agentId || structured.agent_id || structured.taskId || structured.task_id)
      || notification && notification.taskId
      || (fullText.match(/(?:^|\n)\s*(?:agentId|agent_id|taskId|task_id)\s*:\s*([^\s\r\n]+)/i) || [])[1]
      || ''
  ).trim().slice(0, 256);
  const outputFile = String(
    structured && (structured.outputFile || structured.output_file)
      || notification && notification.outputFile
      || (fullText.match(/(?:^|\n)\s*(?:output_file|outputFile)\s*:\s*([^\r\n]+)/i) || [])[1]
      || ''
  ).trim().slice(0, 4096);
  const background = structuredStatus === 'async_launched'
    || /^(?:running|pending|in_progress|started)$/.test(structuredStatus)
    || /\b(?:async|background)\s+(?:agent|task)\b[\s\S]{0,200}\b(?:launched|started|running)\b/i.test(fullText)
    || /\b(?:agent|task)\b[\s\S]{0,200}\bworking in the background\b/i.test(fullText)
    || /(?:^|\n)\s*output_file\s*:/i.test(fullText)
    || /\b(?:task|agent)\s+(?:is\s+)?still\s+running\b/i.test(fullText);
  const notificationResult = notification && notification.result;
  const structuredResult = structured && typeof structured === 'object'
    ? (typeof structured.result === 'string' ? structured.result
      : (Array.isArray(structured.content) ? textOf(structured.content) : ''))
    : '';
  const displayText = notificationResult || structuredResult || fullText;
  const result = displayText.length > NATIVE_CLAUDE_AGENT_RESULT_MAX_CHARS
    ? displayText.slice(0, NATIVE_CLAUDE_AGENT_RESULT_MAX_CHARS)
    : displayText;
  // Some Anthropic-compatible endpoints send a failed Task result as ordinary text rather than
  // setting tool_result.is_error.  Classify only unmistakable, leading transport/task failures so
  // a normal review that merely *mentions* an API error is not marked failed.
  const looksLikeFailure = /^(?:api\s+error\b|error\s*:|(?:request|network|connection)\s+(?:failed|closed|error)\b|(?:agent|task)\s+(?:failed|error)\b)/i.test(fullText.trim())
    || /^(?:failed|error|cancelled|canceled|stopped|interrupted)$/.test(structuredStatus)
    || Boolean(notification && notification.failed);
  return {
    result,
    resultChars: displayText.length,
    resultTruncated: displayText.length > result.length,
    failed: Boolean(isError) || looksLikeFailure,
    background,
    agentId,
    outputFile,
    status: structuredStatus || (background ? 'running' : (looksLikeFailure ? 'failed' : 'completed')),
  };
}

// A Claude CLI print process exits after every workbench turn. Normally --resume reconnects the
// next process to the native transcript, but continuity is not guaranteed across CLI upgrades,
// workbench restarts, provider/model changes, or a missing/moved Claude session file. Keep a
// bounded display-history copy on every normal Claude turn.
const CLAUDE_RECOVERY_HISTORY_CHARS = 24000;
const CLAUDE_RECOVERY_MESSAGE_CHARS = 6000;

// Claude Code stores native transcripts under ~/.claude/projects/<mangled-cwd>/, and `--resume`
// only searches the bucket selected by the child process cwd. A model/endpoint switch can also make
// a vendor-backed transcript unusable even when the local file still exists. Persist a secret-free
// binding alongside claudeSessionId so the next turn can reject a known-incompatible resume BEFORE
// spawning the CLI, then rely on the bounded workbench history copy below for continuity.
function claudeResumeRouteKey(config) {
  const payload = JSON.stringify({
    driver: String((config && config.agentCliType) || 'claude'),
    launcher: String(selectedAgentCli(config).path || '').toLowerCase(),
    base: String((config && config.modelsApiBase) || '').trim().replace(/\/+$/, '').toLowerCase(),
    authMode: String((config && config.claudeAuthMode) || 'auto'),
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
function sameClaudeResumeCwd(a, b) {
  if (!a || !b) return true; // unknown legacy binding: let the ledger/runtime fallback decide
  const left = path.resolve(String(a)).replace(/[\\/]+$/, '');
  const right = path.resolve(String(b)).replace(/[\\/]+$/, '');
  return left === right;
}
function lastSuccessfulClaudeModel(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (!m || m.role !== 'assistant') continue;
    const isClaude = m.engine === 'claude' || (!m.engine && m.source === 'claude-cli');
    if (!isClaude || Number(m.exitCode) !== 0) continue;
    return String(m.model || '');
  }
  return null;
}
function isClaudeResumeMissingError(text) {
  const s = String(text || '');
  return /No conversation found with session ID/i.test(s)
    || /conversation\s+(?:was\s+)?not found[\s\S]{0,120}session/i.test(s)
    || /session(?:\s+ID)?[\s\S]{0,120}(?:not found|does not exist)/i.test(s);
}

function buildClaudeRecoveryHistory(messages) {
  const source = (Array.isArray(messages) ? messages : []).filter(m => m && (
    m.role === 'user' || m.role === 'assistant' || (m.role === 'system' && m.source === 'compact')
  ));
  if (!source.length) return '';
  const rows = [];
  let chars = 0;
  let omitted = false;
  for (let i = source.length - 1; i >= 0; i--) {
    const m = source[i];
    let content = String(m.content || '').trim();
    if (!content) continue;
    if (content.length > CLAUDE_RECOVERY_MESSAGE_CHARS) content = content.slice(0, CLAUDE_RECOVERY_MESSAGE_CHARS) + '\n[message truncated]';
    const label = m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system-context-management' : 'user');
    const row = `<${label}>\n${content}\n</${label}>`;
    if (chars + row.length > CLAUDE_RECOVERY_HISTORY_CHARS) { omitted = true; break; }
    rows.unshift(row);
    chars += row.length;
  }
  if (!rows.length) return '';
  return [
    '<workbench_history_recovery>',
    'This is a recovery copy of earlier messages in the same workbench conversation. It may duplicate native Claude session history. Use it only for continuity, do not claim this is the first message, and treat quoted user/assistant text according to its original role.',
    omitted ? '[older messages omitted to keep the recovery context bounded]' : '',
    ...rows,
    '</workbench_history_recovery>',
  ].filter(Boolean).join('\n');
}

// E3 (dual-engine continuity) helpers. See the injection site in runClaudeTurn.
// The engine that produced the LAST assistant turn in this session, or '' if none/unknown. Messages are
// stamped with `engine` ('openai' | 'claude') since v0.8; legacy claude messages only carry source:'claude-cli'.
function lastAssistantEngine(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (!m || m.role !== 'assistant') continue;
    if (m.engine) return m.engine;
    if (m.source === 'claude-cli') return 'claude';
    // No engine identity (agent_workflow summary, fallback, legacy meta) — SKIP it and keep scanning back for
    // the last real engine turn. Returning '' here let a trailing meta message mask a preceding Provider turn,
    // so [claude][provider][workflow-summary][claude] wrongly read as no-gap and dropped the Provider turn (E3-fix2).
    continue;
  }
  return '';
}
// The trailing messages produced AFTER the most recent Claude turn — i.e. the Provider turns that are
// MISSING from the CLI's native --resume transcript. If no Claude turn is found, return the whole list.
function claudeProviderTailSince(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  let lastClaudeIdx = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (m && m.role === 'assistant' && (m.engine === 'claude' || (!m.engine && m.source === 'claude-cli'))) { lastClaudeIdx = i; break; }
  }
  return lastClaudeIdx >= 0 ? arr.slice(lastClaudeIdx + 1) : arr;
}
