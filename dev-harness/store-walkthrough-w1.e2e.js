#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 走查 W1(存储/路由一批)的 HTTP 层回归件。真服务、临时家、全离线。
//   [F] #9  任何响应都带 X-Frame-Options: DENY 与 Content-Security-Policy: frame-ancestors 'none'(防被嵌入);
//   [H] #11 /health 带 app 字段(freeStalePort 的工作台识别口径,见 unit/health-looks-like-workbench);
//   [R] #10 项目级 agent-roles / workflows 的 cwd 不存在或是文件 → 400 人话(不再 500 + ENOTDIR 原文),正常目录照存;
//   [S] #12 会话内容搜索:正文头/尾 1MB 边界上的消息补读成整行(≤2MB 整个读;更大的头尾补行),冷索引并发搜索只建一遍(单飞)。
const { createRunner } = require('./lib/harness');
const { killOwnTree } = require('./lib/kill-own-tree');
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getFreePort } = require('./free-port.js');

const t = createRunner('STORE WALKTHROUGH W1');
const { ok } = t;
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-store-w1-'));
const OPEN_LOG = path.join(HOME, 'open-count.log');
const APP_NAME = '如意 Ruyi';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function request(port, method, route, { body, token, headers = {} } = {}) {
  return new Promise(resolve => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method, timeout: 20000,
      headers: { host: `127.0.0.1:${port}`, ...(token ? { 'x-wcw-token': token } : {}), ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...headers } }, res => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', c => { out += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(out); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, headers: res.headers, text: out, json }); });
    });
    req.on('error', e => resolve({ status: 0, headers: {}, text: String(e.message), json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: -1, headers: {}, text: 'timeout', json: null }); });
    if (raw) req.write(raw);
    req.end();
  });
}
async function waitUp(port) { for (let i = 0; i < 300; i++) { const r = await request(port, 'GET', '/health'); if (r.status === 200) return true; await sleep(150); } return false; }
async function tokenOf(port) {
  const r = await request(port, 'GET', '/');
  const m = r.text.match(/name="wcw-token"\s+content="([a-f0-9]+)"/);
  return m ? m[1] : '';
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────────────────────
const TS = '2026-09-01T00:00:00.000Z';
const rowLine = (role, content) => JSON.stringify({ role, content, createdAt: TS, turnSeq: 1 }) + '\n';
const ROW_OVERHEAD = Buffer.byteLength(rowLine('assistant', ''));
// 按「起点字节偏移」摆放特殊行,中间用助手行精确填充(助手行只收开头 240 字,不会挤占检索单元的额度)。
function buildMessages(specials, finalSizeOf) {
  const parts = []; let size = 0;
  const pad = until => {
    let remaining = until - size;
    if (remaining < 0 || (remaining > 0 && remaining < ROW_OVERHEAD + 1)) throw new Error('填充目标不可达:' + remaining);
    while (remaining > 0) {
      const chunk = remaining > 40000 + ROW_OVERHEAD + 1 ? 40000 : remaining;
      parts.push(rowLine('assistant', 'f'.repeat(chunk - ROW_OVERHEAD)));
      size += chunk; remaining -= chunk;
    }
  };
  const spans = {};
  for (const sp of specials) {
    pad(sp.start);
    const line = rowLine('user', sp.marker + ' ' + 'z'.repeat(3000));
    spans[sp.marker] = [size, size + Buffer.byteLength(line)];
    parts.push(line); size += Buffer.byteLength(line);
  }
  pad(finalSizeOf(spans));
  return { text: parts.join(''), spans, size };
}
function writeSession(id, title, text) {
  fs.writeFileSync(path.join(HOME, 'sessions', id + '.json'), JSON.stringify({
    id, storageVersion: 2, title, summary: '', cwd: 'C:/work/' + id, pinned: false, createdAt: TS, updatedAt: TS, turnSeq: 1,
    messageCount: text.split('\n').filter(Boolean).length, providerHistoryCount: 0, messages: [], providerHistory: [],
  }, null, 2));
  fs.writeFileSync(path.join(HOME, 'sessions', id + '.messages.ndjson'), text);
}
const MB = 1024 * 1024;
function seed() {
  fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass', autoImportClaudeCodeMcp: false,
  }, null, 2));
  // ≤ 2MB(1.7MB):特殊行跨在 1MB 接缝上 —— 修前头段尾巴是半行、尾段又无条件丢第一行,这条消息两边都不要。
  const small = buildMessages([{ start: MB - 1500, marker: 'zzseamalpha' }], () => 1700000);
  // > 2MB(3.3MB):头窗口(0..1MB)与尾窗口(size-1MB..size)的边界各压着一条用户消息。
  const big = buildMessages([{ start: MB - 1500, marker: 'zzheadbeta' }, { start: 2400000, marker: 'zztailbeta' }], spans => spans.zztailbeta[0] + 1500 + MB);
  fixture.small = small; fixture.big = big;
  writeSession('sess-seam-small', '无关标题甲', small.text);
  writeSession('sess-seam-big', '无关标题乙', big.text);
  for (let i = 0; i < 8; i++) writeSession('sess-sf-' + i, '无关标题' + i, rowLine('user', '单飞夹具 zzsingleflight' + i) + rowLine('assistant', 'ok'));

}
const fixture = {};

