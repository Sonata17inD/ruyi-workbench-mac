'use strict';
// 干预(权限/提问/计划)状态转换的「先落盘、再推进」。真源码、临时 HOME、真读盘真写盘。
//
// 修前(代码走查):appendIntervention 的写链把 appendFile 的失败整个吞掉,transitionInterventionState
// 以为「执行中」已经落盘,照样执行动作(放行工具、交回答案)。重启时账上仍是 pending,
// markInterruptedInterventions 就把一个已经执行过的动作报成「因重启取消」。
//   [P1] 「执行中」写不进去 ⇒ 不执行动作,如实回 persist_failed,待决仍在;盘恢复后再点一次照常成功。
//   [P2] 瞬时锁(EBUSY)有界重试 ⇒ 一两次失败不影响结果。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-iv-persist-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const { mapInterventionTransitionFailure } = require('../../ruyi-workbench/app/backend/intervention-decisions.cjs');
const srv = require('../../ruyi-workbench/app/backend/intervention-journal.cjs').createInterventionJournal({
  paths: { sessions: root }, nowIso: () => new Date().toISOString(), events: { emit() {} }, logEvent() {},

  atomicWriteJson: (file, data) => fsp.writeFile(file, data),
  repairTornTail: async () => {}, recordChange: async () => {}, listAgentRuns: async () => [],
});
const { registerIntervention, transitionInterventionState, readInterventions } = srv;

async function pendingIv(tag) {
  const s = { id: 'sess_' + tag };
  const ivId = 'perm_' + tag;
  registerIntervention(s.id, 'permission', ivId, { toolName: 'file_write' });
  for (let i = 0; i < 50 && !(await readInterventions(s.id)).some(x => x.id === ivId); i++) await new Promise(r => setTimeout(r, 10));
  return { sid: s.id, ivId };
}
// 只让本会话干预日志的 appendFile 失败 times 次(Infinity = 一直失败)。
async function withAppendFailing(sid, code, times, fn) {
  const orig = fsp.appendFile;
  let left = times;
  fsp.appendFile = async function (p) {
    if (String(p).includes(sid) && /interventions/i.test(String(p)) && left > 0) {
      left--;
      throw Object.assign(new Error(code + ': simulated'), { code });
    }
    return orig.apply(this, arguments);
  };
  try { return await fn(); } finally { fsp.appendFile = orig; }
}

test('[P1] 「执行中」写不进去 ⇒ 不执行动作、回 persist_failed;恢复后再点照常成功', async () => {
  const { sid, ivId } = await pendingIv('p1');
  let ran = 0;
  const r = await withAppendFailing(sid, 'ENOSPC', Infinity,
    () => transitionInterventionState(sid, ivId, undefined, 'allowed', { action: () => { ran++; } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'persist_failed');
  assert.equal(ran, 0, '「执行中」没落盘却执行了动作(重启会把它报成因重启取消)');
  assert.equal((await readInterventions(sid)).find(x => x.id === ivId).status, 'pending');
  const again = await transitionInterventionState(sid, ivId, undefined, 'allowed', { action: () => { ran++; } });
  assert.equal(again.ok, true);
  assert.equal(ran, 1);
  assert.equal((await readInterventions(sid)).find(x => x.id === ivId).status, 'allowed');
});

test('[P2] 瞬时锁(EBUSY)两次 ⇒ 重试后照常成功', async () => {
  const { sid, ivId } = await pendingIv('p2');
  let ran = 0;
  const r = await withAppendFailing(sid, 'EBUSY', 2,
    () => transitionInterventionState(sid, ivId, undefined, 'allowed', { action: () => { ran++; } }));
  assert.equal(r.ok, true);
  assert.equal(ran, 1);
  assert.equal((await readInterventions(sid)).find(x => x.id === ivId).status, 'allowed');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

test('[P3] terminal write failure reports an uncertain outcome without claiming audit success or replaying the action', async () => {
  const { sid, ivId } = await pendingIv('terminal');
  const original = fsp.appendFile;
  let ran = 0, audits = 0, cleanups = 0;
  fsp.appendFile = async function (file, data, ...args) {
    if (String(file).includes(sid) && String(file).endsWith('.interventions.ndjson') && JSON.parse(String(data)).status === 'allowed') {
      throw Object.assign(new Error('simulated terminal disk full'), { code: 'ENOSPC' });
    }
    return original.call(this, file, data, ...args);
  };
  let result;
  try {
    result = await transitionInterventionState(sid, ivId, undefined, 'allowed', {
      action: () => { ran++; }, audit: () => { audits++; }, afterTerminal: () => { cleanups++; },
    });
  } finally { fsp.appendFile = original; }
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'terminal_persist_failed');
  assert.equal(result.status, 'applying');
  const response = mapInterventionTransitionFailure(result);
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'intervention.terminal_persist_failed');
  assert.equal(response.body.error.params.outcomeUnknown, true);
  assert.ok(!response.body.error.message.includes('nothing was applied'));
  assert.equal(ran, 1); assert.equal(audits, 0); assert.equal(cleanups, 0);
  assert.equal((await readInterventions(sid)).find(row => row.id === ivId).status, 'applying');
  const retry = await transitionInterventionState(sid, ivId, undefined, 'allowed', { action: () => { ran++; } });
  assert.equal(retry.reason, 'not_pending'); assert.equal(ran, 1);
  await srv.markInterruptedInterventions();
  assert.equal((await readInterventions(sid)).find(row => row.id === ivId).status, 'indeterminate');
});
