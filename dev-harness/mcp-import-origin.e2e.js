require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
'use strict';
const { killOwnTree } = require('./lib/kill-own-tree');
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mcp-import-origin-'));
const WB_PORT = 8733;                     // 本件固定端口(端口审计:跨文件零撞车)
const LOG = path.join(HOME, 'claude-argv.log');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(c) { if (c && c.pid) { try { killOwnTree(c); } catch { /* already gone */ } } }
function request(method, pathname, body, token) {
  return new Promise(resolve => {
    const raw = body == null ? '' : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: pathname, method, timeout: 20000, headers: {
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(token ? { 'x-wcw-token': token } : {}),
    } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-json */ } resolve({ status: res.statusCode, json: j, text: b }); }); });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
    if (raw) r.write(raw);
    r.end();
  });
}
async function waitHealth() { for (let i = 0; i < 300; i++) { const r = await request('GET', '/health', null, ''); if (r && r.status === 200) return true; await sleep(100); } return false; }
async function waitToken(old) { for (let i = 0; i < 300; i++) { let t = ''; try { t = JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { /* not yet */ } if (t && t !== old) return t; await sleep(100); } return ''; }
function readConfigJson() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); } catch { return null; } }
function findServer(cfg, id) { return ((cfg && cfg.externalMcpServers) || []).find(s => s && s.id === id) || null; }
function logText() { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } }
function addJsonSeen(id) { return new RegExp('mcp\\|add-json\\|' + id + '\\|').test(logText()); }

function spawnWb() {
  return cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME },
  });
}
// 启动一轮:等 /health、等 token 轮换、再多等一会儿让 listen 之后那段启动探针(§2.5 起它排在 listen 后)
// 真的把 syncMcpServersToClaude 跑完 —— 日志判据看的正是它。
async function bootOnce(oldToken) {
  const wb = spawnWb();
  wb.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));
  const up = await waitHealth();
  const token = await waitToken(oldToken);
  for (let i = 0; i < 100 && !/mcp\|add-json/.test(logText()); i++) await sleep(100); // 同步跑起来就停等
  await sleep(1500);   // 再给串行的几发 add-json 一点时间
  return { wb, up, token };
}

(async () => {
  const fakeClaude = path.join(HOME, 'claude');
  fs.writeFileSync(fakeClaude, '#!' + process.execPath + '\n'
    + 'require("fs").appendFileSync(' + JSON.stringify(LOG) + ', process.argv.slice(2, 5).join("|") + "|\\n");\n', { mode: 0o755 });
  // 夹具家的 .claude.json:X 是「Claude Code 那边注册的」,启动时会被 autoImportClaudeCodeMcp 拉进来。
  fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({
    mcpServers: { 'origin-x': { command: 'node', args: ['-e', 'process.exit(0)'], env: {} } },
  }), 'utf8');
  // Y 直接写在 Ruyi 自己的 config 里(没有 origin)—— 它必须照常同步过去,做「跳过不是把同步弄坏」的对照。
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, permissionMode: 'bypass', includeWorkbenchMcp: false, claudePath: fakeClaude,
    desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },  // 关桌面探测:本件只看同步方向
    externalMcpServers: [{ id: 'origin-y', label: 'Y', command: 'node', args: ['-e', 'process.exit(0)'], env: {}, enabled: true }],
  }), 'utf8');

  let wb = null;
  try {
    // ── 第一次启动:导入 X,并打上来源标记 ──
    let r = await bootOnce(''); wb = r.wb;
    ok(r.up, '第一次启动:workbench up');
    const cfg1 = readConfigJson();
    const x1 = findServer(cfg1, 'origin-x');
    ok(!!x1, '第一次启动:X 被 autoImportClaudeCodeMcp 拉进 config');
    ok(x1 && x1.origin === 'claude-code', `第一次启动:X.origin === 'claude-code'（实得 ${x1 ? JSON.stringify(x1.origin) : 'n/a'}）`);
    const y1 = findServer(cfg1, 'origin-y');
    ok(y1 && y1.origin === undefined, 'Y（用户自己写在 config 里的）不带 origin —— 缺省即 Ruyi 所有');
    kill(wb); wb = null; await sleep(400);

    // ── 第二次启动:X 不再被同步回 Claude Code;Y 照常同步 ──
    fs.rmSync(LOG, { force: true });
    r = await bootOnce(r.token); wb = r.wb;
    ok(r.up, '第二次启动:workbench up');
    ok(!addJsonSeen('origin-x'), `第二次启动:日志里【没有】mcp add-json origin-x（日志：${JSON.stringify(logText().trim().slice(0, 300))}）`);
    ok(addJsonSeen('origin-y'), '第二次启动:Y 照常 mcp add-json（跳过是按来源跳，不是把整条同步弄坏）');
    kill(wb); wb = null; await sleep(400);

    // ── 第三次启动:用户在 Ruyi 里显式(再)导入 X → 接管 → 恢复同步 ──
    // 号文写的是「/api/mcp upsert」。HTTP 面【没有】upsert 路由(upsert 只在工具面 mcp_configure →
    // mutateMcpConnector),用户可达的「显式接管」是 /api/mcp/import-config/apply:它按 id 整条替换,
    // 且 import 路径按号文不打标 —— 落盘后这条就没有 origin 了。工具面那条 `delete clean.origin`
    // 由下面的形状锁钉住。
    fs.rmSync(LOG, { force: true });
    r = await bootOnce(r.token); wb = r.wb;
    ok(r.up, '第三次启动（显式再导入前）:workbench up');
    const up = await request('POST', '/api/mcp/import-config/apply', {
      servers: [{ id: 'origin-x', label: 'X', command: 'node', args: ['-e', 'process.exit(0)'], env: {}, cwd: '' }],
    }, r.token);
    ok(up && up.status === 200 && up.json && up.json.ok === true, `显式再导入 origin-x 成功（${up ? up.status : 'no-response'}${up && up.text ? ' ' + up.text.slice(0, 160) : ''}）`);
    const cfg3 = readConfigJson();
    const x3 = findServer(cfg3, 'origin-x');
    ok(x3 && x3.origin === undefined, `显式再导入之后 X 的 origin 被清掉（实得 ${x3 ? JSON.stringify(x3.origin) : 'n/a'}）`);
    kill(wb); wb = null; await sleep(400);

    fs.rmSync(LOG, { force: true });
    r = await bootOnce(r.token); wb = r.wb;
    ok(r.up, '第四次启动（显式再导入后）:workbench up');
    ok(addJsonSeen('origin-x'), `第四次启动:X 恢复同步，日志里有 mcp add-json origin-x（日志：${JSON.stringify(logText().trim().slice(0, 300))}）`);

  } finally {
    kill(wb);
    await sleep(300);
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* windows file lock */ }
  }
  console.log('\nMCP IMPORT ORIGIN E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
