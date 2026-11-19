require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离，防 fake-mcp 夹具经 claude mcp add-json／Kimi 同步漏进真机 ~/.claude.json 与 ~/.kimi-code/mcp.json（见 lib 头注）
// v0.7d self-tests #5 (real desktop MCP smoke, best-effort) + #6 (detectDesktopMcp unit).
// Requires server.js as a module (no server spawned) and drives McpStdioClient directly against the
// REAL ai-computer-control python MCP. If python/deps are missing, #5 is reported as SKIP (not a fail).
const path = require('path');
const fs = require('fs');
const SERVER = require('path').resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js');
const REPO = [path.resolve(__dirname, '..', 'ai-computer-control'), path.resolve(__dirname, '..', 'mcp', 'ai-computer-control')]
  .find(p => fs.existsSync(p)) || path.resolve(__dirname, '..', 'mcp', 'ai-computer-control');
const { McpStdioClient, detectDesktopMcp, desktopMcpFromInstalledRoot, desktopPythonCandidates, pickPython, resolveExternalMcpServers } = require(SERVER);

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  // A present bundled Python is not necessarily usable (a partial installation can omit mcp). The
  // deterministic probe seam proves we skip it and retain the working fallback + launcher arguments.
  const selected = pickPython(REPO, { PYTHONPATH: path.join(REPO, 'src'), PYTHONUTF8: '1' }, {
    noCache: true,
    candidates: [
      { command: 'broken-embedded-python', args: [], source: 'bundled-runtime', requireExisting: false },
      { command: 'usable-system-python', args: ['-u'], source: 'system-path', requireExisting: false },
    ],
    probe: candidate => candidate.command === 'usable-system-python',
  });
  ok(selected && selected.command === 'usable-system-python' && selected.args[0] === '-u', 'pickPython skips a broken embedded runtime and keeps the usable fallback launcher');
  const none = pickPython(REPO, { PYTHONPATH: path.join(REPO, 'src'), PYTHONUTF8: '1' }, {
    noCache: true,
    candidates: [{ command: 'no-python', args: [], source: 'none', requireExisting: false }],
    probe: () => false,
  });
  ok(none === null, 'pickPython reports no candidate when every runtime fails the ACC import probe');
  const fullPreferred = pickPython(REPO, { PYTHONPATH: path.join(REPO, 'src'), PYTHONUTF8: '1' }, {
    noCache: true,
    candidates: [
      { command: 'core-only-python', args: [], source: 'repo-venv', requireExisting: false },
      { command: 'optional-deps-python', args: [], source: 'installed-full-runtime', requireExisting: false },
    ],
    probe: candidate => candidate.command === 'core-only-python' ? 'core' : 'full',
  });
  ok(fullPreferred && fullPreferred.command === 'optional-deps-python' && fullPreferred.capability === 'full',
    'pickPython prefers a later Mac Python with the Full optional dependencies over an earlier core-only Python');
  const distributionRoot = path.join(REPO, 'fake bundled ACC');
  const distributionCandidates = desktopPythonCandidates(distributionRoot);
  const offlineCandidate = distributionCandidates[0];
  ok(offlineCandidate && offlineCandidate.source === 'bundled-runtime'
    && offlineCandidate.command === path.join(distributionRoot, 'runtime', 'python', 'bin', 'python3'),
  'repo detection prioritizes the portable Mac Python runtime');
  const bundledPreferred = pickPython(distributionRoot, { PYTHONUTF8: '1' }, {
    candidates: distributionCandidates.map(candidate => ({ ...candidate, requireExisting: false })),
    probe: () => 'full',
  });
  ok(bundledPreferred && bundledPreferred.command === offlineCandidate.command,
    'portable Full package Python wins when bundled and system runtimes are both usable');

  const installedRuntime = desktopMcpFromInstalledRoot(path.join(REPO, 'fake installed ACC'), {
    noCache: true,
    candidates: [
      { command: 'installed-runtime-python', args: [], source: 'installed-runtime', requireExisting: false },
      { command: 'legacy-venv-python', args: [], source: 'installed-venv', requireExisting: false },
    ],
    probe: candidate => candidate.command === 'installed-runtime-python',
  });
  ok(installedRuntime && installedRuntime.command === 'installed-runtime-python' && installedRuntime.pythonSource === 'installed-runtime' && installedRuntime.pythonCapability === 'full', 'installed ACC detection prefers the new Full runtime/python layout');

  // ---- #6: detectDesktopMcp() ----
  const det = detectDesktopMcp();
  if (det) ok(true, 'detectDesktopMcp() returns a verified usable runtime');
  else console.log('SKIP detectDesktopMcp runtime probe — checkout has no usable ACC Python dependencies');
  if (det) {
    console.log('  detected: ' + JSON.stringify({ command: det.command, args: det.args, via: det.via, cwd: det.cwd }));
    ok(typeof det.command === 'string' && det.command.length > 0, 'detected.command is a non-empty string');
    ok(Array.isArray(det.args), 'detected.args is an array');
    ok(det.via === 'python-module' || det.via === 'console-script', 'detected.via is a known strategy (' + det.via + ')');
    ok(typeof det.pythonSource === 'string' && det.pythonSource.length > 0, 'detected python source is surfaced for diagnosis (' + det.pythonSource + ')');
    ok(det.pythonCapability === 'full' || det.pythonCapability === 'core', 'detected Python capability is surfaced (' + det.pythonCapability + ')');
  }
  // resolveExternalMcpServers with an autodetect desktopMcp should surface id ai-computer-control.
  const resolved = resolveExternalMcpServers({ desktopMcp: { enabled: true, command: '', args: [], cwd: '', autodetect: true }, externalMcpServers: [] });
  if (det) ok(resolved.some(s => s.id === 'ai-computer-control'), 'resolveExternalMcpServers surfaces ai-computer-control when autodetected');
  else ok(!resolved.some(s => s.id === 'ai-computer-control'), 'resolveExternalMcpServers does not surface an unusable ACC runtime');

  // ---- #5: real desktop MCP smoke (best-effort) ----
  // Prefer the detected launch; fall back to an explicit python -X utf8 -m against the known repo.
  const launch = det && det.via === 'python-module'
    ? { id: 'ai-computer-control', command: det.command, args: det.args, cwd: det.cwd, env: det.env }
    : { id: 'ai-computer-control', command: 'python3', args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: REPO, env: { PYTHONPATH: path.join(REPO, 'src'), PYTHONUTF8: '1' } };
  const client = new McpStdioClient(launch);
  let started = false, toolCount = -1;
  try { await client.start(); started = true; toolCount = client.listTools().length; }
  catch (e) { console.log('SKIP real desktop MCP smoke — could not start (needs target machine / python deps): ' + (e && e.message || e)); }
  if (started) {
    const names = new Set(client.listTools().map(tool => tool.name));
    const diagnostics = await client.callTool('diagnostics', {});
    const capture = diagnostics.capabilities?.['desktop.capture'];
    const ocr = diagnostics.capabilities?.['desktop.ocr'];
    ok(diagnostics.ok && diagnostics.tool_count >= 80 && toolCount >= 50 && toolCount <= diagnostics.tool_count,
      `real MCP exposes the shared catalog and eligible Mac tools (${toolCount} listed / ${diagnostics.tool_count} registered)`);
    ok(names.has('diagnostics') && names.has('run_command'), 'real desktop MCP exposes the shared diagnostics and shell tools');
    ok(typeof capture?.inputReady === 'boolean' && names.has('hotkey') === capture.inputReady,
      'hotkey discovery matches current native input readiness');
    ok(typeof ocr?.screenReady === 'boolean' && names.has('ocr_find_text') === ocr.screenReady,
      'screen OCR discovery matches current native OCR readiness');
    if (names.has('run_command')) {
      const commandProbe = await client.callTool('run_command', { command: 'echo ACC_RUN_COMMAND_OK', timeout: 10 });
      ok(/ACC_RUN_COMMAND_OK/.test(JSON.stringify(commandProbe)) && !/timed out|timeout/i.test(String(commandProbe.error || '')),
        'ACC run_command executes a safe shell command through the real MCP transport');
    }
    if (names.has('hotkey')) {
      const badHotkey = await client.callTool('hotkey', { keys: [], target: {} });
      ok(badHotkey.ok === false && badHotkey.code === 'invalid_args' && /key list/i.test(String(badHotkey.error || '')),
        'Mac hotkey rejects an empty key list before posting events');
    }
    if (names.has('ocr_find_text')) {
      const badOcr = await client.callTool('ocr_find_text', { text: '', click: false });
      ok(badOcr.ok === false && badOcr.code === 'invalid_args' && /search text/i.test(String(badOcr.error || '')),
        'Mac OCR validates its arguments through the real async MCP transport before accessing the screen');
    }
    client.kill();
  }

  console.log('\nDESKTOP-MCP-SMOKE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS') + (started ? '' : ' [real runtime SKIP]'));
  // Give the killed child a moment, then exit.
  setTimeout(() => process.exit(fail ? 1 : 0), 400);
})();
