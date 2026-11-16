'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../ruyi-workbench/app/backend/file-text-format.cjs');
test('supplementary CJK characters suppress ordinary adjacent punctuation warnings', () => {
  assert.equal(F.buildNonAsciiReport('𠀀（').total, 0);
  assert.equal(F.buildNonAsciiReport('（𠀀').total, 0);
});
test('diagnostic samples retain priority, UTF16 columns and base-line coordinates', () => {
  const text = '😀 x“y\nabc\u200bz\n\u00a0';
  const r = F.buildNonAsciiReport(text, { baseLine: 10, maxSamples: 2 });
  assert.equal(r.total, 3);
  assert.deepEqual(r.samples.map(s => [s.codepoint, s.line, s.column]), [['U+200B', 11, 4], ['U+00A0', 12, 1]]);
});
test('user text line-ending and BOM policies remain supported', () => {
  assert.equal(F.detectTextLineEnding('a\r\nb\r\n'), 'crlf');
  assert.equal(F.detectTextLineEnding('a\nb\r\n'), 'mixed');
  assert.equal(F.normalizeTextLineEndings('a\r\nb\nc\r', 'crlf'), 'a\r\nb\r\nc\r\n');
  assert.equal(F.textFileWantsUtf8Bom('external.ps1'), true);
});
