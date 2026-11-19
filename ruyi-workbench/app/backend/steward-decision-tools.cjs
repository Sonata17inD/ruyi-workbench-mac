'use strict';
const fsp = require('node:fs/promises');

function createStewardDecisionTools({
  makeId, safeJsonParse, safeSessionId, stewardAppendDecision, stewardBasisOf, stewardFail,
  runs, sessions, admission, pending, exemptions, guardrails, limits,
}) {
  const { AgentRecovery, agentRunActionCommand, agentRunFile } = runs;
  const {
    decideIntervention, readInterventions, stewardReadSessionHead, stewardRawKind,
    stewardThreadPermissionMode, threadOriginOf,
  } = sessions;
  const {
    stewardMayAct, stewardPermissionLabel, stewardPermissionRank, stewardSeatedByUser, stewardSeatedFail,
    stewardStoppedRefusal, stewardStoppedTarget, stewardTurnTaintedBy, stewardUserDirected,
    stewardWatchedThread, stewardSanitizeText,
  } = admission;
  const {
    stewardExemptDelegatedLog, stewardExemptLiveTurn, stewardExemptPendingSummary,
    stewardLiveTurnPermissionMode,
  } = pending;
  const {
    stewardExemptDelegationRecord, stewardExemptDelegationVerdict, stewardExemptDelegationsInWindow,
    stewardExemptHits, stewardExemptReason, stewardExemptRiskNote, stewardExemptScanInput,
  } = exemptions;
  const {
    httpRequestInternalTargetReason, stewardAutoAskIndirect, stewardAutoAskScanIncomplete,
    stewardAutoAskSensitiveKind, webPayloadReason,
  } = guardrails;
  const { STEWARD_EXEMPT_CATEGORY_LABELS, STEWARD_STEER_TEXT_MAX } = limits;

  // ════════════════════════════════════════════════════════════════════════════
  // 决策族(tier exec)—— 替用户答复待决 / 控制班组。放行范围一律经 stewardMayAct + 永久豁免。
  // ════════════════════════════════════════════════════════════════════════════

  // 13) steward_decide。判定顺序(顺序即安全):
  //     读待决 -> 永久豁免正则 -> stewardMayAct(目标线程权限) -> 才真正 decideIntervention。
  //     前两道拦下的一律【不落决策日志】—— 没做决定就没有决定可记(只记「做过什么」,不记「想做什么」)。
  // 2026-10(用户拍板「管家常常只说留给你、不表态 —— 加强」):管家【表过态】的待决。收件箱回合收尾时(13q)拿它判
  // 「这一条管家有没有经手」:调过 steward_decide(不论放行、拒绝,还是被工具挡回 propose_required)就算经手,
  // 不再追问。只在内存、有界(老的先丢),重启即空 —— 与 13q 那张「已经追问过」的表同一立场。
  const STEWARD_DECIDE_ATTEMPTS_MAX = 512;
  const stewardDecideAttempts = new Set();
  function stewardNoteDecideAttempt(interventionId) {
    const id = String(interventionId || '');
    if (!id) return;
    stewardDecideAttempts.delete(id);
    stewardDecideAttempts.add(id);
    while (stewardDecideAttempts.size > STEWARD_DECIDE_ATTEMPTS_MAX) stewardDecideAttempts.delete(stewardDecideAttempts.values().next().value);
  }
  function stewardDecideAttempted(interventionId) {
    return stewardDecideAttempts.has(String(interventionId || ''));
  }

  async function stewardImplDecide(args, ctx, config) {
    const missionId = safeSessionId(args.missionId);
    const interventionId = String(args.interventionId || '');
    const action = String(args.action || '');
    if (!missionId || !interventionId || !action) return stewardFail('invalid_request', 'missionId, interventionId and action are required');
    stewardNoteDecideAttempt(interventionId);
    const head = await stewardReadSessionHead(missionId);
    if (!head || !head.id) return stewardFail('not_found', 'mission or intervention not found');
    const current = (await readInterventions(missionId).catch(() => [])).find(iv => iv && String(iv.id) === interventionId);
    if (!current) return stewardFail('not_found', 'mission or intervention not found');
    // 121-K3(34 号文 §4.5「管家对你正坐着的线程」):【代答路径】。用户就坐在这条线程前面时,那道提问
    // 是当着他的面弹出来的 —— 管家替他按下去,是在抢他手里的鼠标。判据与 13k 两处工具门同一份
    // (stewardSeatedByUser,13k -> 13l 是后向边),拒绝信封也同一个形状。
    // 注意这道门【只挡代答】:steward_thread_read 不过门(用户问「那条在干嘛」时管家还得答得上来)。
    if (stewardSeatedByUser(missionId)) return stewardSeatedFail(missionId);

    const type = String(current.type || '');
    const toolName = String(current.toolName || '');
    const tier = String(current.tier || '');
    const permissionMode = stewardThreadPermissionMode(head, config);

    // §3.3 永久豁免:命中即降级为提议,任何权限档都不放行 —— 这类动作没有 checkpoint 可回滚。
    // 116-3 P0-1:read/edit 档只看工具名(那两档本来就不碰系统面);其余(exec 与档位缺失)连
    // 命令文本一起看 —— `Bash`/`PowerShell`/`run_command` 这类通用执行工具的名字什么关键词都不含,
    // 只看名字等于对 `rm -rf` / `winget uninstall` / `curl -X POST` / `git push` 完全不设防。
    // 信封要说清楚「因为哪一条被降级」:① 工具名本身就在清单里;② 名字看不出来,但命令文本命中了那五类动作;
    // ③ 结构化入参里是写型网络请求。
    // 127 波 2-bis ③(45 号文 §2-bis):以前两问分开调布尔判据,只说得出「命中了清单」—— 用户真机上管家只能答
    // 「命令原文我这边看不到」,讲不出是哪条规则咬的。现在一次问 06i 的 stewardExemptReason(布尔判据
    // stewardToolPermanentlyExempt 就是由它派生的,同一个单点):【哪一类】进 message(人话,「删数据」之类)
    // 与 exemptCategory(机器键);exemptBy 如实三分 —— 117m-A3 那道结构化对外写以前被并进 command_text
    // 报,可它根本不是命令文本。
    // 127 波 2-quater B1 ③:tier 口径搬进 06i 的 stewardExemptScanInput(13k 的收件箱摘录读同一个函数),行为逐字不变。
    const exemptInput = stewardExemptScanInput(tier, current.input);
    const exemptHit = stewardExemptReason(toolName, exemptInput);
    // 127 波 2-quater B2(45 号文 §2-quater.2 B2):豁免命中不再是「一律提议」,而是先过十道代批闸
    // (06i stewardExemptDelegationVerdict,顺序即判定顺序)。任何一道不过 → 与修前【同形】的 propose_required
    // (message 与既有 details 逐字不变),details 只多 delegable:false 与 blockedBy(闸 8 拦下时再多一个 taintBy)。
    // 全过 → delegation 非空,落到下面同一条 decideIntervention 路径(B1 的 updatedInput/scope 剥离照旧生效)。
    // 事实来源逐条:
    //   闸 1 开关   —— config.stewardExemptDelegationV1(forbidden 档,管家自己改不了);
    //   闸 2 档位   —— 13k stewardExemptLiveTurn 读活回合登记表上的实效档,【不是】上面那个 permissionMode(会话头);
    //   闸 3 看管   —— 会话头:显式 stewardWatch:false 才拦(2026-10 起;watched / origin 照喂、不再参与判定);
    //   闸 4/5      —— stewardExemptHits 的全部命中(不看首中)、scannedFully / textLength 与【交给管家那段摘录的长度】;
    //   闸 6/7      —— 107-S1:同一份 stewardExemptHits 里的 indirect / absoluteDeleteTarget 两个形状标记;
    //   闸 8 污染   —— 13k stewardExemptLiveTurn(活回合段表 + 粘性污染位;判不出算污染);
    //   闸 9 理由   —— args.riskNote 经 06i stewardExemptRiskNote 中和截断;
    //   闸 10 窗口  —— 13j 的滚动一小时计数。
    // 不读 ctx.userPressed:用户按下管家给的按钮(/api/steward/act)与模型直调走同一套闸 —— 永久豁免那一格
    // 从来不因为「用户点了一下管家的按钮」而放宽(06i 契约;用户要亲自批,在线程里按)。
    // 第二轮工具走查(F13):拒绝类(deny / reject)是【收紧类】动作 —— 与 steward_run_action 的 pause/stop、steward_thread_stop
    // 同一条理由:它只会让事情【少】发生。修前 deny 与 allow 过一模一样的闸:命中永久豁免(rm -rf / git push 这类本该最想拒的)
    // 反而被 propose_required 挡下「必须用户亲自决定」,线程权限档不够(每步都问 / 只做计划)同样被挡 —— 越危险越拒不了。
    // 现在拒绝类跳过永久豁免 / 代批十道闸与权限档判定(目标待决存在、没有被用户当面坐着,这两道前置闸仍在);
    // 放行类(allow / approve / answer)一个字不松。决策日志照常记,mayAct 如实写 'auto'。
    const refusing = action === 'deny' || action === 'reject';
    // 2026-10:命令是拼出来 / 编码出来 / 求值出来的(06i stewardAutoAskIndirect,智能自动正是因为它才停下来问):
    // 不在五类豁免里,但管家同样判不出它真正要跑什么 —— 放行类一律交回用户,拒绝类照常可以。
    if (type === 'permission' && !exemptHit && !refusing && stewardAutoAskIndirect(exemptInput)) {
      return stewardFail('propose_required', `工具 ${stewardSanitizeText(toolName)} 这次要执行的命令是拼接、编码或求值出来的,看不出真正要跑什么 —— 这一条必须你亲自决定`, {
        reason: 'indirect_command', missionId, interventionId, type, toolName, tier, permissionMode,
        delegable: false, blockedBy: 'indirect_command',
      });
    }
    // 3.0 收口走查(第四波):命令超出扫描窗口 / 嵌套过深(06i stewardAutoAskScanIncomplete —— 智能自动档正是因为它才停下来问)。
    // 修前非豁免分支只认窗口里的文本:命令前垫 4000 个空格,窗口外的 git push / rm -rf / curl 在这里判成「五类都没命中」、豁免十道闸
    // 整段不进、交给管家的摘录也是空的 —— 管家可以替你批一条它根本没看全的命令。窗口之后没人看过不等于安全:放行类一律交回用户,拒绝类照常可以。
    if (type === 'permission' && !exemptHit && !refusing && stewardAutoAskScanIncomplete(toolName, exemptInput)) {
      return stewardFail('propose_required', `工具 ${stewardSanitizeText(toolName)} 这次要执行的命令太长或嵌套太深,我没能看全它真正要做什么 —— 这一条必须你亲自决定`, {
        reason: 'scan_incomplete', missionId, interventionId, type, toolName, tier, permissionMode,
        delegable: false, blockedBy: 'scan_incomplete',
      });
    }
    // 安全走查 S2:命令里有网络外发 / 读数据根密钥文件(06i stewardAutoAskSensitiveKind,智能自动正是因为它才停下来问):不在五类豁免里,
    // 但「外发什么、读了什么」管家同样判不出 —— 放行类一律交回用户,拒绝类照常可以。
    if (type === 'permission' && !exemptHit && !refusing) {
      const sensitiveKind = stewardAutoAskSensitiveKind(toolName, exemptInput);
      if (sensitiveKind) {
        return stewardFail('propose_required', `工具 ${stewardSanitizeText(toolName)} 这次要执行的命令会${sensitiveKind === 'dataroot' ? '读取如意数据目录里的密钥 / 状态文件' : '访问外部网络'},可能在外传数据 —— 这一条必须你亲自决定`, {
          reason: sensitiveKind === 'dataroot' ? 'dataroot_read' : 'network_egress', missionId, interventionId, type, toolName, tier, permissionMode,
          delegable: false, blockedBy: sensitiveKind === 'dataroot' ? 'dataroot_read' : 'network_egress',
        });
      }
    }
    // 3.0 收口走查(第四波):http_request 打回环 / 内网 / 元数据地址(07 httpRequestInternalTargetReason,智能自动正是因为它才停下来问)——
    // 本机其它服务与如意自己的接口都在这一类里,管家同样不替用户批,放行类一律交回用户。
    if (type === 'permission' && !refusing && httpRequestInternalTargetReason(toolName, current.input)) {
      return stewardFail('propose_required', `工具 ${stewardSanitizeText(toolName)} 这次要访问本机或内网地址 —— 这一条必须你亲自决定`, {
        reason: 'internal_target', missionId, interventionId, type, toolName, tier, permissionMode,
        delegable: false, blockedBy: 'internal_target',
      });
    }
    // 安全走查 S1:联网请求带疑似载荷(超长查询串 / 编码串,07 webPayloadReason)—— 它是「可能在外传数据」的那一问,管家同样不替用户批,放行类一律交回用户。
    if (type === 'permission' && !refusing && webPayloadReason(toolName, current.input)) {
      return stewardFail('propose_required', `工具 ${stewardSanitizeText(toolName)} 这次的网址 / 查询带了大段数据,可能是在往外传内容 —— 这一条必须你亲自决定`, {
        reason: 'web_payload', missionId, interventionId, type, toolName, tier, permissionMode,
        delegable: false, blockedBy: 'web_payload',
      });
    }
    let delegation = null;
    if (type === 'permission' && exemptHit && !refusing) {
      const safeTool = stewardSanitizeText(toolName);
      const categoryLabel = exemptHit.category ? (STEWARD_EXEMPT_CATEGORY_LABELS[exemptHit.category] || exemptHit.category) : '';
      const because = exemptHit.by === 'tool_name'
        ? `工具 ${safeTool} 属于永久豁免清单`
        : (exemptHit.by === 'structured_write'
          ? `工具 ${safeTool} 这次是写型网络请求,命中了永久豁免清单的「${categoryLabel}」类`
          : `工具 ${safeTool} 这次要执行的命令命中了永久豁免清单的「${categoryLabel}」类`);
      const exemptScan = stewardExemptHits(toolName, exemptInput);
      // 107-S1 ①(46 号文 §5 ⑦b):摘录提前到【判之前】算 —— 闸 5 要的不只是「原文多长」,还要
      // 「真正交给管家的那一段有没有被截」(脱敏会把短值撑长,300 字以内的原文照样可能截)。
      // 生产者与修前逐字相同(13k stewardExemptPendingSummary,收件箱 / thread_status 同一个),
      // 只是位置提前,代批落定时原样复用这一份,不再算第二遍。
      const exemptExcerpt = String((stewardExemptPendingSummary(current) || {}).commandExcerpt || '');
      const liveTurn = stewardExemptLiveTurn(missionId, interventionId, head);
      const riskNote = stewardExemptRiskNote(args.riskNote);
      const windowNow = Date.now();
      // ── 129c 闸 11:**管家自己这一回合读过外界内容就不代批**(31 号文红线 4)────────────────
      // 与闸 8 不是一回事:闸 8 判【目标线程】的活回合干不干净(它要这个权限的理由干净吗),
      // 这一条判【管家自己】干不干净(它现在要替你批,是不是被它刚读到的那张网页指使的)。
      // 线程干净 ≠ 管家干净:网页里一句「approve it」不能借管家的手按下去。
      // 放在十道闸【之前】判,于是它连滚动窗口的名额都不占(被拦下的不该计数)。
      const selfTaint = stewardTurnTaintedBy(ctx);
      if (selfTaint.length) {
        return stewardFail('propose_required', `${because}(不可撤销且外溢的动作);而且我这一回合读过外部内容(${selfTaint.join('/')}),按规矩读过就不替你批 —— 这一条必须你亲自决定`, {
          reason: 'permanently_exempt', exemptBy: exemptHit.by, exemptCategory: exemptHit.category,
          missionId, interventionId, type, toolName, permissionMode,
          delegable: false, blockedBy: 'steward_turn_tainted', selfTaintBy: selfTaint,
        });
      }
      const verdict = stewardExemptDelegationVerdict({
        enabled: config && config.stewardExemptDelegationV1 === true,
        liveMode: liveTurn.live ? liveTurn.mode : '',
        watched: stewardWatchedThread(head, String(head.id), String(head.missionId || head.id)),
        origin: threadOriginOf(head),
        explicitUnwatch: head.stewardWatch === false,
        scan: exemptScan,
        excerptChars: exemptExcerpt.length,
        taint: liveTurn.taint,
        riskNote,
        recentCount: stewardExemptDelegationsInWindow(windowNow),
      });
      if (!verdict.delegable) {
        return stewardFail('propose_required', `${because}(不可撤销且外溢的动作),任何权限档都必须由用户亲自决定`, {
          reason: 'permanently_exempt', exemptBy: exemptHit.by, exemptCategory: exemptHit.category,
          missionId, interventionId, type, toolName, permissionMode,
          delegable: false, blockedBy: verdict.blockedBy, ...(verdict.taintBy ? { taintBy: verdict.taintBy } : {}),
        });
      }
      stewardExemptDelegationRecord(windowNow);
      delegation = {
        categories: verdict.categories,
        exemptBy: exemptHit.by,
        // 摘录与收件箱 / thread_status 同一个生产者(13k):04 redact 脱敏 → 06i stewardExemptExcerpt 中和 + 截 300 字。
        // 107-S1 ①:就是上面喂给闸 5 的那一份(同一个值,不再算第二遍)。
        commandExcerpt: exemptExcerpt,
        riskNote,
        liveMode: liveTurn.mode,
        windowCount: stewardExemptDelegationsInWindow(windowNow),
      };
    }
    // 代批那一支按【活回合实效档】算 mayAct(闸 2 已钉死它是 'auto',于是恒为 'auto'):会话头档位与回合实效档
    // 可以不一致 —— 会话头 auto、回合 default 已被闸 2 拦下;反过来会话头 default、回合按请求级 auto 在跑
    // (定时任务的 autonomy.permissionMode),线程此刻确实是「智能自动」,拿会话头去判会把一条合规的代批说成
    // 「档位不够」。非代批的待决口径一个字不变。
    // 审计 E:非代批那一支修前只看会话头 / 全局档。全局 auto、会话头没设档,而定时任务按 autonomy.permissionMode
    // 'default'(或交办卡把这一单收紧到 plan/default)在跑时,管家拿「auto」去判 → 替用户批掉了回合自己该问人的那一步。
    // 现在取【会话头档与活回合实效档中更紧的那一个】(只收不放:活回合档更宽时仍按会话头判,口径与修前一致);
    // 定时任务开出来的线程读不到活回合档(回合已结束 / 引擎登记表不带档)时按 default 算 —— 天花板语义见 13s。
    const liveActMode = stewardLiveTurnPermissionMode(missionId);
    let actMode = permissionMode;
    if (liveActMode && stewardPermissionRank(liveActMode) >= 0 && stewardPermissionRank(liveActMode) < stewardPermissionRank(actMode)) actMode = liveActMode;
    if (!liveActMode && threadOriginOf(head) === 'schedule' && stewardPermissionRank(actMode) > stewardPermissionRank('default')) actMode = 'default';
    const mayAct = refusing ? 'auto' : stewardMayAct(delegation ? delegation.liveMode : actMode, type === 'permission' ? 'permission' : type, tier);
    if (mayAct !== 'auto') {
      return stewardFail('propose_required', `目标线程的权限档为「${stewardPermissionLabel(delegation ? permissionMode : actMode)}」,这类待决只能由用户决定;把它作为提议交给用户,不要重试`, {
        reason: 'permission_mode', missionId, interventionId, type, toolName, tier, permissionMode,
        ...(!delegation && actMode !== permissionMode ? { effectivePermissionMode: actMode } : {}),
      });
    }

    const expectedVersion = Number.isInteger(args.expectedVersion) && args.expectedVersion >= 0
      ? args.expectedVersion
      : Math.max(0, Number(current.interventionVersion) || 0);
    // 127 波 2-quater B1 ①(45 号文 §2-quater.1 取证 2「批 A、跑 B」):管家发起的 permission 决定一律剥掉
    // updatedInput 与 scope。修前 payload 原样透传,核心层接受 updatedInput(13d decideIntervention),原生回合
    // 拿到就 `args = decision.updatedInput` 直接执行、不再过一遍豁免判据 —— 而上面那道豁免判据看的是【待决里存的
    // 原 input】。会话头档位与回合实效档位错位时(定时任务 / 请求级 permissionMode),管家就能「批准 npm test」而
    // 实际跑 `git push --force`。scope:'session' 同理:一次放行被升格成整条会话的放行,那也不是这一条待决的内容。
    // 管家能做的只有「按线程原样放行 / 拒绝」;要改命令,只能让线程自己重新发起、重新过闸。
    // 这里是管家决定进核心的【唯一】入口:模型直调工具、回合结构化 actions(13p)、用户按下管家给的按钮
    // (/api/steward/act,13q)三条路都经 StewardHooks.decide 落到本函数。用户自己在线程里点「允许」走的是
    // 13d 的干预路由,不经这里,updatedInput 照旧可用。
    const rawPayload = (args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)) ? args.payload : {};
    const ignoredPayloadKeys = type === 'permission' ? ['updatedInput', 'scope'].filter(key => Object.prototype.hasOwnProperty.call(rawPayload, key)) : [];
    const decisionPayload = { action, ...rawPayload };
    for (const key of ignoredPayloadKeys) delete decisionPayload[key];
    const result = await decideIntervention({
      missionId,
      interventionId,
      payload: decisionPayload,
      expectedVersion,
      idempotencyKey: makeId('stew'),
      source: 'steward',
      decidedBy: 'steward',
      contractRequest: true,
    });
    const body = (result && result.body) || {};
    // permission 放行后不可撤销(工具已经开跑);其余三类锚回会话 turnSeq(可回退检查点)。
    const undoRef = body.ok === true
      ? (type === 'permission' && action === 'allow'
        ? { kind: 'none', note: '不可撤销' }
        : { kind: 'turn', sessionId: missionId, turnSeq: Math.max(0, Number(head.turnSeq) || 0) })
      : null;
    if (body.ok === true) {
      stewardAppendDecision({
        tool: 'steward_decide',
        args: { type, action, toolName, tier, interventionId, expectedVersion },
        targetSessionId: missionId,
        permissionMode,
        mayAct,
        undoRef,
        basis: {
          interventionId, interventionVersion: Number(body.interventionVersion) || 0,
          // 127 波 2-quater B2:代批的依据整份进账本(行动流水 UI 读它画类别与理由)。tainted 恒 false ——
          // 走到这里说明闸 8 已经放行(命中不含两类外联时闸 8 根本不问,也记 false:这条命令不在污染规则的范围里)。
          ...(delegation ? {
            delegation: {
              categories: delegation.categories, exemptBy: delegation.exemptBy,
              commandExcerpt: delegation.commandExcerpt, riskNote: delegation.riskNote,
              tainted: false, taintBy: null,
            },
          } : {}),
        },
      });
      if (delegation) {
        stewardExemptDelegatedLog({
          sessionId: missionId, interventionId, toolName, categories: delegation.categories, exemptBy: delegation.exemptBy,
          riskNoteChars: delegation.riskNote.length, windowCount: delegation.windowCount,
        });
      }
      // 127 波 2-quater B1 ①:剥掉了什么如实回给模型(没剥就不落这个键,既有回执逐字节不变)——
      // 否则它会以为改过的命令已经按它的意思跑了。
      // 127 波 2-quater B2:代批落定时多带 exemptDelegation(非代批的决定不落这个键)。它同时是 13q 确定性回执的
      // 识别标记 —— 管家回合里模型直调工具代批了,不靠它自己在 say 里提,回执照样出一行。
      return {
        ...body, undoRef,
        ...(ignoredPayloadKeys.length ? { ignoredPayloadKeys } : {}),
        ...(delegation ? {
          exemptDelegation: {
            delegated: true, categories: delegation.categories,
            labels: delegation.categories.map(key => STEWARD_EXEMPT_CATEGORY_LABELS[key] || key),
            riskNote: delegation.riskNote,
            note: `已按代批规则替用户放行这条「${delegation.categories.map(key => STEWARD_EXEMPT_CATEGORY_LABELS[key] || key).join('」「')}」类命令;工作台会给用户出一行回执,并把理由记进行动流水`,
          },
        } : {}),
      };
    }
    // 失败按 decideIntervention 的稳定 reason 原样回传(version_conflict / not_found / already_terminal /
    // delivery_unavailable …)。用 body.reason 而不是 error.code:reason 是命令核心的机器码,
    // error.code 只是它加了 'intervention.' 前缀的 HTTP 变体,工具面统一暴露前者更好分支。
    const failure = (body.error && typeof body.error === 'object') ? body.error : {};
    return stewardFail(String(body.reason || failure.code || 'decision_failed'), String(failure.message || body.message || 'decision could not be delivered'), {
      missionId, interventionId, type, params: failure.params || {}, status: result && result.status,
    });
  }

  // 14) steward_run_action。口径(§11.3 116c 行):
  //     pause / stop —— 收紧类,任何权限档都可做(把事情停下来永远比让它跑下去保守);
  //     resume / retry_node —— 失败处置类,按 §3.3 真值表的 'failed' 档口径:「改文件不问」以上可由管家直接做
  //     (续跑/重试只是让线程接着走,线程自己的权限门仍会对 exec 逐条问);「每步都问」「只做计划」只提议。
  //     116-2b 验收对齐(Fable):原先借 'plan' 档判定把它们限定为「只有全自动」,与 §3.3 自理清单
  //     (失败重试/重启续跑对改文件不问生效)及 13h 自理侧预闸口径不一致,两道闸统一为 'failed'。
  //     steer_node —— 改变线程要做的事,按 'plan' 档口径只有「全自动」可做。
  const STEWARD_RUN_TIGHTENING = Object.freeze(['pause', 'stop']);
  const STEWARD_RUN_ADVANCING = Object.freeze(['resume', 'retry_node', 'steer_node']);
  const STEWARD_RUN_ACTION_KIND = Object.freeze({ resume: 'failed', retry_node: 'failed', steer_node: 'plan' });
  // 116-3 P0-4(对抗审查):续跑的第六道闸(§11.3 116-2b 行「权限面不可证明就不自动」)此前【只】长在
  // 13h 的确定性自理路径上 —— 模型在结构化回复里声明 {tool:'steward_run_action', args:{action:'resume'}}
  // 的那条路完全绕开它,一个被判为 manual_resume_required(有非纯读节点停在半路 / 权限面变过)的班组
  // 会被自动续跑。判据的【唯一权威点】按 §3.3 的既定纪律在 13g 工具内部,故函数搬到这里;13h 的自理
  // 预闸仍调它(13h -> 13g 是后向边),两处共用同一份判定,不再各写一份。
  // 读不到快照一律按不安全处理('unknown' ≠ 'auto_resumable')。
  //
  // 125-P0:班组快照的另一个读点。它与上面那道分级读的是【同一份文件】,但两者的「读不到」语义不同 ——
  // 分级要分 ENOENT('missing',没有这条班组可续,不是安全问题)与其它 IO 错('unknown',按不安全处理),
  // 所以那个函数一个字节不动;这里只回快照本身,读不到回 null,由 06i 的判据决定怎么办(读不到 = 不知道
  // 它被停没停 -> stewardStoppedTarget 只看 head 那一半,不凭空拦)。执行序上这道闸排在分级【之前】,
  // 拦下了就不会再读第二次。
  async function stewardReadRunSnapshot(sessionId, runId) {
    try { return safeJsonParse(await fsp.readFile(agentRunFile(sessionId, runId), 'utf8'), null); }
    catch { return null; }
  }
  async function stewardRunResumeTier(sessionId, runId, config) {
    let raw = null;
    try {
      raw = await fsp.readFile(agentRunFile(sessionId, runId), 'utf8');
    } catch (error) {
      // 快照【根本不存在】≠「不敢续跑」:那是「没有这条班组可续」,核心自己会回 run_action_failed,
      // 拿它当危险来挡会把一个 not-found 说成安全问题。其余读失败(权限/IO)一律按不安全处理。
      return (error && error.code === 'ENOENT') ? 'missing' : 'unknown';
    }
    const run = safeJsonParse(raw, null);
    if (!run) return 'unknown';
    return String(AgentRecovery.classifyRunResumeTier(run, await AgentRecovery.agentRunPermissionMode(sessionId, config || {})).tier || '');
  }
  async function stewardImplRunAction(args, ctx, config) {
    const sessionId = safeSessionId(args.sessionId);
    const runId = safeSessionId(args.runId);
    const action = String(args.action || '');
    // 第二轮工具走查(F10):runId【给了但格式不对】('../../x' 之类)修前也落进下面「缺 runId 的收紧类 → no_agent_run」那一支,
    // 回一句「这条线程没有班组可暂停」—— 把一个明明是请求非法的值说成了「没班组」,模型会据此放弃找班组。
    // 给了就是给了:格式不对如实报 invalid runId;只有真的【没给】runId 才走 117m-A4 那条「问错了工具」的口径。
    if (sessionId && args.runId != null && String(args.runId).trim() !== '' && !runId) {
      return stewardFail('invalid_request', `invalid runId ${JSON.stringify(stewardSanitizeText(String(args.runId)).slice(0, 60))}; use a runId from steward_runs_status`, { sessionId });
    }
    if (!sessionId || !runId) return (sessionId && STEWARD_RUN_TIGHTENING.includes(action)) ? stewardFail('no_agent_run', '这条线程没有班组可暂停;要停的是它这一回合的话,用 steward_thread_stop', { sessionId, action }) : stewardFail('invalid_request', 'sessionId and runId are required');  // 117m-A4:缺 runId 的收紧类是【问错了工具】(普通线程没有班组),不是请求非法;其余动作逐字不变。全部理由见 13h 的 stewardImplThreadStop 头注
    if (!STEWARD_RUN_TIGHTENING.includes(action) && !STEWARD_RUN_ADVANCING.includes(action)) {
      return stewardFail('invalid_request', `unknown action: ${stewardSanitizeText(action)}`);
    }
    const head = await stewardReadSessionHead(sessionId);
    if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
    if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session has no agent runs');
    const permissionMode = stewardThreadPermissionMode(head, config);
    const mayAct = STEWARD_RUN_TIGHTENING.includes(action) ? 'auto' : stewardMayAct(permissionMode, STEWARD_RUN_ACTION_KIND[action], 'exec');
    if (mayAct !== 'auto') {
      return stewardFail('propose_required', `「${stewardSanitizeText(action)}」是推进类动作,当前线程权限「${stewardPermissionLabel(permissionMode)}」不允许管家直接执行(续跑/重试需「改文件不问」以上,改指令需「智能自动」)——把它作为提议交给用户,不要重试`, {
        reason: 'permission_mode', sessionId, runId, action, permissionMode,
      });
    }
    // 125-P0(42 号文 §1 ①):被停下来的班组,管家不自动重开。判据在 06i 一处(本文件不自己算),
    // 位置在 mayAct 之后、续跑分级之前 —— 分级读的是同一份快照,先问这一句,拦下了就省掉那次读。
    // 条件是【用户不在跟前】:POST /api/steward/act 与 /api/steward/relay 都给 trigger:'user',于是
    // 「降级成按钮、用户自己按」那条路照旧走得通;没有 trigger 的调用面(工具循环里模型直接调、
    // 进程内直调)按 fail-closed 一并拦下 —— 那些面上做决定的仍然是模型,不是人。
    if (STEWARD_RUN_ADVANCING.includes(action) && !stewardUserDirected(ctx)) {
      const stoppedWhich = stewardStoppedTarget(head, await stewardReadRunSnapshot(sessionId, runId));
      if (stoppedWhich) {
        return stewardFail('propose_required', stewardStoppedRefusal(stoppedWhich), {
          reason: 'target_stopped', sessionId, runId, action, permissionMode, stopped: stoppedWhich,
        });
      }
    }
    // 116-3 P0-4:第六道闸。放在 mayAct 之后、真正下发命令之前 —— 权限档允许不代表这条班组
    // 「重启后自动跑起来」是安全的(那是 run 快照自己的分级,与线程权限档正交)。
    if (action === 'resume') {
      const resumeTier = await stewardRunResumeTier(sessionId, runId, config);
      if (resumeTier !== 'auto_resumable' && resumeTier !== 'missing') {
        return stewardFail('propose_required', `这条班组重启后被判为「${stewardSanitizeText(resumeTier || '未知')}」,自动续跑不安全;把它作为提议交给用户按,不要重试`, {
          reason: 'resume_tier', sessionId, runId, action, permissionMode, resumeTier,
        });
      }
    }
    const cmd = await agentRunActionCommand({
      sessionId, runId, action,
      nodeId: args.nodeId,
      text: args.message == null ? '' : String(args.message).slice(0, STEWARD_STEER_TEXT_MAX),
    });
    if (!cmd) return stewardFail('invalid_request', `unsupported action: ${stewardSanitizeText(action)}`);
    const body = cmd.body || {};
    if (body.ok !== true) return stewardFail('run_action_failed', String(body.error || 'agent run action failed'), { sessionId, runId, action, status: cmd.status });
    // pause/stop 可由 resume 撤销;推进类动作没有对称撤销原语,如实标注不可撤销。
    const undoRef = action === 'pause' || action === 'stop'
      ? { kind: 'run_action', sessionId, runId, action: 'resume' }
      : { kind: 'none', note: '不可撤销' };
    stewardAppendDecision({
      tool: 'steward_run_action',
      args: { action, runId, nodeId: String(args.nodeId || '') },
      targetSessionId: sessionId,
      permissionMode,
      mayAct,
      undoRef,
      basis: stewardBasisOf(args, { runId }),
    });
    return { ...body, sessionId, runId, action, undoRef };
  }

  return {
    stewardDecideAttempted, stewardImplDecide, stewardImplRunAction, stewardReadRunSnapshot,
    stewardRunResumeTier,
  };
}

module.exports = { createStewardDecisionTools };
