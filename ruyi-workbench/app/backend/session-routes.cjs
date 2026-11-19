'use strict';

const os = require('node:os');
const { apiFailure, apiSessionIdInvalid, apiSessionNotFound, json, readJsonBody, send } = require('./http-protocol.cjs');
const { PERMISSION_MODES, PERMISSION_MODES_REQUIRING_CONFIRM, resolvePermissionMode } = require('./agent-role-policy.cjs');
const { sessionSearchIndexEnabled } = require('./runtime-policy.cjs');
const { pathWithinRoot } = require('./path-containment.cjs');

function createSessionRoutes({
  tokenOk, safeSessionId, safeDecodeURIComponent, readConfig, logEvent, PrivacyGateway, STEWARD_SESSION_ID,
  resolveContainmentPath, pretenderNotModified, searchSessionsByContent,
  execution: { sessionExecutionSnapshot, sessionExecutionObservation, EventStreamHooks, sessionBackgroundRunRows, agentRunActionCommand },
  envelope: { sessionEnvelopeStamp, sessionEnvelopeEtag, sessionEnvelopeLiveParts },
  sessions: {
    listSessions, createSession, readSessionHeadResilient, loadSession, updateSessionMeta, sessionMeta,
    SESSION_LOAD_OMIT_PROVIDER, sessionOmittedProviderHistory, sessionMessagesDelta, sessionProviderHistoryLength,
    detectDanglingTurn, sessionDisplayTitle, sessionDesktopToolsOf, bulkDeleteUnpinnedSessions, deleteSession,
  },
}) {
  // 安全走查 S10:导入会话 JSON(POST /api/sessions 带 messages)时,文件里写的 cwd 不能原样当工作区 —— 一份被分享来的会话文件
  // 写个 cwd:'/' 就把本会话的文件工具写根放大到整盘。前端 importSession 已不再上送文件里的 cwd;这里是服务端的第二道:
  // 导入形态(body.messages 非空)若显式带了 cwd,必须落在【已配置的工作区】(默认工作区 + workspaces[] 各条)之一内部或就是它,
  // 否则 400(不回显路径)。比对走真实路径(符号链接 / junction 逃不出去)。普通「新建会话」(不带 messages)不受影响:
  // 它的 cwd 来自用户在界面里选的文件夹(最近用过的、拖进来的),并不要求事先登记成工作区。
  async function importedSessionCwdAllowed(cwd, config) {
    const raw = typeof cwd === 'string' ? cwd.trim() : '';
    if (!raw) return true;
    const target = await resolveContainmentPath(raw);
    if (!target || target.unresolvable) return false;
    const rootsRaw = [config && config.defaultWorkspace ? config.defaultWorkspace : os.homedir()];
    for (const w of (config && Array.isArray(config.workspaces) ? config.workspaces : [])) {
      if (w && typeof w === 'object' && typeof w.path === 'string' && w.path.trim()) rootsRaw.push(w.path.trim());
    }
    for (const rootRaw of rootsRaw) {
      if (typeof rootRaw !== 'string' || !rootRaw.trim()) continue;
      const root = await resolveContainmentPath(rootRaw);
      if (root && !root.unresolvable && pathWithinRoot(target.path, root.path)) return true;
    }
    return false;
  }

  async function handleSessionApiRoutes(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/sessions') {
      return send(res, json({ ok: true, sessions: await listSessions() }));
    }
    // 113b: 会话内容搜索。GET /api/sessions/search?q=&limit=
    // 必须排在下面那条 pathname.startsWith('/api/sessions/') 的通配分支【之前】，
    // 否则 'search' 会被当成会话 id 拿去查。
    if (req.method === 'GET' && pathname === '/api/sessions/search') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const config = await readConfig();
      if (!sessionSearchIndexEnabled(config)) {
        // 走 apiFailure 而不是裸字符串 error：后者会被 normalizeApiErrorPayload 归结成
        // api.request_failed，真正的 code 降级成 message，调用方就分不出“关了”和“坏了”。
        // 118 波在 help.doc_missing 上栓过同一个坑。状态码给 200：它不是错误，只是能力关着。
        return send(res, apiFailure('session_search.disabled', {}, 'session search index is disabled', 200));
      }
      const params = new URL(req.url, 'http://x').searchParams;
      return send(res, json(await searchSessionsByContent(params.get('q') || '', params.get('limit'))));
    }
    if (req.method === 'POST' && pathname === '/api/sessions') {
      const body = await readJsonBody(req);
      if (body && Array.isArray(body.messages) && body.messages.length && typeof body.cwd === 'string' && body.cwd.trim()
        && !(await importedSessionCwdAllowed(body.cwd, await readConfig()))) {
        return send(res, apiFailure('session.import_cwd_not_allowed', {}, 'imported session cwd must be a configured workspace (or a subfolder of one)', 400));
      }
      // 121-K3(§4.1「来源三值」):这条路由就是【用户自己按下「新会话」】那一下,来源恒为 'user'。
      // 显式钉死而不是把 body 整份透传:createSession 现在认 origin 参数,透传等于让任意调用方
      // 把自己的普通会话刷成「管家开的」—— 那正是 02 把 origin 挡在 PATCH 白名单外要防的同一件事,
      // 只挡 PATCH 不挡建会话是把门修在窗户旁边。管家族那两条路径自己传 'steward'(13k)。
      return send(res, json({ ok: true, session: await createSession({ ...(body && typeof body === 'object' ? body : {}), origin: 'user' }) }));
    }
    // Bulk history cleanup is intentionally narrower than the single-session DELETE endpoint: it only
    // clears unpinned sessions and can preserve the currently open session supplied by the UI.
    if (req.method === 'POST' && pathname === '/api/sessions/bulk-delete') {
      const body = await readJsonBody(req);
      return send(res, json(await bulkDeleteUnpinnedSessions({
        preserveSessionId: body && body.preserveSessionId,
        purgeAssociated: Boolean(body && body.purgeAssociated),
      })));
    }
    // 135c(用户 2026-09-23「会话内的后台任务进度」;拍板:只在对应线程里显示、跑完即消失、能停但先确认、
    // 别的线程只在左栏打一个小标记)。四条路由,都排在下面 '/api/sessions/' 通配分支之前(否则
    // 'background' 会被当成会话 id)。修前后台命令【没有任何 HTTP 读口】—— 只有模型自己的 shell_* 工具看得见。
    //   GET  /api/sessions/background-counts      各线程在跑的后台件数(左栏标记用;只有计数,不带内容)
    //   GET  /api/sessions/:id/background         这条线程在跑的后台任务:后台命令 + 后台子代理 + 班组
    //   GET  /api/sessions/:id/background/output  某条后台命令的最近输出(过 redact)
    //   POST /api/sessions/:id/background/stop    停一件:命令走 shellKill(认主),子代理/班组走既有 stop 动作
    if (req.method === 'GET' && pathname === '/api/sessions/background-counts') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const shells = EventStreamHooks.backgroundShells;
      const counts = shells ? shells.counts() : {};
      for (const row of sessionBackgroundRunRows(null)) counts[row.sessionId] = (counts[row.sessionId] || 0) + 1;
      return send(res, json({ ok: true, counts }));
    }
    {
      const bg = /^\/api\/sessions\/([^/]+)\/background(\/output|\/stop)?$/.exec(pathname);
      if (bg) {
        if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
        const sid = safeSessionId(safeDecodeURIComponent(bg[1]));   // 坏编码(%zz)→ null → 400,不再 URIError 500
        if (!sid) return send(res, apiSessionIdInvalid());
        if (req.method === 'GET' && !bg[2]) {
          const shells = EventStreamHooks.backgroundShells;
          const items = (shells ? shells.rows(sid) : []).concat(sessionBackgroundRunRows(sid));
          items.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
          return send(res, json({ ok: true, sessionId: sid, items }));
        }
        if (req.method === 'GET' && bg[2] === '/output') {
          const shellId = new URL(req.url, 'http://x').searchParams.get('shellId') || '';
          const shells = EventStreamHooks.backgroundShells;
          const out = shells ? shells.outputTail(sid, shellId, 8000) : null;
          if (!out) return send(res, json({ ok: false, error: 'background command not found' }, 404));
          return send(res, json({ ok: true, ...out }));
        }
        if (req.method === 'POST' && bg[2] === '/stop') {
          const body = await readJsonBody(req);
          const taskId = String((body && body.id) || '');
          if (taskId.startsWith('shell:')) {
            const shells = EventStreamHooks.backgroundShells;
            const result = shells ? await shells.stop(sid, taskId.slice(6)) : { ok: false };
            logEvent({ kind: 'background_task_stop', sessionId: sid, taskId, ok: result.ok === true, by: 'user' });
            return send(res, json(result.ok ? { ...result, state: 'stopped' } : { ...result, ok: false, error: result.error || 'background command not found' }, result.ok ? 200 : result.cleanupIncomplete ? 409 : 404));
          }
          if (taskId.startsWith('run:')) {
            const result = await agentRunActionCommand({ sessionId: sid, runId: taskId.slice(4), action: 'stop' });
            logEvent({ kind: 'background_task_stop', sessionId: sid, taskId, ok: result.status === 200, by: 'user' });
            return send(res, json(result.body, result.status));
          }
          return send(res, json({ ok: false, error: 'unknown background task id' }, 400));
        }
        return send(res, json({ ok: false, error: 'method not allowed' }, 405));
      }
    }
    // 单条会话的 GET / PATCH / DELETE 只认 /api/sessions/<一段>。修前是 startsWith + path.basename(pathname):
    // /api/sessions/随便/什么/<id> 与 /api/sessions/<id>/ 都被当成 <id> —— 同一条会话有无数个别名(DELETE 也吃),
    // 以后再加 /api/sessions/:id/xxx 子路由时稍不留神就被这里先吞掉。其余形状落到路由末尾的 api.route_not_found。
    const single = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (single) {
      // 与后台任务那几条同一个解码口径:坏编码(%zz)→ '' → 下面各分支按不合形的 id 处理(404 / 400)。
      const id = safeDecodeURIComponent(single[1]) || '';
      if (req.method === 'GET') {
        if (!safeSessionId(id)) return send(res, apiSessionNotFound());   // 不合形/保留名(01 safeSessionId)不可能是一条会话
        // Mapping expiry/import/revocation may change a user-facing copy without a
        // canonical session write. Such sessions must not reuse canonical HTTP/delta
        // cache proofs. Fresh OFF sessions retain the original fast paths.
        const displayPrivate = Boolean(await PrivacyGateway.displayCacheKey(id));
        const displayReply = async (envelope, headers = {}) => send(res, json(await PrivacyGateway.displayEnvelope(id, envelope), 200, headers));
        // 条件 GET(perf):这条路由每 3 s(直播回合)/ 5–30 s(管家抽屉)被轮询一次,而 loadSession 要读整份头 + 两个
        // 正文并逐行 sha1(18 MB 会话 250–350 ms;逐行 sha1 后来去掉了,见 02 sessionBodyState)。ETag 在【装载之前】用「头文件内容哈希 + 两个正文的大小 + 后台任务账本 +
        // 内存覆盖表 + 内存活态」算出,与 If-None-Match 相等就直接 304,连会话都不装载。取样顺序有讲究:盘上的戳在装载【之前】取,
        // 装载期间若有写者落盘,下一次比对必然不等 → 只会多回一次 200,绝不会拿旧标签配新内容(只可能多刷新,不会漏刷新)。
        // 内存活态在 200 体里现算(与体里放的东西同一份取样);304 判定用装载前的取样:活态没变才相等。
        // providerHistory 仍在 200 体里:大量 e2e 与外部脚本从这条路由读它(前端虽不读,也不删 —— 断言只加不改)。
        const sinceRaw = id === STEWARD_SESSION_ID ? new URL(req.url, 'http://x').searchParams.get('since') : null;
        // perf(前端长会话):?fromIndex=N&prefixStamp=S —— 经典壳在自己起的回合收尾时只要 messages[N..]。S 是 02 sessionMessagesStamp
        // 给出的前缀戳(回合起点那条 session 事件上带着);服务端对【此刻要下发的】前 N 条重算一遍,相等才回尾巴,否则(历史被改写过、
        // N 超长、参数是垃圾)回与不带参数时逐字节相同的全量体。与 since 互斥(since 优先,管家会话的尾巴切片语义不动)。
        const deltaQuery = sinceRaw == null ? new URL(req.url, 'http://x').searchParams : null;
        const deltaFromRaw = deltaQuery ? deltaQuery.get('fromIndex') : null;
        const deltaStampRaw = deltaQuery ? deltaQuery.get('prefixStamp') : null;
        const deltaKey = !displayPrivate && (deltaFromRaw != null || deltaStampRaw != null) ? [deltaFromRaw, deltaStampRaw] : null;
        // perf(前端长会话):?view=live —— 经典壳看「别处起的回合」时每条 thread.live 推送(约 1 次/秒)来一发,只读信封上的在跑部分
        // (liveTail / liveTurn / relay / resumable.live)。修前每发都整份装载并下发全部历史(2000 条消息约 7.7 MB)。
        // 真有活回合时只读会话头、回轻量信封(view:'live',session 只带几个标量,不是完整会话);没有活回合就落回下面的全量路径
        // —— 回合刚收尾的那一拍前端正要把整份会话换上来,拿到的就是它。不带 view 的调用逐字节不变。
        if (sinceRaw == null && new URL(req.url, 'http://x').searchParams.get('view') === 'live') {
          const liveParts = sessionEnvelopeLiveParts(id);
          const head = liveParts.live ? await readSessionHeadResilient(id) : null;
          if (head && typeof head === 'object') {
            const { liveTail, liveTurn, relay, execution, executionObservation } = liveParts;
            const turnSeq = Math.max(0, Number(head.turnSeq) || 0);
            const count = (n, list) => (Number.isInteger(n) ? n : (Array.isArray(list) ? list.length : 0));
            const historyLength = count(head.providerHistoryCount, head.providerHistory);
            return displayReply({
              ok: true, view: 'live', execution, executionObservation,
              session: { id, updatedAt: String(head.updatedAt || ''), turnSeq, messageCount: count(head.messageCount, head.messages), providerHistoryCount: historyLength },
              resumable: { dangling: false, kind: null, turnSeq, historyLength, live: true },
              ...(liveTail ? { liveTail } : {}), ...(liveTurn ? { liveTurn } : {}), ...(relay ? { relay } : {}),
            }, { 'cache-control': 'no-store' });
          }
        }
        // 审查轮:活态在盘上戳【之前】取。反过来(先戳后活态)时,两次取样之间「落盘 + 活态翻转」可能拼出一个等于客户端手上旧标签的
        // 组合(旧盘 + 新活态),回一次不该回的 304;先取活态,竞态最多多回一次 200。
        const preLive = sessionEnvelopeLiveParts(id);
        const envelopeStamp = await sessionEnvelopeStamp(id);
        if (envelopeStamp && !displayPrivate) {
          const preEtag = sessionEnvelopeEtag(id, envelopeStamp, preLive, sinceRaw, deltaKey);
          if (pretenderNotModified(req, preEtag)) return send(res, { status: 304, headers: { etag: preEtag, 'cache-control': 'no-store' }, body: '' });
        }
        const notFound = () => send(res, id === STEWARD_SESSION_ID ? json({ ok: true, execution: sessionExecutionSnapshot(id), executionObservation: sessionExecutionObservation(id), session: { id: STEWARD_SESSION_ID, messages: [] }, resumable: null, displayTitle: '', created: false }) : apiSessionNotFound()); // 管家会话懒创建:首个管家回合落盘前回空历史(created:false),不再每次加载页面都在控制台留一条 404;别的会话照旧 404
        // perf(增量取):带 fromIndex/prefixStamp 的请求先用「不读 provider 正文」的装载视图(02 SESSION_LOAD_OMIT_PROVIDER:
        // 前提拿不准它自己就是一次完整装载)。前缀戳对不上 = 要回全量,全量体里有 providerHistory,于是换一份完整装载再往下走。
        let session = await loadSession(id, 0, 0, deltaKey ? SESSION_LOAD_OMIT_PROVIDER : null);
        if (!session) return notFound();
        let delta = null;
        if (deltaKey) {
          const omitted = sessionOmittedProviderHistory(session);
          delta = sessionMessagesDelta(session.messages, deltaFromRaw, deltaStampRaw, omitted ? omitted.body : null);
          if (!delta && omitted) {
            session = await loadSession(id);
            if (!session) return notFound();
          }
        }
        // v0.8-S0 A6: surface whether the last turn dangles (arrested mid-flight) so the UI can offer resume.
        // 运行中豁免:活回合/活 agent run 在跑时,providerHistory 尾部恰好就是 detectDanglingTurn
        // 判悬挂的形状(user 尾/tool 尾/未答 tool_calls)——切到还在正常跑的会话不能弹「未正常结束」
        // 横幅,故 live 会话直接返回不悬挂。
        const liveParts = sessionEnvelopeLiveParts(id);
        const { live, liveTail, liveTurn, relay, execution, executionObservation } = liveParts;
        // 200 体的标签:盘上戳是装载前取的(见上),内存活态是这一刻取的;没有戳(读不到头/正文)就不发 ETag,照旧无条件全量。
        const envelopeHeaders = displayPrivate ? { 'cache-control': 'no-store' }
          : envelopeStamp ? { etag: sessionEnvelopeEtag(id, envelopeStamp, liveParts, sinceRaw, deltaKey), 'cache-control': 'no-store' } : {};
        // 117l-A1-fix2(§11.9;B1 实现抽屉时发现,主会话核对源码):抽屉 steward-drawer.js 的
        // isLive() 第一判据是 `resumable && resumable.live === true`,而这个活回合分支修前没有
        // `live` 键,那条判据从没走通过,一直静默回落到「事项行五态 === 'running'」——挂在
        // request_user_input 上等答案的回合五态是 needs_you,于是被判成不在跑,抽屉的轮询节拍
        // (活 5s／闲 15s)与 activitySnapshot 都跟着错。只加这一个键;detectDanglingTurn 那一支
        // (真正判悬挂的形状)一个字不动。
        const resumable = live
          ? { dangling: false, kind: null, turnSeq: Math.max(0, Number(session.turnSeq) || 0), historyLength: sessionProviderHistoryLength(session), live: true }
          : detectDanglingTurn(session);
        // 116-4（27 号文 §11.7 第 3 项「唤醒链诚实」）：GET /api/sessions/steward?since=<ISO> 只回
        // 该时刻【之后】的消息。117b 的轮询发现 state.lastReply.at 变了（trigger:'inbox'）之后要把新
        // 回合追加进对话流，整份拉一遍管家会话在长会话上是几百 KB 的重复载荷。
        // 纪律：① 只对管家会话生效 —— 别的会话有自己的分页语义，不在本波范围；② 不带 since 的旧调用
        // 逐字节不变（没有这个参数就走原路，一行都不改）；③ 只切 messages 的尾巴，其余字段原样带出，
        // 前端拿到的仍是同一个形状；④ 不改会话对象本身（浅拷贝），loadSession 的返回值不许被路由改写。
        const sinceMs = sinceRaw ? Date.parse(String(sinceRaw)) : NaN;
        if (Number.isFinite(sinceMs)) {
          const all = Array.isArray(session.messages) ? session.messages : [];
          const tail = all.filter(m => {
            const at = Date.parse(String((m && m.createdAt) || ''));
            return Number.isFinite(at) && at > sinceMs;
          });
          return displayReply({ ok: true, execution, executionObservation, session: { ...session, messages: tail }, resumable, since: String(sinceRaw), messageCount: all.length, ...(liveTail ? { liveTail } : {}), ...(liveTurn ? { liveTurn } : {}) }, envelopeHeaders);
        }
        // 增量取:前缀戳对得上才回尾巴。信封与全量同形(同一组键、同一份 resumable/displayTitle/活态),只有三处不同 ——
        // session.messages 只是 messages[N..];session 上不带 providerHistory(前端从不读它,全量里照旧有);信封上多
        // messagesFrom(= N,客户端据此拼接)/ messageCount(整份条数,客户端拼完自检)/ messagesStamp(整份的新戳,可接着再增量)。
        // 对不上就什么都不做,落到下面的全量 —— 标签里带着参数,所以同一状态下全量与增量的标签不同,304 各认各的。
        // (delta 在装载之后就算好了,见上。)
        if (deltaKey) {
          if (delta) {
            const { providerHistory: _providerHistory, ...sessionHead } = session;
            return displayReply({
              ok: true, execution, executionObservation, session: { ...sessionHead, messages: delta.tail }, resumable, displayTitle: sessionDisplayTitle(session),
              messagesFrom: delta.from, messageCount: delta.count, messagesStamp: delta.stamp,
              ...(liveTail ? { liveTail } : {}), ...(liveTurn ? { liveTurn } : {}), ...(relay ? { relay } : {}),
            }, envelopeHeaders);
          }
        }
        // 116-5b(§11.8.5):这条线程该显示什么名字,由 02 的 sessionDisplayTitle 一处判定。
        // 放在【信封】上而不是往 session 里塞:session 就是会话头本身,路由不许改写它的形状
        // (上面 since 分支那条「不改会话对象本身」是同一条纪律);抽屉/「现在这一件」的标题读这个键。
        return displayReply({ ok: true, execution, executionObservation, session, resumable, displayTitle: sessionDisplayTitle(session), ...(liveTail ? { liveTail } : {}), ...(liveTurn ? { liveTurn } : {}), ...(relay ? { relay } : {}) }, envelopeHeaders);
      }
      if (req.method === 'PATCH' || (req.method === 'POST' && req.headers['x-http-method'] === 'PATCH')) {
        const body = await readJsonBody(req);
        // 116-3 A2:管家会话不是线程 —— 它没有权限档、没有标题重命名语义,元数据一律不许经这条通用
        // 路由改(GET 保留:117c 的历史渲染要读它)。与 10 的回合入口那道门同一条纪律:管家会话的写面
        // 只有管家运行器自己。
        if (id === STEWARD_SESSION_ID) {
          return send(res, apiFailure('steward.forbidden', {}, 'the steward session cannot be patched through /api/sessions', 403));
        }
        if (!safeSessionId(id)) return send(res, apiSessionNotFound());
        // 116-2a(27 号文 §3.3/§8.6「每条线程一个权限 chip、点开即换、立即生效」):线程级权限就地快切。
        // 与 engineRoute 同端点、同风格(它是会话级字段的既有先例)。两道门:
        //   ① 白名单 —— 非 PERMISSION_MODES 的值 400,绝不悄悄回落(用户按了一个档,系统却按另一个档跑,
        //      是第 78 波注释里点名的那类事故);null/'' 是【合法】的,意思是「清除会话级设置,回落全局」。
        //   ② 二次确认 —— 切到全自动必须显式 confirm:true,否则 409。这是 §8.6 那条弹窗要求的服务端一半:
        //      服务端不能只信 UI 弹过窗,任何调用方(脚本/117 壳/未来的管家 UI)都得过这道门。
        //      收紧与清除不需要确认。
        if (body && Object.prototype.hasOwnProperty.call(body, 'permissionMode')) {
          const requested = body.permissionMode == null ? '' : String(body.permissionMode);
          if (requested !== '' && !PERMISSION_MODES.includes(requested)) {
            return send(res, apiFailure('session.invalid_permission_mode', { permissionMode: requested, allowed: PERMISSION_MODES },
              `permissionMode must be one of ${PERMISSION_MODES.join('/')}, or null/"" to follow the global default`, 400));
          }
          if (PERMISSION_MODES_REQUIRING_CONFIRM.includes(requested) && body.confirm !== true) {
            return send(res, apiFailure('permission.confirm_required', { permissionMode: requested },
              'switching a thread to full-auto requires an explicit confirm:true (it can change files and run commands while you are away)', 409));
          }
        }
        // 117z-E2b 提交②(27 号文 §11.21.7 债 ②):给线程开桌面工具是与「切全自动」同一道门的另一种口径 ——
        // 修前只有 permissionMode 要 confirm:true,`desktopTools:true` 直接过。严格只看 === true:false / null /
        // '' / 不带键都是收紧或清除,与 permissionMode 那条一样不需要确认。错误码沿用同一个,前端一处分支。
        if (body && body.desktopTools === true && body.confirm !== true) {
          return send(res, apiFailure('permission.confirm_required', { desktopTools: true },
            'giving a thread desktop tools requires an explicit confirm:true (it can see your screen and press keys while you are away)', 409));
        }
        const session = await updateSessionMeta(id, body);
        if (!session) return send(res, apiSessionNotFound());
        const patchedConfig = await readConfig();
        // 审计:权限档是安全面,每一次改动都要能事后对账(谁、哪条线程、从哪档到哪档、生效档是什么)。
        if (body && Object.prototype.hasOwnProperty.call(body, 'permissionMode')) {
          logEvent({
            kind: 'session', source: 'permission_mode', sessionId: id,
            permissionMode: sessionMeta(session).permissionMode,
            effectivePermissionMode: resolvePermissionMode({ session, config: patchedConfig }),
            confirmed: body.confirm === true,
          });
        }
        // 117z-E2b 提交②:桌面工具的会话级覆盖同样是安全面,照 permission_mode 那条的形状记一行
        //(哪条线程、写成了什么、是不是带 confirm 来的)。desktopTools 读的是落盘后的三态(true/false/null)。
        if (body && Object.prototype.hasOwnProperty.call(body, 'desktopTools')) {
          logEvent({
            kind: 'session', source: 'desktop_tools', sessionId: id,
            desktopTools: sessionDesktopToolsOf(session),
            confirmed: body.confirm === true,
          });
        }
        // 既有形状只加不改:`session` 原样保留(既有断言与前端都读它),额外带一份 sessionMeta —— 它是
        // 权限 chip 要的两个字段(会话级 permissionMode / 派生 effectivePermissionMode)的唯一读形。
        return send(res, json({ ok: true, session, sessionMeta: sessionMeta(session, patchedConfig) }));
      }
      if (req.method === 'DELETE' || (req.method === 'POST' && req.headers['x-http-method'] === 'DELETE')) {
        // 列表只发布 safeSessionId 合法的 id(02 重建索引的判据),不合法的 id 不可能是一条会话:先回 400,
        // 不再对它跑 stopSession / revokeAllGrants / 一串 unlink,再回一个假的 ok:true。
        if (!safeSessionId(id)) return send(res, apiSessionIdInvalid());
        return send(res, json(await deleteSession(id)));
      }
    }
    return false;
  }

  return handleSessionApiRoutes;
}

module.exports = { createSessionRoutes };
