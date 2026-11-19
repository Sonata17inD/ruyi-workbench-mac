'use strict';

function createStewardRunnerLifecycle({ sessions, routing, runtime }) {
  const {
    SESSION_SCHEMA, STEWARD_SESSION_ID, STEWARD_SESSION_TITLE, STEWARD_PERMISSION_MODE, loadSession,
    saveSession, stopSession,
  } = sessions;
  const {
    AGENT_CLI_TYPES, normalizeAgentCliType, normalizeSessionEngineRoute, sessionEngineRouteFromConfig,
  } = routing;
  const { paths, nowIso, logEvent } = runtime;

  // ────────────────────────────────────────────────────────────────────────────
  // 运行时状态。全部【只在内存】—— 管家的持久化面只有 13g 登记的四个 + 本切片的 visits 归档,
  // 到访状态本身不落盘(进程重启 = 新到访,与 §11.1 第 7 项「一次到访 = 页面重开或静默 60 分钟」一致)。
  // ────────────────────────────────────────────────────────────────────────────
  const stewardRunnerRuntime = {
    conversationGeneration: 0,
    // 123-M2:fireSeq 是【承诺三项】的第二个水位。为什么不能复用 inboxSeq:fires-v1.ndjson 有它
    // 自己的一条单调 seq(13s 的账本),与收件箱那条各走各的 —— 拿收件箱的行号去筛 fires 的行
    // 会漏掉/重复算「上次到访以来跳过或结果未知的那几次」。
    visit: { startedAt: '', lastActivityAt: '', inboxSeq: 0, fireSeq: 0, previousStartedAt: '' },
    turns: [],            // 已跑回合的时间戳(ms),滑动窗口用
    noProgress: 0,        // 连续零进展的收件箱回合数
    inflight: null,       // { kind:'user'|'inbox', promise, controller, cancelled, events }
    queue: [],            // 待处理的收件箱事件(抢占时回排在这里)
    viewHeld: [],         // 2026-10:用户正看着的待决,先不起回合(见 STEWARD_VIEW_RECHECK_MS)
    viewHeldTimer: null,
    debounceTimer: null,
    debounceMs: -1,       // 116-4:当前那个定时器排的是多久(用来判「该不该重排成更快的」)
    lastReply: null,      // 最近一次 steward_reply 的精简副本(供 /api/steward/state)
    circuit: null,        // 最近一次触发的熔断 { kind, at, detail }
    stopped: false,       // 一键停机:停轮询的同时停回合队列
    // 116-2b:自理动作的每目标账。targetKey = sessionId|runId。只在内存(进程重启 = 重新开始数;
    // 与 §11.1 第 7 项「重启即新到访」同一立场:重启后第一次仍值得试一次,连着失败才该停手)。
    selfServe: new Map(),  // targetKey -> { attempts, lastRetryAt, lastActionAt }
    // 「没做完就续一轮」的每线程账:sessionId -> { count, doneAt, turnSeq, at }。count = 连续自动续跑次数;
    // doneAt = 上次续跑那一刻计划已完成的步数(下一次到访拿它判「计划有没有往前走」);turnSeq = 续跑前的回合号。
    // 只在内存,与上面 selfServe 同一立场(重启即重新数)。线程恢复正常收工时删除该条。
    continueUnfinished: new Map(),
  };

  function stewardStopRunner() {
    stewardRunnerRuntime.stopped = true;
    if (stewardRunnerRuntime.debounceTimer) { clearTimeout(stewardRunnerRuntime.debounceTimer); stewardRunnerRuntime.debounceTimer = null; }
    stewardRunnerRuntime.queue = [];
    const inflight = stewardRunnerRuntime.inflight;
    if (inflight) {
      inflight.cancelled = 'stopped';
      stewardAbortInflight(inflight);
    }
    return { ok: true, stopped: true };
  }
  function stewardResumeRunner() {
    stewardRunnerRuntime.stopped = false;
    return { ok: true, stopped: false };
  }

  // 停一个在途管家回合:先 stopSession(既有停止原语 —— 它拿到 activeChildren 里的 abort 句柄直接掐
  // 在途 fetch,不依赖 killOnDisconnect 配置),再 abort 我们自己的 signal(双保险;runSessionTurn 的
  // 断线语义走的是这条)。线程自己的回合不受影响 —— 这里停的只有管家会话。
  function stewardAbortInflight(inflight) {
    try { stopSession(STEWARD_SESSION_ID, 'steward-preempt'); } catch { /* 没有在途子进程即无操作 */ }
    try { if (inflight && inflight.controller) inflight.controller.abort(); } catch { /* 无 AbortController 环境 */ }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 管家会话(单例)。
  // ────────────────────────────────────────────────────────────────────────────

  // 引擎解析:stewardProviderId/stewardModel 为空则跟随主端点(§11.1 第 5 项)。
  // 返回 { ok:true, route } 或 { ok:false, error:'steward.unsupported_engine', engine }。
  function stewardResolveRoute(config) {
    const cfg = (config && typeof config === 'object') ? config : {};
    const explicitId = String(cfg.stewardProviderId || '').trim();
    if (explicitId) {
      const provider = (cfg.providers || []).find(p => p && p.id === explicitId);
      if (!provider) {
        return { ok: false, error: 'steward.unsupported_engine', engine: explicitId, message: `管家要用的模型服务「${explicitId}」已经不在了,请到设置 › 管家里重新挑一个` };
      }
      const route = normalizeSessionEngineRoute({ engine: 'openai', providerId: explicitId, model: String(cfg.stewardModel || '').trim() || provider.model || '' });
      return route ? { ok: true, route } : { ok: false, error: 'steward.unsupported_engine', engine: explicitId, message: `管家要用的模型服务「${explicitId}」不是 OpenAI 兼容的,请到设置 › 管家里换一个` };
    }
    // 跟随主端点。CLI 引擎(Claude / Kimi)在本切片不支持:管家回合的事件流与工具协议要另接一套,
    // 属 116-2。fail-closed 返回稳定信封,而不是悄悄换成别的端点跑起来。
    const route = sessionEngineRouteFromConfig(cfg);
    if (!route || route.engine !== 'openai') {
      const engine = route ? (route.agentCliType || 'claude') : 'none';
      return { ok: false, error: 'steward.unsupported_engine', engine, message: (engine === 'none' || !(cfg.providers || []).some(p => p && (!p.type || String(p.type).startsWith('openai')))) ? '还没接上能用的模型,管家暂时回不了话。先在向导或设置里接一个模型(本机或云端都行)' : `管家要用一个 OpenAI 兼容的模型服务才能回话,现在的主模型走的是命令行引擎(${AGENT_CLI_TYPES[normalizeAgentCliType(engine)].label})。请到设置 › 管家里给它单独挑一个` };   // 走查 #1:不出配置键名
    }
    const model = String(cfg.stewardModel || '').trim();
    return { ok: true, route: model ? { ...route, model } : route };
  }

  // 懒创建管家会话。不用 createSession(它生成 sess_* 随机 id;管家要的是固定 id,见 06i 的注释),
  // 但字段形状与 createSession 逐条对齐,以便所有既有会话原语(load/save/rewind/压缩)照常可用。
  async function ensureStewardSession(config) {
    const resolved = stewardResolveRoute(config);
    if (!resolved.ok) return resolved;
    const existing = await loadSession(STEWARD_SESSION_ID).catch(() => null);
    if (existing && existing.id === STEWARD_SESSION_ID) {
      // 引擎/模型可能在设置里被改过 —— 每次唤醒对齐一次(会话头是路由的权威源,configForSessionEngineRoute
      // 读它)。kind 一旦被外部改坏就纠回来:身份判据全靠它。
      let dirty = false;
      if (existing.kind !== 'steward') { existing.kind = 'steward'; dirty = true; }
      if (JSON.stringify(existing.engineRoute || null) !== JSON.stringify(resolved.route)) { existing.engineRoute = resolved.route; dirty = true; }
      if (dirty) await saveSession(existing).catch(() => {});
      return { ok: true, session: existing, route: resolved.route };
    }
    const now = nowIso();
    const session = {
      id: STEWARD_SESSION_ID,
      schemaVersion: SESSION_SCHEMA,
      turnSeq: 0,
      title: STEWARD_SESSION_TITLE,
      summary: '',
      pinned: false,
      // cwd = 数据根:管家没有工作目录的概念(它不动文件),但回合机器要一个存在的目录做 workingDir。
      cwd: paths.data,
      createdAt: now,
      updatedAt: now,
      claudeSessionId: null,
      messages: [],
      providerHistory: [],
      providerHistoryCursor: 0,
      attachments: [],
      engineRoute: resolved.route,
      mission: null,
      missionId: STEWARD_SESSION_ID,
      kind: 'steward',                 // 身份:所有排除面按【这个原始值】判定
      permissionMode: STEWARD_PERMISSION_MODE, // 独立模式,不进 PERMISSION_MODES
    };
    await saveSession(session);
    logEvent({ kind: 'steward_session_created', sessionId: STEWARD_SESSION_ID, providerId: resolved.route.providerId, model: resolved.route.model });
    return { ok: true, session, route: resolved.route };
  }

  return {
    stewardRunnerRuntime, stewardStopRunner, stewardResumeRunner, stewardAbortInflight, stewardResolveRoute,
    ensureStewardSession,
  };
}

module.exports = { createStewardRunnerLifecycle };
