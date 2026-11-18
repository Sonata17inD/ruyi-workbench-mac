#!/usr/bin/env node
'use strict';

// 47b/86 (v1.9.1 wave): 验证「工具超时但一直卡在运行中」修复。
// 回合被 Stop/看门狗/异常中止时,正在执行的 tool/subagent/workflow 段拿不到 tool_result/end 事件,
// 旧行为以 status:'running' 落盘并在刷新后永远显示「运行中」。本门验证两条兜底:
//   1) createTurnSegmentBuilder().finalizeAll(reason) 在 snapshot() 前把悬空 running 段标 'cancelled',
//      已 done/error 的段不动;
//   2) healStalePendingSegments 在 loadSession 时把存量 running tool/subagent/workflow 段标 'cancelled'
//      (修复前落盘的旧会话);
//   3) 桥接超时表给 ACC `wait`(cap 300s) 310s,不再用默认 120s 杀掉合法 wait(300)。
// 直接调用生产模块验证回合收尾、落盘段恢复及 MCP 超时。

const { createTurnSegmentBuilder } = require('../ruyi-workbench/app/backend/turn-segments.cjs');
const { createSessionRecovery } = require('../ruyi-workbench/app/backend/session-recovery.cjs');

let failures = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { failures += 1; console.log('FAIL ' + label); }
};

// 使用独立待决注册表验证存量段和活待决。
const pendingPermissions = new Map();
const { healStalePendingSegments } = createSessionRecovery({
  pendingPermissions, pendingPlans: new Map(), pendingQuestions: new Map(),
});
ok(typeof createTurnSegmentBuilder === 'function', 'F1 装载实际回合分段构建器');
ok(typeof healStalePendingSegments === 'function', 'F2 装载实际会话段恢复函数');

const builder = createTurnSegmentBuilder();

// --- F3: finalizeAll marks running tool/subagent/workflow as cancelled, leaves done alone ----
const batch = builder.createBatchId('openai');
builder.consume({ type: 'assistant_delta', text: '先说明。' });
builder.consume({ type: 'tool_use', id: 't-running', name: 'run_command', batchId: batch });
builder.consume({ type: 'tool_use', id: 't-done', name: 'file_read', batchId: batch });
builder.consume({ type: 'tool_result', id: 't-done', content: 'ok' });
builder.consume({ type: 'tool_use', id: 't-error', name: 'shell_send', batchId: batch });
builder.consume({ type: 'tool_result', id: 't-error', content: 'boom', isError: true });
builder.consume({ type: 'subagent', id: 's-running', state: 'start' });
builder.consume({ type: 'agent_workflow', id: 'wf1', state: 'run' });

const healed = builder.finalizeAll('回合被停止,进行中的工具已中断');
const segs = builder.snapshot();
const find = (cid) => segs.find(s => s.toolCallId === cid || s.workflowId === cid);

ok(healed === 3, `F3 finalizeAll 报告 3 处悬空段 (got ${healed})`);
ok(find('t-running').status === 'cancelled', 'F3a 运行中工具 -> cancelled');
ok(find('t-running').note && find('t-running').note.includes('停止'), 'F3b cancelled 段带中断 note');
ok(find('t-done').status === 'done', 'F3c 已完成工具不被触碰 (仍 done)');
ok(find('t-error').status === 'error', 'F3d 已出错工具不被触碰 (仍 error)');
ok(find('s-running').status === 'cancelled', 'F3e 运行中 subagent -> cancelled');
ok(find('wf1').status === 'cancelled', 'F3f 运行中 workflow -> cancelled');

// --- F4: a normally-completing turn (no finalizeAll) still works & running segments persist ---
const b2 = createTurnSegmentBuilder();
const batch2 = b2.createBatchId('claude');
b2.consume({ type: 'tool_use', id: 'x1', name: 'git_status', batchId: batch2 });
const beforeSegs = b2.snapshot();
ok(beforeSegs.find(s => s.toolCallId === 'x1').status === 'running', 'F4 未 finalize 的运行段保持 running (证明 finalizeAll 是显式收尾,不是副作用)');
b2.consume({ type: 'tool_result', id: 'x1', content: 'clean' });
ok(b2.snapshot().find(s => s.toolCallId === 'x1').status === 'done', 'F4 正常 tool_result 仍把 running -> done');

