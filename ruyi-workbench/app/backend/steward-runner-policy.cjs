'use strict';

function createStewardRunnerPolicy({ labels }) {
  const { ERROR_CLASSES, stewardSanitizeText } = labels;

  // ── 落盘面(唯一新增:到访归档;已登记进 durable-state-inventory)────────────────────────────────
  const STEWARD_VISITS_DIR = 'visits';
  const STEWARD_VISIT_SCHEMA = 1;
  const STEWARD_VISITS_KEEP = 200;              // 归档文件保留个数(超出从最旧删起)

  // ── 回合层数值口径(§11.2)────────────────────────────────────────────────────────────────────
  const STEWARD_INBOX_EVENTS_PER_TURN = 30;     // 一个收件箱回合最多带 30 条事件
  const STEWARD_INBOX_EVENT_CHARS = 400;        // 每条事件 ≤400 字
  // 117s-H1(27 号文 §11.13.3):事件行仍是那 400 字的标题行,交付正文另起一个【受预算的引用块】
  // 跟在它后面 —— 于是模型不必再花一次 steward_thread_read 配额去读它自己刚被通知的那份交付。
  const STEWARD_INBOX_DELIVERABLE_CHARS = 4000; // 单条交付正文在收件箱消息里的上限
  const STEWARD_INBOX_MESSAGE_CHARS = 12000;    // 一条收件箱消息的总预算(标题行永不丢,正文从最旧的丢起)
  const STEWARD_MEMORY_BLOCK_CHARS = 3000;      // 记忆块 ≤3000 字符
  // 128h-J12:被否决条目在提示词里自带一份【独立】预算,排在生效清单之后。不与上面那 3000 字共用:
  // 那是「按这些办」的清单,这是「别再写回去」的清单,后者挤掉前者就本末倒置了。8 条够用 ——
  // 否决是个罕见动作,真到了几十条,模型要的是最近否的那几条,不是全表。
  const STEWARD_MEMORY_VETOED_BLOCK_CHARS = 600; // 否决清单 ≤600 字符
  const STEWARD_MEMORY_VETOED_MAX = 8;           // 否决清单最多 8 条(按 updatedAt 取最近的)
  // 117y-S1(27 号文 §11.18.2):原来这里只有一个 say 上限常量(600),它同时扮演两个角色 ——
  // 06b 输出契约里写给模型看的「≤600 字」,和 13o 解析时那把裸 slice。用户第十一轮拍板:
  // 「得保证话能说全,不要硬截…通过提示词去约束说的话长度」。于是两个角色拆开:
  //   · TARGET  = 600  —— 只说给模型听的目标(06b 输出契约那一行)。**运行期不再据此裁剪。**
  //   · CEILING = 4000 —— 只防病态载荷(尤其 13o 那条 JSON 解析失败的兜底会把整份原始模型输出
  //     灌进来)。约为目标的 6.7 倍,守规矩的回复永远碰不到;触到了也走 06i 的
  //     stewardTrimSayAtSentence 在句末标点处切并明说,不裸切。
  // 旧名直接删掉而不留别名:全仓消费方只有 13o 的那两处(其余命中全是生成物
  // module-contracts.json / module-dependency-graph 与 27 号文的病灶描述),不存在被静默改语义的第三方。
  const STEWARD_SAY_TARGET = 600;               // say 的提示词目标(不是运行期上限)
  const STEWARD_SAY_CEILING = 4000;             // say 的病态载荷天花板(触顶按句界裁剪并明说)
  const STEWARD_WHY_MAX = 400;
  const STEWARD_ACT_LABEL_MAX = 12;             // 按钮文字 ≤12 字
  // 107-S1 ④(46 号文 §5 ⑦b H1):confirm 族(改设置 / 改技能 / 给线程开桌面)的按钮【另有一个天花板】。
  // 12 字是「按钮上写用户要做的那件事」的预算,装不下「改设置:permissionMode=auto」—— 而这一族的整个修法
  // 就是「按钮上必须写清要改哪个键、改成什么」,不能让模型自己命名它。32 字够一条「键=值」,
  // 多于一个键时按钮只写第一个键＋「等 N 项」,整份清单在确认面板里逐条列(值另有 40 字的裁剪)。
  // 只对这一族生效:其余 act 的标签口径与预算逐字节不变。
  const STEWARD_ACT_CONFIRM_LABEL_MAX = 32;     // confirm 族按钮文字 ≤32 字(要写得下「键=值」)
  const STEWARD_ACT_CONFIRM_VALUE_CHARS = 40;   // 确认面板里每个值的裁剪长度
  const STEWARD_ACTS_MAX = 3;                   // 一次回合按钮 ≤3 个
  const STEWARD_ACTIONS_MAX = 5;                // 一次回合最多执行 5 条 action(其余丢弃并如实标注)
  const STEWARD_DEBOUNCE_MS = 5000;             // 收件箱去抖窗口
  // 116-4(27 号文 §11.7 第 2 项「速查闭环」):速查线程的答案是【用户正在等的那一句】。让它也压满
  // 5 秒去抖,用户的体感就是「问一次要等两趟」。带 quick:true 的 done 行把本次去抖压到 0,其余事件
  // 仍走 5 秒 —— 它们是通知,不是有人正等着的答案。
  const STEWARD_QUICK_DEBOUNCE_MS = 0;          // 速查答案:不去抖,立刻起回合
  // 2026-10(智能自动的应答速度):队列里有【线程正卡在上面等】的权限/提问待决时,去抖压到 1 秒。
  // 那条线程此刻停着,5 秒去抖加上轮询间隔是「管家代批要等半分钟」的大头;1 秒仍够把同一阵涌来的
  // 几条待决并成一个回合(真机里一个回合内连发的工具请求彼此相隔远小于 1 秒)。其余通知照旧 5 秒。
  const STEWARD_BLOCKING_DEBOUNCE_MS = 1000;
  // 2026-10(用户:「用户在看提问、权限,管家被立刻唤醒也不要插手」):用户正看着的那几条待决,回合排空器先扣在
  // 回合队列外(13q stewardHoldViewedEvents),每 5 s 拿当时的在场重判一次;扣着的条数有上限(老的先丢 —— 丢的
  // 只是「管家替你处理」的那次机会,收件箱里的那一行与安静卡都还在)。
  const STEWARD_VIEW_RECHECK_MS = 5000;
  const STEWARD_VIEW_HELD_MAX = 200;
  const STEWARD_NO_PROGRESS_MAX = 5;            // 连续 5 次收件箱回合零 acts 零 actions -> 退避
  const STEWARD_VISIT_DIGEST_MAX = 5;           // 到访摘要 ≤5 条人话
  const STEWARD_PENDING_LIST_MAX = 20;          // 到访返回的待决列表上限
  const { STEWARD_TURN_WINDOW_MS, STEWARD_TURN_DAY_MS } = require('./steward-core.cjs');
  const STEWARD_PREEMPT_WAIT_MS = 15000;        // 抢占后等在途回合收尾的上限
  // 117l D3(§11.9;用户第四轮走查第 6 条「为啥输出完了还显示『在忙上一件』;要能让用户连续发消息」):
  // 用户回合撞用户回合时【真】排队等前一个收尾的上限。修前是一发 Promise.race(15s) 之后【不复查】,
  // 超时就带着一个还在写正文的回合再开一个 —— 两个回合同时写管家会话正文,后一条把前一条盖掉。
  const STEWARD_USER_QUEUE_WAIT_MS = 5 * 60 * 1000;
  // ── 116-2b 自理动作(§3.3 自理清单的【真实执行】)──────────────────────────────────────────
  const STEWARD_SELF_SERVE_ATTEMPT_MAX = 2;    // 同一目标连续 2 次自理动作后仍失败 -> 停自动、只提议
  const STEWARD_SELF_SERVE_RETRY_WINDOW_MS = 60 * 60 * 1000; // 同一目标本小时只自动重试一次
  const STEWARD_SELF_SERVE_PER_TURN_MAX = 3;   // 一个收件箱回合最多自理 3 个目标(其余进回合层)
  // ── 「回合收了但任务没做完」的自动续跑(stewardAutoActions.continueUnfinished)的上限 ─────────────────
  // 防死循环烧钱,两道,都按【同一条线程连续自动续跑】数,线程自己正常收工(不再未完成)就清零:
  //   · 有计划(todo)的线程:最多连续续 STEWARD_CONTINUE_PLAN_MAX 次,且【每一次续跑之后计划都要往前走】
  //     (已完成步数增加)—— 续了一轮计划纹丝不动就停,不再续;
  //   · 没有计划、只靠「上次任务未完成」横幅判据(回合被工具次数/预算截断)的线程:没有进度可量,
  //     只续 STEWARD_CONTINUE_NOPLAN_MAX 次。
  // 超过上限的那一次不是静默放弃:降级成一条提议按钮,并落一行行动流水(见 stewardContinueUnfinishedGate)。
  const STEWARD_CONTINUE_PLAN_MAX = 5;
  const STEWARD_CONTINUE_NOPLAN_MAX = 2;
  const STEWARD_CONTINUE_FRESH_MS = 6 * 60 * 60 * 1000;   // 上次自动续跑过去这么久,再遇到没做完就当全新的一次,账从 0 数
  const STEWARD_CONTINUE_PROMPT = '请继续完成上一个未完成的任务。';   // 与前端「继续」横幅发的那一句同文(chat.resume.prompt)

  // ── 到访摘要的五类人话(确定性归纳,不调模型;§8.9「每次打开只汇报」)──────────────────────────
  const STEWARD_DIGEST_KIND_TEXT = Object.freeze({
    needs_you: n => `${n} 条线程在等你拿主意`,
    failed: n => `${n} 条线程出错了`,
    done: n => `${n} 条线程收工了`,
    stalled: n => `${n} 条线程停住了`,
    budget: n => `${n} 条线程用完了预算`,
    // 121-K3(34 号文 §4.4「交接」):第六类。措辞用「交给你盯」而不是「交给你」—— 交接的是注意力,
    // 不是所有权:用户随时可以再坐回那条线程,那时 §4.5 的在场门会让管家自动松手。
    adopted: n => `${n} 条线程刚交给你盯`,
    // 123-M2(37 号文 §3.5):第七类。措辞是「到点了」而不是「有 N 条提醒」—— 这一类不需要用户
    // 回答任何东西,它只是把「你自己排的那件事发生了」说一遍(到点提醒、错过跳过、连败熔断三件
    // 都走它,共同点就是「一句事实」)。
    reminder: n => `${n} 件定时任务到点了`,
  });

  // ── 可由 actions 执行的写工具 -> StewardHooks 实现键。白名单即闸门:不在表里的工具名一律拒绝
  //    (读类工具没有出现在这里的理由 —— 模型要读就自己在回合里调工具,不该经 actions 绕一圈)。
  // ── 125-P1(42 号文 §1 ②):失败的原因与下一步,由工作台给,不由模型编 ────────────────────────
  // 取证:`errorClass` 在 13o(提示词)、13p(动作)、13m(共享面)与整个管家前端里 grep 零命中 ——
  // 它唯一的去处是收件箱事件那句摘要里的一个括号,于是模型看见的是 `会话第 3 回合失败(idle_timeout)`
  // 这串原始机器词,「这是什么意思、该怎么办」全靠它自己编。而工作台自己有一张写好了「下一步」的
  // 表(06 的 ERROR_CLASSES,已经上 /api/status 给 2.0 的错误卡用),就在隔壁。
  //
  // 本函数是管家侧唯一的取话口:查既有表,查不到就【如实说未知】并把原词带上 —— 不许在这里
  // 编第二套解释,也不许把不认识的类悄悄说成「执行失败」(那是把不知道说成知道)。
  // 返回 '' 表示这条事件根本没带类别(不是「不知道」,是「没这回事」),调用方据此整段不出现。
  function stewardFailureExplain(errorClass) {
    const raw = stewardSanitizeText(errorClass);
    if (!raw) return '';
    const row = (ERROR_CLASSES && Object.prototype.hasOwnProperty.call(ERROR_CLASSES, raw)) ? ERROR_CLASSES[raw] : null;
    // 「表里没这一条」与「表里有但没写人话」是同一件事:我们说不出它是什么。合成一个出口,
    // 于是这句话在全仓只有一种写法(静态锁 ⑧f 按「恰一处」数它)。
    const zh = row ? stewardSanitizeText(row.zh) : '';
    if (!zh) return `未知类别(${raw})`;
    const next = row ? stewardSanitizeText(row.next) : '';
    return next ? `${zh} · 下一步:${next}` : zh;
  }

  // 落点说明:本函数原想放在 06i(管家纯函数都住那儿),但 06i 排在 06 之前 —— 06/07/09/10/13* 都依赖
  // 06i,让 06i 反过来读 06 的 ERROR_CLASSES 会造出一圈循环边(依赖图 --check 当场报了 7 条)。
  // 于是落在 13m 这个「管家运行器共享面」:它本来就是回合层文本表的家,读 06 是干净的后向边。
  const STEWARD_ACTION_HOOKS = Object.freeze({
    steward_thread_new: 'threadNew',
    steward_thread_continue: 'threadContinue',
    steward_thread_rename: 'threadRename',
    // 129e:它在非 auto 档一定回 propose_required -> 被降级成一枚按钮 -> 用户按下走这张表找实现。
    // 不进表 = 「管家提了『换个目录』,按下去报 not_allowed」(静态锁 ①e 正是为这个坑立的)。
    steward_thread_workspace: 'threadWorkspace',
    steward_thread_prioritize: 'threadPrioritize',   // 116h:§8.10 看板每行的「提升优先级」按钮
    steward_decide: 'decide',
    steward_run_action: 'runAction',
    steward_thread_stop: 'threadStop',               // 117m-A4:线程级停止(不在表里 = 按钮按下去 4xx)
    // 2026-10 工具走查:插话补充在无人值守时也过 relay + 权限档两道闸,会回 propose_required → 进表(①e)。
    steward_thread_note: 'threadNote',
    steward_memory_write: 'memoryWrite',
    steward_memory_veto: 'memoryVeto',
    // 116-2e:两个「须确认」的写工具。它们在模型回合里一定回 propose_required(ctx 里没有
    // userPressed),被 stewardDowngradeActions 降级成一个按钮;用户按下那个按钮走
    // POST /api/steward/act,那条路径才置 ctx.userPressed = true。
    steward_config_set: 'configSet',
    steward_skill_toggle: 'skillToggle',
    // 117z-E2b 提交①(27 号文 §11.21.7 债 ①):线程权限。E-手① 时它只降档、从不 propose_required,
    // 不进表没关系;E-手② 给它加了 capabilities.desktop,desktop:true 在【任何】档位都回 propose_required
    // -> 被降级成按钮 -> 用户按下去经这张表找实现;不在表里 = 13q 查不到 -> not_allowed 4xx,
    // 生产形状是「管家说要开桌面,按钮出来,按了报错」。与 config_set / skill_toggle 同一个「须确认」
    // 模具:只有 13q 那条路置 ctx.userPressed = true,13k 只在 desktop:true 那一支上读它。
    steward_thread_permission: 'threadPermission',
    // 124 走查(用户 2026-09-15 真机:「就按这个排」按下去 —— 没做成: steward_schedule_create
    // 不能作为 act 执行)。123-M2 新增六个定时任务工具时登记了 schema(13f)/handler(12)/tier 与
    // pack(07)【三处】,漏了这第四处 —— 而 create 与 delete 自己在无人值守时就回 propose_required,
    // 被 stewardDowngradeActions 降级成按钮,按下去必然 not_allowed。**同一个坑这是第三次**
    // (thread_stop 117m-A4、thread_permission 117z-E2b),所以这一刀连带加了一把机械锁:
    // steward-tools.static ①e —— 实现里会回 propose_required 的管家工具必须在本表里。
    // 五个【写类】都进表(list 是只读,按表头那条纪律「读类工具没有出现在这里的理由」不进):
    // pause/resume/run_now 不回 propose_required,锁不要求它们,但模型照样能把它们提成一枚按钮
    // (acts 不经这张表过滤),不进表就是同一种「按了报错」。
    steward_schedule_create: 'scheduleCreate',
    steward_schedule_pause: 'schedulePause',
    steward_schedule_resume: 'scheduleResume',
    steward_schedule_run_now: 'scheduleRunNow',
    steward_schedule_delete: 'scheduleDelete',
  });

  // 降级成按钮时的人话标签(§8.4「话＋一行按钮」:按钮上写用户要做的那件事,不写工具名)。
  const STEWARD_DECIDE_LABELS = Object.freeze({ allow: '允许', deny: '拒绝', approve: '批准', reject: '驳回', answer: '回答' });
  const STEWARD_RUN_ACTION_LABELS = Object.freeze({ pause: '暂停', resume: '继续', stop: '停止', retry_node: '重试', steer_node: '插话' });
  const STEWARD_TOOL_LABELS = Object.freeze({
    steward_thread_new: '新开线程', steward_thread_continue: '接着办', steward_thread_rename: '改标题',
    steward_thread_workspace: '换工作目录',
    steward_memory_write: '记下', steward_memory_veto: '别记',
    steward_thread_prioritize: '插到最前',
    steward_thread_stop: '暂停这条线程',                            // 117m-A4
    steward_thread_note: '补一句',
    steward_config_set: '改设置', steward_skill_toggle: '改技能',   // 116-2e
    // 117z-E2b 提交①:这是行动流水与兜底用的总称;真正降级成按钮的只有 capabilities.desktop === true
    // 那一支,13o 的 stewardActLabel 按 args 把它写成「给它开桌面」(按钮上写用户要做的那件事,§8.4)。
    steward_thread_permission: '改线程权限',
    // 124 走查:降级按钮与 ※ 脚注上写用户要做的那件事,不吐 steward_schedule_* 这些内部 id。
    steward_schedule_create: '排上', steward_schedule_pause: '先停一停', steward_schedule_resume: '继续排',
    steward_schedule_run_now: '现在就跑一次', steward_schedule_delete: '删掉这条定时',
  });

  return {
    STEWARD_VISITS_DIR, STEWARD_VISIT_SCHEMA, STEWARD_VISITS_KEEP, STEWARD_INBOX_EVENTS_PER_TURN,
    STEWARD_INBOX_EVENT_CHARS, STEWARD_INBOX_DELIVERABLE_CHARS, STEWARD_INBOX_MESSAGE_CHARS,
    STEWARD_MEMORY_BLOCK_CHARS, STEWARD_MEMORY_VETOED_BLOCK_CHARS, STEWARD_MEMORY_VETOED_MAX,
    STEWARD_SAY_TARGET, STEWARD_SAY_CEILING, STEWARD_WHY_MAX, STEWARD_ACT_LABEL_MAX,
    STEWARD_ACT_CONFIRM_LABEL_MAX, STEWARD_ACT_CONFIRM_VALUE_CHARS, STEWARD_ACTS_MAX, STEWARD_ACTIONS_MAX,
    STEWARD_DEBOUNCE_MS, STEWARD_QUICK_DEBOUNCE_MS, STEWARD_BLOCKING_DEBOUNCE_MS, STEWARD_VIEW_RECHECK_MS,
    STEWARD_VIEW_HELD_MAX, STEWARD_NO_PROGRESS_MAX, STEWARD_VISIT_DIGEST_MAX, STEWARD_PENDING_LIST_MAX,
    STEWARD_TURN_WINDOW_MS, STEWARD_TURN_DAY_MS, STEWARD_PREEMPT_WAIT_MS, STEWARD_USER_QUEUE_WAIT_MS,
    STEWARD_SELF_SERVE_ATTEMPT_MAX, STEWARD_SELF_SERVE_RETRY_WINDOW_MS, STEWARD_SELF_SERVE_PER_TURN_MAX,
    STEWARD_CONTINUE_PLAN_MAX, STEWARD_CONTINUE_NOPLAN_MAX, STEWARD_CONTINUE_FRESH_MS, STEWARD_CONTINUE_PROMPT,
    STEWARD_DIGEST_KIND_TEXT, stewardFailureExplain, STEWARD_ACTION_HOOKS, STEWARD_DECIDE_LABELS,
    STEWARD_RUN_ACTION_LABELS, STEWARD_TOOL_LABELS,
  };
}

module.exports = { createStewardRunnerPolicy };
