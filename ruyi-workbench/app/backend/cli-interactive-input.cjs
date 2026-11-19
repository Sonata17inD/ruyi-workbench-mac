'use strict';

function createCliInteractiveInput({ activeChildren, PrivacyCore }) {
  // --- Interactive stream-json envelopes (defensive; exact shapes are underdocumented). ---
  function buildUserEnvelope(text) {
    return { type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text || '') }] } };
  }
  function writeToChild(sessionId, obj) {
    const reg = activeChildren.get(sessionId);
    if (!reg || !reg.child || !reg.child.stdin.writable) return false;
    try {
      if (typeof PrivacyCore !== 'undefined') PrivacyCore.configHooks.assertCliAllowed?.();
      reg.child.stdin.write(JSON.stringify(obj) + '\n', 'utf8'); return true;
    } catch { return false; }
  }
  // Tools the workbench OWNS the interactive answer for (never intercept tools the CLI runs itself).
  function isAskUserTool(name) {
    return typeof name === 'string' && name.replace(/[^a-z]/gi, '').toLowerCase().includes('askuserquestion');
  }
  return { buildUserEnvelope, writeToChild, isAskUserTool };
}

module.exports = { createCliInteractiveInput };
