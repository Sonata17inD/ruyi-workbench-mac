'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { nulRecords, parseEolRecord, trackedEol } = require('../lib/git-eol');
test('streamed Git records cross the previous maxBuffer and arbitrary UTF-8 boundaries', async () => {
  const record = 'i/lf    w/lf    attr/text=auto eol=lf \t 目录/中文\t换\n行\\".js\0';
  const bytes = Buffer.from(record.repeat(22000));
  assert.ok(bytes.length > 1024 * 1024);
  async function* chunks() { for (let i = 0; i < bytes.length; i += 101) yield bytes.subarray(i, i + 101); }
  let count = 0;
  for await (const value of nulRecords(Readable.from(chunks()))) {
    assert.equal(parseEolRecord(value).file, ' 目录/中文\t换\n行\\".js'); count++;
  }
  assert.equal(count, 22000);
});
test('actual Git -z preserves literal filenames and reports process failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-eol-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, '.gitattributes'), '* text=auto eol=lf\n');
    const name = ' 空格中文\t换\n行".txt'; fs.writeFileSync(path.join(root, name), 'text\n');
    execFileSync('git', ['add', '--', '.'], { cwd: root });
    const rows = []; for await (const row of trackedEol(root)) rows.push(row);
    assert.ok(rows.some(row => row.file === name && row.eol === 'lf'));
    fs.unlinkSync(path.join(root, name));
    const deleted = []; for await (const row of trackedEol(root)) deleted.push(row);
    assert.equal(deleted.find(row => row.file === name).worktree, '');
    fs.rmSync(path.join(root, '.git'), { recursive: true });
    await assert.rejects(async () => { for await (const row of trackedEol(root)) void row; }, /git ls-files failed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
