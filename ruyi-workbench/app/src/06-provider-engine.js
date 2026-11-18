// v0.8-S6 ERROR_CLASSES (§C6 seed): stable server-side枚举 mapping a machine error class → 中文人话 + 下一步.
// Seeded now so the v0.9 error-humanization UI has real data to render. `result` events attach `errorClass`
// when determinable (additive field). Exported for the UI + tests.
const ERROR_CLASSES = {
  provider_misconfigured: { zh: '模型端点未配置或不可用', next: '到 设置 → 模型与服务 → 模型服务商 检查地址与密钥' },
  network_down: { zh: '网络不可用（当前离线）', next: '联网后重试；或改用离线可完成的任务' },
  permission_denied: { zh: '此操作被权限拒绝', next: '在弹窗中允许，或在 设置→权限 调整模式' },
  tool_error: { zh: '工具执行出错', next: '查看工具返回的错误详情，调整参数后重试' },
  idle_timeout: { zh: '回合空闲超时，已中止', next: '重新发送，或缩小单步任务范围' },
  // v0.8-S7: the repeated-call loop guard stopped the turn (≥5 identical consecutive tool calls). Distinct
  // from idle_timeout / the iteration-cap message — it means the model was stuck retrying the same call.
  tool_loop: { zh: '检测到重复的工具调用，已停止本轮', next: '换个说法或参数再试；若结果不对，先确认前一步的输出' },
  // v0.9-S5: the user rejected the execution plan in 计划模式 (真流程). No tool ran; the turn ended cleanly.
  plan_rejected: { zh: '你否决了本次执行计划', next: '补充要求后重新发起，或切换权限模式' },
  schema_failed: { zh: '节点输出不符合结构化契约', next: '检查 outputSchema；可能缺失的字段请显式允许 null' },
  evidence_missing: { zh: '节点缺少要求的工具执行证据', next: '确认节点工具权限，并让节点实际调用工具后再下结论' },
  vote_contract_failed: { zh: '投票节点输入格式不正确', next: '让每个投票前序明确输出 verdict 与 confidence' },
  dependency_cycle: { zh: '依赖图存在真实环或悬空依赖', next: '检查节点依赖方向和引用的节点 ID' },
  gate_rejected: { zh: '质量门给出不通过裁决', next: '查看 verdict、confidence 和 findings 后决定修复或接受' },
  // 125-P1(42 号文 §5-ter):把「能走到用户/管家面前的机器类」补齐。数过一遍才发现,修前表里 12 条,
  // 而 08 的 classifyNodeErrorText 三个默认出口(timeout / network / subagent_failed)—— 也就是**最常见
  // 的那几类** —— 一条都不在表里,于是管家只能说「未知类别(subagent_failed)」,并不比原始机器词强。
  // 既有 12 条一个字节不动(2.0 错误卡读的是同一张表,改它等于改那张卡的文案)。
  timeout: { zh: '这一步超时了', next: '稍后重试;或把这一步拆小一点再跑' },
  network: { zh: '网络访问失败', next: '检查网络后重试;暂时不通就先做不依赖联网的部分' },
  subagent_failed: { zh: '子代理没能完成这一步', next: '打开节点详情看它最后的输出,再决定重跑还是改任务' },
  no_progress: { zh: '连着几轮没有新进展,已停下', next: '换个做法或把任务拆开,原地重试解决不了' },
  semantic_stall: { zh: '反复产出相同结果,判为原地打转', next: '补上缺的信息,或换一种分解方式' },
  node_exception: { zh: '节点执行时抛了异常', next: '看错误详情,多半是参数或环境问题' },
  scheduler_error: { zh: '调度器兜底异常(节点没能正常收尾)', next: '这类多半是工作台自身的问题,留一条取证给开发者' },
  degraded_fail: { zh: '只拿到降级输出,按策略判失败', next: '重跑这个节点,或把质量门放宽' },
  worktree_error: { zh: '隔离工作树收尾失败', next: '看工作区是不是被占用,再重跑' },
  blocked: { zh: '被前面失败的节点挡住了', next: '先把前一步修好,它好了这一步会自己继续' },
  cancelled: { zh: '已被停止', next: '要接着做就自己按「继续」——工作台不会替你重开' },
  interrupted: { zh: '被中断了(插话或停止)', next: '先确认当时改到哪一步,再决定接着做还是重来' },
  propagate_cycle: { zh: '依赖传播时发现环', next: '检查节点之间的依赖方向' },
  gate_uncovered: { zh: '质量门要求的检查没覆盖到', next: '补上门要求的检查项再跑' },
  gate_unverified: { zh: '质量门的结论缺少验证', next: '让节点真的跑一次验证再下结论' },
  gate_unpropagated: { zh: '质量门结论没有传到下游', next: '检查下游节点有没有声明依赖' },
  claude_cli_error: { zh: 'Claude CLI 这一回合非正常退出', next: '看会话里最后的输出;多为 CLI 侧问题,可以重发' },
  kimi_acp_error: { zh: 'Kimi 这一回合非正常退出', next: '看会话里最后的输出;可以重发' },
  cli_missing: { zh: '找不到可用的 CLI', next: '到 设置 检查 CLI 路径' },
  launch_error: { zh: '这一回合根本没起来', next: '重发一次;仍然不行就看工作台日志' },
  // hunt2:主回合 429 已自动退避重试过几次仍被限流(09 runOpenAiTurn)。修前归 tool_error,把人引去查工具。
  rate_limited: { zh: '模型服务商限流(请求太频繁或额度用尽)', next: '稍等一会儿再发;频繁出现就到 设置 → 模型与服务 → 模型服务商 检查额度或换备用端点' },
  // 服务商自己报的错(HTTP 5xx / 其它 4xx、流内错误帧、Responses failed、Anthropic 拒答)。修前这些全落成 tool_error「工具执行出错」,
  // 把人引去查工具;它不是工具的错,也不一定是配置的错(404 / 401 / 403 另有 provider_misconfigured),多半是服务端暂时故障或请求被拒。
  provider_error: { zh: '模型服务商返回了错误', next: '多为服务端暂时故障或请求被拒:稍后重试;反复出现就看错误详情,或到 设置 → 模型与服务 → 模型服务商 检查模型名与地址' },
};

// ============================================================================
// v0.9-S2 — Playbooks (§7.8 / §4 C2). One-click办公任务模板. Schema:
//   { id, title, icon, desc, inputs:[{key,label,type:'text'|'folder'|'file'}],
//     promptTemplate, requires:[], engineHint, uiMode }
// Built-ins ship read-only in resources/playbooks/*.json; user playbooks live in dataRoot/playbooks/*.json.
// getCapabilities evaluates each against requires → available:bool + unavailableReason (never hidden — an
// unavailable card renders greyed with its reason, so the capability model stays legible to the user, C2).
// ============================================================================
const { evalPlaybookAvailability, matchServiceEntry } = require('./backend/playbook-policy.cjs');
const { normalizePlaybook, loadAllPlaybooks, listPlaybooksWithAvailability, saveUserPlaybook, deleteUserPlaybook, playbookReuseSources, draftPlaybookFromSession } = require('./backend/playbooks.cjs').createPlaybooks({ safeSessionId, externalRoot, paths, safeJsonParse, getCapabilities, atomicWriteJson, loadSession, readConfig, activeOpenAiProvider, providerRawCompletion, cachedInputTokensFromUsage, computeProviderCost, appendUsageLedger });