(async () => {
  let server = null;
  try {
    seed();
    const PORT = await getFreePort();
    server = cp.spawn(process.execPath, [path.join(WB, 'app', 'server.js')], {
      env: {
        ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME, PORT: String(PORT), WCW_NO_BROWSER: '1',
        CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
        RUYI_OPEN_LOG: OPEN_LOG, NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, 'lib', 'count-fsp-open-preload.js'))}`,
      },
      cwd: WB, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', () => {}); server.stderr.on('data', () => {});
    ok(await waitUp(PORT), 'P0 服务起来了');
    const token = await tokenOf(PORT);
    ok(Boolean(token), 'P0b 取得 token');

    // ── [F] #9 防嵌入响应头 ──────────────────────────────────────────────────────────────────
    const rootPage = await request(PORT, 'GET', '/');
    const health = await request(PORT, 'GET', '/health');
    const status = await request(PORT, 'GET', '/api/status', { token });
    const asset = await request(PORT, 'GET', '/app.js');
    const notFound = await request(PORT, 'GET', '/definitely-not-here.html');
    for (const [label, r] of [['HTML 页面', rootPage], ['/health', health], ['/api/status', status], ['静态资源', asset], ['404', notFound]]) {
      ok(r.headers['x-frame-options'] === 'DENY', `F1 ${label}带 X-Frame-Options: DENY(实得 ${r.headers['x-frame-options']})`);
      ok(/frame-ancestors 'none'/.test(String(r.headers['content-security-policy'] || '')), `F2 ${label}带 CSP frame-ancestors 'none'`);
    }
    ok(rootPage.status === 200 && /<meta http-equiv="Content-Security-Policy"/.test(rootPage.text), 'F3 页面里原有的 CSP meta 还在(两者叠加,互不替代)');

    // ── [H] #11 /health 带 app ───────────────────────────────────────────────────────────────
    ok(health.json && health.json.app === APP_NAME, `H1 /health 带 app: ${APP_NAME}(实得 ${health.json && health.json.app})`);
    ok(health.json && health.json.ok === true && typeof health.json.overlayId === 'string' && typeof health.json.version === 'string', 'H2 /health 原有字段(ok / version / overlayId)不变');

    // ── [R] #10 项目级 cwd 校验 ──────────────────────────────────────────────────────────────
    const missingDir = path.join(HOME, 'no-such-dir');
    const aFile = path.join(HOME, 'i-am-a-file.txt');
    fs.writeFileSync(aFile, 'x');
    const goodDir = path.join(HOME, 'proj-ok');
    fs.mkdirSync(goodDir, { recursive: true });
    for (const [label, cwd] of [['不存在的目录', missingDir], ['是个文件', aFile]]) {
      const r = await request(PORT, 'POST', '/api/agent-roles', { token, body: { scope: 'project', cwd, roles: [] } });
      ok(r.status === 400, `R1 agent-roles project ${label} → 400(实得 ${r.status})`);
      ok(r.json && r.json.error && r.json.error.code === 'project.cwd_not_directory', `R2 ${label}:稳定错误码 project.cwd_not_directory`);
      ok(!/ENOTDIR|EEXIST|ENOENT|errno/i.test(r.text) && !r.text.includes(path.basename(cwd)), `R3 ${label}:响应里没有 errno 原文与宿主路径`);
      const wf = await request(PORT, 'POST', '/api/agent-workflows', { token, body: { scope: 'project', cwd, workflow: { id: 'w1-probe', title: 'probe', nodes: [] } } });
      ok(wf.status === 400 && wf.json && wf.json.error && wf.json.error.code === 'project.cwd_not_directory', `R4 workflows project 保存 ${label} → 400 同码(实得 ${wf.status})`);
      const del = await request(PORT, 'POST', '/api/agent-workflows/w1-probe', { token, headers: { 'x-http-method': 'DELETE' }, body: { scope: 'project', cwd } });   // 带 scope 的删除走 POST + x-http-method 覆写(见路由)
      ok(del.status === 400 && del.json && del.json.error && del.json.error.code === 'project.cwd_not_directory', `R5 workflows project 删除 ${label} → 400 同码(实得 ${del.status})`);
    }
    const goodRoles = await request(PORT, 'POST', '/api/agent-roles', { token, body: { scope: 'project', cwd: goodDir, roles: [] } });
    ok(goodRoles.status === 200 && goodRoles.json && goodRoles.json.ok === true && fs.existsSync(path.join(goodDir, '.ruyi', 'agents.json')), 'R6 正常目录照存(.ruyi/agents.json 落盘)');
    const globalRoles = await request(PORT, 'POST', '/api/agent-roles', { token, body: { scope: 'global', roles: [] } });
    ok(globalRoles.status === 200, 'R7 全局作用域不受影响');

    // ── [S] #12 会话搜索 ─────────────────────────────────────────────────────────────────────
    ok(fixture.small.size > MB && fixture.small.size <= 2 * MB && fixture.small.spans.zzseamalpha[0] < MB && fixture.small.spans.zzseamalpha[1] > MB, `S0a 夹具:≤2MB 文件的特殊行跨 1MB 接缝(${fixture.small.size} 字节)`);
    const bigSpans = fixture.big.spans;
    ok(fixture.big.size > 2 * MB && bigSpans.zzheadbeta[0] < MB && bigSpans.zzheadbeta[1] > MB
      && bigSpans.zztailbeta[0] < fixture.big.size - MB && bigSpans.zztailbeta[1] > fixture.big.size - MB, `S0b 夹具:>2MB 文件的头/尾窗口边界各压一条消息(${fixture.big.size} 字节)`);
    try { fs.writeFileSync(OPEN_LOG, ''); } catch { /* 日志会被预加载件追加创建 */ }
    // 冷索引 + 4 个并发搜索(边打字边搜的形态):修前每个请求各自重抽全部单元。
    const queries = ['zzseamalpha', 'zzheadbeta', 'zztailbeta', 'zzsingleflight3'];
    const results = await Promise.all(queries.map(q => request(PORT, 'GET', '/api/sessions/search?q=' + q, { token })));
    const hit = (r, id) => r.json && Array.isArray(r.json.results) && r.json.results.some(x => x.id === id);
    ok(hit(results[0], 'sess-seam-small'), 'S1 ≤2MB 文件:跨 1MB 接缝的那条消息搜得到(修前两边都丢)');
    ok(hit(results[1], 'sess-seam-big'), 'S2 >2MB 文件:头窗口边界上的消息补读成整行,搜得到');
    ok(hit(results[2], 'sess-seam-big'), 'S3 >2MB 文件:尾窗口起点上的消息补读成整行,搜得到');
    ok(hit(results[3], 'sess-sf-3'), 'S4 普通小会话照常');
    const opens = (fs.existsSync(OPEN_LOG) ? fs.readFileSync(OPEN_LOG, 'utf8') : '').split('\n').filter(Boolean);
    const perFile = new Map();
    for (const f of opens) perFile.set(f, (perFile.get(f) || 0) + 1);
    const sessionFiles = ['sess-seam-small', 'sess-seam-big', ...Array.from({ length: 8 }, (_, i) => 'sess-sf-' + i)];
    const counts = sessionFiles.map(id => perFile.get(path.join(HOME, 'sessions', id + '.messages.ndjson')) || 0);
    ok(counts.every(n => n === 1), `S5 单飞:4 个并发冷索引搜索,每个会话正文只被读一遍(各文件打开次数 ${counts.join(',')};修前最多 4 倍)`);
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    if (server) { try { killOwnTree(server); } catch { /* 已退出 */ } }
    await sleep(300);
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  t.done({ exit: true });
})();
