'use strict';
import { createDeadlinePoll } from './deadline-poll.js';

import { derivePresence, presenceLabelKey } from './steward-presence.js';
import { createStewardConversation } from './steward-conversation.js';
import { createStewardComposer } from './steward-composer.js';
import { createStewardDrawer, STEWARD_NEW_THREAD_EVENT } from './steward-drawer.js';
import { createStewardSettingsDomain } from './steward-settings.js';
import { createStewardBoard, STEWARD_FOCUS_THREAD_EVENT } from './steward-board.js';   // 2026-09-24：线程头「回到管家」派的焦点事件名从同一条 import 取（同一份登记，不另起第二条 import 行）
import { createThreadHead } from './thread-head.js';
import { createQuietCard } from './quiet-card.js';
import { createStewardDecisions } from './steward-decisions.js';
import { toast } from './util.js';   // 123-M2：安静卡「稍后」建不成那条 reminder 时的一句提示
import { stewardEscapeStack, byId, STEWARD_POLL_MS_MIN, STEWARD_POLL_MS_DEFAULT, STEWARD_POLL_MS_CONNECTED, STEWARD_POLL_DUE_SLACK_MS as POLL_DUE_SLACK_MS } from './steward-chips.js';   // 117j UX-F3：Esc 逐层的唯一监听点；33 号文 §4：轮询常量（下限/默认/容差）也只有那一份；121-K2b：事件流连着时的兜底节拍同源；轮询生命周期（启停／门控）同一份
// 33 号文 §4「`steward-shell.js:92,105,108`」：壳模式本机偏好只有一份定义，byId 只有
// steward-chips.js 那一份 —— 本文件两者都不再自带。121-K1（34 号文 §8.2）：那份定义随交办台退役
// 从 preview-shell.js 搬到叶子 js/shell-mode.js，本文件只改 import 来源，取法一个字未变。
import { SHELL_MODE_STORAGE_KEY } from './shell-mode.js';


export const STEWARD_SHELL_SLOT_IDS = Object.freeze([
  'stewardHeader',
  'stewardFeed',
  'stewardComposer',
  'stewardStatus',
]);


// 骨架齐备 = 同级容器在，且四个空位都在。纯 DOM 判定，无副作用，测试与 UI 共用同一口径。
export function stewardShellDomReady(doc = globalThis.document) {
  if (!doc || typeof doc.getElementById !== 'function') return false;
  if (!doc.getElementById('stewardShell')) return false;
  return STEWARD_SHELL_SLOT_IDS.every(id => Boolean(doc.getElementById(id)));
}

// 管家开关：读的是 GET /api/status 回来的 config（provider-settings.refreshStatus 落进 state.config）。
// 后端零改动 —— `stewardEnabledV1` 本来就在 maskProviders(config) 的输出里。
export function stewardEnabledInConfig(config) {
  return Boolean(config) && config.stewardEnabledV1 === true;
}

