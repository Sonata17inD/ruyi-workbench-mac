'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { functionBlock } = require('../lib/source-slice.js');
const src = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/public/js/session-experience.js'), 'utf8');
const assemblePlaybookPrompt = new Function(functionBlock(src, 'assemblePlaybookPrompt') + ';return assemblePlaybookPrompt;')();

describe('assemblePlaybookPrompt', () => {
  it('substitutes declared keys', () => {
    const pb = { promptTemplate: 'Analyze {file} with {tool}', inputs: [{ key: 'file' }, { key: 'tool' }] };
    const result = assemblePlaybookPrompt(pb, { file: 'app.js', tool: 'eslint' });
    assert.equal(result, 'Analyze app.js with eslint');
  });
  it('leaves undeclared placeholders as-is', () => {
    const pb = { promptTemplate: 'Analyze {file} at {unknown}', inputs: [{ key: 'file' }] };
    const result = assemblePlaybookPrompt(pb, { file: 'app.js' });
    assert.equal(result, 'Analyze app.js at {unknown}');
  });
  it('handles missing values gracefully', () => {
    const pb = { promptTemplate: 'Analyze {file}', inputs: [{ key: 'file' }] };
    const result = assemblePlaybookPrompt(pb, {});
    assert.equal(result, 'Analyze ');
  });
  it('handles null values', () => {
    const pb = { promptTemplate: 'Analyze {file}', inputs: [{ key: 'file' }] };
    const result = assemblePlaybookPrompt(pb, { file: null });
    assert.equal(result, 'Analyze ');
  });
  it('handles missing promptTemplate', () => {
    const pb = { inputs: [{ key: 'file' }] };
    const result = assemblePlaybookPrompt(pb, { file: 'x' });
    assert.equal(result, '');
  });
  it('handles empty inputs array', () => {
    const pb = { promptTemplate: 'No placeholders', inputs: [] };
    const result = assemblePlaybookPrompt(pb, {});
    assert.equal(result, 'No placeholders');
  });
  it('substitutes all occurrences of a key', () => {
    const pb = { promptTemplate: '{x} and {x} again', inputs: [{ key: 'x' }] };
    const result = assemblePlaybookPrompt(pb, { x: 'A' });
    assert.equal(result, 'A and A again');
  });
  it('does not re-substitute a {key} that appears inside a value (single pass)', () => {
    const pb = { promptTemplate: '{notes} -> {output}', inputs: [{ key: 'notes' }, { key: 'output' }] };
    assert.equal(assemblePlaybookPrompt(pb, { notes: 'write to {output}', output: 'out.md' }), 'write to {output} -> out.md');
  });
  it('handles special regex chars in key name', () => {
    const pb = { promptTemplate: 'Use {file.name}', inputs: [{ key: 'file.name' }] };
    const result = assemblePlaybookPrompt(pb, { 'file.name': 'test.js' });
    assert.equal(result, 'Use test.js');
  });
  it('XSS: values are NOT escaped (textContent expected in caller)', () => {
    // This is a design choice — the caller must use textContent, not innerHTML
    const pb = { promptTemplate: 'Run {cmd}', inputs: [{ key: 'cmd' }] };
    const result = assemblePlaybookPrompt(pb, { cmd: '<script>alert(1)</script>' });
    assert.equal(result, 'Run <script>alert(1)</script>');
    // NOTE: caller MUST use textContent when rendering this into the DOM
  });
});
