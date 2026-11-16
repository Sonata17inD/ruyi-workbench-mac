'use strict';
const { URL } = require('node:url');
const { send, json, apiFailure, readJsonBody } = require('./http-protocol.cjs');

function createSchedulerRoutes({ scheduler, describeSchedule, normalizeSchedulerTask, SCHEDULER_LIMITS, readConfig, safeDecodeURIComponent, makeId }) {
  const { SCHEDULER_RUNS_LIMIT_DEFAULT, SCHEDULER_RUNS_LIMIT_MAX, schedulerClockNow, schedulerRuntime, schedulerEnabled, schedulerLoad, startScheduler, schedulerSaveTasks, schedulerEnsureTimer, schedulerEmitChanged, schedulerRunNow, schedulerReadFireRows } = scheduler;
// ── API(§3.3)───────────────────────────────────────────────────────────────
// 鉴权沿用 01b-route-auth.js 的表(六条一律 token;body-token 永远够不着写面 —— 29 号文 §10);
// 表是权威,handler 不另写一道自查(同 /api/steward/*)。
function schedulerPublicTask(schedTask, schedLocale) {
  const described = describeSchedule(schedTask.schedule, schedLocale);
  return {
    id: schedTask.id,
    title: schedTask.title,
    // K7 前端(rail-pocket / steward-drawer「接下来」/ steward-settings)读的就是 nextRunAt 与 enabled。
    // name 是它那份前向兼容读法的第二个候选键,一并给上,省得前端两处各写一个回落。
    name: schedTask.title,
    nextRunAt: schedTask.state.nextFireAt,
    enabled: schedTask.state.enabled,
    createdAt: schedTask.createdAt,
    updatedAt: schedTask.updatedAt,
    createdBy: schedTask.createdBy,
    revision: schedTask.revision,
    schedule: schedTask.schedule,
    payload: schedTask.payload,
    target: schedTask.target,
    autonomy: schedTask.autonomy,
    policy: schedTask.policy,
    state: schedTask.state,
    describeKey: described.key,
    describeParams: described.params,
  };
}
// fires 的多行(registered/dispatched/running/reconciled)是【同一次运行】的四段;对外按 runId 合成
// 一行「一次运行」。同 occurrence 的多次尝试是多个 runId,各占一行(executionGeneration 区分)。
function schedulerMergeRuns(schedRows, schedTaskId) {
  const byRun = new Map();
  for (const row of schedRows) {
    if (String(row.taskId || '') !== String(schedTaskId)) continue;
    const key = String(row.runId || '') || ('nore:' + String(row.seq));
    const entry = byRun.get(key) || { runId: String(row.runId || ''), firedAt: String(row.at || ''), phase: '', outcome: '' };
    entry.seq = Number(row.seq) || entry.seq || 0;
    entry.occurrenceKey = String(row.occurrenceKey || entry.occurrenceKey || '');
    entry.dueAt = String(row.dueAt || entry.dueAt || '');
    entry.mode = String(row.mode || entry.mode || '');
    entry.executionGeneration = Number(row.executionGeneration) || entry.executionGeneration || 0;
    entry.phase = String(row.phase || entry.phase || '');
    if (row.sessionId) entry.sessionId = String(row.sessionId);
    if (row.outcome) entry.outcome = String(row.outcome);
    if (row.error) entry.error = String(row.error);
    if (row.durationMs != null) entry.durationMs = Number(row.durationMs) || 0;
    if (row.costTokens != null) entry.costTokens = Number(row.costTokens) || 0;
    if (row.tripped) entry.tripped = true;
    byRun.set(key, entry);
  }
  return [...byRun.values()].sort((a, b) => (b.seq || 0) - (a.seq || 0));
}
function schedulerLocaleOf(req) {
  const raw = String((req && req.headers && req.headers['accept-language']) || '');
  return /^en/i.test(raw) ? 'en' : 'zh';
}

// 六条路由共用的前置:读配置 → 开关关就 409(路由清册不因开关变化,与 /api/steward/* 的
// steward.disabled 同款)→ 装载任务表。返回 locale;返回 '' 表示已经答过了(调用方直接 return)。
// **故意不在函数开头写 `if (!pathname.startsWith('/api/scheduler/')) return;` 这样的前缀早退守卫**:
// 路由清册的扫描器会把它认成一个判定点,于是清册里凭空多出一条「无鉴权首配」的裸前缀死路由
// (13r 的头注里记着同一条坑)。改成六个分支各调一次本函数,顺带也不让无关请求付一次 readConfig。
async function schedulerRouteGate(req, res) {
  const config = await readConfig();
  if (!schedulerEnabled(config)) {
    send(res, apiFailure('scheduler.disabled', {}, 'the scheduler is turned off (schedulerEnabledV1)', 409));
    return '';
  }
  await schedulerLoad();
  if (!schedulerRuntime.loaded) {
    send(res, apiFailure('scheduler.unavailable', {}, 'the scheduler task table exists but could not be read; nothing was changed', 503));
    return '';
  }
  // hunt2-P6:启动那一刻读失败而没起来的调度器,在这里装载成功后补起(startScheduler 自己幂等)。
  // 启动时关着、之后开着(配置被手改、没经 writeConfig 那一声)的同样在这里补起。
  if ((schedulerRuntime.startDeferred || schedulerRuntime.awaitingEnable) && !schedulerRuntime.started) await startScheduler(config);
  return schedulerLocaleOf(req);
}

async function handleSchedulerApiRoutes(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/scheduler/tasks') {
    const locale = await schedulerRouteGate(req, res); if (!locale) return;
    return send(res, json({
      ok: true,
      nowMs: schedulerClockNow(),
      tasks: schedulerRuntime.tasks.map(task => schedulerPublicTask(task, locale)),
    }));
  }

  if (req.method === 'POST' && pathname === '/api/scheduler/tasks') {
    const locale = await schedulerRouteGate(req, res); if (!locale) return;
    let body = {};
    try { body = await readJsonBody(req); } catch { return send(res, apiFailure('api.body_invalid', {}, 'invalid JSON body', 400)); }
    if (schedulerRuntime.tasks.length >= SCHEDULER_LIMITS.maxTasks) {
      return send(res, apiFailure('scheduler.capacity_exceeded', { max: SCHEDULER_LIMITS.maxTasks },
        'at most ' + SCHEDULER_LIMITS.maxTasks + ' scheduler tasks', 409));
    }
    // workdir 是服务端自有字段(127 波 2-ter S-b,见 06j ⑦ 段):新建时一律剥掉,调用方写不进来。
    const normalized = normalizeSchedulerTask({ ...body, id: '', revision: 0, workdir: '' }, schedulerClockNow());
    if (!normalized.ok) return send(res, apiFailure('scheduler.' + normalized.code, {}, normalized.message, 400));
    normalized.task.id = makeId('sch');
    schedulerRuntime.tasks.push(normalized.task);
    await schedulerSaveTasks();
    schedulerEnsureTimer();
    schedulerEmitChanged(normalized.task.id, 'created', '');
    return send(res, json({ ok: true, task: schedulerPublicTask(normalized.task, locale) }));
  }

  if ((req.method === 'PATCH' || (req.method === 'POST' && req.headers['x-http-method'] === 'PATCH'))
      && pathname.match(/^\/api\/scheduler\/tasks\/([^/]+)$/)) {
    const locale = await schedulerRouteGate(req, res); if (!locale) return;
    const id = safeDecodeURIComponent(pathname.slice('/api/scheduler/tasks/'.length));
    if (id === null) return send(res, apiFailure('scheduler.not_found', {}, 'no such scheduler task', 404));   // 坏编码(%zz):不是任何任务的 id,不再 URIError 500
    const index = schedulerRuntime.tasks.findIndex(task => task.id === id);
    if (index < 0) return send(res, apiFailure('scheduler.not_found', { id }, 'no such scheduler task', 404));
    let body = {};
    try { body = await readJsonBody(req); } catch { return send(res, apiFailure('api.body_invalid', {}, 'invalid JSON body', 400)); }
    // 读 body 期间表可能变过(并发 DELETE):按 id 重新找,不拿旧下标。
    const current = schedulerRuntime.tasks.find(task => task.id === id);
    if (!current) return send(res, apiFailure('scheduler.not_found', { id }, 'no such scheduler task', 404));
    // 部分更新:只认这五个顶层键,其余一律不动(id/createdAt/createdBy/revision 由服务端管)。
    // 127 波 2-ter:改档位就走这里 —— target 是整份替换(target.tier 随之生效或消失),不另开工具。
    // workdir 同属服务端自有(S-b):body 里带了也不认,永远取 current 那一份(显式写出来,不靠 ...current 的顺序)。
    const merged = {
      ...current,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
      ...(body.payload !== undefined ? { payload: body.payload } : {}),
      ...(body.target !== undefined ? { target: body.target } : {}),
      ...(body.autonomy !== undefined ? { autonomy: body.autonomy } : {}),
      ...(body.policy !== undefined ? { policy: body.policy } : {}),
      state: { ...current.state, ...(body.enabled !== undefined ? { enabled: body.enabled !== false } : {}) },
      id: current.id,
      createdAt: current.createdAt,
      createdBy: current.createdBy,
      revision: current.revision,
      workdir: String(current.workdir || ''),
    };
    const normalized = normalizeSchedulerTask(merged, schedulerClockNow());
    if (!normalized.ok) return send(res, apiFailure('scheduler.' + normalized.code, {}, normalized.message, 400));
    normalized.task.revision = (Number(current.revision) || 0) + 1;
    // 计划没变时保住盘上的 nextFireAt(改个标题不该把下一次往后推);变了才用新算的那个。
    // 例外:从暂停(含熔断停用)里被重新打开 —— 暂停期间 tick 不碰这条任务,盘上的 nextFireAt 还停在暂停那一刻的
    // 旧时点上;保住它的话,恢复后第一拍就把暂停期间的时点当「错过」补跑一次(或记一条没人错过的 skipped)。
    // 此时用 normalizeSchedulerTask 刚按「此刻」算好的那个(与 13t schedulerToolSetEnabled 同口径)。
    const resumedFromPause = normalized.task.state.enabled && !current.state.enabled;
    if (!resumedFromPause && JSON.stringify(normalized.task.schedule) === JSON.stringify(current.schedule)) {
      normalized.task.state.nextFireAt = current.state.nextFireAt;
    }
    normalized.task.state.inFlightRunId = current.state.inFlightRunId;
    // 从熔断里被重新打开:连败计数清零,否则下一次失败立刻再熔断。
    if (normalized.task.state.enabled && !current.state.enabled) normalized.task.state.consecutiveFailures = 0;
    // hunt2-P1:【原地】换内容,不换对象。在飞的 schedulerFireOnce 攥着的就是 current 这个对象 —— 修前这里
    // 换成新对象,在飞那一次收尾时把 inFlightRunId 清在已经不在表里的旧对象上,表里的新对象永远带着一个
    // 不会被清的 inFlightRunId(run-now 永远 409、tick 永远跳过,落盘后重启还会被当成崩溃残留)。
    // 在飞那一次此后读 task.state 拿到的是这里的新 state(已带着 inFlightRunId),收尾照常清掉它。
    for (const key of Object.keys(current)) if (!Object.prototype.hasOwnProperty.call(normalized.task, key)) delete current[key];
    Object.assign(current, normalized.task);
    await schedulerSaveTasks();
    schedulerEnsureTimer();
    schedulerEmitChanged(id, 'updated', '');
    return send(res, json({ ok: true, task: schedulerPublicTask(current, locale) }));
  }

  if ((req.method === 'DELETE' || (req.method === 'POST' && req.headers['x-http-method'] === 'DELETE'))
      && pathname.match(/^\/api\/scheduler\/tasks\/([^/]+)$/)) {
    const locale = await schedulerRouteGate(req, res); if (!locale) return;
    const id = safeDecodeURIComponent(pathname.slice('/api/scheduler/tasks/'.length));
    if (id === null) return send(res, apiFailure('scheduler.not_found', {}, 'no such scheduler task', 404));   // 坏编码(%zz):不是任何任务的 id,不再 URIError 500
    const index = schedulerRuntime.tasks.findIndex(task => task.id === id);
    if (index < 0) return send(res, apiFailure('scheduler.not_found', { id }, 'no such scheduler task', 404));
    schedulerRuntime.tasks.splice(index, 1);
    // **删定义不删历史回执**(37 号文 §1):fires-v1.ndjson 一个字节都不动 —— 它是 append-only 的账,
    // 「这条任务当初真的跑过」是既成事实,不因为定义没了就该消失。
    await schedulerSaveTasks();
    schedulerEnsureTimer();
    schedulerEmitChanged(id, 'deleted', '');
    return send(res, json({ ok: true, id }));
  }

  if (req.method === 'POST' && pathname.match(/^\/api\/scheduler\/tasks\/([^/]+)\/run-now$/)) {
    const locale = await schedulerRouteGate(req, res); if (!locale) return;
    const id = safeDecodeURIComponent(pathname.slice('/api/scheduler/tasks/'.length, pathname.length - '/run-now'.length));
    if (id === null) return send(res, apiFailure('scheduler.not_found', {}, 'no such scheduler task', 404));   // 坏编码(%zz):不是任何任务的 id,不再 URIError 500
    const task = schedulerRuntime.tasks.find(row => row.id === id);
    if (!task) return send(res, apiFailure('scheduler.not_found', { id }, 'no such scheduler task', 404));
    // hunt2-P10:修前这里整段拿着 ticking(tick 重入闸),手动那一次的回合跑多久,其它任务就多久派不出单
    // (tick 一进来就 return)。现在只挡【这一条任务】—— 闸与新 occurrence 的取法都在 schedulerRunNow(与管家工具共用)。
    const ran = await schedulerRunNow(task);
    if (ran.busy) return send(res, apiFailure('scheduler.busy', { id }, 'this task is already running', 409));
    return send(res, json({ ok: true, outcome: ran.outcome, task: schedulerPublicTask(task, locale) }));
  }

  if (req.method === 'GET' && pathname.match(/^\/api\/scheduler\/tasks\/([^/]+)\/runs$/)) {
    if (!(await schedulerRouteGate(req, res))) return;
    const id = safeDecodeURIComponent(pathname.slice('/api/scheduler/tasks/'.length, pathname.length - '/runs'.length));
    if (id === null) return send(res, apiFailure('scheduler.not_found', {}, 'no such scheduler task', 404));   // 坏编码(%zz):不是任何任务的 id,不再 URIError 500
    const query = new URL(req.url, 'http://127.0.0.1').searchParams;
    // **先取原值再转数字**:`Number(query.get('limit'))` 在没带这个参数时是 Number(null) === 0,
    // 而 0 会被 Number.isFinite 认成「用户真给了一个数」,再钳进 [1,50] 就变成 limit=1 ——
    // 于是设置面「最近 5 次」永远只显示 1 条。同一个模具在 01c-runtime-flags 的 memoryLimit 头注里
    // 已经被记过一次(Number(null)=0 被静默解读成「上限为 0」);本件 F6/G3 又当场抓到一次。
    const rawLimit = query.get('limit');
    const wanted = rawLimit == null || rawLimit === '' ? NaN : Number(rawLimit);
    const limit = Number.isFinite(wanted) ? Math.min(SCHEDULER_RUNS_LIMIT_MAX, Math.max(1, Math.round(wanted))) : SCHEDULER_RUNS_LIMIT_DEFAULT;
    const rows = await schedulerReadFireRows();
    // 删掉定义之后这条仍然读得出来(回执不随定义走)—— 所以这里【不】先查 tasks 表。
    return send(res, json({ ok: true, taskId: id, runs: schedulerMergeRuns(rows, id).slice(0, limit) }));
  }
}
  return { schedulerPublicTask, schedulerMergeRuns, schedulerLocaleOf, schedulerRouteGate, handleSchedulerApiRoutes };
}

module.exports = { createSchedulerRoutes };
