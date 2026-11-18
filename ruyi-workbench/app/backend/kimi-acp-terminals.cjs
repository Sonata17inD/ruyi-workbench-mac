'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { redact } = require('./secret-redaction.cjs');
const { kimiAcpRequestError, kimiAcpAssertSession, awaitKimiAcpWithSignal } = require('./kimi-acp-rpc.cjs');

function createKimiAcpTerminals({ classifyKimiAcpReadonlySearch, KIMI_ACP_SEARCH_BLOCKED_ENV_RE, guardWorkspaceExecute,
  ensureKimiAcpOperationPermission, kimiAcpNativeBashWrapperCandidate, ProcessRuntime, killChildTree, makeId }) {
  function kimiAcpTerminal(context, params) {
    kimiAcpAssertSession(params, context);
    const id = String(params && params.terminalId || '');
    const terminal = context.reg.kimiAcpTerminals && context.reg.kimiAcpTerminals.get(id);
    if (!terminal || terminal.released) throw kimiAcpRequestError(-32602, `Unknown or released terminalId: ${id}`);
    if (terminal.sessionId !== String(params.sessionId)) throw kimiAcpRequestError(-32602, 'terminalId belongs to a different session');
    return terminal;
  }

  function kimiAcpTerminalRef(value) {
    const pending = [value];
    const seen = new Set();
    for (let visited = 0; pending.length && visited < 64; visited++) {
      const row = pending.shift();
      if (!row || typeof row !== 'object' || seen.has(row)) continue;
      seen.add(row);
      if (row.type === 'terminal' && row.terminalId) return String(row.terminalId);
      if (Array.isArray(row)) pending.push(...row.slice(0, 32));
      else if (row.content) pending.push(row.content);
    }
    return '';
  }

  function kimiAcpTerminalDisplayResult(reg, terminalId) {
    if (!reg || !terminalId) return null;
    const active = reg.kimiAcpTerminals && reg.kimiAcpTerminals.get(terminalId);
    const snapshot = active || (reg.kimiAcpTerminalResults && reg.kimiAcpTerminalResults.get(terminalId));
    if (!snapshot) return null;
    const output = String((active ? kimiAcpTerminalOutputText(active) : snapshot.output) || '');
    if (output) return output;
    const code = snapshot.exitCode;
    const signal = snapshot.signal;
    return signal ? `[terminal exited: ${signal}]` : `[terminal exited: ${code == null ? 'unknown' : code}; no output]`;
  }

  function rememberKimiAcpTerminal(reg, terminal) {
    if (!reg || !terminal) return;
    if (!reg.kimiAcpTerminalResults) reg.kimiAcpTerminalResults = new Map();
    reg.kimiAcpTerminalResults.set(terminal.id, {
      output: kimiAcpTerminalOutputText(terminal), truncated: terminal.truncated, exitCode: terminal.exitCode, signal: terminal.signal, at: Date.now(),
    });
    while (reg.kimiAcpTerminalResults.size > 32) reg.kimiAcpTerminalResults.delete(reg.kimiAcpTerminalResults.keys().next().value);
  }

  // hunt2-engines#5:修前每来一块输出就把【整个】缓冲重新编码一遍再比长度 —— 输出量 N、上限 L 时是 O(N·L/块长),
  // 8MB 上限下 100MB 输出要阻塞事件循环四十多秒(整个服务跟着卡)。现在只累计新块的字节数,超过 2 倍上限才裁一次
  // (每次裁掉至少 L 字节,摊还线性);读的一侧经 kimiAcpTerminalOutputText 先裁到上限,对外口径与修前一致(≤ 上限、
  // 从头部裁、不切半个 UTF-8 字符、truncated 置位)。
  function trimKimiAcpTerminalOutput(terminal) {
    if (!(terminal.outputBytes > terminal.outputByteLimit)) return;
    const bytes = Buffer.from(terminal.output, 'utf8');
    let start = bytes.length - terminal.outputByteLimit;
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
    terminal.output = bytes.subarray(start).toString('utf8');
    terminal.outputBytes = bytes.length - start;
    terminal.truncated = true;
  }
  function appendKimiAcpTerminalOutput(terminal, text) {
    if (!text) return;
    terminal.output += text;
    terminal.outputBytes = (Number(terminal.outputBytes) || 0) + Buffer.byteLength(text, 'utf8');
    if (terminal.outputBytes > terminal.outputByteLimit * 2) trimKimiAcpTerminalOutput(terminal);
  }
  function kimiAcpTerminalOutputText(terminal) {
    trimKimiAcpTerminalOutput(terminal);
    return terminal.output;
  }

  function settleKimiAcpTerminal(terminal, exitCode, signal) {
    if (!terminal || terminal.exited) return;
    try { appendKimiAcpTerminalOutput(terminal, terminal.stdoutDecoder.end()); } catch { /* already drained */ }
    try { appendKimiAcpTerminalOutput(terminal, terminal.stderrDecoder.end()); } catch { /* already drained */ }
    terminal.exited = true;
    terminal.exitCode = Number.isInteger(exitCode) && exitCode >= 0 ? exitCode : null;
    terminal.signal = signal == null ? null : String(signal);
    terminal.resolveExit({ exitCode: terminal.exitCode, signal: terminal.signal });
  }

  async function killKimiAcpTerminal(terminal) {
    if (!terminal) return;
    const supervised = ProcessRuntime.result(terminal.child)?.scope === 'owned-group-and-observed';
    if (!terminal.exited) {
      try { if (terminal.child && terminal.child.pid) killChildTree(terminal.child); } catch { /* best effort */ }
      await Promise.race([terminal.waitPromise, new Promise(resolve => setTimeout(resolve, 3000))]);
      if (!terminal.exited) {
        try {
          if (supervised) killChildTree(terminal.child);
          else terminal.child.kill('SIGKILL');
        } catch { /* already gone */ }
        await Promise.race([terminal.waitPromise, new Promise(resolve => setTimeout(resolve, 500))]);
      }
      if (!terminal.exited && !supervised) settleKimiAcpTerminal(terminal, null, 'SIGKILL');
    }
    if (supervised) {
      const cleanup = await ProcessRuntime.waitForCleanup(terminal.child, 500);
      if (!cleanup || cleanup.incomplete || !terminal.exited) {
        throw kimiAcpRequestError(-32000, 'Terminal cleanup has not been confirmed');
      }
    }
  }

  async function handleKimiAcpTerminalCreate(params, context, requestMeta) {
    kimiAcpAssertSession(params, context);
    let command = String(params && params.command || '');
    const rawArgs = params && params.args === undefined ? [] : params && params.args;
    if (!Array.isArray(rawArgs) || rawArgs.length > 128
      || rawArgs.some(arg => typeof arg !== 'string' || arg.length > 32768 || arg.includes('\0'))) {
      throw kimiAcpRequestError(-32602, 'Invalid terminal arguments');
    }
    let args = rawArgs.slice();
    if (!command || command.length > 4096 || command.includes('\0')) {
      throw kimiAcpRequestError(-32602, 'Invalid terminal command or arguments');
    }
    let cwd = params && params.cwd ? String(params.cwd) : String(context.session.cwd || context.config.defaultWorkspace || os.homedir());
    if (!path.isAbsolute(cwd)) throw kimiAcpRequestError(-32602, 'terminal cwd must be an absolute path');
    let readonlySearch = null;
    let classified;
    try {
      // The classifier owns argv/cwd/read-root canonicalization. Its success descriptor is the only input
      // accepted by the read-only fast path; caller params.env is intentionally never copied into it.
      classified = await classifyKimiAcpReadonlySearch({ command, args, cwd, env: params && params.env }, context);
    } catch (error) {
      classified = { ok: false, reason: `classifier-error:${String(error && error.message || error)}` };
    }
    if (classified && classified.ok === true
      && typeof classified.command === 'string' && path.isAbsolute(classified.command)
      && Array.isArray(classified.args) && typeof classified.cwd === 'string' && path.isAbsolute(classified.cwd)) {
      readonlySearch = classified;
      command = classified.command;
      args = classified.args.map(value => String(value));
      cwd = classified.cwd;
    } else if (classified && classified.reason
      && (command === 'rg' || command.toLowerCase() === 'rg'
        || (path.isAbsolute(command) && path.basename(command).toLowerCase() === ('rg')))) {
      context.onEvent({ type: 'stderr', text: `[Kimi ACP 搜索策略] ${redact(String(classified.reason))}` });
    }
    const stat = await fsp.stat(cwd).catch(() => null);
    if (!stat || !stat.isDirectory()) throw kimiAcpRequestError(-32602, 'terminal cwd does not exist or is not a directory');
    const execGuard = readonlySearch
      ? { ok: true, absPath: cwd }
      : await guardWorkspaceExecute(cwd, { session: context.session, config: context.config });
    if (!execGuard.ok) throw kimiAcpRequestError(-32000, execGuard.error);
    const shellCommand = args.length === 2 && args[0] === '-c' ? args[1] : [command, ...args].join(' ');
    const nativeBashWrapper = kimiAcpNativeBashWrapperCandidate({ command, args, cwd, env: params && params.env }, context);
    if (!readonlySearch) {
      await awaitKimiAcpWithSignal(
        ensureKimiAcpOperationPermission(context, 'terminal', {
          command: shellCommand, cwd, ...(nativeBashWrapper ? { __kimiAcpNativeBashWrapper: nativeBashWrapper } : {}),
        }),
        requestMeta && requestMeta.signal,
      );
    }
    let env;
    if (readonlySearch) {
      env = {};
      for (const [name, value] of Object.entries(process.env)) {
        if (!KIMI_ACP_SEARCH_BLOCKED_ENV_RE.test(name)) env[name] = value;
      }
      if (readonlySearch.env && typeof readonlySearch.env === 'object' && !Array.isArray(readonlySearch.env)) {
        Object.assign(env, readonlySearch.env);
      }
    } else {
      env = { ...process.env };
      for (const item of (Array.isArray(params.env) ? params.env.slice(0, 128) : [])) {
        const name = String(item && item.name || '');
        const value = String(item && item.value || '');
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && value.length <= 32768 && !value.includes('\0')) env[name] = value;
      }
    }
    const outputByteLimit = Math.min(8 * 1024 * 1024, Math.max(4096, Number(params.outputByteLimit) || 1024 * 1024));
    const terminalId = makeId('kimi_terminal');
    const spawnCommand = nativeBashWrapper ? nativeBashWrapper.canonicalExecutable : command;
    const spawnArgs = nativeBashWrapper ? nativeBashWrapper.argv : args;
    let child;
    try {
      child = await ProcessRuntime.spawn(spawnCommand, spawnArgs, { cwd, env, signal: requestMeta?.signal, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
        { kind: 'kimi-terminal', sessionId: String(params.sessionId), toolCallId: terminalId });
    } catch (error) { throw kimiAcpRequestError(-32000, `Failed to create terminal: ${error && error.message || error}`); }
    let resolveExit;
    const waitPromise = new Promise(resolve => { resolveExit = resolve; });
    const terminal = {
      id: terminalId, sessionId: String(params.sessionId), child, output: '', outputBytes: 0, outputByteLimit, truncated: false,
      exited: false, released: false, exitCode: null, signal: null, resolveExit, waitPromise,
      stdoutDecoder: new StringDecoder('utf8'), stderrDecoder: new StringDecoder('utf8'),
    };
    context.reg.kimiAcpTerminals.set(terminalId, terminal);
    child.stdout.on('data', chunk => { appendKimiAcpTerminalOutput(terminal, terminal.stdoutDecoder.write(chunk)); context.reg.lastEventAt = Date.now(); });
    child.stderr.on('data', chunk => { appendKimiAcpTerminalOutput(terminal, terminal.stderrDecoder.write(chunk)); context.reg.lastEventAt = Date.now(); });
    child.once('error', error => {
      appendKimiAcpTerminalOutput(terminal, `\n[terminal error] ${String(error && error.message || error)}\n`);
      settleKimiAcpTerminal(terminal, null, 'ERROR');
    });
    child.once('close', (code, signal) => settleKimiAcpTerminal(terminal, code, signal));
    const readiness = await ProcessRuntime.ready(child);
    if (!readiness.ok) {
      context.reg.kimiAcpTerminals.delete(terminalId);
      throw kimiAcpRequestError(-32000, `Failed to create terminal: ${readiness.error && readiness.error.message || 'execution unavailable'}`);
    }
    if (requestMeta && requestMeta.signal && requestMeta.signal.aborted) {
      context.reg.kimiAcpTerminals.delete(terminalId);
      await killKimiAcpTerminal(terminal);
      throw kimiAcpRequestError(-32800, 'Request cancelled');
    }
    return { terminalId };
  }

  async function handleKimiAcpTerminalRequest(method, params, context, requestMeta) {
    if (method === 'terminal/create') return handleKimiAcpTerminalCreate(params, context, requestMeta);
    const terminal = kimiAcpTerminal(context, params);
    if (method === 'terminal/output') {
      return {
        output: kimiAcpTerminalOutputText(terminal), truncated: terminal.truncated,
        ...(terminal.exited ? { exitStatus: { exitCode: terminal.exitCode, signal: terminal.signal } } : {}),
      };
    }
    if (method === 'terminal/wait_for_exit') return awaitKimiAcpWithSignal(terminal.waitPromise, requestMeta && requestMeta.signal);
    if (method === 'terminal/kill') { await killKimiAcpTerminal(terminal); return {}; }
    if (method === 'terminal/release') {
      await killKimiAcpTerminal(terminal);
      terminal.released = true;
      context.reg.kimiAcpTerminals.delete(terminal.id);
      rememberKimiAcpTerminal(context.reg, terminal);
      return {};
    }
    throw kimiAcpRequestError(-32601, `Unsupported terminal method: ${method}`);
  }

  async function cleanupKimiAcpTerminals(reg) {
    const terminals = reg && reg.kimiAcpTerminals ? [...reg.kimiAcpTerminals.values()] : [];
    if (reg && reg.kimiAcpTerminals) reg.kimiAcpTerminals.clear();
    const results = await Promise.allSettled(terminals.map(async terminal => { terminal.released = true; await killKimiAcpTerminal(terminal); }));
    const unconfirmed = results.filter(result => result.status === 'rejected').length;
    if (unconfirmed && reg) {
      reg.kimiAcpCleanupIncomplete = Number(reg.kimiAcpCleanupIncomplete || 0) + unconfirmed;
      try { reg.onEvent?.({ type: 'stderr', text: `[Kimi terminal] ${unconfirmed} 个终端的清理尚未确认完成` }); } catch { /* observer may be closed */ }
    }
    return { unconfirmed };
  }

  return {
    handleKimiAcpTerminalRequest, cleanupKimiAcpTerminals, killKimiAcpTerminal,
    kimiAcpTerminalRef, kimiAcpTerminalDisplayResult,
  };
}

module.exports = { createKimiAcpTerminals };