export function createStewardShellDomain({
  // api / closeSettings / now 在 117a 全程未被调用：按 preview-shell 的注入形状先把口子留好，
  // 117c 起的管家对话（取数、切壳后关设置、消息时间戳）直接接在这三个上，不必再动组合根。
  api = async () => null,
  state = null,
  t = key => key,
  applyShellMode = null,
  closeSettings = () => {},
  now = () => new Date(),
  // 121-K4：左栏搜索（Ctrl+K）的后端内容搜索结果快照（session-experience 算好的 { query, results }）。
  // 缺省返回 null＝没有后端命中，左栏回落到按标题子串过滤（见 steward-board.js 的 railFilter）。
  searchState = () => null,
  // 117d：抽屉的「2.0 视窗」要「切到经典壳并选中该会话」，openSession 是经典壳既有的那一个
  // （session-experience.js 导出，preview-shell 的 openSelectedInClassic 用的也是它）。
  openSession = async () => {},
  // 121-K5（§2.7／§3.2）：「在工作台打开」＝切视角 ＋ openSession，一处实现住 js/shell-mode.js。
  // 本文件四个调用点（对话流交付卡、左栏行、焦点栏、抽屉）全部转调它 —— 退役的
  // steward-classic-window.js 那条带返回标记的路自此不存在。缺省回落只切视角。
  openInWorkbench = async sessionId => { if (typeof applyShellMode === 'function') applyShellMode('classic'); return String(sessionId || ''); },
  // 121-K5（§3.1）：2.0 模型弹层独有的三件全局事（思考／推理强度、删自定义模型、刷新与管理
  // 服务商），由组合根从 navigation-controls.js 递进来，挂在线程头那组 chip 的模型菜单尾部。
  modelMenuExtras = null,
  // 121 走查1-⑤：线程头那组 chip 改完这条线程的档之后，经典壳那一侧还有一批读面要跟着重画
  // （空态「当前引擎：…」、#statusLine 的 title、上下文电量、引擎相关的 composer 按钮）。
  // 它们的重画口都在组合根，本文件只做转交（与 modelMenuExtras 同一条纪律：管家域不认识那些面）。
  onSessionMetaChanged = () => {},
  // 117e：设置写口与「打开设置的某个页签」。前者是 provider-settings 既有的那一个（POST /api/config
  // 的唯一封装），后者让头像菜单三项与盾牌的二次确认能直达「管家」页签。
  saveConfigPartial = async () => false,
  openSettingsTab = () => {},
  // 117s-C（用户第九轮走查⑦）：全仓唯一那条 markdown＋净化路径（chat-render-primitives.js 的
  // renderMarkdownInto／highlightIn）。117c 那会儿本文件写着「组合根 app.js 一行不加」——那说的是
  // 117c 自己不需要新依赖；而经典壳六个消费面拿到渲染器【都】是在组合根注入的，管家壳要复用
  // 同一条净化通道就得走同一条路。本文件只做转注入（不 import 渲染器，D2 的 import 白名单不变）。
  renderMarkdownInto = null,
  renderFilePreviewInto = null,
  highlightIn = null,
  // 122-L1b（36 号文 §2.13）：首跑向导。组合根手里那一个（session-experience.js 的
  // openOnboardingWizard，工作台空态那枚「开始引导」点的也是它），本文件只做转注入。
  openOnboardingWizard = null,
  // 121-K2b（34 号文 §6.2）：组合根那【一条】事件流。本文件用它三件事：①壳层状态轮询在连接时
  // 降到 30 s 兜底；②`steward.say` 到达就拉一次状态（avatar 与对话流的追加都挂在那一处，不新开
  // 第二条请求路）；③把同一条实例转给看板与抽屉（它们自己不建连接）。
  eventStream = null,
} = {}) {
  // 117n-M1：byId 从 steward-chips.js import（六个消费方零本地重复定义）；33 号文 §4 起本文件也收编 ——
  // 原来那一份 `globalThis.document ? globalThis.document.getElementById(id) : null` 与它逐字同义。
  const setStatusText = key => {
    const node = byId('stewardStatus');
    if (node) node.textContent = t(key);
  };
  // 117k（用户走查②）：恢复位只写不清 —— 开机 config 还没到时先 fail-closed 写了「管家还没打开，
  // 已回到经典布局」，等 config 到了、壳真的进了管家，那句话还挂在底部（实测 12 秒后仍在），
  // 而它是 role="status" aria-live，读屏也会念一遍。准入判定通过就把它擦掉。
  const clearStatusText = () => {
    const node = byId('stewardStatus');
    if (node && node.textContent) node.textContent = '';
  };
  const setStoredMode = mode => {
    try { localStorage.setItem(SHELL_MODE_STORAGE_KEY, mode); } catch { /* local preference may be unavailable */ }
  };
  const storedMode = () => {
    try { return localStorage.getItem(SHELL_MODE_STORAGE_KEY) || ''; }
    catch { return ''; }
  };
  const syncModeSelector = mode => {
    const select = byId('cfgShellMode');
    if (select) select.value = mode;
  };

  // ③ 模块依赖缺失：没有 applyShellMode 就没有单一写入点，此时唯一安全的动作是把壳钉死在经典。
  const dependenciesReady = typeof applyShellMode === 'function' && typeof t === 'function';

  function recoverStewardShell({ persist = true } = {}) {
    try { globalThis.document?.documentElement?.setAttribute('data-shell-mode', 'classic'); } catch { /* pre-DOM failure */ }
    if (persist) setStoredMode('classic');
    try { syncModeSelector('classic'); } catch { /* pre-DOM failure */ }
    try {
      if (!dependenciesReady) setStatusText('stewardShell.recovery.dependency'); // ③
      else if (!stewardShellDomReady()) setStatusText('stewardShell.recovery.missingShell'); // ②
      else setStatusText('stewardShell.recovery.disabled'); // ①
    } catch { /* pre-DOM failure */ }
    return 'classic';
  }

  if (!dependenciesReady) {
    recoverStewardShell();
    return Object.freeze({
      bindStewardShell: () => 'classic',
      canEnterSteward: () => false,
      isStewardMode: () => false,
      recoverStewardShell,
      syncStewardShellAvailability: () => 'classic',
      // 依赖缺失时壳整体 fail-closed 到经典，avatar 无处可画；derive 仍是纯函数原样导出
      // （§8.1 原则5「可退化」：调用方拿到的形状不变，只是永远读到 sleeping）。
      presence: Object.freeze({ derive: derivePresence, set: () => 'sleeping', current: () => 'sleeping' }),
      // 依赖缺失时抽屉也开不出来（它要 applyShellMode 才能切 2.0 视窗）：给一个同形的空壳，
      // 调用方（117h）拿到的键集不变，只是永远打不开。
      drawer: Object.freeze({ openThread: () => {}, closeDrawer: () => {}, isOpen: () => false }),
      // 117e：同理给一个同形空壳 —— 组合根照常能调 fillStewardSettings()，只是什么也不做。
      fillStewardSettings: () => false,
      openStewardPanel: () => '',
      settings: Object.freeze({ fillStewardSettings: () => false, openPanel: () => '', setStopped: () => false, isStopped: () => true }),
      // 117g/117h：同理给同形空壳 —— 依赖缺失时壳整体钉在经典，看板与 2.0 视窗都无处可去。
      // 121-K4：看板浮层的开合随它退役；空壳跟着改成左栏那几个口（组合根在 setRailRenderer 与
      // §2.9 的 sharedThreadId 两处会调 renderRail／syncRail／focusThreadId，键集必须同形）。
      board: Object.freeze({
        renderRail: () => 0, syncRail: () => false, refreshBoard: async () => 0,
        closeNow: () => false, focusThreadId: () => '',
      }),
      // 121-K5：117g 的 classicWindow 空壳换成线程头的空壳。「在工作台打开」不再住这儿（它进了
      // js/shell-mode.js，由组合根注入），所以空壳只剩线程头自己那两个口。
      threadHead: Object.freeze({ render: () => '', bandKey: () => 'threadHead.steward.seeing' }),
    });
  }

  function isStewardMode() {
    return globalThis.document?.documentElement?.getAttribute('data-shell-mode') === 'steward';
  }

  // 准入只看 ①②（27 号文 117a 设计）：开关开着、骨架齐备，才允许进管家壳。
  function canEnterSteward() {
    return stewardEnabledInConfig(state && state.config) && stewardShellDomReady();
  }

  // ── 117b：avatar 状态派生（§8.3）与状态轮询 ────────────────────────────────────
  const presenceInputs = {
    enabled: false, stopped: false, inflight: '', phase: 'idle', streaming: false,
    lastError: '', pendingCount: 0, needsYouCount: 0, typing: false,
  };
  let presenceState = derivePresence(presenceInputs);

  // data-state + 一次性类(.pulse/.shake) + aria-live 文字，三处一次写完。一次性类只在真正
  // 「切换到」那个状态的那一刻补上(entering 判定)，同一状态内的后续 setPresenceInputs(例如轮询
  // 又拿到一次 lastReply.error 相同的响应)不会打断正在播的动效。
  function renderPresence() {
    const next = derivePresence(presenceInputs);
    const entering = next !== presenceState;
    presenceState = next;
    const avatar = byId('stewardAvatar');
    if (avatar) {
      avatar.dataset.state = next;
      if (entering) {
        avatar.classList.remove('pulse', 'shake');
        if (next === 'waiting_you') { void avatar.offsetWidth; avatar.classList.add('pulse'); }
        else if (next === 'error') { void avatar.offsetWidth; avatar.classList.add('shake'); }
      }
    }
    // 117j W2-3：头部那枚 6px 状态点。头像跟着话走之后它是头部唯一的状态投影，读的仍是这一处
    // 算出来的 next —— 绝不另起一份判据（117b 的「三处一次写完」现在是四处，仍然只有一个真值）。
    const dot = byId('stewardPresenceDot');
    if (dot) dot.dataset.state = next;
    // 117j copy-P2-3：#stewardPresenceText 是 aria-live="polite" 的。轮询每一拍都会走到这里，
    // 而 textContent 只要被赋值（哪怕值一模一样）读屏就再念一遍 —— 空闲时它会每 5～15 秒念一次
    // 「空闲」。所以先比一次，真变了才写。
    const text = byId('stewardPresenceText');
    const label = t(presenceLabelKey(next), { detail: '' });
    if (text && text.textContent !== label) text.textContent = label;
    return next;
  }

  function setPresenceInputs(patch) {
    if (patch && typeof patch === 'object') Object.assign(presenceInputs, patch);
    return renderPresence();
  }

  function nudgeAvatar() {
    const avatar = byId('stewardAvatar');
    if (!avatar) return false;
    avatar.classList.remove('is-nudged');
    void avatar.offsetWidth;   // 强制重排：同一帧内摘了又加，不重排的话动画不会重放
    avatar.addEventListener('animationend', () => avatar.classList.remove('is-nudged'), { once: true });
    avatar.classList.add('is-nudged');
    return true;
  }

  // GET /api/steward/state 没有独立的 pending 字段(13h-steward-runner.js stewardRunnerState 只有
  // stopped/inflight/circuit/lastReply/queued/noProgress/arbiter)。117b 曾借 lastReply.acts 非空近似
  // 「有提议待批」；117c 改接真值 —— POST /api/steward/visit 回的 `pending[]` 就是仍待决的提议清单，
  // 由 steward-conversation.js 的 enterVisit() 直接写进 presence.pendingCount(每次进壳刷新一次)。
  // 轮询这一路因此【不再】碰 pendingCount，只管 stopped/inflight/lastError 三个真有的字段。
  // 117j W2-4：对话流已渲染到的最后一条 lastReply.at。空 = 还没轮询过一次（此时的 lastReply 属于
  // 进壳前，enterVisit 已经把它画进历史了，再追加一次就重了）。
  let lastReplyAt = '';
  let lastStateAt = 0;
  // 121-K2b：推送连着没有。断开时四处轮询各自回到今天的节奏（这就是「兜底」两个字的意思）。
  let streamConnected = false;

  // 节拍：壳可见【且】真有事情在跑时用 5 秒，否则仍按配置（默认 15 秒）。「有事情在跑」= 管家自己
  // 有在途回合，或看板那份行里有线程在跑 —— 后者看板每一拍都已经算过，这里只读它的句柄。
  // **后端的 stewardPollMs 下限一个字没动**：这是前端自己的节拍，不是配置。
  function boardNeedsYouCount() {
    try { return Number(board.needsYouCount()) || 0; } catch { return 0; }
  }
  // 走查 S-08：pendingCount 只在 enterVisit 写过一次（到访那一刻的快照），之后待决在别处处理完了它也不会减 ——
  // 头像于是一直停在「等你确认」。待决与「需要你的线程」是同一批事实（visit.pending 就是各线程的未决干预，行上的
  // needs_you 由它而来），所以看板每拿到新的一批行，就让头像的两个计数一起跟着看板那一份活计数走。
  // 计数仍只有看板 renderStatusLine 那一处在算；两个字段的写法由看板的 presenceCounts() 一次给齐（本文件不再多一处
  // 写「需要你的线程数」那个字段 —— steward-avatar.static I3 钉着它在壳层里只有「声明／取值／喂给 presence」三处）。
  // 只在看板【真的取到过行】之后才跟：挂在 onRowsChanged 上，进壳那一刻看板还没取回行时不会拿一个空的 0 冲掉到访快照。
  function syncPresenceFromBoard() {
    try { const result = setPresenceInputs(board.presenceCounts()); syncPolling(); return result; } catch { return presenceState; }
  }
  function stewardPollFast() {
    if (!isStewardMode() || (globalThis.document && globalThis.document.hidden)) return false;
    if (presenceInputs.inflight) return true;
    try { return board.hasRunningThread() === true; } catch { return false; }
  }
  function pollStewardTick() {
    const due = streamConnected ? STEWARD_POLL_MS_CONNECTED : (stewardPollFast() ? STEWARD_POLL_MS_MIN : pollIntervalMs());
    if (Date.now() - lastStateAt < due - POLL_DUE_SLACK_MS) return;
    return pollStewardState();
  }

  function pollStewardState() {
    if (typeof api !== 'function') return;
    const generation = conversation.conversationGeneration();
    return Promise.resolve(api('/api/steward/state')).then(response => {
      if (generation !== conversation.conversationGeneration() || conversation.resetInProgress()) return;
      if (!response || typeof response !== 'object') return;
      lastStateAt = Date.now(); syncPolling();   // 117j W2-4：节拍水位。落在这里而不是函数头 —— C3b 逐字钉住了函数头那两行。
      const lastReply = (response.lastReply && typeof response.lastReply === 'object') ? response.lastReply : null;
      setPresenceInputs({
        stopped: response.stopped === true,
        inflight: typeof response.inflight === 'string' ? response.inflight : '',
        lastError: (lastReply && lastReply.error) ? String(lastReply.error) : '',
        // 117m-A3:线程级「等你」进头像。读看板已经算好的那一份(它每一拍都在算 needs_you 行),
        // 与 hasRunningThread 同一个只读句柄先例 —— 不发第二条请求、不开第二个计数源。
        needsYouCount: boardNeedsYouCount(),
      });
      // 117e：头部常驻停机键与设置页的运行态读同一份真值，不各自再发一条请求。
      settings.setStopped(response.stopped === true);
      // Inbox and remote-owner turns load persisted messages by watermark; local submissions paint themselves.
      // 用户自己发的那一条是 sendToSteward 当场画的，再追加一次就重了；首次轮询也跳过（那一条
      // 属于进壳之前，enterVisit 已经画过）。
      const at = String((lastReply && lastReply.at) || '');
      if (at && at !== lastReplyAt) {
        const firstSeen = !lastReplyAt;
        lastReplyAt = at;
        // 117l-B2 ①：nudge 与 appendSince 同一道判据、同一分支 —— 有「线程回来了」这件事的
        // 那一刻才播，且必须在追加之前发（头像随即被 moveAvatarTo 搬到新那一行，先播后搬，
        // 光环跟着头像走）。用户自己发的那条回复走的是 sendToSteward，压根不进这个分支。
        if (isStewardMode() && (lastReply.trigger === 'external' || (!firstSeen && lastReply.trigger === 'inbox'))) { nudgeAvatar(); void conversation.appendSince(''); }
      }
    }).catch(() => { lastStateAt = Date.now(); /* 下一次期限重试 */ }).finally(() => { lastStateAt = Date.now(); syncPolling(); });
  }

  function pollIntervalMs() {
    const raw = Number(state && state.config && state.config.stewardPollMs);
    return Number.isFinite(raw) && raw > 0 ? Math.max(STEWARD_POLL_MS_MIN, raw) : STEWARD_POLL_MS_DEFAULT;
  }

  // 121-K2b（§6.2）：把那一条事件流接到壳层。**零新请求路**：`steward.say` 到达就走既有的
  // pollStewardState()（全文件唯一那处请求调用点，C3a/C3b 钉着），它自己会判「要不要 nudge、要不要
  // appendSince」—— 推送只是把「什么时候拉」从「每 5–15 秒猜一次」换成「它真说完了才拉」。
  // 连接状态只改 due（见 pollStewardTick），不改启停条件：syncPolling 的三重门控一个字没动。
  function bindEventStream() {
    if (!eventStream || typeof eventStream.on !== 'function') return false;
    eventStream.on('connection', payload => { streamConnected = Boolean(payload && payload.connected); syncPolling(); if (isStewardMode() && !globalThis.document?.hidden) void pollStewardState(); });
    streamConnected = typeof eventStream.isConnected === 'function' ? eventStream.isConnected() === true : false;
    eventStream.on('steward.say', () => { if (isStewardMode() && !globalThis.document?.hidden) void pollStewardState().finally(syncPolling); });
    quietCard.bind(eventStream); // 121-K6a：安静卡订阅 inbox.appended（§4.3），零新请求路
    return true;
  }

  const polling = createDeadlinePoll({
    shouldRun: () => isStewardMode() && !(globalThis.document && globalThis.document.hidden),
    delay: () => {
      if (streamConnected && !stewardPollFast()) return Infinity;
      const due = streamConnected ? STEWARD_POLL_MS_CONNECTED : (stewardPollFast() ? STEWARD_POLL_MS_MIN : pollIntervalMs());
      return Math.max(1, due - (Date.now() - lastStateAt));
    },
    tick: pollStewardTick,
  });
  // 唯一入口：轮询该开该关只由这一个判定决定——管家模式 且 页面可见。本文件别处一律不直接调
  // polling.start/polling.stop，只调 syncPolling（源码正则锚，见 dev-harness/steward-avatar.static.e2e.js）。
  function syncPolling() {
    polling.sync();
  }

  // typing 由输入框驱动 + 轮询/属性变化的两个触发点各接一次，绑定完立刻按当前实况刷一次
  // （覆盖「页面直接以 data-shell-mode=steward 启动」这个 MutationObserver 观察不到的初始态）。
  function bindPresence() {
    const input = byId('stewardComposerInput');
    if (input) {
      input.disabled = false; // 117b：可聚焦但仍不发送(发送归 117c)，仅用来测 listening 态
      const setTyping = () => setPresenceInputs({ typing: input.value.trim().length > 0 });
      input.addEventListener('input', setTyping);
      input.addEventListener('focus', setTyping);
      input.addEventListener('blur', () => setPresenceInputs({ typing: false }));
    }
    if (globalThis.MutationObserver && globalThis.document && globalThis.document.documentElement) {
      new MutationObserver(syncPolling)
        .observe(globalThis.document.documentElement, { attributes: true, attributeFilter: ['data-shell-mode'] });
    }
    if (globalThis.document) globalThis.document.addEventListener('visibilitychange', () => {
      syncPolling();
      if (isStewardMode() && !globalThis.document.hidden) void pollStewardState();
    });
    // U16 走查：运行时切语言（不刷新页面）时，「空闲」这类五态人话字面量是 renderPresence() 在
    // 上一次状态变化那一刻算好焊死的，presenceInputs 没变就再也不会重算 —— 于是停在旧语言。
    // i18n.js 的 setLocale 在 applyTranslations() 之后派一发全局 i18n:change（§ i18n.js 头注），
    // 这里听它重画一次：presenceState 没变但 label 会用新 activeLocale 重算，字面量因此跟上。
    try { globalThis.addEventListener('i18n:change', () => { renderPresence(); }); } catch { /* ignore */ }
    renderPresence();
    syncPolling();
  }

  // 设置页第三项的可选性随管家开关走：关时置灰并把「先打开管家」那句提示显出来。
  function syncSettingOption() {
    const enabled = stewardEnabledInConfig(state && state.config);
    const option = byId('cfgShellMode')?.querySelector('option[value="steward"]');
    if (option) option.disabled = !enabled;
    const hint = byId('stewardShellModeHint');
    if (hint) hint.hidden = enabled;
    return enabled;
  }

  // 组合根在 refreshStatus() 之后调用一次：config 到达前谁也不知道开关开没开，所以 bind 期的
  // 准入判断一律不落盘（persist:false，只把画面钉在经典）；真正把本机偏好改回 classic 的是这里。
  function syncStewardShellAvailability() {
    syncSettingOption();
    // 117b：avatar 的 enabled 输入跟 config refresh 同一节拍——config 到达前一律 sleeping(fail-closed)。
    setPresenceInputs({ enabled: stewardEnabledInConfig(state && state.config) });
    // 117c：config 到达后补一次到访判定。页面【直接以 data-shell-mode=steward 启动】时属性从没变过，
    // MutationObserver 观察不到；而 bind 期 state.config 还是空的，enterVisit 必然早退。ensureVisit
    // 的一次性门（每次进壳只到访一次）保证这里的补调不会把正在进行的对话清屏重画。
    syncConversation();
    if (canEnterSteward()) {
      clearStatusText();   // 117k：进得去就没有「回到经典」这回事，那句话不该再留在屏幕上
      // 配置就绪后才可恢复显式的管家偏好；新安装从工作台开始。
      const prefersClassic = storedMode() !== 'steward';
      if (!prefersClassic && !isStewardMode()) return applyShellMode('steward', { persist: false, focus: false });
      return isStewardMode() ? 'steward' : 'classic';
    }
    if (isStewardMode() || storedMode() === 'steward') return recoverStewardShell();
    return 'classic';
  }

  const presenceApi = Object.freeze({ derive: derivePresence, set: setPresenceInputs, current: () => presenceState });
  const conversation = createStewardConversation({
    api, state, t, presence: presenceApi, isStewardMode,
    // 117e：头像菜单的「设置／记忆／行动流水」三项（117c 那里只有「细节」）。菜单只负责调用，
    // 页签切换、滚动与取数全在 steward-settings.js 里。
    openStewardPanel: section => settings.openPanel(section),
    openExternalBotSetup: id => settings.openExternalBotSetup(id),
    // 117 走查（用户 2026-09-06）：主端点是命令行引擎时，对话区的「改用『某端点』」按钮经这里写
    // stewardProviderId（走设置域同一个 saveConfigPartial，对话区不碰 /api/config）。
    setStewardProvider: id => saveConfigPartial({ stewardProviderId: id }),
    // 121-K4：头像菜单末项「整体切到 2.0」退役（§2.2：视角切换只在顶栏分段钮一处）。
    // 117s-H：交付卡的「看全文」直接在工作台打开那条线程（与焦点栏那三处同一个入口）。
    // 121-K5：那个入口从 classicWindow.openClassicWindow 换成组合根注入的 openInWorkbench
    // （js/shell-mode.js 一处实现：切视角 ＋ openSession，不再有返回标记与返回带）。
    openClassicWindow: sessionId => openInWorkbench(sessionId),
    // 117s-C：转注入渲染器。对话区自己不 import 它（A2 锁：本域内相对路径），缺席时回落纯文本。
    renderMarkdownInto, highlightIn,
    renderFilePreviewInto,
    prepareDeliveryRevision: source => composer.beginDeliveryRevision(source),
    openOnboardingWizard,   // 122-L1b（36 号文 §2.13）：管家问候行下那枚「开始引导」，与工作台空态同一个入口
  });
  // 128h-J03:焦点＝右栏抽屉此刻那一条。drawer 在下面才建 —— 这里是个闭包,输入时才调(那时早已就位;
  // 真在建好之前被调到会抛 TDZ,composer 那一侧 try/catch 当「没有焦点」)。
  const composer = createStewardComposer({ api, state, t, isStewardMode, conversation,
    focusThreadId: () => (drawer && typeof drawer.currentSessionId === 'function' ? drawer.currentSessionId() : '') });
  const drawer = createStewardDrawer({ api, state, t, isStewardMode, applyShellMode, openSession });
  const decisions = createStewardDecisions({ api, t, isStewardMode, eventStream, openThread: id => openInWorkbench(id) });
  // 117e：设置页「管家」页签 + 头部的盾牌与停机键。它是【唯一】写全局 permissionMode 与管家配置的
  // 地方；四档表与全自动确认文案由它从 steward-chips.js import 复用，本文件不碰。
  // 117j UX-F1：总开关关掉的那一刻要立刻回经典。准入判定的单点就在本文件的
  // syncStewardShellAvailability（fail-closed 回退那一支也在它里面），设置域只负责在写完配置之后
  // 踢它一脚 —— 不给它第二份「能不能进管家壳」的判据。
  const settings = createStewardSettingsDomain({
    api, state, t, saveConfigPartial, openSettingsTab, presence: presenceApi,
    syncShellAvailability: () => syncStewardShellAvailability(),
  });
  // 123-M2（37 号文 §3.6）：定时任务展开的最近几次里，点产出线程在【如意内】打开它（不给路径）。
  // 迟绑定 setter —— 上面那一行构造被 steward-settings.static 逐字钉着。
  settings.setOpenThread(sessionId => { void openSession(sessionId); });
  settings.setExternalDraftImporter(item => composer.importExternalReference(item));
  // 121-K5：工作台视角的线程头（§2.5）。它接替 117g 的「2.0 视窗返回带」：不发取数请求，只读
  // state 与左栏已经取回来的那一行（迟绑定句柄 —— board 在它之后才构造），控件是同一份 chips 工厂。
  let boardHandle = null;
  // 2026-09-24（用户：「打开线程……默认直接打开工作台里的对应线程」的另一半）：从工作台回来要有明显的
  // 入口。线程头那枚「回到管家」＝切回管家视角 ＋ 把焦点落在【刚看的这条】（派 steward:focus-thread：
  // 右栏展开着就换成它；用户收着右栏就只让窄条亮一下，不强行展开）。
  // 视角属性可能在 View Transitions 的回调里才落地 —— 事件要等它落地再派（此刻派的话看板还在
  // 工作台视角，syncNow 判「没接住」会把抽屉以覆盖式开在工作台上）。一次性观察者，落地即断开；
  // 准入没过（applyShellMode 回落工作台）也断开，不留悬着的观察者。
  function backToSteward(sessionId) {
    const id = String(sessionId || '');
    const fire = () => {
      if (!id) return;
      try { globalThis.document.dispatchEvent(new CustomEvent(STEWARD_FOCUS_THREAD_EVENT, { detail: { sessionId: id } })); }
      catch { /* 无 CustomEvent 的宿主 */ }
    };
    if (isStewardMode()) { fire(); return 'steward'; }
    const root = globalThis.document && globalThis.document.documentElement;
    let watcher = null;
    if (globalThis.MutationObserver && root) {
      watcher = new MutationObserver(() => {
        if (!isStewardMode()) return;
        watcher.disconnect();
        fire();
      });
      watcher.observe(root, { attributes: true, attributeFilter: ['data-shell-mode'] });
    }
    const mode = applyShellMode('steward');
    if (mode !== 'steward' && watcher) watcher.disconnect();
    return mode;
  }
  const threadHead = createThreadHead({
    api, state, t,
    modelMenuExtras,
    onSessionMetaChanged,
    missionRowOf: sessionId => (boardHandle ? boardHandle.missionRowFor(sessionId) : null),
    refreshRows: () => (boardHandle ? boardHandle.refreshBoard() : Promise.resolve(0)),
    presenceState: () => presenceApi.current(),
    backToSteward,   // 2026-09-24：线程头「回到管家」
  });
  // 117h：一行状态 → 看板 → 「现在这一件」。「现在这一件」不另起抽屉，直接把 117d 那一份换成
  // docked 挂法（drawer.setMount），所以这里把 drawer 子域整个交给它。
  const board = createStewardBoard({
    api, state, t, isStewardMode, drawer, saveConfigPartial,
    openClassicWindow: sessionId => openInWorkbench(sessionId),
    // 121-K4（§2.3 点击语义）：左栏是两视角共用的那一份 DOM —— 工作台视角里点一行要真的把中栏
    // 换成那条线程，所以把组合根那一个 openSession 原样递下去（与抽屉的「在工作台打开」同一份实现）。
    openSession,
    // 121-K4：左栏搜索（Ctrl+K）读 2.0 那条内容搜索的结果快照。去抖与请求仍住 session-experience，
    // 这里只是把它的读口接上 —— 左栏不发第二发请求。
    searchState,
    // 117g/121-K5：左栏拿到新的一批行就让线程头重画 —— 任务名、线程数、来源、管家盯没盯、
    // 谁坐着，五样事实的唯一来源就是那批行（线程头因此零取数）。
    onRowsChanged: () => { threadHead.render(); syncPresenceFromBoard(); },
  });
  boardHandle = board;
  // 121-K6a（34 号文 §4.3）：安静卡。与线程头同一手法——不发第二发 /api/missions，问左栏已经取回来
  // 的那一行要任务名与色号（missionRowOf 迟绑定到 boardHandle，此刻 board 已经赋过值）；「去看」用
  // 组合根那一个 openSession（工作台视角本就在，不必再切视角）。事件订阅见下面 bindEventStream()。
  const quietCard = createQuietCard({
    api, state, t,
    shellModeOf: () => (isStewardMode() ? 'steward' : 'classic'),
    missionRowOf: sessionId => (boardHandle ? boardHandle.missionRowFor(sessionId) : null),
    openSession,
    // 123-M2（37 号文 §3.5）：「稍后」＝真 snooze。推迟多少分钟只有服务端那一份（01-config 已钳
    // [1,1440]，客户端不抄第二份）；建不成时 toast 一句、卡不动（成功才收卡）。
    snoozeMinutesOf: () => (state && state.config ? state.config.quietCardSnoozeMinutes : undefined),
    notifyFailure: message => toast(message, 'err'),
  });
  // 121-K2b：同一条事件流转给左栏与焦点栏。走 setter 而不是构造参数 —— 抽屉那一行构造被
  // steward-drawer.static I3 逐字钉着（新依赖一律迟绑定，与 setClassicWindow／setMissionRows 同纪律）。
  board.setEventStream(eventStream);
  drawer.setEventStream(eventStream);
  // 40 号文 P0③：设置页的定时任务块也订同一条流（只听 schedule.changed）—— 口袋与焦点栏早就订了，
  // 独独这一块要手动按刷新才看得见别处的改动。同一条迟绑定纪律：构造那一行被 F4 逐字钉着。
  settings.setEventStream(eventStream);
  // 117g：抽屉的「2.0 视窗」「看全文」「看改动」改走统一入口（构造那一行被 steward-drawer.static I3
  // 逐字钉住，新依赖一律走 setter —— 与 conversation.setPickTargetHandler 同一条迟绑定纪律）。
  drawer.setClassicWindow(sessionId => openInWorkbench(sessionId));
  drawer.setOpenDelivery(source => conversation.openDelivery(source));
  // 两个子域的唯一反向依赖：撤回／换一条之后打开输入区的候选列表。迟绑定（组合根先例
  // previewStreamSink），不让 conversation import composer。
  conversation.setPickTargetHandler(() => composer.openPicker());
  conversation.setHandOffDraftHandler(attempt => composer.restoreHandOffDraft(attempt));

  // 进壳即到访(§8.9「每次打开只汇报本次」)，出壳即收摊(清倒计时与去抖，零后台活动)。触发点与
  // syncPolling 同一路信号(data-shell-mode 的属性变化)，但各自独立观察 —— 轮询门控那一条的形状
  // 被静态锁逐字钉住，不能把两件事塞进同一个回调里。
  function syncConversation() {
    conversation.syncEngineGate();   // 走查 #1：没模型时输入框置灰；刚接上时把「已到访」复位，下一句 ensureVisit 重新到访
    if (isStewardMode()) conversation.ensureVisit();
    else { conversation.resetConversation(); composer.resetComposer(); }
  }

  function bindStewardShell() {
    // 117j UX-F3/F4：Esc 逐层的【唯一】 keydown。**必须排在 composer/drawer/board 的绑定之前** ——
    // 抽屉与看板各自那处 document keydown 保留着（它们是最底层），而 DOM 的同型监听按注册顺序触发，
    // 所以这一处先跑：栈里有浮层／菜单就关栈顶并 stopPropagation（下面那两路收不到），
    // 栈空了才轮到它们关抽屉／看板。判据与关闭器都不在这里 —— 各模块只 push 自己的那一个。
    if (globalThis.document) {
      globalThis.document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !isStewardMode()) return;
        if (stewardEscapeStack.handleEscape()) event.stopPropagation();
      });
      // 117k（用户要求）：点界面别的地方，所有菜单／浮层自动收回。与 Esc 同一个栈、同一处监听，
      // 每一层自己说「哪些节点算我的」。**必须捕获阶段**：同一次点击里，另一颗键的处理器可能
      // 【正要】打开一个菜单（比如撤回到点后的「换一条」）——冒泡阶段跑到这里时它刚开、而目标
      // 又在它外面，就会刚开就被关掉。捕获阶段先于目标处理器：那一刻它还没开，我们直接略过。
      globalThis.document.addEventListener('click', event => {
        if (!isStewardMode()) return;
        stewardEscapeStack.handleOutsideClick(event && event.target);
      }, true);
    }
    // 121-K4（§2.2／§2.7）：输入区那枚「经典模式」退役 —— 视角切换只在顶栏分段钮一处
    // （js/app-frame.js 调同一个 applyShellMode，本文件因此不再有第二个切换入口）。
    syncSettingOption();
    bindEventStream(); // 121-K2b：推送订阅（连接状态 + steward.say）；连接本身由组合根 start()
    bindPresence(); // 117b：avatar 的输入监听 + 模式/可见性观察者，见函数头注
    composer.bindStewardComposer();      // 117c：递送目标 chip / 候选列表 /「+」占位 / Enter 直接递
    drawer.bindStewardDrawer();          // 117d：线程抽屉（接 steward:open-thread / steward:focus-thread）
    // 117d 抽屉的「＋ 线程」→ 输入区 chip 变「→ 如意 · 在事项下新开」。抽屉不 import composer，
    // 靠这一条事件把两个子域接起来（与 setPickTargetHandler 的迟绑定同一纪律）。
    if (globalThis.document) {
      globalThis.document.addEventListener(STEWARD_NEW_THREAD_EVENT,
        event => composer.markNewInMission(event && event.detail && event.detail.missionId));
    }
    settings.bindStewardSettings();       // 117e：设置页控件 + 头部盾牌与常驻停机键
    threadHead.bindThreadHead();          // 121-K5：工作台线程头（一套 chip / 任务 › 线程 / 管家条）
    board.bindStewardBoard();             // 117h：一行状态 / 看板 / 「现在这一件」
    decisions.bind();
    conversation.bindStewardConversation(); // 117c：头像菜单的「细节」开关 + 进壳时的首次到访
    if (globalThis.MutationObserver && globalThis.document && globalThis.document.documentElement) {
      new MutationObserver(syncConversation)
        .observe(globalThis.document.documentElement, { attributes: true, attributeFilter: ['data-shell-mode'] });
    }
    return isStewardMode() ? 'steward' : 'classic';
  }

  return Object.freeze({
    bindStewardShell,
    canEnterSteward,
    isStewardMode,
    recoverStewardShell,
    syncStewardShellAvailability,
    // 117c/117h 复用：derive 是纯函数(可脱离本实例单独跑真值表)，set 驱动本实例的 DOM 渲染，
    // current 读当前已渲染的态(不重新派生，跟屏幕上看到的一致)。
    presence: presenceApi,
    conversation,
    composer,
    // 117e：组合根在 fillSettings() 里调 fillStewardSettings()（一行注入），面板本身归 settings。
    // 排在 drawer 之前，是为了让 117d 的 `steward-drawer.static I7`（锚「drawer 是导出对象的末项」）
    // 原样通过 —— 既有断言只加不改。
    settings,
    fillStewardSettings: () => settings.fillStewardSettings(),
    openStewardPanel: section => settings.openPanel(section),
    // 117g/117h：看板与 2.0 视窗子域（组合根一行不加；它们的依赖全在本文件内注入）。
    board,
    threadHead,
    // 121-K6a：安静卡（真夹具直接问 cardCount()/cardFor() 断言，不必解析卡片文案）。放在 drawer
    // 之前——steward-drawer.static I7 锚着「drawer 是导出对象的末项」，新导出一律插在它前面。
    quietCard,
    // 117d：117h「现在这一件」直接调 drawer.openThread(sessionId)，不再另起一份抽屉。
    drawer,
  });
}