// --- F5: healStalePendingSegments heals persisted running tool/subagent/workflow segments ------
const session = {
  messages: [{
    role: 'assistant',
    segments: [
      { type: 'tool', toolCallId: 'old-tool', status: 'running' },
      { type: 'tool', toolCallId: 'old-done', status: 'done' },
      { type: 'subagent', toolCallId: 'old-sub', status: 'running' },
      { type: 'workflow', workflowId: 'old-wf', status: 'running' },
      { type: 'workflow', workflowId: 'old-wf-paused', status: 'paused' },
      { type: 'permission', requestId: 'old-perm', status: 'pending' },
      { type: 'tool', toolCallId: 'old-done2', status: 'done' },
    ],
  }],
};
const healedSession = healStalePendingSegments(session);
ok(healedSession === true, 'F5 healStalePendingSegments 报告有修复');
const seg = (cid) => session.messages[0].segments.find(s => s.toolCallId === cid || s.workflowId === cid || s.requestId === cid);
ok(seg('old-tool').status === 'cancelled', 'F5a 存量 running 工具 -> cancelled');
ok(seg('old-done').status === 'done' && seg('old-done2').status === 'done', 'F5b 已完成工具不动');
ok(seg('old-sub').status === 'cancelled', 'F5c 存量 running subagent -> cancelled');
ok(seg('old-wf').status === 'cancelled', 'F5d 存量 running workflow -> cancelled');
ok(seg('old-wf-paused').status === 'cancelled', 'F5e 存量 paused workflow -> cancelled');
ok(seg('old-perm').status === 'cancelled', 'F5f 存量 pending permission 仍被修 (回归保护)');

// --- F6: live pending permission is NOT healed (decision may still arrive) ------------------
pendingPermissions.set('live-perm', { sessionId: 'x' });
const live = { messages: [{ segments: [{ type: 'permission', requestId: 'live-perm', status: 'pending' }] }] };
healStalePendingSegments(live);
ok(live.messages[0].segments[0].status === 'pending', 'F6 活待决 permission 不被误标 (决策仍会到达)');

// --- F7: production bridge deadlines include the tool ceiling and request-specific grace ---
const { bridgedToolCallTimeoutMs } = require('../ruyi-workbench/app/backend/mcp-tool-timeouts.cjs');
const previousOverride = process.env.WCW_BRIDGED_TIMEOUT_OVERRIDE;
try {
  delete process.env.WCW_BRIDGED_TIMEOUT_OVERRIDE;
  ok(bridgedToolCallTimeoutMs('wait') === 310000, 'F7a wait -> 310000ms');
  ok(bridgedToolCallTimeoutMs('launch_application') === 650000, 'F7b launch_application -> 650000ms');
  ok(bridgedToolCallTimeoutMs('file_read') === 900000, 'F7c 未知长工具默认 -> 900000ms');
  ok(bridgedToolCallTimeoutMs('run_command', { timeout: 600 }) === 610000, 'F7d run_command 采用本次请求上限加传输宽限');
  process.env.WCW_BRIDGED_TIMEOUT_OVERRIDE = 'wait:5000,run_command:8000';
  ok(bridgedToolCallTimeoutMs('wait') === 5000, 'F7e WCW_BRIDGED_TIMEOUT_OVERRIDE 覆盖 wait -> 5000ms');
  ok(bridgedToolCallTimeoutMs('run_command', { timeout: 600 }) === 8000, 'F7f 显式覆盖限制本次命令的桥超时');
} finally {
  if (previousOverride === undefined) delete process.env.WCW_BRIDGED_TIMEOUT_OVERRIDE;
  else process.env.WCW_BRIDGED_TIMEOUT_OVERRIDE = previousOverride;
}

// --- summary ---------------------------------------------------------------------------------
console.log('\n' + (failures ? `FINALIZE-SEGMENTS STATIC: FAIL (${failures})` : 'FINALIZE-SEGMENTS STATIC: ALL PASS'));
process.exit(failures ? 1 : 0);
