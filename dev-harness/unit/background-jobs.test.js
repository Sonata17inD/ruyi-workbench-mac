'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackgroundJobs } = require('../../ruyi-workbench/app/backend/background-jobs.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ledger-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = { id: 'sess-test', messages: [], providerHistory: [] }, events = [], wakes = [], errors = [];
  const options = { paths: { sessions: root }, safeSessionId: id => /^sess-[a-z]+$/.test(id) ? id : null,
    sessionPath: id => path.join(root, id + '.json'), getActiveSession: () => session, getActiveRun: () => null,
    emitCompleted: e => events.push(e), onAgentEnvelopePersisted: j => wakes.push(j), logEvent: e => errors.push(e),
    neutralizeInjectedPrefixes: s => s, MAIL_TEXT_MAX: 1000, nowIso: () => '2026-11-16T00:00:00.000Z' };
  fs.writeFileSync(options.sessionPath(session.id), '{}');
  return { ...options, root, session, events, wakes, errors, jobs: createBackgroundJobs(options), options };
}
test('ledger survives restart and merges/drains once; rewind removes receipt', t => {
  const f = fixture(t), { session, jobs } = f;
  assert(jobs.notifyAgentRunEnvelope(session.id, { id: 'run1', status: 'succeeded', launchedByModel: true }, { result: 'PRIVATE' }));
  assert.equal(f.wakes.length, 1);
  assert(!JSON.stringify(f.events).includes('PRIVATE'));
  const restarted = createBackgroundJobs(f.options);
  restarted.mergeBackgroundJobs(session);
  assert.equal(session.messages.length, 1);
  restarted.drainBackgroundJobs(session); restarted.drainBackgroundJobs(session);
  assert.equal(session.providerHistory.length, 1);
  assert(restarted.isAgentEnvelopeDelivered(session, 'run1'));
  assert.equal(restarted.forgetBackgroundJobs(session.id, ['agent:run1']), 1);
  session.messages = []; restarted.mergeBackgroundJobs(session);
  assert.equal(session.messages.length, 0);
});
test('peer delivery persists source-bound receipt without waking parent', t => {
  const { jobs, session, wakes } = fixture(t);
  assert(jobs.notifyAgentMessage({ sessionId: session.id, sourceSessionId: 'sess-source', messageId: 'm1', text: 'hello' }));
  assert.equal(jobs.agentMessageStatus('sess-source', session.id, 'm1').status, 'queued');
  assert.equal(jobs.agentMessageStatus('sess-foreign', session.id, 'm1').status, 'not_found');
  assert(jobs.drainAgentEnvelopesText(session).includes('hello'));
  assert.equal(jobs.drainAgentEnvelopesText(session), '');
  assert.equal(jobs.agentMessageStatus('sess-source', session.id, 'm1').status, 'delivered');
  assert.equal(wakes.length, 0);
});
test('failed persistence reports failure, retains live receipt and cannot wake', t => {
  const { jobs, root, session, events, wakes, errors } = fixture(t);
  fs.writeFileSync(path.join(root, 'background-jobs'), 'blocked');
  assert.equal(jobs.notifyAgentRunEnvelope(session.id, { id: 'run1', launchedByModel: true }, { result: 'PRIVATE' }), false);
  assert.equal(session.messages.length, 1);
  assert.equal(events[0].persisted, false);
  assert.equal(wakes.length, 0);
  assert.equal(errors.length, 1);
});
