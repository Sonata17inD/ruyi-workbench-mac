#!/usr/bin/env node
'use strict';

// 第117波 117b 静态契约(27 号文 §5 117b 行/§8.3「avatar 状态与动效规格」)：管家 avatar 的七态
// 与 CSS 规则一一对应、reduced-motion 降级、DOM 结构（button/svg/ring/body/eyes/aria-live）、
// 零 canvas/WebGL/第三方动画库、零 innerHTML、零硬编码色、定时器只在 isStewardMode() 门控内、
// i18n 七键中英对称、新样式层的三处登记（styles.css @import / read-frontend-css 清单 / overlay 清单）。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const read = relative => fs.readFileSync(path.join(PUBLIC, ...relative.split('/')), 'utf8');
const html = read('index.html');
const stewardShell = read('js/steward-shell.js');
const stewardPresenceSrc = read('js/steward-presence.js');
const css = read('css/views/steward-avatar.css');
const styles = read('styles.css');
const zh = JSON.parse(read('locales/zh-CN.json'));
const en = JSON.parse(read('locales/en-US.json'));
const stewardBoard = read('js/steward-board.js');
// 架构还债批 3·D:载荷登记断言读打包器运行时遍历的那份数组(macos-runtime-files.js 被 require 时零副作用),
// 不再在打包器源码里找 'app/…' 字面量(表改成派生或换引号就静默失明)。
const overlayPayload = new Set(require(path.join(ROOT, 'ruyi-workbench', 'tools', 'macos-runtime-files.js')).filesFor('workbench'));
const readFrontendCss = fs.readFileSync(path.join(__dirname, 'read-frontend-css.js'), 'utf8');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

(async () => {

// ─── A 常量表：七态是唯一真源 ─────────────────────────────────────────────────────
const mod = await import(`data:text/javascript;base64,${Buffer.from(stewardPresenceSrc).toString('base64')}`);
const { STEWARD_PRESENCE_STATES } = mod;
ok(Array.isArray(STEWARD_PRESENCE_STATES) && STEWARD_PRESENCE_STATES.length === 7
  && Object.isFrozen(STEWARD_PRESENCE_STATES),
  'A1 STEWARD_PRESENCE_STATES 是冻结的七态');

// ─── B CSS 七态与 STEWARD_PRESENCE_STATES 一一对应 ────────────────────────────────
const cssStates = [...new Set([...css.matchAll(/\[data-state="([a-z_]+)"\]/g)].map(m => m[1]))];
ok(STEWARD_PRESENCE_STATES.every(state => cssStates.includes(state)),
  `B1 七态每态至少一条 [data-state] 规则(缺: ${STEWARD_PRESENCE_STATES.filter(s => !cssStates.includes(s)).join(',') || '无'})`);
ok(cssStates.every(state => STEWARD_PRESENCE_STATES.includes(state)),
  `B2 CSS 里没有枚举之外的 data-state(多出: ${cssStates.filter(s => !STEWARD_PRESENCE_STATES.includes(s)).join(',') || '无'})`);
for (const state of STEWARD_PRESENCE_STATES) {
  ok(new RegExp(`\\.steward-avatar\\[data-state="${state}"\\]`).test(css), `B3 ${state} 态有 .steward-avatar[data-state="${state}"] 规则`);
}
ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*animation: none !important;[\s\S]*transition: none !important;/.test(css),
  'B4 reduced-motion 分支存在且关闭 animation/transition');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'B5 avatar CSS 全部使用主题/语义 token，无硬编码色值');
ok(!/canvas|WebGL|webgl/.test(css) && !/canvas|WebGL|webgl/.test(html.slice(html.indexOf('id="stewardShell"'), html.indexOf('</section>', html.indexOf('id="stewardShell"')))),
  'B6 零 canvas/WebGL(CSS 与管家壳 DOM 均无)');

// ─── C DOM 结构：button/svg/ring/body/eyes/aria-live ─────────────────────────────
const headerStart = html.indexOf('id="stewardHeader"');
const headerEnd = html.indexOf('</header>', headerStart);
const header = html.slice(headerStart, headerEnd);
ok(/<button type="button" id="stewardAvatar" class="steward-avatar" data-state="idle"/.test(header),
  'C1 #stewardAvatar 是可聚焦的 <button>，初始 data-state="idle"');
