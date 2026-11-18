'use strict';
// Verify context governance using the release allowlist in a directory without app/src.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { filesFor } = require('../../ruyi-workbench/tools/macos-runtime-files');

const workbench = path.resolve(__dirname, '../../ruyi-workbench');
const rulePath = 'app/backend/context-governance-rules.json';

test('the Mac release includes the only rule source and can render both summary prompts without src', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cg-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const release = filesFor('workbench').filter(file => file === 'app/server.js'
    || file === 'app/workbench-runtime.cjs' || file.startsWith('app/backend/'));
  assert.equal(release.filter(file => file === rulePath).length, 1);
  for (const file of release) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(workbench, file), target);
  }
  process.env.RUYI_HOME = path.join(root, 'data');
  assert.equal(fs.existsSync(path.join(root, 'app', 'src')), false);
  const rules = require(path.join(root, rulePath));
  const srv = require(path.join(root, 'app', 'server.js'));
  const guidance = rules.summary.callPolicy.promptGuidance;
  assert.ok(typeof guidance === 'string' && guidance.length > 10);
  const zh = srv.summaryPromptWithGuidance({ locale: 'zh-CN', runtimeSummaryPromptI18nV1: true });
  assert.equal(zh, rules.summary.prompt + '\n' + guidance);
  assert.equal(zh.split('map 每节尽量短').length - 1, 1);
  const en = srv.summaryPromptWithGuidance({ locale: 'en-US', runtimeSummaryPromptI18nV1: true });
  assert.equal(en, rules.summary.promptEn);
  assert.equal(srv.isContextOverflowError('HTTP 413'), true);
});
