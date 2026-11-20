'use strict';

function createAgentCliEvents({
  safeJsonParse,
}) {

  function deltaOf(streamEvent) {
    // Tolerate both {event:{delta}} and {event:{event:{delta}}} nestings seen across CLI versions.
    if (!streamEvent || typeof streamEvent !== 'object') return null;
    if (streamEvent.delta) return streamEvent;
    if (streamEvent.event) return deltaOf(streamEvent.event);
    return null;
  }

  const CLAUDE_TASK_NOTIFICATION_MAX_CHARS = 100000;
  function decodeClaudeTaskXmlText(value) {
    return String(value || '')
      .replace(/&#(\d+);/g, (_, n) => {
        const code = Number(n);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
      })
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
        const code = parseInt(n, 16);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
      })
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'").replace(/&amp;/gi, '&');
  }
  function claudeTaskNotificationTag(text, tag, maxChars = CLAUDE_TASK_NOTIFICATION_MAX_CHARS) {
    const match = String(text || '').match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i'));
    if (!match) return '';
    return decodeClaudeTaskXmlText(match[1]).slice(0, Math.max(0, maxChars));
  }
  // Claude Code emits background-Agent completion as a string-valued user message rather than a
  // tool_result block. Keep this parser deliberately narrow: only the documented task-notification
  // envelope is accepted, tags are bounded, and the raw XML is never surfaced as an assistant reply.
  function parseClaudeTaskNotification(content) {
    const text = typeof content === 'string' ? content : '';
    if (!/<task-notification(?:\s|>)/i.test(text)) return null;
    const status = claudeTaskNotificationTag(text, 'status', 80).trim().toLowerCase();
    const result = claudeTaskNotificationTag(text, 'result');
    const summary = claudeTaskNotificationTag(text, 'summary', 4000);
    const failed = /^(?:failed|error|cancelled|canceled|stopped|interrupted)$/.test(status);
    return {
      kind: 'subagent_notification',
      taskId: claudeTaskNotificationTag(text, 'task-id', 256).trim(),
      toolUseId: claudeTaskNotificationTag(text, 'tool-use-id', 256).trim(),
      outputFile: claudeTaskNotificationTag(text, 'output-file', 4096).trim(),
      status: status || (failed ? 'failed' : 'completed'),
      summary,
      note: claudeTaskNotificationTag(text, 'note', 4000),
      result: (result || summary).slice(0, CLAUDE_TASK_NOTIFICATION_MAX_CHARS),
      resultChars: (result || summary).length,
      resultTruncated: (result || summary).length > CLAUDE_TASK_NOTIFICATION_MAX_CHARS,
      failed,
    };
  }
  function parseClaudeEvent(evt) {
    const out = [];
    if (!evt || typeof evt !== 'object') return [{ kind: 'unknown', raw: evt }];
    const sid = evt.session_id || evt.sessionId;

    if (evt.type === 'system') {
      if (sid) out.push({ kind: 'init', sessionId: sid, subtype: evt.subtype });
      return out.length ? out : [{ kind: 'unknown', raw: evt }];
    }

    if (evt.type === 'stream_event' || evt.type === 'content_block_delta' || evt.event) {
      // Per-API-CALL usage (message_start carries the input breakdown; message_delta the output).
      // This is NOT the cumulative turn total, so it reflects true context-window occupancy.
      const inner = evt.event || evt;
      const mu = (inner && inner.message && inner.message.usage) || (inner && inner.usage);
      if (mu && typeof mu === 'object' && ('input_tokens' in mu || 'output_tokens' in mu || 'cache_read_input_tokens' in mu || 'cache_creation_input_tokens' in mu)) {
        out.push({ kind: 'msg_usage', usage: mu });
      }
      const holder = deltaOf(evt.event || evt);
      const delta = holder && holder.delta;
      if (delta) {
        const dt = delta.type || '';
        if (dt === 'text_delta' && typeof delta.text === 'string') {
          out.push({ kind: 'text', text: delta.text, partial: true, index: holder.index });
        } else if (/thinking|reasoning/i.test(dt) || typeof delta.thinking === 'string' || typeof delta.reasoning === 'string') {
          // Tolerate old (thinking_delta) + new adaptive/reasoning shapes and varying text fields.
          const t = [delta.thinking, delta.reasoning, delta.text].find(v => typeof v === 'string') || '';
          if (t) out.push({ kind: 'thinking', text: t, partial: true, index: holder.index });
        }
        // signature_delta and other unknown deltas are intentionally ignored
      }
      if (out.length) return out;
      // fall through to structural handling below if it wasn't a recognized delta
    }

    if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
      if (evt.message.usage) out.push({ kind: 'msg_usage', usage: evt.message.usage }); // complete per-call usage
      for (const block of evt.message.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          out.push({ kind: 'text', text: block.text, partial: false });
        } else if (block.type === 'redacted_thinking') {
          out.push({ kind: 'thinking', text: '[redacted thinking]', partial: false, redacted: true });
        } else if (/thinking|reasoning/i.test(block.type || '') || typeof block.thinking === 'string' || typeof block.reasoning === 'string') {
          // Robust across thinking(enabled)/thinking(adaptive)/reasoning block variants + text field names.
          const t = [block.thinking, block.reasoning, block.text, (typeof block.content === 'string' ? block.content : null)].find(v => typeof v === 'string') || '';
          out.push({ kind: 'thinking', text: t, partial: false });
        } else if (block.type === 'tool_use') {
          out.push({ kind: 'tool_use', id: block.id, name: block.name, input: block.input });
        }
      }
      return out.length ? out : [{ kind: 'unknown', raw: evt }];
    }

    if (evt.type === 'user' && evt.message) {
      if (typeof evt.message.content === 'string') {
        const notification = parseClaudeTaskNotification(evt.message.content);
        if (notification) return [notification];
      } else if (Array.isArray(evt.message.content)) {
        for (const block of evt.message.content) {
          if (block && block.type === 'tool_result') {
            out.push({ kind: 'tool_result', id: block.tool_use_id, content: block.content, isError: Boolean(block.is_error) });
          }
        }
      }
      return out.length ? out : [{ kind: 'unknown', raw: evt }];
    }

    if (evt.type === 'result') {
      return [{
        kind: 'result',
        sessionId: sid,
        ok: evt.subtype === 'success' || (!evt.is_error && evt.subtype !== 'error'),
        subtype: evt.subtype,
        result: typeof evt.result === 'string' ? evt.result : undefined,
        usage: evt.usage,
        costUsd: evt.total_cost_usd ?? evt.cost_usd,
        durationMs: evt.duration_ms,
        numTurns: evt.num_turns,
      }];
    }

    return [{ kind: 'unknown', raw: evt }];
  }

  // Claude CLI's native Agent/Task tool returns the child agent's final answer as the parent
  // tool_result.  Unlike workbench-managed sub-turns, the CLI does not expose that child's
  // intermediate events, so this result is the only inspectable evidence of what it did.  Keep a
  // bounded, display-safe copy for the UI instead of reducing it to a character count.
  const NATIVE_CLAUDE_AGENT_RESULT_MAX_CHARS = 100000;
  function nativeClaudeAgentResultInfo(content, isError) {
    const textOf = value => {
      if (value == null) return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
      if (typeof value === 'object') {
        // Anthropic accepts both a plain string and content-block arrays for tool_result.
        if (typeof value.text === 'string') return value.text;
        if (typeof value.content === 'string') return value.content;
        if (Array.isArray(value.content)) return textOf(value.content);
        try { return JSON.stringify(value, null, 2); } catch { return String(value); }
      }
      return String(value);
    };
    const fullText = textOf(content);
    let structured = null;
    if (content && !Array.isArray(content) && typeof content === 'object') structured = content;
    if (!structured && typeof content === 'string' && /^\s*\{[\s\S]*\}\s*$/.test(content)) {
      try { structured = JSON.parse(content); } catch { /* ordinary text result */ }
    }
    const notification = parseClaudeTaskNotification(fullText);
    const structuredStatus = String(structured && structured.status || notification && notification.status || '').trim().toLowerCase();
    const agentId = String(
      structured && (structured.agentId || structured.agent_id || structured.taskId || structured.task_id)
        || notification && notification.taskId
        || (fullText.match(/(?:^|\n)\s*(?:agentId|agent_id|taskId|task_id)\s*:\s*([^\s\r\n]+)/i) || [])[1]
        || ''
    ).trim().slice(0, 256);
    const outputFile = String(
      structured && (structured.outputFile || structured.output_file)
        || notification && notification.outputFile
        || (fullText.match(/(?:^|\n)\s*(?:output_file|outputFile)\s*:\s*([^\r\n]+)/i) || [])[1]
        || ''
    ).trim().slice(0, 4096);
    const background = structuredStatus === 'async_launched'
      || /^(?:running|pending|in_progress|started)$/.test(structuredStatus)
      || /\b(?:async|background)\s+(?:agent|task)\b[\s\S]{0,200}\b(?:launched|started|running)\b/i.test(fullText)
      || /\b(?:agent|task)\b[\s\S]{0,200}\bworking in the background\b/i.test(fullText)
      || /(?:^|\n)\s*output_file\s*:/i.test(fullText)
      || /\b(?:task|agent)\s+(?:is\s+)?still\s+running\b/i.test(fullText);
    const notificationResult = notification && notification.result;
    const structuredResult = structured && typeof structured === 'object'
      ? (typeof structured.result === 'string' ? structured.result
        : (Array.isArray(structured.content) ? textOf(structured.content) : ''))
      : '';
    const displayText = notificationResult || structuredResult || fullText;
    const result = displayText.length > NATIVE_CLAUDE_AGENT_RESULT_MAX_CHARS
      ? displayText.slice(0, NATIVE_CLAUDE_AGENT_RESULT_MAX_CHARS)
      : displayText;
    // Some Anthropic-compatible endpoints send a failed Task result as ordinary text rather than
    // setting tool_result.is_error.  Classify only unmistakable, leading transport/task failures so
    // a normal review that merely *mentions* an API error is not marked failed.
    const looksLikeFailure = /^(?:api\s+error\b|error\s*:|(?:request|network|connection)\s+(?:failed|closed|error)\b|(?:agent|task)\s+(?:failed|error)\b)/i.test(fullText.trim())
      || /^(?:failed|error|cancelled|canceled|stopped|interrupted)$/.test(structuredStatus)
      || Boolean(notification && notification.failed);
    return {
      result,
      resultChars: displayText.length,
      resultTruncated: displayText.length > result.length,
      failed: Boolean(isError) || looksLikeFailure,
      background,
      agentId,
      outputFile,
      status: structuredStatus || (background ? 'running' : (looksLikeFailure ? 'failed' : 'completed')),
    };
  }

  // A Claude CLI print process exits after every workbench turn. Normally --resume reconnects the
  // next process to the native transcript, but continuity is not guaranteed across CLI upgrades,
  // workbench restarts, provider/model changes, or a missing/moved Claude session file. Keep a
  // bounded display-history copy on every normal Claude turn.

  return { nativeClaudeAgentResultInfo, parseClaudeEvent, parseClaudeTaskNotification };
}

module.exports = { createAgentCliEvents };