// ── 116-5a(27 号文 §11.8「线程自动摘要」)────────────────────────────────────────────────
// 每开一条新线程,自动生成一个 ≤24 字的名字与一句 ≤80 字的概括写进会话头 threadBrief。用户证据:
// 线程搜索结果里整条是用户原话「帮我分析一下AMD——按美股超威半导体…」,一屏放不下三条,
// 看不出哪条是哪件事。
//
// 与 playbook 起草、JSON 修复共用非流式补全服务，独立记入 aux 台账。
//
// 红线(§11.8.8):不改写 session.title(原话是权威,brief 只是显示层的另一份数据);不给存量会话
// 补账;不进 providerHistory(与会话上下文完全隔离,不污染下一回合);失败静默,绝不阻塞回合。
const THREAD_BRIEF_INPUT_CHARS = 1200;    // 喂给模型的用户原话上限
const THREAD_BRIEF_REPLY_CHARS = 400;     // settled 阶段附带的助手回复上限
// 两次机会各自的尝试预算(实测调整,见 §11.6 116-5a 交付记录):
//   · 首回合那次是【机会性】的 —— 端点正常时一发就中,不该为了一个名字在回合刚起跑时连打三次;
//   · 收工那次才是真正的兜底(此刻有助手回复,概括也更准),退避重试留给它。
// 全流程一条线程最多 4 次调用(常见路径 1 次),而不是「两次机会 × 各 3 次 = 6 次」。
const THREAD_BRIEF_FIRST_TURN_TRIES = 1;
const THREAD_BRIEF_RETRY_BACKOFF_MS = [1000, 4000];  // 收工那次:首发 + 两次退避重试后放弃
const THREAD_BRIEF_PER_MINUTE = 20;       // 每进程每分钟上限,防批量导入会话把端点打爆
const threadBriefCalls = [];              // 最近一分钟的调用时刻(ms),纯内存
// 每会话在途/已成的登记表(纯内存,进程重启即清)。**没有它就会重复调模型**:首回合那次的落盘走
// updateSessionMeta,活回合期间它会被延后到 settle 之后重放;而收工钩子恰恰在那个窗口里判「还没有
// brief」—— 于是同一条线程被起了两次名字(116-5a 实测:briefHits=2)。磁盘上的判据在这个窗口里
// 是不可靠的,唯一可靠的是进程内「我已经在给它起名字了」。
const threadBriefInflight = new Map();    // sessionId -> Promise<brief|null>
const threadBriefDone = new Map();        // sessionId -> 本进程内算出来的 brief(供收工补写)

function threadBriefEnabled(config) {
  // 默认【开】,所以判据是 !== false(与 01-config 的归一同方向)。
  return !config || config.stewardThreadBriefV1 !== false;
}

// 端点解析(用户 2026-09-07 拍板 §11.8.10 第 2 条):管家端点优先,没配就回落到【这条线程自己的】
// OpenAI 兼容 provider;两者都不可用(主引擎是 CLI 且没配管家端点)则不生成。
// 要避开的是 CLI 进程与工具循环,不是「同一个 provider」—— 一次独立的非流式 HTTP 调用不占 CLI。
function threadBriefProvider(config, threadProvider) {
  const id = String((config && config.stewardProviderId) || '').trim();
  if (id) {
    const found = ((config && config.providers) || []).find(p => p && p.id === id);
    if (!found) return null;   // 配了却找不到:不静默换成别的端点(与 13h stewardResolveRoute 同立场)
    const model = String((config && config.stewardModel) || '').trim();
    return model ? { ...found, model } : found;
  }
  return threadProvider || null;
}

function threadBriefRateLimited() {
  const now = Date.now();
  while (threadBriefCalls.length && now - threadBriefCalls[0] > 60000) threadBriefCalls.shift();
  if (threadBriefCalls.length >= THREAD_BRIEF_PER_MINUTE) return true;
  threadBriefCalls.push(now);
  return false;
}

// 模型输出 -> {title, gist} | null。围栏、前后杂字、以及【单元素数组】外壳都容忍(取第一个 { 到
// 最后一个 },所以 [{…}] 会被拆开;多元素数组切出来不是合法 JSON,照样失败)。宽容一点是有代价考量的:
// 每失败一次就要多两次模型调用。但解析不出合法对象就是失败(交给重试)—— 绝不拿整段原文当标题,
// 那正是这一波要消灭的东西。
function parseThreadBrief(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj = null;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const title = String(obj.title || '').replace(/\s+/g, ' ').trim();
  const gist = String(obj.gist || '').replace(/\s+/g, ' ').trim();
  return title ? { title, gist } : null;   // 没有名字就不算成功(概括可以空)
}

function buildThreadBriefMessages(message, replyText, locale, excerpts) {
  const zh = !String(locale || '').toLowerCase().startsWith('en');
  const sys = zh
    ? '你给一条对话线程起名字。只输出一个 JSON 对象:{"title":"…","gist":"…"}。title 是这件事的名字,不超过 24 个字,像文件名一样具体(例:「AMD 收盘分析」);gist 是一句人话,不超过 80 个字,说清要做什么。不要解释、不要代码围栏、不要任何多余字符。'
    : 'You name a conversation thread. Output only one JSON object: {"title":"…","gist":"…"}. title names the task in at most 24 characters, concrete like a filename; gist is one plain sentence of at most 80 characters saying what is being done. No explanation, no code fences, no extra characters.';
  const parts = [(zh ? '用户原话:' : "User's own words:") + '\n' + (excerpts ? excerpts.message : String(message || '').slice(0, THREAD_BRIEF_INPUT_CHARS))];
  const reply = String(replyText || '').trim();
  if (reply) parts.push((zh ? '助手回复(节选):' : 'Assistant reply (excerpt):') + '\n' + (excerpts ? excerpts.reply : reply.slice(0, THREAD_BRIEF_REPLY_CHARS)));
  return [{ role: 'system', content: sys }, { role: 'user', content: parts.join('\n\n') }];
}

// 主入口。**永不抛、永不阻塞回合**:调用方一律 void 调它。返回落盘的 brief 或 null。
// 外壳只做一件事:同一条会话同时只有一次在途 —— 后到的那次等前一次的结果,前一次成了就不再调模型。
async function maybeWriteThreadBrief(input) {
  const o = (input && typeof input === 'object') ? input : {};
  const sid0 = safeSessionId(o.sessionId);
  if (!sid0) return null;
  if (threadBriefDone.has(sid0)) return null;
  const inflight = threadBriefInflight.get(sid0);
  if (inflight) {
    const prior = await inflight.catch(() => null);
    if (prior) return null;                 // 前一次已经把名字写上了,这一次不用再调
    if (threadBriefDone.has(sid0)) return null;
  }
  const task = threadBriefOnce(o, sid0);
  threadBriefInflight.set(sid0, task);
  try {
    const brief = await task;
    if (brief) threadBriefDone.set(sid0, brief);
    return brief;
  } finally {
    if (threadBriefInflight.get(sid0) === task) threadBriefInflight.delete(sid0);
  }
}

// 116-5a 收工那一刻的唯一入口:先【补写】(不调模型),不行再走收工那次兜底。
// 为什么必须补写(116-5a 实测抓到的丢写):首回合那次是在回合刚起跑时发的,它的落盘与回合自己的
// 收尾整份 saveSession 抢同一个文件 —— 回合手里那份内存副本【不含】 brief,谁后写谁赢,而回合
// 几乎总是后写。updateSessionMeta 的活回合延后防护挡不住这一发(brief 的写可能恰好落在
// turnSettlers 已清、回合收尾 save 还没落地的那个窗口里)。补写是幂等的,而且不再调模型。
async function settleThreadBrief(o) {
  const sid = safeSessionId(o && o.sessionId);
  if (!sid) return null;
  const reasserted = await reassertThreadBrief(sid);
  if (reasserted) return reasserted;
  return maybeWriteThreadBrief({ ...(o || {}), stage: 'settled' });
}

