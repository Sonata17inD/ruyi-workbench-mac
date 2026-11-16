'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createToolboxRegistry } = require('../../ruyi-workbench/app/backend/toolbox-registry.cjs');
test('disk registry validates entries, handles BOM, filters disabled components and invalidates its cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-registry-'));
  const previous = process.env.RUYI_TOOLBOX_HOME;
  process.env.RUYI_TOOLBOX_HOME = root;
  try {
    const dir = path.join(root, 'components'); fs.mkdirSync(dir);
    const events = [];
    const registry = createToolboxRegistry({ logEvent: event => events.push(event), safeJsonParse: raw => { try { return JSON.parse(raw); } catch { return null; } } });
    const entry = { schema: 1, id: 'fixture', kind: 'mcp', run: { command: process.execPath, cwd: root, args: ['literal ; 中文'], env: {} } };
    fs.writeFileSync(path.join(dir, 'fixture.json'), '\ufeff' + JSON.stringify(entry));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{');
    assert.deepEqual(registry.scan().map(c => c.id), ['fixture']);
    assert.deepEqual(registry.scan()[0].run.args, ['literal ; 中文']);
    assert.equal(events.length, 1);
    assert.deepEqual(registry.enabled({ toolbox: { autoDiscover: false } }), []);
    assert.deepEqual(registry.enabled({ toolbox: { disabled: ['fixture'] } }), []);
    fs.unlinkSync(path.join(dir, 'fixture.json'));
    assert.equal(registry.scan().length, 1);
    registry.invalidate();
    assert.deepEqual(registry.scan(), []);
    assert.equal(events.length, 1, 'unchanged invalid registration is audited only once');
  } finally {
    if (previous === undefined) delete process.env.RUYI_TOOLBOX_HOME; else process.env.RUYI_TOOLBOX_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
