#!/usr/bin/env node
'use strict';
// 128b(48 号文 §2-b)静态锁:会话「读-改-写」只走 mutateSession,旁车／驱动器过撤回闸,撤回相关的码有人话。
//
// 为什么是普查而不是「凡是 saveSession 都要 X」:哪一处是「回合存自己」(被闸丢掉是对的)、哪一处是「请求／后台读改写」
// (被闸丢掉就是回了一句假话),机器分不出来 —— 这是判断题。所以钉的是【普查数】:各模块里 saveSession( 的调用个数
// 与下面那张表逐项相等;谁新加一处,这里当场红,红的那句话告诉他回来做这道判断题(读改写 → mutateSession)。
// 另外逐个点名 128b 改过的那十一处,钉住「它们真的走 mutateSession」,免得普查数碰巧对上而改法被撤回。
const fs = require('fs');
const path = require('path');
const { functionBlock } = require('./lib/source-slice');
const SRC = path.join(__dirname, '..', 'ruyi-workbench', 'app', 'src');
let fail = 0;
const ok = (c, label) => { if (c) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
const read = n => fs.readFileSync(path.join(SRC, n), 'utf8');
const codeLines = text => text.split('\n').map(l => l.replace(/\/\/.*$/, ''));

// ① 普查:各模块 saveSession( 的调用个数(128b 之后)。
const CENSUS = {
  '../backend/session-rewind.cjs': 1, // 撤回成功的严格提交。
  '../backend/session-transactions.cjs': 2, // 读改写与回合收尾的共享提交出口。
  '../backend/session-persistence.cjs': 3, // 装载归一化、旧格式迁移与迁移备份恢复。
  '02-session-store.js': 2, // 创建与会话元数据存储端口。
  '../backend/session-meta-updates.cjs': 2, // 元数据立即／延后提交，使用撤回代数闸与有界重放。
  '../backend/mission-control.cjs': 1, // 控制动作提交，撤回时仅重放账本。
  '05-claude-engine.js': 3,      // runClaudeTurn 自存(收尾那一存改走 02 saveTurnFinalSession)
  '../backend/kimi-acp-turn.cjs': 2, // Kimi 回合自存，收尾走 saveTurnFinalSession。
  '../backend/mission-driver.cjs': 6,    // 驱动器自存(拿着聊天流那份对象;撤回后由 sessionObjectIsStale 收手);hunt2-steward ⑤ 收手时降 supervised 那一存同属回合自存(仍归本回合、不陈旧才存)
  '07-autonomy.js': 1,           // steer 排空(回合自存)
  '../backend/provider-turn.cjs': 12,          // +1 persistToolHistory: live turn intent/result barriers, requirePersisted and executionOwner; runOpenAiTurn 自存(收尾走 02 saveTurnFinalSession);新增协调图执行前/信封后两处也是回合自存，均带 turnSaveOpts 的 executionOwner + dropIfTurnSuperseded，迟到回归证明不盖新回合
  '../backend/session-compaction.cjs': 1, // maybeAutoCompact(回合自存,L1 / L2 / L2 失败保 L1 三个出口并成一处);两个手动压缩已改走 mutateSession
  // session-execution-routes.cjs 0:Kimi 状态 GET 回写用量走 mutateSession + keepUpdatedAt,见下面 ② 的 kimi/status 一行。
  '../backend/session-steering.cjs': 1, // 插话路由往活回合那份对象里追加(回合自存)
  '13ac-desktop-execution-runtime.js': 1, // 主回合自存：保存实际会话对象，严格落盘并重读验证后确认桌面结果交付；沿用executionOwner/turn/gen闸。
  '../backend/intervention-routes.cjs': 1,// 权限暂停计时器的纯重写
  '../backend/steward-thread-create.cjs': 2,   // 建会话
  '13m-steward-runner-base.js': 2, // ensureStewardSession(建/补管家会话)
  '../backend/scheduler-runtime.cjs': 1,         // 定时触发建会话
};
const actual = {};
for (const n of fs.readdirSync(SRC).filter(x => x.endsWith('.js')).concat(fs.readdirSync(path.join(SRC, '../backend')).filter(x => x.endsWith('.cjs')).map(x => '../backend/' + x)).sort()) {
  let c = 0;
  for (const code of codeLines(read(n))) {
    if (/function saveSession\(/.test(code)) continue;
    c += (code.match(/\bsaveSession\(/g) || []).length;
  }
  if (c) actual[n] = c;
}
const diffs = [...new Set([...Object.keys(CENSUS), ...Object.keys(actual)])]
  .filter(n => (CENSUS[n] || 0) !== (actual[n] || 0)).map(n => `${n}: 表 ${CENSUS[n] || 0} / 实 ${actual[n] || 0}`);
ok(diffs.length === 0, `① saveSession 普查与表逐项相等${diffs.length ? '(对不上:' + diffs.join(';') + ')—— 新加的若是请求／后台「读-改-写」,改走 mutateSession;若是回合存自己,回来改表并写明理由' : ''}`);

// ② 128b 改过的十一处真的走 mutateSession(慢活带 expectGen)。
function fnBody(file, header) {
  const name = /\bfunction (\w+)\(/.exec(header)?.[1];
  return name ? functionBlock(read(file), name) : '';
}
function routeBlock(file, marker, lines = 70) {
  const text = read(file);
  const at = text.indexOf(marker);
  return at < 0 ? '' : text.slice(at).split('\n').slice(0, lines).join('\n');
}
// 路由判定串按片拼出来,本文件里不出现字面路由路径:route-inventory 按「测试文件里出现了这条路径」认覆盖,
// 而本件只读源码、并不打这些路由 —— 字面写出来就是一条假覆盖(本件第一版就把 6 条路由的 coveredBy 冒领了)。
const routeMarker = tail => "pathname === '/" + 'api/' + tail + "'";
const sites = [
  ['skill-routes.cjs setSessionSkillsCore', fnBody('../backend/skill-routes.cjs', 'async function setSessionSkillsCore('), false],
  ['memory-routes.cjs 线程记忆设置路由', routeBlock('../backend/memory-routes.cjs', routeMarker('session/memories'), 60), false],
  ['mission-ledger-routes.cjs todo 回写路由', routeBlock('../backend/mission-ledger-routes.cjs', routeMarker('todo'), 25), false],
  ['session-execution-routes.cjs Kimi 状态读数回写路由', routeBlock('../backend/session-execution-routes.cjs', routeMarker('kimi/status'), 30), false],
  ['mission-ledger-routes.cjs 任务账本路由(check／start／update)', routeBlock('../backend/mission-ledger-routes.cjs', routeMarker('mission'), 110), true],
  ['session-compaction.cjs runProviderCompact', fnBody('../backend/session-compaction.cjs', 'async function runProviderCompact('), true],
  ['session-compaction.cjs runAgentExternalCompact', fnBody('../backend/session-compaction.cjs', 'async function runAgentExternalCompact('), true],
  ['kimi-native-operations.cjs runKimiCompact', fnBody('../backend/kimi-native-operations.cjs', 'async function runKimiCompact('), false],
  ['08-agent-runs.js appendAgentWorkflowSummaryToSession', fnBody('08-agent-runs.js', 'async function appendAgentWorkflowSummaryToSession('), false],
  ['steward-conversation-replies.cjs stewardStampReply', fnBody('../backend/steward-conversation-replies.cjs', 'async function stewardStampReply('), false],
  ['steward-conversation-visits.cjs stewardArchiveConversation', fnBody('../backend/steward-conversation-visits.cjs', 'async function stewardArchiveConversation('), true],
  ['mission-control.cjs missionControlCommand', fnBody('../backend/mission-control.cjs', 'async function missionControlCommand('), false],
];
for (const [label, body, needsExpectGen] of sites) {
  const code = codeLines(body).join('\n');
  const uses = /\bmutateSession\(/.test(code);
  const bare = code.split('\n').filter(l => /\bsaveSession\(/.test(l) && !/throwIfStale:\s*true/.test(l));
  ok(body.length > 0 && uses && bare.length === 0 && (!needsExpectGen || /expectGen/.test(code)),
    `② ${label} 走 mutateSession${needsExpectGen ? '(带 expectGen)' : ''}、没有裸 saveSession(${body.length ? `裸存 ${bare.length} 处` : '没找到函数'})`);
}

// ③ 原语本身:存盘带 throwIfStale、expectGen 不一致就不写。
const mutate = fnBody('../backend/session-transactions.cjs', 'async function mutateSession(');
ok(/throwIfStale:\s*true/.test(mutate) && /expectGen/.test(mutate) && /session\.rewound_during_write|sessionRewoundError/.test(mutate),
  '③ mutateSession 存盘带 throwIfStale、expectGen 不一致即抛 session.rewound_during_write');

// ④ 旁车与驱动器过撤回闸。
ok(/sessionObjectIsStale\(session\)/.test(fnBody('../backend/session-notes.cjs', 'async function maybeWriteSessionNotes(')), '④ 会话笔记旁车:陈旧对象不写');
ok(/sessionObjectIsStale\(session\)\s*\?\s*''\s*:\s*(?:await\s+)?writeHistorySnapshot\(/.test(read('../backend/session-compaction.cjs')), '④ 历史快照:陈旧对象不写');
ok(/sessionObjectIsStale\(session\)/.test(fnBody('../backend/mission-driver.cjs', 'async function runMissionDriver(')), '④ 任务驱动器:陈旧对象收手');

// ⑤ 撤回相关的码有稳定码与人话(Brief §4.2 第 18 条)。
const boot = read('../backend/http-protocol.cjs');
ok(/\['rewind_superseded', 'session\.rewind_superseded'\]/.test(boot), "⑤ 裸串 'rewind_superseded' 归一成稳定码 session.rewind_superseded");
const app = fs.readFileSync(path.join(SRC, '..', 'public', 'app.js'), 'utf8');
const drawer = fs.readFileSync(path.join(SRC, '..', 'public', 'js', 'steward-drawer.js'), 'utf8');
const codes = ['session.rewind_superseded', 'session.rewound_during_write', 'session.history_changed_during_compact'];
ok(codes.every(c => app.includes(`'${c}':`) && drawer.includes(`'${c}':`)), '⑤ 工作台与管家抽屉都给这三个码配了人话键');
const keys = ['error.api.rewindSuperseded', 'error.api.rewoundDuringWrite', 'error.api.historyChangedDuringCompact'];
const localeFiles = ['ruyi-workbench/app/public/locales/zh-CN.json', 'ruyi-workbench/app/public/locales/en-US.json', 'docs/i18n/locales/zh-CN.json', 'docs/i18n/locales/en-US.json']
  .map(r => JSON.parse(fs.readFileSync(path.join(__dirname, '..', r), 'utf8')));
ok(localeFiles.every(l => keys.every(k => typeof l[k] === 'string' && l[k].length > 8)), '⑤ 四份 locale 都有这三句人话');

console.log(`SESSION SAVE CENSUS STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