// 把本进程算出来的 brief 再写一次(仅当盘上确实没有)。永不调模型、永不抛。
async function reassertThreadBrief(sessionId) {
  try {
    const sid = safeSessionId(sessionId);
    if (!sid) return null;
    const brief = threadBriefDone.get(sid);
    if (!brief) return null;
    const head = await loadSession(sid).catch(() => null);
    const live = getSessionTitleOverride(sid);
    if (!head || head.titleSource === 'user' || (live && live.rewindGen !== undefined && (Number(head.rewindGen) || 0) !== live.rewindGen)) return null;
    if (head && head.threadBrief && String(head.threadBrief.title || '').trim()) return brief;  // 已经在盘上
    await updateSessionMeta(sid, { threadBrief: brief }).catch(() => null);
    return brief;
  } catch { return null; }
}

// The current main agent supplies a title only after an explicit change of objective; no extra model call.
async function updateAutomaticThreadTitle(input) {
  const o = input || {}, sid = safeSessionId(o.sessionId);
  if (!sid) return { ok: false, error: 'session_required' };
  const head = await loadSession(sid);
  if (!head || head.kind === 'steward') return { ok: false, error: 'invalid_thread' };
  if (head.titleSource === 'user') return { ok: true, updated: false, reason: 'user_title' };
  if (typeof o.title !== 'string') return { ok: false, error: 'title_required' };
  const parsed = parseThreadBrief(JSON.stringify({ title: o.title, gist: o.gist ?? '' }));
  if (!parsed) return { ok: false, error: 'title_required' };
  const brief = { schema: 1, title: parsed.title.slice(0, SESSION_BRIEF_TITLE_CHARS), gist: parsed.gist.slice(0, SESSION_BRIEF_GIST_CHARS), at: nowIso(), model: 'agent', stage: 'settled' };
  const rewindGen = Number(head.rewindGen) || 0;
  if (getSessionTitleOverride(sid)?.titleSource === 'user') return { ok: true, updated: false, reason: 'user_title' };
  setSessionTitleOverride(sid, { threadBrief: brief, rewindGen });
  threadBriefDone.set(sid, brief);
  RUYI_EVENTS.emit('thread.state', { sessionId: sid });
  await updateSessionMeta(sid, { threadBrief: brief, threadBriefRewindGen: rewindGen });
  return { ok: true, updated: true, title: brief.title };
}

async function threadBriefOnce(o, sid, policyBound = false) {
  try {
    const config = o.config || null;
    if (!threadBriefEnabled(config)) return null;
    if (!policyBound && typeof PrivacyGateway !== 'undefined') return await PrivacyGateway.withPolicy(sid, () => threadBriefOnce(o, sid, true));
    const stage = o.stage === 'settled' ? 'settled' : 'first_turn';
    const message = String(o.message || '').trim();
    if (!message) return null;
    // 管家会话不是线程(它没有名字要起)。判据读【原始】 kind,不经 sessionKind() —— 那会把它归一成
    // quick_ask。这里【不能】引用 06i 的 STEWARD_SESSION_ID:06i 拼在 06 之后,引用它就是一条前向边。
    const head = await loadSession(sid).catch(() => null);
    if (!head || !head.id) return null;
    if (head.kind === 'steward') return null;
    // 116-5a:这条线程已经有【人给的】名字(建会话时就带了非占位标题,或用户/管家改过名)——
    // 生成的名字本来就排在它后面(§11.8.3 的显示优先级),再花一次调用去起一个永远不显示的名字
    // 是纯浪费。这也是 116-5a 全量回归里那批红的根因:默认开之后,每一条首轮都多打一发,把各
    // e2e 假端点的计数与剧本序列全打乱了 —— 收窄到「真的没名字才起名」之后,那批红自然消失,
    // 而不是靠给二十几个夹具挨个塞一行开关关掉。
    if (head.titleSource === 'user') return null;
    // 已经有名字了就不再写:两次机会(首回合发起 + 收工补写)里先到的那次说了算。
    if (head.threadBrief && typeof head.threadBrief === 'object' && String(head.threadBrief.title || '').trim()) return null;
    const provider = threadBriefProvider(config, o.threadProvider || null);
    if (!provider) return null;                    // 端点不可用:静默不生成
    if (threadBriefRateLimited()) return null;
    let excerpts;
    if (typeof PrivacyGateway !== 'undefined' && PrivacyGateway.active()) {
      // Identify the full originals before applying title budgets. A raw slice can split a
      // credential/identity into an unrecognizable fragment; a protected slice stays atomic.
      const messageView = await PrivacyGateway.projectSource(message, true);
      const reply = String(o.replyText || '').trim();
      const replyView = reply ? await PrivacyGateway.projectSource(reply, true) : null;
      excerpts = {
        message: PrivacyGateway.sliceSource(messageView, 0, Math.min(message.length, THREAD_BRIEF_INPUT_CHARS)).text,
        reply: replyView ? PrivacyGateway.sliceSource(replyView, 0, Math.min(reply.length, THREAD_BRIEF_REPLY_CHARS)).text : '',
      };
    }
    const messages = buildThreadBriefMessages(message, o.replyText, config && config.locale, excerpts);
    const tries = stage === 'settled' ? THREAD_BRIEF_RETRY_BACKOFF_MS.length + 1 : THREAD_BRIEF_FIRST_TURN_TRIES;
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, THREAD_BRIEF_RETRY_BACKOFF_MS[attempt - 1]));
      const sc = await providerRawCompletion(provider, messages, sid);
      // 记账:与 playbook-draft / json-repair 逐条同款(kind:'aux' + note)。usage 缺失直接跳过不估算。
      // **不计入 stewardMaxCostPerDay**(note 不是 'steward')—— 它不是管家回合,混进去会让管家因为
      // 用户开了几条新线程而提前停机。防御式:记账绝不可影响摘要,更不可影响回合。
      try {
        const u = sc && sc.usage;
        const inTok = u ? (Number(u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens) || 0) : 0;
        const outTok = u ? (Number(u.completion_tokens != null ? u.completion_tokens : u.output_tokens) || 0) : 0;
        const cachedInTok = cachedInputTokensFromUsage(u);
        if (inTok > 0 || outTok > 0) {
          const ledgerModel = (sc && sc.model) || provider.model || '';
          const { cost, currency } = computeProviderCost(provider, inTok, outTok, cachedInTok, ledgerModel);
          appendUsageLedger({
            sessionId: sid, engine: 'openai', provider: provider.id, model: ledgerModel,
            inTok, outTok, cachedInTok, cost, currency, estimated: false,
            turnSeq: Math.max(0, Number(head.turnSeq) || 0), kind: 'aux', note: 'thread-brief',
          });
        }
      } catch { /* accounting must never break the brief */ }
      const parsed = (sc && sc.ok) ? parseThreadBrief(sc.content) : null;
      if (parsed) {
        // 走 updateSessionMeta:首回合那次发起时回合还在跑,这条通道会延后到 settle 之后在
        // 【重新装载的副本】上重放,绝不会用陈旧正文盖掉回合刚写的消息(116-2a 的既有防护)。
        const brief = { schema: 1, title: parsed.title.slice(0, SESSION_BRIEF_TITLE_CHARS), gist: parsed.gist.slice(0, SESSION_BRIEF_GIST_CHARS), at: nowIso(), model: String((sc && sc.model) || provider.model || ''), stage };
        const current = await loadSession(sid).catch(() => null);
        if (!current || current.titleSource === 'user' || (Number(current.rewindGen) || 0) !== (Number(head.rewindGen) || 0)
            || String(current.threadBrief?.at || '') !== String(head.threadBrief?.at || '')) return null;
        const live = getSessionTitleOverride(sid);
        if (live?.titleSource === 'user' || live?.threadBrief) return null;
        setSessionTitleOverride(sid, { threadBrief: brief, rewindGen: Number(head.rewindGen) || 0 });
        RUYI_EVENTS.emit('thread.state', { sessionId: sid });
        await updateSessionMeta(sid, { threadBrief: brief, threadBriefRewindGen: Number(head.rewindGen) || 0 }).catch(() => null);
        return brief;
      }
    }
    // 只有收工那次(真正的兜底)失败才算「放弃」值得记一条;首回合那一发是机会性的,失败很正常。
    if (stage === 'settled') logEvent({ kind: 'thread_brief_failed', sessionId: sid, stage, provider: String(provider.id || '') });
    return null;
  } catch (error) {
    try { logEvent({ kind: 'thread_brief_failed', sessionId: String(o.sessionId || ''), stage: String(o.stage || ''), error: String((error && error.message) || error).slice(0, 200) }); } catch { /* 观测绝不反噬 */ }
    return null;
  }
}

