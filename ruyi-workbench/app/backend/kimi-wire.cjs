'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { safeJsonParse } = require('./ordinary-json.cjs');

function kimiCodeHome() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

function kimiWireSessionDir(nativeSessionId) {
  try {
    const indexFile = path.join(kimiCodeHome(), 'session_index.jsonl');
    const lines = fs.readFileSync(indexFile, 'utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const row = safeJsonParse(lines[i]);
      if (row && row.sessionId === nativeSessionId && row.sessionDir) return String(row.sessionDir);
    }
  } catch { /* absent native index */ }
  return '';
}

function kimiWireFile(nativeSessionId) {
  const dir = kimiWireSessionDir(nativeSessionId);
  return dir ? path.join(dir, 'agents', 'main', 'wire.jsonl') : '';
}

function parseKimiWireCompaction(row, contextWindow) {
  if (!row || typeof row !== 'object') return null;
  if (row.type === 'full_compaction.begin') return { type: 'compact', mode: 'kimi-native', phase: 'started', trigger: row.source || 'auto' };
  if (row.type === 'context.apply_compaction') return { type: 'compact', mode: 'kimi-native', phase: 'applied', beforeTokens: Number(row.tokensBefore) || 0, afterTokens: Number(row.tokensAfter) || 0, compactedCount: Number(row.compactedCount) || 0 };
  if (row.type === 'token_counting.rebased') return { type: 'usage', usage: {}, contextTokens: Number(row.tokens) || 0, contextWindow: Number(contextWindow) || undefined, source: 'kimi-wire' };
  if (row.type === 'full_compaction.complete') return { type: 'compact', mode: 'kimi-native', phase: 'completed' };
  if (row.type === 'full_compaction.cancel' || row.type === 'full_compaction.cancelled') return { type: 'compact', mode: 'kimi-native', phase: 'failed', error: row.reason || 'Kimi 压缩已取消' };
  return null;
}

function kimiWireLoopEvent(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.type === 'context.append_loop_event' && row.event && typeof row.event === 'object') return row.event;
  return row;
}

function kimiWireSubagentId(nativeId) {
  return `kimi:${String(nativeId || '').trim()}`;
}

function ensureKimiWireSubagent(state, nativeId, patch = {}) {
  const key = String(nativeId || '').trim();
  if (!key) return { agent: null, created: false };
  if (!state.subagents) state.subagents = new Map();
  let agent = state.subagents.get(key);
  const created = !agent;
  if (!agent) {
    agent = {
      id: kimiWireSubagentId(key), nativeId: key, name: '', description: '', parentToolCallId: '', parentAgentId: '',
      runInBackground: false, model: '', thinkingEffort: '', startedAt: Date.now(), running: true, settled: false, lastProgressAt: 0,
    };
    state.subagents.set(key, agent);
  }
  for (const [name, value] of Object.entries(patch)) {
    if (value !== undefined && value !== null && value !== '') agent[name] = value;
  }
  return { agent, created };
}

function kimiWireSubagentStart(agent) {
  return {
    type: 'subagent', id: agent.id, state: 'start', task: agent.description || agent.name || `Kimi 子代理 ${agent.nativeId}`,
    roleId: agent.name || 'subagent', roleLabel: agent.name || 'Kimi 子代理', model: agent.model || undefined,
    thinkingEffort: agent.thinkingEffort || undefined, engine: 'kimi', native: true, agentId: agent.nativeId,
    parentToolCallId: agent.parentToolCallId || undefined, parentAgentId: agent.parentAgentId || undefined,
  };
}

