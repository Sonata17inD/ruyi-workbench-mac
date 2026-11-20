require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
// E2E (v1.4.6-S2 + S3): shell-free open-spawn + native file-tool workspace boundary.
// PART A — pure units (require the module; no server):
//   S2  Mac LaunchServices receives the URL as a single verbatim argument.
//   S3  providerIsLocal() classifies loopback/private hosts as local, public hosts as remote.
//   S3  guardFileToolPath() policy matrix: in-bounds allow; out-of-bounds write DENY always; out-of-bounds
//       read allow only for a LOCAL provider; allowOutsideWorkspace bypasses both.
// PART B — integration (real workbench on an ephemeral port) proving the guard is wired into the live /api/tools/ path:
//   No-provider config denies reads outside the workspace. Bypass permits writes except protected paths.
//   flip config to a LOCAL provider → out-of-bounds read now ALLOWED (provider-sensitive, live).
const { killOwnTree } = require('./lib/kill-own-tree');
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const WB_PORT = await getFreePort();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-file-guard-'));
process.once('exit', () => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
const SERVICE_DATA = path.join(fixtureRoot, 'service-data');
const UNIT_DATA = path.join(fixtureRoot, 'unit-data');
const OUTSIDE = path.join(fixtureRoot, 'outside.txt');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); } // 117q-§8.14:抓 token 这一次原给 1500,重载下 GET / p90=2083ms 被击穿(不是竞态,见 30 号文 §8.14)
function post(port, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 6000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j }); }); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  // ── PART A: pure units ────────────────────────────────────────────────────────────────────────────────
  fs.mkdirSync(UNIT_DATA);
  process.env.RUYI_HOME = UNIT_DATA; // isolate the required module's dataRoot from the spawned WB
  const S = require(SERVER);

  // S2: shell-free open spawn.
  const target = 'http://x&calc';
  const launch = S.buildOpenSpawn(target, 'darwin');
  ok(launch.command === '/usr/bin/open', 'S2 buildOpenSpawn uses Mac LaunchServices');
  ok(launch.args.length === 2 && launch.args[0] === '--' && launch.args[1] === target,
    'S2 passes one verbatim target after the option terminator');

  // S3: local vs remote provider classification.
  const P = (base) => ({ providers: [{ id: 'p', type: 'openai-compat', baseUrl: base, apiKey: 'k', model: 'm' }], activeProvider: 'p' });
  ok(S.providerIsLocal(P('http://127.0.0.1:11434')) === true, 'S3 providerIsLocal: 127.0.0.1 → local');
  ok(S.providerIsLocal(P('http://localhost:1234/v1')) === true, 'S3 providerIsLocal: localhost → local');
  ok(S.providerIsLocal(P('http://192.168.1.9:1234')) === true, 'S3 providerIsLocal: 192.168.x → local');
  ok(S.providerIsLocal(P('https://api.deepseek.com')) === false, 'S3 providerIsLocal: public host → remote');
  ok(S.providerIsLocal({}) === false, 'S3 providerIsLocal: no provider → remote');

  // S3: guardFileToolPath matrix.
  const WS = path.join(UNIT_DATA, 'ws'); fs.mkdirSync(WS, { recursive: true });
  const inside = path.join(WS, 'in.txt'); fs.writeFileSync(inside, 'hi');
  fs.writeFileSync(OUTSIDE, 'secret');
  const ctx = (base, extra) => ({ config: { ...P(base), permissionMode: 'default', defaultWorkspace: WS, ...(extra || {}) }, session: { cwd: WS } });
  const g = async (p, c, write) => (await S.guardFileToolPath(p, c, { write })).ok;
  ok(await g(inside, ctx('https://api.deepseek.com'), false) === true, 'S3 in-bounds read → allow');
  ok(await g(inside, ctx('https://api.deepseek.com'), true) === true, 'S3 in-bounds write → allow');
  ok(await g(OUTSIDE, ctx('https://api.deepseek.com'), true) === false, 'S3 out-of-bounds write (remote) → DENY');
  ok(await g(OUTSIDE, ctx('http://127.0.0.1:11434'), true) === false, 'S3 out-of-bounds write (local) → DENY (write always denied)');
  ok(await g(OUTSIDE, ctx('https://api.deepseek.com'), false) === false, 'S3 out-of-bounds read (remote) → DENY');
  ok(await g(OUTSIDE, ctx('http://127.0.0.1:11434'), false) === true, 'S3 out-of-bounds read (local) → allow');
  ok(await g(OUTSIDE, ctx('https://api.deepseek.com', { allowOutsideWorkspace: true }), false) === true, 'S3 allowOutsideWorkspace → out-of-bounds read allowed');
  ok(await g(OUTSIDE, ctx('https://api.deepseek.com', { allowOutsideWorkspace: true }), true) === true, 'S3 allowOutsideWorkspace → out-of-bounds write allowed');
  const gv = await S.guardFileToolPath(OUTSIDE, ctx('https://api.deepseek.com'), { write: true });
  ok(gv.ok === false && gv.code === 'not-allowed' && typeof gv.error === 'string', 'S3 denial carries {ok:false, code:not-allowed, error}');

  // v2.7.1 (opt#1): bypass/auto = 宽【写】-- 越界写放行(等同 allowOutsideWorkspace=on,不改配置);读不受影响,
  // 仍维持原 exfil 防护(远端 provider 越界读拒、本地放行)。三层硬地板(应用数据/autoexec/OS 关键目录)始终拦截。
  const wide = extra => ctx('https://api.deepseek.com', { permissionMode: 'bypass', ...(extra || {}) });
  ok(await g(OUTSIDE, wide(), true) === true, 'S3 v2.7.1 bypass -> out-of-bounds write ALLOWED (wide write)');
  ok(await g(OUTSIDE, ctx('http://127.0.0.1:11434', { permissionMode: 'auto' }), true) === true, 'S3 v2.7.1 auto -> out-of-bounds write ALLOWED (wide write)');
  ok(await g(OUTSIDE, wide(), false) === false, 'S3 v2.7.1 wide write does NOT open read (remote out-of-bounds read still DENY)');
  ok(await g(OUTSIDE, ctx('http://127.0.0.1:11434', { permissionMode: 'auto' }), false) === true, 'S3 v2.7.1 auto + local provider -> out-of-bounds read still allow (unchanged)');
  const osP = '/System/ruyi-guard-no-write.txt';
  const go = await S.guardFileToolPath(osP, wide(), { write: true });
  ok(go.ok === false && go.code === 'os-critical-denied', 'S3 v2.7.1 bypass wide write still DENIES OS-critical path (3rd floor)');
  const gs = await S.guardFileToolPath(path.join(UNIT_DATA, 'sessions', 'x.json'), wide(), { write: true });
  ok(gs.ok === false && gs.code === 'not-allowed', 'S3 v2.7.1 bypass wide write still DENIES app-data path (1st floor)');
  for (const target of ['/private/etc/ruyi-no-write.txt', '/System/Volumes/Data/private/etc/ruyi-no-write.txt']) {
    const result = await S.guardFileToolPath(target, wide(), { write: true });
    ok(!result.ok && result.code === 'os-critical-denied', 'S3 Mac physical system alias denied: ' + target);
  }
  // 远程 UNC 非回环主机:修前「不在盘符地板 -> 宽写放行属设计意图」。3.0 收口安全走查 W1 起改为在任何 I/O 之前就拒(宽写档也拒,
  // 除非落在用户登记的 UNC 工作区里)—— realpath / 读写一碰就去连对方 SMB,是无提示外传通道并泄露本机 NTLM 凭据。
  const gr = await S.guardFileToolPath('\\\\?\\UNC\\remote-host\\C$\\x\\y.txt', wide(), { write: true });
  ok(gr.ok === false && gr.code === 'not-allowed' && /网络共享/.test(gr.error || ''), 'S3 [unc-remote] wide-write denied before any I/O (W1: a remote share is an exfiltration / NTLM channel)');
  // v2.7.1 对抗轮 G-02: 无 permissionMode 的 ctx 缺省回落 default(fail-closed)——越界写必须拒绝。
  const gNm = await S.guardFileToolPath(OUTSIDE, ctx('https://api.deepseek.com', { permissionMode: undefined }), { write: true });
  ok(gNm.ok === false && gNm.code === 'not-allowed', 'S3 v2.7.1 G-02 no-mode fallback -> out-of-bounds write DENY (fail-closed)');

  // Compare the canonical existing prefix when the workspace or destination does not yet exist.
  const REAL_WS = path.join(UNIT_DATA, 'real-ws');
  const ALIAS_WS = path.join(UNIT_DATA, 'alias-ws');
  fs.mkdirSync(REAL_WS, { recursive: true });
  try {
    fs.symlinkSync(REAL_WS, ALIAS_WS);
    const missingViaAlias = path.join(ALIAS_WS, 'new-dir', 'new-file.txt');
    const aliasCtx = { config: { ...P('https://api.deepseek.com'), permissionMode: 'default', defaultWorkspace: ALIAS_WS }, session: { cwd: ALIAS_WS } };
    const ga = await S.guardFileToolPath(missingViaAlias, aliasCtx, { write: true });
    ok(ga.ok === true, 'S3 missing write target through workspace symlink remains in-bounds');
    const missingRootViaAlias = path.join(ALIAS_WS, 'not-created-workspace');
    const missingRootCtx = { config: { ...P('https://api.deepseek.com'), permissionMode: 'default', defaultWorkspace: missingRootViaAlias }, session: { cwd: missingRootViaAlias } };
    const gm = await S.guardFileToolPath(path.join(missingRootViaAlias, 'new-file.txt'), missingRootCtx, { write: true });
    ok(gm.ok === true, 'S3 missing workspace root and target share the same canonical existing parent');

    const ESCAPE_WS = path.join(fixtureRoot, 'escape-target');
    const ESCAPE_LINK = path.join(REAL_WS, 'escape-link');
    fs.rmSync(ESCAPE_WS, { recursive: true, force: true });
    fs.mkdirSync(ESCAPE_WS, { recursive: true });
    fs.symlinkSync(ESCAPE_WS, ESCAPE_LINK);
    const escapeCtx = { config: { ...P('https://api.deepseek.com'), permissionMode: 'default', defaultWorkspace: REAL_WS }, session: { cwd: REAL_WS } };
    const ge = await S.guardFileToolPath(path.join(ESCAPE_LINK, 'missing.txt'), escapeCtx, { write: true });
    ok(ge.ok === false && ge.code === 'not-allowed', 'S3 missing write target through escaping symlink remains denied');
    fs.unlinkSync(ESCAPE_LINK);
    fs.rmSync(ESCAPE_WS, { recursive: true, force: true });
  } catch (e) {
    ok(false, 'S3 workspace symlink regression setup (' + (e && e.message || e) + ')');
  }

  // 安全审计 2026-09(#1/#7,全量用例见 unit/write-guard-autoload.test.js):
  //   #7 悬空符号链接指向工作区外(目标尚不存在)不再被当成「还不存在的工作区文件」放行;
  //   #1 数据根里会被自动加载/执行的状态(mcp drop-in、检查点、工作流模板)写拒、读照旧;agent CLI 启动配置写拒。
  {
    const DANGLE_OUT = path.join(fixtureRoot, 'missing-target');
    fs.rmSync(DANGLE_OUT, { recursive: true, force: true });
    const DANGLE_LINK = path.join(WS, 'dangle-dir');
    try { fs.rmSync(DANGLE_LINK, { force: true, recursive: true }); } catch { /* none */ }
    let linked = false;
    try { fs.symlinkSync(path.join(DANGLE_OUT, 'not-created'), DANGLE_LINK); linked = true; } catch (e) { console.log('SKIP #7 dangling link setup: ' + (e && e.code || e)); }
    if (linked) {
      const gd = await S.guardFileToolPath(path.join(DANGLE_LINK, 'new.txt'), ctx('https://api.deepseek.com'), { write: true });
      ok(gd.ok === false && gd.code === 'not-allowed', 'S3 安全审计#7 write through a dangling symlink to outside → DENY (' + gd.code + ')');
      try { fs.unlinkSync(DANGLE_LINK); } catch { try { fs.rmdirSync(DANGLE_LINK); } catch { /* best-effort */ } }
    }
    const dataCtx = { config: { ...P('https://api.deepseek.com'), permissionMode: 'default', defaultWorkspace: UNIT_DATA }, session: { cwd: UNIT_DATA } };
    const gMcp = await S.guardFileToolPath(path.join(UNIT_DATA, 'mcp', 'evil', 'ruyi-mcp.json'), dataCtx, { write: true });
    ok(gMcp.ok === false, 'S3 安全审计#1 dataRoot/mcp drop-in manifest write → DENY');
    const gCk = await S.guardFileToolPath(path.join(UNIT_DATA, 'checkpoints', 's', 'index.json'), wide(), { write: true });
    ok(gCk.ok === false, 'S3 安全审计#1 dataRoot/checkpoints write → DENY even in bypass wide write');
    const gCkR = await S.guardFileToolPath(path.join(UNIT_DATA, 'checkpoints', 's', '1-1.gz'), dataCtx, { write: false });
    ok(gCkR.ok === true, 'S3 安全审计#1 dataRoot/checkpoints READ stays allowed');
    for (const rel of ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.claude.json', '.kimi/mcp.json', '.ruyi-toolbox/components/x.json']) {
      const ga = await S.guardFileToolPath(path.join(WS, rel), ctx('https://api.deepseek.com'), { write: true });
      ok(ga.ok === false && ga.code === 'autoexec-denied', 'S3 安全审计#1 agent-CLI launch config ' + rel + ' write → autoexec-denied');
    }
    const gPkg = await S.guardFileToolPath(path.join(WS, 'package.json'), ctx('https://api.deepseek.com'), { write: true });
    ok(gPkg.ok === true, 'S3 安全审计#1 ordinary workspace file (package.json) write still allowed');
  }

  // ── PART B: integration on a live workbench ───────────────────────────────────────────────────────────
  fs.mkdirSync(SERVICE_DATA);
  const WS2 = path.join(SERVICE_DATA, 'ws'); fs.mkdirSync(WS2, { recursive: true });
  const inside2 = path.join(WS2, 'inside.txt'); fs.writeFileSync(inside2, 'INSIDE-CONTENT');
  fs.writeFileSync(OUTSIDE, 'OUTSIDE-SECRET'); // recreate (unit part may share path)
  // Start with NO provider → guard treats reads as "remote" (deny out of bounds). defaultWorkspace is pinned
  // to WS2 (NOT the real user home, which normalizeConfig would otherwise default it to) so that OUTSIDE —
  // a sibling of SERVICE_DATA under the fixture root — is genuinely outside every allowed root.
  fs.writeFileSync(path.join(SERVICE_DATA, 'config.json'), JSON.stringify({ configSchema: 7, version: '1.0.0', permissionMode: 'bypass', defaultWorkspace: WS2 }, null, 2));
  const wb = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, RUYI_HOME: SERVICE_DATA } });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'B: workbench up on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'B: UI token scraped');
    const created = await post(WB_PORT, '/api/sessions', { title: 'file-guard', cwd: WS2 }, { 'x-wcw-token': token });
    const sid = created.json && created.json.session && created.json.session.id;
    ok(!!sid, 'B: session created (cwd=WS)');
    const tool = (name, body) => post(WB_PORT, '/api/tools/' + name, { ...body, sessionId: sid }, { 'x-wcw-token': token });

    const rin = await tool('file_read', { path: inside2 });
    ok(rin.json && rin.json.result && rin.json.result.ok === true && /INSIDE-CONTENT/.test(rin.json.result.content || ''), 'B: in-bounds file_read allowed + content returned');
    const rout = await tool('file_read', { path: OUTSIDE });
    ok(rout.json && rout.json.result && rout.json.result.ok === false && rout.json.result.code === 'not-allowed', 'B: out-of-bounds file_read DENIED (remote)');
    ok(!(rout.json && rout.json.result && /OUTSIDE-SECRET/.test(rout.json.result.content || '')), 'B: denied read leaks NO content');

    // v2.7.1 (opt#1): config 为 bypass(工作台默认) -> 宽写:越界 file_write 放行;但 OS 关键目录与应用数据地板仍拒。
    const woutPath = path.join(fixtureRoot, 'wide-write.txt');
    fs.rmSync(woutPath, { force: true });
    const wout = await tool('file_write', { path: woutPath, content: 'should-write-wide' });
    ok(wout.json && wout.json.result && wout.json.result.ok === true, 'B: out-of-bounds file_write ALLOWED under bypass (wide write)');
    ok(fs.existsSync(woutPath), 'B: out-of-bounds file_write created the file (wide write)');
    fs.rmSync(woutPath, { force: true }); // wide write cleanup
    const osP = '/System/ruyi-guard-' + Date.now() + '.tmp';
    const wos = await tool('file_write', { path: osP, content: 'nope' });
    ok(wos.json && wos.json.result && wos.json.result.ok === false && wos.json.result.code === 'os-critical-denied', 'B: OS-critical path write DENIED even under bypass');
    ok(!fs.existsSync(osP), 'B: OS-critical write left NO file on disk');
    const wsen = await tool('file_write', { path: path.join(SERVICE_DATA, 'config.json'), content: '{}' });
    ok(wsen.json && wsen.json.result && wsen.json.result.ok === false && wsen.json.result.code === 'not-allowed', 'B: app-data path (config.json) write DENIED even under bypass');
    const winPath = path.join(WS2, 'new-inside.txt');
    const win = await tool('file_write', { path: winPath, content: 'ok-inside' });
    ok(win.json && win.json.result && win.json.result.ok === true && fs.existsSync(winPath), 'B: in-bounds file_write allowed + file created');

    // Flip config to a LOCAL provider → out-of-bounds read now allowed (provider-sensitive, live).
    const cfg = await post(WB_PORT, '/api/config', { providers: [{ id: 'local', label: 'Local', type: 'openai-compat', baseUrl: 'http://127.0.0.1:11434', apiKey: 'k', model: 'm' }], activeProvider: 'local' }, { 'x-wcw-token': token });
    ok(cfg.json && cfg.json.ok === true, 'B: config flipped to a LOCAL provider');
    const routLocal = await tool('file_read', { path: OUTSIDE });
    ok(routLocal.json && routLocal.json.result && routLocal.json.result.ok === true && /OUTSIDE-SECRET/.test(routLocal.json.result.content || ''), 'B: out-of-bounds file_read now ALLOWED under a local provider');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    if (wb && wb.pid) { try { killOwnTree(wb); } catch { /* ignore */ } }
    await sleep(300);
    console.log('\nFILE-GUARD E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
