'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUserQuestions, normalizeQuestionAnswer, normalizeQuestionContext, formatQuestionGuidance } = require('../../ruyi-workbench/app/backend/user-question-protocol.cjs');
test('questions have bounded unique IDs and finite options, with text fallback', () => {
  const questions = normalizeUserQuestions({ questions: [
    { id: 'a'.repeat(80), question: '选择', options: [{ id: 'x', label: '甲' }, { id: 'x', label: '乙' }], multiSelect: true },
    { id: 'a'.repeat(80), question: '说明', answerMode: 'single' },
    { id: 'third', question: '第三' }, { id: 'fourth', question: '第四' },
  ] });
  assert.equal(questions.length, 3);
  assert.equal(new Set(questions.map(q => q.id)).size, 3);
  assert.ok(questions.every(q => q.id.length <= 80));
  assert.deepEqual(questions[0].options.map(o => o.id), ['x', 'x_2']);
  assert.equal(questions[0].answerMode, 'multiple');
  assert.equal(questions[1].answerMode, 'text');
});
test('answers deduplicate choices and enforce other-answer policy using registered labels', () => {
  const questions = normalizeUserQuestions([{ id: 'q', question: '选择', allowOther: false, options: ['甲', '乙'] }]);
  const result = normalizeQuestionAnswer({ answers: [{ questionId: 'q', question: 'forged', selectedOptionIds: ['option_1','option_1'], answer: ['乙','unlisted'], otherText: 'unlisted' }] }, questions);
  assert.deepEqual(result.answers[0].selectedOptionIds, ['option_1','option_2']);
  assert.deepEqual(result.answers[0].answer, ['甲','乙']);
  assert.equal(result.answers[0].otherText, '');
  assert.equal(result.content, '选择: 甲, 乙');
  assert.equal(normalizeQuestionAnswer({ content: 'direct reply', isError: true }, []).ok, false);
});
test('context retains recent text and normalizes CRLF without changing answer guidance', () => {
  assert.equal(normalizeQuestionContext(' x\r\ny '), 'x\ny');
  const context = normalizeQuestionContext('a'.repeat(7000) + '尾');
  assert.equal(context.length, 6000);
  assert.ok(context.endsWith('尾'));
  assert.match(formatQuestionGuidance({ content: '已确认' }), /<workbench_user_answer>\n已确认\n/);
});