// v1.5 (Judge JSON 修复 · 兜底/§2): provider 引擎节点的解析加固仍失败时的一次性(bounded=1)无工具修复调用。复用
// providerRawCompletion 的非流式模式：system 层钉「JSON 修复器」，user 层携原始输出 + 解析错误 + schema 要点，
// 只求模型吐回单个合法 JSON 对象；结果交回同一解析管线。这一次补全按 aux 台账记账(kind:'aux'/note:'json-repair'，
// 仿 playbook-draft)。全程防御式——修复/记账的任何异常都不得影响节点执行主流程(返回 null 即维持原失败路径)。
async function repairNodeJsonViaProvider(provider, config, session, node, schema, rawOutput, parseError) {
  try {
    const sys = '你是 JSON 修复器，只输出修正后的单个 JSON 对象，无任何其它文字（不要 Markdown、不要标题、不要代码围栏、不要解释）。字符串值内部的双引号必须转义为 \\"，去掉尾逗号，补齐缺失的括号与引号。';
    const schemaHint = schema ? ('\n\n目标 JSON Schema（要点）：\n' + JSON.stringify(schema).slice(0, 1500)) : '';
    // 对抗轮 P2: 裁判类输出是"长分析在前、JSON 收尾"(候选提取从后往前的同一设计前提),截取必须保尾——
    // 原 slice(0,12000) 在超长输出下发给修复模型的是不含真实 JSON 的分析文字,诱导其凭空编造 verdict。
    const rawStr = String(rawOutput || '');
    const rawSlice = rawStr.length <= 12000 ? rawStr : (rawStr.slice(0, 2000) + '\n…(中段省略)…\n' + rawStr.slice(-10000));
    const user = '下面的文本本应是一个 JSON 对象，但解析失败了。请只输出修正后的 JSON 对象。\n\n解析错误：' + String(parseError || '').slice(0, 300) + schemaHint + '\n\n原始输出：\n' + rawSlice;
    const sc = await providerRawCompletion(provider, [{ role: 'system', content: sys }, { role: 'user', content: user }], session?.id);
    // v1.4-OSS 用量看板(补): 每次实际发出的修复补全记一行 aux(note:'json-repair')。usage 缺失直接跳过不估算。
    // 防御式 —— 记账绝不可影响修复流程。
    try {
      const u = sc && sc.usage;
      const inTok = u ? (Number(u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens) || 0) : 0;
      const outTok = u ? (Number(u.completion_tokens != null ? u.completion_tokens : u.output_tokens) || 0) : 0;
      const cachedInTok = cachedInputTokensFromUsage(u);
      if ((inTok > 0 || outTok > 0) && session && session.id) {
        const ledgerModel = sc.model || provider.model || '';
        const { cost, currency } = computeProviderCost(provider, inTok, outTok, cachedInTok, ledgerModel);
        appendUsageLedger({
          sessionId: session.id, engine: 'openai', provider: provider.id, model: ledgerModel,
          inTok, outTok, cachedInTok, cost, currency, estimated: false, turnSeq: session.turnSeq, kind: 'aux', note: 'json-repair',
          agentKey: node && node.id,
        });
      }
    } catch { /* accounting must never break repair */ }
    if (sc && sc.ok && sc.content) return sc.content;
  } catch { /* repair must never break node execution */ }
  return null;
}

// ============================================================================
// v0.8-S6 — Layered system prompt framework (§7.6).
// buildProviderSystemPrompt assembles the provider engine's layers: [identity] [runtime identity]
// [tool protocol] [capability] [project-memory] [provider]. The Claude/Kimi CLIs build their own system
// prompt and read CLAUDE.md natively; Ruyi reaches them through --append-system-prompt (Claude) or the
// stdin instruction block (Kimi), and since 145-W3 both carry the per-engine environment brief built by
// buildEngineEnvBrief below from the same capability facts. The product name DOES enter the prompt now
// (108a runtime identity layer, 「如意 Ruyi」), but the identity is still pinned to the provider label +
// model, and the provider-side text must never say "Claude" or the old product name "Workbench": the
// historical "running inside Win Claude Workbench" line was the identity bleed that made deepseek-v4-pro
// claim to be Claude (capabilities.e2e / prompt-snapshot D11b guard that).
// ============================================================================
const PROJECT_MEMORY_CAP = 16 * 1024; // 16KB cap on CLAUDE.md/AGENTS.md before truncation

function buildBrowserAutomationHint(config, platform = process.platform) {
  const browser = (config && config.browserAutomation) || {};
  const mode = String(browser.mode || 'system');
  if (mode === 'system') return 'Browser target: system (macOS). browser_open only requests URL handoff; navigation is not verified and the user browser is not DOM-attached. For desktop interaction, inspect diagnostics for current capture, input and AX readiness and verify the target browser window. Local-image OCR does not require screen recording permission. URL handoff alone does not establish desktop readiness. For DOM work, ask the user to configure managed/custom/CDP/bundled and prepare its local runtime. Never navigate or close the Ruyi Workbench tab; never change the browser target without the user asking.';
  if (mode === 'cdp') return `Browser target: CDP (${String(browser.cdpUrl || 'http://127.0.0.1:9222')}). Reuse the attached user browser when available; inspect tabs before opening another one.`;
  if (mode === 'managed') return 'Browser target: managed installed browser. Use the user\'s configured Chromium-family browser executable through Playwright; this may open a separate automation window. Reuse its current tab unless the user asks for a new tab.';
  if (mode === 'custom') return `Browser target: custom executable (${String(browser.executable || 'not configured')}). Reuse its current automation tab unless the user asks for a new tab.`;
  return 'Browser target: bundled Playwright browser (isolated Chrome for Testing). This is an explicit compatibility/testing choice and may open a separate window; never describe it as the user\'s signed-in browser.';
}

// 108b: 文案迁入 06b registry(中英双包),并补齐设置边界: mcp_configure 只写 MCP 连接器与浏览器目标,
// 模型端点/模型/权限模式/输出风格/界面语言必须引导用户去设置面板改。调用方传 config 以选 locale;
// 不传时按 getPromptPack 的既有默认(中文包)取。
function buildToolCustomizationHint(config) {
  return getPromptPack(config && config.locale).toolCustomization.hint;
}

const TOOL_ITERATION_BUDGETS = Object.freeze({ standard: 100, long: 200, standardHard: 300, hard: 1000, extension: 50 });