// ACP's session/update schema deliberately has no subagent variants. Kimi does persist those native events
// in every agent's wire.jsonl, including the child tool lifecycle. Translate that authoritative local stream
// into Ruyi's existing subagent/card event contract rather than inventing a parallel UI protocol.
function parseKimiWireAgentEvents(row, wireAgentId, state = {}) {
  const event = kimiWireLoopEvent(row);
  if (!event || typeof event !== 'object') return [];
  const out = [];
  const type = String(event.type || '');
  const startIfNeeded = (agent, created) => { if (agent && created) out.push(kimiWireSubagentStart(agent)); };
  if (type === 'subagent.spawned') {
    const { agent, created } = ensureKimiWireSubagent(state, event.subagentId, {
      name: String(event.subagentName || ''), description: String(event.description || ''),
      parentToolCallId: String(event.parentToolCallId || ''), parentAgentId: String(event.parentAgentId || ''),
      runInBackground: event.runInBackground === true, model: String(event.model || ''), thinkingEffort: String(event.thinkingEffort || ''),
    });
    startIfNeeded(agent, created);
    if (agent && event.runInBackground === true) out.push({ type: 'subagent', id: agent.id, state: 'background', task: agent.description || agent.name, engine: 'kimi', native: true, agentId: agent.nativeId });
    return out;
  }
  if (type === 'subagent.started' || type === 'subagent.suspended' || type === 'subagent.completed' || type === 'subagent.failed') {
    const { agent, created } = ensureKimiWireSubagent(state, event.subagentId);
    if (!agent) return out;
    startIfNeeded(agent, created);
    if (type === 'subagent.started') {
      agent.running = true; agent.lastProgressAt = Date.now();
      out.push({ type: 'subagent_progress', subagentId: agent.id, state: 'running', note: 'Kimi 子代理运行中', noteCode: 'kimiRunning', engine: 'kimi', native: true, agentId: agent.nativeId });
    } else if (type === 'subagent.suspended') {
      agent.running = true;
      out.push({ type: 'subagent_progress', subagentId: agent.id, state: 'waiting', note: `Kimi 子代理已暂停：${String(event.reason || '等待继续')}`, noteCode: event.reason ? 'kimiPaused' : 'kimiPausedWaiting', reason: String(event.reason || ''), engine: 'kimi', native: true, agentId: agent.nativeId });
    } else if (!agent.settled) {
      agent.running = false; agent.settled = true;
      const ok = type === 'subagent.completed';
      const result = ok ? String(event.resultSummary || '') : String(event.error || 'Kimi 子代理执行失败');
      out.push({
        type: 'subagent', id: agent.id, state: 'end', ok, task: agent.description || agent.name || '', result,
        resultChars: result.length, usage: event.usage || undefined, contextTokens: Number(event.contextTokens) || undefined,
        engine: 'kimi', native: true, agentId: agent.nativeId,
      });
    }
    return out;
  }
  // Main-agent tools already arrive through ACP. Child wires are the missing half: nest their native
  // Glob/Grep/Bash/etc. cards under the corresponding subagent without duplicating the parent tool stream.
  const childId = String(wireAgentId || '');
  if (!childId || childId === 'main' || (type !== 'tool.call' && type !== 'tool.result')) return out;
  if (!state.childTools) state.childTools = new Map();
  const { agent, created } = ensureKimiWireSubagent(state, childId);
  if (!agent) return out;
  startIfNeeded(agent, created);
  const nativeToolId = String(event.toolCallId || '');
  if (!nativeToolId) return out;
  const key = `${childId}\u0000${nativeToolId}`;
  let tool = state.childTools.get(key);
  if (type === 'tool.call') {
    const input = event.args && typeof event.args === 'object' ? event.args : {};
    if (!tool) {
      tool = { id: `kimi:${childId}:${nativeToolId}`, name: String(event.name || 'KimiTool'), input, settled: false };
      state.childTools.set(key, tool);
      out.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input, subagentId: agent.id, engine: 'kimi', native: true });
    } else if (tool.name !== event.name || tool.input !== input) {
      tool.name = String(event.name || tool.name); tool.input = input;
      out.push({ type: 'tool_use_update', id: tool.id, name: tool.name, input: tool.input, subagentId: agent.id, engine: 'kimi', native: true });
    }
  } else if (!tool || !tool.settled) {
    if (!tool) {
      tool = { id: `kimi:${childId}:${nativeToolId}`, name: 'KimiTool', input: {}, settled: false };
      state.childTools.set(key, tool);
      out.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input, subagentId: agent.id, engine: 'kimi', native: true });
    }
    tool.settled = true;
    const result = event.result;
    out.push({
      type: 'tool_result', id: tool.id, subagentId: agent.id,
      content: result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'output') ? result.output : result,
      isError: Boolean(event.isError || (result && result.isError)), engine: 'kimi', native: true,
    });
  }
  return out;
}

