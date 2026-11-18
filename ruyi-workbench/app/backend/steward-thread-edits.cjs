'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');

function createStewardThreadEdits({
  paths, safeSessionId, pathWithinRoot, decodeTextFileBytes, realpathForContainment, sanitizeFsSegmentName,
  activeChildren, steerSessionCore, stewardLaunchTurn, stewardAppendDecision, stewardBasisOf, stewardFail,
  stewardErrorDetail,
  sessions, workspaces, policy, limits,
}) {
  const {
    sessionDisplayTitle, updateSessionMeta, sessionDesktopToolsOf, sessionPermissionModeOf, stewardReadSessionHead,
    stewardRawKind, stewardThreadPermissionMode,
  } = sessions;
  const {
    stewardKnownWorkspaces, stewardMatchKnownWorkspace, stewardSamePath, stewardWorkspaceRootFor,
  } = workspaces;
  const {
    StewardHooks, stewardMayAct, stewardMayTightenTo, stewardPermissionLabel, stewardSanitizeText,
    stewardStoppedRefusal, stewardStoppedTarget, stewardAnswerGate, stewardRelayAutoAllowed, stewardSeatedByUser,
    stewardSeatedFail, stewardUnattendedByModel, stewardUserDirected,
  } = policy;
  const {
    PERMISSION_MODES, STEWARD_NOTE_PREFIX, STEWARD_NOTE_TEXT_MAX, STEWARD_TITLE_MAX,
  } = limits;

  async function stewardContinueAttachments(raw) {
    if (raw == null) return { ok: true, attachments: [] };
    if (!Array.isArray(raw) || raw.length > 12) return stewardFail('invalid_request', '最多递送 12 个上传附件');
    const root = await fsp.realpath(paths.uploads).catch(() => paths.uploads);
    const attachments = [];
    for (const item of raw) {
      const id = item && item.id, name = item && item.name;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof name !== 'string' || !name || name.length > 200 || sanitizeFsSegmentName(name) !== name || /[. ]$/.test(name)) return stewardFail('invalid_request', '附件记录无效,请重新上传');
      const target = path.resolve(paths.uploads, id, name);
      const real = await fsp.realpath(target).catch(() => null);
      const stat = real && pathWithinRoot(real, root) ? await fsp.stat(real).catch(() => null) : null;
      if (!stat || !stat.isFile()) return stewardFail('attachment_missing', `附件「${stewardSanitizeText(name)}」已不可用,请重新上传`);
      const textLike = /\.(txt|md|json|js|ts|tsx|jsx|py|ps1|bat|cmd|csv|xml|svg|html|css|yaml|yml|ini|log)$/i.test(name);
      const media = /\.(png|jpe?g|gif|webp|bmp|wav|mp3|m4a|webm|ogg|flac)$/i.test(name);
      // 图片 OCR / 音频转写由上传端生成,仍按用户资料传递;文本文件的预览则重新从真实文件读取。
      const textPreview = textLike && stat.size <= 256 * 1024 ? decodeTextFileBytes(await fsp.readFile(real), true).slice(0, 12000)
        : media && typeof item.textPreview === 'string' ? item.textPreview.slice(0, 4000) : '';
      attachments.push({ id, name, path: real, size: stat.size, textPreview,
        ...(/\.(png|jpe?g|gif|webp|bmp)$/i.test(name) ? { kind: 'image' } : {}),
        ...(/\.(wav|mp3|m4a|webm|ogg|flac)$/i.test(name) ? { kind: 'audio' } : {}) });
    }
    return { ok: true, attachments };
  }
  // 11) steward_thread_continue —— 原话直递。undoRef 锚在递话【前】的 turnSeq(rewindSession 的主键)。
  async function stewardImplThreadContinue(args, ctx, config) {
    const sessionId = safeSessionId(args.sessionId);
    if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
    // 第二轮工具走查(F8):message 是【原话直递】—— 门控壳的类型校验对「数字当字符串」一贯宽松,
    // 但把 12345 当成用户的话递给线程等于模型自己编了一句原话,这里收紧到必须真是字符串。
    if (args.message != null && typeof args.message !== 'string') return stewardFail('invalid_request', 'message must be a string (the user\'s words, passed through verbatim)');
    const message = String(args.message == null ? '' : args.message);
    if (!message.trim()) return stewardFail('invalid_request', 'message is required');
    const head = await stewardReadSessionHead(sessionId);
    if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
    if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session cannot be a relay target');
    const checkedAttachments = await stewardContinueAttachments(args.attachments);
    if (!checkedAttachments.ok) return checkedAttachments;
    const attachments = checkedAttachments.attachments;
    const revision = args.deliverySource ? await StewardHooks.validateDeliveryReference(sessionId, args.deliverySource, config) : null;
    if (revision && !revision.ok) return revision;
    // 121-K3(§4.5):用户正坐在这条线程前面 -> 不递话。排在权限闸【之前】:这不是「有没有权限」的问题,
    // 而是「现在不是时候」,先答这一句比先算一遍权限档诚实(也省一次配置读)。
    if (stewardSeatedByUser(sessionId)) return stewardSeatedFail(sessionId);
    // 117l D2(§11.9;用户第四轮走查第 1、6 条):这里原本只有一道 activeChildren.has -> steward.busy,
    // 两头都错(等回答的线程也算「忙」;没命中时 stewardLaunchTurn 又会 supersede 掉它)。现在按
    // 【目标状态】选通道,判定与执行的单点在 13h(经 StewardHooks.relayDeliver 延迟绑定,零前向边;
    // 四条通道各自的理由写在那里的头注),POST /api/steward/relay 走的是同一个实现。

    // 125-P0(42 号文 §1 ①):上一回合是被【停】下来的,就别自动往里递话 —— 用户按的停也好、别处
    // 掐的也好,那是一次明确的意思表示。判据在 06i 一处(本文件不自己算),排在权限闸【之前】:与上面
    // 那条「用户正坐在这条线程前面」同理,这不是「有没有权限」,是「这件事刚被停下来,不该由管家替他
    // 撤销」。条件是用户不在跟前 —— /api/steward/relay 与 /api/steward/act 都给 trigger:'user',
    // 用户自己按那枚按钮照旧递得进去。
    if (!stewardUserDirected(ctx) && stewardStoppedTarget(head, null) === 'thread') {
      return stewardFail('propose_required', stewardStoppedRefusal('thread'), {
        reason: 'target_stopped', sessionId, stopped: 'thread',
      });
    }

    // 116-3 P0-2:无人值守(收件箱)触发的递话要过两道闸 —— 自理清单勾选 + 目标线程权限档
    // (§3.5 工具面表格:线程族按目标线程权限,「每步都问」「只做计划」一律提议)。判据与
    // stewardImplDecide / stewardImplRunAction 同一写法:先算 mayAct,不是 'auto' 就 propose_required。
    const permissionMode = stewardThreadPermissionMode(head, config);
    let mayAct = 'auto';
    // 129g:先探一眼目标此刻在哪条通道上 —— **只为决定该问哪一格开关**,不作为放行依据。
    // 代答那一支归 answer 格管(见 stewardAnswerGate),不该被 relay 那一格挡下:用户勾「事项内自动
    // 交接」是要让上一条线程的结论流到下一条,与「替我回答」是两件事。
    // 探测与投递之间线程状态可能翻转,所以真正的门在 13q 的 answer 支里、在通道定下来之后 ——
    // 这里探错了顶多是多问一格开关,盖不住的那一半由那道门兜住。
    const answerProbe = typeof StewardHooks.relayChannel === 'function' ? StewardHooks.relayChannel(sessionId) : null;
    const probablyAnswer = Boolean(answerProbe && answerProbe.channel === 'answer');
    if (!probablyAnswer && stewardUnattendedByModel(ctx)) {
      if (!stewardRelayAutoAllowed(config)) {
        return stewardFail('propose_required', '「任务内自动交接」没有勾选,无人值守时的递话只能作为提议交给用户,不要重试', {
          reason: 'self_serve_off', sessionId, permissionMode,
        });
      }
      mayAct = stewardMayAct(permissionMode, 'relay', 'edit');
      if (mayAct !== 'auto') {
        return stewardFail('propose_required', `目标线程的权限档为「${stewardPermissionLabel(permissionMode)}」,管家不能在你不在场时直接往它里面递话;把它作为提议交给用户,不要重试`, {
          reason: 'target_permission', sessionId, permissionMode,
        });
      }
    }

    // 递话【前】的 turnSeq:检查点以它为锚。但 rewindSession 的主键【不是】它 —— 它按「要删的那一回合的
    // 第一条用户消息」定位,即 plannedTurnSeq = 递话前 turnSeq + 1(与 09-workflow 同口径)。117d 第 0 步
    // 补出显式字段 rewindTargetTurnSeq;turnSeq 语义保持「递话前」不变(既有消费者逐字节不受影响)。
    const beforeTurnSeq = Math.max(0, Number(head.turnSeq) || 0);
    let undoRef = { kind: 'none', sessionId };
    const basis = stewardBasisOf(args);
    // 129g:代答闸的回调。只在通道真的落到 'answer' 时被 13q 叫到;gate.used 是【核实过】的依据,
    // 放行后原样进决策账本 —— 账本记的是「服务端核住了什么」,不是「模型说它有什么」。
    const gate = { args, ctx, config, head, sessionId, permissionMode, used: null };
    // title 用【显示名】(116-5b 单点),不拿 id 冒充标题;turn 通道的启动仍是 13g 自己的
    // stewardLaunchTurn(同一个 requestMeta、同一本决策日志)—— 13h 只决定「走哪条」。
    const delivered = await StewardHooks.relayDeliver({
      sessionId, message, attachments, revision: !!revision, title: sessionDisplayTitle(head), source: 'steward_thread_continue',
      answerGuard: decided => { gate.decided = decided; return stewardAnswerGate(gate); },
      launch: async () => {
        const launched = stewardLaunchTurn({ sessionId, message, attachments, expectedCwd: String(head.cwd || ''), source: 'steward',
          ...(revision ? { expectedTurnSeq: revision.reference.latestTurnSeq, expectedDelivery: args.deliverySource, messageMeta: { origin: 'steward', tool: 'steward_thread_continue', revisionOf: revision.reference } } : {}),
          requestMeta: { tool: 'steward_thread_continue', ...(basis.origin ? { origin: basis.origin } : {}) } }, 'steward_thread_continue');
        const registration = await launched.registration;
        if (!registration) {
          await launched;
          return stewardFail('relay_failed', '目标回合未登记,这句话和附件尚未确认递送');
        }
        if (registration) undoRef = { kind: 'turn', sessionId, turnSeq: beforeTurnSeq, ...registration };
        return { undoRef };
      },
    });
    if (delivered && delivered.ok === false) return delivered;
    // 只有开了【新回合】的那一支(turn)才有可回退的锚点。答提问(answer)与插话(steer)都落在一个已有的回合里:
    // 修前 answer 交回的 undoRef 没有回合号,前端「撤回」按 0+1 回退 = 把整条线程从第 1 回合起删光;steer 交回的
    // 锚点指着正在跑的那一回合,撤回先停掉用户的回合再回退失败。这两支一律不给撤回锚点(kind:'none')。
    const deliveredChannel = String((delivered && delivered.channel) || 'turn');
    const finalUndoRef = deliveredChannel === 'turn' ? undoRef : { kind: 'none', sessionId, channel: deliveredChannel };

    stewardAppendDecision({
      tool: 'steward_thread_continue',
      // 117l D2:走的哪条通道进决策日志 —— 行动流水里「答了一道提问」与「开了一个新回合」是两件事。
      args: { messageChars: message.length, channel: String(delivered && delivered.channel || 'turn') },
      targetSessionId: sessionId,
      permissionMode,
      // 116-3 P0-2:写【真实】判定值,不再是硬编码 'auto' —— 决策日志要能事后对账
      // 「这个动作到底是不是该提议而没提议」。
      mayAct,
      undoRef: finalUndoRef,
      // 129g:代答那一支把核实过的出处并进 basis —— 行动流水里「管家替我答了那道题」必须能点开
      // 看见凭什么。没走代答(用户原话直递 / 别的通道)时 gate.used 为 null,basis 一字不变。
      basis: gate.used ? { ...basis, ...(gate.used.memoryIds.length ? { memoryIds: gate.used.memoryIds } : {}), ...(gate.used.briefRef ? { briefRef: gate.used.briefRef } : {}), answeredFor: 'user' } : basis,
    });
    return { ok: true, sessionId, ...(delivered && typeof delivered === 'object' ? delivered : {}), undoRef: finalUndoRef };
  }

  // 12) steward_thread_rename —— undoRef 带旧标题(一键改回)。
  async function stewardImplThreadRename(args, ctx, config) {
    const sessionId = safeSessionId(args.sessionId);
    if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
    // 第二轮工具走查(F8):title:{a:1} 修前被 String() 成 "[object Object]" 写进会话头(门控壳现在也会拦对象/数组,
    // 这里再收紧到「必须是字符串」—— 标题是给人看的名字,数字、布尔当标题都是模型传串了位)。
    if (args.title != null && typeof args.title !== 'string') return stewardFail('invalid_request', 'title must be a string');
    const title = String(args.title == null ? '' : args.title).replace(/[\r\n]+/g, ' ').trim().slice(0, STEWARD_TITLE_MAX);
    if (!title) return stewardFail('invalid_request', 'title is required');
    const head = await stewardReadSessionHead(sessionId);
    if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
    if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session cannot be renamed by a tool');
    // 与 thread_continue 同一条忙锁:改名走 loadSession -> saveSession 的读改写,活回合期间那份内存副本会
    // 在回合的收尾 save 之后落盘,把回合刚写进去的消息用陈旧副本盖掉(会话正文缩水 = 头计数与正文行数错位)。
    // 经典壳的重命名由用户手动触发、撞上的概率低;管家是自动的,必须显式挡住。
    if (activeChildren.has(sessionId)) return stewardFail('steward.busy', `thread ${sessionId} has a turn in flight; rename it after the turn settles`);
    // 116-3 P0-2:改名同样按目标线程权限档判(§3.5 线程族整行都是「按目标线程权限」)。
    // 13h 的 stewardSelfServeAllows 末尾原有的注释说「rename 由 13g 内部的 stewardMayAct 裁决」——
    // 那句话此前是错的(内部根本没有这个裁决),这一行把它补成真的。
    const currentMode = stewardThreadPermissionMode(head, config);
    let renameMayAct = 'auto';
    if (stewardUnattendedByModel(ctx)) {
      renameMayAct = stewardMayAct(currentMode, 'relay', 'edit');
      if (renameMayAct !== 'auto') {
        return stewardFail('propose_required', `目标线程的权限档为「${stewardPermissionLabel(currentMode)}」,管家不能在你不在场时改它的标题;把它作为提议交给用户,不要重试`, {
          reason: 'target_permission', sessionId, permissionMode: currentMode,
        });
      }
    }
    const previousTitle = String(head.title || '');
    // 复用既有的会话元数据更新原语(PUT /api/sessions/:id 背后那一个),不另开第二条改名写路径。
    const session = await updateSessionMeta(sessionId, { title });
    if (!session) return stewardFail('not_found', `thread ${sessionId} not found`);
    const undoRef = { kind: 'title', sessionId, previousTitle };
    stewardAppendDecision({
      tool: 'steward_thread_rename',
      args: { title, previousTitle },
      targetSessionId: sessionId,
      permissionMode: stewardThreadPermissionMode(session, config),
      mayAct: renameMayAct,   // 116-3 P0-2:真实判定值,不再是常量
      undoRef,
      basis: {},
    });
    return { ok: true, sessionId, title, undoRef };
  }

  // 12a2) steward_thread_workspace —— 改一条【已有】线程在哪个目录里干活(129e;49 号文 §4)。
  //
  // 31 号文 §2.3 放① 只做了「开线程时选工作区」;真机上另一半更常撞见:**线程已经开在错的目录里了**
  // (那份走查里四条线程含两条股票问题全落在代码仓库)。今天用户能在顶栏改(updateSessionMeta 的
  // patch.cwd 就是那条路),管家不能 —— 它连提都提不出来。
  //
  // **围栏红线不破**:只收【工作区表】里的路径,表外一律拒;recentWorkspaces 不算(打开过 ≠ 授权过)。
  // 管家写不了 workspaces 本身(forbidden 档),所以它只能在用户已经登记过的目录之间挪。
  //
  // 三条行为(用户 2026-09-20 拍板 ＋ 主会话定的两条):
  //   ① **auto 档自动、其余档提议** —— 与「选工作区是开线程的参数、三档都可」对齐,但改【已有】线程
  //      比开新线程重(脚下的地换了,后面每一回合都按新目录算),所以往紧里收一格;
  //   ② 活回合期间一律拒 —— 不在回合中途换脚下的地。这与 thread_rename 同一条忙锁,但理由更硬:
  //      rename 怕的是读改写竞态,这里还多一层「这一回合的工具正拿着旧 cwd 在跑」;
  //   ③ 旧目录上的检查点**不迁移、不删除**,返回里明说 —— 悄悄搬走比不搬更难解释。
  async function stewardImplThreadWorkspace(args, ctx, config) {
    const sessionId = safeSessionId(args && args.sessionId);
    if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
    const wantRaw = String((args && args.cwd) || '').trim();
    if (!wantRaw) return stewardFail('invalid_request', 'cwd is required');
    const head = await stewardReadSessionHead(sessionId);
    if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
    if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session has no working folder to change');
    // W7:与 thread_new 同一口径 —— 已知工作区清单里的【名字】也收(上下文里给的就是名字),先换成那一行的路径。
    const knownHit = stewardMatchKnownWorkspace(wantRaw, stewardKnownWorkspaces(config));
    const want = knownHit ? knownHit.path : wantRaw;
    // 围栏:只认已登记工作区(判据单点在 06i,与 steward_file_read 同一个函数)。
    const root = stewardWorkspaceRootFor(want, config);
    if (!root) {
      return stewardFail('outside_workspace', 'cwd must be one of the registered workspaces; pick a path from the workspace table', { cwd: stewardSanitizeText(want).slice(0, 200) });
    }
    // 真实落点也得在区内(链接/联接指向区外的不认),且得是一个已存在的目录:修前不存在的路径、甚至一个文件
    // 都能被设成线程的工作目录,线程下一回合直接起不来。
    const [realWant, realRoot] = await Promise.all([realpathForContainment(want), realpathForContainment(root)]);
    if (!pathWithinRoot(realWant, realRoot)) {
      return stewardFail('outside_workspace', 'that path is a link that points outside the registered workspace; pick a real folder inside it', { cwd: stewardSanitizeText(want).slice(0, 200) });
    }
    const wantStat = await fsp.stat(want).catch(() => null);
    if (!wantStat || !wantStat.isDirectory()) {
      return stewardFail('invalid_request', wantStat ? 'cwd must be a folder, not a file' : 'that folder does not exist; pick an existing folder from the workspace table', { cwd: stewardSanitizeText(want).slice(0, 200) });
    }
    if (activeChildren.has(sessionId)) {
      return stewardFail('steward.busy', `thread ${sessionId} has a turn in flight; change its working folder after the turn settles`, { sessionId });
    }
    const currentMode = stewardThreadPermissionMode(head, config);
    if (currentMode !== 'auto') {
      return stewardFail('propose_required', `目标线程的权限档是「${stewardPermissionLabel(currentMode)}」,换工作目录这件事要用户亲手按;把它作为提议交给用户,不要重试`, {
        reason: 'target_permission', sessionId, permissionMode: currentMode, cwd: stewardSanitizeText(want).slice(0, 200),
      });
    }
    const previousCwd = String(head.cwd || '');
    if (stewardSamePath(previousCwd, want)) {
      return stewardFail('not_changed', '这条线程已经在这个目录里了,不用改', { sessionId, cwd: stewardSanitizeText(previousCwd).slice(0, 200) });
    }
    // 复用顶栏那条既有写路径(updateSessionMeta 的 patch.cwd),不另开第二条。
    const session = await updateSessionMeta(sessionId, { cwd: want });
    if (!session) return stewardFail('not_found', `thread ${sessionId} not found`);
    const undoRef = { kind: 'cwd', sessionId, previousCwd };
    stewardAppendDecision({
      tool: 'steward_thread_workspace',
      args: { cwd: want, previousCwd },
      targetSessionId: sessionId,
      permissionMode: currentMode,
      mayAct: 'auto',
      undoRef,
      basis: {},
    });
    return {
      ok: true, sessionId, cwd: String(session.cwd || want), previousCwd, undoRef,
      note: '之前那些检查点仍然指向旧目录(没有迁移,也没有删除)。',
    };
  }

  // 12b) steward_thread_permission —— 线程权限【只降不升】(116-2a)。
  // 这是永久豁免清单第 2 条(「管家不得自我扩权:放宽任一线程的 permissionMode」)的机器实现:
  // 目标档必须严格比【当前生效档】更紧(STEWARD_PERMISSION_RANK 的单调性判定),否则一律
  // steward.widen_forbidden —— 放宽只能由用户在界面上改,那条路上还有一道「切到全自动须二次确认」。
  // 不加忙锁:116-2a 把 updateSessionMeta 的读改写竞态改成了「活回合期间延后落盘 + 内存覆盖表立刻生效」,
  // 收紧对下一回合立即有效且不会盖掉在途回合刚写的消息 —— 这正是收紧最该起效的时刻,拒绝反而危险。
  // 117z-E2 提交②(27 号文 §11.21.3/§11.21.5 裁决 A):本工具多一条【能力】轴 —— `capabilities.desktop`。
  // 两条轴上的纪律不是同一条,但方向是同一个:**能自动的只有降,升永远要人按**。
  //   · permissionMode 轴:只降不升,由 06i 的 stewardMayTightenTo 机械执行(一个字没动);
  //   · desktop 轴:false(收紧)与档位轴的收紧同口径 —— 直接做;true(放宽)**恒 propose_required**,
  //     含 auto 档,且目标必须是 createdBy === 'steward' 的线程,否则 invalid_target。
  // 为什么放宽在 auto 档也不给自动路(§11.21.5 选项 A,用户未表态按推荐做):管家稳定层纪律 2 是
  // 「任何情况下都不放宽」,而这条轴的爆炸半径是【用户的桌面】(03-bridge-guard 自己把它描述成
  // "acts on everything the user owns")。例外一旦开在最高爆炸半径的面上,以后每一轴都会来要同样的例外。
  // 于是「放宽」这条路上唯一的钥匙是 `ctx.userPressed === true` —— 用户在界面上亲手按下了那枚按钮
  // (13q 的 POST /api/steward/act 是它全仓唯一的置 true 点)。模型自己在 args 里写 userPressed 不算数
  // (13g 的门控壳把同名字段剥掉)。
  async function stewardImplThreadPermission(args, ctx, config) {
    const sessionId = safeSessionId(args.sessionId);
    if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
    // 两条轴都可选,但不能一条都不给(那是一次没有内容的写)。
    const hasMode = args.permissionMode != null && String(args.permissionMode) !== '';
    const capsArg = (args.capabilities && typeof args.capabilities === 'object' && !Array.isArray(args.capabilities)) ? args.capabilities : null;
    const hasDesktop = !!capsArg && typeof capsArg.desktop === 'boolean';
    if (!hasMode && !hasDesktop) {
      return stewardFail('invalid_request', 'permissionMode or capabilities.desktop is required');
    }
    const target = hasMode ? String(args.permissionMode) : '';
    if (hasMode && !PERMISSION_MODES.includes(target)) {
      return stewardFail('invalid_request', `permissionMode must be one of ${PERMISSION_MODES.join('/')}`);
    }
    const head = await stewardReadSessionHead(sessionId);
    if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
    if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session has no thread permission');
    // 121-K3(§4.5):用户正坐在这条线程前面 -> 不改它的权限与模型。与递话那一处同一道门、同一条理由。
    if (stewardSeatedByUser(sessionId)) return stewardSeatedFail(sessionId);

    const current = stewardThreadPermissionMode(head, config);
    if (hasMode && !stewardMayTightenTo(current, target)) {
      return stewardFail('steward.widen_forbidden',
        `线程 ${sessionId} 当前权限是「${stewardPermissionLabel(current)}」,管家只能收紧、不能放宽或平移到「${stewardPermissionLabel(target)}」;要放宽请让用户在界面上改`,
        { sessionId, permissionMode: current, requested: target });
    }
    // ── desktop 轴的两道闸(只在放宽方向上有闸)────────────────────────────────────────────
    const wantDesktop = hasDesktop ? capsArg.desktop === true : null;
    if (wantDesktop === true) {
      // 闸一:目标必须是管家自己开的线程。用户自己的会话不归管家管,它的桌面权限在设置里改
      // (§11.21.2)—— 对那种线程连提议都不出。读的是【出身】标,不是 launchedBy(会被递话污染)。
      if (String(head.createdBy || '') !== 'steward') {
        return stewardFail('invalid_target',
          `线程 ${sessionId} 不是我开的线程,它的桌面权限只能由用户自己在设置里改;我连这个提议都不出`,
          { sessionId, reason: 'not_steward_created', capabilities: { desktop: true } });
      }
      // 闸二:恒提议。任何档位(含 auto)都走这里,只有用户亲手按下那枚按钮的那一次能穿过去。
      if (ctx == null || ctx.userPressed !== true) {
        return stewardFail('propose_required',
          `给线程开桌面权限是一次【放宽】,任何权限档都必须由你亲自按下才生效;把它作为提议交给用户,不要重试`,
          { reason: 'confirm_required', sessionId, permissionMode: current, capabilities: { desktop: true } });
      }
    }
    const previous = sessionPermissionModeOf(head);            // 档位轴的会话级旧值(null = 之前跟着全局走)
    const previousDesktop = sessionDesktopToolsOf(head);       // 能力轴的会话级旧值(null = 之前跟着全局走)
    const session = await updateSessionMeta(sessionId, {
      ...(hasMode ? { permissionMode: target } : {}),
      ...(hasDesktop ? { desktopTools: wantDesktop } : {}),
    });
    if (!session) return stewardFail('not_found', `thread ${sessionId} not found`);
    const effectiveMode = hasMode ? target : current;
    // undoRef 与既有形状同款(一键改回):动了能力轴就标 kind:'desktop',否则仍是 'permission'。
    const undoRef = hasDesktop
      ? { kind: 'desktop', sessionId, previous: previousDesktop, ...(hasMode ? { previousPermissionMode: previous } : {}) }
      : { kind: 'permission', sessionId, previous };
    stewardAppendDecision({
      tool: 'steward_thread_permission',
      args: {
        ...(hasMode ? { permissionMode: target, previous } : {}),
        ...(hasDesktop ? { capabilities: { desktop: wantDesktop }, previousDesktop } : {}),
      },
      targetSessionId: sessionId,
      permissionMode: effectiveMode,
      // 放宽那一次是【用户按的】,如实记 'user'(与 config_set 的 confirm 档同口径);其余仍是 'auto'。
      mayAct: wantDesktop === true ? 'user' : 'auto',
      undoRef,
      basis: { previousEffective: current },
    });
    return {
      ok: true, sessionId,
      permissionMode: effectiveMode, effectivePermissionMode: effectiveMode, previousEffective: current, previous,
      ...(hasDesktop ? { desktopTools: wantDesktop, previousDesktopTools: previousDesktop } : {}),
      undoRef,
    };
  }

  // 15b) steward_thread_note —— 既有线程的【插话补充】(116-2b,§3.5 委派行末句)。
  //
  // 为什么是插话而不是递话:§8.12 定的是「既有线程的递话走原话直递,管家如有补充以插话追加,不阻塞
  // 线程启动」。递话(thread_continue)会【起一个新回合】,补充却必须落在【正在跑的那个回合】里 ——
  // 它是给线程补上下文,不是给它派新活。所以走的是 /api/steer 背后的同一条注入通道(116-2b 把它零行为
  // 抽成了 13b 的 steerSessionCore),而不是第二条注入路径:引擎分流(openai 队列 / Claude stdin /
  // Kimi ACP 跟随)、队列上限、提问挂起时拒绝、持久呈现进会话正文,一条纪律都不用重写。
  //
  // 三条自己的收紧:①≤600 字;②尖括号中和(stewardSanitizeText,与总览行同一函数);③服务端加
  // 「（管家补充）」前缀 —— 用户在 2.0 视窗里看到的插话必须能一眼分清是谁说的。
  // 没有在途回合(或该回合不接受插话)时一律 steward.no_active_turn:模型看到这个信封就该改用
  // steward_thread_continue,而不是轮询重试。
  async function stewardImplThreadNote(args, ctx, config) {
    const sessionId = safeSessionId(args.sessionId);
    if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
    const text = stewardSanitizeText(args.text).trim().slice(0, STEWARD_NOTE_TEXT_MAX);
    if (!text) return stewardFail('invalid_request', 'text is required');
    const head = await stewardReadSessionHead(sessionId);
    if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
    if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session cannot receive a steward note');
    // 插话与递话走同一条注入通道,无人值守时也该过同样两道闸(修前写死 mayAct:'auto',「只做计划」档的线程
    // 照样被收件箱回合插进话去):自理清单 relay 勾选 + 目标线程权限档。
    const permissionMode = stewardThreadPermissionMode(head, config);
    let mayAct = 'auto';
    if (stewardUnattendedByModel(ctx)) {
      if (!stewardRelayAutoAllowed(config)) {
        return stewardFail('propose_required', '「任务内自动交接」没有勾选,无人值守时的插话只能作为提议交给用户,不要重试', {
          reason: 'self_serve_off', sessionId, permissionMode,
        });
      }
      mayAct = stewardMayAct(permissionMode, 'relay', 'edit');
      if (mayAct !== 'auto') {
        return stewardFail('propose_required', `目标线程的权限档为「${stewardPermissionLabel(permissionMode)}」,管家不能在你不在场时直接往它里面插话;把它作为提议交给用户,不要重试`, {
          reason: 'target_permission', sessionId, permissionMode,
        });
      }
    }

    const outcome = await steerSessionCore({ sessionId, text: STEWARD_NOTE_PREFIX + text });
    // 核心的两种"没成"(apiFailure 形态的 400/409 与裸 json 的 {ok:false,error}) 归一成同一个稳定信封:
    // 对模型来说它们是同一件事 —— 现在没法把这句话插进去,别重试。
    if (outcome.kind === 'failure' || !(outcome.body && outcome.body.ok === true)) {
      const detail = stewardErrorDetail(outcome.kind === 'failure' ? outcome.message : (outcome.body && outcome.body.error)).slice(0, 300);
      return stewardFail('steward.no_active_turn', `thread ${sessionId} cannot take a note right now: ${detail} —— do not retry; use steward_thread_continue to start a new turn instead`, { sessionId });
    }
    const body = outcome.body;
    // 撤回原语是 DELETE /api/steer,它按【文本】在队列里找那一条 —— 所以 undoRef 的真正把手是 text
    // 而不是某个 id(既有插话通道就没有 id 这个东西,编一个出来只会骗人)。
    const undoRef = { kind: 'note', sessionId, text: STEWARD_NOTE_PREFIX + text, queued: Number(body.queued) || 0, injected: body.injected === true };
    stewardAppendDecision({
      tool: 'steward_thread_note',
      args: { textChars: text.length },
      targetSessionId: sessionId,
      permissionMode,
      mayAct,
      undoRef,
      basis: {},
    });
    return { ok: true, sessionId, queued: Number(body.queued) || 0, injected: body.injected === true, undoRef };
  }

  return {
    stewardContinueAttachments, stewardImplThreadContinue, stewardImplThreadRename, stewardImplThreadWorkspace,
    stewardImplThreadPermission, stewardImplThreadNote,
  };
}

module.exports = { createStewardThreadEdits };
