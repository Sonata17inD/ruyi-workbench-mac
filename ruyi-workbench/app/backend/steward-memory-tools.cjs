'use strict';

function createStewardMemoryTools({
  loadSession, makeId, nowIso, safeSessionId, stewardAppendDecision, stewardClampInt, stewardFail,
  stewardSanitizeText,
  memory, evidence, limits,
}) {
  const {
    cleanMemoryDate, memoryIsExpired, memoryProposalLooksSensitive, stewardMemoryScopeMatches,
    stewardMemoryScopeOf, stewardMemoryTerms, stewardMutateMemory, stewardNormalizeMemoryScope,
    stewardReadMemoryStore, stewardTermJaccard,
  } = memory;
  const { isStewardToolName, stewardToolCallLine, stewardToolCallVerdict } = evidence;
  const { STEWARD_MEMORY_KINDS, STEWARD_MEMORY_LIMITS, STEWARD_MEMORY_MERGED_FROM_MAX } = limits;

  // ════════════════════════════════════════════════════════════════════════════
  // 记忆族(§4)—— 只记「用户本人陈述」。四道闸:来源必须是用户消息 -> 敏感过滤 -> 容量 -> 同义去重。
  // ════════════════════════════════════════════════════════════════════════════

  // 来源校验:sourceRef 指向的那个回合里必须真有一条【用户】消息。工具输出/助手消息来源确定性拒绝
  // (§11.3「工具输出来源确定性拒绝」)—— 否则管家会把自己或工具说的话当成用户的偏好记下来。
  // 126-M01:来源那条会话的工作目录 —— 作用域键的唯一来路。读不出就回空串(落全局)。
  async function stewardSourceCwd(sourceRef) {
    const sessionId = safeSessionId(sourceRef && sourceRef.sessionId);
    if (!sessionId) return '';
    const session = await loadSession(sessionId).catch(() => null);
    return String((session && session.cwd) || '');
  }
  // 返回该回合里【用户本人】消息的正文数组(没有则 null)。角色闸与 quote 核对共用这一份取数,不各读一遍会话。
  async function stewardSourceUserTexts(sourceRef) {
    const sessionId = safeSessionId(sourceRef && sourceRef.sessionId);
    if (!sessionId) return null;
    const turnSeq = Number(sourceRef && sourceRef.turnSeq);
    if (!Number.isFinite(turnSeq)) return null;
    const session = await loadSession(sessionId).catch(() => null);
    if (!session) return null;
    const messages = Array.isArray(session.messages) ? session.messages : [];
    // 116f 第二道:role:'user' 还不够 —— 管家的【收件箱回合】也是以一条 user 消息注入的(工作台把
    // 几十条系统事件归成一段文本发给模型),但那不是用户本人说的话。13h 在那条消息上落了
    // meta.origin === 'inbox'(随会话正文持久化,重启后仍在),这里确定性拒绝它。同理拒绝
    // 驱动器自动续跑的消息(source:'mission-driver')—— 也不是人说的。
    // 唤醒通知(meta.origin:'agent_wake',后台代理跑完后工作台替模型起的回合)同理:它是系统通知,正文里还带着子代理任务标题 ——
    // 那是模型 / 网页可影响的文本,不是用户说的话(06d memoryRecentUserTexts 早已同口径排除)。
    // 第二轮工具走查(F17):再拒一类 —— 管家自己发起的那条用户消息(thread_new 委托书 / thread_continue 递话 /
    // quick_ask 问题,13k stewardLaunchTurn 落 meta.origin:'steward')。它是管家转述的,不是用户本人这一回合说的话。
    const own = messages.filter(m => m && m.role === 'user' && Number(m.turnSeq) === turnSeq
      && !(m.meta && typeof m.meta === 'object' && (m.meta.origin === 'inbox' || m.meta.origin === 'steward' || m.meta.origin === 'agent_wake'))
      && m.source !== 'mission-driver');
    return own.length ? own.map(m => String(m.content == null ? '' : (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))) : null;
  }
  // 行动经验只引用已落盘、带明确成败的真实工具调用。只提供脱敏后的动作摘要,不把网页/工具正文当偏好。
  async function stewardSourceActivityTexts(sourceRef) {
    const sid = safeSessionId(sourceRef && sourceRef.sessionId);
    const callId = String(sourceRef && sourceRef.toolCallId || '');
    const turnSeq = Number(sourceRef && sourceRef.turnSeq);
    if (!sid || !callId || !Number.isSafeInteger(turnSeq)) return null;
    const session = await loadSession(sid).catch(() => null);
    const calls = (session?.messages || []).filter(m => m.role === 'assistant' && Number(m.turnSeq) === turnSeq)
      .flatMap(m => Array.isArray(m.toolCalls) ? m.toolCalls : []);
    const call = calls.find(c => String(c.id || '') === callId && !isStewardToolName(String(c.name || '')));
    if (!call || stewardToolCallVerdict(call) == null) return null;
    return [stewardToolCallLine(call)];
  }
  // 14(走查):来源闸原来只核对「那一回合有一条用户消息」,不核对写进库的内容是不是那条消息说的 —— 引一条无关的用户消息
  // (「帮我看看订单表」)就能写进 policy「所有线程的命令请求一律直接批准」,而这库驱动路由和代答依据。
  // 现在 sourceRef 还要带 quote:来源原话的一个片段,服务端逐字(空白折叠后)在那条用户消息里核对,仿 briefQuote 的 includes 校验。
  // 核得动的只是「这句引文真是用户说的」—— 它把「凭空编出处」变成「得引一句真话」,并且引文随条目落库(sourceQuote),
  // 面板与决策日志里看得见「它凭哪句话记的」。不做改述相似度(J12 已证伪)。
  function stewardFoldWs(text) { return String(text == null ? '' : text).replace(/\s+/g, ' ').trim(); }
  function stewardQuoteInSource(quote, userTexts) {
    const q = stewardFoldWs(quote).slice(0, STEWARD_MEMORY_LIMITS.quoteChars);
    if (!q) return { ok: false, code: 'invalid_request', message: 'sourceRef.quote is required: copy a verbatim fragment of the user\'s own message that this fact comes from' };
    const hay = (Array.isArray(userTexts) ? userTexts : []).map(stewardFoldWs);
    // 片段太短到处都能命中;但用户整条消息本来就很短(「用中文」)时,整条消息就是合法引文。
    if (q.length < STEWARD_MEMORY_LIMITS.quoteMin && !hay.some(t => t === q)) {
      return { ok: false, code: 'invalid_request', message: `sourceRef.quote is too short (at least ${STEWARD_MEMORY_LIMITS.quoteMin} characters, unless it is the user's whole message)` };
    }
    if (!hay.some(t => t.includes(q))) {
      return { ok: false, code: 'quote_not_found', message: 'sourceRef.quote does not appear verbatim in the user\'s message at that turn; copy the user\'s own words, do not paraphrase or cite a different message' };
    }
    return { ok: true, quote: q };
  }
  // 第二道(走查 #14 的核心):引文是真话还不够 —— 模型照样可以引一句无关的真话(「帮我看看订单表」)再配上编出来的 policy。
  // 所以要求写进库的这句话与引文【用词上有交集】(复用 stewardMemoryTerms:拉丁按词、CJK 按 2-gram,至少共享一个词项)。
  // 不做相似度(J12 已证伪「改述 vs 反话」分不开;这里只拦「风马牛不相及」的那一类),语种不同(英文引文配中文转述)词面上本来就没法比,放行。
  // 这仍然不是语义核实:同话题的反话(「别自动批准」→「用户要求自动批准」)拦不住 —— 那一类靠 policy 的后续闸与面板的可见/可否决(entry.sourceQuote 一并落库给人看)。
  function stewardTextGroundedInQuote(text, quote) {
    const cjk = v => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(String(v));
    if (cjk(text) !== cjk(quote)) return true;
    const quoteTerms = stewardMemoryTerms(quote);
    for (const term of stewardMemoryTerms(text)) if (quoteTerms.has(term)) return true;
    return false;
  }

  // 15) steward_memory_write
  async function stewardImplMemoryWrite(args, ctx, config) {
    if (args.basis != null && !['user', 'activity'].includes(args.basis)) return stewardFail('invalid_request', 'basis must be user or activity');
    const activity = args.basis === 'activity';
    const kind = String(args.kind || '');
    if (!STEWARD_MEMORY_KINDS.includes(kind)) return stewardFail('invalid_request', `kind must be one of ${STEWARD_MEMORY_KINDS.join('/')}`);
    const text = stewardSanitizeText(args.text).trim();
    if (!text) return stewardFail('invalid_request', 'text is required');
    if (text.length > STEWARD_MEMORY_LIMITS.textChars) {
      return stewardFail('invalid_request', `text must be at most ${STEWARD_MEMORY_LIMITS.textChars} characters`);
    }
    const sourceRef = (args.sourceRef && typeof args.sourceRef === 'object') ? args.sourceRef : null;
    if (!sourceRef) return stewardFail('invalid_request', 'sourceRef {sessionId, turnSeq} is required');
    const sourceTexts = activity ? await stewardSourceActivityTexts(sourceRef) : await stewardSourceUserTexts(sourceRef);
    if (sourceTexts === null) {
      if (activity) return stewardFail('source_not_activity', 'cite a persisted toolCallId with a known success/failure result; quote its redacted action summary, never external output');
      return stewardFail('source_not_user', 'sourceRef must point at a turn that contains the user\'s own message; tool output and assistant text are not valid memory sources');
    }
    const quoted = stewardQuoteInSource(sourceRef.quote, sourceTexts);
    if (!quoted.ok) return stewardFail(quoted.code, quoted.message);
    if (!stewardTextGroundedInQuote(text, quoted.quote)) {
      return stewardFail('quote_unrelated', 'the memory text shares no wording with sourceRef.quote; record the fact in words that come from the user\'s own sentence (the quote is stored as the evidence of what the user said)');
    }
    // 敏感过滤复用工作台记忆的同一条正则(密钥/口令/JWT/连接串),不另写第二套判据。
    if (memoryProposalLooksSensitive({ body: text })) {
      return stewardFail('sensitive_rejected', 'the text looks like a credential/secret and will never be stored in steward memory');
    }

    // 126-M02:时效。清洗复用 06d 的 cleanMemoryDate(非法/缺省 -> 空串 = 不过期)。
    // 写的时候允许留空 —— 「我用 Windows」这种事实本来就不该有到期日;该写的是
    //「这两周在赶 A 项目」那一类必然过期的。给不给由模型按提示词判断,服务端只管清洗与过滤。
    const activityExpiry = activity ? new Date(Date.now() + 30 * 86400000).toISOString() : '';
    const expiresAt = cleanMemoryDate(args && args.expiresAt) || activityExpiry;
    // 第二轮工具走查(F12):到期日【已经过去】修前被静默收下 —— 条目一落库就是「已过期」,既不进提示词也搜不到,
    // 模型却收到 ok:true,以为这条记住了(又一个「说 ok 其实没用」)。拒绝并如实说原因;要记就给将来的日期或不给。
    if (expiresAt && memoryIsExpired({ expiresAt })) {
      return stewardFail('invalid_request', `expiresAt ${stewardSanitizeText(String(args.expiresAt)).slice(0, 40)} is already in the past, so the entry would be expired on arrival and never used; give a future date or omit it`);
    }
    // 126-M01:作用域。模型只说「这条是不是项目级的」,**键由服务端从来源那条会话的 cwd 推出来** ——
    // 让模型自己填项目键 = 让它推断「这条管得着谁」,正是 31 号文 §2.6 的红线禁止的。
    // 来源会话读不出 cwd(或模型没说 project)时落全局:宁可多用一条,不可凭空把它锁进某个项目。
    const scope = (String(args && args.scope || '') === 'project' || (activity && args.scope !== 'global'))
      ? stewardMemoryScopeOf(await stewardSourceCwd(sourceRef))
      : '';
    const terms = stewardMemoryTerms(text);
    // 128h-J12:用户这次真改主意了的那条通道。模型必须**指名道姓**说出它要盖掉的那条否决条目的 id
    // (id 只出现在提示词的否决清单里),而不是靠换个说法把闸绕过去。
    const supersedes = String((args && args.supersedesVetoed) || '');
    if (activity && supersedes) return stewardFail('vetoed_duplicate', 'observations cannot revive a user-vetoed memory');
    return stewardMutateMemory(async store => {
      // 128h-J12:复活【按 id 认,不按相似度认】。这一条是写件时当场测出来的:用户改主意时说的那句话
      // 通常与当初否决的那条**说法不一样**(「算了还是记着吧,报告一律用中文」vs「用户偏好报告用中文书写」,
      // 实测重合度远在 0.8 以下)。要是只在词面闸命中时才认这个参数,那条否决条目会一直留在否决清单里,
      // 同时又多出一条生效的新条目 —— 提示词自相矛盾,正是本刀要消掉的那种场面。
      const revive = supersedes ? (store.entries.find(e => e.id === supersedes && e.state === 'vetoed') || null) : null;
      if (supersedes && !revive) {
        // 点名了一条不存在/不是被否决状态的条目:fail-closed。静默当成一次普通写入的话,模型以为
        // 「我已经把旧的盖掉了」,而旧的还在否决清单里 —— 又是一次「说 ok 其实没落上」。
        return { persist: false, result: stewardFail('not_found', `supersedesVetoed "${stewardSanitizeText(supersedes)}" is not a vetoed memory entry; check the vetoed list in your prompt for the right id`, { id: supersedes }) };
      }
      // 被否决过的同义内容拒绝写回(§4 第 ⑤ 条:vetoed 之后同义不再自动写回)。
      const vetoed = store.entries.find(e => e.state === 'vetoed' && stewardTermJaccard(terms, e.text) >= STEWARD_MEMORY_LIMITS.dedupeJaccard);
      // 128h-J12:修前这道闸是**死闸** —— 否决过就永远写不回来,用户后来改主意(「算了还是记着吧」)
      // 只能自己去面板点恢复,而管家什么都不会说,用户看到的是「它没记」。现在给一条窄通道:
      //   ① 必须显式点名那条否决条目的 id(拿错 id 照样拒);
      //   ② sourceRef 仍必须是【用户本人这一回合说的话】(上面那道 source_not_user 没有放松);
      //   ③ 不新增条目 —— 走与合并同一条路:保留旧 id、state 回 active、text 取新(与面板的「恢复」同义),
      //      于是否决清单里不会一边留着「用户否决过 X」一边又有一条生效的 X。
      // 「不再【自动】写回」这条拍板没有被推翻:显式点名不是自动。
      // 复活的是甲、这一句却又踩中了被否决的乙 -> 照拦(点名甲不等于连乙一起赦免)。
      if (vetoed && (!revive || revive.id !== vetoed.id)) {
        return { persist: false, result: stewardFail('vetoed_duplicate', `a synonymous memory was vetoed by the user (${vetoed.id}); do not write it back, not even reworded. If the user explicitly asked for it again in this turn, call again with supersedesVetoed:"${vetoed.id}"`, { id: vetoed.id }) };
      }
      const existing = revive || store.entries.find(e => e.state === 'active' && e.kind === kind && stewardTermJaccard(terms, e.text) >= STEWARD_MEMORY_LIMITS.dedupeJaccard);
      // 128h-J12:复活会让生效条数 +1,所以它和「新写一条」一样要过容量闸(合并不加条数,不过)。
      // 漏这一条的话,库满之后复活就成了绕过上限的后门。
      // 2026-10 起这一支真的够得到:读库改成生效条与被否决条各自封顶(13j),200 条生效之外的否决条不再挤掉生效条。
      if (revive && store.entries.filter(e => e.state === 'active').length >= STEWARD_MEMORY_LIMITS.maxEntries) {
        return { persist: false, result: stewardFail('capacity_exceeded', `steward memory is full (${STEWARD_MEMORY_LIMITS.maxEntries} active entries); veto something before writing more`) };
      }
      const at = nowIso();
      if (existing) {
        // 同一条证据重试不增加置信度;行为推断也不能覆盖用户明确确认过的事实。
        const sameEvidence = ref => String(ref.sessionId || ref.sourceSessionId || '') === String(sourceRef.sessionId)
          && Number(ref.turnSeq ?? ref.sourceSeq) === Number(sourceRef.turnSeq)
          && String(ref.toolCallId || ref.sourceToolCallId || '') === String(sourceRef.toolCallId || '');
        if (activity && (existing.basis !== 'activity' || sameEvidence(existing) || (existing.mergedFrom || []).some(sameEvidence))) {
          return { persist: false, result: { ok: true, id: existing.id, merged: true, unchanged: true, basis: existing.basis || 'user' } };
        }
        // 116-2e(§4 ⑥):合并【不新增条目】—— 保留旧 id(引用它的决策日志与提示词行不失效),
        // text 取新(用户最近一次的说法更准),confidence 取两者较大再 +0.1 封顶 1(同一件事被说了
        // 第二遍,置信度只该升不该降),来源 ref 进 mergedFrom(最多 5 个,先进先出)。
        const incomingConfidence = Number.isFinite(Number(args.confidence)) ? Math.min(1, Math.max(0, Number(args.confidence))) : 0.6;
        const wasActivity = existing.basis === 'activity';
        const prevRef = { sessionId: existing.sourceSessionId, turnSeq: existing.sourceSeq, at: existing.updatedAt || existing.createdAt,
          ...(existing.sourceToolCallId ? { toolCallId: existing.sourceToolCallId } : {}) };
        existing.text = text;
        existing.confidence = activity ? Math.min(0.85, existing.confidence + 0.1) : Math.min(1, Math.max(existing.confidence, incomingConfidence) + 0.1);
        if (activity) { existing.basis = 'activity'; existing.sourceToolCallId = String(sourceRef.toolCallId); }
        else { delete existing.basis; delete existing.sourceToolCallId; }
        existing.mergedFrom = [...(Array.isArray(existing.mergedFrom) ? existing.mergedFrom : []), prevRef].slice(-STEWARD_MEMORY_MERGED_FROM_MAX);
        existing.sourceSessionId = String(sourceRef.sessionId || '');
        existing.sourceSeq = Math.max(0, Number(sourceRef.turnSeq) || 0);
        existing.sourceQuote = quoted.quote;
        existing.updatedAt = at;
        // 126-M02 合并时的时效:给了新到期日就用新的;**没给而旧的已经过期,就把到期日清掉** ——
        // 用户又说了一遍,这条事实就是当下有效的。不这么写会留一个陷阱:合并成功、
        // 却因为继承了过去的到期日而仍然不进提示词块(写了等于没写)。
        if (scope) existing.scope = scope; // 126-M01:只有显式说了 project 才改;没说就不动(作用域不会"到期",不该被悄悄改)
        if (expiresAt) existing.expiresAt = expiresAt;
        else if (!activity && wasActivity) existing.expiresAt = '';
        else if (memoryIsExpired(existing)) existing.expiresAt = '';
        // 128h-J12:复活那一支 —— state 回 active、kind 取这一次的(用户重新说了一遍,按这次的类别归),
        // 并把「它曾经被否决过、是谁让它回来的」留在条目上(面板与决策日志都看得见,不是一次静默的翻盘)。
        const revived = existing.state === 'vetoed';
        if (revived) { existing.state = 'active'; existing.kind = kind; existing.revivedFrom = 'vetoed'; }
        // undo 的落点与面板「恢复」同源:撤销这一次复活 = 把它放回 vetoed。普通合并没有状态变化,仍是 null。
        const undoRef = { kind: 'memory', id: existing.id, prev: revived ? 'vetoed' : null };
        stewardAppendDecision({ tool: 'steward_memory_write', args: { kind, chars: text.length, merged: true, ...(revived ? { supersedesVetoed: existing.id } : {}) }, targetSessionId: String(sourceRef.sessionId || ''), permissionMode: '', mayAct: 'auto', undoRef, basis: { memoryIds: [existing.id] } });
        return { persist: true, result: { ok: true, id: existing.id, merged: true, ...(revived ? { revived: true } : {}), undoRef } };
      }
      const activeCount = store.entries.filter(e => e.state === 'active').length;
      if (activeCount >= STEWARD_MEMORY_LIMITS.maxEntries) {
        return { persist: false, result: stewardFail('capacity_exceeded', `steward memory is full (${STEWARD_MEMORY_LIMITS.maxEntries} active entries); veto something before writing more`) };
      }
      const entry = {
        id: makeId('smem'),
        kind,
        text,
        confidence: Number.isFinite(Number(args.confidence)) ? Math.min(activity ? 0.6 : 1, Math.max(0, Number(args.confidence))) : 0.6,
        ...(activity ? { basis: 'activity', sourceToolCallId: String(sourceRef.toolCallId) } : {}),
        sourceSessionId: String(sourceRef.sessionId || ''),
        sourceSeq: Math.max(0, Number(sourceRef.turnSeq) || 0),
        sourceQuote: quoted.quote, // 14:凭哪句用户原话记的(服务端已逐字核对过)
        createdAt: at,
        updatedAt: at,
        lastUsedAt: '',
        useCount: 0,
        state: 'active',
        mergedFrom: [],
        expiresAt, // 126-M02:空串 = 不过期(绝大多数条目就该是空的)
        scope,     // 126-M01:空串 = 全局(绝大多数条目也该是空的)
      };
      store.entries.push(entry);
      const undoRef = { kind: 'memory', id: entry.id, prev: null };
      stewardAppendDecision({ tool: 'steward_memory_write', args: { kind, chars: text.length, merged: false }, targetSessionId: entry.sourceSessionId, permissionMode: '', mayAct: 'auto', undoRef, basis: { memoryIds: [entry.id] } });
      return { persist: true, result: { ok: true, id: entry.id, merged: false, undoRef } };
    });
  }

  // 16) steward_memory_veto
  async function stewardImplMemoryVeto(args) {
    const id = String(args.id || '');
    if (!id) return stewardFail('invalid_request', 'id is required');
    return stewardMutateMemory(async store => {
      const entry = store.entries.find(e => e.id === id);
      if (!entry) return { persist: false, result: stewardFail('not_found', `memory ${stewardSanitizeText(id)} not found`) };
      // 第二轮工具走查(F12):已经是否决状态再否决一次,修前照样回 ok、undoRef.prev 记成 'vetoed'(撤销它等于「还原成否决」,
      // 即什么都没撤)、还多写一行决策日志 —— 行动流水里一件事被记两遍。幂等:不写库、不记决策,如实说「没变」。
      if (entry.state === 'vetoed') return { persist: false, result: { ok: true, id, state: 'vetoed', unchanged: true } };
      const prev = entry.state;
      entry.state = 'vetoed';
      entry.updatedAt = nowIso();
      const undoRef = { kind: 'memory', id, prev };
      stewardAppendDecision({ tool: 'steward_memory_veto', args: { id }, targetSessionId: entry.sourceSessionId, permissionMode: '', mayAct: 'auto', undoRef, basis: { memoryIds: [id] } });
      return { persist: true, result: { ok: true, id, state: 'vetoed', undoRef } };
    });
  }

  // 17) steward_memory_search —— 词法匹配(词项 Jaccard + 子串命中),默认排除 vetoed。
  async function stewardImplMemorySearch(args) {
    const q = String(args.q || '').trim();
    const kind = STEWARD_MEMORY_KINDS.includes(String(args.kind || '')) ? String(args.kind) : '';
    const limit = stewardClampInt(args.limit, 1, STEWARD_MEMORY_LIMITS.searchLimit, 20);
    const includeVetoed = args.includeVetoed === true;
    // 126-M02:过期条目默认**不出现在读取结果里** —— 提示词块(13o)与模型自己的检索都走这一口,
    // 所以「过期就不再被用上」这件事在这一处就够了,不必散到调用方去。
    // 时效是**过滤,不是删除**:条目仍在库里、仍在面板上可见并带「已过期」标(§6 ② 的拍板;
    // 与 116 波「否决条目不换说法复活」同一条理由 —— 删掉的话同一条会被原样重写一遍)。
    // 判据不在本文件:调 06d 的 memoryIsExpired,与工作台库同一口径(44 号文 §1.2)。
    const includeExpired = args.includeExpired === true;
    // 126-M01:可选按作用域筛。**不传就不筛** —— 管家本来就是跨项目的看护者,把项目记忆整个藏掉
    // 是信息损失;真正的错是把它当成全局(那一半由提示词块标出项目名来治,见 13o)。
    const scopeWanted = stewardNormalizeMemoryScope(args && args.scope);
    const nowMs = Date.now();
    const store = await stewardReadMemoryStore();
    const terms = q ? stewardMemoryTerms(q) : null;
    const needle = q.toLowerCase();
    const rows = store.entries
      .filter(e => (includeVetoed || e.state === 'active') && (!kind || e.kind === kind))
      .filter(e => includeExpired || !memoryIsExpired(e, nowMs))
      .filter(e => stewardMemoryScopeMatches(e, scopeWanted))
      .map(e => ({
        entry: e,
        score: terms ? Math.max(stewardTermJaccard(terms, e.text), e.text.toLowerCase().includes(needle) ? 0.9 : 0) : 0,
      }))
      .filter(row => !terms || row.score > 0)
      .sort((a, b) => b.score - a.score || String(b.entry.updatedAt).localeCompare(String(a.entry.updatedAt)))
      .slice(0, limit)
      .map(row => ({ ...row.entry, score: Number(row.score.toFixed(4)) }));
    return { ok: true, query: q, kind: kind || '', total: store.entries.length, entries: rows };
  }

  // 20) steward_missions —— 事项级只读视图(116g / §3.1 / §8.10)。
  // 纪律:装配全部委托 13d 的 buildMissionAggregateRows(与看板 GET /api/missions 逐字节同源),
  // 事项级状态只经 06i 的 aggregateMissionState 纯函数 —— 本文件【不】自己判定任何状态。

  return {
    stewardImplMemorySearch, stewardImplMemoryVeto, stewardImplMemoryWrite, stewardQuoteInSource,
    stewardSourceUserTexts,
  };
}

module.exports = { createStewardMemoryTools };