function watchKimiWire(nativeSessionId, onEvent, contextWindow, state = {}) {
  const sessionDir = kimiWireSessionDir(nativeSessionId);
  const agentsDir = sessionDir && path.join(sessionDir, 'agents');
  if (!agentsDir || !fs.existsSync(agentsDir)) return () => {};
  const files = new Map();
  const addWireFile = (file, agentId, replay) => {
    if (!file || files.has(file) || !fs.existsSync(file)) return;
    // hunt2-engines#15:每个文件一只 StringDecoder —— 两次轮询之间的读窗口边界不保证落在字符边界上,各窗口单独
    // toString('utf8') 会把被切开的汉字变成 U+FFFD(子代理结论、工具输出里的中文就此乱码)。
    try { files.set(file, { file, agentId, offset: replay ? 0 : fs.statSync(file).size, pending: '', decoder: new StringDecoder('utf8') }); } catch { /* race with child cleanup */ }
  };
  const discover = replayNew => {
    let entries = [];
    try { entries = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(agentsDir, entry.name, 'wire.jsonl');
      addWireFile(file, entry.name, replayNew);
    }
  };
  discover(false);
  let reading = false;
  const timer = setInterval(async () => {
    if (reading) return;
    reading = true;
    try {
      discover(true);
      for (const track of files.values()) {
        const size = (await fsp.stat(track.file)).size;
        if (size < track.offset) { track.offset = 0; track.pending = ''; track.decoder = new StringDecoder('utf8'); }
        if (size <= track.offset) continue;
        const handle = await fsp.open(track.file, 'r');
        try {
          const buffer = Buffer.alloc(size - track.offset);
          await handle.read(buffer, 0, buffer.length, track.offset);
          track.offset = size;
          const lines = (track.pending + track.decoder.write(buffer)).split(/\r?\n/);
          track.pending = lines.pop() || '';
          for (const line of lines) {
            const row = safeJsonParse(line);
            if (!row) continue;
            if (track.agentId === 'main') {
              const compact = parseKimiWireCompaction(row, contextWindow);
              if (compact) onEvent(compact);
            }
            for (const event of parseKimiWireAgentEvents(row, track.agentId, state)) onEvent(event);
          }
        } finally { await handle.close(); }
      }
      const now = Date.now();
      for (const agent of state.subagents instanceof Map ? state.subagents.values() : []) {
        if (agent.running && !agent.settled && now - agent.lastProgressAt >= 2000) {
          agent.lastProgressAt = now;
          onEvent({ type: 'subagent_progress', subagentId: agent.id, state: 'running', note: `Kimi 子代理运行中 · ${Math.max(1, Math.round((now - agent.startedAt) / 1000))}s`, noteCode: 'kimiRunningFor', secs: Math.max(1, Math.round((now - agent.startedAt) / 1000)), engine: 'kimi', native: true, agentId: agent.nativeId });
        }
      }
    } catch { /* wire updates are best-effort */ } finally { reading = false; }
  }, 250);
  return () => clearInterval(timer);
}

async function readKimiWireRuntime(nativeSessionId) {
  const file = kimiWireFile(nativeSessionId);
  if (!file) return null;
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const stat = await handle.stat();
    const length = Math.min(stat.size, 1024 * 1024);
    const offset = stat.size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (offset > 0) lines.shift(); // first tail fragment is not a complete JSON row
    let tokens = 0;
    let busy = false;
    let compactionBegins = 0;
    let compactionCompletes = 0;
    for (const line of lines) {
      const row = safeJsonParse(line);
      if (!row) continue;
      if (row.type === 'turn.prompt') busy = true;
      else if (row.type === 'full_compaction.begin') { busy = true; compactionBegins++; }
      else if (row.type === 'turn.ended') busy = false;
      else if (row.type === 'full_compaction.complete') { busy = false; compactionCompletes++; }
      else if (row.type === 'full_compaction.cancel' || row.type === 'full_compaction.cancelled') { busy = false; compactionCompletes++; }
      if ((row.type === 'token_counting.measured' || row.type === 'token_counting.rebased') && Number(row.tokens) > 0) tokens = Number(row.tokens);
      else if (row.type === 'context.apply_compaction' && Number(row.tokensAfter) > 0) tokens = Number(row.tokensAfter);
    }
    return tokens > 0 ? { tokens, busy, file, size: stat.size, compactionBegins, compactionCompletes } : null;
  } catch { return null; } finally { if (handle) await handle.close().catch(() => {}); }
}

function kimiAcpWireCheckpoint(nativeSessionId) {
  const file = kimiWireFile(nativeSessionId);
  if (!file) return { file: '', size: 0 };
  try { return { file, size: fs.statSync(file).size }; } catch { return { file, size: 0 }; }
}

async function kimiAcpWireOutcome(nativeSessionId, checkpoint) {
  const file = kimiWireFile(nativeSessionId) || checkpoint && checkpoint.file;
  if (!file) return null;
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const stat = await handle.stat();
    let offset = checkpoint && checkpoint.file === file ? Math.min(Number(checkpoint.size) || 0, stat.size) : 0;
    if (stat.size - offset > 2 * 1024 * 1024) offset = stat.size - 2 * 1024 * 1024;
    const buffer = Buffer.alloc(stat.size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (offset > 0) lines.shift();
    let ended = null;
    for (const line of lines) {
      const row = safeJsonParse(line);
      if (row && row.type === 'turn.ended') ended = row;
    }
    if (!ended) return null;
    const error = ended.error && typeof ended.error === 'object' ? ended.error : {};
    return {
      reason: String(ended.reason || ''),
      error: String(error.message || error.detail || ended.message || error.code || ''),
      code: String(error.code || ''),
    };
  } catch { return null; } finally { if (handle) await handle.close().catch(() => {}); }
}

module.exports = {
  kimiCodeHome, kimiWireSessionDir, readKimiWireRuntime, parseKimiWireCompaction, parseKimiWireAgentEvents,
  watchKimiWire, kimiAcpWireCheckpoint, kimiAcpWireOutcome,
};