// Long-task detection is deliberately independent from Agent team mode. A single-agent migration, audit,
// investigation, or end-to-end implementation can be long; conversely, the explicit team switch is an
// orchestration preference. Both receive enough starting room, but for different reasons.
function isLongToolTask(message, context = {}) {
  if (context.driverAuto === true || context.hasMission === true) return true;
  const text = String(message || '').trim();
  if (text.length >= 1200) return true;
  const explicitLong = /长任务|复杂任务|持续推进|自主推进|不要停|端到端|全面(?:实现|测试|排查|审计)|完整(?:实现|迁移|重构)|批量(?:处理|迁移|测试)|系统性(?:排查|研究|评测)|\b(?:long[- ]running|complex task|end[- ]to[- ]end|comprehensive|systematic|autonomously continue|do not stop|benchmark|migration|refactor|audit|investigation)\b/i;
  if (explicitLong.test(text)) return true;
  const implementation = /实现|修改|开发|构建|修复|迁移|重构|implement|build|change|fix|migrate|refactor/i.test(text);
  const verification = /测试|验证|回归|打包|部署|发布|重启|提交|推送|test|verify|regression|package|deploy|release|restart|commit|push/i.test(text);
  return implementation && verification && (text.length >= 160 || /然后|并且|同时|and then|as well as/i.test(text));
}

function resolveToolIterationBudget(configured, message, context = {}) {
  const raw = Math.round(Number(configured));
  const base = Number.isFinite(raw) ? Math.max(1, Math.min(200, raw)) : TOOL_ITERATION_BUDGETS.standard;
  const longTask = isLongToolTask(message, context);
  const agentTeam = context.agentTeam === true;
  const elevated = longTask || agentTeam;
  return {
    base,
    initial: elevated ? Math.max(base, TOOL_ITERATION_BUDGETS.long) : base,
    hardLimit: elevated ? TOOL_ITERATION_BUDGETS.hard : TOOL_ITERATION_BUDGETS.standardHard,
    extension: TOOL_ITERATION_BUDGETS.extension,
    mode: agentTeam ? 'agent-team' : (longTask ? 'long' : 'standard'),
    longTask,
    agentTeam,
  };
}

function shouldExtendToolIterationBudget({ currentLimit, hardLimit, iter, lastProgressIter, progressEvents, progressAtLastExtension }) {
  if (!(currentLimit < hardLimit)) return false;
  if ((Number(progressEvents) || 0) - (Number(progressAtLastExtension) || 0) < 3) return false;
  return (Number(iter) || 0) - (Number(lastProgressIter) || 0) <= 8;
}

// Read cwd's project-memory file (CLAUDE.md preferred, then AGENTS.md), ≤16KB. Returns { text, name,
// truncated } or null when neither exists. Runtime reads the USER'S OWN file (clean-room safe); the content
// is fenced + labeled as untrusted reference input by the caller so a malicious repo can't hijack the系统层.
async function readProjectMemory(cwd) {
  const dir = String(cwd || '').trim();
  if (!dir) return null;
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const p = path.join(dir, name);
    try {
      const stat = await fsp.stat(p);
      if (!stat.isFile()) continue;
      let text = await fsp.readFile(p, 'utf8');
      // F3 (安全·围栏防字面闭合): the caller wraps this content in a FIXED literal fence
      // (<project-memory>…</project-memory>). Untrusted repo content containing a literal
      // `</project-memory>` (or an opening `<project-memory>`) would otherwise close/spoof the fence
      // early and let a CLAUDE.md line escape into the system layer. Rewrite the angle-bracket form to a
      // bracket form (`<project-memory` → `[project-memory`, `</project-memory` → `[/project-memory`) —
      // same byte length, so the truncation math below is unaffected.
      text = neutralizeFenceTag(text, 'project-memory'); // P2-8: 单一事实源见 00-boot.js
      let truncated = false;
      if (Buffer.byteLength(text, 'utf8') > PROJECT_MEMORY_CAP) {
        // Truncate to the cap by bytes (slice by chars then trim until under the byte cap — good enough).
        text = text.slice(0, PROJECT_MEMORY_CAP);
        while (Buffer.byteLength(text, 'utf8') > PROJECT_MEMORY_CAP) text = text.slice(0, -256);
        truncated = true;
      }
      return { text, name, truncated };
    } catch { /* not found / unreadable → try next */ }
  }
  return null;
}

// Build the four-layer provider system prompt. `identityOnly` (used by summary calls) yields just the
// identity layer (+ provider layer) so a compaction summary is cheap yet still correctly identified.
//   provider  : the active provider object (label + model drive the pinned identity line)
//   model     : resolved model id
//   cwd       : working directory (surfaced + used to locate project memory)
//   tools     : the tool list actually offered this turn (drives the tool-protocol guard rails)
//   caps      : the capability matrix (drives the capability layer + 「当前不可用」 list)
//   config    : for TOOL_REQUIRES gating (enableToolRequiresProbe)
//   projectMemory : pre-read { text, name, truncated } or null
//   skillEntries : v1 技能体系 — 本会话已启用且可用的技能条目(kind==='skill'),仅主回合传入;identityOnly/子代理不传。
// 51d(04 Phase C)C1a:拆分稳定层/易变层(prefix-cache 稳定化分层基础)。buildProviderSystemPrompt 保留为
// 向后兼容包装(stable+volatile),行为零漂移(prompt-snapshot 绿)。C1b(后续):09 启用分层(sys=stable,
// volatile 动态注入 messages[1],避开 09:854 参数未初始化 + 持久化问题)。
// 稳定层:身份 + 工具协议 + provider append(会话内逐字节稳定,prefix-cache 友好)。
// 108a:身份层之后、工具协议层之前加「运行时身份层」(产品名/版本/启动模式/安装位置/数据目录/服务地址/实例标识),
// 只在 !identityOnly 时注入(压缩摘要调用保持廉价);字段全部为进程内恒定量,不破坏前缀缓存。
// 108a 运行时事实装配:只读 00-boot / 01-config 的进程内恒定量(不读 LAUNCH_MODE,那是前向边),
function buildRuntimeIdentityFacts() {
  const host = (typeof RUNTIME !== 'undefined' && RUNTIME && RUNTIME.host) || '127.0.0.1';
  const port = (typeof RUNTIME !== 'undefined' && RUNTIME && RUNTIME.port) || DEFAULT_PORT;
  return {
    appName: APP_NAME,
    version: VERSION,
    launchMode: 'node',
    installDir: externalRoot(),
    dataDir: dataRoot(),
    address: 'http://' + host + ':' + port,
    instanceId: OVERLAY_ID,
  };
}

