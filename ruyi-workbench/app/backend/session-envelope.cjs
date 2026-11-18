'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

function createSessionEnvelope({
  paths, safeSessionId, sessionPath, sessionBodyPaths, pretenderEtag, pretenderHash, StewardHooks,
  execution: { activeChildren, activeAgentRuns, turnSettlers, sessionExecutionSnapshot, sessionExecutionObservation },
  overrides: { sessionPermissionModeOverrides, sessionDesktopToolsOverrides },
}) {
  // GET /api/sessions/:id 条件 GET 的【盘上戳】。不装载会话就能取:头文件整份读出来哈希(头只有几 KB~几十 KB;
  // 不能只信 updatedAt/mtime —— 同一毫秒/同一个文件系统时钟刻度内两次落头会撞)+ 两个正文的 size/mtime/ino(追加改 size,
  // 慢路径整份重写是 rename 换 inode)+ 后台任务账本的 size/mtime/ino(loadSession 会把它合并进 messages)。
  // 头是提交点(saveSession 正文先落、头后落,且每次都推 updatedAt),所以「头哈希 + 正文戳」不变 = 盘上没有新提交。
  // 任何一步读不到(legacy 单文件会话没有正文文件、瞬时锁、会话不存在)一律返回 null → 调用方不发 ETag、走原来的无条件全量,
  // 与修前逐字节一致。
  async function sessionEnvelopeStamp(id) {
    if (safeSessionId(id) === null) return null;
    try {
      const bp = sessionBodyPaths(id);
      const [head, msg, prov, jobs] = await Promise.all([
        fsp.readFile(sessionPath(id)),
        fsp.stat(bp.messages),
        fsp.stat(bp.provider),
        // 与后台任务账本的存储路径一致。账本变化须使条件响应失效。
        fsp.stat(path.join(paths.sessions, 'background-jobs', id + '.json')).catch(() => null),
      ]);
      const fileStamp = st => `${st.size}:${st.mtimeMs}:${st.ino}`;
      return crypto.createHash('sha1').update(head).digest('hex') + '|' + fileStamp(msg) + '|' + fileStamp(prov) + '|' + (jobs ? fileStamp(jobs) : '-');
    } catch { return null; }
  }
  // 标签 = 盘上戳 + 装载会改变响应的全部【内存】输入:活态四件(见 sessionEnvelopeLiveParts)、会话级权限档/桌面工具覆盖表
  // (loadSession 会把它们盖到返回的会话对象上)、垂死回合收尾窗口(turnSettlers:窗口内 loadSession 不做残留 pending 叙事段的
  // 惰性清理,出窗后同一份盘面装载出的会话就不同了)、以及 ?since 参数(管家会话的尾巴切片,响应体不同)。
  // deltaKey:增量取的两个查询参数(见路由体 fromIndex/prefixStamp)—— 它们改变响应体(尾巴 vs 全量),所以进标签;
  // 不带这两个参数时哈希输入与修前逐项相同(不追加这一项),无参 GET 的标签逐字节不变。
  function sessionEnvelopeEtag(id, stamp, liveParts, sinceRaw, deltaKey) {
    const overrides = [
      sessionPermissionModeOverrides.has(id) ? [sessionPermissionModeOverrides.get(id)] : null,
      sessionDesktopToolsOverrides.has(id) ? [sessionDesktopToolsOverrides.get(id)] : null,
    ];
    const parts = [stamp, overrides, turnSettlers.has(id), liveParts, sinceRaw == null ? null : String(sinceRaw)];
    if (deltaKey) parts.push(['delta', deltaKey]);
    return pretenderEtag('session', pretenderHash(parts));
  }
  // 会话信封上【只来自内存】的那几样(活回合标志 / liveTail / liveTurn / 递话通道):GET /api/sessions/:id 的 200 体与
  // 条件 GET 的 ETag 共用这一份取样 —— 判据只写一处,响应里放了什么,ETag 就带什么(sessionEnvelopeEtag 直接哈希它)。
  // 纯同步只读:不碰盘、不改 reg。取样逻辑与注释原样搬自路由体(只是从内联挪成函数,一个字没动)。
  function sessionEnvelopeLiveParts(id) {
    // A child can exit before its final assistant message is persisted. Keep pollers live until
    // the driver releases its existing owner, or a user-only snapshot can stop polling forever.
    let live = activeChildren.has(id) || turnSettlers.has(id);
    if (!live) {
      for (const runtime of activeAgentRuns.values()) {
        if (runtime && runtime.run && runtime.run.sessionId === id) { live = true; break; }
      }
    }
    // 117l D4(§11.9;用户第四轮走查第 3 条):活回合的尾巴。只在【真有一个活回合】时出现
    // (回合一结束这个键就不在了 —— 抽屉据此把「它正在说」换回「它刚说」),不落盘、不进任何投影。
    // 放在【信封】上而不往 session 里塞:与下面 displayTitle 同一条纪律(路由不改写会话头本身)。
    // 117m-A5(用户第六轮走查①「点开线程的看全文,还是啥也看不到」):同一个信封上再多带四个键 ——
    // full(本回合从头累加的正文,04 里硬顶 12000 字、超顶砍头)、truncated、tools(最近 ≤20 条工具名
    // 与起止,**不含参数与结果**)、startedAt/iterations。经典壳据此在会话末尾画一张临时气泡,
    // 让「在别处起的回合」也看得到它现在在说什么。仍然是【条件展开】:回合一结束这个键就不在了。
    // 白名单式逐字段搬运,不 spread reg 上那份对象 —— 累加器上还有 batchMark/lastKind 这类内部游标,
    // tools 里还有工具调用 id,都不该出现在信封上。
    const liveReg = activeChildren.get(id);
    const liveTail = liveReg && liveReg.liveTail && typeof liveReg.liveTail === 'object'
      ? {
        text: String(liveReg.liveTail.text || ''), tool: String(liveReg.liveTail.tool || ''), updatedAt: String(liveReg.liveTail.updatedAt || ''),
        full: String(liveReg.liveTail.full || ''),
        truncated: Boolean(liveReg.liveTail.truncated),
        startedAt: String(liveReg.liveTail.startedAt || ''),
        iterations: Math.max(0, Number(liveReg.liveTail.iterations) || 0),
        tools: (Array.isArray(liveReg.liveTail.tools) ? liveReg.liveTail.tools : []).slice(-20).map(row => ({
          name: String((row && row.name) || '').slice(0, 80),
          status: String((row && row.status) || ''),
          startedAt: String((row && row.startedAt) || ''),
          endedAt: String((row && row.endedAt) || ''),
        })),
      }
      : null;
    // 117o-A7(用户第七轮走查,两张截图对照:「为啥这个查看全文,不能像 2.0 那样显示呢」):
    // 同一个信封上【再加一个新键】liveTurn —— 在途回合的有序叙事账本(02c 的 createTurnSegmentBuilder,
    // 回合落盘之后经典壳重建叙事靠的就是它)。A5 的 liveTail 只是一段拼好的纯文本,渲染层再怎么写
    // 也画不出思考块 / 过程记录 / 工具卡,差距的根子是数据形状。前端拿到它以后组装成一条与落盘助手
    // 消息同形的对象,交给【渲染落盘助手消息的同一个入口】去画,不写第二套简版渲染器。
    // 三条纪律:① 上面 liveTail 那几个键一个字不动(抽屉的「它正在说」在读它,117l/117m 的断言看着它),
    // 新键是【加】不是改;② 有界与截断方向都在 02c 的 liveSnapshot() 里(段数/单段/总文本三重硬顶,
    // 超顶从头部丢弃并置 truncated:true);③ **工具结果一律不下发** —— 只送 name 与那一行参数摘要,
    // 结果可能是整份文件、可能含密钥;回合一结束真消息落盘,经典壳照常拿到全部(e2e 的 E 段钉着这条)。
    const liveNarrative = liveReg && liveReg.liveSegments && typeof liveReg.liveSegments.liveSnapshot === 'function'
      ? liveReg.liveSegments.liveSnapshot()
      : null;
    const liveTurn = liveNarrative
      ? {
        segments: Array.isArray(liveNarrative.segments) ? liveNarrative.segments : [],
        toolCalls: Array.isArray(liveNarrative.toolCalls) ? liveNarrative.toolCalls : [],
        truncated: Boolean(liveNarrative.truncated),
        startedAt: liveTail ? liveTail.startedAt : '',
        iterations: liveTail ? liveTail.iterations : 0,
      }
      : null;
    // 117s-G(27 号文 §11.13.1 ②;真浏览器复现的丢回合 bug):这条线程此刻【该走哪条递话通道】。
    // 判据不是新造的 —— 就是 13h 那条递话阶梯 stewardRelayChannelFor,顺序 answer > permission >
    // queued > steer > turn,
    // 全仓递话唯一那处判定,经 06i 的延迟绑定命名空间取(13d 直接引用 13h 会造一条前向边)。
    // 为什么信封上要有它:经典壳的发送门只认 activeTurns —— 本页自己起的那条流。管家在服务端起的
    // 回合不在里面,于是用户在「2.0 视窗」里打一句话走的是「新回合」那条路,09:1347 的
    // `activeChildren.has -> stopSession('superseded')` 把跑着的回合就地杀掉,界面零提示。
    // 只投影 {channel, wait} 两个键:questionId/pendingId 是待决面的内部锚点,不该进会话信封。
    // 空闲(channel === 'turn')时整个键都不下发 —— 存量消费者拿到的信封逐字节不变。
    const relayDecision = typeof StewardHooks.relayChannel === 'function' ? StewardHooks.relayChannel(id) : null;
    const relay = relayDecision && relayDecision.channel && relayDecision.channel !== 'turn'
      ? { channel: String(relayDecision.channel), ...(relayDecision.wait ? { wait: relayDecision.wait } : {}) }
      : null;
    return { live, liveTail, liveTurn, relay, execution: sessionExecutionSnapshot(id), executionObservation: sessionExecutionObservation(id) };
  }

  return { sessionEnvelopeStamp, sessionEnvelopeEtag, sessionEnvelopeLiveParts };
}

module.exports = { createSessionEnvelope };
