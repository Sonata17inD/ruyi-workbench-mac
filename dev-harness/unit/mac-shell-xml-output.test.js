'use strict';
require('../lib/self-isolate-home');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadServerInternals } = require('../lib/server-internals');
const S = loadServerInternals(['shellLastLine', 'sessionShellOutputTail', 'completeBackgroundJob', 'shellSessions', 'sessionPath', 'readBackgroundJobs']);
test('Mac background XML survives receipt, preview and latest-line projection', () => {
  const sid = 'xml_output_test', shellId = 'xml_test';
  const output = 'header\n<Objs version="1">数据</Objs>\n<Obj id="1">result</Obj>';
  const file = S.sessionPath(sid);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}');
  const sess = { mode: 'background', sessionId: sid, jobId: 'xml_job', name: 'xml', buf: output, baseOffset: 0, exitCode: 0, running: false };
  S.shellSessions.set(shellId, sess);
  try {
    assert.equal(S.shellLastLine(sess), '<Obj id="1">result</Obj>');
    assert.equal(S.sessionShellOutputTail(sid, shellId).output, output);
    S.completeBackgroundJob(shellId, sess);
    assert.equal(S.readBackgroundJobs(sid).find(job => job.id === 'xml_job').output, output);
  } finally { S.shellSessions.delete(shellId); }
});