// ── 145-W3 引擎运行环境说明(单一事实源)────────────────────────────────────────────────────────
// 用户 2026-09-24:「根据不同引擎的线程设计不同的提示词,让 claude code 知道它是在如意工作台中、有什么能力」。
// 修前只有 provider 引擎有完整的「你在如意里」说明;Claude/Kimi 只拿到零散的 MCP/工具加载/记忆提示。
// 这里把事实收成一张表(facts),三个引擎各按自己的口径渲染,文字全在 06b 的 engineBrief:
//   · facts 只取【能力集合】:引擎、语言包、版本与启动方式、MCP 是否接入、是否交互模式、编排是否开启、
//     桌面控制(全局闸 + 会话级覆盖 + desktopMcp.enabled)、终端里的 rg 来源、权限档、是否管家代开。
//     不含时间戳、端口、会话 id、联网状态这类每回合会变的东西 —— 同一能力集两次装配逐字节相同
//     (fingerprint 同),Claude 的系统提示前缀与 Kimi 的 stdin 去重哈希都不会被它无端打破。
//   · claude / kimi:整段 <ruyi-environment> 围栏,进 CLI 的附加指令。
//   · provider:身份层与运行时身份层已经说过的不再重复 —— 稳定层只补 renderDiagram(常量),易变层补
//     权限档、提问弹窗、管家代开三句(providerEnvLines),rg 并进既有能力行(见 buildVolatileParts)。
const ENGINE_BRIEF_OPEN = '<ruyi-environment>';
const ENGINE_BRIEF_CLOSE = '</ruyi-environment>';
const RUYI_MCP_TOOL_PREFIX = RUYI_MCP_CLI_TOOL_PREFIX; // CLI 引擎里如意工具的全名前缀(mcp__ruyi__)
const _engineBriefMemo = new Map();
function engineBriefFacts({ engine, config, session, rg } = {}) {
  const cfg = config || {};
  // 登记过的 CLI 类型原样;provider 族归 provider;其余(缺失/野值)归默认 CLI(claude)。修前是 `=== 'kimi'` 三分。
  const kind = isAgentCliType(engine) ? engine : ((engine === 'provider' || engine === 'openai') ? 'provider' : AGENT_CLI_DEFAULT_TYPE);
  const runtime = buildRuntimeIdentityFacts();
  const deskOverride = session && typeof session.desktopTools === 'boolean' ? session.desktopTools : null;
  const allowDesk = deskOverride == null ? cfg.allowDesktopTools !== false : deskOverride;
  const rgShell = rg && (rg.shell === 'bundled' || rg.shell === 'system') ? rg.shell : '';
  return {
    engine: kind,
    locale: getPromptPack(cfg.locale) === PROMPT_EN ? 'en-US' : 'zh-CN',
    version: runtime.version,
    launchMode: runtime.launchMode,
    mcp: kind !== 'provider' && cfg.includeWorkbenchMcp !== false,
    interactive: kind !== 'provider' && AGENT_CLI_TYPES[kind].usesStreamJsonInput(cfg),
    orchestrate: Number(cfg.subagentMaxPerTurn) > 0,
    desktop: !!(cfg.desktopMcp && cfg.desktopMcp.enabled) && allowDesk,
    rgShell,
    permissionMode: PERMISSION_MODES.includes(cfg.permissionMode) ? cfg.permissionMode : 'default',
    stewardOpened: !!(session && (session.createdBy === 'steward' || session.origin === 'steward')),
  };
}
function renderCliEnvBrief(f) {
  const askNative = AGENT_CLI_TYPES[f.engine].hasNativeQuestionPrompt();
  const pack = getPromptPack(f.locale);
  const b = pack.engineBrief;
  const lines = [ENGINE_BRIEF_OPEN];
  lines.push(b.cliIdentity({ appName: APP_NAME, version: f.version, launchMode: f.launchMode, engineName: b.engineName[f.engine] }));
  lines.push(b.nativeTools[f.engine]);
  if (process.platform === 'darwin') lines.push(pack.toolProtocol.intro);
  if (f.mcp) {
    lines.push(b.mcpIntro({ prefix: RUYI_MCP_TOOL_PREFIX }));
    lines.push(b.mcpMemory);
    // Kimi 的原生提问经 ACP 落到如意的提问卡;Claude 交互模式禁了原生 AskUserQuestion(--disallowedTools)。
    lines.push(askNative ? b.askNative : b.mcpAsk + (f.interactive ? b.mcpAskNoNative : ''));
    lines.push(b.mcpToolSearch);
    if (f.orchestrate) lines.push(b.mcpOrchestrate);
    lines.push(b.mcpSelfStatus);
  } else if (askNative) {
    lines.push(b.askNative);
  }
  lines.push(f.desktop ? b.desktopOn : b.desktopOff);
  lines.push(b.rgShell[f.rgShell || 'none']);
  lines.push([b.renderMarkdown, b.renderDiagram].join(f.locale === 'en-US' ? ' ' : ''));
  lines.push(b.workspace);
  lines.push(b.permission(b.permissionModes[f.permissionMode] || b.permissionModes.default) + b.permissionRefusal);
  lines.push(b.steward);
  if (f.stewardOpened) lines.push(b.stewardOpened);
  lines.push(ENGINE_BRIEF_CLOSE);
  return lines.join('\n');
}
function providerEnvLines(f, offeredNames) {
  const b = getPromptPack(f.locale).engineBrief;
  const lines = [b.permission(b.permissionModes[f.permissionMode] || b.permissionModes.default)];
  if (offeredNames && offeredNames.has('request_user_input')) lines.push(b.askProvider);
  if (f.stewardOpened) lines.push(b.stewardOpened);
  return lines;
}
// 返回 { text, lines, fingerprint, facts }。claude/kimi 用 text(整段围栏);provider 用 lines(易变层逐行)。
function buildEngineEnvBrief(opts = {}) {
  const facts = engineBriefFacts(opts);
  const fingerprint = crypto.createHash('sha1').update(JSON.stringify(facts), 'utf8').digest('hex').slice(0, 12);
  if (facts.engine === 'provider') {
    return { text: '', lines: providerEnvLines(facts, opts.offeredNames), fingerprint, facts };
  }
  let text = _engineBriefMemo.get(fingerprint);
  if (text === undefined) {
    text = renderCliEnvBrief(facts);
    if (_engineBriefMemo.size > 64) _engineBriefMemo.clear();
    _engineBriefMemo.set(fingerprint, text);
  }
  return { text, lines: [], fingerprint, facts };
}
// CLI 装配入口:rg 走 11 的进程级缓存异步探测(05 不直接引用 11,免一条新的模块环边)。
async function resolveEngineEnvBrief(opts = {}) {
  const rg = opts.rg !== undefined ? opts.rg : await probeRgAsync().catch(() => null);
  return buildEngineEnvBrief({ ...opts, rg });
}

