'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createProcessHelperCapability } = require('../../ruyi-workbench/app/backend/process-helper-capability.cjs');
test('helper cache shares probes, invalidates after runtime faults and rejects replacement or removal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-helper-capability-'));
  const helper = path.join(root, 'helper'), count = path.join(root, 'count');
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  const report = { protocolVersion: 3, guardian: true, supervise: true, privateFd: true, identityCleanup: true, escapeCoverage: 'observed-only' };
  const service = createProcessHelperCapability({ hooks: { helperPath: () => helper }, process: { platform: 'darwin' } });
  try {
    fs.writeFileSync(helper, '#!/bin/sh\nprintf x >> ' + quote(count) + '\nprintf \'%s\\n\' ' + quote(JSON.stringify(report)) + '\n', { mode: 0o700 });
    const results = await Promise.all([service.async(), service.async(), service.async()]);
    assert.ok(results.every(state => state.ready));
    assert.equal(fs.readFileSync(count, 'utf8'), 'x');
    assert.equal(service.sync().ready, true);
    assert.equal(fs.readFileSync(count, 'utf8'), 'x');
    service.invalidate();
    assert.equal((await service.async()).ready, true);
    assert.equal(fs.readFileSync(count, 'utf8'), 'xx');
    fs.writeFileSync(helper, '#!/bin/sh\nprintf \'{}\\n\'\n');
    assert.equal((await service.async()).code, 'process_helper_incompatible');
    fs.unlinkSync(helper);
    assert.equal((await service.async()).code, 'process_helper_missing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
