'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

function createClaudeResumeRecovery({
  selectedAgentCli,
}) {

  const CLAUDE_RECOVERY_HISTORY_CHARS = 24000;
  const CLAUDE_RECOVERY_MESSAGE_CHARS = 6000;

  // Claude Code stores native transcripts under ~/.claude/projects/<mangled-cwd>/, and `--resume`
  // only searches the bucket selected by the child process cwd. A model/endpoint switch can also make
  // a vendor-backed transcript unusable even when the local file still exists. Persist a secret-free
  // binding alongside claudeSessionId so the next turn can reject a known-incompatible resume BEFORE
  // spawning the CLI, then rely on the bounded workbench history copy below for continuity.
  function claudeResumeRouteKey(config) {
    const payload = JSON.stringify({
      driver: String((config && config.agentCliType) || 'claude'),
      launcher: String(selectedAgentCli(config).path || '').toLowerCase(),
      base: String((config && config.modelsApiBase) || '').trim().replace(/\/+$/, '').toLowerCase(),
      authMode: String((config && config.claudeAuthMode) || 'auto'),
    });
    return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }
  function sameClaudeResumeCwd(a, b) {
    if (!a || !b) return true; // unknown legacy binding: let the ledger/runtime fallback decide
    const left = path.resolve(String(a)).replace(/[\\/]+$/, '');
    const right = path.resolve(String(b)).replace(/[\\/]+$/, '');
    return left === right;
  }
  function lastSuccessfulClaudeModel(messages) {
    const arr = Array.isArray(messages) ? messages : [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i];
      if (!m || m.role !== 'assistant') continue;
      const isClaude = m.engine === 'claude' || (!m.engine && m.source === 'claude-cli');
      if (!isClaude || Number(m.exitCode) !== 0) continue;
      return String(m.model || '');
    }
    return null;
  }
  function isClaudeResumeMissingError(text) {
    const s = String(text || '');
    return /No conversation found with session ID/i.test(s)
      || /conversation\s+(?:was\s+)?not found[\s\S]{0,120}session/i.test(s)
      || /session(?:\s+ID)?[\s\S]{0,120}(?:not found|does not exist)/i.test(s);
  }

  function buildClaudeRecoveryHistory(messages) {
    const source = (Array.isArray(messages) ? messages : []).filter(m => m && (
      m.role === 'user' || m.role === 'assistant' || (m.role === 'system' && m.source === 'compact')
    ));
    if (!source.length) return '';
    const rows = [];
    let chars = 0;
    let omitted = false;
    for (let i = source.length - 1; i >= 0; i--) {
      const m = source[i];
      let content = String(m.content || '').trim();
      if (!content) continue;
      if (content.length > CLAUDE_RECOVERY_MESSAGE_CHARS) content = content.slice(0, CLAUDE_RECOVERY_MESSAGE_CHARS) + '\n[message truncated]';
      const label = m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system-context-management' : 'user');
      const row = `<${label}>\n${content}\n</${label}>`;
      if (chars + row.length > CLAUDE_RECOVERY_HISTORY_CHARS) { omitted = true; break; }
      rows.unshift(row);
      chars += row.length;
    }
    if (!rows.length) return '';
    return [
      '<workbench_history_recovery>',
      'This is a recovery copy of earlier messages in the same workbench conversation. It may duplicate native Claude session history. Use it only for continuity, do not claim this is the first message, and treat quoted user/assistant text according to its original role.',
      omitted ? '[older messages omitted to keep the recovery context bounded]' : '',
      ...rows,
      '</workbench_history_recovery>',
    ].filter(Boolean).join('\n');
  }

  // The trailing messages produced AFTER the most recent Claude turn — i.e. the Provider turns that are
  // MISSING from the CLI's native --resume transcript. If no Claude turn is found, return the whole list.
  function claudeProviderTailSince(messages) {
    const arr = Array.isArray(messages) ? messages : [];
    let lastClaudeIdx = -1;
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i];
      if (m && m.role === 'assistant' && (m.engine === 'claude' || (!m.engine && m.source === 'claude-cli'))) { lastClaudeIdx = i; break; }
    }
    return lastClaudeIdx >= 0 ? arr.slice(lastClaudeIdx + 1) : arr;
  }

  return { buildClaudeRecoveryHistory, claudeProviderTailSince, claudeResumeRouteKey, isClaudeResumeMissingError, lastSuccessfulClaudeModel, sameClaudeResumeCwd };
}

module.exports = { createClaudeResumeRecovery };