const { renderProviderStablePrompt } = require('./backend/provider-stable-prompt.cjs');
function buildStableSystemPrompt(provider, model, cwd, tools, identityOnly, config) {
  return renderProviderStablePrompt({
    provider, model, cwd, tools, identityOnly, config,
    runtimeIdentity: identityOnly ? null : buildRuntimeIdentityFacts(),
  });
}
// 易变层:能力/桌面规程/搜索/风格/项目/技能/记忆/账本(每回合可能变化,自破 prefix cache)。
// C1b 时移 user 侧;C1a 仍由 buildProviderSystemPrompt 包装进 system(行为零漂移)。
// 108b: 末尾新增可选参数 playbookEntries(不动任何既有位置参数,旧调用点与快照夹具原样可用)。
// 只有主回合调用方传它;子代理(08-agent-runs)不与用户对话,不传 -> 天然无 playbook 索引。
// 145-W3: 末尾再加可选参数 envContext = { session }(不动任何既有位置参数)。传了会话头才认得出「管家代开」;
// 不传时引擎说明的其余几句照常(权限档/提问弹窗)。
// #9: 末尾再加可选参数 options。options.memoryTurnTail===true 时本层只含【稳定的核心胶囊】,不含随每条消息变化的检索回执与相关记忆索引 ——
// 调用方(09 runOpenAiTurn)用 buildMemoryTurnSection 另造那一半,投到末条 user 尾部;这一层前插首条 user,必须跨回合逐字节稳定才吃得到前缀缓存。
function buildVolatileParts(provider, tools, caps, config, projectMemory, skillEntries, memoryEntries, mission, memoryConflicts, memoryCheck, playbookEntries, envContext, options) {
  const lines = [];
  // [能力层]
  const netStr = caps && caps.network
    ? (caps.network.online === true ? '在线' : (caps.network.online === false ? '离线' : '联网状态未知'))
    : '联网状态未知';
  const deskN = (caps && caps.desktopMcp && Number(caps.desktopMcp.toolCount)) || 0;
  const gitStr = (caps && caps.binaries && caps.binaries.git) ? '有 git' : '无 git';
  // 145-W3:rg 那一格按能力矩阵的 rgShell 说清「终端里能不能直接敲 rg」(随包 vendor-bin 已前置进 PATH)。
  const rgText = getPromptPack(config && config.locale).engineBrief.rgCapability;
  const rgStr = (caps && caps.binaries && caps.binaries.rg) ? (caps.binaries.rgShell ? rgText.shell : rgText.fast) : rgText.none;
  lines.push(getPromptPack(config && config.locale).capability.line({ netStr, deskN, gitStr, rgStr }));
  const toolRequiresEnabled = !!(config && config.enableToolRequiresProbe);
  const offeredNames = new Set((tools || []).map(t => t && t.function && t.function.name).filter(Boolean));
  if (offeredNames.has('orchestrate_agents') || offeredNames.has('shell_start')) {
    lines.push(getPromptPack(config && config.locale).toolProtocol.asyncWork);
  }
  if (offeredNames.has('orchestrate_agents')) {
    const concurrent = Math.max(1, Number(config && config.subagentMaxConcurrent) || 2);
    const total = Math.max(0, Number(config && config.subagentMaxPerTurn) || 0);
    lines.push(getPromptPack(config && config.locale).capability.subagentConcurrency({ concurrent, total }));
    lines.push(getPromptPack(config && config.locale).capability.subagentOrchestrate);
    lines.push(getPromptPack(config && config.locale).capability.subagentResources);
    // 52x: 子 agent 优先端点+模型(设了 subagentPreferredProvider 且 id 有效才提示)
    const spProv = config && config.subagentPreferredProvider;
    if (spProv) {
      const spProvObj = (config.providers || []).find(p => p.id === spProv);
      if (spProvObj) lines.push(getPromptPack(config && config.locale).capability.subagentPreferred({ provider: spProvObj.label || spProv, model: (config.subagentPreferredModel || '').trim() }));
    }
  }
  if (offeredNames.has('mcp_list') || offeredNames.has('mcp_configure')) lines.push(buildToolCustomizationHint(config));
  // 108c: 提示模型有 workbench_self_status 可查自身版本/位置/端口/设置,别凭记忆回答。
  if (offeredNames.has('workbench_self_status')) lines.push(getPromptPack(config && config.locale).capability.selfStatus);
  const unavailable = [];
  for (const [name, spec] of Object.entries(TOOL_REQUIRES)) {
    if (spec.testOnly && !toolRequiresEnabled) continue;
    if (offeredNames.has(name)) continue;
    const chk = toolRequirementsMet(name, caps, toolRequiresEnabled, config);
    if (!chk.met) unavailable.push(`${name}（${chk.reason || '当前不可用'}）`);
  }
  if (unavailable.length) lines.push(getPromptPack(config && config.locale).capability.unavailable({ list: unavailable.join('、') }));
  // [操控规程层]
  const deskToolsOffered = [...offeredNames].some(n => {
    const p2 = toolPackForName(n, {});
    return p2 === 'desktop' || p2 === 'office';
  });
  const deskPresent = !!(caps && caps.desktopMcp && caps.desktopMcp.present && deskToolsOffered);
  const visionCap = provider ? provider.vision === true : !!(caps && caps.provider && caps.provider.vision === true);
  if (deskPresent) {
    lines.push(buildBrowserAutomationHint(config));
    if (process.platform === 'darwin') {
      lines.push(getPromptPack(config && config.locale).desktop.sharedMac);
    } else if (visionCap) {
      lines.push(getPromptPack(config && config.locale).desktop.vision);
    } else {
      lines.push(getPromptPack(config && config.locale).desktop.text);
    }
    lines.push(getPromptPack(config && config.locale).desktop.office);
  }
  // [检索指引]
  const searchBackendOn = !!(config && config.searchBackend && config.searchBackend.type && config.searchBackend.type !== 'none');
  const hasWebSearch = offeredNames.has('web_search')
    || (searchBackendOn && toolRequirementsMet('web_search', caps, false, config).met);
  const onlineNow = !!(caps && caps.network && caps.network.online === true);
  if (hasWebSearch && onlineNow) {
    lines.push(getPromptPack(config && config.locale).webSearch);
  }
  // [风格层]
  if (config && config.outputStyle === 'concise') {
    lines.push(getPromptPack(config && config.locale).styleConcise);
  }
  // [如意环境层] - 145-W3:与 Claude/Kimi 的 <ruyi-environment> 同一张事实表(buildEngineEnvBrief)。
  // provider 这边只补身份层/工具协议层没说过的:当前权限档的含义、request_user_input 会弹提问卡、管家代开。
  lines.push(...buildEngineEnvBrief({
    engine: 'provider', config, session: envContext && envContext.session, offeredNames,
    rg: { shell: caps && caps.binaries ? caps.binaries.rgShell : '' },
  }).lines);
  // [项目层]
  if (projectMemory && projectMemory.text) {
    const note = projectMemory.truncated ? `（超过 16KB，已截断）` : '';
    lines.push(getPromptPack(config && config.locale).projectMemory({ note, text: projectMemory.text }));
  }
  // [技能层]
  if (Array.isArray(skillEntries) && skillEntries.length) {
    const skillSec = buildSkillsPromptSection(skillEntries, 'openai', config);
    if (skillSec) lines.push(skillSec);
  }
  // [Playbook 索引层] - 108b · 紧跟技能层之后、记忆层之前
  if (Array.isArray(playbookEntries) && playbookEntries.length) {
    const pbSec = buildPlaybookIndexSection(playbookEntries, config);
    if (pbSec) lines.push(pbSec);
  }
  // [记忆层]
  const memoryTurnTail = !!(options && options.memoryTurnTail === true);
  if (memoryCheck && !memoryTurnTail) {
    const checkSec = buildMemoryCheckPrompt(memoryCheck, config);
    if (checkSec) lines.push(checkSec);
  }
  if (Array.isArray(memoryEntries) && memoryEntries.length) {
    const memSec = buildMemoryPromptSection(memoryEntries, 'openai', config, memoryConflicts, memoryTurnTail ? { part: 'core' } : undefined);
    if (memSec) lines.push(memSec);
  }
  // [工作台记忆核心能力] — 内置工具是唯一入口；写入永远经过候选卡片与用户确认。
  if (Array.isArray(tools) && tools.some(t => t && t.function && t.function.name === 'workbench_memory_propose')) {
    lines.push(getPromptPack(config && config.locale).memoryCoreGuide({
      list: 'workbench_memory_list', read: 'workbench_memory_read', propose: 'workbench_memory_propose',
      relationPropose: 'workbench_memory_relation_propose', revise: 'workbench_memory_revise', relationRevoke: 'workbench_memory_relation_revoke',
      lazyMaintenance: !(config && config.toolLoadingMode === 'full'), // N8: 三个维护工具在 memory 包,按需装载
    }));
  }
  // [ACC 序列思维工具引导] — 当 sequential_thinking 在工具列表中时，注入使用指引
  if (Array.isArray(tools) && tools.some(t => t && t.function && t.function.name === 'sequential_thinking')) {
    lines.push('[序列思维工具指引]');
    lines.push('你有 sequential_thinking 工具用于外化多步推理链。以下场景应主动使用：');
    lines.push('- 复杂多步规划（>3 步）、方案对比权衡、调试根因分析');
    lines.push('- 最简用法: sequential_thinking(thought="...", thought_number=1, total_thoughts=3, next_thought_needed=true)');
    lines.push('- 简单一步能答的问题不要用（徒增往返）；这不是执行工具，只记录思考过程');
  }
  // [任务账本层]
  if (mission) {
    const misSec = buildMissionPromptSection(mission, 'openai', config);
    if (misSec) lines.push(misSec);
  }
  return lines.join('\n');
}
// 向后兼容包装(行为零漂移):identityOnly 时只 stable,否则 stable+volatile。
function buildProviderSystemPrompt(provider, model, cwd, tools, caps, config, projectMemory, identityOnly, skillEntries, memoryEntries, mission, memoryConflicts, memoryCheck, playbookEntries, envContext) {
  const stable = buildStableSystemPrompt(provider, model, cwd, tools, identityOnly, config);
  if (identityOnly) return stable;
  const volatile = buildVolatileParts(provider, tools, caps, config, projectMemory, skillEntries, memoryEntries, mission, memoryConflicts, memoryCheck, playbookEntries, envContext);
  return volatile ? stable + '\n' + volatile : stable;
}

