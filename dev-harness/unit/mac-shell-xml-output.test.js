'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createShellSessions } = require('../../ruyi-workbench/app/backend/shell-sessions.cjs');
test('Mac background XML survives receipt, preview and latest-line projection', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-shell-xml-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobs = [];
  const S = createShellSessions({ sessionPath: id => path.join(root, id + '.json'),
    safeSessionId: id => id, redact: text => text, nowIso: () => new Date().toISOString(),
    persistBackgroundJob: job => jobs.push(job) });
  const sid = 'xml_output_test', shellId = 'xml_test';
  const output = 'header\n<Objs version="1">数据</Objs>\n<Obj id="1">result</Obj>';
  const file = path.join(root, sid + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}');
  const sess = { mode: 'background', sessionId: sid, jobId: 'xml_job', name: 'xml', buf: output, baseOffset: 0, exitCode: 0, running: false };
  S.shellSessions.set(shellId, sess);
  try {
    assert.equal(S.shellLastLine(sess), '<Obj id="1">result</Obj>');
    assert.equal(S.sessionShellOutputTail(sid, shellId).output, output);
    S.completeBackgroundJob(shellId, sess);
    assert.equal(jobs.find(job => job.id === 'xml_job').output, output);
  } finally { S.shellSessions.delete(shellId); }
});
