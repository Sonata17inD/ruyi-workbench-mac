'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { producedUserFile } = require('../../ruyi-workbench/app/backend/bridged-write-targets.cjs');

test('self-check requires a successful product write, including writes through proxies', () => {
  const receipt = { ok: true, path: '/tmp/report.txt' };
  for (const name of ['todo_write', 'scratchpad_write', 'read_pdf', 'browser_click', 'file_read']) {
    assert.equal(producedUserFile({ name, result: receipt }), false, name);
  }
  const proxy = { name: 'tool_invoke_edit', input: { name: 'file_edit', arguments: { path: receipt.path } } };
  assert.equal(producedUserFile({ ...proxy, result: receipt }), true);
  assert.equal(producedUserFile({ ...proxy, result: { ok: false, path: receipt.path } }), false);
  assert.equal(producedUserFile({ ...proxy, result: { ...receipt, unchanged: true } }), false);
  const office = { name: 'ai_computer_control__excel_chart', input: { path: '/tmp/report.xlsx' } };
  assert.equal(producedUserFile({ ...office, result: { success: true } }), true);
  assert.equal(producedUserFile({ ...office, result: { ok: true, success: false } }), false);
});
