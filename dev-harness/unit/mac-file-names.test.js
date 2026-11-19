'use strict';
require('../lib/self-isolate-home');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mac-names-'));
const S = require('../lib/server-internals').loadServerInternals(['stewardDeliveryFiles', 'toolCall']);
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('local delivery preserves a backslash in a Mac filename', () => {
  const name = '中文\\report.txt';
  const files = S.stewardDeliveryFiles({ artifacts: [{ path: name }] }, root);
  assert.deepEqual(files.map(file => [file.name, file.path]), [[name, path.join(root, name)]]);
});

test('case-only file move keeps literal backslash filename and original bytes', async () => {
  const from = path.join(root, 'Report\\Draft.txt'), to = path.join(root, 'report\\draft.txt');
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
  fs.writeFileSync(from, bytes);
  const result = await S.toolCall('file_move', { from, to }, { workingDir: root, config: {}, session: { id: 'mac_names', cwd: root } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(fs.readFileSync(to), bytes);
  assert.deepEqual(fs.readdirSync(root), [path.basename(to)]);
});
