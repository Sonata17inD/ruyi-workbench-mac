'use strict';
const { runKeyedChain } = require('./keyed-chain.cjs');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { platformShellEnvironment } = require('./mac-launch-policy.cjs');
function createShellSessions({ ProcessRuntime, killChildTree, nowIso, persistBackgroundJob,
  backgroundChanged, redact, safeSessionId, sessionPath }) {
// ===================================================================================================
// Persistent managed bash sessions (provider engine only).
// A session = one long-lived bash child whose stdout+stderr stream into a
// ring buffer. State lives ONLY in the serve process Map below; the one-shot MCP child (Claude CLI
// engine) cannot host it (RUNTIME.isMcpChild guard in toolCall), so shell_* return a guiding error there.
// Cursor semantics = ABSOLUTE offset since session start, measured in UTF-16 code units (chunks are
// toString('utf8')-decoded BEFORE length accounting — so this is a JS char offset, NOT raw bytes; do not
// use it for external byte math). When buf is trimmed at the head (>200KB units), the evicted unit count
// accumulates into baseOffset; a cursor below baseOffset yields truncated:true.
// ===================================================================================================
const SHELL_BUF_MAX = 200 * 1024;                 // ring-buffer cap per session (UTF-16 units of retained tail)
const SHELL_IDLE_MS = 30 * 60 * 1000;             // auto-kill sessions idle longer than this
const shellSessions = new Map();                  // shellId -> { child, name, cwd, buf, baseOffset, running, exitCode, startedAt, lastUsedAt }

function completeBackgroundJob(shellId, sess) {
  if (sess.mode !== 'background' || sess.notified || !sess.sessionId) return;
  sess.notified = true;
  if (!fs.existsSync(sessionPath(sess.sessionId))) return;
  const job = {
    id: sess.jobId, shellId, name: sess.name, sessionId: sess.sessionId,
    status: sess.cleanup?.incomplete ? 'failed' : sess.cancelled ? 'cancelled' : sess.timedOut ? 'timed_out' : sess.exitCode === 0 ? 'succeeded' : 'failed',
    ...shellCleanupFields(sess),
    exitCode: sess.exitCode, output: String(sess.buf || '').slice(-6000), truncated: sess.baseOffset > 0 || sess.buf.length > 6000,
    completedAt: nowIso(),
  };
  persistBackgroundJob(job);
}
function shellIdValid(id) { return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(id); }
function genShellId() { return 'sh_' + crypto.randomBytes(5).toString('hex'); }

// Append a chunk to a session's ring buffer, trimming the head past SHELL_BUF_MAX and accounting the
// evicted units into baseOffset so cursor offsets stay absolute across trims.
function shellAppend(sess, chunk) {
  sess.buf += chunk;
  if (sess.buf.length > SHELL_BUF_MAX) {
    const drop = sess.buf.length - SHELL_BUF_MAX;
    sess.buf = sess.buf.slice(drop);
    sess.baseOffset += drop;
  }
}

// Total absolute offset (UTF-16 units) of the buffer's tail end (== units ever written, modulo trimming accounting).
function shellEndOffset(sess) { return sess.baseOffset + sess.buf.length; }

// Slice the buffer from an absolute cursor to the end. cursor < baseOffset → start at baseOffset,
// truncated:true (the requested region was already evicted). Returns { output, cursor, truncated }.
function shellSliceFrom(sess, cursor) {
  const end = shellEndOffset(sess);
  let from = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0;
  let truncated = false;
  if (from < sess.baseOffset) { from = sess.baseOffset; truncated = true; }
  if (from > end) from = end;
  const output = sess.buf.slice(from - sess.baseOffset);
  return { output, cursor: end, truncated, from };
}

// NE-2:shell_poll / shell_send 的输出整形。修前一次最多回 200K 字符,且 output 排在 cursor/running/exitCode 前面 —— 超过 60K 后
// 模型看不到「作业结束了没」。现在:状态字段在前;output 封顶 maxChars(默认 16000,范围 500..30000)。
// cursor 语义统一:cursor = 本次返回的输出【结束处】的绝对偏移(UTF-16 单位,不是字节)—— 原样传回下一次 shell_poll 即续读,不丢不重。
//   · 不传 cursor(或 0)= 「看最新」:缓冲超过 maxChars 时取 开头 20% + 结尾 80%,中间写明省略区间 omittedFrom..omittedTo(绝对偏移),
//     cursor 落在缓冲末尾;想读回中间某段,用 cursor=omittedFrom 分页。
//   · 传 cursor>0 = 「往后翻页」:从 cursor 起最多 maxChars 字符,more:true 表示后面还有,cursor 是这一页的末尾。
const SHELL_OUTPUT_DEFAULT_CHARS = 16000;
const SHELL_OUTPUT_MIN_CHARS = 500;
const SHELL_OUTPUT_MAX_CHARS = 30000;
const SHELL_POLL_WAIT_MAX_MS = 30000;
function shellOutputCap(args) {
  const n = Number(args && args.maxChars);
  if (!Number.isFinite(n) || n <= 0) return SHELL_OUTPUT_DEFAULT_CHARS;
  return Math.min(SHELL_OUTPUT_MAX_CHARS, Math.max(SHELL_OUTPUT_MIN_CHARS, Math.floor(n)));
}
const isHighSurrogate = c => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = c => c >= 0xdc00 && c <= 0xdfff;
// slice = shellSliceFrom 的结果;paging=true 走「往后翻页」。返回 { output, cursor, more?, omittedChars?, omittedFrom?, omittedTo?, hint? }。
function shellShapeOutput(slice, cap, paging) {
  const text = slice.output;
  if (text.length <= cap) return { output: text, cursor: slice.cursor };
  if (paging) {
    let n = cap;
    if (isHighSurrogate(text.charCodeAt(n - 1))) n -= 1;
    const cursor = slice.from + n;
    return { output: text.slice(0, n), cursor, more: true, remainingChars: slice.cursor - cursor,
      hint: `后面还有 ${slice.cursor - cursor} 字符;用 cursor=${cursor} 继续读下一页` };
  }
  let headN = Math.floor(cap * 0.2);
  if (isHighSurrogate(text.charCodeAt(headN - 1))) headN -= 1;
  let tailStart = text.length - (cap - headN);
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1;
  const omittedFrom = slice.from + headN;
  const omittedTo = slice.from + tailStart;
  const omittedChars = tailStart - headN;
  const marker = `\n[...省略偏移 ${omittedFrom}..${omittedTo} 共 ${omittedChars} 字符;shell_poll({shellId, cursor:${omittedFrom}}) 可读回...]\n`;
  return { output: text.slice(0, headN) + marker + text.slice(tailStart), cursor: slice.cursor, omittedChars, omittedFrom, omittedTo,
    hint: '输出过长,只返回了开头和最新一段;中间被省略的部分可用 cursor=omittedFrom 分页读回' };
}

// 持久 shell 的数量上限。cap(config.shellSessionMax,默认 3)是【每个会话】的:shell_list / shell_kill 本来就只看得见、管得了本会话开的
// (见 shellVisibleTo),修前上限却是全进程共用的 —— 会话 B 被「已达上限 3」拒绝,自己的 shell_list 却是空的、也杀不掉 A 开的。
// 全局另设一个安全上限(防止多会话 / 多子代理合起来把机器的进程撑爆),它与每会话上限取大者。
const SHELL_GLOBAL_MAX = 12;
// Command input is NUL-delimited; completion metadata uses fd 4, separate from stdout/stderr.
const MAC_SHELL_DRIVER = [
  'function __ruyi_report() {',
  '  __ruyi_cwd="$(builtin pwd -P; builtin printf .)"',
  '  __ruyi_cwd="${__ruyi_cwd%.}"',
  '  __ruyi_cwd="${__ruyi_cwd%$\'\\n\'}"',
  '  builtin printf "%s\\0%s\\0%s\\0" "$1" "$2" "$__ruyi_cwd" >&4',
  '}',
  '__ruyi_report 0 0',
  'while IFS= builtin read -r -d "" __ruyi_id && IFS= builtin read -r -d "" __ruyi_command; do',
  '  builtin eval "$__ruyi_command" </dev/null 4>&-',
  '  __ruyi_status=$?',
  '  __ruyi_report "$__ruyi_id" "$__ruyi_status" || exit 125',
  'done',
].join('\n');
const MAC_SHELL_COMMAND_MAX_BYTES = 1024 * 1024;
const macShellSendChains = new Map();

function bindMacShellProtocol(sess) {
  const channel = sess.child.stdio[4];
  let buffer = '';
  let resolveReady;
  sess.protocolReady = new Promise(resolve => { resolveReady = resolve; });
  sess.commandSequence = 0;
  const fail = () => {
    sess.protocolError = 'shell_protocol_invalid';
    buffer = ''; channel.destroy();
    resolveReady({ ok: false });
    if (sess.pendingCommand) { sess.pendingCommand.resolve(); sess.pendingCommand = null; }
    killChildTree(sess.child);
  };
  channel.setEncoding('utf8');
  channel.on('error', fail);
  channel.on('end', () => { sess.protocolClosed = true; resolveReady({ ok: false }); channel.destroy(); });
  channel.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 8192) { fail(); return; }
    for (;;) {
      const parts = buffer.split('\0');
      if (parts.length < 4) return;
      const [id, status, cwd] = parts;
      buffer = parts.slice(3).join('\0');
      if (!/^\d+$/.test(id) || !/^\d+$/.test(status) || Number(status) > 255 || !path.isAbsolute(cwd)) { fail(); return; }
      if (id === '0' && !sess.protocolStarted) {
        sess.protocolStarted = true; sess.cwd = cwd; resolveReady({ ok: true }); continue;
      }
      if (!sess.pendingCommand || sess.pendingCommand.completing || id !== String(sess.pendingCommand.id)) { fail(); return; }
      const pending = sess.pendingCommand;
      pending.completing = true;
      // Keep the command busy while ready stdout/stderr callbacks drain across the private-fd boundary.
      setImmediate(() => setImmediate(() => {
        if (sess.pendingCommand !== pending) return;
        sess.cwd = cwd;
        sess.lastCommandExitCode = Number(status);
        pending.resolve(); sess.pendingCommand = null;
      }));
    }
  });
  sess.child.once('close', () => {
    resolveReady({ ok: false });
    if (sess.pendingCommand) { sess.pendingCommand.resolve(); sess.pendingCommand = null; }
  });
}

