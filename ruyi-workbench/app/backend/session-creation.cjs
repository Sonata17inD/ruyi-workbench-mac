'use strict';
const fsp = require('node:fs/promises');
const { managedWorkspacePath } = require('./config-defaults.cjs');

function createSessionService({
  SESSION_SCHEMA, makeId, clearDeletedSession, readConfig, nowIso, newSessionEngineRoute,
  isUntitledSessionTitle, normalizeSession, saveSession, RUYI_EVENTS,
}) {
  const IMPORTED_MESSAGE_ROLE_MAX = 32;
  // 安全走查 S10:导入来的消息是外来文本(可能是别人分享的会话文件、含伪造的「用户已授权…」对话),每条打来源标记
  // meta.imported:true,让这条线程里的内容始终能被认出是导入的。meta【整个替换】而不是合并:文件自带的 meta
  // (比如伪造 origin:'agent_wake' / 'inbox' 去走界面里那几条特殊渲染)一律丢掉。
  function sanitizeImportedSessionMessages(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(m => m && typeof m === 'object' && !Array.isArray(m)
      && typeof m.role === 'string' && m.role.trim() && m.role.length <= IMPORTED_MESSAGE_ROLE_MAX
      && (m.content == null || typeof m.content === 'string' || Array.isArray(m.content)))
      .map(m => ({ ...m, meta: { imported: true } }));
  }

  async function createSession({ title, cwd, origin, engineRoute }) {
    const id = makeId('sess');
    clearDeletedSession(id);   // hunt2-P2:新建的会话绝不继承同名旧会话的删除墓碑
    const config = await readConfig();
    // 导入会话(POST /api/sessions 的 messages,来自用户选的 JSON 文件)同样不可信:修前 [null] 让建会话 500
    // (而且半截落了盘),数字/字符串元素原样进正文。只收【普通对象 + 非空字符串 role + content 缺省或为字符串/数组】
    // 的条目,其余丢掉 —— 这就是展示消息的形状(assistant 的 content 可以是 '',正文在 segments 里)。
    const initialMessages = sanitizeImportedSessionMessages(arguments[0]?.messages);
    // title / cwd 来自 POST /api/sessions 与 /api/chat/stream 的请求体,类型不可信:修前 {"cwd":5} 原样落盘,
    // 这条会话此后每一回合都死在 path.resolve(5);对象/数组标题会原样回给列表(前端 .trim() 的雷)。
    // 非字符串或空白一律当没传;标题上限与 applySessionMetaPatch 改名同为 200。
    const safeTitle = typeof title === 'string' && title.trim() ? title.slice(0, 200) : undefined;
    const safeCwd = typeof cwd === 'string' && cwd.trim() ? cwd : undefined;
    const managed = managedWorkspacePath(config.stewardWorkspaceRoot);
    const workspace = safeCwd || config.defaultWorkspace || managed;
    if (workspace === managed) await fsp.mkdir(workspace, { recursive: true });
    const session = {
      id,
      schemaVersion: SESSION_SCHEMA,
      turnSeq: 0,
      title: safeTitle || 'New session',
      summary: '',
      pinned: false,
      cwd: workspace,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      claudeSessionId: null,
      messages: initialMessages,
      providerHistory: [],
      providerHistoryCursor: 0,
      privacyHistoryV1: false, // Fresh disabled sessions bypass legacy-reference migration entirely.
      attachments: [],
      // 123-N2:四层优先级搬进 newSessionEngineRoute(见那里的头注)。修前这一行是
      // `inferSessionEngineRoute({messages}) || sessionEngineRouteFromConfig(config)` —— 即今天的
      // ②||④,新增的是最前面的 ①(显式入参)与中间的 ③(上一次用的)。
      engineRoute: newSessionEngineRoute(config, engineRoute, initialMessages, id),
      mission: null, // 第26波b: 任务账本(见 normalizeMission)
      missionId: id, // 75a (D1 plan B): stable Mission identity, written for new sessions (== sessionId in 3.0)
      kind: 'quick_ask', // 第70波(EC-E):显式 Quick Ask 标识;mission start 时翻转 'mission'(见 13-http-router /api/mission)
      // 第 121 波 K3(34 号文 §4.1「来源三值」):这条线程是谁开的。**只在这里写一次,此后终身不变**,
      // 且【不在】 applySessionMetaPatch 的白名单里(理由与 createdBy 同一条,见那里的注释锚)。
      // 三值 'steward' | 'user' | 'schedule':管家族两条建线程的路径(13k thread_new / quick_ask)显式传
      // 'steward';119 波的定时任务落地后由它自己传 'schedule';其余一律 'user'。非法值当没传。
      // 存量会话头没有这个字段:读侧由 06i 的 threadOriginOf 现场派生,**不回写**(索引是纯派生物,
      // 为了补一个字段去改几百个会话文件不值得,而且那会把 sourceStamp 全体打脏)。
      origin: (origin === 'steward' || origin === 'schedule') ? origin : 'user',
      // 116-5a(§11.8.3):建会话时就带了一个【不是占位符】的标题 = 这条线程已经有名字了,不必再花一次
      // 模型调用去起名。判据复用既有的 isUntitledSessionTitle(中英占位集,双引擎自动命名共用同一个),
      // 所以经典壳送来的「新会话」/「New chat」仍然算没名字。与「用户手改标题」写的是同一个字段:
      // 显示优先级只有一条 —— 人给的名字 > 生成的名字 > 原话。
      ...(isUntitledSessionTitle(safeTitle) ? {} : { titleSource: 'user' }),
    };
    // 落盘前就补齐 normalizeSession 的默认字段(todos / skills / memories / memoriesExplicit / memoryExclusions ……)。
    // 修前新会话头缺这几个键,第一次 loadSession 判 changed → load_normalize 回写 —— 光是「点开看一眼」就把
    // updatedAt 推到现在,这条会话跳到列表最上面(rail-session-search 浏览器件在 Windows CI 上偶发红的根因)。
    normalizeSession(session);
    await saveSession(session);
    // 121-K2a(§6.1 第 4 条):新线程。missionId 在 3.0 里建会话时 == sessionId(见上面那一行),
    // 真正归到别的任务是后来 missionAttachThread 的事(它自己派 thread.adopted)。
    RUYI_EVENTS.emit('thread.created', { sessionId: id, missionId: String(session.missionId || ''), title: String(session.title || '') });
    return session;
  }

  return createSession;
}

module.exports = { createSessionService };