ok(/<svg viewBox="0 0 100 100" aria-hidden="true">/.test(header), 'C2 SVG viewBox 100，装饰性(aria-hidden)');
ok(/<circle class="sa-ring" cx="50" cy="50" r="44">/.test(header), 'C3 环：circle.sa-ring r=44');
ok(header.includes('<g class="sa-body">') && header.includes('<path class="sa-slash"'), 'C4 头像保留动作主体与品牌斜杠');
ok(header.includes('<path fill-rule="evenodd"'), 'C5 字母 R 使用镂空字腔');
ok(/id="stewardPresenceText" class="steward-presence-text" aria-live="polite"/.test(header),
  'C6 #stewardPresenceText 是 aria-live="polite" 的状态文字（avatar 不可用时的文字等价）');
ok(/data-i18n-attr="aria-label:stewardShell\.avatarLabel"/.test(header), 'C7 avatar 的 aria-label 走 i18n');

// ─── D 零 innerHTML、模块内零第三方 import ────────────────────────────────────────
ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(stewardShell),
  'D1 steward-shell.js 零 innerHTML/insertAdjacentHTML/document.write');
const importLines = [...stewardShell.matchAll(/^import .*$/gm)].map(match => match[0]);
ok(JSON.stringify(importLines) === JSON.stringify([
  "import { createDeadlinePoll } from './deadline-poll.js';",
  "import { derivePresence, presenceLabelKey } from './steward-presence.js';",
  "import { createStewardConversation } from './steward-conversation.js';",
  "import { createStewardComposer } from './steward-composer.js';",
  "import { createStewardDrawer, STEWARD_NEW_THREAD_EVENT } from './steward-drawer.js';",
  // 117e：设置页「管家」页签 + 头部盾牌与常驻停机键。白名单加第五条（只加，形态不变：仍是
  // 本域内的相对路径、零第三方库、零裸包名）。
  "import { createStewardSettingsDomain } from './steward-settings.js';",
  "import { createStewardBoard, STEWARD_FOCUS_THREAD_EVENT } from './steward-board.js';   // 2026-09-24：线程头「回到管家」派的焦点事件名从同一条 import 取（同一份登记，不另起第二条 import 行）",
  // 121-K5（34 号文 §2.5／§3）：「2.0 视窗与返回带」那一片（steward-classic-window.js）退役，
  // 位置由工作台线程头接手（一套 chip ＋「任务 › 线程」＋ 管家条）。形态仍然不变：本域内相对
  // 路径、零第三方库、零裸包名。
  "import { createThreadHead } from './thread-head.js';",
  // 121-K6a（34 号文 §4.3）：安静卡——工作台里管家的唯一打扰形态。形态仍然不变：本域内相对路径、
  // 零第三方库、零裸包名。
  "import { createQuietCard } from './quiet-card.js';",
  "import { createStewardDecisions } from './steward-decisions.js';",
  // 123-M2（37 号文 §3.5）：安静卡的「稍后」改成真 snooze 之后，建不成那条 reminder 要 toast
  // 一句（成功才收卡）。toast 住 util.js（零 import 的叶子）。形态仍然不变：本域内相对路径、
  // 零第三方库、零裸包名。
  "import { toast } from './util.js';   // 123-M2：安静卡「稍后」建不成那条 reminder 时的一句提示",
  "import { stewardEscapeStack, byId, STEWARD_POLL_MS_MIN, STEWARD_POLL_MS_DEFAULT, STEWARD_POLL_MS_CONNECTED, STEWARD_POLL_DUE_SLACK_MS as POLL_DUE_SLACK_MS } from './steward-chips.js';   // 117j UX-F3：Esc 逐层的唯一监听点；33 号文 §4：轮询常量（下限/默认/容差）也只有那一份；121-K2b：事件流连着时的兜底节拍同源；轮询生命周期（启停／门控）同一份",
  "import { SHELL_MODE_STORAGE_KEY } from './shell-mode.js';",
]), `D2 steward-shell.js 的 import 只有本域内相对路径、零第三方库、零裸包名：实测 ${JSON.stringify(importLines)}`);
ok(stewardShell.includes("import { derivePresence, presenceLabelKey } from './steward-presence.js';"),
  'D3 derivePresence/presenceLabelKey 来自 steward-presence.js（渲染只是纯函数结果的落地）');