// v1 技能体系: 生成紧凑技能索引段，供两个引擎注入系统提示。engine==='claude' → 每行附 SKILL.md 绝对路径，
// 说明用 Read 工具读取路径下的 SKILL.md 及其目录内脚本/资源；否则(provider) → 每行附 [id]，说明用 skill_read
// 工具按需读取全文。每技能一行「- <name>：<description ≤160字>」。整段上限 3000 字符(超出截断加省略行)。
// 只认 kind==='skill' 且带 dir 的条目;其余(command/playbook)不进系统提示。
function buildSkillsPromptSection(enabledSkills, engine, config) {
  const skills = (Array.isArray(enabledSkills) ? enabledSkills : []).filter(s => s && s.kind === 'skill' && s.dir);
  if (!skills.length) return '';
  const isClaude = engine === 'claude';
  // P2-1: 声明式表头 —— 技能 name/description 来自不可信 SKILL.md,明确降级为「参考资料」,不得覆盖以上任何守则;
  // 技能行包进 <skill-index> 围栏(不可信带),并中和技能名/描述里可能伪造围栏的 <skill-index> / </skill-index> 记号
  // (同 project-memory 的 fence 手法,把尖括号换成方括号)。
  const fence = t => neutralizeFenceTag(t, 'skill-index'); // P2-8: 单一事实源见 00-boot.js
  const header = isClaude ? getPromptPack(config && config.locale).skillsHeader.claude : getPromptPack(config && config.locale).skillsHeader.provider;
  const body = [];
  for (const s of skills) {
    const desc = fence(String(s.description || '').replace(/\s+/g, ' ').trim().slice(0, 160));
    const name = fence(String(s.name || s.id));
    if (isClaude) body.push(`- ${name}（${path.join(s.dir, 'SKILL.md')}）：${desc}`);
    else body.push(`- ${name} [${s.id}]：${desc}`);
  }
  // 整段上限 ~3000 字符：仅截断围栏内的技能行,闭合围栏始终保留(截断行落在栏内)。
  const OPEN = '\n<skill-index>\n', CLOSE = '\n</skill-index>', TRUNC = '\n' + getPromptPack(config && config.locale).skillsHeader.truncated;
  let text = body.join('\n');
  const budget = 3000 - header.length - OPEN.length - CLOSE.length;
  if (text.length > budget) text = text.slice(0, Math.max(0, budget - TRUNC.length)) + TRUNC;
  return header + OPEN + text + CLOSE;
}

// 作者写的文本(Playbook / 技能的标题、描述、正文)进模型前的统一中和:所有尖括号换成方括号,伪造围栏 / 伪造标签一并失效。
// 单一事实源 —— Playbook 索引段(下)与 playbook_list / playbook_read / skill_list 三个只读工具(12)共用,不各抄一份。
function neutralizeAuthoredText(t) { return String(t == null ? '' : t).replace(/[<>]/g, ch => (ch === '<' ? '[' : ']')); }

// 108b Playbook 精简索引: 索引只给「有哪些、叫什么、干什么」;要看步骤用 playbook_read(只读,12 的 INTEGRATION_TOOL_HANDLERS),
// 照做须用户点名或明确同意(尾行 playbookIndex.trailer 同口径)。数据来自内置 resources/playbooks 与用户可写的
// dataRoot/playbooks/*.json, 标题与描述都是不可信文本,故沿用技能索引的不可信带纪律:整段包进
// <playbook-index> 围栏,条目里的尖括号一律中和成方括号(伪造围栏/伪造标签一并失效),描述裁到 160 字。
// 规模控制: 整行详情至多 12 条(available 优先,不可用项排后并标注),其余压成一行简列,整段硬顶 900 字符(见函数内
// 61-B5 注);连简列都装不下才按整条截断并补一行省略标记(不做裸 slice,避免半截条目)。空列表返回 '' -> 零注入。
// 入参条目形状容错: { id | 'pb:id', title|name, description|desc, available, unavailableReason }。
function buildPlaybookIndexSection(playbooks, config) {
  const list = (Array.isArray(playbooks) ? playbooks : []).filter(p => p && (p.id || p.title || p.name));
  if (!list.length) return '';
  const pack = getPromptPack(config && config.locale).playbookIndex;
  // 不可信带中和: 所有尖括号 -> 方括号(比技能索引只中和 <skill-index> 更严,因为 playbook 描述常带示例文本)。
  const fence = neutralizeAuthoredText;
  // 61-B5:修前硬顶 600 字、按整行装箱,16 个内置 Playbook 实测只放得下字母序前 6 个,weekly-report 之类永远不可见。
  // 改成两级:前 k 条给整行(标题 + id + 描述),其余压成一行「其余:标题 [id]、…」;k 取装得下的最大值,整段硬顶 900 字。
  // 连全压缩都装不下时才按整条截断并留省略行(被裁掉这件事不静默丢失)。
  const MAX_ENTRIES = 12, CAP = 900;
  // available 优先: 不可用条目排在后面(排序稳定,同组保持原顺序)。
  const ordered = [...list.filter(p => p.available !== false), ...list.filter(p => p.available === false)];
  const fields = p => ({
    id: fence(String(p.id || '').replace(/^pb:/, '')),
    name: fence(String(p.title || p.name || p.id || '')),
    mark: p.available === false ? pack.unavailable : '',
  });
  const detailLine = p => {
    const { id, name, mark } = fields(p);
    const desc = fence(String(p.description || p.desc || '').replace(/\s+/g, ' ').trim().slice(0, 160));
    return `- ${name}${id ? ` [${id}]` : ''}：${desc}${mark}`;
  };
  const briefItem = p => { const { id, name, mark } = fields(p); return `${name}${id ? ` [${id}]` : ''}${mark}`; };
  const OPEN = '\n<playbook-index>\n', CLOSE = '\n</playbook-index>\n';
  const shellRoom = CAP - (pack.header.length + OPEN.length + CLOSE.length + pack.trailer.length);
  const wrap = lines => pack.header + OPEN + lines.join('\n') + CLOSE + pack.trailer;
  for (let k = Math.min(MAX_ENTRIES, ordered.length); k >= 0; k -= 1) {
    const lines = ordered.slice(0, k).map(detailLine);
    const rest = ordered.slice(k);
    if (rest.length) lines.push(pack.more(rest.map(briefItem)));
    if (lines.join('\n').length <= shellRoom) return wrap(lines);
  }
  // 全压缩也装不下:压缩行按整条装,留省略行。
  const room = shellRoom - (pack.truncated.length + 1);
  const items = ordered.map(briefItem);
  let n = items.length;
  while (n > 0 && pack.more(items.slice(0, n)).length > room) n -= 1;
  if (!n) return ''; // 连一条都放不下 -> 整段丢(不留空围栏)
  return wrap([pack.more(items.slice(0, n)), pack.truncated]);
}
