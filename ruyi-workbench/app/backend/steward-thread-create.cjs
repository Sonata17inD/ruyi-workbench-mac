'use strict';

function createStewardThreadCreation({
  nowIso, safeSessionId, stewardAppendDecision, stewardBasisOf, stewardFail, stewardTurnKeyOf, stewardTurnQuotaTake, stewardLaunchTurn,
  sessions, workspaces, policy, content, limits,
}) {
  const {
    createSession, listSessions, missionIndexAdd, readMissionContainer, saveSession, sessionMetaIsSteward,
    sessionMissionId, stewardRawKind, stewardReadSessionHead, stewardThreadPermissionMode,
  } = sessions;
  const {
    stewardDeriveThreadCwd, stewardRecordMissionWorkspace, stewardResolveThreadCwd, stewardWorkspaceNameOf,
  } = workspaces;
  const {
    StewardHooks, stewardUnattendedByModel, stewardOpenAiFallback, stewardSanitizeText,
  } = policy;
  const {
    listPlaybooksWithAvailability, buildStewardBrief, stewardAssemblePlaybookPrompt,
    stewardPlaybookMissingInputs,
  } = content;
  const {
    STEWARD_QUICK_KIND, STEWARD_QUICK_QUESTION_CHARS, STEWARD_QUICK_ASKS_PER_TURN, STEWARD_TITLE_MAX,
  } = limits;

  // thread_new 的 missionId 是不是一个真实存在的事项(见调用处的说明)。
  async function stewardMissionExists(stewardMissionIdArg) {
    const missionId = safeSessionId(stewardMissionIdArg);
    if (!missionId) return false;
    if (await readMissionContainer(missionId).catch(() => null)) return true;
    const own = await stewardReadSessionHead(missionId);
    if (own && own.id && stewardRawKind(own) !== 'steward') return true;
    const metas = await listSessions().catch(() => []);
    return metas.some(meta => meta && !sessionMetaIsSteward(meta) && String(meta.missionId || '') === missionId);
  }

  // 10) steward_thread_new —— 委托书。原话逐字在最前,管家补充经中和后进围栏(见 06i buildStewardBrief)。
  // A step list is one DAG owned by one new thread, never cross-thread completion links.
  function stewardDelegationSteps(raw, args, config) {
    if (raw === undefined) return { steps: null };
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 8) return { error: 'steps requires 2–8 ordered steps' };
    if (args.missionId || args.relatedSessionId || args.brief?.playbook) return { error: 'steps requires a new standalone mission, without missionId, relatedSessionId or playbook' };
    const cap = Number(config.subagentMaxPerTurn) || 0;
    if (cap <= 0) return { error: 'agent_delegation_disabled' };
    if (Number(config.agentWorkflowMaxNodes) === 0) return { error: 'agent_workflow_disabled' };
    if (raw.length > cap || (Number(config.agentWorkflowMaxNodes) > 0 && raw.length > Number(config.agentWorkflowMaxNodes))) return { error: 'steps exceeds the configured agent budget' };
    if (!stewardOpenAiFallback(config)) return { error: 'steps requires a configured provider' };
    const steps = [];
    for (const [i, row] of raw.entries()) {
      if (!row || typeof row !== 'object' || typeof row.task !== 'string' || !row.task.trim() || row.task.length > 2000 || !['read', 'edit', 'exec'].includes(row.toolTier || 'read') || Object.keys(row).some(k => !['task', 'toolTier'].includes(k))) return { error: `invalid step ${i + 1}: task (1–2000 chars) and toolTier (read/edit/exec) only` };
      steps.push({ id: 'step-' + (i + 1), task: row.task.trim(), toolTier: row.toolTier || 'read', dependsOn: i ? ['step-' + i] : [], maxRetries: 0 });
    }
    return { steps };
  }
  async function stewardImplThreadNew(args, ctx, config) {
    const brief = (args.brief && typeof args.brief === 'object') ? args.brief : null;
    if (!brief || !String(brief.userText || '').trim()) {
      return stewardFail('invalid_request', 'brief.userText is required and must contain the user\'s own words verbatim');
    }
    // 116-3 P0-2:收件箱触发的「自己新开线程」要用户先在自理清单里留着这一项(§11.1 第 6 项)。
    const delegation = stewardDelegationSteps(args.steps, args, config);
    if (delegation.error) return stewardFail('invalid_request', delegation.error, { reason: 'delegation_unavailable' });
    // 新线程还没有目标线程可判权限,所以这里只有清单这一道闸;新线程自己的权限由全局默认档决定。
    if (stewardUnattendedByModel(ctx)) {
      const auto = (config && config.stewardAutoActions && typeof config.stewardAutoActions === 'object') ? config.stewardAutoActions : {};
      if (auto.newThread === false) {
        return stewardFail('propose_required', '「自己新开线程」已经关掉,无人值守时只能把它作为提议交给用户,不要重试', {
          reason: 'self_serve_off', tool: 'steward_thread_new',
        });
      }
    }
    // ── 129h 跑 playbook(31 号文 §2.7 放①)────────────────────────────────────────────────
    // **有意不新加工具**。「跑一个 playbook」这件事拆开看就是:按模板组装一段话 → 开一条线程去办。
    // 后半截已经在这个函数里了,而且带着全套闸(工作区表、权限档、分档、事项、undoRef、决策账本)。
    // 另起一个 steward_playbook_run 要么把这些重抄一遍,要么转头调这里 —— 两头都不如直接长在这。
    // (§2.7 的原话也是「同一条执行路径,不另写」。)
    const pbAsk = (brief.playbook && typeof brief.playbook === 'object' && !Array.isArray(brief.playbook)) ? brief.playbook : null;
    let pbResolved = null;
    if (pbAsk) {
      const wantId = String(pbAsk.id || '').trim();
      if (!wantId) return stewardFail('invalid_request', 'brief.playbook.id is required');
      // 可用性直接读既有结论(06 的 listPlaybooksWithAvailability,与技能库面板同一份),不另写判据。
      const list = await listPlaybooksWithAvailability(config).catch(() => []);
      const pb = list.find(one => one && one.id === wantId) || null;
      if (!pb) {
        return stewardFail('not_found', `没有叫 "${stewardSanitizeText(wantId)}" 的 playbook —— 先用 steward_playbooks 看一眼有哪些,别猜 id`, {
          reason: 'playbook_not_found',
        });
      }
      // 不可用就别开:缺的是能力(联网/桌面/命令…),开出来的线程第一步就卡住,而用户要等到那时才知道。
      if (pb.available === false) {
        return stewardFail('invalid_request',
          // 字段名是 unavailableReason,**不是** reason(06 的 evalPlaybookAvailability 口径)——
          // 写错的话这里永远吐兜底那句「所需能力没就绪」,用户看不到真原因,而断言还是绿的:
          // 与 129b 那次「字段名写成 description 而非 desc,整列全空」同一个模具。
          `playbook「${stewardSanitizeText(pb.title)}」现在跑不了:${stewardSanitizeText(String(pb.unavailableReason || '所需能力没就绪'))} —— 把这句告诉用户,别开线程`, {
            reason: 'playbook_unavailable', playbookId: pb.id,
            missingCaps: (Array.isArray(pb.missingCaps) ? pb.missingCaps : []).map(c => stewardSanitizeText(String(c || ''))).slice(0, 6),
          });
      }
      // 参数必须齐。比前端严,理由见 06i stewardPlaybookMissingInputs 的头注:
      // 弹窗前面坐着用户,留空是他的选择;管家填空是猜,猜出来的空串会让模板在错的地方动手。
      const missing = stewardPlaybookMissingInputs(pb, pbAsk.inputs);
      if (missing.length) {
        return stewardFail('invalid_request',
          `这个 playbook 还缺 ${missing.length} 个参数没填:${missing.map(m => m.label).join('、')} —— 去问用户要,别自己编`, {
            reason: 'playbook_inputs_missing', playbookId: pb.id, missing,
          });
      }
      pbResolved = { id: pb.id, title: pb.title, text: stewardAssemblePlaybookPrompt(pb, pbAsk.inputs) };
    }
    const composed = buildStewardBrief(pbResolved
      ? { ...brief, playbookId: pbResolved.id, playbookTitle: pbResolved.title, playbookText: pbResolved.text }
      : brief);
    const requestedMissionId = args.missionId ? safeSessionId(args.missionId) : '';
    if (args.missionId && !requestedMissionId) return stewardFail('invalid_request', 'invalid missionId');
    // 第二轮工具走查(F14):missionId 格式合法但【根本没有这个事项】时,修前照样把新线程挂到它名下 —— 凭空造出一个
    // 只有一条线程、没有事项文件的「幽灵事项」(relatedSessionId 同样的错早就返回 not_found 了)。
    // 认三种真事项:有事项容器文件的;就是某条线程自己的 id(未归类事项的 missionId === 线程 id,不是管家会话);
    // 已有线程头上的 missionId 指着它的。都不是 -> not_found,排在 createSession 之前(拒的是「开线程」,不是开完再回滚)。
    if (requestedMissionId && !await stewardMissionExists(requestedMissionId)) {
      return stewardFail('not_found', `missionId ${requestedMissionId} 不是一个已有的事项(没有这个事项,也没有这条线程);不确定就省掉 missionId 让新线程自成事项,不要重试同一个值`, { reason: 'mission_not_found' });
    }
    // W7:cwd 选择顺序(见文件头 stewardResolveThreadCwd):明确给的 > 事项记着的 > 相关线程的 > 新开。
    // 给了但不合法(已知工作区之外的 cwd、不存在的 relatedSessionId)一律拒,不静默回落;排在 createSession
    // 之前:拒的是「开线程」,不是「开完再回滚」。
    const cwdPick = await stewardResolveThreadCwd(args, config, requestedMissionId);
    if (!cwdPick.ok) return cwdPick.fail;

    const session = await createSession({
      title: args.title ? String(args.title).slice(0, STEWARD_TITLE_MAX) : undefined,
      cwd: cwdPick.cwd,
      // 121-K3(§4.1 来源三值):出身在 createSession 那一次写死。与下面的 createdBy 是两个字段、
      // 一个事实的两面 —— createdBy 是权限判据(桌面权限只开给管家自己开的线程),origin 是展示与
      // 索引口径(界面上的来源图形)。不合并成一个:前者是布尔语义的闸,后者要三值。
      origin: 'steward',
    });
    // 选择顺序第 ④ 步:在 Ruyi 根下派生子工作区,登记进如意自己那张表(不进常用工作区)。写在 createSession
    // 之后是为了拿到真线程 id(标题为空时 slug 要回落到它),改的是内存副本,跟着下面那一次 saveSession
    // 一起落盘,零额外写。派生不成(根不可用/撞名试满/写失败)就保持 createSession 刚落的回落值。
    let cwdSource = cwdPick.source;
    if (cwdPick.cwd === undefined) {
      const derivedCwd = await stewardDeriveThreadCwd(args.title, session.id, config);
      if (derivedCwd) session.cwd = derivedCwd;
      else cwdSource = 'default';
    }
    if (cwdPick.relatedSessionId) session.relatedSessionId = cwdPick.relatedSessionId;
    if (delegation.steps) delegation.steps = delegation.steps.map(step => ({ ...step, resources: [(step.toolTier === 'read' ? 'read:' : '') + 'workspace:' + session.cwd] }));
    session.kind = 'mission';                                   // 线程 = 任务线程(不是速问)
    session.launchedBy = 'steward';                             // 116-4:收件箱第四源的「管家关心」标
    // 117z-E2 提交①(27 号文 §11.21.3):【出身】标 —— 这条线程是管家自己开的。
    // 为什么不复用既有的两个标:`launchedBy:'steward'` 也会打在 thread_continue 递话进【用户自己的】
    // 会话那一路(见本文件 stewardMarkLaunched),`titleSource:'steward'` 语义是标题来源、quick_ask 还
    // 会删掉它 —— 两个都答不出「这条线程是谁开的」。放宽桌面权限的目标合法性判据(13k 的
    // stewardImplThreadPermission)只读这一个字段;它只在这里与 quick_ask 各写一次,此后终身不变,
    // 也【不在】 02 的 applySessionMetaPatch 白名单里(PATCH 改不动它,见那里的注释)。
    session.createdBy = 'steward';
    // 117s-A D2(§11.13 ⑤a):管家给的 title【不是】人起的名字(模型只是把用户那句话抄了一遍),
    // 覆写掉 createSession 刚写下的 'user',否则 116-5 的自动摘要永远跳过 —— 白名单与理由见 02:1066。
    if (args.title) session.titleSource = 'steward';
    if (requestedMissionId) session.missionId = requestedMissionId; // 归入既有事项;否则 createSession 已置 missionId = 自身 id
    // 委托书落盘:原话与管家补充【分开存】,供 117 显示与用户「改一下」;不把拼好的整段存成一坨。
    session.brief = {
      schema: 1,
      by: 'steward',
      createdAt: nowIso(),
      userText: composed.userText,
      supplement: composed.supplement,
      // 132a:分字段版本(goal/acceptance/context/preferences/constraints,已裁剪),委托书带按它画列表;老线程没有它就回落 supplement。
      fields: composed.fields,
      truncated: composed.truncated,
      memoryIds: composed.memoryIds,
      // 129h:真跑了 playbook 时,这一格记【跑的那一个】。修前它只记 brief.playbookId ——
      // 那个字段的老语义是「建议线程参考的 id」(一行文字,没人加载它);现在两种来源都落到同一格,
      // 界面与事后对账不必分辨是「参考过」还是「跑过」的 id —— 真跑过的那一次另有决策账本作证。
      playbookId: pbResolved ? pbResolved.id : String(brief.playbookId || ''),
      ...(delegation.steps ? { steps: delegation.steps } : {}),
    };
    // 117l D7:按任务复杂度选档(缺省 strong)—— 写在 saveSession 之前,跟着同一次落盘走,零额外写。
    const tiered = StewardHooks.applyThreadTier(session, args.tier, config);
    await saveSession(session);
    // 116g:显式指定了事项就写反向索引(事项文件不存在 = 「未归类」,missionIndexAdd 自身 no-op ——
    // 新会话的 missionId === sessionId 那条常规路径永远不会凭空建出一个事项文件)。
    if (requestedMissionId) await missionIndexAdd(requestedMissionId, session.id);
    // W7:事项第一次有了工作区就记进事项容器(之后这个事项里开的线程走选择顺序第 ② 步)。
    // 回落到默认工作区的那一次不记 —— 那不是谁选的,是派生失败的兜底。
    if (requestedMissionId && cwdSource !== 'default') await stewardRecordMissionWorkspace(requestedMissionId, session.cwd);

    const launched = stewardLaunchTurn({
      sessionId: session.id,
      message: composed.text,
      cwd: session.cwd,
      source: 'steward',
      requestMeta: { tool: 'steward_thread_new' },
      ...(delegation.steps ? { delegationPlan: { nodes: delegation.steps, context: composed.text } } : {}),
    }, 'steward_thread_new');

    // 117d 第 0 步:回退锚点。undoRef.sessionId 是「删掉这条线程」的把手,但整单回退要的是
    // 【被递那一回合将拥有的 seq】—— 与 09-workflow 的 plannedTurnSeq 同口径(session.turnSeq + 1);
    // 新建会话 turnSeq 恒为 0,故委托书是第 1 回合。rewindSession 按这个 seq 定位首条用户消息。
    const registration = await launched.registration;
    const undoRef = registration ? { kind: 'thread_new', sessionId: session.id, ...registration } : { kind: 'none', sessionId: session.id };
    stewardAppendDecision({
      tool: 'steward_thread_new',
      args: {
        title: session.title, missionId: session.missionId, briefChars: composed.text.length,
        supplementChars: composed.supplement.length, truncated: composed.truncated, tier: tiered.tier,
        // W7:目录是怎么选出来的(explicit/mission/related/mission_thread/new/default)——行动流水事后
        // 答得出「为什么这条线程开在这儿」。只记来源不记全路径(决策日志也进管家的上下文)。
        cwdSource,
        ...(delegation.steps ? { steps: delegation.steps.length } : {}),
        // 129h:跑过 playbook 的那一次,行动流水要看得出来是【哪一个】、正文有多长 ——
        // 「管家自己起了一条线程」与「管家按你存下的那个流程起了一条线程」是两件事。
        ...(pbResolved ? { playbookId: pbResolved.id, playbookChars: pbResolved.text.length } : {}),
      },
      targetSessionId: session.id,
      permissionMode: stewardThreadPermissionMode(session, config),
      mayAct: 'auto',
      undoRef,
      basis: { memoryIds: composed.memoryIds, ...(pbResolved ? { playbookId: pbResolved.id } : {}) },
    });
    return {
      ok: true, sessionId: session.id, missionId: sessionMissionId(session), title: session.title,
      // W7:开在哪个工作区(名字,不给全路径)、为什么开在那儿。
      workspace: (stewardWorkspaceNameOf(session.cwd, config) || { name: '' }).name, cwdSource,
      briefTruncated: composed.truncated, tier: tiered.tier, engine: tiered.engine, undoRef,
      ...(delegation.steps ? { delegation: { kind: 'ordered_steps', steps: delegation.steps, coordinatorSessionId: session.id, status: 'accepted' } } : {}),
      ...(pbResolved ? { playbook: { id: pbResolved.id, title: pbResolved.title, chars: pbResolved.text.length } } : {}),
    };
  }

  // 24) steward_quick_ask —— 速查线程(§11.1 第 2 项)。
  //     何时用:要读文件、联网或动手才能答的问题。何时别用:关于如意、事项、费用、设置的问题 —— 那些
  //     管家自己就知道,开一条线程去问等于让用户白等一次回合。
  //     不进任何事项;权限用新线程默认权限(即全局 permissionMode),照常受 116h 仲裁;答完自动收工。
  async function stewardImplQuickAsk(args, ctx, config) {
    // 第二轮工具走查(F14):question 是【用户的话】,与 thread_new 的 brief.userText 同一待遇 —— 逐字递进线程。
    // 修前过 stewardSanitizeText:`List<String>`、`a<b` 里的尖括号被换成全角 ＜＞,换行折成空格,线程收到的已经不是用户写的那句
    // (问代码泛型/不等式的速查全被改了意思)。中和是为了防【管家自己提示词里】的围栏标记被冒充,而这句话进的是线程的
    // 首条用户消息,不是管家提示词;只有管家自己写的补充才需要中和(buildStewardBrief 的 supplement)。
    // 返回给管家的回显与线程标题仍走 stewardSanitizeText(单行、中和),它们是给管家/看板读的展示面。
    const question = String(args.question == null ? '' : args.question).trim();
    if (!question) return stewardFail('invalid_request', 'question is required');
    if (question.length > STEWARD_QUICK_QUESTION_CHARS) {
      return stewardFail('invalid_request', `question must be at most ${STEWARD_QUICK_QUESTION_CHARS} characters`);
    }
    // W7:与 thread_new 共用同一条 cwd 选择顺序(见文件头 stewardResolveThreadCwd;速查线程不进事项,
    // 所以没有事项那两步)。排在配额之前:参数不合法不该烧掉本回合的速查名额。
    const quickCwdPick = await stewardResolveThreadCwd(args, config, '');
    if (!quickCwdPick.ok) return quickCwdPick.fail;
    if (!stewardTurnQuotaTake('quick_ask', ctx, STEWARD_QUICK_ASKS_PER_TURN)) {
      return stewardFail('quota_exceeded', `at most ${STEWARD_QUICK_ASKS_PER_TURN} quick-ask threads per steward turn; do not retry - answer with what you already know or tell the user`);
    }
    const session = await createSession({
      title: stewardSanitizeText(question).slice(0, STEWARD_TITLE_MAX),
      cwd: quickCwdPick.cwd,
      origin: 'steward',   // 121-K3:速查线程也是管家开的(与 thread_new 同一口径,见那里的注释)
    });
    // 选择顺序第 ④ 步:与 thread_new 同一口径。速查线程的「标题」就是问题原话的前 N 个字,slug 自己会
    // 截到 64;答完就收工的线程也照样给它一个自己的目录(它可能下载了东西)—— 登记在如意自己那张表里,
    // 不进用户的常用工作区。
    let quickCwdSource = quickCwdPick.source;
    if (quickCwdPick.cwd === undefined) {
      const quickDerivedCwd = await stewardDeriveThreadCwd(question, session.id, config);
      if (quickDerivedCwd) session.cwd = quickDerivedCwd;
      else quickCwdSource = 'default';
    }
    if (quickCwdPick.relatedSessionId) session.relatedSessionId = quickCwdPick.relatedSessionId;
    session.kind = STEWARD_QUICK_KIND;
    // 116-5a:速查线程建出来时 title 是【问题原话的前 N 个字】,那不是「人给的名字」而恰恰是本波要
    // 替换掉的东西。createSession 会因为它非占位而标上 titleSource:'user',这里清掉 —— 否则这条线程
    // 永远拿不到自动摘要。thread_new 那边不清:args.title 是管家【有意】起的名字,与改名同一性质。
    delete session.titleSource;
    // 116-4:管家关心的会话的三个机器痕迹之一(另两个是 stewardQuick、线程在别人的事项里)。
    // 在这里就地写进内存副本,跟着下面那次 saveSession 一起落盘 —— 零额外写。
    session.launchedBy = 'steward';
    // 117z-E2 提交①(§11.21.3):出身标,与 thread_new 那处同一个字段、同一条纪律(见那里的注释)。
    // 速查线程也算「管家自己开的」—— 它确实是 steward_quick_ask 建出来的,与 titleSource 被删掉那件事
    // 无关(那删的是「标题是谁给的」,不是「线程是谁开的」)。
    session.createdBy = 'steward';
    // 速查线程【不进事项】:missionId 指回自己(createSession 的缺省),不写任何反向索引,
    // GET /api/missions 里它就是一条「未归类」的派生行,不占任何事项的验收与预算。
    session.stewardQuick = {
      schema: 1,
      askedAt: nowIso(),
      question,
      stewardTurnKey: String(stewardTurnKeyOf(ctx)),
      closedAt: null,
    };
    // 117l D7:速查线程恒走 fast 档 —— 它定义上就是「查一下」,没有理由烧强模型(没配 fast 档就跟随全局)。
    const quickTier = StewardHooks.applyThreadTier(session, 'fast', config);
    await saveSession(session);

    const launched = stewardLaunchTurn({
      sessionId: session.id,
      message: question,
      cwd: session.cwd,
      source: 'steward',
      requestMeta: { tool: 'steward_quick_ask' },
    }, 'steward_quick_ask');

    // 117e 第 0 步:与 117d-0 的 thread_new / thread_continue 同口径 —— 撤回锚点显式化。
    // rewindSession 按「要删的那一回合的第一条用户消息」定位(09 的 plannedTurnSeq = turnSeq + 1),
    // 按 `turnSeq` 字面传会得 target turn not found。新建会话的 turnSeq 恒为 0,这里仍按字段读,
    // 与上面那两处逐字同形(将来 createSession 若带出非零 seq 也不会错)。
    const registration = await launched.registration;
    const undoRef = registration ? { kind: 'thread_new', sessionId: session.id, ...registration } : { kind: 'none', sessionId: session.id };
    stewardAppendDecision({
      tool: 'steward_quick_ask',
      args: { chars: question.length, tier: quickTier.tier, cwdSource: quickCwdSource },
      targetSessionId: session.id,
      permissionMode: stewardThreadPermissionMode(session, config),
      mayAct: 'auto',
      undoRef,
      basis: stewardBasisOf(args),
    });
    return {
      ok: true, sessionId: session.id, kind: STEWARD_QUICK_KIND, question: stewardSanitizeText(question), tier: quickTier.tier, engine: quickTier.engine, undoRef,
      workspace: (stewardWorkspaceNameOf(session.cwd, config) || { name: '' }).name, cwdSource: quickCwdSource,   // W7:同 thread_new
    };
  }

  return { stewardImplThreadNew, stewardImplQuickAsk };
}

module.exports = { createStewardThreadCreation };
