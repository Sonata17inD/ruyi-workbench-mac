'use strict';
// 真落盘验证保留策略、原子替换/追加串行、游标和历史待决语义;只隔离投影与总线,不调用模型。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAtomicFileStore } = require('../../ruyi-workbench/app/backend/file-persistence.cjs');
const { createStewardCore } = require('../../ruyi-workbench/app/backend/steward-core.cjs');
const { createStewardInboxEvents } = require('../../ruyi-workbench/app/backend/steward-inbox-events.cjs');
const { createStewardInbox } = require('../../ruyi-workbench/app/backend/steward-inbox.cjs');
const rules = createStewardCore({});
const inboxEvents = createStewardInboxEvents(rules);
const NOW = Date.now(), DAY = 86400000;
const row = (inboxSeq, age = 0, extra = {}) => ({ inboxSeq, at: new Date(NOW - age * DAY).toISOString(),
  kind: 'done', sessionId: 'sess_test', seq: inboxSeq, payload: {}, count: 1, ...extra });
const needs = (inboxSeq, id, age = 60, extra = {}) => row(inboxSeq, age, {
  kind: 'needs_you', seq: id, payload: { interventionId: id }, ...extra,
});

function harness(t, rows = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-inbox-retention-'));
  t.after(() => {
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('ruyi-inbox-retention-'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const file = path.join(home, 'steward', 'inbox-v1.ndjson');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, rows.map(value => JSON.stringify(value)).join('\n') + (rows.length ? '\n' : ''));
  const events = [];
  const listeners = [];
  const hooks = {};
  const fixtureFs = { ...fs };
  const fixtureFsp = { ...fsp };
  const { atomicWriteJson } = createAtomicFileStore({ paths: {}, process, fsp: fixtureFsp });
  const projected = { read: async () => ({ sessions: [{ sessionId: 'sess_test', interventions: [] }] }) };
  const getPretenderProjectionIndex = () => projected.read();
  const emit = (name, frame) => {
    if (name === 'inbox.appended') events.push(frame);
    for (const fn of listeners) fn(name, frame);
  };
  const config = { stewardEnabledV1: true };
  const inbox = createStewardInbox({
    paths: { data: home }, RUYI_EVENTS: { subscribe(fn) { listeners.push(fn); }, emit },
    rules, inboxEvents, StewardHooks: hooks, EventStreamHooks: {}, logEvent() {},
    execution: { activeAgentRuns: new Map(), activeChildren: new Map(), turnSettlers: new Map(), turnOutcomePending: new Set() },
    safeJsonParse: (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } },
    safeSessionId: value => value, nowIso: () => new Date().toISOString(), readConfig: async () => config,
    io: { fs: fixtureFs, fsp: fixtureFsp, atomicWriteJson, async repairMissionChangeTornTail() {} },
    sources: { getPretenderProjectionIndex, sessionPath: id => path.join(home, 'sessions', id + '.json'), async listAgentRuns() { return []; } },
    timers: { setTimeout() { return {}; }, clearTimeout() {}, setInterval() { return {}; }, clearInterval() {} },
  });
  t.after(inbox.stopStewardInbox);
  return { ...inbox, hooks, fixtureFs, fixtureFsp, projected, emit, events, file,
    tick: () => inbox.startStewardInbox(config),
    read: () => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
}

test('清理过期通知,保留当前待决、仍有待决的合并组和未知组;保留重启序号水位', async t => {
  const h = harness(t, [row(1, 60), needs(2, 'open'), needs(3, 'closed'),
    needs(4, 'closed', 60, { count: 2, payload: { interventionId: 'closed', mergedSeqs: ['open', 'closed'] } }),
    needs(5, 'closed', 60, { count: 30 }), row(6, 1), row(7, 60)]);
  h.projected.read = async () => ({ sessions: [{ sessionId: 'sess_test', interventions: [{ id: 'open', status: 'pending', type: 'question' }] }] });
  await h.tick();
  assert.deepEqual(h.read().map(r => r.inboxSeq), [2, 4, 5, 6, 7]);
  const restarted = harness(t, h.read());
  const [next] = await restarted.stewardAppendInboxRows([row(8)]);
  assert.equal(next.inboxSeq, 8);
});

test('历史容量最多 5000 条,旧待决不挤占历史额度,增量分页不受默认最新读取影响', async t => {
  const h = harness(t, [needs(1, 'open'), ...Array.from({ length: 5010 }, (_, i) => row(i + 2, 1))]);
  fs.writeFileSync(path.join(path.dirname(h.file), 'cursor-v1.json'), JSON.stringify({
    schema: 1, inboxSeq: 5011, sources: { pendingIds: ['sess_test\0open'] },
  }));
  h.projected.read = async () => ({ sessions: [{ sessionId: 'sess_test', interventions: [{ id: 'open', status: 'pending', type: 'question' }] }] });
  await h.tick();
  assert.equal(h.read().length, 5001);
  assert.deepEqual(h.read().slice(0, 2).map(r => r.inboxSeq), [1, 12]);
  const first = await h.stewardInboxRead({ since: 0, limit: 2 });
  assert.deepEqual(Array.from(first.items, r => r.inboxSeq), [1, 12]);
  assert.equal(first.hasMore, true);
  const second = await h.stewardInboxRead({ since: 12, limit: 2 });
  assert.deepEqual(Array.from(second.items, r => r.inboxSeq), [13, 14]);
  const latest = await h.stewardImplInboxRead({ limit: 2 });
  assert.deepEqual(Array.from(latest.items, r => r.inboxSeq), [5011, 5010]);
  assert.equal(latest.order, 'desc');
  const incremental = await h.stewardImplInboxRead({ since: 0, limit: 2 });
  assert.equal(incremental.order, 'asc');
});

test('工具从当前投影核对待决;合并组的最后一条已处理不能掩盖仍待决的较早一条', async t => {
  const h = harness(t, [needs(1, 'open'), needs(2, 'closed'), needs(3, 'closed', 0,
    { count: 2, payload: { interventionId: 'closed', mergedSeqs: ['open', 'closed'] } })]);
  h.projected.read = async () => ({ sessions: [{ sessionId: 'sess_test',
    interventions: [{ id: 'open', status: 'pending' }, { id: 'closed', status: 'answered' }] }] });
  const result = await h.stewardImplInboxRead({ since: 0 });
  assert.equal(result.pendingCount, 1);
  assert.deepEqual(Array.from(result.items, r => r.pendingState), ['pending', 'not_pending', 'pending']);
  h.projected.read = async () => { throw new Error('unavailable'); };
  const unknown = await h.stewardImplInboxRead({});
  assert.equal(unknown.pendingCount, null);
  assert.ok(unknown.items.every(r => r.pendingState === 'unknown'));
});

test('整理和追加共用写链,重写前后的新通知都不丢;一小时内不重复扫描', async t => {
  const h = harness(t, [row(1, 60), row(2)]);
  await Promise.all([h.stewardAppendInboxRows([row(3)]), h.stewardMaintainInbox(NOW), h.stewardAppendInboxRows([row(4)])]);
  assert.deepEqual(h.read().map(r => r.inboxSeq), [2, 3, 4]);
  h.fixtureFs.createReadStream = () => { throw new Error('must not rescan'); };
  await h.stewardMaintainInbox(NOW + 1);
});

test('轮询增强期间发布的提醒保有其序号，失败的轮询重试后仍可增量读取', async t => {
  const h = harness(t);
  await h.tick();
  let release;
  const entered = new Promise(resolve => {
    h.hooks.enrichInboxRows = () => new Promise(continueTick => {
      release = continueTick;
      resolve();
    });
  });
  h.emit('thread.adopted', { by: 'user', sessionId: 'sess_test' });
  const tick = h.tick();
  await entered;
  const [first] = await h.stewardAppendInboxRows([row(101, 0, { kind: 'reminder' })]);
  h.fixtureFsp.appendFile = async () => { throw Object.assign(new Error('injected write failure'), { code: 'EIO' }); };
  release();
  await tick;
  assert.equal((await h.stewardInboxState()).lastError, 'injected write failure');
  h.fixtureFsp.appendFile = fsp.appendFile;
  h.hooks.enrichInboxRows = null;
  await h.tick();
  const [last] = await h.stewardAppendInboxRows([row(102, 0, { kind: 'reminder' })]);
  assert.equal(first.inboxSeq, 1);
  assert.equal(last.inboxSeq, 3);
  assert.deepEqual(h.read().map(row => [row.kind, row.inboxSeq]), [['reminder', 1], ['adopted', 2], ['reminder', 3]]);
  assert.deepEqual(h.events.map(frame => frame.inboxSeq), [1, 2, 3]);
  const page = await h.stewardInboxRead({ since: first.inboxSeq });
  assert.deepEqual(Array.from(page.items, row => row.inboxSeq), [2, 3]);
});

test('读失败、坏行或原子替换失败都保留原文件;整理故障也有节流', async t => {
  for (const failure of ['read', 'invalid', 'rename']) {
    const h = harness(t, [row(1, 60), row(2)]);
    if (failure === 'invalid') fs.appendFileSync(h.file, '{torn');
    if (failure === 'read') h.fixtureFs.createReadStream = file => fs.createReadStream(file + '.missing');
    if (failure === 'rename') h.fixtureFsp.rename = async () => { throw Object.assign(new Error('I/O'), { code: 'EIO' }); };
    const before = fs.readFileSync(h.file, 'utf8');
    await assert.rejects(h.stewardMaintainInbox(NOW));
    assert.equal(fs.readFileSync(h.file, 'utf8'), before);
    await h.stewardMaintainInbox(NOW + 1);
    assert.deepEqual(fs.readdirSync(path.dirname(h.file)), ['inbox-v1.ndjson']);
  }
});

test('持久游标的 2000 条上限不裁掉内存待决集合', async t => {
  const h = harness(t);
  const interventions = Array.from({ length: 2010 }, (_, i) => ({ id: 'iv_' + i, status: 'pending', type: 'replan' }));
  h.projected.read = async () => ({ sessions: [{ sessionId: 'sess_test', interventions }] });
  await h.tick();
  const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(h.file), 'cursor-v1.json'), 'utf8'));
  assert.equal(saved.sources.pendingIds.length, 2000);
  assert.ok(interventions.every(iv => h.stewardPendingStillOpen({ sessionId: 'sess_test', payload: { interventionId: iv.id } })));
});
