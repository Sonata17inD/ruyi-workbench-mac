'use strict';

function normalizeUserQuestions(raw) {
  const source = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.questions) ? raw.questions : [raw]);
  const uniqueId = (value, fallback, seen) => {
    const base = String(value || fallback).trim().slice(0, 80) || fallback;
    let candidate = base;
    for (let attempt = 2; seen.has(candidate); attempt++) {
      const suffix = `_${attempt}`;
      candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
    }
    seen.add(candidate);
    return candidate;
  };
  const questionIds = new Set();
  return source.filter(q => q && typeof q === 'object').slice(0, 3).map((q, index) => {
    const questionId = uniqueId(q.id, `question_${index + 1}`, questionIds);
    const optionIds = new Set();
    const options = (Array.isArray(q.options) ? q.options : []).slice(0, 12).map((opt, optionIndex) => {
      const row = typeof opt === 'string' ? { label: opt } : (opt || {});
      const label = String(row.label || row.value || '').trim().slice(0, 200);
      if (!label) return null;
      const optionId = uniqueId(row.id, `option_${optionIndex + 1}`, optionIds);
      return {
        id: optionId,
        label,
        description: String(row.description || '').trim().slice(0, 500),
      };
    }).filter(Boolean);
    const requestedMode = String(q.answerMode || '').trim().toLowerCase();
    let answerMode = ['single', 'multiple', 'text'].includes(requestedMode)
      ? requestedMode
      : (options.length ? (q.multiSelect === true ? 'multiple' : 'single') : 'text');
    if (!options.length && answerMode !== 'text') answerMode = 'text';
    return {
      id: questionId,
      header: String(q.header || '').trim().slice(0, 80),
      question: String(q.question || q.header || `Question ${index + 1}`).trim().slice(0, 1000),
      answerMode,
      multiSelect: answerMode === 'multiple', // legacy clients keep their existing branch
      // Wave 85: finite choices are the primary path; typing stays available behind an explicit Other row.
      // Callers may set false only when a custom answer would be semantically invalid.
      allowOther: answerMode !== 'text' && q.allowOther !== false,
      otherLabel: String(q.otherLabel || '').trim().slice(0, 120),
      otherPlaceholder: String(q.otherPlaceholder || '').trim().slice(0, 300),
      options,
    };
  }).filter(q => q.question);
}

function normalizeQuestionAnswer(body, questions) {
  const source = (Array.isArray(body && body.answers) ? body.answers : []).slice(0, 3);
  const knownQuestions = Array.isArray(questions) ? questions : [];
  const answers = source.map((row, index) => {
    const input = row && typeof row === 'object' ? row : {};
    const questionId = String(input.questionId || '').slice(0, 80);
    const question = knownQuestions.find(q => q && questionId && q.id === questionId) || knownQuestions[index] || null;
    const options = Array.isArray(question && question.options) ? question.options : [];
    const optionById = new Map(options.map(opt => [String(opt.id || ''), opt]));
    const optionByLabel = new Map(options.map(opt => [String(opt.label || ''), opt]));
    const selected = [];
    const selectedSeen = new Set();
    const addSelected = value => {
      const key = String(value == null ? '' : value).trim();
      const opt = optionById.get(key) || optionByLabel.get(key);
      if (!opt || selectedSeen.has(opt.id)) return false;
      selectedSeen.add(opt.id); selected.push(opt); return true;
    };
    const selectedInput = Array.isArray(input.selectedOptionIds) ? input.selectedOptionIds : [];
    selectedInput.slice(0, 12).forEach(addSelected);
    const legacyValues = (Array.isArray(input.answer) ? input.answer : [input.answer])
      .filter(v => v != null && String(v).trim()).slice(0, 12).map(v => String(v).trim().slice(0, 2000));
    let otherText = String(input.otherText || '').trim().slice(0, 4000);
    for (const value of legacyValues) {
      if (addSelected(value)) continue;
      if (!otherText && (!question || question.answerMode === 'text' || question.allowOther === true)) otherText = value;
    }
    const acceptedOther = !!otherText && (!question || question.answerMode === 'text' || question.allowOther === true);
    const answer = selected.map(opt => opt.label);
    if (acceptedOther) answer.push(otherText);
    return {
      questionId: String((question && question.id) || questionId || `question_${index + 1}`).slice(0, 80),
      question: String((question && question.question) || input.question || '').slice(0, 1000),
      answer,
      selectedOptionIds: selected.map(opt => opt.id),
      otherText: acceptedOther ? otherText : '',
    };
  });
  const generatedContent = answers.map(a => `${a.question}: ${a.answer.join(', ')}`).join('\n');
  const fallbackContent = String((body && body.content) || '');
  const content = String(generatedContent || fallbackContent).slice(0, 12000);
  return { ok: !(body && body.isError), answers, content };
}

function formatQuestionGuidance(answer) {
  const text = String((answer && answer.content) || '').trim() || '(user supplied no answer)';
  return `<workbench_user_answer>\n${text}\n</workbench_user_answer>\nContinue the current task using this answer. Do not ask the same question again.`;
}

function normalizeQuestionContext(value) {
  const clean = String(value || '').replace(/\r\n/g, '\n').trim();
  if (clean.length <= 6000) return clean;
  return `…\n${clean.slice(-5998)}`;
}

module.exports = { normalizeUserQuestions, normalizeQuestionAnswer, formatQuestionGuidance, normalizeQuestionContext };