// ─── E 一次性动效类：进入态才补，且各只出现在对应状态里 ───────────────────────────
ok(/\.steward-avatar\[data-state="waiting_you"\]\.pulse \.sa-ring \{ animation: sa-pulse/.test(css),
  'E1 waiting_you 的一次性脉冲(.pulse)只在该态生效');
ok(/\.steward-avatar\[data-state="error"\]\.shake \.sa-body \{ animation: sa-shake/.test(css),
  'E2 error 的一次性摆动(.shake)只在该态生效');
ok(/if \(next === 'waiting_you'\) \{ void avatar\.offsetWidth; avatar\.classList\.add\('pulse'\); \}/.test(stewardShell)
  && /else if \(next === 'error'\) \{ void avatar\.offsetWidth; avatar\.classList\.add\('shake'\); \}/.test(stewardShell)
  && /const entering = next !== presenceState;/.test(stewardShell),
  'E3 renderPresence 只在真正切换到该态(entering)时才补一次性类，同态内重复渲染不重放动效');

// 117l-B2 ①（用户第五轮走查 1「线程返回信息给管家时，最好给 avatar 一个小动效」）：
// 第三个一次性类 .is-nudged。它【不是】第八个状态（B1/B2 的七态枚举一个字没动，见上面）——
// 线程回报时 data-state 多半仍是 idle，所以只能是类，不能是态。
ok(/\.steward-avatar\.is-nudged::after \{/.test(css)
  && /animation: sa-nudge-halo \.6s var\(--ease-out\) 1;/.test(css)
  && /@keyframes sa-nudge-halo \{/.test(css),
  'E4 nudge 的扩散光环是 .is-nudged::after（600ms 一次，零 DOM 节点）');
ok(/\.steward-avatar\.is-nudged \.sa-body \{ animation: sa-nudge-bob \.6s var\(--ease-out\) 1; \}/.test(css)
  && /@keyframes sa-nudge-bob \{[\s\S]{0,120}scale\(1\.06\)/.test(css),
  'E5 本体那次轻微起伏是 1 → 1.06 → 1 的一次性动画');
// reduced-motion 分支：光环留着、位移关掉。光环必须留 —— 摘类靠的是 animationend，
// 两个动画都被关掉的话事件永远不来，.is-nudged 会永远挂在头像上。
// 扫的是【剥掉注释】的 CSS：这一段的修法注释里逐字写了「光环（.is-nudged::after）因此照播」，
// 不剥的话写下纪律的那一句会把自己判红（与本仓其它 static 件同一条 stripComments 纪律）。
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
const reducedBlock = cssCode.slice(cssCode.indexOf('@media (prefers-reduced-motion: reduce)'));
ok(/\.steward-avatar\.is-nudged \.sa-body \{ animation: none !important; \}/.test(reducedBlock)
  && !/\.is-nudged::after/.test(reducedBlock),
  'E6 reduced-motion 下 .is-nudged 只做光环不做位移（光环留着，animationend 才回得来）');
// 触发点唯一性：nudge 只在壳层轮询判定 trigger==='inbox' 的那一分支里发一次。
ok(/lastReply\.trigger === 'external' \|\| \(!firstSeen && lastReply\.trigger === 'inbox'\)\)\) \{ nudgeAvatar\(\);/.test(stewardShell)
  && (stewardShell.match(/nudgeAvatar\(\)/g) || []).length === 2,
  'E7 nudgeAvatar 只有「定义 1 ＋ 调用 1」两处，调用点就在 trigger===\'inbox\' 那一分支');
ok(/function nudgeAvatar\(\) \{[\s\S]{0,420}addEventListener\('animationend'[\s\S]{0,120}\{ once: true \}\)/.test(stewardShell)
  && (stewardShell.match(/setTimeout\(/g) || []).length === 0,
  'E8 nudge 零计时器：类由 animationend 摘（steward-shell.js 仍然零 setTimeout）');
ok(!/nudge/.test(stewardPresenceSrc),
  'E9 nudge 一个字都没进 steward-presence.js —— 那是零 DOM 的纯投影，不该长出「播过没有」这种记忆');

// ─── F 定时器只在 isStewardMode() 门控内(重钉锚点，与 steward-shell.static.e2e.js C2/C3 呼应) ───
const setIntervalSites = (stewardShell.match(/setInterval\(/g) || []).length;
const clearIntervalSites = (stewardShell.match(/clearInterval\(/g) || []).length;
ok((stewardShell.match(/setInterval\(/g) || []).length === 0, 'F1 壳层没有固定 interval');
// 轮询生命周期收编（前端架构债第一批）重钉 F2／F3／F4：pollTimer ＋ startPolling／stopPolling 收进
// steward-chips.js 的 createPollLifecycle（壳层／看板／抽屉同一份）。钉的事不变：setInterval 住在起表
// 那一处且起表前先拉一次；clearInterval 住在停表那一处、停表把句柄归零（每次 start 都有对应的 stop
// 可清）；唯一入口 syncPolling 的门控第一件事是 isStewardMode()。
const chipsSrcF = read('js/steward-chips.js');
ok(stewardShell.includes('createDeadlinePoll({'), 'F2 壳层使用共享期限调度器');
ok(stewardShell.includes('if (streamConnected && !stewardPollFast()) return Infinity;'), 'F3 在线空闲时不安排唤醒');
ok(/function syncPolling\(\) \{\s*polling\.sync\(\);\s*\}/.test(stewardShell)
  && /shouldRun: \(\) => isStewardMode\(\)/.test(stewardShell),
  'F4 唯一入口 syncPolling 第一件事就是 isStewardMode() 判定（门控 shouldRun 打头即 isStewardMode()）');
ok(stewardShell.includes('new MutationObserver(syncPolling)') && stewardShell.includes("addEventListener('visibilitychange', () =>"), 'F5 模式变化和可见性变化都重算期限，恢复可见补快照');

// ─── G i18n：presence 七键中英对称，且不提前暴露内部代号 ──────────────────────────
const presenceKeysZh = STEWARD_PRESENCE_STATES.map(state => `stewardShell.presence.${state}`);
ok(presenceKeysZh.every(key => typeof zh[key] === 'string' && zh[key].length > 0),
  'G1 zh-CN 七个 stewardShell.presence.* 键齐备且非空');
ok(presenceKeysZh.every(key => typeof en[key] === 'string' && en[key].length > 0),
  'G2 en-US 七个 stewardShell.presence.* 键齐备且非空');
ok(presenceKeysZh.every(key => !/Pretender|3\.0/.test(String(zh[key])) && !/Pretender|3\.0/.test(String(en[key]))),
  'G3 presence 文案不提前暴露内部代号与保留大版本号');
ok(typeof zh['stewardShell.avatarLabel'] === 'string' && typeof en['stewardShell.avatarLabel'] === 'string',
  'G4 avatarLabel 键中英齐备');

// ─── H 新样式层三处登记：styles.css @import / read-frontend-css 清单 / overlay 清单 ────
ok(styles.includes('@import url("/css/views/steward-avatar.css");')
  && html.includes('<link rel="stylesheet" href="/css/views/steward-avatar.css" />'),
  'H1 styles.css @import 与 index.html 直链同步收录 steward-avatar.css');
ok(readFrontendCss.includes("'css/views/steward-avatar.css',"),
  'H2 read-frontend-css.js 的 CSS_PAYLOAD_GROUPS 收录 steward-avatar.css');
ok(overlayPayload.has('app/public/css/views/steward-avatar.css') && overlayPayload.has('app/public/js/steward-presence.js'),
  'H3 离线包清单收录 steward-avatar.css 与 steward-presence.js');

// ─── I 117m-A3：线程级「等你」真的进头像（needsYouCount 修前是个死字段）──────
// derivePresence 早就把 needsYouCount>0 判成 waiting_you，但全仓没有一处【写】它 —— 于是用户那 14 条
// permission 挂在线程上时，头像照旧一副没事人的样子（用户第六轮走查⑤⑥ 的另一半）。
// 这三条钉住「有一个写口、且它读的是看板已经算好的那一份」，不许再退回死字段。
ok(stewardBoard.includes('needsYouCount: () => needsYouIds.length,'),
  'I1 看板开放只读句柄 needsYouCount()，值就是状态行算出的那份名单长度（不新开计数源）');
ok(stewardShell.includes('needsYouCount: boardNeedsYouCount(),') && stewardShell.includes('function boardNeedsYouCount()'),
  'I2 壳层把它喂进 setPresenceInputs（needsYouCount 有且只有这一个写口）');
ok((stewardShell.match(/needsYouCount/g) || []).length === 3,
  'I3 壳层里 needsYouCount 恰好三处：声明、取值函数、喂给 presence（没有第二条拉取路径）');

console.log(`\nSTEWARD AVATAR STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
