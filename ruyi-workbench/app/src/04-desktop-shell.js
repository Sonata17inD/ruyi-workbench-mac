const DesktopShell = ((fsModule, fspModule, pathModule, osModule, cpModule, killTreeFn, spawnDetachedFn, decodeConsoleTextFn) => {
  const fs = fsModule;
  const fsp = fspModule;
  const path = pathModule;
  const os = osModule;
  const cp = cpModule;
  const killChildTree = killTreeFn;
  // 分离式启动带 'error' 监听(见 00-boot spawnDetachedChecked):explorer.exe 起不来时不再是 uncaughtException。
  const spawnDetachedChecked = spawnDetachedFn;
  // v1.0.1 编码修复:Windows 子进程(powershell/cmd/git/python…)在中文系统默认按 OEM 代码页(GBK/cp936)
  // 输出,而非 UTF-8。此前 runProcess 按 UTF-8 逐块 toString → 中文全乱码(GBK 字节 c2a6c9bd… 被读成「¦ɽ」)。
  // 修法:累积原始字节,收尾时智能解码——先按 UTF-8 解;若出现替换符(�,说明不是合法 UTF-8),退回 GBK。
  // 我们自己以 UTF-8 输出的工具不受影响(合法 UTF-8 无替换符,原样保留),GBK 原生命令输出也能正确还原。
  // 2026-09 起改为【按行】判定(00-boot decodeConsoleText):修前整段只要有一处不是合法 UTF-8 就整段按 GBK 解,
  // 混排输出(git 的 UTF-8 + 系统命令的 GBK)里总有一半是乱码。
  // 2026-10 补【源头】一层:Node 侧解码只能还原「有损但可逆」的 GBK;en-US 等非中文代码页的机器上,PowerShell 按控制台代码页
  // (OEM 437 / ANSI 1252)编码,中文在源头就变成 `?`,信息已丢。曾有注释称 [Console]::OutputEncoding 那类 PS 方案「在无窗口
  // spawn 下会静默失效」—— 在 en-US 机器上实测【不成立】:windowsHide 起的子进程有自己的隐藏控制台,脚本头设置后中文输出 /
  // 文件名 / cmd /c dir / Write-Host / stderr 全部正确。所以 withQuietProgress(见下)给脚本头加 UTF-8 输出编码前导
  // (00-boot PS_UTF8_OUTPUT_PREAMBLE,含共享控制台副作用的调查结论),Node 侧按行解码保留为兜底
  // (中文系统上设置失败、原生命令自己写 GBK 等;源头已是 UTF-8 时被 UTF-8 优先分支正确接住)。
  function decodeBestEffort(buf) {
    return decodeConsoleTextFn(buf);
  }
  // ---------------------------------------------------------------------------------------------------
  // 执行结果整形(NE-1)。模型最终只看得到序列化 JSON 的前 ~60K 字符(10 truncateToolResult 平切),而修前 runProcess
  // 把 stdout 放在 stderr/退出码/超时标记之前、单流最多 2MB:输出一过 60K,错误文本、timedOut、尾部(构建报错所在)整块丢失。
  // 修法是在【源头】整形:每条流 头+尾(中间明确写「已省略 N 字符」),键序 ok/code/timedOut/interrupted/error/stderr 在前、
  // stdout 在后,`\r` 覆盖式进度条折叠成最终一行、ANSI 控制序列剥掉。只对 options.shape===true 的调用方(shell_run /
  // script_run)生效 —— 其余内部调用方(MCP 登记、迁移中心、校验命令)要解析完整 stdout,不能被截。
  // ---------------------------------------------------------------------------------------------------
  const EXEC_TIMEOUT_DEFAULT = 60000;
  const EXEC_TIMEOUT_MIN = 1000;
  const EXEC_TIMEOUT_MAX = 30 * 60 * 1000;
  // NE-5:非数字 / NaN / 非正数 → 默认;其余夹到 [1s, 30min]。修前 `Number('abc')` = NaN → setTimeout(NaN) 约 1ms 就把进程杀了。
  function normalizeExecTimeout(raw, fallback = EXEC_TIMEOUT_DEFAULT) {
    const n = typeof raw === 'string' ? (raw.trim() === '' ? NaN : Number(raw)) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(EXEC_TIMEOUT_MAX, Math.max(EXEC_TIMEOUT_MIN, n));
  }
  const EXEC_STDOUT_HEAD = 8000, EXEC_STDOUT_TAIL = 24000;
  const EXEC_STDERR_HEAD = 4000, EXEC_STDERR_TAIL = 8000;
  const EXEC_JSON_BUDGET = 44000;            // 两条流序列化后的合计上限(远低于 60K 的模型硬顶;换行/引号转义会让 JSON 比原文长)
  const EXEC_HEAD_RAW_BYTES = 64 * 1024;     // 尾部滚动缓冲丢弃旧块后,开头另存这么多原始字节供「头」使用
  const EXEC_EXIT_GRACE_MS = 500;            // NE-4:主进程 exit 后等管道排空的静默宽限
  const EXEC_EXIT_GRACE_MAX_MS = 3000;       // 宽限的总上限(后台孙进程一直往管道写也不无限续期)
  const omitMarker = n => `\n[...已省略 ${n} 字符...]\n`;
  // ANSI CSI/OSC 剥掉;`\r\n` 归一为 `\n`;行内 `\r` 覆盖(pip/curl/winget/git clone 的进度条)只留最后一段非空文本。
  function condenseTerminalText(input) {
    let t = String(input == null ? '' : input);
    if (!t) return t;
    if (t.indexOf('\u001b') !== -1) t = t.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '');
    if (t.indexOf('\r') === -1) return t;
    t = t.replace(/\r\n/g, '\n');
    if (t.indexOf('\r') === -1) return t;
    return t.split('\n').map(line => {
      if (line.indexOf('\r') === -1) return line;
      const segs = line.split('\r');
      for (let i = segs.length - 1; i >= 0; i -= 1) if (segs[i] !== '') return segs[i];
      return '';
    }).join('\n');
  }
  // 头 n 字符,尽量收在整行边界(半行以上才回退),不劈开代理对。
  function cutHead(text, n) {
    if (text.length <= n) return text;
    let end = n;
    const nl = text.lastIndexOf('\n', n - 1);
    if (nl >= n * 0.5) end = nl + 1;
    else if (/[\ud800-\udbff]/.test(text[end - 1] || '')) end -= 1;
    return text.slice(0, end);
  }
  function cutTail(text, n) {
    if (text.length <= n) return text;
    let start = text.length - n;
    const nl = text.indexOf('\n', start);
    if (nl !== -1 && nl - start <= n * 0.5) start = nl + 1;
    else if (/[\udc00-\udfff]/.test(text[start] || '')) start += 1;
    return text.slice(start);
  }
  // 单段文本头+尾。够短原样返回;否则 头 + 省略标记 + 尾,omitted = 被省略的字符数。
  function headTailText(text, headN, tailN) {
    const s = String(text == null ? '' : text);
    if (s.length <= headN + tailN) return { text: s, omitted: 0 };
    const h = cutHead(s, headN);
    const t = cutTail(s, tailN);
    const omitted = Math.max(0, s.length - h.length - t.length);
    return { text: h + omitMarker(omitted) + t, omitted };
  }
  // src: { full } —— 整段都在;或 { head, tail, gapBytes } —— 滚动缓冲丢过旧块,开头/末尾各一段,中间 gapBytes 字节没了。
  function shapeOneStream(src, headN, tailN) {
    if (src.full !== undefined) {
      const r = headTailText(src.full, headN, tailN);
      return { text: r.text, omitted: r.omitted };
    }
    const h = cutHead(src.head, headN);
    const t = cutTail(src.tail, tailN);
    const omitted = src.gapBytes + (src.head.length - h.length) + (src.tail.length - t.length);
    return { text: h + omitMarker(omitted) + t, omitted };
  }
  function shapeExecStreams(outSrc, errSrc) {
    let scale = 1;
    let o; let e;
    for (;;) {
      o = shapeOneStream(outSrc, Math.floor(EXEC_STDOUT_HEAD * scale), Math.floor(EXEC_STDOUT_TAIL * scale));
      e = shapeOneStream(errSrc, Math.floor(EXEC_STDERR_HEAD * scale), Math.floor(EXEC_STDERR_TAIL * scale));
      if (scale <= 0.1 || JSON.stringify(o.text).length + JSON.stringify(e.text).length <= EXEC_JSON_BUDGET) break;
      scale *= 0.7;
    }
    return { stdout: o.text, stdoutOmitted: o.omitted, stderr: e.text, stderrOmitted: e.omitted };
  }

  function runProcess(command, args, options = {}) {
    return new Promise(resolve => {
      const start = Date.now();
      const timeoutMs = normalizeExecTimeout(options.timeoutMs);
      const shape = options.shape === true;
      const CAP = shape ? 1_000_000 : 2_000_000; // 字节上限(超出从最旧块丢弃,保留尾部;整形模式另存开头,见 EXEC_HEAD_RAW_BYTES)
      // 每条流一个状态:chunks 是滚动尾部,total 累计字节,dropped 被丢弃的旧块字节,head 开头原始字节(仅整形模式用)。
      const mkStream = () => ({ chunks: [], len: 0, total: 0, dropped: 0, head: Buffer.alloc(0), truncated: false });
      const outS = mkStream();
      const errS = mkStream();
      let timedOut = false;
      let interrupted = false;
      const collect = (st, d) => {
        st.chunks.push(d);
        st.len += d.length;
        st.total += d.length;
        if (shape && st.head.length < EXEC_HEAD_RAW_BYTES) st.head = Buffer.concat([st.head, d.subarray(0, EXEC_HEAD_RAW_BYTES - st.head.length)]);
        while (st.len > CAP && st.chunks.length > 1) { const old = st.chunks.shift(); st.len -= old.length; st.dropped += old.length; st.truncated = true; } // 审计 P0:CAP 截断需告知模型
      };
      const rawText = st => decodeBestEffort(Buffer.concat(st.chunks));
      const streamSrc = st => {
        if (!st.dropped) return { full: condenseTerminalText(rawText(st)) };
        if (st.dropped <= st.head.length) return { full: condenseTerminalText(decodeBestEffort(Buffer.concat([st.head.subarray(0, st.dropped), ...st.chunks]))) };
        return { head: condenseTerminalText(decodeBestEffort(st.head)), tail: condenseTerminalText(rawText(st)), gapBytes: st.dropped - st.head.length };
      };
      // Transparently wrap .cmd/.bat targets (e.g. claude.cmd) so they don't throw "spawn EINVAL".
      const s = { command, args, opts: {} };
      let processHandle;
      try {
        processHandle = ProcessRuntime.start({
          executable: s.command, argv: s.args,
          cwd: options.cwd || process.cwd(),
          env: options.inheritEnv === false ? { ...(options.env || {}) } : { ...process.env, ...(options.env || {}) },
          owner: { ...ProcessRuntime.currentOwner(), kind: 'desktop-shell', ...options.owner },
          spawnOptions: {
          windowsHide: true,
          shell: options.shell || false,
          // NE-3:一次性运行不给子进程一根永不关闭的 stdin 管道 —— 读 stdin / 弹提示(Read-Host、pause、input()、git commit 缺 -m)
          // 的程序会一直等到超时。'ignore' 让它们立刻读到 EOF / 得到错误;极少数要喂 stdin 的调用方传 options.stdin==='pipe'。
          stdio: options.stdin === 'pipe' ? 'pipe' : ['ignore', 'pipe', 'pipe'],
          ...s.opts,
          },
        });
      } catch (error) {
        if (!error.capability) throw error;
        resolve({ ok: false, code: -1, error: error.message, errorCode: error.code, capability: error.capability,
          stdout: '', stderr: error.message, timedOut: false, interrupted: false, elapsedMs: Date.now() - start });
        return;
      }
      const child = ProcessRuntime.child(processHandle);
      let killGraceTimer = null;
      let exitTimer = null;
      let exitAt = 0;
      let exitInfo = null;
      let cleanup = null;
      const signal = options.signal;
      let abortHandler = null;
      const isBudgetKill = () => Boolean(signal && signal.reason === 'tool_time_budget');
      const cleanupNote = () => cleanup && cleanup.incomplete ? 'process cleanup incomplete'
        : cleanup && cleanup.scope === 'owned-group-and-observed' ? 'owned process group and observed descendants terminated'
          : cleanup && cleanup.scope === 'observed-tree' ? 'observed descendants terminated' : 'process tree killed';
      const abortSuffix = () => isBudgetKill() ? (cleanup ? '\n[已触发工具时间预算硬上限; ' + cleanupNote() + ']' : '\n[已触发工具时间预算硬上限;进程树已回收]')
        : '\n[interrupted by user steer; ' + cleanupNote() + ']';
      // 可执行文件本身找不到(ENOENT 且工作目录是存在的 —— 目录不存在时 Node 报的也是 ENOENT,那是另一回事):
      // 带上 commandNotFound 标记,让调用方(12 的 powershell 系工具)把裸的「spawn powershell.exe ENOENT」换成人话,
      // 而不是各自去解析 stderr 文案。
      const commandMissing = extra => !!(extra && extra.spawnError && extra.spawnError.code === 'ENOENT' && !(options.cwd && !fs.existsSync(options.cwd)));
      // 收尾载荷。code = 退出码;extra.spawnError / extra.exitNote / extra.forceFail 见各调用点。
      const compose = (code, extra = {}) => {
        if (process.platform === 'darwin') cleanup = ProcessRuntime.result(child) || cleanup;
        const cleanupFailed = cleanup && cleanup.incomplete === true;
        const ok = !extra.forceFail && code === 0 && !timedOut && !interrupted && !cleanupFailed;
        const suffix = extra.errorText ? extra.errorText : interrupted ? abortSuffix() : (timedOut ? '\n[timed out; ' + cleanupNote() + ']' : '');
        const budgetKilled = interrupted && isBudgetKill();
        const cleanupFields = cleanup ? { cleanupScope: cleanup.scope, cleanupIncomplete: cleanup.incomplete === true,
          ...(cleanup.escapeCoverage ? { cleanupEscapeCoverage: cleanup.escapeCoverage } : {}),
          ...(Number.isSafeInteger(cleanup.unconfirmed) ? { cleanupUnconfirmed: cleanup.unconfirmed } : {}) } : {};
        const stoppedText = cleanup ? (cleanup.incomplete ? '子进程清理尚未确认完成' : '已核验的子进程已终止') : '进程树已回收';
        if (!shape) {
          const stdout = decodeBestEffort(Buffer.concat(outS.chunks));
          const stderr = decodeBestEffort(Buffer.concat(errS.chunks)) + suffix;
          return { ok, code, stdout, stderr, elapsedMs: Date.now() - start, timedOut, interrupted, ...cleanupFields, ...(cleanupFailed ? { error: '子进程清理尚未确认完成' } : {}), ...(budgetKilled ? { budgetKilled: true } : {}), ...(extra.exitNote ? { note: extra.exitNote } : {}), ...(commandMissing(extra) ? { commandNotFound: true } : {}) };
        }
        const sh = shapeExecStreams(streamSrc(outS), streamSrc(errS));
        const payload = { ok, code, timedOut, interrupted, ...cleanupFields };
        if (budgetKilled) payload.budgetKilled = true;
        if (!ok) {
          let error; let hint;
          if (extra.spawnError) {
            const cwdMissing = extra.spawnError.code === 'ENOENT' && options.cwd && !fs.existsSync(options.cwd);
            if (cwdMissing) { error = `工作目录不存在: ${options.cwd}`; hint = '确认 cwd 是已存在的目录,或省略 cwd 用线程工作目录'; }
            else {
              error = `无法启动进程 ${command}: ${extra.spawnError.message || extra.spawnError}`;
              if (extra.spawnError.code === 'ENOENT') hint = `找不到可执行文件 ${command};确认已安装并在 PATH 上`;
            }
          } else if (interrupted) {
            error = (budgetKilled ? '已触发工具时间预算硬上限,' : '被用户插话中断,') + stoppedText;
          } else if (timedOut) {
            error = cleanup ? `命令超过 ${timeoutMs}ms 仍未结束,${stoppedText};stdout/stderr 是已产生的部分输出`
              : `命令超过 ${timeoutMs}ms 仍未结束,已终止(进程树已回收);stdout/stderr 是已产生的部分输出`;
            hint = '长任务请用 shell_start({command}) 后台运行并用 shell_poll 取结果;或加大 timeoutMs(上限 1800000)';
          } else if (cleanupFailed) {
            error = '子进程清理尚未确认完成';
          } else {
            error = code == null ? '进程被信号终止' : `进程以退出码 ${code} 结束`;
          }
          payload.error = error;
          if (hint) payload.hint = hint;
        }
        if (sh.stdoutOmitted || sh.stderrOmitted) {
          const h = '输出过长,只保留开头和结尾(中间已省略);要看完整内容请把命令输出重定向到文件后用 file_read 分段读,或先过滤(Select-String / Select-Object -Last N)';
          payload.hint = payload.hint ? payload.hint + ';' + h : h;
        }
        if (extra.exitNote) payload.note = extra.exitNote;
        if (commandMissing(extra)) payload.commandNotFound = true;
        payload.stderr = sh.stderr + suffix;
        if (sh.stderrOmitted) payload.stderrOmitted = sh.stderrOmitted;
        payload.stdout = sh.stdout;
        if (sh.stdoutOmitted) payload.stdoutOmitted = sh.stdoutOmitted;
        payload.elapsedMs = Date.now() - start;
        return payload;
      };
      // 审计 P2: 单次结算门 —— close/error/exit 宽限/超时兜底四条路径共用,防重复 resolve。
      let settled = false;
      const finish = payload => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killGraceTimer) clearTimeout(killGraceTimer);
        if (exitTimer) clearTimeout(exitTimer);
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        if (outS.truncated) payload.stdoutTruncated = true;
        if (errS.truncated) payload.stderrTruncated = true;
        resolve(payload);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        // 审计 P2: 超时用 killChildTree 整树杀(128i 起按创建时间认子孙,不再 taskkill /T) —— child.kill('SIGTERM') 在 Windows 上只杀直接子
        // 进程,claude.cmd→node、shell→子命令等孙进程会遗孤泄漏,且其继承的 stdio 句柄不关 → 'close' 迟迟不触发,
        // promise 悬挂到远超 timeoutMs。killChildTree 内含 SIGKILL 兜底。
        cleanup = killChildTree(child);
        // 二次兜底:即便整树已杀,若仍有句柄让 'close' 不触发,3s 后硬 resolve,绝不让工具调用无限悬挂。
        killGraceTimer = setTimeout(() => finish(compose(-1, { forceFail: true })), 3000);
        if (killGraceTimer.unref) killGraceTimer.unref();
      }, timeoutMs);
      // 106 #13a-t: 中断原因感知 —— 仅新原因 'tool_time_budget' 走专用文案与 budgetKilled 标记;
      // 既有 'user_steer' / 'turn_stopped' 等一切旧原因文案逐字节不变。
      abortHandler = () => {
        if (settled) return;
        interrupted = true;
        cleanup = killChildTree(child);
        // Keep the normal close event as the primary settlement path, but never make steering wait on a
        // descendant that retained stdio handles after the tree kill.
        killGraceTimer = setTimeout(() => finish(compose(-1, { forceFail: true })), 1000);
        if (killGraceTimer.unref) killGraceTimer.unref();
      };
      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
        if (signal.aborted) abortHandler();
      }
      // NE-4:主进程 exit 后管道被一个脱离的孙进程(gradle/adb/docker daemon、Start-Process)继续占着 → 'close' 迟迟不来,
      // 工具调用被拖到孙进程退出(实测 8s+,甚至撞 timeoutMs 被判超时并杀树)。exit 后给一小段静默宽限排空管道(期间仍有数据就顺延,
      // 总共不超过 EXEC_EXIT_GRACE_MAX_MS),之后销毁我们这一侧的流并按已捕获的输出结算,note 如实说明。
      const settleAfterExit = () => {
        if (settled) return;
        try { if (child.stdout) child.stdout.destroy(); if (child.stderr) child.stderr.destroy(); } catch { /* already closed */ }
        finish(compose(exitInfo ? exitInfo.code : null, { exitNote: '进程已退出,但有后台子进程仍占着输出管道;已按退出时已收到的输出返回(之后写入的输出不含在内)' }));
      };
      const armExitTimer = () => {
        if (exitTimer) clearTimeout(exitTimer);
        exitTimer = setTimeout(settleAfterExit, EXEC_EXIT_GRACE_MS);
      };
      const onData = st => d => {
        collect(st, d);
        if (exitAt && !settled && Date.now() - exitAt < EXEC_EXIT_GRACE_MAX_MS) armExitTimer();
      };
      child.stdout?.on('data', onData(outS));
      child.stderr?.on('data', onData(errS));
      child.on('error', error => finish(compose(-1, { forceFail: true, spawnError: error, errorText: error.message })));
      child.on('exit', code => {
        exitInfo = { code: code === undefined ? null : code };
        exitAt = Date.now();
        armExitTimer();
      });
      child.on('close', code => finish(compose(code)));
    });
  }

  async function runBash(command, cwd, timeoutMs, signal, opts = {}) {
    if (process.platform !== 'darwin') return { ok: false, code: 'bash_unavailable', error: '本机尚未启用受管 bash 执行' };
    const capability = ProcessRuntime.helperCapability();
    if (!capability.ready) return { ok: false, code: capability.code, error: 'Mac bash 的原生进程监督器尚未就绪', capability };
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-bash-'));
    const script = path.join(directory, 'command.sh');
    try {
      await fsp.writeFile(script, String(command), { encoding: 'utf8', mode: 0o600 });
      return await runProcess('/bin/bash', ['--noprofile', '--norc', '--', script], {
        cwd: cwd || os.homedir(), timeoutMs, signal, shape: opts.shape === true,
        inheritEnv: false, env: platformShellEnvironment(process.env),
      });
    } finally { await fsp.rm(directory, { recursive: true, force: true }).catch(() => {}); }
  }

  function revealInFinder(absPath, mode) {
    return fsp.realpath(absPath).then(realPath => {
      const spec = platformOpenSpawn(realPath, mode);
      return spawnDetachedChecked(spec.command, spec.args, { detached: true, stdio: 'ignore' }).then(result => result.ok);
    }).catch(() => false);
  }
  async function pickFolder() {
    return { ok: false, code: 'host_required', error: '请在 Mac 应用中选择文件夹，或粘贴完整路径' };
  }
  async function pickFile() {
    return { ok: false, code: 'host_required', error: '请在 Mac 应用中选择文件，或粘贴完整路径' };
  }
  return Object.freeze({ decodeBestEffort, runProcess, runBash, revealInFinder, pickFolder, pickFile });
})(fs, fsp, path, os, cp, killChildTree, spawnDetachedChecked, decodeConsoleText);