async function sendMacShell(sess, args, ctx) {
  const signal = ctx && ctx.signal;
  if (signal?.aborted) return { ok: false, interrupted: true, running: sess.running, error: 'shell 命令在发送前已取消' };
  if (sess.protocolError || sess.protocolClosed) return { ok: false, error: sess.protocolError || 'shell_protocol_closed', running: sess.running };
  if (sess.pendingCommand) return { ok: false, error: '上一条命令仍在执行，请用 shell_poll 查看或 shell_kill 取消', running: true, commandRunning: true };
  const input = String(args.input == null ? '' : args.input);
  if (input.includes('\0') || Buffer.byteLength(input, 'utf8') > MAC_SHELL_COMMAND_MAX_BYTES) {
    return { ok: false, code: 'invalid_args', error: '命令不能包含 NUL，且 UTF-8 内容不得超过 1MiB' };
  }
  const startCursor = shellEndOffset(sess);
  if (!sess.running) return shellSendResult(sess, shellSliceFrom(sess, startCursor), args, 'exit');
  let resolveCommand;
  const done = new Promise(resolve => { resolveCommand = resolve; });
  sess.pendingCommand = { id: ++sess.commandSequence, resolve: resolveCommand };
  sess.lastCommandExitCode = undefined;
  sess.lastUsedAt = Date.now(); scheduleShellReaper();
  sess.child.stdin.write(String(sess.commandSequence) + '\0' + input + '\0', error => {
    if (error) {
      sess.protocolError = 'shell_input_failed';
      if (sess.pendingCommand) { sess.pendingCommand.resolve(); sess.pendingCommand = null; }
      killChildTree(sess.child);
    }
  });
  let timer;
  let abortHandler;
  let interrupted = false;
  const aborted = new Promise(resolve => {
    abortHandler = () => {
      interrupted = true;
      void stopMacShell(String(args.shellId), sess).then(resolve, resolve);
    };
    if (signal) signal.addEventListener('abort', abortHandler, { once: true });
  });
  const timeoutMs = Math.min(120000, Math.max(1000, Number(args.timeoutMs) || 10000));
  try { await Promise.race([done, aborted, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
  finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', abortHandler); }
  const settled = sess.pendingCommand ? 'timeout' : sess.running ? 'completed' : 'exit';
  sess.lastUsedAt = Date.now(); scheduleShellReaper();
  const result = shellSendResult(sess, shellSliceFrom(sess, startCursor), args, settled);
  if (interrupted) return { ...result, ok: false, interrupted: true, error: 'shell 命令已取消', ...shellCleanupFields(sess) };
  if (sess.protocolError) return { ...result, ok: false, error: sess.protocolError };
  if (settled === 'completed' && sess.lastCommandExitCode !== 0) return { ...result, ok: false, error: '命令以退出码 ' + sess.lastCommandExitCode + ' 结束' };
  return result;
}

async function stopMacShell(shellId, sess) {
  sess.cancelled = true;
  killChildTree(sess.child);
  const cleanup = await ProcessRuntime.waitForCleanup(sess.child);
  sess.cleanup = cleanup || { scope: 'unknown', incomplete: true };
  if (sess.cleanup.incomplete) return { ok: false, error: 'shell 子进程清理尚未确认完成', ...shellCleanupFields(sess) };
  sess.running = false;
  sess.child.stdout?.destroy(); sess.child.stderr?.destroy(); sess.child.stdio[4]?.destroy();
  if (shellSessions.get(shellId) === sess) shellSessions.delete(shellId); scheduleShellReaper();
  return { ok: true, ...shellCleanupFields(sess) };
}

function shellCleanupFields(sess) {
  return sess.cleanup ? { cleanupScope: sess.cleanup.scope, cleanupIncomplete: sess.cleanup.incomplete,
    cleanupEscapeCoverage: sess.cleanup.escapeCoverage, cleanupUnconfirmed: sess.cleanup.unconfirmed } : {};
}

// Spawn a managed bash child. Returns { ok, shellId, name, cwd } or { ok:false, error, hint }.
// 异步:要等到子进程【真的起来了】(spawn 事件)才回 ok —— spawn 的 ENOENT 是异步 error 事件,修前回 ok:true 却是个死会话。
async function shellStart(args, config, ctx = {}) {
  const max = (config && Number.isFinite(config.shellSessionMax)) ? config.shellSessionMax : 3;
  // The cap counts LIVE sessions only. Exited (running:false) sessions stay in the Map so their output
  // tail remains pollable — that's their value — but they must not eat concurrency slots (a naturally
  // exited shell would otherwise block new starts with a confusing "limit reached").
  const live = [...shellSessions.values()].filter(s => s.running);
  const mine = live.filter(s => shellVisibleTo(s, ctx)).length;
  if (mine >= max) {
    return { ok: false, error: `本会话的 shell 已达上限 ${max}(运行中 ${mine} 个)`, hint: '先 shell_kill 释放(shell_list 可见本会话全部,含已退出)' };
  }
  const globalMax = Math.max(SHELL_GLOBAL_MAX, max);
  if (live.length >= globalMax) {
    return { ok: false, error: `工作台全局 shell 数已达安全上限 ${globalMax}(含其它会话开的 ${live.length - mine} 个,本会话看不到也杀不了它们)`, hint: '稍后再试,或等其它会话 / 线程的 shell 结束、被空闲回收' };
  }
  let shellId = args.shellId;
  if (shellId !== undefined && shellId !== null && shellId !== '') {
    // Caller-specified id: deterministic (static FAKE_TOOL_SEQUENCE + models). Validate + reject clashes.
    if (!shellIdValid(String(shellId))) return { ok: false, error: 'shellId 非法(仅 [a-zA-Z0-9_-]{1,32})' };
    shellId = String(shellId);
    if (shellSessions.has(shellId)) return { ok: false, error: `shellId '${shellId}' 已存在` };
  } else {
    do { shellId = genShellId(); } while (shellSessions.has(shellId));
  }
  // 107-S0:工具分发(12 shell_start)总是传入执行闸解析好的 cwd;家目录兜底只留给没有 cwd 的直接调用方。
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : os.homedir();
  // NE-13:cwd 不存在时 spawn 只报告 ENOENT —— 先明说目录不存在。
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory'); }
  catch { return { ok: false, error: `工作目录不存在: ${cwd}`, hint: '确认 cwd 是已存在的目录,或省略 cwd 用线程工作目录' }; }
  const name = args.name ? String(args.name).slice(0, 80) : shellId;
  const command = args.command == null ? '' : String(args.command).trim();
  const mode = command ? 'background' : 'interactive';
  const timeoutMs = Math.min(24 * 60 * 60 * 1000, Math.max(1000, Number(args.timeoutMs) || SHELL_IDLE_MS));
  const language = args.language || 'bash';
  if (language !== 'bash') return { ok: false, code: 'invalid_args', error: 'shell_start supports bash' };
  if (process.platform !== 'darwin') return { ok: false, code: 'bash_unavailable', error: '本机尚未启用受管 bash 会话' };
  let scriptDirectory = '';
  let startingSession = null;
  const launchArgs = ['--noprofile', '--norc'];
  if (command && (command.includes('\0') || Buffer.byteLength(command, 'utf8') > MAC_SHELL_COMMAND_MAX_BYTES)) return { ok: false, code: 'command_too_long', error: 'Invalid shell command size' };
  startingSession = { name, cwd, mode, running: true, starting: true,
    sessionId: safeSessionId(ctx?.sessionId || ctx?.session?.id || ''), buf: '', baseOffset: 0, startedAt: Date.now(), lastUsedAt: Date.now() };
  shellSessions.set(shellId, startingSession); scheduleShellReaper();
  {
    if (command) {
      try {
        scriptDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-shell-'));
        const script = path.join(scriptDirectory, 'command.sh');
        await fsp.writeFile(script, command, { encoding: 'utf8', mode: 0o600 });
        launchArgs.push('--', script);
      } catch (error) {
        if (shellSessions.get(shellId) === startingSession) shellSessions.delete(shellId); scheduleShellReaper();
        if (scriptDirectory) await fsp.rm(scriptDirectory, { recursive: true, force: true }).catch(() => {});
        return { ok: false, error: String(error.message || error) };
      }
      if (startingSession.cancelled || shellSessions.get(shellId) !== startingSession) {
        await fsp.rm(scriptDirectory, { recursive: true, force: true }).catch(() => {});
        return { ok: false, code: 'cancelled', error: 'shell 启动已取消' };
      }
    } else launchArgs.push('-c', MAC_SHELL_DRIVER);
  }
  let child;
  try {
    child = await ProcessRuntime.spawn('/bin/bash', launchArgs, {
      cwd, signal: ctx?.signal,
      admit: () => { if (startingSession?.cancelled || (startingSession && shellSessions.get(shellId) !== startingSession)) throw Object.assign(new Error('Shell start cancelled'), { code: 'ABORT_ERR' }); },
      env: platformShellEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'],
      ...(!command ? { extraStdio: ['pipe'] } : {}),
    }, { ...ProcessRuntime.currentOwner(), kind: 'shell', sessionId: ctx?.sessionId || ctx?.session?.id || '', shellId });
  } catch (e) {
    if (startingSession && shellSessions.get(shellId) === startingSession) shellSessions.delete(shellId); scheduleShellReaper();
    if (scriptDirectory) await fsp.rm(scriptDirectory, { recursive: true, force: true }).catch(() => {});
    return { ok: false, code: e.code, ...(e.capability ? { capability: e.capability } : {}), error: e.message || 'spawn failed' };
  }
  if (startingSession.cancelled || shellSessions.get(shellId) !== startingSession) {
    killChildTree(child);
    await ProcessRuntime.waitForCleanup(child, 1500);
    if (scriptDirectory) await fsp.rm(scriptDirectory, { recursive: true, force: true }).catch(() => {});
    return { ok: false, code: 'cancelled', error: 'shell 启动已取消' };
  }
  // shell_send 往一个刚关了 stdin 的子进程里写 → 异步 EPIPE 落在 stdin 的 'error' 上(try/catch 接不住),
  // 没监听者就是 uncaughtException;吸收即可,子进程状态由 exit/close 收尾。
  if (child.stdin) child.stdin.on('error', () => {});
  const now = Date.now();
  // 135c(线程内后台任务条):记下命令原文供界面显示 —— 先过 04 的 redact(与权限弹窗/审计同一张表),压成一行、裁 200。
  const commandShown = command ? redact(command).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const sess = { child, name, cwd, mode, shellLanguage: language, command: commandShown, sessionId: safeSessionId(ctx?.sessionId || ctx?.session?.id || ''), jobId: crypto.randomBytes(12).toString('hex'), timedOut: false, buf: '', baseOffset: 0, running: true, exitCode: null, startedAt: now, lastUsedAt: now };
  if (!command) bindMacShellProtocol(sess);
  let deadline = null;
  if (command) {
    child.stdin.end();
    deadline = setTimeout(() => {
      if (!sess.running) return;
      sess.timedOut = true;
      shellAppend(sess, '\n[background command timed out]\n');
      try { killChildTree(child); } catch { /* already exited */ }
    }, timeoutMs);
    deadline.unref();
  }
  // Preserve UTF-8 characters split across pipe chunks.
  const makeDecoder = () => {
    const decoder = new StringDecoder('utf8');
    return { write: data => decoder.write(data), flush: () => '', end: () => decoder.end() };
  };
  const outDecoder = makeDecoder();
  const errDecoder = makeDecoder();
  let exitAt = 0;
  let exitTimer = null;
  let finalized = false;
  // 收尾只做一次:'close'(管道都关了)与后台任务的 'exit' 宽限(下面)两条路径共用。
  const finalize = (code, note) => {
    if (finalized) return;
    finalized = true;
    clearTimeout(deadline);
    if (scriptDirectory) void fsp.rm(scriptDirectory, { recursive: true, force: true }).catch(() => {});
    if (sess.spawnFailed) return; // 根本没起来的进程不算一次「作业完成」:不弹完成通知、不留死会话(shellStart 已回 ok:false)
    if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
    shellAppend(sess, outDecoder.end() + errDecoder.end());
    if (note) shellAppend(sess, note);
    sess.running = false; sess.exitCode = (code === null || code === undefined ? null : code); sess.lastUsedAt = Date.now(); scheduleShellReaper();
    sess.cleanup = ProcessRuntime.result(child);
    void ProcessRuntime.waitForCleanup(child).then(cleanup => { sess.cleanup = cleanup; completeBackgroundJob(shellId, sess); });
  };
  // NE-4:后台命令的主进程已退出,但一个脱离的孙进程(gradle/adb/docker daemon)还占着输出管道 → 'close' 迟迟不来,
  // sess.running 永远 true:不弹完成通知、一直占 shell 会话名额、空闲收割也不碰它(它把「后台运行中」的会话当活的)。
  // exit 后给一小段静默宽限排空管道(仍有输出就顺延,总共 ≤3s),之后销毁我们这一侧的流,按已收到的输出收尾。只管后台命令;
  // 交互式 shell 自己退出就是会话结束,不套这条。
  const armExitTimer = () => {
    if (exitTimer) clearTimeout(exitTimer);
    exitTimer = setTimeout(() => {
      exitTimer = null;
      if (finalized) return;
      try { if (child.stdout) child.stdout.destroy(); if (child.stderr) child.stderr.destroy(); child.stdio[4]?.destroy(); } catch { /* already closed */ }
      finalize(exitInfoCode, '\n[process exited; a background child kept the output pipe open — later output is not captured]\n');
    }, 500);
    if (exitTimer.unref) exitTimer.unref();
  };
  let exitInfoCode = null;
  const feed = (decoder, d) => {
    shellAppend(sess, decoder.write(d));
    if (exitAt && !finalized && Date.now() - exitAt < 3000) armExitTimer();
  };
  child.stdout?.on('data', d => feed(outDecoder, d));
  child.stderr?.on('data', d => feed(errDecoder, d));
  let spawned = false;
  child.once('spawn', () => { spawned = true; });
  child.on('error', err => { clearTimeout(deadline); if (!spawned) sess.spawnFailed = true; shellAppend(sess, `\n[shell error] ${err && err.message ? err.message : err}\n`); sess.running = false; });
  child.on('exit', code => { exitInfoCode = code; exitAt = Date.now(); armExitTimer(); });
  child.on('close', code => finalize(code));
  shellSessions.set(shellId, sess); scheduleShellReaper();
  // 等子进程真的起来(或起不来):起不来就别留一个 running:false 的空壳,直接说明原因。
  const readiness = await ProcessRuntime.ready(child);
  let spawnErr = readiness.ok ? null : readiness.error;
  if (!spawnErr && !command) {
    let readyTimer;
    try {
      const protocol = await Promise.race([sess.protocolReady, new Promise(resolve => { readyTimer = setTimeout(() => resolve({ ok: false }), 5000); })]);
      if (!protocol.ok) spawnErr = new Error('Mac shell control channel failed to initialize');
    } finally { clearTimeout(readyTimer); }
  }
  if (spawnErr) {
    clearTimeout(deadline);
    sess.spawnFailed = true;
    killChildTree(child);
    if (shellSessions.get(shellId) === sess) shellSessions.delete(shellId); scheduleShellReaper();
    return { ok: false, code: 'shell_unavailable', error: spawnErr.message };

  }
  if (sess.cancelled || shellSessions.get(shellId) !== sess) return { ok: false, code: 'cancelled', error: 'shell 启动已取消' };
  if (sess.running && mode === 'background' && sess.sessionId) backgroundChanged?.(sess.sessionId);
  return { ok: true, shellId, name, cwd: sess.cwd, mode, shell: 'bash', tty: false, ...(command ? { jobId: sess.jobId, notification: sess.sessionId ? 'session_push' : 'unbound', running: true, timeoutMs, cursor: 0 } : {}) };
}

// 135c(真机核实的隔离缺口):shell_list 修前列出【整个进程】的 shell,shell_poll/send/kill 也不认主 ——
// A 线程的模型能看到并杀掉 B 线程的后台命令。现在带 ctx.sessionId 的调用只看得见自己线程开的;
// 子代理的工具调用用的是父会话 id(08 toolCall 传 parentSession.id),所以父子之间照常互通。
// 不带 ctx 的内部调用方(空闲收割、关机收尸)仍然看得见全部。
function shellVisibleTo(sess, ctx) {
  const sid = safeSessionId(ctx?.sessionId || ctx?.session?.id || '');
  return !sid || !sess.sessionId || sess.sessionId === sid;
}
function shellLookup(shellId, ctx) {
  const sess = shellSessions.get(shellId);
  return sess && shellVisibleTo(sess, ctx) ? sess : null;
}

async function shellSend(args, ctx) {
  const shellId = String(args.shellId || '');
  const sess = shellLookup(shellId, ctx);
  // v0.8-S7 error guidance: an unknown shellId (typo, or the session was reaped/killed) → point the model
  // at shell_list / shell_start rather than leaving it to retry the same dead id.
  if (!sess) return { ok: false, error: `未知 shellId '${shellId}'`, hint: '用 shell_list 查看现有会话,或 shell_start 新建' };
  if (sess.mode === 'background') return { ok: false, error: '后台命令不接受输入;用 shell_poll 读取结果或 shell_kill 取消' };
  return runKeyedChain(macShellSendChains, sess.jobId, () => sendMacShell(sess, args, ctx));
}
// shell_send 的返回:状态字段在前,output(封顶,见 shellShapeOutput)在最后。
function shellSendResult(sess, slice, args, settled) {
  const shaped = shellShapeOutput(slice, shellOutputCap(args), false);
  const out = { ok: true, running: sess.running };
  if (!sess.running) out.exitCode = sess.exitCode;
  out.cursor = shaped.cursor;
  out.settled = settled;
  if (slice.truncated) out.truncated = true;
  if (shaped.omittedChars) { out.omittedChars = shaped.omittedChars; out.omittedFrom = shaped.omittedFrom; out.omittedTo = shaped.omittedTo; out.hint = shaped.hint; }
  Object.assign(out, shellCleanupFields(sess));
  if (sess.shellLanguage === 'bash') Object.assign(out, { cwd: sess.cwd, commandRunning: Boolean(sess.pendingCommand), commandExitCode: sess.lastCommandExitCode });
  out.output = shaped.output;
  return out;
}

// shell_poll {shellId, cursor?, maxChars?, waitMs?}。返回键序:ok/running/exitCode/timedOut/mode/cursor 在前,output 最后(NE-2)。
// waitMs(≤30s):长轮询 —— 当前没有可返回的新输出且作业还在跑时,等到有新输出或进程退出再返回;省得模型每隔几秒烧一整轮 LLM 去轮询。
async function shellPoll(args, ctx) {
  const shellId = String(args.shellId || '');
  const sess = shellLookup(shellId, ctx);
  // v0.8-S7 error guidance: same unknown-shellId hint as shell_send.
  if (!sess) return { ok: false, error: `未知 shellId '${shellId}'`, hint: '用 shell_list 查看现有会话,或 shell_start 新建' };
  sess.lastUsedAt = Date.now(); scheduleShellReaper();
  const cursorNum = args.cursor === undefined || args.cursor === null ? 0 : Number(args.cursor);
  const paging = Number.isFinite(cursorNum) && cursorNum > 0;
  const waitMs = Math.min(SHELL_POLL_WAIT_MAX_MS, Math.max(0, Number(args.waitMs) || 0));
  if (waitMs > 0) {
    const until = Date.now() + waitMs;
    const signal = ctx && ctx.signal;
    while (sess.running && shellEndOffset(sess) <= Math.max(paging ? cursorNum : 0, 0) && Date.now() < until) {
      if (signal && signal.aborted) break;
      await new Promise(r => setTimeout(r, 50));
      sess.lastUsedAt = Date.now(); scheduleShellReaper();
    }
  }
  const slice = shellSliceFrom(sess, cursorNum);
  const shaped = shellShapeOutput(slice, shellOutputCap(args), paging);
  const out = { ok: true, running: sess.running };
  if (!sess.running) out.exitCode = sess.exitCode;
  out.timedOut = sess.timedOut === true;
  out.mode = sess.mode || 'interactive';
  out.cursor = shaped.cursor;
  if (slice.truncated) out.truncated = true;
  if (shaped.more) { out.more = true; out.remainingChars = shaped.remainingChars; }
  if (shaped.omittedChars) { out.omittedChars = shaped.omittedChars; out.omittedFrom = shaped.omittedFrom; out.omittedTo = shaped.omittedTo; }
  if (shaped.hint) out.hint = shaped.hint;
  Object.assign(out, shellCleanupFields(sess));
  if (sess.shellLanguage === 'bash') Object.assign(out, { cwd: sess.cwd, commandRunning: Boolean(sess.pendingCommand), commandExitCode: sess.lastCommandExitCode });
  out.output = shaped.output;
  return out;
}

function shellKill(args, ctx) {
  const shellId = String(args.shellId || '');
  const sess = shellLookup(shellId, ctx);
  if (!sess) return { ok: false, error: `未知 shellId '${shellId}'` };
  if (sess.starting && !sess.child) { sess.cancelled = true; shellSessions.delete(shellId); scheduleShellReaper(); return { ok: true }; }
  return stopMacShell(shellId, sess);
}

function shellList(ctx) {
  const shells = [];
  for (const [shellId, s] of shellSessions) {
    if (!shellVisibleTo(s, ctx)) continue;
    shells.push({
      shellId, name: s.name, cwd: s.cwd, running: s.running, exitCode: s.exitCode, ...shellCleanupFields(s),
      mode: s.mode || 'interactive', timedOut: s.timedOut === true,
      startedAt: new Date(s.startedAt).toISOString(), lastUsedAt: new Date(s.lastUsedAt).toISOString(),
      bytes: shellEndOffset(s),
    });
  }
  return { ok: true, shells };
}

// 135c:线程内后台任务条的三个读写口(13d 的 /api/sessions/:id/background 路由用)。只认【后台命令】
// (shell_start 带 command 的那种):交互式 shell 是一个常驻提示符,不是「一件在跑的事」。
function shellLastLine(sess) {
  const tail = String(sess.buf || '').slice(-4000).split(/\r?\n/).map(l => l.trim())
    .filter(Boolean);
  return tail.length ? redact(tail[tail.length - 1]).slice(0, 160) : '';
}
function sessionBackgroundShellRows(sessionId) {
  const sid = safeSessionId(sessionId);
  const rows = [];
  if (!sid) return rows;
  for (const [shellId, s] of shellSessions) {
    if (s.mode !== 'background' || !s.running || s.sessionId !== sid) continue;
    rows.push({ id: 'shell:' + shellId, kind: 'shell', shellId, name: s.name, command: s.command || '', startedAt: new Date(s.startedAt).toISOString(), tail: shellLastLine(s) });
  }
  return rows;
}
function backgroundShellCountsBySession() {
  const counts = {};
  for (const [, s] of shellSessions) {
    if (s.mode !== 'background' || !s.running || !s.sessionId) continue;
    counts[s.sessionId] = (counts[s.sessionId] || 0) + 1;
  }
  return counts;
}
// 最近输出(给「看输出」):只给这条线程自己的 shell,且过一遍 redact。
function sessionShellOutputTail(sessionId, shellId, maxChars = 8000) {
  const sid = safeSessionId(sessionId);
  const sess = sid ? shellLookup(String(shellId || ''), { sessionId: sid }) : null;
  if (!sess || !sess.sessionId) return null;
  const cap = Math.min(20000, Math.max(200, Number(maxChars) || 8000));
  return { output: redact(String(sess.buf || '').slice(-cap)), truncated: sess.baseOffset > 0 || sess.buf.length > cap, running: sess.running === true };
}

// 13d 的后台任务路由经延迟绑定命名空间取这四个口(直接引用会造一条 13d->11 的新循环边,依赖图门禁不收)。
const backgroundShells = Object.freeze({
  rows: sessionBackgroundShellRows,
  counts: backgroundShellCountsBySession,
  outputTail: sessionShellOutputTail,
  stop: (sessionId, shellId) => shellKill({ shellId }, { sessionId }),
});

// Reap every live shell session (called on serve-process shutdown alongside killAllMcpClients).
function killAllShellSessions() {
  for (const [, s] of shellSessions) { s.cancelled = true; try { if (s.child && s.child.pid) killChildTree(s.child); } catch { /* ignore */ } }
  shellSessions.clear(); scheduleShellReaper();
}

// One deadline for the next eligible shell; no timer when empty or only running
// background jobs remain. Completion makes a background job eligible again.
let shellIdleReaper = null;
let shellReaping = false;
const shellReapRetryAfter = new WeakMap();
function scheduleShellReaper() {
  clearTimeout(shellIdleReaper);
  shellIdleReaper = null;
  if (shellReaping) return;
  let next = Infinity;
  for (const session of shellSessions.values()) {
    if (session.mode === 'background' && session.running) continue;
    if (Number.isFinite(session.lastUsedAt)) next = Math.min(next, Math.max(session.lastUsedAt + SHELL_IDLE_MS, shellReapRetryAfter.get(session) || 0));
  }
  if (!Number.isFinite(next)) return;
  shellIdleReaper = setTimeout(async () => {
    shellIdleReaper = null;
    shellReaping = true;
    const cutoff = Date.now() - SHELL_IDLE_MS;
    for (const [id, session] of shellSessions) {
      if (!(session.mode === 'background' && session.running) && session.lastUsedAt <= cutoff
          && (shellReapRetryAfter.get(session) || 0) <= Date.now()) {
        try { await shellKill({ shellId: id }); } catch { /* retry without hot-looping */ }
        if (shellSessions.get(id) === session) shellReapRetryAfter.set(session, Date.now() + 1000);
      }
    }
    shellReaping = false;
    scheduleShellReaper();
  }, Math.max(1, next - Date.now()));
  shellIdleReaper.unref();
}

// v0.8-S2: the guarding stub returned when a shell_* tool runs in the one-shot MCP child (Claude CLI
// engine). The session cannot live there; steer the model to the persistent provider engine, or to
// shell_run for a one-shot command.
function shellMcpChildGuard() {
  return {
    ok: false,
    error: 'shell 会话仅在原生 provider 引擎可用(工具运行于一次性 MCP 子进程,无法跨回合存活)',
    hint: '需要非阻塞长任务时请使用当前 CLI 引擎自己的后台命令工具,或切换到原生 provider 引擎使用 shell_start/shell_poll/shell_kill。短命令可用 shell_run 或显式语言的 script_run。',
  };
}

return { shellStart, shellVisibleTo, shellSend, shellPoll, shellKill, shellList, killAllShellSessions, shellMcpChildGuard, shellSessions, shellLastLine, sessionShellOutputTail, completeBackgroundJob, scheduleShellReaper, SHELL_IDLE_MS, backgroundShells, hasIdleWakeup: () => shellIdleReaper !== null };
}
module.exports = { createShellSessions };
