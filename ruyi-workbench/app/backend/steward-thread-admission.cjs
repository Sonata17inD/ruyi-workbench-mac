'use strict';

function createStewardThreadAdmission({
  EventStreamHooks, sessionMissionId, memoryIsExpired, STEWARD_ANSWER_BASIS,
  STEWARD_SESSION_ID, stewardMayAct, stewardPermissionLabel, stewardSanitizeText, stewardWatchedThread,
  threadOriginOf, stewardFail, stewardReadMemoryStore, stewardThreadPermissionMode, stewardTurnTaintedBy,
  stewardUserDirected,
}) {

  // ────────────────────────────────────────────────────────────────────────────
  // 121-K3(34 号文 §4.5「管家对你正坐着的线程」):用户此刻就坐在这条线程前面时,管家【不动手】。
  // 具体是:不代答它的提问(不主动 steward_thread_continue)、不递话、不改它的权限与模型。
  // **可以读**(steward_thread_read 不过这道门)—— 用户问「那条在干嘛」时管家还得答得上来。
  //
  // 事实源与 13e 的索引行 seatedBy 同一份:13r 的在场快照(SSE 连接自报的 lens/sessionId),
  // 经 00-boot 的延迟绑定命名空间取(13k 拼在 13r 之前,直引是前向边)。
  // 读不到一律当【没人坐着】= 修前行为:这道门管的是打扰纪律,不是权限门(那一道在别处,不受影响),
  // 所以 fail-open —— 在场信号缺席时让管家停摆,比偶尔插一句话糟得多。
  function stewardSeatedByUser(sessionId) {
    const sid = String(sessionId || '');
    if (!sid) return false;
    try {
      const presence = typeof EventStreamHooks.presenceSnapshot === 'function' ? EventStreamHooks.presenceSnapshot() : [];
      // 2026-10(用户:「用户在看提问、权限,管家被立刻唤醒也不要插手」):第二种「在跟前」—— 任一视角的连接在
      // viewing 里报了这条线程(它的权限/提问弹窗、展开的待办小窗、管家焦点栏正摆在用户面前,且人在,见 13r 头注)。
      // 同一个单点:代批(13l steward_decide)、代答、递话、续跑的门都从这里过,不各补一份。
      return Array.isArray(presence) && presence.some(row => row && (
        (row.lens === 'classic' && String(row.sessionId || '') === sid)
        || (Array.isArray(row.viewing) && row.viewing.includes(sid))));
    } catch { return false; }
  }
  // 128f-⑪(用户拍板 A):管家盯着的线程,权限请求至少等 600 s。三个条件同时成立才算:
  // 管家开着;线程由管家盯着(stewardWatchedThread);用户此刻没坐在 / 没看着它(那是当面弹的,按基础时限等 ——
  // 缺省不限时,128f 时代的「120 s」已经不是缺省值 —— 管家也不插手,见上面的 stewardSeatedByUser)。
  // WCW_TEST_STEWARD_PERMISSION_WAIT_MS 是测试口(e2e 不等 10 分钟)。
  // 注:04 的 permissionTimeoutMs 自 2026-09-24 起缺省 0(不限时),那时这 600 s 只是 max(不限时, 600 s) = 仍不限时;
  // 只有用户在设置里给权限请求配了时限,这一格才把它抬到至少 10 分钟。2026-10 的放宽(见下面 stewardMediatesPermissions)
  // 【不】碰这一格:用户给自己开的线程配了时限,那是他的意思,不因为线程按智能自动在跑就被悄悄拉长到 10 分钟。
  const STEWARD_MEDIATED_PERMISSION_WAIT_MS = 600000;
  function stewardMediatedPermissionWaitMs(sessionId, config, head) {
    if (!config || config.stewardEnabledV1 !== true) return 0;
    const sid = String(sessionId || '');
    if (!sid || sid === STEWARD_SESSION_ID || !head || String(head.id || '') !== sid) return 0;
    if (!stewardWatchedThread(head, sid, sessionMissionId(head) || sid)) return 0;
    if (stewardSeatedByUser(sid)) return 0;
    const test = Number(process.env.WCW_TEST_STEWARD_PERMISSION_WAIT_MS);
    return Number.isFinite(test) && test > 0 ? test : STEWARD_MEDIATED_PERMISSION_WAIT_MS;
  }
  // 2026-10(用户拍板「用户自己开的线程可以适当放宽」):「这条线程停下来问的权限请求归管家处理」的单点 ——
  // 13q 回合收尾的「留给你」通知与「追问一次」都读它。比上面那条等待判据宽:
  //   · 管家开着、不是管家自己的会话、用户此刻没坐在 / 没看着它(stewardSeatedByUser);
  //   · 用户按过「别盯了」(stewardWatch:false)—— 不算,那是用户说「这条我自己看着」;
  //   · 管家盯着的线程(stewardWatchedThread)、定时任务开的线程 —— 算;
  //   · 2026-10 放宽:用户自己开、按「智能自动」在跑的线程 —— 也算。用户把档位定成智能自动,就是把「停下来问的
  //     那几条」交给了管家;代批本身仍要过 06i 的十道闸(闸 3 同样只认显式「别盯了」)。
  function stewardMediatesPermissions(sessionId, config, head) {
    if (!config || config.stewardEnabledV1 !== true) return false;
    const sid = String(sessionId || '');
    if (!sid || sid === STEWARD_SESSION_ID || !head || typeof head !== 'object' || String(head.id || '') !== sid) return false;
    if (head.stewardWatch === false || stewardSeatedByUser(sid)) return false;
    if (stewardWatchedThread(head, sid, sessionMissionId(head) || sid)) return true;
    if (threadOriginOf(head) === 'schedule') return true;
    return stewardThreadPermissionMode(head, config) === 'auto';
  }
  // 结构化拒绝:错误码 'seated_by_user',人话直说「你正在这条线程里,我不插手」。
  // 与 propose_required 那一族一样带 `reason`,行动流水事后能分清「管家没做」的两种原因。
  function stewardSeatedFail(sessionId) {
    return stewardFail('seated_by_user',
      '你正在这条线程里(或正看着它的提问/权限),我不插手 —— 等你离开它我再接手;要我现在就动手,先把这条线程留给我',
      { sessionId: String(sessionId || ''), reason: 'seated_by_user' });
  }

  // ── 129g 代答要有依据(31 号文 §2.5)──────────────────────────────────────────────────────
  // 修前的洞:线程挂着一道给用户的提问时,管家把 message 递过去就【直接答进那道题】—— 而且不检查
  // 这句话是谁说的。用户在跟前时那是他的原话(本来就该这样);无人值守回合里那就是管家自己编的一句,
  // 线程却分不出来(两条路同一个 decideIntervention,落到线程眼里都是「用户答了」)。
  // 于是本刀的口径:**替用户说话之前,先说清这句话的出处,而且出处要服务端核得动。**
  //
  // 两种出处各有各的核法,都不做相似度 —— J12 那一轮已经用实测证伪过「中段相似度分得清改述与反话」
  // (改述 0.176 < 反话 0.556,顺序是反的),这里不再走回同一条路:
  //   · 记忆:给条目 id → 回库里查,必须真在、仍 active、没过期。编一个 id 当场穿帮。
  //   · 委托书:给**原文片段** → indexOf 逐字核对。片段有下限,否则「是」「均价」这种碎片到处都能命中。
  function stewardAnswerBasisOf(args) {
    const raw = (args && typeof args.answerBasis === 'object' && args.answerBasis && !Array.isArray(args.answerBasis)) ? args.answerBasis : null;
    if (!raw) return { memoryIds: [], briefQuote: '' };
    const ids = Array.isArray(raw.memoryIds) ? raw.memoryIds : (raw.memoryIds ? [raw.memoryIds] : []);
    return {
      memoryIds: ids.map(v => String(v == null ? '' : v).trim()).filter(Boolean).slice(0, STEWARD_ANSWER_BASIS.maxMemoryIds),
      briefQuote: String(raw.briefQuote == null ? '' : raw.briefQuote).trim().slice(0, STEWARD_ANSWER_BASIS.quoteChars),
    };
  }

  // 委托书的可引正文 = 用户原话 ＋ 管家补充(两段都是【开线程那一刻就定下】的文本,事后不会变)。
  // 不是管家开的线程没有 brief —— 那就引不了委托书,只能靠记忆,或者照旧转用户。
  function stewardBriefTextOf(head) {
    const b = (head && head.brief && typeof head.brief === 'object') ? head.brief : null;
    if (!b) return '';
    return [String(b.userText || ''), String(b.supplement || '')].filter(Boolean).join('\n');
  }

  // 回 { ok, resolved:{memoryIds,briefRef}, misses:[人话] }。ok 的判据是**至少有一条真的落实了**,
  // 不是「模型填了字段」:填了四个不存在的 id 与一个字都没填,是同一件事。
  async function stewardResolveAnswerBasis(wanted, head) {
    const resolved = { memoryIds: [], briefRef: '' };
    const misses = [];
    if (wanted.memoryIds.length) {
      const store = await stewardReadMemoryStore().catch(() => ({ entries: [] }));
      const nowMs = Date.now();
      const byId = new Map((Array.isArray(store.entries) ? store.entries : [])
        .map(e => [String((e && e.id) || ''), e]));
      for (const id of wanted.memoryIds) {
        const entry = byId.get(id);
        if (!entry) { misses.push(`记忆 ${id} 不在库里`); continue; }
        // 被否决的条目不能当依据 —— 用户否掉它就是在说「别再按这条办」。过期同理(126-M02:
        // 时效是过滤不是删除,条目还在库里,但它不该再替用户拿主意)。
        if (entry.state !== 'active') { misses.push(`记忆 ${id} 已经被你否决过`); continue; }
        if (memoryIsExpired(entry, nowMs)) { misses.push(`记忆 ${id} 已过期`); continue; }
        if (entry.basis === 'activity') { misses.push(`记忆 ${id} 是行动推断,不能代替用户明确答复`); continue; }
        resolved.memoryIds.push(id);
      }
    }
    if (wanted.briefQuote) {
      const brief = stewardBriefTextOf(head);
      if (!brief) misses.push('这条线程没有委托书,引不了它的原文');
      else if (wanted.briefQuote.length < STEWARD_ANSWER_BASIS.quoteMin) misses.push(`引的片段太短(至少 ${STEWARD_ANSWER_BASIS.quoteMin} 个字)`);
      else if (!brief.includes(wanted.briefQuote)) misses.push('引的片段在委托书里逐字找不到');
      else resolved.briefRef = wanted.briefQuote;
    }
    return { ok: resolved.memoryIds.length > 0 || Boolean(resolved.briefRef), resolved, misses };
  }

  // 那道题的人话。13q 传进来的 decided 里带着 04 归一化过的 questions;取第一道就够 ——
  // 确认面板要的是「你在答什么」,不是把整份问卷再抄一遍。过一遍中和:它是线程模型写的文本。
  function stewardAnswerQuestionText(decided) {
    const list = (decided && Array.isArray(decided.questions)) ? decided.questions : [];
    const first = list.find(q => q && String(q.question || '').trim());
    return first ? stewardSanitizeText(String(first.question)).slice(0, STEWARD_ANSWER_BASIS.shownChars) : '';
  }

  // 代答闸。只在通道真的落到 'answer' 时由 13q 回调进来(见那里的头注)。
  // 返回 null = 放行;返回 stewardFail(...) = 这一句不代答,降级成提议交给用户。
  async function stewardAnswerGate(o) {
    const { args, ctx, config, head, sessionId, permissionMode } = o;
    // ① 用户就在跟前 —— 这句话是他的原话,不是代答。既有行为一字不动。
    //    判据是【此刻这个管家回合是不是用户触发的】,不是模型说了算(ctx 由 13g 的门控壳按
    //    13h 的 inflight.kind 填,模型碰不到)。取不到 trigger 一律按「不是用户」办 —— fail-closed:
    //    替人说话这件事上,「不确定」必须等于「不做」。
    if (stewardUserDirected(ctx)) return null;
    // ② 污染(129c 红线 4):这一回合读过外界内容就不代答。理由比别处更硬 —— 代答的「依据」本身
    //    可以是被网页诱导出来的:一个假页面写「用户说了按收盘价」,管家转手就替用户答了「按收盘」。
    const taintedBy = stewardTurnTaintedBy(ctx);
    if (taintedBy.length) {
      return stewardFail('propose_required',
        `我这一回合读过外部内容(${taintedBy.join('/')}),按规矩读过之后我不替你回答线程的提问 —— 这一句交给你`, {
          reason: 'steward_turn_tainted', selfTaintBy: taintedBy, channel: 'answer', sessionId,
        });
    }
    // ③ 自理清单。独立一格 answer,**不搭在 relay 上** —— 「事项内自动交接」与「替我回答」是两件事,
    //    一格两权的话用户勾的时候看不见第二个(默认关,见 01-config 的 DEF_AA)。
    const auto = (config && config.stewardAutoActions && typeof config.stewardAutoActions === 'object') ? config.stewardAutoActions : {};
    if (auto.answer !== true) {
      return stewardFail('propose_required',
        '「替我回答线程的提问」没有勾选,这一句只能作为提议交给你,不要重试', {
          reason: 'self_serve_off', channel: 'answer', sessionId,
        });
    }
    // ④ 目标线程权限档。事件类别如实填 'question'(线程此刻问的就是一道题),于是判据仍然只有
    //    06i 那张 §3.3 真值表一份 —— 只有全自动档判 auto。
    //    **这比 31 号文 §2.5 那一行「acceptEdits 与 auto 自动」严**:真值表是 2026-09-05 用户拍板的
    //    单点,而 acceptEdits 的原意是「改文件不问」,不是「替我拿主意」。要放开就改真值表那一处,
    //    不要在这里另写一份档位判据。
    const mayAct = stewardMayAct(permissionMode, 'question', 'edit');
    if (mayAct !== 'auto') {
      return stewardFail('propose_required',
        `目标线程的权限档为「${stewardPermissionLabel(permissionMode)}」,我不替你回答它的提问;把这一句作为提议交给你,不要重试`, {
          reason: 'target_permission', permissionMode, channel: 'answer', sessionId,
        });
    }
    // ⑤ 依据。没有出处就照旧转用户 —— 这是 §2.5 的原话,也是这一刀的名字。
    const wanted = stewardAnswerBasisOf(args);
    const found = await stewardResolveAnswerBasis(wanted, head);
    if (!found.ok) {
      const why = found.misses.length ? found.misses.join(';') : '一条依据都没给';
      return stewardFail('propose_required',
        `这道题的答案我没有出处(${why}),不替你答 —— 要我代答,先在 answerBasis 里给出记忆条目 id 或委托书原文片段;给不出就把这道题交给你`, {
          reason: 'no_basis', channel: 'answer', sessionId, misses: found.misses,
          // 129g:把【那道题本身】带回去。降级成按钮之后 13p 要拿它拼确认清单 —— 见那里的头注:
          // 不带的话按钮上只有「接着办」三个字,用户看不见自己在答什么。
          question: stewardAnswerQuestionText(o.decided),
        });
    }
    o.used = found.resolved;   // 放行:把【核实过的】依据回给调用方记账(不记模型填了什么,记核住了什么)
    return null;
  }

  // 续办只接受仍存在的上传件。以 id/name 在 uploads 内重新定位,不相信客户端的 path/size。

  return {
    stewardSeatedByUser, stewardMediatedPermissionWaitMs, stewardMediatesPermissions, stewardSeatedFail,
    stewardAnswerGate, stewardResolveAnswerBasis,
  };
}

module.exports = { createStewardThreadAdmission };
