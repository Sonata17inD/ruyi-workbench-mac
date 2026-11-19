'use strict';
// 架构还债批 1 #3:runKeyedChain(keyed-chain.cjs)是按 key 串行写链的唯一实现。修前 02 / 08 七处各自手写。
//   [K1] 同 key 严格串行、按提交顺序;不同 key 互不等待。
//   [K2] 前一个失败不挡后一个;失败原样交给这一次的调用方。
//   [K3] 链尾结算后自清(map 不留长寿条目);中途被接上的新链不会被旧链误删。
//   [K4] 修前手写的七处都已收编(02 / 08 不再出现 previous.catch().then(work) → set → 自清 的手写副本)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SRC = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const { runKeyedChain } = require(path.resolve(__dirname, '../../ruyi-workbench/app/backend/keyed-chain.cjs'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const settle = () => new Promise(r => setImmediate(r));

test('[K1] 同 key 串行按序,不同 key 并行', async () => {
  const chains = new Map();
  const log = [];
  const job = (tag, ms) => async () => { log.push(tag + '+'); await sleep(ms); log.push(tag + '-'); return tag; };
  const a1 = runKeyedChain(chains, 'a', job('a1', 30));
  const a2 = runKeyedChain(chains, 'a', job('a2', 1));
  const b1 = runKeyedChain(chains, 'b', job('b1', 1));
  assert.deepEqual(await Promise.all([a1, a2, b1]), ['a1', 'a2', 'b1']);
  assert.ok(log.indexOf('a1-') < log.indexOf('a2+'), 'a2 在 a1 收尾之前就开始了');
  assert.ok(log.indexOf('b1-') < log.indexOf('a1-'), 'b1 被 a1 挡住了');
});

test('[K2] 前一个失败不挡后一个,失败交给自己的调用方', async () => {
  const chains = new Map();
  const bad = runKeyedChain(chains, 'k', async () => { throw new Error('boom'); });
  const good = runKeyedChain(chains, 'k', async () => 'ok');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
});

test('[K3] 结算后自清;新接上的链不被旧链删掉', async () => {
  const chains = new Map();
  const first = runKeyedChain(chains, 'k', async () => { await sleep(5); });
  const second = runKeyedChain(chains, 'k', async () => { await sleep(20); });
  await first; await settle();
  assert.equal(chains.get('k'), second, '旧链结算时删掉了还在跑的新链');
  await second; await settle(); await settle();
  assert.equal(chains.has('k'), false, '链尾结算后没有自清');
  runKeyedChain(chains, 'x', async () => { throw new Error('x'); }).catch(() => {});
  await sleep(5); await settle();
  assert.equal(chains.has('x'), false, '失败的链尾没有自清');
});

test('[K4] 修前的手写副本都已收编', () => {
  const handRolled = /(\w+Chains|\w+Locks)\.get\([^)]*\) \|\| Promise\.resolve\(\);\s*\n\s*const \w+ = \w+\.catch\(\(\) => \{\}\)\.then/g;
  const found = [];
  for (const f of ['02-session-store.js', '08-agent-runs.js', '../backend/subagent-runner.cjs', '../backend/session-meta-updates.cjs']) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const m of text.matchAll(handRolled)) found.push(`${f}:${m[1]}`);
  }
  // 仍手写、且有理由的:saveSession / bumpMissionChangeSeq 的 sessionWriteChains(在飞快照被别处读)、
  // appendIntervention(结算推送 + 压缩计数,且其写入块被 readfiletail-torntail (c2) 原样抠出执行)、
  // setSessionMetaDeferred(自己的延后合并语义)。
  const allowed = new Set(['02-session-store.js:sessionWriteChains', '02-session-store.js:interventionWriteChains', '../backend/session-meta-updates.cjs:sessionMetaDeferChains']);
  assert.deepEqual(found.filter(x => !allowed.has(x)), [], '新写链请用 runKeyedChain(keyed-chain.cjs)');
  for (const name of ['checkpoint-journal', 'agent-run-store', 'external-bot-credentials', 'mission-changes',
    'mission-store', 'shell-sessions', 'memory-relations', 'intervention-journal', 'session-transactions', 'session-scratchpad']) {
    const text = fs.readFileSync(path.join(SRC, '../backend', name + '.cjs'), 'utf8');
    assert.match(text, /const \{ runKeyedChain \} = require\('\.\/keyed-chain\.cjs'\)/, name);
    const specialized = new Set(['mission-changes:sessionWriteChains', 'intervention-journal:interventionWriteChains']);
    assert.deepEqual([...text.matchAll(handRolled)].map(match => name + ':' + match[1]).filter(key => !specialized.has(key)), [],
      name + ' only snapshot coordination and intervention compaction keep specialized chains');
  }

});
