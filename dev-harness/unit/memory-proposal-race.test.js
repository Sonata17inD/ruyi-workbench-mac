'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createMemoryProposals } = require('../../ruyi-workbench/app/backend/memory-proposals.cjs');
const { memorySearchTerms } = require('../../ruyi-workbench/app/backend/memory-recall.cjs').createMemoryRecall();

for (const dismiss of [false, true]) {
  test(dismiss ? 'a judge finishing late cannot reopen a dismissed same-turn proposal' : 'a judge finishing late preserves the first same-turn tool proposal', { timeout: 5000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-proposal-race-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const session = { id: 'sess_test', cwd: root, turnSeq: 7, messages: [
      { role: 'user', content: '请记住这个项目的部署约定，先在预发布环境测试部署流程。' },
      { role: 'assistant', content: '项目部署约定：先在预发布环境完成一轮部署验证，然后再将相同的版本部署到正式环境。',
        engine: 'openai', providerId: 'fixture', source: 'provider', turnSeq: 7, exitCode: 0 },
    ] };
    const judgeEntered = Promise.withResolvers();
    const judgeResult = Promise.withResolvers();
    const config = { defaultWorkspace: root, activeProvider: 'fixture', providers: [{ id: 'fixture', type: 'openai-compat' }] };
    let sequence = 0;
    const proposals = createMemoryProposals({
      paths: { memory: root }, store: {
        fmVal: value => String(value ?? ''), loadMemoryRegistry: async () => [], projectKeyForCwd: () => 'project',
      }, relations: {}, memorySearchTerms,
      resolveWorkbenchMemoryToolContext: async () => ({ sid: session.id, session, cwd: root }),
      activeChildren: new Map(), loadSession: async () => session, readConfig: async () => config, safeSessionId: id => id,
      providerRawCompletion: async () => { judgeEntered.resolve(); return judgeResult.promise; },
      atomicWriteJson: (file, payload) => fs.writeFile(file, payload),
      makeId: () => 'proposal-' + ++sequence, nowIso: () => '2026-11-18T11:00:00.000Z', MEMORY_TYPES: new Set(['convention']),
    });
    assert.equal(proposals.memoryProposalPrefilter(session).eligible, true);
    const automatic = proposals.proposeMemoryFromSession(session.id);
    await judgeEntered.promise;
    const tool = await proposals.proposeWorkbenchMemory({ name: '预发布部署验证', description: '部署约定', type: 'convention',
      scope: 'project', body: '正式部署之前先在预发布环境测试部署流程。', reason: '项目部署规则长期复用' }, { turnSeq: session.turnSeq });
    assert.ok(tool.ok && tool.proposalId, JSON.stringify(tool));
    if (dismiss) assert.equal((await proposals.decideMemoryProposal(session.id, tool.proposalId, 'dismissed')).ok, true);
    judgeResult.resolve({ ok: true, content: '{"decision":"none"}' });
    const automaticResult = await automatic;
    const replay = await proposals.replayPendingMemoryProposal(session.id);
    if (dismiss) {
      assert.equal(automaticResult.proposal, null);
      assert.equal(replay.proposal, null);
      const saved = JSON.parse(await fs.readFile(path.join(root, 'proposals', session.id + '.json'), 'utf8'));
      assert.equal(saved.current.status, 'dismissed');
      assert.equal(saved.history.length, 1);
    } else {
      assert.equal(automaticResult.proposalId, tool.proposalId);
      assert.equal(replay.proposalId, tool.proposalId);
    }
  });
}
